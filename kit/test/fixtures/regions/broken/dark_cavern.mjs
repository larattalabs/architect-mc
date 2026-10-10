// M5: a cavern whose "light" blocks give no light.
import { region } from '../../../../lib/region/program.mjs';
import { start } from './base.mjs';
export const id = 'broken_dark_cavern';
export default function (ctx) {
  const { r, cx, cz } = start(region, ctx);
  const g = ctx.survey.heightAt(cx, cz);
  r.part('cave', { stage: 'ground' }).cavern({ kind: 'ellipsoid', c: [cx, { abs: g - 14 }, cz], r: [12, 5, 10] }, { amp: 0, floorY: g - 17, light: { every: 6, block: 'minecraft:cobblestone' } });
  // a stair down into it, so its floor is walk area
  r.part('down', { stage: 'ways', set: 'path' }).stair([[cx, g, cz + 26], [cx, g - 18, cz + 2]], { width: 3, solid: true });
  return r;
}
