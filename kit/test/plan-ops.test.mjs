// Phase 6c slice P0 gate item 10 (docs/CONTRACT.md P0 §6 "A shipped op's semantics never change"): kit/test/fixtures/ops/ holds one
// frozen IR per op kind and member family, with its tile shas, and every later kit evaluates them to the same tiles (macOS and
// Linux CI). A moved sha fails the build. A newer kit may plan differently; it never evaluates an older IR differently.
// The IRs are cut from the committed scenario goldens (their survey is the golden's, named in each fixture's source.json) and, for
// `stamp`, planned once over a synthetic claim with a synthetic stamp. Regenerate only when adding a family:
//   UPDATE_OPS_GOLDENS=1 node --test kit/test/plan-ops.test.mjs   (an existing family's tiles.json must never be rewritten)
// The negative control changes one op member and asserts a tile sha moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evalTile, walkKinds } from '../lib/realise.mjs';
import { windowFromSurvey } from '../lib/region/survey.mjs';
import { FLAG_MISSING, canonicalJson, encodeColumns, makeColumns, sha256Hex } from '../lib/region/pack.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { region } from '../lib/region/program.mjs';
import { stamp } from '../lib/region/scatterPlan.mjs';
import { syntheticStamp } from '../lib/region/stamps.mjs';
import { ROOT, KIT } from './plan-helpers.mjs';

const OPS = path.join(KIT, 'test', 'fixtures', 'ops');
const UPDATE = process.env.UPDATE_OPS_GOLDENS === '1';

/** Each family: the golden it is cut from and the ops it keeps. */
const FAMILIES = [
  { id: 'shape', from: 's7', keep: (o) => o.op === 'shape' && !o.mask && !(o.material && typeof o.material === 'object') },
  { id: 'shape_rule', from: 's1', keep: (o) => o.op === 'shape' && o.material && typeof o.material === 'object' },
  { id: 'shape_mask', from: 'crater_toolbox', keep: (o) => o.op === 'shape' && o.mask !== undefined },
  { id: 'columns', from: 's7', keep: (o) => o.op === 'columns' },
  { id: 'columns_route', from: 'route_demo', keep: (o) => o.op === 'columns' },
  { id: 'voxels', from: 'forms_demo', keep: (o) => o.op === 'voxels' },
  { id: 'relief', from: 'relief_demo', keep: (o) => o.op === 'relief' },
  { id: 'scatter', from: 'scatter_demo', keep: (o) => o.op === 'scatter' },
];

const tileOf = (v) => Math.floor(v / 64);
/** The IR cut to the ops `keep` selects (parts without one dropped), its tiles and kinds recomputed. */
function cut(ir, keep) {
  const parts = ir.parts.map((p) => ({ ...p, ops: p.ops.filter(keep) })).filter((p) => p.ops.length);
  const tiles = {};
  for (const s of ir.stages) tiles[s] = { terrain: new Set(), path: new Set() };
  for (const p of parts) for (const op of p.ops) {
    const b = op.bounds;
    for (let tx = tileOf(Math.max(b.minX, ir.claim.minX)); tx <= tileOf(Math.min(b.maxX, ir.claim.maxX)); tx++) for (let tz = tileOf(Math.max(b.minZ, ir.claim.minZ)); tz <= tileOf(Math.min(b.maxZ, ir.claim.maxZ)); tz++) tiles[p.stage][p.set].add(`${tx},${tz}`);
  }
  const sorted = (set) => [...set].sort((a, b) => { const [ax, az] = a.split(',').map(Number), [bx, bz] = b.split(',').map(Number); return ax - bx || az - bz; });
  const out = { ...ir, parts, lots: [], roads: [], paths: [], tiles: Object.fromEntries(ir.stages.map((s) => [s, { terrain: sorted(tiles[s].terrain), path: sorted(tiles[s].path) }])) };
  delete out.forms; delete out.graph; delete out.utility; delete out.floating;
  const kinds = walkKinds(out);
  if (kinds.length) { out.format = 2; out.requires = kinds; } else { out.format = 1; delete out.requires; }
  return out;
}

/** Every tile's sha of an IR over a survey: {"stage|set|key": sha}. */
function shasOf(ir, survey, blobDir) {
  const blobs = (sha) => { const f = path.join(blobDir, `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const out = {};
  for (const s of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles?.[s]?.[set] ?? []) {
    const w = windowFromSurvey(survey, key);
    w.flags.forEach((f, i) => { w.flags[i] = f & ~FLAG_MISSING; });
    out[`${s}|${set}|${key}`] = evalTile(ir, key, w, { stage: s, set, blobs }).sha;
  }
  return out;
}

const goldenDir = (g) => path.join(ROOT, 'scenarios', 'goldens', g);

/** The stamp family: one synthetic stamp on a 64x64 flat claim (planned once, then frozen like the rest). */
async function stampIr() {
  const c = makeColumns(0, 0, 64, 64, 1);
  c.ground.fill(64); c.height.fill(64); c.floor.fill(64);
  const survey = encodeColumns(c);
  const lib = new Map([['oak/1', syntheticStamp('tree', 1)]]);
  const prog = { id: 'ops_stamp', default: (ctx) => { const r = region(ctx); r.stages(['main']); stamp(r, 'oak/1', [32, 65, 32], { rotation: 90, stage: 'main' }); r.anchor('entrance', [8, 8]); r.anchor('spawn', [8, 8]); return r; } };
  const res = await planRegion({ program: prog, programSource: 'ops_stamp', survey, claim: { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: -64, maxY: 319 }, stamps: lib, kitVersion: '0.25.0', node: 'golden', seed: '7' });
  return { ir: res.ir, survey, blobs: res.blobs };
}

if (UPDATE) {
  test('UPDATE_OPS_GOLDENS: write the missing families (never rewrite one)', async () => {
    fs.mkdirSync(OPS, { recursive: true });
    for (const f of FAMILIES) {
      const dir = path.join(OPS, f.id);
      if (fs.existsSync(path.join(dir, 'tiles.json'))) continue;
      const g = goldenDir(f.from);
      const ir = cut(JSON.parse(fs.readFileSync(path.join(g, 'ir.json'), 'utf8')), f.keep);
      fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
      for (const b of Object.values(ir.blobs ?? {})) if (b.sha) fs.copyFileSync(path.join(g, 'blobs', `${b.sha}.bin`), path.join(dir, 'blobs', `${b.sha}.bin`));
      fs.writeFileSync(path.join(dir, 'ir.json'), canonicalJson(ir));
      fs.writeFileSync(path.join(dir, 'source.json'), `${JSON.stringify({ family: f.id, cutFrom: `scenarios/goldens/${f.from}/ir.json`, survey: `scenarios/goldens/${f.from}/survey.bin` }, null, 2)}\n`);
      const tiles = shasOf(ir, fs.readFileSync(path.join(g, 'survey.bin')), path.join(dir, 'blobs'));
      fs.writeFileSync(path.join(dir, 'tiles.json'), `${JSON.stringify({ irSha: sha256Hex(canonicalJson(ir)), tiles }, null, 1)}\n`);
    }
    const dir = path.join(OPS, 'stamp');
    if (!fs.existsSync(path.join(dir, 'tiles.json'))) {
      const s = await stampIr();
      fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
      for (const [sha, b] of s.blobs) fs.writeFileSync(path.join(dir, 'blobs', `${sha}.bin`), b);
      fs.writeFileSync(path.join(dir, 'ir.json'), canonicalJson(s.ir));
      fs.writeFileSync(path.join(dir, 'survey.bin'), s.survey);
      fs.writeFileSync(path.join(dir, 'source.json'), `${JSON.stringify({ family: 'stamp', planned: 'a synthetic stamp (oak/1, tree seed 1) turned 90 on a 64x64 flat claim', survey: 'kit/test/fixtures/ops/stamp/survey.bin' }, null, 2)}\n`);
      fs.writeFileSync(path.join(dir, 'tiles.json'), `${JSON.stringify({ irSha: sha256Hex(canonicalJson(s.ir)), tiles: shasOf(s.ir, s.survey, path.join(dir, 'blobs')) }, null, 1)}\n`);
    }
  });
}

const fams = () => (fs.existsSync(OPS) ? fs.readdirSync(OPS).filter((d) => fs.existsSync(path.join(OPS, d, 'tiles.json'))).sort() : []);
const surveyOf = (dir) => { const s = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8')).survey; return fs.readFileSync(path.join(ROOT, s)); };

test('item 10: every op kind and member family has a frozen IR (shape, shape:rule, shape:mask, columns, voxels, relief, scatter, stamp)', () => {
  const have = fams();
  for (const f of [...FAMILIES.map((x) => x.id), 'stamp']) assert.ok(have.includes(f), `fixtures/ops/${f}`);
  const kinds = new Set(have.flatMap((d) => JSON.parse(fs.readFileSync(path.join(OPS, d, 'ir.json'), 'utf8')).parts.flatMap((p) => p.ops.map((o) => o.op))));
  for (const k of ['shape', 'columns', 'voxels', 'relief', 'scatter', 'stamp']) assert.ok(kinds.has(k), `op kind ${k}`);
});

for (const d of fams()) {
  test(`item 10: fixtures/ops/${d} evaluates to its frozen tile shas`, () => {
    const dir = path.join(OPS, d);
    const irText = fs.readFileSync(path.join(dir, 'ir.json'), 'utf8');
    const want = JSON.parse(fs.readFileSync(path.join(dir, 'tiles.json'), 'utf8'));
    assert.equal(sha256Hex(irText), want.irSha, 'the frozen IR is unchanged');
    const got = shasOf(JSON.parse(irText), surveyOf(dir), path.join(dir, 'blobs'));
    assert.deepEqual(got, want.tiles);
  });
}

test('item 10 (negative control): a changed op member moves a tile sha', () => {
  const dir = path.join(OPS, 'columns');
  const ir = JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8'));
  const want = JSON.parse(fs.readFileSync(path.join(dir, 'tiles.json'), 'utf8')).tiles;
  // every columns op's solid materials swapped (what a changed member meaning would do)
  for (const op of ir.parts.flatMap((p) => p.ops)) if (op.op === 'columns') op.materials = op.materials.map((m) => (m ? 'minecraft:diamond_block' : m));
  const got = shasOf(ir, surveyOf(dir), path.join(dir, 'blobs'));
  assert.ok(Object.keys(want).some((k) => got[k] !== want[k]), 'a moved sha fails the build');
  const r = JSON.parse(fs.readFileSync(path.join(OPS, 'relief', 'ir.json'), 'utf8'));
  const rop = r.parts.flatMap((p) => p.ops).find((o) => o.op === 'relief');
  rop.maxCut = Math.max(0, (rop.maxCut ?? 6) - 3);
  const rw = JSON.parse(fs.readFileSync(path.join(OPS, 'relief', 'tiles.json'), 'utf8')).tiles;
  const rg = shasOf(r, surveyOf(path.join(OPS, 'relief')), path.join(OPS, 'relief', 'blobs'));
  assert.ok(Object.keys(rw).some((k) => rg[k] !== rw[k]), 'relief maxCut changed: a sha moves');
});
