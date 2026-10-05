// The client token (ported from AgentCraft's foreman/src/clienttoken.ts): which WebSocket clients
// may talk to the sidecar.
//
// Any local process can open ws://127.0.0.1:<port>, including a Bash command the design agent runs.
// `auth.set` changes credentials and `design.request` spends the user's money, so the sidecar writes
// a random token to <data>/client.token (mode 0600, a new one on every start) and a connection must
// send it in `hello` before anything else; every other connection is refused. The mod reads the
// file; the agent policy denies agents the file (policy.ts, foremanPrivateVerdict).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './util/fsx.js';

export const CLIENT_TOKEN_FILE = 'client.token';

export function clientTokenPath(dataDir: string): string {
  return path.join(dataDir, CLIENT_TOKEN_FILE);
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** Write `token` owner-only (0600) to <dataDir>/client.token (temp file + rename, never follows a link). */
export function writeClientToken(dataDir: string, token: string): string {
  const file = clientTokenPath(dataDir);
  writeFileAtomic(file, `${token}\n`, { mode: 0o600 });
  return file;
}

/** Remove the token file, unless it holds another token by now (another sidecar's). */
export function removeClientToken(file: string, token: string): void {
  try {
    if (fs.readFileSync(file, 'utf8').trim() === token) fs.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time token comparison (both sides hashed first, so lengths never leak either). */
export function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || !given) return false;
  return timingSafeEqual(digest(expected), digest(given.trim()));
}
