'use strict';
// What gets published: README examples must equal real output, and the tree
// must not contain machine-specific paths, credentials, or private material.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, ZIP_PATH, buildZip } = require('../src/bundle');
const { readZip } = require('../src/zip');
const p = require('../src/policy');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const ASSUMED = { value: 128000, label: 'assumed' };

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
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0], p.render({ kind: 'estimate', tokens: 50000, limit: ASSUMED }));
  assert.equal(blocks[1], p.render({ kind: 'estimate', tokens: 50000, limit: ASSUMED, compacted: true }));
  assert.match(blocks[0], /Risk: LOW/);
  assert.doesNotMatch(blocks[1], /lower bound/i);
});

test('README documents Work as supported and Chat as an observed account limit, without overclaiming', () => {
  const r = read('README.md');
  assert.match(r, /Supported and tested surface: ChatGPT Work/);
  assert.match(r, /ChatGPT Chat: unavailable on the maintainer's account/);
  assert.match(r, /observed availability limit on one account, not a statement about OpenAI's products in general/);
  assert.match(r, /does not read ChatGPT's hidden context meter/);
  assert.match(r, /never runs `\/handoff`/);
  assert.match(r, /planning assumption, not a verified limit/);
  assert.match(r, /Plugins → Skills → Create → Upload from your computer/);
  assert.match(r, /not a documented ChatGPT slash command/);
  assert.doesNotMatch(r, /fully tested in ChatGPT/i);
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
