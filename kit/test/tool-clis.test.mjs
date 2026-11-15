// (GI2) The tool CLIs that had no unit: argument parsing and a dry path each (nothing built, nothing written in the repo).
// tools/api-baselines-build.mjs, tools/plan-catalogue-diff.mjs, tools/step-inputs.mjs, tools/api-compat.mjs (+ tools/lib/api-classes.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { archTmpDir } from '../../tools/lib/arch-tmp.mjs';
import { hasClasses, noClassesMessage, resolveClassDirs } from '../../tools/lib/api-classes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = (script, args, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GATE_UNIT_MOD_RUN: '', GATE_FROZEN_SOURCE: '', ...env }, timeout: 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

test('tools/api-baselines-build.mjs: usage on no command, an unknown flag and build without a tag (exit 2, no Gradle)', () => {
  for (const args of [[], ['--bogus'], ['build'], ['frob']]) {
    const r = run('tools/api-baselines-build.mjs', args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
    assert.match(r.out, /usage/);
  }
});

test('tools/plan-catalogue-diff.mjs: usage with one file; a catalogue against itself is unchanged (exit 0); --json', () => {
  const c = 'kit/test/fixtures/plan/catalogue-p0.json';
  const u = run('tools/plan-catalogue-diff.mjs', [c]);
  assert.equal(u.code, 2);
  assert.match(u.out, /usage/);
  const same = run('tools/plan-catalogue-diff.mjs', [c, c]);
  assert.equal(same.code, 0, same.out);
  assert.match(same.out, /added: none/);
  assert.match(same.out, /REMOVED \(never allowed\): none/);
  const j = JSON.parse(run('tools/plan-catalogue-diff.mjs', [c, c, '--json']).out);
  assert.deepEqual([j.added, j.removed], [[], []]);
});

test('tools/step-inputs.mjs: usage on an unknown command; show and which are read-only', () => {
  const u = run('tools/step-inputs.mjs', ['frob']);
  assert.equal(u.code, 2);
  assert.match(u.out, /usage/);
  const s = run('tools/step-inputs.mjs', ['show', 'unit-kit']);
  assert.equal(s.code, 0, s.out);
  assert.ok(JSON.parse(s.out).filesAtHead > 0);
  const w = run('tools/step-inputs.mjs', ['which', 'tools/gate-run.mjs']);
  assert.equal(w.code, 0);
  assert.match(w.out, /tools\/gate-run\.mjs: in \d+ step set/);
});

test('tools/api-compat.mjs: usage without a jar; no compiled classes fails clearly (exit 2), never a MISSING list', () => {
  const empty = archTmpDir('api-compat-cli');
  const u = run('tools/api-compat.mjs', []);
  assert.equal(u.code, 2);
  assert.match(u.out, /usage/);
  const r = run('tools/api-compat.mjs', [path.join(empty, 'none.jar'), empty]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /FAIL api-compat: no compiled classes in/);
  assert.doesNotMatch(r.out, /MISSING/);
});

test('api-classes: unit-mod\'s run, then the frozen source, then this checkout; a dir without a class file is skipped', () => {
  const t = archTmpDir('api-classes');
  const mk = (base, withClass) => {
    const d = path.join(t, base, 'mod', 'build', 'classes', 'java', 'main', 'dev');
    fs.mkdirSync(d, { recursive: true });
    if (withClass) fs.writeFileSync(path.join(d, 'A.class'), 'x');
    return path.join(t, base);
  };
  const lane = mk('lane', false);
  const unit = mk('unit', true);
  const frozen = mk('frozen', true);
  assert.equal(hasClasses(path.join(lane, 'mod')), false);
  assert.match(resolveClassDirs({ root: lane, env: { GATE_UNIT_MOD_RUN: unit, GATE_FROZEN_SOURCE: frozen } }).source, /^GATE_UNIT_MOD_RUN/);
  assert.match(resolveClassDirs({ root: lane, env: { GATE_FROZEN_SOURCE: frozen } }).source, /^GATE_FROZEN_SOURCE/);
  assert.match(resolveClassDirs({ root: unit, env: {} }).source, /^this checkout/);
  const none = resolveClassDirs({ root: lane, env: {} });
  assert.equal(none.ok, false);
  assert.equal(none.dirs[0], path.join(lane, 'mod', 'build', 'classes', 'java', 'main'));
  assert.match(noClassesMessage(none.dirs, none.tried), /build first/);
});
