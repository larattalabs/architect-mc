// (6c VOC-c) rule.palette through the sidecar (docs/CONTRACT.md "Phase 6c slice VOC-c" §4, §6): a check's `lotBlocks` (the mod's
// histograms of the lots whose entry the plan names) validated by the protocol, written for the plan CLI as --lot-blocks and measured by
// the REAL kit (the bound lot in the rule's `measured`, the artifact's palette row); vocab/1's groups and compact.palette in both forms;
// the feature plan.rules. Skipped without the kit.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { expandSystemRefs } from '../src/jobs/systemrefs.js';
import type { Outbound } from '../src/protocol.js';
import { FEATURES, parseClientMessage } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { arsv, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'regions', 'plan_v0.mjs'));
const CLAIM = { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 };
type Planned = Extract<Outbound, { type: 'region.planned' }>;
/* eslint-disable @typescript-eslint/no-explicit-any */

describe('(6c VOC-c) the protocol and the feature', () => {
  const base = { v: 1, type: 'region.plan', id: 'x', program: 'plan_v0', claim: CLAIM, surveyBlobId: 'b'.repeat(16), params: {} };
  it('takes lotBlocks {lot: {block: n}} and refuses a malformed one', () => {
    expect(parseClientMessage(JSON.stringify({ ...base, lotBlocks: { hall: { 'minecraft:copper_block': 46, 'minecraft:cut_copper': 82 } } })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ ...base, lotBlocks: { hall: { 'minecraft:copper_block': 0 } } })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ ...base, lotBlocks: { Hall: { 'minecraft:copper_block': 1 } } })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ ...base, lotBlocks: { hall: { copper_block: 1 } } })).ok).toBe(false);
  });
  it('lists plan.rules after the earlier features (appended; 6c RS appends region.survival after it)', () => {
    expect(FEATURES.indexOf('plan.rules')).toBe(FEATURES.indexOf('reserved') + 1);
  });
});

describe.skipIf(!hasKit)('(6c VOC-c) vocab/1: groups and compact.palette', () => {
  it('both forms carry the wood group (the 13 woods) and the compact form the palette note', async () => {
    const full = JSON.parse((await expandSystemRefs(KIT, ['vocab/1'])).split('\n\n').slice(1).join('\n\n'));
    const compact = JSON.parse((await expandSystemRefs(KIT, ['vocab/1#compact'])).split('\n\n').slice(1).join('\n\n'));
    // the full form drops `compact`, the compact form drops `blocks` (systemrefs.ts): the top-level groups are in both, and the compact
    // member holds them again with its palette note
    for (const d of [full, compact, compact.compact]) expect(d.groups.wood).toEqual(['acacia', 'bamboo', 'birch', 'cherry', 'crimson', 'dark_oak', 'jungle', 'mangrove', 'oak', 'pale_oak', 'poplar', 'spruce', 'warped']);
    expect(full.compact).toBeUndefined();
    expect(compact.compact.palette).toMatch(/rule\.palette \{family, share\}/);
  });
});

describe.skipIf(!hasKit)('(6c VOC-c) a palette check through the sidecar (real kit)', () => {
  let root: string;
  let sc: Sidecar;
  const events: Outbound[] = [];
  beforeAll(async () => {
    root = tempDir('arch-vocc-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    sc.subscribe((m) => events.push(m));
    await sc.start(new SimDesigner(sc, 5));
  });
  afterAll(async () => {
    await sc?.close();
    rmrf(root);
  });

  async function check(plan: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Planned> {
    const surveyBlobId = sc.blobs.putBytes(arsv(0, 0, 192, 192, () => 64), 'survey', 'bin');
    let ack: { ok: boolean; error?: string; result?: Record<string, unknown> } | undefined;
    const params = { plan, anchors: { anchors: { stone: [96, 65, 96] } }, protected: { areas: [] }, regions: { regions: [] }, budget: {}, bible: null, fingerprint: { sha: 'f'.repeat(64) } };
    await sc.handle({ v: 1, type: 'region.plan', id: 'p', program: 'plan_v0', params, claim: CLAIM, surveyBlobId, planCache: 'steward_mc:vocc', previewViews: ['siteplan'], ...extra } as never, (m) => {
      if (m.type === 'ack') ack = m;
    });
    expect(ack?.ok, ack?.error).toBe(true);
    const planId = ack!.result!.planId as string;
    await until(() => events.some((e) => (e.type === 'region.planned' || e.type === 'region.failed') && e.planId === planId), 180_000, 50);
    const failed = events.find((e) => e.type === 'region.failed' && e.planId === planId);
    expect(failed, failed?.type === 'region.failed' ? failed.message : '').toBeUndefined();
    return events.find((e): e is Planned => e.type === 'region.planned' && e.planId === planId)!;
  }

  // a lot bound to an entry, under a rule over its zone that counts the lot only (exempt both; the zone writes lanterns and paths)
  const PLAN = { schemaVersion: 'plan/0', zones: [{ id: 'town', program: { lots: [{ id: 'hall', type: 'house', size: [9, 11], entry: 'cabin' }], shared: 'none' }, where: { near: { anchor: 'stone', within: 16 } } }],
    rules: [{ id: 'copperish', kind: 'palette', family: 'copper', share: [0, 1], scope: ['town'] }] };
  const LOT = { 'minecraft:copper_block': 46, 'minecraft:cut_copper': 82, 'minecraft:oak_door': 2, 'minecraft:dirt': 9 };

  it('lotBlocks reach the plan CLI (lotblocks.json, --lot-blocks) and the kit measures the bound lot from them', async () => {
    const p = await check(PLAN, { lotBlocks: { hall: LOT } });
    const pc = p.planCheck as Record<string, any>;
    const a = pc.parts.find((x: { part: string }) => x.part === 'copperish');
    expect(a.class).toBe('fits');
    // dirt is a common natural block: not measured; 130 cells, 128 copper
    expect(a.measured.lots).toEqual({ hall: [128, 130] });
    expect(a.measured.pendingLots).toEqual([]);
    const art = JSON.parse(pc.artifact as string);
    expect(art.palette.map((r: { rule: string }) => r.rule)).toEqual(['copperish']);
    expect(art.palette[0].lotCounts).toEqual({ hall: [128, 130] });
    const dir = path.join(root, 'data', 'regions', 'plans', p.planId);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'lotblocks.json'), 'utf8'))).toEqual({ hall: LOT });
  });

  it('without lotBlocks the named lot is pending (measured at realiseApproved)', async () => {
    const p = await check(PLAN);
    const a = (p.planCheck as Record<string, any>).parts.find((x: { part: string }) => x.part === 'copperish');
    expect(a.measured.pendingLots).toEqual(['hall']);
    expect(fs.existsSync(path.join(root, 'data', 'regions', 'plans', p.planId, 'lotblocks.json'))).toBe(false);
  });
});
