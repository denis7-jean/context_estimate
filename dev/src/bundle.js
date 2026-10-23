'use strict';
// Validates the skill folder against the Agent Skills spec constraints and
// packages it as dist/contextestimate.zip (one top-level folder).

const fs = require('node:fs');
const path = require('node:path');
const { createZip } = require('./zip');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILL_DIR = path.join(ROOT, 'skill', 'contextestimate');
const DIST_DIR = path.join(ROOT, 'dist');
const ZIP_PATH = path.join(DIST_DIR, 'contextestimate.zip');

// Only these may ship. Anything else in the skill folder fails validation.
const ALLOWED_FILES = ['SKILL.md'];

function listFiles(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

// Parses the YAML frontmatter used by this skill: top-level `key: value`
// scalars only. Anything more complex is reported as an error rather than
// guessed at.
function parseFrontmatter(rawText) {
  const text = rawText.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) throw new Error('SKILL.md must start with --- frontmatter');
  const end = text.indexOf('\n---', 4);
  if (end < 0) throw new Error('Unterminated frontmatter');
  const fm = {};
  for (const line of text.slice(text.indexOf('\n') + 1, end).split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const m = /^([a-z][a-z0-9-]*):\s?(.*)$/.exec(line);
    if (!m) throw new Error(`Unsupported frontmatter line: ${line}`);
    let v = m[2].trim();
    if (/^["'].*["']$/.test(v)) v = v.slice(1, -1);
    if (/^[|>]/.test(v) || v === '') throw new Error(`Unsupported or empty value for ${m[1]}`);
    if (/^[\[{&*!%@`]/.test(v) || /:\s/.test(v) || /\s#/.test(v)) throw new Error(`Value for ${m[1]} needs quoting in YAML`);
    fm[m[1]] = v;
  }
  return { fm, body: text.slice(text.indexOf('\n', end + 1) + 1) };
}

function validateSkill(dir = SKILL_DIR) {
  const errors = [];
  const files = listFiles(dir);
  const skillMds = files.filter((f) => f.toLowerCase() === 'skill.md' || f.toLowerCase().endsWith('/skill.md'));
  if (skillMds.length !== 1 || skillMds[0] !== 'SKILL.md') errors.push(`Expected exactly one root SKILL.md, found: ${skillMds.join(', ')}`);
  for (const f of files) if (!ALLOWED_FILES.includes(f)) errors.push(`Unexpected file in bundle: ${f}`);

  const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  let fm = {};
  let body = '';
  try {
    ({ fm, body } = parseFrontmatter(text));
  } catch (e) {
    errors.push(e.message);
  }
  const allowedKeys = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
  for (const k of Object.keys(fm)) if (!allowedKeys.includes(k)) errors.push(`Unknown frontmatter key: ${k}`);
  const name = fm.name || '';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) errors.push(`Invalid name: ${name}`);
  if (name !== path.basename(dir)) errors.push(`name "${name}" must match folder "${path.basename(dir)}"`);
  const desc = fm.description || '';
  if (desc.length < 1 || desc.length > 1024) errors.push(`description length ${desc.length} not in 1..1024`);

  // Relative links in the body must resolve inside the bundle.
  for (const m of body.matchAll(/\]\(([^)#\s]+)\)/g)) {
    const target = m[1];
    if (/^[a-z]+:/i.test(target)) continue;
    if (!files.includes(target)) errors.push(`Broken relative reference: ${target}`);
  }
  if (text.split('\n').length > 500) errors.push('SKILL.md exceeds 500 lines');
  return { errors, files, fm, body, text };
}

function buildZip() {
  const { errors, files } = validateSkill();
  if (errors.length) throw new Error(`Skill validation failed:\n- ${errors.join('\n- ')}`);
  const entries = [{ name: 'contextestimate/' }];
  for (const f of files) {
    const data = fs.readFileSync(path.join(SKILL_DIR, f));
    entries.push({ name: `contextestimate/${f}`, data: Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'), 'utf8') });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(ZIP_PATH, createZip(entries));
  return { zipPath: ZIP_PATH, files };
}

if (require.main === module) {
  const { zipPath, files } = buildZip();
  console.log(`Wrote ${zipPath} (${fs.statSync(zipPath).size} bytes): ${files.join(', ')}`);
}

module.exports = { ROOT, SKILL_DIR, DIST_DIR, ZIP_PATH, parseFrontmatter, validateSkill, buildZip, listFiles };
