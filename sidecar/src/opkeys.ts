// (6c 0a, C9; docs/CONTRACT.md "Phase 6c slice 0a" §6) Caller operation keys: a bible.request or design.group may carry an
// `opKey` ([A-Za-z0-9_.:-]{1,128}), scoped by (owner, kind, opKey); a null owner is the player. The same key with the same
// body returns the first operation (adopted: true) and starts no new work, in any state; another body is refused with
// "op_key_conflict: ...". Bodies compare by the sha256 of the request's canonical JSON (sorted keys) without opKey.
//
// Keys live in state.json (`opKeys`), written in the same flushed write that creates the job or group, before the ack. A key
// lives as long as its record; records with a key are kept at least 30 days after they are final (the pruning in bibles.ts and
// groups.ts skips them), and a key whose record is gone is dropped 30 days after it was made.
import crypto from 'node:crypto';
import { ClientError } from './errors.js';
import type { Store } from './store.js';

export type OpKind = 'bible' | 'group';
export interface OpKeyEntry {
  id: string;
  hash: string;
  at: number;
}

export const OP_KEY_KEEP_MS = 30 * 24 * 3600_000;
export const OP_KEY_CONFLICT = 'op_key_conflict';

/** JSON with object keys sorted, recursively (undefined members dropped, as JSON.stringify does). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The sha256 of a request's canonical JSON without its opKey. */
export function bodyHash(req: Record<string, unknown>): string {
  const { opKey: _k, ...rest } = req;
  return crypto.createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

const slot = (kind: OpKind, owner: string | undefined, key: string) => `${kind}|${owner ?? ''}|${key}`;

export class OpKeys {
  constructor(
    private store: Store,
    private now: () => number = Date.now,
  ) {}

  private get map(): Record<string, OpKeyEntry> {
    return (this.store.data.opKeys ??= {});
  }

  /** The record id a key names, if any. */
  get(kind: OpKind, owner: string | undefined, key: string): OpKeyEntry | undefined {
    return this.map[slot(kind, owner, key)];
  }

  /**
   * Before creating: the id of the operation this key already made with the same body (adopt it), undefined when the key is
   * new; throws op_key_conflict when the key was used with another body.
   */
  check(kind: OpKind, owner: string | undefined, key: string, req: Record<string, unknown>): string | undefined {
    const e = this.get(kind, owner, key);
    if (!e) return undefined;
    if (e.hash !== bodyHash(req)) throw new ClientError(`${OP_KEY_CONFLICT}: opKey "${key}" (${kind}${owner ? `, ${owner}` : ''}) was used for another ${kind === 'bible' ? 'bible request' : 'group'} (${e.id})`);
    return e.id;
  }

  /** After creating: remember the key, and flush state.json now (the key must be on disk before the ack). */
  record(kind: OpKind, owner: string | undefined, key: string, req: Record<string, unknown>, id: string): void {
    this.map[slot(kind, owner, key)] = { id, hash: bodyHash(req), at: this.now() };
    this.store.markDirty();
    this.store.flush();
  }

  /** Drops keys whose record is gone and that are older than 30 days. */
  prune(exists: (kind: OpKind, id: string) => boolean): void {
    let n = 0;
    for (const [k, e] of Object.entries(this.map)) {
      const kind = k.split('|')[0] as OpKind;
      if (!exists(kind, e.id) && this.now() - e.at > OP_KEY_KEEP_MS) {
        delete this.map[k];
        n++;
      }
    }
    if (n) this.store.markDirty();
  }
}

/** Whether a final record with an opKey is still inside its 30-day keep (so pruning skips it). */
export function keptForKey(r: { opKey?: string | undefined; request?: { opKey?: string | undefined }; updatedAt: number }, now: number): boolean {
  return !!(r.opKey ?? r.request?.opKey) && now - r.updatedAt < OP_KEY_KEEP_MS;
}
