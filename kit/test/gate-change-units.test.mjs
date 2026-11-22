// tools/lib/change-units.mjs (GI2): the change tier runs unit-scope; a full suite joins only for a step that waits for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeChangeUnits } from '../../tools/lib/change-units.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sel = (ids, reasons, steps) => {
  const want = new Set(ids);
  const why = Object.fromEntries(ids.map((i) => [i, reasons[i] ?? ['x']]));
  const addW = (s, r) => { want.add(s); (why[s] ??= []).push(r); };
  scopeChangeUnits({ want, why, steps, addW });
  return { want: [...want].sort(), why };
};

test('impact-named full suites become unit-scope; a step waiting for one keeps it', () => {
  const steps = { 'api-compat': { waitFor: ['unit-mod'] }, 'w-unit': { waitFor: ['unit-kit', 'unit-sidecar'] }, 'sim-jobs': {} };
  const a = sel(['unit-kit', 'unit-mod', 'sim-jobs'], { 'unit-kit': ['impact rule "kit" (change)'] }, steps);
  assert.deepEqual(a.want, ['sim-jobs', 'unit-scope']);
  assert.match(a.why['unit-scope'].join('\n'), /impact rule "kit" \(change\) -> unit-kit/);
  const b = sel(['unit-kit', 'api-compat', 'w-unit'], {}, steps);
  assert.deepEqual(b.want, ['api-compat', 'unit-kit', 'unit-mod', 'unit-scope', 'unit-sidecar', 'w-unit']);
  assert.match(b.why['unit-mod'][0], /api-compat waits for it/);
});

test('the chain config: change runs unit-scope (uncacheable), slice and release keep the full suites', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/gate-chains.json'), 'utf8'));
  const cache = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/gate-cache.json'), 'utf8'));
  assert.deepEqual(cfg.tiers.change.always, ['unit-scope']);
  assert.deepEqual(cfg.tiers.change.fallback, ['unit-scope']);
  for (const t of ['slice', 'release']) for (const u of ['unit-mod', 'unit-kit', 'unit-sidecar']) assert.ok(cfg.tiers[t].always.includes(u), `${t} ${u}`);
  assert.match(cfg.steps['unit-scope'].shell, /tools\/unit-scope\.mjs --run/);
  assert.match(cfg.steps['unit-scope'].shell, /GATE_CHANGED_FILES/);
  assert.ok(cache.uncacheable['unit-scope']);
});

test('(SPD) fullUnitsInRun: the full unit steps in the run or CACHED, in a fixed order; nothing else', async () => {
  const { fullUnitsInRun } = await import('../../tools/lib/change-units.mjs');
  assert.deepEqual(fullUnitsInRun(['unit-scope', 'sim-jobs']), []);
  assert.deepEqual(fullUnitsInRun(['unit-scope', 'unit-kit', 'd-unit']), ['unit-kit']);
  assert.deepEqual(fullUnitsInRun(['unit-sidecar'], new Set(['unit-mod'])), ['unit-mod', 'unit-sidecar']);
});
