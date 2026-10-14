#!/usr/bin/env node
// Phase 6c slice D1 gate (docs/CONTRACT.md "Phase 6c slice D: districts, and a district beside a standing region" §4) against the
// headless server (or a dev client) of the D run worktree (`../architect-mc-D-run`, a detached worktree at this checkout's HEAD;
// the sim sidecar, no Claude). Ports 8914 (sidecar) / 8915 (DevBridge) by default. $0: no Claude call anywhere; spend.json $0.00.
//
//   node tools/gate6cd.mjs <step>
//     start [world] | stop | base      the client (or server) and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit                              the kit's D1 tests (items 1-4 and 8's kit half: the assignment on 300 seeded claims, the bands,
//                                       connectivity and loopiness, the beside rule and join, plan/0's program.districts and
//                                       endpoint.region), P0's tests with the catalogue flip (item 9 of P0), the goldens that must not
//                                       move (item 12), the whole kit suite, the sidecar's beside and feature tests
//     plantime                          item 9 (BAR): districts_demo on S3's claim through the plan CLI in the helper's sandbox, median of 3;
//                                       item 8 offline: the IR sha over the 3 plans, tile shas 1 = 4 workers, the golden
//     apicompat                         item 13: tools/api-compat.mjs --gate6cd (the 0.27.0, 0.26.0, 0.25.0 apitest jars, the 0.27.0 surface)
//     ingame                            items 5, 6, 7 in game (headless): a standing flat_village on a flat world, then a 4-lot district
//                                       beside it: OVERLAP refusals with nothing written, the join walkable (vanilla villager path from a
//                                       new lot to the village's bell, both ways; the kit's movers on the join), Regions.remove(new) leaving
//                                       0 changed cells in the village (ARWD diff) and E-flat 0 over the new claim; PT: a player's cabin in
//                                       the new claim kept out (IR keep-out, its kept hash unchanged); the standing region removed first:
//                                       the dangling join noted, then the district's removal restoring both claims (E-flat 0)
//     districtsflat | districts         districts_demo on S3's pinned claim, flat then natural (scenarios.mjs, phase 6c-d): items 2, 3, 4,
//                                       8, 10, 11 in game
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-d/<step>.json in the main checkout (GATE6CD_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-D-run');
process.env.GATE6B_OUT = process.env.GATE6CD_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-d');
process.env.GATE6B_SIDECAR_PORT ??= '8914';
process.env.GATE6B_DEV_PORT ??= '8915';
process.env.SCENARIOS_ART ??= path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'scenarios');
const L = await import('./lib/run6b.mjs');
const { OUT, SAVES, bar, call, check, cmd, connect, fails, leaveWorld, log, openWorld, refuseKeys, results, root, state, startClient, stopClient, tp, sleep } = L;

refuseKeys();
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const PHASE = '6c-d';
const OWNER = 'test:d1';
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const SC = () => JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'districts_demo.json'), 'utf8'));
const json = (o) => JSON.stringify(o).replaceAll(' ', '');

const steps = {};
async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data, error;
  log(`== ${name}`);
  try {
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  if (!['stop', 'start'].includes(name)) L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice D1 is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6C D Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  for (const [name, preset] of [[BASE, 'normal'], [FLAT, 'flat']]) {
    if (fs.existsSync(path.join(SAVES, name, 'level.dat'))) continue;
    await leaveWorld();
    await openWorld(name, { mode: 'creative', preset, seed: SEED, cheats: true });
    await L.setRules(preset === 'flat' ? 'exact' : 'default');
    await tp(0.5, 200, 0.5);
    await cmd('/save-all flush');
    await leaveWorld();
  }
  spendZero();
  return { worlds: [BASE, FLAT], seed: SEED };
};

// ------------------------------------------------------------------ offline: unit, plan time, api-compat

function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)), comments: t.split('\n').filter((l) => /^# /.test(l)).slice(0, 40) };
}

steps.unit = async () => {
  const out = {};
  out.d = nodeTest(['kit/test/districts-d.test.mjs']);
  // (6c D2) C27 (biome edge, shore, ridge), C28, outposts, refusals: the kit half
  out.d2 = nodeTest(['kit/test/districts-d2.test.mjs']);
  check(out.d2.code === 0 && out.d2.fail === 0 && out.d2.pass >= 8, `D2 (kit): C28's 4x4 biome grid, a biome-edge district's shape within 4 cells of the edge over its length, a shore street parallel to the shore, a ridge street on the crest, stable re-plans, named refusals (NO_EDGE, PROTECTED), an outpost's corridor, plan/0's D2 flips: ${out.d2.pass} pass, ${out.d2.fail} fail`, out.d2.failing);
  check(out.d.code === 0 && out.d.fail === 0 && out.d.pass >= 13, `items 1-4, 8 (kit): the assignment on 300 seeded claims (exact <= greedy, no overlap, none in keep-out or C17 areas, unplaced exact), full plans with keep-out (0 lots in it), districts_demo's bands and connectivity on S3's survey, loopiness on 8 districts, the IR sha, the beside seam rule and join, plan/0's program.districts and endpoint.region: ${out.d.pass} pass, ${out.d.fail} fail`, out.d.failing);
  out.p0 = nodeTest(['kit/test/plan-p0.test.mjs', 'kit/test/plan-ops.test.mjs']);
  check(out.p0.code === 0 && out.p0.fail === 0, `P0 item 9 (the catalogue flip: program.districts and endpoint.region reserved -> supported, exactly, against P0's archived golden and catalogue-next.json), P0's items 1-11 with D1's fixtures (Steward's 59 plans: none malformed): ${out.p0.pass} pass, ${out.p0.fail} fail`, out.p0.failing);
  out.goldens = nodeTest(['kit/test/region-golden.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/region-fixtures.test.mjs', 'kit/test/forms-island.test.mjs', 'kit/test/region-lint.test.mjs', 'kit/test/relief-t1.test.mjs', 'kit/test/route-t2.test.mjs', 'kit/test/village.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `item 12: S1, S7, mega_bench, relief_demo, route_demo (and every committed) scenario golden, the format-1 goldens and the 6b fixtures unchanged; districts_demo's golden holds; the realise lint: ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  out.kit = nodeTest(fs.readdirSync(path.join(root, 'kit', 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `kit/test/${f}`));
  check(out.kit.code === 0 && out.kit.fail === 0, `the whole kit suite: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const sc = spawnSync('npx', ['vitest', 'run', 'test/regions-village.test.ts', 'test/plan-check.test.ts', 'test/jobs.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 900_000 });
  const st = `${sc.stdout}${sc.stderr}`;
  out.sidecar = { code: sc.status, summary: st.split('\n').filter((l) => /Tests|Test Files/.test(l)).join(' | ') };
  check(sc.status === 0, `§1 (sidecar): region.plan beside (protocol, --beside, beside.json, the IR's beside, the external edge in siteplan.json), region.districts and region.beside appended to the features: ${out.sidecar.summary}`);
  spendZero();
  return out;
};

/** One plan through the kit CLI in the helper's sandbox (permission model, no network, the pass heap). */
function sandboxPlan(dir, surveyFile, params, claim, heapMb, seed) {
  fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'out', 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', 'params.json'), JSON.stringify(params));
  fs.copyFileSync(surveyFile, path.join(dir, 'out', 'survey.bin'));
  const o = path.join(dir, 'out');
  const node = ['--permission', `--allow-fs-read=${KIT}`, `--allow-fs-read=${o}`, `--allow-fs-write=${o}`, `--max-old-space-size=${heapMb}`,
    path.join(KIT, 'tools', 'region.mjs'), 'plan', path.join(KIT, 'regions', 'districts_demo.mjs'), '--params', path.join(o, 'params.json'), '--survey', path.join(o, 'survey.bin'),
    '--seed', seed, '--claim', claim.join(','), '--blobs-out', path.join(o, 'blobs'), '--out', o, '--json'];
  const timeArgs = process.platform === 'darwin' ? ['-l'] : ['-v'];
  const t0 = performance.now();
  const r = spawnSync('/usr/bin/time', [...timeArgs, process.execPath, ...node], { encoding: 'utf8', timeout: 900_000, env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
  const wallMs = performance.now() - t0;
  const err = r.stderr ?? '';
  const mac = /(\d+)\s+maximum resident set size/.exec(err), lin = /Maximum resident set size \(kbytes\): (\d+)/.exec(err);
  const peakMb = mac ? Number(mac[1]) / 1048576 : lin ? Number(lin[1]) / 1024 : null;
  const plan = fs.existsSync(path.join(o, 'plan.json')) ? JSON.parse(fs.readFileSync(path.join(o, 'plan.json'), 'utf8')) : null;
  const meta = fs.existsSync(path.join(o, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(o, 'meta.json'), 'utf8')) : null;
  return { code: r.status, wallMs, peakMb, plan, meta, out: o, tail: `${r.stdout}`.split('\n').slice(-3).join('\n') + err.split('\n').filter((l) => /error|Error/.test(l)).slice(0, 5).join('\n') };
}

steps.plantime = async () => {
  const dir = path.join(OUT, 'plantime');
  fs.mkdirSync(dir, { recursive: true });
  const sc = SC();
  const s3File = path.join(dir, 's3.bin');
  fs.copyFileSync(path.join(root, 'scenarios', 'goldens', 'route_demo', 'survey.bin'), s3File);
  const c = sc.fixture.claim;
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const r = sandboxPlan(dir, s3File, sc.params, [c[0], c[1], c[2], c[3], -64, 319], 2048, sc.seed);
    const passes = r.plan?.passRuns ?? [];
    runs.push({ code: r.code, wallMs: Math.round(r.wallMs), districtsMs: r.meta?.districts?.ms ?? null, routeMs: passes.find((p) => p.name === 'route')?.ms ?? null, peakMb: r.peakMb === null ? null : Math.round(r.peakMb), irSha: r.plan?.irSha ?? null, tail: r.code ? r.tail : undefined });
    if (i === 2 && r.plan) fs.cpSync(r.out, path.join(dir, 'last-s3'), { recursive: true });
  }
  const med = (k) => { const v = runs.map((x) => x[k]).filter((x) => x !== null).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
  const out = { load1: os.loadavg()[0], runs, median: { districtsMs: med('districtsMs'), wallMs: med('wallMs'), peakMb: med('peakMb') } };
  check(runs.every((x) => x.code === 0 && x.irSha), `item 9: 3 plans of districts_demo on S3's claim in the sandbox: exit ${runs.map((x) => x.code).join(', ')}`);
  bar(out.median.districtsMs !== null && out.median.districtsMs <= 60_000, `item 9: the districts pass with its routes on S3's claim ${out.median.districtsMs} ms (median of 3), at most 60 s; whole plan ${out.median.wallMs} ms, peak ${out.median.peakMb} MB (load ${out.load1.toFixed(1)})`);
  check(new Set(runs.map((x) => x.irSha)).size === 1, `item 8: the IR sha over 3 plans: ${runs.map((x) => x.irSha?.slice(0, 12)).join(', ')}`);
  const { tileShas } = await import('./scenarios.mjs');
  const ts = await tileShas(path.join(dir, 'last-s3'));
  const g = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'goldens', 'districts_demo.json'), 'utf8'));
  out.tiles = { count: Object.keys(ts.tiles).length, cells: ts.cells, workersSame: ts.workersSame, golden: JSON.stringify(ts.tiles) === JSON.stringify(g.tiles) };
  check(ts.workersSame, `item 8: ${out.tiles.count} tile shas equal for 1 and 4 workers, forward and shuffled (S3)`);
  check(out.tiles.golden && ts.irSha === g.irSha, `item 8: the sandboxed plan equals the committed golden scenarios/goldens/districts_demo.json (IR ${ts.irSha.slice(0, 12)}, ${out.tiles.count} tile shas)`);
  spendZero();
  return out;
};

steps.apicompat = async () => {
  execFileSync('./gradlew', ['compileJava', 'compileClientJava', '--offline', '-q'], { cwd: path.join(root, 'mod'), env: { ...process.env, JAVA_HOME, GRADLE_USER_HOME: path.join(root, '.gradle-home') }, stdio: 'ignore' });
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), '--gate6cd'], { cwd: root, encoding: 'utf8', env: { ...process.env, JAVA_HOME } });
  const t = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), t);
  check(r.status === 0 && /all 4 checks clean/.test(t), `item 13: api-compat against the 0.27.0, 0.26.0 and 0.25.0 apitest jars and the 0.27.0 surface: ${t.trim().split('\n').pop()}`);
  spendZero();
  return { out: t };
};

// ------------------------------------------------------------------ in game (headless-capable): beside, the join, the undo, PT

const planReq = (o) => call('dev.region.plan', { surveyLoad: 'bounded:256', owner: OWNER, ...o }, 900_000);
const planFiles = (planId) => {
  const d = path.join(L.SIDECAR_DATA, 'regions', 'plans', planId);
  return { ir: JSON.parse(fs.readFileSync(path.join(d, 'ir.json'), 'utf8')), meta: JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8')), report: fs.existsSync(path.join(d, 'report.json')) ? JSON.parse(fs.readFileSync(path.join(d, 'report.json'), 'utf8')) : null };
};
async function undo(region) {
  const r = await call('dev.region.remove', { region, requester: OWNER }, 3_600_000);
  for (let i = 0; i < 1200; i++) {
    const st = await call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || s === 'REMOVED') return r;
    if (s === 'PARTIAL' || s === 'FAILED') throw new Error(`undo of ${region} ended ${s}: ${json(r)}`);
    await sleep(250);
  }
  throw new Error(`undo of ${region} did not finish`);
}
const hash = async (box) => (await call('dev.region.hash', { box }, 3_600_000)).sha256;
/** A log cabin 9 x 7 x 9 at (X, Y, Z) (Y: the floor row) placed by a fake player (PT's cabin), its door in the north wall. */
function cabinOps(X, Y, Z, placer = 'D1Alex') {
  const ops = [];
  for (let y = Y; y < Y + 6; y++) for (let x = X; x <= X + 8; x++) for (let z = Z; z <= Z + 8; z++) {
    if (!(x === X || x === X + 8 || z === Z || z === Z + 8)) continue;
    if (x === X + 4 && z === Z && (y === Y || y === Y + 1)) continue;
    ops.push({ item: 'minecraft:oak_log', at: [x, y, z], placer });
  }
  for (let x = X; x <= X + 8; x++) for (let z = Z; z <= Z + 8; z++) ops.push({ item: 'minecraft:oak_log', at: [x, Y + 6, z], placer });
  ops.push({ item: 'minecraft:oak_door', at: [X + 4, Y, Z], placer, yaw: 0 });
  return ops;
}
const meets = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

steps.ingame = async () => {
  await ensure();
  const out = {};
  const { besideData, seamProblem } = await imp('lib/region/beside.mjs');
  const { besidePorts } = await imp('lib/region/districtsEmit.mjs');
  await L.fresh('G6B D Ingame', FLAT);
  await L.setRules('exact');
  await cmd('/op @s');
  await call('dev.pt.rule', { name: 'graceMs', value: '600000' }).catch(() => null);
  const X = 9000, Z = 9000;
  const A = [X, Z, X + 111, Z + 111];
  await tp(X + 56, 40, Z + 56);
  const s7 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's7_flat_village.json'), 'utf8'));
  // the whole area both claims can touch: A grown by 120 (the district's claim reaches 100 out of A's edge)
  const yr0 = [-64, 140];
  const all = [A[0] - 120, yr0[0], A[1] - 120, A[2] + 120, yr0[1], A[3] + 120];
  await cmd('/kill @e[type=!minecraft:player]');
  const h0 = await hash(all);
  // ---- the standing village (S7's lots, flat_village)
  const pa = await planReq({ program: 'flat_village', params: s7.params, claim: A, check: false });
  if (pa.refused) throw new Error(`the village's plan was refused: ${pa.refused}`);
  const fa = planFiles(pa.planId);
  await cmd('/kill @e[type=!minecraft:player]');
  const ra = await L.realise(pa.planId, { lots: {} });
  const sa = await L.waitRegion(ra, 3_600_000);
  out.village = { planId: pa.planId, region: ra, state: sa.view.state, lots: fa.ir.lots.length };
  check(sa.view.state === 'PLACED', `the standing village ${ra} (S7's ${fa.ir.lots.length} lots) PLACED`);
  // ---- the district's claim: outward from the village's west (or first) street end, its seam holding the cell past it
  const ports = besidePorts(besideData(ra, A, fa.ir, A));
  const q = ports[0];
  const [ex, ez] = q.end, [dx, dz] = q.dir;
  const far = 99, side = 50;
  const B = dx !== 0 ? [dx < 0 ? ex - far : ex, ez - side, dx < 0 ? ex : ex + far, ez + side] : [ex - side, dz < 0 ? ez - far : ez, ex + side, dz < 0 ? ez : ez + far];
  out.claimB = B; out.port = q;
  check(seamProblem(A, fa.ir, B) === null, `the district's claim ${json(B)} beside ${ra}: its seam holds the cell past ${q.node} (${json(q.end)}) and meets no lot, road or path (the kit's rule)`);
  // ---- item 5: refusals, nothing planned or written
  const hBefore = await hash(all);
  const inward = dx !== 0 ? [B[0] + 8 * -dx, B[1], B[2] + 8 * -dx, B[3]] : [B[0], B[1] + 8 * -dz, B[2], B[3] + 8 * -dz];
  const spec = { spec: { districts: [{ id: 'east', size: [48, 48], lots: 4 }] } };
  const r1 = await planReq({ program: 'districts', params: spec, claim: inward, beside: ra });
  const r2 = await planReq({ program: 'districts', params: spec, claim: [A[0] - 40, A[1], A[0] + 40, A[3]], beside: ra });
  const r3 = await planReq({ program: 'districts', params: spec, claim: B, beside: 'rg999999' });
  const r4 = await planReq({ program: 'districts', params: spec, claim: B, beside: ra, owner: 'test:other' });
  out.refusals = { overRoad: r1.refused ?? null, deep: r2.refused ?? null, missing: r3.refused ?? null, otherOwner: r4.refused ?? null };
  check(/^OVERLAP: beside/.test(r1.refused ?? '') && /meets the standing region's/.test(r1.refused ?? ''), `item 5: a claim over the village's street refused OVERLAP, naming the seam (${r1.refused})`);
  check(/^OVERLAP: beside/.test(r2.refused ?? '') && /columns deep/.test(r2.refused ?? ''), `item 5: a claim 41 columns into the village refused OVERLAP (${r2.refused})`);
  check(/^OTHER: beside: no standing region/.test(r3.refused ?? '') && /^OVERLAP_OWNED/.test(r4.refused ?? ''), `named refusals: no such region (${r3.refused}); another owner's (${r4.refused})`);
  check(await hash(all) === hBefore, 'item 5: nothing written (the world hash over both claims is unchanged after the refusals)');
  // ---- PT: a player's cabin inside the district's claim (a fake player's placements: a tracked build, kept out)
  const cx = dx !== 0 ? (dx < 0 ? B[0] + 6 : B[2] - 14) : B[0] + 6, cz = dz !== 0 ? (dz < 0 ? B[1] + 6 : B[3] - 14) : B[1] + 6;
  // the ground y there (the plan survey of a small claim around it; the flat base world's ground is not vanilla's superflat default)
  const sf = path.join(OUT, `survey-${cx}-${cz}.bin`);
  await call('dev.region.survey', { claim: [cx - 1, cz - 1, cx + 1, cz + 1], surveyLoad: 'loaded', file: sf }, 300_000);
  const gy = (await imp('lib/region/pack.mjs')).decodeColumns(fs.readFileSync(sf)).ground[4];
  await call('dev.pt.uses', { ops: cabinOps(cx, gy + 1, cz) }, 900_000);
  await L.settle(6000);
  const cabinBox = [cx, gy + 1, cz, cx + 8, gy + 7, cz + 8];
  const builds = (await call('dev.pt.builds', { box: cabinBox, drain: true }, 600_000)).builds ?? [];
  const kept0 = await call('dev.pt.keptHash', { box: cabinBox }, 120_000);
  out.cabin = { box: cabinBox, builds: builds.map((b) => `${b.id} ${b.state}`), kept: kept0.sha256 ?? kept0 };
  check(builds.length === 1, `PT: the cabin is one tracked build (${out.cabin.builds.join(', ')})`);
  // ---- the district beside the village
  const pb = await planReq({ program: 'districts', params: spec, claim: B, beside: ra, check: true });
  if (pb.refused) throw new Error(`the district's plan was refused: ${pb.refused}`);
  const fb = planFiles(pb.planId);
  const d = fb.meta.districts;
  out.plan = { planId: pb.planId, beside: fb.ir.beside, join: d.join, edges: d.edges, keepOut: fb.ir.keepOut, lots: fb.ir.lots.map((l) => l.id) };
  const cabinRect = [cx, cz, cx + 8, cz + 8];
  const writes = [...fb.ir.lots.map((l) => [l.box.minX, l.box.minZ, l.box.maxX, l.box.maxZ]), ...(fb.ir.paths ?? []).filter((p) => p.box).map((p) => [p.box.minX, p.box.minZ, p.box.maxX, p.box.maxZ])];
  check(fb.ir.beside?.id === ra && d.join?.region === ra && d.edges.some((e) => e.kind === 'join' && e.ok), `§3: the plan read ${ra} (IR beside ${json(fb.ir.beside)}); the join routed to ${d.join?.node} (${json(d.join?.at)})`);
  check((fb.ir.keepOut ?? []).some((k) => meets(k, cabinRect)) && !writes.some((w) => meets(w, cabinRect)), `PT: districts keep out player builds: the IR's keep-out holds the cabin, no lot or path box meets it (${(fb.ir.keepOut ?? []).length} keep-out rects)`);
  const ext = fb.ir.graph.edges.filter((e) => e.external);
  check(ext.length === 1 && ext[0].to === `${ra}:${d.join.node}.${d.join.port}`, `§3: the graph's external edge to ${ext[0]?.to}`);
  // the join's movers (kit): the checker over the plan
  const je = fb.report?.metrics?.route?.edges?.find((e) => e.id === 'join');
  out.joinKit = je ? { player: je.player, villager: je.villager, ladders: je.ladders, grade: je.grade } : null;
  check(je && je.player && je.villager && je.ladders === 0, `item 7 (kit): the join is walkable by the player and villager movers (${json(out.joinKit)})`);
  // ---- realise the district; item 6 snapshots
  const bBox = [B[0] - 8, yr0[0], B[1] - 8, B[2] + 8, yr0[1], B[3] + 8];
  const aBox = [A[0], yr0[0], A[1], A[2], yr0[1], A[3]];
  const aBefore = path.join(OUT, 'ingame-village-before.arwd.gz');
  await call('dev.region.dump', { box: aBox, file: aBefore, light: false }, 900_000);
  const hB0 = await hash(bBox);
  await cmd('/kill @e[type=!minecraft:player]');
  const rb = await L.realise(pb.planId, { lots: {} });
  const sb = await L.waitRegion(rb, 3_600_000);
  out.district = { region: rb, state: sb.view.state, cells: sb.view.cellsWritten, beside: sb.view.beside ?? null, ext: sb.view.ext?.['architect_mc:beside'] ?? null };
  check(sb.view.state === 'PLACED' && sb.view.beside === ra && out.district.ext?.dangling === false, `the district ${rb} PLACED (${sb.view.cellsWritten} cells); its view names beside ${sb.view.beside}, the join not dangling`);
  const kept1 = await call('dev.pt.keptHash', { box: cabinBox }, 120_000);
  check((kept1.sha256 ?? kept1) === out.cabin.kept, 'PT: the cabin\'s kept cells unchanged by the district (kept hash)');
  // ---- item 7 in game: vanilla's villager path from each new lot's entrance to the village's bell, both ways (the player between
  // the claims, so the chunks along the way are loaded)
  await tp(Math.floor((A[0] + A[2] + B[0] + B[2]) / 4), 0, Math.floor((A[1] + A[3] + B[1] + B[3]) / 4));
  await cmd('/kill @e[type=!minecraft:player]');
  const bell = fa.ir.anchors.bell;
  out.nav = {};
  for (const l of fb.ir.lots) {
    const e = l.ext?.['architect_mc:village']?.entrance;
    if (!e) continue;
    const there = await call('dev.nav.villager', { from: e, to: bell, range: 256 }, 120_000);
    const back = await call('dev.nav.villager', { from: bell, to: e, range: 256 }, 120_000);
    out.nav[l.id] = { there: !!there.canReach, back: !!back.canReach, nodes: [there.nodes ?? null, back.nodes ?? null] };
  }
  check(Object.keys(out.nav).length === 4 && Object.values(out.nav).every((n) => n.there && n.back), `item 7: dev.nav.villager from every new lot's entrance to the village's bell and back (${json(Object.fromEntries(Object.entries(out.nav).map(([k, v]) => [k, [v.there, v.back]])))})`);
  // ---- item 6: Regions.remove(new): 0 changed cells in the village (ARWD diff), E-flat 0 over the new claim
  await cmd('/kill @e[type=!minecraft:player]');
  const rm = await undo(rb);
  await L.settle(3000);
  const aAfter = path.join(OUT, 'ingame-village-after.arwd.gz');
  await call('dev.region.dump', { box: aBox, file: aAfter, light: false }, 900_000);
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  const { changedIn } = await import('./lib/scenario-route.mjs');
  out.undo = { removed: rm.removed, restored: rm.restored, village: changedIn(await decodeArwd(fs.readFileSync(aBefore)), await decodeArwd(fs.readFileSync(aAfter)), [[A[0], A[1], A[2], A[3]]]), eflat: (await hash(bBox)) === hB0 };
  check(out.undo.village.cells === 0, `item 6: Regions.remove(${rb}): 0 changed cells in the standing village (ARWD diff over its claim: ${out.undo.village.cells})`);
  check(out.undo.eflat, `item 6: E-flat 0 over the new claim (+8): its hash equals the one before the district (${rm.restored} cells restored)`);
  // ---- the standing region removed first: the dangling join noted; then the district's removal restores both claims
  const pb2 = await planReq({ program: 'districts', params: spec, claim: B, beside: ra, check: false });
  await cmd('/kill @e[type=!minecraft:player]');
  const rb2 = await L.realise(pb2.planId, { lots: {} });
  const sb2 = await L.waitRegion(rb2, 3_600_000);
  check(sb2.view.state === 'PLACED', `again: the district ${rb2} PLACED beside ${ra}`);
  await cmd('/kill @e[type=!minecraft:player]');
  await undo(ra);
  const st2 = await call('dev.region.state', { region: rb2 }, 60_000);
  out.dangling = st2.view.ext?.['architect_mc:beside'] ?? null;
  check(out.dangling?.dangling === true && out.dangling?.region === ra, `§3: the village removed first (allowed): the district's join is reported dangling (${json(out.dangling)})`);
  await undo(rb2);
  await L.settle(3000);
  await cmd('/kill @e[type=!minecraft:player]');
  // the cabin is the players' and stays: compare both claims with the cabin's box left out by restoring nothing there (its cells are
  // unchanged from before the district: kept hash), so the whole-area hash is taken against the world before the village plus the cabin
  const h1 = await hash(all);
  const kept2 = await call('dev.pt.keptHash', { box: cabinBox }, 120_000);
  out.final = { cabinKept: (kept2.sha256 ?? kept2) === out.cabin.kept, hash: h1 };
  // the area hash with the cabin: remove the cabin by commands (no tracking) and compare with h0
  await cmd(`/fill ${cabinBox[0]} ${cabinBox[1]} ${cabinBox[2]} ${cabinBox[3]} ${cabinBox[4]} ${cabinBox[5]} minecraft:air`);
  await L.settle(2000);
  const h2 = await hash(all);
  check(out.final.cabinKept && h2 === h0, `§3: after the village and then the district were removed (and the players' cabin cleared by command), the world over both claims equals the world before either (E-flat 0)`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ D2 (C27, C28, outposts): in game

/** Plan (the districts program, one district), realise without entries, then: the plan again after the world is saved and reopened
 * (stable: the same IR sha, ticks frozen across), the removal restoring the box exactly (ticks frozen from the snapshot to the
 * check). Returns {plan, files, region, view, again, exact}. */
async function d2Round(name, world, claim, district, { beside = null, owner = OWNER, natural = false } = {}) {
  const spec = { spec: { districts: [district] }, lamps: false };
  const yr = [-64, 320];
  const box = [claim[0] - 8, yr[0], claim[1] - 8, claim[2] + 8, yr[1], claim[3] + 8];
  if (natural) await cmd('/tick freeze');
  try {
    await cmd('/kill @e[type=!minecraft:player]');
    // (natural) the snapshot for the E-normal diff: the live world's own changes across the save and reload are classed by the mod
    // (growth, grazed, live, gravity, unsupported); flat: the hash, E-flat 0
    const snapFile = path.join(OUT, `${name}-snap.gz`);
    const h0 = natural ? (await call('dev.region.hash', { box, mode: 'snap', file: snapFile }, 3_600_000)).sha256 : await hash(box);
    const p = await planReq({ program: 'districts', params: spec, claim, owner, ...(beside ? { beside } : {}), check: true });
    if (p.refused) throw new Error(`${name}: plan refused: ${p.refused}`);
    const files = planFiles(p.planId);
    const region = await L.realise(p.planId, { lots: {} });
    const st = await L.waitRegion(region, 3_600_000);
    // reload: save, leave, reopen; plan again (ticks frozen again in the reopened world)
    await cmd('/save-all flush');
    await leaveWorld();
    await openWorld(world);
    if (natural) await cmd('/tick freeze');
    await tp(Math.floor((claim[0] + claim[2]) / 2), 0, Math.floor((claim[1] + claim[3]) / 2));
    // stable: after the reload and the removal (the land as it was planned), the same request plans to the same IR sha
    await cmd('/kill @e[type=!minecraft:player]');
    const rm = await undo(region);
    await L.settle(3000);
    let h1, enormal = null;
    if (natural) {
      const diff = await call('dev.region.hash', { box, mode: 'diff', file: snapFile }, 3_600_000);
      // (as the scenarios' `flow`) the world's own fluids and leaves at cells the plan never writes: every cell more than 6 from the
      // district's rects and its routes' cells (deeper cells: more than 8 below the surveyed ground, beneath any cut, pad or route).
      // An unclassified mismatch there that is water or lava moving (or what it makes or washes away: obsidian, cobblestone, a plant
      // turned water) is classed `flow`; a natural leaf turned air `decay`; the same block in another state `live` (world classes, as
      // the scenarios' melt and freeze)
      const { decodeColumns } = await imp('lib/region/pack.mjs');
      const cols = decodeColumns(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', p.planId, 'survey.bin')));
      const groundAt = (x, z) => { const i = Math.floor((x - cols.minX) / cols.resolution), j = Math.floor((z - cols.minZ) / cols.resolution); return i < 0 || j < 0 || i >= cols.width || j >= cols.depth ? null : cols.ground[i + j * cols.width]; };
      const G = 6, near = new Set();
      const add = (x0, z0, x1, z1) => { for (let x = x0 - G; x <= x1 + G; x++) for (let z = z0 - G; z <= z1 + G; z++) near.add(`${x},${z}`); };
      for (const f of Object.values(files.meta.districts?.follow ?? {})) add(f.rect[0], f.rect[1], f.rect[2], f.rect[3]);
      for (const rr of Object.values(files.meta.districts?.rects ?? {})) add(rr[0], rr[1], rr[2], rr[3]);
      for (const e of files.meta.route?.edges ?? []) for (const [x, , z] of e.path ?? []) add(x, z, x, z);
      const written = (x, y, z) => { const gy = groundAt(x, z); return near.has(`${x},${z}`) && !(gy !== null && y < gy - 8); };
      // anywhere: flowing (non-source) water (the scenarios' T1 `flow`; SETTLEMENTS: E-normal can't classify flowing rivers and
      // waterfalls, and a frozen tick can't let a stream recede), and a
      // natural leaf already at distance 7 decays on its own random tick
      const flowing = (b) => /^minecraft:water\[level=[1-9]/.test(b);
      for (const m of diff.list ?? []) {
        if (m.class !== 'none') continue;
        const [x, y, z] = m.pos.split(',').map(Number);
        const anywhere = (flowing(m.now) && !/^minecraft:water\[level=0/.test(m.was)) || (flowing(m.was) && /^minecraft:(air|cave_air)$/.test(m.now)) ? 'flow'
          : /_leaves\[distance=7,persistent=false/.test(m.was) && /^minecraft:air$/.test(m.now) ? 'decay' : null;
        if (anywhere) { m.class = anywhere; diff.classes.none -= 1; diff.classes[anywhere] = (diff.classes[anywhere] ?? 0) + 1; continue; }
        if (written(x, y, z)) continue;
        const fluid = /^minecraft:(water|lava)\b/.test(m.now) || /^minecraft:(water|lava)\b/.test(m.was) || (/lava/.test(m.was) && /^minecraft:(obsidian|cobblestone|stone)$/.test(m.now));
        const decay = /_leaves\[.*persistent=false/.test(m.was) && /^minecraft:air$/.test(m.now);
        // the same block in another state (a big dripleaf's tilt, a cave's own ticking blocks): the mod's `live`
        const idOf = (b) => b.split(/[[{]/)[0];
        const live = idOf(m.was) === idOf(m.now);
        const cls = fluid ? 'flow' : decay ? 'decay' : live ? 'live' : null;
        if (!cls) continue;
        m.class = cls;
        diff.classes.none -= 1;
        diff.classes[cls] = (diff.classes[cls] ?? 0) + 1;
      }
      const WORLD = ['growth', 'grazed', 'live', 'gravity', 'unsupported', 'flow', 'decay'];
      const undoOwn = diff.mismatches - WORLD.reduce((a, k) => a + (diff.classes?.[k] ?? 0), 0);
      enormal = { mismatches: diff.mismatches, classes: diff.classes ?? {}, undoOwn, cap: Math.floor(0.0001 * (rm.restored ?? 0)), list: (diff.list ?? []).filter((m) => m.class === 'none').slice(0, 40), flowSample: (diff.list ?? []).filter((m) => m.class === 'flow' || m.class === 'decay').slice(0, 5) };
      h1 = enormal.mismatches === 0 ? h0 : null;
    } else h1 = await hash(box);
    const q = await planReq({ program: 'districts', params: spec, claim, owner, ...(beside ? { beside } : {}), check: false });
    const view = (await call('dev.region.state', { region }, 60_000).catch(() => ({}))).view ?? null;
    return { plan: p, files, region, state: st.view.state, viewAtPlace: st.view, again: q.irSha ?? q.refused, sameIr: q.irSha === p.irSha, exact: natural ? (enormal.classes?.none ?? 0) === 0 && enormal.undoOwn <= enormal.cap : h0 === h1, enormal, restored: rm.restored, view };
  } finally {
    if (natural) await cmd('/tick unfreeze').catch(() => null);
  }
}

steps.outpost = async () => {
  await ensure();
  const out = {};
  const { besideData } = await imp('lib/region/beside.mjs');
  const { besidePorts } = await imp('lib/region/districtsEmit.mjs');
  await L.fresh('G6B D2 Outpost', FLAT);
  await L.setRules('exact');
  const X = 9000, Z = 9000, A = [X, Z, X + 111, Z + 111];
  await tp(X + 56, 40, Z + 56);
  const s7 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's7_flat_village.json'), 'utf8'));
  const pa = await planReq({ program: 'flat_village', params: s7.params, claim: A, check: false });
  const fa = planFiles(pa.planId);
  const ra = await L.realise(pa.planId, { lots: {} });
  await L.waitRegion(ra, 3_600_000);
  // the outpost's claim: from the village's street end outward 150, 60 either side (the seam holds the cell past the end)
  const q = besidePorts(besideData(ra, A, fa.ir, A))[0];
  const [ex, ez] = q.end, [dx, dz] = q.dir;
  const B = dx !== 0 ? [dx < 0 ? ex - 150 : ex, ez - 60, dx < 0 ? ex : ex + 150, ez + 60] : [ex - 60, dz < 0 ? ez - 150 : ez, ex + 60, dz < 0 ? ez : ez + 150];
  await tp(Math.floor((B[0] + B[2]) / 2), 40, Math.floor((B[1] + B[3]) / 2));
  const r = await d2Round('outpost', 'G6B D2 Outpost', B, { id: 'camp', size: [40, 40], lots: 2, outpost: { gap: 40 } }, { beside: ra });
  const d = r.files.meta.districts;
  const rc = d.rects.camp;
  const gapTo = Math.max(A[0] - rc[2], rc[0] - A[2], A[1] - rc[3], rc[1] - A[3]);
  const cor = r.viewAtPlace.ext?.['architect_mc:corridor']?.camp ?? null;
  out.outpost = { claim: B, rect: rc, gapTo, join: d.join, corridor: cor ? { cells: cor.cells, rect: cor.rect } : null, sameIr: r.sameIr, exact: r.exact, restored: r.restored };
  check(r.state === 'PLACED' && gapTo >= 40 && d.edges.some((e) => e.kind === 'join' && e.ok), `outpost: placed ${gapTo} from the village (gap 40), its road joined to ${d.join?.node}`);
  check(cor && cor.cells > 100 && Array.isArray(cor.rect), `outpost: its corridor reported as settlement land on the region's view (architect_mc:corridor: ${cor?.cells} cells in ${json(cor?.rect)}), the IR's corridor ${Object.keys(r.files.ir.corridor ?? {})}`);
  check(r.sameIr, `outpost: stable across a reload (the same request planned after the world was saved and reopened: IR ${r.plan.irSha?.slice(0, 12)} = ${String(r.again).slice(0, 12)})`);
  check(r.exact, `outpost: one undo (Regions.remove) restores the world over its claim exactly, its corridor included (${r.restored} cells)`);
  // refused, named: an outpost that can't keep its gap
  const nr = await planReq({ program: 'districts', params: { spec: { districts: [{ id: 'camp', size: [40, 40], lots: 2, outpost: { gap: 400 } }] } }, claim: B, beside: ra, check: false });
  out.refused = nr.refused ?? null;
  check(/NO_ROOM/.test(nr.refused ?? ''), `outpost: a gap no candidate keeps refuses, named (${nr.refused})`);
  await undo(ra);
  await leaveWorld();
  spendZero();
  return out;
};

/** The pinned desert/jungle site (scenarios/sites/desert_jungle_site.json `fixture.claim`). */
const SITE = () => JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'sites', 'desert_jungle_site.json'), 'utf8'));

steps.boundary = async () => {
  await ensure();
  const out = {};
  const B = await imp('lib/region/boundary.mjs');
  const { decodeColumns } = await imp('lib/region/pack.mjs');
  const S3 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's3_monastery.json'), 'utf8')).fixture.claim;
  const world = 'G6B D2 Boundary';
  await L.fresh(world, await L.seedBase(SEED));
  await L.setRules('gallery');
  const near = (p, cells) => { let b = Infinity; for (const q of cells) b = Math.min(b, Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]))); return b; };
  const mask = (runs) => runs.flatMap(([x0, z, x1]) => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, z]));
  // ---- the shore (S3's river) and the ridge (S3's crest), on S3's pinned claim
  await tp(Math.floor((S3[0] + S3[2]) / 2), 200, Math.floor((S3[1] + S3[3]) / 2));
  for (const [id, follow, size, lots] of [['quay', { shore: { minArea: 64 } }, [64, 24], 2], ['crest', { ridge: { minRise: 8 } }, [64, 20], 1]]) {
    const r = await d2Round(id, world, S3, { id, size, follow, lots: Array.from({ length: lots }, (_, i) => ({ id: `${id}_${i + 1}`, type: 'cottage', size: [7, 7] })) }, { natural: true });
    const f = r.files.meta.districts.follow[id];
    const cols = decodeColumns(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', r.plan.planId, 'survey.bin')));
    let geo;
    if (id === 'quay') {
      const water = [];
      for (let j = 0; j < cols.depth; j++) for (let i = 0; i < cols.width; i++) if (cols.flags[i + j * cols.width] & 1) water.push([cols.minX + i * cols.resolution, cols.minZ + j * cols.resolution]);
      const ds = f.street.map(([x, , z]) => near([x, z], water));
      const off = 12;
      geo = { parallel: ds.filter((v) => v >= off - 4 && v <= off + 4).length, of: ds.length, min: Math.min(...ds), max: Math.max(...ds) };
      check(geo.parallel >= geo.of * 0.8, `shore: the street parallel to the shore (${geo.parallel}/${geo.of} street cells within ${off - 4}..${off + 4} of the water; ${geo.min}..${geo.max})`);
    } else {
      const ds = f.street.map(([x, , z]) => near([x, z], f.boundary));
      geo = { on: ds.filter((v) => v <= 4).length, of: ds.length };
      check(geo.on >= geo.of * 0.8, `ridge: the street on the ridge line (${geo.on}/${geo.of} street cells within 4 of the crest)`);
    }
    out[id] = { state: r.state, rect: f.rect, mask: f.maskCells, geo, lots: r.files.meta.districts.lots[id], sameIr: r.sameIr, exact: r.exact, enormal: r.enormal };
    check(r.state === 'PLACED' && r.files.meta.districts.lots[id].length >= 1, `${id}: placed (${r.files.meta.districts.lots[id].length} lot(s)), its shape a ${f.maskCells}-cell mask in ${json(f.rect)}`);
    check(r.sameIr, `${id}: stable across a reload (the same IR sha planned again after the world was saved and reopened)`);
    check(r.exact, `${id}: one undo restores the claim (ticks frozen; ${r.restored} cells; E-normal ${r.enormal?.mismatches} ${json(r.enormal?.classes ?? {})}, unclassified ${r.enormal?.classes?.none ?? 0}, the undo's own ${r.enormal?.undoOwn} (cap ${r.enormal?.cap}))`);
  }
  // ---- the biome edge: the pinned desert/jungle site
  const site = SITE();
  if (!site.fixture?.claim) { check(false, 'biome edge: the desert/jungle site is not pinned (tools/find-site.mjs desert_jungle_site)'); return out; }
  const C = site.fixture.claim;
  await tp(Math.floor((C[0] + C[2]) / 2), 200, Math.floor((C[1] + C[3]) / 2));
  // the jungle side (`side: 'b'`): on the pinned site the desert side is a narrow strip between the edge and water, so a band 24 deep
  // there leaves dry land
  const r = await d2Round('oasis', world, C, { id: 'oasis', size: [96, 24], follow: { biome_edge: { between: ['desert', 'jungle'] } }, side: 'b', lots: 3 }, { natural: true });
  const f = r.files.meta.districts.follow.oasis;
  const g = B.parseBiomes(JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', r.plan.planId, 'biomes.json'), 'utf8')));
  const cols = decodeColumns(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', r.plan.planId, 'survey.bin')));
  const claim = { minX: C[0], minZ: C[1], maxX: C[2], maxZ: C[3] };
  const edge = [...B.biomeEdgeCells(cols, claim, g, ['desert', 'jungle']).cells].map((k) => k.split(',').map(Number));
  const m = mask(f.mask);
  // the shape follows the edge within 4 cells over its length: every boundary cell of its window within 4 of the mask, every mask
  // cell on the other side (the desert) within 4 of the edge
  const far1 = f.boundary.filter((q) => near(q, m) > 4).length;
  const desert = m.filter(([x, z]) => B.familyOf(B.biomeAt(g, x, z)) === 'desert');
  const far2 = desert.filter((q) => near(q, edge) > 4).length;
  out.oasis = { state: r.state, rect: f.rect, mask: f.maskCells, boundary: f.boundary.length, far1, desertCells: desert.length, far2, lots: r.files.meta.districts.lots.oasis, sameIr: r.sameIr, exact: r.exact, enormal: r.enormal, biomes: r.files.ir.biomes };
  check(r.state === 'PLACED' && far1 === 0 && far2 === 0, `biome edge: the district's shape follows the desert/jungle edge within 4 cells over its ${f.boundary.length}-cell length (${far1} boundary cells and ${far2} desert cells past 4; ${r.files.meta.districts.lots.oasis.length} lot(s))`);
  check(r.sameIr && r.exact, `biome edge: stable across a reload, one undo restores the claim (${r.restored} cells; E-normal ${r.enormal?.mismatches} ${json(r.enormal?.classes ?? {})}, unclassified ${r.enormal?.classes?.none ?? 0}, the undo's own ${r.enormal?.undoOwn} (cap ${r.enormal?.cap}))`);
  // refused, named: no such edge; protected over the band
  const nr = await planReq({ program: 'districts', params: { spec: { districts: [{ id: 'oasis', size: [96, 24], follow: { biome_edge: { between: ['desert', 'mushroom'] } }, lots: 2 }] } }, claim: C, check: false });
  check(/NO_EDGE: no mushroom/.test(nr.refused ?? ''), `biome edge: no such edge refused, named (${nr.refused})`);
  const api = async (a) => { const x = await cmd(`/apitest ${a}`); return (x.messages ?? []).find((mm) => mm.startsWith('{')) ?? null; };
  await api(`unprotect ${OWNER} d2band`).catch(() => null);
  await api(`protect ${json({ owner: OWNER, id: 'd2band', x0: C[0], z0: C[1], x1: C[2], z1: C[3], label: 'D2_band' })}`);
  const pr = await planReq({ program: 'districts', params: { spec: { districts: [{ id: 'oasis', size: [96, 24], follow: { biome_edge: { between: ['desert', 'jungle'] } }, side: 'b', lots: 2 }] } }, claim: C, check: false });
  await api(`unprotect ${OWNER} d2band`).catch(() => null);
  out.refusals = { noEdge: nr.refused ?? null, protected: pr.refused ?? null };
  check(/PROTECTED/.test(pr.refused ?? ''), `biome edge: a protected area over its band refused, named (${pr.refused})`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the scenario runs (districts_demo on S3's pinned claim)

function scenario(args) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'scenarios.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 4 * 3_600_000, env: process.env });
  const t = `${r.stdout}${r.stderr}`;
  fs.appendFileSync(path.join(OUT, 'scenarios.log'), t);
  return { code: r.status, fails: t.split('\n').filter((l) => /^FAIL /.test(l)), tail: t.split('\n').slice(-40).join('\n') };
}
const ART = () => path.join(path.resolve(process.env.SCENARIOS_ART), PHASE, 'districts_demo');
const latest = (flat) => {
  const d = ART();
  const runs = fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.endsWith('-flat') === flat && fs.existsSync(path.join(d, x, 'metrics.json'))).map((x) => path.join(d, x)) : [];
  runs.sort((a, b) => fs.statSync(path.join(a, 'metrics.json')).mtimeMs - fs.statSync(path.join(b, 'metrics.json')).mtimeMs);
  return runs.length ? runs[runs.length - 1] : null;
};
function scenarioStep(flat) {
  const r = scenario(['run', 'districts_demo', '--phase', PHASE, ...(flat ? ['--flat'] : [])]);
  const dir = latest(flat);
  const m = dir ? JSON.parse(fs.readFileSync(path.join(dir, 'metrics.json'), 'utf8')) : null;
  for (const x of m?.rows ?? []) {
    if (!x.gated || x.id === 'gallery') continue;
    if (flat && (x.id === 'golden' || x.id === 'determinism' || x.id === 'exactness')) continue; // judged by the natural run (scenarios.mjs)
    if (x.id === 'mspt' || x.id === 'd-tiles') bar(x.pass, `${x.label}: ${x.value}`);
    else check(x.pass, `${x.label}: ${x.value}`);
  }
  check(r.code === 0, `scenarios.mjs run districts_demo${flat ? ' --flat' : ''}: exit ${r.code}${r.fails.length ? ` (${r.fails.join('; ')})` : ''}`);
  return { dir, exit: r.code, evidence: dir ? fs.readFileSync(path.join(dir, 'evidence.sha'), 'utf8').trim() : null, districts: m?.districts ?? null, rows: m?.rows ?? [] };
}
steps.districtsflat = async () => scenarioStep(true);
steps.districts = async () => scenarioStep(false);

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'plantime', 'apicompat', 'ingame', 'districtsflat', 'districts', 'outpost', 'boundary']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  const md = `# Gate 6c-D1 (districts, a district beside a standing region)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cd.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
