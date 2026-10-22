// (6c S3) Terraced districts (docs/CONTRACT.md "Phase 6c slice S3" §3): the zone member `terraces: {rise, retain, stairs}` lays a
// district (or a standard zone, as one district) down the slope as steps. Each lot, with its apron, stands on its own level; the
// levels lie on a ladder `rise` apart (the district's lowest ground plus k x rise), so consecutive lots share a level where the
// ground allows. The street becomes T2's routes between the lots' entrances (switchbacks and stairs within the zone's grade).
// Rims more than 2 over the land outside are retained (`retain: wall`, the bible's `structure`, with a `rail` where the drop is over
// 3), or blended by the relief (`retain: blend`: blend pads; a lot whose fill the relief can't reach keeps a wall, noted).
//
//   parseTerraces(t, where)            the member, validated and with its defaults
//   layoutTerraces({...})              the pure layout in a rect (the districts pass's candidate evaluation)
//   junctionOf(l)                      a lot's junction: its approach's end (JUNCTION cells out of its front, at its floor), where every
//                                      route of the district meets the lot (no facing there, so several routes share it); the lot to
//                                      its junction is a short straight walk of its own
//   terraceEnds(L)                     the district's ends: its lots' junctions, the lowest lot's and the highest lot's first
//   chainTerraces(L, {dry, ...})       the junctions' joins: a tree from the landmark, each join a dry route; a lot no route reaches drops
//   emitTerraces(r, L, {...})          the lots on their levels, the retaining walls and rails; the result's shape is the street
//                                      layout's where the districts pass reads it (lots[].lot, res.bell, laneCells)
// Plan time only, deterministic (integer costs; scan order breaks ties).
import { COND } from './program.mjs';
import { sampleIndex } from './survey.mjs';
import { FLAG_TREE } from './pack.mjs';

const isInt = Number.isInteger;
/** The member's defaults and ranges (CONTRACT S3 §3, S-S3-1). */
export const TERRACES = Object.freeze({ rise: 3, riseMin: 2, riseMax: 6, retain: 'wall', stairs: true });
/** Columns between two lots' rects: each apron, each retaining ring and a 3-wide way between. */
export const TERRACE_GAP = 7;
/** The approach room: the entrance and this many cells out (3 wide) stay clear of every other lot's rect, apron and ring. */
export const TERRACE_FRONT = 6;
/** A lot's cut and fill on its level (the plan's own limit for a pad, 4e/T1's 6). */
export const TERRACE_MAX = 6;
/** The entrance and this many cells out lie within APPROACH_OFF of the pad's top (a route's cut and fill there, T2's 4, less 1). */
export const APPROACH = 3, APPROACH_OFF = 3;
/** A rim more than this over the land outside is retained (CONTRACT S3 §1). */
export const RETAIN_OVER = 2;
/** A rim with a drop of more than this beside it gets a rail (M8). */
export const RAIL_OVER = 3;
/** A join steeper than 1 in STEEP between a site's junction and its nearest placed lot's costs STEEP_COST (a soft rule: the site stays
 * when nothing else fits). */
export const STEEP = 4, STEEP_COST = 400;
/** A level between a lot and the lot placed before it costs this much (consecutive lots share a level where the ground allows). */
export const LEVEL_COST = 40;
/** A lot's junction lies this many cells out of its front, on its approach (inside the approach room TERRACE_FRONT keeps clear). */
export const JUNCTION = 4;
/** The joins between a terraced district's lots: their width, and the routes tried per lot before it drops. */
export const CHAIN_WIDTH = 2;
export const CHAIN_TRIES = 3;
const FRONTS = ['north', 'east', 'south', 'west'];
const CARD = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };

/** The member `terraces` (a district's or a standard zone's): `{rise?: 2..6, retain?: wall|blend, stairs?: boolean}` -> its values. */
export function parseTerraces(t, where = 'terraces') {
  if (t === true) return { rise: TERRACES.rise, retain: TERRACES.retain, stairs: TERRACES.stairs };
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error(`${where} must be {rise?, retain?, stairs?}`);
  for (const k of Object.keys(t)) if (!['rise', 'retain', 'stairs'].includes(k)) throw new Error(`${where}: unknown member '${k}'`);
  const rise = t.rise ?? TERRACES.rise;
  if (!isInt(rise) || rise < TERRACES.riseMin || rise > TERRACES.riseMax) throw new Error(`${where}.rise must be ${TERRACES.riseMin}..${TERRACES.riseMax}`);
  const retain = t.retain ?? TERRACES.retain;
  if (!['wall', 'blend'].includes(retain)) throw new Error(`${where}.retain must be wall or blend`);
  const stairs = t.stairs ?? TERRACES.stairs;
  if (typeof stairs !== 'boolean') throw new Error(`${where}.stairs must be true or false`);
  return { rise, retain, stairs };
}

const rectsMeet = (a, b, g = 0) => a[0] - g <= b[2] && b[0] - g <= a[2] && a[1] - g <= b[3] && b[1] - g <= a[3];
const inRect = (x, z, q) => x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3];
/** Lot order: the landmark first, then central lots, then the list (V's order without the street's square slots). */
const orderOf = (s) => (s.landmark ? 0 : s.placement === 'central' ? 1 : s.placement === 'edge' ? 3 : 2);

/**
 * The terraced layout in `claim` (a rect: {minX, minZ, maxX, maxZ}). `specs`: validated lots (params.mjs validateLots); `terraces`:
 * parseTerraces' values; `keepOut`, `blocked`: [x0, z0, x1, z1] rects no lot, apron, ring or approach meets. Each lot, in order
 * (the landmark first), takes the site (every corner on a lattice of `step`, every front) whose pad fits its level within
 * TERRACE_MAX, whose apron, ring and approach are dry, inside the rect's margin and clear of the others, at the least cost: the
 * pad's cut and fill, how far its approach is off the level, and its distance and level change from the lot placed before it.
 * Returns `{terraced: true, lots: [{spec, rect, floorY, front, entrance, level, cut, fill, side}], levels: [y], unplaced: [{id,
 * reason}], base, rise, flat, score, y}` or `{fail}`. Pure.
 */
export function layoutTerraces({ claim, survey: S, specs, terraces, keepOut = [], blocked = [], margin = 2, step = 2 }) {
  const T = terraces ?? parseTerraces(true);
  const rise = T.rise;
  const R = [claim.minX, claim.minZ, claim.maxX, claim.maxZ];
  const st = S.stats(R[0], R[1], R[2], R[3]);
  if (st.water && st.water === (R[2] - R[0] + 1) * (R[3] - R[1] + 1)) return { fail: 'the rect is all water' };
  const base = st.minGround;
  const flat = st.maxGround - st.minGround < rise;
  const stop = [...keepOut, ...blocked].map((q) => [q[0] - 1, q[1] - 1, q[2] + 1, q[3] + 1]);
  const ordered = specs.map((s, i) => ({ s, i })).sort((a, b) => orderOf(a.s) - orderOf(b.s) || a.i - b.i).map((o) => o.s);
  const placed = [], unplaced = [];
  const within = (x, z) => x >= R[0] + margin && x <= R[2] - margin && z >= R[1] + margin && z <= R[3] - margin;
  // (a tree's trunk is never cut: a felled trunk's leaves decay at cells the plan never wrote, which no undo restores)
  const tree = (x, z) => (S.columns.flags[sampleIndex(S.columns, x, z)] & FLAG_TREE) !== 0;
  const dry = (x, z) => !S.waterAt(x, z) && !(S.missingAt?.(x, z)) && !tree(x, z);
  // a placed lot's taken cells: its rect grown by its apron and ring (2), and its approach room
  const roomOf = (q) => {
    const [fx, fz] = CARD[q.front];
    const out = [];
    for (let t = 0; t <= TERRACE_FRONT; t++) for (let v = -1; v <= 1; v++) out.push([q.entrance[0] + fx * t + fz * v, q.entrance[2] + fz * t + fx * v]);
    return out;
  };
  for (const s of ordered) {
    const prev = placed.length ? placed[placed.length - 1] : null;
    let best = null;
    for (const front of FRONTS) {
      const ns = front === 'north' || front === 'south';
      const w = ns ? s.size[0] : s.size[1], d = ns ? s.size[1] : s.size[0];
      const [fx, fz] = CARD[front];
      for (let z0 = R[1] + margin + 2; z0 + d - 1 <= R[3] - margin - 2; z0 += step) for (let x0 = R[0] + margin + 2; x0 + w - 1 <= R[2] - margin - 2; x0 += step) {
        const x1 = x0 + w - 1, z1 = z0 + d - 1;
        const rect = [x0, z0, x1, z1];
        if (placed.some((q) => rectsMeet(q.rect, rect, TERRACE_GAP))) continue;
        if (stop.some((q) => rectsMeet(q, rect, 2))) continue;
        const ex = front === 'east' ? x1 + 1 : front === 'west' ? x0 - 1 : x0 + Math.floor((w - 1) / 2);
        const ez = front === 'south' ? z1 + 1 : front === 'north' ? z0 - 1 : z0 + Math.floor((d - 1) / 2);
        // the approach room: dry, in the margin, clear of the others' rects (with apron and ring) and of keep-out
        let open = true;
        for (let t = 0; t <= TERRACE_FRONT && open; t++) for (let v = -1; v <= 1; v++) {
          const x = ex + fx * t + fz * v, z = ez + fz * t + fx * v;
          if (!within(x, z) || !dry(x, z) || placed.some((q) => inRect(x, z, [q.rect[0] - 2, q.rect[1] - 2, q.rect[2] + 2, q.rect[3] + 2])) || stop.some((q) => inRect(x, z, q))) { open = false; break; }
        }
        if (!open) continue;
        // and the others' approach rooms stay clear of this rect (with its apron and ring); its junction 3 or more from theirs (each
        // lot meets the district's routes at its own junction)
        const grown = [x0 - 2, z0 - 2, x1 + 2, z1 + 2];
        if (placed.some((q) => roomOf(q).some(([x, z]) => inRect(x, z, grown)))) continue;
        const jx = ex + fx * JUNCTION, jz = ez + fz * JUNCTION;
        if (placed.some((q) => { const [qx, qz] = CARD[q.front]; return Math.max(Math.abs(q.entrance[0] + qx * JUNCTION - jx), Math.abs(q.entrance[2] + qz * JUNCTION - jz)) < 3; })) continue;
        // no tree in the footprint, its apron or its ring
        let treed = false;
        for (let z = grown[1]; z <= grown[3] && !treed; z++) for (let x = grown[0]; x <= grown[2]; x++) if (tree(x, z)) { treed = true; break; }
        if (treed) continue;
        const bal = S.padStats(x0, z0, w, d);
        if (bal.water) continue;
        // the ladder level nearest the balanced pad's top, then the one below and above (the first within the limits)
        const k0 = Math.floor((2 * (bal.top - base) + rise) / (2 * rise));
        let pick = null;
        for (const k of [k0, k0 - 1, k0 + 1]) {
          if (k < 0) continue;
          const top = base + k * rise;
          const ps = S.padStats(x0, z0, w, d, { floorY: top + 1 });
          if (ps.cut > TERRACE_MAX || ps.fill > TERRACE_MAX || ps.water) continue;
          pick = { k, top, cut: ps.cut, fill: ps.fill };
          break;
        }
        if (!pick) continue;
        // the approach's ground against the level (a route leaves the entrance there)
        // (the route meets the survey's ground there, within its own cut and fill: the entrance and APPROACH cells out stay within
        // APPROACH_OFF of the pad's top)
        let off = 0;
        for (let t = 0; t <= APPROACH; t++) off = Math.max(off, Math.abs(S.groundAt(ex + fx * t, ez + fz * t) - pick.top));
        if (off > APPROACH_OFF) continue;
        const near = prev ? Math.abs(ex - prev.entrance[0]) + Math.abs(ez - prev.entrance[2]) : Math.abs(((x0 + x1) >> 1) - ((R[0] + R[2]) >> 1)) + Math.abs(((z0 + z1) >> 1) - ((R[1] + R[3]) >> 1));
        // a join to the nearest placed lot that would have to climb steeper than 1 in STEEP (junction to junction) costs STEEP_COST:
        // such a join needs a flight where the lots leave no room for one
        let steep = 0;
        if (placed.length) {
          let nd = Infinity, ny = 0;
          for (const q of placed) { const [qx, qz] = CARD[q.front]; const d = Math.abs(q.entrance[0] + qx * JUNCTION - jx) + Math.abs(q.entrance[2] + qz * JUNCTION - jz); if (d < nd) { nd = d; ny = Math.abs(q.floorY - 1 - pick.top); } }
          if (ny * STEEP > nd) steep = STEEP_COST;
        }
        const cost = 4 * (pick.cut + pick.fill) + 3 * off + 2 * near + steep + (prev ? LEVEL_COST * Math.abs(pick.k - prev.level) : 0);
        if (!best || cost < best.cost) best = { cost, rect, front, floorY: pick.top + 1, level: pick.k, cut: pick.cut, fill: pick.fill, entrance: [ex, pick.top + 1, ez] };
      }
    }
    if (!best) { unplaced.push({ id: s.id, reason: 'no_room' }); continue; }
    placed.push({ spec: s, ...best });
  }
  if (!placed.length) return { fail: 'no lot has a terraced site in the rect (water, keep-out, or pads past their limits)', unplaced };
  const levels = [...new Set(placed.map((l) => base + l.level * rise))].sort((a, b) => a - b);
  const score = placed.length * 1_000_000 - placed.reduce((a, l) => a + l.cost, 0);
  const y = Math.round(placed.reduce((a, l) => a + l.floorY - 1, 0) / placed.length);
  const lots = placed.map(({ cost, ...l }) => ({ ...l, slot: 'terrace' }));
  return { terraced: true, rise, retain: T.retain, stairs: T.stairs, base, flat: flat || levels.length === 1, levels, lots, unplaced, score, y, rect: R };
}

/** A lot's junction (the end of its approach, JUNCTION cells out of its front at its floor): `{name, at: [x, y, z]}` (feet). */
export function junctionOf(l) {
  const [fx, fz] = CARD[l.front];
  return { name: `${l.spec.id}_j`.slice(0, 48), at: [l.entrance[0] + fx * JUNCTION, l.entrance[1], l.entrance[2] + fz * JUNCTION] };
}

/**
 * The district's ends, each a lot's junction (a route ends there, from any side): its lowest-level lot's, its highest's (ties: the
 * first placed; with one lot both are it), then every other lot's in placed order. A join between districts takes the cheapest
 * routable pair of ends.
 */
export function terraceEnds(L) {
  const lots = L.lots;
  if (!lots.length) return [];
  let lo = lots[0], hi = lots[0];
  for (const l of lots) { if (l.level < lo.level) lo = l; if (l.level > hi.level) hi = l; }
  if (hi === lo && lots.length > 1) hi = lots.find((l) => l !== lo) ?? hi;
  const order = [lo, hi, ...lots.filter((l) => l !== lo && l !== hi)];
  return order.map((l, k) => { const j = junctionOf(l); return { k, x: j.at[0], z: j.at[2], y: j.at[1], facing: null, lot: l.spec.id, junction: j.name, terraced: true, street: null }; });
}

/**
 * The lots' joins (pure): from the landmark (the first lot), each lot not yet joined in turn (the nearest to the joined set first),
 * tried against its CHAIN_TRIES nearest joined lots by a dry route `dry(a, b)` between their junctions ({at, facing: null} each; ->
 * {ok, cost}); a lot no try routes drops (`unreachable`). `forbid`: "a|b" pairs not to try (a join the one-pass run failed). Returns `{edges: [{a, b}] (lot ids), kept: [lot], dropped: [{id, reason}]}`.
 */
export function chainTerraces(L, { dry, forbid = new Set() }) {
  const lots = L.lots;
  if (!lots.length) return { edges: [], kept: [], dropped: [] };
  const end = (l) => ({ at: [...junctionOf(l).at], facing: null });
  const man = (a, b) => Math.abs(a.entrance[0] - b.entrance[0]) + Math.abs(a.entrance[2] - b.entrance[2]) + 4 * Math.abs(a.entrance[1] - b.entrance[1]);
  const joined = [lots[0]], left = lots.slice(1), edges = [], dropped = [];
  while (left.length) {
    left.sort((p, q) => Math.min(...joined.map((j) => man(p, j))) - Math.min(...joined.map((j) => man(q, j))) || lots.indexOf(p) - lots.indexOf(q));
    const l = left.shift();
    const tries = [...joined].sort((p, q) => man(l, p) - man(l, q) || lots.indexOf(p) - lots.indexOf(q)).slice(0, CHAIN_TRIES);
    let ok = null;
    const why = [];
    for (const j of tries) {
      // (a pair the one-pass run failed, `forbid` "a|b", is not tried again)
      if (forbid.has(`${j.spec.id}|${l.spec.id}`)) { why.push(`${j.spec.id}: failed in the one pass`); continue; }
      const e = dry(end(j), end(l)); if (e.ok) { ok = j; break; } why.push(`${j.spec.id}: ${e.failed ?? 'no route'}`);
    }
    if (!ok) { dropped.push({ id: l.spec.id, reason: 'unreachable', tried: why }); continue; }
    edges.push({ a: ok.spec.id, b: l.spec.id });
    joined.push(l);
  }
  return { edges, kept: joined, dropped };
}

/**
 * The cells of a lot's retaining ring (the columns just outside its apron, Chebyshev 2 from its rect) where its rim stands more than
 * RETAIN_OVER over the land, and those of them with a drop over RAIL_OVER (a rail), outside its approach (entrance and TERRACE_FRONT
 * out, 3 wide, plus a column each side). [[x, z, ground]] each.
 */
export function ringOf(S, l) {
  const [x0, z0, x1, z1] = l.rect, t = l.floorY - 1;
  const [fx, fz] = CARD[l.front];
  const approach = new Set();
  for (let k = 0; k <= TERRACE_FRONT + 1; k++) for (let v = -2; v <= 2; v++) approach.add(`${l.entrance[0] + fx * k + fz * v},${l.entrance[2] + fz * k + fx * v}`);
  const wall = [], rail = [], keep = [];
  for (let z = z0 - 2; z <= z1 + 2; z++) for (let x = x0 - 2; x <= x1 + 2; x++) {
    if (Math.max(x0 - x, x - x1, z0 - z, z - z1) !== 2) continue;
    if (approach.has(`${x},${z}`)) continue;
    const g = S.groundAt(x, z);
    if (!(t - g > RETAIN_OVER)) { keep.push([x, z, g]); continue; }
    wall.push([x, z, g]);
    // the drop beside it: the lowest ground of its outer neighbours
    let low = g;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Z = z + dz; if (Math.max(x0 - X, X - x1, z0 - Z, Z - z1) === 3) low = Math.min(low, S.groundAt(X, Z)); }
    if (t - low > RAIL_OVER) rail.push([x, z, low]);
  }
  return { wall, rail, keep };
}

/**
 * Emit a terraced layout: each lot on its level (`retain: wall`: a wall pad, then its retaining ring in the `structure` role from the
 * ring's ground to the pad's top, and a `rail` post on it where the drop is over 3; `retain: blend`: a blend pad, or a wall pad and
 * its ring where its fill is past `blendFill`, noted). `L.lots` holds only the lots to emit. Returns the street layout's shape where
 * the districts pass reads it: `{terraced: true, lots: [{...l, lot}], res: {bell, area: [], golem: []}, laneCells: {}, unplaced,
 * ring: [[x0, z0, x1, z1]] (the retaining rings' cells as 1x1 rects: hard to the routes), retained, rails, blended, notes}`.
 */
export function emitTerraces(r, L, { stages = {}, prefix = '', maxHeight = 32, blendFill = 6, keepOut = [], unretained = false } = {}) {
  const sg = stages.ground ?? 'ground', sl = stages.lots ?? 'lots';
  const S = r.survey;
  const pads = r.part(`${prefix}pads`, { stage: sg });
  const lotOut = [], notes = [], ringCells = [];
  let retained = 0, rails = 0, blended = 0;
  const wallCols = [], railCols = [];
  const kept = (x, z) => !keepOut.some((q) => inRect(x, z, q));
  for (const l of L.lots) {
    const s = l.spec;
    const w = l.rect[2] - l.rect[0] + 1, d = l.rect[3] - l.rect[1] + 1;
    const blend = L.retain === 'blend' && l.fill <= blendFill;
    if (L.retain === 'blend' && !blend) notes.push(`terraces: lot ${s.id}'s fill ${l.fill} is past the relief's ${blendFill}: retained by a wall`);
    const lot = pads.lot(s.id, {
      at: [l.rect[0], l.rect[1]], size: [w, d], floor: l.floorY, front: l.front, max: [w, maxHeight, d], brief: s.brief, stage: sl,
      pad: { edge: blend ? 'blend' : 'wall', maxCut: Math.max(1, l.cut), maxFill: Math.max(1, l.fill) },
      ext: { ...s.ext, 'architect_mc:village': { role: s.role, type: s.type, villager: s.villager, entrance: l.entrance, landmark: s.landmark, placement: s.placement, slot: 'terrace', terrace: { level: l.level, y: l.floorY - 1 } } },
    });
    if (blend) blended++;
    else if (!unretained) { // (`unretained`: the broken variant, no ring or rail)
      const ring = ringOf(S, l);
      const t = l.floorY - 1;
      const pins = [];
      for (const [x, z, g] of ring.wall) { if (!kept(x, z)) continue; wallCols.push(x, z, Math.max(g, r.claim.minY + 2), t, 0); ringCells.push([x, z, x, z]); pins.push([x, z, t]); retained++; }
      // (the ring's other cells, within RETAIN_OVER of the pad's top, are pinned at their own ground: a relief blending the land outside
      // would else cut them into a rim the ring never retained)
      for (const [x, z, g] of ring.keep) if (kept(x, z)) pins.push([x, z, g]);
      // (a relief around this lot pins its ring at the pad's top: the wall stands, the land is blended to it from outside)
      if (pins.length) (r.terraceRings ??= new Map()).set(s.id, pins);
      for (const [x, z] of ring.rail) { if (!kept(x, z)) continue; railCols.push(x, z, t + 1, t + 1, 0); rails++; }
    }
    lotOut.push({ ...l, lot });
  }
  if (wallCols.length || railCols.length) {
    const ret = r.part(`${prefix}retain`, { stage: sg });
    (r.meta.parts[ret.id] ??= {}).kind = 'retaining';
    if (wallCols.length) ret._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: wallCols, materials: [r.material('structure', `${ret.id}: retaining wall`)], cond: COND.IF_NATURAL, walk: false });
    if (railCols.length) ret._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: railCols, materials: [r.material('rail', `${ret.id}: rail`)], cond: COND.IF_AIR_OR_FLUID, walk: false });
  }
  const lm = lotOut.find((l) => l.spec.landmark) ?? lotOut[0];
  const bell = lm ? [...lm.entrance] : null;
  if (L.flat) notes.push('terraces: flat site, one level');
  for (const n of notes) r.note(n);
  return { terraced: true, lots: lotOut, res: { bell, area: [], golem: [] }, laneCells: {}, unplaced: L.unplaced ?? [], ring: ringCells, retained, rails, blended, levels: L.levels, notes };
}
