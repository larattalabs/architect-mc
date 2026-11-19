// (GI2, GR-a item 10) apijars (tools/gate6a.mjs): how one old apitest jar's survival run is judged, and its single retry.
//
// The archived clients of old releases flake now and then (a setTags NPE on 0.56.0, makeVariant on 0.67/0.68) where a second run of the
// same jar passes. A failed jar gets ONE more run, in a fresh world: the retry is logged (`RETRY apijars ...`, with the first run's FAIL
// lines) and recorded; the second run's verdict is the jar's, so a second failure fails the step. A run that failed only on timing (its
// BAR lines, recorded) is not a failure and is never retried.

/** apitest prints timing bars as `FAIL BAR ...`; the archived one prints the quiet-dependent SITE_PROGRESS gap without the prefix. */
export const isTiming = (l) => l.startsWith('FAIL BAR') || (/^FAIL SITE_PROGRESS (\d+)x, at most 1\/s \(min gap (\d+) ms\)/.test(l) && Number(RegExp.$1) >= 2 && Number(RegExp.$2) < 950);

/**
 * (T2b) An archived assertion an intended, reviewed behaviour change superseded: recorded beside the timing lines, never judged. Each
 * entry names its exact line, the change and who agreed it. Only the old line's exact shape matches; the current tree's apitest.mjs
 * checks the new behaviour (here: refund + owed growth > 0) and the txn crash rows check conservation.
 */
export const SUPERSEDED = [
  { re: /^FAIL remove by the owner: refund 0 items \(0 kinds\)$/,
    why: 'T2b: a crate-fed removal with no pile owes its give-back (RemoveResult.owed(), listed apart, never in the refund total; Steward T2b-owed-api Q4, confirmed 2026-11-18)' },
];
export const isSuperseded = (l) => SUPERSEDED.some((s) => s.re.test(l));

/** One run's text and exit code -> { pass, oks, fails, hard, timing, superseded, total }. */
export function judgeApitest(text, code) {
  const lines = String(text ?? '').split('\n');
  const fails = lines.filter((l) => l.startsWith('FAIL'));
  const oks = lines.filter((l) => l.startsWith('ok')).length;
  const hard = fails.filter((l) => !isTiming(l) && !isSuperseded(l));
  const total = Number(String(text ?? '').match(/(\d+) FAILED ->/)?.[1] ?? -1); // apitest's own total must account for every FAIL line
  const pass = hard.length === 0 && (code === 0 || (total === fails.length && fails.length > hard.length)) && oks > 0;
  return { pass, oks, fails, hard, timing: fails.filter(isTiming), superseded: fails.filter(isSuperseded), total };
}

/**
 * attempt(n) -> Promise<{ code, text }> (n = 1, then 2 when the first did not pass). -> { code, text, judged, retried: null | { first } }.
 * log: the retry line.
 */
export async function runJarWithRetry(name, attempt, { log = console.log } = {}) {
  const a = await attempt(1);
  const j = judgeApitest(a.text, a.code);
  if (j.pass) return { ...a, judged: j, retried: null };
  log(`RETRY apijars: the ${name} jar's first run did not pass (exit ${a.code}, ${j.oks} ok, ${j.hard.length} FAIL): running it once more in a fresh world; the second run decides`);
  for (const l of j.hard.slice(0, 8)) log(`  first run: ${l}`);
  const b = await attempt(2);
  const j2 = judgeApitest(b.text, b.code);
  log(`RETRY apijars: the ${name} jar's second run ${j2.pass ? 'passed' : `FAILED too (${j2.hard.length} FAIL)`}`);
  return { ...b, judged: j2, retried: { first: { code: a.code, oks: j.oks, hard: j.hard.slice(0, 20) } } };
}
