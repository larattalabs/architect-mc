// (slice NSQ: Steward's S-NS2-1 and S-NS2-2) Growth over a plan/0 region whose street zone ran `ns` (C37's orientation, kept by Steward
// since NS2), not only AD's adopted north-south village:
//   S-NS2-1  RV/GR's frontage and extension grow lots along an ns street: east and west of it, along z, no overlap, the checks clean;
//            plan/0's revision.grow over that parent answers READY, fits standing grown.
//   S-NS2-2  IG-b: an irrigated grow lot fronting east has the frame [along, deep], and its field, sources and lotCells in the lot's
//            frame are the same as a north- or south-front lot's of the same size (the frame rotates with the front).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { KIT, flatSurvey } from './plan-helpers.mjs';
import { d3Town, reachInputs } from './d3-helpers.mjs';
import { synthVolume } from './h-helpers.mjs';
import { mergeEffective, revisionStanding, reviseIR, standingClasses, columnProblem, intendedCells } from '../lib/region/revise.mjs';
import { streetRuns, graphCut } from '../lib/region/grow.mjs';
import { planRegion, fillMissing } from '../lib/region/plan.mjs';
import { asColumns } from '../lib/region/pack.mjs';
import { finishCheck } from '../lib/plan/finish.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { lotFrame, gridOf } from '../lib/fluids/irrigate.mjs';

const PV0 = path.join(KIT, 'regions', 'plan_v0.mjs');
const house = (id) => ({ id, type: 'house', size: [9, 9] });
const P0_NS = { schemaVersion: 'plan/0', planId: 'ns_town', zones: [{ id: 'town', program: { orientation: 'ns', lots: ['h1', 'h2', 'h3'].map(house) }, where: { near: { anchor: 'claim_center', within: 8 } } }] };

async function p0(plan, survey, claim, revision = null) {
  const params = { plan, anchors: { anchors: {} }, protected: { areas: [] }, regions: { regions: [] }, builds: { builds: [] }, budget: {}, bible: null, fingerprint: null };
  const res = await planRegion({ programFile: PV0, params, survey, claim, roles: {}, ...(revision ? { revision } : {}) });
  const f = finishCheck({ res, survey: fillMissing(asColumns(survey)).columns, blobs: (sha) => res.blobs.get(sha) ?? null, inputs: { surveyRes: 1 } });
  return { res, ...f };
}

let NS = null;
/** The ns plan/0 town on a flat 160 x 160 claim, as a standing region (every lot placed). */
async function nsTown() {
  if (NS) return NS;
  const sv = flatSurvey({ W: 160, D: 160, x0: 0, z0: 0 });
  const parent = await p0(P0_NS, sv.bytes, sv.claim);
  const ir = parent.res.ir;
  const eff = mergeEffective(ir);
  const standing = revisionStanding({ id: 'rg_ns', claim: [0, 0, 159, 159], effective: eff, lots: Object.fromEntries(ir.lots.map((l) => [l.id, { state: 'placed' }])) });
  const ctx = { rid: 1, position: 1, parent: { rid: 0, irSha: parent.res.irSha }, base: { irSha: parent.res.irSha }, survey: sv.bytes, standing };
  NS = { sv, parent, ir, eff, standing, ctx, survey: sv.bytes };
  return NS;
}

let EW = null;
/** D3's ew town (ig.test.mjs's): the north and south fronts to compare with. */
async function ewTown() {
  if (EW) return EW;
  const t = await d3Town();
  const RI = reachInputs({ ir: t.p.ir, world: t.world, claim: t.claim });
  const eff = mergeEffective(t.p.ir);
  const standing = revisionStanding({ id: 'rg1', claim: t.claim, effective: eff, held: RI.besideReach.held });
  const survey = RI.besideReach.survey;
  EW = { eff, standing, survey, ctx: { rid: 1, position: 1, parent: { rid: 0, irSha: t.p.irSha }, base: { irSha: t.p.irSha }, survey, standing } };
  return EW;
}

/** The two-plan flow (Regions.planRevision's): plan, synthesize the volumes the plan asked, plan again with them. */
async function twice(S, request) {
  const first = await reviseIR(S.eff, request, S.ctx);
  const need = first.needVolumes ?? [];
  if (!need.length) return first;
  const c = S.eff.claim;
  const volumes = need.map((b) => synthVolume({ minX: b.minX, minY: b.minY, minZ: b.minZ, maxX: b.maxX, maxY: b.maxY, maxZ: b.maxZ }, S.survey, c, { fluids: !!b.fluids || !!b.blocks }));
  return reviseIR(S.eff, request, { ...S.ctx, volumes });
}

const box2 = (l) => [l.box.minX, l.box.minZ, l.box.maxX, l.box.maxZ];
const apart = (a, b, gap) => a[2] + gap < b[0] || b[2] + gap < a[0] || a[3] + gap < b[1] || b[3] + gap < a[1];

test('S-NS2-1: the parent: a plan/0 street zone forced ns plans READY, its street runs along z', async () => {
  const S = await nsTown();
  assert.equal(S.parent.check.overall, 'READY');
  assert.equal(S.parent.check.parts[0].geometry.orientation, 'ns');
  const runs = streetRuns(S.eff);
  assert.ok(runs.length >= 1 && runs.every((r) => r.o === 'ns'), JSON.stringify(runs.map((r) => [r.road, r.o])));
});

test('S-NS2-1: frontage and extension over an ns plan/0 street: lots east and west of it, along z, apart, nothing standing written, M29 clean', async () => {
  const S = await nsTown();
  const runs = streetRuns(S.eff);
  const streetX = runs[0].c;
  assert.ok(runs.every((r) => r.c === streetX), 'one straight street');
  const sides = new Set();
  for (const [prefer, lots] of [['frontage', ['h4', 'h5']], ['extend', ['h4', 'h5', 'h6', 'h7']]]) {
    const r = await reviseIR(S.eff, { grow: { lots: lots.map(house), prefer } }, S.ctx);
    const g = r.ir.revision.grow;
    assert.deepEqual(g.lots, lots, `${prefer}: ${JSON.stringify(g)}`);
    assert.deepEqual(g.unplaced, []);
    if (prefer === 'frontage') assert.ok(g.frontage.length >= 1, `frontage first: ${JSON.stringify(g.frontage)}`);
    else assert.deepEqual(g.frontage, [], 'extend first: every lot on the extension');
    // each lot stands wholly east or west of the street and fronts it (east of the street fronts west, and the reverse)
    for (const l of r.ir.lots) {
      const east = l.box.minX > streetX, west = l.box.maxX < streetX;
      assert.ok(east || west, `${prefer} ${l.id}: beside the street, not across it (${JSON.stringify(box2(l))})`);
      assert.equal(l.front, east ? 'west' : 'east', `${prefer} ${l.id} front`);
      sides.add(l.front);
    }
    // the extension continues the street along z, from its end, on its line
    if (g.extension) {
      const road = r.ir.roads.find((q) => q.id === g.extension.road);
      assert.ok(road, g.extension.road);
      assert.ok(road.points.every((p) => p[0] === streetX), `${prefer}: the extension on the street's line x ${streetX}: ${JSON.stringify(road.points)}`);
      assert.ok(Math.abs(road.points.at(-1)[2] - road.points[0][2]) >= 9, `${prefer}: the extension runs along z`);
      const standingZ = S.ir.roads.flatMap((q) => q.points.map((p) => p[2]));
      assert.ok(road.points.every((p) => p[2] > Math.max(...standingZ) || p[2] < Math.min(...standingZ)), 'past the standing street\'s end');
    } else assert.equal(prefer, 'frontage');
    if (prefer === 'extend') assert.ok(g.extension && g.extension.lots.length === lots.length, JSON.stringify(g.extension));
    // no overlap: every grown lot apart from every standing lot and every other grown lot (lotGap 3)
    const all = [...S.ir.lots.map((l) => [l.id, box2(l)]), ...r.ir.lots.map((l) => [l.id, box2(l)])];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      if (i < S.ir.lots.length && j < S.ir.lots.length) continue;
      assert.ok(apart(all[i][1], all[j][1], 2), `${prefer}: ${all[i][0]} ${JSON.stringify(all[i][1])} vs ${all[j][0]} ${JSON.stringify(all[j][1])}`);
    }
    // nothing written on a standing road, verge, lot box + 1, path or held column; the graph joins; M29 and every error clean
    const K = standingClasses(S.standing);
    const cells = await intendedCells(r.ir, S.survey, (sha) => r.blobs.get(sha));
    assert.ok(cells.length > 100);
    assert.deepEqual(cells.filter(([x, , z]) => columnProblem(K, x, z)).slice(0, 4), []);
    assert.deepEqual(graphCut(mergeEffective(S.ir, [{ rid: 1, position: 1, ir: r.ir }])), []);
    const chk = checkRegion({ ir: r.ir, survey: fillMissing(asColumns(S.survey)).columns, blobs: (sha) => r.blobs.get(sha), standing: S.standing });
    assert.deepEqual(chk.findings.filter((f) => f.rule === 'M29:revision' || f.severity === 'error').map((f) => [f.rule, f.message]), []);
  }
  assert.deepEqual([...sides].sort(), ['east', 'west'], 'lots line both sides of the street');
});

test('S-NS2-1: plan/0 revision.grow over the ns parent: the zone gaining 4 lots answers READY, fits standing grown, east and west fronts along z', async () => {
  const S = await nsTown();
  const parent = S.parent;
  const built = parent.check.parts.filter((a) => a.class === 'fits' || a.class === 'adjusted').map((a) => a.part);
  const rv = { rid: 1, position: 1, region: 'rg_ns', parentRid: 0, parentArtifact: parent.artifactSha, parentIrSha: parent.res.irSha, base: { irSha: parent.res.irSha },
    parent: { plan: P0_NS, built, geometry: Object.fromEntries(parent.check.parts.filter((a) => a.geometry?.rect).map((a) => [a.part, a.geometry.rect])) },
    standing: S.standing, effective: S.eff, history: {}, heldSha: 'held' };
  const z = JSON.parse(JSON.stringify(P0_NS.zones[0]));
  z.program.lots.push(...['g1', 'g2', 'g3', 'g4'].map(house));
  const g = await p0({ ...P0_NS, zones: [z], revision: { n: 1, parentArtifact: parent.artifactSha } }, S.sv.bytes, S.sv.claim, rv);
  assert.equal(g.check.overall, 'READY', JSON.stringify(g.check.parts));
  const a = g.check.parts.find((q) => q.part === 'town');
  assert.equal(a.class, 'fits', JSON.stringify(a));
  assert.equal(a.standing, true);
  assert.deepEqual(a.grown, ['g1', 'g2', 'g3', 'g4']);
  assert.deepEqual(g.res.ir.lots.map((l) => l.id).sort(), ['g1', 'g2', 'g3', 'g4']);
  assert.ok(g.res.ir.parts.every((p) => /^rv1_/.test(p.id)), g.res.ir.parts.map((p) => p.id).join(','));
  const streetX = streetRuns(S.eff)[0].c;
  for (const l of g.res.ir.lots) assert.equal(l.front, l.box.minX > streetX ? 'west' : 'east', `${l.id} fronts the street`);
  assert.deepEqual([...new Set(g.res.ir.lots.map((l) => l.front))].sort(), ['east', 'west']);
  const zs = g.res.ir.lots.map((l) => l.box.minZ);
  assert.ok(Math.max(...zs) - Math.min(...zs) >= 9, 'the grown lots spread along z');
});

/** An irrigated grow lot's record, read in its own frame: front, frame, field [u0, v0, u1, v1], sources [u, v], lotCells. */
function framed(lot) {
  const F = lotFrame(lot), g = lot.irrigation;
  const a = F.toFrame(g.field[0], lot.floorY, g.field[1]), b = F.toFrame(g.field[2], lot.floorY, g.field[3]);
  return {
    front: lot.front, frame: g.frame, sources: g.sources,
    field: [Math.min(a[0], b[0]), Math.min(a[2], b[2]), Math.max(a[0], b[0]), Math.max(a[2], b[2])],
    grid: gridOf(lot).map(([x, z]) => F.toFrame(x, lot.floorY, z)).map((q) => [q[0], q[2]]).sort((p, q) => p[0] - q[0] || p[1] - q[1]),
    lotCells: g.lotCells,
  };
}

test('S-NS2-2: an east-front irrigated grow lot: frame [along, deep]; field, sources and lotCells are the north/south case\'s in the frame', async () => {
  const S = await nsTown();
  const E = await ewTown();
  for (const [size, prefer] of [[[11, 12], 'frontage'], [[20, 21], 'frontage']]) {
    const farm = { id: 'farm_m', type: 'crop_farm', size, irrigate: true };
    const r = await twice(S, { grow: { lots: [farm], prefer } });
    const lot = r.ir.lots.find((l) => l.id === 'farm_m');
    assert.ok(lot && lot.irrigation, `${size}: placed and irrigated`);
    const streetX = streetRuns(S.eff)[0].c;
    assert.ok(lot.front === 'east' || lot.front === 'west', `${size}: an ns street's lot fronts east or west (${lot.front})`);
    assert.equal(lot.front === 'east' ? lot.box.maxX < streetX : lot.box.minX > streetX, true, 'on the side it fronts from');
    // the world box: along (z) by deep (x); the frame [along, deep]
    assert.deepEqual([lot.box.maxZ - lot.box.minZ + 1, lot.box.maxX - lot.box.minX + 1], size, 'box: along z, deep x');
    assert.deepEqual(lot.irrigation.frame, size);
    assert.deepEqual(lotFrame(lot).size, size);
    // the field in world: the box less a 1-column border and less the two street-side rows (the front row and the one behind it)
    const [fx0, fz0, fx1, fz1] = lot.irrigation.field;
    assert.deepEqual([fz0, fz1], [lot.box.minZ + 1, lot.box.maxZ - 1], 'the field across, along z');
    if (lot.front === 'east') assert.deepEqual([fx0, fx1], [lot.box.minX + 1, lot.box.maxX - 2], 'the front (east) rows off');
    else assert.deepEqual([fx0, fx1], [lot.box.minX + 1, lot.box.maxX - 1].map((v, i) => (i === 0 ? v + 1 : v)), 'the front (west) rows off');
    // the same lot fronting north or south (D3's ew town): identical in the frame
    const q = await twice(E, { grow: { lots: [farm], prefer } });
    const ref = q.ir.lots.find((l) => l.id === 'farm_m');
    assert.ok(ref.front === 'north' || ref.front === 'south', ref.front);
    const a = framed(lot), b = framed(ref);
    assert.deepEqual({ ...a, front: null }, { ...b, front: null }, `${size}: ${lot.front} vs ${ref.front}`);
    // the sources sit on the water cells the record lists (each source column inside the field)
    for (const [x, z] of gridOf(lot)) assert.ok(x >= fx0 && x <= fx1 && z >= fz0 && z <= fz1, `source ${x},${z} in the field`);
    // M25 and M29 clean
    const chk = checkRegion({ ir: r.ir, survey: fillMissing(asColumns(S.survey)).columns, blobs: (sha) => r.blobs.get(sha), standing: S.standing });
    assert.deepEqual(chk.findings.filter((f) => /^M2[59]/.test(f.rule) && f.severity !== 'info'), []);
  }
});
