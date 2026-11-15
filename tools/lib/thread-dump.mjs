// (slice GT) A thread dump of the shard's server JVM when a step's DevBridge request timed out client side (`dev.wait timed out after
// 30000ms (client side)`), a step TIMEOUT or a stall: taken by the runner before it stops the client, so a hang leaves the server's
// threads (the server thread, the IO workers, a region file force) in the step's evidence (traces/<step>/threads-<pid>.txt). On macOS
// the power log's sleep and wake lines over the step are kept beside it (host-sleep.txt): a lid closed mid-step stops every process,
// and on waking each client-side timer fires at once, which reads like a server hang (batch 3's ps-crash, 2026-11-15: the Mac slept
// 538 s from 07:08:14, exactly the "9 minutes of silence" after SD0's restart).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** A DevBridge request that timed out on the client side, as devclient.mjs words it: {type, ms} of the first, or null. */
export function clientTimeout(text) {
  const m = /\b(dev\.[\w.]+) timed out after (\d+)ms \(client side\)/.exec(String(text ?? ''));
  return m ? { type: m[1], ms: Number(m[2]) } : null;
}

/** Why a step's server threads are worth a dump: a client-side DevBridge timeout in its log, a step TIMEOUT or a stall; else null. */
export function dumpReason({ text, timedOut = false, stalled = false } = {}) {
  const t = clientTimeout(text);
  if (t) return `${t.type} timed out after ${t.ms} ms (client side)`;
  if (timedOut) return 'the step timed out';
  if (stalled) return 'the step stalled after a FAIL';
  return null;
}

/** jcmd from JAVA_HOME (the build's JDK), else Homebrew's openjdk@25, else the PATH's; jstack beside it as the fallback. */
export function jdkTools(env = process.env, exists = fs.existsSync) {
  for (const home of [env.JAVA_HOME, '/opt/homebrew/opt/openjdk@25']) {
    if (home && exists(path.join(home, 'bin', 'jcmd'))) return { jcmd: path.join(home, 'bin', 'jcmd'), jstack: path.join(home, 'bin', 'jstack') };
  }
  return { jcmd: 'jcmd', jstack: 'jstack' };
}

/**
 * The tools' own environment: without JAVA_TOOL_OPTIONS, which the runner gives the game JVMs (the class-load log into the coverage
 * dir, the JaCoCo agent): jcmd and jstack are JVMs too, and would write their own coverage files and print "Picked up ..." into the dump.
 */
export function toolEnv(env = process.env) {
  const out = { ...env };
  delete out.JAVA_TOOL_OPTIONS;
  delete out.JDK_JAVA_OPTIONS;
  delete out._JAVA_OPTIONS;
  return out;
}

/**
 * Dumps each pid's threads into dir/threads-<pid>.txt: `jcmd <pid> Thread.print -l`, else `jstack -l <pid>`. Bounded (timeoutMs per
 * tool), never throws: each pid's result says which tool worked or why none did. `run` is spawnSync's shape (injected by the tests).
 */
export function captureThreadDumps({ pids, dir, reason = '', env = process.env, run = spawnSync, now = () => new Date(), timeoutMs = 30_000, exists = fs.existsSync }) {
  fs.mkdirSync(dir, { recursive: true });
  const tools = jdkTools(env, exists);
  const out = [];
  for (const pid of pids ?? []) {
    const file = path.join(dir, `threads-${pid}.txt`);
    const tries = [[tools.jcmd, [String(pid), 'Thread.print', '-l']], [tools.jstack, ['-l', String(pid)]]];
    const errors = [];
    let done = null;
    for (const [cmd, args] of tries) {
      const t0 = Date.now();
      const r = run(cmd, args, { encoding: 'utf8', timeout: timeoutMs, env: toolEnv(env), maxBuffer: 64 * 1024 * 1024 });
      const ms = Date.now() - t0;
      const stdout = String(r?.stdout ?? '');
      if (r && !r.error && r.status === 0 && stdout.trim()) {
        done = { tool: path.basename(cmd), ms, text: stdout };
        break;
      }
      errors.push(`${path.basename(cmd)}: ${r?.error ? r.error.message : `exit ${r?.status ?? '?'}${r?.signal ? ` ${r.signal}` : ''}`}${String(r?.stderr ?? '').trim() ? ` (${String(r.stderr).trim().slice(0, 300)})` : ''}`);
    }
    const head = `# ${now().toISOString()} thread dump of pid ${pid}${reason ? `: ${reason}` : ''}\n`;
    if (done) {
      fs.writeFileSync(file, `${head}# ${done.tool}, ${done.ms} ms\n${done.text}`);
      out.push({ pid, file, ok: true, tool: done.tool, ms: done.ms, threads: (done.text.match(/^"/gm) ?? []).length });
    } else {
      fs.writeFileSync(file, `${head}# no dump: ${errors.join('; ')}\n`);
      out.push({ pid, file, ok: false, error: errors.join('; ') });
    }
  }
  return out;
}

/**
 * (macOS) The power log's sleep and wake lines between `from` and `to` (Date), written to dir/host-sleep.txt when there are any.
 * Returns {file, lines, sleptSeconds} (the summed "Entering Sleep ... N secs" durations), or null off macOS, with no lines, or when
 * pmset fails.
 */
export function hostSleep({ from, to, dir, run = spawnSync, platform = process.platform }) {
  if (platform !== 'darwin') return null;
  const r = run('pmset', ['-g', 'log'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 * 1024 });
  if (!r || r.error || r.status !== 0) return null;
  const lines = sleepLines(String(r.stdout ?? ''), from, to);
  if (!lines.length) return null;
  const sleptSeconds = lines.reduce((a, l) => a + Number(/\bEntering Sleep state\b.*?(\d+) secs\s*$/.exec(l)?.[1] ?? 0), 0);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'host-sleep.txt');
  fs.writeFileSync(file, `# pmset -g log, ${from.toISOString()} .. ${to.toISOString()}: sleep and wake lines (slept ${sleptSeconds} s)\n${lines.join('\n')}\n`);
  return { file, lines: lines.length, sleptSeconds };
}

/** The pure part: `pmset -g log` lines ("2026-11-15 07:08:14 -0700 Sleep ...") in [from, to] whose event is a sleep or a wake. */
export function sleepLines(text, from, to) {
  const out = [];
  for (const l of String(text).split('\n')) {
    const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)\s+(Sleep|Wake|DarkWake)\b/.exec(l);
    if (!m) continue;
    const t = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
    if (Number.isFinite(t) && t >= from.getTime() && t <= to.getTime()) out.push(l.trimEnd());
  }
  return out;
}
