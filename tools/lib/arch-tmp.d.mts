export const PREFIX: string;
export const OWNER_FILE: string;
export const PROCESS_START_MS: number;
export function removeArchTmp(dir: string): void;
export function cleanupArchTmp(): void;
export function ownerRecord(pid?: number, startMs?: number): { pid: number; startMs: number; createdAt: string };
export function archTmpDir(name?: string, opts?: { root?: string; marker?: boolean }): string;
export function liveArchTmp(): string[];
