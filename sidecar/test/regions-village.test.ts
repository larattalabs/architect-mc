// (6c V) region.plan's keepOut and flat_village through the sidecar with the REAL kit: the owner's protected rects reach the plan
// CLI (--keep-out, keepout.json in the plan dir), the IR records the honoured rects, the plan routes around them, the lots param
// passes through, and siteplan.json carries the IR's graph (derived: false) and `unplaced`. Skipped without the kit's program.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import type { Outbound } from '../src/protocol.js';
import { RegionPlanMsg } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { arsv, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'regions', 'flat_village.mjs'));
const CLAIM = { minX: 0, minZ: 0, maxX: 111, maxZ: 111, minY: -64, maxY: 319 };
const LOTS = [
  { id: 'hall_1', type: 'hall', size: [18, 20], landmark: true, villager: 'job' },
  { id: 'trading_hall_1', type: 'trading_hall', size: [14, 17], villager: 'trading_hall' },
  { id: 'cottage_1', type: 'cottage', size: [11, 14] },
  { id: 'cottage_2', type: 'cottage', size: [11, 14] },
  { id: 'keep_1', type: 'keep', size: [96, 60] },
];
type Planned = Extract<Outbound, { type: 'region.planned' }>;

describe('region.plan keepOut (protocol)', () => {
  it('accepts [[x0, z0, x1, z1]] rects and refuses a bad one', () => {
    const base = { v: 1, type: 'region.plan', id: 'p', program: 'flat_village', params: {}, claim: CLAIM, surveyBlobId: 'b'.repeat(16) };
    expect(RegionPlanMsg.safeParse({ ...base, keepOut: [[0, 0, 10, 10]] }).success).toBe(true);
    expect(RegionPlanMsg.safeParse({ ...base, keepOut: [[10, 0, 0, 10]] }).success).toBe(false);
    expect(RegionPlanMsg.safeParse({ ...base, keepOut: [[0, 0, 10]] }).success).toBe(false);
    expect(RegionPlanMsg.safeParse({ ...base, keepOut: Array.from({ length: 1025 }, () => [0, 0, 1, 1]) }).success).toBe(false);
  });
});

describe.skipIf(!hasKit)('flat_village through the sidecar (real kit)', () => {
  let root: string;
  let sc: Sidecar;
  let dataDir: string;
  const events: Outbound[] = [];
  beforeAll(async () => {
    root = tempDir('arch-region-village-');
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

  async function plan(extra: Record<string, unknown>): Promise<Planned> {
    const surveyBlobId = sc.blobs.putBytes(arsv(0, 0, 112, 112, () => 64), 'survey', 'bin');
    let ack: { ok: boolean; error?: string; result?: Record<string, unknown> } | undefined;
    await sc.handle({ v: 1, type: 'region.plan', id: 'p', program: 'flat_village', params: { lots: LOTS }, seed: '7', claim: CLAIM, surveyBlobId, ...extra } as never, (m) => {
      if (m.type === 'ack') ack = m;
    });
    expect(ack?.ok, ack?.error).toBe(true);
    const planId = ack!.result!.planId as string;
    await until(() => events.some((e) => (e.type === 'region.planned' || e.type === 'region.failed') && e.planId === planId), 120_000, 50);
    const failed = events.find((e) => e.type === 'region.failed' && e.planId === planId);
    expect(failed, failed?.type === 'region.failed' ? failed.message : '').toBeUndefined();
    return events.find((e): e is Planned => e.type === 'region.planned' && e.planId === planId)!;
  }

  it('passes keepOut to the plan CLI; the IR records it and nothing is planned inside it', async () => {
    const ko = [[0, 0, 111, 36]];
    const p = await plan({ keepOut: ko });
    const dir = path.join(dataDir, 'regions', 'plans', p.planId);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'keepout.json'), 'utf8'))).toEqual(ko);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8')).keepOut).toEqual(ko);
    const ir = JSON.parse(p.ir ?? fs.readFileSync(sc.blobs.file(p.irBlobId!), 'utf8'));
    expect(ir.keepOut).toEqual(ko);
    for (const l of ir.lots) expect(l.box.minZ).toBeGreaterThan(36);
    expect(ir.graph.nodes.some((n: { kind: string }) => n.kind === 'plaza')).toBe(true);
    expect(p.notes).toContain('unplaced: keep_1');
    const site = p.sitePlan as { graph: { derived: boolean }; unplaced: { id: string }[] } | undefined;
    expect(site?.graph.derived).toBe(false);
    expect(site?.unplaced.map((u) => u.id)).toEqual(['keep_1']);
  }, 180_000);

  it('without keepOut the program records an empty honoured set', async () => {
    const p = await plan({ check: false });
    const ir = JSON.parse(p.ir ?? fs.readFileSync(sc.blobs.file(p.irBlobId!), 'utf8'));
    expect(ir.keepOut).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, 'regions', 'plans', p.planId, 'keepout.json'))).toBe(false);
  }, 180_000);
});
