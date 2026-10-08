// (5b) Entry versions (docs/CONTRACT.md "Phase 5b", §1 "Entry versions on disk", "Installing a version", "Lineage and
// staleness", "Retention"; the layout is pinned in docs/HANDOFF-5b.md, and the mod's EntryVersions.java writes the same).
//
//   <library>/<id>/            the head version (the layout as before 5b): <id>.nbt, <id>.blueprint.json, <id>.mjs,
//                              <id>.parts.nbt, <id>.preview-*.png, critique.json
//   <library>/<id>/versions/<n>/   the same files for version n (and delta.json for a version made from a parent);
//                              immutable once complete; complete = renamed from versions/.tmp-<n>-<rand>/
//
// Install (crash-safe): (1) on the first bump, the top level is copied into versions/.tmp-<head>-<rand>/ (with a
// synthesized lineage when the JSON has none) and renamed to versions/<head>/; (2) version n+1 is written into
// versions/.tmp-<n+1>-<rand>/ (created exclusively) and renamed to versions/<n+1>/: THE COMMIT POINT; (3) the top level is
// replaced from it: every regular file but the blueprint JSON, delta.json and dotfiles (each .tmp + rename), then the
// top-level layout files the new version lacks are deleted, then the blueprint JSON last, carrying the user metadata
// (favorite, userTags, displayName) and ext read from the current top-level JSON just before. Repair (sidecar start, and
// the mod's library load): .tmp-* folders (and stray top-level *.tmp files) are deleted, and a top level whose `version`
// is below the highest complete versions/<m>/ is replaced from it (step 3 again).
//
// Retention: at most 32 versions per entry and 30 days; GC at sidecar start. A version folder goes when it is not the head,
// no site pins it (the pins the mod last reported, <data>/pins.json), no unfinished design or polish uses it, and it is
// older than 30 days; over 32 the oldest such eligible versions go regardless of age. Pins always win. With no pins ever
// received, GC deletes nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withDesignId } from './designs.js';
import { ClientError } from './errors.js';
import { readJson, writeFileAtomic } from './util/fsx.js';

export const MAX_VERSIONS = 32;
export const VERSION_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const USER_FIELDS = ['favorite', 'userTags', 'displayName'] as const;
export const SUMMARY_MAX = 200;

export type VersionBy = 'design' | 'polish' | 'revert' | 'migrated';

/** One entry of the blueprint JSON's `versions` (the lineage). */
export interface LineageEntry {
  n: number;
  createdAt: number;
  by: VersionBy;
  parent: number | null;
  designId?: string;
  summary: string;
  nbtSha256: string;
  criticHash?: string;
}

/** Why a version of this entry cannot be made (polish / revert): docs/CONTRACT.md "Refused". */
export type VersionRefusal = 'bundled' | 'no_source' | 'massing';

export class VersionRefused extends ClientError {
  constructor(
    readonly code: VersionRefusal | 'no_entry' | 'no_version',
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** The fault points of an install (tests: a crash at every step, then repair). */
export type FaultPoint = 'head-copied' | 'head-committed' | 'new-written' | 'committed' | 'top-file' | 'top-files-done' | 'top-json';

/** The files of a new version (named anything; installed under the entry id). */
export interface VersionFiles {
  nbt: string;
  /** the blueprint JSON (an object; `id`, `version` and `versions` are set here) */
  json: Record<string, unknown>;
  parts?: string | undefined;
  source?: string | undefined;
  previews?: string[] | undefined;
  /** critique.json (an object, written as is) */
  critique?: Record<string, unknown> | undefined;
  /** delta.json (an object) */
  delta?: Record<string, unknown> | undefined;
  /** more files, `to` relative to the version folder (bible/components.mjs) */
  files?: Array<{ from: string; to: string }> | undefined;
}

export interface VersionMeta {
  by: VersionBy;
  parent: number | null;
  designId?: string | undefined;
  summary: string;
  criticHash?: string | undefined;
}

export interface VersionsHost {
  libraryDir: string;
  kitDir: string;
  dataDir: string;
  now(): number;
  log: { info(m: string): void; warn(m: string): void };
}

export const sha256File = (f: string): string => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const rand = () => crypto.randomBytes(4).toString('hex');

function readObj(file: string): Record<string, unknown> | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const jsonText = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

export class EntryVersions {
  /** tests: throw at a fault point */
  fault: ((p: FaultPoint) => void) | undefined;

  constructor(private host: VersionsHost) {}

  dir(entryId: string): string {
    return path.join(this.host.libraryDir, entryId);
  }

  jsonFile(entryId: string): string {
    return path.join(this.dir(entryId), `${entryId}.blueprint.json`);
  }

  /** The top-level blueprint JSON (undefined: no such entry). */
  top(entryId: string): Record<string, unknown> | undefined {
    if (!/^[a-z0-9_]+$/.test(entryId)) return undefined;
    return readObj(this.jsonFile(entryId));
  }

  /** The head version (the top-level JSON's `version`, absent = 1). */
  head(entryId: string): number {
    const v = this.top(entryId)?.version;
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : 1;
  }

  /** Complete version folders (versions/<n>/), ascending. */
  folders(entryId: string): number[] {
    const vd = path.join(this.dir(entryId), 'versions');
    if (!fs.existsSync(vd)) return [];
    return fs
      .readdirSync(vd)
      .filter((f) => /^\d+$/.test(f) && fs.statSync(path.join(vd, f)).isDirectory())
      .map(Number)
      .sort((a, b) => a - b);
  }

  /** The folder holding version n's files: versions/<n>/, or the top level for a never-bumped head. */
  versionDir(entryId: string, n: number): string | undefined {
    const vd = path.join(this.dir(entryId), 'versions', String(n));
    if (fs.existsSync(vd)) return vd;
    if (n === this.head(entryId) && fs.existsSync(this.jsonFile(entryId))) return this.dir(entryId);
    return undefined;
  }

  /** The lineage (the JSON's `versions`, else a synthesized version 1 by "migrated"). */
  lineage(entryId: string, json = this.top(entryId)): LineageEntry[] {
    if (!json) return [];
    if (Array.isArray(json.versions) && json.versions.length) return json.versions as LineageEntry[];
    const nbt = path.join(this.dir(entryId), `${entryId}.nbt`);
    return [{ n: typeof json.version === 'number' ? json.version : 1, createdAt: typeof json.createdAt === 'number' ? json.createdAt : 0, by: 'migrated', parent: null, summary: '', nbtSha256: fs.existsSync(nbt) ? sha256File(nbt) : '' }];
  }

  /** entry.versions: the lineage entries whose files are still there (GC removes old ones), with the head last. */
  list(entryId: string): LineageEntry[] {
    if (!this.top(entryId)) throw new VersionRefused('no_entry', `no library entry "${entryId}"`);
    const have = new Set(this.folders(entryId));
    const head = this.head(entryId);
    return this.lineage(entryId).filter((e) => e.n === head || have.has(e.n));
  }

  /** Can a new version of this entry be made (polish, revert)? Throws VersionRefused. */
  checkVersionable(entryId: string): Record<string, unknown> {
    const json = this.top(entryId);
    if (!json) {
      const bundled = /^[a-z0-9_]+$/.test(entryId) && [path.join(this.host.kitDir, 'designs', `${entryId}.mjs`), path.join(this.host.kitDir, 'examples', entryId, `${entryId}.mjs`)].some((f) => fs.existsSync(f));
      if (bundled) throw new VersionRefused('bundled', `${entryId} is a bundled example: make a variant first`);
      throw new VersionRefused('no_entry', `no library entry "${entryId}"`);
    }
    if (json.massing === true) throw new VersionRefused('massing', `${entryId} is a massing (massings keep their own versions)`);
    if (json.imported === true || !fs.existsSync(path.join(this.dir(entryId), `${entryId}.mjs`))) throw new VersionRefused('no_source', `${entryId} has no source (${entryId}.mjs): an imported structure cannot get versions`);
    return json;
  }

  // ---- install ---------------------------------------------------------------------------------------------

  /** Install the files as version head+1. Returns the new version number. */
  install(entryId: string, files: VersionFiles, meta: VersionMeta): number {
    this.repair(entryId);
    const top = this.top(entryId);
    if (!top) throw new VersionRefused('no_entry', `no library entry "${entryId}"`);
    const dir = this.dir(entryId);
    const vroot = path.join(dir, 'versions');
    fs.mkdirSync(vroot, { recursive: true });
    const n = this.head(entryId);
    const lineage = this.lineage(entryId, top);
    // (1) the first bump: the current top level becomes versions/<n>/
    if (!fs.existsSync(path.join(vroot, String(n)))) {
      const tmp = path.join(vroot, `.tmp-${n}-${rand()}`);
      fs.mkdirSync(tmp);
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (f === 'versions' || f.startsWith('.') || f.endsWith('.tmp')) continue;
        const st = fs.statSync(p);
        if (st.isDirectory()) fs.cpSync(p, path.join(tmp, f), { recursive: true });
        else if (st.isFile() && f !== `${entryId}.blueprint.json`) fs.copyFileSync(p, path.join(tmp, f));
      }
      const j = { ...top, version: n, versions: lineage };
      fs.writeFileSync(path.join(tmp, `${entryId}.blueprint.json`), jsonText(j));
      this.fault?.('head-copied');
      fs.renameSync(tmp, path.join(vroot, String(n)));
      this.fault?.('head-committed');
    }
    // (2) version n+1 into versions/.tmp-<n+1>-<rand>/, renamed to versions/<n+1>/ (the commit point)
    const next = n + 1;
    if (fs.existsSync(path.join(vroot, String(next)))) throw new Error(`entry ${entryId}: versions/${next}/ exists already (repair first)`);
    const tmp = path.join(vroot, `.tmp-${next}-${rand()}`);
    fs.mkdirSync(tmp); // exclusive: EEXIST for a clash
    const nbt = path.join(tmp, `${entryId}.nbt`);
    fs.copyFileSync(files.nbt, nbt, fs.constants.COPYFILE_EXCL);
    if (files.parts && fs.existsSync(files.parts)) fs.copyFileSync(files.parts, path.join(tmp, `${entryId}.parts.nbt`), fs.constants.COPYFILE_EXCL);
    if (files.source) fs.writeFileSync(path.join(tmp, `${entryId}.mjs`), withDesignId(fs.readFileSync(files.source, 'utf8'), entryId), { flag: 'wx' });
    for (const p of files.previews ?? []) {
      const view = /\.preview-([a-z0-9_-]+)\.png$/i.exec(p)?.[1];
      if (view) fs.copyFileSync(p, path.join(tmp, `${entryId}.preview-${view.toLowerCase()}.png`), fs.constants.COPYFILE_EXCL);
    }
    for (const f of files.files ?? []) {
      const rel = path.normalize(f.to);
      if (path.isAbsolute(rel) || rel.startsWith('..')) throw new Error(`install: ${f.to} is outside the version folder`);
      if (!fs.existsSync(f.from)) continue;
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.copyFileSync(f.from, path.join(tmp, rel));
    }
    if (files.critique) fs.writeFileSync(path.join(tmp, 'critique.json'), jsonText(files.critique), { flag: 'wx' });
    if (files.delta) fs.writeFileSync(path.join(tmp, 'delta.json'), jsonText(files.delta), { flag: 'wx' });
    const entry: LineageEntry = {
      n: next,
      createdAt: this.host.now(),
      by: meta.by,
      parent: meta.parent,
      ...(meta.designId ? { designId: meta.designId } : {}),
      summary: meta.summary.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX),
      nbtSha256: sha256File(nbt),
      ...(meta.criticHash ? { criticHash: meta.criticHash } : {}),
    };
    const j: Record<string, unknown> = { ...files.json, id: entryId, version: next, versions: [...lineage.filter((e) => e.n < next), entry] };
    if (files.source) j.source = `${entryId}.mjs`;
    for (const k of USER_FIELDS) delete j[k];
    fs.writeFileSync(path.join(tmp, `${entryId}.blueprint.json`), jsonText(j), { flag: 'wx' });
    this.fault?.('new-written');
    fs.renameSync(tmp, path.join(vroot, String(next)));
    this.fault?.('committed');
    // (3) the top level from versions/<next>/
    this.replaceTop(entryId, next);
    this.host.log.info(`entry ${entryId}: version ${next} installed (${meta.by}, parent ${meta.parent ?? '-'})`);
    return next;
  }

  /**
   * Step 3: the top level becomes version m: its regular files but the blueprint JSON, delta.json and dotfiles (each
   * .tmp + rename), the top-level layout files it lacks deleted, then the JSON last with the user metadata and ext of
   * the current top-level JSON.
   */
  replaceTop(entryId: string, m: number): void {
    const dir = this.dir(entryId);
    const vd = path.join(dir, 'versions', String(m));
    const names = new Set<string>();
    for (const f of fs.readdirSync(vd)) {
      const p = path.join(vd, f);
      if (f.startsWith('.') || f === `${entryId}.blueprint.json` || f === 'delta.json' || !fs.statSync(p).isFile()) continue;
      names.add(f);
      writeFileAtomic(path.join(dir, f), fs.readFileSync(p));
      this.fault?.('top-file');
    }
    const layout = (f: string) => f === `${entryId}.parts.nbt` || f === `${entryId}.mjs` || f === 'critique.json' || (f.startsWith(`${entryId}.preview-`) && f.endsWith('.png'));
    for (const f of fs.readdirSync(dir)) if (layout(f) && !names.has(f)) fs.rmSync(path.join(dir, f), { force: true });
    this.fault?.('top-files-done');
    const j = readObj(path.join(vd, `${entryId}.blueprint.json`)) ?? {};
    const cur = this.top(entryId) ?? {};
    for (const k of [...USER_FIELDS, 'ext']) delete j[k];
    for (const k of [...USER_FIELDS, 'ext']) if (cur[k] !== undefined) j[k] = cur[k];
    this.fault?.('top-json');
    writeFileAtomic(this.jsonFile(entryId), jsonText(j));
  }

  // ---- repair and GC -----------------------------------------------------------------------------------------

  /** Repair one entry: .tmp-* folders (and stray top-level *.tmp files) go; a stale top level is redone. */
  repair(entryId: string): boolean {
    const dir = this.dir(entryId);
    const vroot = path.join(dir, 'versions');
    let did = false;
    if (fs.existsSync(vroot)) {
      for (const f of fs.readdirSync(vroot)) {
        if (f.startsWith('.tmp-')) {
          fs.rmSync(path.join(vroot, f), { recursive: true, force: true });
          did = true;
        }
      }
    }
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith('.tmp') && fs.statSync(path.join(dir, f)).isFile()) fs.rmSync(path.join(dir, f), { force: true });
    const have = this.folders(entryId);
    const m = have.at(-1);
    if (m !== undefined && fs.existsSync(path.join(vroot, String(m), `${entryId}.blueprint.json`))) {
      const top = this.top(entryId);
      const v = top && typeof top.version === 'number' ? top.version : 1;
      if (!top || v < m) {
        this.replaceTop(entryId, m);
        this.host.log.warn(`entry ${entryId}: the top level was at v${top ? v : '?'}; repaired to v${m}`);
        did = true;
      }
    }
    return did;
  }

  /** Every library entry with a versions/ folder. */
  versionedEntries(): string[] {
    const lib = this.host.libraryDir;
    if (!fs.existsSync(lib)) return [];
    return fs.readdirSync(lib).filter((e) => /^[a-z0-9_]+$/.test(e) && fs.existsSync(path.join(lib, e, 'versions'))).sort();
  }

  repairAll(): string[] {
    const out: string[] = [];
    for (const e of this.versionedEntries()) {
      try {
        if (this.repair(e)) out.push(e);
      } catch (err) {
        this.host.log.warn(`entry ${e}: repair failed: ${(err as Error).message}`);
      }
    }
    return out;
  }

  // ---- pins (the mod reports them: entry.pins) ---------------------------------------------------------------

  private pinsFile(): string {
    return path.join(this.host.dataDir, 'pins.json');
  }

  /** The pins the mod last reported (undefined: none ever received). */
  pins(): Record<string, number[]> | undefined {
    const j = readJson<{ pins?: Record<string, number[]> }>(this.pinsFile());
    return j?.pins && typeof j.pins === 'object' ? j.pins : undefined;
  }

  setPins(pins: Record<string, number[]>): void {
    writeFileAtomic(this.pinsFile(), jsonText({ at: this.host.now(), pins }));
  }

  /**
   * GC at sidecar start. `inUse` = "<entry>:<n>" of unfinished designs and polishes. Returns the deleted "<entry>:<n>".
   */
  gc(inUse: ReadonlySet<string> = new Set()): string[] {
    const pins = this.pins();
    if (!pins) return [];
    const now = this.host.now();
    const deleted: string[] = [];
    for (const e of this.versionedEntries()) {
      const head = this.head(e);
      const have = this.folders(e);
      const born = new Map(this.lineage(e).map((x) => [x.n, x.createdAt]));
      const pinned = new Set((pins[e] ?? []).filter((n) => Number.isInteger(n)));
      const eligible = have.filter((n) => n !== head && !pinned.has(n) && !inUse.has(`${e}:${n}`));
      const age = (n: number) => {
        const t = born.get(n);
        if (typeof t === 'number' && t > 0) return now - t;
        try {
          return now - fs.statSync(path.join(this.dir(e), 'versions', String(n))).mtimeMs;
        } catch {
          return 0;
        }
      };
      const go = new Set(eligible.filter((n) => age(n) > VERSION_MAX_AGE_MS));
      // over the cap: the oldest eligible versions go regardless of age (pins, the head and versions in use stay)
      let count = have.length - go.size;
      for (const n of eligible) {
        if (count <= MAX_VERSIONS) break;
        if (go.has(n)) continue;
        go.add(n);
        count--;
      }
      for (const n of [...go].sort((a, b) => a - b)) {
        fs.rmSync(path.join(this.dir(e), 'versions', String(n)), { recursive: true, force: true });
        deleted.push(`${e}:${n}`);
      }
    }
    if (deleted.length) this.host.log.info(`entry versions GC: deleted ${deleted.join(', ')}`);
    return deleted;
  }

  // ---- revert ----------------------------------------------------------------------------------------------

  /** entry.revert: version head+1 as a byte copy of version k (by "revert", parent k). */
  revert(entryId: string, k: number): number {
    this.checkVersionable(entryId);
    const head = this.head(entryId);
    if (k === head) throw new VersionRefused('no_version', `${entryId} is at v${k} already`);
    const src = k >= 1 ? this.versionDir(entryId, k) : undefined;
    if (!src || src === this.dir(entryId)) throw new VersionRefused('no_version', `${entryId} has no version ${k}${k < head ? ' (it was garbage-collected)' : ''}`);
    const json = readObj(path.join(src, `${entryId}.blueprint.json`)) ?? {};
    const { version: _v, versions: _vs, ...rest } = json;
    const files = fs.readdirSync(src);
    const extra = files.filter((f) => f !== 'versions' && fs.statSync(path.join(src, f)).isDirectory()).flatMap((d) => walk(path.join(src, d)).map((f) => ({ from: f, to: path.relative(src, f) })));
    const has = (f: string) => files.includes(f);
    const crit = has('critique.json') ? readObj(path.join(src, 'critique.json')) : undefined;
    return this.install(
      entryId,
      {
        nbt: path.join(src, `${entryId}.nbt`),
        json: rest,
        ...(has(`${entryId}.parts.nbt`) ? { parts: path.join(src, `${entryId}.parts.nbt`) } : {}),
        ...(has(`${entryId}.mjs`) ? { source: path.join(src, `${entryId}.mjs`) } : {}),
        previews: files.filter((f) => /\.preview-[a-z0-9_-]+\.png$/i.test(f)).map((f) => path.join(src, f)),
        ...(crit ? { critique: crit } : {}),
        files: extra,
      },
      { by: 'revert', parent: k, summary: `revert to v${k}` },
    );
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// ---- critique.json format 2 and the stale rule ----------------------------------------------------------------

export interface EntryCritique {
  format: number;
  entryId?: string;
  /** the version it was made for (format 1: 1) */
  entryVersion: number;
  /** sha256 of the .nbt it judged */
  entryRevision: string | null;
  /** the critic hash (critichash.ts); format 1 has none */
  criticHash?: string;
  verdict?: { overall: number | null; scores: Record<string, number>; issues: Array<{ priority: string; part: string | null; view: string; what: string; fix: string }>; summary?: string | null } | null;
  openIssues?: Array<{ priority: string; part: string | null; view: string; what: string; fix: string }>;
  [k: string]: unknown;
}

/** Read a critique.json (format 1 reads as entryVersion 1). */
export function readEntryCritique(file: string): EntryCritique | undefined {
  const j = readObj(file);
  if (!j) return undefined;
  const format = typeof j.format === 'number' ? j.format : 1;
  return { ...j, format, entryVersion: typeof j.entryVersion === 'number' ? j.entryVersion : 1, entryRevision: typeof j.entryRevision === 'string' ? j.entryRevision : null } as EntryCritique;
}

/**
 * Stale = made for another version, or another .nbt (entryRevision), or by another critic (criticHash; a format-1 file
 * has none, so it is stale). Returns why (undefined: fresh).
 */
export function staleReason(c: EntryCritique, cur: { version: number; nbtSha256: string; criticHash: string }): string | undefined {
  if (c.entryVersion !== cur.version) return `for v${c.entryVersion}; this is v${cur.version}`;
  if (c.entryRevision !== cur.nbtSha256) return 'the entry changed since (its .nbt differs)';
  if (c.criticHash !== cur.criticHash) return c.criticHash ? 'made by another critic (its prompts changed)' : 'made before 5b (no critic hash)';
  return undefined;
}
