// <data>/secrets.json (mode 0600): the in-game settings from `auth.set`. Holds the Anthropic API key
// the player typed in, and the useClaudeLogin opt-in. Never logged, never echoed to a client, never
// in state.json. Only this file and the design agent's CLI process (its env) ever see the key.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './util/fsx.js';

export const SECRETS_FILE = 'secrets.json';

export interface Secrets {
  apiKey?: string;
  useClaudeLogin?: boolean;
}

export function secretsPath(dataDir: string): string {
  return path.join(dataDir, SECRETS_FILE);
}

export function readSecrets(dataDir: string): Secrets {
  try {
    const raw = JSON.parse(fs.readFileSync(secretsPath(dataDir), 'utf8')) as Record<string, unknown>;
    const out: Secrets = {};
    if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) out.apiKey = raw.apiKey.trim();
    if (typeof raw.useClaudeLogin === 'boolean') out.useClaudeLogin = raw.useClaudeLogin;
    return out;
  } catch {
    return {};
  }
}

/** Apply an `auth.set` (apiKey: string sets, null clears, undefined keeps) and write the file 0600. */
export function updateSecrets(dataDir: string, patch: { apiKey?: string | null | undefined; useClaudeLogin?: boolean | undefined }): Secrets {
  const s = readSecrets(dataDir);
  if (patch.apiKey === null) delete s.apiKey;
  else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) s.apiKey = patch.apiKey.trim();
  if (typeof patch.useClaudeLogin === 'boolean') s.useClaudeLogin = patch.useClaudeLogin;
  writeFileAtomic(secretsPath(dataDir), `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  return s;
}
