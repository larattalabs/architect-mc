// (8c RV) lift_demo: a test-only region (wm_demo's pattern) for the planner's lift (the 8c contract §2.2): two water sources a cell apart
// in a stone trench on the ground, the cell between them an outlet: the water model converts it (2 sources beside, the ground under), so
// r.fluidBody lifts it into the body's written sources (op `converted`). params.lift false: not lifted (M25:convert, lint W6).
import { region } from '../../../lib/region/program.mjs';

export const id = 'lift_demo';
export const catalogue = false;
export const params = { lift: { type: 'bool', default: true } };

export default function liftDemo(ctx) {
  const { claim, survey } = ctx;
  const cx = claim.minX + ((claim.maxX - claim.minX + 1) >> 1), cz = claim.minZ + ((claim.maxZ - claim.minZ + 1) >> 1);
  const r = region(ctx);
  r.stages(['ground', 'fluids']);
  const g = survey.groundAt(cx, cz);
  r.anchor('entrance', [cx, g + 1, cz - 12]);
  r.anchor('spawn', [cx, g + 1, cz - 12]);
  // the trench: the ground row carved at g from cx - 1 to cx + 1 (the body sits in its own ground: sunk 1)
  r.part('trench', { stage: 'ground' }).columns({ abs: 0 }, { abs: 0 }, [cx - 1, cz, g, g, 0, cx, cz, g, g, 0, cx + 1, cz, g, g, 0], [null], { cond: 0 });
  r.fluidBody([[cx - 1, g, cz], [cx + 1, g, cz]], { id: 'pair', kind: 'pond', stage: 'ground', level: g, outlets: [[cx, g, cz]], shellRole: 'minecraft:stone_bricks', model: 'wm', ...(ctx.params?.lift === false ? { lift: false } : {}) });
  return r;
}
