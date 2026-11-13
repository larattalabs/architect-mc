// (7b PA) The paid batch's ledger rules (tools/lib/pa-ledger.mjs, docs/CONTRACT.md "Phase 7b" §4 "Rules"). Pure; no paid call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as P from '../../tools/lib/pa-ledger.mjs';

const day = (h, m) => new Date(2026, 10, 12, h, m);
const at4pm = day(16, 0);

test('job shares are the item cap over its jobs', () => {
  assert.equal(P.jobShare('P1'), 5);
  assert.equal(P.jobShare('P2'), 5.666667);
  assert.equal(P.jobShare('P4'), 5);
  assert.equal(P.jobShare('R'), 3.5);
  assert.throws(() => P.jobShare('P0'));
  // §4's caps sum (without R and P5) stays under the $60 budget, so the planned order never stops by itself
  assert.ok(['P1', 'P2', 'P3', 'P4'].reduce((a, k) => a + P.ITEMS[k].capUsd, 0) <= P.BUDGET_USD);
});

test('a running job counts at its full cap; an ended one at its reported cost', () => {
  const L = P.emptyLedger();
  P.openJob(L, { item: 'P1', step: 'P1:cliff', capUsd: 5 });
  assert.equal(P.committed(L), 5);
  assert.equal(P.spent(L), 0);
  P.updateJob(L, 'P1:cliff', { usd: 1.2 });
  assert.equal(P.committed(L), 5, 'still running: the cap');
  P.updateJob(L, 'P1:cliff', { usd: 3.4, ended: true, status: 'done' });
  assert.equal(P.committed(L), 3.4);
  assert.equal(P.spent(L), 3.4);
  assert.equal(L.items.P1.spentUsd, 3.4);
});

test('the $60 stop and the $90 refusal', () => {
  const L = P.emptyLedger();
  for (let i = 0; i < 11; i++) { P.openJob(L, { item: 'P2', step: `x${i}`, capUsd: 5 }); P.updateJob(L, `x${i}`, { usd: 5, ended: true }); }
  assert.equal(P.committed(L), 55);
  assert.deepEqual(P.guard(L, { item: 'P3', step: 'P3:a', capUsd: 5, now: at4pm }), { ok: true });
  const s = P.guard(L, { item: 'P3', step: 'P3:b', capUsd: 5.67, now: at4pm });
  assert.equal(s.ok, false);
  assert.equal(s.kind, 'stop');
  assert.equal(s.report.step, 'P3:b');
  assert.equal(s.report.spentUsd, 55);
  assert.ok(s.report.skippedOnNo.includes('P3') && s.report.skippedOnNo.includes('R'));
  // an answer for exactly that step lets it pass; another step still stops
  L.answers.push({ step: 'P3:b', yes: true, at: 'now', text: 'Noah: yes' });
  assert.deepEqual(P.guard(L, { item: 'P3', step: 'P3:b', capUsd: 5.67, now: at4pm }), { ok: true });
  assert.equal(P.guard(L, { item: 'P3', step: 'P3:c', capUsd: 5.67, now: at4pm }).kind, 'stop');
  // the hard cap refuses even with an answer
  for (let i = 0; i < 7; i++) { P.openJob(L, { item: 'R', step: `y${i}`, capUsd: 5 }); P.updateJob(L, `y${i}`, { usd: 5, ended: true }); }
  L.answers.push({ step: 'P3:z', yes: true });
  const h = P.guard(L, { item: 'P3', step: 'P3:z', capUsd: 5, now: at4pm });
  assert.equal(h.kind, 'refuse');
  assert.match(h.message, /\$90 hard cap/);
});

test('claude login only; no key in the environment', () => {
  const L = P.emptyLedger();
  assert.equal(P.guard(L, { item: 'P1', step: 's', capUsd: 5, now: at4pm, envKeys: ['ANTHROPIC_API_KEY'] }).kind, 'refuse');
  assert.equal(P.guard(L, { item: 'P1', step: 's', capUsd: 5, now: at4pm, authSource: 'api key (ANTHROPIC_API_KEY)' }).kind, 'refuse');
  assert.equal(P.guard(L, { item: 'P1', step: 's', capUsd: 5, now: at4pm, authSource: 'claude login' }).ok, true);
});

test('the nightly window refuses a paid step that starts in it or would reach it', () => {
  assert.equal(P.inNightly(day(1, 29)), false);
  assert.equal(P.inNightly(day(1, 30)), true);
  assert.equal(P.inNightly(day(3, 29)), true);
  assert.equal(P.inNightly(day(3, 30)), false);
  assert.equal(P.inNightly(day(0, 50), 45), true, 'a 45-min step from 00:50 reaches 01:30');
  assert.equal(P.inNightly(day(0, 40), 45), false);
  assert.equal(P.inNightly(day(23, 50), 120), true);
  const L = P.emptyLedger();
  assert.equal(P.guard(L, { item: 'P2', step: 's', capUsd: 5, now: day(2, 0) }).kind, 'window');
});

test('at most one retry per item, charged to R', () => {
  const L = P.emptyLedger();
  P.openJob(L, { item: 'P2', step: 'P2:a', capUsd: 5 });
  P.updateJob(L, 'P2:a', { usd: 5, ended: true, status: 'budget' });
  assert.equal(P.guard(L, { item: 'P2', step: 'P2:a#retry', capUsd: 3.5, retry: true, now: at4pm }).ok, true);
  P.openJob(L, { item: 'P2', step: 'P2:a#retry', capUsd: 3.5, retry: true });
  P.updateJob(L, 'P2:a#retry', { usd: 2, ended: true });
  assert.equal(L.items.R.spentUsd, 2);
  assert.equal(L.items.P2.spentUsd, 5);
  assert.equal(P.guard(L, { item: 'P2', step: 'P2:b#retry', capUsd: 3.5, retry: true, now: at4pm }).kind, 'retry');
});

test('the re-statement from P1 and the over-estimate flag', () => {
  const L = P.emptyLedger();
  const r = P.restate(L, [5, 6, 7]);
  assert.equal(r.p1MeanUsd, 6);
  assert.equal(r.factor, 1.5);
  assert.equal(r.items.P2.estUsd, 19.5);
  assert.equal(r.items.P2.estOverCap, true);
  assert.equal(r.siteMultiplier, 2.068966);
  assert.equal(P.estimateOf(L, 'P2'), 19.5);
  P.openJob(L, { item: 'P1', step: 'p', capUsd: 15 });
  P.updateJob(L, 'p', { usd: 18.5, ended: true });
  assert.equal(L.items.P1.overEstimate50, true);
});

test('P5 only at <= $50 after P4', () => {
  const L = P.emptyLedger();
  P.openJob(L, { item: 'P1', step: 'a', capUsd: 50 });
  P.updateJob(L, 'a', { usd: 50, ended: true });
  assert.equal(P.p5Eligible(L), true);
  P.openJob(L, { item: 'P4', step: 'b', capUsd: 1 });
  P.updateJob(L, 'b', { usd: 0.01, ended: true });
  assert.equal(P.p5Eligible(L), false);
});

test('the A/B sides are recorded per pair and follow the random bit', () => {
  const bits = [0, 1];
  const k = P.abSides(['a1', 'a2'], () => bits.shift());
  assert.deepEqual(k, { a1: { A: 'on', B: 'off' }, a2: { A: 'off', B: 'on' } });
  const k2 = P.abSides(['x', 'y', 'z']);
  for (const v of Object.values(k2)) assert.deepEqual(new Set([v.A, v.B]), new Set(['on', 'off']));
});

test('the ledger files: the phase ledger and each item\'s copy, under a lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ledger-'));
  const f = path.join(dir, 'spend.json');
  P.withLedger(f, (L) => { P.openJob(L, { item: 'P1', step: 'P1:cliff', capUsd: 5 }); P.updateJob(L, 'P1:cliff', { usd: 3, ended: true }); });
  const L = P.readLedger(f);
  assert.equal(L.totalUsd, 3);
  const item = JSON.parse(fs.readFileSync(path.join(dir, 'P1', 'spend.json'), 'utf8'));
  assert.equal(item.spentUsd, 3);
  assert.equal(item.jobs.length, 1);
  assert.equal(fs.existsSync(`${f}.lock`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
