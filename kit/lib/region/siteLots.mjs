// (7b SL, docs/CONTRACT.md "Phase 7b" slice SL and "Slice SL as built") Site lots: a lot that stands on the land's own shape (a trunk, a
// canopy, a ledge, an overhang, a gap, water) instead of a pad. `r.siteLot(id, {affordance, fit, max, ports, brief, ...})` records:
//   - the lot box (the fit box: a site-bound design is exactly this box), placed from the affordance per kind or given as `box`;
//   - the site (= api.SiteSpec's wire, kit/schemas/site-spec.json): the frozen volume of the box grown by SITE_MARGIN (8), which must lie
//     inside the claim (SV's Site reads the lot box as the volume less the margin), the frame (origin = the box's minimum corner, rotation from the affordance as AF's proposeFrame), the keep-critical cells
//     (the host's logs for wrap_trunk; for suspend the hang points, the first solid cell above each corner of the box inset 2), the port requirements (design cells);
//   - the reserved box: no region op writes inside it but its `host` part's (the region checker's M1:site rule);
// and writes no pad (no op at all). The volume: the two-plan flow plans exactly twice, so a site lot found from an affordance cannot ask
// for its own volume; it is cut from a volume the plan already read (the zone's), encoded as ARVX version 1 and carried as an IR side
// blob `site_<lot>` (gzip with the OS byte pinned, as every volume blob; `site.volumeSha` is the sha of the uncompressed ARVX, the mod
// finds the blob by it and freezes it into architect/volumes). A box whose volume equals a volume read uses it as it is;
// a box no volume read covers asks for it (needVolume) and the lot is not placed on this plan (null; the second plan places it).
// Pure (plan time), deterministic, no trig.
import { FIT_IDS, SITE_MARGIN } from '../siteFits.mjs';
import { siteSpecProblems } from '../siteSpec.mjs';
import { VC, encodeArvx } from './volume.mjs';
import { rotationFacing } from './affordances.mjs';
import { gzipPinned, sha256Hex } from './pack.mjs';

export const SITE_LOT_ID = /^[a-z][a-z0-9_]{0,47}$/;
const ROTATIONS = ['none', 'clockwise_90', 'clockwise_180', 'counterclockwise_90'];
/** The design's front (south) turned by a frame rotation (vanilla's turn: south -> west -> north -> east). */
export const FRONT_OF_ROTATION = Object.freeze({ none: 'south', clockwise_90: 'west', clockwise_180: 'north', counterclockwise_90: 'east' });
const quarter = (rot) => rot === 'clockwise_90' || rot === 'counterclockwise_90';

/** The frame rotation for an affordance (AF's proposeFrame rule): a gap along z turns a quarter; else the design faces the normal. */
export function rotationOf(a) {
  if (!a) return 'none';
  if (a.kind === 'gap') return a.metrics?.axis === 'z' ? 'clockwise_90' : 'none';
  return rotationFacing(a.normal);
}

/**
 * The default port requirements per fit (design cells, the design's own size [w, h, d]; frozen in "Slice SL as built"), named and placed
 * as SV's fixtures name theirs, so SV's fit examples (and DS's site variants of them) find them: on_pad none; wrap_trunk `walk_w` on the
 * west edge at row 2 (a deck over its braces), facing west; span `walk_w` and `walk_e` at the two ends (row 0), facing out; suspend
 * `hatch` at the middle of the floor, facing down (1x1); attach_to_cliff `walk_top` at the back edge three rows under the top, facing
 * north (onto the clifftop); carve_into a door `door_s` at the middle of the front edge (row 0), facing south (1x2). Walk ports 2x2.
 */
export function defaultPorts(fit, [w, h, d]) {
  const mx = Math.floor((w - 1) / 2), mz = Math.floor((d - 1) / 2);
  const walk = (name, at, facing) => ({ name, kind: 'architect:walk', at, facing, width: 2, height: 2 });
  switch (fit) {
    case 'on_pad': return [];
    case 'wrap_trunk': return [walk('walk_w', [0, Math.min(2, h - 1), mz], 'west')];
    case 'span': return [walk('walk_w', [0, 0, mz], 'west'), walk('walk_e', [w - 1, 0, mz], 'east')];
    case 'suspend': return [{ name: 'hatch', kind: 'architect:walk', at: [mx, 0, mz], facing: 'down', width: 1, height: 1 }];
    case 'attach_to_cliff': return [walk('walk_top', [mx, Math.max(0, h - 3), Math.min(1, d - 1)], 'north')];
    case 'carve_into': return [{ name: 'door_s', kind: 'door', at: [mx, 0, d - 1], facing: 'south', width: 1, height: 2 }];
    default: return [];
  }
}

/**
 * The lot box's world placement from an affordance (no `box` given): x/z centred on the affordance (a trunk or spike on its axis), the
 * floor y per kind (`y` overrides it): trunk, spike, cave its first anchor's y; canopy (centred on its first trunk top) the box's top
 * under the leaf layer; overhang the box's top under the bearing row (its anchors); water one over the surface; ledge, pad, gap one over their first anchor; a cliff face its
 * box's bottom. `size` is the world size [W, H, D].
 */
export function placeFromAffordance(a, [W, H, D], y = null) {
  const b = a.box, an = a.anchors?.[0] ?? [Math.floor((b.minX + b.maxX) / 2), b.minY, Math.floor((b.minZ + b.maxZ) / 2)];
  // (a canopy's anchors are its trunks' tops: a canopy lot wraps the first one, under the leaf layer)
  const axial = a.kind === 'trunk' || a.kind === 'spike' || a.kind === 'canopy';
  const cx = axial ? an[0] : Math.floor((b.minX + b.maxX) / 2), cz = axial ? an[2] : Math.floor((b.minZ + b.maxZ) / 2);
  let floor;
  switch (a.kind) {
    case 'trunk': case 'spike': case 'cave': floor = an[1]; break;
    case 'canopy': floor = (Number.isInteger(a.metrics?.layerY) ? a.metrics.layerY : b.minY) - H; break;
    case 'overhang': floor = an[1] - H; break; // (its anchors are the bearing row the lot hangs from)
    case 'water': floor = (Number.isInteger(a.metrics?.surfaceY) ? a.metrics.surfaceY : an[1]) + 1; break;
    case 'ledge': case 'pad': case 'gap': floor = an[1] + 1; break;
    default: floor = b.minY;
  }
  if (Number.isInteger(y)) floor = y;
  const minX = cx - Math.floor((W - 1) / 2), minZ = cz - Math.floor((D - 1) / 2);
  return { minX, minY: floor, minZ, maxX: minX + W - 1, maxY: floor + H - 1, maxZ: minZ + D - 1 };
}

const inside = (o, i) => i.minX >= o.minX && i.maxX <= o.maxX && i.minY >= o.minY && i.maxY <= o.maxY && i.minZ >= o.minZ && i.maxZ <= o.maxZ;
const sameBox = (a, b) => a.minX === b.minX && a.minY === b.minY && a.minZ === b.minZ && a.maxX === b.maxX && a.maxY === b.maxY && a.maxZ === b.maxZ;

/** A decoded volume cut to `box` (inside it): ARVX version 1 bytes (classes and owners; the owners compacted in first-use order). */
export function cropVolume(v, box) {
  const W = box.maxX - box.minX + 1, H = box.maxY - box.minY + 1, D = box.maxZ - box.minZ + 1;
  const classes = new Uint8Array(W * H * D);
  const owners = [], ownerOf = new Map(), remap = new Map();
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
    const src = ((box.minX + x - v.box.minX) * v.depth + (box.minZ + z - v.box.minZ)) * v.height + (box.minY - v.box.minY);
    const dst = (x * D + z) * H;
    for (let y = 0; y < H; y++) {
      const c = v.classes[src + y];
      classes[dst + y] = c;
      if (c === VC.OWNED) {
        const k = v.ownerOf?.get(src + y) ?? 0;
        if (!remap.has(k)) { remap.set(k, owners.length); owners.push(v.owners?.[k] ?? ''); }
        ownerOf.set(dst + y, remap.get(k));
      }
    }
  }
  return encodeArvx(box, classes, owners, ownerOf);
}

/** Region.siteLot's work (see the header). Returns the lot (with `site`), or null when its volume is asked on this plan. */
export function siteLot(r, id, opts = {}) {
  const what = `site lot ${id}`;
  if (typeof id !== 'string' || !SITE_LOT_ID.test(id)) throw new Error(`site lot id '${id}' must match ${SITE_LOT_ID}`);
  if (r.lotIds.has(id)) throw new Error(`lot id '${id}' is used twice`);
  const { fit, max, ports, brief, stage, box: given, host = null, ext, part = null, y = null } = opts;
  if (!FIT_IDS.includes(fit)) throw new Error(`${what}: fit must be one of ${FIT_IDS.join(', ')}`);
  let a = opts.affordance ?? null;
  if (typeof a === 'string') {
    const found = r._affordances?.get(a);
    if (!found) throw new Error(`${what}: no affordance '${a}' (call r.affordances first)`);
    a = found;
  }
  if (a !== null && (typeof a !== 'object' || typeof a.id !== 'string' || typeof a.kind !== 'string' || !a.box)) throw new Error(`${what}: affordance must be an affordance (r.affordances) or its id`);
  if (host !== null && (typeof host !== 'string' || !r.partIds.has(host))) throw new Error(`${what}: host must be a part id (got ${JSON.stringify(host)})`);
  const rotation = a ? rotationOf(a) : (opts.rotation ?? 'none');
  if (!ROTATIONS.includes(rotation)) throw new Error(`${what}: rotation must be one of ${ROTATIONS.join(', ')}`);
  let box;
  if (given) {
    const g = Array.isArray(given) ? { minX: given[0], minY: given[1], minZ: given[2], maxX: given[3], maxY: given[4], maxZ: given[5] } : given;
    if (!['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].every((k) => Number.isInteger(g[k])) || g.minX > g.maxX || g.minY > g.maxY || g.minZ > g.maxZ) throw new Error(`${what}: box must be {minX..maxZ} integers`);
    box = { minX: g.minX, minY: g.minY, minZ: g.minZ, maxX: g.maxX, maxY: g.maxY, maxZ: g.maxZ };
  } else {
    if (!a) throw new Error(`${what}: needs an affordance or a box`);
    if (!Array.isArray(max) || max.length !== 3 || !max.every((v) => Number.isInteger(v) && v >= 1)) throw new Error(`${what}: max must be [x, y, z] (the design's size, front south)`);
    const ws = quarter(rotation) ? [max[2], max[1], max[0]] : [...max];
    box = placeFromAffordance(a, ws, y);
  }
  const W = box.maxX - box.minX + 1, H = box.maxY - box.minY + 1, D = box.maxZ - box.minZ + 1;
  if (W > 96 || H > 64 || D > 96) throw new Error(`${what}: the box ${W}x${H}x${D} is over the 96x64x96 child cap`);
  const c = r.claim;
  if (box.minX < c.minX || box.maxX > c.maxX || box.minZ < c.minZ || box.maxZ > c.maxZ) throw new Error(`${what}: the box is outside the claim`);
  if (box.minY < c.minY || box.maxY > c.maxY) throw new Error(`${what}: the box y ${box.minY}..${box.maxY} is outside the claim's y range`);
  const lstage = r._stage(stage);
  // the volume: the box + 8 (SV's Site reads the lot box as the volume less the margin), inside the claim
  const vb = {
    minX: box.minX - SITE_MARGIN, minY: box.minY - SITE_MARGIN, minZ: box.minZ - SITE_MARGIN,
    maxX: box.maxX + SITE_MARGIN, maxY: box.maxY + SITE_MARGIN, maxZ: box.maxZ + SITE_MARGIN,
  };
  if (vb.minX < c.minX || vb.maxX > c.maxX || vb.minZ < c.minZ || vb.maxZ > c.maxZ || vb.minY < c.minY || vb.maxY > c.maxY) {
    throw new Error(`${what}: its site volume (the box + ${SITE_MARGIN}) leaves the claim`);
  }
  let vol = null, sha = null;
  const read = Object.entries(r.volumesUsed).map(([name, u]) => ({ name, u, d: r._volumeDecoded?.get(name) })).filter((x) => x.d);
  const exact = read.find((x) => sameBox(x.u.box, vb));
  if (exact) {
    vol = exact.d; sha = exact.d.sha;
  } else {
    const cover = read.filter((x) => inside(x.u.box, vb)).sort((p, q) => (p.name < q.name ? -1 : p.name > q.name ? 1 : 0))[0];
    if (cover) {
      const bytes = cropVolume(cover.d, vb);
      sha = sha256Hex(bytes);
      const blob = `site_${id}`;
      if (!r.sideBlobs[blob]) r._sideBlob(blob, 'volume', gzipPinned(bytes)); // (gzip, as a read volume's blob; the volume's sha is the raw ARVX's)
      vol = { box: vb, width: vb.maxX - vb.minX + 1, height: vb.maxY - vb.minY + 1, depth: vb.maxZ - vb.minZ + 1, classes: null, _src: cover.d };
    } else {
      vol = r.needVolume(vb);
      if (!vol) return null;
      sha = vol.sha;
    }
  }
  const src = vol._src ?? vol;
  const clsAt = (x, yy, z) => {
    const b = src.box;
    if (x < b.minX || x > b.maxX || yy < b.minY || yy > b.maxY || z < b.minZ || z > b.maxZ) return VC.MISSING;
    return src.classes[((x - b.minX) * src.depth + (z - b.minZ)) * src.height + (yy - b.minY)];
  };
  // keep-critical cells (world): the host's logs (wrap_trunk); the hang points that are solid (suspend)
  const keepCritical = [];
  if (fit === 'wrap_trunk') {
    for (let x = box.minX; x <= box.maxX; x++) for (let z = box.minZ; z <= box.maxZ; z++) for (let yy = box.minY; yy <= box.maxY; yy++) if (clsAt(x, yy, z) === VC.LOG) keepCritical.push([x, yy, z]);
  } else if (fit === 'suspend') {
    // the hang points: over each corner of the box inset 2 (1 on a side under 5), the first site-solid cell above the box's top (in the
    // volume); a corner with none is left out
    const SOLID = new Set([VC.ROCK, VC.SOIL, VC.LOOSE, VC.ICE, VC.SNOW, VC.LOG]);
    const ix = W >= 5 ? 2 : 0, iz = D >= 5 ? 2 : 0;
    for (const [x, z] of [[box.minX + ix, box.minZ + iz], [box.maxX - ix, box.minZ + iz], [box.minX + ix, box.maxZ - iz], [box.maxX - ix, box.maxZ - iz]]) {
      for (let yy = box.maxY + 1; yy <= vb.maxY; yy++) if (SOLID.has(clsAt(x, yy, z))) { keepCritical.push([x, yy, z]); break; }
    }
  }
  keepCritical.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]); // (x, then y, then z: 7bF's fixtures' order)
  const design = quarter(rotation) ? [D, H, W] : [W, H, D];
  const spec = {
    volumeSha: sha, volumeBlobId: `local:${sha}`, volume: vb, fit, frame: { origin: [box.minX, box.minY, box.minZ], rotation },
    keepCritical, ports: ports === undefined ? defaultPorts(fit, design) : JSON.parse(JSON.stringify(ports)), lotId: id,
  };
  const probs = siteSpecProblems(spec);
  if (probs.length) throw new Error(`${what}: its site is not a valid SiteSpec: ${probs.join('; ')}`);
  for (const p of spec.ports) {
    const [px, py, pz] = p.at;
    if (px < 0 || py < 0 || pz < 0 || px >= design[0] || py >= design[1] || pz >= design[2]) throw new Error(`${what}: port ${p.name} at [${p.at.join(', ')}] is outside the design's ${design.join('x')} box`);
  }
  const front = FRONT_OF_ROTATION[rotation];
  const lot = {
    id, stage: lstage, part, at: [box.minX, box.minZ], size: [W, D], floorY: box.minY, front, max: [W, H, D], box,
    site: spec, affordance: a ? { id: a.id, kind: a.kind } : null, host,
  };
  if (brief !== undefined) lot.brief = String(brief).slice(0, 500);
  if (ext !== undefined) lot.ext = JSON.parse(JSON.stringify(ext));
  if (a && typeof opts.affordance === 'object') (r._affordances ??= new Map()).has(a.id) || r._affordances.set(a.id, JSON.parse(JSON.stringify(a)));
  r.lotIds.add(id);
  r._addLot(lot);
  r.meta.lots[id] = { entrance: null, part, site: true };
  return JSON.parse(JSON.stringify(lot));
}
