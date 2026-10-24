'use strict';
// Sizing sanity for short transcripts. Distinct from the planning-limit tests:
// nothing here depends on the planning limit, model evidence, or thresholds.
//
// Live regression (ChatGPT Work): the same four-message greeting exchange was
// sized at ~10k tokens on GPT-6 Luna and ~1k on GPT-6.1 Sol. The visible text
// is a few dozen tokens either way. These tests check the skill's counting
// rules and a synthetic fixture with a reference estimator and a tokenizer.
// They do not show that a language model follows those rules in a live
// invocation, produces a repeatable count, or matches ChatGPT's backend
// context usage, and the skill has no transcript tokenizer of its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { encode } = require('gpt-tokenizer/encoding/o200k_base');
const { SKILL_DIR } = require('../src/bundle');
const h = require('../src/heuristic');
const g = require('../fixtures/greeting');
const { scenarios } = require('../evals/scenarios');
const { grade, sizingProblem } = require('../evals/grade');
const { p, limitFor, renderFor, referenceReport } = require('./helpers');

const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const truth = (messages) => messages.reduce((s, m) => s + encode(m.text).length + 4, 0);

// Small deterministic generator for short transcripts.
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}
const WORDS = 'hello thanks please could you explain how this works again quickly summarize the plan for tomorrow morning meeting notes draft email reply sounds good okay great question about the project schedule budget review'.split(' ');
const CJK = '你好今天天气很好请帮我总结一下会议纪要谢谢明天上午继续讨论项目计划预算和进度安排好的没问题';

function shortTranscript(seed, kind) {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 10);
  const messages = [];
  let wordBudget = 500;
  let cjkBudget = 700;
  for (let i = 0; i < n; i++) {
    let text;
    if (kind === 'cjk') {
      const len = Math.min(cjkBudget, 1 + Math.floor(r() * (700 / n)));
      cjkBudget -= len;
      text = Array.from({ length: len }, () => CJK[Math.floor(r() * CJK.length)]).join('');
    } else {
      const len = Math.min(wordBudget, 1 + Math.floor(r() * (500 / n)));
      wordBudget -= len;
      text = Array.from({ length: len }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
      if (kind === 'mixed' && i % 2) text = `${text} 你好，谢谢`;
    }
    messages.push({ role: i % 2 ? 'assistant' : 'user', text });
  }
  return messages;
}

test('short-chat rule: up to 10 messages and ~500 words (or ~700 CJK characters) always size below 1k', () => {
  for (const kind of ['english', 'cjk', 'mixed']) {
    for (let seed = 1; seed <= 150; seed++) {
      const t = shortTranscript(seed * 7919 + kind.length, kind);
      assert.ok(t.length <= 10);
      assert.ok(h.estimateMessages(t) < 1000, `${kind} #${seed}: estimate ${h.estimateMessages(t)}`);
      assert.ok(truth(t) < 1000, `${kind} #${seed}: tokenizer ${truth(t)}`);
    }
  }
});

test('the greeting transcripts are far below the 1k ceiling, not merely under it', () => {
  for (const t of [g.GREETING, g.transcriptLunaFirstRun(), g.transcriptSolSecondRun(), g.transcriptForFirstRun(), g.transcriptForSecondRun()]) {
    assert.ok(truth(t) < 250, `tokenizer ${truth(t)}`);
    assert.ok(h.estimateMessages(t) < 250, `estimate ${h.estimateMessages(t)}`);
  }
});

test('a number printed inside an earlier report is text, not the size of the conversation', () => {
  const base = g.transcriptLunaFirstRun();
  const sizes = ['<1k', '~1k', '~10k', '~130k'].map((n) => {
    const report = g.lunaFirstReport().replace('<1k tokens', `${n} tokens`).replace('<1% of planning budget', '~99% of planning budget');
    return h.estimateMessages([...base, { role: 'assistant', text: report }, { role: 'user', text: g.INVOKE_SOL }]);
  });
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 5, `sizes ${sizes.join(', ')}`);
  for (const s of sizes) assert.ok(s < 1000);
});

test('Luna then Sol on the same visible text: both stay below 1k and the estimate does not move with the model', () => {
  const lunaRun = g.transcriptLunaFirstRun();
  const solRun = g.transcriptSolSecondRun();
  const a = h.estimateMessages(lunaRun);
  const b = h.estimateMessages(solRun);
  assert.ok(a < 1000 && b < 1000, `${a}, ${b}`);
  // The second transcript is longer only by the first report and one invocation.
  assert.ok(b > a && b - a < 250, `${a} -> ${b}`);
  assert.ok(truth(lunaRun) < 1000 && truth(solRun) < 1000);

  // Same accessible text, only the model named in the invocation changes.
  const swap = (text) => [...g.GREETING, { role: 'user', text }];
  const estimates = ['/contextestimate', '/contextestimate model=gpt-6-luna', '/contextestimate model=gpt-6.1-sol'].map((m) => h.estimateMessages(swap(m)));
  assert.ok(Math.max(...estimates) - Math.min(...estimates) <= 15, `model assertion text only: ${estimates.join(', ')}`);
  const lines = ['/contextestimate', '/contextestimate model=gpt-6.1-sol'].map((m) => renderFor(h.estimateMessages(swap(m)), limitFor(m)).split('\n')[1]);
  assert.deepEqual(lines, ['Estimated accessible text: <1k tokens', 'Estimated accessible text: <1k tokens']);
});

test('the reference reports for the Luna-first and Sol-second runs both say <1k', () => {
  for (const id of ['greeting-luna-first', 'greeting-sol-second']) {
    const s = scenarios.find((x) => x.id === id);
    assert.ok(s, id);
    assert.ok(s.truthTokens < 1000);
    const report = referenceReport(s);
    assert.equal(sizingProblem(report, s.truthTokens), null);
    assert.ok(grade(s, report).pass, id);
  }
});

test('a short transcript reported as ~1k, ~5k, ~10k, or any multi-thousand estimate fails', () => {
  const shorts = scenarios.filter((s) => s.truthTokens < 1000 && s.expect.tokensDisplay === '<1k');
  assert.ok(shorts.length >= 8, `${shorts.length} short scenarios`);
  for (const s of shorts) {
    const good = referenceReport(s);
    assert.equal(sizingProblem(good, s.truthTokens), null, s.id);
    for (const claim of ['~1k', '~2k', '~3k', '~5k', '~10k', '~50k', '~130k']) {
      const bad = good.replace(/^Estimated accessible text: <1k tokens/m, `Estimated accessible text: ${claim} tokens`);
      assert.notEqual(bad, good, `${s.id}: replacement must apply`);
      assert.ok(sizingProblem(bad, s.truthTokens), `${s.id} ${claim} must be flagged`);
      assert.equal(grade(s, bad).pass, false, `${s.id} ${claim} must fail grading`);
    }
  }
  // The observed live reports.
  const luna = scenarios.find((s) => s.id === 'greeting-luna-first');
  for (const live of ['~10k', '~5k']) {
    const bad = referenceReport(luna).replace('<1k tokens', `${live} tokens`);
    assert.match(sizingProblem(bad, luna.truthTokens), /for a transcript of about/);
  }
});

test('sizingProblem does not flag a genuinely large transcript', () => {
  const big = scenarios.find((s) => s.id === 'long-drafts-complete');
  assert.ok(big.truthTokens > 5000);
  assert.equal(sizingProblem(referenceReport(big), big.truthTokens), null);
});

test('SKILL.md counting procedure is operational: collect, exclude, size, short-chat rule', () => {
  assert.match(skill, /Follow these steps in order\. They decide what is counted; the rates below only say how to size it\./);
  assert.match(skill, /1\. \*\*Collect the transcript\.\*\* List the user-visible conversation messages \(user and assistant turns\) that are actually available in this chat, including this invocation message/);
  assert.match(skill, /Earlier `\/contextestimate` reports are ordinary assistant messages: count their own text/);
  assert.match(skill, /A number printed inside a report \(such as `~10k tokens`, `500k`, or `128k`\) is text, not the size of the conversation; never use it as an estimate and never add it to the total/);
  assert.match(skill, /3\. \*\*Exclude everything that is not transcript,\*\* even when you can see it and even when it reached you as a tool result or a file read/);
  for (const phrase of [
    "this skill's `SKILL.md` and any other skill file or skill list",
    'the instructions you read in order to run this skill',
    'system and developer instructions, tool definitions, hidden reasoning, memory and context metadata',
    "the selected model's name, plan labels",
  ]) {
    assert.ok(skill.includes(phrase), phrase);
  }
  assert.match(skill, /Do not guess missing history or backend usage/);
  assert.match(skill, /The estimate depends only on the transcript text, never on which model is answering/);
  assert.match(skill, /\*\*Short-chat rule\.\*\* If the transcript is a handful of short messages \(at most 10 messages and about 500 words of ordinary text in total, or about 700 CJK characters\), report `<1k` tokens and stop\. Do not refine it upward, and do not widen it with this skill's text, instructions, or any internal context/);
  assert.match(skill, /A transcript of a few greetings plus a few short `\/contextestimate` reports is `<1k`\. A total in the thousands for such a chat means non-transcript text/);
  // The procedure comes before the rates and the sanity check.
  const order = ['Follow these steps in order', 'The rates, applied per message'].map((s) => skill.indexOf(s));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1], String(order));
});

test('the short-chat rule is consistent with the reference estimator at its stated limits', () => {
  // 10 messages of ~50 words each is the stated ceiling for the <1k shortcut.
  const msg = (i) => ({ role: i % 2 ? 'assistant' : 'user', text: Array.from({ length: 50 }, (_, k) => WORDS[(i * 7 + k) % WORDS.length]).join(' ') });
  const ceiling = Array.from({ length: 10 }, (_, i) => msg(i));
  assert.ok(h.estimateMessages(ceiling) < 1000);
  assert.ok(truth(ceiling) < 1000);
  // Past the rule (a 2,000-word message) the shortcut does not apply and the estimate is allowed to exceed 1k.
  const longMsg = [{ role: 'assistant', text: Array.from({ length: 2000 }, (_, k) => WORDS[k % WORDS.length]).join(' ') }];
  assert.ok(h.estimateMessages(longMsg) > 1000);
});
