// The `scatter` and `stamp` ops (docs/CONTRACT.md 6c F2 §2 and §4; SETTLEMENTS §3.4 "Scatter without a global pass", §9.3,
// §9.4; kit/REGIONS.md "Kit 0.22.0"). Pure and under the realise lint (lib/realise.mjs imports it): integer hashing, no clock,
// only exact Math members.
//
// scatter: the plane is cut into `grid`-sized cells (world-aligned: cell gx covers x = gx*grid .. gx*grid + grid - 1). Each cell's
// 32-bit hashes of (the IR seed, the op's seedLabel, gx, gz) give its one jittered point, whether it fires (the density) and which
// item (the weights) at which quarter turn. A tile evaluates every grid cell whose point can reach it (its 64 columns plus the op's
// largest item radius, at most SCATTER_MAX_RADIUS = 4). A placement's decision reads only the frozen columns of its own footprint
// (within 4 of its point, so within 8 of any cell it writes: K2), the IR's fields and frozen volumes, its lots and keep-out: the same
// seed gives the same placements in any tile order.
//
// stamp: a captured vanilla feature (an ARVB side blob, kind `voxels`) placed with its root cell at `at`, quarter-turned, plus a root
// skirt of each base column's own block down to the frozen ground (at most 6).
import { hash3, fnv64, mix64 } from '../noise.mjs';
import { sampleField } from '../material.mjs';
import { FLAG_FROZEN, FLAG_LAVA, FLAG_MISSING, FLAG_TREE, FLAG_WATER } from './pack.mjs';
import { ROTATIONS, decodeVoxels, turnState, turnXZ, voxelAt } from './voxels.mjs';

/** A scatter item's largest reach from its point (columns, Chebyshev): K2's 8 = the footprint read (4) + the reach (4). */
export const SCATTER_MAX_RADIUS = 4;
export const SCATTER_ANCHORS = Object.freeze(['ground', 'ceiling', 'wall']);
/** A stamp's (and a stamp item's) root skirt reaches at most this far down to the frozen ground. */
export const SKIRT_MAX = 6;
/** At most this many items per scatter op, and grid cells 2..64. */
export const SCATTER_MAX_ITEMS = 64;
/** Voxel classes (lib/region/volume.mjs VOXEL_CLASSES ordinals). */
export const SCATTER_CLASSES = Object.freeze(['AIR', 'ROCK', 'SOIL', 'LOOSE', 'ICE', 'SNOW', 'WATER', 'LAVA', 'LOG', 'LEAVES', 'PLANT', 'OWNED', 'PLAYER', 'BLOCK_ENTITY', 'MISSING']);
const C_AIR = 0, C_ICE = 4, C_SNOW = 5, C_PLANT = 10, C_MISSING = 14;
/** An item whose `on` is SOIL alone is a plant (its vanilla soils, `#minecraft:supports_vegetation`, are that class but for clay and
 * dirt paths): it needs the frozen volume to fire. */
const SOIL_BIT = 1 << 2;
/** The classes a ground item may stand on by default (a solid natural block). */
export const SOLID_CLASSES = Object.freeze(['ROCK', 'SOIL', 'LOOSE', 'ICE', 'SNOW']);
const SOLID_BITS = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5);
/** The cell an item takes must hold one of these (air, a plant, a snow layer): IF_NATURAL replaces them. */
const FREE_BITS = (1 << C_AIR) | (1 << C_PLANT) | (1 << C_SNOW);
/** The faces a block item may name (the face of the block it is attached to, seen from the item). */
export const FACES = Object.freeze(['down', 'up', 'north', 'east', 'south', 'west']);
const WALL_DIRS = [[0, -1, 'north'], [1, 0, 'east'], [0, 1, 'south'], [-1, 0, 'west']];
const DRY = FLAG_WATER | FLAG_LAVA | FLAG_MISSING | FLAG_TREE | FLAG_FROZEN;
const colKey = (x, z) => (x + 33554432) * 67108864 + (z + 33554432);
const isInt = Number.isInteger;

/** The scatter op's 32-bit keys from the IR seed (u64 decimal string) and its label. */
export function scatterKey(seed, label) {
  const h = fnv64(String(seed ?? '0'), 'scatter', String(label));
  return mix64(h.hi, h.lo);
}

/**
 * One grid cell's draw: its point (px, pz), the fire value u16 (fires when u16 < density * 65536), the item draw in [0, total) and
 * the quarter turn. Exposed for the property tests (the density share, tile independence).
 */
export function gridDraw(key, grid, jitter, gx, gz, total) {
  const c = Math.floor(grid / 2);
  const span = 2 * jitter + 1;
  const jx = Math.floor((hash3(key[0], key[1], gx, 0, gz) * span) / 4294967296) - jitter;
  const jz = Math.floor((hash3(key[0], key[1], gx, 1, gz) * span) / 4294967296) - jitter;
  const ox = Math.min(grid - 1, Math.max(0, c + jx)), oz = Math.min(grid - 1, Math.max(0, c + jz));
  const fire = hash3(key[0], key[1], gx, 2, gz) >>> 16;
  const pick = Math.floor((hash3(key[0], key[1], gx, 3, gz) * total) / 4294967296);
  const turn = hash3(key[0], key[1], gx, 4, gz) & 3;
  return { px: gx * grid + ox, pz: gz * grid + oz, fire, pick, turn };
}

/** A quarter turn (clockwise from above, as voxels.mjs) of an offset around the origin, k times. */
function turnOff(dx, dz, k) {
  let a = dx, b = dz;
  for (let i = 0; i < k; i++) { const t = -b; b = a; a = t; }
  return [a, b];
}

/** Classes named in a list -> a bitmask (throws on an unknown name). */
function classBits(list, where) {
  let m = 0;
  for (const n of list) {
    const i = SCATTER_CLASSES.indexOf(n);
    if (i < 0 || i === C_MISSING) throw new Error(`${where}: '${n}' is not a voxel class (${SCATTER_CLASSES.join(', ')})`);
    m |= 1 << i;
  }
  return m;
}

/**
 * A captured or baked body (ARVB bytes) with its root cell, turned k quarter turns: the cells relative to the root (dx, dy, dz,
 * material) and the base columns (those whose lowest cell is the body's bottom layer) for the skirt.
 */
function bodyOf(bytes, root, k, mat, where) {
  const v = decodeVoxels(bytes, where);
  const [sx, , sz] = v.size;
  const [rx, ry, rz] = root;
  if (!(isInt(rx) && isInt(ry) && isInt(rz))) throw new Error(`${where}: root must be 3 integers`);
  const [trx, trz] = turnXZ(rx, rz, sx, sz, k);
  const n = v.count;
  const dx = new Int32Array(n), dy = new Int32Array(n), dz = new Int32Array(n), m = new Int32Array(n);
  const low = new Map(); // column -> [ly, material]
  let r = 0, minDy = Infinity;
  for (let i = 0; i < n; i++) {
    const [lx, ly, lz] = voxelAt(v, i);
    const [tx, tz] = turnXZ(lx, lz, sx, sz, k);
    const st = v.palette[v.pal[i]];
    dx[i] = tx - trx; dy[i] = ly - ry; dz[i] = tz - trz;
    m[i] = mat(st === 'minecraft:air' ? null : turnState(st, k));
    r = Math.max(r, Math.abs(dx[i]), Math.abs(dz[i]));
    if (dy[i] < minDy) minDy = dy[i];
    const ck = colKey(dx[i], dz[i]);
    const l = low.get(ck);
    if (!l || ly < l[0]) low.set(ck, [ly, m[i], dx[i], dz[i]]);
  }
  // the base columns: lowest cell on the body's bottom layer (local y 0)
  const base = [];
  for (const [, l] of low) if (l[0] === 0) base.push(l[2], l[3], l[1]);
  return { n, dx, dy, dz, m, radius: r, bottom: minDy, base: Int32Array.from(base), size: v.size };
}

/**
 * Compile a `stamp` op: `{op: 'stamp', id, blob, root: [x, y, z], at: [x, y, z], rotation, skirt}` (format 2). `ctx`: `{blobBytes(name),
 * mat(state)}`. Returns the compiled fields (kind 5) with its x/z bounds.
 */
export function compileStamp(o, where, ctx) {
  if (typeof o.id !== 'string' || !/^[a-z0-9_.-]+(\/[a-z0-9_.-]+)?$/.test(o.id)) throw new Error(`${where}: stamp id must be '<feature>/<seed>'`);
  if (typeof o.blob !== 'string') throw new Error(`${where}: stamp blob must be a blob name`);
  if (o.mask !== undefined) throw new Error(`${where}: a stamp op takes no mask`);
  const at = o.at;
  if (!Array.isArray(at) || at.length !== 3 || !at.every(isInt)) throw new Error(`${where}: stamp at must be [x, y, z] integers`);
  const rot = o.rotation ?? 0;
  if (!ROTATIONS.includes(rot)) throw new Error(`${where}: stamp rotation must be 0, 90, 180 or 270`);
  const skirt = o.skirt ?? SKIRT_MAX;
  if (!(isInt(skirt) && skirt >= 0 && skirt <= SKIRT_MAX)) throw new Error(`${where}: stamp skirt must be 0..${SKIRT_MAX}`);
  if (!Array.isArray(o.root) || o.root.length !== 3) throw new Error(`${where}: stamp root must be [x, y, z]`);
  const b = bodyOf(ctx.blobBytes(o.blob), o.root, ROTATIONS.indexOf(rot), ctx.mat, `${where} blob ${o.blob}`);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < b.n; i++) {
    const x = at[0] + b.dx[i], z = at[2] + b.dz[i];
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { kind: 5, body: b, at: [at[0], at[1], at[2]], skirt, minX, maxX, minZ, maxZ };
}

/** A stamp's cells in one tile's columns: Map(colKey -> [y, material, ...]) (body first, then the skirt). */
export function stampTileCells(op, x0, z0, env) {
  const out = new Map();
  const b = op.body, [ax, ay, az] = op.at;
  const push = (x, y, z, m) => {
    const k = colKey(x, z);
    let l = out.get(k);
    if (!l) { l = []; out.set(k, l); }
    l.push(y, m);
  };
  emitBody(b, ax, ay, az, x0, z0, op.skirt, env, push);
  return out;
}

/** A body's cells (and skirt) whose columns are in the tile [x0, x0 + 63] x [z0, z0 + 63]. */
function emitBody(b, ax, ay, az, x0, z0, skirt, env, push) {
  // the skirt first, so the body's own bottom cells win where they meet it
  for (let i = 0; i < b.base.length; i += 3) {
    const x = ax + b.base[i], z = az + b.base[i + 1];
    if (x < x0 || x > x0 + 63 || z < z0 || z > z0 + 63 || !skirt) continue;
    const g = env.groundAt(x, z);
    if (g === null) continue;
    const bottom = ay + b.bottom;
    for (let y = bottom - 1, n = 0; y > g && n < skirt; y--, n++) push(x, y, z, b.base[i + 2]);
  }
  for (let i = 0; i < b.n; i++) {
    const x = ax + b.dx[i], z = az + b.dz[i];
    if (x < x0 || x > x0 + 63 || z < z0 || z > z0 + 63) continue;
    push(x, ay + b.dy[i], z, b.m[i]);
  }
}

/**
 * Compile a `scatter` op (format 2): `{op: 'scatter', area: [x0, z0, x1, z1], grid, jitter, density: p | {field, scale: [lo, hi]} |
 * {mask, p?}, mask?, items: [{w, anchor, block | patch | cells, root?, skirt?, on?, melts?, light?, rotate?}], seedLabel, avoid?, lit?,
 * y?: [lo, hi], cond, walk}`. `ctx`: `{blobBytes, mat, fieldNames, fieldFn, compileMask(spec, where), seed, hasVolume, lots, keepOut,
 * claim}`. Returns the compiled fields (kind 4) with the op's x/z bounds (the area plus its items' reach).
 */
export function compileScatter(o, where, ctx) {
  const area = o.area;
  if (!Array.isArray(area) || area.length !== 4 || !area.every(isInt) || area[0] > area[2] || area[1] > area[3]) throw new Error(`${where}: scatter area must be [x0, z0, x1, z1] integers`);
  const grid = o.grid, jitter = o.jitter ?? 0;
  if (!(isInt(grid) && grid >= 2 && grid <= 64)) throw new Error(`${where}: scatter grid must be an integer 2..64`);
  if (!(isInt(jitter) && jitter >= 0 && 2 * jitter < grid)) throw new Error(`${where}: scatter jitter must be an integer 0..(grid - 1) / 2`);
  if (typeof o.seedLabel !== 'string' || !o.seedLabel) throw new Error(`${where}: scatter seedLabel must be a name`);
  const items = o.items;
  if (!Array.isArray(items) || !items.length || items.length > SCATTER_MAX_ITEMS) throw new Error(`${where}: scatter items must be 1..${SCATTER_MAX_ITEMS} items`);
  // density
  let dens;
  const d = o.density;
  if (typeof d === 'number') {
    if (!(d >= 0 && d <= 1)) throw new Error(`${where}: scatter density must be 0..1`);
    dens = { kind: 0, p: Math.floor(d * 65536) };
  } else if (d && typeof d === 'object' && d.field !== undefined) {
    if (!ctx.fieldNames.has(d.field)) throw new Error(`${where}: scatter density field '${d.field}' is not one of the IR's fields`);
    const s = d.scale;
    if (!Array.isArray(s) || s.length !== 2 || !(typeof s[0] === 'number' && typeof s[1] === 'number') || !(s[1] > s[0])) throw new Error(`${where}: scatter density scale must be [lo, hi] with lo < hi`);
    dens = { kind: 1, f: ctx.fieldFn(d.field), lo: s[0], hi: s[1] };
  } else if (d && typeof d === 'object' && d.mask !== undefined) {
    const p = d.p ?? 1;
    if (!(typeof p === 'number' && p >= 0 && p <= 1)) throw new Error(`${where}: scatter density p must be 0..1`);
    dens = { kind: 2, p: Math.floor(p * 65536), mask: ctx.compileMask(d.mask, `${where} density mask`) };
  } else throw new Error(`${where}: scatter density must be a number, {field, scale} or {mask, p}`);
  const mask = o.mask === undefined ? null : ctx.compileMask(o.mask, `${where} mask`);
  const fieldOf = (name, what) => {
    if (name === undefined || name === null) return null;
    if (!ctx.fieldNames.has(name)) throw new Error(`${where}: scatter ${what} '${name}' is not one of the IR's fields`);
    return ctx.fieldFn(name);
  };
  const avoid = fieldOf(o.avoid, 'avoid'), lit = fieldOf(o.lit, 'lit');
  let yRange = null;
  if (o.y !== undefined) {
    if (!Array.isArray(o.y) || o.y.length !== 2 || !o.y.every(isInt) || o.y[0] > o.y[1]) throw new Error(`${where}: scatter y must be [lo, hi] integers`);
    yRange = [o.y[0], o.y[1]];
  }
  let total = 0, radius = 0;
  const its = items.map((it, i) => {
    const w2 = `${where} item ${i}`;
    if (!(isInt(it.w) && it.w >= 1 && it.w <= 1000)) throw new Error(`${w2}: w must be an integer 1..1000`);
    const anchor = it.anchor ?? 'ground';
    if (!SCATTER_ANCHORS.includes(anchor)) throw new Error(`${w2}: anchor must be ${SCATTER_ANCHORS.join(', ')}`);
    if (anchor !== 'ground' && !yRange) throw new Error(`${w2}: a ${anchor} anchor needs the op's y range ([lo, hi]: where it looks in the frozen volume)`);
    const kinds = ['block', 'patch', 'cells'].filter((k) => it[k] !== undefined);
    if (kinds.length !== 1) throw new Error(`${w2}: an item is exactly one of block, patch or cells`);
    if (anchor !== 'ground' && kinds[0] !== 'block') throw new Error(`${w2}: a ${anchor} item is a block`);
    const c = { w: it.w, anchor, kind: kinds[0], on: classBits(it.on ?? SOLID_CLASSES, `${w2} on`), melts: !!it.melts, rotate: it.rotate !== false, light: null, radius: 0 };
    if (c.kind === 'block') {
      if (typeof it.block === 'string') c.faces = FACES.map(() => ctx.mat(it.block));
      else if (it.block && typeof it.block === 'object') {
        for (const k of Object.keys(it.block)) if (!FACES.includes(k)) throw new Error(`${w2}: block faces are ${FACES.join(', ')}`);
        c.faces = FACES.map((f) => (it.block[f] === undefined ? -1 : ctx.mat(it.block[f])));
      } else throw new Error(`${w2}: block must be a block state or {face: blockState}`);
    } else if (c.kind === 'patch') {
      if (!Array.isArray(it.patch) || !it.patch.length || it.patch.length > 81) throw new Error(`${w2}: patch must be 1..81 [dx, dz, state, upper?] entries`);
      c.rot = [0, 1, 2, 3].map((k) => {
        const e = new Int32Array(it.patch.length * 4);
        it.patch.forEach((p, j) => {
          if (!Array.isArray(p) || p.length < 3 || !isInt(p[0]) || !isInt(p[1]) || typeof p[2] !== 'string') throw new Error(`${w2}: patch entry ${j} must be [dx, dz, state, upper?]`);
          const [a, b] = turnOff(p[0], p[1], k);
          e[j * 4] = a; e[j * 4 + 1] = b; e[j * 4 + 2] = ctx.mat(turnState(p[2], k)); e[j * 4 + 3] = typeof p[3] === 'string' ? ctx.mat(turnState(p[3], k)) : -1;
        });
        return e;
      });
      for (const p of it.patch) c.radius = Math.max(c.radius, Math.abs(p[0]), Math.abs(p[1]));
    } else {
      if (typeof it.cells !== 'string') throw new Error(`${w2}: cells must be a blob name (ARVB, kind voxels)`);
      const bytes = ctx.blobBytes(it.cells);
      c.rot = [0, 1, 2, 3].map((k) => bodyOf(bytes, it.root ?? [0, 0, 0], k, ctx.mat, `${w2} blob ${it.cells}`));
      c.radius = c.rot[0].radius;
      c.skirt = it.skirt ?? 0;
      if (!(isInt(c.skirt) && c.skirt >= 0 && c.skirt <= SKIRT_MAX)) throw new Error(`${w2}: skirt must be 0..${SKIRT_MAX}`);
    }
    c.cellRadius = c.radius; // the item's own cells (the avoid and lit fields); `radius` adds a light's melt reach (claim, lots, keep-out)
    if (it.light !== undefined) {
      const L = it.light;
      if (!Array.isArray(L) || L.length !== 4 || !L.every(isInt) || L[3] < 1 || L[3] > 15) throw new Error(`${w2}: light must be [dx, dy, dz, level 1..15] (the item's emitter)`);
      c.light = L;
      // a light melts snow layers within (level - 12) and ice within (level - 11) (Manhattan, M17): the item clears its reach
      c.radius = Math.max(c.radius, Math.abs(L[0]) + Math.max(0, L[3] - 12), Math.abs(L[2]) + Math.max(0, L[3] - 12));
    }
    if (c.radius > SCATTER_MAX_RADIUS) throw new Error(`${w2}: reach ${c.radius} is over ${SCATTER_MAX_RADIUS} (a larger item is not scatter: place it as an explicit op)`);
    // an item stays inside its own grid cell (so placements never overlap: a later one can't take an earlier one's support)
    if (2 * c.cellRadius + 1 > grid) throw new Error(`${w2}: its cells reach ${c.cellRadius} from its point, which needs a grid of at least ${2 * c.cellRadius + 1} (got ${grid})`);
    total += c.w;
    radius = Math.max(radius, c.radius);
    return c;
  });
  const cum = new Int32Array(its.length);
  let acc = 0;
  its.forEach((c, i) => { acc += c.w; cum[i] = acc; });
  const lots = (ctx.lots ?? []).map((l) => [l.box.minX - 1, l.box.minZ - 1, l.box.maxX + 1, l.box.maxZ + 1]);
  // (F1's keepNatural) the IR's kept natural cells: a placement that would write one is not placed (the frozen volume's class)
  const keep = (ctx.keep ?? []).map((k) => ({ c: SCATTER_CLASSES.indexOf(k.class), b: k.box })).filter((k) => k.c >= 0);
  const keepOut = (ctx.keepOut ?? []).map((k) => [k[0], k[1], k[2], k[3]]);
  return {
    kind: 4, area: [area[0], area[1], area[2], area[3]], grid, jitter, key: scatterKey(ctx.seed, o.seedLabel), dens, mask, avoid, lit, yRange,
    items: its, total, cum, radius, lots, keepOut, keep, claim: ctx.claim,
    minX: area[0] - radius, maxX: area[2] + radius, minZ: area[1] - radius, maxZ: area[3] + radius,
  };
}

/** Does the rect [x0, z0, x1, z1] meet any of `rects`? */
function meets(rects, x0, z0, x1, z1) {
  for (const r of rects) if (x0 <= r[2] && r[0] <= x1 && z0 <= r[3] && r[1] <= z1) return true;
  return false;
}

/**
 * A scatter op's cells in one tile: Map(colKey -> [y, material, ...]) in placement order (grid cells by z then x; a later
 * placement wins a shared cell). `env`: `{groundAt(x, z) -> frozen ground | null (missing), flagsAt(x, z), classAt(x, y, z) -> class
 * index | null (no volume), reliefTop(x, z, g) -> g', maskCol}`. `stats` (optional) counts the decisions (the property tests).
 */
export function scatterTileCells(op, x0, z0, env, stats = null) {
  const out = new Map();
  const push = (x, y, z, m) => {
    if (x < x0 || x > x0 + 63 || z < z0 || z > z0 + 63) return;
    const k = colKey(x, z);
    let l = out.get(k);
    if (!l) { l = []; out.set(k, l); }
    l.push(y, m);
  };
  // the lights' melt clearing (air over natural snow layers) goes under every placement's own cells: a clearing never takes a
  // neighbouring placement's post or plant
  const pre = new Map();
  const clear = (x, y, z) => {
    if (x < x0 || x > x0 + 63 || z < z0 || z > z0 + 63) return;
    const k = colKey(x, z);
    let l = pre.get(k);
    if (!l) { l = []; pre.set(k, l); }
    l.push(y, 0);
  };
  const R = op.radius, G = op.grid, A = op.area, C = op.claim;
  const lo = [Math.max(A[0], x0 - R), Math.max(A[1], z0 - R)], hi = [Math.min(A[2], x0 + 63 + R), Math.min(A[3], z0 + 63 + R)];
  if (lo[0] > hi[0] || lo[1] > hi[1]) return out;
  // the frozen volume's class of a cell, or null (no volume there): without it a plant never fires, anything else trusts the survey
  const cls = env.hasVolume ? env.classAt : null;
  const free = (x, y, z) => { if (!cls) return true; const c = cls(x, y, z); return c === null || ((1 << c) & FREE_BITS) !== 0; };
  // a kept natural cell (F1's keepNatural): never written
  const kept = (x, y, z) => {
    if (!cls || !op.keep.length) return false;
    for (const k of op.keep) { const b = k.b; if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ && cls(x, y, z) === k.c) return true; }
    return false;
  };
  const stands = (it, x, g, g0, z) => {
    const plant = it.on === SOIL_BIT;
    const sc = cls && g === g0 ? cls(x, g, z) : null; // a relief-moved column stands on the relief's fill: no plant on it
    return sc === null ? !plant : ((1 << sc) & it.on) !== 0;
  };
  for (let gz = Math.floor(lo[1] / G); gz <= Math.floor(hi[1] / G); gz++) {
    for (let gx = Math.floor(lo[0] / G); gx <= Math.floor(hi[0] / G); gx++) {
      const dr = gridDraw(op.key, G, op.jitter, gx, gz, op.total);
      let ii = 0;
      while (op.cum[ii] <= dr.pick) ii++;
      const it = op.items[ii];
      // the point, kept so the item's cells stay inside its grid cell (placements never overlap within an op)
      const cr = it.cellRadius;
      const px = gx * G + Math.min(G - 1 - cr, Math.max(cr, dr.px - gx * G)), pz = gz * G + Math.min(G - 1 - cr, Math.max(cr, dr.pz - gz * G));
      if (px < lo[0] || px > hi[0] || pz < lo[1] || pz > hi[1]) continue;
      // the density (a field's density reads the point's sample; a mask density waits for the anchor)
      let p = op.dens.p;
      if (op.dens.kind === 1) {
        const v = sampleField(op.dens.f, px, pz);
        p = v <= op.dens.lo ? 0 : v >= op.dens.hi ? 65536 : Math.floor(((v - op.dens.lo) * 65536) / (op.dens.hi - op.dens.lo));
      }
      if (stats) stats.cells++;
      if (dr.fire >= p) continue;
      if (stats) stats.fired++;
      const k = it.rotate ? dr.turn : 0;
      const r = it.radius;
      // hard exclusions: the claim, the lots (box and apron), keep-out, then the avoid / lit fields over the footprint
      if (px - r < C.minX || px + r > C.maxX || pz - r < C.minZ || pz + r > C.maxZ || meets(op.lots, px - r, pz - r, px + r, pz + r) || meets(op.keepOut, px - r, pz - r, px + r, pz + r)) { if (stats) stats.excluded++; continue; }
      if (op.avoid || (op.lit && it.melts)) {
        let bad = false;
        for (let dz = -cr; dz <= cr && !bad; dz++) for (let dx = -cr; dx <= cr; dx++) {
          if ((op.avoid && sampleField(op.avoid, px + dx, pz + dz) > 0) || (op.lit && it.melts && sampleField(op.lit, px + dx, pz + dz) > 0)) { bad = true; break; }
        }
        if (bad) { if (stats) stats.excluded++; continue; }
      }
      // the anchor
      let ay, face = 0;
      if (it.anchor === 'ground') {
        const g0 = env.groundAt(px, pz);
        if (g0 === null || (env.flagsAt(px, pz) & DRY)) { if (stats) stats.unsupported++; continue; }
        const g = env.reliefTop(px, pz, g0);
        ay = g + 1;
        if (!stands(it, px, g, g0, pz) || !free(px, ay, pz)) { if (stats) stats.unsupported++; continue; }
      } else {
        if (!cls) { if (stats) stats.unsupported++; continue; } // ceiling and wall anchors read the frozen volume (MISSING outside it)
        const [ylo, yhi] = op.yRange;
        ay = null;
        for (let y = ylo; y <= yhi && ay === null; y++) {
          if (cls(px, y, pz) !== C_AIR) continue; // (null outside every volume: never an anchor)
          if (it.anchor === 'ceiling') { const c = cls(px, y + 1, pz); if (c !== null && ((1 << c) & SOLID_BITS)) { ay = y; face = 1; } }
          else {
            for (let q = 0; q < 4; q++) {
              const [ddx, ddz] = WALL_DIRS[(q + dr.turn) & 3];
              const c = cls(px + ddx, y, pz + ddz);
              if (c !== null && ((1 << c) & SOLID_BITS)) { ay = y; face = 2 + ((q + dr.turn) & 3); break; }
            }
          }
        }
        if (ay === null) { if (stats) stats.unsupported++; continue; }
      }
      if (op.dens.kind === 2 && !op.dens.mask(px, ay, pz, env.maskCol(px, pz))) { if (stats) stats.masked++; continue; }
      if (op.mask && !op.mask(px, ay, pz, env.maskCol(px, pz))) { if (stats) stats.masked++; continue; }
      // a light: no ice within its melt reach (the frozen volume), no tree column within its snow reach
      if (it.light) {
        const [ldx0, ldy, ldz0, L] = it.light;
        const [ldx, ldz] = turnOff(ldx0, ldz0, k);
        const lx = px + ldx, ly = ay + ldy, lz = pz + ldz;
        let bad = false;
        const ri = L - 11, rs = L - 12;
        if (cls && ri > 0) {
          for (let dx = -ri; dx <= ri && !bad; dx++) for (let dz = -ri; dz <= ri && !bad; dz++) {
            const rem = ri - Math.abs(dx) - Math.abs(dz);
            if (rem < 0) continue;
            // the column's snow layer (the cell over its frozen ground) is cleared below; any other snow (a snow block, a layer on a
            // ledge) within the snow reach is not: the checker reads natural snow as a block it can't tell from a layer (M17)
            const gc = env.groundAt(lx + dx, lz + dz);
            for (let dy = -rem; dy <= rem; dy++) {
              const c = cls(lx + dx, ly + dy, lz + dz);
              if (c === C_ICE || (c === C_SNOW && Math.abs(dx) + Math.abs(dz) + Math.abs(dy) <= rs && ly + dy !== (gc ?? -32768) + 1)) { bad = true; break; }
            }
          }
        }
        for (let dx = -rs; dx <= rs && !bad; dx++) for (let dz = -rs; dz <= rs; dz++) {
          if (Math.abs(dx) + Math.abs(dz) > rs) continue;
          const f = env.flagsAt(lx + dx, lz + dz);
          if (f & (FLAG_TREE | FLAG_FROZEN | FLAG_MISSING)) { bad = true; break; }
        }
        if (bad) { if (stats) stats.unsupported++; continue; }
      }
      // a body never writes a kept cell (nor does its skirt)
      if (it.kind === 'cells' && op.keep.length && cls) {
        const b = it.rot[k];
        let hit = false;
        for (let q = 0; q < b.n && !hit; q++) hit = kept(px + b.dx[q], ay + b.dy[q], pz + b.dz[q]);
        for (let q = 0; q < b.base.length && !hit && it.skirt; q += 3) {
          const x = px + b.base[q], z = pz + b.base[q + 1], g = env.groundAt(x, z);
          if (g === null) continue;
          for (let y = ay + b.bottom - 1, n = 0; y > g && n < it.skirt && !hit; y--, n++) hit = kept(x, y, z);
        }
        if (hit) { if (stats) stats.excluded++; continue; }
      }
      if (it.kind === 'block' && kept(px, ay, pz)) { if (stats) stats.excluded++; continue; }
      if (stats) stats.placed++;
      // emit
      if (it.kind === 'block') {
        const m = it.faces[face];
        if (m < 0) { if (stats) stats.placed--; continue; }
        push(px, ay, pz, m);
      } else if (it.kind === 'patch') {
        const e = it.rot[k];
        for (let j = 0; j < e.length; j += 4) {
          const x = px + e[j], z = pz + e[j + 1];
          const g0 = env.groundAt(x, z);
          if (g0 === null || (env.flagsAt(x, z) & DRY)) continue;
          const g = env.reliefTop(x, z, g0);
          if (Math.abs(g - (ay - 1)) > 2) continue;
          if (!stands(it, x, g, g0, z) || !free(x, g + 1, z) || (e[j + 3] >= 0 && !free(x, g + 2, z)) || kept(x, g + 1, z) || (e[j + 3] >= 0 && kept(x, g + 2, z))) continue;
          push(x, g + 1, z, e[j + 2]);
          if (e[j + 3] >= 0) push(x, g + 2, z, e[j + 3]);
        }
      } else {
        const b = it.rot[k];
        // the root column rests on the ground (the body is connected; the skirt fills under its base columns)
        emitBody(b, px, ay, pz, x0, z0, it.skirt, env, push);
      }
      if (it.light && cls) {
        // clear the natural snow layers within the light's snow reach (the cell above each column's frozen ground)
        const [ldx0, , ldz0, L] = it.light;
        const [ldx, ldz] = turnOff(ldx0, ldz0, k);
        const rs = L - 12;
        for (let dx = -rs; dx <= rs; dx++) for (let dz = -rs; dz <= rs; dz++) {
          if (Math.abs(dx) + Math.abs(dz) > rs) continue;
          const x = px + ldx + dx, z = pz + ldz + dz;
          const g = env.groundAt(x, z);
          if (g === null || x < x0 || x > x0 + 63 || z < z0 || z > z0 + 63) continue;
          if (cls(x, g + 1, z) === C_SNOW && !(x === px && z === pz) && !kept(x, g + 1, z)) {
            // never over the item's own cells (they are pushed already: a later push would win)
            let own = false;
            if (it.kind === 'cells') { const b = it.rot[k]; for (let q = 0; q < b.n; q++) if (px + b.dx[q] === x && pz + b.dz[q] === z && ay + b.dy[q] === g + 1) { own = true; break; } }
            if (!own) clear(x, g + 1, z);
          }
        }
      }
    }
  }
  if (!pre.size) return out;
  for (const [k, l] of pre) { const b = out.get(k); out.set(k, b ? [...l, ...b] : l); }
  return out;
}

/** A body's reach from its root (Chebyshev, x/z) and its turned x/z extent relative to the root, from ARVB bytes. */
function bodyReach(bytes, root, rotation = 0) {
  const b = bodyOf(bytes, root, ROTATIONS.indexOf(rotation), () => 0, 'blob');
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < b.n; i++) { minX = Math.min(minX, b.dx[i]); maxX = Math.max(maxX, b.dx[i]); minZ = Math.min(minZ, b.dz[i]); maxZ = Math.max(maxZ, b.dz[i]); }
  return { radius: b.radius, minX, maxX, minZ, maxZ };
}

/** (plan time) A scatter op's x/z bounds: its area plus its items' largest reach (y: column-dependent). */
export function scatterBounds(op, bytesOf) {
  let r = 0;
  for (const it of op.items ?? []) {
    if (Array.isArray(it.patch)) for (const p of it.patch) r = Math.max(r, Math.abs(p[0]), Math.abs(p[1]));
    if (typeof it.cells === 'string') r = Math.max(r, bodyReach(bytesOf(it.cells), it.root ?? [0, 0, 0]).radius);
    if (Array.isArray(it.light)) r = Math.max(r, Math.abs(it.light[0]) + Math.max(0, it.light[3] - 12), Math.abs(it.light[2]) + Math.max(0, it.light[3] - 12));
  }
  const a = op.area;
  return { minX: a[0] - r, maxX: a[2] + r, minZ: a[1] - r, maxZ: a[3] + r, minY: null, maxY: null };
}

/** (plan time) A stamp op's x/z bounds: its turned body at `at` (the skirt is under its own columns); y from the body. */
export function stampBounds(op, bytesOf) {
  const e = bodyReach(bytesOf(op.blob), op.root, op.rotation ?? 0);
  return { minX: op.at[0] + e.minX, maxX: op.at[0] + e.maxX, minZ: op.at[2] + e.minZ, maxZ: op.at[2] + e.maxZ, minY: null, maxY: null };
}
