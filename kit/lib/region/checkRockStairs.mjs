// (7a RK) The rock stair rules of the checker (docs/CONTRACT.md "Phase 7a slice RK" §5), for every flight the plan meta records
// (`meta.rockStairs`, written by lib/connectors/rockStairGeom.mjs `rockStair`). They read the world's blocks (the virtual world at plan
// time, a realised dump world in the gate):
//   M3:tunnel, M3:gravity, M4:tunnel, M6   T3b's rules (checkTunnels.mjs) over the flight unchanged: its void and shell are a tunnel's,
//                                          its floor cells the treads at their own y (an all-cut flight is no finding: a rock stair needs
//                                          no bore); their counts in `metrics.rockStairs.per[].tunnel`
//   M10:rock_stair (warning)               every tread a floor rising 1 from the last (a step: a stairs block facing up the flight) or
//                                          level with it (a landing: a full block), landings every `landing` steps and 2 flat, every
//                                          tread on a site-solid cell (solid, not falling, not fluid) and 2 passable over it
// The M5 count over the treads is check.mjs's (`metrics.M5rockStair`, over each record's `cells`). Leaves `vw` as it found it.
import { tunnelRules } from './checkTunnels.mjs';

const nameOf = (s) => String(s ?? '').replace(/\[.*$/, '');
const propOf = (s, k) => (new RegExp(`[[,]${k}=([^,\\]]+)`).exec(String(s ?? '')) ?? [])[1] ?? null;

/** The rock stair rules: findings and `metrics.rockStairs`. */
export function rockStairRules({ ir, vw, rockStairs, meta, want, findings, metrics, partStage, finding }) {
  const P = vw.pal, out = [];
  // T3b's rules over each flight as a tunnel record (boreMin 0), into their own metrics; the findings name the rock stair
  const tm = {};
  const asTunnels = rockStairs.map((t) => ({ ...t, boreMin: 0 }));
  const before = findings.length;
  tunnelRules({ ir, vw, tunnels: asTunnels, meta, want, findings, metrics: tm, partStage, finding });
  for (let k = before; k < findings.length; k++) if (typeof findings[k].message === 'string') findings[k].message = findings[k].message.replace(/^tunnel /, 'rock stair ');
  const firm = (b) => P.solid[b] && !P.fluid[b] && !P.air[b] && !P.gravity[b];
  for (const [n, t] of rockStairs.entries()) {
    const row = { id: t.id, part: t.part ?? null, steps: t.steps, landings: t.landings, treads: (t.floor ?? []).length, rises: 0, badRise: 0, flat: 0, badLanding: 0, unanchored: 0, notClear: 0, tunnel: tm.tunnels?.per?.[n] ?? null };
    const [fx, , fz] = t.from, [dx, dz] = t.dir;
    const idxOf = (x, z) => (x - fx) * dx + (z - fz) * dz;
    const bad = [];
    const flag = (c) => { if (bad.length < 16) bad.push(c); };
    // per tread index, the lanes' cells (the record's floor: [x, y, z, kind])
    const byI = new Map();
    for (const c of t.floor ?? []) { const i = idxOf(c[0], c[2]); (byI.get(i) ?? byI.set(i, []).get(i)).push(c); }
    const up = t.rise >= 0 ? 1 : -1;
    const L = t.length;
    // the profile in the flight's own sense, from its lower end: a step rises 1 over the last tread, a landing is level with it
    const order = [];
    for (let i = 1; i <= L; i++) order.push(i);
    if (up < 0) order.reverse();
    let prevY = up > 0 ? t.from[1] : t.to[1];
    for (const i of order) {
      const cells = byI.get(i) ?? [];
      for (const [x, y, z] of cells) {
        const b = vw.get(x, y, z), under = vw.get(x, y - 1, z);
        // on site-solid ground, a floor (a stairs block or a full block), 2 passable over it
        if (!firm(under)) { row.unanchored++; flag([x, y - 1, z]); }
        if (!(P.stairs[b] || (P.solid[b] && !P.gravity[b]))) { row.badRise++; flag([x, y, z]); }
        if (!(P.passable[vw.get(x, y + 1, z)] && P.passable[vw.get(x, y + 2, z)])) { row.notClear++; flag([x, y + 1, z]); }
      }
      const y = cells.length ? cells[0][1] : null;
      if (y === null) { row.badRise++; continue; }
      const d = y - prevY;
      const kind = (t.kinds ?? [])[i - 1];
      if (kind === 'landing') { if (d !== 0) { row.badLanding++; flag(cells[0]); } else row.flat++; }
      else if (d === 1) row.rises++;
      else { row.badRise++; flag(cells[0]); }
      // a step is a stairs block facing up the flight
      if (kind !== 'landing') for (const [x, yy, z] of cells) { const b = vw.get(x, yy, z); if (!P.stairs[b] || propOf(P.states[b], 'facing') !== t.facing) { row.badRise++; flag([x, yy, z]); } }
      prevY = y;
    }
    // landings every `landing` steps (counted from the lower end) and 2 flat
    const seq = (t.kinds ?? []).slice();
    if (up < 0) seq.reverse();
    let run = 0;
    for (let j = 0; j < seq.length; j++) {
      if (seq[j] === 'landing') { if (run !== (t.landing ?? 8)) row.badLanding++; let k = j; while (k < seq.length && seq[k] === 'landing') k++; if (k - j !== 2) row.badLanding++; j = k - 1; run = 0; } else run++;
    }
    const total = row.badRise + row.badLanding + row.unanchored + row.notClear;
    if (total && want.has('M10')) findings.push(finding('M10:rock_stair', t.part ?? null, t.stage ?? null, total, bad, `rock stair ${t.id}: ${row.badRise} tread(s) off the profile, ${row.badLanding} landing fault(s), ${row.unanchored} tread(s) not on site-solid ground, ${row.notClear} without 2 clear`));
    void nameOf;
    out.push(row);
  }
  metrics.rockStairs = { per: out, count: out.length };
}
