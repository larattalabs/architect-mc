// Slice 6d FS (docs/CONTRACT.md "Phase 6d slice FS: updates follow the source" §6 item 1) with the sim backend and the REAL kit: a copy
// follows its source's new version by its recipe (byte-identical to an independent rebuild of that recipe on the new version), each
// refusal (frame, check, bar, fit, source_gone, bible_gone, head_moved), the opKey replay and conflict, followAll's frozen set (a copy
// made mid-operation is not followed; the source versioned again mid-operation: the frozen version is used), the already-followed
// no-op, the kinds that don't follow (NOT_ALLOWED not_copy, until_7b), and a kill mid-followAll and its resume.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { DesignRequest, GroupRequest, type Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import type { FollowOp } from '../src/follows.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'tools', 'copy-recipe.mjs'));

interface H {
  root: string;
  sc: Sidecar;
  events: Outbound[];
  close(keep?: boolean): Promise<void>;
}

async function harness(root = tempDir('arch-fs-')): Promise<H> {
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
  cfg.simStepMs = 15;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
  const events: Outbound[] = [];
  sc.subscribe((m) => events.push(m));
  await sc.start(new SimDesigner(sc, cfg.simStepMs));
  return { root, sc, events, close: async (keep = false) => { await sc.close(); if (!keep) rmrf(root); } };
}

const lib = (h: H) => h.sc.config.libraryDir;
const top = (h: H, id: string) => JSON.parse(fs.readFileSync(path.join(lib(h), id, `${id}.blueprint.json`), 'utf8')) as Record<string, unknown>;
const writeTop = (h: H, id: string, j: Record<string, unknown>) => fs.writeFileSync(path.join(lib(h), id, `${id}.blueprint.json`), `${JSON.stringify(j, null, 2)}\n`);
const nbt = (h: H, id: string) => fs.readFileSync(path.join(lib(h), id, `${id}.nbt`));
const item = (itemKey: string, type: string, o: Record<string, unknown> = {}) => ({ ...request({ type, name: undefined, notes: undefined, maxSize: { x: 64, y: 64, z: 64 } }), itemKey, ...o });

/** A group with an archetype and 2 copies (the 0b cap: 3 placements per design). */
async function family(h: H, type = 'cabin'): Promise<{ arch: string; copies: string[] }> {
  const g = h.sc.groups.create(GroupRequest.parse({ name: 'G', bible: 'oak', items: [item('house', type, { count: 3 })] }));
  await until(() => ['done', 'failed', 'cancelled'].includes(h.sc.groups.get(g.id)!.status), 120_000);
  const f = h.sc.groups.get(g.id)!;
  expect(f.status).toBe('done');
  return { arch: f.items[0]!.entryId!, copies: [f.items[1]!.entryId!, f.items[2]!.entryId!] };
}

/** A sim versionOf of the source (an int param's default up by one); `notes` may carry sim tokens. */
async function versionOf(h: H, entryId: string, type = 'cabin', notes = 'make it wider'): Promise<number> {
  const d = h.sc.requestDesign(DesignRequest.parse(request({ type, notes, maxSize: { x: 64, y: 64, z: 64 }, versionOf: { entryId } })));
  await until(() => ['done', 'failed', 'cancelled'].includes(h.sc.designs.get(d.id)!.status), 60_000);
  expect(h.sc.designs.get(d.id)!.status, h.sc.designs.get(d.id)!.error).toBe('done');
  return h.sc.versions.head(entryId);
}

async function run(h: H, op: FollowOp): Promise<FollowOp> {
  await until(() => h.sc.follows.get(op.id)?.status === 'done', 120_000);
  return h.sc.follows.get(op.id)!;
}

/** An independent rebuild (kit/build.mjs CLI): the source version's .mjs under the copy's id, with the recipe on that version's values. */
function rebuild(h: H, copy: string, source: string, sourceVersion: number): Buffer {
  const der = top(h, copy).derivation as { recipe: { roles: Record<string, string>; param?: { name: string; value: unknown } | null; mirror: boolean; bible: { id: string; version: number } } };
  const r = der.recipe;
  const dir = h.sc.versions.versionDir(source, sourceVersion)!;
  const sj = JSON.parse(fs.readFileSync(path.join(dir, `${source}.blueprint.json`), 'utf8')) as { values: Record<string, unknown> };
  const values = { ...sj.values, ...(r.param ? { [r.param.name]: r.param.value } : {}) };
  const tmp = tempDir('arch-fs-rebuild-');
  try {
    fs.cpSync(KIT, path.join(tmp, 'kit'), { recursive: true, filter: (p) => !/[\\/](out|node_modules)([\\/]|$)/.test(p) });
    const src = fs.readFileSync(path.join(dir, `${source}.mjs`), 'utf8').replace(new RegExp(`\\b${source}\\b`, 'g'), copy).replace(/(['"])(?:\.\.?\/)+(?:[^'"\n]*\/)?lib\/([\w.-]+\.mjs)\1/g, '$1../lib/$2$1');
    fs.writeFileSync(path.join(tmp, 'kit', 'designs', `${copy}.mjs`), src);
    if (fs.existsSync(path.join(dir, 'bible'))) fs.cpSync(path.join(dir, 'bible'), path.join(tmp, 'bible'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'b.json'), JSON.stringify({ id: r.bible.id, version: r.bible.version, roles: r.roles }));
    execFileSync('node', [path.join('kit', 'build.mjs'), copy, '--out', 'out', '--bible', 'b.json', '--values', JSON.stringify(values), ...(r.mirror ? ['--mirror'] : []), '--json'], { cwd: tmp });
    return fs.readFileSync(path.join(tmp, 'out', `${copy}.nbt`));
  } finally {
    rmrf(tmp);
  }
}

/** Install a hand-made version of `entryId` (its head's source, changed by `edit`), as a design would: the kit builds it. */
function installEdited(h: H, entryId: string, edit: (src: string) => string): number {
  const tmp = tempDir('arch-fs-edit-');
  try {
    fs.cpSync(KIT, path.join(tmp, 'kit'), { recursive: true, filter: (p) => !/[\\/](out|node_modules)([\\/]|$)/.test(p) });
    const head = h.sc.versions.head(entryId);
    const src = edit(fs.readFileSync(path.join(lib(h), entryId, `${entryId}.mjs`), 'utf8').replace(/(['"])(?:\.\.?\/)+(?:[^'"\n]*\/)?lib\/([\w.-]+\.mjs)\1/g, '$1../lib/$2$1'));
    const file = path.join(tmp, 'kit', 'designs', `${entryId}.mjs`);
    fs.writeFileSync(file, src);
    if (fs.existsSync(path.join(lib(h), entryId, 'bible'))) fs.cpSync(path.join(lib(h), entryId, 'bible'), path.join(tmp, 'bible'), { recursive: true });
    execFileSync('node', [path.join('kit', 'build.mjs'), entryId, '--out', 'out', '--json'], { cwd: tmp });
    const t = top(h, entryId);
    const json = { ...(JSON.parse(fs.readFileSync(path.join(tmp, 'out', `${entryId}.blueprint.json`), 'utf8')) as Record<string, unknown>) };
    for (const k of ['name', 'request', 'bible', 'group', 'groupItem', 'derivation', 'variantOf', 'variantOfVersion']) if (t[k] !== undefined) json[k] = t[k];
    return h.sc.versions.install(entryId, { nbt: path.join(tmp, 'out', `${entryId}.nbt`), json, source: file }, { by: 'design', parent: head, summary: 'test edit' });
  } finally {
    rmrf(tmp);
  }
}

/** Install a version of `entryId` with an edited source and the head's blocks (a source the kit can't build). */
function installRaw(h: H, entryId: string, edit: (src: string) => string): number {
  const tmp = tempDir('arch-fs-raw-');
  try {
    const file = path.join(tmp, `${entryId}.mjs`);
    fs.writeFileSync(file, edit(fs.readFileSync(path.join(lib(h), entryId, `${entryId}.mjs`), 'utf8')));
    const { version: _v, versions: _vs, ...json } = top(h, entryId);
    return h.sc.versions.install(entryId, { nbt: path.join(lib(h), entryId, `${entryId}.nbt`), json, source: file }, { by: 'design', parent: h.sc.versions.head(entryId), summary: 'test: a broken source' });
  } finally {
    rmrf(tmp);
  }
}

const refusalOf = (fn: () => unknown): [string | undefined, string | undefined] => {
  try {
    fn();
  } catch (e) {
    return [(e as { code?: string }).code, (e as { detail?: string }).detail ?? (e as Error).message];
  }
  return [undefined, undefined];
};

describe.skipIf(!hasKit)('6d FS: copies follow their source (sim backend, real kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('followers, followAll, byte identity, ENTRY_VERSIONED, already followed, opKey replay and conflict, the kinds that refuse', async () => {
    h = await harness();
    const { arch, copies } = await family(h);
    const variant = h.sc.requestVariant(arch, undefined, { porch: false });
    await until(() => ['done', 'failed'].includes(h!.sc.variants.get(variant.id)!.status), 60_000);
    const vId = h.sc.variants.get(variant.id)!.blueprintId!;
    // followers: the 2 copies and the variant, none behind
    let fl = h.sc.follows.followers(arch);
    expect(fl.map((f) => [f.entryId, f.kind, f.behind]).sort()).toEqual([[copies[0], 'copy', false], [copies[1], 'copy', false], [vId, 'variant', false]].sort());
    const heads = copies.map((c) => nbt(h!, c));
    const v2 = await versionOf(h, arch);
    expect(v2).toBe(2);
    fl = h.sc.follows.followers(arch);
    expect(fl.filter((f) => f.behind).map((f) => f.entryId).sort()).toEqual([...copies].sort());
    expect(fl.find((f) => f.entryId === vId)!.behind).toBe(false);
    h.events.length = 0;
    const op = await run(h, h.sc.follows.followAll(arch, 0, 'fs.all.1'));
    expect(op.target).toBe(2);
    for (const [i, c] of copies.entries()) {
      const r = op.members.find((m) => m.entryId === c)!.result!;
      expect(r, r.message).toMatchObject({ followed: true, fromVersion: 1, newVersion: 2, sourceVersion: 2, refused: null, alreadyFollowed: false });
      const t = top(h, c);
      expect(t.version).toBe(2);
      expect((t.versions as Array<{ by: string }>).at(-1)!.by).toBe('follow');
      expect(t.derivation).toMatchObject({ source: arch, sourceVersion: 2, kind: 'copy' });
      expect(t.variantOfVersion).toBe(2);
      // the source's change came through (width 9 -> 10), and the blocks equal an independent rebuild of the recipe on v2
      expect(nbt(h, c).equals(heads[i]!)).toBe(false);
      expect(rebuild(h, c, arch, 2).equals(nbt(h, c))).toBe(true);
    }
    const versioned = h.events.filter((e) => e.type === 'entry.versioned') as Array<{ entryId: string; by: string; version: number }>;
    expect(versioned.map((e) => [e.entryId, e.by, e.version]).sort()).toEqual(copies.map((c) => [c, 'follow', 2]).sort());
    expect(h.events.filter((e) => e.type === 'follow.upsert').at(-1)).toMatchObject({ follow: { id: op.id, status: 'done' } });
    // the replay: the same operation, nothing installed again
    const again = h.sc.follows.followAll(arch, 0, 'fs.all.1');
    expect(again.id).toBe(op.id);
    expect(again.status).toBe('done');
    expect(copies.map((c) => h!.sc.versions.head(c))).toEqual([2, 2]);
    // another body under the key: op_key_conflict
    expect(refusalOf(() => h!.sc.follows.followAll(arch, 1, 'fs.all.1'))[1]).toMatch(/^op_key_conflict/);
    // nothing behind now; a single follow to v2 is the already-followed no-op
    expect(h.sc.follows.followAll(arch, 0).members).toEqual([]);
    const one = await run(h, h.sc.follows.follow(copies[0]!, 2));
    expect(one.members[0]!.result).toMatchObject({ followed: false, refused: null, alreadyFollowed: true, newVersion: 2 });
    expect(h.sc.versions.head(copies[0]!)).toBe(2);
    // a COPY stays refused versionOf and polish
    expect(refusalOf(() => h!.sc.polishes.request(copies[0]!, {}))).toEqual(['VERSION_REFUSED', 'copy']);
    // the kinds that don't follow
    expect(refusalOf(() => h!.sc.follows.follow(vId, 0))).toEqual(['NOT_ALLOWED', 'not_copy']);
    expect(refusalOf(() => h!.sc.follows.follow(arch, 0))).toEqual(['NOT_ALLOWED', 'not_copy']);
    const site = 'fs_site_copy';
    fs.cpSync(path.join(lib(h), copies[1]!), path.join(lib(h), site), { recursive: true });
    for (const f of fs.readdirSync(path.join(lib(h), site))) if (f.startsWith(copies[1]!)) fs.renameSync(path.join(lib(h), site, f), path.join(lib(h), site, f.replace(copies[1]!, site)));
    writeTop(h, site, { ...top(h, site), id: site, derivation: { ...(top(h, site).derivation as object), kind: 'site' } });
    expect(refusalOf(() => h!.sc.follows.follow(site, 0))).toEqual(['NOT_ALLOWED', 'until_7b']);
    expect(h.sc.follows.followers(arch).find((f) => f.entryId === site)).toMatchObject({ kind: 'site', behind: false });
  }, 300_000);

  it('the tavern source: a copy re-made from v2 equals an independent rebuild of its recipe', async () => {
    h = await harness();
    const { arch, copies } = await family(h, 'tavern');
    expect(await versionOf(h, arch, 'tavern', 'make it longer')).toBe(2);
    const op = await run(h, h.sc.follows.follow(copies[0]!, 0, 'fs.tavern'));
    expect(op.members[0]!.result, op.members[0]!.result?.message).toMatchObject({ followed: true, newVersion: 2, sourceVersion: 2 });
    expect(rebuild(h, copies[0]!, arch, 2).equals(nbt(h, copies[0]!))).toBe(true);
    // the other copy is still behind
    expect(h.sc.follows.followers(arch).find((f) => f.entryId === copies[1])!.behind).toBe(true);
  }, 300_000);

  it('each refusal leaves the copy at its version: frame, check, bar, fit, bible_gone, source_gone, head_moved', async () => {
    h = await harness();
    const { arch, copies } = await family(h);
    const [a, b] = copies as [string, string];
    const expectRefused = async (copy: string, refused: string, to = 0) => {
      const before = h!.sc.versions.head(copy);
      const bytes = nbt(h!, copy);
      const op = await run(h!, h!.sc.follows.follow(copy, to));
      const r = op.members[0]!.result!;
      expect(r, r.message).toMatchObject({ followed: false, refused, alreadyFollowed: false, newVersion: before });
      expect(h!.sc.versions.head(copy)).toBe(before);
      expect(nbt(h!, copy).equals(bytes)).toBe(true);
      return r;
    };
    // frame: v2 with a turned front (the sim's versionOf keeps it under sim:frontmove)
    expect(await versionOf(h, arch, 'cabin', 'turn it sim:frontmove')).toBe(2);
    expect((top(h, arch).front as string)).not.toBe('south');
    expect((await expectRefused(a, 'frame')).message).toMatch(/front changed/);
    // check: v3 whose source throws (installed as is: the head's blocks, the broken source)
    expect(installRaw(h, arch, (src) => src.replace(/export default function build\(([^)]*)\) \{/, (m) => `${m}\n  throw new Error('fs: a broken source');`))).toBe(3);
    expect((await expectRefused(a, 'check')).message).toMatch(/did not pass the check/);
    // v4: the source mended (no throw, the front back to south): a good source for the rest
    expect(installEdited(h, arch, (src) => src.replace(/\n  throw new Error\('fs: a broken source'\);/, '').replace(/front: '(east|west)'/, "front: 'south'"))).toBe(4);
    const ta = top(h, a);
    // bar: a recipe with no shift and no param (only the mirror lever, or none) is too close to the source
    const tb = top(h, b);
    const recB = (tb.derivation as { recipe: Record<string, unknown> & { bible: { id: string; version: number } } }).recipe;
    const bibleRoles = (JSON.parse(fs.readFileSync(h.sc.bibleIndex.resolve(recB.bible).files.json, 'utf8')) as { roles: Record<string, string> }).roles;
    writeTop(h, b, { ...tb, derivation: { ...(tb.derivation as object), recipe: { ...recB, shift: null, param: null, roles: bibleRoles, bar: true } } });
    expect((await expectRefused(b, 'bar')).message).toMatch(/too close/);
    writeTop(h, b, tb);
    const recA = (ta.derivation as { recipe: Record<string, unknown> }).recipe;
    // fit: the copy's own maximum below its size
    writeTop(h, a, { ...ta, request: { ...(ta.request as object), maxSize: { x: 6, y: 6, z: 6 } } });
    expect((await expectRefused(a, 'fit')).message).toMatch(/over the copy's maximum/);
    writeTop(h, a, ta);
    // bible_gone: the pin names a bible that does not exist
    writeTop(h, a, { ...ta, derivation: { ...(ta.derivation as object), recipe: { ...recA, bible: { id: 'bib_gone_fs', version: 1 } } } });
    await expectRefused(a, 'bible_gone');
    writeTop(h, a, ta);
    // head_moved: the copy's head moves while its follow builds (a revert installs v2 of it)
    h.sc.follows.fault = (p, e) => {
      if (p === 'built' && e === a) {
        h!.sc.follows.fault = undefined;
        installEdited(h!, a, (s) => s);
      }
    };
    const hm = await run(h, h.sc.follows.follow(a, 0));
    expect(hm.members[0]!.result).toMatchObject({ followed: false, refused: 'head_moved' });
    expect(h.sc.versions.head(a)).toBe(2);
    expect((top(h, a).versions as Array<{ by: string }>).at(-1)!.by).toBe('design');
    // source_gone: the source deleted
    fs.rmSync(path.join(lib(h), arch), { recursive: true, force: true });
    await expectRefused(b, 'source_gone');
    // followAll of the gone source: every copy answers source_gone
    const all = await run(h, h.sc.follows.followAll(arch, 0));
    expect(all.members.map((m) => m.result!.refused).sort()).toEqual(['source_gone', 'source_gone']);
  }, 300_000);

  it('followAll freezes its set and version: a copy made mid-operation is not followed, a source version made mid-operation is not used', async () => {
    h = await harness();
    const { arch, copies } = await family(h);
    expect(await versionOf(h, arch)).toBe(2);
    let late = '';
    h.sc.follows.fault = (p) => {
      if (p !== 'built' || late) return;
      // mid-operation: a new copy of the source (behind) and the source's v3
      late = 'fs_late_copy';
      fs.cpSync(path.join(lib(h!), copies[1]!), path.join(lib(h!), late), { recursive: true });
      for (const f of fs.readdirSync(path.join(lib(h!), late))) if (f.startsWith(copies[1]!)) fs.renameSync(path.join(lib(h!), late, f), path.join(lib(h!), late, f.replace(copies[1]!, late)));
      writeTop(h!, late, { ...top(h!, late), id: late });
      installEdited(h!, arch, (s) => s);
    };
    const op = await run(h, h.sc.follows.followAll(arch, 0));
    expect(op.target).toBe(2);
    expect(op.members.map((m) => m.entryId).sort()).toEqual([...copies].sort());
    for (const m of op.members) expect(m.result, m.result!.message).toMatchObject({ followed: true, sourceVersion: 2 });
    for (const c of copies) expect(top(h, c).derivation).toMatchObject({ sourceVersion: 2 });
    expect(h.sc.versions.head(arch)).toBe(3);
    expect(h.sc.versions.head(late)).toBe(1);
    expect(h.sc.follows.followers(arch).filter((f) => f.behind).map((f) => f.entryId).sort()).toEqual([...copies, late].sort());
  }, 300_000);

  it('a kill mid-followAll: the restart resumes the saved operation, the follower installed before the kill reports followed', async () => {
    const root = tempDir('arch-fs-kill-');
    h = await harness(root);
    const { arch, copies } = await family(h);
    expect(await versionOf(h, arch)).toBe(2);
    const first = h.sc.follows.followers(arch).filter((f) => f.behind)[0]!.entryId;
    h.sc.follows.fault = (p, e) => {
      if (p === 'installed' && e === first) throw Object.assign(new Error('killed (test)'), { fatal: true });
    };
    const op = h.sc.follows.followAll(arch, 0, 'fs.kill');
    await until(() => h!.sc.versions.head(first) === 2, 120_000);
    await h.sc.follows.idle();
    const saved = h.sc.follows.get(op.id)!;
    expect(saved.status).toBe('running');
    expect(saved.members.find((m) => m.entryId === first)).toMatchObject({ state: 'installing', installing: 2 });
    await h.close(true);
    h = await harness(root);
    const done = await run(h, h.sc.follows.followAll(arch, 0, 'fs.kill'));
    expect(done.id).toBe(op.id);
    for (const c of copies) {
      const r = done.members.find((m) => m.entryId === c)!.result!;
      expect(r, r.message).toMatchObject({ followed: true, newVersion: 2, alreadyFollowed: false });
      expect(h.sc.versions.head(c)).toBe(2);
      expect((top(h, c).versions as unknown[]).length).toBe(2);
    }
    expect(done.members.find((m) => m.entryId === first)!.result!.message).toMatch(/resumed/);
  }, 300_000);
});
