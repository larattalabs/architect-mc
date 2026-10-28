// (6c D1) The districts pass's emitting half (docs/CONTRACT.md "Phase 6c slice D" §2, §3): `r.pass('districts', intent)`.
//   1. parse the districts (each: id, size, lots (a count or V's lot list), levelBand, prefer, near, shared, squareSize);
//   2. survey candidates per district (passes/districts.mjs), each evaluated with V's layoutStreet in its rect (the lots it places);
//   3. the assignment: exact (Hungarian with overlap branch and bound) in phases by `near` (a district near others is placed after
//      them, its cost the distance to them), else greedy; districts without a candidate are `unplaced`;
//   4. the edges: T2 route costs between district street ends (dry runs of the pure route pass, each pair alone), Kruskal's tree plus
//      the cheapest loops within `loopiness` of the tree's cost; a district that no route reaches is unplaced (`unreachable`);
//   5. a district beside a standing region (ctx.beside, Regions.plan's `beside`): one routed join from a district's street end to
//      the standing region's nearest compatible port (a street end) inside this claim's seam, written by this region;
//   6. emission: V's streetLayout per district (prefix `<id>_`, wall pads: `padEdge`, default wall; a slope pad's batter undercut V's verges on S3), props, then one route pass with every edge, the link
//      edges from each route end to its street, the external join edge, lamps over the lot aprons and along the routes.
// Plan time only, deterministic (integer costs; ties by id).
import { validateLots } from '../params.mjs';
import { layoutStreet, streetLayout, STREET_RULES, toWorld } from './village.mjs';
import { emitProps, lampFixture, planProps } from './props.mjs';
import { lightCover } from './light.mjs';
import { fixtureFor, roadLamp } from './fixtures.mjs';
import { PASSES } from './passes/index.mjs';
import { lampSpots } from './passes/route.mjs';
import { placeFollow, followLots, emitFollowLots, maskRuns } from './followEmit.mjs';
import { edgeColumns, footprintOf } from './passes/route.mjs';
import { LEAD, chooseReach, reachFor } from './reach.mjs';
import { aroundOf } from './gateJoin.mjs';
import { keyRuns } from './beside.mjs';
import { CHAIN_WIDTH, chainTerraces, emitTerraces, junctionOf, layoutTerraces, parseTerraces, ringOf, terraceEnds } from './terraces.mjs';
import { BANDS, DISTRICTS_MAX, DISTRICT_GAP, DISTRICT_INF, EXACT_MAX, LOT_UNPLACED, PREFER_TAGS, UNPLACED, assignDistricts, bandOf, candidateCost, districtCandidates, levelBands, rectsMeet, spanningEdges } from './passes/districts.mjs';

const DISTRICT_ID = /^[a-z][a-z0-9_]{0,23}$/;
const isInt = Number.isInteger;
/** A district's lot when it asks for a count: a 9x9 house (a g6a_stub_9 fits). */
export const COUNT_LOT = Object.freeze({ type: 'house', size: [9, 9] });
/** The route width between districts and of the join. */
export const DISTRICT_ROUTE_WIDTH = 3;
/** At most this many nearest districts are paired per district for the route costs (the rest are not candidates for edges). */
export const PAIR_NEIGHBOURS = 6;
/** Columns around a street end where trees are no obstacle to the routes (the route starts there). */
export const END_CLEAR = 2;
/** A dry route (a pair's cost) gives up after this many A* expansions (a dead end otherwise searches the whole claim). */
export const DRY_EXPANDED = 1_000_000;
/** (6c S3) A terraced district's join between two of its lots gives up after this many (a join that routes takes far fewer). */
export const CHAIN_EXPANDED = 300_000;
/** (6c S3) Rounds of the joins' one-pass dry run (a round drops the lots whose join failed and joins the district again). */
export const CHAIN_ROUNDS = 4;
/** (6c S3) Pairs of ends tried between two districts when one of them is terraced (the nearest first). */
export const TERRACED_COMBOS = 4;
/** (6c D2) Windows of a following district's boundary tried for its street before the plan refuses NO_EDGE. */
export const FOLLOW_WINDOWS = 4;
/** (6c D2) A following street keeps within this many cells of its line (the route pass's per-edge `within`). */
export const FOLLOW_WITHIN = 2;

/** A following street's corridor (its line grown by FOLLOW_WITHIN + 1) as one-row rects [x0, z, x1, z]. */
function lineClear(line) {
  const g = FOLLOW_WITHIN + 1, rows = new Map();
  for (const [x, z] of line) for (let dz = -g; dz <= g; dz++) {
    const k = z + dz, o = rows.get(k);
    rows.set(k, o ? [Math.min(o[0], x - g), Math.max(o[1], x + g), [...o[2], [x - g, x + g]]] : [x - g, x + g, [[x - g, x + g]]]);
  }
  const out = [];
  for (const [z, [, , spans]] of [...rows].sort((a, b) => a[0] - b[0])) {
    spans.sort((a, b) => a[0] - b[0]);
    let cur = null;
    for (const sp of spans) { if (cur && sp[0] <= cur[1] + 1) cur[1] = Math.max(cur[1], sp[1]); else { if (cur) out.push([cur[0], z, cur[1], z]); cur = [...sp]; } }
    if (cur) out.push([cur[0], z, cur[1], z]);
  }
  return out;
}

/**
 * Validate and normalise a districts list: `[{id, size: [w, d], lots: n | [lot], levelBand?: low|mid|high|any, prefer?: [tag],
 * near?: [districtId], shared?: square|well, squareSize?, label?}]`. Throws with the path. Lot ids unique across every district.
 */
export function parseDistricts(list, where = 'districts') {
  if (!Array.isArray(list) || !list.length) throw new Error(`${where} must list at least one district`);
  if (list.length > DISTRICTS_MAX) throw new Error(`${where}: ${list.length} districts (at most ${DISTRICTS_MAX})`);
  const ids = new Set(), lotIds = new Set();
  const out = list.map((d, i) => {
    const w = `${where}[${i}]`;
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(`${w} must be an object`);
    for (const k of Object.keys(d)) if (!['id', 'size', 'lots', 'levelBand', 'prefer', 'near', 'shared', 'squareSize', 'label', 'follow', 'side', 'outpost', 'terraces'].includes(k)) throw new Error(`${w}: unknown member '${k}'`);
    if (typeof d.id !== 'string' || !DISTRICT_ID.test(d.id)) throw new Error(`${w}.id must match ${DISTRICT_ID}`);
    if (ids.has(d.id)) throw new Error(`${w}.id '${d.id}' is used twice`);
    ids.add(d.id);
    // (6c D2) a following district's size is [length, depth]: its depth 12..64
    if (!Array.isArray(d.size) || d.size.length !== 2 || !d.size.every(isInt) || d.size[0] < 24 || d.size[0] > 256 || d.size[1] < (d.follow ? 12 : 24) || d.size[1] > 256) throw new Error(`${w}.size must be [w, d], integers 24..256${d.follow ? ' (a following district: [length, depth], depth 12..64)' : ''}`);
    let specs;
    if (isInt(d.lots)) {
      if (d.lots < 1 || d.lots > 16) throw new Error(`${w}.lots must be 1..16 (or a lot list)`);
      specs = validateLots(Array.from({ length: d.lots }, (_, k) => ({ id: `${d.id}_${k + 1}`, ...COUNT_LOT, size: [...COUNT_LOT.size] })), `${w}.lots`);
    } else specs = validateLots(d.lots, `${w}.lots`);
    if (!specs.length) throw new Error(`${w}.lots is empty`);
    for (const s of specs) { if (lotIds.has(s.id)) throw new Error(`${w}.lots: lot id '${s.id}' is used by another district`); lotIds.add(s.id); }
    const levelBand = d.levelBand ?? 'any';
    if (![...BANDS, 'any'].includes(levelBand)) throw new Error(`${w}.levelBand must be one of ${[...BANDS, 'any'].join(', ')}`);
    const prefer = d.prefer ?? [];
    if (!Array.isArray(prefer) || prefer.some((t) => !PREFER_TAGS.includes(t))) throw new Error(`${w}.prefer must list tags of ${PREFER_TAGS.join(', ')}`);
    const near = d.near ?? [];
    if (!Array.isArray(near) || near.some((t) => typeof t !== 'string')) throw new Error(`${w}.near must list district ids`);
    const shared = d.shared ?? (Math.min(d.size[0], d.size[1]) >= 40 ? 'square' : 'well');
    if (!['square', 'well'].includes(shared)) throw new Error(`${w}.shared must be square or well`);
    const squareSize = d.squareSize ?? 9;
    if (!isInt(squareSize) || squareSize < 7 || squareSize > 15) throw new Error(`${w}.squareSize must be 7..15`);
    if (d.label !== undefined && (typeof d.label !== 'string' || d.label.length > 80)) throw new Error(`${w}.label must be a string (<= 80)`);
    // (6c D2, C27) a district following a boundary: {biome_edge: {between: [a, b]}} | {shore: {minArea?}} | {ridge: {minRise?}}; its size
    // is [length along the boundary, depth off it]; side a|b (a biome edge: whose side; default a)
    let follow = null;
    if (d.follow !== undefined) {
      const fk = d.follow && typeof d.follow === 'object' ? Object.keys(d.follow) : [];
      if (fk.length !== 1 || !['biome_edge', 'shore', 'ridge'].includes(fk[0])) throw new Error(`${w}.follow must be one of {biome_edge: {between: [a, b]}}, {shore: {}} or {ridge: {}}`);
      if (fk[0] === 'biome_edge' && !(Array.isArray(d.follow.biome_edge?.between) && d.follow.biome_edge.between.length === 2 && d.follow.biome_edge.between.every((f) => typeof f === 'string' && /^[a-z][a-z_]{0,23}$/.test(f)) && d.follow.biome_edge.between[0] !== d.follow.biome_edge.between[1])) throw new Error(`${w}.follow.biome_edge.between must name two biome families`);
      if (fk[0] === 'shore' && d.follow.shore?.minArea !== undefined && !(isInt(d.follow.shore.minArea) && d.follow.shore.minArea >= 1)) throw new Error(`${w}.follow.shore.minArea must be a positive integer`);
      if (fk[0] === 'ridge' && d.follow.ridge?.minRise !== undefined && !(isInt(d.follow.ridge.minRise) && d.follow.ridge.minRise >= 1 && d.follow.ridge.minRise <= 256)) throw new Error(`${w}.follow.ridge.minRise must be 1..256`);
      if (d.size[1] < 12 || d.size[1] > 64) throw new Error(`${w}.size: a following district's depth is 12..64`);
      follow = JSON.parse(JSON.stringify(d.follow));
    }
    if (d.side !== undefined && !['a', 'b'].includes(d.side)) throw new Error(`${w}.side must be a or b (a biome edge's side)`);
    // (6c D2) an outpost: a district not touching the town, at least `gap` (default 24) from the standing region and the other districts
    let outpost = null;
    if (d.outpost !== undefined && d.outpost !== false) {
      const gap = d.outpost === true ? 24 : d.outpost?.gap;
      if (!isInt(gap) || gap < 8 || gap > 512) throw new Error(`${w}.outpost must be true or {gap: 8..512}`);
      if (follow) throw new Error(`${w}: an outpost is placed on a survey candidate (no follow)`);
      outpost = { gap };
    }
    // (6c S3) a terraced district: its lots on levels down the slope (terraces.mjs); only when given, so every other district is as before
    let terraces = null;
    if (d.terraces !== undefined) {
      terraces = parseTerraces(d.terraces, `${w}.terraces`);
      if (follow) throw new Error(`${w}: a following district is laid along its boundary (no terraces)`);
    }
    return { id: d.id, size: [...d.size], specs, levelBand, prefer: [...prefer], near: [...near], shared: shared === 'square' ? { kind: 'square', size: squareSize } : { kind: 'well', size: 7 }, ...(d.label ? { label: d.label } : {}), ...(follow ? { follow, side: d.side ?? 'a' } : {}), ...(outpost ? { outpost } : {}), ...(terraces ? { terraces } : {}) };
  });
  for (const d of out) for (const t of d.near) if (!ids.has(t) || t === d.id) throw new Error(`${where}: district ${d.id}'s near names '${t}', not another district`);
  return out;
}

/** Phases by `near`: a district is placed after the districts it is near (a cycle is broken by id: the rest go last). */
function phasesOf(ds) {
  const left = new Set(ds.map((d) => d.id)), done = new Set(), phases = [];
  while (left.size) {
    const ready = ds.filter((d) => left.has(d.id) && d.near.every((t) => done.has(t)));
    const ph = ready.length ? ready : ds.filter((d) => left.has(d.id));
    for (const d of ph) { left.delete(d.id); }
    for (const d of ph) done.add(d.id);
    phases.push(ph.map((d) => d.id));
  }
  return phases;
}

/** The two street ends of a layout: the cell past each end along the street axis, with its outward facing. */
export function streetEnds(L) {
  const o = L.orientation, sv = L.road.sv;
  return [[L.u0 - 1, -1, L.u0], [L.u1 + 1, 1, L.u1]].map(([u, s, ue], k) => {
    const [x, z] = toWorld(o, u, sv), [xe, ze] = toWorld(o, ue, sv);
    return { k, x, z, street: [xe, ze], facing: o === 'ew' ? [s, 0] : [0, s] };
  });
}

/**
 * A standing region's join ports (ctx.beside): the terminal junctions of its street network (a junction with one road or path edge),
 * each with the cell past it along its edge (outward) and that direction. `[{node, port, at, end: [x, z], dir: [dx, dz]}]`.
 */
export function besidePorts(beside) {
  const nodes = new Map((beside.graph?.nodes ?? []).map((n) => [n.id, n]));
  const deg = new Map();
  const nb = new Map();
  for (const e of beside.graph?.edges ?? []) {
    // ((6d GR §6) a growth's frontage `along` edges ride on the standing road: never counted, so an end stays terminal)
    if (e.along) { const j = String(e.to).split('.')[0]; deg.set(j, (deg.get(j) ?? 0) + 2); }
    if (e.external || e.along) continue;
    for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) {
      const n = String(a).split('.')[0];
      deg.set(n, (deg.get(n) ?? 0) + 1);
      if (!nb.has(n)) nb.set(n, { other: String(b).split('.')[0], port: String(a).split('.')[1], type: e.type });
    }
  }
  const out = [];
  for (const [id, n] of nodes) {
    if (n.kind !== 'junction' || deg.get(id) !== 1) continue;
    const o = nodes.get(nb.get(id).other);
    if (!o) continue;
    const dx = Math.sign(n.at[0] - o.at[0]), dz = Math.sign(n.at[2] - o.at[2]);
    // an axis-aligned terminal only (a street end); a diagonal route end has no single outward cell
    if ((dx !== 0) === (dz !== 0)) continue;
    out.push({ node: id, port: nb.get(id).port, type: nb.get(id).type, at: [...n.at], end: [n.at[0] + dx, n.at[2] + dz], dir: [dx, dz] });
  }
  out.sort((p, q) => (p.node < q.node ? -1 : p.node > q.node ? 1 : 0));
  return out;
}

/**
 * The placement (pure): candidates per district, each with V's street layout in its rect, and the assignment in phases by `near`.
 * `{S (ctx.survey), claim, keepOut, blocked, ds (parseDistricts), step, limit, exact, wet (6c HY-a: the hydrology pass's `wet` field)}` ->
 * `{bands, cands, pick: Map(id -> candidate),
 * unplaced, phases, methods, exact, bnbNodes, totalCost}`. The plan check (plan_v0) places a districts zone with it at resolve time
 * and hands the result to emitDistricts (`_placed`).
 */
export function placeDistricts({ S, claim, keepOut = [], blocked = [], ds, step = 4, limit = EXACT_MAX, exact: wantExact = true, farFrom = [], wet = null }) {
  const cols = S.columns;
  step ??= 4; limit ??= EXACT_MAX;
  const bands = levelBands(cols, claim);
  // ---- candidates, each with its street layout
  const rectOf = (c) => ({ ...claim, minX: c.rect.minX, minZ: c.rect.minZ, maxX: c.rect.maxX, maxZ: c.rect.maxZ });
  const cands = ds.map((d) => {
    // (6c D2) an outpost keeps `gap` from the standing region and the following districts (`farFrom` rects)
    const far = (c) => !d.outpost || farFrom.every((q) => !rectsMeet(c.rect, { minX: q[0], minZ: q[1], maxX: q[2], maxZ: q[3] }, d.outpost.gap));
    const cs = d.follow ? [] : districtCandidates(cols, claim, d.size, { bands, blocked, step, limit: d.outpost ? limit * 4 : limit, band: d.levelBand, gap: 1, wet }).filter(far).slice(0, limit);
    const out = [];
    for (const c of cs) {
      // (6c S3) a terraced district's candidate: its terraced layout (layoutStreet refuses a slope steeper than a street)
      const L = d.terraces ? layoutTerraces({ claim: rectOf(c), survey: S, specs: d.specs, terraces: d.terraces, keepOut }) : layoutStreet({ claim: rectOf(c), survey: S, specs: d.specs, rules: STREET_RULES, shared: d.shared, keepOut });
      if (L.fail || !L.lots.length) continue;
      out.push({ ...c, L, unplacedLots: L.unplaced.length });
    }
    return out;
  });
  // ---- the assignment, in phases by near
  const phases = phasesOf(ds);
  const pick = new Map(); // district id -> candidate
  let exact = true, bnbNodes = 0, totalCost = 0;
  const methods = new Set();
  for (const ph of phases) {
    const idx = ph.map((id) => ds.findIndex((d) => d.id === id));
    const taken = [...pick.values()].map((c) => c.rect);
    const pc = idx.map((i) => {
      const d = ds[i];
      const near = d.near.filter((t) => pick.has(t)).map((t) => { const q = pick.get(t).rect; return [(q.minX + q.maxX) >> 1, (q.minZ + q.maxZ) >> 1]; });
      return cands[i].filter((c) => !taken.some((q) => rectsMeet(q, c.rect, DISTRICT_GAP))).map((c) => ({ ...c, cost: candidateCost(d, c, { unplacedLots: c.unplacedLots, near }) })).filter((c) => c.cost < DISTRICT_INF);
    });
    const a = assignDistricts(idx.map((i) => ds[i]), pc, { gap: DISTRICT_GAP, exact: wantExact !== false });
    exact &&= a.exact; bnbNodes += a.nodes; totalCost += a.cost; methods.add(a.method);
    idx.forEach((i, n) => { if (a.pick[n] >= 0) pick.set(ds[i].id, pc[n][a.pick[n]]); });
  }
  const unplaced = [];
  for (const [i, d] of ds.entries()) if (!pick.has(d.id)) unplaced.push({ id: d.id, reason: cands[i].length ? 'no_room' : 'no_candidate', candidates: cands[i].length });
  return { bands, cands, pick, unplaced, phases, methods, exact, bnbNodes, totalCost };
}

/**
 * `r.pass('districts', intent)`: `{districts: [...], loopiness = 0.15, candidates = 'survey', step = 4, limit = 64, exact = true,
 * stage: {ground, street, routes, lots, props}, maxGrade = 0.25, routeLamps = true, lampFixture, keepOut, hard}`. Returns
 * `{data}` (also `r.meta.districts`): `{assign: {districtId: candidateId}, rects, lots, unplaced, edges, treeCost, loopCost,
 * loopiness, bands, candidates, exact, method, join, ms}`.
 */
export function emitDistricts(r, intent = {}) {
  const t0 = performance.now();
  const it = { ...intent };
  const what = 'pass districts';
  const ctx = r.ctx, claim = r.claim, S = r.survey, cols = S.columns;
  if ((it.candidates ?? 'survey') !== 'survey') throw new Error(`${what}: candidates must be 'survey' (7a's affordances come later)`);
  const ds = parseDistricts(it.districts, `${what}: districts`);
  const loopiness = it.loopiness ?? 0.15;
  if (typeof loopiness !== 'number' || !(loopiness >= 0 && loopiness <= 1)) throw new Error(`${what}: loopiness must be 0..1`);
  const stages = { ground: 'ground', street: 'street', routes: 'routes', lots: 'lots', props: 'props', ...(it.stage ?? {}) };
  for (const s of Object.values(stages)) if (!r.stageList.includes(s)) throw new Error(`${what}: stage '${s}' is not one of the region's stages (${r.stageList.join(', ')})`);
  // ---- obstacles: keep-out (the owner's areas and builds), the caller's hard rects, a standing region's cells, this region's lots and forms
  const keepOut = [...(ctx.keepOut ?? []), ...(it.keepOut ?? [])].map((k) => [...k]);
  const beside = ctx.beside ?? null;
  const standing = beside ? [...(beside.lots ?? []).map((b) => [b[0] - 1, b[1] - 1, b[2] + 1, b[3] + 1]), ...(beside.keep ?? [])] : [];
  const own = r._routeObstacles({}).hard;
  const blocked = [...keepOut, ...(it.hard ?? []), ...standing, ...own];
  const maxGrade = it.maxGrade ?? 0.25;
  // ((6c S3) `routeKeepOut`: rects every route of the pass keeps out of (a terraced plan's protected areas, other regions, builds); absent:
  // as before)
  const rko = Array.isArray(it.routeKeepOut) && it.routeKeepOut.length ? it.routeKeepOut.map((k) => [...k]) : null;
  const feet = (x, z) => [x, S.groundAt(x, z) + 1, z];
  const dryRoute = (a, b, hardRects, clearTrees, prefer = [], cap = DRY_EXPANDED, extra = {}) => {
    const out = PASSES.route(cols, ctx.volumes ?? [], {
      edges: [{ id: 'dry', from: { at: a.at, facing: a.facing }, to: { at: b.at, facing: b.facing }, width: DISTRICT_ROUTE_WIDTH, movers: ['player', 'villager'], ladders: false, ...(prefer.length ? { prefer } : {}), ...extra }],
      maxGrade, hairpinLanding: 3, stairs: true, maxCut: 4, maxFill: 4, margin: 2, hard: hardRects, keepOut: rko ? [...keepOut, ...rko] : keepOut, prefer: [], clearTrees,
      maxExpanded: cap,
    });
    return out.data.edges[0];
  };
  // ---- (6c D2, C27) the following districts first: traced along their boundary (a named refusal when one can't be placed)
  const follows = new Map(); // id -> {pf, path, lots, unplacedLots, hard}
  const biomes = ds.some((d) => d.follow?.biome_edge) ? ctx.biomes ?? null : null;
  const anchorNear = (d) => (it.near?.[d.id] ? it.near[d.id] : beside ? [(beside.claim[0] + beside.claim[2]) >> 1, (beside.claim[1] + beside.claim[3]) >> 1] : null);
  for (const d of ds.filter((x) => x.follow)) {
    const taken = [...follows.values()].map((f) => [f.pf.rect.minX, f.pf.rect.minZ, f.pf.rect.maxX, f.pf.rect.maxZ]);
    // its street: a dry route between the window's line ends that prefers the line, then its lots beside that path. A window whose
    // street does not route (too steep beside the water, say) gives way to the next window along the boundary: at most
    // FOLLOW_WINDOWS windows, each with twice a pair's expansions (a following street is long and winds with its boundary)
    const tried = [];
    let pf = null, st = null, failed = null;
    for (let w = 0; w < (it._follow?.[d.id] ? 1 : FOLLOW_WINDOWS); w++) {
      const p = it._follow?.[d.id] ?? placeFollow({ cols, claim, d, biomes, blocked: [...blocked.filter((q) => !keepOut.includes(q)), ...taken], keepOut, near: anchorNear(d), exclude: tried });
      if (p.none) { if (!w) throw new Error(`${p.none} (district ${d.id})`); break; }
      tried.push(p.start);
      const na = { at: feet(p.ends[0].x, p.ends[0].z), facing: p.ends[0].facing }, nb = { at: feet(p.ends[1].x, p.ends[1].z), facing: p.ends[1].facing };
      // the street's corridor is the street's to clear (its run fells what stands there): no tree obstacle within it (a jungle edge)
      const endClearF = [...p.ends.map((e) => [e.x - END_CLEAR, e.z - END_CLEAR, e.x + END_CLEAR, e.z + END_CLEAR]), ...lineClear(p.line)];
      const baseF = r._routeObstacles({ hard: [...standing, ...taken], clearTrees: endClearF });
      const s = dryRoute(na, nb, baseF.hard, baseF.clearTrees, p.line, 2 * DRY_EXPANDED, { within: p.line, withinRadius: FOLLOW_WITHIN });
      if (s.ok) { pf = p; st = s; break; }
      failed = failed ?? s.failed;
    }
    if (!pf) throw new Error(`NO_EDGE: the street along the ${(it._follow?.[d.id]?.kind ?? Object.keys(d.follow)[0]).replace('_', ' ')} does not route (${failed}; ${tried.length} window(s); district ${d.id})`);
    const fl = followLots(S, pf, st.path, d.specs, { blocked: [...standing, ...taken], keepOut, taken: [...follows.values()].flatMap((f) => f.lots.map((l) => l.rect)) });
    const foot = footprintOf(st.path, DISTRICT_ROUTE_WIDTH);
    follows.set(d.id, { pf, path: st.path, lots: fl.lots, unplacedLots: fl.unplaced, hard: maskRuns(new Set(foot.map((q) => `${q[0]},${q[1]}`))), clear: lineClear(pf.line) });
  }
  const followRects = [...follows.values()].map((f) => [f.pf.rect.minX - 1, f.pf.rect.minZ - 1, f.pf.rect.maxX + 1, f.pf.rect.maxZ + 1]);
  const farFrom = [...(beside ? [beside.claim] : []), ...followRects];
  const P = it._placed ?? placeDistricts({ S, claim, keepOut, blocked: [...blocked, ...followRects], ds, step: it.step, limit: it.limit, exact: it.exact, farFrom, wet: r.hydrology?.wet ?? null });
  const { bands, cands, pick, phases, methods } = P;
  const unplaced = P.unplaced.filter((u) => !follows.has(u.id));
  let { exact, bnbNodes, totalCost } = P;
  // ---- (6c S3) a terraced district's joins, before anything is emitted: a tree of dry routes from its landmark between its lots'
  // entrances (terraces.mjs chainTerraces); a lot no route reaches drops (its district's unplaced lots, as D1's unreachable districts)
  const terr = new Map(); // district id -> {L (the kept lots), edges, dropped}
  const lotHard = (l) => [l.rect[0] - 1, l.rect[1] - 1, l.rect[2] + 1, l.rect[3] + 1];
  const terraceHard = (L) => L.lots.flatMap((l) => [lotHard(l), ...((L.retain === 'wall' || l.fill > 6) && !it._unsafeUnretained ? ringOf(S, l).wall.map(([x, z]) => [x, z, x, z]) : [])]);
  const srOf = (L) => {
    const o = L.orientation, half = Math.floor(STREET_RULES.streetWidth / 2), sv = L.road.sv;
    const a = toWorld(o, L.u0, sv - half), b = toWorld(o, L.u1, sv + half);
    const sh = L.shared.rect;
    return [[Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], [sh[0], sh[1], sh[2], sh[3]]];
  };
  const followRectsT = [...follows.values()].map((f) => [f.pf.rect.minX - 1, f.pf.rect.minZ - 1, f.pf.rect.maxX + 1, f.pf.rect.maxZ + 1]);
  for (const d of ds) {
    if (!d.terraces || !pick.has(d.id) || follows.has(d.id)) continue;
    const L0 = pick.get(d.id).L;
    const others = [...pick.entries()].filter(([id]) => id !== d.id).flatMap(([, q]) => (q.L.terraced ? terraceHard(q.L) : [...q.L.lots.map(lotHard), ...srOf(q.L)]));
    const hardC = r._routeObstacles({ hard: [...others, ...terraceHard(L0), ...standing, ...followRectsT] });
    const clearC = [...hardC.clearTrees, ...L0.lots.map((l) => [l.entrance[0] - END_CLEAR, l.entrance[2] - END_CLEAR, l.entrance[0] + END_CLEAR, l.entrance[2] + END_CLEAR])];
    const ch = chainTerraces(L0, { dry: (a, b) => dryRoute(a, b, hardC.hard, clearC, [], CHAIN_EXPANDED, { width: CHAIN_WIDTH, ...(d.terraces.stairs ? {} : { stairs: false }) }) });
    terr.set(d.id, { L: { ...L0, lots: ch.kept, unplaced: [...L0.unplaced, ...ch.dropped] }, edges: ch.edges, dropped: ch.dropped });
  }
  // the joins as the route pass will lay them (each district's approaches, then its joins, district by district, one pass: an earlier
  // edge's stairs bar a later one): a dry run of exactly those edges; a lot whose approach or join fails drops and its district is
  // joined again without it (at most CHAIN_ROUNDS rounds)
  if (terr.size) {
    const CARD = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
    for (let round = 0; round < CHAIN_ROUNDS; round++) {
      const E = [];
      const tds = ds.filter((d) => terr.has(d.id));
      for (const d of tds) {
        const t = terr.get(d.id);
        t.L.lots.forEach((l, k) => E.push({ d: d.id, lot: l.spec.id, kind: 'a', id: `${d.id}_a${k + 1}`, from: { at: [...l.entrance], facing: [...CARD[l.front]] }, to: { at: [...junctionOf(l).at], facing: null }, width: CHAIN_WIDTH }));
        const lotOf = new Map(t.L.lots.map((l) => [l.spec.id, l]));
        t.edges.forEach((e, k) => E.push({ d: d.id, lot: e.b, pair: `${e.a}|${e.b}`, kind: 't', id: `${d.id}_t${k + 1}`, from: { at: [...junctionOf(lotOf.get(e.a)).at], facing: null }, to: { at: [...junctionOf(lotOf.get(e.b)).at], facing: null }, width: CHAIN_WIDTH, ...(d.terraces.stairs ? {} : { stairs: false }) }));
      }
      if (!E.length) break;
      const allHard = [...ds.filter((d) => pick.has(d.id) && !follows.has(d.id)).flatMap((d) => (terr.has(d.id) ? terraceHard(terr.get(d.id).L) : [...pick.get(d.id).L.lots.map(lotHard), ...srOf(pick.get(d.id).L)])), ...standing, ...followRectsT];
      const base0 = r._routeObstacles({ hard: allHard });
      const clear0 = [...base0.clearTrees, ...tds.flatMap((d) => terr.get(d.id).L.lots.flatMap((l) => { const j = junctionOf(l).at; return [[l.entrance[0] - END_CLEAR, l.entrance[2] - END_CLEAR, l.entrance[0] + END_CLEAR, l.entrance[2] + END_CLEAR], [j[0] - END_CLEAR, j[2] - END_CLEAR, j[0] + END_CLEAR, j[2] + END_CLEAR]]; }))];
      const out = PASSES.route(cols, ctx.volumes ?? [], {
        edges: E.map((e) => ({ id: e.id, from: e.from, to: e.to, width: e.width, movers: ['player', 'villager'], ladders: false, ...(e.stairs === false ? { stairs: false } : {}) })),
        maxGrade, hairpinLanding: 3, stairs: true, maxCut: 4, maxFill: 4, margin: 2, hard: base0.hard, keepOut: rko ? [...keepOut, ...rko] : keepOut, prefer: [], clearTrees: clear0,
        maxExpanded: CHAIN_EXPANDED * E.length,
      });
      // a failed approach drops its lot; a failed join is forbidden and the district joined again (the lot tries its other neighbours)
      const bad = new Map(); // district -> {drop: lots, forbid: pairs}
      out.data.edges.forEach((x, i) => {
        if (x.ok) return;
        const e = E[i];
        if (!bad.has(e.d)) bad.set(e.d, { drop: new Set(), forbid: new Set() });
        if (e.kind === 'a' || round === CHAIN_ROUNDS - 1) bad.get(e.d).drop.add(e.lot);
        else bad.get(e.d).forbid.add(e.pair);
      });
      if (!bad.size) break;
      for (const [did, b] of bad) {
        const d = ds.find((q) => q.id === did), t = terr.get(did);
        t.forbid = new Set([...(t.forbid ?? []), ...b.forbid]);
        const keep = t.L.lots.filter((l) => !b.drop.has(l.spec.id) || l === t.L.lots[0]);
        const lost = t.L.lots.filter((l) => !keep.includes(l)).map((l) => ({ id: l.spec.id, reason: 'unreachable', tried: ['its approach or join in the one pass'] }));
        const L1 = { ...t.L, lots: keep };
        const hardC = r._routeObstacles({ hard: allHard });
        const ch = chainTerraces(L1, { forbid: t.forbid, dry: (a, q) => dryRoute(a, q, hardC.hard, clear0, [], CHAIN_EXPANDED, { width: CHAIN_WIDTH, ...(d.terraces.stairs ? {} : { stairs: false }) }) });
        terr.set(did, { L: { ...L1, lots: ch.kept, unplaced: [...t.L.unplaced.filter((u) => !ch.kept.some((l) => l.spec.id === u.id)), ...lost, ...ch.dropped] }, edges: ch.edges, dropped: [...t.dropped.filter((u) => !ch.kept.some((l) => l.spec.id === u.id)), ...lost, ...ch.dropped], forbid: t.forbid });
      }
    }
  }
  const Lof = (d) => terr.get(d.id)?.L ?? pick.get(d.id).L;
  // ---- route costs between the placed districts' street ends (dry runs, each pair alone)
  const placed = ds.filter((d) => pick.has(d.id) || follows.has(d.id));
  const ends = new Map(placed.map((d) => [d.id, follows.has(d.id) ? follows.get(d.id).pf.ends : Lof(d).terraced ? terraceEnds(Lof(d)) : streetEnds(Lof(d))]));
  // the districts' streets and squares are hard to every route (the lots join through this.lots once emitted; before, from the layouts)
  const streetRects = (L) => {
    const o = L.orientation, half = Math.floor(STREET_RULES.streetWidth / 2), sv = L.road.sv;
    const a = toWorld(o, L.u0, sv - half), b = toWorld(o, L.u1, sv + half);
    const q = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    const s = L.shared.rect;
    return [q, [s[0], s[1], s[2], s[3]]];
  };
  const districtHard = placed.flatMap((d) => (follows.has(d.id) ? follows.get(d.id).hard : Lof(d).terraced ? terraceHard(Lof(d)).filter((q) => q[0] === q[2] && q[1] === q[3]) : streetRects(Lof(d))));
  const layoutLots = placed.flatMap((d) => (follows.has(d.id) ? follows.get(d.id).lots.map((l) => [l.rect[0] - 1, l.rect[1] - 1, l.rect[2] + 1, l.rect[3] + 1]) : Lof(d).lots.map((l) => [l.rect[0] - 1, l.rect[1] - 1, l.rect[2] + 1, l.rect[3] + 1])));
  // a street end's ground is the street's to clear: no tree obstacle within END_CLEAR of it (the route fells what stands there)
  const endClear = placed.flatMap((d) => ends.get(d.id).map((e) => [e.x - END_CLEAR, e.z - END_CLEAR, e.x + END_CLEAR, e.z + END_CLEAR]));
  const base = r._routeObstacles({ hard: [...districtHard, ...layoutLots, ...standing], clearTrees: endClear });
  // (a following street's own cells are not hard to the routes that end on it: its ends are open, as a V street's past-end cells are)
  const dryMemo = new Map();
  const dryOne = (a, b, cap = DRY_EXPANDED) => {
    // ((6c S3) a terraced pass's dry pairs are remembered: the same two ends are routed once)
    const mk = terr.size ? `${a.at}|${a.facing}|${b.at}|${b.facing}|${cap}` : null;
    if (mk && dryMemo.has(mk)) return dryMemo.get(mk);
    const e = dryRoute(a, b, base.hard, base.clearTrees, [], cap);
    if (mk) dryMemo.set(mk, e.ok ? { cost: e.cost, length: e.length } : { cost: DISTRICT_INF, failed: e.failed });
    return e.ok ? { cost: e.cost, length: e.length } : { cost: DISTRICT_INF, failed: e.failed };
  };
  // ((6c S3) a terraced district's end is a lot's junction: the route ends there from any side)
  const endNode = (d, e) => (e.terraced ? { name: e.junction, at: [e.x, e.y, e.z], facing: null, e, d } : { name: `${d.id}_s${e.k}`, at: feet(e.x, e.z), facing: e.facing, e, d });
  const pairs = [];
  const rectOfD = (d) => (follows.has(d.id) ? follows.get(d.id).pf.rect : pick.get(d.id).rect);
  const centre = (d) => { const q = rectOfD(d); return [(q.minX + q.maxX) >> 1, (q.minZ + q.maxZ) >> 1]; };
  const cheb = (p, q) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]));
  const neighbours = new Map(placed.map((d) => [d.id, new Set(placed.filter((x) => x !== d).sort((p, q) => cheb(centre(d), centre(p)) - cheb(centre(d), centre(q)) || (p.id < q.id ? -1 : 1)).slice(0, PAIR_NEIGHBOURS).map((x) => x.id))]));
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const A = placed[i], B = placed[j];
    if (!neighbours.get(A.id).has(B.id) && !neighbours.get(B.id).has(A.id)) continue;
    // the cheapest routable pair of street ends: the 2 x 2 nearest first, a pair skipped when its lower bound (10 a cell, Chebyshev)
    // can't beat the best so far; ties by end index
    let best = null;
    const combos = [];
    for (const ea of ends.get(A.id)) for (const eb of ends.get(B.id)) combos.push({ ea, eb, dd: cheb([ea.x, ea.z], [eb.x, eb.z]) });
    combos.sort((p, q) => p.dd - q.dd || p.ea.k - q.ea.k || p.eb.k - q.eb.k);
    // ((6c S3) with a terraced end, the TERRACED_COMBOS nearest pairs of ends only)
    const terracedPair = combos.some((q) => q.ea.terraced || q.eb.terraced);
    // ((6c S3) a terraced district may list one lot as two ends: each pair of junctions once)
    if (terracedPair) { const seen = new Set(); for (let i = combos.length - 1; i >= 0; i--) { const k = `${combos[i].ea.junction ?? combos[i].ea.k}|${combos[i].eb.junction ?? combos[i].eb.k}`; if (seen.has(k)) combos.splice(i, 1); else seen.add(k); } combos.sort((p, q) => p.dd - q.dd || p.ea.k - q.ea.k || p.eb.k - q.eb.k); }
    let tries = 0;
    for (const { ea, eb, dd } of terracedPair ? combos.slice(0, TERRACED_COMBOS) : combos) {
      if (best && best.dry.cost < DISTRICT_INF && 10 * dd >= best.dry.cost) continue;
      const na = endNode(A, ea), nb = endNode(B, eb);
      // ((6c S3) a terraced pair's later tries give up after CHAIN_EXPANDED: the nearest ends had the full budget)
      const dry = dryOne(na, nb, terracedPair && tries++ > 0 ? CHAIN_EXPANDED : DRY_EXPANDED);
      if (!best || dry.cost < best.dry.cost) best = { na, nb, dry };
    }
    pairs.push({ a: A.id, b: B.id, cost: best.dry.cost, na: best.na, nb: best.nb, dry: best.dry });
  }
  const span = spanningEdges(placed.map((d) => d.id), pairs, loopiness);
  // a district no route reaches (outside the largest component) is unplaced: unreachable
  const main = new Set(span.components[0] ?? []);
  for (const d of placed) if (!main.has(d.id)) { unplaced.push({ id: d.id, reason: 'unreachable', candidates: cands[ds.indexOf(d)].length }); pick.delete(d.id); follows.delete(d.id); }
  const isPlaced = (id) => pick.has(id) || follows.has(id);
  const chosen = [...span.tree.map((p) => ({ ...p, kind: 'tree' })), ...span.loops.map((p) => ({ ...p, kind: 'loop' }))].filter((p) => isPlaced(p.a) && isPlaced(p.b));
  if (!ds.some((x) => isPlaced(x.id))) throw new Error(`NO_ROOM: no district could be placed (${unplaced.map((u) => `${u.id}: ${u.reason}`).join(', ')})`);
  // ---- the join to a standing region: the cheapest dry route from a district end to a standing street end in the seam
  let join = null;
  // ((6c D3) the reach step's state when it chose the join: the frame's survey, the candidate, the hard columns)
  let reachJ = null;
  if (beside) {
    const ports = besidePorts(beside).filter((q) => q.end[0] >= claim.minX && q.end[0] <= claim.maxX && q.end[1] >= claim.minZ && q.end[1] <= claim.maxZ);
    // (6c D3, §2.1) the seam step first, as D1; the reach step only when it has no port or no dry route, and only with the reach inputs
    // (an older mod sends none: D1's two refusals read as before)
    let best = null;
    for (const d of ds.filter((x) => isPlaced(x.id))) for (const e of ends.get(d.id)) for (const q of ports) {
      const a = endNode(d, e);
      const b = { name: `join_${beside.id}`.replace(/[^a-z0-9_]/g, '_'), at: feet(q.end[0], q.end[1]), facing: [q.dir[0], q.dir[1]] };
      const dry = dryOne(a, b);
      if (dry.cost >= DISTRICT_INF) continue;
      if (!best || dry.cost < best.dry.cost) best = { a, b, q, dry };
    }
    if (!best && !ctx.besideReach) {
      if (!ports.length) throw new Error(`NO_JOIN: no street end of region ${beside.id} lies inside this claim (its seam with the standing claim must hold one, at most 16 columns)`);
      throw new Error(`NO_JOIN: no route from a district to region ${beside.id}'s street ends (${ports.map((q) => q.node).join(', ')}) within the grade and the obstacles`);
    }
    if (!best) {
      reachJ = reachStep({ r, ctx, claim, beside, ds: ds.filter((x) => isPlaced(x.id)), ends, endNode, base, keepOut, rko, maxGrade, seamPorts: ports.length, unsafe: it._unsafe ?? {} });
      best = reachJ.join;
    }
    join = best;
  } else if (it.joinTo) {
    // (6c D2) a join to a point of this region (a plan's outpost to its town zone's street end): routed, no external edge
    let best = null;
    for (const d of ds.filter((x) => isPlaced(x.id))) for (const e of ends.get(d.id)) {
      const a = endNode(d, e);
      const b = { name: it.joinTo.name, at: it.joinTo.at, facing: it.joinTo.facing ?? null };
      const dry = dryOne(a, b);
      if (dry.cost >= DISTRICT_INF) continue;
      if (!best || dry.cost < best.dry.cost) best = { a, b, q: null, dry };
    }
    if (!best) throw new Error(`NO_JOIN: no route from the districts to ${it.joinTo.name} within the grade and the obstacles`);
    join = best;
  }
  // ---- emit: the districts' street layouts, props; the following districts' lots and lanes
  const placedNow = ds.filter((d) => isPlaced(d.id));
  if (!placedNow.length) throw new Error(`NO_ROOM: no district could be placed (${unplaced.map((u) => `${u.id}: ${u.reason}`).join(', ')})`);
  const reserved = new Set(), laneCells = [];
  const layouts = {}, followOut = {};
  for (const d of placedNow) {
    if (follows.has(d.id)) {
      const f = follows.get(d.id);
      const em = emitFollowLots(r, d, f.lots, stages);
      laneCells.push(...em.laneCells);
      followOut[d.id] = em;
      continue;
    }
    const c = pick.get(d.id);
    if (Lof(d).terraced) {
      // (6c S3) the terraced lots on their levels, their retaining rings and rails (no street, square or props)
      layouts[d.id] = emitTerraces(r, Lof(d), { stages: { ground: stages.ground, lots: stages.lots }, prefix: `${d.id}_`, keepOut, unretained: !!it._unsafeUnretained });
      continue;
    }
    let props = null;
    const L = streetLayout(r, d.specs, {
      rules: STREET_RULES, shared: d.shared, laneWidth: 2, maxHeight: 32, rect: c.rect, prefix: `${d.id}_`, layout: c.L, padEdge: it.padEdge ?? 'wall',
      stages: { ground: stages.ground, street: stages.street, lots: stages.lots },
      planProps: ({ o, sh, res, lots }) => (props = planProps(r, { o, sh, res, lots, laneWidth: 2, lamps: 'street', bell: false, keepOut, rng: ctx.rng(`props:${d.id}`) })),
    });
    emitProps(r, props, { stage: stages.props, prefix: `${d.id}_` });
    for (const k of props?.noWalk ?? []) reserved.add(k);
    for (const [x, z] of [...L.res.area, ...L.res.golem]) reserved.add(`${x},${z}`);
    laneCells.push(...Object.values(L.laneCells).flat());
    layouts[d.id] = L;
  }
  // ---- the routes: the following streets, every chosen edge and the join, in one route pass (ids st_<d>, d_<a>__<b> and join)
  const nodes = {}, edges = [];
  const addNode = (n) => { nodes[n.name] = { at: n.at, kind: 'junction', facing: n.facing }; };
  for (const d of placedNow) {
    if (!follows.has(d.id)) continue;
    const f = follows.get(d.id);
    const na = endNode(d, f.pf.ends[0]), nb = endNode(d, f.pf.ends[1]);
    addNode(na); addNode(nb);
    edges.push({ id: `st_${d.id}`, from: na.name, to: nb.name, width: DISTRICT_ROUTE_WIDTH, prefer: f.path.map(([x, , z]) => [x, z]), within: f.pf.line, withinRadius: FOLLOW_WITHIN });
  }
  // (6c S3) a terraced district first: each lot's approach to its junction (ids <d>_a<k>), then the joins between the junctions (ids
  // <d>_t<k>; stairs as its member says); the joins between districts meet the junctions after (an earlier edge's walk is preferred)
  for (const d of placedNow) {
    const t = terr.get(d.id);
    if (!t) continue;
    t.L.lots.forEach((l, k) => { const j = junctionOf(l); nodes[j.name] = { at: [...j.at], kind: 'junction', facing: null }; edges.push({ id: `${d.id}_a${k + 1}`.slice(0, 48), from: l.spec.id, to: j.name, width: CHAIN_WIDTH }); });
    const jn = new Map(t.L.lots.map((l) => [l.spec.id, junctionOf(l).name]));
    t.edges.forEach((e, k) => edges.push({ id: `${d.id}_t${k + 1}`.slice(0, 48), from: jn.get(e.a), to: jn.get(e.b), width: CHAIN_WIDTH, ...(d.terraces.stairs ? {} : { stairs: false }) }));
  }
  for (const p of chosen) { addNode(p.na); addNode(p.nb); edges.push({ id: `d_${p.a}__${p.b}`.slice(0, 48), from: p.na.name, to: p.nb.name, width: DISTRICT_ROUTE_WIDTH }); }
  // ((6c D3) a reach join: framed by both claims, its lead into the junction, graded (its columns exactly its footprint) and its own part
  // `route_join`; the pass runs over the frame's survey, every other edge framed by the claim)
  // (`_unsafe.wideReach`: the join in the routes part, a non-join writer outside the claim; `_unsafe.writeVerge`: its footprint behind the
  // junction kept, a T graded into the verge: broken variants M28:beside must catch)
  const U0 = it._unsafe ?? {};
  // ((7a GJ, §3) a gate join: the leg out (`join`, to the gate's outer cell) and the leg in (`join_in`, from its inner cell), both
  // `route_join`; `_unsafe.writeGate`: one edge straight through the gate, its cells not hard (a broken variant M28:beside must catch))
  const GJ = reachJ?.G && !U0.writeGate ? reachJ.G : null;
  if (join && GJ) {
    addNode(join.a); addNode(GJ.out); addNode(GJ.in); addNode(join.b);
    edges.push({ id: 'join', from: join.a.name, to: GJ.out.name, width: DISTRICT_ROUTE_WIDTH, frame: reachJ.frame, lead: LEAD, graded: true, part: 'route_join', behindNear: 2 });
    edges.push({ id: 'join_in', from: GJ.in.name, to: join.b.name, width: DISTRICT_ROUTE_WIDTH, frame: reachJ.innerFrame, lead: LEAD, graded: true, part: 'route_join', behindNear: 2 });
  } else if (join) { addNode(join.a); addNode(join.b); edges.push({ id: 'join', from: join.a.name, to: join.b.name, width: DISTRICT_ROUTE_WIDTH, ...(reachJ ? { frame: reachJ.frame, lead: LEAD, graded: true, ...(U0.wideReach ? {} : { part: 'route_join' }), ...(U0.writeVerge ? { keepBehind: true } : {}) } : {}) }); }
  let routed = null;
  const streetHard = placedNow.filter((d) => !follows.has(d.id)).flatMap((d) => (Lof(d).terraced ? layouts[d.id].ring : streetRects(Lof(d))));
  const reachIn = reachJ ? { survey: reachJ.api, frame: [reachJ.claimR], noRetain: reachJ.noRetain } : {};
  const reachHard = reachJ ? (reachJ.G && U0.writeGate ? keyRuns([...reachJ.hardKeys].filter((k) => !reachJ.gateCols.has(k))) : reachJ.hard) : [];
  if (edges.length) routed = r._route({ nodes, edges, maxGrade, stage: stages.routes, part: it.routePart ?? 'routes', hard: [...streetHard, ...standing, ...reachHard], keepOut: [...(it.keepOut ?? []), ...(rko ?? [])], lanterns: true, clearTrees: [...endClear, ...[...follows.values()].flatMap((f) => f.clear), ...[...terr.values()].flatMap((t) => t.L.lots.map((l) => [l.entrance[0] - END_CLEAR, l.entrance[2] - END_CLEAR, l.entrance[0] + END_CLEAR, l.entrance[2] + END_CLEAR]))], roadSurface: 'path', lamp: roadLamp(lampFixture(r)), ...(terr.size ? { guard: true } : {}), ...reachIn });
  const byId = new Map((routed?.edges ?? []).map((e) => [e.id, e]));
  // a following street that does not route refuses the plan, named
  for (const d of placedNow) if (follows.has(d.id) && !byId.get(`st_${d.id}`)?.ok) throw new Error(`NO_EDGE: the street of district ${d.id} along the ${follows.get(d.id).pf.kind.replace('_', ' ')} did not route (${byId.get(`st_${d.id}`)?.failed ?? 'not routed'})`);
  // a following street's chain in the graph: its ends and the junctions in front of its lots, in path order
  for (const d of placedNow) {
    if (!follows.has(d.id)) continue;
    const js = [...followOut[d.id].junctions].sort((p, q) => p.at - q.at);
    const chain = [`${d.id}_s0.route`, ...js.map((j) => `${j.id}.street`), `${d.id}_s1.route`];
    for (let k = 0; k + 1 < chain.length; k++) r.graphEdge({ id: `${d.id}_street#${k + 1}`, from: chain[k], to: chain[k + 1], type: 'road', width: DISTRICT_ROUTE_WIDTH, path: `route_st_${d.id}`, stage: stages.routes });
  }
  // the route ends join their streets: a link edge from each end node to the street's terminal junction
  const linked = new Set();
  const linkEnd = (en) => {
    if (en.e.follow || en.e.terraced || linked.has(en.name) || !r.graph.nodes.some((x) => x.id === en.name)) return;
    linked.add(en.name);
    const [xe, ze] = en.e.street;
    const term = r.graph.nodes.find((x) => x.kind === 'junction' && x.id.startsWith(`${en.d.id}_`) && x.at[0] === xe && x.at[2] === ze);
    const plaza = r.graph.nodes.find((x) => x.id === `${en.d.id}_plaza`);
    let to = term ? `${term.id}.${term.ports[0].name}` : null;
    if (!to && plaza) { const pp = plaza.ports.find((q) => q.at[0] === xe && q.at[2] === ze); if (pp) to = `${plaza.id}.${pp.name}`; }
    if (!to) return;
    r.graphEdge({ id: `${en.name}_link`, from: `${en.name}.${r.graph.nodes.find((x) => x.id === en.name).ports[0].name}`, to, type: 'road', width: DISTRICT_ROUTE_WIDTH, path: `${en.d.id}_street`, stage: stages.routes });
  };
  for (const p of chosen) if (byId.get(`d_${p.a}__${p.b}`.slice(0, 48))?.ok) { linkEnd(p.na); linkEnd(p.nb); }
  // ((7a GJ) a gate join routed: both its legs)
  const joinOk = !!byId.get('join')?.ok && (!GJ || !!byId.get('join_in')?.ok);
  if (join && joinOk && beside) {
    linkEnd(join.a);
    // the external edge (7a turns it into a typed link, S-D-2): this region's join node to the standing region's port
    const jn = r.graph.nodes.find((x) => x.id === join.b.name);
    // ((6c D3, §3.5) a reach join's edge names its junction: a street end as D1 plus `junction {kind: end, at}`, a side `<town>:<roadId>`
    // with `junction {kind: side, at, side, u}`)
    const to = join.q.node ? `${beside.id}:${join.q.node}.${join.q.port}` : `${beside.id}:${join.q.road}`;
    // ((7a GJ, §5) through a gate: `via`, the gate junction (then D3's) and the crossing; the traverse an edge of its own between the legs)
    const gx = GJ ? { via: `${reachJ.gate.region}:${reachJ.gate.id}`, junction: { kind: 'gate', gate: reachJ.gate.id, at: [...reachJ.gate.at], then: reachJ.cand.junction }, crossing: { type: 'gate', lands: reachJ.gate.id } } : null;
    if (GJ) {
      const go = r.graph.nodes.find((x) => x.id === GJ.out.name), gi = r.graph.nodes.find((x) => x.id === GJ.in.name);
      if (go && gi) r.graphEdge({ id: 'join_gate', from: `${go.id}.${go.ports[0].name}`, to: `${gi.id}.${gi.ports[0].name}`, type: 'road', width: Math.min(DISTRICT_ROUTE_WIDTH, reachJ.gate.width), path: 'route_join', stage: stages.routes, via: gx.via, crossing: gx.crossing, segments: [{ kind: 'gate', gate: reachJ.gate.id, region: reachJ.gate.region }] });
    }
    r.graphEdge({ id: 'join_external', from: `${jn.id}.${jn.ports[0].name}`, to, type: 'road', width: DISTRICT_ROUTE_WIDTH, path: 'route_join', stage: stages.routes, external: true, ...(gx ?? (reachJ ? { junction: reachJ.cand.junction } : {})) });
  }
  const failed = (routed?.edges ?? []).filter((e) => !e.ok);
  if (join && joinOk && !beside) linkEnd(join.a);
  if (join && !joinOk) throw new Error(`NO_JOIN: ${reachJ ? '[route] ' : ''}the join to ${beside ? `region ${beside.id}` : it.joinTo.name} did not route (${byId.get('join')?.ok === false || !byId.get('join') ? byId.get('join')?.failed ?? 'not routed' : `its leg in from gate ${reachJ.gate.id}: ${byId.get('join_in')?.failed ?? 'not routed'}`})`);
  // ---- (6c D3, §2.3) the reach: the join's written columns outside this claim, and the contact columns it holds
  if (reachJ) r.meta.reach = reachRecord(r, reachJ, beside, U0);
  // ---- (6c D2) an outpost's corridor: the routes that reach it (its join, its spanning-tree edges), each footprint grown by 2: the
  // settlement land its road crosses, undone with it (one region)
  const corridor = {};
  const metaEdge = (id) => r.meta.route?.edges?.find((e) => e.id === id && e.ok);
  for (const d of placedNow.filter((x) => x.outpost)) {
    const ids = [...chosen.filter((p) => p.a === d.id || p.b === d.id).map((p) => `d_${p.a}__${p.b}`.slice(0, 48)), ...(join && join.a.d.id === d.id ? ['join', ...(GJ ? ['join_in'] : [])] : [])];
    const cells = new Set();
    for (const id of ids) { const e = metaEdge(id); if (e) for (const q of footprintOf(e.path, DISTRICT_ROUTE_WIDTH + 4)) cells.add(`${q[0]},${q[1]}`); }
    corridor[d.id] = { edges: ids, runs: maskRuns(cells), cells: cells.size };
  }
  // ---- anchors (the first district's bell), lamps
  const bellOf = (d) => (follows.has(d.id) ? (() => { const P2 = follows.get(d.id).path; const m = P2[P2.length >> 1]; return [m[0], m[1] + 1, m[2]]; })() : layouts[d.id].res.bell);
  const first = placedNow[0];
  const bell = bellOf(first);
  if (it.anchors !== false) {
    if (!r.anchors.entrance) r.anchor('entrance', bell);
    if (!r.anchors.spawn) r.anchor('spawn', bell);
    for (const d of placedNow) r.anchor(`bell_${d.id}`.slice(0, 32), bellOf(d));
  }
  let lamps = null;
  if (it.lamps !== false) {
    const extra = [], extraCap = {};
    // ((6c D3, N-D3-2) a reach join's lamps: inside this claim only, and none within LAMP_GAP of a town lamp)
    // ((6c D3, the coordinator's ruling B) a reach join is lit inside the town's claim too: its lamps may stand on reach columns (unheld,
    // off the town's footprint and bodies, never a contact column), none within LAMP_GAP of a town lamp (N-D3-2), and the cover holds
    // over its walk cells in the town on their own, the town's own lights counted)
    const RL = reachJ ? reachLamps(reachJ, claim, r) : null;
    const lampOk = RL ? (e, q) => (e.id !== 'join' && e.id !== 'join_in') || ((q.x >= claim.minX && q.x <= claim.maxX && q.z >= claim.minZ && q.z <= claim.maxZ) || RL.lampOk(q.x, q.z)) && !reachJ.nearTownLamp(q.x, q.z) : null;
    if (it.routeLamps !== false && r.meta.route) for (const e of r.meta.route.edges) { const l = lampSpots(e); const sp = lampOk ? l.spots.filter((q) => lampOk(e, q)) : l.spots; extra.push(...sp); if (sp.length) extraCap[`route:${e.id}`] = RL && e.id === 'join' ? l.cap + RL.extraCap : l.cap; }
    const fixture = it.lampFixture ? fixtureFor(it.lampFixture, r.material('rail', 'lamp post')) : lampFixture(r);
    if (RL) r._reachSurvey = reachJ.U;
    const cover = lightCover(r, { fixture, stage: stages.props, keepOut, reserved, laneCells, extra, extraCap, ...(RL ? { reach: { lampOk: RL.lampOk, targets: RL.targets, lights: RL.lights, area: (x, z) => reachJ.frame.slice(1).some((q) => x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3]) } } : {}) });
    if (RL) { delete r._reachSurvey; reachAddLamps(r, claim, cover.lamps); }
    lamps = { fixture: cover.fixture, perLot: cover.perLot, before: cover.before, after: cover.after, capped: cover.capped, count: cover.lamps.length, ...(cover.reach ? { reach: cover.reach } : {}) };
  }
  // ---- the record
  const rectArr = (q) => [q.minX, q.minZ, q.maxX, q.maxZ];
  const yOf = (d) => (follows.has(d.id) ? bellOf(d)[1] - 1 : pick.get(d.id).y);
  const data = {
    loopiness, bands, exact, method: [...methods].join(", "), nodes: bnbNodes, cost: totalCost, phases,
    candidates: Object.fromEntries(ds.map((d, i) => [d.id, cands[i].length])),
    assign: Object.fromEntries(placedNow.map((d) => [d.id, follows.has(d.id) ? `follow:${follows.get(d.id).pf.kind}` : pick.get(d.id).id])),
    rects: Object.fromEntries(placedNow.map((d) => [d.id, rectArr(rectOfD(d))])),
    bandOf: Object.fromEntries(placedNow.map((d) => [d.id, { want: d.levelBand, got: bandOf(bands, yOf(d)), y: yOf(d) }])),
    lots: Object.fromEntries(placedNow.map((d) => [d.id, follows.has(d.id) ? follows.get(d.id).lots.map((l) => l.spec.id) : layouts[d.id].lots.map((l) => l.spec.id)])),
    unplacedLots: Object.fromEntries(placedNow.map((d) => [d.id, follows.has(d.id) ? follows.get(d.id).unplacedLots.map((u) => u.id) : layouts[d.id].unplaced.map((u) => u.id)])),
    unplaced,
    pairs: pairs.map((p) => ({ a: p.a, b: p.b, cost: p.cost < DISTRICT_INF ? p.cost : null, failed: p.dry.failed ?? null })),
    edges: [...chosen.map((p) => { const id = `d_${p.a}__${p.b}`.slice(0, 48); const e = byId.get(id); return { id, a: p.a, b: p.b, kind: p.kind, dryCost: p.cost, ok: !!e?.ok, failed: e?.failed ?? null }; }),
      ...(join ? [{ id: 'join', a: join.a.d.id, b: beside ? `${beside.id}:${join.q.node ?? join.q.road}` : join.b.name, kind: 'join', dryCost: join.dry.cost, ok: !!byId.get('join')?.ok, failed: byId.get('join')?.failed ?? null }] : [])],
    treeCost: span.treeCost, loopCost: span.loopCost, failedEdges: failed.map((e) => e.id),
    join: join ? (beside ? { region: beside.id, node: join.q.node, port: join.q.port, at: join.b.at, from: join.a.name, district: join.a.d.id, ...(reachJ ? { road: join.q.road, step: 'reach', junction: reachJ.cand.junction, tried: reachJ.tried, candidates: reachJ.count } : {}), ...(GJ ? { via: `${reachJ.gate.region}:${reachJ.gate.id}`, gate: gateMeta(reachJ.gate) } : {}) } : { to: join.b.name, at: join.b.at, from: join.a.name, district: join.a.d.id }) : null,
    bells: Object.fromEntries(placedNow.map((d) => [d.id, bellOf(d)])),
    ...(follows.size ? { follow: Object.fromEntries([...follows.entries()].filter(([id]) => placedNow.some((d) => d.id === id)).map(([id, f]) => [id, {
      kind: f.pf.kind, side: f.pf.side, rect: rectArr(f.pf.rect), mask: maskRuns(f.pf.mask), maskCells: f.pf.mask.size, boundary: f.pf.window, line: f.pf.line,
      street: (r.meta.route?.edges?.find((e) => e.id === `st_${id}`)?.path ?? []).map((q) => [...q]), spineLength: f.pf.spineLength,
    }])) } : {}),
    ...(Object.keys(corridor).length ? { corridor } : {}),
    ...(terr.size ? { terraces: Object.fromEntries([...terr.entries()].filter(([id]) => placedNow.some((d) => d.id === id)).map(([id, t]) => [id, {
      rise: t.L.rise, retain: t.L.retain, stairs: t.L.stairs, base: t.L.base, flat: t.L.flat, levels: layouts[id].levels,
      lots: t.L.lots.map((l) => ({ id: l.spec.id, level: l.level, y: l.floorY - 1, front: l.front, cut: l.cut, fill: l.fill, rect: [...l.rect] })),
      edges: t.edges.map((e, k) => ({ id: `${id}_t${k + 1}`.slice(0, 48), a: e.a, b: e.b, ok: !!byId.get(`${id}_t${k + 1}`.slice(0, 48))?.ok })),
      dropped: t.dropped, retained: layouts[id].retained, rails: layouts[id].rails, blended: layouts[id].blended,
    }])) } : {}),
    lamps, ms: Math.round(performance.now() - t0),
  };
  if (it.meta !== false) r.meta.districts = data;
  if (Object.keys(corridor).length) r.meta.corridor = Object.fromEntries(Object.entries(corridor).map(([k, v]) => [k, v.runs]));
  r.note(`pass districts: ${placedNow.length}/${ds.length} placed (${data.method}${exact ? '' : ', not exact'}${follows.size ? `; ${follows.size} following a boundary` : ''}), ${chosen.length} edge(s) (${span.tree.length} tree, ${span.loops.length} loop), loop cost ${span.loopCost} of tree ${span.treeCost}${join ? `, joined to ${beside ? `${beside.id} at ${join.q.node}` : join.b.name}` : ''}${unplaced.length ? `; unplaced: ${unplaced.map((u) => `${u.id} (${u.reason})`).join(', ')}` : ''}`);
  return { data, layouts, ends: Object.fromEntries(placedNow.map((d) => [d.id, ends.get(d.id)])), reserved, laneCells };
}

/**
 * (6c D3, §2) The reach step: the join's candidates over the town's claim (its street ends and sides), the cheapest dry route (T2 cost)
 * from a district end to one, over the reach frame (this claim and the town's, one grid). Pairs are tried in order of their 10-a-cell
 * lower bound and skipped once the bound can't win; at most REACH_DRY_MAX dry routes, each at most REACH_EXPANDED expansions. Throws
 * `NO_JOIN: [kind] ...` (apart, street, wall, route, budget). Returns the join (as the seam step's: {a, b, q, dry}) and the state the
 * route pass, the lamps and the reach record read.
 */
function reachStep({ r, ctx, claim, beside, ds, ends, endNode, base, keepOut, rko, maxGrade, seamPorts, unsafe }) {
  const districtEnds = ds.flatMap((d) => ends.get(d.id).map((e) => { const n = endNode(d, e); return { x: e.x, z: e.z, at: n.at, facing: n.facing, node: n }; }));
  // ((7a GJ, §4) a map of reach inputs: the town's, and a wall region's round it)
  const R = reachFor(ctx.besideReach, beside.id);
  if (!R) throw new Error(`NO_JOIN: the reach inputs name no region ${beside.id}`);
  const J = chooseReach({ planCols: r.survey.columns, R, around: aroundOf(ctx.besideReach, beside.id), beside, claim: [claim.minX, claim.minZ, claim.maxX, claim.maxZ], yRange: [claim.minY, claim.maxY], districtEnds, baseHard: base.hard, clearTrees: base.clearTrees, keepOut: rko ? [...keepOut, ...rko] : keepOut, maxGrade, volumes: ctx.volumes ?? [], seamPorts, unsafe, route: PASSES.route });
  const name = `join_${beside.id}`.replace(/[^a-z0-9_]/g, '_');
  const a = J.best.end.node;
  const b = { name, at: [...J.cand.at], facing: [...J.cand.facing] };
  // ((7a GJ, §1, §3) through a gate: two legs, to its outer cell and on from its inner cell; the traverse between is never written)
  const G = J.gate ? { out: { name: `${name}_go`, at: [J.gate.outer[0], J.gate.y + 1, J.gate.outer[1]], facing: [...J.gate.facing] }, in: { name: `${name}_gi`, at: [J.gate.inner[0], J.gate.y + 1, J.gate.inner[1]], facing: [-J.gate.facing[0], -J.gate.facing[1]] } } : null;
  return { ...J, G, join: { a, b, q: { node: J.cand.node ?? null, port: J.cand.port ?? null, road: J.cand.road }, dry: J.best.dry } };
}

/**
 * (6c D3, §2.3) The IR's `reach` (the plan adds its input shas): the join's written columns outside this claim and the contact columns it
 * holds (row runs), their rect and count. Every reach column is checked against the reach rules (§5.3's M28:beside, at plan time):
 * inside the town's claim, never the footprint, a body or a held column outside the contact columns.
 */
function reachRecord(r, J, beside, unsafe = {}) {
  const broken = !!(unsafe.ignoreHeld || unsafe.writeVerge || unsafe.wideReach || unsafe.noHold);
  // ((7a GJ) a gate join's two legs; never a gate cell: the traverse is the wall's)
  const recs = r.meta.route.edges.filter((e) => e.id === 'join' || (J.G && e.id === 'join_in'));
  const out = new Set();
  const inClaim = (x, z) => x >= J.claimR[0] && x <= J.claimR[2] && z >= J.claimR[1] && z <= J.claimR[3];
  for (const rec of recs) for (const q of rec?.written ?? []) for (let x = q[0]; x <= q[2]; x++) if (!inClaim(x, q[1])) out.add(`${x},${q[1]}`);
  const contact = new Set(J.cand.contact);
  for (const k of out) {
    const [x, z] = k.split(',').map(Number);
    if (broken || unsafe.writeGate) continue;
    if (!J.frame.slice(1).some((q) => x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3])) throw new Error(`NO_JOIN: [route] the join writes (${x}, ${z}) outside ${J.G ? 'the standing claims' : 'both claims'}`);
    if (J.G && J.gateCols.has(k)) throw new Error(`NO_JOIN: [route] the join writes (${x}, ${z}), a cell of gate ${J.gate.id}`);
    if (J.hardKeys.has(k) && !contact.has(k)) throw new Error(`NO_JOIN: [route] the join writes (${x}, ${z}), a column region ${beside.id} or another site holds`);
  }
  const hold = unsafe.noHold ? [] : J.cand.hold.filter((k) => contact.has(k));
  for (const k of hold) out.add(k);
  const runs = keyRuns(out);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const q of runs) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[2]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); }
  return { standing: beside.id, runs, rect: runs.length ? [x0, z0, x1, z1] : null, cells: out.size, hold: keyRuns(hold), junction: J.cand.junction, contact: keyRuns(J.cand.contact), ...(J.G ? { gate: gateMeta(J.gate) } : {}) };
}

/** (7a GJ, §3) The gate a join crosses, as the IR's `reach.gate` and the plan meta record it (the traverse: never written, never held). */
function gateMeta(g) {
  return { region: g.region, wall: g.wall, id: g.id, at: [...g.at], y: g.y, h: g.h, width: g.width, facing: [...g.facing], door: g.door, ...(g.doorBlock ? { doorBlock: g.doorBlock } : {}), cells: g.cells.map((q) => [...q]), outer: [...g.outer], inner: [...g.inner], ...(g.narrowed ? { narrowed: g.narrowed } : {}) };
}

/**
 * (6c D3, ruling B) A reach join's lamps: `lampOk` (a lamp column outside this claim: in the town's claim, unheld, off the footprint and
 * bodies, never a contact column or one the join writes), `targets` (the join's walk cells outside this claim: feet over its surface),
 * `lights` (the town's own light blocks, [x, y, z, level]) and `extraCap` (more lamps for the in-town stretch: one per 10 cells of it).
 */
function reachLamps(J, claim, r) {
  const inClaim = (x, z) => x >= claim.minX && x <= claim.maxX && z >= claim.minZ && z <= claim.maxZ;
  const reachCols = new Set();
  for (const q of r.meta.reach?.runs ?? []) for (let x = q[0]; x <= q[2]; x++) reachCols.add(`${x},${q[1]}`);
  const contact = new Set(J.cand.contact);
  const lampOk = (x, z) => !inClaim(x, z) && J.frame.slice(1).some((q) => x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3]) && !J.hardKeys.has(`${x},${z}`) && !contact.has(`${x},${z}`) && !reachCols.has(`${x},${z}`) && !(J.G && J.gateCols.has(`${x},${z}`));
  const targets = [];
  for (const rec of r.meta.route.edges.filter((e) => e.id === 'join' || (J.G && e.id === 'join_in'))) if (rec?.ok) for (const o of edgeColumns({ path: rec.path, segments: rec.segments, landings: rec.landings ?? [], width: rec.width ?? DISTRICT_ROUTE_WIDTH }).cols) if (!inClaim(o.x, o.z) && reachCols.has(`${o.x},${o.z}`)) targets.push([o.x, o.y + 1, o.z]);
  return { lampOk, targets, lights: J.lights ?? [], extraCap: Math.max(1, Math.floor((targets.length / 3 + 9) / 10)) };
}

/** (6c D3, ruling B) The join's lamps that stand outside this claim join the reach (their columns; `lamps` names them for M28). */
function reachAddLamps(r, claim, lamps) {
  const out = new Set();
  for (const l of lamps) for (const [x, , z] of l.cells) if (!(x >= claim.minX && x <= claim.maxX && z >= claim.minZ && z <= claim.maxZ)) out.add(`${x},${z}`);
  if (!out.size) return;
  const m = r.meta.reach;
  const all = new Set();
  for (const q of m.runs) for (let x = q[0]; x <= q[2]; x++) all.add(`${x},${q[1]}`);
  for (const k of out) all.add(k);
  m.runs = keyRuns(all);
  m.lamps = keyRuns(out);
  m.cells = all.size;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const q of m.runs) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[2]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); }
  m.rect = [x0, z0, x1, z1];
}

export { LOT_UNPLACED, UNPLACED };
