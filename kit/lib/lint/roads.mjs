// (fast checks P2) The 4e street lanterns as the mod lays them at realise (mod RoadPlan.lanterns + RoadTerrain.kind), laid into a
// virtual world so the lints see the posts and their light as the realised world holds them. vworld.mjs writes a 4e road's surface
// only; light.mjs models the lanterns' light for the lamp cover but not the posts, and not the post-foot rules.
//
// Mirrors RoadPlan.lanterns (fix/lamp-path c494ddab): the first `first` cells out, then every `every`, on the first side (hi + 1, then
// lo - 1) whose column is off the walkway; for dy in 0, +1, -1 from the centre's height: the foot (the cell under the post) is natural
// ground that is not a dirt path, or a built block / dirt path the road's own owner wrote (ownFoot: in a virtual world, a cell the
// region wrote); the post's and lantern's cells open (air or clearable, not a double plant); never in a protected column. A lamp
// fixture (the IR road's `lamp`) stands its cells along the travel, each open, off the walkway (but its foot), not over a dirt path
// the road's owner didn't write. Not placed: since = every / 2 (the next try half a spacing on).
//
// `preFix: 'lamp-path'` reproduces RoadPlan before 52cc9606 (a dirt path counted as natural ground for the foot, whoever wrote it):
// the reverted-code mutation of the lamp-on-dirt-path bug, for the lint's mutation evidence. Java is the real writer; this model is
// kept honest by the realised == virtual SMOKE row (tools/lib/realised-virtual.mjs: a post where the model has none differs).
import { hasTag, info } from '../blocks.mjs';
import { centreCells, crossOffsets, rightOf, segmentAxis } from '../region/geom.mjs';
import { F_WRITTEN } from '../region/vworld.mjs';

export const K = Object.freeze({ AIR: 0, PLANT: 1, STACK: 2, LEAVES: 3, LOG: 4, WATER: 5, LAVA: 6, DIRT: 7, SAND: 8, STONE: 9, MUD: 10, PATH: 11, BUILT: 12, BUILT_OPEN: 13, BLOCK_ENTITY: 14 });
const LANTERN_SPACING = 12, LANTERN_FIRST = 6;
const FENCE = 'minecraft:oak_fence[east=false,north=false,south=false,waterlogged=false,west=false]';
const LANTERN = 'minecraft:lantern[hanging=false,waterlogged=false]';

const kindCache = new Map();
/** RoadTerrain.kind over a block state string (the kit's tags for vanilla's; frozen-water ice counts as ice here, not water). */
export function roadKind(state) {
  let k = kindCache.get(state);
  if (k !== undefined) return k;
  const name = state.replace(/\[.*$/, '');
  const props = state.includes('[') ? state.slice(state.indexOf('[') + 1, -1) : '';
  const bi = info(name);
  const fam = bi?.family ?? null;
  if (/^minecraft:(air|cave_air|void_air)$/.test(name)) k = K.AIR;
  else if (name === 'minecraft:lava') k = K.LAVA;
  else if (name === 'minecraft:water' || name === 'minecraft:bubble_column' || /waterlogged=true/.test(props)) k = K.WATER;
  else if (bi?.be) k = K.BLOCK_ENTITY;
  else if (name === 'minecraft:fire' || name === 'minecraft:soul_fire' || name === 'minecraft:light') k = K.BUILT_OPEN;
  else if (hasTag(name, 'minecraft:leaves')) k = K.LEAVES;
  else if (hasTag(name, 'minecraft:logs') || name === 'minecraft:cactus') k = K.LOG;
  else if (fam === 'double_plant' || /^minecraft:(tall_grass|large_fern|sunflower|lilac|rose_bush|peony|pitcher_plant|sugar_cane|bamboo|small_dripleaf)$/.test(name)) k = K.STACK;
  else if (/^minecraft:(snow|lily_pad|brown_mushroom|red_mushroom)$/.test(name) || hasTag(name, 'minecraft:replaceable_by_trees') || hasTag(name, 'minecraft:flowers') || hasTag(name, 'minecraft:saplings') || hasTag(name, 'minecraft:small_flowers')) k = K.PLANT;
  else if (name === 'minecraft:dirt_path') k = K.PATH;
  else if (name === 'minecraft:farmland') k = K.BUILT;
  else if (hasTag(name, 'minecraft:ores')) k = K.STONE;
  else if (name === 'minecraft:mud' || name === 'minecraft:muddy_mangrove_roots') k = K.MUD;
  else if (hasTag(name, 'minecraft:dirt') || hasTag(name, 'minecraft:substrate_overworld') || hasTag(name, 'minecraft:grass_blocks') || hasTag(name, 'minecraft:moss_blocks')) k = K.DIRT;
  else if (hasTag(name, 'minecraft:sand') || name === 'minecraft:gravel') k = K.SAND;
  else if (hasTag(name, 'minecraft:base_stone_overworld') || hasTag(name, 'minecraft:base_stone_nether') || hasTag(name, 'minecraft:badlands_terracotta') || /^minecraft:(sandstone|red_sandstone|clay|snow_block|terracotta)$/.test(name)) k = K.STONE;
  else if (bi && bi.collision === 'none' && (bi.v === 'PLANT' || bi.family === 'plant')) k = K.PLANT;
  else k = bi && bi.collision === 'none' ? K.BUILT_OPEN : K.BUILT;
  kindCache.set(state, k);
  return k;
}
const ground = (k) => k === K.DIRT || k === K.SAND || k === K.STONE || k === K.MUD || k === K.PATH;
const open = (k) => k === K.AIR || k === K.PLANT || k === K.STACK || k === K.LEAVES;

/**
 * Lay every 4e road's lanterns (roads with `lanterns`) into `vw` (as written cells of the road's part). `protect(x, z)`: a protected
 * column (the owner's areas, other regions, builds) or null. Returns `{posts: [{road, foot: [x, y, z], footState, own, cells}],
 * skipped: n, lights: [[x, y, z, level]]}`.
 */
export function layRoadLanterns(vw, ir, { protect = () => false, preFix = null } = {}) {
  const P = vw.pal;
  const partIdx = new Map(ir.parts.map((p, i) => [p.id, i]));
  const out = { posts: [], skipped: 0, lights: [] };
  const st = (x, y, z) => P.states[vw.get(x, y, z)];
  const own = (x, y, z) => (vw.flags(x, y, z) & F_WRITTEN) !== 0;
  for (const r of ir.roads ?? []) {
    if (!r.lanterns) continue;
    const pi = partIdx.get(r.part) ?? -1;
    const pts = r.points.map((p) => [p[0], p[2]]);
    const { cells } = centreCells(pts);
    const offs = crossOffsets(r.width);
    const hi = offs[offs.length - 1], lo = offs[0];
    const walk = new Set();
    for (const c of cells) {
      const a = pts[Math.min(c.seg, pts.length - 1)], b = pts[Math.min(c.seg + 1, pts.length - 1)];
      const rr = rightOf(segmentAxis(a, b));
      for (const k of offs) walk.add(`${c.x + rr[0] * k},${c.z + rr[1] * k}`);
    }
    const lamp = r.lamp ?? null;
    const every = lamp ? lamp.every : LANTERN_SPACING;
    let since = every - (lamp ? lamp.first : LANTERN_FIRST);
    for (let i = 1; i < cells.length - 1; i++) {
      since += 1;
      if (since + 1e-9 < every) continue;
      const c = cells[i], n = cells[i + 1];
      const dx = Math.sign(n.x - c.x), dz = Math.sign(n.z - c.z);
      const rx = -dz, rz = dx;
      const t = vw.colTop(c.x, c.z); // the road's surface at its centre (vworld lays the surface at the column's pre-region top)
      let placed = false;
      for (const side of [hi + 1, lo - 1]) {
        const qx = c.x + side * rx, qz = c.z + side * rz;
        if (walk.has(`${qx},${qz}`) || !vw.inClaim(qx, qz)) continue;
        for (const dy of [0, 1, -1]) {
          const y = t + 1 + dy; // the post's cell (the feet row over the surface row t)
          const bs = st(qx, y - 1, qz), below = roadKind(bs);
          const foot = preFix === 'lamp-path'
            ? ground(below) || (below === K.BUILT && own(qx, y - 1, qz))
            : (ground(below) && below !== K.PATH) || ((below === K.BUILT || below === K.PATH) && own(qx, y - 1, qz));
          if (!foot) continue;
          if (!lamp) {
            const f = roadKind(st(qx, y, qz)), l = roadKind(st(qx, y + 1, qz));
            if (!open(f) || !open(l) || f === K.STACK || l === K.STACK || protect(qx, qz)) continue;
            vw.set(qx, y, qz, P.of(FENCE), 0, pi);
            vw.set(qx, y + 1, qz, P.of(LANTERN), 0, pi);
            out.posts.push({ road: r.id, foot: [qx, y - 1, qz], footState: bs, own: own(qx, y - 1, qz), cells: [[qx, y, qz], [qx, y + 1, qz]] });
            out.lights.push([qx, y + 1, qz, 15]);
            placed = true;
            break;
          }
          let ok = true;
          const cs = [];
          for (const [along, ddy, state] of lamp.cells) {
            const cx = qx + along * dx, cz = qz + along * dz, cy = y + ddy;
            const kd = roadKind(st(cx, cy, cz));
            const under = roadKind(st(cx, cy - 1, cz));
            ok = open(kd) && kd !== K.STACK && (along === 0 || !walk.has(`${cx},${cz}`)) && !protect(cx, cz)
              && (preFix === 'lamp-path' || under !== K.PATH || own(cx, cy - 1, cz));
            if (!ok) break;
            cs.push([cx, cy, cz, state]);
          }
          if (!ok) continue;
          for (const [x, yy, z, s] of cs) vw.set(x, yy, z, P.of(s), 0, pi);
          const lc = cs[lamp.light];
          out.posts.push({ road: r.id, foot: [qx, y - 1, qz], footState: bs, own: own(qx, y - 1, qz), cells: cs.map((q) => q.slice(0, 3)) });
          out.lights.push([lc[0], lc[1], lc[2], P.emit[P.of(lc[3])]]);
          placed = true;
          break;
        }
        if (placed) break;
      }
      if (placed) since = 0;
      else { out.skipped++; since = every / 2; }
    }
  }
  return out;
}
