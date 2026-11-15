// Temp-dir hygiene (slice TS, docs/GATES.md "Slice TS as built"). Every temp dir Architect's tests, runners and tools make is a
// direct child of the temp root (the RAM disk's tmp/ or os.tmpdir()) named `arch-<name>-XXXXXX`, carries an owner marker (`.arch-owner`: the creator's pid and start
// time) and is removed when the creating process exits (normal exit, SIGINT, SIGTERM, SIGHUP). A killed run (SIGKILL) can't clean
// up: tools/tmp-sweep.mjs removes what it left, and skips any dir whose owner is still alive.
//
// The default root is the RAM disk's tmp/ when usable (tools/lib/ram-tmp.mjs; ARCH_NO_RAMDISK=1 off), else os.tmpdir().
// ARCH_KEEP_TMP=1 keeps the dirs (for debugging a failure); the sweep removes them later by age.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ramTmpDir, explainEnospc } from './ram-tmp.mjs';

export const PREFIX = 'arch-';
export const OWNER_FILE = '.arch-owner';
/** This process's start time (epoch ms). The sweep compares it with the live process's start, so a reused pid doesn't count. */
export const PROCESS_START_MS = Math.round(performance.timeOrigin);

const live = new Set();
let hooked = false;

const keep = () => process.env.ARCH_KEEP_TMP === '1';

/** Remove one dir (never throws). */
export function removeArchTmp(dir) {
  live.delete(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // best effort: the sweep gets what's left
  }
}

/** Remove every dir this process made (the exit hook; tests may call it from afterAll). */
export function cleanupArchTmp() {
  if (keep()) return;
  for (const d of [...live]) removeArchTmp(d);
}

function onSignal(sig) {
  cleanupArchTmp();
  // another listener owns the exit (it calls process.exit, which runs the exit hook again, now a no-op); else die of the signal
  if (process.listenerCount(sig) > 1) return;
  process.removeListener(sig, onSignal);
  process.kill(process.pid, sig);
}

function hook() {
  if (hooked) return;
  hooked = true;
  process.on('exit', cleanupArchTmp);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, onSignal);
}

/** The owner marker's content. */
export const ownerRecord = (pid = process.pid, startMs = PROCESS_START_MS) => ({ pid, startMs, createdAt: new Date().toISOString() });

/**
 * A fresh `arch-<name>-XXXXXX` dir under `root` (default: the RAM disk's tmp/ when usable, else os.tmpdir()), with an owner marker, removed at exit.
 * `{ marker: false }` leaves the marker out for a dir whose listing a caller compares exactly (the sweep then goes by age).
 */
export function archTmpDir(name = 'tmp', { root = ramTmpDir() ?? os.tmpdir(), marker = true } = {}) {
  const base = String(name).replace(/^arch-/, '').replace(/-+$/, '') || 'tmp';
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(root, `${PREFIX}${base}-`));
  } catch (e) {
    throw explainEnospc(e, root); // a full RAM disk names itself and the fix
  }
  if (marker) {
    try {
      fs.writeFileSync(path.join(dir, OWNER_FILE), `${JSON.stringify(ownerRecord())}\n`);
    } catch {
      // a marker is advisory: without one the sweep goes by the longer age
    }
  }
  live.add(dir);
  hook();
  return dir;
}

/** How many dirs this process still holds (tests). */
export const liveArchTmp = () => [...live];
