'use strict';
// Reference implementation of the deterministic parts of SKILL.md: invocation
// parsing, planning-limit and model-evidence resolution, planning-risk
// classification, display rounding, the progress bar, and the report layout.
// Used by the tests to pin down the documented policy; the skill does not
// execute this code inside ChatGPT.

// Conservative planning baseline used only when no budget and no documented
// model default applies. It is not a claim about any model's real window.
const DEFAULT_LIMIT = 128000;
const DEFAULT_THRESHOLDS = { medium: 50, high: 70, critical: 90 };

// Only limits OpenAI documents for the ChatGPT Work surface belong here.
// Do not add API model specifications or guesses.
const DOCUMENTED_SOURCE = {
  url: 'https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex',
  verified: '2026-10-23',
  wording: 'GPT-6.1 Sol has a default context window of 500,000 tokens in ChatGPT Work and Codex.',
};
const DOCUMENTED_MODEL_DEFAULTS = {
  'gpt-6.1-sol': { name: 'GPT-6.1 Sol', limit: 500000 },
};

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

// Used when planning risk is UNKNOWN for a known reason (partial history,
// unmeasured attachments, unknown model window). The base is escalated only by
// the counted share of the planning limit.
const INCOMPLETE_SUFFIX = {
  partial: 'earlier history is not counted',
  unmeasured: 'attachments or images are not counted',
  both: 'earlier history and attachments or images are not counted',
};
// An unknown model window is not, by itself, a reason to hand off. With the
// baseline as the only planning limit, the report says so neutrally.
const NEUTRAL_RECOMMENDATION =
  'A model-relative handoff assessment is unavailable. Provide model=MODEL_ID or limit=N for a planning comparison.';
const INCOMPLETE_BASE = {
  LOW: 'Consider /handoff before substantial work',
  MEDIUM: 'Consider /handoff before substantial work',
  HIGH: 'Run /handoff before starting another major task',
  CRITICAL: 'Run /handoff now before continuing substantial work',
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
const transcriptNote = (tokenizer) =>
  `Note: Counts the supplied text with ${tokenizer}; it may not match any Work model's tokenizer or the active context.`;

function isValidLimit(raw) {
  return typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(Number(raw));
}

// "GPT-6.1 Sol", "gpt-6.1_sol" -> "gpt-6.1-sol". Returns null if unusable.
function normalizeModelId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return /^[a-z0-9][a-z0-9.-]*$/.test(id) ? id : null;
}

// Parses a user message. Returns null when the message is not an invocation.
// Only the first line is read: options on later lines, or text elsewhere in
// the conversation, are never treated as arguments.
// Options: limit=N, model=MODEL_ID (user assertion of the selected Work
// model), bar=ascii (plain-text bar fallback).
function parseInvocation(message) {
  const m = /^\s*\/contextestimate(?=\s|$)([^\n]*)/.exec(message);
  if (!m) return null;
  const args = m[1];
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

  const models = opt('model');
  let model = { status: 'none' };
  if (models.length > 0) {
    const ids = [...new Set(models.map(normalizeModelId))];
    if (ids.length === 1 && ids[0]) model = { status: 'asserted', raw: models[0], id: ids[0] };
    else if (ids.length > 1) model = { status: 'conflicting', raw: models.join(' ') };
    // An empty or malformed single value is ignored: it is not model evidence.
  }
  return { override, barStyle, model };
}

// The only accepted evidence of the current model, re-evaluated per
// invocation: (1) trusted runtime metadata that identifies both the model and
// the Work surface, supplied by the platform for this invocation; (2) a model=
// assertion in the invoking message. Nothing else qualifies: not the
// assistant's self-identification, an earlier invocation, quoted or summarized
// content, the plan, the task type, or the tooling used to build this skill.
function resolveModel({ invocation, runtime } = {}) {
  if (runtime && runtime.surface === 'work') {
    const id = normalizeModelId(runtime.id);
    if (id) return { id, source: 'runtime' };
  }
  if (invocation && invocation.model && invocation.model.status === 'asserted') {
    return { id: invocation.model.id, source: 'user' };
  }
  return null;
}

// Planning-limit precedence: valid limit=N; valid saved_limit; documented Work
// default for the currently evidenced model; conservative baseline. `saved` is
// the `saved_limit` value from the skill configuration ("none" or digits).
// Derived limits are never written back to saved_limit.
function resolveLimit(invocation, saved, runtime) {
  const override = invocation && invocation.override;
  if (override && override.status === 'valid') {
    return { value: override.value, source: 'override', label: LIMIT_LABELS.override };
  }
  const savedStr = saved === undefined || saved === null ? 'none' : String(saved).trim();
  if (isValidLimit(savedStr)) return { value: Number(savedStr), source: 'saved', label: LIMIT_LABELS.saved };
  const model = resolveModel({ invocation, runtime });
  const documented = model && DOCUMENTED_MODEL_DEFAULTS[model.id];
  if (documented) {
    return {
      value: documented.limit,
      source: 'documented',
      label: `documented ${documented.name} / Work default`,
      model: model.id,
      modelSource: model.source,
    };
  }
  return { value: DEFAULT_LIMIT, source: 'baseline', label: LIMIT_LABELS.baseline };
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
// whenever coverage is incomplete or the only denominator is the baseline for
// an unknown model window. It is never a measure of backend context risk.
function planningRisk(usage, { compacted, unmeasured, source }, t = DEFAULT_THRESHOLDS) {
  const reasons = [];
  if (compacted) reasons.push('partial history');
  if (unmeasured) reasons.push('unmeasured attachments');
  if (source === 'baseline') reasons.push('model window unknown');
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

// Recommendation when planning risk is UNKNOWN.
// - Only the baseline (no missing history or attachments): neutral, no handoff advice.
// - Missing history or unmeasured attachments are explicit reasons to consider a
//   handoff. The base escalates with the counted share only for a known planning
//   limit (override, saved, documented); against the baseline the share is not a
//   reliable threshold comparison, so the base stays at "consider".
function incompleteRecommendation(usage, { compacted, unmeasured, source }, t = DEFAULT_THRESHOLDS) {
  if (!compacted && !unmeasured) return NEUTRAL_RECOMMENDATION;
  const base = source === 'baseline' ? INCOMPLETE_BASE.LOW : INCOMPLETE_BASE[classify(usage, t)];
  return `${base}; ${INCOMPLETE_SUFFIX[compacted ? (unmeasured ? 'both' : 'partial') : 'unmeasured']}.`;
}

// state: {
//   kind: 'estimate' | 'unavailable' | 'host' | 'transcript',
//   tokens, limit (from resolveLimit), unmeasured?, compacted?,
//   invalidLimitRaw?, conflictingModel?, tokenizer? (transcript kind),
//   hostLimit? (host kind), thresholds?, barStyle?
// }
function render(state) {
  const t = state.thresholds || DEFAULT_THRESHOLDS;
  const style = state.barStyle || 'unicode';
  const limitLine = `Planning limit: ${formatLimit(state.limit.value)} (${state.limit.label})`;
  const lines = ['Context Estimate'];
  const extraNotes = [];
  if (state.invalidLimitRaw !== undefined) extraNotes.push(`Note: Ignored invalid limit "${state.invalidLimitRaw}".`);
  if (state.conflictingModel) extraNotes.push(NOTES.conflictingModel);
  const finish = (primaryNote) => [...lines, '', primaryNote, ...extraNotes].join('\n');

  if (state.kind === 'unavailable') {
    lines.push('Estimated accessible text: Unavailable', limitLine, '');
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
  lines.push(limitLine);
  lines.push(`${bar(usage, style)} ${pct} of planning limit${suffix}`, '');

  const risk = planningRisk(usage, { compacted: state.compacted, unmeasured: state.unmeasured, source: state.limit.source }, t);
  if (risk.level === 'UNKNOWN') {
    lines.push(`Planning risk: UNKNOWN (${risk.reasons.join('; ')})`, 'Recommendation:');
    lines.push(incompleteRecommendation(usage, { compacted: state.compacted, unmeasured: state.unmeasured, source: state.limit.source }, t));
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
  BAR_WIDTH,
  BAR_STYLES,
  LIMIT_LABELS,
  RECOMMENDATIONS,
  INCOMPLETE_BASE,
  INCOMPLETE_SUFFIX,
  NEUTRAL_RECOMMENDATION,
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
