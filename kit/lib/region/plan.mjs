// Plan a region (docs/CONTRACT.md "1. The program model", "Limits"; kit/REGIONS.md "The Region IR"): run a program once
// over the plan survey and return its canonical Region IR, with the exact cell budget (every tile of every stage and set
// evaluated over the survey, nearest-neighbour upsampled to resolution 1) and the tiles each change-set touches.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORE_ROLES, MACRO_ROLES, PALETTES, ROLE_NAME, rolesOfPalette } from '../kit.mjs';
import { fnv64, splitmix64, fromDecimal64, toDecimal64 } from '../noise.mjs';
import { evalTile, MAX_OPS, walkKinds } from '../realise.mjs';
import { shapeBounds, yrefAbs } from '../sdf.mjs';
import { FLAG_MISSING, asColumns, canonicalJson, makeColumns, sha256Hex } from './pack.mjs';
import { voxelsSize } from './voxels.mjs';
import { scatterBounds, stampBounds } from './scatter.mjs';
import { stampLibrary } from './stamps.mjs';
import { parseBiomes } from './boundary.mjs';
import { decodeArbl } from '../realise.mjs';
import { COND, DEFAULT_MACRO_ROLES, Region, TERRAIN_OPS, blockState, region as makeRegion } from './program.mjs';
import { surveyApi, windowFromSurvey } from './survey.mjs';
import { validateParams, resolveValues } from '../params.mjs';
import { mapPatternMats, patternError } from '../pattern.mjs';
import { maskTerms } from '../mask.mjs';
import { PASS_NAMES } from './passes/index.mjs';
import { connectorRoles, connectorsError } from '../connectors/style.mjs';
import { lintFluidState } from '../fluids/body.mjs';
import { fluidsError } from '../fluids/place.mjs';

/** The kit's region engine version (recorded in every IR). */
export const KIT_VERSION = '0.39.0';

export const LIMITS = Object.freeze({
  claim: 1024, claimBig: 2048, irBytes: 4 * 1024 * 1024, ops: MAX_OPS, lots: 1024, paths: 256, stages: 64,
  budgetDefault: 20_000_000, budgetHard: 64_000_000, worldMinY: -2048, worldMaxY: 2047,
});
/** Margin (blocks) kept around the surveyed terrain when the IR's y range is tightened inside the request's. */
export const Y_MARGIN = 64;

/**
 * (6c W) A region's parts, side blobs and tiles as the IR carries them (the ops' conditions and bounds, the tiles each stage and
 * set touches). planRegion assembles the IR from it; light.mjs builds a draft IR from it (draftIR) mid-program.
 */
export function assembleParts(r, claim, reach = null) {
  const stages = r.stageList;
  // (6b) side blobs: name -> {sha, bytes, kind} in the IR; the bytes by sha beside it
  const sideBytes = new Map();
  const irBlobs = {};
  for (const [name, b] of Object.entries(r.sideBlobs)) {
    const sha = sha256Hex(b.bytes);
    sideBytes.set(sha, b.bytes);
    irBlobs[name] = { sha, bytes: b.bytes.length, kind: b.kind };
  }
  let total = 0;
  for (const b of sideBytes.values()) total += b.length;
  if (total > 64 * 1024 * 1024) throw new Error(`the plan's blobs are ${total} bytes (at most 64 MB)`);
  const blobs = Object.keys(r.blobs).length ? r.blobs : undefined;
  const blobResolver = (name) => {
    const e = irBlobs[name];
    if (!e) throw new Error(`shape: blob '${name}' is not in the IR's blobs`);
    return decodeArbl(sideBytes.get(e.sha), `blob ${name}`);
  };
  const parts = r.parts.map((p) => {
    const si = stages.indexOf(p.stage);
    const ops = p.ops.map((op) => {
      // (6c T1) a relief op's write condition is its `cut`; its bounds are its field's extent (y: column-dependent)
      if (op.op === 'relief') return { ...op, cut: (op.cut ?? COND.IF_NATURAL) === COND.IF_NATURAL && (p.set === 'path' || si > 0) ? COND.ALWAYS_OURS : (op.cut ?? COND.IF_NATURAL), bounds: reliefBounds(op, r.fields) };
      const cond = op.cond === COND.IF_NATURAL && (p.set === 'path' || si > 0) ? COND.ALWAYS_OURS : op.cond;
      const b = opBounds(op, Object.keys(irBlobs).length ? blobResolver : blobs, (name) => { const e = irBlobs[name]; if (!e) throw new Error(`voxels: blob '${name}' is not in the IR's blobs`); return sideBytes.get(e.sha); });
      return { ...op, cond, bounds: b };
    });
    return { id: p.id, stage: p.stage, set: p.set, ops, ...(p.keep ? { keep: p.keep } : {}) };
  });

  const irClaim = { ...claim };

  // tiles per stage and set, from op x/z bounds clipped to the claim
  const tiles = {};
  for (const s of stages) tiles[s] = { terrain: new Set(), path: new Set() };
  for (const p of parts) {
    for (const op of p.ops) {
      const b = op.bounds;
      const x0 = Math.max(b.minX, irClaim.minX), x1 = Math.min(b.maxX, irClaim.maxX), z0 = Math.max(b.minZ, irClaim.minZ), z1 = Math.min(b.maxZ, irClaim.maxZ);
      if (x0 <= x1 && z0 <= z1) for (let tx = tileOf(x0); tx <= tileOf(x1); tx++) for (let tz = tileOf(z0); tz <= tileOf(z1); tz++) tiles[p.stage][p.set].add(`${tx},${tz}`);
      // ((6c D3) and the tiles of the reach columns the op's bounds meet)
      if (reach) for (const q of reach.runs) {
        if (q[2] < b.minX || q[0] > b.maxX || q[1] < b.minZ || q[1] > b.maxZ) continue;
        for (let tx = tileOf(Math.max(q[0], b.minX)); tx <= tileOf(Math.min(q[2], b.maxX)); tx++) tiles[p.stage][p.set].add(`${tx},${tileOf(q[1])}`);
      }
    }
  }
  const sortKeys = (set) => [...set].sort((a, b) => { const [ax, az] = a.split(',').map(Number), [bx, bz] = b.split(',').map(Number); return ax - bx || az - bz; });
  const tilesOut = {};
  for (const s of stages) tilesOut[s] = { terrain: sortKeys(tiles[s].terrain), path: sortKeys(tiles[s].path) };
  return { sideBytes, irBlobs, blobs, parts, tilesOut };
}

/**
 * (6c W) A draft IR of a region being built (no budget pass): enough for buildVirtual and the checker's walk graph, so a program
 * can look at its own virtual world before it returns (r.lightCover). `{ir, blobs}` (blobs: sha -> bytes).
 */
export function draftIR(r) {
  const claim = r.claim;
  // ((6c D3) a reach plan's tiles also cover its reach columns outside the claim)
  const reachM = r.meta.reach ?? null;
  const { sideBytes, irBlobs, blobs, parts, tilesOut } = assembleParts(r, claim, reachM ? { runs: reachM.runs } : null);
  const ir = { format: 1, id: 'draft', claim: { ...claim }, roles: r.roles, stages: r.stageList, parts, lots: r.lots, roads: r.roads, paths: r.paths, anchors: r.anchors, rules: {}, tiles: tilesOut };
  if (blobs) ir.blobs = blobs;
  if (Object.keys(irBlobs).length) ir.blobs = irBlobs;
  if (Object.keys(r.fields).length) ir.fields = r.fields;
  if (Object.keys(r.volumesUsed).length) ir.volumes = r.volumesUsed;
  if (Object.keys(r.blockTags).length) ir.blockTags = r.blockTags;
  if (r.floatingDecl.length) ir.floating = r.floatingDecl;
  // ((6c D3) its reach columns are claimed land for writing in the draft's virtual world too)
  if (reachM) ir.reach = { runs: reachM.runs };
  return { ir, blobs: (sha) => sideBytes.get(sha) };
}

/** The roles a plan resolves: the rustic built-in's core roles and the macro defaults, under the bible's roles. */
export function resolveRoles(bibleRoles = {}, programRoles = {}) {
  // (6b) a program's own role defaults (`export const roles`) sit between the rustic defaults and the bible's roles
  const base = { ...rolesOfPalette(PALETTES.rustic), ...DEFAULT_MACRO_ROLES, ...programRoles };
  const out = {};
  for (const [k, v] of Object.entries({ ...base, ...bibleRoles })) {
    if (!ROLE_NAME.test(k)) throw new Error(`role name '${k}' must match ${ROLE_NAME}`);
    if (typeof v !== 'string') throw new Error(`role ${k} must be a block state string`);
    out[k] = blockState(v);
  }
  for (const k of [...CORE_ROLES, ...MACRO_ROLES]) if (!out[k]) throw new Error(`role ${k} resolves to nothing`);
  return out;
}

/**
 * (6c MP) A bible's role patterns `{role: pattern}` resolved against the plan's roles: every role named must be a role, and
 * every mat a role name (resolved to its block) or a block state. Returns `{role: pattern}` with block states (frozen).
 */
export function resolvePatterns(patterns = {}, roles = {}) {
  if (!patterns || typeof patterns !== 'object' || Array.isArray(patterns)) throw new Error('patterns must be {role: pattern}');
  const out = {};
  for (const k of Object.keys(patterns).sort()) {
    if (!Object.prototype.hasOwnProperty.call(roles, k)) throw new Error(`patterns.${k}: '${k}' is not a role (a pattern paints a role the bible names)`);
    const e0 = patternError(patterns[k], `patterns.${k}`);
    if (e0) throw new Error(e0);
    const p = mapPatternMats(patterns[k], (m) => {
      if (m === null || m === 'air' || m === 'minecraft:air') return null;
      if (Object.prototype.hasOwnProperty.call(roles, m)) return roles[m];
      try { return blockState(m); } catch (e) { throw new Error(`patterns.${k}: '${m}' is neither a role nor a block state (${e.message})`); }
    });
    out[k] = Object.freeze(p);
  }
  return Object.freeze(out);
}

/** (6c V) Validate keep-out rects: [[x0, z0, x1, z1], ...] integers, x0 <= x1, z0 <= z1, at most 1024; sorted, unique. */
export function parseKeepOut(v) {
  const a = typeof v === 'string' ? JSON.parse(v) : v;
  if (!Array.isArray(a) || a.length > 1024) throw new Error('keepOut must be an array of at most 1024 [x0, z0, x1, z1] rects');
  const out = a.map((r, i) => {
    if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isInteger) || r[0] > r[2] || r[1] > r[3]) throw new Error(`keepOut[${i}] must be [x0, z0, x1, z1] integers with x0 <= x1, z0 <= z1`);
    return [...r];
  });
  out.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2] || p[3] - q[3]);
  return out.filter((r, i) => i === 0 || r.join() !== out[i - 1].join());
}

/**
 * (6c D1) A standing region for `beside` (the mod's region.plan `beside`): `{id, claim: [x0, z0, x1, z1], lots: [[x0, z0, x1, z1]],
 * keep: [[x0, z0, x1, z1]] (its written cells inside this claim), graph: {nodes, edges}}`. Throws on a bad shape.
 */
export function parseBeside(b) {
  const rect = (q) => Array.isArray(q) && q.length === 4 && q.every(Number.isInteger) && q[0] <= q[2] && q[1] <= q[3];
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('beside must be an object');
  if (typeof b.id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(b.id)) throw new Error('beside.id must be a region id');
  if (!rect(b.claim)) throw new Error('beside.claim must be [x0, z0, x1, z1]');
  for (const k of ['lots', 'keep']) {
    const a = b[k] ?? [];
    if (!Array.isArray(a) || a.length > 8192 || !a.every(rect)) throw new Error(`beside.${k} must be at most 8192 [x0, z0, x1, z1] rects`);
  }
  const g = b.graph ?? { nodes: [], edges: [] };
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges) || g.nodes.length > 4096 || g.edges.length > 8192) throw new Error('beside.graph must be {nodes, edges} (at most 4096 nodes)');
  return { id: b.id, claim: [...b.claim], lots: (b.lots ?? []).map((q) => [...q]), keep: (b.keep ?? []).map((q) => [...q]), graph: { nodes: g.nodes, edges: g.edges } };
}

/** Parse a claim: an object or "minX,minZ,maxX,maxZ[,minY,maxY]" (inclusive). */
export function parseClaim(c) {
  let o = c;
  if (typeof c === 'string') {
    const v = c.split(',').map((s) => Number(s.trim()));
    if (!(v.length === 4 || v.length === 6) || !v.every(Number.isInteger)) throw new Error('claim must be minX,minZ,maxX,maxZ[,minY,maxY] integers');
    o = { minX: v[0], minZ: v[1], maxX: v[2], maxZ: v[3], minY: v[4] ?? -64, maxY: v[5] ?? 319 };
  }
  const claim = { minX: o.minX, minZ: o.minZ, maxX: o.maxX, maxZ: o.maxZ, minY: o.minY ?? -64, maxY: o.maxY ?? 319 };
  for (const k of Object.keys(claim)) if (!Number.isInteger(claim[k])) throw new Error(`claim.${k} must be an integer`);
  if (claim.minX > claim.maxX || claim.minZ > claim.maxZ || claim.minY > claim.maxY) throw new Error('claim: min must be <= max');
  return claim;
}

/** The default seed: fnv64(programId, canonical(params), canonical(claim)) as a u64 decimal string. */
export function defaultSeed(programId, params, claim) {
  const h = fnv64(programId, canonicalJson(params), canonicalJson(claim));
  return toDecimal64(h.hi, h.lo);
}

/** `ctx.rng(label)`: a seeded PRNG `() => [0, 1)` with `int(a, b)`, `pick(arr)`, `shuffle(arr)` (in place). */
export function makeRng(seed, label) {
  const h = fnv64(seed, 'rng', label);
  const g = splitmix64(h.hi, h.lo);
  const f = () => g.float();
  f.int = (a, b) => a + Math.floor(g.float() * (b - a + 1));
  f.pick = (arr) => arr[Math.floor(g.float() * arr.length)];
  f.shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(g.float() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  };
  return f;
}

/**
 * The survey with missing columns (flag bit 1: unexplored at plan time) filled from their nearest known neighbours
 * (breadth-first in index order, deterministic), so programs and the budget pass see plausible land everywhere. All
 * missing: ground 64. The `missing` flag is kept (survey.missingAt reports it).
 */
export function fillMissing(survey) {
  const c = asColumns(survey);
  const n = c.width * c.depth;
  const out = makeColumns(c.minX, c.minZ, c.width, c.depth, c.resolution);
  out.ground.set(c.ground); out.height.set(c.height); out.floor.set(c.floor); out.flags.set(c.flags);
  const known = new Uint8Array(n);
  let queue = [];
  for (let i = 0; i < n; i++) if (!(c.flags[i] & FLAG_MISSING)) { known[i] = 1; queue.push(i); }
  if (!queue.length) {
    out.ground.fill(64); out.height.fill(64); out.floor.fill(64);
    return { columns: out, missing: n };
  }
  let missing = n - queue.length;
  while (queue.length) {
    const next = [];
    for (const i of queue) {
      const x = i % c.width, z = (i - x) / c.width;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Z = z + dz;
        if (X < 0 || Z < 0 || X >= c.width || Z >= c.depth) continue;
        const j = X + Z * c.width;
        if (known[j]) continue;
        known[j] = 1;
        out.ground[j] = out.ground[i]; out.height[j] = out.ground[i]; out.floor[j] = out.floor[i];
        out.flags[j] = (c.flags[j] & FLAG_MISSING) | (out.flags[i] & 1);
        next.push(j);
      }
    }
    queue = next;
  }
  return { columns: out, missing };
}

const tileOf = (v) => Math.floor(v / 64);

/** (6c T1) A relief op's bounds: its field's x/z extent; y depends on each column's frozen ground. */
export function reliefBounds(op, fields) {
  const f = fields?.[op.field];
  if (!f) throw new Error(`relief op: field '${op.field}' is not one of the region's fields`);
  return { minX: f.minX, maxX: f.minX + f.width * f.res - 1, minZ: f.minZ, maxZ: f.minZ + f.depth * f.res - 1, minY: null, maxY: null };
}

/** (6c T1) A program's declared passes (`export const passes = [...]`): a list of kit pass names, each once. */
export function declaredPasses(mod) {
  if (mod.passes === undefined) return [];
  if (!Array.isArray(mod.passes) || mod.passes.some((p) => typeof p !== 'string')) throw new Error('the program\'s passes must be an array of pass names');
  for (const p of mod.passes) if (!PASS_NAMES.includes(p)) throw new Error(`the program declares pass '${p}', which is not a kit pass (${PASS_NAMES.join(', ')})`);
  if (new Set(mod.passes).size !== mod.passes.length) throw new Error('the program declares a pass twice');
  return [...mod.passes];
}

/**
 * Conservative world bounds of an IR op: {minX, maxX, minZ, maxZ, minY|null, maxY|null}. (6c F1) A voxels op needs `bytesOf(name)`,
 * its ARVB blob's bytes.
 */
export function opBounds(op, blobs, bytesOf = null) {
  if (op.op === 'shape') return shapeBounds(op.shape, blobs);
  // (6c F2) scatter: its area plus its items' reach; stamp: its turned body at `at`
  if (op.op === 'scatter' || op.op === 'stamp') {
    if (!bytesOf) throw new Error(`${op.op} op: its blobs have no bytes here`);
    return op.op === 'scatter' ? scatterBounds(op, bytesOf) : stampBounds(op, bytesOf);
  }
  // (6c H) a fluid body: its sources' and ice's runs (the mod's members, shell to watch, are no cells of the op)
  if (op.op === 'fluid') {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const q of [...(op.cells ?? []), ...(op.ice ?? [])]) { minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]); minZ = Math.min(minZ, q[1]); maxZ = Math.max(maxZ, q[1]); minY = Math.min(minY, q[2]); maxY = Math.max(maxY, q[3]); }
    return { minX, maxX, minZ, maxZ, minY, maxY };
  }
  if (op.op === 'voxels') {
    if (!bytesOf) throw new Error(`voxels op: blob '${op.blob}' has no bytes here`);
    const [sx, sy, sz] = voxelsSize(bytesOf(op.blob));
    const odd = op.rotation === 90 || op.rotation === 270;
    const w = odd ? sz : sx, d = odd ? sx : sz;
    return { minX: op.origin[0], maxX: op.origin[0] + w - 1, minZ: op.origin[2], maxZ: op.origin[2] + d - 1, minY: op.origin[1], maxY: op.origin[1] + sy - 1 };
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minA = Infinity, maxB = -Infinity;
  for (let i = 0; i < op.cols.length; i += 5) {
    const [x, z, a, b] = op.cols.slice(i, i + 4);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    minA = Math.min(minA, a); maxB = Math.max(maxB, b);
  }
  const f = yrefAbs(op.from), t = yrefAbs(op.to);
  return { minX, maxX, minZ, maxZ, minY: f === null ? null : f + minA, maxY: t === null ? null : t + maxB };
}

/**
 * Plan a region.
 * @param {object} o
 * @param {string} [o.programFile] the program module path (or `o.program`: an already imported module namespace,
 *   with `o.programSource` for its sha)
 * @param {object} [o.params] param values (validated against the program's `params`)
 * @param {Uint8Array|object} o.survey the plan survey (ARSV bytes or a decoded columns object)
 * @param {string|null} [o.seed] u64 decimal string (default: defaultSeed)
 * @param {object|string} o.claim
 * @param {object} [o.roles] extra / bible roles {role: blockState}
 * @param {object} [o.patterns] (6c MP) the bible's role patterns {role: pattern} (lib/pattern.mjs; mats are roles or block states)
 * @param {object} [o.connectors] (7a K1) the bible's connectors member {wall?, gate?, rope_bridge?} (role names; lib/connectors/style.mjs)
 * @param {object} [o.fluids] (6c H) the bible's fluids member {bed?, rim?, coping?, spout?, quay?, mooring?} (role names; lib/fluids/place.mjs)
 * @param {object} [o.rarity] (6c VOC) the bible's rarity member (lib/vocab/rarity.mjs): ctx.rarity (its defaults filled in) and the plan
 *   meta's `vocab` (the style's own blocks, the resolved roles; the region checker's M26 and M27 read it)
 * @param {object} [o.vocabRefuse] (6c VOC) plan parts refused before they emit ({part: reason}): the compile pass's second plan
 * @param {object} [o.lotBlocks] (6c VOC-c) the bound lots' block histograms {lot: {block: n}} (the mod's, at check time): a palette rule
 *   measures a lot from its entry's blocks
 * @param {object[]} [o.paletteExclude] (6c VOC-c) [{rule, blocks, scope}]: the palette re-plan's swaps ("no X"), applied to the region's ops
 *   before its IR is assembled (kit/lib/plan/palette.mjs applyPaletteExclude)
 * @param {string} [o.kitVersion] / [o.node] recorded in the IR (defaults: KIT_VERSION, this Node's major)
 * @returns {Promise<{ir, irJson, irSha, notes: string[], stats}>}
 */
/**
 * (6c RS, §3, §4) A survival plan's IR marks: each op a terrain kind wrote gets `free: true` (TERRAIN_OPS; relief, scatter and stamp ops by
 * kind; every op of a brush stroke), and the member `survival` names the target groups: `groups` (sorted ids), `parts` (IR part id -> group
 * index: a plan part, so its own parts build together; the first connector of a shared route part; a bundled program's IR part itself) and
 * `pads` (the lots' pad parts, whose free cells are always the free pass). Mutates `ir`.
 */
export function markSurvival(ir, r, programId) {
  const all = programId === 'brush';
  ir.parts.forEach((p, i) => {
    const src = r.parts[i];
    p.ops.forEach((op, j) => {
      if (all || TERRAIN_OPS.has(src.ops[j]) || op.op === 'relief' || op.op === 'scatter' || op.op === 'stamp') op.free = true;
    });
  });
  const partOf = r.meta.planCheck?.partOf ?? null;
  const groupOf = (pid) => {
    const o = partOf ? partOf[pid] : null;
    if (typeof o !== 'string' || !o) return pid;
    return o.startsWith('routes:') ? o.slice(7).split(',')[0] : o;
  };
  const ids = ir.parts.map((p) => groupOf(p.id));
  const groups = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const parts = {};
  ir.parts.forEach((p, i) => { parts[p.id] = groups.indexOf(ids[i]); });
  const pads = [...new Set((ir.lots ?? []).map((l) => l.part))].filter((x) => parts[x] !== undefined).sort();
  ir.survival = { format: 1, groups, parts, pads };
  // (6c RS-b, §6.4, §7.2) the tunnels' bores: per bore its group, its start walk cell, its cardinal heading and its box, so the mod builds
  // the group's target ring by ring along the heading (a ring's lining, then the carve behind it). Only a plan with a tunnel has it.
  const bores = (r.meta.tunnels ?? []).filter((t) => parts[t.part] !== undefined).map((t) => ({ group: groups[parts[t.part]], from: [...t.from], dir: [...t.dir], box: [t.box.minX, t.box.minY, t.box.minZ, t.box.maxX, t.box.maxY, t.box.maxZ] }));
  if (bores.length) ir.survival.bores = bores.sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : a.from[0] - b.from[0] || a.from[2] - b.from[2] || a.from[1] - b.from[1]));
}

export async function planRegion(o) {
  const t0 = performance.now();
  const claim = parseClaim(o.claim);
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const big = process.env.ARCHITECT_BIG_REGIONS === '1';
  const maxSide = big ? LIMITS.claimBig : LIMITS.claim;
  if (W > maxSide || D > maxSide) throw new Error(`REGION_LIMIT: the claim is ${W}x${D} columns (at most ${maxSide}x${maxSide}${big ? '' : '; 2048 with ARCHITECT_BIG_REGIONS=1'})`);
  if (claim.minY < LIMITS.worldMinY || claim.maxY > LIMITS.worldMaxY) throw new Error('REGION_LIMIT: the claim y range is outside any world');

  const keepOut = parseKeepOut(o.keepOut ?? []);
  let keepOutRead = false;
  // (6c D1) a standing region the plan lays out beside (Regions.plan's `beside`): read through ctx.beside, recorded in the IR when read
  const beside = o.beside ? parseBeside(o.beside) : null;
  let besideRead = false;
  // (6c D3) the reach inputs beside a standing region (the town claim's survey, the held columns, the standing data): read only by the
  // reach step (a seam-step plan's IR is unchanged); recorded in the IR's `reach` when the reach step chose the join
  const RM = o.besideReach ? await import('./reach.mjs') : null;
  const besideReach = RM ? RM.parseReachInput(o.besideReach) : null;
  // (6c D2) the plan's biome grid (one biome per 4x4 columns: the game's storage, C28): read through ctx.biomes, recorded when read
  const biomes = o.biomes ? parseBiomes(o.biomes) : null;
  let biomesRead = false;
  const raw = asColumns(o.survey);
  const { columns: survey, missing } = fillMissing(raw);
  let roles;
  let vocabStyle = null;
  const notes = [];
  if (missing) notes.push(`survey: ${missing} of ${survey.width * survey.depth} columns missing (filled from their neighbours)`);

  // run the program: Math.random throws, Date.now returns 0, for the program's whole run (import included)
  const savedRandom = Math.random, savedNow = Date.now;
  let mod, out, programSource, regionObj, passes = [];
  const ctx = {};
  try {
    Math.random = () => { throw new Error('Math.random is not allowed in a region program: use ctx.rng(label)'); };
    Date.now = () => 0;
    if (o.program) { mod = o.program; programSource = o.programSource ?? ''; }
    else {
      programSource = fs.readFileSync(o.programFile);
      mod = await import(pathToFileURL(path.resolve(o.programFile)).href);
    }
    const id = mod.id;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(id)) throw new Error('the program must export id matching [a-z][a-z0-9_]{0,47}');
    if (typeof mod.default !== 'function') throw new Error('the program must export default (ctx) => Region');
    validateParams(mod.params, { region: true });
    if (mod.roles !== undefined && (typeof mod.roles !== 'object' || mod.roles === null || Array.isArray(mod.roles))) throw new Error('the program\'s roles must be {role: blockState}');
    roles = Object.freeze(resolveRoles(o.roles ?? {}, mod.roles ?? {}));
    const patterns = resolvePatterns(o.patterns ?? {}, roles);
    // (7a K1) the bible's connector roles (each slot a role the plan resolves, else its default chain)
    const ce = connectorsError(o.connectors ?? undefined, roles);
    if (ce) throw new Error(ce);
    const connectors = Object.freeze(connectorRoles(roles, o.connectors ?? null));
    // (6c H) the bible's fluids member (role names per slot: bed, rim, coping, spout, quay, mooring; lib/fluids/place.mjs)
    const fe = fluidsError(o.fluids ?? undefined, roles);
    if (fe) throw new Error(fe);
    // (6c VOC) the bible's style: its rarity budget (when it carries one) and its own blocks (roles, pattern mats, allow)
    const { styleOf } = await import('../vocab/budget.mjs');
    vocabStyle = styleOf({ roles: o.roles ?? {}, patterns: o.patterns ?? undefined, rarity: o.rarity ?? undefined });
    passes = declaredPasses(mod);
    const params = resolveValues(mod.params ?? {}, o.params ?? {});
    const seed = o.seed === undefined || o.seed === null || o.seed === 'default' ? defaultSeed(id, params, claim) : toDecimal64(...fromDecimal64(o.seed));
    const onKeepOut = () => { keepOutRead = true; };
    Object.assign(ctx, {
      claim: Object.freeze({ ...claim }), survey: surveyApi(survey, claim, { keepOut, onKeepOut }), roles, patterns, connectors, seed, params: Object.freeze({ ...params }),
      fluidsGiven: o.fluids ? Object.freeze({ ...o.fluids }) : null,
      // (6c VOC) the bible's rarity budget (defaults filled in), or null when the bible carries none; the plan compile's VOCAB/FIRE
      // refusals of the second plan ({part: reason})
      rarity: vocabStyle.opted ? Object.freeze({ ...vocabStyle.rarity }) : null,
      vocabRefuse: o.vocabRefuse ? Object.freeze({ ...o.vocabRefuse }) : null,
      // (6c KC, §5) the plan check's M25:clear refusals of the replan ({part: reason}): a part that wrote a body's cells is refused
      clearRefuse: o.clearRefuse ? Object.freeze({ ...o.clearRefuse }) : null,
      // (6c RS, §3) a survival check's SURVIVAL refusals of the replan ({part: reason}): a part that writes a creative-only block
      survivalRefuse: o.survivalRefuse ? Object.freeze({ ...o.survivalRefuse }) : null,
      // (6c RS) the plan is checked or planned in survival (the world's mode): its IR carries the free marks and the target groups
      survival: !!o.survival,
      kitVersion: o.kitVersion ?? KIT_VERSION, rng: (label) => makeRng(seed, String(label)),
      volumes: o.volumes ?? [],
      // (6c F2) the local stamp library (lib/region/stamps.mjs stampLibrary: a dir or an id -> bytes map; local-only, N-F2-1)
      stamps: o.stamps ? (typeof o.stamps.get === 'function' && typeof o.stamps.has === 'function' && typeof o.stamps.ids === 'function' ? o.stamps : stampLibrary(o.stamps)) : null,
      passes: Object.freeze([...passes]), // (6c T1) the declared passes (r.pass refuses any other)
      // (6c P0) the plan check's per-part cache (key -> entry | null; read only, never part of the params or the IR)
      planCache: typeof o.planCache === 'function' ? o.planCache : null,
      // (6c T2) cells the route pass prefers (hysteresis: an earlier plan's routes, 6d replanning; [[x, z]])
      routePrefer: Array.isArray(o.routePrefer ?? []) ? Object.freeze((o.routePrefer ?? []).map((q) => Object.freeze([q[0], q[1]])))
        : Object.freeze(Object.fromEntries(Object.entries(o.routePrefer).map(([k, v]) => [k, Object.freeze(v.map((q) => Object.freeze([q[0], q[1]])))]))),
    });
    ctx.region = () => makeRegion(ctx);
    // (6c V) the owner's protected rects; a program that reads them records them in the IR (`keepOut`: the areas it honoured)
    Object.defineProperty(ctx, 'keepOut', { enumerable: true, get: () => { keepOutRead = true; return keepOut.map((k) => [...k]); } });
    // (6c D1) the standing region beside this claim (null without one; a program that reads it records it in the IR)
    Object.defineProperty(ctx, 'biomes', { enumerable: true, get: () => { if (!biomes) return null; biomesRead = true; return biomes; } });
    Object.defineProperty(ctx, 'beside', { enumerable: true, get: () => { if (!beside) return null; besideRead = true; return JSON.parse(JSON.stringify(beside)); } });
    // (6c D3) not enumerable: a program's ctx copies stay as they were
    Object.defineProperty(ctx, 'besideReach', { enumerable: false, get: () => besideReach });
    out = await mod.default(ctx);
    regionObj = out;
    ctx.__id = id; ctx.__params = params;
  } finally {
    Math.random = savedRandom;
    Date.now = savedNow;
  }
  if (!(regionObj instanceof Region)) throw new Error('the program did not return a Region (return the region(ctx) builder)');
  const r = regionObj;
  notes.push(...r.notes);
  const tProgram = performance.now() - t0;

  // ---- validate and assemble
  for (const a of ['entrance', 'spawn']) if (!r.anchors[a]) throw new Error(`the region needs an anchor '${a}'`);
  // (6c T1) a pad on a `blend` edge has no batter: the relief pass must have blended around it
  const unblended = r.blendLots.filter((id) => !r.reliefLots.has(id));
  if (unblended.length) throw new Error(`lot ${unblended.join(', ')}: pad.edge 'blend' needs the relief pass around it (r.pass('relief', {around: [...]}))`);
  // (6c S3) and a terrace on a `blend` edge: its levels' pins in a relief pass's `around`
  const unpinned = (r.blendTerraces ?? []).filter((t) => !r.reliefTerraces.has(t.id)).map((t) => t.id);
  if (unpinned.length) throw new Error(`terrace ${unpinned.join(', ')}: edge 'blend' needs the relief pass around its levels (r.pass('relief', {around: levels.flatMap((l) => l.pins)}))`);
  const stages = r.stageList;
  if (stages.length > LIMITS.stages) throw new Error(`the region has ${stages.length} stages (at most ${LIMITS.stages})`);
  if (r.opCount > LIMITS.ops) throw new Error(`the region has ${r.opCount} ops (at most ${LIMITS.ops})`);
  if (r.lots.length > LIMITS.lots) throw new Error(`the region has ${r.lots.length} lots (at most ${LIMITS.lots})`);
  if (r.paths.length > LIMITS.paths) throw new Error(`the region has ${r.paths.length} paths (at most ${LIMITS.paths})`);
  const budgetCap = r.budgetCells ?? LIMITS.budgetDefault;
  if (budgetCap > LIMITS.budgetHard) throw new Error(`budget ${budgetCap} is over the hard cap ${LIMITS.budgetHard}`);

  // (6c VOC-c) "no X": the palette re-plan swaps the excluded family in the ops of the parts in its rules' scope (only when asked: every
  // other plan's ops are untouched)
  let paletteSwaps = null;
  if (Array.isArray(o.paletteExclude) && o.paletteExclude.length && r.meta.planCheck && !r.meta.planCheck.malformed) {
    const { applyPaletteExclude } = await import('../plan/palette.mjs');
    paletteSwaps = applyPaletteExclude(r, o.paletteExclude, r.meta.planCheck.partOf ?? {}, roles).swaps;
  }
  // ((6c D3) a reach plan's tiles also cover its reach columns outside the claim)
  const reachM = r.meta.reach ?? null;
  const { sideBytes, irBlobs, blobs, parts, tilesOut } = assembleParts(r, claim, reachM ? { runs: reachM.runs } : null);
  // the IR's y range: the request's for now; tightened after the budget pass (below)
  const irClaim = { ...claim };

  const ir = {
    format: 1, id: ctx.__id, programSha: sha256Hex(programSource), kitVersion: o.kitVersion ?? KIT_VERSION,
    node: o.node ?? process.versions.node.split('.')[0], params: ctx.__params, seed: ctx.seed, claim: irClaim, roles,
    stages, parts, lots: r.lots, roads: r.roads, paths: r.paths, anchors: r.anchors, rules: {},
    budget: { cells: 0, removed: 0, added: 0 }, tiles: tilesOut,
  };
  if (blobs) ir.blobs = blobs;
  // (6b) format-2 members, only when used; then format and requires from the IR's actual contents
  if (Object.keys(irBlobs).length) ir.blobs = irBlobs;
  if (Object.keys(r.fields).length) ir.fields = r.fields;
  if (Object.keys(r.volumesUsed).length) ir.volumes = r.volumesUsed;
  // (6c B) the block tags the masks name, expanded (only when an op's mask uses one)
  const usedTags = new Set();
  for (const p of parts) for (const op of p.ops) if (op.mask !== undefined) for (const t of maskTerms(op.mask, 'block')) if (t.startsWith('#')) usedTags.add(t);
  if (usedTags.size) ir.blockTags = Object.fromEntries([...usedTags].sort().map((t) => [t, r.blockTags[t]]));
  if (r.forms.length) {
    const base = new Map();
    let n = 0;
    for (const p of parts) { base.set(p.id, n); n += p.ops.length; }
    ir.forms = r.forms.map((f) => ({ id: f.id, generator: f.generator, version: f.version, params: f.params, seed: f.seed, bounds: f.bounds, ...(f.baked ? { baked: f.baked } : {}), ...(f.columns ? { columns: f.columns } : {}),
      ops: Array.from({ length: f.opsTo - f.opsFrom }, (_, k) => base.get(f.part) + f.opsFrom + k) }));
  }
  if (r.floatingDecl.length) ir.floating = r.floatingDecl;
  if (r.utility.length) ir.utility = r.utility;
  // (6c V) the settlement graph (SETTLEMENTS §8.1's shape; a format-1 member the evaluator ignores) and the honoured keep-out
  if (r.graph.nodes.length) ir.graph = { nodes: r.graph.nodes, edges: r.graph.edges };
  if (keepOutRead) ir.keepOut = keepOut.map((k) => [...k]);
  // (6c D1) the standing region the plan read (its id and the sha of what it read: the join and the obstacles came from it)
  if (besideRead) ir.beside = { id: beside.id, sha: sha256Hex(canonicalJson(beside)) };
  // (6c D2) the biome grid the plan read (its sha), and an outpost's corridor (settlement land its road crosses: row runs per outpost)
  if (biomesRead) ir.biomes = { sha: sha256Hex(canonicalJson({ minX: biomes.minX, minZ: biomes.minZ, res: biomes.res, width: biomes.width, depth: biomes.depth, palette: biomes.palette, ids: [...biomes.ids] })) };
  if (r.meta.corridor) ir.corridor = r.meta.corridor;
  // (6c D3, §2.3) the reach: the join's columns outside the claim and the contact columns it holds, with the shas of the reach inputs
  if (reachM) {
    const { encodeColumns } = await import('./pack.mjs');
    const BR = RM.reachFor(besideReach, reachM.standing);
    ir.reach = { standing: reachM.standing, runs: reachM.runs, rect: reachM.rect, cells: reachM.cells, hold: reachM.hold, contact: reachM.contact, ...(reachM.lamps ? { lamps: reachM.lamps } : {}),
      heldSha: sha256Hex(canonicalJson(BR.held)), surveySha: sha256Hex(encodeColumns(BR.survey)), standingSha: sha256Hex(canonicalJson(BR.standing)) };
  }
  // (6c RS) a survival plan (the world's mode): free marks and the target groups (a creative plan's IR is unchanged)
  if (o.survival) markSurvival(ir, r, ctx.__id);
  const kinds = walkKinds(ir);
  if (kinds.length) { ir.format = 2; ir.requires = kinds; }
  // (6c H, §1.1) lint FLUID_STATE: no op carries a flowing water or lava state (sources only)
  const flowing = lintFluidState(ir);
  if (flowing.length) throw new Error(`FLUID_STATE: ${flowing.length} op(s) write a flowing fluid state (sources only): ${flowing.slice(0, 4).map((f) => `part ${f.part} op ${f.op} ${f.state}`).join('; ')}`);
  const evalBlobs = (sha) => sideBytes.get(sha);

  // ---- the exact budget: every tile of every change-set over the survey
  const tBudget = performance.now();
  // ((6c D3) a reach plan's budget reads the reach frame's survey: the claim's columns are the plan survey's own)
  const reachIn = reachM ? RM.reachFor(besideReach, reachM.standing) : null;
  const evalSurvey = reachM ? RM.unionColumns(survey, reachIn.survey, [claim.minX, claim.minZ, claim.maxX, claim.maxZ], reachIn.standing.claim) : survey;
  let cells = 0, removed = 0, added = 0, evaluated = 0, cellLo = Infinity, cellHi = -Infinity;
  const perStage = {};
  const sv = ir.survival ? {} : null; // (6c RS) per group: free, held, paid cells and creative-only blocks over the survey
  const windows = new Map();
  for (const s of stages) {
    perStage[s] = { terrain: 0, path: 0 };
    for (const set of ['terrain', 'path']) {
      for (const key of tilesOut[s][set]) {
        let w = windows.get(key);
        if (!w) { w = windowFromSurvey(evalSurvey, key); w.flags.forEach((f, i) => { w.flags[i] = f & ~FLAG_MISSING; }); windows.set(key, w); }
        const e = evalTile(ir, key, w, { stage: s, set, countOnly: true, blobs: evalBlobs });
        cells += e.count; removed += e.removed; added += e.added; evaluated++;
        if (sv) for (const [g, x] of Object.entries(e.notes.survival ?? {})) {
          const t = (sv[g] ??= { free: 0, held: 0, paid: 0, creativeOnly: {} });
          t.free += x.free; t.held += x.held; t.paid += x.paid;
          for (const [b, n] of Object.entries(x.creativeOnly ?? {})) t.creativeOnly[b] = (t.creativeOnly[b] ?? 0) + n;
        }
        if (e.minY !== null) { cellLo = Math.min(cellLo, e.minY); cellHi = Math.max(cellHi, e.maxY); }
        perStage[s][set] += e.count;
      }
    }
  }
  ir.budget = { cells, removed, added };
  if (sv) {
    // (6c RS) the plan's survival estimate (over the survey, like the budget): the cells per group, and the creative-only blocks a group
    // writes (realise refuses CREATIVE_ONLY_BLOCK naming them; a plan check refuses the part SURVIVAL)
    const keys = Object.keys(sv).sort();
    ir.survival.cells = Object.fromEntries(keys.map((g) => [g, { free: sv[g].free, held: sv[g].held, paid: sv[g].paid }]));
    const co = keys.filter((g) => Object.keys(sv[g].creativeOnly).length);
    if (co.length) ir.survival.creativeOnly = Object.fromEntries(co.map((g) => [g, Object.fromEntries(Object.entries(sv[g].creativeOnly).sort())]));
  }
  if (cells > budgetCap) throw new Error(`the region writes ${cells} cells, over its budget of ${budgetCap}${r.budgetCells ? '' : ' (the default; declare more with region.budget(n), at most 64M)'}`);
  // tighten the y range inside the request's: the surveyed land and every cell the budget pass emitted, plus a margin of
  // Y_MARGIN (every emitted cell stays inside, so the budget is unchanged)
  let yLo = cellLo, yHi = cellHi;
  for (let i = 0; i < survey.width * survey.depth; i++) {
    if (raw.flags[i] & FLAG_MISSING) continue;
    yLo = Math.min(yLo, survey.floor[i]); yHi = Math.max(yHi, survey.height[i], survey.ground[i]);
  }
  for (const l of r.lots) { yLo = Math.min(yLo, l.box.minY - 1); yHi = Math.max(yHi, l.box.maxY); }
  for (const a of Object.values(r.anchors)) { yLo = Math.min(yLo, a[1]); yHi = Math.max(yHi, a[1]); }
  // an unexplored column could hold anything: then the request's range stays (cuts to a column's top and fills from its
  // floor must not be clipped by a guess)
  if (missing) notes.push('claim: the y range stays the request\'s (the survey has missing columns)');
  else if (Number.isFinite(yLo)) {
    ir.claim = { ...claim, minY: Math.max(claim.minY, yLo - Y_MARGIN), maxY: Math.min(claim.maxY, yHi + Y_MARGIN) };
  }
  // (6c RS, §3) a survival plan check: a part that writes a creative-only block (one of the 35, survival class none) is refused SURVIVAL
  // {kind: "creativeOnly"} and the plan planned again without it (at most 3 times), as the vocab refusals are
  if (o.survival && ir.survival?.creativeOnly && r.meta.planCheck && !r.meta.planCheck.malformed && (o._survivalPass ?? 0) < 3) {
    const ok = new Set((r.meta.planCheck.answers ?? []).filter((a) => a.class === 'fits' || a.class === 'adjusted').map((a) => a.part));
    const fresh = {};
    for (const [g, blocks] of Object.entries(ir.survival.creativeOnly)) {
      if (!ok.has(g) || (o.survivalRefuse ?? {})[g]) continue;
      const n = Object.values(blocks).reduce((a, b) => a + b, 0);
      fresh[g] = { code: 'SURVIVAL', message: `it writes ${n} creative-only block${n === 1 ? '' : 's'} (${Object.keys(blocks).join(', ')}): a survival world can't build ${n === 1 ? 'it' : 'them'}`, evidence: { kind: 'creativeOnly', blocks } };
    }
    if (Object.keys(fresh).length) {
      const again = await planRegion({ ...o, survivalRefuse: { ...(o.survivalRefuse ?? {}), ...fresh }, _survivalPass: (o._survivalPass ?? 0) + 1 });
      again.meta.planCheck.survival = { refused: Object.keys({ ...(o.survivalRefuse ?? {}), ...fresh }).sort(), pass: (o._survivalPass ?? 0) + 1 };
      return again;
    }
  }
  const irJson = canonicalJson(ir);
  const irBytes = Buffer.byteLength(irJson);
  if (irBytes > LIMITS.irBytes) throw new Error(`the IR is ${irBytes} bytes (at most ${LIMITS.irBytes})`);
  const stats = {
    ms: { program: Math.round(tProgram), budget: Math.round(performance.now() - tBudget), total: Math.round(performance.now() - t0) },
    irBytes, ops: r.opCount, parts: parts.length, lots: r.lots.length, roads: r.roads.length, paths: r.paths.length,
    tiles: Object.fromEntries(stages.map((s) => [s, { terrain: tilesOut[s].terrain.length, path: tilesOut[s].path.length }])),
    tileEvals: evaluated, cellsPerStage: perStage, surveyMissing: missing,
  };
  // a fresh object: evalTile caches compiled IRs per object, and the claim changed after the budget pass
  stats.irFormat = ir.format;
  stats.requires = ir.requires ?? [];
  stats.passes = r.passRuns.map((x) => ({ ...x }));
  const meta = { format: 1, paths: r.meta.paths, lots: r.meta.lots, parts: r.meta.parts, ...(r.meta.village ? { village: r.meta.village } : {}), ...(r.meta.gravity ? { gravity: r.meta.gravity } : {}), ...(r.meta.forms ? { forms: r.meta.forms } : {}), ...(r.passRuns.length ? { passes: r.passRuns.map((x) => ({ ...x })) } : {}), ...(r.meta.relief ? { relief: r.meta.relief } : {}), ...(r.meta.scatter ? { scatter: r.meta.scatter } : {}), ...(r.meta.stamps ? { stamps: r.meta.stamps } : {}), ...(r.meta.scatterDemo ? { scatterDemo: r.meta.scatterDemo } : {}), ...(r.meta.route ? { route: r.meta.route } : {}), ...(r.meta.planCheck ? { planCheck: r.meta.planCheck } : {}), ...(r.meta.villageZones ? { villageZones: r.meta.villageZones } : {}), ...(r.meta.districts ? { districts: r.meta.districts } : {}), ...(r.meta.outpost ? { outpost: r.meta.outpost } : {}), ...(r.meta.monastery ? { monastery: r.meta.monastery } : {}), ...(r.meta.walls ? { walls: r.meta.walls } : {}), ...(r.meta.ropes ? { ropes: r.meta.ropes } : {}), ...(r.meta.bridges ? { bridges: r.meta.bridges } : {}), ...(r.meta.tunnels ? { tunnels: r.meta.tunnels } : {}), ...(r.meta.waters ? { waters: r.meta.waters } : {}), ...(r.meta.quays ? { quays: r.meta.quays } : {}), ...(r.meta.wet ? { wet: r.meta.wet } : {}), ...(r.meta.wetAsked ? { wetAsked: true } : {}), ...(r.meta.courses ? { courses: r.meta.courses } : {}), ...(r.meta.forest ? { forest: r.meta.forest } : {}) };
  // (6c VOC) the style the region checker measures with (M26, M27:role): the roles the bible names (resolved) and the style's own blocks
  meta.vocab = { roles: Object.fromEntries(Object.keys(o.roles ?? {}).filter((k) => roles[k]).sort().map((k) => [k, roles[k]])), own: [...vocabStyle.own].sort(), opted: vocabStyle.opted, ...(vocabStyle.opted ? { rarity: vocabStyle.rarity } : {}) };
  // (6c VOC, §5.2 "New in VOC") a plan check: M27's state and convert and M20 (a) over each part's emitted cells (the virtual world of
  // this IR); a part with an error is refused (VOCAB, FIRE) and the plan planned again with it refused, so it writes nothing. Only when
  // the IR names a state that could make one (VOCAB_ERROR_STATES); the time is recorded (item 13)
  if (r.meta.planCheck && !r.meta.planCheck.malformed) {
    const { COST_STATES, VOCAB_ERROR_STATES, vocabCells, vocabRefusals, vocabScan } = await import('./checkVocab.mjs');
    const t = performance.now();
    let v = null;
    const errs = VOCAB_ERROR_STATES.test(irJson);
    // (the answers' cost.rarity and cost.creativeOnly, finish.mjs: only with an opted-in bible or a precious or creative-only block)
    const cost = vocabStyle.opted || COST_STATES.test(irJson);
    // (6c VOC-c) a plan with a palette rule is always scanned: the rule is measured over the scan's cells
    const pal = Array.isArray(r.meta.planCheck.palette) && r.meta.planCheck.palette.length ? r.meta.planCheck.palette : null;
    let palette = null;
    if (errs || cost || pal) {
      const { buildVirtual } = await import('./vworld.mjs');
      const irObj = JSON.parse(irJson);
      const built = buildVirtual({ ir: irObj, survey, filled: survey, blobs: (sha) => sideBytes.get(sha), volumes: (o.volumes ?? []).map((x) => x.decoded ?? x) });
      const scan = vocabScan({ ir: irObj, vw: built.vw, meta, lava: false });
      // (a part asked `architect_mc:unsafe` is a broken variant the checker must catch: never refused here)
      const plan = ctx.__params?.plan ?? {};
      const unsafe = new Set(['zones', 'forms', 'connectors', 'links'].flatMap((k) => (Array.isArray(plan[k]) ? plan[k] : [])).filter((q) => q?.ext?.['architect_mc:unsafe']).map((q) => q.id));
      if (errs) v = vocabRefusals({ ir: irObj, vw: built.vw, meta, partOf: r.meta.planCheck.partOf ?? {}, roles, scan, skip: unsafe });
      if (cost) meta.planCheck.vocabCells = vocabCells(irObj, scan);
      if (pal) {
        const { palettePass } = await import('../plan/palette.mjs');
        palette = palettePass({ pc: meta.planCheck, ir: irObj, hist: scan.hist, lotBlocks: o.lotBlocks ?? {}, excludes: o.paletteExclude ?? [], from: o._paletteFrom ?? {}, swaps: paletteSwaps ?? {} });
      }
    }
    meta.planCheck.vocab = { ms: Math.round(performance.now() - t), scanned: !!v, found: v?.found ?? [], refused: Object.keys(o.vocabRefuse ?? {}).sort(), pass: (o._vocabPass ?? 0) + 1 };
    const fresh = v ? Object.fromEntries(Object.entries(v.refuse).filter(([id]) => !(o.vocabRefuse ?? {})[id])) : {};
    // (6c VOC-c) "no X" asks the same re-plan (one counter for both: at most 3 passes in all), with its family excluded
    const want = palette?.want ?? [];
    if ((Object.keys(fresh).length || want.length) && (o._vocabPass ?? 0) < 3) {
      const again = await planRegion({ ...o, vocabRefuse: { ...(o.vocabRefuse ?? {}), ...fresh }, ...(want.length ? { paletteExclude: [...(o.paletteExclude ?? []), ...want], _paletteFrom: { ...(o._paletteFrom ?? {}), ...palette.from } } : {}), _vocabPass: (o._vocabPass ?? 0) + 1 });
      again.meta.planCheck.vocab.first = meta.planCheck.vocab;
      return again;
    }
    if (palette) {
      // the answers in place of the compile's placeholders; the artifact's rows and the measures for finish.mjs and the evidence
      meta.planCheck.answers = meta.planCheck.answers.map((a) => palette.answers[a.part] ?? a);
      meta.planCheck.paletteRows = palette.rows;
      meta.planCheck.paletteMeasures = palette.measures;
      if (paletteSwaps && Object.keys(paletteSwaps).length) meta.planCheck.paletteSwaps = paletteSwaps;
    }
  }
  // (6c KC, §3, §5) the backstop: M25:clear over this IR's virtual world, only when it has a body (every other plan is untouched). A plan
  // part that wrote a cell of a body's hard or watch set (the water gate's lintel and frame aside) was placed after the body: it is
  // refused OVERLAP {kind: "body"} and the plan planned again without it (at most 3 times). A part asked `architect_mc:unsafe` (a
  // broken variant the checker must catch) and a writer the plan does not map are never refused here: the region check's M25:clear
  // names them.
  if (r.meta.planCheck && !r.meta.planCheck.malformed && irJson.includes('"op":"fluid"')) {
    const { clearScan, clearRefusals, bodiesOf } = await import('./checkFluids.mjs');
    const { buildVirtual } = await import('./vworld.mjs');
    const irObj = JSON.parse(irJson);
    const built = buildVirtual({ ir: irObj, survey, filled: survey, blobs: (sha) => sideBytes.get(sha), volumes: (o.volumes ?? []).map((x) => x.decoded ?? x) });
    const sc = clearScan({ ir: irObj, vw: built.vw, meta });
    const plan = ctx.__params?.plan ?? {};
    const fresh = clearRefusals({ findings: sc.findings, plan, courses: new Set(bodiesOf(irObj).filter((b) => b.course).map((b) => b.id)), already: o.clearRefuse ?? {} });
    if (Object.keys(fresh).length && (o._clearPass ?? 0) < 3) {
      const again = await planRegion({ ...o, clearRefuse: { ...(o.clearRefuse ?? {}), ...fresh }, _clearPass: (o._clearPass ?? 0) + 1 });
      again.meta.planCheck.clear = { refused: Object.keys({ ...(o.clearRefuse ?? {}), ...fresh }).sort(), pass: (o._clearPass ?? 0) + 1, counts: sc.counts };
      return again;
    }
  }
  // ((6c D3) a reach plan's evaluation survey (the reach frame's): the plan check's artifact evaluates its tiles over it)
  return { ir: JSON.parse(irJson), irJson, irSha: sha256Hex(irJson), notes, stats, blobs: sideBytes, meta, needVolumes: r.needVolumes, passes, ...(reachM ? { evalSurvey } : {}) };
}
