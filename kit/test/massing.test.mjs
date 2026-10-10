// Phase 4c massings (docs/CONTRACT.md "Kit: massing designs"): the builder (roof forms, openings, stilts, parts, roles),
// the massing checker profile, massing conformance (lib + CLI) and the example massings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Blueprint, PALETTES, palette } from '../lib/kit.mjs';
import { massing, checkConformance, roleBlock } from '../lib/massing.mjs';
import { checkBlueprint } from '../lib/check.mjs';
import { buildDesign, listDesigns } from '../build.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(KIT, 'test', 'fixtures', 'massing');
const MASSINGS = path.join(KIT, 'massings');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-massing-'));
const run = (script, args) => spawnSync(process.execPath, [path.join(KIT, script), ...args], { encoding: 'utf8' });
const P = PALETTES.oak;
const has = (list, re) => list.some((m) => re.test(m));
const sidecarOf = (bp) => JSON.parse(JSON.stringify(bp.sidecar()));
const blocks = (bp, part) => [...bp.cells].filter(([k]) => !part || bp.cellPart.get(k) === part).map(([, c]) => c.state);

/** One 9x7 mass with a roof form, a door, entrance + spawn in front; the template sized to fit. */
function single(roof, { size = SIZES[roof], ridge, wall, high, pal = P } = {}) {
  const o = roof === 'flat' || roof === 'none' ? 0 : 1; // the default overhang
  const bp = new Blueprint({ id: `m_${roof}`, type: 'tavern', size, origin: [o, 0, o], palette: pal });
  const m = massing(bp);
  m.mass('hall', [0, 0, 0, 8, 5, 6], { roof, ridge, wall, high });
  m.opening('hall', 'south', [4, 1], [1, 2]);
  bp.part('path', () => bp.floor(4, 7, 4, 8, 0, pal.path));
  bp.spot('entrance', 4, 7, 180);
  bp.spot('spawn', 4, 8, 180);
  return { bp, m };
}
/** the exact template sizes: a 9x7 footprint (+1 overhang each side), roofs up to row 9, a flat deck + parapet to row 7, a path to z=8 */
const SIZES = { gable: [11, 10, 10], hip: [11, 10, 10], shed: [11, 10, 10], flat: [9, 8, 9], none: [9, 6, 9] };

// ---------------------------------------------------------------- the builder

test('massing(bp) marks the blueprint: the sidecar says massing: true; an ordinary one says nothing', () => {
  const { bp } = single('none');
  assert.equal(sidecarOf(bp).massing, true);
  assert.equal(new Blueprint({ id: 'x', size: [1, 1, 1] }).sidecar().massing, undefined);
  assert.equal(sidecarOf(new Blueprint({ id: 'x', size: [1, 1, 1], massing: true })).massing, true);
});

for (const roof of ['gable', 'hip', 'flat', 'shed', 'none']) {
  test(`mass with roof '${roof}': a named part recording its roof, in the roles, passes the massing profile clean`, () => {
    const { bp } = single(roof);
    const sc = sidecarOf(bp);
    assert.equal(sc.parts.hall.roof, roof);
    assert.equal(sc.parts.hall.storeys, 1);
    assert.deepEqual(sc.parts.hall.box.slice(0, 3), [0, 0, 0]); // the roof (and its overhang) is in the mass's part
    const names = new Set(blocks(bp).map((s) => s.name));
    assert.ok(names.has(P.wall), 'the wall role');
    assert.ok(names.has(P.foundation), 'the foundation role on the ground row');
    assert.ok(names.has(P.door), 'the door');
    if (roof === 'gable' || roof === 'hip' || roof === 'shed') assert.ok(names.has(P.roofStairs), 'roof stairs');
    if (roof === 'flat') assert.ok(names.has(P.roofBlock), 'the roof deck');
    if (roof === 'none') assert.ok(![P.roofStairs, P.roofBlock, P.roofSlab].some((b) => names.has(b)), 'no roof blocks');
    const r = checkBlueprint(bp);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
  });
}

test('gable: the ridge runs along the requested axis (overhang 1, pitch 1)', () => {
  for (const [ridge, size] of [['x', [11, 10, 10]], ['z', [11, 11, 10]]]) {
    const { bp } = single('gable', { size, ridge });
    const facings = new Set(blocks(bp).filter((s) => s.name === P.roofStairs).map((s) => s.props.facing));
    assert.deepEqual([...facings].sort(), ridge === 'x' ? ['north', 'south'] : ['east', 'west']);
    const top = Math.max(...[...bp.cells.keys()].map((k) => Number(k.split(',')[1])));
    assert.equal(top, ridge === 'x' ? 9 : 10, `ridge ${ridge}: half the overhung span above the eaves`);
  }
});

test('shed: one slope rising to the high side (default the back), closed at the ends', () => {
  const { bp } = single('shed');
  const stairs = blocks(bp).filter((s) => s.name === P.roofStairs);
  assert.ok(stairs.length && stairs.every((s) => s.props.facing === 'north'));
  const south = single('shed', { high: 'south' }).bp;
  assert.ok(blocks(south).filter((s) => s.name === P.roofStairs).every((s) => s.props.facing === 'south'));
  assert.throws(() => single('shed', { high: 'east' }), /high side 'east' must be north or south/);
  assert.deepEqual(checkBlueprint(south).warnings, []);
});

test('roofPart: the roof goes in its own part and both record the form', () => {
  const bp = new Blueprint({ id: 'rp', size: [11, 10, 9], origin: [1, 0, 1], palette: P });
  const m = massing(bp);
  m.mass('main', [0, 0, 0, 8, 5, 6], { roof: 'gable', roofPart: 'roof' });
  const sc = sidecarOf(bp);
  assert.deepEqual(sc.parts.main.box, [1, 0, 1, 9, 5, 7]);
  assert.deepEqual(sc.parts.roof.box, [0, 5, 0, 10, 9, 8]);
  assert.equal(sc.parts.roof.roof, 'gable');
  assert.equal(sc.parts.main.roof, 'gable');
});

test('storeys: floors inside at even heights, recorded; too many for the height throws', () => {
  const bp = new Blueprint({ id: 's', size: [5, 11, 5], palette: P });
  massing(bp).mass('tower', [0, 0, 0, 4, 10, 4], { storeys: 2 });
  assert.equal(sidecarOf(bp).parts.tower.storeys, 2);
  assert.equal(bp.nameAt(2, 5, 2), P.floor);
  assert.throws(() => massing(new Blueprint({ id: 's', size: [5, 4, 5], palette: P })).mass('t', [0, 0, 0, 4, 3, 4], { storeys: 2 }), /too low for 2 storey/);
});

test('mass: readable errors for a bad box, roof, ridge or role', () => {
  const m = massing(new Blueprint({ id: 'e', size: [9, 9, 9], palette: P }));
  assert.throws(() => m.mass('a', [0, 0, 0, 3, 3]), /box must be/);
  assert.throws(() => m.mass('a', [0, 0, 0, 3, 3, 3], { roof: 'dome' }), /roof 'dome' must be one of gable, hip, flat, shed, none/);
  assert.throws(() => m.mass('a', [0, 0, 0, 3, 3, 3], { ridge: 'y' }), /ridge must be 'x' or 'z'/);
  assert.throws(() => m.mass('a', [0, 0, 0, 3, 3, 3], { wall: 'marble' }), /unknown role 'marble'/);
  assert.throws(() => m.mass('Bad Name', [0, 0, 0, 3, 3, 3]), /part name/);
});

test('openings: door (doors below, glass above), window (glass), arch (open); they stay in the mass part', () => {
  const bp = new Blueprint({ id: 'o', size: [9, 7, 7], palette: P });
  const m = massing(bp);
  m.mass('hall', [0, 0, 0, 8, 6, 6]);
  m.opening('hall', 'south', [1, 1], [2, 3]); // door by default (starts on the feet row, 2+ tall)
  m.opening('hall', 'east', [2, 2], [2, 2]); // window by default
  m.opening('hall', 'north', [3, 1], [3, 3], { kind: 'arch' });
  assert.equal(bp.nameAt(1, 1, 6), P.door);
  assert.equal(bp.get(1, 1, 6).state.props.open, 'false');
  assert.equal(bp.get(2, 2, 6).state.props.half, 'upper');
  assert.equal(bp.nameAt(1, 3, 6), P.glass);
  assert.equal(bp.nameAt(8, 2, 2), P.glass);
  assert.equal(bp.nameAt(8, 3, 3), P.glass);
  assert.equal(bp.nameAt(4, 2, 0), 'minecraft:air');
  assert.deepEqual(Object.keys(sidecarOf(bp).parts), ['hall']);
  assert.throws(() => m.opening('wing', 'south', [1, 1], [1, 2]), /no mass 'wing' \(masses: hall\)/);
  assert.throws(() => m.opening('hall', 'up', [1, 1], [1, 2]), /face 'up'/);
  assert.throws(() => m.opening('hall', 'south', [0, 1], [1, 2]), /columns 0\.\.0 must be inside the wall, between 1 and 7/);
  assert.throws(() => m.opening('hall', 'south', [1, 5], [1, 2]), /rows 5\.\.6 must be between the floor and the top, 1\.\.5/);
  assert.throws(() => m.opening('hall', 'south', [1, 1], [1, 2], { kind: 'portal' }), /kind 'portal'/);
});

test('stilts: frame posts on a grid (corners always), a mass on top is not floating', () => {
  const bp = new Blueprint({ id: 'st', type: 'house', size: [8, 9, 8], palette: P });
  const m = massing(bp);
  m.stilts('piles', [0, 0, 0, 7, 3, 7], 3);
  m.mass('hut', [0, 4, 0, 7, 8, 7], { wall: 'wall' });
  m.opening('hut', 'south', [3, 5], [1, 2]);
  const posts = new Set([...bp.cells].filter(([k]) => bp.cellPart.get(k) === 'piles').map(([k]) => k.split(',').filter((_, i) => i !== 1).join(',')));
  assert.deepEqual([...posts].sort(), ['0,0', '0,3', '0,6', '0,7', '3,0', '3,3', '3,6', '3,7', '6,0', '6,3', '6,6', '6,7', '7,0', '7,3', '7,6', '7,7'].sort());
  assert.ok(blocks(bp, 'piles').every((s) => s.name === P.frame));
  // a raised mass: its bottom row is a floor, not the foundation
  assert.equal(bp.nameAt(3, 4, 3), P.floor);
  bp.spot('entrance', 3, 9, 180);
  bp.spot('spawn', 3, 9, 180);
  const r = checkBlueprint(bp, { profile: 'massing' });
  assert.deepEqual(r.errors, []);
  assert.ok(!has(r.warnings, /floating/), r.warnings.join(' | '));
  assert.throws(() => m.stilts('p', [0, 0, 0, 1, 1, 1], 0), /spacing/);
});

test('roles: a massing re-skins under a style bible (shell, roof, foundation, glass from the roles)', () => {
  const bible = { id: 'ash', version: 2, roles: { ...PALETTES.oak.roles, wall: 'minecraft:blackstone', roof: 'minecraft:deepslate_tiles', foundation: 'minecraft:polished_blackstone_bricks', glass: 'minecraft:red_stained_glass_pane', wall_alt: 'minecraft:basalt' } };
  const pal = palette({ bible });
  const { bp, m } = single('gable', { pal });
  m.opening('hall', 'east', [2, 2], [2, 2]);
  const names = new Set(blocks(bp).map((s) => s.name));
  for (const b of ['minecraft:blackstone', 'minecraft:deepslate_tile_stairs', 'minecraft:polished_blackstone_bricks', 'minecraft:red_stained_glass']) assert.ok(names.has(b), b);
  assert.equal(roleBlock(pal, 'wall_alt'), 'minecraft:basalt');
  assert.deepEqual(sidecarOf(bp).bible, { id: 'ash', version: 2 });
  assert.deepEqual(checkBlueprint(bp).errors, []);
});

// ---------------------------------------------------------------- the massing profile

test('massing profile: no interior, light, door or type-geometry rules (a tower massing need not be tall or lit)', () => {
  // a squat 'tower' massing without an interior and without a light: as a detail design it fails; as a massing it is clean
  const bp = new Blueprint({ id: 't', type: 'tower', size: [7, 6, 5], palette: P });
  const m = massing(bp);
  m.mass('shaft', [0, 0, 0, 4, 5, 4], { wall: 'foundation' });
  m.mass('annex', [5, 0, 1, 6, 3, 3]);
  m.opening('shaft', 'south', [2, 1], [1, 2], { kind: 'arch' });
  bp.spot('entrance', 2, 5, 180);
  bp.spot('spawn', 0, 6, 180);
  const r = checkBlueprint(bp);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  bp.massing = false;
  assert.ok(has(checkBlueprint(bp).errors, /interior is required for type 'tower'/));
});

test('massing profile: anchors stay errors; parts, floating and the way in are warnings', () => {
  // one part only, a floating block, and no way in (the door turned into wall)
  const lone = new Blueprint({ id: 'lone', type: 'house', size: [9, 9, 9], palette: P });
  const m = massing(lone);
  m.mass('hall', [0, 0, 0, 8, 5, 6]);
  lone.part('hall', () => {
    lone.set(4, 8, 3, P.wall);
    lone.fill([0, 0, 8, 0, 2, 8], P.wall); // a pillar
  });
  lone.spot('entrance', 4, 7, 180);
  lone.spot('spawn', 4, 8, 180);
  const r = checkBlueprint(lone);
  assert.deepEqual(r.errors, []);
  assert.ok(has(r.warnings, /^parts: 1 named part/), r.warnings.join(' | '));
  assert.ok(has(r.warnings, /^floating: 1 block/), r.warnings.join(' | '));
  assert.ok(has(r.warnings, /^massing: no way into the building from the entrance/), r.warnings.join(' | '));
  // spawn on a pillar nobody can climb: not reachable from the entrance
  lone.spot('spawn', 0, 8, 180, { y: 3 });
  assert.ok(has(checkBlueprint(lone).warnings, /^massing: spawn 0,3,8 cannot be walked to from the entrance/));
  // missing anchors are still errors
  const noAnchors = new Blueprint({ id: 'na', size: [9, 6, 7], palette: P });
  massing(noAnchors).mass('hall', [0, 0, 0, 8, 5, 6]);
  assert.ok(has(checkBlueprint(noAnchors).errors, /missing required anchor 'entrance'/));
});

test('massing profile is chosen by the sidecar; --profile massing on a non-massing is an error', () => {
  const { bp } = single('gable');
  assert.deepEqual(checkBlueprint(bp, { profile: 'massing' }).errors, []);
  bp.massing = false;
  assert.ok(has(checkBlueprint(bp, { profile: 'massing' }).errors, /asked for a massing, but the sidecar has no massing: true/));
});

// ---------------------------------------------------------------- conformance

const EXAMPLES = ['cabin', 'tower', 'tavern', 'gatehouse'];
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('the example massings are listed and build clean (massing profile, no warnings)', async () => {
  assert.deepEqual(listDesigns(MASSINGS), EXAMPLES.map((e) => `${e}_massing`).sort());
  for (const e of EXAMPLES) {
    const { result, written } = await buildDesign(`${e}_massing`, { out: tmp, dir: MASSINGS });
    assert.deepEqual([...result.errors, ...result.warnings], [], e);
    assert.equal(readJson(written.jsonPath).massing, true);
    assert.ok(Object.keys(readJson(written.jsonPath).parts).length >= 2);
  }
});

for (const e of EXAMPLES) {
  test(`conformance: ${e} against its own massing gives 0 issues, with a roof actually compared`, async () => {
    const { written } = await buildDesign(`${e}_massing`, { out: tmp, dir: MASSINGS });
    const c = checkConformance(readJson(path.join(KIT, 'examples', e, `${e}.blueprint.json`)), readJson(written.jsonPath));
    assert.deepEqual(c.errors, []);
    assert.deepEqual(c.issues, []);
    assert.ok(c.ok);
    assert.ok(c.compared.parts >= 2, `${c.compared.parts} parts compared`);
    assert.ok(c.compared.roofs >= 1, 'a roof form compared');
    assert.equal(c.compared.entrance, true, 'the entrance column compared');
  });
}

// (6c 0a, C6) the front and the entrance column, which make Sites.fitMassingToLot predict the detail's fit
test('conformance (6c 0a C6): a turned front is an error, an entrance column more than 1 off an issue', async () => {
  for (const e of EXAMPLES) {
    const m = readJson(path.join(MASSINGS, `${e}_massing`, `${e}_massing.blueprint.json`));
    const d = readJson(path.join(KIT, 'examples', e, `${e}.blueprint.json`));
    for (const f of ['north', 'east', 'west']) {
      const c = checkConformance({ ...d, front: f }, m);
      assert.equal(c.ok, false, `${e} turned ${f}`);
      assert.deepEqual(c.errors, [`front: the design faces ${f}, the massing south (keep the massing's front: it would stand turned on its lot)`], e);
      assert.ok(!has(c.issues, /^entrance:/), 'no entrance issue on top of a turned front');
    }
    const moved = (dx) => ({ ...d, anchors: { ...d.anchors, entrance: { ...d.anchors.entrance, x: d.anchors.entrance.x + dx } } });
    for (const dx of [-1, 1]) assert.deepEqual([checkConformance(moved(dx), m).errors, checkConformance(moved(dx), m).issues], [[], []], `${e} entrance ${dx}`);
    for (const dx of [-2, 2, 5]) {
      const c = checkConformance(moved(dx), m);
      assert.deepEqual(c.errors, [], `${e} entrance ${dx}: an issue, not an error`);
      const mc = Math.floor(m.anchors.entrance.x);
      assert.deepEqual(c.issues, [`entrance: column x=${mc + dx} is ${dx > 0 ? '+' : ''}${dx} off the massing's x=${mc} (more than 1; it moves the building on its lot)`], `${e} entrance ${dx}`);
    }
    // moving the entrance in depth (z on a south front) is not a column change
    const deeper = { ...d, anchors: { ...d.anchors, entrance: { ...d.anchors.entrance, z: d.anchors.entrance.z - 3 } } };
    assert.deepEqual(checkConformance(deeper, m).issues, [], e);
  }
  // an east/west front compares z; the front is case-blind and defaults to south; no entrance on either side: nothing compared
  const side = (front, x, z) => ({ id: 's', massing: true, front, size: { x: 9, y: 9, z: 9 }, parts: { a: { box: [0, 0, 0, 8, 8, 8] } }, anchors: { entrance: { x, y: 1, z } } });
  assert.deepEqual(checkConformance(side('east', 1.5, 4.5), side('east', 7.5, 4.5)).issues, []);
  assert.ok(has(checkConformance(side('east', 4.5, 1.5), side('east', 4.5, 4.5)).issues, /^entrance: column z=1 is -3 off the massing's z=4/));
  assert.deepEqual(checkConformance(side('SOUTH', 4.5, 1.5), side('south', 4.5, 4.5)).errors, []);
  const nofront = side(undefined, 4.5, 1.5);
  delete nofront.front;
  assert.deepEqual(checkConformance(nofront, side('south', 4.5, 4.5)).errors, []);
  assert.equal(checkConformance(nofront, side('west', 4.5, 4.5)).errors.length, 1);
  const bare = side('south', 0, 0);
  delete bare.anchors;
  const c = checkConformance(bare, side('south', 4.5, 4.5));
  assert.deepEqual([c.errors, c.issues, c.compared.entrance], [[], [], false]);
});

test('conformance: the non-conforming fixture pair has each problem, the size cap as an error', async () => {
  const mm = await buildDesign('hall_massing', { out: tmp, dir: FIX });
  assert.deepEqual([...mm.result.errors, ...mm.result.warnings], []);
  const bad = await buildDesign('hall_bad', { out: tmp, dir: FIX });
  const c = checkConformance(readJson(bad.written.jsonPath), readJson(mm.written.jsonPath));
  assert.equal(c.ok, false);
  assert.deepEqual(c.errors, ["size: x is 18, over the massing's 15 + 2 (the approved massing caps the size)"]);
  assert.equal(c.issues.length, 5, c.issues.join(' | '));
  assert.ok(has(c.issues, /^size: y is 10, more than 2 under the massing's 15$/));
  assert.ok(has(c.issues, /^part 'tower' is missing/));
  assert.ok(has(c.issues, /^part 'hall': box \[1,0,1,11,5,7\] is off the massing's \[1,0,1,9,5,7\] by more than 1 on east \(x1\) \+2$/));
  assert.ok(has(c.issues, /^part 'roof': box \[0,5,0,12,9,8\] is off the massing's \[0,5,0,10,9,8\] by more than 1 on east \(x1\) \+2$/));
  assert.ok(has(c.issues, /^part 'roof': roof 'hip' but the massing has 'gable'$/));
  // within tolerance: +1 on a face, +2 on the size, extra detail parts
  const d = readJson(mm.written.jsonPath);
  delete d.massing;
  d.size.x += 2;
  d.parts.hall.box = d.parts.hall.box.map((v) => v + 1);
  d.parts.porch = { box: [0, 0, 0, 1, 1, 1], cells: 2 };
  const ok = checkConformance(d, readJson(mm.written.jsonPath));
  assert.deepEqual([ok.errors, ok.issues], [[], []]);
  // a reference that isn't a massing is an issue
  assert.ok(has(checkConformance(d, d).issues, /is not a massing/));
});

test('check.mjs / build.mjs --massing: warning lines, the size cap fails the check, --json conformance', async () => {
  const mm = await buildDesign('hall_massing', { out: tmp, dir: FIX });
  const bad = await buildDesign('hall_bad', { out: tmp, dir: FIX });
  const r = run('check.mjs', [bad.written.nbtPath, bad.written.jsonPath, '--massing', mm.written.jsonPath]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^error: massing: size: x is 18, over the massing's 15 \+ 2/m);
  assert.match(r.stdout, /^warning: massing: part 'tower' is missing/m);
  assert.match(r.stdout, /^warning: massing: part 'roof': roof 'hip' but the massing has 'gable'$/m);
  assert.match(r.stdout, /^check: FAILED$/m);
  const j = JSON.parse(run('check.mjs', [bad.written.nbtPath, bad.written.jsonPath, '--massing', mm.written.jsonPath, '--json']).stdout);
  assert.equal(j.conformance.ok, false);
  assert.equal(j.conformance.errors.length, 1);
  assert.equal(j.conformance.issues.length, 5);
  // without --massing there is no conformance field
  assert.equal('conformance' in JSON.parse(run('check.mjs', [bad.written.nbtPath, bad.written.jsonPath, '--json']).stdout), false);
  // the examples against their massings via build.mjs: OK, no warnings, conformance ok
  for (const e of EXAMPLES) {
    const mf = path.join(MASSINGS, `${e}_massing`, `${e}_massing.blueprint.json`);
    const b = JSON.parse(run('build.mjs', [e, '--out', tmp, '--massing', mf, '--json']).stdout);
    assert.deepEqual([b.ok, b.errors, b.warnings, b.conformance], [true, [], [], { ok: true, errors: [], issues: [] }], e);
  }
  // check.mjs --profile massing on a massing; usage errors exit 2
  assert.equal(run('check.mjs', [mm.written.nbtPath, mm.written.jsonPath, '--profile', 'massing']).status, 0);
  assert.equal(run('check.mjs', [bad.written.nbtPath, bad.written.jsonPath, '--profile', 'massing']).status, 1);
  assert.equal(run('check.mjs', [bad.written.nbtPath, bad.written.jsonPath, '--profile', 'lit']).status, 2);
  assert.equal(run('check.mjs', [bad.written.nbtPath, bad.written.jsonPath, '--massing', path.join(tmp, 'nope.json')]).status, 2);
  assert.equal(run('build.mjs', ['cabin', '--out', tmp, '--massing', path.join(tmp, 'nope.json')]).status, 2);
  assert.equal(run('build.mjs', ['cabin', '--out', tmp, '--profile', 'massing']).status, 1);
});
