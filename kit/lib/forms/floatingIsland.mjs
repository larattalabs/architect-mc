// The `floatingIsland` generator, version 1 (docs/CONTRACT.md 6b §4.1, SETTLEMENTS §9.1-9.2). Plan time only: it grows
// an island as closed-library shapes (a flattened ellipsoid top with noise relief, an inverted warped cone underside,
// hanging roots as capsuleChains) and returns ordinary IR ops, one bounded op per cluster (the body; each root cluster;
// the pads; the rim rail; the lamp posts), at most 32 primitives per op. Integer or exactly specified float maths only:
// no trig (compassDir), no Math.random, no Date. Deterministic: the same params and seed give byte-identical ops.
import { fnv64, splitmix64 } from '../noise.mjs';
import { columnCells, compileShape, sdAt } from '../sdf.mjs';
import { compassDir } from '../region/geom.mjs';

export const GENERATOR = 'floatingIsland';
export const VERSION = 1;
const round = (v) => Math.floor(v + 0.5);
const isInt = Number.isInteger;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** The default material rule `island`, with role names (resolved through the bible by the planner). */
export function islandRule(seed, bandsFrom) {
  const ore = { kind: 'value', dims: 3, scale: 3, octaves: 1, seed: fnv64(seed, 'island-ore').hex };
  const clauses = [
    { when: { depth: [0, 0], facing: 'up' }, mat: 'surface' },
    { when: { depth: [0, 3], facing: 'up' }, mat: 'subsurface' },
    { when: { depth: [1, 3] }, mat: 'subsurface' },
    { when: { depth: [6, 999], noise: ore, gte: 0.62 }, mat: 'minecraft:coal_ore' },
  ];
  // strata: bands every 3 cells; alternate andesite and tuff over the island's own bands, at depth 4 and over
  for (let b = bandsFrom; b < bandsFrom + 24; b++) {
    if (b % 3 === 0) clauses.push({ when: { depth: [4, 999], band: [b, b] }, mat: 'minecraft:andesite' });
    else if (b % 3 === 1) clauses.push({ when: { depth: [4, 999], band: [b, b] }, mat: 'minecraft:tuff' });
  }
  return { rule: clauses, default: 'rock', dither: 'ordered4' };
}

function rng(seed, label) {
  const h = fnv64(seed, 'floatingIsland', label);
  const g = splitmix64(h.hi, h.lo);
  const f = () => g.float();
  f.int = (a, b) => a + Math.floor(g.float() * (b - a + 1));
  return f;
}

/** Validate the params; returns them with defaults filled. */
export function islandParams(p) {
  const o = {
    at: p.at, r: p.r, thickness: p.thickness ?? 16, seed: String(p.seed ?? '1'),
    top: { relief: p.top?.relief ?? 2, pads: p.top?.pads ?? [], edge: p.top?.edge ?? 'rail', lights: p.top?.lights ?? 0 },
    underside: { taper: p.underside?.taper ?? 0.7, roots: p.underside?.roots ?? 4 },
    materials: p.materials ?? 'island',
    anchorAt: p.anchorAt ?? null,
  };
  if (o.anchorAt !== null && !(Array.isArray(o.anchorAt) && o.anchorAt.length === 2 && o.anchorAt.every(isInt))) throw new Error('floatingIsland: anchorAt must be [x, z] integers');
  if (!Array.isArray(o.at) || o.at.length !== 3 || !o.at.every(isInt)) throw new Error('floatingIsland: at must be [x, y, z] integers');
  if (!Array.isArray(o.r) || o.r.length !== 2 || !o.r.every((v) => isNum(v) && v >= 4 && v <= 96)) throw new Error('floatingIsland: r must be [rx, rz], 4..96');
  if (!(isInt(o.thickness) && o.thickness >= 4 && o.thickness <= 96)) throw new Error('floatingIsland: thickness must be 4..96');
  if (!(isInt(o.top.relief) && o.top.relief >= 0 && o.top.relief <= 4)) throw new Error('floatingIsland: top.relief must be 0..4');
  if (!(isNum(o.underside.taper) && o.underside.taper >= 0.3 && o.underside.taper <= 0.9)) throw new Error('floatingIsland: underside.taper must be 0.3..0.9');
  if (!(isInt(o.underside.roots) && o.underside.roots >= 0 && o.underside.roots <= 12)) throw new Error('floatingIsland: underside.roots must be 0..12');
  if (![null, 'rail', 'wall'].includes(o.top.edge)) throw new Error("floatingIsland: top.edge must be 'rail', 'wall' or null");
  if (!(isInt(o.top.lights) && o.top.lights >= 0 && o.top.lights <= 32)) throw new Error('floatingIsland: top.lights must be 0 (none) or a spacing 4..32');
  for (const [i, pad] of o.top.pads.entries()) {
    if (!Array.isArray(pad.at) || !Array.isArray(pad.size) || !pad.at.every(isInt) || !pad.size.every((v) => isInt(v) && v >= 1)) throw new Error(`floatingIsland: pad ${i} needs at: [x, z] and size: [w, d] integers`);
    if (pad.landing !== undefined && typeof pad.landing !== 'boolean') throw new Error(`floatingIsland: pad ${i} landing must be a boolean`);
  }
  return o;
}

/**
 * Grow an island. Returns `{ops, bounds, anchor, pads: [{at, size, y}], top: Map("x,z" -> top y), generator, version,
 * params, seed}`. Ops carry role names (`surface`, `subsurface`, `rock`, `rail`) for the planner to resolve.
 */
export function floatingIsland(params) {
  const p = islandParams(params);
  const [x, y, z] = p.at;
  const [rx, rz] = p.r;
  const R = Math.min(rx, rz);
  const seed = p.seed;
  const relief = p.top.relief;
  const amp = Math.min(6, Math.max(2, round(R / 6)));
  const topH = Math.max(3, relief + 3);
  // the body: a flattened ellipsoid top (relief by 2D noise, clipped flat at y + relief) over an inverted cone underside
  const reliefNoise = { kind: 'value', dims: 2, scale: Math.max(6, round(R / 2)), octaves: 2, seed: fnv64(seed, 'island-relief').hex };
  const top = relief > 0
    ? { kind: 'clipY', y0: null, y1: { abs: y + relief }, of: { kind: 'displace', amp: relief, noise: reliefNoise, of: { kind: 'ellipsoid', c: [x, { abs: y }, z], r: [rx, topH, rz] } } }
    : { kind: 'clipY', y0: null, y1: { abs: y }, of: { kind: 'ellipsoid', c: [x, { abs: y }, z], r: [rx, topH, rz] } };
  const coneH = p.thickness;
  const r0 = Math.max(1, R * (1 - p.underside.taper));
  const cone = { kind: 'cone', c: [x, { abs: y - coneH }, z], r0, r1: R * 0.96, h: coneH + 1 };
  const warpNoise = { kind: 'value', dims: 3, scale: Math.max(8, round(R / 2)), octaves: 1, seed: fnv64(seed, 'island-warp').hex };
  // the warp bends the whole body; the top is clipped again after it, so the walkable top never rises over y + relief
  const warped = { kind: 'clipY', y0: null, y1: { abs: y + relief }, of: { kind: 'warp', amp, noise: warpNoise, of: { kind: 'union', of: [top, { kind: 'clipY', y0: null, y1: { abs: y }, of: cone }] } } };
  const bandsFrom = Math.floor((y - coneH - amp - 8) / 3);
  const body = { kind: 'strata', bands: { every: 3, offset: 0 }, of: warped };
  const rule = p.materials === 'island' ? islandRule(seed, bandsFrom) : p.materials;
  const ops = [{ op: 'shape', shape: body, material: { rule }, cond: 2, walk: false }];

  // the body's cells (plan time): the warp can leave small fragments at the rim; keep the largest face-connected
  // component and clear the rest (a trim op), so the island is one piece (M3 floating)
  const node = compileShape(body);
  const col = { g: 0, h: 0, f: 0 };
  const cells = new Set();
  const key = (a, b, c) => `${a},${b},${c}`;
  for (let zz = Math.floor(node.minZ); zz <= Math.ceil(node.maxZ); zz++) for (let xx = Math.floor(node.minX); xx <= Math.ceil(node.maxX); xx++) {
    columnCells(node, xx, zz, col, y - coneH - 2 * amp - 2, y + relief + amp + 2, (yy) => cells.add(key(xx, yy, zz)));
  }
  let best = null;
  const seen = new Set();
  for (const c0 of [...cells].sort()) {
    if (seen.has(c0)) continue;
    const comp = [c0];
    seen.add(c0);
    for (let i = 0; i < comp.length; i++) {
      const [a, b, c] = comp[i].split(',').map(Number);
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const n = key(a + dx, b + dy, c + dz);
        if (cells.has(n) && !seen.has(n)) { seen.add(n); comp.push(n); }
      }
    }
    if (!best || comp.length > best.length) best = comp;
  }
  const keep = new Set(best ?? []);
  const trim = [];
  for (const c of [...cells].sort()) if (!keep.has(c)) { const [a, b, cc] = c.split(',').map(Number); trim.push(a, cc, b, b, 0); }
  if (trim.length) ops.push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: trim, materials: [null], cond: 2, walk: false });
  const topY = new Map();
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (const c of keep) {
    const [xx, yy, zz] = c.split(',').map(Number);
    const k = `${xx},${zz}`;
    if (!(topY.get(k) >= yy)) topY.set(k, yy);
    if (xx < bx0) bx0 = xx; if (xx > bx1) bx1 = xx; if (zz < bz0) bz0 = zz; if (zz > bz1) bz1 = zz;
    if (yy < by0) by0 = yy; if (yy > by1) by1 = yy;
  }

  // hanging roots: one capsuleChain cluster per op, starting deep inside the unwarped cone (margin > amp * sqrt 3)
  const rr = rng(seed, 'roots');
  for (let k = 0; k < p.underside.roots; k++) {
    const d = compassDir((360 * k) / Math.max(1, p.underside.roots) + rr.int(0, 30));
    const t = 0.35 + 0.15 * rr();                 // depth fraction under the top
    const yy = round(y - coneH * t);
    const rad = (R * (1 - t) + r0 * t) * 0.4;     // inside the cone's radius there by a margin
    const sx = round(x + d[0] * rad), sz = round(z + d[1] * rad);
    const n = rr.int(3, 6);
    const pts = [[sx, yy, sz]];
    const radii = [1.8];
    let cx = sx, cy = yy, cz2 = sz;
    for (let i = 1; i <= n; i++) {
      cx += round(d[0] * 2 + (rr() - 0.5) * 2); cz2 += round(d[1] * 2 + (rr() - 0.5) * 2); cy -= rr.int(2, 4);
      pts.push([cx, cy, cz2]);
      radii.push(Math.max(1, 1.8 - (0.8 * i) / n));
    }
    ops.push({ op: 'shape', shape: { kind: 'capsuleChain', points: pts, radii }, material: 'minecraft:rooted_dirt', cond: 2, walk: false });
    for (const q of pts) {
      if (q[1] - 2 < by0) by0 = q[1] - 2;
      if (q[0] - 2 < bx0) bx0 = q[0] - 2; if (q[0] + 2 > bx1) bx1 = q[0] + 2;
      if (q[2] - 2 < bz0) bz0 = q[2] - 2; if (q[2] + 2 > bz1) bz1 = q[2] + 2;
    }
  }

  // pads: exactly flat at y, carved into the relief, solid under them to depth 3 (and down into the body)
  const padsOut = [];
  for (const pad of p.top.pads) {
    const [px, pz] = pad.at, [w, dd] = pad.size;
    ops.push({ op: 'shape', shape: { kind: 'box', min: [px, { abs: y + 1 }, pz], max: [px + w - 1, { abs: y + relief + amp + 2 }, pz + dd - 1] }, material: null, cond: 3, walk: false });
    ops.push({ op: 'shape', shape: { kind: 'box', min: [px, { abs: y - 3 - amp }, pz], max: [px + w - 1, { abs: y - 1 }, pz + dd - 1] }, material: 'subsurface', cond: 3, walk: false });
    ops.push({ op: 'shape', shape: { kind: 'box', min: [px, { abs: y }, pz], max: [px + w - 1, { abs: y }, pz + dd - 1] }, material: 'surface', cond: 3, walk: false });
    for (let zz = pz; zz < pz + dd; zz++) for (let xx = px; xx < px + w; xx++) topY.set(`${xx},${zz}`, y);
    padsOut.push({ at: [px, pz], size: [w, dd], y });
  }
  const inPad = (xx, zz, m = 0, lotsOnly = false) => p.top.pads.some((pd) => !(lotsOnly && pd.landing) && xx >= pd.at[0] - m && xx < pd.at[0] + pd.size[0] + m && zz >= pd.at[1] - m && zz < pd.at[1] + pd.size[1] + m);

  // the rim: a rail (or a 2-high wall) on every top cell beside a drop over 3 (M8)
  if (p.top.edge) {
    const rim = [];
    for (const [k, ty] of topY) {
      const [xx, zz] = k.split(',').map(Number);
      if (inPad(xx, zz, 0, true)) continue; // a lot stands on the pad: its building guards its own edge (landings are railed)
      const drop = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const n = topY.get(`${xx + dx},${zz + dz}`); return n === undefined || ty - n > 3; });
      if (drop) rim.push([xx, zz, ty]);
    }
    rim.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const h = p.top.edge === 'wall' ? 2 : 1;
    const cols = [];
    for (const [xx, zz, ty] of rim) cols.push(xx, zz, ty + 1, ty + h, 0);
    if (cols.length) ops.push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: [p.top.edge === 'wall' ? 'rubble' : 'rail'], cond: 2, walk: false });
  }

  // lamp posts on a grid (M5): a fence post and a lantern, away from pads and the rim
  if (p.top.lights) {
    const L = p.top.lights;
    const cols = [];
    // the grid is offset by half a spacing, so the top centre (the anchor) is never a post
    const h2 = L >> 1;
    for (let zz = z + h2 - (Math.floor((rz + h2) / L) * L); zz <= z + rz; zz += L) for (let xx = x + h2 - (Math.floor((rx + h2) / L) * L); xx <= x + rx; xx += L) {
      const ty = topY.get(`${xx},${zz}`);
      if (ty === undefined || inPad(xx, zz, 2)) continue;
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]].every(([dx, dz]) => topY.get(`${xx + dx},${zz + dz}`) !== undefined);
      if (!nb) continue;
      cols.push(xx, zz, ty + 1, ty + 1, 0, xx, zz, ty + 2, ty + 2, 1);
    }
    if (cols.length) ops.push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: ['rail', 'minecraft:lantern[hanging=false]'], cond: 2, walk: false });
  }

  const bounds = { minX: bx0 - 1, maxX: bx1 + 1, minZ: bz0 - 1, maxZ: bz1 + 1, minY: by0, maxY: by1 + 3 };
  const [ax, az] = p.anchorAt ?? [x, z];
  const ty = topY.get(`${ax},${az}`) ?? y;
  return {
    generator: GENERATOR, version: VERSION, params: { at: p.at, r: p.r, thickness: p.thickness, top: { relief, pads: p.top.pads, edge: p.top.edge, lights: p.top.lights }, underside: p.underside, materials: typeof p.materials === 'string' ? p.materials : 'rule' },
    seed, ops, bounds, anchor: [ax, ty + 1, az], pads: padsOut, top: topY, amp,
  };
}

/** The island's top y at a column (plan time), or null. */
export function islandTopAt(isl, x, z) { return isl.top.get(`${x},${z}`) ?? null; }

export { sdAt };
