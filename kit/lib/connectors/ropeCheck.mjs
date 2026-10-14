// (7a K1b) The checker's M10:rope (docs/CONTRACT.md "Phase 7a slice K1" §5): for every rope bridge the plan records
// (meta.paths[id].kind === 'rope'), the deck as the world holds it: each deck cell's walk surface measured from its blocks (a bottom
// slab is an odd half-block surface, a full block an even one) equals §3's formula, adjacent cells (landings included) differ by at
// most one half block, the span is 8..40, and the four posts stand from 2 below the landing to 2 above it on solid ground. The same
// rule reads the virtual world (plan time) and a realised dump world (the gate), so the plan's own numbers are only the inputs
// (n, the landings, the width), never the answer. A warning, as M10.
import { profile, y2Of, ROPE, sagOf, maxRiseOf, rightOf } from './ropeGeom.mjs';

const nameOf = (s) => String(s ?? '').replace(/\[.*$/, '');

/** The rule: appends findings `M10:rope` and returns the per-bridge metrics. */
export function ropeRule({ vw, meta, findings }) {
  const P = vw.pal, out = [];
  const push = (m, count, sample, message) => findings.push({ rule: 'M10:rope', severity: 'warning', part: m.part ?? null, stage: m.stage ?? null, count, sample: sample.slice(0, 20), message });
  for (const [pid, m] of Object.entries(meta?.paths ?? {})) {
    if (m?.kind !== 'rope') continue;
    const { n, rise, from, dir, lo, hi } = m;
    const [x0, y0, z0] = from, [dx, dz] = dir, [rx, rz] = rightOf(dir);
    const want = profile(n, y0, rise);
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
      for (let i = 0; i <= n; i++) {
        const x = x0 + dx * i + rx * v, z = z0 + dz * i + rz * v;
        const got = surface(x, z);
        if (i > 0 && i < n) {
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
    row.ok = !row.missing && !row.wrong && row.maxStep <= 1 && n >= ROPE.spanMin && n <= ROPE.spanMax && row.postsOk === 4;
    out.push(row);
  }
  return out;
}
