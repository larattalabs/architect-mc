// s3_hill (6c S3, docs/CONTRACT.md "Phase 6c slice S3" §9 item 3): the flat variant's hill, not a catalogue program. On a flat claim it
// raises a quadratic mound `height` blocks over the flat ground (its radius the claim's half less `margin`) through the relief pass's
// `base` (T1's flat hill): one pin at its top, the mound as the land the blend meets, everything outside the band written as the base
// (the pass's `raised` cells). The harness raises the same mound (`hillAt`) with vanilla /fill (tools/lib/scenario-s3.mjs raiseHill):
// realised as a region, its cells were another owner's (OWNED) and the monastery could not build on them. Integer only (the plan
// path's lint).
import { region } from '../lib/region/program.mjs';

export const id = 's3_hill';
export const description = 'S3\'s flat variant: a quadratic hill raised through the relief pass\'s base (6c S3).';
export const catalogue = false;
export const passes = ['relief'];
export const roles = { surface: 'minecraft:grass_block', subsurface: 'minecraft:dirt', rock: 'minecraft:stone' };

export const params = {
  height: { type: 'int', min: 8, max: 64, default: 60, label: 'Hill height' },
  margin: { type: 'int', min: 2, max: 32, default: 8, label: 'Margin to the claim edge' },
};

/** The hill's height over the flat ground at (x, z): floor(height * (R^2 - d^2) / R^2) inside R, else 0. */
export function hillAt(cx, cz, R, H, x, z) {
  const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
  return d2 >= R * R ? 0 : Math.floor((H * (R * R - d2)) / (R * R));
}

export default function s3Hill(ctx) {
  const { claim, survey: S, params: P } = ctx;
  const r = region(ctx);
  r.stages(['ground']);
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const cx = (claim.minX + claim.maxX) >> 1, cz = (claim.minZ + claim.maxZ) >> 1;
  const R = Math.max(8, (Math.min(W, D) >> 1) - P.margin);
  const values = new Int16Array((2 * R + 1) * (2 * R + 1));
  for (let j = 0; j <= 2 * R; j++) for (let i = 0; i <= 2 * R; i++) values[i + j * (2 * R + 1)] = hillAt(cx, cz, R, P.height, cx - R + i, cz - R + j);
  const base = { minX: cx - R, minZ: cz - R, width: 2 * R + 1, depth: 2 * R + 1, values };
  // the pass's one pin: the claim's corner at its own ground (outside the mound), so the whole mound is the base's raised land
  const px = claim.minX + 1, pz = claim.minZ + 1;
  r.pass('relief', { around: [{ rect: [px, pz, px + 1, pz + 1], y: S.groundAt(px, pz) }], radius: 4, maxCut: 0, maxFill: Math.min(64, P.height + 2), base, part: 'hill', name: 'hill' });
  r.anchor('entrance', [claim.minX + 2, S.groundAt(claim.minX + 2, claim.minZ + 2) + 1, claim.minZ + 2]);
  r.anchor('spawn', [claim.minX + 2, S.groundAt(claim.minX + 2, claim.minZ + 2) + 1, claim.minZ + 2]);
  r.meta.relief = { flat: true, hill: { at: [cx, cz], r: R, h: P.height } };
  return r;
}
