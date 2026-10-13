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
import { fixtureFor } from './fixtures.mjs';
import { PASSES } from './passes/index.mjs';
import { lampSpots } from './passes/route.mjs';
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
    for (const k of Object.keys(d)) if (!['id', 'size', 'lots', 'levelBand', 'prefer', 'near', 'shared', 'squareSize', 'label'].includes(k)) throw new Error(`${w}: unknown member '${k}'`);
    if (typeof d.id !== 'string' || !DISTRICT_ID.test(d.id)) throw new Error(`${w}.id must match ${DISTRICT_ID}`);
    if (ids.has(d.id)) throw new Error(`${w}.id '${d.id}' is used twice`);
    ids.add(d.id);
    if (!Array.isArray(d.size) || d.size.length !== 2 || !d.size.every((n) => isInt(n) && n >= 24 && n <= 256)) throw new Error(`${w}.size must be [w, d], integers 24..256`);
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
    return { id: d.id, size: [...d.size], specs, levelBand, prefer: [...prefer], near: [...near], shared: shared === 'square' ? { kind: 'square', size: squareSize } : { kind: 'well', size: 7 }, ...(d.label ? { label: d.label } : {}) };
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
    if (e.external) continue;
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
 * `{S (ctx.survey), claim, keepOut, blocked, ds (parseDistricts), step, limit, exact}` -> `{bands, cands, pick: Map(id -> candidate),
 * unplaced, phases, methods, exact, bnbNodes, totalCost}`. The plan check (plan_v0) places a districts zone with it at resolve time
 * and hands the result to emitDistricts (`_placed`).
 */
export function placeDistricts({ S, claim, keepOut = [], blocked = [], ds, step = 4, limit = EXACT_MAX, exact: wantExact = true }) {
  const cols = S.columns;
  step ??= 4; limit ??= EXACT_MAX;
  const bands = levelBands(cols, claim);
  // ---- candidates, each with its street layout
  const rectOf = (c) => ({ ...claim, minX: c.rect.minX, minZ: c.rect.minZ, maxX: c.rect.maxX, maxZ: c.rect.maxZ });
  const cands = ds.map((d) => {
    const cs = districtCandidates(cols, claim, d.size, { bands, blocked, step, limit, band: d.levelBand, gap: 1 });
    const out = [];
    for (const c of cs) {
      const L = layoutStreet({ claim: rectOf(c), survey: S, specs: d.specs, rules: STREET_RULES, shared: d.shared, keepOut });
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
  const P = it._placed ?? placeDistricts({ S, claim, keepOut, blocked, ds, step: it.step, limit: it.limit, exact: it.exact });
  const { bands, cands, pick, unplaced, phases, methods } = P;
  let { exact, bnbNodes, totalCost } = P;
  // ---- route costs between the placed districts' street ends (dry runs, each pair alone)
  const placed = ds.filter((d) => pick.has(d.id));
  const ends = new Map(placed.map((d) => [d.id, streetEnds(pick.get(d.id).L)]));
  const feet = (x, z) => [x, S.groundAt(x, z) + 1, z];
  // the districts' streets and squares are hard to every route (the lots join through this.lots once emitted; before, from the layouts)
  const streetRects = (L) => {
    const o = L.orientation, half = Math.floor(STREET_RULES.streetWidth / 2), sv = L.road.sv;
    const a = toWorld(o, L.u0, sv - half), b = toWorld(o, L.u1, sv + half);
    const q = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    const s = L.shared.rect;
    return [q, [s[0], s[1], s[2], s[3]]];
  };
  const districtHard = placed.flatMap((d) => streetRects(pick.get(d.id).L));
  const layoutLots = placed.flatMap((d) => pick.get(d.id).L.lots.map((l) => [l.rect[0] - 1, l.rect[1] - 1, l.rect[2] + 1, l.rect[3] + 1]));
  const maxGrade = it.maxGrade ?? 0.25;
  // a street end's ground is the street's to clear: no tree obstacle within END_CLEAR of it (the route fells what stands there)
  const endClear = placed.flatMap((d) => ends.get(d.id).map((e) => [e.x - END_CLEAR, e.z - END_CLEAR, e.x + END_CLEAR, e.z + END_CLEAR]));
  const base = r._routeObstacles({ hard: [...districtHard, ...layoutLots, ...standing], clearTrees: endClear });
  const dryOne = (a, b) => {
    const out = PASSES.route(cols, ctx.volumes ?? [], {
      edges: [{ id: 'dry', from: { at: a.at, facing: a.facing }, to: { at: b.at, facing: b.facing }, width: DISTRICT_ROUTE_WIDTH, movers: ['player', 'villager'], ladders: false }],
      maxGrade, hairpinLanding: 3, stairs: true, maxCut: 4, maxFill: 4, margin: 2, hard: base.hard, keepOut, prefer: [], clearTrees: base.clearTrees,
      maxExpanded: DRY_EXPANDED,
    });
    const e = out.data.edges[0];
    return e.ok ? { cost: e.cost, length: e.length } : { cost: DISTRICT_INF, failed: e.failed };
  };
  const endNode = (d, e) => ({ name: `${d.id}_s${e.k}`, at: feet(e.x, e.z), facing: e.facing, e, d });
  const pairs = [];
  const centre = (d) => { const q = pick.get(d.id).rect; return [(q.minX + q.maxX) >> 1, (q.minZ + q.maxZ) >> 1]; };
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
    for (const { ea, eb, dd } of combos) {
      if (best && best.dry.cost < DISTRICT_INF && 10 * dd >= best.dry.cost) continue;
      const na = endNode(A, ea), nb = endNode(B, eb);
      const dry = dryOne(na, nb);
      if (!best || dry.cost < best.dry.cost) best = { na, nb, dry };
    }
    pairs.push({ a: A.id, b: B.id, cost: best.dry.cost, na: best.na, nb: best.nb, dry: best.dry });
  }
  const span = spanningEdges(placed.map((d) => d.id), pairs, loopiness);
  // a district no route reaches (outside the largest component) is unplaced: unreachable
  const main = new Set(span.components[0] ?? []);
  for (const d of placed) if (!main.has(d.id)) { unplaced.push({ id: d.id, reason: 'unreachable', candidates: cands[ds.indexOf(d)].length }); pick.delete(d.id); }
  const chosen = [...span.tree.map((p) => ({ ...p, kind: 'tree' })), ...span.loops.map((p) => ({ ...p, kind: 'loop' }))].filter((p) => pick.has(p.a) && pick.has(p.b));
  // ---- the join to a standing region: the cheapest dry route from a district end to a standing street end in the seam
  let join = null;
  if (beside) {
    const ports = besidePorts(beside).filter((q) => q.end[0] >= claim.minX && q.end[0] <= claim.maxX && q.end[1] >= claim.minZ && q.end[1] <= claim.maxZ);
    if (!ports.length) throw new Error(`NO_JOIN: no street end of region ${beside.id} lies inside this claim (its seam with the standing claim must hold one, at most 16 columns)`);
    let best = null;
    for (const d of ds.filter((x) => pick.has(x.id))) for (const e of ends.get(d.id)) for (const q of ports) {
      const a = endNode(d, e);
      const b = { name: `join_${beside.id}`.replace(/[^a-z0-9_]/g, '_'), at: feet(q.end[0], q.end[1]), facing: [q.dir[0], q.dir[1]] };
        const dry = dryOne(a, b);
      if (dry.cost >= DISTRICT_INF) continue;
      if (!best || dry.cost < best.dry.cost) best = { a, b, q, dry };
    }
    if (!best) throw new Error(`NO_JOIN: no route from a district to region ${beside.id}'s street ends (${ports.map((q) => q.node).join(', ')}) within the grade and the obstacles`);
    join = best;
  }
  // ---- emit: the districts' street layouts, props
  const placedNow = ds.filter((d) => pick.has(d.id));
  if (!placedNow.length) throw new Error(`NO_ROOM: no district could be placed (${unplaced.map((u) => `${u.id}: ${u.reason}`).join(', ')})`);
  const reserved = new Set(), laneCells = [];
  const layouts = {};
  for (const d of placedNow) {
    const c = pick.get(d.id);
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
  // ---- the routes: every chosen edge and the join, in one route pass (ids d_<a>__<b> and join)
  const nodes = {}, edges = [];
  const addNode = (n) => { nodes[n.name] = { at: n.at, kind: 'junction', facing: n.facing }; };
  for (const p of chosen) { addNode(p.na); addNode(p.nb); edges.push({ id: `d_${p.a}__${p.b}`.slice(0, 48), from: p.na.name, to: p.nb.name, width: DISTRICT_ROUTE_WIDTH }); }
  if (join) { addNode(join.a); addNode(join.b); edges.push({ id: 'join', from: join.a.name, to: join.b.name, width: DISTRICT_ROUTE_WIDTH }); }
  let routed = null;
  if (edges.length) routed = r._route({ nodes, edges, maxGrade, stage: stages.routes, part: it.routePart ?? 'routes', hard: [...districtHard, ...standing], keepOut: it.keepOut ?? [], lanterns: true, clearTrees: endClear });
  const byId = new Map((routed?.edges ?? []).map((e) => [e.id, e]));
  // the route ends join their streets: a link edge from each end node to the street's terminal junction
  const linked = new Set();
  const linkEnd = (en) => {
    if (linked.has(en.name) || !r.graph.nodes.some((x) => x.id === en.name)) return;
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
  if (join && byId.get('join')?.ok) {
    linkEnd(join.a);
    // the external edge (7a turns it into a typed link, S-D-2): this region's join node to the standing region's port
    const jn = r.graph.nodes.find((x) => x.id === join.b.name);
    r.graphEdge({ id: 'join_external', from: `${jn.id}.${jn.ports[0].name}`, to: `${beside.id}:${join.q.node}.${join.q.port}`, type: 'road', width: DISTRICT_ROUTE_WIDTH, path: 'route_join', stage: stages.routes, external: true });
  }
  const failed = (routed?.edges ?? []).filter((e) => !e.ok);
  if (join && !byId.get('join')?.ok) throw new Error(`NO_JOIN: the join to region ${beside.id} did not route (${byId.get('join')?.failed ?? 'not routed'})`);
  // ---- anchors (the first district's bell), lamps
  const first = placedNow[0];
  const bell = layouts[first.id].res.bell;
  if (it.anchors !== false) {
    if (!r.anchors.entrance) r.anchor('entrance', bell);
    if (!r.anchors.spawn) r.anchor('spawn', bell);
    for (const d of placedNow) r.anchor(`bell_${d.id}`.slice(0, 32), layouts[d.id].res.bell);
  }
  let lamps = null;
  if (it.lamps !== false) {
    const extra = [], extraCap = {};
    if (it.routeLamps !== false && r.meta.route) for (const e of r.meta.route.edges) { const l = lampSpots(e); extra.push(...l.spots); if (l.spots.length) extraCap[`route:${e.id}`] = l.cap; }
    const fixture = it.lampFixture ? fixtureFor(it.lampFixture, r.material('rail', 'lamp post')) : lampFixture(r);
    const cover = lightCover(r, { fixture, stage: stages.props, keepOut, reserved, laneCells, extra, extraCap });
    lamps = { fixture: cover.fixture, perLot: cover.perLot, before: cover.before, after: cover.after, capped: cover.capped, count: cover.lamps.length };
  }
  // ---- the record
  const rectArr = (q) => [q.minX, q.minZ, q.maxX, q.maxZ];
  const data = {
    loopiness, bands, exact, method: [...methods].join(", "), nodes: bnbNodes, cost: totalCost, phases,
    candidates: Object.fromEntries(ds.map((d, i) => [d.id, cands[i].length])),
    assign: Object.fromEntries(placedNow.map((d) => [d.id, pick.get(d.id).id])),
    rects: Object.fromEntries(placedNow.map((d) => [d.id, rectArr(pick.get(d.id).rect)])),
    bandOf: Object.fromEntries(placedNow.map((d) => [d.id, { want: d.levelBand, got: bandOf(bands, pick.get(d.id).y), y: pick.get(d.id).y }])),
    lots: Object.fromEntries(placedNow.map((d) => [d.id, layouts[d.id].lots.map((l) => l.spec.id)])),
    unplacedLots: Object.fromEntries(placedNow.map((d) => [d.id, layouts[d.id].unplaced.map((u) => u.id)])),
    unplaced,
    pairs: pairs.map((p) => ({ a: p.a, b: p.b, cost: p.cost < DISTRICT_INF ? p.cost : null, failed: p.dry.failed ?? null })),
    edges: [...chosen.map((p) => { const id = `d_${p.a}__${p.b}`.slice(0, 48); const e = byId.get(id); return { id, a: p.a, b: p.b, kind: p.kind, dryCost: p.cost, ok: !!e?.ok, failed: e?.failed ?? null }; }),
      ...(join ? [{ id: 'join', a: join.a.d.id, b: `${beside.id}:${join.q.node}`, kind: 'join', dryCost: join.dry.cost, ok: !!byId.get('join')?.ok, failed: byId.get('join')?.failed ?? null }] : [])],
    treeCost: span.treeCost, loopCost: span.loopCost, failedEdges: failed.map((e) => e.id),
    join: join ? { region: beside.id, node: join.q.node, port: join.q.port, at: join.b.at, from: join.a.name, district: join.a.d.id } : null,
    bells: Object.fromEntries(placedNow.map((d) => [d.id, layouts[d.id].res.bell])),
    lamps, ms: Math.round(performance.now() - t0),
  };
  if (it.meta !== false) r.meta.districts = data;
  r.note(`pass districts: ${placedNow.length}/${ds.length} placed (${data.method}${exact ? '' : ', not exact'}), ${chosen.length} edge(s) (${span.tree.length} tree, ${span.loops.length} loop), loop cost ${span.loopCost} of tree ${span.treeCost}${join ? `, joined to ${beside.id} at ${join.q.node}` : ''}${unplaced.length ? `; unplaced: ${unplaced.map((u) => `${u.id} (${u.reason})`).join(', ')}` : ''}`);
  return { data, layouts, ends: Object.fromEntries(placedNow.map((d) => [d.id, ends.get(d.id)])), reserved, laneCells };
}

export { LOT_UNPLACED, UNPLACED };
