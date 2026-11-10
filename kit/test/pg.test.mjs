// (Slice PG) Passage gates in the gate join (docs/CONTRACT.md "Slice PG"): a district joins a walled town through a K3 gatehouse's
// passage. Items 1 (a gatehouse-only town joins: front port -> back port), 2 (a mixed wall: GJ's order, deterministic), 3 (an unbuilt
// gatehouse skipped), 5 (a gate mechanism: rest open joins, rest closed skipped), and the record's rules (the wall line includes its lots,
// the passage's record, a K1 gate's unchanged).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planRegion } from '../lib/region/plan.mjs';
import { besideData, besideGates, besideStanding, passageGate, runKeys } from '../lib/region/beside.mjs';
import { gateProblem } from '../lib/region/gateJoin.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { encodeColumns } from '../lib/region/pack.mjs';
import { columnsOf, worldOf } from './region-helpers.mjs';
import { KIT } from './d3-helpers.mjs';
import fs from 'node:fs';
import { PG_FIXTURE, buildPg, passageTown } from './pg-parity.mjs';

const A = [0, 0, 159, 159];
const B = [160, 50, 249, 109];
const world = worldOf({ flat: 64 });

/** A districts region east of the town, beside it, with reach inputs `R`. */
export function planDistrict(T, R = T.R, seed = '1') {
  const claim = { minX: B[0], minZ: B[1], maxX: B[2], maxZ: B[3], minY: -64, maxY: 319 };
  return planRegion({ programFile: path.join(KIT, 'regions', 'districts.mjs'), params: { spec: { districts: [{ id: 'east', size: [48, 48], lots: 4 }] } },
    survey: columnsOf(world, B[0], B[1], B[2] - B[0] + 1, B[3] - B[1] + 1), claim, seed, beside: besideData('rg1', A, T.ir, B), besideReach: R });
}

const checkOf = (T, q, R = T.R) => checkRegion({ ir: q.ir, survey: encodeColumns(columnsOf(world, B[0], B[1], B[2] - B[0] + 1, B[3] - B[1] + 1)), blobs: (s) => q.blobs.get(s) ?? null, meta: q.meta, besideReach: R, prefix: false });
const errors = (rep) => rep.findings.filter((f) => f.severity === 'error');
const withGates = (T, f) => ({ ...T.R, gates: T.R.gates.map(f) });

let GH = null;
const gh = async () => (GH ??= await passageTown());

test('the record: a passage node reads as a gate (kind passage, the lot, its cells, ports and floor); the wall line includes the wall lots\' boxes', async () => {
  const T = await gh();
  assert.equal(T.check.overall, 'READY');
  const gs = besideGates('rg1', T.ir);
  assert.equal(gs.length, 1, 'a gatehouse-only wall: one gate, the passage');
  const g = gs[0], lot = T.ir.lots.find((l) => l.id === 'gatehouse_1'), p = lot.onWall.passage;
  assert.deepEqual([g.kind, g.id, g.lot, g.wall, g.door, g.doorBlock, g.width, g.h], ['passage', 'gatehouse_1', 'gatehouse_1', 'town_wall', 'none', null, p.width, p.height]);
  assert.deepEqual(g.outer, [p.front[0], p.front[2]]);
  assert.deepEqual(g.inner, [p.back[0], p.back[2]]);
  assert.equal(g.y, p.floor[2]);
  assert.equal(g.y + 1, p.front[1], 'the walk\'s feet are the ports\'');
  assert.deepEqual(g.facing, { east: [1, 0], west: [-1, 0], north: [0, -1], south: [0, 1] }[p.facing]);
  assert.equal(g.cells.length, p.cells.length / 4, 'one cell per passage column');
  assert.equal(g.mechanism, undefined, 'no mechanism: no member');
  // the meta's passage gate is the same opening
  const mg = T.meta.walls.find((w) => w.id === 'town_wall').gates.find((q) => q.kind === 'passage');
  assert.deepEqual(g.cells, mg.cells);
  assert.equal(g.y, mg.y);
  // the standing's walls hold the gatehouse's box (K3 cuts the wall line there)
  const st = besideStanding('rg1', A, T.ir), walls = runKeys(st.walls);
  for (let x = lot.box.minX; x <= lot.box.maxX; x++) for (const z of [lot.box.minZ, lot.box.maxZ]) assert.ok(walls.has(`${x},${z}`), `box column ${x},${z}`);
  // a K1 wall's gate record and standing are unchanged (no member added)
  const K = await passageTown({ gatehouse: false, k1: 'east' });
  const kg = besideGates('rg1', K.ir);
  assert.deepEqual(kg.map((q) => Object.keys(q)), [['region', 'wall', 'id', 'at', 'y', 'h', 'width', 'facing', 'door', 'doorBlock', 'cells', 'outer', 'inner']]);
  assert.equal(passageGate('rg1', { kind: 'passage', ref: 'nope' }, T.ir), null, 'a passage node without its lot: no gate');
});

test('item 1: a gatehouse-only walled town joins a district through the passage, front port -> back port; no NO_JOIN [wall]', async () => {
  const T = await gh();
  const q = await planDistrict(T);
  const j = q.meta.districts.join, g = q.ir.reach.gate;
  assert.equal(j.via, 'rg1:gatehouse_1');
  assert.equal(j.step, 'reach');
  assert.deepEqual([g.kind, g.lot, g.id], ['passage', 'gatehouse_1', 'gatehouse_1']);
  assert.deepEqual([j.node, j.road, j.junction.kind], ['wlb_gatehouse_1', 'route_wl_gatehouse_1_1', 'end']);
  // the walk: the leg out ends at the front port, the traverse, the one cell at the back port
  const edges = q.meta.route.edges.filter((e) => e.id === 'join' || e.id === 'join_in');
  assert.deepEqual(edges.map((e) => [e.id, e.ok]), [['join', true], ['join_in', true]]);
  const out = edges[0].path.at(-1), inn = edges[1].path[0];
  assert.deepEqual([out[0], out[2]], g.outer, 'join ends at the front port');
  assert.deepEqual([inn[0], inn[2]], g.inner, 'join_in at the back port');
  assert.equal(edges[1].path.length, 1, 'the back port is the town lane\'s end: no leg in, the one cell');
  const tr = q.ir.graph.edges.find((e) => e.id === 'join_gate');
  assert.deepEqual(tr.segments, [{ kind: 'gate', gate: 'gatehouse_1', region: 'rg1' }]);
  const ext = q.ir.graph.edges.find((e) => e.id === 'join_external');
  assert.equal(ext.via, 'rg1:gatehouse_1');
  assert.equal(ext.junction.kind, 'gate');
  // never a passage cell written; the front's pad columns held as contact
  const reach = runKeys(q.ir.reach.runs), gk = runKeys(g.cells);
  assert.equal([...reach].filter((k) => gk.has(k)).length, 0, 'no reach column is a passage cell');
  const hold = runKeys(q.ir.reach.hold);
  assert.ok(hold.has(`${g.outer[0]},${g.outer[1]}`), 'the front port (the K3 pad\'s) is held as a contact column');
  const rep = checkOf(T, q);
  assert.deepEqual(errors(rep).map((f) => f.message), []);
  for (const e of rep.metrics.route.edges.filter((x) => x.id.startsWith('join'))) assert.ok(e.player && e.villager, `${e.id}: both movers`);
  assert.equal(rep.metrics.M28.gate, 0);
  assert.equal(rep.metrics.M28.held, 0);
  // deterministic
  const q2 = await planDistrict(T);
  assert.equal(JSON.stringify(q2.ir), JSON.stringify(q.ir));
});

test('item 3: an unbuilt gatehouse (the mod\'s stands: false) is skipped "not standing as built"; the only gate: NO_JOIN [wall] naming it', async () => {
  const T = await gh();
  const R = withGates(T, (g) => ({ ...g, stands: false, why: 'gatehouse lot gatehouse_1 is not built (a reserved box)' }));
  await assert.rejects(planDistrict(T, R), /NO_JOIN: \[wall\] .*rg1:gatehouse_1 not standing as built \(gatehouse lot gatehouse_1 is not built \(a reserved box\)\)/);
});

test('item 2: a mixed wall (a K1 door gate north, the gatehouse east): GJ\'s order, the same answer twice; either one alone when the other does not stand', async () => {
  const T = await passageTown({ k1: 'north' });
  const gs = T.R.gates;
  assert.deepEqual(gs.map((g) => [g.id, g.kind ?? 'gate']).sort(), [['gatehouse_1', 'passage'], ['tg', 'gate']]);
  const q = await planDistrict(T), q2 = await planDistrict(T);
  assert.equal(q.meta.districts.join.via, 'rg1:gatehouse_1', 'the gatehouse faces the district: the cheapest sum');
  assert.equal(JSON.stringify(q2.ir), JSON.stringify(q.ir), 'deterministic');
  const off = (id) => withGates(T, (g) => (g.id === id ? { ...g, stands: false, why: 'test' } : g));
  const k = await planDistrict(T, off('gatehouse_1'));
  assert.equal(k.meta.districts.join.via, 'rg1:tg', 'the gatehouse not standing: the K1 gate');
  assert.equal(k.ir.reach.gate.kind, undefined, 'a K1 gate\'s record names no kind');
  const p = await planDistrict(T, off('tg'));
  assert.equal(p.meta.districts.join.via, 'rg1:gatehouse_1');
});

test('item 5: a gate mechanism: a portcullis (rest open, day-driven) is an open gate; a swing (rest closed) is skipped; a swing beside a K1 gate: the K1 gate', async () => {
  const P = await passageTown({ mech: 'portcullis' });
  const pg = P.R.gates[0];
  assert.deepEqual([pg.mechanism?.kind, pg.mechanism?.rest], ['portcullis', 'open']);
  const m = P.ir.lots.find((l) => l.id === 'gatehouse_1').onWall.passage.mechanism;
  assert.deepEqual(pg.mechanism.volatile, [...m.states.closed, ...m.states.open, ...m.triggers.flatMap((t) => [t.at[0], t.at[2], t.at[1], t.at[1]])]);
  assert.equal(gateProblem(pg), null);
  const q = await planDistrict(P);
  assert.equal(q.meta.districts.join.via, 'rg1:gatehouse_1');
  assert.deepEqual([q.ir.reach.gate.mechanism.kind, q.ir.reach.gate.mechanism.rest], ['portcullis', 'open']);
  assert.deepEqual(errors(checkOf(P, q)).map((f) => f.message), []);
  const S = await passageTown({ mech: 'swing' });
  assert.deepEqual([S.R.gates[0].mechanism?.kind, S.R.gates[0].mechanism?.rest], ['swing', 'closed']);
  assert.match(gateProblem(S.R.gates[0]), /swing mechanism closed at rest \(player-only/);
  await assert.rejects(planDistrict(S), /NO_JOIN: \[wall\] .*rg1:gatehouse_1 a swing mechanism closed at rest/);
  const SK = await passageTown({ mech: 'swing', k1: 'north' });
  assert.equal((await planDistrict(SK)).meta.districts.join.via, 'rg1:tg');
});

test('parity: the fixture (kit/test/fixtures/gj/pg-parity.json, the mod\'s GateJoinTest) is the kit\'s own answer: besideGates and the standing\'s walls', async () => {
  const f = await buildPg();
  assert.deepEqual(JSON.parse(fs.readFileSync(PG_FIXTURE, 'utf8')), JSON.parse(JSON.stringify(f)));
  assert.deepEqual(f.walls.map((w) => w.gates.map((g) => `${g.id}/${g.kind ?? 'gate'}/${g.mechanism?.rest ?? '-'}`).join(',')), ['gatehouse_1/passage/-', 'gatehouse_1/passage/open', 'gatehouse_1/passage/closed', 'gatehouse_1/passage/-,tg/gate/-']);
});
