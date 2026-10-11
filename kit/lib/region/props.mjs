// Flat-village props (docs/CONTRACT.md "Phase 6c slice V" §3): the dry well, lamp posts, benches, planters and the opt-in bell,
// placed in the shared space at plan time. Each prop is a list of cells relative to the space's levelled top y (dy >= 1), written
// into air only (IF_AIR_OR_FLUID) in stage `props`, standing on the paving (supported), beside walk cells and never on them:
// their footprint columns are paved without the walk bit. Props never land in a lot box, on a walk cell, in the bell area or the
// golem space, or in keep-out. Counts: at most 1 well, 2-4 benches, 4 planters; lamps at the square's corners.
import { variant } from '../kit.mjs';
import { COND, stairsOf } from './program.mjs';
import { CARDINALS } from './geom.mjs';
import { toWorld, frontOf } from './village.mjs';

export const PROP_KINDS = ['well', 'lamp', 'bench', 'planter', 'bell'];

/** The cells of one prop at world (x, z) footprint origin: [[x, dy, z, state]...] and its footprint columns. */
export function propCells(kind, r, at, o = {}) {
  const [x, z] = at;
  const out = [];
  if (kind === 'lamp') {
    out.push([x, 1, z, r.material('rail', 'lamp post')], [x, 2, z, r.material('light', 'lamp light')]);
  } else if (kind === 'bench') {
    out.push([x, 1, z, stairsOf('minecraft:oak_planks', o.facing)]);
  } else if (kind === 'planter') {
    out.push([x, 1, z, 'minecraft:grass_block'], [x, 2, z, o.flower ?? 'minecraft:poppy']);
    for (const [d, [dx, dz]] of Object.entries(CARDINALS)) out.push([x + dx, 1, z + dz, `minecraft:oak_trapdoor[facing=${d},half=bottom,open=true,powered=false,waterlogged=false]`]);
  } else if (kind === 'well') {
    // a 3x3 ring (structure) around a dry water cauldron, fence posts on the ring's corners, a slab roof (dry: no fluid in V)
    const ring = r.material('structure', 'well ring');
    const slab = variant(ring.replace(/\[.*$/, ''), 'slab') ?? 'minecraft:oak_slab';
    const roof = `${slab}[type=bottom,waterlogged=false]`;
    for (let dx = 0; dx < 3; dx++) for (let dz = 0; dz < 3; dz++) {
      const cx = x + dx, cz = z + dz;
      if (dx === 1 && dz === 1) out.push([cx, 1, cz, 'minecraft:water_cauldron[level=3]']);
      else out.push([cx, 1, cz, ring]);
      if ((dx === 0 || dx === 2) && (dz === 0 || dz === 2)) out.push([cx, 2, cz, r.material('rail', 'well post')], [cx, 3, cz, r.material('rail', 'well post')]);
      out.push([cx, 4, cz, roof]);
    }
  } else if (kind === 'bell') {
    out.push([x, 1, z, r.material('structure', 'bell post')], [x, 2, z, `minecraft:bell[attachment=floor,facing=${o.facing ?? 'north'},powered=false]`]);
  } else throw new Error(`no prop '${kind}'`);
  const foot = [...new Set(out.map((c) => `${c[0]},${c[2]}`))].map((k) => k.split(',').map(Number));
  return { cells: out, foot };
}

/**
 * Plan the shared space's props (pure but for the role lookups): candidates in a fixed order, each kept when its footprint lies
 * inside the space and meets no reserved column (the bell area, the golem space, the square lots' lanes, the street's entries,
 * another prop) and no keep-out. Returns `{props: [{kind, id, cells, foot}], noWalk: Set<"x,z">}`.
 */
export function planProps(r, { o, sh, res, lots, laneWidth = 2, lamps = 'street', bell = false, keepOut = [], rng }) {
  const reserved = new Set();
  const key = (x, z) => `${x},${z}`;
  for (const [x, z] of res.area) reserved.add(key(x, z));
  for (const [x, z] of res.golem) reserved.add(key(x, z));
  const cv = Math.floor((sh.v0 + sh.v1) / 2);
  // the street's entries (square: both u edges, the street's 5 rows) and the square lots' lanes (their edge cells and the next row)
  for (const u of [sh.u0, sh.u0 + 1, sh.u1 - 1, sh.u1]) for (let dv = -2; dv <= 2; dv++) reserved.add(key(...toWorld(o, u, cv + dv)));
  for (const l of lots) {
    if (l.slot !== 'square') continue;
    const [eu] = o === 'ew' ? [l.entrance[0]] : [l.entrance[2]];
    const ev = l.side < 0 ? sh.v0 : sh.v1;
    for (let k = -1; k <= laneWidth; k++) for (const dv of [0, l.side < 0 ? 1 : -1]) reserved.add(key(...toWorld(o, eu + k, ev + dv)));
  }
  if (sh.kind !== 'square') for (let u = sh.u0; u <= sh.u1; u++) reserved.add(key(...toWorld(o, u, sh.v1))); // the green's front row
  const inside = (x, z) => {
    const [u, v] = o === 'ew' ? [x, z] : [z, x];
    return u >= sh.u0 && u <= sh.u1 && v >= sh.v0 && v <= sh.v1;
  };
  const kept = (x, z) => keepOut.some((k) => x >= k[0] && x <= k[2] && z >= k[1] && z <= k[3]);
  const props = [];
  const counts = {};
  const tryPlace = (kind, u, v, o2 = {}, max = Infinity) => {
    if ((counts[kind] ?? 0) >= max) return false;
    const at = toWorld(o, u, v);
    const p = propCells(kind, r, at, o2);
    // a prop's footprint, plus one column around it, stays clear of the reserved columns (beside walk cells, not on them)
    for (const [x, z] of p.foot) if (!inside(x, z) || reserved.has(key(x, z)) || kept(x, z)) return false;
    for (const [x, z] of p.foot) reserved.add(key(x, z));
    counts[kind] = (counts[kind] ?? 0) + 1;
    props.push({ kind, id: `${kind}_${counts[kind]}`, cells: p.cells.map(([x, dy, z, s]) => [x, sh.y + dy, z, s]), foot: p.foot });
    return true;
  };
  const { u0, u1, v0, v1 } = sh;
  if (bell) tryPlace('bell', sh.cu, cv - Math.floor(5 / 2) - 1, { facing: frontOf(o, -1) === 'south' ? 'south' : 'east' }, 1);
  if (lamps !== 'none') {
    const corners = lamps === 'few' ? [[u0, v0], [u1, v1]] : [[u0, v0], [u1, v0], [u0, v1], [u1, v1]];
    for (const [u, v] of corners) tryPlace('lamp', u, v);
  }
  if (sh.kind === 'square') {
    for (const [u, v] of [[u0, v1 - 3], [u0, v0 + 1], [u1 - 2, v1 - 3], [u1 - 2, v0 + 1]]) if (tryPlace('well', u, v, {}, 1)) break;
    // benches on the -v and +v edges, facing the square (their backs to the edge)
    // a stairs block's tall back is on its `facing` side: the edge behind the bench (-v edge: frontOf(o, 1), +v edge: frontOf(o, -1))
    for (const du of [-3, 3, -4, 4]) for (const side of [-1, 1]) tryPlace('bench', sh.cu + du, side < 0 ? v0 : v1, { facing: frontOf(o, -side) }, 4);
    const flowers = ['minecraft:poppy', 'minecraft:dandelion', 'minecraft:cornflower', 'minecraft:oxeye_daisy'];
    for (const [u, v] of [[u0 + 1, v0 + 1], [u1 - 1, v0 + 1], [u0 + 1, v1 - 1], [u1 - 1, v1 - 1]]) tryPlace('planter', u, v, { flower: rng ? rng.pick(flowers) : flowers[0] }, 4);
  }
  const noWalk = new Set();
  for (const p of props) for (const [x, z] of p.foot) noWalk.add(key(x, z));
  return { props, noWalk, counts };
}

/** Emit planned props: one part per kind in `stage`, `columns` ops at absolute y, IF_AIR_OR_FLUID (into air only). */
export function emitProps(r, plan, { stage = 'props' } = {}) {
  const byKind = new Map();
  for (const p of plan.props) { const l = byKind.get(p.kind) ?? []; l.push(p); byKind.set(p.kind, l); }
  for (const kind of PROP_KINDS) {
    const list = byKind.get(kind);
    if (!list) continue;
    const part = r.part(`props_${kind}`, { stage });
    const mats = [], mi = new Map(), cols = [];
    for (const p of list) for (const [x, y, z, s] of p.cells) {
      let i = mi.get(s);
      if (i === undefined) { i = mats.length; mats.push(s); mi.set(s, i); }
      cols.push(x, z, y, y, i);
    }
    part._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: mats, cond: COND.IF_AIR_OR_FLUID, walk: false });
    (r.meta.parts[part.id] ??= {}).kind = 'add';
  }
  (r.meta.village ??= {}).props = plan.props.map((p) => ({ kind: p.kind, id: p.id, cells: p.cells }));
  r.meta.village.propCounts = { ...plan.counts };
}
