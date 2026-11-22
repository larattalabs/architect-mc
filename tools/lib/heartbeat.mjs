// A running step's heartbeat (docs/GATES.md "For agents: launch, then wait once"): tools/gate-run.mjs logs one line per step every
// GATE_HEARTBEAT_MS (3 min) to runner.log, so a quiet step can be told from a hung one.
//
// 2026-11: t4-crash ran 26 minutes with no output and two stall checks took it for a hang; PLR2's xr-crash had a driver wait that sat
// silent for 40 minutes and really was one. Both looked the same in runner.log. Each beat now says how long the step has run, when its
// own log last grew, and for every liveness source (the client/server script's stdout, Minecraft's mod/run/logs/latest.log) its mtime
// and how much it grew since the last beat, plus the CPU% of the step's processes when that is known.
//
// "possibly stalled" is a log flag only: when no source (the step's log included) has grown for `stallMs` (15 min) the beat says so,
// once per quiet stretch (it re-arms when anything grows). It never kills or fails anything: the step keeps its timeout and the
// stalled-after-a-FAIL kill (stall-watch.mjs). The heartbeat writes only through `log` (runner.log), never into a watched file, so it
// can't count as growth or reset the stall-after-FAIL clock.

import fs from 'node:fs';

const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19);
const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
    : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
const kib = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KiB` : `${n} B`);

/**
 * The heartbeat for one running step.
 *   label      what the line names ("t4-crash on shard s2")
 *   stepLog    the step's own log file (its last growth is "last activity")
 *   sources()  -> [{ label, file }]: other liveness files (missing ones are skipped silently)
 *   cpu()      -> a number (summed %CPU of the step's processes) or null (left out)
 *   log(line)  where the beat goes (gate-run: runner.log)
 *   intervalMs, stallMs (0: no flag), now (the clock), startedMs, fsImpl
 * -> { stop(), tick(at), timer }. The interval is unref'd: it never holds the process open; stop() clears it (gate-run calls it on the
 * step's exit and on a spawn error). tick(at) runs one beat by hand (the unit test's fake clock).
 */
export function startHeartbeat({ label, stepLog, sources = () => [], cpu = () => null, log, intervalMs = 180_000, stallMs = 15 * 60_000,
  now = Date.now, startedMs = now(), fsImpl = fs, autoStart = true } = {}) {
  const prev = new Map(); // file -> size at the last beat (or at the start)
  const stat = (f) => {
    try {
      const s = fsImpl.statSync(f);
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  };
  const all = () => [{ label: 'step', file: stepLog }, ...(sources() ?? [])].filter((s) => s?.file);
  for (const s of all()) prev.set(s.file, stat(s.file)?.size ?? 0);
  let lastGrowth = startedMs;
  let stepGrewAt = null;
  let flagged = false;
  let stopped = false;

  const tick = (at = now()) => {
    if (stopped) return null;
    const parts = [];
    let grew = false;
    for (const s of all()) {
      const st = stat(s.file);
      if (!st) continue;
      const before = prev.get(s.file) ?? 0;
      const delta = st.size - before; // < 0: rotated or truncated, which is activity too
      prev.set(s.file, st.size);
      if (delta !== 0) {
        grew = true;
        if (s.label === 'step') stepGrewAt = at;
      }
      if (s.label !== 'step') parts.push(`${s.label} mtime ${hhmmss(st.mtimeMs)} ${delta >= 0 ? '+' : ''}${kib(delta < 0 ? 0 : delta)}${delta < 0 ? ' (rotated)' : ''}`);
    }
    if (grew) {
      lastGrowth = at;
      flagged = false;
    }
    let c = null;
    try {
      c = cpu();
    } catch {
      c = null;
    }
    const quietMs = at - lastGrowth;
    let line = `  heartbeat ${label}: ${dur(at - startedMs)} elapsed; step log last grew ${stepGrewAt === null ? `never since the start (${hhmmss(startedMs)})` : `at ${hhmmss(stepGrewAt)}`}`;
    if (parts.length) line += `; ${parts.join(', ')}`;
    if (Number.isFinite(c)) line += `; cpu ${c.toFixed(0)}%`;
    if (stallMs > 0 && quietMs >= stallMs && !flagged) {
      flagged = true;
      line += `; possibly stalled: no growth in the step, client or server logs for ${dur(quietMs)} (a log flag only: nothing is killed)`;
    }
    log(line);
    return line;
  };

  const timer = autoStart ? setInterval(() => tick(), intervalMs) : null;
  timer?.unref();
  return {
    tick,
    timer,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}

/** Sums %CPU from `ps -o pid=,pgid=,%cpu=,command=` output for the processes in group `pgid` or whose pid is in `pids`. null: none. */
export function sumCpu(psOut, { pgid, pids = [] } = {}) {
  const want = new Set(pids.map(Number));
  let total = 0;
  let seen = 0;
  for (const l of String(psOut ?? '').split('\n')) {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)/);
    if (!m) continue;
    const [pid, g, pc] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (g === pgid || want.has(pid)) {
      total += pc;
      seen++;
    }
  }
  return seen ? total : null;
}
