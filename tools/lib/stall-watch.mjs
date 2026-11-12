// A step that stalls after a failure (docs/GATES.md "Stalled after a FAIL"): tools/gate-run.mjs ends it instead of waiting for its timeout.
//
// 2026-11-12: st-ingame printed `FAIL cliff_east sampled to its own sha undefined` at 05:54:11 and then waited in a ten-minute `until()` for a
// variant that could not come. The runner only acts on a step's exit or its timeout (45 min there), so the dev client sat idle in its world, the
// step's end went unrecorded and the slot stayed taken until someone sent the runner SIGTERM at 06:02. A driver that has printed a functional
// FAIL and then prints nothing at all for `idleMs` is stuck: the runner kills its process group, the step ends FAIL (its error says why) and the
// usual failed-step path stops the shard's client by PID; the next step starts fresh or the run finishes.
//
// Only a functional failure arms it: a driver's own check line (`FAIL ...` at the start of a line, the runner's FAIL_RE), not a test runner's
// indented ` FAIL  file > test` (vitest keeps printing after one) and not a `FAIL BAR` line where the tier records timing bars (that step can
// still pass, and its driver goes on). Any output at all resets the idle clock: a driver still printing after a failure is not stuck.

const FAIL_RE = /^(?:\[\d\d:\d\d:\d\d\] )?FAIL\b/;
const BAR_FAIL_RE = /^(?:\[\d\d:\d\d:\d\d\] )?FAIL\s+BAR\b/;

/** Whether one log line is a functional failure. barsRecorded: the tier records timing bars (a `FAIL BAR` line doesn't fail the step). */
export function isFunctionalFail(line, { barsRecorded = false } = {}) {
  if (!FAIL_RE.test(line)) return false;
  return !(barsRecorded && BAR_FAIL_RE.test(line));
}

/**
 * The watch for one step. idleMs: how long a step may print nothing after its first functional FAIL (0 or less: off). now: the clock.
 * feed(text, at) takes new log output (a chunk, any split); check(at) -> null, or { failLine, failAt, idleMs } once the step has been silent
 * for idleMs since its last output and a functional FAIL has been seen.
 */
export function stallWatch({ idleMs, barsRecorded = false, now = Date.now() } = {}) {
  let lastOutput = now;
  let fail = null;
  let partial = '';
  return {
    feed(text, at = Date.now()) {
      if (!text) return;
      lastOutput = at;
      const lines = (partial + text).split('\n');
      partial = lines.pop();
      if (!fail) {
        const hit = lines.find((l) => isFunctionalFail(l, { barsRecorded }));
        if (hit) fail = { line: hit, at };
      }
    },
    check(at = Date.now()) {
      if (!(idleMs > 0)) return null;
      // a FAIL line still being written (no newline yet) counts once it is complete or the step goes silent with it
      if (!fail && partial && isFunctionalFail(partial, { barsRecorded })) fail = { line: partial, at: lastOutput };
      if (!fail || at - lastOutput < idleMs) return null;
      return { failLine: fail.line.slice(0, 300), failAt: fail.at, idleMs: at - lastOutput };
    },
    get failSeen() {
      return !!fail;
    },
  };
}

/** The idle limit in minutes for a step: its chain entry's `stallAfterFailMin`, else the config's top-level one, else 5. 0/false: off. */
export function stallMinutes(step, cfg) {
  const v = step.stallAfterFailMin ?? cfg.stallAfterFailMin ?? 5;
  return v === false ? 0 : Number(v) || 0;
}
