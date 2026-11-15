// tools/lib/thread-dump.mjs (slice GT): the runner's thread dump of the server JVM after a client-side DevBridge timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { captureThreadDumps, clientTimeout, dumpReason, jdkTools, sleepLines, toolEnv } from '../../tools/lib/thread-dump.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arch-gt-'));

test('the trigger: devclient\'s client-side timeout wording (batch 3\'s ps-crash line), a TIMEOUT, a stall; else none', () => {
  const line = '[14:17:11] DevError: dev.wait timed out after 30000ms (client side)\n    at Timeout._onTimeout (devclient.mjs:141:16)';
  assert.deepEqual(clientTimeout(line), { type: 'dev.wait', ms: 30000 });
  assert.equal(dumpReason({ text: line }), 'dev.wait timed out after 30000 ms (client side)');
  assert.equal(dumpReason({ text: 'dev.crate.insert timed out after 120000ms (client side)' }), 'dev.crate.insert timed out after 120000 ms (client side)');
  assert.equal(dumpReason({ text: '[x] FAIL a check', timedOut: true }), 'the step timed out');
  assert.equal(dumpReason({ text: '[x] FAIL a check', stalled: true }), 'the step stalled after a FAIL');
  assert.equal(dumpReason({ text: '[x] FAIL a check\n1 FAILURE(S)' }), null);
  assert.equal(dumpReason({ text: 'no dev.hello within 5s' }), null);
});

test('jcmd from JAVA_HOME, then Homebrew\'s JDK, then the PATH; the tools run without the game JVMs\' JAVA_TOOL_OPTIONS', () => {
  assert.equal(jdkTools({ JAVA_HOME: '/j' }, (p) => p === '/j/bin/jcmd').jcmd, '/j/bin/jcmd');
  assert.equal(jdkTools({}, (p) => p === '/opt/homebrew/opt/openjdk@25/bin/jcmd').jstack, '/opt/homebrew/opt/openjdk@25/bin/jstack');
  assert.deepEqual(jdkTools({}, () => false), { jcmd: 'jcmd', jstack: 'jstack' });
  const env = toolEnv({ PATH: '/bin', JAVA_TOOL_OPTIONS: '-javaagent:jacoco.jar', JDK_JAVA_OPTIONS: '-X', _JAVA_OPTIONS: '-Y' });
  assert.deepEqual(env, { PATH: '/bin' });
});

test('jcmd first; jstack when jcmd fails; a pid neither can dump is recorded, never thrown', () => {
  const dir = tmp();
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push([path.basename(cmd), args, opts.env.JAVA_TOOL_OPTIONS]);
    if (args.includes('7')) return { status: 0, stdout: '"Server thread" #40 prio=5\n   java.lang.Thread.State: RUNNABLE\n"IO-Worker-1" #41\n' };
    if (args.includes('8') && path.basename(cmd) === 'jstack') return { status: 0, stdout: '"main" #1\n' };
    return { status: 1, stdout: '', stderr: 'AttachNotSupportedException' };
  };
  const out = captureThreadDumps({ pids: [7, 8, 9], dir, reason: 'ps-crash: dev.wait timed out', env: { JAVA_HOME: '/j', JAVA_TOOL_OPTIONS: '-javaagent:x' }, run, exists: () => true, now: () => new Date('2026-11-15T14:17:11Z') });
  assert.deepEqual(out.map((d) => [d.pid, d.ok, d.tool ?? null, d.threads ?? null]), [[7, true, 'jcmd', 2], [8, true, 'jstack', 1], [9, false, null, null]]);
  assert.deepEqual(calls.map((c) => c[0]), ['jcmd', 'jcmd', 'jstack', 'jcmd', 'jstack']);
  assert.deepEqual(calls[0][1], ['7', 'Thread.print', '-l']);
  assert.ok(calls.every((c) => c[2] === undefined), 'no JAVA_TOOL_OPTIONS for the tools');
  const f7 = fs.readFileSync(path.join(dir, 'threads-7.txt'), 'utf8');
  assert.match(f7, /^# 2026-11-15T14:17:11.000Z thread dump of pid 7: ps-crash: dev.wait timed out\n# jcmd, \d+ ms\n"Server thread"/);
  assert.match(fs.readFileSync(path.join(dir, 'threads-9.txt'), 'utf8'), /no dump: jcmd: exit 1 \(AttachNotSupportedException\); jstack: exit 1/);
  assert.match(out[2].error, /jstack: exit 1/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the power log\'s sleep and wake lines over the step (batch 3: the Mac slept 538 s from 07:08:14)', () => {
  const log = [
    '2026-11-15 07:06:01 -0700 Sleep               \tEntering DarkWake state due to \'Clamshell Sleep\'',
    '2026-11-15 07:08:14 -0700 Sleep               \tEntering Sleep state due to \'Clamshell Sleep\':TCPKeepAlive=active Using AC (Charge:80%) 538 secs  ',
    '2026-11-15 07:08:15 -0700 Wake Requests       \t[process=dasd request=SleepService]',
    '2026-11-15 07:10:00 -0700 Assertions          \tPID 427(coreaudiod) Released PreventUserIdleSystemSleep',
    '2026-11-15 07:17:12 -0700 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to rtc/Maintenance 47 secs',
  ].join('\n');
  const got = sleepLines(log, new Date('2026-11-15T14:08:00Z'), new Date('2026-11-15T14:17:12Z'));
  assert.equal(got.length, 3);
  assert.match(got[0], /07:08:14 .*538 secs$/);
  assert.match(got[2], /DarkWake from Deep Idle/);
  assert.equal(sleepLines(log, new Date('2026-11-15T15:00:00Z'), new Date('2026-11-15T16:00:00Z')).length, 0);
});

// the real path: a live JVM dumped by the JDK's own jcmd (skipped without a JDK)
const tools = jdkTools();
const haveJdk = tools.jcmd !== 'jcmd' && fs.existsSync(tools.jcmd) && fs.existsSync(path.join(path.dirname(tools.jcmd), 'java'));
test('a live JVM\'s threads, its main thread among them', { skip: !haveJdk && 'no JDK (JAVA_HOME or openjdk@25)', timeout: 60_000 }, async () => {
  const dir = tmp();
  const src = path.join(dir, 'Hang.java');
  fs.writeFileSync(src, 'public class Hang { public static void main(String[] a) throws Exception { System.out.println("up"); Thread.sleep(60_000); } }\n');
  const java = spawn(path.join(path.dirname(tools.jcmd), 'java'), [src], { env: toolEnv(), stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((res, rej) => {
      java.stdout.on('data', (d) => String(d).includes('up') && res());
      java.on('exit', (c) => rej(new Error(`java exited ${c}`)));
    });
    const [d] = captureThreadDumps({ pids: [java.pid], dir: path.join(dir, 'out'), reason: 'test' });
    assert.equal(d.ok, true, d.error);
    assert.equal(d.tool, 'jcmd');
    const text = fs.readFileSync(d.file, 'utf8');
    assert.match(text, /"main" #\d+/);
    assert.match(text, /Hang\.main/);
  } finally {
    java.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
