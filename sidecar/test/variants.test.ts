// Variants and imports without Claude (docs/CONTRACT.md "Variants without Claude", "Import / export"), with the
// fixture kit: naming, import path rules, the job pipeline, refusals, independence from the design queue, restart.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { ServerMessage, type ServerMessage as SM } from '../src/protocol.js';
import { SidecarServer } from '../src/server.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { checkImportPath, importRoots, mergePalette, normalizeKitImports, variantDisplayName, variantId, VariantRefused } from '../src/variants.js';
import { copyKit, request, rmrf, tempDir, until } from './helpers.js';

// ---------------------------------------------------------------- pure parts

describe('the brief asks for parametric, palette-driven designs', () => {
  it('mentions params, their corners and palette-driven materials', async () => {
    const { designBrief } = await import('../src/claude/brief.js');
    const { CONTRACT_EXCERPT } = await import('../src/claude/contract.js');
    const { DesignRequest } = await import('../src/protocol.js');
    const b = designBrief(DesignRequest.parse(request()), 'gen_x', { renderer: true, examples: ['cabin', 'tower'] });
    expect(b).toMatch(/export const params = \{\.\.\.\}` with 2 to 4 meaningful params/);
    expect(b).toMatch(/Materials come from the palette/);
    expect(b).toMatch(/--palette cherry/);
    expect(CONTRACT_EXCERPT).toMatch(/## Parametric designs/);
    expect(CONTRACT_EXCERPT).toMatch(/"values": \{ "width": 9/);
  });
});

describe('variant naming', () => {
  it('ids: <from>_<palette>, then _2; <from>_v2, _v3 without a palette', () => {
    const lib = tempDir();
    try {
      expect(variantId(lib, 'gen_cabin', 'birch')).toBe('gen_cabin_birch');
      fs.mkdirSync(path.join(lib, 'gen_cabin_birch'));
      expect(variantId(lib, 'gen_cabin', 'birch')).toBe('gen_cabin_birch_2');
      expect(variantId(lib, 'gen_cabin', { wood: 'cherry', stone: 'bricks' })).toBe('gen_cabin_cherry');
      expect(variantId(lib, 'gen_cabin', { stone: 'minecraft:mud_bricks' })).toBe('gen_cabin_mud_bricks');
      expect(variantId(lib, 'gen_cabin', undefined)).toBe('gen_cabin_v2');
      fs.mkdirSync(path.join(lib, 'gen_cabin_v2'));
      expect(variantId(lib, 'gen_cabin', undefined, new Set(['gen_cabin_v3']))).toBe('gen_cabin_v4');
    } finally {
      rmrf(lib);
    }
  });

  it('display names list the palette and the values that changed', () => {
    const params = { floors: { type: 'int', label: 'Floors' }, porch: { type: 'bool', label: 'Porch' }, roof: { type: 'enum', label: 'Roof' } };
    expect(variantDisplayName('Lakeside Cabin', { palette: 'birch', values: { floors: 2 }, baseValues: { floors: 1 }, params })).toBe('Lakeside Cabin (birch, floors 2)');
    expect(variantDisplayName('Lakeside Cabin', { values: { porch: false, floors: 1, roof: 'hip' }, baseValues: { floors: 1, porch: true }, params })).toBe('Lakeside Cabin (no porch, roof hip)');
    expect(variantDisplayName('Tower', { palette: { wood: 'cherry', stone: 'mud_bricks' } })).toBe('Tower (cherry, mud bricks)');
    expect(variantDisplayName('Tower', {})).toBe('Tower (variant)');
  });

  it('palettes: a preset as asked, inputs over the recorded ones', () => {
    const rec = { preset: 'rustic', wood: 'spruce', stone: 'cobblestone', roof: 'dark_oak', accent: 'dark_oak' };
    expect(mergePalette(rec, 'birch')).toBe('birch');
    expect(mergePalette(rec, { wood: 'cherry' })).toEqual({ ...rec, wood: 'cherry' });
    expect(mergePalette(rec, undefined)).toEqual(rec);
    expect(mergePalette(undefined, undefined)).toBeUndefined();
    expect(mergePalette({ junk: 1 }, { wood: 'oak' })).toEqual({ wood: 'oak' });
  });

  it('library sources get their kit imports pointed at the scratch kit', () => {
    const src = "import { Blueprint } from '../lib/kit.mjs';\nimport { x } from \"../../kit/lib/blocks.mjs\";\nimport y from './lib/check.mjs';\nconst z = await import('../../../somewhere/kit/lib/kit.mjs');\nimport fs from 'node:fs';\n";
    expect(normalizeKitImports(src)).toBe("import { Blueprint } from '../lib/kit.mjs';\nimport { x } from \"../lib/blocks.mjs\";\nimport y from '../lib/check.mjs';\nconst z = await import('../lib/kit.mjs');\nimport fs from 'node:fs';\n");
  });
});

describe('import paths', () => {
  let root: string;
  let lib: string;
  beforeAll(() => {
    root = tempDir('arch-imp-');
    lib = path.join(root, 'game', 'architect', 'library');
    fs.mkdirSync(lib, { recursive: true });
    const w = path.join(root, 'game', 'saves', 'World 1');
    for (const f of ['architect/imports/hut.nbt', 'architect/imports/sub/deep.nbt', 'architect/imports/notes.txt', 'saves/World 1/generated/minecraft/structures/house.nbt', 'saves/World 1/generated/mymod/structures/a/b.nbt', 'saves/World 1/data/raids.nbt', 'saves/World 1/level.nbt', 'outside.nbt']) {
      fs.mkdirSync(path.dirname(path.join(root, 'game', f)), { recursive: true });
      fs.writeFileSync(path.join(root, 'game', f), 'x');
    }
    fs.symlinkSync(path.join(root, 'game', 'outside.nbt'), path.join(root, 'game', 'architect', 'imports', 'link.nbt'));
    fs.symlinkSync(path.join(w, 'generated', 'minecraft', 'structures', 'house.nbt'), path.join(root, 'game', 'architect', 'imports', 'ok_link.nbt'));
  });
  afterAll(() => rmrf(root));

  it('derives the roots from the library path', () => {
    expect(importRoots(lib)).toEqual({ imports: path.join(root, 'game', 'architect', 'imports'), saves: path.join(root, 'game', 'saves') });
  });

  it('accepts .nbt files in imports/ and in a world\'s generated/<ns>/structures/', () => {
    const g = (f: string) => path.join(root, 'game', f);
    expect(checkImportPath(g('architect/imports/hut.nbt'), lib)).toBe(g('architect/imports/hut.nbt'));
    expect(checkImportPath(g('architect/imports/sub/deep.nbt'), lib)).toBe(g('architect/imports/sub/deep.nbt'));
    expect(checkImportPath(g('saves/World 1/generated/minecraft/structures/house.nbt'), lib)).toBe(g('saves/World 1/generated/minecraft/structures/house.nbt'));
    expect(checkImportPath(g('saves/World 1/generated/mymod/structures/a/b.nbt'), lib)).toBe(g('saves/World 1/generated/mymod/structures/a/b.nbt'));
    // a link inside imports/ to a structure save is fine (its real path is allowed too)
    expect(checkImportPath(g('architect/imports/ok_link.nbt'), lib)).toBe(g('saves/World 1/generated/minecraft/structures/house.nbt'));
  });

  it('refuses anything else, and says so', () => {
    const g = (f: string) => path.join(root, 'game', f);
    const refused = (p: string, re: RegExp) => {
      expect(() => checkImportPath(p, lib)).toThrow(VariantRefused);
      expect(() => checkImportPath(p, lib)).toThrow(re);
    };
    refused('architect/imports/hut.nbt', /not an absolute path/);
    refused(g('architect/imports/notes.txt'), /not an \.nbt file/);
    refused(g('architect/imports/../../outside.nbt'), /outside those folders/);
    refused(g('architect/imports/link.nbt'), /outside those folders/);
    refused(g('saves/World 1/data/raids.nbt'), /outside those folders/);
    refused(g('saves/World 1/level.nbt'), /outside those folders/);
    refused(g('architect/imports/missing.nbt'), /no file/);
    refused(g('architect/imports'), /not an \.nbt file/);
    expect(() => checkImportPath(g('outside.nbt'), lib)).toThrow(/Architect imports only an \.nbt file in/);
  });
});

// ---------------------------------------------------------------- jobs (fixture kit)

interface H {
  root: string;
  game: string;
  sc: Sidecar;
  store: Store;
  close(): Promise<void>;
}

/** A sidecar over <root>/game/architect/{library,sidecar-data} with a copy of the fixture kit. */
function harness(simStepMs = 5): { h: H; designer: SimDesigner } {
  const root = tempDir('arch-var-');
  const game = path.join(root, 'game');
  const kit = copyKit(root);
  const cfg = loadConfig(['--data', path.join(game, 'architect', 'sidecar-data'), '--library', path.join(game, 'architect', 'library'), '--kit', kit, '--backend', 'sim'], {});
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.libraryDir, { recursive: true });
  const store = new Store(cfg.dataDir, { debounceMs: 5 });
  const sc = new Sidecar(cfg, store, memoryLogger());
  const designer = new SimDesigner(sc, simStepMs);
  return {
    designer,
    h: {
      root,
      game,
      sc,
      store,
      close: async () => {
        await sc.close();
        rmrf(root);
      },
    },
  };
}

/** A library entry made from the fixture cabin, as an installed (phase 2) entry looks. */
function installEntry(sc: Sidecar, id: string, extra: Record<string, unknown> = {}): void {
  const dir = path.join(sc.config.libraryDir, id);
  fs.mkdirSync(dir, { recursive: true });
  // an installed source imports ../lib/kit.mjs from <library>/<id>/
  fs.writeFileSync(path.join(dir, `${id}.mjs`), fs.readFileSync(path.join(sc.config.kitDir, 'designs', 'cabin.mjs'), 'utf8').replace("export const id = 'cabin'", `export const id = '${id}'`));
  fs.writeFileSync(path.join(dir, `${id}.nbt`), 'FAKE');
  fs.writeFileSync(path.join(dir, `${id}.blueprint.json`), JSON.stringify({
    id, name: 'Lakeside Cabin', description: 'A cabin by the lake.', type: 'cabin', size: { x: 11, y: 9, z: 10 },
    palette: { preset: 'rustic', wood: 'spruce', stone: 'cobblestone', roof: 'dark_oak', accent: 'dark_oak' },
    params: { floors: { type: 'int', min: 1, max: 3, default: 1, label: 'Floors' }, porch: { type: 'bool', default: true, label: 'Porch' } },
    values: { floors: 1, porch: false },
    source: `${id}.mjs`, createdAt: 1, request: request(), favorite: true, userTags: ['mine'], displayName: 'My Cabin',
    ...extra,
  }));
}

const readSidecar = (sc: Sidecar, id: string) => JSON.parse(fs.readFileSync(path.join(sc.config.libraryDir, id, `${id}.blueprint.json`), 'utf8')) as Record<string, unknown>;

describe('variant jobs (fixture kit)', () => {
  let h: H;
  let designer: SimDesigner;
  beforeEach(async () => {
    ({ h, designer } = harness());
    await h.sc.start(designer);
  });
  afterEach(async () => h.close());

  it('a palette variant: built, checked, rendered, installed with variantOf, the request and a displayName', async () => {
    installEntry(h.sc, 'gen_lakeside_cabin');
    const v = h.sc.requestVariant('gen_lakeside_cabin', 'birch');
    expect(v).toMatchObject({ id: 'v1', kind: 'variant', from: 'gen_lakeside_cabin', palette: 'birch' });
    await h.sc.variantRunner.idle();
    const done = h.sc.variants.get(v.id)!;
    expect(done.status, done.error).toBe('done');
    expect(done.blueprintId).toBe('gen_lakeside_cabin_birch');
    expect(done.size).toEqual({ x: 11, y: 9, z: 10 });
    const dir = path.join(h.sc.config.libraryDir, 'gen_lakeside_cabin_birch');
    expect(fs.readdirSync(dir).sort()).toEqual(['gen_lakeside_cabin_birch.blueprint.json', 'gen_lakeside_cabin_birch.mjs', 'gen_lakeside_cabin_birch.nbt', 'gen_lakeside_cabin_birch.preview-front.png', 'gen_lakeside_cabin_birch.preview-iso.png', 'gen_lakeside_cabin_birch.preview-top.png']);
    expect(done.previews).toEqual(['front', 'iso', 'top'].map((x) => path.join(dir, `gen_lakeside_cabin_birch.preview-${x}.png`)));
    const sc = readSidecar(h.sc, 'gen_lakeside_cabin_birch');
    expect(sc).toMatchObject({
      id: 'gen_lakeside_cabin_birch', name: 'Lakeside Cabin', description: 'A cabin by the lake.', type: 'cabin', variantOf: 'gen_lakeside_cabin',
      palette: { preset: 'birch', wood: 'birch' }, values: { floors: 1, porch: false }, source: 'gen_lakeside_cabin_birch.mjs', request: request(),
      displayName: 'Lakeside Cabin (birch)',
    });
    expect(sc.favorite).toBeUndefined();
    expect(sc.userTags).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'gen_lakeside_cabin_birch.mjs'), 'utf8')).toContain("export const id = 'gen_lakeside_cabin_birch'");
    // the original is untouched
    expect(readSidecar(h.sc, 'gen_lakeside_cabin')).toMatchObject({ favorite: true, displayName: 'My Cabin' });
    // the checker child got a minimal environment
    const env = JSON.parse(fs.readFileSync(path.join(h.sc.config.dataDir, 'variants', 'v1', 'check', 'env.json'), 'utf8')) as Record<string, string>;
    expect(Object.keys(env).every((k) => ['PATH', 'Path', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR', 'SystemRoot', 'SYSTEMROOT', 'windir', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].includes(k))).toBe(true);
  });

  it('a param variant keeps the entry\'s palette and values, may grow, and is named _v2', async () => {
    installEntry(h.sc, 'gen_lakeside_cabin');
    const v = h.sc.requestVariant('gen_lakeside_cabin', undefined, { floors: 3 });
    const w = h.sc.requestVariant('gen_lakeside_cabin', { wood: 'cherry' }, undefined, 'Cherry Cabin');
    await h.sc.variantRunner.idle();
    expect(h.sc.variants.get(v.id)!.blueprintId).toBe('gen_lakeside_cabin_v2');
    const a = readSidecar(h.sc, 'gen_lakeside_cabin_v2');
    expect(a).toMatchObject({ size: { x: 11, y: 17, z: 10 }, values: { floors: 3, porch: false }, palette: { preset: 'rustic', wood: 'spruce' }, displayName: 'Lakeside Cabin (floors 3)', variantOf: 'gen_lakeside_cabin' });
    const b = readSidecar(h.sc, h.sc.variants.get(w.id)!.blueprintId!);
    expect(b).toMatchObject({ id: 'gen_lakeside_cabin_cherry', palette: { preset: 'rustic', wood: 'cherry', stone: 'cobblestone' }, displayName: 'Cherry Cabin' });
  });

  it('a variant of a variant, and of a bundled example (the kit design; no request)', async () => {
    const v = h.sc.requestVariant('cabin', 'dark', { porch: false });
    await h.sc.variantRunner.idle();
    expect(h.sc.variants.get(v.id)!.status).toBe('done');
    const sc = readSidecar(h.sc, 'cabin_dark');
    expect(sc).toMatchObject({ variantOf: 'cabin', palette: { preset: 'dark' }, values: { floors: 1, porch: false }, displayName: 'Cabin (dark, no porch)' });
    expect(sc.request).toBeUndefined();
    const v2 = h.sc.requestVariant('cabin_dark', 'birch');
    await h.sc.variantRunner.idle();
    expect(readSidecar(h.sc, h.sc.variants.get(v2.id)!.blueprintId!)).toMatchObject({ id: 'cabin_dark_birch', variantOf: 'cabin_dark', values: { porch: false } });
  });

  it('refuses at once: no such entry, an import, an entry without a source', () => {
    expect(() => h.sc.requestVariant('nope')).toThrow(/no library entry "nope"/);
    installEntry(h.sc, 'imp_house', { imported: true });
    expect(() => h.sc.requestVariant('imp_house')).toThrow(/imported structure: it has no source/);
    installEntry(h.sc, 'gen_old');
    fs.rmSync(path.join(h.sc.config.libraryDir, 'gen_old', 'gen_old.mjs'));
    expect(() => h.sc.requestVariant('gen_old')).toThrow(/has no source/);
    expect(h.sc.variants.list()).toHaveLength(0);
  });

  it('a value out of range or a bad palette fails the job with the kit\'s lines; nothing is installed', async () => {
    installEntry(h.sc, 'gen_lakeside_cabin');
    const a = h.sc.requestVariant('gen_lakeside_cabin', undefined, { floors: 9 });
    const b = h.sc.requestVariant('gen_lakeside_cabin', 'nope');
    await h.sc.variantRunner.idle();
    expect(h.sc.variants.get(a.id)).toMatchObject({ status: 'failed' });
    expect(h.sc.variants.get(a.id)!.error).toMatch(/- values: floors must be an integer 1\.\.3 \(got 9\)/);
    expect(h.sc.variants.get(b.id)!.error).toMatch(/palette: unknown preset 'nope'/);
    expect(fs.readdirSync(h.sc.config.libraryDir).sort()).toEqual(['gen_lakeside_cabin']);
  });

  it('a check failure carries the checker lines', async () => {
    installEntry(h.sc, 'gen_broken');
    const f = path.join(h.sc.config.libraryDir, 'gen_broken', 'gen_broken.mjs');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("description: 'A fixture cabin.'", "description: 'A fixture cabin.', fail: 'light: 3 standable interior cell(s) get no block light', warnings: ['floating: 1 block(s)']"));
    const v = h.sc.requestVariant('gen_broken', 'birch');
    await h.sc.variantRunner.idle();
    const r = h.sc.variants.get(v.id)!;
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/the variant did not pass: the checker refused the design:\n- light: 3 standable interior cell\(s\) get no block light/);
  });

  it('does not wait behind a running design', async () => {
    const slow = harness(60_000);
    try {
      await slow.h.sc.start(slow.designer);
      const d = slow.h.sc.requestDesign(request());
      await until(() => slow.h.sc.designs.get(d.id)!.status === 'designing');
      const v = slow.h.sc.requestVariant('cabin', 'birch');
      await until(() => slow.h.sc.variants.get(v.id)!.status === 'done', 20_000);
      expect(slow.h.sc.designs.get(d.id)!.status).toBe('designing');
    } finally {
      await slow.h.close();
    }
  });
});

describe('import jobs (fixture kit)', () => {
  let h: H;
  let designer: SimDesigner;
  let imports: string;
  beforeEach(async () => {
    ({ h, designer } = harness());
    imports = path.join(h.game, 'architect', 'imports');
    fs.mkdirSync(imports, { recursive: true });
    await h.sc.start(designer);
  });
  afterEach(async () => h.close());

  it('imports an .nbt as an imported entry without a source', async () => {
    const file = path.join(imports, 'my_old-house.nbt');
    fs.writeFileSync(file, 'NBT');
    const v = h.sc.requestImport(file);
    expect(v).toMatchObject({ kind: 'import', from: file });
    await h.sc.variantRunner.idle();
    const done = h.sc.variants.get(v.id)!;
    expect(done.status, done.error).toBe('done');
    expect(done.blueprintId).toBe('imp_my_old_house');
    expect(fs.readdirSync(path.join(h.sc.config.libraryDir, 'imp_my_old_house')).sort()).toEqual(['imp_my_old_house.blueprint.json', 'imp_my_old_house.nbt', 'imp_my_old_house.preview-front.png', 'imp_my_old_house.preview-iso.png', 'imp_my_old_house.preview-top.png']);
    const sc = readSidecar(h.sc, 'imp_my_old_house');
    expect(sc).toMatchObject({ id: 'imp_my_old_house', type: 'custom', imported: true, groundY: 1, front: 'south', name: 'My Old House' });
    for (const k of ['source', 'variantOf', 'request', 'displayName', 'favorite']) expect(sc[k]).toBeUndefined();
    // and no variants of it
    expect(() => h.sc.requestVariant('imp_my_old_house')).toThrow(/no source/);
    // a second import of the same file never overwrites
    const v2 = h.sc.requestImport(file);
    await h.sc.variantRunner.idle();
    expect(h.sc.variants.get(v2.id)!.blueprintId).toBe('imp_my_old_house_2');
  });

  it('non-vanilla blocks fail with the list of them; junk fails clearly', async () => {
    fs.writeFileSync(path.join(imports, 'modded.nbt'), 'NBT MODDED');
    fs.writeFileSync(path.join(imports, 'junk.nbt'), 'JUNK');
    const a = h.sc.requestImport(path.join(imports, 'modded.nbt'));
    const b = h.sc.requestImport(path.join(imports, 'junk.nbt'));
    await h.sc.variantRunner.idle();
    expect(h.sc.variants.get(a.id)!.error).toMatch(/modded\.nbt cannot be imported: the checker refused it:\n- unknown or non-vanilla blocks \(2\): create:shaft x4, create:cogwheel x1/);
    expect(h.sc.variants.get(b.id)!.error).toMatch(/cannot read it as a structure file/);
    expect(fs.readdirSync(h.sc.config.libraryDir)).toEqual([]);
  });

  it('refuses a path outside the import folders at once', () => {
    const out = path.join(h.root, 'elsewhere.nbt');
    fs.writeFileSync(out, 'NBT');
    expect(() => h.sc.requestImport(out)).toThrow(/import refused: .* is outside those folders/);
    expect(() => h.sc.requestImport('relative.nbt')).toThrow(/not an absolute path/);
    expect(h.sc.variants.list()).toHaveLength(0);
  });
});

describe('restart and the wire', () => {
  it('unfinished variant jobs are picked up again on start', async () => {
    const { h, designer } = harness();
    try {
      installEntry(h.sc, 'gen_lakeside_cabin');
      // queued before a "crash": the runner never ran it
      const v = h.sc.variants.create({ kind: 'variant', from: 'gen_lakeside_cabin', palette: 'dark' });
      h.sc.variants.update(v.id, { status: 'building', step: 'building' });
      h.store.flush();
      const store2 = new Store(h.sc.config.dataDir, { debounceMs: 5 });
      const sc2 = new Sidecar(h.sc.config, store2, memoryLogger());
      await sc2.start(new SimDesigner(sc2, 5));
      await until(() => sc2.variants.get(v.id)!.status === 'done', 20_000);
      expect(sc2.variants.get(v.id)!.blueprintId).toBe('gen_lakeside_cabin_dark');
      await sc2.close();
    } finally {
      await h.close();
    }
  });

  it('variant.request and import.request over the WebSocket: acks, upserts, snapshot.variants', async () => {
    const { h, designer } = harness();
    const token = 'tok-0123456789';
    const server = new SidecarServer(h.sc, { host: '127.0.0.1', port: 0, token, validateOutbound: true, log: memoryLogger() });
    await server.start();
    await h.sc.start(designer);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const msgs: SM[] = [];
    ws.on('message', (d) => {
      const p = ServerMessage.safeParse(JSON.parse(d.toString()));
      if (!p.success) throw new Error(`bad server message ${d.toString()}`);
      msgs.push(p.data);
    });
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    const send = (o: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, ...o }));
    try {
      send({ type: 'hello', token });
      await until(() => msgs.some((m) => m.type === 'snapshot'));
      expect(msgs.find((m) => m.type === 'snapshot')).toMatchObject({ variants: [] });
      installEntry(h.sc, 'gen_lakeside_cabin');
      fs.mkdirSync(path.join(h.game, 'architect', 'imports'), { recursive: true });
      fs.writeFileSync(path.join(h.game, 'architect', 'imports', 'shed.nbt'), 'NBT');
      send({ type: 'variant.request', id: 'r1', from: 'gen_lakeside_cabin', palette: 'birch' });
      send({ type: 'variant.request', id: 'r2', from: 'gen_lakeside_cabin', values: { floors: 2 } });
      send({ type: 'import.request', id: 'r3', path: path.join(h.game, 'architect', 'imports', 'shed.nbt') });
      send({ type: 'import.request', id: 'r4', path: '/etc/passwd.nbt' });
      send({ type: 'variant.request', id: 'r5', from: 'Bad Id' });
      await until(() => ['r1', 'r2', 'r3', 'r4', 'r5'].every((r) => msgs.some((m) => m.type === 'ack' && m.re === r)));
      const ack = (r: string) => msgs.find((m) => m.type === 'ack' && m.re === r) as Extract<SM, { type: 'ack' }>;
      expect(ack('r1')).toMatchObject({ ok: true, result: { variantId: 'v1' } });
      expect(ack('r2')).toMatchObject({ ok: true, result: { variantId: 'v2' } });
      expect(ack('r3')).toMatchObject({ ok: true, result: { variantId: 'v3' } });
      expect(ack('r4')).toMatchObject({ ok: false });
      expect(ack('r4').error).toMatch(/import refused/);
      expect(ack('r5')).toMatchObject({ ok: false });
      await until(() => ['v1', 'v2', 'v3'].every((id) => msgs.some((m) => m.type === 'variant.upsert' && m.variant.id === id && m.variant.status === 'done')), 20_000);
      const ups = msgs.filter((m): m is Extract<SM, { type: 'variant.upsert' }> => m.type === 'variant.upsert' && m.variant.id === 'v1');
      expect([...new Set(ups.map((u) => u.variant.status))]).toEqual(['queued', 'building', 'done']);
      expect(ups.at(-1)!.variant).toMatchObject({ blueprintId: 'gen_lakeside_cabin_birch', from: 'gen_lakeside_cabin', kind: 'variant' });
      // a new client's snapshot lists them
      const ws2 = new WebSocket(`ws://127.0.0.1:${server.port}`);
      const snap = await new Promise<Extract<SM, { type: 'snapshot' }>>((res, rej) => {
        ws2.once('open', () => ws2.send(JSON.stringify({ v: 1, type: 'hello', token })));
        ws2.on('message', (d) => {
          const p = ServerMessage.parse(JSON.parse(d.toString()));
          if (p.type === 'snapshot') res(p);
        });
        ws2.once('error', rej);
      });
      expect(snap.variants.map((v) => [v.id, v.kind, v.status, v.blueprintId])).toEqual([['v1', 'variant', 'done', 'gen_lakeside_cabin_birch'], ['v2', 'variant', 'done', 'gen_lakeside_cabin_v2'], ['v3', 'import', 'done', 'imp_shed']]);
      ws2.close();
    } finally {
      ws.close();
      await server.stop();
      await h.close();
    }
  });
});
