#!/usr/bin/env node
// Phase 6c slice V gate (docs/CONTRACT.md "Phase 6c slice V: flat village (C10)", §7) against a dev client of the V run worktree
// (`../architect-mc-V-run`, a detached worktree at this checkout's HEAD; tools/run-gate6b-client.sh: the sim sidecar, no Claude,
// apitest on the classpath). Ports 8906 (sidecar) / 8907 (DevBridge). $0: no Claude call anywhere; spend.json reads $0.00.
//
//   node tools/gate6cv.mjs <step>
//     start [world] | stop | base       the client and the base worlds (G6B Seed Base, G6B Flat Base, G6B V Survival)
//     unit                               item 1 (no game): the kit's village tests, the goldens, the sidecar's village test
//     variants                           item 2: each broken variant caught on its named part (kit, no game)
//     s7flat | s7                        item 3: S7 flat variant (bar 10 E-flat) then natural (bars 1-12): tools/scenarios.mjs
//     nav                                item 4: dev.nav.villager's range control and negative control (+ S7's door-to-bell paths)
//     protect                            item 5: a protected area over a third of the claim; a mark after the plan refuses
//     steward                            item 6: Steward's flow on 0a's sim (plan lots, massingFirst group, fitToLot, realise, remove)
//     survroad                           the coordinator's C16 addition: dirt paths on dirt/coarse dirt/podzol/mycelium/rooted dirt free
//     report                             REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-v/<step>.json in the main checkout (GATE6CV_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-V-run');
// GATE6CV_OUT wins over the runner's GATE6B_OUT (the gate runner gives every step its 6b evidence dir)
process.env.GATE6B_OUT = process.env.GATE6CV_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-v');
process.env.GATE6B_SIDECAR_PORT ??= '8906';
process.env.GATE6B_DEV_PORT ??= '8907';
const L = await import('./lib/run6b.mjs');
const { RUN, OUT, SAVES, SIDECAR_DATA, LIBRARY, call, check, cmd, connect, fails, leaveWorld, log, openWorld, refuseKeys, results, root, settle, sleep, startClient,
  state, stopClient, tp, write, copyWorld, plan, prepare, realise, waitRegion } = L;

refuseKeys();
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base', SURV = 'G6B V Survival';
const OWNER = 'test:v';
const KIT = path.join(root, 'kit');
const S7 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's7_flat_village.json'), 'utf8'));
const json = (o) => JSON.stringify(o).replaceAll(' ', '');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

// ---- the apitest mod
const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args}: no JSON answer: ${JSON.stringify(r).slice(0, 400)}`);
  return JSON.parse(line);
};
const result = async (pending, timeoutMs = 120_000) => {
  const key = pending?.pending;
  if (!key) return pending;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api(`get ${key}`);
    if (r && r.value !== undefined && r.value !== null) return r.value;
    await sleep(500);
  }
  throw new Error(`no result for ${key}`);
};
const later = async (args, t) => result(await api(args), t);
const hash = async (min, max) => (await call('dev.box.hash', { min, max }, 600_000)).sha256;

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
  if (!['stop', 'start'].includes(name)) write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
async function fresh(name, from) {
  await leaveWorld();
  copyWorld(from, name);
  await openWorld(name);
}
/** The feet y of a column (the survey's height + 1). */
async function feet(x, z) {
  const h = await later(`heights ${x} ${z} ${x} ${z} 1`);
  return h[0][2] + 1;
}
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice V is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? FLAT, { backend: 'sim' });
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
  if (!fs.existsSync(path.join(SAVES, SURV, 'level.dat'))) {
    await leaveWorld();
    await openWorld(SURV, { mode: 'survival', preset: 'flat', seed: SEED, cheats: true });
    for (const r of ['random_tick_speed 0', 'mob_griefing false', 'advance_time false', 'advance_weather false', 'spawn_mobs false', 'spawn_monsters false']) await cmd(`/gamerule ${r}`);
    await cmd('/time set 6000');
    await call('dev.survival.set', { on: true });
    await cmd('/save-all flush');
    await leaveWorld();
  }
  const stubs = ['g6a_stub_9', 'g6a_stub_14', 'g6a_stub_19', 'g6a_stub_24'];
  if (!stubs.every((id) => fs.existsSync(path.join(LIBRARY, id)))) execFileSync('node', [path.join(root, 'tools', 'gate6a-stubs.mjs'), LIBRARY]);
  spendZero();
  return { worlds: [BASE, FLAT, SURV], seed: SEED };
};

// ------------------------------------------------------------------ item 1: unit and property tests (no game)

function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 1_800_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)) };
}

steps.unit = async () => {
  const out = {};
  out.village = nodeTest(['kit/test/village.test.mjs']);
  check(out.village.code === 0 && out.village.fail === 0 && out.village.pass >= 10, `item 1: kit village tests (500 claims, parity, props, mover, lots type, schema, variants): ${out.village.pass} pass, ${out.village.fail} fail`, out.village.failing);
  out.goldens = nodeTest(['kit/test/region-golden.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/forms-island.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `item 1: goldens unchanged (mega_bench tiles, S1's tile shas, 6b fixtures, islands): ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  out.kit = nodeTest(fs.readdirSync(path.join(root, 'kit', 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `kit/test/${f}`));
  check(out.kit.code === 0 && out.kit.fail === 0, `item 1: the whole kit suite: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const sc = spawnSync('npx', ['vitest', 'run', 'test/regions-village.test.ts', 'test/regions-real-kit-6b.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 900_000 });
  const st = `${sc.stdout}${sc.stderr}`;
  out.sidecar = { code: sc.status, summary: st.split('\n').filter((l) => /Tests|Test Files/.test(l)).join(' | ') };
  check(sc.status === 0, `item 1: sidecar keepOut and real-kit tests: ${out.sidecar.summary}`);
  // the golden tiles of mega_bench and S1 are unchanged: the committed goldens, compared by the tests above
  out.goldenFiles = { megaBench: fs.existsSync(path.join(KIT, 'test', 'fixtures', 'mega_bench.golden.json')), s1: fs.existsSync(path.join(root, 'scenarios', 'goldens', 's1.json')) };
  return out;
};

// ------------------------------------------------------------------ item 2: the broken variants (kit, no game)

steps.variants = async () => {
  const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
  const { planRegion } = await imp('lib/region/plan.mjs');
  const { makeColumns } = await imp('lib/region/pack.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const { lane, surfaceOps } = await imp('lib/region/village.mjs');
  const fv = await imp('regions/flat_village.mjs');
  const claim = { minX: 0, minZ: 0, maxX: 111, maxZ: 111, minY: -64, maxY: 319 };
  const survey = (water) => {
    const c = makeColumns(0, 0, 112, 112, 1);
    for (let j = 0; j < 112; j++) for (let i = 0; i < 112; i++) {
      const k = i + j * 112, wet = water.some((r) => i >= r[0] && i <= r[2] && j >= r[1] && j <= r[3]);
      c.ground[k] = 64; c.height[k] = 64; c.floor[k] = wet ? 61 : 64; c.flags[k] = wet ? 1 : 0;
    }
    return c;
  };
  const lots = S7.params.lots;
  const variant = async (hooks, { s = survey([[90, 4, 99, 13]]), keepOut = [] } = {}) => {
    const program = { id: 'flat_village_broken', params: fv.params, roles: fv.roles, default: (ctx) => fv.build(ctx, hooks) };
    const p = await planRegion({ program, programSource: `broken ${Object.keys(hooks)}`, params: { lots }, survey: s, claim, keepOut, node: 'test' });
    return { p, r: checkRegion({ ir: p.ir, survey: s, meta: p.meta }) };
  };
  const find = (r, f) => r.findings.filter(f).map((x) => ({ rule: x.rule, severity: x.severity, part: x.part, message: x.message }));
  const out = {};
  const base = await variant({});
  out.clean = { errors: base.r.errors, findings: base.r.findings.map((f) => `${f.rule} ${f.part ?? '-'}`) };
  check(base.r.errors === 0 && !base.r.findings.some((f) => /^(M1|M2|M22|M23|M24)/.test(f.rule)), `variants: the unbroken plan is clean (${out.clean.findings.join('; ') || 'no findings'})`);
  let v = await variant({ _unsafe: { noLane: 'cottage_2' } });
  out.noLane = find(v.r, (f) => f.rule === 'M2');
  check(out.noLane.some((f) => f.part === 'lanes' && /cottage_2/.test(f.message)), `variants: a lot with no lane -> M2 (${out.noLane.map((f) => f.message).join('; ')})`);
  v = await variant({ _unsafe: { notOnSquare: 'trading_hall_1' } });
  out.tradeFar = { distance: v.r.metrics.M23.trading_hall_1, findings: find(v.r, (f) => f.rule === 'M23') };
  check(out.tradeFar.distance > 12 && out.tradeFar.findings.length === 1, `variants: the trading hall at ${out.tradeFar.distance} -> M23 (${out.tradeFar.findings.map((f) => f.message).join('; ')})`);
  v = await variant({ after: (reg, Lay) => { const [x, y, z] = Lay.res.bell; const q = reg.part('props_extra', { stage: 'props' }); q._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: [x + 1, z, y, y, 0, x + 1, z, y + 1, y + 1, 1], materials: ['minecraft:oak_fence', 'minecraft:lantern'], cond: 2, walk: false }); } });
  out.propInBell = find(v.r, (f) => f.rule === 'M22');
  check(out.propInBell.length > 0, `variants: a prop in the bell area -> M22 (${out.propInBell.map((f) => f.message).join('; ')})`);
  v = await variant({ _unsafe: { noNearWater: true } }, { s: survey([[100, 50, 105, 62]]) });
  out.farmFar = { water: v.r.metrics.M24.farms.farm_1, findings: find(v.r, (f) => f.rule === 'M24') };
  check(out.farmFar.water > 2 && out.farmFar.findings.length === 1, `variants: a farm at ${out.farmFar.water} from water -> M24 (${out.farmFar.findings.map((f) => f.message).join('; ')})`);
  v = await variant({ after: (reg, Lay) => { const b = Lay.lots[0].lot.box; surfaceOps(reg.parts.find((q) => q.id === 'lanes'), [[b.minX + 2, b.minY - 1, b.minZ + 2], [b.minX + 3, b.minY - 1, b.minZ + 2]], 'path'); } });
  out.laneInBox = { ok: v.r.ok, findings: find(v.r, (f) => f.rule === 'M1') };
  check(!v.r.ok && out.laneInBox.findings.some((f) => f.severity === 'error' && f.part === 'lanes'), `variants: a lane into a lot box -> M1 error (${out.laneInBox.findings.map((f) => f.message).join('; ')})`);
  let refused = null;
  try { await variant({ after: (reg, Lay) => { const e = Lay.lots[0].entrance; lane(reg.parts.find((q) => q.id === 'lanes'), 'lane_x', e, [e[0] + 6, e[1], e[2]], 2, { o: 'ew', keepOut: [[e[0] + 3, e[2] - 2, e[0] + 3, e[2] + 2]] }); } }); } catch (e) { refused = e.message; }
  out.laneAcrossKeepOut = { refused };
  check(/lane lane_x crosses keep-out/.test(refused ?? ''), `variants: a lane across keep-out -> plan refused (${refused})`);
  return out;
};

// ------------------------------------------------------------------ item 3: S7

function scenario(args) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'scenarios.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 4 * 3_600_000, env: process.env });
  const t = `${r.stdout}${r.stderr}`;
  fs.appendFileSync(path.join(OUT, 'scenarios.log'), t);
  return { code: r.status, fails: t.split('\n').filter((l) => /^FAIL /.test(l)), tail: t.split('\n').slice(-30).join('\n') };
}
const S7_ART = () => path.join(process.env.SCENARIOS_ART ? path.resolve(process.env.SCENARIOS_ART) : path.join(path.resolve(root, '..', 'architect-mc'), 'artifacts', 'scenarios'), '6c-v', 's7');
/** The latest S7 run (natural or flat) with metrics: under the scenarios' default dir, or a runner's $SCENARIOS_ART/s7[-flat]. */
const latest = (flat) => {
  const d = S7_ART();
  const runs = fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.endsWith('-flat') === flat && fs.existsSync(path.join(d, x, 'metrics.json'))).sort().map((x) => path.join(d, x)) : [];
  const r = process.env.SCENARIOS_ART && path.join(path.resolve(process.env.SCENARIOS_ART), flat ? 's7-flat' : 's7');
  if (r && fs.existsSync(path.join(r, 'metrics.json'))) runs.push(r);
  runs.sort((a, b) => fs.statSync(path.join(a, 'metrics.json')).mtimeMs - fs.statSync(path.join(b, 'metrics.json')).mtimeMs);
  return runs.length ? runs[runs.length - 1] : null;
};

steps.s7flat = async () => {
  await ensure();
  const r = scenario(['run', 's7', '--phase', '6c-v', '--flat']);
  const dir = latest(true);
  const m = dir ? JSON.parse(fs.readFileSync(path.join(dir, 'metrics.json'), 'utf8')) : null;
  const ex = dir ? JSON.parse(fs.readFileSync(path.join(dir, 'exact.json'), 'utf8')) : null;
  check(r.code === 0, `S7 flat variant: every gated run bar (exit ${r.code})${r.fails.length ? `: ${r.fails.join('; ')}` : ''}`);
  check(ex && ex.mismatches === 0, `S7 flat: E-flat ${ex?.mismatches} mismatches over ${ex?.cellsWritten} written cells (bar 10)`);
  return { dir, rows: m?.rows, exact: ex && { mismatches: ex.mismatches, cellsWritten: ex.cellsWritten }, village: m?.village };
};

steps.s7 = async () => {
  await ensure();
  const r = scenario(['run', 's7', '--phase', '6c-v']);
  const dir = latest(false);
  const m = dir ? JSON.parse(fs.readFileSync(path.join(dir, 'metrics.json'), 'utf8')) : null;
  check(r.code === 0, `S7 natural: every gated run bar but the gallery (exit ${r.code})${r.fails.length ? `: ${r.fails.join('; ')}` : ''}`);
  for (const row of m?.rows ?? []) if (row.gated && row.id !== 'gallery') check(row.pass, `S7 bar ${row.label}: ${row.value} (bar: ${row.threshold})`);
  const ev = dir ? fs.readFileSync(path.join(dir, 'evidence.sha'), 'utf8').trim() : null;
  return { dir, evidence: ev, rows: m?.rows, village: m?.village, tail: r.code ? r.tail : undefined };
};

// ------------------------------------------------------------------ item 4: the behavioural villager test

steps.nav = async () => {
  await ensure();
  const out = {};
  // the S7 run's door-to-bell paths (bar 3, vanilla): 100% of the villager lots
  const dir = latest(false);
  if (dir && fs.existsSync(path.join(dir, 'nav.json'))) {
    const nav = JSON.parse(fs.readFileSync(path.join(dir, 'nav.json'), 'utf8'));
    const vl = Object.entries(nav.lots).filter(([, l]) => ['dwelling', 'job', 'trading_hall', 'farm'].includes(l.villager));
    out.s7 = { run: path.basename(dir), lots: Object.fromEntries(vl.map(([k, l]) => [k, { door: l.door, canReach: l.canReach, nodes: l.nodes }])) };
    check(vl.length > 0 && vl.every(([, l]) => l.canReach), `nav: vanilla villager paths from every villager lot's door cell to the bell in S7 (${vl.filter(([, l]) => l.canReach).length}/${vl.length})`, out.s7);
  } else { out.s7 = 'no S7 natural run here: its door-to-bell paths are S7\'s own bar (3b)'; log(`  ${out.s7}`); }
  await fresh('G6B V Nav', FLAT);
  const X = 3000, Z = 3000;
  await tp(X + 50.5, -40, Z + 0.5, 0, 89);
  const y = await feet(X, Z);
  // range control: a straight 100-cell flat path is found first (a failure below then means "not walkable", not "out of range")
  const rc = await call('dev.nav.villager', { from: [X, y, Z], to: [X + 100, y, Z], range: 160 }, 120_000);
  out.rangeControl = rc;
  check(rc.canReach && rc.nodes >= 100, `nav: range control, a straight 100-cell flat path (canReach ${rc.canReach}, ${rc.nodes} nodes)`);
  // negative control: a cottage raised 3 (a 7x7 stone platform 3 high) reached only by a ladder
  const P = [X, Z + 30];
  await cmd(`/fill ${P[0]} ${y} ${P[1]} ${P[0] + 6} ${y + 2} ${P[1] + 6} minecraft:stone_bricks`);
  await cmd(`/setblock ${P[0] + 3} ${y} ${P[1] - 1} minecraft:ladder[facing=north]`);
  await cmd(`/setblock ${P[0] + 3} ${y + 1} ${P[1] - 1} minecraft:ladder[facing=north]`);
  await cmd(`/setblock ${P[0] + 3} ${y + 2} ${P[1] - 1} minecraft:ladder[facing=north]`);
  await settle(1500);
  const top = [P[0] + 3, y + 3, P[1] + 3];
  const neg = await call('dev.nav.villager', { from: [P[0] + 3, y, P[1] - 8], to: top, range: 64 }, 120_000);
  out.negativeVanilla = neg;
  check(!neg.canReach, `nav: negative control, the platform raised 3 with only a ladder: vanilla canReach ${neg.canReach} (end ${JSON.stringify(neg.end)})`);
  // the kit mover on the same cells (an ARWD dump of the box)
  const box = [P[0] - 4, y - 2, P[1] - 12, P[0] + 10, y + 6, P[1] + 10];
  const file = path.join(OUT, 'nav-negative.arwd.gz');
  await call('dev.region.dump', { box, file, light: false }, 600_000);
  const { decodeArwd, dumpWorld } = await import(pathToFileURL(path.join(KIT, 'lib', 'region', 'vworld.mjs')).href);
  const { walkGraph, nodeReached } = await import(pathToFileURL(path.join(KIT, 'lib', 'region', 'check.mjs')).href);
  const d = await decodeArwd(fs.readFileSync(file));
  const claim = { minX: box[0], minZ: box[2], maxX: box[3], maxZ: box[5], minY: box[1], maxY: box[4] };
  const w = dumpWorld(d, d, claim, {});
  w.colRange ??= () => [box[1], box[4]];
  const kv = nodeReached(walkGraph(w, [[P[0] + 3, y, P[1] - 8]], { mover: 'villager' }), top);
  const kp = nodeReached(walkGraph(w, [[P[0] + 3, y, P[1] - 8]], { mover: 'player' }), top);
  out.negativeKit = { villager: kv, player: kp };
  check(!kv && kp, `nav: negative control, the kit: villager mover ${kv} (the player mover climbs: ${kp})`);
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ item 5: protected area

steps.protect = async () => {
  await ensure();
  const out = {};
  await fresh('G6B V Protect', FLAT);
  const X = 5000, Z = 5000;
  const claim = [X, Z, X + 111, Z + 111];
  await tp(X + 56.5, -40, Z + 56.5, 0, 89);
  const area = { owner: OWNER, id: 'third', x0: X, z0: Z, x1: X + 111, z1: Z + 36, label: 'a third of the claim' };
  await api(`unprotect ${OWNER} third`).catch(() => null);
  out.area = await api(`protect ${json(area)}`);
  const params = { lots: S7.params.lots };
  const p = await plan('flat_village', claim, { params, surveyLoad: 'bounded:256', owner: OWNER, check: false });
  const ir = JSON.parse(fs.readFileSync(path.join(SIDECAR_DATA, 'regions', 'plans', p.planId, 'ir.json'), 'utf8'));
  out.plan = { planId: p.planId, keepOut: ir.keepOut, lots: ir.lots.map((l) => [l.id, l.box.minZ]), notes: p.notes };
  check(json(ir.keepOut) === json([[area.x0, area.z0, area.x1, area.z1]]), `protect: the plan received and honoured the area (IR keepOut ${json(ir.keepOut)})`);
  check(ir.lots.every((l) => l.box.minZ - 1 > area.z1) && ir.roads.every((r) => r.points.every((q) => q[2] - 2 > area.z1)), `protect: the plan routes around it (every lot and the street south of z ${area.z1})`);
  const yr = p.claimY ?? [-64, 64];
  const box = [claim[0] - 8, yr[0] - 2, claim[1] - 8, claim[2] + 8, Math.min(yr[1], -20), claim[3] + 8];
  const before = path.join(OUT, 'protect-before.arwd.gz'), after = path.join(OUT, 'protect-after.arwd.gz');
  await call('dev.region.dump', { box, file: before, light: false }, 900_000);
  const region = await realise(p.planId, { lots: Object.fromEntries(ir.lots.map((l) => [l.id, 'g6a_stub_9'])) });
  const st = await waitRegion(region, 3_600_000);
  out.realise = { state: st.view.state, cells: st.view.cellsWritten, lots: st.view.lots.map((l) => `${l.id}:${l.state}`) };
  await call('dev.region.dump', { box, file: after, light: false }, 900_000);
  const { decodeArwd } = await import(pathToFileURL(path.join(KIT, 'lib', 'region', 'vworld.mjs')).href);
  const a = await decodeArwd(fs.readFileSync(before)), b = await decodeArwd(fs.readFileSync(after));
  let inArea = 0, written = 0;
  for (let x = box[0]; x <= box[3]; x++) for (let z = box[2]; z <= box[5]; z++) for (let yy = box[1]; yy <= box[4]; yy++) {
    if (a.palette[a.cells[a.at(x, yy, z)]] === b.palette[b.cells[b.at(x, yy, z)]]) continue;
    written++;
    if (x >= area.x0 && x <= area.x1 && z >= area.z0 && z <= area.z1) inArea++;
  }
  out.diff = { written, inArea };
  check(st.view.state === 'PLACED' && written > 1000 && inArea === 0, `protect: realised (${st.view.state}, ${written} cells changed in the dump box), 0 cells written in the area (ARWD diff: ${inArea})`);
  await cmd('/kill @e[type=!minecraft:player]');
  const rm = await call('dev.region.remove', { region }, 3_600_000);
  check(rm.removed, `protect: the region removed (${rm.restored} cells)`);
  // a plan made before the mark, realised after it: refused with 0c's typed reason, nothing written
  await api(`unprotect ${OWNER} third`);
  const p2 = await plan('flat_village', claim, { params, surveyLoad: 'bounded:256', owner: OWNER, check: false });
  const ir2 = JSON.parse(fs.readFileSync(path.join(SIDECAR_DATA, 'regions', 'plans', p2.planId, 'ir.json'), 'utf8'));
  await api(`protect ${json(area)}`);
  const h0 = await hash([claim[0], -64, claim[1]], [claim[2], -20, claim[3]]);
  const j0 = (await call('dev.journal.state', {}, 60_000)).entries?.length ?? -1;
  const r2 = await call('dev.region.realise', { planId: p2.planId, lots: Object.fromEntries(ir2.lots.map((l) => [l.id, 'g6a_stub_9'])) }, 300_000);
  await settle(3000);
  const h1 = await hash([claim[0], -64, claim[1]], [claim[2], -20, claim[3]]);
  const j1 = (await call('dev.journal.state', {}, 60_000)).entries?.length ?? -1;
  out.lateMark = { keepOut: ir2.keepOut, refused: r2.refused ?? null, region: r2.region ?? null, journal: [j0, j1], same: h0 === h1 };
  check(json(ir2.keepOut) === '[]' && /PROTECTED/.test(json(r2.refused ?? '')) && h0 === h1 && j0 === j1, `protect: a plan made before the mark, realised after it: refused ${json(r2.refused)}; nothing written (hash ${h0 === h1 ? 'same' : 'CHANGED'}, journal ${j0} -> ${j1})`);
  // a program that reads no keepOut (region_small) keeps 0c's rule: a claim meeting the area is refused PROTECTED
  const r3 = await call('dev.region.plan', { program: 'region_small', claim: [X - 40, Z - 40, X + 151, Z + 151], owner: OWNER, check: false, surveyLoad: 'bounded:256' }, 900_000);
  out.oldProgram = { refused: r3.refused ?? null };
  check(/PROTECTED/.test(String(r3.refused ?? '')), `protect: a program that honours no keep-out is refused PROTECTED as in 0c (${r3.refused})`);
  await api(`unprotect ${OWNER} third`);
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ item 6: Steward's flow on 0a's sim

/** Steward's lantern_shore card program expanded as ProgramPlanner.lots does (S 11x9, M 14x12, L 18x15 footprints, +5 deep). */
export function lanternShoreLots() {
  const F = { S: [11, 9], M: [14, 12], L: [18, 15] };
  const card = [
    { role: "glassblowers' hall", type: 'glassworks', count: 1, footprint: 'L', landmark: true },
    { role: "glassblower's workshop", type: 'workshop', count: 2, footprint: 'M' },
    { role: "lantern maker's workshop", type: 'workshop', count: 2, footprint: 'M' },
    { role: 'artisan cottage', type: 'cottage', count: 4, footprint: 'S' },
    { role: 'lakeside market stall', type: 'shop', count: 1, footprint: 'M', villager: 'trading_hall' },
    { role: 'quiet inn', type: 'tavern', count: 1, footprint: 'M' },
    { role: 'fishing dock and boathouse', type: 'boathouse', count: 1, footprint: 'S', placement: 'near_water' },
  ];
  const n = {};
  const out = [];
  for (const b of card) for (let i = 0; i < b.count; i++) {
    n[b.type] = (n[b.type] ?? 0) + 1;
    const f = F[b.footprint];
    out.push({ id: `${b.type}_${n[b.type]}`, type: b.type, role: b.role, size: [f[0], f[1] + 5], landmark: !!b.landmark && i === 0, placement: b.placement ?? null, ...(b.villager ? { villager: b.villager } : {}) });
  }
  out.push({ id: 'keep_1', type: 'keep', role: 'an oversized keep (unplaced on purpose)', size: [96, 80], villager: 'none' });
  return out;
}

steps.steward = async () => {
  await ensure();
  const out = {};
  await fresh('G6B V Steward', FLAT);
  const X = 7000, Z = 7000;
  await tp(X + 64.5, -40, Z + 64.5, 0, 89);
  const lots = lanternShoreLots();
  // 1. Regions.plan(flat_village, lots): no Claude call; the previews and unplaced go to the card screen
  const claim = [X, Z, X + 127, Z + 127];
  const p = await plan('flat_village', claim, { params: { lots }, surveyLoad: 'bounded:256', owner: OWNER });
  const ir = JSON.parse(fs.readFileSync(path.join(SIDECAR_DATA, 'regions', 'plans', p.planId, 'ir.json'), 'utf8'));
  const site = JSON.parse(fs.readFileSync(path.join(SIDECAR_DATA, 'regions', 'plans', p.planId, 'siteplan.json'), 'utf8'));
  out.plan = { planId: p.planId, placed: ir.lots.map((l) => l.id), unplacedNote: (p.notes ?? []).find((n) => n.startsWith('unplaced:')), siteplanUnplaced: site.unplaced, report: p.report && { errors: p.report.errors, warnings: p.report.warnings } };
  check((p.notes ?? []).some((n) => /^unplaced: .*keep_1/.test(n)) && site.unplaced?.some((u) => u.id === 'keep_1'), `steward: the oversized lot comes back unplaced (${out.plan.unplacedNote}; siteplan ${json(site.unplaced)})`);
  const ext = (p.lots ?? []).map((l) => l.ext?.['architect_mc:village']).filter(Boolean);
  check(ext.length === ir.lots.length && ext.every((e) => e.villager && Array.isArray(e.entrance) && e.lane), `steward: every LotSpec carries ext["architect_mc:village"] (${ext.length}/${ir.lots.length}; e.g. ${json(ext[0])})`);
  check(ir.lots.length >= 10, `steward: ${ir.lots.length} of ${lots.length} lots placed`);
  // 2. a sim massingFirst group keyed by lot id (0b's copies off: one item per lot)
  await api('clear').catch(() => null);
  const items = ir.lots.map((l) => ({ itemKey: l.id, type: lots.find((x) => x.id === l.id).type === 'cottage' ? 'cottage' : 'custom', style: 'rustic', size: [l.box.maxX - l.box.minX + 1, 24, l.box.maxZ - l.box.minZ + 1 - 5].map((v) => Math.max(7, Math.min(96, v))) }));
  const gid = await later(`opgroup v vflow:${Date.now().toString(36)} ${b64({ name: 'Lantern Shore', bible: 'birch', owner: OWNER, items, massingFirst: true, approvalUi: 'owner' })}`);
  let g = null;
  for (let i = 0; i < 240; i++) { g = await api(`group0a ${gid}`); if (g?.status === 'AWAITING_APPROVAL' || ['DONE', 'FAILED', 'CANCELLED'].includes(g?.status)) break; await sleep(1000); }
  check(g?.status === 'AWAITING_APPROVAL', `steward: the massingFirst group awaits approval (${g?.status})`);
  await later(`approve va ${gid} ${b64({ approve: items.map((i) => i.itemKey), owner: OWNER })}`);
  for (let i = 0; i < 600; i++) { g = await api(`group0a ${gid}`); if (['DONE', 'FAILED', 'CANCELLED'].includes(g?.status)) break; await sleep(1000); }
  const entries = Object.fromEntries((g?.items ?? []).filter((it) => it.entryId).map((it) => [it.itemKey, it.entryId]));
  out.group = { id: gid, status: g?.status, entries };
  check(g?.status === 'DONE' && Object.keys(entries).length === ir.lots.length, `steward: the group is DONE with an entry per lot (${Object.keys(entries).length}/${ir.lots.length})`);
  // 3. fitToLot with the default CentreOn.ENTRANCE
  const fits = {};
  for (const l of ir.lots) {
    const b = l.box;
    const f = await api(`fit ${entries[l.id]} ${[b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ].join(',')} ${l.front} owner=${OWNER}`);
    fits[l.id] = { fits: f.fits ?? f.ok ?? null, verdict: f.verdict?.ok ?? null, why: f.why ?? f.verdict?.refusals?.map((r) => r.reason) ?? null };
  }
  out.fits = fits;
  check(Object.values(fits).every((f) => f.fits !== false), `steward: fitToLot fits every lot (${json(Object.entries(fits).filter(([, f]) => f.fits === false))})`);
  // 4. realise(lotEntries); 5. one exact Regions.remove
  const yr = p.claimY ?? [-64, 64];
  const min = [claim[0] - 8, yr[0], claim[1] - 8], max = [claim[2] + 8, Math.min(yr[1], 0), claim[3] + 8];
  const h0 = await hash(min, max);
  const region = await realise(p.planId, { lots: entries });
  const st = await waitRegion(region, 3_600_000);
  out.realise = { state: st.view.state, lots: st.view.lots.map((l) => `${l.id}:${l.state}`) };
  check(st.view.state === 'PLACED' && st.view.lots.every((l) => l.state === 'placed'), `steward: realise(lotEntries) placed every lot (${st.view.state}; ${out.realise.lots.join(', ')})`);
  await cmd('/kill @e[type=!minecraft:player]');
  const rm = await call('dev.region.remove', { region }, 3_600_000);
  await settle(5000);
  const h1 = await hash(min, max);
  out.remove = { removed: rm.removed, restored: rm.restored, exact: h0 === h1 };
  check(rm.removed && h0 === h1, `steward: one Regions.remove is exact (${rm.restored} cells; hash ${h0 === h1 ? 'equal' : 'DIFFERS'})`);
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ the coordinator's C16 addition

steps.survroad = async () => {
  await ensure();
  await fresh('G6B V SurvRoad', SURV);
  await call('dev.survival.set', { on: true });
  const X = 9000, Z = 9000;
  await cmd('/gamemode creative');
  await tp(X + 20.5, 0, Z + 30.5, 0, 89);
  const y = await feet(X, Z);
  const out = {};
  const kinds = ['dirt', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt', 'grass_block', 'sand'];
  for (const [i, k] of kinds.entries()) {
    const z = Z + i * 10;
    await cmd(`/fill ${X - 2} ${y - 1} ${z - 2} ${X + 32} ${y - 1} ${z + 2} minecraft:${k}`);
    await settle(500);
    const road = { points: [[X, y, z], [X + 30, y, z]], width: 1, owner: OWNER, mode: 'CONSTRUCTION' };
    const c = await api(`roadcheck ${json(road)}`);
    out[k] = { ok: c.ok, construction: c.construction, bom: c.bom ?? null };
  }
  for (const k of kinds.slice(0, 6)) check(out[k].ok && out[k].construction && json(out[k].bom) === '{}', `survroad: a construction road's dirt path on ${k} is free (BOM ${json(out[k].bom)})`);
  check(out.sand.ok && Object.keys(out.sand.bom ?? {}).length > 0, `survroad: on sand it costs (BOM ${json(out.sand.bom)})`);
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'variants', 's7flat', 's7', 'nav', 'protect', 'steward', 'survroad']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  const spend = JSON.parse(fs.readFileSync(path.join(OUT, 'spend.json'), 'utf8'));
  const md = `# Gate 6c-V (flat village, C10)\n\nSpend: $${spend.totalUsd.toFixed(2)} (cap $${spend.capUsd}).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  return { lines: rows.length };
};

// ------------------------------------------------------------------ the main
const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cv.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
