// Massing designs (docs/CONTRACT.md phase 4c, "Kit: massing designs"): coarse volumes, roof forms and major openings,
// no detail. A massing is an ordinary Blueprint with `massing: true`; every mass is a named part (bp.part), and the
// detail design keeps those part names and boxes (checkConformance below compares the two sidecars).
//
//   import { Blueprint, PALETTES } from '../lib/kit.mjs';
//   import { massing } from '../lib/massing.mjs';
//   const bp = new Blueprint({ id, type: 'tavern', size: [16, 17, 12], origin: [1, 0, 1], palette: p });
//   const m = massing(bp);                                         // sets bp.massing = true
//   m.mass('hall', [0, 0, 0, 13, 5, 8], { roof: 'gable', ridge: 'x', storeys: 1, roofPart: 'roof' });
//   m.opening('hall', 'south', [6, 1], [2, 2]);                     // a double door in the hall's south wall
//   m.stilts('piles', [0, -3, 0, 13, -1, 8], 4);                     // posts under a raised mass
//
// Materials are the palette's style-bible roles in flat form (bp.p.roles): a mass's shell in its `wall` role (default
// 'wall'; any role name, e.g. 'foundation' for a stone mass), the bottom row of a grounded mass in `foundation`, floors in
// `floor`, roofs in `roof` (its stairs and slabs on the slopes), openings in `glass`, doors in the palette's door, stilts
// in `frame`. A massing therefore reads in the bible's colours and re-skins with the palette.
import fs from 'node:fs';
import { DIR, OPPOSITE, ROOF_FORMS } from './kit.mjs';

const FACES = ['north', 'south', 'east', 'west'];
const isBox = (b) => Array.isArray(b) && b.length === 6 && b.every(Number.isInteger);
const norm = (b) => [Math.min(b[0], b[3]), Math.min(b[1], b[4]), Math.min(b[2], b[5]), Math.max(b[0], b[3]), Math.max(b[1], b[4]), Math.max(b[2], b[5])];

/** The block of a role in flat form: a full block where the role has one (glass -> the glass block, roof -> the roof block). */
export function roleBlock(p, role) {
  if (role === 'roof') return p.roofBlock;
  if (role === 'glass') return p.glass;
  const b = p.roles?.[role];
  if (!b) throw new Error(`massing: unknown role '${role}' (the palette has ${Object.keys(p.roles ?? {}).join(', ')})`);
  return b;
}

/** Start a massing on a Blueprint (marks it `massing: true`). */
export function massing(bp) {
  return new Massing(bp);
}

export class Massing {
  constructor(bp) {
    if (!bp || typeof bp.part !== 'function') throw new Error('massing(bp): bp must be a Blueprint');
    this.bp = bp;
    bp.massing = true;
    /** mass name -> { box (design coordinates), roof, ridge, storeys, wall } */
    this.masses = new Map();
  }

  get p() { return this.bp.p; }

  /**
   * A mass: a closed shell over `box` = [x0,y0,z0,x1,y1,z1] (design coordinates; y0 the floor row, y1 the top row, where
   * a sloped roof's eaves sit), with a roof form on top. Everything it writes is part `name` (the roof: part `roofPart`).
   * opts:
   *   roof     'gable' | 'hip' | 'flat' | 'shed' | 'none' (default 'none': a flat top in the wall role)
   *   ridge    'x' | 'z': the ridge (gable) or the high edge (shed) runs along this axis (default: the longer side)
   *   storeys  whole number >= 1 (default 1): floors inside at even heights, recorded on the part
   *   overhang cells the roof reaches past the walls (default 1 for gable/hip/shed, 0 for flat)
   *   wall     the role of the shell (default 'wall'); `foundation` for stone, `wall_alt` for plaster, ...
   *   roofPart the part the roof goes in (default `name`), e.g. 'roof' when the detail design keeps its roof apart
   *   high     shed only: the high side ('north'|'south'|'east'|'west', across the ridge axis; default the back)
   *   parapet  flat only: a ring of the wall role on the deck (default true); crenels: merlons on it (default false)
   * The roof form is recorded as `parts.<name>.roof` (and on `roofPart`), which massing conformance compares.
   */
  mass(name, box, { roof = 'none', ridge, storeys = 1, overhang, wall = 'wall', roofPart = name, high, parapet = true, crenels = false } = {}) {
    const bp = this.bp;
    if (!isBox(box)) throw new Error(`mass('${name}'): box must be [x0,y0,z0,x1,y1,z1] (whole numbers)`);
    const [x0, y0, z0, x1, y1, z1] = norm(box);
    if (!ROOF_FORMS.includes(roof)) throw new Error(`mass('${name}'): roof '${roof}' must be one of ${ROOF_FORMS.join(', ')}`);
    if (!Number.isInteger(storeys) || storeys < 1) throw new Error(`mass('${name}'): storeys must be a whole number >= 1`);
    if (y1 - y0 < 2 * storeys) throw new Error(`mass('${name}'): ${y1 - y0 + 1} rows is too low for ${storeys} storey(s) (a floor row, at least one free row and a top row per storey)`);
    if (ridge === undefined) ridge = x1 - x0 >= z1 - z0 ? 'x' : 'z';
    if (ridge !== 'x' && ridge !== 'z') throw new Error(`mass('${name}'): ridge must be 'x' or 'z'`);
    const o = overhang ?? (roof === 'flat' || roof === 'none' ? 0 : 1);
    if (!Number.isInteger(o) || o < 0 || o > 3) throw new Error(`mass('${name}'): overhang must be 0..3`);
    const p = this.p;
    const shell = roleBlock(p, wall);
    const grounded = y0 <= bp.feet - 1;
    bp.part(name, () => {
      // bottom row: the foundation on the ground, else a floor inside the shell
      if (grounded) bp.fill([x0, y0, z0, x1, y0, z1], roleBlock(p, 'foundation'));
      else {
        bp.fill([x0, y0, z0, x1, y0, z1], shell);
        if (x1 - x0 >= 2 && z1 - z0 >= 2) bp.fill([x0 + 1, y0, z0 + 1, x1 - 1, y0, z1 - 1], roleBlock(p, 'floor'));
      }
      if (x1 - x0 >= 2 && z1 - z0 >= 2 && y1 - y0 >= 2) bp.carve([x0 + 1, y0 + 1, z0 + 1, x1 - 1, y1 - 1, z1 - 1]);
      bp.walls(x0, z0, x1, z1, y0 + 1, y1, { block: shell, corners: null });
      if (x1 - x0 >= 2 && z1 - z0 >= 2) {
        bp.fill([x0 + 1, y1, z0 + 1, x1 - 1, y1, z1 - 1], shell); // the top
        for (let i = 1; i < storeys; i++) {
          const fy = y0 + Math.round((i * (y1 - y0)) / storeys);
          bp.fill([x0 + 1, fy, z0 + 1, x1 - 1, fy, z1 - 1], roleBlock(p, 'floor'));
        }
      }
    }, { storeys, roof });
    this.masses.set(name, { box: [x0, y0, z0, x1, y1, z1], roof, ridge, storeys, wall });
    if (roof === 'none') return this;
    bp.part(roofPart, () => {
      if (roof === 'gable') {
        bp.roofGable(x0 - o, z0 - o, x1 + o, z1 + o, y1, { ridge, pitch: 1, gable: shell, gableInset: o, gableFrom: y1 + 1 });
      } else if (roof === 'hip') {
        bp.roofHip(x0 - o, z0 - o, x1 + o, z1 + o, y1);
      } else if (roof === 'flat') {
        // the deck in the roof role; with a parapet its rim (and the ring above it) are the wall, so the walls run up clean
        bp.roofFlat(x0 - o, z0 - o, x1 + o, z1 + o, y1 + 1, { deck: p.roofBlock, parapet: parapet ? shell : null, crenels });
        if (parapet) bp.walls(x0 - o, z0 - o, x1 + o, z1 + o, y1 + 1, y1 + 1, { block: shell, corners: null });
      } else if (roof === 'shed') {
        this.#shed(name, [x0, z0, x1, z1], y1, { ridge, o, shell, high });
      }
    }, { roof });
    return this;
  }

  /** A shed roof: one slope at half pitch (stairs and top slabs) rising to the high side; the side walls close under it. */
  #shed(name, [x0, z0, x1, z1], y, { ridge, o, shell, high }) {
    const bp = this.bp;
    const p = this.p;
    // the slope runs across the ridge axis: ridge 'x' -> the slope climbs along z (north/south), 'z' -> along x
    const across = ridge === 'x' ? ['north', 'south'] : ['west', 'east'];
    if (high === undefined) high = across.includes(OPPOSITE[bp.front]) ? OPPOSITE[bp.front] : across[0];
    if (!across.includes(high)) throw new Error(`mass('${name}'): shed high side '${high}' must be ${across.join(' or ')} for ridge '${ridge}'`);
    const [a0, a1] = ridge === 'x' ? [z0 - o, z1 + o] : [x0 - o, x1 + o];
    const [b0, b1] = ridge === 'x' ? [x0 - o, x1 + o] : [z0 - o, z1 + o];
    const up = DIR[high];
    const rising = (up.dx + up.dz) > 0; // the slope rises towards +a
    const at = (a, b) => (ridge === 'x' ? [b, a] : [a, b]);
    const lining = [];
    for (let a = a0; a <= a1; a++) {
      const i = rising ? a - a0 : a1 - a;
      const dy = Math.floor(i / 2);
      for (let b = b0; b <= b1; b++) {
        const [x, z] = at(a, b);
        if (i % 2 === 0) bp.set(x, y + dy, z, p.roofStairs, { facing: high, half: 'bottom', shape: 'straight' });
        else bp.set(x, y + dy, z, p.roofSlab, { type: 'top' });
        if (dy > 0 && !bp.get(x, y + dy - 1, z)) lining.push([x, y + dy - 1, z]);
      }
      // the side walls (the wall planes at the ends of the ridge) close under the slope
      const [aw0, aw1] = ridge === 'x' ? [z0, z1] : [x0, x1];
      if (a >= aw0 && a <= aw1) {
        for (const b of ridge === 'x' ? [x0, x1] : [z0, z1]) {
          const [x, z] = at(a, b);
          for (let yy = y + 1; yy < y + dy; yy++) bp.set(x, yy, z, shell);
        }
      }
    }
    for (const [x, yy, z] of lining) if (!bp.get(x, yy, z)) bp.set(x, yy, z, p.roofBlock);
  }

  /**
   * A door or major opening in the `face` wall of mass `name` (its cells stay in that mass's part). `at` = [u, y]: u the
   * first column along the face (x on a north/south face, z on an east/west face), y the bottom row; `size` = [w, h]
   * (extending to +u and up). opts.kind: 'door' (doors on the bottom two rows, glass above; the default when the opening
   * starts on the mass's first feet row and is at least 2 tall), 'window' (glass; the default otherwise), 'arch' (open).
   */
  opening(name, face, at, size, { kind } = {}) {
    const m = this.masses.get(name);
    if (!m) throw new Error(`opening('${name}'): no mass '${name}' (masses: ${[...this.masses.keys()].join(', ') || 'none yet: call m.mass() first'})`);
    if (!FACES.includes(face)) throw new Error(`opening('${name}'): face '${face}' must be one of ${FACES.join(', ')}`);
    if (!Array.isArray(at) || at.length !== 2 || !at.every(Number.isInteger)) throw new Error(`opening('${name}'): at must be [u, y] (u = x on a north/south face, z on an east/west face)`);
    if (!Array.isArray(size) || size.length !== 2 || !size.every((n) => Number.isInteger(n) && n >= 1)) throw new Error(`opening('${name}'): size must be [w, h] (whole numbers >= 1)`);
    const [x0, y0, z0, x1, y1, z1] = m.box;
    const [u, y] = at;
    const [w, h] = size;
    const alongX = face === 'north' || face === 'south';
    const [lo, hi] = alongX ? [x0, x1] : [z0, z1];
    if (u <= lo || u + w - 1 >= hi) throw new Error(`opening('${name}', '${face}'): columns ${u}..${u + w - 1} must be inside the wall, between ${lo + 1} and ${hi - 1}`);
    if (y <= y0 || y + h - 1 >= y1) throw new Error(`opening('${name}', '${face}'): rows ${y}..${y + h - 1} must be between the floor and the top, ${y0 + 1}..${y1 - 1}`);
    const k = kind ?? (y === y0 + 1 && h >= 2 ? 'door' : 'window');
    if (!['door', 'window', 'arch'].includes(k)) throw new Error(`opening('${name}'): kind '${k}' must be door, window or arch`);
    const plane = { north: z0, south: z1, west: x0, east: x1 }[face];
    const cell = (i) => (alongX ? [u + i, plane] : [plane, u + i]);
    const p = this.p;
    this.bp.part(name, () => {
      for (let i = 0; i < w; i++) {
        const [x, z] = cell(i);
        for (let r = 0; r < h; r++) {
          if (k === 'arch') this.bp.air(x, y + r, z);
          else if (k === 'door' && r < 2) {
            if (r === 0) this.bp.door(x, y, z, face, { hinge: i % 2 ? 'right' : 'left', block: p.door, buttons: false });
          } else this.bp.set(x, y + r, z, p.glass);
        }
      }
    });
    return this;
  }

  /**
   * Stilts (piles, posts) in the frame role: a post every `spacing` cells over the footprint of `box` (the corners and the
   * far edges always get one), from row y0 to y1. Put a mass on top at y1 + 1. Part `name`.
   */
  stilts(name, box, spacing = 3) {
    if (!isBox(box)) throw new Error(`stilts('${name}'): box must be [x0,y0,z0,x1,y1,z1] (whole numbers)`);
    if (!Number.isInteger(spacing) || spacing < 1) throw new Error(`stilts('${name}'): spacing must be a whole number >= 1`);
    const [x0, y0, z0, x1, y1, z1] = norm(box);
    const line = (a0, a1) => {
      const out = [];
      for (let a = a0; a < a1; a += spacing) out.push(a);
      out.push(a1);
      return out;
    };
    this.bp.part(name, () => {
      for (const x of line(x0, x1)) for (const z of line(z0, z1)) this.bp.post(x, z, y0, y1, this.p.frame);
    });
    return this;
  }
}

// ==================================================================== conformance (detail vs its massing)

const FACE_NAMES = ['west (x0)', 'bottom (y0)', 'north (z0)', 'east (x1)', 'top (y1)', 'south (z1)'];

/**
 * Massing conformance (docs/CONTRACT.md phase 4c, with Steward's 4c review): a detail design's sidecar against its
 * massing's sidecar.
 *   errors: the detail's size is at most the massing's size + 2 on every axis (the size cap binds), and (6c 0a, C6)
 *     the front matches the massing's: a turned detail would stand turned on the lot the massing was fitted
 *     to (Sites.fitMassingToLot), so the round goes back to the designer
 *   issues (warnings): every massing part exists in the detail (extra parts are fine), each massing part's box is within
 *     1 of the detail part's box on every face, the size is not more than 2 under the massing's, the roof forms match
 *     where both record one (`parts.<name>.roof`), and (6c 0a, C6) the entrance column (anchors.entrance: x on a
 *     north/south front, z on an east/west one) is within 1 of the massing's where both have an entrance
 * Boxes and anchors are template coordinates, so both templates are compared from their minimum corners.
 * @returns {{ ok: boolean, errors: string[], issues: string[], compared: { parts: number, roofs: number, entrance: boolean } }}
 */
export function checkConformance(detail, massing) {
  const errors = [];
  const issues = [];
  const compared = { parts: 0, roofs: 0, entrance: false };
  if (!massing || typeof massing !== 'object') return { ok: false, errors: ['the massing sidecar is not an object'], issues, compared };
  if (massing.massing !== true) issues.push(`the reference sidecar '${massing.id}' is not a massing (no massing: true)`);
  const ds = detail.size ?? {};
  const ms = massing.size ?? {};
  for (const a of ['x', 'y', 'z']) {
    if (!Number.isInteger(ds[a]) || !Number.isInteger(ms[a])) { errors.push(`size: ${a} missing in ${!Number.isInteger(ds[a]) ? 'the design' : 'the massing'}`); continue; }
    if (ds[a] > ms[a] + 2) errors.push(`size: ${a} is ${ds[a]}, over the massing's ${ms[a]} + 2 (the approved massing caps the size)`);
    else if (ds[a] < ms[a] - 2) issues.push(`size: ${a} is ${ds[a]}, more than 2 under the massing's ${ms[a]}`);
  }
  // (6c 0a, C6) the front and the entrance column: what Sites.fitToLot turns and centres by
  const df = String(detail.front ?? 'south').toLowerCase();
  const mf = String(massing.front ?? 'south').toLowerCase();
  if (df !== mf) errors.push(`front: the design faces ${df}, the massing ${mf} (keep the massing's front: it would stand turned on its lot)`);
  else {
    const de = detail.anchors?.entrance;
    const me = massing.anchors?.entrance;
    const axis = mf === 'east' || mf === 'west' ? 'z' : 'x';
    if (Number.isFinite(de?.[axis]) && Number.isFinite(me?.[axis])) {
      compared.entrance = true;
      const dc = Math.floor(de[axis]);
      const mc = Math.floor(me[axis]);
      if (Math.abs(dc - mc) > 1) issues.push(`entrance: column ${axis}=${dc} is ${dc - mc > 0 ? '+' : ''}${dc - mc} off the massing's ${axis}=${mc} (more than 1; it moves the building on its lot)`);
    }
  }
  const mp = massing.parts && typeof massing.parts === 'object' ? massing.parts : {};
  const dp = detail.parts && typeof detail.parts === 'object' ? detail.parts : {};
  if (!Object.keys(mp).length) issues.push('the massing has no named parts to keep');
  for (const [n, m] of Object.entries(mp)) {
    const d = dp[n];
    if (!d) { issues.push(`part '${n}' is missing (keep the massing's part names: bp.part('${n}', ...); detail parts: ${Object.keys(dp).join(', ') || 'none'})`); continue; }
    compared.parts++;
    if (isBox(m.box) && isBox(d.box)) {
      const off = m.box.map((v, i) => [i, d.box[i] - v]).filter(([, dv]) => Math.abs(dv) > 1);
      if (off.length) issues.push(`part '${n}': box [${d.box.join(',')}] is off the massing's [${m.box.join(',')}] by more than 1 on ${off.map(([i, dv]) => `${FACE_NAMES[i]} ${dv > 0 ? '+' : ''}${dv}`).join(', ')}`);
    } else issues.push(`part '${n}': no box to compare`);
    if (m.roof !== undefined && d.roof !== undefined) {
      compared.roofs++;
      if (m.roof !== d.roof) issues.push(`part '${n}': roof '${d.roof}' but the massing has '${m.roof}'`);
    }
  }
  return { ok: !errors.length && !issues.length, errors, issues, compared };
}

/** Read a massing sidecar for `--massing <file>` (throws with the reason: missing, not JSON, not a massing's sidecar object). */
export function readMassingArg(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error(`--massing: cannot read ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`); }
  let s;
  try { s = JSON.parse(text); } catch (e) { throw new Error(`--massing: ${file} is not JSON (${e.message})`); }
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`--massing: ${file} is not a sidecar object`);
  return s;
}
