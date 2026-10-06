// Phase 5a kit additions (docs/CONTRACT.md "Kit additions", "Bible-set clutter"): render --views, slices.mjs, the attach
// and facing rules (the kit examples clean, deliberately broken fixtures flagged), the metrics on hand-built structures
// with known answers, restraint warnings, bible format 2.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Blueprint, palette, PALETTE_PRESETS } from '../lib/kit.mjs';
import { normalize } from '../lib/blocks.mjs';
import { checkBlueprint, checkStructure, restraintWarnings, DETAIL_NOISE_MAX } from '../lib/check.mjs';
import { parse, plain } from '../lib/nbt.mjs';
import { cornerValues } from '../lib/params.mjs';
import { validateBible, restraintOf, RESTRAINT_DEFAULTS } from '../lib/bible.mjs';
import { loadDesign } from '../build.mjs';
import { renderStructure, VIEWS } from '../render.mjs';
import { slices, TRUNCATED } from '../tools/slices.mjs';
import { runComponents } from '../tools/components.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-kit-5a-'));
const run = (script, args) => spawnSync(process.execPath, [path.join(KIT, script), ...args], { encoding: 'utf8' });
const NEW = /^(attach|facing):/;
const newWarnings = (r) => r.warnings.filter((w) => NEW.test(w));
const P = palette({ wood: 'oak', stone: 'cobblestone' });

/** The checker's 5x5 hut (test/check.test.mjs): walls x/z 0..4, rows 1..3, flat roof on row 4, door south at x=2, a hanging lantern. */
function hut(add = () => {}, { size = [5, 5, 7], door = 'south' } = {}) {
  const bp = new Blueprint({ id: 'hut', type: 'custom', size, palette: P, interior: [1, 1, 1, 3, 3, 3], front: 'south' });
  bp.part('main', () => {
    bp.floor(0, 0, 4, 6, 0, P.stone);
    bp.carve([1, 1, 1, 3, 3, 3]);
    bp.walls(0, 0, 4, 4, 1, 3);
    if (door) bp.door(2, 1, 4, door);
    bp.lantern(2, 3, 2, true);
  });
  bp.part('roof', () => bp.floor(0, 0, 4, 4, 4, P.planks));
  bp.part('extra', () => add(bp));
  bp.spot('entrance', 2, 5, 180);
  bp.spot('spawn', 2, 6, 180);
  return bp;
}
const warn = (bp) => newWarnings(checkBlueprint(bp));
const one = (list, re) => { assert.equal(list.filter((w) => re.test(w)).length, 1, `expected one ${re} in:\n${list.join('\n')}`); };

// ---------------------------------------------------------------- render --views

test('render --views writes each listed view; iso_back differs from iso; the default is unchanged', () => {
  const nbt = path.join(KIT, 'examples/tavern/tavern.nbt');
  const out = path.join(tmp, 'views');
  const r = renderStructure(nbt, { out, views: ['iso', 'iso_back', 'cutaway'] });
  assert.deepEqual(Object.keys(r.files), ['iso', 'iso_back', 'cutaway']);
  for (const f of Object.values(r.files)) assert.ok(fs.existsSync(f));
  assert.match(r.files.iso_back, /tavern\.preview-iso_back\.png$/);
  assert.notDeepEqual(fs.readFileSync(r.files.iso), fs.readFileSync(r.files.iso_back));
  const d = renderStructure(nbt, { out: path.join(tmp, 'default') });
  assert.deepEqual(Object.keys(d.files), ['iso', 'top', 'front']);
  const c = renderStructure(nbt, { out: path.join(tmp, 'default'), cutaway: true });
  assert.deepEqual(Object.keys(c.files), ['iso', 'top', 'front', 'cutaway']);
  assert.deepEqual(VIEWS, ['iso', 'iso_back', 'front', 'top', 'cutaway']);
  assert.throws(() => renderStructure(nbt, { out, views: ['iso', 'side'] }), /unknown view side/);
});

test('render.mjs --views on the CLI; an unknown view exits 2', () => {
  const nbt = path.join(KIT, 'examples/cabin/cabin.nbt');
  const out = path.join(tmp, 'cli-views');
  const r = run('render.mjs', [nbt, '--out', out, '--views', 'iso_back,top']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ['cabin.preview-iso_back.png', 'cabin.preview-top.png']);
  const bad = run('render.mjs', [nbt, '--out', out, '--views', 'iso,bogus']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown view bogus/);
});

// ---------------------------------------------------------------- slices

const readStructure = (id) => plain(parse(fs.readFileSync(path.join(KIT, `examples/${id}/${id}.nbt`))));
const readSidecar = (id) => JSON.parse(fs.readFileSync(path.join(KIT, `examples/${id}/${id}.blueprint.json`), 'utf8'));

test('slices: every layer by default, --y and --box restrict it, the legend and the directional listing', () => {
  const s = readStructure('cabin');
  const all = slices(s, readSidecar('cabin'), { name: 'cabin.nbt' });
  assert.equal((all.match(/^-- y=/gm) ?? []).length, s.size[1]);
  assert.match(all, /^legend: A=/m);
  assert.match(all, /^directional blocks/m);
  const one2 = slices(s, null, { y: [2, 2], box: [0, 0, 3, 2] });
  assert.deepEqual(one2.match(/^-- y=\d+/gm), ['-- y=2']);
  const rows = one2.split('\n').filter((l) => /^ {0,2}\d+ \S+$/.test(l));
  assert.equal(rows.length, 3); // z 0..2
  for (const r of rows) assert.equal(r.split(' ').pop().length, 4); // x 0..3
});

test('slices --storeys: the floor row and the eye-height row of each storey, at most 6 layers', () => {
  const sc = readSidecar('tower');
  const out = slices(readStructure('tower'), sc, { storeys: true });
  const layers = [...out.matchAll(/^-- y=(\d+) \(storey (\d+) (floor|eye height)\)/gm)];
  assert.ok(layers.length >= 4 && layers.length <= 6, out.slice(0, 400));
  assert.equal(layers[0][3], 'floor');
  assert.equal(Number(layers[1][1]), Number(layers[0][1]) + 2); // floor row = feet - 1, eye = feet + 1
  assert.throws(() => slices(readStructure('tower'), null, { storeys: true }), /needs the sidecar/);
  // a one-storey cabin: its ground floor
  const cab = slices(readStructure('cabin'), readSidecar('cabin'), { storeys: true });
  assert.match(cab, new RegExp(`^-- y=${readSidecar('cabin').interior.minY - 1} \\(storey 1 floor\\)`, 'm'));
});

test('slices --max-chars truncates the whole output with a final marker line', () => {
  const out = slices(readStructure('tavern'), readSidecar('tavern'), { maxChars: 500 });
  assert.ok(out.length <= 500, String(out.length));
  assert.equal(out.split('\n').pop(), TRUNCATED);
  const short = slices(readStructure('cabin'), null, { y: [1, 1], maxChars: 100000 });
  assert.ok(!short.includes(TRUNCATED));
});

test('slices.mjs CLI: reads the sidecar next to the .nbt; bad usage exits 2', () => {
  const nbt = path.join(KIT, 'examples/tower/tower.nbt');
  const r = run('tools/slices.mjs', [nbt, '--storeys', '--max-chars', '8000']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /storey 1 floor/);
  assert.ok(r.stdout.length <= 8001);
  assert.equal(run('tools/slices.mjs', [nbt, '--box', '1,2']).status, 2);
  assert.equal(run('tools/slices.mjs', [nbt, '--bogus']).status, 2);
});

// ---------------------------------------------------------------- attach and facing: the examples are clean

test('attach/facing: no warnings on any kit example at any param corner in any preset, the massings, or the rustic components', async () => {
  const found = [];
  for (const id of ['cabin', 'tower', 'tavern', 'gatehouse']) {
    const mod = await import(`../designs/${id}.mjs`);
    for (const preset of [undefined, ...Object.keys(PALETTE_PRESETS)]) for (const values of cornerValues(mod.params)) {
      const w = newWarnings(checkBlueprint(await loadDesign(id, { palette: preset, values })));
      if (w.length) found.push(`${id} ${preset} ${JSON.stringify(values)}: ${w.join(' | ')}`);
    }
  }
  for (const id of ['cabin_massing', 'tower_massing', 'tavern_massing', 'gatehouse_massing']) {
    const w = newWarnings(checkBlueprint(await loadDesign(id, { dir: path.join(KIT, 'massings') })));
    if (w.length) found.push(`${id}: ${w.join(' | ')}`);
  }
  const comp = await runComponents(path.join(KIT, 'bibles/rustic/components.mjs'));
  for (const c of comp.components ?? []) if (c.warnings.some((w) => NEW.test(w))) found.push(`component ${c.name}: ${c.warnings.join(' | ')}`);
  assert.deepEqual(found, []);
});

test('the hut fixture has no attach or facing warnings', () => assert.deepEqual(warn(hut()), []));

// ---------------------------------------------------------------- attach: broken fixtures

test('attach: ladders, wall torches, wall signs and wall banners need a solid block behind them', () => {
  // backed by the wall: clean
  assert.deepEqual(warn(hut((bp) => {
    bp.ladder(1, 1, 1, 2, 'south');
    bp.torch(3, 2, 2, 'west');
    bp.set(1, 2, 5, 'minecraft:red_wall_banner', { facing: 'south' });
    bp.set(3, 1, 5, 'minecraft:oak_wall_sign', { facing: 'south' });
  })), []);
  // in the middle of the room, on a door, on a half slab, on air
  const w = warn(hut((bp) => {
    bp.set(2, 1, 2, 'minecraft:ladder', { facing: 'south' }); // behind: 2,1,1 air
    bp.set(2, 2, 3, 'minecraft:soul_wall_torch', { facing: 'south' }); // behind: 2,2,2 air
    bp.set(2, 2, 5, 'minecraft:oak_wall_sign', { facing: 'south' }); // behind: the door's upper half
    bp.slab(3, 1, 3, 'bottom');
    bp.set(3, 1, 2, 'minecraft:ladder', { facing: 'north' }); // behind: a bottom slab (half a face)
    bp.set(4, 2, 5, 'minecraft:blue_wall_banner', { facing: 'east' }); // behind: 3,2,5 air
  }));
  one(w, /^attach: 5 wall-mounted block\(s\)/);
  for (const at of ['ladder at 2,1,2', 'soul_wall_torch at 2,2,3', 'oak_wall_sign at 2,2,5', 'ladder at 3,1,2', 'blue_wall_banner at 4,2,5']) assert.ok(w[0].includes(at), at);
});

test('attach: a door upper half needs its lower half; beds need both halves', () => {
  const w = warn(hut((bp) => {
    bp.set(1, 2, 1, 'minecraft:oak_door', { half: 'upper', facing: 'south' });
    bp.set(3, 1, 1, 'minecraft:red_bed', { facing: 'north', part: 'foot' }); // no head at 3,1,0 (a wall)
  }));
  one(w, /^attach: 1 door upper half\(s\) with no lower half below, e\.g\. oak_door at 1,2,1/);
  one(w, /^attach: 1 bed half\(s\) without the other half, e\.g\. red_bed foot at 3,1,1/);
  // a lower half without its upper half, or a door written open, stay the doorCheck errors (not repeated as warnings)
  const r = checkBlueprint(hut((bp) => bp.set(1, 1, 1, 'minecraft:oak_door', { half: 'lower', facing: 'south' })));
  assert.ok(r.errors.some((e) => /no matching upper half/.test(e)));
  assert.deepEqual(newWarnings(r).filter((w) => w.startsWith('attach:')), []);
});

test('attach: a hanging lantern hangs from a solid block, a chain or a fence', () => {
  assert.deepEqual(warn(hut((bp) => {
    bp.set(1, 2, 1, 'minecraft:iron_chain', { axis: 'y' });
    bp.lantern(1, 1, 1, true);
    bp.set(3, 2, 3, 'minecraft:oak_fence');
    bp.lantern(3, 1, 3, true);
  })), []);
  one(warn(hut((bp) => bp.lantern(1, 2, 1, true))), /^attach: 1 hanging lantern\(s\) with nothing above/);
});

// ---------------------------------------------------------------- facing: broken fixtures

test('facing: a door must not open into a wall', () => {
  // turned 90 degrees in its wall: its front and back are the wall
  const w = checkBlueprint(hut(() => {}, { door: 'east' }));
  one(newWarnings(w), /^facing: 1 door\(s\) open into a wall.*oak_door at 2,1,4 facing east/);
  // a block right behind the door
  one(warn(hut((bp) => bp.set(2, 1, 3, P.stone))), /^facing: 1 door\(s\) open into a wall.*back 2,1,3 is cobblestone/);
});

test('facing: a bed head against a wall', () => {
  assert.deepEqual(warn(hut((bp) => bp.bed(1, 1, 2, 'west'))), []); // head 1,1,2, beyond: 0,1,2 the wall
  one(warn(hut((bp) => bp.bed(2, 1, 2, 'east'))), /^facing: 1 bed\(s\) with the head not against a wall.*red_bed at 2,1,2 facing east \(beyond the head: air\)/); // beyond 3,1,2: air
});

test('facing: stairs on a slope face up-slope; only the reversal is flagged', () => {
  const slope = (facing) => hut((bp) => {
    // three stairs rising north on the roof, with planks under them
    bp.fill([1, 5, 1, 1, 6, 1], P.planks);
    bp.set(1, 5, 2, P.planks);
    bp.stairs(1, 5, 3, facing);
    bp.stairs(1, 6, 2, facing);
    bp.stairs(1, 7, 1, facing);
  }, { size: [5, 8, 7] });
  assert.deepEqual(warn(slope('north')), []);
  assert.deepEqual(warn(slope('east')), []); // across the run (a hip, a crooked eave): not flagged
  one(warn(slope('south')), /^facing: 3 stair\(s\) on a slope facing down-slope.*oak_stairs at 1,5,3 facing south on a slope rising north/);
});

// ---------------------------------------------------------------- metrics on hand-built structures

/**
 * A 3x1 wall (x 0..2, rows 1..3, z 0) on a cobblestone ground row:
 *   y=3  cobblestone   cobblestone   cobblestone
 *   y=2  moss_block    glass_pane    birch_planks
 *   y=1  cobblestone   oak_planks    cobblestone
 */
function wall({ palette: pal = { wood: 'spruce', stone: 'cobblestone', roof: 'dark_oak', accent: 'birch' }, swap = {}, parts } = {}) {
  const rows = { 3: ['cobblestone', 'cobblestone', 'cobblestone'], 2: ['moss_block', 'glass_pane', 'birch_planks'], 1: ['cobblestone', 'oak_planks', 'cobblestone'], 0: ['cobblestone', 'cobblestone', 'cobblestone'] };
  for (const [k, v] of Object.entries(swap)) { const [x, y] = k.split(',').map(Number); rows[y][x] = v; }
  const ids = [...new Set(Object.values(rows).flat())];
  const structure = {
    DataVersion: 5023, size: [3, 4, 1], entities: [],
    palette: ids.map((id) => { const n = normalize(`minecraft:${id}`); return { id: n.name, properties: n.props }; }),
    blocks: Object.entries(rows).flatMap(([y, r]) => r.map((id, x) => ({ pos: [x, Number(y), 0], state: ids.indexOf(id) }))),
  };
  const sidecar = {
    id: 'wall', name: 'Wall', type: 'custom', size: { x: 3, y: 4, z: 1 }, groundY: 1, front: 'south',
    anchors: { entrance: { x: 1.5, y: 1, z: 2.5, yaw: 0, pitch: 0 }, spawn: { x: 1.5, y: 1, z: 3.5, yaw: 0, pitch: 0 } },
    ...(pal ? { palette: pal } : {}),
    parts: parts ?? { wall: { box: [0, 1, 0, 2, 3, 0], cells: 9 }, base: { box: [0, 0, 0, 2, 0, 0], cells: 3 } },
  };
  return checkStructure(sidecar, structure);
}

test('metrics: known answers on a small wall', () => {
  const { metrics: m } = wall();
  // 8 shell cells without the pane: accents = moss (no palette field), birch planks (the accent wood), oak planks (no field)
  assert.equal(m.accentShare, 0.375);
  // per side: north and south 12 pairs (6 along, 6 vertical), 10 differ each; east and west 2 vertical pairs, both differ
  assert.equal(m.detailNoise, 0.857); // 24 / 28
  assert.deepEqual(m.windowsPerFacade, { north: 1, south: 1, east: 0, west: 0 });
  assert.equal(m.windowsMin, 0);
  // wood/stone cells: 8 cobblestone, birch (palette accent wood), oak (not the palette's) -> 9 / 10
  assert.equal(m.paletteAdherence, 0.9);
  assert.equal(m.parts, 2);
  assert.equal(m.cellsOutsideParts, 0);
  assert.equal(m.blocks, 12);
  assert.deepEqual(m.topBlocks[0], ['cobblestone', 8]);
  assert.equal(m.topBlocks.length, 5);
});

test('metrics: an all-cobblestone wall has no noise, no accents and full adherence; parts that miss cells', () => {
  const { metrics: m } = wall({ swap: { '0,2': 'cobblestone', '1,2': 'cobblestone', '2,2': 'cobblestone', '1,1': 'cobblestone' }, parts: { wall: { box: [0, 1, 0, 2, 3, 0], cells: 8 } } });
  assert.equal(m.detailNoise, 0);
  assert.equal(m.accentShare, 0);
  assert.equal(m.paletteAdherence, 1);
  assert.equal(m.windowsMin, 0);
  assert.equal(m.parts, 1);
  assert.equal(m.cellsOutsideParts, 4);
});

test('metrics: without a recorded palette the 4 most-used families are main; adherence is 1', () => {
  // families on the shell: cobblestone 5, moss 1, birch 1, oak 1 -> all four are main
  assert.equal(wall({ palette: null }).metrics.accentShare, 0);
  // a fifth family (wool for one cobblestone): cobblestone 4, then the ties by name: moss, wool, birch; oak is the accent
  const m = wall({ palette: null, swap: { '1,3': 'white_wool' } }).metrics;
  assert.equal(m.accentShare, 0.125);
  assert.equal(m.paletteAdherence, 1);
});

test('metrics: a main block\'s stairs or slab is main; the roof wood used as accent wood counts as main', () => {
  // rustic: accent wood dark_oak = the roof wood; dark_oak_planks is the roof block (main)
  assert.equal(wall({ palette: 'rustic', swap: { '2,2': 'dark_oak_planks', '0,2': 'cobblestone_slab', '1,1': 'cobblestone' } }).metrics.accentShare, 0);
});

test('metrics: windows are connected glass groups per side', () => {
  const m = wall({ swap: { '0,2': 'glass_pane', '1,1': 'glass', '1,3': 'cobblestone' } }).metrics;
  // north: panes at 0,2 and 1,2 + glass at 1,1, all connected -> 1; west: the pane at 0,2 -> 1
  assert.deepEqual(m.windowsPerFacade, { north: 1, south: 1, east: 0, west: 1 });
  const two = wall({ swap: { '0,2': 'glass_pane', '2,2': 'glass_pane', '1,2': 'cobblestone' } }).metrics;
  assert.deepEqual(two.windowsPerFacade, { north: 2, south: 2, east: 1, west: 1 });
  assert.equal(two.windowsMin, 1);
});

test('metrics: the kit examples and an early failure', () => {
  const r = checkBlueprint(hut());
  for (const k of ['accentShare', 'detailNoise', 'windowsPerFacade', 'windowsMin', 'paletteAdherence', 'parts', 'cellsOutsideParts', 'blocks', 'topBlocks']) assert.ok(k in r.metrics, k);
  assert.equal(checkStructure({}, { DataVersion: 1 }).metrics, null);
});

// ---------------------------------------------------------------- restraint

test('restraint warnings: accentShare, windowsMin and detailNoise against the bible restraint', () => {
  const r = { ...RESTRAINT_DEFAULTS, heroMotifs: [] };
  const ok = { accentShare: 0.1, detailNoise: 0.3, windowsPerFacade: { north: 2, south: 3, east: 2, west: 2 }, windowsMin: 2 };
  assert.deepEqual(restraintWarnings(ok, r), []);
  const bad = { accentShare: 0.2, detailNoise: DETAIL_NOISE_MAX.moderate + 0.01, windowsPerFacade: { north: 0, south: 3, east: 1, west: 2 }, windowsMin: 0 };
  const w = restraintWarnings(bad, r);
  assert.equal(w.length, 3);
  assert.ok(w.every((m) => m.startsWith('restraint: ')));
  assert.match(w[1], /north 0, east 1 window/);
  assert.deepEqual(restraintWarnings(bad, { ...r, accentShareMax: 0.2, windowsPerFacadeMin: 0, detailDensity: 'rich' }), []);
  assert.ok(DETAIL_NOISE_MAX.sparse < DETAIL_NOISE_MAX.moderate && DETAIL_NOISE_MAX.moderate < DETAIL_NOISE_MAX.rich);
});

test('--restraint on build.mjs and check.mjs adds restraint warnings; --json carries metrics', () => {
  const bible = path.join(tmp, 'bible.json');
  fs.writeFileSync(bible, JSON.stringify({ name: 'Strict', format: 2, motifs: ['a'], restraint: { heroMotifs: ['a'], windowsPerFacadeMin: 3, accentShareMax: 0.04, detailDensity: 'sparse' } }));
  const b = run('build.mjs', ['cabin', '--out', tmp, '--json', '--restraint', bible]);
  const j = JSON.parse(b.stdout.trim());
  assert.equal(j.ok, true);
  assert.ok(j.metrics && typeof j.metrics.detailNoise === 'number');
  assert.ok(j.warnings.some((w) => /^restraint: .*windowsPerFacadeMin 3/.test(w)), j.warnings.join('\n'));
  const plainBuild = JSON.parse(run('build.mjs', ['cabin', '--out', tmp, '--json']).stdout.trim());
  assert.deepEqual(plainBuild.warnings, []);
  assert.deepEqual(plainBuild.metrics, j.metrics);
  const c = run('check.mjs', [j.nbt, j.sidecar, '--json', '--restraint', bible]);
  const cj = JSON.parse(c.stdout.trim());
  assert.deepEqual(cj.metrics, j.metrics);
  assert.deepEqual(cj.warnings, j.warnings);
  const bad = JSON.parse(run('check.mjs', ['--json']).stdout.trim());
  assert.equal(bad.metrics, null);
});

// ---------------------------------------------------------------- bible format 2

const F1 = { name: 'Test', roles: { ...P.roles }, motifs: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'], components: ['window', 'stilt', 'net', 'rack', 'boat'] };

test('bible format 1: unchanged limits; restraintOf gives the defaults with the first 3 motifs as hero motifs', () => {
  const v = validateBible(F1, { frame: false });
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.equal(v.bible.restraint, undefined);
  assert.deepEqual(restraintOf(F1), { heroMotifs: ['m1', 'm2', 'm3'], accentShareMax: 0.12, detailDensity: 'moderate', windowsPerFacadeMin: 2 });
  assert.deepEqual(restraintOf({}).heroMotifs, []);
  assert.match(validateBible({ ...F1, restraint: {} }, { frame: false }).errors.join(), /restraint needs format: 2/);
});

test('bible format 2: validated restraint with defaults; at most 6 motifs and 3 extra components', () => {
  const ok = validateBible({ ...F1, format: 2, motifs: F1.motifs.slice(0, 6), components: ['stilt', 'net'], restraint: { heroMotifs: ['m2'], detailDensity: 'sparse' } }, { frame: false });
  assert.equal(ok.ok, true, ok.errors.join('; '));
  assert.deepEqual(ok.bible.restraint, { heroMotifs: ['m2'], accentShareMax: 0.12, detailDensity: 'sparse', windowsPerFacadeMin: 2 });
  assert.deepEqual(restraintOf(ok.bible), ok.bible.restraint);
  const noR = validateBible({ ...F1, format: 2, motifs: ['a', 'b', 'c', 'd'], components: [] }, { frame: false });
  assert.deepEqual(noR.bible.restraint, { heroMotifs: ['a', 'b', 'c'], ...RESTRAINT_DEFAULTS });
  const errs = (patch) => validateBible({ ...F1, format: 2, motifs: F1.motifs.slice(0, 6), components: [], ...patch }, { frame: false }).errors.join('\n');
  assert.match(errs({ motifs: F1.motifs }), /at most 6 strings \(format 2\)/);
  assert.match(errs({ components: ['a', 'b', 'c', 'd'] }), /plus at most 3/);
  assert.match(errs({ restraint: { heroMotifs: ['m1', 'm2', 'm3', 'm4'] } }), /heroMotifs must be a list of at most 3/);
  assert.match(errs({ restraint: { heroMotifs: ['nope'] } }), /'nope' is not one of the motifs/);
  assert.match(errs({ restraint: { accentShareMax: 0.3 } }), /accentShareMax must be a number 0.04-0.2/);
  assert.match(errs({ restraint: { detailDensity: 'lots' } }), /detailDensity must be one of sparse, moderate, rich/);
  assert.match(errs({ restraint: { windowsPerFacadeMin: 1.5 } }), /windowsPerFacadeMin must be an integer/);
  assert.match(errs({ restraint: { colour: 1 } }), /unknown field 'colour'/);
  assert.match(validateBible({ ...F1, format: 3 }, { frame: false }).errors.join(), /format must be 1 or 2/);
});
