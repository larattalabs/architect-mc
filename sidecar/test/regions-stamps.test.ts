// (6c F2) The local stamp library through the sidecar with the REAL kit (N-F2-1: stamps are local-only, `<game>/architect/stamps`,
// the dir beside the library): the plan CLI gets `--stamps <dir>` and reads it inside the plan sandbox, so a plan that names a stamp
// embeds it (requires `stamp`); without the dir the plan says the stamp is not in the library and falls back. The stamps here are the
// kit's synthetic ones (lib/region/stamps.mjs syntheticStamp: no vanilla data in the repo). Skipped without the kit's program.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import type { Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { arsv, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'regions', 'scatter_demo.mjs')) && fs.existsSync(path.join(KIT, 'lib', 'region', 'stamps.mjs'));
const CLAIM = { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 };
type Planned = Extract<Outbound, { type: 'region.planned' }>;

describe.skipIf(!hasKit)('the local stamp library through the sidecar (real kit)', () => {
  let root: string;
  let sc: Sidecar;
  const events: Outbound[] = [];
  beforeAll(async () => {
    root = tempDir('arch-region-stamps-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    expect(cfg.regions.stampsDir).toBe(path.join(root, 'stamps'));
    sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    sc.subscribe((m) => events.push(m));
    await sc.start(new SimDesigner(sc, 5));
  });
  afterAll(async () => {
    await sc?.close();
    rmrf(root);
  });

  async function plan(): Promise<Planned> {
    const surveyBlobId = sc.blobs.putBytes(arsv(0, 0, 192, 192, () => 64), 'survey', 'bin');
    let ack: { ok: boolean; error?: string; result?: Record<string, unknown> } | undefined;
    await sc.handle({ v: 1, type: 'region.plan', id: 'p', program: 'scatter_demo', params: {}, seed: '7', claim: CLAIM, surveyBlobId } as never, (m) => {
      if (m.type === 'ack') ack = m;
    });
    expect(ack?.ok, ack?.error).toBe(true);
    const planId = ack!.result!.planId as string;
    await until(() => events.some((e) => (e.type === 'region.planned' || e.type === 'region.failed') && e.planId === planId), 120_000, 50);
    const failed = events.find((e) => e.type === 'region.failed' && e.planId === planId);
    expect(failed, failed?.type === 'region.failed' ? failed.message : '').toBeUndefined();
    return events.find((e): e is Planned => e.type === 'region.planned' && e.planId === planId)!;
  }

  it('without the dir: the plan notes the missing stamps and needs no stamp kind', async () => {
    const p = await plan();
    expect(p.requires).not.toContain('stamp');
    expect(p.notes.some((n) => /not in the local stamp library/.test(n))).toBe(true);
  });

  it('with <game>/architect/stamps: the plan CLI reads it in its sandbox and embeds the stamps', async () => {
    const { syntheticStamp } = (await import(pathToFileURL(path.join(KIT, 'lib', 'region', 'stamps.mjs')).href)) as { syntheticStamp: (k: string, s: number) => Uint8Array };
    for (const [id, kind, seed] of [['oak/1', 'tree', 1], ['birch/1', 'tree', 2], ['spruce/1', 'tree', 3], ['acacia/1', 'tree', 4], ['dark_oak/1', 'tree', 5], ['huge_brown_mushroom/1', 'mushroom', 1], ['huge_red_mushroom/1', 'mushroom', 2], ['fossil_coal/1', 'mushroom', 3]] as const) {
      const [f, s] = id.split('/');
      fs.mkdirSync(path.join(root, 'stamps', f!), { recursive: true });
      fs.writeFileSync(path.join(root, 'stamps', f!, `${s}.bin`), syntheticStamp(kind, seed));
    }
    const p = await plan();
    expect(p.requires).toContain('stamp');
    expect(p.notes.filter((n) => /not in the local stamp library/.test(n))).toEqual([]);
    expect((p.blobs ?? []).some((b) => b.name.startsWith('stamp_oak_1'))).toBe(true);
  });
});
