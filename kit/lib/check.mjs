// Blueprint checker: validates a structure template + its sidecar against docs/CONTRACT.md "Checker profiles".
//   checkFiles(nbtPath, jsonPath, opts) / checkBlueprint(bp, opts) / checkStructure(sidecar, structure, opts)
//     -> { ok, errors: string[], warnings: string[] }
//   opts: { max?: {x,y,z}, type?: string }
// Ported from AgentCraft's tools/blueprints/lib/check.mjs (MIT, see LICENSE): the office rules are gone, the light,
// door and anchor rules stay errors; the rules new in Architect are warnings in phase 1.
import fs from 'node:fs';
import { parse, plain } from './nbt.mjs';
import {
  BLOCKS, collisionOf, normalize, emissionOf, opticsOf, voxelsOf, faceMask, lightCost, isConductor, isFloor,
} from './blocks.mjs';
import { BUILDING_TYPES } from './kit.mjs';

const DIRS6 = [['east', 1, 0, 0], ['west', -1, 0, 0], ['up', 0, 1, 0], ['down', 0, -1, 0], ['south', 0, 0, 1], ['north', 0, 0, -1]];
const OPP = { east: 'west', west: 'east', up: 'down', down: 'up', south: 'north', north: 'south' };
const H_VEC = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
export const fmt = (x, y, z) => `${x},${y},${z}`;
const unfmt = (k) => k.split(',').map(Number);

/**
 * The parsed template as a grid with the cell rules every check shares. Unwritten cells above the ground row are air
 * (placement clears natural terrain in the box); unwritten cells below it are terrain (solid).
 */
export function makeGrid(cells, size, groundY) {
  const [sx, sy, sz] = size;
  const at = (x, y, z) => cells.get(fmt(x, y, z)) ?? null;
  const inBox = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz;
  const terrain = (x, y, z) => y < groundY && !cells.has(fmt(x, y, z));
  const cls = (x, y, z) => {
    const c = at(x, y, z);
    if (c) return collisionOf(c);
    return terrain(x, y, z) ? 'full' : 'none';
  };
  /** a body can be in the cell without opening anything (air, carpet, torches, buttons...) */
  const free = (x, y, z) => { const k = cls(x, y, z); return k === 'none' || k === 'low'; };
  /** an entity can stand on the cell (the cell above is its feet cell) */
  const floor = (x, y, z) => (terrain(x, y, z) ? true : isFloor(at(x, y, z)));
  /** a mob could stand at feet cell (x,y,z): a floor below, two free cells */
  const standable = (x, y, z) => floor(x, y - 1, z) && free(x, y, z) && free(x, y + 1, z);
  return { cells, size, groundY, at, inBox, cls, free, floor, standable, terrain };
}

/**
 * The outside: a flood from beyond the template box through every cell a mob could pass (air, carpet, torches,
 * buttons, lanterns and other small blocks; not cubes, glass, panes, fences, closed doors, slabs, stairs), above the
 * ground row. `capY`: never rise above this row (seeded at the ground beside the box), which finds openings in walls;
 * without it the flood also comes down through open roofs.
 * @returns {Map<string,string|null>} reached cell -> the cell it came from
 */
export function outsideFlood(g, capY = null) {
  const [sx, sy, sz] = g.size;
  const top = capY ?? sy;
  const open = (x, y, z) => {
    if (!g.inBox(x, y, z)) return y >= g.groundY;
    const k = g.cls(x, y, z);
    return k === 'none' || k === 'low' || k === 'partial';
  };
  const parent = new Map();
  const y0 = capY === null ? sy : g.groundY;
  parent.set(fmt(-1, y0, -1), null);
  const q = [[-1, y0, -1]];
  for (let i = 0; i < q.length; i++) {
    const [x, y, z] = q[i];
    for (const [, dx, dy, dz] of DIRS6) {
      const nx = x + dx; const ny = y + dy; const nz = z + dz;
      if (nx < -1 || nx > sx || nz < -1 || nz > sz || ny > top || ny < Math.min(g.groundY, 0)) continue;
      const k = fmt(nx, ny, nz);
      if (parent.has(k) || !open(nx, ny, nz)) continue;
      parent.set(k, fmt(x, y, z));
      q.push([nx, ny, nz]);
    }
  }
  return parent;
}

/**
 * Vanilla block light from vanilla emitters (torches, lanterns, froglights, lit candles...; never the invisible
 * `minecraft:light`): the level drops by 1 per step (more through leaves and water), opaque cubes stop it, glass and
 * panes pass it, slabs and stairs block it through their full faces. Terrain below the ground row is opaque.
 * @returns {(x:number,y:number,z:number)=>number} the light level of a cell
 */
export function lightLevels(g) {
  const [sx, sy, sz] = g.size;
  const idx = (x, y, z) => x + sx * (y + sy * z);
  const n = sx * sy * sz;
  const optic = new Uint8Array(n); // 0 clear, 1 opaque, 2 shape
  const vox = new Uint8Array(n);
  const cost = new Uint8Array(n).fill(1);
  const level = new Int8Array(n);
  const buckets = Array.from({ length: 16 }, () => []);
  for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) {
    const i = idx(x, y, z);
    const c = g.at(x, y, z);
    if (!c) { optic[i] = y < g.groundY ? 1 : 0; continue; }
    const o = opticsOf(c);
    optic[i] = o === 'opaque' ? 1 : o === 'shape' ? 2 : 0;
    if (o === 'shape') vox[i] = voxelsOf(c);
    cost[i] = lightCost(c);
    const e = emissionOf(c);
    if (e > 0) { level[i] = e; buckets[e].push(i); }
  }
  for (let L = 15; L >= 2; L--) {
    for (const i of buckets[L]) {
      if (level[i] !== L) continue;
      const x = i % sx; const y = Math.floor(i / sx) % sy; const z = Math.floor(i / (sx * sy));
      for (const [d, dx, dy, dz] of DIRS6) {
        const nx = x + dx; const ny = y + dy; const nz = z + dz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
        const j = idx(nx, ny, nz);
        if (optic[j] === 1) continue;
        if ((optic[i] === 2 || optic[j] === 2) && ((optic[i] === 2 ? faceMask(vox[i], d) : 0) | (optic[j] === 2 ? faceMask(vox[j], OPP[d]) : 0)) === 15) continue;
        const nl = L - cost[j];
        if (nl > level[j]) { level[j] = nl; if (nl >= 1) buckets[nl].push(j); }
      }
    }
  }
  return (x, y, z) => (g.inBox(x, y, z) ? level[idx(x, y, z)] : 0);
}

/** The interior box's cells as [x,y,z] (feet rows). */
export function interiorCells(w) {
  const out = [];
  for (let y = w.minY; y <= w.maxY; y++) for (let z = w.minZ; z <= w.maxZ; z++) for (let x = w.minX; x <= w.maxX; x++) out.push([x, y, z]);
  return out;
}

/**
 * Doors: every door is written closed; an iron door has a stone (or any) button on both sides, each on a full,
 * redstone-conductive block touching one of the door's halves. Returns the lower halves found.
 */
export function doorCheck(g) {
  const errors = [];
  const buttons = [];
  const doors = [];
  for (const [k, c] of g.cells) {
    if (BLOCKS[c.name]?.family !== 'button') continue;
    const [x, y, z] = unfmt(k);
    const f = c.props.face;
    const [ax, ay, az] = f === 'floor' ? [x, y - 1, z] : f === 'ceiling' ? [x, y + 1, z] : [x - H_VEC[c.props.facing][0], y, z - H_VEC[c.props.facing][1]];
    const a = g.at(ax, ay, az);
    buttons.push({ x, y, z, ax, ay, az, conductive: !!a && isConductor(a) });
  }
  for (const [k, c] of g.cells) {
    if (BLOCKS[c.name]?.family !== 'door' || c.props.half !== 'lower') continue;
    const [x, y, z] = unfmt(k);
    doors.push({ x, y, z, state: c });
    if (c.props.open !== 'false') errors.push(`door at ${k} is written open (write doors closed: an open door lets mobs in at night)`);
    const up = g.at(x, y + 1, z);
    if (!up || up.name !== c.name || up.props.half !== 'upper') errors.push(`door at ${k}: no matching upper half above it`);
    if (c.name !== 'minecraft:iron_door') continue;
    const [fx, fz] = H_VEC[c.props.facing];
    const side = new Set();
    for (const b of buttons) {
      if (!b.conductive) continue;
      const touches = [y, y + 1].some((dy) => Math.abs(b.ax - x) + Math.abs(b.ay - dy) + Math.abs(b.az - z) === 1);
      if (!touches) continue;
      const along = (b.x - x) * fx + (b.z - z) * fz;
      if (along !== 0) side.add(Math.sign(along));
    }
    if (!side.has(1) || !side.has(-1)) {
      errors.push(`iron door at ${k}: needs a button on ${!side.has(1) && !side.has(-1) ? 'both sides' : !side.has(1) ? 'its front' : 'its back'} attached to a full, redstone-conductive block next to the door (or use a wooden door)`);
    }
  }
  return { errors, doors };
}

/** Parse `x,y,z` (--max). */
export function parseMax(s) {
  const m = /^(\d+),(\d+),(\d+)$/.exec(String(s).trim());
  if (!m) throw new Error(`--max must be x,y,z (got '${s}')`);
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

/**
 * @param {object} sidecar parsed <id>.blueprint.json
 * @param {object} structure plain (untagged) parsed structure NBT root
 * @param {{max?:{x:number,y:number,z:number}, type?:string}} [opts]
 */
export function checkStructure(sidecar, structure, opts = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  // ---- structure format
  if (!Number.isInteger(structure.DataVersion)) err('structure: DataVersion missing / not an int');
  const size = structure.size;
  if (!Array.isArray(size) || size.length !== 3 || !size.every(Number.isInteger)) err('structure: size must be a list of 3 ints');
  if (!Array.isArray(structure.palette)) err('structure: palette missing');
  if (!Array.isArray(structure.blocks)) err('structure: blocks missing');
  if (!Array.isArray(structure.entities)) err('structure: entities missing (must be an empty list)');
  else if (structure.entities.length) err('structure: entities must be empty');
  if (errors.length) return { ok: false, errors, warnings };

  // ---- palette: vanilla blocks only, every property explicit and valid
  const palette = structure.palette.map((p, i) => {
    const props = p.properties ?? {};
    const name = p.id;
    if (typeof name !== 'string' || !name.includes(':')) { err(`palette[${i}]: bad id '${name}'`); return { name: String(name), props }; }
    if (!name.startsWith('minecraft:')) { err(`palette[${i}]: '${name}' is not a vanilla block (templates use minecraft: blocks only)`); return { name, props }; }
    if (!BLOCKS[name]) { err(`palette[${i}]: unknown block '${name}' (not a vanilla 26.3 block)`); return { name, props }; }
    for (const v of Object.values(props)) if (typeof v !== 'string') err(`palette[${i}] ${name}: property values must be strings`);
    try {
      const full = normalize(name, props);
      for (const k of Object.keys(full.props)) if (!(k in props)) err(`palette[${i}] ${name}: property '${k}' not written explicitly`);
    } catch (e) {
      err(`palette[${i}]: ${e.message}`);
    }
    return { name, props };
  });

  // ---- blocks
  const cells = new Map();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const [i, b] of structure.blocks.entries()) {
    if (!Array.isArray(b.pos) || b.pos.length !== 3 || !b.pos.every(Number.isInteger)) { err(`blocks[${i}]: bad pos`); continue; }
    const [x, y, z] = b.pos;
    const st = palette[b.state];
    if (!st) { err(`blocks[${i}] at ${x},${y},${z}: state ${b.state} not in palette`); continue; }
    const k = fmt(x, y, z);
    if (cells.has(k)) err(`duplicate block at ${k}`);
    cells.set(k, { ...st, nbt: b.nbt });
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], b.pos[a]); max[a] = Math.max(max[a], b.pos[a]); }
    if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) err(`block at ${k} outside size ${size.join('x')}`);
  }
  if (cells.size) {
    const extent = max.map((m, a) => m - min[a] + 1);
    if (min.some((m) => m !== 0) || extent.some((e, a) => e !== size[a])) {
      err(`size ${size.join('x')} does not match block extents ${extent.join('x')} (min ${min.join(',')})`);
    }
  } else err('no blocks');

  // ---- size limit (--max)
  if (opts.max) {
    const over = ['x', 'y', 'z'].filter((a, i) => size[i] > opts.max[a]);
    if (over.length) err(`size ${size.join('x')} exceeds the limit ${opts.max.x}x${opts.max.y}x${opts.max.z} (${over.join(', ')})`);
  }

  // ---- sidecar basics
  for (const f of ['id', 'name', 'type', 'size', 'groundY', 'front', 'anchors']) if (sidecar[f] === undefined) err(`sidecar: '${f}' missing`);
  if (!/^[a-z0-9_]+$/.test(sidecar.id ?? '')) err(`sidecar: id '${sidecar.id}' must match [a-z0-9_]+`);
  if (sidecar.type !== undefined && !BUILDING_TYPES.includes(sidecar.type)) err(`sidecar: type '${sidecar.type}' must be one of ${BUILDING_TYPES.join(', ')}`);
  if (opts.type && sidecar.type !== opts.type) err(`sidecar: type '${sidecar.type}' but the request asked for '${opts.type}'`);
  if (!(sidecar.front in H_VEC)) err(`sidecar: front '${sidecar.front}' invalid`);
  if (sidecar.size && (sidecar.size.x !== size[0] || sidecar.size.y !== size[1] || sidecar.size.z !== size[2])) {
    err(`sidecar size ${sidecar.size?.x}x${sidecar.size?.y}x${sidecar.size?.z} != structure size ${size.join('x')}`);
  }
  if (!(Number.isInteger(sidecar.groundY) && sidecar.groundY >= 1 && sidecar.groundY < size[1])) err('sidecar: groundY must be an int inside the template (>= 1: the floor row is groundY-1)');
  if (sidecar.tags !== undefined && !(Array.isArray(sidecar.tags) && sidecar.tags.every((t) => typeof t === 'string'))) err('sidecar: tags must be a list of strings');
  if (sidecar.materials !== undefined && !(Array.isArray(sidecar.materials) && sidecar.materials.every((t) => typeof t === 'string' && BLOCKS[t]))) err('sidecar: materials must be a list of vanilla block ids');
  const w = sidecar.interior ?? null;
  if (w) {
    for (const f of ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ']) if (!Number.isInteger(w[f])) err(`sidecar: interior.${f} must be an int`);
    if (w.minX > w.maxX || w.minY > w.maxY || w.minZ > w.maxZ) err('sidecar: interior min > max');
    if (w.minX < 0 || w.minY < 0 || w.minZ < 0 || w.maxX >= size[0] || w.maxY >= size[1] || w.maxZ >= size[2]) err('sidecar: interior outside the template');
  }
  if (sidecar.foundationBlock !== undefined) {
    const fb = sidecar.foundationBlock;
    if (typeof fb !== 'string' || !fb.startsWith('minecraft:')) err(`sidecar: foundationBlock '${fb}' must be a vanilla block id (minecraft:...)`);
    else if (!BLOCKS[fb] || collisionOf({ name: fb, props: {} }) !== 'full' || opticsOf({ name: fb, props: {} }) !== 'opaque') err(`sidecar: foundationBlock '${fb}' must be a full, opaque block`);
  }
  if (sidecar.approach !== undefined && sidecar.approach !== false) {
    const a = sidecar.approach;
    if (typeof a !== 'object' || a === null) err("sidecar: 'approach' must be an object or false");
    else {
      if (a.length !== undefined && !(Number.isInteger(a.length) && a.length >= 0 && a.length <= 16)) err(`sidecar: approach.length ${a.length} must be an int 0..16`);
      if (a.width !== undefined && !(Number.isInteger(a.width) && a.width >= 1 && a.width <= 7)) err(`sidecar: approach.width ${a.width} must be an int 1..7`);
      for (const [k, want] of [['block', 'floor'], ['slab', 'slab']]) {
        const id = a[k];
        if (id === undefined) continue;
        if (typeof id !== 'string' || !id.startsWith('minecraft:') || !BLOCKS[id]) err(`sidecar: approach.${k} '${id}' must be a vanilla block id`);
        else if (want === 'floor' && !isFloor(normalize(id))) err(`sidecar: approach.${k} '${id}' must be a block to walk on (a full block or a path)`);
        else if (want === 'slab' && BLOCKS[id].family !== 'slab') err(`sidecar: approach.${k} '${id}' must be a slab`);
      }
    }
  }
  if (errors.length) return { ok: false, errors, warnings };

  const g = makeGrid(cells, size, sidecar.groundY);

  // ---- anchors: entrance + spawn, standable
  const anchors = sidecar.anchors ?? {};
  for (const n of ['entrance', 'spawn']) if (!anchors[n]) err(`missing required anchor '${n}'`);
  for (const [n, a] of Object.entries(anchors)) {
    for (const f of ['x', 'y', 'z', 'yaw', 'pitch']) if (typeof a[f] !== 'number' || !Number.isFinite(a[f])) err(`anchor ${n}: '${f}' must be a finite number`);
  }
  const cellOf = (a) => [Math.floor(a.x), Math.floor(a.y + 1e-6), Math.floor(a.z)];
  for (const n of ['entrance', 'spawn']) {
    const a = anchors[n];
    if (!a || !Number.isFinite(a.x)) continue;
    const [x, y, z] = cellOf(a);
    if (!g.inBox(x, y, z)) { err(`anchor ${n} (${a.x},${a.y},${a.z}) is outside the template`); continue; }
    if (!Number.isInteger(a.y)) warn(`anchor ${n}: y ${a.y} is not on a block boundary`);
    const below = g.at(x, y - 1, z);
    if (!g.floor(x, y - 1, z)) err(`anchor ${n}: no solid block to stand on (${below ? below.name : 'nothing written'} at ${fmt(x, y - 1, z)})`);
    for (const [dy, part] of [[0, 'feet'], [1, 'head']]) {
      if (!g.free(x, y + dy, z)) err(`anchor ${n}: ${part} cell ${fmt(x, y + dy, z)} is ${g.at(x, y + dy, z)?.name ?? 'solid'} (needs air or a non-colliding block)`);
    }
  }

  // ---- doors (closed, iron doors with buttons) and an outside door
  const outside = outsideFlood(g);
  const doors = doorCheck(g);
  errors.push(...doors.errors);
  const outsideDoors = doors.doors.filter(({ x, y, z, state }) => {
    const [fx, fz] = H_VEC[state.props.facing];
    return [[fx, fz], [-fx, -fz]].some(([dx, dz]) => outside.has(fmt(x + dx, y, z + dz)) || outside.has(fmt(x + dx, y + 1, z + dz)));
  });
  if (!outsideDoors.length && sidecar.type !== 'barn') err('no outside door: a building needs at least one closed door to the outside on its front');

  // ---- light: every standable interior cell gets block light >= 1 from vanilla sources
  if (w) {
    const light = lightLevels(g);
    const dark = interiorCells(w).filter(([x, y, z]) => g.standable(x, y, z) && light(x, y, z) < 1).map(([x, y, z]) => fmt(x, y, z));
    if (dark.length) err(`light: ${dark.length} standable interior cell(s) get no block light (mobs spawn there at night), e.g. ${dark.slice(0, 6).join('; ')}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Check a Blueprint object (serialised exactly as write.mjs would). */
export function checkBlueprint(bp, opts) {
  const structure = plain(bp.toStructure());
  const sidecar = JSON.parse(JSON.stringify(bp.sidecar()));
  return checkStructure(sidecar, structure, opts);
}

/** Check written files. */
export function checkFiles(nbtPath, jsonPath, opts) {
  let structure;
  let sidecar;
  try { structure = plain(parse(fs.readFileSync(nbtPath))); } catch (e) { return { ok: false, errors: [`${nbtPath}: cannot parse NBT: ${e.message}`], warnings: [] }; }
  try { sidecar = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { return { ok: false, errors: [`${jsonPath}: cannot parse JSON: ${e.message}`], warnings: [] }; }
  return checkStructure(sidecar, structure, opts);
}
