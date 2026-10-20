// plan-p0 item 1 (docs/CONTRACT.md "Phase 6c slice P0" §8): the valid/ fixtures, split out of plan-p0.test.mjs (housekeeping 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stewardAnchors } from './plan-helpers.mjs';
import { validatePlan } from '../lib/plan/schema.mjs';
import { read, svOf, run } from './plan-p0-shared.mjs';

test('item 1: valid/ fixtures (at least 12) validate and every part fits', async () => {
  const fx = read('valid');
  assert.ok(fx.length >= 12, `${fx.length} valid fixtures`);
  for (const f of fx) {
    const v = validatePlan(f.plan, { anchors: Object.keys({ ...stewardAnchors(svOf(f).claim), ...(f.anchors ?? {}) }) });
    assert.equal(v.malformed, null, `${f.name}: ${JSON.stringify(v.malformed)}`);
    for (const p of v.parts) assert.equal(p.verdict, 'compile', `${f.name} ${p.id}: ${p.verdict} ${JSON.stringify(p.reason)}`);
    const r = await run(f);
    assert.equal(r.check.overall, 'READY', `${f.name}: ${r.check.overall}`);
    // ((6c VOC-c) a fixture may name parts that answer adjusted by design: v65's "no wood" rule, re-planned with its swaps)
    for (const a of r.check.parts) assert.equal(a.class, (f.adjusted ?? []).includes(a.part) ? 'adjusted' : 'fits', `${f.name} ${a.part}: ${a.class} ${JSON.stringify(a.reasons ?? a.deviations)}`);
    assert.match(r.artifactSha, /^[0-9a-f]{64}$/);
  }
});
