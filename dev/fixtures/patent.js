'use strict';
// Synthetic stand-ins for the field report: a short chat in which the
// assistant printed several full versions of one long document, then printed
// "context optimization" text. The subject matter is invented; only the
// shape (few turns, long repeated drafts) matters.

const components = [
  ['thermal buffer layer', 'absorbs transient heat from adjacent cells and releases it gradually'],
  ['sensing module', 'samples cell temperature at a configurable interval and reports readings to the controller'],
  ['coolant manifold', 'distributes coolant across parallel channels according to a computed flow schedule'],
  ['controller', 'selects a flow schedule from a stored table based on a rolling average of the readings'],
  ['isolation frame', 'maintains a fixed spacing between cells and routes the coolant channels'],
  ['pressure relief path', 'vents gas away from the cells when an internal pressure threshold is exceeded'],
];

function description(version) {
  const paras = [];
  components.forEach(([name, role], i) => {
    paras.push(
      `The ${name} (reference numeral ${100 + i * 10}) ${role}. In one embodiment the ${name} is arranged so that its first surface faces the cell stack and its second surface faces the enclosure wall, and the dimensions of the ${name} are selected according to the energy density of the pack, the expected duty cycle, and the ambient operating range described with reference to FIG. ${i + 1}. In another embodiment, the ${name} is modular, so that two or more instances may be combined to cover a larger pack without changing the control method.`,
    );
    paras.push(
      `Referring to FIG. ${i + 1}, a method of operating the ${name} includes receiving a first signal, comparing the first signal with a stored threshold, and, responsive to the comparison, adjusting an output of the ${name} for a predetermined period. The predetermined period may be fixed, may depend on a rolling statistic, or may be chosen by a policy stored in the controller. Variations in which the order of the steps differs, or in which some steps are performed in parallel, fall within the scope of this disclosure.`,
    );
  });
  // Later versions add and reword material, so the drafts are similar but not identical.
  for (let v = 2; v <= version; v++) {
    paras.push(
      `Revision ${v} adds the following alternative: the controller may weight recent readings more heavily than older readings, using a decay constant of ${v * 3} seconds, so that the flow schedule responds faster to a rising trend while ignoring isolated outliers. Experimental results for configuration ${v} showed a peak temperature reduction of ${4 + v} percent relative to a baseline without the thermal buffer layer.`,
    );
  }
  return paras.join('\n\n');
}

function claims(version) {
  const out = [];
  for (let i = 1; i <= 10 + version; i++) {
    out.push(
      `${i}. A battery pack comprising: a plurality of cells; a thermal buffer layer disposed between adjacent cells; a sensing module configured to report a temperature of at least one of the cells; and a controller configured to select a coolant flow schedule based on the reported temperature, wherein the flow schedule of claim ${Math.max(1, i - 1)} is further adjusted according to element ${i} of the stored table.`,
    );
  }
  return out.join('\n');
}

function draft(version) {
  return `PATENT APPLICATION DRAFT — VERSION ${version}\n\nTITLE: Adaptive Thermal Buffering for Battery Packs\n\nDETAILED DESCRIPTION\n\n${description(version)}\n\nCLAIMS\n\n${claims(version)}`;
}

const contextOptimization = `Context optimization plan (printed in chat)
1. Keep one canonical draft and refer to it by version number instead of re-pasting it.
2. Move the claims into a separate working file and paste only changed claims.
3. Summarize accepted decisions in five bullets before asking for the next revision.
4. Start a fresh conversation when the canonical draft exceeds two revisions.
Decisions so far: thermal buffer layer retained; controller table retained; pressure relief path moved to a dependent claim.`;

module.exports = { draft, contextOptimization };
