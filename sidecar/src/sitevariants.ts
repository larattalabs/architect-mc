// (7b DS, docs/CONTRACT.md "Phase 7b", Steward's review change 1) Site variants: Designs.siteVariant(entryId, SiteSpec, opKey).
//
//   - site.variant {entryId, site, opKey, owner?}: the source entry's kit program (its head's .mjs) re-run on another site at $0 (no
//     Claude), with the source's recorded values and palette (its own bible files when it has them), checked on the composite
//     (`--site`), and installed directly into the library as a new entry (no group, no approval: its approval is the source's, carried
//     per archetype): `derivation {source, sourceVersion, kind: 'site', recipe {lotId, volumeSha, fit, frame, values}}`, the binding in
//     ext["architect_mc:site"], the site's files beside its source (site/site.arvx, site/site.json), its request the source's with the
//     new site
//   - refusals, synchronous (before the ack) or as the operation's result: SITE_UNSUPPORTED (detail `no_program`: an import or an entry
//     without a source; `not_site_aware`: a program with no `fit`); SITE_UNFIT (detail: the first failing site rule id of the kit's
//     SITE_RULE_IDS; `site_bound` when the program cannot be built into this site at all: another fit, or it throws on the site's shape);
//     an unknown entry is VERSION_REFUSED no_entry (UNKNOWN_BLUEPRINT on the mod side)
//   - one persisted operation per call, <data>/sitevariants/<id>.json, keyed by (owner, "siteVariant", opKey) with the body {entryId,
//     site without its blob id}; the ack carries the operation {id, kind, status, entryId?, refused?}; a running one reports done
//     through follow.upsert {follow} (the API's operation channel, docs/CONTRACT.md "Slice DS as built"); a restart resumes it
//   - deterministic: the same source version and site give the same blocks; the new id is <source>_site_<lot id or sha> (never
//     overwriting)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkDesign, freeLibraryId, installDesign, KIT, refreshKit, renderPreviews, slugify, withDesignId, type CheckResult } from './designs.js';
import { ClientError, RefusedError } from './errors.js';
import { bodyHash, OP_KEY_CONFLICT, siteKeyBody } from './opkeys.js';
import { siteSize, type DesignRequest, type Outbound, type SiteSpec } from './protocol.js';
import { keepSiteVolume, SITE_BINDING_KEY, SITE_CHECK_ARGS, siteBinding, siteEntryFiles, writeSiteFiles } from './sitedesign.js';
import { findVariantSource, isExt, normalizeKitImports, VariantRefused } from './variants.js';
import { truncate } from './util/text.js';
import { writeFileAtomic } from './util/fsx.js';
import type { Logger } from './context.js';
import type { Config } from './config.js';

const KIT_TIMEOUT_MS = 120_000;

/** The kit's site rule ids in report order (kit/lib/siteCheck.mjs SITE_RULE_IDS; a test holds them equal). */
export const SITE_RULE_IDS = ['site_bound', 'site_keep', 'fit:on_pad', 'fit:carve_into', 'fit:attach_to_cliff', 'fit:span', 'fit:wrap_trunk', 'fit:suspend', 'ports_met', 'floors_reachable', 'site_breach', 'cut_volume', 'cantilever', 'neck'] as const;

export interface SiteVariantRefusal {
  code: 'SITE_UNFIT' | 'SITE_UNSUPPORTED';
  detail: string;
  message: string;
}

export interface SiteVariantOp {
  id: string;
  kind: 'siteVariant';
  opKey: string;
  owner?: string;
  hash: string;
  entryId: string;
  site: SiteSpec;
  status: 'running' | 'done';
  /** done: the new entry */
  newEntryId?: string;
  /** done: why nothing was installed */
  refused?: SiteVariantRefusal;
  createdAt: number;
  updatedAt: number;
}

export interface SiteVariantHost {
  readonly config: Config;
  readonly log: Logger;
  readonly blobs: { get(id: string): unknown; file(id: string): string };
  now(): number;
  emit(msg: Outbound): void;
  /** an entry's head version (1 for a bundled example or an entry without versions) */
  entryHead(entryId: string): number;
  /** the kit builds into sites (build.mjs --site) */
  kitHas(flag: string): boolean;
}

/** What the ack and follow.upsert carry. */
export function siteVariantView(op: SiteVariantOp): Record<string, unknown> {
  return {
    id: op.id,
    kind: 'siteVariant',
    status: op.status,
    entryId: op.entryId,
    ...(op.newEntryId ? { newEntryId: op.newEntryId } : {}),
    ...(op.refused ? { refused: op.refused } : {}),
  };
}

/** Does a kit program declare a fit (`export const fit = '...'`)? Only a site-aware program can be re-run on a site. */
export function programFit(source: string): string | undefined {
  return /export\s+const\s+fit\s*=\s*['"]([a-z_]+)['"]/.exec(source)?.[1];
}

/** The failing site rule of a build (SITE_UNFIT's detail): the first site finding, else `site_bound` when it did not build. */
export function unfitRule(res: CheckResult): string | undefined {
  const site = siteResult(res.output);
  const first = site?.findings?.[0]?.rule;
  if (first) return first;
  if (!res.ok) return 'site_bound';
  return site && site.ok === false ? 'site_bound' : undefined;
}

/** The kit's `site` member of the build's --json line, if it printed one. */
export function siteResult(output: string): { ok?: boolean; findings?: Array<{ rule: string; message?: string }>; metrics?: Record<string, unknown> } | undefined {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]!) as { site?: unknown };
      if (j.site && typeof j.site === 'object') return j.site as ReturnType<typeof siteResult>;
      if ('errors' in j) return undefined;
    } catch {
      /* not it */
    }
  }
  return undefined;
}

export class SiteVariants {
  private queue: string[] = [];
  private runP: Promise<void> | undefined;
  private stopped = false;
  private seq = 0;
  private taken = new Set<string>();

  constructor(private host: SiteVariantHost) {}

  private dir(): string {
    return path.join(this.host.config.dataDir, 'sitevariants');
  }

  private file(id: string): string {
    return path.join(this.dir(), `${id}.json`);
  }

  get(id: string): SiteVariantOp | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as SiteVariantOp;
    } catch {
      return undefined;
    }
  }

  private save(op: SiteVariantOp): void {
    op.updatedAt = this.host.now();
    fs.mkdirSync(this.dir(), { recursive: true });
    writeFileAtomic(this.file(op.id), `${JSON.stringify(op, null, 1)}\n`);
  }

  /** The operation file of a key (owner and key hashed: one file per (owner, opKey)). */
  private keyId(owner: string | undefined, opKey: string): string {
    return `sv${crypto.createHash('sha256').update(`${owner ?? ''}|${opKey}`).digest('hex').slice(0, 20)}`;
  }

  /**
   * site.variant: the operation (the same key and body: the first one, in any state; another body: op_key_conflict). Synchronous
   * refusals throw RefusedError (SITE_UNSUPPORTED, VERSION_REFUSED no_entry) or ClientError (the kit, the volume).
   */
  request(entryId: string, site: SiteSpec, opKey: string, owner?: string): SiteVariantOp {
    const body = siteKeyBody({ entryId, site } as Record<string, unknown>);
    const id = this.keyId(owner, opKey);
    const prior = this.get(id);
    if (prior) {
      if (prior.hash !== bodyHash(body)) throw new ClientError(`${OP_KEY_CONFLICT}: opKey "${opKey}" (siteVariant${owner ? `, ${owner}` : ''}) was used for another site variant (${prior.entryId})`);
      this.host.log.info(`site variant ${prior.id}: replayed by opKey ${opKey} (${prior.status})`);
      return prior;
    }
    this.source(entryId);
    if (!this.host.kitHas('--site')) throw new ClientError("this helper's kit cannot build into a site (no build.mjs --site)");
    keepSiteVolume(this.host.config.dataDir, this.host.blobs, site);
    const now = this.host.now();
    const op: SiteVariantOp = { id, kind: 'siteVariant', opKey, ...(owner ? { owner } : {}), hash: bodyHash(body), entryId, site, status: 'running', createdAt: now, updatedAt: now };
    this.save(op);
    this.host.log.info(`site variant ${id}: ${entryId} on site ${site.volumeSha.slice(0, 12)} (${site.fit}${site.lotId ? `, lot ${site.lotId}` : ''})`);
    this.enqueue(id);
    return op;
  }

  /** The source a variant re-runs, refused as the API names it. */
  private source(entryId: string): { file: string; dir: string; entry: Record<string, unknown>; bundled: boolean; fit: string } {
    let src;
    try {
      src = findVariantSource(this.host.config.libraryDir, this.host.config.kitDir, entryId);
    } catch (e) {
      const msg = (e as Error).message;
      if (e instanceof VariantRefused && /^no library entry/.test(msg)) throw new RefusedError('VERSION_REFUSED', 'no_entry', msg);
      throw new SiteRefused('SITE_UNSUPPORTED', 'no_program', `${msg} (a site variant re-runs the source's kit program)`);
    }
    const fit = programFit(fs.readFileSync(src.sourceFile, 'utf8'));
    if (!fit) throw new SiteRefused('SITE_UNSUPPORTED', 'not_site_aware', `${entryId}'s program is not site-aware (it declares no fit): only a site-aware design is re-run on another site`);
    return { file: src.sourceFile, dir: path.dirname(src.sourceFile), entry: src.entry ?? {}, bundled: src.bundled, fit };
  }

  // ---- the runner ----------------------------------------------------------------------------------------------------

  /** Resume every running operation (the sidecar's start). */
  start(): void {
    if (!fs.existsSync(this.dir())) return;
    for (const f of fs.readdirSync(this.dir()).filter((x) => x.endsWith('.json')).sort()) {
      const op = this.get(f.slice(0, -5));
      if (op?.status === 'running') this.enqueue(op.id);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.runP?.catch(() => undefined);
  }

  async idle(): Promise<void> {
    while (this.runP) await this.runP.catch(() => undefined);
  }

  private enqueue(id: string): void {
    if (!this.queue.includes(id)) this.queue.push(id);
    if (this.runP || this.stopped) return;
    this.runP = (async () => {
      // (SA, A18) yield to the event loop first: the runner's first steps (the kit copy, the site files) are synchronous, and started
      // inside the request they ran before the site.variant ack was written; under load the ack missed the mod's 20 s window
      await new Promise<void>((r) => setImmediate(r));
      try {
        while (!this.stopped && this.queue.length) {
          const next = this.queue.shift()!;
          try {
            await this.run(next);
          } catch (e) {
            this.host.log.warn(`site variant ${next}: stopped: ${(e as Error).message}`);
          }
        }
      } finally {
        this.runP = undefined;
      }
    })();
  }

  private finish(op: SiteVariantOp, out: { newEntryId: string } | { refused: SiteVariantRefusal }): void {
    op.status = 'done';
    if ('newEntryId' in out) op.newEntryId = out.newEntryId;
    else op.refused = { ...out.refused, message: truncate(out.refused.message.replace(/\s+/g, ' ').trim(), 600) };
    this.save(op);
    this.host.log.info(`site variant ${op.id}: ${op.newEntryId ? `installed ${op.newEntryId}` : `refused ${op.refused!.code} ${op.refused!.detail}`}`);
    this.host.emit({ type: 'follow.upsert', follow: siteVariantView(op) } as Outbound);
  }

  private async run(id: string): Promise<void> {
    const op = this.get(id);
    if (!op || op.status !== 'running') return;
    // a resume after a kill between the install and the record: the entry this operation installed
    const done = this.installedBy(op);
    if (done) return this.finish(op, { newEntryId: done });
    let src;
    try {
      src = this.source(op.entryId);
    } catch (e) {
      if (e instanceof SiteRefused) return this.finish(op, { refused: { code: e.code as SiteVariantRefusal['code'], detail: e.detail, message: e.message } });
      if (e instanceof RefusedError) return this.finish(op, { refused: { code: 'SITE_UNSUPPORTED', detail: 'no_program', message: e.message } });
      throw e;
    }
    const site = op.site;
    if (src.fit !== site.fit) return this.finish(op, { refused: { code: 'SITE_UNFIT', detail: 'site_bound', message: `${op.entryId} is a ${src.fit} design; the site is a ${site.fit} lot` } });
    const cfg = this.host.config;
    const scratch = path.join(cfg.dataDir, 'sitevariant-scratch', id);
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    const base = `${op.entryId}_site_${slugify(site.lotId ?? site.volumeSha.slice(0, 8)).slice(0, 24)}`.slice(0, 64);
    const bp = freeLibraryId(cfg.libraryDir, base, this.taken);
    this.taken.add(bp);
    try {
      const work = fs.realpathSync(scratch);
      refreshKit(cfg.kitDir, work);
      const design = path.join(work, KIT, 'designs', `${bp}.mjs`);
      fs.writeFileSync(design, withDesignId(normalizeKitImports(fs.readFileSync(src.file, 'utf8')), bp));
      const ownBible = path.join(src.dir, 'bible');
      if (!src.bundled && fs.existsSync(ownBible)) fs.cpSync(ownBible, path.join(work, 'bible'), { recursive: true });
      writeSiteFiles(work, keepSiteVolume(cfg.dataDir, this.host.blobs, site), site);
      const entry = src.entry;
      const values = entry.values && typeof entry.values === 'object' ? (entry.values as Record<string, unknown>) : {};
      const palette = entry.palette;
      const extra = [
        ...(palette !== undefined ? ['--palette', typeof palette === 'string' ? palette : JSON.stringify(palette)] : []),
        ...(Object.keys(values).length ? ['--values', JSON.stringify(values)] : []),
        ...SITE_CHECK_ARGS,
      ];
      const type = typeof entry.type === 'string' ? entry.type : undefined;
      const profile = Array.isArray(entry.profile) ? (entry.profile as string[]) : undefined;
      const res = await checkDesign(cfg.kitDir, work, bp, { maxSize: siteSize(site), ...(type ? { type } : {}), ...(profile ? { profile } : {}) }, KIT_TIMEOUT_MS, extra);
      const rule = unfitRule(res);
      if (rule || !res.ok) {
        const site0 = siteResult(res.output);
        const msg = site0?.findings?.[0]?.message ?? res.problem ?? 'the check failed';
        return this.finish(op, { refused: { code: 'SITE_UNFIT', detail: rule ?? 'site_bound', message: `${op.entryId} re-run on site ${site.volumeSha.slice(0, 12)}: ${msg}` } });
      }
      const rp = await renderPreviews(work, res.nbt!, KIT_TIMEOUT_MS);
      if (this.stopped) return;
      const sourceVersion = this.host.entryHead(op.entryId);
      const sc = res.sidecar!;
      const name = typeof entry.name === 'string' ? entry.name : typeof sc.name === 'string' ? sc.name : op.entryId;
      const request = entry.request && typeof entry.request === 'object' ? ({ ...(entry.request as DesignRequest), site } as DesignRequest) : undefined;
      const ext = { ...(isExt(entry.ext) ? (entry.ext as Record<string, unknown>) : {}), [SITE_BINDING_KEY]: siteBinding(site) };
      const installed = installDesign({
        library: cfg.libraryDir,
        baseId: bp,
        taken: new Set([...this.taken].filter((x) => x !== bp)),
        nbt: res.nbt!,
        sidecar: sc,
        source: design,
        previews: rp.files,
        files: [
          ...(fs.existsSync(path.join(work, 'bible')) ? ['bible.json', 'bible.md', 'components.mjs'].filter((f) => fs.existsSync(path.join(work, 'bible', f))).map((f) => ({ from: path.join(work, 'bible', f), to: path.join('bible', f) })) : []),
          ...siteEntryFiles(work),
        ],
        meta: {
          name,
          description: typeof entry.description === 'string' ? entry.description : undefined,
          request,
          createdAt: this.host.now(),
          extra: {
            variantOf: op.entryId,
            variantOfVersion: sourceVersion,
            derivation: { source: op.entryId, sourceVersion, kind: 'site', recipe: { ...(site.lotId ? { lotId: site.lotId } : {}), volumeSha: site.volumeSha, fit: site.fit, frame: site.frame, values } },
            displayName: truncate(`${name} (site ${site.lotId ?? site.volumeSha.slice(0, 8)})`, 80),
            ext,
            siteVariantOp: op.id,
            ...(entry.bible && typeof entry.bible === 'object' ? { bible: entry.bible } : {}),
            ...(profile ? { profile } : {}),
          },
        },
      });
      this.finish(op, { newEntryId: installed.blueprintId });
    } finally {
      this.taken.delete(bp);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** The library entry an operation installed (its id in the entry's siteVariantOp), if a kill came between the install and the record. */
  private installedBy(op: SiteVariantOp): string | undefined {
    const lib = this.host.config.libraryDir;
    if (!fs.existsSync(lib)) return undefined;
    const pre = `${op.entryId}_site_`;
    for (const d of fs.readdirSync(lib).filter((x) => x.startsWith(pre)).sort()) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(lib, d, `${d}.blueprint.json`), 'utf8')) as { siteVariantOp?: string };
        if (j.siteVariantOp === op.id) return d;
      } catch {
        /* not it */
      }
    }
    return undefined;
  }
}

/** A typed site refusal raised inside the runner and the synchronous checks (the ack carries code and detail). */
export class SiteRefused extends RefusedError {
  constructor(code: 'SITE_UNFIT' | 'SITE_UNSUPPORTED', detail: string, message: string) {
    super(code, detail, message);
  }
}
