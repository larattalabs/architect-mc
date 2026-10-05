// Writes <id>.nbt (gzipped vanilla structure template) + <id>.blueprint.json (sidecar).
import fs from 'node:fs';
import path from 'node:path';
import { encodeGzip } from './nbt.mjs';

/** The sidecar fields only the mod writes (favourite, tags, rename). */
export const USER_FIELDS = ['favorite', 'userTags', 'displayName'];

/**
 * @param {import('./kit.mjs').Blueprint} bp
 * @param {string} dir where both files go
 * @returns {{nbtPath:string, jsonPath:string, blocks:number, bytes:number}}
 */
export function writeBlueprint(bp, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const nbtPath = path.join(dir, `${bp.id}.nbt`);
  const jsonPath = path.join(dir, `${bp.id}.blueprint.json`);
  const bytes = encodeGzip(bp.toStructure());
  fs.writeFileSync(nbtPath, bytes);
  const sidecar = bp.sidecar();
  for (const k of USER_FIELDS) delete sidecar[k];
  // user metadata the mod edits in place (docs/CONTRACT.md "Library entry"): a build never writes it, a rebuild keeps it
  let old = null;
  try { old = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { /* no previous sidecar */ }
  if (old && typeof old === 'object') for (const k of USER_FIELDS) if (old[k] !== undefined) sidecar[k] = old[k];
  fs.writeFileSync(jsonPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  return { nbtPath, jsonPath, blocks: bp.cells.size, bytes: bytes.length };
}
