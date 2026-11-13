// (7b DM, docs/CONTRACT.md "Slice DM as built") The disturbance rule DM-1 (tools/lib/scenario-sb.mjs lotDisturbance, carveBuilding) on
// hand-built fixtures: a carve_into lot's carved, enclosed, entered room and its shell count as building; an open pit, an open doorway, a
// gap stopped by only a torch and a sealed void nobody can enter stay disturbance; a wrap_trunk lot is unchanged (every cut counts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { lotDisturbance, carveBuilding, DISTURBANCE_RULE } from '../../tools/lib/scenario-sb.mjs';
import { stateClass } from '../lib/region/sculpt.mjs';

// a hill: stone up to y = 7 (the lot box's top), air over it (the sky) and at z >= 10 (the hall in front of the lot)
const BOX = { minX: 0, maxX: 9, minY: 0, maxY: 7, minZ: 0, maxZ: 9 };
const lot = (fit) => ({ id: `lot_${fit}`, box: BOX, site: { fit } });
const STONE = 'minecraft:stone', AIR = 'minecraft:air', PLANKS = 'minecraft:spruce_planks';
const door = (half, open = 'false') => `minecraft:spruce_door[facing=south,half=${half},hinge=left,open=${open},powered=false]`;
const hill = (x, y, z) => (y > 7 || z >= 10 ? AIR : STONE);
const k = (x, y, z) => `${x},${y},${z}`;

/** The world after: the hill with `edits` (a Map of cells to states) written. */
const world = (edits) => (x, y, z) => edits.get(k(x, y, z)) ?? hill(x, y, z);

/** A carved home: a 6x3x6 room (x, z 2..7, y 1..3) in a one-thick plank shell (x, z 1..8, y 0..4), its door in the south wall
 * (x 4, z 8, y 1..2) and the entrance cut in front of it (x 4, z 9, y 1..2) open to the hall. `doorway` writes the doorway's two cells. */
function home({ doorway = [door('lower'), door('upper')] } = {}) {
  const e = new Map();
  for (let x = 1; x <= 8; x++) for (let z = 1; z <= 8; z++) for (let y = 0; y <= 4; y++) {
    const inside = x >= 2 && x <= 7 && z >= 2 && z <= 7 && y >= 1 && y <= 3;
    e.set(k(x, y, z), inside ? AIR : PLANKS);
  }
  if (doorway) { e.set(k(4, 1, 8), doorway[0]); e.set(k(4, 2, 8), doorway[1]); }
  e.set(k(4, 1, 9), AIR); e.set(k(4, 2, 9), AIR);
  return e;
}
const score = (fit, edits) => lotDisturbance({ lot: lot(fit), stBefore: hill, stAfter: world(edits), cls: stateClass, inTemplate: () => true });
const VOL = 10 * 8 * 10;

test('DM-1: a carved room behind a door counts as building (interior and shell), only the open entrance cut counts', async () => {
  const d = await score('carve_into', home());
  assert.equal(d.rule, DISTURBANCE_RULE);
  assert.equal(d.cut, 8 * 8 * 5 + 2, 'raw cut: the shell box and the entrance');
  assert.equal(d.cutInterior, 6 * 3 * 6);
  assert.equal(d.cutShell, 8 * 8 * 5 - 6 * 3 * 6, 'every plank and the door: within one cell of the room');
  assert.equal(d.cutCounted, 2, 'the entrance cut is open to the hall');
  assert.equal(d.fill, 0);
  assert.equal(d.disturbance, Math.round((2 / VOL) * 1e4) / 1e4);
  // an open door is still a door: it seals
  const open = await score('carve_into', home({ doorway: [door('lower', 'true'), door('upper', 'true')] }));
  assert.equal(open.cutCounted, 2);
});

test('DM-1: an open pit inside a carve_into lot counts as disturbance', async () => {
  const e = new Map();
  for (let x = 3; x <= 6; x++) for (let z = 3; z <= 6; z++) for (let y = 3; y <= 7; y++) e.set(k(x, y, z), AIR);
  const d = await score('carve_into', e);
  assert.equal(d.cut, 4 * 4 * 5);
  assert.equal(d.cutInterior + d.cutShell, 0);
  assert.equal(d.cutCounted, d.cut);
  // the same pit floored and walled in planks is still open to the sky: its planks are not a shell
  for (let x = 2; x <= 7; x++) for (let z = 2; z <= 7; z++) if (!(x >= 3 && x <= 6 && z >= 3 && z <= 6)) for (let y = 2; y <= 7; y++) e.set(k(x, y, z), PLANKS);
  const w = await score('carve_into', e);
  assert.equal(w.cutCounted, w.cut);
});

test('DM-1: a doorway with no door, or a gap stopped only by a torch, leaves the room open: all of its cut counts', async () => {
  for (const doorway of [[AIR, AIR], ['minecraft:torch', 'minecraft:torch'], ['minecraft:white_carpet', 'minecraft:oak_sign[rotation=0,waterlogged=false]']]) {
    const d = await score('carve_into', home({ doorway }));
    assert.equal(d.cutInterior + d.cutShell, 0, `doorway ${doorway.join(' / ')}`);
    assert.equal(d.cutCounted, d.cut);
  }
  // glass panes are windows: they seal (the room has its door too)
  const e = home();
  e.set(k(6, 2, 8), 'minecraft:glass_pane[east=false,north=false,south=false,waterlogged=false,west=false]');
  e.set(k(6, 2, 9), AIR); e.set(k(6, 1, 9), AIR);
  const g = await score('carve_into', e);
  assert.equal(g.cutInterior, 6 * 3 * 6);
  assert.equal(g.cutCounted, 4, 'the entrance and the cut in front of the window');
});

test('DM-1: a sealed void nobody can enter is excavation, not a room', async () => {
  const d = await score('carve_into', home({ doorway: [PLANKS, PLANKS] }));
  assert.equal(d.cutInterior + d.cutShell, 0);
  assert.equal(d.cutCounted, d.cut);
});

test('DM-1: a wrap_trunk lot is unchanged: every cut cell counts, as rule SB-1 did', async () => {
  const d = await score('wrap_trunk', home());
  assert.equal(d.cut, 8 * 8 * 5 + 2);
  assert.equal(d.cutInterior + d.cutShell, 0);
  assert.equal(d.cutCounted, d.cut);
  assert.equal(d.disturbance, Math.round((d.cut / VOL) * 1e4) / 1e4);
});

test('DM-1: carveBuilding is deterministic and judges only the box', async () => {
  const a = await carveBuilding({ box: BOX, stBefore: hill, stAfter: world(home()) });
  const b = await carveBuilding({ box: BOX, stBefore: hill, stAfter: world(home()) });
  for (let x = -1; x <= 10; x++) for (let y = -1; y <= 8; y++) for (let z = -1; z <= 10; z++) assert.equal(a.kind(x, y, z), b.kind(x, y, z));
  assert.equal(a.kind(4, 2, 4), 'interior');
  assert.equal(a.kind(1, 2, 4), 'shell');
  assert.equal(a.kind(4, 1, 9), null, 'the entrance cut');
  assert.equal(a.kind(4, 2, 10), null, 'outside the box');
});
