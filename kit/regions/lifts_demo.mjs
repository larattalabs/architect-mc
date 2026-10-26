// lifts_demo (7a LF, docs/CONTRACT.md "Phase 7a slice LF" §9): the lift fixture. Lift edges (exactly one bubble column each, the walks at
// their ends), found by the route pass's lift row (row 9) and written by the links stage, their columns in the fluids stage
// (lib/connectors/liftsDemo.mjs).
//   flat claim (E-flat): two plateaus along the claim's north side, 8 and 48 high, raised in stage `ground` through the shared base; an up
//                        column against each face, the high one with a down column beside it
//   natural:             the pinned site's best face (CW's cliff site, scenarios/sites/cliff_face.json), a lift up it (a down column where
//                        one fits)
// Anchors: entrance and spawn at the first lift's foot, cameras cam_approach (out from the foot, looking at the tower), cam_top (on the
// top, looking down the shaft), cam_side (beside the tower, level with its middle); per lift foot_<edge>, top_<edge> (the walk cells,
// feet), down_<edge> (the down column's top walk cell) for the movers and the ride probe.
import { region } from '../lib/region/program.mjs';
import { emitDemoLifts, flatSection, naturalSection, FLAT } from '../lib/connectors/liftsDemo.mjs';

export const id = 'lifts_demo';
export const catalogue = false;
export const passes = ['route'];

export const params = {
  variant: { type: 'enum', options: ['auto', 'flat', 'natural'], default: 'auto', label: 'Variant' },
  low: { type: 'int', min: 4, max: 16, default: 8, label: 'Low face height (flat claim)' },
  high: { type: 'int', min: 16, max: 64, default: 48, label: 'High face height (flat claim)' },
};

export default function liftsDemo(ctx) {
  const { claim, survey: S, params: P } = ctx;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const st = S.stats(claim.minX, claim.minZ, claim.maxX, claim.maxZ);
  const variant = P.variant === 'auto' ? (st.maxGround - st.minGround <= 2 ? 'flat' : 'natural') : P.variant;
  if (variant === 'flat' && (W < FLAT.W || D < FLAT.D)) throw new Error(`lifts_demo (flat) needs a claim of at least ${FLAT.W}x${FLAT.D} (got ${W}x${D})`);
  const r = region(ctx);
  r.stages(['ground', 'routes', 'links', 'fluids']);
  const base = { minX: claim.minX, minZ: claim.minZ, width: W, depth: D, values: new Int16Array(W * D) };
  const sec = variant === 'flat' ? flatSection(ctx, r, base, P) : naturalSection(ctx, r, base, P);
  let lifts = [], routed = 0;
  if (sec.edges.length) {
    const net = r.pass('route', { nodes: sec.nodes, edges: sec.edges, stage: 'routes', base, lanterns: false });
    routed = net.edges.filter((e) => e.ok).length;
    lifts = emitDemoLifts(r, ctx, r.meta.route?.edges ?? [], { stage: 'links', base: variant === 'flat' ? base : null });
  }
  r.note(`lifts_demo (${variant}): ${sec.note}; ${routed}/${sec.edges.length} edge(s) routed (${lifts.map((q) => `a lift of rise ${q.rec.rise}${q.rec.down ? ' with a down column' : ''}`).join(', ') || 'no lift'})`);
  finish(r, ctx, lifts);
  return r;
}

/** The anchors: entrance and spawn at the first lift's foot; the cameras; each lift's foot, top and down column's top. */
function finish(r, ctx, lifts) {
  const q = lifts[0]?.rec;
  if (!q) { const c = ctx.survey.pickCenter(); r.anchor('entrance', [c[0], c[1] + 1, c[2]]); r.anchor('spawn', [c[0], c[1] + 1, c[2]]); return; }
  const [x, y, z] = q.foot;
  r.anchor('entrance', [x, y + 1, z]);
  r.anchor('spawn', [x, y + 1, z]);
  const c = ctx.claim, cl = ([ax, ay, az]) => [Math.max(c.minX, Math.min(c.maxX, ax)), ay, Math.max(c.minZ, Math.min(c.maxZ, az))];
  const [dx, dz] = q.dir, [rx, rz] = [-dz, dx];
  r.anchor('cam_approach', cl([x - dx * 12 + rx * 6, y + 6, z - dz * 12 + rz * 6]));
  r.anchor('cam_top', cl([q.top[0] + dx * 3, q.top[1] + 3, q.top[2] + dz * 3]));
  r.anchor('cam_side', cl([x + dx * 2 + rx * 12, y + Math.floor(q.rise / 2) + 2, z + dz * 2 + rz * 12]));
  for (const { edge, rec } of lifts) {
    const tag = edge.replace(/^lift_/, '');
    r.anchor(`foot_${tag}`, [rec.foot[0], rec.foot[1] + 1, rec.foot[2]]);
    r.anchor(`top_${tag}`, [rec.top[0], rec.top[1] + 1, rec.top[2]]);
    if (rec.downTop) { r.anchor(`down_${tag}`, [rec.downTop[0], rec.downTop[1] + 1, rec.downTop[2]]); r.anchor(`downfoot_${tag}`, [rec.downFoot[0], rec.downFoot[1] + 1, rec.downFoot[2]]); }
  }
}
