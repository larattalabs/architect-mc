// (6c H) Shared helpers for the H tests (not a test file itself): a frozen volume synthesized from a survey (what the game would sample:
// air over the ground, 3 soil, rock below; a water column's cells from its floor up to its ground as water sources), with the block ids
// and the fluid layer (ARVX version 3) when asked, and the two-plan flow over a bundled program in process.
import { planRegion } from '../lib/region/plan.mjs';
import { encodeArvx, decodeArvx, VC, FC } from '../lib/region/volume.mjs';
import { surveyApi } from '../lib/region/survey.mjs';

/**
 * A synthetic frozen volume over `box` from `survey` (ARSV bytes or columns) and `claim`: `{box, bytes, sha, decoded}` (the shape
 * ctx.volumes holds). `fluids`: a version-3 volume (blocks and the fluid layer). `edits`: [{box: [x0, y0, z0, x1, y1, z1], class, block?,
 * fluid?}] applied in order (a cave, an owned cell, a pocket of flowing water).
 */
export function synthVolume(box, survey, claim, { fluids = true, edits = [] } = {}) {
  const S = surveyApi(survey, claim);
  const W = box.maxX - box.minX + 1, H = box.maxY - box.minY + 1, D = box.maxZ - box.minZ + 1;
  const n = W * H * D;
  const classes = new Uint8Array(n);
  const palette = ['minecraft:air', 'minecraft:stone', 'minecraft:dirt', 'minecraft:grass_block', 'minecraft:water', 'minecraft:sand', 'minecraft:lava'];
  const index = new Uint16Array(n);
  const fl = new Uint8Array(n);
  const blockOf = (b) => { let i = palette.indexOf(b); if (i < 0) { palette.push(b); i = palette.length - 1; } return i; };
  for (let x = box.minX; x <= box.maxX; x++) for (let z = box.minZ; z <= box.maxZ; z++) {
    const inClaim = x >= claim.minX && x <= claim.maxX && z >= claim.minZ && z <= claim.maxZ;
    const g = inClaim ? S.groundAt(x, z) : 64, f = inClaim ? S.floorAt(x, z) : 64, wet = inClaim && S.waterAt(x, z);
    for (let y = box.minY; y <= box.maxY; y++) {
      const i = ((x - box.minX) * D + (z - box.minZ)) * H + (y - box.minY);
      let c, b, fc = FC.none;
      if (wet && y > f && y <= g) { c = VC.WATER; b = 4; fc = FC.water_source; }
      else if (y > (wet ? g : g)) { c = VC.AIR; b = 0; }
      else if (y === f && wet) { c = VC.LOOSE; b = 5; }
      else if (y === g) { c = VC.SOIL; b = 3; }
      else if (y >= g - 3) { c = VC.SOIL; b = 2; }
      else { c = VC.ROCK; b = 1; }
      for (const e of edits) if (x >= e.box[0] && x <= e.box[3] && y >= e.box[1] && y <= e.box[4] && z >= e.box[2] && z <= e.box[5]) { c = VC[e.class]; b = e.block ? blockOf(e.block) : c === VC.AIR ? 0 : b; if (e.fluid !== undefined) fc = FC[e.fluid]; }
      classes[i] = c; index[i] = b; fl[i] = fc;
    }
  }
  const bytes = fluids ? encodeArvx(box, classes, [], new Map(), { palette, index }, fl) : encodeArvx(box, classes);
  const decoded = decodeArvx(bytes);
  return { box: { ...box }, bytes, sha: decoded.sha, decoded };
}

/**
 * The two-plan flow over a bundled program in process (Regions.plan's, 6b): plan once, synthesize every asked volume from the survey,
 * plan again with them. `o`: planRegion's options (program, programSource, params, survey, claim, seed, node). Returns the second
 * plan's result with `first` and `volumes`.
 */
export async function planTwice(o, { edits = [] } = {}) {
  const first = await planRegion(o);
  const need = first.needVolumes ?? [];
  if (!need.length) return { ...first, first, volumes: [] };
  const volumes = need.map((b) => synthVolume({ minX: b.minX, minY: b.minY, minZ: b.minZ, maxX: b.maxX, maxY: b.maxY, maxZ: b.maxZ }, o.survey, o.claim, { fluids: !!b.fluids || !!b.blocks, edits }));
  const second = await planRegion({ ...o, volumes });
  return { ...second, first, volumes };
}
