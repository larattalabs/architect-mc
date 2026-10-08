// Phase 5b: entry versions (docs/CONTRACT.md "Phase 5b gate" item 1, sidecar): the install with a fault at every step,
// then repair; user metadata and ext kept through a bump; GC keeps pins (and deletes nothing without them); the stale
// rule (version, sha, critic hash); revert; the refusals; the entry.* messages and protocol 1.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { criticHash, criticHashOfFile } from '../src/critichash.js';
import { parseClientMessage, toProtocol1, type Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { Store } from '../src/store.js';
import { EntryVersions, readEntryCritique, sha256File, staleReason, type FaultPoint } from '../src/versions.js';
import { rmrf, SIDECAR_ROOT, tempDir } from './helpers.js';

const REPO = path.resolve(SIDECAR_ROOT, '..');
const KIT = path.join(REPO, 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'tools', 'delta-fixtures.mjs'));
let fixtures = '';
let root = '';

const log = memoryLogger();
function lib(): { dir: string; v: EntryVersions; t: { now: number } } {
  const dir = tempDir('arch-ver-');
  const t = { now: 1_800_000_000_000 };
  return { dir, v: new EntryVersions({ libraryDir: path.join(dir, 'library'), kitDir: KIT, dataDir: path.join(dir, 'data'), now: () => t.now, log }), t };
}
/** a library entry "tavern" = the fixture version v<n> */
function entry(libDir: string, n = 1, extra: Record<string, unknown> = {}): string {
  const d = path.join(libDir, 'library', 'tavern');
  fs.mkdirSync(d, { recursive: true });
  const src = path.join(fixtures, 'versions', 'tavern', `v${n}`);
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(d, f));
  const j = JSON.parse(fs.readFileSync(path.join(d, 'tavern.blueprint.json'), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(path.join(d, 'tavern.blueprint.json'), JSON.stringify({ ...j, createdAt: 1_700_000_000_000, ...extra }, null, 2));
  return d;
}
const v2files = () => {
  const src = path.join(fixtures, 'versions', 'tavern', 'v2');
  return { nbt: path.join(src, 'tavern.nbt'), json: JSON.parse(fs.readFileSync(path.join(src, 'tavern.blueprint.json'), 'utf8')) as Record<string, unknown>, parts: path.join(src, 'tavern.parts.nbt'), source: path.join(src, 'tavern.mjs'), previews: [], critique: { format: 2, entryVersion: 2 }, delta: { from: 1, to: 2 } };
};
const readTop = (d: string) => JSON.parse(fs.readFileSync(path.join(d, 'tavern.blueprint.json'), 'utf8')) as Record<string, unknown>;

describe.skipIf(!hasKit)('entry versions', () => {
  beforeAll(() => {
    root = tempDir('arch-verfx-');
    fixtures = path.join(root, 'fx');
    execFileSync(process.execPath, [path.join(KIT, 'tools', 'delta-fixtures.mjs'), '--out', fixtures, '--no-previews'], { stdio: 'pipe' });
  }, 60_000);
  afterAll(() => rmrf(root));

  it('the critic hash is 5a\'s provenance hash of sidecar/src/critic.ts (critic.ts is unchanged since 5a)', () => {
    expect(criticHash()).toBe(criticHashOfFile(path.join(SIDECAR_ROOT, 'src', 'critic.ts')));
    expect(criticHash()).toBe('b7888e53874212e7f6efbefff555d79f9962e7c4679025b417f24a423e6e0bcc');
  });

  it('a bump: versions/1 from the top level (lineage migrated), versions/2 committed, the top level = v2 with the user metadata and ext', () => {
    const { dir, v } = lib();
    const d = entry(dir, 1, { favorite: true, userTags: ['inn'], displayName: 'My Inn', ext: { 'steward_mc:lot': 'L3' } });
    const n = v.install('tavern', v2files(), { by: 'polish', parent: 1, designId: 'd9', summary: 'resolved: the roof', criticHash: criticHash() });
    expect(n).toBe(2);
    const top = readTop(d);
    expect(top).toMatchObject({ version: 2, favorite: true, userTags: ['inn'], displayName: 'My Inn', ext: { 'steward_mc:lot': 'L3' } });
    expect(top.versions).toEqual([
      { n: 1, createdAt: 1_700_000_000_000, by: 'migrated', parent: null, summary: '', nbtSha256: sha256File(path.join(fixtures, 'versions', 'tavern', 'v1', 'tavern.nbt')) },
      { n: 2, createdAt: 1_800_000_000_000, by: 'polish', parent: 1, designId: 'd9', summary: 'resolved: the roof', nbtSha256: sha256File(path.join(fixtures, 'versions', 'tavern', 'v2', 'tavern.nbt')), criticHash: criticHash() },
    ]);
    // the version folders: v1 is the old top level, v2 the new files (no user metadata in a version's JSON)
    expect(fs.readFileSync(path.join(d, 'versions', '1', 'tavern.nbt'))).toEqual(fs.readFileSync(path.join(fixtures, 'versions', 'tavern', 'v1', 'tavern.nbt')));
    expect(fs.readFileSync(path.join(d, 'tavern.nbt'))).toEqual(fs.readFileSync(path.join(d, 'versions', '2', 'tavern.nbt')));
    expect(JSON.parse(fs.readFileSync(path.join(d, 'versions', '2', 'tavern.blueprint.json'), 'utf8')).favorite).toBeUndefined();
    expect(fs.existsSync(path.join(d, 'versions', '2', 'delta.json'))).toBe(true);
    expect(fs.existsSync(path.join(d, 'delta.json'))).toBe(false);
    expect(fs.readdirSync(path.join(d, 'versions')).sort()).toEqual(['1', '2']);
    expect(v.list('tavern').map((e) => e.n)).toEqual([1, 2]);
    rmrf(dir);
  });

  it('the top level is exactly the head: layout files the new version lacks are deleted', () => {
    const { dir, v } = lib();
    const d = entry(dir, 1);
    fs.writeFileSync(path.join(d, 'critique.json'), '{"format":1}');
    fs.writeFileSync(path.join(d, 'tavern.preview-iso.png'), 'png');
    const f = v2files();
    v.install('tavern', { ...f, parts: undefined, critique: undefined }, { by: 'polish', parent: 1, summary: 's' });
    expect(fs.existsSync(path.join(d, 'critique.json'))).toBe(false);
    expect(fs.existsSync(path.join(d, 'tavern.preview-iso.png'))).toBe(false);
    expect(fs.existsSync(path.join(d, 'tavern.parts.nbt'))).toBe(false);
    expect(fs.existsSync(path.join(d, 'versions', '1', 'critique.json'))).toBe(true);
    rmrf(dir);
  });

  const points: FaultPoint[] = ['head-copied', 'head-committed', 'new-written', 'committed', 'top-file', 'top-files-done', 'top-json'];
  for (const p of points) {
    it(`a crash at ${p}, then repair: the top level is a complete v${['committed', 'top-file', 'top-files-done', 'top-json'].includes(p) ? 2 : 1}`, () => {
      const { dir, v } = lib();
      const d = entry(dir, 1, { favorite: true, ext: { 'x:y': 1 } });
      v.fault = (q) => {
        if (q === p) throw new Error(`crash at ${q}`);
      };
      expect(() => v.install('tavern', v2files(), { by: 'polish', parent: 1, summary: 's' })).toThrow(`crash at ${p}`);
      // a new process: repair at start
      const v2 = new EntryVersions({ libraryDir: path.join(dir, 'library'), kitDir: KIT, dataDir: path.join(dir, 'data'), now: () => 1, log });
      v2.repairAll();
      const committed = ['committed', 'top-file', 'top-files-done', 'top-json'].includes(p);
      const top = readTop(d);
      expect(top.version ?? 1).toBe(committed ? 2 : 1);
      expect(top).toMatchObject({ favorite: true, ext: { 'x:y': 1 } });
      expect(fs.readFileSync(path.join(d, 'tavern.nbt'))).toEqual(fs.readFileSync(path.join(fixtures, 'versions', 'tavern', `v${committed ? 2 : 1}`, 'tavern.nbt')));
      expect(fs.readFileSync(path.join(d, 'tavern.parts.nbt'))).toEqual(fs.readFileSync(path.join(fixtures, 'versions', 'tavern', `v${committed ? 2 : 1}`, 'tavern.parts.nbt')));
      // no temp folders or files are left
      expect(fs.readdirSync(path.join(d, 'versions')).filter((f) => f.startsWith('.'))).toEqual([]);
      expect(fs.readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([]);
      // and the next install works
      const n = v2.install('tavern', v2files(), { by: 'polish', parent: committed ? 2 : 1, summary: 'again' });
      expect(n).toBe(committed ? 3 : 2);
      rmrf(dir);
    });
  }

  it('the user metadata is read just before the JSON is replaced (an edit by the mod during the install is kept)', () => {
    const { dir, v } = lib();
    const d = entry(dir, 1, { displayName: 'Old' });
    v.fault = (q) => {
      if (q === 'top-files-done') fs.writeFileSync(path.join(d, 'tavern.blueprint.json'), JSON.stringify({ ...readTop(d), displayName: 'Renamed meanwhile', userTags: ['x'] }));
    };
    v.install('tavern', v2files(), { by: 'polish', parent: 1, summary: 's' });
    expect(readTop(d)).toMatchObject({ version: 2, displayName: 'Renamed meanwhile', userTags: ['x'] });
    rmrf(dir);
  });

  it('revert: version n+1 is a byte copy of version k (by revert, parent k); history stays linear', () => {
    const { dir, v } = lib();
    const d = entry(dir, 1);
    v.install('tavern', v2files(), { by: 'polish', parent: 1, summary: 's' });
    const n = v.revert('tavern', 1);
    expect(n).toBe(3);
    expect(fs.readFileSync(path.join(d, 'tavern.nbt'))).toEqual(fs.readFileSync(path.join(d, 'versions', '1', 'tavern.nbt')));
    expect(fs.readFileSync(path.join(d, 'versions', '3', 'tavern.parts.nbt'))).toEqual(fs.readFileSync(path.join(d, 'versions', '1', 'tavern.parts.nbt')));
    expect((readTop(d).versions as Array<{ n: number; by: string; parent: number | null }>).map((e) => [e.n, e.by, e.parent])).toEqual([[1, 'migrated', null], [2, 'polish', 1], [3, 'revert', 1]]);
    expect(() => v.revert('tavern', 3)).toThrow(/no_version: tavern is at v3 already/);
    expect(() => v.revert('tavern', 9)).toThrow(/no_version/);
    rmrf(dir);
  });

  it('refusals: bundled (make a variant first), no_source (an import), massing', () => {
    const { dir, v } = lib();
    expect(() => v.checkVersionable('tavern')).toThrow(/^bundled: tavern is a bundled example: make a variant first/);
    entry(dir, 1);
    const imp = path.join(dir, 'library', 'imp_hut');
    fs.mkdirSync(imp, { recursive: true });
    fs.writeFileSync(path.join(imp, 'imp_hut.blueprint.json'), JSON.stringify({ id: 'imp_hut', imported: true }));
    expect(() => v.checkVersionable('imp_hut')).toThrow(/^no_source:/);
    const m = path.join(dir, 'library', 'mas_x');
    fs.mkdirSync(m, { recursive: true });
    fs.writeFileSync(path.join(m, 'mas_x.blueprint.json'), JSON.stringify({ id: 'mas_x', massing: true }));
    fs.writeFileSync(path.join(m, 'mas_x.mjs'), '');
    expect(() => v.checkVersionable('mas_x')).toThrow(/^massing:/);
    expect(() => v.checkVersionable('nope')).toThrow(/^no_entry:/);
    expect(v.checkVersionable('tavern')).toMatchObject({ id: 'tavern' });
    rmrf(dir);
  });

  it('GC: nothing without pins ever received; pins always win; 30 days; over 32 the oldest eligible go', () => {
    const { dir, v, t } = lib();
    const d = entry(dir, 1);
    for (let i = 0; i < 5; i++) v.install('tavern', v2files(), { by: 'polish', parent: i + 1, summary: `s${i}` });
    // versions 1..6, the head is 6; age them all 40 days
    t.now += 40 * 24 * 60 * 60_000;
    expect(v.gc()).toEqual([]);
    expect(v.folders('tavern')).toEqual([1, 2, 3, 4, 5, 6]);
    v.setPins({ tavern: [2] });
    expect(v.gc(new Set(['tavern:4']))).toEqual(['tavern:1', 'tavern:3', 'tavern:5']);
    expect(v.folders('tavern')).toEqual([2, 4, 6]);
    expect(v.list('tavern').map((e) => e.n)).toEqual([2, 4, 6]);
    // the cap: 34 recent versions, the oldest unpinned go first, pins and the head stay
    for (let i = 0; i < 31; i++) v.install('tavern', v2files(), { by: 'polish', parent: null, summary: `c${i}` });
    expect(v.folders('tavern').length).toBe(34);
    v.setPins({ tavern: [2, 4] });
    const gone = v.gc();
    expect(gone).toEqual(['tavern:6', 'tavern:7']);
    expect(v.folders('tavern').length).toBe(32);
    expect(v.folders('tavern')).toEqual(expect.arrayContaining([2, 4, 37]));
    void d;
    rmrf(dir);
  });

  it('the stale rule: version, the .nbt sha, the critic hash; format 1 reads as entryVersion 1 (and has no critic hash)', () => {
    const { dir } = lib();
    const f = path.join(dir, 'c.json');
    const cur = { version: 2, nbtSha256: 'aa', criticHash: 'h' };
    fs.writeFileSync(f, JSON.stringify({ format: 2, entryVersion: 2, entryRevision: 'aa', criticHash: 'h', verdict: {} }));
    expect(staleReason(readEntryCritique(f)!, cur)).toBeUndefined();
    expect(staleReason(readEntryCritique(f)!, { ...cur, version: 3 })).toBe('for v2; this is v3');
    expect(staleReason(readEntryCritique(f)!, { ...cur, nbtSha256: 'bb' })).toMatch(/\.nbt differs/);
    expect(staleReason(readEntryCritique(f)!, { ...cur, criticHash: 'other' })).toMatch(/another critic/);
    fs.writeFileSync(f, JSON.stringify({ format: 1, entryRevision: 'aa', verdict: {} }));
    const c1 = readEntryCritique(f)!;
    expect(c1.entryVersion).toBe(1);
    expect(staleReason(c1, { version: 1, nbtSha256: 'aa', criticHash: 'h' })).toMatch(/before 5b/);
    rmrf(dir);
  });
});

describe.skipIf(!hasKit)('entry.* messages', () => {
  let dir = '';
  let sc: Sidecar;
  const events: Outbound[] = [];
  beforeAll(() => {
    if (!fixtures || !fs.existsSync(fixtures)) {
      root = tempDir('arch-verfx-');
      fixtures = path.join(root, 'fx');
      execFileSync(process.execPath, [path.join(KIT, 'tools', 'delta-fixtures.mjs'), '--out', fixtures, '--no-previews'], { stdio: 'pipe' });
    }
    dir = tempDir('arch-vermsg-');
    const cfg = loadConfig(['--data', path.join(dir, 'data'), '--library', path.join(dir, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    sc.subscribe((m) => events.push(m));
    entry(dir, 1);
    sc.versions.install('tavern', v2files(), { by: 'polish', parent: 1, summary: 'v2' });
  }, 60_000);
  afterAll(() => {
    sc.store.close();
    rmrf(dir);
    rmrf(root);
  });
  const call = async (msg: Record<string, unknown>) => {
    const out: Outbound[] = [];
    const p = parseClientMessage({ v: 1, id: 'q', ...msg });
    if (!p.ok) throw new Error(p.error);
    await sc.handle(p.msg, (m) => out.push(m));
    return out.find((m) => m.type === 'ack') as { ok: boolean; result?: Record<string, unknown>; error?: string };
  };

  it('entry.versions, entry.delta (the kit summary), entry.revert (entry.versioned), entry.pins (persisted)', async () => {
    const vs = await call({ type: 'entry.versions', entryId: 'tavern' });
    expect(vs.ok).toBe(true);
    expect((vs.result!.versions as Array<{ n: number }>).map((x) => x.n)).toEqual([1, 2]);
    const dl = await call({ type: 'entry.delta', entryId: 'tavern', from: 1, to: 2 });
    expect(dl.ok, dl.error).toBe(true);
    const delta = dl.result!.delta as Record<string, unknown>;
    expect(delta).toMatchObject({ entryId: 'tavern', from: 1, to: 2, frameKept: true, approximate: false, added: 130, removed: 26, changed: 284 });
    expect((delta.parts as Record<string, { status: string }>).wing_east!.status).toBe('ADDED');
    expect(delta.violations).toBeUndefined();
    const rv = await call({ type: 'entry.revert', entryId: 'tavern', toVersion: 1 });
    expect(rv.result).toEqual({ entryId: 'tavern', version: 3 });
    expect(events.find((e) => e.type === 'entry.versioned')).toMatchObject({ entryId: 'tavern', version: 3, from: 2, by: 'revert' });
    const pins = await call({ type: 'entry.pins', pins: { tavern: [1, 3] } });
    expect(pins.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(sc.config.dataDir, 'pins.json'), 'utf8')).pins).toEqual({ tavern: [1, 3] });
    const bad = await call({ type: 'entry.delta', entryId: 'tavern', from: 1, to: 9 });
    expect(bad).toMatchObject({ ok: false });
    expect(bad.error).toMatch(/no version 9/);
    const refused = await call({ type: 'entry.revert', entryId: 'cabin', toVersion: 1 });
    expect(refused.error).toMatch(/^bundled:/);
  });

  it('protocol 1: no entry.* messages, no entry.versioned, no polish designs', () => {
    expect(parseClientMessage({ v: 1, type: 'entry.versions', entryId: 'tavern' }, 1).ok).toBe(false);
    expect(parseClientMessage({ v: 1, type: 'design.polish', entryId: 'tavern' }, 1).ok).toBe(false);
    expect(toProtocol1({ v: 1, type: 'entry.versioned', entryId: 'tavern', version: 2, from: 1, by: 'polish' })).toBeUndefined();
    const d = { id: 'd1', status: 'queued', step: 's', request: { type: 'cabin', style: 'x', features: [], maxSize: { x: 9, y: 9, z: 9 } }, createdAt: 1, updatedAt: 1, kind: 'polish', polish: { entryId: 'tavern', fromVersion: 1, steps: [], installedVersion: null } };
    expect(toProtocol1({ v: 1, type: 'design.upsert', design: d })).toBeUndefined();
    expect((toProtocol1({ v: 1, type: 'snapshot', version: 'x', status: { auth: 'ok', useClaudeLogin: false, sdk: 'ready', queued: 0 }, designs: [d], variants: [] }) as { designs: unknown[] }).designs).toEqual([]);
  });
});
