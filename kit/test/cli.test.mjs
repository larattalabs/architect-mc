// The kit CLI (docs/CONTRACT.md "Kit CLI"): build.mjs output, --json, --max, --type, exit codes; render.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodePng } from '../lib/png.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-kit-'));
const run = (script, args) => spawnSync(process.execPath, [path.join(KIT, script), ...args], { encoding: 'utf8' });

for (const id of ['cabin', 'tower', 'tavern', 'gatehouse']) {
  test(`build ${id}: check OK with no warnings`, () => {
    const r = run('build.mjs', [id, '--out', tmp]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^check: OK$/m);
    assert.doesNotMatch(r.stdout, /^(warning|error):/m);
  });
}

test('build --json prints one JSON line', () => {
  const r = run('build.mjs', ['cabin', '--out', tmp, '--json']);
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const j = JSON.parse(lines[0]);
  assert.equal(j.ok, true);
  assert.deepEqual(j.errors, []);
  assert.deepEqual(j.warnings, []);
  assert.equal(j.nbt, path.join(tmp, 'cabin.nbt'));
  assert.equal(j.sidecar, path.join(tmp, 'cabin.blueprint.json'));
  const sc = JSON.parse(fs.readFileSync(j.sidecar, 'utf8'));
  for (const f of ['id', 'name', 'description', 'type', 'tags', 'size', 'groundY', 'front', 'materials', 'foundationBlock', 'approach', 'interior', 'anchors', 'source']) assert.ok(f in sc, f);
  assert.equal(sc.type, 'cabin');
  assert.equal(sc.source, 'cabin.mjs');
  assert.ok(sc.anchors.entrance && sc.anchors.spawn);
});

test('build --max too small fails the check (exit 1)', () => {
  const r = run('build.mjs', ['cabin', '--out', tmp, '--max', '5,5,5']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^error: size 11x12x12 exceeds the limit 5x5x5/m);
  assert.match(r.stdout, /^check: FAILED$/m);
  const j = JSON.parse(run('build.mjs', ['cabin', '--out', tmp, '--max', '5,5,5', '--json']).stdout);
  assert.equal(j.ok, false);
});

test('build --type mismatch fails the check (exit 1)', () => {
  const r = run('build.mjs', ['cabin', '--out', tmp, '--type', 'tower']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /asked for 'tower'/);
});

test('build: bad usage and unknown designs exit 2', () => {
  assert.equal(run('build.mjs', []).status, 2);
  assert.equal(run('build.mjs', ['cabin', '--max', 'big']).status, 2);
  assert.equal(run('build.mjs', ['cabin', '--type', 'castle']).status, 2);
  assert.equal(run('build.mjs', ['cabin', '--frobnicate']).status, 2);
  const r = run('build.mjs', ['no_such_design', '--json']);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).ok, false);
});

test('render writes the three previews', () => {
  run('build.mjs', ['tower', '--out', tmp]);
  const r = run('render.mjs', [path.join(tmp, 'tower.nbt'), '--out', tmp]);
  assert.equal(r.status, 0, r.stderr);
  for (const v of ['iso', 'top', 'front']) {
    const img = decodePng(fs.readFileSync(path.join(tmp, `tower.preview-${v}.png`)));
    assert.ok(img.width > 100 && img.height > 100, v);
  }
  assert.equal(run('render.mjs', []).status, 2);
  assert.equal(run('render.mjs', [path.join(tmp, 'missing.nbt')]).status, 1);
});
