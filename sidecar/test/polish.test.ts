// Phase 5b: polish on the sim backend with the real kit (docs/CONTRACT.md "Phase 5b gate" item 1, sidecar): every end
// reason scripted, target selection (untargetable included), a scope failure then a fix, the acceptance rule, the caps,
// a restart mid-step, a usage hold, the estimate, notes routing, critique.mode "polish", and protocol-1 filtering.
// Scripts: the entry's request notes `sim:issues=...` (the report's issues), `sim:base=<score>`, `sim:polish=<t1>/<t2>`
// (polish.ts simToken / sim.ts polishBackend).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { acceptStep, defaultTarget } from '../src/polish.js';
import { DesignRequest, parseClientMessage, toProtocol1, type Design, type Outbound, type PolishSpec } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.resolve(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'tools', 'diff.mjs'));

interface H {
  root: string;
  sc: Sidecar;
  events: Outbound[];
  close(keep?: boolean): Promise<void>;
}

async function harness(over: Partial<Config> = {}, root = tempDir('arch-5b-'), stepMs = 10): Promise<H> {
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
  cfg.simStepMs = stepMs;
  cfg.simLimitMs = 400;
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

const FINAL = ['done', 'failed', 'cancelled'];
const final = (h: H, id: string, ms = 60_000) => until(() => FINAL.includes(h.sc.designs.get(id)!.status), ms);
const get = (h: H, id: string) => h.sc.designs.get(id)!;
const top = (h: H, e: string) => JSON.parse(fs.readFileSync(path.join(h.sc.config.libraryDir, e, `${e}.blueprint.json`), 'utf8')) as Record<string, unknown>;

/** A sim tavern entry (the kit example under a new id) whose notes script the polish. */
async function entry(h: H, notes: string, name = 'Polish Inn', over: Record<string, unknown> = {}): Promise<string> {
  const d = h.sc.requestDesign(DesignRequest.parse(request({ type: 'tavern', name, notes, maxSize: { x: 64, y: 64, z: 64 }, ...over })));
  await final(h, d.id);
  expect(get(h, d.id).status, get(h, d.id).error).toBe('done');
  return get(h, d.id).blueprintId!;
}
/** a polish; budgetUsd 5 unless the spec says (the default cap, 1.0x the sim design's $0.3, is a test of its own) */
async function polish(h: H, entryId: string, spec: PolishSpec = {}): Promise<Design> {
  const d = h.sc.polishes.request(entryId, { budgetUsd: 5, ...spec });
  await final(h, d.id);
  return get(h, d.id);
}

describe('polish rules (pure)', () => {
  const i = (priority: 'P0' | 'P1' | 'P2', part: string | null, what = 'x') => ({ priority, part, view: 'iso', what, fix: 'f' });
  it('the default target: the highest-priority open issue that names a part, verdict order; failed ones skipped', () => {
    const issues = [i('P2', 'roof'), i('P1', null), i('P1', 'porch'), i('P0', 'main'), i('P1', 'roof', 'y')];
    expect(defaultTarget(issues, new Set())!.index).toBe(3);
    expect(defaultTarget(issues, new Set(['P0|main|x']))!.index).toBe(2);
    expect(defaultTarget([i('P1', null)], new Set())).toBeUndefined();
    expect(defaultTarget(issues, new Set(), ['roof'])!.index).toBe(4);
  });
  it('acceptance: the target resolved, no new P0, overall >= base - 0.5', () => {
    const base = { overall: 6, scores: {}, issues: [i('P1', 'roof'), i('P0', 'main')], resolved: [], modelVerdict: null, ship: false };
    const fresh = (o: Record<string, unknown>) => ({ ...base, resolved: [0], ...o });
    expect(acceptStep(base, fresh({}), 0)).toEqual({ accepted: true, failure: null });
    expect(acceptStep(base, fresh({ resolved: [] }), 0).failure).toBe('not_resolved');
    expect(acceptStep(base, fresh({ issues: [i('P0', 'roof')] }), 0).failure).toBe('new_p0');
    expect(acceptStep(base, fresh({ issues: [i('P0', 'main')] }), 0).accepted).toBe(true);
    expect(acceptStep(base, fresh({ overall: 5.5 }), 0).accepted).toBe(true);
    expect(acceptStep(base, fresh({ overall: 5.4 }), 0).failure).toBe('regressed');
  });
});

describe.skipIf(!hasKit)('polish (sim backend, real kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('polished: two targeted steps (P1 roof, then P1 taproom), one new version with delta.json and critique.json format 2', async () => {
    h = await harness();
    const e = await entry(h, 'sim:issues=P1@roof,P2@-,P1@taproom sim:polish=er/er');
    const d = await polish(h, e);
    expect(d.status, d.error).toBe('done');
    expect(d.kind).toBe('polish');
    const p = d.polish!;
    expect(p).toMatchObject({ entryId: e, fromVersion: 1, end: 'polished', installedVersion: 2, untargetable: 1, report: true });
    expect(p.steps.map((s) => [s.n, s.target?.part, s.accepted, s.failure])).toEqual([[1, 'roof', true, null], [2, 'taproom', true, null]]);
    expect(p.steps[0]!.allowedParts).toEqual(['roof']);
    expect(p.steps[0]!.changedCells).toBeGreaterThan(0);
    expect(p.prompts).toMatchObject({ status: 'draft' });
    const j = top(h, e);
    expect(j.version).toBe(2);
    expect((j.versions as Array<{ by: string; parent: number | null; summary: string }>).at(-1)).toMatchObject({ by: 'polish', parent: 1, summary: expect.stringMatching(/^polish: resolved 2 issues/) });
    const dir = path.join(h.sc.config.libraryDir, e);
    const delta = JSON.parse(fs.readFileSync(path.join(dir, 'versions', '2', 'delta.json'), 'utf8')) as { parts: Record<string, { status: string }>; from: number; to: number };
    expect(delta).toMatchObject({ entryId: e, from: 1, to: 2, frameKept: true });
    expect(Object.entries(delta.parts).filter(([, x]) => x.status !== 'UNCHANGED').map(([n]) => n).sort()).toEqual(['roof', 'taproom']);
    const cj = JSON.parse(fs.readFileSync(path.join(dir, 'critique.json'), 'utf8'));
    expect(cj).toMatchObject({ format: 2, entryVersion: 2, mode: 'polish', criticHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(h.events.some((m) => m.type === 'entry.versioned' && m.entryId === e && m.version === 2 && m.from === 1 && m.by === 'polish' && m.designId === d.id)).toBe(true);
    expect(fs.existsSync(path.join(dir, `${e}.parts.nbt`))).toBe(true);
    // a second polish reuses v2's fresh critique.json (no report): its only open issue has no part
    const d2 = await polish(h, e, { maxSteps: 1 });
    expect(d2.polish).toMatchObject({ fromVersion: 2, installedVersion: null, end: 'no_target', untargetable: 1 });
    expect(d2.polish!.report).toBeUndefined();
  }, 120_000);

  it('no_target: only issues without a part (untargetable); the fresh report becomes the head critique.json', async () => {
    h = await harness();
    const e = await entry(h, 'sim:issues=P1@-,P2@-');
    const d = await polish(h, e);
    expect(d.polish).toMatchObject({ end: 'no_target', installedVersion: null, untargetable: 2, steps: [] });
    expect(top(h, e).version ?? 1).toBe(1);
    const cj = JSON.parse(fs.readFileSync(path.join(h.sc.config.libraryDir, e, 'critique.json'), 'utf8'));
    expect(cj).toMatchObject({ format: 2, entryVersion: 1, mode: 'report' });
  }, 120_000);

  it('not_resolved, scope_failed, check_failed: nothing installs', async () => {
    h = await harness();
    const a = await entry(h, 'sim:issues=P1@roof sim:polish=en', 'A Inn');
    expect((await polish(h, a, { maxSteps: 1 })).polish).toMatchObject({ end: 'not_resolved', installedVersion: null });
    const b = await entry(h, 'sim:issues=P1@roof sim:polish=ex', 'B Inn');
    const pb = (await polish(h, b, { maxSteps: 1 })).polish!;
    expect(pb).toMatchObject({ end: 'scope_failed', installedVersion: null });
    expect(pb.steps[0]).toMatchObject({ failure: 'scope_failed', fixTurns: 2, accepted: false });
    const c = await entry(h, 'sim:issues=P1@roof sim:polish=et', 'C Inn');
    expect((await polish(h, c, { maxSteps: 1 })).polish).toMatchObject({ end: 'check_failed', installedVersion: null });
    for (const e of [a, b, c]) expect(top(h, e).version ?? 1).toBe(1);
  }, 120_000);

  it('a scope failure, then a fix turn that passes: the step is accepted (and the next step starts from the same base when one fails)', async () => {
    h = await harness();
    const e = await entry(h, 'sim:issues=P1@roof,P1@taproom sim:polish=x/ex1r');
    const p = (await polish(h, e)).polish!;
    expect(p.steps.map((s) => [s.target?.part, s.accepted, s.failure, s.fixTurns])).toEqual([['roof', false, 'scope_failed', 2], ['taproom', true, null, 1]]);
    expect(p).toMatchObject({ end: 'polished', installedVersion: 2 });
  }, 120_000);

  it('the acceptance rule: a new P0 and a drop over 0.5 are rejected; a rejected issue is not targeted again', async () => {
    h = await harness();
    const e = await entry(h, 'sim:base=6 sim:issues=P1@roof,P1@taproom sim:polish=erP/erd-1', 'Rule Inn');
    const p = (await polish(h, e)).polish!;
    expect(p.steps.map((s) => [s.target?.part, s.failure])).toEqual([['roof', 'new_p0'], ['taproom', 'regressed']]);
    expect(p.end).toBe('not_resolved');
    const e2 = await entry(h, 'sim:base=6 sim:issues=P1@roof sim:polish=erd-0.5', 'Slack Inn');
    expect((await polish(h, e2, { maxSteps: 1 })).polish).toMatchObject({ end: 'polished', installedVersion: 2 });
  }, 120_000);

  it('base_drift: the installed .nbt no longer equals its source: the polish ends before any model call', async () => {
    h = await harness();
    const e = await entry(h, 'sim:issues=P1@roof');
    // tamper the installed template (another building's cells)
    fs.copyFileSync(path.join(KIT, 'examples', 'cabin', 'cabin.nbt'), path.join(h.sc.config.libraryDir, e, `${e}.nbt`));
    const jobsBefore = h.sc.jobs.book.recent().length;
    const d = await polish(h, e);
    expect(d.polish).toMatchObject({ end: 'base_drift', installedVersion: null, steps: [] });
    expect(d.step).toMatch(/differs from the installed one in \d+ cells/);
    expect(h.sc.jobs.book.recent().length).toBe(jobsBefore);
  }, 120_000);

  it('caps: a step that does not fit ends budget (the accepted chain still installs); time; critic_failed', async () => {
    h = await harness();
    const a = await entry(h, 'sim:issues=P1@roof,P1@taproom', 'Budget Inn');
    // the report $0.01, a step $0.1 + its critic $0.01: $0.15 fits one step, not two
    const pa = (await polish(h, a, { budgetUsd: 0.15 })).polish!;
    expect(pa).toMatchObject({ end: 'budget', installedVersion: 2 });
    expect(pa.steps.length).toBe(1);
    const b = await entry(h, 'sim:issues=P1@roof', 'Poor Inn');
    expect((await polish(h, b, { budgetUsd: 0.05 })).polish).toMatchObject({ end: 'budget', installedVersion: null, steps: [] });
    const c = await entry(h, 'sim:issues=P1@roof', 'Slow Inn');
    expect((await polish(h, c, { maxMinutes: 0.0001 })).polish).toMatchObject({ end: 'time', installedVersion: null });
    const f = await entry(h, 'sim:issues=P1@roof sim:polish=erF', 'Mute Inn');
    expect((await polish(h, f)).polish).toMatchObject({ end: 'critic_failed', installedVersion: null });
  }, 120_000);

  it('a usage limit during a step holds it; it resumes after the reset and finishes', async () => {
    h = await harness();
    const e = await entry(h, 'sim:issues=P1@roof sim:polish=erL');
    const d = h.sc.polishes.request(e, { maxSteps: 1 });
    await until(() => !!h!.sc.store.data.limit, 30_000);
    expect(get(h, d.id).step).toMatch(/usage limit/);
    await final(h, d.id);
    expect(get(h, d.id).polish).toMatchObject({ end: 'polished', installedVersion: 2 });
  }, 120_000);

  it('a restart mid-step: the step runs again after the restart and the polish installs once', async () => {
    const root = tempDir('arch-5b-restart-');
    h = await harness({}, root, 10);
    const e = await entry(h, 'sim:issues=P1@roof');
    await h.close(true);
    h = await harness({}, root, 1500);
    const d = h.sc.polishes.request(e, { maxSteps: 1 });
    await until(() => /step 1/.test(get(h!, d.id).step), 60_000);
    await h.close(true);
    h = await harness({}, root, 10);
    await final(h, d.id);
    expect(get(h, d.id).polish).toMatchObject({ end: 'polished', installedVersion: 2 });
    expect(top(h, e).version).toBe(2);
    expect(fs.readdirSync(path.join(h.sc.config.libraryDir, e, 'versions')).sort()).toEqual(['1', '2']);
  }, 180_000);

  it('targets: explicit issues in the order given; notes route through the scoping call (a whole-look request is declined)', async () => {
    h = await harness();
    const e = await entry(h, 'sim:issues=P1@roof,P2@taproom');
    const p = (await polish(h, e, { maxSteps: 1, target: { issues: [1] } })).polish!;
    expect(p.steps[0]!.target).toMatchObject({ part: 'taproom', priority: 'P2' });
    const n = (await polish(h, e, { maxSteps: 2, target: { notes: 'make the roof less cluttered' } })).polish!;
    expect(n.scoping).toMatchObject({ parts: ['roof'], fits: true, suggest: 'polish' });
    expect(n.steps.length).toBe(1);
    expect(n.steps[0]).toMatchObject({ allowedParts: ['roof'], accepted: true });
    const w = (await polish(h, e, { target: { notes: 'change the whole look to a desert style' } })).polish!;
    expect(w).toMatchObject({ end: 'no_target', installedVersion: null, steps: [] });
    expect(w.scoping).toMatchObject({ fits: false, suggest: 'reskin' });
    // notes with parts skip the scoping call
    const q = (await polish(h, e, { maxSteps: 1, target: { notes: 'fewer barrels', parts: ['taproom'] } })).polish!;
    expect(q.scoping).toBeUndefined();
    expect(q.steps[0]!.allowedParts).toEqual(['taproom']);
  }, 180_000);

  it('refusals and the estimate (polish as its own fields); protocol 1 never sees a polish', async () => {
    h = await harness();
    expect(() => h!.sc.polishes.request('cabin', {})).toThrow(/^bundled:/);
    const e = await entry(h, 'sim:issues=P1@roof');
    const out: Outbound[] = [];
    const msg = parseClientMessage({ v: 1, id: 'q', type: 'design.estimate', entryId: e, polish: { maxSteps: 2 } });
    expect(msg.ok).toBe(true);
    await h.sc.handle((msg as unknown as { msg: never }).msg, (m) => out.push(m));
    const est = (out.find((m) => m.type === 'ack') as { result: Record<string, number | string> }).result;
    expect(est).toMatchObject({ usdLow: 0, usdHigh: 0, polishUsdLow: expect.any(Number), polishUsdHigh: expect.any(Number), polishMinutesLow: expect.any(Number), polishMinutesHigh: expect.any(Number) });
    expect(est.polishUsdLow as number).toBeLessThanOrEqual(est.polishUsdHigh as number);
    expect(String(est.basis)).toMatch(/a report first/);
    // the polish request through the protocol
    const out2: Outbound[] = [];
    const pm = parseClientMessage({ v: 1, id: 'p', type: 'design.polish', entryId: e, spec: { maxSteps: 1, apply: { sites: 'all' } } });
    await h.sc.handle((pm as unknown as { msg: never }).msg, (m) => out2.push(m));
    const ack = out2.find((m) => m.type === "ack") as unknown as { ok: boolean; result: { designId: string } };
    expect(ack.ok).toBe(true);
    const id = ack.result.designId;
    expect(get(h, id).polish!.apply).toEqual({ sites: 'all', preview: true });
    await final(h, id);
    for (const m of h.events.filter((x) => x.type === 'design.upsert' && (x as { design: Design }).design.id === id)) expect(toProtocol1({ v: 1, ...m })).toBeUndefined();
    expect((toProtocol1({ v: 1, ...h.sc.snapshot(2) }) as { designs: Design[] }).designs.some((x) => x.id === id)).toBe(false);
    expect(h.sc.snapshot(2)).toMatchObject({ features: expect.arrayContaining(['entry.versions', 'entry.delta', 'design.polish', 'critique.polish']) });
  }, 120_000);

  it('critique.mode "polish" in a new design: round 0 installs with its report, then a polish of the new entry installs v2', async () => {
    h = await harness();
    const d = h.sc.requestDesign(DesignRequest.parse(request({ type: 'tavern', name: 'Mode Inn', notes: 'sim:critique=5 sim:polish=er', maxSize: { x: 64, y: 64, z: 64 }, critique: { mode: 'polish', maxRevisions: 1, budgetUsd: 5 } })));
    await final(h, d.id);
    expect(get(h, d.id)).toMatchObject({ status: 'done' });
    const e = get(h, d.id).blueprintId!;
    await until(() => h!.sc.designs.list().some((x) => x.kind === 'polish' && x.polish?.entryId === e && FINAL.includes(x.status)), 60_000);
    const p = h.sc.designs.list().find((x) => x.kind === 'polish' && x.polish?.entryId === e)!;
    expect(p.polish).toMatchObject({ fromVersion: 1, installedVersion: 2, end: 'polished' });
    // the report's critique.json was reused (fresh), so no second report ran
    expect(p.polish!.report).toBeUndefined();
  }, 120_000);
});
