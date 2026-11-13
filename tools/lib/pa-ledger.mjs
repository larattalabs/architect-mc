// (7b PA, docs/CONTRACT.md "Phase 7b" §4) The paid batch's spend ledger and its rules, pure (no I/O but the file helpers at the end):
// tools/gate7bpa.mjs (the driver) and tools/lib/scenario-sb.mjs (P2/P3's paid archetypes, in game) both guard through it.
//
//   - one phase ledger (artifacts/7b/spend.json) plus a per-item copy (artifacts/7b/<item>/spend.json); costs from each job's own reported
//     usage (the design's cost.usd)
//   - before each paid job: committed + the job's cap > $90 refuses; committed + the job's cap > $60 stops for the coordinator (Noah) unless
//     an answer recorded in the ledger approves exactly that step. "Committed" counts a job still running (or one that ended without a
//     reported cost) at its full cap, so a crash mid-job can never let the next step pass the cap unseen
//   - each job's budgetUsd = its share of the item cap; at most one retry per item, charged to the reserve R
//   - no paid step starts inside the nightly window 01:30-03:30 local (nor one whose expected end reaches it)
//   - an item over its estimate by more than 50% is flagged; the next items' estimates are re-stated from P1's measured cost per design
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Credentials that must never be set in an env the batch starts (claude login only). */
export const KEY_VARS = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK']);
/** An env with no ANTHROPIC_* and no CLAUDE* variable (the helper's SDK then reads Noah's own claude login, not a calling session's). */
export function scrubbedEnv(env = process.env, extra = {}) {
  const out = {};
  // (also any variable whose value names anthropic, e.g. the desktop app's bundle id, so `env | rg -i anthropic` reads empty)
  for (const [k, v] of Object.entries(env)) if (!/^(ANTHROPIC_|CLAUDE)/.test(k) && k !== 'AWS_BEARER_TOKEN_BEDROCK' && !/anthropic/i.test(String(v))) out[k] = v;
  return { ...out, ...extra };
}
/** `env | rg -i anthropic` over an env: the names that would show (must be none in a paid step's env). */
export const anthropicNames = (env) => Object.keys(env).filter((k) => /anthropic/i.test(k) || /anthropic/i.test(String(env[k])));

export const BUDGET_USD = 60;
export const HARD_CAP_USD = 90;
/** §4's items: estimate, cap, the number of paid jobs the cap is shared over. */
export const ITEMS = Object.freeze({
  P0: Object.freeze({ estUsd: 0, capUsd: 0, jobs: 0, what: 'sim dry runs of every paid item' }),
  P1: Object.freeze({ estUsd: 12, capUsd: 15, jobs: 3, what: 'calibration: 3 STANDARD site-aware designs on non-scenario sites' }),
  P2: Object.freeze({ estUsd: 13, capUsd: 17, jobs: 3, what: 'S5 treehouses: 2 wrap_trunk archetypes + 1 landmark, the rest site variants' }),
  P3: Object.freeze({ estUsd: 13, capUsd: 17, jobs: 3, what: 'S6 cave city: 2 carve_into archetypes + 1 landmark, the rest site variants' }),
  P4: Object.freeze({ estUsd: 8, capUsd: 10, jobs: 2, what: "images A/B: S5's 2 archetypes again with the site renders off" }),
  P5: Object.freeze({ estUsd: 5, capUsd: 7, jobs: 1, what: 'S4 stretch: site variants of P1 + 1 ravine landmark (only at <= $50 after P4)' }),
  R: Object.freeze({ estUsd: 7, capUsd: 7, jobs: 2, what: 'reserve: repair re-runs and 2 paid adaptations (versionOf + site)' }),
});
export const PAID_ORDER = ['P1', 'P2', 'P3', 'P4', 'P5', 'R'];
/** P1's estimate per design (§4: $12 for 3): the base the re-stated estimates scale from. */
export const P1_EST_PER_DESIGN = ITEMS.P1.estUsd / ITEMS.P1.jobs;
/** A plain STANDARD M design (§4 "Unit costs used": $2.2-3.6, the 0b bench): the site multiplier's denominator (the middle). */
export const PLAIN_STANDARD_USD = 2.9;
/** P5 runs only when the ledger reads at most this after P4. */
export const P5_GATE_USD = 50;
/** The nightly window (local time): no gate run and no paid step. */
export const NIGHTLY = Object.freeze({ from: [1, 30], to: [3, 30] });

const r6 = (n) => Math.round(n * 1e6) / 1e6;

export function emptyLedger() {
  return { budgetUsd: BUDGET_USD, capUsd: HARD_CAP_USD, totalUsd: 0, committedUsd: 0, items: {}, jobs: [], answers: [], restated: null, notes: [] };
}

/** A job's committed cost: its reported usd once it ended with a cost, else its cap (running, or ended with no report). */
export function jobCommitted(j) {
  if (j.ended && typeof j.usd === 'number') return j.usd;
  return Math.max(j.capUsd ?? 0, j.usd ?? 0);
}
export const spent = (L) => r6(L.jobs.reduce((a, j) => a + (j.usd ?? 0), 0));
export const committed = (L) => r6(L.jobs.reduce((a, j) => a + jobCommitted(j), 0));
export function spentByItem(L) {
  const out = {};
  for (const j of L.jobs) out[j.chargedTo ?? j.item] = r6((out[j.chargedTo ?? j.item] ?? 0) + (j.usd ?? 0));
  return out;
}

/** The item's estimate now: the re-stated one (after P1) when present, else §4's. */
export function estimateOf(L, item) {
  return L.restated?.items?.[item]?.estUsd ?? ITEMS[item].estUsd;
}

/** A job's budgetUsd: its share of the item's cap (P1: $15 / 3 = $5). R's jobs share R's cap. */
export function jobShare(item) {
  const it = ITEMS[item];
  if (!it || !it.jobs) throw new Error(`no paid jobs in ${item}`);
  return r6(it.capUsd / it.jobs);
}

/** Whether a local time falls in the nightly window, or a step starting now and lasting `minutes` would reach it. */
export function inNightly(date, minutes = 0) {
  const at = (d) => d.getHours() * 60 + d.getMinutes();
  const from = NIGHTLY.from[0] * 60 + NIGHTLY.from[1], to = NIGHTLY.to[0] * 60 + NIGHTLY.to[1];
  const start = at(date);
  for (let m = 0; m <= minutes; m += 5) {
    const t = (start + m) % 1440;
    if (t >= from && t < to) return true;
  }
  const end = (start + minutes) % 1440;
  return end >= from && end < to;
}

/**
 * The rule before a paid job (§4 "Rules"): {ok: true} or {ok: false, kind: 'refuse'|'stop'|'window'|'retry', message, report?}.
 * `step` names the job (`P2:tree_1`); `capUsd` its budget; `retry` marks a re-run (charged to R, at most one per item).
 */
export function guard(L, { item, step, capUsd, retry = false, now = new Date(), minutes = 0, authSource = null, envKeys = [] }) {
  if (envKeys.length) return { ok: false, kind: 'refuse', message: `refusing ${step}: ${envKeys.join(', ')} set in the environment (claude login only)` };
  if (authSource !== null && !/claude login/i.test(authSource)) return { ok: false, kind: 'refuse', message: `refusing ${step}: the helper's auth is "${authSource}", not the claude login` };
  if (inNightly(now, minutes)) return { ok: false, kind: 'window', message: `refusing ${step}: the nightly window ${NIGHTLY.from.join(':')}-${NIGHTLY.to.join(':')} (no paid step; this one could last ${minutes} min)` };
  if (retry) {
    const prior = L.jobs.filter((j) => j.item === item && j.retry).length;
    if (prior >= 1) return { ok: false, kind: 'retry', message: `refusing ${step}: ${item} already used its one retry` };
  }
  const c = committed(L);
  if (c + capUsd > HARD_CAP_USD + 1e-9) return { ok: false, kind: 'refuse', message: `refusing ${step}: committed $${c.toFixed(2)} + its cap $${capUsd.toFixed(2)} passes the $${HARD_CAP_USD} hard cap` };
  if (c + capUsd > BUDGET_USD + 1e-9 && !approved(L, step)) {
    return { ok: false, kind: 'stop', message: `stop before ${step}: committed $${c.toFixed(2)} + its cap $${capUsd.toFixed(2)} passes the $${BUDGET_USD} budget: ask the coordinator (Noah)`, report: stopReport(L, { item, step, capUsd }) };
  }
  return { ok: true };
}

/** An answer recorded with `answer` approves this exact step past $60. */
export const approved = (L, step) => L.answers.some((a) => a.step === step && a.yes === true);

/** What the $60 stop sends: spent per item, the step, its estimate and cap, what is left, what is skipped on a no. */
export function stopReport(L, { item, step, capUsd }) {
  const byItem = spentByItem(L);
  const done = new Set(Object.keys(byItem));
  const after = PAID_ORDER.slice(PAID_ORDER.indexOf(item) + 1);
  return {
    spentUsd: spent(L),
    committedUsd: committed(L),
    spentByItem: byItem,
    step,
    item,
    estimateUsd: estimateOf(L, item),
    capUsd,
    leftUsd: { toBudget: r6(BUDGET_USD - committed(L)), toHardCap: r6(HARD_CAP_USD - committed(L)) },
    skippedOnNo: [item, ...after].filter((i) => !done.has(i) || i === item),
  };
}

/** Open a job (guard first). Returns the job record (mutates L). */
export function openJob(L, { item, step, capUsd, retry = false, authSource = null, designId = null }) {
  const j = { item, step, capUsd: r6(capUsd), usd: 0, ended: false, retry: !!retry, chargedTo: retry ? 'R' : item, authSource, designId, startedAt: new Date().toISOString() };
  L.jobs.push(j);
  tally(L);
  return j;
}
/** Update a job's cost (still running) or close it with its reported cost and outcome. */
export function updateJob(L, step, { usd, ended = false, status = null, designId, entryId, rounds, error } = {}) {
  const j = [...L.jobs].reverse().find((x) => x.step === step);
  if (!j) throw new Error(`no job ${step}`);
  if (typeof usd === 'number') j.usd = r6(usd);
  if (designId) j.designId = designId;
  if (entryId) j.entryId = entryId;
  if (rounds !== undefined) j.rounds = rounds;
  if (error) j.error = String(error).slice(0, 400);
  if (status) j.status = status;
  if (ended) { j.ended = true; j.endedAt = new Date().toISOString(); }
  tally(L);
  return j;
}
/** Totals and the per-item rows (estimate, cap, spent, over-estimate flag). */
export function tally(L) {
  L.totalUsd = spent(L);
  L.committedUsd = committed(L);
  const by = spentByItem(L);
  L.items = {};
  for (const [k, it] of Object.entries(ITEMS)) {
    const est = estimateOf(L, k);
    const s = by[k] ?? 0;
    L.items[k] = { estUsd: est, capUsd: it.capUsd, spentUsd: s, jobs: L.jobs.filter((j) => (j.chargedTo ?? j.item) === k).length, overEstimate50: est > 0 && s > est * 1.5 };
  }
  return L;
}

/**
 * The re-statement after P1 (§4 "Restate P2-P5's estimates from P1's measured multiplier before P2"): P1's measured mean cost per design
 * against §4's assumed $4 per design scales every later estimate; the site multiplier is that mean against a plain STANDARD M design.
 */
export function restate(L, p1Usd) {
  const n = p1Usd.length;
  if (!n) throw new Error('restate: no P1 design costs');
  const mean = p1Usd.reduce((a, b) => a + b, 0) / n;
  const factor = mean / P1_EST_PER_DESIGN;
  const items = {};
  for (const k of ['P2', 'P3', 'P4', 'P5', 'R']) items[k] = { estUsd: r6(ITEMS[k].estUsd * factor), was: ITEMS[k].estUsd, capUsd: ITEMS[k].capUsd, estOverCap: ITEMS[k].estUsd * factor > ITEMS[k].capUsd };
  L.restated = { at: new Date().toISOString(), p1MeanUsd: r6(mean), p1Designs: n, factor: r6(factor), siteMultiplier: r6(mean / PLAIN_STANDARD_USD), items };
  tally(L);
  return L.restated;
}

/** P5 runs only when the ledger reads at most $50 after P4. */
export const p5Eligible = (L) => spent(L) <= P5_GATE_USD + 1e-9;

/**
 * The blind A/B sheet's randomisation: per pair, which arm is shown as side A. `rand` returns a byte (crypto by default). Returns
 * {pairs: [{pair, A, B}], key: {pair: {A: arm, B: arm}}} where arms are 'on' / 'off'.
 */
export function abSides(pairIds, rand = () => crypto.randomBytes(1)[0]) {
  const key = {};
  for (const p of pairIds) key[p] = rand() & 1 ? { A: 'off', B: 'on' } : { A: 'on', B: 'off' };
  return key;
}

// ---- the files ----------------------------------------------------------------------------------------------------------------

export function readLedger(file) {
  try {
    const L = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...emptyLedger(), ...L };
  } catch {
    return emptyLedger();
  }
}
/** Write the phase ledger and each item's copy (its own jobs and row) beside it, atomically. */
export function writeLedger(file, L) {
  tally(L);
  const put = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, `${JSON.stringify(o, null, 2)}\n`); fs.renameSync(t, f); };
  put(file, L);
  for (const k of Object.keys(ITEMS)) {
    const jobs = L.jobs.filter((j) => (j.chargedTo ?? j.item) === k || j.item === k);
    if (!jobs.length && !L.restated?.items?.[k]) continue;
    put(path.join(path.dirname(file), k, 'spend.json'), { item: k, ...L.items[k], jobs });
  }
}
/** The ledger, locked for one read-modify-write (a lock file; the in-game run and the driver share the ledger, never at once). */
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
