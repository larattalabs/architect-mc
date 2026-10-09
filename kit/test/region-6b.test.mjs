// Phase 6b gate items 1 and 5 (kit): format-2 determinism (IR byte-identical over 3 plans; S1's and the four fixtures'
// tile shas identical for 1 and 4 workers, forward and shuffled; committed goldens), preview goldens (pixel shas) and
// siteplan.json against its schema with a graph node per lot entrance and anchor, the ARVX decoder against the mod's
// fixtures, and the 6b primitives' guarantees as properties.
// Regenerate (only on purpose): UPDATE_GOLDEN=1 node --test kit/test/region-6b.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { region } from '../lib/region/program.mjs';
import { synthSurvey } from '../lib/region/synth.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { renderPreviews } from '../lib/region/preview.mjs';
import { validateSchema } from '../lib/region/siteplan.mjs';
import { decodeArvx, encodeArvx } from '../lib/region/volume.mjs';
import { buildVirtual, decodeArwd, dumpWorld, encodeArwd } from '../lib/region/vworld.mjs';
import { makeColumns } from '../lib/region/pack.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, '..');
const ROOT = path.resolve(KIT, '..');
const FIX = path.join(HERE, 'fixtures', 'regions');
const WORKER = new URL('./fixtures/regions/eval-worker.mjs', import.meta.url);
const SEED = 'golden';

/** S1 and the four family fixtures, over synthetic land (the golden seed). */
const CASES = { floating_islands: 256, crater_works: 200, sky_isle: 240, rift_city: 256, walled_hill: 200 };
const claimOf = (size) => { const h = size / 2; return { minX: -h, minZ: -h, maxX: h - 1, maxZ: h - 1, minY: -64, maxY: 319 }; };
const plan = (id) => planRegion({ programFile: path.join(KIT, 'regions', `${id}.mjs`), survey: synthSurvey(claimOf(CASES[id]), SEED), claim: claimOf(CASES[id]), node: 'golden' });

function evalIn(irJson, jobs, blobs) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { irJson, seed: SEED, jobs, blobs } });
    w.once('message', (m) => { resolve(m); void w.terminate(); });
    w.once('error', reject);
  });
}
function shuffled(arr, seed) {
  const a = [...arr];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

test('format-2 determinism: IR byte-identical over 3 plans; tile shas for 1 and 4 workers, forward and shuffled, equal the golden', async () => {
  const goldenFile = path.join(FIX, 'regions-6b.golden.json');
  const now = {};
  for (const id of Object.keys(CASES)) {
    const a = await plan(id), b = await plan(id), c = await plan(id);
    assert.equal(a.irJson, b.irJson, `${id}: plan 2`);
    assert.equal(a.irJson, c.irJson, `${id}: plan 3`);
    const blobs = Object.fromEntries([...a.blobs].map(([k, v]) => [k, v]));
    const jobs = [];
    for (const stage of a.ir.stages) for (const set of ['terrain', 'path']) for (const key of a.ir.tiles[stage][set]) jobs.push({ key, stage, set });
    const one = await evalIn(a.irJson, jobs, blobs);
    const order = shuffled(jobs, 99);
    const four = (await Promise.all([0, 1, 2, 3].map((k) => evalIn(a.irJson, order.filter((_, i) => i % 4 === k), blobs)))).flat();
    const tag = (r) => `${r.stage}|${r.set}|${r.key}`;
    const m1 = Object.fromEntries(one.map((r) => [tag(r), r.sha])), m4 = Object.fromEntries(four.map((r) => [tag(r), r.sha]));
    assert.deepEqual(m4, m1, `${id}: 4 workers shuffled = 1 worker forward`);
    now[id] = { irSha: a.irSha, format: a.ir.format, requires: a.ir.requires ?? [], cells: one.reduce((n, r) => n + r.count, 0), tiles: Object.fromEntries(Object.keys(m1).sort().map((k) => [k, m1[k]])) };
  }
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(goldenFile, `${JSON.stringify({ note: 'S1 (floating_islands) and the four family fixtures over synthSurvey(claim, "golden"), node pinned to "golden"; tiles: stage|set|key -> sha256 of the ARTL payload', cases: now }, null, 1)}\n`);
  const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8')).cases;
  for (const id of Object.keys(CASES)) {
    assert.equal(now[id].irSha, golden[id].irSha, `${id}: IR sha`);
    assert.deepEqual(now[id].tiles, golden[id].tiles, `${id}: tile shas`);
  }
});

test('previews: pixel goldens; siteplan.json validates against siteplan-1 with a node per lot entrance and anchor', async () => {
  const schema = JSON.parse(fs.readFileSync(path.join(KIT, 'schemas', 'siteplan-1.json'), 'utf8'));
  const goldenFile = path.join(FIX, 'previews-6b.golden.json');
  const now = {};
  for (const id of Object.keys(CASES)) {
    const p = await plan(id);
    const survey = synthSurvey(claimOf(CASES[id]), SEED);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `preview-${id}-`));
    const r = renderPreviews({ ir: p.ir, survey, blobs: p.blobs, meta: p.meta, outDir: out, irSha: p.irSha });
    const again = renderPreviews({ ir: p.ir, survey, blobs: p.blobs, meta: p.meta, outDir: out, irSha: p.irSha });
    assert.deepEqual(again.pixels, r.pixels, `${id}: the same pixels twice`);
    const errs = validateSchema(schema, r.sitePlan);
    assert.deepEqual(errs, [], `${id}: siteplan.json validates`);
    const ids = new Set(r.sitePlan.graph.nodes.map((n) => n.id));
    for (const l of p.ir.lots) assert.ok(ids.has(`lot:${l.id}`), `${id}: a node for lot ${l.id}`);
    for (const a of Object.keys(p.ir.anchors)) if (!a.startsWith('cam_')) assert.ok(ids.has(`anchor:${a}`), `${id}: a node for anchor ${a}`);
    assert.equal(r.sitePlan.graph.derived, true);
    for (const f of ['top.png', 'section-1.png', 'iso.png', 'siteplan.png', 'siteplan.svg']) assert.ok(fs.existsSync(path.join(out, 'previews', f)), `${id}: ${f}`);
    now[id] = r.pixels;
    fs.rmSync(out, { recursive: true, force: true });
  }
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(goldenFile, `${JSON.stringify({ note: 'sha256 of each preview\'s RGBA pixels (the PNG bytes depend on the bundled zlib)', cases: now }, null, 1)}\n`);
  assert.deepEqual(now, JSON.parse(fs.readFileSync(goldenFile, 'utf8')).cases);
});

test('ARWD: a realised check over before/after dumps of S1\'s virtual world (plan attribution) equals the virtual check', async () => {
  const id = 'floating_islands';
  const p = await plan(id);
  const survey = synthSurvey(claimOf(CASES[id]), SEED);
  const virt = checkRegion({ ir: p.ir, survey, blobs: p.blobs, meta: p.meta, prefix: false });
  const { vw } = buildVirtual({ ir: p.ir, survey, blobs: p.blobs });
  let lo = Infinity, hi = -Infinity;
  vw.eachWritten((x, y) => { if (y < lo) lo = y; if (y > hi) hi = y; });
  const c = p.ir.claim;
  const box = { minX: c.minX, minY: lo - 2, minZ: c.minZ, maxX: c.maxX, maxY: hi + 2, maxZ: c.maxZ };
  const S = vw.pal.states;
  const before = await decodeArwd(encodeArwd(box, (x, y, z) => S[vw.base(x, y, z)]));
  const after = await decodeArwd(encodeArwd(box, (x, y, z) => S[vw.get(x, y, z)]));
  assert.equal(after.cells.length, (box.maxX - box.minX + 1) * (box.maxY - box.minY + 1) * (box.maxZ - box.minZ + 1));
  const world = dumpWorld(before, after, c, { virtual: vw, lots: p.ir.lots });
  const real = checkRegion({ ir: p.ir, meta: p.meta, world, prefix: false });
  assert.equal(real.mode, 'realised');
  for (const k of ['M2', 'M3', 'M4', 'M8', 'M10']) assert.deepEqual(real.metrics[k], virt.metrics[k], `${k}: realised = virtual`);
  assert.deepEqual(real.findings.map((f) => `${f.rule}|${f.part}|${f.count}`).sort(), virt.findings.filter((f) => f.rule !== 'M1').map((f) => `${f.rule}|${f.part}|${f.count}`).sort());
});

test('ARVX: the kit decoder reads the mod encoder\'s fixtures (runs, owners, sha) and round-trips its own encoding', () => {
  const dir = path.join(ROOT, 'mod', 'src', 'test', 'resources', 'arvx');
  for (const name of ['simple', 'owned', 'tall']) {
    const exp = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
    const v = decodeArvx(fs.readFileSync(path.join(dir, `${name}.bin`)));
    assert.equal(v.sha, exp.sha, `${name}: sha over the uncompressed bytes`);
    assert.deepEqual(v.box, exp.box, `${name}: box`);
    let col = 0;
    for (const runs of exp.columns) {
      let y = 0;
      for (const [cls, len] of runs) { for (let i = 0; i < len; i++) assert.equal(v.classes[col * v.height + y + i], cls, `${name}: column ${col} y ${y + i}`); y += len; }
      col++;
    }
    assert.deepEqual(v.owners, exp.owners ?? [], `${name}: owners`);
    const re = encodeArvx(v.box, v.classes, v.owners, v.ownerOf);
    assert.equal(decodeArvx(re).sha, v.sha, `${name}: re-encoding gives the same bytes`);
  }
});

// ---- the 6b primitives' guarantees

const small = claimOf(128);
const flat = () => { const c = makeColumns(small.minX, small.minZ, 128, 128, 1); c.ground.fill(64); c.height.fill(64); c.floor.fill(64); return c; };
async function planWith(fn) {
  const prog = { id: 'prim_test', default: (ctx) => { const r = region(ctx); r.stages(['ground', 'ways']); fn(r, ctx); r.anchor('entrance', [0, 50]); r.anchor('spawn', [3, 50]); return r; } };
  return planRegion({ program: prog, programSource: 'prim_test', survey: flat(), claim: small, node: 'golden' });
}

test('cavern: lights cover the floor (no dark spawnable cell inside, over 6 seeds and sizes)', async () => {
  for (const [rx, rz, every] of [[10, 8, 8], [14, 10, 8], [8, 8, 6], [16, 12, 10], [12, 6, 8], [20, 14, 8]]) {
    const p = await planWith((r) => {
      r.part('cave', { stage: 'ground' }).cavern({ kind: 'ellipsoid', c: [0, { abs: 50 }, 0], r: [rx, 6, rz] }, { amp: 2, floorY: 46, light: { every } });
      r.part('down', { stage: 'ways', set: 'path' }).stair([[0, 64, rz + 22], [0, 45, rz - 2]], { width: 3, solid: true });
    });
    const rep = checkRegion({ ir: p.ir, survey: flat(), blobs: p.blobs, meta: p.meta, prefix: false });
    assert.equal(rep.findings.filter((f) => f.rule === 'M5' && f.part === 'cave').length, 0, `cavern ${rx}x${rz} every ${every}: ${JSON.stringify(rep.findings.map((f) => f.rule + ':' + f.part))}`);
  }
});

test("'ends' bridges: the whole deck within maxSpan or the plan fails; within it M10 holds with both ends on parts", async () => {
  await assert.rejects(planWith((r) => r.part('d', { stage: 'ways', set: 'path' }).bridge([[-20, 80, 0], [20, 80, 0]], { supports: { style: 'ends' }, maxSpan: 24 })), /'ends' bridge spans its whole length \(40\), more than maxSpan 24/);
  const p = await planWith((r) => {
    const g = r.part('piers', { stage: 'ground' });
    g.fill({ kind: 'box', min: [-14, 65, -3], max: [-9, 79, 3] }, 'structure', { cond: 0 });
    g.fill({ kind: 'box', min: [9, 65, -3], max: [14, 79, 3] }, 'structure', { cond: 0 });
    r.part('d', { stage: 'ways', set: 'path' }).bridge([[-11, 80, 0], [11, 80, 0]], { supports: { style: 'ends' }, maxSpan: 24, id: 'b' });
  });
  const rep = checkRegion({ ir: p.ir, survey: flat(), blobs: p.blobs, meta: p.meta, prefix: false });
  assert.equal(rep.findings.filter((f) => f.rule === 'M10').length, 0, JSON.stringify(rep.findings));
  assert.ok(rep.metrics.M10[0].bearing.every((n) => n >= 4));
});

test('ring towers and crenels: every gate opening stays clear, towers never stand on a gate', async () => {
  for (const [r0, every] of [[30, 24], [40, 32], [50, 48]]) {
    let gates;
    const p = await planWith((r) => { gates = r.part('wall', { stage: 'ground' }).ring([0, 0], r0, r0 + 3, { height: 6, towers: { every, radius: 3, extra: 4 }, crenels: true, gates: [0, 90, 180, 270].map((angle) => ({ angle, width: 5, height: 5 })) }); });
    const { vw } = buildVirtual({ ir: p.ir, survey: flat(), blobs: p.blobs });
    for (const g of gates) {
      const [gx, gy, gz] = g.at;
      for (let dv = -2; dv <= 2; dv++) for (let h = 1; h <= 5; h++) {
        const x = gx + Math.round(g.dir[1] * -dv), z = gz + Math.round(g.dir[0] * dv);
        assert.ok(vw.pal.air[vw.get(x, gy + h, z)], `ring ${r0}: gate at ${g.at} is clear at ${x},${gy + h},${z}`);
      }
    }
  }
});

test('add underside taper/rock: the mass and its underside are one face-connected piece', async () => {
  for (const underside of ['taper', 'rock']) {
    const p = await planWith((r) => r.part('mass', { stage: 'ground' }).add({ kind: 'cylinder', c: [0, { abs: 120 }, 0], r: 14, h: 5 }, 'rock', { underside, taper: 0.8 }));
    const { vw } = buildVirtual({ ir: p.ir, survey: flat(), blobs: p.blobs });
    const cells = [];
    vw.eachWritten((x, y, z, idx) => { if (!vw.pal.air[idx]) cells.push(`${x},${y},${z}`); });
    const set = new Set(cells), seen = new Set([cells[0]]), q = [cells[0]];
    while (q.length) { const [x, y, z] = q.pop().split(',').map(Number); for (const [a, b, c] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const k = `${x + a},${y + b},${z + c}`; if (set.has(k) && !seen.has(k)) { seen.add(k); q.push(k); } } }
    const below = cells.filter((k) => Number(k.split(',')[1]) < 120).length;
    assert.ok(below > 50, `${underside}: an underside (${below} cells under the mass)`);
    assert.ok(seen.size >= cells.length - Math.ceil(cells.length * 0.002), `${underside}: ${cells.length - seen.size} of ${cells.length} cells not connected`);
  }
});
