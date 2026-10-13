// Slice 6c PT2 (docs/CONTRACT.md "Phase 6c slice PT2" §3, §5, §6) with the sim backend and the REAL kit: an adopted entry (a captured
// source, kit/lib/adopt.mjs, as the mod writes it) gets "add a floor" by versionOf (the sim bumps its `floors` param 0 -> 1): v2 installs
// by design, checked as a captured source (its own empty profile, the type adopted), and stays adopted (the `adopted` key carried, the
// sourceKind captured); polish of it is refused adopted_polish.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { DesignRequest } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner, simRedirect } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'lib', 'adopt.mjs'));
const ID = 'adopted_1a2b3c4d';

/** A 5 x 4 x 5 log hut with its door in the north wall, as Adopt.java captures it (template coordinates, runs along x). */
function capture() {
  const palette = ['minecraft:oak_log[axis=y]', 'minecraft:air', 'minecraft:oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]',
    'minecraft:oak_door[facing=south,half=upper,hinge=left,open=false,powered=false]'];
  const runs: number[] = [];
  for (let y = 0; y < 4; y++) {
    for (let z = 0; z < 5; z++) {
      if (y === 3 || z === 4) runs.push(y, z, 0, 4, 0);
      else if (z === 0 && y < 2) runs.push(y, 0, 0, 1, 0, y, 0, 2, 2, 2 + y, y, 0, 3, 4, 0);
      else if (z === 0) runs.push(y, 0, 0, 4, 0);
      else runs.push(y, z, 0, 0, 0, y, z, 4, 4, 0);
    }
  }
  return { format: 1, build: 'build-3', name: 'Adopted house build-3', description: 'Captured from the player\'s build build-3 (house)', size: [5, 4, 5], groundY: 0,
    front: 'north', frameGuessed: false, palette, runs, nbt: {}, wall: 'minecraft:oak_log[axis=y]', anchors: {} };
}

/** The source Adopt.source() writes. */
const source = (cap: unknown) => `// Captured by Architect (6c slice PT2): the player's build build-3, adopted as ${ID}.\nimport { adopted } from '../lib/adopt.mjs';\n\n`
  + `export const id = '${ID}';\nexport const params = {\n  floors: { type: 'int', min: 0, max: 4, default: 0, label: 'Storeys added on top' },\n};\n\n`
  + `export const CAPTURE = ${JSON.stringify(cap)};\n\nexport default function build({ floors = 0 } = {}) {\n  return adopted(id, CAPTURE, { floors });\n}\n`;

async function adoptedEntry(library: string): Promise<void> {
  const dir = path.join(library, ID);
  fs.mkdirSync(dir, { recursive: true });
  const src = source(capture());
  // build v1 with the kit (as the mod's capture writes it: the same cells), then the mod's marker
  const scratch = tempDir('arch-pt2-src-');
  fs.mkdirSync(path.join(scratch, 'designs'));
  fs.symlinkSync(path.join(KIT, 'lib'), path.join(scratch, 'lib'));
  fs.writeFileSync(path.join(scratch, 'designs', `${ID}.mjs`), src);
  const mod = await import(pathToFileURL(path.join(scratch, 'designs', `${ID}.mjs`)).href);
  const { writeBlueprint } = await import(pathToFileURL(path.join(KIT, 'lib', 'write.mjs')).href);
  writeBlueprint(mod.default({}), dir);
  fs.writeFileSync(path.join(dir, `${ID}.mjs`), src);
  const jf = path.join(dir, `${ID}.blueprint.json`);
  const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
  j.adopted = { build: 'build-3', at: 1, cells: 100, frameGuessed: false };
  fs.writeFileSync(jf, `${JSON.stringify(j, null, 2)}\n`);
  rmrf(scratch);
}

describe.skipIf(!hasKit)('an adopted entry (sim backend, real kit)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('the sim bumps the captured source\'s floors param: "add a floor"', () => {
    const r = simRedirect(source(capture()));
    expect(r.change).toBe('floors 0 -> 1');
    expect(r.source).toContain('floors: { type: \'int\', min: 0, max: 4, default: 1');
  });

  it('versionOf "add a floor" installs v2 by design, still adopted and captured; polish is refused adopted_polish', async () => {
    const root = tempDir('arch-pt2-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    cfg.simStepMs = 15;
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    await adoptedEntry(cfg.libraryDir);
    const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    await sc.start(new SimDesigner(sc, cfg.simStepMs));
    close = async () => { await sc.close(); rmrf(root); };
    const d = sc.requestDesign(DesignRequest.parse(request({ type: 'adopted', notes: 'add a floor', maxSize: { x: 16, y: 20, z: 16 }, versionOf: { entryId: ID, siteId: 's1' } })));
    await until(() => ['done', 'failed', 'cancelled'].includes(sc.designs.get(d.id)!.status), 60_000);
    const done = sc.designs.get(d.id)!;
    expect(done.status, done.error).toBe('done');
    const j = JSON.parse(fs.readFileSync(path.join(cfg.libraryDir, ID, `${ID}.blueprint.json`), 'utf8')) as Record<string, unknown>;
    expect(j.version).toBe(2);
    expect(j.adopted).toMatchObject({ build: 'build-3' });
    expect(j.sourceKind).toBe('captured');
    expect(j.type).toBe('adopted');
    expect((j.size as { y: number }).y).toBe(9);
    expect((j.versions as Array<Record<string, unknown>>).at(-1)).toMatchObject({ n: 2, by: 'design', parent: 1 });
    let detail: string | undefined;
    try {
      sc.polishes.request(ID, { steps: 1 } as never);
    } catch (e) {
      detail = (e as { detail?: string }).detail;
    }
    expect(detail).toBe('adopted_polish');
  });

  // C35: Steward's stub e2e sent the settlement's bible with the change (withBible); the kit threw "ignores the palette it is given".
  // A captured source opts out: v2 installs with the captured cells as they were, the bible is not recorded as the entry's, and the
  // design's notes say it was ignored.
  it('C35: versionOf "add a floor" with a bible installs v2; the bible is ignored and noted', async () => {
    const root = tempDir('arch-pt2-c35-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    cfg.simStepMs = 15;
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    await adoptedEntry(cfg.libraryDir);
    const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    await sc.start(new SimDesigner(sc, cfg.simStepMs));
    close = async () => { await sc.close(); rmrf(root); };
    const d = sc.requestDesign(DesignRequest.parse(request({ type: 'adopted', notes: 'add a floor', bible: 'birch', maxSize: { x: 16, y: 20, z: 16 }, versionOf: { entryId: ID, siteId: 's1' } })));
    await until(() => ['done', 'failed', 'cancelled'].includes(sc.designs.get(d.id)!.status), 60_000);
    const done = sc.designs.get(d.id)!;
    expect(done.status, done.error).toBe('done');
    expect(done.step).toMatch(/the bible birch v\d+ was ignored: a captured source keeps the player's blocks as built/);
    const j = JSON.parse(fs.readFileSync(path.join(cfg.libraryDir, ID, `${ID}.blueprint.json`), 'utf8')) as Record<string, unknown>;
    expect(j.version).toBe(2);
    expect(j.sourceKind).toBe('captured');
    expect(j.adopted).toMatchObject({ build: 'build-3' });
    expect((j.size as { y: number }).y).toBe(9);
    expect(j.bible).toBeUndefined();
    expect(j.palette).toBeUndefined();
    expect(j.paletteIgnored).toMatchObject({ bible: { id: 'birch' } });
  });
});
