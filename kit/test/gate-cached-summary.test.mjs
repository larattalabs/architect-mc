// tools/lib/cached-summary.mjs (GI2): an all-CACHED gate-run leaves summary.json (state done, so a waiter wakes) and SUMMARY.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cachedTableLines, writeAllCachedSummary } from '../../tools/lib/cached-summary.mjs';
import { archTmpDir } from '../../tools/lib/arch-tmp.mjs';

const hits = [{ id: 'unit-kit', key: 'k1'.repeat(8), at: '2026-11-15T01:00:00Z', head: '91ce29bfdeadbeef', run: '/x/artifacts/gate-runs/20261115-010000-change', log: 'unit-kit.log' }];

test('an all-CACHED run writes summary.json (done, PASS, no steps) and SUMMARY.md with the CACHED table', () => {
  const out = path.join(archTmpDir('cached-summary'), '20261115-120000-change');
  const w = writeAllCachedSummary(out, { chain: 'change', head: '91ce29bfdeadbeef', range: 'origin/main...HEAD', cached: hits });
  const s = JSON.parse(fs.readFileSync(w.json, 'utf8'));
  assert.equal(s.state, 'done');
  assert.equal(s.verdict, 'PASS');
  assert.deepEqual(s.steps, []);
  assert.equal(s.allCached, true);
  const md = fs.readFileSync(w.md, 'utf8');
  assert.match(md, /every selected step CACHED/);
  assert.match(md, /### CACHED \(1\)/);
  assert.match(md, /\| unit-kit \| abcdef012345 \| .* \| `20261115-010000-change` \| `unit-kit.log` \|/);
});

test('cachedTableLines: empty for no hits; the explicit-list note', () => {
  assert.deepEqual(cachedTableLines([]), []);
  assert.match(cachedTableLines(hits, { explicit: true })[1], /an explicit list/);
});
