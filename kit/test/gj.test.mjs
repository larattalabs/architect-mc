// Phase 7a slice GJ, a district joins a walled town through a standing gate (docs/CONTRACT.md "Phase 7a slice GJ" §11), the kit half of
// the gate, $0 and offline (step gj-unit):
//   1   the third step's order (only where D3 answers [wall]); the gates and their cells (besideGates, the parity fixture); the traverse
//       (no gate cell written or held; M28:beside on the broken variant that writes one); a narrow gate (the join narrowed across it,
//       noted); the refusal's list (sealed, a fence gate); determinism over 100 seeded walled towns
//   2   byte identity: a walled town's reach inputs without gates read as D3's; D3's own suites keep its pinned set (d3-unit)
//   10  KC: a fountain inside the ring on the cheapest inner run: kept clear, M25:clear 0
//   11  determinism: the IR sha over 3 plans
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { besideGates, runKeys } from '../lib/region/beside.mjs';
import { districtLand } from '../lib/region/land.mjs';
import { chooseReach } from '../lib/region/reach.mjs';
import { gateProblem } from '../lib/region/gateJoin.mjs';
import { routePass } from '../lib/region/passes/route.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { encodeColumns } from '../lib/region/pack.mjs';
import { columnsOf, worldOf } from './region-helpers.mjs';
import { GJ_EAST, planBesideWalled, synthWalled, walledTown } from './gj-helpers.mjs';
import { FIXTURE, RINGS, trimWall } from './gj-parity.mjs';

const flat = worldOf({ flat: 64 });
const check = (W, q, claimB = GJ_EAST, besideReach = W.besideReach) => checkRegion({ ir: q.ir, survey: encodeColumns(columnsOf(W.world, claimB[0], claimB[1], claimB[2] - claimB[0] + 1, claimB[3] - claimB[1] + 1)), blobs: (s) => q.blobs.get(s) ?? null, meta: q.meta, besideReach, prefix: false });
const errors = (rep) => rep.findings.filter((f) => f.severity === 'error');

let OPEN = null;
const open = async () => (OPEN ??= await walledTown());

test('item 1 (parity): besideGates over the fixture\'s walls equals its recorded gates; the fixture is the kit\'s own answer', async () => {
  const f = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.equal(f.walls.length, RINGS.length);
  for (const w of f.walls) assert.deepEqual(besideGates(w.id, w.ir), w.gates, w.name);
  for (const d of f.districts) {
    assert.deepEqual(districtLand(d.ir, d.townClaim), d.land, d.name);
    assert.deepEqual(districtLand(d.ir, d.townClaim, { standingRemoved: 1234567 }), d.landRemoved, d.name);
    const j = d.land.parts.find((p) => p.kind === 'join');
    assert.equal(j.via, 'rgW:ring_g1');
    assert.equal(j.junction, 'side', 'the land names the junction it ends at (the gate junction\'s then)');
  }
});

test('item 1 (gates and their cells): the ring\'s gate as K1a emits it (meta.walls), its outer and inner cells just past the wall\'s depth on its axis', async () => {
  const W = await open();
  const [g] = W.besideReach.rgW.gates;
  assert.equal(g.id, 'ring_g1');
  assert.deepEqual(g.facing, [1, 0]);
  assert.equal(g.width, 3);
  assert.equal(g.h, 3);
  assert.equal(g.door, 'none');
  // the opening is the wall's depth (2) by its width (3); the outer cell one past its outer face on `at`'s line, the inner one before
  assert.equal(g.cells.length, 6);
  const xs = [...new Set(g.cells.map((c) => c[0]))];
  assert.deepEqual(g.outer, [Math.max(...xs) + 1, g.at[2]]);
  assert.deepEqual(g.inner, [Math.min(...xs) - 1, g.at[2]]);
  // the classification: a fence gate is player-only, an iron door is not a villager's, an opening walled up is not standing
  assert.match(gateProblem({ ...g, door: 'fence_gate' }), /fence gate/);
  assert.match(gateProblem({ ...g, door: 'door', doorBlock: 'minecraft:iron_door' }), /villagers open wooden doors only/);
  assert.equal(gateProblem({ ...g, door: 'door', doorBlock: 'minecraft:spruce_door' }), null);
  assert.match(gateProblem({ ...g, stands: false, why: 'its opening holds minecraft:cobblestone' }), /not standing as built/);
});

test('item 1 (the third step): a district beside a walled town joins through the gate: two legs, the traverse never written or held', async () => {
  const W = await open();
  const q = await planBesideWalled({ W });
  const j = q.meta.districts.join;
  assert.equal(j.via, 'rgW:ring_g1');
  assert.equal(j.step, 'reach');
  const g = q.ir.reach.gate;
  assert.equal(g.id, 'ring_g1');
  assert.equal(g.region, 'rgW');
  // the IR: the reach records the gate, the gates read and the wall region's inputs (§4)
  assert.ok(q.ir.reach.gatesSha && q.ir.reach.around?.[0]?.standing === 'rgW');
  // two legs in route_join; no reach column is a gate cell; no reach column is held (outside the contact columns)
  const edges = q.meta.route.edges.filter((e) => e.id === 'join' || e.id === 'join_in');
  assert.deepEqual(edges.map((e) => [e.id, e.ok]), [['join', true], ['join_in', true]]);
  const gk = runKeys(g.cells);
  const reach = runKeys(q.ir.reach.runs);
  assert.equal([...reach].filter((k) => gk.has(k)).length, 0, 'no reach column is a gate cell');
  // the legs meet the gate: the leg out ends at its outer cell, the leg in starts at its inner cell, both at its walk
  const out = edges[0].path.at(-1), inn = edges[1].path[0];
  assert.deepEqual([out[0], out[2]], g.legs?.[0] ?? g.outer);
  assert.deepEqual([inn[0], inn[2]], g.legs?.[1] ?? g.inner);
  assert.ok(Math.abs(out[1] - g.y) <= 1 && Math.abs(inn[1] - g.y) <= 1, `the legs at the gate's walk (${out[1]}, ${inn[1]} vs ${g.y})`);
  // the graph (§5): join_external through the gate, its junction then D3's; the traverse edge with its segment
  const ext = q.ir.graph.edges.find((e) => e.id === 'join_external');
  assert.equal(ext.via, 'rgW:ring_g1');
  assert.equal(ext.type, 'road');
  assert.deepEqual(ext.crossing, { type: 'gate', lands: 'ring_g1' });
  assert.equal(ext.junction.kind, 'gate');
  assert.equal(ext.junction.then.kind, j.junction.kind);
  const tr = q.ir.graph.edges.find((e) => e.id === 'join_gate');
  assert.deepEqual(tr.segments, [{ kind: 'gate', gate: 'ring_g1', region: 'rgW' }]);
  // the checker: no error; M2 walks both legs for the player and the villager; M28 0 gate cells written
  const rep = check(W, q);
  assert.deepEqual(errors(rep).map((f) => f.message), []);
  for (const e of rep.metrics.route.edges.filter((x) => x.id.startsWith('join'))) assert.ok(e.player && e.villager, `${e.id}: both movers`);
  assert.equal(rep.metrics.M28.gate, 0);
  assert.equal(rep.metrics.M28.held, 0);
});

test('item 1 (the broken variant): a join written through the gate is M28:beside', async () => {
  const W = await open();
  const q = await planBesideWalled({ W, unsafe: { writeGate: true } });
  const rep = check(W, q);
  const m = rep.findings.filter((f) => f.rule === 'M28:beside' && /gate rgW:ring_g1/.test(f.message));
  assert.ok(m.length && rep.metrics.M28.gate > 0, `M28:beside names the gate (${rep.metrics.M28.gate} cells)`);
});

test('item 1 (the order): only where D3 answers [wall]; without gates (sealed) or with the only gate a fence gate, NO_JOIN [wall] lists them', async () => {
  const W = await open();
  // the town's reach inputs alone (no wall region's gates): every gate unknown, NO_JOIN [wall] (sealed), as D3 answered
  await assert.rejects(planBesideWalled({ W, besideReach: W.townOnly }), /NO_JOIN: \[wall\] .*the gates tried: no gate \(sealed\)/);
  const F = await walledTown({ gates: RINGS.find((r) => r[0] === 'fence')[1] });
  await assert.rejects(planBesideWalled({ W: F }), /NO_JOIN: \[wall\] .*rgW:gf fence gate \(player-only/);
  // a gate the world holds walled up (the mod's stands: false): skipped, named
  const S = { ...W.besideReach, rgW: { ...W.besideReach.rgW, gates: W.besideReach.rgW.gates.map((g) => ({ ...g, stands: false, why: 'its opening at 78, 65, 53 holds minecraft:cobblestone' })) } };
  await assert.rejects(planBesideWalled({ W, besideReach: S }), /NO_JOIN: \[wall\] .*rgW:ring_g1 not standing as built \(its opening at 78, 65, 53 holds minecraft:cobblestone\)/);
});

test('item 1 (a narrow gate): a 1-wide gate is crossed at its width (noted), the legs 3 wide outside its depth', async () => {
  const N = await walledTown({ gates: RINGS.find((r) => r[0] === 'narrow')[1] });
  const q = await planBesideWalled({ W: N });
  assert.equal(q.ir.reach.gate.width, 1);
  assert.equal(q.ir.reach.gate.narrowed, 1);
  assert.equal(q.ir.graph.edges.find((e) => e.id === 'join_gate').width, 1);
  const rep = check(N, q);
  assert.deepEqual(errors(rep).map((f) => f.message), []);
  assert.equal(rep.metrics.M28.gate, 0);
  // a double door (2 wide, oak): crossed by villagers (they open wooden doors)
  const D = await walledTown({ gates: RINGS.find((r) => r[0] === 'door')[1] });
  const qd = await planBesideWalled({ W: D });
  assert.equal(qd.ir.reach.gate.door, 'door');
  assert.equal(qd.ir.reach.gate.narrowed, 2);
});

test('item 2 (byte identity): an unwalled town\'s reach plan reads the same with gates in its inputs or a wall region beside them', async () => {
  // D3's own pinned set is d3-unit's (districts-d3*.test.mjs, the goldens); here: the third step never runs off [wall], so inputs that carry
  // gates, or a map with a wall region, give a D3 plan the same IR
  const { d3Town, planBeside, reachInputs } = await import('./d3-helpers.mjs');
  const town = await d3Town();
  const R = reachInputs({ ir: town.p.ir, world: town.world, claim: town.claim });
  const claimB = [100, 13, 180, 93];
  const a = await planBeside({ town, districts: [{ id: 'east', size: [48, 48], lots: 4 }], claimB, besideReach: R.besideReach });
  const W = await open();
  const b = await planBeside({ town, districts: [{ id: 'east', size: [48, 48], lots: 4 }], claimB, besideReach: { rg1: { ...R.besideReach, gates: W.besideReach.rgW.gates }, rgW: W.besideReach.rgW } });
  assert.equal(a.irSha, b.irSha);
  assert.equal(a.ir.reach.gate, undefined);
});

test('item 1 (determinism): 100 seeded synthetic walled towns: every join crosses the gate, never writes it, the same answer twice', () => {
  let s = 20261028;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  let joined = 0;
  for (let n = 0; n < 100; n++) {
    const gz = 30 + Math.floor(rnd() * 36), c = 30 + Math.floor(rnd() * 36), width = 1 + Math.floor(rnd() * 3);
    const t = synthWalled({ gz, c, width, u0: 20 + Math.floor(rnd() * 6), u1: 60 + Math.floor(rnd() * 8) });
    const ez = 6 + Math.floor(rnd() * 84);
    const claim = [96, 0, 135, 95];
    const de = [{ x: 104, z: ez, at: [104, 65, ez], facing: [-1, 0] }];
    const run = () => chooseReach({ planCols: columnsOf(flat, 96, 0, 40, 96), R: t.R, beside: t.beside, claim, districtEnds: de, route: routePass });
    const J = run();
    assert.ok(J.gate, `town ${n}: through the gate`);
    assert.equal(J.gate.id, 'ring_g1');
    assert.equal(J.gate.narrowed ?? null, width < 3 ? width : null);
    const J2 = run();
    assert.deepEqual([J2.best.dry.cost, J2.cand.junction, J2.gate.outer], [J.best.dry.cost, J.cand.junction, J.gate.outer], `town ${n}: deterministic`);
    joined++;
  }
  assert.equal(joined, 100);
});

test('item 10 (KC): a fountain inside the ring on the cheapest inner run: the join keeps clear of it', () => {
  const free = synthWalled({ gz: 48, c: 40 });
  const de = [{ x: 104, z: 48, at: [104, 65, 48], facing: [-1, 0] }];
  const claim = [96, 0, 135, 95];
  const J0 = chooseReach({ planCols: columnsOf(flat, 96, 0, 40, 96), R: free.R, beside: free.beside, claim, districtEnds: de, route: routePass });
  // a fountain across the free plan's inner run, by the gate
  const fount = [[78, 46, 82, 50]];
  const t = synthWalled({ gz: 48, c: 40, bodies: fount });
  const J = chooseReach({ planCols: columnsOf(flat, 96, 0, 40, 96), R: t.R, beside: t.beside, claim, districtEnds: de, route: routePass });
  assert.ok(J0.gate && J.gate);
  const body = new Set(); for (let z = 46; z <= 50; z++) for (let x = 78; x <= 82; x++) body.add(`${x},${z}`);
  assert.ok([...body].every((k) => J.hardKeys.has(k)), 'the fountain\'s columns are hard to the join');
  assert.ok(J.best.dry.cost > J0.best.dry.cost, `the join goes round it (${J0.best.dry.cost} -> ${J.best.dry.cost})`);
});

test('item 11 (determinism): the IR sha over 3 plans of the same district through the gate', async () => {
  const W = await open();
  const shas = new Set();
  for (let i = 0; i < 3; i++) shas.add((await planBesideWalled({ W })).irSha);
  assert.equal(shas.size, 1);
});

test('the gates read from an IR equal the plan meta\'s (K1a\'s walls[].gates) on every ring of the fixture', async () => {
  for (const [name, gates] of RINGS) {
    const W = await walledTown({ gates });
    const got = besideGates('rgW', trimWall(W.ringIr));
    assert.ok(got.length >= 1, name);
    for (const g of got) {
      const m = W.ringMeta.walls.flatMap((w) => w.gates).find((x) => x.id === g.id);
      assert.ok(m, `${name}: ${g.id} in the meta`);
      assert.equal(g.width, m.width, name);
      assert.equal(g.door, m.door, name);
      assert.equal(g.y, m.y, name);
      assert.deepEqual(new Set(g.cells.map((c) => c.join(','))), new Set(m.cells.map((c) => c.join(','))), name);
    }
  }
});

test('item 5 (plan/0): v7a_gj_endpoint\'s endpoint.region reaches the walled town\'s street through the ring\'s gate', async () => {
  const { run } = await import('./plan-p0-shared.mjs');
  const { ENDPOINT } = await import('./gj-parity.mjs');
  const f = { ...JSON.parse(fs.readFileSync(ENDPOINT, 'utf8')), name: 'v7a_gj_endpoint' };
  const r = await run(f);
  assert.equal(r.check.overall, 'READY');
  const p = r.check.parts.find((a) => a.part === 'to_town');
  assert.equal(p.class, 'fits');
  assert.ok((p.notes ?? []).some((n) => /reach: true/.test(n)));
  const g = r.res.ir.reach.gate;
  assert.equal(g.id, 'ring_g1');
  const ext = r.res.ir.graph.edges.find((e) => e.external);
  assert.equal(ext.via, 'rgW:ring_g1');
  assert.equal(ext.junction.kind, 'gate');
  assert.equal([...runKeys(r.res.ir.reach.runs)].filter((k) => runKeys(g.cells).has(k)).length, 0, 'no gate cell written');
});
