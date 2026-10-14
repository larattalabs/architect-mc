// Phase 7a slice K1a, walls and gates (docs/CONTRACT.md "Phase 7a slice K1" §1-§5, §7, §9, §10 and Steward's review), the kit half of
// the gate, $0 and offline:
//   1-4 (virtual world)  the walled village v30 on S7's flat claim and S3's pinned claim: the checker's M2:wall (no cut, closure with
//                        the gates blocked for both movers, every node across with them open), M8:wall, M6 at the gates, M5 on the
//                        gates' walks and the top; the gates exactly the crossings plus gates.min; the line 4-connected
//   6                    every K1a fixture answers as expected: v30-v32 fit; WATER, PROTECTED, OUT_OF_CLAIM and MOVER refusals with
//                        evidence; the sealed wall (S-K1-1), the unread keys (S-K1-3), a crossing gate; castle_city's gate_lot a join
//                        deviation (S-K1-2)
//   7                    §9's wall and gate rows on Steward's 59 recorded plans: 0 malformed and 0 unsupported among the K1 parts, at
//                        least 7 of the 9 wall and gate parts fits or adjusted, every refusal named with evidence; the gap table
//   10                   determinism: 3 checks of v30 give one answer set and one artifact sha
//   11                   the broken variants: noGates (M2:wall), a gap in the wall (closure fails)
// cost.bom on every emitted wall and gate part (§7).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { asksSurvey, goldenSurvey, stewardAnchors, checkPlanLocal, FIX } from './plan-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { PLAN_SCHEMA } from '../lib/plan/schema.mjs';

const SV = { s7: goldenSurvey('s7'), s3: goldenSurvey('s3'), asks: asksSurvey() };
const readJ = (...p) => JSON.parse(fs.readFileSync(path.join(FIX, ...p), 'utf8'));
const run = (fx, plan = fx.plan, extra = {}) => { const s = SV[fx.on]; return checkPlanLocal(plan, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), protected: fx.protected ?? [], ...extra }); };
const part = (r, id) => r.check.parts.find((a) => a.part === id);
const check = (r, on) => checkRegion({ ir: r.res.ir, survey: SV[on].bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, meta: r.res.meta, prefix: false });
const wallFindings = (rep) => rep.findings.filter((f) => /^M2:wall|^M8:wall/.test(f.rule) || (f.part ?? '').startsWith('w_'));

/** The virtual world's wall bars for every wall of a plan's region. */
function wallBars(rep, msg) {
  for (const [id, m] of Object.entries(rep.metrics.walls)) {
    assert.equal(m.cut, 0, `${msg} ${id}: no walk cell under the wall outside its gates`);
    assert.equal(m.M8.low, 0, `${msg} ${id}: every column at least its height at its foot (footMin ${m.M8.footMin})`);
    assert.equal(m.M8.bypass, 0, `${msg} ${id}: every column 2 over any standable cell within 2`);
    assert.equal(m.gateClearance.bad, 0, `${msg} ${id}: the gates' openings clear`);
    assert.equal(m.M5.dark, 0, `${msg} ${id}: 0 dark spawnable cells on the gates' walks and the top`);
    if (m.closure) for (const mv of ['player', 'villager']) {
      assert.equal(m.closure[mv].leaks, 0, `${msg} ${id}: with the gates blocked, 0 ${mv} paths from inside to outside`);
      assert.equal(m.closure[mv].across, m.closure[mv].nodes, `${msg} ${id}: with the gates open, every node reaches across by the ${mv} mover`);
    }
  }
  assert.deepEqual(wallFindings(rep).map((f) => f.message), [], `${msg}: no wall finding`);
}

test('items 1-4 (virtual world): the walled village on S7\'s flat claim: closure, no cut, the top, the gates', async () => {
  const fx = readJ('valid', 'v30_walled_village.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY');
  for (const a of r.check.parts) assert.equal(a.class, 'fits', `${a.part}: ${a.class} ${JSON.stringify(a.reasons ?? a.deviations)}`);
  const w = part(r, 'town_wall'), g = part(r, 'west_gate');
  // two gates in all: the gate at claim_w (its double door, the path through it) and the road's auto gate; no gates.min gate
  assert.deepEqual(w.geometry.gates.map((x) => [x.kind, x.auto, x.door]).sort(), [['at', false, 'door'], ['route', true, 'none']]);
  assert.equal(g.geometry.width, 2);
  assert.equal(g.geometry.door, 'door');
  // the routes' gates: the road opened its own, the path went through the gate at claim_w (no third gate)
  const routeEdges = r.res.meta.route.edges.filter((e) => e.ok);
  assert.ok(routeEdges.every((e) => (e.gates ?? []).length === 1), `each route crossed the wall once (${JSON.stringify(routeEdges.map((e) => e.gates))})`);
  // the line is 4-connected and closed; every cell's top at least height over the ground (the check below in the world)
  const wm = r.res.meta.walls[0];
  assert.equal(wm.closed, true);
  const cells = new Set(wm.cells.map((c) => `${c[0]},${c[1]}`));
  for (const c of wm.cells) assert.ok([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => cells.has(`${c[0] + dx},${c[1] + dz}`)), 'every wall cell has a 4-neighbour in the wall');
  wallBars(check(r, 's7'), 'S7');
  // cost.bom on the wall and the gate: the emitted cells' items
  assert.ok(w.cost?.bom && w.cost.bom['minecraft:stone_bricks'] > 0, `the wall's bill (${JSON.stringify(w.cost?.bom)})`);
  assert.equal(g.cost?.bom?.['minecraft:oak_door'], 2, `the gate's bill: a double door (${JSON.stringify(g.cost?.bom)})`);
});

test('items 1-4 (virtual world): the same walled village on S3\'s pinned claim', async () => {
  const fx = readJ('valid', 'v30_walled_village.json');
  const plan = JSON.parse(JSON.stringify(fx.plan));
  // (on S3 the zone's own pick lands by the river, where no ring [4, 8] is clear: sketched clear of it)
  plan.zones[0].sketch = { frame: 'claim', unit: 'q64', shape: 'point', points: [[23, 31]] };
  const r = await run({ on: 's3' }, plan);
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts));
  assert.equal(part(r, 'town').class, 'adjusted', 'the zone 1 cell from its sketch');
  for (const id of ['town_wall', 'in', 'west_gate', 'west_path']) assert.equal(part(r, id).class, 'fits', `${id}: ${JSON.stringify(part(r, id))}`);
  wallBars(check(r, 's3'), 'S3');
});

test('item 6: v31 (wall.line) and v32 (wall.edge) fit; their auto gates are exactly the crossings', async () => {
  for (const f of ['v31_wall_line.json', 'v32_wall_edge.json']) {
    const fx = readJ('valid', f);
    const r = await run(fx);
    for (const a of r.check.parts) assert.equal(a.class, 'fits', `${f} ${a.part}: ${a.class} ${JSON.stringify(a.reasons ?? a.deviations)}`);
    const wm = r.res.meta.walls[0];
    const crossings = r.res.meta.route.edges.filter((e) => e.ok).flatMap((e) => e.gates ?? []);
    assert.equal(wm.gates.length, crossings.length, `${f}: one gate per crossing (gates.min already met)`);
    wallBars(check(r, fx.on), f);
  }
});

test('item 6: the K1a refusals answer their code with evidence', async () => {
  const fx = fs.readdirSync(path.join(FIX, 'refused')).filter((f) => f.startsWith('k1a_')).sort();
  assert.ok(fx.length >= 4);
  for (const f of fx) {
    const j = readJ('refused', f);
    const r = await run(j);
    const a = part(r, j.expect.part);
    assert.equal(a.class, 'refused', `${f}: ${a.class} ${JSON.stringify(a)}`);
    assert.equal(a.reasons[0].code, j.expect.code, `${f}: ${JSON.stringify(a.reasons)}`);
    assert.ok(a.reasons[0].evidence && Object.keys(a.reasons[0].evidence).length, `${f}: evidence`);
  }
});

test('item 6: the sealed wall (S-K1-1): no gate; a road that must cross refuses UNREACHABLE naming the wall, one that goes round fits', async () => {
  const fx = readJ('k1a', 'sealed.json');
  const r = await run(fx);
  for (const [id, c] of Object.entries(fx.expect)) assert.equal(part(r, id).class, c, `${id}: ${JSON.stringify(part(r, id))}`);
  const why = part(r, 'in').reasons[0];
  assert.equal(why.code, 'UNREACHABLE');
  assert.deepEqual(why.evidence.walls, [{ wall: 'w', sealed: true, gates: 0, max: 0 }]);
  assert.deepEqual(part(r, 'w').geometry.gates, []);
  assert.ok(part(r, 'w').notes.some((n) => /^sealed/.test(n)));
  // the recorded closed walls that name a gate (a gates number, gate, gate_lot, gateLots) are not sealed
});

test('item 6: the unread keys (S-K1-3) are each listed by name; a named lot beside the wall is a join deviation (S-K1-2)', async () => {
  const fx = readJ('k1a', 'unread_keys.json');
  const r = await run(fx);
  const w = part(r, 'w');
  assert.equal(w.class, fx.expect.w);
  for (const n of fx.expect.notes) assert.ok(w.notes.includes(n), `notes: ${JSON.stringify(w.notes)} has ${n}`);
  const j = w.deviations.find((d) => d.what === 'join');
  assert.equal(j.kind, 'join');
  assert.equal(j.lot, 'h1');
  assert.ok(j.value > 0 && Array.isArray(j.box) && j.box.length === 6);
});

test('item 6: a gate named by its crossing styles the gate that road opened (a double door)', async () => {
  const fx = readJ('k1a', 'crossing_gate.json');
  const r = await run(fx);
  for (const [id, c] of Object.entries(fx.expect)) assert.equal(part(r, id).class, c, `${id}: ${JSON.stringify(part(r, id))}`);
  const g = r.res.meta.walls[0].gates.find((x) => x.id === 'in_gate');
  assert.equal(g.kind, 'crossing');
  assert.equal(g.crossing, 'in');
  assert.equal(g.door, 'door');
  assert.equal(r.res.meta.walls[0].gates.length, 1, 'no auto gate besides it');
});

test('item 6: castle_city\'s gate_lot answers adjusted with a join deviation (S-K1-2)', async () => {
  const f = readJ('asks', 'castle_city.json');
  const r = await checkPlanLocal(f.answer.plan, { survey: SV.asks.bytes, claim: SV.asks.claim, anchors: stewardAnchors(SV.asks.claim) });
  const w = part(r, 'curtain_wall');
  assert.equal(w.class, 'adjusted');
  const j = w.deviations.find((d) => d.kind === 'join' && d.lot === 'gatehouse_1');
  assert.ok(j && j.what === 'join' && j.value > 0 && j.key === 'gate_lot', JSON.stringify(w.deviations));
  for (const k of ['corner_lots', 'gate_lot', 'wall_walk']) assert.ok(w.notes.includes(`params.${k} not read`), JSON.stringify(w.notes));
  assert.ok(!w.notes.some((n) => /^sealed/.test(n)), 'a gate_lot names a gate: not sealed');
  assert.ok(w.geometry.gates.length >= 1, 'gates.min 1');
});

// §9's wall and gate rows (Steward's review wins where it differs: a missed join is a deviation, so castle_city and walled_town
// answer adjusted)
const K1_ROWS = [['border_fort', 'fort_wall'], ['camp_to_city', 'city_wall'], ['castle_city', 'curtain_wall'], ['desert_jungle_wall', 'great_wall'], ['metropolis', 'city_wall'], ['redstone_gate', 'curtain_wall'], ['walled_town', 'town_wall'], ['war_camp', 'camp_palisade'], ['redstone_gate', 'main_gate']];

test('item 7: §9 on Steward\'s 59 recorded plans: K1 parts never malformed or unsupported, at least 7 of 9 wall and gate parts fit, refusals named', async () => {
  const fx = fs.readdirSync(path.join(FIX, 'asks')).filter((f) => f.endsWith('.json') && f !== 'SOURCE.json').sort();
  assert.equal(fx.length, 59);
  const K1 = new Set(['connector.wall', 'connector.gate', 'connector.rope_bridge', 'connector.auto']);
  const supported = new Set(PLAN_SCHEMA['x-catalogue'].entries.filter((e) => e.state === 'supported').map((e) => e.id));
  const tally = {}, gaps = {}, rows = [];
  let k1Parts = 0;
  for (const f of fx) {
    const j = JSON.parse(fs.readFileSync(path.join(FIX, 'asks', f), 'utf8'));
    const r = await checkPlanLocal(j.answer.plan, { survey: SV.asks.bytes, claim: SV.asks.claim, anchors: stewardAnchors(SV.asks.claim) });
    for (const a of r.check.parts) {
      tally[a.class] = (tally[a.class] ?? 0) + 1;
      if (a.class === 'unsupported') gaps[a.block] = (gaps[a.block] ?? 0) + 1;
      if (!K1.has(a.block)) continue;
      k1Parts++;
      assert.ok(!['malformed', 'unsupported'].includes(a.class), `${f} ${a.part}: ${a.class}`);
      if (a.class === 'refused') assert.ok(a.reasons?.[0]?.code && a.reasons[0].evidence, `${f} ${a.part}: a refusal names its code with evidence`);
      if (K1_ROWS.some(([n, p]) => `${n}.json` === f && p === a.part)) rows.push(`${f.replace('.json', '')}/${a.part}: ${a.class}${a.reasons ? ` ${a.reasons[0].code}` : ''}${a.deviations ? ` ${a.deviations.map((d) => d.what).join(',')}` : ''}`);
      assert.ok(supported.has(a.block));
    }
  }
  assert.equal(k1Parts, 20, 'the 20 recorded K1 parts');
  assert.equal(rows.length, 9);
  const ok = rows.filter((r) => /: (fits|adjusted)/.test(r)).length;
  console.log(`# K1a §9 rows (${ok} of 9 fits or adjusted): ${rows.join('; ')}`);
  console.log(`# 59 asks: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log('# gap table after (unsupported parts per block id):');
  for (const [k, v] of Object.entries(gaps).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) console.log(`#   ${k.padEnd(24)} ${v}`);
  assert.ok(ok >= 7, `at least 7 of the 9 wall and gate parts fits or adjusted (${ok})`);
});

test('item 10: 3 checks of v30 give one answer set and one artifact sha', async () => {
  const fx = readJ('valid', 'v30_walled_village.json');
  const rs = [await run(fx), await run(fx), await run(fx)];
  assert.ok(rs.every((r) => r.artifactSha && r.artifactSha === rs[0].artifactSha), 'one artifact sha');
  assert.ok(rs.every((r) => r.res.irSha === rs[0].res.irSha), 'one IR sha');
  assert.ok(rs.every((r) => JSON.stringify(r.check.parts) === JSON.stringify(rs[0].check.parts)), 'one answer set');
});

test('item 11: the broken variants: no gates (M2:wall), a gap left in the wall (closure fails)', async () => {
  const fx = readJ('valid', 'v30_walled_village.json');
  const variant = (unsafe) => { const p = JSON.parse(JSON.stringify(fx.plan)); p.connectors[0].ext = { 'architect_mc:unsafe': unsafe }; return p; };
  const ng = check(await run(fx, variant({ noGates: true })), 's7');
  assert.ok(ng.findings.some((f) => f.rule === 'M2:wall' && /walk cell\(s\) under the wall/.test(f.message)), `noGates: M2:wall's cut (${ng.findings.map((f) => f.rule).join(', ')})`);
  assert.ok(ng.findings.some((f) => f.rule === 'M2:wall' && /don't reach across/.test(f.message)), 'noGates: the nodes don\'t reach across');
  const gp = check(await run(fx, variant({ gap: 3 })), 's7');
  assert.ok(gp.metrics.walls.town_wall.closure.player.leaks > 0 && gp.findings.some((f) => f.rule === 'M2:wall' && /with its gates blocked/.test(f.message)), 'a gap: the closure fails (player)');
  assert.ok(gp.metrics.walls.town_wall.closure.villager.leaks > 0, 'a gap: the closure fails (villager)');
});

// (K1-target, the coordinator's addition from Steward) a wall-only plan round one of the owner's standing regions: its footprint
// bounds the ring and stays hard; its roads and ways are crossings (gates); gates.min faces its street ends; another owner's refused
test('K1-target: a wall-only plan round the owner\'s standing village (wall.around {region})', async () => {
  const { planRegion } = await import('../lib/region/plan.mjs');
  const { besideData } = await import('../lib/region/beside.mjs');
  const s = SV.asks;
  const town = { minX: 120, minZ: 120, maxX: 207, maxZ: 199, minY: -64, maxY: 319 };
  const lots = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }, { id: 'cottage_2', type: 'cottage', size: [9, 9] }];
  const p = await planRegion({ programFile: path.join(FIX, '..', '..', '..', 'regions', 'flat_village.mjs'), params: { lots }, survey: s.bytes, claim: town, seed: '1' });
  const standing = besideData('rg1', [town.minX, town.minZ, town.maxX, town.maxZ], p.ir, [s.claim.minX, s.claim.minZ, s.claim.maxX, s.claim.maxZ]);
  const plan = { schemaVersion: 'plan/0', connectors: [{ id: 'town_wall', kind: 'wall', where: { around: { feature: { region: 'rg1' } } } }] };
  const r = await checkPlanLocal(plan, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), standing: [standing] });
  const w = part(r, 'town_wall');
  assert.equal(w.class, 'fits', JSON.stringify(w));
  assert.equal(r.check.overall, 'READY');
  // the ring stays off the village's lots and keep, and has a gate where a street end faces it (gates.min 1)
  const wm = r.res.meta.walls[0];
  const hard = [...standing.lots, ...standing.keep];
  const onHard = wm.cells.filter(([x, z]) => hard.some((q) => x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3]) && !wm.gates.some((g) => g.cells.some(([gx, gz]) => gx === x && gz === z)));
  assert.equal(onHard.length, 0, 'the village\'s footprint is never written');
  assert.ok(wm.gates.length >= 1 && wm.closed, JSON.stringify(wm.gates.map((g) => g.kind)));
  // another owner's region: refused NO_FEATURE
  const other = await checkPlanLocal({ schemaVersion: 'plan/0', connectors: [{ id: 'w', kind: 'wall', where: { around: { feature: { region: 'rg9' } } } }] }, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), regions: [{ id: 'rg9', rect: [10, 10, 40, 40] }] });
  assert.equal(part(other, 'w').class, 'refused');
  assert.equal(part(other, 'w').reasons[0].code, 'NO_FEATURE');
});
