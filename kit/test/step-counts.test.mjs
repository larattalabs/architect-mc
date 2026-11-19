// tools/lib/step-counts.mjs (slice OK0): zero results never count as a PASS in gate-run, and unit-scope --run's summed line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { junitCounts, junitFileCounts, noResultsReason, resultsRecorded, unitScopeLine } from '../../tools/lib/step-counts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const chains = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/gate-chains.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arch-ok0-'));

/** gate-run's metric parse (the step's `parse` regexes, last match wins), as tools/gate-run.mjs does it. */
const parseMetrics = (step, text) => {
  const metrics = {};
  for (const [k, re] of Object.entries(step.parse ?? {})) {
    const m = [...text.matchAll(new RegExp(re, 'gm'))].pop();
    if (m) metrics[k] = Number(m[1]);
  }
  return metrics;
};

test('the ok-0 rule: a PASS with no ok/FAIL line and no count metric is FAIL "no results recorded"', () => {
  const step = { id: 'x', okLines: false };
  assert.equal(noResultsReason(step, { status: 'PASS', ok: 0, fail: 0 }), 'no results recorded');
  assert.equal(noResultsReason(step, { status: 'PASS', ok: 0, fail: 0, metrics: {} }), 'no results recorded');
  // a parsed count of 0 is still zero results (`ℹ tests 0`)
  assert.equal(noResultsReason(step, { status: 'PASS', ok: 0, fail: 0, metrics: { tests: 0, pass: 0, fail: 0 } }), 'no results recorded');
  // a non-count metric is not a result
  assert.equal(noResultsReason(step, { status: 'PASS', ok: 0, fail: 0, metrics: { mspt: 12.5 } }), 'no results recorded');
});

test('the ok-0 rule: ok lines, FAIL lines (timing-only passes) or a count metric above 0 keep the PASS', () => {
  const step = { id: 'x', okLines: false };
  assert.equal(noResultsReason(step, { status: 'PASS', ok: 3, fail: 0 }), null);
  assert.equal(noResultsReason(step, { status: 'PASS', ok: 0, fail: 2, timingRecorded: ['FAIL BAR mspt'] }), null);
  for (const k of ['tests', 'pass', 'passed', 'failures', 'checks']) assert.equal(noResultsReason(step, { status: 'PASS', ok: 0, fail: 0, metrics: { [k]: 5 } }), null, k);
  assert.equal(resultsRecorded({ ok: 0, fail: 0, metrics: { tests: 1561, pass: 1561, fail: 0 } }), true);
});

test('the ok-0 rule: "counts": false exempts the step; a non-PASS is not judged', () => {
  assert.equal(noResultsReason({ id: 'br-s2', counts: false }, { status: 'PASS', ok: 0, fail: 0 }), null);
  assert.equal(noResultsReason({ id: 'x' }, { status: 'FAIL', ok: 0, fail: 0 }), null);
  assert.equal(noResultsReason({ id: 'x' }, { status: 'TIMEOUT', ok: 0, fail: 0 }), null);
});

test('gate-chains.json: every step that passed with ok 0 / FAIL 0 before OK0 now records counts or is declared count-free', () => {
  const countFree = ['6b-scenario-s1', '6b-scenario-s1-flat', '6c-scenario-s2', '6c-scenario-s3', '6cd-scenario-districts', '6ct1-scenario-relief',
    '6ct2-scenario-route', 'br-s1', 'br-s2', 'br-s3', 'br-s3v2', 'br-s5', 'br-s6', 'pa-p0-s5', 'pa-p0-s6', 'pm-promote'];
  for (const id of countFree) assert.equal(chains.steps[id]?.counts, false, id);
  for (const id of ['unit-kit', 'water-lint', 'unit-sidecar', 'br-unit', 'cn-unit', 'pa-unit', 'pf-unit', 'pm-unit', 'sb-unit', 'unit-scope']) assert.ok(chains.steps[id]?.parse, `${id} parses its counts`);
  for (const id of ['unit-mod', 'umt', 'p3-lint']) assert.ok(chains.steps[id]?.junit, `${id} reads JUnit`);
  // node --test's own summary through the parse those steps now carry
  const m = parseMetrics(chains.steps['br-unit'], 'ℹ tests 16\nℹ suites 0\nℹ pass 16\nℹ fail 0\n');
  assert.deepEqual(m, { tests: 16, pass: 16, fail: 0 });
  assert.equal(noResultsReason(chains.steps['br-unit'], { status: 'PASS', ok: 0, fail: 0, metrics: m }), null);
});

test('unit-scope summed line: sums the suites and the node --check runs', () => {
  const line = unitScopeLine([{ name: 'kit', tests: 1561, pass: 1561, fail: 0 }, { name: 'sidecar', tests: 953, pass: 950, fail: 0 }, { name: 'gradle', tests: 812, pass: 810, fail: 2 }], { pass: 2, fail: 0 });
  assert.equal(line, 'unit-scope --run: results tests 3326, pass 3321, fail 2, checks 2, check fail 0 (kit 1561/0, sidecar 950/0, gradle 810/2, node --check 2/0)');
  const unread = unitScopeLine([{ name: 'kit', tests: 10, pass: 10, fail: 0 }, { name: 'gradle', error: 'no JUnit XML written this run' }]);
  assert.match(unread, /^unit-scope --run: results tests 10, pass 10, fail 0, checks 0, check fail 0 \(kit 10\/0, gradle counts unread: no JUnit XML/);
});

test('unit-scope summed line: nothing ran says so with tests 0, and gate-run fails it', () => {
  const line = unitScopeLine([], { pass: 0, fail: 0 });
  assert.equal(line, 'unit-scope --run: results tests 0, pass 0, fail 0, checks 0, check fail 0 (nothing ran: no suite picked and no node --check)');
  const step = chains.steps['unit-scope'];
  const metrics = parseMetrics(step, `unit-scope: explicit paths: 1 changed file(s)\n\nunit-scope --run: nothing to run\n${line}\n`);
  assert.deepEqual(metrics, { tests: 0, pass: 0, fail: 0, checks: 0 });
  assert.equal(noResultsReason(step, { status: 'PASS', ok: 0, fail: 0, metrics }), 'no results recorded');
});

test('unit-scope summed line round-trips through the unit-scope step\'s parse, not the suites\' own count lines', () => {
  const step = chains.steps['unit-scope'];
  assert.notEqual(step.counts, false);
  const line = unitScopeLine([{ name: 'kit', tests: 40, pass: 40, fail: 0 }, { name: 'sidecar', tests: 7, pass: 7, fail: 0 }], { pass: 1, fail: 0 });
  // the kit's and vitest's own summaries land in the same log first: the step's parse must read only the summed line
  const log = `ℹ tests 40\nℹ pass 40\nℹ fail 0\n      Tests  7 passed (7)\n\nunit-scope --run: node --check tools/gate7caq.mjs PASS, kit PASS, sidecar PASS\n${line}\n`;
  const metrics = parseMetrics(step, log);
  assert.deepEqual(metrics, { tests: 47, pass: 47, fail: 0, checks: 1 });
  assert.equal(noResultsReason(step, { status: 'PASS', ok: 0, fail: 0, metrics }), null);
  // only node --check ran (a gate driver no unit reaches): a result, not zero
  const checksOnly = parseMetrics(step, unitScopeLine([], { pass: 2, fail: 0 }));
  assert.equal(noResultsReason(step, { status: 'PASS', ok: 0, fail: 0, metrics: checksOnly }), null);
  // a log without the summed line (an older unit-scope) records nothing
  assert.equal(noResultsReason(step, { status: 'PASS', ok: 0, fail: 0, metrics: parseMetrics(step, 'ℹ tests 40\nℹ pass 40\n') }), 'no results recorded');
});

test('JUnit counts: node/vitest report files and Gradle XMLs written since the run started', () => {
  const d = tmp();
  const f = path.join(d, 'kit.xml');
  fs.writeFileSync(f, '<?xml version="1.0"?>\n<testsuites><testsuite name="a"><testcase name="t1" time="0.1"/><testcase name="t2"><failure message="x"/></testcase>'
    + '<testcase name="t3"><skipped/></testcase></testsuite><testsuite name="b"><testcase name="t4" time="1"></testcase></testsuite></testsuites>\n');
  assert.deepEqual(junitFileCounts(f), { tests: 4, failures: 1, skipped: 1 });
  assert.equal(junitFileCounts(path.join(d, 'missing.xml')), null);
  const g = path.join(d, 'test');
  fs.mkdirSync(g);
  const old = path.join(g, 'TEST-Old.xml');
  fs.writeFileSync(old, '<testsuite name="Old" tests="9" failures="0" errors="0" skipped="0">');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(old, past, past);
  fs.writeFileSync(path.join(g, 'TEST-New.xml'), '<testsuite name="New" tests="5" failures="1" errors="1" skipped="1">');
  assert.deepEqual(junitCounts(g), { tests: 14, failures: 1, errors: 1, skipped: 1, files: 2 });
  assert.deepEqual(junitCounts(g, { since: Date.now() - 10_000 }), { tests: 5, failures: 1, errors: 1, skipped: 1, files: 1 });
  assert.equal(junitCounts(path.join(d, 'none')), null);
  fs.rmSync(d, { recursive: true, force: true });
});
