// (5b) The critic hash (docs/CONTRACT.md "Lineage and staleness": critique.json format 2 records `criticHash`, the hash
// of the critic system prompt, template and schema). They all live in sidecar/src/critic.ts, so the hash is exactly what
// the 5a eval harness recorded as `provenance.hashes.critic`: sha256 of the path "sidecar/src/critic.ts" followed by the
// file's bytes. That keeps a verdict made by 5a's critic reusable while critic.ts is unchanged (tools/eval.mjs
// import-round0 compares it with the 5a run's provenance). The bundle (dist/main.mjs) has no critic.ts next to it:
// scripts/build.mjs computes the hash at build time and defines __ARCHITECT_CRITIC_HASH__; under tsx/vitest it is read
// from the source.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __ARCHITECT_CRITIC_HASH__: string | undefined;

/** sha256("sidecar/src/critic.ts" + the file's bytes), as tools/eval.mjs provenance() computes it. */
export function criticHashOfFile(file: string): string {
  return crypto.createHash('sha256').update('sidecar/src/critic.ts').update(fs.readFileSync(file)).digest('hex');
}

let cached: string | undefined;

export function criticHash(): string {
  if (cached) return cached;
  if (typeof __ARCHITECT_CRITIC_HASH__ === 'string' && __ARCHITECT_CRITIC_HASH__) return (cached = __ARCHITECT_CRITIC_HASH__);
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'critic.ts');
  cached = fs.existsSync(file) ? criticHashOfFile(file) : 'unknown';
  return cached;
}
