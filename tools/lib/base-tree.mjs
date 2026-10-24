// The drivers' merge-base worktrees (../architect-mc-<X>-main, for "byte-identical against the merge base" items), made or moved
// there under a lock (docs/GATES.md "Turbo": split steps). A split unit step's parts start together: unlocked, one part's checkout
// rewrote the tree while another part read it ("Cannot find module .../plan-helpers.mjs"), and their concurrent `git fetch`es
// raced for the ref lock. Now one process fetches and checks out at a time, and a tree already at the base is left alone; under
// gate-run the base is the run's GATE_MERGE_BASE, fixed when it starts (origin/main moving mid-run moved the tree under readers).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** fn() holding `<dir>.gate-lock` (mkdir; a dead owner's lock, or one older than 15 min, is taken over). */
export function withDirLock(dir, fn) {
  const lock = `${dir}.gate-lock`;
  const t0 = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner'), String(process.pid));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = 0;
      try { owner = Number(fs.readFileSync(path.join(lock, 'owner'), 'utf8')); } catch { /* being written */ }
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if ((owner && !alive(owner)) || age > 15 * 60_000 || (!owner && age > 30_000)) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - t0 > 20 * 60_000) throw new Error(`${lock}: still held by pid ${owner} after 20 min`);
      sleepSync(500);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** -> { dir, base }: `dir` (a detached worktree of root's repository) at the merge base of HEAD and origin/main. */
export function syncBaseTree(root, dir, { fetchOptional = false } = {}) {
  return withDirLock(dir, () => {
    // a gate run fixes the merge base once (GATE_MERGE_BASE): every step and part of the run compares with the same commit, and
    // none fetches while another reads the tree
    let base = process.env.GATE_MERGE_BASE?.trim() || null;
    if (!base) {
      try {
        execFileSync('git', ['-C', root, 'fetch', '-q', 'origin', 'main']);
      } catch (e) {
        if (!fetchOptional) throw e; // (offline: the last fetched origin/main)
      }
      base = execFileSync('git', ['-C', root, 'merge-base', 'HEAD', 'origin/main']).toString().trim();
    }
    if (!fs.existsSync(path.join(dir, '.git'))) execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', dir, base]);
    else if (execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim() !== base) execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach', base]);
    return { dir, base };
  });
}

/**
 * (speed audit D, K1) -> null, or { base, head, kit, scenarios } when the base's kit/ and scenarios/ trees are byte-identical to HEAD's
 * (equal tree shas, and no uncommitted change under them): a "byte-identical to the merge base" loop over the same kit and scenarios
 * can only agree, so the caller skips it and prints one check line instead. Only under a gate run (the run's GATE_MERGE_BASE, or the
 * `ref` the caller really compares with); otherwise null. If the trees differ at all, or anything can't be read, null: never skip.
 */
export function identicalToBase(root, { ref = process.env.GATE_MERGE_BASE?.trim() || null } = {}) {
  if (!ref || process.env.GATE_NO_UNCHANGED_SKIP === '1') return null;
  try {
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (git('status', '--porcelain', '--', 'kit', 'scenarios') !== '') return null;
    const [bk, hk, bs, hs] = [git('rev-parse', `${ref}:kit`), git('rev-parse', 'HEAD:kit'), git('rev-parse', `${ref}:scenarios`), git('rev-parse', 'HEAD:scenarios')];
    if (!bk || !bs || bk !== hk || bs !== hs) return null;
    return { base: git('rev-parse', ref), head: git('rev-parse', 'HEAD'), kit: hk, scenarios: hs };
  } catch {
    return null;
  }
}

/** The check line for a skipped loop. */
export const skippedLine = (s, label = 'unchanged') => `${label}: base == head (kit ${s.kit.slice(0, 10)}, scenarios ${s.scenarios.slice(0, 10)}), skipped`;
