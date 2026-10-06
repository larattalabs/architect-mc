// Phase 5a: bible format 2 and restraint, library hygiene (archive, delete, version GC), the sheet critique, job.images,
// and a massing critique (docs/CONTRACT.md "Bible-set clutter", "Images in jobs", "Phase 5a gate" item 1).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { restraintOf } from '../src/bibles.js';
import { DesignRequest, JobSpec, type Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.resolve(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'build.mjs'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

interface H {
  sc: Sidecar;
  events: Outbound[];
  close(): Promise<void>;
}

async function harness(over: Partial<Config> = {}): Promise<H> {
  const root = tempDir('arch-5a-b-');
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
  cfg.simStepMs = 15;
  cfg.simDesignUsd = 0.1;
  cfg.jobs.simStepUsd = 0.01;
  Object.assign(cfg, over);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
  const events: Outbound[] = [];
  sc.subscribe((m) => events.push(m));
  await sc.start(new SimDesigner(sc, cfg.simStepMs));
  return { sc, events, close: async () => {
    await sc.close();
    rmrf(root);
  } };
}

/** A hand-made installed bible version (format 1 unless `extra` says otherwise). */
function installFake(sc: Sidecar, id: string, v: number, extra: Record<string, unknown> = {}, createdAt = Date.now()): void {
  const dir = path.join(sc.config.biblesDir, id, 'versions', String(v));
  fs.mkdirSync(dir, { recursive: true });
  const j = { id, version: v, name: id, roles: { wall: 'minecraft:stone' }, motifs: ['a', 'b', 'c', 'd'], components: ['window'], createdAt, ...extra };
  fs.writeFileSync(path.join(dir, 'bible.json'), JSON.stringify(j));
  fs.writeFileSync(path.join(sc.config.biblesDir, id, 'bible.json'), JSON.stringify(j));
}

function fakeEntry(sc: Sidecar, entry: string, bible: { id: string; version: number }): void {
  const dir = path.join(sc.config.libraryDir, entry);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${entry}.blueprint.json`), JSON.stringify({ id: entry, bible }));
}

describe('restraint (pure)', () => {
  it('format 1 reads with defaults (hero motifs = the first 3); format 2 keeps its own, clamped', () => {
    expect(restraintOf({ motifs: ['a', 'b', 'c', 'd'] })).toEqual({ heroMotifs: ['a', 'b', 'c'], accentShareMax: 0.12, detailDensity: 'moderate', windowsPerFacadeMin: 2 });
    expect(restraintOf({ format: 2, motifs: ['a', 'b'], restraint: { heroMotifs: ['b'], accentShareMax: 0.08, detailDensity: 'sparse', windowsPerFacadeMin: 3 } })).toEqual({ heroMotifs: ['b'], accentShareMax: 0.08, detailDensity: 'sparse', windowsPerFacadeMin: 3 });
    expect(restraintOf({ format: 2, motifs: [], restraint: { accentShareMax: 0.9, detailDensity: 'loud' } })).toMatchObject({ accentShareMax: 0.12, detailDensity: 'moderate' });
  });
});

describe.skipIf(!hasKit)('bibles in 5a (sim backend, real kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('a new bible is format 2 with a restraint; with critique report the sheet is critiqued and stored in bible.json', async () => {
    h = await harness();
    const j = h.sc.bibles.request({ prompt: 'sim:critique=6 weathered fishing village', name: 'Mossy', critique: { mode: 'report' } });
    await until(() => ['done', 'failed'].includes(h!.sc.bibles.get(j.id)!.status), 30_000);
    const done = h.sc.bibles.get(j.id)!;
    expect(done.status, done.error).toBe('done');
    const bible = JSON.parse(fs.readFileSync(path.join(h.sc.config.biblesDir, j.bibleId, 'bible.json'), 'utf8')) as Record<string, unknown>;
    expect(bible).toMatchObject({ format: 2, restraint: { heroMotifs: ['chain lanterns'], accentShareMax: 0.12, detailDensity: 'moderate', windowsPerFacadeMin: 2 }, critique: { overall: 6, ship: false } });
    expect((bible.critique as { scores: Record<string, number> }).scores).toEqual({ legibility: 6, restraint: 6, craft: 6 });
    // the critic's cost is the bible job's
    expect(done.cost.usd).toBeGreaterThanOrEqual(0.01);
    expect(done.bible).toMatchObject({ format: 2, restraint: { detailDensity: 'moderate' }, critique: { overall: 6 } });
    const crit = h.sc.jobs.book.list().find((x) => (x.spec as { owner?: string }).owner === 'architect:sheet-critic')!;
    expect(h.sc.jobs.book.work(crit.id)!.images).toHaveLength(1);
  }, 60_000);

  it('a format-1 bible reads with defaults; archive hides it (a flag); delete is refused while pinned, by another owner, and works once free', async () => {
    h = await harness();
    installFake(h.sc, 'mosswater', 1);
    expect(h.sc.bibleIndex.get('mosswater')).toMatchObject({ format: 1, restraint: { heroMotifs: ['a', 'b', 'c'], accentShareMax: 0.12 } });
    expect(h.sc.bibleIndex.get('mosswater')!.archived).toBeUndefined();
    h.sc.bibleIndex.archive('mosswater', true);
    expect(h.sc.bibleIndex.get('mosswater')!.archived).toBe(true);
    expect(h.events.some((e) => e.type === 'bible.index')).toBe(true);
    h.sc.bibleIndex.archive('mosswater', false);
    expect(h.sc.bibleIndex.get('mosswater')!.archived).toBeUndefined();
    expect(() => h!.sc.bibleIndex.archive('rustic', true)).toThrow(/built-in/);
    fakeEntry(h.sc, 'gen_house', { id: 'mosswater', version: 1 });
    expect(() => h!.sc.bibleIndex.delete('mosswater')).toThrow(/in use, delete refused: entry gen_house/);
    // pinned by an open design too
    fs.rmSync(path.join(h.sc.config.libraryDir, 'gen_house'), { recursive: true });
    installFake(h.sc, 'owned', 1, { owner: 'steward_mc:s1' });
    expect(() => h!.sc.bibleIndex.delete('owned')).toThrow(/belongs to steward_mc:s1/);
    expect(h.sc.bibleIndex.delete('owned', 'steward_mc:s1')).toEqual({ id: 'owned', versions: [1] });
    expect(h.sc.bibleIndex.delete('mosswater')).toEqual({ id: 'mosswater', versions: [1] });
    expect(fs.existsSync(path.join(h.sc.config.biblesDir, 'mosswater'))).toBe(false);
    expect(() => h!.sc.bibleIndex.delete('rustic')).toThrow(/built-in/);
  }, 30_000);

  it('version GC removes old unpinned versions and keeps the latest and every pinned one', async () => {
    h = await harness();
    const old = Date.now() - 40 * 24 * 3600_000;
    installFake(h.sc, 'gcb', 1, {}, old);
    installFake(h.sc, 'gcb', 2, {}, old);
    installFake(h.sc, 'gcb', 3, {}, old);
    installFake(h.sc, 'gcb', 4, {}, Date.now() - 1000);
    installFake(h.sc, 'gcb', 5, {}, old);
    fakeEntry(h.sc, 'gen_pinned', { id: 'gcb', version: 2 });
    expect(h.sc.bibleIndex.gc().sort()).toEqual(['gcb v1', 'gcb v3']);
    expect(h.sc.bibleIndex.versions('gcb')).toEqual([2, 4, 5]);
  }, 30_000);

  it('job.images: PNG blobs become the job\'s images; a non-image blob is refused at once', async () => {
    h = await harness();
    const img = h.sc.blobs.put({ kind: 'image', ext: 'png', chunks: [PNG.toString('base64')] });
    const txt = h.sc.blobs.put({ kind: 'note', data: { hello: 1 } });
    const spec = JobSpec.parse({ kind: 'structured', prompt: 'look', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, images: [{ blob: img.blobId, label: 'front' }] });
    const j = h.sc.jobs.run(spec, undefined);
    expect(h.sc.jobs.book.work(j.id)!.images).toEqual([{ file: expect.stringMatching(/images\/01\.png$/), label: 'front', mediaType: 'image/png' }]);
    await until(() => h!.sc.jobs.book.get(j.id)!.status === 'done', 10_000);
    expect(() => h!.sc.jobs.run(JobSpec.parse({ ...spec, images: [{ blob: txt.blobId, label: 'x' }] }), undefined)).toThrow(/not a PNG or JPEG/);
    expect(JobSpec.safeParse({ ...spec, images: Array.from({ length: 9 }, () => ({ blob: img.blobId, label: 'x' })) }).success).toBe(false);
  }, 30_000);

  it('a massing with critique uses the massing rubric (silhouette, brief, site) and maxRevisions 1', async () => {
    h = await harness();
    const d = h.sc.requestDesign(DesignRequest.parse(request({ name: undefined, notes: 'sim:critique=5/5/5', maxSize: { x: 64, y: 64, z: 64 }, massing: true, critique: { mode: 'loop', budgetUsd: 5 } })));
    await until(() => ['done', 'failed'].includes(h!.sc.designs.get(d.id)!.status), 60_000);
    const f = h.sc.designs.get(d.id)!;
    expect(f.status, f.error).toBe('done');
    expect(f.critique).toMatchObject({ end: 'max_revisions' });
    expect(f.critique!.rounds).toHaveLength(2);
    expect(Object.keys(f.critique!.rounds[0]!.scores).sort()).toEqual(['brief', 'silhouette', 'site']);
    expect(h.sc.massings.get(f.massing!.id)).toBeDefined();
  }, 60_000);
});
