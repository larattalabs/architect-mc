// (7c PAY) The paid batch's ledger rules (tools/lib/pay-ledger.mjs): Noah's $65 hard cap, the 1.2 x share stop, P1's job budgets inside
// its $6 ceiling, a running job counted at its cap, one retry per item charged to R, the claude login only, the nightly window, P6's $50
// rule and the restatement table.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as P from '../../tools/lib/pay-ledger.mjs';

const DAY = new Date('2026-11-15T14:00:00');
const AUTH = 'claude login (subscription)';
const g = (L, o) => P.guard(L, { now: DAY, authSource: AUTH, ...o });

test('ceilings: min(cap, 1.2 x share); P1 is $6; P1 budgets sum to it', () => {
  assert.equal(P.HARD_CAP_USD, 65);
  assert.deepEqual(Object.fromEntries(P.PAID_ORDER.map((k) => [k, P.ceilingOf(k)])), { P1: 6, P2: 34.8, P3: 13.2, P4: 3.6, P5: 3.6, P6: 7.2, R: 8 });
  assert.equal(3 * P.P1_BUDGETS.compose + P.P1_BUDGETS.style, 6);
  const shares = P.PAID_ORDER.reduce((a, k) => a + P.ITEMS[k].shareUsd, 0);
  assert.equal(shares, 65);
});

test('P1: four jobs open at once fit; a fifth stops at the 1.2 x share; an answer for exactly that step lets it pass up to the cap', () => {
  const L = P.emptyLedger();
  for (const [i, cap] of [P.P1_BUDGETS.compose, P.P1_BUDGETS.compose, P.P1_BUDGETS.compose, P.P1_BUDGETS.style].entries()) {
    assert.equal(g(L, { item: 'P1', step: `P1:${i}`, capUsd: cap }).ok, true);
    P.openJob(L, { item: 'P1', step: `P1:${i}`, capUsd: cap, authSource: AUTH });
  }
  assert.equal(L.committedUsd, 6);
  const s = g(L, { item: 'P1', step: 'P1:extra', capUsd: 0.5 });
  assert.equal(s.kind, 'stop');
  assert.equal(s.report.itemCeilingUsd, 6);
  L.answers.push({ step: 'P1:extra', yes: true });
  assert.equal(g(L, { item: 'P1', step: 'P1:extra', capUsd: 0.5 }).ok, true);
  assert.equal(g(L, { item: 'P1', step: 'P1:extra', capUsd: 1.5 }).kind, 'refuse'); // past the $7 cap: no answer passes it
  // a finished job counts its reported cost, not its cap
  P.updateJob(L, 'P1:0', { usd: 0.4, ended: true });
  assert.equal(L.committedUsd, 5.2);
});

test('the $65 hard cap refuses (no answer approves it)', () => {
  const L = P.emptyLedger();
  L.jobs.push({ item: 'P2', step: 'x', capUsd: 34, usd: 34, ended: true, chargedTo: 'P2' }, { item: 'P3', step: 'y', capUsd: 13, usd: 13, ended: true, chargedTo: 'P3' }, { item: 'R', step: 'z', capUsd: 8, usd: 8, ended: true, chargedTo: 'R' }, { item: 'P6', step: 'w', capUsd: 7, usd: 7, ended: true, chargedTo: 'P6' });
  L.answers.push({ step: 'P4:a', yes: true });
  const r = g(P.tally(L), { item: 'P4', step: 'P4:a', capUsd: 3.5 });
  assert.equal(r.kind, 'refuse');
  assert.match(r.message, /\$65 hard cap/);
});

test('one retry per item, charged to R; keys, auth and the nightly window refuse', () => {
  const L = P.emptyLedger();
  assert.equal(g(L, { item: 'P1', step: 'P1:r', capUsd: 1, retry: true }).ok, true);
  P.openJob(L, { item: 'P1', step: 'P1:r', capUsd: 1, retry: true });
  assert.equal(L.items.R.committedUsd, 1);
  assert.equal(L.items.P1.committedUsd, 0);
  assert.equal(g(L, { item: 'P1', step: 'P1:r2', capUsd: 1, retry: true }).kind, 'retry');
  assert.equal(g(L, { item: 'P1', step: 'k', capUsd: 1, envKeys: ['ANTHROPIC_API_KEY'] }).kind, 'refuse');
  assert.equal(g(L, { item: 'P1', step: 'k', capUsd: 1, authSource: 'api key' }).kind, 'refuse');
  assert.equal(P.guard(L, { item: 'P1', step: 'k', capUsd: 1, authSource: null, now: DAY }).kind, 'refuse');
  assert.equal(g(L, { item: 'P1', step: 'k', capUsd: 1, now: new Date('2026-11-15T02:00:00') }).kind, 'window');
  assert.equal(g(L, { item: 'P0', step: 'k', capUsd: 1 }).kind, 'refuse');
  assert.equal(g(L, { item: 'P1', step: 'k', capUsd: 0 }).kind, 'refuse');
  assert.deepEqual(Object.keys(P.scrubbedEnv({ ANTHROPIC_API_KEY: 'x', ANTHROPIC_BASE_URL: 'y', CLAUDE_CODE_X: 'z', PATH: '/bin' })), ['PATH']);
});

test('restatement per unit cost; P6 eligibility; the ledger file round-trips under the lock', () => {
  const L = P.emptyLedger();
  L.jobs.push({ item: 'P1', step: 'a', capUsd: 1.2, usd: 3, ended: true, chargedTo: 'P1' });
  const rs = P.restate(P.tally(L), { composeUsd: 1, styleUsd: 1.5, pickUsd: 0.05, designUsd: 4, authorUsd: 5.5, compositeUsd: 6 });
  assert.equal(rs.items.P2.newEstUsd, 6 * 0.05 + 6 * 1.5 + 2 * 1 + 4 * 4);
  assert.equal(rs.items.P4.newEstUsd, 2);
  assert.equal(rs.items.P3.newEstUsd, 11);
  assert.equal(rs.totalEstUsd, 3 + 27.3 + 11 + 2 + 3 + 6);
  assert.equal(P.estimateOf(L, 'P2'), 27.3);
  assert.equal(P.p6Eligible(L), true);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pay-ledger-')), 'spend.json');
  P.withLedger(f, (x) => P.openJob(x, { item: 'P1', step: 's', capUsd: 2.4 }));
  assert.equal(P.readLedger(f).committedUsd, 2.4);
  assert.equal(fs.existsSync(`${f}.lock`), false);
});
