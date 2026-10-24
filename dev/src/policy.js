'use strict';
// Reference implementation of the deterministic parts of SKILL.md: invocation
// parsing, model-name resolution, planning-limit and model-evidence resolution,
// planning-risk classification, display rounding, the progress bar, and the
// report layout. Used by the tests to pin down the documented policy; the
// skill does not execute this code inside ChatGPT.

// Conservative planning baseline used only when no budget and no documented
// model window applies. It is not a claim about any model's real window.
const DEFAULT_LIMIT = 128000;
const DEFAULT_THRESHOLDS = { medium: 50, high: 70, critical: 90 };

// Registry of the ChatGPT Work model lineup as documented by OpenAI, mirrored
// from the registry table in SKILL.md (tests keep the two in sync). A listing
// is not a claim that a model is available to any particular plan, workspace,
// role, or rollout. `window` is an exact number only where an official source
// explicitly gives a ChatGPT Work or Work-and-Codex value; otherwise null
// ("not documented"). Never infer a window from API documentation, output
// limits, usage allowances, or model-family similarity. `labels` are extra
// official short names (the ChatGPT Learn model picker shows "Astra").
const HELP_WORK_URL = 'https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex';
const LEARN_MODELS_URL = 'https://learn.chatgpt.com/docs/models';
const REGISTRY_CHECKED = '2026-10-23';
const REGISTRY_FRESHNESS_DAYS = 90;
const MODEL_REGISTRY = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', window: 500000, source: HELP_WORK_URL, checked: REGISTRY_CHECKED },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', window: null, source: LEARN_MODELS_URL, checked: REGISTRY_CHECKED },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', window: null, source: LEARN_MODELS_URL, checked: REGISTRY_CHECKED },
  { id: null, name: 'GPT-6 Astra', labels: ['Astra'], window: null, source: LEARN_MODELS_URL, checked: REGISTRY_CHECKED },
  { id: null, name: 'GPT-5.6 Sol', window: null, source: LEARN_MODELS_URL, checked: REGISTRY_CHECKED },
  { id: null, name: 'GPT-5.6 Terra', window: null, source: LEARN_MODELS_URL, checked: REGISTRY_CHECKED },
  { id: null, name: 'GPT-5.6 Luna', window: null, source: LEARN_MODELS_URL, checked: REGISTRY_CHECKED },
];
const DOCUMENTED_SOURCE = {
  url: HELP_WORK_URL,
  verified: REGISTRY_CHECKED,
  wording: 'GPT-6.1 Sol has a default context window of 500,000 tokens in ChatGPT Work and Codex.',
};
// Only the entries with a documented Work window.
const DOCUMENTED_MODEL_DEFAULTS = Object.fromEntries(
  MODEL_REGISTRY.filter((m) => m.window).map((m) => [m.id, { name: m.name, limit: m.window }]),
);

// Official hosts a live lookup may cite. A live value is accepted only when the
// source also explicitly scopes it to ChatGPT Work or to Work and Codex.
const OFFICIAL_HOSTS = ['help.openai.com', 'learn.chatgpt.com', 'openai.com', 'www.openai.com'];
const WORK_SCOPES = ['chatgpt-work', 'work-and-codex'];

// Reasoning-effort words the model picker appends ("GPT-6.1 Sol Medium").
const EFFORT_WORDS = ['light', 'low', 'medium', 'high', 'extra-high', 'xhigh', 'max', 'ultra'];

const BAR_WIDTH = 20; // 5% per block
const BAR_STYLES = {
  unicode: { fill: '█', empty: '░' },
  ascii: { fill: '#', empty: '.' },
};

const LIMIT_LABELS = {
  override: 'user override',
  saved: 'saved user budget',
  baseline: 'conservative baseline; model window unknown',
};

const RECOMMENDATIONS = {
  LOW: 'Continue normally.',
  MEDIUM: 'Continue, but plan a /handoff before a long task.',
  HIGH: 'Run /handoff before starting another major task.',
  CRITICAL: 'Run /handoff now before continuing substantial work.',
  UNKNOWN: 'If this chat feels long, consider /handoff before substantial work.',
};

// Used when planning risk is UNKNOWN because history is partial or attachments
// are unmeasured (an explicit reason to consider a handoff). The base is
// escalated by the counted share only for a known planning limit.
const INCOMPLETE_SUFFIX = {
  partial: 'earlier history is not counted',
  unmeasured: 'attachments or images are not counted',
  both: 'earlier history and attachments or images are not counted',
};
const INCOMPLETE_BASE = {
  LOW: 'Consider /handoff before substantial work',
  MEDIUM: 'Consider /handoff before substantial work',
  HIGH: 'Run /handoff before starting another major task',
  CRITICAL: 'Run /handoff now before continuing substantial work',
};

// An unknown model window is not, by itself, a reason to hand off. Each
// resolution state says what is actually known and offers only what can help.
// `limit=N` is the user's own planning budget; it never reveals a model's real
// window.
const BUDGET_EXAMPLE = '`@contextestimate limit=250000`';
const MODEL_RECOMMENDATIONS = {
  none: `A model-relative handoff assessment is unavailable because the model window is unknown. For a planning comparison, invoke this skill again with \`limit=N\` in the same message, e.g. ${BUDGET_EXAMPLE}.`,
  undocumented: (name) =>
    `${name} was recognized, but no ChatGPT Work context window is documented, so a model-relative handoff assessment is unavailable. For a planning comparison, invoke this skill again with your own budget in the same message, e.g. ${BUDGET_EXAMPLE} (a planning figure, not the model's actual window).`,
  unrecognized: `The model name was not recognized, so a model-relative handoff assessment is unavailable. Invoke this skill again with a clearer model name in the same message, or a budget such as ${BUDGET_EXAMPLE}.`,
  ambiguous: (list) =>
    `The model name is ambiguous or incomplete (could be ${list}), so a model-relative handoff assessment is unavailable. Invoke this skill again with the full model name in the same message, or a budget such as ${BUDGET_EXAMPLE}.`,
};
// Planning-risk reason shown for each model state when the baseline is the only limit.
const MODEL_REASONS = {
  none: 'model window unknown',
  stale: 'model window unknown',
  undocumented: 'model window not documented',
  unrecognized: 'model not recognized',
  ambiguous: 'model ambiguous',
};

const NOTES = {
  budget: 'Note: Visible-text share of your planning budget; the real model window and backend usage are unknown.',
  documented: 'Note: Visible-text estimate against the documented window; backend usage is unknown.',
  baseline: 'Note: Visible-text estimate against a conservative baseline; the model window and backend usage are unknown.',
  over: 'Note: Visible text exceeds the planning limit; backend usage is unknown, and ChatGPT may compact or truncate internally, which this skill cannot see.',
  partial: "Note: Counts visible text only, not ChatGPT's backend token usage or internal compaction; earlier history is summarized or truncated, so actual usage may be higher or lower.",
  unmeasured: "Note: Counts visible text only, not ChatGPT's backend token usage; attachments or images were not counted, so actual usage may differ.",
  both: "Note: Counts visible text only, not ChatGPT's backend token usage or internal compaction; earlier history is summarized or truncated and attachments or images were not counted, so actual usage may be higher or lower.",
  unavailable: 'Note: Conversation content could not be measured.',
  host: 'Note: Host-reported measurement.',
  conflictingModel: 'Note: Ignored conflicting model values.',
};
const staleNote = (name) =>
  `Note: The registry entry for ${name} is older than 90 days and was not rechecked, so its window is treated as unknown.`;
const transcriptNote = (tokenizer) =>
  `Note: Counts the supplied text with ${tokenizer}; it may not match any Work model's tokenizer or the active context.`;
// Targeted lookup outcomes (explicit model= for a model with no documented Work window).
const lookupNote = {
  'none-found': (name) => `Note: Searched official OpenAI sources for ${name}; no ChatGPT Work context window was found.`,
  unavailable: (name) => `Note: Search is unavailable here, so ${name}'s Work window stays unknown.`,
};

function isValidLimit(raw) {
  return typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(Number(raw));
}

// "GPT-6.1 Sol", "gpt-6.1_sol" -> "gpt-6.1-sol". Returns null if unusable.
function normalizeModelId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return /^[a-z0-9][a-z0-9.-]*$/.test(id) ? id : null;
}

// Strips one pair of surrounding quotes or backticks (straight or curly) and
// trims whitespace; collapses internal whitespace.
function cleanModelValue(raw) {
  let v = String(raw).replace(/\s+/g, ' ').trim();
  const pairs = [['"', '"'], ["'", "'"], ['`', '`'], ['“', '”'], ['‘', '’']];
  for (const [open, close] of pairs) {
    if (v.length >= 2 && v.startsWith(open) && v.endsWith(close)) {
      v = v.slice(open.length, v.length - close.length).trim();
      break;
    }
  }
  return v;
}

// Canonical comparison key: lowercase, every dash variant (OpenAI's pages use
// U+2011) becomes "-", separators collapse to single hyphens.
function canon(value) {
  return String(value)
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

function entryKeys(m) {
  const keys = [];
  if (m.id) keys.push(canon(m.id));
  keys.push(canon(m.name));
  keys.push(canon(m.name.replace(/^GPT-/i, ''))); // "6.1 Sol", "6 Luna", "5.6 Terra"
  for (const label of m.labels || []) keys.push(canon(label)); // "Astra"
  return keys;
}

// Resolves a model name or ID against the registry:
//   recognized   exact ID, full name, name without "GPT-", or an official short
//                label, optionally followed by a reasoning-effort word
//   ambiguous    not an exact match, but the words are a contiguous part of
//                one or more registry names ("Sol", "Luna", "gpt-6")
//   unrecognized anything else (including real models that are not in the
//                Work registry, such as GPT-6 Pro)
// Nothing is matched by family similarity, and no ID or window is invented.
function resolveModelInput(raw) {
  const key = canon(cleanModelValue(raw ?? ''));
  if (!key) return { state: 'unrecognized', key: '' };
  const exact = (k) => MODEL_REGISTRY.filter((m) => entryKeys(m).includes(k));
  let hits = exact(key);
  let via = 'name';
  if (hits.length === 0) {
    const parts = key.split('-');
    const last = parts[parts.length - 1];
    const prev = parts[parts.length - 2];
    const effort = last === 'high' && prev === 'extra' ? 2 : EFFORT_WORDS.includes(last) ? 1 : 0;
    if (effort && parts.length > effort) {
      hits = exact(parts.slice(0, parts.length - effort).join('-'));
      via = 'effort-stripped';
    }
  }
  if (hits.length === 1) return { state: 'recognized', entry: hits[0], key, via };
  const tokens = key.split('-');
  const candidates = MODEL_REGISTRY.filter((m) => {
    const hay = canon(m.name).split('-');
    for (let i = 0; i + tokens.length <= hay.length; i++) {
      if (tokens.every((t, j) => hay[i + j] === t)) return true;
    }
    return false;
  });
  if (hits.length > 1 || candidates.length > 0) {
    const list = (hits.length > 1 ? hits : candidates).map((m) => m.name);
    return { state: 'ambiguous', candidates: list, key };
  }
  return { state: 'unrecognized', key };
}

// Parses a user message. Returns null when the message is not an invocation.
// Only the first line is read: options on later lines, or text elsewhere in
// the conversation, are never treated as arguments.
// Options: limit=N, model=NAME (user assertion of the selected Work model; the
// value is the rest of the line, up to the next limit=/bar=/model= option, so
// multiword names work and whitespace around "=" is allowed), bar=ascii.
function parseInvocation(message, { selected = false } = {}) {
  // The invoking message starts with an `@contextestimate` mention and/or
  // `/contextestimate` text. `selected` means the platform shows that this
  // skill was picked for the message (for example with the @ picker) even if
  // its name is not in the text. A later message holding only `model=...` or
  // `limit=...` is not an invocation and never updates an earlier report.
  const m = /^\s*(@contextestimate(?![\w-]))?[ \t]*(\/contextestimate(?![\w-]))?([^\n]*)/.exec(message);
  if (!m || (!m[1] && !m[2] && !selected)) return null;
  const args = m[3];
  const opt = (name) => [...args.matchAll(new RegExp(`(?:^|\\s)${name}=(\\S*)`, 'g'))].map((x) => x[1]);

  const bars = opt('bar');
  const barStyle = bars.length > 0 && bars.every((b) => b === 'ascii') ? 'ascii' : 'unicode';

  const raws = opt('limit');
  let override = { status: 'none' };
  if (raws.length > 0) {
    const distinct = [...new Set(raws)];
    override =
      distinct.length === 1 && isValidLimit(distinct[0])
        ? { status: 'valid', value: Number(distinct[0]), raw: distinct[0] }
        : { status: 'invalid', raw: raws.join(' ') };
  }

  const values = [...args.matchAll(/(?:^|\s)model\s*=\s*([\s\S]*?)(?=\s(?:limit|bar|model)\s*=|$)/g)]
    .map((x) => cleanModelValue(x[1]))
    .filter((v) => v !== '');
  let model = { status: 'none' };
  if (values.length > 0) {
    const resolved = values.map((v) => ({ raw: v, resolution: resolveModelInput(v) }));
    const sig = (r) => (r.resolution.state === 'recognized' ? `entry:${r.resolution.entry.name}` : `key:${r.resolution.key || r.raw}`);
    if (new Set(resolved.map(sig)).size > 1) {
      model = { status: 'conflicting', raw: values.join(' ') };
    } else {
      const { raw, resolution } = resolved[0];
      const id = resolution.state === 'recognized' ? resolution.entry.id || normalizeModelId(resolution.entry.name) : normalizeModelId(raw);
      model = { status: 'asserted', raw, id, resolution };
    }
  }
  return { override, barStyle, model };
}

// Describes the model evidence for this invocation, re-evaluated every time.
// Accepted: (1) trusted runtime metadata that identifies both the model and the
// Work surface, supplied by the platform for this invocation; (2) a model=
// assertion in the invoking message (a user assertion, never detection).
// Nothing else qualifies: not the assistant's self-identification, an earlier
// invocation, quoted or summarized content, the plan, the task type, or the
// tooling used to build this skill.
function describeModel({ invocation, runtime } = {}) {
  if (runtime && runtime.surface === 'work' && runtime.id) {
    const raw = cleanModelValue(runtime.id);
    if (raw) return { source: 'runtime', raw, resolution: resolveModelInput(raw) };
  }
  const m = invocation && invocation.model;
  if (m && m.status === 'asserted') return { source: 'user', raw: m.raw, resolution: m.resolution };
  if (m && m.status === 'conflicting') return { source: 'none', conflicting: true };
  return { source: 'none' };
}

function modelId(info) {
  const r = info.resolution;
  if (!r) return null;
  if (r.state === 'recognized') return r.entry.id || normalizeModelId(r.entry.name);
  return normalizeModelId(info.raw);
}

// Kept for callers that only need the evidenced model's ID and source.
function resolveModel(args = {}) {
  const info = describeModel(args);
  if (info.source === 'none') return null;
  const id = modelId(info);
  return id ? { id, source: info.source === 'runtime' ? 'runtime' : 'user' } : null;
}

// Planning-limit precedence: valid limit=N; valid saved_limit; documented Work
// window for the currently evidenced model (registry, or a lookup result that
// passes the Work-scope rules); conservative baseline. `saved` is the
// `saved_limit` value from the skill configuration ("none" or digits). Derived
// limits are never written back to saved_limit. The returned object also
// carries a non-enumerable `modelInfo` used for the report's Model line.
function resolveLimit(invocation, saved, runtime, { live, today } = {}) {
  const info = describeModel({ invocation, runtime });
  const attach = (limit, state) => {
    Object.defineProperty(limit, 'modelInfo', { value: { ...info, state: state || stateOf(info, today) }, enumerable: false });
    return limit;
  };
  const override = invocation && invocation.override;
  if (override && override.status === 'valid') {
    return attach({ value: override.value, source: 'override', label: LIMIT_LABELS.override });
  }
  const savedStr = saved === undefined || saved === null ? 'none' : String(saved).trim();
  if (isValidLimit(savedStr)) return attach({ value: Number(savedStr), source: 'saved', label: LIMIT_LABELS.saved });

  const r = info.resolution;
  if (r && r.state === 'recognized') {
    const entry = r.entry;
    const stale = isStale(entry, today);
    if (entry.window && !stale) {
      return attach(
        { value: entry.window, source: 'documented', via: 'registry', label: `documented ${entry.name} / Work default`, model: modelId(info), modelSource: info.source === 'runtime' ? 'runtime' : 'user' },
        'documented',
      );
    }
    if (live && acceptLiveResult(live, info.raw).ok) {
      return attach(
        { value: live.window, source: 'documented', via: 'live', label: `documented ${live.name || entry.name} / Work default; live check`, model: modelId(info), modelSource: info.source === 'runtime' ? 'runtime' : 'user' },
        'live',
      );
    }
    // A registry window older than the freshness limit that was not reconfirmed is treated as unknown.
    if (entry.window && stale) return attach({ value: DEFAULT_LIMIT, source: 'baseline', label: LIMIT_LABELS.baseline, staleModel: entry.name }, 'stale');
    return attach({ value: DEFAULT_LIMIT, source: 'baseline', label: LIMIT_LABELS.baseline }, 'undocumented');
  }
  if (r && r.state === 'unrecognized' && live && acceptLiveResult(live, info.raw).ok) {
    return attach(
      { value: live.window, source: 'documented', via: 'live', label: `documented ${live.name || info.raw} / Work default; live check`, model: modelId(info), modelSource: info.source === 'runtime' ? 'runtime' : 'user' },
      'live',
    );
  }
  return attach({ value: DEFAULT_LIMIT, source: 'baseline', label: LIMIT_LABELS.baseline }, stateOf(info));
}

// Model resolution state for the report, before limits are considered.
function stateOf(info, today) {
  const r = info.resolution;
  if (!r) return 'none';
  if (r.state !== 'recognized') return r.state; // ambiguous | unrecognized
  if (!r.entry.window) return 'undocumented';
  return isStale(r.entry, today) ? 'stale' : 'documented';
}

// Registry rows match exactly by ID, full name, name without "GPT-", or an
// official short label. Nothing is matched by family similarity.
function findRegistryEntry(modelIdOrName) {
  const r = resolveModelInput(modelIdOrName);
  return r.state === 'recognized' ? r.entry : null;
}

function daysBetween(fromISO, toISO) {
  return Math.floor((Date.parse(toISO) - Date.parse(fromISO)) / 86400000);
}

// If today's date is not reliably known (`today` missing or invalid), the row is treated as fresh.
function isStale(entry, today) {
  if (!entry || !today || Number.isNaN(Date.parse(today))) return false;
  return daysBetween(entry.checked, today) > REGISTRY_FRESHNESS_DAYS;
}

// Whether a web lookup of official sources is warranted. Ordinary estimates
// return needed=false: no browsing is required to produce a report.
// `explicitModel` means the model came from a model= value in this invocation.
function needsFreshnessLookup({ explicitRequest = false, modelId: id = null, explicitModel = false, today } = {}) {
  const reasons = [];
  if (explicitRequest) reasons.push('explicit request');
  if (id) {
    const r = resolveModelInput(id);
    if (r.state === 'unrecognized') reasons.push('model absent from registry');
    else if (r.state === 'recognized') {
      if (isStale(r.entry, today)) reasons.push('registry entry older than 90 days');
      else if (explicitModel && !r.entry.window) reasons.push('explicit model= with no documented Work window');
    }
    // An ambiguous name cannot be searched; the report asks for a clearer name.
  }
  return { needed: reasons.length > 0, reasons };
}

// A looked-up window is accepted only for the exact model in question, with an
// official source that explicitly scopes the number to ChatGPT Work or Work
// and Codex. API values, output limits, allowances, Codex-only or Chat-only
// values, other models' figures, and ambiguous or inaccessible sources are not
// accepted.
function acceptLiveResult(result, modelName) {
  if (!result || typeof result !== 'object') return { ok: false, reason: 'no result' };
  if (result.status && result.status !== 'ok') return { ok: false, reason: 'source unavailable' };
  const want = resolveModelInput(modelName);
  const got = [result.modelId, result.name].filter(Boolean).map(resolveModelInput);
  const same = (a, b) =>
    a.state === 'recognized' && b.state === 'recognized'
      ? a.entry === b.entry
      : a.state === 'unrecognized' && b.state === 'unrecognized' && a.key !== '' && a.key === b.key;
  if (want.state === 'ambiguous' || !got.some((g) => same(want, g))) return { ok: false, reason: 'different model' };
  let host;
  try {
    host = new URL(result.url).hostname;
  } catch {
    return { ok: false, reason: 'no source URL' };
  }
  if (!OFFICIAL_HOSTS.includes(host)) return { ok: false, reason: 'not an official OpenAI source' };
  if (!WORK_SCOPES.includes(result.scope)) return { ok: false, reason: 'not scoped to ChatGPT Work or Work and Codex' };
  if (!Number.isInteger(result.window) || result.window <= 0) return { ok: false, reason: 'no exact window' };
  return { ok: true };
}

function usagePercent(tokens, limit) {
  return (tokens / limit) * 100;
}

function classify(usage, t = DEFAULT_THRESHOLDS) {
  if (!Number.isFinite(usage)) return 'UNKNOWN';
  if (usage >= t.critical) return 'CRITICAL';
  if (usage >= t.high) return 'HIGH';
  if (usage >= t.medium) return 'MEDIUM';
  return 'LOW';
}

// Planning risk compares visible text with the planning limit. It is UNKNOWN
// whenever coverage is incomplete or the only denominator is the baseline (the
// reason says which model state applies). It is never a measure of backend
// context risk. `modelState` is none | recognized-variants | ambiguous | ...
function planningRisk(usage, { compacted, unmeasured, source, modelState = 'none' }, t = DEFAULT_THRESHOLDS) {
  const reasons = [];
  if (compacted) reasons.push('partial history');
  if (unmeasured) reasons.push('unmeasured attachments');
  if (source === 'baseline') reasons.push(MODEL_REASONS[modelState] || MODEL_REASONS.none);
  if (reasons.length > 0) return { level: 'UNKNOWN', reasons };
  return { level: classify(usage, t), reasons: [] };
}

function formatTokens(tokens) {
  if (tokens < 1000) return '<1k';
  if (tokens < 100000) return `~${Math.round(tokens / 1000)}k`;
  return `~${Math.round(tokens / 5000) * 5}k`;
}

function formatLimit(limit) {
  if (limit % 1000000 === 0) return `${limit / 1000000}M`;
  if (limit % 1000 === 0) return `${limit / 1000}k`;
  return limit.toLocaleString('en-US');
}

function formatPercent(usage) {
  if (usage < 1) return '<1%';
  return `~${Math.round(usage)}%`;
}

// Number of filled blocks out of BAR_WIDTH, from the unrounded usage:
//   0            -> 0 blocks
//   0 < u < 100  -> floor(u / 5 + 0.5), clamped to 1..19
//   u >= 100     -> 20 (a full bar never hides a value that is still below 100)
function barFill(usage) {
  if (!(usage > 0)) return 0;
  if (usage >= 100) return BAR_WIDTH;
  return Math.min(BAR_WIDTH - 1, Math.max(1, Math.floor(usage / (100 / BAR_WIDTH) + 0.5)));
}

function bar(usage, style = 'unicode') {
  const s = BAR_STYLES[style] || BAR_STYLES.unicode;
  const n = barFill(usage);
  return `[${s.fill.repeat(n)}${s.empty.repeat(BAR_WIDTH - n)}]`;
}

// Short display name for a model value in the report.
function displayName(info) {
  const r = info.resolution;
  if (r && r.state === 'recognized') return r.entry.name;
  const raw = info.raw.length > 40 ? `${info.raw.slice(0, 37)}...` : info.raw;
  return `"${raw}"`;
}

// The report's Model line: where the model came from, and what is known about
// it. A user-supplied name is always "supplied by you with model=", never
// "detected".
function modelLine(info, limitState) {
  if (!info || info.source === 'none') return 'Model: not identified (no trusted runtime metadata and no model=)';
  const from = info.source === 'runtime' ? 'from trusted runtime metadata' : 'supplied by you with model=';
  const r = info.resolution;
  const name = displayName(info);
  if (r.state === 'recognized') {
    const tail =
      limitState === 'documented' ? 'recognized; Work window documented'
      : limitState === 'live' ? 'recognized; Work window found by a live check'
      : limitState === 'stale' ? 'recognized; registry window older than 90 days, not rechecked'
      : 'recognized; no ChatGPT Work window documented';
    return `Model: ${name} (${from}; ${tail})`;
  }
  if (r.state === 'ambiguous') {
    const shown = r.candidates.slice(0, 3).join(', ') + (r.candidates.length > 3 ? `, and ${r.candidates.length - 3} more` : '');
    return `Model: ${name} (${from}; ambiguous or incomplete, could be ${shown})`;
  }
  return `Model: ${name} (${from}; not recognized, not in the Work model registry)`;
}

// The recommendation for an UNKNOWN planning risk, by cause.
// - Missing history or unmeasured attachments are explicit reasons to consider a
//   handoff. The base escalates with the counted share only for a known planning
//   limit (override, saved, documented); against the baseline the share is not a
//   reliable threshold comparison, so the base stays at "consider".
// - Otherwise the model state decides: the report says what is unknown and
//   offers only what can help, with no handoff advice from the unknown alone.
function incompleteRecommendation(usage, { compacted, unmeasured, source, modelState = 'none', info, staleModel }, t = DEFAULT_THRESHOLDS) {
  if (compacted || unmeasured) {
    const base = source === 'baseline' ? INCOMPLETE_BASE.LOW : INCOMPLETE_BASE[classify(usage, t)];
    return `${base}; ${INCOMPLETE_SUFFIX[compacted ? (unmeasured ? 'both' : 'partial') : 'unmeasured']}.`;
  }
  const r = info && info.resolution;
  if (modelState === 'undocumented') return MODEL_RECOMMENDATIONS.undocumented(r.entry.name);
  if (modelState === 'unrecognized') return MODEL_RECOMMENDATIONS.unrecognized;
  if (modelState === 'ambiguous') {
    return MODEL_RECOMMENDATIONS.ambiguous(r.candidates.slice(0, 3).join(', ') + (r.candidates.length > 3 ? `, and ${r.candidates.length - 3} more` : ''));
  }
  return MODEL_RECOMMENDATIONS.none;
}

// state: {
//   kind: 'estimate' | 'unavailable' | 'host' | 'transcript',
//   tokens, limit (from resolveLimit), unmeasured?, compacted?,
//   invalidLimitRaw?, conflictingModel?, tokenizer? (transcript kind),
//   lookup? ('none-found' | 'unavailable': outcome of a targeted lookup),
//   hostLimit? (host kind only), thresholds?, barStyle?
// }
function render(state) {
  const t = state.thresholds || DEFAULT_THRESHOLDS;
  const style = state.barStyle || 'unicode';
  const info = state.limit.modelInfo || { source: 'none', state: 'none' };
  const modelState = info.state || 'none';
  const limitLine = `Planning limit: ${formatLimit(state.limit.value)} (${state.limit.label})`;
  const modelText = modelLine(info, modelState);
  const lines = ['Context Estimate'];
  const extraNotes = [];
  if (state.invalidLimitRaw !== undefined) extraNotes.push(`Note: Ignored invalid limit "${state.invalidLimitRaw}".`);
  if (state.conflictingModel) extraNotes.push(NOTES.conflictingModel);
  if (state.limit.staleModel) extraNotes.push(staleNote(state.limit.staleModel));
  if (state.lookup && lookupNote[state.lookup] && info.resolution && info.resolution.state !== 'ambiguous') {
    extraNotes.push(lookupNote[state.lookup](displayName(info)));
  }
  const finish = (primaryNote) => [...lines, '', primaryNote, ...extraNotes].join('\n');

  if (state.kind === 'unavailable') {
    lines.push('Estimated accessible text: Unavailable', limitLine, modelText, '');
    lines.push('Planning risk: UNKNOWN', 'Recommendation:', RECOMMENDATIONS.UNKNOWN);
    return finish(NOTES.unavailable);
  }

  // Genuine platform telemetry only: measured usage and its limit, same scope.
  if (state.kind === 'host') {
    const usage = usagePercent(state.tokens, state.hostLimit);
    const risk = classify(usage, t);
    lines.push(`Measured context: ${state.tokens.toLocaleString('en-US')} tokens (host-reported)`);
    lines.push(`Context limit: ${formatLimit(state.hostLimit)} (host-reported)`);
    lines.push(`${bar(usage, style)} ${formatPercent(usage)} of context limit (host-reported)`, '');
    lines.push(`Context risk: ${risk} (host-reported)`, 'Recommendation:', RECOMMENDATIONS[risk]);
    return finish(NOTES.host);
  }

  const usage = usagePercent(state.tokens, state.limit.value);
  const pct = formatPercent(usage);
  const incomplete = state.compacted ? (state.unmeasured ? 'both' : 'partial') : state.unmeasured ? 'unmeasured' : null;
  const suffix = incomplete === 'partial' || incomplete === 'both' ? ' (partial)' : incomplete === 'unmeasured' ? ' (text only)' : '';

  if (state.kind === 'transcript') {
    lines.push(`Tokenized transcript: ${formatTokens(state.tokens)} tokens (supplied text; tokenizer: ${state.tokenizer})`);
  } else {
    lines.push(`Estimated accessible text: ${formatTokens(state.tokens)} tokens${suffix}`);
  }
  lines.push(limitLine, modelText);
  lines.push(`${bar(usage, style)} ${pct} of planning limit${suffix}`, '');

  const flags = { compacted: state.compacted, unmeasured: state.unmeasured, source: state.limit.source, modelState };
  const risk = planningRisk(usage, flags, t);
  if (risk.level === 'UNKNOWN') {
    lines.push(`Planning risk: UNKNOWN (${risk.reasons.join('; ')})`, 'Recommendation:');
    lines.push(incompleteRecommendation(usage, { ...flags, info, staleModel: state.limit.staleModel }, t));
  } else {
    lines.push(`Planning risk: ${risk.level}`, 'Recommendation:', RECOMMENDATIONS[risk.level]);
  }

  if (incomplete) return finish(NOTES[incomplete]);
  if (state.kind === 'transcript') return finish(transcriptNote(state.tokenizer));
  // Against the baseline the share is only a labeled comparison, so it never
  // gets the over-limit note.
  if (state.limit.source === 'baseline') return finish(NOTES.baseline);
  if (usage >= 100) return finish(NOTES.over);
  return finish(state.limit.source === 'documented' ? NOTES.documented : NOTES.budget);
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_THRESHOLDS,
  DOCUMENTED_SOURCE,
  DOCUMENTED_MODEL_DEFAULTS,
  MODEL_REGISTRY,
  REGISTRY_CHECKED,
  REGISTRY_FRESHNESS_DAYS,
  HELP_WORK_URL,
  LEARN_MODELS_URL,
  OFFICIAL_HOSTS,
  WORK_SCOPES,
  EFFORT_WORDS,
  staleNote,
  lookupNote,
  findRegistryEntry,
  resolveModelInput,
  cleanModelValue,
  canon,
  describeModel,
  modelLine,
  isStale,
  daysBetween,
  needsFreshnessLookup,
  acceptLiveResult,
  BAR_WIDTH,
  BAR_STYLES,
  LIMIT_LABELS,
  RECOMMENDATIONS,
  INCOMPLETE_BASE,
  INCOMPLETE_SUFFIX,
  MODEL_RECOMMENDATIONS,
  MODEL_REASONS,
  NOTES,
  transcriptNote,
  isValidLimit,
  normalizeModelId,
  parseInvocation,
  resolveModel,
  resolveLimit,
  usagePercent,
  classify,
  planningRisk,
  formatTokens,
  formatLimit,
  formatPercent,
  barFill,
  bar,
  incompleteRecommendation,
  render,
};
