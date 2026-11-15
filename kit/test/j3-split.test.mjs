// tools/lib/j3-split.mjs (GI2): j3-ingame's "the split" compares every mod's part of today's spend, so another owner (sim-sets' apitest:)
// in the same run dir no longer fails it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedByMod, ownerMod, splitDiffs } from '../../tools/lib/j3-split.mjs';

test('ownerMod: as lab-ui JobCost.ownerMod (namespace, a colon-less owner as is, none the publisher)', () => {
  assert.equal(ownerMod('steward_mc:settlement/7'), 'steward_mc');
  assert.equal(ownerMod('apitest:village/1'), 'apitest');
  assert.equal(ownerMod(''), 'architect_mc');
  assert.equal(ownerMod(null), 'architect_mc');
  assert.equal(ownerMod('stewardish'), 'stewardish');
  assert.equal(ownerMod(':odd'), ':odd');
});

test('the split with only Steward and Architect, and with an apitest owner beside them', () => {
  const base = [{ usd: 0.03, owner: '' }, { usd: 0.2, owner: 'steward_mc:settlement/7' }, { usd: 0.01, owner: 'architect_mc:x' }];
  const e1 = expectedByMod(base);
  assert.ok(Math.abs(e1.architect_mc - 0.04) < 1e-9 && Math.abs(e1.steward_mc - 0.2) < 1e-9);
  assert.equal(splitDiffs({ architect_mc: 0.04, steward_mc: 0.2 }, e1).ok, true);
  // sim-sets ran first in this run dir: an apitest owner spends today too (the failing case)
  const withApitest = [...base, { usd: 0.6, owner: 'apitest:village/1' }];
  const panel = { architect_mc: 0.04, steward_mc: 0.2, apitest: 0.6 };
  assert.equal(splitDiffs(panel, expectedByMod(withApitest)).ok, true);
  // a real mismatch is still caught, per mod
  const bad = splitDiffs({ architect_mc: 0.64, steward_mc: 0.2 }, expectedByMod(withApitest));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.diffs.map((d) => d.mod), ['apitest', 'architect_mc']);
});
