// (6d AD, docs/CONTRACT.md "Phase 6d slice AD" §2.2, §4 row 1) adopted_village: a standing VillageLayout settlement as a region IR. 20
// synthetic settlements laid out by a port of Steward's VillageLayout.tryStreet (both sides of one straight street, lots from the
// middle outward, lotGap 3, the 5-wide street), some with a second collinear street piece (an addition's `street#2`), some north-south:
// the IR's lots are the sites' boxes, facing the street, its roads the road sites (2 points, flagged architect_mc:street {zone}), its
// graph V's shape (a lot node per lot, a junction per entrance on the line, the plaza at the middle, terminal ends whose one edge is
// their street's), and no parts, tiles or budget. Then GR grows two of them by frontage and one by an extension over the adopted IR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planRegion } from '../lib/region/plan.mjs';
import { columnsOf, worldOf, prng } from './region-helpers.mjs';
import { KIT } from './d3-helpers.mjs';
import { adoptedLayout } from '../regions/adopted_village.mjs';
import { mergeEffective, revisionStanding, reviseIR } from '../lib/region/revise.mjs';
import { streetRuns, extendableEnds, growObstacles } from '../lib/region/grow.mjs';

const PROGRAM = path.join(KIT, 'regions', 'adopted_village.mjs');

/** Steward's VillageLayout.tryStreet on flat ground (no slope, no water): lots on both sides, alternating, from the middle out. */
function villageLayout({ cx, cz, radius, specs, streetZ, northFirst = true, eastFirst = true }) {
  const m = 2, half = 2, gap = 3;
  const xMin = cx - radius + m, xMax = cx + radius - m, zMin = cz - radius + m, zMax = cz + radius - m;
  const placed = [];
  const left = [...specs];
  const curN = [cx, cx - 1], curS = [cx, cx - 1];
  let north = northFirst;
  for (let guard = 0; guard < 4000 && left.length; guard++) {
    const cur = north ? curN : curS;
    let one = false;
    for (let t = 0; t < 2 && !one; t++) {
      const east = (guard + t + (eastFirst ? 0 : 1)) % 2 === 0;
      const s = left[0];
      const x = east ? cur[0] : cur[1] - s.sx + 1;
      const z = north ? streetZ - half - 1 - s.sz + 1 : streetZ + half + 1;
      if (x < xMin || x + s.sx - 1 > xMax || z < zMin || z + s.sz - 1 > zMax) continue;
      if (placed.some((o) => x <= o.x + o.sx - 1 + gap && x + s.sx - 1 >= o.x - gap && z <= o.z + o.sz - 1 + gap && z + s.sz - 1 >= o.z - gap)) {
        if (east) cur[0] += 2; else cur[1] -= 2;
        continue;
      }
      placed.push({ ...s, x, z, north });
      left.shift();
      if (east) cur[0] = x + s.sx + gap; else cur[1] = x - gap - 1;
      one = true;
    }
    north = !north;
    if (!(curN[0] <= xMax || curN[1] >= xMin || curS[0] <= xMax || curS[1] >= xMin)) break;
  }
  const x0 = Math.min(...placed.map((l) => l.x)), x1 = Math.max(...placed.map((l) => l.x + l.sx - 1));
  return { lots: placed, streetZ, x0, x1 };
}

/** A synthetic settlement as Regions.adopt's kit input (the mod builds the same from the sites): ew or ns, one or two street pieces. */
function settlement(k) {
  const rnd = prng(`ad-${k}`);
  const n = 3 + Math.floor(rnd() * 8);
  const specs = Array.from({ length: n }, (_, i) => ({ id: `${['house', 'smithy', 'farm', 'hall'][i % 4]}_${i + 1}`, type: ['house', 'smithy', 'farm', 'hall'][i % 4], sx: 9 + 2 * Math.floor(rnd() * 3), sz: 9 + 2 * Math.floor(rnd() * 3) }));
  const cx = 2000 + 300 * k, cz = -1500, radius = 96, y = 64;
  const streetZ = cz + Math.floor(rnd() * 9) - 4;
  const L = villageLayout({ cx, cz, radius, specs, streetZ, northFirst: rnd() < 0.5, eastFirst: rnd() < 0.5 });
  const ns = k % 4 === 3;
  // a site's box: the design within its lot, shrunk 1 at the back (the approach stops clear of the verge, as fitToLot leaves it)
  const lots = L.lots.map((l) => {
    const b = [l.x, y, l.z, l.x + l.sx - 1, y + 7, l.z + l.sz - 1];
    if (l.north) b[2] += 1; else b[5] -= 1;
    return { id: l.id, site: `s${100 + k * 20 + specs.findIndex((s) => s.id === l.id)}`, box: ns ? [b[2], b[1], b[0], b[5], b[4], b[3]] : b, type: l.type };
  });
  const split = k % 3 === 1 && L.x1 - L.x0 > 20 ? L.x0 + Math.floor((L.x1 - L.x0) / 2) : null;
  const spans = split === null ? [[L.x0, L.x1]] : [[L.x0, split], [split + 1, L.x1]];
  const pt = (u) => (ns ? [streetZ, y - 1, u] : [u, y - 1, streetZ]);
  const roads = spans.map(([a, b], i) => ({ site: `r${10 + k * 3 + i}`, points: [pt(a), pt(b)], width: 3 }));
  const geometry = ns ? { streetX: streetZ, zLo: L.x0, zHi: L.x1 } : { streetZ, xLo: L.x0, xHi: L.x1 };
  const claimR = [cx - radius, cz - radius, cx + radius, cz + radius];
  const claim = ns ? { minX: claimR[1], minZ: claimR[0], maxX: claimR[3], maxZ: claimR[2], minY: -64, maxY: 319 } : { minX: claimR[0], minZ: claimR[1], maxX: claimR[2], maxZ: claimR[3], minY: -64, maxY: 319 };
  return { adopt: { zone: 'village', geometry, roads, lots }, claim, ns, streetZ, x0: L.x0, x1: L.x1, spans };
}

async function planAdopted(s, world = worldOf({ flat: 63 })) {
  const c = s.claim;
  const survey = columnsOf(world, c.minX, c.minZ, c.maxX - c.minX + 1, c.maxZ - c.minZ + 1);
  return planRegion({ programFile: PROGRAM, params: { adopt: s.adopt }, survey, claim: c, seed: '1' });
}

const SETTLEMENTS = Array.from({ length: 20 }, (_, k) => settlement(k));

test('row 1: 20 synthetic VillageLayout settlements: lots, roads and graph as V\'s for the same geometry; no parts', async () => {
  let pieces2 = 0, ns = 0;
  for (const s of SETTLEMENTS) {
    const p = await planAdopted(s);
    const ir = p.ir;
    // no parts: no ops, no tile, budget 0, one stage
    assert.deepEqual(ir.parts, []);
    assert.deepEqual(ir.stages, ['adopted']);
    assert.deepEqual(ir.tiles, { adopted: { terrain: [], path: [] } });
    assert.deepEqual(ir.budget, { cells: 0, removed: 0, added: 0 });
    // the lots: the sites' boxes as they stand, adopted, facing the street, entrance in front of the middle of the front edge
    assert.equal(ir.lots.length, s.adopt.lots.length);
    for (const l of s.adopt.lots) {
      const x = ir.lots.find((q) => q.id === l.id);
      assert.ok(x, l.id);
      assert.equal(x.adopted, l.site);
      assert.deepEqual([x.box.minX, x.box.minY, x.box.minZ, x.box.maxX, x.box.maxY, x.box.maxZ], l.box);
      const across = s.ns ? [x.box.minX, x.box.maxX] : [x.box.minZ, x.box.maxZ];
      const before = across[1] < s.streetZ;
      assert.equal(x.front, s.ns ? (before ? 'east' : 'west') : (before ? 'south' : 'north'), `${l.id} front`);
      const ev = s.ns ? x.entrance[0] : x.entrance[2];
      assert.equal(ev, before ? across[1] + 1 : across[0] - 1, `${l.id} entrance on its front`);
      assert.equal(x.ext['architect_mc:village'].slot, 'street');
    }
    // the roads: one per road site, 2 points on the line, flagged with the zone, ids street_<n> in order along the street
    assert.equal(ir.roads.length, s.spans.length);
    s.spans.forEach(([a, b], i) => {
      const rd = ir.roads[i];
      assert.equal(rd.id, `street_${i + 1}`);
      assert.equal(rd.adopted, s.adopt.roads[i].site);
      assert.equal(rd.points.length, 2);
      assert.deepEqual(rd.ext, { 'architect_mc:street': { zone: 'village' } });
      const u = rd.points.map((q) => (s.ns ? q[2] : q[0]));
      assert.deepEqual(u, [a, b]);
    });
    if (s.spans.length > 1) pieces2++;
    if (s.ns) ns++;
    // the graph: V's shape
    const g = ir.graph;
    const node = (id) => g.nodes.find((n) => n.id === id);
    const lotNodes = g.nodes.filter((n) => n.kind === 'lot');
    assert.equal(lotNodes.length, s.adopt.lots.length);
    for (const l of ir.lots) assert.deepEqual(node(`lot:${l.id}`).at, l.entrance);
    const plaza = g.nodes.filter((n) => n.kind === 'plaza');
    assert.equal(plaza.length, 1);
    const mid = Math.floor((s.x0 + s.x1) / 2);
    assert.equal(s.ns ? plaza[0].at[2] : plaza[0].at[0], mid, 'the plaza at the street\'s middle');
    // every lot's lane edge ends at a junction on the line, at the entrance's u
    for (const l of ir.lots) {
      const e = g.edges.find((x) => x.id === `lane_${l.id}`);
      assert.ok(e, `lane_${l.id}`);
      const j = node(e.to.split('.')[0]);
      assert.equal(j.kind, 'junction');
      assert.equal(s.ns ? j.at[0] : j.at[2], s.streetZ);
      const eu = s.ns ? l.entrance[2] : l.entrance[0];
      assert.equal(s.ns ? j.at[2] : j.at[0], Math.max(s.x0, Math.min(s.x1, eu)));
    }
    // the junctions along the street form one chain of road edges from end to end (connected, no branch)
    const roadEdges = g.edges.filter((e) => e.type === 'road' && e.id !== 'plaza_link');
    const junctions = g.nodes.filter((n) => n.kind === 'junction');
    assert.equal(roadEdges.length, junctions.length - 1);
    const deg = new Map();
    for (const e of roadEdges) for (const end of [e.from, e.to]) { const n = end.split('.')[0]; deg.set(n, (deg.get(n) ?? 0) + 1); }
    assert.equal([...deg.values()].filter((d) => d === 1).length, 2, 'two ends');
    assert.ok([...deg.values()].every((d) => d <= 2));
    // its two ends are terminal: GR finds both as extendable ends of its street (their one edge is their street's)
    const runs = streetRuns(ir);
    const st = revisionStanding({ id: 'rg1', claim: [s.claim.minX, s.claim.minZ, s.claim.maxX, s.claim.maxZ], effective: mergeEffective(ir) });
    const ends = extendableEnds(ir, st, runs, growObstacles(ir, st));
    const terminal = ends.filter((e) => e.why !== 'join' && e.why !== 'edges' && e.why !== 'layout');
    assert.equal(terminal.length, 2, JSON.stringify(ends.map((e) => [e.node, e.why])));
  }
  assert.ok(pieces2 >= 4 && ns >= 4, `variety: ${pieces2} two-piece streets, ${ns} north-south`);
});

test('the refusals: a road off the line, a lot across or on the street, a lot far from it, a gap between pieces, a site named twice', async () => {
  const s = SETTLEMENTS[0];
  const bad = (f) => { const a = JSON.parse(JSON.stringify(s.adopt)); f(a); return a; };
  const cases = [
    [bad((a) => { a.roads[0].points[1][2] += 1; }), /not along the street line/],
    [bad((a) => { const b = a.lots[0].box; a.lots[0].box = [b[0], b[1], s.streetZ - 2, b[3], b[4], s.streetZ + 2]; }), /crosses the street line/],
    [bad((a) => { const b = a.lots[0].box; const d = b[5] < s.streetZ ? s.streetZ - 2 - b[5] : s.streetZ + 2 - b[2]; a.lots[0].box = [b[0], b[1], b[2] + d, b[3], b[4], b[5] + d]; }), /stands on the street/],
    [bad((a) => { const b = a.lots[0].box; const d = b[5] < s.streetZ ? -40 : 40; a.lots[0].box = [b[0], b[1], b[2] + d, b[3], b[4], b[5] + d]; }), /does not face the street/],
    [bad((a) => { a.roads.push({ site: 'r_far', points: [[s.x1 + 10, 62, s.streetZ], [s.x1 + 20, 62, s.streetZ]] }); }), /leave a gap/],
    [bad((a) => { a.lots[1].site = a.lots[0].site; }), /also a road|named twice|site/],
    [bad((a) => { a.lots[1].site = a.roads[0].site; }), /also a road/],
  ];
  for (const [adopt, re] of cases) {
    await assert.rejects(planAdopted({ ...s, adopt }), (e) => /^NOT_ALLOWED: \[adopt\]/.test(e.message) && re.test(e.message), String(re));
  }
  assert.throws(() => adoptedLayout({ ...s.adopt, geometry: { streetZ: 1 } }), /geometry/);
});

test('deterministic: the same settlement plans to the same IR sha', async () => {
  const a = await planAdopted(SETTLEMENTS[5]);
  const b = await planAdopted(SETTLEMENTS[5]);
  assert.equal(a.irSha, b.irSha);
});

test('GR over an adopted village: frontage on its street (the zone\'s), then an extension from a terminal end', async () => {
  const world = worldOf({ flat: 63 });
  for (const k of [0, 4]) {
    const s = SETTLEMENTS[k];
    const p = await planAdopted(s, world);
    const eff = mergeEffective(p.ir);
    const c = s.claim;
    const survey = columnsOf(world, c.minX, c.minZ, c.maxX - c.minX + 1, c.maxZ - c.minZ + 1);
    const standing = revisionStanding({ id: 'rg1', claim: [c.minX, c.minZ, c.maxX, c.maxZ], effective: eff, lots: Object.fromEntries(p.ir.lots.map((l) => [l.id, { state: 'placed', siteId: l.adopted }])) });
    const ctx = { rid: 1, position: 1, parent: { rid: 0, irSha: p.irSha }, base: { irSha: p.irSha }, survey, standing };
    const r = await reviseIR(eff, { grow: { lots: [{ id: 'grown_1', type: 'house', size: [9, 9] }], zone: 'village' } }, ctx);
    const g = r.ir.revision.grow;
    assert.deepEqual(g.lots, ['grown_1'], `settlement ${k}: ${JSON.stringify(g)}`);
    assert.deepEqual(g.unplaced, []);
    // the grown lot keeps off every standing lot box + lotGap
    const l = r.ir.lots.find((q) => q.id === 'grown_1');
    for (const o of p.ir.lots) assert.ok(l.box.maxX + 3 < o.box.minX || o.box.maxX + 3 < l.box.minX || l.box.maxZ + 3 < o.box.minZ || o.box.maxZ + 3 < l.box.minZ, `grown_1 vs ${o.id}`);
    // an extension preferred: it starts from one of the street's terminal ends
    const x = await reviseIR(eff, { grow: { lots: [{ id: 'grown_2', type: 'house', size: [9, 9] }], prefer: 'extend' } }, ctx);
    const ext = x.ir.revision.grow.extension;
    assert.ok(ext && /^street_\d+_(start|end)$/.test(ext.from ?? ext.end ?? ext.node ?? ''), `settlement ${k}: the extension ${JSON.stringify(ext)}`);
  }
});

// ---- row 3's kit half: plan/0's revision.grow over an adopted village, its parent the artifact Regions.adopt writes (RegionAdopt.writeArtifact)
test('row 3 (kit): a revision plan naming the adopted artifact (its zone with one more lot) answers fits standing grown', async () => {
  const { planRegion: pr } = await import('../lib/region/plan.mjs');
  const { finishCheck } = await import('../lib/plan/finish.mjs');
  const { fillMissing } = await import('../lib/region/plan.mjs');
  const { asColumns } = await import('../lib/region/pack.mjs');
  const s = SETTLEMENTS[0];
  const world = worldOf({ flat: 63 });
  const p = await planAdopted(s, world);
  const c = s.claim;
  const survey = columnsOf(world, c.minX, c.minZ, c.maxX - c.minX + 1, c.maxZ - c.minZ + 1);
  // the adopted artifact's plan, as the mod writes it: one zone `village`, its lots [along, deep] in IR order
  const lots = p.ir.lots.map((l) => ({ id: l.id, type: s.adopt.lots.find((q) => q.id === l.id).type, size: [l.box.maxX - l.box.minX + 1, l.box.maxZ - l.box.minZ + 1] }));
  const parentPlan = { schemaVersion: 'plan/0', planId: 'adopted_rg1', zones: [{ id: 'village', program: { lots } }] };
  const eff = mergeEffective(p.ir);
  const standing = revisionStanding({ id: 'rg1', claim: [c.minX, c.minZ, c.maxX, c.maxZ], effective: eff, lots: Object.fromEntries(p.ir.lots.map((l) => [l.id, { state: 'placed', siteId: l.adopted }])) });
  const rv = { rid: 1, position: 1, region: 'rg1', parentRid: 0, parentArtifact: 'a'.repeat(64), parentIrSha: p.irSha, base: { irSha: p.irSha },
    parent: { plan: parentPlan, built: ['village'], geometry: { village: [c.minX + 2, c.minZ + 2, c.maxX - 2, c.maxZ - 2] } }, standing, effective: eff, history: {}, heldSha: 'held' };
  // Steward's plan writer: the adopted zone with one more lot
  const plan = JSON.parse(JSON.stringify(parentPlan));
  plan.zones[0].program.lots.push({ id: 'grown_1', type: 'house', size: [9, 9] });
  plan.revision = { n: 1, parentArtifact: rv.parentArtifact };
  const params = { plan, anchors: { anchors: {} }, protected: { areas: [] }, regions: { regions: [] }, builds: { builds: [] }, budget: {}, bible: null, fingerprint: null };
  const res = await pr({ programFile: path.join(KIT, 'regions', 'plan_v0.mjs'), params, survey, claim: c, roles: {}, revision: rv });
  const f = finishCheck({ res, survey: fillMissing(asColumns(survey)).columns, blobs: (sha) => res.blobs.get(sha) ?? null, inputs: { surveyRes: 1 } });
  const a = f.check.parts.find((q) => q.part === 'village');
  assert.equal(f.check.overall, 'READY', JSON.stringify(f.check.parts));
  assert.equal(a.class, 'fits', JSON.stringify(a));
  assert.equal(a.standing, true);
  assert.deepEqual(a.grown, ['grown_1']);
  assert.deepEqual(f.artifact.lots.map((l) => l.id), ['grown_1']);
  assert.deepEqual(res.ir.lots.map((l) => l.id), ['grown_1']);
});
