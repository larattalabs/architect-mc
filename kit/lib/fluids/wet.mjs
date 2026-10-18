// (6c H-b) The wet fallback and wet columns (docs/CONTRACT.md "Phase 6c slice H" §1.2, §8, §10; Steward's S-H-4: a fallback only).
// Slice H-b owns this file; it must not import compile.mjs or program.mjs.
//
// Only a leg or a wall that fails because of water is searched once more with wet writes allowed; only surveyed (natural) water is ever
// made passable (plan-made water stays an obstacle); a plan with no such failure plans and checks byte for byte as before.
//
//   wetBridgeFallback(K, l, m, why) -> options | null
//       compile.mjs's route rounds, after T3's street fallback (S-T3-2) and before the leg's answer: a street, road, path or bridge leg
//       whose route still fails because a pier is needed in water (`why` 'BRIDGE' with the bridge row's diagnosis WATER, or
//       'ROUTE_WATER' after T3's fallback) gets leg options to route it again with wet piers (merged into l.k1: its t3.bridge gains
//       `wet: {waterDepth}`): one more round, never twice (l.wet). null: no wet fallback (the leg answers as before, its WATER with no
//       `until`). Costs (§8.1): the bridge row's 320 + 30 n + 40 per pier, plus 10 per wet pier cell, so a dry crossing wins where it
//       fits. The caller's frozen volumes with a fluid layer are asked here (outside the round's checkpoint, so their side blobs stay).
//   wetWallFallback(K, wall, failure) -> options | null
//       wall.mjs's ring and line search (K1a's planWalls), where a ring or line fails on OB.WATER: the options to search it again with
//       natural water columns up to waterDepth (default 6) as clear at cost 3 a cell (dry 1). null: no wet fallback (WATER as before).
//
//   wetColumn(vols, x, z, surface, floor, {waterDepth}) -> {ok, why?, bed, depth, covered}
//       one natural water column under a wet write: its bed and depth from the frozen volume where one with a fluid layer covers it,
//       and whether a wet write may stand there: water sources, ice over water and water plants only (never flowing water, lava or a
//       bubble column), at most waterDepth deep. With no fluid volume at all (the first plan) the survey's floor stands in
//       (`covered: false`); once the plan holds fluid volumes (the second plan), a column none of them covers is `unread` (not ok),
//       so the second plan only stands wet writes where it read the water.
import { VC, blockAt, classAt, fluidAt, FC } from '../region/volume.mjs';
import { info, isCube, isFluidStopping, isGravity, qualify } from '../blocks.mjs';

/** §8's numbers: the default depths, the costs, the volume a wet column asks (bed - 3 .. surface + 1). */
export const WET = Object.freeze({ bridgeDepth: 8, wallDepth: 6, quayDepth: 8, costPierCell: 10, wallCell: 3, below: 3, above: 1 });
/** Water plants: dependents that become water (kelp, seagrass, sea pickle); a wet write may replace them. */
export const WATER_PLANTS = Object.freeze(['minecraft:kelp', 'minecraft:kelp_plant', 'minecraft:seagrass', 'minecraft:tall_seagrass', 'minecraft:sea_pickle']);
/** The connector kinds a wet bridge fallback serves (T3's fallback kinds and the bridge). */
export const WET_LEG_KINDS = Object.freeze(['street', 'road', 'path', 'bridge']);

/** The frozen volumes with a fluid layer among `vols` (decoded volumes, or ctx.volumes entries). */
export function fluidVolumes(vols) {
  return (vols ?? []).map((v) => (v && v.decoded ? v.decoded : v)).filter((v) => v && v.fluids);
}

/** The first volume covering a cell with its fluid layer, or null. */
function volAt(vols, x, y, z) {
  for (const v of vols) if (fluidAt(v, x, y, z) !== null) return v;
  return null;
}

/**
 * One water column under a wet write. `surface`: the survey's top water (or ice) cell; `floor`: the survey's bed. Read from the frozen
 * volume where one covers the column (its fluid layer): every cell from the surface down to the bed a water source, ice or a water
 * plant; the bed the first cell under them that is none of these. Returns {ok, why ('deep' | 'flowing' | 'lava' | 'blocked'), bed,
 * depth, covered, bubble?}.
 */
export function wetColumn(vols, x, z, surface, floor, { waterDepth }) {
  const v = vols.length ? volAt(vols, x, surface, z) : null;
  if (!v && vols.length) return { ok: false, why: 'unread', bed: floor, depth: surface - floor, covered: false };
  if (!v) {
    const depth = surface - floor;
    return { ok: depth <= waterDepth, ...(depth > waterDepth ? { why: 'deep' } : {}), bed: floor, depth, covered: false };
  }
  let bed = null;
  for (let y = surface; y >= v.box.minY; y--) {
    const c = classAt(v, x, y, z), f = fluidAt(v, x, y, z), b = blockAt(v, x, y, z);
    if (c === VC.OWNED || c === VC.PLAYER || c === VC.BLOCK_ENTITY) return { ok: false, why: 'blocked', bed: floor, depth: surface - floor, covered: true, at: [x, y, z] };
    if (f === FC.water_flowing || f === FC.water_falling) return { ok: false, why: 'flowing', bed: floor, depth: surface - floor, covered: true, at: [x, y, z] };
    if (f === FC.lava_source || f === FC.lava_flowing || c === VC.LAVA) return { ok: false, why: 'lava', bed: floor, depth: surface - floor, covered: true, at: [x, y, z] };
    if (b === 'minecraft:bubble_column') return { ok: false, why: 'flowing', bubble: true, bed: floor, depth: surface - floor, covered: true, at: [x, y, z] };
    // (a water cell the fluid layer records as a source, or with no level: the class says water)
    const water = f === FC.water_source || WATER_PLANTS.includes(b) || (c === VC.WATER && f !== FC.waterlogged);
    const ice = c === VC.ICE;
    if (water || ice) continue;
    bed = y;
    break;
  }
  if (bed === null) return { ok: false, why: 'deep', bed: v.box.minY, depth: surface - v.box.minY + 1, covered: true };
  const depth = surface - bed;
  return { ok: depth <= waterDepth, ...(depth > waterDepth ? { why: 'deep' } : {}), bed, depth, covered: true };
}

/** The why's priority when a run of water columns refuses a wet write (the answer's `kind`). */
export function wetKind(whys) {
  for (const k of ['lava', 'flowing', 'deep', 'unread']) if (whys.includes(k)) return k;
  return 'deep';
}

/** The box a set of wet columns asks ([[x, z, bed, surface]]): bed - 3 .. surface + 1 over their xz bounds. */
export function wetBox(cols) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, z, bed, surface] of cols) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    minY = Math.min(minY, bed - WET.below); maxY = Math.max(maxY, surface + WET.above);
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/** The `{sha, box}` of the volume the plan read over `box` (r.volumesUsed), or null. */
export function volumeRef(r, box) {
  const u = Object.values(r.volumesUsed ?? {}).find((q) => q.box.minX === box.minX && q.box.minY === box.minY && q.box.minZ === box.minZ && q.box.maxX === box.maxX && q.box.maxY === box.maxY && q.box.maxZ === box.maxZ);
  return u ? { sha: u.sha, box: [box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ] } : null;
}

/**
 * Ask (and, where the caller holds it, read) the fluid volume over a wet structure's columns: `{volume (decoded) | null, ref ({sha, box})
 * | null, box}`. The first plan answers null (the two-plan flow plans again with it).
 */
export function askWet(r, cols) {
  const box = wetBox(cols);
  const volume = r.needVolume(box, { fluids: true });
  return { volume, ref: volume ? volumeRef(r, box) : null, box };
}

/**
 * Record a wet write in the plan meta (body.mjs recordWet's shape, `{id, part, kind, columns: [[x, z, y0, y1]] sorted, volume}`), kept
 * here so the bridge and wall modules need not import body.mjs (which imports the region program: an import cycle).
 */
export function noteWet(r, { id, part = null, kind, columns, volume = null }) {
  const rec = { id, part, kind, columns: columns.map((q) => [...q]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]), volume };
  (r.meta.wet ??= []).push(rec);
  return rec;
}

/** A wet structure's columns as the record keeps them: bed - 3 .. surface + 1 ([[x, z, bed, surface]] in). */
export const wetRuns = (cols) => cols.map(([x, z, bed, surface]) => [x, z, bed - WET.below, surface + WET.above]);

/** Whether a block may stand under a water surface (§1.2): full, fluid-stopping, no gravity, not waterloggable. */
export function underwaterOk(b) {
  if (typeof b !== 'string') return false;
  const name = qualify(b.replace(/\[.*$/, ''));
  const i = info(name);
  return !!i && isCube({ name }) && isFluidStopping(name) && !isGravity(name) && !Object.hasOwn(i.props ?? {}, 'waterlogged');
}

/** The first block of a chain that may stand under a water surface, else stone bricks. */
export function underwaterBlock(chain) {
  for (const b of chain) if (underwaterOk(b)) return b;
  return 'minecraft:stone_bricks';
}

/**
 * The caller's frozen volumes with a fluid layer, asked through needVolume now (so the IR records each and its side blob is written
 * outside any checkpoint a later rollback would undo). Returns the decoded ones.
 */
export function holdFluidVolumes(K) {
  const out = [];
  for (const v of K.ctx.volumes ?? []) {
    if (!v?.decoded?.fluids) continue;
    const d = K.r.needVolume(v.box, { fluids: true });
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/** A leg that still fails because a pier is needed in water: route it once more with wet piers (§8.1, §8.4). */
export function wetBridgeFallback(K, l, m, why) {
  if (!l?.conn || !K?.r || !WET_LEG_KINDS.includes(l.conn.kind)) return null;
  // only a failure on water: the bridge row's WATER (a pier needed in water), or every route crossing water after T3's fallback
  if (why === 'BRIDGE' && m?.bridge?.code !== 'WATER') return null;
  if (why === 'ROUTE_WATER' && !l.fallback && l.conn.kind !== 'bridge') return null;
  if (why !== 'BRIDGE' && why !== 'ROUTE_WATER') return null;
  const part = l.conn.part ?? {};
  const waterDepth = Number.isInteger(part.waterDepth) ? part.waterDepth : WET.bridgeDepth;
  holdFluidVolumes(K);
  // the pass-level bridge input caches its volumes: read them again with the fluid volumes held
  if (K.bridge) K.bridge.input = undefined;
  (K.wet ??= { legs: [] }).legs.push({ conn: l.conn.id, leg: l.k, why, waterDepth });
  const t3 = l.k1?.t3 ?? {};
  // (a street that took T3's fallback carries its spans; a bridge leg its own)
  const spans = l.k1?.spans ?? ['bridge'];
  return { spans, t3: { ...t3, bridge: { ...(t3.bridge ?? { form: 'auto', diagnose: true }), wet: { waterDepth } } } };
}

/** A wall that fails on water: the options to search it again with natural water columns as clear (§8.2). */
export function wetWallFallback(K, wall, failure) {
  if (failure?.code !== 'WATER' || !K?.r) return null;
  const part = wall?.part ?? {};
  const waterDepth = Number.isInteger(part.waterDepth) ? part.waterDepth : WET.wallDepth;
  return { waterDepth, vols: holdFluidVolumes(K) };
}
