// (6c HY) connector.channel as channel.course in the plan compiler, and the region primitive r.course (docs/CONTRACT.md "Phase 6c slice
// HY" §7, §15). Slice HY-b owns this file; it must not import compile.mjs or program.mjs' compile path (kit/lib/fluids/hooks.mjs
// dispatches to it by the channel's block, channelBlock()).
//   resolve(C, p) -> res          compile step 2, after lots, zones and H's forms (they read lot boxes and X's geometry) and before the
//                                 routes: place the course (the router, the profile, its ends) and register an overflow on each plan
//                                 body it leaves (hooks.mjs registerOverflow(C, ...), before that body emits). res as H's (pond.mjs).
//   emit(K, p, res)               compile step 3: write the reaches (r.fluidBody per reach, ids reachId(part, k), k from the head; lining,
//                                 joins into plan bodies, after); throw 'CODE: message' to refuse it (the part rolls back, and its
//                                 overflow registrations with it)
//   answer(K, p, res) -> extra    compile step 6: the answer's fields over the default, or null
//   acceptsOverflow = true         a course can feed another course (a branch takes an overflow from its nearest reach)
//   course(r, path, opts) -> rec   r.course's implementation (bound into program.mjs below): lay a course along `path` (a hydrology pass's
//                                 data.courses[i], {cells: [[x, z]], accumulation?: [n]}, or a polyline [[x, z], ...]) with opts {id
//                                 (the part id rule; reaches are reachId(id, k)), part, look: 'natural' | 'built', flow: 'level' |
//                                 'pools' | 'riffles', width, depth, drop, riffle, cut, fill, stage, from, to (ends: {kind: 'spring' |
//                                 'pool' | 'weir' | 'join' | 'overflow' | 'rim', ...})}. Returns {id, part, bodies: [body records],
//                                 steps: [{kind: 'fall' | 'spillway' | 'riffle', from, to, drop}], ends: [{end: 'from' | 'to', kind, ref}],
//                                 refused: null | {code, message, until?, evidence?}}: siteplan's `courses` row (r.meta.courses).
//
// The model (§1, §7): a course is a chain of H bodies (reaches), level troughs of sources sunk 1 under their lower bank, lined, joined by
// steps whose flowing water is the upper reach's spill:
//   - the path: 4-connected columns (the router's, or a program's polyline made 4-connected); each index's cross-section is `width` lanes
//     across the flow (both crossings' lanes at a turn), its banks the lanes beside them;
//   - the profile (profile.mjs): each index's level, reaches of at least 4 cells, a step at each drop;
//   - a fall's or spillway's lip is the upper reach's last index: one row of flowing water at the upper level over a lined floor (its
//     lining: the cells under and beside it), falling (or, a spillway, stepping 1) onto the lower reach's first row; the lower reach's
//     first 3 rows are at least 2 deep (H's basin rule); a riffle is the upper reach's last cells, a bed stepping down 1 every `seg` cells;
//   - ends (§7.4): a spring (a 3 x 3 head pool 2 deep) or a terminal pool (3 x 3, 2 deep) at a dry end; a weir head or tail (the reach at
//     the natural water's level, a weir 2 thick between: its shell and one course of `weir` lining) or a fall join (the tail's lip over the
//     bank, falling at least 1 into natural sources at least 2 deep) at natural water; an overflow (the plan body X's side shell cell at its
//     surface opened, its spill over its own lining falling 1 into the head: the head's first row is one lane, a neck) or a fall over X's
//     rim (the tail's last row one lane and 1 deep, its lip over X's rim, a drop of at least 2) at a plan body.
// Every shell and lining cell is the first block of its chain that differs from what stands there (H-a's reading), so the realise writes
// it and the body owns it.
import { _bindCourse } from '../region/program.mjs';
import { reachId, shellOf } from './body.mjs';
import { profileOf, PROFILE } from './profile.mjs';
import { FLAG_WATER, FLAG_LAVA } from '../region/pack.mjs';
import { VC, classAt } from '../region/volume.mjs';
import { bodiesMark, bodiesRollback, featureOf, flagsAt, fluidRolesOf, grow, intIn, linesBody, readParams, rectArr, shellBlock, reachMeetsKeep,
  volumeAnswer, volumeKeep, refusal, leakRefusal, exitNotches, freezesAt, MARGIN, meets, centre } from './place.mjs';
import { bodyAnswer, bodyId, naturalOf, shellCheck, outline, rimColumns, shellStatesOf } from './pond.mjs';
import { ringColumns } from './moat.mjs';
import { registerOverflow, overflowsOn, crossingsOf, channelBlockOf } from './hooks.mjs';
import { localWorld } from './body.mjs';
import { waterGate } from './gate.mjs';

export const acceptsOverflow = true;

/** A course's defaults by look (N-HY-2: streams 2 x 2 natural, canals 3 wide built), and its limits (catalogue §6). */
export const COURSE = Object.freeze({
  natural: { width: 2, depth: 2, notch: 6, turn: 4 },
  built: { width: 3, depth: 2, notch: 12, turn: 12 },
  drop: 6, riffle: 4, cut: 6, fill: 2, length: 512, spring: 3, pool: 3, maxNodes: 600000,
  limits: { width: [1, 5], depth: [1, 3], length: [4, 512], drop: [1, 8], riffle: [2, 6], cut: [0, 6], fill: [0, 2] },
});

const k2 = (x, z) => `${x},${z}`;
const k3 = (x, y, z) => `${x},${y},${z}`;
const un3 = (k) => k.split(',').map(Number);
const DIRS = Object.freeze([[1, 0], [0, 1], [-1, 0], [0, -1]]);
const dirIndex = (dx, dz) => DIRS.findIndex((d) => d[0] === dx && d[1] === dz);
const sortCells = (a) => a.sort((p, q) => p[1] - q[1] || p[0] - q[0] || p[2] - q[2]);

/** The stub's refusal (kept for HY-c's and the tests' reference; nothing answers it once HY-b's generators are in). */
export function stubRefusal(block = 'channel.course') {
  return { code: 'UNREACHABLE', message: `${block} is not built in this build`, evidence: { block } };
}

// ------------------------------------------------------------------ the spec

/** A course's members (first-class, then params leniently, R24: width, depth, drop, look, flow; mill, wheel, sluice, lock, material noted). */
export function courseSpec(part, block = 'channel.course') {
  const pr = readParams(part, {
    width: { read: intIn(1, 5), why: 'not 1..5' },
    depth: { read: intIn(1, 3), why: 'not 1..3' },
    drop: { read: intIn(1, 8), why: 'not 1..8' },
    look: { read: (v) => (v === 'natural' || v === 'built' ? v : undefined), why: 'not natural or built' },
    flow: { read: (v) => (['level', 'pools', 'riffles'].includes(v) ? v : undefined), why: 'not level, pools or riffles' },
    riffle: { read: intIn(2, 6), why: 'not 2..6' },
    cut: { read: intIn(0, 6), why: 'not 0..6' },
    fill: { read: intIn(0, 2), why: 'not 0..2' },
  }, { noted: { mill: 'noted, not read (the wheel is the lot design\'s)', wheel: 'noted, not read (the wheel is the lot design\'s)', sluice: 'noted, not read (no mechanism in HY)', lock: 'noted, not read (no mechanism in HY)', material: "not read (the bible's fluids roles style the course)" } });
  const notes = [...pr.notes];
  const look = part.look ?? pr.read.look ?? 'natural';
  const flow = part.flow ?? pr.read.flow ?? 'pools';
  const L = COURSE[look];
  let width = part.width ?? pr.read.width ?? L.width;
  let depth = part.depth ?? pr.read.depth ?? L.depth;
  if (width > 5) { notes.push(`width ${width}: a course is 1..5 wide (read as 5)`); width = 5; }
  if (depth > 3) { notes.push(`depth ${depth}: a course is 1..3 deep (read as 3)`); depth = 3; }
  const drop = part.drop ?? pr.read.drop ?? COURSE.drop;
  return { block, look, flow, width, depth, drop, riffle: pr.read.riffle ?? COURSE.riffle, cut: pr.read.cut ?? COURSE.cut, fill: pr.read.fill ?? COURSE.fill, notes };
}

// ------------------------------------------------------------------ cross-sections

/** The lane offsets of a width: centred, the extra lane on the + side. */
export const laneOffsets = (w) => { const a = -((w - 1) >> 1); return Array.from({ length: w }, (_, i) => a + i); };
const perp = (d) => (d[0] !== 0 ? [0, 1] : [1, 0]);
/** The lane columns at (x, z) across direction d. */
export function lanesAt(x, z, d, offs) {
  const [px, pz] = perp(d);
  return offs.map((o) => [x + px * o, z + pz * o]);
}
function banksAt(x, z, d, offs) {
  const [px, pz] = perp(d);
  const lo = offs[0] - 1, hi = offs[offs.length - 1] + 1;
  return [[x + px * lo, z + pz * lo], [x + px * hi, z + pz * hi]];
}

/** A polyline (or a hydrology path's cells) as a 4-connected path, without repeats: [[x, z]]. */
export function fourConnected(points) {
  const out = [];
  const push = (x, z) => { const l = out[out.length - 1]; if (!l || l[0] !== x || l[1] !== z) out.push([x, z]); };
  for (let i = 0; i < points.length; i++) {
    const [x, z] = points[i];
    if (!out.length) { push(x, z); continue; }
    let [cx, cz] = out[out.length - 1];
    while (cx !== x || cz !== z) {
      // x first, then z (an L per segment; a diagonal step becomes two)
      if (cx !== x) cx += Math.sign(x - cx); else cz += Math.sign(z - cz);
      push(cx, cz);
    }
  }
  return out;
}

/** Per index: the incoming and outgoing directions (index into DIRS). */
function dirsOf(path) {
  const n = path.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? dirIndex(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]) : -1;
    const b = i < n - 1 ? dirIndex(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]) : -1;
    out.push({ din: a >= 0 ? a : b, dout: b >= 0 ? b : a });
  }
  return out;
}

// ------------------------------------------------------------------ the router (§7.2)

/** A binary min-heap of numbers (priorities that encode the state: deterministic ties). */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(v) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p] <= a[i]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l] < a[m]) m = l; if (r < a.length && a[r] < a[m]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; }
    }
    return top;
  }
}

/**
 * A least-cost course from `starts` to a goal over the survey grid (resolution 1), whose state carries the water level (a move keeps it
 * or lowers it, never raises it). G: {box: {minX, minZ, maxX, maxZ} (every lane and bank cell inside), ok(x, z) (a lane or bank column
 * the course may take), ground(x, z), flow(x, z) (the pass's flow field, 0 when it didn't run)}. starts: [{x, z, d (DIRS index, -1 any),
 * level}]. goal: {test(x, z, d, level) -> bool, box (for the heuristic)}. o: {offs, turn, cut, fill, maxNodes, length}. Returns
 * {path: [[x, z]], levels: [n], ground: [n]} or {fail: kind, nodes}.
 */
export function route(G, starts, goal, o) {
  const B = G.box, W = B.maxX - B.minX + 1, D = B.maxZ - B.minZ + 1;
  let lmin = Infinity, lmax = -Infinity;
  for (const s of starts) { lmin = Math.min(lmin, s.level); lmax = Math.max(lmax, s.level); }
  // levels: the starts' levels down to the lowest ground in the box - 2
  for (let x = B.minX; x <= B.maxX; x++) for (let z = B.minZ; z <= B.maxZ; z++) lmin = Math.min(lmin, G.ground(x, z) - 2);
  const NL = lmax - lmin + 1;
  const key = (x, z, d, l) => (((x - B.minX) * D + (z - B.minZ)) * 4 + d) * NL + (l - lmin);
  const KS = W * D * 4 * NL;
  const unkey = (k) => { const l = k % NL; let r = (k - l) / NL; const d = r % 4; r = (r - d) / 4; const zi = r % D; const xi = (r - zi) / D; return [B.minX + xi, B.minZ + zi, d, l + lmin]; };
  const gs = new Map(), par = new Map(), gr = new Map();
  const heap = new Heap();
  const h = (x, z) => 10 * (Math.max(0, goal.box.minX - x, x - goal.box.maxX) + Math.max(0, goal.box.minZ - z, z - goal.box.maxZ));
  const lanesOk = (x, z, d) => {
    const L = lanesAt(x, z, DIRS[d], o.offs), Bk = banksAt(x, z, DIRS[d], o.offs);
    let gB = Infinity, gT = -Infinity;
    for (const [a, b] of [...L, ...Bk]) {
      if (a < B.minX || a > B.maxX || b < B.minZ || b > B.maxZ || !G.ok(a, b)) return null;
      const g = G.ground(a, b);
      if (g < gB) gB = g;
    }
    for (const [a, b] of L) { const g = G.ground(a, b); if (g > gT) gT = g; }
    return { gB, gT };
  };
  for (const s of starts) {
    for (let d = 0; d < 4; d++) {
      if (s.d >= 0 && d !== s.d) continue;
      const q = lanesOk(s.x, s.z, d);
      if (!q) continue;
      const k = key(s.x, s.z, d, s.level);
      if (gs.has(k)) continue;
      gs.set(k, 0); gr.set(k, q.gB); par.set(k, -1);
      heap.push(h(s.x, s.z) * KS + k);
    }
  }
  let nodes = 0, found = -1, sawGoalCol = false;
  while (heap.size) {
    const v = heap.pop();
    const k = v % KS;
    const f = (v - k) / KS;
    const [x, z, d, l] = unkey(k);
    const g = gs.get(k);
    if (f !== g + h(x, z)) continue;
    if (goal.test(x, z, d, l)) { found = k; break; }
    if (goal.col && goal.col(x, z)) sawGoalCol = true;
    if (++nodes > o.maxNodes) return { fail: 'length', nodes };
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue;
      const nx = x + DIRS[nd][0], nz = z + DIRS[nd][1];
      if (goal.corridor && !goal.corridor(nx, nz)) continue;
      // (a lip's column over a plan body's rim: the level carries onto it, nothing of the course stands there but the lip)
      if (goal.lip && goal.lip(nx, nz)) {
        const nk = key(nx, nz, nd, l), ng = g + 10;
        if (!(gs.has(nk) && gs.get(nk) <= ng)) { gs.set(nk, ng); gr.set(nk, G.ground(nx, nz)); par.set(nk, k); heap.push((ng + h(nx, nz)) * KS + nk); }
        continue;
      }
      const q = lanesOk(nx, nz, nd);
      if (!q) continue;
      const opts = [Math.min(l, q.gB - 1)];
      // (fill: the level held over a dip of at most `fill`: raised banks)
      if (l > q.gB - 1 && l - (q.gB - 1) <= o.fill && opts[0] !== l) opts.push(l);
      for (const nl of opts) {
        const cut = q.gT - 1 - nl;
        if (cut > o.cut) continue;
        const raised = Math.max(0, nl - (q.gB - 1));
        let c = 10 + (nd !== d ? o.turn : 0) + 6 * Math.max(0, cut) + 12 * raised - Math.min(6, G.flow(nx, nz) >> 5);
        if (c < 1) c = 1;
        const nk = key(nx, nz, nd, nl);
        const ng = g + c;
        if (gs.has(nk) && gs.get(nk) <= ng) continue;
        gs.set(nk, ng); gr.set(nk, q.gB); par.set(nk, k);
        heap.push((ng + h(nx, nz)) * KS + nk);
      }
    }
  }
  if (found < 0) return { fail: sawGoalCol ? 'level' : 'blocked', nodes };
  const path = [], levels = [], ground = [];
  for (let k = found; k >= 0; k = par.get(k)) { const [x, z, , l] = unkey(k); path.push([x, z]); levels.push(l); ground.push(gr.get(k)); }
  path.reverse(); levels.reverse(); ground.reverse();
  if (path.length > o.length) return { fail: 'length', nodes, n: path.length };
  return { path, levels, ground, nodes };
}

// ------------------------------------------------------------------ the geometry (plan time, pure over the survey)

/**
 * The course's cells from a path and its levels. `S`: the survey api (groundAt, topAt). `spec`: courseSpec's. `ends`: {head: {kind:
 * 'spring' | 'weir' | 'overflow' | 'plain', weirDir?}, tail: {kind: 'pool' | 'weir' | 'join' | 'rim' | 'plain', lip?: {cells, landing,
 * into, solid, drop}}}. `o`: {id, rng, frozen (a cap on every reach: submerged outlets, no spillway or riffle), minDrop}. Returns the geo
 * {path, levels, prof, reaches: [{k, id, level, cells, raised, outlets, lining, weir, joins, planJoins, solid, notchSkip}], steps:
 * [{kind, from, to, drop, cells}], carve: [[x, z, y0]], banks: [[x, y, z]], lanes} or {refused}.
 */
export function courseGeometry(S, path, routeLevels, spec, ends, o) {
  const n = path.length;
  if (n < 2) return { refused: { code: 'UNREACHABLE', message: 'a course needs at least 2 cells', evidence: { kind: 'length' } } };
  const dirs = dirsOf(path);
  const offs = laneOffsets(spec.width);
  const neckHead = ends.head?.kind === 'overflow', neckTail = ends.tail?.kind === 'rim';
  const lipTail = ends.tail?.kind === 'rim' || ends.tail?.kind === 'join';
  // the last index is the tail's lip (a fall over a rim or into natural water): not part of any reach
  // (a rim fall over a raised body's apron: a lip run of 2, the apron column then the rim column)
  const lipLen = lipTail ? Math.max(1, Math.min(3, ends.tail?.lipLen ?? 1)) : 0;
  const nR = n - lipLen;
  const colsOf = (i) => {
    const o2 = (neckHead && i === 0) || (neckTail && i === nR - 1) ? [0] : offs;
    const set = new Map();
    for (const d of [dirs[i].din, dirs[i].dout]) for (const c of lanesAt(path[i][0], path[i][1], DIRS[d], o2)) set.set(k2(...c), c);
    return [...set.values()];
  };
  const bankOf = (i) => {
    const set = new Map();
    for (const d of [dirs[i].din, dirs[i].dout]) for (const c of banksAt(path[i][0], path[i][1], DIRS[d], offs)) set.set(k2(...c), c);
    return [...set.values()];
  };
  const straight = (i) => {
    const d = dirs[i].dout;
    for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 2); j++) if (dirs[j].din !== d || dirs[j].dout !== d) return false;
    return true;
  };
  const pcols = [];
  for (let i = 0; i < nR; i++) {
    const L = colsOf(i), Bk = bankOf(i);
    let g = Infinity, top = -Infinity;
    for (const [x, z] of [...L, ...Bk]) g = Math.min(g, S.groundAt(x, z));
    for (const [x, z] of L) top = Math.max(top, S.groundAt(x, z));
    pcols.push({ g, top, level: routeLevels[i], straight: straight(i) });
  }
  // the levels never rise, and stand at most `fill` over the ground - 1 the router allowed
  for (let i = 1; i < nR; i++) pcols[i].level = Math.min(pcols[i].level, pcols[i - 1].level);
  const prof = profileOf(pcols, { minReach: PROFILE.minReach, drop: spec.drop, ...(spec.riffleCells ? { riffleCells: spec.riffleCells } : {}), flow: o.frozen && spec.flow === 'riffles' ? 'pools' : spec.flow, riffle: spec.riffle, cut: spec.cut, minDrop: o.minDrop ?? 1 });
  if (prof.refused) return prof;
  // (a frozen course: a spillway's submerged outlet would join two reaches at one level; its upper reach takes the lower level)
  if (o.frozen) {
    for (const st of prof.steps) if (st.drop < 2) return { refused: { code: 'WATER', message: `the biome freezes the course's surface: its outlets are submerged under the ice, so every step needs a drop of at least 2 (a drop of ${st.drop} at reach ${st.k})`, evidence: { kind: 'freezes' } } };
  }
  const ids = prof.reaches.map((r) => reachId(o.id, r.k));
  const stepOfReach = new Map(prof.steps.map((s) => [s.k, s]));
  const reaches = prof.reaches.map((rr, j) => ({ k: rr.k, id: ids[j], level: rr.level, i0: rr.i0, i1: stepOfReach.has(rr.k) ? stepOfReach.get(rr.k).i0 - 1 : rr.i1, cells: [], cols: new Map(), outlets: [], lining: [], weir: [], joins: [], planJoins: [], solid: [], ice: [], raised: false }));
  // the deep rows: a reach after a fall or a riffle keeps its first 3 rows at least 2 deep; the spring and the pool 2 deep
  const owner = new Map(); // column -> reach index
  for (let j = 0; j < reaches.length; j++) {
    const R = reaches[j];
    const after = j > 0;
    let noise = null;
    if (spec.look === 'natural' && o.rng && R.i1 - R.i0 + 1 >= 8) {
      const roll = o.rng();
      noise = roll < 1 / 3 ? null : roll < 2 / 3 ? -1 : 1; // (width by at most 1, on one side, over the reach's middle)
    }
    for (let i = R.i0; i <= R.i1; i++) {
      let depth = spec.depth;
      if (after && i - R.i0 < 3) depth = Math.max(2, depth);
      if (neckTail && i === nR - 1) depth = 1;
      let cols = colsOf(i);
      if (noise && i - R.i0 >= 3 && R.i1 - i >= 2 && pcols[i].straight && !(neckHead && i === 0)) {
        const d = DIRS[dirs[i].dout], [px, pz] = perp(d);
        const o2 = noise < 0 ? offs[0] - 1 : offs[offs.length - 1] + 1;
        const c = [path[i][0] + px * o2, path[i][1] + pz * o2];
        // (the wider lane and its bank where the router could have gone: never toward a lot, a build, water or the claim's edge)
        const bank = [c[0] + px * Math.sign(o2), c[1] + pz * Math.sign(o2)];
        if (S.groundAt(c[0], c[1]) - 1 >= R.level && (!o.okCol || (o.okCol(...c) && o.okCol(...bank)))) cols = [...cols, c];
      }
      if (i === 0 && ends.head?.kind === 'spring') { cols = squareAround(path[0], COURSE.spring, cols); depth = Math.max(2, depth); }
      if (i === nR - 1 && ends.tail?.kind === 'pool') { cols = squareAround(path[i], COURSE.pool, cols); depth = Math.max(2, depth); }
      for (const [x, z] of cols) {
        const kk = k2(x, z);
        if (owner.has(kk)) continue;
        owner.set(kk, j);
        R.cols.set(kk, { x, z, depth });
      }
    }
  }
  // (the row before a tail's lip: 1 deep, whichever index (a turn's) holds its columns)
  if (lipTail) { const R = reaches[reaches.length - 1]; for (const [x, z] of colsOf(nR - 1)) { const c = R.cols.get(k2(x, z)); if (c) c.depth = 1; } }
  // (the spring and the pool may widen a column's ground: a reach stands at most 1 over its lowest bank, else it is raised)
  for (const R of reaches) {
    for (const { x, z, depth } of R.cols.values()) for (let y = R.level - depth + 1; y <= R.level; y++) R.cells.push([x, y, z]);
    sortCells(R.cells);
  }
  // the steps' cells: a fall's or spillway's lip (one row at the upper level), a riffle's stepped run (frozen: the outlet one under the
  // surface, a lining crest over it)
  const steps = [];
  const stepCells = new Map(); // "x,y,z" -> step index
  const openTop = new Map(); // column -> the water's top there (cells over it are the open top)
  for (const R of reaches) for (const { x, z } of R.cols.values()) openTop.set(k2(x, z), R.level);
  for (const st of prof.steps) {
    const up = reaches.find((r) => r.k === st.k), lo = reaches.find((r) => r.k === st.k + 1);
    const cells = [];
    for (let i = st.i0; i <= st.i1; i++) {
      const y = st.levels[i - st.i0] - (o.frozen ? 1 : 0);
      for (const [x, z] of colsOf(i).filter((c) => !owner.has(k2(...c)))) { cells.push([x, y, z]); openTop.set(k2(x, z), Math.max(openTop.get(k2(x, z)) ?? -Infinity, y)); }
    }
    steps.push({ kind: st.kind, from: up.id, to: lo.id, drop: st.drop, cells, seg: st.seg, frozen: !!o.frozen, dir: DIRS[dirs[st.i1].dout] });
    for (const c of cells) stepCells.set(k3(...c), steps.length - 1);
    // the upper reach's outlets: its step's cells beside its own; the lower one's: every cell of the step (its rim over a spillway's lip)
    up.outlets.push(...cells);
    lo.outlets.push(...cells);
    // the landing: the lower reach's first row, its surface cells
    const first = colsOf(lo.i0).filter((c) => lo.cols.has(k2(...c)));
    up.planJoins.push({ body: lo.id, cells: first.map(([x, z]) => [x, lo.level, z]) });
  }
  // the tail's lip (a fall over a plan body's rim, or into natural water)
  if (lipTail) {
    const lp = ends.tail.lip;
    const last = reaches[reaches.length - 1];
    if (!lp || last.level - lp.landY < 1) return { refused: { code: 'WATER', message: `the course's tail stands ${lp ? last.level - lp.landY : '?'} over the water it ends in (a fall needs ${ends.tail.kind === 'rim' ? 2 : 1})`, evidence: { kind: 'join' } } };
    const y = last.level - (o.frozen ? 1 : 0);
    const cells = [];
    for (let i = nR; i < n; i++) cells.push(...(neckTail ? [[path[i][0], y, path[i][1]]] : lanesAt(path[i][0], path[i][1], DIRS[dirs[i].dout], offs).map(([x, z]) => [x, y, z])));
    const lastCells = cells.slice(neckTail ? cells.length - 1 : cells.length - offs.length);
    steps.push({ kind: 'fall', from: last.id, to: lp.into ?? null, drop: last.level - lp.landY, cells, seg: 1, frozen: !!o.frozen, tail: ends.tail.kind, dir: DIRS[dirs[n - 1].dout] });
    // (the body it falls into: everything over its surface is open; its shell is its own)
    for (const [x, z] of lp.open ?? []) if (!openTop.has(k2(x, z))) openTop.set(k2(x, z), lp.landY);
    for (const c of cells) { stepCells.set(k3(...c), steps.length - 1); openTop.set(k2(c[0], c[2]), Math.max(openTop.get(k2(c[0], c[2])) ?? -Infinity, c[1])); }
    last.outlets.push(...cells);
    const landing = lastCells.map(([x, , z]) => [x + DIRS[dirs[n - 1].dout][0], lp.landY, z + DIRS[dirs[n - 1].dout][1]]);
    // (the water it lands in: everything over its surface is the fall's open column)
    for (const [x, , z] of landing) openTop.set(k2(x, z), lp.landY);
    if (lp.into) last.planJoins.push({ body: lp.into, cells: landing });
    else {
      // (a natural join: the landing and the water beside it across the flow, where a breached lip's side would fall: all its sources)
      const d = DIRS[dirs[n - 1].dout];
      const wide = lanesAt(path[n - 1][0] + d[0], path[n - 1][1] + d[1], d, [offs[0] - 1, ...offs, offs[offs.length - 1] + 1]).filter(([x, z]) => !lp.water || lp.water.has(k2(x, z)));
      last.joins.push(...wide.map(([x, z]) => [x, lp.landY, z]));
    }
    last.solid.push(...(lp.solid ?? []));
  }
  // the weir (a head or tail at natural water): one course of `weir` lining beyond the shell, on the bank, the reach's full face
  for (const [end, idx, sgn] of [['head', 0, -1], ['tail', nR - 1, 1]]) {
    if (ends[end]?.kind !== 'weir') continue;
    const R = end === 'head' ? reaches[0] : reaches[reaches.length - 1];
    const d = DIRS[end === 'head' ? dirs[0].dout : dirs[nR - 1].din];
    const [bx, bz] = [path[idx][0] + sgn * 2 * d[0], path[idx][1] + sgn * 2 * d[1]];
    const face = lanesAt(bx, bz, d, [offs[0] - 1, ...offs, offs[offs.length - 1] + 1]);
    for (const [x, z] of face) for (let y = R.level - spec.depth; y <= R.level; y++) R.weir.push([x, y, z]);
  }
  // the lining: every face neighbour (under and beside) of a step's cell that is no water cell, no open top and no reach's shell; a
  // frozen outlet's crest over it
  const shells = new Set();
  for (const R of reaches) for (const c of shellOf(R.cells, { open: R.outlets })) shells.add(k3(...c));
  const water = new Set();
  for (const R of reaches) for (const c of R.cells) water.add(k3(...c));
  const isOpen = (x, y, z) => { const t = openTop.get(k2(x, z)); return t !== undefined && y > t; };
  for (let si = 0; si < steps.length; si++) {
    const st = steps[si];
    const up = reaches.find((r) => r.id === st.from);
    const lin = new Map();
    for (const [x, y, z] of st.cells) {
      for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
        const q = [x + dx, y + dy, z + dz], kk = k3(...q);
        if (water.has(kk) || stepCells.has(kk) || shells.has(kk) || isOpen(...q)) continue;
        // (a cell straight over a lower step cell or reach water in the flow's direction is the fall's column: open)
        lin.set(kk, q);
      }
      if (st.frozen) { const q = [x, y + 1, z]; if (!shells.has(k3(...q))) lin.set(k3(...q), q); }
    }
    // a lip's cells over a plan body's rim: that rim is the body's own (its shell), never this course's lining
    const skip = new Set((st.tail === 'rim' ? ends.tail.lip.solid ?? [] : []).map((c) => k3(...c)));
    up.lining.push(...[...lin.values()].filter((c) => !skip.has(k3(...c))));
  }
  // carve: each reach column from its floor's top up to the column's top; each step cell up; frozen crests stay
  const carve = [];
  for (const R of reaches) for (const { x, z, depth } of R.cols.values()) carve.push([x, z, R.level - depth + 1]);
  for (const st of steps) for (const [x, y, z] of st.cells) carve.push([x, z, y, st.frozen ? y : null]);
  // a riffle's banks are exits all along: the bank over its side lining carved open
  for (const st of steps) {
    if (st.kind !== 'riffle') continue;
    const up = reaches.find((r) => r.id === st.from);
    for (const c of up.lining) if (st.cells.some((s) => s[1] === c[1] && Math.abs(s[0] - c[0]) + Math.abs(s[2] - c[2]) === 1) && !isOpen(c[0], c[1] + 1, c[2])) carve.push([c[0], c[2], c[1] + 1]);
  }
  // raised: a reach whose water stands over the ground beside it (fill): banks 2 thick at the top, the fill under its shell
  const banks = new Map();
  for (const R of reaches) {
    const sh = shellOf(R.cells, { open: R.outlets });
    const own = new Set(R.cells.map((c) => k3(...c)));
    const shSet = new Set(sh.map((c) => k3(...c)));
    for (const [x, y, z] of sh) {
      const g = S.groundAt(x, z);
      if (y > R.level) continue; // (the rim over a side wall: the bank's top course)
      if (y <= g) {
        // a side wall in its own ground but with lower ground right outside it (a bank 1 thick over a dip, a river's edge): a second
        // course of fill outside it, so its single breach meets fill, not air
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const q = [x + dx, y, z + dz], kk = k3(...q);
          if (own.has(kk) || shSet.has(kk) || water.has(kk) || stepCells.has(kk) || openTop.has(k2(q[0], q[2])) || !own.has(k3(x - dx, y, z - dz))) continue;
          const gq = S.groundAt(q[0], q[2]);
          if (gq >= y) continue;
          R.raised = true;
          for (let yy = gq + 1; yy <= y; yy++) banks.set(k3(q[0], yy, q[2]), [q[0], yy, q[2]]);
        }
        continue;
      }
      R.raised = true;
      for (let yy = g + 1; yy < y; yy++) if (!shSet.has(k3(x, yy, z)) && !own.has(k3(x, yy, z))) banks.set(k3(x, yy, z), [x, yy, z]);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const q = [x + dx, y, z + dz], kk = k3(...q);
        if (own.has(kk) || shSet.has(kk) || water.has(kk) || stepCells.has(kk) || openTop.has(k2(q[0], q[2]))) continue;
        for (let yy = S.groundAt(q[0], q[2]) + 1; yy <= y + 1; yy++) banks.set(k3(q[0], yy, q[2]), [q[0], yy, q[2]]);
      }
    }
  }
  // a raised lip (over a dip, or over a body's rim or apron): every lining cell over the ground stands on fill to the ground, and a lining
  // cell beside the lip has a second course outside it, so the single breach of any one lining cell lets no water out
  const stepOf = (c) => stepCells.has(k3(...c));
  const allShell = shells;
  const free = (x, y, z) => { const kk = k3(x, y, z); return !water.has(kk) && !stepCells.has(kk) && !allShell.has(kk) && !isOpen(x, y, z) && !(lipSolid.has(kk)); };
  const lipSolid = new Set([...(ends.tail?.lip?.solid ?? []), ...(ends.tail?.lip?.foreign ?? [])].map((c) => k3(...c)));
  for (const R of reaches) for (const [x, y, z] of R.lining) {
    if (y <= S.groundAt(x, z)) continue;
    for (let yy = S.groundAt(x, z) + 1; yy < y; yy++) if (free(x, yy, z) && !R.lining.some((q) => q[0] === x && q[1] === yy && q[2] === z)) banks.set(k3(x, yy, z), [x, yy, z]);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      // (outward: away from the step cell beside it; and the cell past it along the flow, where a breach would fall)
      if (!stepOf([x - dx, y, z - dz])) continue;
      const st = steps[stepCells.get(k3(x - dx, y, z - dz))];
      const fwd = st?.dir ?? null;
      const qs = [[x + dx, y, z + dz], ...(fwd ? [[x + fwd[0], y, z + fwd[1]], [x + dx + fwd[0], y, z + dz + fwd[1]]] : [])];
      for (const q of qs) {
        if (!free(...q)) continue;
        for (let yy = S.groundAt(q[0], q[2]) + 1; yy <= y; yy++) if (free(q[0], yy, q[2])) banks.set(k3(q[0], yy, q[2]), [q[0], yy, q[2]]);
      }
    }
  }
  return { path, dirs, levels: prof.levels, prof, reaches, steps, carve, banks: [...banks.values()], offs, nR };
}

/** The columns of a side x side square centred on p (odd side), with `cols` kept. */
function squareAround(p, side, cols) {
  const h = side >> 1;
  const m = new Map(cols.map((c) => [k2(...c), c]));
  for (let dx = -h; dx <= h; dx++) for (let dz = -h; dz <= h; dz++) m.set(k2(p[0] + dx, p[1] + dz), [p[0] + dx, p[1] + dz]);
  return [...m.values()];
}

// ------------------------------------------------------------------ materials (§7.3, §11)

/** The course's roles: {bed: [chain], rim, lining, weir} block chains by look (the bible's fluids.lining and fluids.weir when named). */
export function courseMaterials(ctx, look) {
  const all = ctx.roles ?? {};
  const fr = fluidRolesOf(ctx);
  const given = ctx.fluidsGiven ?? {};
  const role = (name) => (typeof name === 'string' && linesBody(all[name]) ? all[name] : null);
  const structure = shellBlock(all, 'structure');
  const foundation = shellBlock(all, 'foundation');
  const weir = role(given.weir) ?? foundation;
  if (look === 'built') {
    const trim = linesBody(fr.coping.block) ? fr.coping.block : structure;
    const lining = role(given.lining) ?? structure;
    return { built: true, bed: [lining, 'minecraft:stone_bricks', 'minecraft:cobblestone'], rim: [trim, structure, 'minecraft:stone_bricks'], lining: [lining, 'minecraft:stone_bricks', 'minecraft:cobblestone'], weir: [weir, structure, 'minecraft:stone_bricks'], bank: 'minecraft:dirt' };
  }
  // natural: a clay and mud bed (the bible's fluids.bed when it names one), mossy banks over the ground
  const bed = given.bed && fr.bed.role === given.bed ? fr.bed.block : null;
  const lining = role(given.lining) ?? bed;
  const rimB = fr.rim.block;
  return { built: false, bed: bed ? [bed, 'minecraft:clay', 'minecraft:mud'] : null, rim: ['minecraft:moss_block', rimB, 'minecraft:coarse_dirt'], lining: lining ? [lining, 'minecraft:clay', 'minecraft:mud'] : null, weir: [weir, structure, 'minecraft:stone_bricks'], bank: 'minecraft:dirt', subsurface: linesBody(all.subsurface) ? all.subsurface : 'minecraft:dirt' };
}

/** A shellRole for r.fluidBody: (x, y, z, where) -> the first block of its chain unlike what stands there. */
function shellRoleOf(M, natural, S) {
  const nameOf = (b) => String(b).replace(/\[.*$/, '');
  const pick = (x, y, z, chain) => { const nv = natural(x, y, z); return chain.find((b) => b && nameOf(b) !== nv) ?? chain[chain.length - 1]; };
  // (natural: clay and mud in patches of 2 x 2 by position, a fixed hash; no random number)
  const patch = (x, z) => ((((x >> 1) * 73856093) ^ ((z >> 1) * 19349663)) >>> 0) % 3 === 0;
  const earth = (x, z) => (patch(x, z) ? ['minecraft:mud', 'minecraft:clay', 'minecraft:packed_mud'] : ['minecraft:clay', 'minecraft:mud', 'minecraft:packed_mud']);
  return (x, y, z, where) => {
    if (where === 'weir') return pick(x, y, z, M.weir);
    if (M.built) return pick(x, y, z, where === 'rim' ? M.rim : M.bed);
    if (where === 'rim') return pick(x, y, z, y >= S.groundAt(x, z) ? M.rim : [M.subsurface, 'minecraft:clay', 'minecraft:mud']);
    if (where === 'lining') return pick(x, y, z, M.lining ?? earth(x, z));
    return pick(x, y, z, M.bed ?? earth(x, z));
  };
}

// ------------------------------------------------------------------ laying it (emit and r.course)

/**
 * Write a course's geometry: the carve and the banks in `stage`, the reaches downstream first (each r.fluidBody: its shell and lining in
 * `stage`, its sources in `fluids`), the exits (notches every 6 on a stream, 12 on a canal), the ice caps. Returns {bodies (head first),
 * steps, notes}.
 */
export function layCourse(r, geo, o) {
  const S = o.survey ?? r.ctx.survey;
  const M = courseMaterials(r.ctx, o.look);
  const stage = o.stage;
  const notes = [];
  // what stands there before the course (the first differing block of each chain): read before its own carve and banks are written
  const all = geo.reaches.flatMap((R) => [...R.cells, ...R.lining, ...R.weir]);
  const xs = all.map((c) => c[0]), ys = all.map((c) => c[1]), zs = all.map((c) => c[2]);
  const natural = naturalOf(r, { minX: Math.min(...xs) - 1, maxX: Math.max(...xs) + 1, minZ: Math.min(...zs) - 1, maxZ: Math.max(...zs) + 1 }, Math.min(...ys) - 2, Math.max(...ys) + 3);
  const shellRole0 = shellRoleOf(M, natural, S);
  const unsafe = o.unsafe ?? {};
  const shellRole = (x, y, z, w) => (unsafe.sandLining && w === 'lining' && unsafe.sandLining[0] === x && unsafe.sandLining[1] === y && unsafe.sandLining[2] === z ? 'minecraft:sand' : shellRole0(x, y, z, w));
  // the exits: notches in the rim, never beside a step, a weir or a landing, never under another reach's shell
  const near = new Set();
  for (const st of geo.steps) for (const [x, , z] of st.cells) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) near.add(k2(x + dx, z + dz));
  for (const R of geo.reaches) for (const [x, , z] of R.weir) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) near.add(k2(x + dx, z + dz));
  for (const R of geo.reaches) for (const q of R.planJoins) for (const [x, , z] of q.cells) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) near.add(k2(x + dx, z + dz));
  for (const kk of o.noNotch ?? []) near.add(kk);
  const every = COURSE[o.look].notch;
  for (const R of geo.reaches) R.exits = o.exits === false ? [] : exitNotches(R.cells, R.level, { every, max: 64, skip: (x, y, z) => near.has(k2(x, z)) });
  // every cell the course's shells, linings and weirs hold (no carve or shaft cuts one)
  const held = new Map();
  for (const R of geo.reaches) for (const c of [...shellOf(R.cells, { open: [...R.outlets, ...R.exits] }), ...R.lining, ...R.weir]) { const kk = k2(c[0], c[2]); const l = held.get(kk) ?? []; l.push(c[1]); held.set(kk, l); }
  for (const R of geo.reaches) R.exits = R.exits.filter(([x, y, z]) => !(held.get(k2(x, z)) ?? []).some((hy) => hy > y));
  // the carve (IF_NATURAL air from each column's floor up to its top), split round held cells
  const carve = [];
  const seen = new Set();
  const runs = [...geo.carve.map(([x, z, y0, y1]) => [x, z, y0, y1 ?? Math.max(y0, S.topAt(x, z))]), ...geo.reaches.flatMap((R) => R.exits.map(([x, y, z]) => [x, z, y, Math.max(y, S.topAt(x, z))]))];
  for (const [x, z, y0, t] of runs) {
    const kk = `${x},${z},${y0}`;
    if (seen.has(kk) || t < y0) continue;
    seen.add(kk);
    const hs = (held.get(k2(x, z)) ?? []).filter((hy) => hy >= y0 && hy <= t).sort((a, b) => a - b);
    let a = y0;
    for (const hy of hs) { if (hy - 1 >= a) carve.push(x, z, a, hy - 1, 0); a = hy + 1; }
    if (t >= a) carve.push(x, z, a, t, 0);
  }
  if (carve.length) { const cp = r.part(`${o.id}_carve`.slice(0, 48), { stage }); cp.columns({ abs: 0 }, { abs: 0 }, carve, [null], { cond: 0 }); (r.meta.parts[cp.id] ??= {}).kind = 'carve'; }
  if (geo.banks.length) {
    const bp = r.part(`${o.id}_banks`.slice(0, 48), { stage });
    const cols = [];
    for (const [x, y, z] of geo.banks) cols.push(x, z, y, y, 0);
    bp.columns({ abs: 0 }, { abs: 0 }, cols, [M.bank], { cond: 0 });
    (r.meta.parts[bp.id] ??= {}).kind = 'add';
    notes.push(`raised banks: ${geo.banks.length} cell(s) of fill (the reach stands over a dip of at most ${o.fill ?? COURSE.fill})`);
  }
  const bodies = [];
  for (const R of [...geo.reaches].reverse()) {
    const exits = R.exits;
    const overflow = R.overflow ?? [];
    const rec = r.fluidBody(R.cells, {
      id: R.id, part: o.part ?? null, kind: o.kind ?? 'course', stage, level: R.level, shellRole, outlets: [...R.outlets, ...exits],
      lining: R.lining, weir: R.weir, joins: [...R.joins, ...R.planJoins], solid: R.solid, ice: R.ice.length ? R.ice : null,
      ...(R.grate?.length ? { grate: R.grate } : {}), ...(overflow.length ? { overflow } : {}), ...(R.raised ? { raised: true } : {}),
      ...(unsafe[R.k] ? { _unsafe: unsafe[R.k] } : {}),
    });
    rec.shellStates = shellStatesOf(rec, shellRole);
    for (const c of rec.lining) rec.shellStates.push(shellRole(c[0], c[1], c[2], R.weir.some((w) => w[0] === c[0] && w[1] === c[1] && w[2] === c[2]) ? 'weir' : 'lining'));
    bodies.unshift(rec);
  }
  return { bodies, notes };
}

// ------------------------------------------------------------------ r.course (a program's course along a path)

/** r.course's implementation: a course along a path (a hydrology path or a polyline) with explicit ends; never throws (refused in the record). */
export function course(r, pathIn, opts = {}) {
  const id = opts.id ?? 'course';
  const rec = { id, part: opts.part ?? null, bodies: [], steps: [], ends: [], refused: null };
  try {
    const pts = Array.isArray(pathIn) ? pathIn : pathIn?.cells;
    if (!Array.isArray(pts) || pts.length < 2) throw refusal('UNREACHABLE', 'r.course: a path of at least 2 cells', { kind: 'length' });
    const path = fourConnected(pts);
    const spec = { ...courseSpec({ look: opts.look, flow: opts.flow, width: opts.width, depth: opts.depth, drop: opts.drop }), riffle: opts.riffle ?? COURSE.riffle, cut: opts.cut ?? COURSE.cut, fill: opts.fill ?? COURSE.fill };
    // (opts.survey: a program that sculpted its own ground first gives the course that ground: {groundAt, topAt})
    const S = opts.survey ?? r.ctx.survey;
    const offs = laneOffsets(spec.width);
    const dirs = dirsOf(path);
    // the levels: the running minimum of the lanes' and banks' ground - 1 (a head at `from.level` when given: a weir head)
    const levels = [];
    let L = opts.from?.level ?? Infinity;
    for (let i = 0; i < path.length; i++) {
      let g = Infinity;
      for (const d of [dirs[i].din, dirs[i].dout]) for (const [x, z] of [...lanesAt(path[i][0], path[i][1], DIRS[d], offs), ...banksAt(path[i][0], path[i][1], DIRS[d], offs)]) g = Math.min(g, S.groundAt(x, z));
      L = Math.min(L, g - 1 + (i === 0 && opts.from?.level !== undefined ? Math.max(0, opts.from.level - (g - 1)) : 0));
      levels.push(L);
    }
    const headKind = opts.from?.kind ?? 'spring', tailKind = opts.to?.kind ?? 'pool';
    const ends = { head: { kind: headKind }, tail: { kind: tailKind, lip: opts.to?.lip ?? null } };
    if (tailKind === 'weir' && opts.to?.level !== undefined) { const lv = opts.to.level; for (let i = 0; i < levels.length; i++) levels[i] = Math.max(Math.min(levels[i], levels[i - 1] ?? Infinity), Math.min(lv, levels[i - 1] ?? Infinity)); }
    const frozen = opts.frozen ?? false;
    const geo = courseGeometry(S, path, levels, spec, ends, { id, rng: r.ctx.rng ? r.ctx.rng(`course:${id}`) : null, frozen });
    if (geo.refused) throw refusal(geo.refused.code, geo.refused.message, geo.refused.evidence);
    if (opts.ice) for (const R of geo.reaches) R.ice = iceOf(r.ctx, R, geo, opts.ice === 'all');
    const m = bodiesMark(r);
    try {
      const out = layCourse(r, geo, { id, part: opts.part ?? null, look: spec.look, stage: opts.stage ?? r.stageList[0], unsafe: opts._unsafe ?? null, exits: opts.exits, survey: S });
      rec.bodies = out.bodies;
    } catch (e) { bodiesRollback(r, m); throw e; }
    rec.steps = geo.steps.map((s) => ({ kind: s.kind, from: s.from, to: s.to, drop: s.drop }));
    rec.ends = [{ end: 'from', kind: headKind, ref: opts.from?.ref ?? rec.bodies[0]?.id ?? null }, { end: 'to', kind: tailKind, ref: opts.to?.ref ?? rec.bodies.at(-1)?.id ?? null }];
    rec.geo = geo;
    (r.meta.courses ??= []).push({ id, part: opts.part ?? id, kind: opts.kind ?? 'course', look: spec.look, flow: spec.flow, bodies: rec.bodies.map((b) => b.id), steps: rec.steps, ends: rec.ends });
  } catch (e) {
    const m = /^([A-Z_]{3,20}): ([\s\S]*)$/.exec(String(e.message));
    rec.refused = { code: m ? m[1] : 'UNREACHABLE', message: m ? m[2] : String(e.message), ...(e.evidence ? { evidence: e.evidence } : {}) };
  }
  return rec;
}

/** A reach's ice cap (R23, §1.7): its open surface cells where the biome freezes, less the landing cells under a step's flow. */
function iceOf(ctx, R, geo, all = false) {
  const own = new Set(R.cells.map((c) => k3(...c)));
  const land = new Set(geo.reaches.flatMap((q) => q.planJoins.flatMap((j) => j.cells.map((c) => k3(...c)))));
  return R.cells.filter(([x, y, z]) => y === R.level && !own.has(k3(x, y + 1, z)) && !land.has(k3(x, y, z)) && (all || freezesAt(ctx, x, y, z).freezes));
}

_bindCourse(course);

// ------------------------------------------------------------------ the plan part (compile steps 2, 3, 6)

/** The plan bodies a part names: its geometry for an overflow or a rim fall ({kind, level, surface: [[x, z]], rim: Map, bodyId, notch}). */
export function planBodyOf(C, X) {
  const q = C.byId?.get?.(X);
  const res = C.res?.get?.(X);
  if (!q || !res || !(res.klass === 'fits' || res.klass === 'adjusted')) return null;
  const S = C.env.S;
  if (q.kind === 'pond' && res.water && res.spec?.fluid === 'water') {
    const shape = res.spec.edge !== 'built' ? 'round' : 'rect';
    const cols = outline(res.water, shape);
    const level = Math.min(...rimColumns(cols).map(([x, z]) => S.groundAt(x, z))) - 1;
    const depth = new Map(cols.map((c) => [k2(c.x, c.z), Math.min(res.spec.depth, c.ring)]));
    // (the pond's exits: emitPond's notches, never an outlet or under a lip)
    const cells = cols.flatMap((c) => { const d = Math.min(res.spec.depth, c.ring), o2 = []; for (let y = level - d + 1; y <= level; y++) o2.push([c.x, y, c.z]); return o2; });
    const notches = new Set(exitNotches(cells, level, { every: 6 }).map(([x, , z]) => k2(x, z)));
    return { kind: 'pond', id: X, bodyId: bodyId(X), level, surface: cols.map((c) => [c.x, c.z]), depth, notches, bodies: [bodyId(X)] };
  }
  if (q.kind === 'fountain' && res.rect) {
    const [cx, cz] = centre(res.rect);
    const h = res.spec.basin >> 1;
    let f = Infinity;
    for (let x = cx - h - 2; x <= cx + h + 2; x++) for (let z = cz - h - 2; z <= cz + h + 2; z++) f = Math.min(f, S.groundAt(x, z));
    const surface = [];
    for (let x = cx - h; x <= cx + h; x++) for (let z = cz - h; z <= cz + h; z++) if (x !== cx || z !== cz) surface.push([x, z]);
    const notches = new Set([k2(cx, cz - h - 1), k2(cx, cz + h + 1)]);
    // (the spout's four falling sides: a course's water landing beside one takes its level from that falling water, as vanilla's
    // flow does, not from its own lip: no landing or outlet beside them)
    const busy = new Set([k2(cx + 1, cz), k2(cx - 1, cz), k2(cx, cz + 1), k2(cx, cz - 1)]);
    return { kind: 'fountain', id: X, bodyId: bodyId(X), level: f + 1, surface, depth: new Map(surface.map((c) => [k2(...c), 1])), notches, busy, raised: true, bodies: [bodyId(X)] };
  }
  if (q.kind === 'channel' && res.T && Number.isInteger(res.ring)) {
    const { water, all } = ringColumns(res.T, res.ring, res.spec.width, res.omit);
    const level = Math.min(...all.map(([x, z]) => S.groundAt(x, z))) - 1;
    const cells = water.flatMap(([x, z]) => { const o2 = []; for (let y = level - res.spec.depth + 1; y <= level; y++) o2.push([x, y, z]); return o2; });
    const notches = new Set(exitNotches(cells, level, { every: 12, max: 256 }).map(([x, , z]) => k2(x, z)));
    return { kind: 'moat', id: X, bodyId: bodyId(X), level, surface: water, depth: new Map(water.map((c) => [k2(...c), res.spec.depth])), notches, bodies: [bodyId(X)] };
  }
  if (res.geo && res.course) {
    // another course (a branch leaves it, or a course falls into one): its reaches' surfaces
    const surface = [], depth = new Map(), lv = new Map(), byCol = new Map();
    for (const R of res.geo.reaches) for (const { x, z, depth: d } of R.cols.values()) { surface.push([x, z]); depth.set(k2(x, z), d); lv.set(k2(x, z), R.level); byCol.set(k2(x, z), R.id); }
    return { kind: 'course', id: X, levels: lv, surface, depth, bodyOf: byCol, bodies: res.geo.reaches.map((R) => R.id), course: true };
  }
  if (res.ditch) {
    const surface = res.ditch.cells.map(([x, , z]) => [x, z]);
    return { kind: 'ditch', id: X, bodyId: res.ditch.id, level: res.ditch.level, surface, depth: new Map(surface.map((c) => [k2(...c), 1])), bodies: [res.ditch.id] };
  }
  return null;
}

/**
 * The edge sites of a plan body for an overflow (from X) or a rim fall (to X): each surface column on X's edge with an outward direction,
 * the cell beside it outside (the outlet column, X's side wall there), X's level at it. Sorted (x, z, d).
 */
function edgeSites(B) {
  const own = new Set(B.surface.map((c) => k2(...c)));
  const out = [];
  for (const [x, z] of B.surface) for (let d = 0; d < 4; d++) {
    const [dx, dz] = DIRS[d];
    const ox = x + dx, oz = z + dz;
    if (own.has(k2(ox, oz))) continue;
    // the outlet's own neighbours across the flow: no other surface cell of X (a straight edge or a corner; never a concave nook)
    const [px, pz] = perp(DIRS[d]);
    if (own.has(k2(ox + px, oz + pz)) || own.has(k2(ox - px, oz - pz))) continue;
    if (B.notches?.has(k2(ox, oz))) continue;
    if (B.busy && [[0, 0], ...DIRS].some(([a, b]) => B.busy.has(k2(x + a, z + b)))) continue;
    const level = B.levels ? B.levels.get(k2(x, z)) : B.level;
    out.push({ x, z, d, ox, oz, level, body: B.bodyOf ? B.bodyOf.get(k2(x, z)) : B.bodyId });
  }
  return out.sort((a, b) => a.ox - b.ox || a.oz - b.oz || a.d - b.d);
}

/** An endpoint's column (anchor, part, region, build) for a dry end, or a point near the feature on the side facing `toward`. */
function endPoint(C, e, toward) {
  const env = C.env;
  // (an anchor in the claim's margin, as Steward's street ends and claim_n..claim_w are: drawn in so the course's banks stay inside it)
  const m = MARGIN + 4, c = env.claim;
  const clamp = (x, z) => [Math.max(c.minX + m, Math.min(c.maxX - m, x)), Math.max(c.minZ + m, Math.min(c.maxZ - m, z))];
  if (e.anchor !== undefined) { const a = env.anchors.get(e.anchor); return a ? { at: clamp(a[0], a[1]) } : { error: { code: 'NO_FEATURE', message: `no anchor ${e.anchor}` } }; }
  let rect = null;
  if (e.part !== undefined) rect = C.geomOf(e.part)?.rect ?? null;
  else if (e.build !== undefined) rect = env.buildRects.find((b) => b.id === e.build)?.rect ?? null;
  else if (e.region !== undefined) rect = env.regions.find((g) => g.id === e.region)?.rect ?? null;
  if (!rect) return { error: { code: 'NO_FEATURE', message: `the course's end ${JSON.stringify(e)} has no geometry`, evidence: { feature: e } } };
  // the point 4 outside the rect on its side facing `toward`
  const [cx, cz] = centre(rect);
  const t = toward ?? [cx, cz];
  const dx = t[0] - cx, dz = t[1] - cz;
  if (Math.abs(dx) >= Math.abs(dz)) return { at: [dx >= 0 ? rect.maxX + 4 : rect.minX - 4, Math.max(rect.minZ, Math.min(rect.maxZ, t[1]))], rect };
  return { at: [Math.max(rect.minX, Math.min(rect.maxX, t[0])), dz >= 0 ? rect.maxZ + 4 : rect.minZ - 4], rect };
}

/** The natural water an end names: {body (compile's water body), level (its surface: the survey's ground there), cells: Set "x,z"}. */
function naturalWater(C, f, toward) {
  const F = featureOf(C.env, f, C.geomOf, toward);
  if (F.error) return { error: F.error };
  if (!F.body) return { error: { code: 'NO_FEATURE', message: 'feature.water names no surveyed water', evidence: { feature: f } } };
  const env = C.env, cols = env.cols, r = cols.resolution;
  const cells = new Set();
  // (the water's level: its columns' most common surface, the lower on a tie: a river's edges and falls stand higher than its surface)
  const count = new Map();
  for (const k of F.body.cells) {
    const i = k % cols.width, j = (k - i) / cols.width;
    for (let a = 0; a < r; a++) for (let b = 0; b < r; b++) cells.add(k2(cols.minX + i * r + a, cols.minZ + j * r + b));
    count.set(cols.ground[k], (count.get(cols.ground[k]) ?? 0) + 1);
  }
  let level = null;
  for (const [g, n] of [...count].sort((a, b) => a[0] - b[0])) if (level === null || n > count.get(level)) level = g;
  return { body: F.body, level, cells, rect: F.rect };
}

/** The router's world for a plan: the claim inside its margin, the columns a course may not take, the flow field. */
function routerWorld(C, p, ends, nearLot = null) {
  const env = C.env, S = env.S;
  const box = grow(env.claim, -MARGIN - 1);
  const blocked = [];
  // keep-out, protected areas, other regions and builds (grown by 1), every lot box grown by 2 (its shell 1 clear of the box + 1)
  for (const h of env.hard) blocked.push(h);
  for (const [zid, rr] of C.res ?? []) {
    const q = C.byId.get(zid);
    if (!q || !C.okClass(zid)) continue;
    // (a race's own lot keeps 2, so its band 4 from the box is free; every other lot 3: a course's single breach stays clear of it)
    for (const l of rr?.layout?.lots ?? []) blocked.push(grow({ minX: l.rect[0], minZ: l.rect[1], maxX: l.rect[2], maxZ: l.rect[3] }, l.spec?.id === nearLot ? 2 : 3));
    // the forms and H bodies placed before it (their footprints), but its own ends
    if ((q.family === 'form' || (q.kind === 'channel' && q.id !== p.id)) && !ends.has(zid)) for (const fp of rr?.footprints ?? []) blocked.push({ minX: fp[0], minZ: fp[1], maxX: fp[2], maxZ: fp[3] });
  }
  for (const lid of C.V?.lotZone?.keys?.() ?? []) { const g = C.geomOf(lid); if (g?.rect) blocked.push(grow(g.rect, lid === nearLot ? 2 : 3)); }
  const flow = env.hydro?.out?.fields?.flow ?? null;
  const ok = (x, z) => {
    if (flagsAt(env, x, z) & (FLAG_WATER | FLAG_LAVA)) return false;
    for (const b of blocked) if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return false;
    return true;
  };
  const memo = new Map();
  const okM = (x, z) => { const kk = (x - box.minX) * 65536 + (z - box.minZ); let v = memo.get(kk); if (v === undefined) { v = ok(x, z); memo.set(kk, v); } return v; };
  return {
    box, ok: okM, ground: (x, z) => S.groundAt(x, z),
    flow: flow ? (x, z) => { const i = Math.floor((x - flow.minX) / flow.res), j = Math.floor((z - flow.minZ) / flow.res); return i >= 0 && j >= 0 && i < flow.width && j < flow.depth ? flow.values[i + j * flow.width] : 0; } : () => 0,
    blocked,
  };
}

/** The level an end stands at (the uphill rule, §7.1): its ground (a dry end), its water's level (natural), its body's level (a plan body). */
function endLevel(C, e, toward) {
  if (e.feature?.water !== undefined) { const w = naturalWater(C, e.feature, toward); return w.error ? null : w.level; }
  if (e.part !== undefined) { const B = planBodyOf(C, e.part); if (B) return B.level ?? Math.max(...B.levels.values()); }
  const pt = endPoint(C, e, toward);
  return pt.error ? null : C.env.S.groundAt(pt.at[0], pt.at[1]);
}

/**
 * Place a course (step 2): its ends, the router (from, through each via, to), the profile and the geometry; register the overflow on the
 * plan body it leaves. Returns H's res with {geo, course: true, spec, ends: [...], overflow?, serves?}.
 */
export function planCourse(C, p, { block = 'channel.course', via = null, race = null, adjust = null } = {}) {
  const env = C.env, part = p.part;
  const spec = courseSpec(part, block);
  const notes = [...spec.notes];
  // (the gate's probe (c), ext 'architect_mc:unsafe' {longRiffle: true}: a riffle past its 16-cell cap, recorded, never a plan's)
  if (part.ext?.['architect_mc:unsafe']?.longRiffle === true) { spec.riffleCells = 32; notes.push('architect_mc:unsafe longRiffle: a riffle past its cap (the gate\'s probe (c))'); }
  const offs = laneOffsets(spec.width);
  const refuse = (code, message, evidence = {}, extra = {}) => ({ klass: code === 'UNSUPPORTED' ? 'unsupported' : 'refused', notes, reasons: [{ code, message, evidence, ...(extra.until ? { until: extra.until, block: extra.block } : {}) }], ...(extra.wouldFit ? { wouldFit: extra.wouldFit } : {}) });
  if (part.fluid === 'lava' || part.params?.fluid === 'lava') return refuse('FIRE', 'lava is allowed only in a lined pit (form.pond, R22): a course holds water', { kind: 'lava' });
  if (!part.from || !part.to) return refuse('UNREACHABLE', 'a course needs both from and to', { kind: 'length' });
  // the ends' points (for the uphill rule and the router's heuristic)
  const ptOf = (e) => (e.anchor !== undefined ? env.anchors.get(e.anchor) ?? null : null);
  const toPt = ptOf(part.to), fromPt = ptOf(part.from);
  // (the ends' levels: a water's surface, a plan body's level, a dry end's ground - 1; a course cuts down to a dry `to` by up to `cut`)
  const lf0 = endLevel(C, part.from, toPt), lt0 = endLevel(C, part.to, fromPt);
  const dryTo = part.to.feature?.water === undefined && !(part.to.part !== undefined && planBodyOf(C, part.to.part));
  const dryFrom = part.from.feature?.water === undefined && !(part.from.part !== undefined && planBodyOf(C, part.from.part));
  const lf = lf0 === null ? null : dryFrom ? lf0 - 1 : lf0, lt = lt0 === null ? null : dryTo ? lt0 - 1 : lt0;
  if (lf !== null && lt !== null && lf < lt - (dryTo && !dryFrom ? spec.cut : 0)) {
    // never swapped silently: the swapped part as the wouldFit, re-checked alone
    const frag = { ...part, from: part.to, to: part.from };
    const again = planCourse(C, { ...p, part: frag }, { block, via, race, adjust });
    const wf = again.klass === 'fits' || again.klass === 'adjusted' ? [{ part: p.id, fragment: frag, geometry: { rect: rectArr(again.rect), reaches: again.geo.reaches.length }, cost: { cells: again.geo.reaches.reduce((a, R) => a + R.cells.length, 0) } }] : undefined;
    return refuse('UNREACHABLE', `from stands at ${lf}, lower than to at ${lt}: a course runs downhill from its head (never swapped silently; the swapped course is the wouldFit)`, { kind: 'uphill', from: lf, to: lt }, { wouldFit: wf });
  }
  // (§7.2) a level canal joins two ends at one level: ends 2 or more apart answer WATER level, the pools course the wouldFit
  if (spec.flow === 'level' && lf !== null && lt !== null && lf - lt >= 2) {
    const frag = { ...part, flow: 'pools' };
    const again = planCourse(C, { ...p, part: frag }, { block, via, race, adjust });
    const wf = again.klass === 'fits' || again.klass === 'adjusted' ? [{ part: p.id, fragment: frag, geometry: { rect: rectArr(again.rect), reaches: again.geo.reaches.length }, cost: { cells: again.geo.reaches.reduce((a, R) => a + R.cells.length, 0) } }] : undefined;
    return refuse('WATER', `a level canal joins ends at one level: from stands at ${lf}, to at ${lt} (flow: pools steps down between them; it is the wouldFit)`, { kind: 'level', from: lf, to: lt }, { wouldFit: wf });
  }
  const ends = new Set([part.from.part, part.to.part, ...(part.via ?? []).map((v) => v.part)].filter(Boolean));
  const G = routerWorld(C, p, ends, race?.lot ?? null);
  const turn = COURSE[spec.look].turn;
  const ro = { offs, turn, cut: spec.cut, fill: spec.fill, maxNodes: COURSE.maxNodes, length: COURSE.limits.length[1] };
  // ---- the head
  const head = { kind: 'spring' }, starts = [];
  let overflow = null, weirW = null;
  const F = part.from;
  if (F.feature?.water !== undefined) {
    const w = naturalWater(C, F.feature, toPt);
    if (w.error) return refuse(w.error.code, w.error.message, w.error.evidence ?? {});
    weirW = w;
    head.kind = 'weir'; head.ref = 'water';
    // a weir head: the reach's first row 3 from the water (the weir and the shell on 2 bank columns), the bank site-solid at the level
    for (const kk of [...w.cells].sort()) {
      const [x, z] = kk.split(',').map(Number);
      for (let d = 0; d < 4; d++) {
        const [dx, dz] = DIRS[d];
        const b1 = [x + dx, z + dz], b2 = [x + 2 * dx, z + 2 * dz], s = [x + 3 * dx, z + 3 * dz];
        if (w.cells.has(k2(...b1))) continue;
        const face = [b1, b2, s].flatMap((c) => lanesAt(c[0], c[1], DIRS[d], [offs[0] - 1, ...offs, offs[offs.length - 1] + 1]));
        if (face.some(([a, b]) => w.cells.has(k2(a, b)) || !G.ok(a, b) || env.S.groundAt(a, b) < w.level || a < G.box.minX || a > G.box.maxX || b < G.box.minZ || b > G.box.maxZ)) continue;
        starts.push({ x: s[0], z: s[1], d, level: w.level });
      }
    }
    if (!starts.length) return refuse('NO_ROOM', `no bank of the water 2 cells thick and solid at its level ${w.level} for a weir (a weir stands only on site-solid bank cells, never in the water)`, { kind: 'weir', level: w.level });
  } else if (F.part !== undefined && planBodyOf(C, F.part)) {
    // an overflow from X: a side shell cell at X's surface opened; the head's first row (one lane) beside it, a drop of at least 1
    const B = planBodyOf(C, F.part);
    head.kind = 'overflow'; head.ref = F.part; head.B = B;
    for (const s of edgeSites(B)) {
      const [dx, dz] = DIRS[s.d];
      const hx = s.ox + dx, hz = s.oz + dz;
      if (!G.ok(hx, hz) || !G.ok(s.ox, s.oz)) continue;
      const g = env.S.groundAt(hx, hz);
      // (the head's shell at the outlet's column stays clear of X's side walls under the outlet: X's depth there)
      const dX = B.depth.get(k2(s.x, s.z)) ?? 1;
      starts.push({ x: hx, z: hz, d: s.d, level: Math.min(dX <= 1 ? s.level - 1 : s.level - dX - 1, g - 1), site: s });
    }
    if (!starts.length) return refuse('NO_ROOM', `${F.part} has no straight edge clear of the plan for an overflow`, { kind: 'overflow', part: F.part });
  } else {
    const pt = endPoint(C, F, toPt);
    if (pt.error) return refuse(pt.error.code, pt.error.message, pt.error.evidence ?? {});
    head.ref = F.anchor ?? F.part ?? F.build ?? F.region ?? null;
    starts.push({ x: pt.at[0], z: pt.at[1], d: -1, level: env.S.groundAt(pt.at[0], pt.at[1]) - 1 });
  }
  // ---- the tail
  const T = part.to;
  const tail = { kind: 'pool' };
  let goal;
  if (T.feature?.water !== undefined) {
    const w = naturalWater(C, T.feature, fromPt);
    if (w.error) return refuse(w.error.code, w.error.message, w.error.evidence ?? {});
    tail.kind = 'join'; tail.ref = 'water'; tail.W = w;
    // a fall join: the lip on the bank beside the water, the water at least 2 deep; or a weir tail at the water's level 3 from it
    const deep = (x, z) => w.cells.has(k2(x, z)) && env.S.floorAt(x, z) <= w.level - 2;
    goal = {
      box: w.rect,
      col: (x, z) => [0, 1, 2, 3].some((d) => w.cells.has(k2(x + DIRS[d][0], z + DIRS[d][1]))),
      test: (x, z, d, l) => {
        const [dx, dz] = DIRS[d];
        const L = lanesAt(x + dx, z + dz, DIRS[d], offs);
        if (l >= w.level + 1 && L.every(([a, b]) => deep(a, b))) return true;
        // weir tail: two bank columns, then the water
        const b1 = lanesAt(x + 2 * dx, z + 2 * dz, DIRS[d], offs), wcol = lanesAt(x + 3 * dx, z + 3 * dz, DIRS[d], offs);
        return l === w.level && L.every(([a, b]) => !w.cells.has(k2(a, b)) && env.S.groundAt(a, b) >= w.level) && b1.every(([a, b]) => !w.cells.has(k2(a, b)) && env.S.groundAt(a, b) >= w.level) && wcol.every(([a, b]) => w.cells.has(k2(a, b)));
      },
    };
  } else if (T.part !== undefined && planBodyOf(C, T.part)) {
    const B = planBodyOf(C, T.part);
    tail.kind = 'rim'; tail.ref = T.part; tail.B = B;
    const sites = edgeSites(B);
    const at = new Map(sites.map((s) => [k2(s.ox, s.oz), s]));
    // (a raised body, a fountain: its apron, the column outside its rim, may carry the lip too)
    // (and the cell past it: a raised body keeps a cell of level ground round its site)
    const apron = new Set(B.raised ? sites.flatMap((s) => [1, 2].map((t) => k2(s.ox + t * DIRS[s.d][0], s.oz + t * DIRS[s.d][1]))).filter((kk) => !at.has(kk)) : []);
    const bb = sites.length ? { minX: Math.min(...sites.map((s) => s.ox)), maxX: Math.max(...sites.map((s) => s.ox)), minZ: Math.min(...sites.map((s) => s.oz)), maxZ: Math.max(...sites.map((s) => s.oz)) } : env.claim;
    // the lip stands on X's rim column (the path's last index), the flow into X, the tail's level at least 2 over X's
    goal = {
      box: bb, col: (x, z) => at.has(k2(x, z)), lip: (x, z) => at.has(k2(x, z)) || apron.has(k2(x, z)),
      test: (x, z, d, l) => { const s = at.get(k2(x, z)); return !!s && (s.d + 2) % 4 === d && l >= s.level + 2; },
    };
  } else {
    const pt = endPoint(C, T, fromPt ?? (starts[0] ? [starts[0].x, starts[0].z] : null));
    if (pt.error) return refuse(pt.error.code, pt.error.message, pt.error.evidence ?? {});
    tail.ref = T.anchor ?? T.part ?? T.build ?? T.region ?? null;
    goal = { box: { minX: pt.at[0], maxX: pt.at[0], minZ: pt.at[1], maxZ: pt.at[1] }, col: (x, z) => x === pt.at[0] && z === pt.at[1], test: (x, z) => x === pt.at[0] && z === pt.at[1] };
  }
  // ---- the router, leg by leg (through each via; a race's via is its lot, handled by race.mjs as a waypoint)
  // (a course's own via: each a point the course passes (an anchor, or beside a part, a build or a region); a race's is its lot's side)
  const ownVia = [];
  if (!via) for (const v of part.via ?? []) {
    if (v.feature !== undefined) return refuse('UNREACHABLE', 'a course passes no water on its way (via names a feature): end it there instead', { kind: 'blocked', via: v });
    const pt = endPoint(C, v, toPt);
    if (pt.error) return refuse(pt.error.code, pt.error.message, pt.error.evidence ?? {});
    ownVia.push({ box: { minX: pt.at[0], maxX: pt.at[0], minZ: pt.at[1], maxZ: pt.at[1] }, col: (x, z) => x === pt.at[0] && z === pt.at[1], test: (x, z) => x === pt.at[0] && z === pt.at[1] });
  }
  const legs = [...(via ?? ownVia)];
  let cur = starts;
  const full = { path: [], levels: [] };
  for (let li = 0; li <= legs.length; li++) {
    const g = li < legs.length ? legs[li] : goal;
    const rr = route(G, cur, g, ro);
    if (rr.fail) {
      // why: a valley past fill (an aqueduct), a cut too deep, a wall, else unreachable
      if (rr.fail === 'level' || rr.fail === 'blocked') {
        const deep = route(G, cur, g, { ...ro, fill: 64, maxNodes: 200000 });
        // ((S-T3-4's way, as tunnel.under) the answer names the shape it needs: channel.aqueduct, reserved until 7c)
        if (!deep.fail) p.block = 'channel.aqueduct';
        if (!deep.fail) return refuse('UNSUPPORTED', `the course crosses low ground deeper than its fill (${spec.fill}): it needs an aqueduct (channel.aqueduct, reserved until 7c)`, { kind: 'fill', block: 'channel.aqueduct', until: '7c' }, { until: '7c', block: 'channel.aqueduct' });
        const cutAny = route(G, cur, g, { ...ro, cut: 64, maxNodes: 200000 });
        if (!cutAny.fail) return refuse('UNREACHABLE', `the course would cut deeper than ${spec.cut} under the ground to reach its end`, { kind: 'cut', limit: spec.cut });
        if (tail.kind === 'join' && li === legs.length) return refuse('WATER', `the course reaches ${part.to.feature ? 'the water' : 'its end'} with no drop left and no bank for a weir`, { kind: 'join' });
        if (tail.kind === 'rim' && li === legs.length) {
          const wf = [{ part: p.id, fragment: { ...part, to: { anchor: 'claim_center' } }, notes: [`a terminal pool beside ${part.to.part} (re-check it alone with an anchor beside it)`] }];
          return refuse('WATER', `the course can't reach ${part.to.part} at least 2 over its water (a fall over its rim): it ends lower than ${tail.B.level + 2}`, { kind: 'join', part: part.to.part, level: tail.B.level }, { wouldFit: wf });
        }
      }
      if (rr.fail === 'length') return refuse('UNREACHABLE', `no course within ${COURSE.limits.length[1]} cells (${rr.nodes} states searched)`, { kind: 'length' });
      return refuse('UNREACHABLE', 'no course clear of the lots, builds, protected areas, keep-out, other regions and water between its ends', { kind: 'blocked' });
    }
    if (full.path.length) { rr.path.shift(); rr.levels.shift(); }
    full.path.push(...rr.path); full.levels.push(...rr.levels);
    const e = rr.path.length ? rr.path[rr.path.length - 1] : full.path[full.path.length - 1];
    const ld = full.path.length > 1 ? dirIndex(e[0] - full.path[full.path.length - 2][0], e[1] - full.path[full.path.length - 2][1]) : -1;
    cur = [{ x: e[0], z: e[1], d: ld, level: full.levels[full.levels.length - 1] }];
  }
  if (full.path.length - 1 > COURSE.limits.length[1]) return refuse('UNREACHABLE', `the course is ${full.path.length} cells (at most ${COURSE.limits.length[1]})`, { kind: 'length', cells: full.path.length });
  if (full.path.length < COURSE.limits.length[0]) return refuse('UNREACHABLE', `the course is ${full.path.length} cells (at least ${COURSE.limits.length[0]})`, { kind: 'length', cells: full.path.length });
  // ---- the tail's lip and level for natural and plan-body ends
  const n = full.path.length;
  const dEnd = n > 1 ? dirIndex(full.path[n - 1][0] - full.path[n - 2][0], full.path[n - 1][1] - full.path[n - 2][1]) : 0;
  if (tail.kind === 'join') {
    const [x, z] = full.path[n - 1];
    const [dx, dz] = DIRS[dEnd];
    const fallJoin = lanesAt(x + dx, z + dz, DIRS[dEnd], offs).every(([a, b]) => tail.W.cells.has(k2(a, b)));
    if (fallJoin) {
      // the path's last index (the bank beside the water) is the lip; the landing the water's sources
      tail.lip = { landY: tail.W.level, into: null, solid: [], water: tail.W.cells };
      tail.kind = 'join';
    } else { tail.kind = 'weir'; }
  }
  if (tail.kind === 'rim') {
    const s = edgeSites(tail.B).find((q) => q.ox === full.path[n - 1][0] && q.oz === full.path[n - 1][1] && (q.d + 2) % 4 === dEnd);
    // X's rim under the lip (its shell; the course writes nothing there), the landing X's surface cell
    // (X's cells and shell, as its generator writes them less its outlets: the course writes none of them)
    const xCells = tail.B.surface.flatMap(([x, z]) => { const d = tail.B.depth.get(k2(x, z)) ?? 1, lv = tail.B.levels ? tail.B.levels.get(k2(x, z)) : tail.B.level, o2 = []; for (let y = lv - d + 1; y <= lv; y++) o2.push([x, y, z]); return o2; });
    tail.lip = { landY: s.level, into: s.body, solid: [[s.ox, s.level + 1, s.oz]], open: tail.B.surface, foreign: shellOf(xCells) };
    let ll = 1;
    if (tail.B.raised) for (let t = 1; t <= 2 && n - 1 - t > 0; t++) if (full.path[n - 1 - t][0] === s.ox + t * DIRS[s.d][0] && full.path[n - 1 - t][1] === s.oz + t * DIRS[s.d][1]) ll = t + 1; else break;
    tail.lipLen = ll;
    tail.site = s;
  }
  // (a race: the wheel fall forced beside its lot)
  if (adjust) { const a = adjust(full); if (a?.refused) return refuse(a.refused.code, a.refused.message, a.refused.evidence ?? {}, a.refused.extra ?? {}); }
  const frozen = surfaceFreezesAlong(C.ctx, full.path, full.levels);
  const rng = C.ctx.rng ? C.ctx.rng(`course:${p.id}`) : null;
  const geo = courseGeometry(env.S, full.path, full.levels, spec, { head, tail }, { id: p.id, rng, frozen, okCol: (x, z) => x >= G.box.minX && x <= G.box.maxX && z >= G.box.minZ && z <= G.box.maxZ && G.ok(x, z) });
  if (geo.refused) return refuse(geo.refused.code, geo.refused.message, geo.refused.evidence ?? {});
  // the head's overflow from X: X's side shell cell at its level opened, its spillway's lining X's own (less the head's shell)
  if (head.kind === 'overflow') {
    const s = starts.find((q) => q.x === full.path[0][0] && q.z === full.path[0][1])?.site;
    if (!s) return refuse('NO_ROOM', `no overflow site of ${head.ref} at the course's head`, { kind: 'overflow' });
    const H = geo.reaches[0];
    if (s.level - H.level < 1) return refuse('WATER', `the head stands ${s.level - H.level} under ${head.ref}'s water (an overflow falls at least 1)`, { kind: 'join', part: head.ref });
    const O = [s.ox, s.level, s.oz];
    H.outlets.push(O);
    const headShell = new Set(shellOf(H.cells, { open: H.outlets }).map((c) => k3(...c)));
    const [px, pz] = perp(DIRS[s.d]);
    const lining = [[s.ox, s.level - 1, s.oz], [s.ox + px, s.level, s.oz + pz], [s.ox - px, s.level, s.oz - pz]].filter((c) => !headShell.has(k3(...c)));
    overflow = { from: head.ref, course: p.id, cells: [O], lining, into: { body: H.id, cells: [[full.path[0][0], H.level, full.path[0][1]]] }, site: s };
    // (the outlet and the cells over it are open: the course carves them, X writes nothing there)
    geo.carve.push([s.ox, s.oz, s.level]);
    if (!registerOverflow(C, overflow)) { head.kind = 'spring'; overflow = null; notes.push(`${part.from.part} takes no overflow: the head is a spring`); }
  }
  const allCells = geo.reaches.flatMap((R) => R.cells);
  const xs = allCells.map((c) => c[0]), zs = allCells.map((c) => c[2]);
  const rect = { minX: Math.min(...xs) - 2, minZ: Math.min(...zs) - 2, maxX: Math.max(...xs) + 2, maxZ: Math.max(...zs) + 2 };
  // the footprints later zones and forms keep off: each reach's columns grown by 2
  const fps = geo.reaches.map((R) => { const cs = [...R.cols.values()]; return [Math.min(...cs.map((c) => c.x)) - 2, Math.min(...cs.map((c) => c.z)) - 2, Math.max(...cs.map((c) => c.x)) + 2, Math.max(...cs.map((c) => c.z)) + 2]; });
  if (weirW) notes.push(`a weir head at the water's level ${weirW.level}: a weir 2 thick on the bank (S-HY-5: visible)`);
  if (frozen) notes.push('the biome freezes the course: every reach capped with ice, its outlets submerged under a lining crest (§1.7)');
  return { klass: 'fits', rect, footprints: fps, notes, reasons: [], spec, geo, course: true, ends: { head, tail }, overflow, frozen, race };
}

/** Whether the biome freezes any reach surface along the path (R23): the course is then capped (§1.7). */
function surfaceFreezesAlong(ctx, path, levels) {
  for (let i = 0; i < path.length; i++) if (freezesAt(ctx, path[i][0], levels[i], path[i][1]).freezes) return true;
  return false;
}

/** Place the part (compile step 2). */
export function resolve(C, p) {
  return planCourse(C, p);
}

/** The overflows registered on this course (a branch leaves it): each passed to the reach whose shell holds its outlet. */
function branchOverflows(K, p, geo) {
  const ov = overflowsOn(K, p.id);
  for (const R of geo.reaches) R.overflow = [];
  for (const o of ov) {
    const R = geo.reaches.find((q) => q.id === o.from || o.cells.some((c) => q.cells.some((b) => Math.abs(b[0] - c[0]) + Math.abs(b[2] - c[2]) === 1 && b[1] === c[1])));
    if (R) R.overflow.push({ cells: o.cells, lining: o.lining, into: o.into });
  }
}

/** Write the part (compile step 3): the reaches downstream first; LEAK when a reach's reach meets what it may not. */
export function emit(K, p, res) {
  const r = K.r, env = K.env;
  const geo = res.geo;
  const m = bodiesMark(r);
  try {
    branchOverflows(K, p, geo);
    // (HY-c, joined at the batch) the water gates (§8.3): each reach meeting a planned wall registers its crossing (gate.mjs waterGate:
    // the wall's checks, the still reach, no step within 2 of it; it throws UNREACHABLE {kind: wall, why} to refuse the course) and takes
    // the grate, the reach's own cells in the wall's thickness, written behind iron bars. No exit notch is cut within 2 of a crossing.
    const noNotch = new Set();
    for (const R of geo.reaches) {
      R.grate = [];
      const wg = waterGate(K, { course: p.id, body: R.id, cells: R.cells, level: R.level, outlets: R.outlets, lining: [...R.lining, ...R.weir] });
      if (wg.grate.length) R.grate.push(...wg.grate);
      for (const x of wg.crossings) {
        const [nx, nz] = x.normal ?? [0, 0];
        for (const [cx, cz] of x.cells) for (let k = -3; k <= 3; k++) for (let s = -1; s <= 1; s++) noNotch.add(k2(cx + nx * k + nz * s, cz + nz * k + nx * s));
      }
    }
    // (the gate's uncapped twin, ext 'architect_mc:unsafe' {noCap: true}: a frozen course left open, its outlets still submerged: the
    // freezing probe, dev only, never a plan's)
    const noCap = p.part.ext?.['architect_mc:unsafe']?.noCap === true;
    if (res.frozen && !noCap) for (const R of geo.reaches) R.ice = iceOf(K.ctx, R, geo, false);
    // (§8.3) a wall standing on the course's columns: a water gate (HY-c's crossing), else UNREACHABLE wall
    if (K.walls?.length) {
      const cols = new Set();
      for (const R of geo.reaches) for (const { x, z } of R.cols.values()) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) cols.add(k2(x + dx, z + dz));
      for (const st of geo.steps) for (const [x, , z] of st.cells) cols.add(k2(x, z));
      const crossed = new Set(crossingsOf(K).filter((x) => x.course === p.id).map((x) => x.wall));
      for (const W of K.walls) {
        if (crossed.has(W.id)) continue;
        const c = W.cells.find((q) => cols.has(k2(q.x, q.z)));
        if (c) throw refusal('UNREACHABLE', `wall ${W.id} stands across the course at ${c.x} ${c.z} (a course crosses a wall only under a water gate)`, { kind: 'wall', wall: W.id, at: [c.x, c.z] });
      }
    }
    const unsafe = p.part.ext?.['architect_mc:unsafe']?.course ?? null;
    const out = layCourse(r, geo, { id: p.id, part: p.id, look: res.spec.look, stage: K.stageOf('forms'), unsafe, fill: res.spec.fill, noNotch });
    const vk = volumeKeep(r, VC, classAt);
    for (const b of out.bodies) {
      const hit = reachMeetsKeep(r, env, b, { volClass: vk });
      if (hit) throw leakRefusal(b, hit);
      shellCheck(r, b);
    }
    // (§1.6) the head's or the tail's reach beside natural water
    if (res.ends.head.kind === 'weir') flowingCheck(r, out.bodies[0]);
    if (['weir', 'join'].includes(res.ends.tail.kind)) flowingCheck(r, out.bodies[out.bodies.length - 1]);
    const gates = crossingsOf(K).filter((x) => x.course === p.id);
    res.emitted = { bodies: out.bodies, notes: out.notes, waterGates: gates.map((x) => ({ wall: x.wall, cells: x.cells.length, lintel: x.lintel, grate: x.grate.length })) };
    const kind = res.race ? 'race' : 'course';
    (r.meta.courses ??= []).push({ id: p.id, part: p.id, kind, look: res.spec.look, flow: res.spec.flow, bodies: out.bodies.map((b) => b.id),
      steps: geo.steps.map((s) => ({ kind: s.kind, from: s.from, to: s.to ?? (res.ends.tail.kind === 'join' ? 'water' : null), drop: s.drop })),
      ends: endsRow(res), ...(res.race ? { serves: res.race.serves } : {}), ...(gates.length ? { waterGates: [...new Set(gates.map((x) => x.wall))] } : {}) });
  } catch (e) {
    bodiesRollback(r, m);
    if (r.meta.courses) { r.meta.courses = r.meta.courses.filter((c) => c.part !== p.id); if (!r.meta.courses.length) delete r.meta.courses; }
    throw e;
  }
}

/** The ends row of siteplan's courses (§12): [{end, kind: spring | pool | weir | join | overflow | rim, ref}]. */
function endsRow(res) {
  const h = res.ends.head, t = res.ends.tail;
  return [{ end: 'from', kind: h.kind === 'plain' ? 'spring' : h.kind, ref: h.ref ?? null }, { end: 'to', kind: t.kind === 'plain' ? 'pool' : t.kind, ref: t.ref ?? null }];
}

/** §1.6: natural water at a weir or a join holds no flowing or falling natural water within the body's watch box: else WATER flowing. */
function flowingCheck(r, b) {
  if (b.volumeState !== 'given') return;
  const cells = [...b.cells, ...b.shell, ...b.spill, ...b.watch];
  const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]), zs = cells.map((c) => c[2]);
  const box = { minX: Math.min(...xs) - 2, maxX: Math.max(...xs) + 2, minZ: Math.min(...zs) - 2, maxZ: Math.max(...zs) + 2, minY: Math.min(...ys) - 2, maxY: Math.max(...ys) + 2 };
  const lw = localWorld(r, box);
  for (let x = box.minX; x <= box.maxX; x++) for (let z = box.minZ; z <= box.maxZ; z++) for (let y = box.minY; y <= box.maxY; y++) {
    if (lw.at(x, y, z) === 'flowing_water') throw refusal('WATER', `body ${b.id}: natural flowing water at ${x} ${y} ${z} within its watch box (a weir or a join stands only by still natural sources, §1.6)`, { kind: 'flowing', body: b.id, at: [x, y, z] });
  }
}

/** The part's answer fields: the bodies (one per reach), the steps and the ends, the volume answer first. */
export function answer(K, p, res) {
  const e = res.emitted;
  if (!e) return null;
  const vol = volumeAnswer(K.r, e.bodies);
  if (vol) return vol;
  const geo = res.geo;
  const extra = { block: res.spec.block, look: res.spec.look, flow: res.spec.flow, width: res.spec.width, depth: res.spec.depth,
    steps: geo.steps.map((s) => ({ kind: s.kind, from: s.from, to: s.to, drop: s.drop })), ends: endsRow(res), length: geo.path.length,
    ...(res.race ? { serves: res.race.serves } : {}), ...(e.waterGates?.length ? { waterGates: e.waterGates } : {}) };
  const notes = [...(res.notes ?? []), ...e.notes];
  if (res.race) notes.push(res.race.note);
  return bodyAnswer(K, p, e.bodies, { rect: res.rect, notes, extra });
}

void meets; void rectArr; void channelBlockOf; void sortCells; void un3;
