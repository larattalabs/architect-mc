// (7c CO, docs/CONTRACT.md "Phase 7c" §3 row 12, "Slice CO as built") The standalone composer through the sidecar with the REAL kit
// (../kit, or ARCHITECT_REGION_KIT), on the sim backend: the template pick first (TC's), then the composing round, the mod's check (here
// the kit's own plan check, run as the mod runs it: plan_v0 over the claim's survey, no caller anchors), one repair round with the typed
// answers and the catalogue's long text, and the outcomes PICKED, COMPOSED and NO_PLAN. Images on and off give the same plan bytes.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import type { Design, Outbound } from '../src/protocol.js';
import { FEATURES, JOB_SYSTEM_MAX } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { composeSystem } from '../src/jobs/systemrefs.js';
import {
  bestRound,
  COMPOSE_REFS,
  COMPOSE_ROUNDS,
  callerOptions,
  EXT_HINTS,
  EXT_REPAIRS,
  EXT_SYSTEM,
  CALLER_SYSTEM_MAX,
  composerText,
  composeSystemText,
  composeKeyBody,
  composePrompt,
  keepComposeAffordances,
  partAnswerLine,
  planKinds,
  rankAffordances,
  repairKinds,
  repairPrompt,
  SIM_PLAN,
  waitsOf,
  type ComposeRound,
  type ComposeState,
} from '../src/compose.js';
import { arsv, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
const LANDS = path.join(KIT, 'test', 'fixtures', 'tc');
const TEXT = fs.existsSync(path.join(KIT, 'prompts', 'composer.md')) ? composerText(KIT) : { system: 'x', answer: '## How to answer', repair: 'Answer again.' };
const COMPOSE_SYSTEM = TEXT.system;
const hasCO = fs.existsSync(path.join(KIT, 'tools', 'planimages.mjs')) && fs.existsSync(path.join(LANDS, 'lands.json'));

const lots = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `h${i + 1}`, type: 'house', size: [9, 9] }));
/** A plan whose path names an anchor no compose request has ("stone"): the check answers NEEDS_REPAIR (UNKNOWN_REF). */
const BAD = { schemaVersion: 'plan/0', zones: [{ id: 'town', required: true, program: { lots: lots(3) }, where: { near: { anchor: 'claim_center', within: 8 } } }], connectors: [{ id: 'lane', kind: 'path', from: { anchor: 'stone' }, to: { part: 'town' } }] };
/** The repaired plan: the path from the claim's south edge. */
const GOOD = { ...BAD, connectors: [{ id: 'lane', kind: 'path', from: { anchor: 'claim_s' }, to: { part: 'town' } }] };

describe('the composer\'s pure parts (7c CO)', () => {
  const claim = { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 };
  const aff = keepComposeAffordances([
    { id: 'cave_b', kind: 'cave', box: { minX: 10, minY: 50, minZ: 10, maxX: 40, maxY: 60, maxZ: 20 }, metrics: { floorArea: 500, ceiling: 8 }, score: 0.9 },
    { id: 'pad_a', kind: 'pad', box: { minX: 0, minY: 64, minZ: 0, maxX: 7, maxY: 64, maxZ: 7 }, metrics: { size: 8 }, score: 0.5 },
    { id: 'pad_0', kind: 'pad', box: { minX: 8, minY: 64, minZ: 0, maxX: 15, maxY: 64, maxZ: 7 }, metrics: { size: 8 }, score: 0.5 },
    { id: 'nobox', kind: 'pad', score: 1 },
  ]);

  it('keeps affordances with a box, ranks them as the kit does (score, then id) and numbers them in the prompt', async () => {
    expect(aff.map((a) => a.id)).toEqual(['cave_b', 'pad_a', 'pad_0']);
    expect(rankAffordances(aff).map((a) => a.id)).toEqual(['cave_b', 'pad_0', 'pad_a']);
    if (hasCO) {
      const kit = (await import(pathToFileURL(path.join(KIT, 'lib', 'region', 'planImages.mjs')).href)) as { rankAffordances: (l: unknown[]) => Array<{ id: string }> };
      expect(kit.rankAffordances(aff).map((a) => a.id)).toEqual(rankAffordances(aff).map((a) => a.id));
    }
    const p = composePrompt({ brief: 'a few homes beside a winding lane', claim, summary: 'flat', roles: ['rock'], affordances: aff, images: ['top', 'section-1', 'section-2', 'iso'], answer: TEXT.answer });
    expect(p).toContain('brief: a few homes beside a winding lane');
    expect(p).toContain('1. cave cave_b: x 10..40 y 50..60 z 10..20 (floorArea 500, ceiling 8)');
    expect(p).toContain('2. pad pad_0');
    expect(p).toContain('4 images come before this text: top, section-1, section-2, iso');
    expect(p).toContain('claim_center, claim_n, claim_e, claim_s, claim_w');
    const off = composePrompt({ brief: 'a few homes beside a winding lane', claim, summary: 'flat', roles: ['rock'], affordances: aff, images: [], answer: TEXT.answer });
    expect(off).not.toContain('Planning images');
    expect(composePrompt({ brief: 'x', claim, summary: '', roles: [], images: [], affordanceNote: 'no volume', answer: TEXT.answer })).toContain('not analysed (no volume)');
  });

  it('builds the repair prompt from the typed answers and the kinds the plan used and the check answered', () => {
    const check = { overall: 'NEEDS_REPAIR', parts: [{ part: 'town', class: 'fits', block: 'zone.standard' }, { part: 'lane', class: 'malformed', block: 'connector.path', reasons: [{ code: 'UNKNOWN_REF', path: '$.from', message: 'anchor "stone" is neither built in' }], wouldFit: { from: { anchor: 'claim_s' } }, blockedBy: ['x'] }, { part: 'isle', class: 'unsupported', block: 'form.crater' }], notes: ['n1'] };
    const r: ComposeRound = { n: 1, jobId: 'j', plan: BAD, check };
    expect(planKinds(BAD)).toEqual(['connector.path', 'zone.standard']);
    expect(planKinds({ zones: [{ id: 'a', program: { template: 'authored' } }, { id: 'b', kind: 'outpost' }], forms: [{ id: 'c', kind: 'crater' }] })).toEqual(['form.crater', 'program.authored', 'zone.outpost', 'zone.standard']);
    expect(repairKinds(BAD, check)).toEqual(['connector.path', 'form.crater', 'zone.standard']);
    const line = partAnswerLine(check.parts[1]!);
    expect(line).toContain('- lane: malformed (connector.path)');
    expect(line).toContain('UNKNOWN_REF at $.from: anchor "stone" is neither built in');
    expect(line).toContain('would fit: {"from":{"anchor":"claim_s"}}');
    expect(line).toContain('blocked by: ["x"]');
    const p = repairPrompt('FIRST', r, '[{"id":"connector.path"}]', TEXT.repair);
    expect(p.startsWith('FIRST\n')).toBe(true);
    expect(p).toContain('## Your plan (round 1)');
    expect(p).toContain(JSON.stringify(BAD));
    expect(p).toContain('overall: NEEDS_REPAIR; 1 of 3 part(s) fit or adjusted');
    expect(p).not.toContain('- town: fits');
    expect(p).toContain('- isle: unsupported (form.crater)');
    expect(p).toContain('[{"id":"connector.path"}]');
    expect(repairPrompt('F', { n: 2, jobId: 'k', plan: {}, refused: 'FIELD_LIMIT: too big' }, '', TEXT.repair)).toContain('the check did not run: FIELD_LIMIT: too big');
  });

  it('picks the best round (READY first, a tie to the later round) and lists what waits with the catalogue\'s until', () => {
    const r1: ComposeRound = { n: 1, jobId: 'a', plan: { a: 1 }, check: { overall: 'NEEDS_REPAIR', parts: [] } };
    const r2: ComposeRound = { n: 2, jobId: 'b', plan: { b: 1 }, check: { overall: 'REQUIRED_BLOCKED', parts: [] } };
    const r3: ComposeRound = { n: 2, jobId: 'c', plan: { c: 1 }, check: { overall: 'NEEDS_REPAIR', parts: [] } };
    const r4: ComposeRound = { n: 2, jobId: 'd', plan: { d: 1 }, refused: 'x' };
    expect(bestRound([r1, r2])?.jobId).toBe('a');
    expect(bestRound([r1, r3])?.jobId).toBe('c');
    expect(bestRound([r1, r4])?.jobId).toBe('a');
    const w = waitsOf({ parts: [{ part: 'a', class: 'fits', block: 'zone.standard' }, { part: 'b', class: 'unsupported', block: 'rule.shape', required: true }, { part: 'c', class: 'blocked', block: 'connector.path' }] }, new Map([['rule.shape', 'RC']]));
    expect(w).toEqual([{ part: 'b', class: 'unsupported', block: 'rule.shape', until: 'RC', required: true }, { part: 'c', class: 'blocked', block: 'connector.path' }]);
  });

  it('keys a request by its body without the blob ids (the volume by its sha)', () => {
    const a = composeKeyBody({ v: 1, id: 'q', type: 'region.compose', brief: 'b', surveyBlobId: 's1', volume: { blobId: 'v1', sha: 'ab' }, images: true, opKey: 'k' });
    const b = composeKeyBody({ v: 1, id: 'r', type: 'region.compose', brief: 'b', surveyBlobId: 's2', volume: { blobId: 'v2', sha: 'ab' }, images: true, opKey: 'k' });
    expect(a).toEqual(b);
    expect(a).toEqual({ type: 'region.compose', brief: 'b', volume: { sha: 'ab' }, images: true });
  });

  it('reads its prompt text from the kit (kit/prompts/composer.md) and the caller\'s ext keys: hints, rules, repair rounds', async () => {
    expect(TEXT.system).toContain('settlement composer');
    expect(TEXT.system).toContain('claim_center, claim_n, claim_e, claim_s, claim_w');
    expect(TEXT.answer).toContain('## How to answer');
    expect([EXT_HINTS, EXT_SYSTEM, EXT_REPAIRS]).toEqual(['architect_mc:composeHints', 'architect_mc:composeSystem', 'architect_mc:repairRounds']); // = ComposeRequest.EXT_* (ApiCOTest)
    expect(callerOptions(undefined)).toEqual({ repairs: 1 });
    expect(callerOptions({ 'architect_mc:composeHints': { zones: [{ id: 'harbour' }] }, 'architect_mc:composeSystem': ' Keep a wall. ', 'architect_mc:repairRounds': 2 })).toEqual({ hints: { zones: [{ id: 'harbour' }] }, system: 'Keep a wall.', repairs: 2 });
    expect(() => callerOptions({ 'architect_mc:repairRounds': 3 })).toThrow(/FIELD_LIMIT.*repairRounds/);
    expect(() => callerOptions({ 'architect_mc:composeHints': [1] })).toThrow(/composeHints/);
    expect(() => callerOptions({ 'architect_mc:composeSystem': 'x'.repeat(CALLER_SYSTEM_MAX + 1) })).toThrow(/composeSystem/);
    const p = composePrompt({ brief: 'b', claim, summary: '', roles: [], images: [], hints: { zones: [{ id: 'harbour' }] }, answer: TEXT.answer });
    expect(p).toContain('## The caller\'s hints');
    expect(p).toContain('{"zones":[{"id":"harbour"}]}');
    expect(composeSystemText(TEXT, 'Keep a wall.')).toBe(`${TEXT.system}\n\n## The caller's rules (they add to the rules above)\n\nKeep a wall.`);
    // the largest caller's rules still keep the whole system under the bound
    const big = await composeSystem(KIT, COMPOSE_REFS, composeSystemText(TEXT, 'r'.repeat(CALLER_SYSTEM_MAX)));
    expect(big.length).toBeLessThan(JOB_SYSTEM_MAX);
  });

  it('keeps the structured job\'s system prompt under the 120,000 bound (plan/0#compact + the composer\'s)', async () => {
    const sys = await composeSystem(KIT, COMPOSE_REFS, COMPOSE_SYSTEM);
    console.log(`7c CO: the composer's system prompt is ${sys.length} characters (COMPOSE_SYSTEM ${COMPOSE_SYSTEM.length}; JOB_SYSTEM_MAX ${JOB_SYSTEM_MAX})`);
    expect(sys.length).toBeLessThan(JOB_SYSTEM_MAX);
    expect(sys.endsWith(COMPOSE_SYSTEM)).toBe(true);
  });
});

describe.skipIf(!hasCO)('the composer with the real kit (7c CO)', () => {
  let root: string;
  let sc: Sidecar;
  let kitCheck: (plan: unknown, o: Record<string, unknown>) => Promise<{ check: Record<string, unknown>; artifactSha?: string }>;
  const lands = hasCO ? (JSON.parse(fs.readFileSync(path.join(LANDS, 'lands.json'), 'utf8')) as { lands: Record<string, { sha: string }> }).lands : {};
  const SIDE = 192;
  const claim = { minX: 0, minZ: 0, maxX: SIDE - 1, maxZ: SIDE - 1, minY: -64, maxY: 319 };
  const survey = arsv(0, 0, SIDE, SIDE, () => 64);

  const ask = async (msg: Record<string, unknown>) => {
    let ack: { ok: boolean; error?: string; result?: Record<string, unknown> } | undefined;
    await sc.handle({ v: 1, id: 'q', ...msg } as never, (m) => {
      if (m.type === 'ack') ack = m as typeof ack;
    });
    return ack!;
  };
  const volume = () => ({ blobId: sc.blobs.putBytes(fs.readFileSync(path.join(LANDS, 'plains.bin')), 'region.volume', 'bin'), sha: lands.plains!.sha });
  const compose = async (brief: string, over: Record<string, unknown> = {}) => {
    const a = await ask({ type: 'region.compose', brief, claim, surveyBlobId: sc.blobs.putBytes(survey, 'survey', 'bin'), volume: volume(), ...over });
    expect(a.ok, a.error).toBe(true);
    return a.result as { designId: string; adopted?: boolean };
  };
  const st = (id: string) => sc.designs.get(id)!.settlement as unknown as ComposeState;
  const final = (id: string) => ['done', 'failed', 'cancelled'].includes(sc.designs.get(id)?.status ?? '');
  /** Plays the mod: waits for a round's plan, checks it with the kit as the mod's checkPlan does, answers region.compose.checked. */
  const playMod = async (id: string): Promise<Design> => {
    for (;;) {
      await until(() => final(id) || st(id).awaiting !== undefined, 600_000);
      if (final(id)) return sc.designs.get(id)!;
      const aw = st(id).awaiting!;
      const r = await kitCheck(aw.plan, { survey, claim, anchors: {} });
      const a = await ask({ type: 'region.compose.checked', designId: id, round: aw.round, check: { checkId: `c${aw.round}`, ...r.check, ...(r.artifactSha ? { artifactSha: r.artifactSha } : {}) } });
      expect(a.ok, a.error).toBe(true);
      await until(() => final(id) || st(id).awaiting === undefined || st(id).awaiting!.round !== aw.round, 60_000);
    }
  };
  const queries = (jobId: string) =>
    fs.readFileSync(path.join(sc.config.dataDir, 'jobs', jobId, 'sim-queries.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { system: string; prompt: string });

  beforeAll(async () => {
    root = tempDir('arch-compose-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    cfg.simStepMs = 10;
    sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    sc.subscribe((_m: Outbound) => undefined);
    await sc.start(new SimDesigner(sc, 5));
    const helpers = (await import(pathToFileURL(path.join(KIT, 'test', 'plan-helpers.mjs')).href)) as { checkPlanLocal: typeof kitCheck };
    kitCheck = helpers.checkPlanLocal;
  });
  afterAll(async () => {
    await sc.regions.idle();
    await sc.close();
    rmrf(root);
  });

  it('advertises region.compose and region.planImages', () => {
    expect(FEATURES).toContain('region.compose');
    expect(FEATURES).toContain('region.planImages');
  });

  it('a brief no template fits: composed, checked NEEDS_REPAIR, repaired once with the typed answers, checked READY: COMPOSED', async () => {
    const { designId } = await compose('a few homes beside a winding lane', { ext: { 'architect:simCompose': [{ plan: BAD, reason: 'r1' }, { plan: GOOD, reason: 'r2' }] } });
    const d = await playMod(designId);
    expect(d.status).toBe('done');
    expect(d.kind).toBe('settlement');
    const s = st(designId);
    expect(s.pick?.outcome).toBe('NO_TEMPLATE');
    expect(sc.designs.get(s.pick!.designId)?.kind).toBe('region');
    expect(s.rounds.map((r) => (r.check as { overall: string }).overall)).toEqual(['NEEDS_REPAIR', 'READY']);
    const res = d.result as Record<string, unknown>;
    expect(res.outcome).toBe('COMPOSED');
    expect(JSON.stringify(res.plan)).toBe(JSON.stringify(GOOD));
    expect(typeof (res.check as { artifactSha?: string }).artifactSha).toBe('string');
    expect(res.rounds).toBe(2);
    expect((res.history as Array<{ overall: string }>).map((h) => h.overall)).toEqual(['NEEDS_REPAIR', 'READY']);
    expect(res.cost).toBeGreaterThan(0);
    // round 1's prompt: the brief, the claim's affordances (the plains: pads), no images; the system: plan/0#compact + the composer's
    const q1 = queries(s.rounds[0]!.jobId)[0]!;
    expect(q1.prompt).toContain('brief: a few homes beside a winding lane');
    expect(q1.prompt).toContain('## Site affordances');
    expect(q1.prompt).not.toContain('## Planning images');
    expect(q1.system.endsWith(COMPOSE_SYSTEM)).toBe(true);
    expect(q1.system).toContain("Architect's plan schema (plan/0), compact");
    // round 2's prompt: round 1's plan, the typed answer (UNKNOWN_REF on lane) and the long text of connector.path and zone.standard
    const q2 = queries(s.rounds[1]!.jobId)[0]!;
    expect(q2.prompt.startsWith(q1.prompt)).toBe(true);
    expect(q2.prompt).toContain(JSON.stringify(BAD));
    expect(q2.prompt).toMatch(/- lane: malformed \(connector\.path\)\n {2}- UNKNOWN_REF/);
    expect(q2.prompt).toContain('"id":"connector.path"');
    expect(q2.prompt).toContain('"id":"zone.standard"');
  }, 600_000);

  it('images on and off give byte-identical plans; on: four planning images go to every round\'s job', async () => {
    const script = { 'architect:simCompose': [{ plan: BAD, reason: 'r1' }, { plan: GOOD, reason: 'r2' }] };
    const on = await compose('a few homes beside a winding lane', { images: true, ext: script });
    const off = await compose('a few homes beside a winding lane', { images: false, ext: script });
    const [don, doff] = [await playMod(on.designId), await playMod(off.designId)];
    expect(JSON.stringify((don.result as { plan: unknown }).plan)).toBe(JSON.stringify((doff.result as { plan: unknown }).plan));
    expect(st(on.designId).rounds.map((r) => JSON.stringify((r as ComposeRound).plan))).toEqual(st(off.designId).rounds.map((r) => JSON.stringify((r as ComposeRound).plan)));
    expect((don.result as { check: { planSha: string } }).check.planSha).toBe((doff.result as { check: { planSha: string } }).check.planSha);
    expect((don.result as { check: { artifactSha: string } }).check.artifactSha).toBe((doff.result as { check: { artifactSha: string } }).check.artifactSha);
    const pi = st(on.designId).planImages!;
    expect(pi.images.map((im) => im.name)).toEqual(['top', 'section-1', 'section-2', 'iso']);
    expect(pi.images.every((im) => !!sc.blobs.get(im.blobId))).toBe(true);
    expect((don.result as { images: unknown[] }).images).toHaveLength(4);
    expect(st(off.designId).planImages).toBeUndefined();
    for (const r of st(on.designId).rounds) expect(sc.jobs.book.work(r.jobId)?.images?.length).toBe(4);
    for (const r of st(off.designId).rounds) expect(sc.jobs.book.work(r.jobId)?.images?.length ?? 0).toBe(0);
    expect(queries(st(on.designId).rounds[0]!.jobId)[0]!.prompt).toContain('4 images come before this text: top, section-1, section-2, iso');
    // the renders are the kit's, byte for byte: the same survey and affordances again give the same pixels
    const again = await sc.regions.planImages(sc.blobs.file(st(on.designId).surveyBlobId), st(on.designId).affordances ?? [], path.join(root, 'again'));
    expect(again.images.map((im) => im.pixelSha)).toEqual(pi.images.map((im) => im.pixelSha));
  }, 600_000);

  it('no round checks READY: NO_PLAN with the best round\'s plan and what waits; one repair round only', async () => {
    const { designId } = await compose('a few homes beside a winding lane', { ext: { 'architect:simCompose': [{ plan: BAD, reason: 'r1' }] } });
    const d = await playMod(designId);
    const res = d.result as Record<string, unknown>;
    expect(d.status).toBe('done');
    expect(res.outcome).toBe('NO_PLAN');
    expect(res.rounds).toBe(COMPOSE_ROUNDS);
    expect(res.round).toBe(2);
    expect(JSON.stringify(res.plan)).toBe(JSON.stringify(BAD));
    expect(res.waits).toEqual([{ part: 'lane', class: 'malformed', block: 'connector.path' }]);
  }, 600_000);

  it('a caller\'s repair rounds (2, then 0), hints and rules reach the rounds', async () => {
    const two = await compose('a few homes beside a winding lane', { ext: { 'architect:simCompose': [{ plan: BAD, reason: 'r1' }], 'architect_mc:repairRounds': 2, 'architect_mc:composeHints': { zones: [{ id: 'town', lots: 3 }] }, 'architect_mc:composeSystem': 'Never build a wall.' } });
    const d2 = await playMod(two.designId);
    expect((d2.result as Record<string, unknown>).outcome).toBe('NO_PLAN');
    expect(st(two.designId).rounds).toHaveLength(3);
    const q = queries(st(two.designId).rounds[0]!.jobId)[0]!;
    expect(q.prompt).toContain('{"zones":[{"id":"town","lots":3}]}');
    expect(q.system.endsWith('## The caller\'s rules (they add to the rules above)\n\nNever build a wall.')).toBe(true);
    const zero = await compose('a few homes beside a winding lane', { ext: { 'architect:simCompose': [{ plan: BAD, reason: 'r1' }], 'architect_mc:repairRounds': 0 } });
    const d0 = await playMod(zero.designId);
    expect((d0.result as Record<string, unknown>).outcome).toBe('NO_PLAN');
    expect(st(zero.designId).rounds).toHaveLength(1);
    const bad = await ask({ type: 'region.compose', brief: 'b', claim, surveyBlobId: sc.blobs.putBytes(survey, 'survey', 'bin'), ext: { 'architect_mc:repairRounds': 5 } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/FIELD_LIMIT/);
  }, 600_000);

  it('the sim stand-in composes a plan that checks READY at once (no repair round)', async () => {
    const { designId } = await compose('a few homes beside a winding lane');
    const d = await playMod(designId);
    expect((d.result as Record<string, unknown>).outcome).toBe('COMPOSED');
    expect(st(designId).rounds).toHaveLength(1);
    expect(JSON.stringify((d.result as { plan: unknown }).plan)).toBe(JSON.stringify(SIM_PLAN));
  }, 600_000);

  it('a refused check is a typed answer for the repair round', async () => {
    const { designId } = await compose('a few homes beside a winding lane', { ext: { 'architect:simCompose': [{ plan: BAD, reason: 'r1' }, { plan: GOOD, reason: 'r2' }] } });
    await until(() => st(designId).awaiting?.round === 1, 600_000);
    const a = await ask({ type: 'region.compose.checked', designId, round: 1, refused: 'FIELD_LIMIT: the plan is too big' });
    expect(a.ok, a.error).toBe(true);
    const bad = await ask({ type: 'region.compose.checked', designId, round: 1, refused: 'again' });
    expect(bad.ok).toBe(false);
    const d = await playMod(designId);
    expect((d.result as Record<string, unknown>).outcome).toBe('COMPOSED');
    expect(queries(st(designId).rounds[1]!.jobId)[0]!.prompt).toContain('the check did not run: FIELD_LIMIT: the plan is too big');
  }, 600_000);

  it('a brief a template fits: PICKED, no round', async () => {
    const { designId } = await compose('a flat village with a well');
    await until(() => final(designId), 600_000);
    const d = sc.designs.get(designId)!;
    const res = d.result as Record<string, unknown>;
    expect(res.outcome).toBe('PICKED');
    expect(res.program).toBe('flat_village');
    expect(res.rounds).toBe(0);
    expect(st(designId).rounds).toHaveLength(0);
  }, 600_000);

  it('opKey: the same key and body adopt the first design; another body (images) conflicts', async () => {
    const a = await compose('a flat village with a well', { opKey: 'co.key.1' });
    const b = await compose('a flat village with a well', { opKey: 'co.key.1' });
    expect(b.designId).toBe(a.designId);
    expect(b.adopted).toBe(true);
    const c = await ask({ type: 'region.compose', brief: 'a flat village with a well', claim, surveyBlobId: sc.blobs.putBytes(survey, 'survey', 'bin'), volume: volume(), images: true, opKey: 'co.key.1' });
    expect(c.ok).toBe(false);
    expect(c.error).toMatch(/op_key_conflict/);
    await until(() => final(a.designId), 600_000);
  }, 600_000);

  it('cancel: the pick or the running round stops with the design', async () => {
    const { designId } = await compose('a few homes beside a winding lane');
    await until(() => st(designId).awaiting?.round === 1, 600_000);
    const a = await ask({ type: 'design.cancel', designId });
    expect(a.ok, a.error).toBe(true);
    expect(sc.designs.get(designId)?.status).toBe('cancelled');
    const late = await ask({ type: 'region.compose.checked', designId, round: 1, refused: 'late' });
    expect(late.ok).toBe(false);
  }, 600_000);
});
