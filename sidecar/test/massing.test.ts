// Phase 4c with the sim backend: massing jobs (installed versioned under <massings>/<id>/, the Massing record), redirects,
// the detail pass from a massing (conformance pass, the hard size cap failing it), groups with massingFirst (waves of
// massings, awaiting_approval, approve 2 / redirect 1, the owner-only approval, the redirect cap, the group context in every
// brief, massings counting toward the budget, a restart mid-approval), garbage collection and delete, estimates and the
// protocol-1 filter. Runs on the fixture kit, and again on the REAL kit (../kit, its example massings) when it has
// lib/massing.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { GC_DETAILED_MS, GC_GROUP_MS, GC_UNDETAILED_MS, detailMax } from '../src/massings.js';
import { DesignRequest, GroupRequest, toProtocol1, type Design, type Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner, simRedirect } from '../src/sim.js';
import { Store } from '../src/store.js';
import { copyKit, request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const REAL_KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasRealKit = fs.existsSync(path.join(REAL_KIT, 'lib', 'massing.mjs')) && fs.existsSync(path.join(REAL_KIT, 'massings'));

interface H {
  root: string;
  sc: Sidecar;
  events: Outbound[];
  now: { t: number | undefined };
  close(keep?: boolean): Promise<void>;
}

/** A sim sidecar; `kit` 'fixture' copies the fixture kit into the root (tests may change it), 'real' uses ../kit. */
async function harness(kit: 'fixture' | 'real', over: Partial<Config> = {}, root = tempDir('arch-4c-')): Promise<H> {
  const kitDir = kit === 'real' ? REAL_KIT : fs.existsSync(path.join(root, 'kit')) ? path.join(root, 'kit') : copyKit(root);
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', kitDir, '--backend', 'sim'], {});
  cfg.simStepMs = 10;
  Object.assign(cfg, over);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const now: { t: number | undefined } = { t: undefined };
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger(), () => now.t ?? Date.now());
  const events: Outbound[] = [];
  sc.subscribe((m) => events.push(m));
  await sc.start(new SimDesigner(sc, cfg.simStepMs));
  return {
    root,
    sc,
    events,
    now,
    close: async (keep = false) => {
      await sc.close();
      if (!keep) rmrf(root);
    },
  };
}

const finished = (h: H, id: string, ms = 30_000) => until(() => ['done', 'failed', 'cancelled'].includes(h.sc.designs.get(id)!.status), ms);
const groupIs = (h: H, id: string, ...st: string[]) => until(() => st.includes(h.sc.groups.get(id)!.status), 60_000);
const json = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const massingReq = (o: Record<string, unknown> = {}) => DesignRequest.parse(request({ name: 'Lakeside Cabin', massing: true, maxSize: { x: 40, y: 30, z: 40 }, ...o }));
const item = (itemKey: string, o: Record<string, unknown> = {}) => ({ ...request({ type: 'cabin', name: undefined, notes: undefined, maxSize: { x: 40, y: 30, z: 40 } }), itemKey, ...o });

describe('massings (sim backend, fixture kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('a massing job installs a versioned massing (not in the library) with its record; a redirect makes v2 from notes', async () => {
    h = await harness('fixture');
    const d = h.sc.requestDesign(massingReq({ ext: { 'steward_mc:lot': 'L1' }, owner: 'steward_mc:s1', bible: 'rustic' }));
    expect(d.massing).toEqual({ id: 'mas_lakeside_cabin', version: 1 });
    expect(d.request.model).toBe('claude-sonnet-5-5');
    await finished(h, d.id);
    const done = h.sc.designs.get(d.id)!;
    expect(done.status, done.error).toBe('done');
    expect(done.blueprintId).toBeUndefined();
    expect(done.step).toMatch(/massing mas_lakeside_cabin v1 \(11x9x13, 2 masses\)/);
    expect(fs.existsSync(h.sc.config.libraryDir) ? fs.readdirSync(h.sc.config.libraryDir) : []).toEqual([]);
    const top = path.join(h.sc.config.massing.dir, 'mas_lakeside_cabin');
    expect(fs.readdirSync(path.join(top, 'versions', '1')).sort()).toEqual(['bible', 'mas_lakeside_cabin.blueprint.json', 'mas_lakeside_cabin.mjs', 'mas_lakeside_cabin.nbt', 'mas_lakeside_cabin.preview-front.png', 'mas_lakeside_cabin.preview-iso.png', 'mas_lakeside_cabin.preview-top.png']);
    expect(fs.existsSync(path.join(top, 'mas_lakeside_cabin.nbt'))).toBe(true);
    expect(json(path.join(top, 'mas_lakeside_cabin.blueprint.json'))).toMatchObject({ id: 'mas_lakeside_cabin', massing: true, version: 1, type: 'cabin', ext: { 'steward_mc:lot': 'L1' }, bible: { id: 'rustic', version: 1 }, source: 'mas_lakeside_cabin.mjs' });
    const m = h.sc.massings.get('mas_lakeside_cabin')!;
    expect(m).toMatchObject({ id: 'mas_lakeside_cabin', version: 1, versions: [1], designId: d.id, type: 'cabin', owner: 'steward_mc:s1', ext: { 'steward_mc:lot': 'L1' }, bible: { id: 'rustic', version: 1 }, size: { x: 11, y: 9, z: 13 } });
    expect(Object.keys(m.parts)).toEqual(['hall', 'porch']);
    expect(h.events.some((e) => e.type === 'massing.upsert' && e.massing.id === m.id)).toBe(true);
    // a redirect: version 2, from v1 plus notes (the sim grows a wing)
    const r = h.sc.redirectMassing(m.id, 'add a wing to the east');
    expect(r.massing).toEqual({ id: m.id, version: 2 });
    expect(r.request.redirect).toEqual({ fromVersion: 1, notes: 'add a wing to the east' });
    expect(() => h!.sc.redirectMassing(m.id, 'again')).toThrow(/already has a job running/);
    await finished(h, r.id);
    expect(h.sc.designs.get(r.id)!.status, h.sc.designs.get(r.id)!.error).toBe('done');
    const v2 = h.sc.massings.get(m.id)!;
    expect(v2).toMatchObject({ version: 2, versions: [1, 2], redirect: { fromVersion: 1, notes: 'add a wing to the east' }, size: { x: 17, y: 9, z: 13 } });
    expect(Object.keys(v2.parts)).toEqual(['hall', 'porch', 'wing_east']);
    expect(h.sc.massings.get(m.id, 1)!.versions).toEqual([1, 2]);
    expect(json(path.join(top, 'mas_lakeside_cabin.blueprint.json')).version).toBe(2);
    // the redirect's scratch dir had v1 and the notes
    const scratch = path.join(h.sc.config.dataDir, 'designs', r.id);
    expect(fs.existsSync(path.join(scratch, 'massing', 'mas_lakeside_cabin.mjs'))).toBe(true);
    expect(fs.readFileSync(path.join(scratch, 'BRIEF.md'), 'utf8')).toMatch(/## Redirect: from version 1[\s\S]*add a wing to the east/);
    // massing.list: the latest of each, or every version of one
    expect(h.sc.massings.list().map((x) => [x.id, x.version])).toEqual([[m.id, 2]]);
    expect(h.sc.massings.list('steward_mc:other')).toEqual([]);
    expect(h.sc.massings.list(undefined, m.id).map((x) => x.version)).toEqual([1, 2]);
    expect(((h.sc.snapshot() as unknown as { massings: unknown[] }).massings)).toHaveLength(1);
    // a protocol-1 client never sees massing designs
    expect(toProtocol1({ v: 1, type: 'design.upsert', design: h.sc.designs.get(d.id) })).toBeUndefined();
    const snap1 = toProtocol1({ v: 1, ...(h.sc.snapshot(2) as unknown as Record<string, unknown>) }) as { designs: Design[] };
    expect(snap1.designs).toEqual([]);
    expect(() => h!.sc.requestDesign(DesignRequest.parse(request({ redirect: { fromVersion: 1, notes: 'x' } })))).toThrow(/set by massing.redirect/);
    expect(DesignRequest.safeParse(request({ massing: true, fromMassing: 'x' })).success).toBe(false);
  }, 60_000);

  it('the detail pass from a massing conforms; a detail over the massing + 2 fails on the hard cap', async () => {
    h = await harness('fixture');
    const d = h.sc.requestDesign(massingReq({ context: 'a lakeside lot, the street to the south' }));
    await finished(h, d.id);
    const id = d.massing!.id;
    const det = h.sc.requestDesign(DesignRequest.parse(request({ name: 'Lakeside Cabin', fromMassing: id, maxSize: { x: 40, y: 30, z: 40 } })));
    expect(det.request.massingVersion).toBe(1);
    await finished(h, det.id);
    const done = h.sc.designs.get(det.id)!;
    expect(done.status, done.error).toBe('done');
    expect(done.conformance).toEqual({ ok: true, errors: [], issues: [] });
    expect(json(path.join(h.sc.config.libraryDir, done.blueprintId!, `${done.blueprintId}.blueprint.json`))).toMatchObject({ fromMassing: { id, version: 1 } });
    expect(h.sc.massings.get(id)!.detail).toMatchObject({ designId: det.id, status: 'done', entryId: done.blueprintId });
    // the scratch dir: the massing's files, the binding section, the hard cap in the build command
    const scratch = path.join(h.sc.config.dataDir, 'designs', det.id);
    expect(fs.readdirSync(path.join(scratch, 'massing')).sort()).toEqual([`${id}.blueprint.json`, `${id}.mjs`, `${id}.preview-front.png`, `${id}.preview-iso.png`, `${id}.preview-top.png`]);
    const brief = fs.readFileSync(path.join(scratch, 'BRIEF.md'), 'utf8');
    expect(brief).toContain(`## The approved massing (binding): \`${id}\` v1`);
    expect(brief).toContain('`hall`: box [0, 0, 0, 10, 8, 9], roof gable');
    expect(brief).toContain(`--max 13,11,15 --type cabin --massing massing/${id}.blueprint.json`);
    expect(detailMax({ x: 11, y: 9, z: 13 }, { x: 40, y: 10, z: 40 })).toEqual({ x: 13, y: 10, z: 15 });
    // (the massing's own brief had its context; a detail pass gets its own request's)
    expect(fs.readFileSync(path.join(h.sc.config.dataDir, 'designs', d.id, 'BRIEF.md'), 'utf8')).toContain('a lakeside lot, the street to the south');
    // a detail too tall for the massing: the kit's example cabin with 3 floors (y 17 > 9 + 2)
    const ex = path.join(h.sc.config.kitDir, 'designs', 'cabin.mjs');
    fs.writeFileSync(ex, fs.readFileSync(ex, 'utf8').replace("default: 1, label: 'Floors'", "default: 3, label: 'Floors'").replace('floors = 1', 'floors = 3'));
    const bad = h.sc.requestDesign(DesignRequest.parse(request({ fromMassing: id, maxSize: { x: 40, y: 30, z: 40 } })));
    await finished(h, bad.id);
    const f = h.sc.designs.get(bad.id)!;
    expect(f.status).toBe('failed');
    expect(f.error).toMatch(/size .*y 17|exceeds/);
    expect(f.conformance).toMatchObject({ ok: false, errors: [expect.stringMatching(/size y 17 is over the massing's 9 \+ 2/)] });
    // massing: false (a Java boolean) is an ordinary design
    const plain = h.sc.requestDesign(DesignRequest.parse(request({ massing: false, name: 'Plain', maxSize: { x: 40, y: 30, z: 40 } })));
    expect(plain.massing).toBeUndefined();
    await finished(h, plain.id);
    expect(h.sc.designs.get(plain.id)).toMatchObject({ status: 'done', blueprintId: 'gen_plain' });
    // refusals: an unknown massing, a group's massing
    expect(() => h!.sc.requestDesign(DesignRequest.parse(request({ fromMassing: 'mas_nope' })))).toThrow(/no massing "mas_nope"/);
  }, 60_000);

  it('conformance issues alone never fail a detail round; only errors (the size cap) do', async () => {
    h = await harness('fixture');
    const d = { id: 'dx', request: { ...massingReq({ massing: false }), fromMassing: 'mas_x' } } as unknown as Design;
    const res = (conformance: { ok: boolean; errors: string[]; issues: string[] }) => ({ ok: true, conformance }) as never;
    expect(h.sc.checkOutcome(d, res({ ok: false, errors: [], issues: ['massing: part `tower` roof hip, detail gable'] }))).toBeUndefined();
    expect(h.sc.checkOutcome(d, res({ ok: false, errors: ['massing: size 30x20x20 exceeds the massing 22x20x20 + 2'], issues: [] }))).toMatch(/conformance check failed:\n- massing: size/);
  });

  it('garbage collection: 30 days undetailed, 7 days after the detail, 7 days after the group is final; delete is immediate unless in use', async () => {
    h = await harness('fixture');
    const a = h.sc.requestDesign(massingReq({ name: 'Alpha' }));
    const b = h.sc.requestDesign(massingReq({ name: 'Beta' }));
    await finished(h, a.id);
    await finished(h, b.id);
    const det = h.sc.requestDesign(DesignRequest.parse(request({ fromMassing: 'mas_beta', maxSize: { x: 40, y: 30, z: 40 } })));
    // in use: a detail pass is running from it
    expect(() => h!.sc.massings.delete('mas_beta')).toThrow(/in use: design d3 is detailing it/);
    await finished(h, det.id);
    const t0 = Date.now();
    expect(h.sc.massings.gc(t0 + GC_DETAILED_MS - 60_000)).toEqual([]);
    expect(h.sc.massings.gc(t0 + GC_DETAILED_MS + 60_000)).toEqual(['mas_beta']);
    expect(fs.existsSync(path.join(h.sc.config.massing.dir, 'mas_beta'))).toBe(false);
    expect(h.events.some((e) => e.type === 'massing.removed' && e.massingId === 'mas_beta' && e.reason === 'gc')).toBe(true);
    expect(h.sc.massings.gc(t0 + GC_UNDETAILED_MS - 60_000)).toEqual([]);
    expect(h.sc.massings.gc(t0 + GC_UNDETAILED_MS + 60_000)).toEqual(['mas_alpha']);
    // a group's massings: kept while the group runs, 7 days after it is final
    const g = h.sc.groups.create(GroupRequest.parse({ name: 'Set', bible: 'rustic', massingFirst: true, items: [item('one'), item('two')] }));
    await groupIs(h, g.id, 'awaiting_approval');
    const ids = h.sc.groups.get(g.id)!.items.map((it) => it.massing!.id);
    expect(h.sc.massings.gc(t0 + 100 * GC_UNDETAILED_MS)).toEqual([]);
    expect(() => h!.sc.massings.delete(ids[0]!)).toThrow(/its group g1 is not finished/);
    h.sc.groups.cancel(g.id);
    await groupIs(h, g.id, 'cancelled');
    const at = h.sc.groups.get(g.id)!.updatedAt;
    expect(h.sc.massings.gc(at + GC_GROUP_MS - 1000)).toEqual([]);
    expect(h.sc.massings.gc(at + GC_GROUP_MS + 1000).sort()).toEqual([...ids].sort());
    // delete: immediate
    const c = h.sc.requestDesign(massingReq({ name: 'Gamma' }));
    await finished(h, c.id);
    expect(h.sc.massings.delete('mas_gamma')).toBe(1);
    expect(h.sc.massings.get('mas_gamma')).toBeUndefined();
    expect(fs.existsSync(path.join(h.sc.config.massing.dir, 'mas_gamma'))).toBe(false);
    expect(() => h!.sc.massings.delete('mas_gamma')).toThrow(/no massing/);
  }, 60_000);

  it('estimates: a massing ($0.10-0.40, 1-3 min), and a massingFirst group adds the massing pass', () => {
    const root = tempDir();
    const cfg = loadConfig(['--data', path.join(root, 'd'), '--library', path.join(root, 'l'), '--kit', root], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    try {
      expect(sc.estimates.design(massingReq(), sc.estimateCtx())).toMatchObject({ usdLow: 0.1, usdHigh: 0.4, minutesLow: 1, minutesHigh: 3 });
      const items = [item('a', { role: 'landmark', anchor: true }), item('b'), item('c')];
      const plain = sc.estimates.group(GroupRequest.parse({ name: 'x', bible: 'rustic', items }), sc.estimateCtx());
      const first = sc.estimates.group(GroupRequest.parse({ name: 'x', bible: 'rustic', items, massingFirst: true }), sc.estimateCtx());
      expect(first.usdLow).toBeCloseTo(plain.usdLow + 3 * 0.1, 5);
      expect(first.usdHigh).toBeCloseTo(plain.usdHigh + 3 * 0.4, 5);
      // two waves of massings (the anchor, then two at once): 2 x 1-3 min more
      expect(first.minutesLow).toBeCloseTo(plain.minutesLow + 2, 5);
      expect(first.minutesHigh).toBeCloseTo(plain.minutesHigh + 6, 5);
      expect(first.basis).toMatch(/massing first: 3 massings/);
      sc.estimates.record('massing', 'claude-sonnet-5-5', 0.2, 90_000);
      expect(sc.estimates.design(massingReq(), sc.estimateCtx()).basis).toMatch(/1 measured/);
    } finally {
      sc.store.close();
      rmrf(root);
    }
  });
});

describe('massingFirst groups (sim backend, fixture kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('massings in waves, awaiting_approval; approve 2, redirect 1; the redirect gets a new massing, then approval; all 3 detailed', async () => {
    h = await harness('fixture', { simDesignUsd: 0.01 });
    const g0 = h.sc.groups.create(
      GroupRequest.parse({
        name: 'Hamlet',
        bible: 'rustic',
        massingFirst: true,
        ext: { 'steward_mc:settlement': 'S1' },
        context: { site: 'a river bend', street: 'south', lots: [{ key: 'L1', rect: [0, 0, 20, 20] }] },
        items: [item('hall', { anchor: true, role: 'landmark', ext: { 'steward_mc:lot': 'L1' } }), item('house_a', { ext: { 'steward_mc:lot': 'L2' } }), item('house_b', { ext: { 'steward_mc:lot': 'L3' } })],
      }),
    );
    expect(g0).toMatchObject({ massingFirst: true, approvalUi: 'architect', maxRedirects: 3 });
    expect(g0.items.map((i) => [i.itemKey, i.stage, i.massing?.version, i.rounds])).toEqual([['hall', 'massing', 1, 0], ['house_a', 'massing', 1, 0], ['house_b', 'massing', 1, 0]]);
    const massingDesign = (k: string) => h!.sc.designs.get(g0.items.find((i) => i.itemKey === k)!.designIds![0]!)!;
    expect(massingDesign('hall').request).toMatchObject({ massing: true, model: 'claude-sonnet-5-5', group: g0.id, itemKey: 'hall', wave: 0 });
    await groupIs(h, g0.id, 'awaiting_approval');
    let g = h.sc.groups.get(g0.id)!;
    expect(g.awaiting).toEqual(['hall', 'house_a', 'house_b']);
    expect(g.items.every((i) => i.stage === 'approval')).toBe(true);
    expect(g.done).toBe(0);
    // the waves: wave 1's massings started after the anchor's was done, and saw it as a neighbour
    const startOf = (id: string) => h!.events.findIndex((e) => e.type === 'design.upsert' && e.design.id === id && e.design.status === 'designing');
    const doneOf = (id: string) => h!.events.findIndex((e) => e.type === 'design.upsert' && e.design.id === id && e.design.status === 'done');
    expect(startOf(massingDesign('house_a').id)).toBeGreaterThan(doneOf(massingDesign('hall').id));
    const mb = fs.readFileSync(path.join(h.sc.config.dataDir, 'designs', massingDesign('house_a').id, 'BRIEF.md'), 'utf8');
    expect(mb).toContain('# Massing brief');
    expect(mb).toContain(`neighbours/${g.items[0]!.massing!.id}.png`);
    // the context is in every brief
    expect(mb).toContain('"site": "a river bend"');
    // the massings: group, item key and ext on the records
    expect(h.sc.massings.get(g.items[1]!.massing!.id)).toMatchObject({ group: g0.id, itemKey: 'house_a', ext: { 'steward_mc:lot': 'L2' } });
    // a group massing is approved through its group only
    expect(() => h!.sc.requestDesign(DesignRequest.parse(request({ fromMassing: g.items[0]!.massing!.id })))).toThrow(/approve it with group.approve/);
    expect(() => h!.sc.groups.approve(g0.id, { approve: ['nope'], redirect: {}, cancel: [] })).toThrow(/no item "nope"/);
    expect(() => h!.sc.groups.approve(g0.id, { approve: ['hall'], redirect: { hall: 'x' }, cancel: [] })).toThrow(/only one of them/);
    const r = h.sc.groups.approve(g0.id, { approve: ['hall', 'house_a'], redirect: { house_b: 'make it L-shaped with a wing' }, cancel: [] });
    expect(Object.keys(r.approved)).toEqual(['hall', 'house_a']);
    expect(r.redirected.house_b).toMatchObject({ version: 2 });
    expect(() => h!.sc.groups.approve(g0.id, { approve: ['hall'], redirect: {}, cancel: [] })).toThrow(/not awaiting approval \(detail\)/);
    // the redirected item gets its new massing, then the group awaits approval again (details may still run)
    await until(() => h!.sc.groups.get(g0.id)!.items[2]!.stage === 'approval' && h!.sc.groups.get(g0.id)!.items[2]!.massing!.version === 2, 30_000);
    await groupIs(h, g0.id, 'awaiting_approval', 'running', 'queued');
    await until(() => h!.sc.groups.get(g0.id)!.status === 'awaiting_approval' || h!.sc.groups.get(g0.id)!.awaiting!.length === 1, 30_000);
    g = h.sc.groups.get(g0.id)!;
    expect(g.awaiting).toEqual(['house_b']);
    expect(g.items[2]).toMatchObject({ rounds: 1, massing: { version: 2 } });
    expect(h.events.filter((e) => e.type === 'group.upsert' && e.group.id === g0.id && e.group.status === 'awaiting_approval').length).toBeGreaterThanOrEqual(2);
    h.sc.groups.approve(g0.id, { approve: ['house_b'], redirect: {}, cancel: [] });
    await groupIs(h, g0.id, 'done', 'failed');
    g = h.sc.groups.get(g0.id)!;
    expect(g).toMatchObject({ status: 'done', done: 3, failed: 0, awaiting: [] });
    expect(g.items.map((i) => [i.itemKey, i.stage, i.status, i.designIds!.length])).toEqual([['hall', 'detail', 'done', 2], ['house_a', 'detail', 'done', 2], ['house_b', 'detail', 'done', 3]]);
    // every design counts: 4 massings + 3 details, 3 sim steps of $0.01 each
    expect(g.cost.usd).toBeCloseTo(7 * 0.03, 5);
    expect(g.items[2]!.cost.usd).toBeCloseTo(3 * 0.03, 5);
    for (const it of g.items) {
      const e = json(path.join(h.sc.config.libraryDir, it.entryId!, `${it.entryId}.blueprint.json`));
      expect(e).toMatchObject({ group: g0.id, groupItem: it.itemKey, ext: it.ext, fromMassing: { id: it.massing!.id, version: it.massing!.version } });
      expect(h.sc.designs.get(it.designId)!.conformance?.errors).toEqual([]);
    }
    // the detail briefs: binding massing and the context
    const db = fs.readFileSync(path.join(h.sc.config.dataDir, 'designs', g.items[2]!.designId, 'BRIEF.md'), 'utf8');
    expect(db).toContain(`## The approved massing (binding): \`${g.items[2]!.massing!.id}\` v2`);
    expect(db).toContain('"site": "a river bend"');
  }, 90_000);

  it('approvalUi owner: only the owner approves; the redirect cap; cancel an item; owner is required', async () => {
    h = await harness('fixture');
    expect(GroupRequest.safeParse({ name: 'x', bible: 'rustic', massingFirst: true, approvalUi: 'owner', items: [item('a')] }).success).toBe(false);
    const g0 = h.sc.groups.create(GroupRequest.parse({ name: 'Owned', bible: 'rustic', owner: 'steward_mc:s1', massingFirst: true, approvalUi: 'owner', maxRedirects: 1, items: [item('a'), item('b')] }));
    await groupIs(h, g0.id, 'awaiting_approval');
    expect(() => h!.sc.groups.approve(g0.id, { approve: ['a'], redirect: {}, cancel: [] })).toThrow(/approved by its owner only/);
    expect(() => h!.sc.groups.approve(g0.id, { approve: ['a'], redirect: {}, cancel: [], owner: 'someone_else' })).toThrow(/approved by its owner only/);
    // massing.redirect on a group massing goes through the same check
    const ma = h.sc.groups.get(g0.id)!.items[0]!.massing!.id;
    expect(() => h!.sc.redirectMassing(ma, 'taller')).toThrow(/approved by its owner only/);
    const d = h.sc.redirectMassing(ma, 'taller', { owner: 'steward_mc:s1' });
    expect(d.massing).toEqual({ id: ma, version: 2 });
    await until(() => h!.sc.groups.get(g0.id)!.items[0]!.stage === 'approval' && h!.sc.groups.get(g0.id)!.items[0]!.rounds === 1, 30_000);
    // the cap: one redirect per item
    expect(() => h!.sc.groups.approve(g0.id, { approve: [], redirect: { a: 'again' }, cancel: [], owner: 'steward_mc:s1' })).toThrow(/used its 1 redirect round/);
    h.sc.groups.approve(g0.id, { approve: ['a'], redirect: {}, cancel: ['b'], owner: 'steward_mc:s1' });
    await groupIs(h, g0.id, 'done', 'failed');
    const g = h.sc.groups.get(g0.id)!;
    expect(g).toMatchObject({ status: 'done', done: 1, failed: 1 });
    expect(g.items[1]).toMatchObject({ status: 'cancelled', stage: 'approval' });
    expect(() => h!.sc.groups.approve(g0.id, { approve: ['b'], redirect: {}, cancel: [], owner: 'steward_mc:s1' })).toThrow(/already done/);
  }, 60_000);

  it('massings count toward the budget: the soft budget holds the detail pass until extend + resume', async () => {
    // 3 steps x $0.1 per design: three massings are $0.9 of $1 (soft at $0.8)
    h = await harness('fixture', { simDesignUsd: 0.1, designConcurrency: 1 });
    const g0 = h.sc.groups.create(GroupRequest.parse({ name: 'Thrifty', bible: 'rustic', massingFirst: true, budgetUsd: 1, concurrency: 1, items: [item('a'), item('b'), item('c')] }));
    await groupIs(h, g0.id, 'awaiting_approval');
    // (the 3rd massing crossed the soft budget while it ran, and finished)
    await until(() => h!.sc.groups.get(g0.id)!.awaiting!.length === 3, 30_000);
    expect(h.sc.groups.get(g0.id)!.cost.usd).toBeCloseTo(0.9, 5);
    expect(h.sc.groups.get(g0.id)!.reason).toMatch(/soft budget/);
    h.sc.groups.approve(g0.id, { approve: ['a', 'b', 'c'], redirect: {}, cancel: [] });
    await groupIs(h, g0.id, 'paused_budget');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.sc.groups.get(g0.id)!.items.map((i) => i.status)).toEqual(['queued', 'queued', 'queued']);
    h.sc.groups.extend(g0.id, 3);
    h.sc.groups.resume(g0.id);
    await groupIs(h, g0.id, 'done', 'failed');
    expect(h.sc.groups.get(g0.id)).toMatchObject({ status: 'done', done: 3 });
    expect(h.sc.groups.get(g0.id)!.cost.usd).toBeCloseTo(1.8, 5);
    // the hard cap ends items that wait for approval too
    const g1 = h.sc.groups.create(GroupRequest.parse({ name: 'Capped', bible: 'rustic', massingFirst: true, budgetUsd: 0.5, concurrency: 1, items: [item('a'), item('b'), item('c')] }));
    h.sc.config.groups.softBudgetFraction = 1;
    await groupIs(h, g1.id, 'done', 'failed', 'cancelled');
    const f = h.sc.groups.get(g1.id)!;
    expect(f).toMatchObject({ status: 'failed', reason: 'budget', done: 0 });
    expect(f.items.every((i) => i.status === 'cancelled' || i.status === 'failed')).toBe(true);
  }, 90_000);

  it('a restart mid-approval keeps ext, itemKey and the massings; approval after it finishes the group', async () => {
    const root = tempDir('arch-4c-restart-');
    h = await harness('fixture', {}, root);
    const g0 = h.sc.groups.create(GroupRequest.parse({ name: 'Persist', bible: 'rustic', massingFirst: true, context: 'quiet hamlet', items: [item('k1', { ext: { 'steward_mc:lot': 'A' } }), item('k2', { ext: { 'steward_mc:lot': 'B' } })] }));
    await groupIs(h, g0.id, 'awaiting_approval');
    await h.close(true);
    h = await harness('fixture', {}, root);
    const back = h.sc.groups.get(g0.id)!;
    expect(back.status).toBe('awaiting_approval');
    expect(back.items.map((i) => [i.itemKey, i.ext, i.stage])).toEqual([['k1', { 'steward_mc:lot': 'A' }, 'approval'], ['k2', { 'steward_mc:lot': 'B' }, 'approval']]);
    expect(h.sc.massings.get(back.items[0]!.massing!.id)).toMatchObject({ ext: { 'steward_mc:lot': 'A' }, itemKey: 'k1' });
    h.sc.groups.approve(g0.id, { approve: ['k1', 'k2'], redirect: {}, cancel: [] });
    await groupIs(h, g0.id, 'done', 'failed');
    const g = h.sc.groups.get(g0.id)!;
    expect(g).toMatchObject({ status: 'done', done: 2 });
    for (const it of g.items) expect(json(path.join(h.sc.config.libraryDir, it.entryId!, `${it.entryId}.blueprint.json`))).toMatchObject({ groupItem: it.itemKey, ext: it.ext, group: g0.id });
    expect(fs.readFileSync(path.join(h.sc.config.dataDir, 'designs', g.items[0]!.designId, 'BRIEF.md'), 'utf8')).toContain('quiet hamlet');
  }, 60_000);
});

describe('the sim redirect', () => {
  it('bumps the first int param that can grow, else turns a gable into a hip', () => {
    expect(simRedirect("export const params = {\n  a: { type: 'bool', default: true },\n  wings: { type: 'int', min: 0, max: 2, default: 0, label: 'W' },\n};\nx").change).toBe('wings 0 -> 1');
    expect(simRedirect("m.mass('a', [0,0,0,1,1,1], { roof: 'gable' })").source).toContain("roof: 'hip'");
  });
});

describe.skipIf(!hasRealKit)('massings with the REAL kit (sim backend)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('a tavern massing from the example, a redirect, and the detail pass conforms', async () => {
    h = await harness('real');
    const d = h.sc.requestDesign(DesignRequest.parse(request({ type: 'tavern', name: 'Inn', massing: true, bible: 'oak', maxSize: { x: 64, y: 40, z: 64 } })));
    await finished(h, d.id, 60_000);
    expect(h.sc.designs.get(d.id)!.status, h.sc.designs.get(d.id)!.error).toBe('done');
    const m = h.sc.massings.get('mas_inn')!;
    expect(m.size).toEqual({ x: 16, y: 17, z: 12 });
    expect(Object.keys(m.parts).length).toBeGreaterThanOrEqual(3);
    expect(json(path.join(m.dir, 'mas_inn.blueprint.json'))).toMatchObject({ massing: true, type: 'tavern' });
    const r = h.sc.redirectMassing('mas_inn', 'a hipped roof');
    await finished(h, r.id, 60_000);
    expect(h.sc.designs.get(r.id)!.status, h.sc.designs.get(r.id)!.error).toBe('done');
    expect(h.sc.massings.get('mas_inn')!.version).toBe(2);
    const det = h.sc.requestDesign(DesignRequest.parse(request({ type: 'tavern', name: 'Inn', fromMassing: 'mas_inn', massingVersion: 1, maxSize: { x: 64, y: 40, z: 64 } })));
    await finished(h, det.id, 60_000);
    const done = h.sc.designs.get(det.id)!;
    expect(done.status, done.error).toBe('done');
    expect(done.conformance).toEqual({ ok: true, errors: [], issues: [] });
  }, 120_000);

  it('a massingFirst set of three on the real kit: approve 2, redirect 1, all detailed', async () => {
    h = await harness('real', { designConcurrency: 3 });
    const real = (k: string, type: string, o: Record<string, unknown> = {}) => ({ ...request({ type, name: undefined, notes: undefined, maxSize: { x: 64, y: 40, z: 64 } }), itemKey: k, ...o });
    const g0 = h.sc.groups.create(GroupRequest.parse({ name: 'Real Set', bible: 'oak', massingFirst: true, context: 'a crossroads', items: [real('inn', 'tavern', { anchor: true, role: 'landmark' }), real('watch', 'tower'), real('gate', 'gatehouse')] }));
    await groupIs(h, g0.id, 'awaiting_approval');
    h.sc.groups.approve(g0.id, { approve: ['inn', 'watch'], redirect: { gate: 'hip the roof' }, cancel: [] });
    await until(() => h!.sc.groups.get(g0.id)!.items[2]!.stage === 'approval' && h!.sc.groups.get(g0.id)!.items[2]!.massing!.version === 2, 60_000);
    h.sc.groups.approve(g0.id, { approve: ['gate'], redirect: {}, cancel: [] });
    await groupIs(h, g0.id, 'done', 'failed');
    const g = h.sc.groups.get(g0.id)!;
    expect(g, JSON.stringify(g.items.map((i) => i.error))).toMatchObject({ status: 'done', done: 3 });
    for (const it of g.items) expect(h.sc.designs.get(it.designId)!.conformance?.errors).toEqual([]);
  }, 180_000);
});
