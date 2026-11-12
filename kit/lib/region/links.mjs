// (7b LP, docs/CONTRACT.md "Phase 7b" slice LP row 10, changes 3 and 4, "Slice LP as built") The link pass: connectors whose ends are
// site lots' ports. SETTLEMENTS §8.4 and §8.5: a connector never writes inside a lot's box; it ends on the cell just outside the box
// in the port's facing, at the port's feet y (the lot's design owns its landing, the port cell). The pass runs twice:
//   - at plan time (no `ctx.links`): each link is routed to the ports the lot's site declares (`site.ports`, design cells turned by the
//     site's frame), so checkPlan's answer means something; the link is recorded (`portLinks` in the IR and the plan meta), no op.
//   - at realise (`ctx.links`: the bound entries' own ports, by lot): the same plan replayed, each link routed again to the entry's
//     port of the name chosen at plan time and written in the stage LINK_STAGE after the lots ("IR v2"). A link that can't reach the
//     entry's port throws a NO_LINK error naming {lot, port}: the realise is refused before any write (change 3).
// Connectors at a port (catalogue): `connector.catwalk` (a straight level run between two ports facing each other, along a face),
// `connector.branch_walk` (a level deck hung on chains from the trees over it, routed round the lots) and `tunnel.under` (a
// `connector.tunnel` whose two ends are door ports: a straight bore between cellar doors, no portal). Plan time only, pure, integers.
import { rotateBlock } from '../reserved.mjs';
import { VC, VOXEL_CLASSES } from './volume.mjs';
import { catwalkRun, checkCatwalk } from '../connectors/catwalkGeom.mjs';
import { tunnel as tunnelRun, tunnelLand } from '../connectors/tunnelGeom.mjs';
import { deckChoice, railOf } from '../connectors/bridgeGeom.mjs';
import { rightOf } from '../connectors/ropeGeom.mjs';
import { fixtureFor } from './fixtures.mjs';
import { bomOf } from '../connectors/bom.mjs';

/** The stage the links are written in: after the lots (K1's own `links` stage, before the lots, already holds that name). */
export const LINK_STAGE = 'site_links';
/** The connector kinds a port link is built with (plan/0 kinds; `tunnel` between two door ports is the catalogue's `tunnel.under`). */
export const PORT_LINK_KINDS = Object.freeze(['catwalk', 'branch_walk', 'tunnel']);
/** branch_walk's limits (catalogue `connector.branch_walk`): hanger span, the reach up to an anchor, the route's length, lamps. */
export const BRANCH_WALK = Object.freeze({ span: 8, reach: 16, lengthMax: 96, lampEvery: 12, search: 24, width: 1 });
/** The codes a port link refuses with (plan time: the part's reason; realise: NO_LINK's detail `code`). */
export const LINK_CODES = Object.freeze(['NO_PORT', 'FACING', 'LEVEL', 'ALIGN', 'NO_PATH', 'ANCHOR', 'HEADROOM', 'SPAN', 'PROTECTED', 'NO_GAP', 'WATER', 'NO_COVER', 'VOLUME']);

const TURNS = { none: 0, clockwise_90: 1, clockwise_180: 2, counterclockwise_90: 3 };
const H_DIRS = ['north', 'east', 'south', 'west'];
const VEC = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const OPEN = new Set(['AIR', 'PLANT']);
const SOLID = new Set(['ROCK', 'SOIL', 'LOOSE', 'ICE', 'SNOW', 'LOG']);
const turnFacing = (f, t) => { const i = H_DIRS.indexOf(f); return i < 0 ? f : H_DIRS[(i + t) % 4]; };
const k3 = (x, y, z) => `${x},${y},${z}`;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const quarter = (rot) => rot === 'clockwise_90' || rot === 'counterclockwise_90';

/** A link error: `code` (LINK_CODES), the end it names ({lot, port}), the message. Thrown at realise; an answer's reason at plan time. */
export class LinkError extends Error {
  constructor(code, lot, port, message, evidence = null) {
    super(`${code}: ${message}`);
    this.code = code; this.lot = lot; this.port = port ?? null; this.evidence = evidence;
  }
}

/** A port's design cell from either wire: a SiteSpec port (`at`) or a blueprint sidecar port (`x, y, z`). */
const atOf = (p) => (Array.isArray(p.at) ? p.at : [p.x, p.y, p.z]);

/**
 * A site lot's ports in the world (`ports`: design ports, the entry's or the site's; default the site's): {name, kind, facing (world),
 * cell [x, y, z] (the port's feet cell), out [x, y, z] (the cell just outside the box in the facing, the connector's end), width,
 * height, edge}. Design cells are turned by the site's frame (vanilla's rotation, as lib/site.mjs Site.toWorld).
 */
export function lotPortsWorld(lot, ports = null) {
  const s = lot.site, b = lot.box;
  const t = TURNS[s.frame.rotation] ?? 0;
  const W = b.maxX - b.minX + 1, D = b.maxZ - b.minZ + 1;
  const [sx, sz] = quarter(s.frame.rotation) ? [D, W] : [W, D];
  const [ox, oy, oz] = s.frame.origin;
  return (ports ?? s.ports).map((p) => {
    const [px, py, pz] = atOf(p);
    const [rx, rz] = rotateBlock(px, pz, sx, sz, t);
    const facing = turnFacing(p.facing, t);
    const cell = [ox + rx, oy + py, oz + rz];
    const v = VEC[facing];
    const out = v ? [cell[0] + v[0], cell[1], cell[2] + v[1]] : facing === 'up' ? [cell[0], cell[1] + 1, cell[2]] : [cell[0], cell[1] - 1, cell[2]];
    return { name: p.name, kind: p.kind, facing, cell, out, width: p.width ?? 1, height: p.height ?? 1, ...(p.edge != null ? { edge: p.edge } : {}) };
  });
}

const inBox = (b, x, y, z) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ;
const inCols = (b, x, z) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
const centre = (b) => [Math.floor((b.minX + b.maxX) / 2), Math.floor((b.minZ + b.maxZ) / 2)];

/** The port kinds a connector takes at a port: tunnel a door (a cellar door) or a walk port; the walks a walk port. */
const kindsFor = (kind) => (kind === 'tunnel' ? ['door', 'architect:walk'] : ['architect:walk']);

/**
 * The port an end takes at plan time: the named one; else the lot's port whose `edge` is the link's id; else the horizontal port of a
 * kind the connector takes whose out cell is nearest the other lot's box centre (ties by name). Returns the world port or throws.
 */
export function choosePort(lot, end, link, otherLot) {
  const all = lotPortsWorld(lot);
  const ok = (p) => kindsFor(link.kind).includes(p.kind) && VEC[p.facing];
  if (end.port) {
    const p = all.find((q) => q.name === end.port);
    if (!p) throw new LinkError('NO_PORT', lot.id, end.port, `lot ${lot.id} has no port ${end.port} (its site's ports: ${all.map((q) => q.name).join(', ') || 'none'})`);
    if (!ok(p)) throw new LinkError('NO_PORT', lot.id, end.port, `port ${end.port} of lot ${lot.id} is a ${p.kind} facing ${p.facing}: a ${link.kind} needs a horizontal ${kindsFor(link.kind).join(' or ')} port`);
    return p;
  }
  const cand = all.filter(ok);
  const byEdge = cand.filter((p) => p.edge === link.id);
  const pool = byEdge.length ? byEdge : cand.filter((p) => p.edge == null);
  if (!pool.length) throw new LinkError('NO_PORT', lot.id, null, `lot ${lot.id} has no horizontal ${kindsFor(link.kind).join(' or ')} port for ${link.kind} ${link.id}`);
  const [cx, cz] = centre(otherLot.box);
  const d = (p) => Math.abs(p.out[0] - cx) + Math.abs(p.out[2] - cz);
  return [...pool].sort((p, q) => d(p) - d(q) || cmp(p.name, q.name))[0];
}

/**
 * The land the links read: the plan survey's columns and classes, a frozen volume's where the plan read one (the site volumes and
 * the zones' volumes), `blocked(x, z)` every lot's box columns, the keep-out and the claim's outer column. `written(x, y, z)` never
 * (a link stands on the land and the trees, not on the plan's other writes: their cells may change at realise).
 */
export function linkLand(r) {
  const S = r.survey;
  const vols = [...(r._volumeDecoded?.values() ?? [])].filter((v) => v && v.classes);
  const fromVol = (x, y, z) => {
    for (const v of vols) {
      const b = v.box;
      if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ) continue;
      const c = v.classes[((x - b.minX) * v.depth + (z - b.minZ)) * v.height + (y - b.minY)];
      if (c !== VC.MISSING) return VOXEL_CLASSES[c];
    }
    return null;
  };
  const classAt = (x, y, z) => {
    const v = fromVol(x, y, z);
    if (v !== null) return v;
    if (S.missingAt?.(x, z)) return 'MISSING';
    const g = S.groundAt(x, z);
    if (y > g) return S.treeAt?.(x, z) ? 'MISSING' : 'AIR';
    if (S.waterAt(x, z)) return S.frozenAt?.(x, z) && y === g ? 'ICE' : 'WATER';
    return y >= g - 3 ? 'SOIL' : 'ROCK';
  };
  const c = r.claim, lots = r.lots.filter((l) => l.box || l.site);
  const keep = r.ctx?.keepOut ?? [];
  const blocked = (x, z) => {
    if (x <= c.minX || x >= c.maxX || z <= c.minZ || z >= c.maxZ) return { class: 'claim' };
    for (const l of lots) { const b = l.box ?? null; if (b && inCols(b, x, z)) return { class: 'lot', id: l.id }; }
    for (const k of keep) if (x >= k[0] && x <= k[2] && z >= k[1] && z <= k[3]) return { class: 'keepOut' };
    return null;
  };
  return { S, classAt, blocked, groundAt: (x, z) => S.groundAt(x, z), topAt: (x, z) => (S.treeAt?.(x, z) ? S.groundAt(x, z) + 64 : S.groundAt(x, z)), waterAt: (x, z) => !!S.waterAt(x, z), vols };
}

// ------------------------------------------------------------------ routing per kind (pure: no op)

/** Two ends facing each other on one axis: the heading from a to b, the cells between (exclusive), or a LinkError. */
function facingPair(A, B, link) {
  const [ax, ay, az] = A.cell, [bx, by, bz] = B.cell;
  if (ay !== by && link.kind !== 'tunnel') throw new LinkError('LEVEL', B.lot, B.name, `a ${link.kind} is level: port ${A.lot}.${A.name} is at feet y ${ay}, ${B.lot}.${B.name} at ${by}`);
  const dx = Math.sign(bx - ax), dz = Math.sign(bz - az);
  if ((dx !== 0) === (dz !== 0)) throw new LinkError('ALIGN', B.lot, B.name, `a ${link.kind} at a port is a straight cardinal run: ports ${A.lot}.${A.name} ${A.cell.join(',')} and ${B.lot}.${B.name} ${B.cell.join(',')} are not on one axis`);
  const va = VEC[A.facing], vb = VEC[B.facing];
  if (va[0] !== dx || va[1] !== dz) throw new LinkError('FACING', A.lot, A.name, `port ${A.lot}.${A.name} faces ${A.facing}, away from ${B.lot}.${B.name}`);
  if (vb[0] !== -dx || vb[1] !== -dz) throw new LinkError('FACING', B.lot, B.name, `port ${B.lot}.${B.name} faces ${B.facing}, away from ${A.lot}.${A.name}`);
  return { dir: [dx, dz], n: Math.abs(bx - ax) + Math.abs(bz - az) - 1 };
}

/** A catwalk between two facing ports: the passing check (a face on the right, else the left; the ends' beds inside a lot dropped). */
function routeCatwalk(r, land, A, B, link, lotBoxes) {
  const { dir, n } = facingPair(A, B, link);
  const y = A.cell[1] - 1; // the deck's surface (feet on y + 1)
  const width = link.width ?? 1;
  let last = null;
  for (const side of ['right', 'left']) {
    const c = checkCatwalk(land, [A.cell[0], y, A.cell[2]], dir, n, side, width);
    if (c.ok) {
      // (an end's bed column inside a lot's box is the design's: K5, nothing written there)
      const [rx, rz] = rightOf(dir);
      c.ends = (c.ends ?? []).filter((i) => {
        const qx = A.cell[0] + dir[0] * i + rx * c.lanes.bed, qz = A.cell[2] + dir[1] * i + rz * c.lanes.bed;
        return !lotBoxes.some((b) => inCols(b, qx, qz));
      });
      return { kind: 'catwalk', dir, n, side, y, width, check: c };
    }
    last = c;
  }
  const code = last?.code === 'PROTECTED' ? 'PROTECTED' : last?.code ?? 'ANCHOR';
  throw new LinkError(code, B.lot, B.name, `no catwalk between ${A.lot}.${A.name} and ${B.lot}.${B.name}: ${code} ${JSON.stringify(last?.evidence ?? {}).slice(0, 160)}`, last?.evidence ?? null);
}

/** A tunnel between two facing door ports (tunnel.under): the bore's land and heading (tunnelGeom checks it when written). */
function routeTunnel(r, land, A, B, link) {
  const { dir, n } = facingPair(A, B, link);
  if (n < 4) throw new LinkError('SPAN', B.lot, B.name, `the ports are ${n} apart: a tunnel under is at least 4 long`);
  return { kind: 'tunnel', dir, n, a: [A.cell[0], A.cell[1] - 1, A.cell[2]], b: [B.cell[0], B.cell[1] - 1, B.cell[2]] };
}

/**
 * A branch walk between two ports at one feet y: a level deck routed round the lots (4-neighbour, fewest turns, then shortest, then
 * the fixed heading order E, S, W, N), from A's out cell to B's; every deck cell open over the deck (feet and head air or a plant),
 * the deck cell itself air, a plant or leaves; rails on every open side; chains up from a rail to the first leaf or log (or
 * site-solid) cell over it within BRANCH_WALK.reach, at most BRANCH_WALK.span deck cells apart (the ports' landings carry the ends);
 * a lamp on a rail at most BRANCH_WALK.lampEvery apart.
 */
function routeBranchWalk(r, land, A, B, link) {
  if (A.cell[1] !== B.cell[1]) throw new LinkError('LEVEL', B.lot, B.name, `a branch walk is level: port ${A.lot}.${A.name} is at feet y ${A.cell[1]}, ${B.lot}.${B.name} at ${B.cell[1]}`);
  const fy = A.cell[1];
  const walkable = (x, z) => !land.blocked(x, z) && OPEN.has(land.classAt(x, fy, z)) && OPEN.has(land.classAt(x, fy + 1, z)) && (OPEN.has(land.classAt(x, fy - 1, z)) || land.classAt(x, fy - 1, z) === 'LEAVES');
  for (const E of [A, B]) {
    const [x, , z] = E.out;
    if (land.blocked(x, z)) throw new LinkError('PROTECTED', E.lot, E.name, `the cell outside port ${E.lot}.${E.name} (${E.out.join(',')}) is ${land.blocked(x, z).class}`);
    if (!walkable(x, z)) throw new LinkError('HEADROOM', E.lot, E.name, `the cell outside port ${E.lot}.${E.name} (${E.out.join(',')}) is not open with 2 of head room over a deck cell (${land.classAt(x, fy - 1, z)}, ${land.classAt(x, fy, z)}, ${land.classAt(x, fy + 1, z)})`);
  }
  const s0 = [A.out[0], A.out[2]], g = [B.out[0], B.out[2]];
  const M = BRANCH_WALK.search;
  const lo = [Math.min(s0[0], g[0]) - M, Math.min(s0[1], g[1]) - M], hi = [Math.max(s0[0], g[0]) + M, Math.max(s0[1], g[1]) + M];
  // Dijkstra over (x, z, heading): a step costs 16, a turn 1 more (fewest steps, then fewest turns); the heap's ties by insertion
  const D4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const key = (x, z, h) => `${x},${z},${h}`;
  const dist = new Map(), prev = new Map();
  const heap = [];
  let seq = 0;
  const push = (c, x, z, h) => { heap.push([c, seq++, x, z, h]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (less(heap[i], heap[p])) { [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } else break; } };
  const less = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, rr = l + 1; let m = i; if (l < heap.length && less(heap[l], heap[m])) m = l; if (rr < heap.length && less(heap[rr], heap[m])) m = rr; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
  const startH = D4.findIndex(([dx, dz]) => dx === VEC[A.facing][0] && dz === VEC[A.facing][1]);
  dist.set(key(s0[0], s0[1], startH), 0);
  push(0, s0[0], s0[1], startH);
  let end = null;
  while (heap.length) {
    const [c, , x, z, h] = pop();
    if (c !== dist.get(key(x, z, h))) continue;
    if (x === g[0] && z === g[1]) { end = key(x, z, h); break; }
    if (c > BRANCH_WALK.lengthMax * 17) break;
    for (let nh = 0; nh < 4; nh++) {
      const [dx, dz] = D4[nh], nx = x + dx, nz = z + dz;
      if (nx < lo[0] || nx > hi[0] || nz < lo[1] || nz > hi[1]) continue;
      if (!walkable(nx, nz)) continue;
      const nc = c + 16 + (nh === h ? 0 : 1);
      const nk = key(nx, nz, nh);
      if (dist.has(nk) && dist.get(nk) <= nc) continue;
      dist.set(nk, nc); prev.set(nk, key(x, z, h));
      push(nc, nx, nz, nh);
    }
  }
  if (!end) throw new LinkError('NO_PATH', B.lot, B.name, `no level walk with 2 of head room joins ${A.lot}.${A.name} (${A.out.join(',')}) and ${B.lot}.${B.name} (${B.out.join(',')}) round the lots within ${M} of them`);
  const path = [];
  for (let k = end; k; k = prev.get(k)) { const [x, z] = k.split(',').map(Number); path.push([x, fy, z]); }
  path.reverse();
  if (path.length > BRANCH_WALK.lengthMax) throw new LinkError('SPAN', B.lot, B.name, `the walk between the ports is ${path.length} cells (at most ${BRANCH_WALK.lengthMax})`);
  const onPath = new Set(path.map(([x, , z]) => `${x},${z}`));
  // rails: every lateral cell of a deck cell that is not deck, not a lot's column, open at the feet (a solid cell is its own barrier)
  const railSet = new Map();
  path.forEach(([x, , z], i) => {
    for (const [dx, dz] of D4) {
      const qx = x + dx, qz = z + dz;
      if (onPath.has(`${qx},${qz}`) || railSet.has(`${qx},${qz}`)) continue;
      if (land.blocked(qx, qz)) continue;
      const cl = land.classAt(qx, fy, qz);
      if (!OPEN.has(cl) && cl !== 'LEAVES') continue;
      railSet.set(`${qx},${qz}`, { at: [qx, fy, qz], i });
    }
  });
  const rails = [...railSet.values()].sort((a, b) => a.i - b.i || a.at[0] - b.at[0] || a.at[2] - b.at[2]);
  // hangers: from a rail beside deck cell i, a chain up through open cells to the first leaf, log or site-solid cell within reach
  const anchorOf = ([x, , z]) => {
    for (let y = fy + 1; y <= fy + BRANCH_WALK.reach; y++) {
      const cl = land.classAt(x, y, z);
      if (OPEN.has(cl)) continue;
      if (cl === 'LEAVES' || SOLID.has(cl)) return y > fy + 1 ? { top: y - 1, anchor: [x, y, z], class: cl } : null;
      return null;
    }
    return null;
  };
  const railsBeside = (i) => rails.filter((q) => { const [x, , z] = path[i]; return Math.abs(q.at[0] - x) + Math.abs(q.at[2] - z) === 1; });
  const hangers = [];
  let last = -1; // the port's landing carries index -1, the other port's landing index path.length
  const used = new Set();
  while (path.length - last > BRANCH_WALK.span) {
    let got = null;
    for (let i = Math.min(path.length - 1, last + BRANCH_WALK.span); i > last && !got; i--) {
      for (const q of railsBeside(i)) {
        if (used.has(k3(...q.at))) continue;
        const a = anchorOf(q.at);
        if (a) { got = { i, at: q.at, ...a }; break; }
      }
    }
    if (!got) throw new LinkError('ANCHOR', B.lot, B.name, `no leaf or log within ${BRANCH_WALK.reach} over a rail of deck cells ${last + 1}..${Math.min(path.length - 1, last + BRANCH_WALK.span)} of the walk between ${A.lot}.${A.name} and ${B.lot}.${B.name}: a branch walk hangs from the trees`, { from: path[last + 1] });
    hangers.push(got); used.add(k3(...got.at)); last = got.i;
  }
  // lamps: on a rail (not a hanger's) at most lampEvery deck cells apart, the first within lampEvery / 2 of the start
  const lamps = [];
  let lastLamp = -Math.ceil(BRANCH_WALK.lampEvery / 2) - 1;
  for (let i = 0; i < path.length; i++) {
    if (i - lastLamp < BRANCH_WALK.lampEvery && i !== path.length - 1) continue;
    if (i - lastLamp < Math.ceil(BRANCH_WALK.lampEvery / 2) && i === path.length - 1) break;
    const q = railsBeside(i).find((p) => !used.has(k3(...p.at)) && OPEN.has(land.classAt(p.at[0], fy + 1, p.at[2])));
    if (q) { lamps.push({ i, at: [q.at[0], fy + 1, q.at[2]] }); used.add(k3(...q.at)); lastLamp = i; }
  }
  return { kind: 'branch_walk', fy, path, rails, hangers, lamps, width: 1 };
}

// ------------------------------------------------------------------ the pass

/** The plan's site lots by id (`r.lots` with a site). */
const siteLots = (r) => new Map(r.lots.filter((l) => l.site).map((l) => [l.id, l]));

/**
 * Route one link (plan time with the sites' ports, realise with the entries'): {link, ends: [A, B], route}. `ports`: the realise's
 * ports by lot ({lot: {entry, ports: [design ports]}}) or null. Throws LinkError.
 */
export function routeLink(r, link, ports = null) {
  const lots = siteLots(r);
  const la = lots.get(link.from.lot), lb = lots.get(link.to.lot);
  for (const [l, e] of [[la, link.from], [lb, link.to]]) if (!l) throw new LinkError('NO_PORT', e.lot, e.port ?? null, `${e.lot} is not a site lot of this plan`);
  const land = linkLand(r);
  const ends = [];
  for (const [lot, e, other] of [[la, link.from, lb], [lb, link.to, la]]) {
    // plan time: the site's port (named, or chosen); realise: the entry's port of the name chosen at plan time, same kind and facing
    const hint = choosePort(lot, e, link, other);
    let P = hint;
    if (ports) {
      const got = ports[lot.id];
      if (!got || !Array.isArray(got.ports)) throw new LinkError('NO_PORT', lot.id, hint.name, `lot ${lot.id} has no entry bound at realise: its port ${hint.name} has nothing to land on`);
      const mine = lotPortsWorld(lot, got.ports).find((q) => q.name === hint.name);
      if (!mine) throw new LinkError('NO_PORT', lot.id, hint.name, `entry ${got.entry ?? '?'} bound to lot ${lot.id} has no port ${hint.name} (its ports: ${got.ports.map((q) => q.name).join(', ') || 'none'})`);
      if (mine.facing !== hint.facing) throw new LinkError('FACING', lot.id, hint.name, `entry ${got.entry ?? '?'}'s port ${hint.name} faces ${mine.facing}; the link was planned to the site's port facing ${hint.facing}`);
      if (!kindsFor(link.kind).includes(mine.kind)) throw new LinkError('NO_PORT', lot.id, hint.name, `entry ${got.entry ?? '?'}'s port ${hint.name} is a ${mine.kind}: a ${link.kind} needs ${kindsFor(link.kind).join(' or ')}`);
      if (!inBox(lot.box, ...mine.cell)) throw new LinkError('NO_PORT', lot.id, hint.name, `entry ${got.entry ?? '?'}'s port ${hint.name} at ${mine.cell.join(',')} is outside the lot's box`);
      P = mine;
    }
    ends.push({ ...P, lot: lot.id });
  }
  const [A, B] = ends;
  if (link.kind === 'tunnel') for (const E of ends) if (E.kind !== 'door') throw new LinkError('NO_PORT', E.lot, E.name, `tunnel.under joins two door ports (cellar doors): ${E.lot}.${E.name} is a ${E.kind}`);
  const boxes = r.lots.filter((l) => l.box).map((l) => l.box);
  const route = link.kind === 'catwalk' ? routeCatwalk(r, land, A, B, link, boxes) : link.kind === 'tunnel' ? routeTunnel(r, land, A, B, link) : routeBranchWalk(r, land, A, B, link);
  return { link, ends, route, land };
}

const parapet = (block, sides) => {
  const n = String(block).replace(/\[.*$/, '');
  if (/_wall$/.test(n)) return `${n}[east=${sides.east ? 'low' : 'none'},north=${sides.north ? 'low' : 'none'},south=${sides.south ? 'low' : 'none'},up=true,waterlogged=false,west=${sides.west ? 'low' : 'none'}]`;
  if (/_fence$/.test(n)) return `${n}[east=${sides.east},north=${sides.north},south=${sides.south},waterlogged=false,west=${sides.west}]`;
  return block;
};

/** Write a routed branch walk in `part` (stage LINK_STAGE): deck, rails, chains, lamps; its record in `r.meta.branchWalks`. */
function writeBranchWalk(r, routed, part, id) {
  const R = routed.route;
  const role = (name) => (Object.prototype.hasOwnProperty.call(r.roles, name) ? name : null);
  const cc = r.ctx?.connectors?.branch_walk ?? {};
  const what = `branch_walk ${id}`;
  const chain = [cc.deck, 'floor', 'path', 'structure', 'minecraft:spruce_planks'].filter((x) => typeof x === 'string');
  const resolved = chain.map((x) => (role(x) || /^minecraft:/.test(x) ? r.material(x, `${what} deck`) : null)).filter(Boolean);
  const deck = (deckChoice(resolved) ?? { block: 'minecraft:spruce_planks' }).block.replace(/\[.*$/, '');
  const railRole = cc.rail ?? role('rail');
  const rail = railOf(railRole ? r.material(railRole, `${what} rail`) : null) ?? 'minecraft:spruce_fence';
  const light = fixtureFor(r.material(role('light') ? 'light' : 'minecraft:lantern', `${what} light`), rail);
  const lamp = light.kind === 'hanging_lantern' ? light.light.replace('hanging=true', 'hanging=false') : light.light;
  const chainB = 'minecraft:iron_chain[axis=y,waterlogged=false]';
  const railAt = new Set(R.rails.map((q) => `${q.at[0]},${q.at[2]}`));
  const mats = [deck, chainB, lamp];
  const idx = new Map();
  const mat = (s) => { if (!idx.has(s)) { idx.set(s, mats.length); mats.push(s); } return idx.get(s); };
  const solid = [], walk = [];
  const fy = R.fy;
  for (const [x, , z] of R.path) walk.push(x, z, fy - 1, fy - 1, 0);
  for (const q of R.rails) {
    const [x, , z] = q.at;
    const sides = { east: railAt.has(`${x + 1},${z}`), west: railAt.has(`${x - 1},${z}`), south: railAt.has(`${x},${z + 1}`), north: railAt.has(`${x},${z - 1}`) };
    solid.push(x, z, fy, fy, mat(parapet(rail, sides)));
  }
  for (const h of R.hangers) solid.push(h.at[0], h.at[2], fy + 1, h.top, 1);
  for (const l of R.lamps) solid.push(l.at[0], l.at[2], l.at[1], l.at[1], 2);
  const p = r.parts.find((q) => q.id === part) ?? r.part(part, { stage: LINK_STAGE, set: 'path' });
  (r.meta.parts[p.id] ??= {}).kind ??= 'path';
  p.columns({ abs: 0 }, { abs: 0 }, solid, mats);
  p.columns({ abs: 0 }, { abs: 0 }, walk, mats, { walk: true });
  const states = [];
  for (const cols of [solid, walk]) for (let t = 0; t < cols.length; t += 5) for (let y = cols[t + 2]; y <= cols[t + 3]; y++) states.push(mats[cols[t + 4]]);
  const rec = {
    id, kind: 'branch_walk', part: p.id, stage: LINK_STAGE, feetY: fy, width: 1, from: [...R.path[0]], to: [...R.path[R.path.length - 1]],
    path: R.path.map((q) => [...q]), rails: R.rails.map((q) => [...q.at]), hangers: R.hangers.map((h) => ({ i: h.i, at: [...h.at], top: h.top, anchor: [...h.anchor], class: h.class })),
    lamps: R.lamps.map((l) => ({ i: l.i, at: [...l.at] })), deck, rail, chain: chainB, light: lamp, bom: bomOf(states),
  };
  (r.meta.branchWalks ??= []).push(rec);
  return rec;
}

/**
 * Write one routed link (realise): its part `link_<id>` in LINK_STAGE. Returns the `$.links[]` row: {id, kind, part, from: {lot,
 * port, at, out}, to: {...}, cells}. Every written cell is checked outside every lot's box (K5) before it is kept.
 */
export function writeLink(r, routed) {
  const { link, ends: [A, B], route: R, land } = routed;
  const part = `link_${link.id}`.slice(0, 48);
  let rec;
  if (R.kind === 'catwalk') {
    rec = catwalkRun(r, [A.cell[0], R.y, A.cell[2]], [B.cell[0], R.y, B.cell[2]], { width: R.width, side: R.side, check: R.check, stage: LINK_STAGE, part, id: `catwalk_${link.id}`.slice(0, 48), edge: link.id });
  } else if (R.kind === 'tunnel') {
    const S = r.survey;
    const tl = tunnelLand(S, { volumes: land.vols, classOfVolume: (v, x, y, z) => { const b = v.box; if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ) return 'MISSING'; return VOXEL_CLASSES[v.classes[((x - b.minX) * v.depth + (z - b.minZ)) * v.height + (y - b.minY)]]; }, blocked: (x, z) => { const q = land.blocked(x, z); return q && q.class !== 'lot' ? q : null; } });
    try {
      rec = tunnelRun(r, R.a, R.b, { land: tl, stage: LINK_STAGE, part, id: `tunnel_${link.id}`.slice(0, 48), portal: 'plain', width: link.width ?? 1, height: 2, under: true });
    } catch (e) {
      const code = /TUNNEL ([A-Z_]+)/.exec(e.message)?.[1] ?? 'NO_PATH';
      throw new LinkError(LINK_CODES.includes(code) ? code : 'NO_PATH', B.lot, B.name, `no tunnel under between ${A.lot}.${A.name} and ${B.lot}.${B.name}: ${e.message}`);
    }
  } else {
    rec = writeBranchWalk(r, routed, part, `branch_walk_${link.id}`.slice(0, 48));
  }
  // K5: no cell of the link's part inside any lot's box
  const p = r.parts.find((q) => q.id === part);
  const boxes = r.lots.filter((l) => l.box);
  let cells = 0;
  for (const op of p?.ops ?? []) {
    const cols = op.cols ?? op.columns ?? null;
    if (!Array.isArray(cols)) continue;
    for (let t = 0; t + 4 < cols.length + 1; t += 5) {
      const [x, z, y0, y1] = [cols[t], cols[t + 1], cols[t + 2], cols[t + 3]];
      for (let y = y0; y <= y1; y++) {
        cells++;
        const hit = boxes.find((l) => inBox(l.box, x, y, z));
        if (hit) throw new LinkError('PROTECTED', hit.id, null, `${link.kind} ${link.id} would write ${x},${y},${z} inside lot ${hit.id}'s box (K5)`);
      }
    }
  }
  const endRow = (E) => ({ lot: E.lot, port: E.name, at: [...E.cell], out: [...E.out], facing: E.facing });
  return { id: link.id, kind: link.kind === 'tunnel' ? 'tunnel.under' : link.kind, part, from: endRow(A), to: endRow(B), cells, record: rec.id };
}

/** A link's plan-time record (the IR's `portLinks[]`): its id, kind, plan part, width and the two ends with the port each takes. */
export function linkRecord(routed, planPart = null) {
  const { link, ends: [A, B] } = routed;
  const end = (E) => ({ lot: E.lot, port: E.name, facing: E.facing });
  return { id: link.id, kind: link.kind, ...(planPart ? { planPart } : {}), ...(link.width ? { width: link.width } : {}), from: end(A), to: end(B) };
}

/**
 * The link-time input as the kit reads it (`ctx.links`): `{lots: {lotId: {entry, version?, ports: [design ports]}}}`. Problems as a
 * list (empty when good).
 */
export function linksInputProblems(L) {
  const out = [];
  if (!L || typeof L !== 'object' || Array.isArray(L)) return ['links must be {lots: {lot: {entry, ports}}}'];
  if (!L.lots || typeof L.lots !== 'object' || Array.isArray(L.lots)) return ['links.lots must be an object (lot id -> {entry, ports})'];
  for (const [id, v] of Object.entries(L.lots)) {
    if (!v || typeof v !== 'object' || typeof v.entry !== 'string' || !Array.isArray(v.ports)) { out.push(`links.lots.${id}: {entry: string, ports: [...]}`); continue; }
    v.ports.forEach((p, i) => {
      const at = Array.isArray(p?.at) ? p.at : [p?.x, p?.y, p?.z];
      if (typeof p?.name !== 'string' || typeof p?.kind !== 'string' || typeof p?.facing !== 'string' || !at.every(Number.isInteger)) out.push(`links.lots.${id}.ports[${i}]: {name, kind, facing, at | x, y, z}`);
    });
  }
  return out;
}

/**
 * Run the link pass over a region whose lots are placed: plan time records each link (and refuses one that doesn't reach its site's
 * ports, per link: `onRefuse(link, LinkError)`); realise (r.ctx.links) writes each in LINK_STAGE and returns the `$.links[]` rows, or
 * throws the first LinkError (NO_LINK: nothing is written by the realise). `links`: [{id, kind, from: {lot, port?}, to, width?,
 * planPart?}].
 */
export function linkPass(r, links, { onRefuse = null } = {}) {
  const ports = r.ctx?.links?.lots ?? null;
  const rows = [], records = [];
  for (const link of [...links].sort((a, b) => cmp(a.id, b.id))) {
    let routed;
    try {
      routed = routeLink(r, link, ports);
    } catch (e) {
      if (!(e instanceof LinkError)) throw e;
      if (ports || !onRefuse) throw e;
      onRefuse(link, e);
      continue;
    }
    records.push(linkRecord(routed, link.planPart ?? null));
    if (ports) rows.push(writeLink(r, routed));
  }
  return { records, rows };
}

/**
 * The stage LINK_STAGE in the region's stage list, right after the last stage a site lot names (declared stages: spliced in; implicit
 * ones: appended). Called by the first port link (a plan without one keeps its stages: change 4).
 */
export function ensureLinkStage(r) {
  const list = r._stages ?? (r._implicit ??= []);
  if (list.includes(LINK_STAGE)) return;
  const at = Math.max(-1, ...r.lots.filter((l) => l.site).map((l) => list.indexOf(l.stage)));
  list.splice(at < 0 ? list.length : at + 1, 0, LINK_STAGE);
}

const LINK_ID = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Region.portLink's work: a link between two site lots' ports ({id, kind, from: {lot, port?}, to, width?, planPart?}), routed now
 * (the lots must be placed). Plan time: recorded (r.meta.portLinks), no op; realise (ctx.links): written in LINK_STAGE, its row in
 * r.meta.links. Throws LinkError when it can't reach a port.
 */
export function portLinkOf(r, id, spec = {}) {
  if (typeof id !== 'string' || !LINK_ID.test(id)) throw new Error(`port link id '${id}' must match ${LINK_ID}`);
  if ((r.meta.portLinks ?? []).some((l) => l.id === id)) throw new Error(`port link id '${id}' is used twice`);
  const kind = spec.kind;
  if (!PORT_LINK_KINDS.includes(kind)) throw new Error(`port link ${id}: kind must be one of ${PORT_LINK_KINDS.join(', ')}`);
  for (const k of ['from', 'to']) {
    const e = spec[k];
    if (!e || typeof e.lot !== 'string' || (e.port !== undefined && e.port !== null && typeof e.port !== 'string')) throw new Error(`port link ${id}: ${k} must be {lot, port?}`);
  }
  if (spec.from.lot === spec.to.lot) throw new LinkError('NO_PORT', spec.to.lot, spec.to.port ?? null, `port link ${id} joins lot ${spec.to.lot} to itself`);
  const width = spec.width ?? null;
  if (width !== null && !(Number.isInteger(width) && width >= 1 && width <= 2)) throw new Error(`port link ${id}: width must be 1 or 2`);
  if (width === 2 && kind === 'branch_walk') throw new Error(`port link ${id}: a branch walk is 1 wide`);
  const link = { id, kind, from: { lot: spec.from.lot, ...(spec.from.port ? { port: spec.from.port } : {}) }, to: { lot: spec.to.lot, ...(spec.to.port ? { port: spec.to.port } : {}) }, ...(width ? { width } : {}), ...(spec.planPart ? { planPart: spec.planPart } : {}) };
  ensureLinkStage(r);
  const routed = routeLink(r, link, r.ctx?.links?.lots ?? null);
  const rec = linkRecord(routed, link.planPart ?? null);
  (r.meta.portLinks ??= []).push(rec);
  if (r.ctx?.links) { const row = writeLink(r, routed); (r.meta.links ??= []).push(row); return { ...rec, row }; }
  return rec;
}

/**
 * (change 3's safety) The replay guard: IR v2 (the realise's re-plan with the entries' ports) must be IR v1 (the checked plan's) plus the
 * links only. Every member but these must be equal (canonical JSON): the parts of LINK_STAGE, its tiles, `linked`, the budget (it counts
 * the link cells) and the claim's y range (tightened over the cells written). Returns null when it holds, else what differs.
 */
export function replayDiff(ir1, ir2, canonicalJson) {
  const strip = (ir) => {
    const o = JSON.parse(JSON.stringify(ir));
    o.parts = (o.parts ?? []).filter((p) => p.stage !== LINK_STAGE);
    if (o.tiles) delete o.tiles[LINK_STAGE];
    delete o.linked; delete o.budget;
    if (o.claim) { delete o.claim.minY; delete o.claim.maxY; }
    return o;
  };
  const a = strip(ir1), b = strip(ir2);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const diff = keys.filter((k) => canonicalJson(a[k] ?? null) !== canonicalJson(b[k] ?? null));
  if (!diff.length) return null;
  if (diff.includes('parts')) {
    const ids = (o) => new Map(o.parts.map((p) => [p.id, canonicalJson(p)]));
    const ma = ids(a), mb = ids(b);
    const moved = [...new Set([...ma.keys(), ...mb.keys()])].filter((id) => ma.get(id) !== mb.get(id)).sort();
    return `members ${diff.join(', ')} differ (parts ${moved.slice(0, 8).join(', ')}${moved.length > 8 ? ', ...' : ''})`;
  }
  return `members ${diff.join(', ')} differ`;
}
