// Pinned dev.larattalabs dependencies in a slot's gradle home (tools/lib/pinned-deps.mjs): a lab_ui_version bump must be resolved
// online once per slot before an offline build, not abort the nightly in setup (2026-10-28..11-10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePinnedDeps, missingPins, readPins } from '../../tools/lib/pinned-deps.mjs';

function fixture(version = '0.4.0', cached = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-deps-'));
  const modDir = path.join(root, 'mod');
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, 'gradle.properties'), `# c\nmod_version=1.0.0\nlab_ui_version=${version}\n`);
  const home = path.join(root, '.gradle-home');
  for (const v of cached) fs.mkdirSync(path.join(home, 'caches', 'modules-2', 'files-2.1', 'dev.larattalabs', 'lab_ui', v), { recursive: true });
  return { root, modDir, home };
}
const put = (home, v) => fs.mkdirSync(path.join(home, 'caches', 'modules-2', 'files-2.1', 'dev.larattalabs', 'lab_ui', v), { recursive: true });

test('readPins reads lab_ui_version; a file without it has no pins', () => {
  const { modDir } = fixture('0.4.0');
  assert.deepEqual(readPins(modDir).map((p) => `${p.module}@${p.version}`), ['lab_ui@0.4.0']);
  fs.writeFileSync(path.join(modDir, 'gradle.properties'), 'mod_version=1\n');
  assert.deepEqual(readPins(modDir), []);
});

test('a home that has the pinned version resolves nothing', () => {
  const { modDir, home } = fixture('0.4.0', ['0.4.0']);
  let calls = 0;
  const r = ensurePinnedDeps({ home, modDir, env: {}, resolve: () => { calls++; return { ok: true }; } });
  assert.equal(calls, 0);
  assert.deepEqual(r.resolved, []);
});

test('a home with only the old version gets ONE online resolve, then passes', () => {
  const { modDir, home } = fixture('0.4.0', ['0.1.0']);
  assert.equal(missingPins(home, modDir).length, 1);
  const logs = [];
  let calls = 0;
  const r = ensurePinnedDeps({ home, modDir, slot: 'slot-x', env: {}, log: (m) => logs.push(m), resolve: () => { calls++; put(home, '0.4.0'); return { ok: true }; } });
  assert.equal(calls, 1);
  assert.deepEqual(r.resolved, ['lab_ui 0.4.0']);
  assert.ok(logs.some((l) => l.includes('slot-x')));
  assert.equal(missingPins(home, modDir).length, 0);
});

test('a failed resolve throws naming the slot, the version and the fix', () => {
  const { modDir, home } = fixture('0.4.0', ['0.1.0']);
  assert.throws(() => ensurePinnedDeps({ home, modDir, slot: 'slot-y', env: {}, resolve: () => ({ ok: false, out: 'no token' }) }),
    (e) => /slot slot-y/.test(e.message) && /lab_ui 0\.4\.0/.test(e.message) && /gh auth token/.test(e.message) && /no token/.test(e.message));
});

test('a resolve that reports ok but leaves the module missing still throws; a throwing resolve too', () => {
  const { modDir, home } = fixture('0.4.0');
  assert.throws(() => ensurePinnedDeps({ home, modDir, env: {}, resolve: () => ({ ok: true }) }), /lab_ui 0\.4\.0/);
  assert.throws(() => ensurePinnedDeps({ home, modDir, env: {}, resolve: () => { throw new Error('boom'); } }), /boom/);
});

test('LAB_UI_DIR (a sibling lab-ui checkout) skips the check', () => {
  const { modDir, home } = fixture('0.4.0');
  const r = ensurePinnedDeps({ home, modDir, env: { LAB_UI_DIR: '/x' }, resolve: () => assert.fail('no resolve') });
  assert.deepEqual(r.resolved, []);
});

// (GI A46) the full-classpath seed: any dependency bump, not only dev.larattalabs
import { SEED_FILES, seedClasspath, seedKey, seedMarker } from '../../tools/lib/pinned-deps.mjs';

function seedFixture() {
  const { root, modDir, home } = fixture('0.4.0', ['0.4.0']);
  fs.writeFileSync(path.join(modDir, 'gradlew'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(modDir, 'build.gradle'), 'dependencies { implementation "a:b:1" }\n');
  return { root, modDir, home };
}

test('seed: an offline pass writes the marker once; the next call is a marker hit (no gradle)', () => {
  const { modDir, home } = seedFixture();
  const calls = [];
  const run = (o) => { calls.push(o.online); return { ok: true, out: '' }; };
  const a = seedClasspath({ home, modDir, run });
  assert.deepEqual(calls, [false]);
  assert.equal(a.cached, false);
  assert.ok(fs.existsSync(seedMarker(home, a.key)));
  assert.equal(seedClasspath({ home, modDir, run }).cached, true);
  assert.deepEqual(calls, [false]);
});

test('seed: a bump changes the key (any build file), so the next call resolves again', () => {
  const { modDir, home } = seedFixture();
  const k0 = seedKey(modDir);
  fs.writeFileSync(path.join(modDir, 'gradle.properties'), 'lab_ui_version=0.4.0\njava_websocket_version=9.9.9\n');
  assert.notEqual(seedKey(modDir), k0);
  const k1 = seedKey(modDir);
  fs.writeFileSync(path.join(modDir, 'build.gradle'), 'dependencies { implementation "a:b:2" }\n');
  assert.notEqual(seedKey(modDir), k1);
  assert.ok(SEED_FILES.includes('apitest/build.gradle') && SEED_FILES.includes('mod/gradle/wrapper/gradle-wrapper.properties'));
  let n = 0;
  seedClasspath({ home, modDir, run: () => { n++; return { ok: true }; } });
  assert.equal(n, 1);
});

test('seed: an offline failure gets ONE online run, then the offline run must pass; else it throws naming the slot and the fix', () => {
  const { modDir, home } = seedFixture();
  const calls = [];
  let filled = false;
  const run = ({ online }) => { calls.push(online); if (online) filled = true; return { ok: filled, out: filled ? '' : 'No cached version of x:y:9.9.9 available for offline mode' }; };
  const r = seedClasspath({ home, modDir, slot: 's1', run });
  assert.deepEqual(calls, [false, true, false]);
  assert.equal(r.online, true);
  const b = seedFixture();
  const calls2 = [];
  assert.throws(() => seedClasspath({ home: b.home, modDir: b.modDir, slot: 'slot-z', run: ({ online }) => { calls2.push(online); return { ok: false, out: 'Could not resolve x:y:9.9.9' }; } }),
    (e) => /slot slot-z/.test(e.message) && /gh auth token/.test(e.message) && /9\.9\.9/.test(e.message));
  assert.deepEqual(calls2, [false, true], 'one online run, no retry loop');
  assert.ok(!fs.existsSync(path.join(b.home, 'architect-seed')), 'no marker after a failure');
});

test('seed: ensurePinnedDeps runs it after the pins (both paths); LAB_UI_DIR skips both', () => {
  const { modDir, home } = seedFixture();
  let n = 0;
  const seedRun = () => { n++; return { ok: true }; };
  const r = ensurePinnedDeps({ home, modDir, env: {}, resolve: () => ({ ok: true }), seedRun });
  assert.equal(n, 1);
  assert.equal(r.seed.cached, false);
  assert.equal(ensurePinnedDeps({ home, modDir, env: {}, seedRun }).seed.cached, true);
  const c = seedFixture();
  ensurePinnedDeps({ home: c.home, modDir: c.modDir, env: { LAB_UI_DIR: '/x' }, seedRun });
  assert.equal(n, 1);
});
