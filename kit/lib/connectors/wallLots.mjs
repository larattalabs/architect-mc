// (7a K3) Towers and gatehouses as lots on a wall's line (docs/CONTRACT.md "Phase 7a slice K3"): the lots a recorded wall names are
// sited on the wall's line instead of beside it. A tower stands on a ring's corner, a gatehouse straddles a gate run with a passage
// through it, a run lot stands on a straight run; the wall ends at each lot's box (K1's joined lot: end posts, K5 holds), and routes
// cross the wall through a gatehouse's passage (moves/gate.mjs: the passage move).
//
//   wallLotsOf(part, specOf, form)  §1: the lots a wall names (its `lots` member, else the lenient mapping of its recorded params) and
//                                   the params keys that mapping read
//   withheldOf(V, back)             §2: per zone, the lots its walls site on their lines (laid out without them); `back`: lots sent
//                                   back to their zone by an earlier compile of the same plan (they fitted nowhere on the line)
//   withhold(zone, ids)             a zone part's copy without those lots (its street, frontage and cache key see the rest)
//   lotBand(named, specOf, t)       §3's band: the least ring offset that keeps a lot straddling the line clear of the zone's lots
//   siteWallLots(K, W, named)       §3: the boxes on the ring (corners, gates, runs), the cut, the lots' pads, the passages and the
//                                   artifact's onWall records; a lot that fits nowhere goes back to its zone
//   viaLots(K, W)                   a wall.line's `via` lots (K1's joined lots): their onWall records (a gatehouse's passage where the
//                                   line runs across its sides)
//   wallLanes(K)                    §4: the inner lane from each gatehouse's back port to its zone's nearest street end
// Pure over its inputs and deterministic (ties by perimeter position, then lot order). A wall naming no lot never reaches this module.
import { zoneLots } from '../plan/schema.mjs';
import { OB } from './line.mjs';

/**
 * The lot seen with its front to the south, as a design sees it (IRR's lotFrame, kit/lib/fluids/irrigate.mjs, repeated here: importing the
 * fluids modules from the connectors makes an import cycle): u across, v from the back (D - 1 the front row), y from floorY.
 */
export function lotFrame(lot) {
  const b = lot.box, f = lot.front ?? 'south', fy = lot.floorY ?? b.minY;
  const W = b.maxX - b.minX + 1, D = b.maxZ - b.minZ + 1;
  const T = {
    south: { size: [W, D], to: (x, z) => [x - b.minX, z - b.minZ], from: (u, v) => [b.minX + u, b.minZ + v] },
    north: { size: [W, D], to: (x, z) => [b.maxX - x, b.maxZ - z], from: (u, v) => [b.maxX - u, b.maxZ - v] },
    east: { size: [D, W], to: (x, z) => [b.maxZ - z, x - b.minX], from: (u, v) => [b.minX + v, b.maxZ - u] },
    west: { size: [D, W], to: (x, z) => [z - b.minZ, b.maxX - x], from: (u, v) => [b.maxX - v, b.minZ + u] },
  }[f];
  if (!T) throw new Error(`lotFrame: front '${f}' is not a cardinal`);
  return {
    front: f, size: T.size, floorY: fy,
    toFrame: (x, y, z) => { const [u, v] = T.to(x, z); return [u, y - fy, v]; },
    toWorld: (u, y, v) => { const [x, z] = T.from(u, v); return [x, y + fy, z]; },
  };
}

/** A sited lot's box height (the design's room: a tower's height is twice its smaller side, S-K3's profiles). */
export const WALL_LOT_HEIGHT = 40;
/** A gatehouse passage's clear height over its floor (§4). */
export const PASSAGE_HEIGHT = 3;
/** The narrowest passage (§4: at least 3, else the widest crossing walk). */
export const PASSAGE_MIN = 3;
/** A sited lot's pad limits (a wall lot stands on the line wherever the ground is: the village lots' 2 would leave few places). */
export const WALL_LOT_PAD = Object.freeze({ maxCut: 6, maxFill: 6 });
/** The gap between two lots on one wall (§3: other named lots, gap 2). */
export const LOT_GAP = 2;
/** The most lots one wall sites (the catalogue's `lots` maxItems). */
export const WALL_LOTS_MAX = 16;

const AT = ['corner', 'gate', 'run'];
const CORNER_TYPES = ['tower', 'watchtower'];
const GATE_TYPES = ['gatehouse'];
/** The recorded params that name lots on a wall's line (Steward's recorded plans, S-K1-3), in the order they are read. */
export const LOT_KEYS = Object.freeze(['corner_lots', 'towers', 'gate_lot', 'gateLots', 'gate', 'gates', 'joins', 'anchors']);
const NORMAL = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
const FRONT = { '0,-1': 'north', '1,0': 'east', '0,1': 'south', '-1,0': 'west' };
const VEC = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
const key = (x, z) => `${x},${z}`;
const grow = (a, n) => ({ minX: a.minX - n, minZ: a.minZ - n, maxX: a.maxX + n, maxZ: a.maxZ + n });
const meets = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;

// ------------------------------------------------------------------ §1: the lots a wall names

/** A lot's type and size from its zone's program (`specOf(lotId)` -> {type, size, zone} | null). */
export function lotSpecOf(V) {
  const m = new Map();
  for (const p of V.parts) if (p.family === 'zone') for (const l of zoneLots(p.part)) if (l.lot && typeof l.id === 'string') m.set(l.id, { type: l.lot.type ?? null, size: Array.isArray(l.lot.size) ? l.lot.size : null, zone: p.id });
  return (id) => m.get(id) ?? null;
}

/** By the lot's type, else its id's stem: a gatehouse goes on a gate run, a tower on a corner (then a run), anything else on a run. */
function atByType(id, spec) {
  const t = String(spec?.type ?? '').toLowerCase();
  if (GATE_TYPES.includes(t) || (!t && /^gatehouse(_|$)/.test(id))) return 'gate';
  if (CORNER_TYPES.includes(t) || (!t && /^(watch)?tower(_|$)/.test(id))) return 'corner';
  if (/^gatehouse(_|$)/.test(id)) return 'gate';
  if (/^(watch)?tower(_|$)/.test(id)) return 'corner';
  return 'run';
}

/**
 * §1: the lots a wall names, in reading order: `[{lot, at, near?, key}]`, the params keys read (`read`), and `gatesMin` (params.gates as
 * a list of lot ids sets gates.min to its length; null otherwise). With a `lots` member it alone is read; else the lenient mapping:
 * corner_lots -> corner; towers -> corner (the ring's four corners first), then run; gate_lot, gateLots, gate (a lot id), gates (lot ids)
 * -> gate; joins and anchors by the lot's type (atByType). A lot named twice is read once (the first). `form`: the wall's form (a line
 * has no corners: a corner lot there is a run lot).
 */
export function wallLotsOf(part, specOf, form) {
  const out = [], read = [], seen = new Set();
  let gatesMin = null;
  const add = (lot, at, k, near) => {
    if (typeof lot !== 'string' || seen.has(lot) || out.length >= WALL_LOTS_MAX) return;
    seen.add(lot);
    out.push({ lot, at: form === 'line' && at === 'corner' ? 'run' : at, ...(near ? { near } : {}), key: k });
  };
  if (Array.isArray(part?.lots)) {
    for (const q of part.lots) add(q?.lot, AT.includes(q?.at) ? q.at : atByType(q?.lot, specOf(q?.lot)), 'lots', q?.near ?? null);
    return { named: out, read, gatesMin };
  }
  const P = part?.params && typeof part.params === 'object' && !Array.isArray(part.params) ? part.params : {};
  const list = (v) => (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string');
  let corners = 0;
  for (const k of LOT_KEYS) {
    const v = P[k];
    if (v === undefined) continue;
    // (gates: a number is K1's gates.min, read by readParams; only a list of lot ids is K3's)
    if (k === 'gates' && !Array.isArray(v)) continue;
    if (k === 'gate' && typeof v !== 'string') continue;
    const ids = list(v);
    if (!ids.length) continue;
    read.push(k);
    for (const id of ids) {
      if (k === 'corner_lots') { add(id, 'corner', k); corners++; }
      else if (k === 'towers') { add(id, corners < 4 ? 'corner' : 'run', k); corners++; }
      else if (k === 'joins' || k === 'anchors') add(id, atByType(id, specOf(id)), k);
      else add(id, 'gate', k);
    }
    if (k === 'gates') gatesMin = ids.length;
  }
  return { named: out, read, gatesMin };
}

/** The zone a wall targets (around a zone part, or on a zone's edge), else null. */
export function wallZoneOf(part, V) {
  const z = part?.where?.around?.feature?.part ?? part?.where?.inside?.part ?? null;
  return z && V.byId.get(z)?.family === 'zone' ? z : null;
}

/**
 * §2: per zone id, the set of lot ids its ring walls (wall.around and wall.edge on that zone) site on their lines: the named lots of the
 * wall's own zone, less `back` (lots an earlier compile of the plan sent back: they fitted nowhere on the line). Only lots of a zone
 * laid out by a street or a free layout are withheld (a districts, terraced or following zone keeps its lots: noted by the wall).
 * Empty for every plan whose walls name no lot.
 */
export function withheldOf(V, back = new Set()) {
  const out = new Map();
  const specOf = lotSpecOf(V);
  for (const p of V.parts) {
    if (p.block !== 'connector.wall' || p.verdict !== 'compile') continue;
    const form = p.part.where?.around ? 'around' : p.part.where?.inside ? 'edge' : null;
    if (!form) continue;
    const zid = wallZoneOf(p.part, V);
    if (!zid || !withholds(V.byId.get(zid))) continue;
    for (const q of wallLotsOf(p.part, specOf, form).named) {
      if (back.has(q.lot) || specOf(q.lot)?.zone !== zid) continue;
      if (!out.has(zid)) out.set(zid, new Set());
      out.get(zid).add(q.lot);
    }
  }
  return out;
}

/** Whether a zone's lots can be withheld (a street zone or a free layout; not a districts, terraced, following or outpost zone). */
export function withholds(z) {
  const prog = z?.part?.program;
  if (!prog || Array.isArray(prog.districts) || z.part.terraces !== undefined || z.part.where?.along || z.kind === 'outpost') return false;
  if (prog.template !== undefined && prog.template !== 'flat_village') return false;
  return true;
}

/** A zone part without the lots `ids` (program.lots or program.params.lots). */
export function withhold(zone, ids) {
  if (!ids?.size) return zone;
  const prog = zone.program;
  if (Array.isArray(prog.lots)) return { ...zone, program: { ...prog, lots: prog.lots.filter((l) => !ids.has(l?.id)) } };
  if (Array.isArray(prog.params?.lots)) return { ...zone, program: { ...prog, params: { ...prog.params, lots: prog.params.lots.filter((l) => !ids.has(l?.id)) } } };
  return zone;
}

/** §3's band: the least offset of a ring that keeps a lot straddling the line clear of the zone's lots + 1 (its depth across the line). */
export function lotBand(named, specOf) {
  let deep = 0;
  for (const q of named) {
    const s = specOf(q.lot)?.size;
    if (!s) continue;
    deep = Math.max(deep, q.at === 'corner' ? Math.max(s[0], s[1]) : s[1]);
  }
  return deep ? Math.ceil(deep / 2) + 2 : null;
}

// ------------------------------------------------------------------ §3: siting on a ring

/** A box's world rect for a straight run a..b of side `side` (positions), `d` deep across the line (its band in the middle). */
function runBox(W, a, b, side, d) {
  const I = W.I, t = W.st.thickness, c = (t - 1) >> 1;
  const o0 = c - ((d - 1) >> 1), o1 = o0 + d - 1;
  const ps = [W.positions[a], W.positions[b]];
  const lo = side === 'n' || side === 's' ? Math.min(ps[0].x, ps[1].x) : Math.min(ps[0].z, ps[1].z);
  const hi = side === 'n' || side === 's' ? Math.max(ps[0].x, ps[1].x) : Math.max(ps[0].z, ps[1].z);
  if (side === 'n') return { minX: lo, maxX: hi, minZ: I.minZ - o1, maxZ: I.minZ - o0 };
  if (side === 's') return { minX: lo, maxX: hi, minZ: I.maxZ + o0, maxZ: I.maxZ + o1 };
  if (side === 'w') return { minZ: lo, maxZ: hi, minX: I.minX - o1, maxX: I.minX - o0 };
  return { minZ: lo, maxZ: hi, minX: I.maxX + o0, maxX: I.maxX + o1 };
}

/** The four corners of a ring, clockwise from the north-west: [{ci, x, z (the band's corner square's centre), pos}]. */
function ringCorners(W) {
  const I = W.I, c = (W.st.thickness - 1) >> 1;
  const at = (x, z) => W.positions.findIndex((p) => p.x === x && p.z === z);
  return [
    { ci: 0, x: I.minX - c, z: I.minZ - c, pos: at(I.minX, I.minZ) },
    { ci: 1, x: I.maxX + c, z: I.minZ - c, pos: at(I.maxX, I.minZ) },
    { ci: 2, x: I.maxX + c, z: I.maxZ + c, pos: at(I.maxX, I.maxZ) },
    { ci: 3, x: I.minX - c, z: I.maxZ + c, pos: at(I.minX, I.maxZ) },
  ];
}

/** The cardinal from (dx, dz), the larger axis winning (x on a tie). */
const cardinal = (dx, dz) => (Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : (dz >= 0 ? 'south' : 'north'));

/**
 * Whether positions a..b (a straight run of one side, its jambs a - 1 and b + 1 included) are free for a lot: no corner, no end, no
 * gate, no cut position, no water gate. Returns the side or null.
 */
function lotRunFree(W, a, b) {
  const n = W.positions.length;
  if (a - 1 < 0 || b + 1 >= n) return null;
  const side = W.positions[a].side;
  if (!side) return null;
  for (let i = a - 1; i <= b + 1; i++) {
    const p = W.positions[i];
    if (p.side !== side || p.axis === 3 || W.ends.includes(i) || W.cutPos?.has(i)) return null;
    if (W.gates.some((g) => i >= g.a - 1 && i <= g.b + 1)) return null;
    if (W.waterPos?.has(i) || W.wetPos?.has(i)) return null;
  }
  return side;
}

/** The free run of `w` positions nearest point `pt` along the ring (wrap distance on a closed ring), ties by position: {a, b, side} | null. */
function nearestLotRun(W, pt, w) {
  const n = W.positions.length;
  let proj = 0, pd = Infinity;
  W.positions.forEach((q, i) => { if (W.cutPos?.has(i)) return; const dx = q.x - pt[0], dz = q.z - pt[1], d = dx * dx + dz * dz; if (d < pd) { pd = d; proj = i; } });
  let best = null;
  for (let a = 1; a + w - 1 < n - 1; a++) {
    const b = a + w - 1, side = lotRunFree(W, a, b);
    if (!side) continue;
    const m = (a + b) >> 1, along = W.closed ? Math.min(Math.abs(m - proj), n - Math.abs(m - proj)) : Math.abs(m - proj);
    if (!best || along < best.d) best = { a, b, side, d: along };
  }
  return best;
}

/** The run of `w` positions centred on the longest stretch of free positions of one side (its jambs free too), or null. */
function longestStretchRun(W, w) {
  const n = W.positions.length;
  let best = null;
  for (let a = 1; a < n - 1; a++) {
    if (!lotRunFree(W, a, a) || (a > 1 && lotRunFree(W, a - 1, a - 1) && W.positions[a - 1].side === W.positions[a].side)) continue;
    let b = a;
    while (b + 1 < n - 1 && W.positions[b + 1].side === W.positions[a].side && lotRunFree(W, b + 1, b + 1)) b++;
    if (b - a + 1 >= w && (!best || b - a > best.b - best.a)) best = { a, b };
  }
  if (!best) return null;
  const a = ((best.a + best.b) >> 1) - ((w - 1) >> 1);
  const side = lotRunFree(W, a, a + w - 1);
  return side ? { a, b: a + w - 1, side } : null;
}

/** Why a box (with its apron) is not clear on the wall's grid, the claim and the other boxes: a short word, or null when clear. */
function boxBlocked(W, box, boxes) {
  const G = W.G, A = grow(box, 1);
  for (let z = A.minZ; z <= A.maxZ; z++) for (let x = A.minX; x <= A.maxX; x++) {
    const k = G.at(x, z);
    if (k < 0) return 'the claim';
    if (G.walk[k]) return 'a street or walk';
    const o = G.ob[k];
    if (o === OB.OUT_OF_CLAIM) return 'the claim\'s margin';
    if (o === OB.PROTECTED || o === OB.KEEP_OUT) return 'a protected area';
    if (o === OB.WATER) return 'water';
    if (o === OB.BODY) return 'a plan body';
    if (o) return 'a lot, zone, form or another region';
  }
  for (const b of boxes) if (meets(grow(b, LOT_GAP), box)) return 'another lot on the wall';
  return null;
}

/**
 * §3: site the named lots of wall W (a ring: wall.around or wall.edge, its I and cells placed) on its line. Corners first (clockwise from
 * the north-west), then gates (the run facing a zone street end first, then `near`, then evenly), then runs (evenly). Each lot's box
 * straddles the line, its band in the middle; a gate lot's front faces out, a corner's toward the zone's centre, a run lot's in. The
 * wall's cells inside the boxes are dropped (K5), the positions they emptied cut, the positions beside each cut its end posts. Each lot
 * is emitted as the zone's lot (r.lot on a pad, its zone's prefix aside: the plan's own lot id) with its onWall record; a gatehouse gets
 * its passage (§4). Returns {sited: [rec], back: [{lot, why}], notes}.
 */
export function siteWallLots(K, W, named) {
  const r = K.r, out = { sited: [], back: [], notes: [] };
  if (!W.I || !named.length) return out;
  const specOf = K.lotSpec;
  const zid = W.target?.zone ?? null;
  const zr = zid ? K.geom.get(zid)?.rect ?? null : null;
  const zc = zr ? [(zr.minX + zr.maxX) / 2, (zr.minZ + zr.maxZ) / 2] : [(W.I.minX + W.I.maxX) / 2, (W.I.minZ + W.I.maxZ) / 2];
  W.cutPos ??= new Set();
  const boxes = [];
  let pads = null;
  const place = (q, box, front, kind, extra = {}) => {
    const why = boxBlocked(W, box, boxes);
    if (why) return why;
    const sx = box.maxX - box.minX + 1, sz = box.maxZ - box.minZ + 1;
    const cp = K.checkpoint();
    const fresh = !pads;
    let lot;
    try {
      if (!pads) { pads = r.part(`wl_${W.id}`.slice(0, 48), { stage: K.stageOf('ground') }); (r.meta.parts[pads.id] ??= {}).kind = 'pad'; }
      lot = pads.lot(q.lot, { at: [box.minX, box.minZ], size: [sx, sz], front, max: [sx, WALL_LOT_HEIGHT, sz], pad: { ...WALL_LOT_PAD, edge: 'slope' }, stage: K.stageOf('lots'),
        ext: { 'architect_mc:wall': { wall: W.id, at: q.at } } });
    } catch (e) {
      K.rollback(cp);
      if (fresh) pads = null;
      return /pad needs a cut/.test(e.message) ? `the ground (${e.message.replace(/^lot [^:]+: /, '')})` : e.message;
    }
    K.mark(zid ?? W.id, K.addedSince(cp));
    boxes.push(box);
    const rec = { lot: q.lot, at: q.at, key: q.key, kind, box: [box.minX, lot.floorY, box.minZ, box.maxX, lot.box.maxY, box.maxZ], front, floorY: lot.floorY, entrance: r.meta.lots[q.lot].entrance, size: [sx, sz], ...extra };
    out.sited.push(rec);
    return null;
  };
  // ---- corners (wall.around and wall.edge rings only; a corner of an open ring's omitted side is no corner)
  const corners = ringCorners(W).filter((c) => c.pos >= 0 && W.cells.some((q) => q.pos === c.pos));
  const usedCorner = new Set();
  for (const q of named.filter((x) => x.at === 'corner')) {
    const s = specOf(q.lot)?.size;
    if (!s) { out.back.push({ lot: q.lot, why: 'its size is unknown' }); continue; }
    let why = 'no free corner';
    for (const c of corners) {
      if (usedCorner.has(c.ci)) continue;
      const front = cardinal(zc[0] - c.x, zc[1] - c.z);
      const [ex, ez] = front === 'north' || front === 'south' ? [s[0], s[1]] : [s[1], s[0]];
      const box = { minX: c.x - ((ex - 1) >> 1), minZ: c.z - ((ez - 1) >> 1) };
      box.maxX = box.minX + ex - 1; box.maxZ = box.minZ + ez - 1;
      why = place(q, box, front, 'corner', { corner: c.ci });
      if (!why) { usedCorner.add(c.ci); break; }
    }
    if (why) out.back.push({ lot: q.lot, why: `no corner of the ring holds it (${why})` });
    else cutBox(W, boxes[boxes.length - 1]);
  }
  // ---- gates: the run a zone street end faces first, then `near`, then evenly
  const ends = streetEnds(K, zid);
  const gates = named.filter((x) => x.at === 'gate');
  const n = W.positions.length;
  const freeEnds = [...ends];
  gates.forEach((q, gi) => {
    const s = specOf(q.lot)?.size;
    if (!s) { out.back.push({ lot: q.lot, why: 'its size is unknown' }); return; }
    const [w, d] = s;
    const pts = [];
    // (a zone street end first (the one nearest `near` when given), then `near` itself, then evenly)
    let np = null;
    if (q.near) { const nq = K.endpointNode(q.near, null, W.p, `lots[${gi}].near`); if (!nq.error) np = [nq.at[0], nq.at[2]]; }
    if (freeEnds.length) {
      const d = (e) => (np ? Math.max(Math.abs(e[0] - np[0]), Math.abs(e[1] - np[1])) : 0);
      const k = freeEnds.map((e, i) => i).sort((i1, i2) => d(freeEnds[i1]) - d(freeEnds[i2]) || i1 - i2)[0];
      pts.push(freeEnds[k]);
      freeEnds.splice(k, 1);
    }
    if (np) pts.push(np);
    const target = W.positions[Math.floor((n * (2 * gi + 1)) / (2 * Math.max(1, gates.length)))] ?? W.positions[0];
    pts.push([target.x, target.z]);
    let why = 'no straight run with room';
    for (const pt of pts) {
      const run = nearestLotRun(W, pt, w);
      if (!run) continue;
      const box = runBox(W, run.a, run.b, run.side, d);
      const out0 = NORMAL[run.side], front = FRONT[key(out0[0], out0[1])];
      why = place(q, box, front, 'gate', { run: [run.a, run.b], side: run.side });
      if (!why) break;
    }
    if (why) out.back.push({ lot: q.lot, why: `no gate run holds it (${why})` });
    else cutBox(W, boxes[boxes.length - 1]);
  });
  // ---- runs: evenly along what is left, front facing in
  const runs = named.filter((x) => x.at === 'run');
  runs.forEach((q, ri) => {
    const s = specOf(q.lot)?.size;
    if (!s) { out.back.push({ lot: q.lot, why: 'its size is unknown' }); return; }
    const [w, d] = s;
    // (evenly: the middle of the longest free stretch of one side left, ties by position)
    const run = longestStretchRun(W, w) ?? (() => { const target = W.positions[Math.floor((n * (2 * ri + 1)) / (2 * runs.length))] ?? W.positions[0]; return nearestLotRun(W, [target.x, target.z], w); })();
    let why = 'no straight run with room';
    if (run) {
      const box = runBox(W, run.a, run.b, run.side, d);
      const o = NORMAL[run.side], front = FRONT[key(-o[0], -o[1])];
      why = place(q, box, front, 'run', { run: [run.a, run.b], side: run.side });
    }
    if (why) out.back.push({ lot: q.lot, why: `no run of the wall holds it (${why})` });
    else cutBox(W, boxes[boxes.length - 1]);
  });
  // the passages and the faces, now that every box is cut
  for (const rec of out.sited) finishLot(K, W, rec);
  return out;
}

/** The cells of W inside `box` are dropped; a position left with none is cut; the positions beside each cut run are its end posts. */
export function cutBox(W, box) {
  const inBox = (c) => c.x >= box.minX && c.x <= box.maxX && c.z >= box.minZ && c.z <= box.maxZ;
  const before = new Map();
  for (const c of W.cells) before.set(c.pos, (before.get(c.pos) ?? 0) + 1);
  W.cells = W.cells.filter((c) => !inBox(c));
  const left = new Map();
  for (const c of W.cells) left.set(c.pos, (left.get(c.pos) ?? 0) + 1);
  for (const [p] of before) if (!left.has(p)) W.cutPos.add(p);
  W.cellAt = new Map(W.cells.map((c) => [key(c.x, c.z), c]));
  // the end posts: the uncut positions beside a cut one (a ring wraps)
  const n = W.positions.length, ends = new Set(W.ends);
  for (const p of W.cutPos) for (const q of [p - 1, p + 1]) {
    const i = W.closed ? ((q % n) + n) % n : q;
    if (i >= 0 && i < n && !W.cutPos.has(i) && left.has(i)) ends.add(i);
  }
  for (const p of W.cutPos) ends.delete(p);
  W.ends = [...ends].sort((a, b) => a - b);
}

/** The zone's street ends (V's two, a free layout's, a districts zone's), each [x, z]; in the order gates.min takes them. */
function streetEnds(K, zid) {
  const z = zid ? K.zoneEmit.get(zid) : null;
  const pts = [];
  if (!z) return pts;
  if (z.districts) { for (const e of Object.values(z.districts.ends ?? {})) for (const q of e) pts.push([q.x, q.z]); return pts; }
  if (z.free) { for (const q of z.L.streets ?? []) if (q.cells?.length) { pts.push([q.cells[0][0], q.cells[0][1]]); pts.push([q.cells[q.cells.length - 1][0], q.cells[q.cells.length - 1][1]]); } return pts; }
  if (z.L?.orientation && z.L.road) {
    const o = z.L.orientation, sv = z.L.road.sv;
    for (const u of [z.L.u0 - 1, z.L.u1 + 1]) pts.push(o === 'ew' ? [u, sv] : [sv, u]);
  }
  return pts;
}

/** The widest walk that crosses walls in the plan (the passage is at least that wide, at least PASSAGE_MIN; never past the box). */
function passageWidth(K, w) {
  let pw = PASSAGE_MIN;
  for (const p of K.order) if (p.family === 'connector' && ['street', 'road', 'path', 'auto'].includes(p.kind)) pw = Math.max(pw, p.part.width ?? (p.kind === 'path' ? 1 : 3));
  pw = Math.min(pw, w - 2);
  return pw - ((pw & 1) ? 0 : 1) >= PASSAGE_MIN ? pw : PASSAGE_MIN;
}

/** Runs [x, z, y0, y1] of cells [[x, y, z]] (a column's consecutive ys joined), in (x, z, y) order, flat. */
function flatRuns(cells) {
  const s = [...cells].sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
  const out = [];
  for (const [x, y, z] of s) {
    const L = out.length;
    if (L && out[L - 4] === x && out[L - 3] === z && out[L - 1] === y - 1) out[L - 1] = y; else out.push(x, z, y, y);
  }
  return out;
}

/**
 * A sited lot's onWall record (§5, §6): its outer faces (the box's edge cells on or outside the ring's inner line, rows floorY..+2, the
 * passage's aside) and, for a gatehouse, its passage: the box's centre line front to back, `pw` wide, PASSAGE_HEIGHT high over the
 * floor, its ports the cells just outside the front and back faces at the floor's feet y (the front port is the lot's entrance).
 */
function finishLot(K, W, rec) {
  const [x0, , z0, x1, , z1] = rec.box, fy = rec.floorY;
  const I = W.I;
  const outer = (x, z) => !(x > I.minX && x < I.maxX && z > I.minZ && z < I.maxZ);
  const lot = K.r.lots.find((l) => l.id === rec.lot);
  let passage = null;
  const pass = new Set();
  if (rec.kind === 'gate') {
    // (the passage's front faces out of the wall: a gate lot's front; a via lot's across the line (passFacing))
    const pf = rec.passFacing ?? rec.front;
    const [fx, fz] = VEC[pf];
    const along = fx === 0; // the front faces north or south: the passage runs along z
    const w = along ? x1 - x0 + 1 : z1 - z0 + 1;
    const pw = passageWidth(K, w);
    const lo = -((pw - 1) >> 1), hi = pw >> 1;
    // (the cell in front of the middle of the front edge: r.lot's entrance rule, so a gate lot's front port is its entrance)
    const e = along ? [x0 + ((x1 - x0) >> 1), fy, fz < 0 ? z0 - 1 : z1 + 1] : [fx < 0 ? x0 - 1 : x1 + 1, fy, z0 + ((z1 - z0) >> 1)];
    const cx = along ? e[0] : null, cz = along ? null : e[2];
    const cells = [], floor = [];
    for (let v = lo; v <= hi; v++) {
      if (along) for (let z = z0; z <= z1; z++) { pass.add(key(cx + v, z)); floor.push(cx + v, z, fy - 1); for (let y = fy; y < fy + PASSAGE_HEIGHT; y++) cells.push([cx + v, y, z]); }
      else for (let x = x0; x <= x1; x++) { pass.add(key(x, cz + v)); floor.push(x, cz + v, fy - 1); for (let y = fy; y < fy + PASSAGE_HEIGHT; y++) cells.push([x, y, cz + v]); }
    }
    const front = [e[0], fy, e[2]];
    const back = along ? [cx, fy, fz < 0 ? z1 + 1 : z0 - 1] : [fx < 0 ? x1 + 1 : x0 - 1, fy, cz];
    const F = lotFrame(lot);
    const lotCells = flatRuns(cells.map(([x, y, z]) => { const [u, yy, v] = F.toFrame(x, y, z); return [u, yy, v]; }));
    passage = { width: pw, height: PASSAGE_HEIGHT, cells: flatRuns(cells), lotCells, floor, front, back, lintelY: fy + PASSAGE_HEIGHT, facing: pf };
    rec.ports = [{ name: 'front', at: front, facing: pf }, { name: 'back', at: back, facing: { north: 'south', south: 'north', east: 'west', west: 'east' }[pf] }];
  }
  const faces = [];
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    if (x !== x0 && x !== x1 && z !== z0 && z !== z1) continue;
    if (!outer(x, z) || pass.has(key(x, z))) continue;
    for (let y = fy; y <= fy + 2; y++) faces.push([x, y, z]);
  }
  const F = lotFrame(lot);
  rec.onWall = {
    wall: W.id, at: rec.at, floorY: fy, frame: [...F.size],
    outerFaces: { cells: flatRuns(faces), lotCells: flatRuns(faces.map(([x, y, z]) => F.toFrame(x, y, z))) },
    ...(passage ? { passage } : {}),
  };
  if (lot) { lot.onWall = rec.onWall; if (rec.ports) lot.ports = rec.ports; }
}

/**
 * A wall.line's via lots (K1's joined lots: the line meets the box's faces): their onWall records. The line enters and leaves the box
 * through two faces; where those are the lot's sides (the line runs across the lot), a gatehouse's passage runs front to back through the
 * box's centre and the back face is its outer face; else (the line enters at the front or back) no passage, noted. Returns [rec].
 */
export function viaLots(K, W) {
  const out = [];
  for (const id of W.joined ?? []) {
    const lot = K.r.lots.find((l) => l.id === id);
    if (!lot) continue;
    const spec = K.lotSpec(id);
    const gate = atByType(id, spec) === 'gate';
    const b = lot.box, fy = lot.floorY;
    const [fx, fz] = VEC[lot.front] ?? [0, 1];
    // the faces the wall meets: wall cells beside the box
    const met = new Set();
    for (const c of W.cells) {
      if (c.x === b.minX - 1 && c.z >= b.minZ && c.z <= b.maxZ) met.add('west');
      if (c.x === b.maxX + 1 && c.z >= b.minZ && c.z <= b.maxZ) met.add('east');
      if (c.z === b.minZ - 1 && c.x >= b.minX && c.x <= b.maxX) met.add('north');
      if (c.z === b.maxZ + 1 && c.x >= b.minX && c.x <= b.maxX) met.add('south');
    }
    const across = !met.has(lot.front) && ![...met].some((f) => VEC[f][0] === -fx && VEC[f][1] === -fz);
    // (the passage crosses the line: front to back where the line meets the lot's sides; else side to side, its front east or south)
    const passFacing = across ? lot.front : met.has('north') || met.has('south') ? 'east' : 'south';
    const rec = { lot: id, at: 'via', key: 'via', kind: gate ? 'gate' : 'run', box: [b.minX, fy, b.minZ, b.maxX, b.maxY, b.maxZ], front: lot.front, passFacing, floorY: fy, entrance: K.r.meta.lots[id].entrance, size: [b.maxX - b.minX + 1, b.maxZ - b.minZ + 1] };
    const notes = [];
    // (a line's closure is open; the lot's outer face is the passage's front side (its far side across the line), the passage's cells aside)
    finishLot(K, { id: W.id, I: { minX: b.minX - 1, maxX: b.maxX + 1, minZ: b.minZ - 1, maxZ: b.maxZ + 1 } }, rec);
    const pass = new Set();
    const pc = rec.onWall.passage?.cells ?? [];
    for (let k = 0; k < pc.length; k += 4) pass.add(key(pc[k], pc[k + 1]));
    const faces = [];
    for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) {
      const on = (passFacing === 'north' && z === b.minZ) || (passFacing === 'south' && z === b.maxZ) || (passFacing === 'west' && x === b.minX) || (passFacing === 'east' && x === b.maxX);
      if (!on || pass.has(key(x, z))) continue;
      for (let y = fy; y <= fy + 2; y++) faces.push([x, y, z]);
    }
    const F = lotFrame(lot);
    rec.onWall.outerFaces = { cells: flatRuns(faces), lotCells: flatRuns(faces.map(([x, y, z]) => F.toFrame(x, y, z))) };
    lot.onWall = rec.onWall;
    if (gate && !across) notes.push(`${id}: the line meets its front or back face, so its passage runs side to side across the line (front ${passFacing})`);
    out.push({ rec, notes });
  }
  return out;
}
