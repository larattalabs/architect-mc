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
