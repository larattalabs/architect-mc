// (6c T3b) Tunnels (docs/CONTRACT.md "Phase 6c slice T3" §3, §5, §6, §8; SETTLEMENTS §4.3, §8.2): a straight cardinal bore through
// rising ground, portal to portal. The floor profile, the cover (survey first, then the frozen volume's classes), the cut and bore
// cells, the shell with its lining, cave sealing and falling-block lining, the 2-cell fluid buffer, the portals, the lamps, the
// guard cells the approval artifact keeps (§6's stale rule), and the `r.tunnel` primitive. Plan time only, pure, integer math
// (Math.floor/abs/min/max): no clock, no random draw. This module imports nothing from the plan compiler or the region program
// (K1's cycle came from such an import); `r` is passed in.
//
// Reading of §3 (recorded in "T3b as built"): a tunnel of L floor cells (4..64) runs on a cardinal heading from the start walk cell
// (index 0) over the floor cells (1..L) to the landing walk cell (L + 1), both walk cells of the route at their surface block y
// (the feet on y + 1). The floor is K1b's profile with d = 0: y2(i) = floor((2 y0 L^2 + 2 rise i L) / L^2), so y2(L) is the
// landing's surface; an even y2 is a full floor block at y2 / 2, an odd one a bottom slab at floor(y2 / 2) + 1 over a full bed.
// Each floor cell holds `height` clear cells over it (deckY + 1 .. deckY + height). A floor cell is a **bore** cell when at least
// `cover` (2) site-solid cells lie over its void in every lane's column (counted up to the surface), else a **cut** cell: open
// above, its lanes carved to the surface. The longest bore run must hold at least 4 cells (else NO_COVER).
import { deckY, isSlab, latOn, rightOf, SITE_SOLID } from './ropeGeom.mjs';
import { shapeOf } from './style.mjs';
import { bomOf } from './bom.mjs';
import { fixtureFor, lightLevel } from '../region/fixtures.mjs';

/** The limits (catalogue 6: `connector.tunnel` limits; §4's move). Costs are in T2's units (a straight walk cell is 10). */
export const TUNNEL = Object.freeze({
  lengthMin: 4, lengthMax: 64, widthMin: 1, widthMax: 5, heightMin: 2, heightMax: 5,
  // defaults: 3 wide on a villager edge, 2 player-only; 3 clear
  widthVillager: 3, widthPlayer: 2, height: 3,
  cover: 2, boreMin: 4, fluidBuffer: 2, approach: 16, approachMax: 32,
  // the move's cost: 400 + 30 per floor cell (it wins only where the climb's grade, cut and hairpins cost more)
  cost: 400, costPer: 30,
  // §6: the corridor a tunnel edge asks a volume for, and the caps (past them: incomplete VOLUME)
  corridorPad: 3, corridorDown: 16, edgeCells: 4_000_000, planCells: 16_000_000,
  // the diagnosis scans this far for a bore that would land
  diagMax: 128,
});

/** §3: the largest |rise| a tunnel of L floor cells takes (else TOO_STEEP). */
export const maxRiseOf = (L) => Math.max(1, Math.floor(L / 8));

/** §3's floor: y2(i) for i = 0..L (K1b's profile with d = 0, one floor over the whole expression). */
export function floorProfile(L, y0, rise) {
  const nn = L * L, out = new Array(L + 1);
  for (let i = 0; i <= L; i++) out[i] = Math.floor((2 * y0 * nn + 2 * rise * i * L) / nn);
  return out;
}

/** Shell classes a tunnel lines (§3 Lining): everything but rock that can stand in a wall, roof or floor bed. */
export const LINED_CLASSES = Object.freeze(['SOIL', 'LOOSE', 'ICE', 'SNOW', 'LOG', 'LEAVES', 'PLANT']);
/** Classes a tunnel never writes or undercuts (§3: a player's or an owner's cell, a block entity). */
export const PROTECTED_CLASSES = Object.freeze(['OWNED', 'PLAYER', 'BLOCK_ENTITY']);
/** Fluid classes the buffer keeps away (§3 Fluids). */
export const FLUID_CLASSES = Object.freeze(['WATER', 'LAVA', 'ICE']);

const key = (x, y, z) => `${x},${y},${z}`;
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * The survey-first cover (§6): for each floor cell 1..L, the least over its lanes of the surveyed ground minus the void's top, and
 * whether it is a bore cell by that measure; `run` the longest bore run. `groundAt(x, z)`: the land's surface block y.
 */
export function surfaceCover(groundAt, a, dir, L, rise, width, height, cover = TUNNEL.cover) {
  const [x0, y0, z0] = a, [dx, dz] = dir, [rx, rz] = rightOf(dir), { lo, hi } = latOn(width, dir);
  const ys = floorProfile(L, y0, rise);
  const cv = new Array(L + 1).fill(0), bore = new Array(L + 1).fill(false);
  let run = 0, best = 0, bestAt = -1;
  for (let i = 1; i <= L; i++) {
    const top = deckY(ys[i]) + height;
    let m = Infinity;
    for (let v = lo; v <= hi; v++) m = Math.min(m, groundAt(x0 + dx * i + rx * v, z0 + dz * i + rz * v) - top);
    cv[i] = m;
    bore[i] = m >= cover;
    run = bore[i] ? run + 1 : 0;
    if (run > best) { best = run; bestAt = i - run + 1; }
  }
  return { ys, cover: cv, bore, run: best, runAt: bestAt };
}

/**
 * §6's corridor: the rect of the edge's two ends (feet cells [x, y, z]) dilated by `approach + width + 3`, with y from the lower
 * end's feet - 16 to the highest ground in the rect + 1 (`groundMax(x0, z0, x1, z1)`), clipped to the world's `minY`/`maxY` when
 * given. Integer functions of the plan and the survey, so the same inputs ask for the same volume. Returns the box and its cells.
 */
export function corridorBox(from, to, { approach = TUNNEL.approach, width = TUNNEL.widthVillager, groundMax, minY = -64, maxY = 319 } = {}) {
  const pad = approach + width + TUNNEL.corridorPad;
  const minX = Math.min(from[0], to[0]) - pad, maxX = Math.max(from[0], to[0]) + pad;
  const minZ = Math.min(from[2], to[2]) - pad, maxZ = Math.max(from[2], to[2]) + pad;
  const top = groundMax(minX, minZ, maxX, maxZ);
  const box = { minX, minY: Math.max(minY, Math.min(from[1], to[1]) - TUNNEL.corridorDown), minZ, maxX, maxY: Math.min(maxY, top + 1), maxZ };
  if (box.maxY < box.minY) box.maxY = box.minY;
  return { box, cells: (box.maxX - box.minX + 1) * (box.maxY - box.minY + 1) * (box.maxZ - box.minZ + 1) };
}

/**
 * A land for the tunnel checks over a plan survey api `S` (groundAt, missingAt, waterAt, frozenAt), the decoded frozen `volumes`
 * the plan holds, the program's `base` (a ridge it raises in an earlier stage: the cells between the survey's ground and the
 * base's are written full blocks M3 grounds, so ROCK), `blocked(x, z)` -> null | {class} (keep-out, protected areas, builds,
 * kept columns, other regions, lot boxes and aprons: columns at every depth), `routeLow(x, z)` -> the lowest cell another route
 * writes there (or null), and `wallAt(x, z)` -> null | {id, footing, sealed} (a K1 wall's column). `classAt` answers a volume's class
 * where one covers the cell, else the 2.5D estimate (soil to 3 under the ground, rock below, water down a water column); `known`
 * says whether the class came from a volume or from the plan's own writes (a tunnel needs every cell it reads known: else VOLUME).
 */
export function tunnelLand(S, { volumes = [], base = null, blocked = () => null, routeLow = () => null, wallAt = () => null, classOfVolume, written: writtenBoxes = [], kept = null } = {}) {
  // (a program's own earlier writes by class: [{box: [x0, y0, z0, x1, y1, z1], class}], e.g. crossings_demo's sand band in its raised
  // ridge; a written cell no box names is ROCK)
  const wb = (writtenBoxes ?? []).filter((q) => q && Array.isArray(q.box));
  const writtenClass = (x, y, z) => { for (let t = wb.length - 1; t >= 0; t--) { const b = wb[t].box; if (x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5]) return wb[t].class; } return 'ROCK'; };
  const writtenClassOf = writtenClass;
  const vols = volumes.filter(Boolean);
  const baseAt = (x, z) => {
    if (!base) return 0;
    const i = x - base.minX, j = z - base.minZ;
    return i >= 0 && j >= 0 && i < base.width && j < base.depth ? base.values[i + j * base.width] : 0;
  };
  const surveyGround = (x, z) => S.groundAt(x, z);
  const groundAt = (x, z) => surveyGround(x, z) + Math.max(0, baseAt(x, z));
  const fromVolume = (x, y, z) => {
    for (const v of vols) {
      const c = classOfVolume(v, x, y, z);
      if (c !== 'MISSING') return c;
    }
    return null;
  };
  // (a written cell counts as site-solid only when its class is: a written sand band is LOOSE)
  const raised = (x, y, z) => { const b = baseAt(x, z); return b > 0 && y > surveyGround(x, z) && y <= surveyGround(x, z) + b; };
  const written = (x, y, z) => raised(x, y, z) && ['ROCK', 'SOIL'].includes(writtenClassOf(x, y, z));
  const classAt = (x, y, z) => {
    if (raised(x, y, z)) return writtenClass(x, y, z);
    // a program's base lowers the land: the cells it carved are air
    const b = baseAt(x, z);
    if (b < 0 && y > surveyGround(x, z) + b && y <= surveyGround(x, z)) return 'AIR';
    const v = fromVolume(x, y, z);
    if (v !== null) return v;
    if (S.missingAt(x, z)) return 'MISSING';
    const g = surveyGround(x, z);
    if (y > g) return 'AIR';
    if (S.waterAt(x, z)) return S.frozenAt(x, z) && y === g ? 'ICE' : 'WATER';
    return y >= g - 3 ? 'SOIL' : 'ROCK';
  };
  // (the air over a column's surveyed top is known without a volume: the survey read that column, and nothing stands over its top
  // but a tree, whose crown it does not measure)
  const overTop = (x, y, z) => !S.missingAt(x, z) && !(S.treeAt && S.treeAt(x, z)) && y > groundAt(x, z);
  const known = (x, y, z) => raised(x, y, z) || (baseAt(x, z) < 0 && y > surveyGround(x, z) + baseAt(x, z) && y <= surveyGround(x, z)) || fromVolume(x, y, z) !== null || overTop(x, y, z);
  // ((6c KC, §4) the plan's bodies' hard cells ([[x, y, z]]): the fluid buffer counts them as it counts water)
  const keptSet = Array.isArray(kept) && kept.length ? new Set(kept.map(([x, y, z]) => key(x, y, z))) : null;
  return { groundAt, classAt, known, written, blocked, routeLow, wallAt, missingAt: (x, z) => S.missingAt(x, z), ...(keptSet ? { kept: (x, y, z) => keptSet.has(key(x, y, z)) } : {}) };
}

/**
 * Check one tunnel and give its cells (§3, §5): from the start walk cell `a` = [x, y0, z] (its surface block) on `dir` over L floor
 * cells to the landing at surface y0 + rise. `land`: tunnelLand's shape. `opts`: {width, height, lining: 'exposed' | 'all', portal:
 * 'arch' | 'plain', length: {min, max} (the part's), lampLevel (15), hanging (a lantern can hang: true), _unsafe: {cover, fluidBuffer,
 * noLining, noLamps}}. The checks, in the diagnosis order of §4: NO_COVER (survey first, then the volume's classes), SPAN,
 * TOO_STEEP, WATER (a WATER, LAVA or ICE cell within 2 of a void or floor cell; `evidence.kind`), PROTECTED (keep-out columns, an
 * OWNED, PLAYER or BLOCK_ENTITY cell in the void or the shell, a tree over a cut, a route over the roof with under 2 cells between,
 * a wall over the bore with under 2 between: `evidence.class`), VOLUME (a cell it must read that no volume holds). Returns
 * `{ok, code?, evidence?, ...}` and, when ok, the cells: `voids` [[x, y, z, class]], `floor` [[x, y, z, kind ('block' | 'slab' |
 * 'bed'), i, v]], `lined` [[x, y, z, why ('lining' | 'seal' | 'gravity' | 'face' | 'parapet')]], `portals` [{i, cells: [[x, y, z,
 * kind ('jamb' | 'lintel' | 'arch'), facing]]}], `lamps` [[x, y, z, kind ('hanging' | 'flush' | 'post'), i]], `posterns` [{wall,
 * cells}], `guard` (per-column y runs of the void, shell and buffer: [x, z, y0, y1, ...]), `bore`, `cuts`, `cover`, `carved`, `ys`.
 */
export function tunnelGeom(land, a, dir, L, rise, opts = {}) {
  const width = opts.width ?? TUNNEL.widthVillager, height = opts.height ?? TUNNEL.height;
  const u = opts._unsafe ?? {};
  const coverNeed = Number.isInteger(u.cover) ? u.cover : TUNNEL.cover;
  const buffer = Number.isInteger(u.fluidBuffer) ? u.fluidBuffer : TUNNEL.fluidBuffer;
  const lenMin = Math.max(TUNNEL.lengthMin, opts.length?.min ?? TUNNEL.lengthMin), lenMax = Math.min(TUNNEL.lengthMax, opts.length?.max ?? TUNNEL.lengthMax);
  const [x0, y0, z0] = a, [dx, dz] = dir, [rx, rz] = rightOf(dir), { lo, hi } = latOn(width, dir);
  const at = (i, v) => [x0 + dx * i + rx * v, z0 + dz * i + rz * v];
  // ---- NO_COVER from the survey first (§6): no line with surface cover needs the rock read
  const sc = surfaceCover(land.groundAt, a, dir, L, rise, width, height, coverNeed);
  if (sc.run < TUNNEL.boreMin) {
    return { ok: false, code: 'NO_COVER', evidence: { length: L, bore: sc.run, need: TUNNEL.boreMin, cover: coverNeed, from: [x0, y0, z0], to: [x0 + dx * (L + 1), y0 + rise, z0 + dz * (L + 1)], by: 'survey', message: `the ground over the line never stands ${height + coverNeed} over its floor for ${TUNNEL.boreMin} cells` } };
  }
  if (L < lenMin || L > lenMax) return { ok: false, code: 'SPAN', evidence: { length: L, min: lenMin, max: lenMax } };
  if (Math.abs(rise) > maxRiseOf(L)) return { ok: false, code: 'TOO_STEEP', evidence: { length: L, rise, max: maxRiseOf(L) } };
  const ys = sc.ys;
  const unknown = [];
  const cls = (x, y, z) => {
    const c = land.classAt(x, y, z);
    if (c === 'MISSING' || !land.known(x, y, z)) { if (unknown.length < 4096) unknown.push([x, y, z]); return c === 'MISSING' ? 'MISSING' : c; }
    return c;
  };
  const siteSolid = (x, y, z) => land.written(x, y, z) || SITE_SOLID.includes(land.classAt(x, y, z));
  // ---- the cover from the classes (site-solid cells over the void, up to the surface), bore and cut
  const cover = new Array(L + 1).fill(0), bore = new Array(L + 1).fill(false);
  let run = 0, best = 0;
  for (let i = 1; i <= L; i++) {
    const top = deckY(ys[i]) + height;
    let m = Infinity;
    for (let v = lo; v <= hi; v++) {
      const [x, z] = at(i, v), g = land.groundAt(x, z);
      let n = 0;
      for (let y = top + 1; y <= g; y++) { cls(x, y, z); if (siteSolid(x, y, z)) n++; }
      m = Math.min(m, n);
    }
    cover[i] = m === Infinity ? 0 : m;
    bore[i] = cover[i] >= coverNeed;
    run = bore[i] ? run + 1 : 0;
    best = Math.max(best, run);
  }
  if (best < TUNNEL.boreMin) {
    return { ok: false, code: 'NO_COVER', evidence: { length: L, bore: best, need: TUNNEL.boreMin, cover: coverNeed, from: [x0, y0, z0], by: 'volume', message: `fewer than ${coverNeed} site-solid cells over the roof for ${TUNNEL.boreMin} consecutive cells (sand, gravel and caves are not site-solid)` } };
  }
  // ---- the void (carved or clear), the floor, the shell
  const V = new Map(), F = new Map(), lined = new Map();
  const protect = [];
  let tree = null;
  for (let i = 1; i <= L; i++) {
    const fy = deckY(ys[i]), top = fy + height, slab = isSlab(ys[i]);
    for (let v = lo; v <= hi; v++) {
      const [x, z] = at(i, v);
      F.set(key(x, fy, z), [x, fy, z, slab ? 'slab' : 'block', i, v]);
      if (slab) F.set(key(x, fy - 1, z), [x, fy - 1, z, 'bed', i, v]);
      let y1 = top;
      if (!bore[i]) {
        // a cut: carved to the surface, and the plants and snow on it; a tree over a cut is never felled by a tunnel
        const g = land.groundAt(x, z);
        y1 = Math.max(top, g);
        for (let y = g + 1; y <= g + 2; y++) { const c = cls(x, y, z); if (c === 'PLANT' || c === 'SNOW') y1 = Math.max(y1, y); }
        for (let y = g + 1; y <= g + 12 && !tree; y++) { const c = land.classAt(x, y, z); if (c === 'LOG' || c === 'LEAVES') tree = { at: [x, y, z], class: c, cell: i }; }
      }
      for (let y = fy + 1; y <= y1; y++) V.set(key(x, y, z), [x, y, z, cls(x, y, z), i]);
    }
  }
  // ---- the shell: the face neighbours of the void outside it and the floor
  // (the cells over the walk cells at either end, slices 0 and L + 1, are the route's approach: its own cut clears them)
  const sliceOf = (x, z) => (x - x0) * dx + (z - z0) * dz;
  const S = new Map();
  for (const [x, y, z] of V.values()) for (const [ax, ay, az] of N6) {
    const k = key(x + ax, y + ay, z + az);
    const sl = sliceOf(x + ax, z + az);
    if (sl < 1 || sl > L) continue;
    if (!V.has(k) && !F.has(k) && !S.has(k)) S.set(k, [x + ax, y + ay, z + az]);
  }
  // ---- protection: keep-out columns, protected classes, a tree over a cut, routes and walls over the bore
  const cols = new Map();
  for (const m of [V, S]) for (const c of m.values()) { const kc = `${c[0]},${c[2]}`; const was = cols.get(kc); cols.set(kc, was === undefined ? c[1] : Math.max(was, c[1])); }
  const posterns = new Map();
  for (const [kc, ymax] of cols) {
    const [x, z] = kc.split(',').map(Number);
    const b = land.blocked(x, z);
    if (b) protect.push({ at: [x, z], class: b.class ?? 'KEEP_OUT', ...(b.id ? { id: b.id } : {}) });
    const rl = land.routeLow(x, z);
    if (rl !== null && rl !== undefined && rl - ymax - 1 < TUNNEL.cover) protect.push({ at: [x, rl, z], class: 'ROUTE', between: rl - ymax - 1 });
    const w = land.wallAt(x, z);
    if (w) {
      if (w.footing - ymax - 1 < TUNNEL.cover) protect.push({ at: [x, w.footing, z], class: 'WALL', wall: w.id, between: w.footing - ymax - 1 });
      else { const p = posterns.get(w.id) ?? { wall: w.id, sealed: !!w.sealed, cells: [] }; p.cells.push([x, z]); posterns.set(w.id, p); }
    }
  }
  for (const m of [V, S, F]) for (const c of m.values()) {
    const k = cls(c[0], c[1], c[2]);
    if (PROTECTED_CLASSES.includes(k)) protect.push({ at: [c[0], c[1], c[2]], class: k });
  }
  if (tree) protect.push({ at: tree.at, class: tree.class, message: 'a tree over the cut (a tunnel never fells one)' });
  // ---- lining (§3): every exposed soil-like shell cell under the surface, the caves breaching the shell sealed, rock raw unless 'all'
  const all = opts.lining === 'all';
  const isCut = (i) => i >= 1 && i <= L && !bore[i];
  for (const [x, y, z] of S.values()) {
    const g = land.groundAt(x, z);
    if (y > g) continue; // open air over the land (a cut's side above its walls, the hillside over a portal): never built into
    const c = cls(x, y, z);
    if (c === 'AIR') lined.set(key(x, y, z), [x, y, z, 'seal']);
    else if (LINED_CLASSES.includes(c) || (all && c === 'ROCK')) lined.set(key(x, y, z), [x, y, z, 'lining']);
  }
  // the cuts' parapets: one over the side's ground where the cut is at least 2 deep there (M8: no fall into the cut)
  for (let i = 1; i <= L; i++) {
    if (!isCut(i)) continue;
    const fy = deckY(ys[i]);
    for (const v of [lo - 1, hi + 1]) {
      const [x, z] = at(i, v), g = land.groundAt(x, z);
      if (g - fy >= 2 && !V.has(key(x, g + 1, z))) lined.set(key(x, g + 1, z), [x, g + 1, z, 'parapet']);
    }
  }
  // ---- the portals: jambs and a lintel at the first and last cell of every bore run (the arch steps the jambs' tops with
  // upside-down stairs facing the opening), and the hillside face around them lined one cell out
  const portals = [];
  const portalAt = (i, out) => {
    const fy = deckY(ys[i]), top = fy + height, cells = [];
    for (const v of [lo - 1, hi + 1]) for (let y = fy + 1; y <= top; y++) {
      const [x, z] = at(i, v);
      const arch = opts.portal !== 'plain' && y === top && height >= 3;
      cells.push([x, y, z, arch ? 'arch' : 'jamb', arch ? facingOf(v < lo ? [-rx, -rz] : [rx, rz]) : null]);
    }
    for (let v = lo - 1; v <= hi + 1; v++) { const [x, z] = at(i, v); cells.push([x, top + 1, z, 'lintel', null]); }
    for (const [x, y, z] of cells) lined.delete(key(x, y, z));
    // the face one out: the ring round the frame in the portal's plane
    for (let v = lo - 2; v <= hi + 2; v++) for (let y = fy; y <= top + 2; y++) {
      if (v >= lo - 1 && v <= hi + 1 && y <= top + 1) continue;
      const [x, z] = at(i, v), g = land.groundAt(x, z);
      if (y > g || V.has(key(x, y, z)) || F.has(key(x, y, z))) continue;
      const c = cls(x, y, z);
      if (c === 'AIR' || LINED_CLASSES.includes(c) || (all && c === 'ROCK')) lined.set(key(x, y, z), [x, y, z, 'face']);
    }
    // over a portal that opens on a cut, a parapet along the hillside's edge (M8: no fall from the hill into the cut)
    const o = i + out;
    if (o >= 1 && o <= L && !bore[o]) {
      for (let v = lo - 1; v <= hi + 1; v++) {
        const [x, z] = at(i, v), g = land.groundAt(x, z);
        if (g - fy >= 2 && !V.has(key(x, g + 1, z))) lined.set(key(x, g + 1, z), [x, g + 1, z, 'parapet']);
      }
    }
    portals.push({ i, out, cells });
  };
  for (let i = 1; i <= L; i++) {
    if (!bore[i]) continue;
    if (!bore[i - 1] || i === 1) portalAt(i, -1);
    if (i === L || !bore[i + 1]) portalAt(i, 1);
  }
  // ---- falling blocks (§3 Gravity, M3:gravity): a sand or gravel cell next to a cell the tunnel writes or carves, with the void or
  // air under it, would fall at the first neighbour update: it is lined (a fixed point, at most 8 rounds)
  const portalCells = new Set(portals.flatMap((p) => p.cells.map((c) => key(c[0], c[1], c[2]))));
  const touched = () => [...V.values(), ...F.values(), ...lined.values(), ...[...portalCells].map((k) => k.split(',').map(Number))];
  for (let round = 0; round < 64; round++) {
    let added = 0;
    for (const [x, y, z] of touched()) for (const [ax, ay, az] of N6) {
      const nx = x + ax, ny = y + ay, nz = z + az, k = key(nx, ny, nz);
      if (V.has(k) || F.has(k) || lined.has(k) || portalCells.has(k)) continue;
      if (land.classAt(nx, ny, nz) !== 'LOOSE' || ny > land.groundAt(nx, nz)) continue;
      const kb = key(nx, ny - 1, nz);
      // (a sand or gravel cell resting on a cell the tunnel rewrites is lined too: in game its support's rewrite let the sand above
      // a lined roof fall and vanish, T3b as built)
      const onWrite = ay === 1 && !V.has(kb);
      if (onWrite || V.has(kb) || (!F.has(kb) && !lined.has(kb) && !portalCells.has(kb) && land.classAt(nx, ny - 1, nz) === 'AIR')) { lined.set(k, [nx, ny, nz, 'gravity']); added++; }
    }
    if (!added) break;
  }
  // ---- the fluid buffer (§3 Fluids, M4:tunnel): no water, lava or ice within `buffer` (Chebyshev, 3D) of a void or floor cell
  const fluids = [], B = new Map();
  const near = [...V.values(), ...F.values()];
  for (const [x, y, z] of near) {
    for (let ax = -buffer; ax <= buffer; ax++) for (let ay = -buffer; ay <= buffer; ay++) for (let az = -buffer; az <= buffer; az++) {
      const k = key(x + ax, y + ay, z + az);
      if (!B.has(k)) B.set(k, [x + ax, y + ay, z + az]);
    }
  }
  for (const [x, y, z] of B.values()) {
    const c = cls(x, y, z);
    if (FLUID_CLASSES.includes(c)) fluids.push({ at: [x, y, z], class: c });
    else if (land.kept?.(x, y, z)) fluids.push({ at: [x, y, z], class: 'BODY' }); // ((6c KC) a plan body's cell: within the buffer too)
  }
  if (fluids.length) {
    fluids.sort((p, q) => p.at[1] - q.at[1] || p.at[0] - q.at[0] || p.at[2] - q.at[2]);
    const kinds = [...new Set(fluids.map((f) => f.class.toLowerCase()))].sort();
    return { ok: false, code: 'WATER', evidence: { kind: kinds[0] === 'ice' && kinds.length > 1 ? kinds[1] : kinds[0], kinds, buffer, cells: fluids.length, sample: fluids.slice(0, 16), length: L, from: [x0, y0, z0] } };
  }
  if (protect.length) {
    return { ok: false, code: 'PROTECTED', evidence: { class: protect[0].class, cells: protect.length, sample: protect.slice(0, 12), length: L, from: [x0, y0, z0] } };
  }
  if (unknown.length) {
    return { ok: false, code: 'VOLUME', evidence: { cells: unknown.length, sample: unknown.slice(0, 8), length: L, from: [x0, y0, z0], message: 'no frozen volume holds the corridor\'s rock (its chunks are not loaded or not generated, or it is past the cap)' } };
  }
  // ---- the lamps (M5: 0 dark spawnable floor cells): hanging lanterns from the roof in the bore (an edge lane, 2 clear under it),
  // a light block flush in the wall where the tunnel is 2 high or 1 wide, and in the cuts; one each side of every portal
  const lamps = [];
  if (!u.noLamps) {
    const level = Math.max(1, opts.lampLevel ?? 15);
    const hang = height >= 3 && width >= 2 && opts.hanging !== false;
    const reach = level - 1 - (width - 1) - (height - 1);
    const every = Math.max(2, Math.min(Math.floor((12 * level) / 15), 2 * reach));
    const lampAt = (i, side) => {
      const fy = deckY(ys[i]);
      if (bore[i] && hang) { const [x, z] = at(i, side > 0 ? hi : lo); return [x, fy + height, z, 'hanging', i]; }
      const v = side > 0 ? hi + 1 : lo - 1, [x, z] = at(i, v);
      const k = key(x, fy + 1, z);
      // flush in the wall when the wall stands there (a shell cell under the surface), else a fixture post on the side's ground
      if (!V.has(k) && fy + 1 <= land.groundAt(x, z)) return [x, fy + 1, z, 'flush', i];
      const g = land.groundAt(x, z);
      return V.has(key(x, g + 1, z)) || g + 1 > fy + height + 1 ? null : [x, g + 1, z, 'post', i];
    };
    const want = new Set();
    for (let i = 1 + Math.floor(every / 2) - 1; i <= L; i += every) want.add(Math.max(1, i));
    for (const p of portals) { want.add(p.i); const o = p.i + p.out; if (o >= 1 && o <= L) want.add(o); }
    let side = 1;
    for (const i of [...want].sort((p, q) => p - q)) {
      const l = lampAt(i, side) ?? lampAt(i, -side);
      if (l && !lamps.some((q) => q[0] === l[0] && q[1] === l[1] && q[2] === l[2])) { lamps.push(l); lined.delete(key(l[0], l[1], l[2])); }
      side = -side;
    }
  }
  // ---- a parapet or a lamp post standing on soil: its support lined too (grass under a block the tunnel writes would die to dirt
  // during a stand, a change the removal could not undo; E-normal's bar near a tunnel is 0)
  for (const c of [...lined.values()].filter((q) => q[3] === 'parapet').concat(lamps.filter((l) => l[3] === 'post'))) {
    const [x, y, z] = c, k = key(x, y - 1, z);
    if (V.has(k) || F.has(k) || lined.has(k) || portalCells.has(k)) continue;
    if (LINED_CLASSES.includes(land.classAt(x, y - 1, z)) && y - 1 <= land.groundAt(x, z)) lined.set(k, [x, y - 1, z, 'support']);
  }
  // ---- the guard cells (§6): the void, the shell and the buffer, as per-column y runs (sorted by x, z, y)
  const G = new Set();
  for (const m of [V, S, B, F]) for (const k of m.keys()) G.add(k);
  const byCol = new Map();
  for (const k of G) { const [x, y, z] = k.split(',').map(Number); const kc = `${x},${z}`; (byCol.get(kc) ?? byCol.set(kc, []).get(kc)).push(y); }
  const guard = [];
  for (const kc of [...byCol.keys()].sort((p, q) => { const [px, pz] = p.split(',').map(Number), [qx, qz] = q.split(',').map(Number); return px - qx || pz - qz; })) {
    const [x, z] = kc.split(',').map(Number), yl = byCol.get(kc).sort((p, q) => p - q);
    let s = yl[0], e = yl[0];
    for (let t = 1; t <= yl.length; t++) {
      if (t < yl.length && yl[t] === e + 1) { e = yl[t]; continue; }
      guard.push(x, z, s, e);
      if (t < yl.length) { s = yl[t]; e = yl[t]; }
    }
  }
  const voids = [...V.values()];
  const carved = voids.filter((c) => c[3] !== 'AIR').length;
  return {
    ok: true, ys, cover, bore, cuts: bore.map((b, i) => i >= 1 && !b), voids, floor: [...F.values()], lined: u.noLining ? [] : [...lined.values()].filter((c) => !lamps.some((l) => l[0] === c[0] && l[1] === c[1] && l[2] === c[2])),
    portals, lamps, posterns: [...posterns.values()], guard, carved, lo, hi, width, height, length: L, rise, from: [x0, y0, z0], dir: [dx, dz],
    to: [x0 + dx * (L + 1), y0 + rise, z0 + dz * (L + 1)],
  };
}

const FACING = { '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north' };
/** A horizontal unit vector's facing name. */
export const facingOf = ([ax, az]) => FACING[`${ax},${az}`] ?? 'north';

/**
 * The bible's tunnel roles (§7): lining `foundation`, then `structure`; portal `trim`; floor `path`, then `floor`; lamps the `light`
 * role. `roles`: the plan's role table; `cr`: the bible's `connectors.tunnel` member (role names). Returns role names (or blocks).
 */
export function tunnelRoles(roles, cr = {}) {
  const has = (n) => Object.prototype.hasOwnProperty.call(roles ?? {}, n);
  const pick = (given, chain, fallback) => (given && (has(given) || given.includes(':')) ? given : chain.find(has) ?? fallback);
  return {
    lining: pick(cr.lining, ['foundation', 'structure'], 'minecraft:stone_bricks'),
    portal: pick(cr.portal, ['trim'], 'minecraft:stone_bricks'),
    floor: pick(cr.floor, ['path', 'floor'], 'minecraft:gravel'),
    light: has('light') ? 'light' : 'minecraft:lantern',
  };
}

/**
 * The lantern a tunnel hangs (the bible's light when it is a lantern, else a lantern), and the light it sets flush in a wall: the
 * light role's own full block when it is one (a bollard fixture), else the same lantern standing in a niche (theme rest: never
 * glowstone).
 */
export function tunnelLights(lightBlock) {
  const name = String(lightBlock ?? 'minecraft:lantern').replace(/\[.*$/, '');
  const lantern = /(^|:)(soul_)?lantern$/.test(name) ? name : 'minecraft:lantern';
  const f = fixtureFor(name);
  const standing = `${lantern}[hanging=false,waterlogged=false]`;
  const flush = f.kind === 'bollard' ? f.light : standing;
  return { hanging: `${lantern}[hanging=true,waterlogged=false]`, standing, flush, level: Math.min(lightLevel(`${lantern}[hanging=true,waterlogged=false]`), lightLevel(flush)) || 15 };
}

/**
 * The primitive `r.tunnel(a, b, opts)` (§3): a tunnel from the start walk cell `a` = [x, y0, z] to the landing walk cell `b` (cardinal,
 * 5..65 apart; y the walk cells' surface blocks) in part `part` (a path part in `stage`). `opts`: {land (tunnelLand; default from the
 * program's survey and `volumes`), volumes (decoded, the program asked for), width, height, lining, portal, id, stage, part =
 * 'links', lining/portal/floor/light (roles or blocks: default §7's chains), movers, _unsafe}. Throws `TUNNEL <code>: ...` when a
 * check fails. Writes the carve (air), the floor (slabs on odd half blocks), the lining, the portals, the parapets and the lamps
 * (every cell ALWAYS_OURS: natural, or this region's own earlier stage), and records the tunnel in the plan meta's `tunnels` (the
 * checker's M3:tunnel and M4:tunnel read it). Returns the record.
 */
export function tunnel(r, a, b, opts = {}) {
  const what = `tunnel ${opts.id ?? ''}`.trim();
  const dx = Math.sign(b[0] - a[0]), dz = Math.sign(b[2] - a[2]);
  if ((dx !== 0) === (dz !== 0)) throw new Error(`${what}: the walk cells must lie on one axis (a straight cardinal bore)`);
  const L = Math.abs(b[0] - a[0]) + Math.abs(b[2] - a[2]) - 1, rise = b[1] - a[1], dir = [dx, dz];
  const width = opts.width ?? TUNNEL.widthVillager, height = opts.height ?? TUNNEL.height;
  if (!(Number.isInteger(width) && width >= TUNNEL.widthMin && width <= TUNNEL.widthMax)) throw new Error(`${what}: width must be ${TUNNEL.widthMin}..${TUNNEL.widthMax}`);
  if (!(Number.isInteger(height) && height >= TUNNEL.heightMin && height <= TUNNEL.heightMax)) throw new Error(`${what}: height must be ${TUNNEL.heightMin}..${TUNNEL.heightMax}`);
  const role = (name, fallback) => (Object.prototype.hasOwnProperty.call(r.roles, name) ? name : fallback);
  const rl = tunnelRoles(r.roles, r.ctx?.connectors?.tunnel ?? {});
  const liningB = r.material(opts.liningBlock ?? rl.lining, `${what} lining`);
  const portalB = r.material(opts.portalBlock ?? rl.portal, `${what} portal`);
  const floorB = r.material(opts.floorBlock ?? rl.floor, `${what} floor`);
  const lightB = r.material(opts.light ?? role('light', 'minecraft:lantern'), `${what} light`);
  const lights = tunnelLights(lightB);
  const land = opts.land;
  if (!land) throw new Error(`${what}: needs opts.land (tunnelLand over the plan survey and its frozen volumes)`);
  const g = tunnelGeom(land, a, dir, L, rise, { width, height, lining: opts.lining, portal: opts.portal, lampLevel: lights.level, _unsafe: opts._unsafe });
  if (!g.ok) throw Object.assign(new Error(`${what}: TUNNEL ${g.code}: ${g.evidence?.message ?? JSON.stringify(g.evidence).slice(0, 200)}`), { tunnel: g });
  const slab = shapeOf(floorB, 'slab');
  const stairs = shapeOf(portalB, 'stairs');
  const part = opts.part ?? 'links';
  // (6c RS-b) in survival the whole tunnel is written in its lining's stage (the route's, before the carve's in creative): its approach
  // cut, its lining, its carve and its portals are then one construction target per tile, built ring by ring (a later stage's tile
  // would wait for the earlier one whole, §6.3, and the approach's cut would stand open beside a portal not yet put down)
  const stage = r.ctx?.survival && opts.liningStage ? opts.liningStage : opts.stage;
  const p = r.parts.find((q) => q.id === part) ?? r.part(part, { stage, set: 'path' });
  (r.meta.parts[p.id] ??= {}).kind ??= 'path';
  const mats = [null, floorB, slab ? `${slab}[type=bottom,waterlogged=false]` : floorB, liningB, portalB, lights.hanging, lights.flush, lights.standing];
  const M = { air: 0, floor: 1, slab: 2, lining: 3, portal: 4, hanging: 5, flush: 6, post: 7 };
  // a parapet is the lining's wall block (M8: a barrier of 1.5, never a step), joined to its neighbouring parapets; without a wall
  // variant, the rail role's fence
  const wallB = shapeOf(liningB, 'wall') ?? null;
  const fenceB = wallB ? null : r.material(role('rail', 'minecraft:oak_fence'), `${what} parapet`);
  const par = new Set(g.lined.filter((c) => c[3] === 'parapet').map((c) => `${c[0]},${c[1]},${c[2]}`));
  const parapetState = (x, y, z) => {
    const n = (ax, az) => par.has(`${x + ax},${y},${z + az}`);
    const sides = { east: n(1, 0), west: n(-1, 0), south: n(0, 1), north: n(0, -1) };
    if (wallB) return `${wallB}[east=${sides.east ? 'low' : 'none'},north=${sides.north ? 'low' : 'none'},south=${sides.south ? 'low' : 'none'},up=true,waterlogged=false,west=${sides.west ? 'low' : 'none'}]`;
    return `${String(fenceB).replace(/\[.*$/, '')}[east=${sides.east},north=${sides.north},south=${sides.south},waterlogged=false,west=${sides.west}]`;
  };
  const archIdx = new Map();
  const matOf = (st) => { if (!archIdx.has(st)) { archIdx.set(st, mats.length); mats.push(st); } return archIdx.get(st); };
  const solid = [], walk = [], air = [];
  const lampAt = new Set(g.lamps.map((l) => `${l[0]},${l[1]},${l[2]}`));
  for (const [x, y, z, c] of g.voids) if (c !== 'AIR' && !lampAt.has(`${x},${y},${z}`)) air.push(x, z, y, y, M.air);
  for (const [x, y, z, kind] of g.floor) (kind === 'bed' ? solid : walk).push(x, z, y, y, kind === 'slab' && slab ? M.slab : M.floor);
  // (the lining, sealing and falling-block lining go first, in `liningStage` when the caller gives an earlier stage: every sand or
  // gravel cell the carve would leave over air is lined before the carve, whatever order a stage's cells are written in. (6c RS-b) Not
  // in survival: the lining and the carve are one construction target there, built ring by ring, each ring's carve behind its lining
  // (the mod's RegionTargets orders the cells; a later stage would wait for the whole lining first, §6.3))
  const early = opts.liningStage && opts.liningStage !== opts.stage && !r.ctx?.survival ? [] : solid;
  for (const [x, y, z, why] of g.lined) (why === 'parapet' ? solid : early).push(x, z, y, y, why === 'parapet' ? matOf(parapetState(x, y, z)) : M.lining);
  for (const pt of g.portals) for (const [x, y, z, kind, facing] of pt.cells) {
    if (kind === 'arch' && stairs) solid.push(x, z, y, y, matOf(`${stairs}[facing=${facing},half=top,shape=straight,waterlogged=false]`));
    else solid.push(x, z, y, y, M.portal);
  }
  for (const [x, y, z, kind] of g.lamps) solid.push(x, z, y, y, M[kind]);
  // ALWAYS_OURS (3): natural cells, or this region's own earlier stage (a ridge raised in `ground`), never another owner's
  if (early !== solid && early.length) {
    const lp = r.parts.find((q) => q.id === `${p.id}_lining`) ?? r.part(`${p.id}_lining`, { stage: opts.liningStage, set: 'path' });
    (r.meta.parts[lp.id] ??= {}).kind ??= 'path';
    lp.columns({ abs: 0 }, { abs: 0 }, early, mats, { cond: 3 });
  }
  if (air.length) p.columns({ abs: 0 }, { abs: 0 }, air, mats, { cond: 3 });
  if (solid.length) p.columns({ abs: 0 }, { abs: 0 }, solid, mats, { cond: 3 });
  if (walk.length) p.columns({ abs: 0 }, { abs: 0 }, walk, mats, { cond: 3, walk: true });
  const states = [];
  for (const cols of early === solid ? [solid, walk] : [early, solid, walk]) for (let t = 0; t < cols.length; t += 5) states.push(mats[cols[t + 4]]);
  const bom = bomOf(states);
  const id = opts.id ?? `${p.id}_tunnel_${(r.meta.tunnels?.length ?? 0) + 1}`;
  const xs = [], yz = [], zs = [];
  for (let t = 0; t < g.guard.length; t += 4) { xs.push(g.guard[t]); zs.push(g.guard[t + 1]); yz.push(g.guard[t + 2], g.guard[t + 3]); }
  const box = { minX: Math.min(...xs), minY: Math.min(...yz), minZ: Math.min(...zs), maxX: Math.max(...xs), maxY: Math.max(...yz), maxZ: Math.max(...zs) };
  const rec = {
    id, kind: 'tunnel', part: p.id, stage: p.stage, box, width, height, length: L, rise, from: [...a], to: [...b], dir, lo: g.lo, hi: g.hi, y2: g.ys,
    bore: g.bore.slice(1), cover: g.cover.slice(1), floor: g.floor.filter((c) => c[3] !== 'bed').map((c) => [c[0], c[1], c[2], c[3]]),
    voids: g.voids.map((c) => [c[0], c[1], c[2]]), portals: g.portals.map((q) => ({ i: q.i, out: q.out, cells: q.cells.map((c) => [c[0], c[1], c[2], c[3]]) })),
    lamps: g.lamps.map((c) => [c[0], c[1], c[2], c[3]]), lined: g.lined.length, carved: g.carved, guard: g.guard, posterns: g.posterns,
    lining: liningB, portal: portalB, floorBlock: floorB, light: lights.hanging, bom,
    // the floor blocks (feet one over: check.mjs's M5 over `cells`), and the journal's counts
    cells: g.floor.filter((c) => c[3] !== 'bed').map((c) => [c[0], c[1], c[2]]), counts: { carved: g.carved, lined: g.lined.length, written: (solid.length + walk.length + (early === solid ? 0 : early.length)) / 5 + g.carved },
    ...(early !== solid && early.length ? { liningPart: `${p.id}_lining`, liningStage: opts.liningStage } : {}),
    ...(opts.volume ? { volume: { ...opts.volume } } : {}),
    ...(opts.movers ? { movers: [...opts.movers] } : {}),
    ...(opts._unsafe ? { _unsafe: { ...opts._unsafe } } : {}),
  };
  (r.meta.tunnels ??= []).push(rec);
  return rec;
}
