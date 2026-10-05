// Massings (docs/CONTRACT.md phase 4c, "Sidecar" and "4c review folded in" items 2 and 3): coarse volume designs that are
// approved (or redirected) before the detail pass pays for detail.
//
//   - a massing job is an ordinary design record with `request.massing` and `design.massing = { id, version }` (the id
//     `mas_<slug>` is reserved when the job is made; a redirect keeps the id and makes version + 1). It runs through the
//     designers like any design, but checks with the kit's massing profile (the blueprint says `massing: true`), stays
//     inside request.maxSize (an error) and installs here instead of the library:
//       <massings>/<id>/versions/<v>/   <id>.nbt, <id>.blueprint.json, <id>.mjs, <id>.preview-*.png (+ bible/)
//       <massings>/<id>/                a copy of the latest version
//   - a Massing record per version in state.json (store.data.massings): id, version, itemKey, ext, owner, group, the bible
//     pin, parts, size, request, cost, createdAt, and the latest detail pass made from it
//   - the detail pass (`request.fromMassing`): its check adds `--massing <the version's blueprint.json>` (the kit's
//     conformance check: size-cap errors fail the round, other issues are warnings on the design) and `--max` is
//     min(massing size + 2, request.maxSize) per axis
//   - lifecycle: `massing.delete` removes a massing (every version) at once; garbage collection (at start and hourly)
//     removes a group's massings 7 days after the group is final, a stand-alone one 7 days after its detail design
//     finished, or 30 days after it was made (its latest version) if it was never detailed. A massing in use (a job
//     making or detailing it, or a group that is not final) is never removed.
import fs from 'node:fs';
import path from 'node:path';
import { slugify, type CheckResult, type Limits } from './designs.js';
import { isFinalDesign } from './designs.js';
import { zeroCost } from './jobs/cost.js';
import type { Conformance, Design, DesignRequest, Massing, Outbound } from './protocol.js';
import type { Sidecar } from './sidecar.js';
import { ClientError } from './sidecar.js';

export const MASSING_SNAPSHOT_LIMIT = 20;
const DAY = 24 * 3600_000;
/** a group's massings: this long after the group is final */
export const GC_GROUP_MS = 7 * DAY;
/** a stand-alone massing: this long after its detail design finished */
export const GC_DETAILED_MS = 7 * DAY;
/** a stand-alone massing never detailed: this long after its latest version was made */
export const GC_UNDETAILED_MS = 30 * DAY;
export const GC_INTERVAL_MS = 3600_000;

/** What a detail pass may grow past its massing, per axis (the hard cap, "4c review folded in" item 3). */
export const DETAIL_SIZE_SLACK = 2;

const FINAL_GROUP = new Set(['done', 'failed', 'cancelled']);

export class Massings {
  constructor(private sc: Sidecar) {}

  get dir(): string {
    return this.sc.config.massing.dir;
  }

  private get all(): Massing[] {
    return (this.sc.store.data.massings ??= []);
  }

  /** Every version of a massing, oldest first. */
  versionsOf(id: string): Massing[] {
    return this.all.filter((m) => m.id === id).sort((a, b) => a.version - b.version);
  }

  /** A version (default: the latest). */
  get(id: string, version?: number): Massing | undefined {
    const vs = this.versionsOf(id);
    return version === undefined ? vs.at(-1) : vs.find((m) => m.version === version);
  }

  /** massing.list: the latest version of each massing (of an owner), or every version of one. */
  list(owner?: string, id?: string): Massing[] {
    if (id) return this.versionsOf(id).map((m) => structuredClone(m));
    const latest = new Map<string, Massing>();
    for (const m of this.all) if (!latest.has(m.id) || latest.get(m.id)!.version < m.version) latest.set(m.id, m);
    return [...latest.values()].filter((m) => owner === undefined || m.owner === owner).sort((a, b) => a.createdAt - b.createdAt).map((m) => structuredClone(m));
  }

  /** snapshot.massings: the latest version of every open massing (not detailed, its group not final) plus the last 20. */
  recent(): Massing[] {
    const latest = this.list();
    const tail = latest.slice(-MASSING_SNAPSHOT_LIMIT);
    const open = latest.filter((m) => !tail.includes(m) && this.isOpen(m.id));
    return [...open, ...tail].sort((a, b) => a.createdAt - b.createdAt);
  }

  private isOpen(id: string): boolean {
    const vs = this.versionsOf(id);
    if (vs.some((m) => m.detail?.status === 'done')) return false;
    const g = vs.at(-1)?.group ? this.sc.groups.get(vs.at(-1)!.group!) : undefined;
    return !g || !FINAL_GROUP.has(g.status);
  }

  // ---- ids ----------------------------------------------------------------------------------------

  /** A fresh massing id for a request: mas_<slug of the name, else style_type>, then _2, _3, ... */
  reserveId(req: DesignRequest): string {
    const fromName = req.name ? slugify(req.name) : '';
    const type = req.type === 'custom' ? 'building' : req.type;
    const style = slugify(req.style, 20);
    const base = `mas_${fromName || slugify(style && style !== type ? `${style}_${type}` : type) || 'building'}`;
    const taken = new Set([...this.all.map((m) => m.id), ...this.sc.designs.list().flatMap((d) => (d.massing ? [d.massing.id] : []))]);
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}_${n}`;
      if (!taken.has(id) && !fs.existsSync(path.join(this.dir, id))) return id;
    }
  }

  /** The version a new massing job of `id` makes (after the installed ones). */
  nextVersion(id: string): number {
    return (this.get(id)?.version ?? 0) + 1;
  }

  /** The unfinished massing job of `id`, if one is running or queued. */
  openJob(id: string): Design | undefined {
    return this.sc.designs.active().find((d) => d.massing?.id === id);
  }

  // ---- what a job checks against --------------------------------------------------------------------

  /** The massing a detail design is made from (pinned version), or undefined. */
  sourceOf(d: Design): Massing | undefined {
    const r = d.request;
    return r.fromMassing ? this.get(r.fromMassing, r.massingVersion) : undefined;
  }

  /** The check of a massing or a detail pass: the size cap (the hard one for a detail pass) and the conformance args. */
  checkPlan(d: Design, base: Limits): { limits: Limits; extra: string[] } {
    const r = d.request;
    // the kit's massing profile (`--profile massing`; a sidecar with massing: true gets it anyway), the request's size
    if (r.massing) return { limits: { maxSize: r.maxSize, type: r.type, profile: ['massing'] }, extra: [] };
    const m = this.sourceOf(d);
    if (!m) return { limits: base, extra: [] };
    return { limits: { ...base, maxSize: detailMax(m.size, r.maxSize) }, extra: ['--massing', path.join(m.dir, `${m.id}.blueprint.json`)] };
  }

  /**
   * After the pristine check: a massing must say `massing: true` and have at least 2 named parts; a detail pass records
   * its conformance (errors fail the round, issues stay as warnings). Returns the problem that fails the round, if any.
   */
  checkOutcome(d: Design, res: CheckResult): string | undefined {
    if (d.request.fromMassing) {
      if (res.conformance) this.sc.designs.update(d.id, { conformance: res.conformance });
      else if (res.ok) this.sc.log.warn(`design ${d.id}: the kit printed no massing conformance (does its build.mjs know --massing?)`);
      if (res.ok && res.conformance && (!res.conformance.ok || res.conformance.errors.length)) return `the massing conformance check failed:\n${res.conformance.errors.map((e) => `- ${e}`).join('\n')}`;
    }
    if (!res.ok || !d.request.massing) return undefined;
    const sc = res.sidecar!;
    if (sc.massing !== true) return 'the blueprint is not a massing (`massing: true` is missing): build it with kit/lib/massing.mjs';
    const parts = sc.parts && typeof sc.parts === 'object' ? Object.keys(sc.parts) : [];
    if (parts.length < 2) return `a massing needs at least 2 named masses (it has ${parts.length})`;
    return undefined;
  }

  // ---- install --------------------------------------------------------------------------------------

  /**
   * Install a finished massing job as <massings>/<id>/versions/<v>/ and refresh the latest copy at <massings>/<id>/;
   * record it and send massing.upsert.
   */
  install(d: Design, input: { nbt: string; sidecar: Record<string, unknown>; source: string; previews: string[]; files: Array<{ from: string; to: string }>; createdAt: number }): Massing {
    const { id, version } = d.massing!;
    const r = d.request;
    const top = path.join(this.dir, id);
    const vdir = path.join(top, 'versions', String(version));
    fs.rmSync(vdir, { recursive: true, force: true }); // (a job that crashed mid-install)
    fs.mkdirSync(vdir, { recursive: true });
    const nbt = path.join(vdir, `${id}.nbt`);
    fs.copyFileSync(input.nbt, nbt);
    fs.writeFileSync(path.join(vdir, `${id}.mjs`), fs.readFileSync(input.source, 'utf8').replace(/export\s+const\s+id\s*=\s*(['"`])[^'"`]*\1/, `export const id = '${id}'`));
    const previews: string[] = [];
    for (const p of input.previews) {
      const view = /\.preview-([a-z0-9_-]+)\.png$/i.exec(p)?.[1];
      if (!view) continue;
      const dst = path.join(vdir, `${id}.preview-${view.toLowerCase()}.png`);
      fs.copyFileSync(p, dst);
      previews.push(dst);
    }
    for (const f of input.files) {
      if (!fs.existsSync(f.from)) continue;
      fs.mkdirSync(path.dirname(path.join(vdir, f.to)), { recursive: true });
      fs.copyFileSync(f.from, path.join(vdir, f.to));
    }
    const size = input.sidecar.size as Massing['size'];
    const json: Record<string, unknown> = {
      ...input.sidecar,
      id,
      massing: true,
      version,
      ...(r.name ? { name: r.name } : {}),
      createdAt: input.createdAt,
      request: r,
      source: `${id}.mjs`,
      ...(r.ext && Object.keys(r.ext).length ? { ext: r.ext } : {}),
      ...(r.bible ? { bible: { id: r.bible, version: r.bibleVersion ?? 1 } } : {}),
      ...(r.group ? { group: r.group } : {}),
      ...(r.itemKey ? { groupItem: r.itemKey } : {}),
      ...(r.redirect ? { redirect: r.redirect } : {}),
    };
    for (const k of ['favorite', 'userTags', 'displayName']) delete json[k];
    fs.writeFileSync(path.join(vdir, `${id}.blueprint.json`), `${JSON.stringify(json, null, 2)}\n`);
    // the latest version's copy at <massings>/<id>/ (what a preview by massing id loads)
    for (const f of fs.readdirSync(top)) if (f !== 'versions') fs.rmSync(path.join(top, f), { recursive: true, force: true });
    fs.cpSync(vdir, top, { recursive: true });
    const m: Massing = {
      id,
      version,
      versions: [],
      designId: d.id,
      type: r.type,
      ...(typeof input.sidecar.name === 'string' ? { name: input.sidecar.name } : r.name ? { name: r.name } : {}),
      ...(r.itemKey ? { itemKey: r.itemKey } : {}),
      ...(r.ext && Object.keys(r.ext).length ? { ext: r.ext } : {}),
      ...(r.owner ? { owner: r.owner } : {}),
      ...(r.group ? { group: r.group } : {}),
      ...(r.bible ? { bible: { id: r.bible, version: r.bibleVersion ?? 1 } } : {}),
      parts: (input.sidecar.parts && typeof input.sidecar.parts === 'object' ? input.sidecar.parts : {}) as Record<string, unknown>,
      size: { x: size.x, y: size.y, z: size.z },
      request: structuredClone(r),
      cost: d.cost ?? zeroCost(),
      dir: vdir,
      nbt,
      previews,
      ...(r.redirect ? { redirect: { ...r.redirect } } : {}),
      createdAt: input.createdAt,
    };
    // (a version re-installed after a crash replaces its record)
    const list = this.all;
    const at = list.findIndex((x) => x.id === id && x.version === version);
    if (at >= 0) list.splice(at, 1);
    list.push(m);
    this.syncVersions(id);
    this.sc.store.markDirty();
    this.emit(m);
    return m;
  }

  private syncVersions(id: string): void {
    const vs = this.versionsOf(id);
    for (const m of vs) m.versions = vs.map((x) => x.version);
  }

  private emit(m: Massing): void {
    this.sc.emit({ type: 'massing.upsert', massing: structuredClone(m) } as Outbound);
  }

  /** A design changed: a detail pass made from a massing is recorded on that massing version (its status, entry, when). */
  designChanged(d: Design): void {
    const id = d.request.fromMassing;
    if (!id) return;
    const m = this.get(id, d.request.massingVersion);
    if (!m) return;
    const detail: NonNullable<Massing['detail']> = { designId: d.id, status: d.status, ...(d.blueprintId ? { entryId: d.blueprintId } : {}), ...(isFinalDesign(d) ? { at: d.updatedAt } : {}) };
    if (JSON.stringify(m.detail) === JSON.stringify(detail)) return;
    // an older detail pass does not replace a newer one
    if (m.detail && m.detail.designId !== d.id && Number(m.detail.designId.slice(1)) > Number(d.id.slice(1))) return;
    m.detail = detail;
    this.sc.store.markDirty();
    this.emit(m);
  }

  // ---- delete and garbage collection ----------------------------------------------------------------------

  /** Why a massing cannot be removed now, if it cannot. */
  private inUse(id: string): string | undefined {
    const job = this.sc.designs.active().find((d) => d.massing?.id === id || d.request.fromMassing === id);
    if (job) return `design ${job.id} is ${job.massing ? 'making' : 'detailing'} it`;
    const gid = this.get(id)?.group;
    const g = gid ? this.sc.groups.get(gid) : undefined;
    if (g && !FINAL_GROUP.has(g.status)) return `its group ${g.id} is not finished (cancel the item or the group first)`;
    return undefined;
  }

  /** massing.delete: every version, at once (refused while it is in use). */
  delete(id: string): number {
    const vs = this.versionsOf(id);
    if (!vs.length) throw new ClientError(`no massing "${id}"`);
    const why = this.inUse(id);
    if (why) throw new ClientError(`massing ${id} is in use: ${why}`);
    this.remove(id, 'deleted');
    return vs.length;
  }

  private remove(id: string, reason: 'deleted' | 'gc'): void {
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    const keep = this.all.filter((m) => m.id !== id);
    this.sc.store.data.massings = keep;
    this.sc.store.markDirty();
    this.sc.log.info(`massing ${id} ${reason === 'gc' ? 'garbage-collected' : 'deleted'}`);
    this.sc.emit({ type: 'massing.removed', massingId: id, reason } as Outbound);
  }

  /** When a massing expires (epoch ms), or undefined while it must stay. */
  expiresAt(id: string): number | undefined {
    if (this.inUse(id)) return undefined;
    const vs = this.versionsOf(id);
    const latest = vs.at(-1);
    if (!latest) return undefined;
    if (latest.group) {
      const g = this.sc.groups.get(latest.group);
      // (a group trimmed from state.json: the stand-alone 30-day rule)
      if (g) return FINAL_GROUP.has(g.status) ? g.updatedAt + GC_GROUP_MS : undefined;
      return latest.createdAt + GC_UNDETAILED_MS;
    }
    const detailed = vs.map((m) => m.detail).filter((x): x is NonNullable<Massing['detail']> => x?.status === 'done' && x.at !== undefined);
    if (detailed.length) return Math.max(...detailed.map((x) => x.at!)) + GC_DETAILED_MS;
    return latest.createdAt + GC_UNDETAILED_MS;
  }

  /** Remove the expired massings; returns their ids. */
  gc(now = this.sc.now()): string[] {
    const gone: string[] = [];
    for (const id of new Set(this.all.map((m) => m.id))) {
      const at = this.expiresAt(id);
      if (at !== undefined && now >= at) {
        this.remove(id, 'gc');
        gone.push(id);
      }
    }
    return gone;
  }
}

/** The hard size cap of a detail pass: min(massing size + 2, request.maxSize) per axis. */
export function detailMax(size: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: Math.min(size.x + DETAIL_SIZE_SLACK, max.x), y: Math.min(size.y + DETAIL_SIZE_SLACK, max.y), z: Math.min(size.z + DETAIL_SIZE_SLACK, max.z) };
}

/** One line for a design's step: the conformance warnings. */
export function conformanceNote(c: Conformance | undefined): string {
  return c && c.issues.length ? `${c.issues.length} conformance warning(s)` : '';
}
