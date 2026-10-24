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
