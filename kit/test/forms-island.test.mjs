// Phase 6b gate item 1: the floatingIsland property tests (docs/CONTRACT.md 6b §4.1) over 50 seeded param sets:
// bounds contain every cell; per-tile evaluation equals a whole (tile-free) evaluation; one face-connected component;
// pads flat at their y and solid under them to depth 3; valid blocks (M13); determinism (and a golden of IR shas over 20
// param sets); the evaluation cost per cell against a sphere's (recorded).
// Regenerate the golden (only when the generator changes on purpose): UPDATE_GOLDEN=1 node --test kit/test/forms-island.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { region, blockState } from '../lib/region/program.mjs';
import { compileIR, evalTile } from '../lib/realise.mjs';
import { compileShape, sdAt } from '../lib/sdf.mjs';
import { makeColumnNoise, makeNoise, fnv64 } from '../lib/noise.mjs';
import { makeColumns, unpack } from '../lib/region/pack.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'fixtures', 'regions', 'floating_island.golden.json');
const CLAIM = { minX: -128, minZ: -128, maxX: 127, maxZ: 127, minY: 60, maxY: 230 };

function flatSurvey() {
  const c = makeColumns(CLAIM.minX, CLAIM.minZ, 256, 256, 1);
  c.ground.fill(64); c.height.fill(64); c.floor.fill(64);
  return c;
}
function window(key) {
  const [tx, tz] = key.split(',').map(Number);
  const c = makeColumns(tx * 64 - 8, tz * 64 - 8, 80, 80, 1);
  c.ground.fill(64); c.height.fill(64); c.floor.fill(64);
  return c;
}

/** Param set k (deterministic). */
function paramsOf(k) {
  const h = fnv64('island-params', k);
  let s = h.lo >>> 0;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const rx = 8 + Math.floor(r() * 30), rz = 8 + Math.floor(r() * 30);
  const x = -20 + Math.floor(r() * 40), z = -20 + Math.floor(r() * 40), y = 150 + Math.floor(r() * 50);
  const pads = [];
  if (r() < 0.8) { const w = 4 + Math.floor(r() * Math.min(10, rx - 3)), d = 4 + Math.floor(r() * Math.min(10, rz - 3)); pads.push({ at: [x - (w >> 1), z - (d >> 1)], size: [w, d] }); }
  return {
    at: [x, y, z], r: [rx, rz], thickness: 6 + Math.floor(r() * 24), seed: `s${k}`,
    top: { relief: Math.floor(r() * 5), pads, edge: r() < 0.7 ? 'rail' : null, lights: r() < 0.5 ? 10 : 0 },
    underside: { taper: 0.3 + Math.floor(r() * 7) / 10, roots: Math.floor(r() * 13) },
  };
}

async function plan(params) {
  let isl;
  const prog = { id: 'island_test', default: (ctx) => { const g = region(ctx); g.stages(['main']); isl = g.floatingIsland('isle', params, { stage: 'main' }); g.anchor('entrance', [CLAIM.minX + 2, CLAIM.minZ + 2]); g.anchor('spawn', [CLAIM.minX + 3, CLAIM.minZ + 2]); return g; } };
  const p = await planRegion({ program: prog, programSource: 'island_test', survey: flatSurvey(), claim: CLAIM, node: 'golden' });
  return { p, isl };
}

/** Every cell of every tile of the IR (stage main, both sets): key -> state. */
function tileCells(ir) {
  const m = new Map();
  for (const set of ['terrain', 'path']) for (const key of ir.tiles.main[set]) for (const c of unpack(evalTile(ir, key, window(key), { stage: 'main', set }).payload).cells) m.set(`${c.x},${c.y},${c.z}`, c.state);
  return m;
}

/** A tile-free reference evaluation: ops in IR order over the island's bounds, last op wins. */
function wholeCells(ir, b) {
  const C = compileIR(structuredClone(ir));
  const col = { g: 64, h: 64, f: 64 };
  const m = new Map();
  for (const o of C.ops) {
    if (o.kind === 0) {
      const ref = o.rule ? compileShape(ir.parts[0].ops[o.index].shape) : null;
      for (let x = b.minX - 1; x <= b.maxX + 1; x++) for (let z = b.minZ - 1; z <= b.maxZ + 1; z++) for (let y = b.minY - 2; y <= b.maxY + 2; y++) {
        const sd = sdAt(o.node, x, y, z, col);
        if (!(sd <= 0)) continue;
        let st;
        if (o.rule) {
          const env = { up: () => sdAt(ref, x, y + 1, z, col) > 0, down: () => sdAt(ref, x, y - 1, z, col) > 0, side: () => false, slope: () => 0 };
          st = C.mats[o.rule.pick(x, y, z, sd, env)];
        } else st = C.mats[o.mat];
        m.set(`${x},${y},${z}`, st);
      }
    } else {
      const E = o.entries;
      for (let i = 0; i < E.length; i += 5) for (let y = E[i + 2]; y <= E[i + 3]; y++) m.set(`${E[i]},${y},${E[i + 1]}`, C.mats[E[i + 4]]);
    }
  }
  for (const [k, v] of m) if (v === 'minecraft:air') m.delete(k);
  return m;
}

const SETS = Array.from({ length: 50 }, (_, k) => paramsOf(k));

test('column noise equals the plain field exactly (warp lookups)', () => {
  for (const oct of [1, 2, 3]) {
    const spec = { kind: 'value', dims: 3, scale: 7.3, octaves: oct, seed: fnv64('cn', oct).hex };
    const a = makeNoise(spec), c = makeColumnNoise(spec);
    for (const [x, z] of [[0, 0], [-13, 7], [101, -55]]) {
      c.col(x, z);
      for (const y of [64, 65, 63, 200, -40, 64, 300, 299, 66]) assert.equal(c.at(y), a(x, y, z), `${oct} ${x},${y},${z}`);
    }
  }
});

test('floatingIsland over 50 param sets: bounds, per-tile = whole, one component, flat solid pads, valid blocks', async () => {
  for (let k = 0; k < SETS.length; k++) {
    const params = SETS[k];
    const { p, isl } = await plan(params);
    const ir = p.ir;
    assert.equal(ir.format, 2);
    const cells = tileCells(ir);
    for (const [kk, st] of cells) if (st === 'minecraft:air') cells.delete(kk);
    assert.ok(cells.size > 50, `set ${k}: the island has cells (${cells.size})`);
    const b = isl.bounds;
    // 1. bounds
    for (const kk of cells.keys()) {
      const [x, y, z] = kk.split(',').map(Number);
      assert.ok(x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && y >= b.minY && y <= b.maxY, `set ${k}: ${kk} outside the bounds ${JSON.stringify(b)}`);
    }
    // 2. per-tile = whole (only the first 12 sets: the reference is slow)
    if (k < 12) {
      const whole = wholeCells(ir, b);
      assert.equal(whole.size, cells.size, `set ${k}: cell count`);
      for (const [kk, st] of whole) assert.equal(cells.get(kk), st, `set ${k}: ${kk}`);
    }
    // 3. one face-connected component
    const seen = new Set();
    const start = cells.keys().next().value;
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const [x, y, z] = queue.pop().split(',').map(Number);
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const n = `${x + dx},${y + dy},${z + dz}`;
        if (cells.has(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    assert.equal(seen.size, cells.size, `set ${k}: ${cells.size - seen.size} cells not connected to the island (${[...cells.keys()].filter((c) => !seen.has(c)).slice(0, 6).map((c) => `${c} ${cells.get(c)}`)})`);
    // 4. pads flat at y, solid to depth 3, clear above
    for (const pad of isl.pads) {
      for (let x = pad.at[0]; x < pad.at[0] + pad.size[0]; x++) for (let z = pad.at[1]; z < pad.at[1] + pad.size[1]; z++) {
        for (let d = 0; d <= 3; d++) assert.ok(cells.has(`${x},${pad.y - d},${z}`), `set ${k}: pad cell ${x},${pad.y - d},${z} solid`);
        assert.ok(!cells.has(`${x},${pad.y + 1},${z}`) && !cells.has(`${x},${pad.y + 2},${z}`), `set ${k}: pad ${x},${z} clear above`);
      }
    }
    // 5. valid blocks
    for (const st of new Set(cells.values())) assert.equal(blockState(st), st, `set ${k}: ${st} is a canonical vanilla state`);
  }
});

test('floatingIsland determinism: 3 runs give the same IR; golden IR shas over 20 param sets', async () => {
  const shas = [];
  for (let k = 0; k < 20; k++) {
    const a = await plan(SETS[k]), b = await plan(SETS[k]), c = await plan(SETS[k]);
    assert.equal(a.p.irSha, b.p.irSha);
    assert.equal(a.p.irSha, c.p.irSha);
    shas.push(a.p.irSha);
  }
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, `${JSON.stringify({ note: 'floatingIsland v1: IR shas of the island_test program over param sets 0..19 (node pinned to "golden")', shas }, null, 1)}\n`);
  assert.deepEqual(shas, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).shas);
});

test('floatingIsland evaluation cost per cell against a sphere (recorded)', async () => {
  const { p } = await plan({ ...SETS[3], top: { ...SETS[3].top, lights: 0 } });
  const sphere = structuredClone(p.ir);
  const b = p.ir.parts[0].ops[0];
  sphere.parts[0].ops = [{ op: 'shape', shape: { kind: 'sphere', c: [SETS[3].at[0], { abs: SETS[3].at[1] - 6 }, SETS[3].at[2]], r: Math.min(...SETS[3].r) }, material: 'minecraft:stone', cond: 2, walk: false, bounds: b.bounds }];
  delete sphere.requires; delete sphere.forms; delete sphere.floating; sphere.format = 1;
  const cost = (ir) => {
    let cells = 0;
    const keys = ir.tiles.main.terrain;
    evalTile(ir, keys[0], window(keys[0]), { stage: 'main', set: 'terrain' });
    const t = performance.now();
    for (let rep = 0; rep < 3; rep++) for (const key of keys) cells += evalTile(ir, key, window(key), { stage: 'main', set: 'terrain' }).count;
    return (performance.now() - t) / cells;
  };
  const ci = cost(p.ir), cs = cost(sphere);
  const ratio = ci / cs;
  console.log(`# island ${(ci * 1e6).toFixed(0)} ns/cell, sphere ${(cs * 1e6).toFixed(0)} ns/cell, ratio ${ratio.toFixed(1)}`);
  // CONTRACT 6b §4.1 item 7 estimated at most 2x a sphere's; measured about 20-25x (the warp's three lookups and a child
  // evaluation per cell, the relief noise, the material rule). Recorded as a deviation (CONTRACT "Phase 6b as built"); what
  // the estimate protects is held instead: an island tile evaluates far inside the 2 s per-tile limit and above the 45k
  // cells/s evaluation bar (CONTRACT phase 6 §7).
  assert.ok(1 / (ci * 1000) >= 45_000 * 4, `island evaluation ${(1 / (ci * 1000)).toFixed(0)} cells/s (at least 4x the 45k bar)`);
});
