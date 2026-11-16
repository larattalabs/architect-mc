// (GR-b) kit-reuse when the shared producer (unit-kit) ended without a complete report (docs/GATES.md "Kit suite once per run"):
// producer PASS -> reuse its report; producer TIMEOUT -> the first whole-suite reader re-runs the suite once (lock + .done marker)
// and the others reuse it; a few-file reader runs its files and never waits; a second incomplete run fails fast; concurrent
// whole-suite readers in separate processes -> exactly one re-run. A temp git repo stands in for the checkout.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse, SHARED_MIN_FILES, suiteEnv } from '../../tools/lib/kit-reuse.mjs';
import { archTmpDir } from '../../tools/lib/arch-tmp.mjs';

const LIB = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'lib', 'kit-reuse.mjs')).href;
const N = SHARED_MIN_FILES + 5;
const ALL = Array.from({ length: N }, (_, i) => `kit/test/f${String(i).padStart(2, '0')}.test.mjs`);
const ENV = ['GATE_KIT_RESULTS', 'GATE_KIT_TREE', 'GATE_KIT_SHARED_DIR', 'GATE_KIT_PRODUCER'];

function repo() {
  const root = archTmpDir('grb2-kitprod');
  fs.mkdirSync(path.join(root, 'kit', 'test'), { recursive: true });
  for (const f of ALL) fs.writeFileSync(path.join(root, f), `// ${f}\n`);
  const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
  return { root, tree: git('rev-parse', 'HEAD:kit').stdout.trim() };
}
const junitText = (root, files, { complete = true } = {}) => `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${files.map((f) => `<testcase name="t" time="0.1" classname="c" file="${path.join(root, f)}"></testcase>`).join('\n')}\n${complete ? '</testsuites>\n' : ''}`;

function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV) delete process.env[k];
    Object.assign(process.env, vars);
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('producer PASS: its complete report is reused, no shared run', () => {
  const { root, tree } = repo();
  const dir = archTmpDir('grb2-kitprod');
  const rep = path.join(dir, 'unit-kit.junit.xml');
  fs.writeFileSync(rep, junitText(root, ALL));
  let runs = 0;
  const hit = withEnv({ GATE_KIT_RESULTS: rep, GATE_KIT_TREE: tree, GATE_KIT_SHARED_DIR: path.join(dir, 'shared'), GATE_KIT_PRODUCER: 'PASS' },
    () => kitReuse(root, ALL, { shared: { run: () => { runs++; return { code: 0 }; } } }));
  assert.match(hit?.reused ?? '', /this run's unit-kit/);
  assert.equal(hit.pass, N);
  assert.equal(runs, 0);
});

test('producer TIMEOUT: the first whole-suite reader re-runs once, the next reuses it; a few-file reader runs its own', () => {
  const { root, tree } = repo();
  const dir = archTmpDir('grb2-kitprod');
  const rep = path.join(dir, 'unit-kit.junit.xml');
  fs.writeFileSync(rep, junitText(root, ALL.slice(0, 3), { complete: false })); // killed mid-write
  let runs = 0;
  const run = (_root, junit) => {
    runs++;
    fs.writeFileSync(junit, junitText(root, ALL));
    return { code: 0 };
  };
  const env = { GATE_KIT_RESULTS: rep, GATE_KIT_TREE: tree, GATE_KIT_SHARED_DIR: path.join(dir, 'shared'), GATE_KIT_PRODUCER: 'TIMEOUT' };
  withEnv(env, () => {
    assert.equal(kitReuse(root, ALL.slice(0, 2), { shared: { run } }), null, 'a few files before any shared run: run here');
    assert.equal(runs, 0, 'a few-file reader never starts the whole suite');
    const a = kitReuse(root, ALL, { shared: { run } });
    assert.match(a?.reused ?? '', /shared kit suite/);
    const b = kitReuse(root, ALL, { shared: { run } });
    assert.match(b?.reused ?? '', /shared kit suite/);
    assert.equal(kitReuse(root, ALL.slice(0, 2), { shared: { run } })?.pass, 2, 'a few-file reader uses a done shared run');
    assert.equal(runs, 1, 'one re-run for the run');
  });
  // the producer still running (no status yet): a whole-suite reader doesn't start a duplicate
  const dir2 = archTmpDir('grb2-kitprod');
  withEnv({ ...env, GATE_KIT_SHARED_DIR: dir2, GATE_KIT_PRODUCER: '' }, () => {
    assert.equal(kitReuse(root, ALL, { shared: { run } }), null);
    assert.equal(runs, 1);
  });
});

test('producer TIMEOUT and the shared re-run incomplete too: a whole-suite reader fails fast (no stale PASS, no copy)', () => {
  const { root, tree } = repo();
  const dir = archTmpDir('grb2-kitprod');
  const rep = path.join(dir, 'unit-kit.junit.xml');
  fs.writeFileSync(rep, junitText(root, [], { complete: false }));
  let runs = 0;
  const run = (_root, junit) => {
    runs++;
    fs.writeFileSync(junit, junitText(root, ALL, { complete: false }));
    return { code: null };
  };
  withEnv({ GATE_KIT_RESULTS: rep, GATE_KIT_TREE: tree, GATE_KIT_SHARED_DIR: path.join(dir, 'shared'), GATE_KIT_PRODUCER: 'TIMEOUT' }, () => {
    for (let i = 0; i < 2; i++) {
      const r = kitReuse(root, ALL, { shared: { run } });
      assert.equal(r?.code, 1);
      assert.match(r.failFast, /unit-kit TIMEOUT and the shared kit re-run ended incomplete/);
    }
    assert.equal(runs, 1);
    assert.equal(kitReuse(root, ALL.slice(0, 2), { shared: { run } }), null, 'a few files still run here');
  });
});

test('concurrent whole-suite readers (separate processes): exactly one re-run, every reader reuses it', async () => {
  const { root, tree } = repo();
  const dir = archTmpDir('grb2-kitprod');
  const rep = path.join(dir, 'unit-kit.junit.xml');
  fs.writeFileSync(rep, junitText(root, [], { complete: false }));
  const counter = path.join(dir, 'runs.txt');
  const script = path.join(dir, 'reader.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
import { kitReuse } from ${JSON.stringify(LIB)};
const files = JSON.parse(process.argv[2]);
const run = (_root, junit) => {
  fs.appendFileSync(${JSON.stringify(counter)}, 'x');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  fs.writeFileSync(junit, ${JSON.stringify(junitText(root, ALL))});
  return { code: 0 };
};
const r = kitReuse(${JSON.stringify(root)}, files, { shared: { run, pollMs: 50 } });
process.stdout.write(JSON.stringify({ reused: r?.reused ?? null }));
`);
  const env = { ...process.env, GATE_KIT_RESULTS: rep, GATE_KIT_TREE: tree, GATE_KIT_SHARED_DIR: path.join(dir, 'shared'), GATE_KIT_PRODUCER: 'TIMEOUT' };
  const one = () => new Promise((resolve) => {
    const c = spawn(process.execPath, [script, JSON.stringify(ALL)], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => resolve(JSON.parse(out.split('\n').filter(Boolean).at(-1))));
  });
  const rs = await Promise.all([one(), one(), one()]);
  assert.equal(fs.readFileSync(counter, 'utf8').length, 1, 'one shared re-run');
  for (const r of rs) assert.match(r.reused ?? '', /shared kit suite/);
});

test("the shared re-run gets unit-kit's env: no GATE_KIT_PRODUCER (a kit test inside it never starts or waits on the run's lock)", () => {
  const e = suiteEnv({ PATH: '/bin', GATE_KIT_PRODUCER: 'TIMEOUT', GATE_KIT_SHARED_DIR: '/x' });
  assert.equal(e.GATE_KIT_PRODUCER, undefined);
  assert.equal(e.PATH, '/bin');
  assert.equal(e.GATE_KIT_SHARED_DIR, '/x');
});
