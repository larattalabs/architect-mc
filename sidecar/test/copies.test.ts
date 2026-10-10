// Slice 0b (docs/CONTRACT.md "Phase 6c slice 0b" §2-§4) with the sim backend and the REAL kit: expansion (count, copyOf,
// copyCap, the COPY_REFUSED details), the COPY stage on the variant queue, the copy's derivation (rebuilt byte-identically
// from its recipe), fallback (sim:copyfail, sim:copysize), source_failed, promoteCopy, copies while paused_budget, and the
// small-item rules (C2: no default report critique; C8: the SMALL request).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { GroupRequest, type Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { expandItems, fitsSmall, itemCritique, itemEffort } from '../src/copies.js';
import { RefusedError } from '../src/errors.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'tools', 'copy-recipe.mjs'));

const item = (itemKey: string, o: Record<string, unknown> = {}) => ({ ...request({ type: 'cabin', name: undefined, notes: undefined, maxSize: { x: 64, y: 64, z: 64 } }), itemKey, ...o });
const gr = (o: Record<string, unknown>) => GroupRequest.parse({ name: 'G', bible: 'oak', ...o });

describe('expansion (pure)', () => {
  it('x6 at cap 3 gives 2 archetypes and 4 copies, with the right keys', () => {
    const e = expandItems(gr({ items: [item('house', { count: 6 })] }));
    expect(e.map((x) => [x.itemKey, x.kind, x.copyOf ?? null, x.ordinal ?? null])).toEqual([
      ['house', 'original', null, null],
      ['house#2', 'copy', 'house', 1],
      ['house#3', 'copy', 'house', 2],
      ['house#4', 'original', null, null],
      ['house#5', 'copy', 'house#4', 1],
      ['house#6', 'copy', 'house#4', 2],
    ]);
    expect(e[3]!.note).toMatch(/another design for the same program, not a near-copy of `house`/);
  });
  it('cap 1 gives 6 originals; a landmark x2 gives 2 originals', () => {
    expect(expandItems(gr({ copyCap: 1, items: [item('h', { count: 6 })] })).map((x) => x.kind)).toEqual(Array(6).fill('original'));
    expect(expandItems(gr({ items: [item('hall', { count: 2, role: 'landmark' })] })).map((x) => [x.itemKey, x.kind])).toEqual([['hall', 'original'], ['hall#2', 'original']]);
  });
  it('copyOf: a copy of the archetype, counted toward its cap; every COPY_REFUSED detail', () => {
    const e = expandItems(gr({ items: [item('a'), item('b', { copyOf: 'a' }), item('c', { copyOf: 'b' })] }));
    expect(e.map((x) => [x.itemKey, x.kind, x.copyOf ?? null, x.ordinal ?? null])).toEqual([['a', 'original', null, null], ['b', 'copy', 'a', 1], ['c', 'copy', 'a', 2]]);
    const detail = (o: Record<string, unknown>) => {
      try {
        expandItems(gr(o));
      } catch (err) {
        expect(err).toBeInstanceOf(RefusedError);
        return [(err as RefusedError).code, (err as RefusedError).detail];
      }
      return undefined;
    };
    expect(detail({ items: [item('hall', { role: 'landmark' }), item('b', { copyOf: 'hall' })] })).toEqual(['COPY_REFUSED', 'landmark']);
    expect(detail({ items: [item('a'), item('b', { copyOf: 'zz' })] })).toEqual(['COPY_REFUSED', 'unknown']);
    expect(detail({ items: [item('a'), item('b', { copyOf: 'b' })] })).toEqual(['COPY_REFUSED', 'self']);
    expect(detail({ items: [item('a', { count: 3 }), item('b', { copyOf: 'a' })] })).toEqual(['COPY_REFUSED', 'cap']);
    // no count, no copyOf: exactly as before
    expect(expandItems(gr({ items: [item('x'), item('y')] })).map((x) => [x.itemKey, x.kind, x.effort])).toEqual([['x', 'original', 'standard'], ['y', 'original', 'standard']]);
  });
  it('C2 and C8: the size rule, the effort, the critique', () => {
    expect(fitsSmall({ x: 11, z: 9 })).toBe(true);
    expect(fitsSmall({ x: 9, z: 11 })).toBe(true);
    expect(fitsSmall({ x: 11, z: 10 })).toBe(false);
    expect(itemEffort({ effort: undefined, maxSize: { x: 9, y: 9, z: 9 } } as never, true)).toBe('small');
    expect(itemEffort({ effort: undefined, maxSize: { x: 9, y: 9, z: 9 } } as never, false)).toBe('standard');
    expect(itemEffort({ effort: 'standard', maxSize: { x: 9, y: 9, z: 9 } } as never, true)).toBe('standard');
    expect(itemEffort({ effort: 'small', maxSize: { x: 30, y: 9, z: 30 } } as never, false)).toBe('small');
    const report = { mode: 'report' } as never;
    expect(itemCritique(undefined, report, 'small')).toBeUndefined();
    expect(itemCritique(report, report, 'small')).toBe(report);
    expect(itemCritique(undefined, report, 'standard')).toBe(report);
  });
});

interface H {
  root: string;
  sc: Sidecar;
  events: Outbound[];
  close(keep?: boolean): Promise<void>;
}

async function harness(over: Partial<Config> = {}, root = tempDir('arch-0b-')): Promise<H> {
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
  cfg.simStepMs = 15;
  Object.assign(cfg, over);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
  const events: Outbound[] = [];
  sc.subscribe((m) => events.push(m));
  await sc.start(new SimDesigner(sc, cfg.simStepMs));
  return { root, sc, events, close: async (keep = false) => { await sc.close(); if (!keep) rmrf(root); } };
}

const groupDone = (h: H, id: string, ms = 90_000) => until(() => ['done', 'failed', 'cancelled'].includes(h.sc.groups.get(id)!.status), ms);
const readEntry = (h: H, id: string) => JSON.parse(fs.readFileSync(path.join(h.sc.config.libraryDir, id, `${id}.blueprint.json`), 'utf8')) as Record<string, unknown>;

describe.skipIf(!hasKit)('copies in a group (sim backend, real kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('an x3 item: one design, two $0 copies built from it; derivation COPY rebuilds byte-identically', async () => {
    h = await harness();
    const g = h.sc.groups.create(gr({ items: [item('house', { count: 3 })] }));
    expect(g.items.map((i) => [i.itemKey, i.kind ?? 'original', i.designId === '' ? 'no design' : 'design', i.stage ?? null])).toEqual([['house', 'original', 'design', null], ['house#2', 'copy', 'no design', 'copy'], ['house#3', 'copy', 'no design', 'copy']]);
    await groupDone(h, g.id);
    const f = h.sc.groups.get(g.id)!;
    expect(f).toMatchObject({ status: 'done', done: 3, failed: 0 });
    const [a, c2, c3] = f.items;
    expect(c2!.entryId && c3!.entryId).toBeTruthy();
    expect(c2!.cost.usd).toBe(0);
    // the breakdown's COPY line: $0, time only, one per copy
    expect(f.breakdown?.stages.copy).toMatchObject({ usd: 0, count: 2 });
    expect(f.breakdown!.stages.copy!.ms).toBeGreaterThan(0);
    for (const c of [c2!, c3!]) {
      const e = readEntry(h, c.entryId!);
      expect(e).toMatchObject({ variantOf: a!.entryId, variantOfVersion: 1, group: g.id, groupItem: c.itemKey, derivation: { source: a!.entryId, sourceVersion: 1, kind: 'copy' } });
      const recipe = (e.derivation as { recipe: { roles: Record<string, string>; values: Record<string, unknown>; mirror: boolean; bar?: boolean } }).recipe;
      expect(recipe.bar).toBe(true);
      // the recipe rebuilds the copy from the source version, byte for byte
      const tmp = tempDir('arch-0b-rebuild-');
      try {
        fs.cpSync(KIT, path.join(tmp, 'kit'), { recursive: true, filter: (p) => !/[\\/](out|node_modules)([\\/]|$)/.test(p) });
        const src = fs.readFileSync(path.join(h.sc.config.libraryDir, a!.entryId!, `${a!.entryId}.mjs`), 'utf8').replace(new RegExp(`\\b${a!.entryId}\\b`, 'g'), c.entryId!).replace(/(['"])(?:\.\.?\/)+(?:[^'"\n]*\/)?lib\/([\w.-]+\.mjs)\1/g, '$1../lib/$2$1');
        fs.writeFileSync(path.join(tmp, 'kit', 'designs', `${c.entryId}.mjs`), src);
        if (fs.existsSync(path.join(h.sc.config.libraryDir, a!.entryId!, 'bible'))) fs.cpSync(path.join(h.sc.config.libraryDir, a!.entryId!, 'bible'), path.join(tmp, 'bible'), { recursive: true });
        const bib = (e.bible as { id: string; version: number });
        fs.writeFileSync(path.join(tmp, 'b.json'), JSON.stringify({ id: bib.id, version: bib.version, roles: recipe.roles }));
        execFileSync('node', [path.join('kit', 'build.mjs'), c.entryId!, '--out', 'out', '--bible', 'b.json', '--values', JSON.stringify(recipe.values), ...(recipe.mirror ? ['--mirror'] : []), '--json'], { cwd: tmp });
        expect(fs.readFileSync(path.join(tmp, 'out', `${c.entryId}.nbt`)).equals(fs.readFileSync(path.join(h.sc.config.libraryDir, c.entryId!, `${c.entryId}.nbt`)))).toBe(true);
      } finally {
        rmrf(tmp);
      }
    }
    // (§2.4) a COPY entry refuses polish (VERSION_REFUSED, copy)
    try {
      h.sc.polishes.request(c2!.entryId!, {});
      throw new Error('not refused');
    } catch (err) {
      expect(err).toMatchObject({ code: 'VERSION_REFUSED', detail: 'copy' });
    }
    // the two copies differ (the first mirrored, the second not)
    const r2 = (readEntry(h, c2!.entryId!).derivation as { recipe: { mirror: boolean } }).recipe;
    const r3 = (readEntry(h, c3!.entryId!).derivation as { recipe: { mirror: boolean } }).recipe;
    expect([r2.mirror, r3.mirror]).toEqual([true, false]);
  }, 120_000);

  it('fallback: sim:copyfail and sim:copysize make the copy a FALLBACK original with the reason', async () => {
    h = await harness();
    const g = h.sc.groups.create(gr({ items: [item('a'), item('b', { copyOf: 'a', notes: 'sim:copyfail' }), item('c', { copyOf: 'a', notes: 'sim:copysize' })] }));
    await groupDone(h, g.id);
    const f = h.sc.groups.get(g.id)!;
    expect(f.status).toBe('done');
    const [, b, c] = f.items;
    expect(b).toMatchObject({ kind: 'fallback', status: 'done', copyOf: 'a' });
    expect(b!.fallbackReason).toMatch(/^check: /);
    expect(c!.fallbackReason).toMatch(/^size: /);
    expect(h.sc.designs.get(b!.designId)!.request.itemKey).toBe('b');
  }, 120_000);

  it('massingFirst: the archetype\'s approval covers its copies; a dropped archetype fails its copies with source_failed; a fallback binds the approved massing', async () => {
    h = await harness();
    const g = h.sc.groups.create(gr({ massingFirst: true, items: [item('a', { count: 2 }), item('z', { count: 2, type: 'tower' }), item('k', { copyOf: 'a', notes: 'sim:copyfail' })] }));
    expect(g.items.filter((i) => i.kind === 'copy').map((i) => i.itemKey)).toEqual(['a#2', 'z#2', 'k']);
    await until(() => h!.sc.groups.get(g.id)!.status === 'awaiting_approval', 30_000);
    expect(h.sc.groups.get(g.id)!.awaiting).toEqual(['a', 'z']);
    const designsBefore = h.sc.designs.list().length;
    h.sc.groups.approve(g.id, { approve: ['a'], redirect: {}, cancel: ['z'] });
    await groupDone(h, g.id);
    const f = h.sc.groups.get(g.id)!;
    const by = (k: string) => f.items.find((i) => i.itemKey === k)!;
    expect(by('a#2')).toMatchObject({ kind: 'copy', status: 'done' });
    expect(by('z#2')).toMatchObject({ status: 'failed', error: 'source_failed' });
    expect(by('k')).toMatchObject({ kind: 'fallback', status: 'done', stage: 'detail' });
    const fb = h.sc.designs.get(by('k').designId)!;
    expect(fb.request).toMatchObject({ fromMassing: by('a').massing!.id, massingVersion: by('a').massing!.version });
    // no new massing: only the detail passes of a and k were made after the approval
    expect(h.sc.designs.list().length - designsBefore).toBe(2);
    // the copy of a mirrored copy conforms to the mirrored massing
    expect(readEntry(h, by('a#2').entryId!).fromMassing).toBeUndefined();
  }, 120_000);

  it('promoteCopy: a done copy becomes a FALLBACK original; refused for a non-copy, a copy still building, a final group', async () => {
    h = await harness({ designConcurrency: 1 });
    const g = h.sc.groups.create(gr({ concurrency: 1, items: [item('a', { count: 2 }), item('slow')] }));
    await until(() => h!.sc.groups.get(g.id)!.items[1]!.status === 'done', 60_000);
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as RefusedError).detail ?? (e as Error).message;
      }
      return undefined;
    };
    expect(code(() => h!.sc.groups.promoteCopy(g.id, 'a', 'x'))).toBe('not_copy');
    h.sc.groups.promoteCopy(g.id, 'a#2', 'fitToLot failed: too deep');
    const it = h.sc.groups.get(g.id)!.items[1]!;
    expect(it).toMatchObject({ kind: 'fallback', fallbackReason: 'promoted: fitToLot failed: too deep' });
    expect(it.designId).not.toBe('');
    await groupDone(h, g.id);
    expect(h.sc.groups.get(g.id)!.items[1]!.status).toBe('done');
    expect(code(() => h!.sc.groups.promoteCopy(g.id, 'a#2', 'x'))).toBe('final');
  }, 120_000);

  it('copies run while the group is paused_budget', async () => {
    h = await harness({ designConcurrency: 1, simDesignUsd: 0.1 });
    // the archetype costs $0.3 of $0.35 (soft at 80%): the group pauses; its copies still build ($0)
    const g = h.sc.groups.create(gr({ budgetUsd: 0.35, concurrency: 1, items: [item('a', { count: 3 }), item('b')] }));
    await until(() => h!.sc.groups.get(g.id)!.status === 'paused_budget', 60_000);
    await until(() => h!.sc.groups.get(g.id)!.items.slice(1, 3).every((i) => i.status === 'done'), 60_000);
    const f = h.sc.groups.get(g.id)!;
    expect(f.status).toBe('paused_budget');
    expect(f.items[3]!.status).toBe('queued');
    h.sc.groups.cancel(g.id);
  }, 120_000);

  it('smallBySize: a small item drops the default report critique and asks for the SMALL pass; an explicit critique wins', async () => {
    h = await harness();
    const g = h.sc.groups.create(gr({ smallBySize: true, critique: { mode: 'report' }, items: [item('shed', { maxSize: { x: 11, y: 12, z: 9 } }), item('well', { maxSize: { x: 9, y: 12, z: 9 }, critique: { mode: 'report' } }), item('hall', { maxSize: { x: 30, y: 20, z: 30 } })] }));
    const req = (k: string) => h!.sc.designs.get(g.items.find((i) => i.itemKey === k)!.designId)!.request;
    expect(req('shed').critique).toBeUndefined();
    expect(req('shed').effort).toBe('small');
    expect(req('well').critique?.mode).toBe('report');
    expect(req('hall').critique?.mode).toBe('report');
    expect(req('hall').effort).toBeUndefined();
    expect(g.items.map((i) => i.effort ?? 'standard')).toEqual(['small', 'small', 'standard']);
    h.sc.groups.cancel(g.id);
  }, 60_000);

  it('C8: two sim:repair fail a SMALL item at round 2 (rounds); a STANDARD one repairs twice and passes; the SMALL brief composes from smalls.mjs', async () => {
    h = await harness();
    const g = h.sc.groups.create(gr({ items: [item('s', { effort: 'small', notes: 'sim:repair sim:repair' }), item('t', { notes: 'sim:repair sim:repair' })] }));
    await groupDone(h, g.id);
    const f = h.sc.groups.get(g.id)!;
    expect(f.items[0]).toMatchObject({ status: 'failed', effort: 'small' });
    expect(f.items[0]!.error).toMatch(/^rounds: the SMALL pass used its 2 rounds/);
    expect(f.items[1]!.status).toBe('done');
    const brief = fs.readFileSync(path.join(h.sc.config.dataDir, 'designs', f.items[0]!.designId, 'BRIEF.md'), 'utf8');
    expect(brief).toContain('## A small building (the SMALL pass: 2 rounds, 40 turns each)');
    expect(brief).toContain('kit/lib/smalls.mjs');
    const other = fs.readFileSync(path.join(h.sc.config.dataDir, 'designs', f.items[1]!.designId, 'BRIEF.md'), 'utf8');
    expect(other).not.toContain('A small building');
  }, 60_000);

  it('estimates: COPY $0, SMALL with its caps in the basis, CHANGE from the polish seed', async () => {
    h = await harness();
    const ctx = (h.sc as unknown as { estimateCtx(): never }).estimateCtx();
    const e = h.sc.estimates.mix({ group: gr({ smallBySize: true, massingFirst: true, critique: { mode: 'report' }, items: [item('m', { count: 3 }), item('shed', { maxSize: { x: 9, y: 12, z: 9 } })] }), originals: 0, adapted: 0, copies: 0, newBible: true, massingFirst: true, reportCritique: true }, ctx);
    expect(e.byKind.original!.count).toBe(1);
    expect(e.byKind.copy).toMatchObject({ count: 2, usdLow: 0, usdHigh: 0 });
    expect(e.byKind.small!.count).toBe(1);
    expect(e.byKind.small!.basis).toMatch(/2 rounds, 40 turns, effort medium/);
    const sum = Object.values(e.byKind).reduce((a, l) => a + l!.usdHigh, 0);
    expect(e.usdHigh).toBeCloseTo(sum, 1);
    const c = h.sc.estimates.mix({ originals: 0, adapted: 0, copies: 0, newBible: false, massingFirst: false, reportCritique: false, changes: 1 }, ctx);
    expect(c.byKind.change).toMatchObject({ usdLow: 0.4, usdHigh: 1.2, count: 1 });
  }, 30_000);
});
