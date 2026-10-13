// Phase 6c slice F2 (docs/CONTRACT.md "Phase 6c slice F2: scatter and feature stamps" §5), the kit half of the gate:
//   1 tile independence: scatter_demo's tiles equal for 1 and 4 workers, forward and shuffled; a tile evaluated over a wider window
//     (96x96) gives the same cells as over its own 80x80 (a placement reads only the frozen columns within 8 of what it writes: K2);
//   2 density: over 50 seeds, the fired share per density band within 3 points of the density;
//   3 supports (property, 60 seeded claims): 0 floating scatter cells (the checker's M3), plants only on SOIL, no item cell on a walk
//     column, in a lot box or its apron, or in keep-out; snow layers never where a planned light melts them;
//   5 stamps: realised cells equal the stamp's cells, turned, plus the skirt (at most 6) under its base columns; 4 turns are the
//     identity on every state;
//   7 determinism: scatter_demo's IR byte-identical over 3 plans; the committed kit golden (synthetic stamps: no vanilla data in
//     the repo, N-F2-1);
//  10 the op kinds, appended after relief; a kit without them refuses the IR PLAN_STALE;
// plus anchors on walls and ceilings (a synthetic cave volume), the lantern's melt clearing, the missing-stamp fallback.
// Regenerate the golden (only on purpose): UPDATE_GOLDEN=1 node --test kit/test/scatter-f2.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { compileIR, evalTile, KINDS_FORMAT2, OP_KINDS, OPS_RESERVED, semverCompare, staleReason, walkKinds } from '../lib/realise.mjs';
import { KIT_VERSION, planRegion } from '../lib/region/plan.mjs';
import { region } from '../lib/region/program.mjs';
import { makeColumns, unpack, FLAG_TREE, FLAG_WATER } from '../lib/region/pack.mjs';
import { synthSurvey, synthTileWindow, synthWorld, synthColumns } from '../lib/region/synth.mjs';
import { encodeArvx, decodeArvx, VC } from '../lib/region/volume.mjs';
import { gridDraw, scatterKey, SCATTER_MAX_RADIUS, SKIRT_MAX } from '../lib/region/scatter.mjs';
import { scatter, stamp } from '../lib/region/scatterPlan.mjs';
import { decodeStamp, stampLibrary, syntheticStamp } from '../lib/region/stamps.mjs';
import { turnState, turnXZ, voxelAt } from '../lib/region/voxels.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { buildVirtual, F_WALK } from '../lib/region/vworld.mjs';
import { hasTag } from '../lib/blocks.mjs';
import { prng } from './region-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, '..');
const FIX = path.join(HERE, 'fixtures');
const WORKER = path.join(FIX, 'regions', 'eval-worker.mjs');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const SEED = 'golden';

/** A frozen volume over `box` from a synthetic world: rock under 3 of soil to the ground, water to the water's top, logs up a tree. */
function synthVolume(box, world) {
  const W = box.maxX - box.minX + 1, H = box.maxY - box.minY + 1, D = box.maxZ - box.minZ + 1;
  const cl = new Uint8Array(W * H * D);
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
    const v = world(box.minX + x, box.minZ + z);
    for (let y = 0; y < H; y++) {
      const Y = box.minY + y;
      let c = VC.AIR;
      if (v.flags & FLAG_WATER) c = Y <= v.f ? (Y < v.f - 3 ? VC.ROCK : VC.SOIL) : Y <= v.g ? VC.WATER : VC.AIR;
      else if (Y < v.g - 3) c = VC.ROCK;
      else if (Y <= v.g) c = VC.SOIL;
      else if (v.flags & FLAG_TREE && Y <= v.h) c = VC.LOG;
      cl[(x * D + z) * H + y] = c;
    }
  }
  const bytes = encodeArvx(box, cl);
  const decoded = decodeArvx(bytes);
  return { sha: decoded.sha, box, bytes, decoded };
}

/** Synthetic stamps under the library's ids (no vanilla data in the repo, N-F2-1). */
export function synthLibrary() {
  const m = new Map();
  ['oak/1', 'birch/1', 'spruce/1', 'acacia/1', 'dark_oak/1', 'spruce/2', 'oak/2'].forEach((k, i) => m.set(k, syntheticStamp('tree', i + 1)));
  m.set('huge_brown_mushroom/1', syntheticStamp('mushroom', 1));
  m.set('huge_red_mushroom/1', syntheticStamp('mushroom', 2));
  m.set('fossil_coal/1', syntheticStamp('mushroom', 3));
  m.set('dripstone_cluster/1', syntheticStamp('cluster', 1));
  m.set('dripstone_cluster/2', syntheticStamp('cluster', 2));
  return m;
}

/** Plan a program twice (the two-plan flow): the second plan gets the volumes the first asked for, from `world`. */
async function plan2(o, world) {
  const first = await planRegion(o);
  const volumes = first.needVolumes.map((b) => synthVolume(b, world));
  const p = await planRegion({ ...o, volumes });
  return { ...p, volumes };
}

const claimOf = (n, x0 = 0, z0 = 0) => ({ minX: x0, minZ: z0, maxX: x0 + n - 1, maxZ: z0 + n - 1, minY: -64, maxY: 319 });
const demo = (params = {}, stamps = synthLibrary()) => {
  const claim = claimOf(192);
  return plan2({ programFile: path.join(KIT, 'regions', 'scatter_demo.mjs'), survey: synthSurvey(claim, SEED), claim, params, stamps, node: 'golden', kitVersion: '0.22.0', seed: '42' }, synthWorld(SEED));
};

function evalIn(irJson, jobs, blobs) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { irJson, seed: SEED, jobs, blobs } });
    w.once('message', (m) => { resolve(m); void w.terminate(); });
    w.once('error', reject);
  });
}

// ------------------------------------------------------------------ 10: kinds and versions

test('item 10: scatter and stamp are built op kinds, appended after relief; an older kit refuses them PLAN_STALE', async () => {
  assert.ok(OP_KINDS.includes('scatter') && OP_KINDS.includes('stamp'));
  assert.deepEqual(OPS_RESERVED, []);
  const ri = KINDS_FORMAT2.indexOf('relief');
  assert.equal(KINDS_FORMAT2.indexOf('scatter'), ri + 1, 'appended after relief (rebase point)');
  assert.equal(KINDS_FORMAT2.indexOf('stamp'), ri + 2);
  assert.ok(semverCompare(KIT_VERSION, '0.21.0') >= 0);
  const p = await demo();
  assert.ok(p.ir.requires.includes('scatter') && p.ir.requires.includes('stamp'), p.ir.requires.join(','));
  assert.equal(staleReason(p.ir), null);
  // an older kit names the kit version (the gate's stale step runs v0.21.0's own code for the kinds)
  assert.match(staleReason(p.ir, '0.20.0'), new RegExp(`plan needs kit ${p.ir.kitVersion.replaceAll('.', '\\.')}`));
});

// ------------------------------------------------------------------ 2: density

test('item 2: over 50 seeds, the fired share per density band is within 3 points of the density', () => {
  for (const d of [0.05, 0.2, 0.35, 0.5, 0.75, 0.95]) {
    let fired = 0, n = 0;
    const p = Math.floor(d * 65536);
    for (let s = 0; s < 50; s++) {
      const key = scatterKey(String(1000 + s), 'band');
      for (let gx = -10; gx < 10; gx++) for (let gz = -10; gz < 10; gz++) { n++; if (gridDraw(key, 7, 2, gx, gz, 1).fire < p) fired++; }
    }
    assert.ok(Math.abs(fired / n - d) <= 0.03, `density ${d}: fired ${(fired / n).toFixed(4)} of ${n}`);
  }
  // the item draw follows the weights too (3:1)
  let a = 0, n = 0;
  for (let s = 0; s < 50; s++) { const key = scatterKey(String(s), 'w'); for (let g = 0; g < 400; g++) { n++; if (gridDraw(key, 6, 1, g, s, 4).pick < 3) a++; } }
  assert.ok(Math.abs(a / n - 0.75) <= 0.03, `weights 3:1 -> ${(a / n).toFixed(3)}`);
});

// ------------------------------------------------------------------ 1 and 7: tile independence, determinism, the golden

test('items 1 and 7: scatter_demo is byte-identical over 3 plans; tiles equal for 1 and 4 workers, forward and shuffled; the golden', async () => {
  const a = await demo(), b = await demo(), c = await demo();
  assert.equal(a.irJson, b.irJson);
  assert.equal(a.irJson, c.irJson);
  const meta = a.meta.scatterDemo;
  assert.equal(meta.stamps.length, 8, `every surface stamp and the fossil placed: ${JSON.stringify(meta.missing)}`);
  assert.ok(meta.path && meta.lot, 'a path and a lot');
  const blobs = Object.fromEntries([...a.blobs].map(([sha, bytes]) => [sha, bytes]));
  const jobs = [];
  for (const stage of a.ir.stages) for (const set of ['terrain', 'path']) for (const key of a.ir.tiles[stage][set]) jobs.push({ key, stage, set });
  const one = await evalIn(a.irJson, jobs, blobs);
  const order = [...jobs];
  let s = 7;
  for (let i = order.length - 1; i > 0; i--) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const j = s % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  const four = (await Promise.all([0, 1, 2, 3].map((k) => evalIn(a.irJson, order.filter((_, i) => i % 4 === k), blobs)))).flat();
  const tag = (r) => `${r.stage}|${r.set}|${r.key}`;
  const m1 = Object.fromEntries(one.map((r) => [tag(r), r.sha])), m4 = Object.fromEntries(four.map((r) => [tag(r), r.sha]));
  assert.deepEqual(m4, m1);
  // K2: a wider window (96x96: 16 past the tile) gives the same cells as the tile's own 80x80
  const world = synthWorld(SEED);
  const getBlob = (sha) => a.blobs.get(sha);
  for (const { key, stage, set } of jobs) {
    const [tx, tz] = key.split(',').map(Number);
    const wide = synthColumns({ minX: tx * 64 - 16, minZ: tz * 64 - 16, width: 96, depth: 96, resolution: 1, world });
    const e1 = evalTile(a.ir, key, synthTileWindow(key, SEED), { stage, set, blobs: getBlob }), e2 = evalTile(a.ir, key, wide, { stage, set, blobs: getBlob });
    assert.equal(e2.sha, e1.sha, `tile ${stage}|${set}|${key}: the wider window changes nothing`);
  }
  const now = { irSha: a.irSha, cells: one.reduce((n, r) => n + r.count, 0), tiles: Object.fromEntries(Object.keys(m1).sort().map((k) => [k, m1[k]])) };
  const file = path.join(FIX, 'regions', 'scatter-demo.golden.json');
  if (UPDATE) fs.writeFileSync(file, `${JSON.stringify({ note: 'scatter_demo over synthSurvey(192, "golden") with a synthetic volume and SYNTHETIC stamps (lib/region/stamps.mjs syntheticStamp: no vanilla data, N-F2-1), seed 42, node "golden", kit 0.22.0; tiles: stage|set|key -> sha256 of the ARTL payload (macOS and Linux CI)', ...now }, null, 1)}\n`);
  const g = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(now.irSha, g.irSha, 'IR sha');
  assert.deepEqual(now.tiles, g.tiles, 'tile shas');
});

// ------------------------------------------------------------------ 3: supports (property)

test('item 3: 60 seeded claims: 0 floating scatter cells, plants on SOIL only, nothing on walk columns, lot boxes or keep-out; no snow layer in a light\'s melt reach', async () => {
  let placed = 0, plants = 0, snow = 0, lanterns = 0;
  for (let k = 0; k < 60; k++) {
    const rnd = prng(9000 + k);
    const claim = claimOf(96, rnd.int(-200, 200), rnd.int(-200, 200));
    const seedW = `f2prop${k}`;
    const world = synthWorld(seedW);
    const ko = [[claim.minX + 60, claim.minZ + 10, claim.minX + 75, claim.minZ + 25]];
    const program = { id: 'f2_prop', default: (ctx) => {
      const r = region(ctx);
      r.stages(['ground', 'decor', 'lots-1']);
      const S = ctx.survey;
      const box = { minX: claim.minX, minZ: claim.minZ, maxX: claim.maxX, maxZ: claim.maxZ, minY: 0, maxY: 160 };
      r.needVolume(box);
      // a walk path along z = minZ + 48 and a lot
      const cols = [];
      for (let x = claim.minX + 4; x <= claim.maxX - 4; x++) if (!S.waterAt(x, claim.minZ + 48)) cols.push(x, claim.minZ + 48, 0, 0, 0);
      if (cols.length) r.part('path', { stage: 'ground', set: 'path' })._push({ op: 'columns', from: { surface: 0 }, to: { surface: 0 }, cols, materials: ['minecraft:spruce_planks'], cond: 0, walk: true });
      try { r.part('pads', { stage: 'ground' }).lot('lot_1', { at: [claim.minX + 10, claim.minZ + 10], size: [10, 10], max: [10, 8, 10], pad: { maxCut: 30, maxFill: 30 }, stage: 'lots-1' }); } catch { /* steep */ }
      void ctx.keepOut;
      scatter(r, 'lamps', { grid: 6, jitter: 2, density: { path: [2, 3], p: 1 }, items: [{ w: 1, item: 'path_lantern', light: 'minecraft:lantern', rail: 'minecraft:oak_fence' }] }, { stage: 'decor' });
      scatter(r, 'deco', { grid: 7, jitter: 2, density: 0.7, items: [{ w: 3, item: 'boulder' }, { w: 2, item: 'stump' }, { w: 2, item: 'shrub' }, { w: 2, item: 'fern_patch' }, { w: 2, item: 'moss_carpet' }, { w: 4, item: 'snow_layer' }] }, { stage: 'decor' });
      r.anchor('entrance', [claim.minX + 2, claim.minZ + 2]); r.anchor('spawn', [claim.minX + 2, claim.minZ + 2]);
      return r;
    } };
    const survey = synthSurvey(claim, seedW);
    const p = await plan2({ program, programSource: `prop${k}`, survey, claim, keepOut: ko, seed: String(100 + k), node: 'test' }, world);
    const blobs = (sha) => p.blobs.get(sha);
    const { vw } = buildVirtual({ ir: p.ir, survey, blobs, volumes: p.volumes.map((v) => v.decoded) });
    const rep = checkRegion({ ir: p.ir, survey, blobs, volumes: p.volumes.map((v) => v.decoded), meta: p.meta });
    const sp = new Set(p.ir.parts.map((q, i) => (q.ops.some((o) => o.op === 'scatter') ? i : -1)).filter((i) => i >= 0));
    const floating = rep.findings.filter((f) => /^M3/.test(f.rule) && (f.part === 'deco' || f.part === 'lamps'));
    assert.deepEqual(floating.map((f) => `${f.rule} ${f.part} ${f.count} ${f.message}`), [], `claim ${k}: no M3 finding on a scatter part`);
    const walkCols = new Set(), lotBox = (x, z) => p.ir.lots.some((l) => x >= l.box.minX - 1 && x <= l.box.maxX + 1 && z >= l.box.minZ - 1 && z <= l.box.maxZ + 1);
    vw.eachWritten((x, y, z) => { if (vw.flags(x, y, z) & F_WALK) walkCols.add(`${x},${z}`); });
    const vol = p.volumes[0].decoded;
    const lights = [];
    vw.eachWritten((x, y, z, idx) => { if (sp.has(vw.partAt(x, y, z)) && vw.pal.emit[idx] >= 12) lights.push([x, y, z, vw.pal.emit[idx]]); });
    lanterns += lights.length;
    vw.eachWritten((x, y, z, idx) => {
      if (!sp.has(vw.partAt(x, y, z))) return;
      const st = vw.pal.states[idx];
      if (vw.pal.air[idx]) return; // a lantern's melt clearing (air over a natural snow layer)
      placed++;
      assert.ok(!walkCols.has(`${x},${z}`), `claim ${k}: ${st} at ${x},${y},${z} is on a walk column`);
      assert.ok(!lotBox(x, z), `claim ${k}: ${st} at ${x},${y},${z} is in a lot box or apron`);
      assert.ok(!ko.some((q) => x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3]), `claim ${k}: ${st} at ${x},${y},${z} is in keep-out`);
      const name = st.replace(/\[.*/, '');
      if (['minecraft:fern', 'minecraft:large_fern', 'minecraft:bush'].includes(name) && !/half=upper/.test(st)) {
        plants++;
        const below = vw.pal.states[vw.get(x, y - 1, z)];
        assert.ok(hasTag(below.replace(/\[.*/, ''), 'minecraft:supports_vegetation') || below === 'minecraft:grass_block', `claim ${k}: ${st} at ${x},${y},${z} stands on ${below}`);
      }
      if (name === 'minecraft:snow') {
        snow++;
        for (const [lx, ly, lz, L] of lights) assert.ok(Math.abs(lx - x) + Math.abs(ly - y) + Math.abs(lz - z) > L - 12, `claim ${k}: a snow layer at ${x},${y},${z} within reach of a light ${L} at ${lx},${ly},${lz}`);
      }
    });
    assert.equal(rep.findings.filter((f) => f.rule === 'M17').length, 0, `claim ${k}: M17 ${JSON.stringify(rep.findings.filter((f) => f.rule === 'M17').map((f) => f.message))}`);
    void vol;
  }
  assert.ok(placed > 1000 && plants > 50 && snow > 50 && lanterns > 5, `enough items: ${placed} cells, ${plants} plants, ${snow} snow layers, ${lanterns} lanterns`);
});

// ------------------------------------------------------------------ 5: stamps

test('item 5: a stamp realises as its cells, turned, plus the skirt (at most 6) down to the frozen ground; 4 turns are the identity', async () => {
  const lib = synthLibrary();
  for (const id of lib.keys()) {
    const s = decodeStamp(lib.get(id));
    for (const st of s.voxels.palette) assert.equal(turnState(turnState(turnState(turnState(st, 1), 1), 1), 1), st, `${id}: ${st}`);
  }
  // the local library, when one is there (never in the repo): every harvested state too
  const local = process.env.ARCHITECT_STAMPS_DIR;
  if (local && fs.existsSync(local)) {
    const L = stampLibrary(local);
    for (const id of L.ids()) for (const st of L.get(id).voxels.palette) assert.equal(turnState(turnState(turnState(turnState(st, 1), 1), 1), 1), st, `${id}: ${st}`);
  }
  // a dip under the stamp: ground 64, a pit to 60 at (20..22, 20..22)
  const world = (x, z) => { const g = x >= 20 && x <= 22 && z >= 20 && z <= 22 ? 60 : 64; return { g, h: g, f: g, flags: 0 }; };
  const claim = claimOf(64);
  const survey = synthColumns({ minX: 0, minZ: 0, width: 64, depth: 64, resolution: 1, world });
  for (const rot of [0, 90, 180, 270]) {
    const program = { id: 'f2_stamp', default: (ctx) => { const r = region(ctx); r.stages(['s']); stamp(r, 'mush/1', [21, 65, 21], { rotation: rot, stage: 's' }); stamp(r, 'oak/1', [40, 65, 40], { rotation: rot, stage: 's' }); r.anchor('entrance', [2, 2]); r.anchor('spawn', [2, 2]); return r; } };
    const stamps = new Map([['mush/1', syntheticStamp('mushroom', 1)], ['oak/1', syntheticStamp('tree', 3)]]);
    const p = await planRegion({ program, programSource: `stamp${rot}`, survey, claim, stamps, node: 'test' });
    const cells = new Map();
    for (const key of p.ir.tiles.s.terrain) {
      const w = synthColumns({ minX: Number(key.split(',')[0]) * 64 - 8, minZ: Number(key.split(',')[1]) * 64 - 8, width: 80, depth: 80, resolution: 1, world });
      for (const c of unpack(evalTile(p.ir, key, w, { blobs: (sha) => p.blobs.get(sha) }).payload).cells) cells.set(`${c.x},${c.y},${c.z}`, c.state);
    }
    const k = rot / 90;
    const want = new Map();
    for (const [sid, at] of [['mush/1', [21, 65, 21]], ['oak/1', [40, 65, 40]]]) {
      const s = decodeStamp(stamps.get(sid)), v = s.voxels, [sx, , sz] = v.size, [rx, ry, rz] = s.root;
      const [trx, trz] = turnXZ(rx, rz, sx, sz, k);
      const low = new Map();
      for (let i = 0; i < v.count; i++) {
        const [lx, ly, lz] = voxelAt(v, i);
        const [tx, tz] = turnXZ(lx, lz, sx, sz, k);
        const x = at[0] + tx - trx, y = at[1] + ly - ry, z = at[2] + tz - trz;
        const st = turnState(v.palette[v.pal[i]], k);
        want.set(`${x},${y},${z}`, st);
        const c = `${x},${z}`;
        if (!low.has(c) || low.get(c)[0] > ly) low.set(c, [ly, y, st]);
      }
      for (const [c, [ly, y, st]] of low) {
        if (ly !== 0) continue;
        const [x, z] = c.split(',').map(Number);
        const g = world(x, z).g;
        for (let yy = y - 1, n = 0; yy > g && n < SKIRT_MAX; yy--, n++) if (!want.has(`${x},${yy},${z}`)) want.set(`${x},${yy},${z}`, st);
      }
    }
    assert.deepEqual([...cells.entries()].sort(), [...want.entries()].sort(), `rotation ${rot}`);
    // the mushroom over the pit: its stem's skirt reaches the pit's floor (64 -> 60: 4 cells)
    assert.ok([61, 62, 63, 64].every((y) => cells.has(`21,${y},21`)), `rotation ${rot}: the skirt fills the pit`);
  }
});

// ------------------------------------------------------------------ anchors, melt, fallback

test('ceiling and wall anchors: glow lichen only on cave air beside rock, the face toward the rock; nothing without a volume', async () => {
  const claim = claimOf(64);
  const world = (x, z) => ({ g: 80, h: 80, f: 80, flags: 0 });
  const survey = synthColumns({ minX: 0, minZ: 0, width: 64, depth: 64, resolution: 1, world });
  const box = { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: 40, maxY: 90 };
  // rock to 80, a cave pocket 50..55 over x, z 10..50
  const W = 64, H = 51, D = 64;
  const cl = new Uint8Array(W * H * D);
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) {
    const Y = 40 + y;
    cl[(x * D + z) * H + y] = Y > 80 ? VC.AIR : Y >= 50 && Y <= 55 && x >= 10 && x <= 50 && z >= 10 && z <= 50 ? VC.AIR : VC.ROCK;
  }
  const bytes = encodeArvx(box, cl), decoded = decodeArvx(bytes);
  const vol = { sha: decoded.sha, box, bytes, decoded };
  const program = { id: 'f2_cave', default: (ctx) => { const r = region(ctx); r.stages(['s']); r.needVolume(box); scatter(r, 'lichen', { grid: 3, jitter: 1, density: 1, y: [41, 89], mask: { depth: [2, 400] }, items: [{ w: 1, item: 'glow_lichen' }] }, { stage: 's' }); r.anchor('entrance', [2, 2]); r.anchor('spawn', [2, 2]); return r; } };
  const p = await planRegion({ program, programSource: 'cave', survey, claim, volumes: [vol], node: 'test' });
  const cells = [];
  for (const key of p.ir.tiles.s.terrain) cells.push(...unpack(evalTile(p.ir, key, synthColumns({ minX: Number(key.split(',')[0]) * 64 - 8, minZ: Number(key.split(',')[1]) * 64 - 8, width: 80, depth: 80, resolution: 1, world }), { blobs: (sha) => p.blobs.get(sha) }).payload).cells);
  assert.ok(cells.length > 20, `lichen placed: ${cells.length}`);
  const rock = (x, y, z) => !(y > 80 || (y >= 50 && y <= 55 && x >= 10 && x <= 50 && z >= 10 && z <= 50));
  const D6 = { up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };
  let ceil = 0, wall = 0;
  for (const c of cells) {
    assert.ok(!rock(c.x, c.y, c.z) && c.y >= 50 && c.y <= 55, `${c.state} at ${c.x},${c.y},${c.z} is in the cave`);
    const face = /\[(\w+)=true\]/.exec(c.state)[1];
    const [dx, dy, dz] = D6[face];
    assert.ok(rock(c.x + dx, c.y + dy, c.z + dz), `${c.state} at ${c.x},${c.y},${c.z}: its face is on rock`);
    if (face === 'up') ceil++; else wall++;
  }
  assert.ok(ceil > 0 && wall > 0, `ceiling ${ceil}, walls ${wall}`);
  // without the volume: no wall or ceiling item fires
  const p0 = await planRegion({ program, programSource: 'cave', survey, claim, volumes: [], node: 'test' });
  let n0 = 0;
  for (const key of p0.ir.tiles.s.terrain) n0 += evalTile(p0.ir, key, synthColumns({ minX: Number(key.split(',')[0]) * 64 - 8, minZ: Number(key.split(',')[1]) * 64 - 8, width: 80, depth: 80, resolution: 1, world }), { blobs: (sha) => p0.blobs.get(sha), countOnly: true }).count;
  assert.equal(n0, 0);
});

test('a path lantern clears the natural snow layers within its melt reach and never stands where ice is within its reach', async () => {
  const claim = claimOf(64);
  const world = () => ({ g: 70, h: 70, f: 70, flags: 0 });
  const survey = synthColumns({ minX: 0, minZ: 0, width: 64, depth: 64, resolution: 1, world });
  const box = { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: 60, maxY: 80 };
  const W = 64, H = 21, D = 64;
  const cl = new Uint8Array(W * H * D);
  // soil to 70, a snow layer (class SNOW) on every column at 71; ice blocks at x 0..20 (a frozen patch at 71 instead of snow)
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) { const Y = 60 + y; cl[(x * D + z) * H + y] = Y <= 70 ? VC.SOIL : Y === 71 ? (x <= 20 ? VC.ICE : VC.SNOW) : VC.AIR; }
  const bytes = encodeArvx(box, cl), decoded = decodeArvx(bytes);
  const vol = { sha: decoded.sha, box, bytes, decoded };
  const program = { id: 'f2_lamp', default: (ctx) => { const r = region(ctx); r.stages(['s']); r.needVolume(box); scatter(r, 'lamps', { grid: 8, jitter: 2, density: 1, items: [{ w: 1, item: 'path_lantern', light: 'minecraft:lantern', rail: 'minecraft:oak_fence' }] }, { stage: 's' }); r.anchor('entrance', [2, 2]); r.anchor('spawn', [2, 2]); return r; } };
  const p = await planRegion({ program, programSource: 'lamp', survey, claim, volumes: [vol], node: 'test' });
  const cells = [];
  for (const key of p.ir.tiles.s.terrain) cells.push(...unpack(evalTile(p.ir, key, synthColumns({ minX: -8, minZ: -8, width: 80, depth: 80, resolution: 1, world }), { blobs: (sha) => p.blobs.get(sha) }).payload).cells);
  const lamps = cells.filter((c) => c.state.startsWith('minecraft:lantern'));
  assert.ok(lamps.length >= 10, `lanterns: ${lamps.length}`);
  for (const l of lamps) {
    assert.ok(l.x - 4 > 20, `a lantern at ${l.x},${l.y},${l.z} is within 4 of the ice (x <= 20)`);
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      if (Math.abs(dx) + Math.abs(dz) > 3 || (dx === 0 && dz === 0)) continue;
      const x = l.x + dx, z = l.z + dz;
      if (x < 0 || z < 0 || x > 63 || z > 63) continue;
      assert.ok(cells.some((c) => c.x === x && c.z === z && c.y === 71 && c.state === 'minecraft:air'), `the snow layer at ${x},71,${z} beside the lantern at ${l.x},${l.z} is cleared`);
    }
  }
});

test('a missing stamp is a plan note: a stamp op returns null, a scatter stamp item falls back to a boulder (stamps are local-only)', async () => {
  const claim = claimOf(64);
  const program = { id: 'f2_miss', default: (ctx) => {
    const r = region(ctx); r.stages(['s']);
    assert.equal(stamp(r, 'oak/1', [10, 65, 10], { stage: 's' }), null);
    scatter(r, 'trees', { grid: 8, density: 1, items: [{ w: 1, stamp: ['oak/1'] }] }, { stage: 's' });
    r.anchor('entrance', [2, 2]); r.anchor('spawn', [2, 2]); return r;
  } };
  const p = await planRegion({ program, programSource: 'miss', survey: synthSurvey(claim, 'flatish', () => ({ g: 64, h: 64, f: 64, flags: 0 })), claim, node: 'test' });
  assert.ok(p.notes.some((n) => /stamp oak\/1: not in the local stamp library/.test(n)), p.notes.join('\n'));
  assert.ok(p.notes.some((n) => /falling back to boulder/.test(n)), p.notes.join('\n'));
  assert.ok(!p.ir.requires.includes('stamp'));
  assert.ok(p.meta.scatter[0].items.every((it) => it.bundled === 'boulder'));
  assert.ok(Object.keys(p.ir.blobs).every((n) => !n.startsWith('stamp_')));
});

test('scatter refuses an item reach over 4 and a wall item without a y range', async () => {
  const claim = claimOf(64);
  const survey = synthSurvey(claim, 'flatish', () => ({ g: 64, h: 64, f: 64, flags: 0 }));
  const big = { id: 'f2_big', default: (ctx) => { const r = region(ctx); r.stages(['s']); scatter(r, 'x', { grid: 12, density: 1, items: [{ w: 1, patch: [[0, 0, 'minecraft:fern'], [5, 0, 'minecraft:fern']] }] }, { stage: 's' }); r.anchor('entrance', [2, 2]); r.anchor('spawn', [2, 2]); return r; } };
  await assert.rejects(planRegion({ program: big, programSource: 'big', survey, claim, node: 'test' }), new RegExp(`reach 5 is over ${SCATTER_MAX_RADIUS}`));
  const wall = { id: 'f2_wall', default: (ctx) => { const r = region(ctx); r.stages(['s']); scatter(r, 'x', { grid: 6, density: 1, items: [{ w: 1, block: 'minecraft:glow_lichen[north=true]', anchor: 'wall' }] }, { stage: 's' }); r.anchor('entrance', [2, 2]); r.anchor('spawn', [2, 2]); return r; } };
  await assert.rejects(planRegion({ program: wall, programSource: 'wall', survey, claim, node: 'test' }), /a wall anchor needs the op's y range/);
  // the requires walk
  const ok = { id: 'f2_ok', default: (ctx) => { const r = region(ctx); r.stages(['s']); scatter(r, 'x', { grid: 6, density: 0.5, items: [{ w: 1, item: 'boulder' }] }, { stage: 's' }); r.anchor('entrance', [2, 2]); r.anchor('spawn', [2, 2]); return r; } };
  const p = await planRegion({ program: ok, programSource: 'ok', survey, claim, node: 'test' });
  assert.deepEqual(walkKinds(p.ir), p.ir.requires);
  assert.ok(compileIR(p.ir, { blobs: (sha) => p.blobs.get(sha) }));
  void makeColumns;
});
