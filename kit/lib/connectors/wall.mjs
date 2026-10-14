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
import { readParams } from './params.mjs';
import { MARGIN, OB, lineCells, lineLeg, obstacleGrid, placeRing, ringCells } from './line.mjs';
import { doorOf, shapeOf } from './style.mjs';
import { bomOf } from './bom.mjs';
import { centreCells } from '../region/geom.mjs';
import { footprintOf } from '../region/passes/route.mjs';
import { fixtureCells } from '../region/fixtures.mjs';
import { lampFixture } from '../region/props.mjs';
import { COND } from '../region/program.mjs';

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

/** The obstacle grid of K's claim, with the zones in `allowZones` lifted (a line wall into a joined lot's own zone). */
function gridOf(K, { allowZones = [] } = {}) {
  const env = K.env, r = K.r;
  const zoneRects = [];
  for (const p of K.order) {
    if (p.family !== 'zone' || allowZones.includes(p.id) || !K.okClass(p.id)) continue;
    const z = K.res.get(p.id);
    for (const q of z?.rects ?? (z?.rect ? [z.rect] : [])) zoneRects.push(q);
  }
  const lots = r.lots.map((l) => grow(l.box, 1));
  const forms = r.forms.filter((f) => f.bounds).map((f) => f.bounds);
  const protectedR = [...env.protectedAreas.map((a) => a.rect), ...env.keepOut];
  const overlap = [...zoneRects, ...lots, ...forms, ...env.regions.map((a) => grow(a.rect, 1)), ...env.buildRects.map((a) => grow(a.rect, 1)), ...env.standingHard.map(rect)];
  return obstacleGrid({ claim: env.claim, cols: env.cols, rects: { [OB.PROTECTED]: protectedR, [OB.OVERLAP]: overlap }, walkCells: K.walk, keepOut: [...protectedR, ...env.regions.map((a) => a.rect), ...env.buildRects.map((a) => a.rect)], kept: r._keptColumns() });
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
  const gatesMin = Number.isInteger(g) ? g : Number.isInteger(g?.min) ? g.min : P.read.gatesMin ?? WALL_DEFAULTS.gatesMin;
  const gatesMax = Number.isInteger(g?.max) ? g.max : g === 0 || P.read.gatesMin === 0 ? 0 : WALL_DEFAULTS.gatesMax;
  const form = w.where?.around ? 'around' : w.where?.inside ? 'edge' : 'line';
  const closedWritten = w.where?.around?.closed ?? P.read.closed;
  const closed = form === 'line' ? false : closedWritten ?? true;
  const namesGate = GATE_KEYS.some((k) => w.params?.[k] !== undefined && !(k === 'gates' && w.params[k] === 0));
  const sealed = gatesMax === 0 || (closedWritten === true && !gateParts(K, p.id).length && !namesGate);
  return {
    form, P, closed, sealed, gatesMin: sealed ? 0 : gatesMin, gatesMax: sealed ? 0 : Math.max(gatesMax, gatesMin),
    height: w.height ?? P.read.height ?? WALL_DEFAULTS.height, thickness: w.thickness ?? WALL_DEFAULTS.thickness,
    crenels: w.crenels ?? WALL_DEFAULTS.crenels, corners: w.corners ?? WALL_DEFAULTS.corners, lamps: w.lamps ?? P.read.lamps ?? 'gates',
  };
}

const blockerText = (b) => Object.entries(b).map(([k, v]) => `${k.toLowerCase().replace(/_/g, ' ')} ${v}`).join(', ');

/** Plan one wall's line: {positions, cells, ends, closed, I?, devs, notes, joined, crossings, G} or {error: reason}. */
function lineOf(K, p, st) {
  const w = p.part, t = st.thickness;
  const notes = [], devs = [];
  if (st.form === 'around') {
    const tg = aroundTarget(K, w.where.around.feature);
    if (tg.error) return { error: tg.error };
    const [r0, r1] = Array.isArray(w.where.around.ring) ? w.where.around.ring : WALL_DEFAULTS.ring;
    const order = [];
    for (let d = r0; d <= r1; d++) order.push(d);
    const G = gridOf(K, {});
    const pl = placeRing(G, tg.rect, order, t);
    if (!pl.ok) return { error: { code: pl.code, message: `no clear ring round ${tg.what} at offsets ${r0}..${r1} on its ${pl.side} side (${blockerText(pl.blockers)})`, evidence: { side: pl.side, ring: [r0, r1], blockers: pl.blockers, target: arr(tg.rect) } } };
    return { ...ringOf(K, pl, t, st, notes), devs, notes, target: tg, G };
  }
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
    const G = gridOf(K, { allowZones: inside.part ? [inside.part] : [] });
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
  const G = gridOf(K, { allowZones });
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
    if (n.error) return { error: n.error };
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
  const ax = W.positions[a].axis;
  if (ax === 3) return false;
  for (let i = a - 1; i <= b + 1; i++) {
    if (W.positions[i].axis !== ax) return false;
    if (W.ends.includes(i)) return false;
    if (W.gates.some((g) => i >= g.a - 1 && i <= g.b + 1)) return false;
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
  W.positions.forEach((q, i) => { const d = (q.x - pt[0]) ** 2 + (q.z - pt[1]) ** 2; if (d < pd) { pd = d; proj = i; } });
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
    const L = lineOf(K, p, st);
    const notes = [...st.P.notes];
    if (L.error) { K.ans(p, { class: 'refused', reasons: [L.error], notes }); continue; }
    notes.push(...L.notes);
    if (st.sealed) notes.push(st.gatesMax === 0 && (p.part.gates === 0 || st.P.read.gatesMin === 0) ? 'sealed: gates 0 (no gate; routes go round it or refuse)' : 'sealed: closed with no gate part (no gate; routes go round it or refuse)');
    const W = { id: p.id, p, st, form: st.form, positions: L.positions, cells: L.cells, ends: L.ends ?? [], closed: L.closed, I: L.I ?? null, target: L.target ?? null, joined: L.joined ?? [], gates: [], devs: L.devs, notes, opened: 0, G: L.G };
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
  if (n.error) { K.ans(g, { class: 'refused', reasons: [n.error], notes: gateNotes(g) }); return; }
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
    return { id: W.id, max: W.st.gatesMax, opened: W.opened, cells, open };
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

// ------------------------------------------------------------------ step 4: crossing gates, auto gates, gates.min

export function finishGates(K) {
  if (!K.walls) return;
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
    if (!W.closed || W.st.sealed) continue;
    const want = W.st.gatesMin - W.gates.length;
    if (want <= 0) continue;
    const pts = [];
    const z = W.target?.zone ? K.zoneEmit.get(W.target.zone) : null;
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
    W.answer = { class: klass, deviations, notes, ...(j.klass === 'refused' ? { reasons: [{ code: 'TOLERANCE', message: `the wall stepped ${mv.value} off its edge, past its ceiling ${tol.ceiling}`, evidence: { move: mv.value } }] } : {}), ...(W.joined.length ? { provisional: true } : {}) };
    K.ans(p, W.answer);
  }
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
      K.mark(W.id, K.addedSince(cp));
      metaWalls.push(out.meta);
      K.r.meta.walls = [...metaWalls];
      K.record.walls.push(out.record);
      K.record.bom[W.id] = out.bom;
      for (const g of W.gates) if (g.part) K.record.bom[g.part] = out.gateBom.get(g.id) ?? {};
      K.answers.get(W.id).geometry = out.geometry;
      for (const g of W.gates) if (g.part && K.answers.get(g.part)) K.answers.get(g.part).geometry = { wall: W.id, at: g.at, width: g.width, height: g.h, door: g.door, frame: g.frame, cells: g.cells.length };
    } catch (e) {
      K.rollback(cp);
      metaWalls.length && (K.r.meta.walls = [...metaWalls]);
      K.ans(W.p, { class: 'refused', reasons: [{ code: 'NO_ROOM', message: `the wall's emission failed: ${e.message}`, evidence: { wall: W.id } }], notes: W.answer?.notes });
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
  // ---- the cells
  const ops = new Map(); // "x,y,z" -> state | null (air)
  const put = (x, y, z, s) => ops.set(`${x},${y},${z}`, s);
  const opening = new Map(); // "x,z" -> gate
  for (const g of W.gates) for (const [x, z] of g.cells) opening.set(key(x, z), g);
  const walkSet = new Set(K.walk.map(([x, z]) => key(x, z)));
  const capCells = new Map(); // "x,z" -> {y, merlon}
  const posEnd = new Set(W.ends);
  for (const c of W.cells) {
    const g = opening.get(key(c.x, c.z));
    if (!g && walkSet.has(key(c.x, c.z))) continue; // never on a walk cell (a network's crossing is a gate)
    const foot = S.groundAt(c.x, c.z) - 2;
    const top = T[c.pos];
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
      for (let y = foot; y < top; y++) put(c.x, y, c.z, jg && y > jg.y && y <= jg.y + jg.h + 1 ? frame : body);
      if (posEnd.has(c.pos)) { put(c.x, top, c.z, body); capCells.set(key(c.x, c.z), { y: top + 1, merlon: true }); continue; }
    }
    capCells.set(key(c.x, c.z), { y: top, merlon: !st.crenels || (c.depth === t - 1 && (c.pos & 1) === 0) });
  }
  // corner stubs: 3 above the wall
  for (const [x, z] of stubCells(W)) {
    const c = W.cellAt.get(key(x, z));
    const top = (c ? T[c.pos] : Math.max(...T)) + 3;
    for (let y = S.groundAt(x, z) - 2; y < top; y++) put(x, y, z, body);
    capCells.set(key(x, z), { y: top, merlon: true });
  }
  // the cap course: wall blocks (merlons, or every cell without crenels), bottom slabs between; a cap with neither: its full block
  // and lamps along the top
  let topLamps = false;
  for (const [k, cc] of capCells) {
    if (cc.merlon && capWall) continue;
    const [x, z] = k.split(',').map(Number);
    put(x, cc.y, z, capSlab ? slabState(capSlab) : capWall ? wallState(capWall, {}) : cap);
    if (!capSlab && !capWall) topLamps = true;
  }
  for (const [k, cc] of capCells) {
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
  // lamps along the top (lamps: every, or a cap with neither variant)
  if (st.lamps === 'every' || topLamps) {
    const every = Math.max(4, Math.floor((12 * fixture.level) / 15));
    for (let i = 0; i < n; i += every) {
      const c = cellsOfPos[i].find((q) => q.depth === 0 && !opening.has(key(q.x, q.z)) && capCells.has(key(q.x, q.z)));
      if (!c) continue;
      for (const q of fixtureCells(fixture, [c.x, capCells.get(key(c.x, c.z)).y + 1, c.z]).cells) lampCells.push(q);
    }
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
  const gatesOut = W.gates.map((g) => ({ id: g.id, at: g.at, width: g.width, door: g.door, frame: g.frame, auto: g.auto, kind: g.kind, y: g.y, h: g.h, cells: g.cells, ...(g.conn ? { crossing: g.conn } : {}) }));
  const meta = {
    id: W.id, part: W.id, form: W.form, closed: W.closed, sealed: st.sealed, height: st.height, thickness: t, crenels: st.crenels, line,
    inside: W.closed && W.I ? arr(W.I) : null, joined: W.joined, ends: W.ends,
    cells: W.cells.filter((c) => opening.has(key(c.x, c.z)) || !walkSet.has(key(c.x, c.z))).map((c) => [c.x, c.z, T[c.pos], c.pos, c.depth]),
    gates: gatesOut,
  };
  const record = { id: W.id, form: W.form, closed: W.closed, sealed: st.sealed, line, cells: W.cells.length, top: [Math.min(...T), Math.max(...T)], gates: gatesOut.map(({ cells, ...g }) => { void cells; return g; }) };
  const geometry = { form: W.form, line, closed: W.closed, height: st.height, thickness: t, cells: W.cells.length, top: [Math.min(...T), Math.max(...T)], gates: gatesOut.map((g) => ({ id: g.id, at: g.at, width: g.width, door: g.door, auto: g.auto, kind: g.kind })), ...(W.I ? { ring: arr(W.I) } : {}), ...(W.joined.length ? { joined: W.joined } : {}), ...(st.sealed ? { sealed: true } : {}) };
  return { meta, record, geometry, bom: bomOf(states), gateBom };
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
