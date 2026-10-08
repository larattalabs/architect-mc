// Phase 5b (docs/CONTRACT.md "Phase 5b gate" item 1, kit): the frame and parts.nbt round trips, and kit/tools/diff.mjs on
// fixtures: part statuses, approximate labels, the frame hint, every scope violation (no-part cells and a removed
// out-of-scope part included) and base drift (lib/rebuild.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Blueprint, palette } from '../lib/kit.mjs';
import { parse, plain, encodeGzip } from '../lib/nbt.mjs';
import { writeBlueprint } from '../lib/write.mjs';
import { diffFiles, loadVersion, boxLabels } from '../lib/diff.mjs';
import { verifyRebuild, rebuild } from '../lib/rebuild.mjs';
import { buildDesign } from '../build.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'architect-diff-')));
const DIFF = path.join(KIT, 'tools', 'diff.mjs');
const run = (args) => spawnSync(process.execPath, [DIFF, ...args], { encoding: 'utf8' });
let seq = 0;

/**
 * A small fixture building: parts main (walls), roof (a slab layer), porch (a deck in front) by default. `edit(bp, o)`
 * runs inside, after the parts; `o` carries the options (origin, front, groundY, ...).
 */
function build(o = {}, edit) {
  const bp = new Blueprint({ id: 'fx', type: 'house', size: o.size ?? [16, 8, 16], origin: o.origin ?? [2, 0, 2], groundY: o.groundY ?? 1, front: o.front ?? 'south', palette: palette() });
  const dx = o.shift?.[0] ?? 0;
  const dy = o.shift?.[1] ?? 0;
  const dz = o.shift?.[2] ?? 0;
  bp.part('main', () => {
    for (let x = 0; x <= 6; x++) for (let z = 0; z <= 6; z++) for (let y = 0; y <= 3; y++) if (x === 0 || x === 6 || z === 0 || z === 6 || y === 0) bp.set(x + dx, y + dy, z + dz, o.wall ?? 'minecraft:stone_bricks');
  });
  if (!o.noRoof) bp.part('roof', () => { for (let x = 0; x <= 6; x++) for (let z = 0; z <= 6; z++) bp.set(x + dx, 4 + dy, z + dz, o.roof ?? 'minecraft:oak_planks'); });
  if (!o.noPorch) bp.part('porch', () => { for (let x = 2; x <= 4; x++) for (let z = 7; z <= 8; z++) bp.set(x + dx, 0 + dy, z + dz, 'minecraft:spruce_planks'); });
  if (o.loose) for (const [x, y, z] of o.loose) bp.set(x + dx, y + dy, z + dz, 'minecraft:cobblestone');
  edit?.(bp, o);
  if (o.values) bp.values = o.values;
  const dir = path.join(tmp, `v${++seq}`);
  const w = writeBlueprint(bp, dir);
  return { bp, nbt: w.nbtPath, json: w.jsonPath, parts: w.partsPath, dir };
}

// ---------------------------------------------------------------- frame and parts.nbt round trips

test('frame: the blueprint JSON always records frame.origin, and diff reads it back (design = template - origin)', () => {
  const a = build({ origin: [3, 1, 2] });
  const sc = JSON.parse(fs.readFileSync(a.json, 'utf8'));
  assert.deepEqual(sc.frame, { origin: [3, 1, 2] });
  const v = loadVersion(a.nbt);
  assert.deepEqual(v.origin, [3, 1, 2]);
  // the cell written at design (0,0,0) is at template (3,1,2)
  const s = plain(parse(fs.readFileSync(a.nbt)));
  const i = s.blocks.findIndex((b) => b.pos[0] === 3 && b.pos[1] === 1 && b.pos[2] === 2);
  assert.ok(i >= 0);
  assert.deepEqual(v.cells[i].d, [0, 0, 0]);
  // an origin of 0 is recorded too, and a JSON without frame (pre-5b) reads as [0,0,0]
  const z = build({ origin: [0, 0, 0] });
  assert.deepEqual(JSON.parse(fs.readFileSync(z.json, 'utf8')).frame, { origin: [0, 0, 0] });
  const j = JSON.parse(fs.readFileSync(a.json, 'utf8'));
  delete j.frame;
  fs.writeFileSync(a.json, JSON.stringify(j));
  assert.deepEqual(loadVersion(a.nbt).origin, [0, 0, 0]);
  assert.deepEqual(loadVersion(a.nbt, { frame: [3, 1, 2] }).origin, [3, 1, 2]);
});

test('parts.nbt: { names, idx } with one idx per raw block in file order; set() outside a part clears it; the .nbt bytes are unchanged', () => {
  const a = build({ loose: [[10, 0, 10]] }, (bp) => {
    // a part cell overwritten outside any part loses its part
    bp.set(0, 0, 0, 'minecraft:cobblestone');
  });
  const pm = plain(parse(fs.readFileSync(a.parts)));
  const s = plain(parse(fs.readFileSync(a.nbt)));
  assert.deepEqual(pm.names, ['main', 'roof', 'porch']);
  assert.equal(pm.idx.length, s.blocks.length);
  const byPos = new Map(s.blocks.map((b, i) => [b.pos.join(','), pm.idx[i]]));
  assert.equal(byPos.get('12,0,12'), -1, 'the loose cell is in no part');
  assert.equal(byPos.get('2,0,2'), -1, 'set() outside a part cleared the cell');
  assert.equal(pm.names[byPos.get('3,0,2')], 'main');
  assert.equal(pm.names[byPos.get('2,4,2')], 'roof');
  assert.equal(pm.names[byPos.get('4,0,9')], 'porch');
  // the file order is y, z, x (finalize + sort) and the map follows it
  for (let i = 1; i < s.blocks.length; i++) {
    const [p, q] = [s.blocks[i - 1].pos, s.blocks[i].pos];
    assert.ok(p[1] < q[1] || (p[1] === q[1] && (p[2] < q[2] || (p[2] === q[2] && p[0] < q[0]))));
  }
  // writing the map does not change a byte of the template
  assert.deepEqual(fs.readFileSync(a.nbt), encodeGzip(a.bp.toStructure()));
  // the exact map is used: no approximate labels
  assert.equal(loadVersion(a.nbt).exact, true);
});

test('the kit examples rebuild byte-identically with their parts.nbt next to them (the shipped examples are current)', async () => {
  for (const id of ['cabin', 'tower', 'tavern', 'gatehouse']) {
    const out = path.join(tmp, `ex-${id}`);
    const { written } = await buildDesign(id, { out });
    assert.deepEqual(fs.readFileSync(written.nbtPath), fs.readFileSync(path.join(KIT, 'examples', id, `${id}.nbt`)), id);
    assert.deepEqual(fs.readFileSync(written.partsPath), fs.readFileSync(path.join(KIT, 'examples', id, `${id}.parts.nbt`)), `${id}: kit/examples is out of date (node kit/tools/examples.mjs)`);
  }
});

// ---------------------------------------------------------------- statuses and counts

test('part statuses: ADDED, REMOVED, CHANGED, UNCHANGED, with counts and boxes in design coordinates', () => {
  const a = build();
  const b = build({ noPorch: true, roof: 'minecraft:spruce_planks' }, (bp) => {
    bp.part('wing_east', () => { for (let z = 1; z <= 5; z++) bp.set(7, 1, z, 'minecraft:stone_bricks'); });
  });
  const r = diffFiles(a.nbt, b.nbt);
  assert.equal(r.approximate, false);
  assert.equal(r.frameKept, true);
  assert.deepEqual(Object.keys(r.parts), ['main', 'porch', 'roof', 'wing_east']);
  assert.equal(r.parts.main.status, 'UNCHANGED');
  assert.equal(r.parts.porch.status, 'REMOVED');
  assert.equal(r.parts.porch.removed, 6);
  assert.equal(r.parts.porch.boxTo, null);
  assert.deepEqual(r.parts.porch.boxFrom, [2, 0, 7, 4, 0, 8]);
  assert.equal(r.parts.roof.status, 'CHANGED');
  assert.equal(r.parts.roof.changed, 49);
  assert.equal(r.parts.wing_east.status, 'ADDED');
  assert.equal(r.parts.wing_east.added, 5);
  assert.deepEqual(r.parts.wing_east.boxTo, [7, 1, 1, 7, 1, 5]);
  assert.equal(r.parts.wing_east.boxFrom, null);
  assert.deepEqual([r.added, r.removed, r.changed], [5, 6, 49]);
  assert.equal(r.unchanged, a.bp.cells.size - 6 - 49);
  assert.deepEqual(r.violations, []);
  assert.equal(r.ok, true);
});

test('a changed cell whose part changed name counts under both names; an unlabelled cell is not a part', () => {
  const a = build({ loose: [[9, 0, 9]] });
  const b = build({ loose: [[9, 0, 9]] }, (bp) => {
    // the roof's corner becomes a main cell of another block
    bp.part('main', () => bp.set(0, 4, 0, 'minecraft:stone_bricks'));
    // the loose cell changes block, still in no part
    bp.set(9, 0, 9, 'minecraft:mossy_cobblestone');
  });
  const r = diffFiles(a.nbt, b.nbt, { cells: true });
  assert.equal(r.changed, 2);
  assert.equal(r.parts.roof.changed, 1);
  assert.equal(r.parts.main.changed, 1);
  assert.equal(r.parts.main.status, 'CHANGED');
  assert.equal(Object.keys(r.parts).includes('null'), false);
  // cells: design coordinates sorted y, z, x
  assert.deepEqual(r.cells.changed, [[9, 0, 9], [0, 4, 0]]);
});

// ---------------------------------------------------------------- approximate labels

test('approximate labels: no usable parts.nbt -> by box (smallest volume, ties to the first key), marked approximate', () => {
  const a = build();
  const b = build({ roof: 'minecraft:spruce_planks' });
  fs.rmSync(b.parts);
  const r = diffFiles(a.nbt, b.nbt);
  assert.equal(r.approximate, true);
  assert.match(r.notes[0], /approximate.*B/);
  // the roof box [2,4,2..8,4,8] holds the roof cells: they are labelled roof (smaller than main's)
  assert.equal(r.parts.roof.status, 'CHANGED');
  // an idx list of the wrong length is ignored too
  const pm = plain(parse(fs.readFileSync(a.parts)));
  fs.writeFileSync(path.join(a.dir, 'short.parts.nbt'), encodeGzip({ t: 'compound', v: { names: { t: 'list', of: 'string', v: pm.names.map((n) => ({ t: 'string', v: n })) }, idx: { t: 'intArray', v: pm.idx.slice(1) } } }));
  assert.equal(diffFiles(a.nbt, a.nbt, { partsA: path.join(a.dir, 'short.parts.nbt') }).approximate, true);
  // smallest volume wins; ties go to the first in key order; outside every box = null
  const cells = [{ t: [1, 1, 1] }, { t: [5, 5, 5] }, { t: [9, 9, 9] }];
  assert.deepEqual(boxLabels(cells, { big: { box: [0, 0, 0, 6, 6, 6] }, small: { box: [1, 1, 1, 2, 2, 2] }, twin: { box: [5, 5, 5, 6, 6, 6] }, twin2: { box: [4, 4, 4, 5, 5, 5] } }), ['small', 'twin', null]);
  assert.deepEqual(boxLabels(cells, undefined), [null, null, null]);
});

// ---------------------------------------------------------------- frame

test('growing west by raising origin (design coordinates kept): no change to the existing cells, no hint', () => {
  const a = build({ origin: [2, 0, 2] });
  const b = build({ origin: [5, 0, 2], size: [19, 8, 16] }, (bp) => {
    bp.part('wing_west', () => { for (let z = 1; z <= 5; z++) bp.set(-3, 1, z, 'minecraft:stone_bricks'); });
  });
  const r = diffFiles(a.nbt, b.nbt);
  assert.equal(r.frameKept, true);
  assert.deepEqual([r.added, r.removed, r.changed], [5, 0, 0]);
  assert.equal(r.parts.wing_west.status, 'ADDED');
  assert.equal(r.frameHint, undefined);
  assert.ok(r.notes.some((n) => /origin 2,0,2 -> 5,0,2/.test(n)));
});

test('the frame hint: coordinates moved instead of raising origin -> "frame moved by v"', () => {
  const a = build({ origin: [2, 0, 2] });
  const b = build({ origin: [2, 0, 2], shift: [3, 0, -1] });
  const r = diffFiles(a.nbt, b.nbt);
  assert.deepEqual(r.frameHint, [3, 0, -1]);
  assert.ok(r.notes.includes('frame moved by 3,0,-1: set origin, keep design coordinates'));
  // a few changed cells do not trigger it
  assert.equal(diffFiles(a.nbt, build({ roof: 'minecraft:spruce_planks', noPorch: true }).nbt).frameHint, undefined);
});

test('frameKept: front and the entrance feet row (groundY - origin.y)', () => {
  const a = build();
  assert.equal(diffFiles(a.nbt, build({ front: 'north' }).nbt).frameKept, false);
  // groundY 2 with origin y 1: the same feet row (1)
  assert.equal(diffFiles(a.nbt, build({ groundY: 2, origin: [2, 1, 2] }).nbt).frameKept, true);
  const r = diffFiles(a.nbt, build({ groundY: 2 }).nbt);
  assert.equal(r.frameKept, false);
  assert.ok(r.notes.some((n) => /entrance feet row changed: 1 -> 2/.test(n)));
});

// ---------------------------------------------------------------- scope violations

const kinds = (r) => r.violations.map((v) => `${v.kind}${v.part ? `:${v.part}` : ''}`);

test('scope: a change inside the allowed part is OK; outside it is outside_scope (one per part)', () => {
  const a = build();
  const b = build({ roof: 'minecraft:spruce_planks' });
  assert.deepEqual(diffFiles(a.nbt, b.nbt, { scope: ['roof'] }).violations, []);
  const r = diffFiles(a.nbt, b.nbt, { scope: ['main'] });
  assert.deepEqual(kinds(r), ['outside_scope:roof']);
  assert.equal(r.violations[0].cells, 49);
  assert.equal(r.ok, false);
});

test('scope: changed cells in no part count as outside (they cannot dodge the rule)', () => {
  const a = build({ loose: [[9, 0, 9]] });
  const b = build({ loose: [[9, 0, 9], [10, 0, 9]] });
  const r = diffFiles(a.nbt, b.nbt, { scope: ['roof'] });
  assert.deepEqual(kinds(r), ['outside_scope']);
  assert.equal(r.violations[0].part, undefined);
  assert.equal(r.violations[0].cells, 1);
});

test('scope: a removed out-of-scope part is part_removed (and its cells outside_scope); a removed in-scope part is fine', () => {
  const a = build();
  const b = build({ noPorch: true });
  assert.deepEqual(kinds(diffFiles(a.nbt, b.nbt, { scope: ['roof'] })), ['outside_scope:porch', 'part_removed:porch']);
  assert.deepEqual(diffFiles(a.nbt, b.nbt, { scope: ['porch'] }).violations, []);
});

test('scope: new parts are allowed up to --new-parts; more drop out of the allowed set', () => {
  const a = build();
  const wings = (n) => (bp) => {
    for (let k = 0; k < n; k++) bp.part(`wing_${k}`, () => bp.set(9, 1, k, 'minecraft:stone_bricks'));
  };
  assert.deepEqual(diffFiles(a.nbt, build({}, wings(2)).nbt, { scope: ['roof'] }).violations, []);
  const r = diffFiles(a.nbt, build({}, wings(3)).nbt, { scope: ['roof'] });
  assert.deepEqual(kinds(r), ['outside_scope:wing_0', 'outside_scope:wing_1', 'outside_scope:wing_2', 'too_many_new_parts']);
  assert.deepEqual(kinds(diffFiles(a.nbt, build({}, wings(1)).nbt, { scope: ['roof'], newParts: 0 })), ['outside_scope:wing_0', 'too_many_new_parts']);
});

test('scope: frame_changed, inputs_changed, too_large, too_many_changes', () => {
  const a = build({ values: { length: 7 } });
  assert.deepEqual(kinds(diffFiles(a.nbt, build({ front: 'north', values: { length: 7 } }).nbt, { scope: ['roof'] })), ['frame_changed']);
  assert.deepEqual(kinds(diffFiles(a.nbt, build({ values: { length: 8 } }).nbt, { scope: ['roof'] })), ['inputs_changed']);
  assert.deepEqual(kinds(diffFiles(a.nbt, build({ values: { length: 7 } }).nbt, { scope: ['roof'], max: [15, 8, 16] })), ['too_large']);
  // the whole roof (49 of ~250 cells) changed: within 0.5, over 0.1
  const roof = build({ values: { length: 7 }, roof: 'minecraft:spruce_planks' });
  assert.deepEqual(diffFiles(a.nbt, roof.nbt, { scope: ['roof'] }).violations, []);
  assert.deepEqual(kinds(diffFiles(a.nbt, roof.nbt, { scope: ['roof'], maxShare: 0.1 })), ['too_many_changes']);
});

// ---------------------------------------------------------------- the CLI

test('diff.mjs CLI: --json one line, --cells, exit 0 / 1 / 2', () => {
  const a = build();
  const b = build({ roof: 'minecraft:spruce_planks' });
  const ok = run([a.nbt, b.nbt, '--json', '--cells', '--scope', 'roof']);
  assert.equal(ok.status, 0, ok.stderr);
  const lines = ok.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const j = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(j), ['ok', 'frameKept', 'approximate', 'parts', 'added', 'removed', 'changed', 'unchanged', 'notes', 'violations', 'cells']);
  assert.equal(j.cells.changed.length, 49);
  const bad = run([a.nbt, b.nbt, '--json', '--scope', 'main']);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).violations[0].kind, 'outside_scope');
  // no --scope: no violations
  assert.equal(run([a.nbt, b.nbt]).status, 0);
  assert.equal(run([a.nbt]).status, 2);
  assert.equal(run([a.nbt, path.join(tmp, 'nope.nbt'), '--json']).status, 2);
  assert.equal(run([a.nbt, b.nbt, '--frame-a', '1,2']).status, 2);
  // --parts-b / --frame-b override the files next to the .nbt
  const o = JSON.parse(run([a.nbt, b.nbt, '--json', '--frame-b', '0,0,0']).stdout);
  assert.ok(o.added > 0 && o.removed > 0);
});

// ---------------------------------------------------------------- base drift (polish: the base is rebuilt from source)

test('base drift: a rebuild from source matches the stored build; a tampered stored .nbt is a drift', () => {
  const dir = path.join(tmp, 'stored-tavern');
  const r = rebuild({ source: path.join(KIT, 'designs', 'tavern.mjs'), blueprint: { values: { length: 16, roof: 'hip' }, palette: 'cherry' }, out: dir });
  assert.equal(r.ok, true, r.output);
  fs.copyFileSync(path.join(KIT, 'designs', 'tavern.mjs'), path.join(dir, 'tavern.mjs'));
  assert.equal(verifyRebuild(dir).same, true);
  // the recorded inputs are what it is rebuilt with: the stored JSON says cherry, length 16, hip
  const sc = JSON.parse(fs.readFileSync(path.join(dir, 'tavern.blueprint.json'), 'utf8'));
  assert.deepEqual(sc.values, { length: 16, roof: 'hip', chimney: true });
  // tamper one cell: the stored template no longer equals its source
  const s = parse(fs.readFileSync(r.nbt));
  const blocks = s.v.blocks.v;
  const k = blocks.findIndex((b) => b.v.state.v !== blocks[0].v.state.v);
  blocks[k].v.state = { t: 'int', v: blocks[0].v.state.v };
  const rebuiltCopy = path.join(tmp, 'rebuilt-tavern');
  rebuild({ source: path.join(dir, 'tavern.mjs'), blueprint: sc, out: rebuiltCopy });
  fs.writeFileSync(r.nbt, encodeGzip(s));
  const v = verifyRebuild(dir);
  assert.equal(v.same, false);
  const d = diffFiles(r.nbt, path.join(rebuiltCopy, 'tavern.nbt'));
  assert.equal(d.changed, 1);
  assert.equal(d.added + d.removed, 0);
});

// ---------------------------------------------------------------- the fixture set for the Java equality test

test('delta-fixtures.mjs: the hand-written tavern versions build clean and the pair set has every kind, deterministically', async () => {
  const { writeFixtures } = await import('../tools/delta-fixtures.mjs');
  const out = path.join(tmp, 'fixtures');
  const index = await writeFixtures(out, { previews: false });
  const by = (n) => index.pairs.find((p) => p.name === n);
  assert.ok(index.pairs.length >= 25 && index.pairs.length <= 60, `${index.pairs.length} pairs`);
  for (const kind of ['param', 'palette', 'version', 'identical', 'frame_hint', 'approximate']) assert.ok(index.pairs.some((p) => p.kind === kind), kind);
  assert.ok(index.pairs.filter((p) => p.kind === 'palette').every((p) => p.changed > 0));
  // v2: wing_east added, porch removed, roof re-materialled; v3: wing_west, main's windows, nothing else; v4: the frame
  const e12 = JSON.parse(fs.readFileSync(path.join(out, 'pairs', 'tavern-v1__tavern-v2', 'expected.json'), 'utf8'));
  assert.deepEqual(Object.fromEntries(Object.entries(e12.parts).map(([n, p]) => [n, p.status])), { guest_rooms: 'UNCHANGED', main: 'UNCHANGED', porch: 'REMOVED', roof: 'CHANGED', stairs: 'UNCHANGED', taproom: 'UNCHANGED', wing_east: 'ADDED' });
  const e23 = JSON.parse(fs.readFileSync(path.join(out, 'pairs', 'tavern-v2__tavern-v3', 'expected.json'), 'utf8'));
  assert.deepEqual(Object.entries(e23.parts).filter(([, p]) => p.status !== 'UNCHANGED').map(([n, p]) => `${n}:${p.status}`), ['main:CHANGED', 'wing_west:ADDED']);
  assert.equal(e23.removed, 0);
  assert.equal(by('tavern-v3__tavern-v4').frameKept, false);
  assert.equal(by('tavern-v3__tavern-v5').removed, 260);
  assert.equal(by('tavern-v2__tavern-v2').changed + by('tavern-v2__tavern-v2').added + by('tavern-v2__tavern-v2').removed, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'pairs', 'tavern-v2__tavern-v3moved', 'expected.json'), 'utf8')).frameHint, [5, 0, 0]);
  assert.equal(by('approx-a__tavern-v1__tavern-v2').approximate, true);
  assert.equal(fs.existsSync(path.join(out, 'pairs', 'approx-a__tavern-v1__tavern-v2', 'a.parts.nbt')), false);
  // the installable version folders
  for (const v of [1, 2, 3, 4, 5]) assert.deepEqual(fs.readdirSync(path.join(out, 'versions', 'tavern', `v${v}`)).sort(), ['tavern.blueprint.json', 'tavern.mjs', 'tavern.nbt', 'tavern.parts.nbt']);
  // deterministic: a second run writes the same expected files
  const again = await writeFixtures(path.join(tmp, 'fixtures2'), { previews: false });
  assert.equal(again.kit, index.kit);
  for (const p of index.pairs) assert.equal(fs.readFileSync(path.join(tmp, 'fixtures2', 'pairs', p.name, 'expected.json'), 'utf8'), fs.readFileSync(path.join(out, 'pairs', p.name, 'expected.json'), 'utf8'), p.name);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
