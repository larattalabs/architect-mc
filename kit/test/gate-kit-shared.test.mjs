// The run's shared kit suite (tools/lib/kit-reuse.mjs sharedSuite; docs/GATES.md "Slice GX as built"): when unit-kit's report
// can't serve, the first reader that needs the whole suite runs it once under a lock, the others wait and read its report; an
// incomplete run serves nothing; a lock whose owner died is taken over; a reader that doesn't start it never waits for nothing.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { kitReuse, sharedSuite } from '../../tools/lib/kit-reuse.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TREE = 'abcdef0123456789abcdef';
const junit = (file, { complete = true, fail = false } = {}) => fs.writeFileSync(file, `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n<testcase name="a" time="0.1" classname="t" file="${path.join(ROOT, 'kit', 'test', 'gate-kit-shared.test.mjs')}">${fail ? '<failure message="x"/>' : ''}</testcase>\n${complete ? '</testsuites>\n' : ''}`);

test('the first starter runs the suite once; later readers get the same report; a non-starter only uses one that exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-shared-'));
  let runs = 0;
  const run = (_root, file) => {
    runs++;
    junit(file);
    return { code: 0 };
  };
  assert.equal(sharedSuite(ROOT, TREE, { dir, run }).file, null, 'no starter yet: nothing to read, no wait');
  assert.equal(runs, 0);
  const a = sharedSuite(ROOT, TREE, { dir, run, start: true });
  assert.ok(a.file && fs.existsSync(a.file), a.why);
  const b = sharedSuite(ROOT, TREE, { dir, run, start: true });
  const c = sharedSuite(ROOT, TREE, { dir, run });
  assert.equal(b.file, a.file);
  assert.equal(c.file, a.file);
  assert.equal(runs, 1, 'once per run and tree');
  assert.equal(sharedSuite(ROOT, 'ffffffffffffffffffff', { dir, run }).file, null, 'another kit tree is another suite');
});

test('an incomplete or crashed shared run serves nothing (the readers run their files themselves)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-shared-'));
  const r = sharedSuite(ROOT, TREE, { dir, start: true, run: (_root, file) => { junit(file, { complete: false }); return { code: null }; } });
  assert.equal(r.file, null);
  assert.match(r.why, /incomplete/);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-shared-'));
  // a run with failing tests is complete (exit 1): it serves, and the per-file rules refuse the failing files
  const f = sharedSuite(ROOT, TREE, { dir: dir2, start: true, run: (_root, file) => { junit(file, { fail: true }); return { code: 1 }; } });
  assert.ok(f.file);
});

test('a reader waits for a live holder, and takes over a lock whose owner died', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-shared-'));
  const base = path.join(dir, `kit-${TREE.slice(0, 16)}`);
  // a live holder (a child process) that finishes after 600 ms
  const child = spawn(process.execPath, ['-e', `setTimeout(() => { const fs = require('fs'); fs.writeFileSync(${JSON.stringify(`${base}.junit.xml`)}, ${JSON.stringify(`<testsuites>\n<testcase name="a" file="${path.join(ROOT, 'kit', 'test', 'x.test.mjs')}"/>\n</testsuites>\n`)}); fs.writeFileSync(${JSON.stringify(`${base}.done`)}, JSON.stringify({ pid: process.pid, code: 0, complete: true, seconds: 0.6 })); }, 600)`], { stdio: 'ignore' });
  fs.mkdirSync(`${base}.lock`);
  fs.writeFileSync(path.join(`${base}.lock`, 'owner.json'), JSON.stringify({ pid: child.pid, at: Date.now() }));
  let ran = 0;
  const w = sharedSuite(ROOT, TREE, { dir, start: true, pollMs: 100, run: () => { ran++; return { code: 0 }; } });
  assert.ok(w.file, w.why);
  assert.equal(ran, 0, 'it waited for the holder instead of running its own');
  assert.match(w.why, /waited/);
  // a dead owner's lock: free
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-shared-'));
  const b2 = path.join(dir2, `kit-${TREE.slice(0, 16)}`);
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.mkdirSync(`${b2}.lock`);
  fs.writeFileSync(path.join(`${b2}.lock`, 'owner.json'), JSON.stringify({ pid: Number(dead), at: Date.now() }));
  const t = sharedSuite(ROOT, TREE, { dir: dir2, start: true, pollMs: 50, run: (_root, file) => { junit(file); return { code: 0 }; } });
  assert.ok(t.file, t.why);
});

test('kitReuse: with no unit-kit report, it reads the shared suite (same per-file rules); a failing file is still a re-run', (t) => {
  const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' });
  const tree = git('rev-parse', 'HEAD:kit').stdout.trim();
  if (!tree || git('status', '--porcelain', '--', 'kit').stdout.trim()) {
    t.skip('kit/ is dirty or not a git tree: kitReuse would refuse anyway');
    return;
  }
  const saved = { GATE_KIT_RESULTS: process.env.GATE_KIT_RESULTS, GATE_KIT_TREE: process.env.GATE_KIT_TREE, GATE_KIT_SHARED_DIR: process.env.GATE_KIT_SHARED_DIR };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-shared-'));
  try {
    delete process.env.GATE_KIT_RESULTS;
    delete process.env.GATE_KIT_TREE;
    process.env.GATE_KIT_SHARED_DIR = dir;
    const files = ['kit/test/gate-kit-shared.test.mjs'];
    assert.equal(kitReuse(ROOT, files), null, 'nothing shared yet and not a starter: the driver runs the file');
    const base = path.join(dir, `kit-${tree.slice(0, 16)}`);
    junit(`${base}.junit.xml`);
    fs.writeFileSync(`${base}.done`, JSON.stringify({ pid: 1, code: 0, complete: true, seconds: 1 }));
    const hit = kitReuse(ROOT, files);
    assert.ok(hit?.reused, 'reused from the shared suite');
    assert.match(hit.reused, /shared kit suite/);
    assert.equal(hit.pass, 1);
    // unit-kit's report present but incomplete (timed out): the shared suite serves
    const partial = path.join(dir, 'unit-kit-partial.junit.xml');
    junit(partial, { complete: false });
    Object.assign(process.env, { GATE_KIT_RESULTS: partial, GATE_KIT_TREE: tree });
    assert.ok(kitReuse(ROOT, files)?.reused);
    // a failing file in the shared report: a re-run (another tree's dir, so the memo doesn't serve the old report)
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-shared-'));
    process.env.GATE_KIT_SHARED_DIR = dir2;
    delete process.env.GATE_KIT_RESULTS;
    const b2 = path.join(dir2, `kit-${tree.slice(0, 16)}`);
    junit(`${b2}.junit.xml`, { fail: true });
    fs.writeFileSync(`${b2}.done`, JSON.stringify({ pid: 1, code: 1, complete: true, seconds: 1 }));
    assert.equal(kitReuse(ROOT, files), null);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
