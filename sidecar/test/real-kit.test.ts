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
