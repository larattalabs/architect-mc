// (GR-b) Load-scaled step timeouts (docs/GATES.md "Kit suite once per run", "Load-scaled timeouts"). A unit suite's wall time
// grows with the machine's load: unit-kit, sized at 40 min for load p50 75, timed out at 40.5 min in r073's change run with the
// load at 60-145. For the steps listed in gate-chains.json `timeoutLoadScale.steps`, a wall minute spends only
// min(1, ref / load1) of the step's timeout budget (ref: rule 10's load-gate max1, at least 72), so a step on a machine at twice
// ref gets about twice the wall time; a hard wall cap of `maxFactor` x the budget (clamped to 1..2) keeps every timeout bounded.
// CPU time was the other option and was not taken: the steps' work runs in node --test children that exit (their CPU leaves the
// process group's live accounting), and unit-scope's Gradle work runs in a daemon outside the group, so `ps` over the group
// under-counts on macOS.
//
// (GRA) The ref is the machine's cores (`timeoutLoadScale.ref: "cores"`, tools/lib/cpu-budget.mjs machineCores, GATE_CPU_CORES
// overrides). Rule 10's 72 is when a run may START, not when a suite slows: at load 21-41 on 18 cores the CPU is already 1.2-2.3x
// oversubscribed, and v0.86.0's change gate (gate-runs/20261119-140508) killed a healthy unit-sidecar at 15m17s (mean load 36) with
// none of its budget stretched. A legacy config without `ref` keeps max(72, max1). The 2x wall cap is unchanged: a hang still ends.

export const MAX_FACTOR_CAP = 2;
export const REF_FLOOR = 72; // rule 10's max1 floor (tools/lib/turbo.mjs LOAD_BOUNDS.max1Min)

/**
 * The config for one step id (a split part <id>/p<k> takes its parent's), or null when the step is not load-scaled. The ref:
 * `timeoutLoadScale.ref` "cores" -> the machine's cores (at least 1), a number -> that number, absent -> max(REF_FLOOR, max1).
 */
export function loadScaleFor(cfg, id, { max1 = REF_FLOOR, cores = null } = {}) {
  const c = cfg?.timeoutLoadScale;
  if (!c || !Array.isArray(c.steps) || !c.steps.includes(String(id).split('/')[0])) return null;
  const f = Number(c.maxFactor ?? MAX_FACTOR_CAP);
  const maxFactor = Math.min(MAX_FACTOR_CAP, Math.max(1, Number.isFinite(f) ? f : MAX_FACTOR_CAP));
  if (c.ref === 'cores' && Number(cores) >= 1) return { ref: Number(cores), refSource: 'cores', maxFactor };
  if (typeof c.ref === 'number' && c.ref > 0) return { ref: Number(c.ref), refSource: 'config', maxFactor };
  return { ref: Math.max(REF_FLOOR, Number(max1) || 0), refSource: 'max1', maxFactor };
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

const r1 = (x) => Math.round(Number(x) * 10) / 10;
const dur = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

/**
 * (GRA) What the runner knew when it killed a step at its timeout, taken at the kill (not at exit): the wall time since the step
 * started, the limit and where it came from, the 1/5/15-min load then, and a load-scaled step's account (budget spent, mean load,
 * ref, wall cap). summary.json `timeout`; timeoutNote() is its one line in runner.log and SUMMARY.md.
 */
export function timeoutRecord({ startedMs, killedMs, limitMin, source = null, loadavg = [], loadScale = null }) {
  const [l1, l5, l15] = loadavg.map((x) => r1(x));
  return {
    elapsedSeconds: Math.round(Math.max(0, killedMs - startedMs) / 1000),
    limitMin,
    source,
    load: { load1: l1 ?? null, load5: l5 ?? null, load15: l15 ?? null },
    ...(loadScale ? { loadScaled: { usedMin: loadScale.usedMin, wallMin: loadScale.wallMin, capMin: loadScale.capMin, meanLoad: loadScale.meanLoad, ref: loadScale.ref, why: loadScale.why ?? null } } : {}),
  };
}

/** One line for a timeout record: elapsed, limit, the load at the kill; says it is a TIMEOUT kill, not a test failure. */
export function timeoutNote(t) {
  if (!t) return '';
  const ld = t.load ?? {};
  const ls = t.loadScaled;
  return `killed at its timeout after ${dur(t.elapsedSeconds)} wall (limit ${t.limitMin} min${t.source ? `, ${t.source}` : ''}); `
    + `load at the kill ${ld.load1 ?? '?'} / ${ld.load5 ?? '?'} / ${ld.load15 ?? '?'} (1/5/15 min)`
    + (ls ? `; load-scaled: ${ls.usedMin} of ${t.limitMin} budget min spent, mean load ${ls.meanLoad ?? '?'}, ref ${ls.ref}, wall cap ${ls.capMin} min` : '')
    + '; a TIMEOUT, not a test FAIL';
}
