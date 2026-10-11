// Slice 0b, C13 (docs/CONTRACT.md "Phase 6c slice 0b" §5) with the sim backend and the REAL kit: versionOf installs head + 1
// (by design, parent = the base, the change request as the summary), with the site files in the scratch context; a grown
// result passes; a front-changing result is repaired before install; every refusal detail; base_moved.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { DesignRequest, GroupRequest, type Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'tools', 'diff.mjs'));

interface H {
  sc: Sidecar;
  events: Outbound[];
  close(): Promise<void>;
}

async function harness(over: Partial<Config> = {}): Promise<H> {
  const root = tempDir('arch-0b-vo-');
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
  cfg.simStepMs = 15;
  Object.assign(cfg, over);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
  const events: Outbound[] = [];
  sc.subscribe((m) => events.push(m));
  await sc.start(new SimDesigner(sc, cfg.simStepMs));
  return { sc, events, close: async () => { await sc.close(); rmrf(root); } };
}

const final = (h: H, id: string) => until(() => ['done', 'failed', 'cancelled'].includes(h.sc.designs.get(id)!.status), 60_000);
const top = (h: H, e: string) => JSON.parse(fs.readFileSync(path.join(h.sc.config.libraryDir, e, `${e}.blueprint.json`), 'utf8')) as Record<string, unknown>;
const refusal = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { detail?: string }).detail ?? (e as Error).message;
  }
  return undefined;
};

async function entry(h: H, type = 'tavern'): Promise<string> {
  const d = h.sc.requestDesign(DesignRequest.parse(request({ type, name: 'Inn', maxSize: { x: 64, y: 64, z: 64 } })));
  await final(h, d.id);
  expect(h.sc.designs.get(d.id)!.status, h.sc.designs.get(d.id)!.error).toBe('done');
  return h.sc.designs.get(d.id)!.blueprintId!;
}

const versionOf = (h: H, entryId: string, notes: string, extra: Record<string, unknown> = {}) => h.sc.requestDesign(DesignRequest.parse(request({ type: 'tavern', notes, maxSize: { x: 64, y: 64, z: 64 }, versionOf: { entryId, ...extra } })));

describe.skipIf(!hasKit)('versionOf (sim backend, real kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('installs head + 1 by design (parent = base, the change request as the summary), grown, with the site files as context', async () => {
    h = await harness();
    const e = await entry(h);
    const size1 = top(h, e).size as { x: number; z: number };
    const now = h.sc.blobs.put({ kind: 'site', ext: 'nbt', chunks: [Buffer.from('nbt-bytes').toString('base64')] });
    const edits = h.sc.blobs.put({ kind: 'site', data: { cells: [{ part: 'main', block: 'minecraft:chest', x: 1, y: 1, z: 1 }], counts: { kept: 3 }, siteVersion: 1, deviations: 3 } });
    const d = versionOf(h, e, 'weathered, add a lean-to', { siteId: 's1', siteNow: now.blobId, siteEdits: edits.blobId });
    expect(d.request.versionOf).toMatchObject({ entryId: e, baseVersion: 1, siteId: 's1' });
    await final(h, d.id);
    const done = h.sc.designs.get(d.id)!;
    expect(done.status, done.error).toBe('done');
    expect(done.blueprintId).toBe(e);
    const j = top(h, e);
    expect(j.version).toBe(2);
    expect((j.versions as Array<Record<string, unknown>>).at(-1)).toMatchObject({ n: 2, by: 'design', parent: 1, designId: d.id, summary: 'versionOf: weathered, add a lean-to' });
    expect(h.events.some((m) => m.type === 'entry.versioned' && m.entryId === e && m.version === 2 && m.from === 1 && m.by === 'design')).toBe(true);
    // the sim grew it (an int param up by one): growth passes
    const size2 = j.size as { x: number; z: number };
    expect(size2.x * size2.z).toBeGreaterThan(size1.x * size1.z);
    const scratch = path.join(h.sc.config.dataDir, 'designs', d.id);
    expect(fs.readFileSync(path.join(scratch, 'context', 'site-now.nbt'), 'utf8')).toBe('nbt-bytes');
    expect(JSON.parse(fs.readFileSync(path.join(scratch, 'context', 'site-edits.json'), 'utf8'))).toMatchObject({ counts: { kept: 3 } });
    expect(fs.existsSync(path.join(scratch, 'context', 'base', `${e}.mjs`))).toBe(true);
    expect(fs.readFileSync(path.join(scratch, 'BRIEF.md'), 'utf8')).toContain(`## A new version of \`${e}\` (v1 + 1)`);
  }, 120_000);

  it('a front-changing result is repaired before install (the frame guard)', async () => {
    h = await harness();
    const e = await entry(h);
    const d = versionOf(h, e, 'turn it sim:frontchange');
    await final(h, d.id);
    const done = h.sc.designs.get(d.id)!;
    expect(done.status, done.error).toBe('done');
    expect(done.step).toMatch(/the turned front was repaired/);
    expect(top(h, e)).toMatchObject({ version: 2, front: 'south' });
  }, 120_000);

  it('every refusal detail; base_moved', async () => {
    h = await harness();
    const e = await entry(h);
    expect(refusal(() => versionOf(h!, 'cabin', 'x'))).toBe('bundled');
    expect(refusal(() => versionOf(h!, 'nope', 'x'))).toBe('no_entry');
    // a massing is not a library entry: no_entry; an imported entry has no source
    const imp = path.join(h.sc.config.libraryDir, 'imp_x');
    fs.mkdirSync(imp, { recursive: true });
    fs.writeFileSync(path.join(imp, 'imp_x.blueprint.json'), JSON.stringify({ id: 'imp_x', imported: true, size: { x: 1, y: 1, z: 1 } }));
    expect(refusal(() => versionOf(h!, 'imp_x', 'x'))).toBe('no_source');
    const m = path.join(h.sc.config.libraryDir, 'mass_x');
    fs.mkdirSync(m, { recursive: true });
    fs.writeFileSync(path.join(m, 'mass_x.blueprint.json'), JSON.stringify({ id: 'mass_x', massing: true }));
    expect(refusal(() => versionOf(h!, 'mass_x', 'x'))).toBe('massing');
    // a copy
    const g = h.sc.groups.create(GroupRequest.parse({ name: 'G', bible: 'oak', items: [{ ...request({ type: 'cabin', maxSize: { x: 64, y: 64, z: 64 } }), itemKey: 'a', count: 2 }] }));
    await until(() => ['done', 'failed'].includes(h!.sc.groups.get(g.id)!.status), 60_000);
    expect(refusal(() => versionOf(h!, h!.sc.groups.get(g.id)!.items[1]!.entryId!, 'x'))).toBe('copy');
    // busy, then base_moved: a revert moves the head while the versionOf runs
    const d = versionOf(h, e, 'a change');
    expect(refusal(() => versionOf(h!, e, 'another'))).toBe('busy');
    expect(refusal(() => h!.sc.polishes.request(e, {}))).toMatch(/polish|busy/);
    const v2 = h.sc.versions.head(e);
    expect(v2).toBe(1);
    // the notes are the change request
    expect(refusal(() => h!.sc.requestDesign(DesignRequest.parse(request({ type: 'tavern', notes: '  ', maxSize: { x: 64, y: 64, z: 64 }, versionOf: { entryId: e } }))))).toMatch(/change request/);
    await final(h, d.id);
    expect(h.sc.versions.head(e)).toBe(2);
    const d2 = versionOf(h, e, 'one more');
    h.sc.versions.revert(e, 1);
    await final(h, d2.id);
    expect(h.sc.designs.get(d2.id)).toMatchObject({ status: 'failed', error: 'base_moved' });
  }, 180_000);
});
