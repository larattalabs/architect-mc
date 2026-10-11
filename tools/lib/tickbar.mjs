// MSPT bars judge Architect's own per-tick time (coordinator decision from the 6b engine-chain investigation, 2026-10-10;
// docs/GATES.md "Tick bars"): the vanilla server tick and GC pauses vary with the box's load and are the same in versions that
// did not change, so they are recorded next to the result, not judged on their own. The machine's 1-minute load average is
// recorded with every result.
//
// The judged number (6b, accepted by the coordinator and verified in 6b's release check): dev.placement.stats ->
// placementCpuMsMax, the placement ticks (batches, group undo, jobs: all of Architect's end-of-tick work) in the server
// thread's CPU time, <= 50 ms. The placement ticks' wall time (placementMsMax), the whole tick (msptMax), the vanilla tick
// (serverMsptMax) and GC are recorded, not judged. A build without the CPU field (an old version) falls back to the wall time,
// one without that to the whole tick, and the line says which.
//
// dev.mspt.trace has no CPU figure (its writeMsMax is wall time) and no own-time percentile (slice 0a adds one), so a trace
// only adds recorded numbers (fromStatsAndTrace).

import os from 'node:os';

const r2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
const load1 = () => r2(os.loadavg()[0]);

/** From dev.placement.stats: { ownMaxMs, ownMeanMs, judged: 'cpu'|'wall'|'full tick', wallMaxMs, full: {...}, load1, fallback }. */
export function fromPlacementStats(st = {}) {
  const cpu = typeof st.placementCpuMsMax === 'number';
  const wall = typeof st.placementMsMax === 'number';
  const judged = cpu ? 'cpu' : wall ? 'wall' : 'full tick';
  return {
    ownMaxMs: r2(cpu ? st.placementCpuMsMax : wall ? st.placementMsMax : st.msptMax),
    ownMeanMs: r2(cpu ? st.placementCpuMsMean : wall ? st.placementMsMean : st.msptMean),
    judged,
    wallMaxMs: r2(st.placementMsMax),
    full: { msptMax: r2(st.msptMax), msptMean: r2(st.msptMean), ticksOver50ms: st.ticksOver50ms, serverMsptMax: r2(st.serverMsptMax) },
    load1: load1(),
    fallback: !cpu,
  };
}

/** dev.placement.stats judged, plus the recorded whole-tick percentiles of a dev.mspt.trace stop result over the same window. */
export function fromStatsAndTrace(st = {}, t = {}) {
  const o = fromPlacementStats(st);
  o.full = { ...o.full, p99: r2(t.all?.p99), over50: t.all?.over50, ticks: t.all?.ticks, traceMax: r2(t.all?.max), writeWallMaxMs: r2(t.writeMsMax) };
  return o;
}

/** The judged bar: Architect's own time in every tick <= limitMs (default 50: the old "no tick over 50 ms", Architect's share). */
export const ownOk = (o, limitMs = 50) => typeof o.ownMaxMs === 'number' && o.ownMaxMs <= limitMs;

/** The check line's text: the judged number, then the recorded ones. */
export function describe(o, limitMs = 50) {
  const f = o.full;
  const what = o.judged === 'cpu' ? 'CPU' : o.judged === 'wall' ? 'wall [no CPU field: wall time]' : '[no own-time field: the whole tick]';
  const p99 = f.p99 !== undefined ? `, whole-tick p99 ${f.p99} ms` : '';
  return `Architect's own tick max ${o.ownMaxMs} ms ${what} (<= ${limitMs}); recorded: its wall max ${o.wallMaxMs ?? '-'} ms, `
    + `whole tick max ${f.msptMax ?? f.traceMax ?? '-'} ms${p99}, vanilla max ${f.serverMsptMax ?? '-'} ms, ${f.ticksOver50ms ?? f.over50 ?? '-'} ticks over 50, load ${o.load1}`;
}

// (6c 0a, CONTRACT 0a §12) dev.mspt.trace now answers own-time percentiles: `own` (wall) and `ownCpu` (the server thread's CPU
// time, what Placement measures), each {ticks, p50, p99, max, mean} over the ticks with Architect work. When ownCpu is present it
// is the judged number (p99 and max); dev.placement.stats and the whole tick stay recorded. A build without it falls back to
// fromStatsAndTrace (max only), and the line says so.

/** dev.placement.stats + a dev.mspt.trace stop result: fromStatsAndTrace, judged on the trace's ownCpu when present. */
export function fromOwnTime(st = {}, t = {}) {
  const o = fromStatsAndTrace(st, t);
  const c = t.ownCpu;
  if (c && typeof c.max === 'number' && typeof c.p99 === 'number') {
    o.ownMaxMs = r2(c.max);
    o.ownMeanMs = r2(c.mean);
    o.ownP99Ms = r2(c.p99);
    o.ownP50Ms = r2(c.p50);
    o.ownTicks = c.ticks;
    o.judged = 'cpu';
    o.source = 'trace';
    o.fallback = false;
  }
  if (t.own && typeof t.own.max === 'number') o.ownWall = { p50: r2(t.own.p50), p99: r2(t.own.p99), max: r2(t.own.max), mean: r2(t.own.mean), ticks: t.own.ticks };
  return o;
}

/**
 * The own-time percentile bar: p99 <= p99LimitMs and max <= maxLimitMs (megaA: 25 and 50). Without a trace p99 (an old build) it
 * fails unless `allowNoP99`, which judges the max only.
 */
export const ownPctOk = (o, p99LimitMs = 25, maxLimitMs = 50, allowNoP99 = false) =>
  ownOk(o, maxLimitMs) && (typeof o.ownP99Ms === 'number' ? o.ownP99Ms <= p99LimitMs : allowNoP99);

/** The check line for ownPctOk: the judged p99 and max, then the recorded ones. */
export function describePct(o, p99LimitMs = 25, maxLimitMs = 50) {
  if (typeof o.ownP99Ms !== 'number') return `[no own-time percentiles in this build: p99 not judged] ${describe(o, maxLimitMs)}`;
  const w = o.ownWall;
  return `Architect's own tick CPU p99 ${o.ownP99Ms} ms (<= ${p99LimitMs}), max ${o.ownMaxMs} ms (<= ${maxLimitMs}) over ${o.ownTicks} ticks with work; `
    + `recorded: own wall p99 ${w?.p99 ?? '-'} ms, max ${w?.max ?? '-'} ms; ${describe(o, maxLimitMs).replace(/^.*?; recorded: /, '')}`;
}
