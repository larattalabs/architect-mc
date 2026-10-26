// rockstairs_demo (7a RK, docs/CONTRACT.md "Phase 7a slice RK" §8, N-RK-1): the rock stair fixture. Rock stair edges (exactly one flight
// each, the walks at their ends), found by the route pass's rock stair row (row 11) and written by the links stage
// (lib/connectors/rockStairsDemo.mjs).
//   flat claim (E-flat): two hills raised in stage `ground` through the shared base: a ridge with a cliff (a flight flush on its slope,
//                        bored under the cliff, cut near the top; a sand band in the cliff lined) and a slope terraced 3 over a flight
//                        (carved the whole way, walls lined, parapets on both lips); their corridor one frozen volume (two-plan flow)
//   natural:             the pinned hill (scenarios/sites/tunnel_hill.json): the claim's best straight flight, its rock read from the
//                        claim's frozen volume
// Anchors: entrance and spawn at the first flight's foot; cameras cam_foot (below the foot, looking up the flight), cam_mid (in the
// flight, looking up) and cam_top (over the top, looking down).
import { region } from '../lib/region/program.mjs';
import { emitDemoRockStairs, flatSection, naturalSection, FLAT } from '../lib/connectors/rockStairsDemo.mjs';

export const id = 'rockstairs_demo';
export const catalogue = false;
export const passes = ['route'];

export const params = {
  variant: { type: 'enum', options: ['auto', 'flat', 'natural'], default: 'auto', label: 'Variant' },
};

export default function rockStairsDemo(ctx) {
  const { claim, survey: S, params: P } = ctx;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const st = S.stats(claim.minX, claim.minZ, claim.maxX, claim.maxZ);
  const variant = P.variant === 'auto' ? (st.maxGround - st.minGround <= 2 ? 'flat' : 'natural') : P.variant;
  if (variant === 'flat' && (W < FLAT.W || D < FLAT.D)) throw new Error(`rockstairs_demo (flat) needs a claim of at least ${FLAT.W}x${FLAT.D} (got ${W}x${D})`);
  const r = region(ctx);
  r.stages(['ground', 'routes', 'links']);
  const base = { minX: claim.minX, minZ: claim.minZ, width: W, depth: D, values: new Int16Array(W * D) };
  const sec = variant === 'flat' ? flatSection(ctx, r, base) : naturalSection(ctx, r, base);
  let flights = [], routed = 0;
  if (sec.edges.length) {
    const net = r.pass('route', { nodes: sec.nodes, edges: sec.edges, stage: 'routes', base, lanterns: false, ...(sec.input ? { rockStair: sec.input } : {}) });
    routed = net.edges.filter((e) => e.ok).length;
    flights = emitDemoRockStairs(r, { stage: 'links' });
  }
  r.note(`rockstairs_demo (${variant}): ${sec.note}; ${routed}/${sec.edges.length} edge(s) routed (${flights.map((q) => `a flight of ${q.steps} steps, ${q.landings} landing(s), ${q.bore.filter(Boolean).length} bored`).join(', ') || 'no flight'})`);
  finish(r, ctx, flights);
  return r;
}

/** The anchors: entrance and spawn at the first flight's foot; the cameras along it. */
function finish(r, ctx, flights) {
  const q = flights[0];
  if (!q) { const c = ctx.survey.pickCenter(); r.anchor('entrance', [c[0], c[1] + 1, c[2]]); r.anchor('spawn', [c[0], c[1] + 1, c[2]]); return; }
  const up = q.rise >= 0;
  const foot = up ? q.from : q.to, top = up ? q.to : q.from, [dx, dz] = up ? q.dir : [-q.dir[0], -q.dir[1]];
  r.anchor('entrance', [foot[0], foot[1] + 1, foot[2]]);
  r.anchor('spawn', [foot[0], foot[1] + 1, foot[2]]);
  const c = ctx.claim, cl = ([ax, ay, az]) => [Math.max(c.minX, Math.min(c.maxX, ax)), ay, Math.max(c.minZ, Math.min(c.maxZ, az))];
  r.anchor('cam_foot', cl([foot[0] - dx * 8, foot[1] + 3, foot[2] - dz * 8]));
  const mid = Math.floor(q.length / 2);
  r.anchor('cam_mid', cl([foot[0] + dx * mid, foot[1] + Math.floor(Math.abs(q.rise) / 2) + 2, foot[2] + dz * mid]));
  r.anchor('cam_top', cl([top[0] + dx * 6, top[1] + 5, top[2] + dz * 6]));
}
