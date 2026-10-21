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
//                                  gravity 0 over the world as it stands
//     ice                          N-RS-4: rs08's capped pond in a freezing biome built in survival: the cap free (no ice taken), the body
//                                  settled after its shell, equal to its twin, E-flat 0
//     lava                         items 8 and 9 (lava rows): rs03 built with the conservation sum at 10 or more checkpoints (lava charged,
//                                  a bucket back); before removal fewer buckets than sources kept in stock: scooped with a bucket, drained
//                                  without (exact both ways), one credit; E-flat 0
//     brush                        item 13's last row: a concrete-pattern stroke refused NOT_ALLOWED, a natural stroke free (0 items)
//     report                       REPORT.md over the step JSONs
//   Item 16's rows (hy-ingame, irr-ingame, h-ingame, ha-ingame, kc-ingame) run through tools/gate-run.mjs (HANDOFF-RSb.md has the line).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  if (!['stop', 'start'].includes(name)) L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice RS-b is $0: sim only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ the machine slot (docs/GATES.md "Slot lock"), held by the server's pid

const SLOTS = path.resolve(root, '..', '.gate-slots');
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
    for (let i = 1; i <= 3; i++) {
      const h = readSlot(i);
      if (h?.pid && alive(h.pid)) continue;
      fs.writeFileSync(path.join(SLOTS, `slot-${i}.json`), JSON.stringify({ pid, worktree: root, chain: 'rs-b (headless server)', startedAt: new Date().toISOString() }));
      return i;
    }
    return 0;
  });
}
function releaseSlots() {
  withMutex(() => { for (let i = 1; i <= 3; i++) { const h = readSlot(i); if (h && (h.worktree === root && (!h.pid || !alive(h.pid) || h.pid === process.pid))) fs.rmSync(path.join(SLOTS, `slot-${i}.json`), { force: true }); } });
}

// ------------------------------------------------------------------ the server and the worlds

steps.start = async () => {
  // a slot first, held by this driver's pid while the server boots, then handed to the server's
  let slot = 0;
  for (let k = 0; !(slot = claimSlot(process.pid)); k++) {
    if (k % 40 === 0) log(`waiting for a free gate slot (${[1, 2, 3].map((i) => readSlot(i)?.chain ?? 'free').join(', ')})`);
    await sleep(15_000);
  }
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B RSb Lobby', { backend: 'sim' });
  const pids = L.clientPids();
  if (pids.length) withMutex(() => fs.writeFileSync(path.join(SLOTS, `slot-${slot}.json`), JSON.stringify({ pid: pids[0], worktree: root, chain: 'rs-b (headless server)', startedAt: new Date().toISOString() })));
  spendZero();
  return { head, slot, pids };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
  releaseSlots();
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
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout });
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
  await G.remove(ctx, region);
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
  check(!(br.bom ?? {})['minecraft:ice'] && !(br.consumed ?? {})['minecraft:ice'] && !(br.consumed ?? {})['minecraft:water_bucket'], `N-RS-4 (rs08): the cap is free: no ice on the pond's survival bill (${json(br.bom)}), none taken from the stockpile (consumed ${json(br.consumed)}): the shell alone paid`);
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
  const ps0 = await G.pileState(ctx);
  const brush = (o) => L.call('dev.brush', { owner: G.OWNER, ...o }, 600_000);
  const concrete = await brush({ kind: 'overlay', shape: 'cylinder', at: [x0, gy, z0], radius: 3, strength: 1, pattern: { mix: [{ w: 1, mat: 'minecraft:white_concrete' }] } });
  const players = await brush({ kind: 'raise', shape: 'cylinder', at: [x0, gy, z0], radius: 3, strength: 2, destruction: 'player_blocks' });
  const nat = await brush({ kind: 'raise', shape: 'cylinder', at: [x0, gy, z0], radius: 3, strength: 2 });
  await L.settle(3000);
  const ps1 = await G.pileState(ctx);
  const d = await G.diff(ctx, box, pre);
  const items = await L.call('dev.items.near', { pos: [x0, gy, z0], radius: 16 }, 60_000).catch(() => null);
  const out = { concrete, players, natural: nat, written: d.mismatches, consumed: ps1.consumed ?? {}, items };
  check(concrete?.refused && /NOT_ALLOWED/.test(String(concrete.reason ?? concrete.refused?.reason ?? JSON.stringify(concrete.refused))), `item 13 (brush): a concrete-pattern stroke in survival refused NOT_ALLOWED (${json(concrete?.refused ?? concrete?.reason ?? concrete).slice(0, 300)})`);
  check(players?.refused && /NOT_ALLOWED/.test(String(players.reason ?? json(players.refused))), `item 13 (brush): a PLAYER_BLOCKS stroke refused NOT_ALLOWED (${json(players?.refused ?? players?.reason ?? players).slice(0, 200)})`);
  check(!nat?.refused && nat?.region && (nat.cellsWritten ?? 0) > 0 && d.mismatches > 0 && sum(ps1.consumed) === sum(ps0.consumed), `item 13 (brush): a natural stroke realised free: ${nat?.cellsWritten} cell(s) written, ${d.mismatches} changed in the world, ${sum(ps1.consumed) - sum(ps0.consumed)} item(s) taken from the stockpile`, nat);
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
  const files = fs.readdirSync(OUT).filter((f) => /^(unit|rs04|rs04half|ice|lava|brush)\.json$/.test(f)).sort();
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

const groups = { ingame: ['rs04', 'rs04half', 'ice', 'lava', 'brush'] };
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
