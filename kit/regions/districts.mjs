// districts (6c D1, docs/CONTRACT.md "Phase 6c slice D" §2-§3): a settlement of districts laid out by the `districts` pass on survey
// candidates: each district a V street layout (its lots, its street and its shared space) in a rect at its level band, the districts
// joined by T2 routes (a minimum spanning tree by route cost, plus loops up to `loopiness` of the tree's cost). With Regions.plan's
// `beside` (a standing region, ctx.beside) one routed join meets the standing region's nearest street end inside this claim's seam:
// this region writes the join, so removing it removes the join (S-D-2).
//   ground: pads, shared spaces, verges, lanes;  street: the streets;  routes: the routes and the join;  lots: the lots;  props.
// Params: spec ({districts: [{id, size: [w, d], lots: n | [lot], levelBand, prefer, near, shared, squareSize, label}]}), loopiness
// (percent), gradePct, lamps, routeLamp (bible: the bible's lamp; soul: soul lanterns, under vanilla's melt, for snowy claims).
import { region } from '../lib/region/program.mjs';

export const id = 'districts';
export const description = 'Districts on survey candidates, joined by routes (6c D1); beside a standing region with one join.';
/** Not in Regions.design's pick (a paid re-run of the pick, deferred, as V). */
export const catalogue = false;
export const passes = ['districts', 'route'];
export const roles = { path: 'minecraft:gravel', foundation: 'minecraft:stone_bricks', light: 'minecraft:lantern' };

export const params = {
  spec: { type: 'json', default: null, maxChars: 32768, label: 'Districts' },
  loopiness: { type: 'int', min: 0, max: 100, default: 15, label: 'Loopiness (%)' },
  gradePct: { type: 'int', min: 5, max: 100, default: 25, label: 'Grade limit (%)' },
  lamps: { type: 'bool', default: true, label: 'Lamps' },
  routeLamp: { type: 'enum', options: ['bible', 'soul'], default: 'bible', label: 'Route lamps' },
};

export default function (ctx) {
  return build(ctx, ctx.params.spec?.districts);
}

/** The program over a districts list (districts_demo passes its own). */
export function build(ctx, districts) {
  const P = ctx.params;
  if (!Array.isArray(districts) || !districts.length) throw new Error('districts: params.spec.districts is empty');
  const r = region(ctx);
  r.stages(['ground', 'street', 'routes', 'lots', 'props']);
  const out = r.pass('districts', { districts, loopiness: P.loopiness / 100, maxGrade: P.gradePct / 100, lamps: P.lamps, ...(P.routeLamp === 'soul' ? { lampFixture: 'minecraft:soul_lantern' } : {}) });
  // cameras over the districts' bells
  const c = ctx.claim;
  const bells = Object.keys(out.data.rects).map((d) => r.anchors[`bell_${d}`.slice(0, 32)]).filter(Boolean);
  const mx = Math.floor(bells.reduce((s, b) => s + b[0], 0) / bells.length), mz = Math.floor(bells.reduce((s, b) => s + b[2], 0) / bells.length);
  const top = bells.reduce((s, b) => Math.max(s, b[1]), -64);
  const cam = (name, x, z, up) => r.anchor(name, [Math.max(c.minX, Math.min(c.maxX, x)), Math.min(c.maxY - 1, top + up), Math.max(c.minZ, Math.min(c.maxZ, z))]);
  cam('cam_high', mx + 8, mz + 8, 80); cam('cam_n', mx, mz - 70, 30); cam('cam_s', mx, mz + 70, 30); cam('cam_e', mx + 70, mz, 30); cam('cam_w', mx - 70, mz, 30);
  cam('cam_ground', mx + 12, mz + 12, 3);
  return r;
}
