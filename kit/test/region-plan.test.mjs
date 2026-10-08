// Phase 6a: the program model and the plan (docs/CONTRACT.md §1 "Where programs run", "Seeds and determinism",
// "Limits"): the sandbox rules (Math.random throws, Date.now is 0), validation errors, limits, seeds, the exact budget,
// the IR's identity (3 plan runs in 3 processes give the same bytes), the CLI's exit codes, and mega_bench / region_small
// on synthetic, flat and unexplored land.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { region } from '../lib/region/program.mjs';
import { defaultSeed, planRegion } from '../lib/region/plan.mjs';
import { windowFromSurvey } from '../lib/region/survey.mjs';
import { evalTile } from '../lib/realise.mjs';
import { canonicalJson, encodeColumns, makeColumns, sha256Hex } from '../lib/region/pack.mjs';
import { synthSurvey } from '../lib/region/synth.mjs';
import { planInline, worldOf } from './region-helpers.mjs';

const run = promisify(execFile);
const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(KIT, 'tools', 'region.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kit-region-'));
const anchors = (r, c) => { r.anchor('spawn', [c.minX + 2, c.minZ + 2]); r.anchor('entrance', [c.minX + 3, c.minZ + 2]); };

test('the sandbox: Math.random throws "use ctx.rng", Date.now is 0, ctx.rng is seeded and deterministic', async () => {
  await assert.rejects(planInline((ctx) => { Math.random(); return region(ctx); }), /use ctx.rng/);
  let now, a, b, c;
  await planInline((ctx) => {
    now = Date.now();
    a = [ctx.rng('x')(), ctx.rng('x')(), ctx.rng('y')()];
    b = ctx.rng('x').int(1, 6); c = ctx.seed;
    const r = region(ctx); anchors(r, ctx.claim); return r;
  });
  assert.equal(now, 0);
  assert.notEqual(Date.now(), 0, 'restored after the run');
  assert.equal(typeof Math.random(), 'number', 'restored after the run');
  assert.equal(a[0], a[1]); assert.notEqual(a[0], a[2]);
  assert.ok(b >= 1 && b <= 6); assert.equal(c, '42');
});

test('validation: anchors required, unique part ids, declared stages, lots inside, the result must be a Region', async () => {
  await assert.rejects(planInline((ctx) => region(ctx)), /anchor 'entrance'/);
  await assert.rejects(planInline((ctx) => { const r = region(ctx); r.part('a'); r.part('a'); return r; }), /used twice/);
  await assert.rejects(planInline((ctx) => { const r = region(ctx); r.stages(['one']); r.part('a', { stage: 'two' }); return r; }), /stage 'two' is not declared/);
  await assert.rejects(planInline((ctx) => { const r = region(ctx); r.part('Bad'); return r; }), /must match/);
  await assert.rejects(planInline(() => ({ parts: [] })), /did not return a Region/);
  await assert.rejects(planInline((ctx) => { const r = region(ctx); r.anchor('spawn', [5000, 5]); return r; }), /outside the claim/);
  await assert.rejects(planInline((ctx) => { const r = region(ctx); r.part('a').fill({ kind: 'box', min: [0, 0, 0], max: [1, 1, 1] }, 'nonsense_block'); return r; }), /neither a role/);
  await assert.rejects(planInline((ctx) => { const r = region(ctx); r.part('a').stair([[0, 70, 0], [10, 70, 0]]); return r; }), /needs a path part/);
});

test('limits: claim size, cell budget; roles resolve with fallbacks', async () => {
  await assert.rejects(planInline((ctx) => region(ctx), { claim: { minX: 0, minZ: 0, maxX: 1100, maxZ: 10, minY: -64, maxY: 319 } }), /REGION_LIMIT: the claim is 1101x11/);
  await assert.rejects(planInline((ctx) => {
    const r = region(ctx); anchors(r, ctx.claim); r.budget(1000);
    r.part('a').fill({ kind: 'box', min: [0, 60, 0], max: [40, 80, 40] }, 'structure');
    return r;
  }, { world: worldOf({ flat: 64 }) }), /writes 35301 cells, over its budget of 1000/);
  let scorched;
  const { ir } = await planInline((ctx) => {
    scorched = ctx.roles.scorched ?? ctx.roles.rock;
    const r = region(ctx); anchors(r, ctx.claim); return r;
  });
  assert.equal(scorched, 'minecraft:stone');
  for (const k of ['rock', 'surface', 'subsurface', 'rubble', 'rail', 'structure', 'wall', 'foundation', 'path']) assert.ok(ir.roles[k], k);
});

test('seeds: decimal strings; the default is fnv64(programId, canonical(params), claim)', async () => {
  const claim = { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: -64, maxY: 319 };
  const { ir } = await planInline((ctx) => { const r = region(ctx); anchors(r, ctx.claim); return r; }, { claim, seed: null, id: 'seedy' });
  assert.equal(ir.seed, defaultSeed('seedy', {}, claim));
  assert.match(ir.seed, /^\d+$/);
  const big = await planInline((ctx) => { const r = region(ctx); anchors(r, ctx.claim); return r; }, { claim, seed: '18446744073709551615' });
  assert.equal(big.ir.seed, '18446744073709551615');
});

test('the budget is the exact count: the sum of evalTile over every tile of every change-set on the survey', async () => {
  const c2 = { minX: -100, minZ: 40, maxX: 155, maxZ: 295, minY: -64, maxY: 319 };
  const s2 = synthSurvey(c2, 'budget');
  const p = await planRegion({ programFile: path.join(KIT, 'regions', 'region_small.mjs'), survey: s2, claim: c2, node: 'test' });
  let n = 0, rem = 0, add = 0;
  for (const st of p.ir.stages) for (const set of ['terrain', 'path']) for (const key of p.ir.tiles[st][set]) {
    const e = evalTile(p.ir, key, windowFromSurvey(s2, key), { stage: st, set });
    n += e.count; rem += e.removed; add += e.added;
  }
  assert.deepEqual(p.ir.budget, { cells: n, removed: rem, added: add });
  assert.ok(n > 10000);
  assert.equal(sha256Hex(p.irJson), p.irSha);
  assert.equal(canonicalJson(JSON.parse(p.irJson)), p.irJson, 'ir.json is canonical');
});

test('the CLI: plan writes ir.json (its sha is irSha) and plan.json; exit codes 0 / 1 / 2; eval matches evalTile', async () => {
  const dir = tmp();
  const claim = '0,0,199,199,-64,319';
  const c = { minX: 0, minZ: 0, maxX: 199, maxZ: 199, minY: -64, maxY: 319 };
  fs.writeFileSync(path.join(dir, 'survey.bin'), encodeColumns(synthSurvey(c, 'cli')));
  fs.writeFileSync(path.join(dir, 'params.json'), '{"bowl":true}');
  fs.writeFileSync(path.join(dir, 'bible.json'), JSON.stringify({ id: 'x', version: 1, roles: { rubble: 'mossy_cobblestone' } }));
  const out = path.join(dir, 'plan');
  const r = await run(process.execPath, [CLI, 'plan', path.join(KIT, 'regions', 'region_small.mjs'), '--params', path.join(dir, 'params.json'), '--survey', path.join(dir, 'survey.bin'), '--claim', claim, '--bible', path.join(dir, 'bible.json'), '--out', out, '--json']);
  const j = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(j.ok, true);
  const irText = fs.readFileSync(path.join(out, 'ir.json'), 'utf8');
  assert.equal(sha256Hex(irText), j.irSha);
  const ir = JSON.parse(irText);
  assert.equal(ir.roles.rubble, 'minecraft:mossy_cobblestone');
  assert.ok(JSON.parse(fs.readFileSync(path.join(out, 'plan.json'), 'utf8')).ok);
  // eval
  const key = ir.tiles.ground.terrain[0];
  const [tx, tz] = key.split(',').map(Number);
  const win = synthSurvey({ minX: tx * 64 - 8, minZ: tz * 64 - 8, maxX: tx * 64 + 71, maxZ: tz * 64 + 71 }, 'cli');
  fs.writeFileSync(path.join(dir, 'h.bin'), encodeColumns(win));
  const e = await run(process.execPath, [CLI, 'eval', path.join(out, 'ir.json'), '--tile', key, '--heights', path.join(dir, 'h.bin'), '--stage', 'ground', '--set', 'terrain', '--json', '--out', path.join(dir, 't.artl')]);
  const ej = JSON.parse(e.stdout.trim().split('\n').pop());
  const direct = evalTile(ir, key, win, { stage: 'ground', set: 'terrain' });
  assert.equal(ej.sha, direct.sha); assert.equal(ej.count, direct.count);
  assert.equal(sha256Hex(fs.readFileSync(path.join(dir, 't.artl'))), direct.sha);
  // usage (2) and failure (1)
  const bad = await run(process.execPath, [CLI, 'plan', '--json']).catch((x) => x);
  assert.equal(bad.code, 2); assert.match(JSON.parse(bad.stdout.trim()).error, /usage/);
  fs.writeFileSync(path.join(dir, 'boom.mjs'), "export const id = 'boom'; export default () => { throw new Error('kaboom'); };\n");
  const fail = await run(process.execPath, [CLI, 'plan', path.join(dir, 'boom.mjs'), '--survey', path.join(dir, 'survey.bin'), '--claim', claim, '--json']).catch((x) => x);
  assert.equal(fail.code, 1);
  assert.deepEqual(JSON.parse(fail.stdout.trim()), { ok: false, error: 'kaboom' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mega_bench: 3 plan runs in 3 processes give byte-identical IRs; about 10M cells; 200 lots, 50 per lots stage', async () => {
  const dir = tmp();
  const claim = { minX: -500, minZ: -500, maxX: 499, maxZ: 499, minY: -64, maxY: 319 };
  fs.writeFileSync(path.join(dir, 'survey.bin'), encodeColumns(synthSurvey(claim, 'determinism')));
  const args = (o) => [CLI, 'plan', path.join(KIT, 'regions', 'mega_bench.mjs'), '--survey', path.join(dir, 'survey.bin'), '--claim', '-500,-500,499,499,-64,319', '--out', path.join(dir, o), '--json'];
  const runs = await Promise.all(['a', 'b', 'c'].map((o) => run(process.execPath, args(o))));
  const shas = runs.map((r) => JSON.parse(r.stdout.trim().split('\n').pop()).irSha);
  assert.equal(new Set(shas).size, 1, shas.join(' '));
  const bytes = ['a', 'b', 'c'].map((o) => fs.readFileSync(path.join(dir, o, 'ir.json'), 'utf8'));
  assert.ok(bytes[0] === bytes[1] && bytes[1] === bytes[2]);
  const ir = JSON.parse(bytes[0]);
  assert.ok(ir.budget.cells > 7e6 && ir.budget.cells < 13e6, `about 10M cells (${ir.budget.cells})`);
  assert.equal(ir.lots.length, 200);
  for (const s of ['lots-1', 'lots-2', 'lots-3', 'lots-4']) assert.equal(ir.lots.filter((l) => l.stage === s).length, 50, s);
  assert.deepEqual(ir.stages, ['ground', 'ways', 'lots-1', 'lots-2', 'lots-3', 'lots-4']);
  for (const s of ['lots-1', 'lots-2', 'lots-3', 'lots-4']) assert.deepEqual(ir.tiles[s], { terrain: [], path: [] }, 'lots stages carry no ops');
  assert.equal(ir.paths.filter((p) => p.kind === 'bridge').length, 4);
  assert.ok(ir.paths.some((p) => p.kind === 'stair'));
  assert.equal(ir.parts.filter((p) => /^hill_\d$/.test(p.id)).length, 3);
  for (const l of ir.lots) {
    assert.ok(l.size[0] >= 9 && l.size[0] <= 24 && l.size[1] >= 9 && l.size[1] <= 24, `${l.id} size`);
    assert.ok(l.max[1] >= 6 && l.max[1] <= 14, `${l.id} height`);
    assert.ok(ir.parts.find((p) => p.id === l.part && p.stage === 'ground'), `${l.id} pad part`);
  }
  assert.ok(ir.anchors.entrance && ir.anchors.spawn);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mega_bench and region_small plan on flat, half-unexplored and unexplored land', async () => {
  const claim = { minX: 0, minZ: 0, maxX: 999, maxZ: 999, minY: -64, maxY: 319 };
  const flat = makeColumns(0, 0, 250, 250, 4); flat.ground.fill(-61); flat.height.fill(-61); flat.floor.fill(-61);
  const none = makeColumns(0, 0, 250, 250, 4); none.flags.fill(2);
  const half = synthSurvey(claim, 'half');
  for (let i = 0; i < half.flags.length; i++) if (i % 250 > 125) { half.flags[i] = 2; half.ground[i] = 0; half.height[i] = 0; half.floor[i] = 0; }
  for (const [name, survey] of [['flat', flat], ['none', none], ['half', half]]) {
    const p = await planRegion({ programFile: path.join(KIT, 'regions', 'mega_bench.mjs'), survey, claim, node: 'test' });
    assert.equal(p.ir.lots.length, 200, name);
    assert.ok(p.ir.budget.cells > 5e6, `${name}: ${p.ir.budget.cells}`);
    assert.ok(p.ir.claim.minY >= -64 && p.ir.claim.maxY <= 319);
    const c2 = { minX: 0, minZ: 0, maxX: 127, maxZ: 127, minY: -64, maxY: 319 };
    const s2 = makeColumns(0, 0, 128, 128, 1);
    if (name === 'flat') { s2.ground.fill(-61); s2.height.fill(-61); s2.floor.fill(-61); } else if (name === 'none') s2.flags.fill(2); else s2.ground.fill(70), s2.height.fill(70), s2.floor.fill(70);
    for (const bowl of [true, false]) {
      const q = await planRegion({ programFile: path.join(KIT, 'regions', 'region_small.mjs'), survey: s2, claim: c2, params: { bowl }, node: 'test' });
      assert.equal(q.ir.lots.length, 3, `${name} small`);
      assert.deepEqual(q.ir.stages, ['ground', 'ways', 'lots-1']);
      assert.ok(q.ir.paths.some((x) => x.kind === 'bridge') && q.ir.paths.some((x) => x.kind === 'stair'));
    }
  }
});
