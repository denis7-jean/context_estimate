'use strict';
// Prints heuristic vs. o200k_base (and cl100k_base) counts for every fixture.
//   node src/calibrate.js

const { encode: o200k } = require('gpt-tokenizer/encoding/o200k_base');
const { encode: cl100k } = require('gpt-tokenizer/encoding/cl100k_base');
const h = require('./heuristic');

const pct = (est, act) => `${(((est - act) / act) * 100).toFixed(1)}%`.padStart(7);
let sumAct = 0;
let sumEst = 0;
let sumChars = 0;
console.log('set       fixture           chars  o200k cl100k  heur  err(heur)  err(chars/4)  type');
for (const set of ['texts', 'heldout']) {
  for (const [name, text] of Object.entries(require(`../fixtures/${set}`))) {
    const chars = [...text].length;
    const act = o200k(text).length;
    const est = h.estimateText(text);
    sumAct += act;
    sumEst += est.tokens;
    sumChars += chars;
    const types = Object.entries(est.breakdown)
      .filter(([, v]) => v > 0)
      .map(([t]) => t)
      .join('+');
    console.log(
      `${(set === 'texts' ? 'calib' : 'heldout').padEnd(9)} ${name.padEnd(16)} ${String(chars).padStart(6)} ${String(act).padStart(6)} ${String(cl100k(text).length).padStart(6)} ${String(Math.round(est.tokens)).padStart(5)}  ${pct(est.tokens, act)}    ${pct(chars / 4, act)}      ${types}`,
    );
  }
}
console.log(`\nall fixtures: o200k ${sumAct}, heuristic ${Math.round(sumEst)} (${pct(sumEst, sumAct).trim()}), chars/4 ${Math.round(sumChars / 4)} (${pct(sumChars / 4, sumAct).trim()})`);
