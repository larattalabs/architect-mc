// (slice T4R-D narrowing round, P2-4) A second crash armed for a world's start (dev-start.json's killAt) counts only when it happened:
//   - the open was refused (the headless host has no server: run6b.openWorld's fail-fast), not timed out and not opened;
//   - the host shows no server now;
//   - the recovery it interrupted is still open on disk (txn.json lists the txn kind open or retiring);
//   - (slice T4R-D last round, P2) the start-armed kill left its marker at the intended point: DevStart.markKilled writes
//     <world>/architect/dev-killed.json ({point}) right before the halt, so a start that failed earlier (dev-start.json already consumed)
//     never counts. The gate deletes any old marker before it arms the start.
// Anything else is a FAIL (down false, with why). Tested in kit/test/t4rd-2crash.test.mjs.
import fs from 'node:fs';

/** Whether `<world>/architect/txn.json` at `file` lists an open (or retiring) txn of `kind`; false when absent or unreadable. */
export function txnOpenOnDisk(file, kind) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  return [...(j.open ?? []), ...(j.retiring ?? [])].some((t) => t && t.kind === kind);
}

/** DevStart.KILLED: the file a start-armed kill writes right before its halt. */
export const KILL_MARKER = 'dev-killed.json';

/** The point named by `<arch>/dev-killed.json` (`arch`: the world's architect dir), or null when absent or unreadable. */
export function killMarker(arch) {
  try { return JSON.parse(fs.readFileSync(`${arch}/${KILL_MARKER}`, 'utf8')).point ?? null; } catch { return null; }
}

/**
 * `open()`: the world's open (rejects when the start halted); `sleep(ms)`: the bound; `serverGone()`: the host shows no server;
 * `txnOpen()`: the interrupted recovery's txn is still open on disk; `marker()`: the point the start's kill marker names (or null);
 * `point`: the intended one. -> {down, why}.
 */
export async function secondCrash({ open, sleep, serverGone, txnOpen, marker, point, boundMs }) {
  const r = await Promise.race([
    Promise.resolve().then(open).then(() => 'opened', (e) => `refused: ${e?.message ?? e}`),
    Promise.resolve().then(() => sleep(boundMs)).then(() => 'timeout'),
  ]);
  if (r === 'timeout') return { down: false, why: `timed out after ${Math.round(boundMs / 1000)} s: the start neither opened nor halted` };
  if (r === 'opened') return { down: false, why: 'the world opened: no second crash (its recovery ran to the end)' };
  const m = typeof marker === 'function' ? marker() : null;
  if (!point || m !== point) return { down: false, why: `the open was ${r}, but the kill marker names ${m ?? 'nothing'}, not ${point}: the start never reached its barrier` };
  if (!(await serverGone())) return { down: false, why: `the open was ${r}, but the host still shows a server` };
  if (!txnOpen()) return { down: false, why: `the open was ${r} and no server is left, but txn.json has no open txn of the interrupted recovery` };
  return { down: true, why: r };
}
