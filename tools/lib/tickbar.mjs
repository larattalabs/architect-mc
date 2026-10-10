// MSPT bars judge Architect's own per-tick time (coordinator decision from the 6b engine-chain investigation, 2026-10-10;
// docs/GATES.md "Tick bars"): the vanilla server tick and GC pauses vary with the box's load and are the same in versions that
// did not change, so they are recorded next to the result, not judged on their own. The machine's 1-minute load average is
// recorded with every result.
//
// Architect's own time per tick:
//   dev.placement.stats -> placementMsMax / placementMsMean: Placement.tick (batches, group undo, jobs: all of Architect's
//                          end-of-tick work), per tick with work;
//   dev.mspt.trace      -> writeMsMax / writeMsMean: the same work, per traced tick.
// A client without those fields (an old version) falls back to the full tick, and the line says so.

import os from 'node:os';

const r2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
const load1 = () => r2(os.loadavg()[0]);

/** From dev.placement.stats: { ownMaxMs, ownMeanMs, full: {...}, load1, fallback }. */
export function fromPlacementStats(st = {}) {
  const has = typeof st.placementMsMax === 'number';
  return {
    ownMaxMs: r2(has ? st.placementMsMax : st.msptMax),
    ownMeanMs: r2(has ? st.placementMsMean : st.msptMean),
    full: { msptMax: r2(st.msptMax), msptMean: r2(st.msptMean), ticksOver50ms: st.ticksOver50ms, serverMsptMax: r2(st.serverMsptMax) },
    load1: load1(),
    fallback: !has,
  };
}

/** From dev.mspt.trace's stop result: { ownMaxMs, ownMeanMs, full: {...}, load1, fallback }. */
export function fromTrace(t = {}) {
  const has = typeof t.writeMsMax === 'number';
  return {
    ownMaxMs: r2(has ? t.writeMsMax : t.all?.max),
    ownMeanMs: r2(has ? t.writeMsMean : undefined),
    full: { max: r2(t.all?.max), p99: r2(t.all?.p99), over50: t.all?.over50, ticks: t.all?.ticks, withoutWritesMax: r2(t.withoutWrites?.max) },
    load1: load1(),
    fallback: !has,
  };
}

/** The judged bar: Architect's own time in every tick <= limitMs (default 50: the old "no tick over 50 ms", Architect's share). */
export const ownOk = (o, limitMs = 50) => typeof o.ownMaxMs === 'number' && o.ownMaxMs <= limitMs;

/** The check line's text: the judged number, then the recorded ones. */
export function describe(o, limitMs = 50) {
  const full = o.full.msptMax !== undefined
    ? `full tick max ${o.full.msptMax} ms, vanilla server max ${o.full.serverMsptMax ?? '-'} ms, ${o.full.ticksOver50ms ?? '-'} ticks over 50`
    : `full tick max ${o.full.max} ms, p99 ${o.full.p99} ms, ${o.full.over50 ?? '-'} over 50`;
  return `Architect's own tick time max ${o.ownMaxMs} ms (<= ${limitMs})${o.fallback ? ' [no own-time field: the full tick]' : ''}; recorded: ${full}, load ${o.load1}`;
}
