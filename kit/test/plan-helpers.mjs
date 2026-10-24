// (6c P0) Shared by the plan-check tests: committed survey inputs and an in-process check (plan_v0's plan, then finish.mjs), the
// same code tools/region.mjs runs in the sidecar's sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { planRegion, fillMissing } from '../lib/region/plan.mjs';
import { asColumns, encodeColumns, makeColumns, FLAG_WATER, FLAG_TREE } from '../lib/region/pack.mjs';
import { finishCheck } from '../lib/plan/finish.mjs';

export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(KIT, '..');
export const PLAN_V0 = path.join(KIT, 'regions', 'plan_v0.mjs');
export const FIX = path.join(KIT, 'test', 'fixtures', 'plan');
/**
 * (6c close-out A, §6) Steward's first recordings of the 59 asks (steward-mc 8703dbd): the 47 still in asks/ and the 12 it re-recorded since
 * (0c8f4a8), kept whole in asks-8703dbd/. The slices before close-out A judged those plans, and their tests still do.
 */
export const ASKS_FIRST_DIR = path.join(FIX, 'asks-8703dbd');
export const asksFirstPath = (file) => (fs.existsSync(path.join(ASKS_FIRST_DIR, file)) ? path.join(ASKS_FIRST_DIR, file) : path.join(FIX, 'asks', file));

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
export async function checkPlanLocal(plan, { survey, claim, anchors = {}, protected: prot = [], regions = [], builds = [], standing = null, biomes = null, budget = {}, bible = null, fingerprint = null, keepOut = [], planCache = null, volumes = [], style = null, lotBlocks = null, survival = false, besideReach = null } = {}) {
  const params = { plan, anchors: { anchors }, protected: { areas: prot }, regions: { regions }, builds: { builds }, ...(standing ? { standing: { standing } } : {}), budget, bible, fingerprint: fingerprint ? { sha: fingerprint } : null };
  // (6c VOC) `style`: a bible.json's members as the sidecar passes them to the plan CLI (roles, patterns, connectors, fluids, rarity)
  const sty = style ? { roles: { ...(style.roles ?? {}) }, ...(style.patterns ? { patterns: style.patterns } : {}), ...(style.connectors ? { connectors: style.connectors } : {}), ...(style.fluids ? { fluids: style.fluids } : {}), ...(style.rarity ? { rarity: style.rarity } : {}) } : { roles: {} };
  // ((6c D3) `besideReach`: the reach inputs of the standing regions endpoint.region names, {regionId: {survey, held, standing}})
  const res = await planRegion({ programFile: PLAN_V0, params, survey, claim, ...sty, keepOut, planCache, ...(biomes ? { biomes } : {}), ...(volumes.length ? { volumes } : {}), ...(lotBlocks ? { lotBlocks } : {}), ...(survival ? { survival: true } : {}), ...(besideReach ? { besideReach } : {}) });
  const cols = fillMissing(asColumns(survey)).columns;
  const f = finishCheck({ res, survey: cols, blobs: (sha) => res.blobs.get(sha) ?? null, surveyBytesSha: createHash('sha256').update(survey).digest('hex'), inputs: { surveyRes: cols.resolution } });
  return { ...f, res };
}

/**
 * (7a K1b) A flat claim for the rope fixtures (rift_city's claim range): 240x160 at ground 64, from (1000, 2000); `bands` carve or
 * raise rects `{x0, z0, x1, z1, y, water?}` (ground y; water: a water column from its floor y to y + depth).
 */
export function flatSurvey({ W = 240, D = 160, x0 = 1000, z0 = 2000, y = 64, bands = [], trees = [] } = {}) {
  const c = makeColumns(x0, z0, W, D, 1);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    const k = i + j * W, x = x0 + i, z = z0 + j;
    let g = y, f = y, flag = 0;
    for (const b of bands) if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) { if (b.water) { f = b.y; g = b.y + b.water; flag = FLAG_WATER; } else { g = b.y; f = b.y; flag = 0; } }
    c.ground[k] = g; c.height[k] = g; c.floor[k] = f; c.flags[k] = flag;
  }
  // (6c H-a) trees: [[x, z, height]] trunk columns (FLAG_TREE, the column's top `height` over the ground)
  for (const [x, z, h] of trees) { const k = (x - x0) + (z - z0) * W; if (k >= 0 && k < W * D) { c.flags[k] |= FLAG_TREE; c.height[k] = c.ground[k] + h; } }
  return { bytes: encodeColumns(c), claim: { minX: x0, minZ: z0, maxX: x0 + W - 1, maxZ: z0 + D - 1, minY: -64, maxY: 319 } };
}

/** A cache over a Map (what the sidecar's per-owner directory holds). */
export function memoryCache() {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, put: (out) => { for (const [k, v] of Object.entries(out ?? {})) m.set(k, JSON.parse(JSON.stringify(v))); }, size: () => m.size };
}

/**
 * (6c T3b) A fixture's frozen volume over `box` (what the game would sample): air over the ground, soil to 3 under it, rock below,
 * then `spec.edits` ([{box: [x0, y0, z0, x1, y1, z1], class}] in order, each a voxel class name over its cells). Returns
 * `{box, bytes, sha, decoded}` (the shape ctx.volumes holds).
 */
export async function fixtureVolume(box, spec, survey, claim) {
  // (6c H) a box asked with fluids (`box.fluids`): the synthetic volume of h-helpers.mjs (version 3: the survey's water columns as water
  // sources from the floor up to the ground, block ids and the fluid layer), with the spec's edits
  if (box.fluids) {
    const { synthVolume } = await import('./h-helpers.mjs');
    const b = { minX: box.minX, minY: box.minY, minZ: box.minZ, maxX: box.maxX, maxY: box.maxY, maxZ: box.maxZ };
    return synthVolume(b, survey, claim, { fluids: true, edits: spec?.edits ?? [] });
  }
  const { encodeArvx, decodeArvx, VC } = await import('../lib/region/volume.mjs');
  const { surveyApi } = await import('../lib/region/survey.mjs');
  const S = surveyApi(survey, claim);
  const W = box.maxX - box.minX + 1, H = box.maxY - box.minY + 1, D = box.maxZ - box.minZ + 1;
  const classes = new Uint8Array(W * H * D);
  const edits = (spec?.edits ?? []).map((e) => ({ b: e.box, c: VC[e.class] }));
  for (let x = box.minX; x <= box.maxX; x++) for (let z = box.minZ; z <= box.maxZ; z++) {
    const inClaim = x >= claim.minX && x <= claim.maxX && z >= claim.minZ && z <= claim.maxZ;
    const g = inClaim ? S.groundAt(x, z) : 64;
    for (let y = box.minY; y <= box.maxY; y++) {
      let c = y > g ? VC.AIR : y >= g - 3 ? VC.SOIL : VC.ROCK;
      for (const e of edits) if (x >= e.b[0] && x <= e.b[3] && y >= e.b[1] && y <= e.b[4] && z >= e.b[2] && z <= e.b[5]) c = e.c;
      classes[((x - box.minX) * D + (z - box.minZ)) * H + (y - box.minY)] = c;
    }
  }
  const bytes = encodeArvx(box, classes);
  const decoded = decodeArvx(bytes);
  return { box, bytes, sha: decoded.sha, decoded };
}

/**
 * (6c T3b, CONTRACT T3 §6) The plan check's two-plan flow in process: plan once; when a tunnel part asked for volumes, build each
 * asked box from `volume` (fixtureVolume's spec; `volume.missing: true` gives none, as chunks not loaded), plan again with them.
 * Returns the second check (or the first when nothing was asked), with `volumes` and `first` (the first plan's check).
 */
export async function checkPlanVolumes(plan, { volume = {}, ...o } = {}) {
  // (the caller's own volumes, given before any plan: `volume.given` [[x0, y0, z0, x1, y1, z1]], built from the same spec)
  if (Array.isArray(volume.given) && volume.given.length) {
    o = { ...o, volumes: [...(o.volumes ?? [])] };
    for (const b of volume.given) o.volumes.push(await fixtureVolume({ minX: b[0], minY: b[1], minZ: b[2], maxX: b[3], maxY: b[4], maxZ: b[5] }, volume, o.survey, o.claim));
  }
  const first = await checkPlanLocal(plan, o);
  const need = first.res.needVolumes ?? [];
  const hasTunnel = (plan.connectors ?? []).some((p) => p?.kind === 'tunnel');
  // (6c H, §10) the trigger widened: a body part (pond, fountain, waterfall, moat), a quay, or a part that took the wet fallback (meta.wet)
  const hasH = [...(plan.forms ?? []), ...(plan.connectors ?? [])].some((p) => ['pond', 'fountain', 'waterfall', 'quay', 'channel'].includes(p?.kind)) || (first.res.meta?.wet ?? []).length > 0 || first.check?.wetAsked === true
    || /"(farmPond|irrigate)":true/.test(JSON.stringify(plan.zones ?? [])); // ((6c IRR) irrigate too: PlanChecks.hasH)
  // ((6c F3 §3.3) the cave forms read a frozen volume too: PlanChecks.hasCaveForm)
  const hasCave = (plan.forms ?? []).some((p) => ['stalactites', 'roots'].includes(p?.kind));
  if (!need.length || !(hasTunnel || hasH || hasCave) || volume.missing) return { ...first, volumes: o.volumes ?? [], first, asked: need };
  const vols = [...(o.volumes ?? [])];
  for (const b of need) if (!vols.some((v) => v.box.minX === b.minX && v.box.minY === b.minY && v.box.minZ === b.minZ && v.box.maxX === b.maxX && v.box.maxY === b.maxY && v.box.maxZ === b.maxZ)) vols.push(await fixtureVolume(b, volume, o.survey, o.claim));
  const second = await checkPlanLocal(plan, { ...o, volumes: vols });
  return { ...second, volumes: vols, first, asked: need };
}

/** (6c VOC) A fixture's style: a scenario bible's name (scenarios/bibles/<name>.json), or an inline bible, or null. */
export function fixtureStyle(fx) {
  return typeof fx.style === 'string' ? JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'bibles', `${fx.style}.json`), 'utf8')) : fx.style ?? null;
}

/**
 * (6c VOC-c) A fixture's `lotDesigns` ({lot: design id}, kit/test/fixtures/vocab/vocc-designs.mjs) as the check's `lotBlocks`: each
 * design's block histogram, as the mod reads the bound entry's template. Null without any.
 */
export async function fixtureLotBlocks(fx) {
  if (!fx.lotDesigns) return null;
  const { VOCC_DESIGNS, blueprintBlocks } = await import('./fixtures/vocab/vocc-designs.mjs');
  return Object.fromEntries(Object.entries(fx.lotDesigns).map(([lot, id]) => [lot, blueprintBlocks(VOCC_DESIGNS[id]())]));
}
