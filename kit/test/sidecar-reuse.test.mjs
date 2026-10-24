// tools/lib/sidecar-reuse.mjs (speed audit D, B3): a driver's sidecar test files take pass/fail from the run's unit-sidecar JUnit
// report only when it is exact; otherwise the reason is logged and null returned. Also tools/lib/base-tree.mjs identicalToBase (K1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sidecarReuse, sidecarTree, SIDECAR_TREE_PATHS } from '../../tools/lib/sidecar-reuse.mjs';
import { identicalToBase, skippedLine } from '../../tools/lib/base-tree.mjs';

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-reuse-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  for (const d of ['sidecar', 'kit', 'scenarios']) { fs.mkdirSync(path.join(dir, d)); fs.writeFileSync(path.join(dir, d, 'a.txt'), d); }
  // (the tree key also names api/Limits.java and tools/eval.mjs, read by the sidecar tests from outside the three dirs)
  for (const f of SIDECAR_TREE_PATHS.slice(3)) { fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), f); }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'one');
  return dir;
}
const xml = (suites) => `<?xml version="1.0"?>\n<testsuites name="vitest tests">\n${suites.map((s) => `<testsuite name="${s.name}" tests="${s.cases.length}" failures="${s.failures ?? 0}" errors="0" skipped="${s.skipped ?? 0}">\n${s.cases.map((c) => `<testcase classname="${s.name}" name="${c}">\n</testcase>`).join('\n')}\n</testsuite>`).join('\n')}\n</testsuites>\n`;
function withEnv(env, fn) {
  const old = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === null) delete process.env[k]; else process.env[k] = env[k]; }
  const log = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try { return fn(lines); } finally { console.log = log; for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}

test('sidecarReuse: exact report -> vitest\'s two summary lines and the JSON of the tests; any doubt -> null with the reason', () => {
  const root = repo();
  const rf = path.join(root, 'r.xml');
  const tree = sidecarTree(root);
  assert.match(tree, /^[0-9a-f]{12}(\.[0-9a-f]{12}){4}$/);
  fs.writeFileSync(rf, xml([{ name: 'test/a.test.ts', cases: ['s &gt; one', 's &gt; two'] }, { name: 'test/b.test.ts', cases: ['x'] }, { name: 'test/bad.test.ts', cases: ['y'], failures: 1 }, { name: 'test/skip.test.ts', cases: ['y'], skipped: 1 }]));
  const j = path.join(root, 'out.json');
  withEnv({ GATE_SIDECAR_RESULTS: rf, GATE_SIDECAR_TREE: tree }, (lines) => {
    const r = sidecarReuse(root, ['test/a.test.ts', 'test/b.test.ts'], { jsonOut: j });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Test Files {2}2 passed \(2\)/);
    assert.match(r.stdout, /\n {6}Tests {2}3 passed \(3\)/);
    assert.equal(JSON.parse(fs.readFileSync(j, 'utf8')).testResults[0].assertionResults[0].fullName, 's one');
    assert.ok(lines.some((l) => /reused from this run's unit-sidecar/.test(l)));
    for (const [files, why] of [[['test/missing.test.ts'], /not in the report/], [['test/bad.test.ts'], /1 failed/], [['test/skip.test.ts'], /1 skipped/]]) {
      lines.length = 0;
      assert.equal(sidecarReuse(root, files), null);
      assert.match(lines.join('\n'), why);
      assert.match(lines.join('\n'), /not reused .*running/);
    }
  });
  // a dirty tree, a different tree, an incomplete report, no unit-sidecar in the run
  fs.writeFileSync(path.join(root, 'sidecar', 'a.txt'), 'changed');
  withEnv({ GATE_SIDECAR_RESULTS: rf, GATE_SIDECAR_TREE: tree }, (lines) => { assert.equal(sidecarReuse(root, ['test/a.test.ts']), null); assert.match(lines.join(''), /dirty/); });
  git(root, 'checkout', '--', 'sidecar');
  fs.writeFileSync(path.join(root, 'sidecar', 'a.txt'), 'changed');
  git(root, 'commit', '-qam', 'two');
  withEnv({ GATE_SIDECAR_RESULTS: rf, GATE_SIDECAR_TREE: tree }, (lines) => { assert.equal(sidecarReuse(root, ['test/a.test.ts']), null); assert.match(lines.join(''), /not unit-sidecar's/); });
  const tree2 = sidecarTree(root);
  fs.writeFileSync(rf, xml([{ name: 'test/a.test.ts', cases: ['one'] }]).replace('</testsuites>\n', ''));
  withEnv({ GATE_SIDECAR_RESULTS: rf, GATE_SIDECAR_TREE: tree2 }, (lines) => { assert.equal(sidecarReuse(root, ['test/a.test.ts']), null); assert.match(lines.join(''), /missing or incomplete/); });
  withEnv({ GATE_SIDECAR_RESULTS: null, GATE_SIDECAR_TREE: null }, (lines) => { assert.equal(sidecarReuse(root, ['test/a.test.ts']), null); assert.equal(lines.length, 0); });
  fs.rmSync(root, { recursive: true, force: true });
});

test('identicalToBase: equal kit and scenarios trees skip; any difference, a dirty tree or no base never does', () => {
  const root = repo();
  const base = git(root, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'sidecar', 'a.txt'), 'only the sidecar changes');
  git(root, 'commit', '-qam', 'sidecar only');
  const s = identicalToBase(root, { ref: base });
  assert.equal(s.base, base);
  assert.match(skippedLine(s), /^unchanged: base == head \(kit [0-9a-f]{10}, scenarios [0-9a-f]{10}\), skipped$/);
  assert.equal(identicalToBase(root, { ref: null }), null);
  fs.writeFileSync(path.join(root, 'kit', 'a.txt'), 'dirty');
  assert.equal(identicalToBase(root, { ref: base }), null, 'an uncommitted kit change is never skipped');
  git(root, 'commit', '-qam', 'kit');
  assert.equal(identicalToBase(root, { ref: base }), null, 'a differing kit tree is never skipped');
  fs.writeFileSync(path.join(root, 'kit', 'new.txt'), 'untracked');
  assert.equal(identicalToBase(root, { ref: git(root, 'rev-parse', 'HEAD') }), null, 'an untracked file under kit is never skipped');
  fs.rmSync(root, { recursive: true, force: true });
});
