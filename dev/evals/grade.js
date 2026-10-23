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
const { RECOMMENDATIONS, NEUTRAL_RECOMMENDATION, barFill } = require('../src/policy');

const REASON = '(?:partial history|unmeasured attachments|model window unknown)';
const RISK_RE = new RegExp(`^Planning risk: (LOW|MEDIUM|HIGH|CRITICAL|UNKNOWN)(?: \\((${REASON}(?:; ${REASON})*)\\))?$`);
const BAR_RE = /^\[([█░]{20}|[#.]{20})\] (<1%|~\d+%) of planning limit(?: \((?:partial|text only)\))?$/;
const BASE = '(Consider \\/handoff before substantial work|Run \\/handoff before starting another major task|Run \\/handoff now before continuing substantial work)';
const HIST = '(?:earlier history is not counted|attachments or images are not counted|earlier history and attachments or images are not counted)';
const UNKNOWN_REC_RE = new RegExp(`^${BASE}; ${HIST}\\.$`);

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

  // Layout: header, text, planning limit, bar+share, planning risk,
  // "Recommendation:", recommendation, notes.
  add('no code fences', !/```/.test(text));
  const layoutOk =
    lines.length >= 8 &&
    lines.length <= 10 &&
    /^Context Estimate$/.test(lines[0]) &&
    /^Estimated accessible text: .+$/.test(lines[1]) &&
    /^Planning limit: .+$/.test(lines[2]) &&
    /^\[/.test(lines[3]) &&
    /^Planning risk: /.test(lines[4]) &&
    /^Recommendation:$/.test(lines[5]);
  add('line order matches the documented layout', layoutOk, lines.slice(0, 6).join(' | '));
  const blanksOk = raw[4] === '' && raw[raw.length - 1] !== '' && raw.filter((l) => l === '').length === 2 && raw.indexOf('', 5) > 5;
  add('blank lines after the bar and after the recommendation', blanksOk);
  const notes = lines.slice(7);
  add('1–3 Note lines and nothing else after the recommendation', notes.length >= 1 && notes.length <= 3 && notes.every((l) => l.startsWith('Note: ')), notes.join(' | '));
  add('uses the current labels (no "Risk:", "Estimated usage", or "Configured context limit")', !/^(Risk:|Estimated usage|Configured context limit|Estimated visible context)/m.test(text));

  // Bar
  const barM = BAR_RE.exec(lines[3] || '');
  add('progress bar line is well-formed (20 cells, "of planning limit")', barM, lines[3]);
  if (barM) {
    const shownText = barM[2];
    const shown = shownText === '<1%' ? 0.5 : Number(shownText.replace(/[~%]/g, ''));
    const filled = [...barM[1]].filter((c) => c === '█' || c === '#').length;
    add('bar fill matches the displayed percentage (±1 block)', Math.abs(filled - barFill(shown)) <= 1, `${filled} blocks for ${shownText}`);
    if (exp.usageDisplay) add(`share display is ${exp.usageDisplay}`, shownText === exp.usageDisplay, shownText);
    if (exp.usageOver100) add('full bar with percentage above 100% preserved', filled === 20 && shown > 100, lines[3]);
  }

  // Planning risk and recommendation
  const riskM = RISK_RE.exec(lines[4] || '');
  const riskText = riskM ? lines[4].replace(/^Planning risk: /, '') : null;
  add(`planning risk is ${exp.risk}`, riskText === exp.risk, `got ${riskText}`);
  const rec = lines[6] || '';
  if (exp.incomplete) {
    add('UNKNOWN planning risk with a stated reason', riskM && riskM[1] === 'UNKNOWN' && Boolean(riskM[2]));
    if (exp.incomplete === 'baseline') {
      add('unknown window alone gives the neutral recommendation, with no handoff advice', rec === NEUTRAL_RECOMMENDATION && !/\/handoff/i.test(text), rec);
    } else {
      add('recommendation names what is not counted', UNKNOWN_REC_RE.test(rec), rec);
    }
  } else {
    add('recommendation matches planning-risk policy', riskM && rec === RECOMMENDATIONS[riskM[1]], rec);
  }
  if (exp.recommendation) add('recommendation matches expected wording', rec === exp.recommendation, `expected "${exp.recommendation}"`);
  add('never uses "lower bound" wording', !/lower bound/i.test(text));

  // Planning limit and provenance
  const limitVal = (lines[2] || '').replace(/^Planning limit: /, '');
  add(`planning limit is ${exp.limit}`, limitVal === exp.limit, `got "${limitVal}"`);

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
  add('does not claim backend usage or the model window was measured', !/backend (usage|tokens?) (is|was|are) (measured|\d)|measured (backend|context)|actual (usage|context) (is|was) \d/i.test(text));
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
