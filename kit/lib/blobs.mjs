// Blobs in a job's scratch dir (docs/CONTRACT.md "Jobs (R2)"): the sidecar copies each blob a
// JobSpec lists into `./blobs/<id>.<ext>` (`.json` for a JSON blob, the upload's ext or `.bin` for
// binary). Kit programs read them from there, e.g. a site survey:
//
//   import { readBlob } from '../lib/blobs.mjs';
//   const survey = readBlob('b1a2b3c4d5e6f7a8');   // parsed JSON
//
// Plain ESM, no dependencies.
import fs from 'node:fs';
import path from 'node:path';

const BLOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The blobs in `dir` (default `./blobs`): [{ id, ext, file }], sorted by id. */
export function listBlobs(dir = 'blobs') {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((f) => /^([A-Za-z0-9_-]{1,64})\.([a-z0-9]{1,8})$/.exec(f))
    .filter(Boolean)
    .map((m) => ({ id: m[1], ext: m[2], file: path.join(dir, m[0]) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The file of blob `id` in `dir` (default `./blobs`); throws when it is not there. */
export function blobPath(id, dir = 'blobs') {
  if (typeof id !== 'string' || !BLOB_ID.test(id)) throw new Error(`not a blob id: ${JSON.stringify(id)}`);
  const hit = listBlobs(dir).find((b) => b.id === id);
  if (!hit) throw new Error(`no blob ${id} in ${path.resolve(dir)} (list it in the job's blobs)`);
  return hit.file;
}

/** Blob `id`: parsed JSON for a `.json` blob, else a Buffer. */
export function readBlob(id, { dir = 'blobs' } = {}) {
  const file = blobPath(id, dir);
  const buf = fs.readFileSync(file);
  return file.endsWith('.json') ? JSON.parse(buf.toString('utf8')) : buf;
}

/** Blob `id` parsed as JSON, whatever its extension (a JSON blob uploaded as chunks). */
export function readBlobJson(id, { dir = 'blobs' } = {}) {
  return JSON.parse(fs.readFileSync(blobPath(id, dir), 'utf8'));
}
