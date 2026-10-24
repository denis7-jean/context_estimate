'use strict';
// Invocation syntax and the retry-with-a-parameter flow. These check the
// documented behavior and the reference parser; they do not test how ChatGPT
// Work delivers an @ mention to the assistant.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, SKILL_DIR } = require('../src/bundle');
const h = require('../src/heuristic');
const g = require('../fixtures/greeting');
const { p, limitFor, BASELINE, SOL, renderFor } = require('./helpers');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8').replace(/\r\n/g, '\n');
const skill = read(SKILL_DIR, 'SKILL.md');
const readme = read(ROOT, 'README.md');
const notes = read(ROOT, 'docs', 'development-notes.md');

test('the supported invocation forms parse: @mention, /contextestimate text, or both, with options on the same line', () => {
  const cases = [
    ['/contextestimate limit=250000', { limit: 250000 }],
    ['@contextestimate limit=250000', { limit: 250000 }],
    ['@contextestimate /contextestimate limit=250000', { limit: 250000 }],
    ['  @contextestimate   model=gpt-6-luna', { model: 'gpt-6-luna' }],
    ['@contextestimate model=gpt-6.1-sol limit=250000 bar=ascii', { limit: 250000, model: 'gpt-6.1-sol', bar: 'ascii' }],
    ['@contextestimate', {}],
    ['/contextestimate', {}],
  ];
  for (const [message, want] of cases) {
    const inv = p.parseInvocation(message);
    assert.ok(inv, message);
    assert.equal(inv.override.status === 'valid' ? inv.override.value : undefined, want.limit, message);
    assert.equal(inv.model.status === 'asserted' ? inv.model.id : undefined, want.model, message);
    assert.equal(inv.barStyle, want.bar || 'unicode', message);
  }
});

test('a separate message holding only model=... or limit=... is not an invocation and updates nothing', () => {
  for (const m of ['model=gpt-6-luna', 'limit=250000', 'model=gpt-6.1-sol limit=250000', 'use model=gpt-6.1-sol please', 'try limit=250000']) {
    assert.equal(p.parseInvocation(m), null, m);
  }
  // Prefix lookalikes and quoted lines are not invocations either.
  for (const m of ['/contextestimates limit=5', '@contextestimates limit=5', '> @contextestimate limit=5', 'please @contextestimate limit=5']) {
    assert.equal(p.parseInvocation(m), null, m);
  }
  // Only when the platform shows the skill was selected for that message (e.g. the @ picker) are bare options read.
  assert.equal(p.parseInvocation('limit=250000', { selected: true }).override.value, 250000);
  assert.equal(p.parseInvocation('model=gpt-6.1-sol', { selected: true }).model.id, 'gpt-6.1-sol');
});

test('retry flow: each new invocation applies its parameter to that run only and recalculates from the current transcript', () => {
  const run1 = [...g.GREETING, { role: 'user', text: '@contextestimate' }];
  const report1 = renderFor(h.estimateMessages(run1), limitFor('@contextestimate'));
  assert.match(report1, /^Planning budget: 128k \(default heuristic\)$/m);

  // A bare follow-up message is not an invocation: nothing is recalculated and the first report stands.
  const followUp = { role: 'user', text: 'model=gpt-6.1-sol' };
  assert.equal(p.parseInvocation(followUp.text), null);

  // Invoking again with the parameter in the same message recalculates against the documented default.
  const run2 = [...run1, { role: 'assistant', text: report1 }, followUp, { role: 'user', text: '@contextestimate model=gpt-6.1-sol' }];
  const lim2 = limitFor('@contextestimate model=gpt-6.1-sol');
  assert.deepEqual(lim2, SOL);
  const est2 = h.estimateMessages(run2);
  const report2 = renderFor(est2, lim2);
  assert.match(report2, /^Planning budget: 500k \(documented GPT-6\.1 Sol Work window, checked 2026-10-23\)$/m);
  assert.match(report2, /^Estimated accessible text: <1k tokens$/m);
  // Recalculated from visible messages, not patched from the earlier report's number.
  assert.notEqual(est2, h.estimateMessages(run1));

  // The parameter does not persist: the next plain invocation is back to the baseline.
  assert.deepEqual(limitFor('@contextestimate'), BASELINE);

  // A budget parameter on a new invocation compares against that budget for that run only.
  const lim3 = limitFor('@contextestimate limit=250000');
  assert.deepEqual(lim3, { value: 250000, source: 'override', label: 'user budget' });
  assert.match(renderFor(130000, lim3), /^\[█{10}░{10}\] ~52% of planning budget$/m);
  assert.match(renderFor(130000, lim3), /^Handoff priority: MEDIUM$/m);
  assert.deepEqual(limitFor('/contextestimate'), BASELINE);
});

test('model=gpt-6-luna is an assertion that records the model but, with no documented Work window, keeps the default budget and normal guidance', () => {
  const inv = p.parseInvocation('@contextestimate model=gpt-6-luna');
  assert.equal(inv.model.id, 'gpt-6-luna');
  assert.deepEqual(p.resolveLimit(inv, 'none'), BASELINE);
  const out = renderFor(1000, p.resolveLimit(inv, 'none'));
  assert.match(out, /^Model: GPT-6 Luna \(user-supplied\) — Work window undocumented$/m);
  assert.match(out, /^Handoff priority: LOW$/m);
  assert.match(out, /^Continue normally\.$/m);
});

test('parameters are optional: a plain invocation gets full guidance, and no report asks the user to supply model= or limit=', () => {
  for (const message of ['@contextestimate', '/contextestimate', '@contextestimate model=GPT-6 Sol', '@contextestimate model=Sol', '@contextestimate model=GPT-7 Foo']) {
    const out = renderFor(5000, limitFor(message));
    assert.match(out, /^Handoff priority: LOW$/m, message);
    assert.match(out, /^Continue normally\.$/m, message);
    assert.doesNotMatch(out, /limit=N|model=MODEL_ID|invoke this skill again|model-relative|unavailable/i, message);
  }
  // The options still work when given, in the same message.
  assert.equal(p.parseInvocation('@contextestimate limit=250000').override.value, 250000);
  assert.match(renderFor(5000, limitFor('@contextestimate limit=250000')), /^Planning budget: 250k \(user budget\)$/m);
});

test('SKILL.md states the retry flow, parameter scope, and evidence rules', () => {
  assert.match(skill, /A separate later message containing only `model=\.\.\.` or `limit=\.\.\.` is not an invocation unless it also selects this skill, and it never updates an earlier report/);
  assert.match(skill, /The user invokes or selects this skill again with the parameter in that same message; apply it to that run only and recalculate from the visible conversation accessible now; do not edit or build on the previous report's numbers/);
  assert.match(skill, /`@contextestimate limit=250000` or `\/contextestimate model=gpt-6\.1-sol`/);
  assert.match(skill, /OpenAI documents `@` as the way to select a skill in ChatGPT/);
  assert.match(skill, /never tell the user it is a registered command/);
  assert.match(skill, /the user's assertion of the Work model currently selected, not detection/);
  assert.match(skill, /Options apply to this run only\. Do not claim they persist\./);
});

test('README and notes document optional parameters with @ examples and without implying a bare follow-up works', () => {
  for (const [name, doc] of [['README', readme], ['notes', notes]]) {
    assert.match(doc, /@contextestimate limit=250000/, name);
    assert.match(doc, /@contextestimate model=gpt-6-luna/, name);
    assert.match(doc, /in the same message/, name);
    assert.match(doc, /does not (?:necessarily )?(?:invoke|update)|never updates an earlier report|not an invocation/i, name);
  }
  assert.match(readme, /A plain invocation gets full guidance; no options are needed/);
  assert.match(readme, /Options are optional controls/);
  assert.match(readme, /user-provided assertion, not automatic model detection/);
  assert.match(readme, /user-provided planning budget/);
  assert.match(readme, /type `@` to select a skill/);
});

test('no document claims /contextestimate is a registered slash command', () => {
  for (const [name, doc] of [['SKILL.md', skill], ['README', readme], ['notes', notes]]) {
    const sentences = doc.split(/(?<=[.!?])\s+|\n+/).filter((s) => /registered|registers? .*slash|slash command/i.test(s) && /contextestimate/.test(s));
    for (const s of sentences) {
      assert.match(s, /not|never|may not|unverified|rather than|has not been verified|isn't/i, `${name}: ${s}`);
    }
  }
});
