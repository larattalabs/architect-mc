// The frozen source (docs/GATES.md "Frozen source and the CPU budget"). The drivers (tools/*.mjs) and every step without a run: cwd ran from the
// source checkout's working tree, which its agent keeps committing to: a kit commit mid-run (K2's and CW's slices, 2026-10-23)
// made every driver's kit-suite reuse refuse (tools/lib/kit-reuse.mjs: the tree is not the one unit-kit ran), so eight unit steps
// re-ran the 824-test suite at once and timed out. The runner now runs them from a detached worktree at the run's HEAD.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const real = (p) => fs.realpathSync(p);

/**
 * A detached worktree `dir` of `src` at `head`: added once, then checked out at each run's head. A worktree with modified tracked
 * files is refused (as a run dir is). The untracked deps the drivers need (`seed`: gradle's home, the sidecar's node_modules) are
 * APFS-cloned (cp -c) from `src`, else from `main`, once. -> { dir, created, seeded: [rel] }.
 */
export function prepareFrozenSource({ src, main, dir, head, seed = ['.gradle-home', 'sidecar/node_modules'], log = () => {} }) {
  let created = false;
  if (!fs.existsSync(dir)) {
    log(`setup: git worktree add --detach ${dir} ${head.slice(0, 7)} (the frozen source)`);
    git(src, 'worktree', 'add', '--detach', dir, head);
    created = true;
  } else {
    if (real(path.resolve(dir, git(dir, 'rev-parse', '--git-common-dir'))) !== real(path.resolve(src, git(src, 'rev-parse', '--git-common-dir')))) {
      throw new Error(`${dir} is not a worktree of this repository`);
    }
    if (git(dir, 'status', '--porcelain', '--untracked-files=no')) throw new Error(`${dir} (the frozen source) has modified tracked files; refusing to check out over them`);
    git(dir, 'checkout', '-q', '--detach', head);
  }
  const seeded = [];
  for (const rel of seed) {
    const dst = path.join(dir, rel);
    if (fs.existsSync(dst)) continue;
    const from = [src, main].filter(Boolean).map((r) => path.join(r, rel)).find((p) => fs.existsSync(p));
    if (!from) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    log(`setup: cloning ${from} into the frozen source (APFS clone)`);
    // an APFS clone on macOS (cheap); a plain copy elsewhere (GNU cp's -c is not a clone)
    if (process.platform === 'darwin') execFileSync('cp', ['-c', '-R', from, dst]);
    else fs.cpSync(from, dst, { recursive: true });
    seeded.push(rel);
  }
  return { dir, created, seeded };
}

/**
 * A kit-suite reader (waitFor unit-kit) that will re-run the kit suite itself (kit-reuse refuses: unit-kit did not pass, or the
 * drivers' kit/ is dirty) does several times its reuse-path work, which its history timeout (2 x a p90 of reuse runs) does not
 * cover. unitKit: unit-kit's status in this run, or null when unit-kit is not in it (then there is no report: the runner already
 * gives such a step its configured timeout). -> the reason, or null.
 */
export function kitReaderSlowPath({ step, hasReport, unitKit, drvDir }) {
  if (!(step.waitFor ?? []).includes('unit-kit') || !hasReport) return null;
  if (unitKit && unitKit !== 'PASS' && unitKit !== 'CACHED') return `unit-kit ${unitKit}: the kit suite runs again in this step`;
  try {
    if (drvDir && git(drvDir, 'status', '--porcelain', '--', 'kit')) return `${drvDir}'s kit/ is dirty: the kit suite runs again in this step`;
  } catch {
    // no git there: kit-reuse decides
  }
  return null;
}
