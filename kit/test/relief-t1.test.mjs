// Phase 6c slice T1 (docs/CONTRACT.md "Phase 6c slice T1"): the relief op (parse, refusal paths, evaluation, clamps), the pass
// framework (declared passes, an undeclared pass fails, the lint), the relief pass (Jacobi on a 5x5 hand case, erosion never moves
// a pin, determinism), `pad.edge: 'blend'` (N-T1-1: the default only for programs that declare passes) and relief_demo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileIR, evalTile, KINDS_FORMAT2, OP_KINDS, OPS_RESERVED, RELIEF_NONE, staleReason, walkKinds, EVAL_KIT_VERSION } from '../lib/realise.mjs';
import { KIT_VERSION, planRegion } from '../lib/region/plan.mjs';
import { makeColumns, unpack } from '../lib/region/pack.mjs';
import { NONE, pinsOf, relax, reliefPass, ERODE_MAX } from '../lib/region/passes/relief.mjs';
import { PASS_NAMES } from '../lib/region/passes/index.mjs';
import { region } from '../lib/region/program.mjs';
import { synthColumns } from '../lib/region/synth.mjs';

/** The code with comments and string contents removed (region-lint.test.mjs's scan; inlined: importing a test file runs it). */
function codeOnly(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') { let j = i + 1; while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; } out += `${c}${c}`; i = j + 1; continue; }
    out += c; i++;
  }
  return out;
}

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAIM = { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: -64, maxY: 319 };

function flatWindow(key, g) {
  const [tx, tz] = key.split(',').map(Number);
  const c = makeColumns(tx * 64 - 8, tz * 64 - 8, 80, 80, 1);
  c.ground.fill(g); c.height.fill(g); c.floor.fill(g);
  return c;
}
function i16(values) {
  const b = new Uint8Array(values.length * 2);
  values.forEach((v, i) => { const w = v & 0xffff; b[2 * i] = w & 255; b[2 * i + 1] = w >> 8; });
  return b;
}
/** A one-op relief IR over a 4x1 field at x 10..13, z 10 (blob "f" -> sha "aa..") and its blobs getter. */
function reliefIR(values, opExtra = {}, fieldExtra = {}) {
  const sha = 'a'.repeat(64);
  const op = { op: 'relief', field: 'r', mode: 'delta', cut: 0, fill: { rule: { rule: [{ when: { depth: [0, 0] }, mat: 'minecraft:grass_block' }, { when: { depth: [1, 3] }, mat: 'minecraft:dirt' }], default: 'minecraft:stone' } }, maxCut: 6, maxFill: 6, ...opExtra };
  const ir = { format: 2, id: 't', programSha: 'x', kitVersion: KIT_VERSION, node: 'test', params: {}, seed: '1', claim: CLAIM, roles: {}, stages: ['main'],
    parts: [{ id: 'p', stage: 'main', set: 'terrain', ops: [op] }], lots: [], roads: [], paths: [], anchors: {}, rules: {}, budget: { cells: 0, removed: 0, added: 0 },
    tiles: { main: { terrain: ['0,0'], path: [] } }, blobs: { field_r: { sha, bytes: values.length * 2, kind: 'field' } },
    fields: { r: { blob: 'field_r', type: 'i16', minX: 10, minZ: 10, width: values.length, depth: 1, res: 1, ...fieldExtra } } };
  ir.requires = walkKinds(ir);
  return { ir, blobs: { [sha]: i16(values) } };
}
const column = (cells, x, z) => cells.filter((c) => c.x === x && c.z === z).map((c) => [c.y, c.state]).sort((a, b) => a[0] - b[0]);

test('relief is a built op kind and a format-2 kind; the kit and the evaluator agree on 0.20.0', () => {
  assert.ok(OP_KINDS.includes('relief'));
  assert.ok(!OPS_RESERVED.includes('relief'));
  assert.equal(KINDS_FORMAT2[KINDS_FORMAT2.length - 1], 'relief', 'appended at the end (rebase point)');
  assert.equal(KIT_VERSION, '0.20.0');
  assert.equal(EVAL_KIT_VERSION, KIT_VERSION);
  const { ir } = reliefIR([1]);
  assert.deepEqual(ir.requires, ['blobs:side', 'fields', 'material:rule', 'relief']);
  // a kit without the kind refuses the IR PLAN_STALE (the kind and the kit version)
  assert.match(staleReason({ ...ir, kitVersion: '0.20.0' }, '0.18.0'), /plan needs kit 0\.20\.0/);
});

test('the relief op evaluates: fill (g..top by depth), cut (air above top, the skin at top), clamps, NONE, delta 0, target', () => {
  // field x 10..15: +2, -3, 0, NONE, +9 (clamped to +6), -9 (clamped to -6)
  const { ir, blobs } = reliefIR([2, -3, 0, RELIEF_NONE, 9, -9]);
  const e = evalTile(ir, '0,0', flatWindow('0,0', 64), { blobs });
  const cells = unpack(e.payload).cells;
  assert.deepEqual(column(cells, 10, 10), [[64, 'minecraft:dirt'], [65, 'minecraft:dirt'], [66, 'minecraft:grass_block']]);
  assert.deepEqual(column(cells, 11, 10), [[61, 'minecraft:grass_block'], [62, 'minecraft:air'], [63, 'minecraft:air'], [64, 'minecraft:air'], [65, 'minecraft:air'], [66, 'minecraft:air']]);
  assert.deepEqual(column(cells, 12, 10), [], 'delta 0 writes nothing');
  assert.deepEqual(column(cells, 13, 10), [], 'NONE writes nothing');
  assert.equal(column(cells, 14, 10).at(-1)[0], 70, 'fill clamped at maxFill 6');
  assert.equal(column(cells, 14, 10)[0][1], 'minecraft:stone', 'the core below depth 3 is the rule default');
  assert.equal(column(cells, 15, 10)[0][0], 58, 'cut clamped at maxCut 6');
  assert.deepEqual(column(cells, 9, 10), [], 'outside the field: nothing');
  assert.ok(cells.every((c) => c.cond === 0), 'cut is the cells\' condition');
  // target: the field is an absolute y; drift follows the frozen ground (g 64 vs 66 give the same top)
  const t = reliefIR([66, 60], { mode: 'target' });
  for (const g of [64, 66]) {
    const c2 = unpack(evalTile(t.ir, '0,0', flatWindow('0,0', g), { blobs: t.blobs }).payload).cells;
    assert.equal(column(c2, 10, 10).filter(([, s]) => s !== 'minecraft:air').at(-1)[0], 66);
    assert.equal(column(c2, 11, 10).filter(([, s]) => s !== 'minecraft:air').at(-1)[0], 60);
  }
  // delta follows the real surface: frozen ground 70 with dh +2 gives 72
  const c3 = unpack(evalTile(ir, '0,0', flatWindow('0,0', 70), { blobs }).payload).cells;
  assert.equal(column(c3, 10, 10).at(-1)[0], 72);
  // the same bytes in any order and from a fresh compile
  assert.equal(evalTile(JSON.parse(JSON.stringify(ir)), '0,0', flatWindow('0,0', 64), { blobs }).sha, e.sha);
});

test('relief op refusal paths', () => {
  const bad = (opExtra, re, fieldExtra = {}) => { const { ir, blobs } = reliefIR([1], opExtra, fieldExtra); assert.throws(() => compileIR(ir, { blobs }), re); };
  bad({ field: 'nope' }, /relief field 'nope' is not one of the IR's fields/);
  bad({ mode: 'add' }, /relief mode must be delta or target/);
  bad({ cut: 7 }, /relief cut must be a cond 0..3/);
  bad({ maxCut: 65 }, /relief maxCut must be 0..64/);
  bad({ maxFill: -1 }, /relief maxFill must be 0..64/);
  bad({ fill: null }, /relief fill must be a block state or a material rule/);
  bad({ fill: { rule: { rule: [{ when: { wetness: 1 }, mat: 'minecraft:dirt' }] } } }, /unknown rule 'wetness'/);
  bad({}, /relief field 'r' must be i16/, { type: 'u8' });
  const { ir, blobs } = reliefIR([1]);
  assert.throws(() => compileIR({ ...ir, requires: ['blobs:side', 'fields', 'material:rule'] }, { blobs }), /requires misses \[relief\]/);
  const f1 = { ...ir, format: 1 };
  for (const k of ['requires', 'blobs', 'fields']) delete f1[k];
  assert.throws(() => compileIR(f1, { blobs }), /a relief op needs format 2/);
});

test('Jacobi on a 5x5 hand case: a centre pin at 8 over ground 0, band radius 2, one iteration', () => {
  const W = 5, D = 5, n = 25;
  const pin = new Int16Array(n).fill(NONE); pin[12] = 8;
  const z0 = relax({ ground: new Int16Array(n), pin, fixed: new Uint8Array(n), W, D, R: 2, iterations: 0, maxCut: 6, maxFill: 6 });
  // the start: the pin's y fades linearly to the land at R + 1 (1/16 fixed point, rounded): d 1 -> 5, d 2 -> 3
  assert.deepEqual([...z0.h], [3, 3, 3, 3, 3, 3, 5, 5, 5, 3, 3, 5, 8, 5, 3, 3, 5, 5, 5, 3, 3, 3, 3, 3, 3]);
  const z1 = relax({ ground: new Int16Array(n), pin, fixed: new Uint8Array(n), W, D, R: 2, iterations: 1, maxCut: 6, maxFill: 6 });
  // by hand: corner (42+42+42+42+2)/4 = 42 -> 3; (1,0) (42+42+85+42+2)/4 = 53 -> 3; (1,1) (85+42+85+42+2)/4 = 64 -> 4;
  // (2,1) (85+85+128+42+2)/4 = 85 -> 5; the pin stays 8
  assert.deepEqual([...z1.h], [3, 3, 3, 3, 3, 3, 4, 5, 4, 3, 3, 5, 8, 5, 3, 3, 4, 5, 4, 3, 3, 3, 3, 3, 3]);
  assert.equal(z1.band.reduce((a, b) => a + b, 0), 24);
  // the clamp: maxFill 2 holds every band column at 2
  const zc = relax({ ground: new Int16Array(n), pin, fixed: new Uint8Array(n), W, D, R: 2, iterations: 4, maxCut: 6, maxFill: 2 });
  assert.ok([...zc.h].every((v, i) => i === 12 || v <= 2));
  // a fixed column keeps its ground
  const fixed = new Uint8Array(n); fixed[6] = 1;
  assert.equal(relax({ ground: new Int16Array(n), pin, fixed, W, D, R: 2, iterations: 4, maxCut: 6, maxFill: 6 }).h[6], 0);
});

test('erosion never moves a pin and adds at most 4 to a column', () => {
  const W = 40, D = 40, n = W * D;
  const ground = new Int16Array(n);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) ground[x + z * W] = 60 + ((x * 7 + z * 13) % 9) - (x > 20 ? 6 : 0);
  const pin = new Int16Array(n).fill(NONE);
  for (let z = 15; z < 25; z++) for (let x = 15; x < 25; x++) pin[x + z * W] = 66;
  const base = relax({ ground, pin, fixed: new Uint8Array(n), W, D, R: 12, iterations: 48, maxCut: 6, maxFill: 6 });
  const er = relax({ ground, pin, fixed: new Uint8Array(n), W, D, R: 12, iterations: 48, maxCut: 6, maxFill: 6, erode: { thermal: 8, stream: 8, streamAt: 4 } });
  let moved = 0, maxExtra = 0;
  for (let i = 0; i < n; i++) {
    if (pin[i] !== NONE) { assert.equal(er.h[i], 66); continue; }
    const e = Math.abs(er.h[i] - base.h[i]);
    if (e) moved++;
    maxExtra = Math.max(maxExtra, e);
    assert.ok(er.h[i] >= ground[i] - 6 && er.h[i] <= ground[i] + 6, 'the clamps hold after erosion');
  }
  assert.ok(moved > 0, 'erosion did something');
  assert.ok(maxExtra <= ERODE_MAX, `extra ${maxExtra}`);
});

test('the relief pass: pins (lots, corridors), the fields (NONE off the band), the ops, water kept, determinism', () => {
  const c = synthColumns({ minX: 0, minZ: 0, width: 128, depth: 128, resolution: 1, seed: 't1' });
  const lot = { id: 'a', at: [40, 40], size: [12, 10], floorY: c.ground[46 + 45 * 128] + 1, part: 'pads' };
  const cor = { path: [[52, lot.floorY - 1, 45], [90, lot.floorY - 1, 45]], width: 3 };
  const { pin, kind } = pinsOf(c, [lot, cor]);
  assert.equal(pin[39 + 39 * 128], lot.floorY - 1, 'the apron is pinned');
  assert.equal(kind[39 + 39 * 128], 3, 'an apron column');
  assert.equal(kind[45 + 45 * 128], 1, 'a footprint column');
  assert.equal(kind[70 + 45 * 128], 2, 'the corridor is pinned');
  assert.equal(kind[70 + 47 * 128], 0, 'a 3-wide corridor');
  const intent = { around: [lot, cor], radius: 12, maxCut: 6, maxFill: 6, erode: { thermal: 2, stream: 1 }, fill: 'minecraft:dirt' };
  const a = reliefPass(c, [], intent), b = reliefPass(c, [], intent);
  assert.deepEqual(a.ops.map((o) => [o.field, o.mode]), [['relief', 'delta'], ['relief_target', 'target'], ['relief_apron', 'target']]);
  assert.deepEqual(Buffer.from(a.fields.relief.values.buffer), Buffer.from(b.fields.relief.values.buffer), 'deterministic');
  const f = a.fields.relief;
  const at = (x, z) => f.values[(x - f.minX) + (z - f.minZ) * f.width];
  assert.equal(at(45, 45), NONE, 'a pad column is the lot\'s own');
  assert.notEqual(at(30, 45), NONE, 'in the band');
  assert.ok(f.minX >= 40 - 1 - 12 && f.minX <= 40 - 1, 'the field is the band\'s bounding box');
  assert.equal(a.fields.relief_target.values[(70 - f.minX) + (45 - f.minZ) * f.width], lot.floorY - 1);
  const ap = a.fields.relief_apron;
  assert.equal(ap.values[(39 - ap.minX) + (39 - ap.minZ) * ap.width], lot.floorY - 1, 'the apron at the pad\'s top');
  assert.equal(ap.values[(45 - ap.minX) + (45 - ap.minZ) * ap.width], NONE, 'the footprint is the lot\'s own');
  assert.ok(a.data.band > 0 && a.data.pinned > 0);
  assert.throws(() => reliefPass(c, [], { ...intent, around: [] }), /around/);
  assert.throws(() => reliefPass(c, [], { ...intent, radius: 0 }), /radius/);
});

test('passes are declared: an undeclared pass fails the plan; an unknown declared pass fails; blend needs the relief pass', async () => {
  const claim = { minX: 0, minZ: 0, maxX: 127, maxZ: 127, minY: -64, maxY: 319 };
  const survey = synthColumns({ minX: 0, minZ: 0, width: 128, depth: 128, resolution: 1, seed: 't1' });
  const prog = (passes, body) => ({ id: 'p_test', ...(passes ? { passes } : {}), default: (ctx) => { const r = region(ctx); r.stages(['ground', 'lots']); body(r, ctx); r.anchor('entrance', [5, 5]); r.anchor('spawn', [5, 5]); return r; } });
  const plan = (program) => planRegion({ program, programSource: 'x', survey, claim, seed: '7' });
  const lotAt = (r, edge) => r.part('pads', { stage: 'ground' }).lot('a', { at: [40, 40], size: [10, 10], stage: 'lots', pad: { maxCut: 12, maxFill: 12, ...(edge ? { edge } : {}) } });
  await assert.rejects(plan(prog(null, (r) => r.pass('relief', { around: [lotAt(r)] }))), /PASS_UNDECLARED: the program calls pass 'relief'/);
  await assert.rejects(plan(prog(['route'], () => {})), /declares pass 'route', which is not a kit pass/);
  await assert.rejects(plan(prog(['relief', 'relief'], () => {})), /declares a pass twice/);
  // N-T1-1: blend is the default edge of a program with passes, and then needs the pass
  await assert.rejects(plan(prog(['relief'], (r) => lotAt(r))), /lot a: pad.edge 'blend' needs the relief pass/);
  const p = await plan(prog(['relief'], (r) => r.pass('relief', { around: [lotAt(r)] })));
  assert.equal(p.ir.lots[0].pad.edge, 'blend');
  assert.ok(p.ir.requires.includes('relief'));
  assert.ok(p.notes.some((n) => /^pass relief: \d+\.\d s, \d+ MB$/.test(n)), p.notes.join('; '));
  assert.deepEqual(p.passes, ['relief']);
  assert.equal(p.stats.passes[0].name, 'relief');
  assert.equal(p.meta.passes[0].name, 'relief');
  assert.equal(p.ir.parts.find((x) => x.id === 'relief').stage, 'ground', 'the relief ops are in the pads\' stage');
  // a program without passes keeps 6a's slope edge (its IR as before)
  const q = await plan(prog(null, (r) => lotAt(r)));
  assert.equal(q.ir.lots[0].pad.edge, 'slope');
  assert.ok(!q.ir.requires?.includes('relief'));
  // an explicit slope edge in a program with passes needs no pass
  const s = await plan(prog(['relief'], (r) => lotAt(r, 'slope')));
  assert.equal(s.ir.lots[0].pad.edge, 'slope');
  assert.deepEqual(PASS_NAMES, ['relief']);
});

test('relief_demo plans the same IR twice on a synthetic hilly claim; its relief ops read the pads\' frozen ground', async () => {
  const claim = { minX: 512, minZ: 512, maxX: 703, maxZ: 703, minY: -64, maxY: 319 };
  const survey = synthColumns({ minX: 512, minZ: 512, width: 192, depth: 192, resolution: 1, seed: 'relief' });
  const programFile = path.join(KIT, 'regions', 'relief_demo.mjs');
  const a = await planRegion({ programFile, survey, claim, seed: '11' });
  const b = await planRegion({ programFile, survey, claim, seed: '11' });
  assert.equal(a.irSha, b.irSha);
  assert.equal(a.ir.format, 2);
  assert.ok(a.ir.requires.includes('relief'));
  assert.equal(a.ir.lots.length, 3);
  assert.ok(a.ir.lots.every((l) => l.pad.edge === 'blend'));
  const relief = a.ir.parts.find((p) => p.id === 'relief');
  assert.equal(relief.stage, a.ir.parts.find((p) => p.id === 'pads').stage);
});

test('the realise lint covers the passes (kit/lib/region/passes/**): exact Math only, no clock, no Date, no **', () => {
  const dir = path.join(KIT, 'lib', 'region', 'passes');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.includes('relief.mjs'));
  const ALLOWED = new Set(['floor', 'sqrt', 'abs', 'min', 'max', 'imul']);
  const bad = [];
  for (const f of files) {
    const code = codeOnly(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const m of code.matchAll(/\bMath\s*\.\s*([A-Za-z_$][\w$]*)/g)) if (!ALLOWED.has(m[1])) bad.push(`${f}: Math.${m[1]}`);
    if (/\bDate\b/.test(code)) bad.push(`${f}: Date`);
    if (/\*\*/.test(code)) bad.push(`${f}: **`);
    if (/\bMath\s*\[/.test(code)) bad.push(`${f}: computed Math member`);
    if (/\bperformance\b|\bprocess\b/.test(code)) bad.push(`${f}: clock or process`);
    for (const m of code.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)) if (!m[1].startsWith('.')) bad.push(`${f}: imports ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});
