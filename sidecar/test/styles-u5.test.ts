// Style unification U5 (docs/CONTRACT.md "Style unification U5"):
// - U5a, the hybrid default: a materials-only request (DesignRequest.palette) also gets the Style's shape hints as guidance, and a
//   Style without its own parts never runs bible set mode (no other Style's components, no restraint, no "follow it");
// - U5b, parts for any Style: `bible.parts` drafts a component set for an existing Style as a bible job seeded from it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bibleSection, designBrief, hintsOf, styleHintLines } from '../src/claude/brief.js';
import { partsOf } from '../src/bibles.js';
import { loadConfig, type Config } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { BibleEstimateMsg, BiblePartsMsg, DesignRequest, FEATURES, type Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.resolve(SIDECAR_ROOT, '..', 'kit');

interface H {
  sc: Sidecar;
  events: Outbound[];
  close(): Promise<void>;
}

async function harness(over: Partial<Config> = {}): Promise<H> {
  const root = tempDir('arch-u5-');
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
  cfg.simStepMs = 10;
  Object.assign(cfg, over);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
  const events: Outbound[] = [];
  sc.subscribe((m) => events.push(m));
  await sc.start(new SimDesigner(sc, cfg.simStepMs));
  return { sc, events, close: async () => {
    await sc.close();
    rmrf(root);
  } };
}

const SET_MODE_TEXT = [/Follow it over your own taste/, /Use the components/, /bible\/components\.mjs/, /\*\*Restraint\*\*/];
const brief = (sc: Sidecar, designId: string) => fs.readFileSync(path.join(sc.config.dataDir, 'designs', designId, 'BRIEF.md'), 'utf8');
const done = async (h: H, id: string) => {
  await until(() => ['done', 'failed'].includes(h.sc.designs.get(id)!.status), 60_000);
  const d = h.sc.designs.get(id)!;
  expect(d.status, d.error).toBe('done');
  return d;
};

describe('U5a: the hints as guidance (pure)', () => {
  const hints = hintsOf(
    { name: 'Medieval', blurb: 'Dark oak timber framing with pale daub walls.', roofLanguage: 'steep gables, jettied upper floors', silhouette: 'tall and narrow', proportions: { storey: 4, roofPitch: 1.5, overhang: 1 }, motifs: ['jetties', { name: 'carved brackets' }] },
    { id: 'medieval', version: 1 },
  )!;

  it('hintsOf keeps what the Style has and drops the default proportions', () => {
    expect(hints).toEqual({ id: 'medieval', version: 1, name: 'Medieval', blurb: 'Dark oak timber framing with pale daub walls.', roofLanguage: 'steep gables, jettied upper floors', silhouette: 'tall and narrow', proportions: { roofPitch: 1.5 }, motifs: ['jetties', 'carved brackets'] });
    expect(hintsOf({ name: 'Plain', proportions: { storey: 4 } }, { id: 'oak', version: 1 })).toBeUndefined();
    expect(styleHintLines(undefined)).toEqual([]);
  });

  it('a materials-only brief carries the hints, as guidance, and no component or restraint text', () => {
    const roles = { wall: 'minecraft:white_concrete', roof: 'minecraft:spruce_planks' };
    const req = DesignRequest.parse(request({ palette: { bible: { id: 'medieval', version: 1, roles } } }));
    const b = designBrief(req, 'gen_x', { renderer: false, examples: ['cabin'], styleHints: hints });
    expect(b).toContain("## The Style's look: Medieval (guidance)");
    expect(b).toContain('- description: Dark oak timber framing with pale daub walls.');
    expect(b).toContain('- roofs: lean toward steep gables, jettied upper floors.');
    expect(b).toContain('- proportions: lean toward a roof pitch of about 1.5');
    expect(b).toContain('- silhouette: lean toward tall and narrow.');
    expect(b).toContain('none is required): jetties, carved brackets.');
    expect(b).toContain('the shapes, the layout and the details stay your call');
    for (const re of SET_MODE_TEXT) expect(b).not.toMatch(re);
    expect(b).not.toMatch(/restraint/i);
    expect(b).not.toContain('## The style bible');
    // no hints: no section
    expect(designBrief(req, 'gen_x', { renderer: false, examples: [] })).not.toContain("The Style's look");
  });

  it('a Style without parts named as the bible: its roles and hints, never set mode', () => {
    const b = bibleSection({ id: 'medieval', version: 1, name: 'Medieval', roles: { wall: 'minecraft:white_concrete' }, components: [], hasProse: false, restraint: { heroMotifs: ['x'], accentShareMax: 0.12, detailDensity: 'moderate', windowsPerFacadeMin: 2 }, parts: false, hints }, 'gen_x').join('\n');
    expect(b).toContain('## The Style: Medieval (`medieval` v1)');
    expect(b).toContain('it has no parts of its own');
    expect(b).toContain('lean toward steep gables');
    for (const re of SET_MODE_TEXT) expect(b).not.toMatch(re);
  });

  it('set mode is unchanged for a Style with its own parts (a Claude-made bible)', () => {
    const base = { id: 'bib_x', version: 2, name: 'X', roles: { wall: 'minecraft:stone' }, components: ['window', 'door_surround', 'lantern_post', 'roof_trim', 'chimney', 'bench'], hasProse: true, restraint: { heroMotifs: ['m'], accentShareMax: 0.1, detailDensity: 'sparse', windowsPerFacadeMin: 2 } };
    // `parts` absent (a caller from before U5) and `parts: true` give the same, the 4b/5a text: components, "follow it", restraint
    const before = bibleSection(base, 'gen_x');
    expect(bibleSection({ ...base, parts: true, hints }, 'gen_x')).toEqual(before);
    const t = before.join('\n');
    for (const re of SET_MODE_TEXT) expect(t).toMatch(re);
    expect(t).toContain('`C.bench(...)`');
    expect(t).not.toContain('lean toward');
  });

  it("partsOf: a Style's own parts only", () => {
    const req = ['window', 'door_surround', 'lantern_post', 'roof_trim', 'chimney'];
    expect(partsOf({ components: req, componentsFile: '/kit/bibles/rustic/components.mjs' }, true)).toEqual(req);
    expect(partsOf({ components: [] }, true)).toEqual([]);
    // a hand save lists the kit's required names (the kit normalises it) but drafted none
    expect(partsOf({ origin: 'hand', components: req })).toEqual([]);
    expect(partsOf({ origin: 'hand', components: req, parts: ['window'] })).toEqual(['window']);
    // a bible job's, before U5 (no parts stored) and after
    expect(partsOf({ origin: 'claude', components: req })).toEqual(req);
    expect(partsOf({ components: req })).toEqual(req);
    expect(partsOf({})).toEqual(req);
  });
});

describe('U5a: the sidecar (sim)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('a materials-only design gets its Style hints; no bible files, no restraint', async () => {
    h = await harness();
    const med = h.sc.bibleIndex.get('medieval')!;
    expect(med.parts).toEqual([]);
    expect(med.roofLanguage).toBe('steep gables, jettied upper floors');
    const d = await done(h, h.sc.requestDesign(DesignRequest.parse(request({ name: 'Daub House', palette: { bible: { id: 'medieval', version: 1, roles: med.roles } } }))).id);
    const b = brief(h.sc, d.id);
    expect(b).toContain("## The Style's look: Medieval (guidance)");
    expect(b).toContain('lean toward steep gables, jettied upper floors');
    for (const re of SET_MODE_TEXT) expect(b).not.toMatch(re);
    expect(fs.existsSync(path.join(h.sc.config.dataDir, 'designs', d.id, 'bible'))).toBe(false);
    expect(h.sc.checkPlan(d).extra).not.toContain('--restraint');
    // a preset name gives the built-in's hints too; plain inputs give none
    const p = await done(h, h.sc.requestDesign(DesignRequest.parse(request({ palette: 'japanese' }))).id);
    expect(brief(h.sc, p.id)).toContain('lean toward low hipped roofs with wide eaves');
    const i = await done(h, h.sc.requestDesign(DesignRequest.parse(request({ palette: { wood: 'oak' } }))).id);
    expect(brief(h.sc, i.id)).not.toContain("The Style's look");
  });

  it("a built-in without parts as the bible: the hybrid (no rustic components, no restraint); rustic keeps its own", async () => {
    h = await harness();
    const d = await done(h, h.sc.requestDesign(DesignRequest.parse(request({ name: 'Set Med', bible: 'medieval' }))).id);
    const b = brief(h.sc, d.id);
    expect(b).toContain('## The Style: Medieval');
    for (const re of SET_MODE_TEXT) expect(b).not.toMatch(re);
    const scratch = path.join(h.sc.config.dataDir, 'designs', d.id, 'bible');
    expect(fs.existsSync(path.join(scratch, 'bible.json'))).toBe(true);
    expect(fs.existsSync(path.join(scratch, 'components.mjs'))).toBe(false);
    expect(h.sc.setMode(d)).toBe(false);
    expect(h.sc.checkPlan(d).extra).not.toContain('--restraint');
    expect(fs.existsSync(path.join(h.sc.config.libraryDir, d.blueprintId!, 'bible', 'components.mjs'))).toBe(false);
    // rustic ships its own library in the kit: set mode, as before
    const r = await done(h, h.sc.requestDesign(DesignRequest.parse(request({ name: 'Set Rustic', bible: 'rustic' }))).id);
    expect(brief(h.sc, r.id)).toMatch(/Follow it over your own taste/);
    expect(h.sc.setMode(r)).toBe(true);
    expect(h.sc.bibleIndex.get('rustic')!.parts).toHaveLength(5);
  });

  it('a hand-made Style has no parts and no copied library; a hand edit of a Style with parts keeps them', async () => {
    h = await harness();
    const med = h.sc.bibleIndex.get('medieval')!;
    const s = h.sc.bibleIndex.save({ bible: { name: 'Hand Style', roles: med.roles, basedOn: { id: 'medieval', version: 1 } } });
    expect(s.bible.parts).toEqual([]);
    expect(fs.readdirSync(path.join(h.sc.config.biblesDir, s.id, 'versions', '1')).sort()).toEqual(['bible.json']);
    expect(h.sc.bibleIndex.resolve(s.id).files.components).toBe('');
    // parts added (as an "Add parts" job installs them), then a hand edit: the next version keeps them
    const v2 = path.join(h.sc.config.biblesDir, s.id, 'versions', '2');
    fs.mkdirSync(v2, { recursive: true });
    const j = JSON.parse(fs.readFileSync(path.join(h.sc.config.biblesDir, s.id, 'versions', '1', 'bible.json'), 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(path.join(v2, 'bible.json'), JSON.stringify({ ...j, version: 2, parts: ['window', 'door_surround', 'lantern_post', 'roof_trim', 'chimney'] }));
    fs.copyFileSync(path.join(KIT, 'bibles', 'rustic', 'components.mjs'), path.join(v2, 'components.mjs'));
    expect(h.sc.bibleIndex.get(s.id)!.parts).toHaveLength(5);
    const s3 = h.sc.bibleIndex.save({ id: s.id, bible: { name: 'Hand Style', roles: { ...med.roles, light: 'minecraft:soul_lantern' }, parts: [] } });
    expect(s3.version).toBe(3);
    expect(s3.bible.parts).toHaveLength(5);
    expect(fs.existsSync(path.join(h.sc.config.biblesDir, s.id, 'versions', '3', 'components.mjs'))).toBe(true);
  });

});

/** sha256 of every file under dir, by relative path */
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out[path.relative(dir, f)] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

describe('U5b: "Add parts…" (bible.parts, sim)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });
  const job = async (id: string) => {
    await until(() => ['done', 'failed', 'cancelled'].includes(h!.sc.bibles.get(id)!.status), 60_000);
    const j = h!.sc.bibles.get(id)!;
    expect(j.status, j.error).toBe('done');
    return j;
  };

  it('FEATURES lists bible.parts; the wire takes it and the estimate', () => {
    expect(FEATURES).toContain('bible.parts');
    expect(BiblePartsMsg.safeParse({ v: 1, type: 'bible.parts', id: 'c1', bibleId: 'medieval' }).success).toBe(true);
    expect(BiblePartsMsg.safeParse({ v: 1, type: 'bible.parts', id: 'c1', bibleId: 'Medieval!' }).success).toBe(false);
    expect(BibleEstimateMsg.safeParse({ v: 1, type: 'bible.estimate', id: 'c1', parts: true }).success).toBe(true);
  });

  it('a built-in: its parts go on a hand-made copy based on it; the built-in stays the kit\'s', async () => {
    h = await harness();
    const med = h.sc.bibleIndex.get('medieval')!;
    const acks: Outbound[] = [];
    await h.sc.handle(BiblePartsMsg.parse({ v: 1, type: 'bible.parts', id: 'c1', bibleId: 'medieval' }) as never, (m) => acks.push(m));
    expect(acks[0]).toMatchObject({ type: 'ack', ok: true, result: { bibleId: 'bib_medieval_parts', version: 1, from: { id: 'medieval', version: 1 }, copy: true } });
    const j = await job((acks[0] as unknown as { result: { jobId: string } }).result.jobId);
    expect(j.kind).toBe('request');
    const b = h.sc.bibleIndex.get('bib_medieval_parts')!;
    expect(b).toMatchObject({ name: 'Medieval (parts)', origin: 'hand', basedOn: { id: 'medieval', version: 1 }, roles: med.roles, tags: med.tags, suggestedFeatures: med.suggestedFeatures, blurb: med.blurb, roofLanguage: med.roofLanguage, builtin: false });
    expect(b.parts).toEqual(['window', 'door_surround', 'lantern_post', 'roof_trim', 'chimney']);
    const dir = path.join(h.sc.config.biblesDir, 'bib_medieval_parts', 'versions', '1');
    expect(fs.readdirSync(dir).sort()).toEqual(['bible.json', 'bible.md', 'components.mjs', 'sheet.png']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'bible.json'), 'utf8'))).toMatchObject({ partsOf: { id: 'medieval', version: 1 } });
    // the built-in is unchanged: no parts, and set mode never runs for it
    expect(h.sc.bibleIndex.get('medieval')!.parts).toEqual([]);
    expect(h.sc.bibleIndex.versions('medieval')).toEqual([]);
    // a design with the copy as its bible: set mode with its own parts
    const d = await done(h, h.sc.requestDesign(DesignRequest.parse(request({ name: 'Parts House', bible: 'bib_medieval_parts' }))).id);
    expect(brief(h.sc, d.id)).toMatch(/Follow it over your own taste/);
    expect(h.sc.setMode(d)).toBe(true);
    // the estimate first (sim: labelled), an upper bound
    const est: Outbound[] = [];
    await h.sc.handle(BibleEstimateMsg.parse({ v: 1, type: 'bible.estimate', id: 'e1', parts: true }) as never, (m) => est.push(m));
    expect(JSON.stringify(est[0])).toContain('Add parts: at most a bible job');
  });

  it('the player\'s Style: the next version of the same Style, roles, hints and owner kept; earlier versions untouched', async () => {
    h = await harness();
    const med = h.sc.bibleIndex.get('medieval')!;
    const uuid = '45ec2bed-0a65-3047-9f6e-8e67d21b1b92';
    const s = h.sc.bibleIndex.save({ owner: uuid, bible: { name: 'Pale Town', roles: med.roles, tags: ['pale'], roofLanguage: 'tall gables', basedOn: { id: 'medieval', version: 1 } } });
    const v1 = hashTree(path.join(h.sc.config.biblesDir, s.id, 'versions', '1'));
    // a stale version is refused; another owner too
    expect(() => h!.sc.bibles.parts({ bibleId: s.id, version: 7 })).toThrow(/no longer the latest/);
    expect(() => h!.sc.bibles.parts({ bibleId: s.id, owner: 'othermod:x' })).toThrow(/belongs to/);
    const r = h.sc.bibles.parts({ bibleId: s.id, version: 1 });
    expect(r).toMatchObject({ copy: false, from: { id: s.id, version: 1 } });
    expect(() => h!.sc.bibles.parts({ bibleId: s.id })).toThrow(/being made or revised/);
    await job(r.job.id);
    const b = h.sc.bibleIndex.get(s.id)!;
    expect(b).toMatchObject({ version: 2, name: 'Pale Town', owner: uuid, origin: 'hand', tags: ['pale'], roofLanguage: 'tall gables', basedOn: { id: 'medieval', version: 1 }, roles: med.roles });
    expect(b.parts).toHaveLength(5);
    expect(hashTree(path.join(h.sc.config.biblesDir, s.id, 'versions', '1'))).toEqual(v1);
    expect(h.sc.bibleIndex.get(s.id, 1)!.parts).toEqual([]);
  });

  it("a mod's Style: only its owner adds parts", async () => {
    h = await harness();
    const med = h.sc.bibleIndex.get('medieval')!;
    const st = h.sc.bibleIndex.save({ owner: 'steward_mc:settlement/abc', bible: { name: 'Frostholm', roles: med.roles } });
    expect(() => h!.sc.bibles.parts({ bibleId: st.id })).toThrow(/belongs to steward_mc:settlement\/abc/);
    const r = h.sc.bibles.parts({ bibleId: st.id, owner: 'steward_mc:settlement/abc' });
    const j = await job(r.job.id);
    expect(j.version).toBe(2);
    expect(h.sc.bibleIndex.get(st.id)).toMatchObject({ owner: 'steward_mc:settlement/abc', version: 2 });
  });
});
