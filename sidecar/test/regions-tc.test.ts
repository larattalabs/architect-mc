// (7c TC, docs/CONTRACT.md "Phase 7c" §3 row 7, "Slice TC as built") The template catalogue through the sidecar with the REAL kit
// (../kit, or ARCHITECT_REGION_KIT): the scenario programs listed with their land needs; the claim's frozen volume (region.design's
// `volume`) analysed by the kit once per design and summarised in the pick's prompt; a fit over land without a template's needs refused
// (one retry, then NO_TEMPLATE offering that template as the closest). On the sim backend the pick is the sim's stand-in (`simPick`,
// keywords): these runs show the listing, the land check and the outcomes, not a model's pick accuracy.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import type { Design, Outbound } from '../src/protocol.js';
import { FEATURES } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import {
  AFFORDANCE_KINDS,
  affordanceNeeds,
  affordanceSummary,
  describeProgram,
  keepAffordances,
  missingLand,
  pickPrompt,
  simPick,
  validatePick,
  type CatalogueProgram,
  type PickAffordance,
} from '../src/regiondesign.js';
import { arsv, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
const LANDS = path.join(KIT, 'test', 'fixtures', 'tc');
const hasTC = fs.existsSync(path.join(LANDS, 'lands.json')) && fs.existsSync(path.join(KIT, 'tools', 'affordances.mjs'));
const ROOT = path.join(KIT, '..');
const brief = (f: string) => (JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', `${f}.json`), 'utf8')) as { brief: string }).brief;

/** Each scenario: its file, program, land fixture and claim side (S1's program takes 200-320, the others hold 192). */
const SCENARIOS = [
  { f: 's1_floating_islands', program: 'floating_islands', land: 'plains', side: 256 },
  { f: 's2_ice_spikes', program: 'ice_outpost', land: 'plains', side: 192 },
  { f: 's3_monastery', program: 'terraced_monastery', land: 's6_hill', side: 192 },
  { f: 's5_treehouses', program: 's5_treehouses', land: 's5_grove', side: 192 },
  { f: 's6_cave_city', program: 's6_cave_city', land: 's6_cavern', side: 192 },
  { f: 's7_flat_village', program: 'flat_village', land: 'plains', side: 192 },
] as const;

describe.skipIf(!hasTC)('the template catalogue with the real kit (7c TC)', () => {
  let root: string;
  let sc: Sidecar;
  let programs: CatalogueProgram[];
  const lands = hasTC ? (JSON.parse(fs.readFileSync(path.join(LANDS, 'lands.json'), 'utf8')) as { lands: Record<string, { sha: string; kinds: Record<string, number> }> }).lands : {};

  const ask = async (msg: Record<string, unknown>) => {
    let ack: { ok: boolean; error?: string; result?: Record<string, unknown> } | undefined;
    await sc.handle({ v: 1, id: 'q', ...msg } as never, (m) => {
      if (m.type === 'ack') ack = m as typeof ack;
    });
    return ack!;
  };
  const claimOf = (side: number) => ({ minX: 0, minZ: 0, maxX: side - 1, maxZ: side - 1, minY: -64, maxY: 319 });
  const volume = (name: string) => ({ blobId: sc.blobs.putBytes(fs.readFileSync(path.join(LANDS, `${name}.bin`)), 'region.volume', 'bin'), sha: lands[name]!.sha });
  const design = async (b: string, side: number, land: string | null, over: Record<string, unknown> = {}): Promise<Design> => {
    const a = await ask({ type: 'region.design', brief: b, claim: claimOf(side), surveyBlobId: sc.blobs.putBytes(arsv(0, 0, side, side, () => 64), 'survey', 'bin'), plan: false, ...(land ? { volume: volume(land) } : {}), ...over });
    expect(a.ok, a.error).toBe(true);
    const id = a.result!.designId as string;
    await until(() => ['done', 'failed', 'cancelled'].includes(sc.designs.get(id)?.status ?? ''), 600_000);
    return sc.designs.get(id)!;
  };
  const tries = (d: Design) => (d.region as { tries: Array<{ jobId: string; errors?: string[] }> }).tries;

  beforeAll(async () => {
    root = tempDir('arch-region-tc-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    cfg.simStepMs = 10;
    sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    sc.subscribe((_m: Outbound) => undefined);
    await sc.start(new SimDesigner(sc, 5));
    programs = await sc.regions.catalogue();
  });
  afterAll(async () => {
    await sc.regions.idle();
    await sc.close();
    rmrf(root);
  });

  it('advertises region.templates; AF kinds equal the kit\'s; the catalogue lists the scenario programs with their land needs', async () => {
    expect(FEATURES).toContain('region.templates');
    const kit = (await import(pathToFileURL(path.join(KIT, 'lib', 'region', 'affordances.mjs')).href)) as { AFFORDANCE_KINDS: string[] };
    expect([...AFFORDANCE_KINDS]).toEqual([...kit.AFFORDANCE_KINDS]);
    const ids = programs.map((p) => p.id);
    for (const s of SCENARIOS) expect(ids).toContain(s.program);
    const by = Object.fromEntries(programs.map((p) => [p.id, p]));
    expect(affordanceNeeds(by.s5_treehouses!)).toEqual([{ kind: 'trunk', count: 6, min: { height: 24 } }]);
    expect(affordanceNeeds(by.s6_cave_city!)).toEqual([{ kind: 'cave', count: 1, min: { floorArea: 400, ceiling: 6 } }]);
    expect(programs.filter((p) => affordanceNeeds(p).length).map((p) => p.id)).toEqual(['s5_treehouses', 's6_cave_city']);
    // the prompt's catalogue: the land needs on their own line, the other needs as before; enum options shown (6b dropped them)
    expect(describeProgram(by.s6_cave_city!)).toContain('  needs land features (in the claim\'s "Site affordances"): 1 cave (floorArea >= 400, ceiling >= 6)');
    expect(describeProgram(by.s6_cave_city!)).not.toContain('"affordances"');
    expect(describeProgram(by.sky_isle!)).toContain('support: one of pillars, taper, default "pillars"');
    expect(describeProgram(by.crater_works!)).toContain('  needs: minFlat 0.3, water false, relief "low to moderate (up to ~50)"');
  });

  it('the sim stand-in picks each scenario\'s program from its one-line brief (keywords); nothing matched: no fit', () => {
    for (const s of SCENARIOS) expect(simPick(brief(s.f), undefined, programs), s.f).toMatchObject({ fits: true, program: s.program, params: {} });
    expect(simPick('a cave city', undefined, programs)).toMatchObject({ fits: true, program: 's6_cave_city' });
    expect(simPick('a cozy two-room house', undefined, programs)).toMatchObject({ fits: false, program: programs[0]!.id });
  });

  it('the land check: met over the sculpted land, refused over plains, refused without a summary; a program without needs is never refused for land', () => {
    const by = Object.fromEntries(programs.map((p) => [p.id, p]));
    const grove: PickAffordance[] = [...Array(6)].map((_, i) => ({ id: `trunk_${i}`, kind: 'trunk', metrics: { height: 35 } }));
    expect(missingLand(by.s5_treehouses!, grove)).toEqual([]);
    expect(missingLand(by.s5_treehouses!, grove.slice(0, 5))).toEqual(['s5_treehouses needs 6 trunk (height >= 24) in the claim\'s land; it has 5']);
    expect(missingLand(by.s5_treehouses!, [{ id: 't', kind: 'trunk', metrics: { height: 12 } }])).toEqual(['s5_treehouses needs 6 trunk (height >= 24) in the claim\'s land; it has 0 (1 trunk of any size)']);
    expect(missingLand(by.s6_cave_city!, undefined)[0]).toMatch(/needs land features \(1 cave \(floorArea >= 400, ceiling >= 6\)\) and this claim's land was not analysed/);
    expect(missingLand(by.flat_village!, undefined)).toEqual([]);
    const fit = { fits: true, program: 's6_cave_city', params: {}, reason: 'x' };
    expect(validatePick(fit, programs, [192, 192], { affordances: [] })).toEqual(['s6_cave_city needs 1 cave (floorArea >= 400, ceiling >= 6) in the claim\'s land; it has 0 (0 cave of any size)']);
    expect(validatePick({ ...fit, fits: false }, programs, [192, 192], { affordances: [] })).toEqual([]); // (a closest offer is not a fit)
    expect(validatePick(fit, programs, [192, 192])).toEqual([]); // (a caller without the land check: 6b's)
    expect(validatePick({ fits: true, program: 'sky_isle', params: { support: 'taper' }, reason: 'x' }, programs, [200, 200], { affordances: [] })).toEqual([]);
  });

  it('the summary and the prompt section: counts per kind and the largest of each; "not analysed" without a volume', () => {
    const s = affordanceSummary(keepAffordances([{ id: 'cave_1', kind: 'cave', metrics: { floorArea: 732, ceiling: 8, cells: 5568 }, score: 0.9 }, { id: 'pad_1', kind: 'pad', metrics: { size: 8, range: 0 } }]));
    expect(s).toBe('- cave: 1; the largest: [floorArea 732, ceiling 8, cells 5568]\n- pad: 1; the largest: [size 8, range 0]');
    expect(affordanceSummary([])).toMatch(/^none found/);
    expect(affordanceSummary(undefined, 'the mod sent no volume of the claim')).toMatch(/^not analysed \(the mod sent no volume of the claim\)/);
    const pr = pickPrompt({ brief: 'b', claim: claimOf(192), summary: 'survey\n', roles: [], mustPass: [], programs, affordances: s });
    expect(pr).toContain('## Site affordances (land features found in the claim\'s 3D volume)\n- cave: 1;');
    expect(pr).toContain('and the site affordances hold every land feature it needs');
    const old = pickPrompt({ brief: 'b', claim: claimOf(192), summary: 'survey\n', roles: [], mustPass: [], programs: [] });
    expect(old).not.toContain('Site affordances');
  });

  for (const s of SCENARIOS) {
    it(`${s.f}: its one-line brief over its land (${s.land}) is PICKED on ${s.program}, in one try`, async () => {
      const d = await design(brief(s.f), s.side, s.land);
      expect(d.result, JSON.stringify(tries(d))).toMatchObject({ outcome: 'PICKED', fits: true, program: s.program, tries: 1 });
      const st = d.region as { affordances: PickAffordance[]; volume: { sha: string } };
      const kinds: Record<string, number> = {};
      for (const a of st.affordances) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
      expect(kinds).toEqual(lands[s.land]!.kinds); // (the kit's analysis of the mod's volume, kept in the record)
      expect(st.volume.sha).toBe(lands[s.land]!.sha);
      const prompt = (sc.jobs.book.get(tries(d)[0]!.jobId)!.spec as { prompt: string }).prompt;
      expect(prompt.length).toBeGreaterThan(0);
    }, 600_000);
  }

  it('mismatched: S6\'s brief (a cave city) over plains answers NO_TEMPLATE with s6_cave_city the closest, the missing cave named', async () => {
    for (const b of [brief('s6_cave_city'), 'a cave city']) {
      const d = await design(b, 192, 'plains');
      expect(d.status).toBe('done');
      expect(d.result).toMatchObject({ outcome: 'NO_TEMPLATE', fits: false, program: 's6_cave_city', params: {}, tries: 2 });
      expect(d.result!.reason).toMatch(/no valid pick after 2 tries \(s6_cave_city needs 1 cave \(floorArea >= 400, ceiling >= 6\) in the claim's land; it has 0/);
      expect(d.result!.planId).toBeUndefined();
    }
    // requireFit: a failed design with the same offer
    const r = await design('a cave city', 192, 'plains', { requireFit: true });
    expect(r).toMatchObject({ status: 'failed', result: { outcome: 'NO_TEMPLATE', program: 's6_cave_city' } });
    expect(r.error).toMatch(/^NO_TEMPLATE: /);
  }, 600_000);

  it('mismatched: S5\'s brief over the cavern, S6\'s over the grove, and either with no volume: NO_TEMPLATE, never landing on the template', async () => {
    const a = await design(brief('s5_treehouses'), 192, 's6_cavern');
    expect(a.result).toMatchObject({ outcome: 'NO_TEMPLATE', program: 's5_treehouses' });
    expect(a.result!.reason).toMatch(/s5_treehouses needs 6 trunk \(height >= 24\) in the claim's land; it has 0/);
    const b = await design(brief('s6_cave_city'), 192, 's5_grove');
    expect(b.result).toMatchObject({ outcome: 'NO_TEMPLATE', program: 's6_cave_city' });
    const c = await design(brief('s6_cave_city'), 192, null);
    expect(c.result).toMatchObject({ outcome: 'NO_TEMPLATE', program: 's6_cave_city' });
    expect(c.result!.reason).toMatch(/this claim's land was not analysed/);
    expect((c.region as { affordances?: unknown }).affordances).toBeUndefined();
    // a scripted model answer that does fit wins over the sim stand-in (the land check still applies to it)
    const d = await design(brief('s6_cave_city'), 192, 'plains', { ext: { 'architect:simAnswers': [{ fits: true, program: 'flat_village', params: { houses: 6 }, reason: 'scripted' }] } });
    expect(d.result).toMatchObject({ outcome: 'PICKED', program: 'flat_village', params: { houses: 6 }, tries: 1 });
  }, 600_000);

  it('refusals: a volume blob that is not there; a volume of another sha is recorded as not analysed (the pick goes on without it)', async () => {
    const a = await ask({ type: 'region.design', brief: 'x', claim: claimOf(192), surveyBlobId: sc.blobs.putBytes(arsv(0, 0, 192, 192, () => 64), 'survey', 'bin'), volume: { blobId: 'b_nope', sha: 'a'.repeat(64) } });
    expect(a.ok).toBe(false);
    expect(a.error).toMatch(/volume: no blob "b_nope"/);
    const d = await design(brief('s6_cave_city'), 192, null, { volume: { ...volume('s6_cavern'), sha: 'b'.repeat(64) } });
    expect((d.region as { affordanceError: string }).affordanceError).toMatch(/hash to .*, not b{64}/);
    expect(d.result).toMatchObject({ outcome: 'NO_TEMPLATE', program: 's6_cave_city' });
  }, 600_000);
});
