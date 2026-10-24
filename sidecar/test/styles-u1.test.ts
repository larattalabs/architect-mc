// Style unification U1 (docs/CONTRACT.md "Style unification"): materials only (DesignRequest.palette with a Style's roles inline,
// never bible set mode), the strict PaletteSpec, variants with roles, and bible.save (a hand-made Style: no Claude call, every save a
// new version, an existing version folder never touched).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { BibleSaveMsg, DesignRequest, FEATURES, PaletteSpec, VariantRequestMsg, type Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.resolve(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'build.mjs'));

/** kit PALETTES.medieval.roles (an authored built-in Style: its wall is set by the Style, not by the wood) */
const MEDIEVAL = {
  wall: 'minecraft:white_terracotta', wall_alt: 'minecraft:calcite', trim: 'minecraft:smooth_stone', roof: 'minecraft:spruce_planks', floor: 'minecraft:dark_oak_planks',
  frame: 'minecraft:dark_oak_log', accent: 'minecraft:spruce_planks', light: 'minecraft:lantern', glass: 'minecraft:glass_pane', foundation: 'minecraft:stone_bricks', path: 'minecraft:dirt_path',
};

interface H {
  sc: Sidecar;
  events: Outbound[];
  close(): Promise<void>;
}

async function harness(over: Partial<Config> = {}): Promise<H> {
  const root = tempDir('arch-u1-');
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

const sidecarJson = (sc: Sidecar, id: string) => JSON.parse(fs.readFileSync(path.join(sc.config.libraryDir, id, `${id}.blueprint.json`), 'utf8')) as Record<string, unknown>;

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

describe('the wire (pure)', () => {
  it('FEATURES lists palette.roles and bible.save; PaletteSpec takes roles inline and refuses unknown keys', () => {
    expect(FEATURES).toContain('palette.roles');
    expect(FEATURES).toContain('bible.save');
    const roles = { bible: { id: 'medieval', version: 1, roles: MEDIEVAL } };
    expect(PaletteSpec.parse(roles)).toEqual(roles);
    expect(PaletteSpec.parse('rustic')).toBe('rustic');
    expect(PaletteSpec.parse({ wood: 'oak' })).toEqual({ wood: 'oak' });
    // before U1 the inputs object was not strict: { bible } parsed as {} and built the default palette
    expect(PaletteSpec.safeParse({ wood: 'oak', bible: roles.bible }).success).toBe(false);
    expect(PaletteSpec.safeParse({ wod: 'oak' }).success).toBe(false);
    expect(PaletteSpec.safeParse({ bible: { id: 'medieval', version: 1, roles: MEDIEVAL, extra: 1 } }).success).toBe(false);
    expect(PaletteSpec.safeParse({ bible: { id: 'medieval', version: 1, roles: { Wall: 'minecraft:stone' } } }).success).toBe(false);
    expect(VariantRequestMsg.safeParse({ v: 1, type: 'variant.request', from: 'gen_a', palette: roles }).success).toBe(true);
    // palette and bible exclude each other; a massing has no materials
    expect(DesignRequest.safeParse(request({ palette: roles, bible: 'rustic' })).success).toBe(false);
    expect(DesignRequest.safeParse(request({ palette: roles, massing: true })).success).toBe(false);
    expect(DesignRequest.parse(request({ palette: roles })).palette).toEqual(roles);
    expect(BibleSaveMsg.safeParse({ v: 1, type: 'bible.save', bible: { name: 'X', roles: MEDIEVAL } }).success).toBe(true);
  });
});

describe.skipIf(!hasKit)('U1 materials only, variants with roles, bible.save (sim backend, real kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('a design with a built-in Style through palette: built with its roles, no bible set mode, the palette recorded', async () => {
    h = await harness();
    const palette = { bible: { id: 'medieval', version: 1, roles: MEDIEVAL } };
    const d = h.sc.requestDesign(DesignRequest.parse(request({ name: 'Daub House', palette })));
    await until(() => ['done', 'failed'].includes(h!.sc.designs.get(d.id)!.status), 60_000);
    const done = h.sc.designs.get(d.id)!;
    expect(done.status, done.error).toBe('done');
    const sc = sidecarJson(h.sc, done.blueprintId!);
    expect(sc.palette).toEqual(palette);
    // the kit records the Style the roles came from as the entry's bible pin (so that version is kept); the blocks come from the roles
    expect(sc.bible).toEqual({ id: 'medieval', version: 1 });
    expect(fs.existsSync(path.join(h.sc.config.libraryDir, done.blueprintId!, 'bible'))).toBe(false);
    const blocks = JSON.stringify(sc);
    expect(blocks).toContain('white_terracotta');
    // a palette the kit cannot build is refused at the request
    expect(() => h!.sc.requestDesign(DesignRequest.parse(request({ palette: { bible: { id: 'x', version: 1, roles: { ...MEDIEVAL, roof: 'minecraft:glass' } } } })))).toThrow(/palette: .*roof/);
    expect(() => h!.sc.requestDesign(DesignRequest.parse(request({ palette: 'nope' })))).toThrow(/unknown preset/);
  });

  it('the brief names the materials and never the bible section', async () => {
    const { designBrief } = await import('../src/claude/brief.js');
    const req = DesignRequest.parse(request({ palette: { bible: { id: 'medieval', version: 1, roles: MEDIEVAL } } }));
    const b = designBrief(req, 'gen_x', { examples: ['cabin'] } as never);
    expect(b).toContain('the player picked these materials');
    expect(b).toContain('white_terracotta');
    expect(b).not.toContain('## The style bible');
    expect(b).not.toContain('Follow it over your own taste');
  });

  it('a variant with roles inline replaces the recorded palette and re-skins the entry', async () => {
    h = await harness();
    const d = h.sc.requestDesign(DesignRequest.parse(request({ name: 'Plain Cabin', palette: 'oak' })));
    await until(() => ['done', 'failed'].includes(h!.sc.designs.get(d.id)!.status), 60_000);
    const from = h.sc.designs.get(d.id)!.blueprintId!;
    const roles = { ...MEDIEVAL, light: 'minecraft:soul_lantern' };
    const v = h.sc.requestVariant(from, { bible: { id: 'medieval', version: 1, roles } });
    await until(() => ['done', 'failed'].includes(h!.sc.variants.get(v.id)!.status), 60_000);
    const done = h.sc.variants.get(v.id)!;
    expect(done.status, done.error).toBe('done');
    expect(done.blueprintId).toBe(`${from}_medieval`);
    const sc = sidecarJson(h.sc, done.blueprintId!);
    expect(sc.palette).toEqual({ bible: { id: 'medieval', version: 1, roles } });
  });

  it('bible.save: a new Style, a new version per save, refusals; existing version folders never touched', async () => {
    h = await harness();
    const s1 = h.sc.bibleIndex.save({ bible: { name: 'Alpine Timber', roles: MEDIEVAL, tags: ['cold'], suggestedFeatures: ['chimney'], basedOn: { id: 'medieval', version: 1 }, origin: 'claude', builtin: true } });
    expect(s1).toMatchObject({ id: 'bib_alpine_timber', version: 1 });
    expect(s1.bible).toMatchObject({ origin: 'hand', tags: ['cold'], suggestedFeatures: ['chimney'], basedOn: { id: 'medieval', version: 1 }, builtin: false });
    const dir = path.join(h.sc.config.biblesDir, 'bib_alpine_timber');
    const v1 = hashTree(path.join(dir, 'versions', '1'));
    expect(Object.keys(v1).sort()).toEqual(['bible.json', 'components.mjs']);
    const s2 = h.sc.bibleIndex.save({ id: 'bib_alpine_timber', bible: { name: 'Alpine Timber', roles: { ...MEDIEVAL, light: 'minecraft:soul_lantern' } } });
    expect(s2.version).toBe(2);
    expect(hashTree(path.join(dir, 'versions', '1'))).toEqual(v1);
    expect(h.sc.bibleIndex.get('bib_alpine_timber')!.roles.light).toBe('minecraft:soul_lantern');
    expect(h.sc.bibleIndex.get('bib_alpine_timber', 1)!.roles.light).toBe('minecraft:lantern');
    // the same name again: a new id
    expect(h.sc.bibleIndex.save({ bible: { name: 'Alpine Timber', roles: MEDIEVAL } }).id).toBe('bib_alpine_timber_2');
    // refusals: built-in, another owner's, bad roles (the test house), no name
    const before = hashTree(h.sc.config.biblesDir);
    expect(() => h!.sc.bibleIndex.save({ id: 'medieval', bible: { name: 'M', roles: MEDIEVAL } })).toThrow(/built-in Style/);
    expect(() => h!.sc.bibleIndex.save({ id: 'bib_alpine_timber', owner: 'steward_mc:s1', bible: { name: 'A', roles: MEDIEVAL } })).toThrow(/belongs to the player/);
    expect(() => h!.sc.bibleIndex.save({ bible: { name: 'Dark', roles: { ...MEDIEVAL, light: 'minecraft:stone' } } })).toThrow(/kit refused/);
    expect(() => h!.sc.bibleIndex.save({ bible: { roles: MEDIEVAL } })).toThrow(/needs a name/);
    expect(() => h!.sc.bibleIndex.save({ bible: { name: 'Feat', roles: MEDIEVAL, suggestedFeatures: ['moat'] } })).toThrow(/moat/);
    expect(hashTree(h.sc.config.biblesDir)).toEqual(before);
    // a mod's Style: only that owner saves, and the version GC keeps every version of it
    const st = h.sc.bibleIndex.save({ owner: 'steward_mc:s1', bible: { name: 'Frostholm', roles: MEDIEVAL } });
    expect(() => h!.sc.bibleIndex.save({ id: st.id, bible: { name: 'Frostholm', roles: MEDIEVAL } })).toThrow(/belongs to steward_mc:s1/);
    h.sc.bibleIndex.save({ id: st.id, owner: 'steward_mc:s1', bible: { name: 'Frostholm', roles: MEDIEVAL } });
    const old = path.join(h.sc.config.biblesDir, st.id, 'versions', '1', 'bible.json');
    const b1 = JSON.parse(fs.readFileSync(old, 'utf8')) as Record<string, unknown>;
    expect(b1.owner).toBe('steward_mc:s1');
    const owned = hashTree(path.join(h.sc.config.biblesDir, st.id));
    expect(h.sc.bibleIndex.gc(-1)).not.toContain(`${st.id} v1`);
    expect(hashTree(path.join(h.sc.config.biblesDir, st.id))).toEqual(owned);
    // the wire: bible.save through the message handler acks the saved version
    const acks: Outbound[] = [];
    await h.sc.handle(BibleSaveMsg.parse({ v: 1, type: 'bible.save', id: 'c1', bible: { name: 'Wire Style', roles: MEDIEVAL } }) as never, (m) => acks.push(m));
    expect(acks[0]).toMatchObject({ type: 'ack', ok: true, result: { id: 'bib_wire_style', version: 1 } });
  });
});
