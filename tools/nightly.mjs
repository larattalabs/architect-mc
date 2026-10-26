#!/usr/bin/env node
// The nightly full gate run (docs/GATES.md "Affected-only releases"): fetch origin, move the nightly's own worktree to a detached
// origin/main, run `release --full --no-cache --nightly` there (every candidate, every rotation option, and the judged benches with
// their timing judged, isolated: a release reuses those PASSes, docs/GATES.md "Benches out of the release path"; each PASS
// recorded in the step cache), and write a summary for the coordinator to artifacts/nightly/<date>/. No notification of any kind.
//
//   node tools/nightly.mjs              what the LaunchAgent runs at about 02:00 (tools/nightly-install.mjs)
//   node tools/nightly.mjs --megab-full the full megaB walk tonight (on demand; else weekly, release.benches.megaB.weeklyDay)
//   node tools/nightly.mjs --plan       the plan only (gate-run --plan), nothing run, nothing written but the log line
//   node tools/nightly.mjs --misses <nightly run dir> [--release <release run dir>]
//                                       recompute the impact-map misses of a finished nightly run (writes nothing; prints JSON)
//
// It never kills anything, never queues behind or ahead of another run, and never touches another checkout's tree:
//   - one nightly at a time: artifacts/nightly/nightly.lock (pid); a live holder -> exit 0 at once ("already active");
//   - any gate run active or queued (a live slot holder or queue ticket in the slot dir): the night is skipped, exit 0 at once
//     (nightly.idleWaitMin > 0 waits that long for an idle machine first, without taking a queue ticket);
//   - after the run, the UI gallery (nightly-only, non-blocking: docs/GATES.md "UI gallery") shoots the screens into <date>/ui/;
//   - otherwise the gate run (turbo: the machine idle at night, it holds every slot until it ends) runs in its own run dirs;
//   - the main checkout is only fetched (git fetch), never checked out or pulled; the nightly worktree (gate-cache.json
//     nightly.worktree) is moved only when clean, else the night is skipped.
// An impact-map miss: a step the last release skipped as CACHED fails (FAIL or TIMEOUT) at the same key here. It is written to
// artifacts/nightly/<date>/impact-map-misses.json with a ready line for docs/GATES.md's misses log (the coordinator commits it:
// the nightly never writes to a tree).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(HERE, '..', 'architect-mc');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const NIGHTLY = path.join(MAIN, 'artifacts', 'nightly');
const conf = JSON.parse(fs.readFileSync(path.join(HERE, 'tools', 'gate-cache.json'), 'utf8')).nightly ?? {};
const WT = path.resolve(MAIN, conf.worktree ?? '../architect-mc-nightly');
const RUN_DIR = path.resolve(MAIN, conf.runDir ?? '../architect-mc-nightrun');
const OUT = path.resolve(MAIN, conf.out ?? 'artifacts/gate-runs-nightly');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const stamp = () => new Date().toISOString();
fs.mkdirSync(NIGHTLY, { recursive: true });
const LOGF = path.join(NIGHTLY, 'nightly.log');
const log = (m) => {
  const line = `[${stamp()}] ${m}`;
  console.log(line);
  fs.appendFileSync(LOGF, `${line}\n`);
};
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------ the impact-map misses

/** The newest finished release run (not a nightly) that skipped steps as CACHED, before `before`. */
function lastCachedRelease(before) {
  const art = path.join(MAIN, 'artifacts');
  let best = null;
  for (const d of fs.readdirSync(art).filter((x) => /^gate-runs/.test(x) && path.join(art, x) !== OUT)) {
    let runs = [];
    try {
      runs = fs.readdirSync(path.join(art, d)).filter((x) => /-release$/.test(x));
    } catch {
      continue;
    }
    for (const r of runs) {
      const sm = readJson(path.join(art, d, r, 'summary.json'));
      if (!sm || sm.state !== 'done' || !sm.cached?.length || !(sm.startedAt < before)) continue;
      if (!best || sm.startedAt > best.sm.startedAt) best = { dir: path.join(art, d, r), sm };
    }
  }
  return best;
}

/** -> { release, misses: [...], explained: [...] } for a nightly run's summary. */
function impactMisses(nightlyRun, releaseRun) {
  const ns = readJson(path.join(nightlyRun, 'summary.json'));
  if (!ns) throw new Error(`no summary.json in ${nightlyRun}`);
  const rel = releaseRun ? { dir: releaseRun, sm: readJson(path.join(releaseRun, 'summary.json')) } : lastCachedRelease(ns.startedAt);
  const out = { nightly: { run: nightlyRun, head: ns.head, startedAt: ns.startedAt }, release: rel ? { run: rel.dir, head: rel.sm.head, startedAt: rel.sm.startedAt } : null, misses: [], explained: [] };
  if (!rel) return out;
  const byId = new Map(ns.steps.map((s) => [s.id, s]));
  for (const c of rel.sm.cached) {
    const s = byId.get(c.id);
    if (!s || !['FAIL', 'TIMEOUT'].includes(s.status)) continue;
    let changed = [];
    try {
      changed = git(MAIN, 'diff', '--name-only', `${c.head}`, `${ns.head}`).split('\n').filter(Boolean);
    } catch {
      changed = ['(unknown: a head is missing here)'];
    }
    const rec = {
      step: c.id, nightlyStatus: s.status, failLines: s.failLines ?? s.tail ?? [], nightlyLog: s.log ? path.join(nightlyRun, s.log) : null,
      cachedKey: c.key, nightlyKey: s.cache?.key ?? null, cachedFrom: { run: c.run, head: c.head, at: c.at, log: c.log },
      changedSincePass: changed.slice(0, 200), changedCount: changed.length,
    };
    // the same key: nothing in the step's input set moved since the PASS that served the release, yet it fails now. Either the map
    // misses an input (a bug in tools/step-inputs.json) or the step is flaky; a different key means the inputs moved (expected)
    if (rec.nightlyKey && rec.nightlyKey === c.key) out.misses.push(rec);
    else out.explained.push({ ...rec, why: rec.nightlyKey ? 'its inputs changed since the cached PASS (another key): not a map miss' : 'the nightly recorded no key for it' });
  }
  return out;
}

if (flag('--misses')) {
  console.log(JSON.stringify(impactMisses(path.resolve(opt('--misses')), opt('--release') ? path.resolve(opt('--release')) : null), null, 1));
  process.exit(0);
}

// ------------------------------------------------------------------ one nightly at a time

const LOCK = path.join(NIGHTLY, 'nightly.lock');
function takeLock() {
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: stamp() }), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = readJson(LOCK);
      if (held?.pid && alive(held.pid)) return held;
      fs.rmSync(LOCK, { force: true }); // stale: its pid is gone
    }
  }
  return false;
}
const got = takeLock();
if (got !== true) {
  log(`nightly: already active (pid ${got?.pid}, since ${got?.startedAt}); this one exits`);
  process.exit(0);
}
const releaseLock = () => {
  try {
    if (readJson(LOCK)?.pid === process.pid) fs.rmSync(LOCK, { force: true });
  } catch {
    // gone
  }
};
process.on('exit', releaseLock);

// any gate run active or waiting: skip the night (a turbo nightly would hold the machine; queued behind a run it would start late)
const SLOT_DIR = path.resolve(process.env.GATE_SLOTS_DIR ?? path.join(MAIN, '..', '.gate-slots'));
async function activeRuns() {
  try {
    const t = await import(path.join(HERE, 'tools', 'lib', 'turbo.mjs'));
    return [...t.liveHolders(SLOT_DIR), ...t.liveTickets(SLOT_DIR, { prune: false })].filter((h) => h.pid !== process.pid).map((h) => t.describeRun(h));
  } catch {
    // no turbo module (an older checkout): the slot files alone
    let names = [];
    try {
      names = fs.readdirSync(SLOT_DIR).filter((f) => /^slot-\d+\.json$/.test(f));
    } catch {
      return [];
    }
    return [...new Set(names.map((f) => readJson(path.join(SLOT_DIR, f))).filter((h) => h?.pid && alive(h.pid)).map((h) => `pid ${h.pid} ${h.chain ?? '?'} ${h.worktree ?? ''}`))];
  }
}
// wait for an idle machine without taking a place in the queue (nightly.idleWaitMin, polled every 5 min), then skip the night
let busy = flag('--plan') ? [] : [...new Set(await activeRuns())];
const idleUntil = Date.now() + Number(opt('--idle-wait-min') ?? conf.idleWaitMin ?? 0) * 60_000;
if (busy.length && idleUntil > Date.now()) log(`nightly: a gate run is active or queued (${busy.join('; ')}); waiting for an idle machine until ${new Date(idleUntil).toISOString()} (no queue ticket taken)`);
while (busy.length && Date.now() < idleUntil) {
  await new Promise((r) => setTimeout(r, Math.min(300_000, Math.max(1000, idleUntil - Date.now()))));
  busy = [...new Set(await activeRuns())];
}
if (busy.length) {
  log(`nightly: skipped, a gate run is still active or queued (${busy.join('; ')}); nothing started`);
  fs.mkdirSync(path.join(NIGHTLY, new Date().toISOString().slice(0, 10)), { recursive: true });
  fs.writeFileSync(path.join(NIGHTLY, new Date().toISOString().slice(0, 10), 'summary.json'), `${JSON.stringify({ date: new Date().toISOString().slice(0, 10), state: 'skipped', why: 'a gate run is active or queued', active: busy, at: stamp() }, null, 1)}\n`);
  process.exit(0);
}

const date = new Date().toISOString().slice(0, 10);
const DAY = path.join(NIGHTLY, date);
fs.mkdirSync(DAY, { recursive: true });
const summary = { date, state: 'starting', startedAt: stamp(), worktree: WT, head: null, run: null, verdict: null };
const writeDay = () => fs.writeFileSync(path.join(DAY, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
writeDay();

// ------------------------------------------------------------------ the worktree at origin/main

let wtConf = conf; // origin/main's own nightly settings, once its worktree is there

try {
  git(MAIN, 'fetch', '--quiet', 'origin');
  if (!fs.existsSync(WT)) {
    log(`nightly: git worktree add --detach ${WT} origin/main`);
    git(MAIN, 'worktree', 'add', '--detach', WT, 'origin/main');
  } else {
    if (git(WT, 'status', '--porcelain', '--untracked-files=all')) throw new Error(`${WT} has local changes: not moving it (the night is skipped)`);
    git(WT, 'checkout', '-q', '--detach', 'origin/main');
  }
  wtConf = readJson(path.join(WT, 'tools', 'gate-cache.json'))?.nightly ?? conf;
  // the drivers run gradle (src-gradle.mjs, --offline) and vitest in this checkout: it needs the main checkout's untracked deps,
  // APFS-cloned (AGENTS.md; cheap). Ignored by git, so the tree stays clean. nightly.seedFromMain lists them.
  for (const rel of wtConf.seedFromMain ?? conf.seedFromMain ?? ['.gradle-home', 'sidecar/node_modules']) {
    const dst = path.join(WT, rel);
    const src = path.join(MAIN, rel);
    if (fs.existsSync(dst) || !fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    execFileSync('cp', ['-c', '-R', src, dst]);
    log(`nightly: cloned the main checkout's ${rel} into ${WT}`);
  }
  summary.head = git(WT, 'rev-parse', 'HEAD');
  log(`nightly: ${WT} at origin/main ${summary.head.slice(0, 9)}`);
} catch (e) {
  summary.state = 'skipped';
  summary.error = e.message;
  writeDay();
  log(`nightly: skipped: ${e.message}`);
  process.exit(0);
}
if (!fs.existsSync(path.join(WT, 'tools', 'step-inputs.json'))) log('nightly: origin/main has no step cache yet: the run still runs everything, nothing is recorded');

// ------------------------------------------------------------------ the run

const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(ANTHROPIC_|CLAUDE)/.test(k) && !/^GATE_NOTIFY/.test(k) && k !== 'AWS_BEARER_TOKEN_BEDROCK') env[k] = v;
// (nightly 2026-10-25) launchd's bare environment (no TERM, no agent variables) makes vitest colour its summary even into a pipe, and the
// drivers' /Tests\s+\d+ passed/ checks then fail on "Tests [22m [1m[32m25 passed" (sch-unit, p0-unit, coa-unit item 3, pt2-unit when
// unit-sidecar's report could not be reused). Plain output, as every agent-launched run already gets.
env.NO_COLOR = '1';
const outFile = path.join(DAY, flag('--plan') ? 'plan.out' : 'gate-run.out');
const t0 = Date.now();
let current = null; // the runner child now running
// SIGTERM to the nightly passes on to its own runner only (the runner then stops its own steps and clients)
const onSig = () => {
  try {
    if (current) process.kill(current.pid, 'SIGTERM');
  } catch {
    // gone
  }
};
process.on('SIGTERM', onSig);
process.on('SIGINT', onSig);

// the yield guard (gate-cache.json nightly.yieldAfter, local time): past it, with another run queued, the turbo run is asked to
// yield (SIGUSR2: it starts nothing new, its running steps finish); the steps it didn't start then run as a normal one-slot run
const [yh, ym] = String(wtConf.yieldAfter ?? conf.yieldAfter ?? '05:30').split(':').map(Number);
const pastCutoff = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() >= yh * 60 + (ym || 0);
};
async function queuedOthers(mine) {
  try {
    const t = await import(path.join(HERE, 'tools', 'lib', 'turbo.mjs'));
    return t.liveTickets(SLOT_DIR, { prune: false }).filter((x) => !mine.includes(x.pid)).map((x) => t.describeRun(x));
  } catch {
    return [];
  }
}

/** Runs gate-run with `args` to its end; -> { code, run, sm, pid }. `guard`: watch for the yield cutoff. */
async function runGate(args, { guard = false } = {}) {
  log(`nightly: node ${args.join(' ')} (cwd ${WT})`);
  const fd = fs.openSync(outFile, 'a');
  const child = spawn(process.execPath, args, { cwd: WT, env, stdio: ['ignore', fd, fd] });
  current = child;
  summary.state = 'running';
  summary.runnerPid = child.pid;
  writeDay();
  let timer = null;
  if (guard) {
    timer = setInterval(async () => {
      if (summary.yield || !pastCutoff()) return;
      // only a runner that holds the machine and runs its steps yields (one still waiting for its slot is left to queue)
      let running = false;
      try {
        for (const d of fs.readdirSync(OUT).filter((x) => /-release$/.test(x))) {
          const s0 = readJson(path.join(OUT, d, 'summary.json'));
          if (s0?.runnerPid === child.pid && s0.state === 'running' && s0.steps?.some((x) => x.status === 'RUNNING' || x.status === 'PASS' || x.status === 'FAIL')) running = true;
        }
      } catch {
        // no out dir yet
      }
      if (!running) return;
      const q = await queuedOthers([process.pid, child.pid]);
      if (!q.length) return;
      summary.yield = { at: stamp(), cutoff: `${yh}:${String(ym || 0).padStart(2, '0')}`, queued: q };
      writeDay();
      log(`nightly: past ${summary.yield.cutoff} with a run queued (${q.join('; ')}): asking the turbo run to yield (SIGUSR2)`);
      try {
        process.kill(child.pid, 'SIGUSR2');
      } catch {
        // gone
      }
    }, 60_000);
  }
  const code = await new Promise((r) => child.on('exit', (c) => r(c ?? 1)));
  if (timer) clearInterval(timer);
  fs.closeSync(fd);
  current = null;
  let run = null;
  try {
    for (const d of fs.readdirSync(OUT).filter((x) => /-release$/.test(x)).sort().reverse()) {
      if (readJson(path.join(OUT, d, 'summary.json'))?.runnerPid === child.pid) {
        run = path.join(OUT, d);
        break;
      }
    }
  } catch {
    // no out dir
  }
  return { code, run, sm: run ? readJson(path.join(run, 'summary.json')) : null, pid: child.pid };
}

// --nightly: the judged benches run here with their timing judged, isolated, and their PASSes are recorded for the releases to
// reuse (docs/GATES.md "Benches out of the release path"); megaB's walk follows its schedule, --megab-full forces the full walk
const benchArgs = ['--nightly', ...(flag('--megab-full') ? ['--megab-full'] : [])];
const first = await runGate(['tools/gate-run.mjs', 'release', '--full', '--no-cache', ...benchArgs, '--run-dir', RUN_DIR, '--out', OUT, ...(wtConf.extraArgs ?? []), ...(flag('--plan') ? ['--plan'] : [])], { guard: !flag('--plan') });
if (flag('--plan')) {
  summary.state = 'plan';
  writeDay();
  log(`nightly: plan written to ${outFile}`);
  process.exit(0);
}
const runs = [first];
if (first.sm?.yielded?.notStarted?.length) {
  // the rest as a normal shared run: one slot, in the queue like any run (behind the run that was waiting)
  const rest = first.sm.yielded.notStarted;
  summary.yield = { ...(summary.yield ?? {}), yieldedAt: first.sm.yielded.at, notStarted: rest.length, firstRun: first.run };
  log(`nightly: the turbo run yielded with ${rest.length} step(s) not started; running them as a one-slot run`);
  const second = await runGate(['tools/gate-run.mjs', 'release', '--no-cache', '--no-turbo', '--nightly', '--only', rest.join(','), '--run-dir', RUN_DIR, '--out', OUT]);
  summary.yield.secondRun = second.run;
  runs.push(second);
}
const run = first.run;
const allSteps = runs.flatMap((r) => (r.sm?.steps ?? []).filter((s) => !(s.status === 'SKIPPED' && s.error === 'yielded')).map((s) => ({ ...s, run: r.run })));
const counts = {};
for (const s of allSteps) counts[s.status] = (counts[s.status] ?? 0) + 1;
const last = runs[runs.length - 1].sm;
const sm = first.sm;
Object.assign(summary, {
  state: last?.state === 'done' && (sm?.state === 'done' || sm?.yielded) ? 'done' : sm?.state ?? 'aborted', endedAt: stamp(), wallMin: Math.round((Date.now() - t0) / 600) / 100,
  exitCode: runs.map((r) => r.code), run, runs: runs.map((r) => r.run), verdict: runs.some((r) => !r.sm) ? null : allSteps.length && allSteps.every((x) => x.status === 'PASS') ? 'PASS' : 'FAIL',
  counts, steps: allSteps.length, slotWaitMin: Math.round(runs.reduce((a, r) => a + (r.sm?.slot?.waitedSeconds ?? 0), 0) / 6) / 10,
  notPassing: allSteps.filter((s) => s.status !== 'PASS').map((s) => ({ id: s.id, status: s.status, failLines: (s.failLines ?? s.tail ?? []).slice(0, 3), log: s.log ? path.join(s.run, s.log) : null })),
  recorded: allSteps.filter((s) => s.cache?.recorded).length, inputsMisses: runs.flatMap((r) => r.sm?.inputsMisses ?? []),
  // the judged benches this nightly ran (a release reuses their PASSes: docs/GATES.md "Benches out of the release path")
  benches: { ...(sm?.tier?.benches ?? {}), results: allSteps.filter((s) => (sm?.tier?.benches?.ids ?? []).includes(s.id.split('/')[0])).map((s) => ({ id: s.id, status: s.status, recorded: !!s.cache?.recorded, why: s.cache?.why ?? null })) },
});

// the impact-map misses against the last release that served steps from the cache
let mm = { misses: [], explained: [], release: null };
for (const r of runs.filter((x) => x.run)) {
  try {
    const m = impactMisses(r.run);
    mm = { ...m, misses: [...mm.misses, ...m.misses], explained: [...mm.explained, ...m.explained], release: m.release ?? mm.release };
  } catch (e) {
    summary.missError = e.message;
  }
}
summary.release = mm.release;
summary.impactMapMisses = mm.misses.length;
fs.writeFileSync(path.join(DAY, 'impact-map-misses.json'), `${JSON.stringify(mm, null, 1)}\n`);
const lines = mm.misses.map((m) => `| ${date} | ${m.step} | ${m.nightlyStatus} at key ${m.cachedKey.slice(0, 12)} (nightly ${String(summary.head).slice(0, 9)}); CACHED in ${path.basename(mm.release.run)} from ${path.basename(m.cachedFrom.run ?? '?')} @ ${String(m.cachedFrom.head).slice(0, 9)}; ${m.changedCount} file(s) changed since the PASS | open: find the input the map lacks (or a flake), widen tools/step-inputs.json |`);
fs.writeFileSync(path.join(DAY, 'misses-log.md'), lines.length ? `${lines.join('\n')}\n` : '');
writeDay();

// ------------------------------------------------------------------ the UI gallery (docs/GATES.md "UI gallery")
// NIGHTLY ONLY and non-blocking: after the full run, the named chain `ui-gallery` (one client step, sim sidecar, $0, no Claude) shoots
// every Architect screen / HUD state / in-world piece at GUI scale 2 and 4 into artifacts/nightly/<date>/ui/ with index.json. Own run
// dir, out dir, lock and ports (gate-cache.json nightly.uiGallery). Whatever happens (the chain missing on this head, a client that
// won't start, a timeout, capture failures) is only reported in summary.uiGallery and SUMMARY.md; it never touches verdict, counts or
// notPassing. Skipped past the yield cutoff, and when the chain is not on this head yet.
const UIG = { enabled: true, runDir: '../architect-mc-nightui-run', out: 'artifacts/gate-runs-nightly-ui', ports: '8898:8899', timeoutMin: 20, ...(conf.uiGallery ?? {}), ...(wtConf.uiGallery ?? {}) };
async function uiGallery() {
  const res = { state: 'skipped', shots: 0, failed: 0, skipped: 0, wallMin: 0, dir: path.join(DAY, 'ui'), error: null };
  const chains = readJson(path.join(WT, 'tools', 'gate-chains.json'));
  if (!UIG.enabled) res.error = 'disabled (nightly.uiGallery.enabled)';
  else if (!chains?.chains?.['ui-gallery']) res.error = 'no ui-gallery chain on this head';
  else if (pastCutoff()) res.error = `past the ${yh}:${String(ym || 0).padStart(2, '0')} cutoff`;
  if (res.error) return res;
  const t1 = Date.now();
  fs.rmSync(res.dir, { recursive: true, force: true });
  const uiOut = path.resolve(MAIN, UIG.out);
  const args = ['tools/gate-run.mjs', 'ui-gallery', '--no-turbo', '--run-dir', path.resolve(MAIN, UIG.runDir), '--out', uiOut, '--ports', UIG.ports, '--lock', path.join(uiOut, 'gate-run.lock')];
  log(`nightly: ui gallery: node ${args.join(' ')} (cwd ${WT}; at most ${UIG.timeoutMin} min)`);
  const fd = fs.openSync(path.join(DAY, 'ui-gallery.out'), 'a');
  const child = spawn(process.execPath, args, { cwd: WT, env: { ...env, GATEUIG_DEST: res.dir }, stdio: ['ignore', fd, fd] });
  current = child;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 90_000).unref();
  }, UIG.timeoutMin * 60_000);
  const code = await new Promise((r) => child.on('exit', (c) => r(c ?? 1)));
  clearTimeout(timer);
  fs.closeSync(fd);
  current = null;
  res.wallMin = Math.round((Date.now() - t1) / 600) / 100;
  const idx = readJson(path.join(res.dir, 'index.json'));
  if (idx) Object.assign(res, { shots: idx.counts?.shots ?? idx.shots?.length ?? 0, failed: idx.counts?.failed ?? 0, skipped: idx.counts?.skipped ?? 0, failures: (idx.failed ?? []).slice(0, 40).map((f) => `${f.screen}/${f.state}${f.scale ? ` s${f.scale}` : ''}: ${f.error}`) });
  res.state = timedOut ? 'timeout' : idx ? (res.failed ? 'partial' : 'ok') : 'failed';
  if (timedOut) res.error = `killed after ${UIG.timeoutMin} min`;
  else if (!idx) res.error = `no index.json (the runner exited ${code}; see ui-gallery.out)`;
  return res;
}
if (!flag('--plan')) {
  try {
    summary.uiGallery = await uiGallery();
  } catch (e) {
    summary.uiGallery = { state: 'failed', shots: 0, error: e.message };
  }
  log(`nightly: ui gallery ${summary.uiGallery.state}: ${summary.uiGallery.shots} shot(s), ${summary.uiGallery.failed ?? 0} failed${summary.uiGallery.error ? `, ${summary.uiGallery.error}` : ''}`);
}

const md = [
  `# Nightly ${date}: ${summary.verdict ?? summary.state}`,
  '',
  `origin/main ${String(summary.head).slice(0, 9)}; \`release --full --no-cache\`, ${summary.steps} steps in ${summary.wallMin} min${summary.slotWaitMin ? ` (${summary.slotWaitMin} min waiting for a slot)` : ''}; run \`${run ?? '-'}\`.`,
  ...(summary.yield?.yieldedAt ? [`**Yielded** at ${summary.yield.yieldedAt} (past ${summary.yield.cutoff} with ${summary.yield.queued?.length ?? '?'} run(s) queued): ${summary.yield.notStarted} step(s) ran afterwards as a one-slot run, \`${summary.yield.secondRun ?? '-'}\`.`] : []),
  `Steps: ${Object.entries(summary.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(', ') || '-'}; ${summary.recorded} PASS(es) recorded in the step cache.`,
  `Benches (timing judged, isolated; a release reuses these PASSes): ${summary.benches.results.map((b) => `${b.id} ${b.status}${b.status === 'PASS' ? (b.recorded ? ' (recorded)' : ` (NOT recorded: ${b.why})`) : ''}`).join(', ') || '-'}${summary.benches.megaB ? `; megaB: ${summary.benches.megaB.id} (${summary.benches.megaB.why})` : ''}.`,
  '',
  `**Impact-map misses: ${mm.misses.length}**${mm.release ? ` (against the last cached release ${path.basename(mm.release.run)} @ ${String(mm.release.head).slice(0, 9)})` : ' (no release has served a step from the cache yet)'}.`,
  ...mm.misses.map((m) => `- **${m.step}** ${m.nightlyStatus} at the key it was CACHED under: \`${(m.failLines[0] ?? '').replace(/`/g, "'").slice(0, 160)}\` (log \`${m.nightlyLog}\`). Paste \`misses-log.md\` into docs/GATES.md's misses log.`),
  ...(mm.explained.length ? ['', `Not misses (their inputs changed since the cached PASS): ${mm.explained.map((m) => `${m.step} ${m.nightlyStatus}`).join(', ')}.`] : []),
  ...(summary.inputsMisses.length ? ['', `Inputs-map misses in this run (a PASS not cached: its trace left its set; \`node tools/step-inputs.mjs merge ${run}\`): ${summary.inputsMisses.map((m) => m.step).join(', ')}.`] : []),
  '',
  `**UI gallery** (non-blocking, $0): ${summary.uiGallery ? `${summary.uiGallery.state}; ${summary.uiGallery.shots} shot(s) at GUI scale 2 and 4, ${summary.uiGallery.failed ?? 0} capture(s) failed, ${summary.uiGallery.skipped ?? 0} skipped, ${summary.uiGallery.wallMin} min${summary.uiGallery.error ? `; ${summary.uiGallery.error}` : ''}; \`${path.join(DAY, 'ui')}/index.json\`` : 'not run'}.`,
  ...(summary.uiGallery?.failures?.length ? summary.uiGallery.failures.map((f) => `  - not captured: ${f}`) : []),
  '',
  '## Not passing',
  '',
  ...(summary.notPassing.length ? summary.notPassing.map((s) => `- ${s.id} ${s.status}: \`${(s.failLines[0] ?? '').replace(/`/g, "'").slice(0, 160)}\``) : ['none']),
  '',
];
fs.writeFileSync(path.join(DAY, 'SUMMARY.md'), md.join('\n'));
if (summary.state === 'done') fs.writeFileSync(path.join(NIGHTLY, 'latest.json'), `${JSON.stringify({ date, state: 'done', startedAt: summary.startedAt, endedAt: summary.endedAt, head: summary.head, run, verdict: summary.verdict }, null, 1)}\n`);
log(`nightly: ${summary.verdict ?? summary.state}, ${summary.wallMin} min, ${mm.misses.length} impact-map miss(es); ${path.join(DAY, 'SUMMARY.md')}`);
process.exit(0);
