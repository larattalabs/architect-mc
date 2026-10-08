#!/usr/bin/env node
// node kit/tools/delta-fixtures.mjs --out <dir> [--no-previews]
//
// Phase 5b: the fixture set behind "the kit diff equals the mod's TemplateDelta" (docs/CONTRACT.md "Phase 5b gate" item 1).
// Writes, under <dir>:
//   builds/<name>/<id>.{nbt,parts.nbt,blueprint.json,mjs}   every build the pairs use (kit examples, their param and
//                                                          palette variants, the hand-written tavern versions)
//   versions/tavern/v1..v5/                               the hand-written versions (kit/test/fixtures/versions/tavern/vN),
//                                                          built with previews: what dev.entry.installVersion installs
//   pairs/<pair>/{a,b}.{nbt,parts.nbt,blueprint.json}      one folder per pair (an `approximate` pair omits a parts.nbt)
//   pairs/<pair>/expected.json                            `node kit/tools/diff.mjs a.nbt b.nbt --cells --json` (one line)
//   index.json                                           { format, kit, pairs: [{ name, a, b, kind, approximate }] }
// Deterministic: the same kit gives the same files. The pairs: every kit example (kit/designs/*.mjs) at its defaults
// against one change of each param and against two palette presets (the first two that change it); the tavern versions v1->v2 (wing_east added, porch
// removed, roof re-materialled), v2->v3 (grown west by raising origin, main's windows), v3->v4 (front changed),
// v3->v5 (shrunk), v1->v3, v1->v5, v5->v1, v2->v2 (identical), v2->v3 with the frame moved instead of origin raised (the
// frame hint), and two pairs with labels by box (approximate).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDesigns } from '../build.mjs';
import { diffFiles } from '../lib/diff.mjs';
import { rebuild } from '../lib/rebuild.mjs';
import { renderStructure } from '../render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, '..');
const VERSIONS = path.join(KIT, 'test', 'fixtures', 'versions', 'tavern');
const DIFF = path.join(HERE, 'diff.mjs');
/** palette presets tried in order; the first two that change the default build are used */
const PRESETS = ['cherry', 'fortress', 'mangrove', 'crimson', 'rustic'];

/** One change per param: an int one step (up, or down at its max), a bool flipped, an enum's next option. */
export function paramChanges(params = {}) {
  const out = [];
  for (const [k, p] of Object.entries(params)) {
    if (p.type === 'int') out.push({ [k]: p.default < p.max ? p.default + 1 : p.default - 1 });
    else if (p.type === 'bool') out.push({ [k]: !p.default });
    else if (p.type === 'enum') out.push({ [k]: p.options[(p.options.indexOf(p.default) + 1) % p.options.length] });
  }
  return out;
}

function build(outDir, name, source, blueprint = {}) {
  const dir = path.join(outDir, 'builds', name);
  fs.rmSync(dir, { recursive: true, force: true });
  const r = rebuild({ source, blueprint, out: dir, kitDir: KIT });
  if (!r.ok || r.code !== 0) throw new Error(`${name}: the build failed or did not pass the check (exit ${r.code}):\n${r.output.split('\n').slice(-6).join('\n')}`);
  fs.copyFileSync(source, path.join(dir, `${r.id}.mjs`));
  return { name, dir, id: r.id };
}

function pair(outDir, name, a, b, { kind, dropParts = [] } = {}) {
  const dir = path.join(outDir, 'pairs', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [side, x] of [['a', a], ['b', b]]) {
    fs.copyFileSync(path.join(x.dir, `${x.id}.nbt`), path.join(dir, `${side}.nbt`));
    fs.copyFileSync(path.join(x.dir, `${x.id}.blueprint.json`), path.join(dir, `${side}.blueprint.json`));
    if (!dropParts.includes(side)) fs.copyFileSync(path.join(x.dir, `${x.id}.parts.nbt`), path.join(dir, `${side}.parts.nbt`));
  }
  const r = spawnSync(process.execPath, [DIFF, path.join(dir, 'a.nbt'), path.join(dir, 'b.nbt'), '--cells', '--json'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${name}: diff.mjs exited ${r.status}: ${r.stderr}`);
  fs.writeFileSync(path.join(dir, 'expected.json'), r.stdout.trim() + '\n');
  const j = JSON.parse(r.stdout);
  return { name, a: a.name, b: b.name, kind, approximate: j.approximate, frameKept: j.frameKept, added: j.added, removed: j.removed, changed: j.changed, unchanged: j.unchanged };
}

/** Hash of the kit (lib/, build.mjs, tools/diff.mjs, the designs and the version sources): what the set was made from. */
function kitHash() {
  const h = crypto.createHash('sha256');
  const files = [
    ...fs.readdirSync(path.join(KIT, 'lib')).sort().map((f) => path.join(KIT, 'lib', f)),
    path.join(KIT, 'build.mjs'),
    DIFF,
    ...listDesigns().map((d) => path.join(KIT, 'designs', `${d}.mjs`)),
    ...[1, 2, 3, 4, 5].map((v) => path.join(VERSIONS, `v${v}`, 'tavern.mjs')),
  ];
  for (const f of files) {
    h.update(path.relative(KIT, f));
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex');
}

export async function writeFixtures(outDir, { previews = true } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const sub of ['builds', 'pairs', 'versions']) fs.rmSync(path.join(outDir, sub), { recursive: true, force: true });
  const pairs = [];
  // the kit examples against their param and palette variants
  for (const id of listDesigns()) {
    const source = path.join(KIT, 'designs', `${id}.mjs`);
    const mod = await import(path.join(KIT, 'designs', `${id}.mjs`));
    const base = build(outDir, `${id}-default`, source);
    for (const values of paramChanges(mod.params)) {
      const [k, v] = Object.entries(values)[0];
      const b = build(outDir, `${id}-${k}-${v}`, source, { values });
      pairs.push(pair(outDir, `${id}-default__${id}-${k}-${v}`, base, b, { kind: 'param' }));
    }
    let palettes = 0;
    for (const preset of PRESETS) {
      if (palettes >= 2) break;
      const b = build(outDir, `${id}-${preset}`, source, { palette: preset });
      const d = diffFiles(path.join(base.dir, `${id}.nbt`), path.join(b.dir, `${id}.nbt`));
      // the design's own default palette changes nothing: not a palette variant
      if (d.added + d.removed + d.changed === 0) {
        fs.rmSync(b.dir, { recursive: true, force: true });
        continue;
      }
      pairs.push(pair(outDir, `${id}-default__${id}-${preset}`, base, b, { kind: 'palette' }));
      palettes++;
    }
  }
  // the hand-written tavern versions
  const v = {};
  for (const n of [1, 2, 3, 4, 5]) {
    v[n] = build(outDir, `tavern-v${n}`, path.join(VERSIONS, `v${n}`, 'tavern.mjs'));
    const dst = path.join(outDir, 'versions', 'tavern', `v${n}`);
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(v[n].dir)) fs.copyFileSync(path.join(v[n].dir, f), path.join(dst, f));
    if (previews) renderStructure(path.join(dst, 'tavern.nbt'), { out: dst });
  }
  // v3 with its coordinates moved instead of origin raised (the designer's mistake the frame hint names): the same cells,
  // but the JSON keeps v2's origin, so its design coordinates are off by the 5 the origin should have moved
  const moved = path.join(outDir, 'builds', 'tavern-v3moved');
  fs.rmSync(moved, { recursive: true, force: true });
  fs.cpSync(v[3].dir, moved, { recursive: true });
  const mj = JSON.parse(fs.readFileSync(path.join(moved, 'tavern.blueprint.json'), 'utf8'));
  mj.frame = { origin: [1, 0, 1] };
  fs.writeFileSync(path.join(moved, 'tavern.blueprint.json'), `${JSON.stringify(mj, null, 2)}\n`);
  const v3moved = { name: 'tavern-v3moved', dir: moved, id: 'tavern' };
  const chain = [
    [1, 2, 'version'],
    [2, 3, 'version'],
    [3, 4, 'version'],
    [3, 5, 'version'],
    [1, 3, 'version'],
    [1, 5, 'version'],
    [5, 1, 'version'],
    [2, 2, 'identical'],
  ];
  for (const [a, b, kind] of chain) pairs.push(pair(outDir, `tavern-v${a}__tavern-v${b}`, v[a], v[b], { kind }));
  pairs.push(pair(outDir, 'tavern-v2__tavern-v3moved', v[2], v3moved, { kind: 'frame_hint' }));
  pairs.push(pair(outDir, 'approx-a__tavern-v1__tavern-v2', v[1], v[2], { kind: 'approximate', dropParts: ['a'] }));
  pairs.push(pair(outDir, 'approx-ab__tavern-v2__tavern-v5', v[2], v[5], { kind: 'approximate', dropParts: ['a', 'b'] }));
  const index = { format: 1, kit: kitHash(), command: 'node kit/tools/diff.mjs a.nbt b.nbt --cells --json', pairs };
  fs.writeFileSync(path.join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  if (i < 0 || !argv[i + 1]) {
    console.error('usage: node kit/tools/delta-fixtures.mjs --out <dir> [--no-previews]');
    process.exit(2);
  }
  const out = path.resolve(argv[i + 1]);
  const index = await writeFixtures(out, { previews: !argv.includes('--no-previews') });
  console.log(`${index.pairs.length} pairs in ${out} (kit ${index.kit.slice(0, 12)})`);
}
