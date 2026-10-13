// (6c P0) The plan check through the sidecar (docs/CONTRACT.md "Phase 6c slice P0" §2, §4, §6, §7): region.plan of the bundled
// plan_v0 with `planCache` (the owner) carries the kit's answer (planCheck: overall, parts, cost, catalogue, the light preview with the
// class map, the artifact's canonical JSON), renders only the asked previews, keeps the per-owner cache (24 h or 256 checks) and
// lowers the plan budget to the check's. Also gate item 1's other half: every kit/test/fixtures/plan/valid/ plan is valid under
// ajv's 2020-12 validator, and plan.json compiles there. The REAL kit; skipped without it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020Module from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import type { Outbound } from '../src/protocol.js';
import { FEATURES, parseClientMessage } from '../src/protocol.js';
import { PLAN_CACHE_CHECKS } from '../src/regions.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { arsv, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'regions', 'plan_v0.mjs'));
const CLAIM = { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 };
type Planned = Extract<Outbound, { type: 'region.planned' }>;
const lots = (n: number, p = 'h') => Array.from({ length: n }, (_, i) => ({ id: `${p}${i + 1}`, type: 'house', size: [9, 9] }));

describe('plan/0 under ajv 2020-12 (gate item 1)', () => {
  it.skipIf(!hasKit)('compiles kit/schemas/plan.json and accepts every valid/ fixture', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(KIT, 'schemas', 'plan.json'), 'utf8')) as Record<string, unknown>;
    // ajv's CommonJS default export, under NodeNext's interop
    const Ajv2020 = ((Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module) as unknown as new (o: Record<string, unknown>) => { compile: (s: unknown) => ((v: unknown) => boolean) & { errors?: unknown } };
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    const dir = path.join(KIT, 'test', 'fixtures', 'plan', 'valid');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const f of files) {
      const plan = (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { plan: unknown }).plan;
      expect(validate(plan), `${f}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    // the 59 recorded plans too (Steward validated them against the same schema)
    const asks = path.join(KIT, 'test', 'fixtures', 'plan', 'asks');
    for (const f of fs.readdirSync(asks).filter((x) => x.endsWith('.json') && x !== 'SOURCE.json')) {
      const plan = (JSON.parse(fs.readFileSync(path.join(asks, f), 'utf8')) as { answer: { plan: unknown } }).answer.plan;
      expect(validate(plan), `${f}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });
});

describe('region.plan: the P0 members', () => {
  it('lists region.planCheck after region.route', () => {
    expect(FEATURES.indexOf('region.planCheck')).toBe(FEATURES.indexOf('region.route') + 1);
  });
  it('takes planCache, previewViews, timeoutMs and heapMb; params up to 256 KB', () => {
    const base = { v: 1, type: 'region.plan', id: 'x', program: 'plan_v0', claim: CLAIM, surveyBlobId: 'b'.repeat(16) };
    expect(parseClientMessage(JSON.stringify({ ...base, params: { plan: { notes: 'n'.repeat(100_000) } }, planCache: 'steward_mc:town', previewViews: ['siteplan'], timeoutMs: 1000, heapMb: 512 })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ ...base, params: { plan: { notes: 'n'.repeat(300_000) } } })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ ...base, params: {}, previewViews: ['photo'] })).ok).toBe(false);
  });
});

describe.skipIf(!hasKit)('a plan check through the sidecar (real kit)', () => {
  let root: string;
  let sc: Sidecar;
  let dataDir: string;
  const events: Outbound[] = [];
  beforeAll(async () => {
    root = tempDir('arch-plan-check-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    dataDir = cfg.dataDir;
    sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    sc.subscribe((m) => events.push(m));
    await sc.start(new SimDesigner(sc, 5));
  });
  afterAll(async () => {
    await sc?.close();
    rmrf(root);
  });

  async function check(plan: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Planned | { failed: string }> {
    const surveyBlobId = sc.blobs.putBytes(arsv(0, 0, 192, 192, () => 64), 'survey', 'bin');
    let ack: { ok: boolean; error?: string; result?: Record<string, unknown> } | undefined;
    const params = { plan, anchors: { anchors: { stone: [96, 65, 96] } }, protected: { areas: [] }, regions: { regions: [] }, budget: {}, bible: null, fingerprint: { sha: 'f'.repeat(64) } };
    await sc.handle({ v: 1, type: 'region.plan', id: 'p', program: 'plan_v0', params, claim: CLAIM, surveyBlobId, planCache: 'steward_mc:test', previewViews: ['siteplan'], ...extra } as never, (m) => {
      if (m.type === 'ack') ack = m;
    });
    expect(ack?.ok, ack?.error).toBe(true);
    const planId = ack!.result!.planId as string;
    await until(() => events.some((e) => (e.type === 'region.planned' || e.type === 'region.failed') && e.planId === planId), 180_000, 50);
    const failed = events.find((e) => e.type === 'region.failed' && e.planId === planId);
    if (failed?.type === 'region.failed') return { failed: failed.message };
    return events.find((e): e is Planned => e.type === 'region.planned' && e.planId === planId)!;
  }

  const PLAN = { schemaVersion: 'plan/0', zones: [{ id: 'east', program: { lots: lots(3, 'e') }, where: { near: { anchor: 'claim_e', within: 8 } } }, { id: 'west', program: { lots: lots(3, 'w') }, where: { near: { anchor: 'claim_w', within: 8 } } }],
    connectors: [{ id: 'road', kind: 'road', from: { part: 'east' }, to: { part: 'west' } }] };

  it('answers the check in region.planned: READY, an artifact by its sha, the light preview only, the class map', async () => {
    const p = (await check(PLAN)) as Planned;
    expect('failed' in p).toBe(false);
    const pc = p.planCheck as Record<string, any>;
    expect(pc.overall).toBe('READY');
    expect(pc.parts.map((a: { part: string; class: string }) => `${a.part}:${a.class}`)).toEqual(['east:fits', 'west:fits', 'road:fits']);
    expect(typeof pc.artifact).toBe('string');
    expect(crypto.createHash('sha256').update(pc.artifact as string).digest('hex')).toBe(pc.artifactSha);
    expect(JSON.parse(pc.artifact as string).region.irSha).toBe(p.irSha);
    expect(Object.keys(p.previews ?? {})).toEqual(['siteplan']);
    expect((p.sitePlan as Record<string, any>).planParts.map((x: { part: string }) => x.part)).toEqual(['east', 'west']);
    expect(fs.existsSync(pc.preview.classMap.path)).toBe(true);
    expect(pc.catalogue.entries.length).toBeGreaterThan(60);
  });

  it('a second check with one zone changed takes the unchanged zone from the owner\'s cache', async () => {
    const changed = structuredClone(PLAN);
    changed.zones[1]!.program.lots.push({ id: 'w4', type: 'smithy', size: [11, 9] });
    const p = (await check(changed)) as Planned;
    const parts = (p.planCheck as Record<string, any>).parts as Array<{ part: string; cached?: boolean }>;
    expect(parts.find((a) => a.part === 'east')!.cached).toBe(true);
    expect(parts.find((a) => a.part === 'west')!.cached).toBeUndefined();
    const dir = sc.regions.planCacheDir('steward_mc:test');
    expect(fs.readdirSync(path.join(dir, 'checks')).length).toBe(2);
  });

  it('the cache keeps an owner\'s newest 256 checks, each at most 24 h', () => {
    const dir = sc.regions.planCacheDir('steward_mc:prune');
    const planDir = tempDir('arch-plan-cache-src-');
    try {
      fs.mkdirSync(path.join(planDir, 'plancache'));
      fs.writeFileSync(path.join(planDir, 'plancache', `${'a'.repeat(64)}.json`), '{}');
      fs.writeFileSync(path.join(dir, 'checks', 'old.json'), JSON.stringify({ at: 1, keys: ['b'.repeat(64)] }));
      fs.writeFileSync(path.join(dir, `${'b'.repeat(64)}.json`), '{}');
      expect(sc.regions.storePlanCache(planDir, dir, 'pnew')).toBe(1);
      expect(fs.existsSync(path.join(dir, `${'a'.repeat(64)}.json`))).toBe(true);
      expect(fs.existsSync(path.join(dir, `${'b'.repeat(64)}.json`)), 'a check older than 24 h is dropped with its entries').toBe(false);
      expect(PLAN_CACHE_CHECKS).toBe(256);
    } finally {
      rmrf(planDir);
    }
  });

  it('a malformed plan answers MALFORMED with no artifact; a lowered heap still plans', async () => {
    const p = (await check({ schemaVersion: 'plan/0', zones: [], stray: 1 }, { heapMb: 512 })) as Planned;
    const pc = p.planCheck as Record<string, any>;
    expect(pc.overall).toBe('MALFORMED');
    expect(pc.malformed.path).toBe('$');
    expect(pc.artifact).toBeUndefined();
    expect(fs.existsSync(path.join(dataDir, 'regions', 'plans', p.planId, 'artifact.json'))).toBe(false);
  });
});
