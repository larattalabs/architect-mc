// (RTE5) The second RTE readers' compatibility corpus (kit/tools/rte5-compat-fixture.mjs): the shapes RTE4's corpus lacked (plan_v0 street
// flags, bandless growth, ridge and biome-edge boundaries, seam, reach and gate joins beside a town, undo and gapped histories, histories
// across releases) and RTE4's own cases under releases v0.48.0..v0.84.0, each IR as its release wrote it. Every round reads in this tree
// exactly as v0.88.0 read it (route ends and free ends, growPlan, streetRuns, architect_mc:land by exact cell runs); and this tree writes
// what v0.89.0 wrote for every new case, but where RTE5 drops a district tag v0.89.0 wrote needlessly (plan_v0, a b_street district).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus, writtenSha } from '../tools/rte5-compat-fixture.mjs';
import { cases, effectiveOf, kitAt, readers, runCase } from '../tools/rte5-compat-worker.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const C = loadCorpus();

test('rte5-compat: the corpus holds the shapes it is for', () => {
  assert.deepEqual(C.versions, ['v0.48.0', 'v0.55.0', 'v0.65.0', 'v0.75.0', 'v0.84.0', 'v0.85.0', 'v0.86.0', 'v0.87.0', 'v0.88.0']);
  const n = (f) => C.cases.filter(f).length;
  assert.ok(C.cases.length >= 400, `cases: ${C.cases.length}`);
  assert.ok(n((c) => c.family === 'rte4' && ['v0.48.0', 'v0.55.0', 'v0.65.0', 'v0.75.0', 'v0.84.0'].includes(c.version)) >= 150, 'RTE4\'s cases before v0.85.0');
  // plan_v0's stamped streets: {zone, district} and a plain zone's {zone}
  const flags = new Set(C.cases.filter((c) => c.family === 'plan_v0').flatMap((c) => c.ir.roads.map((r) => r.ext?.['architect_mc:street']).filter(Boolean).map((f) => (f.district ? 'district' : 'zone'))));
  assert.deepEqual([...flags].sort(), ['district', 'zone']);
  // bandless growth (a street extension: flagged, no band) and a boundary growth on a ridge
  const grownRoads = C.cases.flatMap((c) => c.revisions.flatMap((r) => r.ir.roads ?? []));
  assert.ok(grownRoads.some((r) => r.ext?.['architect_mc:street'] && !r.ext?.['architect_mc:band']), 'bandless growth');
  assert.ok(C.cases.some((c) => c.recipe === 'ridge' && c.revisions.some((r) => r.ir.roads?.some((x) => x.ext?.['architect_mc:band']))), 'a ridge band grown');
  assert.ok(n((c) => c.recipe === 'biome') > 0, 'a biome edge');
  // joins: a seam join, a reach join, a gate join
  assert.ok(C.cases.some((c) => c.join === 'seam' && !c.ir.reach), 'seam');
  assert.ok(C.cases.some((c) => c.join === 'reach' && c.ir.reach && !c.ir.reach.gate), 'reach');
  assert.ok(C.cases.some((c) => c.join === 'gate' && c.ir.reach?.gate), 'gate');
  // histories: an undo (revised, fewer revisions), a gap (a rid past its position), one that spans releases (two or more `by`)
  assert.ok(C.cases.some((c) => c.rounds.some((r) => r.revised && r.revs.length === 0)), 'undone to the plan');
  assert.ok(C.cases.some((c) => c.revisions.some((r) => r.rid > r.position && c.rounds.some((x) => x.revs.includes(r.rid) && x.revs.length > 1))), 'gapped');
  assert.ok(C.cases.some((c) => c.chain && new Set(c.revisions.map((r) => r.by)).size >= 3), 'across releases');
  assert.ok(C.cases.some((c) => c.chain?.[0] === 'v0.88.0' && c.revisions.some((r) => r.by === 'v0.85.0')), 'a later release continued by an earlier one');
  // exact runs
  assert.ok(C.cases.every((c) => c.expected.every((e) => !e.land || (typeof e.land.union[1] === 'string' && e.land.parts.every((p) => typeof p[6] === 'string')))));
});

test('rte5-compat: every round of every corpus case (v0.48.0..v0.88.0) reads in this tree exactly as v0.88.0 read it, land by exact runs', async () => {
  const K = await kitAt(ROOT);
  const bad = [];
  let n = 0;
  for (const c of C.cases) {
    assert.equal(c.rounds.length, c.expected.length, c.key);
    c.rounds.forEach((rd, k) => {
      n++;
      const got = readers(K, effectiveOf(K, c, k), c, rd.revised), want = c.expected[k];
      for (const key of Object.keys(want)) if (JSON.stringify(got[key]) !== JSON.stringify(want[key])) bad.push(`${c.key} round ${k} ${key}: got ${JSON.stringify(got[key]).slice(0, 300)}, v0.88.0 ${JSON.stringify(want[key]).slice(0, 300)}`);
    });
  }
  assert.ok(n >= 1200, `effective IRs: ${n}`);
  assert.deepEqual(bad, []);
});

test('rte5-compat: v0.89.0 read every round as v0.88.0 did (RTE4\'s claim, over the new shapes)', () => {
  assert.deepEqual(C.cases.filter((c) => c.v089).map((c) => c.key), []);
});

// ---- the emission check: what this tree writes for each new case, against what v0.89.0 wrote (digests without each IR's `kitVersion`
// and `node`, writtenSha: a release's bump and CI's Node major are not emission changes)

/** The cases RTE5 changes on purpose: plan_v0 zones whose districts' roads v0.89.0 tagged though streetRuns reads them right by the stamp. */
const ITEM1 = ['pv0_b-b_street', 'pv0_b_street', 'pv0_b_street-c', 'pv0_two_zones'];

test('rte5-compat: this tree writes v0.89.0\'s IRs and revisions for every new case, but RTE5\'s plan_v0 cases, which lose only the district tag', async () => {
  const K = await kitAt(ROOT);
  const same = [], item1 = [], other = [];
  for (const c0 of cases()) {
    const w = C.written[c0.id];
    let c;
    try { c = await runCase(K, structuredClone(c0), 'HEAD'); } catch (e) { c = { error: String(e.message).split('\n')[0].slice(0, 160) }; }
    if (w.error || c.error) { (w.error && c.error ? same : other).push(`${c0.id}: ${w.error ?? '-'} / ${c.error ?? '-'}`); continue; }
    assert.deepEqual(c.log.map((l) => l.slice(0, -1).filter((x) => x !== 'HEAD')), w.log, `${c0.id}: the same outcomes`);
    const sha = writtenSha(c.ir, c.revisions);
    if (sha === w.sha) same.push(c0.id);
    else if (sha === w.untagged && writtenSha(c.ir, c.revisions, true) === sha) item1.push(c0.id);
    else other.push(c0.id);
  }
  assert.deepEqual(other, []);
  assert.deepEqual(item1.sort(), [...ITEM1].sort());
  assert.ok(same.length >= 25, `${same.length}`);
});
