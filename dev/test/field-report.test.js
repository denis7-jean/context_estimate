'use strict';
// Regression tests for a real-world report: a ChatGPT Work chat with fewer than
// 50 turns, several full drafts of one long document, and printed "context
// optimization" text was reported as ~130k tokens (partial), ~102% of an
// assumed 128k limit. The skill must (a) count visible text only, each printed
// copy once, and (b) never imply it read backend usage or inspected internal
// compaction.
//
// These tests use synthetic documents. They do not validate the 130k figure
// from the report, which cannot be checked without the transcript.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { encode } = require('gpt-tokenizer/encoding/o200k_base');
const { SKILL_DIR } = require('../src/bundle');
const h = require('../src/heuristic');
const p = require('../src/policy');
const { draft, contextOptimization } = require('../fixtures/patent');
const { scenarios } = require('../evals/scenarios');
const { grade } = require('../evals/grade');

const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const ASSUMED = p.resolveLimit(p.parseInvocation('/contextestimate limit=128000'), 'none');
const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
const tokens = (text) => encode(text).length;

test('repeated drafts each count once: three versions cost about three times one', () => {
  const one = h.estimateText(draft(1)).tokens;
  const all = [1, 2, 3].map((v) => h.estimateText(draft(v)).tokens);
  const sum = all.reduce((a, b) => a + b, 0);
  assert.ok(sum > 2.9 * one, `${sum} vs 3x${one}`);
  const truth = [1, 2, 3].reduce((s, v) => s + tokens(draft(v)), 0);
  assert.ok(Math.abs(sum - truth) / truth <= 0.1, `${sum} vs ${truth}`);
});

test('printed "context optimization" text is counted like any other message', () => {
  const base = [{ role: 'user', text: 'Print a context optimization plan.' }];
  const withText = [...base, { role: 'assistant', text: contextOptimization }];
  const added = h.estimateMessages(withText) - h.estimateMessages(base);
  assert.ok(added >= tokens(contextOptimization) * 0.85, `added ${added}`);
});

test('fewer than 50 turns of long drafts can exceed 100k visible tokens; turn count is not evidence of size', () => {
  const longDrafts = [];
  for (let i = 0; i < 15; i++) {
    longDrafts.push({ role: 'user', text: 'Revise and print the full application again.' });
    longDrafts.push({ role: 'assistant', text: [1, 2, 3].map(draft).join('\n\n') });
  }
  assert.ok(longDrafts.length < 50);
  const truth = longDrafts.reduce((s, m) => s + tokens(m.text) + 4, 0);
  const est = h.estimateMessages(longDrafts);
  assert.ok(truth > 100000, `truth ${truth}`);
  assert.ok(Math.abs(est - truth) / truth <= 0.1, `${est} vs ${truth}`);

  const manyShort = [];
  for (let i = 0; i < 120; i++) manyShort.push({ role: i % 2 ? 'assistant' : 'user', text: 'Okay, sounds good — next item please.' });
  assert.ok(manyShort.length > 100);
  assert.ok(h.estimateMessages(manyShort) < 0.2 * est, 'many short turns are far smaller than a few long drafts');
});

test('field-report shape renders UNKNOWN with the visible-text vs backend distinction', () => {
  const s = byId['long-drafts-partial'];
  const limit = p.resolveLimit(p.parseInvocation(s.messages.at(-1).text), 'none');
  const out = p.render({ kind: 'estimate', tokens: s.truthTokens, limit, compacted: true, unmeasured: true });
  assert.match(out, /^Estimated accessible text: ~7k tokens \(partial\)$/m);
  assert.match(out, /^Planning limit: 5,300 \(user override\)$/m);
  assert.match(out, /^\[█{20}\] ~135% of planning limit \(partial\)$/m);
  assert.match(out, /^Planning risk: UNKNOWN \(partial history; unmeasured attachments\)$/m);
  assert.match(out, /^Run \/handoff now before continuing substantial work; earlier history and attachments or images are not counted\.$/m);
  assert.match(out, /Counts visible text only, not ChatGPT's backend token usage or internal compaction/);
  assert.doesNotMatch(out, /lower bound|measured by ChatGPT|backend usage is|compaction (was|occurred|happened)/i);
  assert.ok(grade(s, out).pass);
});

test('the same conversation with full coverage keeps CRITICAL and notes what the skill cannot see', () => {
  const s = byId['long-drafts-complete'];
  const limit = p.resolveLimit(p.parseInvocation(s.messages.at(-1).text), 'none');
  const out = p.render({ kind: 'estimate', tokens: s.truthTokens, limit });
  assert.match(out, /^Planning risk: CRITICAL$/m);
  assert.match(out, /~134%/);
  assert.match(out, /^Note: Visible text exceeds the planning limit; backend usage is unknown, and ChatGPT may compact or truncate internally, which this skill cannot see\.$/m);
  assert.ok(grade(s, out).pass);
});

test('the over-limit note appears only at or above 100% with full coverage', () => {
  const render = (t, extra = {}) => p.render({ kind: 'estimate', tokens: t, limit: ASSUMED, ...extra });
  assert.doesNotMatch(render(127999), /exceeds the planning limit/);
  assert.match(render(128000), /exceeds the planning limit/);
  assert.match(render(300000), /exceeds the planning limit/);
  assert.doesNotMatch(render(300000, { compacted: true }), /exceeds the planning limit/);
  assert.doesNotMatch(p.render({ kind: 'transcript', tokens: 300000, limit: ASSUMED, tokenizer: 'o200k_base' }), /exceeds the planning limit/);
});

test('every partial or over-limit note says what it does not measure', () => {
  for (const key of ['partial', 'unmeasured', 'both']) {
    assert.match(p.NOTES[key], /not ChatGPT's backend token usage/, key);
    assert.doesNotMatch(p.NOTES[key], /lower bound/i, key);
  }
  assert.match(p.NOTES.partial, /internal compaction/);
  assert.match(p.NOTES.over, /backend usage is unknown/);
  assert.match(p.NOTES.over, /which this skill cannot see/);
});

test('SKILL.md separates visible text, internal compaction, and backend usage', () => {
  assert.match(skill, /### What the number is, and is not/);
  assert.match(skill, /\*\*Visible text\*\*/);
  assert.match(skill, /\*\*Internal compaction or other backend state\*\*/);
  assert.match(skill, /\*\*Actual backend token usage\*\* — you have no access to it/);
  assert.match(skill, /Count every printed copy once, so three full drafts of the same document count three times/);
  assert.match(skill, /"context optimization" text that was printed in the chat counts like any other message/);
  assert.match(skill, /You cannot inspect it\. Never say it happened, never count or subtract it, and never present it as measured/);
  assert.match(skill, /Say history is summarized or truncated only when you can see a summary or a truncation marker/);
  assert.match(skill, /not ChatGPT's usage; it can be above or below the real figure/);
  assert.match(skill, /Turn count, chat age, and how long the chat "feels" are not evidence of size in either direction/);
  assert.match(skill, /do not stretch a count over text you cannot see/);
});

test('calibration constants and thresholds were not changed by this report', () => {
  assert.deepEqual(h.RATES, {
    cjkTokensPerChar: 0.75,
    charsPerToken: { prose: 5.0, code: 3.5, structured: 3.0, dense: 2.2 },
    perMessageOverhead: 4,
  });
  assert.deepEqual(p.DEFAULT_THRESHOLDS, { medium: 50, high: 70, critical: 90 });
  assert.equal(p.DEFAULT_LIMIT, 128000);
});
