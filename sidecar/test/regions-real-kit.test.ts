// (6a) Region plans and tiles against the REAL kit (../kit: tools/region.mjs, lib/realise.mjs, regions/mega_bench.mjs),
// when it is there: mega_bench planned twice from a synthetic ARSV survey (the same IR, within the 30 s budget), a
// spread of its tiles streamed through the pool with 1 and 4 workers in forward and shuffled order (the same shas), and
// the pool's bytes checked against the kit's own evalTile called directly in this process on a fresh copy of the IR.
// Skipped without the kit's region engine. Everything the test assumes about the kit is in KIT_SHAPE below.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import type { Outbound, Protocol } from '../src/protocol.js';
import type { ClientHandle } from '../src/server.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { arsv, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

// ARCHITECT_REGION_KIT points it at another kit checkout (e.g. the kit branch's worktree)
const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
/** What the test assumes about the kit (kit/REGIONS.md, CONTRACT §8). */
const KIT_SHAPE = {
  realise: path.join(KIT, 'lib', 'realise.mjs'),
  program: 'mega_bench',
  claim: { minX: 0, minZ: 0, maxX: 999, maxZ: 999, minY: -64, maxY: 319 },
  planBudgetMs: 30_000,
  /** a fixed seed (the IR records it; without one the sidecar picks a random u64) */
  seed: '6',
};
const hasKit = fs.existsSync(KIT_SHAPE.realise) && fs.existsSync(path.join(KIT, 'tools', 'region.mjs')) && fs.existsSync(path.join(KIT, 'regions', `${KIT_SHAPE.program}.mjs`));

/** Gentle synthetic terrain, continuous across the survey and every tile window. */
const groundAt = (x: number, z: number) => 70 + Math.round(6 * Math.sin(x / 97) + 5 * Math.cos(z / 73) + 2 * Math.sin((x + z) / 31));
function survey(): Buffer {
  const c = KIT_SHAPE.claim;
  const res = 4;
  const w = Math.ceil((c.maxX - c.minX + 1) / res);
  const d = Math.ceil((c.maxZ - c.minZ + 1) / res);
  return arsv(c.minX, c.minZ, w, d, (i, j) => groundAt(c.minX + i * res, c.minZ + j * res), res);
}
function heightsOf(key: string): Buffer {
  const [tx, tz] = key.split(',').map(Number) as [number, number];
  return arsv(64 * tx - 8, 64 * tz - 8, 80, 80, (i, j) => groundAt(64 * tx - 8 + i, 64 * tz - 8 + j));
}

type Planned = Extract<Outbound, { type: 'region.planned' }>;
type Tile = { key: string; stage: string; set: 'terrain' | 'path' };

describe.skipIf(!hasKit)('region plans and tiles with the real kit (mega_bench)', () => {
  let root: string;
  const sidecars: Sidecar[] = [];
  const events: Outbound[] = [];

  async function sidecar(workers: number): Promise<Sidecar> {
    const dir = path.join(root, `s${sidecars.length}`);
    const cfg = loadConfig(['--data', path.join(dir, 'data'), '--library', path.join(dir, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    cfg.regions.workers = workers;
    cfg.regions.window = 8;
    const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    sc.subscribe((m) => events.push(m));
    await sc.start(new SimDesigner(sc, 5));
    sidecars.push(sc);
    return sc;
  }

  async function plan(sc: Sidecar): Promise<{ planned: Planned; ms: number }> {
    const surveyBlobId = sc.blobs.putBytes(survey(), 'survey', 'bin');
    const t0 = Date.now();
    let ack: { ok: boolean; error?: string; result?: Record<string, unknown> } | undefined;
    await sc.handle({ v: 1, type: 'region.plan', id: 'p', program: KIT_SHAPE.program, params: {}, seed: KIT_SHAPE.seed, claim: KIT_SHAPE.claim, surveyBlobId } as never, (m) => {
      if (m.type === 'ack') ack = m;
    });
    expect(ack?.ok, ack?.error).toBe(true);
    const planId = ack!.result!.planId as string;
    await until(() => events.some((e) => (e.type === 'region.planned' || e.type === 'region.failed') && e.planId === planId), 120_000, 50);
    const failed = events.find((e) => e.type === 'region.failed' && e.planId === planId);
    expect(failed, failed?.type === 'region.failed' ? failed.message : '').toBeUndefined();
    return { planned: events.find((e): e is Planned => e.type === 'region.planned' && e.planId === planId)!, ms: Date.now() - t0 };
  }

  async function stream(sc: Sidecar, p: Planned, tiles: Tile[]): Promise<Map<string, { sha: string; count: number; payload: Buffer } | string>> {
    const got = new Map<string, { frames: Buffer[]; sha: string; count: number }>();
    const out = new Map<string, { sha: string; count: number; payload: Buffer } | string>();
    const client: ClientHandle = {
      id: 1,
      name: 'test',
      protocol: 2 as Protocol,
      paused: false,
      open: true,
      send(m) {
        const k = 'key' in m ? `${(m as Tile).stage}|${(m as Tile).set}|${(m as Tile).key}` : '';
        if (m.type === 'region.tile') {
          const a = got.get(k) ?? { frames: [], sha: m.sha, count: m.count };
          a.frames[m.seq] = Buffer.from(m.data, 'base64');
          got.set(k, a);
          if (!m.more) out.set(k, { sha: a.sha, count: a.count, payload: zlib.gunzipSync(Buffer.concat(a.frames)) });
        } else if (m.type === 'region.tile.error') out.set(k, m.message);
      },
    };
    for (let i = 0; i < tiles.length; i += 64) {
      const batch = tiles.slice(i, i + 64);
      let ack: { ok: boolean; error?: string } | undefined;
      await sc.handle({ v: 1, type: 'region.tiles.request', id: 't', planId: p.planId, irSha: p.irSha, tiles: batch.map((t) => ({ ...t, heights: heightsOf(t.key).toString('base64') })) } as never, (m) => {
        if (m.type === 'ack') ack = m;
      }, client);
      expect(ack?.ok, ack?.error).toBe(true);
    }
    await until(() => out.size === tiles.length, 120_000, 20);
    return out;
  }

  let planned: Planned;
  let tiles: Tile[];

  beforeAll(async () => {
    root = tempDir('arch-region-realkit-');
  });
  afterAll(async () => {
    for (const sc of sidecars) await sc.close();
    rmrf(root);
  });

  it('plans mega_bench within the budget, and the IR is the same on a second run', async () => {
    const a = await plan(await sidecar(1));
    console.log(`[numbers] real mega_bench plan: ${a.ms} ms round trip (${a.planned.ms} ms in the child), IR ${a.planned.ir ? Buffer.byteLength(a.planned.ir) : `blob ${a.planned.irBlobId}`} bytes, budget ${JSON.stringify(a.planned.budget)}`);
    expect(a.ms).toBeLessThan(KIT_SHAPE.planBudgetMs);
    expect(a.planned.stages.length).toBeGreaterThan(0);
    const b = await plan(sidecars[0]!);
    expect(b.planned.irSha).toBe(a.planned.irSha);
    planned = a.planned;
    const all: Tile[] = [];
    for (const [stage, sets] of Object.entries(planned.tiles as Record<string, { terrain?: string[]; path?: string[] }>))
      for (const set of ['terrain', 'path'] as const) for (const key of sets[set] ?? []) all.push({ key, stage, set });
    expect(all.length).toBeGreaterThan(0);
    // a spread of 24 evaluations across the stages and sets
    const step = Math.max(1, Math.floor(all.length / 24));
    tiles = all.filter((_, i) => i % step === 0).slice(0, 24);
  }, 180_000);

  it('the same tile bytes for 1 and 4 workers, forward and shuffled, and the same as the kit\'s own evalTile', async () => {
    expect(planned, 'the plan test ran first').toBeDefined();
    const one = await stream(sidecars[0]!, planned, tiles);
    const shuffled = [...tiles].reverse();
    for (let i = 0; i < shuffled.length - 1; i += 3) [shuffled[i], shuffled[i + 1]] = [shuffled[i + 1]!, shuffled[i]!];
    const sc4 = await sidecar(4);
    const p4 = (await plan(sc4)).planned;
    expect(p4.irSha).toBe(planned.irSha);
    const four = await stream(sc4, p4, shuffled);
    const errors = [...one.entries()].filter(([, v]) => typeof v === 'string');
    expect(errors, JSON.stringify(errors.slice(0, 3))).toEqual([]);
    for (const [k, v] of one) {
      const w = four.get(k);
      expect(typeof w === 'object' && w.sha, k).toBe(typeof v === 'object' && v.sha);
    }
    // the kit's evalTile, called here on a fresh parse of the IR, gives the bytes the pool streamed
    const realise = (await import(pathToFileURL(KIT_SHAPE.realise).href)) as { evalTile: (ir: unknown, key: string, heights: Uint8Array, o: { stage: string; set: string }) => Promise<{ payload: Uint8Array; sha?: string }> | { payload: Uint8Array; sha?: string } };
    const irJson = planned.ir ?? fs.readFileSync(sidecars[0]!.blobs.file(planned.irBlobId!), 'utf8');
    for (const t of tiles.slice(0, 4)) {
      const r = await realise.evalTile(JSON.parse(irJson), t.key, heightsOf(t.key), { stage: t.stage, set: t.set });
      const mine = one.get(`${t.stage}|${t.set}|${t.key}`) as { sha: string; payload: Buffer };
      expect(Buffer.from(r.payload).equals(mine.payload), `${t.stage}/${t.set}/${t.key}`).toBe(true);
      expect(crypto.createHash('sha256').update(r.payload).digest('hex')).toBe(mine.sha);
    }
  }, 300_000);
});
