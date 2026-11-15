// tools/lib/junit-reuse.mjs: a driver's Java test patterns answer from this run's unit-mod XML only when exact (speed audit A);
// (GI2) method patterns (`Class.method`, `*` in the method part) match <testcase> names, failing closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { javaClasses, javaReuse, methodPattern, readJunitDir } from '../../tools/lib/junit-reuse.mjs';
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

// (chore GRB) b-unit's and t3b-unit's Java classes: their own patterns against unit-mod's XML, and the gradle fallback under the lock
const xmlDir = (rows) => {
  const dir = archTmpDir('junit-reuse-grb');
  for (const [cls, cases] of rows) fs.writeFileSync(path.join(dir, `TEST-dev.larattalabs.architect.${cls}.xml`), suite(`dev.larattalabs.architect.${cls}`, cases));
  return dir;
};
function withEnv(env, fn) {
  const old = { ...process.env };
  Object.assign(process.env, env);
  for (const k of ['GRADLE_OPTS', 'JAVA_TOOL_OPTIONS', 'JAVA_OPTS']) delete process.env[k];
  try { return fn(); } finally { for (const k of Object.keys(env)) if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
}

test('javaClasses: b-unit\'s and t3b-unit\'s patterns answer from unit-mod\'s XML, per class', () => {
  const root = repo();
  const dir = xmlDir([['api.ApiBTest', [{ n: 'a()' }, { n: 'b()' }]], ['region.BrushesTest', [{ n: 'a()' }]], ['region.volume.ArvxBlocksTest', [{ n: 'a()' }]],
    ['region.volume.ArvxTest', [{ n: 'a()' }, { n: 'b()' }]], ['region.PlanChecksT3Test', [1, 2, 3, 4, 5].map((i) => ({ n: `t${i}()` }))], ['api.ApiT3Test', [{ n: 'a()' }]]]);
  const env = { GATE_UNIT_MOD_JUNIT: dir, GATE_UNIT_MOD_TREE: git(root, 'rev-parse', 'HEAD^{tree}') };
  const lines = [];
  const b = withEnv(env, () => javaClasses(root, ['*ApiBTest', '*BrushesTest', '*ArvxBlocksTest', '*ArvxTest'], ['api.ApiBTest', 'region.BrushesTest', 'region.volume.ArvxBlocksTest', 'region.volume.ArvxTest'], () => assert.fail('gradle ran'), { log: (m) => lines.push(m) }));
  assert.equal(b.code, 0);
  assert.ok(b.reused, lines.join('\n'));
  assert.deepEqual(b.classes, { 'api.ApiBTest': { tests: 2, failures: 0 }, 'region.BrushesTest': { tests: 1, failures: 0 }, 'region.volume.ArvxBlocksTest': { tests: 1, failures: 0 }, 'region.volume.ArvxTest': { tests: 2, failures: 0 } });
  const t = withEnv(env, () => javaClasses(root, ['*PlanChecksT3Test*', '*ApiT3Test*'], ['region.PlanChecksT3Test'], () => assert.fail('gradle ran'), { log: () => {} }));
  assert.deepEqual([t.code, t.classes['region.PlanChecksT3Test']], [0, { tests: 5, failures: 0 }]);
});

test('javaClasses: without unit-mod\'s XML it runs gradle holding the checkout\'s gradle lock and reads the XML inside it', () => {
  const root = repo();
  fs.mkdirSync(path.join(root, 'mod'));
  // a stand-in gradlew: refuses to run unless the lock is held, then writes the class's XML
  const res = path.join(root, 'mod', 'build', 'test-results', 'test');
  fs.writeFileSync(path.join(root, 'mod', 'gradlew'), `#!/bin/sh\n[ -d .gradle/gate-gradle.lock ] || { echo "no lock"; exit 3; }\nmkdir -p build/test-results/test\ncat > build/test-results/test/TEST-dev.larattalabs.architect.region.PlanChecksT3Test.xml <<'X'\n${suite('dev.larattalabs.architect.region.PlanChecksT3Test', [{ n: 'a()' }, { n: 'b()' }, { n: 'c()' }, { n: 'd()' }])}X\n`, { mode: 0o755 });
  const t = withEnv({ GATE_UNIT_MOD_JUNIT: '', GATE_UNIT_MOD_TREE: '' }, () => javaClasses(root, ['*PlanChecksT3Test*'], ['region.PlanChecksT3Test', 'api.ApiT3Test'],
    () => spawnSync('./gradlew', ['test'], { cwd: path.join(root, 'mod'), encoding: 'utf8' }), { log: () => {} }));
  assert.equal(t.code, 0, t.tail.join('\n'));
  assert.equal(t.reused, null);
  assert.deepEqual(t.classes, { 'region.PlanChecksT3Test': { tests: 4, failures: 0 }, 'api.ApiT3Test': null });
  assert.ok(fs.existsSync(res));
  assert.ok(!fs.existsSync(path.join(root, 'mod', '.gradle', 'gate-gradle.lock')), 'the lock is released');
});
