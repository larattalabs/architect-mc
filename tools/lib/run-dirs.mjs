// A gate run's disk use (docs/GATES.md "Disk space"): the free-space guard before a run takes a slot, and the cleanup of its run
// dirs after a PASS. tools/gate-run.mjs calls both; kit/test/gate-disk.test.mjs runs them against temporary repos.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
/** `p` is `dir` or inside it (both real paths). */
const within = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/** The real path of `p`'s nearest existing ancestor (`p` itself when it exists): the volume a write to `p` lands on. */
export function nearestExisting(p) {
  let probe = path.resolve(p);
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  return real(probe);
}

/**
 * The free-space guard: a run refuses to start when any volume it writes to has under `min` GiB free. The destinations are every
 * run dir (`runDirs` when --run-dirs names them, else `run1`; its -s<k>/-o<j> shards sit beside it) and the frozen source
 * (`drvDir`, <run1>-src, when `frozen`), each judged by the real path of its nearest existing ancestor, so a symlinked run dir
 * counts on its target's volume. `min` <= 0 turns it off. -> { ok, min, volumes: [{ probe, free, dests }], low: [...] }
 */
export function checkSpace({ min, run1, runDirs = [], frozen = false, drvDir = null, statfs = fs.statfsSync }) {
  if (!(min > 0)) return { ok: true, min, volumes: [], low: [] };
  const dests = [...(runDirs.length ? runDirs : [run1]), ...(frozen && drvDir ? [drvDir] : [])];
  const byProbe = new Map();
  for (const d of dests) {
    const probe = nearestExisting(d);
    if (!byProbe.has(probe)) byProbe.set(probe, []);
    byProbe.get(probe).push(d);
  }
  const volumes = [...byProbe].map(([probe, ds]) => {
    const st = statfs(probe);
    return { probe, free: (st.bavail * st.bsize) / 2 ** 30, dests: ds };
  });
  const low = volumes.filter((v) => v.free < min);
  return { ok: !low.length, min, volumes, low };
}

/**
 * Empties `dir`'s world copies (mod/run/saves/*) without following a symlink: the run dir, mod, mod/run and saves must be real
 * directories (lstat), saves' real path must be inside the run dir's, and each world is removed only when it is a real directory
 * whose real path is inside saves. A symlinked world entry is left alone (neither it nor its target is touched); fs.rmSync
 * removes a link inside a world as a link. -> the names removed, or null when the saves dir was refused.
 */
export function emptyWorlds(dir, log = () => {}) {
  const root = real(dir);
  let p = root;
  for (const part of ['', 'mod', 'run', 'saves']) {
    p = part ? path.join(p, part) : p;
    const st = lstat(p);
    if (!st) return [];
    if (st.isSymbolicLink() || !st.isDirectory()) {
      log(`cleanup: ${p} is ${st.isSymbolicLink() ? 'a symlink' : 'not a directory'}: its worlds are not touched`);
      return null;
    }
  }
  const saves = real(p);
  if (!within(saves, root) || saves === root) {
    log(`cleanup: ${saves} is outside ${root}: its worlds are not touched`);
    return null;
  }
  const removed = [];
  for (const name of fs.readdirSync(saves)) {
    const w = path.join(saves, name);
    const st = lstat(w);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      log(`cleanup: ${w} is a symlink: kept`);
      continue;
    }
    if (!within(real(w), saves) || real(w) === saves) continue;
    fs.rmSync(w, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * After a PASS. `dirs`: [{ dir, created }], every run dir and the frozen source, `created` when this invocation added the worktree.
 * - created by this run: `git worktree remove` (never --force); a worktree git refuses to remove keeps its files and loses its
 *   world copies (they are this run's).
 * - not created by this run, a default run dir (beside the main checkout by real path: cfg.runDir, its -s<k>/-o<j> shards, the
 *   nightly's): reused across runs, so it stays and only its world copies go. The same for one this run created there.
 * - not created by this run, anything else (another slice's worktree passed as --run-dir, an earlier run's dir reused): this run
 *   does not own it, so nothing is touched.
 * The main checkout, this checkout and the seed (by real path) are never touched. No path is followed through a symlink
 * (emptyWorlds). A FAIL, an INCONCLUSIVE or `keep` keeps everything. -> [{ dir, action }]
 */
export function cleanupRunDirs({ verdict, keep = false, src, main, seed = null, cfgRunDir, dirs, log = () => {} }) {
  if (keep) {
    log('cleanup: --keep-run-dirs, run dirs kept');
    return [];
  }
  if (verdict !== 'PASS') {
    log(`cleanup: ${verdict}, run dirs kept for inspection; remove them (git worktree remove) once done`);
    return [];
  }
  // real paths: _work/architect-mc is a symlink to the main checkout, so a plain dirname would make every _work dir its sibling
  const mainParent = path.dirname(real(main));
  const defaults = [path.resolve(src, cfgRunDir), path.resolve(main, cfgRunDir)].map(real);
  const protectedDirs = new Set([main, src, seed].filter(Boolean).map(real));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // a run dir beside the main checkout (Minecraft/: the default, the nightly's, the seed's) is reused: only its worlds go
  const isDefault = (d) => path.dirname(d) === mainParent || defaults.some((b) => d === b || new RegExp(`^${esc(b)}-(s|o)\\d+$`).test(d));
  const rm = (d) => {
    const r = spawnSync('git', ['-C', src, 'worktree', 'remove', d], { encoding: 'utf8' });
    if (r.status === 0) return true;
    log(`cleanup: git worktree remove ${d} failed (${(r.stderr ?? '').trim().split('\n')[0]}): kept`);
    return false;
  };
  const out = [];
  const empty = (d, why) => {
    const removed = emptyWorlds(d, log);
    log(`cleanup: ${d} kept (${why}), ${removed === null ? 'its saves refused' : `${removed.length} world cop${removed.length === 1 ? 'y' : 'ies'} removed`}`);
    out.push({ dir: d, action: removed === null ? 'kept' : 'emptied' });
  };
  for (const { dir: d, created } of dirs) {
    if (!lstat(d)) continue;
    const r = real(d);
    if (protectedDirs.has(r)) {
      log(`cleanup: ${d} is the main checkout, this checkout or the seed: not touched`);
      out.push({ dir: d, action: 'kept' });
    } else if (isDefault(r)) empty(d, 'a reused default run dir');
    else if (!created) {
      log(`cleanup: ${d} kept whole: not created by this run (an existing worktree is never removed or emptied)`);
      out.push({ dir: d, action: 'kept' });
    } else if (lstat(d).isSymbolicLink()) {
      log(`cleanup: ${d} is a symlink: not touched`);
      out.push({ dir: d, action: 'kept' });
    } else if (rm(d)) {
      log(`cleanup: removed ${d}`);
      out.push({ dir: d, action: 'removed' });
    } else empty(d, 'git refused to remove it');
  }
  return out;
}
