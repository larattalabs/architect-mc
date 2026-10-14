// links_demo (7a K1b, docs/CONTRACT.md "Phase 7a slice K1" §10): the rope bridge fixture. Rope bridges found by the route pass's
// rope move (rope_bridge edges: exactly one span each, no approach walk) and written by the links stage (lib/connectors/ropeGeom.mjs).
//   flat claim:    a ravine raised in stage `ground` (two banks 16 high, the gap between them their floor: a flat world can't be carved
//                  below its bedrock), three sections of it 8, 24 and 40 wide, so the bridges span 8, 24 and 40 deck cells; routed
//                  through the pass's `base` (the pass reads the frozen survey, which an earlier op can't change: T1's lesson)
//   natural claim: rift_city's rift (its own program builds the region) and up to three bridges across it from lip to lip, where the
//                  lips stand level enough (the rise at most n / 8) and clear of the template's lots and ways, each landing on a stone
//                  footing (the pinned rift site is desert sand); the rift's carved ground reaches the pass through
//                  lib/connectors/templateLand.mjs
// Every bridge is 2 wide on a slab deck (a villager edge), with fence rails, posts in the frame role, chains and W's lamps.
// Anchors: entrance and spawn on the first bridge's near lip; cameras cam_rope (beside the longest span) and cam_high.
import { region } from '../lib/region/program.mjs';
import { emitRouteRopes, maxRiseOf } from '../lib/connectors/ropeGeom.mjs';
import { riftLand } from '../lib/connectors/templateLand.mjs';
import riftCity, { params as riftParams } from './rift_city.mjs';

export const id = 'links_demo';
export const catalogue = false;
export const passes = ['route'];

export const params = {
  bank: { type: 'int', min: 8, max: 32, default: 16, label: 'Bank height (flat claim)' },
  bridges: { type: 'int', min: 1, max: 3, default: 3, label: 'Bridges (natural claim)' },
  chains: { type: 'bool', default: true, label: 'Chains (rope decoration)' },
};

/** The flat variant's sections: the gap's width (= the span in deck cells) and the bank's length along the ravine. */
export const SECTIONS = Object.freeze([8, 24, 40]);
const LEN = 24; // each section's length along the ravine (x)
const STEP = 48; // section centres apart (x): more than twice a span's approach, so no bridge can land in the next section

export default function linksDemo(ctx) {
  const { claim, survey: S, params: P } = ctx;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const st = S.stats(claim.minX, claim.minZ, claim.maxX, claim.maxZ);
  const flat = st.maxGround - st.minGround <= 2;
  return flat ? flatVariant(ctx, P, W, D) : riftVariant(ctx, P);
}

function flatVariant(ctx, P, W, D) {
  const { claim, survey: S } = ctx;
  if (W < 160 || D < 80) throw new Error(`links_demo (flat) needs a claim of at least 160x80 (got ${W}x${D})`);
  const r = region(ctx);
  r.stages(['ground', 'routes', 'links']);
  const cz = claim.minZ + (D >> 1), x0 = claim.minX + 32;
  const H = P.bank;
  // the banks: each section's two blocks of land, LEN long, 16 deep, raised H; the gap between them is the section's width
  const banks = [];
  SECTIONS.forEach((n, s) => {
    const xc = x0 + s * STEP, zn = cz - (n >> 1) - 1, zs = zn + n + 1; // the lips: the north bank's last row, the south bank's first
    banks.push({ s, n, xc, rects: [[xc - (LEN >> 1), zn - 15, xc + (LEN >> 1) - 1, zn], [xc - (LEN >> 1), zs, xc + (LEN >> 1) - 1, zs + 15]], zn, zs });
  });
  const values = new Int16Array(W * D);
  const bank = r.part('banks', { stage: 'ground' });
  const mats = [r.material('surface', 'bank'), r.material('subsurface', 'bank'), r.material('rock', 'bank')];
  const cols = [];
  for (const b of banks) for (const [ax, az, bx, bz] of b.rects) for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) {
    values[(x - claim.minX) + (z - claim.minZ) * W] = H;
    const g = S.groundAt(x, z);
    cols.push(x, z, g + 1, g + H - 4, 2, x, z, g + H - 3, g + H - 1, 1, x, z, g + H, g + H, 0);
  }
  bank._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: mats, cond: 0, walk: false });
  (r.meta.parts.banks ??= {}).kind = 'add';
  // a fence round each bank's top (the drop is H) but where the bridge lands (its deck's columns), a lantern on every 6th post
  const fence = r.part('bank_rails', { stage: 'ground' });
  const fcols = [], fmats = [r.material('rail', 'bank rail'), 'minecraft:lantern[hanging=false,waterlogged=false]'];
  for (const b of banks) b.rects.forEach(([ax, az, bx, bz], side) => {
    const lip = side === 0 ? bz : az;
    let k = 0;
    const post = (x, z) => {
      if (z === lip && x >= b.xc - 3 && x <= b.xc) return; // the landing (xc - 2, xc - 1: a southward deck's right is west) and its posts
      const y = S.groundAt(x, z) + H + 1;
      fcols.push(x, z, y, y, 0);
      if (k++ % 6 === 0) fcols.push(x, z, y + 1, y + 1, 1);
    };
    for (let x = ax; x <= bx; x++) { post(x, az); post(x, bz); }
    for (let z = az + 1; z < bz; z++) { post(ax, z); post(bx, z); }
  });
  fence._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: fcols, materials: fmats, cond: 0, walk: false });
  const base = { minX: claim.minX, minZ: claim.minZ, width: W, depth: D, values };
  // the bridges: a rope_bridge edge from each section's north lip to its south lip (no approach walk: the span is the gap)
  const nodes = {}, edges = [];
  for (const b of banks) {
    const xm = b.xc - 1;
    nodes[`n${b.s}`] = { at: [xm, S.groundAt(xm, b.zn) + H + 1, b.zn], kind: 'junction' };
    nodes[`s${b.s}`] = { at: [xm, S.groundAt(xm, b.zs) + H + 1, b.zs], kind: 'junction' };
    edges.push({ id: `span_${b.n}`, from: `n${b.s}`, to: `s${b.s}`, width: 2, movers: ['player', 'villager'], spans: ['rope'], spanOnce: true, approach: 0 });
  }
  const net = r.pass('route', { nodes, edges, stage: 'routes', base, lanterns: false });
  const ropes = emitRouteRopes(r, { stage: 'links', part: 'links', prefix: 'rope_', ...(P.chains ? {} : { style: { rope: null } }) });
  finish(r, ctx, ropes, `links_demo (flat): banks ${H} high; ${net.edges.filter((e) => e.ok).length}/${edges.length} bridges routed (${ropes.map((q) => q.n).join(', ')} deck cells)`);
  r.meta.links = { variant: 'flat', bank: H, sections: banks.map((b) => ({ n: b.n, x: b.xc - 1, zn: b.zn, zs: b.zs })) };
  return r;
}

function riftVariant(ctx, P) {
  const { claim, survey: S } = ctx;
  const rp = Object.fromEntries(Object.entries(riftParams).map(([k, d]) => [k, d.default]));
  const sub = Object.create(ctx, { params: { value: Object.freeze(rp), enumerable: true } });
  const r = riftCity(sub);
  const land = riftLand(claim, S, rp);
  if (!land) throw new Error('links_demo (natural): rift_city has no rift on this claim');
  const { cz, half, x0, x1 } = land.layout;
  const zn = cz - half - 4, zs = cz + half + 4, n = zs - zn - 1; // the lips 18 from the centre line (the warp carves up to 17)
  // the template's lots (with aprons) and ways are obstacles; a bridge needs its deck, rails and posts clear (a southward deck's
  // right-hand side is west: x - 2 .. x + 1)
  const hard = [...r.lots.map((l) => [l.box.minX - 1, l.box.minZ - 1, l.box.maxX + 1, l.box.maxZ + 1]), ...r.paths.filter((q) => q.box).map((q) => [q.box.minX, q.box.minZ, q.box.maxX, q.box.maxZ])];
  const clear = (x) => !hard.some((h) => x + 1 >= h[0] && x - 2 <= h[2] && zs >= h[1] && zn <= h[3]);
  const picks = [];
  for (let x = x0; x <= x1 && picks.length < P.bridges; x++) {
    if (!clear(x) || picks.some((p) => Math.abs(p - x) < 12)) continue;
    if (Math.abs(S.groundAt(x, zs) - S.groundAt(x, zn)) > maxRiseOf(n) || Math.abs(S.groundAt(x - 1, zs) - S.groundAt(x - 1, zn)) > maxRiseOf(n)) continue;
    picks.push(x);
  }
  // stone footings at each landing and its posts (the lip's top and the 3 cells under it, x - 2 .. x + 1): the pinned rift site is
  // desert, whose sand is no site-solid (§3: a full block the plan writes that M3 grounds is), so the posts stand on the plan's own
  // footing (and its top too: a sand top left over a rewritten column fell in the realised world)
  const foot = r.part('footings', { stage: 'ground' });
  const fcols = [];
  for (const x of picks) for (const z of [zn, zs]) for (let xx = x - 2; xx <= x + 1; xx++) { const g = S.groundAt(xx, z); fcols.push(xx, z, g - 3, g, 0); }
  if (fcols.length) { foot.columns({ abs: 0 }, { abs: 0 }, fcols, ['foundation']); (r.meta.parts.footings ??= {}).kind = 'add'; }
  const nodes = {}, edges = [];
  picks.forEach((x, i) => {
    nodes[`n${i}`] = { at: [x, S.groundAt(x, zn) + 1, zn], kind: 'junction' };
    nodes[`s${i}`] = { at: [x, S.groundAt(x, zs) + 1, zs], kind: 'junction' };
    edges.push({ id: `span_${i + 1}`, from: `n${i}`, to: `s${i}`, width: 2, movers: ['player', 'villager'], spans: ['rope'], spanOnce: true, approach: 0 });
  });
  let routed = 0, ropes = [];
  if (edges.length) {
    const net = r.pass('route', { nodes, edges, stage: 'ways', base: land.base, hard: r.paths.filter((q) => q.box).map((q) => [q.box.minX, q.box.minZ, q.box.maxX, q.box.maxZ]), lanterns: false });
    routed = net.edges.filter((e) => e.ok).length;
    ropes = emitRouteRopes(r, { stage: 'lots', part: 'links', prefix: 'rope_', ...(P.chains ? {} : { style: { rope: null } }) });
  }
  finish(r, ctx, ropes, `links_demo (natural): rift_city's rift, ${picks.length} level lip pair(s) at x ${picks.join(', ') || '-'}; ${routed}/${edges.length} bridges routed`, false);
  r.meta.links = { variant: 'rift', lips: [zn, zs], picks };
  return r;
}

/** The anchors (flat: entrance and spawn on the first bridge's near lip) and the cameras beside the longest span. */
function finish(r, ctx, ropes, note, anchors = true) {
  r.note(note);
  if (!ropes.length) { if (anchors) { const c = ctx.survey.pickCenter(); r.anchor('entrance', [c[0], c[1] + 1, c[2]]); r.anchor('spawn', [c[0], c[1] + 1, c[2]]); } return; }
  const first = ropes[0], longest = ropes.reduce((a, q) => (q.n > a.n ? q : a), ropes[0]);
  if (anchors) {
    const [x, y, z] = first.from;
    r.anchor('entrance', [x, y + 1, z]);
    r.anchor('spawn', [x, y + 1, z]);
  }
  const mid = longest.from.map((v, i) => (i === 1 ? v : v + Math.floor(((longest.to[i] - v) * 1) / 2)));
  const side = longest.dir[0] !== 0 ? [0, 1] : [1, 0];
  r.anchor('cam_rope', [mid[0] + side[0] * 22, mid[1] + 6, mid[2] + side[1] * 22]);
  r.anchor('cam_deck', [longest.from[0] + 1, longest.from[1] + 3, longest.from[2] - longest.dir[1] * 3 - longest.dir[0] * 3]);
  r.anchor('cam_high', [mid[0] - side[0] * 30, mid[1] + 40, mid[2] - side[1] * 30]);
}
