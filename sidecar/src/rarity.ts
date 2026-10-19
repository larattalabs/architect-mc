// (6c VOC, S-VOC-1) A bible request's rarity budget (docs/CONTRACT.md "Phase 6c slice VOC" §4.3): checked with the member's schema from
// the kit the sidecar carries (kit/lib/vocab/rarity.mjs validateRarity: the same code validateBible runs), so a malformed budget is refused
// FIELD_LIMIT, naming its path, before any job exists (no round trip). The bible job then copies it by code into the made bible's
// `rarity` (bibles.ts); the prompt is unchanged (N-VOC-1).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RefusedError } from './errors.js';

type Validate = (r: unknown, p?: string) => { errors: string[]; rarity: Record<string, unknown> | null };
const cache = new Map<string, Promise<Validate | null>>();

/** The kit's validateRarity, or null for a kit without rarity budgets. */
function validatorOf(kitDir: string): Promise<Validate | null> {
  let p = cache.get(kitDir);
  if (!p) {
    const f = path.join(kitDir, 'lib', 'vocab', 'rarity.mjs');
    p = fs.existsSync(f) ? import(pathToFileURL(f).href).then((m: { validateRarity?: Validate }) => m.validateRarity ?? null) : Promise.resolve(null);
    cache.set(kitDir, p);
  }
  return p;
}

/** Refuse (FIELD_LIMIT, detail `rarity`) a malformed budget; resolves for a valid one, or for none. */
export async function checkRarity(kitDir: string, rarity: unknown): Promise<void> {
  if (rarity === undefined) return;
  const v = await validatorOf(kitDir);
  if (!v) throw new RefusedError('FIELD_LIMIT', 'rarity', "rarity: this helper's kit has no rarity budgets (kit/lib/vocab/rarity.mjs)");
  const r = v(rarity, 'rarity');
  if (r.errors.length) throw new RefusedError('FIELD_LIMIT', 'rarity', r.errors.slice(0, 4).join('; '));
}
