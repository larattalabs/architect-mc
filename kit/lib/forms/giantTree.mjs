// The `giantTree` generator, version 1 (docs/CONTRACT.md 6c F3 §2, SETTLEMENTS §9.2). Plan time only.
//
// Skeleton, all F1 rules (forms/rules.mjs: at most 32 primitives an op; absolute y; seeded fnv64(seed, generator, label)):
//   - a trunk `capsuleChain` tapering with height (axis y), its base sunk 3 under the plan ground;
//   - branches by integer space colonisation toward attractors in the crown, each step a 2-point `capsuleChain` segment, grouped into
//     one op per log axis (x, y, z) and chunk of 32;
//   - leaves in `ellipsoid` lobes at the branch tips (a cone of stacked discs for spruce), holed by a hash field at the lobes' skin;
//   - its own buttress roots (§2.1): `capsuleChain`s from the trunk's foot bending into the ground, at most SKIRT (6) under it.
// The ops are evaluated by the kit's own evaluator (rules.mjs formCells) and the cells fixed for drift (forms/states.mjs: every leaf
// persistent=true with vanilla's distance; logs' axis per segment; a wood core); cells in no component touching the trunk are dropped;
// a soil cell under a written log or root (a grass block a root would kill) is written as dirt. Always baked (r.form, `voxels`): the
// drift states are a function of the final cell set (CONTRACT F3 as built: "baked always").
// Presets: oak, spruce, birch, jungle, dark_oak, cherry, mangrove, pale_oak, and the nether's crimson and warped (stems, wart caps,
// shroomlight; no leaves, no M18). Sizes 16-64 high, crowns at most 32 across (Noah, N-F3-2: 2-4x vanilla).
// Integer or exactly specified maths only (no trig, no Math.random, no Date): the same params and seed give byte-identical cells.
import { fnv64, splitmix64 } from '../noise.mjs';
import { MAX_PRIMITIVES, formCells } from './rules.mjs';
import { AIR, columnRuns, connectedTo, fixStates, isLeaves, isLog, key, unkey } from './states.mjs';

export const GENERATOR = 'giantTree';
export const VERSION = 1;
/** The trunk's foot under the plan ground (drift absorbed; the roots reach SKIRT). */
const FOOT = 3;
const ROOT_DEPTH = 6;
const isInt = Number.isInteger;

/**
 * Bundled presets (species). `kind`: broad (a round crown of lobes on colonised branches), flat (a wide, low crown), cone (stacked
 * discs round a trunk to the top), fungus (a stem under a domed wart cap). `crown`: the crown's horizontal radius range (lobes
 * included, so the canopy is at most 2 x 15 + 1 = 31 across); `trunk`: the base radius range; `roots`: buttress roots by default.
 */
export const PRESETS = Object.freeze({
  oak: { kind: 'broad', log: 'oak_log', wood: 'oak_wood', leaves: 'oak_leaves', height: [24, 36], crown: [10, 14], crownH: 0.62, trunk: [2, 3], top: 0.6, roots: true, lean: 2 },
  spruce: { kind: 'cone', log: 'spruce_log', wood: 'spruce_wood', leaves: 'spruce_leaves', height: [40, 64], crown: [8, 11], crownH: 1, trunk: [2, 2.5], top: 0.94, roots: true, lean: 0 },
  birch: { kind: 'broad', log: 'birch_log', wood: 'birch_wood', leaves: 'birch_leaves', height: [20, 32], crown: [6, 8], crownH: 1.1, trunk: [1, 1.5], top: 0.7, roots: false, lean: 1 },
  jungle: { kind: 'flat', log: 'jungle_log', wood: 'jungle_wood', leaves: 'jungle_leaves', height: [40, 64], crown: [11, 15], crownH: 0.4, trunk: [3, 3.5], top: 0.78, roots: true, lean: 1 },
  dark_oak: { kind: 'flat', log: 'dark_oak_log', wood: 'dark_oak_wood', leaves: 'dark_oak_leaves', height: [16, 28], crown: [12, 15], crownH: 0.45, trunk: [3, 4], top: 0.6, roots: true, lean: 1 },
  cherry: { kind: 'flat', log: 'cherry_log', wood: 'cherry_wood', leaves: 'cherry_leaves', height: [16, 26], crown: [11, 15], crownH: 0.5, trunk: [2, 2.5], top: 0.55, roots: false, lean: 2 },
  mangrove: { kind: 'broad', log: 'mangrove_log', wood: 'mangrove_wood', leaves: 'mangrove_leaves', height: [20, 32], crown: [9, 12], crownH: 0.6, trunk: [2, 2.5], top: 0.62, roots: true, lean: 1, rootBlock: 'mangrove_roots' },
  pale_oak: { kind: 'broad', log: 'pale_oak_log', wood: 'pale_oak_wood', leaves: 'pale_oak_leaves', height: [18, 30], crown: [10, 13], crownH: 0.55, trunk: [2.5, 3], top: 0.58, roots: true, lean: 1 },
  crimson: { kind: 'fungus', log: 'crimson_stem', wood: 'crimson_hyphae', cap: 'nether_wart_block', light: 'shroomlight', height: [16, 32], crown: [7, 11], crownH: 0.55, trunk: [1.5, 2], top: 0.85, roots: false, lean: 0 },
  warped: { kind: 'fungus', log: 'warped_stem', wood: 'warped_hyphae', cap: 'warped_wart_block', light: 'shroomlight', height: [16, 32], crown: [7, 11], crownH: 0.55, trunk: [1.5, 2], top: 0.85, roots: false, lean: 0 },
});
export const SIZE = Object.freeze({ height: [16, 64], crownMax: 15 });

function rng(seed, label) {
  const h = fnv64(seed, GENERATOR, label);
  const g = splitmix64(h.hi, h.lo);
  const f = () => g.float();
  f.int = (a, b) => a + Math.floor(g.float() * (b - a + 1));
  return f;
}
/** A deterministic hash in [0, 1) of a cell (the leaf holes). */
function cellHash(seed, x, y, z) {
  const h = fnv64(seed, 'hole', x, y, z);
  return (h.lo >>> 8) / 16777216;
}
const r2 = (v) => Math.round(v * 100) / 100;
const mc = (n) => (n.includes(':') ? n : `minecraft:${n}`);

/** Validate the params (a preset's values under the given ones); returns them filled. */
export function treeParams(p) {
  const preset = p.preset ?? 'oak';
  const base = PRESETS[preset];
  if (!base) throw new Error(`giantTree: unknown preset '${preset}' (${Object.keys(PRESETS).join(', ')})`);
  let height = p.height ?? base.height;
  if (isInt(height)) height = [height, height];
  const o = { at: p.at, preset, seed: String(p.seed ?? '1'), height, roots: p.roots ?? base.roots };
  if (!Array.isArray(o.at) || o.at.length !== 3 || !o.at.every(isInt)) throw new Error('giantTree: at must be [x, y, z] integers (y: the plan ground)');
  if (!(Array.isArray(height) && height.length === 2 && height.every(isInt) && height[0] <= height[1] && height[0] >= SIZE.height[0] && height[1] <= SIZE.height[1])) throw new Error(`giantTree: height must be an integer or [min, max] in ${SIZE.height[0]}..${SIZE.height[1]}`);
  if (typeof o.roots !== 'boolean') throw new Error('giantTree: roots must be a boolean');
  return o;
}

/** The capsuleChain primitive. */
const chain = (points, radii) => ({ kind: 'capsuleChain', points: points.map(([x, y, z]) => [x, y, z]), radii: radii.map(r2) });
/** The log state of a segment by its dominant axis. */
function axisOf(a, b) {
  const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]), dz = Math.abs(b[2] - a[2]);
  return dy >= dx && dy >= dz ? 'y' : dx >= dz ? 'x' : 'z';
}
/** Group primitives into shape ops of at most MAX_PRIMITIVES, one material. */
function opsOf(shapes, material) {
  const out = [];
  for (let i = 0; i < shapes.length; i += MAX_PRIMITIVES) out.push({ op: 'shape', shape: { kind: 'union', of: shapes.slice(i, i + MAX_PRIMITIVES) }, material, cond: 0, walk: false });
  return out;
}

/**
 * Space colonisation (integer): branches from `starts` toward `attractors` in steps of `step`, an attractor pulling its nearest node
 * within `influence` and killed within `kill`. Returns segments [[a, b, depth]] (a node's depth: its distance in steps from the trunk).
 */
function colonise(starts, attractors, { step = 2, influence = 12, kill = 3, rounds = 24 } = {}) {
  const nodes = starts.map((p) => ({ p, d: 0 }));
  let att = attractors.slice();
  const segs = [];
  const sq = (v) => v * v;
  const d2 = (a, b) => sq(a[0] - b[0]) + sq(a[1] - b[1]) + sq(a[2] - b[2]);
  for (let r = 0; r < rounds && att.length; r++) {
    const pull = new Map();
    for (const a of att) {
      let best = -1, bd = influence * influence + 1;
      for (let i = 0; i < nodes.length; i++) { const d = d2(nodes[i].p, a); if (d < bd) { bd = d; best = i; } }
      if (best < 0) continue;
      const v = pull.get(best) ?? [0, 0, 0, 0];
      const len = Math.sqrt(bd) || 1;
      v[0] += (a[0] - nodes[best].p[0]) / len; v[1] += (a[1] - nodes[best].p[1]) / len; v[2] += (a[2] - nodes[best].p[2]) / len; v[3]++;
      pull.set(best, v);
    }
    if (!pull.size) break;
    const added = [];
    for (const i of [...pull.keys()].sort((a, b) => a - b)) {
      const v = pull.get(i);
      const len = Math.sqrt(sq(v[0]) + sq(v[1]) + sq(v[2])) || 1;
      const n = nodes[i].p;
      const q = [n[0] + Math.round((v[0] / len) * step), n[1] + Math.round((v[1] / len) * step), n[2] + Math.round((v[2] / len) * step)];
      if (q[0] === n[0] && q[1] === n[1] && q[2] === n[2]) continue;
      if (nodes.some((o) => o.p[0] === q[0] && o.p[1] === q[1] && o.p[2] === q[2])) continue;
      added.push({ p: q, d: nodes[i].d + 1 });
      segs.push([n, q, nodes[i].d + 1]);
    }
    if (!added.length) break;
    nodes.push(...added);
    att = att.filter((a) => !added.some((o) => d2(o.p, a) <= kill * kill));
  }
  return segs;
}

/** Integer points in an ellipsoid (rejection sampling, seeded). */
function attractorsIn(rr, c, rx, ry, rz, n) {
  const out = [];
  for (let t = 0; t < n * 8 && out.length < n; t++) {
    const x = rr.int(-rx, rx), y = rr.int(-ry, ry), z = rr.int(-rz, rz);
    if ((x * x) / (rx * rx) + (y * y) / (ry * ry) + (z * z) / (rz * rz) > 1) continue;
    out.push([c[0] + x, c[1] + y, c[2] + z]);
  }
  return out;
}

/** Eight compass directions as integer steps (no trig). */
const DIR8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/**
 * Grow one tree. `groundAt(x, z)` gives the plan ground (default: `at[1]` everywhere). Returns `{generator, version, seed, params,
 * ops (the skeleton: shape ops, each at most 32 primitives), cells (Map "x,y,z" -> state, final), columns (the 2.5D mask runs), bounds,
 * stats}`.
 */
export function giantTree(params, { groundAt = null, _unsafe = null } = {}) {
  const p = treeParams(params);
  const P = PRESETS[p.preset];
  const [x0, y0, z0] = p.at;
  const ground = groundAt ?? (() => y0);
  const rr = rng(p.seed, 'tree');
  const H = rr.int(p.height[0], p.height[1]);
  const g = ground(x0, z0);
  // the crown scales with the height within the preset's range (a short tree, a smaller crown)
  const span = P.height[1] - P.height[0] || 1;
  const t = Math.max(0, Math.min(1, (H - P.height[0]) / span));
  const crownR = Math.min(SIZE.crownMax, Math.max(P.crown[0], Math.round(P.crown[0] + t * (P.crown[1] - P.crown[0]) + rr.int(-1, 1))));
  const r0 = P.trunk[0] + Math.round(((P.trunk[1] - P.trunk[0]) * t) * 2) / 2;
  const lx = P.lean ? rr.int(-P.lean, P.lean) : 0, lz = P.lean ? rr.int(-P.lean, P.lean) : 0;
  const top = g + H;
  const trunkTop = g + Math.max(6, Math.round(H * P.top));
  const log = (axis) => `${mc(P.log)}[axis=${axis}]`;
  const ops = [];
  // ---- the trunk (one capsuleChain, tapering)
  const tp = [[x0, g - FOOT, z0], [x0 + Math.trunc(lx / 2), g + Math.round((trunkTop - g) / 2), z0 + Math.trunc(lz / 2)], [x0 + lx, trunkTop, z0 + lz]];
  const tr = [r0 + 0.25, r0 * 0.8, Math.max(0.6, r0 * 0.55)];
  ops.push(...opsOf([chain(tp, tr)], log('y')));
  const trunkAt = (y) => {
    // the trunk axis at height y (linear between the chain's points)
    const [a, b, c] = tp;
    const s = y <= b[1] ? [a, b] : [b, c];
    const f = (y - s[0][1]) / ((s[1][1] - s[0][1]) || 1);
    return [Math.round(s[0][0] + (s[1][0] - s[0][0]) * f), y, Math.round(s[0][2] + (s[1][2] - s[0][2]) * f)];
  };
  const branchSegs = { x: [], y: [], z: [] };
  const lobes = [];
  const caps = [];
  if (P.kind === 'broad' || P.kind === 'flat') {
    // ---- branches by space colonisation toward the crown; leaves in lobes at the tips
    const lobeR = P.kind === 'flat' ? 4 : 3;
    const cyR = Math.max(3, Math.round(crownR * P.crownH));
    const cy = top - cyR;
    const cx = x0 + lx, cz = z0 + lz;
    const attR = Math.max(3, crownR - lobeR);
    const atts = attractorsIn(rr, [cx, cy, cz], attR, Math.max(2, cyR - 2), attR, 28 + crownR * 2);
    const starts = [];
    for (let y = Math.max(g + 4, trunkTop - Math.round(H * 0.18)); y <= trunkTop; y += 2) starts.push(trunkAt(y));
    const segs = colonise(starts, atts, { step: 2, influence: Math.max(10, crownR + 2), kill: 3 });
    // the pipe model, roughly: a branch thins with its depth from the trunk
    const depthMax = Math.max(1, ...segs.map((s) => s[2]));
    const tips = new Map();
    for (const [a, b, d] of segs) {
      const ra = Math.max(0.5, (r0 * 0.6) * (1 - (d - 1) / (depthMax + 1))), rb = Math.max(0.5, (r0 * 0.6) * (1 - d / (depthMax + 1)));
      branchSegs[axisOf(a, b)].push(chain([a, b], [ra, rb]));
      tips.set(key(...b), b);
      tips.delete(key(...a));
    }
    // a lobe at every tip and at every third node (a full crown), holed at its skin below
    const tipList = [...tips.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
    for (const q of tipList) lobes.push({ kind: 'ellipsoid', c: [q[0], { abs: q[1] }, q[2]], r: [lobeR + 0.5, Math.max(2, Math.round(lobeR * (P.kind === 'flat' ? 0.55 : 0.75))) + 0.5, lobeR + 0.5] });
    // the crown's own body over the trunk top (no gap between the lobes)
    lobes.push({ kind: 'ellipsoid', c: [cx, { abs: cy }, cz], r: [Math.max(3, attR) + 0.5, Math.max(2, cyR - 1) + 0.5, Math.max(3, attR) + 0.5] });
    if (!segs.length) throw new Error('giantTree: no branch grew (crown attractors out of reach)');
  } else if (P.kind === 'cone') {
    // ---- stacked discs from the crown's foot to the top, the radius falling linearly; short branches into each disc
    const foot = g + Math.round(H * 0.28);
    for (let y = foot; y <= top - 1; y += 3) {
      const f = (top - y) / (top - foot);
      const rd = Math.max(1.5, crownR * f);
      const c = trunkAt(Math.min(trunkTop, y));
      lobes.push({ kind: 'ellipsoid', c: [c[0], { abs: y }, c[2]], r: [r2(rd + 0.5), 1.6, r2(rd + 0.5)] });
      const L = Math.floor(rd * 0.6);
      if (L >= 2) for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) branchSegs[dx ? 'x' : 'z'].push(chain([c, [c[0] + dx * L, y, c[2] + dz * L]], [0.75, 0.5]));
    }
    lobes.push({ kind: 'ellipsoid', c: [x0 + lx, { abs: top }, z0 + lz], r: [1.5, 2.5, 1.5] });
  } else {
    // ---- fungus: a domed cap (clipY'd ellipsoid shell) over the stem, its rim hanging 2 under, shroomlight under the cap (below)
    const cyR = Math.max(3, Math.round(crownR * P.crownH));
    const cy = top - cyR;
    const c = trunkAt(trunkTop);
    caps.push({ kind: 'clipY', y0: { abs: cy - 2 }, of: { kind: 'subtract', of: [
      { kind: 'ellipsoid', c: [c[0], { abs: cy }, c[2]], r: [crownR + 0.5, cyR + 0.5, crownR + 0.5] },
      { kind: 'ellipsoid', c: [c[0], { abs: cy - 2 }, c[2]], r: [crownR - 1.5, cyR - 1, crownR - 1.5] },
    ] } });
  }
  // ---- buttress roots (§2.1): from the foot outward and down, at most ROOT_DEPTH under the ground
  const rootShapes = [];
  if (p.roots) {
    const n = Math.min(8, Math.max(3, Math.round(r0 * 2)));
    const off = rr.int(0, 7);
    for (let i = 0; i < n; i++) {
      const [dx, dz] = DIR8[(off + Math.floor((i * 8) / n)) % 8];
      const L = Math.round(r0 * 2) + rr.int(2, 5);
      const ax = x0 + Math.round(dx * r0), az = z0 + Math.round(dz * r0);
      const mx = x0 + Math.round(dx * (r0 + L / 2)), mz = z0 + Math.round(dz * (r0 + L / 2));
      const ex = x0 + dx * Math.round(r0 + L), ez = z0 + dz * Math.round(r0 + L);
      const up = P.rootBlock ? 4 : 2;
      rootShapes.push(chain([[ax, g + up, az], [mx, g + (P.rootBlock ? 2 : 0), mz], [ex, Math.max(g - ROOT_DEPTH, ground(ex, ez) - 3), ez]], [Math.max(0.75, r0 * 0.55), 1, 0.6]));
    }
  }
  // ---- the ops, in write order: leaves (or the cap) first, then branches, the trunk, the roots: logs win where they meet leaves
  const leafState = P.leaves ? mc(P.leaves) : null;
  const leafOps = leafState ? opsOf(lobes, leafState) : opsOf(caps, mc(P.cap));
  const branchOps = [];
  for (const ax of ['y', 'x', 'z']) branchOps.push(...opsOf(branchSegs[ax], log(ax)));
  const rootOps = opsOf(rootShapes, P.rootBlock ? mc(P.rootBlock) : log('y'));
  const all = [...leafOps, ...branchOps, ...ops, ...rootOps];
  // ---- the cells
  const { cells: raw } = formCells(all);
  const cells = new Map();
  for (const [k, s] of raw) if (s !== AIR) cells.set(k, s);
  // roots under the ground: logs only where the root runs (axis from the root's own direction: horizontal roots by its dominant axis)
  if (rootShapes.length && !P.rootBlock) {
    for (const [k, s] of cells) {
      if (!isLog(s) || s !== log('y')) continue;
      const [x, y, z] = unkey(k);
      if (y >= g + 3) continue;
      const dx = x - x0, dz = z - z0;
      if (Math.max(Math.abs(dx), Math.abs(dz)) <= Math.ceil(r0)) continue;
      cells.set(k, log(Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z'));
    }
  }
  // leaf holes: a 2x2x2 hash field at the crown's skin (a cell with an empty face neighbour), 18%
  if (leafState) {
    const holes = [];
    for (const [k, s] of cells) {
      if (s !== leafState) continue;
      const [x, y, z] = unkey(k);
      let skin = false;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (!cells.has(key(x + dx, y + dy, z + dz))) { skin = true; break; }
      if (skin && cellHash(p.seed, x >> 1, y >> 1, z >> 1) < 0.18) holes.push(k);
    }
    for (const k of holes) cells.delete(k);
  }
  // fungus: shroomlight in the cap's underside (a cap cell with air under it), 8% by hash
  if (P.kind === 'fungus') {
    for (const [k, s] of [...cells]) {
      if (s !== mc(P.cap)) continue;
      const [x, y, z] = unkey(k);
      if (!cells.has(key(x, y - 1, z)) && cellHash(p.seed, x, y, z) < 0.08) cells.set(k, mc(P.light));
    }
  }
  // the wood core: a trunk log whose four horizontal neighbours are logs of the trunk
  for (const [k, s] of [...cells]) {
    if (s !== log('y')) continue;
    const [x, y, z] = unkey(k);
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => { const o = cells.get(key(x + dx, y, z + dz)); return o && isLog(o) && o.startsWith(mc(P.log)); })) cells.set(k, `${mc(P.wood)}[axis=y]`);
  }
  // keep only what touches the trunk (through any cell): no floating lobe or branch (M3)
  const base = key(x0, g, z0);
  for (const k of connectedTo(cells, (k2) => k2 === base)) cells.delete(k);
  if (!cells.has(base)) throw new Error('giantTree: the trunk has no cell at its base');
  // a soil cell under a written log, root or stem standing on the ground: dirt (a grass block under a solid block dies: §10 item 5)
  for (const [k, s] of [...cells]) {
    if (isLeaves(s)) continue;
    const [x, y, z] = unkey(k);
    const gy = ground(x, z);
    if (y === gy + 1 && !cells.has(key(x, gy, z))) cells.set(key(x, gy, z), 'minecraft:dirt');
  }
  const fixed = fixStates(cells);
  // (the broken variant `_unsafe.leafNotPersistent`, M18's: every leaf written as vanilla's own, persistent=false)
  if (_unsafe?.leafNotPersistent) for (const [k, s] of cells) if (isLeaves(s)) cells.set(k, s.replace('persistent=true', 'persistent=false'));
  const columns = columnRuns(cells);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const k of cells.keys()) {
    const [x, y, z] = unkey(k);
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  let logs = 0, leaves = 0;
  for (const s of cells.values()) { if (isLog(s)) logs++; else if (isLeaves(s)) leaves++; }
  return {
    generator: GENERATOR, version: VERSION, seed: p.seed,
    params: { at: p.at, preset: p.preset, height: p.height, roots: p.roots },
    ops: all, cells, columns, bounds: { minX, maxX, minZ, maxZ, minY, maxY },
    stats: { height: H, crown: crownR, trunk: r0, ops: all.length, cells: cells.size, logs, leaves, faces: fixed.faces, across: Math.max(maxX - minX, maxZ - minZ) + 1 },
  };
}
