// Phase 6c slice 0a, the sidecar half (docs/CONTRACT.md "Phase 6c slice 0a" §6-§8, §13 items 5-8): caller operation keys
// (adopt, conflict, owner scope, the key on disk before the ack, lookups across a restart), group seq / lastAction, the
// per-stage breakdown (stage lines, totals, the bible line once per owner, QUEUED, USAGE_HOLD, the log line), and the
// bible.cancel ack with the job.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, MEASURED_SIM_COSTS, type Config } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { bodyHash, canonicalJson } from '../src/opkeys.js';
import type { Group, Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'tools', 'components.mjs'));

interface H {
  root: string;
  sc: Sidecar;
  events: Outbound[];
  log: ReturnType<typeof memoryLogger>;
  close(keep?: boolean): Promise<void>;
}

async function harness(over: Partial<Config> = {}, root = tempDir('arch-0a-')): Promise<H> {
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
  cfg.simStepMs = 15;
  cfg.simLimitMs = 600;
  Object.assign(cfg, over);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const log = memoryLogger();
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), log);
  const events: Outbound[] = [];
  sc.subscribe((m) => events.push(m));
  await sc.start(new SimDesigner(sc, cfg.simStepMs));
  return {
    root,
    sc,
    events,
    log,
    close: async (keep = false) => {
      await sc.close();
      if (!keep) rmrf(root);
    },
  };
}

let n = 0;
/** One client message through Sidecar.handle; resolves with its ack. */
function send(sc: Sidecar, msg: Record<string, unknown>): Promise<{ ok: boolean; error?: string; result?: Record<string, unknown> }> {
  const id = `t${++n}`;
  return new Promise((res) => {
    void sc.handle({ v: 1, id, ...msg } as never, (m) => {
      if (m.type === 'ack' && m.re === id) res(m as never);
      if (m.type === 'error') res({ ok: false, error: (m as { message?: string }).message } as never);
    });
  });
}

const item = (itemKey: string, o: Record<string, unknown> = {}) => ({ ...request({ type: 'cabin', name: undefined, notes: undefined, maxSize: { x: 64, y: 64, z: 64 } }), itemKey, ...o });
const final = (s: string) => ['done', 'failed', 'cancelled'].includes(s);
const upserts = (h: H, id: string) => h.events.filter((e): e is Extract<Outbound, { type: 'group.upsert' }> => e.type === 'group.upsert' && e.group.id === id).map((e) => e.group);

describe('opKeys: canonical bodies', () => {
  it('hashes the canonical JSON without the key (key order and the key itself do not matter)', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(bodyHash({ a: 1, b: 2, opKey: 'x' })).toBe(bodyHash({ b: 2, a: 1, opKey: 'y' }));
    expect(bodyHash({ a: 1 })).not.toBe(bodyHash({ a: 2 }));
  });
});

describe.skipIf(!hasKit)('slice 0a sidecar (sim backend, real kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('C9: a bible request and a group with an opKey adopt, conflict, are owner-scoped, are on disk at the ack, and are found across a restart', async () => {
    const root = tempDir('arch-0a-keys-');
    h = await harness({}, root);
    const sc = h.sc;
    const breq = { prompt: 'a mill town', name: 'Mill', owner: 'steward:s1', opKey: 'st:bible:1' };
    const b1 = await send(sc, { type: 'bible.request', request: breq });
    expect(b1).toMatchObject({ ok: true, result: { adopted: false } });
    // on disk before the ack (the same write that created the job)
    const disk = JSON.parse(fs.readFileSync(path.join(sc.config.dataDir, 'state.json'), 'utf8'));
    expect(disk.opKeys['bible|steward:s1|st:bible:1'].id).toBe(b1.result!.jobId);
    expect(disk.bibleJobs.some((j: { id: string }) => j.id === b1.result!.jobId)).toBe(true);
    const b2 = await send(sc, { type: 'bible.request', request: { ...breq } });
    expect(b2.result).toMatchObject({ jobId: b1.result!.jobId, adopted: true });
    const bc = await send(sc, { type: 'bible.request', request: { ...breq, prompt: 'another town' } });
    expect(bc.ok).toBe(false);
    expect(bc.error).toMatch(/^op_key_conflict: /);
    const bo = await send(sc, { type: 'bible.request', request: { ...breq, owner: 'other:mod' } });
    expect(bo.result).toMatchObject({ adopted: false });
    expect(bo.result!.jobId).not.toBe(b1.result!.jobId);
    expect(sc.bibles.list().length).toBe(2);
    await until(() => final(sc.bibles.get(b1.result!.jobId as string)!.status), 30_000);
    // adopted in any state (done)
    expect((await send(sc, { type: 'bible.request', request: { ...breq } })).result).toMatchObject({ jobId: b1.result!.jobId, adopted: true });
    expect((await send(sc, { type: 'bible.byKey', owner: 'steward:s1', opKey: 'st:bible:1' })).result).toMatchObject({ job: { id: b1.result!.jobId, opKey: 'st:bible:1', status: 'done' } });
    expect((await send(sc, { type: 'bible.byKey', opKey: 'st:bible:1' })).result).toEqual({});
    // a group
    const greq = { name: 'Hamlet', bible: 'birch', owner: 'steward:s1', opKey: 'st:group:1', items: [item('a')] };
    const g1 = await send(sc, { type: 'design.group', group: greq });
    expect(g1.result).toMatchObject({ adopted: false });
    const g2 = await send(sc, { type: 'design.group', group: { ...greq } });
    expect(g2.result).toMatchObject({ groupId: g1.result!.groupId, adopted: true, designIds: g1.result!.designIds });
    expect((await send(sc, { type: 'design.group', group: { ...greq, name: 'Other' } })).error).toMatch(/^op_key_conflict/);
    expect(sc.groups.list().length).toBe(1);
    // a restart: the lookups still answer
    await h.close(true);
    h = await harness({}, root);
    expect((await send(h.sc, { type: 'group.byKey', owner: 'steward:s1', opKey: 'st:group:1' })).result).toMatchObject({ group: { id: g1.result!.groupId, opKey: 'st:group:1' } });
    expect((await send(h.sc, { type: 'group.byKey', owner: 'steward:s1', opKey: 'never' })).result).toEqual({});
    expect((await send(h.sc, { type: 'design.group', group: { ...greq } })).result).toMatchObject({ groupId: g1.result!.groupId, adopted: true });
  }, 90_000);

  it('C7: seq strictly increases on transitions only; lastAction names them; the breakdown lines sum, the bible line once per owner; the log line', async () => {
    h = await harness({ simCosts: { ...MEASURED_SIM_COSTS } });
    const sc = h.sc;
    const b = await send(sc, { type: 'bible.request', request: { prompt: 'a mill town', name: 'Mill', owner: 'steward:s1' } });
    await until(() => final(sc.bibles.get(b.result!.jobId as string)!.status), 30_000);
    const bibleId = b.result!.bibleId as string;
    const g = (await send(sc, { type: 'design.group', group: { name: 'G', bible: bibleId, owner: 'steward:s1', massingFirst: true, approvalUi: 'owner', critique: { mode: 'report' }, items: [item('a', { notes: 'sim:repair' }), item('b')] } })).result!;
    const gid = g.groupId as string;
    await until(() => sc.groups.get(gid)!.status === 'awaiting_approval', 30_000);
    await send(sc, { type: 'group.approve', groupId: gid, owner: 'steward:s1', approve: ['a', 'b'] });
    await until(() => final(sc.groups.get(gid)!.status), 60_000);
    const ups = upserts(h, gid);
    const seqs = ups.map((u) => u.seq!);
    // non-decreasing across every upsert, strictly increasing across the distinct transitions, no repeats of a seq with another signature
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThanOrEqual(seqs[i - 1]!);
    const distinct = [...new Set(seqs)];
    expect(distinct).toEqual([...distinct].sort((x, y) => x - y));
    expect(distinct[0]).toBe(1);
    const actions = ups.filter((u, i) => i === 0 || u.seq !== ups[i - 1]!.seq).map((u) => u.lastAction);
    expect(actions[0]).toBe('created');
    for (const a of ['awaiting_approval', 'approved', 'done']) expect(actions).toContain(a);
    // cost-only upserts do not bump seq
    expect(seqs.length).toBeGreaterThan(distinct.length);
    const done = sc.groups.get(gid)!;
    const bd = done.breakdown!;
    const st = bd.stages;
    expect(st.bible).toMatchObject({ usd: 1.35, count: 1 });
    expect(bd.bibleJobIds).toEqual([b.result!.jobId]);
    // 2 massings at round 1 ($0.19 each; a's massing also has sim:repair: + $0.50), 2 details ($3.40; a's + $0.50), 2 report critiques ($0.10)
    expect(st.massing!.usd).toBeCloseTo(2 * 0.19, 6);
    expect(st.detail!.usd).toBeCloseTo(2 * 3.4, 6);
    expect(st.repair).toMatchObject({ count: 2 });
    expect(st.repair!.usd).toBeCloseTo(2 * 0.5, 6);
    expect(st.critique!.usd).toBeCloseTo(2 * 0.1, 6);
    const lineSum = ['massing', 'detail', 'repair', 'critique'].reduce((a, k) => a + (st[k as keyof typeof st]?.usd ?? 0), 0);
    expect(lineSum).toBeCloseTo(done.cost.usd, 3);
    expect(bd.totalUsd).toBeCloseTo(done.cost.usd + 1.35, 3);
    expect(bd.wallMs).toBeGreaterThan(0);
    expect(bd.firstDetailedMs).toBeGreaterThan(0);
    for (const k of ['bible', 'massing', 'detail', 'repair', 'critique', 'queued', 'usage_hold']) expect(st).toHaveProperty(k);
    const lines = h.log.lines.filter((l) => l.includes(`group ${gid} breakdown `));
    expect(lines.length, lines.map((l) => l.slice(0, 60)).join(" / ") + " :: " + upserts(h, gid).map((u) => `${u.seq}:${u.lastAction}:${u.status}`).join(" ")).toBe(2); // at awaiting approval and at the end
    // a second group of the same owner on the same bible version: its bible line is 0
    const g2 = (await send(sc, { type: 'design.group', group: { name: 'G2', bible: bibleId, owner: 'steward:s1', items: [item('c')] } })).result!;
    await until(() => final(sc.groups.get(g2.groupId as string)!.status), 30_000);
    expect(sc.groups.get(g2.groupId as string)!.breakdown!.stages.bible).toMatchObject({ usd: 0, count: 0 });
    expect(sc.groups.get(g2.groupId as string)!.breakdown!.bibleJobIds).toEqual([]);
  }, 120_000);

  it('C7: QUEUED time at concurrency 1, USAGE_HOLD time under sim:usage_limit', async () => {
    h = await harness({ designConcurrency: 1 });
    const g = h.sc.groups.create({ name: 'Q', bible: 'birch', concurrency: 1, items: [item('a'), item('b'), item('c', { notes: 'sim:usage_limit' })] } as never) as Group;
    await until(() => final(h!.sc.groups.get(g.id)!.status), 60_000);
    const bd = h.sc.groups.get(g.id)!.breakdown!;
    expect(bd.stages.queued!.ms).toBeGreaterThan(0);
    expect(bd.stages.usage_hold!.ms).toBeGreaterThan(0);
  }, 90_000);

  it('bible.cancel acks with the job, cancelled; a second cancel fails "already cancelled"', async () => {
    h = await harness({ simStepMs: 2000 });
    const b = await send(h.sc, { type: 'bible.request', request: { prompt: 'slow', name: 'Slow' } });
    const c = await send(h.sc, { type: 'bible.cancel', jobId: b.result!.jobId });
    expect(c.result).toMatchObject({ jobId: b.result!.jobId, job: { id: b.result!.jobId, status: 'cancelled' } });
    const c2 = await send(h.sc, { type: 'bible.cancel', jobId: b.result!.jobId });
    expect(c2.ok).toBe(false);
    expect(c2.error).toMatch(/already cancelled/);
  }, 30_000);
});
