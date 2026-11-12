// (7b SV, SETTLEMENTS §7.2) Helpers for terrain-merged forms, installed on Blueprint (lib/kit.mjs): ordinary kit code over the design's
// Site (`bp.site`, lib/site.mjs). Coordinates are design (= template) coordinates; every block comes from the palette's roles (or their
// stairs, slab, fence shapes) unless the caller passes one, so a palette or bible re-skins the result. Each helper skips the
// Blueprint's keep cells (bp.keep: the cells the template must not write) and the cells outside the template, and returns what it
// wrote.
//   ringDeck   an annular deck round a vertical axis (a trunk), with knee braces to the trunk and a rail
//   bracket    a knee brace from a face: a post against the face and upside-down stairs out from it
//   hangChain  a chain column hanging from a ceiling (the functional iron chain)
//   beamInto   a beam that runs until it ends 1 cell inside the site's solid
//   carveRoom  air in a box where the site is solid; exposed soil round it lined with the foundation role
//   facadeOnFace  a wall that follows a face's offsets (on the face's surface, or the first air cell in front of it)
//   stilts     posts from a deck down through air and water to the site's solid (or the template's floor row)
import { BLOCKS, qualify } from './blocks.mjs';

const VEC = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east' };
const LINE_SOFT = new Set(['SOIL', 'LOOSE', 'SNOW']);
/** The chain block a hanging house hangs from (26.3's iron chain; functional: connectors/style.mjs UNTHEMED_OK). */
export const CHAIN = 'minecraft:iron_chain';

const needSite = (bp, what) => {
  if (!bp.site) throw new Error(`${bp.id}: ${what} needs the design's site (new Blueprint({ site }))`);
  return bp.site;
};
const axisOf = (dir) => (dir === 'east' || dir === 'west' ? 'x' : 'z');

/** The props a block has (a role may be a block without an axis or a facing: those are dropped, as Blueprint.beam does). */
export function propsFor(block, props = {}) {
  const have = BLOCKS[qualify(block)]?.props ?? {};
  return Object.fromEntries(Object.entries(props).filter(([k, v]) => k in have && have[k].includes(String(v))));
}

/** Write one cell unless it is a keep cell or outside the template; returns whether it wrote. */
function put(bp, x, y, z, block, props = {}) {
  if (!bp.inBounds(x, y, z) || bp.isKeep(x, y, z)) return false;
  bp.set(x, y, z, block, propsFor(block, props));
  return true;
}

export const SITE_HELPERS = {
  /** Write a cell unless it is a keep cell or outside the template (the helpers' writer). Returns whether it wrote. */
  put(x, y, z, block, props) { return put(this, x, y, z, block, props); },

  /**
   * An annular deck on row `y` round the vertical axis through cell (cx, cz): the cells whose distance from the axis is in [r0, r1]
   * (r1 rounded half a cell out). Site-solid cells (the trunk) and keep cells are left. Options: `block` (default the floor role),
   * `rail` (a fence block on the outer edge one row up; default none), `brackets`: 'trunk' writes knee braces under the deck's inner
   * edge on the four axes (upside-down stairs facing the axis, `braceLen` rows deep, at most down to row 0). Returns {deck, rail,
   * braces} (cell lists).
   */
  ringDeck(cx, cz, r0, r1, y, { block = this.p.floor, rail = null, brackets = null, braceLen = 2 } = {}) {
    const site = this.site;
    const inRing = (x, z) => { const d = Math.hypot(x - cx, z - cz); return d >= r0 - 1e-9 && d <= r1 + 0.5; };
    const deck = [], railCells = [], braces = [];
    const R = Math.ceil(r1) + 1;
    for (let x = cx - R; x <= cx + R; x++) for (let z = cz - R; z <= cz + R; z++) {
      if (!inRing(x, z) || (site && site.solid(x, y, z))) continue;
      if (put(this, x, y, z, block)) deck.push([x, y, z]);
    }
    if (rail) {
      for (const [x, , z] of deck) {
        const d = Math.hypot(x - cx, z - cz);
        const edge = Object.values(VEC).some(([dx, dz]) => !inRing(x + dx, z + dz) && Math.hypot(x + dx - cx, z + dz - cz) > d);
        if (edge && put(this, x, y + 1, z, rail)) railCells.push([x, y + 1, z]);
      }
    }
    if (brackets === 'trunk') {
      for (const [dir, [dx, dz]] of Object.entries(VEC)) {
        // the brace starts at the first cell outside the trunk on its lowest row (k = 0, against the trunk); each next cell one out and
        // one up, the last just under the deck
        const y0 = y - braceLen;
        let r = Math.ceil(r0);
        while (r < r1 && (this.isKeep(cx + dx * r, Math.max(y0, 0), cz + dz * r) || (site && site.solid(cx + dx * r, Math.max(y0, 0), cz + dz * r)))) r++;
        for (let k = 0; k < braceLen; k++) {
          const yy = y0 + k, x = cx + dx * (r + k), z = cz + dz * (r + k);
          if (yy < 0) continue;
          if (put(this, x, yy, z, this.p.stairs, { facing: OPP[dir], half: 'top' })) braces.push([x, yy, z]);
        }
      }
    }
    return { deck, rail: railCells, braces };
  },

  /**
   * A knee brace from a face: (x, y, z) is the cell in front of the face (the face's solid is behind it, opposite `dir`, the way the
   * brace leans out). A post of `len` rows (the frame role) stands against the face from row y up, and upside-down stairs run out and up
   * from it (`len - 1` of them), the top one under row y + len. Returns {cells, bears} (bears: the solid cells behind the post).
   */
  bracket(x, y, z, dir, { len = 2, post = this.p.frame, stairs = this.p.stairs } = {}) {
    const [dx, dz] = VEC[dir] ?? (() => { throw new Error(`${this.id}: bracket: dir ${dir} must be horizontal`); })();
    const site = this.site;
    const cells = [];
    let bears = 0;
    for (let k = 0; k < len; k++) {
      if (put(this, x, y + k, z, post, { axis: 'y' })) cells.push([x, y + k, z]);
      if (site && site.solid(x - dx, y + k, z - dz)) bears++;
    }
    for (let k = 1; k < len; k++) {
      if (put(this, x + dx * k, y + k, z + dz * k, stairs, { facing: OPP[dir], half: 'top' })) cells.push([x + dx * k, y + k, z + dz * k]);
    }
    return { cells, bears };
  },

  /** A chain column at (x, z) from row yTop down to row yBottom (inclusive; the iron chain, axis y). Returns the cells. */
  hangChain(x, z, yTop, yBottom) {
    const out = [];
    for (let y = Math.max(yTop, yBottom); y >= Math.min(yTop, yBottom); y--) if (put(this, x, y, z, CHAIN, { axis: 'y' })) out.push([x, y, z]);
    return out;
  },

  /**
   * A beam from (x0, y, z0) along `dir`, through the cells the site leaves open, ending 1 cell inside the site's solid (that cell is
   * written too). `block` defaults to the frame role (a log along the beam's axis). Throws when the beam leaves the template, or meets a
   * keep cell, before reaching solid. Returns {cells, end}.
   */
  beamInto(x0, y, z0, dir, { block = this.p.frame } = {}) {
    const site = needSite(this, 'beamInto');
    const [dx, dz] = VEC[dir] ?? (() => { throw new Error(`${this.id}: beamInto: dir ${dir} must be horizontal`); })();
    const cells = [];
    for (let x = x0, z = z0; ; x += dx, z += dz) {
      if (!this.inBounds(x, y, z)) throw new Error(`${this.id}: beamInto(${x0},${y},${z0} ${dir}) leaves the template before it meets the site's solid`);
      if (this.isKeep(x, y, z)) throw new Error(`${this.id}: beamInto(${x0},${y},${z0} ${dir}) meets keep cell ${x},${y},${z}`);
      this.set(x, y, z, block, propsFor(block, { axis: axisOf(dir) }));
      cells.push([x, y, z]);
      if (site.solid(x, y, z)) return { cells, end: [x, y, z] };
    }
  },

  /**
   * A room cut into the site: air in `box` ([x0, y0, z0, x1, y1, z1]) where the site is solid (open cells stay unwritten: they are air
   * already), and every soil, loose or snow cell of the site touching the box (outside it, inside the template) lined with `lining`
   * (default the foundation role). Rock is left as the room's walls, floor and ceiling. Returns {carved, lined}.
   */
  carveRoom(box, { lining = this.p.foundation } = {}) {
    const site = needSite(this, 'carveRoom');
    const [x0, y0, z0, x1, y1, z1] = [Math.min(box[0], box[3]), Math.min(box[1], box[4]), Math.min(box[2], box[5]), Math.max(box[0], box[3]), Math.max(box[1], box[4]), Math.max(box[2], box[5])];
    const inBox = (x, y, z) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1;
    let carved = 0, lined = 0;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      if (site.solid(x, y, z) && put(this, x, y, z, 'minecraft:air')) carved++;
    }
    for (let x = x0 - 1; x <= x1 + 1; x++) for (let y = y0 - 1; y <= y1 + 1; y++) for (let z = z0 - 1; z <= z1 + 1; z++) {
      if (inBox(x, y, z)) continue;
      const faceAdj = [x < x0, x > x1, y < y0, y > y1, z < z0, z > z1].filter(Boolean).length === 1; // a face neighbour, not an edge
      if (!faceAdj || this.get(x, y, z) || !LINE_SOFT.has(site.at(x, y, z))) continue;
      if (put(this, x, y, z, lining)) lined++;
    }
    return { carved, lined };
  },

  /**
   * A wall on a face (`face` from site.faces() / site.face(normal)): for each column u in [u0, u1] and row y in [y0, y1] (default the
   * face's own extent), the cell on the face's surface (`out: 0`, the default: the outermost solid cell along the normal, replaced) or
   * the first open cell in front of it (`out: 1`). `block(u, y, cell)` may return a block id per cell (null: leave the cell), else
   * `wall` (default the wall role) is written. Returns the cells written.
   */
  facadeOnFace(face, { u0 = face.u0, u1 = face.u1, y0 = face.y0, y1 = face.y1, out = 0, wall = this.p.wall, block = null } = {}) {
    const site = needSite(this, 'facadeOnFace');
    const [nx, nz] = VEC[face.normal];
    const cells = [];
    for (let u = u0; u <= u1; u++) for (let y = y0; y <= y1; y++) {
      // walk along the normal from the face's plane to the last solid cell of this column (the face's offset here)
      let x = face.axis === 'x' ? face.at : u, z = face.axis === 'x' ? u : face.at;
      if (!site.solid(x, y, z)) continue; // the face does not reach this cell
      while (site.solid(x + nx, y, z + nz) && this.inBounds(x + nx, y, z + nz)) { x += nx; z += nz; }
      if (out) { x += nx * out; z += nz * out; }
      const b = block ? block(u, y, [x, y, z]) : wall;
      if (b && put(this, x, y, z, b)) cells.push([x, y, z]);
    }
    return cells;
  },

  /**
   * Posts under a deck: for each [x, z] of `points`, the frame role (axis y) from row `yTop` down through every cell the site leaves open
   * (air, water, plants), stopping above the first site-solid cell or at the template's floor row 0. Returns [{x, z, y0, y1, footing}]
   * (footing 'site' when the post stands on the site's solid, 'box' when it reached row 0).
   */
  stilts(points, yTop, { block = this.p.frame } = {}) {
    const site = needSite(this, 'stilts');
    const out = [];
    for (const [x, z] of points) {
      let y = yTop;
      let lowest = null;
      for (; y >= 0; y--) {
        if (site.solid(x, y, z)) break;
        if (put(this, x, y, z, block, { axis: 'y' })) lowest = y;
      }
      if (lowest !== null) out.push({ x, z, y0: lowest, y1: yTop, footing: y >= 0 ? 'site' : 'box' });
    }
    return out;
  },
};
