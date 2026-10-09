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
import { info, normalize, qualify } from '../blocks.mjs';
import { variant } from '../kit.mjs';
import { fnv64 } from '../noise.mjs';
import { columnCells, compileShape, polygonDistance, sdAt, shapeError, staticY, yrefError } from '../sdf.mjs';
import { encodeArbl } from '../realise.mjs';
import { ruleError } from '../material.mjs';
import { sha256Hex } from './pack.mjs';
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
  if (ctx.__region) throw new Error('region(ctx) may be called once per plan');
  const r = new Region(ctx);
  Object.defineProperty(ctx, '__region', { value: r, enumerable: false });
  return r;
}

export class Region {
  constructor(ctx) {
    this.ctx = ctx;
    this.claim = ctx.claim;
    this.survey = ctx.survey;
    this.roles = ctx.roles;
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
    this.volumesUsed = {}; // name -> {blob, box, sha}
    this.meta = { paths: {}, lots: {}, parts: {} };
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

  /** A part: the unit of per-part counts and (6d) diffs. `set`: 'terrain' (default) or 'path'. */
  part(id, { stage, set = 'terrain' } = {}) {
    if (typeof id !== 'string' || !PART_ID.test(id)) throw new Error(`part id '${id}' must match ${PART_ID}`);
    if (this.partIds.has(id)) throw new Error(`part id '${id}' is used twice (part ids are unique)`);
    if (set !== 'terrain' && set !== 'path') throw new Error(`part ${id}: set must be 'terrain' or 'path'`);
    const p = new Part(this, id, this._stage(stage), set);
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

  /** (6b) Ask the planner for a frozen 3D volume over `box` (the two-plan flow); returns the decoded volume when it was given. */
  needVolume(box) {
    const b = { minX: box.minX, minY: box.minY, minZ: box.minZ, maxX: box.maxX, maxY: box.maxY, maxZ: box.maxZ };
    if (!Object.values(b).every(isInt)) throw new Error('needVolume: box needs integer minX..maxZ');
    this.needVolumes.push(b);
    const v = this.ctx.volumes?.find((x) => x.box.minX === b.minX && x.box.minY === b.minY && x.box.minZ === b.minZ && x.box.maxX === b.maxX && x.box.maxY === b.maxY && x.box.maxZ === b.maxZ);
    if (!v) return null;
    const name = `vol_${Object.keys(this.volumesUsed).length + 1}`;
    this._sideBlob(name, 'volume', v.bytes);
    this.volumesUsed[name] = { blob: name, box: b, sha: v.sha };
    return v.decoded ?? null;
  }

  /**
   * (6b) A generated form (plan time): `gen` is a generator result `{ops, bounds, generator, version, params, seed}`; its ops
   * go into part `id` (created in `stage`) and its provenance into the IR's `forms`.
   */
  form(id, gen, { stage, set = 'terrain' } = {}) {
    const p = this.part(id, { stage, set });
    const from = p.ops.length;
    for (const op of gen.ops) {
      if (op.op === 'shape') { const e = shapeError(op.shape); if (e) throw new Error(`form ${id}: ${e}`); }
      if (op.material && typeof op.material === 'object') { const e = ruleError(op.material.rule, `form ${id} material`); if (e) throw new Error(e); }
      p._push({ ...op, cond: op.cond ?? COND.IF_AIR_OR_FLUID, walk: !!op.walk });
    }
    this.forms.push({ id, generator: gen.generator, version: gen.version, params: gen.params, seed: gen.seed, bounds: gen.bounds, part: id, opsFrom: from, opsTo: p.ops.length });
    (this.meta.parts[id] ??= {}).kind = 'form';
    return p;
  }

  /** A material: a role name (ctx.roles), a block state, or null / 'air'. Returns the block state or null (air). */
  material(v, what = 'material') {
    if (v === null || v === undefined || v === 'air' || v === 'minecraft:air') return null;
    if (v && typeof v === 'object' && v.rule) return this.materialRule(v, what);
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
    const out = { rule: r.rule.map((c) => ({ when: c.when ?? {}, mat: this.material(c.mat, `${what} rule`) })), default: this.material(r.default ?? 'rock', `${what} rule default`) };
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
  constructor(region, id, stage, set) {
    this.region = region;
    this.id = id;
    this.stage = stage;
    this.set = set;
    this.ops = [];
  }

  get roles() { return this.region.roles; }
  _mat(v, what) { return this.region.material(v, `${this.id}: ${what}`); }

  _push(op) {
    this.region.opCount++;
    this.ops.push(op);
  }

  /** Low-level: every cell inside `shape` gets `material` (null: air) with `cond` and `walk`. */
  fill(shape, material, { cond = COND.IF_NATURAL, walk = false } = {}) {
    const err = shapeError(shape);
    if (err) throw new Error(`part ${this.id}: ${err}`);
    if (!isInt(cond) || cond < 0 || cond > 3) throw new Error(`part ${this.id}: cond must be 0..3`);
    this._push({ op: 'shape', shape, material: this._mat(material, 'fill material'), cond, walk: !!walk });
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
  carve(shape, { to = 'air', lining = null, liningDepth = 1, naturalOnly = true } = {}) {
    const err = shapeError(shape);
    if (err) throw new Error(`part ${this.id}: carve: ${err}`);
    if (!(isNum(liningDepth) && liningDepth > 0 && liningDepth <= 8)) throw new Error(`part ${this.id}: carve liningDepth must be 0 < d <= 8`);
    const cond = naturalOnly ? COND.IF_NATURAL : COND.ALWAYS_OURS;
    if (lining !== null) {
      const shell = { kind: 'clipY', y0: null, y1: { floor: 0 }, of: { kind: 'subtract', of: [{ kind: 'offset', d: liningDepth, of: shape }, shape] } };
      this._shapeOp(shell, this._mat(lining, 'carve lining'), COND.IF_SOLID_NATURAL);
    }
    const toMat = this._mat(to, 'carve to');
    this._shapeOp(toMat === null ? { kind: 'clipY', y0: null, y1: { height: 0 }, of: shape } : shape, toMat, cond);
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
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const col = { g: s.heightAt(x, z), h: s.topAt(x, z), f: s.floorAt(x, z) };
      if (sdAt(node, x, fy, z, col) > 0 || fy > col.g) continue; // only under the ground: a hollow, not open air
      if (floor === 'flat') floorCols.add(x, z, fy - 1, fy - 1, this._mat(floorMaterial, 'cavern floor'));
      n++;
      if ((x - x0) % every === Math.floor(every / 2) % every && (z - z0) % every === Math.floor(every / 2) % every) { lights.add(x, z, fy, fy, lightM); lit.push([x, fy, z]); }
    }
    if (!n) throw new Error(`part ${this.id}: the cavern has no floor cell under the ground at floorY ${fy}`);
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
  ring(c, r0, r1, { height = 8, rise = 0, gates = [], material = 'structure', threshold = 'path', towers, crenels } = {}) {
    if (!Array.isArray(c) || c.length !== 2 || !c.every(isNum)) throw new Error(`part ${this.id}: ring centre must be [x, z]`);
    if (!(isNum(r0) && isNum(r1) && r0 >= 0 && r1 > r0)) throw new Error(`part ${this.id}: ring needs 0 <= r0 < r1`);
    if (!(isInt(height) && height >= 1 && height <= 64)) throw new Error(`part ${this.id}: ring height must be 1..64`);
    if (!(isInt(rise) && rise >= 0 && rise <= 64)) throw new Error(`part ${this.id}: ring rise must be 0..64`);
    const mat = this._mat(material, 'ring material');
    this._shapeOp({ kind: 'ring', c: [c[0], { surface: 0 }, c[1]], r0, r1, h: height + rise + 1 }, mat, COND.IF_NATURAL);
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
        const tx = c[0] + d[0] * rm, tz = c[1] + d[1] * rm;
        if (gateAt.some((g) => Math.sqrt(sq(g.x - tx) + sq(g.z - tz)) < g.w / 2 + tr + 2)) continue;
        this._shapeOp({ kind: 'cylinder', c: [tx, { surface: 0 }, tz], r: tr, h: top + extra }, mat, COND.IF_NATURAL);
        towerList.push([round(tx), round(tz), tr]);
      }
    }
    // (6b) crenels: merlons on every other outer-rim cell of the wall top (checkerboard), plus the towers' rims
    if (crenels) {
      const cols = new Cols({ surface: 0 }, { surface: 0 });
      const R1 = Math.ceil(r1) + 1;
      for (let z = Math.floor(c[1] - R1); z <= Math.ceil(c[1] + R1); z++) for (let x = Math.floor(c[0] - R1); x <= Math.ceil(c[0] + R1); x++) {
        const d = Math.sqrt(sq(x - c[0]) + sq(z - c[1]));
        if (d >= r1 - 1 && d <= r1 && ((x + z) & 1) === 0) cols.add(x, z, top, top, mat);
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
      const ty = this.region.survey.heightAt(round(gx), round(gz));
      const v0 = -Math.floor((w - 1) / 2) - 0.25, v1 = Math.floor(w / 2) + 0.25;
      const u0 = r0 - 2, u1 = r1 + 2;
      const poly = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => [c[0] + d[0] * u + p[0] * v, c[1] + d[1] * u + p[1] * v]);
      this._shapeOp({ kind: 'extrude', polygon: poly, y0: { floor: 1 }, y1: { abs: ty - 1 } }, this._mat('foundation', 'foundation'), COND.IF_NATURAL);
      this._shapeOp({ kind: 'extrude', polygon: poly, y0: { abs: ty }, y1: { abs: ty } }, this._mat(threshold, 'gate threshold'), COND.IF_NATURAL, true);
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
   * Returns the levels `[{y, radius|polygon}]`.
   */
  terrace(area, levels, { riser = 2, step, retain = 'structure', edge = 'slope', stairs = true, stairWidth = 3, surface = 'surface', fill = 'subsurface', soil = 3, stairMaterial = 'structure', startAngle = 45 } = {}) {
    if (!area || typeof area !== 'object') throw new Error(`part ${this.id}: terrace area must be {center, radius} or {polygon}`);
    if (edge !== 'slope' && edge !== 'wall') throw new Error(`part ${this.id}: terrace edge must be slope or wall`);
    const circle = Array.isArray(area.center) && isNum(area.radius);
    if (!circle && !(Array.isArray(area.polygon) && area.polygon.length >= 3)) throw new Error(`part ${this.id}: terrace area must be {center, radius} or {polygon}`);
    const center = area.center ?? centroid(area.polygon);
    const n = Array.isArray(levels) ? levels.length : levels;
    if (!(isInt(n) && n >= 1 && n <= 32)) throw new Error(`part ${this.id}: terrace needs 1..32 levels`);
    const fr = area.fractions ?? Array.from({ length: n }, (_, k) => 1 - k / n);
    if (fr.length !== n || fr.some((f, k) => !(f > 0 && f <= 1 && (k === 0 || f < fr[k - 1])))) throw new Error(`part ${this.id}: terrace fractions must be ${n} descending values in (0, 1]`);
    const stepH = step ?? (edge === 'wall' ? 4 : riser);
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
      this._shapeOp(footprint(k, { abs: y + 1 }, { height: 0 }), null, COND.IF_NATURAL);
      this._shapeOp(footprint(k, { min: [{ floor: 1 }, { abs: Math.max(y - soil, this.region.claim.minY + 2) }] }, { abs: y - 1 }), fillM, COND.IF_NATURAL);
      this._shapeOp(footprint(k, { abs: y }, { abs: y }), surf, COND.IF_NATURAL);
      if (edge === 'wall') {
        const lo = k === 0 ? { floor: 1 } : { abs: ys[k - 1] + 1 };
        const wall = circle
          ? { kind: 'ring', c: [center[0], { abs: -4096 }, center[1]], r0: area.radius * fr[k] - 1, r1: area.radius * fr[k], h: 8192 }
          : { kind: 'subtract', of: [{ kind: 'extrude', polygon: scalePoly(area.polygon, center, fr[k]), y0: { abs: -4096 }, y1: { abs: 4096 } }, { kind: 'offset', d: -1, of: { kind: 'extrude', polygon: scalePoly(area.polygon, center, fr[k]), y0: { abs: -4200 }, y1: { abs: 4200 } } }] };
        this._shapeOp({ kind: 'clipY', y0: lo, y1: { abs: y }, of: wall }, ret, COND.IF_NATURAL);
      }
      out.push(circle ? { y, radius: area.radius * fr[k] } : { y, polygon: scalePoly(area.polygon, center, fr[k]) });
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
  stair(path, { width = 3, rise = 1, landingEvery = 8, carve = true, railing = null, spiral = false, material = 'structure', id, lights, _unsafeRise } = {}) {
    this._requirePath('stair');
    if (rise !== 1) throw new Error(`part ${this.id}: stair rise must be 1`);
    const r = this._stair(path, { width, landingEvery, carve, railing, spiral, material, kind: 'stair', lights, _unsafeRise });
    const sid = id ?? `${this.id}_stair_${this.region.paths.length + 1}`;
    this.region.paths.push({ id: sid, stage: this.stage, part: this.id, kind: 'stair', box: r.box });
    this.region.meta.paths[sid] = { kind: 'stair', part: this.id, stage: this.stage, width, landingEvery, cells: r.cells };
    (this.region.meta.parts[this.id] ??= {}).kind ??= 'path';
    return { ...r, id: sid };
  }

  _stair(path, { width = 3, landingEvery = 8, carve = true, railing = null, spiral = false, material = 'structure', kind = 'stair', lights, _unsafeRise }) {
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
      core = { c: s.center, top: s.top, bottom: s.bottom };
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
    const tread = (x, y, z, m) => {
      const k = `${x},${z}`;
      const l = colTreads.get(k) ?? [];
      if (l.some((v) => Math.abs(v - y) < 3)) return;
      l.push(y);
      colTreads.set(k, l);
      treads.add(x, z, y, y, m);
      if (carve) head.add(x, z, y + 1, y + 2, null);
      grow(x, y, z); grow(x, y + 2, z);
    };
    const matAt = (i) => (stairFacing[i] ? stairsOf(full, stairFacing[i]) ?? full : full);
    cells.forEach((c, i) => tread(c.x, ys[i], c.z, matAt(i)));
    cells.forEach((c, i) => {
      const y = ys[i];
      for (const k of offs) if (k !== 0) tread(c.x + c.r[0] * k, y, c.z + c.r[1] * k, matAt(i));
      if (railM !== null) {
        for (const k of [offs[0] - 1, offs[offs.length - 1] + 1]) {
          const x = c.x + c.r[0] * k, z = c.z + c.r[1] * k;
          rails.addOnce(`${x},${y},${z}`, x, z, y, y, full);
          rails.addOnce(`${x},${y + 1},${z}`, x, z, y + 1, y + 1, railM);
          grow(x, y + 1, z);
        }
      }
    });
    this._colsOp(rails, COND.IF_NATURAL);
    this._colsOp(head, COND.IF_NATURAL);
    if (core) {
      const [cx, cz] = core.c.map(round);
      this._shapeOp({ kind: 'box', min: [cx - 1, { min: [{ floor: 1 }, { abs: core.bottom }] }, cz - 1], max: [cx + 1, { abs: core.top }, cz + 1] }, full, COND.IF_NATURAL);
      grow(cx - 1, core.bottom, cz - 1); grow(cx + 1, core.top, cz + 1);
    }
    this._colsOp(treads, COND.IF_NATURAL, true);
    // (6b) lights: a lantern on a rail post (or the tread's outer edge) every `lights` cells
    if (lights) {
      const lm = this._mat('minecraft:lantern', `${kind} light`);
      const lc = new Cols({ abs: 0 }, { abs: 0 });
      for (let i = 0; i < cells.length; i += lights) {
        const c = cells[i], k = railM !== null ? offs[offs.length - 1] + 1 : offs[offs.length - 1];
        lc.add(c.x + c.r[0] * k, c.z + c.r[1] * k, ys[i] + (railM !== null ? 2 : 1), ys[i] + (railM !== null ? 2 : 1), lm);
      }
      this._colsOp(lc, COND.IF_NATURAL);
    }
    return { cells: cells.map((c, i) => [c.x, ys[i], c.z]), box, width };
  }

  // ---------------------------------------------------------------- bridge

  /**
   * A bridge deck along a polyline [[x, y, z], ...] (y absolute or {surface: dy}), y interpolated per cell (at most 1
   * per block: a steeper segment fails), `width` walk-surface cells wide with rail posts on both sides, 2 cells of
   * headroom carved, and pillar supports (the deck's full cross-section, down to the frozen floor; `supports.bottom(x, z)`
   * may return an absolute y to reach lower, e.g. a carved bowl's floor) at the ends and at most `every` apart.
   * `every` must be <= `maxSpan`. Arches and towers are phase 6b.
   */
  bridge(path, { width = 3, deck = 'structure', rail = true, railMaterial = 'rail', supports = {}, maxSpan = 24, towers = false, id, lights, _unsafe = false } = {}) {
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
    const walkCells = new Cols({ abs: 0 }, { abs: 0 });
    const edgeCells = new Cols({ abs: 0 }, { abs: 0 });
    const head = new Cols({ abs: 0 }, { abs: 0 });
    const box = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
    const grow = (x, y, z) => { box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x); box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y); box.minZ = Math.min(box.minZ, z); box.maxZ = Math.max(box.maxZ, z); };
    const s = this.region.survey;
    cells.forEach((c, i) => {
      walkCells.addOnce(`${c.x},${c.z}`, c.x, c.z, ys[i], ys[i], deckM);
      head.addOnce(`${c.x},${c.z}`, c.x, c.z, ys[i] + 1, ys[i] + 2, null);
    });
    cells.forEach((c, i) => {
      const y = ys[i];
      for (const k of offs) {
        const x = c.x + c.r[0] * k, z = c.z + c.r[1] * k;
        walkCells.addOnce(`${x},${z}`, x, z, y, y, deckM);
        head.addOnce(`${x},${z}`, x, z, y + 1, y + 2, null);
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
      for (const i of [0, cells.length - 1]) {
        const c = cells[i];
        for (const k of [offs[0] - 2, offs[offs.length - 1] + 2]) {
          const x = c.x + c.r[0] * k, z = c.z + c.r[1] * k;
          this._shapeOp({ kind: 'box', min: [x - 1, { min: [{ floor: 1 }, { abs: ys[i] }] }, z - 1], max: [x + 1, { abs: ys[i] + th }, z + 1] }, supportM, COND.IF_AIR_OR_FLUID);
          grow(x - 1, ys[i], z - 1); grow(x + 1, ys[i] + th, z + 1);
        }
      }
    }
    this._colsOp(edgeCells, COND.IF_AIR_OR_FLUID);
    this._colsOp(head, COND.IF_NATURAL);
    this._colsOp(walkCells, COND.IF_AIR_OR_FLUID, true);
    // (6b) lights: a lantern on the rail post every `lights` cells (M5 on the deck)
    if (lights && rail) {
      const lm = this._mat('minecraft:lantern', 'bridge light');
      const lc = new Cols({ abs: 0 }, { abs: 0 });
      for (let i = 0; i < cells.length; i += lights) {
        const c = cells[i], k = outer[(i / lights) % 2];
        lc.add(c.x + c.r[0] * k, c.z + c.r[1] * k, ys[i] + 2, ys[i] + 2, lm);
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
  road(path, { width = 3, surface = null, lanterns = true, mode = 'ground', optional = false, id, foundation = 'foundation', retain = 'structure' } = {}) {
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
        if (!why) return { mode: 'ground', ids: this._groundRoad(rid, pts, { width, surface, lanterns }) };
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
      if (s.waterAt(c.x, c.z)) return `water at ${c.x},${c.z}`;
      const g = s.heightAt(c.x, c.z);
      lo = Math.max(g - M, lo - 1);
      hi = Math.min(g + M, hi + 1);
      if (lo > hi) return `too steep at ${c.x},${c.z} (cut/fill over ${M} with steps of 1)`;
    }
    return null;
  }

  _groundRoad(rid, pts, { width, surface, lanterns }) {
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
  lot(id, { at, size, floor = 'auto', front = 'south', max, brief, pad = {}, foundation = 'foundation', batter = 'subsurface', stage } = {}) {
    const what = `lot ${id}`;
    if (typeof id !== 'string' || !LOT_ID.test(id)) throw new Error(`lot id '${id}' must match ${LOT_ID}`);
    if (this.region.lotIds.has(id)) throw new Error(`lot id '${id}' is used twice`);
    if (!Array.isArray(at) || at.length !== 2 || !at.every(isInt)) throw new Error(`${what}: at must be [x, z] integers`);
    if (!Array.isArray(size) || size.length !== 2 || !size.every((v) => isInt(v) && v >= 1 && v <= 96)) throw new Error(`${what}: size must be [w, d], 1..96`);
    const [w, d] = size;
    const mx = max ?? [w, 16, d];
    if (!Array.isArray(mx) || mx.length !== 3 || !mx.every((v) => isInt(v) && v >= 1) || mx[0] > 96 || mx[1] > 64 || mx[2] > 96) throw new Error(`${what}: max must be [x, y, z] within 96x64x96`);
    const { maxCut = 6, maxFill = 6, edge = 'slope', fill: padFill = 'foundation' } = pad;
    if (padFill !== 'foundation' && padFill !== 'none') throw new Error(`${what}: pad fill must be 'foundation' or 'none'`);
    if (!(isInt(maxCut) && maxCut >= 0 && maxCut <= 64 && isInt(maxFill) && maxFill >= 0 && maxFill <= 64)) throw new Error(`${what}: pad maxCut / maxFill must be 0..64`);
    if (edge !== 'slope' && edge !== 'wall') throw new Error(`${what}: pad edge must be slope or wall`);
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
    // fill: batter steps (subsurface) then the pad itself (foundation, wins where they overlap)
    if (Bf > 0) this._shapeOp({ kind: 'union', of: Array.from({ length: Bf }, (_, i) => box(i + 1, { floor: 1 }, { abs: t - 2 - i })) }, bat, COND.IF_NATURAL);
    if (!none) this._shapeOp(box(0, { floor: 1 }, { abs: t - 1 }), fdn, COND.IF_NATURAL);
    // cut: the footprint to the lot box's top, the apron and batter steps to the column top
    const cut = [{ kind: 'box', min: [x0, { abs: floorY }, z0], max: [x1, { max: [{ height: 0 }, { abs: boxMaxY }] }, z1] }];
    for (let k = 0; k <= Bc; k++) cut.push(box(k, { abs: floorY + k }, { height: 0 }));
    if (none) this._shapeOp({ kind: 'box', min: [x0 - 1, { abs: floorY }, z0 - 1], max: [x1 + 1, { abs: boxMaxY }, z1 + 1] }, null, COND.ALWAYS_OURS);
    else this._shapeOp({ kind: 'union', of: cut }, null, COND.IF_NATURAL);
    this._shapeOp(box(0, { abs: t }, { abs: t }), fdn, none ? COND.ALWAYS_OURS : COND.IF_NATURAL);
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
