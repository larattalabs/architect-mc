// (7c US) Inverted builds (docs/CONTRACT.md "Phase 7c" §3 row 10, "Slice US as built"): bp.invert() (lib/invert.mjs) exact over every
// block state family (a property test over every state of every kit block); invertBlueprint's mapping; the inverted example
// fit_suspend_inverted built into the 7bF fixture `overhang`, current in kit/examples and clean on the composite (SC's fit:suspend, neck
// and cantilever included); rule.suspended supported (an elevated zone's lots on overhangs only, each marked inverted), its refusals, the
// catalogue flip; the recorded ask upside_down re-planned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCKS, supportOf } from '../lib/blocks.mjs';
import { flipOf, invertProps, invertBlueprint, INVERT_KEYS } from '../lib/invert.mjs';
import { Blueprint } from '../lib/kit.mjs';
import { parse, plain } from '../lib/nbt.mjs';
import { siteFixture } from '../lib/siteFixture.mjs';
import { buildExample } from '../tools/examples.mjs';
import { planCatalogue, diffCatalogues } from '../lib/plan/catalogue.mjs';
import { asksSurvey, stewardAnchors, checkPlanVolumes, FIX } from './plan-helpers.mjs';
import { read, run } from './plan-p0-shared.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'us-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---------------------------------------------------------------- the flip, every state of every block

/** Every state of a block: its property domain enumerated (last property fastest). */
function* states(dom) {
  const keys = Object.keys(dom);
  const vals = keys.map((k) => [...dom[k]]);
  const n = vals.reduce((a, v) => a * v.length, 1);
  for (let i = 0; i < n; i++) {
    let j = i;
    const s = {};
    for (let k = keys.length - 1; k >= 0; k--) { s[keys[k]] = vals[k][j % vals[k].length]; j = Math.floor(j / vals[k].length); }
    yield s;
  }
}

/** The values that say up or down (a property that has one must change on an exact flip). */
const VERTICAL = { half: ['top', 'bottom', 'upper', 'lower'], type: ['top', 'bottom'], hanging: ['true', 'false'], face: ['floor', 'ceiling'], attachment: ['floor', 'ceiling'], facing: ['up', 'down'], vertical_direction: ['up', 'down'] };
const vert = (s) => (s ?? []).filter((v) => v[1] !== 0).map((v) => v[1]).sort();

/** The block families with states that have no upside-down twin, and how many such states each has (the NO_FLIP list, measured). */
const NO_FLIP = {
  banner: 256, bed: 272, block: 22, cake: 41, candle: 272, carpet: 179, ceiling_plant: 5, diode: 80, double_plant: 42, flower_pot: 40,
  hanging_sign: 832, multiface: 23, plant: 439, pressure_plate: 62, rail: 92, redstone_wire: 1296, sign: 416, skull: 224, snow_layer: 8, torch: 5,
};

test('the flip is exact over every block state family: an involution, inside each domain, only the vertical properties, each up/down value flipped', () => {
  let n = 0, exact = 0;
  const bad = [];
  const none = {};
  for (const [name, d] of Object.entries(BLOCKS)) {
    const dom = d.props ?? {};
    for (const s of states(dom)) {
      n++;
      const f = flipOf(name, s);
      // an involution: flipped twice is the state again
      if (JSON.stringify(invertProps(name, f.props)) !== JSON.stringify(s)) bad.push(`${name} ${JSON.stringify(s)}: not an involution`);
      // inside the block's domain, the same keys
      assert.deepEqual(Object.keys(f.props).sort(), Object.keys(s).sort(), name);
      for (const [k, v] of Object.entries(f.props)) if (![...dom[k]].includes(v)) bad.push(`${name}.${k}=${v}: outside its domain`);
      // only the vertical properties change
      for (const k of Object.keys(s)) if (f.props[k] !== s[k] && !INVERT_KEYS.includes(k)) bad.push(`${name}.${k} changed`);
      if (!f.exact) { none[d.family] = (none[d.family] ?? 0) + 1; continue; }
      exact++;
      // an exact flip turns every up/down value (half, slab type, hanging, face, attachment, a vertical facing, vertical_direction) ...
      for (const [k, vs] of Object.entries(VERTICAL)) if (k in s && vs.includes(s[k])) {
        if (f.props[k] === s[k]) bad.push(`${name} ${k}=${s[k]}: exact but unflipped`);
      }
      if ('up' in s && 'down' in s && f.props.up !== s.down) bad.push(`${name}: up/down not swapped`);
      // ... and a one-way vertical bearing the other way (a door's pair swaps halves with its cells: each still bears below)
      const b0 = vert(supportOf({ name, props: s })), b1 = vert(supportOf({ name, props: f.props }));
      const oneWay = (v) => v.length > 0 && !(v.includes(1) && v.includes(-1));
      if (d.family !== 'door' && oneWay(b0) && JSON.stringify(b1) !== JSON.stringify(b0.map((x) => -x).sort())) bad.push(`${name} ${JSON.stringify(s)}: bears ${b0} before, ${b1} after`);
    }
  }
  assert.deepEqual(bad.slice(0, 12), [], `${bad.length} problem(s)`);
  assert.ok(n > 30000, `${n} states enumerated`);
  // the states with no twin: floor-only and ceiling-only attachables, the hopper facing down, a crafter or jigsaw whose top is up
  assert.deepEqual(none, NO_FLIP);
  assert.equal(exact + Object.values(NO_FLIP).reduce((a, b) => a + b, 0), n);
});

test('the named families flip as the contract says: stairs, slabs, trapdoors, doors and lanterns', () => {
  assert.deepEqual(invertProps('minecraft:oak_stairs', { facing: 'east', half: 'bottom', shape: 'outer_left', waterlogged: 'false' }), { facing: 'east', half: 'top', shape: 'outer_left', waterlogged: 'false' });
  assert.deepEqual(invertProps('minecraft:oak_slab', { type: 'bottom', waterlogged: 'false' }), { type: 'top', waterlogged: 'false' });
  assert.deepEqual(invertProps('minecraft:oak_slab', { type: 'double', waterlogged: 'false' }), { type: 'double', waterlogged: 'false' });
  assert.equal(invertProps('minecraft:spruce_trapdoor', { facing: 'north', half: 'top', open: 'false', powered: 'false', waterlogged: 'false' }).half, 'bottom');
  assert.equal(invertProps('minecraft:oak_door', { facing: 'south', half: 'lower', hinge: 'left', open: 'false', powered: 'false' }).half, 'upper');
  assert.equal(invertProps('minecraft:lantern', { hanging: 'false', waterlogged: 'false' }).hanging, 'true');
  assert.equal(invertProps('minecraft:bell', { attachment: 'floor', facing: 'north', powered: 'false' }).attachment, 'ceiling');
  assert.equal(invertProps('minecraft:pointed_dripstone', { thickness: 'tip', vertical_direction: 'down', waterlogged: 'false' }).vertical_direction, 'up');
  assert.equal(invertProps('minecraft:crafter', { crafting: 'false', orientation: 'down_east', triggered: 'false' }).orientation, 'up_east');
  assert.equal(flipOf('minecraft:crafter', { crafting: 'false', orientation: 'north_up', triggered: 'false' }).exact, false);
  assert.equal(flipOf('minecraft:hopper', { enabled: 'true', facing: 'down' }).exact, false);
  assert.equal(flipOf('minecraft:torch', {}).exact, false);
  assert.equal(flipOf('minecraft:oak_log', { axis: 'y' }).exact, true);
});

test('invertBlueprint: cells, parts, ports, anchors and the interior mapped; twice is the original; a cell with no twin refused', () => {
  const make = () => {
    const bp = new Blueprint({ id: 'u', size: [5, 6, 4], interior: [1, 1, 1, 3, 2, 2] });
    bp.part('main', (b) => {
      b.set(0, 0, 0, 'minecraft:oak_stairs', { facing: 'east', half: 'bottom', shape: 'straight' });
      b.set(1, 1, 0, 'minecraft:oak_slab', { type: 'top' });
      b.lantern(2, 2, 2, false);
      b.door(3, 1, 3, 'south');
    });
    bp.port('p', 'architect:walk', 2, 0, 1, 'down');
    bp.anchor('a', 1.5, 1, 1.5, 90, 10);
    return bp;
  };
  const bp = make();
  bp.invert();
  assert.equal(bp.inverted, true);
  assert.deepEqual(bp.cells.get('0,5,0').state.props, { facing: 'east', half: 'top', shape: 'straight', waterlogged: 'false' });
  assert.equal(bp.cells.get('1,4,0').state.props.type, 'bottom');
  assert.equal(bp.cells.get('2,3,2').state.props.hanging, 'true');
  assert.equal(bp.cells.get('3,4,3').state.props.half, 'upper'); // the door's old lower half, on top now
  assert.equal(bp.cells.get('3,3,3').state.props.half, 'lower');
  assert.equal(bp.cellPart.get('0,5,0'), 'main');
  assert.deepEqual(bp.ports[0], { name: 'p', kind: 'architect:walk', x: 2, y: 5, z: 1, facing: 'up' });
  assert.deepEqual(bp.anchors.a, { x: 1.5, y: 5, z: 1.5, yaw: 90, pitch: -10 });
  assert.equal(bp.interiorBox.minY, 3);
  assert.equal(bp.interiorBox.maxY, 4);
  assert.equal(bp.sidecar().inverted, true);
  bp.invert();
  const a = make();
  assert.deepEqual([...bp.cells].sort(), [...a.cells].sort());
  assert.deepEqual(bp.ports, a.ports);
  assert.deepEqual(bp.anchors, a.anchors);
  assert.deepEqual(bp.interiorBox, a.interiorBox);
  assert.equal(bp.sidecar().inverted, undefined);
  // no twin: refused, or kept on request
  const t = new Blueprint({ id: 't', size: [3, 3, 3] });
  t.set(1, 1, 1, 'minecraft:torch');
  assert.throws(() => t.invert(), /1 cell\(s\) have no upside-down state \(minecraft:torch at 1,1,1\)/);
  t.invert({ unflipped: 'keep' });
  assert.equal(t.cells.get('1,1,1').state.name, 'minecraft:torch');
  // every other design's bytes: no `inverted` key
  assert.equal(make().sidecar().inverted, undefined);
});

// ---------------------------------------------------------------- the inverted example

const ID = 'fit_suspend_inverted';
let built = null;
const example = async () => (built ??= await buildExample(ID, { out: path.join(tmp, 'ex', ID) }));

test('the inverted example: built into `overhang`, clean on the composite (fit:suspend, neck, cantilever, ports_met), current in kit/examples', async () => {
  const r = await example();
  assert.ok(r.ok, r.problems.join(' | '));
  assert.deepEqual(r.result.errors, []);
  assert.deepEqual(r.result.warnings, []);
  assert.deepEqual(r.result.site.findings, []);
  assert.equal(r.result.site.fit, 'suspend');
  assert.deepEqual(r.result.site.metrics.portsMet, ['hatch']);
  for (const f of [`${ID}.nbt`, `${ID}.blueprint.json`, `${ID}.parts.nbt`, `${ID}.mjs`]) {
    assert.deepEqual(fs.readFileSync(path.join(tmp, 'ex', ID, f)), fs.readFileSync(path.join(KIT, 'examples', ID, f)), `${f}: kit/examples is out of date (node kit/tools/examples.mjs ${ID})`);
  }
  const sc = JSON.parse(fs.readFileSync(path.join(KIT, 'examples', ID, `${ID}.blueprint.json`), 'utf8'));
  assert.equal(sc.inverted, true);
  assert.equal(sc.site.volumeSha, siteFixture('overhang').sha);
  assert.ok(sc.interior && sc.anchors.entrance && sc.anchors.spawn);
});

test('the inverted example hangs the right way up: the old floor under the rock, the flipped states in place, every cell bearing up', async () => {
  await example();
  const st = plain(parse(fs.readFileSync(path.join(KIT, 'examples', ID, `${ID}.nbt`))));
  const site = siteFixture('overhang');
  const H = site.size.y;
  const cells = new Map(st.blocks.map((b) => [b.pos.join(','), st.palette[b.state]]));
  const at = (x, y, z) => cells.get(`${x},${y},${z}`);
  const props = (c) => c?.Properties ?? c?.properties ?? {};
  // the top row (under the rock) is the old floor slab; the rock is the row over it
  const hang = site.hangPoints();
  for (const [x, y, z] of hang) { assert.equal(y, H); assert.notEqual(at(x, H - 1, z)?.Name ?? at(x, H - 1, z)?.id, undefined); }
  const all = [...cells.values()];
  const name = (c) => c.Name ?? c.id;
  // the roof's stairs upside down (half top), the hatch trapdoor half top, the lanterns hanging, the door upright on the new floor
  const stairs = all.filter((c) => /_stairs$/.test(name(c)) && !/chair/.test(name(c)));
  assert.ok(stairs.length > 20 && stairs.filter((c) => props(c).half === 'top').length >= stairs.length - 2, 'the keel\'s stairs are top-half');
  const lanterns = all.filter((c) => /lantern$/.test(name(c)));
  assert.ok(lanterns.length === 2 && lanterns.every((c) => props(c).hanging === 'true'));
  const doors = [...cells].filter(([, c]) => /_door$/.test(name(c)));
  const lower = doors.find(([, c]) => props(c).half === 'lower'), upper = doors.find(([, c]) => props(c).half === 'upper');
  assert.equal(Number(lower[0].split(',')[1]) + 1, Number(upper[0].split(',')[1]), 'the door stands the right way up');
  const floor = Number(lower[0].split(',')[1]) - 1;
  assert.ok(at(Number(lower[0].split(',')[0]), floor, Number(lower[0].split(',')[2])), 'the door stands on the new floor');
  const trap = all.filter((c) => /_trapdoor$/.test(name(c)));
  assert.equal(trap.length, 1);
  assert.equal(props(trap[0]).half, 'top');
  // SC's support rule judged it: every structural cell bears up through the house to the rock (no fit:suspend finding, above)
  const r = await example();
  assert.ok(!r.result.site.findings.some((f) => f.rule === 'fit:suspend' || f.rule === 'neck' || f.rule === 'cantilever'));
});

// ---------------------------------------------------------------- rule.suspended in plan/0

const V = read('valid').find((f) => f.name === 'v7c_us_hanging.json');

test('rule.suspended: the zone\'s lots are suspend site lots on overhangs only, each marked inverted (IR lot, artifact lot); stable', async () => {
  const r = await run(V);
  assert.equal(r.check.overall, 'READY');
  const z = r.check.parts.find((p) => p.part === 'hanging');
  assert.equal(z.class, 'fits');
  assert.equal(r.check.parts.find((p) => p.part === 'hang_inverted').class, 'fits');
  const lots = r.artifact.lots;
  assert.deepEqual(lots.map((l) => l.id).sort(), ['home_a', 'home_b']);
  for (const l of lots) {
    assert.equal(l.inverted, true);
    assert.equal(l.site.fit, 'suspend');
    assert.equal(l.affordance.kind, 'overhang');
    assert.equal(l.site.keepCritical.length, 4, 'the four hang points');
    assert.equal(r.res.ir.lots.find((x) => x.id === l.id).inverted, true);
  }
  assert.equal((await run(V)).artifactSha, r.artifactSha, 'deterministic');
  // the same plan without the rule: the same lots, none marked inverted (the rule adds only the mark here: the land holds only overhangs)
  const plain_ = await run({ ...V, plan: { ...V.plan, rules: [] } });
  assert.deepEqual(plain_.artifact.lots.map((l) => [l.id, l.box]), lots.map((l) => [l.id, l.box]));
  assert.ok(plain_.artifact.lots.every((l) => !('inverted' in l)));
});

test('rule.suspended: overhangs only (a canopy is passed over), refused when its scope is not an elevated zone, blocked when its zone finds none', async () => {
  // a tree beside the overhangs: unsuspended, the first lot may take the canopy; suspended, the lots take only overhangs
  const tree = { box: [1106, 65, 2050, 1108, 84, 2052], class: 'LOG' }, leaves = { box: [1100, 85, 2044, 1114, 89, 2058], class: 'LEAVES' };
  const mixed = { ...V, volume: { edits: [...V.volume.edits, tree, leaves] } };
  const m = await run(mixed);
  assert.ok(m.artifact.lots.every((l) => l.affordance.kind === 'overhang' && l.inverted === true), JSON.stringify(m.artifact.lots.map((l) => l.affordance)));
  // a scope that is not an elevated lots zone
  const street = { id: 'street_town', kind: 'standard', size: { preset: 'S' }, program: { lots: [{ id: 'h1', type: 'house', size: [9, 9] }] } };
  const wrong = await run({ ...V, plan: { ...V.plan, zones: [...V.plan.zones, street], rules: [{ id: 'hang_inverted', kind: 'suspended', scope: ['street_town'] }] } });
  const w = wrong.check.parts.find((p) => p.part === 'hang_inverted');
  assert.equal(w.class, 'refused');
  assert.equal(w.reasons[0].code, 'NO_FEATURE');
  assert.match(w.reasons[0].message, /street_town is not a lots zone with layout elevated/);
  assert.ok(wrong.artifact.lots.filter((l) => l.zone === 'hanging').every((l) => !('inverted' in l)), 'the zones untouched');
  // no overhang in the land: the zone refused in the rule's words, the rule blocked
  const bare = await run({ ...V, volume: { edits: [] } });
  const bz = bare.check.parts.find((p) => p.part === 'hanging');
  assert.equal(bz.class, 'refused');
  assert.match(bz.reasons[0].message, /found no overhang ceiling to hang from in the zone \(rule\.suspended/);
  assert.equal(bare.check.parts.find((p) => p.part === 'hang_inverted').class, 'blocked');
  // scope left out: every elevated zone of the plan
  const all = await run({ ...V, plan: { ...V.plan, rules: [{ id: 'hang_inverted', kind: 'suspended' }] } });
  assert.ok(all.artifact.lots.every((l) => l.inverted === true));
});

test('catalogue: rule.suspended supported (sinceApi NEXT, schemaVersion 1, def, limits); against catalogue-pre7c.json the flip is this one\'s', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(KIT, 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden);
  const e = golden.entries.find((x) => x.id === 'rule.suspended');
  assert.equal(e.state, 'supported');
  assert.equal(e.schemaVersion, 1);
  assert.equal(e.sinceApi, 'NEXT');
  assert.equal(e.until, undefined);
  assert.deepEqual(e.limits, { scope: 32, layouts: ['elevated'], affordances: ['overhang'] });
  const pre = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-pre7c.json'), 'utf8'));
  const d = diffCatalogues(pre, golden);
  assert.ok(d.reservedToSupported.includes('rule.suspended'));
  assert.ok(d.schemaVersionBumps.some((b) => b.id === 'rule.suspended' && b.from === 0 && b.to === 1));
});

// ---------------------------------------------------------------- the recorded ask

test('upside_down re-planned: as recorded and with rule.suspended on the asks survey it still waits (no overhang); over overhang shelves every lot hangs inverted', async () => {
  const A = asksSurvey();
  const rec = JSON.parse(fs.readFileSync(path.join(FIX, 'asks', 'upside_down.json'), 'utf8')).answer.plan;
  const anchors = stewardAnchors(A.claim);
  const o = { survey: A.bytes, claim: A.claim, anchors };
  const cls = (r, id) => r.check.parts.find((p) => p.part === id);
  const asRec = await checkPlanVolumes(rec, o);
  assert.equal(cls(asRec, 'hanging_village').class, 'refused');
  const withRule = { ...rec, rules: [{ id: 'hang_from_ceiling', kind: 'suspended', scope: ['hanging_village'] }] };
  const flat = await checkPlanVolumes(withRule, o);
  assert.equal(cls(flat, 'hanging_village').class, 'refused');
  assert.match(cls(flat, 'hanging_village').reasons[0].message, /no overhang ceiling/);
  assert.equal(cls(flat, 'hang_from_ceiling').class, 'blocked');
  // a natural overhang field near its stone (9 rock shelves 13 x 13, 4 thick, their undersides 16 over the ground): every lot hangs inverted
  const [sx, sy, sz] = anchors.stone;
  const edits = [];
  for (const [dx, dz] of [[-16, -16], [0, -16], [16, -16], [-16, 0], [16, 0], [-16, 16], [0, 16], [16, 16], [0, 0]]) edits.push({ box: [sx + dx - 6, sy + 16, sz + dz - 6, sx + dx + 6, sy + 19, sz + dz + 6], class: 'ROCK' });
  const shelves = await checkPlanVolumes(withRule, { ...o, volume: { edits } });
  assert.equal(cls(shelves, 'hanging_village').class, 'fits');
  assert.equal(cls(shelves, 'hang_from_ceiling').class, 'fits');
  assert.equal(shelves.artifact.lots.length, 9);
  assert.ok(shelves.artifact.lots.every((l) => l.inverted === true && l.site.fit === 'suspend'));
  // its chain bridge between two hanging lots stays LP's (a rope bridge to a site lot's port is not a link kind)
  assert.equal(cls(shelves, 'chain_bridge_1').class, 'unsupported');
});
