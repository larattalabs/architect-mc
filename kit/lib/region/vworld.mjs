// The virtual world (docs/CONTRACT.md 6b §3.1, SETTLEMENTS §5.2): the plan survey (2.5D: solid from the floor down, air
// above the column's top) + frozen volumes where the plan took them + the IR, evaluated by the same realise.mjs stage by
// stage with the cell conditions resolved against the world as it stands, as the mod does at P1. The checker (check.mjs)
// and the previews read it. A dump-backed world (two ARWD dumps of the realised claim, before and after) gives the same
// interface for the scenario metrics.
import { BLOCKS, collisionOf, emissionOf, isClimbable, isFloor, isPassable, isSpawnable, lightCost, opticsOf, topOf, voxelClassOf } from '../blocks.mjs';
import { compileIR, evalTile } from '../realise.mjs';
import { FLAG_MISSING, FLAG_TREE, FLAG_WATER, asColumns, makeColumns, unpack } from './pack.mjs';
import { sampleIndex } from './survey.mjs';
import { VC, classAt } from './volume.mjs';
import { centreCells, crossOffsets, segmentAxis, rightOf } from './geom.mjs';

export const AIR = 'minecraft:air';

/** Parse a canonical block state string to {name, props}. */
export function parseState(s) {
  const i = s.indexOf('[');
  if (i < 0) return { name: s, props: {} };
  const props = {};
  for (const kv of s.slice(i + 1, -1).split(',')) { const [k, v] = kv.split('='); props[k] = v; }
  return { name: s.slice(0, i), props };
}

const NATURAL_CLASSES = new Set(['AIR', 'ROCK', 'SOIL', 'LOOSE', 'ICE', 'SNOW', 'WATER', 'LAVA', 'LOG', 'LEAVES', 'PLANT']);
const GRAVITY = /(^minecraft:(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|anvil|chipped_anvil|damaged_anvil|pointed_dripstone|scaffolding)$)|_concrete_powder$/;

/** A palette of block states with the per-state facts the rules need. */
export class Palette {
  constructor() {
    this.states = [];
    this.index = new Map();
    this.passable = []; this.floor = []; this.solid = []; this.barrier = []; this.fluid = []; this.water = []; this.lava = [];
    this.natural = []; this.gravity = []; this.emit = []; this.opaque = []; this.cost = []; this.spawn = []; this.climb = []; this.air = [];
    this.top = [];
    this.of(AIR);
  }
  of(s) {
    let i = this.index.get(s);
    if (i !== undefined) return i;
    i = this.states.length;
    this.states.push(s);
    this.index.set(s, i);
    const st = parseState(s);
    const known = !!BLOCKS[st.name];
    const air = st.name === 'minecraft:air' || st.name === 'minecraft:cave_air' || st.name === 'minecraft:void_air';
    const water = st.name === 'minecraft:water' || st.name === 'minecraft:bubble_column' || st.props.waterlogged === 'true';
    const lava = st.name === 'minecraft:lava';
    this.air.push(air);
    this.water.push(water && !air);
    this.lava.push(lava);
    this.fluid.push(st.name === 'minecraft:water' || st.name === 'minecraft:bubble_column' || lava);
    this.passable.push(air || (known ? isPassable(st) : false));
    this.floor.push(!air && known && isFloor(st));
    const coll = known ? collisionOf(st) : 'full';
    this.solid.push(!air && coll !== 'none' && coll !== 'low');
    this.top.push(known ? topOf(st) : 1);
    this.barrier.push(!air && known && (coll === 'thin' || coll === 'full' || (coll === 'door' && st.props.open !== 'true')) && (topOf(st) >= 1.5 || coll === 'thin' || coll === 'full'));
    const vc = air ? 'AIR' : voxelClassOf(st.name);
    this.natural.push(NATURAL_CLASSES.has(vc));
    this.gravity.push(GRAVITY.test(st.name));
    this.emit.push(known ? emissionOf(st) : 0);
    this.opaque.push(known ? opticsOf(st) === 'opaque' : true);
    this.cost.push(known ? lightCost(st) : 15);
    this.spawn.push(known && isSpawnable(st.name) && isFloor(st));
    this.climb.push(known && isClimbable(st));
    return i;
  }
}

const SECTION = 4096;
const skey = (sx, sy, sz) => ((sx + 131072) * 262144 + (sz + 131072)) * 512 + (sy + 256);
// cell flags
export const F_WRITTEN = 1, F_WALK = 2;

/**
 * The world as the rules see it: `get(x, y, z)` -> palette index. `base(x, y, z)` is the pre-region world; overrides
 * (written cells) live in 16^3 sections with their flags and the part that wrote them.
 */
export class VWorld {
  constructor({ claim, palette, base, colTop }) {
    this.claim = claim;
    this.pal = palette ?? new Palette();
    this.base = base;
    this.colTop = colTop; // (x, z) -> the pre-region column's top y (fast path for untouched columns)
    this.sections = new Map();
    this.W = claim.maxX - claim.minX + 1; this.D = claim.maxZ - claim.minZ + 1;
    this.wLo = new Int16Array(this.W * this.D).fill(32767); // per column: written y range
    this.wHi = new Int16Array(this.W * this.D).fill(-32768);
    this.lots = []; // active lot boxes
    this.lotCol = new Int32Array(this.W * this.D); // lot index + 1 per column (lots never overlap)
    this.written = 0;
  }
  inClaim(x, z) { return x >= this.claim.minX && x <= this.claim.maxX && z >= this.claim.minZ && z <= this.claim.maxZ; }
  colIndex(x, z) { return (x - this.claim.minX) + (z - this.claim.minZ) * this.W; }
  sec(x, y, z, make) {
    const k = skey(x >> 4, y >> 4, z >> 4);
    let s = this.sections.get(k);
    if (!s && make) { s = { v: new Uint16Array(SECTION), f: new Uint8Array(SECTION), p: new Uint16Array(SECTION) }; this.sections.set(k, s); }
    return s;
  }
  get(x, y, z) {
    const s = this.sections.get(skey(x >> 4, y >> 4, z >> 4));
    if (s) { const v = s.v[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]; if (v) return v - 1; }
    return this.base(x, y, z);
  }
  flags(x, y, z) {
    const s = this.sections.get(skey(x >> 4, y >> 4, z >> 4));
    return s ? s.f[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] : 0;
  }
  partAt(x, y, z) {
    const s = this.sections.get(skey(x >> 4, y >> 4, z >> 4));
    return s ? s.p[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] - 1 : -1;
  }
  set(x, y, z, idx, flags, part = -1) {
    const s = this.sec(x, y, z, true);
    const o = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
    if (!(s.f[o] & F_WRITTEN)) this.written++;
    s.v[o] = idx + 1; s.f[o] = flags | F_WRITTEN; s.p[o] = part + 1;
    if (this.inClaim(x, z)) {
      const c = this.colIndex(x, z);
      if (y < this.wLo[c]) this.wLo[c] = y;
      if (y > this.wHi[c]) this.wHi[c] = y;
    }
  }
  /** Activate a lot's box (an obstacle: its interior is the declared box, A5B §3). */
  addLot(lot) {
    const li = this.lots.length;
    this.lots.push(lot);
    const b = lot.box;
    for (let z = b.minZ; z <= b.maxZ; z++) for (let x = b.minX; x <= b.maxX; x++) if (this.inClaim(x, z)) this.lotCol[this.colIndex(x, z)] = li + 1;
  }
  lotAt(x, y, z) {
    if (!this.inClaim(x, z)) return null;
    const li = this.lotCol[this.colIndex(x, z)];
    if (!li) return null;
    const b = this.lots[li - 1].box;
    return y >= b.minY && y <= b.maxY ? this.lots[li - 1] : null;
  }
  /** Every written cell: cb(x, y, z, idx, flags, part). */
  eachWritten(cb) {
    for (const [k, s] of this.sections) {
      const sy = (k % 512) - 256, rest = Math.floor(k / 512), sz = (rest % 262144) - 131072, sx = Math.floor(rest / 262144) - 131072;
      for (let o = 0; o < SECTION; o++) {
        if (!(s.f[o] & F_WRITTEN)) continue;
        cb(sx * 16 + (o & 15), sy * 16 + (o >> 8), sz * 16 + ((o >> 4) & 15), s.v[o] - 1, s.f[o], s.p[o] - 1);
      }
    }
  }
  /** The y range a column's cells may change in (written cells, or its pre-region top). */
  colRange(x, z) {
    const t = this.colTop(x, z);
    if (!this.inClaim(x, z)) return [t, t];
    const c = this.colIndex(x, z);
    return this.wLo[c] <= this.wHi[c] ? [Math.min(this.wLo[c], t), Math.max(this.wHi[c], t)] : [t, t];
  }
}

/**
 * The pre-region world of a plan survey (any resolution; nearest sample, missing columns from their neighbours as the
 * planner fills them) and frozen volumes (decoded ARVX, cell for cell where they cover).
 */
export function surveyBase(survey, palette, volumes = []) {
  const c = asColumns(survey);
  const P = palette;
  const S = { air: P.of(AIR), grass: P.of('minecraft:grass_block'), dirt: P.of('minecraft:dirt'), stone: P.of('minecraft:stone'), water: P.of('minecraft:water'),
    log: P.of('minecraft:oak_log'), sand: P.of('minecraft:sand'), lava: P.of('minecraft:lava') };
  const VCS = [S.air, S.stone, S.dirt, S.sand, P.of('minecraft:ice'), P.of('minecraft:snow_block'), S.water, S.lava, S.log, P.of('minecraft:oak_leaves'), P.of('minecraft:short_grass'),
    P.of('minecraft:stone_bricks'), P.of('minecraft:stone_bricks'), P.of('minecraft:chest'), -1];
  const at = (x, z) => sampleIndex(c, x, z);
  const top = (x, z) => { const k = at(x, z); return Math.max(c.ground[k], c.height[k]); };
  const base = (x, y, z) => {
    for (const v of volumes) {
      const cl = classAt(v, x, y, z);
      if (cl !== VC.MISSING) return VCS[cl];
    }
    const k = at(x, z);
    const g = c.ground[k], h = c.height[k], f = c.floor[k], fl = c.flags[k];
    if (y > g) return fl & FLAG_TREE && y <= h ? S.log : S.air;
    if (fl & FLAG_WATER && y > f) return S.water;
    if (y === g) return fl & FLAG_WATER ? S.sand : S.grass;
    if (y >= g - 3) return S.dirt;
    return S.stone;
  };
  return { base, colTop: top, columns: c };
}

/** Windows of resolution 1 for a tile key from a survey (as the plan's budget pass), with the missing flag cleared. */
export function windowOf(survey, key) {
  const s = asColumns(survey);
  const [tx, tz] = String(key).split(',').map(Number);
  const w = makeColumns(tx * 64 - 8, tz * 64 - 8, 80, 80, 1);
  for (let j = 0; j < 80; j++) for (let i = 0; i < 80; i++) {
    const k = sampleIndex(s, w.minX + i, w.minZ + j), o = i + j * 80;
    w.ground[o] = s.ground[k]; w.height[o] = s.height[k]; w.floor[o] = s.floor[k]; w.flags[o] = s.flags[k] & ~FLAG_MISSING;
  }
  return w;
}

/**
 * Build the virtual world of an IR over a survey, stage by stage (terrain, then paths, then the stage's ground roads; then
 * the stage's lots become boxes). Each written cell passes its condition against the world as it stands (CellCond).
 * `onStage(stage, vw)` runs after each stage (the prefix checks). Returns {vw, clipped: {part: n}, ms}.
 */
export function buildVirtual({ ir, survey, blobs, volumes = [], onStage, filled }) {
  const t0 = performance.now();
  const pal = new Palette();
  const sb = surveyBase(filled ?? survey, pal, volumes);
  const vw = new VWorld({ claim: ir.claim, palette: pal, base: sb.base, colTop: sb.colTop });
  vw.survey = sb.columns;
  const C = compileIR(ir, { blobs });
  const partIdx = new Map(ir.parts.map((p, i) => [p.id, i]));
  const opPart = C.ops.map((o) => o.part);
  const clipped = {};
  const windows = new Map();
  const win = (key) => { let w = windows.get(key); if (!w) { w = windowOf(filled ?? survey, key); windows.set(key, w); } return w; };
  for (const stage of ir.stages) {
    for (const set of ['terrain', 'path']) {
      for (const key of ir.tiles?.[stage]?.[set] ?? []) {
        const e = evalTile(ir, key, win(key), { stage, set, blobs, cellOps: true });
        const cells = unpack(e.payload).cells;
        for (let i = 0; i < cells.length; i++) {
          const c = cells[i];
          const idx = pal.of(c.state);
          const cur = vw.get(c.x, c.y, c.z);
          const ours = (vw.flags(c.x, c.y, c.z) & F_WRITTEN) !== 0;
          let ok;
          switch (c.cond) {
            case 1: ok = pal.natural[cur] && !pal.air[cur] && !pal.fluid[cur] && pal.solid[cur]; break;
            case 2: ok = pal.air[cur] || pal.fluid[cur]; break;
            case 3: ok = ours || pal.natural[cur]; break;
            default: ok = pal.natural[cur];
          }
          if (!ok) continue;
          if (cur === idx && !c.walk) continue; // a no-op cell (the mod skips it at P1)
          vw.set(c.x, c.y, c.z, idx, c.walk ? F_WALK : 0, opPart[e.cellOps[i]]);
        }
        if (e.notes.clipped) {
          // attribute clipped cells by re-counting per part (rare: a write outside the claim)
          for (const p of ir.parts) {
            if (p.stage !== stage || (p.set ?? 'terrain') !== set) continue;
            const one = { ...ir, parts: [p] };
            const n = evalTile(one, key, win(key), { stage, set, blobs, countOnly: true }).notes.clipped;
            if (n) clipped[p.id] = (clipped[p.id] ?? 0) + n;
          }
        }
      }
    }
    // 4e ground roads: a dirt path surface at the ground, 2 cells cleared above (their real profile is 4e's, at realise)
    for (const r of ir.roads ?? []) {
      if (r.stage !== stage) continue;
      const pi = partIdx.get(r.part) ?? -1;
      const surf = pal.of(r.surface ?? 'minecraft:dirt_path'), air = pal.of(AIR);
      const pts = r.points.map((p) => [p[0], p[2]]);
      const { cells } = centreCells(pts);
      const offs = crossOffsets(r.width);
      for (const c of cells) {
        const a = pts[Math.min(c.seg, pts.length - 1)], b = pts[Math.min(c.seg + 1, pts.length - 1)];
        const rr = rightOf(segmentAxis(a, b));
        for (const k of offs) {
          const x = c.x + rr[0] * k, z = c.z + rr[1] * k;
          if (!vw.inClaim(x, z)) continue;
          const g = sb.colTop(x, z);
          vw.set(x, g, z, surf, F_WALK, pi);
          for (const dy of [1, 2]) if (!pal.air[vw.get(x, g + dy, z)]) vw.set(x, g + dy, z, air, 0, pi);
        }
      }
    }
    for (const l of ir.lots ?? []) if (l.stage === stage) vw.addLot(l);
    if (onStage) onStage(stage, vw);
  }
  return { vw, clipped, ms: performance.now() - t0 };
}

// ------------------------------------------------------------------ the dump-backed world (realised metrics)

/** Decode an ARWD dump (kit/REGIONS.md "Realised-world dumps"). */
export async function decodeArwd(file) {
  const zlib = await import('node:zlib');
  let b = file instanceof Uint8Array ? file : Uint8Array.from(file);
  if (b[0] === 0x1f && b[1] === 0x8b) b = new Uint8Array(zlib.gunzipSync(b));
  if (b.length < 32 || b[0] !== 0x41 || b[1] !== 0x52 || b[2] !== 0x57 || b[3] !== 0x44) throw new Error('ARWD: bad magic');
  if (b[4] !== 1) throw new Error(`ARWD: version ${b[4]}`);
  const hasLight = (b[5] & 1) !== 0;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const box = { minX: dv.getInt32(8, true), minY: dv.getInt32(12, true), minZ: dv.getInt32(16, true), maxX: dv.getInt32(20, true), maxY: dv.getInt32(24, true), maxZ: dv.getInt32(28, true) };
  let o = 32;
  const varint = () => { let v = 0, mul = 1, byte; do { byte = b[o++]; v += (byte & 127) * mul; mul *= 128; } while (byte & 128); return v; };
  const np = varint();
  const palette = [];
  const td = new TextDecoder();
  for (let i = 0; i < np; i++) { const n = varint(); palette.push(td.decode(b.subarray(o, o + n))); o += n; }
  const W = box.maxX - box.minX + 1, H = box.maxY - box.minY + 1, D = box.maxZ - box.minZ + 1;
  const cells = new Uint16Array(W * H * D);
  for (let col = 0; col < W * D; col++) { let y = 0; while (y < H) { const pi = varint(), len = varint(); cells.fill(pi, col * H + y, col * H + y + len); y += len; } }
  let light = null;
  if (hasLight) {
    light = new Uint8Array(W * H * D);
    for (let col = 0; col < W * D; col++) { let y = 0; while (y < H) { const l = b[o++], len = varint(); light.fill(l, col * H + y, col * H + y + len); y += len; } }
  }
  return { box, palette, cells, light, W, H, D, at: (x, y, z) => ((x - box.minX) * D + (z - box.minZ)) * H + (y - box.minY) };
}

/**
 * A world from two dumps of the same box: `before` (pristine) and `after` (realised). Cells that differ are the written
 * cells (no part attribution). `light` comes from the after dump when it carries it.
 */
export function dumpWorld(before, after, claim) {
  const pal = new Palette();
  const map = (d) => d.palette.map((s) => pal.of(s));
  const pb = map(before), pa = map(after);
  const box = after.box;
  const inBox = (x, y, z) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && z >= box.minZ && z <= box.maxZ;
  const air = pal.of(AIR);
  const base = (x, y, z) => (inBox(x, y, z) ? pb[before.cells[before.at(x, y, z)]] : air);
  const colTop = (x, z) => {
    if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) return box.minY;
    for (let y = box.maxY; y >= box.minY; y--) if (!pal.air[base(x, y, z)]) return y;
    return box.minY;
  };
  const vw = new VWorld({ claim: { ...claim, minY: box.minY, maxY: box.maxY }, palette: pal, base, colTop });
  for (let x = box.minX; x <= box.maxX; x++) for (let z = box.minZ; z <= box.maxZ; z++) for (let y = box.minY; y <= box.maxY; y++) {
    const i = after.at(x, y, z);
    const a = pa[after.cells[i]], b0 = pb[before.cells[before.at(x, y, z)]];
    if (a !== b0) vw.set(x, y, z, a, 0, -1);
  }
  if (after.light) vw.lightAt = (x, y, z) => (inBox(x, y, z) ? after.light[after.at(x, y, z)] : 0);
  return vw;
}
