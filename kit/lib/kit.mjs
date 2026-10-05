// Blueprint kit: build a Minecraft building as code. docs/CONTRACT.md ("Library on disk", "Kit CLI") is the contract;
// kit/README.md has the API overview. Ported from AgentCraft's tools/blueprints/lib/kit.mjs (MIT, see LICENSE).
//
// Conventions (same as vanilla structure templates): the template origin is its minimum corner,
// +x = east, +y = up, +z = south. `front: 'south'` means the entrance faces +z.
// Anchors: spots = feet position (x+.5, y, z+.5); yaw in Minecraft degrees: 0 = facing south (+z), 90 = west,
// 180 = north, -90 = east. `cam_*` anchors are eye positions.
// Floor convention: floor row y = groundY-1 (replaces the terrain's top block), feet row y = groundY (sits on the
// terrain surface). `origin` shifts every design coordinate, so a design can be written relative to its main walls
// while the template keeps a margin for overhangs, porches and paths.
import { nbt } from './nbt.mjs';
import { BLOCKS, normalize, qualify, isCube, familyOf, info } from './blocks.mjs';

/** DataVersion of Minecraft 26.3 (version.json world_version in the 26.3 jar). */
export const DATA_VERSION = 5023;

/** The building types of the contract (each has a checker profile). */
export const BUILDING_TYPES = ['house', 'cabin', 'cottage', 'tower', 'shop', 'tavern', 'barn', 'smithy', 'chapel', 'gatehouse', 'custom'];

export const DIR = {
  north: { dx: 0, dz: -1, yaw: 180 },
  south: { dx: 0, dz: 1, yaw: 0 },
  west: { dx: -1, dz: 0, yaw: 90 },
  east: { dx: 1, dz: 0, yaw: -90 },
};
export const OPPOSITE = { north: 'south', south: 'north', west: 'east', east: 'west', up: 'down', down: 'up' };
/** Clockwise / counter-clockwise (seen from above) of a horizontal direction. */
export const CW = { north: 'east', east: 'south', south: 'west', west: 'north' };
export const CCW = { north: 'west', west: 'south', south: 'east', east: 'north' };
export const yawOf = (dir) => DIR[dir].yaw;
/** Horizontal direction for a yaw (multiples of 90). */
export function dirOfYaw(yaw) {
  const y = ((Math.round(yaw / 90) * 90) % 360 + 360) % 360;
  return { 0: 'south', 90: 'west', 180: 'north', 270: 'east' }[y];
}
/** Yaw looking from (x,z) towards (tx,tz) (Minecraft convention). */
export const lookYaw = (x, z, tx, tz) => (Math.atan2(-(tx - x), tz - z) * 180) / Math.PI;
const r3 = (n) => Math.round(n * 1000) / 1000 || 0; // || 0 folds -0
const key = (x, y, z) => `${x},${y},${z}`;
const has = (n) => !!BLOCKS[qualify(n)];

/** Cells of the axis-aligned segment/rect (x0,z0)-(x1,z1), row-major. */
export function cellsOf(x0, z0, x1, z1) {
  const out = [];
  for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) out.push([x, z]);
  return out;
}

// ------------------------------------------------------------------ palette

/**
 * The stairs / slab / wall variant of a full block, or null: `variant('stone_bricks', 'stairs')` ->
 * 'minecraft:stone_brick_stairs', `variant('oak_planks', 'slab')` -> 'minecraft:oak_slab',
 * `variant('quartz_block', 'stairs')` -> 'minecraft:quartz_stairs', `variant('cut_sandstone', 'stairs')` -> null.
 */
export function variant(block, kind) {
  const b = qualify(block).replace(/^minecraft:/, '');
  const cands = [];
  if (b.endsWith('_planks')) cands.push(b.slice(0, -'_planks'.length));
  cands.push(b.replace(/_block$/, ''), b.replace(/bricks$/, 'brick').replace(/tiles$/, 'tile'), b);
  for (const c of cands) if (has(`${c}_${kind}`)) return `minecraft:${c}_${kind}`;
  return null;
}

/** Woods with a full set (planks, log, stairs, slab, fence, door...). */
export const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'poplar', 'bamboo', 'crimson', 'warped'];
const DARK_WOODS = new Set(['spruce', 'dark_oak', 'mangrove', 'crimson', 'warped']);

function woodSet(w) {
  if (!has(`${w}_planks`)) throw new Error(`palette: unknown wood '${w}' (one of ${WOODS.join(', ')})`);
  const pick = (...names) => { for (const n of names) if (n && has(n)) return qualify(n); return null; };
  return {
    planks: qualify(`${w}_planks`),
    log: pick(`${w}_log`, `${w}_stem`, `${w}_block`),
    strippedLog: pick(`stripped_${w}_log`, `stripped_${w}_stem`, `stripped_${w}_block`, `${w}_log`, `${w}_stem`, `${w}_block`),
    bark: pick(`${w}_wood`, `${w}_hyphae`, `${w}_block`),
    stairs: qualify(`${w}_stairs`),
    slab: qualify(`${w}_slab`),
    fence: qualify(`${w}_fence`),
    fenceGate: qualify(`${w}_fence_gate`),
    door: qualify(`${w}_door`),
    trapdoor: qualify(`${w}_trapdoor`),
    button: qualify(`${w}_button`),
    pressurePlate: qualify(`${w}_pressure_plate`),
  };
}

/**
 * A material palette: what a design builds with, so the same source can be re-run as oak/cobblestone or
 * spruce/deepslate (phase 2 variants). Designs read `p.planks`, `p.log`, `p.stone`, `p.roofStairs`... never literal
 * wood or stone names, for anything that should follow the palette.
 * @param {{wood?:string, stone?:string, roof?:string, accent?:string, [k:string]:any}} o
 *   wood: a WOODS name; stone: a full stone block (cobblestone, stone_bricks, deepslate_tiles, bricks, sandstone...);
 *   roof: a wood name or a full block with stairs+slab (default: a darker wood than `wood`);
 *   accent: a second wood for trim (default: the roof wood if it is a wood, else `wood`).
 *   Any other key overrides the derived field (e.g. `wall: 'minecraft:white_terracotta'`).
 */
export function palette(o = {}) {
  const wood = o.wood ?? 'oak';
  const stone = qualify(o.stone ?? 'cobblestone');
  if (!has(stone)) throw new Error(`palette: unknown stone '${o.stone}'`);
  const roof = o.roof ?? (DARK_WOODS.has(wood) ? (wood === 'dark_oak' ? 'spruce' : 'dark_oak') : 'dark_oak');
  const w = woodSet(wood);
  const roofIsWood = has(`${roof}_planks`);
  const roofBlock = roofIsWood ? qualify(`${roof}_planks`) : qualify(roof);
  if (!has(roofBlock)) throw new Error(`palette: unknown roof '${roof}'`);
  const roofStairs = variant(roofBlock, 'stairs');
  const roofSlab = variant(roofBlock, 'slab');
  if (!roofStairs || !roofSlab) throw new Error(`palette: roof '${roof}' has no stairs/slab variant`);
  const accentWood = o.accent ?? (roofIsWood ? roof : wood);
  const a = woodSet(accentWood);
  const p = {
    wood, stoneName: stone.replace(/^minecraft:/, ''), roofName: roof, accentWood,
    ...w,
    accentPlanks: a.planks, accentLog: a.strippedLog, accentStairs: a.stairs, accentSlab: a.slab, accentFence: a.fence,
    stone,
    stoneStairs: variant(stone, 'stairs') ?? 'minecraft:cobblestone_stairs',
    stoneSlab: variant(stone, 'slab') ?? 'minecraft:cobblestone_slab',
    stoneWall: variant(stone, 'wall') ?? 'minecraft:cobblestone_wall',
    roofBlock, roofStairs, roofSlab,
    wall: w.planks, // main wall fill
    frame: w.log, // corner posts / timber frame
    floor: w.planks,
    foundation: stone,
    glass: 'minecraft:glass',
    pane: 'minecraft:glass_pane',
    light: 'minecraft:lantern',
    path: 'minecraft:dirt_path',
  };
  for (const [k, v] of Object.entries(o)) {
    if (['wood', 'stone', 'roof', 'accent'].includes(k)) continue;
    p[k] = typeof v === 'string' ? qualify(v) : v;
  }
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'string' && v.startsWith('minecraft:') && !has(v)) throw new Error(`palette: ${k} '${v}' is not a vanilla block`);
  }
  p.with = (more) => palette({ ...o, ...more });
  return Object.freeze(p);
}

/** Named starting points (any can be tweaked: `PALETTES.rustic.with({ stone: 'mossy_cobblestone' })`). */
export const PALETTES = {
  rustic: palette({ wood: 'spruce', stone: 'cobblestone', roof: 'dark_oak' }),
  oak: palette({ wood: 'oak', stone: 'stone_bricks', roof: 'spruce' }),
  birch: palette({ wood: 'birch', stone: 'polished_andesite', roof: 'dark_oak' }),
  dark: palette({ wood: 'dark_oak', stone: 'deepslate_bricks', roof: 'deepslate_tiles', accent: 'spruce' }),
  desert: palette({ wood: 'jungle', stone: 'sandstone', roof: 'smooth_sandstone', accent: 'jungle' }),
  brick: palette({ wood: 'oak', stone: 'bricks', roof: 'deepslate_tiles', accent: 'dark_oak' }),
};

// ------------------------------------------------------------------ blueprint

export class Blueprint {
  /**
   * @param {{id:string, name?:string, description?:string, type?:string, tags?:string[],
   *   size:number[]|{x:number,y:number,z:number}, origin?:number[], groundY?:number, front?:string,
   *   palette?:object, foundationBlock?:string, interior?:number[]|object,
   *   approach?:false|{length?:number,width?:number,block?:string,slab?:string}, createdAt?:number, request?:object}} o
   * `foundationBlock`: the vanilla block the mod fills under the floor down to the ground on placement (default the
   * palette's foundation). `approach`: the entrance path the mod builds in front of the door on placement (rows out
   * from the box, cells across, the path block and the half-step slab; false = none).
   * `interior`: the box of the rooms ([x0,y0,z0,x1,y1,z1] in design coordinates, feet rows), checked for light,
   * reachability, enclosure and volume.
   */
  constructor(o) {
    if (!/^[a-z0-9_]+$/.test(o.id ?? '')) throw new Error(`blueprint id must match [a-z0-9_]+ (got '${o.id}')`);
    this.id = o.id;
    this.name = o.name ?? o.id;
    this.description = o.description ?? '';
    this.type = o.type ?? 'custom';
    if (!BUILDING_TYPES.includes(this.type)) throw new Error(`type '${this.type}' must be one of ${BUILDING_TYPES.join(', ')}`);
    this.tags = [...(o.tags ?? [])];
    const s = Array.isArray(o.size) ? o.size : [o.size.x, o.size.y, o.size.z];
    this.size = { x: s[0], y: s[1], z: s[2] };
    this.groundY = o.groundY ?? 1;
    this.front = o.front ?? 'south';
    this.p = o.palette ?? palette();
    this.foundationBlock = qualify(o.foundationBlock ?? this.p.foundation);
    this.approach = o.approach === false ? { length: 0, width: 3, block: this.p.path, slab: this.p.stoneSlab }
      : { length: 4, width: 3, block: this.p.path, slab: this.p.stoneSlab, ...(o.approach ?? {}) };
    this.createdAt = o.createdAt;
    this.request = o.request;
    this.cells = new Map(); // "x,y,z" -> { state:{name,props}, nbt }
    this.anchors = {};
    const og = o.origin ?? [0, 0, 0];
    this.ox = og[0];
    this.oy = og[1];
    this.oz = og[2];
    this.interiorBox = null;
    if (o.interior) this.interior(o.interior);
  }

  /** Feet row (rows >= this are the building above the terrain). */
  get feet() { return this.groundY - this.oy; }

  /** Set the interior box ([x0,y0,z0,x1,y1,z1] or {minX..maxZ}, design coordinates). */
  interior(w) {
    const o = Array.isArray(w)
      ? { minX: w[0], minY: w[1], minZ: w[2], maxX: w[3], maxY: w[4], maxZ: w[5] }
      : w;
    this.interiorBox = {
      minX: Math.min(o.minX, o.maxX) + this.ox, minY: Math.min(o.minY, o.maxY) + this.oy, minZ: Math.min(o.minZ, o.maxZ) + this.oz,
      maxX: Math.max(o.minX, o.maxX) + this.ox, maxY: Math.max(o.minY, o.maxY) + this.oy, maxZ: Math.max(o.minZ, o.maxZ) + this.oz,
    };
    return this;
  }

  // ------------------------------------------------------------------ cells

  inBounds(x, y, z) {
    x += this.ox; y += this.oy; z += this.oz;
    return x >= 0 && y >= 0 && z >= 0 && x < this.size.x && y < this.size.y && z < this.size.z;
  }

  /** Place one block. `props` may be partial (the rest is filled with defaults); `nbt` is a block-entity compound as a plain object. */
  set(x, y, z, block, props = {}, nbtData = null) {
    if (!this.inBounds(x, y, z)) throw new Error(`${this.id}: set(${x},${y},${z}) outside size ${this.size.x}x${this.size.y}x${this.size.z} (origin ${this.ox},${this.oy},${this.oz})`);
    this.cells.set(key(x + this.ox, y + this.oy, z + this.oz), { state: normalize(block, props), nbt: nbtData });
    return this;
  }

  air(x, y, z) { return this.set(x, y, z, 'minecraft:air'); }

  get(x, y, z) { return this.cells.get(key(x + this.ox, y + this.oy, z + this.oz)) ?? null; }

  nameAt(x, y, z) { return this.get(x, y, z)?.state.name ?? null; }

  /** Remove a written cell (placement then leaves the terrain there). */
  unset(x, y, z) { this.cells.delete(key(x + this.ox, y + this.oy, z + this.oz)); return this; }

  /** Fill an inclusive box [x0,y0,z0,x1,y1,z1]. */
  fill(box, block, props = {}, nbtData = null) {
    const [x0, y0, z0, x1, y1, z1] = box;
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
      for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, z, block, props, nbtData);
    return this;
  }

  /** Only the six faces of the box. */
  hollow(box, block, props = {}) {
    const [x0, y0, z0, x1, y1, z1] = box.map((n, i) => (i < 3 ? Math.min(n, box[i + 3]) : Math.max(n, box[i - 3])));
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++)
          if (x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1) this.set(x, y, z, block, props);
    return this;
  }

  /** Interior air so placing the template clears the space. */
  carve(box) { return this.fill(box, 'minecraft:air'); }

  // ------------------------------------------------------------------ walls, floors, rooms

  /**
   * Four walls around the rectangle (x0,z0)-(x1,z1) (the wall cells themselves), rows y0..y1. `corners` (default the
   * palette's frame log) for the four corner columns; `openings` = [[x0,y0,z0,x1,y1,z1], ...] carved to air afterwards.
   */
  walls(x0, z0, x1, z1, y0, y1, { block = this.p.wall, corners = this.p.frame, props, openings = [] } = {}) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) for (const z of [z0, z1]) this.set(x, y, z, block, props);
      for (let z = z0; z <= z1; z++) for (const x of [x0, x1]) this.set(x, y, z, block, props);
    }
    if (corners) for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) this.fill([x, y0, z, x, y1, z], corners);
    for (const b of openings) this.carve(b);
    return this;
  }

  /** A flat floor rectangle on row y: floor(x0,z0,x1,z1,y,block). */
  floor(x0, z0, x1, z1, y, block = this.p.floor, props) { return this.fill([x0, y, z0, x1, y, z1], block, props); }

  /**
   * A closed room: walls on the box's faces (frame logs on the corners), a floor on y0, a ceiling on y1 and air inside.
   * box = [x0,y0,z0,x1,y1,z1] including the walls, floor and ceiling.
   */
  room(box, { wall = this.p.wall, floor = this.p.floor, ceiling = this.p.planks, corners = this.p.frame } = {}) {
    const [x0, y0, z0, x1, y1, z1] = box;
    this.carve([x0 + 1, y0 + 1, z0 + 1, x1 - 1, y1 - 1, z1 - 1]);
    this.walls(x0, z0, x1, z1, y0 + 1, y1 - 1, { block: wall, corners });
    this.fill([x0, y0, z0, x1, y0, z1], floor);
    if (ceiling) this.fill([x0, y1, z0, x1, y1, z1], ceiling);
    return this;
  }

  /** A vertical post of `block` from y0..y1 at (x,z). */
  post(x, z, y0, y1, block = this.p.frame) { return this.fill([x, y0, z, x, y1, z], block); }

  /** A horizontal beam of logs along x or z (axis set from the run direction). */
  beam(x0, y, z0, x1, z1, block = this.p.frame) {
    const axis = z0 === z1 ? 'x' : 'z';
    const props = BLOCKS[qualify(block)]?.props.axis ? { axis } : {};
    for (const [x, z] of cellsOf(x0, z0, x1, z1)) this.set(x, y, z, block, props);
    return this;
  }

  // ------------------------------------------------------------------ windows

  /** Glass panes over a wall rectangle (connections are computed in finalize()). */
  window(x0, y0, z0, x1, y1, z1, pane = this.p.pane) { return this.fill([x0, y0, z0, x1, y1, z1], pane); }

  /**
   * A row of windows along a wall segment (x0,z0)-(x1,z1): `width` panes wide and rows y0..y1, one every `every`
   * cells starting `start` cells in (default: centred). Optional outside `sill` (a slab under each window, on the
   * `outside` direction) and `shutters` (trapdoors beside the window, open, on the outside).
   */
  windows(x0, z0, x1, z1, y0, y1, { every = 3, width = 1, start, pane = this.p.pane, sill = null, outside = null } = {}) {
    const cells = cellsOf(x0, z0, x1, z1);
    const n = cells.length;
    const count = Math.max(1, Math.floor((n - width) / every) + 1);
    const used = (count - 1) * every + width;
    const s = start ?? Math.floor((n - used) / 2);
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < width; k++) {
        const c = cells[s + i * every + k];
        if (!c) continue;
        this.window(c[0], y0, c[1], c[0], y1, c[1], pane);
        if (sill && outside) {
          const d = DIR[outside];
          this.set(c[0] + d.dx, y0 - 1, c[1] + d.dz, sill, has(sill) && familyOf(sill) === 'slab' ? { type: 'top' } : familyOf(sill) === 'stairs' ? { facing: OPPOSITE[outside], half: 'top' } : {});
        }
      }
    }
    return this;
  }

  // ------------------------------------------------------------------ doors

  /**
   * A two-high door in the wall cell (x,y,z); the cell above is its upper half. `facing` is the side the door faces
   * (for an entrance: the outside). Default: the palette's wooden door, written closed. An iron door (`block:
   * 'minecraft:iron_door'` or ironDoor()) gets a stone button on BOTH sides at y+1 on the jamb next to it
   * (`buttonSide` +1 = the +x / +z jamb, -1 the other); the jamb becomes `jamb` (a full, redstone-conductive block:
   * the button powers it, it powers the door).
   */
  door(x, y, z, facing, { hinge = 'left', block = this.p.door, buttons = qualify(block) === 'minecraft:iron_door', buttonSide = 1, jamb = this.p.stone, button = 'minecraft:stone_button' } = {}) {
    this.set(x, y, z, block, { facing, half: 'lower', hinge, open: 'false' });
    this.set(x, y + 1, z, block, { facing, half: 'upper', hinge, open: 'false' });
    if (buttons) {
      const f = DIR[facing];
      const [jx, jz] = f.dx === 0 ? [x + buttonSide, z] : [x, z + buttonSide];
      this.set(jx, y + 1, jz, jamb);
      this.set(jx + f.dx, y + 1, jz + f.dz, button, { face: 'wall', facing });
      this.set(jx - f.dx, y + 1, jz - f.dz, button, { face: 'wall', facing: OPPOSITE[facing] });
    }
    return this;
  }

  /** An iron door (zombie-proof) with a stone button on both sides; see door(). */
  ironDoor(x, y, z, facing, opts = {}) { return this.door(x, y, z, facing, { ...opts, block: 'minecraft:iron_door', buttons: true }); }

  /** Two doors side by side (left and right hinge), (x,y,z) the left one seen from outside. */
  doubleDoor(x, y, z, facing, opts = {}) {
    // seen from outside (looking against `facing`), the right-hand side is CCW of facing
    const r = DIR[CCW[facing]];
    this.door(x, y, z, facing, { ...opts, hinge: 'left' });
    this.door(x + r.dx, y, z + r.dz, facing, { ...opts, hinge: 'right' });
    return this;
  }

  // ------------------------------------------------------------------ stairs, ladders

  stairs(x, y, z, facing, { block = this.p.stairs, half = 'bottom', shape = 'straight' } = {}) {
    return this.set(x, y, z, block, { facing, half, shape });
  }

  slab(x, y, z, type = 'bottom', block = this.p.slab) { return this.set(x, y, z, block, { type }); }

  /**
   * A straight staircase climbing `rise` blocks towards `dir`, (x,y,z) the first step (the cell in the lower feet
   * row). Step i sits at (x,y,z) + i*(dir) + (0,i,0); the last one is in the upper floor's floor row, so the
   * staircase ends level with the upper floor: rise = upperFloorRow - y + 1. Headroom above every step
   * (`headroom` cells) is carved to air, which opens the stairwell through the upper floor; the space under each step
   * is filled with `under` (null: leave it).
   */
  stairRun(x, y, z, dir, rise, { block = this.p.stairs, under = this.p.planks, headroom = 2 } = {}) {
    const d = DIR[dir];
    for (let i = 0; i < rise; i++) {
      const sx = x + d.dx * i;
      const sz = z + d.dz * i;
      this.set(sx, y + i, sz, block, { facing: dir, half: 'bottom', shape: 'straight' });
      if (under) for (let yy = y; yy < y + i; yy++) this.set(sx, yy, sz, under);
      for (let h = 1; h <= headroom; h++) this.air(sx, y + i + h, sz);
    }
    return this;
  }

  /**
   * A ladder column at (x,z) from y0 to y1 (inclusive), each ladder `facing` away from the wall it hangs on (the
   * support is the cell behind it). It replaces whatever is there, so it cuts through floors on its way up.
   */
  ladder(x, z, y0, y1, facing) {
    for (let y = y0; y <= y1; y++) this.set(x, y, z, 'minecraft:ladder', { facing });
    return this;
  }

  // ------------------------------------------------------------------ roofs

  /**
   * A gabled roof over the rectangle (x0,z0)-(x1,z1) (include the overhang in it), eaves on row y.
   * ridge: 'x' = the ridge runs east-west (eaves on the north/south edges), 'z' = north-south.
   * pitch 1: one row per cell (stairs, ridge = `full` blocks or `ridgeSlab`s); pitch 0.5: half a row per cell
   * (stairs / top slabs alternating, a shallow roof for wide halls). The attic is left hollow.
   * Gable ends: `gableInset` cells in from the rectangle's ends (normally the overhang) are filled with `gable` up to the
   * slope (`gableFrom` = first row, default y); `gable: null` leaves them open. Stairs `facing` points up the slope.
   */
  roofGable(x0, z0, x1, z1, y, {
    ridge = 'x', pitch = 1, stairs = this.p.roofStairs, slab = this.p.roofSlab, full = this.p.roofBlock,
    gable = this.p.wall, gableInset = 0, gableFrom = null, ridgeSlab = false, lining = this.p.roofBlock,
  } = {}) {
    if (pitch !== 1 && pitch !== 0.5) throw new Error('roofGable: pitch must be 1 or 0.5');
    const alongX = ridge === 'x';
    const a0 = alongX ? Math.min(z0, z1) : Math.min(x0, x1);
    const a1 = alongX ? Math.max(z0, z1) : Math.max(x0, x1);
    const b0 = alongX ? Math.min(x0, x1) : Math.min(z0, z1);
    const b1 = alongX ? Math.max(x0, x1) : Math.max(z0, z1);
    const half = (a1 - a0) / 2;
    const profile = (a) => {
      const m = Math.min(a - a0, a1 - a);
      const up = a - a0 < a1 - a ? (alongX ? 'south' : 'east') : alongX ? 'north' : 'west';
      const mid = Number.isInteger(half) && a - a0 === half;
      if (pitch === 1) return mid ? { dy: m, kind: ridgeSlab ? 'ridgeSlab' : 'ridge', up } : { dy: m, kind: 'stair', up };
      if (mid) return { dy: Math.ceil(m / 2), kind: 'ridgeSlab', up };
      return m % 2 === 0 ? { dy: m / 2, kind: 'stair', up } : { dy: (m - 1) / 2, kind: 'topSlab', up };
    };
    const linings = [];
    for (let a = a0; a <= a1; a++) {
      const p = profile(a);
      for (let b = b0; b <= b1; b++) {
        const [x, z] = alongX ? [b, a] : [a, b];
        if (p.kind === 'ridge') this.set(x, y + p.dy, z, full);
        else if (p.kind === 'ridgeSlab') this.set(x, y + p.dy, z, slab, { type: 'bottom' });
        else if (p.kind === 'topSlab') this.set(x, y + p.dy, z, slab, { type: 'top' });
        else this.set(x, y + p.dy, z, stairs, { facing: p.up, half: 'bottom', shape: 'straight' });
        if (lining && p.dy > 0 && p.kind !== 'topSlab' && !this.get(x, y + p.dy - 1, z)) linings.push([x, y + p.dy - 1, z]);
      }
      if (gable) {
        const top = y + p.dy - (p.kind === 'ridgeSlab' && pitch === 1 ? 0 : 1);
        for (const b of [b0 + gableInset, b1 - gableInset]) {
          const [x, z] = alongX ? [b, a] : [a, b];
          for (let yy = gableFrom ?? y; yy <= top; yy++) this.set(x, yy, z, gable);
        }
      }
    }
    // the lining (one block under every roof block above the eaves) ties each course of the roof to the one below it
    for (const [x, yy, z] of linings) if (!this.get(x, yy, z)) this.set(x, yy, z, lining);
    return this;
  }

  /**
   * A hip roof: stairs rise one row per cell from all four edges of (x0,z0)-(x1,z1) (include the overhang), eaves on
   * row y, outer-corner stairs on the hips. `rise` = rows before a flat top of `top` blocks (default: up to the
   * ridge, which gets `top` blocks); `lining` (default the roof block, null for none) goes one block under every
   * course above the eaves so each course rests on the one below; `under` instead backs the slope down to row y.
   */
  roofHip(x0, z0, x1, z1, y, { rise, stairs = this.p.roofStairs, top = this.p.roofBlock, under = null, lining = this.p.roofBlock } = {}) {
    const maxM = Math.floor((Math.min(x1 - x0, z1 - z0)) / 2);
    const R = rise ?? maxM;
    const flatTop = rise !== undefined && rise < maxM;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const dN = z - z0;
        const dS = z1 - z;
        const dW = x - x0;
        const dE = x1 - x;
        const m = Math.min(dW, dE, dN, dS);
        if (m >= R && (flatTop || (m === maxM && Math.min(x1 - x0, z1 - z0) % 2 === 0))) {
          this.set(x, y + R, z, top);
          if (lining && R > 0 && !this.get(x, y + R - 1, z)) this.set(x, y + R - 1, z, lining);
          continue;
        }
        if (m > R) continue;
        const sides = [dN === m && 'north', dS === m && 'south', dW === m && 'west', dE === m && 'east'].filter(Boolean);
        let facing = OPPOSITE[sides[0]]; // tall side faces inwards
        let shape = 'straight';
        if (sides.length > 1) {
          const ns = sides.find((q) => q === 'north' || q === 'south');
          const we = sides.find((q) => q === 'west' || q === 'east');
          if (ns && we) {
            facing = ns === 'north' ? 'south' : 'north';
            shape = { 'north,west': 'outer_left', 'north,east': 'outer_right', 'south,east': 'outer_left', 'south,west': 'outer_right' }[`${ns},${we}`];
          }
        }
        this.set(x, y + m, z, stairs, { facing, half: 'bottom', shape });
        if (under) for (let yy = y; yy < y + m; yy++) this.set(x, yy, z, under);
        else if (lining && m > 0 && !this.get(x, y + m - 1, z)) this.set(x, y + m - 1, z, lining);
      }
    }
    return this;
  }

  /** Flat roof deck on row y over (x0,z0)-(x1,z1) with an optional parapet ring on y+1 (crenellated: every other cell). */
  roofFlat(x0, z0, x1, z1, y, { deck = this.p.stone, parapet = this.p.stone, crenels = false } = {}) {
    this.fill([x0, y, z0, x1, y, z1], deck);
    if (parapet) {
      let i = 0;
      for (const [x, z] of cellsOf(x0, z0, x1, z1)) {
        if (!(x === x0 || x === x1 || z === z0 || z === z1)) continue;
        this.set(x, y + 1, z, parapet);
        if (crenels && (x + z) % 2 === 0) this.set(x, y + 2, z, parapet);
        i++;
      }
      void i;
    }
    return this;
  }

  // ------------------------------------------------------------------ exterior features

  /**
   * A chimney column of `block` at (x,z) from y0 to y1, topped by a lit campfire (smoke) unless `smoke: false`.
   * Put it against a wall or through the roof; the column must touch the building or the ground.
   */
  chimney(x, z, y0, y1, { block = this.p.stone, smoke = true } = {}) {
    this.fill([x, y0, z, x, y1, z], block);
    if (smoke) this.set(x, y1 + 1, z, 'minecraft:campfire', { lit: 'true', signal_fire: 'false', facing: 'north' });
    return this;
  }

  /**
   * A porch: a deck (floor row y-1 over (x0,z0)-(x1,z1)), posts at `posts` = [[x,z],...] from the feet row up to
   * roofY-1, a slab roof on roofY (null: no roof) and optional fence `rail` along `railSides` (['west','east',..]).
   */
  porch(x0, z0, x1, z1, { y = this.feet, roofY = null, deck = this.p.planks, posts = [], post = this.p.frame, roof = this.p.roofSlab, rail = null, railSides = [] } = {}) {
    this.floor(x0, z0, x1, z1, y - 1, deck);
    for (const [px, pz] of posts) this.post(px, pz, y, (roofY ?? y + 2) - 1, post);
    if (roofY !== null && roof) for (const [x, z] of cellsOf(x0, z0, x1, z1)) this.slab(x, roofY, z, 'bottom', roof);
    if (rail) {
      for (const side of railSides) {
        const cells = side === 'west' ? cellsOf(x0, z0, x0, z1) : side === 'east' ? cellsOf(x1, z0, x1, z1) : side === 'north' ? cellsOf(x0, z0, x1, z0) : cellsOf(x0, z1, x1, z1);
        for (const [x, z] of cells) if (!this.get(x, y, z) || this.nameAt(x, y, z) === 'minecraft:air') this.set(x, y, z, rail);
      }
    }
    return this;
  }

  // ------------------------------------------------------------------ lights, decor

  /** A lantern (hanging from the block above, or standing on the block below). */
  lantern(x, y, z, hanging = false, block = this.p.light) { return this.set(x, y, z, block, { hanging: String(hanging) }); }

  /** A torch: on the floor, or on a wall when `facing` (pointing away from the wall it hangs on) is given. */
  torch(x, y, z, facing = null) {
    return facing ? this.set(x, y, z, 'minecraft:wall_torch', { facing }) : this.set(x, y, z, 'minecraft:torch');
  }

  candle(x, y, z, n = 2, lit = true) { return this.set(x, y, z, 'minecraft:candle', { candles: n, lit: String(lit) }); }

  /**
   * Hanging lanterns on row y (the row just under a ceiling) over (x0,z0)-(x1,z1), on a grid `spacing` apart
   * (centred). A lantern gives light 15, so spacing <= 12 lights every cell of a flat room.
   */
  ceilingLights(x0, z0, x1, z1, y, { spacing = 6, block = this.p.light } = {}) {
    const axis = (a0, a1) => {
      const n = a1 - a0 + 1;
      const k = Math.max(1, Math.ceil(n / spacing));
      return Array.from({ length: k }, (_, i) => a0 + Math.floor(((i + 0.5) * n) / k));
    };
    for (const x of axis(x0, x1)) for (const z of axis(z0, z1)) this.lantern(x, y, z, true, block);
    return this;
  }

  /** A potted plant (any `minecraft:potted_*`). */
  plant(x, y, z, block = 'minecraft:potted_fern') { return this.set(x, y, z, block); }

  /** A carpet rug over (x0,z0)-(x1,z1) on row y with a border colour. */
  rug(x0, z0, x1, z1, y, { fill = 'minecraft:red_carpet', border = 'minecraft:brown_carpet' } = {}) {
    for (const [x, z] of cellsOf(x0, z0, x1, z1)) this.set(x, y, z, x === x0 || x === x1 || z === z0 || z === z1 ? border : fill);
    return this;
  }

  /** A table: a fence post with a pressure plate on top (classic) or a top slab (`top: 'slab'`). */
  table(x, y, z, { top = 'plate' } = {}) {
    if (top === 'slab') return this.slab(x, y, z, 'top', this.p.slab);
    this.set(x, y, z, this.p.fence);
    return this.set(x, y + 1, z, this.p.pressurePlate);
  }

  /** A chair: a stair facing away from where the sitter looks (`looks` = the direction the sitter faces). */
  chair(x, y, z, looks) { return this.stairs(x, y, z, OPPOSITE[looks]); }

  /** A bed: the head half at (x,z), the foot half one cell behind (opposite `facing`, which points to the pillow). */
  bed(x, y, z, facing, color = 'red') {
    const f = DIR[facing];
    const block = `minecraft:${color}_bed`;
    this.set(x, y, z, block, { facing, part: 'head', occupied: 'false' });
    this.set(x - f.dx, y, z - f.dz, block, { facing, part: 'foot', occupied: 'false' });
    return this;
  }

  // ------------------------------------------------------------------ anchors

  /** Raw anchor (design coordinates; spots = feet position). */
  anchor(name, x, y, z, yaw = 0, pitch = 0) {
    this.anchors[name] = { x: r3(x + this.ox), y: r3(y + this.oy), z: r3(z + this.oz), yaw: r3(yaw), pitch: r3(pitch) };
    return this;
  }

  /** A standing spot at the centre of cell (cx, cz), feet row y (default the ground feet row), looking at `yaw`. */
  spot(name, cx, cz, yaw = 0, { y = this.feet } = {}) { return this.anchor(name, cx + 0.5, y, cz + 0.5, yaw, 0); }

  /** QA / preview camera `cam_<name>` (eye position) looking at a point. */
  camera(name, eye, lookAt) {
    const n = name.startsWith('cam_') ? name : `cam_${name}`;
    const [ex, ey, ez] = eye;
    const [lx, ly, lz] = lookAt;
    const dx = lx - ex;
    const dy = ly - ey;
    const dz = lz - ez;
    const yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
    const pitch = (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
    return this.anchor(n, ex, ey, ez, yaw, pitch);
  }

  // ------------------------------------------------------------------ output

  /** Connect panes, iron bars, fences and walls to their neighbours (vanilla does it on neighbour update). */
  finalize() {
    const connects = (fam, n, dir) => {
      if (!n) return false;
      const nf = BLOCKS[n.state.name]?.family;
      if (fam === 'pane') return nf === 'pane' || nf === 'wall' || isCube(n.state);
      if (fam === 'fence') return nf === 'fence' || (nf === 'fence_gate' && ['north', 'south'].includes(n.state.props.facing) === ['east', 'west'].includes(dir)) || isCube(n.state);
      if (fam === 'wall') return nf === 'wall' || nf === 'pane' || nf === 'fence_gate' || isCube(n.state);
      return false;
    };
    for (const [k, c] of this.cells) {
      const fam = BLOCKS[c.state.name]?.family;
      if (fam !== 'pane' && fam !== 'fence' && fam !== 'wall') continue;
      const [x, y, z] = k.split(',').map(Number);
      const props = { ...c.state.props };
      const conn = {};
      for (const d of Object.keys(DIR)) conn[d] = connects(fam, this.cells.get(key(x + DIR[d].dx, y, z + DIR[d].dz)), d);
      if (fam === 'wall') {
        for (const d of Object.keys(DIR)) props[d] = conn[d] ? 'low' : 'none';
        const straight = (conn.north && conn.south && !conn.east && !conn.west) || (conn.east && conn.west && !conn.north && !conn.south);
        props.up = String(!straight || !!this.cells.get(key(x, y + 1, z)));
      } else for (const d of Object.keys(DIR)) props[d] = String(conn[d]);
      c.state = { name: c.state.name, props };
    }
    return this;
  }

  /** Written blocks as { x, y, z, state:{name,props}, nbt } sorted by y, z, x. */
  entries() {
    this.finalize();
    return [...this.cells].map(([k, c]) => {
      const [x, y, z] = k.split(',').map(Number);
      return { x, y, z, state: c.state, nbt: c.nbt };
    }).sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  }

  /** The vanilla structure template as a tagged NBT root compound. */
  toStructure() {
    const list = this.entries();
    const palette = [];
    const index = new Map();
    const blocks = [];
    for (const e of list) {
      const pk = qualify(e.state.name) + JSON.stringify(e.state.props);
      if (!index.has(pk)) {
        index.set(pk, palette.length);
        const entry = { id: nbt.str(e.state.name) };
        if (Object.keys(e.state.props).length) {
          entry.properties = nbt.compound(Object.fromEntries(Object.entries(e.state.props).map(([k, v]) => [k, nbt.str(v)])));
        }
        palette.push(nbt.compound(entry));
      }
      const b = { pos: nbt.list('int', [nbt.int(e.x), nbt.int(e.y), nbt.int(e.z)]), state: nbt.int(index.get(pk)) };
      if (e.nbt) b.nbt = nbt.compound(Object.fromEntries(Object.entries(e.nbt).map(([k, v]) => [k, typeof v === 'number' ? nbt.int(v) : nbt.str(v)])));
      blocks.push(nbt.compound(b));
    }
    return nbt.compound({
      DataVersion: nbt.int(DATA_VERSION),
      size: nbt.list('int', [nbt.int(this.size.x), nbt.int(this.size.y), nbt.int(this.size.z)]),
      palette: nbt.list('compound', palette),
      blocks: nbt.list('compound', blocks),
      entities: nbt.list('compound', []),
    });
  }

  /** The block ids the template uses, most used first (air left out): the sidecar's `materials`. */
  materials() {
    const count = new Map();
    for (const c of this.cells.values()) {
      const n = c.state.name;
      if (info(n).family === 'air') continue;
      count.set(n, (count.get(n) ?? 0) + 1);
    }
    return [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([n]) => n);
  }

  /** The `<id>.blueprint.json` sidecar object (docs/CONTRACT.md "Sidecar"). */
  sidecar() {
    const s = {
      id: this.id,
      name: this.name,
      description: this.description,
      type: this.type,
      tags: [...this.tags],
      size: { ...this.size },
      groundY: this.groundY,
      front: this.front,
      materials: this.materials(),
      foundationBlock: this.foundationBlock,
      approach: { ...this.approach },
    };
    if (this.interiorBox) s.interior = { ...this.interiorBox };
    s.anchors = Object.fromEntries(Object.entries(this.anchors).map(([k, v]) => [k, { ...v }]));
    s.source = `${this.id}.mjs`;
    if (this.createdAt !== undefined) s.createdAt = this.createdAt;
    if (this.request !== undefined) s.request = this.request;
    return s;
  }
}
