// tools/lib/run-shared.mjs (docs/GATES.md "Speed set C"): work a gate run's steps and parts share is done once, across processes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MOD = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'lib', 'run-shared.mjs')).href;

test('without a shared dir the work is only memoised in the process', async () => {
  delete process.env.GATE_RUN_SHARED;
  const { sharedOnce } = await import(`${MOD}?a`);
  let n = 0;
  const [a, b] = await Promise.all([sharedOnce('t', 'k', async () => ({ v: ++n })), sharedOnce('t', 'k', async () => ({ v: ++n }))]);
  assert.equal(n, 1);
  assert.equal(a.v, 1);
  assert.equal(b.v, 1);
});

test('two processes ask for the same key: one builds, the other waits for it and reuses it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-shared-'));
  const code = `
    const { sharedOnce } = await import(${JSON.stringify(MOD)});
    const t0 = Date.now();
    const v = await sharedOnce('t', 'k', async () => { await new Promise((r) => setTimeout(r, 1500)); return { by: process.pid }; }, { pollMs: 100 });
    console.log(JSON.stringify({ by: v.by, shared: v.shared, ms: Date.now() - t0 }));`;
  const run = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, GATE_RUN_SHARED: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (k) => (k === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${k}`))));
  });
  const [x, y] = await Promise.all([run(), run()]);
  assert.equal(x.by, y.by, 'both read the one build');
  assert.deepEqual([x.shared, y.shared].sort(), ['built', 'reused']);
  assert.ok(!fs.existsSync(path.join(dir, 't', 'k.lock')), 'the lock is dropped');
});

test('a builder that fails publishes nothing and drops its lock; the next asker builds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-shared-'));
  process.env.GATE_RUN_SHARED = dir;
  const { sharedOnce } = await import(`${MOD}?b`);
  await assert.rejects(sharedOnce('t', 'f', async () => { throw new Error('boom'); }), /boom/);
  assert.ok(!fs.existsSync(path.join(dir, 't', 'f.json')));
  assert.ok(!fs.existsSync(path.join(dir, 't', 'f.lock')));
  const v = await sharedOnce('t', 'f', async () => ({ ok: 1 }));
  assert.equal(v.ok, 1);
});

test('a lock whose pid is dead is taken over; onHit false builds again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-shared-'));
  process.env.GATE_RUN_SHARED = dir;
  const { sharedOnce } = await import(`${MOD}?c`);
  fs.mkdirSync(path.join(dir, 't', 'd.lock'), { recursive: true });
  fs.writeFileSync(path.join(dir, 't', 'd.lock', 'pid'), '999999');
  const v = await sharedOnce('t', 'd', async () => ({ n: 1 }), { pollMs: 50 });
  assert.equal(v.n, 1);
  const { sharedOnce: again } = await import(`${MOD}?d`); // a fresh memo: the file is there
  const w = await again('t', 'd', async () => ({ n: 2 }), { onHit: () => false });
  assert.equal(w.n, 2, 'a stale hit (its files gone) is built again');
});
