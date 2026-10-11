// Style bibles (docs/CONTRACT.md phase 4b, "Style bible (A1)" and "Component library and named parts (R3)"):
//
//   BibleIndex   the installed bibles in <gameDir>/architect/bibles/<id>/ (the library dir's sibling) plus the built-in
//                ones (the kit's palette presets, `kit/tools/bible.mjs builtin`); resolves a reference to a pinned
//                version and its files
//   Bibles       bible jobs (`bible.request`, `bible.revise`): their records (`bible.upsert`, snapshot.bibles), and the
//                job itself, which holds one pool slot:
//                  1. drafting    a structured pass writes the bible JSON (roles, proportions, ...) and its prose; the kit
//                                 validates it (`kit/tools/bible.mjs validate`: roles are vanilla blocks and build a
//                                 palette, macro roles for a settlement); one re-ask on a miss
//                  2. components  an agent pass in a scratch kit writes bible/components.mjs (starting from the
//                                 reference library, the seed's, or the previous version's)
//                  3. checking    the pristine kit's component frame (`kit/tools/components.mjs`) builds every component,
//                                 checks it and renders sheet.png; a failure goes back to the agent, 3 rounds in all
//                  4. install     <bibles>/<id>/versions/<v>/ (never overwritten) and a copy at <bibles>/<id>/ (latest)
//
// The backends: the Claude one (claude/bible.ts) and the sim (a fixed bible plus the reference components, through the
// real component check and sheet).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BibleInfo, BibleJob, BibleJobStatus, BibleRef, BibleRequest, BiblePin, Cost, Outbound } from './protocol.js';
import { BibleInfo as BibleInfoSchema } from './protocol.js';
import { KIT, minimalEnv, outputTail, refreshKit, runNode, slugify } from './designs.js';
import { copyBible } from './scratch.js';
import { zeroCost } from './jobs/cost.js';
import type { Sidecar } from './sidecar.js';
import { ClientError } from './sidecar.js';
import { keptForKey } from './opkeys.js';
import { truncate } from './util/text.js';

export const BIBLE_SNAPSHOT_LIMIT = 20;
const BIBLE_KEEP = 100;
export const MAX_BIBLE_ROUNDS = 3;
const KIT_TIMEOUT_MS = 180_000;
const FINAL: ReadonlySet<BibleJobStatus> = new Set(['done', 'failed', 'cancelled']);
export const isFinalBibleJob = (j: BibleJob): boolean => FINAL.has(j.status);
export const CORE_ROLES = ['wall', 'wall_alt', 'trim', 'roof', 'floor', 'frame', 'accent', 'light', 'glass', 'foundation', 'path'] as const;
export const MACRO_ROLES = ['rock', 'surface', 'subsurface', 'rubble', 'rail', 'structure'] as const;
export const REQUIRED_COMPONENTS = ['window', 'door_surround', 'lantern_post', 'roof_trim', 'chimney'] as const;
/** the files of a bible (version) folder */
export const BIBLE_FILES = ['bible.json', 'bible.md', 'components.mjs', 'sheet.png'] as const;

/** 'critique' (5a): the design gave its slot back while its critic call runs (critique.ts re-queues the revision) */
export type RunOutcome = 'finished' | 'requeue' | 'stopped' | 'critique';

// ---- the index ------------------------------------------------------------------------------------

/** Hero motifs that are among the motifs (at most 3); none: the first 3 motifs. */
function heroesOf(heroes: string[], motifs: unknown[]): string[] {
  const ok = heroes.filter((m) => motifs.includes(m)).slice(0, 3);
  return ok.length ? ok : motifs.filter((m): m is string => typeof m === 'string').slice(0, 3);
}

export const DEFAULT_RESTRAINT = { accentShareMax: 0.12, detailDensity: 'moderate' as const, windowsPerFacadeMin: 2 };

/** (5a) A bible's effective restraint: format 2's own (defaults filled in); format 1: the defaults, hero motifs = its first 3 motifs. */
export function restraintOf(j: Record<string, unknown>): { heroMotifs: string[]; accentShareMax: number; detailDensity: 'sparse' | 'moderate' | 'rich'; windowsPerFacadeMin: number } {
  const motifs = (Array.isArray(j.motifs) ? j.motifs : []).map((m) => (typeof m === 'string' ? m : typeof (m as { name?: unknown })?.name === 'string' ? (m as { name: string }).name : JSON.stringify(m)));
  const r = (j.format === 2 && j.restraint && typeof j.restraint === 'object' ? j.restraint : {}) as Record<string, unknown>;
  const hero = Array.isArray(r.heroMotifs) ? (r.heroMotifs as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 3) : motifs.slice(0, 3);
  const asm = typeof r.accentShareMax === 'number' && r.accentShareMax >= 0.04 && r.accentShareMax <= 0.2 ? r.accentShareMax : DEFAULT_RESTRAINT.accentShareMax;
  const dd = r.detailDensity === 'sparse' || r.detailDensity === 'moderate' || r.detailDensity === 'rich' ? r.detailDensity : DEFAULT_RESTRAINT.detailDensity;
  const wmin = typeof r.windowsPerFacadeMin === 'number' && Number.isInteger(r.windowsPerFacadeMin) && r.windowsPerFacadeMin >= 0 ? r.windowsPerFacadeMin : DEFAULT_RESTRAINT.windowsPerFacadeMin;
  return { heroMotifs: hero, accentShareMax: asm, detailDensity: dd, windowsPerFacadeMin: wmin };
}

export interface BibleFiles {
  json: string;
  md?: string | undefined;
  components: string;
  sheet?: string | undefined;
}

export interface Resolved {
  pin: BiblePin;
  files: BibleFiles;
  info: BibleInfo;
}

interface BuiltinRecord {
  id: string;
  name: string;
  version: number;
  scope?: string;
  roles: Record<string, string>;
  components?: string[];
  componentsFile?: string | null;
}

const readJson = (f: string): Record<string, unknown> | undefined => {
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8')) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

export class BibleIndex {
  private builtins: BuiltinRecord[] | undefined;

  constructor(private sc: Sidecar) {}

  get dir(): string {
    return this.sc.config.biblesDir;
  }

  /** The kit's built-in bibles (once; `kit/tools/bible.mjs builtin`), with a bible.json written under <data>/builtin-bibles/. */
  private loadBuiltins(): BuiltinRecord[] {
    if (this.builtins) return this.builtins;
    const tool = path.join(this.sc.config.kitDir, 'tools', 'bible.mjs');
    let list: BuiltinRecord[] = [];
    if (fs.existsSync(tool)) {
      const r = spawnSync(process.execPath, [tool, 'builtin'], { cwd: this.sc.config.kitDir, env: minimalEnv(), encoding: 'utf8', timeout: 30_000 });
      try {
        const j = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as { bibles?: BuiltinRecord[] };
        list = Array.isArray(j.bibles) ? j.bibles.filter((b) => typeof b.id === 'string' && b.roles && typeof b.roles === 'object') : [];
      } catch {
        this.sc.log.warn(`kit bible.mjs builtin: unexpected output (${truncate(`${r.stdout}${r.stderr}`, 200)})`);
      }
    }
    this.builtins = list;
    return list;
  }

  /** The reference components of the kit (a built-in bible without its own uses them: they read the roles). */
  referenceComponents(name?: string): string | undefined {
    const b = name ? this.loadBuiltins().find((x) => x.id === name) : undefined;
    if (b?.componentsFile && fs.existsSync(b.componentsFile)) return b.componentsFile;
    const ref = path.join(this.sc.config.kitDir, 'bibles', 'rustic', 'components.mjs');
    return fs.existsSync(ref) ? ref : undefined;
  }

  private builtinFiles(b: BuiltinRecord): BibleFiles {
    const dir = path.join(this.sc.config.dataDir, 'builtin-bibles', b.id);
    fs.mkdirSync(dir, { recursive: true });
    const json = path.join(dir, 'bible.json');
    const { componentsFile: _c, ...rest } = b;
    fs.writeFileSync(json, `${JSON.stringify(rest, null, 2)}\n`);
    return { json, components: this.referenceComponents(b.id) ?? '' };
  }

  private builtinInfo(b: BuiltinRecord): BibleInfo {
    return { id: b.id, name: b.name, version: b.version ?? 1, versions: [b.version ?? 1], builtin: true, scope: b.scope === 'settlement' ? 'settlement' : 'building', roles: { ...b.roles }, components: b.components?.length ? [...b.components] : [...REQUIRED_COMPONENTS] };
  }

  /** The versions installed for an id, ascending. */
  versions(id: string): number[] {
    try {
      return fs
        .readdirSync(path.join(this.dir, id, 'versions'))
        .filter((v) => /^\d+$/.test(v) && fs.existsSync(path.join(this.dir, id, 'versions', v, 'bible.json')))
        .map(Number)
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  isBuiltin(id: string): boolean {
    return this.loadBuiltins().some((b) => b.id === id);
  }

  /** Is the id free for a new bible (not installed, not built in, not reserved by an unfinished job)? */
  taken(id: string): boolean {
    return this.isBuiltin(id) || fs.existsSync(path.join(this.dir, id)) || this.sc.bibles.reserved().has(id);
  }

  private versionDir(id: string, v: number): string {
    return path.join(this.dir, id, 'versions', String(v));
  }

  /** The info of an installed version (from its folder). */
  private installedInfo(id: string, v: number): BibleInfo | undefined {
    const dir = this.versionDir(id, v);
    const j = readJson(path.join(dir, 'bible.json'));
    if (!j) return undefined;
    let prose: string | undefined;
    try {
      prose = truncate(fs.readFileSync(path.join(dir, 'bible.md'), 'utf8'), 8000);
    } catch {
      /* none */
    }
    const info = {
      id,
      name: typeof j.name === 'string' ? j.name : id,
      version: v,
      versions: this.versions(id),
      builtin: false,
      scope: j.scope === 'settlement' ? 'settlement' : 'building',
      ...(typeof j.prompt === 'string' ? { prompt: j.prompt } : {}),
      roles: (j.roles && typeof j.roles === 'object' ? j.roles : {}) as Record<string, string>,
      ...(prose !== undefined ? { prose } : {}),
      ...(fs.existsSync(path.join(dir, 'sheet.png')) ? { sheetPath: path.join(dir, 'sheet.png') } : {}),
      dir,
      components: Array.isArray(j.components) ? (j.components as string[]) : [...REQUIRED_COMPONENTS],
      ...(typeof j.owner === 'string' ? { owner: j.owner } : {}),
      ...(j.ext && typeof j.ext === 'object' ? { ext: j.ext } : {}),
      ...(typeof j.createdAt === 'number' ? { createdAt: j.createdAt } : {}),
      ...(j.cost && typeof j.cost === 'object' ? { cost: j.cost } : {}),
      format: j.format === 2 ? 2 : 1,
      restraint: restraintOf(j),
      ...(this.archived(id) ? { archived: true } : {}),
      ...(j.critique && typeof j.critique === 'object' ? { critique: j.critique } : {}),
    };
    const r = BibleInfoSchema.safeParse(info);
    return r.success ? r.data : undefined;
  }

  /** Every installed bible (its latest version), then the built-in ones. */
  list(): BibleInfo[] {
    const out: BibleInfo[] = [];
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(this.dir).filter((d) => /^[a-z0-9_]{1,64}$/.test(d)).sort();
    } catch {
      /* no bibles yet */
    }
    for (const id of ids) {
      const v = this.versions(id).pop();
      const info = v !== undefined ? this.installedInfo(id, v) : undefined;
      if (info) out.push(info);
    }
    for (const b of this.loadBuiltins()) if (!ids.includes(b.id)) out.push(this.builtinInfo(b));
    return out;
  }

  get(id: string, version?: number): BibleInfo | undefined {
    const vs = this.versions(id);
    if (vs.length) {
      const v = version ?? vs[vs.length - 1]!;
      return vs.includes(v) ? this.installedInfo(id, v) : undefined;
    }
    const b = this.loadBuiltins().find((x) => x.id === id);
    return b && (version === undefined || version === (b.version ?? 1)) ? this.builtinInfo(b) : undefined;
  }

  /** A bible reference -> its pinned version and files; ClientError when there is no such bible / version. */
  resolve(ref: BibleRef | BiblePin): Resolved {
    const id = typeof ref === 'string' ? ref : ref.id;
    const version = typeof ref === 'string' ? undefined : ref.version;
    const vs = this.versions(id);
    if (vs.length) {
      const v = version ?? vs[vs.length - 1]!;
      if (!vs.includes(v)) throw new ClientError(`bible ${id} has no version ${v} (has ${vs.join(', ')})`);
      const dir = this.versionDir(id, v);
      const info = this.installedInfo(id, v);
      if (!info) throw new ClientError(`bible ${id} v${v}: its bible.json is unreadable`);
      return { pin: { id, version: v }, files: { json: path.join(dir, 'bible.json'), md: path.join(dir, 'bible.md'), components: path.join(dir, 'components.mjs'), sheet: path.join(dir, 'sheet.png') }, info };
    }
    const b = this.loadBuiltins().find((x) => x.id === id);
    if (b) {
      if (version !== undefined && version !== (b.version ?? 1)) throw new ClientError(`the built-in bible ${id} has only version ${b.version ?? 1}`);
      return { pin: { id, version: b.version ?? 1 }, files: this.builtinFiles(b), info: this.builtinInfo(b) };
    }
    throw new ClientError(`no bible "${id}" (installed in ${this.dir}, or a built-in one: ${this.loadBuiltins().map((x) => x.id).join(', ') || 'none'})`);
  }

  // ---- (5a) library hygiene: archive, delete, version GC ---------------------------------------------

  private adminFile(id: string): string {
    return path.join(this.dir, id, 'admin.json');
  }

  archived(id: string): boolean {
    return readJson(this.adminFile(id))?.archived === true;
  }

  /** bible.archive: hide it from the pickers (its entries and re-skins are unaffected). */
  archive(id: string, archived: boolean): { id: string; archived: boolean } {
    if (this.isBuiltin(id) && !this.versions(id).length) throw new ClientError(`${id} is a built-in bible: it cannot be archived`);
    if (!this.versions(id).length) throw new ClientError(`no bible "${id}"`);
    const f = this.adminFile(id);
    const cur = readJson(f) ?? {};
    fs.writeFileSync(f, `${JSON.stringify({ ...cur, archived }, null, 2)}\n`);
    this.sc.log.info(`bible ${id} ${archived ? 'archived' : 'unarchived'}`);
    this.sc.bibleIndexChanged();
    return { id, archived };
  }

  /**
   * What pins a bible's versions: library entries (their blueprint JSON `bible`), unfinished groups and designs, open
   * massings, unfinished bible jobs.
   */
  pins(id: string): { versions: Set<number>; by: string[] } {
    const versions = new Set<number>();
    const by: string[] = [];
    const lib = this.sc.config.libraryDir;
    for (const e of fs.existsSync(lib) ? fs.readdirSync(lib) : []) {
      const j = readJson(path.join(lib, e, `${e}.blueprint.json`));
      const b = j?.bible as { id?: string; version?: number } | undefined;
      if (b?.id === id) {
        versions.add(b.version ?? 1);
        by.push(`entry ${e}`);
      }
    }
    for (const g of this.sc.groups.active()) if (g.bible.id === id) {
      versions.add(g.bible.version);
      by.push(`group ${g.id}`);
    }
    for (const d of this.sc.designs.active()) if (d.request.bible === id && !d.request.group) {
      versions.add(d.request.bibleVersion ?? 1);
      by.push(`design ${d.id}`);
    }
    for (const m of this.sc.massings.list()) if (m.bible?.id === id && !m.detail) {
      versions.add(m.bible.version);
      by.push(`massing ${m.id}`);
    }
    for (const j of this.sc.bibles.active()) if (j.bibleId === id) by.push(`bible job ${j.id}`);
    return { versions, by: [...new Set(by)] };
  }

  /** bible.delete: refused while anything pins it, or for another owner's bible without that owner. No force flag. */
  delete(id: string, owner?: string): { id: string; versions: number[] } {
    const vs = this.versions(id);
    if (!vs.length) throw new ClientError(this.isBuiltin(id) ? `${id} is a built-in bible: it cannot be deleted` : `no bible "${id}"`);
    const info = this.installedInfo(id, vs[vs.length - 1]!);
    if (info?.owner && info.owner !== owner) throw new ClientError(`bible ${id} belongs to ${info.owner}: only its owner can delete it`);
    const p = this.pins(id);
    if (p.by.length) throw new ClientError(`bible ${id} is in use, delete refused: ${p.by.slice(0, 12).join(', ')}${p.by.length > 12 ? `, and ${p.by.length - 12} more` : ''}`);
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    this.sc.log.info(`bible ${id} deleted (versions ${vs.join(', ')})`);
    this.sc.bibleIndexChanged();
    return { id, versions: vs };
  }

  /**
   * Version GC (at sidecar start): a version that is neither the latest nor pinned, and older than `maxAgeMs`, loses its
   * versions/<v>/ folder. Pins always win.
   */
  gc(maxAgeMs = 30 * 24 * 3600_000): string[] {
    const removed: string[] = [];
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(this.dir).filter((d) => /^[a-z0-9_]{1,64}$/.test(d));
    } catch {
      return removed;
    }
    const now = this.sc.now();
    for (const id of ids) {
      const vs = this.versions(id);
      if (vs.length < 2) continue;
      const latest = vs[vs.length - 1]!;
      const pinned = this.pins(id).versions;
      for (const v of vs) {
        if (v === latest || pinned.has(v)) continue;
        const j = readJson(path.join(this.versionDir(id, v), 'bible.json'));
        const at = typeof j?.createdAt === 'number' ? j.createdAt : fs.statSync(this.versionDir(id, v)).mtimeMs;
        if (now - at < maxAgeMs) continue;
        fs.rmSync(this.versionDir(id, v), { recursive: true, force: true });
        removed.push(`${id} v${v}`);
      }
    }
    if (removed.length) this.sc.log.info(`bible version gc: removed ${removed.join(', ')}`);
    return removed;
  }

  /** Copy a bible's files into <scratch>/bible/ (bible.json, bible.md, components.mjs), replacing what is there. */
  copyInto(files: BibleFiles, scratch: string): void {
    copyBible(files, scratch);
  }

  /**
   * Install a finished version from `src` (a folder with BIBLE_FILES): <bibles>/<id>/versions/<v>/ is created
   * exclusively (a version is never overwritten), then copied to <bibles>/<id>/ as the latest.
   */
  install(id: string, version: number, src: string): string {
    const vdir = this.versionDir(id, version);
    fs.mkdirSync(path.dirname(vdir), { recursive: true });
    fs.mkdirSync(vdir); // EEXIST: that version exists already
    try {
      for (const f of BIBLE_FILES) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(vdir, f), fs.constants.COPYFILE_EXCL);
    } catch (e) {
      fs.rmSync(vdir, { recursive: true, force: true });
      throw e;
    }
    const top = path.join(this.dir, id);
    for (const f of BIBLE_FILES) {
      if (fs.existsSync(path.join(vdir, f))) fs.copyFileSync(path.join(vdir, f), path.join(top, f));
      else fs.rmSync(path.join(top, f), { force: true });
    }
    return vdir;
  }
}

// ---- jobs -----------------------------------------------------------------------------------------

/** A bible job's own progress (survives a restart). */
export interface BibleWork {
  /** the validated, normalised bible JSON once drafted (with id, version, prompt, ...) */
  bible?: Record<string, unknown>;
  prose?: string;
  /** the structured pass's session (a re-ask resumes it) */
  draftSession?: string;
  /** structured re-asks after the kit refused the draft */
  draftRetries: number;
  /** component rounds started */
  round: number;
  /** what the last component check said (the next round's prompt) */
  problem?: string;
  cost: Cost;
  startedAt?: number;
  /** (6c 0a) sim only: the notional bible cost charged so far (simCosts) */
  simCharged?: number;
}

/** What a backend gets for one pass. */
export interface BiblePass {
  job: BibleJob;
  work: BibleWork;
  scratch: string;
  /** what is left of the job's budget (undefined: no budget) */
  budgetLeft?: number | undefined;
  /** the kit refused the last draft: its errors (a re-ask) */
  retryErrors?: string[] | undefined;
  /** a component round after a failed check: the problem */
  problem?: string | undefined;
}

export type PassResult = { ok: true } | { ok: false; outcome: RunOutcome; error?: string };
export type DraftResult = { ok: true; bible: Record<string, unknown>; prose: string } | { ok: false; outcome: RunOutcome; error?: string };

export interface BibleBackend {
  readonly name: 'claude' | 'sim';
  draft(p: BiblePass): Promise<DraftResult>;
  components(p: BiblePass): Promise<PassResult>;
  cancel(jobId: string): void;
}

export class Bibles {
  backend: BibleBackend | undefined;
  private cancelled = new Set<string>();

  constructor(private sc: Sidecar) {}

  private get all(): BibleJob[] {
    return (this.sc.store.data.bibleJobs ??= []);
  }

  private get works(): Record<string, BibleWork> {
    return (this.sc.store.data.bibleWork ??= {});
  }

  work(id: string): BibleWork | undefined {
    return this.works[id];
  }

  get(id: string): BibleJob | undefined {
    return this.all.find((j) => j.id === id);
  }

  list(): BibleJob[] {
    return this.all;
  }

  active(): BibleJob[] {
    return this.all.filter((j) => !isFinalBibleJob(j));
  }

  recent(): BibleJob[] {
    const tail = this.all.slice(-BIBLE_SNAPSHOT_LIMIT);
    const extra = this.active().filter((j) => !tail.includes(j));
    return [...extra, ...tail].sort((a, b) => a.createdAt - b.createdAt).map((j) => structuredClone(j));
  }

  /** bible ids unfinished jobs are about to install */
  reserved(): Set<string> {
    return new Set(this.active().filter((j) => j.kind === 'request').map((j) => j.bibleId));
  }

  update(id: string, patch: Partial<Pick<BibleJob, 'status' | 'step' | 'error' | 'cost' | 'rounds' | 'usageLimitUntil' | 'bible'>>): BibleJob | undefined {
    const j = this.get(id);
    if (!j || isFinalBibleJob(j)) return j;
    let changed = false;
    for (const [k, v0] of Object.entries(patch) as Array<[keyof typeof patch, unknown]>) {
      if (v0 === undefined) continue;
      const v = k === 'step' || k === 'error' ? truncate(String(v0).replace(/\s+/g, ' ').trim(), k === 'step' ? 120 : 1500) : v0;
      if (JSON.stringify(j[k]) !== JSON.stringify(v)) {
        (j as Record<string, unknown>)[k] = v;
        changed = true;
      }
    }
    if (patch.status && patch.status !== 'queued' && j.usageLimitUntil !== undefined && patch.usageLimitUntil === undefined) {
      delete j.usageLimitUntil;
      changed = true;
    }
    if (changed) {
      j.updatedAt = this.sc.now();
      // a bible job that just became final is on disk before any client hears of it (as DesignBook.update): after a
      // crash between the emit and a later flush the restart would re-queue the installed bible's job and run its paid
      // components round again
      if (isFinalBibleJob(j)) this.sc.store.flush();
      else this.sc.store.markDirty();
      this.sc.emit({ type: 'bible.upsert', bible: structuredClone(j) } as Outbound);
    }
    return j;
  }

  private create(kind: BibleJob['kind'], bibleId: string, version: number, request: BibleJob['request']): BibleJob {
    const now = this.sc.now();
    const j: BibleJob = { id: this.sc.store.nextId('b'), kind, bibleId, version, request: structuredClone(request), status: 'queued', step: 'waiting for a design slot', cost: zeroCost(), ...(request.opKey ? { opKey: request.opKey } : {}), createdAt: now, updatedAt: now };
    this.all.push(j);
    this.works[j.id] = { draftRetries: 0, round: 0, cost: zeroCost() };
    while (this.all.length > BIBLE_KEEP) {
      // (6c 0a) a job with an opKey is kept at least 30 days after it is final
      const k = this.all.findIndex((x) => isFinalBibleJob(x) && !keptForKey(x, now));
      if (k < 0) break;
      const [gone] = this.all.splice(k, 1);
      if (gone) delete this.works[gone.id];
    }
    this.sc.store.markDirty();
    this.sc.emit({ type: 'bible.upsert', bible: structuredClone(j) } as Outbound);
    this.sc.scheduler.enqueueBible(j.id);
    return j;
  }

  /** bible.request: reserve an id (bib_<slug of the name, else the prompt>) and queue the job. */
  request(req: BibleRequest): BibleJob {
    this.sc.ensureClaudeAvailable();
    if (req.seedPreset && !this.sc.bibleIndex.isBuiltin(req.seedPreset)) throw new ClientError(`seedPreset "${req.seedPreset}" is not a built-in bible (${this.sc.bibleIndex.list().filter((b) => b.builtin).map((b) => b.id).join(', ')})`);
    for (const r of req.references ?? []) if (!fs.existsSync(path.join(this.sc.config.libraryDir, r, `${r}.blueprint.json`))) throw new ClientError(`reference "${r}" is not in the library`);
    const base = `bib_${slugify(req.name ?? req.prompt.split(/\s+/).slice(0, 4).join(' '), 28) || 'bible'}`;
    let id = base;
    for (let n = 2; this.sc.bibleIndex.taken(id); n++) id = `${base}_${n}`;
    const j = this.create('request', id, 1, req);
    this.sc.log.info(`bible job ${j.id} requested: ${id} ("${truncate(req.prompt, 80)}")`);
    return j;
  }

  /** bible.revise: version + 1 of an installed bible, from the notes. */
  revise(id: string, notes: string, model?: string, budgetUsd?: number, critique?: BibleJob['request']['critique']): BibleJob {
    this.sc.ensureClaudeAvailable();
    const vs = this.sc.bibleIndex.versions(id);
    if (!vs.length) throw new ClientError(this.sc.bibleIndex.isBuiltin(id) ? `${id} is a built-in bible: request a new bible with seedPreset "${id}" instead` : `no bible "${id}"`);
    if (this.active().some((j) => j.bibleId === id)) throw new ClientError(`bible ${id} is being made or revised already`);
    const info = this.sc.bibleIndex.get(id)!;
    const req: BibleJob['request'] = { prompt: info.prompt ?? info.name, name: info.name, notes, ...(model ? { model } : {}), ...(budgetUsd !== undefined ? { budgetUsd } : {}), ...(info.owner ? { owner: info.owner } : {}), ...(info.scope === 'settlement' ? { scope: 'settlement' as const } : {}), ...(critique ? { critique } : {}) };
    const j = this.create('revise', id, vs[vs.length - 1]! + 1, req);
    this.sc.log.info(`bible job ${j.id}: revise ${id} -> v${j.version}`);
    return j;
  }

  cancel(jobId: string): BibleJob {
    const j = this.get(jobId);
    if (!j) throw new ClientError(`no bible job "${jobId}"`);
    if (isFinalBibleJob(j)) throw new ClientError(`bible job ${jobId} is already ${j.status}`);
    this.update(jobId, { status: 'cancelled', step: 'cancelled' });
    this.sc.pool.withdraw(`bible:${jobId}`);
    this.cancelled.add(jobId);
    this.backend?.cancel(jobId);
    return j;
  }

  /** May a bible job start (the designer can run turns)? */
  ready(_id: string): boolean {
    return this.sc.designerReady();
  }

  /** Auth failed for good: what waits fails with the reason. */
  failWaiting(why: string): void {
    for (const k of this.sc.pool.waitingKeys('bibles')) {
      const id = k.slice('bible:'.length);
      this.sc.pool.withdraw(k);
      this.fail(id, why);
    }
  }

  /** After a restart: queue the unfinished jobs again. */
  start(): void {
    for (const j of this.active()) {
      this.update(j.id, { status: 'queued', step: 'picked up again after a restart' });
      this.sc.scheduler.enqueueBible(j.id);
    }
  }

  private fail(id: string, error: string, step?: string): void {
    this.update(id, { status: 'failed', step: step ?? `failed: ${error.split('\n')[0]}`, error });
    this.sc.log.warn(`bible job ${id} failed: ${truncate(error.split('\n')[0] ?? error, 200)}`);
  }

  private stopped(id: string): boolean {
    const j = this.get(id);
    return !j || isFinalBibleJob(j) || this.cancelled.has(id);
  }

  scratchDir(id: string): string {
    return path.join(this.sc.config.dataDir, 'bibles', id);
  }

  /**
   * The job's scratch dir: a fresh kit, BIBLE.md, CONTRACT.md, and bible/components.mjs to start from (the previous
   * version's for a revise, the seed's, else the kit's reference library). Kept across restarts.
   */
  prepare(j: BibleJob): string {
    fs.mkdirSync(this.scratchDir(j.id), { recursive: true });
    const scratch = fs.realpathSync(this.scratchDir(j.id));
    refreshKit(this.sc.config.kitDir, scratch);
    const bdir = path.join(scratch, 'bible');
    fs.mkdirSync(bdir, { recursive: true });
    const comp = path.join(bdir, 'components.mjs');
    if (!fs.existsSync(comp)) {
      if (j.kind === 'revise') {
        const prev = this.sc.bibleIndex.resolve({ id: j.bibleId, version: j.version - 1 });
        fs.mkdirSync(path.join(scratch, 'previous'), { recursive: true });
        for (const f of Object.values(prev.files)) if (f && fs.existsSync(f)) fs.copyFileSync(f, path.join(scratch, 'previous', path.basename(f)));
        if (fs.existsSync(prev.files.components)) fs.copyFileSync(prev.files.components, comp);
      }
      if (!fs.existsSync(comp)) {
        const ref = this.sc.bibleIndex.referenceComponents(j.request.seedPreset);
        if (ref) fs.copyFileSync(ref, comp);
      }
    }
    return scratch;
  }

  /** The pristine-kit component check: fresh kit, our own bible.json, `kit/tools/components.mjs ... --out sheet --json`. */
  async checkComponents(scratch: string, w: BibleWork): Promise<{ ok: boolean; problem?: string; sheet?: string; warnings: string[]; components: string[] }> {
    refreshKit(this.sc.config.kitDir, scratch);
    this.writeBible(scratch, w);
    const out = path.join(scratch, 'sheet');
    fs.rmSync(out, { recursive: true, force: true });
    const tool = path.join(KIT, 'tools', 'components.mjs');
    if (!fs.existsSync(path.join(scratch, tool))) return { ok: false, problem: 'this kit has no tools/components.mjs', warnings: [], components: [] };
    const r = await runNode(tool, [path.join('bible', 'components.mjs'), '--bible', path.join('bible', 'bible.json'), '--out', out, '--json'], scratch, KIT_TIMEOUT_MS);
    let j: { ok?: boolean; errors?: string[]; warnings?: string[]; components?: Array<{ name: string; ok: boolean }>; sheet?: string } | undefined;
    try {
      j = JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '');
    } catch {
      j = undefined;
    }
    const warnings = j?.warnings ?? [];
    const components = (j?.components ?? []).map((c) => c.name);
    if (!r.ok || !j?.ok) {
      const detail = j?.errors?.length ? j.errors.map((e) => `- ${e}`).join('\n') : outputTail(r.output);
      return { ok: false, problem: `the component check failed${r.timedOut ? ' (timed out)' : ''}:\n${truncate(detail, 1500)}${warnings.length ? `\nwarnings:\n${truncate(warnings.map((x) => `- ${x}`).join('\n'), 600)}` : ''}`, warnings, components };
    }
    const sheet = j.sheet && fs.existsSync(j.sheet) ? j.sheet : undefined;
    if (!sheet) return { ok: false, problem: 'the component check wrote no sheet.png', warnings, components };
    return { ok: true, sheet, warnings, components };
  }

  /** Write the drafted bible (bible/bible.json, bible/bible.md) from the job's own copy (the agent cannot change them). */
  writeBible(scratch: string, w: BibleWork): void {
    if (!w.bible) return;
    fs.mkdirSync(path.join(scratch, 'bible'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'bible', 'bible.json'), `${JSON.stringify(w.bible, null, 2)}\n`);
    fs.writeFileSync(path.join(scratch, 'bible', 'bible.md'), `${(w.prose ?? '').trim()}\n`);
  }

  /** Validate a draft with the kit (roles, palette, schema); returns the normalised bible or the errors. */
  async validate(scratch: string, draft: Record<string, unknown>, scope: string): Promise<{ ok: true; bible: Record<string, unknown> } | { ok: false; errors: string[] }> {
    const f = path.join(scratch, 'draft.json');
    const out = path.join(scratch, 'draft.normalised.json');
    fs.writeFileSync(f, JSON.stringify(draft, null, 2));
    fs.rmSync(out, { force: true });
    const tool = path.join(KIT, 'tools', 'bible.mjs');
    const r = await runNode(tool, ['validate', f, '--scope', scope, '--write', out], scratch, KIT_TIMEOUT_MS);
    let j: { ok?: boolean; errors?: string[] } | undefined;
    try {
      j = JSON.parse(r.stdout.trim().split('\n').pop() ?? '');
    } catch {
      j = undefined;
    }
    if (j?.ok && fs.existsSync(out)) return { ok: true, bible: readJson(out) ?? {} };
    return { ok: false, errors: j?.errors?.length ? j.errors : [`the kit could not validate the bible: ${outputTail(r.output, 6, 400)}`] };
  }

  /** Run one job in its pool slot. */
  async run(id: string): Promise<void> {
    const out = await this.runJob(id).catch((e) => {
      this.sc.log.error(`bible job ${id}: ${(e as Error).stack ?? e}`);
      this.fail(id, (e as Error).message);
      return 'finished' as RunOutcome;
    });
    this.cancelled.delete(id);
    // (after the pool has released this run's slot)
    if (out === 'requeue') setImmediate(() => this.sc.scheduler.enqueueBible(id, true));
  }

  private budgetLeft(j: BibleJob, w: BibleWork): number | undefined {
    return j.request.budgetUsd === undefined ? undefined : Math.round((j.request.budgetUsd - w.cost.usd) * 1e6) / 1e6;
  }

  /** (backends) the job's cost so far */
  setCost(id: string, cost: Cost): void {
    const w = this.works[id];
    if (w) w.cost = cost;
    this.update(id, { cost });
  }

  private async runJob(id: string): Promise<RunOutcome> {
    const j = this.get(id);
    const w = this.works[id];
    const backend = this.backend;
    if (!j || isFinalBibleJob(j)) return 'finished';
    if (!w) {
      this.fail(id, 'its state was lost');
      return 'finished';
    }
    if (!backend) throw new Error('no bible backend');
    w.startedAt ??= this.sc.now();
    const scratch = this.prepare(j);
    const scope = j.request.scope ?? 'building';
    // ---- 1. the structured bible
    if (!w.bible) {
      let retryErrors: string[] | undefined;
      for (;;) {
        if (this.stopped(id)) return 'finished';
        const left = this.budgetLeft(j, w);
        if (left !== undefined && left <= 0) {
          this.fail(id, 'budget', `failed: budget ($${w.cost.usd.toFixed(4)} of $${j.request.budgetUsd})`);
          return 'finished';
        }
        this.update(id, { status: 'drafting', step: retryErrors ? 'fixing the bible (the kit refused a role)' : j.kind === 'revise' ? `revising ${j.bibleId} (v${j.version})` : 'drafting the style bible' });
        const r = await backend.draft({ job: j, work: w, scratch, budgetLeft: left, retryErrors });
        this.sc.store.markDirty();
        if (!r.ok) return this.passEnded(id, r);
        // (5a) every new version is format 2 (the kit validates its restraint and limits)
        const v = await this.validate(scratch, { ...r.bible, format: 2, id: j.bibleId, version: j.version }, scope);
        if (!v.ok) {
          if (w.draftRetries < 1) {
            w.draftRetries++;
            retryErrors = v.errors;
            this.sc.log.warn(`bible job ${id}: the draft does not validate (${truncate(v.errors.join('; '), 200)}); asking once more`);
            continue;
          }
          this.fail(id, `the bible did not validate: ${truncate(v.errors.join('; '), 1000)}`);
          return 'finished';
        }
        // (5a) format 2: the restraint (the draft's own, else the defaults with its first 3 motifs as heroes)
        const restraint = restraintOf({ ...v.bible, format: 2, ...(r.bible.restraint ? { restraint: r.bible.restraint } : {}) });
        const motifs = Array.isArray(v.bible.motifs) ? (v.bible.motifs as unknown[]) : [];
        w.bible = {
          ...v.bible,
          format: 2,
          motifs,
          restraint: { ...restraint, heroMotifs: heroesOf(restraint.heroMotifs, motifs) },
          id: j.bibleId,
          version: j.version,
          name: j.request.name ?? v.bible.name ?? j.bibleId,
          prompt: j.request.prompt,
          scope,
          ...(j.request.owner ? { owner: j.request.owner } : {}),
          ...(j.request.ext ? { ext: j.request.ext } : {}),
          ...(j.request.seedPreset ? { seedPreset: j.request.seedPreset } : {}),
          createdAt: this.sc.now(),
        };
        w.prose = r.prose;
        this.writeBible(scratch, w);
        this.sc.store.markDirty();
        break;
      }
    }
    // ---- 2. + 3. the components, checked in the pristine kit's frame (up to MAX_BIBLE_ROUNDS)
    for (;;) {
      if (this.stopped(id)) return 'finished';
      const left = this.budgetLeft(j, w);
      if (left !== undefined && left <= 0) {
        this.fail(id, 'budget', `failed: budget ($${w.cost.usd.toFixed(4)} of $${j.request.budgetUsd})`);
        return 'finished';
      }
      w.round++;
      this.sc.store.markDirty();
      this.update(id, { status: 'components', rounds: w.round, step: w.round === 1 ? 'writing the components' : `fixing the components (round ${w.round} of ${MAX_BIBLE_ROUNDS})` });
      this.writeBible(scratch, w);
      const r = await backend.components({ job: j, work: w, scratch, budgetLeft: left, problem: w.problem });
      if (!r.ok) {
        w.round--;
        return this.passEnded(id, r);
      }
      if (this.stopped(id)) return 'finished';
      this.update(id, { status: 'checking', step: `checking the components (round ${w.round})` });
      const c = await this.checkComponents(scratch, w);
      if (this.stopped(id)) return 'finished';
      if (c.ok) {
        // ---- 4. install
        this.update(id, { status: 'rendering', step: 'installing the bible and its sheet' });
        // (5a) format 2: the drafted list (the 5 required plus at most 3) is the library; extra exports are not listed
        const drafted = (w.bible!.components as string[] | undefined) ?? [];
        const comps = w.bible!.format === 2 && drafted.length ? [...new Set(drafted)] : [...new Set([...drafted, ...c.components])];
        w.bible = { ...w.bible!, components: comps, cost: w.cost };
        const stage = path.join(scratch, 'install');
        fs.rmSync(stage, { recursive: true, force: true });
        fs.mkdirSync(stage, { recursive: true });
        fs.writeFileSync(path.join(stage, 'bible.json'), `${JSON.stringify(w.bible, null, 2)}\n`);
        fs.writeFileSync(path.join(stage, 'bible.md'), `${(w.prose ?? '').trim()}\n`);
        fs.copyFileSync(path.join(scratch, 'bible', 'components.mjs'), path.join(stage, 'components.mjs'));
        fs.copyFileSync(c.sheet!, path.join(stage, 'sheet.png'));
        // (5a) the sheet critique (one report call on sheet.png), stored in bible.json `critique`
        if (j.request.critique?.mode === 'report') {
          this.update(id, { step: 'critic: the component sheet' });
          const crit = await this.sc.critiques.sheetCritique(j, w, path.join(stage, 'sheet.png'));
          if (this.stopped(id)) return 'finished';
          if (crit) {
            w.bible = { ...w.bible!, critique: crit, cost: w.cost };
            fs.writeFileSync(path.join(stage, 'bible.json'), `${JSON.stringify(w.bible, null, 2)}\n`);
          }
        }
        this.sc.bibleIndex.install(j.bibleId, j.version, stage);
        const info = this.sc.bibleIndex.get(j.bibleId, j.version);
        if (this.sc.designerName() === 'claude' && w.startedAt) this.sc.estimates.record('bible', j.request.model ?? this.sc.config.bibleModel, w.cost.usd, this.sc.now() - w.startedAt);
        this.update(id, { status: 'done', step: `done: ${j.bibleId} v${j.version} (${comps.length} components${c.warnings.length ? `, ${c.warnings.length} warning(s)` : ''})`, ...(info ? { bible: info } : {}) });
        this.sc.log.info(`bible ${j.bibleId} v${j.version} is ready in ${info?.dir ?? this.sc.config.biblesDir} ($${w.cost.usd.toFixed(4)}${this.sc.config.simCosts && this.sc.designerName() === 'sim' ? ', sim: true, notional' : ''})`);
        this.sc.bibleIndexChanged();
        return 'finished';
      }
      w.problem = c.problem;
      this.sc.store.markDirty();
      if (w.round >= MAX_BIBLE_ROUNDS) {
        this.fail(id, c.problem ?? 'the component check failed');
        return 'finished';
      }
      this.update(id, { step: `check failed: ${truncate((c.problem ?? '').split('\n')[1] ?? c.problem ?? '', 80)}` });
    }
  }

  private passEnded(id: string, r: { outcome: RunOutcome; error?: string }): RunOutcome {
    if (r.outcome === 'requeue') {
      const until = this.sc.store.data.limit?.until;
      this.update(id, { status: 'queued', step: 'usage limit: waiting for the reset', ...(until ? { usageLimitUntil: until } : {}) });
      return 'requeue';
    }
    if (r.outcome === 'stopped') return 'stopped';
    if (r.error && !this.stopped(id)) this.fail(id, r.error);
    return 'finished';
  }
}

/** The sim backend: a fixed bible (or the seed preset's roles) and the reference components, no Claude. */
export class SimBibleBackend implements BibleBackend {
  readonly name = 'sim' as const;
  private stops = new Set<string>();

  constructor(
    private sc: Sidecar,
    private stepMs: number,
  ) {}

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms).unref?.());
  }

  cancel(jobId: string): void {
    this.stops.add(jobId);
  }

  async draft(p: BiblePass): Promise<DraftResult> {
    await this.sleep(this.stepMs);
    if (this.stops.delete(p.job.id)) return { ok: false, outcome: 'finished' };
    const seed = p.job.request.seedPreset ? this.sc.bibleIndex.get(p.job.request.seedPreset) : undefined;
    const roles: Record<string, string> = seed
      ? { ...seed.roles }
      : {
          wall: 'minecraft:blackstone', wall_alt: 'minecraft:polished_blackstone_bricks', trim: 'minecraft:basalt', roof: 'minecraft:deepslate_tiles',
          floor: 'minecraft:polished_basalt', frame: 'minecraft:crimson_stem', accent: 'minecraft:crimson_planks', light: 'minecraft:shroomlight',
          glass: 'minecraft:red_stained_glass_pane', foundation: 'minecraft:blackstone', path: 'minecraft:coarse_dirt',
        };
    if ((p.job.request.scope ?? 'building') === 'settlement') Object.assign(roles, { rock: 'minecraft:stone', surface: 'minecraft:grass_block', subsurface: 'minecraft:dirt', rubble: 'minecraft:cobblestone', rail: 'minecraft:rail', structure: 'minecraft:oak_planks' });
    this.charge(p, 'draft');
    return {
      ok: true,
      bible: {
        name: p.job.request.name ?? (seed ? `${seed.name} (sim)` : 'Sim Ashfall'),
        roles,
        proportions: { storey: 4, roofPitch: 1, overhang: 1, windowRhythm: 3, plinth: 1 },
        roofLanguage: 'steep gable', silhouette: 'tall and narrow', motifs: ['chain lanterns'], tiers: { humble: ['wall_alt'], important: ['wall', 'trim'] },
        lighting: 'low and warm', avoid: ['white'], components: [...REQUIRED_COMPONENTS],
      },
      prose: `# ${p.job.request.name ?? 'Sim Ashfall'}\n\nA simulated style bible (no Claude) for: ${p.job.request.prompt}${p.job.request.notes ? `\n\nRevised: ${p.job.request.notes}` : ''}\n`,
    };
  }

  async components(p: BiblePass): Promise<PassResult> {
    await this.sleep(this.stepMs);
    if (this.stops.delete(p.job.id)) return { ok: false, outcome: 'finished' };
    // the starting library (the reference components) is the sim's answer
    this.charge(p, 'components');
    return { ok: true };
  }

  /**
   * A pass's notional cost: simDesignUsd per pass, or (6c 0a, simCosts) the bible's figure, half at the draft and the rest at
   * the components pass, so a bible job sums exactly to it (a pass that runs again adds nothing more).
   */
  private charge(p: BiblePass, pass: 'draft' | 'components'): void {
    const c = this.sc.config.simCosts;
    let usd = this.sc.config.simDesignUsd;
    if (c) {
      const due = pass === 'draft' ? Math.round((c.bible / 2) * 1e6) / 1e6 : c.bible;
      usd = Math.max(0, Math.round((due - (p.work.simCharged ?? 0)) * 1e6) / 1e6);
      p.work.simCharged = Math.max(p.work.simCharged ?? 0, due);
      this.sc.store.markDirty();
    }
    if (usd > 0) this.sc.bibles.setCost(p.job.id, { ...p.work.cost, usd: Math.round((p.work.cost.usd + usd) * 1e6) / 1e6, turns: p.work.cost.turns + 1 });
  }
}
