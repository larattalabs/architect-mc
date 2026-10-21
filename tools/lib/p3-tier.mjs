// (P3, docs/FAST-CHECKS.md "Cutover") What an in-game driver runs of the groups the water and survival ledger lints took over.
// GATE_P3=smoke (the slice tier's `<step>-smoke` ids, tools/gate-chains.json): the SMOKE remainder, one instance per kind and short stands;
// every group the lints cover leaves, each named in a `P3 smoke:` log line (neither ok nor FAIL). Unset (the full ids: the release tier,
// a named chain, a step run by hand): everything, as before. GATE_P3=probe: the release tier's calibration probes only (tools/p3-probe.mjs).
export const P3 = process.env.GATE_P3 === 'smoke' ? 'smoke' : process.env.GATE_P3 === 'probe' ? 'probe' : 'full';
export const smoke = P3 === 'smoke';
export const probe = P3 === 'probe';

/** A stand's length: the full 2 minutes, or 30 s at smoke (the physics is the census's: no fluid tick scheduled; the stand guards slow ticks). */
export function standMs(full = 120_000) {
  return smoke ? Math.min(full, 30_000) : full;
}

/** A line naming what smoke left out and which rule or probe covers it (neither `ok` nor `FAIL`: the runner counts neither). */
export function skipped(log, what, by) {
  log(`  P3 smoke: ${what} left to ${by} (the full step runs it at release)`);
}
