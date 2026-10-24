// One CPU budget per gate run (docs/GATES.md "Frozen source and the CPU budget"). Several layers each sized themselves to the whole machine: the
// in-game shards and offline lanes, and inside every step node --test (cores - 1 test files at once), corpus-plan's worker pool
// (up to cores - 1 threads per driver), gradle's and vitest's workers (one per core). Under a turbo run that is 12 workers each
// asking for the whole machine. The one that blew up (K2's and CW's slices, 2026-10-23: 45-65 node --test children at once, load
// 100-150 on 18 cores) is node --test, when every unit driver re-runs the whole kit suite (kit-reuse refused: the source's kit
// tree moved during the run). The drivers' plan pools measured about 2 cores in all: their floor stays 4 (PLAN_FLOOR).
//
// The runner gives each worker (shard or lane) an equal share of the cores, at least `minShare`; a step's `cpuShares` (chain
// entry, default 1) takes that many shares (unit-kit: the whole kit suite at run start, which every kit-suite reader waits for).
// It hands the share to the step's children through the environment only; outside the runner (no GATE_CPU_SHARE) every consumer
// keeps its own default.

import os from 'node:os';

/** The machine's cores (hw.ncpu on macOS): os.availableParallelism(). GATE_CPU_CORES overrides it (tests, a smaller budget). */
export function machineCores(env = process.env) {
  const v = Number(env.GATE_CPU_CORES);
  if (Number.isInteger(v) && v >= 1) return v;
  return os.availableParallelism?.() ?? os.cpus().length;
}

/**
 * The per-worker share: floor(cores / workers), at least minShare (2: a plan pool of 1 is the serial loop, corpus-plan's floor).
 * conf: gate-chains.json `cpu` ({ minShare, maxShare }). -> { cores, workers, share }.
 */
export function cpuShare({ cores, workers, conf = {} }) {
  const min = Number.isInteger(conf.minShare) && conf.minShare >= 1 ? conf.minShare : 2;
  const w = Math.max(1, workers);
  let share = Math.max(min, Math.floor(cores / w));
  if (Number.isInteger(conf.maxShare) && conf.maxShare >= 1) share = Math.min(share, conf.maxShare);
  return { cores, workers: w, share: Math.min(share, Math.max(1, cores - 1)) };
}

/**
 * The environment a step's children get for `shares` shares (a step's cpuShares, default 1), at most cores - 1:
 * GATE_CPU_SHARE (the share itself, recorded), GATE_PLAN_WORKERS (corpus-plan's pool, at least PLAN_FLOOR), GATE_TEST_CONCURRENCY (every
 * `node --test` the gates run: testConcurrencyArgs below and the chain shells), VITEST_MAX_WORKERS (the sidecar's vitest) and
 * gradle's max workers through GRADLE_OPTS (-Dorg.gradle.workers.max: "Using N worker leases" at --info, with --no-daemon too).
 * A value the runner itself was started with is kept (a by-hand override wins).
 */
export const PLAN_FLOOR = 4;
export function budgetEnv({ cores, share }, { shares = 1, env = {} } = {}) {
  const n = Math.max(1, Math.min(cores - 1 || 1, Math.round(share * (Number(shares) > 0 ? Number(shares) : 1))));
  const out = { GATE_CPU_CORES: String(cores), GATE_CPU_SHARE: String(n) };
  // a plan pool below corpus-plan's own floor only stretched the critical path (voc-unit's tail on an idle machine, 2026-10-23)
  out.GATE_PLAN_WORKERS = env.GATE_PLAN_WORKERS ?? String(Math.max(n, Math.min(PLAN_FLOOR, cores - 1)));
  out.GATE_TEST_CONCURRENCY = env.GATE_TEST_CONCURRENCY ?? String(n);
  out.VITEST_MAX_WORKERS = env.VITEST_MAX_WORKERS ?? String(n);
  const g = env.GRADLE_OPTS ?? '';
  out.GRADLE_OPTS = /-Dorg\.gradle\.workers\.max=/.test(g) ? g : [g, `-Dorg.gradle.workers.max=${n}`].filter(Boolean).join(' ');
  return out;
}

/** `node --test` flags for the share the runner set: ['--test-concurrency=N'], or [] outside the runner (node's default). */
export function testConcurrencyArgs(env = process.env) {
  const n = Number(env.GATE_TEST_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 ? [`--test-concurrency=${n}`] : [];
}
