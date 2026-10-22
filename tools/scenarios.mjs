#!/usr/bin/env node
// The scenario harness (docs/CONTRACT.md 6b §8.2) against the dev client of the 6b run worktree (tools/gate6b.mjs start).
//
//   node tools/scenarios.mjs pin <scenario>                 program seed, the 6 cameras (the plan's cam_* anchors looking at
//                                                           its hub) and lotEntries, written into scenarios/<id>.json once
//   node tools/scenarios.mjs run <scenario> --phase 6b [--flat] [--out dir]
//   node tools/scenarios.mjs golden <scenario> <runDir>     scenarios/goldens/<short>.json and its inputs from a green run
//   node tools/scenarios.mjs gallery --phase 6b [--local]   the gallery bundle (artifacts/scenarios/6b/gallery/)
//   node tools/scenarios.mjs check --phase 6b               every new or changed scenario's metrics pass and are approved
//   node tools/scenarios.mjs calibrate --phase 6b           the calibration card: 10 held-out floatingIsland renders
//
// A run: a fresh world from the pinned seed (or the flat variant) -> plan (report and previews kept) -> prepare -> plan over
// the prepared chunks (the realised plan; 2 more for the IR sha check) -> the pristine cameras (before/) -> dumps and a snap
// of the claim -> realise with lotEntries (MSPT traced) -> the realised dump -> the 2-minute stand (natural only, default
// random ticks) -> the 6 cameras (shots/) -> Regions.remove -> the exactness diff. Then the metrics (tools/lib/
// scenario-metrics.mjs) and evidence.sha over the run's outputs (raw/ holds the dumps and snap, outside the evidence).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCEN = path.join(root, 'scenarios');
// SCENARIOS_ART: where runs and the gallery go (the coordinator keeps them in the main checkout's artifacts/scenarios)
const ART = process.env.SCENARIOS_ART ? path.resolve(process.env.SCENARIOS_ART) : path.join(root, 'artifacts', 'scenarios');
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const sub = args[0];

export function scenarioPath(id) {
  for (const f of [path.join(SCEN, `${id}.json`), path.join(SCEN, 'sites', `${id}.json`)]) if (fs.existsSync(f)) return f;
  const m = fs.readdirSync(SCEN).find((f) => f.startsWith(`${id}_`) && f.endsWith('.json'));
  if (m) return path.join(SCEN, m);
  throw new Error(`no scenario ${id}`);
}
const readSc = (id) => JSON.parse(fs.readFileSync(scenarioPath(id), 'utf8'));
const writeSc = (sc) => fs.writeFileSync(scenarioPath(sc.id), `${JSON.stringify(sc, null, 2)}\n`);
// (6c MP) a scenario may name its short id (its golden and run dirs); else the id's first word
const short = (sc) => sc.short ?? sc.id.split('_')[0];
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** SHA-256 over the sorted (path, sha) list of every file under dir except raw/ (CONTRACT 6b §8.2). */
export function evidenceSha(dir) {
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (r !== 'raw') walk(path.join(d, e.name), r); } else if (r !== 'evidence.sha') files.push(r);
    }
  };
  walk(dir, '');
  files.sort();
  const lines = files.map((f) => `${f} ${sha256(fs.readFileSync(path.join(dir, f)))}`);
  return { sha: sha256(lines.join('\n') + '\n'), files: lines };
}

/**
 * (fix/voc-natural; here since 6c S3, the rule unchanged) voc-natural's item 9 and S3's natural run: the world class for S3's own fluids still settling: F2's `distant` rule (`distantOf` below)
 * restricted to flowing fluid. S3's fresh chunks carry worldgen springs (a cave stream at x 3752-3760, y 37-48, z -924..-914; lava at
 * y -2, x 3787-3789) whose flow front can cross the snapshot: with no region at all the same cells go air -> flowing water within 15 s
 * of a snapshot. An unclassified (`none`) mismatch is classed `farfluid` only when
 *   - kind: was and now are each air, cave air, or a non-source water or lava (level 1-15), and at least one side is that fluid
 *     (a source block on either side, or any other block, is never classed);
 *   - place: a cell the plan never writes, in no lot box, and 8 or more (Manhattan) from every written cell (the undo writes only the
 *     journal's cells, which are the written cells and what stood on them).
 * Pure: `written` is a Set of "x,y,z" keys, `lots` the IR's lots. Returns the diff with the moved cells' class and the counts updated.
 */
export function farFluidOf(diff, { written, lots = [] }) {
  if (!diff || !(diff.classes?.none > 0)) return diff;
  const empty = (st) => /^minecraft:(air|cave_air)$/.test(String(st));
  const flowing = (st) => /^minecraft:(water|lava)\[level=([1-9]|1[0-5])\]$/.test(String(st));
  const kind = (m) => (empty(m.was) || flowing(m.was)) && (empty(m.now) || flowing(m.now)) && (flowing(m.was) || flowing(m.now));
  const inLot = (x, y, z) => lots.some((l) => x >= l.box.minX && x <= l.box.maxX && y >= l.box.minY && y <= l.box.maxY && z >= l.box.minZ && z <= l.box.maxZ);
  const near = (x, y, z) => {
    for (let dx = -7; dx <= 7; dx++) for (let dy = -7 + Math.abs(dx); dy <= 7 - Math.abs(dx); dy++) {
      const r = 7 - Math.abs(dx) - Math.abs(dy);
      for (let dz = -r; dz <= r; dz++) if (written.has(`${x + dx},${y + dy},${z + dz}`)) return true;
    }
    return false;
  };
  const moved = new Set((diff.list ?? []).filter((m) => {
    if (m.class !== 'none' || !kind(m)) return false;
    const [x, y, z] = String(m.pos).split(',').map(Number);
    return !written.has(`${x},${y},${z}`) && !inLot(x, y, z) && !near(x, y, z);
  }));
  if (!moved.size) return diff;
  const classes = { ...diff.classes, none: diff.classes.none - moved.size, farfluid: (diff.classes.farfluid ?? 0) + moved.size };
  if (!classes.none) delete classes.none;
  return { ...diff, classes, list: diff.list.map((m) => (moved.has(m) ? { ...m, class: 'farfluid' } : m)) };
}

/**
 * (6c S3, CONTRACT S3 §6) The mod's world classes `growth`, `grazed` and `live` only at unwritten cells (K1b's and T3's bridge rule): a
 * mismatch of those classes at a cell the plan wrote (the virtual world's F_WRITTEN) is the undo's, so it goes back to `none` (a
 * grass/dirt flip on a restored pad counts). Pure: (diff, vw, F_WRITTEN) -> the diff, its counts updated.
 */
export function s3Unwritten(diff, vw, F_WRITTEN) {
  if (!diff?.list?.length) return diff;
  const back = new Set(diff.list.filter((m) => ['growth', 'grazed', 'live'].includes(m.class) && (vw.flags(...String(m.pos).split(',').map(Number)) & F_WRITTEN)));
  if (!back.size) return diff;
  const classes = { ...diff.classes };
  for (const m of back) { classes[m.class] -= 1; if (!classes[m.class]) delete classes[m.class]; classes.none = (classes.none ?? 0) + 1; }
  return { ...diff, classes, list: diff.list.map((m) => (back.has(m) ? { ...m, class: 'none', was_class: m.class } : m)) };
}

/**
 * (6c S3, H §4.5) Nothing within 6 cells (3D, Chebyshev) of a fluid body's cells, shell or watch is classed: every world class there
 * goes back to `none` (a body's undo error never hides behind a world class). Pure: (diff, ir) -> the diff, its counts updated.
 */
export function s3NearBodies(diff, ir) {
  if (!diff?.list?.length) return diff;
  const runs = [];
  for (const p of ir.parts ?? []) for (const o of p.ops ?? []) if (o.op === 'fluid') for (const set of ['cells', 'shell', 'watch']) for (const q of o[set] ?? []) runs.push(q);
  if (!runs.length) return diff;
  const near = (x, y, z) => runs.some(([rx, rz, y0, y1]) => Math.abs(rx - x) <= 6 && Math.abs(rz - z) <= 6 && y >= y0 - 6 && y <= y1 + 6);
  const back = new Set(diff.list.filter((m) => m.class !== 'none' && near(...String(m.pos).split(',').map(Number))));
  if (!back.size) return diff;
  const classes = { ...diff.classes };
  for (const m of back) { classes[m.class] -= 1; if (!classes[m.class]) delete classes[m.class]; classes.none = (classes.none ?? 0) + 1; }
  return { ...diff, classes, list: diff.list.map((m) => (back.has(m) ? { ...m, class: 'none', was_class: m.class } : m)) };
}

/** (6c F1) The world's own freezing (a class body; scenarios.mjs `freezeOf` picks the scenarios): an unclassified mismatch where still water
 * became ice (or a snow layer fell) at a cell the plan never writes is classed `freeze`. Pure. */
export function freezeClass(e, vw, F_WRITTEN) {
  const moved = (e.list ?? []).filter((m) => m.class === 'none' && !(vw.flags(...m.pos.split(',').map(Number)) & F_WRITTEN)
    && ((/^minecraft:water/.test(m.was) && /^minecraft:ice$/.test(m.now)) || (/air$/.test(m.was) && /^minecraft:snow\[/.test(m.now))));
  if (!moved.length) return e;
  const classes = { ...e.classes, none: e.classes.none - moved.length, freeze: (e.classes.freeze ?? 0) + moved.length };
  return { ...e, classes, list: e.list.map((m) => (moved.includes(m) ? { ...m, class: 'freeze' } : m)) };
}

/** (6c H §4.5) D2's rule for `flow`: a cell more than 6 columns from every written column (`far`), or more than 8 below the surveyed
 * ground and every written cell within 6 columns (`deep`). Returns (x, y, z) -> boolean (the written columns read once). */
export function awayFromWrites(vw, sampleIndexOf) {
  let writtenCols = null;
  return (x, y, z) => {
    if (!writtenCols) {
      writtenCols = new Map();
      vw.eachWritten((wx, wy, wz) => { const k = `${wx},${wz}`; writtenCols.set(k, Math.min(writtenCols.get(k) ?? Infinity, wy)); });
    }
    let near = Infinity, nearest = Infinity;
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) { const lo = writtenCols.get(`${x + dx},${z + dz}`); if (lo !== undefined) { near = Math.min(near, lo); nearest = 0; } }
    if (nearest === Infinity) return true; // far
    const g = vw.survey ? vw.survey.ground[sampleIndexOf(vw.survey, x, z)] : Infinity;
    return y < g - 8 && y < near - 8; // deep
  };
}

/** (6c T1; H §4.5's narrowing) The world's flowing water (`flowOf` picks the scenarios): flowing water in the snapshot, air now, at an
 * unwritten cell `away` from the writes, is classed `flow`. Pure. */
export function flowClass(e, vw, F_WRITTEN, away) {
  const moved = (e.list ?? []).filter((m) => m.class === 'none' && /^minecraft:water\[level=[1-9]/.test(m.was) && /^minecraft:(air|cave_air)$/.test(m.now)
    && !(vw.flags(...m.pos.split(',').map(Number)) & F_WRITTEN) && away(...m.pos.split(',').map(Number)));
  if (!moved.length) return e;
  const classes = { ...e.classes, none: e.classes.none - moved.length, flow: (e.classes.flow ?? 0) + moved.length };
  return { ...e, classes, list: e.list.map((m) => (moved.includes(m) ? { ...m, class: 'flow' } : m)) };
}

/** (6c T2) The region's lamps melting the world's snow (`meltOf` picks the scenarios): a snow layer in the snapshot, air now, at an
 * unwritten cell lit over 11 by a light the plan placed (unoccluded), is classed `melt`. Pure. */
export function meltClass(e, vw, F_WRITTEN) {
  const lights = [];
  vw.eachWritten((x, y, z, idx) => { const em = vw.pal.emit[idx]; if (em > 11) lights.push([x, y, z, em]); });
  const lit = (x, y, z) => lights.some(([lx, ly, lz, em]) => em - (Math.abs(lx - x) + Math.abs(ly - y) + Math.abs(lz - z)) > 11);
  const moved = (e.list ?? []).filter((m) => { if (m.class !== 'none' || !/^minecraft:snow\[/.test(m.was) || !/^minecraft:(air|cave_air)$/.test(m.now)) return false; const [x, y, z] = m.pos.split(',').map(Number); return !(vw.flags(x, y, z) & F_WRITTEN) && lit(x, y, z); });
  if (!moved.length) return e;
  const classes = { ...e.classes, none: e.classes.none - moved.length, melt: (e.classes.melt ?? 0) + moved.length };
  return { ...e, classes, list: e.list.map((m) => (moved.includes(m) ? { ...m, class: 'melt' } : m)) };
}

/**
 * (6c S3, CONTRACT S3 §6) S3's E-normal classes on a diff, in one place (the natural scenario run and the s3-plan copy): the mod's growth,
 * grazed and live only at unwritten cells; then `freeze`, `flow` (D2's far and deep) and `melt` by kind at unwritten cells; `farfluid`
 * (voc-natural's rule); and nothing within 6 (3D) of a body's cells, shell or watch stays classed. `vw`: the plan's virtual world.
 */
export function s3Classify(e, { vw, ir, F_WRITTEN, sampleIndexOf }) {
  if (!e) return e;
  let d = s3Unwritten(e, vw, F_WRITTEN);
  if (d.classes?.none > 0) d = freezeClass(d, vw, F_WRITTEN);
  if (d.classes?.none > 0) d = flowClass(d, vw, F_WRITTEN, awayFromWrites(vw, sampleIndexOf));
  if (d.classes?.none > 0) d = meltClass(d, vw, F_WRITTEN);
  const written = new Set();
  vw.eachWritten((x, y, z) => { written.add(`${x},${y},${z}`); });
  return s3NearBodies(farFluidOf(d, { written, lots: ir.lots ?? [] }), ir);
}

/** Tile shas of a plan's IR over its own survey, with 1 worker forward and 4 workers shuffled. */
export async function tileShas(planDir, { timingPasses = 1 } = {}) {
  const irJson = fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8');
  const ir = JSON.parse(irJson);
  const survey = fs.readFileSync(path.join(planDir, 'survey.bin'));
  const blobDir = path.join(planDir, 'blobs');
  const jobs = [];
  for (const stage of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles?.[stage]?.[set] ?? []) jobs.push({ key, stage, set });
  const W = new URL('./lib/scenario-eval-worker.mjs', import.meta.url);
  const run = (js) => new Promise((res, rej) => { const w = new Worker(W, { workerData: { irJson, survey, blobDir, jobs: js } }); w.once('message', (m) => { res(m); void w.terminate(); }); w.once('error', rej); });
  const order = [...jobs];
  let s = 99;
  for (let i = order.length - 1; i > 0; i--) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const j = s % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  const one = await run(jobs);
  const four = (await Promise.all([0, 1, 2, 3].map((k) => run(order.filter((_, i) => i % 4 === k))))).flat();
  const tag = (r) => `${r.stage}|${r.set}|${r.key}`;
  const m1 = Object.fromEntries(one.map((r) => [tag(r), r.sha])), m4 = Object.fromEntries(four.map((r) => [tag(r), r.sha]));
  const same = Object.keys(m1).length === Object.keys(m4).length && Object.keys(m1).every((k) => m1[k] === m4[k]);
  // (6c F1) evaluation time per tile: the single worker's forward pass, or with `timingPasses` > 1 the best of that many passes
  // in one warm worker (a cold JIT and a loaded box inflate single samples)
  const best = Object.fromEntries(one.map((r) => [tag(r), r.ms ?? 0]));
  if (timingPasses > 1) for (const r of await run(Array.from({ length: timingPasses }, () => jobs).flat())) best[tag(r)] = Math.min(best[tag(r)], r.ms ?? 0);
  const ms = Object.values(best).sort((a, b) => a - b);
  const cells = one.reduce((n, r) => n + r.count, 0);
  const timing = { passes: timingPasses, count: ms.length, p99Ms: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.99))] : 0, maxMs: ms.length ? ms[ms.length - 1] : 0, totalMs: ms.reduce((a, b) => a + b, 0) };
  timing.cellsPerSecond = timing.totalMs > 0 ? cells / (timing.totalMs / 1000) : 0;
  timing.p50Ms = ms.length ? ms[ms.length >> 1] : 0; // (6c T1)
  return { irSha: sha256(irJson), tiles: Object.fromEntries(Object.keys(m1).sort().map((k) => [k, m1[k]])), cells, workersSame: same, timing };
}

// ------------------------------------------------------------------ in-game steps (lazy: the offline commands need no client)
let L;
const lib = async () => (L ??= await import('./lib/run6b.mjs'));

function copyPlan(planId, to) {
  const from = path.join(L.SIDECAR_DATA, 'regions', 'plans', planId);
  fs.mkdirSync(to, { recursive: true });
  execFileSync('cp', ['-R', `${from}/.`, to]);
  return to;
}

/** The y span the plan writes (its virtual world's written cells and its lots' boxes). */
async function writtenY(planDir, ir) {
  const { buildVirtual } = await import('../kit/lib/region/vworld.mjs');
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw } = buildVirtual({ ir, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs });
  let lo = Infinity, hi = -Infinity;
  vw.eachWritten((x, y) => { if (y < lo) lo = y; if (y > hi) hi = y; });
  for (const l of ir.lots) { lo = Math.min(lo, l.box.minY - 1); hi = Math.max(hi, l.box.maxY); }
  return [Math.max(ir.claim.minY, lo), Math.min(ir.claim.maxY, hi)];
}

async function shoot(cams, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = {};
  for (const name of Object.keys(cams)) {
    await L.call('dev.scenario.cams', { cams, cam: name }, 60_000);
    const s = await L.call('dev.screenshot', { name: `scn_${name}`, frames: 20, chunkTimeoutMs: 60_000 }, 180_000);
    fs.copyFileSync(s.path, path.join(dir, `${name}.png`));
    out[name] = { width: s.width, height: s.height };
  }
  await L.call('dev.release', {}).catch(() => null);
  return out;
}

/**
 * Lot children (CONTRACT 6b §4: the kit examples plus the 6a stubs, as mega_bench): per lot, round robin over the entries
 * whose size (the stub's footprint includes its path rows) fits the lot's box; the smallest stub when nothing else does.
 */
export function fitEntries(lots) {
  const sizes = { g6a_stub_9: [9, 6, 9], g6a_stub_14: [14, 8, 12], g6a_stub_19: [19, 11, 15], g6a_stub_24: [24, 14, 20] };
  for (const e of ['cabin', 'gatehouse', 'tavern', 'tower']) {
    const s = JSON.parse(fs.readFileSync(path.join(root, 'kit', 'examples', e, `${e}.blueprint.json`), 'utf8')).size;
    sizes[e] = [s.x, s.y, s.z + 3];
  }
  const out = {};
  let k = 0;
  for (const l of lots) {
    const b = l.box, w = b.maxX - b.minX + 1, h = b.maxY - b.minY + 1, d = b.maxZ - b.minZ + 1;
    const fits = Object.entries(sizes).filter(([, [x, y, z]]) => y <= h && ((x <= w && z <= d) || (x <= d && z <= w))).map(([e]) => e);
    out[l.id] = fits.length ? fits[k++ % fits.length] : 'g6a_stub_9';
  }
  return out;
}

// ------------------------------------------------------------------ (6c V) the flat village scenario (S7)
const isV = (sc) => sc.phase === '6c-v';
const isT1 = (sc) => sc.phase === '6c-t1'; // (6c T1) relief_demo on S3's claim
const isF1 = (sc) => sc.phase === '6c-f1'; // (6c F1) forms_demo on S2's claim
const isF2 = (sc) => sc.phase === '6c-f2'; // (6c F2) scatter_demo on S2's claim and the 6b volume fixture's cave
const isT2 = (sc) => sc.phase === '6c-t2'; // (6c T2) route_demo on S3's claim
const isD = (sc) => sc.phase === '6c-d'; // (6c D1) districts_demo on S3's claim
const isS2 = (sc) => sc.program === 'ice_outpost'; // (6c S2) the ice-spike outpost on S2's claim
const isS3 = (sc) => sc.program === 'terraced_monastery'; // (6c S3) the terraced monastery on S3's claim
const BARS = new Set(['mspt', 't1-tiles', 't2-tiles', 'd-tiles', 's2-tiles', 's3-tiles']); // timing rows (recorded, not blocking in change/slice)

/** (6c T2) An /apitest command's JSON answer (the apitest mod: protected areas). */
async function apitest(args) {
  const r = await L.cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args}: no JSON answer: ${JSON.stringify(r).slice(0, 400)}`);
  return JSON.parse(line);
}

/**
 * (6c V) Before the world opens: the fixture bible (scenarios/<bibleFixture>, installed as the sidecar's bible `sc.bible` v1) and the
 * lot entries (free variants of the kit's cabin, tavern and tower at the scenario's params, built with the kit into the library,
 * $0; the library loads them when the world opens).
 */
async function prepV(sc) {
  if (sc.bibleFixture) {
    const dst = path.join(L.GAME_DIR, 'architect', 'bibles', sc.bible, 'versions', '1'); // the helper's installed bibles
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(path.join(SCEN, sc.bibleFixture), path.join(dst, 'bible.json'));
  }
  if (sc.entries) {
    const { loadDesign } = await import('../kit/build.mjs');
    const { writeBlueprint } = await import('../kit/lib/write.mjs');
    // built in the fixture bible's roles (Steward re-skins with its settlement bible): the designs' own path rows are its path
    const bible = sc.bibleFixture ? JSON.parse(fs.readFileSync(path.join(SCEN, sc.bibleFixture), 'utf8')) : null;
    for (const [id, e] of Object.entries(sc.entries)) {
      const dir = path.join(L.LIBRARY, id);
      const spec = JSON.stringify({ ...e, bible: bible?.roles ?? null });
      if (fs.existsSync(path.join(dir, `${id}.nbt`)) && fs.existsSync(path.join(dir, 'g6cv.spec.json')) && fs.readFileSync(path.join(dir, 'g6cv.spec.json'), 'utf8') === spec) continue;
      // a settlement bible names few roles: the rustic core roles under its own
      const { PALETTES, rolesOfPalette } = await import('../kit/lib/kit.mjs');
      const roles = bible ? { ...rolesOfPalette(PALETTES.rustic), ...bible.roles } : null;
      const bp = await loadDesign(e.design, { values: e.values ?? {}, ...(roles ? { palette: { bible: { id: sc.bible, version: 1, roles } } } : {}) });
      bp.id = id;
      bp.name = `${e.design} ${JSON.stringify(e.values ?? {})}`;
      writeBlueprint(bp, dir);
      fs.writeFileSync(path.join(dir, 'g6cv.spec.json'), spec);
      L.log(`  entry ${id}: ${e.design} ${JSON.stringify(e.values ?? {})}${bible ? ` in ${sc.bible}'s roles` : ''} -> ${dir}`);
    }
  }
}

/**
 * (6c V, CONTRACT V §7 item 4) After the realise: each placed lot's door cell (the placed site's entrance anchor, through
 * DevBridge) and, for every villager lot, vanilla's villager path from it to the bell (dev.nav.villager: a no-AI villager,
 * FOLLOW_RANGE raised over the claim). Writes nav.json.
 */
async function villageNav(sc, region, ir, out) {
  const st = await L.call('dev.region.state', { region }, 60_000);
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'raw', 'plan', 'meta.json'), 'utf8'));
  const bell = ir.anchors.bell;
  const range = Math.max(ir.claim.maxX - ir.claim.minX, ir.claim.maxZ - ir.claim.minZ) + 32;
  const lots = {};
  for (const l of st.view.lots ?? []) {
    const v = meta.village?.lots?.[l.id];
    const o = { state: l.state, siteId: l.siteId ?? null, villager: v?.villager ?? null };
    if (l.siteId) {
      const a = await L.call('dev.site.anchors', { site: l.siteId }, 30_000);
      const e = a.anchors?.entrance;
      if (e) o.door = [Math.floor(e.x), Math.round(e.y), Math.floor(e.z)];
      o.box = a.box;
    }
    if (o.door && ['dwelling', 'job', 'trading_hall', 'farm'].includes(o.villager)) {
      const n = await L.call('dev.nav.villager', { from: o.door, to: bell, range }, 120_000);
      Object.assign(o, { canReach: !!n.canReach, nodes: n.nodes, end: n.end ?? null });
    }
    lots[l.id] = o;
  }
  const nav = { bell, range, lots };
  fs.writeFileSync(path.join(out, 'nav.json'), `${JSON.stringify(nav, null, 2)}\n`);
  return nav;
}

/** yaw/pitch (Minecraft: yaw 0 = +z, 90 = -x) from an eye at `a` looking at `b`. */
export function look(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const yaw = Math.round((Math.atan2(-dx, dz) * 180) / Math.PI * 10) / 10;
  const pitch = Math.round((-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI * 10) / 10;
  return [yaw, pitch];
}

async function pin(id) {
  await lib();
  await L.connect();
  const sc = readSc(id);
  if (!sc.fixture?.claim) throw new Error(`${id}: the fixture is not pinned (node tools/gate6b.mjs findsite ${id})`);
  const seed = sc.seed ?? BigInt.asUintN(64, BigInt(`0x${sha256(`${sc.id}@${sc.world.seed}`).slice(0, 16)}`)).toString();
  if (isV(sc) || isS2(sc) || isS3(sc)) await prepV(sc); // (6c S2) its fixture bible and lot entries, as S7's (6c S3: S3's too)
  await L.fresh(`G6B Pin ${short(sc)}`, await L.seedBase(sc.world.seed));
  const c = sc.fixture.claim;
  await L.tp((c[0] + c[2]) / 2, sc.fixture.yRange[1], (c[1] + c[3]) / 2);
  const p = await L.plan(sc.program, c, { params: sc.params, surveyLoad: 'bounded:256', seed, bible: sc.bible ?? undefined });
  const ir = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', p.planId, 'ir.json'), 'utf8'));
  const anchors = ir.anchors;
  const hub = anchors.hub ?? anchors.entrance;
  const cams = {};
  for (const [n, a] of Object.entries(anchors).filter(([k]) => k.startsWith('cam_')).sort()) {
    const target = [hub[0], hub[1] - 6, hub[2]];
    const [yaw, pitch] = look([a[0] + 0.5, a[1], a[2] + 0.5], target);
    // the ground camera looks up at the islands at a walker's angle, not straight up the tower
    cams[n] = [a[0] + 0.5, a[1], a[2] + 0.5, yaw, n === 'cam_ground' ? Math.max(pitch, -28) : pitch];
  }
  const lotEntries = isV(sc) || isS2(sc) || isS3(sc) ? Object.fromEntries(ir.lots.map((l) => [l.id, sc.entryFor[l.id]])) : fitEntries(ir.lots);
  Object.assign(sc, { seed, cams, lotEntries });
  sc.fixture.irShaAtPin = p.irSha;
  writeSc(sc);
  await L.leaveWorld();
  return { seed, cams, lotEntries, irSha: p.irSha };
}

async function runScenario(id) {
  await lib();
  L.refuseKeys();
  await L.connect();
  const sc = readSc(id);
  const flat = !!opt('flat');
  const phase = opt('phase', '6b');
  // (6c W) `--bible <id>`: the run with another fixture bible (scenarios/bibles/<id>.json, installed as bible <id> v1): the W path
  // bibles and the gallery's looks. Its runs go to <phase>/<short>-<id>/; its golden row compares with S7's own golden (recorded).
  const bibleOpt = opt('bible');
  if (bibleOpt) { sc.bible = bibleOpt; sc.bibleFixture = `bibles/${bibleOpt}.json`; }
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}${flat ? '-flat' : ''}`;
  const out = path.resolve(opt('out') || path.join(ART, phase, bibleOpt ? `${short(sc)}-${bibleOpt}` : short(sc), runId));
  const raw = path.join(out, 'raw');
  fs.mkdirSync(raw, { recursive: true });
  const t = {};
  const T = (k, t0) => { t[k] = (Date.now() - t0) / 1000; };
  const c = sc.fixture.claim;
  const off = flat ? sc.flat.claimOffset : [0, 0];
  const claim = [c[0] + off[0], c[1] + off[1], c[2] + off[0], c[3] + off[1]];
  const cams = Object.fromEntries(Object.entries(sc.cams).map(([k, v]) => [k, [v[0] + off[0], v[1], v[2] + off[1], v[3], v[4]]]));
  L.log(`== scenario ${sc.id} ${flat ? 'flat' : 'natural'} run ${runId} -> ${out}`);
  if (isV(sc) || isS2(sc) || isS3(sc)) await prepV(sc);
  let t0 = Date.now();
  await L.fresh(`G6B Scn ${short(sc)}${flat ? ' Flat' : ''}`, flat ? FLAT : await L.seedBase(sc.world.seed));
  await L.setRules(flat ? 'exact' : 'gallery');
  await L.tp((claim[0] + claim[2]) / 2, sc.fixture.yRange[1], (claim[1] + claim[3]) / 2);
  T('world', t0);
  // plan (kept), prepare, the realised plan (+2 for the IR sha)
  t0 = Date.now();
  const bible = sc.bible ?? undefined;
  // (6c T2) the owner's protected areas (natural run): the plans read them as keep-out; removed again after the undo
  const owner = isT2(sc) ? sc.owner : undefined;
  const protect = isT2(sc) && !flat ? sc.protect ?? [] : [];
  for (const a of protect) { await apitest(`unprotect ${owner} ${a.id}`).catch(() => null); await apitest(`protect ${JSON.stringify({ owner, ...a }).replaceAll(' ', '_')}`); }
  const p1 = await L.plan(sc.program, claim, { params: sc.params, surveyLoad: 'bounded:256', seed: sc.seed, bible, owner });
  T('plan', t0);
  t0 = Date.now();
  const pr = await L.prepare(p1.planId);
  T('prepare', t0);
  // (6c S3, CONTRACT S3 §6) S3's plans read a survey taken after the 90 s settle: the claim's spring stream starts only once a fresh
  // copy's chunks tick, so a survey before the settle never holds it (its columns are then no water to the plan, and a fill can bury
  // the feeder: T1's falling-water failures). The flat variant's hill is raised first (vanilla /fill, natural land: the base world)
  let hill = null;
  if (isS3(sc)) {
    if (flat) { t0 = Date.now(); hill = await (await import('./lib/scenario-s3.mjs')).raiseHill(L, claim, sc); T('hill', t0); }
    await L.tp((claim[0] + claim[2]) / 2, sc.fixture.yRange[1], (claim[1] + claim[3]) / 2);
    t0 = Date.now();
    await L.settle(90_000);
    T('settleBeforePlan', t0);
  }
  // (6c F1) a plan that reads a frozen volume of a live world (forms_demo keeps the natural ice) sees the world's own changes between
  // plans (a plant breaking, water freezing): the three plans of the IR sha check run with the world's ticking frozen (/tick freeze)
  // (6c T1) relief_demo's land too: S3's flowing water moves the plan survey between plans
  const freeze = isF1(sc) || isT1(sc) || isF2(sc) || isT2(sc) || isD(sc) || isS2(sc) || isS3(sc); // (6c F2) scatter_demo reads the frozen volume; (6c T2) route_demo on S3; (6c D1) districts_demo too; (6c S2) the outpost reads S2's frozen volume too
  if (freeze) await L.cmd('/tick freeze');
  let p2, irShas;
  try {
    p2 = await L.plan(sc.program, claim, { params: sc.params, surveyLoad: 'generated:64', seed: sc.seed, bible, owner });
    irShas = [p2.irSha];
    for (let i = 0; i < 2; i++) irShas.push((await L.plan(sc.program, claim, { params: sc.params, surveyLoad: 'generated:64', seed: sc.seed, bible, owner })).irSha);
  } finally {
    if (freeze) await L.cmd('/tick unfreeze');
  }
  const planDir = copyPlan(p2.planId, path.join(raw, 'plan'));
  fs.copyFileSync(path.join(planDir, 'report.json'), path.join(out, 'report.json'));
  fs.mkdirSync(path.join(out, 'previews'), { recursive: true });
  for (const f of fs.readdirSync(path.join(planDir, 'previews'))) fs.copyFileSync(path.join(planDir, 'previews', f), path.join(out, 'previews', f));
  fs.copyFileSync(path.join(planDir, 'siteplan.json'), path.join(out, 'previews', 'siteplan.json'));
  fs.copyFileSync(path.join(planDir, 'summary.txt'), path.join(out, 'summary.txt'));
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  // (6c W) a close-up camera on the first apron lamp (the lamp look for the gallery): 4 out and 2 up, on the side away from its lot
  if (!flat) {
    const pm = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
    const lamp = (pm.village?.props ?? []).find((p) => p.kind === 'apron_lamp');
    if (lamp) {
      const [lx, ly, lz] = lamp.cells[0];
      const lot = ir.lots.find((l) => l.id === lamp.lot)?.box;
      const sx = lot && lx < (lot.minX + lot.maxX) / 2 ? -1 : 1, sz = lot && lz < (lot.minZ + lot.maxZ) / 2 ? -1 : 1;
      const eye = [lx + 0.5 + 4 * sx, ly + 2.6, lz + 0.5 + 4 * sz];
      const [yaw, pitch] = look(eye, [lx + 0.5, ly + 1, lz + 0.5]);
      cams.cam_lamp = [...eye, yaw, pitch];
    }
  }
  // the box: the claim + 8 over the written y span +-8 (the plan's virtual world and its lots), as 6a's exactness box
  const ys = await writtenY(planDir, ir);
  const box = [claim[0] - 8, ys[0] - 8, claim[1] - 8, claim[2] + 8, ys[1] + 8, claim[3] + 8];
  // the prepared chunks tick a while first (fresh chunks settle fluids and schedule their first block ticks), player at the centre
  await L.tp((claim[0] + claim[2]) / 2, sc.fixture.yRange[1], (claim[1] + claim[3]) / 2);
  // (gate waits, 2026-10-20) until no simulated chunk holds a scheduled block or fluid tick for 10 s and the claim's chunks (+ 48)
  // tick, at most the 90 s it always waited (run.json `settle`)
  const settled = await L.settleQuiet([claim[0] - 48, claim[1] - 48, claim[2] + 48, claim[3] + 48], { capMs: 90_000 });
  // the pristine cameras, then the before dump and the snap
  let before = null;
  // (6c F2) on a headless host (docs/GATES.md "Headless gates") there is no camera: a scenario without a gallery bar (F2) runs
  // there without its shots (recorded in run.json); every other scenario keeps the client
  const headless = (await L.call('dev.state').catch(() => ({}))).headless === true;
  // (6c S2) S2's flat variant takes no shots either (docs/GATES.md "Headless gates": only the gallery's shots stay on a client)
  if (headless && !isF2(sc) && !isD(sc) && !((isS2(sc) || isS3(sc)) && flat)) throw new Error('this scenario shoots its cameras: run it on a client (only F2\'s and D\'s scenarios and S2\'s flat variant run headless)');
  const shotsOn = !flat && !headless;
  if (shotsOn) { t0 = Date.now(); before = await shoot(cams, path.join(out, 'before')); T('beforeShots', t0); }
  await L.tp((claim[0] + claim[2]) / 2, sc.fixture.yRange[1], (claim[1] + claim[3]) / 2);
  t0 = Date.now();
  const d0 = await L.call('dev.region.dump', { box, file: path.join(raw, 'before.arwd.gz') }, 1_800_000);
  const snap = await L.call('dev.region.hash', { box, mode: 'snap', file: path.join(raw, 'snap.gz') }, 4 * 3_600_000);
  T('beforeDump', t0);
  if (d0.refused) throw new Error(`dump refused: ${d0.refused}`);
  // (6c T2) a lot waiting OCCUPIED holds a mob in its box (4e's rule: it would be buried) and waits for it to leave; on S3 a rabbit
  // in lot:hall stalled a fresh world's run for 33 minutes. Clear the mobs just before placing and whenever an item waits OCCUPIED,
  // as gate6a's megaA driver does (entities only: no block changes, so the snapshot and the exactness are untouched); run.json
  // records `mobs` (the pre-place clear, the OCCUPIED clears and their waits)
  // (gate speed, 2026-10-17) every scenario now: K1a's 6cv-scenario-s7 burned its whole 60-minute timeout on lot:hall_1 waiting
  // OCCUPIED for a horse (client log: "in the box: horse (move them out)"), then passed on re-run. A killed mob drops its loot, which
  // is an entity in the box too, so the drops go a second later. A PLAYER_IN_BOX wait moves the player 32 blocks up (it stands at
  // the claim centre at the top of the y range; the claim itself is never touched).
  const mobs = { beforePlace: true, occupiedClears: 0, playerMoves: 0, waits: [] };
  const clearAll = async () => {
    await L.cmd('/kill @e[type=!minecraft:player]');
    await L.settle(1000);
    await L.cmd('/kill @e[type=minecraft:item]');
    await L.cmd('/kill @e[type=minecraft:experience_orb]');
  };
  await clearAll();
  // (6c S3) bar 11: the bodies' boxes censused before the realise (the world's own water there is not the fountain's)
  const fBefore = isS3(sc) && !flat ? await (await import('./lib/scenario-s3.mjs')).fluidsBefore(L, ir) : null;
  // realise
  await L.call('dev.mspt.trace', { start: true });
  await L.call('dev.placement.stats', { reset: true });
  t0 = Date.now();
  const region = await L.realise(p2.planId, { lots: sc.lotEntries });
  const st = await L.waitRegion(region, 3 * 3_600_000, async (s) => {
    if (s.waiting?.OCCUPIED) { mobs.occupiedClears++; if (mobs.waits.length < 20) mobs.waits.push(s.waiting); L.log(`  ${region}: an item waits OCCUPIED (${JSON.stringify(s.waiting)}): clearing the mobs`); await clearAll(); }
    if (s.waiting?.PLAYER_IN_BOX) { mobs.playerMoves++; if (mobs.waits.length < 20) mobs.waits.push(s.waiting); L.log(`  ${region}: an item waits PLAYER_IN_BOX: moving the player 32 blocks up`); await L.tp((claim[0] + claim[2]) / 2, sc.fixture.yRange[1] + 32, (claim[1] + claim[3]) / 2); }
  });
  if (mobs?.occupiedClears) L.log(`  mobs cleared ${mobs.occupiedClears}x while placing`);
  T('realise', t0);
  const mspt = await L.call('dev.mspt.trace', { stop: true });
  // (6b, coordinator 2026-10-10) the judged bar is Architect's own per-tick time; the whole tick, the vanilla tick and GC are recorded
  const pst = await L.call('dev.placement.stats', {});
  mspt.architect = { placementCpuMsMax: pst.placementCpuMsMax, placementMsMax: pst.placementMsMax, placementMsMean: pst.placementMsMean, serverMsptMax: pst.serverMsptMax, msptMax: pst.msptMax };
  const rec = st.record;
  const cps = rec.stats?.firstTileAt && rec.stats?.lastTileAt ? rec.cellsWritten / ((rec.stats.lastTileAt - rec.stats.firstTileAt) / 1000) : null;
  L.log(`  ${region} ${st.view.state}: ${rec.cellsWritten} cells, MSPT ${JSON.stringify(mspt.all)}, lots ${JSON.stringify(st.view.lots.map((l) => l.state))}`);
  t0 = Date.now();
  const d1 = await L.call('dev.region.dump', { box, file: path.join(raw, 'after.arwd.gz') }, 1_800_000);
  T('afterDump', t0);
  // (6c S3) bar 11: the fountain settled and its census against its prediction, right after the realise
  if (fBefore) { t0 = Date.now(); const cen = await (await import('./lib/scenario-s3.mjs')).fountainCensus(L, region, ir, fBefore); fs.writeFileSync(path.join(out, 'census.json'), `${JSON.stringify(cen, null, 2)}\n`); T('census', t0); }
  // (6c V) the door cells and vanilla's villager paths, before the stand
  if (isV(sc)) { t0 = Date.now(); await villageNav(sc, region, ir, out); T('nav', t0); }
  // (6c T2) vanilla's villager path along every villager edge, both ways
  if ((isT2(sc) || isD(sc) || isS2(sc) || isS3(sc)) && !flat) { t0 = Date.now(); await (await import('./lib/scenario-route.mjs')).routeNav(L, JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8')), ir, out); T('nav', t0); }
  // the stand and the cameras (natural only)
  let shots = null;
  if (!flat) {
    t0 = Date.now();
    await L.settle(120_000);
    T('stand', t0);
    // (6c F1) the world after the stand: M17 on the realised world and the melt across the stand
    if (isF1(sc) || isF2(sc) || isS2(sc) || isS3(sc)) { t0 = Date.now(); await L.call('dev.region.dump', { box, file: path.join(raw, 'after-stand.arwd.gz') }, 1_800_000); T('standDump', t0); }
    if (shotsOn) {
      t0 = Date.now();
      shots = await shoot(cams, path.join(out, 'shots'));
      T('shots', t0);
    } else shots = { skipped: 'headless host (no camera); F2 has no gallery bar' };
  }
  // the group undo and the exactness diff
  await L.tp((claim[0] + claim[2]) / 2, sc.fixture.yRange[1], (claim[1] + claim[3]) / 2);
  await L.cmd('/kill @e[type=!minecraft:player]');
  await L.settle(5000);
  t0 = Date.now();
  const rm = await L.call('dev.region.remove', { region, ...(owner ? { requester: owner } : {}) }, 4 * 3_600_000);
  T('remove', t0);
  await L.settle(10_000);
  const diff = await L.call('dev.region.hash', { box, mode: 'diff', file: path.join(raw, 'snap.gz') }, 4 * 3_600_000);
  // ((6c S3) S3 keeps every listed mismatch: its classes narrow growth to unwritten cells, so each one is read)
  const exact = { kind: flat ? 'E-flat' : 'E-normal', box, cellsWritten: rec.cellsWritten, removed: rm.removed, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes, list: isS3(sc) ? [...(diff.list ?? [])] : [...(diff.list ?? []).filter((m) => m.class !== 'growth'), ...(diff.list ?? []).filter((m) => m.class === 'growth').slice(0, 50)], listTotal: (diff.list ?? []).length };
  fs.writeFileSync(path.join(out, 'exact.json'), `${JSON.stringify(exact, null, 2)}\n`);
  for (const a of protect) await apitest(`unprotect ${owner} ${a.id}`).catch(() => null);
  await L.leaveWorld();
  const lotStates = (st.view.lots ?? []).map((l) => ({ id: l.id, state: l.state }));
  const metrics = await computeMetrics({ sc, out, planDir, ir, irShas, mspt, cps, exact, flat, lotStates });
  const gp = fs.readFileSync(path.join(root, 'mod', 'gradle.properties'), 'utf8');
  const api = /String VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(root, 'mod', 'src', 'main', 'java', 'dev', 'larattalabs', 'architect', 'api', 'ArchitectApi.java'), 'utf8'))?.[1];
  const hello = await L.call('dev.state').catch(() => ({}));
  const run = {
    scenario: sc.id, version: sc.version, phase, runId, settle: settled, variant: flat ? 'flat' : 'natural', bible: sc.bible ?? null, worldSeed: sc.world.seed, programSeed: sc.seed, claim, irSha: p2.irSha, irShas,
    planId: p2.planId, region, state: st.view.state, cellsWritten: rec.cellsWritten, lots: sc.lotEntries,
    versions: { mod: /mod_version\s*=\s*(\S+)/.exec(gp)?.[1], api, kit: ir.kitVersion, sidecar: hello.sidecar?.version ?? hello.sidecarVersion ?? null, minecraft: /minecraft_version\s*=\s*(\S+)/.exec(gp)?.[1], node: process.versions.node.split('.')[0], head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim() },
    wallSeconds: t, prepare: pr.stats ?? null, dumps: { before: { sha: d0.sha, cells: d0.cells }, after: { sha: d1.sha, cells: d1.cells } }, snap: { cells: snap.cells }, before, shots,
    spendUsd: 0, lotStates, mobs, ...(hill ? { hill } : {}),
  };
  fs.writeFileSync(path.join(out, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  const ev = evidenceSha(out);
  fs.writeFileSync(path.join(out, 'evidence.sha'), `${ev.sha}\n`);
  L.log(`== scenario ${sc.id} run ${runId}: evidence ${ev.sha.slice(0, 12)}; ${metrics.rows.filter((r) => r.gated && !r.pass).map((r) => r.id).join(', ') || 'every run bar passes'}`);
  return { out, runId, evidence: ev.sha, metrics };
}

/** The metrics of a run directory (also `scenarios.mjs metrics <runDir>` to recompute after a kit fix). */
async function computeMetrics({ sc, out, planDir, ir, irShas, mspt, cps, exact, flat, lotStates = null }) {
  const { decodeArwd, dumpWorld, buildVirtual, F_WRITTEN } = await import('../kit/lib/region/vworld.mjs');
  const { sampleIndex: sampleIndexOf } = await import('../kit/lib/region/survey.mjs');
  const { checkRegion } = await import('../kit/lib/region/check.mjs');
  const M = await import('./lib/scenario-metrics.mjs');
  const raw = path.join(out, 'raw');
  const survey = fs.readFileSync(path.join(planDir, 'survey.bin'));
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const { vw } = buildVirtual({ ir, survey, blobs });
  const before = await decodeArwd(fs.readFileSync(path.join(raw, 'before.arwd.gz')));
  const after = await decodeArwd(fs.readFileSync(path.join(raw, 'after.arwd.gz')));
  const world = dumpWorld(before, after, ir.claim, { virtual: vw, lots: ir.lots });
  const realised = checkRegion({ ir, meta, world, prefix: false, ...(isF1(sc) || isF2(sc) || isS2(sc) || isS3(sc) ? { blobs } : {}) });
  fs.writeFileSync(path.join(out, 'realised-report.json'), `${JSON.stringify(realised, null, 1)}\n`);
  const palette = M.paletteAdherence(ir, world);
  const organic = M.axisRunShare(ir, vw);
  const lib6 = L ?? await lib();
  const buildings = [];
  for (const entry of [...new Set(Object.values(sc.lotEntries).map((e) => e.replace(/@\d+$/, '')))].sort()) { // (6c V) entry@version pins
    const dir = path.join(lib6.LIBRARY, entry);
    let j;
    try { j = JSON.parse(execFileSync('node', [path.join(root, 'kit', 'check.mjs'), path.join(dir, `${entry}.nbt`), path.join(dir, `${entry}.blueprint.json`), '--json', '--restraint', sc.restraint ?? 'rustic']).toString().trim().split('\n').pop()); } catch (e) { j = JSON.parse(String(e.stdout ?? '{}').trim().split('\n').pop() || '{"errors":["unreadable"]}'); }
    // the bar reads detailNoise and accentShare against the restraint (as 5a); other restraint lines are recorded only
    const rw = (j.warnings ?? []).filter((w) => w.startsWith('restraint'));
    buildings.push({ entry, errors: (j.errors ?? []).length, errorList: j.errors ?? [], restraint: rw.filter((w) => /detail ?noise|accent/i.test(w)), restraintOther: rw.filter((w) => !/detail ?noise|accent/i.test(w)), metrics: { detailNoise: j.metrics?.detailNoise ?? null, accentShare: j.metrics?.accentShare ?? null } });
  }
  const ts = await tileShas(planDir, { timingPasses: isF1(sc) || isT1(sc) || isF2(sc) || isT2(sc) || isD(sc) || isS2(sc) || isS3(sc) ? 3 : 1 });
  const gFile = path.join(SCEN, 'goldens', `${short(sc)}.json`);
  let golden = 'none';
  if (fs.existsSync(gFile)) {
    const g = JSON.parse(fs.readFileSync(gFile, 'utf8'));
    // the bar is on the tiles: an IR that differs only by its recorded kitVersion (6c V's kit 0.16.0 over a golden cut by 0.12.0)
    // matches when every tile sha does
    const runKit = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8')).kitVersion;
    const sameTiles = JSON.stringify(g.tiles) === JSON.stringify(ts.tiles);
    // (6c F1) a plan that reads a frozen volume of the live world (forms_demo's kept ice) records that volume's sha: a fresh world
    // copy differs by a few natural cells (plants, water), so with every tile sha equal and the IR equal but for its volume blobs,
    // the golden matches
    const noVol = (j) => { const o = JSON.parse(JSON.stringify(j)); for (const [n, b] of Object.entries(o.blobs ?? {})) if (b.kind === 'volume') delete o.blobs[n]; delete o.volumes; return JSON.stringify(o); };
    const gIr = fs.existsSync(path.join(SCEN, 'goldens', short(sc), 'ir.json')) ? JSON.parse(fs.readFileSync(path.join(SCEN, 'goldens', short(sc), 'ir.json'), 'utf8')) : null;
    const volOnly = sameTiles && gIr && noVol(gIr) === noVol(JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8')));
    golden = sameTiles && g.irSha === ts.irSha ? 'match'
      : volOnly ? 'match (every tile sha; the IR differs only by its frozen volume of the live world)'
      : sameTiles && g.kitVersion && g.kitVersion !== runKit ? `match (every tile sha; the IR sha differs by its kitVersion ${g.kitVersion} -> ${runKit})`
        : `differs (golden ${g.irSha.slice(0, 12)}, run ${ts.irSha.slice(0, 12)}${sameTiles ? '' : '; tile shas differ'})`;
    // (6c T1) relief_demo plans from the live world's survey (S3: flowing water, plants and leaves move a fresh copy's survey, and the
    // program picks its sites from it), so a run whose plan survey differs from the golden's can't reproduce its IR. Then the row
    // holds the golden itself: its committed inputs re-plan to its IR sha and every tile sha (1 = 4 workers), and it records how far
    // the run's survey is from the golden's
    const gDir = path.join(SCEN, 'goldens', short(sc));
    if ((isT1(sc) || isT2(sc) || isD(sc) || isS2(sc) || isS3(sc)) && golden.startsWith('differs') && fs.existsSync(path.join(gDir, 'survey.bin'))) { // (6c T2: route_demo on S3 too; 6c D1: districts_demo; 6c S2: the outpost reads a live survey and frozen volume)
      const runSurvey = fs.readFileSync(path.join(planDir, 'survey.bin')), gSurvey = fs.readFileSync(path.join(gDir, 'survey.bin'));
      if (sha256(runSurvey) !== sha256(gSurvey)) {
        const { asColumns } = await import('../kit/lib/region/pack.mjs');
        const ra = asColumns(runSurvey), ga = asColumns(gSurvey);
        let cols = 0;
        for (let i = 0; i < ra.ground.length; i++) if (ra.ground[i] !== ga.ground[i] || ra.flags[i] !== ga.flags[i] || ra.height[i] !== ga.height[i]) cols++;
        const { planRegion } = await import('../kit/lib/region/plan.mjs');
        const gIr = JSON.parse(fs.readFileSync(path.join(gDir, 'ir.json'), 'utf8'));
        // (6c S2) with the golden's committed frozen volumes (its keep sets read them)
        const gVols = gIr.volumes ? await irVolumesIn(gIr, path.join(gDir, 'blobs')) : [];
        // ((6c S3) a golden that kept its plan's biome grid and bible fluids (biomes.json, bible.json: the fountain reads both) re-plans with them)
        const gBiomes = fs.existsSync(path.join(gDir, 'biomes.json')) ? JSON.parse(fs.readFileSync(path.join(gDir, 'biomes.json'), 'utf8')) : null;
        const gFluids = fs.existsSync(path.join(gDir, 'bible.json')) ? JSON.parse(fs.readFileSync(path.join(gDir, 'bible.json'), 'utf8')).fluids ?? null : null;
        const re = await planRegion({ programFile: path.join(root, 'kit', 'regions', `${gIr.id}.mjs`), params: gIr.params, survey: gSurvey, seed: gIr.seed, claim: { ...gIr.claim, minY: -64, maxY: 319 }, roles: gIr.roles, kitVersion: gIr.kitVersion, keepOut: gIr.keepOut ?? [], ...(gVols.length ? { volumes: gVols } : {}), ...(gBiomes ? { biomes: gBiomes } : {}), ...(gFluids ? { fluids: gFluids } : {}) }); // (6c F2) the golden's own recorded kit: a later slice's KIT_VERSION bump alone moves no planner output
        const gts = await tileShas(gDir);
        const ok = re.irSha === g.irSha && gts.irSha === g.irSha && gts.workersSame && JSON.stringify(gts.tiles) === JSON.stringify(g.tiles);
        golden = ok ? `match (the golden's committed inputs re-plan to its IR ${g.irSha.slice(0, 12)} and its ${Object.keys(g.tiles).length} tile shas; this run's live survey differs from the golden's in ${cols} columns, so its IR ${ts.irSha.slice(0, 12)} is its own)`
          : `differs (the golden's inputs re-plan to ${re.irSha.slice(0, 12)}, golden ${g.irSha.slice(0, 12)})`;
      }
    }
  }
  // (6c F2) the committed golden is the stamps-off plan of a run's own survey (N-F2-1: no vanilla stamp in the repo): the row holds
  // the golden itself (its committed inputs re-plan to its IR sha and its tile shas, as T1's); this run's IR, with the local stamps,
  // is its own (its determinism: the IR sha over 3 plans and 1 vs 4 workers). A fixture without a golden (`sc.golden: false`) says so.
  if (isF2(sc)) golden = sc.golden === false ? 'none (this fixture keeps no golden: scatter_demo\'s is the slice\'s)' : await f2Golden(sc, ts);
  // the other variant's exactness (E-flat from the latest flat run beside a natural one, and back)
  const sibling = latestRun(sc, out, !flat);
  const exactOther = sibling ? JSON.parse(fs.readFileSync(path.join(sibling, 'exact.json'), 'utf8')) : null;
  // (6c F1) the world's own freezing during the stand: an unclassified mismatch where still water became ice (or a snow layer
  // fell) at a cell the plan never writes is the cold biome's doing, not the undo's: classed `freeze` (a world class)
  const freezeOf = (e) => (!e || flat || !(isF1(sc) || isF2(sc) || isS2(sc) || isS3(sc)) || !(e.classes?.none > 0) ? e : freezeClass(e, vw, F_WRITTEN));
  // (6c T1) the world's flowing water: an unclassified mismatch where the snapshot held flowing (non-source) water and the world now
  // holds air is a stream that moved between the snapshot and the write (SETTLEMENTS §4.2: flowing water is outside E-normal), classed
  // `flow` (a world class); the plan never places flowing water
  // (6c H §4.5) narrowed to D2's rule, so no class can hide a fluid undo error: only at a cell the plan never writes, more than 6 columns
  // from every written column (`far`), or more than 8 below the surveyed ground and every written cell within 6 columns (`deep`)
  const away = awayFromWrites(vw, sampleIndexOf);
  const flowOf = (e) => (!e || flat || !(isT1(sc) || isT2(sc) || isD(sc) || isS2(sc) || isS3(sc)) || !(e.classes?.none > 0) ? e : flowClass(e, vw, F_WRITTEN, away));
  // (6c F2) the world's own changes far from every cell the plan writes: an unclassified mismatch at a cell the plan never writes,
  // in no lot box, 8 or more (Manhattan) from every written cell, is classed `distant` (a world class): the undo writes only the
  // journal's cells, so it can't reach there (the cave fixture's lava still settling, leaves re-counting their distance)
  const distantOf = (e) => {
    if (!e || flat || !isF2(sc) || !(e.classes?.none > 0)) return e;
    const wr = new Set();
    vw.eachWritten((x, y, z) => { wr.add(`${x},${y},${z}`); });
    const near = (x, y, z) => {
      for (let dx = -7; dx <= 7; dx++) for (let dy = -7 + Math.abs(dx); dy <= 7 - Math.abs(dx); dy++) {
        const r = 7 - Math.abs(dx) - Math.abs(dy);
        for (let dz = -r; dz <= r; dz++) if (wr.has(`${x + dx},${y + dy},${z + dz}`)) return true;
      }
      return false;
    };
    const inLot = (x, y, z) => (ir.lots ?? []).some((l) => x >= l.box.minX && x <= l.box.maxX && y >= l.box.minY && y <= l.box.maxY && z >= l.box.minZ && z <= l.box.maxZ);
    // only the kinds the world does on its own far away: fluids settling (water or lava on either side), cobblestone, stone or
    // obsidian a fluid made, and leaves re-counting their distance (the same leaves, only `distance` differs) or decaying (distance 7,
    // not persistent, to air); anything else stays
    // unclassified, so a far change of another kind can never hide an undo error
    const name = (st) => String(st).replace(/\[.*$/, '');
    const fluid = (st) => /^minecraft:(water|lava|flowing_water|flowing_lava)$/.test(name(st));
    const leafDistance = (a, b) => {
      if (name(a) !== name(b) || !/_leaves$/.test(name(a))) return false;
      const strip = (st) => String(st).replace(/distance=\d+,?/, '');
      return strip(a) === strip(b);
    };
    // (leaf decay is the end of a distance change: non-persistent leaves at distance 7 turning to air)
    const leafDecay = (a, b) => /_leaves\[/.test(String(a)) && /distance=7/.test(String(a)) && /persistent=false/.test(String(a)) && name(b) === 'minecraft:air';
    const worldKind = (m) => fluid(m.was) || fluid(m.now) || (/^minecraft:(cobblestone|stone|obsidian)$/.test(name(m.now)) && /^minecraft:(air|cave_air|water|lava)$/.test(name(m.was))) || leafDistance(m.was, m.now) || leafDecay(m.was, m.now);
    const moved = (e.list ?? []).filter((m) => { if (m.class !== 'none') return false; const [x, y, z] = m.pos.split(',').map(Number); return worldKind(m) && !(vw.flags(x, y, z) & F_WRITTEN) && !inLot(x, y, z) && !near(x, y, z); });
    if (!moved.length) return e;
    const classes = { ...e.classes, none: e.classes.none - moved.length, distant: (e.classes.distant ?? 0) + moved.length };
    return { ...e, classes, list: e.list.map((m) => (moved.includes(m) ? { ...m, class: 'distant' } : m)) };
  };
  // (6c F2) amethyst growth (the world's own random ticks on a budding block): an unclassified mismatch where air or cave air
  // became a small, medium or large amethyst bud or a cluster, at a cell the plan never writes, is classed `amethyst` (a world
  // class, by what the change is)
  const amethystOf = (e) => {
    if (!e || flat || !isF2(sc) || !(e.classes?.none > 0)) return e;
    const moved = (e.list ?? []).filter((m) => { if (m.class !== 'none') return false; const [x, y, z] = m.pos.split(',').map(Number);
      return /^minecraft:(air|cave_air)$/.test(m.was) && /^minecraft:(small_amethyst_bud|medium_amethyst_bud|large_amethyst_bud|amethyst_cluster)(\[|$)/.test(m.now) && !(vw.flags(x, y, z) & F_WRITTEN); });
    if (!moved.length) return e;
    const classes = { ...e.classes, none: e.classes.none - moved.length, amethyst: (e.classes.amethyst ?? 0) + moved.length };
    return { ...e, classes, list: e.list.map((m) => (moved.includes(m) ? { ...m, class: 'amethyst' } : m)) };
  };
  // (6c T2) the region's lamps melting the world's snow: an unclassified mismatch where the snapshot held a snow layer and the world
  // now holds air, at a cell the plan never writes (any written cell stays unclassified: snow in the snapshot, a write there and air
  // after the undo is exactly the shape of an undo error), lit over 11 (vanilla's snow melt) by a light the plan placed (block light
  // from the plan's emitters, unoccluded: emission minus the Manhattan distance), is classed `melt` (a world class: the undo restores
  // the cells the plan wrote; a melted layer was never one). The lamps cannot see snow at plan time (the survey has no snow layers).
  const meltOf = (e) => (!e || flat || !(isT2(sc) || isD(sc) || isS2(sc) || isS3(sc)) || !(e.classes?.none > 0) ? e : meltClass(e, vw, F_WRITTEN));
  // (6c S3, CONTRACT S3 §6) S3's natural run: s3Classify (the mod's growth, grazed and live only at unwritten cells; freeze, flow and melt
  // by kind; farfluid; nothing within 6 of a body classed)
  const exN = !flat && isS3(sc) ? s3Classify(exact, { vw, ir, F_WRITTEN, sampleIndexOf }) : meltOf(distantOf(amethystOf(flowOf(freezeOf(exact)))));
  const ex = flat ? { flat: exact, normal: exactOther, cellsWritten: exactOther?.cellsWritten ?? 0 } : { flat: exactOther, normal: exN, cellsWritten: exact.cellsWritten };
  const plan = { report: JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')) };
  let rows = M.bars({ plan, realised, palette, organic, buildings, mspt, cellsPerSecond: cps, exact: ex, determinism: { irShas, workersSame: ts.workersSame, golden }, spendUsd: 0, approval: 'pending' });
  // (6c F1) forms_demo's own bars: melt across the stand, kept cells, voxels, tile evaluation
  let forms = null;
  if (isF1(sc)) {
    const F = await import('./lib/scenario-forms.mjs');
    const standFile = path.join(raw, 'after-stand.arwd.gz');
    const stand = fs.existsSync(standFile) ? await decodeArwd(fs.readFileSync(standFile)) : null;
    const realisedStand = stand ? checkRegion({ ir, meta, world: dumpWorld(before, stand, ir.claim, { virtual: vw, lots: ir.lots }), prefix: false, blobs }) : null;
    if (realisedStand) fs.writeFileSync(path.join(out, 'realised-stand-report.json'), `${JSON.stringify({ ...realisedStand, _world: undefined }, null, 1)}\n`);
    const melt = stand ? F.meltAcrossStand(after, stand, F.plannedLights(vw)) : null;
    const kept = F.keptDiff(ir, F.planVolumes(planDir, ir), before, after);
    const voxels = F.voxelsExact(ir, planDir, after);
    const organicPer = {};
    for (const gname of [...new Set((ir.forms ?? []).map((f) => f.generator))]) organicPer[gname] = M.axisRunShare({ ...ir, forms: ir.forms.filter((f) => f.generator === gname), floating: [] }, vw).share;
    rows = F.formsBars({ plan, realised, realisedStand, melt, kept, voxels, organic, organicPer, workersSame: ts.workersSame, tiles: ts.timing, mspt, load1: Math.round((await import('node:os')).loadavg()[0] * 10) / 10 }, rows);
    forms = { melt, kept, voxels, organicPer, tiles: ts.timing, realisedM17: (realisedStand ?? realised).metrics.M17, realisedM3: realised.metrics.M3, meta: meta.forms ?? null };
  }
  // (6c F2) scatter_demo's own bars (CONTRACT F2 §5): supports, melt across the stand, stamps realised exactly, the placements
  let scatterM = null;
  if (isF2(sc)) {
    const F = await import('./lib/scenario-forms.mjs');
    const SC = await import('./lib/scenario-scatter.mjs');
    const standFile = path.join(raw, 'after-stand.arwd.gz');
    const stand = fs.existsSync(standFile) ? await decodeArwd(fs.readFileSync(standFile)) : null;
    const realisedStand = stand ? checkRegion({ ir, meta, world: dumpWorld(before, stand, ir.claim, { virtual: vw, lots: ir.lots }), prefix: false, blobs }) : null;
    if (realisedStand) fs.writeFileSync(path.join(out, 'realised-stand-report.json'), `${JSON.stringify({ ...realisedStand, _world: undefined }, null, 1)}\n`);
    const melt = stand ? F.meltAcrossStand(after, stand, F.plannedLights(vw)) : null;
    const supports = SC.supports({ ir, vw, after, realised });
    const planned = SC.asPlanned({ ir, vw, after });
    const snow = SC.snowAcrossStand({ ir, vw, after, stand });
    const stampsMissing = (meta.stamps ?? []).filter((x) => x.missing).map((x) => x.id);
    rows = SC.scatterBars({ plan, realised, realisedStand, melt, supports, planned, snow, stampsMissing, workersSame: ts.workersSame, tiles: ts.timing, mspt, load1: Math.round((await import('node:os')).loadavg()[0] * 10) / 10 }, rows);
    // the flat run records E-flat; the natural run judges both (with this run's E-flat): here the row is recorded, never a FAIL
    if (flat) rows = rows.map((r) => (r.id === 'exactness' ? { ...r, gated: false, pass: null, threshold: `recorded here (E-flat ${exact.mismatches === 0 ? '0' : exact.mismatches}); the natural run judges E-flat and E-normal together` } : r));
    // a fixture without a flat variant (the cave): E-normal only; scatter_demo's flat run holds E-flat
    if (!sc.flat) {
      const en = exN, WORLD = ['growth', 'grazed', 'live', 'gravity', 'unsupported', 'freeze', 'flow', 'distant', 'amethyst'];
      const undoOwn = en.mismatches - WORLD.reduce((a, k) => a + (en.classes?.[k] ?? 0), 0), cap = 0.0001 * (en.cellsWritten ?? 0);
      rows = rows.map((r) => (r.id === 'exactness' ? { ...r, value: `E-flat: none (this fixture has no flat variant; scatter_demo's flat run holds E-flat); E-normal ${en.mismatches} (${JSON.stringify(en.classes ?? {})}; unclassified ${en.classes?.none ?? 0}; the undo's own ${undoOwn}, cap ${cap.toFixed(0)})`, threshold: 'E-normal all classified, <= 0.01% of written cells', pass: (en.classes?.none ?? 0) === 0 && undoOwn <= cap } : r));
    }
    // the determinism row: identical over 3 plans and 1 vs 4 workers, and the golden held (a fixture without one: recorded)
    rows = rows.map((r) => (r.id === 'determinism' ? { ...r, pass: new Set(irShas).size === 1 && ts.workersSame && (String(golden).startsWith('match') || sc.golden === false), threshold: sc.golden === false ? 'identical (this fixture keeps no golden)' : 'identical; the committed golden scenarios/goldens/scatter_demo.json (stamps off) holds' } : r));
    scatterM = { melt, supports, planned, snow, stampsMissing, tiles: ts.timing, realisedM17: (realisedStand ?? realised).metrics.M17, realisedM3: realised.metrics.M3, meta: meta.scatterDemo ?? null, scatter: meta.scatter ?? null, stamps: meta.stamps ?? null };
  }
  // (6c T1) relief_demo's own bars (CONTRACT T1 §6): items 1-4 and 10 (tools/lib/scenario-relief.mjs), item 7's tile evaluation
  let relief = null;
  if (isT1(sc)) {
    const T = await import('./lib/scenario-relief.mjs');
    const rm = await T.reliefMetrics({ planDir, ir, survey, blobs, vw, after, before });
    rows = T.reliefBars(rm, plan.report, rows, { flat, metaFlat: meta.relief?.flat ?? null });
    const tm = ts.timing;
    rows.push({ id: 't1-tiles', label: 'T1 7 Tile evaluation (best of 3 per tile)', value: `p50 ${tm.p50Ms.toFixed(1)} ms, p99 ${tm.p99Ms.toFixed(1)} ms, max ${tm.maxMs.toFixed(1)} ms over ${tm.count} tiles; ${Math.round(tm.cellsPerSecond)} cells/s`, threshold: 'p99 < 2 s; >= 45k cells/s', pass: tm.p99Ms < 2000 && tm.cellsPerSecond >= 45_000, gated: true });
    relief = { ...rm, tiles: tm, meta: meta.relief ?? null, passes: meta.passes ?? null };
  }
  // (6c T2) route_demo's own bars (CONTRACT T2 §3): items 1, 3-6, 9 (tools/lib/scenario-route.mjs), item 11's tile evaluation
  let route = null;
  if (isT2(sc)) {
    const T2 = await import('./lib/scenario-route.mjs');
    const nav = fs.existsSync(path.join(out, 'nav.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'nav.json'), 'utf8')) : null;
    const rmt = await T2.routeMetrics({ sc, ir, meta, report: plan.report, realised, nav, before, after, planDir, flat });
    rows = T2.routeBars(rmt, plan.report, rows, { flat, metaFlat: meta.route?.demo?.flat ?? null });
    const tm = ts.timing;
    rows.push({ id: 't2-tiles', label: 'T2 11 Tile evaluation (best of 3 per tile)', value: `p50 ${tm.p50Ms.toFixed(1)} ms, p99 ${tm.p99Ms.toFixed(1)} ms, max ${tm.maxMs.toFixed(1)} ms over ${tm.count} tiles; ${Math.round(tm.cellsPerSecond)} cells/s`, threshold: 'p99 < 2 s', pass: tm.p99Ms < 2000, gated: true });
    route = { ...rmt, tiles: tm, passes: meta.passes ?? null };
  }
  // (6c D1) districts_demo's own bars (CONTRACT D §4): items 2-4 (tools/lib/scenario-districts.mjs), item 11's tile evaluation
  let districts = null;
  if (isD(sc)) {
    const DB = await import('./lib/scenario-districts.mjs');
    const nav = fs.existsSync(path.join(out, 'nav.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'nav.json'), 'utf8')) : null;
    const dm = DB.districtsMetrics({ ir, meta, report: plan.report, realised, nav });
    rows = DB.districtsBars(dm, plan.report, rows, { flat });
    const tm = ts.timing;
    rows.push({ id: 'd-tiles', label: 'D 11 Tile evaluation (best of 3 per tile)', value: `p50 ${tm.p50Ms.toFixed(1)} ms, p99 ${tm.p99Ms.toFixed(1)} ms, max ${tm.maxMs.toFixed(1)} ms over ${tm.count} tiles; ${Math.round(tm.cellsPerSecond)} cells/s`, threshold: 'p99 < 2 s', pass: tm.p99Ms < 2000, gated: true });
    districts = { ...dm, tiles: tm, passes: meta.passes ?? null };
  }
  // (6c S2) the outpost's own rows (CONTRACT S2 §3): T2's route rows, then S2's (tools/lib/scenario-s2.mjs)
  let s2 = null;
  if (isS2(sc)) {
    const T2 = await import('./lib/scenario-route.mjs');
    const S2 = await import('./lib/scenario-s2.mjs');
    const F = await import('./lib/scenario-forms.mjs');
    const nav = fs.existsSync(path.join(out, 'nav.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'nav.json'), 'utf8')) : null;
    const rmt = await T2.routeMetrics({ sc, ir, meta, report: plan.report, realised, nav, before, after, planDir, flat });
    const routeRows = T2.routeBars(rmt, plan.report, [], { flat });
    const standFile = path.join(raw, 'after-stand.arwd.gz');
    const stand = fs.existsSync(standFile) ? await decodeArwd(fs.readFileSync(standFile)) : null;
    const realisedStand = stand ? checkRegion({ ir, meta, world: dumpWorld(before, stand, ir.claim, { virtual: vw, lots: ir.lots }), prefix: false, blobs }) : null;
    if (realisedStand) fs.writeFileSync(path.join(out, 'realised-stand-report.json'), `${JSON.stringify({ ...realisedStand, _world: undefined }, null, 1)}\n`);
    const vols = F.planVolumes(planDir, ir);
    const standC = stand ? S2.standCounts(ir, vols, after, stand) : null;
    const keptAfter = F.keptDiff(ir, vols, before, after);
    const lots = S2.lotRows(meta, { lots: lotStates ?? [] });
    const gravity = (realised.findings ?? []).filter((f) => f.rule === 'M3:gravity').reduce((a, f) => a + f.count, 0);
    rows = S2.s2Bars({ plan, realised, realisedStand, stand: standC, keptAfter, lots, tiles: ts.timing, flat, gravity, load1: Math.round((await import('node:os')).loadavg()[0] * 10) / 10 }, rows, routeRows);
    s2 = { route: rmt, stand: standC, keptAfter, lots, gravity, tiles: ts.timing, outpost: meta.outpost ?? null, realisedM17: (realisedStand ?? realised).metrics.M17 };
  }
  // (6c S3) the monastery's own rows (CONTRACT S3 §7): T2's route rows, then S3's (tools/lib/scenario-s3.mjs)
  let s3 = null;
  if (isS3(sc)) {
    const T2 = await import('./lib/scenario-route.mjs');
    const S3 = await import('./lib/scenario-s3.mjs');
    const nav = fs.existsSync(path.join(out, 'nav.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'nav.json'), 'utf8')) : null;
    const rmt = await T2.routeMetrics({ sc, ir, meta, report: plan.report, realised, nav, before, after, planDir, flat });
    const routeRows = T2.routeBars(rmt, plan.report, [], { flat });
    const standFile = path.join(raw, 'after-stand.arwd.gz');
    const stand = fs.existsSync(standFile) ? await decodeArwd(fs.readFileSync(standFile)) : null;
    const realisedStand = stand ? checkRegion({ ir, meta, world: dumpWorld(before, stand, ir.claim, { virtual: vw, lots: ir.lots }), prefix: false, blobs }) : null;
    if (realisedStand) fs.writeFileSync(path.join(out, 'realised-stand-report.json'), `${JSON.stringify({ ...realisedStand, _world: undefined }, null, 1)}\n`);
    const geom = (meta.planCheck?.answers ?? []).find((a) => a.part === 'monastery')?.geometry ?? null;
    const rims = S3.rimsRetained(ir, geom?.terraces ?? null, after, meta.lots);
    const earth = S3.earthworks(vw, ir, geom);
    const census = fs.existsSync(path.join(out, 'census.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'census.json'), 'utf8')) : null;
    const states = Object.fromEntries((lotStates ?? []).map((l) => [l.id, l.state]));
    const lots = { planned: (ir.lots ?? []).length, placed: Object.values(states).filter((v) => String(v).toUpperCase() === 'PLACED').length, states, unplaced: Object.values(geom?.districts ?? {}).flatMap((d) => d.unplaced ?? []) };
    const gravity = (realised.findings ?? []).filter((q) => q.rule === 'M3:gravity').reduce((a, q) => a + q.count, 0);
    rows = S3.s3Bars({ plan, realised, realisedStand, meta, rims, earth, census, tiles: ts.timing, flat, gravity, lots, load1: Math.round((await import('node:os')).loadavg()[0] * 10) / 10 }, rows, routeRows);
    s3 = { route: rmt, rims, earth, census, lots, gravity, tiles: ts.timing, monastery: meta.monastery ?? null, realisedM17: (realisedStand ?? realised).metrics.M17 };
  }
  // (6c V) S7's own bars (CONTRACT V §7): the door-to-street walk, the lot fronts, the villager rules, the props
  let village = null;
  if (isV(sc)) {
    const VB = await import('./lib/scenario-village.mjs');
    const nav = fs.existsSync(path.join(out, 'nav.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'nav.json'), 'utf8')) : { lots: {} };
    const door = VB.doorToStreet(ir, meta, world, nav);
    const fronts = VB.villageFronts(ir, meta, before, after, door);
    const props = VB.villageProps(ir, meta, world, realised, vw);
    const walkDark = VB.walkDark(world, vw, door);
    rows = VB.villageBars({ plan, realised, door, fronts, props, nav, walkDark, lamps: meta.village?.apronLamps ?? null }, rows);
    village = { lamps: meta.village?.apronLamps ?? null, walkDark, door: Object.fromEntries(Object.entries(door).map(([k, d]) => [k, { ...d, path: undefined, pathLength: d.path?.length }])), fronts, props, nav: VB.navSummary(nav),
      M2villager: realised.metrics.M2villager, M22: realised.metrics.M22, M23: realised.metrics.M23, M24: realised.metrics.M24, graph: realised.metrics.graph };
  }
  // (fast checks P2, docs/FAST-CHECKS.md "Precondition for every REPLACE row") the realised world against the plan's virtual world,
  // per writer kind: the SMOKE row that keeps the structure and look lints (tools/lint.mjs) trustworthy. Gated: 0 differing cells of
  // any kind (the classes kept / road / plant / child / grass / fluid recorded; tools/lib/realised-virtual.mjs)
  const RV = await import('./lib/realised-virtual.mjs');
  const rv = await RV.realisedVsVirtual(planDir, path.join(raw, 'after.arwd.gz'), path.join(raw, 'before.arwd.gz'));
  fs.writeFileSync(path.join(out, 'realised-virtual.json'), `${JSON.stringify(rv, null, 1)}\n`);
  rows.push({ id: 'realisedVirtual', label: 'P2 realised == virtual (per writer kind)', value: `${rv.differ} of ${rv.written} written cells differ; ${RV.describeRealised(rv)}${rv.first.length ? `; first ${JSON.stringify(rv.first.slice(0, 3))}` : ''}`, threshold: `0 differing cells of every writer kind${flat ? ' (flat: none but child)' : ''}`, pass: RV.realisedOk(rv, [], { strict: flat }).pass, gated: true });
  const fronts = M.lotFronts(ir, after);
  L.log(`  lot fronts: outside the boxes ${JSON.stringify(fronts.outside)}; inside (the children's own) ${JSON.stringify(fronts.inside)}`);
  const metrics = { scenario: sc.id, worldChanges: world.worldChanges, cellsPerSecond: cps, lotFronts: fronts, ...(village ? { village } : {}), ...(forms ? { forms } : {}), ...(relief ? { relief } : {}), ...(scatterM ? { scatter: scatterM } : {}), ...(route ? { route } : {}), ...(districts ? { districts } : {}), ...(s2 ? { s2 } : {}), ...(s3 ? { s3 } : {}), variant: flat ? 'flat' : 'natural', rows, palette, organic, buildings, mspt, tiles: { irSha: ts.irSha, count: Object.keys(ts.tiles).length, cells: ts.cells, workersSame: ts.workersSame, golden }, exactSibling: sibling ? path.relative(out, sibling) : null,
    realised: { M2: realised.metrics.M2 && { ...realised.metrics.M2, perNode: undefined }, M3: realised.metrics.M3, M4: realised.metrics.M4, M5: realised.metrics.M5, M8: realised.metrics.M8 && { ...realised.metrics.M8, unguardedSample: (realised.metrics.M8.unguardedSample ?? []).slice(0, 20) }, M10: realised.metrics.M10, findings: realised.findings.map((f) => `${f.rule} ${f.severity} ${f.part ?? '-'} x${f.count}`) } };
  fs.writeFileSync(path.join(out, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  for (const r of rows) L.log(`  ${r.gated ? (r.pass ? 'ok  ' : 'FAIL') : 'rec '} ${BARS.has(r.id) ? 'BAR ' : ''}${r.label}: ${r.value}`); // the mspt row is a timing bar (recorded, not blocking in change/slice)
  return metrics;
}

function latestRun(sc, out, wantFlat) {
  const dir = path.dirname(out);
  if (!fs.existsSync(dir)) return null;
  // (6c F2) only this scenario's own runs: a gate's --out puts every scenario's runs side by side
  const own = (d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, d, 'run.json'), 'utf8')).scenario === sc.id; } catch { return true; } };
  const runs = fs.readdirSync(dir).filter((d) => d.endsWith('-flat') === wantFlat && fs.existsSync(path.join(dir, d, 'exact.json')) && own(d)).sort();
  return runs.length ? path.join(dir, runs[runs.length - 1]) : null;
}

/** Recompute a run's metrics from its raw/ (after a kit fix or once the other variant has run). Refreshes evidence.sha. */
async function metricsOf(runDir) {
  await lib();
  const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  const sc = readSc(run.scenario);
  const planDir = path.join(runDir, 'raw', 'plan');
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const old = JSON.parse(fs.readFileSync(path.join(runDir, 'metrics.json'), 'utf8'));
  const exact = JSON.parse(fs.readFileSync(path.join(runDir, 'exact.json'), 'utf8'));
  const m = await computeMetrics({ sc, out: runDir, planDir, ir, irShas: run.irShas, mspt: old.mspt, cps: old.cellsPerSecond ?? null, exact, flat: run.variant === 'flat', lotStates: run.lotStates ?? null });
  const ev = evidenceSha(runDir);
  fs.writeFileSync(path.join(runDir, 'evidence.sha'), `${ev.sha}\n`);
  return { evidence: ev.sha, failing: m.rows.filter((r) => r.gated && !r.pass).map((r) => r.id) };
}

/** (6c F2) The decoded frozen volumes an IR names, from a dir of its side blobs: [{sha, box, bytes, decoded}] (planRegion's form). */
async function irVolumesIn(ir, blobDir) {
  const { decodeArvx } = await import('../kit/lib/region/volume.mjs');
  const out = [];
  for (const v of Object.values(ir.volumes ?? {})) {
    const f = path.join(blobDir, `${ir.blobs[v.blob].sha}.bin`);
    const bytes = fs.readFileSync(f);
    const decoded = decodeArvx(bytes);
    out.push({ sha: decoded.sha, box: decoded.box, bytes: Uint8Array.from(bytes), decoded });
  }
  return out;
}

/** (6c F2) Re-plan a plan dir's inputs (its survey and frozen volumes) with params `over` and no stamps: {p, ir}. */
async function replanStampsOff(planDir, over = {}, keepKit = false) {
  const { planRegion } = await import('../kit/lib/region/plan.mjs');
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const volumes = await irVolumesIn(ir, path.join(planDir, 'blobs'));
  const p = await planRegion({ programFile: path.join(root, 'kit', 'regions', `${ir.id}.mjs`), params: { ...ir.params, ...over }, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), seed: ir.seed, claim: { ...ir.claim, minY: -64, maxY: 319 }, roles: ir.roles, volumes, stamps: null, ...(over.kitVersion ? {} : { kitVersion: keepKit ? ir.kitVersion : undefined }) });
  return { p, ir };
}

/** (6c F2) The golden row: the committed golden's inputs (stamps off) re-plan to its IR sha, and their tiles to its tile shas. */
async function f2Golden(sc, ts) {
  const gFile = path.join(SCEN, 'goldens', `${short(sc)}.json`), gDir = path.join(SCEN, 'goldens', short(sc));
  if (!fs.existsSync(gFile) || !fs.existsSync(path.join(gDir, 'ir.json'))) return 'none';
  const g = JSON.parse(fs.readFileSync(gFile, 'utf8'));
  const { p } = await replanStampsOff(gDir, {}, true);
  const gts = await tileShas(gDir);
  const ok = p.irSha === g.irSha && gts.irSha === g.irSha && gts.workersSame && JSON.stringify(gts.tiles) === JSON.stringify(g.tiles);
  return ok ? `match (the golden's committed inputs, stamps off (N-F2-1), re-plan to its IR ${g.irSha.slice(0, 12)} and its ${Object.keys(g.tiles).length} tile shas, 1 = 4 workers; this run's IR ${ts.irSha.slice(0, 12)}, with the local stamps, is its own)`
    : `differs (the golden's inputs re-plan to ${p.irSha.slice(0, 12)}, golden ${g.irSha.slice(0, 12)}; tiles ${JSON.stringify(gts.tiles) === JSON.stringify(g.tiles) ? 'equal' : 'differ'})`;
}

/** scenarios/goldens/<short>.json: the IR sha and tile shas over the run's own plan inputs, which are committed beside it. */
async function golden(id, runDir) {
  const sc = readSc(id);
  if (isF2(sc)) {
    // (6c F2, N-F2-1) the run's own survey and volumes re-planned with the stamps off: no vanilla stamp is ever committed
    const { p } = await replanStampsOff(path.join(runDir, 'raw', 'plan'), { stamps: false });
    if (Object.keys(p.ir.blobs ?? {}).some((n) => n.startsWith('stamp_')) || (p.ir.requires ?? []).includes('stamp')) throw new Error('the stamps-off plan still names a stamp');
    const gDir = path.join(SCEN, 'goldens', short(sc));
    fs.mkdirSync(path.join(gDir, 'blobs'), { recursive: true });
    fs.writeFileSync(path.join(gDir, 'ir.json'), p.irJson);
    fs.copyFileSync(path.join(runDir, 'raw', 'plan', 'survey.bin'), path.join(gDir, 'survey.bin'));
    fs.writeFileSync(path.join(gDir, 'meta.json'), JSON.stringify(p.meta));
    for (const [sha, bytes] of p.blobs) fs.writeFileSync(path.join(gDir, 'blobs', `${sha}.bin`), bytes);
    const ts = await tileShas(gDir);
    if (!ts.workersSame) throw new Error('1 and 4 workers differ');
    const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    const g = { scenario: sc.id, version: sc.version, note: `the stamps-off plan (params.stamps false; N-F2-1: no vanilla stamp in the repo) of run ${run.runId}'s own survey and frozen volume: IR sha and tile shas over its own plan survey (kit windowFromSurvey), 1 worker = 4 workers shuffled; inputs in goldens/${short(sc)}/`, fromRun: run.runId, irSha: ts.irSha, kitVersion: p.ir.kitVersion, cells: ts.cells, tiles: ts.tiles };
    fs.writeFileSync(path.join(SCEN, 'goldens', `${short(sc)}.json`), `${JSON.stringify(g, null, 1)}\n`);
    return { irSha: ts.irSha, tiles: Object.keys(ts.tiles).length, stampsOff: true };
  }
  const planDir = path.join(runDir, 'raw', 'plan');
  const ts = await tileShas(planDir);
  if (!ts.workersSame) throw new Error('1 and 4 workers differ');
  const gDir = path.join(SCEN, 'goldens', short(sc));
  fs.mkdirSync(path.join(gDir, 'blobs'), { recursive: true });
  for (const f of ['ir.json', 'survey.bin', 'meta.json']) fs.copyFileSync(path.join(planDir, f), path.join(gDir, f));
  // ((6c S3) the monastery's fountain reads the plan's biome grid and the bible's fluids: kept beside the golden's inputs)
  if (isS3(sc)) for (const f of ['biomes.json', 'bible.json']) if (fs.existsSync(path.join(planDir, f))) fs.copyFileSync(path.join(planDir, f), path.join(gDir, f));
  for (const f of fs.existsSync(path.join(planDir, 'blobs')) ? fs.readdirSync(path.join(planDir, 'blobs')) : []) fs.copyFileSync(path.join(planDir, 'blobs', f), path.join(gDir, 'blobs', f));
  const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  const g = { scenario: sc.id, version: sc.version, note: `tile shas of the IR over its own plan survey (kit windowFromSurvey), 1 worker = 4 workers shuffled; inputs in goldens/${short(sc)}/`, fromRun: run.runId, irSha: ts.irSha, kitVersion: JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8')).kitVersion, cells: ts.cells, tiles: ts.tiles };
  fs.writeFileSync(path.join(SCEN, 'goldens', `${short(sc)}.json`), `${JSON.stringify(g, null, 1)}\n`);
  return { irSha: ts.irSha, tiles: Object.keys(ts.tiles).length };
}

/** `check --phase 6b`: every scenario of the phase has a natural run whose metrics pass and an approval for its evidence. */
function checkPhase(phase) {
  const approvals = (() => { try { return JSON.parse(fs.readFileSync(path.join(ART, phase, 'approvals.json'), 'utf8')); } catch { return { approvals: [] }; } })();
  const out = [];
  for (const f of fs.readdirSync(SCEN).filter((n) => n.endsWith('.json'))) {
    const sc = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8'));
    if (sc.phase !== phase) continue;
    const dir = path.join(ART, phase, short(sc));
    const runs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => !d.endsWith('-flat') && fs.existsSync(path.join(dir, d, 'metrics.json'))).sort() : [];
    if (!runs.length) { out.push({ scenario: sc.id, ok: false, why: 'no run' }); continue; }
    const rd = path.join(dir, runs[runs.length - 1]);
    const m = JSON.parse(fs.readFileSync(path.join(rd, 'metrics.json'), 'utf8'));
    const ev = evidenceSha(rd).sha;
    const recorded = fs.readFileSync(path.join(rd, 'evidence.sha'), 'utf8').trim();
    const failing = m.rows.filter((r) => r.gated && !r.pass && r.id !== 'gallery').map((r) => r.id);
    const a = (approvals.approvals ?? []).find((x) => x.scenario === sc.id && x.phase === phase);
    const approved = a && a.decision === 'approved' && a.evidenceSha === ev;
    out.push({ scenario: sc.id, run: runs[runs.length - 1], evidence: ev, evidenceFile: recorded === ev, failing, approval: a ? `${a.decision} for ${a.evidenceSha.slice(0, 12)}` : 'none', ok: recorded === ev && failing.length === 0 && !!approved });
  }
  return out;
}

const main = {
  pin: () => pin(args[1]),
  run: () => runScenario(args[1]),
  // (6c W) a village scenario's fixture bible and lot entries, installed as a run does (`--bible <id>` for another bible)
  prep: async () => { await lib(); const sc = readSc(args[1]); if (opt('bible')) { sc.bible = opt('bible'); sc.bibleFixture = `bibles/${opt('bible')}.json`; } if (isV(sc)) await prepV(sc); return { bible: sc.bible, entries: Object.keys(sc.entries ?? {}) }; },
  metrics: () => metricsOf(path.resolve(args[1])),
  golden: () => golden(args[1], path.resolve(args[2])),
  check: () => checkPhase(opt('phase', '6b')),
  gallery: async () => (await import('./lib/gallery6b.mjs')).build({ phase: opt('phase', '6b'), local: !!opt('local'), ART, SCEN, evidenceSha }),
  calibrate: async () => (await import('./lib/gallery6b.mjs')).calibrate({ phase: opt('phase', '6b'), ART }),
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!main[sub]) { console.error(`usage: node tools/scenarios.mjs <${Object.keys(main).join('|')}> ...`); process.exit(2); }
  try {
    const r = await main[sub]();
    console.log(JSON.stringify(r, null, 1)?.slice(0, 4000));
    // check: a scenario not passing or not approved. run (the gate runner judges by the exit code): a gated run bar failing,
    // except the gallery (a person's approval) and, on the flat variant, the rows that belong to the natural run: the golden (it
    // pins the natural run's tiles; the flat run's IR shas and 1-vs-4-worker tiles must still agree) and E-normal (the flat run
    // is held to E-flat 0). The natural run's exactness row needs a flat sibling in the same parent dir (run the flat one first).
    const flatRun = sub === 'run' && r.metrics.variant === 'flat';
    const irSame = flatRun && new Set(JSON.parse(fs.readFileSync(path.join(r.out, 'run.json'), 'utf8')).irShas).size === 1;
    const eFlat0 = flatRun && JSON.parse(fs.readFileSync(path.join(r.out, 'exact.json'), 'utf8')).mismatches === 0;
    const runBad = (x) => x.gated && !x.pass && x.id !== 'gallery'
      && !(flatRun && x.id === 'determinism' && irSame && r.metrics.tiles.workersSame) && !(flatRun && x.id === 'exactness' && eFlat0);
    const bad = (sub === 'check' && r.some((x) => !x.ok)) || (sub === 'run' && r.metrics.rows.some(runBad));
    if (sub === 'run') console.error(`${r.metrics.rows.filter(runBad).length} failure(s) (scenario run)`);
    if (sub === 'run') for (const x of r.metrics.rows.filter(runBad)) console.error(`FAIL ${BARS.has(x.id) ? 'BAR ' : ''}${x.id}: ${x.value} (bar: ${x.threshold})`);
    try { L?.state.dev?.close(); } catch { /* closed */ }
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error(e?.stack ?? e);
    try { L?.state.dev?.close(); } catch { /* closed */ }
    process.exit(1);
  }
}
