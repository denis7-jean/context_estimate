'use strict';
// Shared helpers for policy tests (not a test file; the glob skips it).

const p = require('../src/policy');

// Resolves the planning limit for an invoking message the way the skill does.
const limitFor = (message, saved = 'none', runtime) => p.resolveLimit(p.parseInvocation(message), saved, runtime);

const BASELINE = limitFor('/contextestimate'); // 128k conservative baseline, model window unknown
const SOL = limitFor('/contextestimate model=gpt-6.1-sol'); // documented Work default, 500k
const budget = (n) => limitFor(`/contextestimate limit=${n}`); // user override

const renderFor = (tokens, limit, extra = {}) => p.render({ kind: 'estimate', tokens, limit, ...extra });
const lineOf = (out, re) => out.split('\n').find((l) => re.test(l));

module.exports = { p, limitFor, BASELINE, SOL, budget, renderFor, lineOf };
