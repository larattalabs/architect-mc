// Phase 6c slice MP (docs/CONTRACT.md "Phase 6c slice MP: masks and patterns" §4), the kit half of the gate:
//   1 mix shares (50 seeds x 10k cells, each block within 2 points of its weight);
//   2 gradients monotone by stop order over 1,000 random columns, and no straight boundary run of 6+ on a flat gradient;
//   3 masks equal to a brute-force reference evaluator: 500 random masks x 2,000 cells through evalTile (class terms from a
//     frozen volume, field and noise terms) and 500 x 2,000 through compileMask with block terms (a synthetic block source);
//   4 tile independence and 5 determinism on the crater toolbox demo (1 and 4 workers, forward and shuffled; IR byte-identical
//     over 3 plans; committed golden);
//   6 the schema drift fixture (kit/test/fixtures/mp/specs.json; the mod's MaskPatternDriftTest reads it);
//   8 crater_works without the toolbox keeps its IR (the params leave `toolbox` out);
// plus the program API (fill, carve, part masks, role patterns from a bible, refusals) and format 2 (`requires`).
// Regenerate the fixtures (only on purpose): UPDATE_GOLDEN=1 node --test kit/test/mp.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { compileMask, maskError } from '../lib/mask.mjs';
import { compilePattern, patternError } from '../lib/pattern.mjs';
import { compileIR, evalTile, staleReason, walkKinds } from '../lib/realise.mjs';
import { makeNoise } from '../lib/noise.mjs';
import { tagBlocks } from '../lib/blocks.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { region } from '../lib/region/program.mjs';
import { sha256Hex, unpack } from '../lib/region/pack.mjs';
import { synthSurvey, synthTileWindow, synthWorld } from '../lib/region/synth.mjs';
import { encodeArvx } from '../lib/region/volume.mjs';
import { CLASSES, BLOCKS, driftSpecs, randomMask, randomPattern, rng } from './mp-specs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, '..');
const FIX = path.join(HERE, 'fixtures');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const SEED = 'golden';

// ------------------------------------------------------------------ the brute-force reference (independent of lib/mask.mjs)

/** A mask's verdict at one cell, straight from the spec. `W`: {ground(x, z), field(name, x, z), cls(x, y, z), block(x, y, z)}. */
export function refMask(m, x, y, z, W) {
  if (m.all) return m.all.every((k) => refMask(k, x, y, z, W));
  if (m.any) return m.any.some((k) => refMask(k, x, y, z, W));
  if (m.not) return !refMask(m.not, x, y, z, W);
  const cmp = (v) => (m.gte === undefined || v >= m.gte) && (m.lt === undefined || v < m.lt);
  if (m.height) return y >= m.height[0] && y <= m.height[1];
  if (m.depth) { const d = W.ground(x, z) - y; return d >= m.depth[0] && d <= m.depth[1]; }
  if (m.slope) {
    const g = W.ground(x, z);
    let s = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) s = Math.max(s, Math.abs(W.ground(x + dx, z + dz) - g));
    return s >= m.slope[0] && s <= m.slope[1];
  }
  if (m.field !== undefined) return cmp(W.field(m.field, x, z));
  if (m.noise) return cmp(W.noise(m.noise)(x, y, z));
  if (m.class) return m.class.includes(W.cls(x, y, z));
  if (m.block) {
    const b = W.block(x, y, z);
    return m.block.some((t) => (t.startsWith('#') ? tagBlocks(t).includes(b) : (t.includes(':') ? t : `minecraft:${t}`) === b));
  }
  throw new Error(`refMask: ${JSON.stringify(m)}`);
}

// a 2D u8 field 'wet' over [-64, 192)^2 and a frozen volume over part of it
const FIELD = { minX: -64, minZ: -64, width: 256, depth: 256 };
const fieldValues = (() => { const r = rng(17), v = new Uint8Array(FIELD.width * FIELD.depth); for (let i = 0; i < v.length; i++) v[i] = r.int(0, 255); return v; })();
const fieldAt = (x, z) => {
  const i = x - FIELD.minX, j = z - FIELD.minZ;
  return i < 0 || j < 0 || i >= FIELD.width || j >= FIELD.depth ? 0 : fieldValues[i + j * FIELD.width];
};
const VBOX = { minX: 10, minY: 40, minZ: 10, maxX: 100, maxY: 120, maxZ: 100 };
const volClasses = (() => {
  const W = VBOX.maxX - VBOX.minX + 1, H = VBOX.maxY - VBOX.minY + 1, D = VBOX.maxZ - VBOX.minZ + 1;
  const r = rng(29), c = new Uint8Array(W * H * D);
  for (let i = 0; i < c.length; i++) { const k = r.int(0, 13); c[i] = k === 11 ? 1 : k; } // no OWNED (it needs owners)
  return c;
})();
const clsAt = (x, y, z) => {
  if (x < VBOX.minX || x > VBOX.maxX || y < VBOX.minY || y > VBOX.maxY || z < VBOX.minZ || z > VBOX.maxZ) return 'MISSING';
  const H = VBOX.maxY - VBOX.minY + 1, D = VBOX.maxZ - VBOX.minZ + 1;
  return CLASSES[volClasses[((x - VBOX.minX) * D + (z - VBOX.minZ)) * H + (y - VBOX.minY)]];
};
const world = synthWorld(SEED);
const noiseCache = new Map();
const W = {
  ground: (x, z) => world(x, z).g,
  field: (name, x, z) => fieldAt(x, z),
  noise: (spec) => { const k = JSON.stringify(spec); let f = noiseCache.get(k); if (!f) { f = makeNoise(spec); noiseCache.set(k, f); } return f; },
  cls: clsAt,
  block: (x, y, z) => BLOCKS[((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0) % BLOCKS.length],
};

/** A format-2 IR of one masked fill of `box` with the field and the volume as side blobs. */
function maskedIR(mask, box, material = 'minecraft:stone') {
  const fieldBytes = Uint8Array.from(fieldValues);
  const vol = encodeArvx(VBOX, volClasses);
  const blobs = new Map([[sha256Hex(fieldBytes), fieldBytes], [sha256Hex(vol), vol]]);
  const ir = {
    format: 2, id: 'mp_mask', seed: '7', kitVersion: '0.19.0', claim: { minX: -64, minZ: -64, maxX: 191, maxZ: 191, minY: 0, maxY: 200 },
    stages: ['main'], parts: [{ id: 'p', stage: 'main', set: 'terrain', ops: [{ op: 'shape', shape: { kind: 'box', min: [box[0], box[1], box[2]], max: [box[3], box[4], box[5]] }, material, cond: 0, walk: false, mask }] }],
    blobs: { field_wet: { sha: sha256Hex(fieldBytes), bytes: fieldBytes.length, kind: 'field' }, vol_1: { sha: sha256Hex(vol), bytes: vol.length, kind: 'volume' } },
    fields: { wet: { blob: 'field_wet', type: 'u8', ...FIELD, res: 1 } },
    volumes: { vol_1: { blob: 'vol_1', box: VBOX, sha: sha256Hex(vol) } },
  };
  ir.requires = walkKinds(ir);
  return { ir, blobs };
}

// ------------------------------------------------------------------ 3. masks against the reference

test('item 3: 500 random masks x ~2,000 cells through evalTile equal the brute-force reference (class from a frozen volume)', () => {
  const r = rng(3);
  let cells = 0, selected = 0;
  for (let i = 0; i < 500; i++) {
    const mask = randomMask(r, { terms: ['height', 'slope', 'depth', 'field', 'noise', 'class'] });
    assert.equal(maskError(mask), null, JSON.stringify(mask));
    const tx = r.int(0, 1), tz = r.int(0, 1);
    const x0 = tx * 64 + r.int(0, 51), z0 = tz * 64 + r.int(0, 51);
    const g0 = W.ground(x0 + 6, z0 + 6);
    const box = [x0, g0 - 7, z0, x0 + 11, g0 + 6, z0 + 11]; // 12 x 14 x 12 = 2,016 cells
    const { ir, blobs } = maskedIR(mask, box);
    const e = evalTile(ir, `${tx},${tz}`, synthTileWindow(`${tx},${tz}`, SEED), { blobs: (sha) => blobs.get(sha) });
    const got = new Set(e.count ? unpack(e.payload).cells.map((c) => `${c.x},${c.y},${c.z}`) : []);
    for (let x = box[0]; x <= box[3]; x++) for (let y = box[1]; y <= box[4]; y++) for (let z = box[2]; z <= box[5]; z++) {
      const want = refMask(mask, x, y, z, W);
      cells++;
      if (want) selected++;
      if (want !== got.has(`${x},${y},${z}`)) assert.fail(`mask ${i} ${JSON.stringify(mask)} at ${x},${y},${z}: reference ${want}, evalTile ${!want}`);
    }
  }
  assert.ok(cells >= 1_000_000 && selected > cells * 0.1 && selected < cells * 0.9, `${cells} cells, ${selected} selected`);
});

test('item 3: 500 random masks x 2,000 cells through compileMask (block terms and tags too) equal the reference', () => {
  const r = rng(33);
  const fields = (name) => ({ type: 'u8', ...FIELD, res: 1, values: fieldValues });
  let hits = 0;
  for (let i = 0; i < 500; i++) {
    const mask = randomMask(r);
    const test1 = compileMask(mask, { fields, classAt: clsAt, blockAt: W.block, tagBlocks });
    for (let k = 0; k < 2000; k++) {
      const x = r.int(-20, 130), z = r.int(-20, 130), y = W.ground(x, z) + r.int(-8, 8);
      const col = { g: W.ground(x, z), slope: () => { const g = W.ground(x, z); return Math.max(...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => Math.abs(W.ground(x + dx, z + dz) - g))); } };
      const want = refMask(mask, x, y, z, W);
      if (want) hits++;
      assert.equal(test1(x, y, z, col), want, `mask ${i} ${JSON.stringify(mask)} at ${x},${y},${z}`);
    }
  }
  assert.ok(hits > 100_000 && hits < 900_000, `${hits} selected of 1,000,000`);
});

test('masks: a block term refuses MASK_NEEDS_VOLUME in an IR; a class term needs the IR\'s volumes; format 1 refuses a mask', () => {
  const { ir, blobs } = maskedIR({ block: ['minecraft:stone'] }, [0, 60, 0, 3, 63, 3]);
  assert.throws(() => evalTile(ir, '0,0', synthTileWindow('0,0', SEED), { blobs: (s) => blobs.get(s) }), /MASK_NEEDS_VOLUME: .*block term/);
  const { ir: ir2, blobs: b2 } = maskedIR({ class: ['ROCK'] }, [0, 60, 0, 3, 63, 3]);
  delete ir2.volumes; delete ir2.blobs.vol_1; ir2.requires = walkKinds(ir2);
  assert.throws(() => evalTile(ir2, '0,0', synthTileWindow('0,0', SEED), { blobs: (s) => b2.get(s) }), /MASK_NEEDS_VOLUME: .*class term/);
  const f1 = { format: 1, claim: { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: 0, maxY: 100 }, parts: [{ id: 'p', stage: 'main', ops: [{ op: 'shape', shape: { kind: 'box', min: [0, 60, 0], max: [1, 61, 1] }, material: 'minecraft:stone', mask: { height: [0, 100] } }] }] };
  assert.throws(() => compileIR(f1), /a mask needs format 2/);
  assert.match(maskError({ slope: [3, 1] }), /mask\.slope: \[a, b\] needs a <= b/);
  assert.match(maskError({ all: [{ height: [1, 2] }, { foo: 1 }] }), /^mask\.all\[1\]/);
});

// ------------------------------------------------------------------ 1. mix shares

test('item 1: mix shares over 50 seeds x 10,000 cells are within 2 points of their weights', () => {
  const r = rng(1);
  let worst = 0;
  for (let s = 0; s < 50; s++) {
    const spec = s === 0 ? { mix: [{ w: 6, mat: 'minecraft:stone' }, { w: 3, mat: 'minecraft:andesite' }, { w: 1, mat: 'minecraft:cobblestone' }], seedLabel: 'wall' }
      : { mix: Array.from({ length: r.int(2, 5) }, (_, i) => ({ w: r.int(1, 20), mat: BLOCKS[i] })), seedLabel: r.pick(['wall', 'floor', 'mix']) };
    assert.equal(patternError(spec), null);
    const idx = new Map();
    const pick = compilePattern(spec, { mat: (m) => { if (!idx.has(m)) idx.set(m, idx.size); return idx.get(m); }, seed: String(1000003 * s + 7) });
    const n = new Array(spec.mix.length).fill(0);
    const ox = r.int(-5000, 5000), oz = r.int(-5000, 5000), y = r.int(-40, 200);
    for (let x = 0; x < 100; x++) for (let z = 0; z < 100; z++) n[pick(ox + x, y, oz + z, 0)]++;
    const total = spec.mix.reduce((a, e) => a + e.w, 0);
    spec.mix.forEach((e, i) => {
      const d = Math.abs(n[idx.get(e.mat)] / 10000 - e.w / total);
      worst = Math.max(worst, d);
      assert.ok(d <= 0.02, `seed ${s}: ${e.mat} share ${n[idx.get(e.mat)] / 10000} vs weight ${e.w / total}`);
    });
  }
  console.log(`# mix: worst share error ${(100 * worst).toFixed(2)} points over 50 seeds x 10,000 cells`);
});

// ------------------------------------------------------------------ 2. gradients

test('item 2: gradients pick monotonically by stop order over 1,000 random columns', () => {
  const r = rng(2);
  const fields = () => ({ type: 'u8', ...FIELD, res: 1, values: fieldValues });
  for (let c = 0; c < 1000; c++) {
    const spec = randomPattern(r);
    if (!spec.gradient) { c--; continue; }
    const mats = spec.gradient.stops.map((_, i) => `minecraft:stop_${i}`);
    spec.gradient.stops.forEach((s, i) => { s.mat = mats[i]; });
    const pick = compilePattern(spec, { mat: (m) => mats.indexOf(m), fields, seed: '5' });
    const x = r.int(-60, 180), z = r.int(-60, 180), g = r.int(50, 90);
    const by = spec.gradient.by;
    // walk the gradient's own variable upwards: y for 'y', down the column for 'depth'; a field gradient is checked over x
    const seq = [];
    if (by === 'y') for (let y = 20; y <= 140; y++) seq.push(pick(x, y, z, g));
    else if (by === 'depth') for (let y = g + 10; y >= g - 140; y--) seq.push(pick(x, y, z, g));
    else {
      const vs = [];
      for (let k = 0; k < 64; k++) vs.push([fieldAt(x + k, z), x + k]);
      vs.sort((a, b) => a[0] - b[0]);
      // for a fixed dither cell the choice is monotone in the field value: compare cells with the same (x & 3, z & 3)
      for (const [, xx] of vs.filter(([, xx]) => (xx & 3) === (x & 3))) seq.push(pick(xx, 64, z, g));
    }
    for (let i = 1; i < seq.length; i++) assert.ok(seq[i] >= seq[i - 1], `column ${c} ${JSON.stringify(spec)}: stop ${seq[i - 1]} then ${seq[i]}`);
    if (by !== 'y' && by !== 'depth') continue;
    assert.equal(seq[0], 0, 'below the first stop: the first mat');
    assert.equal(seq[seq.length - 1], mats.length - 1, 'past the last stop: the last mat');
  }
});

test('item 2: the dither leaves no straight boundary run of 6 or more on a flat gradient (intervals 2..12)', () => {
  let longest = 0;
  for (let gap = 2; gap <= 12; gap++) {
    const spec = { gradient: { by: 'y', stops: [{ at: 60, mat: 'minecraft:sand' }, { at: 60 + gap, mat: 'minecraft:grass_block' }] }, dither: 'ordered4' };
    const pick = compilePattern(spec, { mat: (m) => (m === 'minecraft:sand' ? 0 : 1), seed: '1' });
    // the boundary: the lowest y of the upper mat per column
    const top = (x, z) => { for (let y = 55; y <= 80; y++) if (pick(x, y, z, 64) === 1) return y; return 81; };
    for (let a = 0; a < 64; a++) {
      let runX = 1, runZ = 1;
      for (let b = 1; b < 64; b++) {
        runX = top(b, a) === top(b - 1, a) ? runX + 1 : 1;
        runZ = top(a, b) === top(a, b - 1) ? runZ + 1 : 1;
        longest = Math.max(longest, runX, runZ);
      }
    }
  }
  console.log(`# gradient: the longest straight boundary run is ${longest} (bar: under 6)`);
  assert.ok(longest < 6, `a straight boundary run of ${longest}`);
});

test('patterns in an IR: shape materials, columns materials and rule mats paint as compilePattern picks; requires names pattern', () => {
  const mix = { mix: [{ w: 1, mat: 'minecraft:stone' }, { w: 1, mat: 'minecraft:andesite' }], seedLabel: 'wall' };
  const grad = { gradient: { by: 'depth', stops: [{ at: 0, mat: 'minecraft:grass_block' }, { at: 4, mat: 'minecraft:dirt' }, { at: 8, mat: 'minecraft:stone' }] } };
  const g = (x, z) => W.ground(x, z);
  const ir = {
    format: 2, id: 'mp_pat', seed: '99', kitVersion: '0.19.0', claim: { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: 0, maxY: 200 }, stages: ['main'],
    parts: [{ id: 'p', stage: 'main', set: 'terrain', ops: [
      { op: 'shape', shape: { kind: 'box', min: [0, 30, 0], max: [15, 120, 15] }, material: { pattern: mix }, cond: 0, walk: false },
      { op: 'columns', from: { surface: 0 }, to: { surface: 0 }, cols: [20, 20, -12, 0, 0, 21, 20, -12, 0, 1], materials: [{ pattern: grad }, 'minecraft:gold_block'], cond: 0, walk: false },
      { op: 'shape', shape: { kind: 'box', min: [30, 30, 30], max: [33, 120, 33] }, material: { rule: { rule: [{ when: { yAbs: [0, 70] }, mat: { pattern: grad } }], default: { pattern: mix } } }, cond: 0, walk: false },
    ] }],
  };
  ir.requires = walkKinds(ir);
  assert.deepEqual(ir.requires, ['material:rule', 'pattern']);
  const cells = unpack(evalTile(ir, '0,0', synthTileWindow('0,0', SEED)).payload).cells;
  const idx = [];
  const mat = (m) => { let i = idx.indexOf(m); if (i < 0) { idx.push(m); i = idx.length - 1; } return i; };
  const pm = compilePattern(mix, { mat, seed: '99' }), pg = compilePattern(grad, { mat, seed: '99' });
  let n = 0;
  for (const c of cells) {
    let want;
    if (c.x <= 15 && c.z <= 15) want = idx[pm(c.x, c.y, c.z, g(c.x, c.z))];
    else if (c.z === 20 && c.x === 20) want = idx[pg(c.x, c.y, c.z, g(c.x, c.z))];
    else if (c.z === 20 && c.x === 21) want = 'minecraft:gold_block';
    else want = c.y <= 70 ? idx[pg(c.x, c.y, c.z, g(c.x, c.z))] : idx[pm(c.x, c.y, c.z, g(c.x, c.z))];
    assert.equal(c.state, want, `${c.x},${c.y},${c.z}`);
    n++;
  }
  assert.ok(n > 20000, `${n} cells`);
  // a role name in an IR pattern is refused (roles resolve at plan time)
  const bad = structuredClone(ir);
  bad.parts[0].ops = [{ ...ir.parts[0].ops[0], material: { pattern: { mix: [{ w: 1, mat: 'rock' }] } } }];
  assert.throws(() => compileIR(bad), /'rock' is not a block state/);
});

// ------------------------------------------------------------------ the program API

const claimOf = (size) => { const h = size / 2; return { minX: -h, minZ: -h, maxX: h - 1, maxZ: h - 1, minY: -64, maxY: 319 }; };
async function planInline(fn, { size = 64, patterns, roles, params } = {}) {
  const program = { id: 'mp_inline', default: (ctx) => { const r = region(ctx); fn(r, ctx); r.anchor('entrance', [0, 0]); r.anchor('spawn', [1, 0]); return r; } };
  return planRegion({ program, programSource: fn.toString(), survey: synthSurvey(claimOf(size), SEED), claim: claimOf(size), patterns, roles, params, node: 'golden' });
}

test('program: fill with a mask and a pattern, a part mask, carve with a pattern lining, noise labels and block tags resolved', async () => {
  const p = await planInline((r) => {
    const a = r.part('a');
    a.fill({ kind: 'box', min: [-20, { surface: -3 }, -20], max: [-5, { surface: 0 }, -5] }, { mix: [{ w: 3, mat: 'rock' }, { w: 1, mat: 'andesite' }] }, { mask: { all: [{ slope: [0, 2] }, { not: { noise: 'age', gte: 0.6 } }] } });
    const b = r.part('b', { mask: { depth: [0, 1] } });
    b.fill({ kind: 'box', min: [0, { surface: -4 }, 0], max: [10, { surface: 0 }, 10] }, 'rubble');
    b.fill({ kind: 'box', min: [12, { surface: -4 }, 0], max: [20, { surface: 0 }, 10] }, 'rubble', { mask: { height: [0, 300] } });
    r.part('c').carve({ kind: 'sphere', c: [0, { surface: -2 }, 20], r: 5 }, { lining: { gradient: { by: 'y', stops: [{ at: 50, mat: 'rock' }, { at: 90, mat: 'surface' }] } } });
    // a block mask is resolved (tags qualified) even though the realise refuses it later
    assert.deepEqual(r.mask({ block: ['#dirt', 'grass_block'] }), { block: ['#minecraft:dirt', 'minecraft:grass_block'] });
    assert.throws(() => r.mask({ block: ['#nope'] }), /not a 26.3 block tag/);
    assert.throws(() => r.part('d').ring([0, 0], 3, 5, { material: { mix: [{ w: 1, mat: 'rock' }] } }), /a pattern is taken by fill, carve and material rules/);
  });
  assert.equal(p.ir.format, 2);
  assert.deepEqual(p.ir.requires, ['mask', 'pattern']);
  const [opA] = p.ir.parts.find((x) => x.id === 'a').ops;
  assert.deepEqual(opA.material, { pattern: { mix: [{ w: 3, mat: 'minecraft:stone' }, { w: 1, mat: 'minecraft:andesite' }] } });
  assert.equal(typeof opA.mask.all[1].not.noise, 'object', 'the noise label is a seeded spec');
  const opsB = p.ir.parts.find((x) => x.id === 'b').ops;
  assert.deepEqual(opsB.map((o) => o.mask), [{ depth: [0, 1] }, { height: [0, 300] }], 'the part mask, then an op\'s own');
  const opsC = p.ir.parts.find((x) => x.id === 'c').ops;
  assert.deepEqual(opsC[0].material.pattern.gradient.stops.map((s) => s.mat), ['minecraft:stone', 'minecraft:grass_block']);
  // the part mask held: part b writes depth 0..1 only
  const bOnly = await planInline((r) => { r.part('b', { mask: { depth: [0, 1] } }).fill({ kind: 'box', min: [0, { surface: -4 }, 0], max: [10, { surface: 0 }, 10] }, 'rubble'); });
  assert.equal(bOnly.ir.budget.cells, 11 * 11 * 2);
});

test('program: a bible\'s role patterns paint fill and carve; primitives take the role\'s block; a bad pattern refuses', async () => {
  const patterns = { rock: { mix: [{ w: 1, mat: 'rock' }, { w: 1, mat: 'minecraft:tuff' }], seedLabel: 'rock' } };
  const p = await planInline((r, ctx) => {
    r.part('a').fill({ kind: 'box', min: [0, { surface: -2 }, 0], max: [4, { surface: 0 }, 4] }, 'rock');
    r.part('b').pillar([10, ctx.survey.heightAt(10, 10) + 3, 10], { material: 'rock' });
  }, { patterns, roles: { rock: 'minecraft:deepslate' } });
  assert.deepEqual(p.ir.parts[0].ops[0].material, { pattern: { mix: [{ w: 1, mat: 'minecraft:deepslate' }, { w: 1, mat: 'minecraft:tuff' }], seedLabel: 'rock' } });
  assert.equal(p.ir.parts[1].ops[0].material, 'minecraft:deepslate');
  assert.equal(p.ir.roles.rock, 'minecraft:deepslate', 'roles stay block states');
  await assert.rejects(planInline(() => {}, { patterns: { nope: { mix: [{ w: 1, mat: 'rock' }] } } }), /patterns\.nope: 'nope' is not a role/);
  await assert.rejects(planInline(() => {}, { patterns: { rock: { mix: [{ w: 0, mat: 'rock' }] } } }), /patterns\.rock\.mix\[0\]\.w: under 1/);
});

test('format 2: requires names mask and pattern; an older kit refuses them (PLAN_STALE)', async () => {
  const p = await planInline((r) => { r.part('a').fill({ kind: 'box', min: [0, 60, 0], max: [1, 61, 1] }, { mix: [{ w: 1, mat: 'rock' }] }, { mask: { height: [0, 100] } }); });
  assert.deepEqual(p.ir.requires, ['mask', 'pattern']);
  assert.equal(staleReason(p.ir), null);
  assert.match(staleReason(p.ir, '0.18.0'), new RegExp(`plan needs kit ${p.ir.kitVersion.replaceAll('.', '\\.')}`)); // (6c T1) the running kit's version, 0.19.0 or later
  assert.match(staleReason({ ...p.ir, kitVersion: '0.18.0', requires: ['mask', 'pattern', 'op:brush'] }), /kinds \[op:brush\]/);
});

// ------------------------------------------------------------------ 4, 5, 8: the crater toolbox demo

const WORKER = new URL('./fixtures/regions/eval-worker.mjs', import.meta.url);
const evalIn = (irJson, jobs, blobs) => new Promise((resolve, reject) => {
  const w = new Worker(WORKER, { workerData: { irJson, seed: SEED, jobs, blobs } });
  w.once('message', (m) => { resolve(m); void w.terminate(); });
  w.once('error', reject);
});
const crater = (params) => planRegion({ programFile: path.join(KIT, 'regions', 'crater_works.mjs'), survey: synthSurvey(claimOf(200), SEED), claim: claimOf(200), params, node: 'golden', kitVersion: '0.19.0' });

test('items 4 and 5: the crater toolbox demo: IR byte-identical over 3 plans; tiles equal for 1 and 4 workers, forward and shuffled; the golden', async () => {
  const a = await crater({ toolbox: true }), b = await crater({ toolbox: true }), c = await crater({ toolbox: true });
  assert.equal(a.irJson, b.irJson);
  assert.equal(a.irJson, c.irJson);
  assert.deepEqual(a.ir.requires, ['mask', 'pattern']);
  const jobs = [];
  for (const stage of a.ir.stages) for (const set of ['terrain', 'path']) for (const key of a.ir.tiles[stage][set]) jobs.push({ key, stage, set });
  const one = await evalIn(a.irJson, jobs, {});
  const order = [...jobs];
  let s = 99;
  for (let i = order.length - 1; i > 0; i--) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const j = s % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  const four = (await Promise.all([0, 1, 2, 3].map((k) => evalIn(a.irJson, order.filter((_, i) => i % 4 === k), {})))).flat();
  const tag = (r) => `${r.stage}|${r.set}|${r.key}`;
  const m1 = Object.fromEntries(one.map((r) => [tag(r), r.sha])), m4 = Object.fromEntries(four.map((r) => [tag(r), r.sha]));
  assert.deepEqual(m4, m1);
  const now = { irSha: a.irSha, cells: one.reduce((n, r) => n + r.count, 0), tiles: Object.fromEntries(Object.keys(m1).sort().map((k) => [k, m1[k]])) };
  const file = path.join(FIX, 'regions', 'crater-toolbox.golden.json');
  if (UPDATE) fs.writeFileSync(file, `${JSON.stringify({ note: 'crater_works {toolbox: true} over synthSurvey(200, "golden"), node "golden", kit 0.19.0: the MP demo; tiles: stage|set|key -> sha256 of the ARTL payload (macOS and Linux CI)', ...now }, null, 1)}\n`);
  const g = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(now.irSha, g.irSha, 'IR sha');
  assert.deepEqual(now.tiles, g.tiles, 'tile shas');
  // the toolbox moved some cells (the rim mask) and materials, not the frozen terrain's plan otherwise
  const off = await crater({});
  assert.ok(Object.keys(now.tiles).length === Object.values(off.ir.tiles).reduce((n, t) => n + t.terrain.length + t.path.length, 0), 'the same tiles');
});

test('item 8: crater_works without the toolbox keeps its IR: toolbox is left out of the params at its default', async () => {
  const a = await crater({}), b = await crater({ toolbox: false });
  assert.equal(a.irJson, b.irJson);
  assert.equal(a.ir.params.toolbox, undefined);
  assert.equal(a.ir.format, 1, 'no mask, no pattern: format 1 as before');
});

// ------------------------------------------------------------------ 6. the schema drift fixture

test('item 6: the drift fixture (200 generated specs, valid and invalid) is current; the kit\'s schema check agrees with it', () => {
  const verdict = (kind, spec) => (kind === 'mask' ? maskError(spec) : patternError(spec));
  const now = driftSpecs(verdict);
  const file = path.join(FIX, 'mp', 'specs.json');
  if (UPDATE) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify({ note: 'kit/test/mp-specs.mjs driftSpecs: 100 masks and 100 patterns, every other one broken; valid/error from the kit (lib/mask.mjs maskError, lib/pattern.mjs patternError); the mod\'s MaskPatternDriftTest asserts api.Mask / api.Pattern agree', specs: now }, null, 1)}\n`); }
  const g = JSON.parse(fs.readFileSync(file, 'utf8')).specs;
  assert.deepEqual(now, g);
  const valid = g.filter((x) => x.valid).length;
  assert.equal(g.length, 200);
  assert.ok(valid >= 90 && valid <= 110, `${valid} valid`);
  // every generated (unbroken) spec is valid; every broken one invalid
  g.forEach((x, i) => assert.equal(x.valid, (i % 100) % 2 === 1, `spec ${i}: ${x.error}`));
});

test('the checker reads pattern materials (M13): the toolbox demo checks with 0 errors, a bad block in a pattern is an M13 error', async () => {
  const { checkRegion } = await import('../lib/region/check.mjs');
  const p = await crater({ toolbox: true });
  const r = checkRegion({ ir: p.ir, meta: p.meta, survey: synthSurvey(claimOf(200), SEED), blobs: p.blobs });
  assert.equal(r.errors, 0, JSON.stringify(r.findings.filter((f) => f.severity === 'error')));
  const bad = structuredClone(p.ir);
  bad.parts.find((x) => x.id === 'crater').ops[0].material.pattern.mix[1].mat = 'minecraft:not_a_block';
  const r2 = checkRegion({ ir: bad, meta: p.meta, survey: synthSurvey(claimOf(200), SEED), blobs: p.blobs, rules: ['M13'] });
  assert.ok(r2.findings.some((f) => f.rule === 'M13' && /not_a_block/.test(f.message)), JSON.stringify(r2.findings));
});
