'use strict';
// Reference implementation of the deterministic parts of SKILL.md: limit
// parsing and precedence, risk classification, display rounding, the progress
// bar, and the report layout. Used by the tests to pin down the documented
// policy; the skill does not execute this code inside ChatGPT.

const DEFAULT_LIMIT = 128000;
const DEFAULT_THRESHOLDS = { medium: 50, high: 70, critical: 90 };

const BAR_WIDTH = 20; // 5% per block
const BAR_STYLES = {
  unicode: { fill: '█', empty: '░' },
  ascii: { fill: '#', empty: '.' },
};

const RECOMMENDATIONS = {
  LOW: 'Continue normally.',
  MEDIUM: 'Continue, but plan a /handoff before a long task.',
  HIGH: 'Run /handoff before starting another major task.',
  CRITICAL: 'Run /handoff now before continuing substantial work.',
  UNKNOWN: 'If this chat feels long, consider /handoff before substantial work.',
};

// Used when coverage is incomplete (summarized/truncated history or unmeasured
// attachments). The base wording is escalated only by the counted share.
const INCOMPLETE_SUFFIX = {
  partial: 'earlier history is not counted.',
  unmeasured: 'attachments or images are not counted.',
  both: 'earlier history and attachments or images are not counted.',
};
const INCOMPLETE_BASE = {
  LOW: 'Consider /handoff before substantial work',
  MEDIUM: 'Consider /handoff before substantial work',
  HIGH: 'Run /handoff before starting another major task',
  CRITICAL: 'Run /handoff now before continuing substantial work',
};

const NOTES = {
  estimate: 'Note: Visible-text estimate; actual context usage may differ.',
  partial: 'Note: Counts accessible text only; earlier history is summarized or truncated, so actual usage may be higher or lower.',
  unmeasured: 'Note: Attachments or images were not counted, so actual usage may differ.',
  both: 'Note: Counts accessible text only; earlier history is summarized or truncated and attachments or images were not counted, so actual usage may be higher or lower.',
  unavailable: 'Note: Conversation content could not be measured.',
  host: 'Note: Host-reported measurement.',
  transcript: 'Note: Measures the supplied transcript only; actual context usage may differ.',
};

function isValidLimit(raw) {
  return typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(Number(raw));
}

// Parses a user message. Returns null when the message is not an invocation.
// Supported options: limit=N and bar=ascii (plain-text bar fallback).
function parseInvocation(message) {
  const m = /^\s*\/contextestimate(?=\s|$)(.*)$/s.exec(message);
  if (!m) return null;
  const raws = [...m[1].matchAll(/(?:^|\s)limit=(\S*)/g)].map((x) => x[1]);
  const bars = [...m[1].matchAll(/(?:^|\s)bar=(\S*)/g)].map((x) => x[1]);
  const barStyle = bars.length > 0 && bars.every((b) => b === 'ascii') ? 'ascii' : 'unicode';
  if (raws.length === 0) return { override: { status: 'none' }, barStyle };
  const distinct = [...new Set(raws)];
  if (distinct.length === 1 && isValidLimit(distinct[0])) {
    return { override: { status: 'valid', value: Number(distinct[0]), raw: distinct[0] }, barStyle };
  }
  return { override: { status: 'invalid', raw: raws.join(' ') }, barStyle };
}

// saved: the `saved_limit` value from the skill configuration ("none" or digits).
function resolveLimit(override, saved) {
  if (override && override.status === 'valid') {
    return { value: override.value, label: 'user-configured', source: 'override' };
  }
  const savedStr = saved === undefined || saved === null ? 'none' : String(saved).trim();
  if (isValidLimit(savedStr)) {
    return { value: Number(savedStr), label: 'user-configured', source: 'saved' };
  }
  return { value: DEFAULT_LIMIT, label: 'assumed', source: 'default' };
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

function incompleteRecommendation(usage, kind, t) {
  return `${INCOMPLETE_BASE[classify(usage, t)]}; ${INCOMPLETE_SUFFIX[kind]}`;
}

// state: {
//   kind: 'estimate' | 'unavailable' | 'host' | 'transcript',
//   tokens, limit: {value,label}, unmeasured?, compacted?, invalidLimitRaw?,
//   hostLimit? (host kind only), thresholds?, barStyle?
// }
function render(state) {
  const t = state.thresholds || DEFAULT_THRESHOLDS;
  const style = state.barStyle || 'unicode';
  const limitLine = (l) => `Configured context limit: ${formatLimit(l.value)} (${l.label})`;
  const lines = ['Context Estimate'];
  const extraNotes = [];
  if (state.invalidLimitRaw !== undefined) extraNotes.push(`Note: Ignored invalid limit "${state.invalidLimitRaw}".`);
  const finish = (primaryNote) => [...lines, '', primaryNote, ...extraNotes].join('\n');

  if (state.kind === 'unavailable') {
    lines.push('Estimated visible context: Unavailable', limitLine(state.limit), 'Estimated usage: Unavailable', '');
    lines.push('Risk: UNKNOWN', 'Recommendation:', RECOMMENDATIONS.UNKNOWN);
    return finish(NOTES.unavailable);
  }

  if (state.kind === 'host') {
    const limit = state.hostLimit || state.limit.value;
    const usage = usagePercent(state.tokens, limit);
    const risk = classify(usage, t);
    lines.push(`Measured context: ${state.tokens.toLocaleString('en-US')} tokens (host-reported)`);
    lines.push(state.hostLimit ? `Context limit: ${formatLimit(state.hostLimit)} (host-reported)` : limitLine(state.limit));
    lines.push(`Usage: ${formatPercent(usage)}`);
    lines.push(`${bar(usage, style)} ${formatPercent(usage)} of context limit (host-reported)`, '');
    lines.push(`Risk: ${risk}`, 'Recommendation:', RECOMMENDATIONS[risk]);
    return finish(NOTES.host);
  }

  const usage = usagePercent(state.tokens, state.limit.value);
  const pct = formatPercent(usage);
  const incomplete = state.compacted ? (state.unmeasured ? 'both' : 'partial') : state.unmeasured ? 'unmeasured' : null;
  const barSuffix = incomplete === 'partial' || incomplete === 'both' ? ' (partial)' : incomplete === 'unmeasured' ? ' (text only)' : '';

  if (state.kind === 'transcript') {
    lines.push(`Tokenized transcript: ${formatTokens(state.tokens)} tokens (supplied text)`);
  } else {
    lines.push(`Estimated visible context: ${formatTokens(state.tokens)} tokens${barSuffix}`);
  }
  lines.push(limitLine(state.limit));
  lines.push(`Estimated usage: ${pct}${incomplete ? ' (counted text only)' : ''}`);
  const supplied = state.kind === 'transcript' ? ' (supplied text)' : '';
  lines.push(`${bar(usage, style)} ${pct} of planning limit${barSuffix}${supplied}`, '');

  if (incomplete) {
    const label = { partial: 'partial history', unmeasured: 'unmeasured attachments', both: 'partial history; unmeasured attachments' }[incomplete];
    lines.push(`Risk: UNKNOWN (${label})`, 'Recommendation:', incompleteRecommendation(usage, incomplete, t));
    return finish(NOTES[incomplete]);
  }
  const risk = classify(usage, t);
  lines.push(`Risk: ${risk}`, 'Recommendation:', RECOMMENDATIONS[risk]);
  return finish(state.kind === 'transcript' ? NOTES.transcript : NOTES.estimate);
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_THRESHOLDS,
  BAR_WIDTH,
  BAR_STYLES,
  RECOMMENDATIONS,
  INCOMPLETE_BASE,
  INCOMPLETE_SUFFIX,
  NOTES,
  isValidLimit,
  parseInvocation,
  resolveLimit,
  usagePercent,
  classify,
  formatTokens,
  formatLimit,
  formatPercent,
  barFill,
  bar,
  incompleteRecommendation,
  render,
};
