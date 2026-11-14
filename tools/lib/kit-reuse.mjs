// The kit suite once per gate run (docs/GATES.md "Kit suite once per run"). The runner's unit-kit step runs every kit test file
// and also writes a JUnit report to $GATE_KIT_RESULTS; the gate drivers' unit steps, which used to re-run the whole kit suite (and
// the goldens and the P0 tests) next to their own items, take those files' results from it instead. Only when it is exact:
//
// - the runner set GATE_KIT_RESULTS and GATE_KIT_TREE (unit-kit is in this run), and the report is complete (closing tag);
// - this checkout's kit/ is clean and its tree is the one unit-kit ran (GATE_KIT_TREE: HEAD:kit; unit-kit runs in the run
//   worktree at HEAD, the drivers from this checkout);
// - every requested file is in the report with at least one test and no failure, cancel or file-level error;
// - the call has no flag other than --test-skip-pattern (a subset of tests that all passed passes). A name pattern, or a call
//   that reads the tests' names or diagnostics, is the driver's own item and always runs.
//
// Otherwise (no unit-kit in the run: --only, a named chain, the verifier's re-runs; a failure in one of the files; a dirty kit/)
// it returns null and the driver runs the files itself, exactly as before.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { testConcurrencyArgs } from './cpu-budget.mjs';

let parsed = null;

function report(file) {
  if (parsed?.file === file) return parsed.files;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (!/<\/testsuites>\s*$/.test(text)) return null; // unit-kit still running, or killed mid-write
  const files = {};
  // attribute values may hold a raw `>` (a test named "plan -> LotSpec"), so attributes are matched as name="value" pairs
  for (const m of text.matchAll(/<testcase((?:\s+[\w:.-]+="[^"]*")*)\s*(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const f = /\bfile="([^"]+)"/.exec(m[1])?.[1];
    if (!f) return null; // a test the report can't place: don't guess
    const k = `kit/test/${path.basename(f)}`;
    const e = (files[k] ??= { tests: 0, failures: 0, skipped: 0 });
    e.tests++;
    const body = m[3] ?? '';
    // a todo test that fails is not a failure (node --test exits 0 for it); a skipped or todo test is not a pass
    if (/<skipped\b[^>]*type="todo"/.test(body)) e.skipped++;
    else if (/<failure\b|<error\b/.test(body)) e.failures++;
    else if (/<skipped\b/.test(body)) e.skipped++;
  }
  parsed = { file, files };
  return files;
}

function kitTree(root) {
  const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  const t = git('rev-parse', 'HEAD:kit');
  const s = git('status', '--porcelain', '--', 'kit');
  if (t.status !== 0 || s.status !== 0) return null;
  return s.stdout.trim() ? 'dirty' : t.stdout.trim();
}

/**
 * `args` as given to `node --test` (files, maybe --test-skip-pattern). -> null (run them yourself), or a result shaped like the
 * drivers' nodeTest: { code: 0, pass, fail: 0, failing: [], names: [], notes: [], comments: [], reused }.
 */
export function kitReuse(root, args, { startShared = false } = {}) {
  // (speed audit A) every fallback says why, so a driver that runs the files itself is never silent about it
  const no = (why) => { console.log(`  kit: not reused (${why}): running ${args.filter((a) => !a.startsWith('--')).map((f) => path.basename(f)).join(' ') || 'the files'} here`); return null; };
  let file = process.env.GATE_KIT_RESULTS;
  let tree = process.env.GATE_KIT_TREE;
  let source = 'this run\'s unit-kit';
  const flags = args.filter((a) => a.startsWith('--'));
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) return no('no files named');
  if (flags.some((f) => !f.startsWith('--test-skip-pattern='))) return no(`a flag the report can't stand for: ${flags.find((f) => !f.startsWith('--test-skip-pattern='))}`);
  const kt = kitTree(root);
  if (kt === 'dirty') return no('this checkout\'s kit/ is dirty');
  if (kt === null) return no('this checkout\'s kit tree can\'t be read');
  // (GX) unit-kit's report unusable (not in the run, timed out, killed): the run's shared kit suite, once for every reader
  if (!file || !tree || (tree === kt && !report(file))) {
    const why = !file || !tree ? 'no unit-kit in this run' : 'unit-kit\'s report is missing or incomplete';
    const sh = sharedSuite(root, kt, { start: startShared });
    if (!sh.file) return no(`${why}; ${sh.why}`);
    console.log(`  kit: ${why}: using the run's shared kit suite (${sh.why})`);
    file = sh.file;
    tree = kt;
    source = 'the run\'s shared kit suite';
  }
  if (kt !== tree) return no(`kit tree ${kt.slice(0, 12)} is not the one unit-kit ran, ${tree.slice(0, 12)}`);
  const rep = report(file);
  if (!rep) return no(`${source}'s report is missing, incomplete or has a test it can't place`);
  let pass = 0;
  for (const f of files) {
    const e = rep[f];
    if (!e) return no(`${f} is not in unit-kit's report`);
    if (e.tests === 0) return no(`${f} has no tests in the report`);
    if (e.failures > 0) return no(`${f} failed in ${source}`);
    // (GI A49) as javaReuse: a file whose every test was skipped (or todo) ran nothing there, so it is not a pass to reuse
    if (e.skipped >= e.tests) return no(`${f}: every test was skipped in unit-kit (nothing ran)`);
    pass += e.tests - e.skipped;
  }
  const reused = `reused from ${source} (${path.basename(file)}, kit tree ${tree.slice(0, 12)}): ${files.length} file(s), ${pass} pass, 0 fail${flags.length ? `; the run had every test, ${flags.join(' ')} would skip some` : ''}`;
  console.log(`  kit: ${reused}`);
  return { code: 0, pass, fail: 0, failing: [], names: [], notes: [], comments: [], reused };
}

// ------------------------------------------------------------------ (GX) the run's shared kit suite
//
// When unit-kit's report can't serve (unit-kit not in the run, or it timed out or was killed, so its report is incomplete), each
// driver used to run the files itself, and d-unit, t1-unit and others each ran the whole kit suite, side by side (SA's change run,
// 2026-11-13: three whole suites at load 400). Now the first reader that asks with `startShared` (a driver that needs the whole
// suite) runs the whole suite once, under a lock in the run's shared dir (GATE_KIT_SHARED_DIR, set by the runner), keyed by the
// kit tree; every other reader waits for it and reads its report under exactly the rules above (complete, the tree, every file
// present with tests and no failure). A reader that doesn't start it uses it only when it is running or done. A failed or
// incomplete shared suite serves nothing: the readers run their files themselves, as before.

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** -> { file, why } (file null: not available). The whole kit suite of this checkout, once per run and kit tree. */
export function sharedSuite(root, tree, { start = false, dir = process.env.GATE_KIT_SHARED_DIR, timeoutMs = 3_600_000, pollMs = 2000, run = runSuite } = {}) {
  if (!dir) return { file: null, why: 'no shared dir (not a gate run)' };
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `kit-${tree.slice(0, 16)}`);
  const junit = `${base}.junit.xml`;
  const done = `${base}.done`;
  const lock = `${base}.lock`;
  const t0 = Date.now();
  for (;;) {
    if (fs.existsSync(done)) {
      const d = JSON.parse(fs.readFileSync(done, 'utf8'));
      return d.complete ? { file: junit, why: `run by pid ${d.pid} in ${Math.round(d.seconds)} s${Date.now() - t0 > 200 ? `, waited ${Math.round((Date.now() - t0) / 100) / 10} s` : ''}` } : { file: null, why: `the shared kit suite ended incomplete (exit ${d.code})` };
    }
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    } catch {
      holder = fs.existsSync(lock) ? { pid: 0, at: fs.statSync(lock).mtimeMs } : null;
    }
    if (holder && (holder.pid ? !alive(holder.pid) : Date.now() - holder.at > 30_000)) {
      fs.rmSync(lock, { recursive: true, force: true }); // its owner died before writing .done: free
      holder = null;
    }
    if (!holder) {
      if (!start) return { file: null, why: 'no shared kit suite running or done for this tree' };
      try {
        fs.mkdirSync(lock);
      } catch {
        continue; // another reader took it first: wait for it
      }
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
      const s0 = Date.now();
      const r = run(root, junit, timeoutMs);
      const complete = r.code === 0 || r.code === 1 ? !!report(junit) : false;
      fs.writeFileSync(`${done}.tmp`, JSON.stringify({ pid: process.pid, code: r.code, complete, seconds: (Date.now() - s0) / 1000, tree }));
      fs.renameSync(`${done}.tmp`, done);
      fs.rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - t0 > timeoutMs) return { file: null, why: `waited ${Math.round(timeoutMs / 60000)} min for the shared kit suite (pid ${holder.pid})` };
    sleepMs(pollMs);
  }
}

function runSuite(root, junit, timeoutMs) {
  const files = fs.readdirSync(path.join(root, 'kit', 'test')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `kit/test/${f}`);
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), '--test-reporter=dot', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${junit}`, ...files], { cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 2 ** 20 });
  return { code: r.status };
}

/**
 * (GX) The drivers' nodeTest, without blocking: `node --test` over `files` in `root`, the same result shape ({ code, pass, fail,
 * failing, names, comments }), so independent groups of one driver run side by side.
 */
export function nodeTestAsync(root, files, { timeoutMs = 3_600_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let t = '';
    child.stdout.on('data', (d) => { t += d; });
    child.stderr.on('data', (d) => { t += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
      resolve({ code, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)), comments: t.split('\n').filter((l) => /^# /.test(l)).slice(0, 40) });
    });
  });
}

/** The kit-suite reader with the non-blocking fallback: unit-kit's (or the shared suite's) results, else `node --test` here. */
export async function kitOnceAsync(root, files, opts = {}) {
  return kitReuse(root, files, opts) ?? nodeTestAsync(root, files);
}
