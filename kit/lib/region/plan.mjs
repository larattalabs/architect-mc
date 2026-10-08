// Plan a region (docs/CONTRACT.md "1. The program model", "Limits"; kit/REGIONS.md "The Region IR"): run a program once
// over the plan survey and return its canonical Region IR, with the exact cell budget (every tile of every stage and set
// evaluated over the survey, nearest-neighbour upsampled to resolution 1) and the tiles each change-set touches.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORE_ROLES, MACRO_ROLES, PALETTES, ROLE_NAME, rolesOfPalette } from '../kit.mjs';
import { fnv64, splitmix64, fromDecimal64, toDecimal64 } from '../noise.mjs';
import { evalTile, MAX_OPS } from '../realise.mjs';
import { shapeBounds, yrefAbs } from '../sdf.mjs';
import { FLAG_MISSING, asColumns, canonicalJson, makeColumns, sha256Hex } from './pack.mjs';
import { COND, DEFAULT_MACRO_ROLES, Region, blockState, region as makeRegion } from './program.mjs';
import { surveyApi, windowFromSurvey } from './survey.mjs';
import { validateParams, resolveValues } from '../params.mjs';

/** The kit's region engine version (recorded in every IR). */
export const KIT_VERSION = '0.11.0';

export const LIMITS = Object.freeze({
  claim: 1024, claimBig: 2048, irBytes: 4 * 1024 * 1024, ops: MAX_OPS, lots: 1024, paths: 256, stages: 64,
  budgetDefault: 20_000_000, budgetHard: 64_000_000, worldMinY: -2048, worldMaxY: 2047,
});
/** Margin (blocks) kept around the surveyed terrain when the IR's y range is tightened inside the request's. */
export const Y_MARGIN = 64;

/** The roles a plan resolves: the rustic built-in's core roles and the macro defaults, under the bible's roles. */
export function resolveRoles(bibleRoles = {}) {
  const base = { ...rolesOfPalette(PALETTES.rustic), ...DEFAULT_MACRO_ROLES };
  const out = {};
  for (const [k, v] of Object.entries({ ...base, ...bibleRoles })) {
    if (!ROLE_NAME.test(k)) throw new Error(`role name '${k}' must match ${ROLE_NAME}`);
    if (typeof v !== 'string') throw new Error(`role ${k} must be a block state string`);
    out[k] = blockState(v);
  }
  for (const k of [...CORE_ROLES, ...MACRO_ROLES]) if (!out[k]) throw new Error(`role ${k} resolves to nothing`);
  return out;
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

/** Conservative world bounds of an IR op: {minX, maxX, minZ, maxZ, minY|null, maxY|null}. */
export function opBounds(op, blobs) {
  if (op.op === 'shape') return shapeBounds(op.shape, blobs);
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
 * @param {string} [o.kitVersion] / [o.node] recorded in the IR (defaults: KIT_VERSION, this Node's major)
 * @returns {Promise<{ir, irJson, irSha, notes: string[], stats}>}
 */
export async function planRegion(o) {
  const t0 = performance.now();
  const claim = parseClaim(o.claim);
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const big = process.env.ARCHITECT_BIG_REGIONS === '1';
  const maxSide = big ? LIMITS.claimBig : LIMITS.claim;
  if (W > maxSide || D > maxSide) throw new Error(`REGION_LIMIT: the claim is ${W}x${D} columns (at most ${maxSide}x${maxSide}${big ? '' : '; 2048 with ARCHITECT_BIG_REGIONS=1'})`);
  if (claim.minY < LIMITS.worldMinY || claim.maxY > LIMITS.worldMaxY) throw new Error('REGION_LIMIT: the claim y range is outside any world');

  const raw = asColumns(o.survey);
  const { columns: survey, missing } = fillMissing(raw);
  const roles = Object.freeze(resolveRoles(o.roles ?? {}));
  const notes = [];
  if (missing) notes.push(`survey: ${missing} of ${survey.width * survey.depth} columns missing (filled from their neighbours)`);

  // run the program: Math.random throws, Date.now returns 0, for the program's whole run (import included)
  const savedRandom = Math.random, savedNow = Date.now;
  let mod, out, programSource, regionObj;
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
    validateParams(mod.params);
    const params = resolveValues(mod.params ?? {}, o.params ?? {});
    const seed = o.seed === undefined || o.seed === null || o.seed === 'default' ? defaultSeed(id, params, claim) : toDecimal64(...fromDecimal64(o.seed));
    Object.assign(ctx, {
      claim: Object.freeze({ ...claim }), survey: surveyApi(survey, claim), roles, seed, params: Object.freeze({ ...params }),
      kitVersion: o.kitVersion ?? KIT_VERSION, rng: (label) => makeRng(seed, String(label)),
    });
    ctx.region = () => makeRegion(ctx);
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
  const stages = r.stageList;
  if (stages.length > LIMITS.stages) throw new Error(`the region has ${stages.length} stages (at most ${LIMITS.stages})`);
  if (r.opCount > LIMITS.ops) throw new Error(`the region has ${r.opCount} ops (at most ${LIMITS.ops})`);
  if (r.lots.length > LIMITS.lots) throw new Error(`the region has ${r.lots.length} lots (at most ${LIMITS.lots})`);
  if (r.paths.length > LIMITS.paths) throw new Error(`the region has ${r.paths.length} paths (at most ${LIMITS.paths})`);
  const budgetCap = r.budgetCells ?? LIMITS.budgetDefault;
  if (budgetCap > LIMITS.budgetHard) throw new Error(`budget ${budgetCap} is over the hard cap ${LIMITS.budgetHard}`);

  const blobs = Object.keys(r.blobs).length ? r.blobs : undefined;
  const parts = r.parts.map((p) => {
    const si = stages.indexOf(p.stage);
    const ops = p.ops.map((op) => {
      const cond = op.cond === COND.IF_NATURAL && (p.set === 'path' || si > 0) ? COND.ALWAYS_OURS : op.cond;
      const b = opBounds(op, blobs);
      return { ...op, cond, bounds: b };
    });
    return { id: p.id, stage: p.stage, set: p.set, ops };
  });

  // the IR's y range: the request's for now; tightened after the budget pass (below)
  const irClaim = { ...claim };

  // tiles per stage and set, from op x/z bounds clipped to the claim
  const tiles = {};
  for (const s of stages) tiles[s] = { terrain: new Set(), path: new Set() };
  for (const p of parts) {
    for (const op of p.ops) {
      const b = op.bounds;
      const x0 = Math.max(b.minX, irClaim.minX), x1 = Math.min(b.maxX, irClaim.maxX), z0 = Math.max(b.minZ, irClaim.minZ), z1 = Math.min(b.maxZ, irClaim.maxZ);
      if (x0 > x1 || z0 > z1) continue;
      for (let tx = tileOf(x0); tx <= tileOf(x1); tx++) for (let tz = tileOf(z0); tz <= tileOf(z1); tz++) tiles[p.stage][p.set].add(`${tx},${tz}`);
    }
  }
  const sortKeys = (set) => [...set].sort((a, b) => { const [ax, az] = a.split(',').map(Number), [bx, bz] = b.split(',').map(Number); return ax - bx || az - bz; });
  const tilesOut = {};
  for (const s of stages) tilesOut[s] = { terrain: sortKeys(tiles[s].terrain), path: sortKeys(tiles[s].path) };

  const ir = {
    format: 1, id: ctx.__id, programSha: sha256Hex(programSource), kitVersion: o.kitVersion ?? KIT_VERSION,
    node: o.node ?? process.versions.node.split('.')[0], params: ctx.__params, seed: ctx.seed, claim: irClaim, roles,
    stages, parts, lots: r.lots, roads: r.roads, paths: r.paths, anchors: r.anchors, rules: {},
    budget: { cells: 0, removed: 0, added: 0 }, tiles: tilesOut,
  };
  if (blobs) ir.blobs = blobs;

  // ---- the exact budget: every tile of every change-set over the survey
  const tBudget = performance.now();
  let cells = 0, removed = 0, added = 0, evaluated = 0, cellLo = Infinity, cellHi = -Infinity;
  const perStage = {};
  const windows = new Map();
  for (const s of stages) {
    perStage[s] = { terrain: 0, path: 0 };
    for (const set of ['terrain', 'path']) {
      for (const key of tilesOut[s][set]) {
        let w = windows.get(key);
        if (!w) { w = windowFromSurvey(survey, key); w.flags.forEach((f, i) => { w.flags[i] = f & ~FLAG_MISSING; }); windows.set(key, w); }
        const e = evalTile(ir, key, w, { stage: s, set, countOnly: true });
        cells += e.count; removed += e.removed; added += e.added; evaluated++;
        if (e.minY !== null) { cellLo = Math.min(cellLo, e.minY); cellHi = Math.max(cellHi, e.maxY); }
        perStage[s][set] += e.count;
      }
    }
  }
  ir.budget = { cells, removed, added };
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
  return { ir: JSON.parse(irJson), irJson, irSha: sha256Hex(irJson), notes, stats };
}
