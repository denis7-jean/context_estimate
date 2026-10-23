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
  assert.match(report1, /^Planning limit: 128k \(conservative baseline; model window unknown\)$/m);

  // A bare follow-up message is not an invocation: nothing is recalculated and the first report stands.
  const followUp = { role: 'user', text: 'model=gpt-6.1-sol' };
  assert.equal(p.parseInvocation(followUp.text), null);

  // Invoking again with the parameter in the same message recalculates against the documented default.
  const run2 = [...run1, { role: 'assistant', text: report1 }, followUp, { role: 'user', text: '@contextestimate model=gpt-6.1-sol' }];
  const lim2 = limitFor('@contextestimate model=gpt-6.1-sol');
  assert.deepEqual(lim2, SOL);
  const est2 = h.estimateMessages(run2);
  const report2 = renderFor(est2, lim2);
  assert.match(report2, /^Planning limit: 500k \(documented GPT-6\.1 Sol \/ Work default\)$/m);
  assert.match(report2, /^Estimated accessible text: <1k tokens$/m);
  // Recalculated from visible messages, not patched from the earlier report's number.
  assert.notEqual(est2, h.estimateMessages(run1));

  // The parameter does not persist: the next plain invocation is back to the baseline.
  assert.deepEqual(limitFor('@contextestimate'), BASELINE);

  // A budget parameter on a new invocation compares against that budget for that run only.
  const lim3 = limitFor('@contextestimate limit=250000');
  assert.deepEqual(lim3, { value: 250000, source: 'override', label: 'user override' });
  assert.match(renderFor(130000, lim3), /^\[█{10}░{10}\] ~52% of planning limit$/m);
  assert.match(renderFor(130000, lim3), /^Planning risk: MEDIUM$/m);
  assert.deepEqual(limitFor('/contextestimate'), BASELINE);
});

test('model=gpt-6-luna is an assertion that records the model but, with no documented Work window, keeps the baseline', () => {
  const inv = p.parseInvocation('@contextestimate model=gpt-6-luna');
  assert.equal(inv.model.id, 'gpt-6-luna');
  assert.deepEqual(p.resolveLimit(inv, 'none'), BASELINE);
  assert.match(renderFor(1000, p.resolveLimit(inv, 'none')), /^Planning risk: UNKNOWN \(model window unknown\)$/m);
});

test('the neutral recommendation spells out the retry step with valid @ examples', () => {
  const rec = p.NEUTRAL_RECOMMENDATION;
  assert.match(rec, /^A model-relative handoff assessment is unavailable\. /);
  assert.match(rec, /invoke this skill again with the parameter in the same message/);
  assert.ok(rec.includes('`@contextestimate limit=250000`'));
  assert.ok(rec.includes('`@contextestimate model=MODEL_ID`'));
  assert.doesNotMatch(rec, /\/handoff|reply with|send (a )?(follow-up|separate)|then send/i);
  // The suggested examples are valid invocations.
  for (const example of ['@contextestimate limit=250000', '@contextestimate model=MODEL_ID']) {
    assert.ok(p.parseInvocation(example), example);
  }
  assert.equal(p.parseInvocation('@contextestimate limit=250000').override.value, 250000);
  assert.equal(p.parseInvocation('@contextestimate model=MODEL_ID').model.id, 'model-id');
});

test('SKILL.md states the retry flow, parameter scope, and evidence rules', () => {
  assert.match(skill, /A separate later message containing only `model=\.\.\.` or `limit=\.\.\.` is not an invocation unless it also selects this skill, and it never updates an earlier report/);
  assert.match(skill, /the user invokes or selects this skill again with the parameter in that same message/);
  assert.match(skill, /apply the parameter to that run only and recalculate the estimate from the visible conversation that is accessible now; do not edit or build on the previous report's numbers/);
  assert.match(skill, /`@contextestimate limit=250000` or `\/contextestimate model=gpt-6\.1-sol`/);
  assert.match(skill, /OpenAI documents `@` as the way to select a skill in ChatGPT/);
  assert.match(skill, /never tell the user it is a registered command/);
  assert.match(skill, /It is a user assertion, not detection/);
  assert.match(skill, /Options apply to this run only\. Do not claim they persist\./);
});

test('README and notes document the retry flow with @ examples and without implying a bare follow-up works', () => {
  for (const [name, doc] of [['README', readme], ['notes', notes]]) {
    assert.match(doc, /@contextestimate limit=250000/, name);
    assert.match(doc, /@contextestimate model=gpt-6-luna/, name);
    assert.match(doc, /in the same message/, name);
    assert.match(doc, /does not (?:necessarily )?(?:invoke|update)|never updates an earlier report|not an invocation/i, name);
  }
  assert.match(readme, /### Getting a parameterized estimate/);
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
