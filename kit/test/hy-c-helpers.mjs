// (6c HY-c) Shared helpers for the water gate's tests (not a test file itself): hy_gate_demo on a flat claim through the two-plan flow,
// and the checker over it.
import fs from 'node:fs';
import path from 'node:path';
import { flatSurvey } from './plan-helpers.mjs';
import { planTwice } from './h-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import * as demo from '../regions/hy_gate_demo.mjs';

export const G = 64;
export const CLAIM = { minX: 1000, minZ: 2000, maxX: 1127, maxZ: 2111, minY: -64, maxY: 319 };
const SRC = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'regions', 'hy_gate_demo.mjs'), 'utf8');

/** hy_gate_demo through the two-plan flow on a flat claim. */
export async function planGate(params = {}, claim = CLAIM) {
  const sv = flatSurvey({ W: claim.maxX - claim.minX + 1, D: claim.maxZ - claim.minZ + 1, x0: claim.minX, z0: claim.minZ, y: G });
  const p = await planTwice({ program: demo, programSource: SRC, params, survey: sv.bytes, seed: '7', claim: sv.claim, node: 'test' });
  return { ...p, world: { survey: sv.bytes, claim: sv.claim } };
}

/** The checker's report over a planGate result. */
export function checkGate(p) {
  return checkRegion({ ir: p.ir, survey: p.world.survey, blobs: p.blobs, volumes: p.volumes.map((v) => v.decoded), meta: p.meta });
}
