// The judged benches out of the release path (Noah, 2026-10-22; docs/GATES.md "Benches out of the release path").
//
// The benches whose timing is judged (tools/gate-cache.json release.benches) run in the nightly, isolated, with their timing judged.
// A release reuses the latest nightly's result for a bench when that result was a PASS and nothing the bench measures has changed
// since: not a file of its recorded coverage or input set (the step cache's key over that PASS: its definition, toolchain, runner
// and modes too), and not a path of the bench-sensitive list. Otherwise the release runs it, with the reason. 6a-heap is nightly
// only. 6a-megaB's full walk runs in the nightly once a week (a configured day), on demand (--megab-full), and when the
// bench-sensitive core changed since the last full walk; the other nightlies run 6a-megaB-fast.
//
// The decisions are pure functions over records (unit-tested: kit/test/gate-benches.test.mjs); the runner supplies the records:
// the nightly runs' summaries (latestNightlyRecords), the changed files (git diff <nightly head> HEAD, two-dot) and whether the
// step cache's key still holds for the PASS (entryStillValid in step-cache.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { globRe } from './step-inputs.mjs';
import { parentOf } from './step-split.mjs';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TERMINAL = new Set(['PASS', 'FAIL', 'TIMEOUT', 'NOISY', 'ERROR']);

/** tools/gate-cache.json release.benches -> the sets and lists the runner uses. */
export function benchConf(conf) {
  const b = conf?.release?.benches ?? {};
  const megaB = { full: b.megaB?.full ?? '6a-megaB', fast: b.megaB?.fast ?? '6a-megaB-fast', weeklyDay: b.megaB?.weeklyDay ?? 'sun' };
  const groups = Object.entries(b.sensitive ?? {}).filter(([k]) => !k.startsWith('$')).map(([name, g]) => ({ name, paths: g.paths ?? [], benches: g.benches ?? [], res: (g.paths ?? []).map(globRe) }));
  return {
    judged: new Set(b.judged ?? []),
    nightlyJudged: new Set(b.nightlyJudged ?? []),
    nightlyOnly: new Set(b.nightlyOnly ?? []),
    megaB,
    groups,
  };
}

/**
 * The release's benches, one entry per logical bench: megaB's two walks are one bench (the latest nightly ran one of them).
 * -> [{ bench, ids }]
 */
export function releaseBenches(bc) {
  const out = [];
  const seen = new Set();
  for (const id of bc.judged) {
    if (seen.has(id)) continue;
    if (id === bc.megaB.full || id === bc.megaB.fast) {
      seen.add(bc.megaB.full);
      seen.add(bc.megaB.fast);
      out.push({ bench: 'megaB', ids: [bc.megaB.full, bc.megaB.fast] });
    } else {
      seen.add(id);
      out.push({ bench: id, ids: [id] });
    }
  }
  return out;
}

/** The bench-sensitive groups that name one of `ids` and match one of `files`: -> [{ group, files }]. */
export function sensitiveHits(bc, ids, files) {
  const want = new Set(ids);
  const out = [];
  for (const g of bc.groups) {
    if (!g.benches.some((b) => want.has(b))) continue;
    const hit = files.filter((f) => g.res.some((r) => r.test(f)));
    if (hit.length) out.push({ group: g.name, files: hit });
  }
  return out;
}

const hitText = (hits) => hits.map((h) => `${h.group} (${h.files.slice(0, 3).join(', ')}${h.files.length > 3 ? ` and ${h.files.length - 3} more` : ''})`).join('; ');

/**
 * Which megaB walk the nightly runs. date: the nightly's start (local day); onDemand: --megab-full; lastFull: the latest nightly
 * record of the full walk ({ head } or null); changedSinceFull: the files changed since lastFull.head (null: unknown).
 * -> { id, why }
 */
export function megaBVariant(bc, { date, onDemand = false, lastFull = null, changedSinceFull = null }) {
  const { full, fast, weeklyDay } = bc.megaB;
  if (onDemand) return { id: full, why: 'the full walk on demand (--megab-full)' };
  const day = DAYS[date.getDay()];
  if (String(weeklyDay).toLowerCase().slice(0, 3) === day) return { id: full, why: `the weekly full walk (${weeklyDay}, release.benches.megaB.weeklyDay)` };
  if (!lastFull) return { id: full, why: 'no nightly has run the full walk yet' };
  if (lastFull.status && lastFull.status !== 'PASS') return { id: full, why: `the last full walk (${lastFull.date ?? '?'}, ${String(lastFull.head).slice(0, 9)}) ended ${lastFull.status}` };
  if (changedSinceFull === null) return { id: full, why: `the files changed since the last full walk (${String(lastFull.head).slice(0, 9)}) are unknown` };
  const hits = sensitiveHits(bc, [full], changedSinceFull);
  if (hits.length) return { id: full, why: `the bench-sensitive core changed since the last full walk (${String(lastFull.head).slice(0, 9)}): ${hitText(hits)}` };
  return { id: fast, why: `the fast walk (the full walk runs on ${weeklyDay}, on demand, or when the bench-sensitive core changed; last full ${String(lastFull.head).slice(0, 9)})` };
}

/**
 * The benches a nightly (release --full --nightly) adds: every judged bench, with megaB's walk chosen by megaBVariant.
 * A release --full that is not the nightly (by hand, or the auto --full rule) runs every judged bench but the nightly-only ones
 * (6a-heap), and megaB's full walk. -> { ids, why: { id: reason } }
 */
export function fullBenches(bc, { nightly, variant }) {
  const ids = [];
  const why = {};
  for (const { bench, ids: xs } of releaseBenches(bc)) {
    if (!nightly && xs.every((x) => bc.nightlyOnly.has(x))) continue;
    if (bench === 'megaB') {
      const id = nightly ? variant.id : bc.megaB.full;
      ids.push(id);
      why[id] = nightly ? `nightly bench: ${variant.why}` : 'release --full: every judged bench, megaB\'s full walk';
    } else {
      ids.push(xs[0]);
      why[xs[0]] = nightly ? 'nightly bench: its timing is judged here, isolated' : 'release --full: every judged bench (not the nightly-only ones)';
    }
  }
  return { ids, why };
}

/**
 * The release's decision for one bench (pure).
 *   latest:    the latest nightly record of the bench (any of its ids): null | { id, status, date, head, run, startedAt, key, log }
 *   valid:     whether that PASS still holds here (the step cache's key, or its coverage, over the PASS): { ok, why }; null when
 *              there is no PASS entry to check
 *   changed:   the files changed between latest.head and HEAD (git diff, two-dot), or null when unknown
 *   nightlyOnly, noReuse (--no-cache), megaB (the bench's ids are megaB's walks)
 * -> { run: bool, step: the id to run (or reused), why, reuse?: latest }
 */
export function decideBench(bc, { bench, ids, latest, valid, changed, noReuse = false }) {
  const isMegaB = bench === 'megaB';
  const nightlyOnly = ids.every((x) => bc.nightlyOnly.has(x));
  const last = latest ? `the nightly of ${latest.date} (head ${String(latest.head).slice(0, 9)})` : null;
  if (nightlyOnly) return { run: false, step: ids[0], why: `nightly only${last ? `; last judged in ${last}: ${latest.status}` : '; no nightly has run it yet'}`, ...(latest ? { reuse: latest } : {}), nightlyOnly: true };
  const hits = latest && changed ? sensitiveHits(bc, ids, changed) : [];
  // megaB: the full walk when the bench-sensitive core changed, else the fast walk
  const runId = isMegaB ? (hits.length ? bc.megaB.full : bc.megaB.fast) : ids[0];
  if (noReuse) return { run: true, step: runId, why: '--no-cache: no nightly result is reused' };
  if (!latest) return { run: true, step: runId, why: 'no nightly has run it yet' };
  if (latest.status !== 'PASS') return { run: true, step: runId, why: `the latest nightly result is ${latest.status} (${last}): only a PASS is reused` };
  if (changed === null) return { run: true, step: runId, why: `the files changed since ${last} are unknown (its head is not in this repository?)` };
  if (hits.length) return { run: true, step: runId, why: `bench-sensitive code changed since ${last}: ${hitText(hits)}` };
  // valid may be a thunk: the runner checks the entry only when nothing above decided (it may need the build artifact)
  if (typeof valid === 'function') valid = valid();
  if (!valid) return { run: true, step: runId, why: `no step-cache entry for its PASS in ${last} (key ${latest.key ? String(latest.key).slice(0, 12) : 'none'})` };
  if (!valid.ok) return { run: true, step: runId, why: `the code it measures changed since ${last}: ${valid.why}` };
  return { run: false, step: latest.id, why: `reused: ${latest.id} PASS in ${last}, nothing it measures changed (${valid.why})`, reuse: latest };
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * The newest nightly record of each step in `ids` (by parent id: a split step's parts fold, worst status), from the nightly root
 * (artifacts/nightly/<date>/summary.json and its runs' summary.json). Every nightly that has runs counts, finished or not (a nightly
 * stopped after a bench FAILed still shows that FAIL); only a step's terminal result counts (PASS, FAIL, TIMEOUT, NOISY, ERROR), not
 * PENDING, RUNNING or SKIPPED (a yielded step never ran). -> Map id -> record
 */
export function latestNightlyRecords(root, ids) {
  const want = new Set(ids);
  const out = new Map();
  let days = [];
  try {
    days = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  } catch {
    return out;
  }
  const rank = { PASS: 0, NOISY: 1, FAIL: 3, TIMEOUT: 3, ERROR: 3 };
  for (const d of days) {
    const day = readJson(path.join(root, d, 'summary.json'));
    if (!day || !(day.runs ?? (day.run ? [day.run] : [])).length) continue;
    const found = new Map();
    for (const run of day.runs ?? (day.run ? [day.run] : [])) {
      const sm = readJson(path.join(run, 'summary.json'));
      for (const s of sm?.steps ?? []) {
        const id = parentOf(s.id);
        if (!want.has(id) || out.has(id)) continue;
        if (!TERMINAL.has(s.status)) continue;
        const prev = found.get(id);
        const rec = { id, status: s.status, date: d, head: day.head ?? sm.head, run, startedAt: day.startedAt, key: s.cache?.key ?? null, recorded: !!s.cache?.recorded, log: s.log ? path.join(run, s.log) : null };
        if (!prev || (rank[rec.status] ?? 3) > (rank[prev.status] ?? 3)) found.set(id, rec);
      }
    }
    for (const [id, r] of found) out.set(id, r);
    if (ids.every((x) => out.has(x))) break;
  }
  return out;
}

/** The newest of the records of `ids` (megaB: whichever walk the latest nightly ran). */
export function newestOf(records, ids) {
  return ids.map((x) => records.get(x)).filter(Boolean).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0] ?? null;
}

// ------------------------------------------------------------------ the full twins that only the nightly runs (Noah, 2026-10-23)

/** tools/gate-cache.json release.nightly.ids: the full ids the releases replace by their smoke or slice twins and only the nightly runs. */
export function nightlyFulls(conf) {
  return [...(conf?.release?.nightly?.ids ?? [])];
}

/**
 * Applies the rule to a release's candidate set `want` (a Set, edited in place): a release drops every nightly-only full id (a smoke or
 * slice twin stands for it: it is in the release's own lists, supersededBy that full id); the nightly adds them (a step a full id
 * supersedes then drops, as at any run that holds both). -> { dropped, added }: what changed, for the plan.
 */
export function applyNightlyFulls(want, ids, { nightly, valid = () => true }) {
  const dropped = [], added = [];
  for (const s of ids) {
    if (!valid(s)) continue;
    if (nightly) {
      if (!want.has(s)) { want.add(s); added.push(s); }
    } else if (want.delete(s)) dropped.push(s);
  }
  return { dropped, added };
}
