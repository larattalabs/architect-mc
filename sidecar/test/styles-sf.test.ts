// (7c SF) Style format 3 in the sidecar (docs/CONTRACT.md "Phase 7c: composition" §3 row 4, S-7c-3, Steward's change 1): the feature,
// the sim bible job with scope settlement writing a valid format 3 (a building Style stays format 2), a zone Style job (BibleRequest ext
// architect_mc:relatedTo) pinning its settlement Style and sharing its core roles, a format 2 Style as that settlement Style, and
// bible.save / bible.check holding a zone Style to its settlement Style.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { formatOf, jobFormat, relatedOf, restraintOf } from '../src/bibles.js';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { BibleInfo, BibleJob, EXT_RELATED_TO, FEATURES } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.resolve(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'build.mjs'));

/** kit PALETTES.medieval.roles */
const MEDIEVAL = {
  wall: 'minecraft:white_terracotta', wall_alt: 'minecraft:calcite', trim: 'minecraft:smooth_stone', roof: 'minecraft:spruce_planks', floor: 'minecraft:dark_oak_planks',
  frame: 'minecraft:dark_oak_log', accent: 'minecraft:spruce_planks', light: 'minecraft:lantern', glass: 'minecraft:glass_pane', foundation: 'minecraft:stone_bricks', path: 'minecraft:dirt_path',
};
const MACRO = { rock: 'minecraft:stone', surface: 'minecraft:grass_block', subsurface: 'minecraft:dirt', rubble: 'minecraft:cobblestone', rail: 'minecraft:oak_fence', structure: 'minecraft:oak_planks' };

describe('Style format 3 (wire, pure)', () => {
  it('advertises bible.format3 (appended after design.program; later slices append after it); the ext key is the Java one; BibleInfo and BibleJob carry format 3 and relatedTo', () => {
    expect(FEATURES.indexOf('bible.format3')).toBe(FEATURES.indexOf('design.program') + 1); // (merge with BF) later features append after it
    expect(EXT_RELATED_TO).toBe('architect_mc:relatedTo');
    const info = { id: 'bib_h', name: 'H', version: 1, versions: [1], builtin: false, scope: 'building', roles: {}, components: [], format: 3, relatedTo: { id: 'bib_t', version: 2 } };
    expect(BibleInfo.parse(info).relatedTo).toEqual({ id: 'bib_t', version: 2 });
    expect(BibleJob.shape.request.safeParse({ prompt: 'x', relatedTo: { id: 'bib_t', version: 2 } }).success).toBe(true);
  });

  it('formatOf, relatedOf, jobFormat; a format 3 Style keeps its restraint (format 2\'s)', () => {
    expect([formatOf({}), formatOf({ format: 2 }), formatOf({ format: 3 }), formatOf({ format: 4 })]).toEqual([1, 2, 3, 1]);
    expect(relatedOf({ format: 3, relatedTo: { id: 'bib_t', version: 2 } })).toEqual({ id: 'bib_t', version: 2 });
    expect(relatedOf({ format: 2, relatedTo: { id: 'bib_t', version: 2 } })).toBeUndefined();
    expect([jobFormat('building', false), jobFormat('settlement', false), jobFormat('building', true)]).toEqual([2, 3, 3]);
    const r = { motifs: ['a', 'b', 'c', 'd'], restraint: { heroMotifs: ['d'], accentShareMax: 0.06, detailDensity: 'sparse', windowsPerFacadeMin: 3 } };
    expect(restraintOf({ ...r, format: 3 })).toEqual(restraintOf({ ...r, format: 2 }));
    expect(restraintOf({ ...r, format: 3 }).heroMotifs).toEqual(['d']);
  });
});

describe.skipIf(!hasKit)('Style format 3 (sim backend, real kit)', () => {
  let sc: Sidecar | undefined;
  let root = '';
  afterEach(async () => {
    await sc?.close();
    sc = undefined;
    rmrf(root);
  });

  async function start(): Promise<Sidecar> {
    root = tempDir('arch-sf-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    cfg.simStepMs = 10;
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    await sc.start(new SimDesigner(sc, cfg.simStepMs));
    return sc;
  }
  const finish = async (s: Sidecar, id: string) => {
    await until(() => ['done', 'failed', 'cancelled'].includes(s.bibles.get(id)!.status), 600_000);
    const j = s.bibles.get(id)!;
    expect(j.status, j.error).toBe('done');
    return j;
  };
  const stored = (s: Sidecar, id: string) => JSON.parse(fs.readFileSync(path.join(s.config.biblesDir, id, 'bible.json'), 'utf8')) as Record<string, unknown>;
  /** the kit's own verdict on an installed bible.json (tools/bible.mjs validate) */
  const kitValid = (s: Sidecar, id: string, scope: string) => {
    const r = spawnSync(process.execPath, [path.join(KIT, 'tools', 'bible.mjs'), 'validate', path.join(s.config.biblesDir, id, 'bible.json'), '--scope', scope], { cwd: KIT, encoding: 'utf8' });
    return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as { ok: boolean; errors: string[] };
  };

  it('the bible job with scope settlement writes a valid format 3 (the settlement defaults filled in); scope building stays format 2', async () => {
    const s = await start();
    const town = await finish(s, s.bibles.request({ prompt: 'a hill town of terraces and rope bridges', name: 'Hill Town', scope: 'settlement' }).id);
    const j = stored(s, town.bibleId);
    expect(j.format).toBe(3);
    expect(j.scope).toBe('settlement');
    expect(j.settlement).toEqual({ verticality: 'high', density: 'low', lightEvery: 12, edges: 'railed', roleShares: { wall: [0.05, 0.6], frame: [0.02, 0.3] } });
    expect(j.connectors).toEqual({ prefer: ['rope_bridge', 'ladder'], ladder: { landingEvery: 16 } });
    expect(j.restraint).toBeTruthy();
    expect(kitValid(s, town.bibleId, 'settlement')).toMatchObject({ ok: true, errors: [] });
    expect(town.bible).toMatchObject({ format: 3, scope: 'settlement' });
    expect(town.bible!.relatedTo).toBeUndefined();
    const house = await finish(s, s.bibles.request({ prompt: 'a cottage', name: 'Cottage' }).id);
    const h = stored(s, house.bibleId);
    expect(h.format).toBe(2);
    for (const k of ['settlement', 'forms', 'scatter', 'references', 'relatedTo']) expect(h[k], k).toBeUndefined();
    expect(h.connectors).toBeUndefined();
    expect(house.bible!.format).toBe(2);
    // a revise of the settlement Style stays format 3; its "Add parts" too
    const rev = await finish(s, s.bibles.revise(town.bibleId, 'warmer roofs').id);
    expect(stored(s, rev.bibleId).format).toBe(3);
    const parts = await finish(s, s.bibles.parts({ bibleId: town.bibleId }).job.id);
    expect(stored(s, parts.bibleId).format).toBe(3);
  });

  it('a zone Style (ext architect_mc:relatedTo) pins its settlement Style and shares its core roles; a format 2 Style is a settlement Style', async () => {
    const s = await start();
    // Steward's change 1: its one bible per settlement, format 2, made by hand (bible.save), is the settlement Style
    const saved = s.bibleIndex.save({ owner: 'steward_mc:settlement/s1', bible: { name: 'Mossford', scope: 'settlement', format: 2, roles: { ...MEDIEVAL, ...MACRO } } });
    expect(stored(s, saved.id).format).toBe(2);
    const zone = await finish(s, s.bibles.request({ prompt: 'the harbour quarter', name: 'Harbour', ext: { [EXT_RELATED_TO]: saved.id } }).id);
    expect(zone.request.relatedTo).toEqual({ id: saved.id, version: saved.version });
    const z = stored(s, zone.bibleId);
    expect(z.format).toBe(3);
    expect(z.relatedTo).toEqual({ id: saved.id, version: saved.version });
    // the sim drafts its own roles; the core roles are the settlement Style's
    const zr = z.roles as Record<string, string>;
    for (const [r, b] of Object.entries(MEDIEVAL)) expect(zr[r], r).toBe(b);
    expect(zone.bible!.relatedTo).toEqual({ id: saved.id, version: saved.version });
    expect(kitValid(s, zone.bibleId, 'building').ok).toBe(true);
    // what a zone Style may not relate to: nothing, a missing Style, another zone Style
    expect(() => s.bibles.request({ prompt: 'x', ext: { [EXT_RELATED_TO]: 'bib_nowhere' } })).toThrow(/no Style "bib_nowhere"/);
    expect(() => s.bibles.request({ prompt: 'x', ext: { [EXT_RELATED_TO]: 7 } })).toThrow(/must be a Style id/);
    expect(() => s.bibles.request({ prompt: 'x', ext: { [EXT_RELATED_TO]: zone.bibleId } })).toThrow(/is itself a zone Style/);
    // a built-in Style (format 1) is a settlement Style too
    const fromRustic = await finish(s, s.bibles.request({ prompt: 'the market', name: 'Market', ext: { [EXT_RELATED_TO]: 'rustic' } }).id);
    expect(stored(s, fromRustic.bibleId).relatedTo).toEqual({ id: 'rustic', version: 1 });
  });

  it('bible.save and bible.check hold a zone Style to its settlement Style\'s core roles', async () => {
    const s = await start();
    const town = s.bibleIndex.save({ bible: { name: 'Town', scope: 'settlement', format: 3, roles: { ...MEDIEVAL, ...MACRO }, settlement: { density: 'high' } } });
    expect(stored(s, town.id).settlement).toEqual({ verticality: 'medium', density: 'high', lightEvery: 12, edges: 'railed', roleShares: {} });
    const pin = { id: town.id, version: town.version };
    const zone = { name: 'Docks', format: 3, relatedTo: pin, roles: { ...MEDIEVAL, ...MACRO, structure: 'minecraft:spruce_planks' }, connectors: { prefer: ['bridge'] } };
    expect(s.bibleIndex.check({ bible: zone })).toMatchObject({ ok: true, errors: [] });
    const off = { ...zone, roles: { ...zone.roles, wall: 'minecraft:sandstone' } };
    const c = s.bibleIndex.check({ bible: off });
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toMatch(/shares the settlement Style's core roles; wall is minecraft:sandstone/);
    expect(() => s.bibleIndex.save({ bible: off })).toThrow(/core roles/);
    expect(s.bibleIndex.check({ bible: { ...zone, relatedTo: { id: town.id, version: 9 } } }).errors.join(' ')).toMatch(/has no version 9/);
    const ok = s.bibleIndex.save({ bible: zone });
    expect(stored(s, ok.id)).toMatchObject({ format: 3, relatedTo: pin, connectors: { prefer: ['bridge'] } });
    expect(ok.bible.relatedTo).toEqual(pin);
    // nothing left behind
    expect(fs.readdirSync(s.config.dataDir).filter((f) => f.startsWith('bible-related-') || f.startsWith('bible-check-') || f.startsWith('bible-save-'))).toEqual([]);
  });
});
