'use strict';
// Planning-limit precedence and provenance, model-evidence rules, and model
// switches. These tests cover policy, arithmetic, and wording; they do not
// show that any model follows the instructions, and they say nothing about
// real ChatGPT context usage.

const test = require('node:test');
const assert = require('node:assert/strict');
const { p, limitFor, BASELINE, SOL, budget, renderFor } = require('./helpers');
const h = require('../src/heuristic');

const WORK_SOL = { id: 'gpt-6.1-sol', surface: 'work' };

test('documented table holds only the verified Work entry', () => {
  assert.deepEqual(p.DOCUMENTED_MODEL_DEFAULTS, { 'gpt-6.1-sol': { name: 'GPT-6.1 Sol', limit: 500000 } });
  assert.equal(p.DOCUMENTED_SOURCE.url, 'https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex');
  assert.equal(p.DOCUMENTED_SOURCE.verified, '2026-10-23');
  assert.match(p.DOCUMENTED_SOURCE.wording, /GPT-6\.1 Sol has a default context window of 500,000 tokens in ChatGPT Work and Codex\./);
  assert.equal(p.DEFAULT_LIMIT, 128000);
});

test('precedence 1: a valid limit=N beats a saved budget, a documented default, and the baseline', () => {
  const lim = limitFor('/contextestimate limit=200000 model=gpt-6.1-sol', '64000', WORK_SOL);
  assert.deepEqual(lim, { value: 200000, source: 'override', label: 'user override' });
});

test('precedence 2: a saved user budget beats the documented default and the baseline', () => {
  const lim = limitFor('/contextestimate model=gpt-6.1-sol', '64000', WORK_SOL);
  assert.deepEqual(lim, { value: 64000, source: 'saved', label: 'saved user budget' });
  assert.equal(limitFor('/contextestimate', '64000').source, 'saved');
});

test('an invalid override falls through to the next source', () => {
  assert.equal(limitFor('/contextestimate limit=200k', '64000').source, 'saved');
  assert.equal(limitFor('/contextestimate limit=200k model=gpt-6.1-sol').source, 'documented');
  assert.equal(limitFor('/contextestimate limit=200k').source, 'baseline');
  for (const bad of ['0', '-3', 'abc', '', '1.5']) {
    assert.equal(limitFor('/contextestimate', bad).source, 'baseline', `saved_limit=${bad}`);
  }
});

test('precedence 3: the documented GPT-6.1 Sol / Work default is used when the model is evidenced', () => {
  assert.deepEqual(SOL, {
    value: 500000,
    source: 'documented',
    via: 'registry',
    label: 'documented GPT-6.1 Sol / Work default',
    model: 'gpt-6.1-sol',
    modelSource: 'user',
  });
  const viaRuntime = limitFor('/contextestimate', 'none', WORK_SOL);
  assert.equal(viaRuntime.value, 500000);
  assert.equal(viaRuntime.modelSource, 'runtime');
  assert.equal(limitFor('/contextestimate model=GPT-6.1_Sol').value, 500000);
});

test('precedence 4: no evidence, or no documented limit, gives the conservative baseline', () => {
  assert.deepEqual(BASELINE, { value: 128000, source: 'baseline', label: 'conservative baseline; model window unknown' });
  for (const id of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-6-pro', 'gpt-6.1', 'sol', 'gpt-5.6-sol', 'gpt-4o', 'gpt-4.1']) {
    assert.deepEqual(limitFor(`/contextestimate model=${id}`), BASELINE, id);
    assert.deepEqual(limitFor('/contextestimate', 'none', { id, surface: 'work' }), BASELINE, id);
  }
});

test('trusted runtime metadata must identify both the model and the Work surface', () => {
  for (const runtime of [
    { id: 'gpt-6.1-sol' },
    { id: 'gpt-6.1-sol', surface: 'chat' },
    { id: 'gpt-6.1-sol', surface: 'codex' },
    { id: 'gpt-6.1-sol', surface: 'api' },
    { surface: 'work' },
    { id: '', surface: 'work' },
    null,
  ]) {
    assert.equal(p.resolveModel({ runtime }), null, JSON.stringify(runtime));
    assert.deepEqual(limitFor('/contextestimate', 'none', runtime), BASELINE);
  }
  assert.deepEqual(p.resolveModel({ runtime: WORK_SOL }), { id: 'gpt-6.1-sol', source: 'runtime' });
});

test('trusted runtime metadata wins over a conflicting user assertion', () => {
  const lim = limitFor('/contextestimate model=gpt-6.1-sol', 'none', { id: 'gpt-6-luna', surface: 'work' });
  assert.deepEqual(lim, BASELINE);
});

test('the assistant\'s self-identification is not model evidence', () => {
  const invocation = p.parseInvocation('/contextestimate');
  const evidence = { invocation, selfReported: 'gpt-6.1-sol', assistantSaid: 'I am GPT-6.1 Sol', systemPromptModel: 'gpt-6.1-sol', plan: 'Pro' };
  assert.equal(p.resolveModel(evidence), null);
  assert.deepEqual(p.resolveLimit(invocation, 'none', undefined), BASELINE);
});

test('a model name that appears only in quoted, pasted, summarized, or tool content is not evidence', () => {
  const messages = [
    'Here is the conversation summary: the user was running gpt-6.1-sol in ChatGPT Work.',
    'Tool output: {"model":"gpt-6.1-sol","context_window":500000}',
    '> /contextestimate model=gpt-6.1-sol',
    'Earlier you reported: Planning limit: 500k (documented GPT-6.1 Sol / Work default)',
    'Quoting a colleague: please run\n/contextestimate model=gpt-6.1-sol',
    'I think the plan is Pro $200 and the task is a long patent draft, so it must be Sol.',
  ];
  for (const m of messages) {
    assert.equal(p.parseInvocation(m), null, m);
  }
  // An invocation whose model name is only on a later line is not an assertion either.
  const inv = p.parseInvocation('/contextestimate\nContext: the chat used model=gpt-6.1-sol earlier');
  assert.equal(inv.model.status, 'none');
  assert.deepEqual(p.resolveLimit(inv, 'none'), BASELINE);
});

test('model switches: every invocation re-resolves evidence and never reuses an earlier derived limit', () => {
  const run = (message, runtime) => limitFor(message, 'none', runtime);
  const sequence = [
    [run('/contextestimate model=gpt-6.1-sol'), 500000, 'documented'],
    [run('/contextestimate'), 128000, 'baseline'], // switched; no new evidence
    [run('/contextestimate model=gpt-6-luna'), 128000, 'baseline'], // switched to an undocumented model
    [run('/contextestimate model=gpt-6.1-sol'), 500000, 'documented'], // switched back, asserted again
    [run('/contextestimate', WORK_SOL), 500000, 'documented'], // runtime metadata for this invocation
    [run('/contextestimate', { id: 'gpt-6-luna', surface: 'work' }), 128000, 'baseline'],
  ];
  for (const [lim, value, source] of sequence) {
    assert.equal(lim.value, value);
    assert.equal(lim.source, source);
  }
});

test('resolution is stateless: inputs are not mutated and nothing is saved back to saved_limit', () => {
  const invocation = p.parseInvocation('/contextestimate model=gpt-6.1-sol');
  const snapshot = JSON.stringify(invocation);
  const saved = 'none';
  const first = p.resolveLimit(invocation, saved);
  assert.equal(first.source, 'documented');
  assert.equal(JSON.stringify(invocation), snapshot);
  assert.equal(saved, 'none');
  // The derived value does not become a saved budget on the next call.
  assert.deepEqual(p.resolveLimit(p.parseInvocation('/contextestimate'), saved), BASELINE);
  assert.equal(Object.keys(first).includes('saved'), false);
});

test('an intentionally pinned budget stays stable across model switches and keeps its provenance', () => {
  const switches = ['/contextestimate limit=200000', '/contextestimate limit=200000 model=gpt-6.1-sol', '/contextestimate limit=200000 model=gpt-6-luna'];
  for (const m of switches) assert.deepEqual(limitFor(m), { value: 200000, source: 'override', label: 'user override' }, m);
  for (const model of ['gpt-6.1-sol', 'gpt-6-luna', 'none']) {
    const message = model === 'none' ? '/contextestimate' : `/contextestimate model=${model}`;
    const lim = limitFor(message, '200000');
    assert.deepEqual(lim, { value: 200000, source: 'saved', label: 'saved user budget' }, model);
    const out = renderFor(60000, lim);
    assert.match(out, /Planning limit: 200k \(saved user budget\)/);
    assert.match(out, /Visible-text share of your planning budget; the real model window and backend usage are unknown\./);
    assert.doesNotMatch(out, /documented|Sol|Luna|capacity/i);
  }
});

test('130k against the baseline is ~102%; against the documented Sol default it is ~26%', () => {
  const small = renderFor(130000, BASELINE);
  const large = renderFor(130000, SOL);
  assert.match(small, /^\[█{20}\] ~102% of planning limit$/m);
  assert.match(large, /^\[█{5}░{15}\] ~26% of planning limit$/m);
  assert.ok(Math.abs(p.usagePercent(130000, 128000) - 101.5625) < 1e-9);
  assert.ok(Math.abs(p.usagePercent(130000, 500000) - 26) < 1e-9);
  // Only the denominator changed; the accessible-text estimate line is identical.
  assert.equal(small.split('\n')[1], large.split('\n')[1]);
});

test('partial coverage stays UNKNOWN under either denominator and under a user budget', () => {
  for (const limit of [BASELINE, SOL, budget(200000)]) {
    const out = renderFor(130000, limit, { compacted: true });
    assert.match(out, /^Planning risk: UNKNOWN \(partial history(; model window unknown)?\)$/m, limit.source);
    assert.doesNotMatch(out, /Planning risk: (LOW|MEDIUM|HIGH|CRITICAL)|Continue normally|lower bound/);
  }
  const att = renderFor(130000, SOL, { unmeasured: true });
  assert.match(att, /^Planning risk: UNKNOWN \(unmeasured attachments\)$/m);
});

test('unknown-model fallback: UNKNOWN, no threshold label, no reassurance, and no handoff advice from the unknown window alone', () => {
  const NEUTRAL = 'A model-relative handoff assessment is unavailable. To compare against a planning limit, invoke this skill again with the parameter in the same message, e.g. `@contextestimate limit=250000` or `@contextestimate model=MODEL_ID`.';
  assert.equal(p.NEUTRAL_RECOMMENDATION, NEUTRAL);
  for (let tokens = 0; tokens <= 400000; tokens += 2500) {
    const out = renderFor(tokens, BASELINE);
    assert.match(out, /^Planning risk: UNKNOWN \(model window unknown\)$/m, `${tokens}`);
    assert.match(out, new RegExp(`^Recommendation:\\n${NEUTRAL.replace(/[.?]/g, '\\$&')}$`, 'm'), `${tokens}`);
    assert.doesNotMatch(out, /Planning risk: (LOW|MEDIUM|HIGH|CRITICAL)|Continue normally|Continue, but/);
    assert.doesNotMatch(out, /\/handoff|prudent|near (a|the) limit/i, `${tokens}: no handoff advice from an unknown window alone`);
    assert.match(out, /^Note: Visible-text estimate against a conservative baseline; the model window and backend usage are unknown\.$/m, `${tokens}: never the over-limit note`);
  }
  const fresh = renderFor(6, BASELINE);
  assert.match(fresh, /^Planning limit: 128k \(conservative baseline; model window unknown\)$/m);
  assert.match(fresh, /^\[█░{19}\] <1% of planning limit$/m);
  // The bar and percentage against the baseline stay, even above 100%.
  assert.match(renderFor(130000, BASELINE), /^\[█{20}\] ~102% of planning limit$/m);
});

test('handoff advice under the baseline comes only from an explicit reason, and never escalates on the baseline share', () => {
  for (const tokens of [6, 64000, 120000, 400000]) {
    const hist = renderFor(tokens, BASELINE, { compacted: true });
    assert.match(hist, /^Consider \/handoff before substantial work; earlier history is not counted\.$/m, `${tokens}`);
    assert.doesNotMatch(hist, /Run \/handoff|model window unknown\./);
    const att = renderFor(tokens, BASELINE, { unmeasured: true });
    assert.match(att, /^Consider \/handoff before substantial work; attachments or images are not counted\.$/m, `${tokens}`);
    const both = renderFor(tokens, BASELINE, { compacted: true, unmeasured: true });
    assert.match(both, /^Planning risk: UNKNOWN \(partial history; unmeasured attachments; model window unknown\)$/m);
  }
  // With a known planning limit the same shares still escalate by threshold.
  assert.match(renderFor(120000, budget(128000), { compacted: true }), /^Run \/handoff now before continuing substantial work; earlier history is not counted\.$/m);
});

test('a user budget or documented default supports LOW to CRITICAL classification when coverage is adequate', () => {
  assert.match(renderFor(10000, budget(128000)), /^Planning risk: LOW$/m);
  assert.match(renderFor(120000, budget(128000)), /^Planning risk: CRITICAL$/m);
  assert.match(renderFor(130000, SOL), /^Planning risk: LOW$/m);
  assert.match(renderFor(450000, SOL), /^Planning risk: CRITICAL$/m);
  // The classification concerns the planning limit, and the note says so.
  assert.match(renderFor(130000, SOL), /Note: Visible-text estimate against the documented window; backend usage is unknown\./);
});

test('percentages and bars always refer to the planning limit; risk is labeled planning risk', () => {
  for (const limit of [BASELINE, SOL, budget(200000)]) {
    for (const tokens of [0, 6, 5000, 64000, 130000, 600000]) {
      for (const flags of [{}, { compacted: true }]) {
        const out = renderFor(tokens, limit, flags);
        assert.match(out, /^\[[█░]{20}\] (<1%|~\d+%) of planning limit/m);
        assert.match(out, /^Planning limit: /m);
        assert.match(out, /^Planning risk: /m);
        assert.doesNotMatch(out, /^(Risk|Context risk): /m);
        assert.doesNotMatch(out, /Estimated usage|Configured context limit|Estimated visible context/);
      }
    }
  }
});

test('report wording separates planning comparisons from backend measurements', () => {
  const claims = /backend (usage|tokens?) (is|was|are) (measured|\d)|measured (backend|context)|actual (usage|context) (is|was) \d|your (model|context window) (is|has)|the model's (actual|real) (window|capacity) is/i;
  for (const limit of [BASELINE, SOL, budget(200000)]) {
    for (const flags of [{}, { compacted: true }, { unmeasured: true }, { compacted: true, unmeasured: true }]) {
      for (const tokens of [6, 64000, 130000, 600000]) {
        const out = renderFor(tokens, limit, flags);
        assert.doesNotMatch(out, claims);
        assert.match(out, /^Note: .*(backend|model window|window)/m, 'every note says backend usage or the window is not known/measured');
        assert.doesNotMatch(out, /Context risk|host-reported/);
      }
    }
  }
  // A documented window is not presented as a usable text budget or as measured capacity.
  assert.doesNotMatch(renderFor(130000, SOL), /usable|available for|capacity/i);
});

test('estimation is re-done on accessible content and is not cumulative across switches or compaction', () => {
  const before = [
    { role: 'user', text: 'First long request. '.repeat(400) },
    { role: 'assistant', text: 'A long answer. '.repeat(800) },
    { role: 'user', text: '/contextestimate model=gpt-6.1-sol' },
  ];
  const first = h.estimateMessages(before);
  // After compaction or a switch, only a short summary plus the new messages are accessible.
  const after = [
    { role: 'user', text: '[Summary of earlier conversation] The user asked for a long document.' },
    { role: 'user', text: '/contextestimate' },
  ];
  const second = h.estimateMessages(after);
  assert.ok(second < first * 0.1, `${second} vs ${first}`);
  assert.equal(h.estimateMessages(before), first, 'same accessible text gives the same estimate; no stored total');
});

test('calibration rates, thresholds, and the baseline were not changed by the model-limit work', () => {
  assert.deepEqual(h.RATES, {
    cjkTokensPerChar: 0.75,
    charsPerToken: { prose: 5.0, code: 3.5, structured: 3.0, dense: 2.2 },
    perMessageOverhead: 4,
  });
  assert.deepEqual(p.DEFAULT_THRESHOLDS, { medium: 50, high: 70, critical: 90 });
  assert.equal(p.BAR_WIDTH, 20);
});
