// tools/lib/bench-report.mjs (docs/GATES.md "Speed rules" 9): a bench past its bound flags and is recorded; it fails only under
// ARCHITECT_TIMING_BARS=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bench, benchRows, withinBound } from '../../tools/lib/bench-report.mjs';

test('within, past, judged: a slow reading flags and is recorded with the load; ARCHITECT_TIMING_BARS=1 throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-bench-'));
  try {
    const lines = [];
    const log = (s) => lines.push(s);
    const a = bench({ id: 't/fast', value: 5, bound: 10 }, { dir, env: {}, log });
    const b = bench({ id: 't/slow', value: 15, bound: 10 }, { dir, env: {}, log });
    const c = bench({ id: 't/rate', value: 50, bound: 90, better: 'higher', unit: 'cells/s' }, { dir, env: {}, log });
    assert.deepEqual([a.ok, b.ok, c.ok], [true, false, false]);
    assert.match(lines[0], /^# bench t\/fast 5 ms/);
    assert.match(lines[1], /^FLAG bench t\/slow 15 ms \(bound <= 10; 1-min load [\d.]+ on \d+ cores\): past its bound/);
    assert.throws(() => bench({ id: 't/judged', value: 15, bound: 10 }, { dir, env: { ARCHITECT_TIMING_BARS: '1' }, log }), /ARCHITECT_TIMING_BARS=1/);
    const rows = benchRows([dir, path.join(dir, 'missing')]);
    assert.deepEqual(rows.map((r) => r.id), ['t/fast', 't/slow', 't/rate', 't/judged']);
    assert.ok(rows.every((r) => typeof r.load1 === 'number' && r.cpus > 0));
    assert.equal(benchRows([dir], '2999-01-01T00:00:00.000Z').length, 0, 'since filters');
    assert.equal(withinBound(10, 10), true);
    assert.equal(withinBound(89, 90, 'higher'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
