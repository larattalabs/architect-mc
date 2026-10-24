// The frozen source (docs/GATES.md "Frozen source and the CPU budget"). The drivers (tools/*.mjs) and every step without a run: cwd ran from the
// source checkout's working tree, which its agent keeps committing to: a kit commit mid-run (K2's and CW's slices, 2026-10-23)
// made every driver's kit-suite reuse refuse (tools/lib/kit-reuse.mjs: the tree is not the one unit-kit ran), so eight unit steps
// re-ran the 824-test suite at once and timed out. The runner now runs them from a detached worktree at the run's HEAD.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

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
 * The frozen source carries BUILT mod classes. The snapshot is a fresh worktree: `mod/build` holds nothing, so a driver's own
 * `./gradlew test --tests <filter>` ran 0 tests and tools/api-compat.mjs found no classes (2026-10-24, 12 of 18 steps). Compile
 * them once, here, before any step starts: `classes testClasses :devserver:classes :apitest:classes` offline in the snapshot, with
 * its own gradle home. Gradle's up-to-date checks key on the inputs, so the next run (another head, same dir) recompiles only what
 * changed and never reuses a stale output. A failed build THROWS (the run aborts in setup, before any step). -> { ms, log }.
 */
export function buildFrozenClasses({ dir, tasks = ['classes', 'testClasses', ':devserver:classes', ':apitest:classes'], timeoutMin = 30, log = () => {}, env = process.env } = {}) {
  const mod = path.join(dir, 'mod');
  if (!fs.existsSync(path.join(mod, 'gradlew'))) throw new Error(`frozen source build: ${mod}/gradlew does not exist`);
  const e = { ...env, JAVA_HOME: env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(dir, '.gradle-home') };
  // nothing that changes what is compiled from outside the commit, as the build artifact's build (tools/lib/build-artifact.mjs)
  for (const k of Object.keys(e)) if (/^(JAVA_TOOL_OPTIONS|NODE_OPTIONS|GATE_TRACE_|LAB_UI_DIR|ORG_GRADLE_PROJECT_)/.test(k) || /^(ANTHROPIC_|CLAUDE)/.test(k)) delete e[k];
  log(`setup: building the frozen source's mod classes (./gradlew --offline ${tasks.join(' ')}) in ${mod}`);
  const t0 = Date.now();
  const r = spawnSync('./gradlew', ['--offline', '--no-daemon', '-q', ...tasks], { cwd: mod, env: e, encoding: 'utf8', timeout: timeoutMin * 60_000, maxBuffer: 64 << 20 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const logFile = path.join(dir, 'frozen-build.log');
  try {
    fs.writeFileSync(logFile, out);
  } catch {
    // an unwritable log must not hide the build result
  }
  if (r.status !== 0) {
    throw new Error(`the frozen source's mod build failed (${r.error?.message ?? `exit ${r.status ?? r.signal}`}); no step ran. Last output:\n${out.split('\n').slice(-25).join('\n')}`);
  }
  const ms = Date.now() - t0;
  log(`setup: frozen source built in ${(ms / 1000).toFixed(0)}s`);
  return { ms, log: logFile };
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
