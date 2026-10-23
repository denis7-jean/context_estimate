'use strict';
// What gets published: README examples must equal real output, and the tree
// must not contain machine-specific paths, credentials, or private material.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, ZIP_PATH, buildZip } = require('../src/bundle');
const { readZip } = require('../src/zip');
const { p, SOL, BASELINE, renderFor } = require('./helpers');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

// Same walk the publish step uses: everything under ROOT except what .gitignore excludes.
const IGNORED_DIRS = new Set(['node_modules', 'logs', 'outputs', '.git']);
function publishable(dir = ROOT, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) publishable(full, out);
    else out.push(full);
  }
  return out;
}

test('.gitignore excludes dependencies, logs, and local eval outputs', () => {
  const ig = read('.gitignore');
  for (const entry of ['node_modules/', 'dev/logs/', 'dev/evals/outputs/', '.env']) assert.ok(ig.split('\n').includes(entry), entry);
});

test('README example blocks equal the reference renderer output', () => {
  const blocks = [...read('README.md').matchAll(/```\n(Context Estimate\n[\s\S]*?)\n```/g)].map((m) => m[1]);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0], renderFor(130000, SOL));
  assert.equal(blocks[1], renderFor(130000, BASELINE));
  assert.equal(blocks[2], renderFor(130000, SOL, { compacted: true }));
  assert.match(blocks[0], /Planning risk: LOW/);
  assert.match(blocks[1], /~102% of planning limit/);
  assert.match(blocks[1], /Planning risk: UNKNOWN \(model window unknown\)/);
  assert.match(blocks[2], /Planning risk: UNKNOWN \(partial history\)/);
  for (const b of blocks) assert.doesNotMatch(b, /lower bound|Estimated usage|Configured context limit/i);
});

test('README documents precedence, model evidence, the official source, and the lack of a cross-model guarantee', () => {
  const r = read('README.md');
  const rows = ['`user override`', '`saved user budget`', '`documented GPT-6.1 Sol / Work default`', '`conservative baseline; model window unknown`'].map((l) => r.indexOf(l));
  assert.ok(rows.every((i) => i > 0) && rows.every((v, i) => i === 0 || v > rows[i - 1]), String(rows));
  assert.ok(r.includes(p.DOCUMENTED_SOURCE.url));
  assert.match(r, /wording checked on 2026-10-23/);
  assert.match(r, /GPT-6\.1 Sol: 500,000 tokens in ChatGPT Work and Codex/);
  assert.match(r, /`model=gpt-6\.1-sol` is \*\*your assertion\*\* of the Work model you selected, not automatic detection/);
  assert.match(r, /Model evidence is re-checked on every invocation/);
  assert.match(r, /never reuses an earlier derived limit/);
  assert.match(r, /never saved into `saved_limit`/);
  assert.match(r, /not the model's actual capacity/);
  assert.match(r, /no table of other models' windows\*\*, and no accuracy guarantee across models/);
  assert.match(r, /isn't a promise that all of it is available for conversation text/);
  assert.match(r, /@contextestimate model=gpt-6\.1-sol/);
  assert.match(r, /@contextestimate limit=200000/);
  assert.match(r, /upload the new ZIP again/);
  assert.match(r, /planning guidance, not measured backend context risk/);
});

test('README documents Work as supported and Chat as an observed account limit, without overclaiming', () => {
  const r = read('README.md');
  assert.match(r, /Supported and tested surface: ChatGPT Work/);
  assert.match(r, /ChatGPT Chat: unavailable on the maintainer's account/);
  assert.match(r, /observed availability limit on one account, not a statement about OpenAI's products in general/);
  assert.match(r, /does not read ChatGPT's hidden context meter/);
  assert.match(r, /never runs `\/handoff`/);
  assert.match(r, /the actual model window, backend token usage, and internal compaction, which it cannot see/);
  assert.match(r, /Plugins → Skills → Create → Upload from your computer/);
  assert.match(r, /not a documented ChatGPT slash command/);
  assert.doesNotMatch(r, /fully tested in ChatGPT/i);
});

test('development notes store the official source URL, verification date, and scope of the documented limit', () => {
  const d = read('docs/development-notes.md');
  assert.ok(d.includes(p.DOCUMENTED_SOURCE.url));
  assert.ok(d.includes(p.DOCUMENTED_SOURCE.verified));
  assert.ok(d.includes(p.DOCUMENTED_SOURCE.wording.replace(/\.$/, '')));
  assert.match(d, /Normal invocations never browse to look it up/);
  assert.match(d, /Not generalized: no other model's window is stated on that page, API specifications are not substituted for Work limits, and no hidden-overhead deduction or usable-input budget is invented/);
  assert.match(d, /No cross-model accuracy guarantee/);
  assert.match(d, /never written into `saved_limit`/);
  assert.match(d, /Not accepted: the assistant's self-identification, the local Claude CLI model/);
});

test('LICENSE is MIT, Denis Lan, 2026', () => {
  const l = read('LICENSE');
  assert.match(l, /^MIT License/);
  assert.match(l, /Copyright \(c\) 2026 Denis Lan/);
});

test('committed ZIP is byte-identical to a fresh build from source', () => {
  const committed = fs.readFileSync(ZIP_PATH);
  buildZip();
  assert.ok(committed.equals(fs.readFileSync(ZIP_PATH)), 'dist/contextestimate.zip is stale; run npm run package');
  assert.deepEqual(readZip(committed).map((e) => e.name), ['contextestimate/', 'contextestimate/SKILL.md']);
});

test('published files contain no machine-specific absolute paths', () => {
  const patterns = [/[A-Za-z]:\\(Users|Projects|Windows)/, /[A-Za-z]:\/(Users|Projects)/, /\/c\/Users/i, /\/home\/[a-z]/i, /\/Users\/[A-Za-z]/, /AppData/i, /claude\/C--/];
  const self = path.join(ROOT, 'dev', 'test', 'repo.test.js');
  for (const file of publishable()) {
    if (file === self || file.endsWith('.zip') || file.endsWith('package-lock.json')) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const re of patterns) assert.doesNotMatch(text, re, `${path.relative(ROOT, file)} matches ${re}`);
  }
  const zipText = readZip(fs.readFileSync(ZIP_PATH)).map((e) => e.data.toString('utf8')).join('\n');
  for (const re of patterns) assert.doesNotMatch(zipText, re);
});

test('published files contain no credentials or private identifiers', () => {
  const patterns = [
    /sk-[A-Za-z0-9]{20,}/,
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /xox[abprs]-[A-Za-z0-9-]{10,}/,
    /\b[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|icloud)\.com\b/i,
    /(password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  ];
  const self = path.join(ROOT, 'dev', 'test', 'repo.test.js');
  for (const file of publishable()) {
    if (file === self || file.endsWith('.zip') || file.endsWith('package-lock.json')) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const re of patterns) assert.doesNotMatch(text, re, `${path.relative(ROOT, file)} matches ${re}`);
  }
});

test('publishable tree has only the expected top-level entries and no large artifacts', () => {
  const top = fs.readdirSync(ROOT).filter((n) => n !== '.git' && n !== 'node_modules').sort();
  assert.deepEqual(top, ['.gitattributes', '.gitignore', 'LICENSE', 'README.md', 'dev', 'dist', 'docs', 'skill']);
  for (const file of publishable()) assert.ok(fs.statSync(file).size < 200 * 1024, `${path.relative(ROOT, file)} is large`);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'dist')), ['contextestimate.zip']);
});

test('README and notes document the greeting smoke test, the neutral baseline recommendation, and switch variability', () => {
  const r = read('README.md');
  const d = read('docs/development-notes.md');
  for (const doc of [r, d]) {
    assert.match(doc, /GPT-6 Luna Medium/);
    assert.match(doc, /GPT-6\.1 Sol Medium/);
    assert.match(doc, /Hello, world! 👋/);
    assert.ok(doc.includes(p.NEUTRAL_RECOMMENDATION));
    assert.match(doc, /estimation variability or differences in the accessible history/);
    assert.match(doc, /not measurements of backend context usage/);
  }
  assert.match(r, /An unknown window never triggers a handoff recommendation by itself/);
  assert.match(d, /sizing sanity|synthetic fixture/);
  assert.match(d, /Neither live number is ground truth/);
  assert.match(d, /do not show that a language model produces a deterministic exact count in a live invocation/i);
  const blocks = [...r.matchAll(/```\n(Context Estimate\n[\s\S]*?)\n```/g)].map((m) => m[1]);
  assert.ok(blocks[1].includes(p.NEUTRAL_RECOMMENDATION));
  assert.doesNotMatch(blocks[1], /\/handoff/);
});
