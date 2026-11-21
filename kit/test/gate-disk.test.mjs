// A gate run's disk use (tools/lib/run-dirs.mjs, docs/GATES.md "Disk space"): the cleanup after a PASS never follows a symlink out
// of a run dir, removes only the worktrees this run created, runs before the run gives up its lock and slot, and the free-space
// guard checks every volume the run writes to. Everything runs in temporary git repos; no real run dir is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkSpace, cleanupRunDirs } from '../../tools/lib/run-dirs.mjs';
import { archTmpDir } from '../../tools/lib/arch-tmp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (f, s = 'x') => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s);
};
const world = (dir, name, marker = 'level.dat') => write(path.join(dir, 'mod', 'run', 'saves', name, marker));

/** Minecraft/architect-mc (the main checkout) and its sibling default run dir; work/src (the slice's worktree) and run dirs under work/. */
function layout() {
  const root = archTmpDir('gate-disk');
  const mc = path.join(root, 'Minecraft');
  const main = path.join(mc, 'architect-mc');
  const work = path.join(root, 'work');
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  git(mc, 'init', '-q', main);
  write(path.join(main, '.gitignore'), 'mod/run/\n');
  write(path.join(main, 'kit', 'a.mjs'), 'export const v = 1;\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'one');
  const src = path.join(work, 'src');
  git(main, 'worktree', 'add', '-q', '--detach', src);
  world(main, 'main-world'); // the main checkout's own world: never a run's
  const wt = (dir) => {
    git(src, 'worktree', 'add', '-q', '--detach', dir);
    return dir;
  };
  const opts = { src, main, seed: path.join(mc, 'architect-mc-6a-run'), cfgRunDir: '../architect-mc-gate-run' };
  return { root, mc, main, work, src, wt, opts };
}
const exists = (p) => fs.existsSync(p);
const worktrees = (src) => git(src, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => fs.realpathSync(l.slice(9)));

// ---------------------------------------------------------------- finding 1: symlinks

test('cleanup: a reused run dir whose saves is a symlink to the main checkout\'s saves leaves main\'s worlds alone', () => {
  const { root, mc, main, wt, opts } = layout();
  try {
    const d = wt(path.join(mc, 'architect-mc-gate-run')); // beside main: reused, only its worlds go
    fs.mkdirSync(path.join(d, 'mod', 'run'), { recursive: true });
    fs.symlinkSync(path.join(main, 'mod', 'run', 'saves'), path.join(d, 'mod', 'run', 'saves'));
    cleanupRunDirs({ ...opts, verdict: 'PASS', dirs: [{ dir: d, created: false }] });
    assert.ok(exists(path.join(main, 'mod', 'run', 'saves', 'main-world', 'level.dat')), 'main\'s world survives');
    assert.ok(exists(d), 'the reused default dir stays');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup: a symlinked mod/run, a symlinked world entry and a link inside a world are never followed', () => {
  const { root, mc, main, work, wt, opts } = layout();
  try {
    const outside = path.join(work, 'outside');
    write(path.join(outside, 'keep', 'level.dat'));
    write(path.join(outside, 'deep', 'keep.txt'));
    // a: mod/run itself is a symlink into main
    const a = wt(path.join(mc, 'architect-mc-gate-run'));
    fs.mkdirSync(path.join(a, 'mod'), { recursive: true });
    fs.symlinkSync(path.join(main, 'mod', 'run'), path.join(a, 'mod', 'run'));
    // b: a real saves dir with one real world (holding a link out) and one world entry that is a link out
    const b = wt(path.join(mc, 'architect-mc-gate-run-s2'));
    world(b, 'own');
    fs.symlinkSync(path.join(outside, 'deep'), path.join(b, 'mod', 'run', 'saves', 'own', 'link'));
    fs.symlinkSync(path.join(outside, 'keep'), path.join(b, 'mod', 'run', 'saves', 'linked-world'));
    cleanupRunDirs({ ...opts, verdict: 'PASS', dirs: [{ dir: a, created: false }, { dir: b, created: false }] });
    assert.ok(exists(path.join(main, 'mod', 'run', 'saves', 'main-world', 'level.dat')), 'main\'s world survives a symlinked mod/run');
    assert.ok(exists(path.join(outside, 'keep', 'level.dat')), 'a linked world\'s target survives');
    assert.ok(exists(path.join(outside, 'deep', 'keep.txt')), 'the target of a link inside a world survives');
    assert.ok(!exists(path.join(b, 'mod', 'run', 'saves', 'own')), 'the run\'s own world copy goes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup: a run dir that is the main checkout (or this checkout, or the seed) by its real path is never emptied', () => {
  const { root, main, work, opts } = layout();
  try {
    const link = path.join(work, 'architect-mc'); // _work/architect-mc is a symlink to the main checkout
    fs.symlinkSync(main, link);
    cleanupRunDirs({ ...opts, verdict: 'PASS', dirs: [{ dir: link, created: false }] });
    assert.ok(exists(path.join(main, 'mod', 'run', 'saves', 'main-world', 'level.dat')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- finding 2: ownership

test('cleanup: only the worktrees this run created are removed; another slice\'s worktree keeps everything', () => {
  const { root, mc, work, src, wt, opts } = layout();
  try {
    const mine = wt(path.join(work, 'architect-mc-DISK-run')); // added by this invocation
    world(mine, 'w1');
    const other = wt(path.join(work, 'architect-mc-OTHER')); // another slice's worktree, passed as --run-dir
    world(other, 'their-world');
    const reused = wt(path.join(work, 'architect-mc-DISK-run-s2')); // an earlier run's dir, reused: not this run's
    world(reused, 'old');
    const dflt = wt(path.join(mc, 'architect-mc-gate-run')); // the reused default beside main
    world(dflt, 'w2');
    const logs = [];
    cleanupRunDirs({ ...opts, verdict: 'PASS', log: (m) => logs.push(m), dirs: [
      { dir: mine, created: true }, { dir: other, created: false }, { dir: reused, created: false }, { dir: dflt, created: false }] });
    const wts = worktrees(src);
    assert.ok(!exists(mine) && !wts.includes(fs.realpathSync(work) + '/architect-mc-DISK-run'), 'this run\'s worktree is removed');
    assert.ok(wts.includes(fs.realpathSync(other)), 'another slice\'s worktree stays a worktree');
    assert.ok(exists(path.join(other, 'mod', 'run', 'saves', 'their-world', 'level.dat')), 'and keeps its worlds');
    assert.ok(exists(path.join(reused, 'mod', 'run', 'saves', 'old', 'level.dat')), 'a reused non-default dir is not this run\'s: kept whole');
    assert.ok(wts.includes(fs.realpathSync(dflt)) && !exists(path.join(dflt, 'mod', 'run', 'saves', 'w2')), 'the default keeps its worktree, loses its worlds');
    assert.ok(logs.some((m) => m.includes(other) && /not created by this run/.test(m)), logs.join('\n'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup: a FAIL or --keep-run-dirs keeps everything, even what this run created', () => {
  const { root, work, wt, opts } = layout();
  try {
    const mine = wt(path.join(work, 'architect-mc-DISK-run'));
    world(mine, 'w1');
    cleanupRunDirs({ ...opts, verdict: 'FAIL', dirs: [{ dir: mine, created: true }] });
    cleanupRunDirs({ ...opts, verdict: 'PASS', keep: true, dirs: [{ dir: mine, created: true }] });
    assert.ok(exists(path.join(mine, 'mod', 'run', 'saves', 'w1', 'level.dat')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- finding 4: cleanup before the lock and slot go

test('gate-run: the cleanup runs inside finish(), after the verdict and before the summary, notify and the lock release', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools', 'gate-run.mjs'), 'utf8');
  const i = s.indexOf('async function finish(');
  assert.ok(i > 0);
  const body = s.slice(i, s.indexOf('\n}\n', i));
  const at = (re) => body.search(re);
  const clean = at(/cleanupRunDirs\(summary\.verdict\)/);
  assert.ok(clean > 0, 'finish() cleans up');
  assert.ok(clean > at(/summary\.verdict = /), 'after the verdict');
  for (const re of [/SUMMARY\.md'\), summaryMd/, /\bnotify\(\)/, /\breleaseLock\(\)/]) assert.ok(clean < at(re), `before ${re}`);
  assert.match(body.slice(body.lastIndexOf('try {', clean), clean), /try \{/, 'inside a try: a cleanup failure never changes the verdict');
  // summary.json's state is what waiting agents watch (AGENTS.md): it turns terminal only once the cleanup is done
  assert.ok(at(/summary\.state = state/) > clean, 'summary.state turns terminal after the cleanup');
  const tail = s.slice(s.lastIndexOf("await finish(stopped || draining ? 'stopped' : 'done');"));
  assert.doesNotMatch(tail, /cleanupRunDirs/, 'nothing cleans up after finish() has released the lock');
});

// ---------------------------------------------------------------- finding 5: every destination's volume

/** A fake statfs: `low` real-path prefixes have 10 GiB free, every other path 500. */
const fakeStatfs = (low, calls) => (p) => {
  calls.push(p);
  const free = low.some((l) => p === l || p.startsWith(l + path.sep)) ? 10 : 500;
  return { bavail: free * 2 ** 30 / 4096, bsize: 4096 };
};

test('space guard: --run-dirs elsewhere and no frozen source: the unused default\'s low volume does not refuse', () => {
  const root = archTmpDir('gate-disk');
  try {
    const lowVol = path.join(root, 'low');
    const big = path.join(root, 'big');
    fs.mkdirSync(lowVol);
    fs.mkdirSync(big);
    const calls = [];
    const r = checkSpace({ min: 150, run1: path.join(lowVol, 'architect-mc-gate-run'), runDirs: [path.join(big, 'run-a'), path.join(big, 'run-b')],
      frozen: false, drvDir: path.join(lowVol, 'architect-mc-gate-run-src'), statfs: fakeStatfs([fs.realpathSync(lowVol)], calls) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(calls.every((p) => !p.startsWith(fs.realpathSync(lowVol))), `the unused default is not probed: ${calls}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('space guard: any actual destination on a low volume refuses (a --run-dirs dir, the frozen source, a symlinked run dir)', () => {
  const root = archTmpDir('gate-disk');
  try {
    const lowVol = path.join(root, 'low');
    const big = path.join(root, 'big');
    fs.mkdirSync(lowVol);
    fs.mkdirSync(big);
    const lowReal = fs.realpathSync(lowVol);
    // a run dir on the low volume, the others fine
    const a = checkSpace({ min: 150, run1: path.join(big, 'r'), runDirs: [path.join(big, 'run-a'), path.join(lowVol, 'run-b')], statfs: fakeStatfs([lowReal], []) });
    assert.equal(a.ok, false);
    assert.ok(a.low.some((v) => v.probe.startsWith(lowReal)), JSON.stringify(a));
    // the frozen source (<run dir>-src beside RUN1) on the low volume while --run-dirs are fine
    const b = checkSpace({ min: 150, run1: path.join(lowVol, 'r'), runDirs: [path.join(big, 'run-a')], frozen: true, drvDir: path.join(lowVol, 'r-src'), statfs: fakeStatfs([lowReal], []) });
    assert.equal(b.ok, false, JSON.stringify(b));
    // a run dir that is a symlink to the low volume: probed by its real path
    fs.mkdirSync(path.join(lowVol, 'target'));
    fs.symlinkSync(path.join(lowVol, 'target'), path.join(big, 'linked-run'));
    const calls = [];
    const c = checkSpace({ min: 150, run1: path.join(big, 'linked-run'), statfs: fakeStatfs([lowReal], calls) });
    assert.equal(c.ok, false, JSON.stringify(c));
    assert.ok(calls.includes(path.join(lowReal, 'target')), `probed by real path: ${calls}`);
    // all on the big volume: fine
    assert.equal(checkSpace({ min: 150, run1: path.join(big, 'r'), frozen: true, drvDir: path.join(big, 'r-src'), statfs: fakeStatfs([lowReal], []) }).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
