// tools/lib/turbo.mjs: the gate-run queue and turbo's exclusive hold (docs/GATES.md "Turbo"). Each simulated run is a real
// `sleep` process, so liveness is the real pid check the runner uses; killing one is a crashed run.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseTurbo, enqueue, liveHolders, liveTickets, loadConfig, loadGate, releaseAll, slotFile, tryAcquire } from '../../tools/lib/turbo.mjs';

const kids = [];
after(() => {
  for (const k of kids) try { k.kill('SIGKILL'); } catch {}
});
/** A live pid for a simulated run. */
function run(chain, turbo = false) {
  const k = spawn('sleep', ['120'], { stdio: 'ignore' });
  kids.push(k);
  return { pid: k.pid, worktree: `/tmp/${chain}`, chain, turbo, kill: () => new Promise((r) => { k.once('exit', r); k.kill('SIGKILL'); }) };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gate-turbo-'));
const me = (r) => ({ pid: r.pid, worktree: r.worktree, chain: r.chain, turbo: r.turbo });
const go = (dir, r, o = {}) => tryAcquire(dir, r.m, { slots: 4, fill: 8, decide: async () => ({ shards: 1, ports: [] }), ...o });
async function queued(dir, r) {
  r.m = me(r);
  await enqueue(dir, r.m);
  return r;
}

test('a shared run takes one slot; a second shared run takes the next', async () => {
  const dir = tmp();
  const a = await queued(dir, run('a'));
  const b = await queued(dir, run('b'));
  assert.deepEqual((await go(dir, a)).slots, [1]);
  assert.deepEqual((await go(dir, b)).slots, [2]);
  assert.equal(liveTickets(dir).length, 0, 'tickets leave the queue once the run holds its slot');
});

test('turbo waits for every running holder, reserving freed slots, then holds every slot', async () => {
  const dir = tmp();
  const a = await queued(dir, run('a'));
  assert.ok((await go(dir, a)).acquired);
  const t = await queued(dir, run('t', true));
  const w = await go(dir, t);
  assert.equal(w.acquired, false);
  assert.match(w.waitingOn.join(), new RegExp(`running: pid ${a.pid}`));
  assert.deepEqual(w.reserved, [2, 3, 4, 5, 6, 7, 8], 'the free slots are reserved for it at once');
  // a pre-queue runner (it only looks at slot files) finds no free slot in 1..4
  for (let i = 2; i <= 4; i++) assert.equal(JSON.parse(fs.readFileSync(slotFile(dir, i))).pid, t.pid);
  await a.kill();
  const g = await go(dir, t);
  assert.ok(g.acquired);
  assert.deepEqual(g.slots, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(liveHolders(dir).length, 1);
  assert.equal(liveHolders(dir)[0].state, 'running');
  releaseAll(dir, t.pid);
  assert.equal(liveHolders(dir).length, 0);
});

test('a run queued behind a turbo run waits for it, says so, and starts when it ends', async () => {
  const dir = tmp();
  const t = await queued(dir, run('t', true));
  assert.ok((await go(dir, t)).acquired);
  const b = await queued(dir, run('b'));
  const w = await go(dir, b);
  assert.equal(w.acquired, false);
  assert.match(w.waitingOn.join(), new RegExp(`the machine: pid ${t.pid} TURBO t`));
  releaseAll(dir, t.pid);
  assert.ok((await go(dir, b)).acquired);
});

test('turbo never overtakes a run queued before it (no starvation of the earlier run)', async () => {
  const dir = tmp();
  const slots = [];
  for (let i = 0; i < 4; i++) {
    const h = await queued(dir, run(`h${i}`));
    assert.ok((await go(dir, h)).acquired);
    slots.push(h);
  }
  const early = await queued(dir, run('early'));
  const t = await queued(dir, run('t', true));
  assert.equal((await go(dir, early)).acquired, false, 'all 4 slots in use');
  const w = await go(dir, t);
  assert.equal(w.acquired, false);
  assert.match(w.waitingOn.join(), new RegExp(`queued before it: pid ${early.pid}`));
  assert.equal(w.reserved, undefined, 'it reserves nothing while an earlier run waits');
  await slots[0].kill();
  // the freed slot goes to the earlier run, not to the turbo run polling first
  assert.equal((await go(dir, t)).acquired, false);
  assert.deepEqual((await go(dir, early)).slots, [1]);
  // now the turbo run is at the head: it reserves what frees and waits for the holders
  const w2 = await go(dir, t);
  assert.equal(w2.acquired, false);
  assert.match(w2.waitingOn.join(), /running:/);
});

test('a later shared run never overtakes an earlier one (FIFO among shared runs)', async () => {
  const dir = tmp();
  const hs = [];
  for (let i = 0; i < 4; i++) {
    const h = await queued(dir, run(`h${i}`));
    await go(dir, h);
    hs.push(h);
  }
  const e1 = await queued(dir, run('e1'));
  const e2 = await queued(dir, run('e2'));
  await hs[3].kill();
  const w = await go(dir, e2);
  assert.equal(w.acquired, false);
  assert.match(w.waitingOn.join(), new RegExp(`queued before it: pid ${e1.pid}`));
  assert.ok((await go(dir, e1)).acquired);
});

test('stale state is found by pid: a dead ticket, a dead holder and a dead turbo hold are free', async () => {
  const dir = tmp();
  const dead = await queued(dir, run('dead', true));
  assert.ok((await go(dir, dead)).acquired, 'the turbo run holds the machine');
  const b = await queued(dir, run('b'));
  assert.equal((await go(dir, b)).acquired, false);
  await dead.kill(); // crashed without releasing: its 8 slot files stay on disk
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('slot-')).length, 8);
  assert.ok((await go(dir, b)).acquired, 'a dead turbo hold does not block');
  const d2 = await queued(dir, run('d2'));
  await d2.kill(); // a dead ticket at the head of the queue
  const c = await queued(dir, run('c'));
  assert.ok((await go(dir, c)).acquired, 'a dead ticket ahead does not block');
  assert.ok(!liveTickets(dir).some((t) => t.pid === d2.pid));
});

test('the queue order is the order of enqueueing, even when clocks tie', async () => {
  const dir = tmp();
  const rs = [];
  for (let i = 0; i < 5; i++) rs.push(await queued(dir, run(`q${i}`)));
  const order = liveTickets(dir).map((t) => t.pid);
  assert.deepEqual(order, rs.map((r) => r.pid));
  assert.equal(new Set(liveTickets(dir).map((t) => t.enqueuedAt)).size, 5, 'strictly increasing enqueue times');
});

test('two turbo runs: the second waits for the first, then goes', async () => {
  const dir = tmp();
  const t1 = await queued(dir, run('t1', true));
  const t2 = await queued(dir, run('t2', true));
  assert.ok((await go(dir, t1)).acquired);
  const w = await go(dir, t2);
  assert.equal(w.acquired, false);
  assert.match(w.waitingOn.join(), new RegExp(`running: pid ${t1.pid}`));
  releaseAll(dir, t1.pid);
  assert.ok((await go(dir, t2)).acquired);
});

test('chooseTurbo: no cpu cap; plan, memory and ports bind; lanes take memory and ports', () => {
  const tc = { planSlack: 0.03, reserveGB: 8, memPerShardGB: 5, laneGB: 2 };
  const wall = (n) => 400 / n + 20;
  const probe = { freeGB: 110, load1: 90, load5: 90, cores: 18 };
  const c = chooseTurbo(tc, { max: 12, probe, lanes: 2, wallFor: wall, pairs: 30 });
  assert.equal(c.caps.memory, 19);
  assert.ok(!('cpu' in c.caps));
  assert.equal(c.n, 12, 'a busy load average does not cap a turbo run');
  assert.equal(chooseTurbo(tc, { max: 12, probe: { ...probe, freeGB: 50 }, lanes: 2, wallFor: wall, pairs: 30 }).n, 7);
  assert.equal(chooseTurbo(tc, { max: 12, probe, lanes: 2, wallFor: wall, pairs: 8 }).n, 6);
  assert.equal(chooseTurbo(tc, { max: 12, probe, lanes: 0, wallFor: (n) => Math.max(30, 400 / n), pairs: 30 }).n, 12);
});

test('a turbo run hands the machine straight to the next queued turbo run: a pre-queue runner cannot slip in between', async () => {
  const dir = tmp();
  const t1 = await queued(dir, run('t1', true));
  assert.ok((await go(dir, t1)).acquired);
  const t2 = await queued(dir, run('t2', true));
  assert.equal((await go(dir, t2)).acquired, false);
  assert.equal(releaseAll(dir, t1.pid), t2.pid, 'handed to t2');
  for (let i = 1; i <= 8; i++) {
    const h = JSON.parse(fs.readFileSync(slotFile(dir, i)));
    assert.equal(h.pid, t2.pid, `slot ${i} is t2's at once`);
    assert.equal(h.handedOverBy, t1.pid);
  }
  assert.ok((await go(dir, t2)).acquired);
  // a shared run at the head gets nothing handed: the slots are freed for it
  const b = await queued(dir, run('b'));
  assert.equal(releaseAll(dir, t2.pid), null);
  assert.equal(liveHolders(dir).length, 0);
  assert.ok((await go(dir, b)).acquired);
});

// ------------------------------------------------------------------ the load-aware start (docs/GATES.md "Load-aware start")

const LOAD = { max1: 36, settleSec: 120, maxWaitMin: 30 };
/** A holder that started `ago` ms before `at`. */
const startedAgo = (h, at, ago) => {
  for (const i of liveHolders(h.dir).find((x) => x.pid === h.pid).slots) {
    const f = slotFile(h.dir, i);
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), startedAt: new Date(at - ago).toISOString() }));
  }
};

test('load-aware start: the head of the queue waits while the load is high and goes when it drops; FIFO holds behind it', async () => {
  const dir = tmp();
  const t = Date.now();
  const h = await queued(dir, run('h'));
  await go(dir, h);
  h.dir = dir;
  startedAgo(h, t, 10 * 60_000);
  const a = await queued(dir, run('a'));
  const b = await queued(dir, run('b'));
  let load = 70;
  const o = { load: LOAD, loadNow: () => load, now: () => t };
  const wa = await go(dir, a, o);
  assert.equal(wa.acquired, false);
  assert.equal(wa.load, true);
  assert.equal(wa.load1, 70);
  assert.match(wa.waitingOn.join(), /load-aware start: the 1-min load above 36/);
  // b is behind a: it waits for a, not on the load, and does not overtake it
  const wb = await go(dir, b, o);
  assert.equal(wb.acquired, false);
  assert.match(wb.waitingOn.join(), new RegExp(`queued before it: pid ${a.pid}`));
  load = 20;
  const ga = await go(dir, a, { ...o, now: () => t + 90_000 });
  assert.deepEqual(ga.slots, [2]);
  assert.equal(a.m.loadWait.seconds, 90);
  assert.equal(a.m.loadWait.gaveUp, false);
});

test('load-aware start: no herd; a run that just started holds the next back until its load shows', async () => {
  const dir = tmp();
  const t = Date.now();
  const h = await queued(dir, run('h'));
  await go(dir, h);
  h.dir = dir;
  startedAgo(h, t, 30_000);
  const a = await queued(dir, run('a'));
  const o = { load: LOAD, loadNow: () => 5 };
  const w = await go(dir, a, { ...o, now: () => t });
  assert.equal(w.acquired, false);
  assert.match(w.waitingOn.join(), /started less than 120 s ago/);
  assert.ok((await go(dir, a, { ...o, now: () => t + 91_000 })).acquired, 'two minutes after the last start, at a low load');
});

test('load-aware start: never waits when it would be the only gate run; gives up after the cap; max1 0 is off', async () => {
  const dir = tmp();
  const t = Date.now();
  const alone = await queued(dir, run('alone'));
  const ga = await go(dir, alone, { load: LOAD, loadNow: () => 99, now: () => t });
  assert.ok(ga.acquired, 'alone: the load is not the gate runs\'');
  assert.equal(alone.m.loadWait, undefined);
  alone.dir = dir;
  startedAgo(alone, t, 10 * 60_000);
  const c = await queued(dir, run('c'));
  const o = { load: LOAD, loadNow: () => 99 };
  assert.equal((await go(dir, c, { ...o, now: () => t })).acquired, false);
  assert.equal((await go(dir, c, { ...o, now: () => t + 29 * 60_000 })).acquired, false);
  const gc = await go(dir, c, { ...o, now: () => t + 30 * 60_000 });
  assert.ok(gc.acquired);
  assert.equal(c.m.loadWait.gaveUp, true);
  assert.equal(c.m.loadWait.seconds, 1800);
  const d = await queued(dir, run('d'));
  assert.ok((await go(dir, d, { load: { ...LOAD, max1: 0 }, loadNow: () => 99, now: () => t })).acquired);
});

test('load-aware start: config and env', () => {
  assert.deepEqual(loadConfig({}, {}), { max1: 36, settleSec: 120, maxWaitMin: 30 });
  assert.deepEqual(loadConfig({ slots: { load: { max1: 30 } } }, { GATE_LOAD_WAIT_MAX_MIN: '10' }), { max1: 30, settleSec: 120, maxWaitMin: 10 });
  assert.equal(loadConfig({}, { GATE_LOAD_MAX: '0' }).max1, 0);
  assert.equal(loadGate({}, [{ startedAt: new Date(0).toISOString() }], { load: null }), null);
});
