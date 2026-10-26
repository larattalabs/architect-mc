// (7a RK) Rock stairs (docs/CONTRACT.md "Phase 7a slice RK" §2, §5, §6; SETTLEMENTS §8.2 "landings every 8"): a straight cardinal stair
// flight carved or bored into rising ground, from a start walk cell to a landing walk cell `rise` above (or below) it. It is T3b's
// tunnel inclined: the same cover, cut and bore, shell, lining, sealing, gravity, fluid buffer, protection, portals and guard cells,
// re-derived here per tread against the flight's stepped void (tunnelGeom's floor is K1b's half-block profile and it refuses a bore
// under 4 cells or a rise over L / 8, neither of which holds for a stair). Plan time only, pure, integer math (Math.floor/abs/min/max):
// no clock, no random draw. This module imports nothing from the plan compiler, the region program or the route pass (K1's cycle).
//
// The flight (§2): `rise` steps of 1 a cell, with a 2-cell flat landing after every `landing` steps (default 8) while steps remain.
// Its horizontal length L = |rise| + 2 floor((|rise| - 1) / landing) floor cells (1..L) between the start walk cell (index 0, surface
// y0) and the landing walk cell (L + 1, surface y0 + rise). The profile is always built from the lower end (a flight routed down writes
// exactly the cells of the same flight routed up): counted from the lower end, tread j stands at the lower walk cell's surface plus the
// steps among treads 1..j, so the tread beside the lower walk cell stands 1 over it and the tread beside the upper one level with it.
// A step tread is the tread role's stairs block facing up the flight (half bottom); a landing tread its full block. Each tread holds
// `height` clear cells over it (y + 1 .. y + height). Carved, not built: the cell under every tread is site-solid (ROCK, SOIL, or the
// plan's own written rock), or a single cell of anything but fluid over site-solid ground (filled with the lining: the "grounded fill
// of at most 1"); else ANCHOR {why: tread}. A tread is a **bore** tread where at least 2 site-solid cells lie over its void in every
// lane (counted up to the surface), else a **cut** tread, open above (its lanes carved to the surface) with parapets where a side
// stands 2 or more over the tread (M8). A rock stair needs no bore: an all-cut flight is a stair cut into the hillside.
import { latOn, rightOf, SITE_SOLID } from './ropeGeom.mjs';
import { FLUID_CLASSES, LINED_CLASSES, PROTECTED_CLASSES, TUNNEL, facingOf, tunnelLights, tunnelRoles } from './tunnelGeom.mjs';
import { shapeOf } from './style.mjs';
import { bomOf } from './bom.mjs';
import { BLOCKS } from '../blocks.mjs';

/** The limits (§1) and the move's cost (§4; T2's units, a straight walk cell 10). */
export const ROCK = Object.freeze({
  riseMin: 2, riseMax: 48, widthMin: 1, widthMax: 3, width: 2, heightMin: 2, heightMax: 4, height: 3,
  landing: 8, landingMin: 4, landingMax: 12, landingCells: 2, approach: 16, approachMax: 32,
  cover: 2, fluidBuffer: 2, fill: 1,
  cost: 400, costStep: 40, costLanding: 30,
  // the diagnosis looks this far past the part's rise for a flight that would land (SPAN when only those fit)
  diagMax: 96,
});
/** §4's refusals in the row's order (a candidate further through it is the better diagnosis). */
export const ROCK_ORDER = Object.freeze(['NO_CLIMB', 'SPAN', 'ANCHOR', 'WATER', 'PROTECTED', 'VOLUME']);

/** The number of landings in a flight of `steps` steps (a landing after every `landing` steps while steps remain). */
export const landingsOf = (steps, landing = ROCK.landing) => (steps >= 1 ? Math.floor((steps - 1) / landing) : 0);
/** A flight's floor cells: its steps plus 2 cells per landing. */
export const flightLength = (rise, landing = ROCK.landing) => Math.abs(rise) + ROCK.landingCells * landingsOf(Math.abs(rise), landing);
/** The move's cost (§4): 400 + 40 a step + 30 a landing cell. */
export const flightCost = (rise, landing = ROCK.landing) => ROCK.cost + ROCK.costStep * Math.abs(rise) + ROCK.costLanding * ROCK.landingCells * landingsOf(Math.abs(rise), landing);

/**
 * §2's profile: `ys[0..L+1]` the surface y of the start walk cell, the treads 1..L and the landing walk cell, `kinds[1..L]` ('step' |
 * 'landing'), built from the lower end. `up` is +1 when the flight rises along its heading, -1 when it falls.
 */
export function flightProfile(y0, rise, landing = ROCK.landing) {
  const n = Math.abs(rise), L = flightLength(rise, landing), yLow = Math.min(y0, y0 + rise);
  const low = new Array(L + 1), kind = new Array(L + 1);
  let steps = 0, run = 0, flat = 0;
  for (let j = 1; j <= L; j++) {
    if (flat > 0) { kind[j] = 'landing'; flat--; } else {
      steps++; run++; kind[j] = 'step';
      if (run === landing && steps < n) { flat = ROCK.landingCells; run = 0; }
    }
    low[j] = yLow + steps;
  }
  const ys = new Array(L + 2), kinds = new Array(L + 1);
  ys[0] = y0; ys[L + 1] = y0 + rise;
  for (let i = 1; i <= L; i++) { const j = rise >= 0 ? i : L + 1 - i; ys[i] = low[j]; kinds[i] = kind[j]; }
  return { L, ys, kinds, steps: n, landings: landingsOf(n, landing), up: rise >= 0 ? 1 : -1 };
}

const key = (x, y, z) => `${x},${y},${z}`;
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * The light reach of a lamp along a flight (cells either side it keeps lit): block light falls off 1 a cell over the taxicab
 * distance, and on a flight each step down from a lamp adds a block of height to it. A lamp `height` over a tread (or flush at the
 * feet) reaches d treads down when 2d + height + width - 2 <= level - 2 (one level spare). So every tread lies within `reach` of a lamp.
 */
export const lampReach = (level, width, height) => Math.max(1, Math.floor((level - height - width) / 2));

/**
 * Check one flight and give its cells (§2, §5): from the start walk cell `a` = [x, y0, z] (its surface block) on cardinal `dir` to the
 * landing walk cell at surface y0 + rise. `land`: tunnelGeom's tunnelLand shape (groundAt, classAt, known, written, blocked, routeLow,
 * wallAt, kept?). `opts`: {width, height, landing, lining: 'exposed' | 'all', portal: 'arch' | 'plain', rise: {min, max} (the part's),
 * lampLevel (15), hanging (a lantern can hang: true), _unsafe: {cover, fluidBuffer, noLining, noLamps, noFill}}. The checks in §4's
 * order: NO_CLIMB (|rise| under 2), SPAN (|rise| outside the part's 2..48), ANCHOR (a tread over air or deeper fill: `evidence.why`
 * 'tread'), WATER (WATER, LAVA or ICE, or a plan body's cell, within 2 of a void or tread cell; `evidence.kind`), PROTECTED (keep-out
 * columns, an OWNED, PLAYER or BLOCK_ENTITY cell in the void, shell or treads, a tree over a cut, a route or a wall over the roof with
 * under 2 between: `evidence.class`), VOLUME (a cell it must read that no volume holds). Returns `{ok, code?, evidence?}` and, when ok,
 * the cells: `voids` [[x, y, z, class, i]], `floor` [[x, y, z, kind ('step' | 'landing' | 'bed'), i, v]], `lined` [[x, y, z, why
 * ('lining' | 'seal' | 'gravity' | 'face' | 'parapet' | 'support')]], `portals` [{i, out, cells: [[x, y, z, kind, facing]]}], `lamps`
 * [[x, y, z, kind ('hanging' | 'flush' | 'post'), i]], `guard` (per-column y runs of the void, shell, treads and buffer), `bore`,
 * `cuts`, `cover`, `carved`, `ys`, `kinds`, `facing` (the stairs' facing: up the flight).
 */
export function rockStairGeom(land, a, dir, rise, opts = {}) {
  const width = opts.width ?? ROCK.width, height = opts.height ?? ROCK.height, landing = opts.landing ?? ROCK.landing;
  const u = opts._unsafe ?? {};
  const coverNeed = Number.isInteger(u.cover) ? u.cover : ROCK.cover;
  const buffer = Number.isInteger(u.fluidBuffer) ? u.fluidBuffer : ROCK.fluidBuffer;
  const rMin = Math.max(ROCK.riseMin, opts.rise?.min ?? ROCK.riseMin), rMax = Math.min(ROCK.riseMax, opts.rise?.max ?? ROCK.riseMax);
  const [x0, y0, z0] = a, [dx, dz] = dir, [rx, rz] = rightOf(dir), { lo, hi } = latOn(width, dir);
  const at = (i, v) => [x0 + dx * i + rx * v, z0 + dz * i + rz * v];
  const n = Math.abs(rise);
  const ends = { from: [x0, y0, z0] };
  if (n < ROCK.riseMin) return { ok: false, code: 'NO_CLIMB', evidence: { rise, need: ROCK.riseMin, ...ends } };
  if (n < rMin || n > rMax) return { ok: false, code: 'SPAN', evidence: { rise, min: rMin, max: rMax, ...ends } };
  const P = flightProfile(y0, rise, landing);
  const { L, ys, kinds } = P;
  ends.to = [x0 + dx * (L + 1), y0 + rise, z0 + dz * (L + 1)];
  const unknown = [];
  const cls = (x, y, z) => {
    const c = land.classAt(x, y, z);
    if (c === 'MISSING' || !land.known(x, y, z)) { if (unknown.length < 4096) unknown.push([x, y, z]); }
    return c;
  };
  const siteSolid = (x, y, z) => land.written(x, y, z) || SITE_SOLID.includes(land.classAt(x, y, z));
  // ---- the tread rule (§2 "carved, not built"): site-solid under every tread, or one cell of fill over site-solid ground
  const F = new Map();
  for (let i = 1; i <= L; i++) {
    const fy = ys[i];
    for (let v = lo; v <= hi; v++) {
      const [x, z] = at(i, v);
      F.set(key(x, fy, z), [x, fy, z, kinds[i], i, v]);
      cls(x, fy - 1, z);
      if (siteSolid(x, fy - 1, z)) continue;
      const c1 = land.classAt(x, fy - 1, z);
      if (!u.noFill && !FLUID_CLASSES.includes(c1) && siteSolid(x, fy - 2, z)) { cls(x, fy - 2, z); F.set(key(x, fy - 1, z), [x, fy - 1, z, 'bed', i, v]); continue; }
      return { ok: false, code: 'ANCHOR', evidence: { why: 'tread', at: [x, fy, z], under: c1, tread: i, rise, ...ends, message: `tread ${i} stands over ${c1 === 'AIR' ? 'air' : c1.toLowerCase()} deeper than ${ROCK.fill} cell: a stair standing on fill is a built stair (connector.stair), not a rock stair` } };
    }
  }
  // ---- the cover from the classes (site-solid cells over each tread's void, up to the surface): bore and cut
  const cover = new Array(L + 1).fill(0), bore = new Array(L + 1).fill(false);
  for (let i = 1; i <= L; i++) {
    const top = ys[i] + height;
    let m = Infinity;
    for (let v = lo; v <= hi; v++) {
      const [x, z] = at(i, v), g = land.groundAt(x, z);
      let c = 0;
      for (let y = top + 1; y <= g; y++) { cls(x, y, z); if (siteSolid(x, y, z)) c++; }
      m = Math.min(m, c);
    }
    cover[i] = m === Infinity ? 0 : m;
    bore[i] = cover[i] >= coverNeed;
  }
  // ---- the void (carved or clear) over each tread
  const V = new Map();
  let tree = null;
  for (let i = 1; i <= L; i++) {
    const fy = ys[i], top = fy + height;
    for (let v = lo; v <= hi; v++) {
      const [x, z] = at(i, v);
      let y1 = top;
      if (!bore[i]) {
        // a cut: carved to the surface and the plants and snow on it; a tree over a cut is never felled by a rock stair
        const g = land.groundAt(x, z);
        y1 = Math.max(top, g);
        for (let y = g + 1; y <= g + 2; y++) { const c = cls(x, y, z); if (c === 'PLANT' || c === 'SNOW') y1 = Math.max(y1, y); }
        for (let y = g + 1; y <= g + 12 && !tree; y++) { const c = land.classAt(x, y, z); if (c === 'LOG' || c === 'LEAVES') tree = { at: [x, y, z], class: c, tread: i }; }
      }
      for (let y = fy + 1; y <= y1; y++) V.set(key(x, y, z), [x, y, z, cls(x, y, z), i]);
    }
  }
  // ---- the shell: the face neighbours of the void outside it and the treads (slices 1..L; the cells over the walk cells at either
  // end are the route's approach: its own cut clears them)
  const sliceOf = (x, z) => (x - x0) * dx + (z - z0) * dz;
  const S = new Map();
  for (const [x, y, z] of V.values()) for (const [ax, ay, az] of N6) {
    const k = key(x + ax, y + ay, z + az);
    const sl = sliceOf(x + ax, z + az);
    if (sl < 1 || sl > L) continue;
    if (!V.has(k) && !F.has(k) && !S.has(k)) S.set(k, [x + ax, y + ay, z + az]);
  }
  // ---- protection: keep-out columns, protected classes, a tree over a cut, routes and walls over the roof (no postern: a wall over
  // a rock stair is protected)
  const protect = [];
  const cols = new Map();
  for (const m of [V, S, F]) for (const c of m.values()) { const kc = `${c[0]},${c[2]}`; const was = cols.get(kc); cols.set(kc, was === undefined ? c[1] : Math.max(was, c[1])); }
  for (const [kc, ymax] of cols) {
    const [x, z] = kc.split(',').map(Number);
    const b = land.blocked(x, z);
    if (b) protect.push({ at: [x, z], class: b.class ?? 'KEEP_OUT', ...(b.id ? { id: b.id } : {}) });
    const rl = land.routeLow(x, z);
    if (rl !== null && rl !== undefined && rl - ymax - 1 < ROCK.cover) protect.push({ at: [x, rl, z], class: 'ROUTE', between: rl - ymax - 1 });
    const w = land.wallAt(x, z);
    if (w && w.footing - ymax - 1 < ROCK.cover) protect.push({ at: [x, w.footing, z], class: 'WALL', wall: w.id, between: w.footing - ymax - 1 });
  }
  for (const m of [V, S, F]) for (const c of m.values()) {
    const k = cls(c[0], c[1], c[2]);
    if (PROTECTED_CLASSES.includes(k)) protect.push({ at: [c[0], c[1], c[2]], class: k });
  }
  if (tree) protect.push({ at: tree.at, class: tree.class, message: 'a tree over the cut (a rock stair never fells one)' });
  // ---- lining: every exposed soil-like shell cell under the surface, the caves breaching the shell sealed, rock raw unless 'all'
  const lined = new Map();
  const all = opts.lining === 'all';
  for (const [x, y, z] of S.values()) {
    if (y > land.groundAt(x, z)) continue; // open air over the land: never built into
    const c = cls(x, y, z);
    if (c === 'AIR') lined.set(key(x, y, z), [x, y, z, 'seal']);
    else if (LINED_CLASSES.includes(c) || (all && c === 'ROCK')) lined.set(key(x, y, z), [x, y, z, 'lining']);
  }
  // the cuts' parapets: one over the side's ground where it stands at least 2 over the tread there (M8: no fall into the cut)
  for (let i = 1; i <= L; i++) {
    if (bore[i]) continue;
    const fy = ys[i];
    for (const v of [lo - 1, hi + 1]) {
      const [x, z] = at(i, v), g = land.groundAt(x, z);
      if (g - fy >= 2 && !V.has(key(x, g + 1, z))) lined.set(key(x, g + 1, z), [x, g + 1, z, 'parapet']);
    }
  }
  // ---- the portals: jambs and a lintel at the first and last tread of every bore run (the arch steps the jambs' tops with
  // upside-down stairs facing the opening), and the hillside face around them lined one cell out
  const portals = [];
  const portalAt = (i, out) => {
    const fy = ys[i], top = fy + height, cells = [];
    for (const v of [lo - 1, hi + 1]) for (let y = fy + 1; y <= top; y++) {
      const [x, z] = at(i, v);
      const arch = opts.portal !== 'plain' && y === top && height >= 3;
      cells.push([x, y, z, arch ? 'arch' : 'jamb', arch ? facingOf(v < lo ? [-rx, -rz] : [rx, rz]) : null]);
    }
    for (let v = lo - 1; v <= hi + 1; v++) { const [x, z] = at(i, v); cells.push([x, top + 1, z, 'lintel', null]); }
    for (const [x, y, z] of cells) lined.delete(key(x, y, z));
    for (let v = lo - 2; v <= hi + 2; v++) for (let y = fy; y <= top + 2; y++) {
      if (v >= lo - 1 && v <= hi + 1 && y <= top + 1) continue;
      const [x, z] = at(i, v), g = land.groundAt(x, z);
      if (y > g || V.has(key(x, y, z)) || F.has(key(x, y, z))) continue;
      const c = cls(x, y, z);
      if (c === 'AIR' || LINED_CLASSES.includes(c) || (all && c === 'ROCK')) lined.set(key(x, y, z), [x, y, z, 'face']);
    }
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
    if (i === 1 || !bore[i - 1]) portalAt(i, -1);
    if (i === L || !bore[i + 1]) portalAt(i, 1);
  }
  // ---- falling blocks (M3:gravity): a sand or gravel cell next to a cell the flight writes or carves, with the void or air under it
  // or resting on a cell the flight rewrites, is lined (a fixed point)
  const portalCells = new Set(portals.flatMap((p) => p.cells.map((c) => key(c[0], c[1], c[2]))));
  const touched = () => [...V.values(), ...F.values(), ...lined.values(), ...[...portalCells].map((k) => k.split(',').map(Number))];
  for (let round = 0; round < 64; round++) {
    let added = 0;
    for (const [x, y, z] of touched()) for (const [ax, ay, az] of N6) {
      const nx = x + ax, ny = y + ay, nz = z + az, k = key(nx, ny, nz);
      if (V.has(k) || F.has(k) || lined.has(k) || portalCells.has(k)) continue;
      if (land.classAt(nx, ny, nz) !== 'LOOSE' || ny > land.groundAt(nx, nz)) continue;
      const kb = key(nx, ny - 1, nz);
      const onWrite = ay === 1 && !V.has(kb);
      if (onWrite || V.has(kb) || (!F.has(kb) && !lined.has(kb) && !portalCells.has(kb) && land.classAt(nx, ny - 1, nz) === 'AIR')) { lined.set(k, [nx, ny, nz, 'gravity']); added++; }
    }
    if (!added) break;
  }
  // ---- the fluid buffer (M4:tunnel): no water, lava or ice, nor a plan body's cell (KC), within `buffer` of a void or tread cell
  const fluids = [], B = new Map();
  for (const [x, y, z] of [...V.values(), ...F.values()]) {
    for (let ax = -buffer; ax <= buffer; ax++) for (let ay = -buffer; ay <= buffer; ay++) for (let az = -buffer; az <= buffer; az++) {
      const k = key(x + ax, y + ay, z + az);
      if (!B.has(k)) B.set(k, [x + ax, y + ay, z + az]);
    }
  }
  for (const [x, y, z] of B.values()) {
    const c = cls(x, y, z);
    if (FLUID_CLASSES.includes(c)) fluids.push({ at: [x, y, z], class: c });
    else if (land.kept?.(x, y, z)) fluids.push({ at: [x, y, z], class: 'BODY' });
  }
  if (fluids.length) {
    fluids.sort((p, q) => p.at[1] - q.at[1] || p.at[0] - q.at[0] || p.at[2] - q.at[2]);
    const kinds2 = [...new Set(fluids.map((f) => f.class.toLowerCase()))].sort();
    const kind = kinds2.includes('body') ? 'body' : kinds2[0] === 'ice' && kinds2.length > 1 ? kinds2[1] : kinds2[0];
    return { ok: false, code: 'WATER', evidence: { kind, kinds: kinds2, buffer, cells: fluids.length, sample: fluids.slice(0, 16), rise, ...ends } };
  }
  if (protect.length) return { ok: false, code: 'PROTECTED', evidence: { class: protect[0].class, cells: protect.length, sample: protect.slice(0, 12), rise, ...ends } };
  if (unknown.length) return { ok: false, code: 'VOLUME', evidence: { cells: unknown.length, sample: unknown.slice(0, 8), rise, ...ends, message: 'no frozen volume holds the corridor\'s rock (its chunks are not loaded or not generated, or it is past the cap)' } };
  // ---- the lamps (M5: 0 dark treads): hanging lanterns from the roof in the bore (an edge lane, height - 1 clear under it), a light
  // flush in the wall where the flight is 2 high or 1 wide, a standing light on the side's ground where a cut has no wall; one at each
  // landing, one each side of every portal, and between them every tread within lampReach of one (counted from the lower end)
  const lamps = [];
  if (!u.noLamps) {
    const level = Math.max(1, opts.lampLevel ?? 15);
    const hang = height >= 3 && width >= 2 && opts.hanging !== false;
    const reach = lampReach(level, width, height);
    const lampAt = (i, side) => {
      const fy = ys[i];
      if (bore[i] && hang) { const [x, z] = at(i, side > 0 ? hi : lo); return [x, fy + height, z, 'hanging', i]; }
      const v = side > 0 ? hi + 1 : lo - 1, [x, z] = at(i, v);
      const k = key(x, fy + 1, z);
      if (!V.has(k) && fy + 1 <= land.groundAt(x, z)) return [x, fy + 1, z, 'flush', i];
      const g = land.groundAt(x, z);
      return V.has(key(x, g + 1, z)) || g + 1 > fy + height + 1 || g < fy - 1 ? null : [x, g + 1, z, 'post', i];
    };
    const want = new Set();
    for (let i = 1; i <= L; i++) if (kinds[i] === 'landing' && (i === 1 || kinds[i - 1] !== 'landing')) want.add(i);
    for (const p of portals) { want.add(p.i); const o = p.i + p.out; if (o >= 1 && o <= L) want.add(o); }
    const lit = (i) => [...want].some((w) => Math.abs(w - i) <= reach);
    for (let i = 1; i <= L; i++) if (!lit(i)) want.add(Math.min(L, i + reach));
    let side = 1;
    for (const i of [...want].sort((p, q) => p - q)) {
      const l = lampAt(i, side) ?? lampAt(i, -side);
      if (l && !lamps.some((q) => q[0] === l[0] && q[1] === l[1] && q[2] === l[2])) { lamps.push(l); lined.delete(key(l[0], l[1], l[2])); }
      side = -side;
    }
  }
  // ---- a parapet or a lamp post standing on soil: its support lined too (grass under a written block turns to dirt during a stand)
  for (const c of [...lined.values()].filter((q) => q[3] === 'parapet').concat(lamps.filter((l) => l[3] === 'post'))) {
    const [x, y, z] = c, k = key(x, y - 1, z);
    if (V.has(k) || F.has(k) || lined.has(k) || portalCells.has(k)) continue;
    if (LINED_CLASSES.includes(land.classAt(x, y - 1, z)) && y - 1 <= land.groundAt(x, z)) lined.set(k, [x, y - 1, z, 'support']);
  }
  // ---- the guard cells (§3, T3's stale rule): the void, the shell, the treads and the buffer, as per-column y runs (by x, z, y)
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
  const lampSet = new Set(lamps.map((l) => key(l[0], l[1], l[2])));
  return {
    ok: true, ys, kinds, cover, bore, cuts: bore.map((b, i) => i >= 1 && !b), voids, floor: [...F.values()],
    lined: u.noLining ? [] : [...lined.values()].filter((c) => !lampSet.has(key(c[0], c[1], c[2]))),
    portals, lamps, guard, carved, lo, hi, width, height, landing, length: L, rise, steps: P.steps, landings: P.landings, from: [x0, y0, z0], dir: [dx, dz],
    to: ends.to, facing: facingOf(P.up > 0 ? [dx, dz] : [-dx, -dz]),
  };
}

/**
 * The bible's rock stair roles (§2, N-RK-1; the foundation's §5 slots `rock_stair {tread, lining, portal}`): the lining `foundation`,
 * then `structure` (tunnelRoles'); the portal `trim`; the treads the slot's role where it has stairs, else the lining's, else
 * `structure`'s, else the nearest role with stairs (theme: never a fixed block). Returns the blocks: `{lining, portal, tread (the
 * stairs block), landing (the treads' full block), light}`.
 */
export function rockStairRoles(r) {
  const roles = r.roles ?? {}, cr = r.ctx?.connectors?.rock_stair ?? {};
  const has = (n) => !!n && Object.prototype.hasOwnProperty.call(roles, n);
  const tr = tunnelRoles(roles, { lining: has(cr.lining) ? cr.lining : undefined, portal: has(cr.portal) ? cr.portal : undefined });
  const blockOf = (n) => (has(n) ? String(roles[n]).replace(/\[.*$/, '') : n && n.includes(':') ? n.replace(/\[.*$/, '') : null);
  const chain = [cr.tread, tr.lining, 'foundation', 'structure', 'trim', 'path', 'floor', 'wall', 'roof'];
  let tread = null, treadBase = null;
  for (const n of chain) { const b = blockOf(n); const s = b ? shapeOf(b, 'stairs') : null; if (s) { tread = s; treadBase = b; break; } }
  const cube = (b) => !!b && BLOCKS[b]?.collision === 'full';
  const lining = blockOf(tr.lining) ?? tr.lining;
  return { lining, portal: blockOf(tr.portal) ?? tr.portal, tread, landing: cube(treadBase) ? treadBase : lining, light: has('light') ? roles.light : null };
}

const JOIN = Object.freeze({ north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] });
/** A wall block's (or fence's) sides joined as kit.mjs finalize joins them: to its own kind, panes, gates and full cubes. */
function joinedWall(name, x, y, z, at) {
  const fam = BLOCKS[name]?.family;
  const conn = {};
  for (const [d, [ax, az]] of Object.entries(JOIN)) {
    const nb = at(x + ax, y, z + az);
    const nf = nb ? BLOCKS[nb]?.family : null;
    conn[d] = !!nb && (nf === 'wall' || nf === 'pane' || nf === 'fence_gate' || (fam === 'fence' && nf === 'fence') || BLOCKS[nb]?.collision === 'full');
  }
  if (fam === 'wall') {
    const straight = (conn.north && conn.south && !conn.east && !conn.west) || (conn.east && conn.west && !conn.north && !conn.south);
    return `${name}[east=${conn.east ? 'low' : 'none'},north=${conn.north ? 'low' : 'none'},south=${conn.south ? 'low' : 'none'},up=${!straight || !!at(x, y + 1, z)},waterlogged=false,west=${conn.west ? 'low' : 'none'}]`;
  }
  return `${name}[east=${conn.east},north=${conn.north},south=${conn.south},waterlogged=false,west=${conn.west}]`;
}

/**
 * The primitive (§2): a rock stair from the start walk cell `a` = [x, y0, z] to the landing walk cell `b` (cardinal; y the walk cells'
 * surface blocks) in part `part` (a path part in `stage`; the lining, sealing and falling-block lining in `liningStage`, before the
 * carve, as a tunnel's). `opts`: {land (tunnelLand over the plan survey and its frozen volumes), width, height, landing, lining, portal,
 * id, stage, liningStage, part = 'links', volume ({sha, box}), movers, _unsafe}. Throws `ROCK_STAIR <code>: ...` (with `.rockStair`)
 * when a check fails. Writes the carve (air), the treads (stairs facing up the flight; landings full blocks; one cell of fill under a
 * tread as lining), the lining, the portals, the parapets (the lining's wall block joined to its neighbours, else the rail role's
 * fence) and the lamps (every cell ALWAYS_OURS), and records the flight in the plan meta's `rockStairs` (the checker's rules read it).
 */
export function rockStair(r, a, b, opts = {}) {
  const what = `rock stair ${opts.id ?? ''}`.trim();
  const dx = Math.sign(b[0] - a[0]), dz = Math.sign(b[2] - a[2]);
  if ((dx !== 0) === (dz !== 0)) throw new Error(`${what}: the walk cells must lie on one axis (a straight cardinal flight)`);
  const rise = b[1] - a[1], dir = [dx, dz];
  const width = opts.width ?? ROCK.width, height = opts.height ?? ROCK.height, landing = opts.landing ?? ROCK.landing;
  if (Math.abs(b[0] - a[0]) + Math.abs(b[2] - a[2]) - 1 !== flightLength(rise, landing)) throw new Error(`${what}: the walk cells are not a flight of rise ${rise} apart (landing ${landing})`);
  const R = rockStairRoles(r);
  const liningB = r.material(R.lining, `${what} lining`);
  const portalB = r.material(R.portal, `${what} portal`);
  const landingB = r.material(R.landing, `${what} landing`);
  const treadName = R.tread ? r.material(R.tread, `${what} tread`) : null;
  const lightB = r.material(R.light ? 'light' : 'minecraft:lantern', `${what} light`);
  const lights = tunnelLights(lightB);
  const land = opts.land;
  if (!land) throw new Error(`${what}: needs opts.land (tunnelLand over the plan survey and its frozen volumes)`);
  const g = rockStairGeom(land, a, dir, rise, { width, height, landing, lining: opts.lining, portal: opts.portal, lampLevel: lights.level, _unsafe: opts._unsafe });
  if (!g.ok) throw Object.assign(new Error(`${what}: ROCK_STAIR ${g.code}: ${g.evidence?.message ?? JSON.stringify(g.evidence).slice(0, 200)}`), { rockStair: g });
  const tread = treadName ? `${String(treadName).replace(/\[.*$/, '')}[facing=${g.facing},half=bottom,shape=straight,waterlogged=false]` : landingB;
  const stairs = shapeOf(portalB, 'stairs');
  const part = opts.part ?? 'links';
  const stage = r.ctx?.survival && opts.liningStage ? opts.liningStage : opts.stage;
  const p = r.parts.find((q) => q.id === part) ?? r.part(part, { stage, set: 'path' });
  (r.meta.parts[p.id] ??= {}).kind ??= 'path';
  const mats = [null, tread, landingB, liningB, portalB, lights.hanging, lights.flush, lights.standing];
  const M = { air: 0, step: 1, landing: 2, lining: 3, bed: 3, portal: 4, hanging: 5, flush: 6, post: 7 };
  // the parapets: the lining's wall block (M8: a barrier of 1.5, never a step), joined to their neighbours (the flight's own cells
  // and the land's cubes, as kit.mjs finalize joins them: Noah's look, joined fences); without a wall variant, the rail role's fence
  const wallB = shapeOf(liningB, 'wall') ?? null;
  const role = (name, fallback) => (Object.prototype.hasOwnProperty.call(r.roles, name) ? name : fallback);
  const fenceB = wallB ? null : String(r.material(role('rail', role('frame', 'structure')), `${what} parapet`)).replace(/\[.*$/, '');
  const parName = wallB ?? shapeOf(fenceB, 'fence') ?? fenceB;
  const own = new Map();
  const put = (x, y, z, s) => own.set(key(x, y, z), s);
  for (const [x, y, z, c] of g.voids) if (c !== 'AIR') put(x, y, z, null);
  for (const [x, y, z, kind] of g.floor) put(x, y, z, kind === 'step' ? tread : kind === 'landing' ? landingB : liningB);
  for (const [x, y, z, why] of g.lined) put(x, y, z, why === 'parapet' ? parName : liningB);
  for (const pt of g.portals) for (const [x, y, z] of pt.cells) put(x, y, z, portalB);
  for (const [x, y, z, kind] of g.lamps) put(x, y, z, kind === 'hanging' ? lights.hanging : kind === 'flush' ? lights.flush : lights.standing);
  const voidSet = new Set(g.voids.map((c) => key(c[0], c[1], c[2])));
  const nameAt = (x, y, z) => {
    const k = key(x, y, z);
    if (own.has(k)) { const s = own.get(k); return s === null ? null : String(s).replace(/\[.*$/, ''); }
    if (voidSet.has(k)) return null;
    return land.written(x, y, z) || SITE_SOLID.includes(land.classAt(x, y, z)) ? 'minecraft:stone' : null;
  };
  const archIdx = new Map();
  const matOf = (st) => { if (!archIdx.has(st)) { archIdx.set(st, mats.length); mats.push(st); } return archIdx.get(st); };
  const solid = [], walk = [], air = [];
  const lampAt = new Set(g.lamps.map((l) => key(l[0], l[1], l[2])));
  for (const [x, y, z, c] of g.voids) if (c !== 'AIR' && !lampAt.has(key(x, y, z))) air.push(x, z, y, y, M.air);
  for (const [x, y, z, kind] of g.floor) (kind === 'bed' ? solid : walk).push(x, z, y, y, M[kind]);
  const early = opts.liningStage && opts.liningStage !== opts.stage && !r.ctx?.survival ? [] : solid;
  for (const [x, y, z, why] of g.lined) (why === 'parapet' ? solid : early).push(x, z, y, y, why === 'parapet' ? matOf(joinedWall(parName, x, y, z, nameAt)) : M.lining);
  for (const pt of g.portals) for (const [x, y, z, kind, facing] of pt.cells) {
    if (kind === 'arch' && stairs) solid.push(x, z, y, y, matOf(`${stairs}[facing=${facing},half=top,shape=straight,waterlogged=false]`));
    else solid.push(x, z, y, y, M.portal);
  }
  for (const [x, y, z, kind] of g.lamps) solid.push(x, z, y, y, M[kind]);
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
  const id = opts.id ?? `${p.id}_rock_stair_${(r.meta.rockStairs?.length ?? 0) + 1}`;
  const xs = [], yz = [], zs = [];
  for (let t = 0; t < g.guard.length; t += 4) { xs.push(g.guard[t]); zs.push(g.guard[t + 1]); yz.push(g.guard[t + 2], g.guard[t + 3]); }
  const box = { minX: Math.min(...xs), minY: Math.min(...yz), minZ: Math.min(...zs), maxX: Math.max(...xs), maxY: Math.max(...yz), maxZ: Math.max(...zs) };
  const treads = g.floor.filter((c) => c[3] !== 'bed');
  const rec = {
    id, kind: 'rock_stair', part: p.id, stage: p.stage, box, width, height, landing: g.landing, length: g.length, rise, steps: g.steps, landings: g.landings,
    from: [...a], to: [...b], dir, lo: g.lo, hi: g.hi, facing: g.facing, ys: g.ys, kinds: g.kinds.slice(1),
    bore: g.bore.slice(1), cover: g.cover.slice(1), floor: treads.map((c) => [c[0], c[1], c[2], c[3]]), beds: g.floor.filter((c) => c[3] === 'bed').map((c) => [c[0], c[1], c[2]]),
    voids: g.voids.map((c) => [c[0], c[1], c[2]]), portals: g.portals.map((q) => ({ i: q.i, out: q.out, cells: q.cells.map((c) => [c[0], c[1], c[2], c[3]]) })),
    lamps: g.lamps.map((c) => [c[0], c[1], c[2], c[3]]), lined: g.lined.length, carved: g.carved, guard: g.guard,
    lining: liningB, portal: portalB, tread, landingBlock: landingB, light: lights.hanging, bom,
    // the tread blocks (feet one over: check.mjs's M5 over `cells`), and the journal's counts
    cells: treads.map((c) => [c[0], c[1], c[2]]), counts: { carved: g.carved, lined: g.lined.length, written: (solid.length + walk.length + (early === solid ? 0 : early.length)) / 5 + g.carved },
    ...(early !== solid && early.length ? { liningPart: `${p.id}_lining`, liningStage: opts.liningStage } : {}),
    ...(opts.volume ? { volume: { ...opts.volume } } : {}),
    ...(opts.movers ? { movers: [...opts.movers] } : {}),
    ...(opts._unsafe ? { _unsafe: { ...opts._unsafe } } : {}),
  };
  (r.meta.rockStairs ??= []).push(rec);
  return rec;
}
