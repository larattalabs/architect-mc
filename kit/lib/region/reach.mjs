// (6c D3) A district's join into a standing region town's claim (docs/CONTRACT.md "Phase 6c slice D3" §2, §3, §5): the reach inputs
// (ctx.besideReach: the town claim's survey, the held columns, the standing data), the reach frame's survey (the district's claim and
// the town's on one grid), the town's street network (§3.1), the join's candidates (a street end continuing its line, §3.3; a street's
// side as a T junction, §3.2) with their contact columns (§3.4), and the obstacles the reach step routes around (§5). Plan time only,
// pure, deterministic (integer geometry; ties by kind, road id, x, z).
import { FLAG_MISSING, FLAG_WATER, asColumns, makeColumns } from './pack.mjs';
import { sampleIndex, surveyApi } from './survey.mjs';
import { isStreetId, keyRuns, runKeys } from './beside.mjs';

/** At most this many dry routes in the reach step (§2.2). */
export const REACH_DRY_MAX = 48;
/** Each reach dry route gives up after this many A* expansions (D2's cap). */
export const REACH_EXPANDED = 2_000_000;
/** A street side offers a junction point at most every this many cells along a run (§2.2). */
export const SIDE_EVERY = 4;
/** A straight run of a street offers side points only when it is at least this long (§3.1). */
export const SIDE_MIN_RUN = 9;
/** A side point keeps this far from the run's ends and from any other junction of the street (§3.2). */
export const SIDE_CLEAR = 3;
/** The join's last cells run straight into its junction (§3.2, §3.3). */
export const LEAD = 3;
/** The join's route lamps skip spots within this many cells of a town lamp (N-D3-2, the coordinator's decision). */
export const LAMP_GAP = 6;

const rectOf = (c) => [c.minX, c.minZ, c.maxX, c.maxZ];
const inRect = (q, x, z) => x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3];
const meets = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const runsOk = (a) => Array.isArray(a) && a.length <= 1 << 20 && a.every((q) => Array.isArray(q) && q.length === 4 && q.every(Number.isInteger) && q[0] <= q[2] && q[1] <= q[3]);

/**
 * Validate `besideReach` (the mod's region.plan member, the kit's --beside-reach): `{survey (ARSV bytes or a columns object, resolution 1,
 * the town's claim), held: {runs, town, terrain}, standing: besideStanding(...)}`. Throws on a bad shape; returns it normalised.
 */
export function parseBesideReach(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('besideReach must be an object');
  const survey = asColumns(o.survey);
  if (survey.resolution !== 1) throw new Error('besideReach.survey must be a resolution-1 survey');
  const h = o.held ?? {};
  for (const k of ['runs', 'town', 'terrain']) if (!runsOk(h[k] ?? [])) throw new Error(`besideReach.held.${k} must be row runs [x0, z, x1, z]`);
  const st = o.standing;
  if (!st || typeof st.id !== 'string' || !Array.isArray(st.claim) || st.claim.length !== 4) throw new Error('besideReach.standing must name the standing region (id, claim)');
  return {
    survey,
    held: { runs: (h.runs ?? []).map((q) => [...q]), town: (h.town ?? []).map((q) => [...q]), terrain: (h.terrain ?? []).map((q) => [...q]) },
    standing: JSON.parse(JSON.stringify(st)),
  };
}

/**
 * The reach inputs as a plan gets them: one (a districts plan beside a town: `{survey, held, standing}`) or, for a plan check whose
 * endpoint.region names standing regions, a map {regionId: inputs} (at most 2). Returns the parsed one or map.
 */
export function parseReachInput(o) {
  if (o && typeof o === 'object' && !Array.isArray(o) && o.survey !== undefined) return parseBesideReach(o);
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('besideReach must be an object');
  const ids = Object.keys(o).sort();
  if (ids.length > 2) throw new Error('besideReach: at most 2 standing regions per plan');
  return Object.fromEntries(ids.map((id) => [id, parseBesideReach(o[id])]));
}

/** The reach inputs of one standing region from a parsed besideReach (one or a map), or null. */
export function reachFor(R, id) {
  if (!R) return null;
  if (R.survey) return R.standing?.id === id ? R : null;
  return R[id] ?? null;
}

/**
 * The reach frame's survey: the bounding box of the district's claim and the town's on one resolution-1 grid. A column of the district's
 * claim is the plan survey's, one of the town's claim (outside the district's) the reach survey's, any other FLAG_MISSING.
 */
export function unionColumns(planCols, reachCols, claim, town) {
  const x0 = Math.min(claim[0], town[0]), z0 = Math.min(claim[1], town[1]), x1 = Math.max(claim[2], town[2]), z1 = Math.max(claim[3], town[3]);
  const W = x1 - x0 + 1, D = z1 - z0 + 1;
  const out = makeColumns(x0, z0, W, D, 1);
  const rx0 = reachCols.minX, rz0 = reachCols.minZ, rx1 = rx0 + reachCols.width - 1, rz1 = rz0 + reachCols.depth - 1;
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    const x = x0 + i, z = z0 + j, o = i + j * W;
    let src = null, k = -1;
    if (inRect(claim, x, z)) { src = planCols; k = sampleIndex(planCols, x, z); }
    else if (inRect(town, x, z) && x >= rx0 && x <= rx1 && z >= rz0 && z <= rz1) { src = reachCols; k = (x - rx0) + (z - rz0) * reachCols.width; }
    if (!src) { out.flags[o] = FLAG_MISSING; continue; }
    out.ground[o] = src.ground[k]; out.height[o] = src.height[k]; out.floor[o] = src.floor[k]; out.flags[o] = src.flags[k];
  }
  return out;
}

/** A surveyApi-like reader over a columns object (ground, top, floor, water, missing). */
export function columnsApi(c) {
  const at = (x, z) => sampleIndex(c, x, z);
  return {
    columns: c, resolution: c.resolution,
    heightAt: (x, z) => c.ground[at(x, z)], groundAt: (x, z) => c.ground[at(x, z)], floorAt: (x, z) => c.floor[at(x, z)],
    topAt: (x, z) => Math.max(c.height[at(x, z)], c.ground[at(x, z)]),
    waterAt: (x, z) => (c.flags[at(x, z)] & FLAG_WATER) !== 0,
    missingAt: (x, z) => x < c.minX || z < c.minZ || x >= c.minX + c.width || z >= c.minZ + c.depth || (c.flags[at(x, z)] & FLAG_MISSING) !== 0,
  };
}

/**
 * The town's street network (§3.1) from its standing data and graph: `ends` (terminal junctions whose one edge is a street: node, port,
 * at, the past-end cell `end`, the outward `dir`, its road) and `runs` (each street road's axis-aligned segments of at least SIDE_MIN_RUN
 * cells: road, axis 'x'|'z', the centre line `c`, `u0..u1`, `y`, `hw` (the footprint's half width: half the road plus its verge), and the
 * junctions on it). Routes between districts, joins, lanes, paths and squares are not streets.
 */
export function streetNetwork(standing, graph) {
  const roads = new Map((standing.streets ?? []).map((s) => [s.id, s]));
  const isStreet = (e) => !e.external && (roads.has(e.path) || isStreetId(e.path) || (!e.path && isStreetId(e.id)));
  const nodes = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
  const deg = new Map(), first = new Map();
  for (const e of graph?.edges ?? []) {
    if (e.external) continue;
    for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) {
      const n = String(a).split('.')[0];
      deg.set(n, (deg.get(n) ?? 0) + 1);
      if (!first.has(n)) first.set(n, { other: String(b).split('.')[0], port: String(a).split('.')[1], e });
    }
  }
  const ends = [];
  for (const [id, n] of nodes) {
    if (n.kind !== 'junction' || deg.get(id) !== 1) continue;
    const f = first.get(id);
    if (!isStreet(f.e)) continue;
    const o = nodes.get(f.other);
    if (!o) continue;
    const dx = Math.sign(n.at[0] - o.at[0]), dz = Math.sign(n.at[2] - o.at[2]);
    if ((dx !== 0) === (dz !== 0)) continue;
    ends.push({ node: id, port: f.port, road: f.e.path ?? f.e.id, at: [...n.at], end: [n.at[0] + dx, n.at[2] + dz], dir: [dx, dz] });
  }
  ends.sort((p, q) => (p.node < q.node ? -1 : p.node > q.node ? 1 : 0));
  // the junctions of each street road (the nodes its edges meet)
  const juncOf = new Map();
  for (const e of graph?.edges ?? []) {
    if (!isStreet(e)) continue;
    const rid = e.path ?? e.id;
    if (!juncOf.has(rid)) juncOf.set(rid, new Set());
    for (const a of [e.from, e.to]) { const n = nodes.get(String(a).split('.')[0]); if (n) juncOf.get(rid).add(n); }
  }
  const runs = [];
  for (const s of standing.streets ?? []) {
    const hw = Math.floor((s.width ?? 3) / 2) + 1;
    const js = [...(juncOf.get(s.id) ?? [])];
    for (let i = 0; i + 1 < s.points.length; i++) {
      const a = s.points[i], b = s.points[i + 1];
      const axis = a[2] === b[2] ? 'x' : a[0] === b[0] ? 'z' : null;
      if (!axis) continue;
      const u0 = Math.min(axis === 'x' ? a[0] : a[2], axis === 'x' ? b[0] : b[2]), u1 = Math.max(axis === 'x' ? a[0] : a[2], axis === 'x' ? b[0] : b[2]);
      if (u1 - u0 + 1 < SIDE_MIN_RUN) continue;
      const c = axis === 'x' ? a[2] : a[0];
      const on = js.filter((n) => (axis === 'x' ? n.at[2] === c && n.at[0] >= u0 && n.at[0] <= u1 : n.at[0] === c && n.at[2] >= u0 && n.at[2] <= u1)).map((n) => (axis === 'x' ? n.at[0] : n.at[2]));
      runs.push({ road: s.id, axis, c, u0, u1, y: a[1], hw, junctions: [...new Set(on)].sort((p, q) => p - q) });
    }
  }
  return { ends, runs };
}

/** (u, v) along a run (u along its axis, v across) to world [x, z]. */
const world = (axis, u, v) => (axis === 'x' ? [u, v] : [v, u]);

/**
 * The reach step's standing obstacles and classes (§5): `lot` (lots + 1), `keep` ("x,z" -> footprint pieces), `body` (hard and watch
 * columns), `held`, `town`, `terrain` and `others` (held by another owner), `lamps`, `props`. Keys "x,z".
 */
export function reachClasses(reach) {
  const st = reach.standing;
  const lot = new Set();
  for (const q of st.footprint?.lots ?? []) runKeys([[q[0] - 1, q[1] - 1, q[2] + 1, q[3] + 1]], lot);
  const keep = new Map();
  for (const p of st.footprint?.keep ?? []) for (const k of runKeys([p.rect])) { if (!keep.has(k)) keep.set(k, []); keep.get(k).push(p); }
  const body = runKeys(st.bodies?.hard ?? []);
  runKeys(st.bodies?.watch ?? [], body);
  const held = runKeys(reach.held.runs), town = runKeys(reach.held.town), terrain = runKeys(reach.held.terrain);
  const others = new Set([...held].filter((k) => !town.has(k)));
  return { lot, keep, body, held, town, terrain, others, lamps: runKeys(st.lamps ?? []), props: runKeys(st.props ?? []) };
}

/**
 * A contact column (§3.4): outside the town's lots + 1, its footprint and its bodies, surveyed and dry, inside the frame, and held at most
 * by the town's terrain set. Returns null when it may be one, else the reason.
 */
export function contactProblem(K, api, frame, k, { unsafe = {} } = {}) {
  const [x, z] = k.split(',').map(Number);
  if (!frame.some((q) => inRect(q, x, z))) return 'outside the frame';
  if (api.missingAt(x, z)) return 'not surveyed';
  if (api.waterAt(x, z)) return 'water';
  if (K.lot.has(k)) return 'a lot';
  if (K.keep.has(k)) return `the town's ${K.keep.get(k)[0].kind} ${K.keep.get(k)[0].id}`;
  if (K.body.has(k)) return "a town body's";
  if (!unsafe.ignoreHeld && K.held.has(k) && !K.terrain.has(k)) return K.others.has(k) ? "another site's" : "held by the town's own writes";
  return null;
}

/**
 * The join's candidates in the town (§2.2, §3.2, §3.3): every street end (its past-end cell, continuing its line) and, on each straight
 * run of a street, each side's T points (every SIDE_EVERY cells and the point nearest each district end's projection). Each candidate
 * `{kind: 'end'|'side', road, node?, port?, side?, u?, at: [x, y, z] (feet, the junction cell), facing: [dx, dz] (away from the street),
 * contact: ["x,z"] (its contact columns), hold: ["x,z"] (the contact columns the town's terrain holds), junction}`, sorted by kind (ends
 * first), road id, x, z. `dropped` counts the rejected points by reason.
 */
export function reachCandidates({ reach, K, api, net, frame, districtEnds = [], unsafe = {} }) {
  const out = [], dropped = {};
  const drop = (why) => { dropped[why] = (dropped[why] ?? 0) + 1; };
  const feet = (x, z) => [x, api.groundAt(x, z) + 1, z];
  const tryContact = (keys) => { for (const k of keys) { const p = contactProblem(K, api, frame, k, { unsafe }); if (p) return p; } return null; };
  // ---- street ends: the past-end cell and LEAD cells past it, 3 wide (§3.3, §3.4)
  for (const q of net.ends) {
    const [dx, dz] = q.dir, px = -dz, pz = dx;
    const keys = [];
    for (let t = 0; t <= LEAD; t++) for (let v = -1; v <= 1; v++) keys.push(`${q.end[0] + dx * t + px * v},${q.end[1] + dz * t + pz * v}`);
    const p = tryContact(keys);
    if (p) { drop(`end: ${p}`); continue; }
    // the junction's feet at the street's own surface (its end cell in the survey after the town): the join meets it level
    const at = [q.end[0], api.groundAt(q.at[0], q.at[2]) + 1, q.end[1]];
    out.push({ kind: 'end', road: q.road, node: q.node, port: q.port, at, facing: [dx, dz], contact: keys, hold: keys.filter((k) => K.terrain.has(k)), junction: { kind: 'end', at: [...at] } });
  }
  // ---- street sides (§3.2)
  for (const run of net.runs) {
    const { axis, c, u0, u1, hw } = run;
    const us = new Set();
    for (let u = u0 + SIDE_CLEAR; u <= u1 - SIDE_CLEAR; u += SIDE_EVERY) us.add(u);
    for (const e of districtEnds) { const u = Math.max(u0 + SIDE_CLEAR, Math.min(u1 - SIDE_CLEAR, axis === 'x' ? e.x : e.z)); if (u <= u1 - SIDE_CLEAR) us.add(u); }
    for (const u of [...us].sort((a, b) => a - b)) {
      if (run.junctions.some((j) => Math.abs(j - u) < SIDE_CLEAR)) { drop('side: near a junction'); continue; }
      for (const s of [-1, 1]) {
        const vE = c + (hw + 1) * s, vV = c + hw * s;
        const key = (uu, vv) => { const w = world(axis, uu, vv); return `${w[0]},${w[1]}`; };
        // the landing strip (5 along, 1 deep) and the lead (LEAD deep, 3 wide)
        const strip = [], lead = [], verge = [];
        for (let k = -2; k <= 2; k++) strip.push(key(u + k, vE));
        for (let t = 1; t <= LEAD; t++) for (let k = -1; k <= 1; k++) lead.push(key(u + k, vE + t * s));
        for (let k = -1; k <= 1; k++) verge.push(key(u + k, vV));
        const p = tryContact([...strip, ...lead]);
        if (p) { drop(`side: ${p}`); continue; }
        // the verge contact: the street's own road or verge only (no lamp, prop, lane, other site); never written
        let vp = null;
        for (const k of verge) {
          const [x, z] = k.split(',').map(Number);
          if (api.missingAt(x, z)) { vp = 'verge not surveyed'; break; }
          if (K.lot.has(k)) { vp = 'verge in a lot'; break; }
          if (K.lamps.has(k) || K.props.has(k)) { vp = 'a lamp or prop on the verge'; break; }
          if (K.others.has(k)) { vp = "another site's verge"; break; }
          if (K.body.has(k)) { vp = "a body's verge"; break; }
          const pcs = K.keep.get(k) ?? [];
          if (pcs.some((pc) => !(pc.id === run.road || /(^|_)verges$/.test(pc.id)))) { vp = `the town's ${pcs.find((pc) => !(pc.id === run.road || /(^|_)verges$/.test(pc.id))).id} at the verge`; break; }
        }
        if (vp && !unsafe.writeVerge) { drop(`side: ${vp}`); continue; }
        // the height: E's floor within 1 of the verge's surface
        const [ex, ez] = world(axis, u, vE), [gx, gz] = world(axis, u, vV);
        if (!unsafe.writeVerge && Math.abs(api.groundAt(ex, ez) - api.groundAt(gx, gz)) > 1) { drop('side: height'); continue; }
        const contact = [...strip, ...lead];
        const fs = axis === 'x' ? [0, s] : [s, 0];
        const sideName = axis === 'x' ? (s > 0 ? 's' : 'n') : (s > 0 ? 'e' : 'w');
        // (E's feet at the verge's surface: the T meets the street level, E's floor within 1 of it)
        const at = [ex, api.groundAt(gx, gz) + 1, ez];
        out.push({ kind: 'side', road: run.road, side: sideName, u, at, facing: fs, contact, verge, hold: contact.filter((k) => K.terrain.has(k)), junction: { kind: 'side', at: [...at], side: sideName, u } });
      }
    }
  }
  out.sort((p, q) => (p.kind === q.kind ? 0 : p.kind === 'end' ? -1 : 1) || (p.road < q.road ? -1 : p.road > q.road ? 1 : 0) || p.at[0] - q.at[0] || p.at[2] - q.at[2]);
  return { candidates: out, dropped };
}

/**
 * The reach step's hard columns (§5.1, §5.2): every held column, the town's whole-claim footprint (lots + 1, roads + 1, paths, ways) and its
 * bodies' hard and watch columns, in the town's claim outside the district's (inside it, D1's obstacles hold). A candidate's own contact
 * columns are taken out for its route (`hardRects`). `_unsafe.ignoreHeld` leaves the held set out (the broken variant). "x,z" keys.
 */
export function reachHardKeys(K, claim, town, { unsafe = {} } = {}) {
  const keys = new Set();
  const add = (k) => { const i = k.indexOf(','); const x = Number(k.slice(0, i)), z = Number(k.slice(i + 1)); if (inRect(town, x, z) && !inRect(claim, x, z)) keys.add(k); };
  for (const k of K.lot) add(k);
  for (const k of K.keep.keys()) add(k);
  for (const k of K.body) add(k);
  if (!unsafe.ignoreHeld) for (const k of K.held) add(k);
  return keys;
}

/** The hard rects (row runs) for one candidate: the reach hard columns less its contact columns. */
export function hardRects(keys, cand) {
  const contact = new Set(cand?.contact ?? []);
  return keyRuns([...keys].filter((k) => !contact.has(k)));
}

/**
 * `wall` (§2.5, S-D3-5): every candidate's junction cell is enclosed by columns another owner holds (a wall round the town): a 4-connected
 * flood over the frame from the district ends that never crosses such a column reaches none of them.
 */
export function wallEncloses(K, frame, starts, candidates) {
  if (!candidates.length || !K.others.size) return false;
  const bb = [Math.min(...frame.map((q) => q[0])), Math.min(...frame.map((q) => q[1])), Math.max(...frame.map((q) => q[2])), Math.max(...frame.map((q) => q[3]))];
  const W = bb[2] - bb[0] + 1, D = bb[3] - bb[1] + 1;
  const seen = new Uint8Array(W * D);
  const ok = (x, z) => frame.some((q) => inRect(q, x, z)) && !K.others.has(`${x},${z}`);
  const q = [];
  for (const [x, z] of starts) if (ok(x, z)) { const k = (x - bb[0]) + (z - bb[1]) * W; if (!seen[k]) { seen[k] = 1; q.push(k); } }
  for (let h = 0; h < q.length; h++) {
    const k = q[h], i = k % W, j = (k - i) / W;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= D) continue;
      const nk = ni + nj * W;
      if (seen[nk] || !ok(bb[0] + ni, bb[1] + nj)) continue;
      seen[nk] = 1; q.push(nk);
    }
  }
  return candidates.every((c) => { const x = c.at[0], z = c.at[2]; return x < bb[0] || z < bb[1] || x > bb[2] || z > bb[3] || !seen[(x - bb[0]) + (z - bb[1]) * W]; });
}

/** Whether two claims are one area for the reach frame: they overlap or touch (§2.5 `apart`). */
export const claimsMeet = (a, b) => meets([a[0] - 1, a[1] - 1, a[2] + 1, a[3] + 1], b);

export { rectOf, inRect };

/**
 * (6c D3, §2.2) The reach step's choice (pure): over the reach frame (`claim` and the standing region's claim), the candidates of its
 * street network, and the cheapest dry route (T2 cost) from a district end (`districtEnds`: [{x, z, at, facing}]) to one. Pairs go in
 * order of their 10-a-cell lower bound and stop once the bound can't win; at most REACH_DRY_MAX dry routes of REACH_EXPANDED expansions
 * each. Ties: the candidates' order (ends first, road id, x, z). Throws `NO_JOIN: [kind] ...` (apart, street, wall, route, budget).
 * `route`: the route pass (passes/route.mjs routePass). Returns {best: {end, dry}, cand, api, U, frame, claimR, town, K, hardKeys, hard,
 * noRetain, nearTownLamp, tried, count, candidates}.
 */
export function chooseReach({ planCols, R, beside, claim, yRange = [-64, 319], districtEnds, baseHard = [], clearTrees = [], keepOut = [], maxGrade = 0.25, volumes = [], seamPorts = 0, unsafe = {}, route }) {
  const claimR = [...claim], town = [...beside.claim];
  const why = seamPorts ? `no dry route from a district to its ${seamPorts} street end(s) in the seam` : 'no street end of it lies inside this claim';
  if (!claimsMeet(claimR, town)) throw new Error(`NO_JOIN: [apart] this claim neither overlaps nor touches region ${beside.id}'s claim, so the join can't reach into it (${why})`);
  const net = streetNetwork(R.standing, beside.graph);
  if (!net.ends.length && !net.runs.length) throw new Error(`NO_JOIN: [street] region ${beside.id}'s graph has no street run (${why})`);
  const U = unionColumns(planCols, R.survey, claimR, town);
  const api = { ...surveyApi(U, { minX: U.minX, minZ: U.minZ, maxX: U.minX + U.width - 1, maxZ: U.minZ + U.depth - 1, minY: yRange[0], maxY: yRange[1] }),
    missingAt: (x, z) => x < U.minX || z < U.minZ || x >= U.minX + U.width || z >= U.minZ + U.depth || (U.flags[(x - U.minX) + (z - U.minZ) * U.width] & FLAG_MISSING) !== 0 };
  const frame = [claimR, town];
  const K = reachClasses(R);
  const { candidates, dropped } = reachCandidates({ reach: R, K, api, net, frame, districtEnds, unsafe });
  if (!candidates.length) throw new Error(`NO_JOIN: [route] no street end or side of region ${beside.id} offers a junction (${Object.entries(dropped).map(([k, v]) => `${v} ${k}`).join('; ') || 'none'}; ${why})`);
  if (wallEncloses(K, frame, districtEnds.map((q) => [q.x, q.z]), candidates)) throw new Error(`NO_JOIN: [wall] every street end and side of region ${beside.id} is enclosed by another owner's held columns (a wall round the town: joining through its gate is 7a's) (${why})`);
  const hardKeys = reachHardKeys(K, claimR, town, { unsafe });
  const cheb = (p, q) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]));
  const pairs = [];
  candidates.forEach((c, ci) => districtEnds.forEach((q, qi) => pairs.push({ c, ci, q, qi, bound: 10 * cheb([q.x, q.z], [c.at[0], c.at[2]]) })));
  pairs.sort((p, q) => p.bound - q.bound || p.ci - q.ci || p.qi - q.qi);
  let best = null, tried = 0, cut = false;
  for (const pr of pairs) {
    if (best && pr.bound >= best.dry.cost) break;
    if (tried >= REACH_DRY_MAX) { cut = true; break; }
    tried++;
    const out = route(U, volumes, {
      edges: [{ id: 'dry', from: { at: pr.q.at, facing: pr.q.facing }, to: { at: pr.c.at, facing: pr.c.facing, lead: LEAD }, width: 3, movers: ['player', 'villager'], ladders: false, frame }],
      maxGrade, hairpinLanding: 3, stairs: true, maxCut: 4, maxFill: 4, margin: 2, hard: [...baseHard, ...hardRects(hardKeys, pr.c)], keepOut, prefer: [], clearTrees,
      maxExpanded: REACH_EXPANDED, frame: [claimR],
    });
    const e = out.data.edges[0];
    if (!e.ok) continue;
    if (!best || e.cost < best.dry.cost || (e.cost === best.dry.cost && pr.ci < best.ci)) best = { end: pr.q, dry: { cost: e.cost, length: e.length }, ci: pr.ci, cand: pr.c, path: e.path };
  }
  if (!best) {
    if (cut) throw new Error(`NO_JOIN: [budget] ${REACH_DRY_MAX} dry routes into region ${beside.id} found none (${candidates.length} candidate(s), ${pairs.length} pair(s); ${why})`);
    throw new Error(`NO_JOIN: [route] no route from a district to region ${beside.id}'s ${candidates.length} street end(s) and side(s) within the grade and the obstacles (${tried} tried; ${why})`);
  }
  const contact = new Set(best.cand.contact);
  // a retaining column outside this claim only where the reach may write (never a held column, the footprint or a body)
  const noRetain = (x, z) => !inRect(claimR, x, z) && (hardKeys.has(`${x},${z}`) || !inRect(town, x, z)) && !contact.has(`${x},${z}`);
  const lamps = [...K.lamps].map((k) => k.split(',').map(Number));
  const nearTownLamp = (x, z) => lamps.some(([lx, lz]) => Math.max(Math.abs(lx - x), Math.abs(lz - z)) <= LAMP_GAP);
  return { best, cand: best.cand, api, U, frame, claimR, town, K, hardKeys, hard: hardRects(hardKeys, best.cand), noRetain, nearTownLamp, tried, count: candidates.length, candidates };
}
