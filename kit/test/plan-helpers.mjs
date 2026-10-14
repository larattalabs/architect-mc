// (6c P0) Shared by the plan-check tests: committed survey inputs and an in-process check (plan_v0's plan, then finish.mjs), the
// same code tools/region.mjs runs in the sidecar's sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { planRegion, fillMissing } from '../lib/region/plan.mjs';
import { asColumns, encodeColumns, makeColumns, FLAG_WATER } from '../lib/region/pack.mjs';
import { finishCheck } from '../lib/plan/finish.mjs';

export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(KIT, '..');
export const PLAN_V0 = path.join(KIT, 'regions', 'plan_v0.mjs');
export const FIX = path.join(KIT, 'test', 'fixtures', 'plan');

/** A committed scenario survey: S7's flat claim (`s7`) or S3's pinned claim (`s3`, relief_demo's and route_demo's golden survey). */
export function goldenSurvey(name) {
  const dir = path.join(ROOT, 'scenarios', 'goldens', name === 's3' ? 'route_demo' : name);
  const ir = JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8'));
  const bytes = fs.readFileSync(path.join(dir, 'survey.bin'));
  const c = ir.claim;
  return { bytes, claim: { minX: c.minX, minZ: c.minZ, maxX: c.maxX, maxZ: c.maxZ, minY: -64, maxY: 319 } };
}

/**
 * The asks' claim: 320x320 flat ground at y 64 (grass), with a lake in the south-east (40x28, its bed at 60) and a stream from it to
 * the east edge, deterministic (no noise): the 59 recorded plans run over it in kit CI.
 */
export function asksSurvey() {
  const W = 320, D = 320, x0 = 0, z0 = 0;
  const c = makeColumns(x0, z0, W, D, 1);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    const k = i + j * W;
    const lake = i >= 240 && i < 280 && j >= 240 && j < 268;
    const stream = i >= 280 && j >= 252 && j < 256;
    c.ground[k] = 64; c.height[k] = 64; c.floor[k] = lake || stream ? 60 : 64;
    if (lake || stream) c.flags[k] = FLAG_WATER;
  }
  return { bytes: encodeColumns(c), claim: { minX: x0, minZ: z0, maxX: x0 + W - 1, maxZ: z0 + D - 1, minY: -64, maxY: 319 } };
}

/** Steward's anchors (S-P0-3) at fixed places in a claim: stone at the centre, the player and the stockpile beside it, the street ends. */
export function stewardAnchors(claim) {
  const cx = (claim.minX + claim.maxX) >> 1, cz = (claim.minZ + claim.maxZ) >> 1;
  return { stone: [cx, 65, cz], player: [cx - 24, 65, cz - 24], stockpile: [cx + 12, 65, cz + 12], street_w: [claim.minX + 8, 65, cz], street_e: [claim.maxX - 8, 65, cz] };
}

/**
 * Check a plan in process: plan_v0 over `survey` (bytes) and `claim`, then finish. Options: anchors {name: [x, y, z]}, protected
 * [{id, rect}], regions [{id, rect}], budget, bible, fingerprint, keepOut [[x0, z0, x1, z1]], planCache (key -> entry | null).
 */
export async function checkPlanLocal(plan, { survey, claim, anchors = {}, protected: prot = [], regions = [], builds = [], standing = null, budget = {}, bible = null, fingerprint = null, keepOut = [], planCache = null } = {}) {
  const params = { plan, anchors: { anchors }, protected: { areas: prot }, regions: { regions }, builds: { builds }, ...(standing ? { standing: { standing } } : {}), budget, bible, fingerprint: fingerprint ? { sha: fingerprint } : null };
  const res = await planRegion({ programFile: PLAN_V0, params, survey, claim, roles: {}, keepOut, planCache });
  const cols = fillMissing(asColumns(survey)).columns;
  const f = finishCheck({ res, survey: cols, blobs: (sha) => res.blobs.get(sha) ?? null, surveyBytesSha: createHash('sha256').update(survey).digest('hex'), inputs: { surveyRes: cols.resolution } });
  return { ...f, res };
}

/** A cache over a Map (what the sidecar's per-owner directory holds). */
export function memoryCache() {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, put: (out) => { for (const [k, v] of Object.entries(out ?? {})) m.set(k, JSON.parse(JSON.stringify(v))); }, size: () => m.size };
}
