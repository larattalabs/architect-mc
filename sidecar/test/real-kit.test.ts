// The sim designer against the REAL kit (../kit), when it is there: catches drift in the kit CLI
// (exit codes, --json, file names, previews, the `export const id` line). Skipped without it.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { DesignRequest } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'build.mjs'));

describe.skipIf(!hasKit)('sim designer with the real kit', () => {
  let root: string;
  let sc: Sidecar;
  beforeAll(async () => {
    root = tempDir('arch-realkit-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    await sc.start(new SimDesigner(sc, 5));
  });
  afterAll(async () => {
    await sc.close();
    rmrf(root);
  });

  it('variants of a kit example installed in the library: a palette and a param change', async () => {
    const d = sc.requestDesign(DesignRequest.parse(request({ type: 'tower', name: 'Var Tower', maxSize: { x: 64, y: 64, z: 64 } })));
    await until(() => ['done', 'failed'].includes(sc.designs.get(d.id)!.status), 120_000);
    expect(sc.designs.get(d.id)!.status).toBe('done');
    const from = 'gen_var_tower';
    const a = sc.requestVariant(from, 'cherry');
    const b = sc.requestVariant(from, undefined, { floors: 5, roof: 'battlements' });
    const c = sc.requestVariant(from, undefined, { floors: 99 });
    await sc.variantRunner.idle();
    const read = (id: string) => JSON.parse(fs.readFileSync(path.join(sc.config.libraryDir, id, `${id}.blueprint.json`), 'utf8')) as Record<string, unknown>;
    expect(sc.variants.get(a.id)!.status, sc.variants.get(a.id)!.error).toBe('done');
    expect(read(`${from}_cherry`)).toMatchObject({ variantOf: from, palette: { preset: 'cherry', wood: 'cherry' }, values: { floors: 3, width: 7, roof: 'hip' }, displayName: 'Var Tower (cherry)', type: 'tower' });
    expect(sc.variants.get(b.id)!.status, sc.variants.get(b.id)!.error).toBe('done');
    const vb = read(`${from}_v2`);
    expect(vb).toMatchObject({ variantOf: from, palette: { preset: 'fortress' }, values: { floors: 5, roof: 'battlements' }, displayName: 'Var Tower (floors 5, roof battlements)' });
    expect((vb.size as { y: number }).y).toBe(30); // grew past the original's 25: no --max for a variant
    expect((vb.request as { name: string }).name).toBe('Var Tower');
    expect(fs.existsSync(path.join(sc.config.libraryDir, `${from}_v2`, `${from}_v2.preview-iso.png`))).toBe(true);
    expect(sc.variants.get(c.id)).toMatchObject({ status: 'failed' });
    expect(sc.variants.get(c.id)!.error).toMatch(/floors must be an integer 3\.\.6/);
  }, 150_000);

  it('imports a tiny structure-block save; a modded one fails with the list of its blocks', async () => {
    const imports = path.join(path.dirname(sc.config.libraryDir), 'imports');
    fs.mkdirSync(imports, { recursive: true });
    for (const f of ['tiny_hut.nbt', 'modded_hut.nbt']) fs.copyFileSync(path.join(SIDECAR_ROOT, 'test', 'fixtures', 'imports', f), path.join(imports, f));
    const a = sc.requestImport(path.join(imports, 'tiny_hut.nbt'));
    const b = sc.requestImport(path.join(imports, 'modded_hut.nbt'));
    await sc.variantRunner.idle();
    expect(sc.variants.get(a.id)!.status, sc.variants.get(a.id)!.error).toBe('done');
    const dir = path.join(sc.config.libraryDir, 'imp_tiny_hut');
    expect(fs.readdirSync(dir).sort()).toEqual(['imp_tiny_hut.blueprint.json', 'imp_tiny_hut.nbt', 'imp_tiny_hut.preview-front.png', 'imp_tiny_hut.preview-iso.png', 'imp_tiny_hut.preview-top.png']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'imp_tiny_hut.blueprint.json'), 'utf8'))).toMatchObject({ type: 'custom', imported: true, name: 'Tiny Hut', size: { x: 5, y: 4, z: 5 }, anchors: { entrance: { x: 2.5, z: 5.5 }, spawn: { x: 2.5, z: 7.5 } } });
    expect(sc.variants.get(b.id)!.status).toBe('failed');
    expect(sc.variants.get(b.id)!.error).toMatch(/unknown or non-vanilla blocks \(1\): create:andesite_casing x10/);
  }, 60_000);

  for (const type of ['cabin', 'tower', 'tavern', 'gatehouse', 'chapel'] as const) {
    it(`a ${type}: built, checked, rendered and installed`, async () => {
      const d = sc.requestDesign(DesignRequest.parse(request({ type, name: `Real ${type}`, maxSize: { x: 64, y: 64, z: 64 } })));
      await until(() => ['done', 'failed'].includes(sc.designs.get(d.id)!.status), 120_000);
      const done = sc.designs.get(d.id)!;
      expect(done.status, done.error).toBe('done');
      const id = `gen_real_${type}`;
      expect(done.blueprintId).toBe(id);
      const dir = path.join(sc.config.libraryDir, id);
      const files = fs.readdirSync(dir).sort();
      expect(files).toEqual(expect.arrayContaining([`${id}.blueprint.json`, `${id}.mjs`, `${id}.nbt`, `${id}.preview-front.png`, `${id}.preview-iso.png`, `${id}.preview-top.png`]));
      const scj = JSON.parse(fs.readFileSync(path.join(dir, `${id}.blueprint.json`), 'utf8')) as Record<string, unknown>;
      expect(scj).toMatchObject({ id, source: `${id}.mjs`, type: type === 'chapel' ? 'cabin' : type });
      expect(fs.readFileSync(path.join(dir, `${id}.mjs`), 'utf8')).toContain(`export const id = '${id}'`);
      expect(fs.readFileSync(path.join(dir, `${id}.preview-iso.png`)).subarray(1, 4).toString()).toBe('PNG');
    }, 150_000);
  }
});
