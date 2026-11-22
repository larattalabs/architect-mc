// (slice T4R-D narrowing round, P2-4) A second crash armed for a world's start (dev-start.json's killAt) counts only when it happened:
//   - the open was refused (the headless host has no server: run6b.openWorld's fail-fast), not timed out and not opened;
//   - the host shows no server now;
//   - the recovery it interrupted is still open on disk (txn.json lists the txn kind open or retiring).
// Anything else is a FAIL (down false, with why). Tested in kit/test/t4rd-2crash.test.mjs.
import fs from 'node:fs';

/** Whether `<world>/architect/txn.json` at `file` lists an open (or retiring) txn of `kind`; false when absent or unreadable. */
export function txnOpenOnDisk(file, kind) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  return [...(j.open ?? []), ...(j.retiring ?? [])].some((t) => t && t.kind === kind);
}

/**
 * `open()`: the world's open (rejects when the start halted); `sleep(ms)`: the bound; `serverGone()`: the host shows no server;
 * `txnOpen()`: the interrupted recovery's txn is still open on disk. -> {down, why}.
 */
export async function secondCrash({ open, sleep, serverGone, txnOpen, boundMs }) {
  const r = await Promise.race([
    Promise.resolve().then(open).then(() => 'opened', (e) => `refused: ${e?.message ?? e}`),
    Promise.resolve().then(() => sleep(boundMs)).then(() => 'timeout'),
  ]);
  if (r === 'timeout') return { down: false, why: `timed out after ${Math.round(boundMs / 1000)} s: the start neither opened nor halted` };
  if (r === 'opened') return { down: false, why: 'the world opened: no second crash (its recovery ran to the end)' };
  if (!(await serverGone())) return { down: false, why: `the open was ${r}, but the host still shows a server` };
  if (!txnOpen()) return { down: false, why: `the open was ${r} and no server is left, but txn.json has no open txn of the interrupted recovery` };
  return { down: true, why: r };
}
