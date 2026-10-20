// (6c HY) A course's profile (docs/CONTRACT.md "Phase 6c slice HY" §7.2, §1.2, §15): along a routed path, each index's water level (the
// router's: the running minimum of (ground - 1), held over a dip by `fill`), cut into reaches of at least `minReach` cells (shorter runs
// merged into the run below them: cut deeper), each drop between two reaches a step: a spillway (a drop of 1), a fall (2 up to `drop`;
// more becomes several falls with a reach of at least 3 between them), or, under `flow: 'riffles'`, a riffle (a stepped bed of at most 3
// drops and 16 cells) where its cap and the path allow. Slice HY-b owns this file (with the router in course.mjs). Pure, integer,
// deterministic: no random number, no Map or Set iteration order.
//
//   profileOf(cols, opts) -> {levels, reaches: [{k, i0, i1, level}], steps: [{kind, k, i0, i1, drop, seg, levels: [y per index]}], cut} |
//                            {refused: {code, message, evidence}}
//     cols: [{g (the lowest ground of the index's lanes and banks), top (the highest ground of its lanes), level (the router's),
//             straight (the path keeps its direction through the index and its neighbours)}], head first
//     opts: {minReach = 4, drop = 6, flow = 'pools' | 'level' | 'riffles', riffle = 4, cut = 6}
//   A step's cells are the last indices of its upper reach (i0..i1): a fall's or a spillway's lip is the reach's last index (the lip run,
//   one cell, its water at the upper level over a lined floor); a riffle's are its last `drop x seg` indices, segment s at the upper level
//   minus s. The lower reach starts at the next index, so a fall's column stands over the lower reach's first row.

export const PROFILE = Object.freeze({ minReach: 4, drop: 6, riffle: 4, cut: 6, riffleCells: 16, riffleDrops: 3, between: 3 });

/** Runs of equal level: [{i0, i1, level}]. */
function runsOf(levels) {
  const out = [];
  for (let i = 0; i < levels.length; i++) {
    const last = out[out.length - 1];
    if (last && last.level === levels[i]) last.i1 = i;
    else out.push({ i0: i, i1: i, level: levels[i] });
  }
  return out;
}

/** The profile of a path (see the header). */
export function profileOf(cols, opts = {}) {
  const minReach = opts.minReach ?? PROFILE.minReach, maxDrop = opts.drop ?? PROFILE.drop, cutMax = opts.cut ?? PROFILE.cut;
  const flow = opts.flow ?? 'pools', seg0 = opts.riffle ?? PROFILE.riffle, rCells = opts.riffleCells ?? PROFILE.riffleCells;
  const n = cols.length;
  if (!n) return { refused: { code: 'UNREACHABLE', message: 'the course has no cells', evidence: { kind: 'length' } } };
  const levels = cols.map((c) => c.level);
  for (let i = 1; i < n; i++) if (levels[i] > levels[i - 1]) return { refused: { code: 'UNREACHABLE', message: `the level rises at index ${i} (a course never runs uphill)`, evidence: { kind: 'uphill', at: i } } };
  if (flow === 'level') {
    // one reach: the lowest level of the path everywhere
    const lv = Math.min(...levels);
    for (let i = 0; i < n; i++) levels[i] = lv;
  } else {
    // merge runs shorter than minReach into the run below them (a short last run takes the run above it down with it)
    for (let guard = 0; guard < 4 * n; guard++) {
      const runs = runsOf(levels);
      if (runs.length < 2) break;
      const k = runs.findIndex((r) => r.i1 - r.i0 + 1 < minReach);
      if (k < 0) break;
      const into = k < runs.length - 1 ? runs[k + 1].level : runs[k].level;
      const from = k < runs.length - 1 ? runs[k] : runs[k - 1];
      const to = k < runs.length - 1 ? runs[k] : runs[k];
      for (let i = from.i0; i <= to.i1; i++) levels[i] = Math.min(levels[i], into);
    }
    // a drop past `drop`: the upper run's tail (a reach of `between` cells and its lip) stands `drop` lower, again until every drop fits
    for (let guard = 0; guard < 4 * n; guard++) {
      const runs = runsOf(levels);
      let fixed = false;
      for (let k = 0; k + 1 < runs.length; k++) {
        const D = runs[k].level - runs[k + 1].level;
        if (D <= maxDrop) continue;
        const take = PROFILE.between + 1;
        if (runs[k].i1 - runs[k].i0 + 1 < minReach + take) {
          return { refused: { code: 'UNREACHABLE', message: `a drop of ${D} at index ${runs[k + 1].i0} needs a reach of ${PROFILE.between} between falls of at most ${maxDrop}, and the reach above it is too short`, evidence: { kind: 'cut', at: runs[k + 1].i0, drop: D } } };
        }
        for (let i = runs[k].i1 - take + 1; i <= runs[k].i1; i++) levels[i] = runs[k].level - maxDrop;
        fixed = true;
        break;
      }
      if (!fixed) break;
    }
  }
  // a step needs a straight path through its lip and the lower reach's first rows: else the boundary moves upstream (cut deeper)
  for (let guard = 0; guard < 4 * n; guard++) {
    const runs = runsOf(levels);
    let moved = false;
    for (let k = 0; k + 1 < runs.length; k++) {
      const i = runs[k].i1;
      if (cols[i].straight) continue;
      // the nearest straight index upstream that keeps the run at least minReach long
      let j = i - 1;
      while (j >= runs[k].i0 + minReach - 1 && !cols[j].straight) j--;
      if (j < runs[k].i0 + minReach - 1) continue; // (no room: the step stays; the lay judges it)
      for (let q = j + 1; q <= i; q++) levels[q] = runs[k + 1].level;
      moved = true;
      break;
    }
    if (!moved) break;
  }
  // the cut: trench deeper than the sunk 1
  let cut = 0, cutAt = -1;
  for (let i = 0; i < n; i++) { const c = cols[i].top - 1 - levels[i]; if (c > cut) { cut = c; cutAt = i; } }
  if (cut > cutMax) return { refused: { code: 'UNREACHABLE', message: `the course cuts ${cut} under the ground at index ${cutAt} (cut at most ${cutMax})`, evidence: { kind: 'cut', at: cutAt, cut, limit: cutMax } } };
  const runs = runsOf(levels);
  const reaches = runs.map((r, k) => ({ k: k + 1, i0: r.i0, i1: r.i1, level: r.level }));
  const steps = [];
  for (let k = 0; k + 1 < reaches.length; k++) {
    const up = reaches[k], D = up.level - reaches[k + 1].level;
    const len = up.i1 - up.i0 + 1;
    // a riffle: D segments of `seg` cells (the last one spills 1 into the lower reach), at most 3 drops and 16 cells, the path straight
    if (flow === 'riffles' && D <= PROFILE.riffleDrops + 1) {
      const seg = Math.max(2, Math.min(seg0, Math.floor(rCells / D)));
      const cells = D * seg;
      const i0 = up.i1 - cells + 1;
      let ok = len - cells >= minReach - 1 && i0 > up.i0;
      for (let i = Math.max(1, i0 - 1); ok && i <= Math.min(n - 1, up.i1 + 1); i++) if (!cols[i].straight) ok = false;
      if (ok) {
        const lv = [];
        for (let i = i0; i <= up.i1; i++) lv.push(up.level - Math.floor((i - i0) / seg));
        steps.push({ kind: 'riffle', k: up.k, i0, i1: up.i1, drop: D, seg, levels: lv });
        continue;
      }
    }
    steps.push({ kind: D === 1 ? 'spillway' : 'fall', k: up.k, i0: up.i1, i1: up.i1, drop: D, seg: 1, levels: [up.level] });
  }
  return { levels, reaches, steps, cut };
}
