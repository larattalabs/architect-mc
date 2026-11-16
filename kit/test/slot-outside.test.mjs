// tools/lib/slots.mjs + tools/slot.mjs: gate-run slots for outside callers (Steward; docs/GATES.md "Outside callers (Steward)").
// Every test uses its own temp slots dir (never the live .gate-slots). Holders are real `sleep` processes, so liveness is the real
// pid check; killing one is a crashed driver.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireSlot, ARCHITECT_ROOT, releaseTicket, resolveSlotsDir, slotStatus } from '../../tools/lib/slots.mjs';
import { enqueue, liveHolders, liveTickets, slotFile, tryAcquire } from '../../tools/lib/turbo.mjs';
import { archTmpDir } from '../../tools/lib/arch-tmp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const kids = [];
after(() => {
  for (const k of kids) try { k.kill('SIGKILL'); } catch {}
});
function proc() {
  const k = spawn('sleep', ['120'], { stdio: 'ignore' });
  kids.push(k);
  return { pid: k.pid, kill: () => new Promise((r) => { k.once('exit', r); k.kill('SIGKILL'); }) };
}
const tmp = () => archTmpDir('slot-outside');
const cfg = (o = {}) => ({ slots: { max: 2, load: { max1: 72, settleSec: 0, maxWaitMin: 15, ...o } } });
const base = (o = {}) => ({ who: 'steward', label: 'e2e', cfg: cfg(), env: {}, pollMs: 20, log: () => {}, loadNow: () => 1, ...o });
const SHORT = 0.006; // ~360 ms

test('acquire writes a slot held by --pid with who/label/ticket; the queue empties', async () => {
  const dir = tmp();
  const h = proc();
  const r = await acquireSlot(dir, base({ pid: h.pid, worktree: '/w/steward' }));
  assert.equal(r.slot, 1);
  assert.match(r.ticket, /^t-\d+-\d+$/);
  const f = JSON.parse(fs.readFileSync(slotFile(dir, 1), 'utf8'));
  assert.equal(f.pid, h.pid, 'the holder, not the waiting process');
  assert.deepEqual([f.who, f.label, f.ticket, f.worktree, f.outside, f.shards], ['steward', 'e2e', r.ticket, '/w/steward', true, 1]);
  assert.equal(liveTickets(dir).length, 0);
  const s = slotStatus(dir, { cfg: cfg(), env: {}, loadNow: () => [5, 4] });
  assert.equal(s.holders[0].who, 'steward');
  assert.equal(s.holders[0].label, 'e2e');
  assert.equal(s.free, 1);
  assert.equal(s.turbo.active, false);
});

test('contention: with every slot held it times out, naming load and turbo; a dead holder frees its slot', async () => {
  const dir = tmp();
  const a = proc();
  const b = proc();
  const c = proc();
  await acquireSlot(dir, base({ pid: a.pid }));
  await acquireSlot(dir, base({ pid: b.pid }));
  await assert.rejects(acquireSlot(dir, base({ pid: c.pid, maxWaitMin: SHORT })), (e) => e.code === 'SLOT_TIMEOUT' && /waited .* for a slot \(load .*turbo none/.test(e.message));
  assert.equal(liveTickets(dir).length, 0, 'a timed-out ticket leaves the queue');
  await a.kill();
  const r = await acquireSlot(dir, base({ pid: c.pid, maxWaitMin: SHORT }));
  assert.equal(r.slot, 1, 'the dead pid\'s slot is free');
});

test('one holder pid holds several slots; release frees only the given ticket; shards add up', async () => {
  const dir = tmp();
  const d = proc();
  const r1 = await acquireSlot(dir, base({ pid: d.pid, label: 'client-1' }));
  const r2 = await acquireSlot(dir, base({ pid: d.pid, label: 'client-2' }));
  assert.deepEqual([r1.slot, r2.slot], [1, 2]);
  assert.notEqual(r1.ticket, r2.ticket);
  const lh = liveHolders(dir);
  assert.equal(lh.length, 1);
  assert.deepEqual(lh[0].slots, [1, 2]);
  assert.equal(lh[0].shards, 2, 'gate-run\'s shard budget counts both clients');
  const rel = await releaseTicket(dir, r1.ticket);
  assert.deepEqual(rel.released, [1]);
  assert.ok(!fs.existsSync(slotFile(dir, 1)));
  assert.equal(JSON.parse(fs.readFileSync(slotFile(dir, 2), 'utf8')).ticket, r2.ticket, 'the other ticket keeps its slot');
  assert.deepEqual((await releaseTicket(dir, r1.ticket)).released, [], 'a second release frees nothing');
  assert.deepEqual((await releaseTicket(dir, 't-1-1')).released, [], 'an unknown ticket frees nothing');
  await assert.rejects(releaseTicket(dir, 'slot-2'), /not a ticket/);
});

test('a dead holder pid is refused at once', async () => {
  const dir = tmp();
  const h = proc();
  await h.kill();
  await assert.rejects(acquireSlot(dir, base({ pid: h.pid })), (e) => e.code === 'SLOT_HOLDER_DEAD');
});

test('turbo: a queued turbo run is ahead (FIFO); a reserving one blocks acquire and shows in status', async () => {
  const dir = tmp();
  const g = proc(); // a gate run holding slot 1
  const gm = { pid: g.pid, worktree: '/w/gate', chain: 'slice', turbo: false };
  await enqueue(dir, gm);
  assert.ok((await tryAcquire(dir, gm, { slots: 2, decide: async () => ({ shards: 1, ports: [] }) })).acquired);
  const t = proc();
  const tm = { pid: t.pid, worktree: '/w/turbo', chain: 'release', turbo: true };
  await enqueue(dir, tm);
  let s = slotStatus(dir, { cfg: cfg(), env: {}, loadNow: () => [1, 1] });
  assert.equal(s.turbo.active, true);
  assert.deepEqual(s.turbo.queued.map((q) => q.pid), [t.pid], 'queued turbo shows before it reserves');
  const h = proc();
  await assert.rejects(acquireSlot(dir, base({ pid: h.pid, maxWaitMin: SHORT })), (e) => e.code === 'SLOT_TIMEOUT' && /turbo queued/.test(e.message));
  const r = await tryAcquire(dir, tm, { slots: 2, fill: 2 });
  assert.equal(r.acquired, false);
  s = slotStatus(dir, { cfg: cfg(), env: {}, loadNow: () => [1, 1] });
  assert.deepEqual(s.turbo.reserving.map((x) => x.pid), [t.pid]);
  assert.deepEqual(s.turbo.reserving[0].slots, [2]);
  assert.equal(s.turbo.queued.length, 0);
  await assert.rejects(acquireSlot(dir, base({ pid: h.pid, maxWaitMin: SHORT })), (e) => e.code === 'SLOT_TIMEOUT' && /turbo reserving/.test(e.message));
  // the turbo run waits for an outside holder too
  await g.kill();
  await t.kill();
  const o = await acquireSlot(dir, base({ pid: h.pid }));
  const t2 = proc();
  const t2m = { pid: t2.pid, worktree: '/w/turbo2', chain: 'release', turbo: true };
  await enqueue(dir, t2m);
  const w = await tryAcquire(dir, t2m, { slots: 2, fill: 2 });
  assert.equal(w.acquired, false);
  assert.ok(w.waitingOn.some((x) => x.includes(`pid ${h.pid}`) && x.includes('steward:e2e')), w.waitingOn.join('; '));
  await releaseTicket(dir, o.ticket);
  assert.ok((await tryAcquire(dir, t2m, { slots: 2, fill: 2 })).acquired, 'turbo goes once the outside holder released');
});

test('load gate: waits while the load is high or a holder just started, gives up at the cap; --no-load-wait and a low load go', async () => {
  const dir = tmp();
  const a = proc();
  const b = proc();
  await acquireSlot(dir, base({ pid: a.pid }));
  // load alone: it waits the whole cap, then starts anyway (the load gate's give-up, as for a gate run), recorded as gaveUp
  const t0 = Date.now();
  const gave = await acquireSlot(dir, base({ pid: b.pid, maxWaitMin: SHORT, loadNow: () => 100 }));
  assert.ok(Date.now() - t0 >= SHORT * 60_000 - 50, 'it waited on the load');
  assert.equal(gave.loadWait?.gaveUp, true);
  await releaseTicket(dir, gave.ticket);
  const ok = await acquireSlot(dir, base({ pid: b.pid, maxWaitMin: SHORT, loadNow: () => 100, noLoadWait: true }));
  assert.equal(ok.slot, 2);
  await releaseTicket(dir, ok.ticket);
  let n = 0;
  const r = await acquireSlot(dir, base({ pid: b.pid, maxWaitMin: 0.05, loadNow: () => (n++ < 3 ? 100 : 10) }));
  assert.equal(r.slot, 2, 'goes once the load drops');
  // settle: a holder that started under settleSec ago holds the next one back
  const dir2 = tmp();
  await acquireSlot(dir2, base({ pid: a.pid, cfg: cfg({ settleSec: 120 }) }));
  const t1 = Date.now();
  const st = await acquireSlot(dir2, base({ pid: b.pid, cfg: cfg({ settleSec: 120 }), maxWaitMin: SHORT }));
  assert.ok(Date.now() - t1 >= SHORT * 60_000 - 50, 'held back by the settle rule');
  assert.equal(st.loadWait?.gaveUp, true);
  // full slots with a high load still time out (load gives up, a slot never appears)
  const c = proc();
  await assert.rejects(acquireSlot(dir2, base({ pid: c.pid, cfg: cfg({ settleSec: 120 }), maxWaitMin: SHORT, loadNow: () => 100 })), (e) => e.code === 'SLOT_TIMEOUT' && /load 100/.test(e.message));
});

test('maxWaitMin is capped at rule 10\'s 15', async () => {
  const dir = tmp();
  const h = proc();
  const t0 = Date.now();
  const r = await acquireSlot(dir, base({ pid: h.pid, maxWaitMin: 999 }));
  assert.equal(r.slot, 1);
  assert.ok(Date.now() - t0 < 5000);
});

test('CLI from another repo\'s cwd: acquire, status --json, release; the default dir is the checkout\'s ../.gate-slots', () => {
  assert.equal(resolveSlotsDir({ env: {} }), path.join(ARCHITECT_ROOT, '..', '.gate-slots'));
  assert.equal(ARCHITECT_ROOT, ROOT);
  const dir = tmp();
  const cwd = tmp();
  const h = proc();
  const env = { ...process.env, GATE_SLOTS_DIR: dir, GATE_SLOT_POLL_MS: '20' };
  const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'slot.mjs'), ...a], { cwd, env, encoding: 'utf8' });
  const a = cli('acquire', '--who', 'steward', '--label', 'e2e-client-1', '--pid', String(h.pid), '--no-load-wait');
  assert.equal(a.status, 0, a.stderr);
  const r = JSON.parse(a.stdout);
  assert.equal(r.slot, 1);
  assert.equal(JSON.parse(fs.readFileSync(slotFile(dir, 1), 'utf8')).worktree, cwd);
  const s = JSON.parse(cli('status', '--json').stdout);
  assert.equal(s.dir, dir);
  assert.deepEqual(s.holders.map((x) => [x.who, x.label, x.pid]), [['steward', 'e2e-client-1', h.pid]]);
  assert.ok('reserving' in s.turbo && 'queued' in s.turbo && Array.isArray(s.queue));
  assert.equal(cli('release', '--ticket', r.ticket).status, 0);
  assert.equal(cli('release', '--ticket', r.ticket).status, 4, 'nothing left to free');
  assert.equal(cli('acquire', '--who', 'steward', '--label', 'x').status, 1, '--pid is required');
});
