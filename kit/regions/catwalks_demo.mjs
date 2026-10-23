// catwalks_demo (7a CW, docs/CONTRACT.md "Phase 7a slice CW" §8): the catwalk fixture. One catwalk edge (exactly one run along a face,
// 2 wide, villagers), found by the route pass's catwalk row (row 10) and written by the links stage (lib/connectors/catwalksDemo.mjs).
//   flat claim (E-flat): a cliff 20 high along the claim's north side and two shelves 8 high either side of a 16-wide bay, raised in
//                        stage `ground` through the shared base; the catwalk runs along the face at the shelves' level
//   natural:             the pinned cliff site's best straight run along a face (scenarios/sites/cliff_face.json), its ends on pads
// Anchors: entrance and spawn at the run's start, cameras cam_below (under the run, looking up at it), cam_deck (on the deck at its
// start) and cam_side (out over the drop, level with the deck).
import { region } from '../lib/region/program.mjs';
import { emitDemoCatwalks, flatSection, naturalSection, FLAT } from '../lib/connectors/catwalksDemo.mjs';

export const id = 'catwalks_demo';
export const catalogue = false;
export const passes = ['route'];

export const params = {
  variant: { type: 'enum', options: ['auto', 'flat', 'natural'], default: 'auto', label: 'Variant' },
  cliff: { type: 'int', min: 12, max: 32, default: 20, label: 'Cliff height (flat claim)' },
  shelf: { type: 'int', min: 4, max: 12, default: 8, label: 'Shelf height (flat claim)' },
};

export default function catwalksDemo(ctx) {
  const { claim, survey: S, params: P } = ctx;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const st = S.stats(claim.minX, claim.minZ, claim.maxX, claim.maxZ);
  const variant = P.variant === 'auto' ? (st.maxGround - st.minGround <= 2 ? 'flat' : 'natural') : P.variant;
  if (variant === 'flat' && (W < FLAT.W || D < FLAT.D)) throw new Error(`catwalks_demo (flat) needs a claim of at least ${FLAT.W}x${FLAT.D} (got ${W}x${D})`);
  const r = region(ctx);
  r.stages(['ground', 'routes', 'links']);
  const base = { minX: claim.minX, minZ: claim.minZ, width: W, depth: D, values: new Int16Array(W * D) };
  const sec = variant === 'flat' ? flatSection(ctx, r, base, P) : naturalSection(ctx, r, base, P);
  let runs = [], routed = 0;
  if (sec.edges.length) {
    const net = r.pass('route', { nodes: sec.nodes, edges: sec.edges, stage: 'routes', base, lanterns: false });
    routed = net.edges.filter((e) => e.ok).length;
    runs = emitDemoCatwalks(r, { stage: 'links' });
  }
  r.note(`catwalks_demo (${variant}): ${sec.note}; ${routed}/${sec.edges.length} edge(s) routed (${runs.map((q) => `a catwalk of ${q.n}, the face ${q.side}, ${q.brackets} bracket(s)`).join(', ') || 'no catwalk'})`);
  finish(r, ctx, runs);
  return r;
}

/** The anchors: entrance and spawn at the first run's start; the cameras beside it. */
function finish(r, ctx, runs) {
  const q = runs[0];
  if (!q) { const c = ctx.survey.pickCenter(); r.anchor('entrance', [c[0], c[1] + 1, c[2]]); r.anchor('spawn', [c[0], c[1] + 1, c[2]]); return; }
  const [x, y, z] = q.from;
  r.anchor('entrance', [x, y + 1, z]);
  r.anchor('spawn', [x, y + 1, z]);
  const c = ctx.claim, cl = ([ax, ay, az]) => [Math.max(c.minX, Math.min(c.maxX, ax)), ay, Math.max(c.minZ, Math.min(c.maxZ, az))];
  const [dx, dz] = q.dir, half = Math.floor(q.n / 2), out = q.side === 'right' ? -1 : 1; // (the open side: away from the face)
  const [rx, rz] = [-dz, dx];
  const mid = [x + dx * half, y, z + dz * half];
  r.anchor('cam_below', cl([mid[0] + rx * out * 8, y - 6, mid[2] + rz * out * 8]));
  r.anchor('cam_deck', cl([x - dx * 2, y + 2, z - dz * 2]));
  r.anchor('cam_side', cl([mid[0] + rx * out * 16, y + 3, mid[2] + rz * out * 16]));
}
