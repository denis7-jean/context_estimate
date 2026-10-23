'use strict';
// Synthetic stand-in for a real ChatGPT Work smoke test: a four-message
// greeting exchange across a model switch, then /contextestimate run on each
// model. Only visible conversation text belongs in the transcript. The
// non-countable material below is listed so tests can show it is excluded
// (the skill's rules say never to count it); its text is invented except the
// skill text, which is the shipped SKILL.md.
//
// This is a sizing sanity fixture. It is not ground truth for any live
// estimate and says nothing about backend context usage.

const fs = require('node:fs');
const path = require('node:path');
const { estimateMessages } = require('../src/heuristic');
const { parseInvocation, resolveLimit, render } = require('../src/policy');

const GREETING = [
  { role: 'user', text: 'hi' },
  { role: 'assistant', text: 'Hi! What would you like to work on?' },
  { role: 'user', text: 'Hello World' },
  { role: 'assistant', text: 'Hello, world! 👋' },
];

// Which model was selected for each user message (picker state, not text).
const SELECTED_MODELS = ['GPT-6 Luna Medium', null, 'GPT-6.1 Sol Medium', null];

const NON_COUNTABLE = {
  systemPrompt: 'You are ChatGPT Work, an agent for multi-step tasks. Follow the platform policies. '.repeat(40),
  developerInstructions: 'Always format answers in Markdown. Prefer concise answers. Use the tools provided. '.repeat(40),
  memory: 'The user likes concise answers and works in a monorepo with a deployment pipeline. '.repeat(30),
  hiddenReasoning: 'The user greeted me twice; respond briefly and warmly. '.repeat(20),
  toolDefinitions: '{"name":"browser.search","description":"Search the web","parameters":{"query":"string"}}'.repeat(40),
  skillText: fs.readFileSync(path.join(__dirname, '..', '..', 'skill', 'contextestimate', 'SKILL.md'), 'utf8'),
};

const INVOKE_SOL = '/contextestimate model=gpt-6.1-sol';
const INVOKE_LUNA = '/contextestimate model=gpt-6-luna';

// Visible transcript when the first /contextestimate runs on Sol.
function transcriptForFirstRun() {
  return [...GREETING, { role: 'user', text: INVOKE_SOL }];
}

// The first report as it appears in the transcript (modelled with the reference renderer).
function firstReport() {
  const messages = transcriptForFirstRun();
  const limit = resolveLimit(parseInvocation(INVOKE_SOL), 'none');
  return render({ kind: 'estimate', tokens: estimateMessages(messages), limit });
}

// Visible transcript when /contextestimate is then run on Luna: the greeting,
// the first invocation, the first report, and the second invocation.
function transcriptForSecondRun() {
  return [...transcriptForFirstRun(), { role: 'assistant', text: firstReport() }, { role: 'user', text: INVOKE_LUNA }];
}

module.exports = { GREETING, SELECTED_MODELS, NON_COUNTABLE, INVOKE_SOL, INVOKE_LUNA, transcriptForFirstRun, firstReport, transcriptForSecondRun };
