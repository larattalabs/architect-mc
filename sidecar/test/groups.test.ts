// Phase 4b with the sim backend and the REAL kit (../kit): the design pool (round-robin fairness, lane caps), design
// groups (waves and neighbours, the bible in every scratch dir, entries with bible + group, the group-wide usage hold,
// the soft budget then extend / resume, the hard cap, restart mid-group with ext and itemKey intact, the 24-item limit),
// estimates, style bibles (request, revise, seed preset, settlement scope, a pool slot each), re-skins and open types.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { Estimates } from '../src/estimates.js';
import { Pool } from '../src/pool.js';
import { DesignRequest, GroupRequest, type Group, type Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner, SIM_LIMIT_MARK } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'tools', 'components.mjs'));

// ---------------------------------------------------------------- the pool alone

describe('the design pool', () => {
  const deferred = () => {
    let resolve!: () => void;
    const p = new Promise<void>((r) => (resolve = r));
    return { p, resolve };
  };

  it('serves lanes round-robin (fair, not FIFO by lane) and caps a lane', async () => {
    const pool = new Pool(() => 1);
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const add = (lane: string, key: string) => {
      const g = deferred();
      gates.set(key, g);
      pool.submit({ key, lane, ready: () => true, start: () => (started.push(key), g.p) });
    };
    for (let i = 1; i <= 3; i++) add('group:a', `a${i}`);
    for (let i = 1; i <= 3; i++) add('group:b', `b${i}`);
    add('single', 's1');
    for (let i = 0; i < 7; i++) {
      await until(() => started.length === i + 1);
      gates.get(started[i]!)!.resolve();
    }
    // a1 first (it asked first), then the lanes in turn
    expect(started).toEqual(['a1', 'b1', 's1', 'a2', 'b2', 'a3', 'b3']);
    // a lane cap: two slots, but group:c may run only one at a time
    const pool2 = new Pool(() => 2);
    pool2.setLaneCap('group:c', 1);
    const running = new Set<string>();
    let max = 0;
    for (let i = 1; i <= 3; i++) {
      pool2.submit({
        key: `c${i}`,
        lane: 'group:c',
        ready: () => true,
        start: async () => {
          running.add(`c${i}`);
          max = Math.max(max, running.size);
          await new Promise((r) => setTimeout(r, 20));
          running.delete(`c${i}`);
        },
      });
    }
    await until(() => !pool2.runningKeys().length && !pool2.waitingKeys().length);
    expect(max).toBe(1);
  });

  it('a ticket that is not ready waits in place; hold() takes a slot', async () => {
    const pool = new Pool(() => 1);
    let ok = false;
    const started: string[] = [];
    pool.submit({ key: 'x', lane: 'single', ready: () => ok, start: async () => void started.push('x') });
    pool.submit({ key: 'y', lane: 'other', ready: () => true, start: async () => void started.push('y') });
    await until(() => started.length === 1);
    expect(started).toEqual(['y']);
    await until(() => !pool.runningKeys().length);
    expect(pool.hold('h')).toBe(true);
    ok = true;
    pool.kick();
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual(['y']);
    pool.release('h');
    await until(() => started.length === 2);
  });
});

// ---------------------------------------------------------------- estimates

describe('estimates', () => {
  const ctx = { designConcurrency: 3, now: 1_000_000, designModel: 'claude-opus-5-5', landmarkModel: 'claude-opus-5-5', ordinaryModel: 'claude-sonnet-5-5', bibleModel: 'claude-opus-5-5' };
  const item = (o: Record<string, unknown> = {}) => ({ ...request(), ...o }) as unknown as GroupRequest['items'][number];

  it('seeds Opus at $1.0-1.5 and 4-6 min a design, Sonnet at 0.4x the cost; waves and concurrency shape the time', () => {
    const root = tempDir();
    try {
      const est = new Estimates(new Store(root, { debounceMs: 5 }));
      const one = est.group({ items: [item({ role: 'landmark' })] }, ctx);
      expect(one).toMatchObject({ usdLow: 1, usdHigh: 1.5, minutesLow: 4, minutesHigh: 6 });
      expect(one.basis).toMatch(/claude-opus-5-5: seed/);
      const three = est.group({ items: [item({ role: 'landmark', anchor: true }), item(), item()], concurrency: 3 }, ctx);
      // 1 Opus + 2 Sonnet; two waves (the anchor first, then both at once)
      expect(three.usdLow).toBeCloseTo(1 + 2 * 0.4, 5);
      expect(three.usdHigh).toBeCloseTo(1.5 + 2 * 0.6, 5);
      expect(three.minutesLow).toBe(8);
      expect(three.minutesHigh).toBe(12);
      expect(est.group({ items: [item(), item(), item()], concurrency: 1 }, ctx).minutesHigh).toBe(18);
      // a usage limit adds its wait
      expect(est.group({ items: [item()] }, { ...ctx, limitUntil: ctx.now + 10 * 60_000 }).minutesLow).toBe(14);
      expect(est.bible({}, ctx)).toMatchObject({ usdLow: 1, usdHigh: 1.5 });
    } finally {
      rmrf(root);
    }
  });

  it('measurements replace the seed (a rolling average, persisted)', () => {
    const root = tempDir();
    try {
      let store = new Store(root, { debounceMs: 5 });
      let est = new Estimates(store);
      for (const usd of [0.8, 1.0, 1.2]) est.record('design', 'claude-opus-5-5', usd, 5 * 60_000);
      store.flush();
      store = new Store(root, { debounceMs: 5 });
      est = new Estimates(store);
      const e = est.group({ items: [item({ role: 'landmark' })] }, ctx);
      expect(e.basis).toMatch(/3 measured \(avg \$1\.00/);
      expect(e.usdLow).toBeCloseTo(0.75, 2);
      expect(e.usdHigh).toBeCloseTo(1.25, 2);
      for (let i = 0; i < 30; i++) est.record('design', 'claude-opus-5-5', 2, 60_000);
      expect(est.samples('design', 'claude-opus-5-5')).toHaveLength(20);
    } finally {
      rmrf(root);
    }
  });
});

// ---------------------------------------------------------------- groups and bibles, sim + real kit

interface H {
  root: string;
  sc: Sidecar;
  events: Outbound[];
  designer: SimDesigner;
  close(keep?: boolean): Promise<void>;
}

async function harness(over: Partial<Config> = {}, root = tempDir('arch-4b-')): Promise<H> {
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
  cfg.simStepMs = 15;
  cfg.simLimitMs = 600;
  Object.assign(cfg, over);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
  const events: Outbound[] = [];
  sc.subscribe((m) => events.push(m));
  const designer = new SimDesigner(sc, cfg.simStepMs);
  await sc.start(designer);
  return {
    root,
    sc,
    events,
    designer,
    close: async (keep = false) => {
      await sc.close();
      if (!keep) rmrf(root);
    },
  };
}

const item = (itemKey: string, o: Record<string, unknown> = {}) => ({ ...request({ type: 'cabin', name: undefined, notes: undefined, maxSize: { x: 64, y: 64, z: 64 } }), itemKey, ...o });
const groupDone = (h: H, id: string, ms = 60_000) => until(() => ['done', 'failed', 'cancelled'].includes(h.sc.groups.get(id)!.status), ms);
const lastGroup = (h: H, id: string) => [...h.events].reverse().find((e): e is Extract<Outbound, { type: 'group.upsert' }> => e.type === 'group.upsert' && e.group.id === id)!.group;
const readEntry = (h: H, id: string) => JSON.parse(fs.readFileSync(path.join(h.sc.config.libraryDir, id, `${id}.blueprint.json`), 'utf8')) as Record<string, unknown>;

describe.skipIf(!hasKit)('design groups (sim backend, real kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('waves: the anchor first, then the rest with its render as a neighbour; bible files in every scratch dir; entries carry bible and group', async () => {
    h = await harness();
    const g = h.sc.groups.create(
      GroupRequest.parse({
        name: 'Hamlet',
        bible: 'cherry',
        owner: 'steward_mc:s1',
        ext: { 'steward_mc:settlement': 'S1' },
        items: [item('hall', { type: 'tavern', anchor: true, role: 'landmark', ext: { 'steward_mc:lot': 'L1' } }), item('house_a', { ext: { 'steward_mc:lot': 'L2' } }), item('house_b', { type: 'tower' })],
      }),
    );
    expect(g.items.map((i) => [i.itemKey, i.wave, i.role, i.model])).toEqual([['hall', 0, 'landmark', 'claude-opus-5-5'], ['house_a', 1, 'ordinary', 'claude-sonnet-5-5'], ['house_b', 1, 'ordinary', 'claude-sonnet-5-5']]);
    expect(g.bible).toEqual({ id: 'cherry', version: 1 });
    // wave 1 waits for the anchor
    const hall = g.items[0]!.designId;
    const [a, b] = [g.items[1]!.designId, g.items[2]!.designId];
    await until(() => h!.sc.designs.get(hall)!.status !== 'queued');
    expect(h.sc.designs.get(a)!.status).toBe('queued');
    expect(h.sc.designs.get(b)!.status).toBe('queued');
    await groupDone(h, g.id);
    const startOf = (id: string) => h!.events.findIndex((e) => e.type === 'design.upsert' && e.design.id === id && e.design.status === 'designing');
    const doneOf = (id: string) => h!.events.findIndex((e) => e.type === 'design.upsert' && e.design.id === id && e.design.status === 'done');
    expect(startOf(a)).toBeGreaterThan(doneOf(hall));
    expect(startOf(b)).toBeGreaterThan(doneOf(hall));
    const final = h.sc.groups.get(g.id)!;
    expect(final).toMatchObject({ status: 'done', done: 3, failed: 0 });
    expect(final.items.map((i) => i.status)).toEqual(['done', 'done', 'done']);
    expect(final.items[0]!.ext).toEqual({ 'steward_mc:lot': 'L1' });
    expect(final.designs.map((d) => d.id)).toEqual([hall, a, b]);
    // scratch dirs: the bible everywhere, the anchor's render for wave 1
    const scratch = (id: string) => path.join(h!.sc.config.dataDir, 'designs', id);
    for (const id of [hall, a, b]) expect(fs.readdirSync(path.join(scratch(id), 'bible')).sort()).toEqual(['bible.json', 'components.mjs']);
    expect(fs.existsSync(path.join(scratch(hall), 'neighbours'))).toBe(false);
    const hallEntry = final.items[0]!.entryId!;
    expect(fs.readdirSync(path.join(scratch(a), 'neighbours'))).toEqual([`${hallEntry}.png`]);
    const brief = fs.readFileSync(path.join(scratch(a), 'BRIEF.md'), 'utf8');
    expect(brief).toContain('## The style bible: Cherry (`cherry` v1)');
    expect(brief).toContain(`neighbours/${hallEntry}.png`);
    expect(brief).toContain("bp.part('<name>'");
    expect(brief).toContain('../../bible/components.mjs');
    // entries: bible pin, group, item ext, their bible files; the build used the bible's roles
    const e = readEntry(h, final.items[1]!.entryId!);
    expect(e).toMatchObject({ bible: { id: 'cherry', version: 1 }, group: g.id, groupItem: 'house_a', ext: { 'steward_mc:lot': 'L2' } });
    expect((e.palette as { bible: { id: string } }).bible.id).toBe('cherry');
    expect(fs.readdirSync(path.join(h.sc.config.libraryDir, final.items[1]!.entryId!, 'bible')).sort()).toEqual(['bible.json', 'components.mjs']);
    expect(lastGroup(h, g.id).status).toBe('done');
  }, 90_000);

  it('round-robin: two groups and a single design share one slot fairly', async () => {
    h = await harness({ designConcurrency: 1 });
    const a = h.sc.groups.create(GroupRequest.parse({ name: 'A', bible: 'oak', items: [item('a1'), item('a2'), item('a3')] }));
    const b = h.sc.groups.create(GroupRequest.parse({ name: 'B', bible: 'oak', items: [item('b1'), item('b2')] }));
    const s = h.sc.requestDesign(DesignRequest.parse(request({ name: 'Solo', maxSize: { x: 64, y: 64, z: 64 } })));
    await groupDone(h, a.id);
    await groupDone(h, b.id);
    await until(() => h!.sc.designs.get(s.id)!.status === 'done', 30_000);
    const label = new Map([...a.items.map((i) => [i.designId, i.itemKey] as const), ...b.items.map((i) => [i.designId, i.itemKey] as const), [s.id, 'solo'] as const]);
    const firsts = h.events.filter((e): e is Extract<Outbound, { type: 'design.upsert' }> => e.type === 'design.upsert' && e.design.status === 'designing').map((e) => e.design.id);
    const order = firsts.filter((id, i) => firsts.indexOf(id) === i).map((id) => label.get(id));
    expect(order).toEqual(['a1', 'b1', 'solo', 'a2', 'b2', 'a3']);
  }, 90_000);

  it('a usage limit holds the whole group (held_usage); all items resume together after the reset', async () => {
    h = await harness({ designConcurrency: 3 });
    const g = h.sc.groups.create(GroupRequest.parse({ name: 'Held', bible: 'rustic', concurrency: 3, items: [item('i1', { notes: SIM_LIMIT_MARK }), item('i2'), item('i3')] }));
    await until(() => h!.sc.groups.get(g.id)!.status === 'held_usage', 20_000);
    const held = h.sc.groups.get(g.id)!;
    expect(held.usageLimitUntil).toBeGreaterThan(Date.now() - 1000);
    // while held, nothing designs
    await new Promise((r) => setTimeout(r, 150));
    expect(h.sc.groups.get(g.id)!.status).toBe('held_usage');
    expect(held.items.every((i) => i.status === 'queued')).toBe(true);
    await groupDone(h, g.id);
    expect(h.sc.groups.get(g.id)).toMatchObject({ status: 'done', done: 3 });
    expect(h.sc.store.data.limit).toBeUndefined();
    expect(h.events.some((e) => e.type === 'group.upsert' && e.group.id === g.id && e.group.status === 'held_usage')).toBe(true);
  }, 60_000);

  it('the soft budget pauses the group (paused_budget); extend, then resume, and it finishes', async () => {
    // 3 steps x $0.1 per design: $0.3 each; budget $1, soft at $0.8: the 3rd design crosses it
    h = await harness({ designConcurrency: 1, simDesignUsd: 0.1 });
    const g = h.sc.groups.create(GroupRequest.parse({ name: 'Thrifty', bible: 'birch', budgetUsd: 1, concurrency: 1, items: [item('i1'), item('i2'), item('i3'), item('i4')] }));
    await until(() => h!.sc.groups.get(g.id)!.status === 'paused_budget', 30_000);
    const paused = h.sc.groups.get(g.id)!;
    // (the sim reports cost per step: the 3rd design crosses $0.80 while it runs, and finishes)
    expect(paused.reason).toMatch(/soft budget: \$0\.80 of \$1 spent \(80% reached\)/);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.sc.groups.get(g.id)!.items.map((i) => i.status)).toEqual(['done', 'done', 'done', 'queued']);
    expect(() => h!.sc.groups.extend(g.id, 0.5)).toThrow(/not above/);
    h.sc.groups.extend(g.id, 3);
    expect(h.sc.groups.get(g.id)!.status).toBe('paused_budget');
    h.sc.groups.resume(g.id);
    await groupDone(h, g.id);
    expect(h.sc.groups.get(g.id)).toMatchObject({ status: 'done', done: 4, budgetUsd: 3 });
    expect(h.sc.groups.get(g.id)!.cost.usd).toBeCloseTo(1.2, 5);
  }, 60_000);

  it('the hard cap stops what is left with error "budget"', async () => {
    h = await harness({ designConcurrency: 2, simDesignUsd: 0.1 });
    h.sc.config.groups.softBudgetFraction = 1;
    const g = h.sc.groups.create(GroupRequest.parse({ name: 'Capped', bible: 'dark', budgetUsd: 0.5, concurrency: 2, items: [item('i1'), item('i2'), item('i3'), item('i4')] }));
    await groupDone(h, g.id);
    const f = h.sc.groups.get(g.id)!;
    expect(f.reason).toBe('budget');
    const left = f.items.filter((i) => i.status !== 'done');
    expect(left.length).toBeGreaterThan(0);
    for (const it of left) expect(h.sc.designs.get(it.designId)!.error).toBe('budget');
    expect(f.items.filter((i) => i.status === 'cancelled').length).toBeGreaterThan(0);
  }, 60_000);

  it('a restart mid-group keeps ext and itemKey and finishes the group', async () => {
    const root = tempDir('arch-4b-restart-');
    h = await harness({ designConcurrency: 1 }, root);
    const g = h.sc.groups.create(GroupRequest.parse({ name: 'Persist', bible: 'mangrove', ext: { 'steward_mc:s': 'S9' }, items: [item('k1', { ext: { 'steward_mc:lot': 'A' } }), item('k2', { ext: { 'steward_mc:lot': 'B' } }), item('k3', { ext: { 'steward_mc:lot': 'C' } })] }));
    await until(() => h!.sc.groups.get(g.id)!.done >= 1, 30_000);
    await h.close(true);
    h = await harness({ designConcurrency: 1 }, root);
    const back = h.sc.groups.get(g.id)!;
    expect(back.items.map((i) => [i.itemKey, i.ext])).toEqual([['k1', { 'steward_mc:lot': 'A' }], ['k2', { 'steward_mc:lot': 'B' }], ['k3', { 'steward_mc:lot': 'C' }]]);
    expect(back.ext).toEqual({ 'steward_mc:s': 'S9' });
    await groupDone(h, g.id);
    const f = h.sc.groups.get(g.id)!;
    expect(f).toMatchObject({ status: 'done', done: 3 });
    for (const it of f.items) expect(readEntry(h, it.entryId!)).toMatchObject({ groupItem: it.itemKey, ext: it.ext, group: g.id });
    // the snapshot carries it
    expect(((h.sc.snapshot() as unknown as { groups: Group[] }).groups).find((x) => x.id === g.id)!.items).toHaveLength(3);
  }, 90_000);

  it('cancel keeps finished items; 25 items are refused; an unknown bible is refused', async () => {
    h = await harness({ designConcurrency: 1 });
    const g = h.sc.groups.create(GroupRequest.parse({ name: 'Stop', bible: 'oak', items: [item('i1'), item('i2'), item('i3')] }));
    await until(() => h!.sc.groups.get(g.id)!.done >= 1, 30_000);
    h.sc.groups.cancel(g.id);
    await until(() => h!.sc.groups.get(g.id)!.status === 'cancelled');
    const f = h.sc.groups.get(g.id)!;
    expect(f.done).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(h.sc.config.libraryDir, f.items[0]!.entryId!))).toBe(true);
    expect(GroupRequest.safeParse({ name: 'Big', bible: 'oak', items: Array.from({ length: 25 }, (_, i) => item(`i${i}`)) }).success).toBe(false);
    expect(GroupRequest.safeParse({ name: 'Dup', bible: 'oak', items: [item('x'), item('x')] }).success).toBe(false);
    expect(() => h!.sc.groups.create(GroupRequest.parse({ name: 'X', bible: 'bib_nope', items: [item('a')] }))).toThrow(/no bible "bib_nope"/);
  }, 60_000);

  it('an open type with a profile designs and passes; the entry records its profile', async () => {
    h = await harness();
    const d = h.sc.requestDesign(DesignRequest.parse(request({ type: 'hellish_lair', profile: ['door', 'lit', 'no_floating'], name: 'Lair', maxSize: { x: 64, y: 64, z: 64 } })));
    await until(() => ['done', 'failed'].includes(h!.sc.designs.get(d.id)!.status), 30_000);
    expect(h.sc.designs.get(d.id)!.status, h.sc.designs.get(d.id)!.error).toBe('done');
    expect(readEntry(h, 'gen_lair')).toMatchObject({ type: 'hellish_lair', profile: ['door', 'lit', 'no_floating'] });
  }, 60_000);
});

describe.skipIf(!hasKit)('style bibles (sim backend, real kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('bible.request: drafted, components checked in the frame, sheet rendered, installed versioned; revise makes v2', async () => {
    h = await harness();
    const j = h.sc.bibles.request({ prompt: 'hellish evil lair, mining facility', name: 'Ashfall' });
    expect(j).toMatchObject({ bibleId: 'bib_ashfall', version: 1 });
    await until(() => ['done', 'failed'].includes(h!.sc.bibles.get(j.id)!.status), 30_000);
    const done = h.sc.bibles.get(j.id)!;
    expect(done.status, done.error).toBe('done');
    const dir = path.join(h.sc.config.biblesDir, 'bib_ashfall');
    expect(fs.readdirSync(path.join(dir, 'versions', '1')).sort()).toEqual(['bible.json', 'bible.md', 'components.mjs', 'sheet.png']);
    expect(fs.readFileSync(path.join(dir, 'sheet.png')).subarray(1, 4).toString()).toBe('PNG');
    const bible = JSON.parse(fs.readFileSync(path.join(dir, 'bible.json'), 'utf8')) as Record<string, unknown>;
    expect(bible).toMatchObject({ id: 'bib_ashfall', version: 1, name: 'Ashfall', prompt: 'hellish evil lair, mining facility', scope: 'building', roles: { wall: 'minecraft:blackstone' } });
    expect(bible.components).toEqual(expect.arrayContaining(['window', 'door_surround', 'lantern_post', 'roof_trim', 'chimney']));
    expect(done.bible).toMatchObject({ id: 'bib_ashfall', version: 1, versions: [1], builtin: false, sheetPath: path.join(dir, 'versions', '1', 'sheet.png') });
    expect(h.events.some((e) => e.type === 'bible.index')).toBe(true);
    expect(h.sc.bibleIndex.list().map((b) => b.id)).toEqual(expect.arrayContaining(['bib_ashfall', 'rustic', 'cherry']));
    // the next request with the same name gets the next id; revise makes v2 and keeps v1
    expect(h.sc.bibles.request({ prompt: 'x', name: 'Ashfall' }).bibleId).toBe('bib_ashfall_2');
    const r = h.sc.bibles.revise('bib_ashfall', 'more moss, greener glass');
    expect(r).toMatchObject({ kind: 'revise', bibleId: 'bib_ashfall', version: 2 });
    await until(() => h!.sc.bibles.get(r.id)!.status === 'done', 30_000);
    expect(h.sc.bibleIndex.versions('bib_ashfall')).toEqual([1, 2]);
    expect(h.sc.bibleIndex.get('bib_ashfall')!.version).toBe(2);
    expect(h.sc.bibleIndex.resolve({ id: 'bib_ashfall', version: 1 }).pin).toEqual({ id: 'bib_ashfall', version: 1 });
    expect(fs.readFileSync(path.join(dir, 'bible.md'), 'utf8')).toMatch(/more moss/);
    expect(() => h!.sc.bibles.revise('rustic', 'x')).toThrow(/built-in/);
  }, 60_000);

  it('seedPreset starts from a built-in bible; scope settlement adds the macro roles; a bible job takes a pool slot', async () => {
    h = await harness({ designConcurrency: 1 });
    const seeded = h.sc.bibles.request({ prompt: 'a cherry orchard village', seedPreset: 'cherry' });
    const town = h.sc.bibles.request({ prompt: 'a mining town', name: 'Pitworks', scope: 'settlement' });
    const d = h.sc.requestDesign(DesignRequest.parse(request({ name: 'Between', maxSize: { x: 64, y: 64, z: 64 } })));
    // one slot: never two of them at once
    let overlap = false;
    const t = setInterval(() => {
      const busy = [h!.sc.bibles.get(seeded.id)!, h!.sc.bibles.get(town.id)!].filter((j) => !['queued', 'done', 'failed'].includes(j.status)).length + (['designing', 'checking', 'rendering'].includes(h!.sc.designs.get(d.id)!.status) ? 1 : 0);
      if (busy > 1) overlap = true;
    }, 2);
    await until(() => h!.sc.bibles.get(seeded.id)!.status === 'done' && h!.sc.bibles.get(town.id)!.status === 'done' && h!.sc.designs.get(d.id)!.status === 'done', 60_000);
    clearInterval(t);
    expect(overlap).toBe(false);
    expect(h.sc.bibleIndex.get(seeded.bibleId)!.roles.frame).toBe(h.sc.bibleIndex.get('cherry')!.roles.frame);
    expect(Object.keys(h.sc.bibleIndex.get('bib_pitworks')!.roles)).toEqual(expect.arrayContaining(['rock', 'surface', 'subsurface', 'rubble', 'rail', 'structure']));
    expect(h.sc.bibleIndex.get('bib_pitworks')!.scope).toBe('settlement');
    expect(() => h!.sc.bibles.request({ prompt: 'x', seedPreset: 'nope' })).toThrow(/not a built-in bible/);
  }, 90_000);

  it('a group designs with a generated bible, then the collection is re-skinned to a built-in bible (free, checked)', async () => {
    h = await harness();
    const j = h.sc.bibles.request({ prompt: 'hellish evil lair', name: 'Cinder' });
    await until(() => h!.sc.bibles.get(j.id)!.status === 'done', 30_000);
    const g = h.sc.groups.create(GroupRequest.parse({ name: 'Cinder Set', bible: 'bib_cinder', items: [item('keep', { type: 'tower', anchor: true, role: 'landmark' }), item('hut'), item('inn', { type: 'tavern' })] }));
    await groupDone(h, g.id);
    expect(h.sc.groups.get(g.id)!.status).toBe('done');
    for (const it of h.sc.groups.get(g.id)!.items) expect(readEntry(h, it.entryId!).bible).toEqual({ id: 'bib_cinder', version: 1 });
    const r = h.sc.reskins.request('fortress', undefined, { group: g.id });
    expect(r.variants).toHaveLength(3);
    await h.sc.variantRunner.idle();
    await until(() => h!.sc.reskins.get(r.id)!.status !== 'building');
    const rr = h.sc.reskins.get(r.id)!;
    expect(rr, rr.error).toMatchObject({ status: 'done', done: 3, failed: 0, bible: { id: 'fortress', version: 1 } });
    for (const id of rr.entries) {
      const e = readEntry(h, id);
      expect(e).toMatchObject({ bible: { id: 'fortress', version: 1 }, reskin: r.id });
      expect((e.palette as { bible: { id: string } }).bible.id).toBe('fortress');
      expect(e.materials as string[]).not.toContain('minecraft:blackstone');
    }
    expect(h.events.filter((e) => e.type === 'reskin.upsert').length).toBeGreaterThan(1);
    // a single variant with a bible, and the collection by bible
    const v = h.sc.requestVariant(rr.entries[0]!, undefined, undefined, undefined, 'cherry');
    await h.sc.variantRunner.idle();
    expect(h.sc.variants.get(v.id)!.status, h.sc.variants.get(v.id)!.error).toBe('done');
    expect(h.sc.reskins.collection({ bible: 'bib_cinder' })).toHaveLength(3);
    expect(() => h!.sc.requestVariant(rr.entries[0]!, 'oak', undefined, undefined, 'cherry')).toThrow(/palette or a bible/);
  }, 120_000);
});
