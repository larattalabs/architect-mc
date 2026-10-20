// The cave forms (docs/CONTRACT.md 6c F3 §2, §3.3): `stalactites` and `roots`, version 1. Plan time only; both read a frozen volume
// (the two-plan flow), so their sites are where the rock really is.
//
// - stalactites: cones from a cave ceiling and from the floor under it, merged into columns where they meet. Each cone is a column of
//   `pointed_dripstone` (vertical_direction from the cone, thickness as vanilla computes it: base, middle, frustum, tip, tip_merge where
//   two meet) under a `dripstone_block` root replacing the ceiling's (or floor's) own cell; `large` cones carry a dripstone_block core
//   (a `cone` primitive) round the middle column. Never under a root whose cell above holds or touches water or lava (vanilla's growth
//   needs a water source over the root: none grows); the broken variant `_unsafe.stalactiteUnderWater` places one anyway and the lint
//   GROWS refuses it.
// - roots: `capsuleChain`s down a steep face (a bank or a cliff: rooted dirt in the face, a ledge of it out of the face every few cells
//   with hanging roots under it) or along a cave ceiling (rooted dirt in the ceiling, hanging roots under it); `mangrove`: mangrove roots
//   for the rooted dirt. Hanging roots only under a solid cell the form writes or the volume shows.
// Sites: the volume's AIR cells under ROCK, SOIL or LOOSE with at least 4 headroom (ceilings; the floors are the solid cells under them),
// and faces at least 4 high. Integer maths only; seeded fnv64(seed, generator, label).
import { fnv64, splitmix64 } from '../noise.mjs';
import { VC, classAt } from '../region/volume.mjs';
import { formCells } from './rules.mjs';
import { AIR, columnRuns, key, thicknessColumn, unkey } from './states.mjs';

export const VERSION = 1;
const isInt = Number.isInteger;
const SOLID = new Set([VC.ROCK, VC.SOIL, VC.LOOSE]);
const FLUID = new Set([VC.WATER, VC.LAVA]);
/** The least headroom a ceiling needs (air cells from the ceiling down to the floor). */
export const HEADROOM = 4;
/** The search box's depth under the ground (§3.3). */
export const DEPTH = 48;

export const STALACTITE_PRESETS = Object.freeze({
  small: { length: [2, 6], spikes: [3, 6], spread: 3, core: 0 },
  large: { length: [5, 16], spikes: [2, 4], spread: 4, core: 2 },
});
export const ROOT_PRESETS = Object.freeze({
  dirt: { block: 'minecraft:rooted_dirt', length: [6, 14], chains: [3, 6] },
  mangrove: { block: 'minecraft:mangrove_roots', length: [6, 14], chains: [3, 6] },
});

function rng(seed, generator, label) {
  const h = fnv64(seed, generator, label);
  const g = splitmix64(h.hi, h.lo);
  const f = () => g.float();
  f.int = (a, b) => a + Math.floor(g.float() * (b - a + 1));
  return f;
}
const lenRange = (p, base) => {
  let l = p ?? base;
  if (isInt(l)) l = [l, l];
  if (!(Array.isArray(l) && l.length === 2 && l.every(isInt) && l[0] <= l[1] && l[0] >= 2 && l[1] <= 16)) throw new Error('length (height) must be an integer or [min, max] in 2..16');
  return l;
};

/**
 * The ceilings of a volume inside `rect`: [{x, z, y (the ceiling's solid cell), air (the headroom), floor (the solid cell under the
 * air)}], one per column (the lowest ceiling with headroom >= HEADROOM under the column's ground - 2), sorted by headroom (most first),
 * then x, z.
 */
export function ceilingsOf(vol, rect, groundAt, aim = null) {
  const out = [];
  for (let x = Math.max(rect.minX, vol.box.minX); x <= Math.min(rect.maxX, vol.box.maxX); x++) {
    for (let z = Math.max(rect.minZ, vol.box.minZ); z <= Math.min(rect.maxZ, vol.box.maxZ); z++) {
      const top = Math.min(vol.box.maxY, groundAt(x, z) - 2);
      let best = null;
      for (let y = top; y > vol.box.minY; y--) {
        const c = classAt(vol, x, y, z);
        if (c !== VC.AIR || !SOLID.has(classAt(vol, x, y + 1, z))) continue;
        let a = 0;
        while (y - a > vol.box.minY && classAt(vol, x, y - a, z) === VC.AIR) a++;
        const below = classAt(vol, x, y - a, z);
        if (a >= HEADROOM && SOLID.has(below)) best = { x, z, y: y + 1, air: a, floor: y - a };
      }
      if (best) out.push(best);
    }
  }
  // most headroom first (a cluster wants room), then nearest the locator's aim, then x, z
  const d = (c) => (aim ? Math.max(Math.abs(c.x - aim[0]), Math.abs(c.z - aim[1])) : 0);
  return out.sort((p, q) => Math.min(q.air, 16) - Math.min(p.air, 16) || d(p) - d(q) || p.x - q.x || p.z - q.z);
}

/** Whether the cell over a root (x, y, z) holds or touches a fluid (vanilla's dripstone grows under a water source there). */
export function growsAt(vol, x, y, z) {
  const ay = y + 1;
  for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) if (FLUID.has(classAt(vol, x + dx, ay + dy, z + dz))) return true;
  return false;
}

/**
 * A stalactite cluster on `site` (a ceiling from ceilingsOf) over `vol`. Returns {generator, version, seed, params, ops, cells, columns,
 * bounds, stats} as the grown generators do; throws GROWS when a root would grow (only the broken variant gets there).
 */
export function stalactites(params, { vol, site, _unsafe = null, keepCell = () => true } = {}) {
  const preset = params.preset ?? 'small';
  const P = STALACTITE_PRESETS[preset];
  if (!P) throw new Error(`stalactites: unknown preset '${preset}' (${Object.keys(STALACTITE_PRESETS).join(', ')})`);
  const length = lenRange(params.height, P.length);
  const seed = String(params.seed ?? '1');
  const rr = rng(seed, 'stalactites', 'cluster');
  const want = rr.int(P.spikes[0], P.spikes[1]);
  const cells = new Map();
  const ops = [];
  const cones = [];
  let skippedGrows = 0;
  const tried = new Set();
  for (let t = 0; t < want * 6 && cones.length < want; t++) {
    const x = site.x + (t === 0 ? 0 : rr.int(-P.spread, P.spread)), z = site.z + (t === 0 ? 0 : rr.int(-P.spread, P.spread));
    if (tried.has(`${x},${z}`)) continue;
    tried.add(`${x},${z}`);
    // this column's ceiling: the air cell under solid nearest the site's own ceiling height
    let ceil = null;
    for (let y = site.y + 3; y >= site.y - 3; y--) if (SOLID.has(classAt(vol, x, y, z)) && classAt(vol, x, y - 1, z) === VC.AIR) { ceil = y; break; }
    if (ceil === null) continue;
    let air = 0;
    while (classAt(vol, x, ceil - 1 - air, z) === VC.AIR && air < 64) air++;
    const floor = ceil - 1 - air;
    if (air < HEADROOM || !SOLID.has(classAt(vol, x, floor, z))) continue;
    if (growsAt(vol, x, ceil, z) && !_unsafe?.stalactiteUnderWater) { skippedGrows++; continue; }
    if (!keepCell(x, ceil, z) || !keepCell(x, floor, z)) continue;
    const L = Math.min(rr.int(length[0], length[1]), air - 1);
    // the floor's cone under it, its tip meeting the stalactite's when they fill the gap (a column)
    const gap = air - L;
    const up = gap <= 2 ? gap : Math.min(gap - 1, rr.int(1, Math.max(1, Math.floor(L / 2))));
    if (L < 1) continue;
    cones.push({ x, z, ceil, floor, L, up, merged: L + up === air });
  }
  if (!cones.length) throw new Error(skippedGrows ? `NO_FEATURE: every ceiling here has water over it (vanilla's dripstone would grow: ${skippedGrows} skipped)` : 'NO_FEATURE: no ceiling with 4 headroom here');
  for (const c of cones) {
    // roots: the ceiling's and the floor's own cells become dripstone blocks
    cells.set(key(c.x, c.ceil, c.z), 'minecraft:dripstone_block');
    const down = thicknessColumn(c.L, c.merged);
    for (let i = 0; i < c.L; i++) cells.set(key(c.x, c.ceil - 1 - i, c.z), `minecraft:pointed_dripstone[thickness=${down[i]},vertical_direction=down,waterlogged=false]`);
    if (c.up > 0) {
      cells.set(key(c.x, c.floor, c.z), 'minecraft:dripstone_block');
      const upT = thicknessColumn(c.up, c.merged);
      for (let i = 0; i < c.up; i++) cells.set(key(c.x, c.floor + 1 + i, c.z), `minecraft:pointed_dripstone[thickness=${upT[i]},vertical_direction=up,waterlogged=false]`);
    }
    // a large cone's core: dripstone blocks round its upper half (a cone primitive, one op per cone), only into air under solid ground
    if (P.core && c.L >= 4) {
      const h = Math.floor(c.L / 2);
      const shape = { kind: 'cone', c: [c.x, { abs: c.ceil - h }, c.z], r0: 0.5, r1: P.core + 0.5, h: h + 1 };
      ops.push({ op: 'shape', shape: { kind: 'union', of: [shape] }, material: 'minecraft:dripstone_block', cond: 0, walk: false });
    }
  }
  if (ops.length) {
    const { cells: core } = formCells(ops);
    for (const [k, s] of core) {
      if (s === AIR || cells.has(k)) continue;
      const [x, y, z] = unkey(k);
      const cl = classAt(vol, x, y, z);
      // the core fills air beside a spike, never past a solid cell (it hangs from the ceiling: its top ring meets the ceiling)
      if (cl !== VC.AIR || !keepCell(x, y, z)) continue;
      cells.set(k, s);
    }
    // nothing floating: a core cell must touch the ceiling or a spike through core cells (connectedTo by the caller's lint is enough)
  }
  // the skeleton ops for the record: one capsuleChain per cone (the spike's axis), at most 32 an op
  const chains = cones.map((c) => ({ kind: 'capsuleChain', points: [[c.x, c.ceil, c.z], [c.x, c.ceil - c.L, c.z]], radii: [0.5, 0.5] }));
  for (let i = 0; i < chains.length; i += 32) ops.push({ op: 'shape', shape: { kind: 'union', of: chains.slice(i, i + 32) }, material: 'minecraft:pointed_dripstone', cond: 0, walk: false });
  return finish('stalactites', seed, { preset, height: length, at: [site.x, site.y, site.z] }, ops, cells, { cones: cones.length, merged: cones.filter((c) => c.merged).length, skippedGrows });
}

/** A face of the volume inside `rect`: [{x, z, top, foot, dx, dz}]: a solid column whose neighbour (dx, dz) drops by at least HEADROOM. */
export function facesOf(vol, rect, groundAt, aim = null) {
  const out = [];
  for (let x = Math.max(rect.minX, vol.box.minX + 1); x <= Math.min(rect.maxX, vol.box.maxX - 1); x++) {
    for (let z = Math.max(rect.minZ, vol.box.minZ + 1); z <= Math.min(rect.maxZ, vol.box.maxZ - 1); z++) {
      const g = groundAt(x, z);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const g2 = groundAt(x + dx, z + dz);
        if (g - g2 < HEADROOM) continue;
        // the face: this column's solid cells from its ground down to the lower ground + 1, with air beside each
        let n = 0;
        for (let y = g; y > g2; y--) if (SOLID.has(classAt(vol, x, y, z)) && classAt(vol, x + dx, y, z + dz) === VC.AIR) n++;
        if (n >= HEADROOM) out.push({ x, z, top: g, foot: g2 + 1, dx, dz, n });
      }
    }
  }
  const d = (c) => (aim ? Math.max(Math.abs(c.x - aim[0]), Math.abs(c.z - aim[1])) : 0);
  return out.sort((p, q) => Math.min(q.n, 8) - Math.min(p.n, 8) || d(p) - d(q) || p.x - q.x || p.z - q.z || p.dx - q.dx || p.dz - q.dz);
}

/**
 * Roots on `site` (a face from facesOf, or a ceiling from ceilingsOf with `ceiling: true`) over `vol`. Returns the grown result as
 * stalactites does.
 */
export function roots(params, { vol, site, ceiling = false, keepCell = () => true } = {}) {
  const preset = params.preset ?? 'dirt';
  const P = ROOT_PRESETS[preset];
  if (!P) throw new Error(`roots: unknown preset '${preset}' (${Object.keys(ROOT_PRESETS).join(', ')})`);
  const length = lenRange(params.height, P.length);
  const seed = String(params.seed ?? '1');
  const rr = rng(seed, 'roots', 'cluster');
  const nChains = rr.int(P.chains[0], P.chains[1]);
  const cells = new Map();
  const shapes = [];
  const solidAt = (x, y, z) => SOLID.has(classAt(vol, x, y, z));
  const airAt = (x, y, z) => classAt(vol, x, y, z) === VC.AIR;
  const put = (x, y, z, s) => { if (keepCell(x, y, z)) cells.set(key(x, y, z), s); };
  if (!ceiling) {
    // chains down the face: along it (perpendicular to (dx, dz)), each from the top to at most `length` down, the face's own cells
    // rooted; every 3 cells a ledge of one rooted cell out of the face, hanging roots under it
    const ax = site.dz !== 0 ? 1 : 0, az = site.dx !== 0 ? 1 : 0;
    for (let i = 0; i < nChains; i++) {
      const off = (i - (nChains >> 1)) * 2 + rr.int(0, 1);
      const x = site.x + ax * off, z = site.z + az * off;
      const L = Math.min(rr.int(length[0], length[1]), site.top - site.foot + 1);
      let y = site.top - 1, w = 0;
      const pts = [];
      for (let s = 0; s < L; s++, y--) {
        if (s && s % 4 === 0) w += rr.int(-1, 1);
        const cx = x + ax * w, cz = z + az * w;
        if (!solidAt(cx, y, cz) || !airAt(cx + site.dx, y, cz + site.dz)) continue;
        put(cx, y, cz, P.block);
        pts.push([cx, y, cz]);
        if (s % 3 === 2 && airAt(cx + site.dx, y - 1, cz + site.dz)) {
          put(cx + site.dx, y, cz + site.dz, P.block);
          if (cells.has(key(cx + site.dx, y, cz + site.dz))) put(cx + site.dx, y - 1, cz + site.dz, 'minecraft:hanging_roots');
        }
      }
      if (pts.length >= 2) shapes.push({ kind: 'capsuleChain', points: [pts[0], pts[pts.length - 1]], radii: [0.6, 0.6] });
    }
  } else {
    // chains along the ceiling from the site: rooted cells in the ceiling's own solid cells, hanging roots in the air under each; a chain
    // whose first step finds no ceiling turns (the site at a cave's edge)
    const ceilAt = (x, z) => { for (let y = site.y + 2; y >= site.y - 2; y--) if (solidAt(x, y, z) && airAt(x, y - 1, z)) return y; return null; };
    put(site.x, site.y, site.z, P.block);
    if (cells.has(key(site.x, site.y, site.z))) put(site.x, site.y - 1, site.z, 'minecraft:hanging_roots');
    const DIR4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (let i = 0; i < nChains; i++) {
      let x = site.x, z = site.z;
      let d0 = rr.int(0, 3);
      for (let t = 0; t < 4 && ceilAt(x + DIR4[d0][0], z + DIR4[d0][1]) === null; t++) d0 = (d0 + 1) % 4;
      const [dx, dz] = DIR4[d0];
      const L = rr.int(length[0], length[1]);
      const pts = [];
      for (let s = 0; s < L; s++) {
        if (s && s % 3 === 0) { if (dx) z += rr.int(-1, 1); else x += rr.int(-1, 1); }
        x += dx; z += dz;
        // this column's ceiling cell near the site's
        const y0 = ceilAt(x, z);
        if (y0 === null) continue;
        put(x, y0, z, P.block);
        if (cells.has(key(x, y0, z)) && (s % 2 === 0)) put(x, y0 - 1, z, 'minecraft:hanging_roots');
        pts.push([x, y0, z]);
      }
      if (pts.length >= 2) shapes.push({ kind: 'capsuleChain', points: [pts[0], pts[pts.length - 1]], radii: [0.6, 0.6] });
    }
  }
  if (!cells.size) throw new Error(`NO_FEATURE: no ${ceiling ? 'ceiling' : 'face'} cell for roots here`);
  // hanging roots only under a written rooted cell (the solid the form writes) or a solid the volume shows
  for (const [k, s] of [...cells]) {
    if (s !== 'minecraft:hanging_roots') continue;
    const [x, y, z] = unkey(k);
    const above = cells.get(key(x, y + 1, z));
    if (!(above && above !== 'minecraft:hanging_roots') && !solidAt(x, y + 1, z)) cells.delete(k);
  }
  const ops = [];
  for (let i = 0; i < shapes.length; i += 32) ops.push({ op: 'shape', shape: { kind: 'union', of: shapes.slice(i, i + 32) }, material: P.block, cond: 0, walk: false });
  return finish('roots', seed, { preset, height: length, at: ceiling ? [site.x, site.y, site.z] : [site.x, site.top, site.z], on: ceiling ? 'ceiling' : 'face' }, ops, cells, { chains: shapes.length, hanging: [...cells.values()].filter((s) => s === 'minecraft:hanging_roots').length });
}

function finish(generator, seed, params, ops, cells, stats) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const k of cells.keys()) {
    const [x, y, z] = unkey(k);
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { generator, version: VERSION, seed, params, ops, cells, columns: columnRuns(cells), bounds: { minX, maxX, minZ, maxZ, minY, maxY }, stats: { ...stats, cells: cells.size } };
}

/** Lint GROWS: no dripstone root a form writes has a fluid over (or beside the cell over) it. Returns null or the error text. */
export function lintGrows(cells, vol) {
  const bad = [];
  for (const [k, s] of cells) {
    if (s !== 'minecraft:dripstone_block') continue;
    const [x, y, z] = unkey(k);
    const below = cells.get(key(x, y - 1, z));
    if (!below || !/vertical_direction=down/.test(below)) continue;
    if (growsAt(vol, x, y, z)) bad.push(k);
  }
  return bad.length ? `GROWS: ${bad.length} stalactite root(s) under water or lava (vanilla's dripstone would grow): ${bad.slice(0, 4).join('; ')}` : null;
}
