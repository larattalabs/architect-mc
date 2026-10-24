// climbs_demo (7a CL, docs/CONTRACT.md "Phase 7a slice CL" §10): the climbs' fixture. Stairs, switchbacks and ladders found by the route
// pass under their edge profiles (lib/region/passes/moves/profiles.mjs) and fitted in the links stage (lib/connectors/climbGeom.mjs).
//   flat claim (E-flat, at least 224x160): the west part a ridge rising 1 in 2 northwards to a plateau `ridge` high, climbed by a stair
//                 (2 wide, villagers) and a switchback (2 wide, villagers); the east part a mesa `cliff` high with sheer faces on every
//                 side, climbed only by a ladder (player-only, a rest landing every `rest`). Both raised in stage `ground` and routed
//                 through the pass's `base` (the pass reads the frozen survey, which an earlier op can't change: T1's lesson). A bed on
//                 the ridge's plateau (reached by the stair) and one on the mesa (reached only by the ladder): the behavioural villager
//                 test's targets (anchors bed_stair, bed_ladder).
//   natural:      S3's pinned claim (route_demo's): a stair and a switchback from the valley floor to the shoulder (villagers).
// Anchors: entrance and spawn at the stair's foot; foot_stair, top_stair, foot_switch, top_switch, foot_ladder, top_ladder (feet cells);
// bed_stair, bed_ladder (flat); cameras cam_stair, cam_switch, cam_ladder.
import { region } from '../lib/region/program.mjs';
import { emitClimbs, climbLand } from '../lib/connectors/climbGeom.mjs';

export const id = 'climbs_demo';
export const catalogue = false;
export const passes = ['route'];

const XZ = { type: 'int', min: -30000000, max: 30000000, default: 0 };
export const params = {
  variant: { type: 'enum', options: ['auto', 'flat', 'natural'], default: 'auto', label: 'Variant' },
  ridge: { type: 'int', min: 8, max: 32, default: 20, label: 'Ridge height (flat)' },
  cliff: { type: 'int', min: 4, max: 48, default: 36, label: 'Mesa height (flat)' },
  rest: { type: 'int', min: 8, max: 24, default: 24, label: 'Rungs between rest landings' },
  // the natural sites (feet cells; all 0: route_demo's gate and chapel on S3's pinned claim)
  footX: { ...XZ, label: 'Foot x' }, footY: { ...XZ, label: 'Foot y' }, footZ: { ...XZ, label: 'Foot z' },
  topX: { ...XZ, label: 'Top x' }, topY: { ...XZ, label: 'Top y' }, topZ: { ...XZ, label: 'Top z' },
};

/** S3's pinned claim (route_demo's): the valley floor by the gate and the shoulder by the chapel (feet cells). */
export const S3_SITES = Object.freeze({ foot: [3638, 85, -895], top: [3674, 125, -957], foot2: [3632, 85, -890], top2: [3668, 125, -952] });

export default function climbsDemo(ctx) {
  const { claim, survey: S, params: P } = ctx;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const st = S.stats(claim.minX, claim.minZ, claim.maxX, claim.maxZ);
  const variant = P.variant === 'auto' ? (st.maxGround - st.minGround <= 2 ? 'flat' : 'natural') : P.variant;
  if (variant === 'flat' && (W < 224 || D < 160)) throw new Error(`climbs_demo (flat) needs a claim of at least 224x160 (got ${W}x${D})`);
  const r = region(ctx);
  r.stages(['ground', 'routes', 'links', 'props']);
  const base = { minX: claim.minX, minZ: claim.minZ, width: W, depth: D, values: new Int16Array(W * D) };
  const baseAt = (x, z) => (x < claim.minX || z < claim.minZ || x > claim.maxX || z > claim.maxZ ? 0 : base.values[(x - claim.minX) + (z - claim.minZ) * W]);
  const nodes = {}, edges = [], opts = {}, beds = [];
  if (variant === 'flat') {
    const g0 = S.groundAt(claim.minX + 8, claim.minZ + 8);
    // ---- the ridge (west): rising 1 in 2 northwards from zS to the plateau, the plateau to zN; x0r..x1r
    const H = P.ridge, x0r = claim.minX + 16, x1r = claim.minX + 111, zS = claim.maxZ - 24, zTop = zS - 2 * H, zN = zTop - 24;
    const ridgeAt = (x, z) => (x < x0r || x > x1r || z < zN || z > zS ? 0 : Math.min(H, Math.floor((zS - z) / 2)));
    // ---- the mesa (east): a block `cliff` high, its faces sheer
    const C = P.cliff, mx0 = claim.minX + 160, mx1 = mx0 + 23, mz0 = claim.minZ + 60, mz1 = mz0 + 23;
    const mesaAt = (x, z) => (x >= mx0 && x <= mx1 && z >= mz0 && z <= mz1 ? C : 0);
    const raised = r.part('land', { stage: 'ground' });
    const mats = [r.material('surface', 'land'), r.material('subsurface', 'land'), r.material('rock', 'land')];
    const cols = [];
    for (let z = claim.minZ; z <= claim.maxZ; z++) for (let x = claim.minX; x <= claim.maxX; x++) {
      const h = Math.max(ridgeAt(x, z), mesaAt(x, z));
      if (h <= 0) continue;
      base.values[(x - claim.minX) + (z - claim.minZ) * W] = h;
      const g = S.groundAt(x, z);
      if (h > 4) cols.push(x, z, g + 1, g + h - 4, 2);
      cols.push(x, z, Math.max(g + 1, g + h - 3), g + h - 1, 1, x, z, g + h, g + h, 0);
    }
    raised._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: mats, cond: 0, walk: false });
    (r.meta.parts.land ??= {}).kind = 'add';
    const top = g0 + H + 1, foot = g0 + 1;
    // the stair and the switchback: from the ridge's foot (south) up to its plateau
    const xs = x0r + 24, xw = x0r + 64;
    nodes.foot_stair = { at: [xs, foot, zS + 12], kind: 'junction' };
    nodes.top_stair = { at: [xs, top, zTop - 8], kind: 'junction' };
    nodes.foot_switch = { at: [xw, foot, zS + 12], kind: 'junction' };
    nodes.top_switch = { at: [xw, top, zTop - 8], kind: 'junction' };
    edges.push({ id: 'stair', from: 'foot_stair', to: 'top_stair', width: 2, movers: ['player', 'villager'], profile: 'stair', type: 'stair' });
    edges.push({ id: 'switch', from: 'foot_switch', to: 'top_switch', width: 2, movers: ['player', 'villager'], profile: 'switchback', type: 'switchback' });
    // the ladder: from the mesa's west foot to its top
    nodes.foot_ladder = { at: [mx0 - 12, foot, mz0 + 12], kind: 'junction' };
    nodes.top_ladder = { at: [mx0 + 10, g0 + C + 1, mz0 + 12], kind: 'junction' };
    edges.push({ id: 'ladder', from: 'foot_ladder', to: 'top_ladder', width: 1, movers: ['player'], profile: 'ladder', type: 'ladder', ladders: true });
    opts.stair = { kind: 'stair' };
    opts.switch = { kind: 'switchback' };
    opts.ladder = { kind: 'ladder', rest: P.rest };
    // the beds: on the plateau beside the stair's top, and on the mesa beside the ladder's top
    beds.push({ name: 'bed_stair', at: [xs + 6, top, zTop - 14] }, { name: 'bed_ladder', at: [mx0 + 16, g0 + C + 1, mz0 + 16] });
  } else {
    const foot = P.footX || P.footY || P.footZ ? [P.footX, P.footY, P.footZ] : S3_SITES.foot;
    const topc = P.topX || P.topY || P.topZ ? [P.topX, P.topY, P.topZ] : S3_SITES.top;
    nodes.foot_stair = { at: foot, kind: 'junction' };
    nodes.top_stair = { at: topc, kind: 'junction' };
    nodes.foot_switch = { at: S3_SITES.foot2, kind: 'junction' };
    nodes.top_switch = { at: S3_SITES.top2, kind: 'junction' };
    edges.push({ id: 'stair', from: 'foot_stair', to: 'top_stair', width: 2, movers: ['player', 'villager'], profile: 'stair', type: 'stair' });
    edges.push({ id: 'switch', from: 'foot_switch', to: 'top_switch', width: 2, movers: ['player', 'villager'], profile: 'switchback', type: 'switchback' });
    opts.stair = { kind: 'stair' };
    opts.switch = { kind: 'switchback' };
  }
  const net = r.pass('route', { nodes, edges, stage: 'routes', base, lanterns: false, maxGrade: 0.25 });
  const routed = (r.meta.route?.edges ?? []).filter((e) => e.ok);
  const land = climbLand(S, { baseAt });
  const fits = emitClimbs(r, routed, { opts, stage: 'links', part: 'links_climbs', land, taken: () => false });
  // the beds (the behavioural villager test's targets): a red bed, foot and head, facing north
  if (beds.length) {
    const p = r.part('beds', { stage: 'props' });
    const cols = [];
    for (const b of beds) { const [x, y, z] = b.at; cols.push(x, z, y, y, 0, x, z - 1, y, y, 1); r.anchor(b.name, [x, y, z]); }
    p.columns({ abs: 0 }, { abs: 0 }, cols, ['minecraft:red_bed[facing=north,occupied=false,part=foot]', 'minecraft:red_bed[facing=north,occupied=false,part=head]'], { cond: 3 });
  }
  for (const [name, n] of Object.entries(nodes)) r.anchor(name, [...n.at]);
  const f = nodes.foot_stair.at;
  r.anchor('entrance', [...f]);
  r.anchor('spawn', [...f]);
  for (const e of routed) {
    const mid = e.path[e.path.length >> 1];
    r.anchor(`cam_${e.id}`, [Math.max(claim.minX, Math.min(claim.maxX, mid[0] + 16)), mid[1] + 10, Math.max(claim.minZ, Math.min(claim.maxZ, mid[2] + 6))]);
  }
  r.meta.climbsDemo = { variant, routed: routed.map((e) => e.id), failed: net.edges.filter((e) => !e.ok).map((e) => e.id), fits: fits.map((q) => ({ edge: q.edge, flights: q.meta.flights, hairpins: q.meta.hairpins, ladders: q.meta.ladders.length, rails: q.meta.rails, lamps: q.meta.lamps })) };
  r.note(`climbs_demo (${variant}): ${routed.length}/${edges.length} edges routed; ${fits.map((q) => `${q.edge}: ${q.meta.flights} flight(s), ${q.meta.hairpins} hairpin(s), ${q.meta.ladders.length} ladder(s) (${q.meta.ladders.map((l) => `${l.rungs} rungs, ${l.landings} landing(s)`).join('; ')})`).join('; ')}`);
  return r;
}
