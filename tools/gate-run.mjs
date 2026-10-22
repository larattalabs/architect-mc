#!/usr/bin/env node
// Unattended gate runner (docs/GATES.md): runs a named chain, or a tier (change | slice | release), of gate steps from
// tools/gate-chains.json against dev clients in the runner's own run worktrees, with no agent watching. Non-interactive;
// per-step timeouts, from the step history where it has 5 samples (a hung step is killed: its own process group, then its run
// worktree's processes only); continues past failures unless a step is `stopOnFail`; one lock; no notify unless asked (Noah: no
// Discord pings). No Claude: it refuses to start with Claude credentials in the environment, strips every ANTHROPIC_* / CLAUDE*
// variable from its children, and runs only the stub/sim client scripts.
//
//   node tools/gate-run.mjs <chain> [--shards N] [--only a,b] [--from step] [--plan]
//   node tools/gate-run.mjs change  --since <ref> | --range A...B | --files a,b [--shards N] [--plan]   unit suites + mapped steps
//   node tools/gate-run.mjs slice   --since <ref> | --range A...B | --files a,b [--shards N] [--plan]   quick + the affected steps
//   node tools/gate-run.mjs release [--release <tag>] [--since <ref>] [--shards N] [--plan]  everything, duplicates rotated
//   node tools/gate-run.mjs --list                  the chains and tiers
//   [--notify | --notify-dry-run]                   off by default (Noah: no Discord pings)
//
// --plan prints the selection (impact, rotation and what it skipped), the steps, clients, estimates and timeouts, resources,
// shards, per-shard busy time and an estimated wall time, and exits without running anything (--verbose: each step's estimate
// and timeout source and its priority).
//
// Where it runs (flag, else environment, else default). Several agents share this machine: a second runner names its own.
//   --ports S:D[,S:D...]   GATE_PORTS     every shard's sidecar:DevBridge pair. Without it shard 1 is ARCHITECT_GATE_SIDECAR_PORT /
//                                         ARCHITECT_GATE_DEV_PORT (8890/8891) and shards 2.. come from GATE_SHARD_PORTS (no default:
//                                         a sharded run names its ports). 8892-8895 are never a shard's (old-version clients, eval).
//   --run-dir DIR          GATE_RUN_DIR   shard 1's run worktree (../architect-mc-gate-run); shard k is <DIR>-s<k>
//   --run-dirs A,B,C       GATE_RUN_DIRS  every shard's run worktree, explicitly
//   --out DIR              GATE_RUNS_OUT  where runs go (<main checkout>/artifacts/gate-runs)
//   --lock FILE            GATE_LOCK      the lock (<out>/gate-run.lock)
//   --slots N              GATE_SLOTS     machine-wide gate-run slots (default slots.max in gate-chains.json, 4): at most N runs at once, across worktrees. A run
//                                         takes a slot file in --slots-dir (GATE_SLOTS_DIR; <LarattaLabs>/.gate-slots) and waits for a
//                                         free one; a slot held by a dead pid counts as free. Separate from the per-run --lock.
//   --judge-timing         in change/slice timing bars (lines `FAIL BAR ...`) are recorded, not judged; this judges them as at release
//                          (and isolates the bench steps again)
//   --no-history-timeouts  the configured timeoutMin for every step; --no-history also ignores the history for the order
//                          GATE_HISTORY_FILE  the step history (<main checkout>/artifacts/gate-step-history.json, rebuilt every run)
//   --quiet-wait [load]    on by default at release (load 8); opt-in elsewhere. --no-quiet-wait turns it off
//   --host auto|client|server  GATE_HOST  where steps run (tools/lib/hosts.mjs): auto (default) runs the steps marked
//                                         "host": "server" on a headless server, the rest on clients; client runs all on clients
//   --seed-dir DIR         GATE_SEED_DIR  read-only source of .gradle-home, node_modules and the gate worlds (../architect-mc-6a-run)
//                          GATE_SNAPSHOT_DIR  prepared worlds restored by APFS clone (the seed's mod/run/saves)
//                          GATE_NOTIFY=send|dry, GATE_NOTIFY_SCRIPT (~/Developer/_infra/discord-notify.sh); off by default
//
// Shards (--shards N, at most shards.max; or --shards auto, the default for slice/release plans of more than shards.auto.minSteps
// steps): auto picks N from the free shard budget of the slot holders, the load average, available memory and the plan's own
// schedule, and allocates free port pairs from shards.auto.portRange unless --ports names them (tools/lib/shard-auto.mjs; --plan
// prints the caps and which bound). One slot per run; the slot file records the run's shards and ports. Each shard has its own client, run worktree, port pair and evidence dir (<out>/s<k>/ when
// N > 1). Steps declare what they need: steps sharing a resource never overlap, a step with `after` runs on its dependency's
// shard, `waitFor` waits for steps on any shard (any status), and a `stopOnFail` step is a barrier. A free shard takes the ready
// step with the longest estimate (history p50 plus the chain waiting on it), less its client cost there (docs/GATES.md "Gate
// speed"). A `bench` step (timing or MSPT bars) runs alone only where timing is judged (release, named chains, --judge-timing,
// `"isolate": true`); in change/slice it schedules like any step and records `contended`/`ranWith`.
// The kit suite runs once: unit-kit writes a JUnit report to GATE_KIT_RESULTS (tools/lib/kit-reuse.mjs), and the drivers'
// kit-suite and goldens checks read it when exact; the runner also passes GATE_UNIT_MOD_RUN (where unit-mod built this head).
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
import { changedFiles, describeImpact, impactOf, validateImpact, versionOnlyFiles } from './gate-impact.mjs';
import { HEADLESS_SCRIPT, applyHosts } from './lib/hosts.mjs';
import { currentHistory, definitionNow, definitionsAt, effectiveTimeout, estimateMin, loadHistory } from './lib/gate-history.mjs';
import { autoConfig, chooseShards, describeChoice, freePairs, probeMachine } from './lib/shard-auto.mjs';
import { acquire as acquireMachine, chooseTurbo, describeQueue, describeTurbo, foldSamples, liveHolders, releaseAll, sampleMachine, turboConfig } from './lib/turbo.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(SRC, '..', 'architect-mc');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ arguments and config

const argv = process.argv.slice(2);
const VALUED = ['--config', '--only', '--from', '--since', '--range', '--files', '--release', '--shards', '--ports', '--run-dir', '--run-dirs', '--out', '--lock', '--slots', '--slots-dir', '--seed-dir', '--quiet-max-min', '--host', '--lanes'];
const flag = (f) => argv.includes(f);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const CONFIG_PATH = path.resolve(opt('--config') ?? path.join(SRC, 'tools', 'gate-chains.json'));
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const TIERS = ['change', 'slice', 'release'];
// where each step runs: a dev client or a headless server (tools/lib/hosts.mjs; docs/GATES.md "Headless gates")
let HOSTS;
try {
  HOSTS = applyHosts(cfg, opt('--host') ?? process.env.GATE_HOST ?? 'auto');
} catch (e) {
  console.error(`gate-run: ${e.message}`);
  process.exit(2);
}
const chainName = argv.find((a, i) => !a.startsWith('--') && !VALUED.includes(argv[i - 1]) && !(argv[i - 1] === '--quiet-wait' && /^\d/.test(a)));
const ORDER = Object.keys(cfg.steps); // the canonical step order: chains and tiers run in it

const die = (m) => {
  console.error(`gate-run: ${m}`);
  process.exit(2);
};
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

if (flag('--list') || !chainName) {
  for (const [n, s] of Object.entries(cfg.chains)) console.log(`${n.padEnd(8)} ${s.length} steps: ${s.join(' ')}`);
  console.log('change   tier: the impacted unit suites + the impact map\'s change steps (--since <ref>)');
  console.log('slice    tier: the unit suites + apijars + the impact map\'s change and slice steps (the slice\'s own gate steps); no quick (--since <ref>)');
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
  if (cfg.chains[chainName]) return { ids: [...cfg.chains[chainName]], info: { kind: 'chain', why: Object.fromEntries(cfg.chains[chainName].map((s) => [s, [`chain ${chainName}`]])) } };
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
    // a file whose only changes are version constants maps to its unit suite (gate-impact.mjs versionOnlyFiles; needs a range)
    imp = impactOf(files, cfg.impact ?? {}, { versionOnly: listed ? new Set() : versionOnlyFiles(SRC, range, cfg.impact?.versionConstants) });
    info.range = range ?? `--files (${files.length})`;
    info.impact = { files: imp.files, rules: Object.fromEntries(Object.entries(imp.rules).map(([k, v]) => [k, v.files.length])), unmapped: imp.unmapped, ignored: imp.ignored.length, tags: imp.tags };
    info.impactText = describeImpact(imp);
  }
  // release without a range (no tag yet): treated as engine- and placement-touching (the full measurements)
  const tags = new Set(imp ? imp.tags : ['engine', 'placement']);
  info.engine = tags.has('engine');
  info.placement = tags.has('placement');
  const t = cfg.tiers[chainName];
  const why = (info.why = {});
  const addW = (s, r) => {
    want.add(s);
    (why[s] ??= []).includes(r) || why[s].push(r);
  };
  const fromRules = (kinds) => {
    for (const [name, r] of Object.entries(imp.rules)) for (const k of kinds) for (const s of r[k]) addW(s, `impact rule "${name}" (${k})`);
  };
  if (chainName === 'change') {
    // the unit suites always (minutes), unless the diff is only ignored paths (docs): then nothing
    if (imp.files > imp.ignored.length) for (const s of t.always ?? []) addW(s, 'change: the unit suites always run');
    fromRules(['change']);
    if (imp.unmapped.length) {
      for (const s of t.fallback) addW(s, 'unmapped files: the safe default');
      info.notes.push(`unmapped files: the safe default added ${t.fallback.join(' ')}`);
    }
  } else if (chainName === 'slice') {
    // slice = the unit suites + apijars (api-compat) + the impact map's change and slice steps (the slice's own gate steps, found by
    // the impact rule of its driver). No `quick`. A diff of only ignored paths (docs) runs nothing, as for change.
    if (imp.files > imp.ignored.length) for (const s of t.always ?? []) addW(s, 'slice: the unit suites and apijars (api-compat) always run');
    else info.notes.push('only ignored paths (docs etc.): nothing to run');
    fromRules(['change', 'slice']);
    for (const [name, r] of Object.entries(imp.rules)) {
      const drv = r.files.filter((x) => /^tools\/gate[^/]*\.mjs$/.test(x) && !Object.entries(imp.rules).some(([n2, r2]) => n2 !== 'other tools' && r2.files.includes(x)));
      if (name === 'other tools' && drv.length) info.notes.push(`${drv.join(', ')}: a gate driver with no impact rule, so none of its steps run; add a rule to gate-chains.json so the slice's own steps are found`);
    }
    if (imp.unmapped.length) {
      for (const s of t.fallback ?? []) addW(s, 'unmapped files: the safe default');
      info.notes.push('unmapped files: the units and apijars (already in) are the safe default; extend the impact map');
    }
    if (info.engine && t.engineSlice?.length) {
      for (const s of t.engineSlice) want.add(s);
      info.notes.push(`engine-touching: added ${t.engineSlice.join(' ')}`);
    } else if (info.engine) info.notes.push('engine-touching: the full 1000x1000 megaA comes only with region code (the impact map), megaB only at release');
  } else {
    const rk = rotationKey();
    info.rotationKey = rk.key;
    info.rotationSource = rk.source;
    info.rotation = [];
    for (const s of t.always) addW(s, 'release: always');
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
      for (const s of chosen) addW(s, `release rotation "${r.name}": ${reason}`);
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
      addW(dep, `needed by ${s}`);
      info.notes.push(`${s} needs ${dep}: added`);
    }
  }
  // (gate waits, 2026-10-20) a step whose every assertion another step also runs (`supersededBy`, docs/GATES.md "Duplicates") is
  // dropped when that step is in the run too; alone (e.g. the change tier's scenario step) it runs as before
  info.superseded = {};
  for (const s of [...want]) {
    const by = cfg.steps[s].supersededBy;
    if (by && want.has(by) && !Object.entries(cfg.steps).some(([id, x]) => x.after === s && want.has(id))) {
      want.delete(s);
      info.superseded[s] = by;
      info.notes.push(`${s}: dropped, ${by} runs every assertion it runs (supersededBy)`);
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
// --quiet-wait [load] (opt-in; on by default at release): before a bench step, wait until the 1-minute load average is below <load> (default 8), at most
// --quiet-max-min minutes (default 30); if it never gets there the step runs marked noisy and its result is NOISY (inconclusive:
// it neither passes nor fails the bars). Without it, every step's load average is recorded, not acted on.
const quietArg = argv[argv.indexOf('--quiet-wait') + 1];
// Timing policy (docs/GATES.md "Policy update"): in change and slice the timing bars (driver lines `FAIL BAR ...`) are recorded, not
// judged; at release (and in a named chain) they judge, and --quiet-wait is on by default.
const RECORD_TIMING = (chainName === 'change' || chainName === 'slice') && !flag('--judge-timing');
const QUIET = flag('--quiet-wait') ? (/^\d/.test(quietArg ?? '') ? Number(quietArg) : 8) : chainName === 'release' && !flag('--no-quiet-wait') ? 8 : null;
const QUIET_MAX_MIN = Number(opt('--quiet-max-min') ?? 30);
if (QUIET !== null && !(QUIET > 0)) die('--quiet-wait takes a load average, e.g. --quiet-wait 8');
const load1 = () => Math.round(os.loadavg()[0] * 100) / 100;
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
// --shards N | auto (docs/GATES.md "Adaptive shards"). Omitted: auto for slice and release when the plan has more than
// shards.auto.minSteps steps (decided below, once the steps are known), else 1 as before.
const SHARDS_ARG = opt('--shards');
const AC = autoConfig(cfg);
const TC = turboConfig(cfg);
let NSHARDS = SHARDS_ARG === undefined || SHARDS_ARG === 'auto' ? 1 : Number(SHARDS_ARG);
// the bound is shards.max, or shards.turbo.max for a turbo run (checked once the steps, and so turbo, are known)
if (!(Number.isInteger(NSHARDS) && NSHARDS >= 1 && NSHARDS <= Math.max(AC.max, TC.max))) die(`--shards must be 1..${Math.max(AC.max, TC.max)} or auto`);

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
// built by buildShards() once N is known: at once for a fixed --shards, after the auto decision (under the slot mutex) for auto
let shards = [];
let allPorts = [];
// offline lanes (turbo): extra workers for the client-less steps (units, lints), each with its own run worktree (<run dir>-o<j>:
// gradle and the kit suite write into it) and a port pair of its own (the drivers default ports; nothing of theirs is shared)
let NLANES = 0;
function buildShards(n, pp, lanes = 0) {
  NSHARDS = n;
  NLANES = lanes;
  if (RUN_DIRS.length && RUN_DIRS.length < NSHARDS + NLANES) die(`--run-dirs names ${RUN_DIRS.length} dirs for ${NSHARDS} shards${NLANES ? ` + ${NLANES} lanes` : ''}`);
  shards = [];
  const many = NSHARDS + NLANES > 1;
  for (let k = 1; k <= NSHARDS + NLANES; k++) {
    const lane = k > NSHARDS ? k - NSHARDS : 0;
    const [sp, dp] = pp[k - 1] ?? [];
    if (!sp || !dp) die(`${lane ? `lane ${lane}` : `shard ${k}`}: no port pair. Name every shard's ports: --ports 8890:8891,8896:8897 (or GATE_PORTS), or use --shards auto`);
    const RUN = RUN_DIRS.length ? RUN_DIRS[k - 1] : lane ? `${RUN1}-o${lane}` : k === 1 ? RUN1 : `${RUN1}-s${k}`;
    const name = lane ? `o${lane}` : `s${k}`;
    shards.push({ k, name, kind: lane ? 'offline' : 'game', tag: many ? `[${name}] ` : '', RUN, GAME_DIR: path.join(RUN, 'mod', 'run'), SIDECAR_PORT: sp, DEV_PORT: dp, current: null, activeGroup: null, ev: null });
  }
  allPorts = shards.flatMap((s) => [s.SIDECAR_PORT, s.DEV_PORT]);
  if (new Set(allPorts).size !== allPorts.length) die(`shard ports overlap: ${allPorts.join(' ')}`);
  for (const p of allPorts) if (p >= 8892 && p <= 8895) die(`port ${p}: 8892-8895 belong to the gates' old-version clients and eval sidecars, never to a shard`);
  checkRunDirs();
}

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
function checkRunDirs() {
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
}

// steps: only $0 commands; clients: only the stub/sim scripts
const PAID = /(-real\b|--tier\s+(smoke|full)\b|--backend\s+claude\b|--use-claude-login\b|\bpaid\b)/;
const SAFE_CLIENTS = new Set(['tools/run-gate4d-client.sh', 'tools/run-gate4e-client.sh', 'tools/run-gate5b-client.sh', 'tools/run-gate6a-client.sh',
  'tools/run-gate6b-client.sh', 'tools/run-gate6c0a-client.sh', HEADLESS_SCRIPT]);
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
// ------------------------------------------------------------------ the machine-wide slot lock (at most N gate runs at once)

const SLOTS = Number(opt('--slots') ?? process.env.GATE_SLOTS ?? cfg.slots?.max ?? 3);
if (!(Number.isInteger(SLOTS) && SLOTS >= 1)) die('--slots takes a positive integer');
const SLOT_DIR = path.resolve(opt('--slots-dir') ?? process.env.GATE_SLOTS_DIR ?? path.join(MAIN, '..', '.gate-slots'));
// the queue, the slots and turbo's exclusive hold live in tools/lib/turbo.mjs (docs/GATES.md "Turbo"): every run queues (FIFO
// under the slot mutex); a shared run takes one slot, a turbo run every slot. A dead pid's ticket or slot is free.
const slotHolders = () => liveHolders(SLOT_DIR).filter((h) => h.pid !== process.pid);
/** Every live holder in the slot dir (also slots above this run's --slots limit), not this process: their shards and ports count. */
const allSlotHolders = slotHolders;
let holdingSlots = false;
function releaseSlot() {
  if (!holdingSlots) return;
  holdingSlots = false;
  releaseAll(SLOT_DIR, process.pid);
}
process.on('exit', releaseSlot);
const slotNote = { waitedSeconds: 0, slot: null, slots: null, limit: SLOTS, dir: SLOT_DIR, turbo: false };
async function acquireSlot(decide) {
  fs.mkdirSync(SLOT_DIR, { recursive: true });
  const stamp = () => new Date().toISOString().slice(11, 19);
  const onSig = (sig) => {
    releaseSlot();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);
  holdingSlots = true; // the ticket (and a turbo run's reserved slots) from here on
  const me = { pid: process.pid, worktree: SRC, chain: chainName, turbo: TURBO };
  const fill = Math.max(TC.fillSlots, SLOTS, cfg.slots?.max ?? 0);
  const got = await acquireMachine(SLOT_DIR, me, { slots: SLOTS, fill, decide, pollMs: Number(process.env.GATE_SLOT_POLL_MS ?? (TURBO ? TC.pollMs : 15_000)),
    log: (m) => console.log(`[${stamp()}] gate-run ${chainName}: ${m}`) });
  Object.assign(slotNote, { slot: got.slot, slots: got.slots, waitedSeconds: got.waitedSeconds, turbo: TURBO });
  process.removeListener('SIGINT', onSig);
  process.removeListener('SIGTERM', onSig);
  console.log(`[${stamp()}] gate-run ${chainName}: ${TURBO ? `TURBO: holds the machine (slots ${got.slots.join(',')})` : `took slot ${got.slot}/${SLOTS}`}${got.waitedSeconds ? ` after waiting ${fmtDur(got.waitedSeconds)}` : ''}`);
}

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
    GATE4E_RUN: sh.RUN, GATE5B_RUN: sh.RUN, GATE6A_RUN: sh.RUN, GATE6B_RUN: sh.RUN,
    // the 6b gate and the scenario harness: the shard's ports and evidence dir; the 6b client always on the sim backend
    GATE6B_DEV_PORT: String(sh.DEV_PORT), GATE6B_SIDECAR_PORT: String(sh.SIDECAR_PORT), GATE6B_OUT: path.join(OUT, 'gate6b'),
    SCENARIOS_ART: path.join(OUT, 'scenarios'), ARCHITECT_GATE6B_BACKEND: 'sim',
    GATE4D_OUT: path.join(OUT, 'gate4d'), GATE4E_OUT: path.join(OUT, 'gate4e'), GATE5B_OUT: path.join(OUT, 'gate5b'), GATE6A_OUT: path.join(OUT, 'gate6a'),
    ARCHITECT_SHOTS_DIR: path.join(OUT, 'shots'),
    JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25',
    GATE_RUNNER: '1',
    // eval sidecars (if a step starts one) on an ephemeral port, never the fixed 8894/8895 another run may hold
    ARCHITECT_EVAL_PORT: process.env.ARCHITECT_EVAL_PORT ?? '0',
  });
  // the kit suite once per run (tools/lib/kit-reuse.mjs): unit-kit writes its JUnit report here; the drivers' kit-suite and goldens
  // checks take it when exact. Only when unit-kit is in this run.
  if (runShared.kitJunit) Object.assign(env, { GATE_KIT_RESULTS: runShared.kitJunit, GATE_KIT_TREE: runShared.kitTree });
  // the run worktree where unit-mod built this HEAD (gate6cmp reads its classes): set once unit-mod passed
  if (runShared.unitModRun) env.GATE_UNIT_MOD_RUN = runShared.unitModRun;
  for (const [k, v] of Object.entries(extra)) env[k] = expand(String(v), sh);
  return env;
}
/** Run-level facts the steps' environment carries (filled in when the run starts and as steps end). */
const runShared = { kitJunit: null, kitTree: null, unitModRun: null };
const expand = (s, sh) => s.replace(/\$\{(\w+)\}/g, (_, n) => ({ RUN: sh.RUN, SRC, MAIN, OUT: sh.ev })[n] ?? '');
const resolveCwd = (c, sh) => (!c ? SRC : c.startsWith('run:') ? path.join(sh.RUN, c.slice(4)) : c.startsWith('src:') ? path.join(SRC, c.slice(4)) : path.resolve(SRC, c));
const getPath = (obj, p) => p.split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);

// ------------------------------------------------------------------ the schedule (shared by --plan's estimate and the run)

const steps = stepIds.map((id) => ({ id, ...cfg.steps[id] }));
const famOf = (key) => (key && cfg.clients[key] ? cfg.clients[key].family ?? key : null);
const isBench = (s) => (s.resources ?? []).includes('bench');
// Bench isolation only where timing is judged (docs/GATES.md "Scheduling and timeouts"): at release, in the named chains and with
// --judge-timing a bench step runs alone, as before; in change and slice (timing bars recorded, not judged) it schedules like any
// other step, keeping its client, host and resources, and its result records which steps ran next to it (`contended`). A step
// marked `"isolate": true` runs alone in every tier (a bench with a timing check that is not a BAR line).
const ISOLATE_BENCH = !RECORD_TIMING;
const isIsolated = (s) => isBench(s) && (ISOLATE_BENCH || s.isolate === true);

// the step-duration history (tools/lib/gate-history.mjs): built from the past runs' summary.json under the main checkout's artifacts/
const HISTORY_FILE = path.resolve(process.env.GATE_HISTORY_FILE ?? path.join(MAIN, 'artifacts', 'gate-step-history.json'));
const HIST = flag('--no-history') ? { steps: {}, runs: 0 } : loadHistory(path.join(MAIN, 'artifacts'), HISTORY_FILE);
const estOf = new Map(steps.map((s) => [s.id, estimateMin(s, HIST)]));
const est = (s) => estOf.get(s.id).min;
// Timeouts from history: max(2 x the step's p90, 10 min), capped by its configured timeoutMin, once it has 5 samples (--no-history-
// timeouts keeps the configured ones). A bench step running next to others with only isolated samples gets 3 x p90; a stopOnFail
// barrier keeps its configured timeout.
const HIST_TIMEOUTS = !flag('--no-history-timeouts') && !flag('--no-history');
// a history timeout counts only the samples taken under the step's current definition (its chain entry and the driver files its
// shell names, at each sample's run head through git): a changed step starts over from its configured timeout until it has 5 again
const CHAINS_NOW = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const DEF_AT = definitionsAt(SRC, { chainsPath: path.relative(SRC, CONFIG_PATH) });
for (const s of steps) {
  // a stopOnFail step is a barrier (a false TIMEOUT there stops the whole run): it keeps its configured timeout
  // a step that normally waits for another (the kit-suite readers wait for unit-kit) but runs without it takes its slow path (the
  // drivers re-run the whole kit suite): its fast history doesn't apply, so it keeps its configured timeout
  const missing = (s.waitFor ?? []).filter((w) => !stepIds.includes(w));
  const t = !HIST_TIMEOUTS ? { min: s.timeoutMin, source: 'configured (--no-history-timeouts)' } : s.stopOnFail ? { min: s.timeoutMin, source: 'configured (stopOnFail barrier)' }
    : missing.length ? { min: s.timeoutMin, source: `configured (runs without ${missing.join(' ')}: its slow path)` }
    : effectiveTimeout(s, currentHistory(s.id, HIST, definitionNow(SRC, CHAINS_NOW, s.id), DEF_AT), { contendedBench: isBench(s) && !isIsolated(s) });
  s.effTimeoutMin = t.min;
  s.timeoutSource = t.source;
}
// longest-processing-time first: a step's priority is its estimate plus the longest chain of steps that wait for it (`after`,
// `waitFor`), so 4e-orders (with 4e-crash behind it) and unit-kit (the kit-suite readers behind it) start early
const prio = new Map();
const prioOf = (s, seen = new Set()) => {
  if (prio.has(s.id)) return prio.get(s.id);
  if (seen.has(s.id)) return est(s);
  seen.add(s.id);
  const deps = steps.filter((d) => d.after === s.id || (d.waitFor ?? []).includes(s.id));
  const p = est(s) + Math.max(0, ...deps.map((d) => prioOf(d, seen)));
  prio.set(s.id, p);
  return p;
};
for (const s of steps) prioOf(s);

// ------------------------------------------------------------------ the shard count: fixed, or auto (docs/GATES.md "Adaptive shards")

// auto: --shards auto, or --shards omitted on a slice/release plan of more than shards.auto.minSteps steps (else 1, as before)
const AUTO = SHARDS_ARG === 'auto' || (SHARDS_ARG === undefined && (chainName === 'slice' || chainName === 'release') && steps.length > AC.minSteps);
let autoChoice = null;
// turbo (docs/GATES.md "Turbo"): --turbo, or by default a tier run (change | slice | release) of at least shards.turbo.minSteps
// steps; --no-turbo turns it off. A turbo run waits for the whole machine and holds it, runs up to shards.turbo.max in-game shards
// and the client-less steps on their own offline lanes (--lanes N, default shards.turbo.offlineLanes).
const TURBO = !flag('--no-turbo') && (flag('--turbo') || (TIERS.includes(chainName) && steps.length >= TC.minSteps));
if (!TURBO && NSHARDS > AC.max) die(`--shards ${NSHARDS}: more than shards.max ${AC.max} needs --turbo (up to shards.turbo.max ${TC.max})`);
if (TURBO && NSHARDS > TC.max) die(`--shards ${NSHARDS}: more than shards.turbo.max ${TC.max}`);
const offlineSteps = steps.filter((s) => s.client === 'none').length;
const LANES_WANT = TURBO ? Number(opt('--lanes') ?? TC.offlineLanes) : 0;
if (!(Number.isInteger(LANES_WANT) && LANES_WANT >= 0)) die('--lanes takes a non-negative integer');
// lanes only when there are client-less steps and in-game ones to run beside them
const LANES = offlineSteps && offlineSteps < steps.length ? Math.min(LANES_WANT, offlineSteps) : 0;
const TURBO_AUTO = TURBO && (SHARDS_ARG === undefined || SHARDS_ARG === 'auto');
/** Turbo: the shard count from the plan, memory and ports only (the run holds the machine), and the port pairs from the turbo range. */
async function decideTurbo() {
  const probe = probeMachine();
  const pairsFree = await freePairs({ range: TC.portRange, given: allPairs ? portPairs : null, taken: new Set() });
  const max = TURBO_AUTO ? TC.max : NSHARDS;
  const c = chooseTurbo(TC, { max, probe, lanes: LANES, wallFor: (n) => estimate(est, n, LANES).wallMin, pairs: pairsFree.length });
  if (pairsFree.length < c.n + LANES) die(`turbo: ${pairsFree.length} free port pair(s) ${allPairs ? `in --ports ${allPairs}` : `in ${TC.portRange.join('-')} (shards.turbo.portRange)`}, need ${c.n + LANES}`);
  // a fixed --shards N is taken as asked (the plan cap only advises), within memory and the ports
  if (!TURBO_AUTO && Math.min(c.caps.memory, c.caps.ports) < NSHARDS) die(`turbo --shards ${NSHARDS}: only ${Math.min(c.caps.memory, c.caps.ports)} fit (memory ${c.caps.memory}, ports ${c.caps.ports})`);
  const n = TURBO_AUTO ? c.n : NSHARDS;
  autoChoice = {
    mode: TURBO_AUTO ? `turbo auto (${flag('--turbo') ? '--turbo' : `default for a ${chainName} of ${steps.length} steps >= ${TC.minSteps}`}; --no-turbo for a shared run)` : `turbo --shards ${NSHARDS}`,
    turbo: true, n, lanes: LANES, bound: TURBO_AUTO ? c.bound : ['--shards'], caps: c.caps, probe, wallByN: c.table.map((t) => ({ n: t.n, wallMin: Math.round(t.wallMin * 10) / 10 })),
    ports: pairsFree.slice(0, n + LANES).map(([sp, dp]) => `${sp}:${dp}`), portSource: allPairs ? '--ports' : `range ${TC.portRange.join('-')}`, decidedAt: new Date().toISOString(),
    text: describeTurbo({ ...c, n, bound: TURBO_AUTO ? c.bound : ['--shards'] }, probe, TC, LANES),
  };
  buildShards(n, pairsFree.slice(0, n + LANES), LANES);
  return autoChoice;
}
/** Choose N and its port pairs from the machine now (tools/lib/shard-auto.mjs). The run calls it under the slot mutex. */
async function decideAuto() {
  const probe = probeMachine();
  const holders = allSlotHolders();
  const taken = new Set(holders.flatMap((h) => (Array.isArray(h.ports) ? h.ports.flat() : [])).map(Number));
  const pairsFree = await freePairs({ range: AC.portRange, given: allPairs ? portPairs : null, taken });
  const freeRunSlots = Math.max(0, SLOTS - slotHolders().filter((h) => h.pid !== process.pid).length - 1);
  const c = chooseShards(AC, { probe, holders, freeRunSlots, wallFor: (n) => estimate(est, n, 0).wallMin, pairs: pairsFree });
  if (!pairsFree.length) die(`shards auto: no free port pair ${allPairs ? `in --ports ${allPairs}` : `in ${AC.portRange.join('-')} (shards.auto.portRange)`}`);
  autoChoice = {
    mode: SHARDS_ARG === 'auto' ? '--shards auto' : `default for ${chainName} (${steps.length} steps > ${AC.minSteps}; --shards N to fix it)`,
    n: c.n, bound: c.bound, caps: c.caps, probe, otherShards: c.used, wallByN: c.table.map((t) => ({ n: t.n, wallMin: Math.round(t.wallMin * 10) / 10 })),
    ports: pairsFree.slice(0, c.n).map(([sp, dp]) => `${sp}:${dp}`), portSource: allPairs ? '--ports' : `range ${AC.portRange.join('-')}`, decidedAt: new Date().toISOString(),
    text: describeChoice(c, probe, AC),
  };
  buildShards(c.n, pairsFree.slice(0, c.n));
  return autoChoice;
}
const decideShards = TURBO ? decideTurbo : AUTO ? decideAuto : null;
if (!decideShards) buildShards(NSHARDS, portPairs);

/**
 * The next step shard `sh` may start, or null. st: { pending: [index], running: Map(index -> shardK), done: Map(id -> {status,
 * shard}) }. Rules: a stopOnFail step earlier in the order is a barrier until it is done; `after` waits for its dependency and
 * runs on the dependency's shard; `waitFor` waits until those steps have ended (any status, any shard); steps sharing a resource
 * never overlap. One shard runs the order exactly. Sharded: an isolated bench step (release, chains, --judge-timing) waits until
 * every other step has started and the running ones have drained, then runs alone; every other step is picked longest-first
 * (its priority above), less the cost of getting its client here (none if the client is up, a world switch within a family,
 * else a start), so the long steps spread over the shards instead of piling up at the end.
 */
function pick(sh, st, all) {
  const runningSteps = [...st.running.keys()].map((i) => steps[i]);
  if (runningSteps.some(isIsolated)) return null;
  const held = new Set(runningSteps.flatMap((s) => (s.resources ?? []).filter((r) => r !== 'bench')));
  // offline lanes (turbo): a lane takes only client-less steps; an in-game shard takes them only once no in-game step is pending
  // (it would stop its client for one), so the in-game shards keep their clients and the lanes run the units beside them
  const lanes = all.some((o) => o.kind === 'offline');
  const offline = (s) => s.client === 'none';
  const gamePending = lanes && sh.kind !== 'offline' && st.pending.some((j) => !offline(steps[j]));
  const ready = [];
  for (const i of st.pending) {
    const s = steps[i];
    if (lanes && (sh.kind === 'offline' ? !offline(s) : offline(s) && gamePending)) continue;
    if (steps.some((b, j) => j < i && b.stopOnFail && !st.done.has(b.id))) continue;
    if (s.after && stepIds.includes(s.after)) {
      const d = st.done.get(s.after);
      if (!d || d.shard !== sh.k) continue;
    }
    if ((s.waitFor ?? []).some((w) => stepIds.includes(w) && !st.done.has(w))) continue;
    if ((s.resources ?? []).some((r) => held.has(r))) continue;
    ready.push(i);
  }
  if (!ready.length) return null;
  if (all.length === 1) return ready[0]; // one shard: the chain order, exactly
  // sharded: isolated bench steps go after every other step has started, then one at a time with nothing else running
  const rest = ready.filter((i) => !isIsolated(steps[i]));
  if (!rest.length) {
    if (st.pending.some((i) => !isIsolated(steps[i])) || st.running.size) return null;
    return ready[0];
  }
  // longest first, less the client cost here: 0 when this shard's client serves it, 0.15 min for a world switch in the same
  // family, 0.6 min for a start (or for stopping the client up here before a step with no client); ties keep the order
  const fam = famOf(sh.current);
  const cost = (s) => {
    if (s.client === 'none' || s.client === 'self') return sh.current ? 0.6 : 0;
    if (sh.current === s.client && !s.restartClient) return 0;
    if (fam && fam === famOf(s.client) && !s.restartClient) return 0.15;
    return 0.6;
  };
  let best = null;
  let bestScore = -Infinity;
  for (const i of rest) {
    const sc = prio.get(steps[i].id) - cost(steps[i]);
    if (sc > bestScore + 1e-9) {
      best = i;
      bestScore = sc;
    }
  }
  return best;
}

/** --plan's estimate: the schedule with every step taking its estimate (history p50, else estMin) and passing; client starts ~0.6 min
 * (0.15 for a world switch). n in-game shards plus `lanes` offline lanes. */
function estimate(durOf = est, n = NSHARDS, lanes = NLANES) {
  const st = { pending: steps.map((_, i) => i), running: new Map(), done: new Map() };
  const sim = Array.from({ length: n + lanes }, (_, j) => ({ k: j + 1, kind: j >= n ? 'offline' : 'game', current: null, freeAt: 0, busy: 0 }));
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
      if (sim.length > 1 && isIsolated(s)) for (const o of sim) if (o !== sh) o.current = null; // the run stops idle clients for an isolated bench step
      const start = (s.client === 'none' || s.client === 'self') ? 0 : sh.current === s.client && !s.restartClient ? 0 : famOf(sh.current) === famOf(s.client) && !s.restartClient ? 0.15 : 0.6;
      sh.current = s.client === 'none' || s.client === 'self' ? null : s.client;
      const d = start + durOf(s);
      sh.freeAt = now + d;
      sh.busy += d;
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
  const serial = steps.reduce((a, s) => a + durOf(s), 0);
  return { wallMin: now, serialMin: serial, assign, perShard: sim.map((s) => ({ k: s.k, name: s.kind === 'offline' ? `o${s.k - n}` : `s${s.k}`, busyMin: s.busy })) };
}

// ------------------------------------------------------------------ the plan

const totalTimeout = steps.reduce((a, s) => a + s.effTimeoutMin, 0);

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
  { const hs = HOSTS.server.filter((id) => stepIds.includes(id)); console.log(`hosts: --host ${HOSTS.mode}; headless: ${hs.length ? hs.join(' ') : 'none'}`); }
  const head = git(SRC, 'rev-parse', '--short', 'HEAD');
  printSelection();
  console.log(`${tierInfo.kind === 'tier' ? 'tier' : 'chain'} ${chainName}: ${steps.length} steps, worst case ${fmtDur(totalTimeout * 60)} of step timeouts (+ client starts, ${cfg.clientStartMin} min cap each)`);
  console.log(`source ${SRC} @ ${head}${git(SRC, 'status', '--porcelain', '--untracked-files=no') ? ' (DIRTY: the drivers run from the working tree, the clients from HEAD)' : ''}`);
  for (const sh of shards) {
    const missing = (cfg.seed ?? []).filter((s) => !fs.existsSync(path.join(sh.RUN, s)));
    console.log(`${sh.kind === 'offline' ? `offline lane ${sh.name}` : `shard ${sh.k}`}: run worktree ${sh.RUN} ${fs.existsSync(sh.RUN) ? '(exists; checked out --detach at the source HEAD)' : '(created: git worktree add --detach)'}; ports sidecar ${sh.SIDECAR_PORT}, DevBridge ${sh.DEV_PORT}; `
      + `seed ${missing.length ? `would clone ${missing.join(', ')}` : 'nothing missing'}`);
  }
  if (autoChoice) console.log(`${autoChoice.text}\n  mode: ${autoChoice.mode}; ports ${autoChoice.ports.join(',')} (${autoChoice.portSource}; the run re-decides under the slot mutex when it starts)`);
  else console.log(`shards: ${NSHARDS} (--shards ${SHARDS_ARG ?? `omitted: ${steps.length} steps${['slice', 'release'].includes(chainName) ? ` <= ${AC.minSteps}` : `, ${chainName} is not slice/release`}`})`);
  console.log(`${TURBO ? `TURBO: waits for the whole machine and holds every slot (queue FIFO; --no-turbo for a shared run)` : `slots: at most ${SLOTS} gate runs on the machine`} (${SLOT_DIR}); now: ${describeQueue(SLOT_DIR).text}; timing bars ${RECORD_TIMING ? 'RECORDED, not judged (change/slice)' : 'JUDGED'}`);
  console.log(`seed ${SEED} (read-only, APFS clones); snapshots ${SNAP}; artifacts ${RUNS_ROOT}/<timestamp>-${chainName}/; lock ${LOCK}; notify ${NOTIFY_MODE}; quiet-wait ${QUIET === null ? 'off (load recorded)' : `load < ${QUIET}, at most ${QUIET_MAX_MIN} min`}`);
  console.log('setup (each shard): sidecar npm run build (run worktree)');
  const sched = estimate();
  let cur = null;
  steps.forEach((s, i) => {
    let clientNote = '';
    if (shards.length === 1) {
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
    const tags = [s.stopOnFail ? 'stopOnFail' : '', isBench(s) ? (isIsolated(s) ? 'bench, isolated' : 'bench (not isolated: timing recorded)') : '', ...(s.waitFor ?? []).filter((w) => stepIds.includes(w)).map((w) => `waits for ${w}`), ...(s.resources ?? []).filter((r) => r !== 'bench'), s.after ? `after ${s.after}` : '',
      s.restore ? `restore ${s.restore.map((w) => `"${w}"`).join(',')}` : ''].filter(Boolean).join(', ');
    console.log(`${String(i + 1).padStart(2)}. ${s.id.padEnd(19)} ~${est(s).toFixed(1).padStart(5)} / ${String(s.effTimeoutMin).padStart(3)}${s.effTimeoutMin < s.timeoutMin ? `(${s.timeoutMin})` : ''} min${shards.length > 1 ? ` ${sched.perShard[sched.assign[s.id] - 1]?.name ?? '?'}` : ''}  ${clientNote}${cmd}${tags ? `  [${tags}]` : ''}`);
    if (tierInfo.why?.[s.id]) console.log(`      why: ${tierInfo.why[s.id].join('; ')}`);
    if (flag('--verbose')) console.log(`      estimate: ${estOf.get(s.id).source}; timeout: ${s.timeoutSource}; priority ${prio.get(s.id).toFixed(1)} min`);
  });
  if (shards.length === 1 && cur) console.log(`    end: stop client ${cur}`);
  console.log(`estimate: ~${fmtDur(sched.wallMin * 60)} wall on ${NSHARDS} shard(s)${NLANES ? ` + ${NLANES} offline lane(s)` : ''} (serial sum of the step estimates ~${fmtDur(sched.serialMin * 60)}; client starts ~40 s each); `
    + `${shards.length > 1 ? `per shard busy ${sched.perShard.map((p) => `${p.name} ${fmtDur(p.busyMin * 60)}`).join(', ')}; ` : ''}`
    + `schedule: longest first from ${HIST.runs} past runs (${HISTORY_FILE}); benches ${ISOLATE_BENCH ? 'isolated (timing judged)' : 'not isolated (timing recorded)'}; `
    + `timeouts ${HIST_TIMEOUTS ? `from history on ${steps.filter((s) => s.effTimeoutMin < s.timeoutMin).length}/${steps.length} steps` : 'configured'} (--verbose: per step)`);
}

if (!steps.length) {
  printSelection();
  console.log(`${chainName}: nothing to run (${tierInfo.kind === 'tier' ? 'the diff maps to no gate step' : 'empty selection'}).`);
  process.exit(0);
}

if (PLAN) {
  if (decideShards) await decideShards();
  printPlan();
  for (const sh of shards) {
    const busy = [];
    for (const p of [sh.SIDECAR_PORT, sh.DEV_PORT]) if (!(await portFree(p))) busy.push(p);
    const procs = runDirProcs(sh);
    console.log(`preflight now, ${sh.name ?? `s${sh.k}`}: ports ${busy.length ? `BUSY ${busy.join(',')}` : 'free'}; processes in its run worktree: ${procs.length ? procs.map((p) => p.pid).join(',') : 'none'}`);
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
// the slot (one per run) records this run's shard count and ports; an auto run decides both under the slot mutex
await acquireSlot(async () => {
  if (decideShards) await decideShards();
  return { shards: NSHARDS, lanes: NLANES, ports: allPorts };
});
if (autoChoice) console.log(autoChoice.text);
takeLock();
let lockHeld = true;
const releaseLock = () => {
  if (!lockHeld) return;
  lockHeld = false;
  releaseSlot();
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
  sh.ev = shards.length > 1 ? path.join(OUT, sh.name) : OUT;
  sh.clientLog = path.join(OUT, shards.length > 1 ? `client-${sh.name}.log` : 'client.log');
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
  counts: {}, setup: null, slot: slotNote, shardsAuto: autoChoice ? (({ text, ...a }) => a)(autoChoice) : null, hosts: { mode: HOSTS.mode, server: HOSTS.server.filter((id) => stepIds.includes(id)) }, timingPolicy: RECORD_TIMING ? 'recorded' : 'judged', timingRecorded: [],
  schedule: { order: 'longest first', historyRuns: HIST.runs, historyFile: HISTORY_FILE, benches: ISOLATE_BENCH ? 'isolated' : 'not isolated (timing recorded)', historyTimeouts: HIST_TIMEOUTS },
  steps: steps.map((s) => ({ id: s.id, desc: s.desc, status: 'PENDING', timeoutMin: s.timeoutMin, effectiveTimeoutMin: s.effTimeoutMin, timeoutSource: s.timeoutSource, estimateMin: Math.round(est(s) * 10) / 10, ...(tierInfo.why?.[s.id] ? { why: tierInfo.why[s.id] } : {}) })),
};
const MACHINE_LOG = path.join(OUT, 'machine.jsonl');
const machineSamples = [];
let sampler = null;
const writeSummary = () => {
  const c = {};
  for (const s of summary.steps) c[s.status] = (c[s.status] ?? 0) + 1;
  summary.counts = c;
  fs.writeFileSync(path.join(OUT, 'summary.json.tmp'), JSON.stringify(summary, null, 2));
  fs.renameSync(path.join(OUT, 'summary.json.tmp'), path.join(OUT, 'summary.json'));
};
writeSummary();
if (slotNote.slot !== null) log(`${TURBO ? `TURBO: the machine held (slots ${slotNote.slots.join(',')})` : `slot ${slotNote.slot}/${SLOTS} held`} (pid ${process.pid})${slotNote.waitedSeconds ? `, waited ${fmtDur(slotNote.waitedSeconds)} for it` : ''}; timing bars ${RECORD_TIMING ? 'recorded, not judged' : 'judged'}; quiet-wait ${QUIET === null ? 'off' : `load < ${QUIET}`}`);

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
  child.on('error', (e) => {
    exited = -1;
    log(`  client script ${c.script} did not start: ${e.message}`, sh);
  });
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
/** A timing bar the driver printed (`FAIL BAR ...`, `ok   BAR ...`): MSPT, own tick, cells/s, p99, wall, heap, quiet-dependent gaps. */
const BAR_FAIL_RE = /^(?:\[\d\d:\d\d:\d\d\] )?FAIL\s+BAR\b/;

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
    fs.writeSync(fd, `# ${new Date().toISOString()} ${step.shell ?? step.cmd.join(' ')}  (cwd ${cwd}, shard ${sh.name}, ports ${sh.SIDECAR_PORT}/${sh.DEV_PORT})\n`);
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`  TIMEOUT after ${step.effTimeoutMin} min (${step.timeoutSource}): killing step group ${child.pid}`, sh);
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 20_000);
    }, step.effTimeoutMin * 60_000);
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
  rec.shardName = sh.name;
  rec.startedAt = new Date().toISOString();
  rec.load1 = { start: load1() };
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
  const barLines = failLines.filter((l) => BAR_FAIL_RE.test(l));
  rec.barFail = barLines.length;
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
  rec.load1.end = load1();
  // change/slice: a step whose only failures are timing bars passes, with the misses recorded. Guards against hiding a real failure:
  // every FAIL line is a BAR line, no parsed failure count, the driver's own failure total(s) match the FAIL lines it printed,
  // and no uncaught exception (a stack trace) in the log.
  // the drivers' own totals (gate4d/4e/6a `N FAILURE(S)`, gate5b `FAILED (N)`, gate6b/6c*/scenarios `N failure(s)`, apitest `N FAILED ->`),
  // summed over a `&&` chain: at least one must be printed and they must add up to the FAIL lines, so a timing miss followed by an early
  // exit (the rest of the checks never ran) does not pass
  const totals = [...lines.filter((l) => !l.startsWith('# ')).join('\n').matchAll(/(\d+) FAILURE\(S\)|FAILED \((\d+)\)|(\d+) failure\(s\)|(\d+) FAILED ->/g)].map((m) => Number(m[1] ?? m[2] ?? m[3] ?? m[4]));
  const timingOnly = RECORD_TIMING && !r.timedOut && r.code !== 0 && rec.fail > 0 && barLines.length === rec.fail && parsedFail === 0
    && totals.length > 0 && totals.reduce((a, b) => a + b, 0) === rec.fail && !/^\s+at \S.*:\d+:\d+\)?\s*$/m.test(text) && (step.okLines === false || rec.ok > 0);
  if (r.timedOut) rec.status = 'TIMEOUT';
  else if (r.code === 0 && rec.fail === 0 && parsedFail === 0 && (step.okLines === false || rec.ok > 0)) rec.status = 'PASS';
  else if (timingOnly) {
    rec.status = 'PASS';
    rec.timingRecorded = barLines.map((l) => l.replace(/^\[[\d:]+\] /, '').slice(0, 300));
    summary.timingRecorded.push(...rec.timingRecorded.map((line) => ({ step: step.id, line })));
  } else rec.status = 'FAIL';
  // a step with timing bars passing in record mode that also missed none still lists nothing; a recorded miss on a loaded box says so
  if (rec.timingRecorded) rec.timingLoad1 = { start: rec.load1.start, end: rec.load1.end };
  // --quiet-wait gave up: a bench result on a loaded box is inconclusive either way (its failLines still show any functional failure)
  if (rec.noisy && !RECORD_TIMING && ['PASS', 'FAIL'].includes(rec.status)) {
    rec.noisyOutcome = rec.status;
    rec.status = 'NOISY';
  }
  if (rec.status !== 'PASS' && !rec.failLines) {
    // test runners' own failure lines (vitest " FAIL  file > test", node --test "✖ name")
    const tf = lines.filter((l) => /^\s*(FAIL\s|✖\s)/.test(l));
    if (tf.length) rec.failLines = tf.slice(0, 10).map((l) => l.trim().slice(0, 300));
  }
  if (rec.status !== 'PASS') {
    const tail = lines.filter((l) => l.trim()).slice(-5);
    rec.tail = tail.map((l) => l.slice(0, 300));
  }
  log(`  ${rec.status} ${step.id} in ${fmtDur(rec.seconds)} (exit ${r.code}${r.signal ? ` ${r.signal}` : ''}, ok ${rec.ok}, FAIL ${rec.fail}${rec.timingRecorded ? `, ${rec.timingRecorded.length} timing bar(s) RECORDED not judged` : ''})${rec.metrics ? ` ${JSON.stringify(rec.metrics)}` : ''}`, sh);
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
  const setupLog = path.join(OUT, shards.length > 1 ? `setup-${sh.name}.log` : 'setup.log');
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
  // the sidecar build runs in the background: the caller prepares every worktree serially (git and the seed clones), then waits
  // for all builds at once (12 shards' builds in parallel instead of one after another)
  log('setup: sidecar npm run build', sh);
  rec.build = new Promise((resolve, reject) => {
    const fd = fs.openSync(setupLog, 'a');
    fs.writeSync(fd, `# npm run build (cwd ${path.join(RUN, 'sidecar')})\n`);
    const child = spawn('npm', ['run', 'build'], { cwd: path.join(RUN, 'sidecar'), env: childEnv(sh), stdio: ['ignore', fd, fd] });
    child.on('error', (e) => reject(e));
    child.on('exit', (code) => {
      fs.closeSync(fd);
      if (code !== 0) reject(new Error(`npm run build failed (${code}) in ${sh.name}; ${path.basename(setupLog)}`));
      else {
        rec.status = 'PASS';
        rec.seconds = (Date.now() - ts) / 1000;
        resolve();
      }
    });
  });
  return rec;
}

// ------------------------------------------------------------------ the end: summary, notify

function summaryMd() {
  const c = summary.counts;
  const lines = [
    `# Gate run ${summary.chain}: ${summary.verdict}${summary.verdict === 'PASS' && summary.timingRecorded.length ? ` (${summary.timingRecorded.length} timing bar miss(es) recorded, not judged)` : ''}`,
    '',
    `${summary.state}, ${fmtDur(summary.durationSeconds)}, head ${summary.head?.slice(0, 9) ?? '?'}${summary.sourceDirty ? ' (source dirty)' : ''}, `
      + `${shards.map((s) => `${shards.length > 1 ? `${s.name} ` : ''}ports ${s.SIDECAR_PORT}/${s.DEV_PORT}`).join(', ')}.`,
    `Steps: ${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ')}.${summary.timingRecorded.length ? ` ${summary.timingRecorded.length} timing bar miss(es) recorded.` : ''}${summary.error ? ` Error: ${summary.error}` : ''}`,
    `${summary.slot.turbo ? `TURBO (the machine held, ${NSHARDS} shard(s) + ${NLANES} offline lane(s))` : `Slot ${summary.slot.slot}/${summary.slot.limit}`}${summary.slot.waitedSeconds ? ` (waited ${fmtDur(summary.slot.waitedSeconds)})` : ''}; timing bars ${summary.timingPolicy}; benches ${summary.schedule.benches}; ${summary.schedule.historyTimeouts ? 'timeouts from history' : 'configured timeouts'}.`,
  ];
  if (autoChoice) lines.push('', '```', autoChoice.text, '```');
  const mc = summary.machine;
  if (mc) lines.push('', `Machine (${mc.samples} samples, machine.jsonl): load p50 ${mc.loadP50}, p90 ${mc.loadP90}, max ${mc.loadMax}; available memory min ${mc.availGBMin} GB; swap max ${mc.swapGBMax} GB; `
    + `gate processes' RSS max ${mc.gateRssGBMax} GB; largest process per shard ${Object.entries(mc.lanes).map(([k, v]) => `${k} ${v.maxProcGB}`).join(', ')} GB.`);
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
  lines.push('', `| step | ${shards.length > 1 ? 'shard | ' : ''}status | time | ok/FAIL | key numbers |`, `|---|${shards.length > 1 ? '---|' : ''}---|---|---|---|`);
  for (const s of summary.steps) {
    const m = [s.metrics ? Object.entries(s.metrics).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ') : '',
      s.load1 ? `load ${s.load1.start}->${s.load1.end ?? '?'}` : '', s.noisy ? `noisy (outcome ${s.noisyOutcome ?? '?'})` : '',
      s.contended ? `bench contended (ran with ${s.ranWith.length} step(s))` : '', s.timeoutSource?.startsWith('history') && s.status === 'TIMEOUT' ? `history timeout ${s.effectiveTimeoutMin} of ${s.timeoutMin} min` : ''].filter(Boolean).join('; ');
    lines.push(`| ${s.id} | ${shards.length > 1 ? `${s.shardName ?? s.shard ?? '-'} | ` : ''}${s.status} | ${s.seconds != null ? fmtDur(s.seconds) : '-'} | ${s.ok ?? '-'}/${s.fail ?? '-'} | ${m.replace(/\|/g, '/')} |`);
  }
  const rec = summary.steps.filter((s) => s.timingRecorded?.length);
  if (rec.length) {
    lines.push('', '## Timing bars recorded, not judged (change/slice policy)', '',
      'These steps PASS on their functional checks; the timing bars below missed and are judged only at release (with --quiet-wait and the CI runners paused).', '');
    for (const s of rec) {
      lines.push(`- **${s.id}** (load ${s.timingLoad1?.start ?? '?'} -> ${s.timingLoad1?.end ?? '?'}${s.contended ? `; contended: ran next to ${s.ranWith.join(' ')}` : ''}; log \`${s.log ?? '-'}\`)`);
      for (const l of s.timingRecorded) lines.push(`  - \`${l.replace(/`/g, "'").slice(0, 220)}\``);
    }
  } else if (summary.timingPolicy === 'recorded') lines.push('', 'Timing bars: recorded, not judged in this tier; none missed.');
  const bad = summary.steps.filter((s) => ['FAIL', 'TIMEOUT', 'ERROR', 'SKIPPED', 'NOISY'].includes(s.status));
  if (bad.length) {
    lines.push('', '## Not passing', '');
    for (const s of bad) {
      lines.push(`- **${s.id}** ${s.status}${s.error ? `: ${s.error}` : ''} (log \`${s.log ?? '-'}\`)`);
      for (const l of s.failLines ?? s.tail ?? []) lines.push(`  - \`${l.replace(/`/g, "'").slice(0, 200)}\``);
    }
  }
  lines.push('', `Evidence: \`${OUT}\` (summary.json, runner.log, <step>.log, ${shards.length > 1 ? 's<k>/ o<j>/' : ''}gate4d/ gate4e/ gate5b/ gate6a/ sim-*/, client logs).`, '');
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
  if (sampler) clearInterval(sampler);
  if (machineSamples.length) summary.machine = foldSamples(machineSamples);
  summary.state = state;
  if (error) summary.error = error;
  summary.endedAt = new Date().toISOString();
  summary.durationSeconds = (Date.now() - t0) / 1000;
  for (const s of summary.steps) if (['PENDING', 'RUNNING'].includes(s.status)) s.status = 'SKIPPED';
  writeSummary();
  const c = summary.counts;
  const clean = state === 'done' && !error;
  summary.verdict = clean && (c.PASS ?? 0) === summary.steps.length ? 'PASS'
    : clean && (c.PASS ?? 0) + (c.NOISY ?? 0) === summary.steps.length ? 'INCONCLUSIVE' : 'FAIL';
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
    for (const p of [sh.SIDECAR_PORT, sh.DEV_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use (${sh.name}; set --ports / GATE_PORTS)`);
  }
  log(`gate-run ${chainName}: ${steps.length} steps (${steps.map((s) => s.id).join(' ')}); ${shards.map((s) => `shard ${s.k} ${s.RUN} ports ${s.SIDECAR_PORT}/${s.DEV_PORT}`).join('; ')}; notify ${NOTIFY_MODE}`);
  if (tierInfo.kind === 'tier') {
    log(`tier ${tierInfo.tier}${tierInfo.range ? ` over ${tierInfo.range}` : ''}: engine ${tierInfo.engine}, placement ${tierInfo.placement}${tierInfo.impact?.unmapped.length ? `, ${tierInfo.impact.unmapped.length} unmapped files` : ''}`);
    for (const r of tierInfo.rotation ?? []) if (r.skipped.length) log(`rotation ${r.name}: ran ${r.ran.join(' ') || '-'}, SKIPPED ${r.skipped.join(' ')} (${r.reason})`);
  }
  const head = git(SRC, 'rev-parse', 'HEAD');
  summary.head = head;
  if (stepIds.includes('unit-kit')) {
    runShared.kitJunit = path.join(OUT, 'kit-suite.junit.xml');
    runShared.kitTree = git(SRC, 'rev-parse', 'HEAD:kit');
  }
  summary.sourceDirty = !!git(SRC, 'status', '--porcelain', '--untracked-files=no');
  summary.setup = [];
  for (const sh of shards) summary.setup.push(await setupShard(sh, head));
  const builds = await Promise.allSettled(summary.setup.map((r) => r.build));
  for (const r of summary.setup) delete r.build;
  const bad = builds.find((b) => b.status === 'rejected');
  if (bad) throw bad.reason;
  writeSummary();
} catch (e) {
  log(`setup failed: ${e.message}`);
  finishing = true;
  await finish('aborted', `setup: ${e.message}`);
  process.exit(1);
}

// the machine sampler (tools/lib/turbo.mjs): every 30 s the load, available memory, swap and each shard's/lane's resident memory
// (its run worktree's processes: the server/client JVM, the sidecar, gradle, node) to <out>/machine.jsonl; folded into summary.machine
const sampleNow = () => {
  try {
    const smp = sampleMachine(shards.map((sh) => ({ name: sh.name, needles: [...new Set([sh.RUN, real(sh.RUN)])].map((p) => p + path.sep) })), os.loadavg());
    machineSamples.push(smp);
    fs.appendFileSync(MACHINE_LOG, JSON.stringify(smp) + '\n');
  } catch {
    // a missed sample
  }
};
sampleNow();
sampler = setInterval(sampleNow, Number(process.env.GATE_SAMPLE_MS ?? 30_000));
sampler.unref();

// the scheduler: one worker per shard, each starting the next step `pick` allows
const st = { pending: steps.map((_, i) => i), running: new Map(), done: new Map() };
let stopped = false;
const overlaps = new Map(); // running step id -> the ids of the steps that ran at the same time
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
    // an isolated bench step runs alone (pick drained the others): the other shards' idle clients would load the machine, so stop them
    if (isIsolated(step)) for (const o of shards) if (o !== sh && ownProcs(o).length) await stopClient(o, `bench step ${step.id} on ${sh.name}`);
    if (isIsolated(step) && QUIET !== null) {
      const tq = Date.now();
      if (load1() >= QUIET) log(`  ${step.id}: waiting for the 1-min load average ${load1()} to drop below ${QUIET} (at most ${QUIET_MAX_MIN} min)`, sh);
      while (load1() >= QUIET && Date.now() - tq < QUIET_MAX_MIN * 60_000 && !stopped) await sleep(15_000);
      rec.quietWaitSeconds = Math.round((Date.now() - tq) / 1000);
      if (load1() >= QUIET && !RECORD_TIMING) {
        rec.noisy = true;
        log(`  ${step.id}: load ${load1()} still >= ${QUIET} after ${QUIET_MAX_MIN} min: running it marked noisy (NOISY: neither passes nor fails)`, sh);
      }
    }
    // which steps ran next to this one (a bench step's timing is then contended; recorded, never judged in change/slice)
    for (const o of overlaps.values()) o.add(step.id);
    overlaps.set(step.id, new Set([...st.running.keys()].filter((j) => j !== i).map((j) => steps[j].id)));
    await runStep(sh, step, rec);
    const ov = [...overlaps.get(step.id)];
    overlaps.delete(step.id);
    rec.ranWith = ov;
    if (isBench(step)) {
      rec.contended = ov.length > 0;
      if (ov.length) log(`  ${step.id}: bench step ran next to ${ov.join(' ')} (contended: its timing is recorded only)`, sh);
    }
    if (step.id === 'unit-mod' && rec.status === 'PASS') runShared.unitModRun = sh.RUN;
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
