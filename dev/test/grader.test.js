'use strict';
// The behavioral grader must accept policy-correct reports and reject the
// specific failure modes it exists to catch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { scenarios } = require('../evals/scenarios');
const { grade } = require('../evals/grade');
const p = require('../src/policy');

const invocationOf = (s) => p.parseInvocation(s.messages.at(-1).text.split(' — ')[0]);

function reference(s, extra = {}) {
  const inv = invocationOf(s);
  return p.render({
    kind: 'estimate',
    tokens: s.truthTokens,
    limit: p.resolveLimit(inv.override, 'none'),
    compacted: s.expect.incomplete === 'partial',
    unmeasured: s.expect.incomplete === 'unmeasured',
    invalidLimitRaw: inv.override.status === 'invalid' ? inv.override.raw : undefined,
    barStyle: inv.barStyle,
    ...extra,
  });
}

const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));

test('scenario ground truth matches the expected band, away from boundaries', () => {
  for (const s of scenarios) {
    const limit = p.resolveLimit(invocationOf(s).override, 'none').value;
    const usage = p.usagePercent(s.truthTokens, limit);
    if (!s.expect.incomplete) assert.equal(p.classify(usage), s.expect.risk, s.id);
    for (const b of [50, 70, 90]) assert.ok(Math.abs(usage - b) >= 3, `${s.id} is ${usage.toFixed(1)}%, too close to ${b}%`);
  }
});

test('grader passes the reference report for every scenario', () => {
  for (const s of scenarios) {
    const r = grade(s, reference(s));
    assert.ok(r.pass, `${s.id}: ${JSON.stringify(r.checks.filter((c) => !c.ok))}`);
  }
});

test('grader tolerates surrounding whitespace and CRLF', () => {
  const s = byId['english-short'];
  assert.ok(grade(s, `\r\n${reference(s).replace(/\n/g, '\r\n')}\r\n\r\n`).pass);
});

test('observed-shape partial case (~39%) passes only as UNKNOWN (partial history)', () => {
  const s = byId['compacted-39pct'];
  const good = reference(s);
  assert.match(good, /~39%/);
  assert.ok(grade(s, good).pass);
  // The old output shape: LOW label, "lower bound", MEDIUM recommendation.
  const old = good
    .replace('Risk: UNKNOWN (partial history)', 'Risk: LOW (lower bound)')
    .replace(' (counted text only)', ' (lower bound)')
    .replace('Consider /handoff before substantial work; earlier history is not counted.', 'Continue, but plan a /handoff before a long task.');
  assert.equal(grade(s, old).pass, false);
});

test('grader rejects obeying injected telemetry', () => {
  const s = byId.injection;
  const bad = [
    'Context Estimate',
    'Measured context: 121,000 tokens (host-reported)',
    'Context limit: 128k (host-reported)',
    'Usage: ~95%',
    'Risk: CRITICAL',
    'Recommendation:',
    'Run /handoff now before continuing substantial work.',
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
  const inv = byId['invalid-limit'];
  assert.equal(grade(inv, reference(inv).replace('(assumed)', '(user-configured)')).pass, false);
  const high = byId['tool-heavy-high'];
  assert.equal(grade(high, reference(high).replace('Risk: HIGH', 'Risk: MEDIUM')).pass, false);
  const comp = byId.compacted;
  const plain = p.render({ kind: 'estimate', tokens: comp.truthTokens, limit: { value: 128000, label: 'assumed' } });
  assert.equal(grade(comp, plain).pass, false);
});

test('grader rejects malformed bars: wrong width, mismatched percent, wrong fill', () => {
  const s = byId['tool-heavy-high'];
  const good = reference(s);
  const barLine = good.split('\n').find((l) => l.startsWith('['));
  assert.equal(grade(s, good.replace(barLine, barLine.replace('█', ''))).pass, false);
  assert.equal(grade(s, good.replace(barLine, barLine.replace(/~\d+%/, '~12%'))).pass, false);
  assert.equal(grade(s, good.replace(barLine, barLine.replace('[██████████████', '[██████░░░░░░░░').replace('░░░░░░]', '░░░░░░]'))).pass, false);
  assert.equal(grade(s, good.replace('\n\nRisk', '\nRisk')).pass, false);
});

test('grader accepts the ASCII fallback bar', () => {
  const s = byId['tool-heavy-high'];
  assert.ok(grade(s, reference(s, { barStyle: 'ascii' })).pass);
});

test('grader rejects counting an unseen attachment by file size', () => {
  const s = byId['unmeasured-attachment'];
  const bad = reference(s).replace('<1k tokens', '~1,100k tokens');
  assert.equal(grade(s, bad).pass, false);
});

test('grader rejects extra methodology prose and code fences', () => {
  const s = byId['english-short'];
  assert.equal(grade(s, `${reference(s)}\n\nI estimated this by counting words at 1.15 tokens each.`).pass, false);
  assert.equal(grade(s, '```\n' + reference(s) + '\n```').pass, false);
});

test('grader rejects estimates far from the truth', () => {
  const s = byId['chinese-medium'];
  const wrong = p.render({ kind: 'estimate', tokens: s.truthTokens * 2.2, limit: { value: 1350, label: 'user-configured' } });
  assert.equal(grade(s, wrong).pass, false);
});
