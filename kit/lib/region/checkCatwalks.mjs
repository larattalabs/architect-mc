// (7a CW) The catwalk rules of the checker (docs/CONTRACT.md "Phase 7a slice CW" §4): `M10:catwalk`, a warning, for every catwalk the
// plan meta records (`meta.catwalks`, written by lib/connectors/catwalkGeom.mjs catwalkRun). The record gives only the inputs (the
// start cell, the heading, n, the face's side and lateral offset, the planned width); every bar is measured from the world's blocks, so
// the same rule reads the virtual world (plan time) and a realised dump world (the gate):
//   level        every planned lane of every deck cell is a floor at y with 2 passable cells over it
//   face         the face cell beside every deck cell is solid (not fluid, not a gravity block) at y: the deck is face-adjacent to
//                the face, each lane to the one inside it (M3 through the face)
//   outer edge   the walk lanes from the face outward (contiguous floors at y) end at most 2 from the face
//   brackets     a support under the outer lane (a bracket, a strut or the land: any solid cell at y - 1) at deck cells 1 and n and
//                at most 4 apart between
//   rails        a barrier (M8's 1.5) on the bed at y + 1 past the outer lane, for every deck cell
//   head room    2 passable cells over every lane (M6)
//   the face     no face cell (y .. y + 2 beside the deck) written by the catwalk's part and changed: a catwalk cuts nothing
// It records per catwalk the counts as metrics (`metrics.catwalks.per`); M8 and M6 findings name the rails and the head room too, as
// the bridges' rules do. Called by checkRegion (check.mjs), which passes `finding`; leaves `vw` as it found it.
import { rightOf } from '../connectors/ropeGeom.mjs';
import { CATWALK } from '../connectors/catwalkGeom.mjs';
import { F_WRITTEN } from './vworld.mjs';

/** The catwalk rules: findings `M10:catwalk` (and M8, M6) and `metrics.catwalks`. */
export function catwalkRules({ ir, vw, catwalks, want, findings, metrics, finding }) {
  const P = vw.pal, out = [];
  const push = (rule, m, count, sample, message) => { if (want.has(rule.replace(/:.*$/, ''))) findings.push(finding(rule, m.part ?? null, m.stage ?? null, count, sample, message)); };
  const firm = (b) => P.solid[b] && !P.fluid[b] && !P.gravity[b];
  for (const m of catwalks) {
    const pid = m.id, { n, from, dir, y } = m;
    const [x0, , z0] = from, [dx, dz] = dir, [rx, rz] = rightOf(dir);
    const step = m.side === 'right' ? 1 : -1;
    // (a face cell the catwalk's own part wrote: another part's write there, a cliff the program raised, is the land it stands on)
    const pi = ir?.parts ? ir.parts.findIndex((q) => q.id === m.part) : -1;
    const own = (x, yy, z) => (vw.flags(x, yy, z) & F_WRITTEN) !== 0 && (pi < 0 || vw.partAt(x, yy, z) === pi);
    const at = (i, v) => [x0 + dx * i + rx * v, z0 + dz * i + rz * v];
    const lanes = Array.from({ length: m.width }, (_, k) => m.face - step * (k + 1));
    // a walk surface at y: a floor with two passable cells over it
    const walkAt = (x, z) => P.floor[vw.get(x, y, z)] && P.passable[vw.get(x, y + 1, z)] && P.passable[vw.get(x, y + 2, z)];
    const row = { catwalk: pid, part: m.part, n, width: m.width, side: m.side, cells: 0, level: 0, faceOk: 0, outerMax: 0, supports: 0, maxGap: 0, railed: 0, headroom: 0, faceWritten: 0 };
    const notLevel = [], noFace = [], wide = [], noRail = [], low = [], faceHit = [];
    let lastSupport = 0;
    const gaps = [];
    for (let i = 1; i <= n; i++) {
      for (const v of lanes) {
        const [x, z] = at(i, v);
        row.cells++;
        if (walkAt(x, z)) row.level++; else notLevel.push([x, y, z]);
      }
      const [fx, fz] = at(i, m.face);
      if (firm(vw.get(fx, y, fz))) row.faceOk++; else noFace.push([fx, y, fz]);
      // the outer edge: contiguous walk lanes from the face outward
      let d = 0;
      while (d < 4) { const [x, z] = at(i, m.face - step * (d + 1)); if (!walkAt(x, z)) break; d++; }
      if (d > row.outerMax) row.outerMax = d;
      if (d > 2) { const [wx, wz] = at(i, m.face - step * d); wide.push([wx, y, wz]); }
      // a support under the outer lane at y - 1 (a bracket, a strut's top or the land)
      const [ox, oz] = at(i, lanes[lanes.length - 1]);
      const sb = vw.get(ox, y - 1, oz);
      if (P.solid[sb] && !P.fluid[sb]) {
        row.supports++;
        if (i - lastSupport - 1 > row.maxGap) row.maxGap = i - lastSupport - 1;
        lastSupport = i;
      } else if (i === 1 || i === n) gaps.push(i);
      // rails: a barrier on the bed at y + 1, past the outermost walk lane
      const [bx, bz] = at(i, m.face - step * (Math.max(d, 1) + 1));
      if (P.barrier[vw.get(bx, y + 1, bz)]) row.railed++; else noRail.push([bx, y + 1, bz]);
      // head room: 2 passable over every lane
      if (lanes.every((v) => { const [x, z] = at(i, v); return P.passable[vw.get(x, y + 1, z)] && P.passable[vw.get(x, y + 2, z)]; })) row.headroom++;
      else { const [lx, lz] = at(i, lanes[0]); low.push([lx, y + 1, lz]); }
      // the face: never written (its state before and after equal)
      for (let yy = y; yy <= y + 2; yy++) if (own(fx, yy, fz) && vw.get(fx, yy, fz) !== vw.base(fx, yy, fz)) { row.faceWritten++; faceHit.push([fx, yy, fz]); }
    }
    if (n - lastSupport > row.maxGap) row.maxGap = n - lastSupport;
    const every = CATWALK.bracketEvery;
    const bracketsOk = !gaps.length && row.maxGap <= every - 1;
    if (n < CATWALK.runMin || n > CATWALK.runMax) push('M10:catwalk', m, 1, [from], `catwalk ${pid}: ${n} deck cells is outside ${CATWALK.runMin}..${CATWALK.runMax}`);
    if (notLevel.length) push('M10:catwalk', m, notLevel.length, notLevel.slice(0, 8), `catwalk ${pid}: ${notLevel.length} of ${row.cells} deck cell(s) not a level walk surface at y ${y} (a floor with 2 passable over it)`);
    if (noFace.length) push('M10:catwalk', m, noFace.length, noFace.slice(0, 8), `catwalk ${pid}: ${noFace.length} of ${n} deck cell(s) with no solid face beside the inner lane (M3 through the face)`);
    if (wide.length) push('M10:catwalk', m, wide.length, wide.slice(0, 8), `catwalk ${pid}: the deck's outer edge stands ${row.outerMax} from the face (at most 2) at ${wide.length} deck cell(s)`);
    if (!bracketsOk) push('M10:catwalk', m, Math.max(1, gaps.length), gaps.length ? gaps.map((i) => at(i, lanes[lanes.length - 1])).map(([x, z]) => [x, y - 1, z]) : [from], `catwalk ${pid}: brackets more than ${every} apart (the longest unsupported run ${row.maxGap} deck cell(s)${gaps.length ? `; deck cell(s) ${gaps.join(', ')} at the ends unsupported` : ''})`);
    if (row.railed < n) { push('M10:catwalk', m, n - row.railed, noRail.slice(0, 8), `catwalk ${pid}: ${n - row.railed} of ${n} deck cell(s) without a rail on the open edge`); push('M8', m, n - row.railed, noRail.slice(0, 8), `catwalk ${pid}: ${n - row.railed} of ${n} deck cell(s) without a rail on the open edge`); }
    if (row.headroom < n) { push('M10:catwalk', m, n - row.headroom, low.slice(0, 8), `catwalk ${pid}: ${n - row.headroom} of ${n} deck cell(s) without 2 clear over the walk`); push('M6', m, n - row.headroom, low.slice(0, 8), `catwalk ${pid}: ${n - row.headroom} of ${n} deck cell(s) without 2 clear over the walk`); }
    if (row.faceWritten) push('M10:catwalk', m, row.faceWritten, faceHit.slice(0, 8), `catwalk ${pid}: ${row.faceWritten} face cell(s) changed (a catwalk cuts nothing)`);
    row.bracketsOk = bracketsOk;
    row.ok = !notLevel.length && !noFace.length && !wide.length && bracketsOk && row.railed === n && row.headroom === n && !row.faceWritten;
    out.push(row);
  }
  metrics.catwalks = { catwalks: out.length, ok: out.filter((r) => r.ok).length, per: out };
}
