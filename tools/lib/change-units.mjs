// (GI2) The change tier's unit step (docs/GATES.md "Speed rules" 8): unit-scope (tools/unit-scope.mjs --run over the range's changed files)
// instead of the three full suites. An impact rule's unit-mod/unit-kit/unit-sidecar stands for it: unit-scope picks that suite's tests for
// the changed files, or the suite in full for shared core. A full suite joins a change run only for a selected step that waits for it
// (unit-mod's classes and XML, unit-kit's and unit-sidecar's JUnit reports); without it that step would take its slow path. The full
// suites stay in the slice and release tiers.

export const FULL_UNITS = ['unit-mod', 'unit-kit', 'unit-sidecar'];

/** want: Set of step ids; why: { id: [reason] }; steps: the chain config's steps; addW(id, reason). Mutates want/why. */
export function scopeChangeUnits({ want, why, steps, addW }) {
  for (const u of FULL_UNITS) {
    if (!want.has(u)) continue;
    want.delete(u);
    addW('unit-scope', `change: stands for ${(why[u] ?? []).join('; ')} -> ${u} (the full suite runs at slice and release)`);
    delete why[u];
  }
  for (const s of [...want]) for (const w of steps[s]?.waitFor ?? []) {
    if (FULL_UNITS.includes(w) && !want.has(w)) addW(w, `change: ${s} waits for it (its classes, XML or report)`);
  }
}

/**
 * (SPD, docs/SPEED-CUTS.md) The full unit steps this run runs, or has CACHED (a PASS at the same key): gate-run passes them to every step
 * as GATE_FULL_UNITS, and unit-scope skips its picks of those suites (a subset of the full run at the same head).
 */
export function fullUnitsInRun(stepIds, cachedHits = new Map()) {
  return FULL_UNITS.filter((u) => stepIds.includes(u) || cachedHits.has(u));
}
