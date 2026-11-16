// (GR-b) Load-scaled step timeouts (tools/lib/load-timeout.mjs, docs/GATES.md "Kit suite once per run"): below ref a wall minute
// spends a full budget minute; above it, ref / load; a wall cap of maxFactor (<= 2) x the budget bounds it; only the listed steps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadScaleFor, loadScaledBudget } from '../../tools/lib/load-timeout.mjs';

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

test('loadScaleFor: only the listed steps (a split part takes its parent), ref at least 72; the chain config lists the three suites', () => {
  const cfg = { timeoutLoadScale: { steps: ['unit-kit'], maxFactor: 5 } };
  assert.deepEqual(loadScaleFor(cfg, 'unit-kit', { max1: 0 }), { ref: 72, maxFactor: 2 });
  assert.deepEqual(loadScaleFor(cfg, 'unit-kit/p2', { max1: 90 }), { ref: 90, maxFactor: 2 });
  assert.equal(loadScaleFor(cfg, 'd-unit'), null);
  assert.equal(loadScaleFor({}, 'unit-kit'), null);
  const chains = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'gate-chains.json'), 'utf8'));
  for (const id of ['unit-kit', 'unit-sidecar', 'unit-scope']) assert.ok(loadScaleFor(chains, id, { max1: chains.slots.load.max1 }), id);
  for (const id of chains.timeoutLoadScale.steps) assert.ok(chains.steps[id], `${id} is a step`);
});
