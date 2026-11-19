// Pinned dev.larattalabs dependencies in a slot's gradle home (tools/lib/pinned-deps.mjs): a lab_ui_version bump must be resolved
// online once per slot before an offline build, not abort the nightly in setup (2026-10-28..11-10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePinnedDeps, missingPins, readPins } from '../../tools/lib/pinned-deps.mjs';

function fixture(version = '0.4.0', cached = []) {
  const root = archTmpDir('pinned-deps');
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
import { archTmpDir } from '../../tools/lib/arch-tmp.mjs';

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

// (GR-c) the online resolve downloads the pin: `gradlew help` resolved no configuration, so a fresh run home never got lab_ui
import { defaultResolve, resolveProject, PIN_REPO, PIN_RESOLVE_TASK } from '../../tools/lib/pinned-deps.mjs';

test('GR-c: the resolve project declares exactly the missing pins, the mod\'s repository block, and no credential value', () => {
  const files = resolveProject([{ group: 'dev.larattalabs', module: 'lab_ui', version: '0.5.0' }]);
  const b = files['build.gradle'];
  assert.match(b, /pins 'dev\.larattalabs:lab_ui:0\.5\.0'/);
  assert.match(b, /transitive = false/);
  assert.ok(b.includes(`name = "${PIN_REPO.name}"`) && b.includes(PIN_REPO.url) && b.includes('includeGroup "dev.larattalabs"'));
  assert.match(b, /environmentVariable\("GITHUB_TOKEN"\)/, 'the token is read at run time');
  assert.ok(b.includes(`tasks.register('${PIN_RESOLVE_TASK}')`));
  assert.match(files['settings.gradle'], /rootProject\.name/);
  // the mod's own block: same name, url and content filter (Gradle keys cached metadata by repository)
  const mod = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'mod', 'build.gradle'), 'utf8');
  assert.ok(mod.includes(`name = "${PIN_REPO.name}"`) && mod.includes(`url = uri("${PIN_REPO.url}")`) && mod.includes(`includeGroup "${PIN_REPO.group}"`),
    'PIN_REPO matches mod/build.gradle');
});

test('GR-c: defaultResolve runs the pins task in a temp project with the home and the token in the env only; the token is masked', () => {
  const { modDir, home } = fixture('0.5.0', ['0.4.0']);
  const seen = {};
  const spawn = (cmd, args, opts) => {
    const dir = args[args.indexOf('-p') + 1];
    seen.cmd = cmd;
    seen.args = args;
    seen.env = opts.env;
    seen.dir = dir;
    seen.files = fs.readdirSync(dir).sort();
    seen.build = fs.readFileSync(path.join(dir, 'build.gradle'), 'utf8');
    return { status: 0, stdout: 'resolved lab_ui-0.5.0.jar\nauth sekret-token-123\n', stderr: '' };
  };
  const r = defaultResolve({ home, modDir, env: { GITHUB_TOKEN: 'sekret-token-123', GITHUB_ACTOR: 'a' }, missing: missingPins(home, modDir), spawn });
  assert.equal(r.ok, true);
  assert.equal(seen.cmd, path.join(modDir, 'gradlew'));
  assert.ok(seen.args.includes(PIN_RESOLVE_TASK) && seen.args.includes('--no-daemon') && !seen.args.includes('help') && !seen.args.includes('--offline'));
  assert.ok(!seen.dir.startsWith(modDir), 'the project is outside the repo');
  assert.deepEqual(seen.files.filter((f) => f.endsWith('.gradle')), ['build.gradle', 'settings.gradle']);
  assert.match(seen.build, /lab_ui:0\.5\.0/);
  assert.ok(!seen.build.includes('sekret-token-123'), 'the token is never written');
  assert.equal(seen.env.GRADLE_USER_HOME, home);
  assert.equal(seen.env.GITHUB_TOKEN, 'sekret-token-123');
  assert.ok(!r.out.includes('sekret-token-123') && r.out.includes('***'), 'the token is masked in the output');
  assert.equal(fs.existsSync(seen.dir), false, 'the temp project is removed');
  const bad = defaultResolve({ home, modDir, env: { GITHUB_TOKEN: 't' }, missing: missingPins(home, modDir), spawn: () => ({ status: 1, stdout: '', stderr: '401' }) });
  assert.equal(bad.ok, false);
});

import { ensureSlotPins } from '../../tools/lib/pinned-deps.mjs';

test('PDS: ensureSlotPins resolves a bumped pin once per slot home (fresh and stale slots), each with its own env', () => {
  const a = fixture('0.6.1', ['0.6.0']); // a stale slot: the seed's home with the old lab_ui only
  const b = fixture('0.6.1'); // a fresh slot: no cache at all
  const c = fixture('0.6.1', ['0.6.1']); // already has it
  const calls = [];
  const logs = [];
  const r = ensureSlotPins([{ name: 's1', run: a.root, env: { E: '1' } }, { name: 's2', run: b.root, env: { E: '2' } }, { name: 's3', run: c.root, env: { E: '3' } }], {
    log: (m) => logs.push(m),
    resolve: ({ home, modDir, env, missing }) => { calls.push({ home, modDir, env: env.E, missing: missing.map((p) => p.version) }); put(home, '0.6.1'); return { ok: true }; },
    seedRun: () => ({ ok: true }),
  });
  assert.deepEqual(calls, [
    { home: a.home, modDir: a.modDir, env: '1', missing: ['0.6.1'] },
    { home: b.home, modDir: b.modDir, env: '2', missing: ['0.6.1'] },
  ]);
  assert.deepEqual(r.map((x) => [x.slot, x.home, x.resolved]), [['s1', a.home, ['lab_ui 0.6.1']], ['s2', b.home, ['lab_ui 0.6.1']], ['s3', c.home, []]]);
  assert.ok(logs.some((m) => /s1: lab_ui 0\.6\.1 not in .*one online resolve/.test(m)) && logs.some((m) => /s2: resolved lab_ui 0\.6\.1/.test(m)));
  // a failed resolve throws naming the slot (gate-run aborts in setup)
  const d = fixture('0.6.1', ['0.6.0']);
  assert.throws(() => ensureSlotPins([{ name: 'sX', run: d.root, env: {} }], { resolve: () => ({ ok: false, out: '401' }) }), /slot sX: lab_ui 0\.6\.1/);
});

test('PDS: gate-run setupShard calls ensureSlotPins for its run dir before the sidecar build and any step', () => {
  const src = fs.readFileSync(new URL('../../tools/gate-run.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function setupShard('), src.indexOf('// ------------------------------------------------------------------ the end'));
  const call = body.indexOf('ensureSlotPins([{ name: sh.name, run: RUN, env: childEnv(sh) }]');
  assert.ok(call > 0, 'setupShard calls ensureSlotPins with the shard run dir');
  assert.ok(call > body.indexOf("for (const item of cfg.seed ?? [])") && call < body.indexOf("spawn('npm', ['run', 'build']"), 'after the seed clones, before the build');
});
