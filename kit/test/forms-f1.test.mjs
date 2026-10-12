// Phase 6c slice F1 (docs/CONTRACT.md "Phase 6c slice F1", §2-§7): the voxels op, the generator rules (200 seeds per generator:
// every op at most 32 primitives, deterministic, settled: no unsupported cell and no overhang over 4 on a sample), the bake past
// BAKE_OPS (400, confirmed by gate item 6), keepNatural (M1), M17 melt, M3 overhangs, and the broken variants of gate item 2-4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRegion } from '../lib/region/plan.mjs';
import { region } from '../lib/region/program.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { KINDS_FORMAT2, OPS_RESERVED, compileIR, evalTile, staleReason } from '../lib/realise.mjs';
import { makeColumns, unpack } from '../lib/region/pack.mjs';
import { decodeVoxels, encodeVoxels, turnState, turnXZ, voxelAt } from '../lib/region/voxels.mjs';
import { VC, decodeArvx, encodeArvx } from '../lib/region/volume.mjs';
import { fnv64 } from '../lib/noise.mjs';
import { iceSpike, PRESETS as ICE_PRESETS } from '../lib/forms/iceSpike.mjs';
import { rockSpire, PRESETS as ROCK_PRESETS } from '../lib/forms/rockSpire.mjs';
import { BAKE_OPS, MAX_PRIMITIVES, formCells, opPrimitives, overhangs, unsupported } from '../lib/forms/rules.mjs';
import * as formsDemo from '../regions/forms_demo.mjs';

const flatCols = (minX, minZ, w, d, g = 64) => { const c = makeColumns(minX, minZ, w, d, 1); c.ground.fill(g); c.height.fill(g); c.floor.fill(g); return c; };
const win = (key, g = 64) => { const [tx, tz] = key.split(',').map(Number); return flatCols(tx * 64 - 8, tz * 64 - 8, 80, 80, g); };

/** A seeded r() for param sets. */
function rnd(label, k) {
  const h = fnv64(label, k);
  let s = h.lo >>> 0;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  r.int = (a, b) => a + Math.floor(r() * (b - a + 1));
  r.pick = (a) => a[Math.floor(r() * a.length)];
  return r;
}

// ------------------------------------------------------------------ voxels

test('voxels: ARVB round trip, turns and the kinds lists', () => {
  const cells = [[0, 0, 0, 'minecraft:stone'], [2, 1, 0, 'minecraft:oak_log[axis=x]'], [1, 3, 2, 'minecraft:stone'], [0, 2, 1, 'minecraft:air']];
  const b = encodeVoxels([3, 4, 3], cells);
  assert.deepEqual([...b.subarray(0, 5)], [0x41, 0x52, 0x56, 0x42, 1]);
  const v = decodeVoxels(b);
  assert.equal(v.count, 4);
  const back = Array.from({ length: v.count }, (_, i) => [...voxelAt(v, i), v.palette[v.pal[i]]]).sort();
  assert.deepEqual(back, [...cells].sort());
  assert.deepEqual(encodeVoxels([3, 4, 3], [...cells].reverse()), b, 'cell order does not matter');
  assert.throws(() => encodeVoxels([3, 4, 3], [[3, 0, 0, 'minecraft:stone']]), /outside the size/);
  assert.throws(() => decodeVoxels(b.subarray(0, b.length - 1)), /truncated|trailing|out of range/);
  assert.equal(turnState('minecraft:oak_log[axis=x]', 1), 'minecraft:oak_log[axis=z]');
  assert.equal(turnState('minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]', 1), 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]');
  assert.equal(turnState('minecraft:oak_fence[east=false,north=true,south=false,waterlogged=false,west=false]', 2), 'minecraft:oak_fence[east=false,north=false,south=true,waterlogged=false,west=false]');
  assert.deepEqual(turnXZ(0, 0, 3, 2, 1), [1, 0]);
  assert.deepEqual(turnXZ(2, 1, 3, 2, 2), [0, 0]);
  assert.ok(KINDS_FORMAT2.includes('voxels') && !OPS_RESERVED.includes('voxels'));
  // a kit before F1 (no voxels kind) refuses the plan PLAN_STALE, naming the kind
  const ir = { format: 2, requires: ['voxels'], kitVersion: '0.16.0' };
  assert.equal(staleReason(ir), null);
});

/** A one-op IR around a voxels blob (one stage, one part). */
function voxelsIr(bytes, origin, rotation, claim) {
  const sha = 'a'.repeat(64);
  return { ir: { format: 2, id: 'vox_test', kitVersion: '0.19.0', requires: ['blobs:side', 'voxels'], claim, stages: ['s'], parts: [{ id: 'p', stage: 's', set: 'terrain', ops: [{ op: 'voxels', blob: 'b', origin, rotation, cond: 0, walk: false }] }], blobs: { b: { sha, bytes: bytes.length, kind: 'voxels' } } }, blobs: { [sha]: bytes } };
}

test('voxels: realise copies exactly the turned cells, tile by tile, any tile order', () => {
  // a 70x9x5 bar across a tile boundary with a few distinct states
  const cells = [];
  for (let x = 0; x < 70; x++) for (let y = 0; y < 9; y++) for (let z = 0; z < 5; z++) if ((x + y + z) % 3) cells.push([x, y, z, (x % 7 === 0) ? 'minecraft:oak_log[axis=x]' : 'minecraft:packed_ice']);
  const bytes = encodeVoxels([70, 9, 5], cells);
  const claim = { minX: -200, minZ: -200, maxX: 200, maxZ: 200, minY: 0, maxY: 200 };
  for (const rot of [0, 90, 180, 270]) {
    const k = rot / 90;
    const { ir, blobs } = voxelsIr(bytes, [30, 70, -3], rot, claim);
    const want = new Map();
    for (const [x, y, z, s] of cells) { const [dx, dz] = turnXZ(x, z, 70, 5, k); want.set(`${30 + dx},${70 + y},${-3 + dz}`, turnState(s, k)); }
    const keys = ['0,-1', '1,-1', '0,0', '1,0', '-1,-1', '-1,0', '0,-2', '0,1', '-1,1', '-2,0', '1,1', '1,-2'];
    const run = (order) => {
      const got = new Map(), shas = {};
      for (const key of order) { const e = evalTile(ir, key, win(key), { blobs }); shas[key] = e.sha; if (e.payload) for (const c of unpack(e.payload).cells) got.set(`${c.x},${c.y},${c.z}`, c.state); }
      return { got, shas };
    };
    const a = run(keys), b = run([...keys].reverse());
    assert.equal(a.got.size, want.size, `rot ${rot}: every cell once`);
    for (const [kk, s] of want) assert.equal(a.got.get(kk), s, `rot ${rot} ${kk}`);
    assert.deepEqual(a.shas, b.shas, `rot ${rot}: tile shas in any order`);
  }
  // format 1 refuses it; a requires list without voxels is refused
  const { ir } = voxelsIr(bytes, [0, 70, 0], 0, claim);
  assert.throws(() => compileIR({ ...ir, format: 1, requires: undefined, blobs: undefined }), /needs format 2|blob/);
  assert.throws(() => compileIR({ ...ir, requires: ['blobs:side'] }, { blobs: () => bytes }), /requires misses \[voxels\]/);
});

// ------------------------------------------------------------------ the generator rules over 200 seeds each

function iceParamsOf(k) {
  const r = rnd('ice-params', k);
  const preset = r.pick(Object.keys(ICE_PRESETS));
  const p = { at: [r.int(-50, 50), 64, r.int(-50, 50)], preset, seed: String(k) };
  if (r() < 0.5) { const a = r.int(1, 4); p.radius = [a, r.int(a, 4)]; }
  if (r() < 0.5) { const a = r.int(8, 40); p.height = [a, r.int(a, 48)]; }
  if (r() < 0.3) p.spikes = [r.int(1, 4), 8];
  if (r() < 0.3) p.lean = r();
  return p;
}
function rockParamsOf(k) {
  const r = rnd('rock-params', k);
  const preset = r.pick(Object.keys(ROCK_PRESETS));
  const p = { at: [r.int(-50, 50), 64, r.int(-50, 50)], preset, seed: String(k) };
  if (r() < 0.4) { const a = r.int(2, 10); p.radius = [a, r.int(a, 12)]; }
  if (r() < 0.4) { const a = r.int(8, 60); p.height = [a, r.int(a, 72)]; }
  if (r() < 0.3) { const a = r.int(2, 6); p.ledge = [a, r.int(a, 7)]; }
  if (r() < 0.3) p.ledges = [0, r.int(0, 4)];
  if (r() < 0.3) p.warp = r.int(0, 3);
  return p;
}

for (const [name, grow, paramsOf] of [['iceSpike', iceSpike, iceParamsOf], ['rockSpire', rockSpire, rockParamsOf]]) {
  test(`${name}: 200 seeds: every op at most ${MAX_PRIMITIVES} primitives, deterministic, settled (no unsupported cell, no overhang over 4)`, () => {
    let ops = 0, maxPrims = 0, maxOps = 0, structural = 0;
    for (let k = 0; k < 200; k++) {
      const p = paramsOf(k);
      const g = grow(p);
      for (const o of g.ops) { const n = opPrimitives(o); maxPrims = Math.max(maxPrims, n); assert.ok(n <= MAX_PRIMITIVES, `${name} seed ${k}: an op with ${n} primitives`); }
      ops += g.ops.length; maxOps = Math.max(maxOps, g.ops.length);
      assert.ok(g.ops.length <= BAKE_OPS, `${name} seed ${k}: ${g.ops.length} ops (it would be baked)`);
      if (k < 3) assert.equal(JSON.stringify(grow(p).ops), JSON.stringify(g.ops), `${name} seed ${k}: deterministic`);
      // structure on every 8th seed (the evaluation is the slow part)
      if (k % 8 === 0) {
        const { cells } = formCells(g.ops);
        assert.equal(unsupported(cells, () => 64).length, 0, `${name} seed ${k}: unsupported cells`);
        const oh = overhangs(cells, () => 64);
        assert.equal(oh.over.length, 0, `${name} seed ${k}: ${oh.over.length} cells overhang more than 4 (max ${oh.max})`);
        const mats = new Set(cells.values());
        if (name === 'iceSpike') for (const m of mats) assert.ok(!['minecraft:ice'].includes(m) && !m.startsWith('minecraft:snow['), `${name} seed ${k}: ${m} melts`);
        structural++;
      }
    }
    test.diagnostic?.(`${name}: ${ops} ops over 200 seeds, max ${maxOps} per form, max ${maxPrims} primitives per op; ${structural} settled`);
  });
}

test('the bake: a form past BAKE_OPS (400) ops is one voxels op (auto); its cells equal the unbaked ops', async () => {
  const claim = { minX: 0, minZ: 0, maxX: 127, maxZ: 127, minY: -64, maxY: 319 };
  // a synthetic generator with 401 small ops (a grid of stone posts)
  const many = { generator: 'test', version: 1, params: {}, seed: '1', bounds: { minX: 10, maxX: 90, minZ: 10, maxZ: 90, minY: 64, maxY: 70 }, ops: [] };
  for (let i = 0; i < 401; i++) many.ops.push({ op: 'shape', shape: { kind: 'box', min: [10 + (i % 21) * 4, { abs: 64 }, 10 + Math.floor(i / 21) * 4], max: [11 + (i % 21) * 4, { abs: 64 + (i % 5) }, 11 + Math.floor(i / 21) * 4] }, material: 'minecraft:stone', cond: 0 });
  const prog = (bake) => ({ id: 'bake_test', default: (ctx) => { const r = region(ctx); r.stages(['s']); r.form('posts', many, { stage: 's', bake }); r.anchor('entrance', [5, 5]); r.anchor('spawn', [5, 5]); return r; } });
  const survey = flatCols(0, 0, 128, 128);
  const a = await planRegion({ program: prog('auto'), programSource: 'a', survey, claim, node: 'test' });
  const b = await planRegion({ program: prog(false), programSource: 'b', survey, claim, node: 'test' });
  assert.equal(a.ir.parts[0].ops.length, 1);
  assert.equal(a.ir.parts[0].ops[0].op, 'voxels');
  assert.ok(a.ir.requires.includes('voxels'));
  assert.equal(a.ir.forms[0].baked.ops, 401);
  assert.equal(b.ir.parts[0].ops.length, 401);
  // every form over BAKE_OPS ops is baked
  for (const f of a.ir.forms) assert.ok(f.baked || f.ops.length <= BAKE_OPS);
  const cellsOf = (p) => {
    const out = new Map();
    for (const key of p.ir.tiles.s.terrain) {
      const e = evalTile(p.ir, key, win(key), { blobs: (sha) => p.blobs.get(sha) });
      for (const c of unpack(e.payload).cells) out.set(`${c.x},${c.y},${c.z}`, c.state);
    }
    return out;
  };
  const ca = cellsOf(a), cb = cellsOf(b);
  assert.equal(ca.size, cb.size);
  for (const [k, s] of cb) assert.equal(ca.get(k), s, k);
  assert.equal(a.ir.budget.cells, b.ir.budget.cells);
});

// ------------------------------------------------------------------ the broken variants: M17, M3 overhang, M1 keep

const CLAIM = { minX: 0, minZ: 0, maxX: 127, maxZ: 127, minY: -64, maxY: 319 };
async function planCheck(fn, { volumes = [], survey = flatCols(0, 0, 128, 128) } = {}) {
  const prog = { id: 'f1_variant', default: (ctx) => { const r = region(ctx); r.stages(['s']); fn(r, ctx); if (!r.anchors.entrance) { r.anchor('entrance', [2, 2]); r.anchor('spawn', [2, 2]); } return r; } };
  const p = await planRegion({ program: prog, programSource: String(fn), survey, claim: CLAIM, volumes, node: 'test' });
  return { p, rep: checkRegion({ ir: p.ir, survey, blobs: (sha) => p.blobs.get(sha), volumes: volumes.map((v) => v.decoded), meta: p.meta }) };
}

test('M17: an ice spike under a lantern melts; packed ice and a soul lantern do not', async () => {
  const lantern = (r, at, block = 'minecraft:lantern') => r.part('lamp', { stage: 's' })._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: [at[0], at[2], at[1], at[1], 0], materials: [block], cond: 2, walk: false });
  const spike = (r, mat) => r.part('spike', { stage: 's' }).fill({ kind: 'cone', c: [40, { abs: 65 }, 40], r0: 2.5, r1: 0, h: 12 }, mat, { cond: 0 });
  let { rep } = await planCheck((r) => { spike(r, 'minecraft:ice'); lantern(r, [43, 66, 40]); });
  const m17 = rep.findings.filter((f) => f.rule === 'M17');
  assert.equal(m17.length, 1, JSON.stringify(rep.findings.map((f) => f.rule)));
  assert.equal(m17[0].part, 'spike');
  assert.ok(rep.metrics.M17.melting > 0);
  ({ rep } = await planCheck((r) => { spike(r, 'minecraft:packed_ice'); lantern(r, [43, 66, 40]); }));
  assert.equal(rep.findings.filter((f) => f.rule === 'M17').length, 0);
  ({ rep } = await planCheck((r) => { spike(r, 'minecraft:ice'); lantern(r, [43, 66, 40], 'minecraft:soul_lantern'); }));
  assert.equal(rep.findings.filter((f) => f.rule === 'M17').length, 0, 'block light 10 never melts ice');
  // a snow layer at block light 12 melts, at 11 it does not (26.3's SnowLayerBlock: over 11)
  ({ rep } = await planCheck((r) => { r.part('snow', { stage: 's' })._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: [60, 60, 65, 65, 0], materials: ['minecraft:snow'], cond: 2, walk: false }); lantern(r, [63, 65, 60]); }));
  assert.equal(rep.findings.filter((f) => f.rule === 'M17').length, 1, 'light 12 at the layer');
  ({ rep } = await planCheck((r) => { r.part('snow', { stage: 's' })._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: [60, 60, 65, 65, 0], materials: ['minecraft:snow'], cond: 2, walk: false }); lantern(r, [64, 65, 60]); }));
  assert.equal(rep.findings.filter((f) => f.rule === 'M17').length, 0, 'light 11 at the layer');
});

/** A frozen volume over [0..31] x [60..80] x [0..31] of the flat world, with ICE or SNOW at given cells. */
function volumeWith(cellsOf) {
  const box = { minX: 0, minY: 60, minZ: 0, maxX: 31, maxY: 80, maxZ: 31 };
  const W = 32, H = 21, D = 32;
  const classes = new Uint8Array(W * H * D);
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) classes[(x * D + z) * H + y] = y + 60 <= 64 ? VC.SOIL : VC.AIR;
  for (const [x, y, z, c] of cellsOf) classes[(x * D + z) * H + (y - 60)] = c;
  const bytes = encodeArvx(box, classes);
  const decoded = decodeArvx(bytes);
  return { box, bytes, sha: decoded.sha, decoded };
}

test('M17 and keepNatural: natural ice a planned lantern reaches; a spike written over a kept natural spike is an M1 error', async () => {
  const natural = [];
  for (let y = 65; y <= 72; y++) natural.push([10, y, 10, VC.ICE]); // a natural ice pillar (a spike)
  natural.push([20, 65, 20, VC.SNOW]);
  const vol = volumeWith(natural);
  const box = vol.box;
  let { rep, p } = await planCheck((r) => {
    const k = r.keepNatural('ICE', box);
    assert.ok(k && k.cells === 8 && k.columns.size === 1 && k.has(10, 70, 10) && !k.has(11, 70, 10));
    r.part('lamp', { stage: 's' })._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: [12, 10, 66, 66, 0, 22, 20, 65, 65, 0], materials: ['minecraft:lantern'], cond: 2, walk: false });
  }, { volumes: [vol] });
  assert.deepEqual(p.ir.parts.find((q) => q.id === 'keep_ice').keep, [{ volume: 'vol_1', class: 'ICE', box }]);
  const m17 = rep.findings.filter((f) => f.rule === 'M17');
  assert.equal(m17.length, 1);
  assert.equal(m17[0].part, null, 'natural cells');
  assert.ok(m17[0].count >= 3, `ice within the lantern's reach and the snow beside the second (${m17[0].message})`);
  assert.equal(rep.errors, 0);
  // the broken variant: a spike over the kept natural spike
  ({ rep } = await planCheck((r) => {
    r.keepNatural('ICE', box);
    r.form('ice_bad', iceSpike({ at: [10, 64, 10], preset: 'stubby', seed: '3' }), { stage: 's' });
  }, { volumes: [vol] }));
  const m1 = rep.findings.filter((f) => f.rule === 'M1');
  assert.equal(m1.length, 1, JSON.stringify(rep.findings.map((f) => f.message)));
  assert.equal(m1[0].part, 'ice_bad');
  assert.equal(m1[0].severity, 'error');
  assert.equal(rep.ok, false);
  assert.ok(rep.metrics.keep.written > 0);
});

test('M3: a 6-wide unbuttressed ledge is an overhang finding; a generated spire has none', async () => {
  let { rep } = await planCheck((r) => { r.rockSpire('spire_bad', { at: [60, 64, 60], preset: 'tower', ledge: [6, 6], ledges: [1, 1], seed: '3' }, { stage: 's', _unsafe: { noButtress: true, ledgeOut: 2 } }); });
  const oh = rep.findings.filter((f) => f.rule === 'M3:overhang');
  assert.equal(oh.length, 1, JSON.stringify(rep.findings.map((f) => f.rule)));
  assert.equal(oh[0].part, 'spire_bad');
  assert.ok(rep.metrics.M3.maxOverhang > 4);
  for (const preset of Object.keys(ROCK_PRESETS)) {
    ({ rep } = await planCheck((r) => { r.rockSpire('spire_ok', { at: [60, 64, 60], preset, seed: '3' }, { stage: 's' }); }));
    assert.equal(rep.findings.filter((f) => /^M3/.test(f.rule)).length, 0, `${preset}: ${JSON.stringify(rep.findings.map((f) => f.message))}`);
    assert.equal(rep.metrics.M3.overhangCells, 0);
  }
});

// ------------------------------------------------------------------ forms_demo

test('forms_demo: plans on a flat claim (6 clusters, 3 spires, one baked), clean, identical over 3 plans', async () => {
  const claim = { minX: 2508, minZ: 1588, maxX: 2699, maxZ: 1779, minY: -64, maxY: 319 };
  const survey = flatCols(claim.minX, claim.minZ, 192, 192);
  const shas = [];
  let p;
  for (let i = 0; i < 3; i++) {
    p = await planRegion({ program: formsDemo, programSource: 'forms_demo', survey, claim, node: 'test' });
    shas.push(`${p.irSha} ${[...p.blobs.keys()].sort().join(',')}`);
  }
  assert.equal(new Set(shas).size, 1);
  const f = p.meta.forms.forms;
  assert.equal(f.filter((x) => x.kind === 'iceSpike').length, 6);
  assert.equal(f.filter((x) => x.kind === 'rockSpire').length, 3);
  assert.equal(p.ir.forms.filter((x) => x.baked).length, 1);
  assert.ok(p.ir.requires.includes('voxels'));
  const rep = checkRegion({ ir: p.ir, survey, blobs: (sha) => p.blobs.get(sha), meta: p.meta });
  assert.equal(rep.errors, 0);
  assert.equal(rep.findings.filter((x) => /^M3|^M17/.test(x.rule)).length, 0, JSON.stringify(rep.findings.map((x) => x.message)));
  assert.equal(rep.metrics.M3.overhangCells, 0);
});
