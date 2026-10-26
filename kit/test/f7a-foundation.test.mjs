// Phase 7a foundation (docs/CONTRACT.md "Phase 7a foundation: the shared interface" §7): the interface is inert with its stubs in
// (the byte identity over every committed fixture is tools/gate7af.mjs's, against the merge base), the catalogue's three changes, P0's
// reserved example on connector.tube (plan-p0.test.mjs), the alias, and the interface's shape (kinds, hook table, rows 9-11, profiles,
// defs, codes, rules, wire shapes, bible keys).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, ROOT } from './plan-helpers.mjs';
import { read, run } from './plan-p0-shared.mjs';
import { planCatalogue, diffCatalogues } from '../lib/plan/catalogue.mjs';
import { PLAN_SCHEMA, validatePlan } from '../lib/plan/schema.mjs';
import * as K7 from '../lib/connectors/kinds7a.mjs';
import { EMIT_ORDER_7A, HOOKS_7A, hookOf } from '../lib/connectors/hooks7a.mjs';
import { COST, LADDER_MAX, SPECIAL_MOVES, routePass } from '../lib/region/passes/route.mjs';
import { PROFILES, PROFILE_NAMES } from '../lib/region/passes/moves/profiles.mjs';
import { CONNECTOR_SLOTS, connectorRoles, connectorsError } from '../lib/connectors/style.mjs';
import { LINK_KINDS } from '../lib/plan/compile.mjs';
import { validateSchema } from '../lib/region/siteplan.mjs';
import { makeColumns } from '../lib/region/pack.mjs';

const KIT = path.join(ROOT, 'kit');

test('§1: the kinds are a leaf module (no imports), and LINK_KINDS reads them', () => {
  const src = fs.readFileSync(path.join(KIT, 'lib', 'connectors', 'kinds7a.mjs'), 'utf8');
  assert.doesNotMatch(src, /^\s*import\b/m);
  assert.deepEqual([...K7.CLIMB_KINDS], ['stair', 'switchback', 'ladder']);
  assert.deepEqual([...K7.KINDS_7A], ['stair', 'switchback', 'ladder', 'rock_stair', 'lift', 'catwalk', 'stairs_around']);
  assert.deepEqual({ ...K7.ALIAS_KINDS }, { span_bridge: 'bridge' });
  for (const k of K7.KINDS_7A) assert.ok(LINK_KINDS.includes(k), k);
});

test('§2: the hook table: five rows in order, each module an inert stub with every hook; the emission order frozen', () => {
  assert.deepEqual(HOOKS_7A.map((h) => [h.name, h.file, [...h.kinds]]), [
    ['climb', './climb.mjs', ['stair', 'switchback', 'ladder']], ['rockStair', './rockStair.mjs', ['rock_stair']], ['lift', './lift.mjs', ['lift']],
    ['catwalk', './catwalk.mjs', ['catwalk']], ['spiral', './spiral.mjs', ['stairs_around']]]);
  assert.deepEqual(EMIT_ORDER_7A.map((h) => h.name), ['climb', 'rockStair', 'catwalk', 'spiral', 'lift']);
  for (const h of HOOKS_7A) {
    for (const fn of ['resolve', 'leg', 'passInput', 'failAnswer', 'answer', 'emit', 'bom', 'survival']) assert.equal(typeof h.mod[fn], 'function', `${h.name}.${fn}`);
    // (each module never imports compile.mjs, program.mjs or rope.mjs: K1's cycle lesson)
    const src = fs.readFileSync(path.join(KIT, 'lib', 'connectors', h.file), 'utf8');
    assert.doesNotMatch(src, /from '\.\.\/plan\/compile\.mjs'|from '\.\.\/region\/program\.mjs'|from '\.\/rope\.mjs'/, h.file);
  }
  assert.equal(hookOf('ladder').name, 'climb');
  assert.equal(hookOf('bridge'), null);
});

test('§3.2: rows 9-11 after tunnel, in order, each off (init null) in the foundation', () => {
  assert.deepEqual(SPECIAL_MOVES.map((m) => [m.name, m.code, m.segment, m.flag]), [
    ['gate', 5, 'gate', false], ['rope', 6, 'rope', true], ['bridge', 7, 'bridge', true], ['tunnel', 8, 'tunnel', true],
    ['lift', 9, 'lift', true], ['catwalk', 10, 'catwalk', true], ['rock_stair', 11, 'rock_stair', true]]);
  for (const m of SPECIAL_MOVES.slice(4)) {
    assert.equal(m.init({}, { edges: [{ spans: [m.name], once: m.name }] }), null, m.name);
    for (const k of ['active', 'needsFlag', 'blocks', 'expand', 'cells', 'commit', 'fail']) assert.equal(typeof m[k], 'function', `${m.name}.${k}`);
  }
});

test('§3.1: the profiles are frozen by name and shape, each equal to the pass\'s own; an edge with a profile routes as without', () => {
  assert.deepEqual([...PROFILE_NAMES], ['stair', 'switchback', 'ladder']);
  for (const n of PROFILE_NAMES) {
    const p = PROFILES[n];
    assert.deepEqual(Object.keys(p).sort(), ['cost', 'ladderMax', 'ladders', 'stairs']);
    // ((7a CL) CL set the values (cl.test.mjs judges them): each cost a member of COST, the flags booleans)
    for (const k of Object.keys(p.cost)) assert.ok(k in COST, `${n}.${k}`);
    assert.ok(Number.isInteger(p.ladderMax) && p.ladderMax >= LADDER_MAX);
    assert.equal(typeof p.stairs, 'boolean');
    assert.equal(typeof p.ladders, 'boolean');
  }
  // a slope and a cliff (a player-only edge may ladder): the same route with each profile and without
  const W = 64, D = 48;
  const s = makeColumns(0, 0, W, D, 1);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) { const k = x + z * W, g = z < 24 ? 64 + (x >= 40 ? 6 : 0) : 64 + Math.floor(Math.max(0, x - 10) / 2); s.ground[k] = g; s.height[k] = g; s.floor[k] = g; }
  const edges = [{ id: 'e1', from: { at: [4, 65, 8] }, to: { at: [58, 71, 8] }, width: 1, movers: ['player'], ladders: true }, { id: 'e2', from: { at: [4, 65, 40] }, to: { at: [58, 89, 40] }, width: 2 }];
  const out0 = routePass(s, [], { edges }).data;
  assert.ok(out0.edges.every((e) => e.ok), JSON.stringify(out0.failed));
  assert.ok(out0.edges[0].segments.some((g) => g.kind === 'ladder') && out0.edges[1].segments.some((g) => g.kind === 'stair' || g.kind === 'landing'), 'the case climbs');
  const base = JSON.stringify(out0);
  // ((7a CL) without a profile the pass is T2's; an edge with CL's profiles is cl.test.mjs's)
  assert.equal(JSON.stringify(routePass(s, [], { edges: edges.map((e) => ({ ...e, profile: null })) }).data), base);
  assert.throws(() => routePass(s, [], { edges: [{ ...edges[0], profile: 'escalator' }] }), /profile must be one of stair, switchback, ladder/);
});

test('§4: the defs (strict, read once each kind flips), NO_CLIMB, the climb deviation, R25-R27', () => {
  const defs = PLAN_SCHEMA.$defs;
  for (const k of K7.KINDS_7A) {
    const d = defs[`connector.${k}`];
    assert.ok(d, k);
    assert.equal(d.additionalProperties, false, k);
    assert.equal(d.properties.kind.const, k);
    // each validates connector.routed's members (stairs_around: its own shape) and the plan writer's params
    for (const m of ['id', 'kind', 'required', 'label', 'notes', 'ext', 'from', 'style', 'tolerance', 'params', 'movers']) assert.ok(d.properties[m], `${k}.${m}`);
  }
  assert.ok(defs.reason.properties.code.enum.includes('NO_CLIMB'));
  assert.ok(defs.partAnswer.properties.deviations.items.properties.what.enum.includes('climb'));
  const rules = PLAN_SCHEMA['x-rules'];
  for (const r of ['R25 ', 'R26 ', 'R27 ']) assert.equal(rules.filter((x) => x.startsWith(r)).length, 1, r);
  // every 7a kind but the alias stays reserved until its own slice flips it ((7a slices) a flipped kind is supported, schemaVersion
  // at least 1, with its def: FLIPPED_7A below)
  const cat = planCatalogue();
  for (const k of K7.KINDS_7A) {
    const e = cat.entries.find((x) => x.id === `connector.${k}`);
    if (e.state === 'supported') { assert.ok(e.schemaVersion >= 1 && PLAN_SCHEMA['x-catalogue'].entries.find((x) => x.id === e.id)?.def === `#/$defs/connector.${k}`, k); continue; }
    assert.equal(e.state, 'reserved', k);
  }
});

test('§7 item 2: the golden equals planCatalogue(); against catalogue-pre7a.json exactly §4\'s three entries', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(KIT, 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden);
  const pre = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-pre7a.json'), 'utf8'));
  const d = diffCatalogues(pre, golden, { pending: [{ part: 'rail_1', block: 'connector.rail' }, { part: 'x', block: 'connector.span_bridge' }] });
  // ((7a slices) each 7a slice flips its own kinds reserved -> supported (CW: connector.catwalk): those flips are the slices' and are
  // left out here, so this item keeps checking exactly the foundation's three entries whichever slices have merged)
  // ((7a K2) and K2's wall.along)
  const flipped = new Set([...K7.KINDS_7A.map((k) => `connector.${k}`), 'wall.along'].filter((id) => golden.entries.find((e) => e.id === id)?.state === 'supported'));
  const own = (l, f = (x) => x) => l.filter((x) => !flipped.has(f(x)));
  assert.deepEqual(own(d.reservedToSupported), ['connector.span_bridge']);
  assert.deepEqual(own(d.schemaVersionBumps, (x) => x.id), [{ id: 'connector.span_bridge', from: 0, to: 1 }]);
  assert.deepEqual(own(d.untilChanged, (x) => x.id), [{ id: 'connector.rail', from: '7a', to: 'CR' }, { id: 'connector.branch_walk', from: '7a', to: '7b' }]);
  assert.deepEqual(own(d.notesChanged, (x) => x.id).map((x) => x.id), ['connector.rail', 'connector.branch_walk']);
  // ((6d RV) the revision.* entries RV adds are rv-a.test.mjs's)
  assert.deepEqual([d.added.filter((x) => !/^revision\./.test(x.id)), d.removed, d.retired, d.otherStateChanges, own(d.limitsChanged, (x) => x.id ?? x)], [[], [], [], [], []]);
  assert.deepEqual(d.recheck, [{ part: 'x', block: 'connector.span_bridge' }]);
  const sb = golden.entries.find((e) => e.id === 'connector.span_bridge');
  assert.equal(sb.aliasOf, 'connector.bridge');
  // the three changed entries carry the placeholder (the merge stamps it); nothing else changed its sinceApi
  const changed = golden.entries.filter((e) => JSON.stringify(e) !== JSON.stringify(pre.entries.find((x) => x.id === e.id)));
  assert.deepEqual(own(changed, (e) => e.id).map((e) => e.id).filter((id) => !/^revision\./.test(id)), ['connector.rail', 'connector.branch_walk', 'connector.span_bridge']);
  // (released in v0.43.0 at API 1.40.0, catalogue-v0430.json: a later release's golden.api moves on, the stamp stays; the 7a slices'
  // flips in `changed` too: CL's and K2's released in v0.44.0 at API 1.41.0)
  for (const e of changed) assert.ok(e.sinceApi === 'NEXT' || e.sinceApi === golden.api || e.sinceApi === '1.40.0' || (flipped.has(e.id) && e.sinceApi === '1.41.0'), `${e.id}: ${e.sinceApi}`);
  // every reserved 7a kind still has its extension fixture; span_bridge left e15
  const ext = new Set(read('extension').flatMap((f) => (f.expect.all ?? [f.expect]).map((x) => x.block)));
  assert.ok(!ext.has('connector.span_bridge'));
  for (const id of ['connector.rail', 'connector.branch_walk', 'connector.tube', ...own(K7.KINDS_7A.map((k) => `connector.${k}`))]) assert.ok(ext.has(id), id);
  for (const id of flipped) assert.ok(!ext.has(id), `${id} left e15 when it shipped`);
});

test('§7 item 4: a span_bridge part answers as the same bridge part, block connector.bridge, with the note (R25); the caller\'s plan untouched', async () => {
  const fx = read('valid');
  const alias = fx.find((f) => f.name === 'v7a_foundation_span_bridge.json');
  const bridge = fx.find((f) => f.name === 'v35_bridge_beam.json');
  const plan0 = JSON.stringify(alias.plan);
  const v = validatePlan(alias.plan, { anchors: ['a', 'b'] });
  const p = v.parts.find((q) => q.id === 'ravine_road');
  assert.equal(p.block, 'connector.bridge');
  assert.equal(p.kind, 'bridge');
  assert.equal(p.verdict, 'compile');
  assert.equal(JSON.stringify(alias.plan), plan0, 'the caller\'s plan is not rewritten');
  const [ra, rb] = [await run(alias), await run(bridge)];
  assert.equal(JSON.stringify(alias.plan), plan0);
  const a = ra.check.parts.find((q) => q.part === 'ravine_road'), b = rb.check.parts.find((q) => q.part === 'ravine_road');
  assert.equal(a.block, 'connector.bridge');
  assert.equal(a.notes[0], 'span_bridge is connector.bridge (R25)');
  const { notes: na, ...restA } = a, { notes: nb, ...restB } = b;
  assert.deepEqual(restA, restB);
  assert.deepEqual(na.slice(1), nb ?? []);
  assert.equal(ra.check.overall, rb.check.overall);
  // the same IR, but the plan it records (the caller's, with its kind as written)
  // (and the seed, derived from the params)
  const irOf = (r) => { const ir = JSON.parse(r.res.irJson); assert.ok(ir.params.plan); delete ir.params.plan; delete ir.seed; return JSON.stringify(ir); };
  assert.equal(JSON.parse(ra.res.irJson).params.plan.connectors[0].kind, 'span_bridge');
  assert.ok(irOf(ra) === irOf(rb), 'the same IR (the recorded plan aside)');
  // a malformed alias part is malformed against the bridge's def
  const bad = validatePlan({ ...alias.plan, connectors: [{ ...alias.plan.connectors[0], form: 'suspension' }] }, { anchors: ['a', 'b'] });
  assert.equal(bad.parts[bad.parts.length - 1].verdict, 'malformed');
});

test('§5: siteplan/1 takes the 7a rows and edge types; the bible takes the role keys', () => {
  const roles = { structure: 'minecraft:stone_bricks', trim: 'minecraft:spruce_planks', rail: 'minecraft:spruce_fence', floor: 'minecraft:spruce_planks', path: 'minecraft:dirt_path' };
  for (const [k, slots] of Object.entries({ stair: ['tread', 'rail'], switchback: ['retaining'], ladder: ['ladder', 'landing', 'rail', 'gate'], rock_stair: ['tread', 'lining', 'portal'], lift: ['shell', 'base', 'door', 'cap'], catwalk: ['deck', 'bracket', 'rail'], stairs_around: ['tread', 'rail', 'deck'] })) {
    assert.deepEqual(CONNECTOR_SLOTS[k], slots, k);
    assert.equal(connectorsError({ [k]: Object.fromEntries(slots.map((s) => [s, 'trim'])) }, roles), null, k);
  }
  assert.deepEqual(CONNECTOR_SLOTS.wall, ['body', 'cap', 'frame', 'walk', 'parapet']);
  // the K1 and T3 defaults are unchanged
  const d = connectorRoles(roles, null);
  assert.deepEqual(d.bridge, { deck: 'path', rail: 'trim', pier: 'structure', arch: 'structure' });
  const schema = JSON.parse(fs.readFileSync(path.join(KIT, 'schemas', 'siteplan-1.json'), 'utf8'));
  for (const k of ['climbs', 'rockStairs', 'lifts', 'catwalks', 'spirals']) assert.ok(schema.properties[k], k);
  const row = { climbs: [{ id: 'c', part: 'p', kind: 'ladder', flights: 0, hairpins: 0, ladders: [{ at: [1, 2, 3], rungs: 30, landings: 1 }] }], rockStairs: [{ id: 'r', part: 'p', steps: 9, landings: 1, carved: 40, lined: 3 }],
    lifts: [{ id: 'l', part: 'p', foot: [0, 64, 0], top: [0, 80, 0], rise: 16, down: false }], catwalks: [{ id: 'w', part: 'p', cells: 12, brackets: 4 }], spirals: [{ id: 's', part: 'p', host: 'spire', rise: 20, turns: 1.5, top: [0, 84, 0] }] };
  for (const [k, v] of Object.entries(row)) assert.deepEqual(validateSchema(schema.properties[k], v, `$.${k}`, schema), [], k);
  const edge = schema.properties.graph.properties.edges.items;
  assert.deepEqual(validateSchema(edge.properties.crossing, { type: 'ladder', rise: 30, landings: 1 }, '$', schema), []);
  for (const t of ['stair', 'switchback', 'ladder', 'lift', 'catwalk', 'rock_stair', 'stairs_around']) assert.ok(edge.properties.type.enum.includes(t), t);
});
