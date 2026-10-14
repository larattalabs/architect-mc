// (7a K1b) The rope bridge rules of the checker (docs/CONTRACT.md "Phase 7a slice K1" §5): `M10:rope`, for every rope bridge the
// plan meta records (`meta.ropes`, written by lib/connectors/ropeGeom.mjs ropeBridge): each deck cell's walk surface measured from
// the world's blocks (a bottom slab an odd half-block surface, a full block an even one) equals §3's formula, adjacent cells
// (landings included) differ by at most one half block, the span is 8..40 deck cells, and the four posts stand from 2 below the
// landing to 2 above it on solid ground. The same rule reads the virtual world (plan time) and a realised dump world (the gate), so
// the plan's numbers are only its inputs (n, the landings, the width), never the answer. Per bridge it records the rails (a barrier
// on both sides of each deck cell, M8's) and the head room (2 clear over each walk cell, M6's) as metrics. A warning, as M10.
// Called by checkRegion (check.mjs), which passes `finding`; leaves `vw` as it found it.
import { profile, y2Of, ROPE, sagOf, maxRiseOf, rightOf } from '../connectors/ropeGeom.mjs';

const nameOf = (s) => String(s ?? '').replace(/\[.*$/, '');

/** The rope rules: findings `M10:rope` and `metrics.ropes` (per bridge: the profile, the posts, rails and head room over the deck). */
export function ropeRules({ vw, ropes, want, findings, metrics, finding }) {
  const P = vw.pal, out = [];
  const push = (m, count, sample, message) => { if (want.has('M10')) findings.push(finding('M10:rope', m.part ?? null, m.stage ?? null, count, sample, message)); };
  for (const m of ropes) {
    const pid = m.id;
    const { n, rise, from, dir, lo, hi } = m;
    const [x0, y0, z0] = from, [dx, dz] = dir, [rx, rz] = rightOf(dir);
    // the deck cells 1..n follow the profile; the landings 0 and n + 1 stand at 2 y0 and 2 (y0 + rise)
    const want = [...profile(n, y0, rise), 2 * (y0 + rise)];
    const yHi = Math.max(y0, y0 + rise) + 3, yLo = Math.min(y0, y0 + rise) - sagOf(n) - maxRiseOf(n) - 4;
    // the walk surface of a column: the highest cell in the deck's range that a mover stands on (a floor or a bottom slab with
    // two passable cells over it), as half blocks; null when there is none
    const surface = (x, z) => {
      for (let y = yHi; y >= yLo; y--) {
        const b = vw.get(x, y, z);
        if (P.air[b] || P.passable[b]) continue;
        if (!(P.floor[b] || P.half[b])) return null;
        if (!P.passable[vw.get(x, y + 1, z)] || !P.passable[vw.get(x, y + 2, z)]) return null;
        return y2Of(y, P.half[b]);
      }
      return null;
    };
    const row = { path: pid, n, rise, width: hi - lo + 1, cells: 0, wrong: 0, missing: 0, maxStep: 0, postsOk: 0, posts: [] };
    const wrong = [], missing = [];
    for (let v = lo; v <= hi; v++) {
      let prev = null;
      for (let i = 0; i <= n + 1; i++) {
        const x = x0 + dx * i + rx * v, z = z0 + dz * i + rz * v;
        const got = surface(x, z);
        if (i > 0 && i <= n) {
          row.cells++;
          if (got === null) { row.missing++; missing.push([x, Math.floor(want[i] / 2), z]); }
          else if (got !== want[i]) { row.wrong++; wrong.push([x, Math.floor((got + 1) / 2), z]); }
        }
        if (got !== null && prev !== null) row.maxStep = Math.max(row.maxStep, Math.abs(got - prev));
        prev = got;
      }
    }
    if (n < ROPE.spanMin || n > ROPE.spanMax) push(m, 1, [from], `rope bridge ${pid}: span ${n} is outside ${ROPE.spanMin}..${ROPE.spanMax}`);
    if (row.missing) push(m, row.missing, missing, `rope bridge ${pid}: ${row.missing} of ${row.cells} deck cell(s) hold no walk surface in the deck's range`);
    if (row.wrong) push(m, row.wrong, wrong, `rope bridge ${pid}: ${row.wrong} of ${row.cells} deck cell(s) off the profile (y2 = floor((2 y0 n^2 + 2 rise i n - 8 d i (n - i)) / n^2))`);
    if (row.maxStep > 1) push(m, 1, [from], `rope bridge ${pid}: adjacent deck cells differ by ${row.maxStep} half blocks (at most 1)`);
    // the posts: the post block from landing - 2 to landing + 2, and solid ground (no gravity block) under it
    const postName = nameOf(m.post);
    const badPosts = [];
    for (const q of m.posts ?? []) {
      const deep = [q.landing - 2, q.landing - 1].every((y) => nameOf(P.states[vw.get(q.x, y, q.z)]) === postName);
      const up = [q.landing, q.landing + 1, q.landing + 2].every((y) => nameOf(P.states[vw.get(q.x, y, q.z)]) === postName);
      const under = vw.get(q.x, q.landing - 3, q.z);
      const ground = P.solid[under] && !P.fluid[under] && !P.gravity[under];
      const ok = deep && up && ground;
      row.posts.push({ x: q.x, z: q.z, landing: q.landing, deep, up, ground, ok });
      if (ok) row.postsOk++; else badPosts.push([q.x, q.landing - 2, q.z]);
    }
    if ((m.posts ?? []).length !== 4) push(m, 1, [from], `rope bridge ${pid}: ${(m.posts ?? []).length} post(s) recorded (4: two at each landing)`);
    if (badPosts.length) push(m, badPosts.length, badPosts, `rope bridge ${pid}: ${badPosts.length} of ${(m.posts ?? []).length} post(s) not standing 2 deep on solid ground (${row.posts.filter((p) => !p.ok).map((p) => `${p.x},${p.z}: ${!p.deep ? 'not 2 deep' : !p.up ? 'not 2 above' : 'no solid ground under it'}`).join('; ')})`);
    // rails on both edges of every deck cell (a barrier at the feet cell beside the deck: M8's 1.5) and 2 clear over every walk cell
    row.railed = 0; row.headroom = 0;
    for (let i = 1; i <= n; i++) {
      const x = x0 + dx * i, z = z0 + dz * i;
      const feet = (xx, zz) => { const s = surface(xx, zz); return s === null ? null : Math.floor((s + 1) / 2) + 1; };
      let ok = true;
      for (const v of [lo - 1, hi + 1]) {
        const xr = x + rx * v, zr = z + rz * v, f = feet(x + rx * (v < lo ? lo : hi), z + rz * (v < lo ? lo : hi));
        if (f === null || !P.barrier[vw.get(xr, f, zr)]) ok = false;
      }
      if (ok) row.railed++;
      let clear = true;
      for (let v = lo; v <= hi; v++) { const f = feet(x + rx * v, z + rz * v); if (f === null || !P.passable[vw.get(x + rx * v, f, z + rz * v)] || !P.passable[vw.get(x + rx * v, f + 1, z + rz * v)]) clear = false; }
      if (clear) row.headroom++;
    }
    row.ok = !row.missing && !row.wrong && row.maxStep <= 1 && n >= ROPE.spanMin && n <= ROPE.spanMax && row.postsOk === 4;
    out.push(row);
  }
  metrics.ropes = { bridges: out.length, ok: out.filter((r) => r.ok).length, per: out };
}
