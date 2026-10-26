// (6d GR, docs/CONTRACT.md "Phase 6d slice GR" §2-§8, §11 items 1, 2, 6 (kit), 12 (kit)) Growing a standing region, the kit's side: the
// growth search (frontage slots, the lot-free side, aprons, lane contact, never a verge or road cell written), the extendable ends (the
// join end, a held end, a short end refused), the extension (grade, length, its road flagged and joined end to end, the new end
// terminal), ids and the graph (no standing node or edge changed; graph.cut = []), districts and outposts, NO_ROOM, the broken variant
// (a lane onto a verge: M29 catches it), land v 2, plan/0's revision.grow, determinism, and 300 seeded synthetic towns grown 1-6 lots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3Town, planBeside, reachInputs } from './d3-helpers.mjs';
import { realiseAll, prng, worldOf } from './region-helpers.mjs';
import { mergeEffective, revisionStanding, reviseIR, standingClasses, columnProblem, nonAdditive } from '../lib/region/revise.mjs';
import { growPlan, streetRuns, extendableEnds, growObstacles, graphCut, FRONT_LANE } from '../lib/region/grow.mjs';
import { districtLand } from '../lib/region/land.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { planRegion, fillMissing } from '../lib/region/plan.mjs';
import { asColumns, canonicalJson } from '../lib/region/pack.mjs';
import { finishCheck } from '../lib/plan/finish.mjs';
import { KIT } from './d3-helpers.mjs';
import { surveyApi } from '../lib/region/survey.mjs';
import path from 'node:path';

let T = null;
async function town() {
  if (T) return T;
  const t = await d3Town();
  const ir = t.p.ir;
  const RI = reachInputs({ ir, world: t.world, claim: t.claim });
  const eff = mergeEffective(ir);
  const standing = revisionStanding({ id: 'rg1', claim: t.claim, effective: eff, held: RI.besideReach.held });
  T = { t, ir, eff, standing, survey: RI.besideReach.survey, RI };
  return T;
}
const ctxOf = (S, rid = 1, extra = {}) => ({ rid, position: rid, parent: { rid: rid - 1, irSha: S.t.p.irSha }, base: { irSha: S.t.p.irSha }, survey: S.survey, standing: S.standing, ...extra });
const errOf = async (p) => { try { await p; return null; } catch (e) { return /^([A-Z_]+): \[([a-z_]+)\]/.exec(e.message)?.slice(1, 3).join(' ') ?? e.message; } };
const LOTS2 = [{ id: 'smithy', type: 'smithy', size: [9, 11], villager: 'job' }, { id: 'bakery', type: 'bakery', size: [9, 9] }];
const LOTS6 = Array.from({ length: 6 }, (_, i) => ({ id: `house_${i + 1}`, type: 'house', size: [9, 9] }));

/** Every cell a revision IR writes (its own evaluation over the survey). */
async function cellsOf(r, survey) {
  const { intendedCells } = await import('../lib/region/revise.mjs');
  return intendedCells(r.ir, survey, (sha) => r.blobs.get(sha));
}

test('item 1, frontage: lots on the lot-free side nearest the square; the lane ends next to the verge, never on a verge or road cell; the graph joins', async () => {
  const S = await town();
  const r = await reviseIR(S.eff, { grow: { lots: LOTS2 } }, ctxOf(S));
  const g = r.ir.revision.grow;
  assert.deepEqual(g.lots, ['smithy', 'bakery']);
  assert.equal(g.extension, null);
  assert.deepEqual(g.unplaced, []);
  // each lot fronts its street on a side with no standing lot there; its front edge FRONT_LANE + 3 off the centre line
  for (const f of g.frontage) {
    const run = streetRuns(S.eff).find((q) => q.road === f.street);
    const l = r.ir.lots.find((q) => q.id === f.lot);
    const near = f.side > 0 ? l.box.minZ : l.box.maxZ;
    assert.equal(Math.abs(near - run.c), 3 + FRONT_LANE, `${f.lot} front`);
    // (street lots only: the hall stands on the square)
    const standingSameSide = S.ir.lots.filter((q) => q.ext?.['architect_mc:village']?.slot === 'street' && (f.side > 0 ? q.box.minZ > run.c : q.box.maxZ < run.c) && q.box.maxX >= run.u0 && q.box.minX <= run.u1);
    assert.equal(standingSameSide.length, 0, `${f.lot}: the lot-free side`);
  }
  // nothing written on a standing road, verge, lot box + 1, path or held column
  const K = standingClasses(S.standing);
  const cells = await cellsOf(r, S.survey);
  assert.ok(cells.length > 100);
  const bad = cells.filter(([x, , z]) => columnProblem(K, x, z));
  assert.equal(bad.length, 0, JSON.stringify(bad.slice(0, 4)));
  // ids: parts prefixed, lots the caller's, nothing standing named; no standing node or edge changed; graph.cut = []
  assert.ok(r.ir.parts.every((p) => p.id.startsWith('rv1_')));
  assert.deepEqual(nonAdditive(r.ir, { ...S.standing, ids: { parts: S.ir.parts.map((p) => p.id), lots: S.ir.lots.map((l) => l.id), roads: S.ir.roads.map((x) => x.id), nodes: S.ir.graph.nodes.map((n) => n.id) } }), []);
  const m = mergeEffective(S.ir, [{ rid: 1, position: 1, ir: r.ir }]);
  assert.deepEqual(m.graph.nodes.slice(0, S.ir.graph.nodes.length), S.ir.graph.nodes);
  assert.deepEqual(m.graph.edges.slice(0, S.ir.graph.edges.length), S.ir.graph.edges);
  assert.deepEqual(graphCut(m), []);
  // two real `along` edges per frontage junction, riding on the standing road
  const along = r.ir.graph.edges.filter((e) => e.along);
  assert.equal(along.length, 4);
  for (const e of along) assert.ok(S.ir.roads.some((x) => x.id === e.along));
  // M29 holds on the revision (the checker's rule, independent of the guard)
  const chk = checkRegion({ ir: r.ir, survey: fillMissing(asColumns(S.survey)).columns, blobs: (sha) => r.blobs.get(sha), standing: S.standing });
  assert.equal(chk.findings.filter((f) => f.rule === 'M29:revision').length, 0, JSON.stringify(chk.findings.filter((f) => f.rule === 'M29:revision')));
});

test('item 1, the broken variant: a grown lane onto a standing verge passes the guard (switched off) and M29 catches it', async () => {
  const S = await town();
  const r = await reviseIR(S.eff, { grow: { lots: LOTS2 }, unsafe: { growVerge: true } }, ctxOf(S));
  const chk = checkRegion({ ir: r.ir, survey: fillMissing(asColumns(S.survey)).columns, blobs: (sha) => r.blobs.get(sha), standing: S.standing });
  const f = chk.findings.filter((q) => q.rule === 'M29:revision');
  assert.ok(f.length >= 1 && /road|path/.test(f[0].message), JSON.stringify(f));
});

test('item 1, the extendable ends and the extension: a straight run of the street\'s look, joined end to end, flagged, its new end terminal', async () => {
  const S = await town();
  const runs = streetRuns(S.eff);
  const ends = extendableEnds(S.eff, S.standing, runs);
  assert.deepEqual(ends.map((e) => [e.node, e.ok]), [['street_e_end', true], ['street_w_start', true]]);
  // a held end: a cell past it held by another site
  const held = { ...S.standing, held: { ...S.standing.held, runs: [...S.standing.held.runs, [76, 53, 76, 53]] } };
  assert.equal(extendableEnds(S.eff, held, runs).find((e) => e.node === 'street_e_end').why, 'held');
  // a beside region's reach past it
  const besideR = { ...S.standing, beside: [{ id: 'rg2', reach: [[75, 52, 78, 54]], hold: [] }] };
  assert.equal(extendableEnds(S.eff, besideR, runs).find((e) => e.node === 'street_e_end').why, 'held');
  // a short end: the claim margin within END_ROOM
  const shortEff = { ...S.eff, claim: { ...S.eff.claim, maxX: 82 } };
  assert.equal(extendableEnds(shortEff, S.standing, runs).find((e) => e.node === 'street_e_end').why, 'room');
  // the extension (prefer: extend)
  const r = await reviseIR(S.eff, { grow: { lots: LOTS6, prefer: 'extend' } }, ctxOf(S));
  const x = r.ir.revision.grow.extension;
  assert.ok(x && x.lots.length >= 2, JSON.stringify(r.ir.revision.grow));
  const road = r.ir.roads.find((q) => q.id === x.road);
  const st = S.ir.roads.find((q) => q.id === x.along);
  assert.equal(road.width, st.width);
  assert.equal(road.surface, st.surface);
  assert.equal(road.lanterns, st.lanterns);
  assert.deepEqual(road.ext['architect_mc:street'], { zone: 'town' });
  // joined end to end: the new road's first point is the cell past the standing road's end, on its line
  const endP = st.points[st.points.length - 1];
  assert.deepEqual([road.points[0][0], road.points[0][2]], [endP[0] + 1, endP[2]]);
  assert.ok(road.points[1][0] - road.points[0][0] >= 9);
  // lots on both sides
  const sides = new Set(r.ir.lots.filter((l) => x.lots.includes(l.id)).map((l) => l.front));
  assert.deepEqual([...sides].sort(), ['north', 'south']);
  // the graph: the old end gains one edge; the new end is terminal (one edge); cut = []
  const m = mergeEffective(S.ir, [{ rid: 1, position: 1, ir: r.ir }]);
  const deg = (id) => m.graph.edges.filter((e) => e.from.split('.')[0] === id || e.to.split('.')[0] === id).length;
  assert.equal(deg('street_e_end'), 2);
  assert.equal(deg(`${x.road}_end`), 1);
  assert.deepEqual(graphCut(m), []);
  // the effective IR's new end is extendable by a later growth (a 2-lot extension leaves room); the old one is not
  const r2 = await reviseIR(S.eff, { grow: { lots: LOTS2, prefer: 'extend' } }, ctxOf(S));
  const x2 = r2.ir.revision.grow.extension;
  const m2 = mergeEffective(S.ir, [{ rid: 1, position: 1, ir: r2.ir }]);
  const e2 = extendableEnds(m2, S.standing, streetRuns(m2));
  assert.equal(e2.find((e) => e.node === 'street_e_end').ok, false);
  assert.equal(e2.find((e) => e.node === `${x2.road}_end`)?.ok, true, JSON.stringify(e2));
  // nothing written over a standing class (the verge skips a standing lot's apron ring)
  const K = standingClasses(S.standing);
  const cells = await cellsOf(r, S.survey);
  assert.equal(cells.filter(([cx, , cz]) => columnProblem(K, cx, cz)).length, 0);
  // extend: none -> frontage only; an end id that is not extendable -> NO_ROOM where nothing else fits
  const n = await reviseIR(S.eff, { grow: { lots: LOTS6, extend: 'none' } }, ctxOf(S));
  assert.equal(n.ir.revision.grow.extension, null);
  assert.ok(n.ir.revision.grow.unplaced.length >= 1);
});

test('item 1, grade: an extension ends where the street rule fails (cut/fill 3, steps of 1); lots past it are unplaced', async () => {
  // a cliff 8 high from x 96 east of the town's east end (x 74)
  const world = (x) => (x >= 96 ? { g: 72, h: 72, f: 72, flags: 0 } : { g: 64, h: 64, f: 64, flags: 0 });
  const t = await d3Town({ world });
  const ir = t.p.ir;
  const RI = reachInputs({ ir, world: t.world, claim: t.claim });
  const eff = mergeEffective(ir);
  const st = revisionStanding({ id: 'rg1', claim: t.claim, effective: eff, held: RI.besideReach.held });
  const c = { minX: 0, minZ: 0, maxX: 111, maxZ: 111, minY: -64, maxY: 319 };
  const p = growPlan({ eff, standing: st, survey: surveyApi(RI.besideReach.survey, c), grow: { lots: LOTS6, prefer: 'extend', extend: 'street_e_end' }, rid: 1 });
  assert.ok(p.extension, JSON.stringify(p.ends));
  // the run stops 3 cells into the climb at most (cut 3, steps of 1 from y 64)
  assert.ok(p.extension.run[1] <= 98, JSON.stringify(p.extension.run));
  const ext = p.lots.filter((l) => l.slot.kind === 'extension');
  assert.ok(ext.length >= 1 && ext.length < 6 && ext.every((l) => l.rect[2] <= 98), JSON.stringify(ext.map((l) => l.rect)));
});

test('NO_ROOM: every slot held refuses with its kind, nothing planned; a standing id refuses not_additive; a district must be named', async () => {
  const S = await town();
  const all = { ...S.standing, held: { ...S.standing.held, runs: [[0, 0, 111, 0], ...Array.from({ length: 112 }, (_, z) => [0, z, 111, z])] } };
  assert.equal(await errOf(reviseIR(S.eff, { grow: { lots: LOTS2 } }, ctxOf(S, 1, { standing: all }))), 'NO_ROOM held');
  assert.equal(await errOf(reviseIR(S.eff, { grow: { lots: [{ id: 'hall_1', type: 'hall', size: [9, 9] }] } }, ctxOf(S))), 'NOT_ALLOWED not_additive');
  assert.equal(await errOf(reviseIR(S.eff, { grow: { lots: [] } }, ctxOf(S))), 'NOT_ALLOWED empty');
});

test('items 10-12 (kit): a beside district and an outpost grow on their own streets (<d>_<k> ids continue), never into town land; land v 2', async () => {
  const S = await town();
  for (const [name, ds, claimB] of [['east', [{ id: 'east', size: [48, 48], lots: 2 }], [100, 13, 180, 93]], ['camp', [{ id: 'camp', size: [40, 40], lots: 2, outpost: { gap: 30 } }], [100, 13, 230, 120]]]) {
    const q = await planBeside({ town: S.t, districts: ds, claimB, besideReach: S.RI.besideReach });
    const eff = mergeEffective(q.ir);
    const RI = reachInputs({ id: 'rg2', ir: q.ir, world: S.t.world, claim: claimB });
    const st = { ...revisionStanding({ id: 'rg2', claim: claimB, effective: eff, held: RI.besideReach.held }), town: { id: 'rg1', claim: S.t.claim } };
    const ctx = { rid: 1, position: 1, parent: { rid: 0, irSha: q.irSha }, base: { irSha: q.irSha }, survey: RI.besideReach.survey, standing: st };
    const land0 = districtLand(q.ir, S.t.claim);
    assert.equal(land0.v, 1);
    assert.equal(await errOf(reviseIR(eff, { grow: { lots: 2 } }, ctx)), 'NOT_ALLOWED call');
    const r = await reviseIR(eff, { grow: { district: name, lots: 2 } }, ctx);
    assert.deepEqual(r.ir.revision.grow.lots, [`${name}_3`, `${name}_4`]);
    assert.ok(r.ir.parts.every((p) => p.id.startsWith(`rv1_${name}_`)), r.ir.parts.map((p) => p.id).join(','));
    // never town land
    const cells = await cellsOf(r, RI.besideReach.survey);
    const tc = S.t.claim;
    assert.equal(cells.filter(([x, , z]) => x >= tc[0] && x <= tc[2] && z >= tc[1] && z <= tc[3]).length, 0);
    for (const l of r.ir.lots) assert.ok(l.box.minX > tc[2] || l.box.maxZ < tc[1] || l.box.minZ > tc[3]);
    // land v 2: the grown part, its revision; outside grows, inside unchanged; after the undo (head 0, revised) the parts are gone
    const m = mergeEffective(q.ir, [{ rid: 1, position: 1, ir: r.ir }]);
    const land = districtLand(m, S.t.claim);
    assert.equal(land.v, 2);
    const gp = land.parts.find((p) => p.kind === 'grown');
    assert.equal(gp.id, 'rv1');
    assert.equal(gp.revision, 1);
    assert.equal(gp.district, name);
    assert.equal(gp.insideCells, 0);
    assert.ok(land.parts.every((p) => Number.isInteger(p.revision)));
    assert.ok(land.outside.cells > land0.outside.cells);
    assert.deepEqual(land.inside, land0.inside);
    const undone = districtLand(q.ir, S.t.claim, { revised: true });
    assert.equal(undone.v, 2);
    assert.equal(undone.parts.filter((p) => p.kind === 'grown').length, 0);
    assert.deepEqual(undone.union, land0.union);
    assert.equal(undone.outside.cells, land0.outside.cells);
    assert.deepEqual(graphCut(m), []);
    // an outpost's corridor is unchanged (item 11)
    assert.deepEqual(m.corridor, q.ir.corridor);
  }
});

test('item 2, byte identity and determinism: a program without grow is unchanged; a growth plans the same IR three times', async () => {
  const S = await town();
  const rs = [];
  for (let i = 0; i < 3; i++) rs.push(await reviseIR(S.eff, { grow: { lots: LOTS6, prefer: 'extend' } }, ctxOf(S)));
  assert.ok(rs.every((r) => r.irSha === rs[0].irSha));
  // the town replanned is the same IR (grow is a revision's alone)
  const again = await d3Town();
  assert.equal(again.p.irSha, S.t.p.irSha);
  // a non-growth revision's IR has no grow member
  const pond = await reviseIR(S.eff, { parts: [{ id: 'pond', call: { fn: 'pond', rect: [88, 88, 96, 96] } }] }, ctxOf(S));
  assert.equal(pond.ir.revision.grow, undefined);
});

test('item 1, 300 seeded synthetic towns grown 1-6 lots: kept parts untouched, deterministic, 0 writes under a standing lot box + 1 or a held column', async () => {
  const rnd = prng(20261026);
  let grown = 0, refused = 0, n = 0;
  const towns = [];
  for (let i = 0; i < 6; i++) {
    const lots = [{ id: 'hall_1', type: 'hall', size: [11 + 2 * (i % 2), 11], landmark: true }, ...Array.from({ length: 2 + (i % 3) }, (_, k) => ({ id: `c_${k + 1}`, type: 'cottage', size: [9, 9] }))];
    const t = await d3Town({ lots, seed: String(100 + i), claim: [0, 0, 111 + 8 * (i % 3), 111 + 8 * ((i + 1) % 3)] });
    const ir = t.p.ir;
    const RI = reachInputs({ ir, world: t.world, claim: t.claim });
    const eff = mergeEffective(ir);
    towns.push({ t, ir, eff, standing: revisionStanding({ id: 'rg1', claim: t.claim, effective: eff, held: RI.besideReach.held }), survey: RI.besideReach.survey });
  }
  for (let k = 0; k < 300; k++) {
    const S = towns[k % towns.length];
    const nl = 1 + Math.floor(rnd() * 6);
    const lots = Array.from({ length: nl }, (_, i) => ({ id: `g${k}_${i}`, type: 'house', size: [7 + 2 * Math.floor(rnd() * 3), 7 + 2 * Math.floor(rnd() * 3)] }));
    const grow = { lots, prefer: rnd() < 0.5 ? 'frontage' : 'extend' };
    const K = standingClasses(S.standing);
    let p;
    const sv = surveyApi(S.survey, { ...S.t.p.ir.claim });
    try { p = growPlan({ eff: S.eff, standing: S.standing, survey: sv, grow, rid: 1 }); } catch (e) { assert.match(e.message, /^NO_ROOM: \[/); refused++; continue; }
    const p2 = growPlan({ eff: S.eff, standing: S.standing, survey: sv, grow, rid: 1 });
    assert.equal(canonicalJson(p2.lots.map((l) => [l.spec.id, l.rect])), canonicalJson(p.lots.map((l) => [l.spec.id, l.rect])));
    // every lot's pad (rect + 3) and lane: no standing class
    for (const l of p.lots) {
      for (let x = l.rect[0] - 1; x <= l.rect[2] + 1; x++) for (let z = l.rect[1] - 1; z <= l.rect[3] + 1; z++) assert.equal(columnProblem(K, x, z)?.kind === 'held' || columnProblem(K, x, z)?.kind === 'lot', false, `seed ${k}: ${l.spec.id} at ${x},${z}`);
      for (const [x, , z] of l.laneCells) assert.equal(columnProblem(K, x, z), null, `seed ${k}: lane at ${x},${z}`);
    }
    n += p.lots.length;
    grown++;
  }
  assert.ok(grown >= 200, `${grown} grown, ${refused} refused`);
  assert.ok(n >= 400);
});

// ---- plan/0's revision.grow (§8, item 6's kit half)
const PV0 = path.join(KIT, 'regions', 'plan_v0.mjs');
const P0_TOWN = { schemaVersion: 'plan/0', planId: 'gr_town', zones: [{ id: 'town', program: { lots: [{ id: 'h1', type: 'house', size: [9, 9] }, { id: 'h2', type: 'house', size: [9, 9] }, { id: 'h3', type: 'house', size: [9, 9] }] }, where: { near: { anchor: 'claim_center', within: 8 } } }] };
async function p0(plan, survey, claim, revision = null) {
  const params = { plan, anchors: { anchors: {} }, protected: { areas: [] }, regions: { regions: [] }, builds: { builds: [] }, budget: {}, bible: null, fingerprint: null };
  const res = await planRegion({ programFile: PV0, params, survey, claim, roles: {}, ...(revision ? { revision } : {}) });
  const f = finishCheck({ res, survey: fillMissing(asColumns(survey)).columns, blobs: (sha) => res.blobs.get(sha) ?? null, inputs: { surveyRes: 1 } });
  return { res, ...f };
}

test('item 6 (kit): plan/0 revision.grow: a zone gaining 2 lots answers fits standing grown; the artifact lists the 2 lots; the IR holds only the growth', async () => {
  const { flatSurvey } = await import('./plan-helpers.mjs');
  const sv = flatSurvey({ W: 160, D: 160, x0: 0, z0: 0 });
  const parent = await p0(P0_TOWN, sv.bytes, sv.claim);
  assert.equal(parent.check.overall, 'READY');
  const built = parent.check.parts.filter((a) => a.class === 'fits' || a.class === 'adjusted').map((a) => a.part);
  const eff = mergeEffective(parent.res.ir);
  const world = worldOf({ flat: 64 });
  const cells = realiseAll(parent.res.ir, world);
  void cells;
  const standing = revisionStanding({ id: 'rg7', claim: [0, 0, 159, 159], effective: eff, lots: Object.fromEntries(parent.res.ir.lots.map((l) => [l.id, { state: 'placed' }])) });
  const rv = { rid: 1, position: 1, region: 'rg7', parentRid: 0, parentArtifact: parent.artifactSha, parentIrSha: parent.res.irSha, base: { irSha: parent.res.irSha },
    parent: { plan: P0_TOWN, built, geometry: Object.fromEntries(parent.check.parts.filter((a) => a.geometry?.rect).map((a) => [a.part, a.geometry.rect])) }, standing, effective: eff, history: {}, heldSha: 'held' };
  const z = JSON.parse(JSON.stringify(P0_TOWN.zones[0]));
  z.program.lots.push({ id: 'h4', type: 'house', size: [9, 9] }, { id: 'h5', type: 'house', size: [9, 9] });
  const g = await p0({ ...P0_TOWN, zones: [z], revision: { n: 1, parentArtifact: parent.artifactSha } }, sv.bytes, sv.claim, rv);
  const a = g.check.parts.find((q) => q.part === 'town');
  assert.equal(a.class, 'fits', JSON.stringify(a));
  assert.equal(a.standing, true);
  assert.deepEqual(a.grown, ['h4', 'h5']);
  assert.deepEqual(g.artifact.revision.grow, ['town']);
  assert.deepEqual(g.artifact.lots.map((l) => l.id).sort(), ['h4', 'h5']);
  assert.deepEqual(g.res.ir.lots.map((l) => l.id).sort(), ['h4', 'h5']);
  assert.ok(g.res.ir.parts.every((p) => /^rv1_/.test(p.id)), g.res.ir.parts.map((p) => p.id).join(','));
  // a zone that loses a lot answers unsupported revision.change
  const z2 = JSON.parse(JSON.stringify(P0_TOWN.zones[0]));
  z2.program.lots.pop();
  assert.equal((await p0({ ...P0_TOWN, zones: [z2], revision: { n: 1, parentArtifact: parent.artifactSha } }, sv.bytes, sv.claim, rv)).check.parts.find((q) => q.part === 'town').reasons[0].block, 'revision.change');
});
