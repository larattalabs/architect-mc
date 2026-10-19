// Flat-village props (docs/CONTRACT.md "Phase 6c slice V" §3): the dry well, lamp posts, benches, planters and the opt-in bell,
// placed in the shared space at plan time. Each prop is a list of cells relative to the space's levelled top y (dy >= 1), written
// into air only (IF_AIR_OR_FLUID) in stage `props`, standing on the paving (supported), beside walk cells and never on them:
// their footprint columns are paved without the walk bit. Props never land in a lot box, on a walk cell, in the bell area or the
// golem space, or in keep-out. Counts: at most 1 well, 2-4 benches, 4 planters; lamps at the square's corners.
import { variant } from '../kit.mjs';
import { COND, stairsOf } from './program.mjs';
import { CARDINALS } from './geom.mjs';
import { toWorld, frontOf } from './village.mjs';
import { ARM_DIRS, fixtureCells, fixtureFor } from './fixtures.mjs';

/** (6c W) The village's lamp fixture: the bible's `light` role on a post of its `rail` role (fixtures.mjs). */
export const lampFixture = (r) => fixtureFor(r.material('light', 'lamp light'), r.material('rail', 'lamp post'));

export const PROP_KINDS = ['well', 'lamp', 'bench', 'planter', 'bell'];

/** The cells of one prop at world (x, z) footprint origin: [[x, dy, z, state]...] and its footprint columns. */
export function propCells(kind, r, at, o = {}) {
  const [x, z] = at;
  const out = [];
  if (kind === 'lamp') {
    // (6c W) the bible's fixture (fixtures.mjs): a lantern post by default, cells from the floor's first cell above (dy 1)
    out.push(...fixtureCells(o.fixture ?? lampFixture(r), [x, 1, z], { arm: o.arm }).cells);
  } else if (kind === 'bench') {
    out.push([x, 1, z, stairsOf('minecraft:oak_planks', o.facing)]);
  } else if (kind === 'planter') {
    out.push([x, 1, z, 'minecraft:grass_block'], [x, 2, z, o.flower ?? 'minecraft:poppy']);
    for (const [d, [dx, dz]] of Object.entries(CARDINALS)) out.push([x + dx, 1, z + dz, `minecraft:oak_trapdoor[facing=${d},half=bottom,open=true,powered=false,waterlogged=false]`]);
  } else if (kind === 'well') {
    // a 3x3 ring (structure) around a dry water cauldron, fence posts on the ring's corners, a slab roof (dry: no fluid in V; (6c H)
    // o.water: no cauldron, the shaft open over a source 1 under the ring)
    const ring = r.material('structure', 'well ring');
    const slab = variant(ring.replace(/\[.*$/, ''), 'slab') ?? 'minecraft:oak_slab';
    const roof = `${slab}[type=bottom,waterlogged=false]`;
    for (let dx = 0; dx < 3; dx++) for (let dz = 0; dz < 3; dz++) {
      const cx = x + dx, cz = z + dz;
      // ((6c H) a wet well, o.water: the shaft stays open over the source the well's body writes 1 under the ring: pond.mjs wetWell)
      if (dx === 1 && dz === 1) { if (!o.water) out.push([cx, 1, cz, 'minecraft:water_cauldron[level=3]']); }
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
export function planProps(r, { o, sh, res, lots, laneWidth = 2, lamps = 'street', bell = false, keepOut = [], rng, wellWater = false }) {
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
  const taken = new Set(); // the props' own footprint columns
  const tryPlace = (kind, u, v, o2 = {}, max = Infinity) => {
    if ((counts[kind] ?? 0) >= max) return false;
    const at = toWorld(o, u, v);
    const p = propCells(kind, r, at, o2);
    // a prop's footprint, plus one column around it, stays clear of the reserved columns (beside walk cells, not on them)
    for (const [x, z] of p.foot) if (!inside(x, z) || reserved.has(key(x, z)) || kept(x, z)) return false;
    // beside walk cells: one 4-neighbour of the footprint stays a walk cell of the space (kept from later props)
    const foot = new Set(p.foot.map(([x, z]) => key(x, z)));
    let beside = null, bestRank = Infinity;
    const [ccx, ccz] = toWorld(o, sh.cu, cv);
    for (const [x, z] of p.foot) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = key(x + dx, z + dz);
      if (foot.has(k) || !inside(x + dx, z + dz) || taken.has(k)) continue;
      const rank = (reserved.has(k) ? 0 : 1000) + Math.abs(x + dx - ccx) + Math.abs(z + dz - ccz);
      if (rank < bestRank) { bestRank = rank; beside = k; }
    }
    if (!beside) return false;
    for (const [x, z] of p.foot) { reserved.add(key(x, z)); taken.add(key(x, z)); }
    reserved.add(beside);
    counts[kind] = (counts[kind] ?? 0) + 1;
    props.push({ kind, id: `${kind}_${counts[kind]}`, cells: p.cells.map(([x, dy, z, s]) => [x, sh.y + dy, z, s]), foot: p.foot });
    return true;
  };
  const { u0, u1, v0, v1 } = sh;
  // every placement inside the space, the preferred spots first (a generic scan when those are taken: small squares, lots'
  // lanes, the street's entries)
  const cells = [];
  for (let u = u0; u <= u1; u++) for (let v = v0; v <= v1; v++) cells.push([u, v]);
  const far = (u, v) => -(Math.abs(u - sh.cu) + Math.abs(v - cv));
  const scan = (kind, prefer, o2, max, w = 1) => {
    for (const [u, v] of prefer) if (tryPlace(kind, u, v, typeof o2 === 'function' ? o2(u, v) : o2, max)) return true;
    const rest = cells.filter(([u, v]) => u + w - 1 <= u1 && v + w - 1 <= v1).sort((a2, b2) => far(...a2) - far(...b2) || a2[0] - b2[0] || a2[1] - b2[1]);
    for (const [u, v] of rest) if (tryPlace(kind, u, v, typeof o2 === 'function' ? o2(u, v) : o2, max)) return true;
    return false;
  };
  if (bell) scan('bell', [[sh.cu, cv - 3], [sh.cu, cv + 3], [sh.cu - 3, cv], [sh.cu + 3, cv]], { facing: o === 'ew' ? 'north' : 'west' }, 1);
  if (sh.kind === 'square') {
    scan('well', [[u0, v0], [u0, v1 - 2], [u1 - 2, v0], [u1 - 2, v1 - 2]], wellWater ? { water: true } : {}, 1, 3);
  }
  if (sh.kind === 'square') {
    // benches on the -v and +v edges, facing the square: a stairs block's tall back is on its `facing` side, the edge behind it
    // 2 on a square up to 11, 4 on a larger one (room for the planters)
    const maxBench = sh.u1 - sh.u0 + 1 <= 11 ? 2 : 4;
    let benches = 0;
    for (const du of [-3, 3, -4, 4, -2, 2, -5, 5, -1, 1]) for (const side of [-1, 1]) if (benches < maxBench && tryPlace('bench', sh.cu + du, side < 0 ? v0 : v1, { facing: frontOf(o, -side) }, 4)) benches++;
  }
  if (sh.kind === 'square') {
    // planters (a plus of trapdoors round a flower on grass) in the free corners
    const flowers = ['minecraft:poppy', 'minecraft:dandelion', 'minecraft:cornflower', 'minecraft:oxeye_daisy'];
    for (const [u, v] of [[u0 + 1, v0 + 1], [u1 - 1, v0 + 1], [u0 + 1, v1 - 1], [u1 - 1, v1 - 1]]) tryPlace('planter', u, v, { flower: rng ? rng.pick(flowers) : flowers[0] }, 4);
  }
  if (lamps !== 'none') {
    const fixture = lampFixture(r);
    const arms = fixture.kind === 'hanging_lantern' ? ARM_DIRS : [undefined];
    const edge = cells.filter(([u, v]) => u === u0 || u === u1 || v === v0 || v === v1);
    const placeNear = (cu0, cv0) => {
      const near = [...edge].sort((a2, b2) => (Math.abs(a2[0] - cu0) + Math.abs(a2[1] - cv0)) - (Math.abs(b2[0] - cu0) + Math.abs(b2[1] - cv0)) || a2[0] - b2[0] || a2[1] - b2[1]);
      for (const [u, v] of near) for (const arm of arms) if (tryPlace('lamp', u, v, { fixture, arm })) return true;
      return false;
    };
    const corners = lamps === 'few' ? [[u0, v0], [u1, v1]] : [[u0, v0], [u1, v0], [u0, v1], [u1, v1]];
    // a corner, or the free edge cell nearest to it
    for (const [cu0, cv0] of corners) placeNear(cu0, cv0);
    // (6c W) a weaker fixture (a soul lantern's 10, a torch's 14) covers less: more edge lamps, each at the free edge cell nearest
    // the space's cell farthest from every lamp's light, until each cell is within the fixture's reach (at most 8 lamps)
    if (lamps === 'street' && fixture.level < 15) {
      const lightOf = (p) => p.cells.find((c) => c[3] === fixture.light) ?? p.cells[p.cells.length - 1];
      const reach = (u, v) => {
        const [x, z] = toWorld(o, u, v);
        let best = Infinity;
        for (const p of props) if (p.kind === 'lamp') { const L = lightOf(p); best = Math.min(best, Math.abs(L[0] - x) + Math.abs(L[2] - z) + Math.max(0, L[1] - (sh.y + 1))); }
        return best;
      };
      for (let guard = 0; guard < 8 && (counts.lamp ?? 0) < 8; guard++) {
        let far = null, fd = -1;
        for (const [u, v] of cells) { const d = reach(u, v); if (d > fd) { fd = d; far = [u, v]; } }
        if (!far || fd < fixture.level) break;
        if (!placeNear(...far)) break;
      }
    }
  }
  const noWalk = new Set();
  for (const p of props) for (const [x, z] of p.foot) noWalk.add(key(x, z));
  return { props, noWalk, counts };
}

/** Emit planned props: one part per kind in `stage`, `columns` ops at absolute y, IF_AIR_OR_FLUID (into air only). */
export function emitProps(r, plan, { stage = 'props', prefix = '' } = {}) {
  // (6c P0) `prefix`: a plan's second zone on (its part ids and its meta under r.meta.villageZones[prefix])
  const byKind = new Map();
  for (const p of plan.props) { const l = byKind.get(p.kind) ?? []; l.push(p); byKind.set(p.kind, l); }
  for (const kind of PROP_KINDS) {
    const list = byKind.get(kind);
    if (!list) continue;
    const part = r.part(`${prefix}props_${kind}`, { stage });
    const mats = [], mi = new Map(), cols = [];
    for (const p of list) for (const [x, y, z, s] of p.cells) {
      let i = mi.get(s);
      if (i === undefined) { i = mats.length; mats.push(s); mi.set(s, i); }
      cols.push(x, z, y, y, i);
    }
    part._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: mats, cond: COND.IF_AIR_OR_FLUID, walk: false });
    (r.meta.parts[part.id] ??= {}).kind = 'add';
  }
  const vm = prefix ? ((r.meta.villageZones ??= {})[prefix] ??= {}) : (r.meta.village ??= {});
  vm.props = plan.props.map((p) => ({ kind: p.kind, id: p.id, cells: p.cells }));
  vm.propCounts = { ...plan.counts };
}
