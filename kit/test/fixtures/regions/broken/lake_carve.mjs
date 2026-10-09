// M4: a bowl carved next to a surveyed lake (the test survey has water at the claim's west side).
import { region } from '../../../../lib/region/program.mjs';
import { start } from './base.mjs';
export const id = 'broken_lake_carve';
export default function (ctx) {
  const { r, cx, cz, c } = start(region, ctx);
  const x = c.minX + 34, g = ctx.survey.heightAt(x, cz);
  r.part('pit', { stage: 'ground' }).carve({ kind: 'bowl', c: [x, { abs: g }, cz], r: 12, depth: 8 });
  return r;
}
