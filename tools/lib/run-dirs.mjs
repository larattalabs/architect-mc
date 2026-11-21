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

/**
 * The free-space guard: below `min` GiB free on the run dirs' volume a run refuses to start. `min` <= 0 turns it off.
 * -> { ok, min, volumes: [{ probe, free }], low: [{ probe, free }] }
 */
export function checkSpace({ min, run1, runDirs = [], frozen = false, drvDir = null, statfs = fs.statfsSync }) {
  void runDirs, frozen, drvDir;
  if (!(min > 0)) return { ok: true, min, volumes: [], low: [] };
  let probe = path.dirname(run1);
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const st = statfs(probe);
  const free = (st.bavail * st.bsize) / 2 ** 30;
  const volumes = [{ probe, free }];
  const low = volumes.filter((v) => v.free < min);
  return { ok: !low.length, min, volumes, low };
}

/**
 * After a PASS: removes this run's own run worktrees and frozen source, and empties the world copies of the reused default run dirs
 * (cfg.runDir and its -s<k>/-o<j> shards, the nightly's). A run that does not pass keeps everything. `keep` keeps all.
 * `dirs`: [{ dir, created }] (created: this invocation added the worktree).
 */
export function cleanupRunDirs({ verdict, keep = false, src, main, seed = null, cfgRunDir, dirs, log = () => {} }) {
  void seed;
  if (keep) return log('cleanup: --keep-run-dirs, run dirs kept');
  if (verdict !== 'PASS') return log(`cleanup: ${verdict}, run dirs kept for inspection; remove them (git worktree remove) once done`);
  // real paths: _work/architect-mc is a symlink to the main checkout, so a plain dirname would make every _work dir its sibling
  const mainParent = path.dirname(real(main));
  const defaults = [path.resolve(src, cfgRunDir), path.resolve(main, cfgRunDir)].map((d) => (fs.existsSync(d) ? real(d) : d));
  // a run dir beside the main checkout (Minecraft/: the default, the nightly's, the seed's) is reused: only its worlds go
  const isDefault = (d0) => { const d = real(d0); return path.dirname(d) === mainParent || defaults.some((b) => d === b || new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(s|o)\\d+$`).test(d)); };
  const rm = (d) => {
    const r = spawnSync('git', ['-C', src, 'worktree', 'remove', d], { encoding: 'utf8' });
    if (r.status === 0) return true;
    log(`cleanup: git worktree remove ${d} failed (${(r.stderr ?? '').trim().split('\n')[0]}): kept`);
    return false;
  };
  for (const { dir: d } of dirs) {
    if (!fs.existsSync(d)) continue;
    if (isDefault(d) || !rm(d)) {
      const saves = path.join(d, 'mod', 'run', 'saves');
      if (fs.existsSync(saves)) for (const w of fs.readdirSync(saves)) fs.rmSync(path.join(saves, w), { recursive: true, force: true });
      log(`cleanup: ${d} kept, its world copies removed`);
    } else log(`cleanup: removed ${d}`);
  }
}
