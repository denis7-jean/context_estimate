'use strict';
// Shared helpers for policy tests (not a test file; the glob skips it).

const p = require('../src/policy');

// Resolves the planning limit for an invoking message the way the skill does.
const limitFor = (message, saved = 'none', runtime, extra) => p.resolveLimit(p.parseInvocation(message), saved, runtime, extra);

const BASELINE = limitFor('/contextestimate'); // 128k conservative baseline, model window unknown
const SOL = limitFor('/contextestimate model=gpt-6.1-sol'); // documented Work default, 500k
const budget = (n) => limitFor(`/contextestimate limit=${n}`); // user override

const renderFor = (tokens, limit, extra = {}) => p.render({ kind: 'estimate', tokens, limit, ...extra });
const lineOf = (out, re) => out.split('\n').find((l) => re.test(l));

// The reference report for a behavioral scenario: what the skill should print
// for that scenario's visible transcript, using the scenario's own invocation.
function referenceReport(scenario, extra = {}) {
  const inv = p.parseInvocation(scenario.messages.at(-1).text.split(' — ')[0]);
  const incomplete = scenario.expect.incomplete;
  return p.render({
    kind: 'estimate',
    tokens: scenario.truthTokens,
    limit: p.resolveLimit(inv, 'none'),
    compacted: incomplete === 'partial' || incomplete === 'both',
    unmeasured: incomplete === 'unmeasured' || incomplete === 'both',
    invalidLimitRaw: inv.override.status === 'invalid' ? inv.override.raw : undefined,
    conflictingModel: inv.model.status === 'conflicting',
    barStyle: inv.barStyle,
    lookup: scenario.lookup,
    ...extra,
  });
}

module.exports = { p, limitFor, BASELINE, SOL, budget, renderFor, lineOf, referenceReport };
