// Pinned dev.larattalabs dependencies in a slot's own gradle home (docs/GATES.md "The nightly": setup aborts).
// The gate drivers build `--offline --no-daemon` with each slot's own `.gradle-home`, which is cloned from main only when the slot has
// none. A bump of `lab_ui_version` (mod/gradle.properties) left every existing slot with the old lab_ui only, and every nightly from
// 2026-10-28 to 2026-11-10 aborted in setup ("Could not resolve dev.larattalabs:lab_ui:0.4.0 ... No cached version available for
// offline mode"). ensurePinnedDeps() runs before an offline build: when a pinned module is not in the home's cache it runs ONE online
// resolve with that home (GITHUB_ACTOR/GITHUB_TOKEN from the env, else `gh auth token`; the token is only ever passed in the child's
// environment, never written or logged), and throws a clear error naming the slot, the version and the fix when that fails.

//
// (GI A46) The pins cover dev.larattalabs only; any other bump (Minecraft, Loom, the loader, Fabric API, Java-WebSocket, JUnit, ...) left
// the same hole. seedClasspath() closes it: once per build-file fingerprint per home (a marker in <home>/architect-seed/) an offline
// `architectResolveAll` (an init script: every resolvable compile/runtime classpath and annotation processor of every project) must
// pass; when it fails offline, ONE online run of the same task fills the cache, then the offline run must pass. ensurePinnedDeps() calls
// it after the pins, so every caller (frozen-source, build-artifact, server-host, nomod-server) gets it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

/** The pins: a gradle.properties key -> the module its version names. Add a row for another dev.larattalabs dependency. */
export const PINS = [{ prop: 'lab_ui_version', group: 'dev.larattalabs', module: 'lab_ui' }];

/** [{ prop, group, module, version }] pinned in `<modDir>/gradle.properties` (a pin the file lacks is skipped). */
export function readPins(modDir) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(modDir, 'gradle.properties'), 'utf8');
  } catch {
    return [];
  }
  const props = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z0-9_.]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) props[m[1]] = m[2];
  }
  return PINS.filter((p) => props[p.prop]).map((p) => ({ ...p, version: props[p.prop] }));
}

/** The pins whose module is not in `home`'s resolved-modules cache. */
export function missingPins(home, modDir) {
  return readPins(modDir).filter((p) => !fs.existsSync(path.join(home, 'caches', 'modules-2', 'files-2.1', p.group, p.module, p.version)));
}

function gradleEnv(home, env, { token = true } = {}) {
  const e = { ...env, JAVA_HOME: env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: home };
  for (const k of Object.keys(e)) if (/^(JAVA_TOOL_OPTIONS|NODE_OPTIONS|GATE_TRACE_|LAB_UI_DIR|ORG_GRADLE_PROJECT_)/.test(k) || /^(ANTHROPIC_|CLAUDE)/.test(k)) delete e[k];
  if (token && !e.GITHUB_TOKEN) {
    try {
      e.GITHUB_TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      e.GITHUB_ACTOR = e.GITHUB_ACTOR || 'nlaratta';
    } catch {
      // no gh token: gradle fails below and the error says how to fix it
    }
  }
  return e;
}

function defaultResolve({ home, modDir, env }) {
  const e = gradleEnv(home, env);
  const r = spawnSync('./gradlew', ['--no-daemon', '-q', 'help'], { cwd: modDir, env: e, encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 16 << 20 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.split(e.GITHUB_TOKEN || '\u0000').join('***');
  return { ok: r.status === 0, out: out.split('\n').slice(-12).join('\n') };
}

/**
 * Before an offline gradle build in `modDir` with `home`: makes sure every pinned module is in the home's cache, resolving online once
 * (`resolve`, stubbable) when not. `slot` names the slot in messages. -> { checked, resolved: ['lab_ui 0.4.0'] }; throws when it can't.
 */
export function ensurePinnedDeps({ home, modDir, slot = home, env = process.env, log = () => {}, resolve = defaultResolve, seedRun = defaultSeedRun }) {
  const missing = missingPins(home, modDir);
  const checked = readPins(modDir).length;
  if (env.LAB_UI_DIR) return { checked, resolved: [] };
  if (!missing.length) return { checked, resolved: [], seed: seedClasspath({ home, modDir, slot, env, log, run: seedRun }) };
  const names = missing.map((p) => `${p.module} ${p.version}`);
  log(`setup: ${slot}: ${names.join(', ')} not in ${home}'s cache: one online resolve`);
  let r;
  try {
    r = resolve({ home, modDir, env, missing });
  } catch (e) {
    r = { ok: false, out: e.message };
  }
  const still = r.ok ? missingPins(home, modDir) : missing;
  if (!r.ok || still.length) {
    throw new Error(`slot ${slot}: ${names.join(', ')} (dev.larattalabs, pinned in mod/gradle.properties) is not in its gradle home ${home} and the online resolve failed. `
      + `Fix: run \`cd ${modDir} && GRADLE_USER_HOME=${home} GITHUB_ACTOR=nlaratta GITHUB_TOKEN=$(gh auth token) ./gradlew --no-daemon -q help\` once (needs a token with read:packages). Last output:\n${r.out ?? ''}`);
  }
  log(`setup: ${slot}: resolved ${names.join(', ')}`);
  return { checked, resolved: names, seed: seedClasspath({ home, modDir, slot, env, log, run: seedRun }) };
}

// ------------------------------------------------------------------ (GI A46) the full-classpath seed

/** The build files whose content decides what resolves (relative to the repo root, the mod dir's parent; a missing one hashes as absent). */
export const SEED_FILES = ['mod/gradle.properties', 'mod/settings.gradle', 'mod/build.gradle', 'apitest/build.gradle', 'devserver/build.gradle', 'mod/gradle/wrapper/gradle-wrapper.properties'];

/** The fingerprint of `modDir`'s build files (16 hex), and the marker path for it in `home`. */
export function seedKey(modDir) {
  const h = createHash('sha256');
  for (const f of SEED_FILES) {
    let t = '\u0000absent';
    try { t = fs.readFileSync(path.join(path.dirname(modDir), f), 'utf8'); } catch { /* absent */ }
    h.update(`${f}\n${t}\n`);
  }
  return h.digest('hex').slice(0, 16);
}
export const seedMarker = (home, key) => path.join(home, 'architect-seed', `${key}.ok`);

/** The init script: architectResolveAll in every project resolves each compile/runtime classpath and annotation processor, strictly. */
export const RESOLVE_ALL_GRADLE = `allprojects {
  tasks.register('architectResolveAll') {
    notCompatibleWithConfigurationCache('resolves every classpath')
    def cfgs = project.configurations
    def pname = project.path
    doLast {
      def n = 0
      cfgs.matching { it.canBeResolved && (it.name ==~ /(?i).*(compileClasspath|runtimeClasspath|annotationProcessor)$/) }.each { c ->
        n += c.incoming.artifactView { lenient(false) }.files.files.size()
      }
      println "architectResolveAll \${pname}: \${n} files"
    }
  }
}
`;

/** One gradle run of architectResolveAll; offline unless `online` (then with the GitHub token, as the pins' resolve). -> { ok, out } */
export function defaultSeedRun({ home, modDir, env, online }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-seed-'));
  const init = path.join(dir, 'resolve-all.gradle');
  fs.writeFileSync(init, RESOLVE_ALL_GRADLE);
  try {
    const e = gradleEnv(home, env, { token: online });
    const args = [...(online ? [] : ['--offline']), '--no-daemon', '-q', '--no-configuration-cache', '-I', init, 'architectResolveAll'];
    const r = spawnSync('./gradlew', args, { cwd: modDir, env: e, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 16 << 20 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.split(e.GITHUB_TOKEN || '\u0000').join('***');
    return { ok: r.status === 0, out: out.split('\n').slice(-12).join('\n') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Makes sure `home` can resolve every classpath of `modDir` offline. Marker hit -> { key, cached: true }. Else the offline run; on a
 * failure ONE online run, then the offline run again; the marker is written only after an offline pass. Throws naming the slot and
 * the fix when the cache can't be filled. A dir without gradlew (a unit fixture) is skipped.
 */
export function seedClasspath({ home, modDir, slot = home, env = process.env, log = () => {}, run = defaultSeedRun }) {
  if (!fs.existsSync(path.join(modDir, 'gradlew')) && run === defaultSeedRun) return { skipped: 'no gradlew' };
  const key = seedKey(modDir);
  const marker = seedMarker(home, key);
  if (fs.existsSync(marker)) return { key, cached: true };
  const t0 = Date.now();
  let r = run({ home, modDir, env, online: false });
  let online = false;
  if (!r.ok) {
    log(`setup: ${slot}: the offline classpath resolve failed (a dependency bump?): one online resolve into ${home}`);
    const o = run({ home, modDir, env, online: true });
    online = true;
    r = o.ok ? run({ home, modDir, env, online: false }) : o;
  }
  if (!r.ok) {
    throw new Error(`slot ${slot}: its gradle home ${home} can't resolve every classpath of ${modDir} offline, and one online resolve did not fix it. `
      + `Fix: run \`cd ${modDir} && GRADLE_USER_HOME=${home} GITHUB_ACTOR=nlaratta GITHUB_TOKEN=$(gh auth token) ./gradlew --no-daemon -q help\` once, `
      + `then a build. Last output:\n${r.out ?? ''}`);
  }
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, `${new Date().toISOString()} ${online ? 'online+offline' : 'offline'}\n`);
  log(`setup: ${slot}: every classpath resolves offline (seed ${key}${online ? ', after one online resolve' : ''}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return { key, cached: false, online };
}
