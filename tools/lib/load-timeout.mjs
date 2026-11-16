// (GR-b) Load-scaled step timeouts (docs/GATES.md "Kit suite once per run", "Load-scaled timeouts"). A unit suite's wall time
// grows with the machine's load: unit-kit, sized at 40 min for load p50 75, timed out at 40.5 min in r073's change run with the
// load at 60-145. For the steps listed in gate-chains.json `timeoutLoadScale.steps`, a wall minute spends only
// min(1, ref / load1) of the step's timeout budget (ref: rule 10's load-gate max1, at least 72), so a step on a machine at twice
// ref gets about twice the wall time; a hard wall cap of `maxFactor` x the budget (clamped to 1..2) keeps every timeout bounded.
// CPU time was the other option and was not taken: the steps' work runs in node --test children that exit (their CPU leaves the
// process group's live accounting), and unit-scope's Gradle work runs in a daemon outside the group, so `ps` over the group
// under-counts on macOS.

export const MAX_FACTOR_CAP = 2;
export const REF_FLOOR = 72; // rule 10's max1 floor (tools/lib/turbo.mjs LOAD_BOUNDS.max1Min)

/** The config for one step id (a split part <id>/p<k> takes its parent's), or null when the step is not load-scaled. */
export function loadScaleFor(cfg, id, { max1 = REF_FLOOR } = {}) {
  const c = cfg?.timeoutLoadScale;
  if (!c || !Array.isArray(c.steps) || !c.steps.includes(String(id).split('/')[0])) return null;
  const f = Number(c.maxFactor ?? MAX_FACTOR_CAP);
  return { ref: Math.max(REF_FLOOR, Number(max1) || 0), maxFactor: Math.min(MAX_FACTOR_CAP, Math.max(1, Number.isFinite(f) ? f : MAX_FACTOR_CAP)) };
}

/**
 * samples: [{ t: ms, load1 }] in time order, the first at the step's start. Each interval spends its wall minutes times
 * min(1, ref / its mean load). -> { expired, usedMin, wallMin, capMin, meanLoad, why }; expired once the spent budget reaches
 * budgetMin, or the wall time reaches capMin (budgetMin x maxFactor).
 */
export function loadScaledBudget({ budgetMin, samples, ref = REF_FLOOR, maxFactor = MAX_FACTOR_CAP }) {
  const capMin = budgetMin * Math.min(MAX_FACTOR_CAP, Math.max(1, maxFactor));
  let used = 0;
  let loadMin = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = Math.max(0, samples[i].t - samples[i - 1].t) / 60_000;
    const l = (Number(samples[i].load1) + Number(samples[i - 1].load1)) / 2 || 0;
    used += dt * (l > ref ? ref / l : 1);
    loadMin += dt * l;
  }
  const wallMin = samples.length > 1 ? Math.max(0, samples.at(-1).t - samples[0].t) / 60_000 : 0;
  const r1 = (x) => Math.round(x * 10) / 10;
  const meanLoad = wallMin > 0 ? r1(loadMin / wallMin) : null;
  const byBudget = used >= budgetMin - 1e-9;
  const byCap = wallMin >= capMin;
  const why = byBudget
    ? `load-scaled budget ${budgetMin} min spent in ${r1(wallMin)} wall min (mean load ${meanLoad}, ref ${ref})`
    : byCap ? `load-scaled wall cap ${r1(capMin)} min (${maxFactor} x ${budgetMin}; ${r1(used)} min of budget spent, mean load ${meanLoad}, ref ${ref})` : null;
  return { expired: byBudget || byCap, usedMin: r1(used), wallMin: r1(wallMin), capMin: r1(capMin), meanLoad, ref, why };
}
