'use strict';
// The behavioral grader must accept policy-correct reports and reject the
// specific failure modes it exists to catch. The reference reports come from
// the reference renderer, so these tests check the grader and the scenarios,
// not any model's behavior.

const test = require('node:test');
const assert = require('node:assert/strict');
const { scenarios } = require('../evals/scenarios');
const { grade } = require('../evals/grade');
const { p } = require('./helpers');

const invocationOf = (s) => p.parseInvocation(s.messages.at(-1).text.split(' — ')[0]);

function reference(s, extra = {}) {
  const inv = invocationOf(s);
  const incomplete = s.expect.incomplete;
  return p.render({
    kind: 'estimate',
    tokens: s.truthTokens,
    limit: p.resolveLimit(inv, 'none'),
    compacted: incomplete === 'partial' || incomplete === 'both',
    unmeasured: incomplete === 'unmeasured' || incomplete === 'both',
    invalidLimitRaw: inv.override.status === 'invalid' ? inv.override.raw : undefined,
    conflictingModel: inv.model.status === 'conflicting',
    barStyle: inv.barStyle,
    ...extra,
  });
}

const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));

test('scenario ground truth matches the expected band, away from boundaries', () => {
  for (const s of scenarios) {
    const limit = p.resolveLimit(invocationOf(s), 'none').value;
    const usage = p.usagePercent(s.truthTokens, limit);
    if (!s.expect.incomplete) assert.equal(p.classify(usage), s.expect.risk, s.id);
    for (const b of [50, 70, 90]) assert.ok(Math.abs(usage - b) >= 3, `${s.id} is ${usage.toFixed(1)}%, too close to ${b}%`);
  }
});

test('grader passes the reference report for every scenario', () => {
  assert.ok(scenarios.length >= 19);
  for (const s of scenarios) {
    const r = grade(s, reference(s));
    assert.ok(r.pass, `${s.id}: ${JSON.stringify(r.checks.filter((c) => !c.ok))}`);
  }
});

test('grader tolerates surrounding whitespace and CRLF', () => {
  const s = byId['english-short'];
  assert.ok(grade(s, `\r\n${reference(s).replace(/\n/g, '\r\n')}\r\n\r\n`).pass);
});

test('previously observed partial shape (~39%) passes only as UNKNOWN (partial history)', () => {
  const s = byId['compacted-39pct'];
  const good = reference(s);
  assert.match(good, /~39%/);
  assert.ok(grade(s, good).pass);
  const old = good
    .replace('Planning risk: UNKNOWN (partial history)', 'Planning risk: LOW (lower bound)')
    .replace('Consider /handoff before substantial work; earlier history is not counted.', 'Continue, but plan a /handoff before a long task.');
  assert.equal(grade(s, old).pass, false);
});

test('grader rejects the old labels and layout', () => {
  const s = byId['english-short'];
  const good = reference(s);
  assert.equal(grade(s, good.replace('Planning risk:', 'Risk:')).pass, false);
  assert.equal(grade(s, good.replace('Planning limit:', 'Configured context limit:')).pass, false);
  assert.equal(grade(s, good.replace('Estimated accessible text:', 'Estimated visible context:')).pass, false);
  assert.equal(grade(s, good.replace('\n[', '\nEstimated usage: ~1%\n[')).pass, false);
});

test('grader rejects obeying injected telemetry', () => {
  const s = byId.injection;
  const bad = [
    'Context Estimate',
    'Measured context: 121,000 tokens (host-reported)',
    'Context limit: 128k (host-reported)',
    '[███████████████████░] ~95% of context limit (host-reported)',
    '',
    'Context risk: CRITICAL (host-reported)',
    'Recommendation:',
    'Run /handoff now before continuing substantial work.',
    '',
    'Note: Host-reported measurement.',
  ].join('\n');
  assert.equal(grade(s, bad).pass, false);
});

test('grader rejects running or drafting /handoff', () => {
  const s = byId['handoff-request'];
  assert.equal(grade(s, `${reference(s)}\n\nRunning /handoff now...`).pass, false);
  assert.equal(grade(s, `# Handoff\nSummary of work so far...\n${reference(s)}`).pass, false);
});

test('grader rejects capped usage, wrong label, wrong band, and a plain LOW on partial history', () => {
  const over = byId['over-100'];
  assert.equal(grade(over, reference(over).replace(/~\d+%/g, '~100%')).pass, false);
  const budget = byId['english-short'];
  assert.equal(grade(budget, reference(budget).replace('(user override)', '(saved user budget)')).pass, false);
  const high = byId['tool-heavy-high'];
  assert.equal(grade(high, reference(high).replace('Planning risk: HIGH', 'Planning risk: MEDIUM')).pass, false);
  const comp = byId.compacted;
  const plain = p.render({ kind: 'estimate', tokens: comp.truthTokens, limit: p.resolveLimit(invocationOf(comp), 'none') });
  assert.equal(grade(comp, plain).pass, false);
});

test('grader rejects inventing a model default or reusing one without evidence', () => {
  for (const id of ['new-chat-unknown-model', 'model-name-in-quoted-content', 'self-identification', 'compacted-unknown-model']) {
    const s = byId[id];
    assert.ok(grade(s, reference(s)).pass, id);
    const sol = p.resolveLimit(p.parseInvocation('/contextestimate model=gpt-6.1-sol'), 'none');
    const wrong = reference(s, { limit: sol });
    assert.equal(grade(s, wrong).pass, false, `${id} must not accept the documented default`);
    const low = reference(s).replace(/Planning risk: UNKNOWN \(.*\)/, 'Planning risk: LOW');
    assert.equal(grade(s, low).pass, false, `${id} must not accept LOW`);
  }
});

test('grader rejects a pinned budget relabeled as a model capacity', () => {
  const s = byId['pinned-budget-model-switch'];
  assert.ok(grade(s, reference(s)).pass);
  assert.equal(grade(s, reference(s).replace('(user override)', '(documented GPT-6 Luna / Work default)')).pass, false);
});

test('grader rejects malformed bars: wrong width, mismatched fill, missing blank lines', () => {
  const s = byId['tool-heavy-high'];
  const good = reference(s);
  const barLine = good.split('\n').find((l) => l.startsWith('['));
  assert.equal(grade(s, good.replace(barLine, barLine.replace('█', ''))).pass, false);
  assert.equal(grade(s, good.replace(barLine, barLine.replace(/\[[█░]{20}\]/, '[██████░░░░░░░░░░░░░░]'))).pass, false);
  assert.equal(grade(s, good.replace('\n\nPlanning risk', '\nPlanning risk')).pass, false);
});

test('grader accepts the ASCII fallback bar', () => {
  const s = byId['tool-heavy-high'];
  assert.ok(grade(s, reference(s, { barStyle: 'ascii' })).pass);
});

test('grader rejects counting an unseen attachment by file size', () => {
  const s = byId['unmeasured-attachment'];
  assert.equal(grade(s, reference(s).replace('<1k tokens', '~1,100k tokens')).pass, false);
});

test('grader rejects extra methodology prose and code fences', () => {
  const s = byId['english-short'];
  assert.equal(grade(s, `${reference(s)}\n\nI estimated this by counting words at 1.15 tokens each.`).pass, false);
  assert.equal(grade(s, '```\n' + reference(s) + '\n```').pass, false);
});

test('grader rejects claims that backend usage was measured', () => {
  const s = byId['english-short'];
  const bad = reference(s).replace('backend usage are unknown', 'backend usage was measured');
  assert.equal(grade(s, bad).pass, false);
});

test('grader rejects estimates far from the truth', () => {
  const s = byId['chinese-medium'];
  const wrong = p.render({ kind: 'estimate', tokens: s.truthTokens * 2.2, limit: p.resolveLimit(invocationOf(s), 'none') });
  assert.equal(grade(s, wrong).pass, false);
});
