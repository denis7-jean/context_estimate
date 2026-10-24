'use strict';
// Deterministic policy: planning-risk classification, boundaries, rounding,
// report layout, and the partial / unavailable / host / transcript variants.

const test = require('node:test');
const assert = require('node:assert/strict');
const { p, limitFor, BASELINE, SOL, budget, renderFor } = require('./helpers');

test('documented GPT-6.1 Sol default: 130k / 500k renders exactly (LOW planning risk)', () => {
  assert.equal(
    renderFor(130000, SOL),
    [
      'Context Estimate',
      'Estimated accessible text: ~130k tokens',
      'Planning budget: 500k (documented GPT-6.1 Sol Work window, checked 2026-10-23)',
      'Model: GPT-6.1 Sol (user-supplied) — Work window documented',
      '[█████░░░░░░░░░░░░░░░] ~26% of planning budget',
      'Handoff priority: LOW',
      '',
      'Recommendation:',
      'Continue normally.',
      '',
      'Note: Guidance uses the documented Work window as the planning budget; backend usage and remaining capacity are unknown.',
    ].join('\n'),
  );
});

test('user override: 91k / 128k renders exactly (HIGH planning risk, budget note)', () => {
  assert.equal(
    renderFor(91000, budget(128000)),
    [
      'Context Estimate',
      'Estimated accessible text: ~91k tokens',
      'Planning budget: 128k (user budget)',
      'Model: not identified',
      '[██████████████░░░░░░] ~71% of planning budget',
      'Handoff priority: HIGH',
      '',
      'Recommendation:',
      'Run /handoff before starting another major task.',
      '',
      'Note: Guidance uses your planning budget; actual model capacity and backend usage are unknown.',
    ].join('\n'),
  );
});

test('exact boundaries 50/70/90 and adjacent values classify as planning risk', () => {
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
  for (const [u, level] of cases) {
    assert.equal(p.classify(u), level, `usage ${u}`);
    assert.deepEqual(p.planningRisk(u, { source: 'override' }), { level, reasons: [] });
  }
});

test('boundaries from token counts (exact and ±1 token), under a user budget and the documented default', () => {
  for (const limit of [budget(128000), SOL]) {
    for (const [pct, below, atOrAbove] of [
      [50, 'LOW', 'MEDIUM'],
      [70, 'MEDIUM', 'HIGH'],
      [90, 'HIGH', 'CRITICAL'],
    ]) {
      const tokens = (pct / 100) * limit.value;
      assert.ok(Number.isInteger(tokens));
      const risk = (t) => p.planningRisk(p.usagePercent(t, limit.value), { source: limit.source }).level;
      assert.equal(risk(tokens - 1), below);
      assert.equal(risk(tokens), atOrAbove);
      assert.equal(risk(tokens + 1), atOrAbove);
    }
  }
});

test('classification uses unrounded share even when display rounds across a threshold', () => {
  const out = renderFor(0.696 * 128000, budget(128000)); // 69.6% displays ~70% but is MEDIUM
  assert.match(out, /~70% of planning budget/);
  assert.match(out, /^Handoff priority: MEDIUM$/m);
  assert.match(out, /Continue, but plan a \/handoff before a long task\./);
  const below50 = renderFor(0.4996 * 128000, budget(128000));
  assert.match(below50, /~50% of planning budget/);
  assert.match(below50, /^Handoff priority: LOW$/m);
});

test('share above 100% is preserved, not capped, and keeps the planning label', () => {
  const out = renderFor(150000, budget(128000));
  assert.match(out, /Estimated accessible text: ~150k tokens/);
  assert.match(out, /^\[█{20}\] ~117% of planning budget$/m);
  assert.match(out, /^Handoff priority: CRITICAL$/m);
  assert.match(out, /Run \/handoff now before continuing substantial work\./);
  assert.match(out, /Visible text exceeds the planning budget; backend usage is unknown, and ChatGPT may compact or truncate internally, which this skill cannot see\./);
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
  assert.equal(p.formatLimit(500000), '500k');
  assert.equal(p.formatLimit(1000000), '1M');
  assert.equal(p.formatLimit(131072), '131,072');
  assert.equal(p.formatPercent(0.4), '<1%');
  assert.equal(p.formatPercent(1), '~1%');
  assert.equal(p.formatPercent(32.8125), '~33%');
  assert.equal(p.formatPercent(71.09375), '~71%');
  assert.equal(p.formatPercent(49.5), '~50%');
});

test('invocation parsing: limit, model, and bar options', () => {
  const none = { override: { status: 'none' }, barStyle: 'unicode', model: { status: 'none' } };
  assert.deepEqual(p.parseInvocation('/contextestimate'), none);
  assert.deepEqual(p.parseInvocation('  /contextestimate  '), none);
  assert.equal(p.parseInvocation('/contextestimate limit=200000').override.value, 200000);
  assert.equal(p.parseInvocation('/contextestimate limit=200000 limit=200000').override.status, 'valid');
  for (const bad of ['0', '-5', '1.5', '200k', '200,000', '2e5', '', 'abc', '0128000', '99999999999999999999']) {
    assert.equal(p.parseInvocation(`/contextestimate limit=${bad}`).override.status, 'invalid', bad);
  }
  assert.equal(p.parseInvocation('/contextestimate limit=100000 limit=200000').override.status, 'invalid');
  assert.equal(p.parseInvocation('please /contextestimate'), null);
  assert.equal(p.parseInvocation('/contextestimates'), null);
  const sol = p.parseInvocation('/contextestimate model=gpt-6.1-sol').model;
  assert.deepEqual([sol.status, sol.raw, sol.id, sol.resolution.state], ['asserted', 'gpt-6.1-sol', 'gpt-6.1-sol', 'recognized']);
  assert.equal(p.parseInvocation('/contextestimate model=GPT-6.1_Sol').model.id, 'gpt-6.1-sol');
  assert.equal(p.parseInvocation('/contextestimate model=gpt-6.1-sol model=gpt-6.1-sol').model.status, 'asserted');
  assert.equal(p.parseInvocation('/contextestimate model=gpt-6.1-sol model=gpt-6-luna').model.status, 'conflicting');
  assert.equal(p.parseInvocation('/contextestimate model=').model.status, 'none');
  // A malformed value is still model input, but it is not recognized (see model-resolution.test.js).
  assert.equal(p.parseInvocation('/contextestimate model=!!').model.resolution.state, 'unrecognized');
  assert.equal(p.parseInvocation('/contextestimate limit=5 model=gpt-6.1-sol bar=ascii').barStyle, 'ascii');
});

test('options are read from the first line only', () => {
  const later = p.parseInvocation('/contextestimate\nlimit=999 model=gpt-6.1-sol bar=ascii');
  assert.deepEqual(later, { override: { status: 'none' }, barStyle: 'unicode', model: { status: 'none' } });
});

test('user-override label and invalid-limit note', () => {
  const ok = renderFor(42000, budget(200000));
  assert.match(ok, /Planning budget: 200k \(user budget\)/);
  assert.match(ok, /~21% of planning budget/);
  const bad = renderFor(42000, limitFor('/contextestimate limit=200k model=gpt-6.1-sol'), { invalidLimitRaw: '200k' });
  assert.match(bad, /Planning budget: 500k \(documented GPT-6.1 Sol Work window, checked 2026-10-23\)/);
  assert.match(bad, /Note: Ignored invalid limit "200k"\.$/);
});

test('unmeasured attachments: partial coverage, UNKNOWN planning risk, no lower-bound claim', () => {
  const out = renderFor(30000, budget(128000), { unmeasured: true });
  assert.match(out, /Estimated accessible text: ~30k tokens \(text only\)/);
  assert.match(out, /\[█{5}░{15}\] ~23% of planning budget \(text only\)/);
  assert.match(out, /^Handoff priority: UNKNOWN \(unmeasured attachments\)$/m);
  assert.match(out, /^Consider \/handoff before substantial work; attachments or images are not counted\.$/m);
  assert.match(out, /Note: Counts visible text only, not ChatGPT's backend token usage; attachments or images were not counted, so actual usage may differ\./);
  assert.doesNotMatch(out, /lower bound|Handoff priority: LOW|Continue normally/i);
});

test('50k partial history under the default budget: UNKNOWN from coverage alone, never LOW', () => {
  const out = renderFor(50000, BASELINE, { compacted: true });
  assert.equal(
    out,
    [
      'Context Estimate',
      'Estimated accessible text: ~50k tokens (partial)',
      'Planning budget: 128k (default heuristic)',
      'Model: not identified',
      '[████████░░░░░░░░░░░░] ~39% of planning budget (partial)',
      'Handoff priority: UNKNOWN (partial history)',
      '',
      'Recommendation:',
      'Consider /handoff before substantial work; earlier history is not counted.',
      '',
      "Note: Counts visible text only, not ChatGPT's backend token usage or internal compaction; earlier history is summarized or truncated, so actual usage may be higher or lower.",
    ].join('\n'),
  );
  assert.doesNotMatch(out, /lower bound|Handoff priority: (LOW|MEDIUM|HIGH|CRITICAL)|Continue/);
});

test('partial history stays UNKNOWN at every share; recommendation scales with the counted share', () => {
  const expectBase = [
    [0, 'Consider /handoff before substantial work'],
    [0.69, 'Consider /handoff before substantial work'],
    [0.7, 'Run /handoff before starting another major task'],
    [0.899, 'Run /handoff before starting another major task'],
    [0.9, 'Run /handoff now before continuing substantial work'],
    [1.4, 'Run /handoff now before continuing substantial work'],
  ];
  for (const limit of [budget(128000), SOL]) {
    for (const [share, base] of expectBase) {
      const out = renderFor(share * limit.value, limit, { compacted: true });
      assert.match(out, /^Handoff priority: UNKNOWN \(partial history\)$/m, `${limit.source} ${share}`);
      assert.ok(out.includes(`${base}; earlier history is not counted.`), `${share}: ${out}`);
      assert.doesNotMatch(out, /lower bound/i);
    }
  }
});

test('partial history plus unmeasured attachments uses the combined labels', () => {
  const out = renderFor(6000, budget(128000), { compacted: true, unmeasured: true });
  assert.match(out, /~6k tokens \(partial\)/);
  assert.match(out, /Handoff priority: UNKNOWN \(partial history; unmeasured attachments\)/);
  assert.match(out, /earlier history and attachments or images are not counted\./);
  assert.match(out, /^Note: Counts visible text only, not ChatGPT's backend token usage or internal compaction; earlier history is summarized or truncated and attachments/m);
});

test('invalid-limit and conflicting-model notes are appended under the primary note', () => {
  const out = renderFor(6000, budget(128000), { compacted: true, invalidLimitRaw: 'x', conflictingModel: true });
  const notes = out.split('\n').filter((l) => l.startsWith('Note:'));
  assert.equal(notes.length, 3);
  assert.match(notes[0], /Counts visible text only/);
  assert.equal(notes[1], 'Note: Ignored invalid limit "x".');
  assert.equal(notes[2], 'Note: Ignored conflicting model values.');
});

test('unavailable estimate returns Unavailable and UNKNOWN planning risk, no number and no bar', () => {
  const out = p.render({ kind: 'unavailable', limit: BASELINE });
  assert.equal(
    out,
    [
      'Context Estimate',
      'Estimated accessible text: Unavailable',
      'Planning budget: 128k (default heuristic)',
      'Model: not identified',
      'Handoff priority: UNKNOWN (no defensible text estimate)',
      '',
      'Recommendation:',
      'If this chat feels long, consider /handoff before substantial work.',
      '',
      'Note: Conversation content could not be measured.',
    ].join('\n'),
  );
  assert.doesNotMatch(out, /\d+k tokens|\d+%|\[/);
});

test('host telemetry requires a matching host limit and is labeled as measured, not planning', () => {
  const out = p.render({ kind: 'host', tokens: 61240, limit: BASELINE, hostLimit: 128000 });
  assert.match(out, /Measured context: 61,240 tokens \(host-reported\)/);
  assert.match(out, /Context limit: 128k \(host-reported\)/);
  assert.match(out, /~48% of context limit \(host-reported\)/);
  assert.match(out, /^Handoff priority: LOW \(host-reported usage\)$/m);
  assert.match(out, /Note: Host-reported measurement\./);
  assert.doesNotMatch(out, /Planning|Estimated|Visible-text/);
});

test('tokenized transcript names the tokenizer and claims nothing about Work models', () => {
  const out = p.render({ kind: 'transcript', tokens: 64000, limit: SOL, tokenizer: 'o200k_base' });
  assert.match(out, /Tokenized transcript: ~64k tokens \(supplied text; tokenizer: o200k_base\)/);
  assert.match(out, /Planning budget: 500k \(documented GPT-6.1 Sol Work window, checked 2026-10-23\)/);
  assert.match(out, /Note: Counts the supplied text with o200k_base; it may not match any Work model's tokenizer or the active context\./);
  assert.doesNotMatch(out, /host-reported|Measured context/);
});

test('every rendered report is short and never claims to run /handoff', () => {
  for (const limit of [BASELINE, SOL, budget(200000)]) {
    for (let tokens = 0; tokens <= 600000; tokens += 7500) {
      for (const flags of [{}, { unmeasured: true }, { compacted: true }, { compacted: true, unmeasured: true }]) {
        const out = renderFor(tokens, limit, flags);
        assert.doesNotMatch(out, /\b(running|ran|started|executing|executed|generated)\b.*handoff/i);
        assert.ok(out.split('\n').length <= 13);
        assert.equal(out.split('\n')[0], 'Context Estimate');
        assert.match(out, /^Handoff priority: /m);
        assert.doesNotMatch(out, /^Risk: |Estimated usage|Configured context limit/m);
      }
    }
  }
});
