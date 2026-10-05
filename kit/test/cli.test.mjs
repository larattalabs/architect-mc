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
  assert.equal(run('build.mjs', ['cabin', '--type', 'Castle!']).status, 2);
  assert.equal(run('build.mjs', ['cabin', '--frobnicate']).status, 2);
  const r = run('build.mjs', ['no_such_design', '--json']);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).ok, false);
});

test('build --json keeps stdout to one line when the design logs', () => {
  const file = path.join(KIT, 'designs', 'zzlogtest.mjs');
  fs.writeFileSync(file, `import build0 from './cabin.mjs';
console.log('top-level chatter');
export const id = 'zzlogtest';
export default function build() { console.log('design chatter'); console.info('more'); const bp = build0(); bp.id = id; return bp; }
`);
  try {
    const r = run('build.mjs', ['zzlogtest', '--out', tmp, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, r.stdout);
    assert.equal(JSON.parse(lines[0]).ok, true);
    assert.match(r.stderr, /design chatter/);
  } finally {
    fs.rmSync(file, { force: true });
  }
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

// ---------------------------------------------------------------- phase 2: variants from the CLI

test('build --palette / --values: a variant, recorded in the sidecar', () => {
  const r = run('build.mjs', ['tower', '--out', tmp, '--palette', 'cherry', '--values', '{"floors":4,"roof":"battlements"}', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const sc = JSON.parse(fs.readFileSync(JSON.parse(r.stdout).sidecar, 'utf8'));
  assert.equal(sc.palette.preset, 'cherry');
  assert.deepEqual(sc.values, { floors: 4, width: 7, roof: 'battlements' });
  assert.deepEqual(Object.keys(sc.params), ['floors', 'width', 'roof']);
  assert.ok(sc.materials.includes('minecraft:polished_tuff'));
  const j = run('build.mjs', ['cabin', '--out', tmp, '--palette', '{"preset":"oak","wood":"birch"}', '--json']);
  assert.equal(j.status, 0, j.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'cabin.blueprint.json'), 'utf8')).palette, { preset: 'oak', wood: 'birch', stone: 'stone_bricks', roof: 'spruce', accent: 'spruce' });
});

test('build: a bad palette or bad values is bad usage (exit 2), still one JSON line', () => {
  for (const args of [['--palette', 'nope'], ['--palette', '{"wood":"plastic"}'], ['--palette', '{"wall":"minecraft:stone"}'], ['--palette', '{bad json'], ['--values', '{"floors":99}'], ['--values', '{"towers":1}'], ['--values', '[1]'], ['--values', 'nope']]) {
    const r = run('build.mjs', ['tower', '--out', tmp, ...args, '--json']);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, r.stdout);
    const j = JSON.parse(lines[0]);
    assert.equal(j.ok, false);
    assert.ok(j.errors[0] && !/threw/.test(j.errors[0]), j.errors[0]);
  }
});

test('build never writes favorite/userTags/displayName, and a rebuild keeps them', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-kit-user-'));
  assert.equal(run('build.mjs', ['cabin', '--out', out]).status, 0);
  const file = path.join(out, 'cabin.blueprint.json');
  const sc = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['favorite', 'userTags', 'displayName']) assert.ok(!(k in sc), k);
  fs.writeFileSync(file, JSON.stringify({ ...sc, favorite: true, userTags: ['mine'], displayName: 'My Cabin' }));
  assert.equal(run('build.mjs', ['cabin', '--out', out, '--values', '{"porch":false}']).status, 0);
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(again.favorite, true);
  assert.deepEqual(again.userTags, ['mine']);
  assert.equal(again.displayName, 'My Cabin');
  assert.equal(again.values.porch, false);
});

test('describe prints params, defaults, the default palette, the presets and the choices', () => {
  const r = run('tools/describe.mjs', ['cabin']);
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(d.params), ['width', 'depth', 'porch']);
  assert.deepEqual(d.values, { width: 9, depth: 7, porch: true });
  assert.equal(d.palette.preset, 'rustic');
  assert.ok(d.palettes.length >= 10 && d.palettes.every((p) => p.name && p.wood && p.stone && p.roof && p.accent));
  assert.ok(d.choices.woods.includes('cherry') && d.choices.stones.includes('mud_bricks') && d.choices.roofs.includes('deepslate_tiles'));
  assert.equal(JSON.parse(run('tools/describe.mjs', ['--palettes']).stdout).palettes.length, d.palettes.length);
  const bad = run('tools/describe.mjs', ['no_such_design']);
  assert.equal(bad.status, 2);
  assert.match(JSON.parse(bad.stdout).error, /no design/);
});

test('check.mjs checks a template + sidecar pair without a source', () => {
  assert.equal(run('build.mjs', ['gatehouse', '--out', tmp]).status, 0);
  const nbt = path.join(tmp, 'gatehouse.nbt');
  const json = path.join(tmp, 'gatehouse.blueprint.json');
  const ok = run('check.mjs', [nbt, json, '--json']);
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(JSON.parse(ok.stdout).ok, true);
  const small = run('check.mjs', [nbt, json, '--max', '5,5,5']);
  assert.equal(small.status, 1);
  assert.match(small.stdout, /^check: FAILED$/m);
  assert.equal(run('check.mjs', [nbt]).status, 2);
  assert.equal(run('check.mjs', [nbt, path.join(tmp, 'missing.json'), '--json']).status, 2);
});
