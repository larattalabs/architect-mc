// (gate speed 3, 2026-10-22; docs/GATES.md "Sprinted game-time waits") A wait for game time to pass, run as fast as the server
// can tick: `/tick sprint <n>`, then the game time polled until it has advanced n ticks. It replaces a fixed real-time wait
// (dev.wait {ms} and sleep are wall time on the client and on the headless host alike) only where the driver waits for ticks:
// a stand, a fluid settle, hydration, growth, random-tick probes. Never for a timeout, a wall-clock rule, a bench or a client.
//
// ONE switch: GATE_SPRINT=0 makes every gameWait the exact original real-time wait (the `real` function the call site passes).
// Default on. A client host (not headless) always waits in real time. The real-time safety cap: if the game time has not
// advanced n ticks within max(60 s, ms) of wall time (a frozen or paused server, a stuck sprint), the sprint is stopped and the
// remaining ticks are waited in real time, logged.
//
// Every gameWait logs one line "  (sprint) <label>: ..." (never an ok/FAIL/rec line): the mode, the ticks asked and seen, the
// wall time, so a run shows where the switch held and what each wait cost.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const sprintOn = () => (process.env.GATE_SPRINT ?? '1').trim() !== '0';

/** The overworld's game time (`/time query gametime`), or null when it can't be read. */
export async function gameTime(cmd) {
  const r = await cmd('/time query gametime');
  const m = /(-?\d+)/.exec((r?.messages ?? []).join(' '));
  if (m) return Number(m[1]);
  const n = Number(r?.result);
  return Number.isFinite(n) ? n : null;
}

/** Whether the DevBridge host is the headless server (dev.ping's `headless`); a client host never sprints. */
export async function isHeadless(call) {
  const p = await call('dev.ping', {}, 10_000).catch(() => null);
  return p?.headless === true;
}

/**
 * Advance the game `n` ticks with `/tick sprint n` and wait until the game time has moved n ticks, at most `timeoutMs` of wall
 * time (then the sprint is stopped). -> {ok, ticks (seen), wallMs, t0 (game time before)}.
 */
export async function advanceTicks({ cmd }, n, { timeoutMs = Math.max(60_000, n * 50), pollMs = 200 } = {}) {
  const w0 = Date.now();
  const t0 = await gameTime(cmd);
  if (t0 === null) return { ok: false, ticks: 0, wallMs: 0, t0, why: 'no game time' };
  let t = t0;
  let done = false;
  try {
    await cmd(`/tick sprint ${n}`);
    while (Date.now() - w0 < timeoutMs) {
      await sleep(pollMs);
      const g = await gameTime(cmd);
      if (g !== null) t = g;
      if (t - t0 >= n) { done = true; break; }
    }
  } finally {
    // (a sprint ends by itself after n ticks; stopped here only when the wait gave up or threw)
    if (!done) await cmd('/tick sprint stop').catch(() => null);
  }
  return { ok: done, ticks: t - t0, wallMs: Date.now() - w0, t0, ...(done ? {} : { why: `timeout ${timeoutMs} ms` }) };
}

/**
 * Wait `ms` of game time (ms / 50 ticks). `real(ms)` is the call site's original wait (L.settle or sleep): GATE_SPRINT=0, a
 * client host or `sprint: false` run it unchanged. -> {mode: 'sprint'|'real'|'sprint+real', ticks, wallMs, gameMs}.
 */
export async function gameWait(io, ms, real, { label = '', sprint = true, capMs } = {}) {
  const { call, cmd, log } = io;
  const say = (s) => (log ?? console.log)(`  (sprint) ${label || `${ms / 1000} s`}: ${s}`);
  const w0 = Date.now();
  if (!sprintOn() || !sprint || !(await isHeadless(call))) {
    await real(ms);
    const why = !sprintOn() ? 'GATE_SPRINT=0' : !sprint ? 'kept in real time' : 'not headless';
    say(`real time ${ms / 1000} s (${why}), ${((Date.now() - w0) / 1000).toFixed(1)} s`);
    return { mode: 'real', ticks: null, wallMs: Date.now() - w0, gameMs: ms };
  }
  const n = Math.max(1, Math.round(ms / 50));
  const r = await advanceTicks(io, n, capMs ? { timeoutMs: capMs, pollMs: Math.min(200, capMs / 4) } : {});
  if (r.ok) {
    say(`${n} ticks (${ms / 1000} s) sprinted, ${r.ticks} seen, ${(r.wallMs / 1000).toFixed(1)} s`);
    return { mode: 'sprint', ticks: r.ticks, wallMs: r.wallMs, gameMs: ms };
  }
  const left = Math.max(0, ms - Math.max(0, r.ticks) * 50);
  say(`SPRINT INCOMPLETE (${r.why}): ${r.ticks} of ${n} ticks in ${(r.wallMs / 1000).toFixed(1)} s; the remaining ${left / 1000} s in real time`);
  if (left > 0) await real(left);
  return { mode: 'sprint+real', ticks: r.ticks, wallMs: Date.now() - w0, gameMs: ms };
}
