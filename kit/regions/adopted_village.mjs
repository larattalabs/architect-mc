// adopted_village (docs/CONTRACT.md "Phase 6d slice AD" §2.2): a standing VillageLayout settlement (Steward's own street road sites and
// lot sites, placed before regions) described as a region IR, so Regions.adopt can record it as a region without writing a cell. From
// the street's geometry, the road sites' recorded specs and the lot sites' boxes it emits the lots (each {id, box, front, entrance,
// adopted: siteId}), the roads (each {id: street_<n>, adopted: roadSiteId}, flagged architect_mc:street {zone}) and V's graph (a lot node
// per lot, a junction where each lot's entrance meets the street, the plaza at the street's middle, terminal junctions at both ends), and
// no parts: no ops, so no tile and a budget of 0. Deterministic, catalogue = false.
//
// params.adopt: {
//   zone: the plan/0 zone id the roads are flagged with (default 'village'),
//   geometry: {streetZ, xLo, xHi} (the street runs east-west along x) or {streetX, zLo, zHi} (north-south along z),
//   roads: [{site, points: [[x, y, z], ...], width?, surface?, lanterns?, lamp?}]   the street's road sites, in any order,
//   lots: [{id, site, box: [x0, y0, z0, x1, y1, z1], type?, role?, villager?, landmark?, ext?}],
// }
// Refusals: Error('NOT_ALLOWED: [adopt] ...') naming the road or lot.
import { region } from '../lib/region/program.mjs';

export const id = 'adopted_village';
export const description = 'A standing VillageLayout settlement recorded as a region (6d AD): its lots, street roads and graph; no parts.';
export const catalogue = false;
/** V's look, so a growth's extension reads the same roles (a bible's win). */
export const roles = { path: 'minecraft:gravel', foundation: 'minecraft:stone_bricks', light: 'minecraft:lantern' };

export const params = {
  adopt: { type: 'json', default: null, maxChars: 262144, label: 'Adopted settlement' },
};

/** The street's half width in VillageLayout (Rules.defaults: a 5-wide street, the road 3 of it). */
export const HALF = 2;
/** A lot's street edge at least this far from the centre line (the verge row is HALF), at most FACE_MAX. */
export const FACE_MIN = HALF;
export const FACE_MAX = 32;
/** Collinear road pieces may leave at most this many cells between them. */
export const PIECE_GAP = 1;
export const LANE_WIDTH = 2;

const refuse = (m) => { throw new Error(`NOT_ALLOWED: [adopt] ${m}`); };
const isInt = Number.isInteger;

/** The geometry as {o: 'ew'|'ns', c, lo, hi}. */
export function geometryOf(g) {
  if (!g || typeof g !== 'object') refuse('geometry must be {streetZ, xLo, xHi} or {streetX, zLo, zHi}');
  if (isInt(g.streetZ) && isInt(g.xLo) && isInt(g.xHi) && g.xLo <= g.xHi) return { o: 'ew', c: g.streetZ, lo: g.xLo, hi: g.xHi };
  if (isInt(g.streetX) && isInt(g.zLo) && isInt(g.zHi) && g.zLo <= g.zHi) return { o: 'ns', c: g.streetX, lo: g.zLo, hi: g.zHi };
  return refuse('geometry must be {streetZ, xLo, xHi} or {streetX, zLo, zHi} (integers, lo <= hi)');
}

/** World (x, z) -> local (u along the street, v across). */
const toLocal = (o, x, z) => (o === 'ew' ? [x, z] : [z, x]);
const toWorld = (o, u, v) => (o === 'ew' ? [u, v] : [v, u]);

/** The adopted settlement, validated: {G, zone, pieces: [{id, site, u0, u1, y, width, ...}], lots: [{id, site, box, front, side, eu, entrance, ...}]}. */
export function adoptedLayout(a) {
  if (!a || typeof a !== 'object') refuse('params.adopt is missing');
  const G = geometryOf(a.geometry);
  const zone = a.zone ?? 'village';
  if (typeof zone !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(zone)) refuse(`zone '${zone}' must match [a-z][a-z0-9_]{0,47}`);
  if (!Array.isArray(a.roads) || !a.roads.length) refuse('the street has no road site');
  if (!Array.isArray(a.lots) || !a.lots.length) refuse('the settlement has no lot');
  const pieces = a.roads.map((rd, i) => {
    const what = `road site ${rd?.site ?? `#${i}`}`;
    if (typeof rd?.site !== 'string' || !rd.site) refuse(`road #${i} has no site id`);
    const pts = rd.points;
    if (!Array.isArray(pts) || pts.length < 2 || !pts.every((p) => Array.isArray(p) && p.length === 3 && p.every(isInt))) refuse(`${what}: its points must be 2+ [x, y, z] integers`);
    let u0 = Infinity, u1 = -Infinity, y0 = null, y1 = null;
    for (const [x, y, z] of pts) {
      const [u, v] = toLocal(G.o, x, z);
      if (v !== G.c) refuse(`${what} is not along the street line (${G.o === 'ew' ? 'z' : 'x'} ${v}, the street's ${G.c})`);
      if (u < u0) { u0 = u; y0 = y; }
      if (u > u1) { u1 = u; y1 = y; }
    }
    if (u1 - u0 < 1) refuse(`${what} is a single cell`);
    const width = rd.width ?? 3;
    if (!isInt(width) || width < 1 || width > 5) refuse(`${what}: width ${width} (a VillageLayout street is 3)`);
    return { site: rd.site, u0, u1, y0, y1, width, surface: rd.surface ?? null, lanterns: rd.lanterns !== false, lamp: rd.lamp ?? null };
  }).sort((p, q) => p.u0 - q.u0 || p.u1 - q.u1 || (p.site < q.site ? -1 : 1));
  for (let i = 1; i < pieces.length; i++) {
    if (pieces[i].u0 > pieces[i - 1].u1 + 1 + PIECE_GAP) refuse(`road sites ${pieces[i - 1].site} and ${pieces[i].site} leave a gap of ${pieces[i].u0 - pieces[i - 1].u1 - 1} cells: not one street`);
  }
  const sites = new Set();
  for (const p of pieces) { if (sites.has(p.site)) refuse(`road site ${p.site} is named twice`); sites.add(p.site); }
  pieces.forEach((p, i) => { p.id = `street_${i + 1}`; });
  const U0 = pieces[0].u0, U1 = Math.max(...pieces.map((p) => p.u1));
  if (U0 < G.lo - 64 || U1 > G.hi + 64) refuse(`the street runs ${U0}..${U1}, far past its geometry ${G.lo}..${G.hi}`);
  const ids = new Set();
  const lots = a.lots.map((l, i) => {
    const what = `lot ${l?.id ?? `#${i}`}`;
    if (typeof l?.id !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(l.id)) refuse(`${what}: its id must match [a-z][a-z0-9_]{0,47}`);
    if (ids.has(l.id)) refuse(`${what} is named twice`);
    ids.add(l.id);
    if (typeof l.site !== 'string' || !l.site) refuse(`${what} has no site id`);
    if (sites.has(l.site)) refuse(`${what}: site ${l.site} is also a road`);
    sites.add(l.site);
    const b = l.box;
    if (!Array.isArray(b) || b.length !== 6 || !b.every(isInt) || b[0] > b[3] || b[1] > b[4] || b[2] > b[5]) refuse(`${what}: box must be [x0, y0, z0, x1, y1, z1]`);
    const [ua, va] = toLocal(G.o, b[0], b[2]), [ub, vb] = toLocal(G.o, b[3], b[5]);
    const lu0 = Math.min(ua, ub), lu1 = Math.max(ua, ub), lv0 = Math.min(va, vb), lv1 = Math.max(va, vb);
    let side;
    if (lv1 < G.c) side = -1; else if (lv0 > G.c) side = 1; else refuse(`${what} (site ${l.site}) crosses the street line`);
    const d = side < 0 ? G.c - lv1 : lv0 - G.c;
    if (d < FACE_MIN + 1) refuse(`${what} (site ${l.site}) stands on the street: its edge is ${d} from the centre line (at least ${FACE_MIN + 1})`);
    if (d > FACE_MAX) refuse(`${what} (site ${l.site}) does not face the street: its edge is ${d} from the centre line (at most ${FACE_MAX})`);
    if (lu1 < U0 - 8 || lu0 > U1 + 8) refuse(`${what} (site ${l.site}) is not along the street (${lu0}..${lu1}; the street ${U0}..${U1})`);
    // its front: the side facing the street (V's: a lot north of an east-west street faces south)
    const front = G.o === 'ew' ? (side < 0 ? 'south' : 'north') : (side < 0 ? 'east' : 'west');
    // the entrance: the cell in front of the middle of the front edge, at the street's y (r.lot's rule; the floor is the box's own)
    const mu = lu0 + Math.floor((lu1 - lu0) / 2);
    const ev = side < 0 ? lv1 + 1 : lv0 - 1;
    const eu = Math.max(U0, Math.min(U1, mu));
    return { id: l.id, site: l.site, box: b, lu0, lu1, lv0, lv1, side, front, mu, ev, eu, type: l.type ?? 'house', role: l.role ?? l.type ?? 'house',
      villager: l.villager ?? null, landmark: l.landmark === true, ext: l.ext && typeof l.ext === 'object' ? l.ext : null };
  });
  // lot boxes never overlap (the kit's _addLot rule)
  for (let i = 0; i < lots.length; i++) for (let j = i + 1; j < lots.length; j++) {
    const p = lots[i].box, q = lots[j].box;
    if (p[0] <= q[3] && q[0] <= p[3] && p[2] <= q[5] && q[2] <= p[5]) refuse(`lots ${lots[i].id} and ${lots[j].id} overlap`);
  }
  return { G, zone, pieces, lots, U0, U1 };
}

/** The piece a street position u belongs to (the first that holds it; else the nearest). */
function pieceAt(pieces, u) {
  return pieces.find((p) => u >= p.u0 && u <= p.u1) ?? [...pieces].sort((p, q) => Math.min(Math.abs(u - p.u0), Math.abs(u - p.u1)) - Math.min(Math.abs(u - q.u0), Math.abs(u - q.u1)))[0];
}

/** The street's y at u (each piece's ends' y; between them the nearer end's). */
function yAt(pieces, u) {
  const p = pieceAt(pieces, u);
  return Math.abs(u - p.u0) <= Math.abs(u - p.u1) ? p.y0 : p.y1;
}

export default function (ctx) {
  const r = region(ctx);
  r.stages(['adopted']);
  const A = adoptedLayout(ctx.params.adopt);
  const { G, zone, pieces, lots, U0, U1 } = A;
  const c = r.claim;
  const inClaim = (x, z) => x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ;
  const flag = { 'architect_mc:street': { zone } };
  // the roads: one per road site, 2 points along the line (a 4e road's own ends), flagged
  for (const p of pieces) {
    const [ax, az] = toWorld(G.o, p.u0, G.c), [bx, bz] = toWorld(G.o, p.u1, G.c);
    if (!inClaim(ax, az) || !inClaim(bx, bz)) refuse(`road site ${p.site} runs outside the claim`);
    const rd = { id: p.id, stage: 'adopted', part: null, points: [[ax, p.y0, az], [bx, p.y1, bz]], width: p.width, lanterns: p.lanterns, adopted: p.site, ext: JSON.parse(JSON.stringify(flag)) };
    if (p.surface) rd.surface = p.surface;
    if (p.lamp) rd.lamp = JSON.parse(JSON.stringify(p.lamp));
    r.roads.push(rd);
    r.roadIds.add(p.id);
  }
  // the lots: the sites' boxes as they stand
  for (const l of lots) {
    const [x0, y0, z0, x1, y1, z1] = l.box;
    if (!inClaim(x0, z0) || !inClaim(x1, z1)) refuse(`lot ${l.id} (site ${l.site}) is outside the claim`);
    const [ex, ez] = toWorld(G.o, l.mu, l.ev);
    const ey = yAt(pieces, l.eu);
    l.entrance = [ex, ey, ez];
    const ext = { ...(l.ext ?? {}), 'architect_mc:village': { role: l.role, type: l.type, villager: l.villager, entrance: l.entrance, lane: `lane_${l.id}`, slot: 'street', landmark: l.landmark, adopted: true } };
    const lot = {
      id: l.id, stage: 'adopted', part: null, at: [x0, z0], size: [x1 - x0 + 1, z1 - z0 + 1], floorY: y0, front: l.front, max: [x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1],
      box: { minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1 }, entrance: l.entrance, adopted: l.site, ext,
    };
    r.lots.push(lot);
    r.lotIds.add(l.id);
    r.meta.lots[l.id] = { entrance: l.entrance, part: null, adopted: l.site };
  }
  // the graph (V's shape): lot nodes, a junction where each entrance meets the street, the plaza at the middle, terminal ends
  const at3 = (u) => { const [x, z] = toWorld(G.o, u, G.c); return [x, yAt(pieces, u), z]; };
  const uMid = Math.floor((U0 + U1) / 2);
  const pl = r.graphNode({ id: 'plaza', kind: 'plaza', ref: 'adopted', at: at3(uMid), ports: [{ name: 'bell', at: at3(uMid), facing: 'up', width: 5 }, { name: 'street', at: at3(uMid), facing: 'up', width: 5 }] });
  for (const l of lots) r.graphNode({ id: `lot:${l.id}`, kind: 'lot', ref: l.id, at: l.entrance, ports: [{ name: 'entrance', at: l.entrance, facing: l.front, width: LANE_WIDTH }] });
  const stops = [...new Set([...lots.map((l) => l.eu), uMid])].sort((p, q) => p - q);
  const k = new Map(pieces.map((p) => [p.id, 0]));
  const facingAcross = (side) => (G.o === 'ew' ? (side < 0 ? 'north' : 'south') : (side < 0 ? 'west' : 'east'));
  const chain = []; // [{id, port, u}]
  const node = (id, u, ref) => r.graphNode({ id, kind: 'junction', ref, at: at3(u), ports: [{ name: 'street', at: at3(u), facing: 'up', width: 2 * HALF + 1 }] });
  if (stops[0] !== U0) { const n = node(`${pieces[0].id}_start`, U0, pieces[0].id); chain.push({ n, u: U0, terminal: true }); }
  for (const u of stops) {
    const p = pieceAt(pieces, u);
    k.set(p.id, k.get(p.id) + 1);
    const n = node(`${p.id}_j${k.get(p.id)}`, u, p.id);
    for (const l of lots.filter((x) => x.eu === u)) {
      const port = `lane_${l.id}`;
      n.ports.push({ name: port, at: at3(u), facing: facingAcross(-l.side), width: LANE_WIDTH });
      r.graphEdge({ id: port, from: `lot:${l.id}.entrance`, to: `${n.id}.${port}`, type: 'path', width: LANE_WIDTH, path: port });
    }
    if (u === uMid) {
      n.ports.push({ name: 'plaza', at: at3(u), facing: 'up', width: 2 * HALF + 1 });
      r.graphEdge({ id: 'plaza_link', from: `${n.id}.plaza`, to: `${pl.id}.street`, type: 'road', width: 2 * HALF + 1, path: p.id });
    }
    chain.push({ n, u });
  }
  const last = pieces[pieces.length - 1];
  if (stops[stops.length - 1] !== U1) { const n = node(`${last.id}_end`, U1, last.id); chain.push({ n, u: U1, terminal: true }); }
  // road edges between consecutive stops: a terminal's edge rides its own piece (GR §4: an extendable end's one edge is its street's)
  const seq = new Map(pieces.map((p) => [p.id, 0]));
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1], b = chain[i];
    const p = a.terminal ? pieces[0] : b.terminal ? last : pieceAt(pieces, Math.floor((a.u + b.u) / 2));
    seq.set(p.id, seq.get(p.id) + 1);
    r.graphEdge({ id: `${p.id}#${b.terminal ? 'end' : seq.get(p.id)}`, from: `${a.n.id}.street`, to: `${b.n.id}.street`, type: 'road', width: 2 * HALF + 1, path: p.id });
  }
  r.anchor('entrance', at3(uMid));
  r.anchor('spawn', at3(uMid));
  r.meta.adopted = { zone, orientation: G.o, streetV: G.c, u0: U0, u1: U1, roads: Object.fromEntries(pieces.map((p) => [p.id, p.site])), lots: Object.fromEntries(lots.map((l) => [l.id, l.site])) };
  return r;
}
