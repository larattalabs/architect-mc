// Blobs (docs/CONTRACT.md "Jobs (R2)": `blob.put`, `blob.delete`): data a job needs that must not
// go through the model, such as a survey sample, and job results over 256 KB.
//
//   <data>/blobs/<id>        the bytes (a JSON blob is stored as its JSON text)
//   <data>/blobs/<id>.part   an upload still in progress (`more: true` frames)
//   state.json `blobs`       { id, kind, owner?, ext, size, complete, createdAt, updatedAt }
//
// A blob is kept 7 days (or until `blob.delete`); an upload left unfinished for an hour is dropped.
// A job's `blobs: [id]` copies them into its scratch dir as `blobs/<id>.<ext>`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_BLOB_BYTES, MAX_CHUNK_BYTES, type BlobPutMsg } from './protocol.js';
import type { Store } from './store.js';
import type { z } from 'zod';

export const BLOB_TTL_MS = 7 * 24 * 3600_000;
export const UPLOAD_TTL_MS = 3600_000;

export interface BlobMeta {
  id: string;
  kind: string;
  owner?: string;
  /** the file extension in a job scratch dir */
  ext: string;
  size: number;
  /** false while `more: true` frames are still coming */
  complete: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A blob request the client can fix (ack ok:false). */
export class BlobError extends Error {}

type PutMsg = z.infer<typeof BlobPutMsg>;

export class BlobStore {
  readonly dir: string;

  constructor(
    dataDir: string,
    private store: Store,
    private now: () => number = Date.now,
  ) {
    this.dir = path.join(dataDir, 'blobs');
  }

  private get metas(): Record<string, BlobMeta> {
    return (this.store.data.blobs ??= {});
  }

  file(id: string): string {
    return path.join(this.dir, id);
  }

  private partFile(id: string): string {
    return path.join(this.dir, `${id}.part`);
  }

  /** a finished blob, or undefined */
  get(id: string): BlobMeta | undefined {
    const m = this.metas[id];
    return m?.complete && fs.existsSync(this.file(id)) ? { ...m } : undefined;
  }

  read(id: string): Buffer {
    if (!this.get(id)) throw new BlobError(`no blob "${id}"`);
    return fs.readFileSync(this.file(id));
  }

  private newId(): string {
    for (;;) {
      const id = `b${crypto.randomBytes(8).toString('hex')}`;
      if (!this.metas[id]) return id;
    }
  }

  /** `blob.put`: a whole JSON blob, or base64 chunks (several frames with `more: true`). */
  put(m: Pick<PutMsg, 'blobId' | 'kind' | 'owner' | 'ext' | 'data' | 'chunks' | 'more'>): { blobId: string; size: number; complete: boolean } {
    fs.mkdirSync(this.dir, { recursive: true });
    const now = this.now();
    const prev = m.blobId ? this.metas[m.blobId] : undefined;
    const continuing = !!prev && !prev.complete;
    if (m.data !== undefined) {
      if (continuing) throw new BlobError(`blob ${m.blobId} has an upload in progress (send its remaining chunks)`);
      if (!m.kind) throw new BlobError('blob.put needs a kind');
      const text = JSON.stringify(m.data);
      const size = Buffer.byteLength(text);
      if (size > MAX_BLOB_BYTES) throw new BlobError(`blob is ${size} bytes, more than ${MAX_BLOB_BYTES}`);
      const id = m.blobId ?? this.newId();
      fs.rmSync(this.partFile(id), { force: true });
      fs.writeFileSync(this.file(id), text);
      this.metas[id] = { id, kind: m.kind, ...(m.owner ? { owner: m.owner } : {}), ext: m.ext ?? 'json', size, complete: true, createdAt: now, updatedAt: now };
      // on disk before the ack: a sweep after a crash would delete a blob state.json does not know
      this.store.flush();
      return { blobId: id, size, complete: true };
    }
    const bufs = (m.chunks ?? []).map((c, i) => {
      const b = Buffer.from(c, 'base64');
      if (b.length > MAX_CHUNK_BYTES) throw new BlobError(`chunk ${i} is ${b.length} bytes, more than ${MAX_CHUNK_BYTES}`);
      return b;
    });
    const add = bufs.reduce((n, b) => n + b.length, 0);
    let meta: BlobMeta;
    if (continuing) {
      meta = prev!;
      if (meta.size + add > MAX_BLOB_BYTES) {
        this.drop(meta.id);
        throw new BlobError(`blob ${meta.id} would be more than ${MAX_BLOB_BYTES} bytes; the upload is dropped`);
      }
    } else {
      if (!m.kind) throw new BlobError('blob.put needs a kind on its first frame');
      if (add > MAX_BLOB_BYTES) throw new BlobError(`blob is ${add} bytes, more than ${MAX_BLOB_BYTES}`);
      const id = m.blobId ?? this.newId();
      fs.writeFileSync(this.partFile(id), '');
      meta = { id, kind: m.kind, ...(m.owner ? { owner: m.owner } : {}), ext: m.ext ?? 'bin', size: 0, complete: false, createdAt: now, updatedAt: now };
      this.metas[id] = meta;
    }
    for (const b of bufs) fs.appendFileSync(this.partFile(meta.id), b);
    meta.size += add;
    meta.updatedAt = now;
    if (!m.more) {
      fs.renameSync(this.partFile(meta.id), this.file(meta.id));
      meta.complete = true;
      this.store.flush();
    } else this.store.markDirty();
    return { blobId: meta.id, size: meta.size, complete: meta.complete };
  }

  /** A JSON value as a new blob (a job result over 256 KB). */
  putJson(value: unknown, kind: string, owner?: string): string {
    return this.put({ kind, data: value, ...(owner ? { owner } : {}) }).blobId;
  }

  /** (6a) Exact bytes as a new blob (a region IR over 1 MB: the mod reads <data>/blobs/<id>). */
  putBytes(bytes: Uint8Array, kind: string, ext = 'bin', owner?: string): string {
    if (bytes.length > MAX_BLOB_BYTES) throw new BlobError(`blob is ${bytes.length} bytes, more than ${MAX_BLOB_BYTES}`);
    fs.mkdirSync(this.dir, { recursive: true });
    const now = this.now();
    const id = this.newId();
    fs.writeFileSync(this.file(id), bytes);
    this.metas[id] = { id, kind, ...(owner ? { owner } : {}), ext, size: bytes.length, complete: true, createdAt: now, updatedAt: now };
    this.store.flush();
    return id;
  }

  delete(id: string): boolean {
    if (!this.metas[id]) return false;
    this.drop(id);
    return true;
  }

  private drop(id: string): void {
    delete this.metas[id];
    fs.rmSync(this.file(id), { force: true });
    fs.rmSync(this.partFile(id), { force: true });
    this.store.markDirty();
  }

  /** Why these ids cannot be given to a job, or undefined. */
  missing(ids: string[]): string | undefined {
    const bad = ids.filter((id) => !this.get(id));
    return bad.length ? `no finished blob ${bad.map((b) => `"${b}"`).join(', ')}` : undefined;
  }

  /** Copy blobs into `<dir>/blobs/<id>.<ext>`; returns the relative paths. */
  copyInto(ids: string[], dir: string): string[] {
    const out: string[] = [];
    if (!ids.length) return out;
    fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
    for (const id of ids) {
      const m = this.get(id);
      if (!m) throw new BlobError(`no blob "${id}"`);
      const rel = path.join('blobs', `${id}.${m.ext}`);
      fs.copyFileSync(this.file(id), path.join(dir, rel));
      out.push(rel);
    }
    return out;
  }

  /** Drop blobs older than 7 days, uploads idle for an hour, and files nothing knows. */
  sweep(): number {
    const now = this.now();
    let n = 0;
    for (const m of Object.values(this.metas)) {
      if ((m.complete && now - m.createdAt > BLOB_TTL_MS) || (!m.complete && now - m.updatedAt > UPLOAD_TTL_MS)) {
        this.drop(m.id);
        n++;
      }
    }
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const id = f.endsWith('.part') ? f.slice(0, -5) : f;
        if (!this.metas[id]) {
          fs.rmSync(path.join(this.dir, f), { force: true });
          n++;
        }
      }
    } catch {
      /* no blobs dir yet */
    }
    return n;
  }
}
