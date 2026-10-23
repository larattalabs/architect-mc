// plan-p0 item 11: Steward's 59 recorded plans, split out of plan-p0.test.mjs (housekeeping 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stewardAnchors, checkPlanLocal } from './plan-helpers.mjs';
import { PLAN_SCHEMA } from '../lib/plan/schema.mjs';
import { fileURLToPath } from 'node:url';
import { read, A } from './plan-p0-shared.mjs';
import { asksPlanner } from '../../tools/lib/corpus-plan.mjs'; // (speed audit A) the 59 plans from the run's shared store inside a gate run

test('item 11: Steward\'s 59 recorded plans (whole files, fixtures/plan/asks): no crash, none malformed, answer.waits unsupported or blocked; the gap table', async () => {
  const fx = read('asks');
  assert.equal(fx.length, 59);
  // (7a K1, item 15) the oracle skips a part whose block the current catalogue supports (it was recorded waiting on it); K1's
  // recorded parts table judges those (kit/test/plan-k1.test.mjs)
  const supported = new Set(PLAN_SCHEMA['x-catalogue'].entries.filter((e) => e.state === 'supported').map((e) => e.id));
  const tally = {}, gaps = {}, other = [];
  const anchors = stewardAnchors(A.claim);
  // (this loop reads each check's parts only; the determinism tests keep planning for themselves)
  const planAsk = await asksPlanner(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  for (const f of fx) {
    const r = await planAsk(f.answer.plan);
    assert.notEqual(r.check.overall, 'MALFORMED', f.name);
    const waits = new Set((f.answer.waits ?? []).map((w) => w.part));
    for (const a of r.check.parts) {
      tally[a.class] = (tally[a.class] ?? 0) + 1;
      if (a.class === 'unsupported') gaps[a.block] = (gaps[a.block] ?? 0) + 1;
      assert.notEqual(a.class, 'malformed', `${f.name} ${a.part}: ${JSON.stringify(a.reasons)}`);
      if (waits.has(a.part) && !supported.has(a.block)) assert.ok(['unsupported', 'blocked'].includes(a.class), `${f.name} ${a.part} waits but ${a.class}`);
      else if (!['fits', 'adjusted'].includes(a.class)) other.push(`${f.name.replace('.json', '')}/${a.part}: ${a.class} ${a.reasons?.[0]?.code ?? ''}`);
    }
  }
  const rows = Object.entries(gaps).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  console.log(`# 59 asks: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log('# gap table (unsupported parts per block id):');
  for (const [k, v] of rows) console.log(`#   ${k.padEnd(24)} ${v}`);
  console.log(`# parts outside answer.waits that did not fit (${other.length}): ${other.join('; ')}`);
  assert.ok(tally.unsupported > 0 && tally.fits > 0);
});
