// M10: a bridge whose supports leave a span over its maxSpan.
import { region } from '../../../../lib/region/program.mjs';
import { start } from './base.mjs';
export const id = 'broken_long_span';
export default function (ctx) {
  const { r, cx, cz } = start(region, ctx);
  const y = ctx.survey.heightAt(cx, cz) + 12;
  r.part('span', { stage: 'ways', set: 'path' }).bridge([[cx - 30, y, cz], [cx + 30, y, cz]], { width: 3, supports: { every: 40 }, maxSpan: 24, _unsafe: true, id: 'long_bridge' });
  return r;
}
