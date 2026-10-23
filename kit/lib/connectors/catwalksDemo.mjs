// (7a CW) catwalks_demo's sections (docs/CONTRACT.md "Phase 7a slice CW" §8): the flat variant's raised cliff and shelves, and the
// natural variant's pick of a face on a pinned site. Each returns the route nodes and edge of one catwalk (a catwalk edge: exactly one
// run, the walks at its ends), which kit/regions/catwalks_demo.mjs routes and emits. Pure plan-time code (integer math only).
//   flat:    a cliff `cliff` high along the claim's north side and two shelves `shelf` high south of it, either side of a 16-wide bay,
//            raised in stage `ground` through the shared base (the route pass meets them, T1's lesson); a fence on each shelf's lip over
//            the bay but at the landing; the catwalk runs along the face at the shelves' level (v7a_cw_cliff's shape, on the claim)
//   natural: the claim's best straight run along a face (pickFace): a level y up the face where the face is site-solid from y to y + 2
//            beside every deck cell, the lanes and the bed open, and a drop of 2 or more under the outer lane; the ends' landings on
//            level pads raised in stage `ground` (the foundation role, in the shared base) to y
import { CATWALK, checkCatwalk, catwalkLanes, emitRouteCatwalks } from './catwalkGeom.mjs';
import { rightOf, surveyLand } from './ropeGeom.mjs';

/** The flat variant's layout over a claim's north-west corner (offsets from the claim's min corner). */
/** §8's natural site bar: a face at least 24 long and 8 high. */
export const FACE_BAR = Object.freeze([24, 8]);
export const FLAT = Object.freeze({ cliff: 20, shelf: 8, depth: 30, bay: [60, 75], W: 160, D: 96, from: [48, 36], to: [87, 36] });
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/**
 * The claim's straight runs along a face, best first: `{a: [x, y, z] (the start walk cell), dir, side, n, gap, ends: [{x, z, g}]}`. A
 * run of n deck cells (min..max) at y passes catwalkGeom.checkCatwalk over the survey with the ends' pads raised to y (each end's lanes
 * and the pad's ground at most `padMax` under y, never over it); the longest gap (deck cells over a drop) wins, then the shorter
 * pads, then the line, the runs whose face meets FACE_BAR first. `margin` keeps the run and its pads off the claim's edge.
 */
export function pickFace(S, claim, { width = 2, min = 8, max = 24, padMax = 8, margin = 12, step = 1 } = {}) {
  const out = [];
  const land = surveyLand(S);
  const inside = (x, z) => x >= claim.minX + margin && x <= claim.maxX - margin && z >= claim.minZ + margin && z <= claim.maxZ - margin;
  for (let z = claim.minZ + margin; z <= claim.maxZ - margin; z += step) for (let x = claim.minX + margin; x <= claim.maxX - margin; x += step) {
    for (const dir of DIRS) for (const side of ['left', 'right']) {
      const L = catwalkLanes(width, dir, side), [rx, rz] = rightOf(dir);
      const at = (i, v) => [x + dir[0] * i + rx * v, z + dir[1] * i + rz * v];
      // y: the face's ground beside deck cell 1 minus 2..8 (a shelf up the face), every 2
      const [fx, fz] = at(1, L.face);
      const fg = S.groundAt(fx, fz);
      for (let y = fg - 8; y <= fg - 2; y += 2) {
        if (S.waterAt(x, z)) continue;
        for (let n = max; n >= min; n--) {
          const [lx, lz] = at(n + 1, L.inner);
          if (!inside(lx, lz) || !inside(...at(0, L.outer))) continue;
          // the pads: both ends' lanes at most padMax under y, none over it, no water
          const ends = [0, n + 1].flatMap((i) => L.lanes.map((v) => { const [px, pz] = at(i, v); return { x: px, z: pz, g: S.groundAt(px, pz), w: S.waterAt(px, pz) }; }));
          if (ends.some((e) => e.w || e.g > y || y - e.g > padMax)) continue;
          const padLand = { ...land, groundAt: (px, pz) => (ends.some((e) => e.x === px && e.z === pz) ? y : land.groundAt(px, pz)) };
          const c = checkCatwalk(padLand, [x, y, z], dir, n, side, width);
          if (!c.ok) continue;
          out.push({ a: [x, y, z], dir, side, n, gap: c.gap.length, pad: ends.reduce((t, e) => t + (y - e.g), 0), ends: ends.map(({ x: ex, z: ez, g }) => ({ x: ex, z: ez, g })), face: faceOf(S, [x, y, z], dir, side, n, width) });
          break;
        }
      }
    }
  }
  // (a run whose face meets §8's site bar, 24 long and 8 high, first)
  const bar = (q) => (q.face.length >= FACE_BAR[0] && q.face.height >= FACE_BAR[1] ? 0 : 1);
  out.sort((p, q) => bar(p) - bar(q) || q.gap - p.gap || p.pad - q.pad || q.n - p.n || p.a[0] - q.a[0] || p.a[2] - q.a[2] || p.a[1] - q.a[1] || DIRS.indexOf(p.dir) - DIRS.indexOf(q.dir) || (p.side < q.side ? -1 : p.side > q.side ? 1 : 0));
  return out;
}

/**
 * A run's face (the site's measure, §8 "a face of at least 24 x 8"): `length` the face cells along the run's line, through the run and
 * past both its ends, whose ground stands at least to y + 2; `height` the least rise over the run from the outer lane's ground to the
 * face's top.
 */
export function faceOf(S, a, dir, side, n, width = 2) {
  const L = catwalkLanes(width, dir, side), [rx, rz] = rightOf(dir), [x, y, z] = a;
  const at = (i, v) => [x + dir[0] * i + rx * v, z + dir[1] * i + rz * v];
  const up = (i) => S.groundAt(...at(i, L.face)) >= y + 2;
  let lo = 1, hi = n;
  while (lo > 1 - 64 && up(lo - 1)) lo--;
  while (hi < n + 64 && up(hi + 1)) hi++;
  let height = Infinity;
  for (let i = 1; i <= n; i++) height = Math.min(height, S.groundAt(...at(i, L.face)) - S.groundAt(...at(i, L.outer)));
  return { length: hi - lo + 1, height };
}

const edgeOf = (from, to, approach) => ({ id: 'catwalk', from, to, width: 2, movers: ['player', 'villager'], spans: ['catwalk'], once: 'catwalk', approach, t7: { catwalk: { width: 2 } } });

/** The flat section (stage `ground`): `{nodes, edges, note}`. */
export function flatSection(ctx, r, base, P) {
  const { survey: S, claim } = ctx;
  const x0 = claim.minX, z0 = claim.minZ, x1 = x0 + FLAT.W - 1, z1 = z0 + FLAT.D - 1;
  const H = P.cliff ?? FLAT.cliff, h = P.shelf ?? FLAT.shelf;
  const rects = [[x0, z0, x1, z0 + FLAT.depth - 1, H], [x0, z0 + FLAT.depth, x0 + FLAT.bay[0] - 1, z1, h], [x0 + FLAT.bay[1] + 1, z0 + FLAT.depth, x1, z1, h]];
  const part = r.part('cliff', { stage: 'ground' });
  const mats = [r.material('surface', 'cliff'), r.material('subsurface', 'cliff'), r.material('rock', 'cliff')];
  const cols = [];
  for (const [ax, az, bx, bz, R] of rects) for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) {
    base.values[(x - base.minX) + (z - base.minZ) * base.width] += R;
    const g = S.groundAt(x, z);
    cols.push(x, z, g + 1, g + R - 4, 2, x, z, g + R - 3, g + R - 1, 1, x, z, g + R, g + R, 0);
  }
  part._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: mats, cond: 0, walk: false });
  (r.meta.parts.cliff ??= {}).kind = 'add';
  // a fence on each shelf's lip over the bay (the drop is h), but at the catwalk's landing (its lanes and bed: z0 + 30 .. z0 + 32)
  const fence = r.part('shelf_rails', { stage: 'ground' });
  const fcols = [], fmats = [r.material('rail', 'shelf rail'), 'minecraft:lantern[hanging=false,waterlogged=false]'];
  let k = 0;
  for (const x of [x0 + FLAT.bay[0] - 1, x0 + FLAT.bay[1] + 1]) for (let z = z0 + FLAT.depth + 3; z <= z1 - 2; z++) {
    const y = S.groundAt(x, z) + h + 1;
    fcols.push(x, z, y, y, 0);
    if (k++ % 8 === 0) fcols.push(x, z, y + 1, y + 1, 1);
  }
  fence._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: fcols, materials: fmats, cond: 0, walk: false });
  const at = ([dx, dz]) => [x0 + dx, S.groundAt(x0 + dx, z0 + dz) + h + 1, z0 + dz];
  const nodes = { shelf_w: { at: at(FLAT.from), kind: 'junction' }, shelf_e: { at: at(FLAT.to), kind: 'junction' } };
  r.meta.catwalksDemo = { variant: 'flat', cliff: H, shelf: h, bay: FLAT.bay.map((v) => x0 + v), face: z0 + FLAT.depth - 1 };
  return { nodes, edges: [edgeOf('shelf_w', 'shelf_e', 16)], note: `flat: a cliff ${H} high, shelves ${h} high either side of a ${FLAT.bay[1] - FLAT.bay[0] + 1}-wide bay` };
}

/** The natural section (stage `ground`): the best face run's pads raised to its level; `{nodes, edges, note}`. */
export function naturalSection(ctx, r, base, P) {
  const { survey: S, claim } = ctx;
  const picks = pickFace(S, claim);
  const c = picks[0];
  if (!c) return { nodes: {}, edges: [], note: 'natural: no straight run along a face takes a catwalk' };
  const y = c.a[1];
  const pad = r.part('pads', { stage: 'ground' });
  const mats = [r.material('foundation', 'pad'), r.material('path', 'pad')];
  const cols = [];
  for (const e of c.ends) {
    if (e.g < y) base.values[(e.x - base.minX) + (e.z - base.minZ) * base.width] += y - e.g;
    if (e.g + 1 <= y - 1) cols.push(e.x, e.z, e.g + 1, y - 1, 0);
    if (e.g < y) cols.push(e.x, e.z, y, y, 1);
  }
  if (cols.length) { pad._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: mats, cond: 0, walk: false }); (r.meta.parts.pads ??= {}).kind = 'add'; }
  // the nodes on the run's centre line at both ends (the walk cells the route starts and lands on, feet one over)
  const node = (i) => [c.a[0] + c.dir[0] * i, y + 1, c.a[2] + c.dir[1] * i];
  const nodes = { face_a: { at: node(0), kind: 'junction' }, face_b: { at: node(c.n + 1), kind: 'junction' } };
  r.meta.catwalksDemo = { variant: 'natural', run: { a: c.a, dir: c.dir, side: c.side, n: c.n, gap: c.gap, pad: c.pad }, candidates: picks.length };
  return { nodes, edges: [edgeOf('face_a', 'face_b', 0)], note: `natural: a run of ${c.n} along the face at ${c.a.join(',')} heading ${c.dir.join(',')} (the face ${c.side}), ${c.gap} deck cell(s) over a drop, pads ${c.pad} cell(s) of fill` };
}

/** The catwalks the route pass found, emitted in `stage` (part `links_catwalks`). */
export function emitDemoCatwalks(r, { stage } = {}) {
  return emitRouteCatwalks(r, { stage, part: 'links_catwalks', prefix: 'catwalk_' });
}

export { CATWALK };
