// (6c HY-a) The hydrology pass (docs/CONTRACT.md "Phase 6c slice HY" §5, §14 items 1 and 12 for the pass): hand cases on synthetic
// terrains (a bowl, a valley, a plateau with a pit, flats, a saddle, ties), every column draining to the claim's edge or surveyed
// water with no cycle, the fields' shas pinned (macOS and Linux CI), S3's survey as a natural site, data.courses, r.pass, plan_v0's
// conditional run and D1's `wet` tag.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { D8, HYDRO_DEFAULTS, channelPaths, chebyshev, flood, hydrologyPass, ilog2 } from '../lib/region/passes/hydrology.mjs';
import { PASSES, PASS_NAMES } from '../lib/region/passes/index.mjs';
import { districtCandidates, WET_TAG } from '../lib/region/passes/districts.mjs';
import { FLAG_FROZEN, FLAG_WATER, decodeColumns, makeColumns, unpack } from '../lib/region/pack.mjs';
import { synthSurvey } from '../lib/region/synth.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { scatter } from '../lib/region/scatterPlan.mjs';
import { evalTile } from '../lib/realise.mjs';
import { isCoursePart } from '../lib/plan/compile.mjs';
import { codeOnly } from './region-lint.test.mjs';
import { ROOT, KIT, checkPlanLocal, flatSurvey, stewardAnchors } from './plan-helpers.mjs';

const sha = (u8) => createHash('sha256').update(u8).digest('hex');

/** A columns object W x D at resolution 1 from `g(i, j) -> ground` and `wet(i, j) -> bool` (a water column, surface = ground). */
function grid(W, D, g, { water = () => false, minX = 0, minZ = 0 } = {}) {
  const c = makeColumns(minX, minZ, W, D, 1);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    const k = i + j * W, y = g(i, j);
    c.ground[k] = y; c.height[k] = y; c.floor[k] = y;
    if (water(i, j)) { c.flags[k] = FLAG_WATER; c.floor[k] = y - 3; }
  }
  return c;
}

/**
 * Follow every column's outflow to a sink (a seed: the edge or water). Returns {cycles, maxSteps, sinks: Set of sink indices,
 * uphill (an outflow to a higher filled column)}. A column that takes more than n steps is a cycle.
 */
function drainage(c, f) {
  const W = c.width, D = c.depth, n = W * D;
  let cycles = 0, maxSteps = 0, uphill = 0;
  const sinks = new Set(), sinkOf = new Int32Array(n).fill(-1);
  for (let s = 0; s < n; s++) {
    let k = s, steps = 0;
    while (f.down[k] >= 0 && steps <= n) {
      const t = f.down[k];
      if (f.filled[t] > f.filled[k]) uphill++;
      const dx = Math.abs((t % W) - (k % W)), dz = Math.abs(Math.floor(t / W) - Math.floor(k / W));
      assert.ok(dx <= 1 && dz <= 1 && dx + dz > 0, 'an outflow is one of the 8 neighbours');
      k = t; steps++;
    }
    if (steps > n) { cycles++; continue; }
    const x = k % W, z = (k - x) / W;
    assert.ok(x === 0 || z === 0 || x === W - 1 || z === D - 1 || (c.flags[k] & FLAG_WATER), `column ${s} drains to ${k}, which is neither the edge nor water`);
    sinks.add(k); sinkOf[s] = k;
    if (steps > maxSteps) maxSteps = steps;
  }
  return { cycles, maxSteps, sinks, sinkOf, uphill };
}

const seedsOf = (c) => { const s = new Uint8Array(c.width * c.depth); for (let k = 0; k < s.length; k++) if (c.flags[k] & FLAG_WATER) s[k] = 1; return s; };
const run = (c, unit = 1) => flood({ ground: c.ground, seed: seedsOf(c), W: c.width, D: c.depth, unit });

test('ilog2 is floor(log2) on integers (no Math.log2: the lint)', () => {
  assert.deepEqual([1, 2, 3, 4, 7, 8, 255, 256, 400, 65536, 111072].map(ilog2), [0, 1, 1, 2, 2, 3, 7, 8, 8, 16, 16]);
  assert.equal(ilog2(0), 0);
});

test('hydrology.mjs keeps to the realise lint (Math.floor/sqrt/abs/min/max/imul, no clock, no random, no **)', () => {
  const code = codeOnly(fs.readFileSync(path.join(KIT, 'lib', 'region', 'passes', 'hydrology.mjs'), 'utf8'));
  const bad = [...code.matchAll(/\bMath\s*\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]).filter((m) => !['floor', 'sqrt', 'abs', 'min', 'max', 'imul'].includes(m));
  assert.deepEqual(bad, []);
  assert.ok(!/\bDate\b|\bperformance\b|\*\*/.test(code));
});

test('registered: PASSES.hydrology, D8 in N, NE, E, SE, S, SW, W, NW order (north is -z), defaults', () => {
  assert.ok(PASS_NAMES.includes('hydrology'));
  assert.equal(PASSES.hydrology, hydrologyPass);
  assert.deepEqual(D8, [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]);
  assert.deepEqual({ ...HYDRO_DEFAULTS }, { wetFalloff: 12, minReach: 6 });
});

test('a bowl: the pit fills to its rim\'s lowest pass and drains over it; 0 cycles', () => {
  // 21 x 21: ground rises from 60 at the centre to 80 at the edge (Chebyshev), with a notch in the rim at (10, 0..4) down to 70
  const W = 21, c = grid(W, W, (i, j) => {
    const d = Math.max(Math.abs(i - 10), Math.abs(j - 10));
    if (i === 10 && j <= 4) return 70;
    return 60 + 2 * d;
  });
  const f = run(c);
  const dr = drainage(c, f);
  assert.equal(dr.cycles, 0);
  assert.equal(dr.uphill, 0, 'D8 never points uphill on the filled surface');
  // the centre fills to the notch (70): every column inside the ring at 70 is raised to 70
  assert.equal(f.filled[10 + 10 * W], 70);
  assert.ok(f.raised > 0);
  // the whole bowl inside the notch level leaves through the notch, at (10, 0)
  const centre = dr.sinkOf[10 + 10 * W];
  assert.equal(centre, 10 + 0 * W, 'the bowl drains out of its notch');
  // the notch's outlet column carries the bowl: at least the 9 x 9 at or under 70 (60 + 2 * 5 = 70 is d <= 5: 11 x 11 = 121)
  assert.ok(f.acc[10] >= 121, `the outlet's accumulation ${f.acc[10]}`);
});

test('a valley: the floor gathers the flow, a channel runs down it to the edge, flow rises downstream', () => {
  // 40 x 24: the floor runs along z = 12 falling to the east (x), the sides rising 1 a column away from it
  const W = 40, D = 24, c = grid(W, D, (i, j) => 100 - Math.floor(i / 2) + Math.abs(j - 12));
  const out = hydrologyPass(c, [], { channelAt: 40, minReach: 6 });
  const f = run(c);
  assert.equal(drainage(c, f).cycles, 0);
  const flow = out.fields.flow.values;
  // along the floor, flow never falls going east; the floor carries more than the sides
  for (let i = 2; i < W - 1; i++) assert.ok(flow[i + 12 * W] >= flow[i - 1 + 12 * W], `flow at the floor x=${i}`);
  assert.ok(flow[(W - 2) + 12 * W] > flow[(W - 2) + 4 * W]);
  // data.courses: the longest path is the floor, ending at the east edge
  const p0 = out.data.courses[0];
  assert.ok(p0, 'a channel path');
  const last = p0.cells[p0.cells.length - 1];
  assert.equal(last[0], W - 1, 'the main channel reaches the east edge');
  assert.ok(p0.cells.filter((q) => q[1] === 12).length >= p0.cells.length - 2, 'the main channel keeps to the floor');
  for (let t = 1; t < p0.cells.length; t++) {
    assert.ok(Math.max(Math.abs(p0.cells[t][0] - p0.cells[t - 1][0]), Math.abs(p0.cells[t][1] - p0.cells[t - 1][1])) === 1, 'consecutive cells are D8 neighbours');
    assert.ok(p0.accumulation[t] > p0.accumulation[t - 1], 'accumulation grows downstream');
  }
  assert.ok(p0.accumulation.every((a) => a >= 40));
});

test('a plateau with a pit, and flats: the pit fills, flats drain to the edge by their flood links, deterministically', () => {
  const W = 30, D = 30;
  const c = grid(W, D, (i, j) => (i >= 12 && i <= 15 && j >= 12 && j <= 15 ? 70 : 80));
  const f = run(c);
  const dr = drainage(c, f);
  assert.equal(dr.cycles, 0);
  assert.equal(dr.uphill, 0);
  // the pit fills to the plateau: all 16 raised, and the whole interior is one flat
  assert.equal(f.raised, 16);
  for (let k = 0; k < W * D; k++) assert.equal(f.filled[k], 80);
  // every interior column of a flat drains by its flood link (no strictly lower neighbour)
  assert.equal(f.flatLinks, (W - 2) * (D - 2));
  // flats: an entirely level claim drains to the edge, every column, the same twice
  const flat = grid(W, D, () => 64);
  const a = run(flat), b = run(flat);
  assert.equal(drainage(flat, a).cycles, 0);
  assert.deepEqual([...a.down], [...b.down]);
  // total accumulation reaching the edge equals the columns
  let total = 0;
  for (let k = 0; k < W * D; k++) if (a.down[k] < 0) total += a.acc[k];
  assert.equal(total, W * D);
});

test('a saddle, and ties by direction index', () => {
  // the saddle: two basins (west, east) joined over a pass at x = 5; the north and south edges high, the east edge the only low
  // outlet. The west basin fills to the pass and spills east over it.
  const W = 11, D = 7;
  const c = grid(W, D, (i, j) => {
    if (j === 0 || j === D - 1 || i === 0) return 90;
    if (i === W - 1) return j === 3 ? 50 : 90;
    if (i === 5) return j === 3 ? 66 : 80;
    return 60 + (i > 5 ? -4 : 0);
  });
  const f = run(c);
  const dr = drainage(c, f);
  assert.equal(dr.cycles, 0);
  assert.equal(dr.sinkOf[2 + 3 * W], (W - 1) + 3 * W, 'the west basin spills over the pass to the east outlet');
  assert.equal(f.filled[2 + 3 * W], 66, 'the west basin fills to the pass');
  // ties (on the filled surface: each low run reaches the edge, so nothing fills): the centre (2, 2) with equal lowest neighbours
  // N (60) and E (60) goes N (index 0); with E and W equal, E (index 2) before W (index 6)
  const lowAt = (cells) => (i, j) => (cells.some(([x, z, y]) => x === i && z === j) ? cells.find(([x, z]) => x === i && z === j)[2] : 70);
  const t1 = grid(5, 5, lowAt([[2, 0, 60], [2, 1, 60], [3, 2, 60], [4, 2, 60]]));
  assert.equal(run(t1).down[2 + 2 * 5], 2 + 1 * 5);
  const t2 = grid(5, 5, lowAt([[3, 2, 60], [4, 2, 60], [1, 2, 60], [0, 2, 60]]));
  assert.equal(run(t2).down[2 + 2 * 5], 3 + 2 * 5);
  // the lowest wins over the direction order: SW 55 beats N 60
  const t3 = grid(5, 5, lowAt([[2, 0, 60], [2, 1, 60], [1, 3, 55], [0, 3, 55]]));
  assert.equal(run(t3).down[2 + 2 * 5], 1 + 3 * 5);
});

test('water is a sink, FROZEN counts as water, and wet falls off with the distance to water (plan water too)', () => {
  const W = 40, D = 40;
  const c = grid(W, D, (i, j) => 70 + Math.floor(Math.max(Math.abs(i - 20), Math.abs(j - 20)) / 2), { water: (i, j) => Math.abs(i - 20) <= 2 && Math.abs(j - 20) <= 2 });
  // one lake column frozen (FLAG_FROZEN carries FLAG_WATER: still water)
  c.flags[20 + 20 * W] |= FLAG_FROZEN;
  const f = run(c);
  const dr = drainage(c, f);
  assert.equal(dr.cycles, 0);
  // the slope toward the lake drains into it (a column 6 off its side)
  const s = dr.sinkOf[20 + 28 * W];
  assert.ok(c.flags[s] & FLAG_WATER, 'drains into the lake');
  const out = hydrologyPass(c, [], {});
  const wet = out.fields.wet.values;
  assert.equal(wet[23 + 20 * W] >= 20 * 11, true, 'one block off the water: at least 20 x (12 - 1)');
  assert.equal(wet[20 + 20 * W] >= 240, true);
  // the wet term: 20 * max(0, wetFalloff - d) plus 12 * floor(log2(acc)), exactly
  for (const k of [5 + 5 * W, 30 + 20 * W, 20 + 34 * W]) {
    const x = k % W, z = (k - x) / W;
    let d = 99;
    for (let j = 18; j <= 22; j++) for (let i = 18; i <= 22; i++) d = Math.min(d, Math.max(Math.abs(i - x), Math.abs(j - z)));
    assert.equal(wet[k], Math.min(255, 12 * ilog2(f.acc[k]) + 20 * Math.max(0, 12 - d)), `wet at ${x},${z}`);
  }
  // the plan's own water (intent.water) counts for wet, not as a sink
  const dry = grid(W, D, () => 64);
  const a = hydrologyPass(dry, [], {}), b = hydrologyPass(dry, [], { water: [[10, 10]] });
  assert.equal(b.data.planWater, 1);
  assert.ok(b.fields.wet.values[11 + 10 * W] > a.fields.wet.values[11 + 10 * W]);
  assert.deepEqual([...a.fields.flow.values], [...b.fields.flow.values]);
  // wetFalloff 0: wet is the accumulation term alone
  const z0 = hydrologyPass(c, [], { wetFalloff: 0 });
  for (let k = 0; k < W * D; k++) assert.equal(z0.fields.wet.values[k], Math.min(255, 12 * ilog2(f.acc[k])));
});

test('chebyshev: 8-neighbour BFS distance, R + 1 past R', () => {
  const src = new Uint8Array(25); src[12] = 1;
  const d = chebyshev(src, 5, 5, 1);
  assert.equal(d[12], 0); assert.equal(d[6], 1); assert.equal(d[0], 2); assert.equal(d[24], 2);
  assert.ok(chebyshev(new Uint8Array(4), 2, 2, 3).every((v) => v === 4));
});

test('the intent is checked; ops are empty; the fields cover the survey grid as u8', () => {
  const c = grid(8, 8, () => 64);
  for (const bad of [{ wetFalloff: -1 }, { wetFalloff: 65 }, { wetFalloff: 1.5 }, { channelAt: 0 }, { channelAt: 2.5 }, { minReach: 0 }, { water: 'x' }, { water: [[1.5, 2]] }]) assert.throws(() => hydrologyPass(c, [], bad), /hydrology/);
  const out = hydrologyPass(c, [], {});
  assert.deepEqual(out.ops, []);
  assert.equal(out.data.courses, undefined, 'data.courses only with channelAt');
  for (const k of ['flow', 'wet']) assert.deepEqual({ ...out.fields[k], values: null }, { type: 'u8', minX: 0, minZ: 0, width: 8, depth: 8, res: 1, values: null });
});

test('channelPaths: tributaries stop at their junction, short ones merge, heads longest first (ties by x, then z)', () => {
  // a comb: a trunk along z = 0 flowing west to (0, 0); teeth along x = 2, 5 and 8 flowing north into it from z = 1..L
  // (lengths 6, 2 and 6: the middle one merges at minReach 3)
  const W = 10, D = 8, n = W * D;
  const down = new Int32Array(n).fill(-1), acc = new Float64Array(n).fill(1);
  const teeth = { 2: 6, 5: 2, 8: 6 };
  for (let i = 1; i < W; i++) down[i] = i - 1; // the trunk
  for (const [x, L] of Object.entries(teeth)) for (let z = 1; z <= L; z++) down[Number(x) + z * W] = Number(x) + (z - 1) * W;
  // accumulation by hand: in reverse topological order (z descending, then the trunk east to west)
  for (let z = D - 1; z >= 1; z--) for (let x = 0; x < W; x++) if (down[x + z * W] >= 0) acc[down[x + z * W]] += acc[x + z * W];
  for (let x = W - 1; x >= 1; x--) acc[x - 1] += acc[x];
  // every column in the network is channel (channelAt 1); the isolated columns are sinks with acc 1: heads too, but 1 cell (merged)
  const paths = channelPaths({ down, acc, W, D, minX: 100, minZ: 200, res: 1, channelAt: 1, minCells: 3 });
  // heads by length to the sink: tooth 8 (15), the trunk's own head (9, 0) (10), tooth 2 (9), tooth 5 (8), the isolated sinks (1).
  // Tooth 8 takes the trunk; (9, 0) has 1 own cell before the trunk (merged); tooth 2 stops at its junction (2, 0); tooth 5 has 2
  // own cells (merged); the isolated sinks have 1 (merged)
  assert.deepEqual(paths.map((p) => p.cells[0]), [[108, 206], [102, 206]]);
  assert.equal(paths[0].cells.length, 15);
  assert.deepEqual(paths[0].cells.at(-1), [100, 200]);
  assert.deepEqual(paths[1].cells.at(-1), [102, 200], 'a tributary ends at its junction (an earlier path\'s cell)');
  assert.equal(paths[1].cells.length, 7);
  assert.deepEqual(paths[1].accumulation, [1, 2, 3, 4, 5, 6, acc[2]]);
  // minReach 2: tooth 5 is listed too (after tooth 2: shorter), the trunk head still merged (1 own cell)
  const p2 = channelPaths({ down, acc, W, D, minX: 100, minZ: 200, res: 1, channelAt: 1, minCells: 2 });
  assert.deepEqual(p2.map((p) => p.cells[0]), [[108, 206], [102, 206], [105, 202]]);
  // channelAt over the teeth's heads: the heads move down to the first column at or over it
  const p3 = channelPaths({ down, acc, W, D, minX: 100, minZ: 200, res: 1, channelAt: 3, minCells: 1 });
  assert.deepEqual(p3[0].cells[0], [108, 204]);
  for (const p of paths) assert.equal(p.cells.length, p.accumulation.length);
});

test('S3\'s survey as a natural site: drains with no cycle, wet near water at least 3x far (recorded), shas pinned', () => {
  const c = decodeColumns(fs.readFileSync(path.join(ROOT, 'scenarios', 'goldens', 'route_demo', 'survey.bin')));
  const f = run(c, c.resolution * c.resolution);
  const dr = drainage(c, f);
  assert.equal(dr.cycles, 0);
  assert.equal(dr.uphill, 0);
  const out = hydrologyPass(c, [], { channelAt: 400 });
  const W = c.width, D = c.depth, wet = out.fields.wet.values;
  const water = new Uint8Array(W * D);
  for (let k = 0; k < W * D; k++) if (c.flags[k] & FLAG_WATER) water[k] = 1;
  const d = chebyshev(water, W, D, 64);
  let nearS = 0, nearN = 0, farS = 0, farN = 0;
  for (let k = 0; k < W * D; k++) { if (water[k]) continue; if (d[k] <= 4) { nearS += wet[k]; nearN++; } else if (d[k] > 16) { farS += wet[k]; farN++; } }
  const ratio = (nearS / nearN) / (farS / farN);
  console.log(`# S3 wet: mean within 4 of water ${(nearS / nearN).toFixed(1)} (${nearN}), over 16 away ${(farS / farN).toFixed(1)} (${farN}), ratio ${ratio.toFixed(2)}; ${out.data.courses.length} channel paths`);
  assert.ok(ratio >= 3, `wet within 4 of water is ${ratio.toFixed(2)}x its mean over 16 away`);
  // every channel path ends at the edge, water or an earlier path's cell
  const held = new Set();
  for (const p of out.data.courses) {
    const [x, z] = p.cells.at(-1), i = x - c.minX, j = z - c.minZ, k = i + j * W;
    assert.ok(i === 0 || j === 0 || i === W - 1 || j === D - 1 || (c.flags[k] & FLAG_WATER) || held.has(`${x},${z}`), `path ends at ${x},${z}`);
    for (const q of p.cells) held.add(`${q[0]},${q[1]}`);
  }
  assert.equal(sha(out.fields.flow.values), PINNED.s3.flow);
  assert.equal(sha(out.fields.wet.values), PINNED.s3.wet);
  assert.equal(sha(Buffer.from(JSON.stringify(out.data.courses))), PINNED.s3.courses);
});

/** The fields' shas (the u8 bytes as the blobs carry them) and data.courses' (channelAt 400), pinned so Linux CI checks them against macOS. */
const PINNED = {
  s3: { flow: '200581aa5a8645d27ef1b0ac4e25cb18f58c14c2f6da9a7e6ba33c315c1e7e98', wet: '0429b07a903955c8f0986a7d877835564d51d6bfde66521c1a604a655c383add', courses: '224bfff18d7495796fb2cd01905246f62594f1d1b61b78bdef4f51897d62d06b' },
  s1: { flow: '38cb1da745288ab7037f01b9911f8812b2984aec62f1399061f8eb76ba6f3243', wet: 'b3a4956c32e77a71911b894958ac2c1a14baabe9e2215441aa1fd661d892f5f5', courses: '7773000944b025d2a227e5788305ab40781eafe4fe98eb8f034d735631de77d0' },
  synth1024: { flow: '7761f6eeabe4c57838536e83e3522f1fc4c0d5eb9436473fa977892101058f19', wet: '4ecec80910b72bb96572c7a98cca802d223bac641b3afc0e1f2598b19c98d403', courses: 'd43b3e7cf67570eb507edd38f24d2036a2da661995b925112e76ae5a19f7b459' },
};

test('determinism: the 1024 x 1024 synthetic (resolution 4) and S1\'s survey, 3 runs identical, shas pinned', () => {
  const s1 = decodeColumns(fs.readFileSync(path.join(ROOT, 'scenarios', 'goldens', 's1', 'survey.bin')));
  const syn = synthSurvey({ minX: 0, minZ: 0, maxX: 1023, maxZ: 1023 });
  for (const [name, c] of [['s1', s1], ['synth1024', syn]]) {
    const runs = [0, 1, 2].map(() => hydrologyPass(c, [], { channelAt: 400 }));
    const shas = runs.map((o) => [sha(o.fields.flow.values), sha(o.fields.wet.values), sha(Buffer.from(JSON.stringify(o.data.courses)))]);
    assert.deepEqual(shas[1], shas[0]); assert.deepEqual(shas[2], shas[0]);
    assert.equal(shas[0][0], PINNED[name].flow, `${name} flow`);
    assert.equal(shas[0][1], PINNED[name].wet, `${name} wet`);
    assert.equal(shas[0][2], PINNED[name].courses, `${name} data.courses`);
    assert.equal(drainage(c, run(c, c.resolution * c.resolution)).cycles, 0);
  }
  // resolution 4: a survey column stands for 16 world columns
  const o = hydrologyPass(syn, [], {});
  assert.equal(o.data.resolution, 4);
  assert.equal(o.fields.flow.res, 4);
  assert.equal(o.data.maxAccumulation % 16, 0);
});

test('r.pass(\'hydrology\'): declared only; the fields as side blobs; the plan\'s bodies count as water; once a region', async () => {
  const claim = { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: -64, maxY: 319 };
  const c = grid(64, 64, (i) => 80 - Math.floor(i / 4));
  const prog = (passes, fn) => ({ id: 'hy_inline', passes, default: fn });
  const body = (ctx) => { const r = ctx.region(); r.stages(['main']); r.anchor('entrance', [32, 81, 32]); r.anchor('spawn', [33, 81, 32]); const h = r.pass('hydrology', { channelAt: 64 }); r.meta.hy = h; return r; };
  await assert.rejects(planRegion({ program: prog([], body), survey: c, claim, seed: '1' }), /PASS_UNDECLARED/);
  const res = await planRegion({ program: prog(['hydrology'], (ctx) => { const r = body(ctx); r.note(`courses ${r.meta.hy.data.courses.length}`); delete r.meta.hy; return r; }), survey: c, claim, seed: '1' });
  assert.ok(res.ir.blobs.field_flow && res.ir.blobs.field_wet, 'the fields are side blobs');
  assert.deepEqual(res.meta.passes.map((p) => p.name), ['hydrology']);
  assert.ok(res.notes.some((n) => /pass hydrology/.test(n)));
  await assert.rejects(planRegion({ program: prog(['hydrology'], (ctx) => { const r = body(ctx); r.pass('hydrology'); return r; }), survey: c, claim, seed: '1' }), /once/);
  // the plan's own water bodies written so far (r._fluidBodies, as r.fluidBody records them) count for wet; planWater: false skips them
  const withBody = (planWater) => prog(['hydrology'], (ctx) => {
    const r = ctx.region(); r.stages(['main']); r.anchor('entrance', [32, 81, 32]); r.anchor('spawn', [33, 81, 32]);
    r._fluidBodies = [{ fluid: 'water', cells: [[10, 70, 10], [11, 70, 10]] }, { fluid: 'lava', cells: [[40, 70, 40]] }];
    const h = r.pass('hydrology', { planWater });
    r.note(`planWater ${h.data.planWater}`);
    return r;
  });
  const on = await planRegion({ program: withBody(true), survey: c, claim, seed: '1' }), off = await planRegion({ program: withBody(false), survey: c, claim, seed: '1' });
  assert.ok(on.notes.includes('planWater 2'), 'two water columns; lava is not water');
  assert.ok(off.notes.includes('planWater 0'));
  assert.notEqual(on.ir.blobs.field_wet.sha, off.ir.blobs.field_wet.sha);
  assert.equal(on.ir.blobs.field_flow.sha, off.ir.blobs.field_flow.sha);
});

test('D1\'s wet tag: the wet field\'s max over the rect when given, else surveyed water as before', () => {
  const W = 64, D = 64;
  const c = grid(W, D, () => 64, { water: (i, j) => i >= 60 });
  const claim = { minX: 0, minZ: 0, maxX: W - 1, maxZ: D - 1 };
  const base = districtCandidates(c, claim, [8, 8], { step: 4, margin: 2 });
  const same = districtCandidates(c, claim, [8, 8], { step: 4, margin: 2, wet: null });
  assert.deepEqual(same, base, 'no field: identical');
  const wetOf = (v) => ({ type: 'u8', minX: 0, minZ: 0, width: W, depth: D, res: 1, values: new Uint8Array(W * D).fill(v) });
  const none = districtCandidates(c, claim, [8, 8], { step: 4, margin: 2, wet: wetOf(WET_TAG - 1) });
  const all = districtCandidates(c, claim, [8, 8], { step: 4, margin: 2, wet: wetOf(WET_TAG) });
  assert.ok(base.some((q) => q.tags.includes('wet')) && base.some((q) => !q.tags.includes('wet')));
  assert.ok(none.every((q) => !q.tags.includes('wet')));
  assert.ok(all.every((q) => q.tags.includes('wet')));
  // near_water and the rest are untouched by the field
  assert.deepEqual(all.map((q) => q.tags.filter((t) => t !== 'wet')), base.map((q) => q.tags.filter((t) => t !== 'wet')));
  assert.throws(() => districtCandidates(c, claim, [8, 8], { wet: { ...wetOf(0), width: 32 } }), /survey grid/);
});

test('plan_v0: the pass runs only with a course, race or ditch part', async () => {
  assert.ok(isCoursePart({ family: 'connector', kind: 'channel', part: { from: { anchor: 'a' }, to: { anchor: 'b' } } }));
  assert.ok(isCoursePart({ family: 'connector', kind: 'channel', part: { where: { along: { feature: { part: 'farm' } } } } }));
  assert.ok(!isCoursePart({ family: 'connector', kind: 'channel', part: { where: { around: { feature: { part: 'keep' } } } } }), 'a moat is H\'s');
  assert.ok(!isCoursePart({ family: 'connector', kind: 'street', part: { from: { anchor: 'a' }, to: { anchor: 'b' } } }));
  const s = flatSurvey();
  const anchors = stewardAnchors(s.claim);
  const course = JSON.parse(fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'plan', 'valid', 'v51_canal.json'), 'utf8')).plan;
  const a = await checkPlanLocal(course, { survey: s.bytes, claim: s.claim, anchors });
  assert.deepEqual((a.res.meta.passes ?? []).map((p) => p.name), ['hydrology']);
  assert.ok(a.res.ir.blobs.field_flow && a.res.ir.blobs.field_wet);
  const plain = { schemaVersion: 'plan/0', planId: 'hya_plain', connectors: [{ id: 'lane', kind: 'path', from: { anchor: 'street_w' }, to: { anchor: 'street_e' } }] };
  const b = await checkPlanLocal(plain, { survey: s.bytes, claim: s.claim, anchors });
  assert.ok(!(b.res.meta.passes ?? []).some((p) => p.name === 'hydrology'));
  assert.ok(!b.res.ir.blobs?.field_flow && !b.res.ir.blobs?.field_wet);
});

test('wiring (§5): a material rule and a scatter density on `wet` work in a plan that runs the pass, and fail as today without it', async () => {
  // a 64 x 64 claim, a lake along the east edge (x >= 56); a plane at y 100 painted mud where wet >= 170, else stone
  const W = 64, claim = { minX: 0, minZ: 0, maxX: W - 1, maxZ: W - 1, minY: -64, maxY: 319 };
  const c = grid(W, W, () => 64, { water: (i) => i >= 56 });
  const rule = { rule: [{ when: { field: 'wet', gte: 170 }, mat: 'minecraft:mud' }], default: 'minecraft:stone' };
  const prog = (withPass) => ({ id: 'hy_wire', passes: withPass ? ['hydrology'] : [], default: (ctx) => {
    const r = ctx.region(); r.stages(['main']); r.anchor('entrance', [8, 65, 8]); r.anchor('spawn', [9, 65, 8]);
    if (withPass) r.pass('hydrology');
    r.part('plane', { stage: 'main' }).fill({ kind: 'box', min: [0, 100, 0], max: [W - 1, 100, W - 1] }, rule);
    scatter(r, 'reeds', { grid: 6, jitter: 1, density: { field: 'wet', scale: [40, 200] }, items: [{ w: 1, item: 'fern_patch' }] }, { stage: 'main' });
    return r;
  } });
  const res = await planRegion({ program: prog(true), survey: c, claim, seed: '1' });
  assert.ok(res.ir.requires.includes('fields'));
  const blobs = {};
  for (const [k, v] of res.blobs) blobs[k] = v;
  const win = makeColumns(-8, -8, 80, 80, 1);
  for (let k = 0; k < 80 * 80; k++) { win.ground[k] = 64; win.height[k] = 64; win.floor[k] = 64; }
  const cells = new Map(unpack(evalTile(res.ir, '0,0', win, { blobs, stage: 'main', set: 'terrain' }).payload).cells.filter((q) => q.y === 100).map((q) => [`${q.x},${q.z}`, q.state]));
  const wet = hydrologyPass(c, [], {}).fields.wet.values;
  let mud = 0, n = 0;
  for (let z = 0; z < W; z++) for (let x = 0; x < W; x++) {
    const want = wet[x + z * W] >= 170 ? 'minecraft:mud' : 'minecraft:stone';
    if (cells.has(`${x},${z}`)) { n++; assert.equal(cells.get(`${x},${z}`), want, `${x},${z}`); if (want === 'minecraft:mud') mud++; }
  }
  assert.ok(n >= W * W / 2, `${n} plane cells checked`);
  assert.ok(mud > 0 && cells.get('0,10') === 'minecraft:stone', 'mud by the lake, stone far from it');
  // without the pass: the names the IR doesn't hold fail as today
  await assert.rejects(planRegion({ program: prog(false), survey: c, claim, seed: '1' }), /wet/);
});

test('r.pass(\'hydrology\', {_ran}) is the check\'s own: a program cannot register made-up fields through it', async () => {
  const claim = { minX: 0, minZ: 0, maxX: 31, maxZ: 31, minY: -64, maxY: 319 };
  const c = grid(32, 32, () => 64);
  const fake = { out: { fields: { flow: { type: 'u8', minX: 0, minZ: 0, width: 32, depth: 32, res: 1, values: new Uint8Array(1024).fill(255) }, wet: { type: 'u8', minX: 0, minZ: 0, width: 32, depth: 32, res: 1, values: new Uint8Array(1024).fill(255) } }, data: { resolution: 1 } }, ms: 0 };
  const res = await planRegion({ program: { id: 'hy_ran', passes: ['hydrology'], default: (ctx) => { const r = ctx.region(); r.stages(['main']); r.anchor('entrance', [8, 65, 8]); r.anchor('spawn', [9, 65, 8]); r.pass('hydrology', { _ran: fake }); return r; } }, survey: c, claim, seed: '1' });
  const flow = res.blobs.get(res.ir.blobs.field_flow.sha);
  assert.ok([...flow].some((v) => v !== 255), 'the pass ran on the survey, not the given output');
});
