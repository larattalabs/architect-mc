import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectSweep, sweep, isHeld, knownNames, START_EARLY_MS, START_LATE_MS } from '../../tools/lib/tmp-sweep.mjs';
import { archTmpDir, removeArchTmp, OWNER_FILE, PROCESS_START_MS } from '../../tools/lib/arch-tmp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOUR = 3_600_000;
const NOW = Date.now();

// a fake tmp root (itself an arch- temp dir, cleaned at exit)
const fake = () => fs.realpathSync(archTmpDir('sweep-test'));
const roots = [];
after(() => roots.forEach(removeArchTmp));

function mk(root, name, { ageH = 0, owner = null, file = false } = {}) {
  const p = path.join(root, name);
  if (file) fs.writeFileSync(p, 'x');
  else {
    fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, 'data.bin'), Buffer.alloc(1000));
    if (owner) fs.writeFileSync(path.join(p, OWNER_FILE), JSON.stringify(owner));
  }
  const t = new Date(NOW - ageH * HOUR);
  if (!file) fs.utimesSync(path.join(p, 'data.bin'), t, t);
  if (owner && !file) fs.utimesSync(path.join(p, OWNER_FILE), t, t);
  fs.utimesSync(p, t, t);
  return p;
}
const LIVE = { pid: 4242, startMs: NOW - 5 * HOUR };
const starts = new Map([[4242, LIVE.startMs], [5353, NOW - HOUR]]);
// the known unmarked names in these fakes (the real list is tools/tmp-prefixes.json)
const known = (n) => n.startsWith('arch-nomark-') || n === 'arch-link' || n === 'arch-fake-owner' || n.startsWith('arch-a-') || n.startsWith('arch-b-');
const pick = (root, o = {}) => Object.fromEntries(selectSweep({ root, now: NOW, starts, alive: () => false, known, ...o }).map((i) => [i.name, i.action]));

test('selection: age, live pid, reused pid, no marker, symlink, non-arch names and plain files', () => {
  const root = fake();
  roots.push(root);
  mk(root, 'arch-old-dead', { ageH: 7, owner: { pid: 999999, startMs: NOW - 8 * HOUR } });
  mk(root, 'arch-young-dead', { ageH: 2, owner: { pid: 999999, startMs: NOW - 8 * HOUR } });
  mk(root, 'arch-old-live', { ageH: 30, owner: LIVE });
  mk(root, 'arch-old-reused', { ageH: 7, owner: { pid: 5353, startMs: NOW - 9 * HOUR } }); // pid alive, other start: not held
  mk(root, 'arch-nomark-old', { ageH: 25 });
  mk(root, 'arch-nomark-young', { ageH: 10 });
  mk(root, 'other-old', { ageH: 100 }); // unmarked, unknown name: never touched
  mk(root, 'arch-unknown-old', { ageH: 100 }); // unmarked arch- name not on the list: never touched
  mk(root, 'other-marked', { ageH: 7, owner: { pid: 999999, startMs: NOW - 8 * HOUR } }); // the marker decides, whatever the name
  mk(root, 'arch-bad-marker', { ageH: 100, owner: { pid: 'x' } }); // an invalid marker is no marker: unknown name, untouched
  mk(root, 'arch-file', { ageH: 100, file: true });
  const target = mk(root, 'target-dir', { ageH: 100 });
  fs.symlinkSync(target, path.join(root, 'arch-link'));
  const t = new Date(NOW - 30 * HOUR);
  fs.lutimesSync(path.join(root, 'arch-link'), t, t);

  assert.deepEqual(pick(root), {
    'arch-link': 'remove',
    'arch-nomark-old': 'remove',
    'arch-nomark-young': 'keep',
    'arch-old-dead': 'remove',
    'arch-old-live': 'keep',
    'arch-old-reused': 'remove',
    'arch-young-dead': 'keep',
    'other-marked': 'remove',
  });
  // a held dir stays at any age; hours are tunable
  assert.equal(pick(root, { hours: 1 })['arch-young-dead'], 'remove');
  assert.equal(pick(root, { hours: 0, noMarkerHours: 0 })['arch-old-live'], 'keep');

  // dry run touches nothing, reports bytes
  const dry = sweep({ root, dryRun: true, now: NOW, starts, alive: () => false, known });
  assert.equal(dry.removed, 5);
  assert.ok(dry.bytes >= 3000);
  assert.ok(fs.existsSync(path.join(root, 'arch-old-dead')));

  const r = sweep({ root, now: NOW, starts, alive: () => false, known });
  assert.equal(r.removed, 5);
  assert.equal(r.failed, 0);
  const left = fs.readdirSync(root).sort();
  assert.deepEqual(left, ['.arch-owner', 'arch-bad-marker', 'arch-file', 'arch-nomark-young', 'arch-old-live', 'arch-unknown-old', 'arch-young-dead', 'other-old', 'target-dir']);
  // the symlink went, never its target
  assert.ok(fs.existsSync(path.join(target, 'data.bin')));
});

test('a symlinked .arch-owner does not count as a marker', () => {
  const root = fake();
  roots.push(root);
  const p = mk(root, 'arch-fake-owner', { ageH: 7 });
  const elsewhere = path.join(root, 'owner.json');
  fs.writeFileSync(elsewhere, JSON.stringify(LIVE));
  fs.symlinkSync(elsewhere, path.join(p, OWNER_FILE));
  const t = new Date(NOW - 7 * HOUR);
  fs.lutimesSync(path.join(p, OWNER_FILE), t, t);
  fs.utimesSync(p, t, t);
  assert.equal(pick(root)['arch-fake-owner'], 'keep'); // no marker: 24 h
  assert.equal(pick(root, { noMarkerHours: 6 })['arch-fake-owner'], 'remove');
});

test('isHeld: start-time tolerance, and kill(0) when ps is unavailable', () => {
  // Node's timeOrigin is after the process start (boot, slow under load): held
  assert.equal(isHeld({ pid: 4242, startMs: LIVE.startMs + 5_000 }, starts), true);
  assert.equal(isHeld({ pid: 4242, startMs: LIVE.startMs + START_LATE_MS - 1 }, starts), true);
  assert.equal(isHeld({ pid: 4242, startMs: LIVE.startMs + START_LATE_MS + 1 }, starts), false);
  // the live process started after the marker's: a reused pid
  assert.equal(isHeld({ pid: 4242, startMs: LIVE.startMs - START_EARLY_MS - 1 }, starts), false);
  assert.equal(isHeld({ pid: 4242, startMs: LIVE.startMs - 500 }, starts), true);
  assert.equal(isHeld({ pid: 1234, startMs: 1 }, new Map(), () => true), true);
  assert.equal(isHeld({ pid: -1, startMs: 1 }, starts), false);
  assert.equal(isHeld(null, starts), false);
  // ps truncates to whole seconds
  assert.equal(isHeld({ pid: process.pid, startMs: PROCESS_START_MS }, new Map([[process.pid, PROCESS_START_MS - 900]])), true);
});

test('archTmpDir: marker, removal at normal exit and at SIGTERM; ARCH_KEEP_TMP keeps it', async () => {
  const lib = path.join(REPO, 'tools', 'lib', 'arch-tmp.mjs');
  const root = fake();
  roots.push(root);
  const code = (extra) => `import { archTmpDir } from ${JSON.stringify(lib)}; const d = archTmpDir('child', { root: ${JSON.stringify(root)} }); console.log(d); ${extra}`;
  const run = (extra, env = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', code(extra)], { encoding: 'utf8', env: { ...process.env, ...env } });

  const a = run(`import fs from 'node:fs'; const o = JSON.parse(fs.readFileSync(d + '/.arch-owner', 'utf8')); if (o.pid !== process.pid) process.exit(3);`);
  assert.equal(a.status, 0, a.stderr);
  assert.ok(path.basename(a.stdout.trim()).startsWith('arch-child-'));
  assert.equal(fs.existsSync(a.stdout.trim()), false);

  const thrown = run(`throw new Error('boom');`);
  assert.notEqual(thrown.status, 0);
  assert.equal(fs.existsSync(thrown.stdout.trim()), false);

  const kept = run('', { ARCH_KEEP_TMP: '1' });
  assert.equal(fs.existsSync(kept.stdout.trim()), true);

  const child = spawn(process.execPath, ['--input-type=module', '-e', code('setInterval(() => {}, 1000);')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const dir = await new Promise((res) => child.stdout.once('data', (b) => res(String(b).trim())));
  assert.equal(fs.existsSync(dir), true);
  child.kill('SIGTERM');
  const [, sig] = await new Promise((res) => child.once('exit', (...x) => res(x)));
  assert.equal(sig, 'SIGTERM'); // still dies of the signal
  assert.equal(fs.existsSync(dir), false);
});

test('RAM disk choice: off switch, missing dir, low free space; ENOSPC names the disk and the fix', async () => {
  const { ramTmpChoice, explainEnospc, RAM_DISK } = await import('../../tools/lib/ram-tmp.mjs');
  const root = fake();
  roots.push(root);
  assert.equal(ramTmpChoice({ dir: root, env: {} }).dir, root);
  assert.equal(ramTmpChoice({ dir: root, env: { ARCH_NO_RAMDISK: '1' } }).dir, null);
  assert.equal(ramTmpChoice({ dir: path.join(root, 'nope'), env: {} }).dir, null);
  const low = ramTmpChoice({ dir: root, env: {}, minFree: Number.MAX_SAFE_INTEGER });
  assert.equal(low.dir, null);
  assert.match(low.why, /tmp-sweep/);
  const e = Object.assign(new Error('no space'), { code: 'ENOSPC', path: `${RAM_DISK}/tmp/arch-x` });
  const x = explainEnospc(e);
  assert.match(x.message, /RAM disk \/Volumes\/MCTmp is full .*node tools\/tmp-sweep\.mjs/);
  assert.equal(x.code, 'ENOSPC');
  const other = Object.assign(new Error('no space'), { code: 'ENOSPC', path: '/elsewhere' });
  assert.equal(explainEnospc(other), other);
});

test('sweepAll: every root, summed', async () => {
  const { sweepAll } = await import('../../tools/lib/tmp-sweep.mjs');
  const a = fake();
  const b = fake();
  roots.push(a, b);
  mk(a, 'arch-a-old', { ageH: 30 });
  mk(b, 'arch-b-old', { ageH: 30 });
  mk(b, 'arch-b-young', { ageH: 1 });
  const r = sweepAll({ roots: [a, b], now: NOW, starts, alive: () => false, known });
  assert.equal(r.removed, 2);
  assert.deepEqual(r.roots.map((x) => x.removed), [1, 1]);
  assert.deepEqual(fs.readdirSync(b).sort(), ['.arch-owner', 'arch-b-young']);
});

test('the committed list of pre-TS names: exact mkdtemp shape only', () => {
  const k = knownNames();
  for (const n of ['step-cache-abc123', 'arch-test-Zz9Zz9', 'adopt-pt2-q1W2e3', 'lint-mut-s-theme-AbCdEf', 'au-AbC123']) assert.equal(k(n), true, n);
  for (const n of ['step-cache-abc12', 'step-cache-abc1234', 'step-cache-', 'com.google.Chrome.x', 'TemporaryDirectory.ab12cd', 'steward-m2-abc123', 'arch-newthing-abc123']) assert.equal(k(n), false, n);
});

test('the RAM-disk TMPDIR reaches every `node --test` file process and its children', () => {
  const ram = fake();
  roots.push(ram);
  const lib = path.join(REPO, 'tools', 'lib', 'arch-tmp.mjs');
  const fixture = path.join(ram, 'worker.test.mjs');
  fs.writeFileSync(fixture, `import { test } from 'node:test';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { archTmpDir } from ${JSON.stringify(lib)};
test('worker', () => {
  const d = archTmpDir('worker');
  const child = execFileSync(process.execPath, ['-p', 'require("os").tmpdir()'], { encoding: 'utf8' }).trim();
  console.log('TMPS ' + JSON.stringify({ worker: os.tmpdir(), dir: d, child }));
});
`);
  const env = { ...process.env, ARCH_RAM_TMP: ram };
  delete env.ARCH_NO_RAMDISK;
  delete env.NODE_TEST_CONTEXT; // a nested runner would otherwise talk the parent runner's protocol
  env.TMPDIR = path.join(ram, 'not-this'); // a parent's own TMPDIR is replaced
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fixture], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const m = r.stdout.match(/TMPS (\{.*\})/);
  assert.ok(m, r.stdout);
  const t = JSON.parse(m[1]);
  assert.equal(t.worker, ram);
  assert.equal(t.child, ram);
  assert.equal(path.dirname(t.dir), ram);
  // ARCH_NO_RAMDISK=1: the normal TMPDIR
  const off = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fixture], { encoding: 'utf8', env: { ...env, ARCH_NO_RAMDISK: '1', TMPDIR: ram } });
  assert.equal(JSON.parse(off.stdout.match(/TMPS (\{.*\})/)[1]).worker, ram);
});
