// (7c AU) a fixture authored program: a paved court at the claim's centre with a lot beside it. What a session's clean round installs (the sim
// stand-in's answer). Written as an authored program is: the closed kit imports, no trig, no clocks, its own params and claim range.
import { region } from '../lib/region/program.mjs';

export const id = 'au_courtyard';
export const params = { size: { type: 'int', min: 8, max: 48, default: 16, label: 'Court size' } };
export const catalogue = { claim: { min: [32, 32], max: [512, 512] } };

export default function courtyard(ctx) {
  const { claim, survey, params: P } = ctx;
  const r = region(ctx);
  r.stages(['ground', 'lots']);
  const cx = claim.minX + Math.floor((claim.maxX - claim.minX + 1) / 2), cz = claim.minZ + Math.floor((claim.maxZ - claim.minZ + 1) / 2);
  const h = Math.floor(P.size / 2);
  const y = survey.heightAt(cx, cz);
  r.part('court', { stage: 'ground' }).platform([[cx - h, cz - h], [cx + h, cz - h], [cx + h, cz + h], [cx - h, cz + h]], y, { material: 'path' });
  r.part('lots', { stage: 'ground' }).lot('lot_1', { at: [cx - 4, cz + h + 3], size: [9, 9], front: 'north', max: [9, 10, 9], brief: 'Gatehouse', stage: 'lots' });
  r.anchor('entrance', [cx, cz + h + 1]);
  r.anchor('spawn', [cx + 1, cz + h + 1]);
  return r;
}
