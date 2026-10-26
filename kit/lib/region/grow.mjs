// (6d GR, docs/CONTRACT.md "Phase 6d slice GR" §2-§6) Growing a standing region: new lots on the free frontage of its standing streets,
// then on one straight extension from a street end nobody uses, as one additive revision (RV). Read from the effective IR only (the plan's
// meta isn't kept), the frozen heights (the revision's survey) and ctx.standing (the held set, the beside regions' reach and hold, the
// owner's areas). Standing lots, streets, junctions and verges never move and are never written.
//
//   streetRuns(eff)                     the standing street runs (axis-aligned road segments of a street road), by district
//   extendableEnds(eff, st, runs, ...)  §4.1: the terminal street ends a growth may extend, each with why not when it can't
//   growPlan(ctx)                       §2: the search (frontage slots cheapest first, then one extension); pure, deterministic
//   emitGrowth(r, plan, o)              §3, §4, §6: the parts, lots, road, graph nodes and edges into the revision program
//   graphCut(ir)                        lot nodes not reachable from the plaza over the IR's edges (item 3's graph.cut)
//
// Geometry (a run's own frame, village.mjs): the street runs along `u`, its centre line at `v = c`; its footprint is |v - c| <= 2 (road 3
// plus a verge each side). A frontage lot stands with its front edge on `v = c + s (2 + 1 + L)` (L = FRONT_LANE, the lane's length): its pad's
// batter (PAD_MAX) then stays off the verge row, and its lane (L cells) ends on the row next to the verge, never on it. An extension's lots
// stand as V's do (their front on the new verge row: the new street is the growth's own).
import { COND } from './program.mjs';
import { STREET_RULES, PAD_MAX, toWorld, toLocal, frontOf, rectWorld, surfaceOps, lane } from './village.mjs';
import { columnProblem, standingClasses, ridPrefix } from './revise.mjs';
import { isStreetId, runKeys } from './beside.mjs';
import { fixtureFor, fixtureCells, roadLamp } from './fixtures.mjs';
import { traceBoundary, normalAt } from './boundary.mjs';
import { followLots, smoothLine, maskRuns, FOLLOW_PAD } from './followEmit.mjs';
import { FLAG_WATER, FLAG_LAVA, FLAG_MISSING } from './pack.mjs';

export const GROW_FORMAT = 'grow/1';
/** A frontage lot's lane length (the rows between the verge row and its front edge): the pad's batter (PAD_MAX) plus one stays off the verge. */
export const FRONT_LANE = PAD_MAX + 1;
/** Frontage slots are tried every SLOT_STEP cells along a run (§3). */
export const SLOT_STEP = 2;
/** §4.1: an end's past-end cell lies at least END_ROOM cells inside the claim margin; its past-end cell and the 3 past it are clear, 5 wide. */
export const END_ROOM = 9, END_CLEAR = 4;
/** §4.2: the extension runs 4 past its last lot; at most one extension per growth. */
export const PAST_LAST = 4;
/** §3: a new lot's lamp skips spots within 6 of a standing lamp (N-D3-2's rule). */
export const LAMP_GAP = 6;
/** §2.4: FL rings, spirals and organic layouts grow on straight runs of at least 9. */
export const MIN_RUN = 9;

const k2 = (x, z) => `${x},${z}`;
const rectsMeet = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const growR = (r, m) => [r[0] - m, r[1] - m, r[2] + m, r[3] + m];
const rectKeys = (r, into = new Set()) => { for (let z = r[1]; z <= r[3]; z++) for (let x = r[0]; x <= r[2]; x++) into.add(k2(x, z)); return into; };
const orderOf = (s) => (s.placement === 'central' ? 0 : s.landmark ? 1 : s.placement === 'edge' ? 3 : 2);
const ID = /^[a-z][a-z0-9_]{0,47}$/;

/** The district a street road belongs to: its `architect_mc:street` flag's, else the prefix before `street_` (`east_street_w` -> east). */
function districtOfRoad(rd) {
  const f = rd.ext?.['architect_mc:street'];
  if (f && typeof f.district === 'string') return f.district;
  const m = /^(.*?)_?street_[a-z0-9_]*$/.exec(rd.id);
  return m && m[1] ? m[1] : null;
}

/**
 * The standing street runs of an effective IR: every straight, axis-aligned segment of a street road (flagged `architect_mc:street`, or the
 * `street_` stem; never a route or a following street `st_`), at least MIN_RUN long. `{road, seg, o, c, u0, u1, y, width, lanterns, lamp,
 * surface, ext, district, prefix, twoPoint, grown}` (`o` 'ew' when the run is along x). Sorted by road id, then segment.
 */
export function streetRuns(eff) {
  const out = [];
  for (const rd of eff.roads ?? []) {
    const flagged = !!rd.ext?.['architect_mc:street'];
    if (!flagged && !isStreetId(rd.id)) continue;
    // (§5, GR-b) a following district's street, `route_st_<d>_<n>` (a T2 route): frontage on its straight runs, no §4 extension
    const fm = /^route_st_([a-z][a-z0-9_]*?)_\d+$/.exec(rd.id);
    if (!fm && (/^(route_)?st_/.test(rd.id) || /^route_/.test(rd.id))) continue;
    const pts = rd.points ?? [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      let o;
      if (a[2] === b[2] && a[0] !== b[0]) o = 'ew'; else if (a[0] === b[0] && a[2] !== b[2]) o = 'ns'; else continue;
      const [ua, c] = toLocal(o, a[0], a[2]), [ub] = toLocal(o, b[0], b[2]);
      const u0 = Math.min(ua, ub), u1 = Math.max(ua, ub);
      if (u1 - u0 + 1 < MIN_RUN && pts.length > 2) continue;
      if (fm && u1 - u0 + 1 < MIN_RUN) continue;
      const d = fm ? fm[1] : districtOfRoad(rd);
      out.push({ road: rd.id, seg: i, o, c, u0, u1, y: a[1] ?? b[1] ?? null, width: rd.width ?? 3, lanterns: rd.lanterns !== false, lamp: rd.lamp ?? null, surface: rd.surface ?? null,
        ext: rd.ext ?? null, district: d, prefix: d ? `${d}_` : '', twoPoint: pts.length === 2 && !fm, follow: !!fm, grown: Number.isInteger(rd.rid) && rd.rid > 0 });
    }
  }
  return out.sort((p, q) => (p.road < q.road ? -1 : p.road > q.road ? 1 : p.seg - q.seg));
}

/** The graph's adjacency (node id -> [{edge, other}]) over every edge; an external end (`<region>:...`) counts as the edge's other end. */
function adjacency(graph) {
  const adj = new Map();
  const add = (n, e, o) => { if (!adj.has(n)) adj.set(n, []); adj.get(n).push({ edge: e, other: o }); };
  for (const e of graph?.edges ?? []) {
    const a = String(e.from).split('.')[0], b = String(e.to).split('.')[0];
    add(a, e, b); add(b, e, a);
  }
  return adj;
}

/** The plaza node of a run (its district's `<d>_plaza`, the town's `plaza`), or null. */
function plazaOf(eff, run) {
  const nodes = eff.graph?.nodes ?? [];
  return nodes.find((n) => n.id === `${run.prefix}plaza`) ?? (run.prefix ? null : nodes.find((n) => n.kind === 'plaza')) ?? null;
}

/**
 * The obstacle reader of a growth: the standing classes (RV §5.3: lots + 1, roads + 1, paths and ways, bodies, beside reach and hold, held,
 * the owner's areas, the claim), plus every column a standing part writes (`written`) and, for a district beside a town, the town's claim
 * (`town`: a district's growth never takes town land, §2.3). `problem(x, z)` -> {kind, ...} or null.
 */
export function growObstacles(eff, st, { margin = STREET_RULES.claimMargin } = {}) {
  const K = standingClasses(st);
  const written = new Set();
  for (const p of eff.parts ?? []) for (const op of p.ops ?? []) {
    // (columns ops only: a pad's shape ops are its conditional cut, fill and batter, whose real writes the held set has)
    if (op.op === 'columns' && Array.isArray(op.cols)) for (let i = 0; i + 4 < op.cols.length; i += 5) written.add(k2(op.cols[i], op.cols[i + 1]));
  }
  const town = Array.isArray(st.town?.claim) ? st.town.claim : null;
  const c = eff.claim;
  const lamps = runKeys(st.lamps ?? []);
  const lampList = [...lamps].map((k) => k.split(',').map(Number));
  const problem = (x, z) => {
    if (x < c.minX + margin || x > c.maxX - margin || z < c.minZ + margin || z > c.maxZ - margin) return { kind: 'claim' };
    if (town && x >= town[0] && x <= town[2] && z >= town[1] && z <= town[3]) return { kind: 'town' };
    const p = columnProblem(K, x, z);
    if (p) return p;
    if (written.has(k2(x, z))) return { kind: 'written' };
    return null;
  };
  const nearLamp = (x, z) => lampList.some(([lx, lz]) => Math.max(Math.abs(lx - x), Math.abs(lz - z)) < LAMP_GAP);
  return { K, problem, written, town, lamps: lampList, nearLamp };
}

/**
 * §4.1: the terminal ends of the standing streets, `[{node, road, run, dir, at, u, ok, why?}]`: a junction node with exactly one edge in the
 * effective graph, that edge the street's own road edge; nothing else meets it; its past-end cell and the 3 past it (5 wide) clear of
 * every other entry; the past-end cell at least END_ROOM inside the claim margin along the street's axis. `why`: join | edges | held |
 * room | layout.
 */
export function extendableEnds(eff, st, runs, O = growObstacles(eff, st)) {
  const adj = adjacency(eff.graph);
  const out = [];
  for (const n of eff.graph?.nodes ?? []) {
    if (n.kind !== 'junction' || !Array.isArray(n.at)) continue;
    const run = runs.find((r) => r.road === n.ref);
    if (!run) continue;
    const [nu, nv] = toLocal(run.o, n.at[0], n.at[2]);
    if (nv !== run.c || (nu !== run.u0 && nu !== run.u1)) continue;
    const dir = nu === run.u1 ? 1 : -1;
    const e = { node: n.id, road: run.road, run, dir, at: [...n.at], u: nu, ok: false };
    out.push(e);
    // (a frontage junction's `along` edges ride on the standing road: they never make an end non-terminal, §6)
    const edges = (adj.get(n.id) ?? []).filter(({ edge }) => !edge.along);
    if (!run.twoPoint) { e.why = 'layout'; continue; }
    if (edges.length !== 1) { e.why = edges.length ? 'join' : 'edges'; continue; }
    const only = edges[0].edge;
    if (only.external || only.path !== run.road || only.type !== 'road') { e.why = 'join'; continue; }
    // the past-end cell and the END_CLEAR - 1 past it, 5 wide: no cell of another entry
    let why = null;
    for (let k = 1; k <= END_CLEAR && !why; k++) for (let dv = -2; dv <= 2 && !why; dv++) {
      const [x, z] = toWorld(run.o, nu + dir * k, run.c + dv);
      const p = vergeOk(O.problem(x, z), dv);
      if (p) why = p.kind === 'claim' ? 'room' : 'held';
    }
    if (why) { e.why = why; continue; }
    // room for one lot: END_ROOM cells inside the claim margin from the past-end cell
    const [ex, ez] = toWorld(run.o, nu + dir * END_ROOM, run.c);
    if (O.problem(ex, ez)?.kind === 'claim') { e.why = 'room'; continue; }
    e.ok = true;
  }
  return out.sort((a, b) => (a.node < b.node ? -1 : 1));
}

/**
 * An extension's verge row (|dv| = 2) may pass a standing lot's apron ring (its box plus 1, where V's own verges stand): the verge skips
 * those cells (they are the lot's apron, never written). Any other problem stands.
 */
const vergeOk = (p, dv) => (p && Math.abs(dv) === 2 && p.kind === 'lot' ? null : p);

/** A lot spec as the growth reads it (V's LotSpec): `{id, type, size: [along, deep], villager?, landmark?, placement?, role?, brief?, ext?}`. */
function specOf(s, i) {
  if (!s || typeof s.id !== 'string' || !ID.test(s.id)) throw new Error(`NOT_ALLOWED: [call] grow.lots[${i}]: id must match ${ID}`);
  if (!Array.isArray(s.size) || s.size.length !== 2 || !s.size.every((v) => Number.isInteger(v) && v >= 3 && v <= 48)) throw new Error(`NOT_ALLOWED: [call] grow.lots[${i}] ${s.id}: size must be [along, deep], 3..48`);
  return { ...s, _i: i };
}

/**
 * The growth search (§2). `ctx`: `{eff, standing, survey, grow, rid}` (`grow`: {lots: [LotSpec] | n, district?, prefer?, extend?}). Pure.
 * Returns `{district, prefix, lots: [{spec, rect, front, floorY, entrance, slot: {kind: frontage|extension, street, side, u}, laneFrom,
 * laneTo, lane}], extension: {from, road, newRoad, run: [u0, u1], o, c, y, dir} | null, unplaced: [{id, reason, kind}], ends}`.
 * Throws `NO_ROOM: [kind]` when no lot is placed (nothing planned).
 */
export function growPlan({ eff, standing, survey, grow, rid }) {
  const g = grow ?? {};
  const prefer = g.prefer ?? 'frontage';
  if (!['frontage', 'extend'].includes(prefer)) throw new Error(`NOT_ALLOWED: [call] grow.prefer must be frontage or extend (got ${JSON.stringify(g.prefer)})`);
  const extendWhat = g.extend ?? 'auto';
  const isDistricts = Array.isArray(eff.params?.spec?.districts ?? eff.params?.districts);
  const districts = (eff.params?.spec?.districts ?? eff.params?.districts ?? []).map((d) => d.id);
  const district = g.district ?? null;
  if (isDistricts && !district) throw new Error('NOT_ALLOWED: [call] grow.district: a districts region grows one district (name it)');
  if (district !== null && !districts.includes(district)) throw new Error(`NOT_ALLOWED: [call] grow.district '${district}' is not a district of the region (${districts.join(', ') || 'none'})`);
  const prefix = district ? `${district}_` : '';
  // the lot specs: a list, or a count n (a district's <d>_<k> ids continue its numbering)
  let specs;
  if (Number.isInteger(g.lots) || Number.isInteger(g.n)) {
    const n = Number.isInteger(g.lots) ? g.lots : g.n;
    if (n < 1 || n > 32) throw new Error('NOT_ALLOWED: [call] grow.lots: a count is 1..32');
    const stem = district ?? 'lot';
    let k = 0;
    for (const l of eff.lots ?? []) { const m = new RegExp(`^${stem}_(\\d+)$`).exec(l.id); if (m) k = Math.max(k, Number(m[1])); }
    const size = Array.isArray(g.size) ? g.size : [9, 9];
    specs = Array.from({ length: n }, (_, i) => ({ id: `${stem}_${k + i + 1}`, type: g.type ?? 'house', size, villager: g.villager ?? 'dwelling' }));
  } else specs = Array.isArray(g.lots) ? g.lots : [];
  if (!specs.length) throw new Error('NOT_ALLOWED: [empty] a growth adds at least one lot');
  specs = specs.map(specOf);
  const ids = new Set((eff.lots ?? []).map((l) => l.id));
  const seen = new Set();
  for (const s of specs) {
    if (ids.has(s.id)) throw new Error(`NOT_ALLOWED: [not_additive] grow lot ${s.id} is a standing lot's id (M14: lot ids are unique across the region)`);
    if (seen.has(s.id)) throw new Error(`NOT_ALLOWED: [call] grow lot ${s.id} is named twice`);
    seen.add(s.id);
  }
  const ordered = [...specs].sort((a, b) => orderOf(a) - orderOf(b) || a._i - b._i);
  const O = growObstacles(eff, standing);
  const allRuns = streetRuns(eff);
  // (a plan/0 zone grows on its own streets: their `architect_mc:street` flag names it, §8)
  const zone = typeof g.zone === 'string' ? g.zone : null;
  const runs = allRuns.filter((r) => (district ? r.district === district : r.district === null || !isDistricts) && (!zone || r.ext?.['architect_mc:street']?.zone === zone));
  if (!runs.length) throw new Error(`NO_ROOM: [street] ${district ? `district ${district}` : 'the region'} has no standing street to grow on`);
  const standingBoxes = (eff.lots ?? []).map((l) => [l.box.minX, l.box.minZ, l.box.maxX, l.box.maxZ]);
  const placed = [];
  const taken = []; // [{rect, gap}] the growth's own: its lots (gap lotGap), its lanes and pads (gap 0)
  const unplacedWhy = new Map(); // id -> Map(kind -> n)
  const tally = (id, kind) => { if (!unplacedWhy.has(id)) unplacedWhy.set(id, new Map()); const m = unplacedWhy.get(id); m.set(kind, (m.get(kind) ?? 0) + 1); };
  // (the extension's own reason for a lot it could not take: it names why the street could not carry it, read before the tallies)
  const extWhy = new Map();
  const extTally = (id, kind) => { extWhy.set(id, kind); tally(id, kind); };
  const rules = STREET_RULES;
  const ends = extendableEnds(eff, standing, runs, O);

  /** Can a lot (world rect) with its pad (rect + 1 + PAD_MAX) and its lane cells stand here? null, or the blocking kind. */
  // (the blocking kind: the one kind when a single class blocks the slot (so a slot only held reads `held`), else `frontage`)
  const fits = (rect, laneCells, entrance, { padIgnore = null } = {}) => {
    const pad = growR(rect, 1 + PAD_MAX);
    const kinds = new Set();
    for (let z = pad[1]; z <= pad[3]; z++) for (let x = pad[0]; x <= pad[2]; x++) {
      if (padIgnore && padIgnore(x, z)) continue;
      const p = O.problem(x, z);
      if (p) kinds.add(p.kind === 'beside' ? 'held' : p.kind);
    }
    for (const [x, , z] of laneCells) { const p = O.problem(x, z); if (p) kinds.add(p.kind === 'beside' ? 'held' : p.kind); }
    for (const b of standingBoxes) if (rectsMeet(growR(rect, rules.lotGap), b)) kinds.add('lot');
    for (const t of taken) if (rectsMeet(growR(rect, t.gap), t.rect)) kinds.add('growth');
    for (const [x, , z] of laneCells) for (const t of taken) if (t.lot && x >= t.rect[0] - 1 && x <= t.rect[2] + 1 && z >= t.rect[1] - 1 && z <= t.rect[3] + 1) kinds.add('growth');
    if (kinds.size) return kinds.size === 1 ? [...kinds][0] : 'frontage';
    // the land: dry, slope at most maxSlope, the pad within PAD_MAX at the entrance's y
    let lo = Infinity, hi = -Infinity;
    for (let x = rect[0]; x <= rect[2]; x++) for (let z = rect[1]; z <= rect[3]; z++) {
      if (survey.waterAt(x, z)) return 'body';
      const h = survey.heightAt(x, z);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    for (const [x, , z] of laneCells) if (survey.waterAt(x, z)) return 'body';
    if (hi - lo > rules.maxSlope) return 'slope';
    const ps = survey.padStats(rect[0], rect[1], rect[2] - rect[0] + 1, rect[3] - rect[1] + 1, { floorY: entrance[1] });
    if (ps.cut > PAD_MAX || ps.fill > PAD_MAX) return 'slope';
    return null;
  };

  // ---- §3 frontage: every slot of every run, cheapest first
  const frontage = (s) => {
    const [w, d] = s.size;
    const cands = [];
    for (const run of runs) {
      const pl = plazaOf(eff, run);
      const pu = pl ? toLocal(run.o, pl.at[0], pl.at[2])[0] : null;
      for (const side of [-1, 1]) {
        // the lot-free side: no standing lot fronts the run on this side
        const lotFree = !(eff.lots ?? []).some((l) => {
          const [lu0, lv0] = toLocal(run.o, l.box.minX, l.box.minZ), [lu1, lv1] = toLocal(run.o, l.box.maxX, l.box.maxZ);
          const a = Math.min(lu0, lu1), b = Math.max(lu0, lu1), va = Math.min(lv0, lv1), vb = Math.max(lv0, lv1);
          return b >= run.u0 && a <= run.u1 && (side > 0 ? va > run.c && va <= run.c + 3 + d + FRONT_LANE : vb < run.c && vb >= run.c - 3 - d - FRONT_LANE);
        });
        for (let eu = run.u0 + 1; eu <= run.u1 - 1; eu += SLOT_STEP) {
          const u = eu - Math.floor((w - 1) / 2);
          const front = run.c + side * (2 + 1 + FRONT_LANE);
          const v = side < 0 ? front - d + 1 : front;
          const dist = pu === null ? Math.min(eu - run.u0, run.u1 - eu) : Math.abs(eu - pu);
          cands.push({ run, side, eu, u, v, w, d, dist, lotFree });
        }
      }
    }
    cands.sort((a, b) => a.dist - b.dist || (a.lotFree === b.lotFree ? 0 : a.lotFree ? -1 : 1) || (a.run.road < b.run.road ? -1 : a.run.road > b.run.road ? 1 : 0) || a.side - b.side || a.eu - b.eu);
    for (const q of cands) {
      const { run, side, eu, u, v, w: W, d: D } = q;
      const rect = rectWorld(run.o, u, v, u + W - 1, v + D - 1);
      // the entrance (the cell outside the middle of the front edge) and the lane: from it to the row next to the verge (c + 3s)
      const ev = side < 0 ? v + D : v - 1;
      const [ex, ez] = toWorld(run.o, eu, ev);
      const floorY = survey.heightAt(ex, ez) + 1;
      const laneCells = [];
      for (let vv = run.c + side * 3; ; vv += side) {
        for (const k of [0, 1]) { const [x, z] = toWorld(run.o, eu + k, vv); laneCells.push([x, floorY - 1, z]); }
        if (vv === ev) break;
      }
      const why = fits(rect, laneCells, [ex, floorY, ez]);
      if (why) { tally(s.id, why); continue; }
      const [tx, tz] = toWorld(run.o, eu, run.c + side * 3);
      return { spec: s, rect, front: frontOf(run.o, side), floorY, entrance: [ex, floorY, ez], laneTo: [tx, floorY, tz], laneCells, slot: { kind: 'frontage', street: run.road, side, u: eu }, run };
    }
    return null;
  };
  const takeLot = (l) => {
    placed.push(l);
    taken.push({ rect: l.rect, gap: rules.lotGap, lot: true });
    for (const [x, , z] of l.laneCells ?? []) taken.push({ rect: [x, z, x, z], gap: 0 });
  };

  // ---- §4 the extension: one end, a straight run, lots on both sides as V's
  let extension = null;
  const followD = isDistricts && district ? (eff.params?.spec?.districts ?? eff.params?.districts ?? []).find((d) => d.id === district && d.follow) : null;
  const extend = (left) => {
    if (extendWhat === 'none' || !left.length) return left;
    if (followD) return extendBoundary(left);
    let cands = ends.filter((e) => e.ok);
    if (extendWhat !== 'auto') {
      const e = ends.find((q) => q.node === extendWhat);
      if (!e) throw new Error(`NOT_ALLOWED: [call] grow.extend '${extendWhat}' is not a street end of ${district ? `district ${district}` : 'the region'}`);
      if (!e.ok) { for (const s of left) extTally(s.id, e.why === 'room' ? 'claim' : e.why === 'layout' ? 'layout' : e.why === 'held' ? 'held' : 'street'); return left; }
      cands = [e];
    }
    if (!cands.length) {
      const ws = new Set(ends.map((e) => e.why));
      const k = ws.has('held') ? 'held' : ws.has('room') ? 'claim' : ws.has('layout') && ends.every((e) => e.why === 'layout') ? 'layout' : 'street';
      for (const s of left) extTally(s.id, k);
      return left;
    }
    let best = null;
    for (const e of cands) {
      const t = tryExtension(e, left);
      const pl = plazaOf(eff, e.run);
      const dist = pl ? Math.abs(e.u - toLocal(e.run.o, pl.at[0], pl.at[2])[0]) : 0;
      if (!best || t.lots.length > best.t.lots.length || (t.lots.length === best.t.lots.length && dist < best.dist)) best = { e, t, dist };
    }
    if (!best.t.lots.length) { for (const s of left) extTally(s.id, best.t.why ?? 'street'); return left; }
    for (const l of best.t.lots) takeLot(l);
    extension = best.t.ext;
    const got = new Set(best.t.lots.map((l) => l.spec));
    for (const s of left) if (!got.has(s)) extTally(s.id, best.t.why ?? 'street');
    return left.filter((s) => !got.has(s));
  };
  const tryExtension = (e, left) => {
    const { run, dir } = e;
    const o = run.o, c = run.c;
    const uS = e.u + dir;
    // the run's reach: cells clear 5 wide, inside the claim margin, the street's grade (cut/fill 3, steps of 1 from the end's y), dry
    const y0 = Number.isInteger(e.at[1]) ? e.at[1] : survey.heightAt(...toWorld(o, e.u, c));
    let lo = y0, hi = y0, uMax = e.u;
    for (let u = uS; ; u += dir) {
      let bad = false;
      for (let dv = -2; dv <= 2 && !bad; dv++) { const [x, z] = toWorld(o, u, c + dv); if (vergeOk(O.problem(x, z), dv) || survey.waterAt(x, z)) bad = true; }
      if (bad) break;
      const [x, z] = toWorld(o, u, c);
      const gr = survey.heightAt(x, z);
      const nlo = Math.max(gr - 3, lo - 1), nhi = Math.min(gr + 3, hi + 1);
      if (nlo > nhi) break;
      lo = nlo; hi = nhi; uMax = u;
      if (Math.abs(u - uS) > 512) break;
    }
    const len = Math.abs(uMax - e.u);
    if (len < END_ROOM) return { lots: [], why: 'street' };
    // lots, sides alternating outward from the old end (V's tryStreet), each fronting the new verge
    const half = Math.floor(STREET_RULES.streetWidth / 2);
    const lots = [];
    const cur = { [-1]: uS, [1]: uS };
    let side = -1;
    const inRun = (a, b) => (dir > 0 ? a >= uS && b <= uMax : b <= uS && a >= uMax);
    const extTaken = [];
    let why = null;
    for (const s of left) {
      const [w, d] = s.size;
      let got = null;
      for (let t = 0; t < 2 && !got; t++, side = -side) {
        for (let guard = 0; guard < 512; guard++) {
          const start = cur[side];
          const ua = dir > 0 ? start : start - w + 1, ub = ua + w - 1;
          if (!inRun(Math.min(ua, ub), Math.max(ua, ub))) break;
          const v = side < 0 ? c - half - d : c + half + 1;
          const rect = rectWorld(o, ua, v, ub, v + d - 1);
          const eu = ua + Math.floor((w - 1) / 2), ev = side < 0 ? v + d : v - 1;
          const [ex, ez] = toWorld(o, eu, ev);
          const floorY = survey.heightAt(ex, ez) + 1;
          // (the pad's batter may meet the extension's own street and verges: they are the growth's, written after it as V's)
          const own = (x, z) => { const [uu, vv] = toLocal(o, x, z); return Math.abs(vv - c) <= half && (dir > 0 ? uu >= uS && uu <= uMax : uu <= uS && uu >= uMax); };
          const saved = taken.length;
          for (const q of extTaken) taken.push(q);
          const bad = fits(rect, [], [ex, floorY, ez], { padIgnore: own });
          taken.length = saved;
          if (!bad) {
            got = { spec: s, rect, front: frontOf(o, side), floorY, entrance: [ex, floorY, ez], laneTo: [ex, floorY, ez], laneCells: [], slot: { kind: 'extension', street: `${run.road}_g${rid}`, side, u: eu }, run, ua, ub };
            extTaken.push({ rect, gap: STREET_RULES.lotGap, lot: true });
            cur[side] = dir > 0 ? ub + 1 + STREET_RULES.lotGap : ua - 1 - STREET_RULES.lotGap;
            break;
          }
          why = bad === 'claim' ? 'claim' : bad === 'held' ? 'held' : bad === 'body' ? 'body' : 'street';
          cur[side] += dir * SLOT_STEP;
        }
      }
      if (got) lots.push(got);
    }
    if (!lots.length) return { lots: [], why: why ?? 'street' };
    // the run: to PAST_LAST past the last lot, clamped to the reach
    const far = Math.max(...lots.map((l) => (dir > 0 ? l.ub : -l.ua))) * dir;
    const uEnd = dir > 0 ? Math.min(uMax, far + PAST_LAST) : Math.max(uMax, far - PAST_LAST);
    // (the new road's flag: the standing road's zone and district; a district's own id in a districts region; the town's zone `town`)
    const flag = run.ext?.['architect_mc:street'];
    const fd = typeof flag?.district === 'string' ? flag.district : isDistricts ? run.district : null;
    return { lots, why, ext: { from: e.node, road: run.road, newRoad: `${run.road}_g${rid}`, run: [uS, uEnd], o, c, y: y0, dir, lanterns: run.lanterns, ext: run.ext, district: fd, zone: flag?.zone ?? fd ?? 'town' } };
  };

  // ---- §5 an along district's extension: the boundary traced again over the claim's survey, a new band continuing the standing one
  // from its free route end along the spine, its street a ground road along the band's middle, its lots as D2's (followLots)
  const extendBoundary = (left) => {
    const why = (k) => { for (const s0 of left) extTally(s0.id, k); return left; };
    const cols = survey.columns;
    if (!cols) return why('boundary');
    const c = eff.claim;
    // the route's ends: the street's own (`<d>_s<k>`) and an earlier boundary growth's new end (`route_st_<d>_..._g<n>_end`)
    const endRe = new RegExp(`^(${district}_s\\d+|route_st_${district}_[a-z0-9_]*_g\\d+_end)$`);
    const routeEnds = (eff.graph?.nodes ?? []).filter((n) => n.kind === 'junction' && endRe.test(n.id) && Array.isArray(n.at));
    const adj = adjacency(eff.graph);
    // a free route end: terminal (one edge, `along` edges aside), that edge the street's own (no join, no other route)
    // (every edge the street's own; a grown end has only its own edge; a standing end an earlier growth continued from is not free)
    const free = routeEnds.filter((n) => {
      const es = (adj.get(n.id) ?? []).filter(({ edge }) => !edge.along);
      if (!es.length || es.some(({ edge }) => edge.external || !String(edge.path ?? '').startsWith(`route_st_${district}`))) return false;
      return /_g\d+_end$/.test(n.id) ? es.length === 1 : !es.some(({ edge }) => /_g\d+$/.test(String(edge.path ?? '')));
    });
    if (!free.length) return why('boundary');
    const [length, depth] = followD.size ?? [64, 24];
    const t = traceBoundary(cols, c, followD.follow, { near: [free[0].at[0], free[0].at[2]], minLength: 16 });
    if (t.none) return why('boundary');
    const spine = t.spine;
    const nearest = (p) => spine.reduce((bi, q, i) => (Math.max(Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1])) < Math.max(Math.abs(spine[bi][0] - p[0]), Math.abs(spine[bi][1] - p[1])) ? i : bi), 0);
    let best = null;
    for (const end of [...free].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const other = routeEnds.find((n) => n !== end) ?? null;
      const iE = nearest([end.at[0], end.at[2]]);
      const dirI = other ? Math.sign(iE - nearest([other.at[0], other.at[2]])) || 1 : 1;
      const need = left.reduce((a, s0) => a + s0.size[0] + 3, 0) + 8;
      const win = [];
      for (let i = iE + dirI; i >= 0 && i < spine.length && win.length < Math.min(need, length * 2); i += dirI) win.push(spine[i]);
      if (win.length < 16) continue;
      const flagsAt = (x, z) => { const i = Math.floor((x - cols.minX) / cols.resolution), j = Math.floor((z - cols.minZ) / cols.resolution); return i < 0 || j < 0 || i >= cols.width || j >= cols.depth ? FLAG_MISSING : cols.flags[i + j * cols.width]; };
      let sign = 0;
      if (t.kind !== 'ridge') { let votes = 0; win.forEach((p, i) => { const [nx, nz] = normalAt(win, i); votes += flagsAt(Math.round(p[0] + nx * 2), Math.round(p[1] + nz * 2)) & FLAG_WATER ? -1 : 1; }); sign = votes >= 0 ? 1 : -1; }
      const off = t.kind === 'ridge' ? 0 : depth >> 1;
      const lo = t.kind === 'ridge' ? -(depth >> 1) : 0, hi = t.kind === 'ridge' ? depth >> 1 : depth;
      const line = [], mask = new Set(), seen = new Set();
      win.forEach((p, i) => {
        const [nx, nz] = normalAt(win, i);
        const q = [Math.round(p[0] + nx * off * sign), Math.round(p[1] + nz * off * sign)];
        const k = `${q[0]},${q[1]}`;
        if (!seen.has(k)) { seen.add(k); line.push(q); }
        for (let tt = lo; tt <= hi; tt++) mask.add(`${Math.round(p[0] + nx * tt * (sign || 1))},${Math.round(p[1] + nz * tt * (sign || 1))}`);
      });
      // the street: from the end node along the band's middle, stopping where the land, the claim or the standing region stops it
      // (within 3 of the end node the new street meets the standing one: the standing street's own classes (its road, path, held and
      // written columns) are its contact there, as an extension's past-end cell is §4's)
      const nearEnd = (x, z) => Math.max(Math.abs(x - end.at[0]), Math.abs(z - end.at[2])) <= 3;
      const okAt = ([x, z]) => {
        if (flagsAt(x, z) & (FLAG_WATER | FLAG_LAVA | FLAG_MISSING)) return false;
        const p = O.problem(x, z);
        return !p || (nearEnd(x, z) && ['road', 'path', 'held', 'written'].includes(p.kind));
      };
      const sm = smoothLine([[end.at[0], end.at[2]], ...line]);
      const run = [];
      for (let i = 1; i < sm.length; i++) { const q = sm[i]; let ok = true; for (let dx = -2; dx <= 2 && ok; dx++) for (let dz = -2; dz <= 2 && ok; dz++) if (!okAt([q[0] + dx, q[1] + dz])) ok = false; if (!ok) break; run.push(q); }
      if (run.length < 16) continue;
      const P = run.map(([x, z]) => [x, survey.groundAt ? survey.groundAt(x, z) : survey.heightAt(x, z), z]);
      for (const k of [...mask]) { const [x, z] = k.split(',').map(Number); if (O.problem(x, z)) mask.delete(k); }
      const placedL = followLots(survey, { mask }, P, left, { keepOut: [], taken: [...standingBoxes, ...taken.map((q) => q.rect)] });
      const ok = placedL.lots.filter((l) => {
        const pad = growR(l.rect, 1 + FOLLOW_PAD);
        for (let z = pad[1]; z <= pad[3]; z++) for (let x = pad[0]; x <= pad[2]; x++) if (O.problem(x, z)) return false;
        return true;
      });
      if (!best || ok.length > best.lots.length) best = { end, run, P, mask, lots: ok };
    }
    if (!best || !best.lots.length) return why('boundary');
    const roadId = streetRuns(eff).find((r) => r.follow && r.district === district)?.road ?? `route_st_${district}_1`;
    extension = { kind: 'boundary', from: best.end.id, fromPort: 'route', road: roadId, newRoad: `${roadId}_g${rid}`, run: [0, best.run.length - 1], path: best.P, mask: maskRuns(best.mask), district, zone: district };
    const got = new Set();
    for (const l of best.lots) {
      const lot = { spec: l.spec, rect: l.rect, front: l.front, floorY: l.floorY, entrance: l.entrance, laneTo: l.lane, laneCells: l.laneCells, follow: true, street: l.street, slot: { kind: 'extension', street: extension.newRoad, side: 0, u: l.at }, run: { o: 'ew', c: 0 } };
      takeLot(lot);
      got.add(l.spec);
    }
    for (const s0 of left) if (!got.has(s0)) extTally(s0.id, 'boundary');
    return left.filter((s0) => !got.has(s0));
  };

  let left = [...ordered];
  if (prefer === 'extend') left = extend(left);
  if (left.length) {
    const rest = [];
    for (const s of left) { const l = frontage(s); if (l) takeLot(l); else rest.push(s); }
    left = rest;
  }
  if (prefer === 'frontage' && left.length && !extension) left = extend(left);
  const unplaced = left.map((s) => {
    const m = unplacedWhy.get(s.id) ?? new Map();
    const kinds = { held: 'held', body: 'body', beside: 'held', claim: 'claim', town: 'claim', street: 'street', layout: 'layout', boundary: 'boundary' };
    // (the most frequent single-class blocker among the slots tried; a slot blocked by several classes, or by a standing lot or road,
    // is plain `frontage`)
    let kind = 'frontage', n = 0;
    for (const [k, c] of [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1))) { const kk = kinds[k]; if (kk && c > n) { n = c; kind = kk; } }
    if (extWhy.has(s.id) && ['boundary', 'street', 'claim', 'layout'].includes(kinds[extWhy.get(s.id)])) kind = kinds[extWhy.get(s.id)];
    return { id: s.id, reason: 'NO_ROOM', kind };
  });
  if (!placed.length) {
    const k = unplaced.every((u) => u.kind === unplaced[0]?.kind) ? unplaced[0]?.kind ?? 'frontage' : 'frontage';
    throw new Error(`NO_ROOM: [${k}] no lot of the growth fits ${district ? `district ${district}` : 'the region'}: ${unplaced.map((u) => `${u.id} (${u.kind})`).join(', ')}; street ends ${ends.map((e) => `${e.node} ${e.ok ? 'extendable' : e.why}`).join(', ') || 'none'}`);
  }
  return { format: GROW_FORMAT, district, prefix, lots: placed, extension, unplaced, ends: ends.map((e) => ({ node: e.node, ok: e.ok, ...(e.why ? { why: e.why } : {}) })) };
}

// ------------------------------------------------------------------ emitting the growth into the revision program

/**
 * §3, §4, §6: the growth's parts (`rv<n>_[<d>_]pads`, `_lanes`, `_props`, and for an extension `_verges`, `_street`), its lots (the caller's
 * ids; V's lot ext `architect_mc:village` with the entrance, lane, slot), the extension's road `<roadId>_g<n>` (flag `architect_mc:street`),
 * and the graph: a frontage junction `<roadId>_g<n>_j<k>` at each lane's foot with two `along` road edges to the standing junctions either
 * side of it (no cell written: they ride on the standing road), its lane edge and lot node; an extension's chain from the standing end
 * node to its new terminal end `<roadId>_g<n>_end`. Edges naming standing nodes go straight into the graph (the program's own check
 * only knows the revision's nodes). Returns {parts, roads, nodes, edges, lamps}.
 */
export function emitGrowth(r, plan, { rid, eff, stages = {}, laneWidth = 2, keepOut = [] }) {
  const pre = `${ridPrefix(rid)}${plan.prefix}`;
  const sg = stages.ground ?? 'ground', ss = stages.street ?? 'street', sl = stages.lots ?? 'lots', sp = stages.props ?? 'props';
  const half = Math.floor(STREET_RULES.streetWidth / 2);
  const pads = r.part(`${pre}pads`, { stage: sg });
  const boxes = [];
  const lotsOut = [];
  for (const l of plan.lots) {
    const s = l.spec;
    const lot = pads.lot(s.id, {
      at: [l.rect[0], l.rect[1]], size: [l.rect[2] - l.rect[0] + 1, l.rect[3] - l.rect[1] + 1], floor: l.floorY, front: l.front,
      max: [l.rect[2] - l.rect[0] + 1, 32, l.rect[3] - l.rect[1] + 1], brief: s.brief, pad: { maxCut: l.follow ? FOLLOW_PAD : PAD_MAX, maxFill: l.follow ? FOLLOW_PAD : PAD_MAX, edge: 'slope' }, stage: sl,
      ext: { ...(s.ext ?? {}), 'architect_mc:village': { role: s.role, type: s.type, villager: s.villager, entrance: l.entrance, lane: `lane_${s.id}`, slot: l.slot.kind, landmark: s.landmark, placement: s.placement }, 'architect_mc:grown': { revision: rid, street: l.slot.street, side: l.slot.side, u: l.slot.u } },
    });
    boxes.push({ id: s.id, ...lot.box });
    lotsOut.push({ ...l, lot });
  }
  const lanes = r.part(`${pre}lanes`, { stage: sg, set: 'path' });
  for (const l of lotsOut) if (l.slot.kind === 'frontage') l.cells = lane(lanes, `lane_${l.spec.id}`, l.entrance, l.laneTo, laneWidth, { o: l.run.o, boxes, keepOut });
  const nodes = [], edges = [];
  const pushEdge = (e) => { if (r.graphIds.has(e.id)) throw new Error(`graph id '${e.id}' is used twice`); r.graphIds.add(e.id); r.graph.edges.push(e); edges.push(e.id); };
  const effNodes = eff.graph?.nodes ?? [];
  // ---- frontage junctions: on the standing street, two along edges to its neighbours
  const byRoad = new Map();
  for (const l of lotsOut) if (l.slot.kind === 'frontage') { if (!byRoad.has(l.slot.street)) byRoad.set(l.slot.street, []); byRoad.get(l.slot.street).push(l); }
  for (const [roadId, list] of [...byRoad].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const run = list[0].run;
    // the standing stops on this street: its junctions (and earlier growths'), and the plaza's port that the street's edges end at
    const stops = [];
    // (a junction on the run's centre line between its ends: the street's own (V's ref is the road; a following street's `<d>_street` and
    // its route ends `<d>_s<k>`, whose port is `route`), and earlier growths')
    for (const n of effNodes) {
      if (n.kind !== 'junction' || !Array.isArray(n.at)) continue;
      const [u, v] = toLocal(run.o, n.at[0], n.at[2]);
      if (v !== run.c || u < run.u0 || u > run.u1) continue;
      const port = (n.ports ?? []).find((q) => q.name === 'street') ?? (n.ports ?? []).find((q) => q.name === 'route');
      if (port && (n.ref === roadId || (run.follow && (n.ref === `${run.district}_street` || n.id.startsWith(`${run.district}_s`))) || /_g\d+_j\d+$/.test(n.id))) stops.push({ u, end: `${n.id}.${port.name}` });
    }
    for (const e of eff.graph?.edges ?? []) {
      if (e.path !== roadId || e.type !== 'road') continue;
      for (const end of [e.from, e.to]) {
        const [nid, port] = String(end).split('.');
        const n = effNodes.find((q) => q.id === nid && q.kind === 'plaza');
        const p = n?.ports?.find((q) => q.name === port);
        if (p) { const [u] = toLocal(run.o, p.at[0], p.at[2]); if (!stops.some((q) => q.end === end)) stops.push({ u, end }); }
      }
    }
    const sorted = [...list].sort((a, b) => a.slot.u - b.slot.u || (a.spec.id < b.spec.id ? -1 : 1));
    let k = 0;
    for (const l of sorted) {
      const id = `${roadId}_g${rid}_j${++k}`;
      const at = [...toWorld(run.o, l.slot.u, run.c)];
      const at3 = [at[0], run.y ?? l.floorY - 1, at[1]];
      const port = `lane_${l.spec.id}`;
      const n = r.graphNode({ id, kind: 'junction', ref: roadId, at: at3, ports: [{ name: 'street', at: at3, facing: 'up', width: STREET_RULES.streetWidth }, { name: port, at: at3, facing: frontOf(run.o, -l.slot.side), width: laneWidth }] });
      nodes.push(n.id);
      const below = stops.filter((q) => q.u < l.slot.u).sort((a, b) => b.u - a.u)[0];
      const above = stops.filter((q) => q.u > l.slot.u).sort((a, b) => a.u - b.u)[0];
      for (const [nb, tag] of [[below, 'a'], [above, 'b']]) {
        if (!nb) continue;
        const u0 = Math.min(nb.u, l.slot.u), u1 = Math.max(nb.u, l.slot.u);
        const [sx, sz] = toWorld(run.o, u0, run.c), [tx, tz] = toWorld(run.o, u1, run.c);
        pushEdge({ id: `${id}#${tag}`, from: nb.end, to: `${id}.street`, type: 'road', width: STREET_RULES.streetWidth, stage: sg, path: roadId, along: roadId, span: [u0, u1],
          segments: [{ kind: 'road', from: [sx, at3[1], sz], to: [tx, at3[1], tz] }] });
      }
      stops.push({ u: l.slot.u, end: `${id}.street` });
      r.graphNode({ id: `lot:${l.spec.id}`, kind: 'lot', ref: l.spec.id, at: l.entrance, ports: [{ name: 'entrance', at: l.entrance, facing: l.front, width: laneWidth }] });
      nodes.push(`lot:${l.spec.id}`);
      r.graphEdge({ id: port, from: `lot:${l.spec.id}.entrance`, to: `${id}.${port}`, type: 'path', width: laneWidth, path: port, stage: sg });
      edges.push(port);
    }
  }
  // ---- the extension: verges, the road, junctions at its lots' entrances, the chain from the standing end to the new end
  const roads = [];
  const X = plan.extension;
  if (X && X.kind === 'boundary') {
    // (§5) the new band's street (a ground road through the band's middle), its lots' lanes, the graph chain from the route end
    const street = r.part(`${pre}street`, { stage: ss, set: 'path' });
    const pts = X.path.filter((_, i) => i === 0 || i === X.path.length - 1 || i % 8 === 0).map(([x, , z]) => [x, null, z]);
    const fixture = fixtureFor(r.material('light', 'lamp light'), r.material('rail', 'lamp post'));
    const made = street.road(pts, { width: 3, surface: 'path', lanterns: true, mode: 'ground', id: X.newRoad, lamp: roadLamp(fixture) });
    const rd = r.roads.find((q) => q.id === X.newRoad);
    if (rd) rd.ext = { ...(rd.ext ?? {}), 'architect_mc:street': { zone: X.zone, district: X.district }, 'architect_mc:band': { district: X.district, runs: X.mask } };
    else r.paths.filter((q) => q.id.startsWith(X.newRoad)).forEach((q) => { q.ext = { 'architect_mc:band': { district: X.district, runs: X.mask } }; });
    void made;
    roads.push(X.newRoad);
    const ext = lotsOut.filter((l) => l.slot.kind === 'extension').sort((a, b) => a.slot.u - b.slot.u);
    const lanesB = lanes;
    for (const l of ext) surfaceOps(lanesB, l.laneCells.map((c) => [c[0], c[1], c[2]]), 'path');
    let prev = `${X.from}.${X.fromPort}`, k = 0;
    for (const l of ext) {
      const id = `${X.newRoad}_e${++k}`;
      const at = [l.street[0], l.street[1] + 1, l.street[2]];
      const port = `lane_${l.spec.id}`;
      r.graphNode({ id, kind: 'junction', ref: X.newRoad, at, ports: [{ name: 'street', at, facing: 'up', width: 3 }, { name: port, at, facing: 'up', width: 1 }] });
      nodes.push(id);
      pushEdge({ id: `${X.newRoad}#${k}`, from: prev, to: `${id}.street`, type: 'road', width: 3, stage: sg, path: X.newRoad });
      prev = `${id}.street`;
      r.graphNode({ id: `lot:${l.spec.id}`, kind: 'lot', ref: l.spec.id, at: l.entrance, ports: [{ name: 'entrance', at: l.entrance, facing: l.front, width: 1 }] });
      nodes.push(`lot:${l.spec.id}`);
      r.graphEdge({ id: port, from: `lot:${l.spec.id}.entrance`, to: `${id}.${port}`, type: 'path', width: 1, path: port, stage: sg });
      edges.push(port);
    }
    const last = X.path[X.path.length - 1];
    const endId = `${X.newRoad}_end`;
    const at = [last[0], last[1] + 1, last[2]];
    r.graphNode({ id: endId, kind: 'junction', ref: X.newRoad, at, ports: [{ name: 'street', at, facing: 'up', width: 3 }] });
    nodes.push(endId);
    pushEdge({ id: `${X.newRoad}#end`, from: prev, to: `${endId}.street`, type: 'road', width: 3, stage: sg, path: X.newRoad });
  } else if (X) {
    const o = X.o, c = X.c;
    const [ua, ub] = [Math.min(X.run[0], X.run[1]), Math.max(X.run[0], X.run[1])];
    const verges = r.part(`${pre}verges`, { stage: sg, set: 'path' });
    const vcells = [];
    for (let u = ua; u <= ub; u++) for (const dv of [-half, half]) { const [x, z] = toWorld(o, u, c + dv); if (r._growObstacles?.problem(x, z)?.kind !== 'lot') vcells.push([x, null, z]); }
    surfaceOps(verges, vcells, 'path');
    (r.meta.parts[verges.id] ??= {}).kind = 'path';
    const street = r.part(`${pre}street`, { stage: ss, set: 'path' });
    const p0 = toWorld(o, X.run[0], c), p1 = toWorld(o, X.run[1], c);
    const fixture = fixtureFor(r.material('light', 'lamp light'), r.material('rail', 'lamp post'));
    street.road([[p0[0], null, p0[1]], [p1[0], null, p1[1]]], { width: STREET_RULES.streetWidth - 2, surface: 'path', lanterns: X.lanterns, mode: 'ground', id: X.newRoad, lamp: roadLamp(fixture) });
    const rd = r.roads.find((q) => q.id === X.newRoad);
    if (!rd) throw new Error(`NO_ROOM: [street] the extension ${X.newRoad} could not be laid as a ground road`);
    const flag = X.ext?.['architect_mc:street'];
    void flag;
    rd.ext = { ...(rd.ext ?? {}), 'architect_mc:street': { zone: X.zone, ...(X.district ? { district: X.district } : {}) } };
    roads.push(X.newRoad);
    const yAt = (u) => { const w = toWorld(o, u, c); return [w[0], X.y, w[1]]; };
    const ext = lotsOut.filter((l) => l.slot.kind === 'extension').sort((a, b) => (a.slot.u - b.slot.u) * X.dir || (a.spec.id < b.spec.id ? -1 : 1));
    let prev = `${X.from}.street`, k = 0;
    const stops = [...new Set(ext.map((l) => l.slot.u))];
    for (const u of stops) {
      const id = `${X.newRoad}_e${++k}`; // (the extension's junctions: `_e<k>`; a frontage junction on the standing road is `<roadId>_g<n>_j<k>`)
      const at = yAt(u);
      const n = r.graphNode({ id, kind: 'junction', ref: X.newRoad, at, ports: [{ name: 'street', at, facing: 'up', width: STREET_RULES.streetWidth }] });
      nodes.push(n.id);
      pushEdge({ id: `${X.newRoad}#${k}`, from: prev, to: `${id}.street`, type: 'road', width: STREET_RULES.streetWidth, stage: sg, path: X.newRoad });
      prev = `${id}.street`;
      for (const l of ext.filter((q) => q.slot.u === u)) {
        const port = `lane_${l.spec.id}`;
        n.ports.push({ name: port, at, facing: frontOf(o, -l.slot.side), width: laneWidth });
        r.graphNode({ id: `lot:${l.spec.id}`, kind: 'lot', ref: l.spec.id, at: l.entrance, ports: [{ name: 'entrance', at: l.entrance, facing: l.front, width: laneWidth }] });
        nodes.push(`lot:${l.spec.id}`);
        r.graphEdge({ id: port, from: `lot:${l.spec.id}.entrance`, to: `${id}.${port}`, type: 'path', width: laneWidth, path: port, stage: sg });
        edges.push(port);
      }
    }
    const endId = `${X.newRoad}_end`;
    const at = yAt(X.run[1]);
    r.graphNode({ id: endId, kind: 'junction', ref: X.newRoad, at, ports: [{ name: 'street', at, facing: 'up', width: STREET_RULES.streetWidth }] });
    nodes.push(endId);
    pushEdge({ id: `${X.newRoad}#end`, from: prev, to: `${endId}.street`, type: 'road', width: STREET_RULES.streetWidth, stage: sg, path: X.newRoad });
  }
  // ---- lamps: one by each new lot's lane, on its apron row, skipping spots within LAMP_GAP of a standing lamp (§3)
  const O = r._growObstacles;
  const fixture = fixtureFor(r.material('light', 'lamp light'), r.material('rail', 'lamp post'));
  const mats = [], mi = new Map(), cols = [];
  const lamps = [];
  const placedLamps = [];
  for (const l of lotsOut) {
    if (l.follow) continue; // (an along district's grown lots take no apron lamp: D2's own lots have none)
    const [eu, ev] = toLocal(l.run.o, l.entrance[0], l.entrance[2]);
    const sideU = -1;
    const [x, z] = toWorld(l.run.o, eu + sideU, ev);
    if (O?.nearLamp(x, z) || placedLamps.some(([a, b]) => Math.max(Math.abs(a - x), Math.abs(b - z)) < LAMP_GAP)) continue;
    if (O?.problem(x, z) && l.slot.kind === 'frontage') continue;
    const cells = fixtureCells(fixture, [x, l.floorY, z], { arm: l.front }).cells;
    for (const [cx, cy, cz, s] of cells) {
      let i = mi.get(s);
      if (i === undefined) { i = mats.length; mats.push(s); mi.set(s, i); }
      cols.push(cx, cz, cy, cy, i);
    }
    placedLamps.push([x, z]);
    lamps.push({ lot: l.spec.id, at: [x, l.floorY, z] });
  }
  if (cols.length) {
    const props = r.part(`${pre}props`, { stage: sp });
    props._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: mats, cond: COND.IF_AIR_OR_FLUID, walk: false });
    (r.meta.parts[props.id] ??= {}).kind = 'add';
  }
  return { nodes, edges, roads, lamps, lots: lotsOut.map((l) => l.spec.id) };
}

/** Item 3: the lot nodes of `ir` not reachable from its plaza(s) over its edges (`graph.cut`); [] when every lot joins. */
export function graphCut(ir, { from = null } = {}) {
  const adj = adjacency(ir.graph);
  const starts = from ? [from] : (ir.graph?.nodes ?? []).filter((n) => n.kind === 'plaza').map((n) => n.id);
  const seen = new Set(starts);
  const q = [...starts];
  while (q.length) for (const { other } of adj.get(q.shift()) ?? []) if (!seen.has(other)) { seen.add(other); q.push(other); }
  return (ir.graph?.nodes ?? []).filter((n) => n.kind === 'lot' && !seen.has(n.id)).map((n) => n.id);
}
