// M3 floating_spur: an island part with a second mass that has no face contact with it.
import { region } from '../../../../lib/region/program.mjs';
import { start } from './base.mjs';
export const id = 'broken_floating_spur';
export default function (ctx) {
  const { r, cx, cz } = start(region, ctx);
  const y = ctx.survey.heightAt(cx, cz) + 40;
  const isl = r.part('isle', { stage: 'ground' });
  isl.add({ kind: 'ellipsoid', c: [cx, { abs: y }, cz], r: [10, 4, 10] }, 'rock');
  isl.add({ kind: 'sphere', c: [cx + 20, { abs: y - 8 }, cz], r: 2.5 }, 'rock'); // the spur
  r.anchor('isle_top', [cx, y + 5, cz]);
  r.floating(['isle'], { anchor: 'isle_top' });
  return r;
}
