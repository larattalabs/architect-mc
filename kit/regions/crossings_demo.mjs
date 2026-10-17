// crossings_demo (6c T3, docs/CONTRACT.md "Phase 6c slice T3" §10): the bridge and tunnel fixture. Bridges and tunnels found by the
// route pass's bridge and tunnel moves (bridge and tunnel edges: exactly one span or bore each) and written by the links stage.
//   flat claim (E-flat): the west half holds the bridges (lib/connectors/crossingsBridges.mjs, T3a: a ravine raised in stage `ground`,
//                  a beam of span 24 with 3 piers and an arch of span 16), the east half the tunnel (lib/connectors/crossingsTunnels.mjs,
//                  T3b: a ridge raised in stage `ground` with a 48-cell bore and a sand band); the raised land reaches the pass
//                  through its `base` (the pass reads the frozen survey, which an earlier op can't change: T1's lesson)
//   river:         S3's pinned river crossed by an arch (T3a)
//   frozen:        S7's rejected site 2026101102 (a frozen river) crossed by an arch with nothing written in the ice (T3a)
//   hill:          the pinned hill site's tunnel (T3b)
// Each half adds its own land to the shared base and returns its route nodes and edges; one route pass routes them all; the bridges are
// emitted in the links stage, then the tunnels. Anchors: entrance and spawn at the first span's near landing; cameras cam_side,
// cam_deck and cam_high beside the longest bridge (cam_portal and cam_bore are T3b's).
import { region } from '../lib/region/program.mjs';
import { bridgeSection, emitDemoBridges } from '../lib/connectors/crossingsBridges.mjs';
import { tunnelSection, emitDemoTunnels } from '../lib/connectors/crossingsTunnels.mjs';

export const id = 'crossings_demo';
export const catalogue = false;
export const passes = ['route'];

export const params = {
  variant: { type: 'enum', options: ['auto', 'flat', 'river', 'frozen', 'hill'], default: 'auto', label: 'Variant' },
  bank: { type: 'int', min: 8, max: 32, default: 16, label: 'Bank height (flat claim)' },
};

export default function crossingsDemo(ctx) {
  const { claim, survey: S, params: P } = ctx;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const st = S.stats(claim.minX, claim.minZ, claim.maxX, claim.maxZ);
  const variant = P.variant === 'auto' ? (st.maxGround - st.minGround <= 2 ? 'flat' : 'river') : P.variant;
  if (variant === 'flat' && (W < 256 || D < 112)) throw new Error(`crossings_demo (flat) needs a claim of at least 256x112 (got ${W}x${D})`);
  const r = region(ctx);
  r.stages(['ground', 'routes', 'links']);
  const base = { minX: claim.minX, minZ: claim.minZ, width: W, depth: D, values: new Int16Array(W * D) };
  const half = claim.minX + 127;
  const rects = variant === 'flat' ? { bridges: [claim.minX, claim.minZ, half, claim.maxZ], tunnels: [half + 1, claim.minZ, claim.maxX, claim.maxZ] }
    : { bridges: [claim.minX, claim.minZ, claim.maxX, claim.maxZ], tunnels: [claim.minX, claim.minZ, claim.maxX, claim.maxZ] };
  const b = bridgeSection(ctx, r, { rect: rects.bridges, variant, base, P });
  const t = tunnelSection(ctx, r, { rect: rects.tunnels, variant, base, P });
  const nodes = { ...b.nodes, ...t.nodes }, edges = [...b.edges, ...t.edges];
  let bridges = [], tunnels = [], routed = 0;
  if (edges.length) {
    const net = r.pass('route', { nodes, edges, stage: 'routes', base, lanterns: false, ...(b.input ? { bridge: b.input } : {}), ...(t.input ? { tunnel: t.input } : {}) });
    routed = net.edges.filter((e) => e.ok).length;
    bridges = emitDemoBridges(r, { stage: 'links' });
    tunnels = emitDemoTunnels(r, { stage: 'links' });
  }
  r.note(`crossings_demo (${variant}): ${[b.note, t.note].filter(Boolean).join('; ')}; ${routed}/${edges.length} edges routed (${bridges.map((q) => `${q.form} ${q.n}`).join(', ') || 'no bridge'}${tunnels.length ? `; ${tunnels.length} tunnel(s)` : ''})`);
  r.meta.crossings = { ...(r.meta.crossings ?? {}), variant };
  finish(r, ctx, bridges, tunnels);
  return r;
}

/** The anchors (entrance and spawn at the first span's or bore's near landing) and the bridge cameras beside the longest bridge. */
function finish(r, ctx, bridges, tunnels) {
  const first = bridges[0] ?? tunnels[0] ?? null;
  if (!first?.from) { const c = ctx.survey.pickCenter(); r.anchor('entrance', [c[0], c[1] + 1, c[2]]); r.anchor('spawn', [c[0], c[1] + 1, c[2]]); }
  else { const [x, y, z] = first.from; r.anchor('entrance', [x, y + 1, z]); r.anchor('spawn', [x, y + 1, z]); }
  if (!bridges.length) return;
  const longest = bridges.reduce((a, q) => (q.n > a.n ? q : a), bridges[0]);
  const mid = longest.from.map((v, i) => (i === 1 ? v : v + Math.floor((longest.to[i] - v) / 2)));
  const side = longest.dir[0] !== 0 ? [0, 1] : [1, 0];
  const c = ctx.claim, cl = ([x, y, z]) => [Math.max(c.minX, Math.min(c.maxX, x)), y, Math.max(c.minZ, Math.min(c.maxZ, z))];
  r.anchor('cam_side', cl([mid[0] + side[0] * 26, mid[1] + 2, mid[2] + side[1] * 26]));
  r.anchor('cam_deck', cl([longest.from[0] - longest.dir[0] * 3, longest.from[1] + 3, longest.from[2] - longest.dir[1] * 3]));
  r.anchor('cam_high', cl([mid[0] - side[0] * 30, mid[1] + 36, mid[2] - side[1] * 30]));
}
