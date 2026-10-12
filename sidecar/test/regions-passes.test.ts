// (6c T1) Plan-time passes through the sidecar (docs/CONTRACT.md "Phase 6c slice T1" §1-§3): a program's declared passes read
// from its source pick the pass budget (regionPassPlanMs 120 s, regionPassPlanHeapMb 2 GB; 6a's 30 s / 1 GB otherwise), the
// request and region.planned carry them (the kit's word, for the game's resolution-1 second survey), and the pass timings reach the
// plan notes, plan.json and siteplan.json. relief_demo with the REAL kit; skipped without it.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import type { Outbound } from '../src/protocol.js';
import { FEATURES } from '../src/protocol.js';
import { declaredPasses } from '../src/regions.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { arsv, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

// the repo kit's KIT_VERSION (later slices bump it; 6c B: 0.23.0)
const KIT_VERSION_UNDER_TEST = /export const KIT_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(SIDECAR_ROOT, '..', 'kit', 'lib', 'region', 'plan.mjs'), 'utf8'))![1];

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'regions', 'relief_demo.mjs'));
const CLAIM = { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 };
type Planned = Extract<Outbound, { type: 'region.planned' }>;

describe('declared passes and the pass budget', () => {
  it('reads `export const passes = [...]` from a program source', () => {
    expect(declaredPasses("export const id = 'x';\nexport const passes = ['relief'];\n")).toEqual(['relief']);
    expect(declaredPasses('export const passes = ["relief", "route"];')).toEqual(['relief', 'route']);
    expect(declaredPasses('  export const passes = [\n  \'relief\',\n];')).toEqual(['relief']);
    expect(declaredPasses("export const id = 'x';\n// export const passes = ['relief'] would go here\n")).toEqual([]);
    expect(declaredPasses("const passes = ['relief'];")).toEqual([]);
    expect(declaredPasses('export const passes = [];')).toEqual([]);
  });

  it('defaults to 120 s and 2 GB for programs with passes; 30 s and 1 GB stay for the rest', () => {
    const root = tempDir('arch-passes-cfg-');
    try {
      const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT], {});
      expect(cfg.regions.passPlanMs).toBe(120_000);
      expect(cfg.regions.passPlanHeapMb).toBe(2048);
      expect(cfg.regions.planMs).toBe(30_000);
      expect(cfg.regions.planHeapMb).toBe(1024);
    } finally {
      rmrf(root);
    }
  });

  it('lists region.passes after the 0.19.0 features (later slices append after it)', () => {
    expect(FEATURES.indexOf('region.passes')).toBe(FEATURES.indexOf('patterns') + 1);
  });
});

describe.skipIf(!hasKit)('relief_demo through the sidecar (real kit)', () => {
  let root: string;
  let sc: Sidecar;
  let dataDir: string;
  let log: ReturnType<typeof memoryLogger>;
  const events: Outbound[] = [];
  beforeAll(async () => {
    root = tempDir('arch-region-passes-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    dataDir = cfg.dataDir;
    log = memoryLogger();
    sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), log);
    sc.subscribe((m) => events.push(m));
    await sc.start(new SimDesigner(sc, 5));
  });
  afterAll(async () => {
    await sc?.close();
    rmrf(root);
  });

  async function plan(program: string, params: Record<string, unknown> = {}): Promise<Planned> {
    const surveyBlobId = sc.blobs.putBytes(arsv(0, 0, 192, 192, () => 64), 'survey', 'bin');
    let ack: { ok: boolean; error?: string; result?: Record<string, unknown> } | undefined;
    await sc.handle({ v: 1, type: 'region.plan', id: 'p', program, params, seed: '7', claim: CLAIM, surveyBlobId } as never, (m) => {
      if (m.type === 'ack') ack = m;
    });
    expect(ack?.ok, ack?.error).toBe(true);
    const planId = ack!.result!.planId as string;
    await until(() => events.some((e) => (e.type === 'region.planned' || e.type === 'region.failed') && e.planId === planId), 180_000, 50);
    const failed = events.find((e) => e.type === 'region.failed' && e.planId === planId);
    expect(failed, failed?.type === 'region.failed' ? failed.message : '').toBeUndefined();
    return events.find((e): e is Planned => e.type === 'region.planned' && e.planId === planId)!;
  }

  it('plans with the pass budget; the request, region.planned, plan.json, the notes and siteplan.json carry the passes', async () => {
    const p = await plan('relief_demo');
    expect(p.passes).toEqual(['relief']);
    expect(p.requires).toContain('relief');
    expect(p.kitVersion).toBe(KIT_VERSION_UNDER_TEST);
    expect(p.notes.some((n) => /^pass relief: \d+\.\d s, \d+ MB$/.test(n))).toBe(true);
    const dir = path.join(dataDir, 'regions', 'plans', p.planId);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8')).passes).toEqual(['relief']);
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
    expect(pj.passes).toEqual(['relief']);
    expect(pj.passRuns[0]).toMatchObject({ name: 'relief' });
    expect(pj.passRuns[0].ms).toBeGreaterThanOrEqual(0);
    expect(p.sitePlan?.passes).toEqual([expect.objectContaining({ name: 'relief' })]);
    expect(log.lines.some((l) => /passes relief \(120 s, 2048 MB\)/.test(l))).toBe(true);
  });

  it('a program without passes plans as before: no passes, 6a\'s budget', async () => {
    const p = await plan('flat_village', { lots: [{ id: 'cottage_1', type: 'cottage', size: [11, 14] }] });
    expect(p.passes).toBeUndefined();
    expect(p.requires).not.toContain('relief');
    const dir = path.join(dataDir, 'regions', 'plans', p.planId);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8')).passes).toBeUndefined();
    expect(sc.regions.planBudget([])).toEqual({ timeoutMs: 30_000, heapMb: 1024 });
    expect(sc.regions.planBudget(['relief'])).toEqual({ timeoutMs: 120_000, heapMb: 2048 });
  });
});
