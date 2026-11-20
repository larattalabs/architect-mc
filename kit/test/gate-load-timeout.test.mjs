// (GR-b) Load-scaled step timeouts (tools/lib/load-timeout.mjs, docs/GATES.md "Kit suite once per run"): below ref a wall minute
// spends a full budget minute; above it, ref / load; a wall cap of maxFactor (<= 2) x the budget bounds it; only the listed steps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadScaleFor, loadScaledBudget, timeoutNote, timeoutRecord } from '../../tools/lib/load-timeout.mjs';

const MIN = 60_000;
const flat = (load, minutes, step = 1) => Array.from({ length: Math.floor(minutes / step) + 1 }, (_, i) => ({ t: i * step * MIN, load1: load }));

test('at or below ref the budget is wall time', () => {
  assert.equal(loadScaledBudget({ budgetMin: 40, samples: flat(30, 39), ref: 72 }).expired, false);
  const b = loadScaledBudget({ budgetMin: 40, samples: flat(72, 40), ref: 72 });
  assert.equal(b.expired, true);
  assert.equal(b.usedMin, 40);
  assert.match(b.why, /budget 40 min spent in 40 wall min/);
});

test('above ref a wall minute spends ref / load: load 108 stretches 40 min to 60', () => {
  assert.equal(loadScaledBudget({ budgetMin: 40, samples: flat(108, 59), ref: 72 }).expired, false);
  const b = loadScaledBudget({ budgetMin: 40, samples: flat(108, 60), ref: 72 });
  assert.equal(b.expired, true);
  assert.equal(b.wallMin, 60);
  assert.equal(b.meanLoad, 108);
});

test('the wall cap holds: maxFactor x the budget, maxFactor clamped to 2', () => {
  const b = loadScaledBudget({ budgetMin: 40, samples: flat(400, 80), ref: 72 });
  assert.equal(b.expired, true);
  assert.equal(b.capMin, 80);
  assert.match(b.why, /wall cap 80 min/);
  assert.equal(loadScaledBudget({ budgetMin: 40, samples: flat(400, 80), ref: 72, maxFactor: 9 }).capMin, 80, 'never above 2x');
  assert.equal(loadScaledBudget({ budgetMin: 40, samples: flat(400, 40), ref: 72, maxFactor: 0.5 }).expired, true, 'never below 1x');
});

test("r073's unit-kit (load 60-145 over its 40 min): about 48 wall minutes instead of 40", () => {
  const loads = [34.5, 75.1, 67.5, 59.4, 82.9, 144.6, 114.4, 101.7, 73.9, 71.5, 91.9, 55.2]; // machine.jsonl, every 5 min
  const at = (n) => loadScaledBudget({ budgetMin: 40, samples: loads.slice(0, n).map((load1, i) => ({ t: i * 5 * MIN, load1 })), ref: 72 });
  assert.equal(at(9).wallMin, 40);
  assert.equal(at(9).expired, false, 'not at 40 wall minutes (33.4 of budget spent)');
  assert.equal(at(10).expired, false, 'nor at 45');
  assert.equal(at(11).expired, true, 'by 50');
});

test('loadScaleFor: only the listed steps (a split part takes its parent), legacy ref at least 72; the chain config lists the three suites', () => {
  const cfg = { timeoutLoadScale: { steps: ['unit-kit'], maxFactor: 5 } };
  assert.deepEqual(loadScaleFor(cfg, 'unit-kit', { max1: 0 }), { ref: 72, refSource: 'max1', maxFactor: 2 });
  assert.deepEqual(loadScaleFor(cfg, 'unit-kit/p2', { max1: 90 }), { ref: 90, refSource: 'max1', maxFactor: 2 });
  assert.equal(loadScaleFor(cfg, 'd-unit'), null);
  assert.equal(loadScaleFor({}, 'unit-kit'), null);
  const chains = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'gate-chains.json'), 'utf8'));
  for (const id of ['unit-kit', 'unit-sidecar', 'unit-scope']) assert.ok(loadScaleFor(chains, id, { max1: chains.slots.load.max1 }), id);
  // (GRA) the chain config scales against the machine's cores
  assert.equal(chains.timeoutLoadScale.ref, 'cores');
  assert.deepEqual(loadScaleFor(chains, 'unit-sidecar', { max1: chains.slots.load.max1, cores: 18 }), { ref: 18, refSource: 'cores', maxFactor: 2 });
  assert.ok(chains.steps['unit-sidecar'].timeoutMin >= 30, 'unit-sidecar: 2 x its p90 (24 min) is no longer capped at 15');
  for (const id of chains.timeoutLoadScale.steps) assert.ok(chains.steps[id], `${id} is a step`);
});

// ---- (GRA) ref = the machine's cores; the timeout record

test('ref "cores": the cores (a number ref is used as is; "cores" without a core count falls back to max1)', () => {
  const cfg = (ref) => ({ timeoutLoadScale: { steps: ['unit-sidecar'], ref, maxFactor: 2 } });
  assert.deepEqual(loadScaleFor(cfg('cores'), 'unit-sidecar', { max1: 72, cores: 18 }), { ref: 18, refSource: 'cores', maxFactor: 2 });
  assert.deepEqual(loadScaleFor(cfg(24), 'unit-sidecar', { max1: 72, cores: 18 }), { ref: 24, refSource: 'config', maxFactor: 2 });
  assert.deepEqual(loadScaleFor(cfg('cores'), 'unit-sidecar', { max1: 72 }), { ref: 72, refSource: 'max1', maxFactor: 2 });
  assert.equal(loadScaleFor(cfg('cores'), 'd-unit', { cores: 18 }), null);
});

test('at or below the cores nothing changes: a hang at load 18 still ends at the budget', () => {
  const b = loadScaledBudget({ budgetMin: 24, samples: flat(18, 24), ref: 18 });
  assert.equal(b.expired, true);
  assert.equal(b.wallMin, 24);
  assert.equal(loadScaledBudget({ budgetMin: 24, samples: flat(10, 23.5, 0.5), ref: 18 }).expired, false);
});

// gate-runs/20261119-140508-change (v0.86.0's change gate): unit-sidecar started 14:30:17, killed at 15m17s; machine.jsonl load1
// every 30 s over its run (mean ~36 on 18 cores)
const SIDECAR_0860 = [41.6, 42.6, 42.6, 39, 40.3, 42.5, 38.2, 38.7, 34.7, 34.5, 36.7, 35.7, 38.2, 40.2, 40.8, 53.5, 48.5, 48, 44.8, 41.9,
  34.1, 32.2, 27.7, 27.5, 23, 23.3, 25.1, 28, 23, 24.3, 33.6, 38.7];
const replay = (loads, n) => loads.slice(0, n).map((load1, i) => ({ t: i * 0.5 * MIN, load1 }));

test("v0.86.0's unit-sidecar (load 23-54 for 15 min): ref 72 spent the whole 15 min; ref 18 (the cores) spends about half", () => {
  const at15 = replay(SIDECAR_0860, 31); // 15 wall minutes
  assert.equal(loadScaledBudget({ budgetMin: 15, samples: at15, ref: 72 }).expired, true, 'the old ref: killed at 15');
  const b = loadScaledBudget({ budgetMin: 15, samples: at15, ref: 18 });
  assert.equal(b.expired, false);
  assert.ok(b.usedMin > 6 && b.usedMin < 9, `about half the budget spent (${b.usedMin})`);
  // still bounded: the same load held on, a hang ends at the 2x wall cap
  const hang = loadScaledBudget({ budgetMin: 15, samples: flat(36, 30), ref: 18 });
  assert.equal(hang.expired, true);
  assert.match(hang.why, /wall cap 30 min|budget 15 min spent/);
  // and with its new limit (history 2 x p90 = 24 min), at most 48 wall minutes
  assert.equal(loadScaledBudget({ budgetMin: 24, samples: flat(400, 48), ref: 18 }).expired, true);
  assert.equal(loadScaledBudget({ budgetMin: 24, samples: flat(400, 47.5, 0.5), ref: 18 }).expired, false);
});

test('timeoutRecord / timeoutNote: elapsed, the limit and its source, the load at the kill; says TIMEOUT, not FAIL', () => {
  const ls = loadScaledBudget({ budgetMin: 15, samples: flat(36, 30), ref: 18 });
  const t = timeoutRecord({ startedMs: 1_000, killedMs: 1_000 + 917_000, limitMin: 15, source: 'configured', loadavg: [34.11, 38.72, 45.04], loadScale: ls });
  assert.equal(t.elapsedSeconds, 917);
  assert.deepEqual(t.load, { load1: 34.1, load5: 38.7, load15: 45 });
  assert.equal(t.loadScaled.ref, 18);
  const n = timeoutNote(t);
  assert.match(n, /^killed at its timeout after 15m17s wall \(limit 15 min, configured\)/);
  assert.match(n, /load at the kill 34.1 \/ 38.7 \/ 45 \(1\/5\/15 min\)/);
  assert.match(n, /load-scaled: [\d.]+ of 15 budget min spent, mean load 36, ref 18, wall cap 30 min/);
  assert.match(n, /a TIMEOUT, not a test FAIL$/);
  const plain = timeoutRecord({ startedMs: 0, killedMs: 45_000, limitMin: 10, loadavg: [5, 6, 7] });
  assert.equal(plain.loadScaled, undefined);
  assert.equal(timeoutNote(plain), 'killed at its timeout after 45s wall (limit 10 min); load at the kill 5 / 6 / 7 (1/5/15 min); a TIMEOUT, not a test FAIL');
  assert.equal(timeoutNote(null), '');
});

test('gate-run.mjs records the timeout at the kill and prints it in runner.log and SUMMARY.md', () => {
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'gate-run.mjs'), 'utf8');
  assert.match(src, /timeout = timeoutRecord\(\{ startedMs, killedMs: Date\.now\(\)/);
  assert.match(src, /log\(`  TIMEOUT: \$\{timeoutNote\(timeout\)\}/);
  assert.match(src, /if \(r\.timeout\) rec\.timeout = r\.timeout;/);
  assert.match(src, /last output before the kill/);
  assert.match(src, /loadScaleFor\(cfg, id, \{ max1: cfg\.slots\?\.load\?\.max1, cores: machineCores\(\) \}\)/);
});
