// The RAM disk for throwaway test data (slice TS, Noah 2026-11-14; docs/GATES.md "Slice TS as built"): /Volumes/MCTmp, a 24 GB
// APFS RAM disk with indexing off, recreated at login by a LaunchAgent (com.laratta.mctmp-ramdisk; never touched from here), its
// contents gone at reboot. When its tmp/ dir exists, is writable and has at least MIN_FREE_BYTES free, Architect's temp dirs go
// there (archTmpDir's default root; the gate runner, eval and run-headless-server also point TMPDIR there for their children);
// otherwise the normal $TMPDIR. ARCH_NO_RAMDISK=1 turns it off. tools/lib/arch-tmp.mjs imports ram-tmp-env.mjs, so every process
// that makes an Architect temp dir (each `node --test` file process, each vitest worker) and its children get TMPDIR there too. A full disk fails loudly (ENOSPC names the disk and the fix).

import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const RAM_DISK = '/Volumes/MCTmp';
export const RAM_TMP = `${RAM_DISK}/tmp`;
export const MIN_FREE_BYTES = 2 * 1024 ** 3;
/** The temp dir this process started with, before useRamTmp (the sweep sweeps it too). */
export const ORIGINAL_TMPDIR = os.tmpdir();

/** The RAM tmp dir's path: ARCH_RAM_TMP overrides it (tests). */
export const ramTmpPath = (env = process.env) => env.ARCH_RAM_TMP || RAM_TMP;

/** The OS's own per-user temp dir (macOS: getconf DARWIN_USER_TEMP_DIR), whatever TMPDIR says; null elsewhere or on failure. */
export function systemTmpDir() {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** Free bytes on the volume holding dir, or null. */
export function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** -> { dir, why }: dir = RAM_TMP when usable, else null with the reason (for a log line). */
export function ramTmpChoice({ env = process.env, dir = ramTmpPath(env), minFree = MIN_FREE_BYTES } = {}) {
  if (env.ARCH_NO_RAMDISK === '1') return { dir: null, why: 'ARCH_NO_RAMDISK=1' };
  try {
    if (!fs.statSync(dir).isDirectory()) return { dir: null, why: `${dir} is not a dir` };
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return { dir: null, why: `no writable ${dir}` };
  }
  const free = freeBytes(dir);
  if (free !== null && free < minFree) {
    const msg = `the RAM disk ${RAM_DISK} has ${(free / 1024 ** 3).toFixed(1)} GB free (under ${(minFree / 1024 ** 3).toFixed(0)} GB): using ${os.tmpdir()} instead; free it with node tools/tmp-sweep.mjs`;
    console.error(`WARNING: ${msg}`);
    return { dir: null, why: msg };
  }
  return { dir, why: null };
}

let cached;
/** The RAM tmp dir when usable (checked once per process), else null. */
export function ramTmpDir() {
  if (cached === undefined) cached = ramTmpChoice().dir;
  return cached;
}

/**
 * Point this process's TMPDIR (and so os.tmpdir() and every child that inherits the env) at the RAM disk when usable.
 * -> the one-line note for the caller's log.
 */
export function useRamTmp(env = process.env) {
  const c = ramTmpChoice({ env });
  if (!c.dir) return `TMPDIR ${os.tmpdir()} (RAM disk not used: ${c.why})`;
  if (env.TMPDIR === c.dir) {
    cached = c.dir;
    return `TMPDIR ${c.dir} (RAM disk, inherited)`;
  }
  env.TMPDIR = c.dir;
  cached = c.dir;
  return `TMPDIR ${c.dir} (RAM disk ${RAM_DISK}, ${((freeBytes(c.dir) ?? 0) / 1024 ** 3).toFixed(1)} GB free)`;
}

/** An Error for an ENOSPC under the RAM disk that names the disk and the fix; any other error unchanged. */
export function explainEnospc(e, where = '') {
  if (e?.code !== 'ENOSPC') return e;
  const p = String(e.path ?? where);
  if (!p.startsWith(RAM_DISK)) return e;
  const out = new Error(`the RAM disk ${RAM_DISK} is full (ENOSPC at ${p}). Free it: node tools/tmp-sweep.mjs (or ARCH_NO_RAMDISK=1 to use $TMPDIR)`);
  out.code = 'ENOSPC';
  out.cause = e;
  return out;
}

/** Install a last-resort handler: an uncaught ENOSPC from the RAM disk is printed with the fix before the process dies. */
export function loudEnospc() {
  process.on('uncaughtExceptionMonitor', (e) => {
    const x = explainEnospc(e);
    if (x !== e) console.error(`FATAL: ${x.message}`);
  });
}
