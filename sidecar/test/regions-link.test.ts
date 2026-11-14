// (7b LP) region.link with the REAL kit (../kit): a player's program with two site lots (wrap_trunk, on two synthetic trees of a frozen
// volume) and a branch walk between their ports is planned (its IR records portLinks and an empty site_links stage; plan-args kept, outside the plan dir since 7c AU);
// region.link replays it with the bound entries' ports: IR v2 (the link part in site_links, `linked`, the same plan otherwise), its sha
// the ir text's, cached for the tiles; an entry without the port answers noLink {lot, port}; another irSha is refused. Skipped
// without a kit that has the link pass.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import type { Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { sha256 } from '../src/regions.js';
import { rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
const hasLP = fs.existsSync(path.join(KIT, 'lib', 'region', 'links.mjs')) && fs.existsSync(path.join(KIT, 'test', 'lp-world.mjs'));
const G = 64;

const PROGRAM = (kit: string, box: Record<string, number>) => `import { region } from ${JSON.stringify(pathToFileURL(path.join(kit, 'lib', 'region', 'program.mjs')).href)};
export const id = 'lp_link_test';
export const params = {};
const BOX = ${JSON.stringify(box)};
export default function (ctx) {
  const r = region(ctx);
  r.stages(['ground', 'lots', 'props']);
  r.needVolume(BOX);
  const lot = (cx, cz) => [cx - 4, ${G + 13}, cz - 4, cx + 4, ${G + 20}, cz + 4];
  r.siteLot('a', { fit: 'wrap_trunk', box: lot(1030, 2040), stage: 'lots', ports: [{ name: 'walk_e', kind: 'architect:walk', at: [8, 2, 4], facing: 'east', width: 2, height: 2 }] });
  r.siteLot('b', { fit: 'wrap_trunk', box: lot(1050, 2040), stage: 'lots' });
  r.portLink('ab', { kind: 'branch_walk', from: { lot: 'a' }, to: { lot: 'b' } });
  r.anchor('entrance', [BOX.minX + 2, ${G + 1}, BOX.minZ + 2]);
  r.anchor('spawn', [BOX.minX + 2, ${G + 1}, BOX.minZ + 2]);
  return r;
}
`;

type Planned = Extract<Outbound, { type: 'region.planned' }>;

describe.skipIf(!hasLP)('region.link: the realise\'s link pass with the real kit', () => {
  let root: string;
  let sc: Sidecar;
  const events: Outbound[] = [];
  let planned: Planned;

  async function ask(msg: Record<string, unknown>): Promise<{ ok: boolean; error?: string; result?: Record<string, unknown> }> {
    let ack: { ok: boolean; error?: string; result?: Record<string, unknown> } | undefined;
    await sc.handle({ v: 1, id: 'q', ...msg } as never, (m) => {
      if (m.type === 'ack') ack = m;
    });
    return ack!;
  }
  const walk = (name: string, at: number[], facing: string) => ({ name, kind: 'architect:walk', at, facing, width: 2, height: 2 });

  beforeAll(async () => {
    root = tempDir('arch-region-link-');
    const W = (await import(pathToFileURL(path.join(KIT, 'test', 'lp-world.mjs')).href)) as { makeWorld: (o: unknown) => { box: Record<string, number>; vol: { sha: string }; bytes: Uint8Array; survey: Uint8Array; claim: Record<string, number> }; tree: (x: number, z: number, g: number) => unknown[] };
    const world = W.makeWorld({ ground: G, edits: [...W.tree(1030, 2040, G), ...W.tree(1050, 2040, G)] });
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.mkdirSync(cfg.regions.programsDir, { recursive: true });
    fs.writeFileSync(path.join(cfg.regions.programsDir, 'lp.mjs'), PROGRAM(KIT, world.box));
    cfg.regions.workers = 1;
    sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    sc.subscribe((m) => events.push(m));
    await sc.start(new SimDesigner(sc, 5));
    const surveyBlobId = sc.blobs.putBytes(world.survey, 'survey', 'bin');
    const volBlobId = sc.blobs.putBytes(zlib.gzipSync(world.bytes), 'region.blob', 'bin');
    const a = await ask({ type: 'region.plan', program: 'lp.mjs', params: {}, seed: '5', claim: world.claim, surveyBlobId, check: false, volumes: [{ name: 'land', sha: world.vol.sha, blobId: volBlobId, box: world.box }] });
    expect(a.ok, a.error).toBe(true);
    const planId = a.result!.planId as string;
    await until(() => events.some((e) => (e.type === 'region.planned' || e.type === 'region.failed') && e.planId === planId), 600_000, 50);
    const failed = events.find((e) => e.type === 'region.failed' && e.planId === planId);
    expect(failed, failed?.type === 'region.failed' ? failed.message : '').toBeUndefined();
    planned = events.find((e): e is Planned => e.type === 'region.planned' && e.planId === planId)!;
  }, 1_800_000);
  afterAll(async () => {
    await sc?.close();
    rmrf(root);
  });

  it('the plan records its port link and an empty site_links stage, and keeps its arguments', () => {
    const ir = JSON.parse(planned.ir as string) as { portLinks: Array<{ id: string; from: { port: string }; to: { port: string } }>; stages: string[]; parts: Array<{ stage: string }> };
    expect(ir.portLinks.map((l) => [l.id, l.from.port, l.to.port])).toEqual([['ab', 'walk_e', 'walk_w']]);
    expect(ir.stages).toEqual(['ground', 'lots', 'site_links', 'props']);
    expect(ir.parts.filter((p) => p.stage === 'site_links')).toEqual([]);
    expect(fs.existsSync(path.join(sc.regions.argsDir(), `${planned.planId}.json`))).toBe(true); // (7c AU) kept outside the plan dir
    expect(fs.existsSync(path.join(sc.regions.planDir(planned.planId), 'plan-args.json'))).toBe(false);
  });

  it('region.link answers IR v2: the link written in site_links, linked, its sha the text\'s; the tiles resolve it from the cache', async () => {
    const links = { lots: { a: { entry: 'ea', ports: [walk('walk_e', [8, 2, 4], 'east')] }, b: { entry: 'eb', ports: [walk('walk_w', [0, 2, 3], 'west')] } } };
    const r = await ask({ type: 'region.link', planId: planned.planId, irSha: planned.irSha, links });
    expect(r.ok, r.error).toBe(true);
    const res = r.result!;
    expect(res.noLink).toBeUndefined();
    expect(sha256(res.ir as string)).toBe(res.irSha);
    expect(res.irSha).not.toBe(planned.irSha);
    const ir = JSON.parse(res.ir as string) as { parts: Array<{ id: string; stage: string }>; linked: { lots: Record<string, { entry: string }> } };
    expect(ir.parts.filter((p) => p.stage === 'site_links').map((p) => p.id)).toEqual(['link_ab']);
    expect(Object.keys(ir.linked.lots)).toEqual(['a', 'b']);
    const rows = res.links as Array<{ id: string; kind: string; from: { lot: string; port: string; out: number[] }; to: { lot: string; port: string; out: number[] } }>;
    expect(rows.map((x) => [x.id, x.kind, x.from.lot, x.from.port, x.to.lot, x.to.port])).toEqual([['ab', 'branch_walk', 'a', 'walk_e', 'b', 'walk_w']]);
    expect(rows[0]!.from.out).toEqual([1035, G + 15, 2040]);
    expect(rows[0]!.to.out).toEqual([1045, G + 15, 2039]);
    expect(sc.regions.resolveIr(planned.planId, res.irSha as string, undefined)).toBe(res.ir);
  }, 600_000);

  it('an entry without the port answers noLink {lot, port}; another irSha is refused', async () => {
    const r = await ask({ type: 'region.link', planId: planned.planId, irSha: planned.irSha, links: { lots: { a: { entry: 'ea', ports: [walk('walk_e', [8, 2, 4], 'east')] }, b: { entry: 'eb', ports: [] } } } });
    expect(r.ok, r.error).toBe(true);
    expect(r.result!.noLink).toMatchObject({ lot: 'b', port: 'walk_w', code: 'NO_PORT' });
    const bad = await ask({ type: 'region.link', planId: planned.planId, irSha: 'f'.repeat(64), links: { lots: {} } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/IR is not/);
  }, 600_000);
});
