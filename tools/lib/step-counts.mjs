// A step's result counts (tools/gate-run.mjs) and unit-scope's summed line (tools/unit-scope.mjs --run).
//
// The standing lesson: zero results never count as a PASS. A step "records results" when it printed an ok or FAIL line, or one of its
// parsed count metrics (tests, pass, passed, fail, failed, failures, checks: `parse` regexes or `junit` XML) is above 0. A step that
// exits 0 with none of these ran nothing as far as the runner can tell: FAIL "no results recorded", unless its gate-chains.json entry
// declares `"counts": false` (a driver that prints no ok lines and no counts, e.g. a scenario run, judged by its exit code alone).

import fs from 'node:fs';
import path from 'node:path';

/** The metric keys that are result counts (a parsed `ℹ tests 0` is a count of 0, not a missing count). */
export const COUNT_KEYS = ['tests', 'pass', 'passed', 'fail', 'failed', 'failures', 'checks'];

/** True when the step recorded any result: ok/FAIL lines or a count metric above 0. */
export function resultsRecorded({ ok = 0, fail = 0, metrics = {} } = {}) {
  if (ok > 0 || fail > 0) return true;
  return COUNT_KEYS.some((k) => typeof metrics?.[k] === 'number' && metrics[k] > 0);
}

/**
 * The no-results rule: null when the step's PASS stands, else the reason it becomes FAIL. Only a PASS is judged; a step whose entry
 * says `counts: false` is exempt.
 */
export function noResultsReason(step, rec) {
  if (rec.status !== 'PASS' || step?.counts === false) return null;
  return resultsRecorded(rec) ? null : 'no results recorded';
}

/**
 * JUnit XML totals over a directory's *.xml (each file's <testsuite> head). `since` (ms): only files written at or after it, so a
 * results directory's old reports are not counted again. null when the directory is missing.
 */
export function junitCounts(dir, { since = 0 } = {}) {
  if (!dir || !fs.existsSync(dir)) return null;
  const c = { tests: 0, failures: 0, errors: 0, skipped: 0, files: 0 };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.xml'))) {
    const p = path.join(dir, f);
    if (since && fs.statSync(p).mtimeMs < since) continue;
    c.files++;
    const head = fs.readFileSync(p, 'utf8').slice(0, 2000).match(/<testsuite\b[^>]*>/)?.[0] ?? '';
    for (const k of ['tests', 'failures', 'errors', 'skipped']) c[k] += Number(head.match(new RegExp(`\\b${k}="(\\d+)"`))?.[1] ?? 0);
  }
  return c;
}

/**
 * Totals of one JUnit XML file holding many <testsuite> elements (node --test's and vitest's junit reporters): the <testcase>
 * elements, those with a <failure> or <error>, and those <skipped>. null when the file is missing or empty.
 */
export function junitFileCounts(file) {
  if (!file || !fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return null;
  let tests = 0;
  let failures = 0;
  let skipped = 0;
  for (const m of text.matchAll(/<testcase\b[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    tests++;
    const body = m[2] ?? '';
    if (/<(failure|error)\b/.test(body)) failures++;
    else if (/<skipped\b/.test(body)) skipped++;
  }
  return { tests, failures, skipped };
}

/** The prefix of unit-scope's summed line (gate-chains.json's unit-scope `parse` regexes anchor on it). */
export const UNIT_SCOPE_PREFIX = 'unit-scope --run: results';

/**
 * unit-scope's one summed line. `suites`: [{ name, tests, pass, fail } | { name, error }] for each suite that ran (an error: the
 * suite ran but its counts could not be read); `checks`: { pass, fail } of the `node --check` runs. Nothing ran at all: says so, with
 * tests 0 (gate-run's no-results rule then fails the step).
 */
export function unitScopeLine(suites = [], checks = { pass: 0, fail: 0 }) {
  const ran = suites.filter((s) => s.error == null);
  const tests = ran.reduce((a, s) => a + s.tests, 0);
  const pass = ran.reduce((a, s) => a + s.pass, 0);
  const fail = ran.reduce((a, s) => a + s.fail, 0);
  const nChecks = checks.pass + checks.fail;
  const head = `${UNIT_SCOPE_PREFIX} tests ${tests}, pass ${pass}, fail ${fail}, checks ${nChecks}, check fail ${checks.fail}`;
  if (!suites.length && !nChecks) return `${head} (nothing ran: no suite picked and no node --check)`;
  const per = suites.map((s) => (s.error != null ? `${s.name} counts unread: ${s.error}` : `${s.name} ${s.pass}/${s.fail}`));
  return `${head} (${[...per, ...(nChecks ? [`node --check ${checks.pass}/${checks.fail}`] : [])].join(', ')})`;
}
