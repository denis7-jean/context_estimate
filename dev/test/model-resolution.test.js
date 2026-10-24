'use strict';
// Model-resolution regression tests for the live ChatGPT Work findings: with
// models other than GPT-6.1 Sol, including `/contextestimate model= GPT-6 Sol`,
// the report was the 128k baseline with UNKNOWN, and a recognized model with
// no documented Work window could not be told apart from an unrecognized one.
//
// These tests check the parser, the registry matching, the report wording,
// and the lookup rules in the reference implementation and the instruction
// text. They do not show that a language model follows the instructions, they
// perform no live lookup, and nothing here reads ChatGPT's backend usage or
// obtains an unpublished context window.

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../src/heuristic');
const g = require('../fixtures/greeting');
const { p, limitFor, BASELINE, SOL, renderFor } = require('./helpers');

const resolve = (message, runtime) => p.resolveLimit(p.parseInvocation(message), 'none', runtime);
const parsed = (value) => p.parseInvocation(`/contextestimate model=${value}`).model;
const stateOf = (value) => (parsed(value).resolution || { state: 'none' }).state;
const entryOf = (value) => {
  const r = parsed(value).resolution;
  return r && r.state === 'recognized' ? r.entry.name : null;
};
const report = (message, extra = {}, runtime) => renderFor(500, resolve(message, runtime), extra);
const lineStarting = (out, prefix) => out.split('\n').find((l) => l.startsWith(prefix));

// ---- the observed input ----

test('observed: "/contextestimate model= GPT-6 Sol" is parsed, recognized, reported as Work window undocumented, and gets ordinary default-budget guidance', () => {
  const inv = p.parseInvocation('/contextestimate model= GPT-6 Sol');
  assert.equal(inv.model.status, 'asserted');
  assert.equal(inv.model.raw, 'GPT-6 Sol');
  assert.equal(inv.model.id, 'gpt-6-sol');
  assert.equal(inv.model.resolution.state, 'recognized');
  assert.equal(inv.model.resolution.entry.name, 'GPT-6 Sol');

  const out = report('/contextestimate model= GPT-6 Sol');
  assert.match(out, /^Planning budget: 128k \(default heuristic\)$/m);
  assert.match(out, /^Model: GPT-6 Sol \(user-supplied\) — Work window undocumented$/m);
  assert.match(out, /^Handoff priority: LOW$/m);
  assert.ok(out.includes('Recommendation:\nContinue normally.'));
  assert.match(out, /^Note: Guidance uses a heuristic planning budget; actual model capacity and backend usage are unknown\.$/m);
  // No request to configure anything, and the undocumented window does not block guidance.
  assert.doesNotMatch(out, /model=MODEL_ID|limit=N|model-relative|unavailable|UNKNOWN|documented GPT/);
});

test('model= accepts whitespace around "=", multiword display names, and the rest of the line', () => {
  for (const msg of ['/contextestimate model= GPT-6 Sol', '/contextestimate model =GPT-6 Sol', '/contextestimate model = GPT-6 Sol', '/contextestimate model=   GPT-6 Sol   ', '@contextestimate model= GPT-6 Sol']) {
    const m = p.parseInvocation(msg).model;
    assert.equal(m.raw, 'GPT-6 Sol', msg);
    assert.equal(m.resolution.state, 'recognized', msg);
  }
  assert.equal(parsed('GPT-5.6 Terra').raw, 'GPT-5.6 Terra');
  assert.equal(parsed('GPT-5.6 Terra').resolution.entry.name, 'GPT-5.6 Terra');
});

test('model= stops at the next option on the line, so other options still work', () => {
  const a = p.parseInvocation('/contextestimate model= GPT-6 Sol limit=200000');
  assert.equal(a.model.raw, 'GPT-6 Sol');
  assert.equal(a.override.value, 200000);
  const b = p.parseInvocation('@contextestimate limit=200000 model=GPT-5.6 Terra bar=ascii');
  assert.equal(b.model.raw, 'GPT-5.6 Terra');
  assert.equal(b.override.value, 200000);
  assert.equal(b.barStyle, 'ascii');
  const c = p.parseInvocation('/contextestimate model=GPT-6 Sol model=gpt-6-sol');
  assert.equal(c.model.status, 'asserted');
  assert.equal(p.parseInvocation('/contextestimate model=GPT-6 Sol model=GPT-6 Luna').model.status, 'conflicting');
  assert.equal(p.parseInvocation('/contextestimate model=').model.status, 'none');
  assert.equal(p.parseInvocation('/contextestimate model=   ').model.status, 'none');
  // The value never spills onto a later line.
  assert.equal(p.parseInvocation('/contextestimate model= GPT-6 Sol\nand some more text').model.raw, 'GPT-6 Sol');
  assert.equal(p.parseInvocation('/contextestimate\nmodel=GPT-6 Sol').model.status, 'none');
});

test('surrounding quotes and backticks are removed; internal text is kept', () => {
  for (const q of ['"GPT-6 Luna"', "'GPT-6 Luna'", '`GPT-6 Luna`', '“GPT-6 Luna”', '‘GPT-6 Luna’', ' "GPT-6 Luna" ']) {
    const m = parsed(q);
    assert.equal(m.raw, 'GPT-6 Luna', q);
    assert.equal(m.resolution.state, 'recognized', q);
  }
  // An unmatched quote is not removed from the value, but stray punctuation at the ends does not defeat an exact match.
  assert.equal(parsed('"GPT-6 Luna').raw, '"GPT-6 Luna');
  assert.equal(stateOf('"GPT-6 Luna'), 'recognized');
  assert.equal(stateOf('"GPT-6 Luna extra"'), 'unrecognized');
});

test('valid model IDs and every display spelling resolve to the right registry entry', () => {
  const cases = {
    'GPT-6.1 Sol': ['gpt-6.1-sol', 'GPT-6.1_Sol', 'gpt 6.1 sol', '6.1 Sol', '6.1-sol', 'GPT-6.1 Sol Medium', 'gpt-6.1-sol-ultra', 'GPT‑6.1 Sol'],
    'GPT-6 Sol': ['gpt-6-sol', 'GPT-6 Sol', 'GPT 6 Sol', '6 Sol', 'GPT-6 Sol Light', 'GPT-6 Sol Extra High', 'GPT‑6 Sol'],
    'GPT-6 Luna': ['gpt-6-luna', 'GPT-6 Luna', '6 Luna', 'GPT-6 Luna High', 'GPT-6 Luna Max'],
    'GPT-6 Astra': ['GPT-6 Astra', 'gpt-6-astra', 'Astra', 'astra', 'Astra Light', '6 Astra'],
    'GPT-5.6 Terra': ['GPT-5.6 Terra', 'gpt-5.6-terra', '5.6 Terra', 'GPT-5.6_Terra'],
    'GPT-5.6 Sol': ['GPT-5.6 Sol', 'gpt-5.6-sol', '5.6 Sol'],
    'GPT-5.6 Luna': ['GPT-5.6 Luna', 'gpt-5.6-luna', '5.6 Luna'],
  };
  for (const [name, spellings] of Object.entries(cases)) {
    for (const spelling of spellings) assert.equal(entryOf(spelling), name, `"${spelling}" should be ${name}`);
  }
  // IDs are preserved as valid input and canonicalized.
  assert.equal(parsed('gpt-6.1-sol').id, 'gpt-6.1-sol');
  assert.equal(parsed('GPT-6 Astra').id, 'gpt-6-astra');
});

test('no ID or window is invented: aliases map only to existing rows, and only GPT-6.1 Sol has a window', () => {
  for (const entry of p.MODEL_REGISTRY) assert.equal(Boolean(entry.window), entry.name === 'GPT-6.1 Sol', entry.name);
  assert.deepEqual(p.MODEL_REGISTRY.map((m) => m.id), ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', null, null, null, null]);
  for (const v of ['GPT-6 Sol', 'GPT-6 Luna', 'GPT-6 Astra', 'GPT-5.6 Terra']) assert.deepEqual(resolve(`/contextestimate model=${v}`), BASELINE, v);
  assert.equal(resolve('/contextestimate model=GPT-6.1 Sol Medium').value, 500000);
});

test('ambiguous names list the registry names they could mean and are never guessed', () => {
  const cases = {
    Sol: ['GPT-6.1 Sol', 'GPT-6 Sol', 'GPT-5.6 Sol'],
    luna: ['GPT-6 Luna', 'GPT-5.6 Luna'],
    'GPT-6': ['GPT-6 Sol', 'GPT-6 Luna', 'GPT-6 Astra'],
    'GPT-5.6': ['GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna'],
    Terra: ['GPT-5.6 Terra'], // incomplete: only part of a name, so it is not an alias
  };
  for (const [value, names] of Object.entries(cases)) {
    const r = parsed(value).resolution;
    assert.equal(r.state, 'ambiguous', value);
    assert.deepEqual(r.candidates, names, value);
    assert.deepEqual(resolve(`/contextestimate model=${value}`), BASELINE, value);
  }
});

test('unknown names are unrecognized: real models outside the Work registry, extra words, and junk', () => {
  for (const value of ['GPT-7 Foo', 'gpt-6-pro', 'GPT-6 Pro', 'gpt-6.1-sol-mini', 'GPT-6.2 Sol', 'GPT-6 Sol Turbo', 'GPT-6 Sol Mediumish', 'gpt-5.5', 'gpt-4o', 'o3', '!!', 'MODEL_ID', 'claude-sonnet-5-5']) {
    assert.equal(stateOf(value), 'unrecognized', value);
    assert.deepEqual(resolve(`/contextestimate model=${value}`), BASELINE, value);
  }
});

// ---- distinct output for every resolution state ----

test('every resolution state has a distinct Model line, and none of them blocks or changes the guidance', () => {
  const runtimeSol = { id: 'GPT-6.1 Sol', surface: 'work' };
  const runtimeLuna = { id: 'gpt-6-luna', surface: 'work' };
  const states = {
    'none': report('/contextestimate'),
    'runtime documented': report('/contextestimate', {}, runtimeSol),
    'runtime undocumented': report('/contextestimate', {}, runtimeLuna),
    'user documented': report('/contextestimate model=GPT-6.1 Sol'),
    'user undocumented': report('/contextestimate model=GPT-6 Luna'),
    'user unrecognized': report('/contextestimate model=GPT-7 Foo'),
    'user ambiguous': report('/contextestimate model=Sol'),
  };
  const lines = Object.fromEntries(Object.entries(states).map(([k, v]) => [k, lineStarting(v, 'Model:')]));
  assert.equal(new Set(Object.values(lines)).size, 7, JSON.stringify(lines, null, 1));
  assert.equal(lines.none, 'Model: not identified');
  assert.equal(lines['runtime documented'], 'Model: GPT-6.1 Sol (runtime metadata) — Work window documented');
  assert.equal(lines['runtime undocumented'], 'Model: GPT-6 Luna (runtime metadata) — Work window undocumented');
  assert.equal(lines['user documented'], 'Model: GPT-6.1 Sol (user-supplied) — Work window documented');
  assert.equal(lines['user undocumented'], 'Model: GPT-6 Luna (user-supplied) — Work window undocumented');
  assert.equal(lines['user unrecognized'], 'Model: "GPT-7 Foo" (user-supplied) — not in the Work model registry');
  assert.equal(lines['user ambiguous'], 'Model: "Sol" (user-supplied) — ambiguous: GPT-6.1 Sol, GPT-6 Sol, GPT-5.6 Sol');

  // Unknown, ambiguous, unrecognized, or absent identity never blocks guidance: same priority and advice as a known model.
  for (const [k, out] of Object.entries(states)) {
    assert.match(out, /^Handoff priority: LOW$/m, k);
    assert.ok(out.includes('Recommendation:\nContinue normally.'), k);
    assert.doesNotMatch(out, /UNKNOWN|model-relative|unavailable|limit=N|model=MODEL_ID/, k);
  }
  // Only the budget source (and its note) differs.
  assert.match(states['user documented'], /^Planning budget: 500k \(documented GPT-6\.1 Sol Work window, checked 2026-10-23\)$/m);
  for (const k of ['none', 'runtime undocumented', 'user undocumented', 'user unrecognized', 'user ambiguous']) {
    assert.match(states[k], /^Planning budget: 128k \(default heuristic\)$/m, k);
    assert.match(states[k], /^Note: Guidance uses a heuristic planning budget; actual model capacity and backend usage are unknown\.$/m, k);
  }
});

test('a user-supplied model name is never described as detected; only runtime metadata is labeled "runtime metadata"', () => {
  for (const v of ['GPT-6.1 Sol', 'GPT-6 Sol', 'GPT-7 Foo', 'Sol']) {
    const line = lineStarting(report(`/contextestimate model=${v}`), 'Model:');
    assert.match(line, /\(user-supplied\)/, v);
    assert.doesNotMatch(line, /detect|runtime|automatic/i, v);
  }
  // Runtime evidence must name the model and the Work surface.
  for (const runtime of [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6.1-sol', surface: 'chat' }, { id: 'gpt-6.1-sol', surface: 'api' }, { surface: 'work' }]) {
    assert.equal(lineStarting(report('/contextestimate', {}, runtime), 'Model:'), 'Model: not identified', JSON.stringify(runtime));
  }
});

test('model state does not alter budgets, thresholds, or recommendations; coverage still governs UNKNOWN', () => {
  const withBudget = report('/contextestimate limit=250000 model=GPT-6 Sol');
  assert.match(withBudget, /^Planning budget: 250k \(user budget\)$/m);
  assert.match(withBudget, /^Model: GPT-6 Sol \(user-supplied\) — Work window undocumented$/m);
  assert.match(withBudget, /^Handoff priority: LOW$/m);
  const unrec = report('/contextestimate limit=250000 model=GPT-7 Foo');
  assert.match(unrec, /^Handoff priority: LOW$/m);
  assert.match(unrec, /not in the Work model registry/);
  // Partial history keeps its own UNKNOWN and recommendation whatever the model state.
  for (const m of ['/contextestimate model=GPT-6 Sol', '/contextestimate model=GPT-6.1 Sol', '/contextestimate model=Sol', '/contextestimate']) {
    const partial = renderFor(500, resolve(m), { compacted: true });
    assert.match(partial, /^Handoff priority: UNKNOWN \(partial history\)$/m, m);
    assert.match(partial, /^Consider \/handoff before substantial work; earlier history is not counted\.$/m, m);
  }
});

// ---- targeted official-source lookup ----

const LIVE = (extra = {}) => ({ modelId: 'gpt-6-luna', name: 'GPT-6 Luna', window: 400000, scope: 'chatgpt-work', url: p.LEARN_MODELS_URL, ...extra });

test('a lookup is warranted only for an explicit model= naming a recognized model with no documented Work window', () => {
  const explicit = (modelId) => p.needsFreshnessLookup({ modelId, explicitModel: true, today: '2026-10-24' });
  const implicit = (modelId) => p.needsFreshnessLookup({ modelId, explicitModel: false, today: '2026-10-24' });
  for (const id of ['GPT-6 Sol', 'GPT-6 Luna', 'GPT-6 Astra', 'GPT-5.6 Terra']) {
    assert.deepEqual(explicit(id), { needed: true, reasons: ['explicit model= with no documented Work window'] }, id);
    assert.deepEqual(implicit(id), { needed: false, reasons: [] }, `${id}: a model from runtime metadata never browses`);
  }
  assert.deepEqual(explicit('GPT-6.1 Sol'), { needed: false, reasons: [] }, 'documented window: nothing to look up');
  assert.deepEqual(explicit('GPT-7 Foo').reasons, ['model absent from registry']);
  assert.deepEqual(explicit('Sol'), { needed: false, reasons: [] }, 'an ambiguous name cannot be searched');
  assert.deepEqual(p.needsFreshnessLookup({}), { needed: false, reasons: [] }, 'ordinary invocations never browse');
  assert.deepEqual(p.needsFreshnessLookup({ today: '2026-10-24' }), { needed: false, reasons: [] });
});

test('official-source results are accepted only when scoped to ChatGPT Work or Work and Codex for that exact model', () => {
  assert.deepEqual(p.acceptLiveResult(LIVE(), 'GPT-6 Luna'), { ok: true });
  assert.deepEqual(p.acceptLiveResult(LIVE({ scope: 'work-and-codex' }), 'model= gpt-6-luna'.replace('model= ', '')), { ok: true });
  assert.deepEqual(p.acceptLiveResult(LIVE({ modelId: '6 Luna', name: undefined }), 'GPT-6 Luna'), { ok: true });
  const rejects = {
    'API-only': { scope: 'api' },
    'API context window': { scope: 'api-context-window' },
    'Chat-only': { scope: 'chat' },
    'Codex-only': { scope: 'codex' },
    'output tokens': { scope: 'output-limit' },
    'max output tokens': { scope: 'max-output-tokens' },
    'usage allowance': { scope: 'usage-allowance' },
    'credits': { scope: 'credits' },
    'inferred from a family': { scope: 'inferred' },
    'ambiguous': { scope: 'ambiguous' },
    'unscoped': { scope: undefined },
    'not an official host': { url: 'https://example.com/models' },
    'API docs host': { url: 'https://developers.openai.com/api/docs/models' },
    'no exact window': { window: undefined },
    'non-integer window': { window: '400,000' },
    'source unavailable': { status: 'unavailable' },
  };
  for (const [what, override] of Object.entries(rejects)) {
    assert.equal(p.acceptLiveResult(LIVE(override), 'GPT-6 Luna').ok, false, what);
    assert.deepEqual(resolve('/contextestimate model=GPT-6 Luna'), BASELINE);
    assert.deepEqual(p.resolveLimit(p.parseInvocation('/contextestimate model=GPT-6 Luna'), 'none', undefined, { live: LIVE(override) }), BASELINE, what);
  }
  // A figure for a different model, or for a model that only shares a family, is not this model's.
  for (const other of [{ modelId: 'gpt-6-sol', name: 'GPT-6 Sol' }, { modelId: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }, { modelId: 'gpt-6-luna-mini', name: 'GPT-6 Luna Mini' }, { modelId: 'luna', name: 'Luna' }]) {
    assert.equal(p.acceptLiveResult(LIVE(other), 'GPT-6 Luna').ok, false, JSON.stringify(other));
  }
  // An ambiguous name is never matched to a result.
  assert.equal(p.acceptLiveResult(LIVE({ modelId: 'sol', name: 'Sol' }), 'Sol').ok, false);
});

test('an accepted result applies to that invocation only, is labeled as a live check, and persists nothing', () => {
  const registrySnapshot = JSON.stringify(p.MODEL_REGISTRY);
  const inv = p.parseInvocation('/contextestimate model=GPT-6 Luna');
  const lim = p.resolveLimit(inv, 'none', undefined, { live: LIVE() });
  assert.equal(lim.value, 400000);
  assert.equal(lim.source, 'documented');
  assert.equal(lim.via, 'live');
  const out = renderFor(500, lim);
  assert.match(out, /^Planning budget: 400k \(GPT-6 Luna Work window, live check\)$/m);
  assert.match(out, /^Model: GPT-6 Luna \(user-supplied\) — Work window from live check$/m);
  assert.match(out, /^Handoff priority: LOW$/m);
  // The next invocation, without a lookup, is back to the registry; nothing was written.
  assert.deepEqual(resolve('/contextestimate model=GPT-6 Luna'), BASELINE);
  assert.equal(JSON.stringify(p.MODEL_REGISTRY), registrySnapshot);
  assert.equal(p.findRegistryEntry('GPT-6 Luna').window, null);
  assert.equal(p.resolveLimit(inv, 'none').source, 'baseline');
});

test('a lookup result alone never establishes a model, and budgets still win', () => {
  assert.deepEqual(p.resolveLimit(p.parseInvocation('/contextestimate'), 'none', undefined, { live: LIVE() }), BASELINE);
  assert.deepEqual(p.resolveLimit(p.parseInvocation('/contextestimate model=GPT-6 Sol'), 'none', undefined, { live: LIVE() }), BASELINE);
  assert.equal(p.resolveLimit(p.parseInvocation('/contextestimate limit=100000 model=GPT-6 Luna'), 'none', undefined, { live: LIVE() }).source, 'override');
  assert.equal(p.resolveLimit(p.parseInvocation('/contextestimate model=GPT-6 Luna'), '64000', undefined, { live: LIVE() }).source, 'saved');
});

test('lookup that finds nothing, or no search tool, keeps the default budget and says so in one note; a search is claimed only when one was used', () => {
  const none = renderFor(500, resolve('/contextestimate model=GPT-6 Luna'), { lookup: 'none-found' });
  assert.match(none, /^Note: An official-source search found no ChatGPT Work window for GPT-6 Luna\.$/m);
  assert.match(none, /^Handoff priority: LOW$/m);
  assert.match(none, /^Planning budget: 128k \(default heuristic\)$/m);
  const unavailable = renderFor(500, resolve('/contextestimate model=GPT-5.6 Terra'), { lookup: 'unavailable' });
  assert.match(unavailable, /^Note: No search tool was available, so GPT-5\.6 Terra's Work window was not looked up\.$/m);
  assert.doesNotMatch(unavailable, /searched|search found/i);
  assert.match(unavailable, /^Handoff priority: LOW$/m);
  // No lookup note without an outcome, and none for an ambiguous name.
  assert.doesNotMatch(renderFor(500, resolve('/contextestimate model=GPT-6 Luna')), /search/i);
  assert.doesNotMatch(renderFor(500, resolve('/contextestimate model=Sol'), { lookup: 'none-found' }), /search/i);
  // Unrecognized names can be searched, and the note quotes the name as given.
  assert.match(renderFor(500, resolve('/contextestimate model=GPT-7 Foo'), { lookup: 'none-found' }), /search found no ChatGPT Work window for "GPT-7 Foo"/);
});

test('the accessible-text estimate is identical whichever model is named, asserted, or selected', () => {
  const names = ['', ' model=GPT-6.1 Sol', ' model= GPT-6 Sol', ' model=GPT-6 Luna', ' model=GPT-6 Astra', ' model=GPT-5.6 Terra', ' model=GPT-7 Foo', ' model=Sol'];
  const body = g.GREETING;
  const sizes = names.map((n) => h.estimateMessages([...body, { role: 'user', text: `/contextestimate${n}` }]));
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 12, `only the length of the typed invocation differs: ${sizes.join(', ')}`);
  // The estimate excludes the invocation text entirely: identical transcript, identical estimate.
  const fixed = h.estimateMessages([...body]);
  for (const n of names) assert.equal(h.estimateMessages([...body]), fixed, n);
  // And the report's accessible-text line is the same for every model.
  const textLines = names.map((n) => {
    const lim = resolve(`/contextestimate${n}`);
    return lineStarting(renderFor(fixed, lim), 'Estimated accessible text:');
  });
  assert.equal(new Set(textLines).size, 1, textLines.join(' | '));
  assert.equal(textLines[0], 'Estimated accessible text: <1k tokens');
});

test('switching models between invocations resolves each one afresh and re-estimates the same text', () => {
  const t = g.transcriptSolSecondRun();
  const est = h.estimateMessages(t);
  const seq = ['/contextestimate model=GPT-6.1 Sol', '/contextestimate model=GPT-6 Luna', '/contextestimate', '/contextestimate model=GPT-6.1 Sol Medium', '/contextestimate model=GPT-5.6 Terra'];
  const limits = seq.map(resolve);
  assert.deepEqual(limits.map((l) => l.value), [500000, 128000, 128000, 500000, 128000]);
  assert.deepEqual(limits.map((l) => l.source), ['documented', 'baseline', 'baseline', 'documented', 'baseline']);
  for (const lim of limits) assert.match(renderFor(est, lim), /^Estimated accessible text: <1k tokens$/m);
});

test('switching between two undocumented models gives the same default budget and the same guidance', () => {
  for (const tokens of [5000, 70000, 120000]) {
    const luna = renderFor(tokens, resolve('/contextestimate model=GPT-6 Luna'));
    const terra = renderFor(tokens, resolve('/contextestimate model=GPT-5.6 Terra'));
    // Only the Model line differs.
    const strip = (out) => out.split('\n').filter((l) => !l.startsWith('Model:')).join('\n');
    assert.equal(strip(luna), strip(terra), String(tokens));
    assert.match(luna, /^Planning budget: 128k \(default heuristic\)$/m);
    assert.notEqual(lineStarting(luna, 'Model:'), lineStarting(terra, 'Model:'));
  }
});

test('search results produced by this invocation do not inflate its estimate', () => {
  const body = g.GREETING;
  const invocation = { role: 'user', text: '/contextestimate model=GPT-6 Luna' };
  const search = { role: 'tool', text: 'Official sources: '.concat('ChatGPT Work and Codex models. '.repeat(400)), thisInvocation: true };
  const without = h.estimateMessages([...body, invocation]);
  assert.equal(h.estimateMessages([...body, invocation, search]), without);
  // The same text as an ordinary, earlier tool result in the conversation is counted.
  assert.ok(h.estimateMessages([...body, { ...search, thisInvocation: false }, invocation]) > without + 1000);
  const out = renderFor(without, resolve('/contextestimate model=GPT-6 Luna'), { lookup: 'none-found' });
  assert.match(out, /^Estimated accessible text: <1k tokens$/m);
  assert.match(out, /^Handoff priority: LOW$/m);
});

test('SKILL.md documents the parsing, alias, and lookup rules this suite exercises', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { SKILL_DIR } = require('../src/bundle');
  const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(skill, /spaces around `=` are allowed \(`model= GPT-6 Sol`\)/);
  assert.match(skill, /the rest of the first line up to the next `limit=`, `bar=`, or `model=`/);
  assert.match(skill, /Never invent an ID or window/);
  assert.match(skill, /\(d\) this invocation's `model=` names a recognized model with no documented Work window: search for that exact model's ChatGPT Work context window/);
  assert.match(skill, /Do not browse for an ordinary estimate/);
  assert.match(skill, /scopes that exact number to ChatGPT Work or to Work and Codex for that exact model/);
  assert.match(skill, /Say a search happened only if you actually used a search tool/);
  assert.ok(skill.includes(p.lookupNote['none-found']('<Model name>')));
  assert.ok(skill.includes(p.lookupNote.unavailable('<Model name>')));
  assert.match(skill, /never say a user-supplied name was detected/);
  assert.match(skill, /An unknown, ambiguous, unrecognized, or undocumented model also gets the default; it never blocks guidance/);
});
