// Checker rules, each with a tiny passing and failing fixture (a 5x5 hut built with the kit).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Blueprint, palette } from '../lib/kit.mjs';
import { checkBlueprint, checkStructure } from '../lib/check.mjs';
import { plain } from '../lib/nbt.mjs';

const P = palette({ wood: 'oak', stone: 'cobblestone' });

/** A closed 5x5 hut (walls x/z 0..4, rows 1..3, flat roof on row 4), door south at x=2, lantern inside. */
function hut({ type = 'custom', size = [5, 5, 7], origin = [0, 0, 0], interior = [1, 1, 1, 3, 3, 3], door = true, light = true } = {}) {
  const bp = new Blueprint({ id: 'hut', type, size, origin, palette: P, interior, front: 'south' });
  bp.floor(0, 0, 4, 6, 0, P.stone);
  bp.carve([1, 1, 1, 3, 3, 3]);
  bp.walls(0, 0, 4, 4, 1, 3);
  bp.floor(0, 0, 4, 4, 4, P.planks);
  if (door) bp.door(2, 1, 4, 'south');
  if (light) bp.lantern(2, 3, 2, true);
  bp.spot('entrance', 2, 5, 180);
  bp.spot('spawn', 2, 6, 180);
  return bp;
}
const has = (list, re) => list.some((m) => re.test(m));
const clean = (r) => { assert.deepEqual(r.errors, []); assert.deepEqual(r.warnings, []); };

test('the hut fixture passes with no warnings', () => clean(checkBlueprint(hut())));

// ---------------------------------------------------------------- inherited rules: errors

test('palette: vanilla blocks only, every property explicit and valid', () => {
  const bp = hut();
  const s = plain(bp.toStructure());
  const sc = JSON.parse(JSON.stringify(bp.sidecar()));
  const variants = [
    [(st) => { st.palette[0].id = 'minecraft:not_a_block'; }, /unknown block/],
    [(st) => { st.palette[0].id = 'agentcraft:monitor'; }, /not a vanilla block/],
    [(st) => { const e = st.palette.find((p) => p.id === 'minecraft:oak_door'); delete e.properties.hinge; }, /'hinge' not written explicitly/],
    [(st) => { const e = st.palette.find((p) => p.id === 'minecraft:oak_door'); e.properties.facing = 'up'; }, /invalid value 'up'/],
  ];
  for (const [mutate, re] of variants) {
    const st = structuredClone(s);
    mutate(st);
    const r = checkStructure(sc, st);
    assert.ok(!r.ok && has(r.errors, re), `${re}: ${r.errors.join(' | ')}`);
  }
});

test('doors: an outside door exists and is written closed', () => {
  const none = checkBlueprint(hut({ door: false }));
  assert.ok(has(none.errors, /no outside door/), none.errors.join(' | '));
  const bp = hut();
  bp.set(2, 1, 4, P.door, { facing: 'south', half: 'lower', open: 'true' });
  bp.set(2, 2, 4, P.door, { facing: 'south', half: 'upper', open: 'true' });
  assert.ok(has(checkBlueprint(bp).errors, /written open/));
});

test('doors: an iron door needs a button on both sides on a conductive block; a wooden door does not', () => {
  clean(checkBlueprint(hut()));
  const iron = hut();
  iron.ironDoor(2, 1, 4, 'south');
  clean(checkBlueprint(iron));
  const noButtons = hut();
  noButtons.door(2, 1, 4, 'south', { block: 'minecraft:iron_door', buttons: false });
  assert.ok(has(checkBlueprint(noButtons).errors, /needs a button on both sides/));
  const glassJamb = hut();
  glassJamb.ironDoor(2, 1, 4, 'south', { jamb: 'minecraft:glass' });
  assert.ok(has(checkBlueprint(glassJamb).errors, /iron door .* needs a button/));
});

test('light: every standable interior cell is lit by vanilla sources', () => {
  const dark = checkBlueprint(hut({ light: false }));
  assert.ok(has(dark.errors, /light: 9 standable interior cell/), dark.errors.join(' | '));
  const invisible = hut({ light: false });
  invisible.set(2, 3, 2, 'minecraft:light', { level: 15 });
  assert.ok(has(checkBlueprint(invisible).errors, /light:/), 'the invisible light block does not count');
  const torch = hut({ light: false });
  torch.torch(1, 2, 2, 'east');
  clean(checkBlueprint(torch));
});

test('anchors: entrance and spawn present and standable', () => {
  const bp = hut();
  delete bp.anchors.spawn;
  assert.ok(has(checkBlueprint(bp).errors, /missing required anchor 'spawn'/));
  const inWall = hut();
  inWall.spot('entrance', 0, 2, 180);
  assert.ok(has(checkBlueprint(inWall).errors, /anchor entrance: feet cell/));
  const floating = hut();
  floating.spot('spawn', 2, 6, 180, { y: 3 });
  assert.ok(has(checkBlueprint(floating).errors, /anchor spawn: no solid block to stand on/));
});

test('size limit (--max) and type (--type)', () => {
  assert.ok(has(checkBlueprint(hut(), { max: { x: 4, y: 9, z: 9 } }).errors, /exceeds the limit/));
  clean(checkBlueprint(hut(), { max: { x: 5, y: 5, z: 7 } }));
  assert.ok(has(checkBlueprint(hut(), { type: 'tower' }).errors, /request asked for 'tower'/));
});

// ---------------------------------------------------------------- new rules: warnings

test('floating: blocks must connect to the ground; attachables through their support', () => {
  const base = hut({ size: [5, 8, 7] });
  base.set(2, 7, 2, P.planks); // a block in the air above the roof
  const r = checkBlueprint(base);
  assert.ok(r.ok, r.errors.join(' | '));
  assert.ok(has(r.warnings, /floating: 1 block\(s\).*oak_planks at 2,7,2/), r.warnings.join(' | '));
  const torch = hut();
  torch.set(2, 2, 6, 'minecraft:wall_torch', { facing: 'south' }); // its support (2,2,5) is air
  assert.ok(has(checkBlueprint(torch).warnings, /floating: 1 block\(s\).*wall_torch/));
  const ok = hut();
  ok.set(1, 2, 5, 'minecraft:wall_torch', { facing: 'south' }); // on the front wall
  clean(checkBlueprint(ok));
});

test('reachability: every floor level reachable from the entrance (ladders, stairs; max step 1)', () => {
  const two = (withLadder) => {
    const bp = new Blueprint({ id: 'hut', size: [5, 9, 7], palette: P, interior: [1, 1, 1, 3, 7, 3] });
    bp.floor(0, 0, 4, 6, 0, P.stone);
    bp.carve([1, 1, 1, 3, 7, 3]);
    bp.walls(0, 0, 4, 4, 1, 7);
    bp.floor(1, 1, 3, 3, 4, P.planks);
    bp.floor(0, 0, 4, 4, 8, P.planks);
    bp.door(2, 1, 4, 'south');
    bp.lantern(3, 3, 3, true);
    bp.lantern(3, 7, 3, true);
    if (withLadder) bp.ladder(1, 1, 1, 4, 'south');
    bp.spot('entrance', 2, 5, 180);
    bp.spot('spawn', 2, 6, 180);
    return bp;
  };
  clean(checkBlueprint(two(true)));
  const r = checkBlueprint(two(false));
  assert.ok(has(r.warnings, /floor level y=5 .* cannot be reached/), r.warnings.join(' | '));
  // a 2-high step without stairs is not walkable
  const step = two(false);
  step.set(1, 1, 1, P.planks);
  step.set(1, 2, 1, P.planks);
  step.set(1, 3, 1, P.planks);
  assert.ok(has(checkBlueprint(step).warnings, /y=5 .* cannot be reached/));
  // a staircase is
  const stairs = two(false);
  stairs.stairRun(1, 1, 3, 'north', 3, { headroom: 2 });
  stairs.set(1, 4, 0, P.planks);
  assert.ok(!has(checkBlueprint(stairs).warnings, /cannot be reached/), checkBlueprint(stairs).warnings.join(' | '));
});

test('doors: the front door is on the front face and reachable from the entrance', () => {
  const back = hut({ door: false, size: [5, 5, 8], origin: [0, 0, 1] });
  back.door(2, 1, 0, 'north');
  back.floor(0, -1, 4, -1, 0, P.stone);
  const r = checkBlueprint(back);
  assert.ok(has(r.warnings, /no outside door on the south \(front\) face/), [...r.errors, ...r.warnings].join(' | '));
  const blocked = hut();
  for (const [x, z] of [[1, 5], [3, 5], [1, 6], [2, 6], [3, 6]]) blocked.set(x, 1, z, P.fence); // a pen in front of the door
  blocked.spot('entrance', 0, 6, 180);
  blocked.spot('spawn', 0, 6, 180);
  assert.ok(has(checkBlueprint(blocked).warnings, /cannot be walked to from the entrance/));
});

test('enclosure: a roof over every interior cell and no gaps in the walls', () => {
  const sky = hut();
  sky.air(2, 4, 3);
  sky.set(1, 3, 3, 'minecraft:wall_torch', { facing: 'east' });
  const r = checkBlueprint(sky);
  assert.ok(has(r.warnings, /open to the sky/), r.warnings.join(' | '));
  const glass = hut();
  glass.set(2, 4, 3, 'minecraft:glass');
  clean(checkBlueprint(glass));
  const gap = hut();
  gap.air(0, 2, 2);
  assert.ok(has(checkBlueprint(gap).warnings, /through the walls/));
  const doorway = hut({ door: false, size: [5, 5, 8], origin: [0, 0, 1] });
  doorway.carve([2, 1, 4, 2, 2, 4]);
  doorway.door(2, 1, 0, 'north');
  doorway.floor(0, -1, 4, -1, 0, P.stone);
  assert.ok(has(checkBlueprint(doorway).warnings, /doorway without a door/));
});

test('interior volume per type', () => {
  const r = checkBlueprint(hut({ type: 'cabin' }));
  assert.ok(has(r.warnings, /cabin: interior volume 26 is under the 60/), r.warnings.join(' | '));
  assert.ok(!has(checkBlueprint(hut({ type: 'custom' })).warnings, /volume/));
});

test('tower profile: height >= 2 x footprint, 3 reachable floors', () => {
  const r = checkBlueprint(hut({ type: 'tower' }));
  assert.ok(has(r.warnings, /tower: 4 blocks tall above the ground on a 5-wide footprint/), r.warnings.join(' | '));
  assert.ok(has(r.warnings, /tower: 1 floor level\(s\) reachable/));
});

test('barn profile: an entrance at least 3 wide and 3 tall', () => {
  const barn = (open) => {
    const bp = new Blueprint({ id: 'hut', type: 'barn', size: [7, 6, 9], palette: P, interior: [1, 1, 1, 5, 4, 5] });
    bp.floor(0, 0, 6, 8, 0, P.stone);
    bp.carve([1, 1, 1, 5, 4, 5]);
    bp.walls(0, 0, 6, 6, 1, 4);
    bp.floor(0, 0, 6, 6, 5, P.planks);
    bp.ceilingLights(1, 1, 5, 5, 4);
    if (open) bp.carve([2, 1, 6, 4, 3, 6]);
    else bp.door(3, 1, 6, 'south');
    bp.spot('entrance', 3, 7, 180);
    bp.spot('spawn', 3, 8, 180);
    return bp;
  };
  clean(checkBlueprint(barn(true)));
  assert.ok(has(checkBlueprint(barn(false)).warnings, /barn: no entrance at least 3 wide/));
});

test('gatehouse profile: a passage through, at least 3 wide and 3 tall', () => {
  const gate = (blocked) => {
    const bp = new Blueprint({ id: 'hut', type: 'gatehouse', size: [9, 5, 6], palette: P, interior: [1, 1, 1, 1, 3, 3] });
    bp.floor(0, 0, 8, 4, 0, P.stone);
    bp.carve([1, 1, 1, 1, 3, 3]);
    bp.walls(0, 0, 2, 4, 1, 3);
    bp.walls(6, 0, 8, 4, 1, 3);
    bp.floor(0, 0, 8, 4, 4, P.stone);
    bp.carve([3, 1, 0, 5, 3, 4]);
    bp.door(1, 1, 4, 'south');
    bp.lantern(1, 3, 2, true);
    if (blocked) bp.set(4, 2, 2, 'minecraft:iron_bars');
    bp.spot('entrance', 4, 4, 180);
    bp.spot('spawn', 4, 4, 180);
    bp.floor(0, 5, 8, 5, 0, P.stone);
    return bp;
  };
  clean(checkBlueprint(gate(false)));
  const r = checkBlueprint(gate(true));
  assert.ok(r.ok, r.errors.join(' | '));
  assert.ok(has(r.warnings, /gatehouse: no passage .* \(widest: 1\)/), r.warnings.join(' | '));
});
