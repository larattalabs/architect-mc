// Phase 5a: the critique loop on the sim backend (docs/CONTRACT.md "Phase 5a gate" item 1). Each case is a scripted
// verdict sequence (critic.ts simVerdict: `sim:critique=<r0>/<r1>/...` in the notes).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { blueprintSummary, readVerdict, revisionPrompt, shipRule, simVerdict, verdictSchema } from '../src/critic.js';
import { bestRound } from '../src/critique.js';
import { validateJson } from '../src/jobs/schema.js';
import { DesignRequest, GroupRequest, toProtocol1, type Design, type Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.resolve(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'build.mjs'));

interface H {
  root: string;
  sc: Sidecar;
  events: Outbound[];
  close(keep?: boolean): Promise<void>;
}

async function harness(over: Partial<Config> = {}, root = tempDir('arch-5a-')): Promise<H> {
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
  cfg.simStepMs = 15;
  cfg.simLimitMs = 600;
  // round 0 costs 3 x $0.1; a critic call $0.01; a revision 3 x $0.1
  cfg.simDesignUsd = 0.1;
  cfg.jobs.simStepUsd = 0.01;
  Object.assign(cfg, over);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
  const events: Outbound[] = [];
  sc.subscribe((m) => events.push(m));
  await sc.start(new SimDesigner(sc, cfg.simStepMs));
  return {
    root,
    sc,
    events,
    close: async (keep = false) => {
      await sc.close();
      if (!keep) rmrf(root);
    },
  };
}

const LOOP = (o: Record<string, unknown> = {}) => ({ mode: 'loop' as const, budgetUsd: 5, ...o });
const design = (h: H, notes: string, critique: Record<string, unknown> = LOOP(), over: Record<string, unknown> = {}) =>
  h.sc.requestDesign(DesignRequest.parse(request({ name: undefined, notes, maxSize: { x: 64, y: 64, z: 64 }, critique, ...over })));
const final = (h: H, id: string, ms = 60_000) => until(() => ['done', 'failed', 'cancelled'].includes(h.sc.designs.get(id)!.status), ms);
const get = (h: H, id: string) => h.sc.designs.get(id)!;
const scratch = (h: H, id: string) => path.join(h.sc.config.dataDir, 'designs', id);
const entryDir = (h: H, d: Design) => path.join(h.sc.config.libraryDir, d.blueprintId!);

describe('the critic (pure)', () => {
  it('the ship rule: mean >= shipScore, nothing below shipScore - 2, no P0', () => {
    expect(shipRule({ a: 7, b: 7 }, [], 7)).toBe(true);
    expect(shipRule({ a: 9, b: 4 }, [], 7)).toBe(false);
    expect(shipRule({ a: 8, b: 8 }, [{ priority: 'P0', part: null, view: 'iso', what: 'x', fix: 'y' }], 7)).toBe(false);
    expect(shipRule({ a: 6, b: 7 }, [], 7)).toBe(false);
  });

  it('a verdict: unknown parts become null with a note, overall is the mean, the schema accepts the sim verdicts', () => {
    const dims = ['silhouette', 'legibility', 'craft', 'materials', 'brief', 'x1'];
    const schema = verdictSchema(dims, ['iso', 'front']);
    const raw = simVerdict('sim:critique=5?part', 0, dims, ['main', 'roof']);
    expect(validateJson(raw, schema)).toEqual([]);
    const v = readVerdict(raw, { dims, parts: ['main', 'roof'], shipScore: 7, previousCount: 0 });
    expect(v.overall).toBe(5);
    expect(v.unknownParts).toBe(1);
    expect(v.notes[0]).toMatch(/unknown part "no_such_part" became null/);
    expect(v.issues.every((i) => i.part === null || ['main', 'roof'].includes(i.part))).toBe(true);
    expect(v.ship).toBe(false);
    expect(readVerdict(simVerdict('sim:critique=8', 0, dims, []), { dims, parts: [], shipScore: 7, previousCount: 0 }).ship).toBe(true);
    // a P0 never ships
    expect(readVerdict(simVerdict('sim:critique=9!P0', 0, dims, ['main']), { dims, parts: ['main'], shipScore: 7, previousCount: 0 }).ship).toBe(false);
  });

  it('the best round: highest overall among kept rounds, ties to the later; none scored: the last kept', () => {
    const r = (n: number, overall: number | null, kept = true) => ({ n, verdict: null, overall, scores: {}, issues: [], resolved: [], ship: false, cost: 0, ms: 0, kept });
    expect(bestRound([r(0, 6), r(1, 7), r(2, 7)])!.n).toBe(2);
    expect(bestRound([r(0, 7), r(1, 5), r(2, null, false)])!.n).toBe(0);
    expect(bestRound([r(0, null)])!.n).toBe(0);
  });

  it('the summary stays under 4000 chars; the revision prompt carries the rules', () => {
    const s = blueprintSummary({ sidecar: { type: 'cabin', size: { x: 9, y: 9, z: 9 }, front: 'south', parts: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`part_${i}`, { box: [0, 0, 0, 1, 1, 1], cells: 3 }])) }, warnings: Array.from({ length: 50 }, (_, i) => `warning ${i} ${'x'.repeat(100)}`), metrics: { accentShare: 0.1 } });
    expect(s.length).toBeLessThanOrEqual(4000);
    const p = revisionPrompt('gen_x', { n: 0, verdict: 'iterate', overall: 5.5, scores: { craft: 5 }, issues: [{ priority: 'P1', part: 'roof', view: 'iso', what: 'cluttered roof', fix: 'remove the moss' }], resolved: [], ship: false, cost: 0, ms: 0, kept: true }, 1, 2);
    expect(p).toContain('remove before adding');
    expect(p).toContain('critique/0/');
    expect(p).toContain('part `roof`');
  });
});

describe.skipIf(!hasKit)('the critique loop (sim backend, real kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('ships at round 0: one critic call, installs round 0, critique.json and the entry summary', async () => {
    h = await harness();
    const d = design(h, 'sim:critique=8');
    await final(h, d.id);
    const f = get(h, d.id);
    expect(f.status).toBe('done');
    expect(f.critique).toMatchObject({ mode: 'loop', end: 'ship', best: 0, overall: 8 });
    expect(f.critique!.rounds).toHaveLength(1);
    expect(f.critique!.cost.critic.usd).toBeCloseTo(0.01, 6);
    expect(f.critique!.cost.revise.usd).toBe(0);
    expect(f.cost!.usd).toBeCloseTo(0.31, 6);
    expect(f.step).toMatch(/critique: shipped at round 0 \(8\)/);
    expect(h.events.some((e) => e.type === 'design.upsert' && e.design.id === d.id && e.design.status === 'critiquing')).toBe(true);
    const cj = JSON.parse(fs.readFileSync(path.join(entryDir(h, f), 'critique.json'), 'utf8')) as Record<string, unknown>;
    expect(cj).toMatchObject({ format: 1, entryId: f.blueprintId, mode: 'loop', end: 'ship', verdict: { overall: 8, ship: true } });
    expect(String(cj.entryRevision)).toMatch(/^[0-9a-f]{64}$/);
    const bp = JSON.parse(fs.readFileSync(path.join(entryDir(h, f), `${f.blueprintId}.blueprint.json`), 'utf8')) as Record<string, unknown>;
    expect(bp.critique).toMatchObject({ end: 'ship', overall: 8, best: 0 });
    // the critic job: structured, Sonnet medium, the critic's images (at least the views the renderer made)
    const job = h.sc.jobs.book.list().find((j) => (j.spec as { owner?: string }).owner === 'architect:critic')!;
    expect(job.spec).toMatchObject({ kind: 'structured', model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 3 });
    expect(h.sc.jobs.book.work(job.id)!.images!.length).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('iterate then ship: a revision in the same loop, the best (later) round installs', async () => {
    h = await harness();
    const d = design(h, 'sim:critique=5/8');
    await final(h, d.id);
    const f = get(h, d.id);
    expect(f.critique).toMatchObject({ end: 'ship', best: 1, overall: 8 });
    expect(f.critique!.rounds.map((r) => [r.n, r.overall, r.kept])).toEqual([
      [0, 5, true],
      [1, 8, true],
    ]);
    expect(f.critique!.cost.revise.usd).toBeCloseTo(0.1, 6);
    expect(f.critique!.cost.critic.usd).toBeCloseTo(0.02, 6);
    expect(f.critique!.rounds[1]!.resolved).toEqual([0]);
    const steps = h.events.filter((e): e is Extract<Outbound, { type: 'design.upsert' }> => e.type === 'design.upsert' && e.design.id === d.id).map((e) => e.design.step);
    expect(steps.some((s) => /revising after critique \(1 of 2\): 1 issue/.test(s))).toBe(true);
    expect(steps.some((s) => s === 'critic: round 1')).toBe(true);
    for (const n of [0, 1]) expect(fs.existsSync(path.join(scratch(h, d.id), 'rounds', String(n)))).toBe(true);
  }, 60_000);

  it('a regression keeps the best round (round 0 installs)', async () => {
    h = await harness();
    const d = design(h, 'sim:critique=6/4');
    await final(h, d.id);
    const f = get(h, d.id);
    expect(f.critique).toMatchObject({ end: 'regressed', best: 0, overall: 6 });
    const installed = fs.readFileSync(path.join(entryDir(h, f), `${f.blueprintId}.nbt`));
    const bp = h.sc.store.data.work[d.id]!.critique!.bp;
    expect(installed.equals(fs.readFileSync(path.join(scratch(h, d.id), 'rounds', '0', `${bp}.nbt`)))).toBe(true);
  }, 60_000);

  it('max_revisions: 2 revisions then a last critic call scores the final round', async () => {
    h = await harness();
    const d = design(h, 'sim:critique=5/5/5/5');
    await final(h, d.id);
    const f = get(h, d.id);
    expect(f.critique).toMatchObject({ end: 'max_revisions', best: 2 });
    expect(f.critique!.rounds).toHaveLength(3);
  }, 60_000);

  it('budget: the default 1.0x round-0 cap ends the loop before a revision that would not fit', async () => {
    h = await harness();
    const d = design(h, 'sim:critique=5/5/5/5', { mode: 'loop', maxRevisions: 3 });
    await final(h, d.id);
    const f = get(h, d.id);
    // round 0 cost $0.30 (the cap); each revision $0.10 plus a critic $0.01: the third does not fit what is left ($0.07)
    expect(f.critique).toMatchObject({ end: 'budget' });
    expect(f.critique!.rounds).toHaveLength(3);
    const loop = f.critique!.cost.critic.usd + f.critique!.cost.revise.usd;
    expect(loop).toBeLessThanOrEqual(0.3 + 1e-9);
  }, 60_000);

  it('budget: an explicit critique.budgetUsd allows one revision, then ends', async () => {
    h = await harness();
    const d = design(h, 'sim:critique=5/5/5', { mode: 'loop', budgetUsd: 0.15 });
    await final(h, d.id);
    const f = get(h, d.id);
    expect(f.critique).toMatchObject({ end: 'budget' });
    expect(f.critique!.rounds).toHaveLength(2);
    expect(f.critique!.cost.critic.usd + f.critique!.cost.revise.usd).toBeLessThanOrEqual(0.15 + 1e-9);
  }, 60_000);

  it('time: the loop ends at the first round boundary after maxMinutes', async () => {
    h = await harness();
    const d = design(h, 'sim:critique=5/5', LOOP({ maxMinutes: 0.0001 }));
    await final(h, d.id);
    expect(get(h, d.id).critique).toMatchObject({ end: 'time', best: 0 });
  }, 60_000);

  it('check_failed: a revision that keeps failing its check (its own allowance) installs the best earlier round', async () => {
    h = await harness();
    const d = design(h, 'sim:critique=5/8 sim:revise=fail');
    await final(h, d.id);
    const f = get(h, d.id);
    expect(f.status).toBe('done');
    expect(f.critique).toMatchObject({ end: 'check_failed', best: 0 });
    expect(f.critique!.rounds[1]).toMatchObject({ n: 1, kept: false });
    expect(f.critique!.rounds[1]!.error).toBeTruthy();
  }, 60_000);

  it('critic_failed: the critic call fails twice; round 0 installs with a note', async () => {
    h = await harness();
    const d = design(h, 'sim:critique=fail');
    await final(h, d.id);
    const f = get(h, d.id);
    expect(f.status).toBe('done');
    expect(f.critique).toMatchObject({ end: 'critic_failed', best: 0 });
    expect(h.sc.jobs.book.list().filter((j) => (j.spec as { owner?: string }).owner === 'architect:critic' && j.status === 'failed')).toHaveLength(2);
  }, 60_000);

  it('an unknown part name becomes null and counts against part grounding', async () => {
    h = await harness();
    const d = design(h, 'sim:critique=5?part/8');
    await final(h, d.id);
    const r0 = get(h, d.id).critique!.rounds[0]!;
    expect(r0.unknownParts).toBe(1);
    expect(r0.notes![0]).toMatch(/unknown part/);
    expect(r0.issues.some((i) => i.part === null)).toBe(true);
  }, 60_000);

  it('report mode: one critic call, no revision', async () => {
    h = await harness();
    const d = design(h, 'sim:critique=5', { mode: 'report' });
    await final(h, d.id);
    expect(get(h, d.id).critique).toMatchObject({ mode: 'report', end: 'max_revisions', best: 0 });
    expect(get(h, d.id).critique!.rounds).toHaveLength(1);
  }, 60_000);

  it('a restart mid-critic and a restart mid-revision both finish the loop', async () => {
    const root = tempDir('arch-5a-restart-');
    h = await harness({ simStepMs: 250 }, root);
    const d = design(h, 'sim:critique=5/8');
    await until(() => get(h!, d.id).status === 'critiquing', 30_000);
    await h.close(true);
    h = await harness({ simStepMs: 250 }, root);
    // mid-revision now
    await until(() => h!.sc.critiques.revising(d.id) && get(h!, d.id).status === 'designing', 30_000);
    await h.close(true);
    h = await harness({}, root);
    await final(h, d.id);
    expect(get(h, d.id).critique).toMatchObject({ end: 'ship', best: 1 });
    expect(get(h, d.id).status).toBe('done');
  }, 90_000);

  it('a usage limit mid-critic holds the group (held_usage), then the loop resumes', async () => {
    h = await harness();
    const g = h.sc.groups.create(GroupRequest.parse({ name: 'Held', bible: 'rustic', critique: LOOP(), items: [{ ...request({ name: undefined, notes: 'sim:critique=5L/8', maxSize: { x: 64, y: 64, z: 64 } }), itemKey: 'a' }] }));
    await until(() => h!.sc.groups.get(g.id)!.status === 'held_usage', 30_000);
    const id = g.items[0]!.designId;
    expect(get(h, id).status).toBe('critiquing');
    await until(() => ['done', 'failed'].includes(h!.sc.groups.get(g.id)!.status), 60_000);
    expect(get(h, id).critique).toMatchObject({ end: 'ship', best: 1 });
    expect(h.sc.groups.get(g.id)!.items[0]!.critique).toMatchObject({ rounds: 2, best: 1, end: 'ship', overall: 8 });
  }, 90_000);

  it("a group's soft budget stops new revisions (the item installs its best round)", async () => {
    h = await harness({ designConcurrency: 1 });
    h.sc.config.groups.softBudgetFraction = 0.5;
    // budget $0.6: soft at $0.30, reached by round 0 itself
    const g = h.sc.groups.create(GroupRequest.parse({ name: 'Thrifty', bible: 'rustic', budgetUsd: 0.6, critique: LOOP(), items: [{ ...request({ name: undefined, notes: 'sim:critique=5/8', maxSize: { x: 64, y: 64, z: 64 } }), itemKey: 'a' }] }));
    await until(() => ['done', 'failed', 'paused_budget'].includes(h!.sc.groups.get(g.id)!.status) && h!.sc.designs.get(g.items[0]!.designId)!.status === 'done', 60_000);
    expect(get(h, g.items[0]!.designId).critique).toMatchObject({ end: 'budget', best: 0 });
  }, 60_000);

  it('a protocol-1 client sees critiquing as rendering, and never sees a report of an entry', async () => {
    h = await harness();
    const d = design(h, 'sim:critique=8');
    await until(() => get(h!, d.id).status === 'critiquing', 30_000);
    const v1 = toProtocol1({ type: 'design.upsert', v: 1, design: structuredClone(get(h, d.id)) }) as { design: { status: string; critique?: unknown } };
    expect(v1.design.status).toBe('rendering');
    expect(v1.design.critique).toBeUndefined();
    await final(h, d.id);
    const r = h.sc.critiques.reportEntry(get(h, d.id).blueprintId!, undefined);
    expect(toProtocol1({ type: 'design.upsert', v: 1, design: structuredClone(h.sc.designs.get(r.id)) })).toBeUndefined();
    await final(h, r.id);
    expect(get(h, r.id)).toMatchObject({ status: 'done', critiqueOf: get(h, d.id).blueprintId, blueprintId: get(h, d.id).blueprintId });
  }, 60_000);

  it('the estimate with critique: separate figures, low = 1 critic, high capped at 1.0x round 0', () => {
    const est = (spec: Record<string, unknown> | undefined) => new Sidecar(loadConfig(['--data', tempDir(), '--library', tempDir(), '--kit', KIT], {}), new Store(tempDir()), memoryLogger()).estimates.design(DesignRequest.parse(request({ model: 'claude-sonnet-5-5', ...(spec ? { critique: spec } : {}) })), { designConcurrency: 3, now: Date.now(), designModel: 'claude-opus-5-5', landmarkModel: 'claude-opus-5-5', ordinaryModel: 'claude-sonnet-5-5', bibleModel: 'claude-opus-5-5', massingModel: 'claude-sonnet-5-5', criticModel: 'claude-sonnet-5-5' });
    const off = est(undefined);
    expect(off.critiqueUsdLow).toBeUndefined();
    const on = est({ mode: 'loop' });
    expect(on).toMatchObject({ usdLow: off.usdLow, usdHigh: off.usdHigh, critiqueUsdLow: 0.04, critiqueUsdHigh: 2.25 });
    expect(on.critiqueMinutesLow).toBe(0.5);
    expect(on.basis).toMatch(/critique: up to 2 revisions/);
    const report = est({ mode: 'report' });
    expect(report).toMatchObject({ critiqueUsdLow: 0.04, critiqueUsdHigh: 0.15 });
    const capped = est({ mode: 'loop', budgetUsd: 0.5 });
    expect(capped.critiqueUsdHigh).toBe(0.5);
  });

  it('a group estimate gives critique per item and in total; the item spec wins over the group default', () => {
    const sc = new Sidecar(loadConfig(['--data', tempDir(), '--library', tempDir(), '--kit', KIT], {}), new Store(tempDir()), memoryLogger());
    const g = GroupRequest.parse({ name: 'G', bible: 'rustic', critique: { mode: 'loop' }, items: [{ ...request(), itemKey: 'a' }, { ...request(), itemKey: 'b', critique: { mode: 'off' } }] });
    const e = sc.estimates.group(g, sc.estimateCtx());
    expect(e.items!.map((i) => [i.itemKey, i.critiqueUsdLow ?? null])).toEqual([
      ['a', 0.04],
      ['b', null],
    ]);
    expect(e.critiqueUsdLow).toBe(0.04);
    expect(e.critiqueMinutesHigh).toBeGreaterThan(0);
  });
});
