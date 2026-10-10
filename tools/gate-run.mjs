#!/usr/bin/env node
// Unattended gate runner (docs/GATES.md): runs a named chain, or a tier (change | slice | release), of gate steps from
// tools/gate-chains.json against dev clients in the runner's own run worktrees, with no agent watching. Non-interactive;
// per-step timeouts (a hung step is killed: its own process group, then its run worktree's processes only); continues past
// failures unless a step is `stopOnFail`; one lock; no notify unless asked (Noah: no Discord pings). No Claude: it refuses to
// start with Claude credentials in the environment, strips every ANTHROPIC_* / CLAUDE* variable from its children, and runs
// only the stub/sim client scripts.
//
//   node tools/gate-run.mjs <chain> [--shards N] [--only a,b] [--from step] [--plan]
//   node tools/gate-run.mjs change  --since <ref> | --range A...B | --files a,b [--shards N] [--plan]   unit suites + mapped steps
//   node tools/gate-run.mjs slice   --since <ref> | --range A...B | --files a,b [--shards N] [--plan]   quick + the affected steps
//   node tools/gate-run.mjs release [--release <tag>] [--since <ref>] [--shards N] [--plan]  everything, duplicates rotated
//   node tools/gate-run.mjs --list                  the chains and tiers
//   [--notify | --notify-dry-run]                   off by default (Noah: no Discord pings)
//
// --plan prints the selection (impact, rotation and what it skipped), the steps, clients, timeouts, resources, shards and an
// estimated wall time, and exits without running anything.
//
// Where it runs (flag, else environment, else default). Several agents share this machine: a second runner names its own.
//   --ports S:D[,S:D...]   GATE_PORTS     every shard's sidecar:DevBridge pair. Without it shard 1 is ARCHITECT_GATE_SIDECAR_PORT /
//                                         ARCHITECT_GATE_DEV_PORT (8890/8891) and shards 2.. come from GATE_SHARD_PORTS (no default:
//                                         a sharded run names its ports). 8892-8895 are never a shard's (old-version clients, eval).
//   --run-dir DIR          GATE_RUN_DIR   shard 1's run worktree (../architect-mc-gate-run); shard k is <DIR>-s<k>
//   --run-dirs A,B,C       GATE_RUN_DIRS  every shard's run worktree, explicitly
//   --out DIR              GATE_RUNS_OUT  where runs go (<main checkout>/artifacts/gate-runs)
//   --lock FILE            GATE_LOCK      the lock (<out>/gate-run.lock)
//   --seed-dir DIR         GATE_SEED_DIR  read-only source of .gradle-home, node_modules and the gate worlds (../architect-mc-6a-run)
//                          GATE_SNAPSHOT_DIR  prepared worlds restored by APFS clone (the seed's mod/run/saves)
//                          GATE_NOTIFY=send|dry, GATE_NOTIFY_SCRIPT (~/Developer/_infra/discord-notify.sh); off by default
//
// Shards (--shards N, at most shards.max): each has its own client, run worktree, port pair and evidence dir (<out>/s<k>/ when
// N > 1). Steps declare what they need: steps sharing a resource never overlap, a `bench` step (timing or MSPT bars) runs alone,
// a step with `after` runs on its dependency's shard, and a `stopOnFail` step is a barrier.
//
// Output: <out>/<timestamp>-<chain>/: summary.json (written at the start with state "running", rewritten after every step,
// final state "done" | "stopped" | "aborted"), SUMMARY.md, runner.log, <step>.log, the gates' own evidence under
// [s<k>/]gate4d/ gate4e/ gate5b/ gate6a/ sim-*/, client[-s<k>].log.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DevClient } from './lib/devclient.mjs';
import { changedFiles, describeImpact, impactOf, validateImpact } from './gate-impact.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(SRC, '..', 'architect-mc');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ arguments and config

const argv = process.argv.slice(2);
const VALUED = ['--config', '--only', '--from', '--since', '--range', '--files', '--release', '--shards', '--ports', '--run-dir', '--run-dirs', '--out', '--lock', '--seed-dir'];
const flag = (f) => argv.includes(f);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const CONFIG_PATH = path.resolve(opt('--config') ?? path.join(SRC, 'tools', 'gate-chains.json'));
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const TIERS = ['change', 'slice', 'release'];
const chainName = argv.find((a, i) => !a.startsWith('--') && !VALUED.includes(argv[i - 1]));
const ORDER = Object.keys(cfg.steps); // the canonical step order: chains and tiers run in it

const die = (m) => {
  console.error(`gate-run: ${m}`);
  process.exit(2);
};
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

if (flag('--list') || !chainName) {
  for (const [n, s] of Object.entries(cfg.chains)) console.log(`${n.padEnd(8)} ${s.length} steps: ${s.join(' ')}`);
  console.log('change   tier: the impacted unit suites + the impact map\'s change steps (--since <ref>)');
  console.log(`slice    tier: ${cfg.tiers.slice.base} + the impacted change and slice steps (--since <ref>)`);
  console.log('release  tier: everything, the duplicates rotated (--release <tag>; default key: the ISO week)');
  if (!chainName && !flag('--list')) {
    console.error('\nusage: node tools/gate-run.mjs <chain|change|slice|release> [--since ref | --range A...B] [--release tag] [--shards N] [--plan] [--only a,b] [--from step]');
    process.exit(2);
  }
  process.exit(0);
}
if (!cfg.chains[chainName] && !TIERS.includes(chainName)) die(`unknown chain ${chainName}; chains: ${Object.keys(cfg.chains).join(' ')}; tiers: ${TIERS.join(' ')}`);
{
  const bad = validateImpact(cfg.impact ?? {}, cfg.steps);
  for (const t of Object.values(cfg.tiers ?? {})) {
    for (const s of [...(t.fallback ?? []), ...(t.engineSlice ?? []), ...(t.always ?? []), ...(t.rotate ?? []).flatMap((r) => [...r.options.flat(), ...(r.when?.steps ?? [])])]) {
      if (!cfg.steps[s]) bad.push(`tiers: unknown step ${s}`);
    }
  }
  if (bad.length) die(`config: ${bad.join('; ')}`);
}

// ------------------------------------------------------------------ the selection: a chain, or a tier

/** ISO 8601 week number and its year. */
function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t - y0) / 86400000 + 1) / 7) };
}
const verParts = (t) => (t.match(/\d+/g) ?? []).map(Number);
const cmpVer = (a, b) => {
  const x = verParts(a);
  const y = verParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** The rotation key: --release <tag> -> the tag's index among the version-sorted v* tags (a tag not made yet counts where it
 * would sort); else the ISO week. Deterministic: the same release (or week) always picks the same rotation. */
function rotationKey() {
  const rel = opt('--release');
  if (rel) {
    const tags = git(SRC, 'tag', '--list', 'v*').split('\n').filter(Boolean);
    const index = tags.filter((t) => cmpVer(t, rel) < 0).length;
    return { key: index, source: `release ${rel} (index ${index} among ${tags.length} v* tags)` };
  }
  const w = isoWeek();
  return { key: w.week, source: `ISO week ${w.year}-W${String(w.week).padStart(2, '0')} (no --release)` };
}

function rangeArg() {
  if (opt('--files')) return null;
  if (opt('--range')) return opt('--range');
  if (opt('--since')) return `${opt('--since')}...HEAD`;
  return null;
}

/** -> { ids, info } where info describes the tier: impact, rotation (what it ran and skipped), notes. */
function select() {
  if (cfg.chains[chainName]) return { ids: [...cfg.chains[chainName]], info: { kind: 'chain' } };
  const info = { kind: 'tier', tier: chainName, notes: [] };
  const want = new Set();
  let range = rangeArg();
  if (chainName === 'release' && !range) {
    try {
      const last = git(SRC, 'describe', '--tags', '--abbrev=0', 'HEAD');
      range = `${last}...HEAD`;
    } catch {
      range = null;
    }
  }
  const listed = opt('--files') ? opt('--files').split(',').map((f) => f.trim()).filter(Boolean) : null;
  if (!range && !listed && chainName !== 'release') die(`${chainName} needs --since <ref> (e.g. origin/main), --range A...B or --files a,b`);
  let imp = null;
  if (range || listed) {
    const files = listed ?? changedFiles(SRC, range);
    imp = impactOf(files, cfg.impact ?? {});
    info.range = range ?? `--files (${files.length})`;
    info.impact = { files: imp.files, rules: Object.fromEntries(Object.entries(imp.rules).map(([k, v]) => [k, v.files.length])), unmapped: imp.unmapped, ignored: imp.ignored.length, tags: imp.tags };
    info.impactText = describeImpact(imp);
  }
  // release without a range (no tag yet): treated as engine- and placement-touching (the full measurements)
  const tags = new Set(imp ? imp.tags : ['engine', 'placement']);
  info.engine = tags.has('engine');
  info.placement = tags.has('placement');
  const t = cfg.tiers[chainName];
  if (chainName === 'change') {
    // the unit suites always (minutes), unless the diff is only ignored paths (docs): then nothing
    if (imp.files > imp.ignored.length) for (const s of t.always ?? []) want.add(s);
    for (const s of imp.change) want.add(s);
    if (imp.unmapped.length) {
      for (const s of t.fallback) want.add(s);
      info.notes.push(`unmapped files: the safe default added ${t.fallback.join(' ')}`);
    }
  } else if (chainName === 'slice') {
    // a diff of only ignored paths (docs) runs nothing, as for change
    if (imp.files > imp.ignored.length) for (const s of cfg.chains[t.base]) want.add(s);
    else info.notes.push(`only ignored paths (docs etc.): ${t.base} skipped`);
    for (const s of [...imp.change, ...imp.slice]) want.add(s);
    if (imp.unmapped.length) {
      for (const s of t.fallback ?? []) want.add(s);
      info.notes.push(`unmapped files: the safe default is ${t.base} (already in)`);
    }
    if (info.engine && t.engineSlice?.length) {
      for (const s of t.engineSlice) want.add(s);
      info.notes.push(`engine-touching: added ${t.engineSlice.join(' ')}`);
    } else if (info.engine) info.notes.push('engine-touching: mega-lite covers the slice; the full 1000x1000 megaA comes only with region code, megaB only at release');
  } else {
    const rk = rotationKey();
    info.rotationKey = rk.key;
    info.rotationSource = rk.source;
    info.rotation = [];
    for (const s of t.always) want.add(s);
    for (const r of t.rotate) {
      const all = [...new Set([...r.options.flat(), ...(r.when?.steps ?? [])])];
      let chosen;
      let reason;
      if (r.when && tags.has(r.when.tag)) {
        chosen = r.when.steps;
        reason = `${r.when.tag}-touching release`;
      } else {
        const i = rk.key % r.options.length;
        chosen = r.options[i];
        reason = r.options.length > 1 ? `rotation option ${i + 1}/${r.options.length} (key ${rk.key})` : `not ${r.when?.tag ?? ''}-touching`;
      }
      for (const s of chosen) want.add(s);
      const skipped = all.filter((s) => !chosen.includes(s));
      const next = {};
      for (const s of skipped) {
        const oi = r.options.findIndex((o) => o.includes(s));
        if (oi >= 0 && r.options.length > 1) next[s] = `key ${rk.key + ((oi - (rk.key % r.options.length) + r.options.length) % r.options.length || r.options.length)}`;
        else if (r.when?.steps.includes(s)) next[s] = `the next ${r.when.tag}-touching release`;
      }
      info.rotation.push({ name: r.name, why: r.why, ran: chosen, skipped, reason, next });
    }
    info.notes.push(...(t.notes ?? []));
  }
  // `after` dependencies come along (4e-crash needs 4e-orders' context)
  for (const s of [...want]) {
    const dep = cfg.steps[s].after;
    if (dep && !want.has(dep)) {
      want.add(dep);
      info.notes.push(`${s} needs ${dep}: added`);
    }
  }
  return { ids: ORDER.filter((s) => want.has(s)), info };
}

const sel = select();
let stepIds = sel.ids;
const tierInfo = sel.info;
if (opt('--only')) {
  const only = opt('--only').split(',');
  for (const s of only) if (!cfg.steps[s]) die(`--only: unknown step ${s}`);
  stepIds = cfg.chains[chainName] ? stepIds.filter((s) => only.includes(s)) : ORDER.filter((s) => only.includes(s));
}
if (opt('--from')) stepIds = stepIds.slice(Math.max(0, stepIds.indexOf(opt('--from'))));

const PLAN = flag('--plan') || flag('--dry-run');
// Notifications are off by default (Noah, 2026-10-09: no Discord pings); --notify or GATE_NOTIFY=send turns them on.
const NOTIFY_MODE = flag('--notify-dry-run') || process.env.GATE_NOTIFY === 'dry' ? 'dry' : flag('--notify') || process.env.GATE_NOTIFY === 'send' ? 'send' : 'off';
const NOTIFY_SCRIPT = process.env.GATE_NOTIFY_SCRIPT ?? path.join(os.homedir(), 'Developer', '_infra', 'discord-notify.sh');
const RUN1 = path.resolve(opt('--run-dir') ?? process.env.GATE_RUN_DIR ?? path.resolve(SRC, cfg.runDir));
const RUN_DIRS = (opt('--run-dirs') ?? process.env.GATE_RUN_DIRS ?? '').split(',').map((d) => d.trim()).filter(Boolean).map((d) => path.resolve(d));
const SEED = path.resolve(opt('--seed-dir') ?? process.env.GATE_SEED_DIR ?? path.resolve(SRC, cfg.seedFrom));
const snapDirCfg = cfg.snapshots?.dir ?? 'seed:mod/run/saves';
const SNAP = path.resolve(process.env.GATE_SNAPSHOT_DIR ?? (snapDirCfg.startsWith('seed:') ? path.join(SEED, snapDirCfg.slice(5)) : path.resolve(SRC, snapDirCfg)));
const RUNS_ROOT = path.resolve(opt('--out') ?? process.env.GATE_RUNS_OUT ?? path.join(MAIN, 'artifacts', 'gate-runs'));
const LOCK = path.resolve(opt('--lock') ?? process.env.GATE_LOCK ?? path.join(RUNS_ROOT, 'gate-run.lock'));
const NSHARDS = Number(opt('--shards') ?? 1);
if (!(Number.isInteger(NSHARDS) && NSHARDS >= 1 && NSHARDS <= (cfg.shards?.max ?? 3))) die(`--shards must be 1..${cfg.shards?.max ?? 3}`);

// ------------------------------------------------------------------ guards (before anything runs)

// credential-bearing variables: refuse. Routing/flag variables (ANTHROPIC_BASE_URL, CLAUDE_CODE_*) are only stripped below,
// so an agent's shell can launch the runner.
const CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK'];
const setCreds = CREDENTIALS.filter((k) => process.env[k]);
if (setCreds.length) die(`refusing to start: ${setCreds.join(', ')} set. Gate runs never call Claude; unset it (env -u ${setCreds[0]} node tools/gate-run.mjs ...).`);

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

// the shards: a run worktree, a port pair, an evidence dir each
// ports: --ports / GATE_PORTS lists every shard's pair (sidecar:dev, comma-separated); otherwise shard 1 is
// ARCHITECT_GATE_SIDECAR_PORT/ARCHITECT_GATE_DEV_PORT (default 8890/8891) and shards 2.. come from GATE_SHARD_PORTS. There is no
// default for shards 2..: several agents share this machine, so a sharded run names its ports.
const pairs = (s) => s.split(',').map((p) => p.trim()).filter(Boolean).map((p) => p.split(/[:/]/).map(Number));
const allPairs = opt('--ports') ?? process.env.GATE_PORTS;
const portPairs = allPairs ? pairs(allPairs)
  : [[Number(process.env.ARCHITECT_GATE_SIDECAR_PORT || 8890), Number(process.env.ARCHITECT_GATE_DEV_PORT || 8891)], ...(process.env.GATE_SHARD_PORTS ? pairs(process.env.GATE_SHARD_PORTS) : [])];
if (RUN_DIRS.length && RUN_DIRS.length < NSHARDS) die(`--run-dirs names ${RUN_DIRS.length} dirs for ${NSHARDS} shards`);
const shards = [];
for (let k = 1; k <= NSHARDS; k++) {
  const [sp, dp] = portPairs[k - 1] ?? [];
  if (!sp || !dp) die(`shard ${k}: no port pair. Name every shard's ports: --ports 8890:8891,8896:8897 (or GATE_PORTS)`);
  const RUN = RUN_DIRS.length ? RUN_DIRS[k - 1] : k === 1 ? RUN1 : `${RUN1}-s${k}`;
  shards.push({ k, tag: NSHARDS > 1 ? `[s${k}] ` : '', RUN, GAME_DIR: path.join(RUN, 'mod', 'run'), SIDECAR_PORT: sp, DEV_PORT: dp, current: null, activeGroup: null, ev: null });
}
const allPorts = shards.flatMap((s) => [s.SIDECAR_PORT, s.DEV_PORT]);
if (new Set(allPorts).size !== allPorts.length) die(`shard ports overlap: ${allPorts.join(' ')}`);
for (const p of allPorts) if (p >= 8892 && p <= 8895) die(`port ${p}: 8892-8895 belong to the gates' old-version clients and eval sidecars, never to a shard`);

// a run worktree is the runner's own: never the seed (architect-mc-6a-run), this checkout or the main checkout. The gate drivers
// find their client with an unanchored `pgrep -f <basename>/mod/.gradle/...`, so no run dir's name may end with another's.
// every sibling of a run dir counts (other agents' run worktrees live next to it)
const siblings = (d) => {
  try {
    return fs.readdirSync(path.dirname(d)).map((n) => path.join(path.dirname(d), n));
  } catch {
    return [];
  }
};
const knownRunDirs = [...new Set([...shards.map((s) => s.RUN), ...shards.flatMap((s) => siblings(s.RUN)), path.resolve(SRC, cfg.runDir), SEED])];
for (const sh of shards) {
  for (const [what, p] of [['the seed dir', SEED], ['this checkout', SRC], ['the main checkout', MAIN], ['architect-mc-6a-run', path.resolve(SRC, '..', 'architect-mc-6a-run')]]) {
    if (real(sh.RUN) === real(p)) die(`refusing: the run dir ${sh.RUN} is ${what}`);
  }
  if (real(sh.RUN).startsWith(real(SRC) + path.sep)) die(`refusing: the run dir ${sh.RUN} is inside this checkout`);
  for (const o of knownRunDirs) {
    const a = path.basename(sh.RUN);
    const b = path.basename(o);
    if (a !== b && (a.endsWith(b) || b.endsWith(a))) die(`refusing: run dir ${a} and ${b} end with one another (the drivers' pgrep would match both)`);
  }
}

// steps: only $0 commands; clients: only the stub/sim scripts
const PAID = /(-real\b|--tier\s+(smoke|full)\b|--backend\s+claude\b|--use-claude-login\b|\bpaid\b)/;
const SAFE_CLIENTS = new Set(['tools/run-gate4d-client.sh', 'tools/run-gate4e-client.sh', 'tools/run-gate5b-client.sh', 'tools/run-gate6a-client.sh']);
for (const id of stepIds) {
  const s = cfg.steps[id];
  if (!s) die(`chain ${chainName}: unknown step ${id}`);
  const text = s.shell ?? (s.cmd ?? []).join(' ');
  if (PAID.test(text)) die(`refusing: step ${id} looks like a paid/Claude run: ${text}`);
  if (!['none', 'self'].includes(s.client) && !cfg.clients[s.client]) die(`step ${id}: unknown client ${s.client}`);
  for (const w of s.restore ?? []) if (/[/\\]|^\.\.?$/.test(w)) die(`step ${id}: restore names a path, not a world: ${w}`);
}
for (const [k, c] of Object.entries(cfg.clients)) if (!SAFE_CLIENTS.has(c.script)) die(`client ${k}: ${c.script} is not a stub/sim client script`);

// ------------------------------------------------------------------ helpers

const fmtDur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s.toFixed(0)}s`);

/** Every process whose command line names the shard's run worktree (gradle, the client JVM, the sidecar), minus this one. */
function runDirProcs(sh) {
  const r = spawnSync('ps', ['-axww', '-o', 'pid=,pgid=,command='], { encoding: 'utf8' });
  const needles = [...new Set([sh.RUN, real(sh.RUN)])].map((p) => p + path.sep);
  return r.stdout.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, pgid, cmd]) => ({ pid: Number(pid), pgid: Number(pgid), cmd }))
    .filter((p) => p.pid !== process.pid && needles.some((n) => p.cmd.includes(n)));
}
/** The processes the runner and the gates start in the shard's run worktree: gradle and its daemon/workers, the client JVM,
 * the sidecar, vitest, the client scripts. Only these are ever killed (an observer such as `tail -f <run>/...` is not). */
function ownProcs(sh) {
  const marks = [...new Set([sh.RUN, real(sh.RUN)])].flatMap((r) => ['/mod/.gradle/loom-cache/launch.cfg', '/mod/gradle/wrapper/', '/.gradle-home/',
    '/sidecar/dist/', '/sidecar/node_modules/', '/tools/run-'].map((m) => r + m));
  return runDirProcs(sh).filter((p) => marks.some((m) => p.cmd.includes(m)));
}
const clientProcs = (sh) => runDirProcs(sh).filter((p) => p.cmd.includes('/mod/.gradle/loom-cache/launch.cfg'));
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

/** The children's environment: no ANTHROPIC_* / CLAUDE* at all, the shard's paths and ports, its evidence dirs. */
function childEnv(sh, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE)/.test(k) || k === 'ARCHITECT_DEV_TOKEN' || k === 'AWS_BEARER_TOKEN_BEDROCK') continue;
    env[k] = v;
  }
  const OUT = sh.ev;
  Object.assign(env, {
    ARCHITECT_PORT: String(sh.SIDECAR_PORT), ARCHITECT_DEV_PORT: String(sh.DEV_PORT),
    ARCHITECT_GAME_DIR: sh.GAME_DIR, APITEST_GAME_DIR: sh.GAME_DIR,
    GATE4E_RUN: sh.RUN, GATE5B_RUN: sh.RUN, GATE6A_RUN: sh.RUN,
    GATE4D_OUT: path.join(OUT, 'gate4d'), GATE4E_OUT: path.join(OUT, 'gate4e'), GATE5B_OUT: path.join(OUT, 'gate5b'), GATE6A_OUT: path.join(OUT, 'gate6a'),
    ARCHITECT_SHOTS_DIR: path.join(OUT, 'shots'),
    JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25',
    GATE_RUNNER: '1',
    // eval sidecars (if a step starts one) on an ephemeral port, never the fixed 8894/8895 another run may hold
    ARCHITECT_EVAL_PORT: process.env.ARCHITECT_EVAL_PORT ?? '0',
  });
  for (const [k, v] of Object.entries(extra)) env[k] = expand(String(v), sh);
  return env;
}
const expand = (s, sh) => s.replace(/\$\{(\w+)\}/g, (_, n) => ({ RUN: sh.RUN, SRC, MAIN, OUT: sh.ev })[n] ?? '');
const resolveCwd = (c, sh) => (!c ? SRC : c.startsWith('run:') ? path.join(sh.RUN, c.slice(4)) : c.startsWith('src:') ? path.join(SRC, c.slice(4)) : path.resolve(SRC, c));
const getPath = (obj, p) => p.split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);

// ------------------------------------------------------------------ the schedule (shared by --plan's estimate and the run)

const steps = stepIds.map((id) => ({ id, ...cfg.steps[id] }));
const famOf = (key) => (key && cfg.clients[key] ? cfg.clients[key].family ?? key : null);
const isBench = (s) => (s.resources ?? []).includes('bench');

/**
 * The next step shard `sh` may start, or null. st: { pending: [index], running: Map(index -> shardK), done: Map(id -> {status,
 * shard}) }. Rules: a stopOnFail step earlier in the order is a barrier until it is done; `after` waits for its dependency and
 * runs on the dependency's shard; steps sharing a resource never overlap. One shard runs the order exactly. Sharded, a bench
 * step (timing or MSPT bars) waits until every other step has started and the running ones have drained, then runs alone; among
 * the other ready steps a shard prefers the one its current client serves (no restart).
 */
function pick(sh, st, all) {
  const runningSteps = [...st.running.keys()].map((i) => steps[i]);
  if (runningSteps.some(isBench)) return null;
  const held = new Set(runningSteps.flatMap((s) => (s.resources ?? []).filter((r) => r !== 'bench')));
  const ready = [];
  for (const i of st.pending) {
    const s = steps[i];
    if (steps.some((b, j) => j < i && b.stopOnFail && !st.done.has(b.id))) continue;
    if (s.after && stepIds.includes(s.after)) {
      const d = st.done.get(s.after);
      if (!d || d.shard !== sh.k) continue;
    }
    if ((s.resources ?? []).some((r) => held.has(r))) continue;
    ready.push(i);
  }
  if (!ready.length) return null;
  if (all.length === 1) return ready[0]; // one shard: the chain order, exactly
  // sharded: bench steps go after every other step has started, then one at a time with nothing else running
  const rest = ready.filter((i) => !isBench(steps[i]));
  if (!rest.length) {
    if (st.pending.some((i) => !isBench(steps[i])) || st.running.size) return null;
    return ready[0];
  }
  // prefer: the client already up here; then no client / its own clients; then a client family no other shard has up (the
  // shard that has it takes those); ties in order
  const fam = famOf(sh.current);
  const elsewhere = new Set(all.filter((o) => o.k !== sh.k).map((o) => famOf(o.current)).filter(Boolean));
  const score = (i) => {
    const f = famOf(steps[i].client);
    return fam && f === fam ? 0 : !f ? 1 : !elsewhere.has(f) ? 2 : 3;
  };
  let best = null;
  for (const i of rest) if (best === null || score(i) < score(best)) best = i;
  return best;
}

/** --plan's estimate: the schedule with every step taking its estMin (measured) and passing; client starts ~0.35 min (0.15 for a world switch). */
function estimate() {
  const st = { pending: steps.map((_, i) => i), running: new Map(), done: new Map() };
  const sim = shards.map((s) => ({ k: s.k, current: null, freeAt: 0 }));
  const ends = [];
  const assign = {};
  let now = 0;
  for (let guard = 0; guard < 10_000 && (st.pending.length || st.running.size); guard++) {
    for (const sh of sim) {
      if (sh.freeAt > now) continue;
      const i = pick(sh, st, sim);
      if (i === null) continue;
      const s = steps[i];
      st.pending.splice(st.pending.indexOf(i), 1);
      st.running.set(i, sh.k);
      if (sim.length > 1 && isBench(s)) for (const o of sim) if (o !== sh) o.current = null; // the run stops idle clients for a bench step
      const start = (s.client === 'none' || s.client === 'self') ? 0 : sh.current === s.client && !s.restartClient ? 0 : famOf(sh.current) === famOf(s.client) && !s.restartClient ? 0.15 : 0.35;
      sh.current = s.client === 'none' || s.client === 'self' ? null : s.client;
      sh.freeAt = now + start + (s.estMin ?? s.timeoutMin);
      ends.push({ i, at: sh.freeAt, k: sh.k });
      assign[s.id] = sh.k;
    }
    ends.sort((a, b) => a.at - b.at);
    const e = ends.shift();
    if (!e) break;
    now = e.at;
    st.running.delete(e.i);
    st.done.set(steps[e.i].id, { status: 'PASS', shard: e.k });
  }
  const serial = steps.reduce((a, s) => a + (s.estMin ?? s.timeoutMin), 0);
  return { wallMin: now, serialMin: serial, assign };
}

// ------------------------------------------------------------------ the plan

const totalTimeout = steps.reduce((a, s) => a + s.timeoutMin, 0);

function printSelection() {
  if (tierInfo.kind !== 'tier') return;
  console.log(`tier ${tierInfo.tier}${tierInfo.range ? ` over ${tierInfo.range}` : ' (no range: no release tag reachable)'}; engine-touching ${tierInfo.engine ? 'yes' : 'no'}, placement-touching ${tierInfo.placement ? 'yes' : 'no'}`);
  if (tierInfo.impactText) console.log(tierInfo.impactText.split('\n').map((l) => `  ${l}`).join('\n'));
  if (tierInfo.rotation) {
    console.log(`rotation key ${tierInfo.rotationKey}: ${tierInfo.rotationSource}`);
    for (const r of tierInfo.rotation) {
      console.log(`  ${r.name}: runs ${r.ran.join(' ') || '(nothing)'} (${r.reason})${r.skipped.length ? `; SKIPPED ${r.skipped.map((s) => `${s} (next: ${r.next[s] ?? '-'})`).join(', ')}` : ''}`);
    }
  }
  for (const n of tierInfo.notes ?? []) console.log(`  note: ${n}`);
}

function printPlan() {
  const head = git(SRC, 'rev-parse', '--short', 'HEAD');
  printSelection();
  console.log(`${tierInfo.kind === 'tier' ? 'tier' : 'chain'} ${chainName}: ${steps.length} steps, worst case ${fmtDur(totalTimeout * 60)} of step timeouts (+ client starts, ${cfg.clientStartMin} min cap each)`);
  console.log(`source ${SRC} @ ${head}${git(SRC, 'status', '--porcelain', '--untracked-files=no') ? ' (DIRTY: the drivers run from the working tree, the clients from HEAD)' : ''}`);
  for (const sh of shards) {
    const missing = (cfg.seed ?? []).filter((s) => !fs.existsSync(path.join(sh.RUN, s)));
    console.log(`shard ${sh.k}: run worktree ${sh.RUN} ${fs.existsSync(sh.RUN) ? '(exists; checked out --detach at the source HEAD)' : '(created: git worktree add --detach)'}; ports sidecar ${sh.SIDECAR_PORT}, DevBridge ${sh.DEV_PORT}; `
      + `seed ${missing.length ? `would clone ${missing.join(', ')}` : 'nothing missing'}`);
  }
  console.log(`seed ${SEED} (read-only, APFS clones); snapshots ${SNAP}; artifacts ${RUNS_ROOT}/<timestamp>-${chainName}/; lock ${LOCK}; notify ${NOTIFY_MODE}`);
  console.log('setup (each shard): sidecar npm run build (run worktree)');
  const est = estimate();
  let cur = null;
  steps.forEach((s, i) => {
    let clientNote = '';
    if (NSHARDS === 1) {
      if (s.client === 'none' || s.client === 'self') {
        if (cur) clientNote = `stop client ${cur}; `;
        cur = null;
        if (s.client === 'self') clientNote += 'step starts/stops its own clients; ';
      } else if (cur !== s.client || s.restartClient) {
        const c = cfg.clients[s.client];
        const sw = cur && !s.restartClient && famOf(cur) === famOf(s.client);
        clientNote = sw ? `switch client ${cur} -> ${s.client} ("${c.world}", same process); ` : `${cur ? `stop client ${cur}; ` : ''}start client ${s.client} (${c.script} in "${c.world}"); `;
        cur = s.client;
      }
    } else clientNote = `client ${s.client}; `;
    const cmd = s.shell ?? s.cmd.join(' ');
    const tags = [s.stopOnFail ? 'stopOnFail' : '', isBench(s) ? 'bench' : '', ...(s.resources ?? []).filter((r) => r !== 'bench'), s.after ? `after ${s.after}` : '',
      s.restore ? `restore ${s.restore.map((w) => `"${w}"`).join(',')}` : ''].filter(Boolean).join(', ');
    console.log(`${String(i + 1).padStart(2)}. ${s.id.padEnd(19)} ~${String(s.estMin ?? '?').padStart(4)} / ${String(s.timeoutMin).padStart(3)} min${NSHARDS > 1 ? ` s${est.assign[s.id]}` : ''}  ${clientNote}${cmd}${tags ? `  [${tags}]` : ''}`);
  });
  if (NSHARDS === 1 && cur) console.log(`    end: stop client ${cur}`);
  console.log(`estimate: ~${fmtDur(est.wallMin * 60)} wall on ${NSHARDS} shard(s) (serial sum of the measured step times ~${fmtDur(est.serialMin * 60)}; client starts ~40 s each)`);
}

if (!steps.length) {
  printSelection();
  console.log(`${chainName}: nothing to run (${tierInfo.kind === 'tier' ? 'the diff maps to no gate step' : 'empty selection'}).`);
  process.exit(0);
}

if (PLAN) {
  printPlan();
  for (const sh of shards) {
    const busy = [];
    for (const p of [sh.SIDECAR_PORT, sh.DEV_PORT]) if (!(await portFree(p))) busy.push(p);
    const procs = runDirProcs(sh);
    console.log(`preflight now, shard ${sh.k}: ports ${busy.length ? `BUSY ${busy.join(',')}` : 'free'}; processes in its run worktree: ${procs.length ? procs.map((p) => p.pid).join(',') : 'none'}`);
  }
  process.exit(0);
}

// ------------------------------------------------------------------ the lock

fs.mkdirSync(RUNS_ROOT, { recursive: true });
fs.mkdirSync(path.dirname(LOCK), { recursive: true });
function takeLock() {
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, chain: chainName, startedAt: new Date().toISOString(), runDirs: shards.map((s) => s.RUN), ports: allPorts, out: RUNS_ROOT }), { flag: 'wx' });
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
for (const sh of shards) {
  sh.ev = NSHARDS > 1 ? path.join(OUT, `s${sh.k}`) : OUT;
  sh.clientLog = path.join(OUT, NSHARDS > 1 ? `client-s${sh.k}.log` : 'client.log');
  fs.mkdirSync(path.join(sh.ev, 'shots'), { recursive: true });
}
fs.writeFileSync(path.join(OUT, 'runner.pid'), String(process.pid));
const t0 = Date.now();
const LOGF = path.join(OUT, 'runner.log');
const log = (m, sh) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${sh?.tag ?? ''}${m}`;
  console.log(line);
  fs.appendFileSync(LOGF, line + '\n');
};

const summary = {
  chain: chainName, state: 'running', verdict: null, runnerPid: process.pid, startedAt: new Date(t0).toISOString(), endedAt: null, durationSeconds: null,
  source: SRC, head: null, sourceDirty: null, runDir: shards[0].RUN, lock: LOCK, ports: { sidecar: shards[0].SIDECAR_PORT, dev: shards[0].DEV_PORT }, out: OUT, notify: NOTIFY_MODE,
  shards: shards.map((s) => ({ k: s.k, runDir: s.RUN, ports: { sidecar: s.SIDECAR_PORT, dev: s.DEV_PORT }, evidence: path.relative(OUT, s.ev) || '.' })),
  tier: tierInfo.kind === 'tier' ? { name: tierInfo.tier, range: tierInfo.range ?? null, engine: tierInfo.engine, placement: tierInfo.placement, impact: tierInfo.impact ?? null,
    rotationKey: tierInfo.rotationKey ?? null, rotationSource: tierInfo.rotationSource ?? null, rotation: tierInfo.rotation ?? null, notes: tierInfo.notes } : null,
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

/** SIGTERM, then SIGKILL, the shard's run-worktree gradle/client/sidecar/vitest processes (all started by this run: preflight
 * found nothing using the worktree). */
async function killRunDir(sh, why) {
  let ps = ownProcs(sh);
  if (!ps.length) return;
  log(`  killing run-worktree processes (${why}): ${ps.map((p) => p.pid).join(' ')}`, sh);
  for (const p of ps) try { process.kill(p.pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 30 && (ps = ownProcs(sh)).length; i++) await sleep(1000);
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

function cleanStrays(sh) {
  // apijars copies apitest jars into the run client's mods/ and removes them in a finally that a kill skips
  const mods = path.join(sh.GAME_DIR, 'mods');
  if (!fs.existsSync(mods)) return;
  for (const f of fs.readdirSync(mods)) {
    if (/^architect_apitest-.*\.jar$/.test(f)) {
      fs.rmSync(path.join(mods, f), { force: true });
      log(`  removed stray ${f} from the run client's mods/`, sh);
    }
  }
}

// ------------------------------------------------------------------ the client

async function connectDev(sh, timeoutMs) {
  const tokenFile = path.join(sh.GAME_DIR, 'architect', 'devbridge.token');
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      return await DevClient.connect({ port: sh.DEV_PORT, token, timeoutMs: 10_000 });
    } catch (e) {
      last = e;
    }
    await sleep(2000);
  }
  throw new Error(`no DevBridge on ${sh.DEV_PORT}: ${last?.message ?? last}`);
}

async function stopClient(sh, why = 'switch') {
  if (!ownProcs(sh).length) {
    sh.current = null;
    return;
  }
  if (clientProcs(sh).length) {
    log(`  stopping client ${sh.current ?? '(started by a step)'} (${why})`, sh);
    try {
      const dev = await connectDev(sh, 10_000);
      await dev.call('dev.quit', {}, { timeoutMs: 30_000 }).catch(() => null);
      dev.close();
    } catch {
      // not answering: by PID below
    }
    for (let i = 0; i < 120 && clientProcs(sh).length; i++) await sleep(1000);
  }
  await sleep(2000);
  await killRunDir(sh, `after ${why}`);
  sh.current = null;
}

/** Waits until the client is in a world and ready, its chunks loaded. */
async function waitReady(sh, dev, end) {
  while (Date.now() < end) {
    const st = await dev.call('dev.state').catch(() => ({}));
    if (st.inWorld && st.ready) {
      await dev.call('dev.waitChunks', { timeoutMs: 60_000 }, { timeoutMs: 90_000 }).catch(() => {});
      await sleep(3000);
      return;
    }
    await sleep(1000);
  }
  throw new Error(`client not in a world within ${cfg.clientStartMin} min`);
}

async function leaveWorld(dev) {
  const st = await dev.call('dev.state').catch(() => ({}));
  if (!st.inWorld) return;
  await dev.call('dev.world.leave', {}, { timeoutMs: 300_000 });
  for (let i = 0; i < 600; i++) {
    if (!(await dev.call('dev.state')).inWorld) return;
    await sleep(500);
  }
  throw new Error('still in the world');
}

async function startClient(sh, key) {
  const c = cfg.clients[key];
  const world = c.world;
  log(`  starting client ${key}: ${c.script} in "${world}"`, sh);
  const opts = path.join(sh.GAME_DIR, 'options.txt');
  if (fs.existsSync(opts)) fs.writeFileSync(opts, fs.readFileSync(opts, 'utf8').replace(/^enableVsync:true$/m, 'enableVsync:false'));
  fs.rmSync(path.join(sh.GAME_DIR, 'architect', 'devbridge.token'), { force: true });
  const out = fs.openSync(sh.clientLog, 'a');
  fs.writeSync(out, `\n===== ${new Date().toISOString()} start ${key} (${c.script}, "${world}")\n`);
  const child = spawn(path.join(sh.RUN, c.script), c.args ?? [], { cwd: sh.RUN, detached: true, stdio: ['ignore', out, out],
    env: childEnv(sh, { ...(c.env ?? {}), ARCHITECT_AUTOWORLD_NAME: world }) });
  child.unref();
  let exited = null;
  child.on('exit', (code) => (exited = code));
  const end = Date.now() + cfg.clientStartMin * 60_000;
  let dev = null;
  while (Date.now() < end && exited === null) {
    try {
      dev = await connectDev(sh, 5_000);
      break;
    } catch {
      await sleep(3000);
    }
  }
  if (!dev) throw new Error(exited !== null ? `client script exited ${exited} before the DevBridge came up (${path.basename(sh.clientLog)})` : `no DevBridge within ${cfg.clientStartMin} min`);
  try {
    await waitReady(sh, dev, end);
    sh.current = key;
    log(`  client ${key} up in "${world}" (pids ${clientProcs(sh).map((p) => p.pid).join(' ')})`, sh);
  } finally {
    dev.close();
  }
}

/** A client of the same family (same sidecar kind, same mods) serves the next step by opening its world: no restart. */
async function switchClient(sh, key) {
  const c = cfg.clients[key];
  log(`  switching client ${sh.current} -> ${key}: same process, opening "${c.world}"`, sh);
  const dev = await connectDev(sh, 30_000);
  try {
    await leaveWorld(dev);
    await dev.call('dev.world.open', { name: c.world }, { timeoutMs: 60_000 });
    await waitReady(sh, dev, Date.now() + cfg.clientStartMin * 60_000);
    sh.current = key;
  } finally {
    dev.close();
  }
}

/** Gets the step its client: keeps the one that is up (same client, or the same family by switching worlds), else starts it.
 * `beforeStart` runs with no client up, right before a start. -> true when a running client was reused. */
async function ensureClient(sh, step, beforeStart = async () => {}) {
  if (step.client === 'none' || step.client === 'self') {
    if (ownProcs(sh).length) await stopClient(sh, `before ${step.id}`);
    await beforeStart();
    return false;
  }
  const up = clientProcs(sh).length > 0;
  if (up && sh.current === step.client && !step.restartClient) return true;
  if (up && sh.current && !step.restartClient && famOf(sh.current) === famOf(step.client)) {
    try {
      await switchClient(sh, step.client);
      return true;
    } catch (e) {
      log(`  switch failed (${e.message}): restarting the client`, sh);
    }
  }
  if (ownProcs(sh).length) await stopClient(sh, `before ${step.id}`);
  await beforeStart();
  await startClient(sh, step.client);
  return false;
}

/** Prepared worlds back from the snapshot store (APFS clone): no regeneration, and nothing an earlier step left in them. The
 * client's own world is never replaced under it; with a client up, the restore happens on the title screen. */
async function restoreWorlds(sh, step) {
  const own = cfg.clients[step.client]?.world;
  const worlds = (step.restore ?? []).filter((w) => w !== own);
  if (!worlds.length) return;
  const saves = path.join(sh.GAME_DIR, 'saves');
  const up = clientProcs(sh).length > 0;
  let dev = null;
  if (up) {
    dev = await connectDev(sh, 30_000);
    await leaveWorld(dev);
  }
  try {
    const t = Date.now();
    const done = [];
    for (const w of worlds) {
      const src = path.join(SNAP, w);
      const dst = path.join(saves, w);
      if (!fs.existsSync(path.join(src, 'level.dat'))) {
        log(`  snapshot "${w}" missing in ${SNAP}: the step makes it`, sh);
        continue;
      }
      if (!dst.startsWith(saves + path.sep)) throw new Error(`refusing to replace ${dst}`);
      fs.rmSync(dst, { recursive: true, force: true });
      execFileSync('cp', ['-c', '-R', src, dst]);
      fs.rmSync(path.join(dst, 'session.lock'), { force: true });
      done.push(w);
    }
    if (done.length) log(`  restored ${done.map((w) => `"${w}"`).join(', ')} from snapshots in ${((Date.now() - t) / 1000).toFixed(1)} s`, sh);
  } finally {
    if (dev) {
      await dev.call('dev.world.open', { name: cfg.clients[sh.current]?.world ?? own }, { timeoutMs: 60_000 });
      await waitReady(sh, dev, Date.now() + cfg.clientStartMin * 60_000);
      dev.close();
    }
  }
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

function runProcess(sh, step, logFile) {
  return new Promise((resolve) => {
    const fd = fs.openSync(logFile, 'a');
    const env = childEnv(sh, step.env ?? {});
    const cwd = resolveCwd(step.cwd, sh);
    const [cmd, args] = step.shell ? ['/bin/zsh', ['-c', step.shell]] : [step.cmd[0], step.cmd.slice(1)];
    fs.writeSync(fd, `# ${new Date().toISOString()} ${step.shell ?? step.cmd.join(' ')}  (cwd ${cwd}, shard ${sh.k}, ports ${sh.SIDECAR_PORT}/${sh.DEV_PORT})\n`);
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`  TIMEOUT after ${step.timeoutMin} min: killing step group ${child.pid}`, sh);
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
    sh.activeGroup = child.pid;
  });
}

async function runStep(sh, step, rec) {
  const logFile = path.join(OUT, `${step.id}.log`);
  rec.log = path.relative(OUT, logFile);
  rec.status = 'RUNNING';
  rec.shard = sh.k;
  rec.startedAt = new Date().toISOString();
  writeSummary();
  const ts = Date.now();
  log(`== ${step.id}: ${step.desc ?? ''}`, sh);
  for (const [to, from] of Object.entries(step.links ?? {})) {
    const dst = path.join(sh.ev, to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (!fs.existsSync(dst)) fs.symlinkSync(expand(from, sh), dst);
  }
  try {
    // the restore is cheapest with no client up (before it starts); a reused client goes to the title screen for it
    const reused = await ensureClient(sh, step, () => restoreWorlds(sh, step));
    if (reused) await restoreWorlds(sh, step);
  } catch (e) {
    rec.status = 'ERROR';
    rec.error = `client: ${e.message}`;
    rec.seconds = (Date.now() - ts) / 1000;
    log(`  ERROR ${rec.error}`, sh);
    await stopClient(sh, 'client start failed');
    return rec;
  }
  rec.setupSeconds = (Date.now() - ts) / 1000;
  const r = await runProcess(sh, step, logFile);
  sh.activeGroup = null;
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
    const j = junitCounts(resolveCwd(step.junit, sh));
    if (j) Object.assign(metrics, { tests: j.tests, failures: j.failures + j.errors, skipped: j.skipped });
  }
  for (const [k, spec] of Object.entries(step.metrics ?? {})) {
    const [file, p] = spec.split('#');
    const f = path.join(sh.ev, file);
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
  log(`  ${rec.status} ${step.id} in ${fmtDur(rec.seconds)} (exit ${r.code}${r.signal ? ` ${r.signal}` : ''}, ok ${rec.ok}, FAIL ${rec.fail})${rec.metrics ? ` ${JSON.stringify(rec.metrics)}` : ''}`, sh);
  // a killed or failed step may leave a client in any state (or one it started itself): stop it, the next step starts fresh
  if (rec.status !== 'PASS' || step.client === 'self') {
    await stopClient(sh, `${step.id} ${rec.status}`);
    if (rec.status === 'TIMEOUT') cleanStrays(sh);
  }
  return rec;
}

// ------------------------------------------------------------------ setup: the run worktrees

async function setupShard(sh, head) {
  const rec = { status: 'RUNNING', shard: sh.k };
  const ts = Date.now();
  const setupLog = path.join(OUT, NSHARDS > 1 ? `setup-s${sh.k}.log` : 'setup.log');
  const shx = (cmd, args, cwd) => {
    const r = spawnSync(cmd, args, { cwd, env: childEnv(sh), encoding: 'utf8' });
    fs.appendFileSync(setupLog, `# ${cmd} ${args.join(' ')} (cwd ${cwd}) -> ${r.status}\n${r.stdout ?? ''}${r.stderr ?? ''}\n`);
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}); ${path.basename(setupLog)}`);
    return r.stdout;
  };
  const RUN = sh.RUN;
  if (!fs.existsSync(RUN)) {
    log(`setup: git worktree add --detach ${RUN} ${head.slice(0, 7)}`, sh);
    shx('git', ['-C', SRC, 'worktree', 'add', '--detach', RUN, head], SRC);
  } else {
    if (git(RUN, 'rev-parse', '--git-common-dir') && real(path.resolve(RUN, git(RUN, 'rev-parse', '--git-common-dir'))) !== real(path.resolve(SRC, git(SRC, 'rev-parse', '--git-common-dir')))) {
      throw new Error(`${RUN} is not a worktree of this repository`);
    }
    if (git(RUN, 'status', '--porcelain', '--untracked-files=no')) throw new Error(`${RUN} has modified tracked files; refusing to check out over them`);
    shx('git', ['-C', RUN, 'checkout', '-q', '--detach', head], SRC);
  }
  rec.head = git(RUN, 'rev-parse', '--short', 'HEAD');
  rec.seeded = [];
  for (const item of cfg.seed ?? []) {
    const dst = path.join(RUN, item);
    if (fs.existsSync(dst)) continue;
    const src = path.join(SEED, item);
    if (!fs.existsSync(src)) throw new Error(`seed ${src} missing`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    log(`setup: cloning ${item} from ${SEED} (APFS clone, read-only source)`, sh);
    shx('cp', ['-c', '-R', src, dst], RUN);
    rec.seeded.push(item);
    if (item === 'mod/run') {
      // the seed's runtime state must not carry over: its token, its sidecar/launcher PIDs, stray apitest jars
      for (const f of ['architect/devbridge.token', 'architect/sidecar-data/sidecar.json', 'architect/sidecar-data/launcher.json']) fs.rmSync(path.join(dst, f), { force: true });
      cleanStrays(sh);
    }
  }
  log('setup: sidecar npm run build', sh);
  shx('npm', ['run', 'build'], path.join(RUN, 'sidecar'));
  rec.status = 'PASS';
  rec.seconds = (Date.now() - ts) / 1000;
  return rec;
}

// ------------------------------------------------------------------ the end: summary, notify

function summaryMd() {
  const c = summary.counts;
  const lines = [
    `# Gate run ${summary.chain}: ${summary.verdict}`,
    '',
    `${summary.state}, ${fmtDur(summary.durationSeconds)}, head ${summary.head?.slice(0, 9) ?? '?'}${summary.sourceDirty ? ' (source dirty)' : ''}, `
      + `${shards.map((s) => `${NSHARDS > 1 ? `s${s.k} ` : ''}ports ${s.SIDECAR_PORT}/${s.DEV_PORT}`).join(', ')}.`,
    `Steps: ${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ')}.${summary.error ? ` Error: ${summary.error}` : ''}`,
  ];
  const t = summary.tier;
  if (t) {
    lines.push('', `Tier **${t.name}**${t.range ? ` over \`${t.range}\`` : ''}: engine-touching ${t.engine ? 'yes' : 'no'}, placement-touching ${t.placement ? 'yes' : 'no'}`
      + `${t.impact ? `; ${t.impact.files} files, rules ${Object.keys(t.impact.rules).join(', ') || '-'}${t.impact.unmapped.length ? `, ${t.impact.unmapped.length} UNMAPPED` : ''}` : ''}.`);
    if (t.rotation) {
      lines.push(`Rotation key ${t.rotationKey} (${t.rotationSource}):`);
      for (const r of t.rotation) lines.push(`- ${r.name}: ran ${r.ran.join(' ') || '(nothing)'} (${r.reason})${r.skipped.length ? `; skipped ${r.skipped.map((s) => `${s} (next: ${r.next[s] ?? '-'})`).join(', ')}` : ''}`);
    }
    for (const n of t.notes ?? []) lines.push(`- ${n}`);
  }
  lines.push('', `| step | ${NSHARDS > 1 ? 'shard | ' : ''}status | time | ok/FAIL | key numbers |`, `|---|${NSHARDS > 1 ? '---|' : ''}---|---|---|---|`);
  for (const s of summary.steps) {
    const m = s.metrics ? Object.entries(s.metrics).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ') : '';
    lines.push(`| ${s.id} | ${NSHARDS > 1 ? `${s.shard ?? '-'} | ` : ''}${s.status} | ${s.seconds != null ? fmtDur(s.seconds) : '-'} | ${s.ok ?? '-'}/${s.fail ?? '-'} | ${m.replace(/\|/g, '/')} |`);
  }
  const bad = summary.steps.filter((s) => ['FAIL', 'TIMEOUT', 'ERROR', 'SKIPPED'].includes(s.status));
  if (bad.length) {
    lines.push('', '## Not passing', '');
    for (const s of bad) {
      lines.push(`- **${s.id}** ${s.status}${s.error ? `: ${s.error}` : ''} (log \`${s.log ?? '-'}\`)`);
      for (const l of s.failLines ?? s.tail ?? []) lines.push(`  - \`${l.replace(/`/g, "'").slice(0, 200)}\``);
    }
  }
  lines.push('', `Evidence: \`${OUT}\` (summary.json, runner.log, <step>.log, ${NSHARDS > 1 ? 's<k>/' : ''}gate4d/ gate4e/ gate5b/ gate6a/ sim-*/, client logs).`, '');
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
    const r = spawnSync(NOTIFY_SCRIPT, args, { encoding: 'utf8', timeout: 120_000, env: childEnv(shards[0]) });
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
  for (const sh of shards) if (sh.activeGroup) killGroup(sh.activeGroup, 'SIGTERM');
  await sleep(3000);
  for (const sh of shards) if (sh.activeGroup) killGroup(sh.activeGroup, 'SIGKILL');
  for (const sh of shards) {
    await stopClient(sh, 'abort').catch(() => killRunDir(sh, 'abort'));
    cleanStrays(sh);
  }
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
  // preflight: nothing else may use the run worktrees or the ports, so everything killed later is ours
  for (const sh of shards) {
    const others = runDirProcs(sh);
    if (others.length) throw new Error(`processes already use the run worktree ${sh.RUN} (${others.map((p) => `${p.pid}`).join(', ')}); not ours, not touched`);
    for (const p of [sh.SIDECAR_PORT, sh.DEV_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use (shard ${sh.k}; set --ports / GATE_PORTS)`);
  }
  log(`gate-run ${chainName}: ${steps.length} steps (${steps.map((s) => s.id).join(' ')}); ${shards.map((s) => `shard ${s.k} ${s.RUN} ports ${s.SIDECAR_PORT}/${s.DEV_PORT}`).join('; ')}; notify ${NOTIFY_MODE}`);
  if (tierInfo.kind === 'tier') {
    log(`tier ${tierInfo.tier}${tierInfo.range ? ` over ${tierInfo.range}` : ''}: engine ${tierInfo.engine}, placement ${tierInfo.placement}${tierInfo.impact?.unmapped.length ? `, ${tierInfo.impact.unmapped.length} unmapped files` : ''}`);
    for (const r of tierInfo.rotation ?? []) if (r.skipped.length) log(`rotation ${r.name}: ran ${r.ran.join(' ') || '-'}, SKIPPED ${r.skipped.join(' ')} (${r.reason})`);
  }
  const head = git(SRC, 'rev-parse', 'HEAD');
  summary.head = head;
  summary.sourceDirty = !!git(SRC, 'status', '--porcelain', '--untracked-files=no');
  summary.setup = [];
  for (const sh of shards) summary.setup.push(await setupShard(sh, head));
  writeSummary();
} catch (e) {
  log(`setup failed: ${e.message}`);
  finishing = true;
  await finish('aborted', `setup: ${e.message}`);
  process.exit(1);
}

// the scheduler: one worker per shard, each starting the next step `pick` allows
const st = { pending: steps.map((_, i) => i), running: new Map(), done: new Map() };
let stopped = false;
let waiters = [];
const wake = () => new Promise((r) => {
  waiters.push(r);
  setTimeout(r, 5000);
});
const wakeAll = () => {
  const w = waiters;
  waiters = [];
  for (const f of w) f();
};

/** Steps whose `after` dependency ended without a PASS are skipped (4e-crash needs 4e-orders' context). */
function skipBlocked() {
  for (const i of [...st.pending]) {
    const s = steps[i];
    const d = s.after && stepIds.includes(s.after) ? st.done.get(s.after) : null;
    if (d && d.status !== 'PASS') {
      const rec = summary.steps[i];
      rec.status = 'SKIPPED';
      rec.error = `needs ${s.after} (${d.status})`;
      log(`== ${s.id}: SKIPPED (${rec.error})`);
      st.pending.splice(st.pending.indexOf(i), 1);
      st.done.set(s.id, { status: 'SKIPPED', shard: d.shard });
      writeSummary();
    }
  }
}

async function worker(sh) {
  while (!stopped) {
    skipBlocked();
    if (!st.pending.length) break;
    const i = pick(sh, st, shards);
    if (i === null) {
      if (!st.running.size && !shards.some((o) => pick(o, st, shards) !== null)) {
        for (const j of st.pending) Object.assign(summary.steps[j], { status: 'ERROR', error: 'unschedulable (a bug in the step declarations)' });
        st.pending.length = 0;
        writeSummary();
        break;
      }
      await wake();
      continue;
    }
    st.pending.splice(st.pending.indexOf(i), 1);
    st.running.set(i, sh.k);
    const step = steps[i];
    const rec = summary.steps[i];
    // a bench step runs alone (pick drained the others): the other shards' idle clients would load the machine, so stop them
    if (isBench(step)) for (const o of shards) if (o !== sh && ownProcs(o).length) await stopClient(o, `bench step ${step.id} on s${sh.k}`);
    await runStep(sh, step, rec);
    st.running.delete(i);
    st.done.set(step.id, { status: rec.status, shard: sh.k });
    writeSummary();
    if (step.stopOnFail && rec.status !== 'PASS') {
      log(`${step.id} is stopOnFail and ended ${rec.status}: stopping the chain`, sh);
      stopped = true;
    }
    wakeAll();
  }
  wakeAll();
}

await Promise.all(shards.map((sh) => worker(sh)));
finishing = true;
for (const sh of shards) await stopClient(sh, 'end of chain');
await finish(stopped ? 'stopped' : 'done');
process.exit(summary.verdict === 'PASS' ? 0 : 1);
