// Phase 6c slice 0a, C4 (docs/CONTRACT.md "Phase 6c slice 0a" §2): the sim as the consumer stub. simCosts (zero, measured, an
// object; the env wins over config.json), the faults sim:fail / sim:repair / sim:usage_limit (notes or ext "architect:sim"),
// a scripted job answer checked against the job's schema, and a Steward-sized flow at the default step time with the
// notional "measured" costs summing exactly.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, MEASURED_SIM_COSTS, simCostsConfig, type Config } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { BibleRequest, GroupRequest, JobSpec, type Outbound } from '../src/protocol.js';
import { simAnswerProblems } from '../src/jobs/runner.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner, simFaults } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'tools', 'components.mjs'));

describe('simCosts (config)', () => {
  it('parses zero, measured and an object; anything else is refused', () => {
    expect(simCostsConfig(undefined)).toBeUndefined();
    expect(simCostsConfig('zero')).toBeUndefined();
    expect(simCostsConfig('measured')).toEqual(MEASURED_SIM_COSTS);
    expect(MEASURED_SIM_COSTS).toMatchObject({ bible: 1.35, massing: 0.19, detail: 3.4, critique: 0.1, repair: 0.5 });
    const o = { bible: 1, massing: 0.2, detail: 2, critique: 0.05, repair: 0.4 };
    expect(simCostsConfig(o)).toEqual({ mode: 'custom', ...o });
    expect(simCostsConfig(JSON.stringify(o))).toEqual({ mode: 'custom', ...o });
    expect(() => simCostsConfig('measure')).toThrow(ConfigError);
    expect(() => simCostsConfig({ ...o, repair: -1 })).toThrow(/repair/);
    expect(() => simCostsConfig({ bible: 1 })).toThrow(/massing/);
    expect(() => simCostsConfig({ ...o, extra: 1 })).toThrow(/unknown key/);
  });

  it('ARCHITECT_SIM_COSTS wins over config.json; only the sim backend reads it', () => {
    const root = tempDir('arch-simcosts-');
    try {
      fs.mkdirSync(path.join(root, 'data'));
      fs.writeFileSync(path.join(root, 'data', 'config.json'), JSON.stringify({ simCosts: 'measured' }));
      const args = (b: string) => ['--data', path.join(root, 'data'), '--library', path.join(root, 'lib'), '--kit', KIT, '--backend', b];
      expect(loadConfig(args('sim'), {}).simCosts).toEqual(MEASURED_SIM_COSTS);
      expect(loadConfig(args('sim'), { ARCHITECT_SIM_COSTS: 'zero' }).simCosts).toBeUndefined();
      expect(loadConfig(args('sim'), { ARCHITECT_SIM_COSTS: '{"bible":0,"massing":0,"detail":1,"critique":0,"repair":0}' }).simCosts?.detail).toBe(1);
      expect(loadConfig(args('claude'), { ARCHITECT_SIM_COSTS: 'garbage' }).simCosts).toBeUndefined();
      expect(() => loadConfig(args('sim'), { ARCHITECT_SIM_COSTS: 'garbage' })).toThrow(ConfigError);
    } finally {
      rmrf(root);
    }
  });
});

describe('sim faults and scripted answers', () => {
  it('reads sim:<fault> from the notes and ext "architect:sim"', () => {
    expect([...simFaults({ notes: 'a nook; sim:fail and sim:repair' })].sort()).toEqual(['fail', 'repair']);
    expect([...simFaults({ notes: 'sim:critique=5/7 sim:revise=fail sim:polish=er' })]).toEqual([]);
    expect([...simFaults({ ext: { 'architect:sim': 'sim:usage_limit' } })]).toEqual(['usage_limit']);
    expect([...simFaults({ ext: { 'architect:sim': ['fail', 'repair'] } })].sort()).toEqual(['fail', 'repair']);
  });

  it('checks a scripted answer against the schema (simFail is a script, simLimitMs wraps the answer)', () => {
    const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };
    expect(simAnswerProblems({ title: 'Mill' }, schema)).toEqual([]);
    expect(simAnswerProblems({ name: 'Mill' }, schema).length).toBeGreaterThan(0);
    expect(simAnswerProblems({ simFail: 'no' }, schema)).toEqual([]);
    expect(simAnswerProblems({ simLimitMs: 10, answer: { title: 'x' } }, schema)).toEqual([]);
    expect(simAnswerProblems({ simLimitMs: 10, answer: {} }, schema).length).toBeGreaterThan(0);
    expect(simAnswerProblems({ anything: 1 }, undefined)).toEqual([]);
  });
});

interface H {
  sc: Sidecar;
  events: Outbound[];
  close(): Promise<void>;
}

async function harness(over: Partial<Config> = {}): Promise<H> {
  const root = tempDir('arch-0a-c4-');
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
  cfg.simStepMs = 15;
  cfg.simLimitMs = 600;
  Object.assign(cfg, over);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
  const events: Outbound[] = [];
  sc.subscribe((m) => events.push(m));
  await sc.start(new SimDesigner(sc, cfg.simStepMs));
  return {
    sc,
    events,
    close: async () => {
      await sc.close();
      rmrf(root);
    },
  };
}

const item = (itemKey: string, o: Record<string, unknown> = {}) => ({ ...request({ type: 'cabin', name: undefined, notes: undefined, maxSize: { x: 64, y: 64, z: 64 } }), itemKey, ...o });
const final = (s: string) => ['done', 'failed', 'cancelled'].includes(s);
const usd = (n: number) => Math.round(n * 1e6) / 1e6;

describe.skipIf(!hasKit)('the sim as the consumer stub (real kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('a Steward-sized flow at the default step time: card, bible, 3 massings, a redirect, approval, 3 details, in < 2 min; measured costs sum exactly', async () => {
    h = await harness({ simStepMs: 400, simCosts: { ...MEASURED_SIM_COSTS } });
    const sc = h.sc;
    const t0 = Date.now();
    const schema = { type: 'object', properties: { title: { type: 'string' }, floors: { type: 'integer' } }, required: ['title', 'floors'] };
    const job = sc.jobs.run(JobSpec.parse({ kind: 'structured', prompt: 'a card', schema, ext: { 'architect:simAnswer': { title: 'Mill', floors: 2 } } }), undefined);
    await until(() => final(sc.jobs.book.get(job.id)!.status), 30_000);
    expect(sc.jobs.book.get(job.id)).toMatchObject({ status: 'done', result: { title: 'Mill', floors: 2 } });
    const bj = sc.bibles.request(BibleRequest.parse({ prompt: 'a mill town', name: 'Mill Town', owner: 'steward:s1' }));
    await until(() => final(sc.bibles.get(bj.id)!.status), 60_000);
    expect(sc.bibles.get(bj.id)!.status).toBe('done');
    expect(sc.bibles.get(bj.id)!.cost.usd).toBe(1.35);
    const g = sc.groups.create(GroupRequest.parse({ name: 'Hamlet', bible: bj.bibleId, owner: 'steward:s1', massingFirst: true, approvalUi: 'owner', items: [item('a'), item('b', { type: 'tavern' }), item('c', { type: 'tower' })] }));
    const allWaiting = (v?: number) => () => {
      const x = sc.groups.get(g.id)!;
      return x.status === 'awaiting_approval' && x.items.every((i) => i.stage === 'approval') && (v === undefined || x.items[0]!.massing!.version === v);
    };
    await until(allWaiting(1), 60_000);
    expect(() => sc.groups.approve(g.id, { approve: ['a'], redirect: {}, cancel: [], owner: 'someone:else' })).toThrow();
    sc.groups.approve(g.id, { approve: [], redirect: { a: 'a longer hall' }, cancel: [], owner: 'steward:s1' });
    await until(allWaiting(2), 60_000);
    sc.groups.approve(g.id, { approve: ['a', 'b', 'c'], redirect: {}, cancel: [], owner: 'steward:s1' });
    await until(() => final(sc.groups.get(g.id)!.status), 90_000);
    const done = sc.groups.get(g.id)!;
    const secs = (Date.now() - t0) / 1000;
    expect(done.status).toBe('done');
    expect(done.items.every((i) => i.status === 'done' && i.entryId)).toBe(true);
    // 4 massings (3 + the redirect) and 3 details
    expect(done.cost.usd).toBe(usd(4 * 0.19 + 3 * 3.4));
    expect(secs).toBeLessThan(120);
    const ack = await new Promise<Extract<Outbound, { type: 'ack' }>>((res) => {
      void sc.handle({ v: 1, id: 'e1', type: 'design.estimate', group: GroupRequest.parse({ name: 'E', bible: bj.bibleId, items: [item('a')] }) } as never, (m) => {
        if (m.type === 'ack') res(m);
      });
    });
    expect(ack.ok).toBe(true);
    expect(String(ack.result?.basis)).toMatch(/sim: true, notional sim costs "measured"/);
  }, 150_000);

  it('sim:fail fails the design; sim:repair adds one repair round; sim:usage_limit holds the group', async () => {
    h = await harness({ simCosts: { ...MEASURED_SIM_COSTS } });
    const sc = h.sc;
    const g = sc.groups.create(GroupRequest.parse({ name: 'Faults', bible: 'birch', concurrency: 3, items: [item('f', { notes: 'sim:fail' }), item('r', { ext: { 'architect:sim': ['repair'] } }), item('ok')] }));
    await until(() => final(sc.groups.get(g.id)!.status), 60_000);
    const x = sc.groups.get(g.id)!;
    const [f, r, ok] = x.items;
    expect(f!.status).toBe('failed');
    expect(sc.designs.get(f!.designId)!.error).toMatch(/sim:fail/);
    expect(r!.status).toBe('done');
    expect(sc.designs.get(r!.designId)!.cost).toMatchObject({ usd: usd(3.4 + 0.5), turns: 4 });
    expect(sc.store.data.work[r!.designId]!.sim).toMatchObject({ round: 2, repaired: true });
    expect(sc.designs.get(ok!.designId)!.cost).toMatchObject({ usd: 3.4, turns: 3 });
    // the usage limit: the group holds, then finishes; the item's cost is still the detail's figure (a step run again adds nothing)
    const g2 = sc.groups.create(GroupRequest.parse({ name: 'Held', bible: 'birch', items: [item('u', { notes: 'sim:usage_limit' })] }));
    await until(() => final(sc.groups.get(g2.id)!.status), 60_000);
    expect(h!.events.some((e) => e.type === 'group.upsert' && e.group.id === g2.id && e.group.status === 'held_usage')).toBe(true);
    expect(sc.groups.get(g2.id)!.status).toBe('done');
    expect(sc.designs.get(sc.groups.get(g2.id)!.items[0]!.designId)!.cost!.usd).toBe(3.4);
  }, 90_000);

  it('a report critique costs the critique figure; zero costs keep the old step costs', async () => {
    h = await harness({ simCosts: { ...MEASURED_SIM_COSTS } });
    const g = h.sc.groups.create(GroupRequest.parse({ name: 'Crit', bible: 'birch', critique: { mode: 'report' }, items: [item('a')] }));
    await until(() => final(h!.sc.groups.get(g.id)!.status), 60_000);
    const d = h.sc.designs.get(h.sc.groups.get(g.id)!.items[0]!.designId)!;
    expect(d.status).toBe('done');
    expect(d.critique!.cost.critic.usd).toBe(0.1);
    expect(d.cost!.usd).toBe(usd(3.4 + 0.1));
    await h.close();
    h = await harness({ simDesignUsd: 0.1 });
    const g2 = h.sc.groups.create(GroupRequest.parse({ name: 'Old', bible: 'birch', items: [item('a', { notes: 'sim:repair' })] }));
    await until(() => final(h!.sc.groups.get(g2.id)!.status), 60_000);
    expect(h.sc.designs.get(h.sc.groups.get(g2.id)!.items[0]!.designId)!.cost).toMatchObject({ usd: 0.4, turns: 4 });
  }, 90_000);

  it('a scripted answer that does not match the schema fails the job at once', async () => {
    h = await harness();
    const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };
    const j = h.sc.jobs.run(JobSpec.parse({ kind: 'structured', prompt: 'a card', schema, ext: { 'architect:simAnswer': { name: 'Mill' } } }), undefined);
    await until(() => final(h!.sc.jobs.book.get(j.id)!.status), 10_000);
    expect(h.sc.jobs.book.get(j.id)).toMatchObject({ status: 'failed' });
    expect(h.sc.jobs.book.get(j.id)!.error).toMatch(/scripted answer .* does not match the job's schema/);
  }, 30_000);
});
