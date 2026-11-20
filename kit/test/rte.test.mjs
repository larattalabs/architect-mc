// (RTE) Route pieces name their edge: the districts pass's route pieces (roads and paths) carry ext `architect_mc:route: {edge}`, the
// graph edge the route pass built them for, so readers never parse ownership out of ids (route_d_a__b_1_1 is b's piece 1 group 1 or
// b_1's piece 1). districtLand's route parts follow the recorded edge, and an untagged IR's ids parse a long road's groups as their edge's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { districtLand } from '../lib/region/land.mjs';
import { read, run } from './plan-p0-shared.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(KIT, '..');
const S3 = { minX: 3604, minZ: -1036, maxX: 3795, maxZ: -845, minY: 22, maxY: 220 };
const ROUTE = 'architect_mc:route';

/** Every route piece the route pass recorded for a districts-pass edge carries that edge; nothing else is tagged by it. */
function assertTagged(ir, meta, what) {
  const byId = new Map([...(ir.roads ?? []), ...(ir.paths ?? [])].map((x) => [x.id, x]));
  const want = new Map();
  for (const e of meta.route?.edges ?? []) for (const id of [...(e.roads ?? []), ...(e.paths ?? [])]) want.set(id, `route_${e.id}`);
  let n = 0;
  for (const [id, edge] of want) {
    if (!/^route_(d_|join)/.test(edge)) continue;
    const x = byId.get(id);
    assert.ok(x, `${what}: piece ${id} is in the IR`);
    assert.deepEqual(x.ext?.[ROUTE], { edge }, `${what}: ${id} names its edge ${edge}`);
    assert.ok((ir.graph?.edges ?? []).some((g) => g.id === edge), `${what}: ${edge} is a graph edge`);
    n++;
  }
  assert.ok(n > 0, `${what}: at least one district route piece`);
  for (const [id, x] of byId) if (x.ext?.[ROUTE]) assert.equal(x.ext[ROUTE].edge, want.get(id), `${what}: ${id} tagged only with its own edge`);
}

test('districts_demo on S3: each district route piece names the edge it was built for', async () => {
  const p = await planRegion({ programFile: path.join(KIT, 'regions', 'districts_demo.mjs'), survey: fs.readFileSync(path.join(ROOT, 'scenarios', 'goldens', 'route_demo', 'survey.bin')), claim: S3, seed: '1' });
  assertTagged(p.ir, p.meta, 'districts_demo');
});

test('a districts plan (v18): its route road pieces name their edge too; a connector\'s route stays untagged', async () => {
  const f = read('valid').find((x) => x.name.startsWith('v18'));
  const r = await run(f);
  assert.ok(r.res.ir.roads.some((x) => x.id.startsWith('route_d_') && x.ext?.[ROUTE]), 'a tagged route road');
  // (a plan's later route passes replace meta.route, so the oracle here is the graph: every district route piece names a graph edge its id
  // extends)
  const ir = r.res.ir, edges = new Set(ir.graph.edges.map((e) => e.id));
  for (const x of [...ir.roads, ...ir.paths].filter((q) => q.id.startsWith('route_d_'))) {
    const edge = x.ext?.[ROUTE]?.edge;
    assert.ok(edges.has(edge) && x.id.startsWith(`${edge}_`), `v18: ${x.id} names its edge (${edge})`);
  }
  for (const x of [...r.res.ir.roads, ...r.res.ir.paths]) if (x.id.startsWith('route_c')) assert.equal(x.ext?.[ROUTE], undefined, x.id);
});

test('route_demo (not a districts plan) is unchanged: no piece tagged', async () => {
  const claim = { minX: 3604, minZ: -1036, maxX: 3795, maxZ: -845, minY: 22, maxY: 220 };
  const p = await planRegion({ programFile: path.join(KIT, 'regions', 'route_demo.mjs'), survey: fs.readFileSync(path.join(ROOT, 'scenarios', 'goldens', 'route_demo', 'survey.bin')), claim, seed: '1' });
  for (const x of [...(p.ir.roads ?? []), ...(p.ir.paths ?? [])]) assert.equal(x.ext?.[ROUTE], undefined, x.id);
});

// a minimal districts IR: districts a, b and b_1, the routes route_d_a__b and route_d_a__b_1
const tag = (edge) => ({ ext: { [ROUTE]: { edge } } });
const road = (id, z, x0, x1, t) => ({ id, points: [[x0, 64, z], [x1, 64, z]], width: 1, ...(t ? tag(t) : {}) });
const landIr = (roads, paths = []) => ({ params: { spec: { districts: [{ id: 'a' }, { id: 'b' }, { id: 'b_1' }] } }, parts: [], lots: [], roads, paths,
  graph: { nodes: [], edges: [{ id: 'route_d_a__b', path: 'route_d_a__b' }, { id: 'route_d_a__b_1', path: 'route_d_a__b_1' }] } });
const routeParts = (land) => Object.fromEntries(land.parts.filter((p) => p.kind === 'route').map((p) => [p.id, p.cells]));

test('districtLand, untagged: a long road\'s groups (route_d_a__b_3_1) are their edge\'s route, not a route d_a__b_3', () => {
  const land = districtLand(landIr([road('route_d_a__b_1', 0, 0, 9), road('route_d_a__b_3_1', 0, 20, 29), road('route_d_a__b_3_2', 0, 30, 39)]));
  assert.deepEqual(routeParts(land), { d_a__b: 90 });
});

test('districtLand, tagged: b\'s grouped road route_d_a__b_1_1 stays b\'s, b_1\'s stair section stays b_1\'s', () => {
  const land = districtLand(landIr([road('route_d_a__b_1_1', 0, 0, 9, 'route_d_a__b'), road('route_d_a__b_1_2', 0, 10, 19, 'route_d_a__b')],
    [{ id: 'route_d_a__b_1_3', box: { minX: 0, minY: 64, minZ: 10, maxX: 0, maxY: 70, maxZ: 14 }, ...tag('route_d_a__b_1') }]));
  assert.deepEqual(routeParts(land), { d_a__b: 60, d_a__b_1: 5 });
});
