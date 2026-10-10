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
const short = (sc) => sc.id.split('_')[0];
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

/** Tile shas of a plan's IR over its own survey, with 1 worker forward and 4 workers shuffled. */
export async function tileShas(planDir) {
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
  return { irSha: sha256(irJson), tiles: Object.fromEntries(Object.keys(m1).sort().map((k) => [k, m1[k]])), cells: one.reduce((n, r) => n + r.count, 0), workersSame: same };
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
  await L.fresh(`G6B Pin ${short(sc)}`, BASE);
  const c = sc.fixture.claim;
  await L.tp((c[0] + c[2]) / 2, sc.fixture.yRange[1], (c[1] + c[3]) / 2);
  const p = await L.plan(sc.program, c, { params: sc.params, surveyLoad: 'bounded:256', seed });
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
  const lotEntries = fitEntries(ir.lots);
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
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}${flat ? '-flat' : ''}`;
  const out = path.resolve(opt('out') || path.join(ART, phase, short(sc), runId));
  const raw = path.join(out, 'raw');
  fs.mkdirSync(raw, { recursive: true });
  const t = {};
  const T = (k, t0) => { t[k] = (Date.now() - t0) / 1000; };
  const c = sc.fixture.claim;
  const off = flat ? sc.flat.claimOffset : [0, 0];
  const claim = [c[0] + off[0], c[1] + off[1], c[2] + off[0], c[3] + off[1]];
  const cams = Object.fromEntries(Object.entries(sc.cams).map(([k, v]) => [k, [v[0] + off[0], v[1], v[2] + off[1], v[3], v[4]]]));
  L.log(`== scenario ${sc.id} ${flat ? 'flat' : 'natural'} run ${runId} -> ${out}`);
  let t0 = Date.now();
  await L.fresh(`G6B Scn ${short(sc)}${flat ? ' Flat' : ''}`, flat ? FLAT : BASE);
  await L.setRules(flat ? 'exact' : 'gallery');
  await L.tp((claim[0] + claim[2]) / 2, sc.fixture.yRange[1], (claim[1] + claim[3]) / 2);
  T('world', t0);
  // plan (kept), prepare, the realised plan (+2 for the IR sha)
  t0 = Date.now();
  const p1 = await L.plan(sc.program, claim, { params: sc.params, surveyLoad: 'bounded:256', seed: sc.seed });
  T('plan', t0);
  t0 = Date.now();
  const pr = await L.prepare(p1.planId);
  T('prepare', t0);
  const p2 = await L.plan(sc.program, claim, { params: sc.params, surveyLoad: 'generated:64', seed: sc.seed });
  const irShas = [p2.irSha];
  for (let i = 0; i < 2; i++) irShas.push((await L.plan(sc.program, claim, { params: sc.params, surveyLoad: 'generated:64', seed: sc.seed })).irSha);
  const planDir = copyPlan(p2.planId, path.join(raw, 'plan'));
  fs.copyFileSync(path.join(planDir, 'report.json'), path.join(out, 'report.json'));
  fs.mkdirSync(path.join(out, 'previews'), { recursive: true });
  for (const f of fs.readdirSync(path.join(planDir, 'previews'))) fs.copyFileSync(path.join(planDir, 'previews', f), path.join(out, 'previews', f));
  fs.copyFileSync(path.join(planDir, 'siteplan.json'), path.join(out, 'previews', 'siteplan.json'));
  fs.copyFileSync(path.join(planDir, 'summary.txt'), path.join(out, 'summary.txt'));
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  // the box: the claim + 8 over the written y span +-8 (the plan's virtual world and its lots), as 6a's exactness box
  const ys = await writtenY(planDir, ir);
  const box = [claim[0] - 8, ys[0] - 8, claim[1] - 8, claim[2] + 8, ys[1] + 8, claim[3] + 8];
  // the prepared chunks tick a while first (fresh chunks settle fluids and schedule their first block ticks), player at the centre
  await L.tp((claim[0] + claim[2]) / 2, sc.fixture.yRange[1], (claim[1] + claim[3]) / 2);
  await L.settle(90_000);
  // the pristine cameras, then the before dump and the snap
  let before = null;
  if (!flat) { t0 = Date.now(); before = await shoot(cams, path.join(out, 'before')); T('beforeShots', t0); }
  await L.tp((claim[0] + claim[2]) / 2, sc.fixture.yRange[1], (claim[1] + claim[3]) / 2);
  t0 = Date.now();
  const d0 = await L.call('dev.region.dump', { box, file: path.join(raw, 'before.arwd.gz') }, 1_800_000);
  const snap = await L.call('dev.region.hash', { box, mode: 'snap', file: path.join(raw, 'snap.gz') }, 4 * 3_600_000);
  T('beforeDump', t0);
  if (d0.refused) throw new Error(`dump refused: ${d0.refused}`);
  // realise
  await L.call('dev.mspt.trace', { start: true });
  await L.call('dev.placement.stats', { reset: true });
  t0 = Date.now();
  const region = await L.realise(p2.planId, { lots: sc.lotEntries });
  const st = await L.waitRegion(region, 3 * 3_600_000);
  T('realise', t0);
  const mspt = await L.call('dev.mspt.trace', { stop: true });
  // (6b, coordinator 2026-10-10) the judged bar is Architect's own per-tick time; the whole tick, the vanilla tick and GC are recorded
  const pst = await L.call('dev.placement.stats', {});
  mspt.architect = { placementMsMax: pst.placementMsMax, placementMsMean: pst.placementMsMean, serverMsptMax: pst.serverMsptMax, msptMax: pst.msptMax };
  const rec = st.record;
  const cps = rec.stats?.firstTileAt && rec.stats?.lastTileAt ? rec.cellsWritten / ((rec.stats.lastTileAt - rec.stats.firstTileAt) / 1000) : null;
  L.log(`  ${region} ${st.view.state}: ${rec.cellsWritten} cells, MSPT ${JSON.stringify(mspt.all)}, lots ${JSON.stringify(st.view.lots.map((l) => l.state))}`);
  t0 = Date.now();
  const d1 = await L.call('dev.region.dump', { box, file: path.join(raw, 'after.arwd.gz') }, 1_800_000);
  T('afterDump', t0);
  // the stand and the cameras (natural only)
  let shots = null;
  if (!flat) {
    t0 = Date.now();
    await L.settle(120_000);
    T('stand', t0);
    t0 = Date.now();
    shots = await shoot(cams, path.join(out, 'shots'));
    T('shots', t0);
  }
  // the group undo and the exactness diff
  await L.tp((claim[0] + claim[2]) / 2, sc.fixture.yRange[1], (claim[1] + claim[3]) / 2);
  await L.cmd('/kill @e[type=!minecraft:player]');
  await L.settle(5000);
  t0 = Date.now();
  const rm = await L.call('dev.region.remove', { region }, 4 * 3_600_000);
  T('remove', t0);
  await L.settle(10_000);
  const diff = await L.call('dev.region.hash', { box, mode: 'diff', file: path.join(raw, 'snap.gz') }, 4 * 3_600_000);
  const exact = { kind: flat ? 'E-flat' : 'E-normal', box, cellsWritten: rec.cellsWritten, removed: rm.removed, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes, list: [...(diff.list ?? []).filter((m) => m.class !== 'growth'), ...(diff.list ?? []).filter((m) => m.class === 'growth').slice(0, 50)], listTotal: (diff.list ?? []).length };
  fs.writeFileSync(path.join(out, 'exact.json'), `${JSON.stringify(exact, null, 2)}\n`);
  await L.leaveWorld();
  const metrics = await computeMetrics({ sc, out, planDir, ir, irShas, mspt, cps, exact, flat });
  const gp = fs.readFileSync(path.join(root, 'mod', 'gradle.properties'), 'utf8');
  const api = /String VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(root, 'mod', 'src', 'main', 'java', 'dev', 'larattalabs', 'architect', 'api', 'ArchitectApi.java'), 'utf8'))?.[1];
  const hello = await L.call('dev.state').catch(() => ({}));
  const run = {
    scenario: sc.id, version: sc.version, phase, runId, variant: flat ? 'flat' : 'natural', worldSeed: sc.world.seed, programSeed: sc.seed, claim, irSha: p2.irSha, irShas,
    planId: p2.planId, region, state: st.view.state, cellsWritten: rec.cellsWritten, lots: sc.lotEntries,
    versions: { mod: /mod_version\s*=\s*(\S+)/.exec(gp)?.[1], api, kit: ir.kitVersion, sidecar: hello.sidecar?.version ?? hello.sidecarVersion ?? null, minecraft: /minecraft_version\s*=\s*(\S+)/.exec(gp)?.[1], node: process.versions.node.split('.')[0], head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim() },
    wallSeconds: t, prepare: pr.stats ?? null, dumps: { before: { sha: d0.sha, cells: d0.cells }, after: { sha: d1.sha, cells: d1.cells } }, snap: { cells: snap.cells }, before, shots,
    spendUsd: 0,
  };
  fs.writeFileSync(path.join(out, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  const ev = evidenceSha(out);
  fs.writeFileSync(path.join(out, 'evidence.sha'), `${ev.sha}\n`);
  L.log(`== scenario ${sc.id} run ${runId}: evidence ${ev.sha.slice(0, 12)}; ${metrics.rows.filter((r) => r.gated && !r.pass).map((r) => r.id).join(', ') || 'every run bar passes'}`);
  return { out, runId, evidence: ev.sha, metrics };
}

/** The metrics of a run directory (also `scenarios.mjs metrics <runDir>` to recompute after a kit fix). */
async function computeMetrics({ sc, out, planDir, ir, irShas, mspt, cps, exact, flat }) {
  const { decodeArwd, dumpWorld, buildVirtual } = await import('../kit/lib/region/vworld.mjs');
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
  const realised = checkRegion({ ir, meta, world, prefix: false });
  fs.writeFileSync(path.join(out, 'realised-report.json'), `${JSON.stringify(realised, null, 1)}\n`);
  const palette = M.paletteAdherence(ir, world);
  const organic = M.axisRunShare(ir, vw);
  const lib6 = L ?? await lib();
  const buildings = [];
  for (const entry of [...new Set(Object.values(sc.lotEntries))].sort()) {
    const dir = path.join(lib6.LIBRARY, entry);
    let j;
    try { j = JSON.parse(execFileSync('node', [path.join(root, 'kit', 'check.mjs'), path.join(dir, `${entry}.nbt`), path.join(dir, `${entry}.blueprint.json`), '--json', '--restraint', sc.restraint ?? 'rustic']).toString().trim().split('\n').pop()); } catch (e) { j = JSON.parse(String(e.stdout ?? '{}').trim().split('\n').pop() || '{"errors":["unreadable"]}'); }
    // the bar reads detailNoise and accentShare against the restraint (as 5a); other restraint lines are recorded only
    const rw = (j.warnings ?? []).filter((w) => w.startsWith('restraint'));
    buildings.push({ entry, errors: (j.errors ?? []).length, errorList: j.errors ?? [], restraint: rw.filter((w) => /detail ?noise|accent/i.test(w)), restraintOther: rw.filter((w) => !/detail ?noise|accent/i.test(w)), metrics: { detailNoise: j.metrics?.detailNoise ?? null, accentShare: j.metrics?.accentShare ?? null } });
  }
  const ts = await tileShas(planDir);
  const gFile = path.join(SCEN, 'goldens', `${short(sc)}.json`);
  let golden = 'none';
  if (fs.existsSync(gFile)) {
    const g = JSON.parse(fs.readFileSync(gFile, 'utf8'));
    golden = g.irSha === ts.irSha && JSON.stringify(g.tiles) === JSON.stringify(ts.tiles) ? 'match' : `differs (golden ${g.irSha.slice(0, 12)}, run ${ts.irSha.slice(0, 12)})`;
  }
  // the other variant's exactness (E-flat from the latest flat run beside a natural one, and back)
  const sibling = latestRun(sc, out, !flat);
  const exactOther = sibling ? JSON.parse(fs.readFileSync(path.join(sibling, 'exact.json'), 'utf8')) : null;
  const ex = flat ? { flat: exact, normal: exactOther, cellsWritten: exactOther?.cellsWritten ?? 0 } : { flat: exactOther, normal: exact, cellsWritten: exact.cellsWritten };
  const plan = { report: JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')) };
  const rows = M.bars({ plan, realised, palette, organic, buildings, mspt, cellsPerSecond: cps, exact: ex, determinism: { irShas, workersSame: ts.workersSame, golden }, spendUsd: 0, approval: 'pending' });
  const fronts = M.lotFronts(ir, after);
  L.log(`  lot fronts: outside the boxes ${JSON.stringify(fronts.outside)}; inside (the children's own) ${JSON.stringify(fronts.inside)}`);
  const metrics = { scenario: sc.id, worldChanges: world.worldChanges, cellsPerSecond: cps, lotFronts: fronts, variant: flat ? 'flat' : 'natural', rows, palette, organic, buildings, mspt, tiles: { irSha: ts.irSha, count: Object.keys(ts.tiles).length, cells: ts.cells, workersSame: ts.workersSame, golden }, exactSibling: sibling ? path.relative(out, sibling) : null,
    realised: { M2: realised.metrics.M2 && { ...realised.metrics.M2, perNode: undefined }, M3: realised.metrics.M3, M4: realised.metrics.M4, M5: realised.metrics.M5, M8: realised.metrics.M8 && { ...realised.metrics.M8, unguardedSample: (realised.metrics.M8.unguardedSample ?? []).slice(0, 20) }, M10: realised.metrics.M10, findings: realised.findings.map((f) => `${f.rule} ${f.severity} ${f.part ?? '-'} x${f.count}`) } };
  fs.writeFileSync(path.join(out, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  for (const r of rows) L.log(`  ${r.gated ? (r.pass ? 'ok  ' : 'FAIL') : 'rec '} ${r.label}: ${r.value}`);
  return metrics;
}

function latestRun(sc, out, wantFlat) {
  const dir = path.dirname(out);
  if (!fs.existsSync(dir)) return null;
  const runs = fs.readdirSync(dir).filter((d) => d.endsWith('-flat') === wantFlat && fs.existsSync(path.join(dir, d, 'exact.json'))).sort();
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
  const m = await computeMetrics({ sc, out: runDir, planDir, ir, irShas: run.irShas, mspt: old.mspt, cps: old.cellsPerSecond ?? null, exact, flat: run.variant === 'flat' });
  const ev = evidenceSha(runDir);
  fs.writeFileSync(path.join(runDir, 'evidence.sha'), `${ev.sha}\n`);
  return { evidence: ev.sha, failing: m.rows.filter((r) => r.gated && !r.pass).map((r) => r.id) };
}

/** scenarios/goldens/<short>.json: the IR sha and tile shas over the run's own plan inputs, which are committed beside it. */
async function golden(id, runDir) {
  const sc = readSc(id);
  const planDir = path.join(runDir, 'raw', 'plan');
  const ts = await tileShas(planDir);
  if (!ts.workersSame) throw new Error('1 and 4 workers differ');
  const gDir = path.join(SCEN, 'goldens', short(sc));
  fs.mkdirSync(path.join(gDir, 'blobs'), { recursive: true });
  for (const f of ['ir.json', 'survey.bin', 'meta.json']) fs.copyFileSync(path.join(planDir, f), path.join(gDir, f));
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
    const bad = sub === 'check' && r.some((x) => !x.ok);
    try { L?.state.dev?.close(); } catch { /* closed */ }
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error(e?.stack ?? e);
    try { L?.state.dev?.close(); } catch { /* closed */ }
    process.exit(1);
  }
}
