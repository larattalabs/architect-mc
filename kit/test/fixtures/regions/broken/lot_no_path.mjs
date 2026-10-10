// M2: a lot on top of a 10-high block with no way up.
import { region } from '../../../../lib/region/program.mjs';
import { start } from './base.mjs';
export const id = 'broken_lot_no_path';
export default function (ctx) {
  const { r, cx, cz } = start(region, ctx);
  const g = ctx.survey.heightAt(cx, cz);
  const p = r.part('plinth', { stage: 'ground' });
  p.fill({ kind: 'box', min: [cx - 7, { floor: 1 }, cz - 7], max: [cx + 7, g + 10, cz + 7] }, 'structure', { cond: 0 });
  p.lot('lot_high', { at: [cx - 4, cz - 4], size: [8, 8], floor: g + 11, front: 'south', stage: 'lots', pad: { fill: 'none', edge: 'wall', maxCut: 64, maxFill: 64 } });
  return r;
}
