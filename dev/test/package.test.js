'use strict';
// Skill metadata, bundle structure, referenced files, and clean extraction.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const YAML = require('yaml');
const { encode } = require('gpt-tokenizer/encoding/o200k_base');
const { validateSkill, buildZip, SKILL_DIR, ZIP_PATH, listFiles } = require('../src/bundle');
const { readZip } = require('../src/zip');

const skillText = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');

test('skill folder passes validation with no errors', () => {
  const { errors } = validateSkill();
  assert.deepEqual(errors, []);
});

test('frontmatter parses as YAML with name=contextestimate and a spec-valid description', () => {
  const fmText = skillText.split(/^---\r?$/m)[1];
  const fm = YAML.parse(fmText);
  assert.deepEqual(Object.keys(fm).sort(), ['description', 'name']);
  assert.equal(fm.name, 'contextestimate');
  assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(fm.description.length > 0 && fm.description.length <= 1024);
  assert.match(fm.description, /\/contextestimate/);
  assert.match(fm.description, /limit=/);
  assert.match(fm.description, /\/handoff/);
  assert.match(fm.description, /never runs \/handoff/i);
});

test('validator rejects a bad name, a stray file, and a broken reference', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-bad-')), 'contextestimate');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: Context--Estimate\ndescription: x\n---\nSee [ref](references/missing.md).\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'dev only');
  const { errors } = validateSkill(dir);
  assert.ok(errors.some((e) => e.startsWith('Invalid name')));
  assert.ok(errors.some((e) => e.includes('must match folder')));
  assert.ok(errors.some((e) => e.includes('Unexpected file in bundle: notes.txt')));
  assert.ok(errors.some((e) => e.includes('Broken relative reference: references/missing.md')));
});

test('runtime skill stays small (spec guidance: <500 lines, <5000 tokens)', () => {
  assert.ok(skillText.split('\n').length < 500);
  const tokens = encode(skillText).length;
  assert.ok(tokens < 5000, `SKILL.md is ${tokens} tokens`);
});

test('bundle contains only runtime files (no tests, fixtures, logs, or report)', () => {
  assert.deepEqual(listFiles(SKILL_DIR), ['SKILL.md']);
});

test('zip has one top-level folder, forward-slash names, valid CRCs, and matches source', () => {
  buildZip();
  const entries = readZip(fs.readFileSync(ZIP_PATH));
  const names = entries.map((e) => e.name);
  assert.deepEqual(names, ['contextestimate/', 'contextestimate/SKILL.md']);
  for (const n of names) {
    assert.ok(!n.includes('\\'), `backslash in ${n}`);
    assert.ok(n.startsWith('contextestimate/'));
    assert.ok(!n.includes('..'));
  }
  const skill = entries.find((e) => e.name === 'contextestimate/SKILL.md');
  assert.equal(skill.data.toString('utf8'), skillText.replace(/\r\n/g, '\n'));
});

test('zip is reproducible (byte-identical across builds)', () => {
  buildZip();
  const a = fs.readFileSync(ZIP_PATH);
  buildZip();
  const b = fs.readFileSync(ZIP_PATH);
  assert.ok(a.equals(b));
});

// On Windows, `tar` on PATH may be Git's GNU tar, which cannot read zips.
const TAR =
  process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';

function checkExtracted(out) {
  assert.deepEqual(fs.readdirSync(out), ['contextestimate']);
  assert.deepEqual(fs.readdirSync(path.join(out, 'contextestimate')), ['SKILL.md']);
  const extracted = fs.readFileSync(path.join(out, 'contextestimate', 'SKILL.md'), 'utf8');
  assert.equal(extracted, skillText.replace(/\r\n/g, '\n'));
  const { errors } = validateSkill(path.join(out, 'contextestimate'));
  assert.deepEqual(errors, []);
}

test('zip extracts cleanly with PowerShell Expand-Archive', { skip: process.platform !== 'win32' }, () => {
  buildZip();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-expand-'));
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${ZIP_PATH}' -DestinationPath '${out}'`,
  ]);
  checkExtracted(out);
});

test('zip extracts cleanly with an independent extractor (bsdtar)', () => {
  buildZip();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-extract-'));
  execFileSync(TAR, ['-xf', ZIP_PATH, '-C', out]);
  checkExtracted(out);
});

test('frontmatter parsing and validation work on CRLF checkouts (Windows autocrlf)', () => {
  const { parseFrontmatter } = require('../src/bundle');
  const crlf = skillText.replace(/\r?\n/g, '\r\n');
  const { fm } = parseFrontmatter(crlf);
  assert.equal(fm.name, 'contextestimate');
  assert.equal(fm.description.includes('\r'), false);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-crlf-')), 'contextestimate');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), crlf);
  assert.deepEqual(validateSkill(dir).errors, []);
});
