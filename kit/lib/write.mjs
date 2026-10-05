// Writes <id>.nbt (gzipped vanilla structure template) + <id>.blueprint.json (sidecar).
import fs from 'node:fs';
import path from 'node:path';
import { encodeGzip } from './nbt.mjs';

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
  fs.writeFileSync(jsonPath, `${JSON.stringify(bp.sidecar(), null, 2)}\n`);
  return { nbtPath, jsonPath, blocks: bp.cells.size, bytes: bytes.length };
}
