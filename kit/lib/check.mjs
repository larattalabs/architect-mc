// Blueprint checker: validates a structure template + its sidecar against docs/CONTRACT.md "Checker profiles".
//   checkFiles(nbtPath, jsonPath, opts) / checkBlueprint(bp, opts) / checkStructure(sidecar, structure, opts)
//     -> { ok, errors: string[], warnings: string[] }
//   opts: { max?: {x,y,z}, type?: string, imported?: boolean, profile?: string[]|'massing', massing?: <massing sidecar> }
// The `massing` profile (phase 4c) applies to a sidecar with `massing: true` (or when opts.profile is 'massing'): the
// structure, palette, sidecar, anchor and size rules, no floating, parts, and the entrance reaching into the building; no
// door, light, interior or type-geometry rules. opts.massing (a massing's sidecar) adds massing conformance
// (lib/massing.mjs checkConformance): its errors join the errors, its issues the warnings (prefixed `massing:`), and the
// result gets `conformance: { ok, errors, issues }`.
// `imported` (an .nbt the player built and saved, docs/CONTRACT.md "Import / export"): the rules inherited from
// AgentCraft about how the building works (anchors, doors, light) and the size-vs-extent match become warnings; the
// structure format, palette validity (vanilla blocks with valid properties), the sidecar and --max stay errors.
// Unknown / non-vanilla blocks are then reported as one error listing every id with its block count.
// Ported from AgentCraft's tools/blueprints/lib/check.mjs (MIT, see LICENSE): the office rules are gone, the light,
// door and anchor rules stay errors; the rules new in Architect are warnings in phase 1.
import fs from 'node:fs';
import { parse, plain } from './nbt.mjs';
import {
  BLOCKS, collisionOf, normalize, emissionOf, opticsOf, voxelsOf, faceMask, lightCost, isConductor, isFloor,
  isPassable, isClimbable, supportOf, topOf,
} from './blocks.mjs';
import { BUILDING_TYPES, CORE_ROLES, DEFAULT_PROFILE, fullBlockOf, PORT_KINDS, TYPE_RE, isPresetType, parseProfile, resolvePalette, stoneFamilyOf, woodFamilyOf } from './kit.mjs';
import { checkConformance } from './massing.mjs';

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
 * @param {{max?:{x:number,y:number,z:number}, type?:string, imported?:boolean}} [opts]
 */
/**
 * Ports (docs/CONTRACT.md phase 4a, R5): a list of {name, kind, x, y, z, facing}; unique names, a known kind or
 * `<modid>:<kind>`, an integer cell inside the template, a horizontal facing. Returns the error lines.
 */
export function checkPorts(ports, size) {
  if (ports === undefined) return [];
  if (!Array.isArray(ports)) return ['ports: must be a list of {name, kind, x, y, z, facing}'];
  const out = [];
  const names = new Set();
  for (const [i, p] of ports.entries()) {
    const at = `port ${p && typeof p.name === 'string' && p.name ? `'${p.name}'` : `#${i}`}`;
    if (!p || typeof p !== 'object') { out.push(`${at}: must be an object`); continue; }
    if (typeof p.name !== 'string' || !/^[a-z0-9_][a-z0-9_.-]*$/.test(p.name)) out.push(`${at}: name must match [a-z0-9_][a-z0-9_.-]*`);
    else if (names.has(p.name)) out.push(`${at}: the name is used twice`);
    else names.add(p.name);
    if (!(PORT_KINDS.includes(p.kind) || /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(p.kind ?? ''))) {
      out.push(`${at}: kind '${p.kind}' must be one of ${PORT_KINDS.join(', ')} or <modid>:<kind>`);
    }
    if (!['north', 'south', 'east', 'west'].includes(p.facing)) out.push(`${at}: facing '${p.facing}' must be horizontal (north, south, east, west)`);
    const xyz = [p.x, p.y, p.z];
    if (!xyz.every(Number.isInteger)) out.push(`${at}: x, y, z must be integers`);
    else if (Array.isArray(size) && xyz.some((v, a) => v < 0 || v >= size[a])) out.push(`${at}: cell ${xyz.join(',')} is outside the template (${size.join('x')})`);
  }
  return out;
}

export function checkStructure(sidecar, structure, opts = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);
  const imported = !!opts.imported;
  /** an inherited "does the building work" rule: an error, or a warning for an imported structure */
  const inherited = imported ? (m) => warn(`imported: ${m}`) : err;
  /** imported: unknown block id -> palette indexes (reported once, with block counts) */
  const unknownIds = new Map();

  // ---- structure format
  if (!Number.isInteger(structure.DataVersion)) err('structure: DataVersion missing / not an int');
  const size = structure.size;
  if (!Array.isArray(size) || size.length !== 3 || !size.every(Number.isInteger)) err('structure: size must be a list of 3 ints');
  if (!Array.isArray(structure.palette)) err('structure: palette missing');
  if (!Array.isArray(structure.blocks)) err('structure: blocks missing');
  if (!Array.isArray(structure.entities)) err('structure: entities missing (must be an empty list)');
  else if (structure.entities.length) (imported ? warn : err)(`structure: entities must be empty (${structure.entities.length} found)`);
  if (errors.length) return { ok: false, errors, warnings, metrics: null };

  // ---- palette: vanilla blocks only, every property explicit and valid
  let defaulted = 0;
  const palette = structure.palette.map((p, i) => {
    // (imports: a save older than 26.3 may use the Name / Properties keys)
    let props = p.properties ?? (imported ? p.Properties : undefined) ?? {};
    const name = p.id ?? (imported ? p.Name : undefined);
    if (typeof name !== 'string' || !name.includes(':')) { err(`palette[${i}]: bad id '${name}'`); return { name: String(name), props }; }
    if (imported && !BLOCKS[name]) { unknownIds.set(name, [...(unknownIds.get(name) ?? []), i]); return { name, props }; }
    if (!name.startsWith('minecraft:')) { err(`palette[${i}]: '${name}' is not a vanilla block (templates use minecraft: blocks only)`); return { name, props }; }
    if (!BLOCKS[name]) { err(`palette[${i}]: unknown block '${name}' (not a vanilla 26.3 block)`); return { name, props }; }
    for (const v of Object.values(props)) if (typeof v !== 'string') err(`palette[${i}] ${name}: property values must be strings`);
    try {
      const full = normalize(name, props);
      const missing = Object.keys(full.props).filter((k) => !(k in props));
      // imported: a missing property takes its default when the game loads the template
      if (imported && missing.length) { defaulted++; props = full.props; }
      else for (const k of missing) err(`palette[${i}] ${name}: property '${k}' not written explicitly`);
    } catch (e) {
      err(`palette[${i}]: ${e.message}`);
    }
    return { name, props };
  });

  if (defaulted) warn(`imported: ${defaulted} palette entr${defaulted === 1 ? 'y has' : 'ies have'} properties not written (they take their defaults)`);

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
  if (unknownIds.size) {
    const count = new Map();
    const owner = new Map([...unknownIds].flatMap(([n, idx]) => idx.map((i) => [i, n])));
    for (const b of structure.blocks) { const n = owner.get(b.state); if (n) count.set(n, (count.get(n) ?? 0) + 1); }
    const list = [...unknownIds.keys()].sort((a, b) => (count.get(b) ?? 0) - (count.get(a) ?? 0) || (a < b ? -1 : 1));
    err(`unknown or non-vanilla blocks (${list.length}): ${list.map((n) => `${n} x${count.get(n) ?? 0}`).join(', ')} (Architect places vanilla 26.3 blocks only: replace them and save the structure again)`);
  }
  if (cells.size) {
    const extent = max.map((m, a) => m - min[a] + 1);
    if (min.some((m) => m !== 0) || extent.some((e, a) => e !== size[a])) {
      (imported && min.every((m) => m >= 0) && max.every((m, a) => m < size[a]) ? warn : err)(`size ${size.join('x')} does not match block extents ${extent.join('x')} (min ${min.join(',')})`);
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
  if (sidecar.type !== undefined && !(typeof sidecar.type === 'string' && TYPE_RE.test(sidecar.type))) err(`sidecar: type '${sidecar.type}' must be a preset (${BUILDING_TYPES.join(', ')}) or an open type matching ${TYPE_RE}`);
  if (opts.type && sidecar.type !== opts.type) err(`sidecar: type '${sidecar.type}' but the request asked for '${opts.type}'`);
  // phase 4c: a massing is checked with the massing profile only
  const isMassing = sidecar.massing === true || opts.profile === 'massing';
  if (sidecar.massing !== undefined && sidecar.massing !== true) err('sidecar: massing must be true or absent');
  if (opts.profile === 'massing' && sidecar.massing !== true) err('sidecar: the request asked for a massing, but the sidecar has no massing: true (build it with lib/massing.mjs massing(bp), or new Blueprint({ massing: true }))');
  // open types (R4): a non-preset type is checked with its profile's rules; preset types keep their own profiles
  const open = !isMassing && typeof sidecar.type === 'string' && !isPresetType(sidecar.type);
  let prof = null;
  if (sidecar.profile !== undefined) {
    try { parseProfile(sidecar.profile); } catch (e) { err(`sidecar: ${e.message}`); }
  }
  if (opts.profile !== undefined && opts.profile !== 'massing' && open) {
    const want = parseProfile(opts.profile).list;
    if (JSON.stringify(sidecar.profile ?? null) !== JSON.stringify(want)) err(`sidecar: profile ${JSON.stringify(sidecar.profile ?? null)} but the request asked for ${JSON.stringify(want)} (set \`profile\` on the Blueprint)`);
  }
  if (open) {
    try { prof = parseProfile(sidecar.profile ?? opts.profile ?? DEFAULT_PROFILE); } catch { prof = parseProfile(DEFAULT_PROFILE); }
  }
  /** does this building get rule `r` (a preset type: every rule of its own profile, as before 4b) */
  const rule = (r) => (isMassing ? r === 'no_floating' : !open || prof.rules.has(r));
  const needsInterior = open ? ['interior', 'lit', 'floors_reachable', 'roof_closed', 'min_interior_volume'].filter((r) => prof.rules.has(r)) : [];
  if (!(sidecar.front in H_VEC)) err(`sidecar: front '${sidecar.front}' invalid`);
  if (sidecar.size && (sidecar.size.x !== size[0] || sidecar.size.y !== size[1] || sidecar.size.z !== size[2])) {
    err(`sidecar size ${sidecar.size?.x}x${sidecar.size?.y}x${sidecar.size?.z} != structure size ${size.join('x')}`);
  }
  if (!(Number.isInteger(sidecar.groundY) && sidecar.groundY >= 1 && sidecar.groundY < size[1])) err('sidecar: groundY must be an int inside the template (>= 1: the floor row is groundY-1)');
  for (const m of checkPorts(sidecar.ports, size)) err(m);
  if (sidecar.ext !== undefined && !(sidecar.ext && typeof sidecar.ext === 'object' && !Array.isArray(sidecar.ext))) err('sidecar: ext must be an object');
  if (sidecar.tags !== undefined && !(Array.isArray(sidecar.tags) && sidecar.tags.every((t) => typeof t === 'string'))) err('sidecar: tags must be a list of strings');
  if (sidecar.materials !== undefined && !(Array.isArray(sidecar.materials) && sidecar.materials.every((t) => typeof t === 'string' && BLOCKS[t]))) err('sidecar: materials must be a list of vanilla block ids');
  const w = sidecar.interior ?? null;
  // without an interior the light rule (an error) would be skipped: every type but custom declares one
  if (!w && !open && !isMassing && sidecar.type !== 'custom') err(`sidecar: interior is required for type '${sidecar.type}' (the box agents and players live in; only 'custom' may omit it)`);
  if (!w && open && needsInterior.length) err(`sidecar: interior is required: the profile of '${sidecar.type}' has ${needsInterior.join(', ')}`);
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
  if (errors.length) return { ok: false, errors, warnings, metrics: null };

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
    // outside the template is fine near it (e.g. spawn on the approach strip): there, rows below groundY are terrain
    const [sx, sy, sz] = size;
    if (y < 1 || y >= sy || x < -16 || z < -16 || x >= sx + 16 || z >= sz + 16) { err(`anchor ${n} (${a.x},${a.y},${a.z}) is too far outside the template`); continue; }
    if (!Number.isInteger(a.y)) warn(`anchor ${n}: y ${a.y} is not on a block boundary`);
    const below = g.at(x, y - 1, z);
    if (!g.floor(x, y - 1, z)) inherited(`anchor ${n}: no solid block to stand on (${below ? below.name : 'nothing written'} at ${fmt(x, y - 1, z)})`);
    for (const [dy, part] of [[0, 'feet'], [1, 'head']]) {
      if (!g.free(x, y + dy, z)) inherited(`anchor ${n}: ${part} cell ${fmt(x, y + dy, z)} is ${g.at(x, y + dy, z)?.name ?? 'solid'} (needs air or a non-colliding block)`);
    }
  }

  // ---- doors (closed, iron doors with buttons) and an outside door
  const outside = outsideFlood(g);
  const doors = doorCheck(g);
  for (const m of doors.errors) inherited(m);
  const outsideDoors = doors.doors.filter(({ x, y, z, state }) => {
    const [fx, fz] = H_VEC[state.props.facing];
    return [[fx, fz], [-fx, -fz]].some(([dx, dz]) => outside.has(fmt(x + dx, y, z + dz)) || outside.has(fmt(x + dx, y + 1, z + dz)));
  });
  if (!outsideDoors.length && sidecar.type !== 'barn' && rule('door')) inherited('no outside door: a building needs at least one closed door to the outside on its front');

  // ---- light: every standable interior cell gets block light >= 1 from vanilla sources
  if (w && rule('lit')) {
    const light = lightLevels(g);
    const dark = interiorCells(w).filter(([x, y, z]) => g.standable(x, y, z) && light(x, y, z) < 1).map(([x, y, z]) => fmt(x, y, z));
    if (dark.length) inherited(`light: ${dark.length} standable interior cell(s) get no block light (mobs spawn there at night), e.g. ${dark.slice(0, 6).join('; ')}`);
  }

  // ================================================================ rules new in Architect: warnings in phase 1
  const ctx = { g, sidecar, anchors, interior: w, outside, doors: doors.doors, outsideDoors, imported, open, prof, rule, isMassing };
  for (const rule of NEW_RULES) {
    try { warnings.push(...rule(ctx)); } catch (e) { warnings.push(`checker: rule ${rule.name} failed: ${e.message}`); }
  }

  // ---- metrics (phase 5a) and, against a bible's restraint, the `restraint:` warnings
  let metrics = null;
  try { metrics = computeMetrics(g, sidecar, outside); } catch (e) { warn(`checker: metrics failed: ${e.message}`); }
  if (opts.restraint) warnings.push(...restraintWarnings(metrics, opts.restraint));

  // ---- massing conformance (phase 4c): the size cap is an error, the rest warnings
  let conformance;
  if (opts.massing !== undefined) {
    const c = checkConformance(sidecar, opts.massing);
    conformance = { ok: c.ok, errors: c.errors, issues: c.issues };
    for (const m of c.errors) err(`massing: ${m}`);
    for (const m of c.issues) warn(`massing: ${m}`);
  }

  return { ok: errors.length === 0, errors, warnings, metrics, ...(conformance ? { conformance } : {}) };
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
  try { structure = plain(parse(fs.readFileSync(nbtPath))); } catch (e) { return { ok: false, errors: [`${nbtPath}: cannot parse NBT: ${e.message}`], warnings: [], metrics: null }; }
  try { sidecar = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { return { ok: false, errors: [`${jsonPath}: cannot parse JSON: ${e.message}`], warnings: [], metrics: null }; }
  return checkStructure(sidecar, structure, opts);
}

// ==================================================================== new rules (phase 1: warnings)

const HORIZ4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/** Minimum interior volume (free cells inside `interior`) per type. */
export const MIN_VOLUME = { cabin: 60, cottage: 80, house: 120, shop: 80, smithy: 80, tavern: 250, chapel: 150 };

/**
 * A player walking: feet cells (x,y,z) where the body (feet + head) fits through passable blocks (doors open,
 * ladders climb), standing on a floor (full blocks, top slabs, stairs, near-full blocks; a bottom slab counts too,
 * as a half step) or on/in a climbable block. Moves: to a horizontal neighbour up 1 (a jump needs headroom, unless
 * the target rests on stairs or a bottom slab or we are climbing), level, or down up to 3; up and down ladders.
 */
export function walker(g, margin = 0) {
  const [sx, sy, sz] = g.size;
  // the walk may leave the template by `margin` cells (the ground around it: terrain below groundY, air above)
  const inArea = (x, y, z) => y >= 1 && y < sy && x >= -margin && z >= -margin && x < sx + margin && z < sz + margin;
  const pass = (x, y, z) => {
    const c = g.at(x, y, z);
    if (c) return isPassable(c);
    return !g.terrain(x, y, z);
  };
  const climb = (x, y, z) => isClimbable(g.at(x, y, z));
  const familyAt = (x, y, z) => BLOCKS[g.at(x, y, z)?.name]?.family;
  const halfStep = (x, y, z) => familyAt(x, y, z) === 'stairs' || (familyAt(x, y, z) === 'slab' && g.at(x, y, z).props.type === 'bottom');
  const support = (x, y, z) => g.floor(x, y, z) || (familyAt(x, y, z) === 'slab');
  const feet = (x, y, z) => inArea(x, y, z) && pass(x, y, z) && pass(x, y + 1, z)
    && (support(x, y - 1, z) || climb(x, y, z) || climb(x, y - 1, z));
  /** standing (not just hanging on a ladder) */
  const stands = (x, y, z) => inArea(x, y, z) && pass(x, y, z) && pass(x, y + 1, z) && support(x, y - 1, z);
  function reach(start) {
    const seen = new Set();
    if (!start || !feet(...start)) return seen;
    const q = [start];
    seen.add(fmt(...start));
    for (let i = 0; i < q.length; i++) {
      const [x, y, z] = q[i];
      const next = [];
      if (climb(x, y, z) || climb(x, y + 1, z)) next.push([x, y + 1, z]);
      if (climb(x, y, z) || climb(x, y - 1, z)) next.push([x, y - 1, z]);
      for (const [dx, dz] of HORIZ4) {
        const nx = x + dx; const nz = z + dz;
        if (feet(nx, y + 1, nz) && (pass(x, y + 2, z) || halfStep(nx, y, nz) || climb(x, y, z))) next.push([nx, y + 1, nz]);
        for (let dy = 0; dy >= -3; dy--) {
          if (feet(nx, y + dy, nz)) { next.push([nx, y + dy, nz]); break; }
          if (!(pass(nx, y + dy, nz) && pass(nx, y + dy + 1, nz))) break; // no falling through a block
        }
      }
      for (const n of next) {
        const k = fmt(...n);
        if (seen.has(k) || !feet(...n)) continue;
        seen.add(k);
        q.push(n);
      }
    }
    return seen;
  }
  return { feet, stands, reach, pass };
}

/**
 * The floor levels of the interior: feet rows with at least max(4, 30% of the interior's footprint) standing cells
 * (all of them in a tiny interior), so table tops, barrels and stair steps stay below that.
 */
export function floorLevels(g, w, wk = walker(g)) {
  const area = (w.maxX - w.minX + 1) * (w.maxZ - w.minZ + 1);
  const min = Math.min(area, Math.max(4, Math.ceil(area * 0.3)));
  const levels = [];
  for (let y = w.minY; y <= w.maxY; y++) {
    const cells = [];
    for (let z = w.minZ; z <= w.maxZ; z++) for (let x = w.minX; x <= w.maxX; x++) if (wk.stands(x, y, z)) cells.push(fmt(x, y, z));
    if (cells.length >= min) levels.push({ y, cells });
  }
  return levels;
}

const startOf = (a) => (a ? [Math.floor(a.x), Math.floor(a.y + 1e-6), Math.floor(a.z)] : null);
const sample = (list, n = 5) => list.slice(0, n).join('; ') + (list.length > n ? '; ...' : '');

/** Nothing floating: every block connects to the ground through other blocks (attachables through their support). */
function floating({ g, rule }) {
  if (!rule('no_floating')) return [];
  const nodes = [];
  for (const [k, c] of g.cells) {
    const fam = BLOCKS[c.name]?.family;
    if (fam === 'air' || fam === 'liquid' || fam === 'fire') continue;
    nodes.push([k, c]);
  }
  const connected = new Set();
  const structural = new Set(nodes.filter(([, c]) => supportOf(c) === null).map(([k]) => k));
  const q = [];
  for (const k of structural) {
    const [x, y, z] = unfmt(k);
    if (y <= g.groundY - 1 || g.terrain(x, y - 1, z)) { connected.add(k); q.push([x, y, z]); }
  }
  for (let i = 0; i < q.length; i++) {
    const [x, y, z] = q[i];
    for (const [, dx, dy, dz] of DIRS6) {
      const k = fmt(x + dx, y + dy, z + dz);
      if (structural.has(k) && !connected.has(k)) { connected.add(k); q.push([x + dx, y + dy, z + dz]); }
    }
  }
  const attach = nodes.filter(([k]) => !structural.has(k));
  for (let changed = true; changed;) {
    changed = false;
    for (const [k, c] of attach) {
      if (connected.has(k)) continue;
      const [x, y, z] = unfmt(k);
      if (supportOf(c).some(([dx, dy, dz]) => connected.has(fmt(x + dx, y + dy, z + dz)) || g.terrain(x + dx, y + dy, z + dz))) { connected.add(k); changed = true; }
    }
  }
  const loose = nodes.filter(([k]) => !connected.has(k)).map(([k, c]) => `${c.name.replace('minecraft:', '')} at ${k}`);
  return loose.length ? [`floating: ${loose.length} block(s) not connected to the ground (attachables count through their support), e.g. ${sample(loose)}`] : [];
}

/** A door on the front face that the entrance reaches; every interior floor level reachable from the entrance. */
function reachability({ g, sidecar, anchors, interior: w, outside, outsideDoors, rule }) {
  const out = [];
  if (!rule('door') && !rule('floors_reachable')) return out;
  const wk = walker(g, (sidecar.approach?.length ?? 4) + 2);
  const reached = wk.reach(startOf(anchors.entrance));
  const [fx, fz] = H_VEC[sidecar.front];
  // a door on the front face: its outward side (front) is outside
  const front = outsideDoors.filter(({ x, y, z, state }) => {
    const [dx, dz] = H_VEC[state.props.facing];
    return Math.abs(dx) === Math.abs(fx) && Math.abs(dz) === Math.abs(fz)
      && (outside.has(fmt(x + fx, y, z + fz)) || outside.has(fmt(x + fx, y + 1, z + fz)));
  });
  const frontReached = front.filter(({ x, y, z }) => [0, 1, -1].some((dy) => reached.has(fmt(x + fx, y + dy, z + fz))));
  const opening = sidecar.type === 'barn' && barnOpening(g, sidecar, w);
  if (!opening && rule('door')) {
    if (!front.length) out.push(`doors: no outside door on the ${sidecar.front} (front) face`);
    else if (!frontReached.length) out.push(`doors: the front door${front.length > 1 ? 's' : ''} at ${front.map((d) => fmt(d.x, d.y, d.z)).join('; ')} cannot be walked to from the entrance`);
  }
  if (w && rule('floors_reachable')) {
    const levels = floorLevels(g, w, wk);
    if (!levels.length) out.push('reachability: the interior has no floor level (no row with enough standing room)');
    let ok = 0;
    for (const L of levels) {
      const n = L.cells.filter((k) => reached.has(k)).length;
      if (n === 0) out.push(`reachability: floor level y=${L.y} (${L.cells.length} cells) cannot be reached from the entrance (walking, max step 1: stairs, ladders, slabs)`);
      else if (n < L.cells.length / 2) out.push(`reachability: only ${n} of ${L.cells.length} cells of floor level y=${L.y} can be reached from the entrance`);
      if (n >= L.cells.length / 2) ok++;
    }
    if (sidecar.type === 'tower' && ok < 3) out.push(`tower: ${ok} floor level(s) reachable, a tower needs at least 3`);
  }
  return out;
}

/** The interior is enclosed: walls without gaps and a roof over every cell (any block above counts as cover). */
function enclosure({ g, sidecar, interior: w, rule }) {
  if (!w || !rule('roof_closed')) return [];
  const out = [];
  const sy = g.size[1];
  const open = [];
  const unwritten = [];
  for (const [x, y, z] of interiorCells(w)) {
    if (!g.cells.has(fmt(x, y, z))) unwritten.push(fmt(x, y, z));
    if (!g.free(x, y, z)) continue;
    let covered = false;
    for (let yy = y + 1; yy < sy && !covered; yy++) {
      const c = g.at(x, yy, z);
      if (c && BLOCKS[c.name]?.family !== 'air') covered = true;
    }
    if (!covered) open.push(fmt(x, y, z));
  }
  if (open.length) out.push(`enclosure: ${open.length} interior cell(s) open to the sky (no roof above), e.g. ${sample(open)}`);
  if (unwritten.length) out.push(`interior: ${unwritten.length} cell(s) not written (write interior air explicitly so placement clears it), e.g. ${sample(unwritten)}`);
  if (sidecar.type !== 'barn') {
    const walls = outsideFlood(g, w.maxY);
    const inW = (x, y, z) => x >= w.minX && x <= w.maxX && y >= w.minY && y <= w.maxY && z >= w.minZ && z <= w.maxZ;
    const gaps = interiorCells(w).filter(([x, y, z]) => walls.has(fmt(x, y, z)));
    if (gaps.length) {
      const entries = gaps.map(([x, y, z]) => fmt(x, y, z)).filter((k) => !inW(...unfmt(walls.get(k))));
      out.push(`enclosure: ${gaps.length} interior cell(s) reachable from outside through the walls (a gap, or a doorway without a door), entering at ${sample(entries, 4)}`);
    }
  }
  return out;
}

/** A barn's entrance: a run of >= 3 cells across the front wall, open (or doors / gates) for 3 rows from the ground. */
function barnOpening(g, sidecar, w) {
  if (!w) return false;
  const wk = walker(g);
  const f = sidecar.front;
  const alongX = f === 'north' || f === 'south';
  const plane = f === 'south' ? w.maxZ + 1 : f === 'north' ? w.minZ - 1 : f === 'east' ? w.maxX + 1 : w.minX - 1;
  const [u0, u1] = alongX ? [w.minX - 1, w.maxX + 1] : [w.minZ - 1, w.maxZ + 1];
  let run = 0;
  for (let u = u0; u <= u1; u++) {
    const ok = [0, 1, 2].every((dy) => wk.pass(...(alongX ? [u, g.groundY + dy, plane] : [plane, g.groundY + dy, u])));
    run = ok ? run + 1 : 0;
    if (run >= 3) return true;
  }
  return false;
}

/** Profile geometry: tower proportions, the barn's big entrance, the gatehouse passage, interior volume. */
function profile(ctx) {
  if (ctx.isMassing) return [];
  if (ctx.open) return openProfile(ctx);
  const { g, sidecar, interior: w } = ctx;
  const out = [];
  const t = sidecar.type;
  if (t === 'tower') {
    if (!w) out.push('tower: no interior declared (needed to measure the footprint and the floors)');
    else {
      const side = Math.min(w.maxX - w.minX + 3, w.maxZ - w.minZ + 3);
      let top = -1;
      for (const [k, c] of g.cells) if (BLOCKS[c.name]?.family !== 'air') top = Math.max(top, unfmt(k)[1]);
      const h = top - g.groundY + 1;
      if (h < 2 * side) out.push(`tower: ${h} blocks tall above the ground on a ${side}-wide footprint (a tower is at least 2 x its smaller side: ${2 * side})`);
    }
  }
  if (t === 'barn' && !barnOpening(g, sidecar, w)) out.push(`barn: no entrance at least 3 wide and 3 tall on the ${sidecar.front} face (a door or an open arch)`);
  if (t === 'gatehouse') {
    const best = widestPassage(g, sidecar.front, 3);
    if (best < 3) out.push(`gatehouse: no passage through the building front to back at least 3 wide and 3 tall (widest: ${best})`);
  }
  if (MIN_VOLUME[t] !== undefined) {
    if (!w) out.push(`${t}: no interior declared`);
    else {
      const vol = interiorCells(w).filter(([x, y, z]) => g.free(x, y, z)).length;
      if (vol < MIN_VOLUME[t]) out.push(`${t}: interior volume ${vol} is under the ${MIN_VOLUME[t]} a ${t} needs`);
    }
  }
  return out;
}

/**
 * Palette families (phase 2: a warning): every wood and stone family the template uses comes from its palette, so a
 * palette swap re-skins the whole building. Without a recorded `palette` (imports, phase 1 entries) there is nothing to
 * compare with.
 */
function paletteFamilies({ g, sidecar }) {
  if (!sidecar.palette) return [];
  let p;
  try { p = resolvePalette(sidecar.palette); } catch (e) { return [`palette: the sidecar's palette is invalid: ${e.message}`]; }
  const { woods, stones } = paletteFamilySets(p);
  const off = new Map(); // "wood 'oak'" -> { blocks, n }
  for (const c of g.cells.values()) {
    const wf = woodFamilyOf(c.name);
    const sf = stoneFamilyOf(c.name);
    const k = wf && !woods.has(wf) ? `wood '${wf}'` : sf && !stones.has(sf) ? `stone family '${sf}'` : null;
    if (!k) continue;
    const e = off.get(k) ?? { blocks: new Set(), n: 0 };
    e.blocks.add(c.name.replace('minecraft:', ''));
    e.n++;
    off.set(k, e);
  }
  return [...off].map(([k, e]) => `palette: ${e.n} block(s) of ${k} (${[...e.blocks].slice(0, 4).join(', ')}) not from the palette (woods ${[...woods].join('/')}; stone ${[...stones].join('/')}): read them from the palette so a palette swap changes them too`);
}

/**
 * Blocks survival can't build (docs/CONTRACT.md phase 3 "Materials", the obtainability map): a survival world refuses to
 * place a design that uses one. Keep in sync with creativeOnly in mod/src/main/resources/data/architect_mc/survival_items.json.
 */
export const SURVIVAL_CREATIVE_ONLY = new Set(['bedrock', 'barrier', 'light', 'structure_block', 'structure_void', 'jigsaw', 'test_block',
  'test_instance_block', 'command_block', 'chain_command_block', 'repeating_command_block', 'spawner', 'trial_spawner', 'vault',
  'budding_amethyst', 'reinforced_deepslate', 'end_portal_frame', 'end_portal', 'end_gateway', 'nether_portal', 'petrified_oak_slab',
  'infested_stone', 'infested_cobblestone', 'infested_stone_bricks', 'infested_mossy_stone_bricks', 'infested_cracked_stone_bricks',
  'infested_chiseled_stone_bricks', 'infested_deepslate', 'suspicious_sand', 'suspicious_gravel', 'frogspawn', 'chorus_plant', 'player_head',
  'player_wall_head'].map((b) => `minecraft:${b}`));

/** Survival (phase 3: a warning): the design uses blocks survival can't build, so a survival world refuses to place it. */
function survival({ g, sidecar }) {
  const n = new Map();
  const add = (id) => n.set(id, (n.get(id) ?? 0) + 1);
  for (const c of g.cells.values()) if (SURVIVAL_CREATIVE_ONLY.has(c.name)) add(c.name);
  if (SURVIVAL_CREATIVE_ONLY.has(sidecar.foundationBlock)) add(sidecar.foundationBlock);
  for (const k of ['block', 'slab']) if (SURVIVAL_CREATIVE_ONLY.has(sidecar.approach?.[k])) add(sidecar.approach[k]);
  return [...n].map(([b, c]) => `survival: this design uses ${b.replace('minecraft:', '')} (${c} block${c === 1 ? '' : 's'}), which survival can't build: a survival world refuses to place it`);
}

/** The widest run of columns with a walkable passage, front to back, `h` cells tall (the gatehouse rule). */
function widestPassage(g, front, h) {
  const [sx, , sz] = g.size;
  const wk = walker(g);
  const alongZ = front === 'south' || front === 'north';
  const n = alongZ ? sx : sz;
  const depth = alongZ ? sz : sx;
  let run = 0;
  let best = 0;
  for (let u = 0; u < n; u++) {
    let ok = true;
    for (let d = 0; d < depth && ok; d++) for (let dy = 0; dy < h && ok; dy++) ok = wk.pass(...(alongZ ? [u, g.groundY + dy, d] : [d, g.groundY + dy, u]));
    run = ok ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/** An open type's profile geometry (R4): tall:<ratio>, passage:<w>x<h>, min_interior_volume:<n>. */
function openProfile({ g, sidecar, interior: w, prof }) {
  const out = [];
  const t = sidecar.type;
  if (prof.tall !== undefined) {
    if (!w) out.push(`${t}: tall:${prof.tall} needs an interior (to measure the footprint)`);
    else {
      const side = Math.min(w.maxX - w.minX + 3, w.maxZ - w.minZ + 3);
      let top = -1;
      for (const [k, c] of g.cells) if (BLOCKS[c.name]?.family !== 'air') top = Math.max(top, unfmt(k)[1]);
      const h = top - g.groundY + 1;
      if (h < prof.tall * side) out.push(`${t}: ${h} blocks tall above the ground on a ${side}-wide footprint (tall:${prof.tall} wants at least ${Math.ceil(prof.tall * side)})`);
    }
  }
  if (prof.passage) {
    const best = widestPassage(g, sidecar.front, prof.passage.h);
    if (best < prof.passage.w) out.push(`${t}: no passage through the building front to back at least ${prof.passage.w} wide and ${prof.passage.h} tall (widest: ${best})`);
  }
  if (prof.minVolume !== undefined && w) {
    const vol = interiorCells(w).filter(([x, y, z]) => g.free(x, y, z)).length;
    if (vol < prof.minVolume) out.push(`${t}: interior volume ${vol} is under the ${prof.minVolume} its profile asks for`);
  }
  return out;
}

/**
 * Named parts (R3, phase 4b: warnings): `parts: { name: { box, cells } }`, at least 2, and at most 20% of the template's
 * cells outside every part. Imports have none (a structure the player built).
 */
function parts({ g, sidecar, imported }) {
  if (imported) return [];
  const out = [];
  const p = sidecar.parts;
  const total = g.cells.size;
  if (p === undefined) return [`parts: no named parts (wrap every major mass in bp.part('<name>', () => { ... }): main, roof, porch, tower, wing_east...; at least 2)`];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['parts: must be an object { name: { box, cells } }'];
  let inParts = 0;
  for (const [n, v] of Object.entries(p)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(n)) out.push(`parts: name '${n}' must match [a-z][a-z0-9_]{0,39}`);
    const box = v?.box;
    if (!Array.isArray(box) || box.length !== 6 || !box.every(Number.isInteger) || box.slice(0, 3).some((b, i) => b < 0 || b > box[i + 3] || box[i + 3] >= g.size[i])) out.push(`parts: ${n}: box must be [x0,y0,z0,x1,y1,z1] inside the template`);
    if (!Number.isInteger(v?.cells) || v.cells < 1) out.push(`parts: ${n}: cells must be a positive integer`);
    else inParts += v.cells;
  }
  const n = Object.keys(p).length;
  if (n < 2) out.push(`parts: ${n} named part${n === 1 ? '' : 's'}; declare at least 2 (every major mass: bp.part('main', ...), bp.part('roof', ...), ...)`);
  const outside = total - inParts;
  if (total > 0 && outside > 0.2 * total) out.push(`parts: ${outside} of ${total} cells (${Math.round((100 * outside) / total)}%) are outside every named part (at most 20%): wrap the rest in bp.part()`);
  return out;
}

/**
 * The massing profile's walking rule (phase 4c, a warning): from the entrance a player walks to spawn and into the
 * building (a cell the outside flood doesn't reach: through a door or an arch).
 */
function massingEntrance({ g, sidecar, anchors, outside, isMassing }) {
  if (!isMassing) return [];
  const out = [];
  const wk = walker(g, (sidecar.approach?.length ?? 4) + 2);
  const reached = wk.reach(startOf(anchors.entrance));
  if (!reached.size) return ['massing: the entrance is not a place to stand (solid ground below, 2 free cells)'];
  const sp = startOf(anchors.spawn);
  if (sp && !reached.has(fmt(...sp))) out.push(`massing: spawn ${fmt(...sp)} cannot be walked to from the entrance`);
  // inside: a cell the outside flood doesn't reach (behind a door), or one under cover with blocks on both sides (an arch, a passage)
  const [sx, sy, sz] = g.size;
  const any = (x, y, z) => { const c = g.at(x, y, z); return !!c && BLOCKS[c.name]?.family !== 'air'; };
  const covered = (x, y, z) => { for (let yy = y + 2; yy < sy; yy++) if (any(x, yy, z)) return true; return false; };
  const sides = (x, y, z, dx, dz) => [1, -1].every((s) => { for (let i = 1; ; i++) { const nx = x + s * i * dx; const nz = z + s * i * dz; if (nx < 0 || nz < 0 || nx >= sx || nz >= sz) return false; if (any(nx, y, nz)) return true; } });
  const inside = [...reached].some((k) => {
    const [x, y, z] = unfmt(k);
    if (!g.inBox(x, y, z)) return false;
    if (!outside.has(k)) return true;
    return covered(x, y, z) && (sides(x, y, z, 1, 0) || sides(x, y, z, 0, 1)) && (sides(x, y + 1, z, 1, 0) || sides(x, y + 1, z, 0, 1));
  });
  if (!inside) out.push('massing: no way into the building from the entrance (put a door or an arch on the front: m.opening(<mass>, front, at, size))');
  return out;
}

const NEW_RULES = [floating, reachability, enclosure, profile, paletteFamilies, survival, parts, massingEntrance, attach, facing];

// ==================================================================== phase 5a: attach and facing rules (warnings)
// Ported from Steward's minecraft-structure-design skill (scripts/attach-lint.mjs), owned by Architect from phase 5a;
// changes are reported to Steward. "Solid" uses the kit's block geometry instead of the skill's name list.

const familyOfCell = (c) => (c ? BLOCKS[c.name]?.family : undefined);
const shortId = (c) => c.name.replace('minecraft:', '');
/** Families that never carry a wall-mounted block, whatever their collision (they open, or are thin). */
const NOT_STURDY = new Set(['door', 'trapdoor', 'fence_gate']);

/**
 * The face of cell (x,y,z) on side `dir` (the side that touches the attached block) is sturdy: terrain below the ground
 * row, a full block (not a door, trapdoor or gate), or a stair / slab whose face on that side is full.
 */
export function sturdyFace(g, x, y, z, dir) {
  const c = g.at(x, y, z);
  if (!c) return g.terrain(x, y, z) || (!g.inBox(x, y, z) && y < g.groundY);
  const f = familyOfCell(c);
  if (NOT_STURDY.has(f)) return false;
  if (f === 'stairs' || f === 'slab') return faceMask(voxelsOf(c), dir) === 15;
  return collisionOf(c) === 'full';
}

/** A cell that closes a passage or backs a bed: terrain, a full block (not a door / trapdoor / gate), or a thin block (pane, bars, fence, wall). */
function wallish(g, x, y, z) {
  const c = g.at(x, y, z);
  if (!c) return g.terrain(x, y, z) || (!g.inBox(x, y, z) && y < g.groundY);
  if (NOT_STURDY.has(familyOfCell(c))) return false;
  const k = collisionOf(c);
  return k === 'full' || k === 'thin';
}

/** What a hanging lantern can hang from besides a sturdy bottom face: chains, fences, walls, bars and panes, rods. */
const HANG_FAMILIES = new Set(['chain', 'fence', 'wall', 'pane', 'rod', 'scaffolding']);
const WALL_MOUNTED = new Set(['ladder', 'wall_torch', 'wall_sign', 'wall_banner']);
const line = (n, what, list) => `${n} ${what}, e.g. ${sample(list)}`;

/**
 * attach (5a, warnings): ladders, wall torches (every kind), wall signs and wall banners have a sturdy block behind them;
 * a door's upper half stands on its lower half; both halves of every bed; hanging lanterns hang from something.
 * A door's lower half without its upper half, and a door written open, are already errors (doorCheck), so attach does
 * not repeat them.
 */
function attach({ g, isMassing }) {
  if (isMassing) return [];
  const support = [];
  const doorHalf = [];
  const bed = [];
  const lantern = [];
  for (const [k, c] of g.cells) {
    const f = familyOfCell(c);
    if (!f) continue;
    const [x, y, z] = unfmt(k);
    const p = c.props ?? {};
    if (WALL_MOUNTED.has(f) && H_VEC[p.facing]) {
      const [dx, dz] = H_VEC[p.facing];
      if (!sturdyFace(g, x - dx, y, z - dz, p.facing)) support.push(`${shortId(c)} at ${k} facing ${p.facing} (behind it: ${g.at(x - dx, y, z - dz) ? shortId(g.at(x - dx, y, z - dz)) : 'nothing'} at ${fmt(x - dx, y, z - dz)})`);
    } else if (f === 'door' && p.half === 'upper') {
      const lo = g.at(x, y - 1, z);
      if (!lo || lo.name !== c.name || lo.props.half !== 'lower') doorHalf.push(`${shortId(c)} at ${k}`);
    } else if (f === 'bed' && H_VEC[p.facing]) {
      const [dx, dz] = H_VEC[p.facing];
      const s = p.part === 'head' ? -1 : 1;
      const o = g.at(x + s * dx, y, z + s * dz);
      const want = p.part === 'head' ? 'foot' : 'head';
      if (!o || o.name !== c.name || o.props.part !== want || o.props.facing !== p.facing) bed.push(`${shortId(c)} ${p.part} at ${k} (no ${want} at ${fmt(x + s * dx, y, z + s * dz)})`);
    } else if (f === 'lantern' && p.hanging === 'true') {
      const up = g.at(x, y + 1, z);
      if (!sturdyFace(g, x, y + 1, z, 'down') && !HANG_FAMILIES.has(familyOfCell(up))) lantern.push(`${shortId(c)} at ${k} (above: ${up ? shortId(up) : 'nothing'})`);
    }
  }
  const out = [];
  if (support.length) out.push(`attach: ${line(support.length, 'wall-mounted block(s) (ladders, wall torches, wall signs, wall banners) with no solid block behind them', support)}`);
  if (doorHalf.length) out.push(`attach: ${line(doorHalf.length, 'door upper half(s) with no lower half below', doorHalf)}`);
  if (bed.length) out.push(`attach: ${line(bed.length, 'bed half(s) without the other half', bed)}`);
  if (lantern.length) out.push(`attach: ${line(lantern.length, 'hanging lantern(s) with nothing above to hang from (a solid block, chain, bars or fence)', lantern)}`);
  return out;
}

/** Stairs that count for the slope rule: bottom half, straight. */
const slopeStair = (c) => !!c && familyOfCell(c) === 'stairs' && c.props.half === 'bottom' && (c.props.shape ?? 'straight') === 'straight';
/** A slope run is at least this many stairs rising one row per horizontal step in one direction. */
export const SLOPE_RUN_MIN = 3;

/**
 * facing (5a, warnings):
 * - doors: the cells in front of and behind a door (along its facing, at both halves) are not solid. A vanilla door's leaf
 *   never leaves its own cell, so "opens into a wall" means the door is turned 90 degrees in its wall (its front and back
 *   are wall blocks) or opens straight onto a block;
 * - beds: the cell beyond the head (head + facing) is a wall (a full or thin block);
 * - slopes: a bottom-half straight stair in a run of at least SLOPE_RUN_MIN stairs that rise one row per step in one
 *   horizontal direction (a roof slope or a staircase), with free space above it, does not face straight down-slope
 *   (a stair faces up-slope, the direction you climb it). Only the reversal is flagged: a stair facing across a run is
 *   usually part of a hip or a crooked eave. Top-half stairs (linings, eaves) and corner shapes are skipped.
 */
function facing({ g, isMassing }) {
  if (isMassing) return [];
  const doors = [];
  const beds = [];
  const slopes = [];
  for (const [k, c] of g.cells) {
    const f = familyOfCell(c);
    const p = c.props ?? {};
    if (!H_VEC[p.facing]) continue;
    const [x, y, z] = unfmt(k);
    const [dx, dz] = H_VEC[p.facing];
    if (f === 'door' && p.half === 'lower') {
      const hit = [];
      for (const s of [1, -1]) for (const dy of [0, 1]) {
        const nx = x + s * dx; const ny = y + dy; const nz = z + s * dz;
        if (wallish(g, nx, ny, nz)) hit.push(`${s === 1 ? 'front' : 'back'} ${fmt(nx, ny, nz)} is ${g.at(nx, ny, nz) ? shortId(g.at(nx, ny, nz)) : 'terrain'}`);
      }
      if (hit.length) doors.push(`${shortId(c)} at ${k} facing ${p.facing}: ${hit[0]}`);
    } else if (f === 'bed' && p.part === 'head') {
      if (!wallish(g, x + dx, y, z + dz)) beds.push(`${shortId(c)} at ${k} facing ${p.facing} (beyond the head: ${g.at(x + dx, y, z + dz) ? shortId(g.at(x + dx, y, z + dz)) : 'air'})`);
    } else if (slopeStair(c) && g.free(x, y + 1, z)) {
      const rising = [];
      for (const [d, [ex, ez]] of Object.entries(H_VEC)) {
        let n = 1;
        for (let i = 1; slopeStair(g.at(x + i * ex, y + i, z + i * ez)); i++) n++;
        for (let i = 1; slopeStair(g.at(x - i * ex, y - i, z - i * ez)); i++) n++;
        if (n >= SLOPE_RUN_MIN) rising.push(d);
      }
      // only the reversal (facing straight down-slope): a stair facing across a run is usually a hip or a crooked eave
      if (rising.length && !rising.includes(p.facing) && rising.includes(OPP[p.facing])) slopes.push(`${shortId(c)} at ${k} facing ${p.facing} on a slope rising ${OPP[p.facing]}`);
    }
  }
  const out = [];
  if (doors.length) out.push(`facing: ${line(doors.length, 'door(s) open into a wall: the cell in front of or behind the door is solid (a door turned 90 degrees in its wall, or one opening onto a block)', doors)}`);
  if (beds.length) out.push(`facing: ${line(beds.length, "bed(s) with the head not against a wall (the cell beyond the head is open)", beds)}`);
  if (slopes.length) out.push(`facing: ${line(slopes.length, 'stair(s) on a slope facing down-slope (a slope stair faces up-slope, the direction you climb it)', slopes)}`);
  return out;
}


// ==================================================================== phase 5a: metrics and restraint
//
// metrics (docs/CONTRACT.md "Bible-set clutter"; numbers, fractions 0..1 rounded to 3 decimals):
// - shell cells: non-air, non-liquid cells 6-adjacent to a cell of the outside flood (outsideFlood: what a player sees from
//   outside). A shell cell is visible from side s (north, south, east, west) when its neighbour on that side is outside.
// - accentShare: among shell cells, without glass, panes, doors, trapdoors and light sources, the share that are accents:
//   blocks of the palette's accent fields (accentPlanks, accentLog, accentStairs, accentSlab, accentFence, and the
//   bible role `accent`) plus blocks in no palette field at all (decor: moss, wool, banners, a bible's extra roles such
//   as vines or moss carpet). A block that is also in a main field (e.g. the roof stairs when the accent wood is the
//   roof wood) counts as main, and so does a stairs / slab / wall of a main block (fullBlockOf). Without a recorded palette: the 4 most-used material families on the shell (a wood, a
//   stone family, else the block without its stairs/slab/wall suffix) are main, everything else counts.
// - detailNoise: per side, over pairs of shell cells visible from that side that are neighbours in the facade plane
//   (along the facade horizontally, or one above the other), the share of pairs whose block ids differ; the mean over the
//   4 sides weighted by pair count.
// - windowsPerFacade: per side, the window openings visible from that side: 6-connected groups of glass / glass-pane
//   cells among the shell cells visible from that side. windowsMin: the smallest of the 4.
// - paletteAdherence: among all cells whose block has a wood or stone family (lib/kit.mjs woodFamilyOf / stoneFamilyOf),
//   the share whose family is one of the palette's (as the `palette` warning computes them). 1 without a recorded
//   palette (or without such cells).
// - parts: named parts; cellsOutsideParts: written cells (air included, as the `parts` warning counts) outside every
//   part; blocks: non-air cells; topBlocks: the 12 most used non-air block ids (no minecraft: prefix) with their counts,
//   by count then id.

const CORE_ROLES_SET = new Set(CORE_ROLES);
const SIDES = ['north', 'south', 'east', 'west'];
const ACCENT_FIELDS = new Set(['accentPlanks', 'accentLog', 'accentStairs', 'accentSlab', 'accentFence']);
const round3 = (v) => Math.round(v * 1000) / 1000;

/** The wood and stone families of a palette (its block-valued fields; the `palette` warning and paletteAdherence share it). */
export function paletteFamilySets(p) {
  const woods = new Set();
  const stones = new Set();
  for (const v of Object.values(p)) {
    if (typeof v !== 'string' || !v.startsWith('minecraft:')) continue;
    const wf = woodFamilyOf(v);
    if (wf) woods.add(wf);
    const sf = stoneFamilyOf(v);
    if (sf) stones.add(sf);
  }
  return { woods, stones };
}

/** The sidecar's recorded palette, resolved, or null (none recorded, or invalid). */
function recordedPalette(sidecar) {
  if (!sidecar.palette) return null;
  try { return resolvePalette(sidecar.palette); } catch { return null; }
}

/** A block's material family for the no-palette accent rule. */
function materialOf(name) {
  const wf = woodFamilyOf(name);
  if (wf) return `wood:${wf}`;
  const sf = stoneFamilyOf(name);
  if (sf) return `stone:${sf}`;
  return name.replace(/_(stairs|slab|wall|fence|fence_gate|pane)$/, '');
}

const isGlass = (c) => /glass/.test(c.name);

/**
 * Detail-noise ceilings per bible `restraint.detailDensity`. FROZEN 2026-10-06 after the 5a smoke run: the cluttered 4b
 * Mosswater set measured 0.445-0.497, the kit examples 0.18-0.38 (every corner and preset), the smoke tier's round-0
 * designs (no bible) 0.347-0.416. Moderate sits between the clean designs and the cluttered set.
 */
export const DETAIL_NOISE_MAX = Object.freeze({ sparse: 0.32, moderate: 0.42, rich: 0.5 });

/** The metrics of a grid (see above). `outside`: outsideFlood(g). */
export function computeMetrics(g, sidecar, outside = outsideFlood(g)) {
  const notAir = (c) => !!c && BLOCKS[c.name]?.family !== 'air';
  const shell = new Map(); // key -> { c, sides: Set }
  const counts = new Map();
  let blocks = 0;
  for (const [k, c] of g.cells) {
    if (!notAir(c)) continue;
    blocks++;
    const id = shortId(c);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    const [x, y, z] = unfmt(k);
    let exposed = false;
    const sides = new Set();
    for (const [d, dx, dy, dz] of DIRS6) {
      if (!outside.has(fmt(x + dx, y + dy, z + dz))) continue;
      exposed = true;
      if (H_VEC[d]) sides.add(d);
    }
    const fam = familyOfCell(c);
    if (exposed && fam !== 'liquid' && fam !== 'fire') shell.set(k, { c, sides });
  }
  // accentShare
  const p = recordedPalette(sidecar);
  let isAccent;
  if (p) {
    const main = new Set();
    const accent = new Set();
    for (const [f, v] of Object.entries(p)) if (typeof v === 'string' && v.startsWith('minecraft:')) (ACCENT_FIELDS.has(f) ? accent : main).add(v);
    for (const [r, v] of Object.entries(p.roles ?? {})) if (CORE_ROLES_SET.has(r)) (r === 'accent' ? accent : main).add(v);
    isAccent = (name) => !main.has(name) && !main.has(fullBlockOf(name));
  }
  const counted = [...shell.values()].filter(({ c }) => {
    const f = familyOfCell(c);
    return !isGlass(c) && f !== 'pane' && f !== 'door' && f !== 'trapdoor' && !(emissionOf(c) > 0);
  });
  if (!p) {
    const fam = new Map();
    for (const { c } of counted) { const m = materialOf(c.name); fam.set(m, (fam.get(m) ?? 0) + 1); }
    const main = new Set([...fam].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4).map(([m]) => m));
    isAccent = (name) => !main.has(materialOf(name));
  }
  const accentN = counted.filter(({ c }) => isAccent(c.name)).length;
  // detailNoise and windows, per side
  let pairs = 0;
  let differ = 0;
  const windowsPerFacade = {};
  for (const s of SIDES) {
    const vis = (x, y, z) => shell.get(fmt(x, y, z))?.sides.has(s) ? shell.get(fmt(x, y, z)).c : null;
    const along = s === 'north' || s === 'south' ? [1, 0, 0] : [0, 0, 1];
    const glass = new Set();
    for (const [k, { c, sides }] of shell) {
      if (!sides.has(s)) continue;
      const [x, y, z] = unfmt(k);
      for (const [dx, dy, dz] of [along, [0, 1, 0]]) {
        const o = vis(x + dx, y + dy, z + dz);
        if (!o) continue;
        pairs++;
        if (o.name !== c.name) differ++;
      }
      if (isGlass(c)) glass.add(k);
    }
    let groups = 0;
    const seen = new Set();
    for (const k of glass) {
      if (seen.has(k)) continue;
      groups++;
      const q = [k];
      seen.add(k);
      while (q.length) {
        const [x, y, z] = unfmt(q.pop());
        for (const [, dx, dy, dz] of DIRS6) {
          const n = fmt(x + dx, y + dy, z + dz);
          if (glass.has(n) && !seen.has(n)) { seen.add(n); q.push(n); }
        }
      }
    }
    windowsPerFacade[s] = groups;
  }
  // paletteAdherence
  let fam = 0;
  let inPal = 0;
  if (p) {
    const { woods, stones } = paletteFamilySets(p);
    for (const c of g.cells.values()) {
      const wf = woodFamilyOf(c.name);
      const sf = stoneFamilyOf(c.name);
      if (!wf && !sf) continue;
      fam++;
      if (wf ? woods.has(wf) : stones.has(sf)) inPal++;
    }
  }
  const parts = sidecar.parts && typeof sidecar.parts === 'object' && !Array.isArray(sidecar.parts) ? sidecar.parts : {};
  const inParts = Object.values(parts).reduce((a, v) => a + (Number.isInteger(v?.cells) ? v.cells : 0), 0);
  return {
    accentShare: counted.length ? round3(accentN / counted.length) : 0,
    detailNoise: pairs ? round3(differ / pairs) : 0,
    windowsPerFacade,
    windowsMin: Math.min(...SIDES.map((s) => windowsPerFacade[s])),
    paletteAdherence: p && fam ? round3(inPal / fam) : 1,
    parts: Object.keys(parts).length,
    cellsOutsideParts: Math.max(0, g.cells.size - inParts),
    blocks,
    topBlocks: [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 12),
  };
}

/** The `restraint:` warnings of a metrics object against an effective restraint (lib/bible.mjs restraintOf). */
export function restraintWarnings(metrics, restraint) {
  if (!metrics || !restraint) return [];
  const out = [];
  if (metrics.accentShare > restraint.accentShareMax) out.push(`restraint: accentShare ${metrics.accentShare} is over the bible's accentShareMax ${restraint.accentShareMax} (too many accent and decor blocks on the outside: remove scattered accents before adding anything)`);
  if (metrics.windowsMin < restraint.windowsPerFacadeMin) {
    const low = SIDES.filter((s) => metrics.windowsPerFacade[s] < restraint.windowsPerFacadeMin);
    out.push(`restraint: ${low.map((s) => `${s} ${metrics.windowsPerFacade[s]}`).join(', ')} window(s), under the bible's windowsPerFacadeMin ${restraint.windowsPerFacadeMin} (readable glass openings on every side)`);
  }
  const max = DETAIL_NOISE_MAX[restraint.detailDensity];
  if (max !== undefined && metrics.detailNoise > max) out.push(`restraint: detailNoise ${metrics.detailNoise} is over ${max}, the most the bible's detailDensity '${restraint.detailDensity}' allows (neighbouring facade blocks change too often: use larger runs of one material)`);
  return out;
}
