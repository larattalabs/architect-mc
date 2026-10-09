// Phase 6a gate item 1, determinism (D9): mega_bench's IR sha and every tile's sha (all stages and sets) over a
// deterministic synthetic heightfield (the kit's own noise, no world needed) match the committed golden file, for 1
// worker in forward order and 4 workers in shuffled order. CI runs this on Linux (Node 22), the Mac on Node 24.
// The IR's `node` field is pinned to "golden" here (it records the Node major, which differs between the two).
// Regenerate (only when the engine or mega_bench changes on purpose): UPDATE_GOLDEN=1 node --test kit/test/region-golden.test.mjs
// (6b) The IR records `kitVersion`; the golden was planned by kit 0.11.0, so the test pins it (as it pins `node`): the file is
// 6a's, unchanged, and proves that a format-1 IR evaluates byte-identically under the 6b evaluator (CONTRACT 6b B1).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { synthSurvey } from '../lib/region/synth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, '..');
const GOLDEN = path.join(HERE, 'fixtures', 'regions', 'mega_bench.golden.json');
const WORKER = new URL('./fixtures/regions/eval-worker.mjs', import.meta.url);
const SEED = 'golden';
const CLAIM = { minX: -500, minZ: -500, maxX: 499, maxZ: 499, minY: -64, maxY: 319 };

function evalIn(irJson, jobs) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { irJson, seed: SEED, jobs } });
    w.once('message', (m) => { resolve(m); void w.terminate(); });
    w.once('error', reject);
  });
}

function shuffled(arr, seed) {
  const a = [...arr];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test('mega_bench golden: IR sha and every tile sha, 1 worker forward and 4 workers shuffled', async () => {
  const p = await planRegion({ programFile: path.join(KIT, 'regions', 'mega_bench.mjs'), survey: synthSurvey(CLAIM, SEED), claim: CLAIM, node: 'golden', kitVersion: '0.11.0' });
  const jobs = [];
  for (const stage of p.ir.stages) for (const set of ['terrain', 'path']) for (const key of p.ir.tiles[stage][set]) jobs.push({ key, stage, set });
  const id = (j) => `${j.stage}|${j.set}|${j.key}`;
  const one = await evalIn(p.irJson, jobs);
  const order = shuffled(jobs, 1234);
  const parts = [0, 1, 2, 3].map((k) => order.filter((_, i) => i % 4 === k));
  const four = (await Promise.all(parts.map((js) => evalIn(p.irJson, js)))).flat();
  const map1 = Object.fromEntries(one.map((r) => [id(r), r.sha]));
  const map4 = Object.fromEntries(four.map((r) => [id(r), r.sha]));
  assert.deepEqual(map4, map1, '4 workers in shuffled order = 1 worker in order');
  const cells = one.reduce((n, r) => n + r.count, 0);
  const tiles = Object.fromEntries(Object.keys(map1).sort().map((k) => [k, map1[k]]));
  const now = { irSha: p.irSha, budget: p.ir.budget, cells, tiles };
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.writeFileSync(GOLDEN, `${JSON.stringify({ note: 'mega_bench over synthSurvey(claim, "golden"), node pinned to "golden"; tiles: stage|set|key -> sha256 of the ARTL payload', claim: CLAIM, ...now }, null, 1)}\n`);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.equal(p.irSha, golden.irSha, 'IR sha');
  assert.deepEqual(p.ir.budget, golden.budget, 'budget');
  assert.equal(cells, golden.cells, 'cells over the full-resolution heights');
  assert.deepEqual(tiles, golden.tiles, 'tile shas');
});
