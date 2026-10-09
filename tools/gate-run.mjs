#!/usr/bin/env node
// Unattended gate runner (docs/GATES.md): runs a named chain of gate steps from tools/gate-chains.json against a dev client
// in the runner's own run worktree, with no agent watching. Non-interactive; per-step timeouts (a hung step is killed, its
// own process group and then the run worktree's processes only); continues past failures unless a step is `stopOnFail`;
// one lock; one Discord notify at the end (routine on a pass, critical otherwise). No Claude: it refuses to start with
// Claude credentials in the environment, strips every ANTHROPIC_* / CLAUDE* variable from its children, and runs only the
// stub/sim client scripts.
//
//   node tools/gate-run.mjs <chain> [--notify-dry-run | --no-notify] [--only a,b] [--from step]
//   node tools/gate-run.mjs <chain> --plan          print the plan (steps, clients, timeouts, ports, setup) and exit
//   node tools/gate-run.mjs --list                  the chains
//
// Output: artifacts/gate-runs/<timestamp>-<chain>/ in the main checkout (GATE_RUNS_OUT overrides): summary.json (written at
// the start with state "running", rewritten after every step, final state "done" | "stopped" | "aborted"), SUMMARY.md,
// runner.log, <step>.log, the gates' own evidence under gate4d/ gate4e/ gate5b/ gate6a/ sim-*/, client.log.
//
// Environment: ARCHITECT_GATE_SIDECAR_PORT / ARCHITECT_GATE_DEV_PORT (the game client's pair, default 8890/8891; the gates'
// old-version clients use 8892/8893 and eval sidecars 8894/8895), GATE_RUN_DIR (run worktree, default ../architect-mc-gate-run),
// GATE_SEED_DIR (read-only source of .gradle-home, node_modules and the gate worlds, default ../architect-mc-6a-run),
// GATE_RUNS_OUT, GATE_NOTIFY_SCRIPT (default ~/Developer/_infra/discord-notify.sh), GATE_NOTIFY=dry|off.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DevClient } from './lib/devclient.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(SRC, '..', 'architect-mc');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ arguments and config

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const CONFIG_PATH = path.resolve(opt('--config') ?? path.join(SRC, 'tools', 'gate-chains.json'));
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const chainName = argv.find((a, i) => !a.startsWith('--') && !['--config', '--only', '--from'].includes(argv[i - 1]));

if (flag('--list') || !chainName) {
  for (const [n, s] of Object.entries(cfg.chains)) console.log(`${n.padEnd(8)} ${s.length} steps: ${s.join(' ')}`);
  if (!chainName && !flag('--list')) {
    console.error('\nusage: node tools/gate-run.mjs <chain> [--plan] [--notify-dry-run | --no-notify] [--only a,b] [--from step]');
    process.exit(2);
  }
  process.exit(0);
}
if (!cfg.chains[chainName]) {
  console.error(`unknown chain ${chainName}; chains: ${Object.keys(cfg.chains).join(' ')}`);
  process.exit(2);
}
let stepIds = [...cfg.chains[chainName]];
if (opt('--only')) {
  const only = opt('--only').split(',');
  stepIds = stepIds.filter((s) => only.includes(s));
}
if (opt('--from')) stepIds = stepIds.slice(Math.max(0, stepIds.indexOf(opt('--from'))));

const PLAN = flag('--plan') || flag('--dry-run');
const NOTIFY_MODE = flag('--no-notify') || process.env.GATE_NOTIFY === 'off' ? 'off' : flag('--notify-dry-run') || process.env.GATE_NOTIFY === 'dry' ? 'dry' : 'send';
const NOTIFY_SCRIPT = process.env.GATE_NOTIFY_SCRIPT ?? path.join(os.homedir(), 'Developer', '_infra', 'discord-notify.sh');
const RUN = path.resolve(process.env.GATE_RUN_DIR ?? path.resolve(SRC, cfg.runDir));
const SEED = path.resolve(process.env.GATE_SEED_DIR ?? path.resolve(SRC, cfg.seedFrom));
const RUNS_ROOT = path.resolve(process.env.GATE_RUNS_OUT ?? path.join(MAIN, 'artifacts', 'gate-runs'));
const SIDECAR_PORT = Number(process.env.ARCHITECT_GATE_SIDECAR_PORT || 8890);
const DEV_PORT = Number(process.env.ARCHITECT_GATE_DEV_PORT || 8891);
const GAME_DIR = path.join(RUN, 'mod', 'run');

// ------------------------------------------------------------------ guards (before anything runs)

const die = (m) => {
  console.error(`gate-run: ${m}`);
  process.exit(2);
};
// credential-bearing variables: refuse. Routing/flag variables (ANTHROPIC_BASE_URL, CLAUDE_CODE_*) are only stripped below,
// so an agent's shell can launch the runner.
const CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK'];
const setCreds = CREDENTIALS.filter((k) => process.env[k]);
if (setCreds.length) die(`refusing to start: ${setCreds.join(', ')} set. Gate runs never call Claude; unset it (env -u ${setCreds[0]} node tools/gate-run.mjs ...).`);

// the run worktree is the runner's own: never the seed (architect-mc-6a-run), this checkout or the main checkout
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
for (const [what, p] of [['the seed dir', SEED], ['this checkout', SRC], ['the main checkout', MAIN], ['architect-mc-6a-run', path.resolve(SRC, '..', 'architect-mc-6a-run')]]) {
  if (real(RUN) === real(p)) die(`refusing: the run dir ${RUN} is ${what}`);
}
if (real(RUN).startsWith(real(SRC) + path.sep)) die(`refusing: the run dir ${RUN} is inside this checkout`);

// steps: only $0 commands; clients: only the stub/sim scripts
const PAID = /(-real\b|--tier\s+(smoke|full)\b|--backend\s+claude\b|--use-claude-login\b|\bpaid\b)/;
const SAFE_CLIENTS = new Set(['tools/run-gate4d-client.sh', 'tools/run-gate4e-client.sh', 'tools/run-gate5b-client.sh', 'tools/run-gate6a-client.sh']);
for (const id of stepIds) {
  const s = cfg.steps[id];
  if (!s) die(`chain ${chainName}: unknown step ${id}`);
  const text = s.shell ?? (s.cmd ?? []).join(' ');
  if (PAID.test(text)) die(`refusing: step ${id} looks like a paid/Claude run: ${text}`);
  if (!['none', 'self'].includes(s.client) && !cfg.clients[s.client]) die(`step ${id}: unknown client ${s.client}`);
}
for (const [k, c] of Object.entries(cfg.clients)) if (!SAFE_CLIENTS.has(c.script)) die(`client ${k}: ${c.script} is not a stub/sim client script`);

// ------------------------------------------------------------------ helpers

const fmtDur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s.toFixed(0)}s`);
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** Every process whose command line names the run worktree (gradle, the client JVM, the sidecar), minus this one. */
function runDirProcs() {
  const r = spawnSync('ps', ['-axww', '-o', 'pid=,pgid=,command='], { encoding: 'utf8' });
  const needles = [...new Set([RUN, real(RUN)])].map((p) => p + path.sep);
  return r.stdout.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, pgid, cmd]) => ({ pid: Number(pid), pgid: Number(pgid), cmd }))
    .filter((p) => p.pid !== process.pid && needles.some((n) => p.cmd.includes(n)));
}
/** The processes the runner and the gates start in the run worktree: gradle and its daemon/workers, the client JVM, the
 * sidecar, vitest, the client scripts. Only these are ever killed (an observer such as `tail -f <run>/...` is not). */
function ownProcs() {
  const marks = [...new Set([RUN, real(RUN)])].flatMap((r) => ['/mod/.gradle/loom-cache/launch.cfg', '/mod/gradle/wrapper/', '/.gradle-home/',
    '/sidecar/dist/', '/sidecar/node_modules/', '/tools/run-'].map((m) => r + m));
  return runDirProcs().filter((p) => marks.some((m) => p.cmd.includes(m)));
}
const clientProcs = () => runDirProcs().filter((p) => p.cmd.includes('/mod/.gradle/loom-cache/launch.cfg'));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const portFree = (port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(false));
  srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
});

/** The children's environment: no ANTHROPIC_* / CLAUDE* at all, the run worktree's paths, the gate ports, the run's OUT dirs. */
function childEnv(OUT, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE)/.test(k) || k === 'ARCHITECT_DEV_TOKEN' || k === 'AWS_BEARER_TOKEN_BEDROCK') continue;
    env[k] = v;
  }
  Object.assign(env, {
    ARCHITECT_PORT: String(SIDECAR_PORT), ARCHITECT_DEV_PORT: String(DEV_PORT),
    ARCHITECT_GAME_DIR: GAME_DIR, APITEST_GAME_DIR: GAME_DIR,
    GATE4E_RUN: RUN, GATE5B_RUN: RUN, GATE6A_RUN: RUN,
    GATE4D_OUT: path.join(OUT, 'gate4d'), GATE4E_OUT: path.join(OUT, 'gate4e'), GATE5B_OUT: path.join(OUT, 'gate5b'), GATE6A_OUT: path.join(OUT, 'gate6a'),
    ARCHITECT_SHOTS_DIR: path.join(OUT, 'shots'),
    JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25',
    GATE_RUNNER: '1',
  });
  const vars = { RUN, SRC, MAIN, OUT };
  for (const [k, v] of Object.entries(extra)) env[k] = String(v).replace(/\$\{(\w+)\}/g, (_, n) => vars[n] ?? '');
  return env;
}
const expand = (s, OUT) => s.replace(/\$\{(\w+)\}/g, (_, n) => ({ RUN, SRC, MAIN, OUT })[n] ?? '');
const resolveCwd = (c) => (!c ? SRC : c.startsWith('run:') ? path.join(RUN, c.slice(4)) : c.startsWith('src:') ? path.join(SRC, c.slice(4)) : path.resolve(SRC, c));
const getPath = (obj, p) => p.split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);

// ------------------------------------------------------------------ the plan

const steps = stepIds.map((id) => ({ id, ...cfg.steps[id] }));
const missingSeed = (cfg.seed ?? []).filter((s) => !fs.existsSync(path.join(RUN, s)));
const totalTimeout = steps.reduce((a, s) => a + s.timeoutMin, 0);

function printPlan() {
  const head = git(SRC, 'rev-parse', '--short', 'HEAD');
  console.log(`chain ${chainName}: ${steps.length} steps, worst case ${fmtDur(totalTimeout * 60)} of step timeouts (+ client starts, ${cfg.clientStartMin} min cap each)`);
  console.log(`source ${SRC} @ ${head}${git(SRC, 'status', '--porcelain', '--untracked-files=no') ? ' (DIRTY: the drivers run from the working tree, the client from HEAD)' : ''}`);
  console.log(`run worktree ${RUN} ${fs.existsSync(RUN) ? '(exists; checked out --detach at the source HEAD)' : '(created: git worktree add --detach)'}`);
  console.log(`seed ${SEED} (read-only, APFS clones): ${missingSeed.length ? `would clone ${missingSeed.join(', ')}` : 'nothing missing'}`);
  console.log(`ports: sidecar ${SIDECAR_PORT}, DevBridge ${DEV_PORT}; artifacts ${RUNS_ROOT}/<timestamp>-${chainName}/; notify ${NOTIFY_MODE} via ${NOTIFY_SCRIPT}`);
  console.log('setup: sidecar npm run build (run worktree)');
  let cur = null;
  steps.forEach((s, i) => {
    let clientNote = '';
    if (s.client === 'none' || s.client === 'self') {
      if (cur) clientNote = `stop client ${cur}; `;
      cur = null;
      if (s.client === 'self') clientNote += 'step starts/stops its own clients; ';
    } else if (cur !== s.client || s.restartClient) {
      const c = cfg.clients[s.client];
      clientNote = `${cur ? `stop client ${cur}; ` : ''}start client ${s.client} (${c.script} in "${c.world}"); `;
      cur = s.client;
    }
    const cmd = s.shell ?? s.cmd.join(' ');
    console.log(`${String(i + 1).padStart(2)}. ${s.id.padEnd(15)} ${String(s.timeoutMin).padStart(3)} min${s.stopOnFail ? ' stopOnFail' : ''}  ${clientNote}${cmd}  [cwd ${s.cwd ?? 'src:'}]${s.after ? ` (after ${s.after})` : ''}`);
  });
  if (cur) console.log(`    end: stop client ${cur}`);
}

if (PLAN) {
  printPlan();
  const busy = [];
  for (const p of [SIDECAR_PORT, DEV_PORT]) if (!(await portFree(p))) busy.push(p);
  const procs = runDirProcs();
  console.log(`preflight now: ports ${busy.length ? `BUSY ${busy.join(',')}` : 'free'}; processes in the run worktree: ${procs.length ? procs.map((p) => p.pid).join(',') : 'none'}`);
  process.exit(0);
}

// ------------------------------------------------------------------ the lock

fs.mkdirSync(RUNS_ROOT, { recursive: true });
const LOCK = path.join(RUNS_ROOT, 'gate-run.lock');
function takeLock() {
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, chain: chainName, startedAt: new Date().toISOString(), runDir: RUN }), { flag: 'wx' });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = {};
      try {
        held = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      } catch {
        // unreadable: treated as stale
      }
      if (held.pid && alive(held.pid)) die(`another gate run holds ${LOCK} (pid ${held.pid}, chain ${held.chain}, since ${held.startedAt})`);
      fs.rmSync(LOCK, { force: true }); // stale
    }
  }
  die(`could not take ${LOCK}`);
}
takeLock();
let lockHeld = true;
const releaseLock = () => {
  if (!lockHeld) return;
  lockHeld = false;
  try {
    if (JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid === process.pid) fs.rmSync(LOCK, { force: true });
  } catch {
    // gone
  }
};

// ------------------------------------------------------------------ the run dir, summary, log

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const OUT = path.join(RUNS_ROOT, `${stamp}-${chainName}`);
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'runner.pid'), String(process.pid));
const t0 = Date.now();
const LOGF = path.join(OUT, 'runner.log');
const log = (m) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(line);
  fs.appendFileSync(LOGF, line + '\n');
};

const summary = {
  chain: chainName, state: 'running', verdict: null, runnerPid: process.pid, startedAt: new Date(t0).toISOString(), endedAt: null, durationSeconds: null,
  source: SRC, head: null, sourceDirty: null, runDir: RUN, ports: { sidecar: SIDECAR_PORT, dev: DEV_PORT }, out: OUT, notify: NOTIFY_MODE,
  counts: {}, setup: null, steps: steps.map((s) => ({ id: s.id, desc: s.desc, status: 'PENDING', timeoutMin: s.timeoutMin })),
};
const writeSummary = () => {
  const c = {};
  for (const s of summary.steps) c[s.status] = (c[s.status] ?? 0) + 1;
  summary.counts = c;
  fs.writeFileSync(path.join(OUT, 'summary.json.tmp'), JSON.stringify(summary, null, 2));
  fs.renameSync(path.join(OUT, 'summary.json.tmp'), path.join(OUT, 'summary.json'));
};
writeSummary();

// ------------------------------------------------------------------ processes: kill only ours

/** SIGTERM, then SIGKILL, the run worktree's gradle/client/sidecar/vitest processes (all started by this run: preflight found
 * nothing using the worktree). */
async function killRunDir(why) {
  let ps = ownProcs();
  if (!ps.length) return;
  log(`  killing run-worktree processes (${why}): ${ps.map((p) => p.pid).join(' ')}`);
  for (const p of ps) try { process.kill(p.pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 30 && (ps = ownProcs()).length; i++) await sleep(1000);
  for (const p of ps) try { process.kill(p.pid, 'SIGKILL'); } catch {}
}

/** A step's own process group. */
function killGroup(pgid, sig) {
  try {
    process.kill(-pgid, sig);
  } catch {
    // gone
  }
}

function cleanStrays() {
  // apijars copies apitest jars into the run client's mods/ and removes them in a finally that a kill skips
  const mods = path.join(GAME_DIR, 'mods');
  if (!fs.existsSync(mods)) return;
  for (const f of fs.readdirSync(mods)) {
    if (/^architect_apitest-.*\.jar$/.test(f)) {
      fs.rmSync(path.join(mods, f), { force: true });
      log(`  removed stray ${f} from the run client's mods/`);
    }
  }
}

// ------------------------------------------------------------------ the client

let current = null; // the client key this runner started, or null

async function connectDev(timeoutMs) {
  const tokenFile = path.join(GAME_DIR, 'architect', 'devbridge.token');
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      return await DevClient.connect({ port: DEV_PORT, token, timeoutMs: 10_000 });
    } catch (e) {
      last = e;
    }
    await sleep(2000);
  }
  throw new Error(`no DevBridge on ${DEV_PORT}: ${last?.message ?? last}`);
}

async function stopClient(why = 'switch') {
  if (!ownProcs().length) {
    current = null;
    return;
  }
  if (clientProcs().length) {
    log(`  stopping client ${current ?? '(started by a step)'} (${why})`);
    try {
      const dev = await connectDev(10_000);
      await dev.call('dev.quit', {}, { timeoutMs: 30_000 }).catch(() => null);
      dev.close();
    } catch {
      // not answering: by PID below
    }
    for (let i = 0; i < 120 && clientProcs().length; i++) await sleep(1000);
  }
  await sleep(2000);
  await killRunDir(`after ${why}`);
  current = null;
}

async function startClient(key) {
  const c = cfg.clients[key];
  const world = c.world;
  log(`  starting client ${key}: ${c.script} in "${world}"`);
  const opts = path.join(GAME_DIR, 'options.txt');
  if (fs.existsSync(opts)) fs.writeFileSync(opts, fs.readFileSync(opts, 'utf8').replace(/^enableVsync:true$/m, 'enableVsync:false'));
  fs.rmSync(path.join(GAME_DIR, 'architect', 'devbridge.token'), { force: true });
  const out = fs.openSync(path.join(OUT, 'client.log'), 'a');
  fs.writeSync(out, `\n===== ${new Date().toISOString()} start ${key} (${c.script}, "${world}")\n`);
  const child = spawn(path.join(RUN, c.script), c.args ?? [], { cwd: RUN, detached: true, stdio: ['ignore', out, out],
    env: childEnv(OUT, { ...(c.env ?? {}), ARCHITECT_AUTOWORLD_NAME: world }) });
  child.unref();
  let exited = null;
  child.on('exit', (code) => (exited = code));
  const end = Date.now() + cfg.clientStartMin * 60_000;
  let dev = null;
  while (Date.now() < end && exited === null) {
    try {
      dev = await connectDev(5_000);
      break;
    } catch {
      await sleep(3000);
    }
  }
  if (!dev) throw new Error(exited !== null ? `client script exited ${exited} before the DevBridge came up (client.log)` : `no DevBridge within ${cfg.clientStartMin} min`);
  try {
    while (Date.now() < end) {
      const st = await dev.call('dev.state').catch(() => ({}));
      if (st.inWorld && st.ready) {
        await dev.call('dev.waitChunks', { timeoutMs: 60_000 }, { timeoutMs: 90_000 }).catch(() => {});
        await sleep(3000);
        current = key;
        log(`  client ${key} up in "${world}" (pids ${clientProcs().map((p) => p.pid).join(' ')})`);
        return;
      }
      await sleep(1000);
    }
    throw new Error(`client not in a world within ${cfg.clientStartMin} min`);
  } finally {
    dev.close();
  }
}

async function ensureClient(step) {
  if (step.client === 'none' || step.client === 'self') {
    if (ownProcs().length) await stopClient(`before ${step.id}`);
    return;
  }
  const up = clientProcs().length > 0;
  if (up && current === step.client && !step.restartClient) return;
  if (ownProcs().length) await stopClient(`before ${step.id}`);
  await startClient(step.client);
}

// ------------------------------------------------------------------ a step

const OK_RE = /^(?:\[\d\d:\d\d:\d\d\] )?ok\b/;
const FAIL_RE = /^(?:\[\d\d:\d\d:\d\d\] )?FAIL\b/;

function readJsonSafe(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  }
}

function junitCounts(dir) {
  if (!fs.existsSync(dir)) return null;
  const c = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.xml'))) {
    const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 2000).match(/<testsuite\b[^>]*>/)?.[0] ?? '';
    for (const k of Object.keys(c)) c[k] += Number(head.match(new RegExp(`\\b${k}="(\\d+)"`))?.[1] ?? 0);
  }
  return c;
}

function runProcess(step, logFile) {
  return new Promise((resolve) => {
    const fd = fs.openSync(logFile, 'a');
    const env = childEnv(OUT, step.env ?? {});
    const cwd = resolveCwd(step.cwd);
    const [cmd, args] = step.shell ? ['/bin/zsh', ['-c', step.shell]] : [step.cmd[0], step.cmd.slice(1)];
    fs.writeSync(fd, `# ${new Date().toISOString()} ${step.shell ?? step.cmd.join(' ')}  (cwd ${cwd})\n`);
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`  TIMEOUT after ${step.timeoutMin} min: killing step group ${child.pid}`);
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 20_000);
    }, step.timeoutMin * 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      fs.writeSync(fd, `spawn error: ${e.message}\n`);
      resolve({ code: 127, timedOut: false });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      killGroup(child.pid, 'SIGTERM'); // leftovers of its own group (vitest workers, ...)
      fs.closeSync(fd);
      resolve({ code: code ?? (signal ? 128 : 1), signal, timedOut });
    });
    activeGroup = child.pid;
  });
}
let activeGroup = null;

async function runStep(step, rec) {
  const logFile = path.join(OUT, `${step.id}.log`);
  rec.log = path.relative(OUT, logFile);
  rec.status = 'RUNNING';
  rec.startedAt = new Date().toISOString();
  writeSummary();
  const ts = Date.now();
  log(`== ${step.id}: ${step.desc ?? ''}`);
  for (const [to, from] of Object.entries(step.links ?? {})) {
    const dst = path.join(OUT, to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (!fs.existsSync(dst)) fs.symlinkSync(expand(from, OUT), dst);
  }
  try {
    await ensureClient(step);
  } catch (e) {
    rec.status = 'ERROR';
    rec.error = `client: ${e.message}`;
    rec.seconds = (Date.now() - ts) / 1000;
    log(`  ERROR ${rec.error}`);
    await stopClient('client start failed');
    return rec;
  }
  const r = await runProcess(step, logFile);
  activeGroup = null;
  rec.seconds = (Date.now() - ts) / 1000;
  rec.exitCode = r.code;
  const text = fs.readFileSync(logFile, 'utf8');
  const lines = text.split('\n');
  rec.ok = lines.filter((l) => OK_RE.test(l)).length;
  rec.fail = lines.filter((l) => FAIL_RE.test(l)).length;
  const failLines = lines.filter((l) => FAIL_RE.test(l));
  if (failLines.length) rec.failLines = failLines.slice(0, 10).map((l) => l.slice(0, 300));
  // key numbers
  const metrics = {};
  for (const [k, re] of Object.entries(step.parse ?? {})) {
    const m = [...text.matchAll(new RegExp(re, 'gm'))].pop();
    if (m) metrics[k] = Number(m[1]);
  }
  if (step.junit) {
    const j = junitCounts(resolveCwd(step.junit));
    if (j) Object.assign(metrics, { tests: j.tests, failures: j.failures + j.errors, skipped: j.skipped });
  }
  for (const [k, spec] of Object.entries(step.metrics ?? {})) {
    const [file, p] = spec.split('#');
    const f = path.join(OUT, file);
    if (!fs.existsSync(f) || fs.statSync(f).mtimeMs < ts) continue; // only this step's evidence
    const v = getPath(readJsonSafe(f), p ?? '');
    if (v !== undefined) metrics[k] = typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
  }
  if (Object.keys(metrics).length) rec.metrics = metrics;
  const parsedFail = (metrics.fail ?? 0) + (metrics.failed ?? 0) + (metrics.failures ?? 0);
  if (r.timedOut) rec.status = 'TIMEOUT';
  else if (r.code === 0 && rec.fail === 0 && parsedFail === 0 && (step.okLines === false || rec.ok > 0)) rec.status = 'PASS';
  else rec.status = 'FAIL';
  if (rec.status !== 'PASS' && !rec.failLines) {
    // test runners' own failure lines (vitest " FAIL  file > test", node --test "✖ name")
    const tf = lines.filter((l) => /^\s*(FAIL\s|✖\s)/.test(l));
    if (tf.length) rec.failLines = tf.slice(0, 10).map((l) => l.trim().slice(0, 300));
  }
  if (rec.status !== 'PASS') {
    const tail = lines.filter((l) => l.trim()).slice(-5);
    rec.tail = tail.map((l) => l.slice(0, 300));
  }
  log(`  ${rec.status} ${step.id} in ${fmtDur(rec.seconds)} (exit ${r.code}${r.signal ? ` ${r.signal}` : ''}, ok ${rec.ok}, FAIL ${rec.fail})${rec.metrics ? ` ${JSON.stringify(rec.metrics)}` : ''}`);
  // a killed or failed step may leave a client in any state (or one it started itself): stop it, the next step starts fresh
  if (rec.status !== 'PASS' || step.client === 'self') {
    await stopClient(`${step.id} ${rec.status}`);
    if (rec.status === 'TIMEOUT') cleanStrays();
  }
  return rec;
}

// ------------------------------------------------------------------ setup: the run worktree

async function setup() {
  const rec = { status: 'RUNNING' };
  summary.setup = rec;
  const ts = Date.now();
  const setupLog = path.join(OUT, 'setup.log');
  const sh = (cmd, args, cwd) => {
    const r = spawnSync(cmd, args, { cwd, env: childEnv(OUT), encoding: 'utf8' });
    fs.appendFileSync(setupLog, `# ${cmd} ${args.join(' ')} (cwd ${cwd}) -> ${r.status}\n${r.stdout ?? ''}${r.stderr ?? ''}\n`);
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}); setup.log`);
    return r.stdout;
  };
  const head = git(SRC, 'rev-parse', 'HEAD');
  summary.head = head;
  summary.sourceDirty = !!git(SRC, 'status', '--porcelain', '--untracked-files=no');
  if (!fs.existsSync(RUN)) {
    log(`setup: git worktree add --detach ${RUN} ${head.slice(0, 7)}`);
    sh('git', ['-C', SRC, 'worktree', 'add', '--detach', RUN, head], SRC);
  } else {
    if (git(RUN, 'rev-parse', '--git-common-dir') && real(path.resolve(RUN, git(RUN, 'rev-parse', '--git-common-dir'))) !== real(path.resolve(SRC, git(SRC, 'rev-parse', '--git-common-dir')))) {
      throw new Error(`${RUN} is not a worktree of this repository`);
    }
    if (git(RUN, 'status', '--porcelain', '--untracked-files=no')) throw new Error(`${RUN} has modified tracked files; refusing to check out over them`);
    sh('git', ['-C', RUN, 'checkout', '-q', '--detach', head], SRC);
  }
  rec.head = git(RUN, 'rev-parse', '--short', 'HEAD');
  rec.seeded = [];
  for (const item of cfg.seed ?? []) {
    const dst = path.join(RUN, item);
    if (fs.existsSync(dst)) continue;
    const src = path.join(SEED, item);
    if (!fs.existsSync(src)) throw new Error(`seed ${src} missing`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    log(`setup: cloning ${item} from ${SEED} (APFS clone, read-only source)`);
    sh('cp', ['-c', '-R', src, dst], RUN);
    rec.seeded.push(item);
    if (item === 'mod/run') {
      // the seed's runtime state must not carry over: its token, its sidecar/launcher PIDs, stray apitest jars
      for (const f of ['architect/devbridge.token', 'architect/sidecar-data/sidecar.json', 'architect/sidecar-data/launcher.json']) fs.rmSync(path.join(dst, f), { force: true });
      cleanStrays();
    }
  }
  log('setup: sidecar npm run build');
  sh('npm', ['run', 'build'], path.join(RUN, 'sidecar'));
  rec.status = 'PASS';
  rec.seconds = (Date.now() - ts) / 1000;
  writeSummary();
}

// ------------------------------------------------------------------ the end: summary, notify

function summaryMd() {
  const c = summary.counts;
  const lines = [
    `# Gate run ${summary.chain}: ${summary.verdict}`,
    '',
    `${summary.state}, ${fmtDur(summary.durationSeconds)}, head ${summary.head?.slice(0, 9) ?? '?'}${summary.sourceDirty ? ' (source dirty)' : ''}, ports ${SIDECAR_PORT}/${DEV_PORT}.`,
    `Steps: ${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ')}.${summary.error ? ` Error: ${summary.error}` : ''}`,
    '',
    '| step | status | time | ok/FAIL | key numbers |',
    '|---|---|---|---|---|',
  ];
  for (const s of summary.steps) {
    const m = s.metrics ? Object.entries(s.metrics).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ') : '';
    lines.push(`| ${s.id} | ${s.status} | ${s.seconds != null ? fmtDur(s.seconds) : '-'} | ${s.ok ?? '-'}/${s.fail ?? '-'} | ${m.replace(/\|/g, '/')} |`);
  }
  const bad = summary.steps.filter((s) => ['FAIL', 'TIMEOUT', 'ERROR'].includes(s.status));
  if (bad.length) {
    lines.push('', '## Not passing', '');
    for (const s of bad) {
      lines.push(`- **${s.id}** ${s.status}${s.error ? `: ${s.error}` : ''} (log \`${s.log ?? '-'}\`)`);
      for (const l of s.failLines ?? s.tail ?? []) lines.push(`  - \`${l.replace(/`/g, "'").slice(0, 200)}\``);
    }
  }
  lines.push('', `Evidence: \`${OUT}\` (summary.json, runner.log, <step>.log, gate4d/ gate4e/ gate5b/ gate6a/ sim-*/, client.log).`, '');
  return lines.join('\n');
}

let notified = false;
function notify() {
  if (notified) return;
  notified = true;
  const c = summary.counts;
  const pass = c.PASS ?? 0;
  const notPass = (c.FAIL ?? 0) + (c.TIMEOUT ?? 0) + (c.ERROR ?? 0);
  const ok = summary.verdict === 'PASS';
  const parts = [`${pass} pass`, `${c.FAIL ?? 0} fail`, `${c.TIMEOUT ?? 0} timeout`];
  if (c.ERROR) parts.push(`${c.ERROR} error`);
  if (c.SKIPPED) parts.push(`${c.SKIPPED} skipped`);
  const failed = summary.steps.filter((s) => ['FAIL', 'TIMEOUT', 'ERROR'].includes(s.status)).map((s) => `${s.id} ${s.status}`);
  const message = `${ok ? '🟢' : '🔴'} Architect gate-run \`${summary.chain}\` ${summary.verdict}${summary.state !== 'done' ? ` (${summary.state})` : ''}: `
    + `${parts.join(', ')} of ${summary.steps.length} in ${fmtDur(summary.durationSeconds)} @ ${summary.head?.slice(0, 9) ?? '?'}`
    + `${failed.length ? `\nnot passing: ${failed.slice(0, 8).join(', ')}` : ''}\nsummary: ${path.join(OUT, 'SUMMARY.md')}`;
  const args = ok ? [message] : ['--critical', message];
  const record = { mode: NOTIFY_MODE, script: NOTIFY_SCRIPT, severity: ok ? 'routine' : 'critical', args, message, notPass };
  if (NOTIFY_MODE === 'dry') {
    console.log(`notify (dry run, not sent): ${JSON.stringify(record, null, 2)}`);
  } else if (NOTIFY_MODE === 'send') {
    const r = spawnSync(NOTIFY_SCRIPT, args, { encoding: 'utf8', timeout: 120_000, env: childEnv(OUT) });
    record.exit = r.status;
    record.stderr = (r.stderr ?? '').slice(0, 300);
    log(`notify ${record.severity}: exit ${r.status}${r.stderr ? ` ${r.stderr.trim().slice(0, 200)}` : ''}`);
  }
  fs.writeFileSync(path.join(OUT, 'notify.json'), JSON.stringify(record, null, 2));
}

async function finish(state, error) {
  summary.state = state;
  if (error) summary.error = error;
  summary.endedAt = new Date().toISOString();
  summary.durationSeconds = (Date.now() - t0) / 1000;
  for (const s of summary.steps) if (['PENDING', 'RUNNING'].includes(s.status)) s.status = 'SKIPPED';
  writeSummary();
  const c = summary.counts;
  summary.verdict = state === 'done' && (c.PASS ?? 0) === summary.steps.length && !error ? 'PASS' : 'FAIL';
  writeSummary();
  fs.writeFileSync(path.join(OUT, 'SUMMARY.md'), summaryMd());
  log(`${summary.verdict}: ${JSON.stringify(c)} in ${fmtDur(summary.durationSeconds)}; ${path.join(OUT, 'SUMMARY.md')}`);
  notify();
  releaseLock();
}

let finishing = false;
async function abort(why) {
  if (finishing) return;
  finishing = true;
  log(`aborting: ${why}`);
  if (activeGroup) {
    killGroup(activeGroup, 'SIGTERM');
    await sleep(3000);
    killGroup(activeGroup, 'SIGKILL');
  }
  await stopClient('abort').catch(() => killRunDir('abort'));
  cleanStrays();
  await finish('aborted', why);
  process.exit(1);
}
process.on('SIGINT', () => abort('SIGINT'));
process.on('SIGTERM', () => abort('SIGTERM'));
// unattended: a closed terminal (SIGHUP, EPIPE on stdout) must not end the run; everything also goes to runner.log
process.on('SIGHUP', () => log('SIGHUP ignored (unattended)'));
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
process.on('uncaughtException', (e) => abort(`uncaught: ${e?.stack ?? e}`));
process.on('unhandledRejection', (e) => abort(`unhandled: ${e?.stack ?? e}`));

// ------------------------------------------------------------------ main

try {
  // preflight: nothing else may use the run worktree or the ports, so everything killed later is ours
  const others = runDirProcs();
  if (others.length) throw new Error(`processes already use the run worktree (${others.map((p) => `${p.pid}`).join(', ')}); not ours, not touched`);
  for (const p of [SIDECAR_PORT, DEV_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use (set ARCHITECT_GATE_SIDECAR_PORT / ARCHITECT_GATE_DEV_PORT)`);
  log(`gate-run ${chainName}: ${steps.length} steps (${steps.map((s) => s.id).join(' ')}); run worktree ${RUN}; ports ${SIDECAR_PORT}/${DEV_PORT}; notify ${NOTIFY_MODE}`);
  await setup();
} catch (e) {
  if (summary.setup) summary.setup.status = 'ERROR';
  log(`setup failed: ${e.message}`);
  finishing = true;
  await finish('aborted', `setup: ${e.message}`);
  process.exit(1);
}

let stopped = false;
for (let i = 0; i < steps.length; i++) {
  const step = steps[i];
  const rec = summary.steps[i];
  if (step.after && stepIds.includes(step.after)) {
    const dep = summary.steps.find((s) => s.id === step.after);
    if (dep.status !== 'PASS') {
      rec.status = 'SKIPPED';
      rec.error = `needs ${step.after} (${dep.status})`;
      log(`== ${step.id}: SKIPPED (${rec.error})`);
      writeSummary();
      continue;
    }
  }
  await runStep(step, rec);
  writeSummary();
  if (step.stopOnFail && rec.status !== 'PASS') {
    log(`${step.id} is stopOnFail and ended ${rec.status}: stopping the chain`);
    stopped = true;
    break;
  }
}
finishing = true;
await stopClient('end of chain');
await finish(stopped ? 'stopped' : 'done');
process.exit(summary.verdict === 'PASS' ? 0 : 1);
