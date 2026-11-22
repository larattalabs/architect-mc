// tools/lib/heartbeat.mjs: a running step's heartbeat in runner.log (docs/GATES.md "For agents: launch, then wait once"), so a quiet
// step can be told from a hung one, and the "possibly stalled" log flag (never a kill).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHeartbeat, sumCpu } from '../../tools/lib/heartbeat.mjs';
import { archTmpDir, removeArchTmp } from '../../tools/lib/arch-tmp.mjs';

const MIN = 60_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** An in-memory fs: files[name] = { size, mtimeMs }; grow(name, n, at) appends n bytes. */
function fakeFs() {
  const files = {};
  return {
    files,
    grow(f, n, at) {
      files[f] = { size: (files[f]?.size ?? 0) + n, mtimeMs: at };
    },
    statSync(f) {
      if (!files[f]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[f];
    },
  };
}

function rig({ stallMs = 15 * MIN, cpu = () => 42 } = {}) {
  const f = fakeFs();
  const t0 = Date.UTC(2026, 10, 21, 10, 0, 0);
  f.grow('step.log', 100, t0);
  f.grow('client.log', 5000, t0 - MIN); // earlier steps' output: not this step's growth
  const lines = [];
  const hb = startHeartbeat({ label: 't4-crash on shard s2', stepLog: 'step.log', log: (l) => lines.push(l), stallMs, now: () => t0, startedMs: t0,
    sources: () => [{ label: 'client/server stdout', file: 'client.log' }, { label: 'latest.log', file: 'latest.log' }], cpu, fsImpl: f, autoStart: false });
  return { f, t0, lines, hb };
}

test('a beat names the step and shard, the elapsed time, the step log\'s last growth, each source\'s mtime and growth, and the CPU', () => {
  const { f, t0, lines, hb } = rig();
  f.grow('step.log', 10, t0 + MIN);
  f.grow('client.log', 2048, t0 + 2 * MIN);
  hb.tick(t0 + 3 * MIN);
  assert.equal(lines.length, 1);
  const l = lines[0];
  assert.match(l, /^ {2}heartbeat t4-crash on shard s2: 3m00s elapsed; step log last grew at 10:03:00/);
  assert.match(l, /client\/server stdout mtime 10:02:00 \+2 KiB/);
  assert.doesNotMatch(l, /latest\.log/, 'a missing source is skipped silently');
  assert.match(l, /cpu 42%$/);
  assert.doesNotMatch(l, /^\s*(ok|FAIL)\b/, 'never reads as a driver check line');
});

test('a quiet beat says the step log has not grown; a source that appears later is reported', () => {
  const { f, t0, lines, hb } = rig({ cpu: () => null });
  f.grow('latest.log', 300, t0 + 2 * MIN);
  hb.tick(t0 + 3 * MIN);
  assert.match(lines[0], /step log last grew never since the start \(10:00:00\)/);
  assert.match(lines[0], /client\/server stdout mtime 09:59:00 \+0 B/);
  assert.match(lines[0], /latest\.log mtime 10:02:00 \+300 B/);
  assert.doesNotMatch(lines[0], /cpu/, 'no CPU figure: left out');
});

test('"possibly stalled" after 15 min with no growth anywhere; once per quiet stretch; growth re-arms it', () => {
  const { f, t0, lines, hb } = rig();
  hb.tick(t0 + 3 * MIN);
  hb.tick(t0 + 12 * MIN);
  assert.ok(lines.every((l) => !/possibly stalled/.test(l)), 'not before 15 min');
  hb.tick(t0 + 15 * MIN);
  assert.match(lines.at(-1), /possibly stalled: no growth in the step, client or server logs for 15m00s \(a log flag only: nothing is killed\)/);
  hb.tick(t0 + 18 * MIN);
  assert.doesNotMatch(lines.at(-1), /possibly stalled/, 'flagged once per stretch');
  f.grow('latest.log', 1, t0 + 19 * MIN); // the server still logs: alive
  hb.tick(t0 + 21 * MIN);
  hb.tick(t0 + 33 * MIN);
  assert.ok(lines.slice(-2).every((l) => !/possibly stalled/.test(l)), 'growth at 21 min resets the quiet clock');
  hb.tick(t0 + 36 * MIN);
  assert.match(lines.at(-1), /possibly stalled: .* for 15m00s/, 're-armed after the growth');
});

test('growth in any one source (the step log, the stdout, latest.log) keeps the flag off', () => {
  for (const file of ['step.log', 'client.log', 'latest.log']) {
    const { f, t0, lines, hb } = rig();
    for (let m = 3; m <= 30; m += 3) {
      f.grow(file, 1, t0 + m * MIN - 1000);
      hb.tick(t0 + m * MIN);
    }
    assert.ok(lines.every((l) => !/possibly stalled/.test(l)), `${file} grew every beat`);
  }
});

test('stallMs 0 turns the flag off; a throwing cpu() is left out', () => {
  const { t0, lines, hb } = rig({ stallMs: 0, cpu: () => { throw new Error('ps'); } });
  hb.tick(t0 + 60 * MIN);
  assert.doesNotMatch(lines[0], /possibly stalled|cpu/);
});

test('the real timer: beats while the step runs, none after stop(); unref\'d so it never holds the process open', async () => {
  const dir = archTmpDir('gate-hb');
  const log = path.join(dir, 'step.log');
  fs.writeFileSync(log, '');
  const lines = [];
  const hb = startHeartbeat({ label: 'x on shard s1', stepLog: log, log: (l) => lines.push(l), intervalMs: 30, stallMs: 60 });
  assert.equal(hb.timer.hasRef(), false);
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(lines.length >= 3, `beats while running (${lines.length})`);
  assert.ok(lines.some((l) => /possibly stalled/.test(l)), 'the flag fires on no growth');
  hb.stop();
  const n = lines.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(lines.length, n, 'no beat after the step ended');
  assert.equal(hb.tick(), null, 'a stopped heartbeat logs nothing');
  removeArchTmp(dir);
});

test('sumCpu sums the step group and the run-dir pids, once each; null when none', () => {
  const ps = ' 100   100  12.5 node driver.mjs\n 101   100   3.0 node child\n 200   200  80.0 java client\n 300   300  99.0 other\n';
  assert.equal(sumCpu(ps, { pgid: 100, pids: [200, 101] }), 95.5);
  assert.equal(sumCpu(ps, { pgid: 999 }), null);
});

test('gate-run.mjs starts a heartbeat per step in runProcess, logs it to runner.log and stops it on exit and on a spawn error', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'gate-run.mjs'), 'utf8');
  assert.match(src, /import \{ startHeartbeat, sumCpu \} from '\.\/lib\/heartbeat\.mjs';/);
  const i = src.indexOf('function runProcess(');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.match(body, /const hb = startHeartbeat\(\{[\s\S]*?stepLog: logFile, log: \(m\) => log\(m, sh\)/);
  assert.match(body, /GATE_HEARTBEAT_MS \?\? 180_000/);
  assert.match(body, /GATE_HEARTBEAT_STALL_MIN \?\? 15/);
  assert.match(body, /'mod', 'run', 'logs', 'latest\.log'/);
  const onErr = body.slice(body.indexOf("child.on('error'"), body.indexOf("child.on('exit'"));
  const onExit = body.slice(body.indexOf("child.on('exit'"));
  assert.match(onErr, /hb\.stop\(\);/, 'stopped on a spawn error');
  assert.match(onExit, /hb\.stop\(\);/, 'stopped at the step end');
});
