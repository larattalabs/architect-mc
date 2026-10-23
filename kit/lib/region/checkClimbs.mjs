// (7a CL) The climb rules of the checker (docs/CONTRACT.md "Phase 7a slice CL" §10 item 7): for every climb the plan meta records
// (`meta.climbs`, written by lib/connectors/climbGeom.mjs emitClimbs), read from the world's blocks (the virtual world at plan time, a
// realised dump world in the gate):
//   M10:climb  each stair flight rises or falls 1 a cell, at most 8, then 2 flat cells, every tread standable with 2 clear over it; every
//              ladder rung a ladder block against a solid, non-falling face cell; each flight at most `rest` rungs; each rest landing's
//              deck standable; the top gate in place (top: gate)
//   M8:climb   a barrier beside every stair tread and landing cell over a drop of more than 3 (rails: none excepted)
//   M5:climb   no dark (block light 0) spawnable walk, tread or landing cell of the climb
// Per climb `metrics.climbs.per`. Warnings (M10, M8, M5). Called by checkRegion (check.mjs); leaves `vw` as it found it.
import { footprintOf } from './passes/route.mjs';
import { faceDir } from '../connectors/climbGeom.mjs';

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const nameOf = (s) => String(s ?? '').replace(/\[.*$/, '');

/** The climb rules: findings `M10:climb`, `M8:climb`, `M5:climb` and `metrics.climbs`. `light`: blockLight(vw) (lazy). */
export function climbRules({ vw, climbs, want, findings, metrics, finding, light }) {
  const P = vw.pal, per = [];
  const push = (rule, m, count, sample, message) => { if (want.has(rule.replace(/:.*$/, ''))) findings.push(finding(rule, m.part ?? null, null, count, sample, message)); };
  const dropBelow = (x, y, z) => { for (let d = 1; d <= 4; d++) { const s = vw.get(x, y - d, z); if (!P.passable[s] || P.water[s]) return d - 1; } return 99; };
  let L = null;
  for (const m of climbs) {
    const row = { id: m.id, part: m.part, kind: m.kind, flights: 0, flightBad: 0, treads: 0, treadBad: 0, rungs: 0, faceBad: 0, notLadder: 0, longFlights: 0, landings: 0, landingBad: 0, gate: null, m8Edges: 0, m8Open: 0, dark: 0, cells: 0 };
    const e = m.route;
    const bad10 = [], bad8 = [], dark = [];
    if (e) {
      // ---- flights: rise 1 a cell (at most 8), then 2 flat cells; every tread standable
      e.segments.forEach((g, si) => {
        if (g.kind !== 'stair' || g.shared) return;
        row.flights++;
        const ys = e.path.slice(g.from, g.to + 1).map((q) => q[1]);
        const steps = ys.length - 1;
        let ok = steps >= 2 && steps <= 8 && ys.every((y, i) => i === 0 || Math.abs(y - ys[i - 1]) === 1) && ys.every((y, i) => i < 2 || Math.sign(y - ys[i - 1]) === Math.sign(ys[1] - ys[0]));
        const next = e.segments[si + 1];
        if (next && !(next.to - next.from >= 2 && e.path[next.from + 1][1] === ys[ys.length - 1] && e.path[next.from + 2][1] === ys[ys.length - 1])) ok = false;
        for (const [x, y, z] of e.path.slice(g.from + 1, g.to + 1)) {
          row.treads++;
          const b = vw.get(x, y, z);
          if (!(P.floor[b] || P.stairs[b] || P.half[b]) || !P.passable[vw.get(x, y + 1, z)] || !P.passable[vw.get(x, y + 2, z)]) { row.treadBad++; bad10.push([x, y, z]); }
        }
        if (!ok) { row.flightBad++; bad10.push([...e.path[g.from]]); }
      });
      // ---- M8 and M5 over the stair treads and landing cells (and the climb's walk cells for M5)
      const fp = new Set();
      for (const g of e.segments) if (!g.shared) for (const q of footprintOf(e.path.slice(g.from, g.to + 1), e.width)) fp.add(`${q[0]},${q[1]}`);
      const cells = [];
      e.segments.forEach((g) => {
        if (g.shared) return;
        for (const q of footprintOf(e.path.slice(g.from, g.to + 1), e.width)) cells.push([q[0], q[2], q[1], g.kind]);
      });
      for (const l of e.landings ?? []) for (const [x, z] of l.cells) cells.push([x, l.y, z, 'landing']);
      const seen = new Set();
      for (const [x, y, z, kind] of cells) {
        const k = `${x},${y},${z}`;
        if (seen.has(k)) continue;
        seen.add(k);
        row.cells++;
        const feet = y + 1;
        if (kind === 'stair' || kind === 'landing') {
          let edge = false, open = false;
          for (const [dx, dz] of DIRS4) {
            const nx = x + dx, nz = z + dz;
            if (fp.has(`${nx},${nz}`)) continue;
            const n = vw.get(nx, feet, nz);
            if (P.passable[n] && dropBelow(nx, feet, nz) > 3) { edge = true; open = true; }
            else if ((P.barrier[n] || P.solid[n]) && dropBelow(nx, feet - 1, nz) > 3) edge = true;
          }
          if (edge) row.m8Edges++;
          if (open && m.railsMode !== 'none') { row.m8Open++; bad8.push([x, feet, z]); }
        }
        if (want.has('M5') && P.spawn[vw.get(x, y, z)] && P.passable[vw.get(x, feet, z)]) {
          L ??= light();
          if (L.at(x, feet, z) === 0) { row.dark++; dark.push([x, feet, z]); }
        }
      }
    }
    // ---- ladders: each rung a ladder against a solid face; flights at most `rest`; landings standable; the top gate
    for (const d of m.detail ?? []) {
      const [fx, fz] = faceDir(d.facing);
      for (const f of d.flights ?? []) {
        if (f.y1 - f.y0 + 1 > (m.rest ?? 24)) { row.longFlights++; bad10.push([f.x, f.y0, f.z]); }
        for (let y = f.y0; y <= f.y1; y++) {
          row.rungs++;
          if (!P.climb[vw.get(f.x, y, f.z)]) { row.notLadder++; bad10.push([f.x, y, f.z]); }
          const b = vw.get(f.x + fx, y, f.z + fz);
          if (!P.solid[b] || P.gravity[b]) { row.faceBad++; bad10.push([f.x + fx, y, f.z + fz]); }
        }
      }
      for (const l of d.rest ?? []) {
        row.landings++;
        for (const [x, z] of l.deck) { const b = vw.get(x, l.y - 1, z); if (!(P.floor[b] || P.half[b]) || !P.passable[vw.get(x, l.y + 1, z)]) { row.landingBad++; bad10.push([x, l.y - 1, z]); } }
      }
      if (d.top) {
        const ok = /fence_gate$/.test(nameOf(P.states[vw.get(d.top[0], d.top[1], d.top[2])]));
        row.gate = (row.gate ?? true) && ok;
        if (!ok) bad10.push([...d.top]);
      }
    }
    per.push(row);
    if (bad10.length) push('M10:climb', m, bad10.length, bad10, `climb ${m.id} (${m.kind}): ${row.flightBad} flight(s) off the profile, ${row.treadBad} tread(s) not standable, ${row.notLadder} rung(s) not a ladder, ${row.faceBad} face cell(s) not solid, ${row.longFlights} flight(s) over ${m.rest ?? 24} rungs, ${row.landingBad} landing cell(s) not standable${row.gate === false ? ', the top gate missing' : ''}`);
    if (bad8.length) push('M8:climb', m, bad8.length, bad8, `climb ${m.id} (${m.kind}): ${bad8.length} of ${row.m8Edges} tread or landing cell(s) beside a drop over 3 have no barrier`);
    if (dark.length) push('M5:climb', m, dark.length, dark, `climb ${m.id} (${m.kind}): ${dark.length} of ${row.cells} walk, tread or landing cell(s) are dark (block light 0) and spawnable`);
  }
  metrics.climbs = { per, flights: per.reduce((n, r) => n + r.flights, 0), rungs: per.reduce((n, r) => n + r.rungs, 0), m8Open: per.reduce((n, r) => n + r.m8Open, 0), dark: per.reduce((n, r) => n + r.dark, 0), bad: per.reduce((n, r) => n + r.flightBad + r.treadBad + r.notLadder + r.faceBad + r.longFlights + r.landingBad + (r.gate === false ? 1 : 0), 0) };
}
