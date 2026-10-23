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

const RISK_RE = /^Risk: (LOW|MEDIUM|HIGH|CRITICAL|UNKNOWN)( \((partial history|unmeasured attachments|partial history; unmeasured attachments)\))?$/;
const BAR_RE = /^\[([█░]{20}|[#.]{20})\] (<1%|~\d+%) of planning limit( \((partial|text only|supplied text)\))?$/;
const INCOMPLETE_REC_RE = /^(Consider \/handoff before substantial work|Run \/handoff before starting another major task|Run \/handoff now before continuing substantial work); (earlier history is not counted|attachments or images are not counted|earlier history and attachments or images are not counted)\.$/;

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

  // Layout: header, context, limit, usage, bar, risk, "Recommendation:", text, notes.
  add('no code fences', !/```/.test(text));
  const layoutOk =
    lines.length >= 9 &&
    lines.length <= 11 &&
    /^Context Estimate$/.test(lines[0]) &&
    /^Estimated visible context: .+$/.test(lines[1]) &&
    /^Configured context limit: .+$/.test(lines[2]) &&
    /^Estimated usage: .+$/.test(lines[3]) &&
    /^\[/.test(lines[4]) &&
    /^Risk: /.test(lines[5]) &&
    /^Recommendation:$/.test(lines[6]);
  add('line order matches the documented layout', layoutOk, lines.slice(0, 7).join(' | '));
  const blanksOk = raw[5] === '' && raw[raw.length - 1] !== '' && raw.indexOf('', 6) > 6 && raw.filter((l) => l === '').length === 2;
  add('blank lines after the bar and after the recommendation', blanksOk);
  const notes = lines.slice(8);
  add('1–2 Note lines and nothing else after the recommendation', notes.length >= 1 && notes.length <= 2 && notes.every((l) => l.startsWith('Note: ')), notes.join(' | '));

  // Bar
  const barM = BAR_RE.exec(lines[4] || '');
  add('progress bar line is well-formed (20 cells)', barM, lines[4]);
  const usageM = /^Estimated usage: (<1%|~\d+%)/.exec(lines[3] || '');
  add('bar percentage equals the numeric usage line', barM && usageM && barM[2] === usageM[1], `${lines[3]} vs ${lines[4]}`);
  if (barM && usageM) {
    const shown = usageM[1] === '<1%' ? 0.5 : Number(usageM[1].replace(/[~%]/g, ''));
    const filled = [...barM[1]].filter((c) => c === '█' || c === '#').length;
    add('bar fill matches the displayed percentage (±1 block)', Math.abs(filled - barFill(shown)) <= 1, `${filled} blocks for ${usageM[1]}`);
    if (exp.usageOver100) add('full bar with percentage above 100% preserved', filled === 20 && shown > 100, lines[3]);
  }

  // Risk and recommendation
  const riskM = RISK_RE.exec(lines[5] || '');
  const riskText = riskM ? lines[5].replace(/^Risk: /, '') : null;
  add(`risk is ${exp.risk}`, riskText === exp.risk, `got ${riskText}`);
  const rec = lines[7] || '';
  if (exp.incomplete) {
    add('partial coverage uses an UNKNOWN risk with a reason', riskM && riskM[1] === 'UNKNOWN' && Boolean(riskM[2]));
    add('recommendation names what is not counted', INCOMPLETE_REC_RE.test(rec), rec);
    if (exp.recommendation) add('recommendation matches expected wording', rec === exp.recommendation, `expected "${exp.recommendation}"`);
  } else {
    add('recommendation matches risk policy', riskM && rec === RECOMMENDATIONS[riskM[1]], rec);
  }
  add('never uses "lower bound" wording', !/lower bound/i.test(text));

  // Limit
  const limitVal = (lines[2] || '').replace(/^Configured context limit: /, '');
  add(`limit is ${exp.limit}`, limitVal === exp.limit, `got "${limitVal}"`);

  // Tokens
  const tokVal = (lines[1] || '').replace(/^[^:]+: /, '');
  const tok = parseTokens(tokVal);
  if (exp.incomplete) {
    const wantSuffix = exp.incomplete === 'unmeasured' ? '(text only)' : '(partial)';
    add(`context line ends with ${wantSuffix}`, tokVal.endsWith(wantSuffix), tokVal);
  }
  if (exp.tokensDisplay) add(`tokens display is ${exp.tokensDisplay}`, tokVal.startsWith(exp.tokensDisplay), `got "${tokVal}"`);
  else if (tok && tok.hi === 999) {
    add('"<1k" is consistent with o200k truth', scenario.truthTokens < 1500, `truth ${scenario.truthTokens}`);
  } else if (tok) {
    const ratio = tok.mid / scenario.truthTokens;
    add('token estimate within ±50% of o200k truth', ratio >= 0.5 && ratio <= 1.5, `est ${tok.mid} vs truth ${scenario.truthTokens} (${((ratio - 1) * 100).toFixed(0)}%)`);
  } else add('token estimate parseable', false, tokVal);
  if (exp.usageDisplay) add(`usage display is ${exp.usageDisplay}`, (lines[3] || '').includes(exp.usageDisplay));

  // Honesty and safety
  add('no host-measurement claim', !/host-reported|Measured context/i.test(text));
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

module.exports = { grade, gradeDir, parseTokens };
