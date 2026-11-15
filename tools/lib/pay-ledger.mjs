// (7c PAY, docs/CONTRACT.md "Phase 7c" §4) The paid batch's spend ledger and its rules, pure but for the file helpers at the end;
// tools/gate7cpay.mjs (the driver) guards every paid job through it. 7b's tools/lib/pa-ledger.mjs is the model (and stays 7b's).
//
// Noah's approval (2026-11-13, "Approve $65"): $65 in all, a HARD cap (the contract's $120 does not apply to this batch). Shares per item;
// before each paid job:
//   - a key variable in the env, an auth that is not the claude login, or the nightly window (01:30-03:30): refuse
//   - committed + the job's cap > $65: refuse (and STOP.json: the coordinator is told; no answer can approve it)
//   - the item's committed + the job's cap > 1.2 x its share (never past its §4 cap): stop for the coordinator, unless an answer recorded
//     in the ledger approves exactly that step (still never past the item's §4 cap)
//   - a retry: at most one per item, charged to R (R's ceiling then applies)
// "Committed" counts a job still running (or one that ended with no reported cost) at its full cap, so a crash mid-job never lets the
// next step pass a cap unseen. Each job's budgetUsd is its allotted share (P1: 3 composes and 1 Style job summing to its $6 ceiling).
import fs from 'node:fs';
import path from 'node:path';
import { KEY_VARS, NIGHTLY, anthropicNames, inNightly, scrubbedEnv } from './pa-ledger.mjs';

export { KEY_VARS, NIGHTLY, anthropicNames, inNightly, scrubbedEnv };

/** Noah's $65, a hard cap. */
export const HARD_CAP_USD = 65;
/** An item may go past its share by at most this factor before the stop. */
export const SHARE_SLACK = 1.2;
/** P6 runs only when the ledger reads at most this after P5. */
export const P6_GATE_USD = 50;

const r6 = (n) => Math.round(n * 1e6) / 1e6;

/** §4's items: estimate, cap, share (the brief's), and what runs. Estimates of P2-P6 are restated from P1 (restate). */
export const ITEMS = Object.freeze({
  P0: Object.freeze({ estUsd: 0, capUsd: 0, shareUsd: 0, what: 'sim dry runs of every paid item; the prompts diffed (images on/off, references on/off)' }),
  P1: Object.freeze({ estUsd: 5, capUsd: 7, shareUsd: 5, what: 'calibration: the composer on 3 builder-written non-scenario briefs over calibration sites; 1 format 3 settlement Style' }),
  P2: Object.freeze({ estUsd: 29, capUsd: 38, shareUsd: 29, what: 'six briefs: 6 picks, 6 format 3 settlement Styles, the plan path forced on S3 and S6, up to 4 new archetype designs' }),
  P3: Object.freeze({ estUsd: 11, capUsd: 16, shareUsd: 11, what: 'authoring: 2 sessions on builder-written briefs no program fits' }),
  P4: Object.freeze({ estUsd: 3, capUsd: 4, shareUsd: 3, what: "planning images A/B: the composer on S3's and S6's briefs, images off" }),
  P5: Object.freeze({ estUsd: 3, capUsd: 4, shareUsd: 3, what: "Style references A/B: the settlement Style job on two scenarios with Noah's six gpt-image-2 references" }),
  P6: Object.freeze({ estUsd: 6, capUsd: 9, shareUsd: 6, what: "(optional) a Claude composite landmark on S3's summit; only if the ledger reads <= $50 after P5" }),
  R: Object.freeze({ estUsd: 8, capUsd: 8, shareUsd: 8, what: 'reserve: repair re-runs; one retry per item' }),
});
export const PAID_ORDER = Object.freeze(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'R']);

/** An item's ceiling before the stop: min(its §4 cap, 1.2 x its share). P1: $6. */
export const ceilingOf = (item) => r6(Math.min(ITEMS[item].capUsd, ITEMS[item].shareUsd * SHARE_SLACK));

/**
 * P1's jobs and their budgets (summing to P1's $6 ceiling, so every job can be open at once): 3 composes (est. $0.3-1.5 each, images on)
 * and 1 format 3 settlement Style job (est. $1.2-2).
 */
export const P1_BUDGETS = Object.freeze({ compose: 1.2, style: 2.4 });

export function emptyLedger() {
  return { phase: '7c', hardCapUsd: HARD_CAP_USD, totalUsd: 0, committedUsd: 0, items: {}, jobs: [], answers: [], restated: null, notes: [] };
}

export function jobCommitted(j) {
  if (j.ended && typeof j.usd === 'number') return j.usd;
  return Math.max(j.capUsd ?? 0, j.usd ?? 0);
}
const charged = (j) => j.chargedTo ?? j.item;
export const spent = (L) => r6(L.jobs.reduce((a, j) => a + (j.usd ?? 0), 0));
export const committed = (L) => r6(L.jobs.reduce((a, j) => a + jobCommitted(j), 0));
export const itemCommitted = (L, item) => r6(L.jobs.filter((j) => charged(j) === item).reduce((a, j) => a + jobCommitted(j), 0));
export const itemSpent = (L, item) => r6(L.jobs.filter((j) => charged(j) === item).reduce((a, j) => a + (j.usd ?? 0), 0));
export const estimateOf = (L, item) => L.restated?.items?.[item]?.newEstUsd ?? ITEMS[item].estUsd;
export const approved = (L, step) => L.answers.some((a) => a.step === step && a.yes === true);

/**
 * The rule before a paid job: {ok: true} or {ok: false, kind: 'refuse'|'stop'|'window'|'retry', message, report?}.
 * `capUsd` is the job's budgetUsd; `retry` a re-run (charged to R, at most one per item).
 */
export function guard(L, { item, step, capUsd, retry = false, now = new Date(), minutes = 0, authSource = null, envKeys = [] }) {
  if (!ITEMS[item] || item === 'P0') return { ok: false, kind: 'refuse', message: `refusing ${step}: ${item} is not a paid item` };
  if (envKeys.length) return { ok: false, kind: 'refuse', message: `refusing ${step}: ${envKeys.join(', ')} set in the environment (claude login only)` };
  if (authSource === null || !/claude login/i.test(String(authSource))) return { ok: false, kind: 'refuse', message: `refusing ${step}: the helper's auth is "${authSource}", not the claude login` };
  if (inNightly(now, minutes)) return { ok: false, kind: 'window', message: `refusing ${step}: the nightly window ${NIGHTLY.from.join(':')}-${NIGHTLY.to.join(':')} (this step could last ${minutes} min)` };
  if (!(capUsd > 0)) return { ok: false, kind: 'refuse', message: `refusing ${step}: no budgetUsd` };
  if (retry && L.jobs.some((j) => j.item === item && j.retry)) return { ok: false, kind: 'retry', message: `refusing ${step}: ${item} already used its one retry` };
  const c = committed(L);
  if (c + capUsd > HARD_CAP_USD + 1e-9) {
    return { ok: false, kind: 'refuse', message: `refusing ${step}: committed $${c.toFixed(2)} + its cap $${capUsd.toFixed(2)} passes the $${HARD_CAP_USD} hard cap (Noah's approval): report to the coordinator`, report: stopReport(L, { item, step, capUsd }) };
  }
  const to = retry ? 'R' : item;
  const ic = itemCommitted(L, to);
  if (ic + capUsd > ITEMS[to].capUsd + 1e-9) return { ok: false, kind: 'refuse', message: `refusing ${step}: ${to}'s committed $${ic.toFixed(2)} + $${capUsd.toFixed(2)} passes its cap $${ITEMS[to].capUsd}` };
  if (ic + capUsd > ceilingOf(to) + 1e-9 && !approved(L, step)) {
    return { ok: false, kind: 'stop', message: `stop before ${step}: ${to}'s committed $${ic.toFixed(2)} + $${capUsd.toFixed(2)} passes its share $${ITEMS[to].shareUsd} by more than 20% ($${ceilingOf(to)}): ask the coordinator (Noah)`, report: stopReport(L, { item, step, capUsd }) };
  }
  return { ok: true };
}

export function stopReport(L, { item, step, capUsd }) {
  const by = {};
  for (const k of Object.keys(ITEMS)) { const s = itemSpent(L, k); if (s) by[k] = s; }
  return { spentUsd: spent(L), committedUsd: committed(L), spentByItem: by, step, item, estimateUsd: estimateOf(L, item), jobCapUsd: capUsd, itemCeilingUsd: ceilingOf(item), leftToHardCapUsd: r6(HARD_CAP_USD - committed(L)) };
}

export function openJob(L, { item, step, capUsd, retry = false, authSource = null, ref = null }) {
  const j = { item, step, capUsd: r6(capUsd), usd: 0, ended: false, retry: !!retry, chargedTo: retry ? 'R' : item, authSource, ref, startedAt: new Date().toISOString() };
  L.jobs.push(j);
  tally(L);
  return j;
}
export function updateJob(L, step, { usd, ended = false, status = null, ref, error, data } = {}) {
  const j = [...L.jobs].reverse().find((x) => x.step === step);
  if (!j) throw new Error(`no job ${step}`);
  if (typeof usd === 'number') j.usd = r6(usd);
  if (ref) j.ref = ref;
  if (error) j.error = String(error).slice(0, 400);
  if (status) j.status = status;
  if (data !== undefined) j.data = data;
  if (ended) { j.ended = true; j.endedAt = new Date().toISOString(); }
  tally(L);
  return j;
}
export function tally(L) {
  L.totalUsd = spent(L);
  L.committedUsd = committed(L);
  L.items = {};
  for (const [k, it] of Object.entries(ITEMS)) {
    L.items[k] = { estUsd: estimateOf(L, k), shareUsd: it.shareUsd, ceilingUsd: k === 'P0' ? 0 : ceilingOf(k), capUsd: it.capUsd, spentUsd: itemSpent(L, k), committedUsd: itemCommitted(L, k), jobs: L.jobs.filter((j) => charged(j) === k).length };
  }
  return L;
}

/** P6 runs only when the ledger reads at most $50 after P5. */
export const p6Eligible = (L) => spent(L) <= P6_GATE_USD + 1e-9;

/**
 * The restatement after P1 (§4: "P1's measured composer and Style costs restate P2-P6's estimates before P2 starts"), per unit cost:
 * `u` = {composeUsd (a composed plan, images on, P1's mean), styleUsd (a format 3 settlement Style, P1's), pickUsd (a template pick),
 * designUsd (a site-aware archetype design, 7b's measured mean), authorUsd and compositeUsd (not measured by P1: §4's estimates kept)}.
 * Each item's count of units is §4's table. Returns the table rows and writes them into the ledger.
 */
export const RESTATE_UNITS = Object.freeze({
  P2: { pick: 6, style: 6, compose: 2, design: 4 },
  P3: { author: 2 },
  P4: { composeOff: 2 },
  P5: { styleRefs: 2 },
  P6: { composite: 1 },
});
export function restate(L, u) {
  const unit = { pick: u.pickUsd, style: u.styleUsd, compose: u.composeUsd, design: u.designUsd, author: u.authorUsd, composeOff: u.composeOffUsd ?? u.composeUsd, styleRefs: u.styleRefsUsd ?? u.styleUsd, composite: u.compositeUsd };
  const items = {};
  let total = 0;
  for (const [k, units] of Object.entries(RESTATE_UNITS)) {
    const est = r6(Object.entries(units).reduce((a, [n, c]) => a + c * unit[n], 0));
    items[k] = { oldEstUsd: ITEMS[k].estUsd, newEstUsd: est, ceilingUsd: ceilingOf(k), capUsd: ITEMS[k].capUsd, units, overCeiling: est > ceilingOf(k) + 1e-9 };
    total += est;
  }
  const p1 = itemSpent(L, 'P1');
  L.restated = { at: new Date().toISOString(), units: { ...u }, items, p1SpentUsd: p1, totalEstUsd: r6(p1 + total), fitsHardCap: p1 + total <= HARD_CAP_USD, reserveUsd: ITEMS.R.capUsd };
  tally(L);
  return L.restated;
}

// ---- the files ------------------------------------------------------------------------------------------------------------------

export function readLedger(file) {
  try { return tally({ ...emptyLedger(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }); } catch { return tally(emptyLedger()); }
}
export function writeLedger(file, L) {
  tally(L);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(t, `${JSON.stringify(L, null, 2)}\n`);
  fs.renameSync(t, file);
}
/** The ledger, locked for one read-modify-write. */
export function withLedger(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = Number(fs.readFileSync(lock, 'utf8'));
      let alive = false;
      try { process.kill(holder, 0); alive = true; } catch { alive = false; }
      if (!alive) { fs.rmSync(lock, { force: true }); continue; }
      if (i > 600) throw new Error(`ledger locked by ${holder}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    const L = readLedger(file);
    const out = fn(L);
    writeLedger(file, L);
    return out;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
