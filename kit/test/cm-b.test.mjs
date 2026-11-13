// Slice CM-b (docs/CONTRACT.md "Phase 7c" §3 row 6): a design may return a Composite (past the cap). kit/build.mjs builds it: the union
// entry, each module's hidden entry and the manifest (c.write), checked by c.check(); the size limit applies to each module, not the union.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDesign, loadDesign } from '../build.mjs';
import { Composite } from '../lib/composite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPOSITES = path.join(HERE, '..', 'designs', 'composite');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kit-cmb-'));

test('build.mjs builds a Composite return: union, modules, manifest; checks clean; the max applies per module', async () => {
  const out = tmp();
  try {
    const r = await buildDesign('castle', { dir: COMPOSITES, out, max: { x: 96, y: 64, z: 96 } });
    assert.ok(r.composite instanceof Composite);
    assert.equal(r.result.ok, true, r.result.errors.join('\n'));
    assert.deepEqual(r.bp.size, { x: 121, y: 15, z: 27 }); // the union is past the cap, and that is fine
    assert.deepEqual(r.written.composite.modules, [{ id: 'west', entryId: 'castle__west' }, { id: 'centre', entryId: 'castle__centre' }, { id: 'east', entryId: 'castle__east' }]);
    for (const f of ['castle.nbt', 'castle.blueprint.json', 'castle.composite.json', 'castle__west.nbt', 'castle__east.blueprint.json']) assert.ok(fs.existsSync(path.join(out, f)), f);
    assert.ok(JSON.parse(fs.readFileSync(path.join(out, 'castle.blueprint.json'), 'utf8')).ext['architect_mc:composite']);
    const small = await buildDesign('castle', { dir: COMPOSITES, out: tmp(), max: { x: 40, y: 64, z: 96 } });
    assert.equal(small.result.ok, false);
    assert.ok(small.result.errors.some((e) => /module 'west' is 41x15x27, over the max 40x64x96/.test(e)), small.result.errors.join('\n'));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a composite is never mirrored or site-bound', async () => {
  await assert.rejects(loadDesign('castle', { dir: COMPOSITES, mirror: true }), /never mirrored/);
});

test('the CLI prints the composite files in its --json line', () => {
  const out = tmp();
  const root = fs.realpathSync(tmp()); // (the CLI runs main only when argv[1] is its real path: /var is a symlink on macOS)
  const kit = path.join(root, 'kit');
  try {
    // the CLI builds kit/designs/<id>.mjs: the castle copied there with its imports re-rooted, as the sidecar's scratch does
    for (const d of fs.readdirSync(path.join(HERE, '..')).filter((n) => !['out', 'node_modules', 'test'].includes(n))) fs.cpSync(path.join(HERE, '..', d), path.join(kit, d), { recursive: true });
    const src = fs.readFileSync(path.join(COMPOSITES, 'castle.mjs'), 'utf8').replace(/'\.\.\/\.\.\/lib\//g, "'../lib/").replace(/export const id = 'castle'/, "export const id = 'keep'");
    fs.writeFileSync(path.join(kit, 'designs', 'keep.mjs'), src);
    const line = execFileSync('node', [path.join(kit, 'build.mjs'), 'keep', '--out', out, '--max', '96,64,96', '--json'], { encoding: 'utf8' }).trim().split('\n').pop();
    const j = JSON.parse(line);
    assert.equal(j.ok, true, j.errors.join('\n'));
    assert.equal(path.basename(j.nbt), 'keep.nbt');
    assert.deepEqual(j.composite.modules.map((m) => m.entryId), ['keep__west', 'keep__centre', 'keep__east']);
    assert.equal(path.basename(j.composite.manifest), 'keep.composite.json');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
