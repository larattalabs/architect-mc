// tools/lib/junit-reuse.mjs: a driver's Java test patterns answer from this run's unit-mod XML only when exact (speed audit A);
// (GI2) method patterns (`Class.method`, `*` in the method part) match <testcase> names, failing closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { javaReuse, methodPattern, readJunitDir } from '../../tools/lib/junit-reuse.mjs';
import { archTmpDir } from '../../tools/lib/arch-tmp.mjs';

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
function repo() {
  const dir = archTmpDir('junit-reuse');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'one');
  return dir;
}
const suite = (cls, cases) => `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${cls}" tests="${cases.length}" skipped="${cases.filter((c) => c.skip).length}" failures="${cases.filter((c) => c.fail).length}" errors="0" timestamp="x" hostname="h" time="0.1">\n  <properties/>\n${cases.map((c) => c.skip ? `  <testcase name="${c.n}" classname="${cls}" time="0"><skipped/></testcase>` : c.fail ? `  <testcase name="${c.n}" classname="${cls}" time="0"><failure message="x">boom</failure></testcase>` : `  <testcase name="${c.n}" classname="${cls}" time="0.01"/>`).join('\n')}\n  <system-out><![CDATA[]]></system-out>\n</testsuite>\n`;
function fixture() {
  const root = repo();
  const dir = archTmpDir('junit-reuse-xml');
  fs.writeFileSync(path.join(dir, 'TEST-dev.x.FooTest.xml'), suite('dev.x.FooTest', [{ n: 'alpha()' }, { n: 'alphaTwo()' }, { n: 'beta(int)' }]));
  fs.writeFileSync(path.join(dir, 'TEST-dev.x.BarTest.xml'), suite('dev.x.BarTest', [{ n: 'ok()' }, { n: 'gone()', skip: true }]));
  fs.writeFileSync(path.join(dir, 'TEST-dev.x.BadTest.xml'), suite('dev.x.BadTest', [{ n: 'fine()' }, { n: 'broken()', fail: true }]));
  return { root, dir, env: { GATE_UNIT_MOD_JUNIT: dir, GATE_UNIT_MOD_TREE: git(root, 'rev-parse', 'HEAD^{tree}') } };
}
function reuse(f, patterns) {
  const old = { ...process.env };
  Object.assign(process.env, f.env);
  for (const k of ['GRADLE_OPTS', 'JAVA_TOOL_OPTIONS', 'JAVA_OPTS']) delete process.env[k];
  const lines = [];
  try {
    return { r: javaReuse(f.root, patterns, { log: (m) => lines.push(m) }), lines };
  } finally {
    for (const k of Object.keys(f.env)) if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k];
  }
}

test('methodPattern: Class.method with globs; class names and plain classes are not method patterns', () => {
  assert.deepEqual({ ...methodPattern('dev.x.FooTest.alpha'), re: undefined }, { cls: 'dev.x.FooTest', method: 'alpha', re: undefined });
  assert.ok(methodPattern('*FooTest.alpha*').re.test('alphaTwo'));
  assert.ok(!methodPattern('FooTest.alpha').re.test('alphaTwo'));
  assert.equal(methodPattern('dev.x.FooTest'), null, 'a class name');
  assert.equal(methodPattern('*FooTest'), null);
  assert.equal(methodPattern('dev.x'), null);
});

test('readJunitDir reads every testcase with its skipped and failed marks', () => {
  const f = fixture();
  const rows = readJunitDir(f.dir);
  const bar = rows.find((r) => r.name === 'dev.x.BarTest');
  assert.deepEqual(bar.cases, [{ name: 'ok()', skipped: false, failed: false }, { name: 'gone()', skipped: true, failed: false }]);
  assert.equal(rows.find((r) => r.name === 'dev.x.BadTest').cases[1].failed, true);
});

test('javaReuse: class patterns as before; method patterns count their matched cases', () => {
  const f = fixture();
  assert.equal(reuse(f, ['*FooTest']).r.tests, 3);
  const one = reuse(f, ['dev.x.FooTest.alpha']);
  assert.equal(one.r.tests, 1, 'alpha only, not alphaTwo');
  assert.match(one.r.reused, /1 class\(es\) \(1 by method\), 1 tests/);
  assert.equal(reuse(f, ['*FooTest.alpha*']).r.tests, 2);
  assert.equal(reuse(f, ['dev.x.FooTest.beta']).r.tests, 1, 'a parameter list in the name is matched without it');
  assert.equal(reuse(f, ['dev.x.BarTest.ok']).r.tests, 1, 'the class has a skipped test, the method asked for ran');
  assert.equal(reuse(f, ['dev.x.BadTest.fine']).r.tests, 1, 'the class failed elsewhere; this method passed');
  // a class and its own method: counted once
  assert.equal(reuse(f, ['*FooTest', 'dev.x.FooTest.alpha']).r.tests, 3);
});

test('javaReuse: method patterns fail closed (no match, skipped, failed, unknown class)', () => {
  const f = fixture();
  for (const [p, why] of [['dev.x.FooTest.gamma', /no testcase/], ['dev.x.BarTest.gone', /skipped/], ['dev.x.BadTest.broken', /failed/], ['dev.x.NoTest.alpha', /class dev.x.NoTest is not/]]) {
    const { r, lines } = reuse(f, [p]);
    assert.equal(r, null, p);
    assert.match(lines.join('\n'), why, p);
  }
  assert.equal(reuse(f, ['*BadTest']).r, null, 'a whole failed class is still refused');
});
