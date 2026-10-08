// Writes <id>.nbt (gzipped vanilla structure template) + <id>.blueprint.json (sidecar) + (phase 5b) <id>.parts.nbt.
import fs from 'node:fs';
import path from 'node:path';
import { encodeGzip, nbt } from './nbt.mjs';

/** Phase 5b: `<id>.parts.nbt`, gzip NBT `{ names: list<string>, idx: int[] }` (docs/HANDOFF-5b.md "Pinned formats"). */
export function encodePartMap(map) {
  return encodeGzip(nbt.compound({ names: nbt.list('string', map.names.map((n) => nbt.str(n))), idx: nbt.intArray(map.idx) }));
}

/** The sidecar fields only the mod writes (favourite, tags, rename). */
export const USER_FIELDS = ['favorite', 'userTags', 'displayName'];

/**
 * @param {import('./kit.mjs').Blueprint} bp
 * @param {string} dir where both files go
 * @returns {{nbtPath:string, jsonPath:string, partsPath:string, blocks:number, bytes:number}}
 */
export function writeBlueprint(bp, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const nbtPath = path.join(dir, `${bp.id}.nbt`);
  const jsonPath = path.join(dir, `${bp.id}.blueprint.json`);
  const bytes = encodeGzip(bp.toStructure());
  fs.writeFileSync(nbtPath, bytes);
  // phase 5b: the per-cell part map, a separate file (vanilla structure loaders keep reading the .nbt unchanged)
  const partsPath = path.join(dir, `${bp.id}.parts.nbt`);
  fs.writeFileSync(partsPath, encodePartMap(bp.partMap()));
  const sidecar = bp.sidecar();
  for (const k of USER_FIELDS) delete sidecar[k];
  // user metadata the mod edits in place (docs/CONTRACT.md "Library entry"): a build never writes it, a rebuild keeps it
  let old = null;
  try { old = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { /* no previous sidecar */ }
  if (old && typeof old === 'object') for (const k of USER_FIELDS) if (old[k] !== undefined) sidecar[k] = old[k];
  // ext (R5): other mods' namespaced data, set on the entry by the mod (Library.setExt); a rebuild keeps it, on top of the design's own
  const ext = { ...(sidecar.ext ?? {}), ...(old && typeof old.ext === 'object' && old.ext ? old.ext : {}) };
  if (Object.keys(ext).length) sidecar.ext = ext;
  else delete sidecar.ext;
  fs.writeFileSync(jsonPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  return { nbtPath, jsonPath, partsPath, blocks: bp.cells.size, bytes: bytes.length };
}
