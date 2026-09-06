// One ceiling, shared by everything that accumulates.
//
// Several scenes keep collections of their own -- falling drops, flow-field
// trails, spiral seeds, skyline bars -- and each used to carry a hard-coded
// limit of a few hundred. That made the renderer's own limit a lie: raising it
// governed the marks and nothing else, and a burst of data could still put far
// more on screen than the machine could draw.
//
// Every such collection now sizes itself against the same budget, so one
// setting genuinely bounds the work. The factors differ because the scenes do:
// a trail costs sixty line segments, a spiral seed costs one small disc.

/**
 * @param {object} api    the scene surface, carrying `budget`
 * @param {number} factor this collection's share of it
 * @returns {number} at least 40, so a small budget never empties a scene
 */
export function cap(api, factor = 1) {
  const budget = Number(api && api.budget) || 800;
  return Math.max(40, Math.round(budget * factor));
}
