'use strict';
// Reference implementation of the visible-text heuristic documented in
// skill/contextestimate/references/estimation.md. The skill itself runs the
// same table by judgment inside ChatGPT; this file exists so the table can be
// checked against a real tokenizer. It only ever sees text passed to it.

// Rates must stay in sync with references/estimation.md (tests enforce this).
const RATES = {
  cjkTokensPerChar: 0.75,
  charsPerToken: {
    prose: 5.0, // English and other Latin-script prose
    code: 3.5, // source code, shell commands, diffs
    structured: 3.0, // JSON, YAML, CSV-like config, key/value data
    dense: 2.2, // logs, tables of numbers, IDs, hashes, URLs, base64
  },
  perMessageOverhead: 4,
};

// CJK ideographs, kana, hangul, and CJK/fullwidth punctuation.
const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/gu;

function countCjk(text) {
  return (text.match(CJK_RE) || []).length;
}

function classifyBlock(block) {
  const lines = block.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return 'prose';
  const nonCjk = block.replace(CJK_RE, '');
  const nonSpace = nonCjk.replace(/\s/g, '');
  if (nonSpace.length === 0) return 'prose';

  const digitsHex = (nonSpace.match(/[0-9]/g) || []).length;
  const symbols = (nonSpace.match(/[^A-Za-z0-9]/g) || []).length;
  const tableLines = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length;
  // CSV-like: several commas and almost no spaces (prose puts spaces after commas).
  const csvLines = lines.filter((l) => (l.match(/,/g) || []).length >= 3 && (l.match(/ /g) || []).length <= 2).length;
  const logLines = lines.filter((l) => /^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(l)).length;
  const urlOrHash = (
    nonCjk.match(/https?:\/\/\S+|\b[0-9a-f]{12,}\b|\b(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]{32,}={0,2}/g) || []
  ).join('').length;
  const trimmed = block.trim();
  const looksJson = /^[[{]/.test(trimmed) && /[\]}]$/.test(trimmed);

  if (tableLines >= lines.length * 0.6 || logLines >= lines.length * 0.5 || csvLines >= lines.length * 0.6) {
    return 'dense';
  }
  if (urlOrHash > nonSpace.length * 0.4) return 'dense';
  if (looksJson) return 'structured';
  if (digitsHex > nonSpace.length * 0.35) return 'dense';
  const kvLines = lines.filter((l) => /^\s*(-\s+)?"?[\w.-]+"?\s*:\s*\S?/.test(l)).length;
  if (kvLines >= lines.length * 0.6 && lines.length >= 3) return 'structured';

  const codeSignals = lines.filter((l) =>
    /[;{}]\s*$|=>|^\s*(def|class|import|from|export|function|const|let|var|return|if|for|while|async|await|@\w+)\b|^\s{2,}\S|\)\s*:\s*$/.test(l),
  ).length;
  if (codeSignals >= lines.length * 0.4 || symbols > nonSpace.length * 0.25) return 'code';
  return 'prose';
}

// Split on blank lines, but keep fenced code blocks intact.
function splitBlocks(text) {
  const blocks = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = fence.exec(text)) !== null) {
    blocks.push(...text.slice(last, m.index).split(/\n\s*\n/).map((b) => ({ text: b })));
    blocks.push({ text: m[1], forced: 'code' });
    last = fence.lastIndex;
  }
  blocks.push(...text.slice(last).split(/\n\s*\n/).map((b) => ({ text: b })));
  return blocks.filter((b) => b.text.trim() !== '');
}

function estimateText(text) {
  let total = 0;
  const breakdown = { cjk: 0, prose: 0, code: 0, structured: 0, dense: 0 };
  // Python-style code blocks are separated by blank lines; classify the whole
  // text as code first if it is overwhelmingly code, so lone `pass` lines or
  // docstrings do not get scored as prose.
  const wholeType = classifyBlock(text);
  for (const block of splitBlocks(text)) {
    const cjk = countCjk(block.text);
    const restChars = [...block.text.replace(CJK_RE, '')].length;
    let type = block.forced || classifyBlock(block.text);
    if (wholeType !== 'prose' && type === 'prose' && cjk === 0) type = wholeType;
    const cjkTokens = cjk * RATES.cjkTokensPerChar;
    const restTokens = restChars / RATES.charsPerToken[type];
    breakdown.cjk += cjkTokens;
    breakdown[type] += restTokens;
    total += cjkTokens + restTokens;
  }
  return { tokens: total, breakdown };
}

// messages: [{ role, text, thisInvocation? }]. Each message's text is estimated
// and a small per-message framing overhead is added. Tool calls and results
// produced by the current /contextestimate run (thisInvocation: true), such as
// an official-source search, are not part of the conversation being measured.
function estimateMessages(messages) {
  let total = 0;
  for (const msg of messages) {
    if (msg.thisInvocation) continue;
    total += estimateText(msg.text).tokens + RATES.perMessageOverhead;
  }
  return total;
}

module.exports = { RATES, classifyBlock, estimateText, estimateMessages, countCjk };
