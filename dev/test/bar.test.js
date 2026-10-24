'use strict';
// Progress bar: fixed width, deterministic fill, rounding, boundaries, >100%.

const test = require('node:test');
const assert = require('node:assert/strict');
const { p, limitFor } = require('./helpers');

const ASSUMED = limitFor('/contextestimate limit=128000'); // a user budget; bars always refer to the planning limit
const blocks = (usage, style) => (p.bar(usage, style).match(style === 'ascii' ? /#/g : /█/g) || []).length;

test('bar has a fixed width of 20 for every usage, in both styles', () => {
  for (const style of ['unicode', 'ascii']) {
    for (let u = 0; u <= 300; u += 0.25) {
      const b = p.bar(u, style);
      assert.equal([...b].length, 22, `${style} ${u}`);
      assert.ok(b.startsWith('[') && b.endsWith(']'));
    }
  }
});

test('0% is empty, and a tiny nonzero value shows one block', () => {
  assert.equal(p.bar(0), '[░░░░░░░░░░░░░░░░░░░░]');
  assert.equal(p.bar(0.001), '[█░░░░░░░░░░░░░░░░░░░]');
  assert.equal(p.bar(0.5), '[█░░░░░░░░░░░░░░░░░░░]');
  assert.equal(p.bar(7.49), '[█░░░░░░░░░░░░░░░░░░░]');
});

test('rounding rule: floor(u/5 + 0.5), half rounds up', () => {
  const cases = [
    [2.5, 1], // 0.5 + 0.5 = 1 -> 1
    [7.5, 2],
    [12.4, 2],
    [12.5, 3],
    [32.5, 7],
    [33, 7],
    [39.0625, 8], // the 50k/128k case
    [42.4, 8],
    [42.5, 9],
    [71.09375, 14], // the 91k/128k case
    [97.4, 19],
  ];
  for (const [u, n] of cases) assert.equal(blocks(u), n, `usage ${u}`);
});

test('threshold boundaries 50/70/90 and neighbors', () => {
  const cases = [
    [49.999, 10],
    [50, 10],
    [50.001, 10],
    [69.999, 14],
    [70, 14],
    [70.001, 14],
    [89.999, 18],
    [90, 18],
    [90.001, 18],
  ];
  for (const [u, n] of cases) assert.equal(blocks(u), n, `usage ${u}`);
  // Risk comes from the number, not from how many blocks are drawn.
  assert.equal(blocks(49.9), blocks(50));
  assert.notEqual(p.classify(49.9), p.classify(50));
});

test('a full bar is reserved for usage >= 100%', () => {
  assert.equal(blocks(99.9), 19);
  assert.equal(blocks(99.999999), 19);
  assert.equal(blocks(100), 20);
  assert.equal(blocks(100.0001), 20);
  assert.equal(blocks(117), 20);
  assert.equal(blocks(10000), 20);
});

test('bar is monotonic non-decreasing in usage', () => {
  let prev = -1;
  for (let u = 0; u <= 150; u += 0.1) {
    const n = p.barFill(u);
    assert.ok(n >= prev, `usage ${u}`);
    prev = n;
  }
});

test('non-finite or negative usage yields an empty bar', () => {
  for (const u of [NaN, -1, undefined]) assert.equal(p.barFill(u), 0);
});

test('above 100% the bar is full but the numeric percentage stays uncapped', () => {
  const out = p.render({ kind: 'estimate', tokens: 150000, limit: ASSUMED });
  assert.match(out, /^\[█{20}\] ~117% of planning budget$/m);
  assert.match(out, /^Handoff priority: CRITICAL$/m);
});

test('0% and sub-1% rendering keeps <1% and an honest bar', () => {
  const out = p.render({ kind: 'estimate', tokens: 6, limit: ASSUMED });
  assert.match(out, /^\[█░{19}\] <1% of planning budget$/m);
  assert.match(out, /^Handoff priority: LOW$/m);
});

test('bar percentage and fill always follow the share of the planning limit', () => {
  for (let tokens = 0; tokens <= 400000; tokens += 3137) {
    for (const flags of [{}, { compacted: true }, { unmeasured: true }]) {
      const out = p.render({ kind: 'estimate', tokens, limit: ASSUMED, ...flags });
      const usage = p.formatPercent(p.usagePercent(tokens, 128000));
      const barLine = /^\[[█░]{20}\] (<1%|~\d+%) of planning budget/m.exec(out);
      assert.ok(barLine, out);
      assert.equal(barLine[1], usage);
      const filled = (barLine[0].match(/█/g) || []).length;
      assert.equal(filled, p.barFill(p.usagePercent(tokens, 128000)));
    }
  }
});

test('planning risk is stated in words on its own line at every usage (never by the bar alone)', () => {
  for (let tokens = 0; tokens <= 200000; tokens += 1000) {
    const out = p.render({ kind: 'estimate', tokens, limit: ASSUMED });
    assert.match(out, /^Handoff priority: (LOW|MEDIUM|HIGH|CRITICAL)$/m);
  }
});

test('plain-text fallback bar uses ASCII only and the same fill', () => {
  const out = p.render({ kind: 'estimate', tokens: 50000, limit: ASSUMED, barStyle: 'ascii' });
  assert.match(out, /^\[#{8}\.{12}\] ~39% of planning budget$/m);
  assert.doesNotMatch(out.split('\n').find((l) => l.startsWith('[')), /[^\x20-\x7e]/);
  assert.equal(p.bar(39.0625, 'ascii'), '[########............]');
  assert.equal(p.bar(117, 'ascii'), '[####################]');
  assert.equal(p.bar(0, 'ascii'), '[....................]');
});

test('bar=ascii option parsing', () => {
  assert.equal(p.parseInvocation('/contextestimate').barStyle, 'unicode');
  assert.equal(p.parseInvocation('/contextestimate bar=ascii').barStyle, 'ascii');
  assert.equal(p.parseInvocation('/contextestimate limit=200000 bar=ascii').barStyle, 'ascii');
  assert.equal(p.parseInvocation('/contextestimate bar=ascii').override.status, 'none');
  assert.equal(p.parseInvocation('/contextestimate bar=fancy').barStyle, 'unicode');
  assert.equal(p.parseInvocation('/contextestimate bar=ascii bar=unicode').barStyle, 'unicode');
});

test('partial and unmeasured bars are labeled and never claim a lower bound', () => {
  const partial = p.render({ kind: 'estimate', tokens: 50000, limit: ASSUMED, compacted: true });
  assert.match(partial, /^\[█{8}░{12}\] ~39% of planning budget \(partial\)$/m);
  const text = p.render({ kind: 'estimate', tokens: 50000, limit: ASSUMED, unmeasured: true });
  assert.match(text, /^\[█{8}░{12}\] ~39% of planning budget \(text only\)$/m);
  for (const out of [partial, text]) assert.doesNotMatch(out, /lower bound|at least|minimum/i);
});

test('host and transcript variants carry a bar with a scope label', () => {
  const host = p.render({ kind: 'host', tokens: 64000, limit: ASSUMED, hostLimit: 128000 });
  assert.match(host, /^\[█{10}░{10}\] ~50% of context limit \(host-reported\)$/m);
  const tr = p.render({ kind: 'transcript', tokens: 64000, limit: ASSUMED, tokenizer: 'o200k_base' });
  assert.match(tr, /^\[█{10}░{10}\] ~50% of planning budget$/m);
});
