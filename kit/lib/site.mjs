// (7b SV, docs/CONTRACT.md "Phase 7b" §2-§3 row 2; SETTLEMENTS §7.2) A Site: a frozen ARVX volume window and the site spec of the lot
// it was cut for, seen in the design's own frame. It is the object a site-aware design is built against (`build({ palette, site })`),
// and the one the checker (SC), the renderer and the slices read.
//
// Frames. Design coordinates are template coordinates (the template's minimum corner at 0,0,0, +x east, +y up, +z south, front south).
// A site-bound template is exactly the lot box, and the spec's frame maps it to the world: `frame.origin` is the rotated template box's
// minimum corner (api.SiteFrame, 7bF reading 4), `frame.rotation` one of SITE_ROTATIONS, turning as vanilla's StructureTemplate and the
// mod's BlueprintTransform do (lib/reserved.mjs rotateBlock: clockwise_90 sends south to west). The volume is the lot box plus
// SITE_MARGIN on every side (7bF reading 5), so the window reaches from -margin to size + margin - 1 on each axis.
//
// Classes are the ARVX voxel classes (lib/region/volume.mjs VOXEL_CLASSES) by name: 'AIR', 'ROCK', 'SOIL', ... ; 'MISSING' outside
// the volume. Ports and keep-critical cells come from the spec: `SitePort.at` is in design cells (with a design-frame facing), the spec's
// `keepCritical` in world cells (7bF reading 5), returned here in design cells.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeArvx, VOXEL_CLASSES } from './region/volume.mjs';
import { rotateBlock } from './reserved.mjs';
import { fitOf, SITE_MARGIN, SITE_ROTATIONS } from './siteFits.mjs';
import { siteSpecProblems } from './siteSpec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The six 7bF site fixtures (kit/test/fixtures/site/<id>/{volume.bin, site.json}). */
export const SITE_FIXTURES = path.resolve(HERE, '..', 'test', 'fixtures', 'site');

/** The classes a building can bear on: the land's own solids (rock, soil, loose, ice, snow) and a host trunk's logs. */
export const SITE_SOLID = Object.freeze(['ROCK', 'SOIL', 'LOOSE', 'ICE', 'SNOW', 'LOG']);
const SOLID = new Set(SITE_SOLID);
const H_DIRS = ['north', 'east', 'south', 'west'];
const VEC = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };
const SIDE = { n: 'north', s: 'south', e: 'east', w: 'west', u: 'up', d: 'down' };
const TURNS = { none: 0, clockwise_90: 1, clockwise_180: 2, counterclockwise_90: 3 };

/** A facing turned `turns` clockwise quarter turns (up and down stay). */
export function turnFacing(f, turns) {
  const i = H_DIRS.indexOf(f);
  return i < 0 ? f : H_DIRS[(i + (((turns % 4) + 4) % 4)) % 4];
}

const boxEq = (a, b) => ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].every((k) => a[k] === b[k]);

export class Site {
  /**
   * @param {object} volume a decoded ARVX volume (decodeArvx), or the file's bytes (gzip or raw)
   * @param {object} lot the site spec's wire form (kit/schemas/site-spec.json), or a 7bF fixture's site.json (`{lot, spec, ...}`)
   */
  constructor(volume, lot) {
    const v = volume instanceof Uint8Array || Buffer.isBuffer?.(volume) ? decodeArvx(volume) : volume;
    if (!v || !v.classes || !v.box) throw new Error('Site: the volume must be a decoded ARVX volume or its bytes');
    const wrapper = lot && typeof lot === 'object' && lot.spec && typeof lot.spec === 'object' ? lot : null;
    const spec = wrapper ? wrapper.spec : lot;
    const problems = siteSpecProblems(spec);
    if (problems.length) throw new Error(`Site: the site spec is invalid: ${problems.join('; ')}`);
    if (v.sha !== spec.volumeSha) throw new Error(`Site: the volume's sha ${v.sha.slice(0, 12)} is not the spec's volumeSha ${spec.volumeSha.slice(0, 12)} (another volume)`);
    if (!boxEq(v.box, spec.volume)) throw new Error('Site: the volume\'s box is not the spec\'s volume');
    this.volume = v;
    this.spec = structuredClone(spec);
    this.sha = v.sha;
    this.fit = spec.fit;
    fitOf(this.fit);
    this.lotId = spec.lotId ?? null;
    this.margin = SITE_MARGIN;
    const b = spec.volume;
    // the lot box (the template box in the world): the fixture records it; else the volume less the margin
    this.lot = wrapper?.lot ? { ...wrapper.lot }
      : { minX: b.minX + SITE_MARGIN, minY: b.minY + SITE_MARGIN, minZ: b.minZ + SITE_MARGIN, maxX: b.maxX - SITE_MARGIN, maxY: b.maxY - SITE_MARGIN, maxZ: b.maxZ - SITE_MARGIN };
    const L = this.lot;
    if (!(L.minX >= b.minX && L.maxX <= b.maxX && L.minY >= b.minY && L.maxY <= b.maxY && L.minZ >= b.minZ && L.maxZ <= b.maxZ && L.minX <= L.maxX && L.minY <= L.maxY && L.minZ <= L.maxZ)) {
      throw new Error('Site: the lot box must lie inside the volume');
    }
    if (!SITE_ROTATIONS.includes(spec.frame.rotation)) throw new Error(`Site: rotation ${spec.frame.rotation}`);
    this.frame = { origin: [...spec.frame.origin], rotation: spec.frame.rotation };
    this.turns = TURNS[spec.frame.rotation];
    const [ox, oy, oz] = this.frame.origin;
    if (ox !== L.minX || oy !== L.minY || oz !== L.minZ) {
      throw new Error(`Site: the frame's origin ${this.frame.origin.join(',')} is not the lot box's minimum corner ${L.minX},${L.minY},${L.minZ} (a site-bound template is the lot box)`);
    }
    const wx = L.maxX - L.minX + 1, wz = L.maxZ - L.minZ + 1;
    // the template's size in the design frame: a quarter turn swaps x and z
    this.size = this.turns & 1 ? { x: wz, y: L.maxY - L.minY + 1, z: wx } : { x: wx, y: L.maxY - L.minY + 1, z: wz };
    // the window (the whole volume) in design cells
    const cs = [];
    for (const x of [b.minX, b.maxX]) for (const z of [b.minZ, b.maxZ]) cs.push(this.toDesign(x, b.minY, z));
    this.bounds = {
      minX: Math.min(...cs.map((c) => c[0])), maxX: Math.max(...cs.map((c) => c[0])),
      minY: b.minY - oy, maxY: b.maxY - oy,
      minZ: Math.min(...cs.map((c) => c[2])), maxZ: Math.max(...cs.map((c) => c[2])),
    };
    this.ports = spec.ports.map((p) => ({ name: p.name, kind: p.kind, at: [...p.at], facing: p.facing, width: p.width, height: p.height, ...(p.edge != null ? { edge: p.edge } : {}) }));
    this.keepCritical = spec.keepCritical.map(([x, y, z]) => this.toDesign(x, y, z));
  }

  /** A Site from files: `volumePath` the ARVX file (gzip or raw), `lotPath` the site spec JSON (a bare spec or a fixture's site.json). */
  static fromFiles(volumePath, lotPath) {
    return new Site(fs.readFileSync(volumePath), JSON.parse(fs.readFileSync(lotPath, 'utf8')));
  }

  /** One of the six 7bF fixtures by id (cliff_face, tunnel_hill, rift_site, grove, overhang, trunk). */
  static fixture(id) {
    if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`Site.fixture: bad id ${JSON.stringify(id)}`);
    const dir = path.join(SITE_FIXTURES, id);
    if (!fs.existsSync(path.join(dir, 'site.json'))) throw new Error(`Site.fixture: no site fixture '${id}' (${dir})`);
    return Site.fromFiles(path.join(dir, 'volume.bin'), path.join(dir, 'site.json'));
  }

  // ------------------------------------------------------------------ frames

  /** A design cell to its world cell. */
  toWorld(x, y, z) {
    const [rx, rz] = rotateBlock(x, z, this.size.x, this.size.z, this.turns);
    return [this.frame.origin[0] + rx, this.frame.origin[1] + y, this.frame.origin[2] + rz];
  }

  /** A world cell to its design cell. */
  toDesign(wx, wy, wz) {
    const L = this.lot ?? null;
    const rsx = L.maxX - L.minX + 1, rsz = L.maxZ - L.minZ + 1;
    const [x, z] = rotateBlock(wx - this.frame.origin[0], wz - this.frame.origin[2], rsx, rsz, (4 - this.turns) % 4);
    return [x, wy - this.frame.origin[1], z];
  }

  /** A design-frame facing as the world sees it (and `worldFacing(f, true)` the other way). */
  worldFacing(f, back = false) { return turnFacing(f, back ? 4 - this.turns : this.turns); }

  /** Is the design cell inside the template (the lot box)? */
  inLot(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.size.x && y < this.size.y && z < this.size.z; }

  /** Is the design cell inside the volume (the window)? */
  inWindow(x, y, z) { const b = this.bounds; return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ; }

  // ------------------------------------------------------------------ cells

  /** The class index (VC) at a design cell (MISSING outside the volume). */
  classIndex(x, y, z) {
    const [wx, wy, wz] = this.toWorld(x, y, z);
    const v = this.volume, b = v.box;
    if (wx < b.minX || wx > b.maxX || wy < b.minY || wy > b.maxY || wz < b.minZ || wz > b.maxZ) return 14;
    return v.classes[((wx - b.minX) * v.depth + (wz - b.minZ)) * v.height + (wy - b.minY)];
  }

  /** The class name at a design cell ('AIR', 'ROCK', ...; 'MISSING' outside the volume). */
  at(x, y, z) { return VOXEL_CLASSES[this.classIndex(x, y, z)]; }

  /** Can a building bear on the cell (SITE_SOLID: rock, soil, loose, ice, snow, a log)? */
  solid(x, y, z) { return SOLID.has(this.at(x, y, z)); }

  /** The top solid cell of column (x, z) at or below `below` (default the window's top), or null. */
  surface(x, z, { below = this.bounds.maxY } = {}) {
    for (let y = Math.min(below, this.bounds.maxY); y >= this.bounds.minY; y--) if (this.solid(x, y, z)) return y;
    return null;
  }

  /** The lowest solid cell of column (x, z) above `above` (default the template's floor row 0), or null. */
  ceiling(x, z, { above = 0 } = {}) {
    for (let y = Math.max(above + 1, this.bounds.minY); y <= this.bounds.maxY; y++) if (this.solid(x, y, z)) return y;
    return null;
  }

  /**
   * The design cells of a class (or a list of classes), sorted x, y, z. By default the lot's (the template box); `window: true` takes
   * the whole volume.
   */
  cellsOf(cls, { window = false } = {}) {
    const want = new Set((Array.isArray(cls) ? cls : [cls]).map((c) => {
      const k = String(c).toUpperCase();
      if (!VOXEL_CLASSES.includes(k)) throw new Error(`Site.cellsOf: unknown class ${JSON.stringify(c)} (one of ${VOXEL_CLASSES.join(', ')})`);
      return VOXEL_CLASSES.indexOf(k);
    }));
    const b = window ? this.bounds : { minX: 0, minY: 0, minZ: 0, maxX: this.size.x - 1, maxY: this.size.y - 1, maxZ: this.size.z - 1 };
    const out = [];
    for (let x = b.minX; x <= b.maxX; x++) for (let y = b.minY; y <= b.maxY; y++) for (let z = b.minZ; z <= b.maxZ; z++) {
      if (want.has(this.classIndex(x, y, z))) out.push([x, y, z]);
    }
    return out;
  }

  // ------------------------------------------------------------------ shapes

  /**
   * The vertical faces that meet the lot: per outward normal (north, south, east, west) and plane, the solid cells whose neighbour along
   * the normal is AIR inside the lot. `[{normal, at (the solid cells' coordinate along the normal's axis), axis ('x' or 'z'), u0, u1
   * (along the other horizontal axis), y0, y1, cells}]`, most cells first (ties: north, east, south, west, then the plane). Faces with
   * fewer than `min` cells are left out.
   */
  faces({ min = 4 } = {}) {
    const acc = new Map();
    for (let x = 0; x < this.size.x; x++) for (let y = 0; y < this.size.y; y++) for (let z = 0; z < this.size.z; z++) {
      if (this.at(x, y, z) !== 'AIR') continue;
      for (const n of H_DIRS) {
        const [dx, , dz] = VEC[n];
        const sx = x - dx, sz = z - dz; // the solid cell behind the air, its face pointing along n
        if (!this.solid(sx, y, sz)) continue;
        const axis = dx ? 'x' : 'z';
        const at = axis === 'x' ? sx : sz, u = axis === 'x' ? z : x;
        const k = `${n}|${at}`;
        const f = acc.get(k) ?? { normal: n, at, axis, u0: Infinity, u1: -Infinity, y0: Infinity, y1: -Infinity, cells: 0 };
        f.u0 = Math.min(f.u0, u); f.u1 = Math.max(f.u1, u); f.y0 = Math.min(f.y0, y); f.y1 = Math.max(f.y1, y); f.cells++;
        acc.set(k, f);
      }
    }
    return [...acc.values()].filter((f) => f.cells >= min)
      .sort((a, b) => b.cells - a.cells || H_DIRS.indexOf(a.normal) - H_DIRS.indexOf(b.normal) || a.at - b.at);
  }

  /** The face with this normal (the one with the most cells), or throws. */
  face(normal) {
    const f = this.faces().find((x) => x.normal === normal);
    if (!f) throw new Error(`Site: no ${normal}-facing face meets the lot (fit ${this.fit})`);
    return f;
  }

  /**
   * The host trunk: the lot's LOG cells. `{cx, cz, y0, y1, cells, radiusAt(y)}`: the centre column (the rounded mean of the logs),
   * the lowest and highest log rows inside the lot and the trunk's radius at a row (the farthest log from the centre, rounded up;
   * -1 on a row without logs). Throws when the lot holds no log (the wrong site for a trunk design).
   */
  trunk() {
    const logs = this.cellsOf('LOG');
    if (!logs.length) throw new Error(`Site: no trunk in the lot (no LOG cells; fit ${this.fit})`);
    const cx = Math.round(logs.reduce((s, c) => s + c[0], 0) / logs.length);
    const cz = Math.round(logs.reduce((s, c) => s + c[2], 0) / logs.length);
    const byY = new Map();
    for (const [x, y, z] of logs) byY.set(y, Math.max(byY.get(y) ?? 0, Math.ceil(Math.hypot(x - cx, z - cz) - 1e-9)));
    const ys = [...byY.keys()];
    return { cx, cz, y0: Math.min(...ys), y1: Math.max(...ys), cells: logs.length, radiusAt: (y) => byY.get(y) ?? -1 };
  }

  /**
   * Ledges: the lot's standing rows on the land (a solid cell with two AIR cells over it, the lower inside the lot), per standing row
   * (`y`: the feet row), most cells first: `[{y, cells, box: [x0, z0, x1, z1]}]`. Rows with fewer than `min` cells are left out.
   */
  ledges({ min = 4 } = {}) {
    const acc = new Map();
    for (let x = 0; x < this.size.x; x++) for (let z = 0; z < this.size.z; z++) for (let y = 0; y < this.size.y; y++) {
      if (this.at(x, y, z) !== 'AIR' || this.at(x, y + 1, z) !== 'AIR' || !this.solid(x, y - 1, z)) continue;
      const l = acc.get(y) ?? { y, cells: 0, box: [Infinity, Infinity, -Infinity, -Infinity] };
      l.cells++;
      l.box = [Math.min(l.box[0], x), Math.min(l.box[1], z), Math.max(l.box[2], x), Math.max(l.box[3], z)];
      acc.set(y, l);
    }
    return [...acc.values()].filter((l) => l.cells >= min).sort((a, b) => b.cells - a.cells || a.y - b.y);
  }

  /** The hang points (a suspend site's keep-critical cells), in design cells. */
  hangPoints() { return this.keepCritical.map((c) => [...c]); }

  /**
   * Where the graph arrives: the cell of the spec's port named `which`, or of its first port facing a side (`'w'`, `'west'`, `'d'`,
   * `'down'`, ...). `[x, y, z]` in design cells; throws when there is none.
   */
  portHint(which) {
    const p = this.port(which);
    return [...p.at];
  }

  /** The spec's port named `which` or facing a side (see portHint). */
  port(which) {
    const side = SIDE[which] ?? (VEC[which] ? which : null);
    const p = this.ports.find((q) => q.name === which) ?? (side ? this.ports.find((q) => q.facing === side) : undefined);
    if (!p) throw new Error(`Site: no port ${JSON.stringify(which)} (the spec has ${this.ports.map((q) => `${q.name} (${q.facing})`).join(', ') || 'none'})`);
    return p;
  }

  /** The fit's row of the fit table (lib/siteFits.mjs). */
  get fitRow() { return fitOf(this.fit); }

  /** A short summary (for logs and the build's JSON). */
  summary() {
    return { fit: this.fit, lotId: this.lotId, volumeSha: this.sha, size: { ...this.size }, frame: { origin: [...this.frame.origin], rotation: this.frame.rotation }, ports: this.ports.map((p) => p.name), keepCritical: this.keepCritical.length };
  }
}

/** The direction vector of a facing. */
export const facingVec = (f) => VEC[f];

// ------------------------------------------------------------------ composites (the renderer and the slices)

/** The block the renderer draws for a site class (render only: never written, so not themed). Air and MISSING draw nothing. */
export const SITE_STAND_IN = Object.freeze({
  ROCK: 'minecraft:stone', SOIL: 'minecraft:dirt', LOOSE: 'minecraft:gravel', ICE: 'minecraft:packed_ice', SNOW: 'minecraft:snow_block',
  WATER: 'minecraft:water', LAVA: 'minecraft:lava', LOG: 'minecraft:oak_log', LEAVES: 'minecraft:oak_leaves', PLANT: 'minecraft:short_grass',
  OWNED: 'minecraft:bricks', PLAYER: 'minecraft:cobblestone', BLOCK_ENTITY: 'minecraft:barrel',
});

/**
 * A plain structure (as lib/nbt.mjs plain() gives: {size, palette: [{id, properties}], blocks: [{pos, state}]}) of the template composited
 * with its site: the whole window (the template at `offset`, the margin round it), the template's written cells as written (its air
 * too) and every cell it leaves showing the site's class as a stand-in block (SITE_STAND_IN; exposed soil as grass). `cut` (optional)
 * drops every cell with a template z above it (a section through the lot). Returns {structure, offset: [dx, dy, dz]}.
 */
export function compositeStructure(structure, site, { cut = null } = {}) {
  const b = site.bounds;
  const off = [-b.minX, -b.minY, -b.minZ];
  const size = [b.maxX - b.minX + 1, b.maxY - b.minY + 1, b.maxZ - b.minZ + 1];
  const palette = structure.palette.map((p) => ({ id: p.id ?? p.Name, properties: { ...(p.properties ?? p.Properties ?? {}) } }));
  const written = new Map();
  for (const bl of structure.blocks) written.set(`${bl.pos[0]},${bl.pos[1]},${bl.pos[2]}`, bl.state);
  const standIn = new Map();
  const stateOf = (id, properties = {}) => {
    const k = `${id}${JSON.stringify(properties)}`;
    if (!standIn.has(k)) { standIn.set(k, palette.length); palette.push({ id, properties }); }
    return standIn.get(k);
  };
  const blocks = [];
  for (let y = b.minY; y <= b.maxY; y++) for (let z = b.minZ; z <= b.maxZ; z++) {
    if (cut !== null && z > cut) continue;
    for (let x = b.minX; x <= b.maxX; x++) {
      const pos = [x + off[0], y + off[1], z + off[2]];
      const w = site.inLot(x, y, z) ? written.get(`${x},${y},${z}`) : undefined;
      if (w !== undefined) { blocks.push({ pos, state: w }); continue; }
      const cls = site.at(x, y, z);
      let id = SITE_STAND_IN[cls];
      if (!id) continue;
      if (cls === 'SOIL' && site.at(x, y + 1, z) === 'AIR' && !(site.inLot(x, y + 1, z) && written.has(`${x},${y + 1},${z}`))) id = 'minecraft:grass_block';
      blocks.push({ pos, state: stateOf(id, cls === 'LOG' ? { axis: 'y' } : {}) });
    }
  }
  return { structure: { DataVersion: structure.DataVersion, size, palette, blocks, entities: [] }, offset: off };
}
