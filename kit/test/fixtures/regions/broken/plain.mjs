// The base of the IR-doctored variants (M13, M14): two small parts.
import { region } from '../../../../lib/region/program.mjs';
import { start } from './base.mjs';
export const id = 'broken_plain';
export default function (ctx) {
  const { r, cx, cz } = start(region, ctx);
  const g = ctx.survey.heightAt(cx, cz);
  r.part('mound', { stage: 'ground' }).fill({ kind: 'box', min: [cx - 2, g + 1, cz - 2], max: [cx + 2, g + 1, cz + 2] }, 'rubble', { cond: 0 });
  r.part('cairn', { stage: 'ground' }).fill({ kind: 'box', min: [cx + 6, g + 1, cz], max: [cx + 6, g + 2, cz] }, 'structure', { cond: 0 });
  return r;
}
