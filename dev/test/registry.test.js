'use strict';
// Work model registry, Work-versus-API source scoping, stale or unavailable
// sources, model assertions, and the rule that ordinary estimates need no web
// search. These tests check policy, arithmetic, and the instruction text. They
// do not perform or verify any live lookup, and they say nothing about which
// models any user's plan or workspace can actually select.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, SKILL_DIR } = require('../src/bundle');
const { p, limitFor, BASELINE, SOL, renderFor } = require('./helpers');

const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const notes = fs.readFileSync(path.join(ROOT, 'docs', 'development-notes.md'), 'utf8').replace(/\r\n/g, '\n');
const policySource = fs.readFileSync(path.join(ROOT, 'dev', 'src', 'policy.js'), 'utf8');

const LIVE_SOL = { modelId: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', window: 500000, scope: 'work-and-codex', url: p.HELP_WORK_URL };
const LIVE_LUNA = { modelId: 'gpt-6-luna', name: 'GPT-6 Luna', window: 400000, scope: 'chatgpt-work', url: p.LEARN_MODELS_URL };
const FRESH = '2026-12-01'; // 39 days after the check
const STALE = '2027-02-01'; // 101 days after the check

// ---- the registry table in SKILL.md and the reference registry agree ----

function skillRegistryRows() {
  const legend = Object.fromEntries([...skill.matchAll(/\b([HL]) = (https:\/\/\S+?)(?:;|\s|$)/g)].map((m) => [m[1], m[2]]));
  const section = skill.slice(skill.indexOf('## Work model registry'), skill.indexOf('## 1. Read the request'));
  const rows = section
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| Model ID'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  return { legend, rows };
}

test('the registry in SKILL.md matches the reference registry: window, source URL, and date for every entry', () => {
  const { legend, rows } = skillRegistryRows();
  assert.deepEqual(legend, { H: p.HELP_WORK_URL, L: p.LEARN_MODELS_URL });
  assert.equal(rows.length, 5);
  const names = p.MODEL_REGISTRY.map((m) => m.name);
  // Every reference entry appears in exactly one row, with the same window, source, and date.
  for (const entry of p.MODEL_REGISTRY) {
    const row = rows.find((r) => r[0].includes(entry.name));
    assert.ok(row, `${entry.name} missing from SKILL.md`);
    if (entry.id) assert.ok(row[0].includes(`\`${entry.id}\``), `${entry.name} id`);
    else assert.match(row[0], /ID not documented|IDs not documented/);
    assert.equal(row[1], entry.window ? String(entry.window) : 'not documented', entry.name);
    assert.equal(legend[row[2]], entry.source, `${entry.name} source`);
    assert.equal(row[3], entry.checked, `${entry.name} checked`);
  }
  // No extra model names in the table beyond the reference registry.
  const listed = rows.flatMap((r) => r[0].match(/GPT-[0-9.]+ (?:Sol|Luna|Terra|Astra)/g) || []);
  assert.deepEqual([...new Set(listed)].sort(), [...names].sort());
});

test('registry contents: GPT-6.1 Sol has the official 500,000 Work window; every other entry is not documented', () => {
  const documented = p.MODEL_REGISTRY.filter((m) => m.window);
  assert.deepEqual(documented.map((m) => [m.id, m.window]), [['gpt-6.1-sol', 500000]]);
  assert.deepEqual(p.MODEL_REGISTRY.filter((m) => !m.window).map((m) => m.name), ['GPT-6 Sol', 'GPT-6 Luna', 'GPT-6 Astra', 'GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna']);
  assert.equal(p.REGISTRY_CHECKED, '2026-10-23');
  assert.equal(p.REGISTRY_FRESHNESS_DAYS, 90);
  for (const m of p.MODEL_REGISTRY) {
    assert.ok([p.HELP_WORK_URL, p.LEARN_MODELS_URL].includes(m.source), m.name);
    assert.match(m.checked, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof m.name, 'string');
  }
  assert.deepEqual(p.DOCUMENTED_MODEL_DEFAULTS, { 'gpt-6.1-sol': { name: 'GPT-6.1 Sol', limit: 500000 } });
});

// ---- known and undocumented models ----

test('known model: GPT-6.1 Sol keeps its documented Work default and labels it as documented', () => {
  assert.deepEqual(SOL, { value: 500000, source: 'documented', via: 'registry', label: 'documented GPT-6.1 Sol / Work default', model: 'gpt-6.1-sol', modelSource: 'user' });
  assert.match(renderFor(130000, SOL), /^Planning limit: 500k \(documented GPT-6\.1 Sol \/ Work default\)$/m);
  assert.deepEqual(limitFor('/contextestimate', 'none', { id: 'GPT-6.1 Sol', surface: 'work' }).value, 500000);
});

test('registry models without a documented Work window stay unknown and use the fallback (no lookup needed, no inference)', () => {
  for (const id of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    assert.ok(p.findRegistryEntry(id), id);
    assert.equal(p.findRegistryEntry(id).window, null, id);
    assert.deepEqual(limitFor(`/contextestimate model=${id}`), BASELINE, id);
    assert.deepEqual(p.needsFreshnessLookup({ modelId: id, today: FRESH }), { needed: false, reasons: [] }, id);
  }
  const out = renderFor(1000, limitFor('/contextestimate model=gpt-6-astra'));
  assert.match(out, /^Planning risk: UNKNOWN \(model window unknown\)$/m);
  assert.match(out, /Planning limit: 128k \(conservative baseline; model window unknown\)/);
});

test('matching is by ID or normalized name only, never by model-family similarity', () => {
  assert.equal(p.findRegistryEntry('GPT-6 Astra').name, 'GPT-6 Astra');
  assert.equal(p.findRegistryEntry('gpt-5.6_terra').name, 'GPT-5.6 Terra');
  for (const id of ['gpt-6.1', 'gpt-6.1-sol-mini', 'gpt-6-sol-pro', 'sol', 'luna', 'gpt-6', 'gpt-5.5', 'gpt-5.4', 'gpt-6-pro', 'gpt-6.2-sol']) {
    assert.equal(p.findRegistryEntry(id), null, id);
    assert.deepEqual(limitFor(`/contextestimate model=${id}`), BASELINE, id);
  }
});

test('a model absent from the registry gets the baseline and triggers (only) a conditional lookup', () => {
  assert.deepEqual(limitFor('/contextestimate model=gpt-7-x'), BASELINE);
  assert.deepEqual(p.needsFreshnessLookup({ modelId: 'gpt-7-x', today: FRESH }), { needed: true, reasons: ['model absent from registry'] });
});

// ---- Work-versus-API scoping and what a live value must satisfy ----

test('a live window is accepted only with an official source that scopes it to ChatGPT Work or Work and Codex', () => {
  assert.deepEqual(p.acceptLiveResult(LIVE_SOL, 'gpt-6.1-sol'), { ok: true });
  assert.deepEqual(p.acceptLiveResult(LIVE_LUNA, 'gpt-6-luna'), { ok: true });
  assert.deepEqual(p.acceptLiveResult({ ...LIVE_LUNA, modelId: undefined, name: 'GPT-6 Luna' }, 'GPT-6 Luna'), { ok: true });
  assert.deepEqual(p.WORK_SCOPES, ['chatgpt-work', 'work-and-codex']);
});

test('API values, output limits, allowances, Codex-only, Chat-only, and unscoped values are rejected', () => {
  for (const scope of ['api', 'api-context-window', 'codex', 'codex-only', 'chat', 'output-limit', 'max-output-tokens', 'usage-allowance', 'credits', 'unspecified', 'ambiguous', '', undefined, 'work']) {
    const r = p.acceptLiveResult({ ...LIVE_LUNA, scope }, 'gpt-6-luna');
    assert.equal(r.ok, false, String(scope));
    assert.match(r.reason, /not scoped to ChatGPT Work or Work and Codex/);
    assert.deepEqual(limitFor('/contextestimate model=gpt-6-luna', 'none', undefined, { live: { ...LIVE_LUNA, scope } }), BASELINE, String(scope));
  }
  // An API documentation page is not an acceptable source even if mislabeled as Work.
  for (const url of ['https://developers.openai.com/api/docs/models', 'https://platform.openai.com/docs/models', 'https://example.com/work', 'http://not a url', undefined]) {
    assert.equal(p.acceptLiveResult({ ...LIVE_LUNA, url }, 'gpt-6-luna').ok, false, String(url));
  }
});

test('live values must be an exact positive integer for the model in question', () => {
  for (const window of [0, -1, 1.5, '400000', '400,000', null, undefined, NaN, Infinity]) {
    assert.equal(p.acceptLiveResult({ ...LIVE_LUNA, window }, 'gpt-6-luna').ok, false, String(window));
  }
  assert.equal(p.acceptLiveResult(LIVE_LUNA, 'gpt-6-sol').ok, false, 'a figure for another model');
  assert.equal(p.acceptLiveResult(LIVE_LUNA, 'gpt-6-luna-mini').ok, false, 'no family inference');
  assert.equal(p.acceptLiveResult(LIVE_LUNA, null).ok, false);
  assert.equal(p.acceptLiveResult(null, 'gpt-6-luna').ok, false);
  assert.equal(p.acceptLiveResult({ ...LIVE_LUNA, status: 'unavailable' }, 'gpt-6-luna').ok, false);
  assert.equal(p.acceptLiveResult({ ...LIVE_LUNA, status: 'inaccessible' }, 'gpt-6-luna').ok, false);
});

test('an accepted live value applies to that invocation only, is labeled as a live check, and edits nothing', () => {
  const snapshot = JSON.stringify(p.MODEL_REGISTRY);
  const lim = limitFor('/contextestimate model=gpt-6-luna', 'none', undefined, { live: LIVE_LUNA });
  assert.deepEqual(lim, { value: 400000, source: 'documented', via: 'live', label: 'documented GPT-6 Luna / Work default; live check', model: 'gpt-6-luna', modelSource: 'user' });
  const out = renderFor(130000, lim);
  assert.match(out, /^Planning limit: 400k \(documented GPT-6 Luna \/ Work default; live check\)$/m);
  assert.match(out, /^Planning risk: LOW$/m);
  // The next invocation without a lookup is back to the registry (unknown window), and the registry is untouched.
  assert.deepEqual(limitFor('/contextestimate model=gpt-6-luna'), BASELINE);
  assert.equal(JSON.stringify(p.MODEL_REGISTRY), snapshot);
  assert.equal(p.MODEL_REGISTRY.find((m) => m.id === 'gpt-6-luna').window, null);
});

test('a lookup never decides which model is current, and cannot override a budget', () => {
  // No model evidence in the invocation or runtime: a live result alone changes nothing.
  assert.deepEqual(limitFor('/contextestimate', 'none', undefined, { live: LIVE_LUNA }), BASELINE);
  assert.deepEqual(limitFor('/contextestimate', 'none', undefined, { live: LIVE_SOL }), BASELINE);
  // A result for a different model than the asserted one is ignored.
  assert.deepEqual(limitFor('/contextestimate model=gpt-6-sol', 'none', undefined, { live: LIVE_LUNA }), BASELINE);
  // Budgets still win.
  assert.equal(limitFor('/contextestimate limit=200000 model=gpt-6-luna', 'none', undefined, { live: LIVE_LUNA }).source, 'override');
  assert.equal(limitFor('/contextestimate model=gpt-6-luna', '64000', undefined, { live: LIVE_LUNA }).source, 'saved');
});

test('a fresh registry value is used as is; a live result is not consulted for it', () => {
  const lim = limitFor('/contextestimate model=gpt-6.1-sol', 'none', undefined, { live: { ...LIVE_SOL, window: 123456 }, today: FRESH });
  assert.equal(lim.value, 500000);
  assert.equal(lim.via, 'registry');
});

// ---- stale or unavailable sources ----

test('freshness arithmetic: stale only after more than 90 days; an unknown date is treated as fresh', () => {
  const entry = p.findRegistryEntry('gpt-6.1-sol');
  assert.equal(p.daysBetween('2026-10-23', '2027-01-21'), 90);
  assert.equal(p.isStale(entry, '2027-01-21'), false);
  assert.equal(p.isStale(entry, '2027-01-22'), true);
  assert.equal(p.isStale(entry, '2026-10-23'), false);
  for (const today of [undefined, null, '', 'not a date']) assert.equal(p.isStale(entry, today), false, String(today));
  assert.deepEqual(p.needsFreshnessLookup({ modelId: 'gpt-6.1-sol', today: '2027-01-21' }), { needed: false, reasons: [] });
  assert.deepEqual(p.needsFreshnessLookup({ modelId: 'gpt-6.1-sol', today: '2027-01-22' }), { needed: true, reasons: ['registry entry older than 90 days'] });
});

test('stale registry window with no confirming lookup is treated as unknown, with a note', () => {
  for (const live of [undefined, null, { ...LIVE_SOL, status: 'unavailable' }, { ...LIVE_SOL, scope: 'api' }, { ...LIVE_SOL, url: 'https://developers.openai.com/api/docs/models' }, { ...LIVE_SOL, window: undefined }]) {
    const lim = limitFor('/contextestimate model=gpt-6.1-sol', 'none', undefined, { live, today: STALE });
    assert.equal(lim.source, 'baseline', JSON.stringify(live));
    assert.equal(lim.value, 128000);
    assert.equal(lim.staleModel, 'GPT-6.1 Sol');
    const out = renderFor(1000, lim);
    assert.match(out, /^Planning risk: UNKNOWN \(model window unknown\)$/m);
    assert.match(out, /^Note: The registry entry for GPT-6\.1 Sol is older than 90 days and was not rechecked, so its window is treated as unknown\.$/m);
    assert.doesNotMatch(out, /\/handoff|500k|documented/);
  }
});

test('stale registry window with a confirming Work-scoped lookup uses the live value for that invocation only', () => {
  const lim = limitFor('/contextestimate model=gpt-6.1-sol', 'none', undefined, { live: LIVE_SOL, today: STALE });
  assert.equal(lim.value, 500000);
  assert.equal(lim.via, 'live');
  assert.equal(lim.label, 'documented GPT-6.1 Sol / Work default; live check');
  assert.equal(lim.staleModel, undefined);
  // A live value that differs is used as given (Work-scoped and official), without editing the registry.
  const changed = limitFor('/contextestimate model=gpt-6.1-sol', 'none', undefined, { live: { ...LIVE_SOL, window: 750000 }, today: STALE });
  assert.equal(changed.value, 750000);
  assert.equal(p.findRegistryEntry('gpt-6.1-sol').window, 500000);
});

test('the staleness note is never printed for fresh rows, undocumented rows, or budgets', () => {
  for (const out of [renderFor(1000, SOL), renderFor(1000, BASELINE), renderFor(1000, limitFor('/contextestimate limit=100000', 'none', undefined, { today: STALE }))]) {
    assert.doesNotMatch(out, /older than 90 days/);
  }
  assert.equal(limitFor('/contextestimate model=gpt-6-luna', 'none', undefined, { today: STALE }).staleModel, undefined);
});

// ---- model assertions ----

test('model identity evidence is unchanged: user assertion or trusted Work runtime metadata only', () => {
  assert.deepEqual(p.resolveModel({ invocation: p.parseInvocation('/contextestimate model=gpt-6.1-sol') }), { id: 'gpt-6.1-sol', source: 'user' });
  assert.deepEqual(p.resolveModel({ runtime: { id: 'gpt-6.1-sol', surface: 'work' } }), { id: 'gpt-6.1-sol', source: 'runtime' });
  assert.equal(p.resolveModel({ runtime: { id: 'gpt-6.1-sol', surface: 'api' } }), null);
  assert.equal(p.resolveModel({ invocation: p.parseInvocation('/contextestimate'), selfReported: 'gpt-6.1-sol' }), null);
  assert.equal(p.resolveModel({ invocation: p.parseInvocation('/contextestimate'), live: LIVE_SOL }), null);
  // The registry listing does not establish the model either.
  assert.deepEqual(limitFor('/contextestimate'), BASELINE);
});

// ---- ordinary estimates need no web search ----

test('ordinary estimates never require a lookup, and the reference code has no network access', () => {
  for (const args of [{}, { modelId: 'gpt-6.1-sol', today: FRESH }, { modelId: 'gpt-6-luna', today: FRESH }, { modelId: null, today: STALE }]) {
    assert.deepEqual(p.needsFreshnessLookup(args), { needed: false, reasons: [] }, JSON.stringify(args));
  }
  assert.deepEqual(p.needsFreshnessLookup({ explicitRequest: true }), { needed: true, reasons: ['explicit request'] });
  assert.deepEqual(p.needsFreshnessLookup({ explicitRequest: true, modelId: 'gpt-7-x', today: STALE }).reasons, ['explicit request', 'model absent from registry']);
  // resolveLimit and render run with no lookup input at all.
  assert.equal(limitFor('/contextestimate model=gpt-6.1-sol').value, 500000);
  assert.doesNotMatch(policySource, /require\(['"](?:node:)?(?:https?|net|dns|tls|http2)['"]\)|\bfetch\s*\(|XMLHttpRequest|child_process/);
});

test('SKILL.md allows browsing only under the conditional lookup rules', () => {
  assert.match(skill, /Do not browse for an ordinary estimate/);
  assert.match(skill, /If web search or browsing is available, check official OpenAI sources \(for example help\.openai\.com and learn\.chatgpt\.com\) only when \(a\) the user explicitly asks for current model or window information, \(b\) the model identified by current evidence is not in the registry, or \(c\) that model's registry row was last checked more than 90 days before today's date \(if you do not reliably know today's date, treat the row as fresh\)/);
  assert.match(skill, /A lookup never decides which model is current/);
  assert.match(skill, /Use its result for that invocation only: never say the skill or its registry was updated, never save it into `saved_limit`, and never imply the model is available to the user's plan or workspace/);
  assert.match(skill, /Accept a looked-up window only if the official source explicitly scopes that exact number to ChatGPT Work or to Work and Codex for the model in question/);
  assert.match(skill, /Do not accept API context windows, maximum output limits, usage allowances or credit rates, Codex-only or Chat-only values, a figure for another model, or a value inferred from a model family/);
  assert.match(skill, /If the source is inaccessible, ambiguous, stale, or API-only, or no search is available, keep the window unknown \(baseline\)/);
  assert.match(skill, /A registry window older than 90 days that you could not recheck is treated as unknown \(baseline\), with the extra line `Note: The registry entry for <Model name> is older than 90 days and was not rechecked, so its window is treated as unknown\.`/);
  assert.ok(skill.includes(p.staleNote('<Model name>').replace(/^Note: /, '')));
  assert.match(skill, /a lookup result is labeled `\(documented <Model name> \/ Work default; live check\)`/);
  assert.match(skill, /A listing does not mean a model is available to this user's plan, workspace, role, or rollout/);
  assert.match(skill, /Do not infer a window from API documentation, output limits, usage allowances, credit rates, or a model in the same family, and do not add rows from memory/);
  // Evidence rules for the model itself are unchanged.
  assert.match(skill, /Accept only \(a\) runtime metadata the platform itself supplies for this invocation that identifies both the current model and the Work surface, or \(b\) a `model=` value in this invocation's first line/);
  assert.match(skill, /It is a user assertion, not detection/);
});

test('README and development notes document the registry, sources, lookup rules, and limitations', () => {
  for (const [name, doc] of [['README', readme], ['notes', notes]]) {
    for (const m of p.MODEL_REGISTRY) assert.ok(doc.includes(m.name), `${name}: ${m.name}`);
    assert.ok(doc.includes(p.HELP_WORK_URL), `${name} help url`);
    assert.ok(doc.includes(p.LEARN_MODELS_URL), `${name} learn url`);
    assert.ok(doc.includes('2026-10-23'), `${name} date`);
    assert.match(doc, /90 days/, name);
    assert.match(doc, /not documented/, name);
    assert.match(doc, /does not (?:mean|claim)[^.]*available to (?:any|every|a|the)[^.]*(?:plan|workspace|user)|not (?:the )?exact list available to every user|availability varies/i, name);
    assert.match(doc, /live check/, name);
    assert.match(doc, /(?:this invocation|that invocation|that run)[^.]*only|only for that invocation/i, name);
  }
  assert.match(notes, /Not verified in ChatGPT Work/);
});
