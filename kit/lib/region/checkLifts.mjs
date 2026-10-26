// (7a LF) The lift rules of the checker (docs/CONTRACT.md "Phase 7a slice LF" §5): for every lift the plan meta records (`meta.lifts`,
// written by lib/connectors/liftGeom.mjs writeLift), read from the world's blocks (the virtual world at plan time, a realised dump world in
// the gate):
//   M10:lift  the base under each shaft (soul sand under an up column, magma under a down one); every shaft cell a bubble column of its
//             drag; the shell 2 thick on every open side at every y the water stands (a fluid-stopping cell, then a second one or the other
//             shaft's water across the shared layer), the face side 2 thick; both airlock doors (lower and upper halves); the rails round
//             the shaft's top on its three open sides; 3 clear over the top; no shaft cell at block light 0 (the light every 6: drowned)
//   M5:lift   no dark (block light 0) spawnable walk cell at the foot (the approaches) or the top (the top walk cells)
// Per lift `metrics.lifts.per`. Warnings. Called by checkRegion (check.mjs); leaves `vw` as it found it.
import { liftLanes } from '../connectors/liftGeom.mjs';

const nameOf = (s) => String(s ?? '').replace(/\[.*$/, '');

/** The lift rules: findings `M10:lift`, `M5:lift` and `metrics.lifts`. `light`: blockLight(vw) (lazy). */
export function liftRules({ vw, lifts, want, findings, metrics, finding, light }) {
  const P = vw.pal, per = [];
  let L = null;
  const st = (x, y, z) => P.states[vw.get(x, y, z)] ?? 'minecraft:air';
  for (const m of lifts) {
    const [ax, y0, az] = m.foot, [dx, dz] = m.dir, [rx, rz] = [-dz, dx], yT = m.yT;
    const at = (t, v) => [ax + dx * t + rx * v, az + dz * t + rz * v];
    const lanes = liftLanes(!!m.down, m.side ?? 'right');
    const row = { id: m.id, part: m.part, rise: m.rise, down: !!m.down, base: 0, column: 0, columnBad: 0, shellBad: 0, doors: 0, doorBad: 0, rails: 0, railBad: 0, headBad: 0, darkShaft: 0, darkWalk: 0 };
    const bad10 = [], dark = [];
    const shaftV = new Set(lanes.shafts.map((s) => s.v));
    const fs = (x, y, z) => { const i = vw.get(x, y, z); return !!P.fs[i] && !P.air[i] && !P.water[i]; };
    for (const sh of lanes.shafts) {
      const [sx, sz] = at(3, sh.v);
      // the base and the column
      const want0 = sh.kind === 'up' ? 'minecraft:soul_sand' : 'minecraft:magma_block';
      if (nameOf(st(sx, y0, sz)) === want0) row.base++; else bad10.push([sx, y0, sz]);
      for (let y = y0 + 1; y <= yT - 1; y++) {
        row.column++;
        const s = st(sx, y, sz);
        const drag = /drag=false/.test(s) ? 'up' : 'down';
        if (nameOf(s) !== 'minecraft:bubble_column' || drag !== sh.kind) { row.columnBad++; bad10.push([sx, y, sz]); }
        // the shell, 2 thick on every side (the face's two cells behind, the shared layer then the other shaft's water)
        for (const [t1, v1, t2, v2] of [[2, sh.v, 1, sh.v], [3, sh.v - 1, 3, sh.v - 2], [3, sh.v + 1, 3, sh.v + 2], [4, sh.v, 5, sh.v]]) {
          const [x1, z1] = at(t1, v1), [x2, z2] = at(t2, v2);
          const second = fs(x2, y, z2) || (t2 === 3 && shaftV.has(v2) && P.water[vw.get(x2, y, z2)]);
          if (!fs(x1, y, z1) || !second) { row.shellBad++; bad10.push([x1, y, z1]); }
        }
        if (want.has('M10')) {
          L ??= light();
          if (L.at(sx, y, sz) === 0) { row.darkShaft++; bad10.push([sx, y, sz]); }
        }
      }
      // the airlock: the outer and inner doors, lower and upper halves
      for (const t of [1, 2]) {
        const [x, z] = at(t, sh.v);
        for (const [y, half] of [[y0 + 1, 'lower'], [y0 + 2, 'upper']]) {
          row.doors++;
          const s = st(x, y, z);
          if (!/_door$/.test(nameOf(s)) || !s.includes(`half=${half}`)) { row.doorBad++; bad10.push([x, y, z]); }
        }
      }
      // the rails round the top on its three open sides; 3 clear over the top
      for (const [t, v] of [[2, sh.v], [3, sh.v - 1], [3, sh.v + 1]]) {
        const [x, z] = at(t, v);
        row.rails++;
        if (!P.barrier[vw.get(x, yT + 1, z)]) { row.railBad++; bad10.push([x, yT + 1, z]); }
      }
      for (let y = yT; y <= yT + 2; y++) if (!P.passable[vw.get(sx, y, sz)] || P.solid[vw.get(sx, y, sz)]) { row.headBad++; bad10.push([sx, y, sz]); break; }
      // M5 at the foot (the approach) and the top (the top walk cell)
      if (want.has('M5')) {
        for (const [x, z, y] of [[...at(0, sh.v), y0], [...at(4, sh.v), yT]]) {
          if (!(P.spawn[vw.get(x, y, z)] && P.passable[vw.get(x, y + 1, z)])) continue;
          L ??= light();
          if (L.at(x, y + 1, z) === 0) { row.darkWalk++; dark.push([x, y + 1, z]); }
        }
      }
    }
    per.push(row);
    if (bad10.length && want.has('M10')) findings.push(finding('M10:lift', m.part ?? null, null, bad10.length, bad10, `lift ${m.id}: ${row.base}/${lanes.shafts.length} base(s), ${row.columnBad} of ${row.column} shaft cell(s) not a bubble column of its drag, ${row.shellBad} shell cell(s) under 2 thick, ${row.doorBad} of ${row.doors} airlock door half(s) missing, ${row.railBad} of ${row.rails} rim rail(s) missing, ${row.headBad} top(s) with under 3 clear, ${row.darkShaft} dark shaft cell(s)`));
    if (dark.length && want.has('M5')) findings.push(finding('M5:lift', m.part ?? null, null, dark.length, dark, `lift ${m.id}: ${dark.length} dark (block light 0) spawnable walk cell(s) at its foot or top`));
  }
  metrics.lifts = { per };
}
