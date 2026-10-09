// M10: an 'ends' bridge with one end in the air.
import { region } from '../../../../lib/region/program.mjs';
import { start } from './base.mjs';
export const id = 'broken_ends_in_air';
export default function (ctx) {
  const { r, cx, cz } = start(region, ctx);
  const g = ctx.survey.heightAt(cx, cz);
  const y = g + 20;
  const pad = r.part('pier', { stage: 'ground' });
  pad.fill({ kind: 'box', min: [cx - 14, { floor: 1 }, cz - 3], max: [cx - 8, y - 1, cz + 3] }, 'structure', { cond: 0 });
  r.part('deck', { stage: 'ways', set: 'path' }).bridge([[cx - 11, y, cz], [cx + 8, y, cz]], { width: 3, supports: { style: 'ends' }, maxSpan: 24, id: 'half_bridge' });
  return r;
}
