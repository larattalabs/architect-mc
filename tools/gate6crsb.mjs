#!/usr/bin/env node
// Phase 6c slice RS-b gate (docs/HANDOFF-RS.md "The split", RS-b's rows of docs/CONTRACT.md "Phase 6c slice RS" §13) against the headless
// server of RS-b's run worktree (`../architect-mc-RSb-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). $0.
// Its own ports (sidecar 8942, DevBridge 8943), run worktree and output (artifacts/gate6c-rsb in the main checkout), so it never touches
// RS-a's server; it takes a machine slot (<LarattaLabs>/.gate-slots) for its server's life.
//
//   node tools/gate6crsb.mjs <step>
//     start | stop | base          the headless server (waits for a free slot) and the survival flat base
//     unit                         offline: TunnelRingsTest and RegionTargetsTest (the ring order, a carve behind its lining, no late blocker,
//                                  the runs within the cap; carveFirst caught), kit/test/rs-b.test.mjs and rs.test.mjs, the tunnel tests
//     rs04                         item 5's rs04 row (build, twin 0, E-flat 0, bills) with the ring evidence every poll (no bore cell open
//                                  without its lining; ring by ring, not course by course)
//     rs04half                     item 6's rs04 row: half of its bill fed: no run started without its whole bill, no open cut, M3/M4/M8/
//                                  gravity 0 over the world as it stands; (batch v0.41.0) RP's record: the unbuilt targets UNFINISHED,
//                                  then fed to build.done: every target WRITTEN and listed, dev.region.realised verify ok
//     ice                          N-RS-4: rs08's capped pond in a freezing biome built in survival: the cap free (no ice taken), the body
//                                  settled after its shell, equal to its twin, E-flat 0
//     lava                         items 8 and 9 (lava rows): rs03 built with the conservation sum at 10 or more checkpoints (lava charged,
//                                  a bucket back); before removal fewer buckets than sources kept in stock: scooped with a bucket, drained
//                                  without (exact both ways), one credit; E-flat 0
//     rs04crash                    item 11's tunnel row: rs04 half built, an autosave, kill -9 and a cold start: the targets resume from
//                                  the world, the rest fed: built, no bore cell open on the way, equal to its twin, E-flat 0
//     rs03stop                     item 11's body row: rs03 half built (its bodies waiting for their barriers), a clean stop and a
//                                  restart: resumed, PLACED and built, every body settled, the sum exact, twin 0, E-flat 0
//     brush                        item 13's last row: a concrete-pattern stroke refused NOT_ALLOWED, a natural stroke free (0 items)
//     report                       REPORT.md over the step JSONs
//   Item 16's rows (hy-ingame, irr-ingame, h-ingame, ha-ingame, kc-ingame) run through tools/gate-run.mjs (HANDOFF-RSb.md has the line).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-RSb-run');
process.env.GATE6B_OUT = process.env.GATE6CRSB_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-rsb');
process.env.GATE6B_SIDECAR_PORT ??= '8942';
process.env.GATE6B_DEV_PORT ??= '8943';
process.env.GATE6B_CLIENT_SCRIPT ??= 'tools/run-headless-server.mjs';
process.env.HEADLESS_SIDECAR ??= 'sim';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient, sleep } = L;
const core = await import('./lib/gate6chy-core.mjs');
const B = await import('./lib/gate6chy-b.mjs');
const G = await import('./lib/gate6crs-game.mjs');
const R = await import('./lib/gate6crsb-game.mjs');

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };
const sum = (m) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);

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
  if (data?.keep) delete data.keep;
  if (!['stop', 'start', 'release'].includes(name)) L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice RS-b is $0: sim only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ the machine slot (docs/GATES.md "Slot lock"), held by the server's pid

const SLOTS = path.resolve(process.env.GATE_SLOTS_DIR ?? path.resolve(root, '..', '.gate-slots'));
const NSLOTS = Number(process.env.GATE_SLOTS ?? (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'tools', 'gate-chains.json'), 'utf8')).slots?.max; } catch { return null; } })() ?? 3);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readSlot = (i) => { try { return JSON.parse(fs.readFileSync(path.join(SLOTS, `slot-${i}.json`), 'utf8')); } catch { return null; } };
function withMutex(fn) {
  const m = path.join(SLOTS, '.mutex');
  fs.mkdirSync(SLOTS, { recursive: true });
  for (let k = 0; k < 200; k++) { try { fs.mkdirSync(m); break; } catch { spawnSync('sleep', ['0.1']); } }
  try { return fn(); } finally { fs.rmSync(m, { recursive: true, force: true }); }
}
function claimSlot(pid) {
  return withMutex(() => {
    // a slot this worktree already holds (its holder alive): kept across server restarts
    for (let i = 1; i <= Math.max(NSLOTS, 6); i++) {
      const h = readSlot(i);
      if (h?.worktree === root && h.pid && alive(h.pid) && h.holder) return i;
    }
    for (let i = 1; i <= NSLOTS; i++) {
      const h = readSlot(i);
      if (h?.pid && alive(h.pid)) continue;
      fs.writeFileSync(path.join(SLOTS, `slot-${i}.json`), JSON.stringify({ pid, worktree: root, chain: 'rs-b (headless server)', startedAt: new Date().toISOString() }));
      return i;
    }
    return 0;
  });
}

// ------------------------------------------------------------------ the server and the worlds

steps.start = async () => {
  // a slot first, held by this driver's pid while the server boots, then handed to the server's
  let slot = 0;
  for (let k = 0; !(slot = claimSlot(process.pid)); k++) {
    if (k % 40 === 0) log(`waiting for a free gate slot (${Array.from({ length: NSLOTS }, (_, i) => i + 1).map((i) => readSlot(i)?.chain ?? 'free').join(', ')})`);
    await sleep(15_000);
  }
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B RSb Lobby', { backend: 'sim' });
  // (the slot held by a detached holder of this worktree's, so a server restart keeps it; `release` ends it)
  let holder = readSlot(slot);
  if (!(holder?.holder && holder.worktree === root && alive(holder.pid))) {
    const { spawn } = await import('node:child_process');
    const h = spawn(process.execPath, ['-e', "process.title='rsb-slot-holder';setInterval(()=>{},3600000)"], { detached: true, stdio: 'ignore' });
    h.unref();
    withMutex(() => fs.writeFileSync(path.join(SLOTS, `slot-${slot}.json`), JSON.stringify({ pid: h.pid, holder: true, worktree: root, chain: 'rs-b (headless server)', startedAt: new Date().toISOString() })));
    holder = { pid: h.pid };
  }
  const pids = [holder.pid];
  spendZero();
  return { head, slot, pids };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
// the slot's holder ended (its pid is this worktree's own) and the slot freed
steps.release = async () => {
  withMutex(() => { for (let i = 1; i <= Math.max(NSLOTS, 6); i++) { const h = readSlot(i); if (h?.worktree === root) { if (h.holder && alive(h.pid)) process.kill(h.pid); fs.rmSync(path.join(SLOTS, `slot-${i}.json`), { force: true }); } } });
};
steps.base = async () => {
  await ensure();
  await L.ensureBase(G.FLAT);
  await G.survivalBase(ctx);
  spendZero();
  return { worlds: [G.FLAT, G.SURV] };
};

// ------------------------------------------------------------------ offline

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
async function javaTests(patterns, minTests) {
  const { srcGradle } = await import('./lib/src-gradle.mjs');
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const args = ['test', '--offline', '-q', ...patterns.flatMap((p) => ['--tests', p])];
  const g = srcGradle(root, () => spawnSync('./gradlew', args, { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 }));
  const dir = path.join(root, 'mod', 'build', 'test-results', 'test');
  let tests = 0, failures = 0;
  const names = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.xml') || !patterns.some((p) => f.includes(p.replaceAll('*', '')))) continue;
    const x = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = /tests="(\d+)" skipped="\d+" failures="(\d+)" errors="(\d+)"/.exec(x);
    if (m) { tests += +m[1]; failures += +m[2] + +m[3]; names.push(`${f.replace(/^TEST-|\.xml$/g, '')}: ${m[1]}/${+m[2] + +m[3]}`); }
  }
  return { code: g.status, tests, failures, names, tail: `${g.stdout ?? ''}${g.stderr ?? ''}`.split('\n').slice(-12), ok: g.status === 0 && tests >= minTests && failures === 0 };
}

steps.unit = async () => {
  const out = {};
  out.java = await javaTests(['*TunnelRingsTest*', '*RegionTargetsTest*'], 11);
  check(out.java.ok, `item 1 (RS-b, mod): a tunnel's target ring by ring (a carve after every paid cell at its ring and the next, before the lining two rings on), no cell before what blocks it in the builder (a hanging lantern after its roof, the roof never waiting for it), a run per ring within the quarter cap, two bores one after the other, ir.survival.bores read; the broken variant carveFirst caught; RS-a's RegionTargetsTest unchanged: ${out.java.tests} tests, ${out.java.failures} failures (${out.java.names.join('; ')})`, out.java.tail);
  out.kit = nodeTest(['kit/test/rs-b.test.mjs', 'kit/test/rs.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 13, `item 1 (RS-b, kit): rs04 in survival one target per tile (its lining in the carve's stage), ir.survival.bores (group, start, heading, box), creative unchanged (the lining part in routes), no bores without a tunnel; rs08's ice cap free (no ice on the survival bill, the cap's cells free), billed in creative as before; RS-a's rs.test: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  out.tunnels = nodeTest(['kit/test/tunnel-t3b.test.mjs', 'kit/test/plan-t3b.test.mjs']);
  check(out.tunnels.code === 0 && out.tunnels.fail === 0, `item 2 (RS-b): the tunnel tests (T3b) unchanged: ${out.tunnels.pass} pass, ${out.tunnels.fail} fail`, out.tunnels.failing);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ rs04: build (item 5) and half fed (item 6)

steps.rs04 = async () => {
  await ensure();
  const samples = [];
  let bad = [], interleaved = 0, open0 = 0;
  const poll = async (st, rs, { region }) => {
    const c = await R.openCuts(ctx, region);
    if (!c.cells) return;
    const r = R.rings(c.at, 0);
    if (r.interleaved) interleaved++;
    if (c.open) open0++;
    bad = bad.concat(c.bad);
    samples.push({ t: Date.now(), open: c.open, cells: c.cells, bad: c.bad.length, built: rs.build?.percent, ...r });
  };
  const o = await R.buildFx(ctx, G, 'rs04', 'rs04_tunnel', { fraction: 0.2, poll, every: 1500 });
  o.rings = { samples: samples.length, withOpen: open0, interleaved, bad: bad.slice(0, 12) };
  o.samples = samples;
  check(samples.length >= 5 && bad.length === 0, `item 6 (rs04, the whole build, ${samples.length} samples): no bore cell open without its lining (every open cut's paid neighbours above and beside within 1 built, across targets): ${bad.length} breach(es)`, bad.slice(0, 8));
  check(interleaved > 0, `§7.2 (rs04): the bore carved ring by ring behind its lining: in ${interleaved} of ${samples.length} samples a ring's carve stood open while a later ring's lining was not yet built (course by course would build every lining course first)`, samples.filter((s) => s.interleaved).slice(0, 3));
  return o;
};

steps.rs04half = async () => {
  await ensure();
  const fx = G.fixture(ctx, 'rs04_tunnel');
  const s = await G.site(ctx, 'rs04 half', fx);
  const box = G.boxOf(s.W);
  const beforeFile = path.join(OUT, 'rsb-rs04-half-before.arwd.gz');
  await L.call('dev.region.dump', { box, file: beforeFile }, 1_800_000);
  const ck = await G.check(ctx, 'rs04-half', s);
  await G.pile(ctx, s, 4);
  const region = await G.realise(ctx, ck.check.artifactSha);
  await G.waitFor(ctx, region, (st, rs) => (rs.targets ?? []).length > 0, { timeoutMs: 300_000 });
  const half = {};
  for (const [it, n] of Object.entries(ck.check.cost.bom ?? {})) if (Math.floor(n / 2) > 0) half[it] = Math.floor(n / 2);
  const acc = (await L.call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: half, exact: false }, 120_000)).accepted ?? {};
  let last = -1, still = 0, bad = [], samples = 0;
  for (let k = 0; k < 150 && still < 5; k++) {
    await sleep(3000);
    const rs = await G.rsState(ctx, region);
    const c = await R.openCuts(ctx, region);
    bad = bad.concat(c.bad);
    samples++;
    const built = (rs.targets ?? []).reduce((a, t) => a + t.built, 0);
    still = built === last ? still + 1 : 0;
    last = built;
  }
  const runs = await R.runsSafe(ctx, G, region);
  const cuts = await R.openCuts(ctx, region);
  const ring = R.rings(cuts.at, 0);
  const sm = await R.standing(ctx, 'rs04', ck, box, beforeFile);
  const rs = await G.rsState(ctx, region);
  const out = { fed: acc, runs, cuts: { cells: cuts.cells, open: cuts.open, bad: cuts.bad.slice(0, 8), samples, during: bad.slice(0, 8) }, ring, standing: sm, build: rs.build && { percent: rs.build.percent, parts: rs.build.parts.map((p) => [p.part, p.state, p.built, p.cells]) } };
  check(runs.bad.length === 0, `item 6 (rs04, half fed ${sum(acc)} items): no run started without its whole bill (${runs.started} run(s) under way, each with its remaining bill in stock)`, runs);
  check(cuts.bad.length === 0 && bad.length === 0, `item 6 (rs04): no bore cell open without its lining, at the checkpoint and in ${samples} samples on the way: ${cuts.open} open cut(s) of ${cuts.cells} target cells (rings ${ring.firstOpen}..${ring.lastOpen} open, lining unbuilt from ring ${ring.firstUnbuilt})`, [...cuts.bad, ...bad].slice(0, 6));
  check(rs.build && rs.build.percent > 0 && rs.build.percent < 100, `item 6 (rs04): half built (${rs.build?.percent}% of the paid cells)`);
  check(sm.M3 === 0 && (sm.M4 ?? 0) === 0 && (sm.M8 ?? 0) === 0 && sm.gravity === 0, `item 6 (rs04): the world as it stands half built: M3 ${sm.M3} floating, M4 ${sm.M4}, M8 ${sm.M8} unguarded, ${sm.gravity} gravity (tunnel findings ${sm.tunnel}, recorded)`, sm);
  // (batch v0.41.0, RP wiring) the tunnel targets' cells UNFINISHED in the realised record while unbuilt; then the rest fed: every
  // target built, its cells WRITTEN and its site listed, and RP's verify agrees after build.done
  const rpHalf = await G.rpRecord(ctx, region);
  check(...G.rpHalf('rs04', rpHalf, { needOpen: true }), rpHalf);
  const fd = await R.feed(ctx, G, region, { timeoutMs: 2_400_000 });
  const rpDone = await G.rpRecord(ctx, region, { verify: true });
  const [okDone, msgDone] = G.rpDone('rs04', rpDone);
  check(okDone && fd.last.st.view.state === 'PLACED' && fd.last.rs.build?.done, `${msgDone}; the rest fed: ${fd.last.st.view.state}, done ${fd.last.rs.build?.done}`, rpDone);
  out.rp = { half: rpHalf, done: rpDone };
  await G.remove(ctx, region);
  return out;
};

// ------------------------------------------------------------------ rs04 across a crash (item 11's tunnel row)

/** The headless host's pids of this run worktree. */
function hostPids() {
  try { return execFileSync('pgrep', ['-f', `${path.basename(L.RUN)}/tools/run-headless-server.mjs`]).toString().trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; }
}

steps.rs04crash = async () => {
  await ensure();
  const fx = G.fixture(ctx, 'rs04_tunnel');
  const T = await R.twin(ctx, G, 'rs04c', fx);
  const s = await G.site(ctx, 'rs04 crash', fx);
  const box = G.boxOf(s.W);
  const pre = await G.snap(ctx, box, 'rsb-rs04c-pre');
  const ck = await G.check(ctx, 'rs04-crash', s);
  const crateAt = await G.pile(ctx, s, 4);
  const region = await G.realise(ctx, ck.check.artifactSha);
  await G.waitFor(ctx, region, (st, rs) => (rs.targets ?? []).length > 0, { timeoutMs: 300_000 });
  const half = {};
  for (const [it, n] of Object.entries(ck.check.cost.bom ?? {})) if (Math.floor(n / 2) > 0) half[it] = Math.floor(n / 2);
  await L.call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: half, exact: false }, 120_000);
  let last = -1, still = 0;
  for (let k = 0; k < 150 && still < 4; k++) {
    await sleep(3000);
    const rs = await G.rsState(ctx, region);
    const built = (rs.targets ?? []).reduce((a, t) => a + t.built, 0);
    still = built === last ? still + 1 : 0;
    last = built;
  }
  const before = await G.rsState(ctx, region);
  const cutsBefore = await R.openCuts(ctx, region);
  const out = { region, world: s.world, before: { percent: before.build?.percent, built: last, open: cutsBefore.open, bad: cutsBefore.bad.length } };
  // the autosave, then kill -9 (our own server's pid) and a cold start in the same world
  await L.cmd('/save-all flush');
  await L.settle(3000);
  const pids = L.clientPids();
  for (const pid of pids) { log(`kill -9 my server pid ${pid}`); process.kill(pid, 'SIGKILL'); }
  for (let i = 0; i < 60 && L.clientPids().length; i++) await sleep(1000);
  for (let i = 0; i < 30 && hostPids().length; i++) await sleep(1000);
  for (const pid of hostPids()) { log(`stopping my headless host pid ${pid}`); process.kill(pid, 'SIGTERM'); }
  for (let i = 0; i < 30 && hostPids().length; i++) await sleep(1000);
  try { state.dev?.close(); } catch { /* closed */ }
  state.dev = null;
  await startClient(s.world, { backend: 'sim' });
  await ensure();
  await L.settle(5000);
  const after = await G.rsState(ctx, region);
  out.resumed = { percent: after.build?.percent, built: (after.targets ?? []).reduce((a, t) => a + t.built, 0), targets: (after.targets ?? []).length };
  check(out.resumed.targets === (before.targets ?? []).length && out.resumed.built === last, `item 11 (rs04): kill -9 after an autosave, a cold start: the tunnel's targets resume from the world (${out.resumed.targets} target(s), ${out.resumed.built} cell(s) built as before the kill: ${last}; ${out.resumed.percent}%)`, out);
  let bad = [], samples = 0, interleaved = 0;
  const f = await R.feed(ctx, G, region, { fraction: 0.5, every: 1500, poll: async () => { const c = await R.openCuts(ctx, region); bad = bad.concat(c.bad); samples++; if (R.rings(c.at, 0).interleaved) interleaved++; } });
  const rs = f.last.rs;
  out.after = { state: f.last.st.view.state, build: rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent }, samples, bad: bad.slice(0, 8), interleaved };
  check(f.last.st.view.state === 'PLACED' && rs.build?.done && bad.length === 0, `item 11 (rs04): fed the rest after the restart: ${f.last.st.view.state}, done ${rs.build?.done}; still no bore cell open without its lining (${samples} samples, ${bad.length} breach(es))`, bad.slice(0, 6));
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twin = d.mismatches;
  check(d.mismatches === 0, `item 11 (rs04): resumed and built, equal to its INSTANT twin cell for cell: ${d.mismatches} differ`, d.list);
  await G.remove(ctx, region);
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  out.eflat = ef.length;
  check(ef.length === 0, `item 11 (rs04): removed after the crash: E-flat ${ef.length}`, ef.slice(0, 8));
  return out;
};

// ------------------------------------------------------------------ rs03: a clean stop while the bodies wait (item 11's body row)

steps.rs03stop = async () => {
  await ensure();
  const fx = G.fixture(ctx, 'rs03_water');
  const entries = R.entriesOf(fx);
  const T = await R.twin(ctx, G, 'rs03s', fx, entries);
  const s = await G.site(ctx, 'rs03 stop', fx);
  await G.designs(ctx);
  const box = G.boxOf(s.W);
  const pre = await G.snap(ctx, box, 'rsb-rs03s-pre');
  const ck = await G.check(ctx, 'rs03-stop', s);
  const crateAt = await G.pile(ctx, s, 4);
  const C = new G.Conservation(ctx, box);
  await C.start();
  const region = await G.realise(ctx, ck.check.artifactSha, entries);
  // fed in waves until about half the paid cells stand: the fluids stage then waits for its barriers (every target BUILT)
  // (the targets put down first: a region with none yet reads 100% of nothing)
  await G.waitFor(ctx, region, (st, rs) => (rs.targets ?? []).length > 0 && (rs.build?.percent ?? 100) < 100, { timeoutMs: 600_000 });
  // (until about half the whole bill stands as paid cells, read from the audit: the build's percent counts what is put down so far)
  const whole = sum(ck.check.cost.bom ?? {});
  let half = false;
  const f1 = await R.feed(ctx, G, region, { cons: C, fraction: 0.25, poll: async (st, rs) => { const a = await C.parts(); half = sum(a.paidStanding) >= whole / 2 && !rs.build?.done; }, until: () => half });
  const st0 = f1.last.st, rs0 = f1.last.rs;
  const bodies0 = R.bodiesOf(st0);
  const out = { region, world: s.world, before: { state: st0.view.state, waiting: st0.view.waiting ?? null, percent: rs0.build?.percent, bodies: bodies0 } };
  const p0 = await C.point('before the stop');
  out.before.fed = sum(C.injected);
  out.before.paid = p0.paid;
  check(st0.view.state === 'PLACING' && !rs0.build?.done && f1.waves > 0 && p0.paid >= whole / 2 && !bodies0.some((b) => b.state === 'settled'), `item 11 (rs03): mid-build, the fluids stage waiting for its barriers (no body written: every target must be BUILT first): ${st0.view.state}, ${p0.paid} of the bill's ${whole} item(s) standing as paid cells (the build reads ${rs0.build?.percent}%), ${f1.waves} wave(s) fed (${sum(C.injected)} items), waiting ${json(st0.view.waiting ?? null).slice(0, 200)}, bodies ${json(bodies0).slice(0, 300)}`);
  // the clean stop (the server saves and quits), then the same world again
  await stopClient();
  await startClient(s.world, { backend: 'sim' });
  await ensure();
  // (the targets rescan their cells as their chunks load: wait, feeding nothing, until the build reads as before or a minute passes)
  let rs1 = null;
  for (let k = 0; k < 30; k++) {
    await L.settle(2000);
    rs1 = await G.rsState(ctx, region);
    if (sum((await C.parts()).paidStanding) === p0.paid) break;
  }
  const p1 = await C.point('after the restart');
  out.resumed = { percent: rs1.build?.percent, targets: (rs1.targets ?? []).length };
  check(G.exact(p0) && G.exact(p1) && p1.paid === p0.paid && p1.stock === p0.stock, `item 11 (rs03): a clean stop and a restart: the build resumes where it stood (${rs0.build?.percent}% -> ${rs1.build?.percent}%; paid standing ${p0.paid} -> ${p1.paid}, stock ${p0.stock} -> ${p1.stock}), the per-item sum exact before and after (${json(p0.diff)}, ${json(p1.diff)})`);
  const f2 = await R.feed(ctx, G, region, { cons: C, fraction: 0.5 });
  const st = f2.last.st, rs = f2.last.rs;
  out.after = { state: st.view.state, build: rs.build && { done: rs.build.done, percent: rs.build.percent }, bodies: R.bodiesOf(st) };
  check(st.view.state === 'PLACED' && rs.build?.done && out.after.bodies.length > 0 && out.after.bodies.every((b) => b.state === 'settled'), `item 11 (rs03): resumed to PLACED and built, every body settled after its barrier (${json(out.after.bodies).slice(0, 300)})`);
  const p2 = await C.point('built');
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twin = d.mismatches;
  check(d.mismatches === 0 && G.exact(p2), `item 11 (rs03): equal to its INSTANT twin (${d.mismatches} differ), the sum exact (${json(p2.diff)})`, d.list);
  await G.remove(ctx, region);
  const p3 = await C.point('removed');
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  out.eflat = ef.length;
  out.conservation = C.points;
  check(ef.length === 0 && G.exact(p3), `item 11 (rs03): removed: E-flat ${ef.length}, the sum exact (every bucket scooped back: ${json(p3.diff)})`, ef.slice(0, 8));
  return out;
};

// ------------------------------------------------------------------ ice caps (N-RS-4)

steps.ice = async () => {
  await ensure();
  const o = await R.buildFx(ctx, G, 'rs08', 'rs08_ice', { fraction: 1, beforeRemove: async (k) => {
    const ps = await G.pileState(ctx);
    const ckp = k.ck.check.parts.find((a) => a.part === 'pond');
    const meta = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', k.ck.check.checkId, 'meta.json'), 'utf8'));
    const cap = (meta.waters ?? []).reduce((a, w) => a + (w.ice ?? 0), 0);
    // the ice standing now against the box before the realise (a dump each)
    const { decodeArwd } = await imp('lib/region/vworld.mjs');
    const nowFile = path.join(OUT, 'rsb-rs08-built.arwd.gz');
    await L.call('dev.region.dump', { box: k.box, file: nowFile }, 1_800_000);
    const count = (d) => { const ice = d.palette.findIndex((x) => x.replace(/\[.*$/, '') === 'minecraft:ice'); let n = 0; if (ice >= 0) for (const c of d.cells) if (c === ice) n++; return n; };
    const iceNow = count(await decodeArwd(fs.readFileSync(nowFile))) - count(await decodeArwd(fs.readFileSync(k.beforeFile)));
    return { cap, iceNow, bom: ckp?.cost?.survival?.bom, consumed: ps.consumed ?? {}, stock: ps.stock ?? {} };
  } });
  const br = o.beforeRemove ?? {};
  check(br.cap > 0 && br.iceNow === br.cap, `N-RS-4 (rs08, a freezing biome by /fillbiome ${json(o.biome?.biome)}): the pond capped with ice in survival (${br.cap} cap cell(s) planned, ${br.iceNow} more ice in the box than before the realise)`, br);
  const fed = o.feed?.inserted ?? {};
  check(!(br.bom ?? {})['minecraft:ice'] && !fed['minecraft:ice'] && !fed['minecraft:water_bucket'] && G.same(fed, br.bom) && sum(br.stock) === 0, `N-RS-4 (rs08): the cap is free: no ice on the pond's survival bill (${json(br.bom)}); the stockpile was fed exactly that bill (${json(fed)}: no ice, no water) and holds nothing after the build (${json(br.stock)}): the shell alone paid`);
  return o;
};

// ------------------------------------------------------------------ lava: items 8 and 9 (lava rows)

/** Regions.remove with the conservation sum sampled while it runs. */
async function removeWithPoints(region, C, n = 4) {
  const r = await L.call('dev.region.remove', { region, requester: G.OWNER }, 3_600_000);
  let k = 0;
  for (let i = 0; i < 1800; i++) {
    const st = await L.call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || ['REMOVED', 'PARTIAL', 'FAILED'].includes(s)) break;
    if (k < n && i % 2 === 0) { await C.point(`removing (${s})`); k++; }
    await L.sleep(1000);
  }
  await L.settle(2000);
  return r;
}

steps.lava = async () => {
  await ensure();
  let lastBodies = '';
  let charged = null;
  const poll = async (st, rs, { C }) => {
    const b = json(R.bodiesOf(st));
    if (b !== lastBodies) {
      lastBodies = b;
      const p = await C.point(`bodies ${b.slice(0, 120)}`);
      if (!charged && p.fluid && p.fluid['minecraft:lava_bucket'] > 0) charged = p;
    }
  };
  const o = await R.buildFx(ctx, G, 'rs03', 'rs03_water', { fraction: 0.5, cons: true, poll, remove: false });
  const k = o.keep;
  const C = k.C;
  const a0 = await C.parts();
  const S = a0.fluidStanding?.['minecraft:lava_bucket'] ?? 0;
  const bucketsBefore = a0.stock?.['minecraft:bucket'] ?? 0;
  await C.point('built, before the withdrawal');
  // fewer buckets than sources in stock: keep b = floor(S / 2) (at least 1), the rest into the player's inventory (counted in the sum)
  const keepB = Math.max(1, Math.floor(S / 2));
  const take = Math.max(0, bucketsBefore - keepB);
  if (take) await L.call('dev.stockpile.withdraw', { owner: G.OWNER, items: { 'minecraft:bucket': take } }, 120_000);
  const pw = await C.point('buckets withdrawn');
  const a1 = await C.parts();
  const b = a1.stock?.['minecraft:bucket'] ?? 0;
  const lavaBefore = a1.stock?.['minecraft:lava_bucket'] ?? 0;
  const keyState0 = await L.call('dev.stockpile.state', { owner: G.OWNER }, 60_000);
  const rm = await removeWithPoints(k.region, C);
  const pr = await C.point('removed');
  const a2 = await C.parts();
  const scooped = (a2.stock?.['minecraft:lava_bucket'] ?? 0) - lavaBefore;
  const bucketsUsed = b - (a2.stock?.['minecraft:bucket'] ?? 0);
  const drained = S - Math.min(S, b);
  const e = await G.diff(ctx, k.box, k.pre);
  const ef = e.list.filter((m) => !k.crateAt.some((c) => c.join(',') === m.pos));
  // a second removal call credits nothing again (one credit per key)
  const again = await L.call('dev.region.remove', { region: k.region, requester: G.OWNER }, 600_000).catch((x) => ({ error: String(x.message ?? x) }));
  await L.settle(2000);
  const a3 = await C.parts();
  const points = C.points;
  const before = points.filter((p) => p !== pr);
  const exactBefore = before.filter((p) => G.exact(p));
  const out = { ...o, lava: { sources: S, charged: charged && { label: charged.label, fluid: charged.fluid }, bucketsBefore, kept: b, withdrawn: take, scooped, bucketsUsed, drained, removedDiff: pr.diff, again: again?.error ?? again?.refused ?? 'ok', after2: { lava: a3.stock?.['minecraft:lava_bucket'] ?? 0, bucket: a3.stock?.['minecraft:bucket'] ?? 0 } }, eflat: { mismatches: ef.length, list: ef.slice(0, 8) }, removed: { removed: rm.removed, refund: rm.refund }, conservation: points, keyState0: keyState0?.stockpile?.credited ?? null };
  check(S >= 2, `item 9 (rs03): the lava pit stands with ${S} lava source(s) charged (fluidStanding ${json(a0.fluidStanding)})`);
  check(!!charged, `item 8 (rs03): lava charged when the body was written (a lava bucket per source taken, a bucket back): ${json(charged && { label: charged.label, fluid: charged.fluid })}`);
  check(points.length >= 10 && exactBefore.length === before.length, `item 8 (rs03): Y1's per-item sum constant at ${before.length} checkpoints through the feed, the build, the bodies (lava charged, a bucket back), the withdrawal and the removal under way (${points.length} with the end); off: ${json(before.filter((p) => !G.exact(p)).map((p) => [p.label, p.diff]))}`, points.map((p) => [p.label, p.diff, p.fluid]));
  check(b < S && b >= 1 && scooped === Math.min(S, b) && bucketsUsed === scooped, `item 9 (rs03, lava): ${b} bucket(s) kept for ${S} source(s): ${scooped} scooped with a bucket each (a bucket from stock became a lava bucket: ${bucketsUsed} bucket(s) used), ${drained} drained without (nothing credited, never a bucket minted)`);
  const want = drained ? { 'minecraft:lava_bucket': -drained, 'minecraft:bucket': drained } : {};
  check(G.same(pr.diff, want) && pr.identity, `items 8 and 9 (rs03): after the removal the sum differs by exactly the drained sources (each a lava bucket gone, its bucket kept): ${json(pr.diff)} = ${json(want)}`);
  check((a3.stock?.['minecraft:lava_bucket'] ?? 0) === (a2.stock?.['minecraft:lava_bucket'] ?? 0) && (a3.stock?.['minecraft:bucket'] ?? 0) === (a2.stock?.['minecraft:bucket'] ?? 0), `item 9 (rs03): one credit per key: a second Regions.remove credits nothing (${json(out.lava.after2)})`);
  check(rm.removed && ef.length === 0, `item 9 (rs03): Regions.remove: E-flat ${ef.length} (the crates aside)`, ef.slice(0, 8));
  return out;
};

// ------------------------------------------------------------------ brushes in survival (item 13's last row)

steps.brush = async () => {
  await ensure();
  const fx = G.fixture(ctx, 'rs01_land');
  const s = await G.site(ctx, 'brush', fx);
  await G.pile(ctx, s, 2);
  const [x0, z0] = [s.W.claim[0] + 40, s.W.claim[1] + 40];
  const gy = s.W.off + (s.T?.y ?? 64);
  const box = [x0 - 12, gy - 10, z0 - 12, x0 + 12, gy + 16, z0 + 12];
  const pre = await G.snap(ctx, box, 'rsb-brush-pre');
  // (stone, dirt and gravel in stock: a natural stroke takes none of them)
  const offered = await L.call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: { 'minecraft:stone': 64, 'minecraft:dirt': 64, 'minecraft:gravel': 64 }, exact: false }, 120_000).catch((e) => ({ error: String(e.message ?? e) }));
  const ps0 = await G.pileState(ctx);
  const brush = (o) => L.call('dev.brush', { owner: G.OWNER, ...o }, 600_000);
  const concrete = await brush({ kind: 'overlay', shape: 'cylinder', at: [x0, gy, z0], radius: 3, strength: 1, pattern: { mix: [{ w: 1, mat: 'minecraft:white_concrete' }] } });
  const players = await brush({ kind: 'raise', shape: 'cylinder', at: [x0, gy, z0], radius: 3, strength: 2, destruction: 'player_blocks' });
  const nat = await brush({ kind: 'raise', shape: 'cylinder', at: [x0, gy, z0], radius: 3, strength: 2 });
  await L.settle(3000);
  const ps1 = await G.pileState(ctx);
  const d = await G.diff(ctx, box, pre);
  const items = await L.call('dev.items.near', { pos: [x0, gy, z0], radius: 16 }, 60_000).catch(() => null);
  const out = { concrete, players, natural: nat, written: d.mismatches, stock: [ps0.stock, ps1.stock], items };
  check(concrete?.refused && /NOT_ALLOWED/.test(String(concrete.reason ?? concrete.refused?.reason ?? JSON.stringify(concrete.refused))), `item 13 (brush): a concrete-pattern stroke in survival refused NOT_ALLOWED (${json(concrete?.refused ?? concrete?.reason ?? concrete).slice(0, 300)})`);
  check(players?.refused && /NOT_ALLOWED/.test(String(players.reason ?? json(players.refused))), `item 13 (brush): a PLAYER_BLOCKS stroke refused NOT_ALLOWED (${json(players?.refused ?? players?.reason ?? players).slice(0, 200)})`);
  check(!nat?.refused && nat?.region && (nat.cellsWritten ?? 0) > 0 && d.mismatches > 0 && G.same(ps1.stock, ps0.stock) && sum(ps1.outstanding) === 0, `item 13 (brush): a natural stroke realised free: ${nat?.cellsWritten} cell(s) written, ${d.mismatches} changed in the world, the stockpile's stock unchanged (${json(ps0.stock)} -> ${json(ps1.stock)}; offered ${json(offered?.accepted ?? offered)}) and nothing outstanding (${json(ps1.outstanding)})`, nat);
  if (nat?.region) {
    await G.remove(ctx, nat.region);
    const e = await G.diff(ctx, box, pre);
    out.eflat = e.mismatches;
    check(e.mismatches === 0, `item 13 (brush): the natural stroke removed: E-flat ${e.mismatches}`, e.list.slice(0, 6));
  }
  return out;
};

// ------------------------------------------------------------------ dispatch

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => /^(unit|rs04|rs04half|rs04crash|rs03stop|ice|lava|brush)\.json$/.test(f)).sort();
  const lines = ['# Slice RS-b gate report', '', `${new Date().toISOString()} · head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
  let fail = 0;
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    lines.push(`## ${j.step} (${Math.round(j.seconds)} s, head ${String(j.head).slice(0, 8)})`, '');
    for (const [k, v] of Object.entries(j.results ?? {})) {
      const ok = v?.ok === true;
      if (!ok) fail++;
      lines.push(`- ${ok ? 'ok' : 'FAIL'} ${k}`);
    }
    lines.push('');
  }
  lines.push(`${fail} failure(s); $0.00`);
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
  return { files, fail };
};

const groups = { ingame: ['rs04', 'rs04half', 'ice', 'lava', 'brush'], crash: ['rs04crash', 'rs03stop'] };
const name = process.argv[2];
if (!name || (!steps[name] && !groups[name])) {
  console.error(`usage: node tools/gate6crsb.mjs ${[...Object.keys(steps), ...Object.keys(groups)].join('|')}`);
  process.exit(2);
}
for (const s of groups[name] ?? [name]) {
  if (!steps[s]) { check(false, `step ${s} is not built`); continue; }
  await run(s);
}
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
