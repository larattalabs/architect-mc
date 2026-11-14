// s3v2_cliffs (7c BR; the S3 v2 gallery item, docs/CONTRACT.md "Phase 7b" §5: "site variants of P1's cliff design on S3's fixture; no
// bars"): attach_to_cliff site lots on the claim's own cliff faces (AF's `cliff_face`), for $0 site variants of a cliff-built design
// (7b P1's gen_pa_cliff_house) placed into them. A gallery program, not a catalogue program: no pad, no route, no op but the lots.
// The faces: the highest-scoring first, at least `minHeight` tall, each face farther than the design's longest side from the lots already taken.
// Cameras: one out from each lot's face (24 along its normal, 6 up) and one high over the claim, all looking at the lot nearest
// the centre (`hub`). Deterministic: no Math.random, no clock, no trig.
import { region } from '../lib/region/program.mjs';

export const id = 's3v2_cliffs';
export const description = 'S3 v2 gallery: cliff-built houses as site lots on the claim\'s own cliff faces (7c BR).';
export const catalogue = false;
export const params = {
  lots: { type: 'int', min: 1, max: 8, default: 5, label: 'Cliff lots' },
  minHeight: { type: 'int', min: 4, max: 64, default: 10, label: 'Least face height' },
};
/** The cliff design's size [w, h, d] (front south; 7b P1's gen_pa_cliff_house). */
export const DESIGN = Object.freeze([18, 24, 12]);
const NORMAL = Object.freeze({ north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] });
const meets = (a, b, g) => a.minX - g <= b.maxX && a.maxX + g >= b.minX && a.minY - g <= b.maxY && a.maxY + g >= b.minY && a.minZ - g <= b.maxZ && a.maxZ + g >= b.minZ;

export default function s3v2Cliffs(ctx) {
  const { claim, survey, params: P } = ctx;
  const r = region(ctx);
  r.stages(['lots']);
  // the read box: the claim's columns, from 8 under the lowest ground to 32 over the highest (inside the claim's y)
  let lo = Infinity, hi = -Infinity;
  for (let x = claim.minX; x <= claim.maxX; x += 2) for (let z = claim.minZ; z <= claim.maxZ; z += 2) { const h = survey.heightAt(x, z); if (h < lo) lo = h; if (h > hi) hi = h; }
  const probe = { minX: claim.minX, maxX: claim.maxX, minZ: claim.minZ, maxZ: claim.maxZ, minY: Math.max(claim.minY, lo - 8), maxY: Math.min(claim.maxY, hi + 32) };
  const faces = r.affordances(probe, { kinds: ['cliff_face'] });
  const cx = claim.minX + Math.floor((claim.maxX - claim.minX + 1) / 2), cz = claim.minZ + Math.floor((claim.maxZ - claim.minZ + 1) / 2);
  r.anchor('entrance', [cx, survey.heightAt(cx, cz) + 1, cz]);
  r.anchor('spawn', [cx, survey.heightAt(cx, cz) + 1, cz]);
  if (!faces.length) { r.meta.s3v2 = { faces: 0, lots: [] }; return r; } // (the first plan reads the volume; the second places the lots)
  const tall = faces.filter((a) => a.box.maxY - a.box.minY + 1 >= P.minHeight && NORMAL[a.normal]);
  tall.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const taken = [], tried = [];
  for (const a of tall) {
    if (taken.length >= P.lots) break;
    // (a lot recorded stays: skip a face within a design's reach of a lot taken before asking for its lot)
    if (taken.some((t) => meets(t.box, a.box, Math.max(...DESIGN)))) { tried.push({ face: a.id, why: 'near a lot taken' }); continue; }
    const id = `cliff_${taken.length + 1}`;
    let lot = null;
    try {
      lot = r.siteLot(id, { affordance: a, fit: 'attach_to_cliff', max: [...DESIGN], stage: 'lots', brief: 'A house built into this cliff face (7b P1\'s cliff design, a $0 site variant).' });
    } catch (e) { tried.push({ face: a.id, why: String(e.message).slice(0, 160) }); continue; }
    if (!lot) { tried.push({ face: a.id, why: 'no lot (its volume)' }); continue; }
    taken.push({ id, box: lot.box, normal: a.normal, face: a.id });
  }
  r.meta.s3v2 = { faces: faces.length, tall: tall.length, lots: taken, tried: tried.slice(0, 24) };
  if (!taken.length) return r;
  const mid = (b) => [Math.floor((b.minX + b.maxX) / 2), Math.floor((b.minY + b.maxY) / 2), Math.floor((b.minZ + b.maxZ) / 2)];
  const near = [...taken].sort((a, b) => { const [ax, , az] = mid(a.box), [bx, , bz] = mid(b.box); return Math.abs(ax - cx) + Math.abs(az - cz) - (Math.abs(bx - cx) + Math.abs(bz - cz)); })[0];
  r.anchor('hub', mid(near.box));
  taken.forEach((t, i) => {
    const [x, y, z] = mid(t.box), [nx, nz] = NORMAL[t.normal];
    const at = [Math.min(claim.maxX, Math.max(claim.minX, x + 24 * nx)), y + 6, Math.min(claim.maxZ, Math.max(claim.minZ, z + 24 * nz))];
    r.anchor(`cam_lot${i + 1}`, at);
  });
  r.anchor('cam_high', [cx, hi + 40, Math.min(claim.maxZ, cz + 60)]);
  return r;
}
