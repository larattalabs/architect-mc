// M1: a part that writes outside the claim.
import { region } from '../../../../lib/region/program.mjs';
import { start } from './base.mjs';
export const id = 'broken_outside_claim';
export default function (ctx) {
  const { r, c } = start(region, ctx);
  const g = ctx.survey.heightAt(c.maxX - 2, c.minZ + 10);
  r.part('overhang', { stage: 'ground' }).fill({ kind: 'box', min: [c.maxX - 4, g + 1, c.minZ + 8], max: [c.maxX + 6, g + 3, c.minZ + 12] }, 'structure', { cond: 0 });
  return r;
}
