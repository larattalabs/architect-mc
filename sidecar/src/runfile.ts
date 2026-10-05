// <data>/sidecar.json: { pid, port, version, startedAt } of the running sidecar, so the mod's
// launcher can reuse one that is already running (docs/CONTRACT.md "Sidecar process"): if the port
// answers `hello` with the same version, reuse it; otherwise stop it if the launcher started it,
// then start its own.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './util/fsx.js';

export const RUN_FILE = 'sidecar.json';

export interface RunInfo {
  pid: number;
  port: number;
  version: string;
  /** epoch ms */
  startedAt: number;
}

export function runFilePath(dataDir: string): string {
  return path.join(dataDir, RUN_FILE);
}

export function writeRunFile(dataDir: string, info: RunInfo): void {
  writeJsonAtomic(runFilePath(dataDir), info);
}

export function readRunFile(dataDir: string): RunInfo | undefined {
  try {
    return readJson<RunInfo>(runFilePath(dataDir));
  } catch {
    return undefined;
  }
}

/** Remove the run file, unless another sidecar wrote it since. */
export function removeRunFile(dataDir: string, pid: number): void {
  const cur = readRunFile(dataDir);
  if (cur && cur.pid !== pid) return;
  fs.rmSync(runFilePath(dataDir), { force: true });
}

/** Is a process with this pid alive? (EPERM: it exists but is not ours.) */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
