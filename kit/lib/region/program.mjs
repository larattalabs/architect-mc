// The region program API (docs/CONTRACT.md "1. The program model", "2. Primitives"; kit/REGIONS.md "Writing a program").
// A program `kit/regions/<id>.mjs` exports `id`, optional `params` and `default (ctx) => Region`:
//
//   import { region } from '../lib/region/program.mjs';
//   export const id = 'my_site';
//   export default function (ctx) {
//     const r = region(ctx);                       // or ctx.region()
//     r.stages(['ground', 'ways']);
//     const g = r.part('crater', { stage: 'ground' });
//     g.carve({ kind: 'bowl', c: [x, { abs: y }, z], r: 40, depth: 12 }, { lining: 'rubble' });
//     ...
//     r.anchor('entrance', [x, y, z]); r.anchor('spawn', [x, y, z]);
//     return r;
//   }
//
// Every primitive compiles, at plan time, into low-level pointwise ops (`shape` and `columns`, kit/REGIONS.md "Ops")
// that lib/realise.mjs evaluates per tile. Plan-time code: any JS, but no trig (the IR must be the same on every Node
// major); directions come from lib/region/geom.mjs.
import { info, normalize, qualify, tagBlocks } from '../blocks.mjs';
import { variant } from '../kit.mjs';
import { fnv64 } from '../noise.mjs';
import { columnCells, compileShape, polygonDistance, sdAt, shapeError, staticY, yrefError } from '../sdf.mjs';
import { encodeArbl } from '../realise.mjs';
import { ruleError } from '../material.mjs';
import { maskError } from '../mask.mjs';
import { isPattern, mapPatternMats, patternError } from '../pattern.mjs';
import { sha256Hex } from './pack.mjs';
import { keyRuns } from './beside.mjs';
import { voxelsSize } from './voxels.mjs';
import { floatingIsland } from '../forms/floatingIsland.mjs';
import { iceSpike } from '../forms/iceSpike.mjs';
import { rockSpire } from '../forms/rockSpire.mjs';
import { BAKE_OPS, bakeCells, bakeOps } from '../forms/rules.mjs';
import { giantTree } from '../forms/giantTree.mjs';
import { giantMushroom } from '../forms/giantMushroom.mjs';
import { lintStates } from '../forms/states.mjs';
import { VOXEL_CLASSES, VC, classAt } from './volume.mjs';
import { PASSES, PASS_NAMES } from './passes/index.mjs';
import { emitDistricts } from './districtsEmit.mjs';
import * as CONNECTOR_WALL from '../connectors/wall.mjs';
import { edgeColumns, inferMovers, footprintOf, polylineOf, VILLAGER } from './passes/route.mjs';
import { ropeBridge, surveyLand } from '../connectors/ropeGeom.mjs';
import { bridgeSpan } from '../connectors/bridgeGeom.mjs';
// (6c T3b) the tunnel primitive (a pure module: it imports neither this file nor the plan compiler)
import { tunnel as tunnelPrimitive } from '../connectors/tunnelGeom.mjs';
// (7a foundation) the 7a kinds (a leaf module): graph edge types, rows 9-11's segments and intent keys
import { INTENT_KEYS_7A, KINDS_7A } from '../connectors/kinds7a.mjs';
/** (7a foundation) The route segments rows 9-11 make (lift, catwalk, rock_stair): their cells are the links stage's. */
const ROW_SEGMENTS_7A = Object.freeze(['lift', 'catwalk', 'rock_stair']);
import { CARDINALS, cardinalOf, centreCells, circlePolygon, compassDir, crossOffsets, dominantCardinal, rightOf, segmentAxis } from './geom.mjs';

export const COND = Object.freeze({ IF_NATURAL: 0, IF_SOLID_NATURAL: 1, IF_AIR_OR_FLUID: 2, ALWAYS_OURS: 3 });
export const PART_ID = /^[a-z][a-z0-9_]{0,47}$/;
export const LOT_ID = /^[a-z][a-z0-9_]{0,47}$/;
export const STAGE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
export const ANCHOR_NAME = /^[a-z][a-z0-9_]{0,31}$/;
export const ROAD_MAX_CELLS = 2048;
export const ROAD_MAX_POINTS = 256;
/** cut/fill margin used when checking a ground road against the plan survey (4e allows 4 at realise) */
export const GROUND_ROAD_MARGIN = 3;
/** (6c S3) A guarded route's parapets: every this-many-th carries the light role on its rail. */
export const GUARD_LIGHT_EVERY = 4;

/** Macro role defaults when the bible does not name them (a settlement bible does). */
export const DEFAULT_MACRO_ROLES = Object.freeze({
  rock: 'minecraft:stone', surface: 'minecraft:grass_block', subsurface: 'minecraft:dirt', rubble: 'minecraft:cobblestone',
  rail: 'minecraft:oak_fence', structure: 'minecraft:stone_bricks',
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = Number.isInteger;
const round = (v) => Math.floor(v + 0.5);
const sq = (v) => v * v;

/**
 * The canonical block state string of `name` or `name[k=v,...]`: `minecraft:` qualified, properties validated against
 * the vanilla tables and sorted by name. Throws on an unknown block or property.
 */
export function blockState(s) {
  const m = /^([a-z0-9_:]+)(?:\[([^\]]*)\])?$/.exec(String(s).trim());
  if (!m) throw new Error(`'${s}' is not a block state (name or name[key=value,...])`);
  const name = qualify(m[1]);
  info(name);
  if (!m[2]) return name;
  const props = {};
  for (const kv of m[2].split(',')) {
    const [k, v] = kv.split('=');
    if (!k || v === undefined) throw new Error(`'${s}': bad property '${kv}'`);
    props[k.trim()] = v.trim();
  }
  normalize(name, props);
  const keys = Object.keys(props).sort();
  return keys.length ? `${name}[${keys.map((k) => `${k}=${props[k]}`).join(',')}]` : name;
}

/** The stairs state of a full block facing a cardinal (bottom half), or null when the block has no stairs. */
export function stairsOf(block, facing) {
  const base = String(block).replace(/\[.*$/, '');
  const v = base.endsWith('_stairs') ? base : variant(base, 'stairs');
  return v ? `${v}[facing=${facing},half=bottom]` : null;
}

// ------------------------------------------------------------------ low-level op builders

/** Collects `columns` op entries [x, z, a, b, m]. */
class Cols {
  constructor(from, to) { this.from = from; this.to = to; this.cols = []; this.materials = []; this.mi = new Map(); this.seen = null; }
  mat(m) {
    const k = m ?? '\u0000air';
    let i = this.mi.get(k);
    if (i === undefined) { i = this.materials.length; this.materials.push(m); this.mi.set(k, i); }
    return i;
  }
  add(x, z, a, b, m) { this.cols.push(x, z, a, b, this.mat(m)); }
  /** add unless (x, z) or (x, y, z) was added before (key chosen by caller) */
  addOnce(key, x, z, a, b, m) {
    this.seen ??= new Set();
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.add(x, z, a, b, m);
  }
  get empty() { return this.cols.length === 0; }
}

// ------------------------------------------------------------------ path geometry shared by stair, bridge, graded road

/** Centre cells with their travel axis and right-hand vector, from a polyline of [x, z] points. */
function pathCells(points2) {
  const { cells, vertexAt, pts } = centreCells(points2);
  for (const c of cells) {
    const a = pts[Math.min(c.seg, pts.length - 1)], b = pts[Math.min(c.seg + 1, pts.length - 1)];
    c.d = segmentAxis(a, b);
    c.r = rightOf(c.d);
  }
  return { cells, vertexAt, pts };
}

/**
 * A stair profile: y per centre cell, rising (or falling) at most 1 per cell, with 2 flat cells after every
 * `landingEvery` steps, reaching each checkpoint's y at its cell. Greedy (steps as early as allowed), so it fails only
 * when no profile can work. `checkpoints`: [[cellIndex, y], ...] ascending, the first at index 0.
 */
function stairProfile(n, checkpoints, landingEvery, what) {
  const y = new Array(n);
  let cur = checkpoints[0][1], flight = 0, flat = 0;
  y[0] = cur;
  for (let c = 1; c < checkpoints.length; c++) {
    const [end, target] = checkpoints[c];
    for (let i = checkpoints[c - 1][0] + 1; i <= end; i++) {
      const want = Math.sign(target - cur);
      if (want !== 0 && flight < landingEvery) { cur += want; flight++; flat = 0; } else { flat++; if (flat >= 2) flight = 0; }
      y[i] = cur;
    }
    if (cur !== target) {
      const from = checkpoints[c - 1][1], cells = end - checkpoints[c - 1][0], rise = Math.abs(target - from);
      throw new Error(`${what}: segment ${c - 1} rises ${rise} over ${cells} cells; with a landing every ${landingEvery} steps it needs at least ${rise + 2 * Math.floor((rise - 1) / landingEvery)} cells`);
    }
  }
  return y;
}

// ------------------------------------------------------------------ the region builder

/** Create the region builder for a program's ctx. */
export function region(ctx) {
  // ((7a K3) a plan compiled once more (a wall lot sent back to its zone: compile.mjs runCheck) takes a fresh region: `__regionAgain`)
  if (ctx.__region && !ctx.__regionAgain) throw new Error('region(ctx) may be called once per plan');
  const r = new Region(ctx);
  Object.defineProperty(ctx, '__region', { value: r, enumerable: false, configurable: true });
  return r;
}

// (6c H) r.fluidBody's implementation, bound late by kit/lib/fluids/body.mjs (which reads the plan's draft virtual world: plan.mjs, which
// imports this module; binding it here keeps this module free of the plan module, as scatterPlan.mjs and light.mjs are)
// (a property of a function declaration: hoisted, so the binding works while this module is still being evaluated in an import cycle)
/** (6c H) Bind r.fluidBody's implementation (kit/lib/fluids/body.mjs does, when it loads). */
export function _bindFluidBody(fn) {
  _bindFluidBody.fn = fn;
}
/** (6c HY) Bind r.course's implementation (kit/lib/fluids/course.mjs does, when it loads; the same hoisted binding as r.fluidBody). */
export function _bindCourse(fn) {
  _bindCourse.fn = fn;
}

/**
 * (6c RS, §4.1) The ops a terrain kind wrote (relief, pads' and terraces' cut and fill, forms, a clearing, brush strokes, and any write in
 * `r.terrain(fn)` or with `{terrain: true}`): a survival plan marks them `free: true` in the IR (lib/region/plan.mjs), so their natural,
 * obtainable blocks are free. Kept outside the ops (never in a creative IR).
 */
export const TERRAIN_OPS = new WeakSet();

export class Region {
  constructor(ctx) {
    this.ctx = ctx;
    this.claim = ctx.claim;
    this.survey = ctx.survey;
    this.roles = ctx.roles;
    // (6c MP) the bible's role patterns (resolved: block states), painted where an op takes a pattern
    this.rolePatterns = ctx.patterns ?? {};
    this._stages = null;
    this.parts = [];
    this.partIds = new Set();
    this.lots = [];
    this.lotIds = new Set();
    this.roads = [];
    this.roadIds = new Set();
    this.paths = [];
    this.anchors = {};
    this.blobs = {};
    this.notes = [];
    this.budgetCells = null;
    this.opCount = 0;
    // (6b)
    this.sideBlobs = {}; // name -> {kind, bytes}
    this.fields = {}; // name -> {blob, type, minX, minZ, width, depth, res}
    this.forms = []; // {id, generator, version, params, seed, bounds, part, opsFrom, opsTo}
    this.floatingDecl = []; // {parts, anchor}
    this.utility = [];
    this.needVolumes = [];
    this.volumesUsed = {}; // name -> {blob, box, sha, blocks?}
    // (6c B) the block tags a `block` mask names, expanded at plan time (the IR's `blockTags`: the evaluator can't read the tables)
    this.blockTags = {};
    this.meta = { paths: {}, lots: {}, parts: {} };
    // (6c V) the settlement graph: nodes {id, kind, ref, level, at, ports: [{name, at, facing, width}]}, edges {id, from, to, type,
    // width, stage, path, mover}
    this.graph = { nodes: [], edges: [] };
    this.graphIds = new Set();
    // (6c T1) the passes run ({name, ms, heapMb}), the lots on a `blend` edge and the lots a relief pass blended around
    this.passRuns = [];
    this.blendLots = [];
    this.reliefLots = new Set();
    // (6c S3) the terraces on a `blend` edge ({id, stage, levels, cells: Map "x,z" -> level, retain}) and those a relief pinned
    this.blendTerraces = [];
    this.reliefTerraces = new Set();
    // (6c HY-a) the hydrology pass's fields ({flow, wet}: {type, minX, minZ, width, depth, res, values}) once it ran; D1 reads `wet`
    this.hydrology = null;
    // (6c RS) inside a terrain kind's writes (`terrain(fn)`): the ops pushed are TERRAIN_OPS
    this._terrain = 0;
  }

  /** (6c RS, §4.1) Runs `fn` with every op it writes marked as a terrain kind's (free in survival when natural); returns its result. */
  terrain(fn) {
    this._terrain++;
    try {
      return fn();
    } finally {
      this._terrain--;
    }
  }

  /**
   * (6c T1) Run a plan-time pass (kit/lib/region/passes/, SETTLEMENTS §4): `relief` blends the land around pads and corridors
   * (`{around: [lots and {path, width} corridors], radius, maxCut, maxFill, erode: {thermal, stream}, fill, corridorFill, stage,
   * part}`). The program must declare it (`export const passes = ['relief']`). Its fields become side blobs (`r.field`), its ops a
   * part (`part`, default the pass's name, in the stage of the first lot it blends around: its pad's, so the pass reads the same
   * frozen ground as the pad). Returns `{fields: {name: fieldName}, ops: n, data: {...the pass's data, ms}}`.
   */
  pass(name, intent = {}) {
    if (!Object.hasOwn(PASSES, name)) throw new Error(`pass '${name}' is not a kit pass (${PASS_NAMES.join(', ')})`);
    const declared = this.ctx.passes ?? [];
    if (!declared.includes(name)) throw new Error(`PASS_UNDECLARED: the program calls pass '${name}' but does not declare it (export const passes = ['${name}'])`);
    if (name === 'route') return this._route(intent);
    if (name === 'districts') return this._districts(intent);
    if (name === 'hydrology') { const { _ran, ...it } = intent ?? {}; return this._hydrology(it); } // (`_ran` is the plan check's own)
    const it = { ...intent };
    const firstLot = (it.around ?? []).find((a) => a && Array.isArray(a.at) && Array.isArray(a.size));
    const stage = it.stage ?? (firstLot ? this.parts.find((p) => p.id === firstLot.part)?.stage : undefined);
    const fillDefault = (skin) => ({ rule: [{ when: { depth: [0, 0] }, mat: skin }, { when: { depth: [1, 3] }, mat: 'subsurface' }], default: 'rock' });
    it.fill = this.material(it.fill ?? fillDefault('surface'), `pass ${name} fill`);
    it.corridorFill = this.material(it.corridorFill ?? fillDefault('path'), `pass ${name} corridorFill`);
    const fname = it.name ?? name;
    const t0 = performance.now();
    // (never below the claim's bottom 2 rows, as terraces: bedrock on a flat world)
    // (6c S2) the plan's kept natural cells (r.keepNatural): the relief never writes their columns
    const kept = it._unsafe?.ignoreKeep ? [] : this._keptColumns(); // (`_unsafe.ignoreKeep`: the broken variant)
    // ((6c S3) a terraced lot's retaining ring is pinned at its pad's top: the relief leaves the wall and blends the land to it)
    if (name === 'relief' && this.terraceRings?.size) {
      const rings = (it.around ?? []).filter((a) => a && typeof a.id === 'string' && this.terraceRings.has(a.id)).flatMap((a) => this.terraceRings.get(a.id).map(([x, z, y]) => ({ rect: [x, z, x, z], y })));
      if (rings.length) it.around = [...it.around, ...rings];
    }
    const out = PASSES[name](this.survey.columns, this.ctx.volumes ?? [], { ...it, name: fname, minY: Math.max(it.minY ?? -32768, this.claim.minY + 2), ...(kept.length ? { keep: kept } : {}) });
    const ms = Math.round(performance.now() - t0);
    const heapMb = Math.round(process.resourceUsage().maxRSS / 1024);
    const res = { fields: {}, ops: out.ops.length, data: { ...out.data, ms } };
    for (const [fn, f] of Object.entries(out.fields)) res.fields[fn] = this.field(fn, f);
    if (out.ops.length) {
      const p = this.part(it.part ?? fname, { stage });
      this.terrain(() => { for (const op of out.ops) p._push(op); }); // (6c RS) the relief's cut and fill
    }
    for (const a of it.around ?? []) if (a && typeof a.id === 'string' && Array.isArray(a.at)) this.reliefLots.add(a.id);
    // (6c S3) a blend terrace's pins: the terrace is blended, and its rims retained against the land the relief leaves
    if (this.blendTerraces.length) {
      const tids = [...new Set((it.around ?? []).filter((a) => a && typeof a.terrace === 'string' && Array.isArray(a.rect)).map((a) => a.terrace))].sort();
      for (const tid of tids) if (!this.reliefTerraces.has(tid)) { this.reliefTerraces.add(tid); this._retainTerrace(tid, out.fields[fname] ?? null); }
    }
    this.passRuns.push({ name, ms, heapMb });
    this.note(`pass ${name}: ${(ms / 1000).toFixed(1)} s, ${heapMb} MB${out.data?.resolution > 1 ? ` (coarse: resolution ${out.data.resolution})` : ''}`);
    return res;
  }

  /**
   * (6c S3) A blend terrace's retaining walls, after the relief that pinned it (`field`: the relief's delta field, dh against the
   * survey's ground; NONE outside its band): every rim cell of a level standing more than 2 over the land outside it (a lower level's
   * y, else the survey's ground plus the relief's dh) gets the terrace's `retain` from that land's height up to the level's top.
   * Written in the terrace's own part (after its fill: last op wins). Recorded in meta.parts[id].terrace.retained.
   */
  _retainTerrace(tid, field) {
    const T = this.blendTerraces.find((t) => t.id === tid);
    const part = this.parts.find((p) => p.id === tid);
    if (!T || !part) return;
    const s = this.survey;
    const dhAt = (x, z) => {
      if (!field) return 0;
      const i = Math.floor((x - field.minX) / field.res), j = Math.floor((z - field.minZ) / field.res);
      if (i < 0 || j < 0 || i >= field.width || j >= field.depth) return 0;
      const v = field.values[i + j * field.width];
      return v === -32768 ? 0 : v;
    };
    const keys = [...T.cells.keys()].map((k) => k.split(',').map(Number)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const cols = [];
    let rims = 0;
    for (const [x, z] of keys) {
      const k = T.cells.get(`${x},${z}`), y = T.levels[k];
      let low = Infinity;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const kn = T.cells.get(`${x + dx},${z + dz}`);
        const g = kn === undefined ? s.groundAt(x + dx, z + dz) + dhAt(x + dx, z + dz) : kn < k ? T.levels[kn] : Infinity;
        if (g < low) low = g;
      }
      if (!(y - low > 2)) continue;
      rims++;
      cols.push(x, z, Math.max(low, this.claim.minY + 2), y, 0);
    }
    if (cols.length) part._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: [T.retain], cond: COND.IF_NATURAL, walk: false });
    const m = this.meta.parts[tid]?.terrace;
    if (m) m.retained = rims;
  }

  /**
   * (6c HY-a) The `hydrology` pass (r.pass('hydrology', {wetFalloff, channelAt, minReach, planWater = true}); passes/hydrology.mjs):
   * the `flow` and `wet` fields (side blobs) and `data` (with `courses` when `channelAt` is given). The plan's own water bodies
   * written so far (r.fluidBody) count as water for `wet` unless `planWater: false`. The fields' values stay on the region
   * (`this.hydrology`): D1's `wet` tag reads them. Returns `{fields: {flow, wet}, ops: 0, data: {...the pass's data, ms}}`.
   */
  _hydrology(intent = {}) {
    if (this.hydrology) throw new Error('pass hydrology: the region runs it once');
    const { planWater = true, _ran = null, ...it } = intent ?? {};
    const water = [];
    if (planWater) for (const b of this._fluidBodies ?? []) if (b.fluid === 'water') for (const q of b.cells) water.push([q[0], q[2]]);
    const t0 = performance.now();
    // (`_ran`: {out, ms}, the pass already run on this survey by the plan check, compile.mjs, before the region existed)
    const out = _ran ? _ran.out : PASSES.hydrology(this.survey.columns, this.ctx.volumes ?? [], { ...it, ...(water.length ? { water } : {}) });
    const ms = _ran ? _ran.ms : Math.round(performance.now() - t0);
    const heapMb = Math.round(process.resourceUsage().maxRSS / 1024);
    const res = { fields: {}, ops: 0, data: { ...out.data, ms } };
    for (const [fn, f] of Object.entries(out.fields)) res.fields[fn] = this.field(fn, f);
    this.hydrology = { flow: out.fields.flow, wet: out.fields.wet };
    this.passRuns.push({ name: 'hydrology', ms, heapMb });
    this.note(`pass hydrology: ${(ms / 1000).toFixed(1)} s, ${heapMb} MB${out.data.resolution > 1 ? ` (coarse: resolution ${out.data.resolution})` : ''}${out.data.courses ? `; ${out.data.courses.length} channel path(s)` : ''}`);
    return res;
  }

  /** (6c D1) The `districts` pass (r.pass('districts', intent); kit/lib/region/districtsEmit.mjs). */
  _districts(intent = {}) {
    return emitDistricts(this, intent);
  }

  /**
   * (6c T2) The route pass's obstacles from the region so far: `hard` (the lots and their aprons, the forms, the keep sets, plus the
   * intent's own `hard` rects, 6c D1) and `clearTrees` (a slope pad's batter rings, plus the intent's). [[x0, z0, x1, z1]].
   */
  _routeObstacles(it = {}) {
    const hard = [];
    for (const l of this.lots) hard.push([l.box.minX - 1, l.box.minZ - 1, l.box.maxX + 1, l.box.maxZ + 1]);
    // a slope pad's batter clears its rings to the column's top (trees included): no tree obstacle there
    const clearTrees = this.lots.filter((l) => l.pad?.edge === 'slope').map((l) => { const m = 1 + Math.max(l.pad.maxCut ?? 0, l.pad.maxFill ?? 0); return [l.box.minX - m, l.box.minZ - m, l.box.maxX + m, l.box.maxZ + m]; });
    // (6c PT) the caller's rects whose logs are no trees (a player's log build: kept out, never felled, so no tree reach)
    for (const b of it.clearTrees ?? []) clearTrees.push([...b]);
    // ((6c F3 §3.2) a grown form's column mask, not its bounds: a canopy's columns are hard, a 32-wide canopy does not block its rect)
    for (const f of this.forms) {
      if (f.columns) for (let i = 0; i < f.columns.length; i += 3) hard.push([f.columns[i + 1], f.columns[i], f.columns[i + 2], f.columns[i]]);
      else if (f.bounds) hard.push([f.bounds.minX, f.bounds.minZ, f.bounds.maxX, f.bounds.maxZ]);
    }
    // (6c S2) a keep set is an obstacle where it keeps a cell: its kept columns, not its whole box (F1's keepNatural over a claim's
    // volume would otherwise block every column of the claim); so for the districts pass's placement, dry runs and routes too
    // (`_unsafe.keepBoxes`: the broken variant, T2's whole-box rule)
    if (it._unsafe?.keepBoxes) for (const p of this.parts) for (const k of p.keep ?? []) hard.push([k.box.minX, k.box.minZ, k.box.maxX, k.box.maxZ]);
    else for (const [x, z] of this._keptColumns()) hard.push([x, z, x, z]);
    // (6c D1) the caller's own hard rects (a district's street and square, a standing region's cells)
    for (const b of it.hard ?? []) hard.push([...b]);
    return { hard, clearTrees };
  }

  /**
   * (6c T2) The `route` pass (r.pass('route', intent); kit/lib/region/passes/route.mjs): `{edges: [{id?, from, to, width = 3, movers?,
   * type?}], nodes: {name: {at: [x, y, z] (feet) | lot: id, kind, facing}}, maxGrade = 0.25, hairpinLanding = 3, stairs = true,
   * ladders = true, maxCut = 4, maxFill = 4, prefer: [[x, z]], base, stage, part = 'routes', surface = 'path', foundation =
   * 'foundation', retain = 'structure', stairMaterial = 'structure', keepOut: [[x0, z0, x1, z1]]}`. An end names a node, a lot (its
   * entrance; out of its front) or a graph node. Movers come from the ends' lot kinds unless the edge sets them (S-T2-1); ladders
   * only on an edge without villagers (S-T2-2). Obstacles: the lots and their aprons, the forms, the keep sets, the owner's keep-out
   * (`ctx.keepOut`, so the IR records it) and the intent's own `keepOut`. Each routed edge becomes ordinary primitives in the
   * path part `part`: 4e ground roads where the route lies on the surveyed ground, graded columns where it cuts or fills, stair
   * flights, hairpin landings and ladder columns; plus a graph edge (`movers`, `segments`). A route writing into keep-out refuses
   * the plan (KEEP_OUT). Returns `{edges, data}` (the pass's data, with `ms`).
   */
  _route(intent = {}) {
    const it = { ...intent };
    const what = 'pass route';
    const nodesIn = it.nodes ?? {};
    const lotKind = (l) => { const v = l?.ext?.['architect_mc:village']; return v?.villager ?? v?.type ?? v?.role ?? null; };
    const vec = (f) => (f === null || f === undefined ? null : Array.isArray(f) ? [...f] : CARDINALS[f] ? [...CARDINALS[f]] : null);
    const resolve = (name) => {
      const n = Object.hasOwn(nodesIn, name) ? nodesIn[name] : null;
      const lotId = n?.lot ?? (n ? null : name);
      const lot = lotId ? this.lots.find((l) => l.id === lotId) : null;
      if (lot) return { name, at: [...this.meta.lots[lot.id].entrance], kind: n?.kind ?? lotKind(lot), facing: vec(lot.front), lot: lot.id };
      if (n) {
        if (!Array.isArray(n.at) || n.at.length !== 3 || !n.at.every(isInt)) throw new Error(`${what}: node '${name}' needs at: [x, y, z] (feet) or lot: id`);
        return { name, at: [...n.at], kind: n.kind ?? null, facing: vec(n.facing), lot: null };
      }
      const g = this.graph.nodes.find((x) => x.id === name);
      if (g) return { name, at: [...g.at], kind: g.kind, facing: null, lot: null, graph: true };
      throw new Error(`${what}: no node, lot or graph node '${name}'`);
    };
    if (!Array.isArray(it.edges) || !it.edges.length) throw new Error(`${what}: edges must list [{from, to}]`);
    const ladders = it.ladders ?? true;
    const edges = it.edges.map((e, i) => {
      const id = e.id ?? `e${i + 1}`;
      if (typeof id !== 'string' || !PART_ID.test(id)) throw new Error(`${what}: edge id '${id}' must match ${PART_ID}`);
      const a = resolve(e.from), b = resolve(e.to);
      const movers = inferMovers(a.kind, b.kind, e.movers);
      // (`_unsafe.villagerLadders`: the broken variant, a ladder on a villager edge for the checker to catch)
      // (6c D2) an edge's own preferred cells (a following district's street along its line)
      // (7a K1) an edge's special-move options (the rope move's spans, spanOnce, span and approach), passed to the pass as given
      const k1 = {};
      // ((6c T3) and the bridge and tunnel rows': `once` and the opaque per-edge `t3` options)
      // ((7a foundation) and the 7a rows' opaque per-edge `t7` options and the edge's `profile` over the built-in moves)
      for (const key of ['spans', 'spanOnce', 'span', 'approach', 'once', 't3', 't7', 'profile', 'hairpinLanding', 'stairMaterial', 'keepEnds']) if (e[key] !== undefined) k1[key] = e[key]; // ((7a CL) and a switchback's own landing depth, a climb's tread role)
      // ((6c D3) a reach join: its own `frame` (rects), its `to` end's `lead`, `graded` (no 4e road: its columns are exactly its
      // footprint) and its own `part`; absent: as before)
      const d3 = {};
      if (Array.isArray(e.frame) && e.frame.length) d3.frame = e.frame.map((q) => [...q]);
      if (isInt(e.lead) && e.lead > 0) d3.lead = e.lead;
      if (e.graded === true) d3.graded = true;
      if (typeof e.part === 'string') d3.part = e.part;
      if (e.keepBehind === true) d3.keepBehind = true;
      return { id, a, b, width: e.width ?? 3, type: e.type ?? ((e.width ?? 3) >= 5 ? 'road' : 'path'), movers, ladders: ladders && (!movers.includes(VILLAGER) || !!it._unsafe?.villagerLadders), ...(Array.isArray(e.prefer) && e.prefer.length ? { prefer: e.prefer.map((q) => [q[0], q[q.length - 1]]) } : {}), ...(e.stairs === false ? { stairs: false } : {}), k1, d3 };
    });
    if (new Set(edges.map((e) => e.id)).size !== edges.length) throw new Error(`${what}: edge ids must be unique`);
    // obstacles: lot footprints and aprons, forms, keep sets (x/z); keep-out (the owner's, read through ctx so the IR records it)
    const { hard, clearTrees } = this._routeObstacles(it);
    // (6c S3) a guarded pass (a terraced plan's) never crosses an earlier pass's walk: each pass grades its cells from the survey, so a
    // later one would cut its own stairs through an earlier run; those runs are obstacles (their width), except within 2 of this
    // pass's own ends (a connector leaves from a district's junction)
    if (it.guard) {
      const ends = edges.flatMap((e) => [e.a.at, e.b.at]);
      for (const m of Object.values(this.meta.paths)) {
        if (!Array.isArray(m.cells) || this.meta.parts[m.part]?.kind !== 'path') continue;
        const h = (m.width ?? 1) >> 1;
        for (const [x, , z] of m.cells) if (!ends.some((a) => Math.max(Math.abs(a[0] - x), Math.abs(a[2] - z)) <= 2)) hard.push([x - h, z - h, x + h, z + h]);
      }
    }
    const keepOut = [...(this.ctx.keepOut ?? []), ...(it.keepOut ?? [])].map((k) => [...k]);
    // hysteresis: the caller's cells, 4e roads and graded paths already in the plan
    // (ctx.routePrefer: an earlier plan's routes, [[x, z]] for every edge or {edgeId: [[x, z]]} each edge its own)
    const rp = this.ctx.routePrefer ?? [];
    const prefer = [...(it.prefer ?? []), ...(Array.isArray(rp) ? rp : [])].map((p) => [p[0], p[p.length - 1]]);
    const preferOf = (id) => (Array.isArray(rp) ? [] : (rp[id] ?? []).map((p) => [p[0], p[p.length - 1]]));
    for (const rd of this.roads) { const { cells } = centreCells(rd.points.map((q) => [q[0], q[2]])); for (const c of cells) prefer.push([c.x, c.z]); }
    for (const m of Object.values(this.meta.paths)) if (m.kind === 'graded' && Array.isArray(m.cells)) for (const q of m.cells) prefer.push([q[0], q[2]]);
    const stage = it.stage ?? this.stageList[this.stageList.length - 1];
    const t0 = performance.now();
    const routeIn = {
      edges: edges.map((e) => ({ id: e.id, from: { at: e.a.at, facing: e.a.facing }, to: { at: e.b.at, facing: e.b.facing, ...(e.d3.lead ? { lead: e.d3.lead } : {}) }, width: e.width, movers: e.movers, ladders: e.ladders, prefer: [...preferOf(e.id), ...(e.prefer ?? [])], ...(e.stairs === false ? { stairs: false } : {}), ...e.k1, ...(e.d3.frame ? { frame: e.d3.frame } : {}) })),
      maxGrade: it.maxGrade ?? 0.25, hairpinLanding: it.hairpinLanding ?? 3, stairs: it.stairs ?? true, maxCut: it.maxCut ?? 4, maxFill: it.maxFill ?? 4, margin: it.margin ?? 2,
      hard, keepOut, prefer, clearTrees, base: it.base ?? null, _unsafe: it._unsafe ?? {},
      // (6c P0) the plan check's node budget over all edges (absent: none)
      ...(it.maxExpanded !== undefined ? { maxExpanded: it.maxExpanded } : {}),
      // (7a K1) the special moves' pass-level inputs: the walls (the gate move) and the rope move's (K1b)
      ...(it.walls ? { walls: it.walls } : {}), ...(it.rope ? { rope: it.rope } : {}),
      // (6c T3) the bridge and tunnel moves' pass-level inputs
      ...(it.bridge ? { bridge: it.bridge } : {}), ...(it.tunnel ? { tunnel: it.tunnel } : {}),
      // (7a foundation) rows 9-11's pass-level inputs (intent.lift, intent.catwalk, intent.rockStair), only when given
      ...Object.fromEntries(INTENT_KEYS_7A.filter((k) => it[k]).map((k) => [k, it[k]])),
      // (6c H) the plan's own water (lib/fluids/moat.mjs passInput), only when the plan has a body
      ...(it.fluids ? { fluids: it.fluids } : {}),
      // (6c D3) the pass's frame (the request claim, on a pass over the reach survey)
      ...(Array.isArray(it.frame) && it.frame.length ? { frame: it.frame } : {}),
    };
    // ((6c D3) `survey`: the reach survey (the district's claim and the town's, one grid) for a pass with a reach join; absent: the plan's)
    const sv = it.survey ?? this.survey;
    const out = PASSES.route(sv.columns, this.ctx.volumes ?? [], routeIn);
    // (the emission reads the same survey: every column of the claim is the plan survey's own there)
    const saved = this.survey;
    if (it.survey) this.survey = it.survey;
    try { return this._routeEmit(it, edges, out, sv, t0, stage, keepOut); } finally { this.survey = saved; }
  }

  /** (6c D3) The route pass's emission (split from _route so a reach pass emits over its own survey). */
  _routeEmit(it, edges, out, sv, t0, stage, keepOut) {
    const ms = Math.round(performance.now() - t0);
    const heapMb = Math.round(process.resourceUsage().maxRSS / 1024);
    // ---- emit
    const p0 = this.part(it.part ?? 'routes', { stage, set: 'path' });
    (this.meta.parts[p0.id] ??= {}).kind = 'path';
    const s = sv;
    let p = p0;
    const baseAt = (x, z) => {
      const b = it.base;
      if (!b) return 0;
      const i = x - b.minX, j = z - b.minZ;
      return i >= 0 && j >= 0 && i < b.width && j < b.depth ? b.values[i + j * b.width] : 0;
    };
    const mats = { surface: it.surface ?? 'path', foundation: it.foundation ?? 'foundation', retain: it.retain ?? 'structure', stair: it.stairMaterial ?? 'structure' };
    // (6c S3) `guard: true`: a walk run's edge over a drop of more than 3 gets a parapet column (the retain role) with a rail on it, and
    // stair flights get railings (M8 on a mountainside); absent: as before
    if (it.guard) mats.guard = it.guardRail ?? 'rail';
    const res = [];
    const written = new Map(); // "x,z" -> edge id (the keep-out guard)
    const mark = (x, z, id) => { const k = `${x},${z}`; if (!written.has(k)) written.set(k, id); };
    const metaEdges = [];
    const taken = new Set(); // "x,z" columns an earlier edge wrote
    // no retaining column on another route cell, nor on a lot's pad, apron or batter (the pad shapes that land)
    const routeCols = new Set();
    for (const d of out.data.edges) if (d.ok) {
      for (const g of d.segments) for (const q of footprintOf(d.path.slice(g.from, g.to + 1), d.width)) routeCols.add(`${q[0]},${q[1]}`);
      for (const l of d.landings) for (const [x, z] of l.cells) routeCols.add(`${x},${z}`);
    }
    const nearLot = (x, z) => this.lots.some((l) => { const m = 1 + Math.max(l.pad?.maxCut ?? 0, l.pad?.maxFill ?? 0); return x >= l.box.minX - m && x <= l.box.maxX + m && z >= l.box.minZ - m && z <= l.box.maxZ + m; });
    // (6c S2) nor on a kept natural cell's column (r.keepNatural: a natural ice spike beside the walk stands over it as land)
    const keptCols = new Set(it._unsafe?.retainOnKept ? [] : this._keptColumns().map(([x, z]) => `${x},${z}`)); // (`_unsafe.retainOnKept`: the broken variant)
    // ((6c S3) a guarded pass: an earlier pass's run, never under this pass's parapets, retaining walls or stair railings: they would bury
    // its walk)
    const priorCols = new Set();
    if (mats.guard) for (const m of Object.values(this.meta.paths)) if (Array.isArray(m.cells) && m.cells.length && this.meta.parts[m.part]?.kind === 'path') for (const q of footprintOf(m.cells, m.width ?? 1)) priorCols.add(`${q[0]},${q[1]}`);
    // ((6c D3) `noRetain`: the caller's own columns no retaining column may take (a reach join's: outside its allowed reach))
    const noRetain0 = typeof it.noRetain === 'function' ? it.noRetain : null;
    const noRetain = (x, z) => routeCols.has(`${x},${z}`) || nearLot(x, z) || keptCols.has(`${x},${z}`) || priorCols.has(`${x},${z}`) || (noRetain0 ? noRetain0(x, z) : false);
    // ((6c S3) the guard's parapet columns, once each over every edge; never on another route's cells, a kept column, or a lot's
    // footprint, apron or (a slope pad's) batter, but beside a wall pad's apron: its ring is the parapet's ground)
    const guardCols = mats.guard ? new Set() : null;
    const inPad = (x, z) => this.lots.some((l) => { const m = 1 + (l.pad?.edge === 'slope' ? Math.max(l.pad.maxCut ?? 0, l.pad.maxFill ?? 0) : 0); return x >= l.box.minX - m && x <= l.box.maxX + m && z >= l.box.minZ - m && z <= l.box.maxZ + m; });
    const noGuard = mats.guard ? (x, z) => routeCols.has(`${x},${z}`) || priorCols.has(`${x},${z}`) || inPad(x, z) || keptCols.has(`${x},${z}`) : null;
    // a slope pad's batter fill (stage before the routes): ring k (1..maxFill) out from the apron is filled to the pad's top - 1 - k
    const fillTop = (x, z) => {
      let top = -Infinity;
      for (const l of this.lots) {
        if (l.pad?.edge !== 'slope' || l.pad.fill === 'none') continue;
        const k = Math.max(l.box.minX - 1 - x, x - l.box.maxX - 1, l.box.minZ - 1 - z, z - l.box.maxZ - 1);
        if (k >= 1 && k <= (l.pad.maxFill ?? 0)) top = Math.max(top, l.floorY - 2 - k);
      }
      return top;
    };
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i], d = out.data.edges[i];
      const rid = `route_${e.id}`;
      const rec = { id: e.id, from: e.a.name, to: e.b.name, movers: e.movers, ladders: e.ladders, width: e.width, ok: d.ok, failed: d.failed ?? null, length: d.length, rise: d.rise, cost: d.cost, search: d.search, expanded: d.expanded, roads: [], paths: [] };
      if (d.rope) rec.rope = d.rope; // (7a K1b) why a rope_bridge edge found no route ({code, evidence})
      if (d.bridge) rec.bridge = d.bridge; // (6c T3) why a bridge edge found no route ({code, evidence, ...})
      if (d.tunnel) rec.tunnel = d.tunnel; // (6c T3) why a tunnel edge found no route
      if (d.t7) rec.t7 = d.t7; // (7a) why a 7a row's edge found no route ({lift | catwalk | rock_stair: {code, evidence}}, as each row's fail sets it)
      metaEdges.push(rec);
      if (!d.ok) { this.note(`route ${e.id} (${e.a.name} -> ${e.b.name}): ${d.failed} (${d.note})`); res.push({ id: e.id, ok: false, failed: d.failed }); continue; }
      // ((6c D3) an edge with its own part: its paths there)
      p = p0;
      if (e.d3.part) { p = this.part(e.d3.part, { stage, set: 'path' }); (this.meta.parts[p.id] ??= {}).kind = 'path'; }
      rec.path = d.path; rec.segments = d.segments; rec.landings = d.landings; rec.ladderCols = d.ladderCols;
      if (d.gates) rec.gates = d.gates; // (7a K1) the gates the edge crossed (only when the plan has walls)
      let n = 0;
      const ladderSegs = [];
      const ec = edgeColumns({ path: d.path, segments: d.segments, landings: d.landings, width: e.width });
      // ((6c D3) an edge with a `lead` meets its junction square on: no column behind the junction cell (the street's end column, a verge)
      // is its; absent: as before)
      if (e.d3.lead && !e.d3.keepBehind && Array.isArray(e.b.facing)) {
        const [gx, , gz] = e.b.at, [fx, fz] = e.b.facing;
        const behind = (o) => (o.x - gx) * fx + (o.z - gz) * fz < 0;
        ec.cols = ec.cols.filter((o) => !behind(o));
        ec.bySeg = ec.bySeg.map((l) => l.filter((o) => !behind(o)));
      }
      // (a column an earlier edge wrote stays that edge's: the search kept this edge within a step of it)
      const fpOf = (si) => ec.bySeg[si].filter((o) => !taken.has(`${o.x},${o.z}`)).map((o) => [o.x, o.z, o.y, o.edge]);
      d.segments.forEach((g, si) => {
        const cells = d.path.slice(g.from, g.to + 1);
        n++;
        if (g.shared) return; // an earlier edge's cells: built by it
        // (7a K1) a rope span is the links stage's (its deck, rails and posts); the route writes its approaches only; (6c T3) so are a
        // bridge's span and a tunnel's bore, but the route writes a bridge's far landing (the segment's last cell: on the walk's fill it is
        // no natural ground; the walk after the span starts from it)
        // ((7a CW) and a catwalk's landing, the same way: the run's deck is the links stage's)
        // ((7a RK) and a rock stair's landing walk cell, the same way as a catwalk's: the flight's treads are the links stage's)
        if (g.kind === 'bridge' || g.kind === 'catwalk' || g.kind === 'rock_stair') {
          const land = cells[cells.length - 1];
          // ((7a CW) a catwalk's landing: only its lanes' row across the run (the single cell's square would reach back over the deck)
          const across = g.kind === 'catwalk' || g.kind === 'rock_stair' ? (q) => (g.dir[0] !== 0 ? q[0] === land[0] : q[1] === land[2]) : () => true;
          const fp = footprintOf([land], e.width).filter((q) => across(q) && !taken.has(`${q[0]},${q[1]}`)).map((q) => [q[0], q[1], q[2], q[3]]);
          if (fp.length) rec.paths.push(p._routeRun(`${rid}_${n}l`, fp, mats, { baseAt, mark: (x, z) => mark(x, z, e.id), cells: [land], noRetain, fillTop, guardCols, noGuard }));
          return;
        }
        // (6c T3b: a tunnel segment's own handling goes here)
        if (g.kind === 'tunnel') return;
        if (g.kind === 'rope') return;
        // ((7a K3) a gatehouse's passage: the lot's design and pad (the route writes nothing in the box)
        if (g.kind === 'passage') return;
        // (7a foundation) a lift's, a catwalk's or a rock stair's own cells are the links stage's (rows 9-11; their slices write them)
        if (ROW_SEGMENTS_7A.includes(g.kind)) return;
        if (g.kind === 'walk' || g.kind === 'landing' || g.kind === 'gate') {
          // 4e's ground road where a walk lies on the surveyed ground (4e follows the realised ground at realise), else graded columns
          // ((7a CL) never on a ladder edge: 4e re-grades its road to the realised ground, and at the face it ramps up against the cliff)
          const onGround = g.kind === 'walk' && (e.k1?.profile ?? e.profile) !== 'ladder' && !it.base && !mats.guard && !e.d3.graded && e.width <= 5 && cells.length >= 4 && cells.every(([x, y, z]) => y === s.groundAt(x, z) && !s.waterAt(x, z));
          if (onGround) {
            const idx = polylineOf(cells);
            const id = `${rid}_${n}`;
            // (6c D1) `roadSurface`: the 4e road's surface role (absent: 4e's default, as before)
            const r = p.road(idx.map((k) => [cells[k][0], cells[k][1], cells[k][2]]), { mode: 'ground', width: e.width, id, lanterns: it.lanterns ?? true, lamp: it.lamp ?? null, ...(it.roadSurface ? { surface: it.roadSurface } : {}) });
            (r.mode === 'ground' ? rec.roads : rec.paths).push(...r.ids);
            for (const q of footprintOf(cells, e.width + 2)) mark(q[0], q[1], e.id);
            return;
          }
          // ((6c S3) a run whose every column an earlier edge wrote builds nothing: it registered an empty path, whose box no IR can hold)
          const fp = fpOf(si);
          if (fp.length) rec.paths.push(p._routeRun(`${rid}_${n}`, fp, mats, { baseAt, mark: (x, z) => mark(x, z, e.id), cells, noRetain, fillTop, guardCols, noGuard }));
        } else if (g.kind === 'stair') {
          // the flight's ground (cut above, fill below), then the treads
          p._routeRun(`${rid}_${n}g`, fpOf(si), mats, { baseAt, mark: (x, z) => mark(x, z, e.id), cells, noSurface: true, register: false, noRetain, fillTop });
          const st = p.stair([cells[0], cells[cells.length - 1]], { width: e.width, landingEvery: 8, carve: true, material: e.k1?.stairMaterial ?? mats.stair, id: `${rid}_${n}`, ...(mats.guard ? { railing: mats.guard, railSkip: (x, z) => priorCols.has(`${x},${z}`) } : {}) });
          rec.paths.push(st.id);
        } else if (g.kind === 'ladder') {
          ladderSegs.push(n);
        }
      });
      // the ladders last (after the walk runs' cuts and fills at their feet)
      d.ladderCols.forEach((lc, k) => { rec.paths.push(p._ladder(`${rid}_${ladderSegs[k]}`, lc)); mark(lc.x, lc.z, e.id); });
      for (const o of ec.cols) if (!d.segments[o.seg].shared) taken.add(`${o.x},${o.z}`);
      // ((6c D3) a framed edge records the columns it wrote: its reach)
      if (e.d3.frame) rec.written = keyRuns([...written].filter(([, id]) => id === e.id).map(([k]) => k));
      // the graph: the ends' nodes (made when missing) and the edge with its movers and segments
      const port = (end) => {
        let g = this.graph.nodes.find((x) => x.id === end.name);
        if (!g) g = this.graphNode({ id: end.name, kind: end.lot ? 'lot' : 'junction', ref: end.lot ?? end.name, at: end.at, ports: [{ name: 'route', at: end.at, facing: end.facing ? cardinalOf(end.facing[0], end.facing[1]) : 'up', width: e.width }] });
        return `${g.id}.${g.ports[0].name}`;
      };
      this.graphEdge({ id: rid, from: port(e.a), to: port(e.b), type: e.type, width: e.width, path: rid, stage, movers: e.movers, segments: d.segments.map((g) => ({ kind: g.kind, from: g.from, to: g.to })) });
      res.push({ id: e.id, ok: true, length: d.length, rise: d.rise, segments: d.segments.length });
    }
    // keep-out: a route never writes into it (with the obstacle off, the plan is refused here)
    for (const [k, id] of written) {
      const [x, z] = k.split(',').map(Number);
      const b = keepOut.find((q) => x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3]);
      if (b) throw new Error(`KEEP_OUT: route ${id} writes into the keep-out rect [${b.join(', ')}] (at ${x}, ${z})`);
    }
    const hairpins = metaEdges.reduce((a, x) => a + (x.landings?.length ?? 0), 0);
    this.meta.route = { maxGrade: it.maxGrade ?? 0.25, hairpinLanding: it.hairpinLanding ?? 3, stairs: it.stairs ?? true, part: p0.id, stage, edges: metaEdges, hairpins, keepOut };
    this.passRuns.push({ name: 'route', ms, heapMb });
    this.note(`pass route: ${(ms / 1000).toFixed(1)} s, ${heapMb} MB${out.data.coarse ? ` (coarse: resolution ${out.data.resolution})` : ''}; ${out.data.routed}/${edges.length} edges routed, ${hairpins} hairpin(s)`);
    return { edges: res, data: { ...out.data, ms } };
  }

  /** (7a K1b) A rope bridge between two landings on one axis (lib/connectors/ropeGeom.mjs, CONTRACT K1 §3); returns its path record. */
  ropeBridge(a, b, opts = {}) {
    return ropeBridge(this, a, b, opts);
  }

  /**
   * (6c T3a) A bridge (beam or arch) between two landings on one axis (lib/connectors/bridgeGeom.mjs, CONTRACT T3 §3); returns its
   * record. Without `opts.land` or `opts.check` the span is checked against the plan survey (the 2.5D classes).
   */
  bridgeSpan(a, b, opts = {}) {
    return bridgeSpan(this, a, b, opts.land || opts.check ? opts : { ...opts, land: surveyLand(this.ctx.survey) });
  }

  /**
   * (6c T3b) A tunnel from a start walk cell to a landing walk cell on one axis (lib/connectors/tunnelGeom.mjs `tunnel`, CONTRACT T3
   * §3): `opts.land` is tunnelLand over the plan survey and the frozen volumes the program asked for. Returns its record.
   */
  tunnel(a, b, opts = {}) {
    return tunnelPrimitive(this, a, b, opts);
  }

  /**
   * (6c H) A fluid body (lib/fluids/body.mjs `fluidBody`, CONTRACT H §7): the shell in the generator's stage, the sources (and ice cap)
   * as a `fluid` op in the `fluids` stage (which must be the region's last), the flow computed (spill, vanilla's steady state, the
   * settle bound, the breach reach). Returns the body record.
   */
  fluidBody(cells, opts = {}) {
    if (!_bindFluidBody.fn) throw new Error('fluidBody: the fluid body primitive is not loaded (kit/lib/fluids/body.mjs)');
    return _bindFluidBody.fn(this, cells, opts);
  }

  /**
   * (6c HY) A course (lib/fluids/course.mjs `course`, CONTRACT HY §5, §7): water laid along `path` (a hydrology pass's data.courses[i],
   * `{cells: [[x, z]], accumulation?}`, or a polyline `[[x, z], ...]`) as a chain of level reaches (r.fluidBody, ids `<id>_r<k>` from the
   * head) joined by falls and spillways. opts: {id, part, look, flow, width, depth, drop, riffle, cut, fill, stage, from, to}. Returns the
   * course record `{id, part, bodies, steps, ends, refused}` (refused: null, or the reason nothing was laid; never a throw).
   */
  course(path, opts = {}) {
    if (!_bindCourse.fn) return { id: opts.id ?? null, part: opts.part ?? null, bodies: [], steps: [], ends: [], refused: { code: 'UNREACHABLE', message: 'r.course: the course primitive is not loaded (kit/lib/fluids/course.mjs)', until: 'HYb' } };
    return _bindCourse.fn(this, path, opts);
  }

  /** (6c V) A graph node (SETTLEMENTS §8.1): `{id, kind: lot|plaza|junction, ref, at, ports}`; ids unique. */
  graphNode({ id, kind, ref = null, at, ports = [] }) {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_:.-]{0,63}$/.test(id)) throw new Error(`graph node id '${id}' is not valid`);
    if (this.graphIds.has(id)) throw new Error(`graph id '${id}' is used twice`);
    // (7a K1) a gate in a wall is a node too
    // ((7a K2) a wall walk's access (a flight or a ladder up its inner face) too)
    // ((7a SA) a spiral's top is a lookout)
    // ((7a K3) a gatehouse's passage through its box: ports front and back)
    if (!['lot', 'plaza', 'junction', 'gate', 'access', 'lookout', 'passage'].includes(kind)) throw new Error(`graph node ${id}: kind must be lot, plaza, junction, gate, access, lookout or passage`);
    this.graphIds.add(id);
    const n = { id, kind, ref, level: 0, at: [...at], ports: ports.map((p) => ({ name: p.name, at: [...p.at], facing: p.facing, width: p.width })) };
    this.graph.nodes.push(n);
    return n;
  }

  /** (6c V) A graph edge `{id, from: 'node.port', to: 'node.port', type: road|path, width, path}` in stage `ground`. */
  graphEdge({ id, from, to, type, width, path, stage = 'ground', movers, segments, external = false, crossing, junction }) {
    if (this.graphIds.has(id)) throw new Error(`graph id '${id}' is used twice`);
    // (7a K1) a rope bridge's edge (with its crossing: {type: rope_bridge, over: gap|water, depth}); (6c T3) a bridge's and a tunnel's
    // ((7a foundation) and a 7a connector's: its kind (P0: "7a's edge `type` is the connector `kind`"), with its crossing)
    // ((7a K2) and a wall walk's run between two accesses: wall_walk)
    // ((7a K3) and a gatehouse's passage, front port to back port: passage)
    if (!['road', 'path', 'rope_bridge', 'bridge', 'tunnel', 'wall_walk', 'passage', ...KINDS_7A].includes(type)) throw new Error(`graph edge ${id}: type must be road, path, rope_bridge, bridge, tunnel, wall_walk, passage or a 7a connector kind (${KINDS_7A.join(', ')})`);
    // (6c D1) an external edge's `to` is another region's port, `<regionId>:<node>.<port>` (CONTRACT D §3; 7a types it)
    // ((6c D3, §3.5) a side junction's edge names the street road: `<regionId>:<roadId>` with `junction {kind: side, ...}`)
    const sideTo = external && junction?.kind === 'side' && /^[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_#.-]{1,64}$/.test(String(to));
    if (external && !sideTo && !/^[A-Za-z0-9_.-]{1,64}:[a-z][a-z0-9_:.-]{0,63}\.[a-z][a-z0-9_]{0,63}$/.test(String(to))) throw new Error(`graph edge ${id}: an external edge's to must be <region>:<node>.<port>`);
    for (const end of external ? [from] : [from, to]) {
      const [n, p] = String(end).split('.');
      const node = this.graph.nodes.find((x) => x.id === n);
      if (!node || !node.ports.some((q) => q.name === p)) throw new Error(`graph edge ${id}: no port '${end}'`);
    }
    this.graphIds.add(id);
    const e = { id, from, to, type, width, stage, path };
    // (6c T2) a routed edge carries its movers and its segments (only when set, so V's graphs are unchanged)
    if (movers !== undefined) e.movers = [...movers];
    if (segments !== undefined) e.segments = segments.map((g) => ({ ...g }));
    if (external) e.external = true;
    if (crossing !== undefined) e.crossing = { ...crossing };
    // ((6c D3) a reach join's junction: {kind: end|side, at, side?, u?})
    if (junction !== undefined) e.junction = JSON.parse(JSON.stringify(junction));
    this.graph.edges.push(e);
    return e;
  }

  /** Declare the stages, in order (at most 64). Parts and lots must then name one of them. */
  stages(list) {
    if (this._stages) throw new Error('stages() may be called once');
    if (!Array.isArray(list) || !list.length) throw new Error('stages() takes a non-empty array of names');
    for (const s of list) if (typeof s !== 'string' || !STAGE_NAME.test(s)) throw new Error(`stage name '${s}' must match ${STAGE_NAME}`);
    if (new Set(list).size !== list.length) throw new Error('stages: duplicate names');
    this._stages = [...list];
    return this;
  }

  _stage(name) {
    const s = name ?? (this._stages ? this._stages[0] : 'main');
    if (typeof s !== 'string' || !STAGE_NAME.test(s)) throw new Error(`stage name '${s}' must match ${STAGE_NAME}`);
    if (this._stages) {
      if (!this._stages.includes(s)) throw new Error(`stage '${s}' is not declared (stages: ${this._stages.join(', ')})`);
    } else {
      this._implicit ??= [];
      if (!this._implicit.includes(s)) this._implicit.push(s);
    }
    return s;
  }

  get stageList() { return this._stages ?? this._implicit ?? ['main']; }

  /**
   * A part: the unit of per-part counts and (6d) diffs. `set`: 'terrain' (default) or 'path'. (6c MP) `mask`: every op of the
   * part keeps only the cells it selects (an op's own mask wins).
   */
  part(id, { stage, set = 'terrain', mask } = {}) {
    if (typeof id !== 'string' || !PART_ID.test(id)) throw new Error(`part id '${id}' must match ${PART_ID}`);
    if (this.partIds.has(id)) throw new Error(`part id '${id}' is used twice (part ids are unique)`);
    if (set !== 'terrain' && set !== 'path') throw new Error(`part ${id}: set must be 'terrain' or 'path'`);
    const p = new Part(this, id, this._stage(stage), set, mask === undefined || mask === null ? null : this.mask(mask, `part ${id}: mask`));
    this.partIds.add(id);
    this.parts.push(p);
    return p;
  }

  /** A named point: `entrance` and `spawn` are required; `cam_*` and others are free. y defaults to ground + 1. */
  anchor(name, at) {
    if (typeof name !== 'string' || !ANCHOR_NAME.test(name)) throw new Error(`anchor name '${name}' must match ${ANCHOR_NAME}`);
    if (!Array.isArray(at) || (at.length !== 2 && at.length !== 3)) throw new Error(`anchor ${name}: at must be [x, z] or [x, y, z]`);
    const [x, y, z] = at.length === 2 ? [at[0], null, at[1]] : at;
    if (!isInt(x) || !isInt(z) || (y !== null && !isInt(y))) throw new Error(`anchor ${name}: coordinates must be integers`);
    const c = this.claim;
    if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) throw new Error(`anchor ${name} (${x}, ${z}) is outside the claim`);
    const yy = y ?? this.survey.heightAt(x, z) + 1;
    if (yy < c.minY || yy > c.maxY) throw new Error(`anchor ${name}: y ${yy} is outside the claim's y range ${c.minY}..${c.maxY}`);
    this.anchors[name] = [x, yy, z];
    return [x, yy, z];
  }

  /**
   * (6b) A clearing for an anchor on the ground: natural cells (trees, plants, a bump) removed over a (2r+1)^2 square from
   * one above the frozen ground to the column's top, so the anchor stands on open ground (M2 starts there).
   */
  clearing(name, [x, z], { r = 2, stage } = {}) {
    const p = this.part(`clear_${name}`, { stage });
    p.fill({ kind: 'box', min: [x - r, { surface: 1 }, z - r], max: [x + r, { max: [{ height: 0 }, { surface: 3 }] }, z + r] }, null, { cond: COND.IF_NATURAL, terrain: true });
    return this.anchor(name, [x, z]);
  }

  /**
   * (6c MP) A mask for an op (lib/mask.mjs), resolved for the IR: block ids and tags qualified and checked against the 26.3
   * tables, a noise term's label (`{noise: 'age'}`) turned into its seeded spec (this.noise). Throws with the path on a bad spec.
   */
  mask(spec, what = 'mask') {
    const fix = (m) => {
      if (!m || typeof m !== 'object' || Array.isArray(m)) return m;
      if (Array.isArray(m.all)) return { ...m, all: m.all.map(fix) };
      if (Array.isArray(m.any)) return { ...m, any: m.any.map(fix) };
      if (m.not !== undefined) return { ...m, not: fix(m.not) };
      if (typeof m.noise === 'string') return { ...m, noise: this.noise(m.noise) };
      if (Array.isArray(m.block)) {
        return { ...m, block: m.block.map((b) => {
          if (typeof b !== 'string') return b;
          if (b.startsWith('#')) {
            const t = `#${qualify(b.slice(1))}`;
            const ids = tagBlocks(t);
            if (!ids) throw new Error(`${what}: '${b}' is not a 26.3 block tag`);
            this.blockTags[t] = [...ids];
            return t;
          }
          info(b);
          return qualify(b);
        }) };
      }
      return m;
    };
    const out = fix(spec);
    const e = maskError(out, what, { fields: new Set(Object.keys(this.fields)) });
    if (e) throw new Error(e);
    return out;
  }

  /** (6c MP) A pattern (lib/pattern.mjs) with its roles resolved to block states: the IR's `{pattern: spec}` material. */
  pattern(spec, what = 'pattern') {
    const e0 = patternError(spec, what);
    if (e0) throw new Error(e0);
    const out = mapPatternMats(spec, (m) => this.material(m, `${what} mat`));
    const e = patternError(out, what, { fields: new Set(Object.keys(this.fields)) });
    if (e) throw new Error(e);
    return { pattern: out };
  }

  /**
   * (6c MP) A material where a pattern is welcome (fill, carve, material rule clauses): a pattern spec ({mix} / {gradient} /
   * {pattern: spec}), a role with a bible pattern (painted with it), or anything `material` takes.
   */
  paint(v, what = 'material') {
    if (v && typeof v === 'object' && v.pattern !== undefined) return this.pattern(v.pattern, what);
    if (isPattern(v)) return this.pattern(v, what);
    if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(this.rolePatterns, v)) return { pattern: this.rolePatterns[v] };
    return this.material(v, what);
  }

  /** A seeded noise field spec, for `displace` (same seed and label, same values). */
  noise(field, { kind = 'simplex', octaves = 1, scale = 32, seedLabel, dims = 2 } = {}) {
    if (typeof field !== 'string' || !field) throw new Error('noise(field): field must be a name');
    return { kind, dims, scale, octaves, seed: fnv64(this.ctx.seed, 'noise', seedLabel ?? field).hex };
  }

  /** Declare the cell budget (default 20M, hard cap 64M); the plan fails when the exact count is over it. */
  budget(cells) {
    if (!isInt(cells) || cells < 1) throw new Error('budget(cells) takes a positive integer');
    this.budgetCells = cells;
    return this;
  }

  /** A note for the plan report. */
  note(msg) { this.notes.push(String(msg)); return this; }

  /**
   * Register a heightfield / mask blob `{minX, minZ, width, depth, data (base64), kind: 'heightfield'|'mask'}` for shapes to
   * name. (6b) Blobs are side files named by sha (format 2, CONTRACT 6b B2): the IR holds `{sha, bytes, kind}`.
   */
  blob(name, b) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(name)) throw new Error(`blob name '${name}' must match [a-z][a-z0-9_]{0,31}`);
    if (!b || !isInt(b.minX) || !isInt(b.minZ) || !isInt(b.width) || !isInt(b.depth) || (typeof b.data !== 'string' && !(b.values instanceof Uint8Array))) throw new Error(`blob ${name}: needs {minX, minZ, width, depth, data (base64) | values (bytes)}`);
    const kind = b.kind ?? 'heightfield';
    if (kind !== 'heightfield' && kind !== 'mask') throw new Error(`blob ${name}: kind must be heightfield or mask`);
    const data = b.values instanceof Uint8Array ? b.values : Uint8Array.from(Buffer.from(b.data, 'base64'));
    this._sideBlob(name, kind, encodeArbl(kind, b.minX, b.minZ, b.width, b.depth, data));
    return name;
  }

  _sideBlob(name, kind, bytes) {
    if (this.sideBlobs[name]) throw new Error(`blob '${name}' is defined twice`);
    if (bytes.length > 16 * 1024 * 1024) throw new Error(`blob ${name} is ${bytes.length} bytes (at most 16 MB)`);
    this.sideBlobs[name] = { kind, bytes };
  }

  /** (6b) A 2D field for material rules: `{type: 'u8'|'i16', minX, minZ, width, depth, res: 1|4, values}` (a side blob). */
  field(name, f) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(name)) throw new Error(`field name '${name}' must match [a-z][a-z0-9_]{0,31}`);
    if (!f || (f.type !== 'u8' && f.type !== 'i16') || ![1, 4].includes(f.res ?? 1) || ![f.minX, f.minZ, f.width, f.depth].every(isInt)) throw new Error(`field ${name}: needs {type: u8|i16, minX, minZ, width, depth, res: 1|4, values}`);
    const n = f.width * f.depth;
    if (!f.values || f.values.length !== n) throw new Error(`field ${name}: values must have width*depth = ${n} entries`);
    const bytes = new Uint8Array(f.type === 'u8' ? n : 2 * n);
    for (let i = 0; i < n; i++) {
      const v = Math.trunc(f.values[i]);
      if (f.type === 'u8') bytes[i] = Math.max(0, Math.min(255, v));
      else { const w = Math.max(-32768, Math.min(32767, v)) & 0xffff; bytes[2 * i] = w & 255; bytes[2 * i + 1] = w >> 8; }
    }
    const blob = `field_${name}`;
    this._sideBlob(blob, 'field', bytes);
    this.fields[name] = { blob, type: f.type, minX: f.minX, minZ: f.minZ, width: f.width, depth: f.depth, res: f.res ?? 1 };
    return name;
  }

  /** (6b) Declare floating parts (M3: connected to each other and to `anchor` when given, not to ground). */
  floating(partIds, { anchor = null } = {}) {
    if (!Array.isArray(partIds) || !partIds.length) throw new Error('floating(parts): a non-empty array of part ids');
    for (const id of partIds) if (!this.partIds.has(id)) throw new Error(`floating: no part '${id}'`);
    if (anchor !== null && typeof anchor !== 'string') throw new Error('floating: anchor is an anchor name');
    this.floatingDecl.push({ parts: [...partIds], anchor });
    for (const id of partIds) { const m = (this.meta.parts[id] ??= {}); m.floating = true; }
    return this;
  }

  /**
   * (6b) Ask the planner for a frozen 3D volume over `box` (the two-plan flow); returns the decoded volume when it was given.
   * (6c B) `{blocks: true}`: a volume that also records each cell's block id (ARVX version 2), for a mask's `block` term; a
   * version-1 volume of the same box does not answer it (null: the game samples one with blocks).
   */
  needVolume(box, { blocks = false, fluids = false } = {}) {
    const b = { minX: box.minX, minY: box.minY, minZ: box.minZ, maxX: box.maxX, maxY: box.maxY, maxZ: box.maxZ };
    if (!Object.values(b).every(isInt)) throw new Error('needVolume: box needs integer minX..maxZ');
    // (6c F1) asking again for the same box gives the same volume (keepNatural and the program may both read it)
    const same = (x) => x.minX === b.minX && x.minY === b.minY && x.minZ === b.minZ && x.maxX === b.maxX && x.maxY === b.maxY && x.maxZ === b.maxZ;
    // (6c H) {fluids: true}: a volume that also records each cell's fluid (ARVX version 3's fluid layer, CONTRACT H §10); a volume
    // without it does not answer such a request (the game samples one with fluids)
    const has = (d) => (!blocks || d?.blocks) && (!fluids || d?.fluids);
    const had = Object.entries(this.volumesUsed).find(([, u]) => same(u.box) && (!blocks || u.blocks) && (!fluids || u.fluids));
    if (had) return this._volumeDecoded?.get(had[0]) ?? null;
    const asked = this.needVolumes.find(same);
    if (asked) {
      if (blocks && !asked.blocks) asked.blocks = true;
      if (fluids && !asked.fluids) asked.fluids = true;
      return null;
    }
    this.needVolumes.push({ ...b, ...(blocks ? { blocks: true } : {}), ...(fluids ? { fluids: true } : {}) });
    const v = this.ctx.volumes?.find((x) => same(x.box) && has(x.decoded));
    if (!v) return null;
    const name = `vol_${Object.keys(this.volumesUsed).length + 1}`;
    this._sideBlob(name, 'volume', v.bytes);
    this.volumesUsed[name] = { blob: name, ...(v.decoded?.blocks ? { blocks: true } : {}), box: b, ...(v.decoded?.fluids ? { fluids: true } : {}), sha: v.sha };
    (this._volumeDecoded ??= new Map()).set(name, v.decoded ?? null);
    return v.decoded ?? null;
  }

  /**
   * (6c F1 §3) Keep the frozen volume's natural cells of class `cls` (a VoxelClass name, e.g. 'ICE') inside `box`: they go into
   * the IR as a `keep` entry `{volume, class, box}` on part `part` (default `keep_<class>`, created in `stage`), so the checker
   * refuses (M1, an error) any op that writes one, and the program can keep its lots, routes and forms off them. Returns
   * `{volume, cells, columns: Set("x,z"), has(x, y, z), near(x, z, r)}`, or null on the first plan (no volume yet: the two-plan
   * flow plans again with it).
   */
  keepNatural(cls, box, { part = null, stage } = {}) {
    if (!VOXEL_CLASSES.includes(cls) || ['AIR', 'MISSING', 'OWNED', 'PLAYER'].includes(cls)) throw new Error(`keepNatural: '${cls}' is not a natural voxel class`);
    const v = this.needVolume(box);
    if (!v) return null;
    const name = Object.entries(this.volumesUsed).find(([, u]) => u.box.minX === box.minX && u.box.minY === box.minY && u.box.minZ === box.minZ && u.box.maxX === box.maxX && u.box.maxY === box.maxY && u.box.maxZ === box.maxZ)[0];
    const pid = part ?? `keep_${cls.toLowerCase()}`;
    let p = this.parts.find((q) => q.id === pid);
    if (!p) { p = this.part(pid, { stage }); (this.meta.parts[pid] ??= {}).kind = 'keep'; }
    p.keep = [...(p.keep ?? []), { volume: name, class: cls, box: { minX: box.minX, minY: box.minY, minZ: box.minZ, maxX: box.maxX, maxY: box.maxY, maxZ: box.maxZ } }];
    const want = VC[cls];
    const columns = new Set();
    let cells = 0;
    for (let x = box.minX; x <= box.maxX; x++) for (let z = box.minZ; z <= box.maxZ; z++) for (let y = box.minY; y <= box.maxY; y++) {
      if (classAt(v, x, y, z) !== want) continue;
      cells++;
      columns.add(`${x},${z}`);
    }
    const has = (x, y, z) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && z >= box.minZ && z <= box.maxZ && classAt(v, x, y, z) === want;
    const near = (x, z, r) => { for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (columns.has(`${x + dx},${z + dz}`)) return true; return false; };
    return { volume: name, part: pid, cells, columns, has, near };
  }

  /**
   * (6c S2) The [x, z] columns holding a cell of any part's keep set (r.keepNatural), sorted (z, then x), from the decoded volumes.
   * Empty without keep sets (or before the volume arrives). Cached until the next keepNatural.
   */
  _keptColumns() {
    const sets = this.parts.flatMap((p) => p.keep ?? []);
    if (!sets.length) return [];
    if (this._keptCache && this._keptCache.n === sets.length) return this._keptCache.cols;
    const cols = new Set();
    for (const k of sets) {
      const v = this._volumeDecoded?.get(k.volume);
      if (!v) continue;
      const want = VC[k.class], b = k.box;
      for (let z = b.minZ; z <= b.maxZ; z++) for (let x = b.minX; x <= b.maxX; x++) for (let y = b.minY; y <= b.maxY; y++) {
        if (classAt(v, x, y, z) === want) { cols.add(`${x},${z}`); break; }
      }
    }
    const out = [...cols].map((s) => s.split(',').map(Number)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    this._keptCache = { n: sets.length, cols: out };
    return out;
  }

  /** (6c F1) An `iceSpike` cluster (lib/forms/iceSpike.mjs) as form part `id`, on the plan ground. Options as `form` (`bake`). */
  iceSpike(id, params, opts = {}) {
    const gen = iceSpike({ ...params, seed: params.seed ?? fnv64(this.ctx.seed, 'iceSpike', id).hex }, { groundAt: (x, z) => this.survey.heightAt(x, z) });
    this.form(id, gen, opts);
    return gen;
  }

  /**
   * (6c F3) A `giantTree` (lib/forms/giantTree.mjs) as form part `id`, on the plan ground: always baked, its column mask in the IR's
   * `forms[]`. Returns the generator's result.
   */
  giantTree(id, params, opts = {}) {
    const gen = giantTree({ ...params, seed: params.seed ?? fnv64(this.ctx.seed, 'giantTree', id).hex }, { groundAt: (x, z) => this.survey.heightAt(x, z) });
    this.form(id, gen, opts);
    return gen;
  }

  /** (6c F3) A `giantMushroom` (lib/forms/giantMushroom.mjs) as form part `id`, on the plan ground (always baked). */
  giantMushroom(id, params, opts = {}) {
    const gen = giantMushroom({ ...params, seed: params.seed ?? fnv64(this.ctx.seed, 'giantMushroom', id).hex }, { groundAt: (x, z) => this.survey.heightAt(x, z) });
    this.form(id, gen, opts);
    return gen;
  }

  /** (6c F1) A `rockSpire` (lib/forms/rockSpire.mjs) as form part `id`, on the plan ground. Options as `form` (`bake`, `_unsafe`). */
  rockSpire(id, params, { _unsafe, ...opts } = {}) {
    const gen = rockSpire({ ...params, seed: params.seed ?? fnv64(this.ctx.seed, 'rockSpire', id).hex }, { groundAt: (x, z) => this.survey.heightAt(x, z), _unsafe });
    this.form(id, gen, opts);
    return gen;
  }

  /**
   * (6b) A floating island (lib/forms/floatingIsland.mjs) as form part `id`, declared floating with an anchor `anchor`
   * (default: the part id) at its top centre. Returns the generator's result (pads with their y, the anchor).
   */
  floatingIsland(id, params, { stage, anchor } = {}) {
    const isl = floatingIsland({ ...params, seed: params.seed ?? fnv64(this.ctx.seed, 'island', id).hex });
    this.form(id, isl, { stage });
    const name = anchor ?? id;
    this.anchor(name, isl.anchor);
    this.floating([id], { anchor: name });
    const m = this.meta.parts[id];
    m.island = { at: isl.params.at, r: isl.params.r, pads: isl.pads, anchor: isl.anchor };
    return isl;
  }

  /**
   * (7a K1) Connector primitives, usable by any program (docs/CONTRACT.md "Phase 7a slice K1" §3; kit/lib/connectors/):
   * `r.wall(line, opts)` a wall on a polyline ([[x, z], ...] corners) or a ring ({ring: [x0, z0, x1, z1]}, the line's inner rect),
   * `opts` {id, stage, height, thickness, crenels, corners, closed, lamps, gates: [{at: [x, z], width, door, frame, height}]}: built
   * now, or with `defer: true` a handle whose `.gate(at, o)` adds gates and `.done()` builds it; `r.gate(handle, at, opts)` is
   * `handle.gate(at, opts)`; `r.ropeBridge(a, b, opts)` is K1b's (above, lib/connectors/ropeGeom.mjs).
   */
  wall(line, opts = {}) { return CONNECTOR_WALL.wallPrimitive(this, line, opts); }
  gate(wall, at, opts = {}) {
    if (!wall || typeof wall.gate !== 'function') throw new Error('r.gate: the wall must be a deferred r.wall(line, {defer: true}) handle');
    return wall.gate(at, opts);
  }

  /**
   * (6b) A generated form (plan time): `gen` is a generator result `{ops, bounds, generator, version, params, seed}`; its ops
   * go into part `id` (created in `stage`) and its provenance into the IR's `forms`.
   */
  form(id, gen, { stage, set = 'terrain', bake = 'auto' } = {}) {
    if (![true, false, 'auto'].includes(bake)) throw new Error(`form ${id}: bake must be true, false or 'auto'`);
    const p = this.part(id, { stage, set });
    const from = p.ops.length;
    if (gen.cells) {
      // (6c F3) a generator handing over its own final cells (block states, drift states fixed): always baked into one voxels op; its
      // 2.5D column mask rides beside its bounds (§3.2: what routes, walls, lots and later forms keep off). Lint STATE first.
      const lint = lintStates(gen.cells);
      if (lint) throw new Error(`form ${id}: ${lint}`);
      const blob = gen.blob ?? `vox_${id}`.slice(0, 32);
      let baked;
      if (gen.reuse) {
        // a copy of a form baked before (mega_bench's forest: a few variants per species, placed by origin)
        p._push({ op: 'voxels', blob, origin: gen.reuse.origin, rotation: 0, cond: COND.IF_NATURAL, walk: false });
        baked = { blob, cells: gen.reuse.cells, ops: gen.ops.length, copy: true };
      } else {
        const b = bakeCells(gen.cells, blob, { cond: COND.IF_NATURAL });
        this._sideBlob(blob, 'voxels', b.bytes);
        p._push(b.op);
        baked = { blob, cells: b.cells, ops: gen.ops.length };
      }
      this.forms.push({ id, generator: gen.generator, version: gen.version, params: gen.params, seed: gen.seed, bounds: gen.bounds, columns: gen.columns, part: id, opsFrom: from, opsTo: p.ops.length, baked });
      (this.meta.parts[id] ??= {}).kind = 'form';
      return p;
    }
    const resolved = [];
    for (const op of gen.ops) {
      if (op.op === 'shape') { const e = shapeError(op.shape); if (e) throw new Error(`form ${id}: ${e}`); }
      const o = { ...op, cond: op.cond ?? COND.IF_AIR_OR_FLUID, walk: !!op.walk };
      // role names resolve here (the IR holds block states only)
      if (op.op === 'columns') o.materials = op.materials.map((m) => this.material(m, `form ${id} material`));
      else o.material = op.material && typeof op.material === 'object' ? this.materialRule(op.material, `form ${id} material`) : this.material(op.material, `form ${id} material`);
      resolved.push(o);
    }
    // (6c F1 §2) past BAKE_OPS ops (or when asked) the form is baked: one voxels op over an ARVB side blob
    let baked = null;
    if (bake === true || (bake === 'auto' && resolved.length > BAKE_OPS)) {
      const blob = `vox_${id}`.slice(0, 32);
      const b = bakeOps(resolved, blob, { cond: COND.IF_NATURAL });
      this._sideBlob(blob, 'voxels', b.bytes);
      this.terrain(() => p._push(b.op)); // (6c RS) a form is a terrain kind's write
      baked = { blob, cells: b.cells, ops: resolved.length };
    } else this.terrain(() => { for (const o of resolved) p._push(o); });
    this.forms.push({ id, generator: gen.generator, version: gen.version, params: gen.params, seed: gen.seed, bounds: gen.bounds, part: id, opsFrom: from, opsTo: p.ops.length, ...(baked ? { baked } : {}) });
    (this.meta.parts[id] ??= {}).kind = 'form';
    return p;
  }

  /** A material: a role name (ctx.roles), a block state, or null / 'air'. Returns the block state or null (air). */
  material(v, what = 'material') {
    if (v === null || v === undefined || v === 'air' || v === 'minecraft:air') return null;
    if (v && typeof v === 'object' && v.rule) return this.materialRule(v, what);
    if (v && typeof v === 'object' && (v.pattern !== undefined || isPattern(v))) throw new Error(`${what}: a pattern is taken by fill, carve and material rules (this primitive needs one block)`);
    if (typeof v !== 'string') throw new Error(`${what}: a material is a role name or a block state (got ${JSON.stringify(v)})`);
    if (Object.prototype.hasOwnProperty.call(this.roles, v)) return this.roles[v];
    try {
      return blockState(v);
    } catch (e) {
      throw new Error(`${what}: '${v}' is neither a role (${Object.keys(this.roles).join(', ')}) nor a block state (${e.message})`);
    }
  }

  /** (6b) A material rule with role names resolved to block states: `{rule: {rule: [{when, mat}], default, dither}}` or the inner object. */
  materialRule(v, what = 'material') {
    const r = v.rule && Array.isArray(v.rule.rule) ? v.rule : v;
    const out = { rule: r.rule.map((c) => ({ when: c.when ?? {}, mat: this.paint(c.mat, `${what} rule`) })), default: this.paint(r.default ?? 'rock', `${what} rule default`) };
    if (r.dither !== undefined) out.dither = r.dither;
    const e = ruleError(out, what, new Set(Object.keys(this.fields)));
    if (e) throw new Error(e);
    return { rule: out };
  }

  /** y of a point given as a number (absolute) or {surface: dy} (the plan survey's ground + dy) at (x, z). */
  planY(y, x, z, what) {
    if (isNum(y)) return y;
    if (y && typeof y === 'object' && isNum(y.abs)) return y.abs;
    if (y && typeof y === 'object' && isNum(y.surface)) return this.survey.heightAt(round(x), round(z)) + y.surface;
    throw new Error(`${what}: y must be a number, {abs: n} or {surface: dy}`);
  }

  /** The lot box overlap check is the program's job; this only rejects overlapping lot boxes. */
  _addLot(lot) {
    for (const o of this.lots) {
      const a = lot.box, b = o.box;
      if (a.minX <= b.maxX && b.minX <= a.maxX && a.minZ <= b.maxZ && b.minZ <= a.maxZ) throw new Error(`lot ${lot.id} overlaps lot ${o.id}`);
    }
    this.lots.push(lot);
  }
}

class Part {
  constructor(region, id, stage, set, mask = null) {
    this.region = region;
    this.id = id;
    this.stage = stage;
    this.set = set;
    this.ops = [];
    // (6c MP) the part's mask: every shape and columns op it emits gets it (an op's own mask wins)
    this.mask = mask;
  }

  get roles() { return this.region.roles; }
  _mat(v, what) { return this.region.material(v, `${this.id}: ${what}`); }

  _push(op) {
    this.region.opCount++;
    if (this.mask !== null && op.mask === undefined) op.mask = this.mask;
    if (this.region._terrain > 0) TERRAIN_OPS.add(op); // (6c RS)
    this.ops.push(op);
  }

  _paint(v, what) { return this.region.paint(v, `${this.id}: ${what}`); }
  _mask(m, what = 'mask') { return m === undefined || m === null ? undefined : this.region.mask(m, `${this.id}: ${what}`); }

  /**
   * Low-level: every cell inside `shape` gets `material` (null: air) with `cond` and `walk`. (6c MP) `material` may be a
   * pattern ({mix} / {gradient}, or a role with a bible pattern); `mask` keeps only the cells it selects.
   */
  fill(shape, material, { cond = COND.IF_NATURAL, walk = false, mask, terrain = false } = {}) {
    const err = shapeError(shape);
    if (err) throw new Error(`part ${this.id}: ${err}`);
    if (!isInt(cond) || cond < 0 || cond > 3) throw new Error(`part ${this.id}: cond must be 0..3`);
    const op = { op: 'shape', shape, material: this._paint(material, 'fill material'), cond, walk: !!walk };
    const m = this._mask(mask);
    if (m !== undefined) op.mask = m;
    // (6c RS) `terrain: true`: a 6a shape fill, a terrain kind's write (free in survival when natural)
    if (terrain) this.region.terrain(() => this._push(op));
    else this._push(op);
    return this;
  }

  /**
   * (6c B) Low-level: a `columns` op. `cols` is a flat list of [x, z, a, b, m] entries (the cells of column (x, z) from
   * `resolve(from) + a` to `resolve(to) + b` get `materials[m]`); `materials` are anything `fill` takes (roles, block states, null
   * for air, patterns). `mask` keeps only the cells it selects.
   */
  columns(from, to, cols, materials, { cond = COND.IF_NATURAL, walk = false, mask, terrain = false } = {}) {
    if (!isInt(cond) || cond < 0 || cond > 3) throw new Error(`part ${this.id}: cond must be 0..3`);
    if (!Array.isArray(cols) || cols.length % 5 !== 0 || !cols.every(isInt)) throw new Error(`part ${this.id}: columns needs [x, z, a, b, m] integer entries`);
    if (!Array.isArray(materials) || !materials.length) throw new Error(`part ${this.id}: columns needs materials`);
    if (!cols.length) return this;
    for (let i = 4; i < cols.length; i += 5) if (cols[i] < 0 || cols[i] >= materials.length) throw new Error(`part ${this.id}: columns entry ${(i - 4) / 5} names material ${cols[i]} of ${materials.length}`);
    const op = { op: 'columns', from, to, cols: [...cols], materials: materials.map((m, i) => this._paint(m, `columns material ${i}`)), cond, walk: !!walk };
    const m = this._mask(mask);
    if (m !== undefined) op.mask = m;
    if (terrain) this.region.terrain(() => this._push(op)); // (6c RS) a terrain kind's write
    else this._push(op);
    return this;
  }

  _shapeOp(shape, material, cond, walk = false) {
    this._push({ op: 'shape', shape, material, cond, walk });
  }

  _colsOp(cols, cond, walk = false) {
    if (cols.empty) return;
    this._push({ op: 'columns', from: cols.from, to: cols.to, cols: cols.cols, materials: cols.materials, cond, walk });
  }

  _requirePath(what) {
    if (this.set !== 'path') throw new Error(`part ${this.id}: ${what} needs a path part (region.part(id, { set: 'path' }))`);
  }

  // ---------------------------------------------------------------- carve

  /**
   * Remove natural cells inside `shape` (`to: 'air'`, clipped to the column's top: never air written into air), or
   * fill them with a role. `lining`: a role written as a shell of `liningDepth` around the void, at or below the
   * column's floor, only over solid natural cells (IF_SOLID_NATURAL).
   */
  carve(shape, { to = 'air', lining = null, liningDepth = 1, naturalOnly = true, mask } = {}) {
    const err = shapeError(shape);
    if (err) throw new Error(`part ${this.id}: carve: ${err}`);
    if (!(isNum(liningDepth) && liningDepth > 0 && liningDepth <= 8)) throw new Error(`part ${this.id}: carve liningDepth must be 0 < d <= 8`);
    const cond = naturalOnly ? COND.IF_NATURAL : COND.ALWAYS_OURS;
    // (6c MP) the lining and `to` may be patterns; `mask` applies to both ops
    const m = this._mask(mask);
    const withMask = (op) => (m === undefined ? op : { ...op, mask: m });
    if (lining !== null) {
      const shell = { kind: 'clipY', y0: null, y1: { floor: 0 }, of: { kind: 'subtract', of: [{ kind: 'offset', d: liningDepth, of: shape }, shape] } };
      this._push(withMask({ op: 'shape', shape: shell, material: this._paint(lining, 'carve lining'), cond: COND.IF_SOLID_NATURAL, walk: false }));
    }
    const toMat = this._paint(to, 'carve to');
    this._push(withMask({ op: 'shape', shape: toMat === null ? { kind: 'clipY', y0: null, y1: { height: 0 }, of: shape } : shape, material: toMat, cond, walk: false }));
    return this;
  }

  // ---------------------------------------------------------------- add

  /**
   * Add a mass of `material` (IF_AIR_OR_FLUID). `underside: 'pillars'` adds pillars to the ground under the mass's
   * grid (every `supportEvery`) and rim, from the plan survey. 'taper' and 'rock' are phase 6b.
   */
  add(shape, material, { underside = 'flat', supportEvery = 8, pillarMaterial, taper = 0.6, undersideMaterial } = {}) {
    const err = shapeError(shape);
    if (err) throw new Error(`part ${this.id}: add: ${err}`);
    if (!['flat', 'pillars', 'taper', 'rock'].includes(underside)) throw new Error(`part ${this.id}: add underside must be flat, pillars, taper or rock`);
    const mat = this._mat(material, 'add material');
    this._shapeOp(shape, mat, COND.IF_AIR_OR_FLUID);
    (this.region.meta.parts[this.id] ??= {}).kind ??= 'add';
    if (underside === 'taper' || underside === 'rock') {
      // (6b) a seeded noise cone under the mass: from its widest footprint at its lowest y down to a point taper * radius below
      if (!(isNum(taper) && taper >= 0.3 && taper <= 1.5)) throw new Error(`part ${this.id}: add taper must be 0.3..1.5`);
      const ys = staticY(shape);
      if (!ys) throw new Error(`part ${this.id}: add underside '${underside}' needs a mass with an absolute y extent`);
      const node = compileShape(shape, this.region.blobs);
      const cx = (node.minX + node.maxX) / 2, cz = (node.minZ + node.maxZ) / 2;
      const r = Math.max(1, Math.min(node.maxX - node.minX, node.maxZ - node.minZ) / 2);
      const h = Math.max(2, round(r * taper));
      const y0 = Math.floor(ys[0]) + 1;
      let cone = { kind: 'cone', c: [cx, y0 - h, cz], r0: 0.5, r1: r * 0.92, h: h + 1 };
      if (underside === 'rock') cone = { kind: 'displace', amp: 2, noise: this.region.noise(`${this.id}_underside`, { kind: 'simplex', dims: 3, scale: 6, octaves: 2 }), of: cone };
      const um = undersideMaterial === undefined ? (underside === 'rock' ? this._mat('rock', 'underside') : mat) : this._mat(undersideMaterial, 'underside material');
      this._shapeOp(cone, um, COND.IF_AIR_OR_FLUID);
    }
    if (underside === 'pillars') {
      if (!(isInt(supportEvery) && supportEvery >= 1 && supportEvery <= 64)) throw new Error(`part ${this.id}: supportEvery must be 1..64`);
      const pm = pillarMaterial === undefined ? mat : this._mat(pillarMaterial, 'pillar material');
      const node = compileShape(shape, this.region.blobs);
      const s = this.region.survey;
      const lowest = (x, z) => {
        let lo = null;
        const col = { g: s.heightAt(x, z), h: s.topAt(x, z), f: s.floorAt(x, z) };
        columnCells(node, x, z, col, this.region.claim.minY, this.region.claim.maxY, (y) => { if (lo === null) lo = y; });
        return lo;
      };
      const x0 = Math.floor(node.minX), x1 = Math.ceil(node.maxX), z0 = Math.floor(node.minZ), z1 = Math.ceil(node.maxZ);
      const at = new Map();
      for (let z = z0; z <= z1; z++) {
        const row = [];
        for (let x = x0; x <= x1; x++) { const lo = lowest(x, z); if (lo !== null) row.push([x, lo]); }
        if (!row.length) continue;
        const onGrid = (z - z0) % supportEvery === 0;
        row.forEach(([x, lo], i) => {
          if ((onGrid && (x - x0) % supportEvery === 0) || (onGrid && (i === 0 || i === row.length - 1))) at.set(`${x},${z}`, [x, z, lo]);
        });
      }
      const cols = new Cols({ floor: 0 }, { abs: 0 });
      for (const [x, z, lo] of at.values()) cols.add(x, z, 1, lo - 1, pm);
      this._colsOp(cols, COND.IF_AIR_OR_FLUID);
    }
    return this;
  }

  // ---------------------------------------------------------------- cavern (6b)

  /**
   * A hollow: `shape` with a noise edge (`noise` spec or a field name for region.noise, `amp`), carved to air (natural
   * cells only). `floor: 'flat'` keeps everything below `floorY` (default: the shape's lowest y + 1) and lays a floor of
   * `floorMaterial` at floorY - 1 inside the hollow. **Light is mandatory**: a light block (`light.block`, default a
   * lantern) on the floor grid every `light.every` (default 8) cells, so no floor cell is more than every/2 from one.
   */
  cavern(shape, { noise, amp = 3, floor = 'flat', floorY, light = {}, floorMaterial = 'rock' } = {}) {
    const err = shapeError(shape);
    if (err) throw new Error(`part ${this.id}: cavern: ${err}`);
    if (floor !== 'flat' && floor !== 'natural') throw new Error(`part ${this.id}: cavern floor must be flat or natural`);
    if (!light || light === false) throw new Error(`part ${this.id}: cavern light is mandatory`);
    const every = light.every ?? 8;
    if (!(isInt(every) && every >= 2 && every <= 14)) throw new Error(`part ${this.id}: cavern light.every must be 2..14`);
    const ys = staticY(shape);
    if (!ys) throw new Error(`part ${this.id}: cavern needs a shape with an absolute y extent`);
    const nz = typeof noise === 'object' && noise ? noise : this.region.noise(typeof noise === 'string' ? noise : `${this.id}_cavern`, { kind: 'simplex', dims: 3, scale: 8, octaves: 2 });
    let hollow = amp ? { kind: 'displace', amp, noise: nz, of: shape } : shape;
    const fy = floorY ?? Math.floor(ys[0]) + 1;
    if (!isInt(fy)) throw new Error(`part ${this.id}: cavern floorY must be an integer`);
    if (floor === 'flat') hollow = { kind: 'clipY', y0: { abs: fy }, y1: null, of: hollow };
    this._shapeOp({ kind: 'clipY', y0: null, y1: { height: 0 }, of: hollow }, null, COND.IF_NATURAL);
    const lightM = this._mat(light.block ?? 'minecraft:lantern', 'cavern light');
    if (lightM === null) throw new Error(`part ${this.id}: cavern light block must not be air`);
    // plan time: the floor cells (inside the hollow at floorY) and the light grid over them
    const node = compileShape(hollow, this.region.blobs);
    const s = this.region.survey;
    const floorCols = new Cols({ abs: 0 }, { abs: 0 });
    const lights = new Cols({ abs: 0 }, { abs: 0 });
    const x0 = Math.floor(node.minX), x1 = Math.ceil(node.maxX), z0 = Math.floor(node.minZ), z1 = Math.ceil(node.maxZ);
    let n = 0;
    const lit = [];
    const floorCells = [];
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const col = { g: s.heightAt(x, z), h: s.topAt(x, z), f: s.floorAt(x, z) };
      if (sdAt(node, x, fy, z, col) > 0 || fy > col.g) continue; // only under the ground: a hollow, not open air
      if (floor === 'flat') floorCols.add(x, z, fy - 1, fy - 1, this._mat(floorMaterial, 'cavern floor'));
      n++;
      floorCells.push([x, z]);
      if ((x - x0) % every === Math.floor(every / 2) % every && (z - z0) % every === Math.floor(every / 2) % every) { lights.add(x, z, fy, fy, lightM); lit.push([x, fy, z]); }
    }
    if (!n) throw new Error(`part ${this.id}: the cavern has no floor cell under the ground at floorY ${fy}`);
    // the guarantee: no floor cell more than every/2 (in x and z) from a light; fill the edges the grid leaves
    const h = Math.floor(every / 2);
    for (const [x, z] of floorCells) {
      if (lit.some(([lx, , lz]) => Math.abs(lx - x) <= h && Math.abs(lz - z) <= h)) continue;
      lights.add(x, z, fy, fy, lightM); lit.push([x, fy, z]);
    }
    if (floor === 'flat') this._colsOp(floorCols, COND.IF_NATURAL);
    this._colsOp(lights, COND.IF_NATURAL);
    const m = (this.region.meta.parts[this.id] ??= {});
    m.kind ??= 'carve';
    (m.caverns ??= []).push({ floorY: fy, lights: lit.length, every, bounds: { minX: x0, maxX: x1, minZ: z0, maxZ: z1, minY: fy, maxY: Math.ceil(ys[1]) } });
    return { floorY: fy, lights: lit };
  }

  // ---------------------------------------------------------------- utility (6b)

  /** A reserved corridor along a polyline [[x, y, z], ...]: no blocks; the checker keeps it clear of later ops. */
  utility(path, { width = 3, height = 3, kind = 'generic', id } = {}) {
    if (!Array.isArray(path) || path.length < 2) throw new Error(`part ${this.id}: utility path must be 2+ points [x, y, z]`);
    if (!(isInt(width) && width >= 1 && width <= 9 && isInt(height) && height >= 1 && height <= 16)) throw new Error(`part ${this.id}: utility width 1..9, height 1..16`);
    const points = path.map((p, i) => {
      if (!Array.isArray(p) || p.length !== 3) throw new Error(`part ${this.id}: utility point ${i} must be [x, y, z]`);
      return [round(p[0]), round(this.region.planY(p[1], p[0], p[2], `utility point ${i}`)), round(p[2])];
    });
    const u = { id: id ?? `${this.id}_utility_${this.region.utility.length + 1}`, stage: this.stage, part: this.id, kind: String(kind), width, height, points };
    this.region.utility.push(u);
    return u;
  }

  // ---------------------------------------------------------------- platform

  /**
   * A flat slab whose top is exactly `y` over `polygon` ([[x, z], ...]), `thickness` deep. `edge: 'rail'|'wall'` puts
   * the rail role (1 high) or the structure role (2 high) on its boundary cells. `underside: 'fill'` fills down to the
   * frozen floor; `clear: true` removes natural cells above it.
   */
  platform(polygon, y, { thickness = 1, edge = 'none', underside = 'none', material = 'structure', clear = false, edgeMaterial } = {}) {
    if (!Array.isArray(polygon) || polygon.length < 3) throw new Error(`part ${this.id}: platform polygon needs 3+ [x, z] points`);
    if (!isInt(y)) throw new Error(`part ${this.id}: platform y must be an integer`);
    if (!(isInt(thickness) && thickness >= 1 && thickness <= 16)) throw new Error(`part ${this.id}: platform thickness must be 1..16`);
    const mat = this._mat(material, 'platform material');
    if (underside === 'fill') this._shapeOp({ kind: 'extrude', polygon, y0: { floor: 1 }, y1: { abs: y - thickness } }, this._mat('foundation', 'foundation'), COND.IF_NATURAL);
    else if (underside !== 'none') throw new Error(`part ${this.id}: platform underside must be none or fill`);
    this._shapeOp({ kind: 'extrude', polygon, y0: { abs: y - thickness + 1 }, y1: { abs: y } }, mat, COND.IF_NATURAL);
    if (clear) this._shapeOp({ kind: 'extrude', polygon, y0: { abs: y + 1 }, y1: { height: 0 } }, null, COND.IF_NATURAL);
    if (edge !== 'none') {
      if (edge !== 'rail' && edge !== 'wall') throw new Error(`part ${this.id}: platform edge must be none, rail or wall`);
      const em = this._mat(edgeMaterial ?? (edge === 'rail' ? 'rail' : 'structure'), 'platform edge');
      const h = edge === 'rail' ? 1 : 2;
      const cols = new Cols({ abs: 0 }, { abs: 0 });
      for (const [x, z] of boundaryCells(polygon)) cols.add(x, z, y + 1, y + h, em);
      this._colsOp(cols, COND.IF_NATURAL);
    }
    return this;
  }

  // ---------------------------------------------------------------- pillar

  /**
   * A size x size column from `at[1]` down to the first solid cell under the frozen surface (`to: 'ground'`: the floor
   * under water), the claim's bottom (`'bedrock'`) or an absolute y. `bottom` (absolute) lets it reach lower than the
   * frozen floor (over the region's own carve).
   */
  pillar(at, { to = 'ground', size = 1, material = 'structure', bottom = null } = {}) {
    if (!Array.isArray(at) || at.length !== 3 || !at.every(isInt)) throw new Error(`part ${this.id}: pillar at must be [x, y, z] integers`);
    if (![1, 2, 3].includes(size)) throw new Error(`part ${this.id}: pillar size must be 1, 2 or 3`);
    const [x, y, z] = at;
    const x0 = x - Math.floor((size - 1) / 2), z0 = z - Math.floor((size - 1) / 2);
    let lo, cond = COND.IF_AIR_OR_FLUID;
    if (to === 'ground') lo = bottom === null ? { floor: 1 } : { min: [{ floor: 1 }, { abs: bottom }] };
    else if (to === 'bedrock') { lo = { abs: this.region.claim.minY }; cond = COND.IF_NATURAL; }
    else if (isInt(to)) lo = { abs: to };
    else throw new Error(`part ${this.id}: pillar to must be 'ground', 'bedrock' or an integer y`);
    this._shapeOp({ kind: 'box', min: [x0, lo, z0], max: [x0 + size - 1, { abs: y }, z0 + size - 1] }, this._mat(material, 'pillar material'), cond);
    return this;
  }

  // ---------------------------------------------------------------- ring

  /**
   * A closed wall between radii r0 and r1 around `c` ([x, z]), following the frozen surface: from the ground block
   * (its footing) up `height + rise` blocks. `gates: [{angle | dir, width: 3, height: 4}]` (angle: compass degrees,
   * 0 = north, clockwise): each opening has at least `width` x `height` clear over a flat threshold of walk-surface
   * cells (path role) at the plan survey's ground at the gate, filled below with foundation. (6b) `towers: {every: 48,
   * radius: 4, extra: 4}` (or true) puts cylinders on the wall line at most `every` apart, never over a gate; `crenels`
   * adds merlons on every other outer-rim cell of the wall and tower tops.
   */
  ring(c, r0, r1, { height = 8, rise = 0, gates = [], material = 'structure', threshold = 'path', towers, crenels, baseY = null } = {}) {
    if (!Array.isArray(c) || c.length !== 2 || !c.every(isNum)) throw new Error(`part ${this.id}: ring centre must be [x, z]`);
    if (!(isNum(r0) && isNum(r1) && r0 >= 0 && r1 > r0)) throw new Error(`part ${this.id}: ring needs 0 <= r0 < r1`);
    if (!(isInt(height) && height >= 1 && height <= 64)) throw new Error(`part ${this.id}: ring height must be 1..64`);
    if (!(isInt(rise) && rise >= 0 && rise <= 64)) throw new Error(`part ${this.id}: ring rise must be 0..64`);
    const mat = this._mat(material, 'ring material');
    // (6b) baseY: an absolute footing (a wall on a raised mass), else the frozen surface
    if (baseY !== null && !isInt(baseY)) throw new Error(`part ${this.id}: ring baseY must be an integer`);
    const B = baseY === null ? { surface: 0 } : { abs: baseY };
    this._shapeOp({ kind: 'ring', c: [c[0], B, c[1]], r0, r1, h: height + rise + 1 }, mat, COND.IF_NATURAL);
    const top = height + rise + 1; // the wall's top cell is ground + height + rise
    const rm = (r0 + r1) / 2;
    const gateAt = gates.map((g) => {
      const d = Array.isArray(g.dir) ? (() => { const l = Math.sqrt(g.dir[0] * g.dir[0] + g.dir[1] * g.dir[1]); return [g.dir[0] / l, g.dir[1] / l]; })() : compassDir(g.angle ?? 0);
      return { x: c[0] + d[0] * rm, z: c[1] + d[1] * rm, w: g.width ?? 3 };
    });
    // (6b) towers on the wall line, at most `every` apart, never over a gate
    const towerList = [];
    if (towers) {
      const t = towers === true ? {} : towers;
      const every = t.every ?? 48, tr = t.radius ?? 4, extra = t.extra ?? 4;
      if (!(isInt(every) && every >= 8 && isNum(tr) && tr >= 2 && tr <= 12 && isInt(extra) && extra >= 0 && extra <= 32)) throw new Error(`part ${this.id}: ring towers: every >= 8, radius 2..12, extra 0..32`);
      const n = Math.max(3, Math.ceil((2 * 3.141592653589793 * rm) / every));
      for (let i = 0; i < n; i++) {
        const d = compassDir((360 * i) / n + (t.start ?? 0));
        const tx = round(c[0] + d[0] * rm), tz = round(c[1] + d[1] * rm);
        if (gateAt.some((g) => Math.sqrt(sq(g.x - tx) + sq(g.z - tz)) < g.w / 2 + tr + 2)) continue;
        this._shapeOp({ kind: 'cylinder', c: [tx, B, tz], r: tr, h: top + extra }, mat, COND.IF_NATURAL);
        towerList.push([round(tx), round(tz), tr]);
      }
    }
    // (6b) crenels: merlons on every other outer-rim cell of the wall top (checkerboard), plus the towers' rims
    if (crenels) {
      const cols = new Cols(B, B);
      const R1 = Math.ceil(r1) + 1;
      for (let z = Math.floor(c[1] - R1); z <= Math.ceil(c[1] + R1); z++) for (let x = Math.floor(c[0] - R1); x <= Math.ceil(c[0] + R1); x++) {
        const d = Math.sqrt(sq(x - c[0]) + sq(z - c[1]));
        if (d >= r1 - 1 && d <= r1 && ((x + z) & 1) === 0 && !gateAt.some((g) => Math.sqrt(sq(g.x - x) + sq(g.z - z)) < g.w / 2 + 1.5)) cols.add(x, z, top, top, mat);
      }
      for (const [tx, tz, tr] of towerList) {
        for (let z = Math.floor(tz - tr); z <= Math.ceil(tz + tr); z++) for (let x = Math.floor(tx - tr); x <= Math.ceil(tx + tr); x++) {
          const d = Math.sqrt(sq(x - tx) + sq(z - tz));
          const textra = (towers === true ? 4 : towers.extra ?? 4);
          if (d >= tr - 1 && d <= tr && ((x + z) & 1) === 0) cols.add(x, z, top + textra, top + textra, mat);
        }
      }
      this._colsOp(cols, COND.IF_NATURAL);
    }
    const out = [];
    gates.forEach((g, gi) => {
      const w = g.width ?? 3, h = g.height ?? 4;
      if (!(isInt(w) && w >= 1 && w <= 16 && isInt(h) && h >= 2 && h <= 32)) throw new Error(`part ${this.id}: gate ${gi} width must be 1..16 and height 2..32`);
      let d;
      if (Array.isArray(g.dir)) {
        const l = Math.sqrt(g.dir[0] * g.dir[0] + g.dir[1] * g.dir[1]);
        if (!(l > 0)) throw new Error(`part ${this.id}: gate ${gi} dir must be a non-zero [dx, dz]`);
        d = [g.dir[0] / l, g.dir[1] / l];
      } else d = compassDir(g.angle ?? 0);
      const p = rightOf(d);
      const rm = (r0 + r1) / 2;
      const gx = c[0] + d[0] * rm, gz = c[1] + d[1] * rm;
      const ty = baseY === null ? this.region.survey.heightAt(round(gx), round(gz)) : baseY;
      const v0 = -Math.floor((w - 1) / 2) - 0.25, v1 = Math.floor(w / 2) + 0.25;
      const u0 = r0 - 2, u1 = r1 + 2;
      const poly = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => [c[0] + d[0] * u + p[0] * v, c[1] + d[1] * u + p[1] * v]);
      if (baseY === null) this._shapeOp({ kind: 'extrude', polygon: poly, y0: { floor: 1 }, y1: { abs: ty - 1 } }, this._mat('foundation', 'foundation'), COND.IF_NATURAL);
      this._shapeOp({ kind: 'extrude', polygon: poly, y0: { abs: ty }, y1: { abs: ty } }, this._mat(threshold, 'gate threshold'), baseY === null ? COND.IF_NATURAL : COND.ALWAYS_OURS, true);
      this._shapeOp({ kind: 'extrude', polygon: poly, y0: { abs: ty + 1 }, y1: { abs: ty + h } }, null, COND.IF_NATURAL);
      out.push({ at: [round(gx), ty, round(gz)], dir: d, width: w, height: h, polygon: poly });
    });
    return out;
  }

  // ---------------------------------------------------------------- terrace

  /**
   * Flat levels. `area`: `{center: [x, z], radius}` or `{polygon: [[x, z], ...], center?}`, with optional `fractions`
   * (descending from 1; default 1 - k/n): level k covers the area scaled by fractions[k] about the centre. `levels`: an
   * array of y (lowest first) or a count (then y0 = the median plan ground over the area and each level `step` higher).
   * Each level is flat: cut above its y (to the column top), filled below (`fill` role, from the frozen floor), its top
   * block the `surface` role over `soil` blocks of `fill` (never into the claim's bottom 2 rows). `edge: 'slope'` keeps every riser <= `riser`; `edge: 'wall'`
   * builds a retaining wall of `retain` on each level's rim. `stairs`: one stair of `stairWidth` joins each pair of levels.
   * (6c S3) `edge: 'blend'` (a program that declares the `relief` pass only): no batters; each level's footprint joins T1's relief
   * as a pin (the levels' `pins`, `{rect, y, terrace}` row runs, go in `r.pass('relief', {around})`, as a lot pad does) and the relief
   * blends the land into it; after the relief, the rim is retained by `retain` where the level stands more than 2 over the land
   * outside it (the relief's surface, else the survey's ground: a relief clamped by its maxFill leaves such a step). A blend terrace
   * no relief pass pinned fails the plan (as a blend pad does). Returns the levels `[{y, radius|polygon, pins?}]`.
   */
  terrace(area, levels, { riser = 2, step, retain = 'structure', edge = 'slope', stairs = true, stairWidth = 3, surface = 'surface', fill = 'subsurface', soil = 3, stairMaterial = 'structure', startAngle = 45 } = {}) {
    if (!area || typeof area !== 'object') throw new Error(`part ${this.id}: terrace area must be {center, radius} or {polygon}`);
    if (edge !== 'slope' && edge !== 'wall' && edge !== 'blend') throw new Error(`part ${this.id}: terrace edge must be slope, wall or blend`);
    if (edge === 'blend' && !(this.region.ctx.passes ?? []).includes('relief')) throw new Error(`part ${this.id}: terrace edge blend needs the relief pass (export const passes = ['relief'])`);
    const circle = Array.isArray(area.center) && isNum(area.radius);
    if (!circle && !(Array.isArray(area.polygon) && area.polygon.length >= 3)) throw new Error(`part ${this.id}: terrace area must be {center, radius} or {polygon}`);
    const center = area.center ?? centroid(area.polygon);
    const n = Array.isArray(levels) ? levels.length : levels;
    if (!(isInt(n) && n >= 1 && n <= 32)) throw new Error(`part ${this.id}: terrace needs 1..32 levels`);
    const fr = area.fractions ?? Array.from({ length: n }, (_, k) => 1 - k / n);
    if (fr.length !== n || fr.some((f, k) => !(f > 0 && f <= 1 && (k === 0 || f < fr[k - 1])))) throw new Error(`part ${this.id}: terrace fractions must be ${n} descending values in (0, 1]`);
    const stepH = step ?? (edge === 'wall' ? 4 : edge === 'blend' ? 3 : riser);
    let ys;
    if (Array.isArray(levels)) {
      ys = levels;
      if (!ys.every(isInt)) throw new Error(`part ${this.id}: terrace levels must be integers`);
    } else {
      const R = circle ? area.radius : Math.max(...area.polygon.map((p) => Math.abs(p[0] - center[0]) + Math.abs(p[1] - center[1])));
      const st = this.region.survey.stats(round(center[0] - R), round(center[1] - R), round(center[0] + R), round(center[1] + R));
      ys = Array.from({ length: n }, (_, k) => st.median + k * stepH);
    }
    if (edge === 'slope') {
      for (let k = 1; k < n; k++) if (Math.abs(ys[k] - ys[k - 1]) > riser) throw new Error(`part ${this.id}: terrace riser ${k} is ${Math.abs(ys[k] - ys[k - 1])} (> riser ${riser}; use edge: 'wall')`);
    }
    const levelShape = (k, y0, y1) => (circle
      ? { kind: 'cylinder', c: [center[0], y0, center[1]], r: area.radius * fr[k], h: 1, __y1: y1 }
      : { kind: 'extrude', polygon: scalePoly(area.polygon, center, fr[k]), y0, y1 });
    // a column-range version of a level's footprint: extrude for polygons, a clipped cylinder for circles
    const footprint = (k, y0, y1) => {
      if (!circle) return levelShape(k, y0, y1);
      return { kind: 'intersect', of: [{ kind: 'cylinder', c: [center[0], { abs: -4096 }, center[1]], r: area.radius * fr[k], h: 8192 }, { kind: 'clipY', y0, y1, of: { kind: 'box', min: [round(center[0] - area.radius - 2), { abs: -4096 }, round(center[1] - area.radius - 2)], max: [round(center[0] + area.radius + 2), { abs: 4096 }, round(center[1] + area.radius + 2)] } }] };
    };
    const surf = this._mat(surface, 'terrace surface'), fillM = this._mat(fill, 'terrace fill'), ret = this._mat(retain, 'terrace retain');
    const out = [];
    for (let k = 0; k < n; k++) {
      const y = ys[k];
      // (6c RS) the level's cut and fill are a terrain kind's write; its retaining wall and stairs are built (paid)
      this.region.terrain(() => {
        this._shapeOp(footprint(k, { abs: y + 1 }, { height: 0 }), null, COND.IF_NATURAL);
        this._shapeOp(footprint(k, { min: [{ floor: 1 }, { abs: Math.max(y - soil, this.region.claim.minY + 2) }] }, { abs: y - 1 }), fillM, COND.IF_NATURAL);
        this._shapeOp(footprint(k, { abs: y }, { abs: y }), surf, COND.IF_NATURAL);
      });
      if (edge === 'wall') {
        const lo = k === 0 ? { floor: 1 } : { abs: ys[k - 1] + 1 };
        const wall = circle
          ? { kind: 'ring', c: [center[0], { abs: -4096 }, center[1]], r0: area.radius * fr[k] - 1, r1: area.radius * fr[k], h: 8192 }
          : { kind: 'subtract', of: [{ kind: 'extrude', polygon: scalePoly(area.polygon, center, fr[k]), y0: { abs: -4096 }, y1: { abs: 4096 } }, { kind: 'offset', d: -1, of: { kind: 'extrude', polygon: scalePoly(area.polygon, center, fr[k]), y0: { abs: -4200 }, y1: { abs: 4200 } } }] };
        this._shapeOp({ kind: 'clipY', y0: lo, y1: { abs: y }, of: wall }, ret, COND.IF_NATURAL);
      }
      out.push(circle ? { y, radius: area.radius * fr[k] } : { y, polygon: scalePoly(area.polygon, center, fr[k]) });
    }
    if (edge === 'blend') {
      // (6c S3) the levels' footprint cells by the evaluator's own rule (sd <= 0 at the cell), each cell in its highest level; the
      // pins are their row runs at the level's y (the relief fixes them), the rim retained after the relief (Region.pass)
      const inLevel = (k, x, z) => (circle ? Math.sqrt((x - center[0]) * (x - center[0]) + (z - center[1]) * (z - center[1])) - area.radius * fr[k] <= 0 : polygonDistance(out[k].polygon, x, z) <= 0);
      const R0 = circle ? area.radius : Math.max(...area.polygon.map((p) => Math.max(Math.abs(p[0] - center[0]), Math.abs(p[1] - center[1]))));
      const x0 = Math.floor(center[0] - R0) - 1, x1 = Math.ceil(center[0] + R0) + 1, z0 = Math.floor(center[1] - R0) - 1, z1 = Math.ceil(center[1] + R0) + 1;
      const levelOf = new Map(); // "x,z" -> k
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) for (let k = n - 1; k >= 0; k--) if (inLevel(k, x, z)) { levelOf.set(`${x},${z}`, k); break; }
      for (let k = 0; k < n; k++) {
        const pins = [];
        for (let z = z0; z <= z1; z++) {
          let run = null;
          for (let x = x0; x <= x1 + 1; x++) {
            const on = x <= x1 && levelOf.get(`${x},${z}`) === k;
            if (on && !run) run = [x, x];
            else if (on) run[1] = x;
            else if (run) { pins.push({ rect: [run[0], z, run[1], z], y: out[k].y, terrace: this.id }); run = null; }
          }
        }
        out[k].pins = pins;
      }
      this.region.blendTerraces.push({ id: this.id, stage: this.stage, levels: out.map((l) => l.y), cells: levelOf, retain: ret });
      (this.region.meta.parts[this.id] ??= {}).terrace = { edge: 'blend', levels: out.map((l) => l.y), retained: null };
    }
    if (stairs && n > 1) {
      for (let k = 0; k + 1 < n; k++) {
        const d = compassDir(startAngle + 135 * k);
        const rOuter = circle ? area.radius * fr[k + 1] : rayToEdge(scalePoly(area.polygon, center, fr[k + 1]), center, d);
        const rise = Math.abs(ys[k + 1] - ys[k]);
        const len = rise + 2 * Math.floor(Math.max(0, rise - 1) / 8) + 1;
        const p0 = [center[0] + d[0] * (rOuter + 1), center[1] + d[1] * (rOuter + 1)];
        const p1 = [center[0] + d[0] * (rOuter - len), center[1] + d[1] * (rOuter - len)];
        this._stair([[p0[0], ys[k], p0[1]], [p1[0], ys[k + 1], p1[1]]], { width: stairWidth, material: stairMaterial, kind: 'terrace stair' });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- stair

  /**
   * A stair along a polyline [[x, y, z], ...] (y absolute or {surface: dy}): treads rise at most 1 per step, with a
   * 2-cell landing at least every `landingEvery` steps, `width` wide, 2 cells of headroom carved above (natural cells
   * only), treads marked walk-surface; rising treads are stairs blocks of the material when it has them. `spiral: true`
   * takes `{center: [x, z], radius, top, bottom, start: angle}` instead of a polyline and winds down from `top` to
   * `bottom` around a 3x3 core. `railing`: a role for posts on both sides.
   */
  stair(path, { width = 3, rise = 1, landingEvery = 8, carve = true, railing = null, spiral = false, material = 'structure', id, lights, _unsafeRise, solid = false, railSkip = null } = {}) {
    this._requirePath('stair');
    if (rise !== 1) throw new Error(`part ${this.id}: stair rise must be 1`);
    const r = this._stair(path, { width, landingEvery, carve, railing, spiral, material, kind: 'stair', lights, _unsafeRise, solid, railSkip });
    const sid = id ?? `${this.id}_stair_${this.region.paths.length + 1}`;
    this.region.paths.push({ id: sid, stage: this.stage, part: this.id, kind: 'stair', box: r.box });
    this.region.meta.paths[sid] = { kind: 'stair', part: this.id, stage: this.stage, width, landingEvery, cells: r.cells };
    (this.region.meta.parts[this.id] ??= {}).kind ??= 'path';
    return { ...r, id: sid };
  }

  _stair(path, { width = 3, landingEvery = 8, carve = true, railing = null, spiral = false, material = 'structure', kind = 'stair', lights, _unsafeRise, solid = false, railSkip = null }) {
    const what = `part ${this.id}: ${kind}`;
    if (!(isInt(width) && width >= 1 && width <= 9)) throw new Error(`${what}: width must be 1..9`);
    if (!(isInt(landingEvery) && landingEvery >= 2 && landingEvery <= 64)) throw new Error(`${what}: landingEvery must be 2..64`);
    const full = this._mat(material, `${kind} material`);
    if (full === null) throw new Error(`${what}: material must not be air`);
    let cells, ys;
    let core = null;
    if (spiral) {
      const s = path;
      if (!s || !Array.isArray(s.center) || !isNum(s.radius) || !isInt(s.top) || !isInt(s.bottom)) throw new Error(`${what}: a spiral takes {center: [x, z], radius, top, bottom, start}`);
      if (s.radius < 3 || s.radius > 32) throw new Error(`${what}: spiral radius must be 3..32`);
      if (s.top <= s.bottom) throw new Error(`${what}: spiral top must be above bottom`);
      const poly = circlePolygon(s.center[0], s.center[1], s.radius, 32, s.start ?? 0);
      const per = 32;
      const drop = s.top - s.bottom;
      const turns = Math.ceil((drop * 1.5) / (s.radius * 4)) + 2;
      const pts = [];
      for (let t = 0; t < turns; t++) for (let i = 0; i < per; i++) pts.push(poly[i]);
      pts.push(poly[0]);
      const pc = pathCells(pts);
      // descend greedily until the bottom, then stop
      const y = [s.top];
      let cur = s.top, flight = 0, flat = 0, n = 1;
      for (let i = 1; i < pc.cells.length && cur > s.bottom; i++, n++) {
        if (flight < landingEvery) { cur--; flight++; flat = 0; } else { flat++; if (flat >= 2) flight = 0; }
        y.push(cur);
      }
      if (cur !== s.bottom) throw new Error(`${what}: the spiral is too short (internal)`);
      cells = pc.cells.slice(0, n);
      ys = y;
      // headroom between turns: a column's treads must be 3+ apart
      const byCol = new Map();
      cells.forEach((c, i) => { const k = `${c.x},${c.z}`; const l = byCol.get(k) ?? []; l.push(ys[i]); byCol.set(k, l); });
      for (const [k, l] of byCol) {
        l.sort((a, b) => a - b);
        for (let i = 1; i < l.length; i++) if (l[i] !== l[i - 1] && l[i] - l[i - 1] < 3) throw new Error(`${what}: spiral turns at ${k} are only ${l[i] - l[i - 1]} apart (make the radius larger)`);
      }
      core = { c: s.center, top: s.top, bottom: s.bottom, r: s.core ?? null };
      if (core.r !== null && !(isNum(core.r) && core.r >= 1 && core.r <= s.radius - 1.5)) throw new Error(`${what}: spiral core must be 1..radius - 1.5`);
    } else {
      if (!Array.isArray(path) || path.length < 2) throw new Error(`${what}: path must be 2+ points [x, y, z]`);
      const pts3 = path.map((p, i) => {
        if (!Array.isArray(p) || p.length !== 3 || !isNum(p[0]) || !isNum(p[2])) throw new Error(`${what}: point ${i} must be [x, y, z]`);
        return [p[0], round(this.region.planY(p[1], p[0], p[2], `${what} point ${i}`)), p[2]];
      });
      const pc = pathCells(pts3.map((p) => [p[0], p[2]]));
      cells = pc.cells;
      // (_unsafeRise: the M7 broken fixture only) a profile that rises 2 per step
      ys = _unsafeRise ? cells.map((_, i) => pts3[0][1] + 2 * i) : stairProfile(cells.length, pc.vertexAt.map((ci, k) => [ci, pts3[k][1]]), landingEvery, what);
    }
    const offs = crossOffsets(width);
    const treads = new Cols({ abs: 0 }, { abs: 0 });
    const head = new Cols({ abs: 0 }, { abs: 0 });
    const rails = new Cols({ abs: 0 }, { abs: 0 });
    const railM = railing === null ? null : this._mat(railing, `${kind} railing`);
    // the stairs block goes on the higher cell of each 1-step, facing the way up
    const stairFacing = new Array(cells.length).fill(null);
    for (let i = 0; i + 1 < cells.length; i++) {
      const dy = ys[i + 1] - ys[i];
      if (dy === 0) continue;
      const [hi, lo] = dy > 0 ? [i + 1, i] : [i, i + 1];
      if (stairFacing[hi] === null) stairFacing[hi] = cardinalOf(cells[hi].x - cells[lo].x, cells[hi].z - cells[lo].z);
    }
    let box = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
    const grow = (x, y, z) => { box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x); box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y); box.minZ = Math.min(box.minZ, z); box.maxZ = Math.max(box.maxZ, z); };
    // treads: centre cells first, then the cross-sections; a column keeps one tread per 3 blocks of height, so the
    // inside of a turn never puts a tread in another tread's headroom
    const colTreads = new Map();
    // (6b) solid: a block under every tread, so each step bears on the one below it (face contact down the flight: M3)
    const supportsC = new Cols({ abs: 0 }, { abs: 0 });
    const tread = (x, y, z, m) => {
      const k = `${x},${z}`;
      const l = colTreads.get(k) ?? [];
      if (l.some((v) => Math.abs(v - y) < (solid ? 4 : 3))) return;
      l.push(y);
      colTreads.set(k, l);
      treads.add(x, z, y, y, m);
      if (solid) supportsC.add(x, z, y - 1, y - 1, full);
      if (carve) head.add(x, z, y + 1, y + 2, null);
      grow(x, y, z); grow(x, y + 2, z);
    };
    const matAt = (i) => (stairFacing[i] ? stairsOf(full, stairFacing[i]) ?? full : full);
    cells.forEach((c, i) => tread(c.x, ys[i], c.z, matAt(i)));
    cells.forEach((c, i) => {
      const y = ys[i];
      for (const k of offs) if (k !== 0) tread(c.x + c.r[0] * k, y, c.z + c.r[1] * k, matAt(i));
      if (railM !== null && !solid) {
        for (const k of [offs[0] - 1, offs[offs.length - 1] + 1]) {
          const x = c.x + c.r[0] * k, z = c.z + c.r[1] * k;
          if (railSkip && railSkip(x, z)) continue; // ((6c S3) never on another route's walk)
          rails.addOnce(`${x},${y},${z}`, x, z, y, y, full);
          rails.addOnce(`${x},${y + 1},${z}`, x, z, y + 1, y + 1, railM);
          grow(x, y + 1, z);
        }
      }
    });
    // (6b) solid stairs: a rail on every side of the flight that has no tread beside it (corners and landings included)
    if (railM !== null && solid) {
      const treadAt = (x, z, y) => (colTreads.get(`${x},${z}`) ?? []).some((v) => Math.abs(v - y) <= 1);
      // the flight's two ends stay open (where it meets the ground, a landing or a deck)
      const open = new Set();
      const ends = cells.length > 1 ? [[cells[0], cells[1]], [cells[cells.length - 1], cells[cells.length - 2]]] : [];
      for (const [e, nb] of ends) {
        const dx = e.x - nb.x, dz = e.z - nb.z;
        for (let s = 1; s <= 2; s++) for (const k of [...offs, offs[0] - 1, offs[offs.length - 1] + 1]) open.add(`${e.x + dx * s + e.r[0] * k},${e.z + dz * s + e.r[1] * k}`);
      }
      for (const [k, l] of colTreads) {
        const [x, z] = k.split(',').map(Number);
        for (const y of l) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const nx = x + dx, nz = z + dz;
          if (treadAt(nx, nz, y) || open.has(`${nx},${nz}`)) continue;
          rails.addOnce(`${nx},${y},${nz}`, nx, nz, y, y, full);
          rails.addOnce(`${nx},${y + 1},${nz}`, nx, nz, y + 1, y + 1, railM);
          grow(nx, y + 1, nz);
        }
      }
    }
    this._colsOp(rails, COND.IF_NATURAL);
    this._colsOp(head, COND.IF_NATURAL);
    if (core && core.r !== null) {
      // (6b) a round core the treads bear on (face contact: no tread hangs in the air)
      this._shapeOp({ kind: 'extrude', polygon: circlePolygon(core.c[0], core.c[1], core.r, 24), y0: { min: [{ floor: 1 }, { abs: core.bottom }] }, y1: { abs: core.top } }, full, COND.IF_NATURAL);
      const [cx, cz] = core.c.map(round), cr = Math.ceil(core.r);
      grow(cx - cr, core.bottom, cz - cr); grow(cx + cr, core.top, cz + cr);
    } else if (core) {
      const [cx, cz] = core.c.map(round);
      this._shapeOp({ kind: 'box', min: [cx - 1, { min: [{ floor: 1 }, { abs: core.bottom }] }, cz - 1], max: [cx + 1, { abs: core.top }, cz + 1] }, full, COND.IF_NATURAL);
      grow(cx - 1, core.bottom, cz - 1); grow(cx + 1, core.top, cz + 1);
    }
    if (solid) this._colsOp(supportsC, COND.IF_NATURAL);
    this._colsOp(treads, COND.IF_NATURAL, true);
    // (6b) lights: a lantern on a rail post (or the tread's outer edge) every `lights` cells
    if (lights) {
      const lm = this._mat('minecraft:lantern', `${kind} light`);
      const lc = new Cols({ abs: 0 }, { abs: 0 });
      for (let i = 0; i < cells.length; i += lights) {
        // on the rail post (above the rail), else in the side wall beside the tread (never in the walk's head room)
        const c = cells[i], k = offs[offs.length - 1] + 1;
        const x = c.x + c.r[0] * k, z = c.z + c.r[1] * k;
        if ((colTreads.get(`${x},${z}`) ?? []).some((v) => Math.abs(v - ys[i]) <= 3)) continue;
        lc.add(x, z, ys[i] + (railM !== null ? 2 : 1), ys[i] + (railM !== null ? 2 : 1), lm);
      }
      this._colsOp(lc, COND.IF_NATURAL);
    }
    return { cells: cells.map((c, i) => [c.x, ys[i], c.z]), box, width };
  }

  // ---------------------------------------------------------------- spiral tower (6b)

  /**
   * A square spiral stair around a solid core: flights of `width` 3 run down the four sides of a square ring of half-size
   * `half` (the flight's centre line), from `top` to `bottom` (tread y), with a flat 3-cell landing at every corner. The core
   * (half - 2) is solid from the frozen floor to `top`, so every tread bears on it or on its neighbour (M3); a rail runs round
   * the outside except at the bottom exit and the top; `lights` puts a lantern on the rail every n cells. `start`: the
   * corner the top is at, 0..3 (NW, NE, SE, SW), running clockwise. `openTop: false` rails the top landing too (a deck
   * arriving there clears its own way through the rail). `ground(x, z)`: the plan's ground; the flight stops where it
   * meets it (an exit flush with the land), `bottom` being the lowest it may go.
   */
  spiralTower({ center, half = 6, top, bottom, start = 0, material = 'structure', railing = 'rail', lights = 8, openTop = true, ground = null, id } = {}) {
    this._requirePath('spiral tower');
    const what = `part ${this.id}: spiral tower`;
    if (!Array.isArray(center) || !center.every(isInt) || !isInt(half) || half < 4 || half > 16 || !isInt(top) || !isInt(bottom) || top <= bottom) throw new Error(`${what}: needs center [x, z], half 4..16, top > bottom`);
    const full = this._mat(material, 'spiral tower material');
    const railM = railing === null ? null : this._mat(railing, 'spiral tower rail');
    const [cx, cz] = center;
    // the centre line: corners NW, NE, SE, SW clockwise; each side runs from one corner to the next
    const C = [[-half, -half], [half, -half], [half, half], [-half, half]];
    const cells = []; // {x, z, y, out: [dx, dz] (outward unit along the cross-section), corner}
    let y = top, k = start % 4, flat = 0;
    const push = (x, z, out, corner) => cells.push({ x, z, y, out, corner });
    while (true) {
      const [ax, az] = C[k % 4], [bx, bz] = C[(k + 1) % 4];
      const sx = Math.sign(bx - ax), sz = Math.sign(bz - az);
      const out = [sz, -sx]; // clockwise: the outward normal of a side (screen: x east, z south)
      // the corner landing (3 cells: the corner and one either side)
      let done = false;
      for (let i = 0; i < 2 * half; i++) {
        const x = cx + ax + sx * i, z = cz + az + sz * i;
        // flat at the corner and one cell either side of it (a 3-cell landing), else one down per cell
        if (i >= 2 && i <= 2 * half - 2 && y > bottom) y--;
        push(x, z, out, i === 0);
        // (ground: stop where the flight meets the local ground, so the exit is flush with it)
        if (i >= 2 && (y === bottom || (ground && y <= ground(x, z)))) { done = true; break; }
      }
      if (done || y <= bottom) break;
      k++;
    }
    const treads = new Cols({ abs: 0 }, { abs: 0 }), head = new Cols({ abs: 0 }, { abs: 0 }), rails = new Cols({ abs: 0 }, { abs: 0 });
    const box = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
    const grow = (x, yy, z) => { box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x); box.minY = Math.min(box.minY, yy); box.maxY = Math.max(box.maxY, yy); box.minZ = Math.min(box.minZ, z); box.maxZ = Math.max(box.maxZ, z); };
    const seen = new Set();
    cells.forEach((c, i) => {
      const next = cells[i + 1];
      // a stairs block on the higher cell of each step, facing up the flight (towards the previous cell)
      const up = next && next.y < c.y ? cardinalOf(Math.sign(c.x - next.x), Math.sign(c.z - next.z)) : null;
      const m = up ? stairsOf(full, up) ?? full : full;
      for (const k of [-1, 0, 1]) {
        const x = c.x + c.out[0] * k, z = c.z + c.out[1] * k;
        const key = `${x},${c.y},${z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        treads.add(x, z, c.y, c.y, m);
        head.add(x, z, c.y + 1, c.y + 2, null);
        grow(x, c.y, z); grow(x, c.y + 2, z);
      }
    });
    // corner squares: fill the 3x3 corner block at the corner's y
    cells.forEach((c) => {
      if (!c.corner) return;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const x = c.x + dx, z = c.z + dz, key = `${x},${c.y},${z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        treads.add(x, z, c.y, c.y, full);
        head.add(x, z, c.y + 1, c.y + 2, null);
      }
    });
    // the outside rail: every cell at Chebyshev distance half + 2 beside a tread (corners included), but not at the exits
    if (railM !== null) {
      const tread = new Map();
      for (const key of seen) { const [x, yy, z] = key.split(',').map(Number); const k = `${x},${z}`; const l = tread.get(k) ?? []; l.push(yy); tread.set(k, l); }
      const nBottom = cells.length - 1;
      const open = new Set(); // the treads of the top 3 and the bottom 2 centre cells (and their corner blocks) stay unrailed
      cells.forEach((c, i) => { if ((openTop && i < 3) || i >= Math.max(0, nBottom - 1)) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) open.add(`${c.x + dx},${c.y},${c.z + dz}`); });
      const lit = [];
      for (const key of [...seen].sort()) {
        if (open.has(key)) continue;
        const [x, yy, z] = key.split(',').map(Number);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          const nx = x + dx, nz = z + dz;
          const ch = Math.max(Math.abs(nx - cx), Math.abs(nz - cz));
          // the outside ring, or a track cell with no tread near this height (the open well beside the top turn)
          if (ch !== half + 2 && (ch < half - 1 || ch > half + 1)) continue;
          if ((tread.get(`${nx},${nz}`) ?? []).some((v) => Math.abs(v - yy) <= 2)) continue;
          if (!rails.seen?.has(`${nx},${yy},${nz}`)) {
            rails.addOnce(`${nx},${yy},${nz}`, nx, nz, yy, yy, full);
            rails.addOnce(`${nx},${yy + 1},${nz}`, nx, nz, yy + 1, yy + 1, railM);
            if (lights && !lit.some(([a, b, c]) => Math.abs(a - nx) + Math.abs(b - yy) + Math.abs(c - nz) < lights)) {
              lit.push([nx, yy, nz]);
              rails.addOnce(`${nx},${yy + 2},${nz}`, nx, nz, yy + 2, yy + 2, this._mat('minecraft:lantern', 'light'));
            }
            grow(nx, yy + 2, nz);
          }
        }
      }
    }
    // the core, with a rail round its top (a walker who steps onto it must not fall into the stair well)
    this._shapeOp({ kind: 'box', min: [cx - half + 2, { min: [{ floor: 1 }, { abs: bottom }] }, cz - half + 2], max: [cx + half - 2, { abs: top }, cz + half - 2] }, full, COND.IF_NATURAL);
    if (railM !== null) {
      const k = half - 2;
      for (let d = -k; d <= k; d++) for (const [x, z] of [[cx + d, cz - k], [cx + d, cz + k], [cx - k, cz + d], [cx + k, cz + d]]) rails.addOnce(`${x},${top + 1},${z}`, x, z, top + 1, top + 1, railM);
    }
    this._colsOp(head, COND.IF_NATURAL);
    this._colsOp(rails, COND.IF_NATURAL);
    this._colsOp(treads, COND.IF_NATURAL, true);
    const sid = id ?? `${this.id}_tower_${this.region.paths.length + 1}`;
    this.region.paths.push({ id: sid, stage: this.stage, part: this.id, kind: 'stair', box });
    const centre = cells.map((c) => [c.x, c.y, c.z]);
    this.region.meta.paths[sid] = { kind: 'stair', part: this.id, stage: this.stage, width: 3, landingEvery: 2 * half, cells: centre };
    (this.region.meta.parts[this.id] ??= {}).kind ??= 'path';
    return { cells: centre, top: cells[0], bottom: cells[cells.length - 1], box, id: sid };
  }

  // ---------------------------------------------------------------- bridge

  /**
   * A bridge deck along a polyline [[x, y, z], ...] (y absolute or {surface: dy}), y interpolated per cell (at most 1
   * per block: a steeper segment fails), `width` walk-surface cells wide with rail posts on both sides, 2 cells of
   * headroom carved, and pillar supports (the deck's full cross-section, down to the frozen floor; `supports.bottom(x, z)`
   * may return an absolute y to reach lower, e.g. a carved bowl's floor) at the ends and at most `every` apart.
   * `every` must be <= `maxSpan`. Arches and towers are phase 6b.
   */
  bridge(path, { width = 3, deck = 'structure', rail = true, railMaterial = 'rail', supports = {}, maxSpan = 24, towers = false, id, lights, over = 'air', _unsafe = false } = {}) {
    this._requirePath('bridge');
    const what = `part ${this.id}: bridge`;
    const style = supports.style ?? 'pillar';
    if (!['pillar', 'arch', 'ends'].includes(style)) throw new Error(`${what}: supports.style must be pillar, arch or ends`);
    const every = supports.every ?? 12;
    if (!(isInt(width) && width >= 1 && width <= 9)) throw new Error(`${what}: width must be 1..9`);
    if (!(isInt(every) && every >= 1)) throw new Error(`${what}: supports.every must be a positive integer`);
    if (!(isInt(maxSpan) && maxSpan >= 1)) throw new Error(`${what}: maxSpan must be a positive integer`);
    if (every > maxSpan && !_unsafe) throw new Error(`${what}: supports every ${every} leave spans over maxSpan ${maxSpan}`);
    if (!Array.isArray(path) || path.length < 2) throw new Error(`${what}: path must be 2+ points [x, y, z]`);
    const pts3 = path.map((p, i) => {
      if (!Array.isArray(p) || p.length !== 3 || !isNum(p[0]) || !isNum(p[2])) throw new Error(`${what}: point ${i} must be [x, y, z]`);
      return [p[0], round(this.region.planY(p[1], p[0], p[2], `${what} point ${i}`)), p[2]];
    });
    const { cells, vertexAt } = pathCells(pts3.map((p) => [p[0], p[2]]));
    if (style === 'ends' && cells.length - 1 > maxSpan && !_unsafe) throw new Error(`${what}: an 'ends' bridge spans its whole length (${cells.length - 1}), more than maxSpan ${maxSpan}`);
    const ys = new Array(cells.length);
    for (let s = 0; s + 1 < pts3.length; s++) {
      const a = vertexAt[s], b = vertexAt[s + 1], n = b - a, dy = pts3[s + 1][1] - pts3[s][1];
      if (Math.abs(dy) > n) throw new Error(`${what}: segment ${s} rises ${Math.abs(dy)} over ${n} cells (at most 1 per block)`);
      for (let i = a; i <= b; i++) ys[i] = pts3[s][1] + (n ? round((dy * (i - a)) / n) : 0);
    }
    const deckM = this._mat(deck, 'bridge deck');
    if (deckM === null) throw new Error(`${what}: deck must not be air`);
    const railM = this._mat(railMaterial, 'bridge rail');
    const offs = crossOffsets(width);
    const outer = rail ? [offs[0] - 1, offs[offs.length - 1] + 1] : [];
    // (6b) a link over the region's own forms clears 6 above the deck: where it cuts a rim up to 3 deep, the rim's grass, its
    // rail and the lantern on the rail go too (4 left a rail lantern floating over the cut on S1's pinned site)
    const headTop = over === 'ours' ? 6 : 2;
    const walkCells = new Cols({ abs: 0 }, { abs: 0 });
    const edgeCells = new Cols({ abs: 0 }, { abs: 0 });
    const head = new Cols({ abs: 0 }, { abs: 0 });
    const box = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
    const grow = (x, y, z) => { box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x); box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y); box.minZ = Math.min(box.minZ, z); box.maxZ = Math.max(box.maxZ, z); };
    const s = this.region.survey;
    cells.forEach((c, i) => {
      walkCells.addOnce(`${c.x},${c.z}`, c.x, c.z, ys[i], ys[i], deckM);
      head.addOnce(`${c.x},${c.z}`, c.x, c.z, ys[i] + 1, ys[i] + headTop, null);
    });
    cells.forEach((c, i) => {
      const y = ys[i];
      for (const k of offs) {
        const x = c.x + c.r[0] * k, z = c.z + c.r[1] * k;
        walkCells.addOnce(`${x},${z}`, x, z, y, y, deckM);
        head.addOnce(`${x},${z}`, x, z, y + 1, y + headTop, null);
        grow(x, y, z); grow(x, y + 2, z);
      }
      for (const k of outer) {
        const x = c.x + c.r[0] * k, z = c.z + c.r[1] * k;
        edgeCells.addOnce(`${x},${y},${z}`, x, z, y, y, deckM);
        edgeCells.addOnce(`${x},${y + 1},${z}`, x, z, y + 1, y + 1, railM);
        grow(x, y + 1, z);
      }
    });
    // supports: at both ends and at most `every` apart ('ends': the deck bears on its ends only, no pillars)
    const at = [];
    for (let i = 0; i < cells.length; i += every) at.push(i);
    if (at[at.length - 1] !== cells.length - 1) at.push(cells.length - 1);
    const across = [...outer.slice(0, 1), ...offs, ...outer.slice(1)];
    const supportM = this._mat(supports.material ?? 'structure', 'bridge support');
    if (style !== 'ends') {
      for (const i of at) {
        const c = cells[i];
        const cols = new Cols({ floor: 1 }, { abs: 0 });
        let low = null;
        for (const k of across) {
          const x = c.x + c.r[0] * k, z = c.z + c.r[1] * k;
          const b = supports.bottom ? supports.bottom(x, z) : null;
          if (b !== null && b !== undefined) {
            if (!isInt(b)) throw new Error(`${what}: supports.bottom must return an integer y or null`);
            low = low === null ? b : Math.min(low, b);
          }
          cols.add(x, z, 0, ys[i] - 1, supportM);
          grow(x, Math.min(s.floorAt(x, z) + 1, b ?? Infinity), z);
        }
        if (low !== null) cols.from = { min: [{ floor: 1 }, { abs: low }] };
        this._colsOp(cols, COND.IF_AIR_OR_FLUID);
      }
    }
    // (6b) arches: between neighbouring supports, a parabolic soffit under the deck, `rise` deep at the piers, 1 at mid-span
    if (style === 'arch') {
      const archDepth = supports.rise ?? Math.max(2, Math.floor(every / 3));
      const arch = new Cols({ abs: 0 }, { abs: 0 });
      for (let q = 0; q + 1 < at.length; q++) {
        const i0 = at[q], i1 = at[q + 1], half = (i1 - i0) / 2;
        if (half <= 0) continue;
        for (let i = i0 + 1; i < i1; i++) {
          const t = (i - i0 - half) / half; // -1 .. 1
          const depth = Math.max(1, round(1 + (archDepth - 1) * t * t));
          const c = cells[i];
          for (const k of across) {
            const x = c.x + c.r[0] * k, z = c.z + c.r[1] * k;
            arch.addOnce(`${x},${z},${q}`, x, z, ys[i] - depth, ys[i] - 1, supportM);
            grow(x, ys[i] - depth, z);
          }
        }
      }
      this._colsOp(arch, COND.IF_AIR_OR_FLUID);
    }
    // (6b) towers: a square tower each side of the deck at both ends, from the floor to the deck + towerHeight
    if (towers) {
      const th = towers === true ? 6 : towers.height ?? 6;
      const at = towers === true || !towers.at ? 'both' : towers.at;
      if (!['both', 'start', 'end'].includes(at)) throw new Error(`${what}: towers.at must be both, start or end`);
      for (const i of at === 'both' ? [0, cells.length - 1] : at === 'start' ? [0] : [cells.length - 1]) {
        const c = cells[i];
        for (const k of [offs[0] - 3, offs[offs.length - 1] + 3]) {
          const x = c.x + c.r[0] * k, z = c.z + c.r[1] * k;
          this._shapeOp({ kind: 'box', min: [x - 1, { min: [{ floor: 1 }, { abs: ys[i] }] }, z - 1], max: [x + 1, { abs: ys[i] + th }, z + 1] }, supportM, COND.IF_AIR_OR_FLUID);
          grow(x - 1, ys[i], z - 1); grow(x + 1, ys[i] + th, z + 1);
        }
      }
    }
    // (6b) over: 'ours' lets the deck and its rails run over cells the region itself wrote (a link across two generated
    // forms), as later-stage ops may (ALWAYS_OURS); 'air' (default) writes only into air or fluid
    if (over !== 'air' && over !== 'ours') throw new Error(`${what}: over must be 'air' or 'ours'`);
    const deckCond = over === 'ours' ? COND.ALWAYS_OURS : COND.IF_AIR_OR_FLUID;
    this._colsOp(edgeCells, deckCond);
    this._colsOp(head, COND.IF_NATURAL);
    this._colsOp(walkCells, deckCond, true);
    // (6b) lights: a lantern on the rail post every `lights` cells (M5 on the deck)
    if (lights && rail) {
      const lm = this._mat('minecraft:lantern', 'bridge light');
      const lc = new Cols({ abs: 0 }, { abs: 0 });
      // on a rail post: never over a deck cell (a diagonal deck's outer cell can be its neighbour's deck)
      const deck = new Set();
      cells.forEach((c) => { for (const k of offs) deck.add(`${c.x + c.r[0] * k},${c.z + c.r[1] * k}`); });
      for (let i = 0; i < cells.length; i += lights) {
        const c = cells[i];
        for (const k of [outer[(i / lights) % 2], outer[1 - ((i / lights) % 2)]]) {
          const x = c.x + c.r[0] * k, z = c.z + c.r[1] * k;
          if (deck.has(`${x},${z}`)) continue;
          lc.add(x, z, ys[i] + 2, ys[i] + 2, lm);
          break;
        }
      }
      this._colsOp(lc, COND.IF_AIR_OR_FLUID);
    }
    const out = { id: id ?? `${this.id}_bridge_${this.region.paths.length + 1}`, stage: this.stage, part: this.id, kind: 'bridge', box };
    this.region.paths.push(out);
    this.region.meta.paths[out.id] = { kind: 'bridge', part: this.id, stage: this.stage, width, style, maxSpan, supports: style === 'ends' ? [0, cells.length - 1] : at, ends: style === 'ends',
      cells: cells.map((c, i) => [c.x, ys[i], c.z]), right: cells.map((c) => c.r) };
    (this.region.meta.parts[this.id] ??= {}).kind ??= 'path';
    return { cells: cells.map((c, i) => [c.x, ys[i], c.z]), supports: at, box, length: cells.length, id: out.id };
  }

  // ---------------------------------------------------------------- road

  /**
   * A road along a polyline [[x, z] | [x, y, z], ...]. `mode: 'ground'` (default) compiles to 4e RoadRequest items in
   * the IR's `roads` (split over 2048 centre cells or 256 points); a ground road that 4e would refuse on the plan
   * survey (width over 5, cut/fill over 3 = 4e's 4 less a margin, water) is converted to `graded` with a note.
   * `mode: 'graded'` writes cells: a profile from the plan survey smoothed to a grade of at most 1 in 4 (vertex y pins it
   * where given), width 1-9, cut/fill at most 12, retaining edges where a cut or fill exceeds 2. `optional: true` drops a
   * road that cannot be built (with a note) instead of failing the plan. Returns `{mode, ids}` or null when dropped.
   */
  /**
   * (6c T2) A routed run's columns, as the graded road writes them: `fp` = [[x, z, y, edge]] (footprintOf), each column filled from
   * its frozen floor to y - 1 (foundation; `retain` on an edge more than 2 above the floor), cut from y + 1 to the column's top
   * (and over the program's `baseAt` raise), the surface at y (a walk cell); a retaining column outside an edge where the land
   * stands more than 2 above the surface. Registered as a `graded` path with its centre `cells` unless `register: false`.
   */
  _routeRun(id, fp, mats, { baseAt = () => 0, mark = () => {}, cells = [], noSurface = false, register = true, noRetain = () => false, fillTop = () => -Infinity, guardCols = null, noGuard = null } = {}) {
    this._requirePath('route');
    const s = this.region.survey;
    const surfM = this._mat(mats.surface, 'route surface'), fM = this._mat(mats.foundation, 'route foundation'), rM = this._mat(mats.retain, 'route retain');
    if (surfM === null) throw new Error(`part ${this.id}: route surface must not be air`);
    const fillC = new Cols({ floor: 1 }, { abs: 0 });
    const fillB = new Cols({ abs: 0 }, { abs: 0 });
    const cutC = new Cols({ abs: 0 }, { height: 0 });
    const cutB = new Cols({ abs: 0 }, { abs: 0 });
    const surfC = new Cols({ abs: 0 }, { abs: 0 });
    const retC = new Cols({ abs: 0 }, { abs: 0 });
    const gM = mats.guard && guardCols ? this._mat(mats.guard, 'route guard rail') : null;
    const guardC = gM ? new Cols({ abs: 0 }, { abs: 0 }) : null, railC = gM ? new Cols({ abs: 0 }, { abs: 0 }) : null;
    const lM = gM ? this._mat('light', 'route guard light') : null, litC = gM ? new Cols({ abs: 0 }, { abs: 0 }) : null;
    let nGuard = 0;
    const inFp = new Set(fp.map(([x, z]) => `${x},${z}`));
    const box = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
    const grow = (x, y, z) => { box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x); box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y); box.minZ = Math.min(box.minZ, z); box.maxZ = Math.max(box.maxZ, z); };
    for (const [x, z, y, edge] of fp) {
      const g = s.groundAt(x, z), top = Math.max(s.topAt(x, z), g + baseAt(x, z));
      fillC.add(x, z, 0, y - 1, edge && y - s.floorAt(x, z) > 2 ? rM : fM);
      // (and 3 below the surface from the surface down, whatever the frozen floor: a pad's batter may cut below the route first)
      fillB.add(x, z, y - 3, y - 1, edge && y - s.floorAt(x, z) > 2 ? rM : fM);
      cutC.add(x, z, y + 1, 0, null);
      // over the program's raise, and 3 cells of head room whatever the survey's top says (a canopy's leaves over the walk)
      const clear = Math.max(top, y + 3, fillTop(x, z)); // (and a slope pad's batter fill over the route, which an earlier stage made)
      if (clear > s.topAt(x, z)) cutB.add(x, z, y + 1, clear, null);
      if (!noSurface) surfC.add(x, z, y, y, surfM);
      mark(x, z);
      grow(x, Math.min(y, s.floorAt(x, z) + 1), z); grow(x, Math.max(y, top), z);
      if (edge) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ox = x + dx, oz = z + dz;
          if (inFp.has(`${ox},${oz}`)) continue;
          const land = s.groundAt(ox, oz) + baseAt(ox, oz);
          // ((6c S3) the guard: a drop of more than 3 beside the walk gets a parapet column up to the walk's surface and a rail on it)
          // (every GUARD_LIGHT_EVERY-th parapet of the pass carries the light role on its rail: a walk along a drop has no ground beside
          // it for a lamp post)
          if (guardC && y - land > 3) { if (!noGuard(ox, oz) && !guardCols.has(`${ox},${oz}`)) { guardCols.add(`${ox},${oz}`); guardC.add(ox, oz, land + 1, y, rM); railC.add(ox, oz, y + 1, y + 1, gM); if (lM && nGuard++ % GUARD_LIGHT_EVERY === 0) litC.add(ox, oz, y + 2, y + 2, lM); mark(ox, oz); grow(ox, land, oz); grow(ox, y + 2, oz); } continue; }
          if (noRetain(ox, oz)) continue;
          if (land - y > 2) { retC.addOnce(`${ox},${oz}`, ox, oz, y + 1, land, rM); mark(ox, oz); grow(ox, land, oz); }
        }
      }
    }
    this._colsOp(fillC, COND.IF_NATURAL);
    this._colsOp(fillB, COND.IF_NATURAL);
    this._colsOp(cutC, COND.IF_NATURAL);
    this._colsOp(cutB, COND.IF_NATURAL);
    this._colsOp(surfC, COND.IF_NATURAL, true);
    this._colsOp(retC, COND.IF_NATURAL);
    if (guardC && !guardC.empty) { this._colsOp(guardC, COND.IF_NATURAL); this._colsOp(railC, COND.IF_AIR_OR_FLUID); this._colsOp(litC, COND.IF_AIR_OR_FLUID); }
    if (register) {
      if (!PART_ID.test(id)) throw new Error(`part ${this.id}: route id '${id}' must match ${PART_ID}`);
      this.region.paths.push({ id, stage: this.stage, part: this.id, kind: 'graded', box });
      this.region.meta.paths[id] = { kind: 'graded', part: this.id, stage: this.stage, width: null, cells: cells.map((c) => [...c]), route: true };
      (this.region.meta.parts[this.id] ??= {}).kind ??= 'path';
    }
    return id;
  }

  /** (6c T2) A ladder column `{x, z, y0, y1, facing}` (the ladder's feet cells, facing away from its wall); a `ladder` path. */
  _ladder(id, { x, z, y0, y1, facing }) {
    this._requirePath('ladder');
    const m = this._mat(`minecraft:ladder[facing=${facing}]`, 'ladder');
    const c = new Cols({ abs: 0 }, { abs: 0 });
    c.add(x, z, y0, y1, m);
    // head room over the top rung (the climber's head as it steps off)
    const h = new Cols({ abs: 0 }, { abs: 0 });
    h.add(x, z, y1 + 1, y1 + 2, null);
    this._colsOp(h, COND.IF_NATURAL);
    this._colsOp(c, COND.IF_NATURAL);
    this.region.paths.push({ id, stage: this.stage, part: this.id, kind: 'ladder', box: { minX: x, minY: y0, minZ: z, maxX: x, maxY: y1 + 2, maxZ: z } });
    this.region.meta.paths[id] = { kind: 'ladder', part: this.id, stage: this.stage, cells: [[x, y0, z], [x, y1, z]], facing };
    return id;
  }

  road(path, { width = 3, surface = null, lanterns = true, mode = 'ground', optional = false, id, foundation = 'foundation', retain = 'structure', lamp = null } = {}) {
    this._requirePath('road');
    const what = `part ${this.id}: road`;
    const rid = id ?? `${this.id}_road_${this.region.roads.length + this.region.paths.length + 1}`;
    if (!PART_ID.test(rid)) throw new Error(`${what}: id '${rid}' must match ${PART_ID}`);
    if (!Array.isArray(path) || path.length < 2) throw new Error(`${what}: path must be 2+ points`);
    const pts = path.map((p, i) => {
      if (!Array.isArray(p) || (p.length !== 2 && p.length !== 3)) throw new Error(`${what}: point ${i} must be [x, z] or [x, y, z]`);
      const [x, y, z] = p.length === 2 ? [p[0], null, p[1]] : p;
      if (!isNum(x) || !isNum(z) || (y !== null && !isInt(y))) throw new Error(`${what}: point ${i} must be numbers (y an integer)`);
      return [round(x), y, round(z)];
    });
    if (!(isInt(width) && width >= 1 && width <= 9)) throw new Error(`${what}: width must be 1..9`);
    if (mode !== 'ground' && mode !== 'graded') throw new Error(`${what}: mode must be ground or graded`);
    try {
      if (mode === 'ground') {
        const why = width > 5 ? `width ${width} > 5` : this._groundRoadProblem(pts);
        if (!why) return { mode: 'ground', ids: this._groundRoad(rid, pts, { width, surface, lanterns, lamp }) };
        this.region.note(`road ${rid}: converted to graded (${why})`);
      }
      return { mode: 'graded', ids: [this._gradedRoad(rid, pts, { width, surface, foundation, retain })] };
    } catch (e) {
      if (!optional) throw e;
      this.region.note(`road ${rid}: dropped (${e.message})`);
      return null;
    }
  }

  /** Why 4e would refuse this ground road on the plan survey, or null. */
  _groundRoadProblem(pts) {
    const s = this.region.survey;
    const { cells } = centreCells(pts.map((p) => [p[0], p[2]]));
    let lo = -Infinity, hi = Infinity;
    const M = GROUND_ROAD_MARGIN;
    for (const c of cells) {
      if (s.waterAt(c.x, c.z)) return s.frozenAt?.(c.x, c.z) ? `frozen water at ${c.x},${c.z}` : `water at ${c.x},${c.z}`;
      const g = s.heightAt(c.x, c.z);
      lo = Math.max(g - M, lo - 1);
      hi = Math.min(g + M, hi + 1);
      if (lo > hi) return `too steep at ${c.x},${c.z} (cut/fill over ${M} with steps of 1)`;
    }
    return null;
  }

  _groundRoad(rid, pts, { width, surface, lanterns, lamp = null }) {
    const s = this.region.survey;
    // split long segments so no segment has more than half the cell cap
    const fine = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = fine[fine.length - 1], b = pts[i];
      const n = Math.abs(b[0] - a[0]) + Math.abs(b[2] - a[2]);
      const parts = Math.ceil(n / (ROAD_MAX_CELLS / 2));
      for (let k = 1; k < parts; k++) fine.push([round(a[0] + ((b[0] - a[0]) * k) / parts), null, round(a[2] + ((b[2] - a[2]) * k) / parts)]);
      fine.push(b);
    }
    const groups = [[fine[0]]];
    let cellsIn = 1;
    for (let i = 1; i < fine.length; i++) {
      const a = fine[i - 1], b = fine[i];
      const n = Math.abs(b[0] - a[0]) + Math.abs(b[2] - a[2]);
      let g = groups[groups.length - 1];
      if (cellsIn + n > ROAD_MAX_CELLS || g.length >= ROAD_MAX_POINTS) { g = [a]; groups.push(g); cellsIn = 1; }
      g.push(b);
      cellsIn += n;
    }
    const sm = surface === null ? null : this._mat(surface, 'road surface');
    const ids = [];
    groups.forEach((g, k) => {
      const id = groups.length === 1 ? rid : `${rid}_${k + 1}`;
      if (this.region.roadIds.has(id)) throw new Error(`road id '${id}' is used twice`);
      this.region.roadIds.add(id);
      const points = g.map((p) => [p[0], p[1] ?? s.heightAt(p[0], p[2]), p[2]]);
      const r = { id, stage: this.stage, part: this.id, points, width, lanterns: !!lanterns };
      if (sm !== null) r.surface = sm;
      // (6c W) the bible's lamp fixture for the lanterns (fixtures.mjs roadLamp; format 2, kind road:lamp), only when not 4e's own
      if (lanterns && lamp) r.lamp = JSON.parse(JSON.stringify(lamp));
      this.region.roads.push(r);
      ids.push(id);
    });
    return ids;
  }

  _gradedRoad(rid, pts, { width, surface, foundation, retain }) {
    const what = `road ${rid} (graded)`;
    const s = this.region.survey;
    const { cells, vertexAt } = pathCells(pts.map((p) => [p[0], p[2]]));
    const n = cells.length;
    const t = cells.map((c) => s.heightAt(c.x, c.z));
    // pins: given vertex y
    const pins = [];
    pts.forEach((p, k) => { if (p[1] !== null) pins.push([vertexAt[k], p[1]]); });
    const G = 0.25;
    const p = t.map((v, i) => {
      let lo = -Infinity, hi = Infinity;
      for (const [j, y] of pins) { lo = Math.max(lo, y - G * Math.abs(i - j)); hi = Math.min(hi, y + G * Math.abs(i - j)); }
      return Math.min(hi, Math.max(lo, v));
    });
    for (let i = 1; i < n; i++) p[i] = Math.min(p[i - 1] + G, Math.max(p[i - 1] - G, p[i]));
    const y = p.map(round);
    let worst = 0, at = null;
    y.forEach((v, i) => { const d = Math.abs(v - t[i]); if (d > worst) { worst = d; at = cells[i]; } });
    if (worst > 12) throw new Error(`${what}: needs a cut or fill of ${worst} at ${at.x},${at.z} (at most 12)`);
    const surfM = this._mat(surface ?? 'path', 'road surface');
    if (surfM === null) throw new Error(`${what}: surface must not be air`);
    const fM = this._mat(foundation, 'road foundation'), rM = this._mat(retain, 'road retain');
    const offs = crossOffsets(width);
    const fillC = new Cols({ floor: 1 }, { abs: 0 });
    const cutC = new Cols({ abs: 0 }, { height: 0 });
    const surfC = new Cols({ abs: 0 }, { abs: 0 });
    const retC = new Cols({ abs: 0 }, { surface: 0 });
    const box = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
    const grow = (x, yy, z) => { box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x); box.minY = Math.min(box.minY, yy); box.maxY = Math.max(box.maxY, yy); box.minZ = Math.min(box.minZ, z); box.maxZ = Math.max(box.maxZ, z); };
    const seen = new Set();
    // centre cells first, then the cross-sections (a column keeps its first assignment)
    const order = offs.map((k, j) => [k, j]).sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]) || a[0] - b[0]);
    for (const [k, j] of order) cells.forEach((c, i) => {
      const yy = y[i];
      {
        const x = c.x + c.r[0] * k, z = c.z + c.r[1] * k;
        const key = `${x},${z}`;
        if (seen.has(key)) return;
        seen.add(key);
        const g = s.heightAt(x, z);
        const edge = j === 0 || j === offs.length - 1;
        fillC.add(x, z, 0, yy - 1, edge && yy - s.floorAt(x, z) > 2 ? rM : fM);
        cutC.add(x, z, yy + 1, 0, null);
        surfC.add(x, z, yy, yy, surfM);
        grow(x, Math.min(yy, s.floorAt(x, z) + 1), z); grow(x, Math.max(yy, g), z);
        if (edge) {
          const kk = k + (j === 0 ? -1 : 1);
          const ox = c.x + c.r[0] * kk, oz = c.z + c.r[1] * kk;
          if (s.heightAt(ox, oz) - yy > 2) retC.addOnce(`${ox},${oz}`, ox, oz, yy + 1, 0, rM);
        }
      }
    });
    this._colsOp(fillC, COND.IF_NATURAL);
    this._colsOp(cutC, COND.IF_NATURAL);
    this._colsOp(surfC, COND.IF_NATURAL, true);
    this._colsOp(retC, COND.IF_NATURAL);
    this.region.paths.push({ id: rid, stage: this.stage, part: this.id, kind: 'graded', box });
    this.region.meta.paths[rid] = { kind: 'graded', part: this.id, stage: this.stage, width, cells: cells.map((c, i) => [c.x, y[i], c.z]) };
    (this.region.meta.parts[this.id] ??= {}).kind ??= 'path';
    return rid;
  }

  // ---------------------------------------------------------------- lot

  /**
   * A building lot on a pad. `at: [x, z]` is the footprint's north-west corner, `size: [w, d]`. The pad (this part's
   * ops): every column of the footprint plus a 1-column apron ends with its top solid block at `floorY - 1`
   * (foundation), with air from `floorY` up to the lot box's top over the footprint (and to the column top elsewhere);
   * cut above (natural cells), fill below from the frozen floor; `pad.edge: 'slope'` adds 1:1 batter steps out to
   * maxCut / maxFill, `'wall'` none. A pad needing more than maxCut / maxFill on the plan survey fails the plan with
   * the numbers. `floor`: 'auto' (balanced cut and fill) or the floorY. `front`: a cardinal or 'toward:<anchor|part>'.
   * `max: [x, y, z]`: the child cap (default [w, 16, d]). `stage`: the lot's stage (default this part's).
   */
  lot(id, { at, size, floor = 'auto', front = 'south', max, brief, pad = {}, foundation = 'foundation', batter = 'subsurface', stage, ext } = {}) {
    const what = `lot ${id}`;
    if (typeof id !== 'string' || !LOT_ID.test(id)) throw new Error(`lot id '${id}' must match ${LOT_ID}`);
    if (this.region.lotIds.has(id)) throw new Error(`lot id '${id}' is used twice`);
    if (!Array.isArray(at) || at.length !== 2 || !at.every(isInt)) throw new Error(`${what}: at must be [x, z] integers`);
    if (!Array.isArray(size) || size.length !== 2 || !size.every((v) => isInt(v) && v >= 1 && v <= 96)) throw new Error(`${what}: size must be [w, d], 1..96`);
    const [w, d] = size;
    const mx = max ?? [w, 16, d];
    if (!Array.isArray(mx) || mx.length !== 3 || !mx.every((v) => isInt(v) && v >= 1) || mx[0] > 96 || mx[1] > 64 || mx[2] > 96) throw new Error(`${what}: max must be [x, y, z] within 96x64x96`);
    // (6c T1, N-T1-1) `blend` (the relief pass meets the pad) is the default edge of a program that declares passes
    const { maxCut = 6, maxFill = 6, edge = (this.region.ctx.passes?.length ? 'blend' : 'slope'), fill: padFill = 'foundation' } = pad;
    if (padFill !== 'foundation' && padFill !== 'none') throw new Error(`${what}: pad fill must be 'foundation' or 'none'`);
    if (!(isInt(maxCut) && maxCut >= 0 && maxCut <= 64 && isInt(maxFill) && maxFill >= 0 && maxFill <= 64)) throw new Error(`${what}: pad maxCut / maxFill must be 0..64`);
    if (edge !== 'slope' && edge !== 'wall' && edge !== 'blend') throw new Error(`${what}: pad edge must be slope, wall or blend`);
    if (edge === 'blend') this.region.blendLots.push(id);
    const s = this.region.survey;
    const ps = s.padStats(at[0], at[1], w, d, { floorY: floor === 'auto' ? null : floor });
    if (floor !== 'auto' && !isInt(floor)) throw new Error(`${what}: floor must be 'auto' or an integer y`);
    if (padFill === 'none') { ps.cut = 0; ps.fill = 0; } // (6b) a pad on a generated mass: no fill to the frozen ground (M9 checks the top)
    if (ps.cut > maxCut || ps.fill > maxFill) throw new Error(`${what}: the pad needs a cut of ${ps.cut} and a fill of ${ps.fill} (max ${maxCut} / ${maxFill}) at floorY ${ps.floorY}`);
    const lstage = stage === undefined ? this.stage : this.region._stage(stage);
    const floorY = ps.floorY, t = floorY - 1;
    const x0 = at[0], z0 = at[1], x1 = x0 + w - 1, z1 = z0 + d - 1;
    const c = this.region.claim;
    if (x0 - 1 < c.minX || x1 + 1 > c.maxX || z0 - 1 < c.minZ || z1 + 1 > c.maxZ) throw new Error(`${what}: the pad is outside the claim`);
    const boxMaxY = floorY + mx[1] - 1;
    if (t < c.minY || boxMaxY > c.maxY) throw new Error(`${what}: the lot box y ${t}..${boxMaxY} is outside the claim's y range`);
    const fdn = this._mat(foundation, 'lot foundation'), bat = this._mat(batter, 'lot batter');
    const none = padFill === 'none';
    const Bc = edge === 'slope' && !none ? maxCut : 0, Bf = edge === 'slope' && !none ? maxFill : 0;
    const box = (k, ylo, yhi) => ({ kind: 'box', min: [x0 - 1 - k, ylo, z0 - 1 - k], max: [x1 + 1 + k, yhi, z1 + 1 + k] });
    // (6c RS) the pad's cut, fill, batter and top are a terrain kind's write (free in survival when natural)
    this.region.terrain(() => {
      // fill: batter steps (subsurface) then the pad itself (foundation, wins where they overlap)
      if (Bf > 0) this._shapeOp({ kind: 'union', of: Array.from({ length: Bf }, (_, i) => box(i + 1, { floor: 1 }, { abs: t - 2 - i })) }, bat, COND.IF_NATURAL);
      if (!none) this._shapeOp(box(0, { floor: 1 }, { abs: t - 1 }), fdn, COND.IF_NATURAL);
      // cut: the footprint to the lot box's top, the apron and batter steps to the column top
      const cut = [{ kind: 'box', min: [x0, { abs: floorY }, z0], max: [x1, { max: [{ height: 0 }, { abs: boxMaxY }] }, z1] }];
      for (let k = 0; k <= Bc; k++) cut.push(box(k, { abs: floorY + k }, { height: 0 }));
      // (pad fill none: the mass under it is a generated form; only the footprint is cleared, its apron stays the form's)
      if (none) this._shapeOp({ kind: 'box', min: [x0, { abs: floorY }, z0], max: [x1, { abs: boxMaxY }, z1] }, null, COND.ALWAYS_OURS);
      else this._shapeOp({ kind: 'union', of: cut }, null, COND.IF_NATURAL);
      // the pad's top: (6b addition, region lot
      // entrances) the 1-column apron keeps the surrounding ground: a natural or region-made top stays, only a gap (air or
      // fluid) takes the surface role; never the foundation block. A fill-none pad's apron is the form's own top.
      // (a plan recorded as kit 0.11.x keeps 0.11's pad: the foundation over the apron too, so its IR stays byte-identical)
      const v = String(this.region.ctx?.kitVersion ?? '0.12.0').split('.').map(Number);
      const legacy = v[0] === 0 && v[1] < 12;
      // (the footprint's top reads as ground too where a smaller child leaves it uncovered: the surface role; a fill-none pad
      // keeps the foundation, written over the form's own top)
      this._shapeOp(legacy ? box(0, { abs: t }, { abs: t }) : { kind: 'box', min: [x0, { abs: t }, z0], max: [x1, { abs: t }, z1] }, legacy || none ? fdn : this._mat('surface', 'lot top'), none ? COND.ALWAYS_OURS : COND.IF_NATURAL);
      if (!none && !legacy) {
        const T = { abs: t };
        const apron = { kind: 'union', of: [
          { kind: 'box', min: [x0 - 1, T, z0 - 1], max: [x1 + 1, T, z0 - 1] }, { kind: 'box', min: [x0 - 1, T, z1 + 1], max: [x1 + 1, T, z1 + 1] },
          { kind: 'box', min: [x0 - 1, T, z0], max: [x0 - 1, T, z1] }, { kind: 'box', min: [x1 + 1, T, z0], max: [x1 + 1, T, z1] },
        ] };
        this._shapeOp(apron, this._mat('surface', 'lot apron'), COND.IF_AIR_OR_FLUID);
      }
    });
    // front
    let fr = front;
    if (typeof front === 'string' && front.startsWith('toward:')) {
      const name = front.slice(7);
      const target = this.region.anchors[name] ?? this.region.parts.find((p) => p.id === name)?.center?.();
      if (!target) throw new Error(`${what}: front '${front}': no anchor or part '${name}'`);
      const tx = Array.isArray(target) ? target[0] : target.x, tz = Array.isArray(target) ? target[target.length - 1] : target.z;
      fr = dominantCardinal(tx - (x0 + x1) / 2, tz - (z0 + z1) / 2);
    }
    if (!Object.hasOwn(CARDINALS, fr)) throw new Error(`${what}: front must be north, south, east, west or 'toward:<anchor|part>'`);
    const lot = {
      id, stage: lstage, part: this.id, at: [x0, z0], size: [w, d], floorY, front: fr, max: mx,
      box: { minX: x0, minY: floorY, minZ: z0, maxX: x1, maxY: boxMaxY, maxZ: z1 },
      pad: { cut: ps.cut, fill: ps.fill, maxCut, maxFill, edge },
    };
    if (brief !== undefined) lot.brief = String(brief).slice(0, 500);
    if (none) lot.pad.fill = 'none';
    // (6c V) caller data carried to LotSpec.ext (e.g. "architect_mc:village"); only when given, so other IRs are unchanged
    if (ext !== undefined) lot.ext = JSON.parse(JSON.stringify(ext));
    this.region.lotIds.add(id);
    this.region._addLot(lot);
    // (6b) the lot's entrance (meta): the cell in front of the middle of the front edge, on the apron, at floorY
    const mx2 = x0 + Math.floor((w - 1) / 2), mz2 = z0 + Math.floor((d - 1) / 2);
    const ent = { north: [mx2, floorY, z0 - 1], south: [mx2, floorY, z1 + 1], west: [x0 - 1, floorY, mz2], east: [x1 + 1, floorY, mz2] }[fr];
    this.region.meta.lots[id] = { entrance: ent, part: this.id };
    (this.region.meta.parts[this.id] ??= {}).kind ??= 'pad';
    return { ...lot, entrance: ent };
  }

  /** The centre of this part's ops' x/z bounds (for 'toward:<part>'). */
  center() {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const o of this.ops) {
      if (o.op === 'shape') {
        const n = compileShape(o.shape, this.region.blobs);
        x0 = Math.min(x0, n.minX); x1 = Math.max(x1, n.maxX); z0 = Math.min(z0, n.minZ); z1 = Math.max(z1, n.maxZ);
      } else if (o.op === 'relief') { // (6c T1) the field's extent
        const f = this.region.fields[o.field];
        if (f) { x0 = Math.min(x0, f.minX); x1 = Math.max(x1, f.minX + f.width * f.res - 1); z0 = Math.min(z0, f.minZ); z1 = Math.max(z1, f.minZ + f.depth * f.res - 1); }
      } else if (o.op === 'scatter') { // (6c F2) the area
        x0 = Math.min(x0, o.area[0]); x1 = Math.max(x1, o.area[2]); z0 = Math.min(z0, o.area[1]); z1 = Math.max(z1, o.area[3]);
      } else if (o.op === 'stamp') { // (6c F2) the root
        x0 = Math.min(x0, o.at[0]); x1 = Math.max(x1, o.at[0]); z0 = Math.min(z0, o.at[2]); z1 = Math.max(z1, o.at[2]);
      } else if (o.op === 'voxels') {
        // (6c F1) the baked box
        const [sx, , sz] = voxelsSize(this.region.sideBlobs[o.blob].bytes);
        const odd = o.rotation === 90 || o.rotation === 270;
        x0 = Math.min(x0, o.origin[0]); x1 = Math.max(x1, o.origin[0] + (odd ? sz : sx) - 1); z0 = Math.min(z0, o.origin[2]); z1 = Math.max(z1, o.origin[2] + (odd ? sx : sz) - 1);
      } else {
        for (let i = 0; i < o.cols.length; i += 5) { x0 = Math.min(x0, o.cols[i]); x1 = Math.max(x1, o.cols[i]); z0 = Math.min(z0, o.cols[i + 1]); z1 = Math.max(z1, o.cols[i + 1]); }
      }
    }
    return Number.isFinite(x0) ? [(x0 + x1) / 2, (z0 + z1) / 2] : null;
  }
}

// ------------------------------------------------------------------ polygon helpers

function centroid(poly) {
  let x = 0, z = 0;
  for (const p of poly) { x += p[0]; z += p[1]; }
  return [x / poly.length, z / poly.length];
}

function scalePoly(poly, c, f) {
  return poly.map((p) => [c[0] + (p[0] - c[0]) * f, c[1] + (p[1] - c[1]) * f]);
}

/** Distance from c along unit d to the polygon's edge (bisection on the evaluator's own distance). */
function rayToEdge(poly, c, d) {
  let lo = 0, hi = 1;
  while (polygonDistance(poly, c[0] + d[0] * hi, c[1] + d[1] * hi) <= 0 && hi < 1e5) hi *= 2;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (polygonDistance(poly, c[0] + d[0] * m, c[1] + d[1] * m) <= 0) lo = m; else hi = m;
  }
  return lo;
}

/** The cells of a polygon (sd <= 0 by the evaluator's rule) that have a 4-neighbour outside. */
export function boundaryCells(poly) {
  const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
  const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs)), z0 = Math.floor(Math.min(...zs)), z1 = Math.ceil(Math.max(...zs));
  const inside = (x, z) => polygonDistance(poly, x, z) <= 0;
  const out = [];
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    if (!inside(x, z)) continue;
    if (!inside(x + 1, z) || !inside(x - 1, z) || !inside(x, z + 1) || !inside(x, z - 1)) out.push([x, z]);
  }
  return out;
}

export { yrefError };
