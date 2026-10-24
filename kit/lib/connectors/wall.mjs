// (7a K1a) Walls and gates in the plan compiler (docs/CONTRACT.md "Phase 7a slice K1" §3, §4, §5, §7 and Steward's review): the
// hooks compile.mjs calls with its context K.
//   planWalls(K)        compile order step 2: each wall's line (wall.around, wall.edge, wall.line), its gates placed `at` an
//                       endpoint and its crossings of the walk networks already laid out (zones' streets and lanes, districts'
//                       routes): all open before routing
//   wallsPassInput(K)   the route pass's `walls` (the gate move: wall cells are obstacles, crossed only through a gate)
//   wallsRouted(K, e)   after a route pass that routed: the gates its edges opened stay open
//   finishGates(K)      step 4: gates by `crossing` (the gate that connector's route opened), the auto gates, gates.min
//   emitWalls(K)        step 5, the links stage: every wall and its gates, each wall under a checkpoint
// A wall is sealed (no gate at all, S-K1-1) when its gates are 0, or when it is written closed: true and neither a gate part nor a
// recorded member names a gate (params gates, gate, gate_lot, gateLots: Steward's recorded plans name their gates that way).
// (6c H-b, §8.2) Harbour walls: a wall whose ring fails on water (OB.WATER), or whose line finds no clear leg on a claim with water, is
// searched once more over the wet grid (wetWallFallback: natural water up to waterDepth, default 6, clear at 3 a cell; the plan's own
// water stays an obstacle). Its wet sections stand full height over the water's surface, solid through the water to a footing 2 into
// the bed (bed - 1), in a block that may stand under water (full, non-waterloggable, no gravity); no gate stands in a wet section. The
// water under them is read from a frozen volume (the first plan asks it: incomplete VOLUME), recorded (meta.wet, kind wall) and
// guarded; the answer's geometry gains `wet: [{from, to, depth}]` and `crossing {type: wall, over: water, depth}`.
import { readParams } from './params.mjs';
import { MARGIN, OB, alongLine, alongSide, lineCells, lineLeg, obstacleGrid, placeRing, ringCells } from './line.mjs';
import { normalAt, traceBoundary } from '../region/boundary.mjs';
import { doorOf, shapeOf } from './style.mjs';
import { bomOf } from './bom.mjs';
import { centreCells } from '../region/geom.mjs';
import { footprintOf } from '../region/passes/route.mjs';
import { fixtureCells } from '../region/fixtures.mjs';
import { lampFixture } from '../region/props.mjs';
import { besidePorts } from '../region/districtsEmit.mjs';
import { COND } from '../region/program.mjs';
import { askWet, noteWet, underwaterBlock, underwaterOk, wetKind, wetRuns, wetWallFallback } from '../fluids/wet.mjs';
import { waterGates } from '../fluids/gate.mjs';
import { keptColumns } from '../fluids/keep.mjs';
import { emitWalk, walkLevels, walkOf } from './wallWalk.mjs';

/** The kinds this module compiles. */
export const WALL_KINDS = Object.freeze(['wall', 'gate']);
/** §3 and N-K1-1's defaults. */
export const WALL_DEFAULTS = Object.freeze({ height: 6, thickness: 2, crenels: true, corners: 'plain', ring: [4, 12], gatesMin: 1, gatesMax: 16, gateWidth: 3, gateHeight: 3, frame: 'arch', door: 'none', edgeStep: 12 });
/** Recorded members that name a gate (so a closed wall that writes one is not sealed). */
const GATE_KEYS = ['gates', 'gate', 'gate_lot', 'gateLots'];

const key = (x, z) => `${x},${z}`;
const rect = (q) => ({ minX: q[0], minZ: q[1], maxX: q[2], maxZ: q[3] });
const arr = (a) => [a.minX, a.minZ, a.maxX, a.maxZ];
const grow = (a, n) => ({ minX: a.minX - n, minZ: a.minZ - n, maxX: a.maxX + n, maxZ: a.maxZ + n });
const centre = (a) => [(a.minX + a.maxX) >> 1, (a.minZ + a.maxZ) >> 1];
const boxGap = (b, x, z) => Math.max(Math.max(0, b.minX - x, x - b.maxX), Math.max(0, b.minZ - z, z - b.maxZ));

// ------------------------------------------------------------------ the world the walls see

/** A y-ref resolved at a column (columns ops' from/to): {abs}, a number, {surface}, {floor}; null when it can't be. */
function yref(S, v, x, z) {
  if (typeof v === 'number') return v;
  if (v && typeof v.abs === 'number') return v.abs;
  if (v && typeof v.surface === 'number') return S.groundAt(x, z) + v.surface;
  if (v && typeof v.floor === 'number') return S.floorAt(x, z) + v.floor;
  return null;
}

/**
 * The walk cells of the networks laid out so far ([[x, z, y]]: y the surface block): 4e roads (on the survey's ground), every
 * `columns` op written as a walk (routes, lanes, squares), the villages' lanes.
 */
export function networkWalk(r, S) {
  const out = [];
  for (const rd of r.roads) {
    const { cells } = centreCells(rd.points.map((q) => [q[0], q[2]]));
    for (const [x, z] of footprintOf(cells.map((c) => [c.x, S.groundAt(c.x, c.z), c.z]), rd.width)) out.push([x, z, S.groundAt(x, z)]);
  }
  for (const p of r.parts) for (const op of p.ops) {
    if (op.op !== 'columns' || !op.walk) continue;
    for (let i = 0; i < op.cols.length; i += 5) {
      const x = op.cols[i], z = op.cols[i + 1], b = op.cols[i + 3], m = op.cols[i + 4];
      if (op.materials[m] === null) continue;
      const top = yref(S, op.to, x, z);
      if (top !== null) out.push([x, z, top + b]);
    }
  }
  for (const v of [r.meta.village, ...Object.values(r.meta.villageZones ?? {})]) for (const cells of Object.values(v?.lanes ?? {})) for (const c of cells) out.push([c[0], c[2], c[1] - 1]);
  return out;
}

/** The standable surface near the walls: the survey's ground, raised by walk surfaces and lot pads (box, apron and batter rings). */
function standMap(K, walk) {
  const S = K.env.S, m = new Map();
  const up = (x, z, y) => { const k = key(x, z); if (!(m.get(k) >= y)) m.set(k, y); };
  for (const [x, z, y] of walk) up(x, z, y);
  for (const l of K.r.lots) {
    const top = (l.floorY ?? l.box.minY) - 1, b = l.box;
    const F = Math.max(1, l.pad?.maxFill ?? 0);
    for (let k = 0; k <= F + 1; k++) for (let z = b.minZ - k; z <= b.maxZ + k; z++) for (let x = b.minX - k; x <= b.maxX + k; x++) {
      if (k && x > b.minX - k && x < b.maxX + k && z > b.minZ - k && z < b.maxZ + k) continue;
      up(x, z, top - Math.max(0, k - 1));
    }
  }
  return (x, z) => Math.max(S.groundAt(x, z), m.get(key(x, z)) ?? -32768);
}

/**
 * The obstacle grid of K's claim, with the zones in `allowZones` lifted (a line wall into a joined lot's own zone). `walkStanding`:
 * (K1-target) a standing region of the owner the wall rings: its lots stay hard, its roads, paths and ways are walk cells (crossings
 * that get gates) at the surveyed ground.
 */
function gridOf(K, { allowZones = [], walkStanding = null, wet = null, bodies = true } = {}) {
  const env = K.env, r = K.r;
  const zoneRects = [];
  for (const p of K.order) {
    if (p.family !== 'zone' || allowZones.includes(p.id) || !K.okClass(p.id)) continue;
    const z = K.res.get(p.id);
    for (const q of z?.rects ?? (z?.rect ? [z.rect] : [])) zoneRects.push(q);
  }
  const lots = r.lots.map((l) => grow(l.box, 1));
  // ((6c F3 §3.2) a grown form's column mask (its runs), else its bounds)
  const forms = r.forms.flatMap((f) => (f.columns ? Array.from({ length: f.columns.length / 3 }, (_, i) => ({ minX: f.columns[3 * i + 1], minZ: f.columns[3 * i], maxX: f.columns[3 * i + 2], maxZ: f.columns[3 * i] })) : f.bounds ? [f.bounds] : []));
  const protectedR = [...env.protectedAreas.map((a) => a.rect), ...env.keepOut];
  const st = walkStanding ? env.standing.find((a) => a.id === walkStanding) : null;
  // ((6c D3, §9, S-D3-6) another standing region's reach (a district's join in the town's claim) is an obstacle too: the ring keeps off it)
  const standingHard = st ? env.standing.flatMap((a) => (a === st ? a.lots.map((q) => [q[0] - 1, q[1] - 1, q[2] + 1, q[3] + 1]) : [...a.lots.map((q) => [q[0] - 1, q[1] - 1, q[2] + 1, q[3] + 1]), ...a.keep, ...(Array.isArray(a.reach) ? a.reach : [])])) : env.standingHard;
  const overlap = [...zoneRects, ...lots, ...forms, ...env.regions.map((a) => grow(a.rect, 1)), ...env.buildRects.map((a) => grow(a.rect, 1)), ...standingHard.map(rect)];
  const walkCells = [...K.walk];
  if (st) for (const q of st.keep) for (let z = q[1]; z <= q[3]; z++) for (let x = q[0]; x <= q[2]; x++) walkCells.push([x, z, env.S.groundAt(x, z)]);
  // ((H-b) the wet grid: the plan's own water (its bodies' cells and shells) stays an obstacle)
  const wetO = wet ? { wet: { ...wet, plan: (r._fluidBodies ?? []).flatMap((b) => [...b.cells, ...b.shell].map((c) => [c[0], c[2]])) } } : {};
  // ((6c KC, §4) the plan's bodies' footprints (reserved at resolve: walls are planned before the bodies emit): OB.BODY, never WATER)
  const bodyCols = bodies && K.keep?.length ? keptColumns(K.keep) : [];
  return obstacleGrid({ claim: env.claim, cols: env.cols, rects: { [OB.PROTECTED]: protectedR, [OB.OVERLAP]: overlap }, walkCells, keepOut: [...protectedR, ...env.regions.map((a) => a.rect), ...env.buildRects.map((a) => a.rect)], kept: r._keptColumns(), ...wetO, ...(bodyCols.length ? { bodies: bodyCols } : {}) });
}

// ------------------------------------------------------------------ step 2: wall lines

/** The rect a wall.around rings: a zone, lot or form of the plan, a protected area or a build. Returns {rect, what} or {error}. */
function aroundTarget(K, f) {
  if (f.part !== undefined) {
    const g = K.geom.get(f.part);
    if (g?.rect) return { rect: g.rect, what: `part ${f.part}`, zone: K.byId.get(f.part)?.family === 'zone' ? f.part : null };
    const l = K.r.lots.find((x) => x.id === f.part);
    if (l) return { rect: { minX: l.box.minX, minZ: l.box.minZ, maxX: l.box.maxX, maxZ: l.box.maxZ }, what: `lot ${f.part}`, zone: K.lotZone.get(f.part) ?? null };
    return { error: { code: 'NO_FEATURE', message: `${f.part} has no geometry to wall round`, evidence: { feature: f } } };
  }
  if (f.protected !== undefined) {
    const a = K.env.protectedAreas.find((p) => p.id === f.protected);
    return a ? { rect: a.rect, what: `protected ${a.id}` } : { error: { code: 'NO_FEATURE', message: `no protected area "${f.protected}" meets the claim`, evidence: { feature: f } } };
  }
  if (f.region !== undefined) {
    // (K1-target) the owner's standing region: its footprint (lots, roads, paths and ways) bounds the ring; another owner's is refused
    const st = K.env.standing.find((a) => a.id === f.region);
    if (!st) return { error: { code: 'NO_FEATURE', message: K.env.regions.some((a) => a.id === f.region) ? `region ${f.region} is another owner's: a wall rings only its owner's standing regions` : `region ${f.region} is not a standing region of this owner meeting the claim`, evidence: { feature: f, standing: K.env.standing.map((a) => a.id) } } };
    const rs = [...st.lots, ...st.keep];
    if (!rs.length) return { error: { code: 'NO_FEATURE', message: `region ${f.region} has no footprint in reach of the claim`, evidence: { feature: f } } };
    const b = { minX: Math.min(...rs.map((q) => q[0])), minZ: Math.min(...rs.map((q) => q[1])), maxX: Math.max(...rs.map((q) => q[2])), maxZ: Math.max(...rs.map((q) => q[3])) };
    return { rect: b, what: `region ${f.region}`, standing: st };
  }
  if (f.build !== undefined) {
    const id = f.build.id ?? null, kind = f.build.kind ?? null;
    const b = id ? K.env.builds.find((x) => x.id === id) : K.env.builds.find((x) => String(x.kind).toLowerCase() === kind);
    const br = b && K.env.buildRects.find((x) => x.id === b.id);
    return br ? { rect: br.rect, what: `build ${b.id}` } : { error: { code: 'NO_FEATURE', message: `no build ${id ?? kind} in the claim`, evidence: { feature: f } } };
  }
  return { error: { code: 'NO_FEATURE', message: `a wall rings a part, a protected area or a build (not ${Object.keys(f)[0]})`, evidence: { feature: f } } };
}

/** The gate parts that name (or, with none named, belong to) a wall. */
const gateParts = (K, wallId) => K.k1Parts.filter((q) => q.kind === 'gate' && (q.part.wall === wallId || (q.part.wall === undefined && K.k1Parts.filter((w) => w.kind === 'wall').length === 1)));

/** A wall's settings from its part and its lenient params. */
function settingsOf(K, p) {
  const P = readParams('wall', p.part);
  const w = p.part;
  const g = w.gates;
  const gatesMin = Number.isInteger(g) ? g : Number.isInteger(g?.min) ? g.min : P.read.gatesMin ?? (w.where?.along ? 0 : WALL_DEFAULTS.gatesMin);
  const gatesMax = Number.isInteger(g?.max) ? g.max : g === 0 || P.read.gatesMin === 0 ? 0 : WALL_DEFAULTS.gatesMax;
  const form = w.where?.around ? 'around' : w.where?.inside ? 'edge' : w.where?.along ? 'along' : 'line';
  // ((7a K2, §2) an along wall is never closed: closed is noted, not read; gates.min defaults to 0 (people walk round its ends))
  const closedWritten = form === 'along' ? undefined : w.where?.around?.closed ?? P.read.closed;
  const closed = form === 'line' || form === 'along' ? false : closedWritten ?? true;
  if (form === 'along' && (P.read.closed !== undefined)) P.notes.push(`params.closed not read (an along wall is open)`);
  const namesGate = GATE_KEYS.some((k) => w.params?.[k] !== undefined && !(k === 'gates' && w.params[k] === 0));
  const sealed = gatesMax === 0 || (closedWritten === true && !gateParts(K, p.id).length && !namesGate);
  // ((7a K2, §1) the walk: the member, else params.wall_walk; with no thickness given the wall is walk.width + 1 thick (the outer course
  // the parapet))
  const walk = walkOf(w, P.read);
  return {
    form, P, closed, sealed, gatesMin: sealed ? 0 : gatesMin, gatesMax: sealed ? 0 : Math.max(gatesMax, gatesMin), walk,
    height: w.height ?? P.read.height ?? WALL_DEFAULTS.height, thickness: w.thickness ?? (walk ? walk.width + 1 : WALL_DEFAULTS.thickness),
    crenels: w.crenels ?? WALL_DEFAULTS.crenels, corners: w.corners ?? WALL_DEFAULTS.corners, lamps: w.lamps ?? P.read.lamps ?? 'gates',
  };
}

const blockerText = (b) => Object.entries(b).map(([k, v]) => `${k.toLowerCase().replace(/_/g, ' ')} ${v}`).join(', ');

/** Plan one wall's line: {positions, cells, ends, closed, I?, devs, notes, joined, crossings, G} or {error: reason}. */
function lineOf(K, p, st, wet = null, bodies = true) {
  const w = p.part, t = st.thickness;
  const notes = [], devs = [];
  if (st.form === 'around') {
    const tg = aroundTarget(K, w.where.around.feature);
    if (tg.error) return { error: tg.error };
    const [r0, r1] = Array.isArray(w.where.around.ring) ? w.where.around.ring : WALL_DEFAULTS.ring;
    const order = [];
    for (let d = r0; d <= r1; d++) order.push(d);
    const G = gridOf(K, { walkStanding: tg.standing?.id ?? null, wet, bodies });
    const pl = placeRing(G, tg.rect, order, t);
    // ((6c D3, S-D3-6) a ring round a standing region that another standing region's reach (a district's join) blocks: {kind: region})
    const reachBlocks = tg.standing && K.env.standing.some((a) => a !== tg.standing && Array.isArray(a.reach) && a.reach.length);
    if (!pl.ok) return { error: { code: pl.code, message: `no clear ring round ${tg.what} at offsets ${r0}..${r1} on its ${pl.side} side (${blockerText(pl.blockers)})`, evidence: { side: pl.side, ring: [r0, r1], blockers: pl.blockers, target: arr(tg.rect), ...(reachBlocks ? { kind: 'region' } : {}) } } };
    return { ...ringOf(K, pl, t, st, notes), devs, notes, target: tg, G };
  }
  if (st.form === 'along') return alongOf(K, p, st, bodies);
  if (st.form === 'edge') {
    const inside = w.where.inside;
    let R, what;
    const order = [];
    if (inside.claim) {
      R = grow(K.env.claim, -MARGIN);
      for (let d = -(t - 1); d >= -(t - 1) - WALL_DEFAULTS.edgeStep; d--) order.push(d);
      what = 'the claim';
    } else {
      const g = K.geom.get(inside.part);
      if (!g?.rect || K.byId.get(inside.part)?.family !== 'zone') return { error: { code: 'NO_FEATURE', message: `wall.edge runs on a zone or the claim (${inside.part} is not a zone with a rect)`, evidence: { inside } } };
      R = g.rect;
      for (let d = -(t - 1); d <= WALL_DEFAULTS.edgeStep; d++) order.push(d);
      what = `zone ${inside.part}`;
    }
    const G = gridOf(K, { allowZones: inside.part ? [inside.part] : [], wet, bodies });
    const pl = placeRing(G, R, order, t);
    if (!pl.ok) return { error: { code: pl.code, message: `no clear ring on the edge of ${what} (${pl.side} side: ${blockerText(pl.blockers)})`, evidence: { side: pl.side, blockers: pl.blockers, edge: arr(R) } } };
    // a side that stepped off the edge: its cells (a move deviation)
    const step = Math.max(...['n', 'e', 's', 'w'].map((s) => Math.abs(pl.o[s] - order[0])));
    if (step) { devs.push({ what: 'move', value: step }); notes.push(`${inside.claim ? 'stepped in from' : 'stepped out of'} ${what}'s edge by up to ${step} (the street layout or an obstacle reaches it)`); }
    return { ...ringOf(K, pl, t, st, notes), devs, notes, target: { rect: R, what, zone: inside.part ?? null }, G };
  }
  // wall.line: legs from, via, to; a lot endpoint ends the leg at its box's face and the next starts from the opposite face
  const ends = [w.from, ...(w.via ?? []), w.to];
  const joinedLots = ends.filter((e) => e.part !== undefined && K.lotZone.has(e.part)).map((e) => e.part);
  const lotOf = (id) => K.r.lots.find((l) => l.id === id);
  const allowZones = [...new Set(joinedLots.map((l) => K.lotZone.get(l)))];
  const G = gridOf(K, { allowZones, wet, bodies });
  const apron = new Set();
  for (const id of joinedLots) {
    const l = lotOf(id);
    if (!l) continue;
    const b = grow(l.box, 1);
    for (let z = b.minZ; z <= b.maxZ; z++) for (let x = b.minX; x <= b.maxX; x++) if (x < l.box.minX || x > l.box.maxX || z < l.box.minZ || z > l.box.maxZ) apron.add(G.at(x, z));
  }
  const free = (k) => apron.has(k);
  const pts = [];
  for (let i = 0; i < ends.length; i++) {
    const e = ends[i];
    if (e.part !== undefined && K.lotZone.has(e.part)) {
      const l = lotOf(e.part);
      if (!l) return { error: { code: 'NO_ROOM', message: `lot ${e.part} was not placed (unplaced in its zone)`, evidence: { lot: e.part } } };
      pts.push({ lot: l });
      continue;
    }
    const other = ends[i === ends.length - 1 ? i - 1 : i + 1];
    const n = K.endpointNode(e, other, p, i === 0 ? 'from' : i === ends.length - 1 ? 'to' : `via[${i - 1}]`);
    if (n.error) return { error: n.error.legacy ?? n.error }; // ((close-out A) a wall's end answers as before)
    pts.push({ at: [n.at[0], n.at[2]] });
  }
  // a lot's faces (headings: 0 E, 1 S, 2 W, 3 N): the face toward the other point, its apron cells (walk cells aside) any of which
  // ends the leg (arriving square on), and the opposite face's cell straight across, where the next leg starts
  const faceOf = (l, toward) => {
    const b = l.box, c = centre(b), dx = toward[0] - c[0], dz = toward[1] - c[1];
    const ok = (x, z) => { const k = G.at(x, z); return k >= 0 && !G.walk[k]; };
    if (Math.abs(dx) >= Math.abs(dz)) {
      const x = dx >= 0 ? b.maxX + 1 : b.minX - 1, ox = dx >= 0 ? b.minX - 1 : b.maxX + 1, h = dx >= 0 ? 2 : 0;
      const cells = []; for (let z = b.minZ; z <= b.maxZ; z++) if (ok(x, z) && ok(ox, z)) cells.push([x, z]);
      return { cells, mid: [x, c[1]], h, across: ([, z]) => [ox, z] };
    }
    const z = dz >= 0 ? b.maxZ + 1 : b.minZ - 1, oz = dz >= 0 ? b.minZ - 1 : b.maxZ + 1, h = dz >= 0 ? 3 : 1;
    const cells = []; for (let x = b.minX; x <= b.maxX; x++) if (ok(x, z) && ok(x, oz)) cells.push([x, z]);
    return { cells, mid: [c[0], z], h, across: ([x]) => [x, oz] };
  };
  const line = [], crossings = [];
  let prev = null;
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i];
    if (q.lot) {
      const from = prev?.cell ?? pts[i + 1]?.at ?? centre(q.lot.box);
      const f = faceOf(q.lot, from);
      if (!f.cells.length) return { error: { code: 'NO_ROOM', message: `lot ${q.lot.id}'s faces have no apron cell clear of walks for the wall to meet`, evidence: { lot: q.lot.id } } };
      let end;
      if (prev) {
        const leg = lineLeg(G, prev.cell, f.mid, t, { free, startH: prev.h ?? null, goalH: f.h, goals: f.cells });
        if (!leg) return { error: { code: 'NO_ROOM', message: `no clear wall line from ${prev.cell.join(', ')} to lot ${q.lot.id}'s face`, evidence: { leg: i, to: q.lot.id } } };
        appendLeg(line, crossings, leg);
        end = leg.cells[leg.cells.length - 1];
      } else end = f.cells.reduce((a, c) => (Math.abs(c[0] - f.mid[0]) + Math.abs(c[1] - f.mid[1]) < Math.abs(a[0] - f.mid[0]) + Math.abs(a[1] - f.mid[1]) ? c : a), f.cells[0]);
      prev = { cell: f.across(end), h: f.h };
      continue;
    }
    if (prev) {
      const leg = lineLeg(G, prev.cell, q.at, t, { free, startH: prev.h ?? null });
      if (!leg) return { error: { code: G.ob[G.at(q.at[0], q.at[1])] === OB.OUT_OF_CLAIM ? 'OUT_OF_CLAIM' : 'NO_ROOM', message: `no clear wall line for leg ${i} (to ${q.at.join(', ')})`, evidence: { leg: i, to: q.at } } };
      appendLeg(line, crossings, leg);
    }
    prev = { cell: q.at };
  }
  const lc = lineCells(line, t);
  if (joinedLots.length) notes.push(`joined lot${joinedLots.length > 1 ? 's' : ''} ${joinedLots.join(', ')}: the wall meets ${joinedLots.length > 1 ? 'their boxes' : 'its box'} (its closure provisional until the lot's entry binds)`);
  return { ...lc, crossings: crossings.map((c) => ({ positions: [c.from, c.to] })), devs, notes, joined: joinedLots, G };
}

/** (7a K2, §2) The default offset range of an along wall from its spine. */
export const ALONG_DISTANCE = Object.freeze([2, 8]);

/**
 * (7a K2, §2) A wall.along's line: D2's boundary (traceBoundary: a water feature's shore, a biome edge, a ridge; near the anchor when
 * given) as a spine, the side (alongSide), each run of 8 spine cells offset by its smallest clear distance (alongLine). No spine:
 * refused NO_FEATURE {why: boundary} (D2's NO_EDGE). The inside of an along wall faces away from its spine: its thickness stands toward
 * the boundary, so its inner course is the line (the coordinator's reading, 2026-10-23).
 */
function alongOf(K, p, st, bodies) {
  const al = p.part.where.along, f = al.feature ?? {}, fk = Object.keys(f)[0];
  const t = st.thickness, notes = [], devs = [];
  const follow = fk === 'water' ? { shore: { minArea: f.water?.minArea ?? 64 } } : fk === 'biome_edge' ? { biome_edge: { between: f.biome_edge.between } } : fk === 'ridge' ? { ridge: { minRise: f.ridge?.minRise ?? 8 } } : null;
  if (!follow) return { error: { code: 'NO_FEATURE', message: `an along wall follows a water body's shore, a biome edge or a ridge (not ${fk})`, evidence: { why: 'boundary', feature: f } } };
  const anchorName = al.anchor ?? f[fk]?.to ?? null;
  const near = anchorName ? K.env.anchors.get(anchorName) ?? null : null;
  const tb = traceBoundary(K.env.cols, K.env.claim, follow, { biomes: K.ctx.biomes ?? null, near, minLength: 16 });
  if (tb.none) return { error: { code: 'NO_FEATURE', message: `no boundary to wall along: ${tb.none.replace(/^NO_EDGE: /, '')}`, evidence: { why: 'boundary', feature: f, found: tb.none } } };
  const spine = tb.spine, nrm = spine.map((_, i) => normalAt(spine, i));
  const dist = Array.isArray(al.distance) ? [Math.min(...al.distance), Math.max(...al.distance)] : Number.isInteger(al.distance) ? [al.distance, al.distance] : [...ALONG_DISTANCE];
  const G = gridOf(K, { bodies });
  const waterAt = (x, z) => { const k = G.at(x, z); return k >= 0 && G.ob[k] === OB.WATER; };
  const sd = alongSide(G, spine, nrm, { side: al.side ?? 'either', kind: tb.kind, anchor: near, dist, waterAt });
  if (tb.kind === 'shore' && al.side && al.side !== 'either') notes.push(`side ${al.side} not read: a wall along a shore stands on the land`);
  const L = alongLine(G, spine, nrm, { sign: sd.sign, dist, t });
  const what = `${tb.kind === 'shore' ? 'the shore' : tb.kind === 'ridge' ? 'the ridge' : 'the biome edge'}`;
  if (!L.ok) return { error: { code: L.code, message: L.short !== undefined ? `the wall along ${what} leaves the claim (${L.short} positions inside its margin)` : `no clear offset for the wall along ${what} at ${dist[0]}..${dist[1]} (or within ${L.tried[1] - dist[1]} past it) for spine cells ${L.spine?.map((q) => q.join(', ')).join(' to ')} (${Object.entries(L.blockers).map(([k, v]) => `${k.toLowerCase().replace(/_/g, ' ')} ${v}`).join(', ')})`, evidence: { why: 'offset', class: L.cls, run: L.run, distance: dist, blockers: L.blockers, ...(L.spine ? { spine: L.spine } : {}) } } };
  if (L.move) { devs.push({ what: 'move', value: L.move }); notes.push(`a run of the wall stood ${L.move} outside its distance ${dist[0]}..${dist[1]} (the band was blocked)`); }
  notes.push(`along ${what}: ${spine.length} spine cells (window ${L.window[0]}..${L.window[1]}), on its ${sd.sign > 0 ? 'left' : 'right'} side (${sd.why}), ${L.runs.length} runs at offsets ${[...new Set(L.runs.map((q) => q.offset))].sort((a, b) => a - b).join(', ')}; open, its ends in posts`);
  return { ...L.lc, closed: false, crossings: L.crossings, devs, notes, G, along: { kind: tb.kind, side: sd.sign > 0 ? 'left' : 'right', spine, window: L.window, runs: L.runs.map(({ from, to, offset }) => ({ from, to, offset })), distance: dist } };
}

function appendLeg(line, crossings, leg) {
  const skip = line.length && line[line.length - 1][0] === leg.cells[0][0] && line[line.length - 1][1] === leg.cells[0][1] ? 1 : 0;
  const off = line.length - skip;
  for (let i = skip; i < leg.cells.length; i++) line.push(leg.cells[i]);
  for (const c of leg.crossings) crossings.push({ from: c.from + off, to: c.to + off });
}

/** A placed ring's cells (an open ring leaves out the side nearest the claim's centre). */
function ringOf(K, pl, t, st, notes) {
  let omit = null;
  if (!st.closed) {
    const [cx, cz] = centre(K.env.claim), I = pl.I;
    const d = { n: Math.abs(cz - I.minZ), e: Math.abs(I.maxX - cx), s: Math.abs(I.maxZ - cz), w: Math.abs(cx - I.minX) };
    omit = ['n', 'e', 's', 'w'].reduce((a, b) => (d[b] < d[a] ? b : a), 'n');
    notes.push(`closed: false: its ${{ n: 'north', e: 'east', s: 'south', w: 'west' }[omit]} side (nearest the claim's centre) is left out`);
  }
  const rc = ringCells(pl.I, t, omit);
  const posAt = new Map(rc.positions.map((q, i) => [key(q.x, q.z), i]));
  const crossings = [];
  for (const c of pl.crossings) {
    if (c.side === omit) continue;
    const ps = [];
    for (let u = c.from; u <= c.to; u++) { const xz = c.side === 'n' ? [u, pl.I.minZ] : c.side === 's' ? [u, pl.I.maxZ] : c.side === 'w' ? [pl.I.minX, u] : [pl.I.maxX, u]; ps.push(posAt.get(key(xz[0], xz[1]))); }
    crossings.push({ positions: [Math.min(...ps), Math.max(...ps)] });
  }
  return { ...rc, I: pl.I, o: pl.o, crossings };
}

/** A gate's record: a run of positions [a, b] on one straight run, its opening cells. */
function makeGate(W, { a, b, y, h, auto, kind, part = null, door = 'none', frame = WALL_DEFAULTS.frame, conn = null, routed = false }) {
  const cells = W.cells.filter((c) => c.pos >= a && c.pos <= b);
  const mid = W.positions[(a + b) >> 1];
  const id = part ?? `${W.id}_g${W.gates.length + 1}`;
  return { id, part, wall: W.id, auto, kind, a, b, width: b - a + 1, y, h, door, frame, conn, routed, cells: cells.map((c) => [c.x, c.z]), at: [mid.x, y + 1, mid.z], axis: mid.axis };
}

/** Whether positions [a - 1, b + 1] are one straight run (the jambs included) clear of the wall's other gates and its ends. */
function runFree(W, a, b) {
  if (a - 1 < 0 || b + 1 >= W.positions.length) return false;
  // ((H-b) no gate in a wet section: a gate needs a walk crossing)
  if (W.wetPos) for (let i = a - 1; i <= b + 1; i++) if (W.wetPos.has(i)) return false;
  const ax = W.positions[a].axis;
  if (ax === 3) return false;
  for (let i = a - 1; i <= b + 1; i++) {
    if (W.positions[i].axis !== ax) return false;
    if (W.ends.includes(i)) return false;
    if (W.gates.some((g) => i >= g.a - 1 && i <= g.b + 1)) return false;
    // ((6c HY-c, §8.3) a water gate's positions and their neighbours hold no walk gate)
    if (W.waterPos && (W.waterPos.has(i) || W.waterPos.has(i - 1) || W.waterPos.has(i + 1))) return false;
  }
  const p0 = W.positions[a - 1], p1 = W.positions[b + 1];
  return (p0.x === p1.x || p0.z === p1.z) && Math.abs(p0.x - p1.x) + Math.abs(p0.z - p1.z) === b - a + 2;
}

/**
 * The free run of `width` nearest point [x, z]: the endpoint projects onto the wall (its nearest position, squared distance, ties by
 * position), and the run whose middle is fewest positions along the wall from there wins (ties by position). Returns {a, b, d}: d
 * the cells the gate moved along the wall from the projection, or null.
 */
function nearestRun(W, pt, width) {
  const n = W.positions.length;
  let proj = 0, pd = Infinity;
  W.positions.forEach((q, i) => { const dx = q.x - pt[0], dz = q.z - pt[1], d = dx * dx + dz * dz; if (d < pd) { pd = d; proj = i; } });
  let best = null;
  for (let a = 1; a + width - 1 < n - 1; a++) {
    const b = a + width - 1;
    if (!runFree(W, a, b)) continue;
    const m = (a + b) >> 1;
    const along = W.closed ? Math.min(Math.abs(m - proj), n - Math.abs(m - proj)) : Math.abs(m - proj);
    if (!best || along < best.d) best = { a, b, d: along };
  }
  return best;
}

/**
 * (6c KC, §4) Whether the plan's bodies are what refused a wall: its line or ring planned once more without their footprints; when that
 * one fits, the refusal is OVERLAP {kind: "body", body, part, cells (<= 16: the free plan's cells on a footprint)}. A ring's wouldFit is
 * the wall with its ring widened (the first wider band, up to 32 past it, that avoids every footprint), re-checked alone on the grid
 * with the footprints. Returns {reason, wouldFit?} or null (the bodies were not the blocker).
 */
function bodyBlame(K, p, st) {
  const free = lineOf(K, p, st, null, false);
  if (free.error) return null;
  const G0 = gridOf(K, {});
  const hits = [];
  const ids = new Map();
  for (const c of free.cells) {
    const id = G0.bodyAt(G0.at(c.x, c.z));
    if (id === null) continue;
    if (hits.length < 16) hits.push([c.x, c.z]);
    ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  if (!ids.size) return null;
  const body = [...ids].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  const rec = K.keep.find((q) => q.body === body || q.part === body);
  const reason = { code: 'OVERLAP', message: `every ${st.form === 'line' ? 'line' : 'ring'} of wall ${p.id} in its band meets the footprint of ${rec?.body ? `body ${rec.body}` : `part ${rec?.part ?? body}`}, placed before it (a body's cells are its own)`, evidence: { kind: 'body', body: rec?.body ?? null, part: rec?.part ?? null, cells: hits } };
  let wouldFit;
  if (st.form === 'around') {
    const [r0, r1] = Array.isArray(p.part.where.around.ring) ? p.part.where.around.ring : WALL_DEFAULTS.ring;
    for (let w = r1 + 1; w <= r1 + 32 && !wouldFit; w++) {
      const frag = { ...p.part, where: { ...p.part.where, around: { ...p.part.where.around, ring: [r0, w] } } };
      const L2 = lineOf(K, { ...p, part: frag }, st);
      if (!L2.error) wouldFit = [{ part: p.id, fragment: frag, geometry: { ring: arr(L2.I) }, notes: [`the ring widened to [${r0}, ${w}] keeps clear of ${rec?.body ?? rec?.part ?? body} (re-checked alone)`] }];
    }
  }
  return { reason, ...(wouldFit ? { wouldFit } : {}) };
}

export function planWalls(K) {
  K.walls = [];
  K.gates = new Map();
  K.walk = networkWalk(K.r, K.env.S);
  K.stand = standMap(K, K.walk);
  for (const p of K.k1Parts.filter((q) => q.kind === 'wall')) {
    if (K.answers.has(p.id)) continue;
    const dep = K.depState(p);
    if (dep) { K.ans(p, dep); continue; }
    const st = settingsOf(K, p);
    // ((7a K2, §1) a walk needs thickness >= walk.width + 1 (the outer course is the parapet): a given thickness too thin is refused
    // NO_ROOM {why: walk}, the thicker wall its wouldFit (re-checked alone)
    if (st.walk && st.thickness < st.walk.width + 1) {
      const need = st.walk.width + 1, frag = { ...p.part, thickness: need };
      const L2 = lineOf(K, { ...p, part: frag }, { ...st, thickness: need });
      K.ans(p, { class: 'refused', notes: [...st.P.notes], reasons: [{ code: 'NO_ROOM', message: `a ${st.walk.width}-wide walk needs a wall at least ${need} thick (its outer course the parapet); thickness ${st.thickness} is too thin`, evidence: { why: 'walk', thickness: st.thickness, need, width: st.walk.width } }], ...(L2.error ? {} : { wouldFit: [{ part: p.id, fragment: frag, notes: [`thickness ${need}: the walk on the inner ${st.walk.width} course${st.walk.width > 1 ? 's' : ''}, the parapet on the outer (re-checked alone: its line fits)`] }] }) });
      continue;
    }
    if (st.walk && p.part.walk === undefined) st.P.notes.push('params.wall_walk read as walk: true');
    if (st.walk && p.part.thickness === undefined && st.thickness !== WALL_DEFAULTS.thickness) st.P.notes.push(`thickness ${st.thickness}: walk.width + 1`);
    // ((6c KC) the broken variant `wallThroughBody` (ext architect_mc:unsafe): the old wall grid, the bodies' footprints left out; M25:clear
    // catches it)
    const blind = p.part.ext?.['architect_mc:unsafe']?.wallThroughBody === true;
    let L = blind ? lineOf(K, p, st, null, false) : lineOf(K, p, st);
    const notes = [...st.P.notes];
    // ((6c H-b, §8.2) a ring that fails on water, or a line with no clear leg on a claim with water: once more over the wet grid)
    let wetW = null;
    // ((7a K2) never for an along wall: 0 of its cells in water, item 7; its WATER refusal stands)
    if (L.error && st.form !== 'along' && (L.error.code === 'WATER' || (st.form === 'line' && K.env.water?.bodies?.length))) {
      const wf = wetWallFallback(K, p.part ? p : { part: p }, { code: 'WATER' });
      const L2 = wf ? lineOf(K, p, st, { waterDepth: wf.waterDepth, vols: wf.vols }) : null;
      if (L2 && !L2.error) { L = L2; wetW = wf; }
      else if (L2 && L.error.code === 'WATER') {
        // still WATER: why (the deepest, flowing or lava water the wet grid refused)
        const whys = [...(L2.G?.wetWhy?.values() ?? [])];
        const kind = whys.length ? wetKind(whys) : 'deep';
        // (the second plan, over water it did not read: incomplete VOLUME)
        if (kind === 'unread') { K.ans(p, { class: 'incomplete', notes, reasons: [{ code: 'VOLUME', message: 'the water a harbour wall would stand in was not read: prepare (or check with load: "generate"), then check again', evidence: { ...(L.error.evidence ?? {}), kind } }] }); continue; }
        L = { error: { ...L.error, message: `${L.error.message}; no harbour wall either (${kind === 'deep' ? `water deeper than waterDepth ${wf.waterDepth}` : `${kind === 'lava' ? 'lava' : 'flowing water'}`})`, evidence: { ...(L.error.evidence ?? {}), kind, waterDepth: wf.waterDepth } } };
      }
    }
    // ((6c KC, §4) a wall no line or ring of which avoids the plan's bodies: OVERLAP {kind: body}, with the ring widened as its wouldFit)
    if (L.error && K.keep?.length && !blind) { const bb = bodyBlame(K, p, st); if (bb) { K.ans(p, { class: 'refused', reasons: [bb.reason], notes, ...(bb.wouldFit ? { wouldFit: bb.wouldFit } : {}) }); continue; } }
    if (L.error) { K.ans(p, { class: 'refused', reasons: [L.error], notes }); continue; }
    // ((H-b) the wet sections: their columns read from the frozen volume (asked: the first plan answers incomplete VOLUME), recorded
    // and guarded)
    let wetInfo = null;
    if (wetW) {
      const cols = [];
      const pos = new Set();
      for (const c of L.cells) { const w = L.G.wetAt(L.G.at(c.x, c.z)); if (w) { cols.push([c.x, c.z, w.bed, w.surface]); pos.add(c.pos); } }
      if (cols.length) {
        const asked = askWet(K.r, cols);
        const rec = noteWet(K.r, { id: `${p.id}_wet`.slice(0, 48), part: p.id, kind: 'wall', columns: wetRuns(cols), volume: asked.ref });
        if (!asked.volume) { K.ans(p, { class: 'incomplete', notes, reasons: [{ code: 'VOLUME', message: 'the water under the harbour wall\'s wet sections was not read: prepare (or check with load: "generate"), then check again', evidence: { box: [asked.box.minX, asked.box.minY, asked.box.minZ, asked.box.maxX, asked.box.maxY, asked.box.maxZ], columns: cols.length } }] }); continue; }
        (K.record.guards ??= []).push({ part: p.id, body: rec.id, kind: 'wet', fluids: true, volume: rec.volume, runs: rec.columns.flat() });
        wetInfo = { cols, pos, at: new Map(cols.map((q) => [key(q[0], q[1]), q])), waterDepth: wetW.waterDepth, record: rec.id };
        notes.push(`a harbour wall: ${pos.size} position(s) stand in natural water (the wet fallback, waterDepth ${wetW.waterDepth})`);
      }
    }
    notes.push(...L.notes);
    if (st.sealed) notes.push(st.gatesMax === 0 && (p.part.gates === 0 || st.P.read.gatesMin === 0) ? 'sealed: gates 0 (no gate; routes go round it or refuse)' : 'sealed: closed with no gate part (no gate; routes go round it or refuse)');
    const W = { id: p.id, p, st, form: st.form, positions: L.positions, cells: L.cells, ends: L.ends ?? [], closed: L.closed, I: L.I ?? null, target: L.target ?? null, joined: L.joined ?? [], gates: [], devs: L.devs, notes, opened: 0, G: L.G, ...(L.along ? { along: L.along } : {}), ...(wetInfo ? { wet: wetInfo, wetPos: wetInfo.pos } : {}) };
    W.cellAt = new Map(W.cells.map((c) => [key(c.x, c.z), c]));
    // the networks' crossings: open gates (auto), at the network's own surface
    for (const c of L.crossings ?? []) {
      const ys = W.cells.filter((q) => q.pos >= c.positions[0] && q.pos <= c.positions[1]).map((q) => L.G.walkY[L.G.at(q.x, q.z)]).filter((y) => y > -32768);
      const p0 = W.positions[c.positions[0]];
      W.gates.push(makeGate(W, { a: c.positions[0], b: c.positions[1], y: ys.length ? Math.max(...ys) : K.env.S.groundAt(p0.x, p0.z), h: WALL_DEFAULTS.gateHeight, auto: true, kind: 'network', routed: true }));
      W.opened++;
    }
    // S-K1-2: lots named to join the wall that stand beside it: a join deviation each (the lot, its box, its distance)
    const joins = [];
    for (const j of st.P.joins) {
      const l = K.r.lots.find((x) => x.id === j.lot);
      if (!l) { notes.push(K.lotZone.has(j.lot) ? `params.${j.key} names ${j.lot}, which its zone did not place` : `params.${j.key} names ${j.lot}, not a lot of this plan`); continue; }
      if (joins.some((x) => x.lot === j.lot) || W.joined.includes(j.lot)) continue;
      let d = Infinity;
      for (const c of W.cells) d = Math.min(d, boxGap(l.box, c.x, c.z));
      joins.push({ what: 'join', kind: 'join', value: Math.max(1, d), lot: l.id, key: j.key, box: [l.box.minX, l.box.minY, l.box.minZ, l.box.maxX, l.box.maxY, l.box.maxZ], note: `${j.key}: ${l.id} stands ${d} from the wall, beside it (lots on the wall line wait for FL's layout.ring or a later slice)` });
    }
    W.joins = joins;
    K.walls.push(W);
    // answered fits for now (its gates depend on it); finishGates gives its final answer
    K.ans(p, { class: 'fits', notes });
  }
  for (const g of K.k1Parts.filter((q) => q.kind === 'gate')) placeAtGate(K, g);
  // ((7a K2) an along wall's gates.min gates, before routing (open gates the routes cross, on their landings: wallsBase))
  for (const W of K.walls) if (W.form === 'along') alongMinGates(K, W, { early: true });
}

/** (7a K2) The longest flight a gate landing runs to meet the ground (beyond it: no landing, noted). */
export const LANDING_FLIGHT = 40;
/** (7a K2) How wide a landing's flight along the inner face is (cells out from the wall). */
export const LANDING_WIDTH = 2;

/**
 * (7a K2, the coordinator's ruling (b), 2026-10-23) A gate landing on an along wall: on each side of the wall, over the gate's lanes, the
 * 2 cells past the wall cut or filled to the gate's floor, then where the ground steps more than 1 a flight (rise 1 a cell, at most
 * LANDING_FLIGHT) away from the wall until it meets the ground. Every cell must be clear on the wall's grid (a walk network's cell is
 * one: the route levels it). Returns {ok: true, cells: [{x, z, y, kind: flat|stair, facing?}]} or {ok: false, why}.
 */
function landingOf(K, W, g) {
  const t = W.st.thickness, S = K.env.S, cells = [];
  const F = { '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north' };
  const N = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] };
  const wet = (x, z) => { const q = W.G.at(x, z); return q >= 0 && W.G.ob[q] === OB.WATER; };
  const innerOf = (p) => W.cells.find((c) => c.pos === p && c.depth === 0);
  let climb = false;
  for (let p = g.a; p <= g.b; p++) {
    const inner = innerOf(p), outer = W.cells.find((c) => c.pos === p && c.depth === t - 1) ?? inner;
    if (!inner) return { ok: false, why: 'no inner course' };
    const [dx, dz] = N[facingOut(W, inner)];
    // inside: the gate's mouth, 2 cells at its floor; past it, a ground more than 1 off it takes the flight along the inner face (below)
    for (let k = 1; k <= 2; k++) {
      const x = inner.x - dx * k, z = inner.z - dz * k;
      if (wet(x, z)) return { ok: false, why: 'water' };
      cells.push({ x, z, y: g.y, kind: 'flat' });
    }
    if (Math.abs(S.groundAt(inner.x - dx * 3, inner.z - dz * 3) - g.y) > 1) climb = true;
    // outside: 2 cells at the floor, then (where the ground is more than 1 off it) a flight straight out to the ground; a lane that meets
    // the water at most 2 under the floor ends there (the gate opens onto the shore)
    let L = g.y, k = 1, shore = false;
    for (; k <= 2; k++) {
      const x = outer.x + dx * k, z = outer.z + dz * k;
      if (wet(x, z)) { if (L - S.groundAt(x, z) <= 2 && L >= S.groundAt(x, z)) { shore = true; break; } return { ok: false, why: `a drop of ${L - S.groundAt(x, z)} to the water` }; }
      cells.push({ x, z, y: g.y, kind: 'flat', out: true, k });
    }
    let run = 0, rest = 0;
    for (; !shore; k++) {
      const x = outer.x + dx * k, z = outer.z + dz * k, G = S.groundAt(x, z);
      if (wet(x, z)) { if (L - G <= 2 && L >= G) break; return { ok: false, why: `a drop of ${L - G} to the water` }; }
      if (Math.abs(G - L) <= 1) break;
      if (k > 2 + LANDING_FLIGHT) return { ok: false, why: `the ground steps ${Math.abs(S.groundAt(outer.x + dx * 3, outer.z + dz * 3) - g.y)} outside: a flight longer than ${LANDING_FLIGHT}` };
      // (as T2's stair move climbs: flights of at most 8, then 2 flat cells, so a route over the landing (the pass's base) follows it)
      if (run === 8) { cells.push({ x, z, y: L, kind: 'flat' }); if (++rest === 2) { run = 0; rest = 0; } continue; }
      const up = G > L;
      L += up ? 1 : -1;
      run++;
      cells.push({ x, z, y: L, kind: 'stair', facing: up ? F[`${dx},${dz}`] : F[`${-dx},${-dz}`] });
    }
  }
  if (!cells.some((c) => c.out && c.k === 1)) return { ok: false, why: 'water at the gate' };
  // inside, the flight along the inner face (the coordinator's ruling (i)): LANDING_WIDTH cells deep beside the wall, from the gate's
  // side along the wall, rising (or falling) 1 a position in T2's pattern until the ground across its width is within 1; the shorter way
  if (climb) {
    let best = null;
    // (along the wall's inner face, position by position, round its bends (a staircase shore's too), LANDING_WIDTH cells out)
    // (a position's centre cell: the line's own, the inner course)
    const posCell = (p) => (p >= 0 && p < W.positions.length ? W.positions[p] : null);
    for (const dir of [1, -1]) {
      const fl = [], seen = new Set(cells.map((c) => key(c.x, c.z)));
      // the flight's centre line: each position's inner neighbour (its depth 2 at an inside corner), joined 4-connected round the bends
      const centres = [];
      const mouth = posCell(dir > 0 ? g.b : g.a);
      let last = null;
      { const nb0 = posCell((dir > 0 ? g.b : g.a) + 1) ?? posCell(dir > 0 ? g.b - 1 : g.a + 1); void nb0; }
      for (let i = 0; i <= LANDING_FLIGHT && centres.length <= LANDING_FLIGHT; i++) {
        const p = (dir > 0 ? g.b + 1 : g.a - 1) + dir * i;
        const c = posCell(p);
        if (!c || W.ends.includes(p) || W.gates.some((q) => q !== g && p >= q.a - 1 && p <= q.b + 1)) break;
        const nb = posCell(p + 1), pb = posCell(p - 1);
        const hx = nb ? nb.x - c.x : c.x - pb.x, hz = nb ? nb.z - c.z : c.z - pb.z;
        const dx = -hz, dz = hx; // outward: right of travel
        let q = [c.x - dx, c.z - dz];
        if (W.cellAt.has(key(q[0], q[1]))) q = [c.x - 2 * dx, c.z - 2 * dz];
        if (W.cellAt.has(key(q[0], q[1]))) continue;
        last ??= [mouth.x - dx, mouth.z - dz];
        // join from the last centre (x first, then z; else z first), never through the wall
        const legs = [];
        for (const xFirst of [true, false]) {
          const out = [];
          let [x, z] = last;
          const step = (ax) => { if (ax === 'x') x += Math.sign(q[0] - x); else z += Math.sign(q[1] - z); out.push([x, z]); };
          if (xFirst) { while (x !== q[0]) step('x'); while (z !== q[1]) step('z'); } else { while (z !== q[1]) step('z'); while (x !== q[0]) step('x'); }
          if (out.every(([a, b]) => !W.cellAt.has(key(a, b)))) { legs.push(...out); break; }
        }
        if (!legs.length && (q[0] !== last[0] || q[1] !== last[1])) break;
        // (a centre met again: the loop between cut out, so the line stays a 4-connected path)
        for (const cc of legs) {
          const at = centres.findIndex((e) => e[0] === cc[0] && e[1] === cc[1]);
          if (at >= 0) centres.length = at + 1; else centres.push([...cc, dx, dz]);
        }
        last = q;
      }
      let L = g.y, run = 0, rest = 0, ok = false, prev = null;
      for (let i = 0; i < centres.length; i++) {
        const [cx, cz, dx, dz] = centres[i];
        if (seen.has(key(cx, cz))) break;
        const lane = [[cx, cz]].filter(([x, z]) => !W.cellAt.has(key(x, z)));
        if (!lane.length) break;
        if (lane.some(([x, z]) => wet(x, z))) break;
        const G = Math.max(...lane.map(([x, z]) => S.groundAt(x, z)));
        if (i > 0 && Math.abs(G - L) <= 1) { ok = true; break; }
        const up = G > L;
        let kind = 'stair';
        if (run === 8) { kind = 'flat'; if (++rest === 2) { run = 0; rest = 0; } } else { L += up ? 1 : -1; run++; }
        const from = prev ?? [cx + dx, cz + dz];
        const sx = Math.sign(cx - from[0]), sz = Math.sign(cz - from[1]);
        const facing = up ? F[`${sx},${sz}`] : F[`${-sx},${-sz}`];
        for (const [x, z] of lane) { seen.add(key(x, z)); fl.push({ x, z, y: L, kind, ...(kind === 'stair' && facing ? { facing } : kind === 'stair' ? { facing: F[`${-dx},${-dz}`] } : {}), flight: true }); }
        prev = centres[i];
      }
      if (ok && (!best || fl.length < best.length)) best = fl;
    }
    if (!best) return { ok: false, why: `the ground steps ${Math.abs(S.groundAt(innerOf(g.a).x, innerOf(g.a).z) - g.y)} inside and no flight along the wall's inner face meets it within ${LANDING_FLIGHT}` };
    cells.push(...best);
  }
  for (const c of cells) {
    const k = W.G.at(c.x, c.z);
    if (k < 0) return { ok: false, why: 'the claim\'s margin' };
    if (W.G.ob[k] && !W.G.walk[k]) return { ok: false, why: ['clear', 'the claim\'s margin', 'a protected area', 'water', 'keep-out', 'a lot, zone, form or another region', 'a plan body'][W.G.ob[k]] };
    if (W.cellAt.has(key(c.x, c.z))) return { ok: false, why: 'the wall itself (a bend)' };
  }
  return { ok: true, cells };
}

/**
 * (7a K2, §2) An along wall's gates.min, before routing: evenly along it (the n-th of `want` at (2n + 1) / (2 want) of its length), ties
 * by position, with the linear distance (two ends, no wrap); within half the spacing of its target a level run wins, then the nearest
 * run whose landing fits (landingOf), else the nearest; the network crossings' gates count. A gate with no landing is noted (never
 * silent: a route the wall cuts answers UNREACHABLE {kind: wall}).
 */
function alongMinGates(K, W, { early = false } = {}) {
  if (W.form !== 'along' || W.st.sealed || W.minDone) return;
  // (before routing, only a wall some of whose gates need a landing: a level wall's gates.min waits for the routes' crossings, as K1a's)
  if (early) {
    const n0 = W.positions.length, h0 = Math.max(1, Math.floor(n0 / (2 * Math.max(1, W.st.gatesMin))));
    let level = true;
    for (let q = 0; q < W.st.gatesMin && level; q++) {
      const target = Math.floor((n0 * (2 * q + 1)) / (2 * W.st.gatesMin));
      let found = false;
      for (let a = 1; a + WALL_DEFAULTS.gateWidth < n0 - 1 && !found; a++) { const b = a + WALL_DEFAULTS.gateWidth - 1; if (Math.abs(((a + b) >> 1) - target) <= h0 && runFree(W, a, b) && crossStep(K, W, a, b) <= 1) found = true; }
      if (!found) level = false;
    }
    if (level) return;
  }
  W.minDone = true;
  const want = W.st.gatesMin - W.gates.length;
  const n = W.positions.length;
  let added = 0;
  const half = Math.max(1, Math.floor(n / (2 * Math.max(1, W.st.gatesMin))));
  for (let q = 0; q < W.st.gatesMin && added < want; q++) {
    const target = Math.floor((n * (2 * q + 1)) / (2 * W.st.gatesMin));
    const cands = [];
    for (let a = 1; a + WALL_DEFAULTS.gateWidth < n - 1; a++) {
      const b = a + WALL_DEFAULTS.gateWidth - 1;
      if (!runFree(W, a, b)) continue;
      cands.push({ a, b, d: Math.abs(((a + b) >> 1) - target) });
    }
    if (!cands.length) break;
    cands.sort((u, v) => u.d - v.d || u.a - v.a);
    const mk = (c, y = null) => { const mid = W.positions[(c.a + c.b) >> 1]; return makeGate(W, { a: c.a, b: c.b, y: y ?? K.env.S.groundAt(mid.x, mid.z), h: WALL_DEFAULTS.gateHeight, auto: true, kind: 'min' }); };
    // a run's landing: at the line's ground, else at the shore's (the land just outside the wall): the shorter that fits
    const landAt = (c) => {
      const g0 = mk(c);
      const ys = new Set([g0.y]);
      for (let p = c.a; p <= c.b; p++) {
        const o = W.cells.find((q) => q.pos === p && q.depth === W.st.thickness - 1), i = W.cells.find((q) => q.pos === p && q.depth === 0);
        if (!o || !i) continue;
        const [dx, dz] = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] }[facingOut(W, i)];
        for (let k = 1; k <= 2; k++) { const gq = W.G.at(o.x + dx * k, o.z + dz * k); if (gq >= 0 && !W.G.ob[gq]) ys.add(K.env.S.groundAt(o.x + dx * k, o.z + dz * k)); }
      }
      let best = null;
      for (const y of [...ys].sort((u, v) => u - v)) { const g = mk(c, y); const l = landingOf(K, W, g); if (l.ok && (!best || l.cells.length < best.l.cells.length)) best = { y, l }; }
      return best;
    };
    let pick = cands.find((c) => c.d <= half && crossStep(K, W, c.a, c.b) <= 1) ?? null, landing = null;
    // (else the run within half the spacing whose landing is shortest: fewest flight steps, then nearest)
    let pickY = null;
    if (!pick) for (const c of cands) { if (c.d > half) break; const b = landAt(c); if (b && (!landing || b.l.cells.length < landing.cells.length)) { pick = c; landing = b.l; pickY = b.y; } }
    // (none within half the spacing: the nearest anywhere whose landing fits, noted as moved from even)
    let far = false;
    if (!pick) for (const c of cands) { if (c.d <= half) continue; const b = landAt(c); if (b) { pick = c; landing = b.l; pickY = b.y; far = true; break; } }
    pick ??= cands[0];
    const g = mk(pick, pickY);
    g.landing = landing ?? landingOf(K, W, g);
    W.gates.push(g);
    W.opened++;
    added++;
    const step = crossStep(K, W, pick.a, pick.b);
    if (far) W.notes.push(`gate ${g.id}: ${pick.d} positions from its even place (none nearer has a level run or a landing)`);
    if (step > 1 && g.landing.ok) W.notes.push(`gate ${g.id}: the ground steps ${step} across the wall there: a landing levels it (${g.landing.cells.filter((c) => c.kind === 'stair').length} flight step(s))`);
    if (step > 1 && !g.landing.ok) W.notes.push(`gate ${g.id}: the ground steps ${step} across the wall there and no landing fits (${g.landing.why}): no walk through it`);
  }
  if (added < want) W.notes.push(`gates.min ${W.st.gatesMin}: room for ${W.gates.length}`);
}

/**
 * (7a K2) The landings' ground for the route pass (its `base`: what each landing cell's ground becomes less the survey's), or null: the
 * routes cross an along wall's gates.min gates at their floors.
 */
export function wallsBase(K) {
  // (the landing's cells and the gate's own opening: its floor through the wall's depth)
  const cs = (K.walls ?? []).flatMap((W) => W.gates.filter((g) => g.landing?.ok).flatMap((g) => [...g.landing.cells, ...g.cells.map(([x, z]) => ({ x, z, y: g.y }))]));
  if (!cs.length) return null;
  const minX = Math.min(...cs.map((c) => c.x)), minZ = Math.min(...cs.map((c) => c.z)), width = Math.max(...cs.map((c) => c.x)) - minX + 1, depth = Math.max(...cs.map((c) => c.z)) - minZ + 1;
  const values = new Array(width * depth).fill(0);
  for (const c of cs) values[(c.x - minX) + (c.z - minZ) * width] = c.y - K.env.S.groundAt(c.x, c.z);
  return { minX, minZ, width, depth, values };
}

/** (7a K2) Two route-pass bases summed over their union (either may be null). */
export function mergeBases(a, b) {
  if (!a || !b) return a ?? b ?? null;
  const minX = Math.min(a.minX, b.minX), minZ = Math.min(a.minZ, b.minZ), maxX = Math.max(a.minX + a.width, b.minX + b.width) - 1, maxZ = Math.max(a.minZ + a.depth, b.minZ + b.depth) - 1;
  const width = maxX - minX + 1, depth = maxZ - minZ + 1, values = new Array(width * depth).fill(0);
  for (const q of [a, b]) for (let j = 0; j < q.depth; j++) for (let i = 0; i < q.width; i++) values[(q.minX + i - minX) + (q.minZ + j - minZ) * width] += q.values[i + j * q.width];
  return { minX, minZ, width, depth, values };
}

/** The wall a gate part belongs to: {W} or {error}. */
function wallOfGate(K, g) {
  const walls = K.k1Parts.filter((q) => q.kind === 'wall');
  const id = g.part.wall ?? (walls.length === 1 ? walls[0].id : null);
  if (!id) return { error: { code: 'NO_FEATURE', message: walls.length ? `${walls.length} walls in the plan: name the gate's wall` : 'the plan has no wall for this gate', evidence: { walls: walls.map((w) => w.id) } } };
  const W = K.walls.find((w) => w.id === id);
  return W ? { W } : { error: { code: 'DEPENDENCY', message: `wall ${id} has no line`, evidence: { wall: id } } };
}

function gateNotes(g) {
  const n = readParams('gate', g.part).notes;
  if (g.part.from && g.part.at === undefined) n.unshift(`from read as at${g.part.to ? `; to (${Object.entries(g.part.to).map(([k, v]) => `${k} ${v}`).join(', ')}) noted as the side it faces` : ''}`);
  return n;
}

function placeAtGate(K, g) {
  if (K.answers.has(g.id)) return;
  const at = g.part.at ?? g.part.from;
  if (!at) return; // a crossing gate, or one that styles its wall's gates: after routing
  const dep = K.depState(g);
  if (dep) { K.ans(g, dep); return; }
  const w = wallOfGate(K, g);
  if (w.error) { K.ans(g, { class: w.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', reasons: [w.error], notes: gateNotes(g) }); return; }
  const W = w.W;
  if (W.st.sealed) { K.ans(g, { class: 'refused', reasons: [{ code: 'NO_ROOM', message: `wall ${W.id} is sealed (gates 0)`, evidence: { wall: W.id } }], notes: gateNotes(g) }); return; }
  const n = K.endpointNode(at, g.part.to ?? null, g, 'at');
  if (n.error) { K.ans(g, { class: 'refused', reasons: [n.error.legacy ?? n.error], notes: gateNotes(g) }); return; } // ((close-out A) a gate answers as before
  const door = g.part.door ?? WALL_DEFAULTS.door;
  const width = g.part.width ?? (door === 'door' ? 2 : WALL_DEFAULTS.gateWidth);
  const run = nearestRun(W, [n.at[0], n.at[2]], width);
  const tol = K.tolOf(g.part, 'move');
  if (!run || run.d > tol.ceiling) { K.ans(g, { class: 'refused', reasons: [{ code: 'NO_ROOM', message: run ? `the nearest straight run of wall ${W.id} with room for a ${width}-wide gate is ${run.d} from its endpoint (at most ${tol.ceiling})` : `wall ${W.id} has no straight run with room for a ${width}-wide gate and its jambs`, evidence: { wall: W.id, width, ...(run ? { move: run.d, ceiling: tol.ceiling } : {}) } }], notes: gateNotes(g) }); return; }
  const mid = W.positions[(run.a + run.b) >> 1];
  const gate = makeGate(W, { a: run.a, b: run.b, y: K.env.S.groundAt(mid.x, mid.z), h: g.part.height ?? WALL_DEFAULTS.gateHeight, auto: false, kind: 'at', part: g.id, door, frame: g.part.frame ?? WALL_DEFAULTS.frame });
  W.gates.push(gate);
  W.opened++;
  const j = K.judge([{ what: 'move', value: run.d, ...tol }]);
  K.gates.set(g.id, gate);
  K.ans(g, { class: j.klass, deviations: j.deviations, notes: gateNotes(g) });
}

// ------------------------------------------------------------------ routing: the walls as the gate move's input

export function wallsPassInput(K) {
  if (!K.walls?.length) return null;
  return K.walls.map((W) => {
    const open = [];
    for (const g of W.gates) for (const [x, z] of g.cells) open.push([x, z, g.y]);
    // every column the wall writes is an obstacle: its cells and the corner stubs (axis 3)
    const cells = W.cells.map((c) => [c.x, c.z, c.axis]);
    for (const [x, z] of stubCells(W)) if (!W.cellAt.has(key(x, z))) cells.push([x, z, 3]);
    // ((6c HY-c) a standing water gate counts against gates.max: the route pass opens fewer)
    const wg = waterGates(K, W).length;
    return { id: W.id, max: W.st.gatesMax, opened: W.opened + wg, cells, open, ...(W.closed && W.I ? { inside: [W.I.minX, W.I.minZ, W.I.maxX, W.I.maxZ] } : {}) };
  });
}

export function wallsRouted(K, edges) {
  if (!K.walls?.length) return;
  for (const e of edges) for (const g of e.gates ?? []) {
    const W = K.walls.find((w) => w.id === g.wall);
    if (!W) continue;
    const ps = g.cells.map(([x, z]) => W.cellAt.get(key(x, z))?.pos).filter((v) => v !== undefined);
    if (!ps.length) continue;
    const a = Math.min(...ps), b = Math.max(...ps);
    const old = W.gates.find((q) => q.a <= a && q.b >= b);
    if (old) { old.routed = true; (old.edges ??= []).push(e.id); continue; }
    const gate = makeGate(W, { a, b, y: g.at[1], h: WALL_DEFAULTS.gateHeight, auto: true, kind: 'route', routed: true });
    gate.edges = [e.id];
    W.gates.push(gate);
    if (g.new) W.opened++;
  }
}

export function wallsEvidence(K, leg) {
  if (!K.walls?.length) return {};
  const a = [leg.from.at[0], leg.from.at[2]], b = [leg.to.at[0], leg.to.at[2]];
  const inside = (W, p) => W.I && p[0] > W.I.minX && p[0] < W.I.maxX && p[1] > W.I.minZ && p[1] < W.I.maxZ;
  const walls = K.walls.filter((W) => W.closed && inside(W, a) !== inside(W, b)).map((W) => ({ wall: W.id, sealed: W.st.sealed, gates: W.gates.length, max: W.st.gatesMax }));
  return walls.length ? { walls } : {};
}

/**
 * (7a K2) A leg the route pass could not route (no route, or the search's budget spent) whose ends an open wall (wall.along: its ends
 * clip at the claim margin) cuts apart: the claim's dry cells reach one end from the other without the walls' cells, and not with them.
 * Its answer says so (refused UNREACHABLE, evidence {kind: wall, walls}) instead of a bare UNREACHABLE or BUDGET: K1a's gate move opens
 * a gate only on a straight run held flat across the wall, which a stepped natural bank (a 45 degree staircase shore) never has. Null
 * when no along wall is the cut.
 */
export function wallsCutAnswer(K, leg, why = null) {
  const along = (K.walls ?? []).filter((W) => W.form === 'along');
  if (!along.length) return null;
  const G = along[0].G, n = G.W * G.D;
  const a = G.at(leg.from.at[0], leg.from.at[2]), b = G.at(leg.to.at[0], leg.to.at[2]);
  if (a < 0 || b < 0) return null;
  const wallAt = new Int16Array(n).fill(-1);
  along.forEach((W, wi) => { for (const c of W.cells) { const k = G.at(c.x, c.z); if (k >= 0) wallAt[k] = wi; } });
  const reach = (blockWalls) => {
    const seen = new Uint8Array(n), q = [a];
    seen[a] = 1;
    for (let i = 0; i < q.length; i++) {
      const k = q[i], x = k % G.W, z = (k - x) / G.W;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= G.W || nz >= G.D) continue;
        const nk = nx + nz * G.W;
        if (seen[nk] || (G.ob[nk] === OB.WATER || G.ob[nk] === OB.OUT_OF_CLAIM) || (blockWalls && wallAt[nk] >= 0)) continue;
        seen[nk] = 1; q.push(nk);
      }
    }
    return seen;
  };
  // the walls the straight line between the ends crosses (the ones a route had to pass through a gate or go round)
  const hit = new Set();
  { let x = leg.from.at[0], z = leg.from.at[2]; const x1 = leg.to.at[0], z1 = leg.to.at[2], dx = Math.abs(x1 - x), dz = Math.abs(z1 - z), sx = Math.sign(x1 - x), sz = Math.sign(z1 - z);
    for (let ix = 0, iz = 0; ix < dx || iz < dz;) { if ((1 + 2 * ix) * dz <= (1 + 2 * iz) * dx) { x += sx; ix++; } else { z += sz; iz++; } const k = G.at(x, z); if (k >= 0 && wallAt[k] >= 0) hit.add(wallAt[k]); } }
  if (!hit.size || !reach(false)[b]) return null;
  const round = reach(true)[b];
  const walls = [...hit].sort((p, q) => p - q).map((wi) => along[wi]).map((W) => ({ wall: W.id, form: 'along', gates: W.gates.length, open: W.gates.filter((g) => g.routed).length }));
  return { class: 'refused', reasons: [{ code: 'UNREACHABLE', message: `leg ${leg.k + 1}: ${walls.length > 1 ? `the along walls ${walls.map((w) => w.wall).join(', ')} stand` : `along wall ${walls[0].wall} stands`} between its ends and no gate could open across it (a gate needs a straight run of the wall held flat across its depth; the ground here steps)${round ? ', and no route round its end was found' : ' (it cuts them apart)'}; give the wall a gate part at an endpoint where the ground is level, or move the route's end`, evidence: { leg: leg.k + 1, from: leg.from.at, to: leg.to.at, kind: 'wall', walls, round: round ? 'not found' : 'none', ...(why ? { search: why } : {}) } }] };
}

// ------------------------------------------------------------------ step 4: crossing gates, auto gates, gates.min

export function finishGates(K) {
  if (!K.walls) return;
  // ((6c HY-c, §8.3) the standing water gates' positions: no auto or gates.min gate stands on them or beside them)
  for (const W of K.walls) { const wg = waterGates(K, W); if (wg.length) W.waterPos = new Set(wg.flatMap((q) => q.positions ?? [])); }
  for (const g of K.k1Parts.filter((q) => q.kind === 'gate' && !K.answers.has(q.id))) {
    const dep = K.depState(g);
    if (dep) { K.ans(g, dep); continue; }
    const w = wallOfGate(K, g);
    if (w.error) { K.ans(g, { class: w.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', reasons: [w.error], notes: gateNotes(g) }); continue; }
    const W = w.W;
    if (g.part.crossing) {
      // the gate the named connector's route opened (any of its legs)
      const edgeIds = K.routed.filter((x) => x.conn.id === g.part.crossing).map((x) => x.edge?.id).filter(Boolean);
      const gate = W.gates.find((q) => q.kind !== 'at' && !q.part && (q.edges ?? []).some((e) => edgeIds.includes(e)));
      if (!gate) { K.ans(g, { class: 'refused', reasons: [{ code: 'UNREACHABLE', message: `${g.part.crossing}'s route opens no gate in wall ${W.id}`, evidence: { crossing: g.part.crossing, wall: W.id } }], notes: gateNotes(g) }); continue; }
      const door = g.part.door ?? WALL_DEFAULTS.door;
      // R17: a fence gate is player-only: a crossing used by a villager edge refuses it
      const movers = K.routed.filter((x) => x.conn.id === g.part.crossing).flatMap((x) => x.meta?.movers ?? []);
      if (door === 'fence_gate' && movers.includes('villager')) { K.ans(g, { class: 'refused', reasons: [{ code: 'MOVER', message: `a fence gate on ${g.part.crossing}, a villager edge (villagers open wooden doors, not fence gates)`, evidence: { crossing: g.part.crossing, movers: [...new Set(movers)] } }], notes: gateNotes(g) }); continue; }
      Object.assign(gate, { part: g.id, id: g.id, auto: false, kind: 'crossing', door, frame: g.part.frame ?? WALL_DEFAULTS.frame, conn: g.part.crossing, ...(g.part.height ? { h: g.part.height } : {}) });
      K.gates.set(g.id, gate);
      K.ans(g, { class: 'fits', notes: gateNotes(g) });
      continue;
    }
    // a gate part that neither places nor names one styles its wall's auto gates
    const autos = W.gates.filter((q) => q.auto);
    for (const q of autos) Object.assign(q, { door: g.part.door ?? q.door, frame: g.part.frame ?? q.frame, ...(g.part.height ? { h: g.part.height } : {}), styledBy: g.id });
    K.gates.set(g.id, null);
    K.ans(g, { class: 'fits', notes: [...gateNotes(g), `styles wall ${W.id}'s ${autos.length} auto gate(s)`] });
  }
  // gates.min on a closed wall: first where a zone's street end faces the ring, then evenly along it (ties by position)
  for (const W of K.walls) {
    // ((7a K2, §2) an along wall's gates.min: placed before routing (alongMinGates); nothing more here
    if (W.form === 'along') { alongMinGates(K, W); continue; }
    if (!W.closed || W.st.sealed) continue;
    let want = W.st.gatesMin - W.gates.length;
    // ((6c HY-c) the standing water gates count against gates.max: gates.min adds no gate past it)
    if (W.waterPos) want = Math.min(want, W.st.gatesMax - W.gates.length - waterGates(K, W).length);
    if (want <= 0) continue;
    const pts = [];
    const z = W.target?.zone ? K.zoneEmit.get(W.target.zone) : null;
    if (W.target?.standing) for (const q of besidePorts(W.target.standing)) pts.push([q.end[0], q.end[1]]);
    if (z?.districts) for (const ends of Object.values(z.districts.ends ?? {})) for (const e of ends) pts.push([e.x, e.z]);
    else if (z?.L?.orientation && z.L.road) {
      const o = z.L.orientation, sv = z.L.road.sv;
      for (const u of [z.L.u0 - 1, z.L.u1 + 1]) pts.push(o === 'ew' ? [u, sv] : [sv, u]);
    }
    let added = 0;
    for (const pt of pts) {
      if (added >= want) break;
      const run = nearestRun(W, pt, WALL_DEFAULTS.gateWidth);
      if (!run) continue;
      const mid = W.positions[(run.a + run.b) >> 1];
      W.gates.push(makeGate(W, { a: run.a, b: run.b, y: K.env.S.groundAt(mid.x, mid.z), h: WALL_DEFAULTS.gateHeight, auto: true, kind: 'min' }));
      added++;
    }
    const n = W.positions.length;
    for (let tries = 0; added < want && tries < 4 * want + 8; tries++) {
      const target = Math.floor((n * (2 * tries + 1)) / (2 * Math.max(1, want)));
      let best = null;
      for (let a = 1; a + WALL_DEFAULTS.gateWidth < n - 1; a++) {
        const b = a + WALL_DEFAULTS.gateWidth - 1;
        if (!runFree(W, a, b)) continue;
        const d = Math.min(Math.abs(a - target), n - Math.abs(a - target));
        if (!best || d < best.d) best = { a, b, d };
      }
      if (!best) break;
      const mid = W.positions[(best.a + best.b) >> 1];
      W.gates.push(makeGate(W, { a: best.a, b: best.b, y: K.env.S.groundAt(mid.x, mid.z), h: WALL_DEFAULTS.gateHeight, auto: true, kind: 'min' }));
      added++;
    }
    if (added < want) W.notes.push(`gates.min ${W.st.gatesMin}: room for ${W.gates.length}`);
  }
  // the wall answers: fits, or adjusted with its deviations (move, joins); notes; the geometry comes with the emission
  for (const W of K.walls) {
    const p = W.p;
    const tol = K.tolOf(p.part, 'move');
    const mv = W.devs.find((d) => d.what === 'move');
    const j = K.judge(mv ? [{ what: 'move', value: mv.value, ...tol }] : []);
    const deviations = [...j.deviations, ...W.joins.map(({ note, ...d }) => { void note; return d; })];
    const notes = mergeNotes([...W.notes, ...W.joins.map((d) => d.note)]);
    const klass = j.klass === 'refused' ? 'refused' : deviations.length ? 'adjusted' : 'fits';
    W.answer = { class: klass, deviations, notes, ...(j.klass === 'refused' ? { reasons: [{ code: 'TOLERANCE', message: W.form === 'along' ? `a run of the wall stood ${mv.value} outside its distance, past its ceiling ${tol.ceiling}` : `the wall stepped ${mv.value} off its edge, past its ceiling ${tol.ceiling}`, evidence: { move: mv.value } }] } : {}), ...(W.joined.length ? { provisional: true } : {}) };
    K.ans(p, W.answer);
  }
}

/**
 * (7a K2) How far the ground steps across a wall at positions a..b: the most, over the run, between the standable ground just inside its
 * inner course and just outside its outer course (and along the opening's own cells).
 */
function crossStep(K, W, a, b) {
  let worst = 0;
  for (let i = a; i <= b; i++) {
    const inner = W.cells.find((c) => c.pos === i && c.depth === 0), outer = W.cells.find((c) => c.pos === i && c.depth === W.st.thickness - 1) ?? inner;
    if (!inner) return Infinity;
    const [dx, dz] = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] }[facingOut(W, inner)];
    const ys = [K.stand(inner.x - dx, inner.z - dz), ...W.cells.filter((c) => c.pos === i).map((c) => K.stand(c.x, c.z)), K.stand(outer.x + dx, outer.z + dz)];
    worst = Math.max(worst, Math.max(...ys) - Math.min(...ys));
  }
  return worst;
}

/** At most 16 notes (partAnswer): the 16th says how many more there were. */
function mergeNotes(n) {
  return n.length <= 16 ? n : [...n.slice(0, 15), `and ${n.length - 15} more: ${n.slice(15).join('; ').slice(0, 400)}`];
}

// ------------------------------------------------------------------ step 5: the links stage

/** The corner stubs' cells of a closed ring with corners: tower (3x3, or t+1 square, over each corner's band square). */
function stubCells(W) {
  if (W.st.corners !== 'tower' || !W.I || !W.closed) return [];
  const t = W.st.thickness, I = W.I, s = Math.max(3, t + 1), out = [];
  for (const [cx, cz, sx, sz] of [[I.minX, I.minZ, -1, -1], [I.maxX, I.minZ, 1, -1], [I.maxX, I.maxZ, 1, 1], [I.minX, I.maxZ, -1, 1]]) {
    const ox = sx < 0 ? cx - (s - 1) : cx, oz = sz < 0 ? cz - (s - 1) : cz;
    for (let dz = 0; dz < s; dz++) for (let dx = 0; dx < s; dx++) out.push([ox + dx, oz + dz]);
  }
  return out;
}

/** A wall block's state for its neighbours (vanilla's connections: joined to its neighbouring wall blocks; `up` unless a straight run). */
function wallState(block, c) {
  const v = (b) => (b ? 'low' : 'none');
  const straight = (c.n && c.s && !c.e && !c.w) || (c.e && c.w && !c.n && !c.s);
  return `${block}[east=${v(c.e)},north=${v(c.n)},south=${v(c.s)},up=${straight ? 'false' : 'true'},waterlogged=false,west=${v(c.w)}]`;
}

const FACING = { '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north' };

/**
 * (6c KC) The broken variant `slabInWatch` (the wall part's ext architect_mc:unsafe): one slab, a non-shell-grade block, written by the
 * wall into the first watch cell of the plan's first registered body; M25:clear's watch clause catches it.
 */
function unsafeSlab(K, W) {
  if (W.p.part.ext?.['architect_mc:unsafe']?.slabInWatch !== true) return;
  const rec = (K.keep ?? []).find((q) => q.kind === 'body' && q.watch.size);
  if (!rec) return;
  const [x, y, z] = [...rec.watch].sort()[0].split(',').map(Number);
  const part = K.r.part(`${W.id}_unsafe_slab`.slice(0, 48), { stage: K.stageOf('links') });
  part.columns({ abs: 0 }, { abs: 0 }, [x, z, y, y, 0], ['minecraft:stone_slab[type=bottom]'], { cond: 3 });
}

export function emitWalls(K) {
  if (!K.walls?.length) return;
  K.record.walls = [];
  K.record.bom ??= {};
  // the walk cells and the standable surface again, with the routes laid now (a road's fill beside the wall raises its top)
  K.walk = networkWalk(K.r, K.env.S);
  K.stand = standMap(K, K.walk);
  const metaWalls = [];
  for (const W of K.walls) {
    if (!['fits', 'adjusted'].includes(K.answers.get(W.id)?.class)) continue;
    const cp = K.checkpoint();
    try {
      const out = emitWall(K, W);
      unsafeSlab(K, W);
      K.mark(W.id, K.addedSince(cp));
      metaWalls.push(out.meta);
      K.r.meta.walls = [...metaWalls];
      K.record.walls.push(out.record);
      K.record.bom[W.id] = out.bom;
      for (const g of W.gates) if (g.part) K.record.bom[g.part] = out.gateBom.get(g.id) ?? {};
      K.answers.get(W.id).geometry = out.geometry;
      // ((7a K2) the walk's notes (its dead ends, an access it had no room for))
      if (out.notes?.length) K.answers.get(W.id).notes = mergeNotes([...(K.answers.get(W.id).notes ?? []), ...out.notes]);
      for (const g of W.gates) if (g.part && K.answers.get(g.part)) K.answers.get(g.part).geometry = { wall: W.id, at: g.at, width: g.width, height: g.h, door: g.door, frame: g.frame, cells: g.cells.length };
    } catch (e) {
      K.rollback(cp);
      metaWalls.length && (K.r.meta.walls = [...metaWalls]);
      K.ans(W.p, { class: 'refused', reasons: [e.reason ?? { code: 'NO_ROOM', message: `the wall's emission failed: ${e.message}`, evidence: { wall: W.id } }], notes: W.answer?.notes });
      for (const g of W.gates) if (g.part && K.answers.has(g.part)) K.answers.set(g.part, { ...K.answers.get(g.part), class: 'blocked', blockedBy: [W.id], reasons: [{ code: 'DEPENDENCY', message: `depends on ${W.id}, which is not fits or adjusted`, evidence: { blockedBy: [W.id] } }] });
    }
  }
}

function emitWall(K, W) {
  const r = K.r, S = K.env.S, st = W.st, t = st.thickness;
  const roles = K.ctx.roles, cr = K.ctx.connectors ?? { wall: { body: 'structure', cap: 'trim', frame: 'trim' }, gate: { frame: 'trim', door: null } };
  const body = roles[cr.wall.body] ?? roles.structure, cap = roles[cr.wall.cap] ?? roles.trim, frame = roles[cr.gate.frame ?? cr.wall.frame] ?? roles.trim;
  const capWall = shapeOf(cap, 'wall'), capSlab = shapeOf(cap, 'slab');
  const slabState = (b) => `${b}[type=bottom,waterlogged=false]`;
  const foundation = roles.foundation, surface = roles.path;
  // ((H-b) a wet section's block under the water's surface: the body where it may stand there, else foundation, else stone bricks)
  const wetBody = W.wet ? (underwaterOk(body) ? body : underwaterBlock([foundation, roles.structure, 'minecraft:stone_bricks'])) : null;
  const wetAt = (x, z) => W.wet?.at.get(key(x, z)) ?? null;
  const footAt = (x, z) => { const w = wetAt(x, z); return w ? w[2] - 1 : S.groundAt(x, z) - 2; };
  const bodyAt = (x, y, z) => { const w = wetAt(x, z); return w && y <= w[3] ? wetBody : body; };
  // ---- the top per position: the standable surface within 2 of its cells (either side) plus height; a gate's lintel and a course
  // over it
  const n = W.positions.length;
  const S2 = new Array(n).fill(-32768);
  const cellsOfPos = Array.from({ length: n }, () => []);
  for (const c of W.cells) cellsOfPos[c.pos].push(c);
  for (let i = 0; i < n; i++) for (const c of cellsOfPos[i]) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) S2[i] = Math.max(S2[i], K.stand(c.x + dx, c.z + dz));
  const T = S2.map((s) => s + st.height);
  for (const g of W.gates) for (let i = g.a - 1; i <= g.b + 1; i++) if (i >= 0 && i < n) T[i] = Math.max(T[i], g.y + g.h + 3 + (g.frame === 'arch' && g.width >= 3 ? 1 : 0));
  // smoothed to runs of at least 3 (only raised)
  for (let it = 0; it < 16; it++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let a = i; while (a > 0 && T[a - 1] === T[i]) a--;
      let b = i; while (b < n - 1 && T[b + 1] === T[i]) b++;
      if (b - a + 1 >= 3 || b - a + 1 === n) { i = b; continue; }
      const nb = Math.max(a > 0 ? T[a - 1] : -32768, b < n - 1 ? T[b + 1] : -32768);
      if (nb > T[i]) { for (let k = a; k <= b; k++) T[k] = nb; } else { if (a > 0) T[a - 1] = T[i]; if (b < n - 1) T[b + 1] = T[i]; }
      changed = true;
      i = b;
    }
    if (!changed) break;
  }
  // ((7a K2, §3) a walk: its surface ramps over the raised tops (within one half block a cell), the wall's top the walk's)
  const WK = st.walk ? walkLevels(T, W.closed) : null;
  if (WK) for (let i = 0; i < n; i++) T[i] = WK.top[i];
  // ---- the cells
  const ops = new Map(); // "x,y,z" -> state | null (air)
  const put = (x, y, z, s) => ops.set(`${x},${y},${z}`, s);
  const opening = new Map(); // "x,z" -> gate
  for (const g of W.gates) for (const [x, z] of g.cells) opening.set(key(x, z), g);
  const walkSet = new Set(K.walk.map(([x, z]) => key(x, z)));
  const capCells = new Map(); // "x,z" -> {y, merlon}
  const posEnd = new Set(W.ends);
  // the broken variants (kit tests and the gate only, through the part's own ext under Architect's namespace): `noGates` writes the
  // wall over its openings (M2:wall), `gap: n` leaves n positions of its first free straight run unwritten (closure fails)
  const unsafe = W.p.part.ext?.['architect_mc:unsafe'] ?? {};
  let gapRun = null;
  if (Number.isInteger(unsafe.gap) && unsafe.gap > 0) for (let a = 2; a + unsafe.gap < n - 2 && !gapRun; a++) if (runFree(W, a, a + unsafe.gap - 1)) gapRun = [a, a + unsafe.gap - 1];
  // ((6c HY-c, §8.3) the water gates: in a crossing's columns the wall has no footing; it stands on the course's own cells (the banks'
  // shell, its rim), and over the grate on a lintel at the reach's open top in the gate frame's role; never a cell of the course's body,
  // shell or lining. Broken variants (the wall part's ext architect_mc:unsafe): `noLintel` leaves the crossing's columns unwritten (a gap
  // in the wall over the water: M2:wall closure), `lintelLow` lays the lintel on as a ceiling over the reach 3 cells past each face
  // (M25:trap))
  const wgs = waterGates(K, W);
  const courseTop = new Map(), grateCols = new Set(), lowCols = [];
  for (const q of wgs) {
    const b = (r._fluidBodies ?? []).find((o) => o.id === q.body);
    if (!b) continue;
    for (const [x, y, z] of [...b.cells, ...b.shell, ...(b.lining ?? [])]) { const k = key(x, z); if (W.cellAt.has(k) && !(courseTop.get(k) >= y)) courseTop.set(k, y); }
    for (const [x, z] of q.cells) grateCols.add(key(x, z));
    if (unsafe.lintelLow && q.normal) {
      const [nx, nz] = q.normal, own = new Set(b.cells.map((c) => key(c[0], c[2])));
      const d = (x, z) => x * nx + z * nz;
      const dmin = Math.min(...q.cells.map(([x, z]) => d(x, z))), dmax = Math.max(...q.cells.map(([x, z]) => d(x, z)));
      for (const [x, z] of q.cells) {
        if (d(x, z) === dmin) for (let k = 1; k <= 3; k++) if (own.has(key(x - nx * k, z - nz * k))) lowCols.push([x - nx * k, q.lintel, z - nz * k]);
        if (d(x, z) === dmax) for (let k = 1; k <= 3; k++) if (own.has(key(x + nx * k, z + nz * k))) lowCols.push([x + nx * k, q.lintel, z + nz * k]);
      }
    }
  }
  for (const c of W.cells) {
    if (gapRun && c.pos >= gapRun[0] && c.pos <= gapRun[1]) continue;
    const ct = courseTop.size ? courseTop.get(key(c.x, c.z)) : undefined;
    if (ct !== undefined) {
      if (unsafe.noLintel) continue;
      const top = T[c.pos];
      const y0 = ct + 1;
      if (grateCols.has(key(c.x, c.z))) put(c.x, y0, c.z, frame);
      else put(c.x, y0, c.z, body);
      for (let y = y0 + 1; y < top; y++) put(c.x, y, c.z, body);
      capCells.set(key(c.x, c.z), { y: Math.max(top, y0 + 1), merlon: !st.crenels || (c.depth === t - 1 && (c.pos & 1) === 0) });
      continue;
    }
    const g = opening.get(key(c.x, c.z));
    if (!g && walkSet.has(key(c.x, c.z))) continue; // never on a walk cell (a network's crossing is a gate)
    const foot = footAt(c.x, c.z);
    const top = T[c.pos];
    if (g && unsafe.noGates) {
      // (the broken variant: the walk left under a filled opening)
      for (let y = g.y + 1; y < top; y++) put(c.x, y, c.z, body);
      capCells.set(key(c.x, c.z), { y: top, merlon: false });
      continue;
    }
    if (g) {
      // the opening: the walk through at the gate's y (filled under where no route or network wrote it), `h` clear, the lintel (an
      // arch: upside-down stairs at its sides, the middle a step higher), the body above, the cap
      if (!g.routed) { for (let y = Math.min(foot, g.y - 1); y < g.y; y++) put(c.x, y, c.z, foundation); put(c.x, g.y, c.z, `${surface}#walk`); }
      for (let y = g.y + 1; y <= g.y + g.h; y++) put(c.x, y, c.z, null);
      const lat = c.pos - g.a;
      let y0 = g.y + g.h + 1;
      if (g.frame === 'arch' && g.width >= 2 && (lat === 0 || lat === g.width - 1)) put(c.x, y0, c.z, stairsState(shapeOf(frame, 'stairs') ?? shapeOf(roles.trim, 'stairs'), lat === 0 ? sideward(W, g, -1) : sideward(W, g, 1), 'top') ?? frame);
      else if (g.frame === 'arch' && g.width >= 3) { put(c.x, y0, c.z, null); y0++; put(c.x, y0, c.z, frame); }
      else put(c.x, y0, c.z, frame);
      for (let y = y0 + 1; y < top; y++) put(c.x, y, c.z, body);
    } else {
      // a jamb (beside an opening, in its run): the frame role up to the lintel
      const jg = W.gates.find((q) => c.pos === q.a - 1 || c.pos === q.b + 1);
      for (let y = foot; y < top; y++) put(c.x, y, c.z, jg && y > jg.y && y <= jg.y + jg.h + 1 ? frame : bodyAt(c.x, y, c.z));
      if (posEnd.has(c.pos)) { put(c.x, top, c.z, body); capCells.set(key(c.x, c.z), { y: top + 1, merlon: true }); continue; }
    }
    capCells.set(key(c.x, c.z), { y: top, merlon: !st.crenels || (c.depth === t - 1 && (c.pos & 1) === 0) });
  }
  for (const [x, y, z] of lowCols) put(x, y, z, frame);
  // ((7a K2, the coordinator's ruling (b)) an along wall's gate landings: the 2 cells past the wall each side cut or filled to the gate's
  // floor, then the flight to the ground; over a route's cells only the cut (the route levels its own floor). A route's own gate gets one
  // too (its route made it flat: nothing to do but the head room); one that does not fit is noted
  const landingStairs = shapeOf(foundation, 'stairs') ?? shapeOf(body, 'stairs') ?? 'minecraft:stone_brick_stairs';
  if (W.form === 'along') for (const g of W.gates) {
    g.landing ??= landingOf(K, W, g);
    if (!g.landing.ok) continue;
    for (const c of g.landing.cells) {
      const G = S.groundAt(c.x, c.z);
      const isWalk = walkSet.has(key(c.x, c.z));
      for (let y = c.y + 1; y <= Math.max(G, c.y + 3); y++) put(c.x, y, c.z, null);
      if (isWalk) continue;
      for (let y = G + 1; y < c.y; y++) put(c.x, y, c.z, foundation);
      put(c.x, c.y, c.z, c.kind === 'stair' ? `${landingStairs}[facing=${c.facing},half=bottom,shape=straight,waterlogged=false]#walk` : `${surface}#walk`);
    }
    // its open sides over a drop of more than 1: the side column filled to the landing and the rail role's fence on it (M8)
    const own = new Set(g.landing.cells.map((c) => key(c.x, c.z)));
    const railFence = shapeOf(roles.rail ?? 'minecraft:oak_fence', 'fence') ?? 'minecraft:oak_fence';
    const sides = new Map();
    for (const c of g.landing.cells) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = c.x + dx, z = c.z + dz, k = key(x, z);
      if (own.has(k) || W.cellAt.has(k) || walkSet.has(k) || opening.has(k)) continue;
      const gq = W.G.at(x, z);
      if (gq < 0 || W.G.ob[gq]) continue;
      if (c.y - S.groundAt(x, z) <= 1) continue;
      if (!(sides.get(k)?.y >= c.y)) sides.set(k, { x, z, y: c.y });
    }
    for (const q of sides.values()) {
      for (let y = S.groundAt(q.x, q.z) + 1; y <= q.y; y++) put(q.x, y, q.z, foundation);
      put(q.x, q.y + 1, q.z, `${railFence}[east=false,north=false,south=false,waterlogged=false,west=false]`);
      put(q.x, q.y + 2, q.z, null);
    }
  }
  // corner stubs: 3 above the wall
  for (const [x, z] of stubCells(W)) {
    const c = W.cellAt.get(key(x, z));
    const top = (c ? T[c.pos] : Math.max(...T)) + 3;
    for (let y = footAt(x, z); y < top; y++) put(x, y, z, bodyAt(x, y, z));
    capCells.set(key(x, z), { y: top, merlon: true });
  }
  // the cap course: wall blocks (merlons, or every cell without crenels), bottom slabs between; a cap with neither: its full block
  // and lamps along the top
  let topLamps = false;
  for (const [k, cc] of capCells) {
    if (WK) break; // ((7a K2) a walk wall's top course is the walk's: wallWalk.mjs)
    if (cc.merlon && capWall) continue;
    const [x, z] = k.split(',').map(Number);
    put(x, cc.y, z, capSlab ? slabState(capSlab) : capWall ? wallState(capWall, {}) : cap);
    if (!capSlab && !capWall) topLamps = true;
  }
  for (const [k, cc] of capCells) {
    if (WK) break;
    if (!(cc.merlon && capWall)) continue;
    const [x, z] = k.split(',').map(Number);
    const joins = (dx, dz) => { const o = capCells.get(key(x + dx, z + dz)); return !!o && o.y === cc.y && o.merlon; };
    put(x, cc.y, z, wallState(capWall, { n: joins(0, -1), s: joins(0, 1), e: joins(1, 0), w: joins(-1, 0) }));
  }
  // ---- doors, fence gates, lamps
  const fixture = lampFixture(r);
  const lampCells = [];
  for (const g of W.gates) {
    const outRow = W.cells.filter((c) => opening.get(key(c.x, c.z)) === g && c.depth === t - 1).sort((a, b) => a.pos - b.pos);
    const fo = facingOut(W, outRow[0] ?? W.cells.find((c) => opening.get(key(c.x, c.z)) === g));
    if (g.door === 'door') {
      const dm = doorOf(frame);
      const k0 = Math.floor((outRow.length - Math.min(2, outRow.length)) / 2);
      const use = outRow.slice(k0, k0 + Math.min(2, outRow.length));
      use.forEach((c, i) => {
        const hinge = use.length === 1 || i === 0 ? 'left' : 'right';
        put(c.x, g.y + 1, c.z, `${dm}[facing=${fo},half=lower,hinge=${hinge},open=false,powered=false]`);
        put(c.x, g.y + 2, c.z, `${dm}[facing=${fo},half=upper,hinge=${hinge},open=false,powered=false]`);
      });
      if (outRow.length > 2) W.notes.push(`gate ${g.id}: ${g.width} wide, its double door covers the middle 2`);
    } else if (g.door === 'fence_gate') {
      const fg = shapeOf(roles.rail, 'fence_gate') ?? 'minecraft:oak_fence_gate';
      const fx = fo === 'north' || fo === 'south' ? fo : fo;
      for (const c of outRow) put(c.x, g.y + 1, c.z, `${fg}[facing=${fx},in_wall=false,open=false,powered=false]`);
    }
    // one lamp a side, beside the opening, outside and inside
    if (st.lamps !== 'none') for (const side of [1, -1]) {
      const spot = lampSpot(K, W, g, side, opening, walkSet);
      if (spot) for (const q of fixtureCells(fixture, spot).cells) lampCells.push(q);
    }
  }
  // lamps along the top (lamps: every, or a cap with neither variant; (7a K2) a walk has its own, on the parapet)
  if (!WK && (st.lamps === 'every' || topLamps)) {
    const every = Math.max(4, Math.floor((12 * fixture.level) / 15));
    for (let i = 0; i < n; i += every) {
      const c = cellsOfPos[i].find((q) => q.depth === 0 && !opening.has(key(q.x, q.z)) && capCells.has(key(q.x, q.z)));
      if (!c) continue;
      for (const q of fixtureCells(fixture, [c.x, capCells.get(key(c.x, c.z)).y + 1, c.z]).cells) lampCells.push(q);
    }
  }
  // ---- ((7a K2, §3) the walk: the courses on the top, the parapet, the inner rail on its corbels, the accesses, the lamps)
  let walkOut = null;
  if (WK) {
    const lampFoot = new Set(lampCells.map(([x, , z]) => key(x, z)));
    // (the gate landings' columns: no access flight or rail over them)
    const landing = new Map();
    for (const g of W.gates) if (g.landing?.ok) for (const c of g.landing.cells) landing.set(key(c.x, c.z), Math.max(c.y, landing.get(key(c.x, c.z)) ?? -32768));
    walkOut = emitWalk({ K, W, top: T, S2: WK.S2, put, landing, get: (x, y, z) => ops.get(`${x},${y},${z}`), has: (c) => capCells.has(key(c.x, c.z)), roles, cr, body, opening, walkSet, stubs: new Set(stubCells(W).map(([x, z]) => key(x, z))), lampFoot, fixture });
    if (walkOut.refuse) throw Object.assign(new Error(walkOut.refuse.message), { reason: walkOut.refuse });
    for (const q of walkOut.lamps) lampCells.push(q);
  }
  // ---- the graph: a node per gate (kind gate, its wall the ref; §8's additive wire shape)
  for (const g of W.gates) {
    const c0 = W.cells.find((c) => c.pos === ((g.a + g.b) >> 1)) ?? W.cells[0];
    r.graphNode({ id: `gate:${g.id}`.slice(0, 64), kind: 'gate', ref: W.id, at: g.at, ports: [{ name: 'gate', at: g.at, facing: facingOut(W, c0), width: g.width }] });
  }
  // ((7a K2, §3) the walk's accesses (kind access) and its runs between them (type wall_walk, player only)
  if (walkOut) {
    for (const a of walkOut.nodes) r.graphNode({ id: a.id, kind: 'access', ref: W.id, at: a.at, ports: [{ name: 'walk', at: a.at, facing: 'up', width: st.walk.width }] });
    for (const e of walkOut.edges) r.graphEdge({ id: e.id, from: `${e.from}.walk`, to: `${e.to}.walk`, type: 'wall_walk', width: st.walk.width, path: `w_${W.id}`.slice(0, 48), stage: K.stageOf('links'), movers: ['player'] });
  }
  // ---- the ops: one part per wall in the links stage, absolute y
  const part = r.part(`w_${W.id}`.slice(0, 48), { stage: K.stageOf('links') });
  (r.meta.parts[part.id] ??= {}).kind = 'add';
  const matIdx = (m, M, I) => { const k2 = m ?? '\u0000'; let i = I.get(k2); if (i === undefined) { i = M.length; M.push(m); I.set(k2, i); } return i; };
  const cols = [], mats = [], mi = new Map(), walkCols = [], wmats = [], wmi = new Map();
  const sorted = [...ops.entries()].map(([k, s]) => { const [x, y, z] = k.split(',').map(Number); return [x, y, z, s]; }).sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
  for (const [x, y, z, s] of sorted) {
    if (typeof s === 'string' && s.endsWith('#walk')) walkCols.push(x, z, y, y, matIdx(s.slice(0, -5), wmats, wmi));
    else cols.push(x, z, y, y, matIdx(s, mats, mi));
  }
  if (cols.length) part.columns({ abs: 0 }, { abs: 0 }, cols, mats, { cond: COND.ALWAYS_OURS });
  if (walkCols.length) part.columns({ abs: 0 }, { abs: 0 }, walkCols, wmats, { cond: COND.ALWAYS_OURS, walk: true });
  if (lampCells.length) {
    const lc = [], lm = [], li = new Map();
    for (const [x, y, z, s] of lampCells) lc.push(x, z, y, y, matIdx(s, lm, li));
    part.columns({ abs: 0 }, { abs: 0 }, lc, lm, { cond: COND.IF_AIR_OR_FLUID });
  }
  // ---- the bill of materials (the wall's cells; each gate part's own: its opening's columns), the meta, the record, the geometry
  const states = [];
  for (const [, s] of ops) if (s) states.push(s.replace(/#walk$/, ''));
  for (const q of lampCells) states.push(q[3]);
  const gateBom = new Map();
  for (const g of W.gates) if (g.part) {
    const mine = new Set(g.cells.map(([x, z]) => key(x, z)));
    const list = [];
    for (const [k, s] of ops) { const [x, , z] = k.split(','); if (s && mine.has(`${x},${z}`)) list.push(s.replace(/#walk$/, '')); }
    gateBom.set(g.id, bomOf(list));
  }
  const line = [];
  W.positions.forEach((q, i) => { if (i === 0 || i === n - 1 || q.axis === 3) line.push([q.x, q.z]); });
  // ((7a K2) a gate's landing: its cells (x, y, z: the floor or stair block), its flight steps)
  const gatesOut = W.gates.map((g) => ({ id: g.id, at: g.at, width: g.width, door: g.door, frame: g.frame, auto: g.auto, kind: g.kind, y: g.y, h: g.h, cells: g.cells, ...(g.conn ? { crossing: g.conn } : {}), ...(g.landing?.ok ? { landing: { steps: g.landing.cells.filter((c) => c.kind === 'stair').length, cells: g.landing.cells.map((c) => [c.x, c.y, c.z]) } } : {}) }));
  const meta = {
    id: W.id, part: W.id, form: W.form, closed: W.closed, sealed: st.sealed, height: st.height, thickness: t, crenels: st.crenels, line,
    inside: W.closed && W.I ? arr(W.I) : null, joined: W.joined, ends: W.ends,
    cells: W.cells.filter((c) => opening.has(key(c.x, c.z)) || !walkSet.has(key(c.x, c.z))).map((c) => [c.x, c.z, T[c.pos], c.pos, c.depth]),
    gates: unsafe.noGates ? [] : gatesOut,
  };
  // ((6c HY-c) the water gates: meta walls[].waterGates, the record's, the answer's geometry and its crossing)
  const wgOut = wgs.map((q) => ({ course: q.course, body: q.body, cells: q.cells, lintel: q.lintel, level: q.level, grate: q.grate.length }));
  if (wgOut.length) meta.waterGates = wgOut;
  const record = { id: W.id, form: W.form, closed: W.closed, sealed: st.sealed, line, cells: W.cells.length, top: [Math.min(...T), Math.max(...T)], gates: gatesOut.map(({ cells, ...g }) => { void cells; return g; }) };
  const geometry = { form: W.form, line, closed: W.closed, height: st.height, thickness: t, cells: W.cells.length, top: [Math.min(...T), Math.max(...T)], gates: gatesOut.map((g) => ({ id: g.id, at: g.at, width: g.width, door: g.door, auto: g.auto, kind: g.kind })), ...(W.I ? { ring: arr(W.I) } : {}), ...(W.joined.length ? { joined: W.joined } : {}), ...(st.sealed ? { sealed: true } : {}) };
  if (walkOut) { meta.walk = walkOut.meta; geometry.walk = walkOut.geometry; record.walk = { width: st.walk.width, runs: walkOut.edges.length, accesses: walkOut.meta.accesses.length }; }
  // ((7a K2, §2, §7) an along wall: its spine (corners), the window used and each run's offset; meta and siteplan carry the spine)
  if (W.along) {
    const sp = W.along.spine, corners = sp.filter((q, i) => i === 0 || i === sp.length - 1 || (sp[i - 1][0] !== sp[i + 1][0] && sp[i - 1][1] !== sp[i + 1][1]));
    geometry.along = { kind: W.along.kind, side: W.along.side, distance: W.along.distance, window: W.along.window, spine: corners.map((q) => [...q]), runs: W.along.runs };
    meta.along = { kind: W.along.kind, side: W.along.side, distance: W.along.distance, spine: sp.slice(W.along.window[0], W.along.window[1] + 1).map((q) => [...q]) };
    record.along = { kind: W.along.kind, side: W.along.side, window: W.along.window, runs: W.along.runs.length };
  }
  // ((H-b) a harbour wall: its wet sections (runs of positions in natural water: from, to at the surface, the deepest water) and its
  // crossing of the water)
  if (W.wet) {
    const runs = [];
    let cur = null;
    for (let i = 0; i < n; i++) {
      const ws = cellsOfPos[i].map((c) => wetAt(c.x, c.z)).filter(Boolean);
      if (!ws.length) { if (cur) { runs.push(cur); cur = null; } continue; }
      const q = W.positions[i], d = Math.max(...ws.map((w) => w[3] - w[2])), s = Math.max(...ws.map((w) => w[3]));
      if (!cur) cur = { from: [q.x, s, q.z], to: [q.x, s, q.z], depth: d, first: i };
      else { cur.to = [q.x, s, q.z]; cur.depth = Math.max(cur.depth, d); }
    }
    if (cur) runs.push(cur);
    // (a closed ring's run through position 0 joins its last)
    if (W.closed && runs.length > 1 && runs[0].first === 0 && cellsOfPos[n - 1].some((c) => wetAt(c.x, c.z))) { const last = runs.pop(); runs[0] = { from: last.from, to: runs[0].to, depth: Math.max(last.depth, runs[0].depth), first: last.first }; }
    geometry.wet = runs.map(({ from, to, depth }) => ({ from, to, depth }));
    geometry.crossing = { type: 'wall', over: 'water', depth: Math.max(...runs.map((q) => q.depth)) };
    meta.wet = { record: W.wet.record, columns: W.wet.cols.map((q) => [...q]), waterDepth: W.wet.waterDepth };
    record.wet = geometry.wet;
  }
  if (wgOut.length) {
    record.waterGates = wgOut;
    geometry.waterGates = wgOut.map(({ course, cells, lintel }) => ({ course, cells: cells.length, lintel }));
    if (!geometry.crossing) geometry.crossing = { type: 'wall', over: 'course', gate: 'water', course: wgOut[0].course };
  }
  return { meta, record, geometry, bom: bomOf(states), gateBom, notes: walkOut?.notes ?? [] };
}

/** The heading out of the wall at a cell (from its inner course to its outer). */
function facingOut(W, c) {
  const inner = W.cells.find((q) => q.pos === c.pos && q.depth === 0), outer = W.cells.find((q) => q.pos === c.pos && q.depth === W.st.thickness - 1) ?? inner;
  let dx = Math.sign(outer.x - inner.x), dz = Math.sign(outer.z - inner.z);
  if (!dx && !dz) { const p = W.positions[c.pos]; if (p.axis === 1) dz = 1; else dx = 1; }
  return FACING[`${dx},${dz}`] ?? 'north';
}

/** The facing along a gate's run toward its first (-1) or last (+1) position: an arch stair's tall side, toward its jamb. */
function sideward(W, g, s) {
  const p0 = W.positions[g.a], p1 = W.positions[g.b];
  const dx = Math.sign(p1.x - p0.x) * s, dz = Math.sign(p1.z - p0.z) * s;
  return FACING[`${dx},${dz}`] ?? 'north';
}

/** An upside-down (`top`) stair's state facing `f` (its tall side), or null. */
function stairsState(block, f, half) {
  return block ? `${block}[facing=${f},half=${half},shape=straight,waterlogged=false]` : null;
}

/** A lamp's foot cell beside a gate, outside (side 1) or inside (-1): beside a jamb, off every walk and wall cell and route. */
function lampSpot(K, W, g, side, opening, walkSet) {
  const t = W.st.thickness;
  for (const jp of [g.a - 1, g.b + 1]) {
    const c = W.cells.find((q) => q.pos === jp && q.depth === (side > 0 ? t - 1 : 0));
    if (!c) continue;
    const inner = W.cells.find((q) => q.pos === jp && q.depth === 0), outer = W.cells.find((q) => q.pos === jp && q.depth === t - 1) ?? inner;
    let dx = Math.sign(outer.x - inner.x), dz = Math.sign(outer.z - inner.z);
    if (!dx && !dz) { const p = W.positions[jp]; if (p.axis === 1) dz = 1; else dx = 1; }
    const x = c.x + dx * side, z = c.z + dz * side;
    const k = key(x, z);
    if (W.cellAt.has(k) || opening.has(k) || walkSet.has(k)) continue;
    if (K.routed.some((e) => (e.meta?.path ?? []).some((q) => Math.abs(q[0] - x) <= Math.floor((e.leg?.width ?? 3) / 2) + 1 && Math.abs(q[2] - z) <= Math.floor((e.leg?.width ?? 3) / 2) + 1))) continue;
    const gk = W.G.at(x, z);
    if (gk < 0 || W.G.ob[gk]) continue;
    return [x, K.stand(x, z) + 1, z];
  }
  return null;
}

// ------------------------------------------------------------------ the primitive (r.wall, r.gate): any program

/**
 * (§3) `r.wall(line, opts)` (kit/lib/region/program.mjs): a wall on a polyline (`[[x, z], ...]` corners, each leg a 4-connected line)
 * or a ring (`{ring: [x0, z0, x1, z1]}`: the inner line's rect, the thickness outward), emitted as plan_v0 emits its walls (the top
 * from the standable ground within 2 plus the height, the crenels, the gates' openings, jambs, lintels, doors and lamps), in
 * `opts.stage`. `opts.gates` ([{at: [x, z], width, door, frame, height}]) opens gates on the free straight runs nearest each point;
 * `defer: true` returns the handle ({gate(at, o), done()}) instead of building it now. Returns {id, gates, geometry, bom}.
 */
export function wallPrimitive(r, line, opts = {}) {
  const id = opts.id ?? `wall${(r.meta.walls?.length ?? 0) + 1}`;
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]{0,40}$/.test(id)) throw new Error(`r.wall: id '${id}' must match ^[a-z][a-z0-9_]{0,40}$`);
  const height = opts.height ?? WALL_DEFAULTS.height, t = opts.thickness ?? WALL_DEFAULTS.thickness;
  if (!(Number.isInteger(height) && height >= 3 && height <= 16)) throw new Error('r.wall: height must be 3..16');
  if (!(Number.isInteger(t) && t >= 1 && t <= 3)) throw new Error('r.wall: thickness must be 1..3');
  let L, form;
  if (line && Array.isArray(line.ring)) {
    const [x0, z0, x1, z1] = line.ring;
    if (![x0, z0, x1, z1].every(Number.isInteger) || x1 - x0 < 4 || z1 - z0 < 4) throw new Error('r.wall: ring must be [x0, z0, x1, z1] at least 5 a side');
    L = ringCells({ minX: x0, minZ: z0, maxX: x1, maxZ: z1 }, t, opts.closed === false ? (opts.omit ?? 'n') : null);
    L.I = { minX: x0, minZ: z0, maxX: x1, maxZ: z1 };
    form = 'around';
  } else if (Array.isArray(line) && line.length >= 2 && line.every((q) => Array.isArray(q) && Number.isInteger(q[0]) && Number.isInteger(q[1]))) {
    const cells = [];
    for (let i = 0; i + 1 < line.length; i++) {
      const [ax, az] = line[i], [bx, bz] = line[i + 1];
      const dx = Math.abs(bx - ax), dz = Math.abs(bz - az), sx = bx > ax ? 1 : -1, sz = bz > az ? 1 : -1;
      let x = ax, z = az, ix = 0, iz = 0;
      if (!cells.length) cells.push([x, z, null]);
      while (ix < dx || iz < dz) {
        const tx = (1 + 2 * ix) * dz, tz = (1 + 2 * iz) * dx;
        let h;
        if (iz >= dz || (ix < dx && tx <= tz)) { x += sx; ix++; h = sx > 0 ? 0 : 2; } else { z += sz; iz++; h = sz > 0 ? 1 : 3; }
        cells.push([x, z, h]);
      }
    }
    if (cells.length < 2) throw new Error('r.wall: a line needs two distinct points');
    cells[0][2] = cells[1][2];
    L = lineCells(cells, t);
    form = 'line';
  } else throw new Error('r.wall: line must be [[x, z], ...] (at least 2 points) or {ring: [x0, z0, x1, z1]}');
  const st = { form, P: { notes: [], read: {}, joins: [], unread: [] }, closed: !!L.closed, sealed: false, gatesMin: 0, gatesMax: WALL_DEFAULTS.gatesMax, height, thickness: t,
    crenels: opts.crenels ?? WALL_DEFAULTS.crenels, corners: opts.corners ?? WALL_DEFAULTS.corners, lamps: opts.lamps ?? 'gates' };
  const S = r.survey;
  const K = { r, env: { S, claim: r.claim, cols: S.columns, protectedAreas: [], keepOut: [], regions: [], buildRects: [], standingHard: [] }, ctx: r.ctx, routed: [], stageOf: () => r._stage(opts.stage), record: {} };
  K.walk = networkWalk(r, S);
  K.stand = standMap(K, K.walk);
  const W = { id, p: { part: { ext: opts._unsafe ? { 'architect_mc:unsafe': opts._unsafe } : {} } }, st, form, positions: L.positions, cells: L.cells, ends: L.ends ?? [], closed: L.closed, I: L.I ?? null, target: null, joined: [], gates: [], devs: [], notes: [], opened: 0,
    G: obstacleGrid({ claim: r.claim, cols: S.columns, walkCells: K.walk }) };
  W.cellAt = new Map(W.cells.map((c) => [key(c.x, c.z), c]));
  let built = null;
  const handle = {
    id,
    gate(at, o = {}) {
      if (built) throw new Error(`r.gate: wall ${id} is built already`);
      const door = o.door ?? WALL_DEFAULTS.door, width = o.width ?? (door === 'door' ? 2 : WALL_DEFAULTS.gateWidth);
      const run = nearestRun(W, at, width);
      if (!run) throw new Error(`r.gate: wall ${id} has no free straight run for a ${width}-wide gate`);
      const mid = W.positions[(run.a + run.b) >> 1];
      const g = makeGate(W, { a: run.a, b: run.b, y: S.groundAt(mid.x, mid.z), h: o.height ?? WALL_DEFAULTS.gateHeight, auto: false, kind: 'at', part: o.id ?? null, door, frame: o.frame ?? WALL_DEFAULTS.frame });
      W.gates.push(g);
      return { id: g.id, at: g.at, width: g.width, moved: run.d };
    },
    done() {
      if (built) return built;
      const out = emitWall(K, W);
      r.meta.walls = [...(r.meta.walls ?? []), out.meta];
      built = { id, gates: out.meta.gates.map((g) => ({ id: g.id, at: g.at, width: g.width, door: g.door })), geometry: out.geometry, bom: out.bom };
      return built;
    },
  };
  for (const g of opts.gates ?? []) handle.gate(g.at, g);
  return opts.defer ? handle : handle.done();
}
