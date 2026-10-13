// 6c D1 (docs/CONTRACT.md "Phase 6c slice D" §2-§4): the districts pass. Items 1 (the assignment on 300 seeded claims: exact <=
// greedy, no overlap, 0 candidates in keep-out or C17 areas, unplaced exact; full plans on a sample: 0 lots in keep-out), 2 (level
// bands on districts_demo over S3's survey), 3 (connectivity: the plan graph and the checker's player/villager reach), 4
// (loopiness: the added loop cost within loopiness of the tree's, +-0.02), 8 (the kit half of determinism), the beside rule (§3:
// the seam, the join, the external edge, the IR's beside) and the pure pieces (Hungarian against brute force, Kruskal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { PASS_NAMES } from '../lib/region/passes/index.mjs';
import { DISTRICT_GAP, DISTRICT_INF, EXACT_MAX, assignDistricts, candidateCost, districtCandidates, hungarian, levelBands, rectsMeet, spanningEdges } from '../lib/region/passes/districts.mjs';
import { besidePorts, parseDistricts } from '../lib/region/districtsEmit.mjs';
import { besideData, seamProblem, SEAM_MAX, standingFootprint } from '../lib/region/beside.mjs';
import { columnsOf, prng, worldOf } from './region-helpers.mjs';
import { synthWorld } from '../lib/region/synth.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(KIT, '..');
const S3 = { minX: 3604, minZ: -1036, maxX: 3795, maxZ: -845, minY: 22, maxY: 220 };
const s3Survey = () => fs.readFileSync(path.join(ROOT, 'scenarios', 'goldens', 'route_demo', 'survey.bin'));

/** Connected components of a plan graph (external edges left out). */
function components(graph) {
  const adj = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    if (e.external) continue;
    const a = e.from.split('.')[0], b = e.to.split('.')[0];
    adj.get(a)?.push(b); adj.get(b)?.push(a);
  }
  const seen = new Set(), out = [];
  for (const n of graph.nodes) {
    if (seen.has(n.id)) continue;
    const c = [n.id];
    seen.add(n.id);
    for (let i = 0; i < c.length; i++) for (const y of adj.get(c[i]) ?? []) if (!seen.has(y)) { seen.add(y); c.push(y); }
    out.push(c);
  }
  return out;
}

test('the pass is registered; a program must declare it', () => {
  assert.ok(PASS_NAMES.includes('districts'));
});

test('hungarian equals brute force on small integer matrices (with forbidden cells)', () => {
  const R = prng(7);
  for (let t = 0; t < 200; t++) {
    const n = R.int(1, 4), m = R.int(n, 6);
    const M = Array.from({ length: n }, () => Array.from({ length: m }, () => (R() < 0.15 ? DISTRICT_INF : R.int(0, 50))));
    const h = hungarian(n, m, (i, j) => M[i][j]);
    let best = Infinity;
    const rec = (i, used, s) => {
      if (i === n) { best = Math.min(best, s); return; }
      for (let j = 0; j < m; j++) if (!used.has(j) && M[i][j] < DISTRICT_INF) { used.add(j); rec(i + 1, used, s + M[i][j]); used.delete(j); }
    };
    rec(0, new Set(), 0);
    if (best === Infinity) assert.equal(h, null); else assert.equal(h.total, best, `trial ${t}`);
  }
});

test('spanningEdges: Kruskal over the routable pairs, loops within loopiness, components', () => {
  const pairs = [{ a: 'a', b: 'b', cost: 10 }, { a: 'b', b: 'c', cost: 10 }, { a: 'a', b: 'c', cost: 3 }, { a: 'c', b: 'd', cost: DISTRICT_INF }];
  const s = spanningEdges(['a', 'b', 'c', 'd'], pairs, 1);
  assert.deepEqual(s.tree.map((p) => `${p.a}${p.b}`), ['ac', 'ab']);
  assert.equal(s.treeCost, 13);
  assert.deepEqual(s.loops.map((p) => `${p.a}${p.b}`), ['bc']); // 10 <= 13 * 1
  assert.deepEqual(s.components, [['a', 'b', 'c'], ['d']]);
  assert.equal(spanningEdges(['a', 'b', 'c'], pairs.slice(0, 3), 0.15).loops.length, 0); // 10 > 13 * 0.15
});

test('item 1: the assignment on 300 seeded claims: exact <= greedy, picks never overlap, none in keep-out or C17 areas, unplaced exact', () => {
  const R = prng(2026101301);
  let exactWins = 0, placed = 0, unplacedN = 0, bnb = 0;
  for (let n = 0; n < 300; n++) {
    const W = R.int(96, 192), D = R.int(96, 192);
    const claim = { minX: R.int(-2000, 2000), minZ: R.int(-2000, 2000) };
    claim.maxX = claim.minX + W - 1; claim.maxZ = claim.minZ + D - 1;
    const world = synthWorld(`d1-${n}`);
    const cols = columnsOf(world, claim.minX, claim.minZ, W, D);
    // keep-out (the owner's) and C17 areas: both arrive as keep-out rects
    const keepOut = Array.from({ length: R.int(0, 4) }, () => { const x = R.int(claim.minX, claim.maxX - 8), z = R.int(claim.minZ, claim.maxZ - 8); return [x, z, x + R.int(4, 30), z + R.int(4, 30)]; });
    const nd = R.int(2, 6);
    const ds = Array.from({ length: nd }, (_, i) => ({ id: `d${i}`, size: [R.int(24, 48), R.int(24, 48)], levelBand: ['any', 'low', 'mid', 'high'][R.int(0, 3)], prefer: R() < 0.3 ? ['flat'] : [] }));
    const bands = levelBands(cols, claim);
    const cands = ds.map((d) => districtCandidates(cols, claim, d.size, { bands, blocked: keepOut, band: d.levelBand, limit: EXACT_MAX }).map((c) => ({ ...c, cost: candidateCost(d, c) })).filter((c) => c.cost < DISTRICT_INF));
    for (const cs of cands) for (const c of cs) for (const k of keepOut) assert.ok(!rectsMeet(c.rect, { minX: k[0], minZ: k[1], maxX: k[2], maxZ: k[3] }), `claim ${n}: candidate ${c.id} meets keep-out`);
    const ex = assignDistricts(ds, cands);
    const gr = assignDistricts(ds, cands, { exact: false });
    assert.ok(ex.cost <= gr.cost, `claim ${n}: exact ${ex.cost} > greedy ${gr.cost}`);
    if (ex.cost < gr.cost) exactWins++;
    if (ex.nodes > 1) bnb++;
    for (const a of [ex, gr]) {
      for (let i = 0; i < nd; i++) for (let j = i + 1; j < nd; j++) {
        if (a.pick[i] < 0 || a.pick[j] < 0) continue;
        assert.ok(!rectsMeet(cands[i][a.pick[i]].rect, cands[j][a.pick[j]].rect, DISTRICT_GAP), `claim ${n}: ${a.method} picks overlap`);
      }
      // unplaced exact: a district is unplaced iff it has no pick, and only when every candidate it has meets a pick (or it has none)
      for (let i = 0; i < nd; i++) {
        if (a.pick[i] >= 0) continue;
        for (const c of cands[i]) assert.ok(a.pick.some((pj, j) => j !== i && pj >= 0 && rectsMeet(cands[j][pj].rect, c.rect, DISTRICT_GAP)) || !a.exact, `claim ${n}: ${ds[i].id} unplaced with a free candidate`);
      }
    }
    placed += ex.pick.filter((p) => p >= 0).length; unplacedN += ex.pick.filter((p) => p < 0).length;
  }
  assert.ok(placed > 300, `districts placed (${placed})`);
  console.log(`# 300 claims: ${placed} placed, ${unplacedN} unplaced, exact beat greedy on ${exactWins}, branch and bound on ${bnb}`);
});

test('item 1 (full plans): 0 lots in keep-out on seeded claims; every district placed or listed unplaced; lots placed + unplaced = asked', async () => {
  const R = prng(99);
  for (let n = 0; n < 6; n++) {
    const claim = { minX: 0, minZ: 0, maxX: 159, maxZ: 159, minY: -64, maxY: 319 };
    const world = worldOf({ seed: `full-${n}` });
    const keepOut = [[R.int(20, 100), R.int(20, 100), 0, 0]].map((k) => [k[0], k[1], k[0] + 20, k[1] + 12]);
    const ds = [{ id: 'a', size: [36, 36], lots: 2 }, { id: 'b', size: [40, 36], lots: 3 }, { id: 'c', size: [32, 32], lots: 2 }];
    let p;
    try {
      p = await planRegion({ programFile: path.join(KIT, 'regions', 'districts.mjs'), params: { spec: { districts: ds }, lamps: false }, survey: columnsOf(world, 0, 0, 160, 160), claim, seed: '1', keepOut });
    } catch (e) { assert.match(e.message, /NO_ROOM/); continue; }
    const d = p.meta.districts;
    for (const l of p.ir.lots) for (const k of keepOut) assert.ok(!(l.box.minX <= k[2] && l.box.maxX >= k[0] && l.box.minZ <= k[3] && l.box.maxZ >= k[1]), `claim ${n}: lot ${l.id} in keep-out`);
    const ids = new Set([...Object.keys(d.rects), ...d.unplaced.map((u) => u.id)]);
    assert.deepEqual([...ids].sort(), ['a', 'b', 'c']);
    for (const x of ds) if (d.rects[x.id]) assert.equal(d.lots[x.id].length + d.unplacedLots[x.id].length, x.lots);
    assert.deepEqual(p.ir.keepOut, keepOut.map((k) => [...k]));
  }
});

let demo = null;
const demoPlan = async () => (demo ??= await planRegion({ programFile: path.join(KIT, 'regions', 'districts_demo.mjs'), survey: s3Survey(), claim: S3, seed: '1' }));

test('item 2: districts_demo on S3\'s claim: every district placed in its level band', async () => {
  const p = await demoPlan();
  const d = p.meta.districts;
  assert.deepEqual(Object.keys(d.rects).sort(), ['cloister', 'fields', 'village']);
  for (const [id, b] of Object.entries(d.bandOf)) assert.equal(b.got, b.want, `${id}: y ${b.y} in ${b.got}, wanted ${b.want}`);
  assert.equal(d.exact, true);
  assert.deepEqual(d.unplaced, []);
});

test('item 3: districts_demo: every district node reaches every other by the plan\'s edges; the checker\'s player and villager reach 100%', async () => {
  const p = await demoPlan();
  const comps = components(p.ir.graph);
  assert.equal(comps.length, 1, comps.map((c) => c.join(',')).join(' | '));
  for (const id of ['cloister', 'village', 'fields']) assert.ok(p.ir.graph.nodes.some((n) => n.id === `${id}_plaza`));
  const rep = checkRegion({ ir: p.ir, survey: s3Survey(), blobs: p.blobs, meta: p.meta });
  assert.equal(rep.errors, 0, rep.findings.filter((f) => f.severity === 'error').map((f) => `${f.rule} ${f.message}`).join('; '));
  for (const m of rep.metrics.route.edges) { assert.equal(m.player, true, m.id); assert.equal(m.villager, true, m.id); assert.equal(m.ladders, 0, m.id); assert.equal(m.grade.bad, 0, m.id); }
  assert.ok(p.meta.districts.edges.every((e) => e.ok));
});

test('item 4: loopiness: the added loop cost stays within loopiness of the tree\'s (+-0.02); loops appear when the bar allows them', async () => {
  const claim = { minX: 0, minZ: 0, maxX: 255, maxZ: 255, minY: -64, maxY: 319 };
  const survey = columnsOf(worldOf({ flat: 64 }), 0, 0, 256, 256);
  const ds = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, size: [32, 32], lots: 1 }));
  for (const lp of [15, 50]) {
    const p = await planRegion({ programFile: path.join(KIT, 'regions', 'districts.mjs'), params: { spec: { districts: ds }, loopiness: lp, lamps: false }, survey, claim, seed: '1' });
    const d = p.meta.districts;
    assert.equal(Object.keys(d.rects).length, 8);
    assert.ok(d.treeCost > 0);
    assert.ok(d.loopCost <= (lp / 100 + 0.02) * d.treeCost, `loopiness ${lp}: ${d.loopCost} of ${d.treeCost}`);
    assert.equal(d.edges.filter((e) => e.kind === 'tree').length, 7);
    if (lp === 50) assert.ok(d.edges.some((e) => e.kind === 'loop'), 'a loop at 0.5');
    assert.equal(components(p.ir.graph).length, 1);
  }
});

test('item 8 (kit half): districts_demo plans to one IR sha three times', async () => {
  const a = await demoPlan();
  const b = await planRegion({ programFile: path.join(KIT, 'regions', 'districts_demo.mjs'), survey: s3Survey(), claim: S3, seed: '1' });
  assert.equal(a.irSha, b.irSha);
});

test('parseDistricts: named refusals', () => {
  assert.throws(() => parseDistricts([]), /at least one/);
  assert.throws(() => parseDistricts([{ id: 'a', size: [10, 10], lots: 1 }]), /size/);
  assert.throws(() => parseDistricts([{ id: 'a', size: [32, 32], lots: 1 }, { id: 'a', size: [32, 32], lots: 1 }]), /used twice/);
  assert.throws(() => parseDistricts([{ id: 'a', size: [32, 32], lots: 1, near: ['b'] }]), /near/);
  assert.throws(() => parseDistricts([{ id: 'a', size: [32, 32], lots: 1, levelBand: 'up' }]), /levelBand/);
  assert.throws(() => parseDistricts([{ id: 'a', size: [32, 32], lots: [{ id: 'x', type: 'house', size: [9, 9] }] }, { id: 'b', size: [32, 32], lots: [{ id: 'x', type: 'house', size: [9, 9] }] }]), /another district/);
  assert.equal(parseDistricts([{ id: 'a', size: [32, 32], lots: 3 }])[0].specs.length, 3);
});

// ------------------------------------------------------------------ beside (§3)

const standing = async () => {
  const world = worldOf({ flat: 64 });
  const lots = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }, { id: 'cottage_2', type: 'cottage', size: [9, 9] }, { id: 'smithy_1', type: 'smithy', size: [9, 9] }, { id: 'farm_1', type: 'farm', size: [13, 13] }];
  const A = { minX: 0, minZ: 0, maxX: 111, maxZ: 111, minY: -64, maxY: 319 };
  const p = await planRegion({ programFile: path.join(KIT, 'regions', 'flat_village.mjs'), params: { lots }, survey: columnsOf(world, 0, 0, 112, 112), claim: A, seed: '1' });
  return { world, p, claim: [0, 0, 111, 111] };
};

test('beside §3: the seam rule (at most 16 deep, never over lots, roads or paths)', async () => {
  const { p, claim } = await standing();
  const f = standingFootprint(p.ir);
  assert.ok(f.lots.length === 5 && f.roads.length >= 2 && f.ways.length > 0);
  const ports = besidePorts(besideData('rg1', claim, p.ir, [-60, 13, 11, 93]));
  assert.deepEqual(ports.map((q) => q.node).sort(), ['street_e_end', 'street_w_start']);
  const w = ports.find((q) => q.node === 'street_w_start');
  // a seam reaching the past-end cell of the west street end, short of the road and the lots
  assert.equal(seamProblem(claim, p.ir, [-60, 13, w.end[0], 93]), null);
  // over the road's end
  assert.match(seamProblem(claim, p.ir, [-60, 13, w.at[0], 93]) ?? '', /meets the standing region's/);
  // deeper than 16
  assert.match(seamProblem(claim, p.ir, [-60, 80, 111, 140]) ?? '', /columns deep/);
  assert.equal(seamProblem(claim, p.ir, [-60, 112, 111, 140]), null, 'no overlap at all');
  assert.equal(SEAM_MAX, 16);
});

test('beside §3: a district beside a standing village: the join routed from a district street end to the village\'s street end in the seam, the external edge, the IR\'s beside', async () => {
  const { world, p, claim } = await standing();
  const B = [-60, 13, 11, 93];
  const bd = besideData('rg1', claim, p.ir, B);
  const claimB = { minX: B[0], minZ: B[1], maxX: B[2], maxZ: B[3], minY: -64, maxY: 319 };
  const survey = columnsOf(world, B[0], B[1], B[2] - B[0] + 1, B[3] - B[1] + 1);
  const q = await planRegion({ programFile: path.join(KIT, 'regions', 'districts.mjs'), params: { spec: { districts: [{ id: 'east', size: [48, 48], lots: 4 }] } }, survey, claim: claimB, seed: '1', beside: bd });
  const d = q.meta.districts;
  assert.equal(d.join.region, 'rg1');
  assert.equal(d.join.node, 'street_w_start');
  assert.deepEqual(d.edges.map((e) => [e.id, e.kind, e.ok]), [['join', 'join', true]]);
  const ext = q.ir.graph.edges.filter((e) => e.external);
  assert.deepEqual(ext.map((e) => e.to), ['rg1:street_w_start.street']);
  assert.equal(components(q.ir.graph).length, 1);
  assert.equal(q.ir.beside.id, 'rg1');
  // the join is this region's (S-D-2): its path is in this IR and inside this claim
  const jp = q.ir.paths.filter((x) => x.id.startsWith('route_join'));
  const jr = q.ir.roads.filter((x) => x.id.startsWith('route_join'));
  assert.ok(jp.length + jr.length > 0);
  // the join's last cell is the cell past the village's street end
  const meta = q.meta.route.edges.find((e) => e.id === 'join');
  const last = meta.path[meta.path.length - 1];
  assert.deepEqual([last[0], last[2]], [12 - 1, 53]);
  // no lot of the new region meets the standing region's footprint
  for (const l of q.ir.lots) for (const r of [...bd.lots, ...bd.keep]) assert.ok(!(l.box.minX <= r[2] && l.box.maxX >= r[0] && l.box.minZ <= r[3] && l.box.maxZ >= r[1]), l.id);
  // a plan that does not read beside records none (old IRs unchanged); no street end inside the claim: NO_JOIN
  const far = [-200, 13, -120, 93];
  await assert.rejects(planRegion({ programFile: path.join(KIT, 'regions', 'districts.mjs'), params: { spec: { districts: [{ id: 'east', size: [48, 48], lots: 4 }] } }, survey: columnsOf(world, far[0], far[1], 81, 81), claim: { minX: far[0], minZ: far[1], maxX: far[2], maxZ: far[3], minY: -64, maxY: 319 }, seed: '1', beside: besideData('rg1', claim, p.ir, far) }), /NO_JOIN/);
});
