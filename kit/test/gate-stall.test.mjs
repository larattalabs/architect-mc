// tools/lib/stall-watch.mjs: a step stalled after a functional FAIL (docs/GATES.md "Stalled after a FAIL").
import test from 'node:test';
import assert from 'node:assert/strict';
import { isFunctionalFail, stallMinutes, stallWatch } from '../../tools/lib/stall-watch.mjs';

const MIN = 60_000;

test('a driver check FAIL is functional; a test runner\'s indented FAIL and a recorded BAR are not', () => {
  assert.equal(isFunctionalFail('[05:54:11] FAIL cliff_east sampled to its own sha undefined'), true);
  assert.equal(isFunctionalFail('FAIL plain'), true);
  assert.equal(isFunctionalFail(' FAIL  test/a.test.ts > b'), false);
  assert.equal(isFunctionalFail('[05:54:11] ok   fine'), false);
  assert.equal(isFunctionalFail('[05:54:11] FAIL BAR mspt 60 > 50', { barsRecorded: true }), false);
  assert.equal(isFunctionalFail('[05:54:11] FAIL BAR mspt 60 > 50', { barsRecorded: false }), true);
  assert.equal(isFunctionalFail('FAILED (3)'), false);
});

test('the ST case: a FAIL, then silence past the limit -> stalled; before the limit -> not', () => {
  const t0 = 1_000_000;
  const w = stallWatch({ idleMs: 5 * MIN, now: t0 });
  w.feed('[05:54:10] ok   the locked picker refuses another fit\n', t0 + 1000);
  w.feed('[05:54:11] FAIL cliff_east sampled to its own sha undefined, the frame proposed\n', t0 + 2000);
  assert.equal(w.check(t0 + 2000 + 5 * MIN - 1), null);
  const st = w.check(t0 + 2000 + 5 * MIN);
  assert.match(st.failLine, /cliff_east sampled/);
  assert.equal(st.idleMs, 5 * MIN);
  assert.equal(st.failAt, t0 + 2000);
});

test('silence without a FAIL is never a stall (a long quiet build or scenario keeps its timeout)', () => {
  const w = stallWatch({ idleMs: 5 * MIN, now: 0 });
  w.feed('[00:00:01] ok   started\n', 0);
  assert.equal(w.check(60 * MIN), null);
});

test('any output after the FAIL resets the clock: a driver still working is not stuck', () => {
  const w = stallWatch({ idleMs: 5 * MIN, now: 0 });
  w.feed('FAIL first\n', 0);
  w.feed('  waiting for the variant ...\n', 4 * MIN);
  assert.equal(w.check(8 * MIN), null);
  assert.ok(w.check(9 * MIN));
});

test('a recorded BAR miss does not arm it; a later functional FAIL does', () => {
  const w = stallWatch({ idleMs: MIN, barsRecorded: true, now: 0 });
  w.feed('FAIL BAR own-tick max 80 ms > 50\n', 0);
  assert.equal(w.check(10 * MIN), null);
  w.feed('FAIL the exact removal\n', 10 * MIN);
  assert.ok(w.check(11 * MIN));
});

test('lines split across chunks, and a FAIL with no newline yet, are still seen', () => {
  const w = stallWatch({ idleMs: MIN, now: 0 });
  w.feed('ok a\nFA', 0);
  w.feed('IL split line\n', 1);
  assert.ok(w.check(MIN + 1));
  const w2 = stallWatch({ idleMs: MIN, now: 0 });
  w2.feed('FAIL no newline', 0);
  assert.ok(w2.check(MIN));
});

test('off: idleMs 0, and the step/config/default minutes', () => {
  const w = stallWatch({ idleMs: 0, now: 0 });
  w.feed('FAIL x\n', 0);
  assert.equal(w.check(1e9), null);
  assert.equal(stallMinutes({}, {}), 5);
  assert.equal(stallMinutes({}, { stallAfterFailMin: 3 }), 3);
  assert.equal(stallMinutes({ stallAfterFailMin: 12 }, { stallAfterFailMin: 3 }), 12);
  assert.equal(stallMinutes({ stallAfterFailMin: false }, {}), 0);
  assert.equal(stallMinutes({ stallAfterFailMin: 0 }, {}), 0);
});
