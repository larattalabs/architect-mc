// The file side of design jobs: naming, the pristine-kit check in a minimal environment, previews,
// the never-overwrite install into the library, and the request schema.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDesign, designBaseId, freeLibraryId, installDesign, minimalEnv, parseBuildJson, refreshKit, renderPreviews, slugify, withDesignId } from '../src/designs.js';
import { DesignRequest, parseClientMessage } from '../src/protocol.js';
import { prepareScratch } from '../src/scratch.js';
import { copyKit, request, rmrf, tempDir } from './helpers.js';

const req = (over: Record<string, unknown> = {}) => DesignRequest.parse(request(over));

describe('naming', () => {
  it('slugs names and builds gen_ ids', () => {
    expect(slugify('Lakeside Cabin!')).toBe('lakeside_cabin');
    expect(slugify('Château  d’Été')).toBe('chateau_d_ete');
    expect(designBaseId(req())).toBe('gen_lakeside_cabin');
    expect(designBaseId(req({ name: undefined }))).toBe('gen_rustic_cabin');
    expect(designBaseId(req({ name: undefined, type: 'custom', style: 'Elven' }))).toBe('gen_elven_building');
    expect(designBaseId(req({ name: '!!!', style: 'tower', type: 'tower' }))).toBe('gen_tower');
  });

  it('picks the first free library id', () => {
    const lib = tempDir();
    try {
      expect(freeLibraryId(lib, 'gen_x')).toBe('gen_x');
      fs.mkdirSync(path.join(lib, 'gen_x'));
      expect(freeLibraryId(lib, 'gen_x')).toBe('gen_x_2');
      expect(freeLibraryId(lib, 'gen_x', new Set(['gen_x_2']))).toBe('gen_x_3');
    } finally {
      rmrf(lib);
    }
  });

  it('rewrites a design module id', () => {
    expect(withDesignId("import x from '../lib/kit.mjs';\nexport const id = 'cabin';\n", 'gen_a')).toContain("export const id = 'gen_a'");
    expect(withDesignId('export const id="cabin"', 'gen_b')).toBe("export const id = 'gen_b'");
  });

  it('reads the kit --json line, tolerating other output', () => {
    expect(parseBuildJson('building...\n{"ok":false,"errors":["no door"],"warnings":[{"rule":"x"}],"nbt":"a","sidecar":{"id":"b"}}\n')).toEqual({ ok: false, errors: ['no door'], warnings: ['{"rule":"x"}'] });
    expect(parseBuildJson('check: OK')).toBeUndefined();
  });
});

describe('the request schema', () => {
  it('accepts free style text and unknown features, refuses bad sizes and types', () => {
    expect(DesignRequest.safeParse(request({ style: 'elven treehouse', features: ['porch', 'hot_tub'] })).success).toBe(true);
    expect(DesignRequest.safeParse(request({ type: 'castle' })).success).toBe(false);
    expect(DesignRequest.safeParse(request({ maxSize: { x: 6, y: 20, z: 20 } })).success).toBe(false);
    expect(DesignRequest.safeParse(request({ maxSize: { x: 97, y: 20, z: 20 } })).success).toBe(false);
    expect(DesignRequest.safeParse(request({ features: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).success).toBe(false);
    expect(DesignRequest.safeParse(request({ features: ['porch', 'porch'] })).success).toBe(false);
    expect(DesignRequest.safeParse(request({ style: 'x'.repeat(41) })).success).toBe(false);
    expect(DesignRequest.safeParse(request({ plot: { dx: 20, dz: 16, height: 24, front: 'east' } })).success).toBe(true);
  });

  it('never echoes values in a parse error (an auth.set carries a key)', () => {
    const r = parseClientMessage({ v: 1, type: 'auth.set', id: 'a1', apiKey: 'sk-ant-SENTINEL'.repeat(50) });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('SENTINEL');
  });
});

describe('the kit pipeline (fixture kit)', () => {
  let root: string;
  let kit: string;
  let scratch: string;
  beforeAll(() => {
    root = tempDir();
    kit = copyKit(root);
    scratch = path.join(root, 'scratch');
    fs.mkdirSync(scratch);
  });
  afterAll(() => rmrf(root));

  const writeDesign = (bp: string, body: string) => {
    fs.mkdirSync(path.join(scratch, 'kit', 'designs'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'kit', 'designs', `${bp}.mjs`), `import { blueprint } from '../lib/kit.mjs';\nexport const id = '${bp}';\nexport default () => blueprint(${body});\n`);
  };

  it('checks with a pristine kit in a minimal environment, with the node running us first on PATH', async () => {
    refreshKit(kit, scratch);
    writeDesign('gen_a', "{ id: 'gen_a', type: 'cabin', size: { x: 9, y: 7, z: 9 } }");
    // tampering with the agent's copy of the kit does not help: the check uses a fresh copy
    fs.writeFileSync(path.join(scratch, 'kit', 'build.mjs'), 'process.exit(0);\n');
    process.env.ANTHROPIC_API_KEY_TEST_SENTINEL = 'x';
    const r = await checkDesign(kit, scratch, 'gen_a', { maxSize: { x: 10, y: 10, z: 10 }, type: 'cabin' });
    delete process.env.ANTHROPIC_API_KEY_TEST_SENTINEL;
    expect(r.ok, r.problem).toBe(true);
    expect(r.sidecar).toMatchObject({ id: 'gen_a', type: 'cabin', size: { x: 9, y: 7, z: 9 } });
    const env = JSON.parse(fs.readFileSync(path.join(scratch, 'check', 'env.json'), 'utf8')) as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY_TEST_SENTINEL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.keys(env).filter((k) => !['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TMP', 'TEMP', 'USERPROFILE', 'SystemRoot', 'windir', 'Path'].includes(k) && !k.startsWith('__CF') && k !== 'PWD' && k !== 'SHLVL' && k !== '_' && k !== 'OLDPWD')).toEqual([]);
    expect(env.PATH!.split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
    expect(minimalEnv({ PATH: '/usr/bin', SECRET: 's' })).toEqual({ PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin` });
  });

  it('reports size, type, checker and thrown-design failures', async () => {
    writeDesign('gen_big', "{ id: 'gen_big', type: 'cabin', size: { x: 30, y: 7, z: 9 } }");
    let r = await checkDesign(kit, scratch, 'gen_big', { maxSize: { x: 10, y: 10, z: 10 }, type: 'cabin' });
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/checker refused[\s\S]*exceeds --max/);
    writeDesign('gen_t', "{ id: 'gen_t', type: 'barn', size: { x: 9, y: 7, z: 9 } }");
    r = await checkDesign(kit, scratch, 'gen_t', { maxSize: { x: 10, y: 10, z: 10 }, type: 'cabin' });
    expect(r.problem).toMatch(/type is barn/);
    fs.writeFileSync(path.join(scratch, 'kit', 'designs', 'gen_throw.mjs'), "export const id = 'gen_throw';\nexport default () => { throw new Error('boom'); };\n");
    r = await checkDesign(kit, scratch, 'gen_throw', { maxSize: { x: 10, y: 10, z: 10 } });
    expect(r.problem).toMatch(/design threw[\s\S]*boom/);
    r = await checkDesign(kit, scratch, 'gen_missing', { maxSize: { x: 10, y: 10, z: 10 } });
    expect(r.problem).toBe('there is no kit/designs/gen_missing.mjs');
  });

  it('renders previews with the kit renderer', async () => {
    writeDesign('gen_r', "{ id: 'gen_r', type: 'cabin', size: { x: 9, y: 7, z: 9 } }");
    const c = await checkDesign(kit, scratch, 'gen_r', { maxSize: { x: 10, y: 10, z: 10 } });
    const r = await renderPreviews(scratch, c.nbt!);
    expect(r.files.map((f) => path.basename(f))).toEqual(['gen_r.preview-front.png', 'gen_r.preview-iso.png', 'gen_r.preview-top.png']);
  });

  it('installs as <library>/<id>/ and never overwrites', async () => {
    const lib = path.join(root, 'library');
    fs.mkdirSync(path.join(lib, 'gen_lakeside_cabin'), { recursive: true });
    fs.writeFileSync(path.join(lib, 'gen_lakeside_cabin', 'gen_lakeside_cabin.nbt'), 'an older one');
    writeDesign('gen_lakeside_cabin_2', "{ id: 'gen_lakeside_cabin_2', type: 'cabin', size: { x: 9, y: 7, z: 9 } }");
    const c = await checkDesign(kit, scratch, 'gen_lakeside_cabin_2', { maxSize: { x: 10, y: 10, z: 10 } });
    const p = await renderPreviews(scratch, c.nbt!);
    const r = req();
    const install = () =>
      installDesign({ library: lib, baseId: 'gen_lakeside_cabin', nbt: c.nbt!, sidecar: c.sidecar!, source: path.join(scratch, 'kit', 'designs', 'gen_lakeside_cabin_2.mjs'), previews: p.files, meta: { name: 'Lakeside Cabin', request: r, createdAt: 1234 } });
    const a = install();
    const b = install();
    expect(a.blueprintId).toBe('gen_lakeside_cabin_2');
    expect(b.blueprintId).toBe('gen_lakeside_cabin_3');
    expect(fs.readFileSync(path.join(lib, 'gen_lakeside_cabin', 'gen_lakeside_cabin.nbt'), 'utf8')).toBe('an older one');
    expect(fs.readdirSync(b.dir).sort()).toEqual(['gen_lakeside_cabin_3.blueprint.json', 'gen_lakeside_cabin_3.mjs', 'gen_lakeside_cabin_3.nbt', 'gen_lakeside_cabin_3.preview-front.png', 'gen_lakeside_cabin_3.preview-iso.png', 'gen_lakeside_cabin_3.preview-top.png']);
    const sc = JSON.parse(fs.readFileSync(b.json, 'utf8')) as Record<string, unknown>;
    expect(sc).toMatchObject({ id: 'gen_lakeside_cabin_3', name: 'Lakeside Cabin', type: 'cabin', source: 'gen_lakeside_cabin_3.mjs', createdAt: 1234, request: r });
    expect(fs.readFileSync(b.source!, 'utf8')).toContain("export const id = 'gen_lakeside_cabin_3'");
  });

  it('prepares a scratch dir: kit copy, BRIEF.md, CONTRACT.md, remix source', () => {
    const data = path.join(root, 'data');
    const lib = path.join(root, 'library2');
    fs.mkdirSync(path.join(lib, 'gen_old'), { recursive: true });
    fs.writeFileSync(path.join(lib, 'gen_old', 'gen_old.mjs'), "export const id = 'gen_old';");
    const now = Date.now();
    const d = { id: 'd7', request: req({ remix: 'gen_old', type: 'tower', plot: { dx: 12, dz: 12, height: 30, front: 'east' } }), status: 'queued' as const, step: '', createdAt: now, updatedAt: now };
    const s = prepareScratch({ dataDir: data, kitDir: kit, libraryDir: lib, design: d, bp: 'gen_new' });
    expect(s).toBe(path.join(data, 'designs', 'd7'));
    expect(fs.existsSync(path.join(s, 'kit', 'build.mjs'))).toBe(true);
    expect(fs.readFileSync(path.join(s, 'remix', 'gen_old.mjs'), 'utf8')).toContain('gen_old');
    const brief = fs.readFileSync(path.join(s, 'BRIEF.md'), 'utf8');
    expect(brief).toContain('kit/designs/gen_new.mjs');
    expect(brief).toContain('type: `tower`');
    expect(brief).toContain('height >= 2 x the smaller footprint side');
    expect(brief).toContain('`kit/designs/tower.mjs`');
    expect(brief).toContain('remix/gen_old.mjs');
    expect(brief).toContain('a marked plot of 12 x 12 blocks');
    expect(brief).toContain('--max 40,20,40 --type tower');
    expect(fs.readFileSync(path.join(s, 'CONTRACT.md'), 'utf8')).toContain('## Checker profiles');
  });
});
