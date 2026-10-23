'use strict';
// Deterministic policy: classification, boundaries, rounding, limits, layout.

const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/policy');

const ASSUMED = { value: 128000, label: 'assumed' };

test('42k / 128k example renders exactly as specified (LOW)', () => {
  const out = p.render({ kind: 'estimate', tokens: 42000, limit: ASSUMED });
  assert.equal(
    out,
    [
      'Context Estimate',
      'Estimated visible context: ~42k tokens',
      'Configured context limit: 128k (assumed)',
      'Estimated usage: ~33%',
      '[███████░░░░░░░░░░░░░] ~33% of planning limit',
      '',
      'Risk: LOW',
      'Recommendation:',
      'Continue normally.',
      '',
      'Note: Visible-text estimate; actual context usage may differ.',
    ].join('\n'),
  );
});

test('91k / 128k example renders exactly as specified (HIGH)', () => {
  const out = p.render({ kind: 'estimate', tokens: 91000, limit: ASSUMED });
  assert.equal(
    out,
    [
      'Context Estimate',
      'Estimated visible context: ~91k tokens',
      'Configured context limit: 128k (assumed)',
      'Estimated usage: ~71%',
      '[██████████████░░░░░░] ~71% of planning limit',
      '',
      'Risk: HIGH',
      'Recommendation:',
      'Run /handoff before starting another major task.',
      '',
      'Note: Visible-text estimate; actual context usage may differ.',
    ].join('\n'),
  );
});

test('exact boundaries 50/70/90 and adjacent values', () => {
  const cases = [
    [0, 'LOW'],
    [49.999999, 'LOW'],
    [50, 'MEDIUM'],
    [50.000001, 'MEDIUM'],
    [69.999999, 'MEDIUM'],
    [70, 'HIGH'],
    [70.000001, 'HIGH'],
    [89.999999, 'HIGH'],
    [90, 'CRITICAL'],
    [90.000001, 'CRITICAL'],
    [100, 'CRITICAL'],
    [250, 'CRITICAL'],
  ];
  for (const [u, risk] of cases) assert.equal(p.classify(u), risk, `usage ${u}`);
});

test('boundaries computed from token counts (exact and ±1 token at 128k)', () => {
  const at = (pct) => (pct / 100) * 128000;
  for (const [pct, below, atOrAbove] of [
    [50, 'LOW', 'MEDIUM'],
    [70, 'MEDIUM', 'HIGH'],
    [90, 'HIGH', 'CRITICAL'],
  ]) {
    const tokens = at(pct);
    assert.ok(Number.isInteger(tokens));
    assert.equal(p.classify(p.usagePercent(tokens - 1, 128000)), below);
    assert.equal(p.classify(p.usagePercent(tokens, 128000)), atOrAbove);
    assert.equal(p.classify(p.usagePercent(tokens + 1, 128000)), atOrAbove);
  }
});

test('classification uses unrounded usage even when display rounds across a threshold', () => {
  const tokens = 0.696 * 128000; // 69.6% -> displays ~70% but is MEDIUM
  const out = p.render({ kind: 'estimate', tokens, limit: ASSUMED });
  assert.match(out, /Estimated usage: ~70%/);
  assert.match(out, /Risk: MEDIUM/);
  assert.match(out, /Continue, but plan a \/handoff before a long task\./);
  const below50 = p.render({ kind: 'estimate', tokens: 0.4996 * 128000, limit: ASSUMED });
  assert.match(below50, /~50%/);
  assert.match(below50, /Risk: LOW/);
});

test('usage above 100% is preserved, not capped', () => {
  const out = p.render({ kind: 'estimate', tokens: 150000, limit: ASSUMED });
  assert.match(out, /Estimated visible context: ~150k tokens/);
  assert.match(out, /Estimated usage: ~117%/);
  assert.match(out, /Risk: CRITICAL/);
  assert.match(out, /Run \/handoff now before continuing substantial work\./);
  assert.equal(p.formatPercent(p.usagePercent(300000, 128000)), '~234%');
});

test('token, limit, and percent rounding', () => {
  assert.equal(p.formatTokens(0), '<1k');
  assert.equal(p.formatTokens(999), '<1k');
  assert.equal(p.formatTokens(1000), '~1k');
  assert.equal(p.formatTokens(1499), '~1k');
  assert.equal(p.formatTokens(1500), '~2k');
  assert.equal(p.formatTokens(42400), '~42k');
  assert.equal(p.formatTokens(99499), '~99k');
  assert.equal(p.formatTokens(99500), '~100k');
  assert.equal(p.formatTokens(102400), '~100k');
  assert.equal(p.formatTokens(133000), '~135k');
  assert.equal(p.formatLimit(128000), '128k');
  assert.equal(p.formatLimit(200000), '200k');
  assert.equal(p.formatLimit(1000000), '1M');
  assert.equal(p.formatLimit(131072), '131,072');
  assert.equal(p.formatPercent(0.4), '<1%');
  assert.equal(p.formatPercent(1), '~1%');
  assert.equal(p.formatPercent(32.8125), '~33%');
  assert.equal(p.formatPercent(71.09375), '~71%');
  assert.equal(p.formatPercent(49.5), '~50%');
});

test('limit override parsing and validation', () => {
  assert.deepEqual(p.parseInvocation('/contextestimate'), { override: { status: 'none' }, barStyle: 'unicode' });
  assert.deepEqual(p.parseInvocation('  /contextestimate  '), { override: { status: 'none' }, barStyle: 'unicode' });
  assert.equal(p.parseInvocation('/contextestimate limit=200000').override.value, 200000);
  assert.equal(p.parseInvocation('/contextestimate limit=200000 limit=200000').override.status, 'valid');
  for (const bad of ['0', '-5', '1.5', '200k', '200,000', '2e5', '', 'abc', '0128000', '99999999999999999999']) {
    assert.equal(p.parseInvocation(`/contextestimate limit=${bad}`).override.status, 'invalid', bad);
  }
  assert.equal(p.parseInvocation('/contextestimate limit=100000 limit=200000').override.status, 'invalid');
  assert.equal(p.parseInvocation('please /contextestimate'), null);
  assert.equal(p.parseInvocation('/contextestimates'), null);
});

test('limit precedence: valid override > saved config > default', () => {
  const valid = p.parseInvocation('/contextestimate limit=200000').override;
  const invalid = p.parseInvocation('/contextestimate limit=abc').override;
  const none = p.parseInvocation('/contextestimate').override;
  assert.deepEqual(p.resolveLimit(valid, '64000'), { value: 200000, label: 'user-configured', source: 'override' });
  assert.deepEqual(p.resolveLimit(invalid, '64000'), { value: 64000, label: 'user-configured', source: 'saved' });
  assert.deepEqual(p.resolveLimit(none, 'none'), { value: 128000, label: 'assumed', source: 'default' });
  assert.deepEqual(p.resolveLimit(invalid, 'none'), { value: 128000, label: 'assumed', source: 'default' });
  assert.deepEqual(p.resolveLimit(none, '0'), { value: 128000, label: 'assumed', source: 'default' });
});

test('user-configured label and invalid-limit note', () => {
  const ok = p.render({ kind: 'estimate', tokens: 42000, limit: { value: 200000, label: 'user-configured' } });
  assert.match(ok, /Configured context limit: 200k \(user-configured\)/);
  assert.match(ok, /Estimated usage: ~21%/);
  const bad = p.render({ kind: 'estimate', tokens: 42000, limit: ASSUMED, invalidLimitRaw: '200k' });
  assert.match(bad, /Configured context limit: 128k \(assumed\)/);
  assert.match(bad, /Note: Ignored invalid limit "200k"\.$/);
});

test('unmeasured attachments: partial coverage, UNKNOWN risk, no lower-bound claim', () => {
  const out = p.render({ kind: 'estimate', tokens: 30000, limit: ASSUMED, unmeasured: true });
  assert.match(out, /Estimated visible context: ~30k tokens \(text only\)/);
  assert.match(out, /Estimated usage: ~23% \(counted text only\)/);
  assert.match(out, /\[█{5}░{15}\] ~23% of planning limit \(text only\)/);
  assert.match(out, /^Risk: UNKNOWN \(unmeasured attachments\)$/m);
  assert.match(out, /^Consider \/handoff before substantial work; attachments or images are not counted\.$/m);
  assert.match(out, /Note: Attachments or images were not counted, so actual usage may differ\./);
  assert.doesNotMatch(out, /lower bound|Risk: LOW|Continue normally/i);
});

test('previously observed 50k/128k partial-history case', () => {
  const out = p.render({ kind: 'estimate', tokens: 50000, limit: ASSUMED, compacted: true });
  assert.equal(
    out,
    [
      'Context Estimate',
      'Estimated visible context: ~50k tokens (partial)',
      'Configured context limit: 128k (assumed)',
      'Estimated usage: ~39% (counted text only)',
      '[████████░░░░░░░░░░░░] ~39% of planning limit (partial)',
      '',
      'Risk: UNKNOWN (partial history)',
      'Recommendation:',
      'Consider /handoff before substantial work; earlier history is not counted.',
      '',
      'Note: Counts accessible text only; earlier history is summarized or truncated, so actual usage may be higher or lower.',
    ].join('\n'),
  );
  // The old mismatch (LOW label with a MEDIUM recommendation) and the
  // "lower bound" wording must not come back.
  assert.doesNotMatch(out, /lower bound/i);
  assert.doesNotMatch(out, /Risk: (LOW|MEDIUM|HIGH|CRITICAL)/);
  assert.doesNotMatch(out, /Continue, but plan a \/handoff before a long task\./);
});

test('partial history never gets a normal risk label at any usage; recommendation scales with counted share', () => {
  const expectBase = [
    [0, 'Consider /handoff before substantial work'],
    [0.69, 'Consider /handoff before substantial work'],
    [0.7, 'Run /handoff before starting another major task'],
    [0.899, 'Run /handoff before starting another major task'],
    [0.9, 'Run /handoff now before continuing substantial work'],
    [1.4, 'Run /handoff now before continuing substantial work'],
  ];
  for (const [share, base] of expectBase) {
    const out = p.render({ kind: 'estimate', tokens: share * 128000, limit: ASSUMED, compacted: true });
    assert.match(out, /^Risk: UNKNOWN \(partial history\)$/m, String(share));
    assert.ok(out.includes(`${base}; earlier history is not counted.`), `${share}: ${out}`);
    assert.doesNotMatch(out, /lower bound/i);
  }
});

test('partial history plus unmeasured attachments uses the combined labels', () => {
  const out = p.render({ kind: 'estimate', tokens: 6000, limit: ASSUMED, compacted: true, unmeasured: true });
  assert.match(out, /~6k tokens \(partial\)/);
  assert.match(out, /Risk: UNKNOWN \(partial history; unmeasured attachments\)/);
  assert.match(out, /earlier history and attachments or images are not counted\./);
  assert.match(out, /^Note: Counts accessible text only; earlier history is summarized or truncated and attachments or images were not counted/m);
});

test('invalid-limit note is appended under the primary note (max two notes)', () => {
  const out = p.render({ kind: 'estimate', tokens: 6000, limit: ASSUMED, compacted: true, unmeasured: true, invalidLimitRaw: 'x' });
  const notes = out.split('\n').filter((l) => l.startsWith('Note:'));
  assert.equal(notes.length, 2);
  assert.match(notes[0], /Counts accessible text only/);
  assert.equal(notes[1], 'Note: Ignored invalid limit "x".');
});

test('unavailable estimate returns Unavailable and UNKNOWN, no number and no bar', () => {
  const out = p.render({ kind: 'unavailable', limit: ASSUMED });
  assert.equal(
    out,
    [
      'Context Estimate',
      'Estimated visible context: Unavailable',
      'Configured context limit: 128k (assumed)',
      'Estimated usage: Unavailable',
      '',
      'Risk: UNKNOWN',
      'Recommendation:',
      'If this chat feels long, consider /handoff before substantial work.',
      '',
      'Note: Conversation content could not be measured.',
    ].join('\n'),
  );
  assert.doesNotMatch(out, /\d+k tokens|\d+%|\[/);
});

test('host telemetry is labeled as measured and never mixed with estimate wording', () => {
  const out = p.render({ kind: 'host', tokens: 61240, limit: ASSUMED, hostLimit: 128000 });
  assert.match(out, /Measured context: 61,240 tokens \(host-reported\)/);
  assert.match(out, /Context limit: 128k \(host-reported\)/);
  assert.match(out, /Usage: ~48%/);
  assert.match(out, /Note: Host-reported measurement\./);
  assert.doesNotMatch(out, /Estimated|Visible-text/);
});

test('tokenized transcript is labeled as supplied text only', () => {
  const out = p.render({ kind: 'transcript', tokens: 42000, limit: ASSUMED });
  assert.match(out, /Tokenized transcript: ~42k tokens \(supplied text\)/);
  assert.match(out, /Measures the supplied transcript only/);
  assert.doesNotMatch(out, /host-reported|Measured context/);
});

test('every rendered report recommends /handoff at most; never claims to run it', () => {
  for (let tokens = 0; tokens <= 200000; tokens += 2500) {
    for (const flags of [{}, { unmeasured: true }, { compacted: true }, { compacted: true, unmeasured: true }]) {
      const out = p.render({ kind: 'estimate', tokens, limit: ASSUMED, ...flags });
      assert.doesNotMatch(out, /\b(running|ran|started|executing|executed|generated)\b.*handoff/i);
      assert.ok(out.split('\n').length <= 13);
      assert.equal(out.split('\n')[0], 'Context Estimate');
    }
  }
});
