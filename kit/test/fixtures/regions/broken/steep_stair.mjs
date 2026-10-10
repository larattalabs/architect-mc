// M7: a stair that rises 2 per step.
import { region } from '../../../../lib/region/program.mjs';
import { start } from './base.mjs';
export const id = 'broken_steep_stair';
export default function (ctx) {
  const { r, cx, cz } = start(region, ctx);
  const g = ctx.survey.heightAt(cx, cz);
  r.part('steep', { stage: 'ways', set: 'path' }).stair([[cx - 6, g, cz], [cx + 6, g + 24, cz]], { width: 3, _unsafeRise: true, solid: true, id: 'steep_stair' });
  return r;
}
