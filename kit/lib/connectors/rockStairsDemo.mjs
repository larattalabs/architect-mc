// (7a RK) rockstairs_demo's sections (docs/CONTRACT.md "Phase 7a slice RK" §8, N-RK-1): the flat variant's two raised hills and the
// natural variant's pick of a flight on the pinned hill. Each section gives the route nodes and edge of one rock stair (a rock stair
// edge: exactly one flight, the walks at its ends), which kit/regions/rockstairs_demo.mjs routes and emits. Pure plan-time code.
//   flat:    on the claim's north half a ridge (v7a_rk_ridge's shape) raised in stage `ground` through the shared base: the ground rises
//            1 a cell for 8 cells, then a cliff to a plateau 20 over the flat, a sand band 2 thick inside the cliff (the bored flight's
//            roof lined); a flight up it is flush on the slope, bored under the cliff and cut near the top. On the south half a terraced
//            slope 3 over a flight of rise 16 (its landings' shelves included): a flight up it is carved 3 deep the whole way, walls
//            lined where soil shows and parapets on both lips. Both hills' corridor is one frozen volume (the two-plan flow).
//   natural: the pinned hill (scenarios/sites/tunnel_hill.json): the claim's best straight flight by the survey (every tread within the
//            fill of the ground, the landing at grade, no tree or water near), checked by rockStairGeom over the claim's frozen volume.
import { ROCK, flightLength, flightProfile, rockStair, rockStairGeom } from './rockStairGeom.mjs';
import { tunnelLand } from './tunnelGeom.mjs';
import { latOn, rightOf } from './ropeGeom.mjs';
import { VOXEL_CLASSES, classAt as volumeClassAt } from '../region/volume.mjs';

/** The flat variant's layout (offsets from the claim's min corner) and its claim's least size. */
export const FLAT = Object.freeze({ W: 200, D: 96, slope: 8, cliff: 20, ridge: [8, 40], carved: [56, 88], foot: 40, rise: 16, band: [0, 5], approach: 16 });
const classOfVolume = (v, x, y, z) => VOXEL_CLASSES[volumeClassAt(v, x, y, z)];
const STATE = new WeakMap();
const baseAt = (base, x, z) => {
  const i = x - base.minX, j = z - base.minZ;
  return i >= 0 && j >= 0 && i < base.width && j < base.depth ? base.values[i + j * base.width] : 0;
};
const edgeOf = (id, from, to, approach) => ({ id, from, to, width: 2, movers: ['player', 'villager'], spans: ['rock_stair'], once: 'rock_stair', approach, t7: { rock_stair: { width: 2 } } });

/**
 * The flat section (stage `ground`): the two hills raised (stone, 3 of dirt, grass on top; the sand band LOOSE), their corridor asked
 * as one frozen volume. `{nodes, edges, input, note}`; without the volume (the first plan) no edge.
 */
export function flatSection(ctx, r, base) {
  const { survey: S, claim } = ctx;
  const x0 = claim.minX, z0 = claim.minZ, g0 = S.groundAt(x0 + FLAT.foot, z0 + FLAT.ridge[0]);
  const xa = x0 + FLAT.foot, xEnd = x0 + FLAT.W - 40;
  // the carved slope's profile: 3 over a flight of rise 16 from the foot (its landings' shelves included), then the plateau 3 over its top
  const P = flightProfile(g0, FLAT.rise);
  const carvedH = (dx) => (dx < 1 ? 0 : dx <= P.L ? P.ys[dx] + 3 - g0 : FLAT.rise + 3);
  const ridgeH = (dx) => (dx < 1 ? 0 : dx <= FLAT.slope ? dx : FLAT.cliff);
  const part = r.part('rk_hills', { stage: 'ground' });
  const mats = [r.material('surface', 'hill'), r.material('subsurface', 'hill'), r.material('rock', 'hill'), r.material('minecraft:sand', 'hill band')];
  const cols = [], written = [];
  const band = { x: [xa + FLAT.slope + 1 + FLAT.band[0], xa + FLAT.slope + 1 + FLAT.band[1]], y: [g0 + 16, g0 + 17], z: [z0 + FLAT.ridge[0], z0 + FLAT.ridge[1]] };
  for (const [[za, zb], hOf] of [[FLAT.ridge, ridgeH], [FLAT.carved, carvedH]]) {
    for (let z = z0 + za; z <= z0 + zb; z++) for (let x = xa; x <= xEnd; x++) {
      const h = hOf(x - xa);
      if (h <= 0) continue;
      base.values[(x - base.minX) + (z - base.minZ) * base.width] += h;
      const g = S.groundAt(x, z), top = g + h;
      for (let y = g + 1; y <= top; y++) {
        const inBand = hOf === ridgeH && x >= band.x[0] && x <= band.x[1] && y >= band.y[0] && y <= band.y[1];
        cols.push(x, z, y, y, y === top ? 0 : y >= top - 3 ? 1 : inBand ? 3 : 2);
      }
      written.push({ box: [x, top - 3, z, x, top, z], class: 'SOIL' });
    }
    written.unshift({ box: [xa, -2048, z0 + za, xEnd, 4096, z0 + zb], class: 'ROCK' });
  }
  written.push({ box: [band.x[0], band.y[0], band.z[0], band.x[1], band.y[1], band.z[1]], class: 'LOOSE' });
  part._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: mats, cond: 2, walk: false });
  (r.meta.parts.rk_hills ??= {}).kind = 'add';
  // the corridor: both hills' lines and their approaches, from 16 under the flat to 1 over the plateau
  const box = { minX: xa - FLAT.approach - 8, minY: Math.max(claim.minY ?? -64, g0 - 16), minZ: z0 + FLAT.ridge[0], maxX: xa + 60, maxY: g0 + FLAT.cliff + 1, maxZ: z0 + FLAT.carved[1] };
  const vol = r.needVolume(box);
  STATE.set(r, { S, base, written, volumes: vol ? [vol] : [] });
  r.meta.rockStairsDemo = { variant: 'flat', foot: xa, ground: g0, ridge: FLAT.ridge.map((v) => z0 + v), carved: FLAT.carved.map((v) => z0 + v), cliff: FLAT.cliff, rise: FLAT.rise, band };
  const note = `flat: a ridge (a slope of ${FLAT.slope}, then a cliff to ${FLAT.cliff} over the flat, a sand band inside it) and a slope terraced 3 over a flight of rise ${FLAT.rise}`;
  if (!vol) return { nodes: {}, edges: [], input: null, note: `${note}; their corridor asked as a frozen volume (the second plan reads it)` };
  const zr = z0 + ((FLAT.ridge[0] + FLAT.ridge[1]) >> 1), zc = z0 + ((FLAT.carved[0] + FLAT.carved[1]) >> 1);
  const node = (x, z) => ({ at: [x, S.groundAt(x, z) + baseAt(base, x, z) + 1, z], kind: 'junction' });
  const nodes = { ridge_foot: node(xa - 12, zr), ridge_top: node(xa + 40, zr), carved_foot: node(xa - 12, zc), carved_top: node(xa + P.L + 1 + 12, zc) };
  const edges = [edgeOf('ridge', 'ridge_foot', 'ridge_top', FLAT.approach), edgeOf('carved', 'carved_foot', 'carved_top', FLAT.approach)];
  return { nodes, edges, input: { volumes: [vol], written }, note };
}

/**
 * The natural section: the claim's straight flights by the survey, best first: every tread's lanes within the fill (1) of the ground
 * and under it by at most 6 (a hillside, not a cliff's foot), the landing walk cell at grade, the ends dry, no tree column within 2 of
 * the lanes; the longest rise wins, then the more treads under the ground, then the line. The first that rockStairGeom passes over the
 * claim's frozen volume is routed; its nodes 8 out from either end.
 */
export function naturalSection(ctx, r, base) {
  const { survey: S, claim } = ctx;
  const st = S.stats(claim.minX, claim.minZ, claim.maxX, claim.maxZ);
  const box = { minX: claim.minX, minY: Math.max(claim.minY ?? -64, st.minGround - 16), minZ: claim.minZ, maxX: claim.maxX, maxY: Math.min(claim.maxY ?? 319, st.maxGround + 1), maxZ: claim.maxZ };
  const vol = r.needVolume(box);
  STATE.set(r, { S, base, written: [], volumes: vol ? [vol] : [] });
  const picks = pickFlights(S, claim);
  r.meta.rockStairsDemo = { variant: 'natural', candidates: picks.length };
  if (!vol) return { nodes: {}, edges: [], input: null, note: `natural: ${picks.length} candidate flight(s) by the survey; the claim's rock asked as a frozen volume (the second plan reads it)` };
  const land = tunnelLand(S, { volumes: [vol], classOfVolume });
  let c = null, tried = 0;
  for (const q of picks) {
    if (tried++ >= 400) break;
    const g = rockStairGeom(land, q.a, q.dir, q.rise, { width: 2 });
    if (g.ok) { c = { ...q, bore: g.bore.filter(Boolean).length }; break; }
  }
  if (!c) return { nodes: {}, edges: [], input: null, note: `natural: none of ${tried} candidate flight(s) passes the rock` };
  const L = flightLength(c.rise), out = 8;
  const at = (i) => { const x = c.a[0] + c.dir[0] * i, z = c.a[2] + c.dir[1] * i; return [x, S.groundAt(x, z) + 1, z]; };
  const nodes = { hill_foot: { at: at(-out), kind: 'junction' }, hill_top: { at: at(L + 1 + out), kind: 'junction' } };
  r.meta.rockStairsDemo = { variant: 'natural', candidates: picks.length, tried, flight: { a: c.a, dir: c.dir, rise: c.rise, bore: c.bore } };
  return { nodes, edges: [edgeOf('hill', 'hill_foot', 'hill_top', 12)], input: { volumes: [vol], written: [] }, note: `natural: a flight of rise ${c.rise} at ${c.a.join(',')} heading ${c.dir.join(',')} (${c.bore} bored tread(s)), the ${tried}th of ${picks.length} candidate(s)` };
}

const DIRS4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
/** The survey's candidate flights (see naturalSection), best first. */
export function pickFlights(S, claim, { margin = 14, riseMin = 6, riseMax = 24 } = {}) {
  const out = [];
  const inside = (x, z) => x >= claim.minX + margin && x <= claim.maxX - margin && z >= claim.minZ + margin && z <= claim.maxZ - margin;
  const near = (x, z, f) => { for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (f(x + dx, z + dz)) return true; return false; };
  for (let z = claim.minZ + margin; z <= claim.maxZ - margin; z++) for (let x = claim.minX + margin; x <= claim.maxX - margin; x++) {
    if (S.waterAt(x, z) || S.treeAt?.(x, z)) continue;
    const y0 = S.groundAt(x, z);
    for (const dir of DIRS4) {
      const [rx, rz] = rightOf(dir), { lo, hi } = latOn(2, dir);
      for (let rise = riseMax; rise >= riseMin; rise--) {
        const P = flightProfile(y0, rise), L = P.L;
        const bx = x + dir[0] * (L + 1), bz = z + dir[1] * (L + 1);
        if (!inside(bx, bz) || !inside(x - dir[0] * 9, z - dir[1] * 9) || !inside(bx + dir[0] * 9, bz + dir[1] * 9)) continue;
        if (S.waterAt(bx, bz) || Math.abs(S.groundAt(bx, bz) - (y0 + rise)) > 1) continue;
        let ok = true, under = 0;
        for (let i = 1; i <= L && ok; i++) for (let v = lo; v <= hi && ok; v++) {
          const cx = x + dir[0] * i + rx * v, cz = z + dir[1] * i + rz * v, g = S.groundAt(cx, cz);
          if (g < P.ys[i] - 1 - ROCK.fill || g > P.ys[i] + 6 || S.waterAt(cx, cz) || near(cx, cz, (qx, qz) => S.treeAt?.(qx, qz) || S.waterAt(qx, qz))) ok = false;
          else if (g > P.ys[i]) under++;
        }
        if (!ok) continue;
        out.push({ a: [x, y0, z], dir, rise, under, key: [-rise, -under, x, z, DIRS4.indexOf(dir)] });
        break;
      }
    }
  }
  out.sort((p, q) => { for (let t = 0; t < p.key.length; t++) if (p.key[t] !== q.key[t]) return p.key[t] - q.key[t]; return 0; });
  return out;
}

/** The flights the route pass found, emitted in `stage` (each written by rockStair; its lining in `liningStage`): the records. */
export function emitDemoRockStairs(r, { stage, liningStage = 'routes' }) {
  const st = STATE.get(r);
  if (!st) return [];
  const out = [];
  const land = tunnelLand(r.ctx.survey, { volumes: st.volumes, base: st.base, written: st.written, classOfVolume });
  for (const e of r.meta.route?.edges ?? []) {
    if (!e.ok) continue;
    (e.segments ?? []).forEach((g, si) => {
      if (g.kind !== 'rock_stair') return;
      const a = e.path[g.from], b = e.path[g.to];
      const v = st.volumes[0];
      const rec = rockStair(r, a, b, { land, width: e.width ?? 2, stage, liningStage, part: 'links_rock_stairs', id: `rock_stair_${e.id}_${si}`.slice(0, 48), movers: e.movers,
        ...(v ? { volume: { sha: v.sha, box: [v.box.minX, v.box.minY, v.box.minZ, v.box.maxX, v.box.maxY, v.box.maxZ] } } : {}) });
      out.push({ edge: e.id, ...rec });
    });
  }
  return out;
}
