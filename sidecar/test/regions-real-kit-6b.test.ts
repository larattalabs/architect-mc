// (6b) Format-2 IRs through the sidecar with the REAL kit (../kit, or ARCHITECT_REGION_KIT): a player's program that uses a
// side blob (a heightfield) and a format-2 shape (ellipsoid) over two stages is planned (format 2, requires, the side blob
// registered as a region.blob blob), its tiles stream through the pool with the same shas as the kit's own evalTile called
// here on the plan dir's blobs; a fresh sidecar answers ir_unknown, then blob_unknown, then evaluates after the re-send
// with the same shas; ghost tiles match evalTile over the kit's windowFromSurvey (every stage, and up to a stage). The
// check / previews run when the kit has them (else the plan carries a checkError). Skipped without a format-2 kit.
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
import { sha256 } from '../src/regions.js';
import { arsv, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
const REALISE = path.join(KIT, 'lib', 'realise.mjs');
const hasF2 = fs.existsSync(REALISE) && /IR_FORMATS = Object\.freeze\(\[1, 2\]\)/.test(fs.readFileSync(REALISE, 'utf8')) && fs.existsSync(path.join(KIT, 'lib', 'region', 'program.mjs')) && fs.readFileSync(path.join(KIT, 'tools', 'region.mjs'), 'utf8').includes('blobs-out');

const CLAIM = { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 };
const groundAt = (x: number, z: number) => 64 + ((x * 3 + z * 5) % 4);
const survey = () => arsv(CLAIM.minX, CLAIM.minZ, 192, 192, (i, j) => groundAt(i, j));
const heightsOf = (key: string) => {
  const [tx, tz] = key.split(',').map(Number) as [number, number];
  return arsv(64 * tx - 8, 64 * tz - 8, 80, 80, (i, j) => groundAt(64 * tx - 8 + i, 64 * tz - 8 + j));
};

/** A player's program: a heightfield mound from a side blob (stage ground), an ellipsoid on it (stage top). */
const PROGRAM = (kit: string) => `import { region } from ${JSON.stringify(pathToFileURL(path.join(kit, 'lib', 'region', 'program.mjs')).href)};
export const id = 'f2_test';
export const params = {};
export default function (ctx) {
  const r = region(ctx);
  r.stages(['ground', 'top']);
  const w = 48, d = 48;
  const vals = new Uint8Array(w * d * 2);
  for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) { const v = 4 + ((i * 7 + j * 3) % 9); vals[2 * (i + j * w)] = v; }
  r.blob('mound', { minX: 40, minZ: 40, width: w, depth: d, values: vals, kind: 'heightfield' });
  r.part('mound', { stage: 'ground' }).fill({ kind: 'heightfield', blob: 'mound', scale: 1, y0: { abs: 64 } }, 'minecraft:stone', { cond: 3 });
  r.part('egg', { stage: 'top' }).fill({ kind: 'ellipsoid', c: [64, { abs: 84 }, 64], r: [10, 6, 12] }, 'minecraft:andesite', { cond: 3 });
  r.anchor('entrance', [10, 10]);
  r.anchor('spawn', [12, 10]);
  return r;
}
`;

type Planned = Extract<Outbound, { type: 'region.planned' }>;
type Got = Map<string, { sha: string; count: number; preview?: boolean } | string>;

describe.skipIf(!hasF2)('format-2 IRs with the real kit: side blobs, blob_unknown, ghost tiles', () => {
  let root: string;
  const sidecars: Sidecar[] = [];
  const events: Outbound[] = [];
  let planned: Planned;
  let realise: { evalTile: (ir: unknown, key: string, h: unknown, o?: Record<string, unknown>) => { payload: Uint8Array; sha: string; count: number } };
  let surveyLib: { windowFromSurvey: (s: Uint8Array, key: string) => unknown };

  async function sidecar(name: string): Promise<Sidecar> {
    const dir = path.join(root, name);
    const cfg = loadConfig(['--data', path.join(dir, 'data'), '--library', path.join(dir, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.mkdirSync(cfg.regions.programsDir, { recursive: true });
    fs.writeFileSync(path.join(cfg.regions.programsDir, 'f2.mjs'), PROGRAM(KIT));
    cfg.regions.workers = 2;
    const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    sc.subscribe((m) => events.push(m));
    await sc.start(new SimDesigner(sc, 5));
    sidecars.push(sc);
    return sc;
  }

  async function ask(sc: Sidecar, msg: Record<string, unknown>, client?: ClientHandle): Promise<{ ok: boolean; error?: string; result?: Record<string, unknown> }> {
    let ack: { ok: boolean; error?: string; result?: Record<string, unknown> } | undefined;
    await sc.handle({ v: 1, id: 'q', ...msg } as never, (m) => {
      if (m.type === 'ack') ack = m;
    }, client);
    return ack!;
  }

  function client(got: Got): ClientHandle {
    const frames = new Map<string, Buffer[]>();
    return {
      id: Math.floor(Math.random() * 1e9),
      name: 'test',
      protocol: 2 as Protocol,
      paused: false,
      open: true,
      send(m) {
        if (m.type !== 'region.tile' && m.type !== 'region.tile.error') return;
        const k = `${m.stage}|${m.set}|${m.key}`;
        if (m.type === 'region.tile.error') return void got.set(k, m.message);
        const f = frames.get(k) ?? [];
        f[m.seq] = Buffer.from(m.data, 'base64');
        frames.set(k, f);
        if (!m.more) {
          const payload = zlib.gunzipSync(Buffer.concat(f));
          expect(sha256(payload)).toBe(m.sha);
          got.set(k, { sha: m.sha, count: m.count, ...(m.preview ? { preview: true } : {}) });
        }
      },
    };
  }

  const tilesOf = (p: Planned) => {
    const out: Array<{ key: string; stage: string; set: 'terrain' | 'path' }> = [];
    for (const [stage, sets] of Object.entries(p.tiles as Record<string, { terrain: string[]; path: string[] }>)) for (const set of ['terrain', 'path'] as const) for (const key of sets[set]) out.push({ key, stage, set });
    return out;
  };

  beforeAll(async () => {
    root = tempDir('arch-region-f2-');
    realise = (await import(pathToFileURL(REALISE).href)) as typeof realise;
    surveyLib = (await import(pathToFileURL(path.join(KIT, 'lib', 'region', 'survey.mjs')).href)) as typeof surveyLib;
    const sc = await sidecar('a');
    const surveyBlobId = sc.blobs.putBytes(survey(), 'survey', 'bin');
    const a = await ask(sc, { type: 'region.plan', program: 'f2.mjs', params: {}, seed: '9', claim: CLAIM, surveyBlobId });
    expect(a.ok, a.error).toBe(true);
    const planId = a.result!.planId as string;
    await until(() => events.some((e) => (e.type === 'region.planned' || e.type === 'region.failed') && e.planId === planId), 120_000, 50);
    const failed = events.find((e) => e.type === 'region.failed' && e.planId === planId);
    expect(failed, failed?.type === 'region.failed' ? failed.message : '').toBeUndefined();
    planned = events.find((e): e is Planned => e.type === 'region.planned' && e.planId === planId)!;
  }, 180_000);
  afterAll(async () => {
    for (const sc of sidecars) await sc.close();
    rmrf(root);
  });

  /** The kit's own evalTile in this process, with the plan dir's blobs. */
  function direct(key: string, stage: string | null, set: string | null, heights: unknown, irObj?: Record<string, unknown>): { sha: string; count: number } {
    const dir = sidecars[0]!.regions.planDir(planned.planId);
    const blobs = new Map(planned.blobs!.map((b) => [b.sha, new Uint8Array(fs.readFileSync(path.join(dir, 'blobs', `${b.sha}.bin`)))]));
    const ir = irObj ?? (JSON.parse(planned.ir!) as Record<string, unknown>);
    const r = realise.evalTile(ir, key, heights, { ...(stage ? { stage } : {}), ...(set ? { set } : {}), blobs: (s: string) => blobs.get(s) });
    return { sha: r.sha, count: r.count };
  }

  it('plans a format-2 IR: irFormat 2, requires, the side blob registered; check/previews or a checkError', () => {
    expect(planned.irFormat).toBe(2);
    expect(planned.requires).toEqual(expect.arrayContaining(['blobs:side', 'shape:ellipsoid']));
    expect(planned.kitVersion).toBe('0.12.0');
    expect(planned.blobs).toHaveLength(1);
    const b = planned.blobs![0]!;
    expect(b).toMatchObject({ name: 'mound', kind: 'heightfield' });
    const sc = sidecars[0]!;
    expect(sc.blobs.get(b.blobId)).toMatchObject({ kind: 'region.blob', size: b.bytes });
    expect(sha256(sc.blobs.read(b.blobId))).toBe(b.sha);
    if (sc.regions.kitInfo().caps.check) expect(planned.report).toBeDefined();
    else expect(planned.checkError).toMatch(/no checker/);
    expect(sc.snapshot(2)).toMatchObject({ kitVersion: '0.12.0', irFormats: [1, 2] });
  });

  it('streams its tiles with the same shas as the kit evaluating them here', async () => {
    const tiles = tilesOf(planned);
    expect(tiles.length).toBeGreaterThan(0);
    const got: Got = new Map();
    const a = await ask(sidecars[0]!, { type: 'region.tiles.request', planId: planned.planId, irSha: planned.irSha, tiles: tiles.map((t) => ({ ...t, heights: heightsOf(t.key).toString('base64') })) }, client(got));
    expect(a.ok, a.error).toBe(true);
    await until(() => got.size === tiles.length, 60_000);
    let cells = 0;
    for (const t of tiles) {
      const g = got.get(`${t.stage}|${t.set}|${t.key}`)!;
      expect(typeof g, String(g)).toBe('object');
      const want = direct(t.key, t.stage, t.set, heightsOf(t.key));
      expect((g as { sha: string }).sha).toBe(want.sha);
      cells += want.count;
    }
    expect(cells).toBeGreaterThan(0);
  });

  it('a fresh sidecar: ir_unknown, blob_unknown <sha>, then the re-send gives the same tiles', async () => {
    const fresh = await sidecar('b');
    const t = tilesOf(planned).find((x) => x.stage === 'ground')!;
    const req = { type: 'region.tiles.request', planId: planned.planId, irSha: planned.irSha, tiles: [{ ...t, heights: heightsOf(t.key).toString('base64') }] };
    const got: Got = new Map();
    const c = client(got);
    expect(await ask(fresh, req, c)).toMatchObject({ ok: false, error: 'ir_unknown' });
    const b = planned.blobs![0]!;
    expect(await ask(fresh, { ...req, ir: planned.ir }, c)).toMatchObject({ ok: false, error: `blob_unknown ${b.sha}` });
    const id = fresh.blobs.put({ kind: 'region.blob', chunks: [sidecars[0]!.blobs.read(b.blobId).toString('base64')] }).blobId;
    expect(await ask(fresh, { ...req, blobs: { [b.sha]: id } }, c)).toMatchObject({ ok: true });
    await until(() => got.size === 1, 30_000);
    expect((got.values().next().value as { sha: string }).sha).toBe(direct(t.key, t.stage, t.set, heightsOf(t.key)).sha);
  });

  it('ghost tiles: evalTile over windowFromSurvey, every stage or up to one', async () => {
    const keys = [...new Set(tilesOf(planned).map((t) => t.key))];
    const got: Got = new Map();
    const req = { type: 'region.tiles.request', planId: planned.planId, irSha: planned.irSha, preview: true, tiles: keys.flatMap((key) => [{ key }, { key, stage: 'ground' }]) };
    expect((await ask(sidecars[0]!, req, client(got))).ok).toBe(true);
    await until(() => got.size === keys.length * 2, 60_000);
    const ir = JSON.parse(planned.ir!) as { parts: Array<{ stage: string }> } & Record<string, unknown>;
    const groundOnly = { ...ir, parts: ir.parts.filter((p) => p.stage === 'ground') };
    const s = new Uint8Array(survey());
    for (const key of keys) {
      const all = got.get(`*|*|${key}`) as { sha: string; preview?: boolean };
      const ground = got.get(`ground|*|${key}`) as { sha: string };
      expect(all.preview).toBe(true);
      expect(all.sha).toBe(direct(key, null, null, surveyLib.windowFromSurvey(s, key)).sha);
      expect(ground.sha).toBe(direct(key, null, null, surveyLib.windowFromSurvey(s, key), groundOnly).sha);
    }
  });
});
