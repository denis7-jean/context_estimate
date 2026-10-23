'use strict';
// Sizing sanity regression for a real Work smoke test: a four-message
// greeting exchange across a model switch (GPT-6 Luna -> GPT-6.1 Sol), with
// /contextestimate run on Sol and then on Luna. The live Luna run reported
// ~5k tokens against the 128k baseline and advised a handoff.
//
// These tests check the skill's stated counting rules and policy on a
// synthetic fixture with the reference estimator and tokenizer. They are not
// ground truth for any live estimate and do not show that a language model
// produces a deterministic exact count in a live invocation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { encode } = require('gpt-tokenizer/encoding/o200k_base');
const { SKILL_DIR } = require('../src/bundle');
const h = require('../src/heuristic');
const g = require('../fixtures/greeting');
const { p, limitFor, BASELINE, SOL, renderFor } = require('./helpers');
const { scenarios } = require('../evals/scenarios');
const { grade } = require('../evals/grade');

const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const tokens = (text) => encode(text).length;
const truth = (messages) => messages.reduce((s, m) => s + tokens(m.text) + 4, 0);
const NEUTRAL = 'A model-relative handoff assessment is unavailable. To compare against a planning limit, invoke this skill again with the parameter in the same message, e.g. `@contextestimate limit=250000` or `@contextestimate model=MODEL_ID`.';

test('the fixture is the four-message exchange plus invocations, with only visible message text', () => {
  assert.deepEqual(g.GREETING.map((m) => m.text), ['hi', 'Hi! What would you like to work on?', 'Hello World', 'Hello, world! 👋']);
  assert.deepEqual(g.GREETING.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(g.SELECTED_MODELS, ['GPT-6 Luna Medium', null, 'GPT-6.1 Sol Medium', null]);
  for (const t of [g.transcriptForFirstRun(), g.transcriptForSecondRun()]) {
    for (const m of t) assert.ok(m.role === 'user' || m.role === 'assistant', m.role);
    assert.deepEqual(Object.keys(t[0]).sort(), ['role', 'text']);
  }
  assert.equal(g.transcriptForFirstRun().length, 5);
  assert.equal(g.transcriptForSecondRun().length, 7);
  assert.equal(g.transcriptForSecondRun()[6].text, g.INVOKE_LUNA);
});

test('the first report in the transcript is the <1k Sol report', () => {
  const report = g.firstReport();
  assert.match(report, /^Estimated accessible text: <1k tokens$/m);
  assert.match(report, /^Planning limit: 500k \(documented GPT-6\.1 Sol \/ Work default\)$/m);
  assert.match(report, /^Planning risk: LOW$/m);
  assert.equal(g.transcriptForSecondRun()[5].text, report);
});

test('non-countable material is excluded from the transcript', () => {
  const visible = g.transcriptForSecondRun().map((m) => m.text).join('\n');
  for (const [name, text] of Object.entries(g.NON_COUNTABLE)) {
    assert.ok(!visible.includes(text.slice(0, 40)), `${name} must not appear in the accessible transcript`);
  }
  // The shipped skill text is loaded when the skill runs, but it is not conversation text.
  assert.ok(!visible.includes('# contextestimate'));
  assert.ok(!visible.includes('saved_limit:'));
});

test('SKILL.md says not to count the non-countable material the fixture excludes', () => {
  assert.match(skill, /system and developer instructions, tool definitions, hidden reasoning, memory and context metadata, the selected model's name, plan labels, and images, audio, or any content you cannot see\. Do not count or invent sizes for any of these/);
  assert.match(skill, /A total in the thousands for such a chat means non-transcript text \(this skill's text, instructions, memory, tool definitions, your own reasoning\) is being counted; recount only the messages/);
  assert.match(skill, /The estimate depends only on the transcript text, never on which model is answering/);
});

test('the complete greeting exchange stays below 1k tokens (reference estimator and o200k_base)', () => {
  for (const t of [g.GREETING, g.transcriptForFirstRun(), g.transcriptForSecondRun()]) {
    const est = h.estimateMessages(t);
    assert.ok(est < 1000, `estimate ${est}`);
    assert.ok(truth(t) < 1000, `tokenizer ${truth(t)}`);
    assert.ok(est < 300, `a tiny exchange is a few hundred tokens at most: ${est}`);
  }
  assert.ok(truth(g.GREETING) < 100);
  assert.ok(Math.abs(h.estimateMessages(g.GREETING) - truth(g.GREETING)) <= 30);
});

test('counting the non-countable material would inflate the same exchange into the thousands (the failure mode to avoid)', () => {
  const real = h.estimateMessages(g.transcriptForSecondRun());
  const skillAlone = tokens(g.NON_COUNTABLE.skillText);
  assert.ok(skillAlone > 3000, `skill text alone is ${skillAlone} tokens`);
  const inflated = real + Object.values(g.NON_COUNTABLE).reduce((s, text) => s + tokens(text), 0);
  assert.ok(inflated > 5000, `inflated ${inflated}`);
  assert.ok(inflated > 20 * real);
});

test('Sol run: the documented 500k default applies and the share is <1%', () => {
  const lim = limitFor(g.INVOKE_SOL);
  assert.deepEqual(lim, SOL);
  const out = renderFor(h.estimateMessages(g.transcriptForFirstRun()), lim);
  assert.equal(out, g.firstReport());
  assert.match(out, /^\[█░{19}\] <1% of planning limit$/m);
  assert.match(out, /^Planning risk: LOW$/m);
});

test('Luna run: baseline denominator, the same <1k text, UNKNOWN, and no handoff advice', () => {
  const lim = limitFor(g.INVOKE_LUNA);
  assert.deepEqual(lim, BASELINE);
  const out = renderFor(h.estimateMessages(g.transcriptForSecondRun()), lim);
  assert.match(out, /^Estimated accessible text: <1k tokens$/m);
  assert.doesNotMatch(out, /~\d+k tokens/);
  assert.match(out, /^Planning limit: 128k \(conservative baseline; model window unknown\)$/m);
  assert.match(out, /^\[█░{19}\] <1% of planning limit$/m);
  assert.match(out, /^Planning risk: UNKNOWN \(model window unknown\)$/m);
  assert.ok(out.includes(`Recommendation:\n${NEUTRAL}`));
  assert.doesNotMatch(out, /\/handoff|500k|documented|Sol/);
});

test('switching Sol -> Luna does not reuse the old denominator or inflate the same accessible transcript', () => {
  const first = h.estimateMessages(g.transcriptForFirstRun());
  const second = h.estimateMessages(g.transcriptForSecondRun());
  // The second transcript is longer only by the first report and one invocation.
  assert.ok(second > first && second - first < 200, `${first} -> ${second}`);
  const sol = renderFor(first, limitFor(g.INVOKE_SOL));
  const luna = renderFor(second, limitFor(g.INVOKE_LUNA));
  assert.match(sol, /<1k tokens/);
  assert.match(luna, /<1k tokens/);
  assert.doesNotMatch(luna, /500k|documented/);
  // Switching back re-resolves the documented default; nothing carried over from the Luna run.
  const back = renderFor(second, limitFor(g.INVOKE_SOL));
  assert.match(back, /^Planning limit: 500k \(documented GPT-6\.1 Sol \/ Work default\)$/m);
  // With no evidence after a switch, the result is the baseline, never the previous model's limit.
  assert.deepEqual(limitFor('/contextestimate'), BASELINE);
  // The same accessible text gives the same estimate regardless of the model asserted.
  assert.equal(h.estimateMessages(g.transcriptForSecondRun()), second);
});

test('model-independent estimate: only the denominator differs between the Sol and Luna reports', () => {
  const t = g.transcriptForSecondRun();
  const est = h.estimateMessages(t);
  const sol = renderFor(est, limitFor(g.INVOKE_SOL)).split('\n');
  const luna = renderFor(est, limitFor(g.INVOKE_LUNA)).split('\n');
  assert.equal(sol[1], luna[1], 'accessible-text line is identical');
  assert.notEqual(sol[2], luna[2], 'only the planning limit differs');
});

test('partial-history and attachment uncertainty are unchanged for the greeting under either model', () => {
  const est = h.estimateMessages(g.transcriptForSecondRun());
  for (const [lim, extra] of [
    [SOL, ''],
    [BASELINE, '; model window unknown'],
  ]) {
    const hist = renderFor(est, lim, { compacted: true });
    assert.match(hist, new RegExp(`^Planning risk: UNKNOWN \\(partial history${extra}\\)$`, 'm'));
    assert.match(hist, /^Consider \/handoff before substantial work; earlier history is not counted\.$/m);
    assert.match(hist, /^Estimated accessible text: <1k tokens \(partial\)$/m);
    const att = renderFor(est, lim, { unmeasured: true });
    assert.match(att, new RegExp(`^Planning risk: UNKNOWN \\(unmeasured attachments${extra}\\)$`, 'm'));
    assert.match(att, /^Consider \/handoff before substantial work; attachments or images are not counted\.$/m);
    assert.doesNotMatch(att + hist, /lower bound|Planning risk: LOW/);
  }
});

test('the greeting scenarios are in the behavioral set and the grader accepts the reference reports', () => {
  const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
  for (const id of ['greeting-sol', 'greeting-luna']) assert.ok(byId[id], id);
  const sol = byId['greeting-sol'];
  const luna = byId['greeting-luna'];
  assert.ok(sol.truthTokens < 1000 && luna.truthTokens < 1000);
  const render = (s) => p.render({ kind: 'estimate', tokens: s.truthTokens, limit: p.resolveLimit(p.parseInvocation(s.messages.at(-1).text), 'none') });
  assert.ok(grade(sol, render(sol)).pass);
  assert.ok(grade(luna, render(luna)).pass);
  // A live-style ~5k report with a handoff recommendation (the observed defect) is rejected.
  const bad = render(luna).replace('<1k tokens', '~5k tokens').replace('<1% of planning limit', '~4% of planning limit').replace(NEUTRAL, 'Consider /handoff before substantial work; model window unknown.');
  assert.equal(grade(luna, bad).pass, false);
});

test('rates, thresholds, and the baseline were not tuned for this case', () => {
  assert.deepEqual(h.RATES, {
    cjkTokensPerChar: 0.75,
    charsPerToken: { prose: 5.0, code: 3.5, structured: 3.0, dense: 2.2 },
    perMessageOverhead: 4,
  });
  assert.deepEqual(p.DEFAULT_THRESHOLDS, { medium: 50, high: 70, critical: 90 });
  assert.equal(p.DEFAULT_LIMIT, 128000);
});
