// The run-level build artifact (docs/GATES.md "Coverage-based inputs"): the mod, devserver and apitest classes (main, client and
// test) compiled once per commit's build inputs, in a dedicated worktree, with a manifest of every class file's digest:
//   <main checkout>/artifacts/build-cache/<inputs hash>.json  { hash, head, ok, classes: { fqn: sha1 }, at, ms, log }
// A coverage-mode step's key holds the bytecode digest of every class its JVMs loaded, from this manifest, instead of the Java
// sources and instead of the whole build: a change to a class it never loaded leaves its key alone, while a constant inlined
// into a class it did load changes that class's bytecode and so its key. The guard: no manifest, or a build that failed, and no
// coverage-mode step is looked up (they all run).

import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { matcher, treeAt } from './step-inputs.mjs';

const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const DEFAULT = {
  inputs: ['mod/**', '!mod/run/**', 'devserver/**', 'apitest/**', 'kit/voxel_classes.json', 'kit/schemas/**', 'tools/gen-palettes.mjs'],
  classDirs: ['mod/build/classes/java/main', 'mod/build/classes/java/client', 'mod/build/classes/java/test', 'devserver/build/classes/java/main', 'apitest/build/classes/java/main', 'apitest/build/classes/java/client'],
  tasks: ['classes', 'testClasses', ':devserver:classes', ':apitest:classes'],
  worktree: '../architect-mc-buildcache',
  timeoutMin: 30,
};

/** The build inputs' hash at a commit (git blob ids) and the compiler. */
export function buildHash(src, commit, conf, java) {
  const b = { ...DEFAULT, ...(conf.build ?? {}) };
  const m = matcher(b.inputs);
  const tree = treeAt(src, commit);
  const h = crypto.createHash('sha1');
  for (const p of [...tree.keys()].sort()) if (m(p)) h.update(`${p}\0${tree.get(p)}\n`);
  h.update(`java ${java}\n`);
  return h.digest('hex').slice(0, 24);
}

/** Every class file under the class dirs of `root` -> { fqn: sha1 of its bytes }. */
export function classManifest(root, classDirs) {
  const out = {};
  for (const d of classDirs) {
    const base = path.join(root, d);
    const walk = (rel) => {
      let ents = [];
      try {
        ents = fs.readdirSync(path.join(base, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r);
        else if (e.name.endsWith('.class')) out[r.slice(0, -6).replaceAll('/', '.')] = sha(fs.readFileSync(path.join(base, r)));
      }
    };
    walk('');
  }
  return out;
}

const loaded = new Map();
/**
 * The manifest for a commit: from the cache, else built now in the dedicated worktree (detached at the commit, the main checkout's
 * gradle home cloned in, offline). -> the manifest object ({ ok: false, error } when the build failed or couldn't run).
 * `build: false` only reads the cache.
 */
export function ensureBuild({ src, main, commit, conf, java, build = true, log = () => {} }) {
  const b = { ...DEFAULT, ...(conf.build ?? {}) };
  const head = git(src, 'rev-parse', commit);
  const hash = buildHash(src, head, conf, java);
  if (loaded.has(hash)) return loaded.get(hash);
  const dir = path.join(main, 'artifacts', 'build-cache');
  const file = path.join(dir, `${hash}.json`);
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    loaded.set(hash, m);
    return m;
  } catch {
    // not built yet
  }
  if (!build) return { ok: false, hash, error: 'not built yet (no manifest in artifacts/build-cache)' };
  fs.mkdirSync(dir, { recursive: true });
  const wt = path.resolve(main, b.worktree);
  const lock = path.join(dir, '.lock');
  const t0 = Date.now();
  // one build at a time on the machine (a dead holder's lock is taken over)
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
      break;
    } catch {
      let pid = 0;
      try {
        pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
        process.kill(pid, 0);
      } catch {
        // a dead holder: one waiter wins the atomic rename, then takes the lock; the others wait again
        try {
          fs.renameSync(lock, `${lock}.stale.${process.pid}`);
          fs.rmSync(`${lock}.stale.${process.pid}`, { recursive: true, force: true });
        } catch {
          // another waiter took it over
        }
        continue;
      }
      if (i > 3600) return { ok: false, hash, error: `the build lock is held by pid ${pid}` };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      try {
        const m = JSON.parse(fs.readFileSync(file, 'utf8'));
        loaded.set(hash, m);
        return m;
      } catch {
        // still building
      }
    }
  }
  let m;
  try {
    if (!fs.existsSync(wt)) git(src, 'worktree', 'add', '--detach', wt, head);
    else {
      if (git(wt, 'status', '--porcelain', '--untracked-files=all')) throw new Error(`${wt} has local changes or untracked files`);
      git(wt, 'checkout', '-q', '--detach', head);
    }
    if (!fs.existsSync(path.join(wt, '.gradle-home', 'caches')) && fs.existsSync(path.join(main, '.gradle-home'))) {
      execFileSync('cp', ['-c', '-R', path.join(main, '.gradle-home'), path.join(wt, '.gradle-home')]);
    }
    log(`build artifact ${hash}: compiling ${head.slice(0, 9)} in ${wt}`);
    const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(wt, '.gradle-home') };
    // nothing that changes what is compiled from outside the commit (a forced lab-ui checkout) and nothing of the gate's tracing
    for (const k of Object.keys(env)) if (/^(JAVA_TOOL_OPTIONS|NODE_OPTIONS|GATE_TRACE_|LAB_UI_DIR|ORG_GRADLE_PROJECT_)/.test(k) || /^(ANTHROPIC_|CLAUDE)/.test(k)) delete env[k];
    const r = spawnSync('./gradlew', ['--offline', '--no-daemon', '-q', ...b.tasks], { cwd: path.join(wt, 'mod'), env, encoding: 'utf8', timeout: b.timeoutMin * 60_000, maxBuffer: 64 << 20 });
    const logFile = path.join(dir, `${hash}.log`);
    fs.writeFileSync(logFile, `${r.stdout ?? ''}${r.stderr ?? ''}`);
    // a compile that fails is a fact of the commit (kept); a timeout or a signal is not (not kept: the next run tries again)
    if (r.status !== 0) m = { ok: false, hash, head, error: `gradle exited ${r.status ?? r.signal}`, log: logFile, at: new Date().toISOString(), ms: Date.now() - t0, transient: r.status === null || !!r.error };
    else {
      if (git(wt, 'rev-parse', 'HEAD') !== head) throw new Error('the build worktree moved');
      m = { ok: true, hash, head, classes: classManifest(wt, b.classDirs), log: logFile, at: new Date().toISOString(), ms: Date.now() - t0 };
    }
  } catch (e) {
    m = { ok: false, hash, head, error: e.message, at: new Date().toISOString(), ms: Date.now() - t0, transient: true };
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
  loaded.set(hash, m);
  if (m.transient) return m; // not cached: a worktree, lock or timeout problem is retried by the next run
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m));
  fs.renameSync(tmp, file);
  return m;
}

/** The bytecode digest of a step's loaded classes (sorted fqn and class-file sha; a class not in the manifest counts as "-"). */
export function bytecodeDigest(classes, manifest) {
  const h = crypto.createHash('sha1');
  for (const c of [...classes].sort()) h.update(`${c}\0${manifest.classes?.[c] ?? '-'}\n`);
  return h.digest('hex');
}
