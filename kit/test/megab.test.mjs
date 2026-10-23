// (6c close-out B) mega_bench B's "REGION_PROGRESS events for every stage" row (tools/lib/megab.mjs): an empty stage is skipped and
// named, a stage with items and no event fails. The events are the v0.41.0 release run's (gate-runs-0410/20261022-043748-release).
import test from 'node:test';
import assert from 'node:assert/strict';
import { stageEvents, stageItems } from '../../tools/lib/megab.mjs';

const ev = (what) => ({ event: 'REGION_PROGRESS', id: 'rg1', what });
const run = [
  ev('PLACING ground:PLACING ways:APPROVED lots-1:APPROVED lots-2:APPROVED lots-3:APPROVED lots-4:APPROVED'),
  ev('PLACING ground:PLACED ways:PLACING lots-1:APPROVED lots-2:APPROVED lots-3:APPROVED lots-4:APPROVED'),
  ev('PLACING ground:PLACED ways:PLACED lots-1:PLACING lots-2:APPROVED lots-3:APPROVED lots-4:APPROVED'),
  ev('PLACING ground:PLACED ways:PLACED lots-1:PLACED lots-2:PLACING lots-3:APPROVED lots-4:APPROVED'),
  ev('PLACING ground:PLACED ways:PLACED lots-1:PLACED lots-2:PLACED lots-3:PLACING lots-4:APPROVED'),
  { event: 'REGION_PROGRESS', id: 'rg2', what: 'PLACING lots-4:PLACING' },
];
// the release run's walk: 256, 45, 50, 50, 44, 0 items
const items = { ground: 256, ways: 45, 'lots-1': 50, 'lots-2': 50, 'lots-3': 44, 'lots-4': 0 };

test('an empty stage (mega_bench lots-4) is skipped and named; the row passes', () => {
  const r = stageEvents(items, run, 'rg1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.skipped, ['lots-4']);
  assert.deepEqual(r.silent, []);
});

test('a stage with items and no PLACING/PLACED event fails the row (never hidden)', () => {
  const r = stageEvents({ ...items, 'lots-4': 3 }, run, 'rg1');
  assert.equal(r.ok, false);
  assert.deepEqual(r.silent, ['lots-4']);
  const r2 = stageEvents(items, run.slice(0, 3), 'rg1');
  assert.deepEqual(r2.silent, ['lots-2', 'lots-3']);
  assert.equal(r2.ok, false);
});

test('no stage with items at all is not a pass', () => {
  assert.equal(stageEvents({ a: 0 }, [], 'rg1').ok, false);
});

test('stageItems counts terrain and path tiles, 4e roads and lots per stage (a stage of roads alone is not empty)', () => {
  const ir = { stages: ['ground', 'ways', 'lots-1', 'lots-2'], tiles: { ground: { terrain: ['0,0', '0,1'], path: ['1,1'] } }, roads: [{ id: 'r1', stage: 'ways' }],
    lots: [{ stage: 'lots-1' }, { stage: 'lots-1' }] };
  assert.deepEqual(stageItems(ir), { ground: 3, ways: 1, 'lots-1': 2, 'lots-2': 0 });
  assert.deepEqual(stageEvents(stageItems(ir), [], 'rg1').silent, ['ground', 'ways', 'lots-1']);
});
