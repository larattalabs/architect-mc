// Pinned dev.larattalabs dependencies in a slot's own gradle home (docs/GATES.md "The nightly": setup aborts).
// The gate drivers build `--offline --no-daemon` with each slot's own `.gradle-home`, which is cloned from main only when the slot has
// none. A bump of `lab_ui_version` (mod/gradle.properties) left every existing slot with the old lab_ui only, and every nightly from
// 2026-10-28 to 2026-11-10 aborted in setup ("Could not resolve dev.larattalabs:lab_ui:0.4.0 ... No cached version available for
// offline mode"). ensurePinnedDeps() runs before an offline build: when a pinned module is not in the home's cache it runs ONE online
// resolve with that home (GITHUB_ACTOR/GITHUB_TOKEN from the env, else `gh auth token`; the token is only ever passed in the child's
// environment, never written or logged), and throws a clear error naming the slot, the version and the fix when that fails.

import fs from 'node:fs';
import path from 'node:path';
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

function defaultResolve({ home, modDir, env }) {
  const e = { ...env, JAVA_HOME: env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: home };
  for (const k of Object.keys(e)) if (/^(JAVA_TOOL_OPTIONS|NODE_OPTIONS|GATE_TRACE_|LAB_UI_DIR|ORG_GRADLE_PROJECT_)/.test(k) || /^(ANTHROPIC_|CLAUDE)/.test(k)) delete e[k];
  if (!e.GITHUB_TOKEN) {
    try {
      e.GITHUB_TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      e.GITHUB_ACTOR = e.GITHUB_ACTOR || 'nlaratta';
    } catch {
      // no gh token: gradle fails below and the error says how to fix it
    }
  }
  const r = spawnSync('./gradlew', ['--no-daemon', '-q', 'help'], { cwd: modDir, env: e, encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 16 << 20 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.split(e.GITHUB_TOKEN || '\u0000').join('***');
  return { ok: r.status === 0, out: out.split('\n').slice(-12).join('\n') };
}

/**
 * Before an offline gradle build in `modDir` with `home`: makes sure every pinned module is in the home's cache, resolving online once
 * (`resolve`, stubbable) when not. `slot` names the slot in messages. -> { checked, resolved: ['lab_ui 0.4.0'] }; throws when it can't.
 */
export function ensurePinnedDeps({ home, modDir, slot = home, env = process.env, log = () => {}, resolve = defaultResolve }) {
  const missing = missingPins(home, modDir);
  const checked = readPins(modDir).length;
  if (!missing.length || env.LAB_UI_DIR) return { checked, resolved: [] };
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
  return { checked, resolved: names };
}
