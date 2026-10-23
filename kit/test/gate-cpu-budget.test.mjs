// The gate runner's CPU budget (tools/lib/cpu-budget.mjs, docs/GATES.md "CPU budget"): the share arithmetic, the environment a
// step's children get, that `--test-concurrency` really bounds node --test, that the chain shells and every driver pass it, and
// that the drivers' kit-suite reuse still hits (the flag never goes into kitReuse's file list).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { budgetEnv, cpuShare, machineCores, testConcurrencyArgs } from '../../tools/lib/cpu-budget.mjs';
import { kitReuse } from '../../tools/lib/kit-reuse.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the share: the cores over the workers, at least minShare, at most cores - 1', () => {
  assert.deepEqual(cpuShare({ cores: 18, workers: 12 }), { cores: 18, workers: 12, share: 2 }); // turbo: 9 shards + 3 lanes
  assert.equal(cpuShare({ cores: 18, workers: 6 }).share, 3);
  assert.equal(cpuShare({ cores: 18, workers: 4 }).share, 4); // a shared run: at least --slots (4) workers
  assert.equal(cpuShare({ cores: 18, workers: 30 }).share, 2); // the floor: a plan pool of 1 is the serial loop
  assert.equal(cpuShare({ cores: 18, workers: 30, conf: { minShare: 1 } }).share, 1);
  assert.equal(cpuShare({ cores: 18, workers: 1 }).share, 17);
  assert.equal(cpuShare({ cores: 18, workers: 2, conf: { maxShare: 6 } }).share, 6);
  assert.equal(machineCores({ GATE_CPU_CORES: '7' }), 7);
  assert.equal(machineCores({}), os.availableParallelism());
});

test('the environment: every consumer gets the step\'s share; a by-hand value wins', () => {
  const e = budgetEnv({ cores: 18, share: 2 });
  assert.deepEqual(e, { GATE_CPU_CORES: '18', GATE_CPU_SHARE: '2', GATE_PLAN_WORKERS: '2', GATE_TEST_CONCURRENCY: '2', VITEST_MAX_WORKERS: '2', GRADLE_OPTS: '-Dorg.gradle.workers.max=2' });
  assert.equal(budgetEnv({ cores: 18, share: 2 }, { shares: 4 }).GATE_TEST_CONCURRENCY, '8'); // unit-kit's cpuShares
  assert.equal(budgetEnv({ cores: 18, share: 6 }, { shares: 4 }).GATE_TEST_CONCURRENCY, '17'); // at most cores - 1
  const kept = budgetEnv({ cores: 18, share: 2 }, { env: { GATE_PLAN_WORKERS: '6', GRADLE_OPTS: '-Xmx1g' } });
  assert.equal(kept.GATE_PLAN_WORKERS, '6');
  assert.equal(kept.GRADLE_OPTS, '-Xmx1g -Dorg.gradle.workers.max=2');
  assert.equal(budgetEnv({ cores: 18, share: 2 }, { env: { GRADLE_OPTS: '-Dorg.gradle.workers.max=9' } }).GRADLE_OPTS, '-Dorg.gradle.workers.max=9');
  assert.deepEqual(testConcurrencyArgs({}), []); // outside the runner: node's own default
  assert.deepEqual(testConcurrencyArgs({ GATE_TEST_CONCURRENCY: '3' }), ['--test-concurrency=3']);
  assert.deepEqual(testConcurrencyArgs({ GATE_TEST_CONCURRENCY: 'x' }), []);
});

test('--test-concurrency bounds node --test: at 1 no two files overlap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-budget-'));
  try {
    const log = path.join(dir, 'log.txt');
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.test.mjs`), `import { test } from 'node:test';\nimport fs from 'node:fs';\n`
        + `test('t${i}', async () => { fs.appendFileSync(${JSON.stringify(log)}, 's\\n'); await new Promise((r) => setTimeout(r, 150)); fs.appendFileSync(${JSON.stringify(log)}, 'e\\n'); });\n`);
    }
    const files = [0, 1, 2, 3].map((i) => path.join(dir, `f${i}.test.mjs`));
    const run = (env) => {
      fs.rmSync(log, { force: true });
      // (a node --test child runs a nested node --test as its own subtests unless NODE_TEST_CONTEXT is dropped)
      const { NODE_TEST_CONTEXT, ...clean } = process.env;
      const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(env), ...files], { encoding: 'utf8', env: clean });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return fs.readFileSync(log, 'utf8').trim().split('\n').join('');
    };
    assert.equal(run({ GATE_TEST_CONCURRENCY: '1' }), 'sesesese');
    if (os.availableParallelism() > 2) assert.notEqual(run({}), 'sesesese', 'without the flag the files run at once');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the chain shells that run node --test pass the share, and only when the runner set it', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'gate-chains.json'), 'utf8'));
  for (const [id, s] of Object.entries(cfg.steps)) {
    for (const m of (s.shell ?? '').matchAll(/node --test\b(.{0,80})/g)) assert.match(m[1], /^ \$\{GATE_TEST_CONCURRENCY:\+--test-concurrency=\$GATE_TEST_CONCURRENCY\}/, `${id}: ${m[0]}`);
  }
  assert.equal(cfg.steps['unit-kit'].cpuShares, 4);
  const { GATE_TEST_CONCURRENCY, ...base } = process.env; // (unit-kit itself runs with the runner's share set)
  const echo = (env) => spawnSync('sh', ['-c', 'echo node --test ${GATE_TEST_CONCURRENCY:+--test-concurrency=$GATE_TEST_CONCURRENCY} a.test.mjs'], { encoding: 'utf8', env: { ...base, ...env } }).stdout.trim();
  assert.equal(echo({}), 'node --test a.test.mjs');
  assert.equal(echo({ GATE_TEST_CONCURRENCY: '2' }), 'node --test --test-concurrency=2 a.test.mjs');
});

test('every gate driver that spawns node --test passes testConcurrencyArgs()', () => {
  const dirs = [path.join(ROOT, 'tools'), path.join(ROOT, 'tools', 'lib')];
  const bad = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.mjs'))) {
      const lines = fs.readFileSync(path.join(d, f), 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (/^\s*(\/\/|\/?\*)/.test(l) || /docker\(/.test(l)) return; // a container run gets none of the runner's environment
        if (/\[\s*'--test'\s*,|['"`]node --test\b/.test(l) && !/testConcurrencyArgs\(\)/.test(l)) bad.push(`${path.relative(ROOT, path.join(d, f))}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(bad, []);
});

test('the drivers\' kit-suite reuse still hits: the flag stays out of kitReuse\'s file list', (t) => {
  const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' });
  const tree = git('rev-parse', 'HEAD:kit').stdout.trim();
  if (!tree || git('status', '--porcelain', '--', 'kit').stdout.trim()) {
    t.skip('kit/ is dirty or not a git tree: kitReuse would refuse anyway');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-budget-junit-'));
  const saved = { GATE_KIT_RESULTS: process.env.GATE_KIT_RESULTS, GATE_KIT_TREE: process.env.GATE_KIT_TREE };
  try {
    const file = path.join(dir, 'kit.junit.xml');
    fs.writeFileSync(file, `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n<testcase name="a" time="0.1" classname="test" file="${path.join(ROOT, 'kit', 'test', 'gate-cpu-budget.test.mjs')}"/>\n</testsuites>\n`);
    Object.assign(process.env, { GATE_KIT_RESULTS: file, GATE_KIT_TREE: tree });
    const files = ['kit/test/gate-cpu-budget.test.mjs'];
    const hit = kitReuse(ROOT, files);
    assert.ok(hit?.reused, 'reused');
    assert.equal(hit.pass, 1);
    assert.equal(kitReuse(ROOT, [...testConcurrencyArgs({ GATE_TEST_CONCURRENCY: '2' }), ...files]), null, 'a flag in the list is a re-run');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
