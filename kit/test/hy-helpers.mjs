// (6c HY) Shared helpers for the HY tests (not a test file itself): hy_core_demo's flat claim with the natural lake beside its head (the
// gate /fills the same lake in game: handcourse.mjs hyCoreLake), its survey and the frozen volumes' edits, and the two-plan flow over it.
import fs from 'node:fs';
import path from 'node:path';
import { flatSurvey } from './plan-helpers.mjs';
import { planTwice } from './h-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import * as demo from '../regions/hy_core_demo.mjs';

export const G = 64;
export const CLAIM = { minX: 1000, minZ: 2000, maxX: 1095, maxZ: 2063, minY: -64, maxY: 319 };

/** The lake's boxes for a claim: {wall, water, level} (absolute [x0, y0, z0, x1, y1, z1]). */
export function lakeOf(claim = CLAIM, params = {}) {
  return demo.hyCoreLake(demo.hyCoreOrigin(claim, params), G);
}

/** The flat survey with the lake (its walls' top and its water as the survey reads them), and the volume edits that make it. */
export function lakeWorld(claim = CLAIM, params = {}, { lake = true } = {}) {
  const L = lakeOf(claim, params);
  const bands = lake ? [
    { x0: L.wall[0], x1: L.wall[3], z0: L.wall[2], z1: L.wall[5], y: L.wall[4] },
    { x0: L.water[0], x1: L.water[3], z0: L.water[2], z1: L.water[5], y: L.water[1] - 1, water: L.water[4] - L.water[1] + 1 },
  ] : [];
  const sv = flatSurvey({ W: claim.maxX - claim.minX + 1, D: claim.maxZ - claim.minZ + 1, x0: claim.minX, z0: claim.minZ, y: G, bands });
  const edits = lake ? [
    { box: L.wall, class: 'ROCK', block: 'minecraft:stone', fluid: 'none' },
    { box: L.water, class: 'WATER', block: 'minecraft:water', fluid: 'water_source' },
  ] : [];
  return { survey: sv.bytes, claim: sv.claim, edits, lake: L };
}

const SRC = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'regions', 'hy_core_demo.mjs'), 'utf8');

/** hy_core_demo through the two-plan flow on the lake world. */
export async function planHy(params = {}, { lake = true } = {}) {
  const w = lakeWorld(CLAIM, params, { lake });
  const p = await planTwice({ program: demo, programSource: SRC, params, survey: w.survey, seed: '7', claim: w.claim, node: 'test' }, { edits: w.edits });
  return { ...p, world: w };
}

/** The checker's report over a planHy result. */
export function checkHy(p) {
  return checkRegion({ ir: p.ir, survey: p.world.survey, blobs: p.blobs, volumes: p.volumes.map((v) => v.decoded), meta: p.meta });
}
