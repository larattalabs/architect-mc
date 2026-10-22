// The drivers' merge-base worktrees (../architect-mc-<X>-main, for "byte-identical against the merge base" items), made or moved
// there under a lock (docs/GATES.md "Turbo": split steps). A split unit step's parts start together: unlocked, one part's checkout
// rewrote the tree while another part read it ("Cannot find module .../plan-helpers.mjs"), and their concurrent `git fetch`es
// raced for the ref lock. Now one process fetches and checks out at a time, and a tree already at the base is left alone.
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
    try {
      execFileSync('git', ['-C', root, 'fetch', '-q', 'origin', 'main']);
    } catch (e) {
      if (!fetchOptional) throw e; // (offline: the last fetched origin/main)
    }
    const base = execFileSync('git', ['-C', root, 'merge-base', 'HEAD', 'origin/main']).toString().trim();
    if (!fs.existsSync(path.join(dir, '.git'))) execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', dir, base]);
    else if (execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim() !== base) execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach', base]);
    return { dir, base };
  });
}
