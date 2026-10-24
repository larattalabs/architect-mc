// The gate runner's frozen source (tools/lib/frozen-source.mjs, docs/GATES.md "Frozen source and the CPU budget"): the drivers run from a detached
// worktree at the run's HEAD, so a commit in the source checkout during the run changes nothing they read; a dirty snapshot is
// refused; the kit-suite readers that will re-run the kit suite get their configured timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { kitReaderSlowPath, prepareFrozenSource } from '../../tools/lib/frozen-source.mjs';

const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-src-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'kit'), { recursive: true });
  git(root, 'init', '-q', src);
  fs.writeFileSync(path.join(src, 'kit', 'a.mjs'), 'export const v = 1;\n');
  git(src, 'add', '-A');
  git(src, 'commit', '-q', '-m', 'one');
  return { root, src, head: git(src, 'rev-parse', 'HEAD') };
}

test('the frozen source: a worktree at the run head; a commit in the source mid-run does not reach it', () => {
  const { root, src, head } = repo();
  try {
    const dir = path.join(root, 'run-src');
    fs.mkdirSync(path.join(src, 'sidecar', 'node_modules', 'x'), { recursive: true }); // an untracked dep the drivers need
    fs.writeFileSync(path.join(src, 'sidecar', 'node_modules', 'x', 'i.js'), '1');
    const r = prepareFrozenSource({ src, main: null, dir, head, seed: ['sidecar/node_modules', '.gradle-home'] });
    assert.equal(r.created, true);
    assert.deepEqual(r.seeded, ['sidecar/node_modules']); // .gradle-home exists nowhere: skipped
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.ok(fs.existsSync(path.join(dir, 'sidecar', 'node_modules', 'x', 'i.js')));
    // the agent commits a kit change in its checkout while the run goes on
    fs.writeFileSync(path.join(src, 'kit', 'a.mjs'), 'export const v = 2;\n');
    git(src, 'commit', '-q', '-am', 'two');
    assert.equal(fs.readFileSync(path.join(dir, 'kit', 'a.mjs'), 'utf8'), 'export const v = 1;\n');
    assert.equal(git(dir, 'rev-parse', 'HEAD:kit'), git(src, 'rev-parse', `${head}:kit`));
    assert.equal(kitReaderSlowPath({ step: { waitFor: ['unit-kit'] }, hasReport: true, unitKit: 'PASS', drvDir: dir }), null);
    // the next run: checked out at its own head, reused
    const head2 = git(src, 'rev-parse', 'HEAD');
    const r2 = prepareFrozenSource({ src, main: null, dir, head: head2, seed: ['sidecar/node_modules'] });
    assert.equal(r2.created, false);
    assert.deepEqual(r2.seeded, []);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a frozen source with modified tracked files is refused; a dirty kit/ sends the readers to their configured timeout', () => {
  const { root, src, head } = repo();
  try {
    const dir = path.join(root, 'run-src');
    prepareFrozenSource({ src, main: null, dir, head, seed: [] });
    fs.writeFileSync(path.join(dir, 'kit', 'b.mjs'), 'untracked\n');
    const reader = { waitFor: ['unit-kit'] };
    assert.match(kitReaderSlowPath({ step: reader, hasReport: true, unitKit: 'PASS', drvDir: dir }), /kit\/ is dirty/);
    fs.writeFileSync(path.join(dir, 'kit', 'a.mjs'), 'export const v = 9;\n');
    assert.throws(() => prepareFrozenSource({ src, main: null, dir, head, seed: [] }), /modified tracked files/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the kit-suite readers\' slow path: unit-kit not passing, no report, not a reader', () => {
  const reader = { waitFor: ['unit-kit'] };
  assert.match(kitReaderSlowPath({ step: reader, hasReport: true, unitKit: 'FAIL', drvDir: null }), /unit-kit FAIL/);
  assert.match(kitReaderSlowPath({ step: reader, hasReport: true, unitKit: 'TIMEOUT', drvDir: null }), /unit-kit TIMEOUT/);
  assert.equal(kitReaderSlowPath({ step: reader, hasReport: true, unitKit: 'CACHED', drvDir: null }), null);
  assert.equal(kitReaderSlowPath({ step: reader, hasReport: false, unitKit: null, drvDir: null }), null); // the runner's own rule
  assert.equal(kitReaderSlowPath({ step: { waitFor: [] }, hasReport: true, unitKit: 'FAIL', drvDir: null }), null);
});

test('the frozen source is built before any step: classes appear in the snapshot, a failed build throws', async () => {
  const { buildFrozenClasses } = await import('../../tools/lib/frozen-source.mjs');
  const { root, src, head } = repo();
  try {
    // a stand-in gradlew: writes the class dirs the real tasks produce, fails when FAIL_BUILD marks the snapshot
    fs.mkdirSync(path.join(src, 'mod'), { recursive: true });
    fs.writeFileSync(path.join(src, 'mod', 'gradlew'), '#!/bin/sh\nif [ -f ../FAIL_BUILD ]; then echo "compile error: boom" >&2; exit 1; fi\nmkdir -p build/classes/java/main ../devserver/build/classes/java/main ../apitest/build/classes/java/main\necho "$@ $GRADLE_USER_HOME" > build/args.txt\ntouch build/classes/java/main/A.class\n');
    fs.chmodSync(path.join(src, 'mod', 'gradlew'), 0o755);
    git(src, 'add', '-A');
    git(src, 'commit', '-q', '-m', 'mod');
    const dir = path.join(root, 'run-src');
    prepareFrozenSource({ src, main: null, dir, head: git(src, 'rev-parse', 'HEAD'), seed: [] });
    assert.ok(!fs.existsSync(path.join(dir, 'mod', 'build'))); // the bug: a fresh snapshot has no classes
    buildFrozenClasses({ dir });
    assert.ok(fs.existsSync(path.join(dir, 'mod', 'build', 'classes', 'java', 'main', 'A.class')));
    assert.ok(fs.existsSync(path.join(dir, 'devserver', 'build', 'classes', 'java', 'main')));
    const args = fs.readFileSync(path.join(dir, 'mod', 'build', 'args.txt'), 'utf8');
    assert.match(args, /--offline .*classes testClasses :devserver:classes :apitest:classes/);
    assert.ok(args.includes(path.join(dir, '.gradle-home'))); // the snapshot's own gradle home
    fs.writeFileSync(path.join(root, 'run-src', 'FAIL_BUILD'), '');
    assert.throws(() => buildFrozenClasses({ dir }), /mod build failed.*boom/s);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
