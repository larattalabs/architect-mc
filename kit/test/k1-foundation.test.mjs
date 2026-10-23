// Phase 7a slice K1, the shared foundation (docs/CONTRACT.md "Phase 7a slice K1" §1, §6, §7; K1a and K1b build on it): lenient
// params, the bible's connector roles, the bill of materials by C26's rules (its map held equal to the mod's), the route pass's
// special-move table and the validator's K1 rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './plan-helpers.mjs';
import { readParams } from '../lib/connectors/params.mjs';
import { connectorRoles, connectorsError, shapeOf, doorOf } from '../lib/connectors/style.mjs';
import { COSTS, bomOf, itemsOf } from '../lib/connectors/bom.mjs';
import { SPECIAL_MOVES } from '../lib/region/passes/route.mjs';
import { validatePlan, wallForm } from '../lib/plan/schema.mjs';
import { resolveRoles } from '../lib/region/plan.mjs';

test('lenient params: read where they map, every other key listed, lot-naming keys are joins', () => {
  const castle = { kind: 'wall', where: { around: { feature: { part: 'castle' }, closed: true } }, params: { height: 8, wall_walk: true, gate_lot: 'gatehouse_1', corner_lots: ['tower_1', 'tower_2'] } };
  const a = readParams('wall', castle);
  assert.deepEqual(a.read, { height: 8 });
  assert.deepEqual(a.unread, ['corner_lots', 'gate_lot', 'wall_walk']);
  assert.deepEqual(a.joins, [{ key: 'corner_lots', lot: 'tower_1' }, { key: 'corner_lots', lot: 'tower_2' }, { key: 'gate_lot', lot: 'gatehouse_1' }]);
  assert.deepEqual(a.notes, ['params.corner_lots not read', 'params.gate_lot not read', 'params.wall_walk not read']);
  // a first-class member wins over params; torches -> lamps every; gates as a number -> gates.min
  const b = readParams('wall', { kind: 'wall', height: 5, lamps: 'none', params: { height: 9, torches: true, gates: 4, material: 'stone' } });
  assert.deepEqual(b.read, { gatesMin: 4 });
  assert.deepEqual(b.unread, ['height', 'material', 'torches']);
  const c = readParams('wall', { kind: 'wall', params: { height: 30, closed: false, torches: true } });
  assert.deepEqual(c.read, { closed: false, lamps: 'every' });
  assert.deepEqual(c.notes, ['params.height not read (outside 3..16)']);
  // a gate's params are never read
  assert.deepEqual(readParams('gate', { kind: 'gate', params: { portcullis: true } }).unread, ['portcullis']);
});

test('connector roles: the bible names roles, else the contract defaults (§6, N-K1-1, N-K1-2)', () => {
  const roles = resolveRoles({});
  const d = connectorRoles(roles, null);
  assert.deepEqual({ wall: d.wall, gate: d.gate, rope_bridge: d.rope_bridge }, { wall: { body: 'structure', cap: 'trim', frame: 'trim', walk: null, parapet: null }, gate: { frame: 'trim', door: null }, rope_bridge: { deck: 'floor', rail: 'rail', post: 'frame', rope: null } });
  const g = connectorRoles(roles, { wall: { body: 'wall_alt' }, rope_bridge: { rope: 'none' } });
  assert.equal(g.wall.body, 'wall_alt');
  assert.equal(g.rope_bridge.rope, 'none');
  assert.equal(connectorsError({ wall: { body: 'nope' } }, roles), "connectors.wall.body: 'nope' is not a role of this bible");
  assert.equal(connectorsError({ moat: {} }, roles), "connectors: unknown member 'moat' (one of wall, gate, rope_bridge, bridge, tunnel, stair, switchback, ladder, rock_stair, lift, catwalk, stairs_around)");
  assert.equal(shapeOf('minecraft:stone_bricks', 'wall'), 'minecraft:stone_brick_wall');
  assert.equal(shapeOf('minecraft:spruce_log', 'slab'), 'minecraft:spruce_slab');
  assert.equal(shapeOf('minecraft:glass', 'wall'), null);
  assert.equal(doorOf('minecraft:spruce_log'), 'minecraft:spruce_door');
  assert.equal(doorOf('minecraft:mossy_cobblestone'), 'minecraft:oak_door');
});

test('the bill of materials: C26\'s rules, and the obtainability map equal to the mod\'s', () => {
  const mod = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod', 'src', 'main', 'resources', 'data', 'architect_mc', 'survival_items.json'), 'utf8'));
  assert.deepEqual(COSTS, mod.costs, 'kit/lib/connectors/bom.mjs COSTS equals survival_items.json costs');
  assert.deepEqual(itemsOf('minecraft:spruce_door[facing=north,half=upper,hinge=left,open=false,powered=false]'), []);
  assert.deepEqual(itemsOf('minecraft:stone_brick_slab[type=double,waterlogged=false]'), [['minecraft:stone_brick_slab', 2]]);
  assert.deepEqual(itemsOf('minecraft:dirt_path'), [['minecraft:dirt', 1]]);
  assert.deepEqual(itemsOf('minecraft:wall_torch[facing=east]'), [['minecraft:torch', 1]]);
  assert.deepEqual(itemsOf('minecraft:air'), []);
  assert.deepEqual(bomOf(['minecraft:stone_bricks', 'minecraft:stone_bricks', 'minecraft:oak_door[half=lower]', 'minecraft:oak_door[half=upper]', 'minecraft:lantern[hanging=false]']),
    { 'minecraft:lantern': 1, 'minecraft:oak_door': 1, 'minecraft:stone_bricks': 2 });
});

test('the route pass\'s special-move table: the frozen interface, gate then rope (6c T3 appends bridge and tunnel)', () => {
  assert.deepEqual(SPECIAL_MOVES.slice(0, 2).map((m) => [m.name, m.code, m.segment, m.flag]), [['gate', 5, 'gate', false], ['rope', 6, 'rope', true]]);
  for (const m of SPECIAL_MOVES) for (const f of ['init', 'active', 'needsFlag', 'blocks', 'expand', 'cells', 'commit']) assert.equal(typeof m[f], 'function', `${m.name}.${f}`);
  // off without walls or rope edges: init returns null (the pass is T2's)
  const env = { W: 4, D: 4, r: 1, minX: 0, minZ: 0 };
  for (const m of SPECIAL_MOVES) assert.equal(m.init(env, { edges: [] }), null, m.name);
});

test('the validator: R15 path forms, R16 references, wall.along reserved, a gate\'s one wall implicit', () => {
  const zone = { id: 'town', program: { lots: [{ id: 'h1', type: 'house', size: [9, 9] }] } };
  const v = (connectors) => validatePlan({ schemaVersion: 'plan/0', zones: [zone], connectors });
  const p = (r, id) => r.parts.find((x) => x.id === id);
  assert.equal(wallForm({ from: { anchor: 'claim_n' }, to: { anchor: 'claim_s' } }), 'line');
  assert.equal(wallForm({ where: { inside: { claim: true } } }), 'edge');
  assert.equal(wallForm({ where: { around: { feature: { part: 'x' } } }, from: { anchor: 'claim_n' } }), null);
  const two = v([{ id: 'w', kind: 'wall', where: { around: { feature: { part: 'town' } } }, from: { anchor: 'claim_n' }, to: { anchor: 'claim_s' } }]);
  assert.equal(p(two, 'w').verdict, 'malformed');
  assert.match(p(two, 'w').reason.message, /R15/);
  const none = v([{ id: 'w', kind: 'wall' }]);
  assert.equal(p(none, 'w').verdict, 'malformed');
  const along = v([{ id: 'w', kind: 'wall', where: { along: { feature: { water: {} } } } }]);
  assert.equal(p(along, 'w').verdict, 'unsupported');
  assert.equal(p(along, 'w').block, 'wall.along');
  assert.equal(p(along, 'w').reason.until, 'K2');
  const g = v([{ id: 'w', kind: 'wall', where: { around: { feature: { part: 'town' } } } }, { id: 'r', kind: 'road', from: { anchor: 'claim_e' }, to: { part: 'town' } }, { id: 'g', kind: 'gate', crossing: 'r' }]);
  assert.deepEqual(p(g, 'g').deps, ['r', 'w'], 'a gate depends on its crossing and (implicitly) the plan\'s one wall');
  const bad = v([{ id: 'w', kind: 'wall', where: { around: { feature: { part: 'town' } } } }, { id: 'g', kind: 'gate', wall: 'town', crossing: 'w' }]);
  assert.equal(p(bad, 'g').verdict, 'malformed');
  assert.equal(p(bad, 'g').reason.code, 'UNKNOWN_REF');
  // the recorded shapes: a gate written from/to validates (read as at)
  const rec = v([{ id: 'w', kind: 'wall', where: { around: { feature: { part: 'town' }, ring: [2, 4], closed: true } }, params: { joins: ['h1'] } }, { id: 'mg', kind: 'gate', from: { part: 'town', port: 'h1' }, to: { anchor: 'claim_center' } }]);
  for (const id of ['w', 'mg']) assert.equal(p(rec, id).verdict, 'compile', `${id}: ${JSON.stringify(p(rec, id).reason)}`);
});
