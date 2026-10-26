#!/usr/bin/env node
// Phase 7a slice RK gate (docs/CONTRACT.md "Phase 7a slice RK: rock stairs" §8) against a dev client or the headless server of the RK
// run worktree (`../architect-mc-RK-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). Ports 8980 (sidecar) /
// 8981 (DevBridge) by default (the runner sets its own; RK's range is 8980-8989). $0: no Claude call anywhere.
//
//   node tools/gate7ark.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit      (rk-unit)               items 1, 2 (kit), 10 offline: kit/test/rk.test.mjs (the profile, cut and bore per tread, the tread
//                                       rule, v7a_rk_ridge through the two-plan flow, routed down, 1 wide, every refusal with its evidence,
//                                       the KC row, the broken variants, the catalogue flip, determinism, rockstairs_demo flat and natural,
//                                       the look's joins and theme in three bibles), the foundation's, P0's, T3's and T2's tests; the
//                                       structure lint's p0:rk and p0:valid/even cases; the catalogue diff; the Java tests (PlanChecksRKTest,
//                                       ApiRKTest, PlanChecksT3Test)
//     unchanged (rk-unit)               item 2: every committed plan fixture without a rock stair plans as on the merge base (answers, IR,
//                                       the first plan; tools/lib/gate7a-kit.mjs), but RK's named movers (RK_MOVED)
//     ingame    (rk-ingame)             items 3-8 on flat worlds (headless): rockstairs_demo flat (two hills raised in stage ground; the
//                                       two-plan flow) planned, realised, re-read from the dumps (every tread rises 1, landings flat, cover
//                                       where bored, every shell cell solid, 0 falling blocks through a 60 s stand, 0 fluid within 2, M3 0,
//                                       M4 0, M5 0 dark treads, M6 0, M10:rock_stair 0; realised == virtual), the kit movers and vanilla
//                                       dev.nav.villager up and down both flights (the hard bar), Regions.remove (E-flat 0); v7a_rk_ridge
//                                       (plan v1's shape) on its terrain by commands: Regions.checkPlan with load "generate"
//                                       (READY, "read N frozen volume(s)"), the stale rock (a shell cell
//                                       mined, water 2 from the void: ARTIFACT_STALE naming the rock stair and the cell; with neither it
//                                       realises), re-read, crossed, removed (E-flat 0)
//     survival  (rk-survival)           item 9 (RS merged): v7a_rk_ridge in survival: checked in survival, fed from a stockpile, built;
//                                       the bills equal the check's cost.survival.bom; the world equal to its INSTANT twin; removed E-flat 0
//     natural   (rk-natural)            items 3, 5, 6, 8 on the pinned hill (scenarios/sites/tunnel_hill.json, a fresh copy of the seed
//                                       world): rockstairs_demo natural (the claim's rock read as a frozen volume; the best flight by the
//                                       survey passed by the rock), realised, re-read (the cells the plan wrote: tree and water drift
//                                       elsewhere recorded, not judged), vanilla villagers both ways, the removal's E-normal (0 unclassified
//                                       within 6 of the written cells); item 3's load: the same flight as a plan/0 rock stair on a fresh copy,
//                                       the corridor never generated: load "loaded" incomplete VOLUME, "generate" READY with its volume read
//     look      (rk-look)               item 11 (client, recorded not judged: N-RK-1): rockstairs_demo flat in three bibles: the carved
//                                       stair up the slope and the bored stair through the ridge, each at its foot, mid-flight and its top
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7a-rk/<step>.json in the main checkout (GATE7ARK_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-RK-run');
process.env.GATE6B_OUT = process.env.GATE7ARK_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7a-rk');
process.env.GATE6B_SIDECAR_PORT ??= '8980';
process.env.GATE6B_DEV_PORT ??= '8981';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, leaveWorld, log, results, root, state, startClient, stopClient, tp } = L;
const core = await import('./lib/gate6chy-core.mjs');
const B = await import('./lib/gate6chy-b.mjs');
const G = await import('./lib/gate6crs-game.mjs');

L.refuseKeys();
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const OWNER = 'test:rk';
const FLAT_CLAIM = [6000, 6000, 6239, 6127];
const SITE_FILE = path.join(root, 'scenarios', 'sites', 'tunnel_hill.json');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };
const sideDir = (id) => path.join(L.SIDECAR_DATA, 'regions', 'plans', id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice RK is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6C RK Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  for (const name of [BASE, FLAT]) await L.ensureBase(name);
  spendZero();
  return { worlds: [BASE, FLAT], seed: SEED };
};

// ------------------------------------------------------------------ offline

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);

steps.unit = async () => {
  const out = {};
  out.rk = kitOnce(['kit/test/rk.test.mjs']);
  check(out.rk.code === 0 && out.rk.fail === 0 && out.rk.pass >= 10, `item 1 (kit): the profile (landings every 8, built from the lower end), cut and bore per tread, the tread rule (ANCHOR; the fill of 1), v7a_rk_ridge through the two-plan flow (fits; the crossing, the graph edge, the guards named rock_stair, the BOM, M3/M4/M5/M6/M10:rock_stair clean, the kit movers both ways), routed down and 1 wide, the refusals NO_CLIMB, SPAN 49, ANCHOR, WATER (at 3 fits), PROTECTED, incomplete VOLUME (cap, unread), KC (WATER {kind: body}; at 3 M25:clear 0), the broken variants, the catalogue flip, determinism, rockstairs_demo flat and natural, joined parapets on something and every block themed in three bibles: ${out.rk.pass} pass, ${out.rk.fail} fail`, out.rk.failing);
  out.found = kitOnce(['kit/test/f7a-foundation.test.mjs', 'kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/t3-foundation.test.mjs', 'kit/test/tunnel-t3b.test.mjs', 'kit/test/plan-t3b.test.mjs', 'kit/test/route-t2.test.mjs', 'kit/test/region-lint.test.mjs', 'kit/test/catalogue-since.test.mjs', 'kit/test/kc.test.mjs']);
  check(out.found.code === 0 && out.found.fail === 0, `items 2, 10 (kit): the foundation's tests, P0 (connector.rock_stair supported, e15 off it), T3's foundation and T3b's tests (tunnels unchanged), T2's routes, KC, the realise lint: ${out.found.pass} pass, ${out.found.fail} fail`, out.found.failing);
  const lint = spawnSync(process.execPath, ['tools/lint.mjs', 'structure', '--only', 'p0:rk,p0:tunnel/1,p0:tunnel/2,even:tunnel,fx:tunnel_hill'], { cwd: root, encoding: 'utf8', timeout: 1_800_000 });
  out.lint = `${lint.stdout}${lint.stderr}`.trim().split('\n').slice(-16);
  check(lint.status === 0, 'item 5 (lint): the structure lint\'s p0:rk (the refusal set as expected, the broken variants caught, S-THEME clean) and the tunnels\' cases unchanged', out.lint);
  const d = spawnSync(process.execPath, ['tools/plan-catalogue-diff.mjs', 'kit/test/fixtures/plan/catalogue-pre7a.json', 'kit/schemas/plan-catalogue.golden.json'], { cwd: root, encoding: 'utf8' });
  out.diff = `${d.stdout}${d.stderr}`.trim();
  const flips = (/reserved -> supported: (.*)/.exec(out.diff) ?? [])[1] ?? '';
  check(d.status === 0 && flips.split(', ').includes('connector.rock_stair') && /retired: none/.test(out.diff) && /REMOVED \(never allowed\): none/.test(out.diff), `item 10: tools/plan-catalogue-diff.mjs pre-7a -> the golden flips connector.rock_stair reserved -> supported (limits.volume: true; with the other merged 7a slices'): ${flips}; nothing retired or removed`, out.diff.split('\n'));
  // the slice's Java: PlanChecks.hasTunnel counts rock_stair, the stale rock names it; the feature
  const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.join(root, '.gradle-home') };
  const gr = spawnSync('./gradlew', ['test', '--offline', '--tests', '*PlanChecksRKTest', '--tests', '*ApiRKTest', '--tests', '*PlanChecksT3Test'], { cwd: path.join(root, 'mod'), encoding: 'utf8', env, timeout: 1_800_000 });
  out.java = { code: gr.status, tail: `${gr.stdout}${gr.stderr}`.trim().split('\n').slice(-8) };
  check(gr.status === 0, 'items 3, 7, 10 (Java): PlanChecksRKTest (a rock_stair part plans twice; the guard\'s connector names the stale rock "rock_stair <part>: ..."; a tunnel\'s message unchanged), ApiRKTest (feature rockStairs), PlanChecksT3Test', out.java.tail);
  // (the latest archived jars' mode: 0.42.0, 0.41.0, 0.40.1 apitest jars and the 0.42.0 surface; GATE7ARK_APICOMPAT another)
  const flag = process.env.GATE7ARK_APICOMPAT ?? '--gate7acl';
  const ac = spawnSync(process.execPath, ['tools/api-compat.mjs', flag], { cwd: root, encoding: 'utf8', timeout: 1_800_000, env: { ...process.env, PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` } });
  out.apicompat = { flag, code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter((l) => /^(ok|FAIL)/.test(l)) };
  check(ac.status === 0, `item 10: api-compat ${flag} clean (a feature only: no record, method or enum value)`, out.apicompat.tail);
  spendZero();
  return out;
};

steps.unchanged = async () => {
  const { RK_MOVED } = await import('./lib/rk-norm.mjs');
  const K = await import('./lib/gate7a-kit.mjs');
  const u = await K.unchanged(root, { check, log, base: 'RK', except: RK_MOVED, mergedIf: 'kit/lib/region/checkRockStairs.mjs' });
  fs.writeFileSync(path.join(OUT, 'rk-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  return { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, moved: u.moved };
};

// ------------------------------------------------------------------ in game: the re-read

async function volumesOf(planDir, ir) {
  const { decodeArvx } = await imp('lib/region/volume.mjs');
  const out = [];
  for (const v of Object.values(ir.volumes ?? {})) {
    const sha = ir.blobs?.[v.blob]?.sha;
    const f = sha ? path.join(planDir, 'blobs', `${sha}.bin`) : null;
    if (f && fs.existsSync(f)) out.push(decodeArvx(fs.readFileSync(f)));
  }
  return out;
}

/** The realised world from two dumps (the plan's virtual world marks its cells) and the checker on it. */
async function realisedOf(planDir, beforeFile, afterFile) {
  const { buildVirtual, decodeArwd, dumpWorld } = await imp('lib/region/vworld.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw } = buildVirtual({ ir, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs, volumes: await volumesOf(planDir, ir) });
  const before = await decodeArwd(fs.readFileSync(beforeFile)), after = await decodeArwd(fs.readFileSync(afterFile));
  const world = dumpWorld(before, after, ir.claim, { virtual: vw, lots: ir.lots });
  const rep = checkRegion({ ir, meta, world, prefix: false });
  return { ir, meta, world, rep, before, after };
}

/** Item 5 over the realised world: every flight's bars re-read; the kit movers both ways. */
async function item5(tag, { meta, world, rep }) {
  const { walkGraph, nodeReached } = await imp('lib/region/check.mjs');
  const per = rep.metrics.rockStairs?.per ?? [];
  const recs = meta.rockStairs ?? [];
  const out = { rockStairs: per.map((q) => ({ ...q, tunnel: q.tunnel && { coverMin: q.tunnel.coverMin, bore: q.tunnel.bore, shell: q.tunnel.shell, shellOpen: q.tunnel.shellOpen, gravity: q.tunnel.gravity, fluids: q.tunnel.fluids, notClear: q.tunnel.notClear } })), M5rockStair: rep.metrics.M5rockStair ?? null };
  check(per.length === recs.length && per.length >= 1, `item 5 (${tag}): ${per.length} flight(s) re-read from the realised world (${per.map((q) => `${q.steps} steps, ${q.landings} landing(s)`).join(', ')})`);
  check(per.every((q) => q.rises === q.steps && q.badRise === 0 && q.badLanding === 0 && q.flat === 2 * q.landings) && !rep.findings.some((f) => f.rule === 'M10:rock_stair'), `item 5 (${tag}): every tread rises 1 (a stairs block facing up the flight), landings every 8 and flat, every tread on site-solid ground with 2 clear (M10:rock_stair 0): ${per.map((q) => `${q.rises}/${q.steps} rises, ${q.flat} flat, ${q.unanchored} unanchored`).join('; ')}`);
  check(per.every((q) => (q.tunnel?.bore ?? 0) === 0 || (q.tunnel.coverMin ?? 0) >= 2), `item 5 (${tag}): cover of 2 or more over every bored tread (${per.map((q) => `${q.tunnel?.bore ?? 0} bored, cover >= ${q.tunnel?.coverMin ?? '-'}`).join('; ')})`);
  check(per.every((q) => (q.tunnel?.shellOpen ?? 0) === 0 && (q.tunnel?.gravity ?? 0) === 0), `item 5 (${tag}): every shell cell solid and not falling, 0 falling blocks over the void (${per.map((q) => `${(q.tunnel?.shell ?? 0) - (q.tunnel?.shellOpen ?? 0)}/${q.tunnel?.shell ?? 0} shell, ${q.tunnel?.gravity ?? 0} gravity`).join('; ')})`);
  check(per.every((q) => (q.tunnel?.fluids ?? 0) === 0), `item 5 (${tag}): 0 fluid cells within 2 of the void (${per.map((q) => q.tunnel?.fluids ?? 0).join(', ')})`);
  const own = new Set(recs.map((q) => q.part));
  const m3 = rep.findings.filter((f) => /^M3/.test(f.rule) && own.has(f.part)), m4 = rep.findings.filter((f) => /^M4/.test(f.rule) && own.has(f.part)), m6 = rep.findings.filter((f) => f.rule === 'M6' && own.has(f.part));
  check(!m3.length && !m4.length && !m6.length, `item 5 (${tag}): M3 0, M4 0, M6 0 in the rock stair parts (${[...m3, ...m4, ...m6].map((f) => `${f.rule} ${f.count}`).join(', ') || 'none'})`);
  check(rep.metrics.M5rockStair && rep.metrics.M5rockStair.darkSpawnable === 0 && rep.metrics.M5rockStair.treads > 0, `item 5 (${tag}): M5 0 dark treads (the realised light: ${json(rep.metrics.M5rockStair && { dark: rep.metrics.M5rockStair.darkSpawnable, treads: rep.metrics.M5rockStair.treads })})`);
  out.movers = {};
  for (const q of recs) {
    const a = [q.from[0], q.from[1] + 1, q.from[2]], b = [q.to[0], q.to[1] + 1, q.to[2]];
    out.movers[q.id] = Object.fromEntries(['player', 'villager'].map((m) => [m, nodeReached(walkGraph(world, [a], { mover: m }), b) && nodeReached(walkGraph(world, [b], { mover: m }), a)]));
  }
  check(Object.values(out.movers).every((v) => v.player && v.villager), `item 6 (${tag}): kit player and villager movers up and down every flight (${json(out.movers)})`);
  return out;
}

/** Vanilla's villager path up and down every flight (the hard bar), from its start walk cell to its landing (feet cells). */
async function nav(meta) {
  const out = {};
  for (const q of meta.rockStairs ?? []) {
    const a = [q.from[0], q.from[1] + 1, q.from[2]], b = [q.to[0], q.to[1] + 1, q.to[2]];
    const ab = await call('dev.nav.villager', { from: a, to: b, range: 256 }, 120_000);
    const ba = await call('dev.nav.villager', { from: b, to: a, range: 256 }, 120_000);
    out[q.id] = { width: q.width, there: !!ab.canReach, back: !!ba.canReach, nodes: [ab.nodes ?? null, ba.nodes ?? null] };
  }
  return out;
}

/** Falling-block entities now (an /execute count): the sand band must never fall. */
async function fallingNow() {
  const r = await cmd('/execute if entity @e[type=minecraft:falling_block]').catch(() => ({ messages: [] }));
  const msg = (r.messages ?? []).join(' ');
  const m = /count: (\d+)/i.exec(msg);
  return m ? +m[1] : /passed/i.test(msg) ? 1 : 0;
}

async function stateAt(x, y, z) {
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  const f = path.join(OUT, `cell-${x}_${y}_${z}.arwd.gz`);
  await call('dev.region.dump', { box: [x, y, z, x, y, z], file: f }, 60_000);
  const d = await decodeArwd(fs.readFileSync(f));
  return d.palette[d.cells[d.at(x, y, z)]];
}

/** The P2 SMOKE row: realised == virtual per writer kind (strict on a flat world). */
async function smoke(tag, planDir, after, before, strict) {
  const RV = await import('./lib/realised-virtual.mjs');
  const rv = await RV.realisedVsVirtual(planDir, after, before, { lots: false });
  check(rv.differ === 0 || !strict, `item 5/P2 SMOKE (${tag}${strict ? ', strict' : ''}): realised == virtual, ${rv.differ} of ${rv.written} differ: ${RV.describeRealised(rv)}${rv.first.length ? ` first ${json(rv.first.slice(0, 3))}` : ''}`);
  return { written: rv.written, differ: rv.differ, byKind: rv.byKind, first: rv.first };
}

/** Plan rockstairs_demo (the two-plan flow), realise (falling blocks counted through a stand), re-read, nav, remove. */
async function demoRun(tag, claim, { kind, standMs = 60_000 }) {
  const out = { claim, kind };
  const flat = kind === 'flat';
  await tp((claim[0] + claim[2]) / 2, flat ? -20 : 200, (claim[1] + claim[3]) / 2);
  const p = await L.plan('rockstairs_demo', claim, { params: { variant: kind }, surveyLoad: 'bounded:256', check: true, owner: OWNER });
  const planDir = sideDir(p.planId);
  out.plan = { planId: p.planId, irSha: p.irSha, notes: (p.notes ?? []).slice(-2) };
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const fl = meta.rockStairs ?? [];
  check(fl.length >= (flat ? 2 : 1), `${tag}: rockstairs_demo (${kind}) planned ${fl.length} flight(s) through the two-plan flow (${fl.map((q) => `${q.steps} steps, ${q.landings} landing(s), ${q.bore.filter(Boolean).length} bored`).join('; ')}; ${out.plan.notes.join(' / ')})`);
  if (!fl.length) return out;
  out.flight = { from: fl[0].from, to: fl[0].to, rise: fl[0].rise };
  if (flat) check(fl.some((q) => q.bore.some(Boolean) && q.bore.some((b) => !b)) && fl.some((q) => q.bore.every((b) => !b)), `${tag}: the ridge's flight part cut and part bored, the slope's carved the whole way`);
  const { buildVirtual } = await imp('lib/region/vworld.mjs');
  const irP = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const blobsP = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw: vP } = buildVirtual({ ir: irP, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs: blobsP, volumes: await volumesOf(planDir, irP) });
  let y0 = Infinity, y1 = -Infinity;
  vP.eachWritten((x, y) => { if (y < y0) y0 = y; if (y > y1) y1 = y; });
  const box = [claim[0] - 8, Math.max(-64, y0 - 8), claim[1] - 8, claim[2] + 8, Math.min(319, y1 + 8), claim[3] + 8];
  await tp((claim[0] + claim[2]) / 2, Math.min(319, y1 + 20), (claim[1] + claim[3]) / 2);
  await L.settle(flat ? 5000 : 60_000);
  const before = path.join(OUT, `${tag}-before.arwd.gz`), after = path.join(OUT, `${tag}-after.arwd.gz`), snapF = path.join(OUT, `${tag}-snap.gz`);
  await call('dev.region.dump', { box, file: before, light: true }, 1_800_000);
  const snap = await call('dev.region.hash', { box, mode: 'snap', file: snapF }, 4 * 3_600_000);
  await cmd('/kill @e[type=!minecraft:player]');
  const region = await L.realise(p.planId, {});
  let falling = 0;
  const st = await L.waitRegion(region, 3 * 3_600_000, async (s) => { falling = Math.max(falling, await fallingNow()); if (s.waiting?.OCCUPIED) await cmd('/kill @e[type=!minecraft:player]'); });
  out.realise = { state: st.view.state, cells: st.record?.cellsWritten ?? st.view.cellsWritten };
  check(st.view.state === 'PLACED', `${tag}: realised (${st.view.state}, ${out.realise.cells} cells)`);
  for (let t = 0; t < standMs; t += 10_000) { await L.gameWait(10_000, { real: sleep, label: `rk ${tag} stand, 200 ticks` }); falling = Math.max(falling, await fallingNow()); }
  out.falling = falling;
  check(falling === 0, `item 5 (${tag}): 0 falling-block entities during the realise and a ${standMs / 1000} s stand (the sand lined; max seen ${falling})`);
  await call('dev.region.dump', { box, file: after, light: true }, 1_800_000);
  const R = await realisedOf(planDir, before, after);
  out.item5 = await item5(tag, R);
  out.smoke = await smoke(tag, planDir, after, before, flat);
  await cmd('/kill @e[type=!minecraft:player]');
  out.nav = await nav(R.meta);
  check(Object.keys(out.nav).length >= 1 && Object.values(out.nav).every((v) => v.there && v.back), `item 6 (${tag}, the hard bar): vanilla dev.nav.villager up and down every flight (${json(Object.fromEntries(Object.entries(out.nav).map(([k, v]) => [k, [v.width, v.there, v.back]])))})`);
  await cmd('/kill @e[type=!minecraft:player]');
  await L.settle(5000);
  const rm = await call('dev.region.remove', { region, requester: OWNER }, 4 * 3_600_000);
  await L.settle(10_000);
  const diff = await call('dev.region.hash', { box, mode: 'diff', file: snapF }, 4 * 3_600_000);
  out.exact = { kind: flat ? 'E-flat' : 'E-normal', box, snapCells: snap.cells, removed: rm.removed, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes, list: (diff.list ?? []).slice(0, 50) };
  fs.writeFileSync(path.join(OUT, `${tag}-exact.json`), `${JSON.stringify(out.exact, null, 2)}\n`);
  if (flat) check(rm.removed && diff.mismatches === 0, `item 8 (${tag}): Regions.remove by its owner restores the box exactly: E-flat ${diff.mismatches} (${rm.restored} cells restored; journal ${out.realise.cells} cells written)`);
  else {
    // (natural: judge the cells the plan wrote and 6 round them (T3b's rule); tree and water drift elsewhere on the claim is recorded)
    const written = new Set();
    vP.eachWritten((x, y, z) => { written.add(`${x},${y},${z}`); });
    const near = (pos) => { const [x, y, z] = String(pos).split(/[ ,]+/).map(Number); for (let dx = -6; dx <= 6; dx++) for (let dy = -6; dy <= 6; dy++) for (let dz = -6; dz <= 6; dz++) if (written.has(`${x + dx},${y + dy},${z + dz}`)) return true; return false; };
    const list = diff.list ?? [];
    const close = list.filter((m) => near(m.pos) && (m.class ?? 'none') === 'none');
    out.exact.near = { unclassified: close.length, sample: close.slice(0, 8), listed: list.length, truncated: list.length < diff.mismatches };
    check(rm.removed && close.length === 0 && (diff.classes?.gravity ?? 0) === 0, `item 8 (${tag}): the removal's E-normal: 0 unclassified mismatches within 6 of the ${written.size} written cells (${diff.mismatches} mismatches over the box, ${json(diff.classes ?? {})}: drift elsewhere recorded, not judged)`, close.slice(0, 8));
  }
  return out;
}

/** A fixture's check's plan dir (the sidecar's, by the check's id), else the kit's plan of the same request over the world's survey. */
async function planDirOf(tag, s, ck) {
  const id = ck.check?.checkId;
  if (id && fs.existsSync(path.join(sideDir(id), 'meta.json'))) return sideDir(id);
  const H = await imp('test/plan-helpers.mjs');
  const file = path.join(OUT, `${tag}-survey.arsv`);
  await call('dev.region.survey', { claim: s.W.claim, surveyLoad: 'bounded:256', file }, 900_000);
  const bytes = fs.readFileSync(file);
  const claim = { minX: s.W.claim[0], minZ: s.W.claim[1], maxX: s.W.claim[2], maxZ: s.W.claim[3], minY: -64, maxY: 319 };
  const r = await H.checkPlanLocal(s.wp.plan, { survey: bytes, claim, anchors: s.wp.anchors, protected: s.wp.protected ?? [] });
  const dir = path.join(OUT, `${tag}-plan`);
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ir.json'), r.res.irJson);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(r.res.meta));
  fs.writeFileSync(path.join(dir, 'survey.bin'), bytes);
  for (const [sha, b] of r.res.blobs) fs.writeFileSync(path.join(dir, 'blobs', `${sha}.bin`), b);
  return dir;
}

/**
 * v7a_rk_ridge (plan v1's shape) on its terrain by commands: Regions.checkPlan with load "generate" (READY, its volume read), the stale rock (item 7), realiseApproved, re-read, crossed, removed (item 8).
 */
async function ridgeRun(tag) {
  const out = { fixture: 'valid/v7a_rk_ridge.json' };
  const fx = G.fixture(ctx, 'valid/v7a_rk_ridge.json');
  const s = await G.site(ctx, tag, fx, { creative: true });
  const W = s.W;
  await tp((W.claim[0] + W.claim[2]) / 2, 120, (W.claim[1] + W.claim[3]) / 2);
  const ck = await G.check(ctx, tag, s);
  const a = (ck.check?.parts ?? []).find((q) => q.part === 'flight');
  out.check = { overall: ck.check?.overall ?? null, class: a?.class ?? null, rockStairs: a?.geometry?.rockStairs ?? null, notes: a?.notes ?? null, volumePass: ck.volumePass ?? null, checkNotes: (ck.check?.notes ?? []).slice(-3) };
  check(ck.check?.overall === 'READY' && a?.class === 'fits', `item 3/4 (${tag}): v7a_rk_ridge (plan v1's shape) through Regions.checkPlan (load "generate"): ${ck.check?.overall}, flight ${a?.class} (${json((a?.geometry?.rockStairs ?? []).map((q) => [q.rise, q.steps, q.crossing?.cover, q.bore, q.cut]))})`);
  const readNote = [...(ck.check?.notes ?? []), ...(a?.notes ?? [])].find((n) => /read \d+ frozen volume/.test(n)) ?? null;
  check(!!readNote, `item 3 (${tag}): the check read its corridor's frozen volume ("${readNote}")`);
  if (!ck.check?.artifactSha) return out;
  const sha = ck.check.artifactSha;
  const planDir = await planDirOf(tag, s, ck);
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const rec = (meta.rockStairs ?? [])[0];
  // item 7: the stale rock: a shell cell of a bored tread mined, then water 2 from the void: ARTIFACT_STALE naming the rock stair and the cell
  if (rec) {
    const i = rec.bore.findIndex(Boolean) + 3; // (rec.bore[k] is tread k + 1: a bored tread 2 in from the portal)
    const [dx, dz] = rec.dir, [rx, rz] = [-dz, dx];
    const lane = (v) => [rec.from[0] + dx * i + rx * v, rec.from[2] + dz * i + rz * v];
    const ty = rec.ys[i];
    const [tx, tz] = lane(rec.hi);
    const mined = [tx, ty + rec.height + 1, tz]; // the roof over the tread's hi lane: a shell cell
    const wasM = await stateAt(...mined);
    await cmd(`/setblock ${mined.join(' ')} minecraft:air`);
    const s1 = await call('dev.region.realiseApproved', { sha }, 300_000);
    const msg1 = JSON.stringify(s1);
    out.staleMine = { cell: mined, message: s1.message ?? s1.refused ?? msg1 };
    check(/ARTIFACT_STALE/.test(msg1) && /rock_stair flight/.test(msg1) && msg1.includes(`(${mined.join(', ')})`), `item 7 (${tag}): a shell cell mined (${mined.join(',')}): realiseApproved ARTIFACT_STALE naming the rock stair and the cell (${String(out.staleMine.message).slice(0, 220)})`);
    await cmd(`/setblock ${mined.join(' ')} ${wasM}`);
    const [wx, wz] = lane(rec.hi + 2);
    const wet = [wx, ty + 1, wz]; // 2 from the void's hi lane, beside the feet: in the fluid buffer
    const wasW = await stateAt(...wet);
    await cmd(`/setblock ${wet.join(' ')} minecraft:water`);
    const s2 = await call('dev.region.realiseApproved', { sha }, 300_000);
    const msg2 = JSON.stringify(s2);
    out.staleWater = { cell: wet, message: s2.message ?? s2.refused ?? msg2 };
    check(/ARTIFACT_STALE/.test(msg2) && /rock_stair flight/.test(msg2) && msg2.includes(`(${wet.join(', ')})`), `item 7 (${tag}): water set 2 from the void (${wet.join(',')}): realiseApproved ARTIFACT_STALE naming the rock stair and the cell (${String(out.staleWater.message).slice(0, 220)})`);
    await cmd(`/setblock ${wet.join(' ')} ${wasW}`);
    await L.settle(3000);
  }
  // with neither: it realises; re-read, crossed, removed
  const box = G.boxOf(W);
  const before = path.join(OUT, `${tag}-before.arwd.gz`), after = path.join(OUT, `${tag}-after.arwd.gz`);
  await call('dev.region.dump', { box, file: before, light: true }, 1_800_000);
  const pre = await G.snap(ctx, box, `rk-${tag}-pre`);
  await cmd('/kill @e[type=!minecraft:player]');
  const region = await G.realise(ctx, sha);
  check(!!region, `item 7 (${tag}): with neither change, realiseApproved realises the approved artifact (${region})`);
  let falling = 0;
  const st = await L.waitRegion(region, 3_600_000, async (x) => { falling = Math.max(falling, await fallingNow()); if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(x?.waiting?.reason)) await cmd('/kill @e[type=!minecraft:player]'); });
  check(st.view.state === 'PLACED', `item 4 (${tag}): realised from its approved artifact (${st.view.state})`);
  for (let t = 0; t < 60_000; t += 10_000) { await L.gameWait(10_000, { real: sleep, label: `rk ${tag} stand, 200 ticks` }); falling = Math.max(falling, await fallingNow()); }
  out.falling = falling;
  check(falling === 0, `item 5 (${tag}): 0 falling-block entities during the realise and a 60 s stand (the sand band lined; max ${falling})`);
  await call('dev.region.dump', { box, file: after, light: true }, 1_800_000);
  const R = await realisedOf(planDir, before, after);
  out.item5 = await item5(tag, R);
  out.smoke = await smoke(tag, planDir, after, before, false);
  await cmd('/kill @e[type=!minecraft:player]');
  out.nav = await nav(R.meta);
  check(Object.values(out.nav).length >= 1 && Object.values(out.nav).every((v) => v.there && v.back), `item 6 (${tag}): vanilla dev.nav.villager up and down the flight (${json(Object.fromEntries(Object.entries(out.nav).map(([k, v]) => [k, [v.there, v.back]])))})`);
  const rm = await G.remove(ctx, region);
  const d = await G.diff(ctx, box, pre);
  out.exact = { removed: rm.removed, mismatches: d.mismatches, classes: d.classes, list: d.list.slice(0, 20) };
  check(rm.removed && d.mismatches === 0, `item 8 (${tag}): Regions.remove: E-flat ${d.mismatches}`, d.list.slice(0, 8));
  await leaveWorld();
  return out;
}

steps.ingame = async () => {
  await ensure();
  const out = {};
  await L.ensureBase(FLAT);
  await L.fresh('G6B RK Flat', FLAT);
  await L.setRules('exact');
  out.flat = await demoRun('flat', FLAT_CLAIM, { kind: 'flat' });
  await leaveWorld();
  out.ridge = await ridgeRun('ridge');
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 9: survival (RS)

steps.survival = async () => {
  await ensure();
  const out = {};
  const fx = G.fixture(ctx, 'valid/v7a_rk_ridge.json');
  const T = await G.twin(ctx, 'rk', fx);
  const s = await G.site(ctx, 'rk', fx);
  const box = G.boxOf(s.W);
  const pre = await G.snap(ctx, box, 'rk-surv-pre');
  const ck = await G.check(ctx, 'rk', s);
  const a = (ck.check?.parts ?? []).find((q) => q.part === 'flight');
  out.check = { overall: ck.check?.overall, survival: ck.check?.survival, cost: a?.cost ?? null };
  check(ck.check?.survival === true && ck.check?.overall === 'READY' && !!a?.cost?.survival, `item 9: v7a_rk_ridge through Regions.checkPlan in survival: ${ck.check?.overall}, survival ${ck.check?.survival}, cost.survival ${json(a?.cost?.survival && { free: a.cost.survival.free, held: a.cost.survival.held })}`);
  if (!ck.check?.artifactSha) return out;
  out.bills = { survival: a?.cost?.survival?.bom ?? null, bom: a?.cost?.bom ?? null };
  const crateAt = await G.pile(ctx, s, 4);
  const region = await G.realise(ctx, ck.check.artifactSha);
  const f = await G.feed(ctx, region, { fraction: 0.5, timeoutMs: 2_400_000 });
  const st = f.last.st, rs = f.last.rs;
  out.feed = { waves: f.waves, inserted: f.inserted, state: st.view.state, build: rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent } };
  check(st.view.state === 'PLACED' && rs.build?.done && rs.build?.percent === 100, `item 9: realiseApproved in survival and fed in ${f.waves} waves: ${st.view.state}, build ${json(out.feed.build)} (carved flight by flight behind its lining: RS §6.3's one target per tile)`);
  const bills = G.billsOf(ck, rs);
  const differ = Object.keys({ ...bills.want, ...bills.got }).filter((p) => p in bills.want && !G.same(bills.want[p], bills.got[p]));
  out.billsDiffer = differ;
  check(differ.length === 0, `item 9: the check's cost.survival.bom against the targets' bills put down, per part: ${differ.length ? differ.map((p) => `${p} ${json(G.minus(bills.want[p], bills.got[p]))}`).join('; ') : 'equal, item for item (BOM exact)'}`, bills);
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twin = d;
  check(d.mismatches === 0, `item 9: the survival build equals its INSTANT twin cell for cell (the crates aside): ${d.mismatches} differ`, d.list);
  const rm = await G.remove(ctx, region);
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  out.eflat = { removed: rm.removed, mismatches: ef.length, list: ef.slice(0, 8) };
  check(rm.removed && ef.length === 0, `item 9: Regions.remove: E-flat ${ef.length} (the crates aside)`, ef.slice(0, 8));
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the natural site (T3b's pinned hill)

steps.natural = async () => {
  await ensure();
  const site = JSON.parse(fs.readFileSync(SITE_FILE, 'utf8'));
  if (!site.fixture?.claim) { check(false, 'natural: the tunnel hill is not pinned'); return {}; }
  await L.ensureBase(BASE);
  await L.fresh('G6B RK Natural', BASE);
  await L.setRules('exact'); // (T3b's rule: no random ticks, no spawns)
  const out = await demoRun('natural', site.fixture.claim, { kind: 'natural', standMs: 60_000 });
  await leaveWorld();
  // item 3's load: the same flight as a plan/0 rock stair (its foot and top walk cells as anchors) checked on a fresh copy with the bot at
  // spawn, the hill's corridor never generated: load "loaded" answers incomplete VOLUME (INCOMPLETE), load "generate" READY
  const fl = out.flight;
  if (fl) {
    await L.fresh('G6B RK Natural Gen', BASE);
    await L.setRules('exact');
    await tp(0.5, 200, 0.5);
    const c = site.fixture.claim;
    const req = { plan: { schemaVersion: 'plan/0', connectors: [{ id: 'flight', kind: 'rock_stair', from: { anchor: 'rk_foot' }, to: { anchor: 'rk_top' }, movers: ['player', 'villager'] }] }, claim: c, owner: OWNER, anchors: { rk_foot: [fl.from[0], fl.from[1] + 1, fl.from[2]], rk_top: [fl.to[0], fl.to[1] + 1, fl.to[2]] } };
    const g1 = await call('dev.region.checkPlan', { ...req, load: 'loaded' }, 1_800_000);
    const a1 = (g1.check?.parts ?? []).find((q) => q.part === 'flight');
    out.loaded = { overall: g1.check?.overall ?? null, class: a1?.class ?? null, code: a1?.reasons?.[0]?.code ?? null };
    check(out.loaded.overall === 'INCOMPLETE' && out.loaded.code === 'VOLUME', `item 3 (natural): the hill's corridor not generated, load "loaded": ${out.loaded.overall}, flight ${out.loaded.class} ${out.loaded.code}`);
    const g2 = await call('dev.region.checkPlan', { ...req, load: 'generate' }, 1_800_000);
    const a2 = (g2.check?.parts ?? []).find((q) => q.part === 'flight');
    const note = [...(g2.check?.notes ?? []), ...(a2?.notes ?? [])].find((n) => /read \d+ frozen volume/.test(n)) ?? null;
    out.generate = { overall: g2.check?.overall ?? null, class: a2?.class ?? null, note, rockStairs: a2?.geometry?.rockStairs ?? null };
    check(out.generate.overall === 'READY' && a2?.class === 'fits' && !!note, `item 3 (natural): the same check with load "generate" prepares the corridor and reads its volume: ${out.generate.overall}, flight ${a2?.class} ("${note}")`);
    await leaveWorld();
  }
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the look (client; recorded, not judged)

const LOOK_BIBLES = [null, 'g7ak1_infernal', 'g7ak1_coastal'];
function installBible(id) {
  const dst = path.join(L.GAME_DIR, 'architect', 'bibles', id, 'versions', '1');
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(root, 'scenarios', 'bibles', `${id}.json`), path.join(dst, 'bible.json'));
}
async function shot(name, eye, at) {
  await call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator', fov: 70 }, 60_000);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
  await L.settle(1500);
  const r = await call('dev.screenshot', { name: `rk_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
  const dir = path.join(OUT, 'look');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `${name}.png`);
  fs.copyFileSync(r.path, dst);
  return { name, eye, at, file: dst, width: r.width, height: r.height };
}

/** The look's three cameras of one flight: at its foot (looking up the flight), mid-flight (on the treads, looking up) and its top (looking down). */
async function flightShots(tag, which, q) {
  const up = q.rise >= 0;
  const foot = up ? q.from : q.to, top = up ? q.to : q.from;
  const [dx, dz] = up ? q.dir : [-q.dir[0], -q.dir[1]];
  const [rx, rz] = [-dz, dx];
  const mid = Math.floor(q.length / 2), midY = q.ys[up ? mid : q.length + 1 - mid];
  const c = (x, z) => [x + 0.5 + rx * 0.5, z + 0.5 + rz * 0.5];
  const out = [];
  const [fx, fz] = c(foot[0] - dx * 7, foot[2] - dz * 7);
  out.push(await shot(`${tag}_${which}_foot`, [fx + rx * 3, foot[1] + 4, fz + rz * 3], [foot[0] + dx * 6 + 0.5, foot[1] + 4, foot[2] + dz * 6 + 0.5]));
  const [mx, mz] = c(foot[0] + dx * (mid - 2), foot[2] + dz * (mid - 2));
  out.push(await shot(`${tag}_${which}_mid`, [mx, midY + 2.4, mz], [mx + dx * 8, midY + 7, mz + dz * 8]));
  const [ux, uz] = c(top[0] + dx * 4, top[2] + dz * 4);
  out.push(await shot(`${tag}_${which}_top`, [ux + rx * 2, top[1] + 4.5, uz + rz * 2], [top[0] - dx * 8 + 0.5, top[1] - 5, top[2] - dz * 8 + 0.5]));
  return out;
}

steps.look = async () => {
  await ensure();
  const out = { shots: [], bibles: {} };
  for (const b of LOOK_BIBLES) if (b) installBible(b);
  for (const bible of LOOK_BIBLES) {
    const tag = bible ?? 'default';
    await L.ensureBase(FLAT);
    await L.fresh(`G6B RK Look ${tag}`, FLAT);
    await L.setRules('exact');
    await cmd('/time set 13000');
    await cmd('/weather clear');
    await tp((FLAT_CLAIM[0] + FLAT_CLAIM[2]) / 2, 0, (FLAT_CLAIM[1] + FLAT_CLAIM[3]) / 2);
    const p = await L.plan('rockstairs_demo', FLAT_CLAIM, { params: { variant: 'flat' }, surveyLoad: 'bounded:256', check: true, owner: OWNER, ...(bible ? { bible } : {}) });
    const meta = JSON.parse(fs.readFileSync(path.join(sideDir(p.planId), 'meta.json'), 'utf8'));
    const region = await L.realise(p.planId, {});
    const st = await L.waitRegion(region, 3_600_000);
    const fl = meta.rockStairs ?? [];
    check(st.view.state === 'PLACED' && fl.length === 2, `look (${tag}): rockstairs_demo flat realised with its two flights (${st.view.state}; recorded, not judged: Noah's call, N-RK-1)`);
    out.bibles[tag] = { planId: p.planId, state: st.view.state, flights: fl.map((q) => ({ id: q.id, tread: q.tread, landing: q.landingBlock, lining: q.lining, portal: q.portal, light: q.light, from: q.from, to: q.to, bore: q.bore.filter(Boolean).length })) };
    for (const q of fl) out.shots.push(...await flightShots(tag, /carved/.test(q.id) ? 'carved' : 'bored', q));
    if (tag === 'default' && fl[0]) {
      await cmd('/time set 6000');
      const q = fl.find((f) => /ridge/.test(f.id)) ?? fl[0];
      out.shots.push(await shot(`${tag}_day_side`, [q.from[0] + 12.5, q.from[1] + 26, q.from[2] - 26.5], [q.from[0] + 12.5, q.from[1] + 8, q.from[2] + 20.5]));
    }
    await call('dev.release', {}).catch(() => null);
    await tp((FLAT_CLAIM[0] + FLAT_CLAIM[2]) / 2, 300, (FLAT_CLAIM[1] + FLAT_CLAIM[3]) / 2);
    const rm = await call('dev.region.remove', { region, requester: OWNER }, 3_600_000).catch((e) => ({ error: String(e?.message ?? e) }));
    out.bibles[tag].remove = { removed: rm.removed ?? null, error: rm.error ?? null };
    await leaveWorld();
  }
  fs.writeFileSync(path.join(OUT, 'look', 'look.json'), JSON.stringify(out, null, 2));
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'unchanged', 'ingame', 'survival', 'natural', 'look']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7a-RK (rock stairs)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7ark.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${L.fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(L.fails() ? 1 : 0);
