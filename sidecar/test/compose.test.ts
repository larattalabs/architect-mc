// (7c CO, docs/CONTRACT.md "Phase 7c" §3 row 12, "Slice CO as built") The standalone composer through the sidecar with the REAL kit
// (../kit, or ARCHITECT_REGION_KIT), on the sim backend: the template pick first (TC's), then the composing round, the mod's check (here
// the kit's own plan check, run as the mod runs it: plan_v0 over the claim's survey, no caller anchors), one repair round with the typed
// answers and the catalogue's long text, and the outcomes PICKED, COMPOSED and NO_PLAN. Images on and off give the same plan bytes.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import type { Design, Outbound } from '../src/protocol.js';
import { FEATURES, JOB_SYSTEM_MAX } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import {
  bestRound,
  composerSystem,
  COMPOSE_ROUNDS,
  callerOptions,
  EXT_HINTS,
  EXT_REPAIRS,
  EXT_SYSTEM,
  CALLER_SYSTEM_MAX,
  FAMILIES_MAX,
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
  EXT_SKIP_PICK,
  EXT_STREET_FIX,
  EXT_VOCAB,
  partName,
  repairStop,
  streetFixes,
  vocabFamiliesText,
  waitSay,
  waitsSaid,
  type ComposeRound,
  type ComposeState,
} from '../src/compose.js';
import { arsv, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
/** (CB) the worst case: every on-demand kind def requested */
const WORST = { brief: '', all: true };
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
    expect(callerOptions(undefined)).toEqual({ repairs: 1, streetFix: true });
    expect(callerOptions({ 'architect_mc:composeHints': { zones: [{ id: 'harbour' }] }, 'architect_mc:composeSystem': ' Keep a wall. ', 'architect_mc:repairRounds': 2 })).toEqual({ hints: { zones: [{ id: 'harbour' }] }, system: 'Keep a wall.', repairs: 2, streetFix: true });
    expect(() => callerOptions({ 'architect_mc:repairRounds': 3 })).toThrow(/FIELD_LIMIT.*repairRounds/);
    // composeHints.anchors: the caller's named places, validated and kept apart from the other hints
    expect(callerOptions({ 'architect_mc:composeHints': { anchors: { stone: [1, 64, 2], player: [3, 64, 4] }, zones: [] } })).toEqual({ anchors: { player: [3, 64, 4], stone: [1, 64, 2] }, hints: { zones: [] }, repairs: 1, streetFix: true });
    expect(() => callerOptions({ 'architect_mc:composeHints': { anchors: { claim_n: [0, 0, 0] } } })).toThrow(/not built in/);
    expect(() => callerOptions({ 'architect_mc:composeHints': { anchors: { stone: [0, 1.5, 0] } } })).toThrow(/integer blocks/);
    expect(() => callerOptions({ 'architect_mc:composeHints': { anchors: [] } })).toThrow(/anchors is an object/);
    const withA = composePrompt({ brief: 'b', claim, summary: '', roles: [], images: [], anchors: { stone: [1, 64, 2] }, answer: TEXT.answer });
    expect(withA).toContain("the caller's: stone at 1 64 2; none other");
    const withB = composePrompt({ brief: 'b', claim, summary: '', roles: [], images: [], builds: [{ id: 'b_1', kind: 'HOUSE', bounds: [1, 64, 1, 9, 70, 9], entrances: [{ pos: [5, 64, 1], facing: 'north' }] }], answer: TEXT.answer });
    expect(withB).toContain("## The player's own builds in the claim");
    expect(withB).toContain('- b_1 (HOUSE): bounds [1,64,1,9,70,9], doors [{"pos":[5,64,1],"facing":"north"}]');
    expect(() => callerOptions({ 'architect_mc:composeHints': [1] })).toThrow(/composeHints/);
    expect(() => callerOptions({ 'architect_mc:composeSystem': 'x'.repeat(CALLER_SYSTEM_MAX + 1) })).toThrow(/composeSystem/);
    const p = composePrompt({ brief: 'b', claim, summary: '', roles: [], images: [], hints: { zones: [{ id: 'harbour' }] }, answer: TEXT.answer });
    expect(p).toContain('## The caller\'s hints');
    expect(p).toContain('{"zones":[{"id":"harbour"}]}');
    expect(composeSystemText(TEXT, 'Keep a wall.')).toBe(`${TEXT.system}\n\n## The caller's rules (they add to the rules above)\n\nKeep a wall.`);
    // the largest caller's rules still keep the whole system under the bound
    const big = await composerSystem(KIT, TEXT, { callerSystem: 'r'.repeat(CALLER_SYSTEM_MAX), needs: WORST }).then((x) => x.system);
    expect(big.length).toBeLessThan(JOB_SYSTEM_MAX);
  });

  it('(7c CP) the ext keys: skipPick, composeVocab "families" only, streetFix (default on); the families block keeps the system under 120,000 with the largest rules', async () => {
    expect([EXT_SKIP_PICK, EXT_VOCAB, EXT_STREET_FIX]).toEqual(['architect_mc:skipPick', 'architect_mc:composeVocab', 'architect_mc:streetFix']);
    expect(callerOptions({ 'architect_mc:skipPick': true, 'architect_mc:composeVocab': 'families', 'architect_mc:streetFix': false })).toEqual({ repairs: 1, skipPick: true, vocab: 'families', streetFix: false });
    expect(() => callerOptions({ 'architect_mc:composeVocab': 'compact' })).toThrow(/FIELD_LIMIT: ext\["architect_mc:composeVocab"\] is "families"/);
    expect(() => callerOptions({ 'architect_mc:streetFix': 1 })).toThrow(/FIELD_LIMIT: ext\["architect_mc:streetFix"\] is a boolean/);
    const fam = vocabFamiliesText(KIT);
    expect(fam.startsWith('## Block families (vocab/1)\n')).toBe(true);
    expect(fam).toMatch(/families: .*\boak\b.*\bspruce\b/);
    expect(fam).toContain('group wood: ');
    expect(fam).toContain('dyed (members are colour-prefixed): ');
    expect(fam).toContain('rule.palette {family, share}');
    expect(fam.length).toBeLessThanOrEqual(FAMILIES_MAX);
    const sysText = composeSystemText(TEXT, 'Keep a wall.', fam);
    expect(sysText).toBe(`${TEXT.system}\n\n${fam}\n\n## The caller's rules (they add to the rules above)\n\nKeep a wall.`);
    expect(composeSystemText(TEXT, 'Keep a wall.')).toBe(`${TEXT.system}\n\n## The caller's rules (they add to the rules above)\n\nKeep a wall.`);
    const big = await composerSystem(KIT, TEXT, { callerSystem: 'r'.repeat(CALLER_SYSTEM_MAX - FAMILIES_MAX), families: fam, needs: WORST }).then((x) => x.system);
    // the families count against the caller's rules: 28,000 with them, 30,000 without
    expect(callerOptions({ 'architect_mc:composeSystem': 'r'.repeat(CALLER_SYSTEM_MAX - FAMILIES_MAX), 'architect_mc:composeVocab': 'families' }).vocab).toBe('families');
    expect(() => callerOptions({ 'architect_mc:composeSystem': 'r'.repeat(CALLER_SYSTEM_MAX - FAMILIES_MAX + 1), 'architect_mc:composeVocab': 'families' })).toThrow(/FIELD_LIMIT: ext\["architect_mc:composeSystem"\] is 28001 characters \(at most 28000 with ext\["architect_mc:composeVocab"\] "families"\)/);
    expect(callerOptions({ 'architect_mc:composeSystem': 'r'.repeat(CALLER_SYSTEM_MAX) }).system?.length).toBe(CALLER_SYSTEM_MAX);
    console.log(`7c CP: the composer's system with the families and the largest rules is ${big.length} characters (families ${fam.length})`);
    expect(big.length).toBeLessThan(JOB_SYSTEM_MAX);
  });

  it('(7c CP) the street fix (Steward\'s streetFixes): one NO_ROOM alt street wouldFit applied, its dropped lots in words; anything else is no fix', () => {
    const plan = { schemaVersion: 'plan/0', zones: [{ id: 'town', label: 'the town', program: { layout: 'grid', lots: [{ id: 'townhouse_4' }, { id: 'h1' }] } }, { id: 'farm' }] };
    const street = (over: Record<string, unknown> = {}) => ({ part: 'town', class: 'refused', reasons: [{ code: 'NO_ROOM', message: 'no grid layout fits', evidence: { layout: 'grid', alt: 'street', altDropped: ['townhouse_4'] } }], wouldFit: [{ part: 'town', fragment: { program: { layout: 'street', lots: [{ id: 'h1' }] } } }], ...over });
    const f = streetFixes(plan, { parts: [street(), { part: 'farm', class: 'fits' }] })!;
    expect(f.parts).toEqual(['town']);
    expect(f.leftOut).toEqual(['townhouse 4']);
    expect((f.plan.zones as Array<Record<string, unknown>>)[0]).toEqual({ id: 'town', label: 'the town', program: { layout: 'street', lots: [{ id: 'h1' }] } });
    expect((plan.zones[0]!.program as { layout: string }).layout).toBe('grid'); // a copy
    expect(streetFixes(plan, { parts: [street({ class: 'adjusted' })] })).toBeUndefined();
    expect(streetFixes(plan, { parts: [street({ wouldFit: [] })] })).toBeUndefined();
    expect(streetFixes(plan, { parts: [street({ wouldFit: [{ fragment: {} }, { fragment: {} }] })] })).toBeUndefined();
    expect(streetFixes(plan, { parts: [street({ reasons: [{ code: 'NO_ROOM', evidence: { layout: 'grid' } }] })] })).toBeUndefined();
    expect(streetFixes(plan, { parts: [street({ part: 'nowhere', wouldFit: [{ fragment: { program: {} } }] })] })).toBeUndefined();
    // idempotent: the fixed plan's own check carries no alt street, so a second pass (Steward's, after compose) changes nothing
    expect(streetFixes(f.plan, { parts: [{ part: 'town', class: 'fits' }, { part: 'farm', class: 'fits' }] })).toBeUndefined();
  });

  it('(7c CP) waits in player words (say) and part names; a free round is never an oscillation of the round it fixed', () => {
    const plan = { zones: [{ id: 'town', label: 'Market Square', program: { lots: [{ id: 'cottage_home_2' }] } }], forms: [{ id: 'hidden_room_1', kind: 'hidden_room' }] };
    expect(partName(plan, 'town')).toBe('Market Square');
    expect(partName(plan, 'cottage_home_2')).toBe('cottage home 2');
    expect(waitSay(plan, { part: 'hidden_room_1', class: 'unsupported', until: '8b' })).toBe('hidden room 1 waits for 8b');
    expect(waitSay(plan, { part: 'hidden_room_1', class: 'unsupported' })).toBe('hidden room 1 waits for a later Architect release');
    expect(waitSay(plan, { part: 'cottage_home_2', class: 'blocked' }, ['town'])).toBe('cottage home 2 waits for Market Square');
    expect(waitSay(plan, { part: 'town', class: 'refused' })).toBe("Market Square didn't fit here");
    expect(waitSay(plan, { part: 'town', class: 'malformed' })).toBe("Market Square couldn't be read");
    expect(waitSay(plan, { part: 'town', class: 'incomplete' })).toBe("Market Square couldn't be checked yet");
    expect(waitsSaid(plan, { parts: [{ part: 'town', class: 'fits' }, { part: 'hidden_room_1', class: 'unsupported', block: 'form.hidden_room', required: true }] }, new Map([['form.hidden_room', '8b']])))
      .toEqual([{ part: 'hidden_room_1', class: 'unsupported', block: 'form.hidden_room', until: '8b', required: true, say: 'hidden room 1 waits for 8b' }]);
    const ref = { overall: 'NEEDS_REPAIR', parts: [{ part: 'town', class: 'refused', reasons: [{ code: 'NO_ROOM' }] }] };
    const paid: ComposeRound = { n: 1, jobId: 'a', plan: {}, check: ref };
    const free: ComposeRound = { n: 2, jobId: '', answer: {}, free: 'street', plan: {}, check: ref };
    expect(repairStop([paid, free])).toBeUndefined();
    expect(repairStop([paid, free, { n: 3, jobId: 'b', plan: {}, check: ref }])).toBe('oscillation');
  });

  it('keeps the structured job\'s system prompt under the 120,000 bound (plan/0#compact + the composer\'s)', async () => {
    const sys = await composerSystem(KIT, TEXT, { needs: WORST }).then((x) => x.system);
    console.log(`7c CO: the composer's system prompt is ${sys.length} characters (COMPOSE_SYSTEM ${COMPOSE_SYSTEM.length}; JOB_SYSTEM_MAX ${JOB_SYSTEM_MAX})`);
    expect(sys.length).toBeLessThan(JOB_SYSTEM_MAX);
    // (CB) the core first, then the composer's text, then the kinds
    expect(sys.startsWith("## Architect's plan schema (plan/0), compact")).toBe(true);
    expect(sys).toContain(`\n\n${COMPOSE_SYSTEM}\n\n## Kind schemas for this request`);
    // (CW2) the reason is the player's summary (player words, not the plan's workings); a wall round a zone leaves `closed` unwritten
    expect(TEXT.answer).toMatch(/reason: one or two sentences the player reads: what they get, as they will see it\. Never the plan's workings/);
    expect(TEXT.system).toContain('or leave `closed` unwritten, as for any wall round a zone; `closed: false` only for an edge zone open to the rest of the town.');
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
    expect(sc.designs.get(s.pick!.designId!)?.kind).toBe('region');
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
    // (CB) the job's system is composerSystem's, byte for byte (no systemRefs): the core, the composer's, the fields-only kinds
    expect(q1.system).toBe((await composerSystem(KIT, TEXT, { needs: { brief: 'a few homes beside a winding lane', affordances: rankAffordances(s.affordances ?? []) } })).system);
    expect(q1.system).toContain(`\n\n${COMPOSE_SYSTEM}\n\n`);
    expect(q1.system).toContain('## Other kinds, fields only');
    expect(s.kindsShown).toBeDefined();
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
    expect(res.waits).toEqual([{ part: 'lane', class: 'malformed', block: 'connector.path', say: "lane couldn't be read" }]);
    // (7c CP) the best round's own words, NO_PLAN's diagnostic reason unchanged
    expect(res.summary).toBe('r1');
    expect(res.reason).toMatch(/^no round's plan checked READY; the best is round 2/);
    expect(res.leftOut).toEqual([]);
  }, 600_000);

  it('(CF2) a required zone short of its lots (LOTS_SHORT) checks NEEDS_REPAIR and the repair round runs with its reason; fewer lots check READY', async () => {
    const halls = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `hall_${i + 1}`, type: 'hall', size: [17, 15] }));
    const SHORT = { schemaVersion: 'plan/0', zones: [{ id: 'town', required: true, size: { preset: 'M' }, program: { lots: halls(8), layout: 'street', shared: 'none' } }] };
    const FEWER = { ...SHORT, zones: [{ ...SHORT.zones[0]!, program: { ...SHORT.zones[0]!.program, lots: halls(4) } }] };
    const { designId } = await compose('a hall quarter', { ext: { 'architect:simCompose': [{ plan: SHORT, reason: 'r1' }, { plan: FEWER, reason: 'r2' }] } });
    const d = await playMod(designId);
    const s = st(designId);
    expect(s.rounds.map((r) => (r.check as { overall: string }).overall)).toEqual(['NEEDS_REPAIR', 'READY']);
    const town = ((s.rounds[0]!.check as { parts: Array<Record<string, unknown>> }).parts).find((p) => p.part === 'town')!;
    expect(town.class).toBe('adjusted');
    expect((d.result as Record<string, unknown>).outcome).toBe('COMPOSED');
    const q2 = queries(s.rounds[1]!.jobId)[0]!;
    expect(q2.prompt).toMatch(/- town: adjusted \(zone\.standard\), required\n {2}- LOTS_SHORT: 4 of the zone's 8 lots did not fit/);
  }, 600_000);

  it('a caller\'s repair rounds (2, then 0), hints and rules reach the rounds', async () => {
    const two = await compose('a few homes beside a winding lane', { ext: { 'architect:simCompose': [{ plan: BAD, reason: 'r1' }], 'architect_mc:repairRounds': 2, 'architect_mc:composeHints': { zones: [{ id: 'town', lots: 3 }] }, 'architect_mc:composeSystem': 'Never build a wall.' } });
    const d2 = await playMod(two.designId);
    expect((d2.result as Record<string, unknown>).outcome).toBe('NO_PLAN');
    // ((7c AU) the oscillation stop: round 2's answers repeat round 1's (the same scripted plan), so no third round is paid for)
    expect(st(two.designId).rounds).toHaveLength(2);
    expect((d2.result as Record<string, unknown>).stopped).toBe('oscillation');
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

  it('the caller\'s anchors (composeHints.anchors) are in the record the mod checks with: a plan naming "stone" checks READY', async () => {
    const { designId } = await compose('a few homes beside a winding lane', { ext: { 'architect:simCompose': [{ plan: BAD, reason: 'r1' }], 'architect_mc:composeHints': { anchors: { stone: [96, 64, 180] } } } });
    await until(() => st(designId).awaiting?.round === 1, 600_000);
    expect(st(designId).anchors).toEqual({ stone: [96, 64, 180] });
    // the mod checks with the record's anchors (Composes.checkRequest); here the kit's check with the same
    const aw = st(designId).awaiting!;
    const r = await kitCheck(aw.plan, { survey, claim, anchors: st(designId).anchors });
    expect(r.check.overall).toBe('READY');
    await ask({ type: 'region.compose.checked', designId, round: 1, check: { checkId: 'c1', ...r.check, artifactSha: r.artifactSha } });
    await until(() => final(designId), 60_000);
    expect((sc.designs.get(designId)!.result as Record<string, unknown>).outcome).toBe('COMPOSED');
    expect(queries(st(designId).rounds[0]!.jobId)[0]!.prompt).toContain("the caller's: stone at 96 64 180");
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

  it('(7c CP) skipPick: a brief a template fits composes from plan/0\'s parts with no pick at all (no region.design asked); without it, PICKED', async () => {
    const spy = vi.spyOn(sc.regionDesigns, 'request');
    const regions0 = sc.designs.list().filter((d) => d.kind === 'region').length;
    const { designId } = await compose('a flat village with a well', { ext: { 'architect_mc:skipPick': true } });
    const d = await playMod(designId);
    expect(spy).not.toHaveBeenCalled();
    expect(sc.designs.list().filter((d) => d.kind === 'region').length).toBe(regions0);
    const res = d.result as Record<string, unknown>;
    expect(res.outcome).toBe('COMPOSED');
    expect(res.pick).toEqual({ outcome: 'SKIPPED', program: null, fits: false });
    expect(st(designId).pick).toEqual({ outcome: 'SKIPPED', program: null, fits: false });
    const q1 = queries(st(designId).rounds[0]!.jobId)[0]!;
    expect(q1.prompt).toContain('## The template pick\nthe caller asked for no template pick, so compose the settlement from plan/0\'s parts.');
    // without the key: the pick first, PICKED (today's default)
    const { designId: d2 } = await compose('a flat village with a well', { ext: { 'architect_mc:skipPick': false } });
    await until(() => final(d2), 600_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((sc.designs.get(d2)!.result as Record<string, unknown>).outcome).toBe('PICKED');
    spy.mockRestore();
    const bad = await ask({ type: 'region.compose', brief: 'b', claim, surveyBlobId: sc.blobs.putBytes(survey, 'survey', 'bin'), ext: { 'architect_mc:skipPick': 'yes' } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/FIELD_LIMIT: ext\["architect_mc:skipPick"\] is a boolean/);
  }, 600_000);

  it('(7c CP) owner and dimension: the owner kept in the record and the design; another level than the Overworld ends NO_PLAN at once, $0', async () => {
    const spy = vi.spyOn(sc.regionDesigns, 'request');
    const { designId: nether } = await compose('a flat village with a well', { owner: 'steward:s1', dimension: 'minecraft:the_nether' });
    await until(() => final(nether), 600_000);
    const n = sc.designs.get(nether)!;
    expect(n.status).toBe('done');
    expect(st(nether).dimension).toBe('minecraft:the_nether');
    expect(n.request.owner).toBe('steward:s1');
    expect(n.result).toMatchObject({ outcome: 'NO_PLAN', refused: 'NOT_ALLOWED: regions are Overworld only in this version', summary: 'regions can only be built in the Overworld for now', rounds: 0, waits: [] });
    expect(st(nether).rounds).toEqual([]); // no round
    expect(spy).not.toHaveBeenCalled(); // no pick
    spy.mockRestore();
    const { designId } = await compose('a flat village with a well', { owner: 'steward:s1', dimension: 'minecraft:overworld', ext: { 'architect_mc:skipPick': true } });
    await until(() => st(designId).awaiting !== undefined || final(designId), 600_000);
    expect(st(designId).owner).toBe('steward:s1');
    expect(sc.designs.get(designId)!.request.owner).toBe('steward:s1');
    expect(st(designId).awaiting).toBeDefined();
    await ask({ type: 'design.cancel', designId });
    const { designId: plain } = await compose('a flat village with a well', { ext: { 'architect_mc:skipPick': true } });
    await until(() => st(plain).awaiting !== undefined || final(plain), 600_000);
    expect(st(plain).dimension).toBeUndefined();
    expect(st(plain).owner).toBeUndefined();
    await ask({ type: 'design.cancel', designId: plain });
  }, 600_000);

  it('(7c CP) the $0 street round: a grid zone refused NO_ROOM with a street wouldFit is fixed with no job and checks READY; streetFix false repairs instead', async () => {
    const cottages = Array.from({ length: 3 }, (_, i) => ({ id: `cottage_${i + 1}`, type: 'cottage', size: [13, 14] }));
    const GRID = { schemaVersion: 'plan/0', zones: [{ id: 'town', required: true, size: { w: 30, d: 90 }, program: { layout: 'grid', lots: cottages } }] };
    const script = { 'architect:simCompose': [{ plan: GRID, reason: 'three cottages in a grid' }] };
    const { designId } = await compose('three cottages', { ext: { ...script, 'architect_mc:skipPick': true } });
    const d = await playMod(designId);
    const res = d.result as Record<string, unknown>;
    const rs = st(designId).rounds as ComposeRound[];
    expect(rs.map((r) => [r.free ?? 'paid', r.refused ?? (r.check as { overall: string }).overall])).toEqual([['paid', expect.stringMatching(/NEEDS_REPAIR|REQUIRED_BLOCKED/)], ['street', 'READY']]);
    expect(rs[1]!.jobId).toBe('');
    expect(rs[1]!.cost).toBeUndefined();
    expect(sc.jobs.book.get('')).toBeUndefined();
    expect(res.outcome).toBe('COMPOSED');
    expect(((res.plan as typeof GRID).zones[0]!.program as { layout: string }).layout).toBe('street');
    expect((res.history as Array<Record<string, unknown>>)[1]).toMatchObject({ round: 2, free: 'street', overall: 'READY' });
    expect(res.summary).toBe('three cottages in a grid');
    expect(res.leftOut).toEqual([]);
    expect(res.waits).toEqual([]);
    expect(res.cost).toBe(d.cost!.usd);
    expect(d.cost!.usd).toBeCloseTo((rs[0]!.cost?.usd ?? 0), 9);
    // idempotent: Steward's own pass after compose finds nothing more to apply
    expect(streetFixes(res.plan, res.check as Record<string, unknown>)).toBeUndefined();
    // streetFix false: no free round, a paid repair instead (the sim repeats the grid plan)
    const off = await compose('three cottages', { ext: { ...script, 'architect_mc:skipPick': true, 'architect_mc:streetFix': false } });
    const d2 = await playMod(off.designId);
    expect((st(off.designId).rounds as ComposeRound[]).some((r) => r.free)).toBe(false);
    expect(st(off.designId).rounds.length).toBe(2);
    expect((d2.result as Record<string, unknown>).outcome).toBe('NO_PLAN');
  }, 600_000);

  it('(7c CP) composeVocab families: the system carries the block families; a family the model made up is refused by the check and repaired', async () => {
    const rule = (family: string) => ({ id: 'palette_1', kind: 'palette', family, share: [0, 1] });
    const script = { 'architect:simCompose': [{ plan: { ...GOOD, rules: [rule('glitterwood')] }, reason: 'r1' }, { plan: { ...GOOD, rules: [rule('oak')] }, reason: 'r2' }] };
    const { designId } = await compose('a few homes beside a winding lane', { ext: { ...script, 'architect_mc:skipPick': true, 'architect_mc:composeVocab': 'families' } });
    const d = await playMod(designId);
    const rs = st(designId).rounds as ComposeRound[];
    const q1 = queries(rs[0]!.jobId)[0]!;
    expect(q1.system).toContain(vocabFamiliesText(KIT));
    expect(q1.system.indexOf('## Block families (vocab/1)')).toBeGreaterThan(q1.system.indexOf(COMPOSE_SYSTEM.slice(0, 200)));
    const p1 = ((rs[0]!.check as { parts: Array<Record<string, unknown>> }).parts).find((p) => p.part === 'palette_1')!;
    expect(p1.class).toBe('refused');
    expect(queries(rs[1]!.jobId)[0]!.prompt).toMatch(/- palette_1: refused \(rule\.palette\)\n {2}- NO_FEATURE: "glitterwood" is not a vocab\/1 family or group/);
    const res = d.result as Record<string, unknown>;
    expect(res.outcome).toBe('COMPOSED');
    expect(res.summary).toBe('r2');
    // without the key: no families block (today's system)
    const { designId: plain } = await compose('a few homes beside a winding lane', { ext: { 'architect:simCompose': [{ plan: GOOD, reason: 'r' }], 'architect_mc:skipPick': true } });
    await playMod(plain);
    // ((CB) the system now ends with the kinds block: the composer's text, then the fields-only kinds)
    const ps = queries(st(plain).rounds[0]!.jobId)[0]!.system;
    expect(ps).not.toContain('## Block families (vocab/1)');
    expect(ps).toContain(`\n\n${COMPOSE_SYSTEM}\n\n## Other kinds, fields only`);
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
    // (CH) adopted once it ended (another world's, or past the snapshot's last 20): its upsert is sent again, so the mod hears of it
    const seen: string[] = [];
    const off = sc.subscribe((m) => {
      if (m.type === 'design.upsert') seen.push(`${(m as { design: Design }).design.id}:${(m as { design: Design }).design.status}`);
    });
    const d = await compose('a flat village with a well', { opKey: 'co.key.1' });
    expect(d).toEqual({ designId: a.designId, adopted: true });
    off();
    expect(seen).toContain(`${a.designId}:done`);
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
