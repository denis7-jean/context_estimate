'use strict';
// Grades /contextestimate reports against the scenarios. Works on any saved
// outputs: model dry runs, or text copied from ChatGPT during the manual
// smoke test.
//
//   node evals/grade.js <outputs-dir>
//
// <outputs-dir> holds <scenario-id>.txt files; missing files are reported as
// NOT RUN rather than failures.

const fs = require('node:fs');
const path = require('node:path');
const { scenarios } = require('./scenarios');
const { RECOMMENDATIONS, barFill } = require('../src/policy');

const REASON = '(?:partial history|unmeasured attachments)';
const PRIORITY_RE = new RegExp(`^Handoff priority: (LOW|MEDIUM|HIGH|CRITICAL|UNKNOWN)(?: \\((${REASON}(?:; ${REASON})*)\\))?$`);
const BAR_RE = /^\[([█░]{20}|[#.]{20})\] (<1%|~\d+%) of planning budget(?: \((?:partial|text only)\))?$/;
const BASE = '(Consider \\/handoff before substantial work|Run \\/handoff before starting another major task|Run \\/handoff now before continuing substantial work)';
const HIST = '(?:earlier history is not counted|attachments or images are not counted|earlier history and attachments or images are not counted)';
const PARTIAL_REC_RE = new RegExp(`^${BASE}; ${HIST}\\.$`);
// Wording that would present a budget as the model's real capacity, or usage as measured.
const OVERCLAIM_RE =
  /backend (usage|tokens?) (is|was|are) (measured|\d)|measured (backend|context)|actual (usage|context) (is|was) \d|remaining capacity (is|was) \d|(heuristic|default|planning) budget is (the|your) model'?s|model'?s (actual|real) (window|capacity) is|128k is (the|a) documented/i;

function parseTokens(display) {
  if (/^<1k\b/.test(display)) return { lo: 0, hi: 999, mid: 500 };
  const m = /^~?([\d,.]+)\s*([kKmM]?)\b/.exec(display);
  if (!m) return null;
  const mult = { '': 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[m[2]];
  const v = parseFloat(m[1].replace(/,/g, '')) * mult;
  return { lo: v, hi: v, mid: v };
}

function grade(scenario, output) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  const text = output.replace(/\r\n/g, '\n').trim();
  const raw = text.split('\n').map((l) => l.trimEnd());
  const lines = raw.filter((l) => l !== '');
  const exp = scenario.expect;

  // Layout: header, text, planning budget, model, bar+share, handoff priority,
  // blank, "Recommendation:", recommendation, blank, notes.
  add('no code fences', !/```/.test(text));
  const layoutOk =
    lines.length >= 9 &&
    lines.length <= 12 &&
    /^Context Estimate$/.test(lines[0]) &&
    /^Estimated accessible text: .+$/.test(lines[1]) &&
    /^Planning budget: .+$/.test(lines[2]) &&
    /^Model: .+$/.test(lines[3]) &&
    /^\[/.test(lines[4]) &&
    /^Handoff priority: /.test(lines[5]) &&
    /^Recommendation:$/.test(lines[6]);
  add('line order matches the documented layout', layoutOk, lines.slice(0, 7).join(' | '));
  const blanksOk = raw[6] === '' && raw[raw.length - 1] !== '' && raw.filter((l) => l === '').length === 2 && raw.indexOf('', 7) > 7;
  add('blank lines after the priority and after the recommendation', blanksOk);
  const notes = lines.slice(8);
  add('1–4 Note lines and nothing else after the recommendation', notes.length >= 1 && notes.length <= 4 && notes.every((l) => l.startsWith('Note: ')), notes.join(' | '));
  add(
    'uses the current labels (no "Planning limit", "Planning risk", "conservative baseline", or older labels)',
    !/^(Risk:|Planning risk|Planning limit|Estimated usage|Configured context limit|Estimated visible context)|conservative baseline|of planning limit|model-relative handoff assessment/m.test(text),
  );

  // Model resolution line
  if (exp.modelLine) add('model line states how the model was resolved', lines[3] === exp.modelLine, `got "${lines[3]}"`);
  add('a user-supplied model is never called detected', !/\bdetected\b|auto-?detected|automatically (identified|detected)/i.test(lines[3] || ''));

  // Bar
  const barM = BAR_RE.exec(lines[4] || '');
  add('progress bar line is well-formed (20 cells, "of planning budget")', barM, lines[4]);
  if (barM) {
    const shownText = barM[2];
    const shown = shownText === '<1%' ? 0.5 : Number(shownText.replace(/[~%]/g, ''));
    const filled = [...barM[1]].filter((c) => c === '█' || c === '#').length;
    add('bar fill matches the displayed percentage (±1 block)', Math.abs(filled - barFill(shown)) <= 1, `${filled} blocks for ${shownText}`);
    if (exp.usageDisplay) add(`share display is ${exp.usageDisplay}`, shownText === exp.usageDisplay, shownText);
    if (exp.usageOver100) add('full bar with percentage above 100% preserved', filled === 20 && shown > 100, lines[4]);
  }

  // Handoff priority and recommendation
  const prioM = PRIORITY_RE.exec(lines[5] || '');
  const prioText = prioM ? lines[5].replace(/^Handoff priority: /, '') : null;
  add(`handoff priority is ${exp.risk}`, prioText === exp.risk, `got ${prioText}`);
  const rec = lines[7] || '';
  if (exp.incomplete) {
    add('UNKNOWN priority with a coverage reason', prioM && prioM[1] === 'UNKNOWN' && Boolean(prioM[2]));
    add('recommendation names what is not counted', PARTIAL_REC_RE.test(rec), rec);
  } else {
    add('recommendation matches the handoff-priority policy', prioM && rec === RECOMMENDATIONS[prioM[1]], rec);
  }
  if (exp.recommendation) add('recommendation matches expected wording', rec === exp.recommendation, `expected "${exp.recommendation}"`);
  add('never uses "lower bound" wording', !/lower bound/i.test(text));
  add('never presents a budget as the model window, or usage/capacity as measured', !OVERCLAIM_RE.test(text));

  // Planning budget and provenance
  const budgetVal = (lines[2] || '').replace(/^Planning budget: /, '');
  add(`planning budget is ${exp.limit}`, budgetVal === exp.limit, `got "${budgetVal}"`);

  // Accessible text
  const tokVal = (lines[1] || '').replace(/^[^:]+: /, '');
  const tok = parseTokens(tokVal);
  if (exp.incomplete === 'partial' || exp.incomplete === 'both') {
    add('context line ends with (partial)', tokVal.endsWith('(partial)'), tokVal);
  } else if (exp.incomplete === 'unmeasured') {
    add('context line ends with (text only)', tokVal.endsWith('(text only)'), tokVal);
  }
  if (exp.tokensDisplay) add(`tokens display is ${exp.tokensDisplay}`, tokVal.startsWith(exp.tokensDisplay), `got "${tokVal}"`);
  else if (tok && tok.hi === 999) {
    add('"<1k" is consistent with o200k truth', scenario.truthTokens < 1500, `truth ${scenario.truthTokens}`);
  } else if (tok) {
    const ratio = tok.mid / scenario.truthTokens;
    add('token estimate within ±50% of o200k truth', ratio >= 0.5 && ratio <= 1.5, `est ${tok.mid} vs truth ${scenario.truthTokens} (${((ratio - 1) * 100).toFixed(0)}%)`);
  } else add('token estimate parseable', false, tokVal);

  // Honesty and safety
  add('no host-measurement claim', !/host-reported|Measured context|Context risk/i.test(text));
  add(
    'does not run or draft /handoff',
    !/\b(running|ran|starting|started|executing|executed|invoking|invoked|calling)\s+(the\s+)?\/?handoff|here is (your|the) handoff|^#+\s*handoff|handoff (document|summary)\s*:/im.test(text),
  );
  for (const re of exp.must || []) add(`contains ${re}`, re.test(text));
  for (const re of exp.mustNot || []) add(`does not contain ${re}`, !re.test(text));

  return { id: scenario.id, pass: checks.every((c) => c.ok), checks };
}

function gradeDir(dir) {
  return scenarios.map((s) => {
    const file = path.join(dir, `${s.id}.txt`);
    if (!fs.existsSync(file)) return { id: s.id, notRun: true };
    return grade(s, fs.readFileSync(file, 'utf8'));
  });
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node evals/grade.js <outputs-dir>');
    process.exit(2);
  }
  const results = gradeDir(dir);
  let pass = 0;
  let fail = 0;
  let notRun = 0;
  for (const r of results) {
    if (r.notRun) {
      notRun++;
      console.log(`NOT RUN  ${r.id}`);
      continue;
    }
    r.pass ? pass++ : fail++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}     ${r.id}`);
    for (const c of r.checks) if (!c.ok) console.log(`         ✖ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(`\n${pass} passed, ${fail} failed, ${notRun} not run (of ${results.length})`);
  process.exitCode = fail ? 1 : 0;
}

// Flags a report that sizes a transcript known to be under 1k tokens at 1k or
// more (for example ~1k, ~5k, or ~10k). Returns a description, or null if fine.
function sizingProblem(report, truthTokens) {
  const m = /^Estimated accessible text: (.+)$/m.exec(report);
  if (!m) return 'no accessible-text line';
  const tok = parseTokens(m[1].replace(/ \((?:partial|text only)\)$/, ''));
  if (!tok) return `unparseable: ${m[1]}`;
  if (truthTokens < 1000 && tok.hi !== 999) return `reported ${m[1]} for a transcript of about ${truthTokens} tokens`;
  return null;
}

module.exports = { grade, gradeDir, parseTokens, sizingProblem };
