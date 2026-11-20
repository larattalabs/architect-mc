// (6c D3, D-S3; docs/CONTRACT.md "Phase 6c slice D3" §6) `architect_mc:land`: the land a districts region takes, for every kind (beside a
// town or not; plain, following, outpost; a street-end or a side join), from its IR alone. The mod computes the same record in
// region/DistrictLand.java at realise (the two are unit-checked equal on every fixture). Not in the IR: IRs are unchanged.
//   parts     district (a following district's columns as a mask; a plain district's or an outpost's as the rect round them), join (the
//             join's written columns, its reach and its claim part together, and the contact columns it holds), route (each route between
//             districts), corridor (an outpost's architect_mc:corridor, exactly), extra (written columns in no other part: lamps, a lane's end)
//   union     every part's columns, but a corridor column in the town's claim that nothing writes (the corridor's margin never claims town land)
//   outside   union minus the town's claim (the land Steward owns); inside: union in the town's claim (the join's reach, any seam cells)
// Written columns: every op's columns (`columns` ops' cells, `bounds` ops' rects), the lots' boxes, the road items' width plus their verge,
// and a reach plan's reach. A seam-step join's graded runs are read from their path boxes (the IR keeps no per-path column list there).
import { keyRuns, runKeys } from './beside.mjs';
import { centreCells, crossOffsets, rightOf, segmentAxis } from './geom.mjs';
/** (RTE) program.mjs ROUTE_EXT: the ext key a route piece names its graph edge under. */
const ROUTE_EXT = 'architect_mc:route';
/**
 * (RTE4) The ext key a district's own road names its district under, `{id}`: written by the districts pass only where one district id is
 * another's plus `_` and a word (`b` and `b_street`, districtIdsShadow), where the id cannot say whose `b_street_w` is.
 */
export const DISTRICT_EXT = 'architect_mc:district';

/** The record's version (6d's grown parts move it to 2, §11). */
export const LAND_V = 1;
/** (6d GR §7) The record's version once the region has had a revision (it stays 2 after undoRevision). */
export const LAND_V2 = 2;

const k2 = (x, z) => `${x},${z}`;
function opCols(op, into) {
  if (op.op === 'columns' && Array.isArray(op.cols)) { for (let i = 0; i + 4 < op.cols.length; i += 5) into.add(k2(op.cols[i], op.cols[i + 1])); return; }
  const b = op.bounds;
  if (b && Number.isFinite(b.minX) && Number.isFinite(b.maxX)) for (let z = b.minZ; z <= b.maxZ; z++) for (let x = b.minX; x <= b.maxX; x++) into.add(k2(x, z));
}
function roadCols(rd, into) {
  const pts = rd.points.map((p) => [p[0], p[2]]);
  const { cells } = centreCells(pts);
  const w = (rd.width ?? 3) + 2;
  for (const c of cells) {
    const a = pts[Math.min(c.seg, pts.length - 1)], b = pts[Math.min(c.seg + 1, pts.length - 1)];
    const r = rightOf(segmentAxis(a, b));
    for (const k of crossOffsets(w)) into.add(k2(c.x + r[0] * k, c.z + r[1] * k));
  }
}
const ids0 = (ir) => (ir.params?.spec?.districts ?? ir.params?.districts ?? []).map((d) => d.id);
/**
 * (RTE2) The district `id` names (`<d>_<word>`: `b_1_pads` is b_1's, not b's): the longest of `ids` that `id` extends past `pre`, or null.
 * A district's own ids go on with a word (pads, lanes, street_w, props_lamp, retain), never a digit, so the longest is exact unless one
 * district's id is another's plus a word of those (`b_street`).
 */
export function districtOfId(id, ids, pre = '') {
  let best = null;
  for (const d of ids) if (typeof d === 'string' && String(id).startsWith(`${pre}${d}_`) && (best === null || d.length > best.length)) best = d;
  return best;
}
/**
 * (RTE4) Whether some district id is another's plus `_` and a letter-led word (`b` and `b_street`, `b` and `b_props`): then an id such as
 * `b_street_w` (b's street road) reads as the longer district's, and the districts pass records each district's roads (DISTRICT_EXT).
 * A digit after the `_` (`b` and `b_1`) is not: a district's own ids go on with a word, so the longest id reads them exactly (RTE2).
 */
export function districtIdsShadow(ids) {
  const s = ids.filter((d) => typeof d === 'string');
  return s.some((a) => s.some((b) => b.length > a.length + 1 && b.startsWith(`${a}_`) && /^[a-z]/.test(b.slice(a.length + 1))));
}
/**
 * (RTE4) A road's district: the one its DISTRICT_EXT tag names (a string id; one `ids` lacks: none), else, untagged (every plan without
 * such ids, a region planned before RTE4), the longest district id it names, as before.
 */
export function districtOfRoad(rd, ids) {
  const t = rd?.ext?.[DISTRICT_EXT]?.id;
  if (typeof t === 'string') return ids.includes(t) ? t : null;
  return districtOfId(rd?.id ?? '', ids);
}
const boxCols = (b, into) => { for (let z = b.minZ; z <= b.maxZ; z++) for (let x = b.minX; x <= b.maxX; x++) into.add(k2(x, z)); };
const rectOfKeys = (keys) => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const k of keys) { const i = k.indexOf(','); const x = Number(k.slice(0, i)), z = Number(k.slice(i + 1)); if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return Number.isFinite(x0) ? [x0, z0, x1, z1] : null;
};

/**
 * `architect_mc:land` of a districts region: `ir` (its IR), `standingClaim` ([x0, z0, x1, z1] of the region it stands beside, or null),
 * `standingRemoved` (the time the standing region was removed, or null). Returns the record (§6's shape), or null for an IR that is not a
 * districts plan (no districts in its params).
 */
export function districtLand(ir, standingClaim = null, { standingRemoved = null, revised = false } = {}) {
  const ds = ir.params?.spec?.districts ?? ir.params?.districts ?? null;
  if (!Array.isArray(ds)) return null;
  const town = Array.isArray(standingClaim) ? standingClaim : null;
  const inTown = (k) => { if (!town) return false; const i = k.indexOf(','); const x = Number(k.slice(0, i)), z = Number(k.slice(i + 1)); return x >= town[0] && x <= town[2] && z >= town[1] && z <= town[3]; };
  // ((6d GR §7) v 2 once the region has had a revision (an effective IR with revisions, or `revised`: the mod's record says one was
  // accepted). A revision's parts, lots and roads (the effective IR's entries carrying `rid`) are its own `grown` part, never a district's
  // or `extra`; every part carries `revision` (0: the realised plan's). An ungrown region's record is v 1, byte-identical.)
  const v2 = revised || (Array.isArray(ir.revisions) && ir.revisions.length > 0);
  const ridOf = (x) => (Number.isInteger(x?.rid) && x.rid > 0 ? x.rid : 0);
  const grownBy = new Map(); // rid -> {cols: Set, district, mask?}
  // ((RTE3) a band once per revision: a grouped growth street stamps the same band on each of its groups, which made two equal district parts)
  if (v2) {
    const g = (rid) => { if (!grownBy.has(rid)) grownBy.set(rid, { cols: new Set(), districts: new Set(), bands: [] }); return grownBy.get(rid); };
    for (const p of ir.parts ?? []) if (ridOf(p)) { const q = g(p.rid); for (const op of p.ops ?? []) opCols(op, q.cols); const d = districtOfId(p.id, ids0(ir), `rv${p.rid}_`); if (d) q.districts.add(d); }
    for (const l of ir.lots ?? []) if (ridOf(l)) { const q = g(l.rid); boxCols(l.box, q.cols); }
    for (const rd of ir.roads ?? []) if (ridOf(rd)) { const q = g(rd.rid); roadCols(rd, q.cols); const d = rd.ext?.['architect_mc:street']?.district; if (typeof d === 'string') q.districts.add(d); const b = rd.ext?.['architect_mc:band']; if (b && typeof b.district === 'string' && Array.isArray(b.runs) && !q.bands.some((o) => o.district === b.district && JSON.stringify(o.runs) === JSON.stringify(b.runs))) q.bands.push(b); }
  }
  ir = v2 ? { ...ir, parts: (ir.parts ?? []).filter((p) => !ridOf(p)), lots: (ir.lots ?? []).filter((l) => !ridOf(l)), roads: (ir.roads ?? []).filter((x) => !ridOf(x)) } : ir;
  const partById = new Map((ir.parts ?? []).map((p) => [p.id, p]));
  const written = new Set();
  for (const p of ir.parts ?? []) for (const op of p.ops ?? []) opCols(op, written);
  for (const l of ir.lots ?? []) boxCols(l.box, written);
  for (const rd of ir.roads ?? []) roadCols(rd, written);
  for (const k of runKeys(ir.reach?.runs ?? [])) written.add(k);
  const parts = [];
  const claimed = new Set();
  const push = (kind, id, keys, extra = {}) => {
    if (!keys.size) return;
    const runs = keyRuns(keys);
    let inside = 0;
    for (const k of keys) { claimed.add(k); if (inTown(k)) inside++; }
    parts.push({ kind, id, ...extra, runs, rect: rectOfKeys(keys), cells: keys.size, insideCells: inside });
  };
  // ---- the districts (placed: a part or a lot of theirs in the IR)
  const ids = ds.map((d) => d.id).filter((id) => typeof id === 'string');
  // ((RTE2) each part, lot and road is one district's: the longest district id it names (b_1_pads is b_1's, never b's too); a following
  // district's street piece the district whose street edge it names (ext architect_mc:route.edge `route_st_<id>`), untagged the longest
  // district with a street edge in the graph (`route_st_b_1_1` untagged: b_1's when b_1 has a street, else b's group); (RTE4) a road
  // tagged with its district (DISTRICT_EXT, written where one id is another's plus a word: b's `b_street_w` beside district b_street) is
  // that district's)
  const stEdges = new Set((ir.graph?.edges ?? []).map((e) => e.id).filter((e) => typeof e === 'string' && e.startsWith('route_st_')));
  const stIds = ids.filter((id) => !stEdges.size || stEdges.has(`route_st_${id}`));
  const streetOf = (x) => {
    const t = x.ext?.[ROUTE_EXT]?.edge;
    if (typeof t === 'string') return t.startsWith('route_st_') && ids.includes(t.slice('route_st_'.length)) ? t.slice('route_st_'.length) : null;
    return districtOfId(x.id, stIds, 'route_st_');
  };
  for (const d of ds) {
    const mine = (id) => districtOfId(id, ids) === d.id;
    const cols = new Set();
    for (const p of ir.parts ?? []) if (mine(p.id)) for (const op of p.ops ?? []) opCols(op, cols);
    for (const l of ir.lots ?? []) if (mine(String(l.part ?? ''))) boxCols(l.box, cols);
    for (const rd of ir.roads ?? []) if (districtOfRoad(rd, ids) === d.id) roadCols(rd, cols);
    // a following district's street (`route_st_<id>`) is inside its mask
    for (const pa of ir.paths ?? []) if (pa.box && pa.id.startsWith('route_st_') && streetOf(pa) === d.id) boxCols(pa.box, cols);
    for (const rd of ir.roads ?? []) if (rd.id.startsWith('route_st_') && streetOf(rd) === d.id) roadCols(rd, cols);
    if (!cols.size) continue;
    if (d.follow) push('district', d.id, cols, { shape: 'mask' });
    else {
      const r = rectOfKeys(cols);
      push('district', d.id, runKeys([r]), { shape: 'rect' });
    }
  }
  // ---- the join: its own part on a reach plan (with the reach), else its paths and roads
  const join = new Set();
  const jp = partById.get('route_join');
  if (jp) for (const op of jp.ops ?? []) opCols(op, join);
  for (const k of runKeys(ir.reach?.runs ?? [])) join.add(k);
  if (!jp) {
    // ((RTE2) a join piece: one naming the join's edge (route_join, a gate join's route_join_in), else an untagged id, a long road's groups
    // `route_join_<n>_<k>` included)
    const joinTag = (x) => { const t = x.ext?.[ROUTE_EXT]?.edge; return typeof t === 'string' ? t === 'route_join' || t === 'route_join_in' : null; };
    for (const pa of ir.paths ?? []) if ((joinTag(pa) ?? /^route_join_\d+[lg]?$/.test(pa.id)) && pa.box) boxCols(pa.box, join);
    for (const rd of ir.roads ?? []) if (joinTag(rd) ?? /^route_join_\d+(_\d+)?$/.test(rd.id)) roadCols(rd, join);
  }
  if (join.size) {
    const ext = (ir.graph?.edges ?? []).find((e) => e.id === 'join_external');
    const jd = (ir.graph?.edges ?? []).find((e) => e.id === 'route_join');
    const from = jd ? String(jd.from).split('.')[0] : '';
    const district = districtOfId(from, ids);
    // ((7a GJ, §5) through a gate: the junction it ends at (the gate junction's `then`) and the gate it crosses (`via`))
    const jk = ext?.junction?.kind === 'gate' ? ext.junction.then?.kind ?? null : ext?.junction?.kind;
    push('join', 'join', join, { district, junction: jk ?? (ext ? 'end' : null), ...(ext?.via ? { via: ext.via } : {}) });
  }
  // ---- the routes between districts (route_d_<a>__<b>_<n>)
  // ((RTE) a piece's route is the edge it names (ext architect_mc:route.edge, the districts pass's pieces since RTE). An untagged piece's
  // id is read as before (route_d_<a>__<b>_<n>), except that a road read so as an edge the graph lacks is a long road's group
  // (route_d_<a>__<b>_<n>_<k>): route_d_a__b_3_1 is d_a__b's, not a route d_a__b_3. Untagged ids stay ambiguous when both edges exist)
  const routes = new Map();
  const graphEdges = new Set((ir.graph?.edges ?? []).map((e) => e.id));
  const routeOf = (x, re, group) => {
    const t = x.ext?.[ROUTE_EXT]?.edge;
    if (typeof t === 'string') return /^route_d_/.test(t) ? t.slice('route_'.length) : null;
    const m = re.exec(x.id);
    if (!m) return null;
    if (group && graphEdges.size && !graphEdges.has(`route_${m[1]}`)) { const g = /^(d_[a-z0-9_]+?__[a-z0-9_]+?)_\d+$/.exec(m[1]); if (g && graphEdges.has(`route_${g[1]}`)) return g[1]; }
    return m[1];
  };
  const addRoute = (id, f) => { if (!id) return; if (!routes.has(id)) routes.set(id, new Set()); f(routes.get(id)); };
  for (const pa of ir.paths ?? []) if (pa.box) addRoute(routeOf(pa, /^route_(d_[a-z0-9_]+?__[a-z0-9_]+?)_\d+[lg]?$/, false), (c) => boxCols(pa.box, c));
  for (const rd of ir.roads ?? []) addRoute(routeOf(rd, /^route_(d_[a-z0-9_]+?__[a-z0-9_]+?)_\d+$/, true), (c) => roadCols(rd, c));
  for (const id of [...routes.keys()].sort()) push('route', id, routes.get(id));
  // ---- an outpost's corridor, exactly architect_mc:corridor's runs
  for (const id of Object.keys(ir.corridor ?? {}).sort()) {
    const cor = ir.corridor[id];
    const keys = runKeys(Array.isArray(cor) ? cor : cor?.runs ?? []);
    if (!keys.size) continue;
    let inside = 0;
    for (const k of keys) if (inTown(k)) inside++;
    parts.push({ kind: 'corridor', id, runs: keyRuns(keys), rect: rectOfKeys(keys), cells: keys.size, insideCells: inside });
  }
  // ---- extra: written columns in no other part
  const extra = new Set([...written].filter((k) => !claimed.has(k)));
  push('extra', 'written', extra);
  // ---- (6d GR §7) each revision's grown land: its own part, by rid
  for (const rid of [...grownBy.keys()].sort((a, b) => a - b)) {
    const q = grownBy.get(rid);
    // (§5) an along district's new band: its own district part (the mask the revision recorded on its road, architect_mc:band)
    for (const b of q.bands) push('district', b.district, runKeys(b.runs), { shape: 'mask', revision: rid });
    const ds = [...q.districts].sort();
    push('grown', `rv${rid}`, q.cols, { district: ds.length === 1 ? ds[0] : ds.length ? ds.join(',') : null, revision: rid });
  }
  if (v2) for (const p of parts) if (p.revision === undefined) p.revision = 0;
  // ---- union, outside, inside
  const union = new Set();
  for (const p of parts) {
    const keys = runKeys(p.runs);
    for (const k of keys) if (!(p.kind === 'corridor' && inTown(k) && !written.has(k))) union.add(k);
  }
  const outside = new Set([...union].filter((k) => !inTown(k))), inside = new Set([...union].filter((k) => inTown(k)));
  const rec = (keys) => ({ runs: keyRuns(keys), rect: rectOfKeys(keys), cells: keys.size });
  return {
    v: v2 ? LAND_V2 : LAND_V, standing: ir.beside?.id ?? null, standingClaim: town ? [...town] : null, standingRemoved: standingRemoved ?? null,
    outside: rec(outside), inside: rec(inside), union: rec(union), parts,
  };
}
