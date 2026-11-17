// Slice CM-b (docs/CONTRACT.md "Phase 7c" §3 row 6): a design job may return a Composite (the kit's, past the cap). The sim's
// `sim:composite` returns the hand-written castle; it installs as ONE library entry (the union, its CompositeInfo wire in ext and its
// manifest beside it) with hidden module entries (`<id>__<m>`, `compositeOf`), so a design group item stays one entry: Steward's
// `itemKey == lotId` binding (S-7c-6, Steward's change 4).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { COMPOSITE_EXT, compositeRole, rewriteCompositeWire } from '../src/designs.js';
import { RefusedError } from '../src/errors.js';
import { allowsComposite, EXT_ALLOW_COMPOSITE, GroupRequest } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'designs', 'composite', 'castle.mjs'));

interface H {
  sc: Sidecar;
  close(): Promise<void>;
}

async function harness(over: Partial<Config> = {}, root = tempDir('arch-cmb-')): Promise<H> {
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
  cfg.simStepMs = 10;
  Object.assign(cfg, over);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
  await sc.start(new SimDesigner(sc, cfg.simStepMs));
  return { sc, close: async () => { await sc.close(); rmrf(root); } };
}

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;

describe('rewriteCompositeWire (pure)', () => {
  it('rewrites module entry ids in modules and joints, nothing else', () => {
    const w = { modules: ['castle__west', 'castle__east'], joints: [{ from: { module: 'castle__west', port: 'arch_e' }, to: { module: 'castle__east', port: 'arch_w' } }], union: { minX: 0 } };
    expect(rewriteCompositeWire(w, 'castle', 'castle_2')).toEqual({ modules: ['castle_2__west', 'castle_2__east'], joints: [{ from: { module: 'castle_2__west', port: 'arch_e' }, to: { module: 'castle_2__east', port: 'arch_w' } }], union: { minX: 0 } });
  });
});

describe('allowsComposite (7c SR, pure)', () => {
  it('only ext architect_mc:allowComposite exactly true', () => {
    expect(EXT_ALLOW_COMPOSITE).toBe('architect_mc:allowComposite');
    expect(allowsComposite({})).toBe(false);
    expect(allowsComposite({ ext: {} })).toBe(false);
    expect(allowsComposite({ ext: { [EXT_ALLOW_COMPOSITE]: 'true' } })).toBe(false);
    expect(allowsComposite({ ext: { [EXT_ALLOW_COMPOSITE]: false } })).toBe(false);
    expect(allowsComposite({ ext: { [EXT_ALLOW_COMPOSITE]: true } })).toBe(true);
  });
});

describe.skipIf(!hasKit)('a design job returning a Composite (sim backend, real kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('one group item, one entry: the composite; its modules hidden, unbound, rewritten to the installed id', async () => {
    h = await harness();
    const lib = h.sc.config.libraryDir;
    const item = { ...request({ type: 'castle', name: 'Keep', notes: undefined, maxSize: { x: 96, y: 64, z: 96 } }), itemKey: 'lot_keep', ext: { 'architect:sim': 'composite', lot: 'keep', [EXT_ALLOW_COMPOSITE]: true } };
    const g = h.sc.groups.create(GroupRequest.parse({ name: 'C', bible: 'oak', items: [item] }));
    await until(() => ['done', 'failed', 'cancelled'].includes(h!.sc.groups.get(g.id)!.status), 600_000);
    const f = h.sc.groups.get(g.id)!;
    expect(f.items.map((i) => i.error ?? null)).toEqual([null]);
    expect(f).toMatchObject({ status: 'done', done: 1, failed: 0 });
    expect(f.items).toHaveLength(1);
    const it0 = f.items[0]!;
    expect(it0.itemKey).toBe('lot_keep');
    const id = it0.entryId!;
    expect(id).toBeTruthy();
    const e = readJson(path.join(lib, id, `${id}.blueprint.json`));
    expect(e).toMatchObject({ id, group: g.id, groupItem: 'lot_keep', size: { x: 121, y: 15, z: 27 } });
    const ext = e.ext as Record<string, unknown>;
    expect(ext.lot).toBe('keep'); // the request's ext is kept beside the wire
    const wire = ext[COMPOSITE_EXT] as { modules: string[]; joints: Array<{ from: { module: string }; to: { module: string } }> };
    expect(wire.modules).toEqual([`${id}__west`, `${id}__centre`, `${id}__east`]);
    expect(wire.joints.flatMap((j) => [j.from.module, j.to.module])).toEqual([`${id}__west`, `${id}__centre`, `${id}__centre`, `${id}__east`]);
    const man = readJson(path.join(lib, id, `${id}.composite.json`)) as { id: string; entryId: string; modules: Array<{ id: string; entryId: string; at: number[] }> };
    expect(man).toMatchObject({ id, entryId: id });
    expect(man.modules.map((m) => [m.id, m.entryId, m.at[0]])).toEqual([['west', `${id}__west`, 0], ['centre', `${id}__centre`, 40], ['east', `${id}__east`, 80]]);
    for (const m of ['west', 'centre', 'east']) {
      const mid = `${id}__${m}`;
      const j = readJson(path.join(lib, mid, `${mid}.blueprint.json`));
      expect(j).toMatchObject({ id: mid, compositeOf: id, version: 1, size: { x: 41, y: 15, z: 27 } });
      // no binding on a module: Steward's itemKey == lotId sees exactly one entry for the item
      expect(j.group).toBeUndefined();
      expect(j.groupItem).toBeUndefined();
      expect((j.ext as Record<string, unknown> | undefined)?.[COMPOSITE_EXT]).toBeUndefined();
      expect(fs.existsSync(path.join(lib, mid, `${mid}.nbt`))).toBe(true);
    }
    // exactly one library entry is bound to the item
    const bound = fs.readdirSync(lib).filter((d) => {
      const p = path.join(lib, d, `${d}.blueprint.json`);
      return fs.existsSync(p) && readJson(p).groupItem === 'lot_keep';
    });
    expect(bound).toEqual([id]);
    // (7c SR) the flag is the item's own: the design's request carries it, and its check limits allow the composite
    const d = h.sc.designs.get(it0.designId)!;
    expect(d.request.ext?.[EXT_ALLOW_COMPOSITE]).toBe(true);
    expect(h.sc.checkPlan(d).limits.allowComposite).toBe(true);
  }, 600_000);

  it('(7c CS) a composite gets no new versions (polish, versionOf, revert, follow refused composite); a re-skin variant is a new composite with the flag', async () => {
    h = await harness();
    const lib = h.sc.config.libraryDir;
    const item = { ...request({ type: 'castle', name: 'Keep', notes: undefined, maxSize: { x: 96, y: 64, z: 96 } }), itemKey: 'lot_keep', ext: { 'architect:sim': 'composite', [EXT_ALLOW_COMPOSITE]: true } };
    const g = h.sc.groups.create(GroupRequest.parse({ name: 'C', bible: 'oak', items: [item] }));
    await until(() => ['done', 'failed', 'cancelled'].includes(h!.sc.groups.get(g.id)!.status), 600_000);
    const id = h.sc.groups.get(g.id)!.items[0]!.entryId!;
    expect(id).toBeTruthy();
    const mid = `${id}__west`;
    expect(compositeRole(readJson(path.join(lib, id, `${id}.blueprint.json`)))).toBe('composite');
    expect(compositeRole(readJson(path.join(lib, mid, `${mid}.blueprint.json`)))).toBe('module');
    const refusal = (f: () => unknown): [string, string] => {
      try {
        f();
      } catch (e) {
        if (e instanceof RefusedError) return [e.code, e.detail];
        throw e;
      }
      throw new Error('not refused');
    };
    for (const e of [id, mid]) {
      expect(refusal(() => h!.sc.polishes.request(e, {}))).toEqual(['VERSION_REFUSED', 'composite']);
      expect(refusal(() => h!.sc.requestDesign(request({ type: 'castle', notes: 'taller towers', versionOf: { entryId: e } })))).toEqual(['VERSION_REFUSED', 'composite']);
      expect(refusal(() => h!.sc.versions.revert(e, 1))).toEqual(['VERSION_REFUSED', 'composite']);
      expect(refusal(() => h!.sc.follows.follow(e, 0))).toEqual(['NOT_ALLOWED', 'composite']);
    }
    // a hidden module is no variant source
    expect(() => h!.sc.requestVariant(mid, 'desert')).toThrow(/hidden module of composite/);
    // a re-palette of the composite (its request allows one): built again as a composite, a new entry with its own module entries
    const v = h.sc.requestVariant(id, 'desert');
    await until(() => ['done', 'failed'].includes(h!.sc.variants.get(v.id)!.status), 600_000);
    const vf = h.sc.variants.get(v.id)!;
    expect(vf.error ?? null).toBeNull();
    const vid = vf.blueprintId!;
    expect(vid).not.toBe(id);
    const ve = readJson(path.join(lib, vid, `${vid}.blueprint.json`));
    expect(ve).toMatchObject({ id: vid, variantOf: id, size: { x: 121, y: 15, z: 27 } });
    const vw = (ve.ext as Record<string, unknown>)[COMPOSITE_EXT] as { modules: string[] };
    expect(vw.modules).toEqual([`${vid}__west`, `${vid}__centre`, `${vid}__east`]);
    for (const m of vw.modules) expect(readJson(path.join(lib, m, `${m}.blueprint.json`))).toMatchObject({ id: m, compositeOf: vid, version: 1 });
    expect(fs.existsSync(path.join(lib, vid, `${vid}.composite.json`))).toBe(true);
  }, 600_000);

  it('(7c SR) without allowComposite a Composite return is refused in the check round: past maxSize, the item fails, nothing installs', async () => {
    h = await harness();
    const lib = h.sc.config.libraryDir;
    const item = { ...request({ type: 'castle', name: 'Keep', notes: undefined, maxSize: { x: 96, y: 64, z: 96 } }), itemKey: 'lot_keep', ext: { 'architect:sim': 'composite', lot: 'keep' } };
    // the group's own ext never reaches an item
    const g = h.sc.groups.create(GroupRequest.parse({ name: 'C', bible: 'oak', ext: { [EXT_ALLOW_COMPOSITE]: true }, items: [item] }));
    const d0 = h.sc.designs.get(h.sc.groups.get(g.id)!.items[0]!.designId)!;
    expect(d0.request.ext?.[EXT_ALLOW_COMPOSITE]).toBeUndefined();
    expect(h.sc.checkPlan(d0).limits.allowComposite).toBeUndefined();
    await until(() => ['done', 'failed', 'cancelled'].includes(h!.sc.groups.get(g.id)!.status), 600_000);
    const f = h.sc.groups.get(g.id)!;
    expect(f.done).toBe(0);
    const err = f.items[0]!.error ?? h.sc.designs.get(f.items[0]!.designId)?.error ?? '';
    expect(err).toMatch(/size 121x15x27 is past maxSize 96x64x96; a composite needs allowComposite/);
    expect(f.items[0]!.entryId).toBeFalsy();
    const bound = fs.existsSync(lib) ? fs.readdirSync(lib).filter((x) => fs.existsSync(path.join(lib, x, `${x}.blueprint.json`))) : [];
    expect(bound).toEqual([]);
  }, 600_000);
});
