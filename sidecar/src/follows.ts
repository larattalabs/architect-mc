// (6d FS, docs/CONTRACT.md "Phase 6d slice FS: updates follow the source") A copy follows its source: its own recorded recipe re-run on
// the source's new version, at $0 (no Claude call), installed as the copy's own next version only if the result still passes what a
// copy had to pass; each lot then updates by the ordinary delta (the mod's checkDelta / applyDelta, nothing new here).
//
//   - entry.follow {entryId, toSourceVersion, opKey?} and entry.followAll {sourceEntryId, toSourceVersion, opKey?}: both are one
//     persisted operation, <data>/follows/<file>.json, written before the ack with the source version and the follower set frozen
//     (followAll: every COPY behind at that moment, each with its head). The ack carries {followId, status, results}; the results of
//     a running operation come as follow.upsert {follow} as each follower ends, `status: 'done'` last
//   - a follower: the source's .mjs at the frozen version under the copy's id, built with the recipe's levers: its bible pin and
//     roles (the shift), the recipe's param over the new version's values, the mirror (as-built: the recipe's `values` are the
//     archetype's values at copy time plus the param, so taking them whole would ignore every source change made through a param
//     default; the new version's values plus the param is the same recipe on the new version). Then the pristine-kit check, the
//     frame (front and the entrance feet row equal to the copy's head), the copy's size bound (its request's maxSize: `fit`), and
//     the 0b variation bar against the new version (2 of 3 levers, 10% of cells), for a copy whose recipe met it
//   - installed as the copy's head + 1, by 'follow', parent = the frozen head, derivation.sourceVersion = the frozen version, the
//     recipe unchanged; entry.versioned fires. Compare-and-set: the copy's head must still be the frozen one and its
//     sourceVersion still below the target, checked synchronously just before the install (else head_moved, nothing installed)
//   - already followed (the head derives from the target or a later version): followed false, alreadyFollowed true, a no-op
//   - a kill mid-operation: the sidecar's start resumes every running operation; an install is preceded by an `installing`
//     marker, so a follower this operation installed before the kill still reports followed
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkDesign, KIT, refreshKit, renderPreviews, runNode, withDesignId, type CheckResult } from './designs.js';
import { ClientError, RefusedError } from './errors.js';
import { bodyHash, OP_KEY_CONFLICT } from './opkeys.js';
import type { BiblePin, FollowLot, Outbound } from './protocol.js';
import { truncate } from './util/text.js';
import { writeFileAtomic } from './util/fsx.js';
import type { EntryVersions } from './versions.js';
import { normalizeKitImports } from './variants.js';
import type { BibleIndex } from './bibles.js';
import type { Logger } from './context.js';

export type FollowRefusal = 'frame' | 'check' | 'bar' | 'fit' | 'lot_too_small' | 'bible_gone' | 'source_gone' | 'head_moved';

/** One follower's outcome (Designs.FollowResult on the mod side). */
export interface FollowResult {
  entryId: string;
  followed: boolean;
  fromVersion: number;
  newVersion: number;
  sourceVersion: number;
  refused: FollowRefusal | null;
  alreadyFollowed: boolean;
  message: string;
}

export interface FollowMember {
  entryId: string;
  /** the copy's head when the operation froze it */
  head: number;
  state: 'pending' | 'installing' | 'done';
  /** the version an install is about to commit (the resume reads it) */
  installing?: number;
  /** (FS-b) the standing region lots that held the copy when the operation froze it (the mod's; frozen with the member so a resume tests the same set) */
  lots?: FollowLot[];
  result?: FollowResult;
}

/** A persisted follow operation. */
export interface FollowOp {
  id: string;
  kind: 'one' | 'all';
  opKey?: string;
  hash: string;
  /** the source entry */
  source: string;
  /** the frozen source version */
  target: number;
  members: FollowMember[];
  status: 'running' | 'done';
  createdAt: number;
  updatedAt: number;
}

/** A Library.Follower (the sidecar's view; the mod lists its own from the loaded entries). */
export interface Follower {
  entryId: string;
  kind: 'variant' | 'reskin' | 'copy' | 'site';
  sourceVersion: number;
  headVersion: number;
  sourceHead: number;
  behind: boolean;
}

export interface FollowHost {
  readonly config: { libraryDir: string; kitDir: string; dataDir: string };
  readonly versions: EntryVersions;
  readonly bibleIndex: Pick<BibleIndex, 'resolve'>;
  readonly log: Logger;
  now(): number;
  emit(m: Outbound): void;
  entryVersioned(entryId: string, version: number, from: number, by: 'follow'): void;
}

/** Tests: throw at a point of a follower's run (a kill). */
export type FollowFaultPoint = 'built' | 'marked' | 'installed' | 'recorded';

const KIT_TIMEOUT_MS = 120_000;
const SAFE_KEY = /^[A-Za-z0-9_.-]{1,100}$/;
/** the copy's JSON keys a new version keeps (as installVersionOf keeps them) */
const CARRY = ['name', 'description', 'createdAt', 'request', 'ext', 'bible', 'group', 'groupItem', 'profile', 'variantOf', 'displayName', 'fromMassing', 'adopted'] as const;

type Recipe = {
  shift?: { name: string; set: Record<string, string> } | null;
  param?: { name: string; value: unknown } | null;
  roles?: Record<string, string>;
  values?: Record<string, unknown>;
  mirror?: boolean;
  bible?: BiblePin;
  bar?: boolean;
  [k: string]: unknown;
};
type Derivation = { source?: string; sourceVersion?: number; kind?: string; recipe?: Recipe };

const derivationOf = (j: Record<string, unknown> | undefined): Derivation | undefined => (j?.derivation && typeof j.derivation === 'object' ? (j.derivation as Derivation) : undefined);

function readObj(file: string): Record<string, unknown> | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The bar script (written into the scratch dir; the kit is not changed): the follower's levers and changed share against the new version. */
const BAR_SCRIPT = `import fs from 'node:fs';
const saved = console.log;
console.log = console.info = console.debug = console.error;
const out = (o) => { console.log = saved; console.log(JSON.stringify(o)); };
try {
  const { loadDesign } = await import('./kit/build.mjs');
  const { changedShare, leversBetween, MIN_LEVERS, MIN_CHANGED } = await import('./kit/lib/variation.mjs');
  const q = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const cellsOf = (bp) => {
    const m = new Map();
    for (const e of bp.entries()) {
      const props = Object.keys(e.state.props).sort().map((k) => k + '=' + e.state.props[k]).join(',');
      m.set((e.x - bp.ox) + ',' + (e.y - bp.oy) + ',' + (e.z - bp.oz), e.state.name + '[' + props + ']|' + (e.nbt ? JSON.stringify(e.nbt) : ''));
    }
    return m;
  };
  const build = async (roles, values, mirror) => cellsOf(await loadDesign(q.id, { palette: { bible: { id: q.bible.id, version: q.bible.version, roles } }, values, mirror }));
  const arch = await build(q.roles, q.values, false);
  const eff = new Set();
  const r = q.recipe;
  if (r.shift && changedShare(arch, await build({ ...q.roles, ...(r.shift.set ?? {}) }, q.values, false)).changed > 0) eff.add('shift:' + r.shift.name);
  if (r.param && changedShare(arch, await build(q.roles, { ...q.values, [r.param.name]: r.param.value }, false)).changed > 0) eff.add('param:' + r.param.name + '=' + JSON.stringify(r.param.value));
  if (r.mirror && changedShare(arch, await build(q.roles, q.values, true)).changed > 0) eff.add('mirror');
  const follower = await build(r.roles, r.values, !!r.mirror);
  const levers = leversBetween(null, r, eff);
  const share = changedShare(arch, follower).share;
  out({ ok: true, levers, share: Math.round(share * 1000) / 1000, bar: levers.length >= MIN_LEVERS && share >= MIN_CHANGED });
} catch (e) {
  out({ ok: false, error: String(e && e.message || e) });
}
`;

export class Follows {
  /** tests: a kill at a point */
  fault: ((p: FollowFaultPoint, entryId: string) => void) | undefined;
  private queue: string[] = [];
  private runP: Promise<void> | undefined;
  private stopped = false;
  private seq = 0;

  constructor(private host: FollowHost) {}

  dir(): string {
    return path.join(this.host.config.dataDir, 'follows');
  }

  private file(id: string): string {
    return path.join(this.dir(), `${id}.json`);
  }

  get(id: string): FollowOp | undefined {
    if (!/^[A-Za-z0-9_.-]{1,140}$/.test(id)) return undefined;
    return readObj(this.file(id)) as FollowOp | undefined;
  }

  /** Every saved operation (oldest first). */
  all(): FollowOp[] {
    if (!fs.existsSync(this.dir())) return [];
    return fs
      .readdirSync(this.dir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => readObj(path.join(this.dir(), f)) as FollowOp | undefined)
      .filter((o): o is FollowOp => !!o && typeof o.id === 'string')
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  private save(op: FollowOp): void {
    op.updatedAt = this.host.now();
    writeFileAtomic(this.file(op.id), `${JSON.stringify(op, null, 2)}\n`);
  }

  /** "<entry>:<version>" of the source versions running operations build from (GC keeps them). */
  versionsInUse(): Set<string> {
    return new Set(this.all().filter((o) => o.status === 'running').map((o) => `${o.source}:${o.target}`));
  }

  /** Every entry whose head derives from `source` (any kind), sorted by id. */
  followers(source: string): Follower[] {
    const lib = this.host.config.libraryDir;
    if (!fs.existsSync(lib)) return [];
    const sourceHead = this.host.versions.top(source) ? this.host.versions.head(source) : 0;
    const out: Follower[] = [];
    for (const id of fs.readdirSync(lib).filter((d) => /^[a-z0-9_]+$/.test(d)).sort()) {
      const j = this.host.versions.top(id);
      const der = derivationOf(j);
      if (!der || der.source !== source) continue;
      const kind = (['reskin', 'copy', 'site'].includes(der.kind ?? '') ? der.kind : 'variant') as Follower['kind'];
      const sv = typeof der.sourceVersion === 'number' ? der.sourceVersion : 1;
      out.push({ entryId: id, kind, sourceVersion: sv, headVersion: this.host.versions.head(id), sourceHead, behind: kind === 'copy' && sourceHead > 0 && sv < sourceHead });
    }
    return out;
  }

  // ---- the requests (synchronous, before the ack) ---------------------------------------------------------------------

  /** entry.follow: one copy. */
  follow(entryId: string, toSourceVersion: number, opKey?: string, lots?: FollowLot[]): FollowOp {
    const body = { type: 'entry.follow', entryId, toSourceVersion };
    const prior = this.prior(opKey, body);
    if (prior) return prior;
    const json = this.host.versions.top(entryId);
    if (!json) throw new RefusedError('VERSION_REFUSED', 'no_entry', `no library entry "${entryId}"`);
    const der = derivationOf(json);
    this.refuseKind(entryId, der);
    const source = der!.source!;
    const target = this.resolveTarget(source, toSourceVersion, true);
    return this.create('one', source, target, [{ entryId, head: this.host.versions.head(entryId), state: 'pending', ...(lots?.length ? { lots } : {}) }], opKey, body);
  }

  /** entry.followAll: every COPY of the source that is behind, frozen now. */
  followAll(source: string, toSourceVersion: number, opKey?: string, lots?: Record<string, FollowLot[]>): FollowOp {
    const body = { type: 'entry.followAll', sourceEntryId: source, toSourceVersion };
    const prior = this.prior(opKey, body);
    if (prior) return prior;
    const exists = !!this.host.versions.top(source);
    const target = this.resolveTarget(source, toSourceVersion, false);
    // a gone source: every COPY of it is frozen (each answers source_gone)
    const members = this.followers(source)
      .filter((f) => f.kind === 'copy' && (!exists || f.sourceVersion < target))
      .map((f) => ({ entryId: f.entryId, head: f.headVersion, state: 'pending' as const, ...(lots?.[f.entryId]?.length ? { lots: lots[f.entryId]! } : {}) }));
    return this.create('all', source, target, members, opKey, body);
  }

  /** The operation a key made with the same body (op_key_conflict for another body), or undefined. */
  private prior(opKey: string | undefined, body: Record<string, unknown>): FollowOp | undefined {
    if (!opKey) return undefined;
    const op = this.get(keyFile(opKey));
    if (!op) return undefined;
    if (op.hash !== bodyHash(body)) throw new ClientError(`${OP_KEY_CONFLICT}: opKey "${opKey}" was used for another follow operation (${op.kind === 'one' ? op.members[0]?.entryId : op.source})`);
    this.host.log.info(`follow ${op.id}: replayed by opKey ${opKey} (${op.status})`);
    return op;
  }

  /** Only a COPY follows (SITE in 7b; a variant or a re-skin was made to differ; a copy of an adopted entry is its own ask). */
  private refuseKind(entryId: string, der: Derivation | undefined): void {
    if (der?.kind === 'site') throw new RefusedError('NOT_ALLOWED', 'until_7b', `${entryId} is a site-adapted entry: it follows its source in 7b, with its fit parameters`);
    if (der?.kind !== 'copy' || typeof der.source !== 'string') throw new RefusedError('NOT_ALLOWED', 'not_copy', `${entryId} is ${der ? `a ${der.kind ?? 'variant'} (made to differ from its source)` : 'not derived from another entry'}: only a copy follows its source`);
    const src = this.host.versions.top(der.source);
    if (src?.adopted === true) throw new RefusedError('NOT_ALLOWED', 'adopted', `${entryId} is a copy of an adopted entry (${der.source}): following it is not supported yet`);
  }

  /** The frozen source version: toSourceVersion, or the head (0). A gone source freezes its last known version (0). */
  private resolveTarget(source: string, to: number, single: boolean): number {
    if (!this.host.versions.top(source)) {
      if (single) return to > 0 ? to : 0;
      return to > 0 ? to : 0;
    }
    const head = this.host.versions.head(source);
    if (to <= 0) return head;
    if (to > head || !this.host.versions.versionDir(source, to)) throw new ClientError(`${source} has no version ${to}${to < head ? ' (it was garbage-collected)' : ` (its head is v${head})`}`);
    return to;
  }

  private create(kind: FollowOp['kind'], source: string, target: number, members: FollowMember[], opKey: string | undefined, body: Record<string, unknown>): FollowOp {
    const now = this.host.now();
    const id = opKey ? keyFile(opKey) : this.freshId();
    const op: FollowOp = { id, kind, ...(opKey ? { opKey } : {}), hash: bodyHash(body), source, target, members, status: members.length ? 'running' : 'done', createdAt: now, updatedAt: now };
    this.save(op);
    this.host.log.info(`follow ${id}: ${kind === 'one' ? members[0]!.entryId : `${members.length} follower(s) of ${source}`} to ${source} v${target}`);
    this.host.emit({ type: 'follow.upsert', follow: view(op) } as Outbound);
    if (op.status === 'running') this.enqueue(op.id);
    return op;
  }

  private freshId(): string {
    for (;;) {
      const id = `fo${this.host.now().toString(36)}${(this.seq++).toString(36)}${crypto.randomBytes(2).toString('hex')}`;
      if (!fs.existsSync(this.file(id))) return id;
    }
  }

  // ---- the runner -----------------------------------------------------------------------------------------------------

  /** Resume every running operation (the sidecar's start). */
  start(): void {
    for (const op of this.all()) if (op.status === 'running') this.enqueue(op.id);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.runP?.catch(() => undefined);
  }

  /** resolves when nothing is queued or running (tests) */
  async idle(): Promise<void> {
    while (this.runP) await this.runP.catch(() => undefined);
  }

  private enqueue(id: string): void {
    if (!this.queue.includes(id)) this.queue.push(id);
    this.kick();
  }

  private kick(): void {
    if (this.runP || this.stopped) return;
    this.runP = (async () => {
      try {
        while (!this.stopped && this.queue.length) {
          const id = this.queue.shift()!;
          try {
            await this.runOp(id);
          } catch (e) {
            // a fault (tests) or a crash: the operation stays running on disk and resumes at the next start
            this.host.log.warn(`follow ${id}: stopped: ${(e as Error).message}`);
            if ((e as Error & { fatal?: boolean }).fatal) this.stopped = true;
          }
        }
      } finally {
        this.runP = undefined;
      }
    })();
  }

  private async runOp(id: string): Promise<void> {
    const op = this.get(id);
    if (!op || op.status !== 'running') return;
    for (const m of op.members) {
      if (this.stopped) return;
      if (m.state === 'done') continue;
      const result = await this.runMember(op, m);
      m.state = 'done';
      delete m.installing;
      m.result = result;
      this.fault?.('recorded', m.entryId);
      this.save(op);
      this.host.emit({ type: 'follow.upsert', follow: view(op) } as Outbound);
    }
    op.status = 'done';
    this.save(op);
    this.host.log.info(`follow ${op.id}: done (${op.members.map((m) => `${m.entryId} ${m.result?.followed ? `v${m.result.newVersion}` : m.result?.alreadyFollowed ? 'already' : m.result?.refused}`).join(', ') || 'no followers'})`);
    this.host.emit({ type: 'follow.upsert', follow: view(op) } as Outbound);
  }

  /** One follower: the checks, then the compare-and-set install. Never throws for a refusal. */
  private async runMember(op: FollowOp, m: FollowMember): Promise<FollowResult> {
    const base = { entryId: m.entryId, fromVersion: m.head, sourceVersion: op.target };
    const refuse = (refused: FollowRefusal, message: string): FollowResult => ({ ...base, followed: false, newVersion: m.head, refused, alreadyFollowed: false, message: truncate(message.replace(/\s+/g, ' ').trim(), 600) });
    const v = this.host.versions;
    const top = v.top(m.entryId);
    const der = derivationOf(top);
    const head = top ? v.head(m.entryId) : 0;
    // the resume: this operation's own install committed before the kill
    if (m.state === 'installing' && m.installing && top && head === m.installing && der?.sourceVersion === op.target) {
      return { ...base, followed: true, newVersion: head, refused: null, alreadyFollowed: false, message: `followed ${op.source} v${op.target}: v${head} (resumed after a restart)` };
    }
    if (!top || !der || der.kind !== 'copy') return refuse('head_moved', `${m.entryId} is gone or no longer a copy`);
    if ((der.sourceVersion ?? 1) >= op.target && op.target > 0) return { ...base, followed: false, newVersion: head, refused: null, alreadyFollowed: true, message: `${m.entryId} v${head} already derives from ${op.source} v${der.sourceVersion}` };
    if (head !== m.head) return refuse('head_moved', `${m.entryId} moved from v${m.head} to v${head} meanwhile`);
    const srcDir = op.target > 0 && v.top(op.source) ? v.versionDir(op.source, op.target) : undefined;
    const srcFile = srcDir ? path.join(srcDir, `${op.source}.mjs`) : undefined;
    if (!srcFile || !fs.existsSync(srcFile)) return refuse('source_gone', `${op.source}${op.target > 0 ? ` v${op.target}` : ''} is gone`);
    const srcJson = readObj(path.join(srcDir!, `${op.source}.blueprint.json`)) ?? {};
    const recipe = der.recipe ?? {};
    const pin = recipe.bible ?? (top.bible as BiblePin | undefined);
    let bibleFile: string;
    let bible: { id?: string; version?: number; roles: Record<string, string>; name?: string };
    try {
      if (!pin) throw new Error('the copy records no bible pin');
      bibleFile = this.host.bibleIndex.resolve(pin).files.json;
      bible = JSON.parse(fs.readFileSync(bibleFile, 'utf8')) as typeof bible;
    } catch (e) {
      return refuse('bible_gone', `the copy's bible ${pin ? `${pin.id} v${pin.version}` : ''} is gone: ${(e as Error).message}`);
    }
    // the recipe's levers on the new version: its roles (the bible pin and the shift), the param over the new version's values, the mirror
    const newValues = srcJson.values && typeof srcJson.values === 'object' ? (srcJson.values as Record<string, unknown>) : {};
    const values = { ...newValues, ...(recipe.param ? { [recipe.param.name]: recipe.param.value } : {}) };
    const roles = recipe.roles ?? { ...bible.roles, ...(recipe.shift?.set ?? {}) };
    const scratch = path.join(this.host.config.dataDir, 'follow-scratch', `${op.id}-${m.entryId}`);
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    try {
      const work = fs.realpathSync(scratch);
      refreshKit(this.host.config.kitDir, work);
      const bp = m.entryId;
      const design = path.join(work, KIT, 'designs', `${bp}.mjs`);
      fs.writeFileSync(design, withDesignId(normalizeKitImports(fs.readFileSync(srcFile, 'utf8')), bp));
      const ownBible = [path.join(srcDir!, 'bible'), path.join(v.dir(op.source), 'bible')].find((d) => fs.existsSync(d));
      if (ownBible) fs.cpSync(ownBible, path.join(work, 'bible'), { recursive: true });
      fs.copyFileSync(bibleFile, path.join(work, 'group-bible.json'));
      fs.writeFileSync(path.join(work, 'copy-bible.json'), `${JSON.stringify({ id: bible.id ?? pin!.id, version: bible.version ?? pin!.version, ...(bible.name ? { name: bible.name } : {}), roles }, null, 2)}\n`);
      const req = (top.request && typeof top.request === 'object' ? top.request : {}) as { maxSize?: { x: number; y: number; z: number }; type?: string };
      const type = typeof top.type === 'string' ? top.type : req.type;
      const profile = Array.isArray(top.profile) ? (top.profile as string[]) : undefined;
      const extra = ['--bible', 'copy-bible.json', ...(Object.keys(values).length ? ['--values', JSON.stringify(values)] : []), ...(recipe.mirror ? ['--mirror'] : []), '--restraint', 'group-bible.json'];
      const res: CheckResult = await checkDesign(this.host.config.kitDir, work, bp, { type, ...(profile ? { profile } : {}) }, KIT_TIMEOUT_MS, extra);
      if (!res.ok) return refuse('check', `the follower did not pass the check: ${res.problem ?? 'the check failed'}`);
      const s = res.sidecar!.size!;
      const max = req.maxSize;
      if (max && (s.x > max.x || s.y > max.y || s.z > max.z)) return refuse('fit', `the follower is ${s.x}x${s.y}x${s.z}, over the copy's maximum ${max.x}x${max.y}x${max.z}`);
      // (FS-b, S-FS-6) every standing region lot that holds the copy must hold the re-made version: refused before anything installs
      const tooSmall = lotsTooSmall(m.lots ?? [], s, res.sidecar as Record<string, unknown>);
      if (tooSmall.length) return refuse('lot_too_small', `the follower is ${s.x}x${s.y}x${s.z}, too big for ${tooSmall.map((l) => `lot ${l.lotId} (site ${l.siteId})`).join(', ')}: ${m.entryId} stays at v${m.head}`);
      // the frame: front and the entrance feet row equal to the copy's head
      const headNbt = path.join(v.dir(m.entryId), `${m.entryId}.nbt`);
      const fr = await runNode(path.join(this.host.config.kitDir, 'tools', 'diff.mjs'), [headNbt, res.nbt!, '--json'], work, KIT_TIMEOUT_MS);
      const fj = lastJson(fr.stdout) as { frameKept?: boolean; notes?: string[] } | undefined;
      if (!fj) return refuse('check', `the frame check could not run: ${truncate(fr.output, 300)}`);
      if (fj.frameKept === false) return refuse('frame', `the frame changed (${(fj.notes ?? []).filter((x) => /^front changed|^entrance feet row/.test(x)).join('; ')}): the copy's lots could not take the delta`);
      // the 0b variation bar against the new version (a copy whose recipe met it at copy time must still meet it)
      fs.writeFileSync(path.join(work, 'follow-bar.mjs'), BAR_SCRIPT);
      fs.writeFileSync(path.join(work, 'follow-bar.json'), JSON.stringify({ id: bp, bible: { id: bible.id ?? pin!.id, version: bible.version ?? pin!.version }, roles: bible.roles, values: newValues, recipe: { shift: recipe.shift ?? null, param: recipe.param ?? null, mirror: !!recipe.mirror, roles, values } }));
      const br = await runNode('follow-bar.mjs', ['follow-bar.json'], work, KIT_TIMEOUT_MS);
      const bj = lastJson(br.stdout) as { ok?: boolean; levers?: string[]; share?: number; bar?: boolean; error?: string } | undefined;
      if (!bj?.ok) return refuse('check', `the variation bar could not be measured: ${bj?.error ?? truncate(br.output, 300)}`);
      if (recipe.bar !== false && !bj.bar) return refuse('bar', `the follower is too close to ${op.source} v${op.target}: levers ${JSON.stringify(bj.levers)}, ${Math.round((bj.share ?? 0) * 1000) / 10}% of cells changed (the bar: 2 levers and 10%)`);
      const rp = await renderPreviews(work, res.nbt!, KIT_TIMEOUT_MS);
      this.fault?.('built', m.entryId);
      // the compare-and-set, synchronously from here to the install
      const now = v.top(m.entryId);
      const nowDer = derivationOf(now);
      const nowHead = now ? v.head(m.entryId) : 0;
      if (now && (nowDer?.sourceVersion ?? 1) >= op.target) return { ...base, followed: false, newVersion: nowHead, refused: null, alreadyFollowed: true, message: `${m.entryId} v${nowHead} already derives from ${op.source} v${nowDer?.sourceVersion}` };
      if (!now || nowHead !== m.head) return refuse('head_moved', `${m.entryId} moved from v${m.head} to v${nowHead} meanwhile`);
      const json: Record<string, unknown> = { ...(res.sidecar as Record<string, unknown>) };
      for (const k of CARRY) if (now[k] !== undefined) json[k] = now[k];
      json.variantOfVersion = op.target;
      json.derivation = { ...nowDer, sourceVersion: op.target };
      const parts = res.nbt!.replace(/\.nbt$/, '.parts.nbt');
      m.state = 'installing';
      m.installing = m.head + 1;
      this.save(op);
      this.fault?.('marked', m.entryId);
      const version = v.install(
        m.entryId,
        { nbt: res.nbt!, json, ...(fs.existsSync(parts) ? { parts } : {}), source: design, previews: rp.files, files: fs.existsSync(path.join(work, 'bible')) ? ['bible.json', 'bible.md', 'components.mjs'].map((f) => ({ from: path.join(work, 'bible', f), to: path.join('bible', f) })) : [] },
        { by: 'follow', parent: m.head, summary: `follow: ${op.source} v${op.target}` },
      );
      this.fault?.('installed', m.entryId);
      this.host.entryVersioned(m.entryId, version, m.head, 'follow');
      return { ...base, followed: true, newVersion: version, refused: null, alreadyFollowed: false, message: `followed ${op.source} v${op.target}: v${version} (${s.x}x${s.y}x${s.z}; levers ${(bj.levers ?? []).join(', ')}, ${Math.round((bj.share ?? 0) * 1000) / 10}% changed)` };
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/**
 * (FS-b) The standing lots a re-made follower of size `size` does not fit. A follower is placed by the delta so that every design coordinate
 * lands on the world cell it has in the version the site stands at (the mod's `SitePlanner.alignedMin`), so its box in that version's
 * template-local blocks is `[oa - ob, oa - ob + size)`, where `oa`/`ob` are the two frame origins (an unframed side borrows the framed
 * side's, as `TemplateDelta.origins` does). The lot's box arrives in the same blocks, so this is containment on x and z (as `fitToLot`
 * tests a footprint; the lot's height is not tested there).
 */
export function lotsTooSmall(lots: readonly FollowLot[], size: { x: number; z: number }, candidate: Record<string, unknown>): FollowLot[] {
  const fb = frameOrigin(candidate);
  return lots.filter((l) => {
    const fa = l.origin;
    const oa = fa ?? fb ?? [0, 0, 0];
    const ob = fb ?? fa ?? [0, 0, 0];
    const x0 = oa[0] - ob[0];
    const z0 = oa[2] - ob[2];
    return !(x0 >= l.box[0] && x0 + size.x - 1 <= l.box[3] && z0 >= l.box[2] && z0 + size.z - 1 <= l.box[5]);
  });
}

function frameOrigin(j: Record<string, unknown>): [number, number, number] | undefined {
  const f = j.frame as { origin?: unknown } | undefined;
  const o = f?.origin;
  return Array.isArray(o) && o.length === 3 && o.every((n) => typeof n === 'number') ? (o as [number, number, number]) : undefined;
}

/** The file stem of a keyed operation (a key that is not a safe file name is hashed). */
export function keyFile(opKey: string): string {
  return SAFE_KEY.test(opKey) ? `key-${opKey}` : `keyh-${crypto.createHash('sha256').update(opKey).digest('hex').slice(0, 32)}`;
}

function lastJson(stdout: string): unknown {
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  try {
    return line ? JSON.parse(line) : undefined;
  } catch {
    return undefined;
  }
}

/** What the ack and follow.upsert carry. */
export function view(op: FollowOp): Record<string, unknown> {
  return {
    id: op.id,
    kind: op.kind,
    ...(op.opKey ? { opKey: op.opKey } : {}),
    source: op.source,
    sourceVersion: op.target,
    status: op.status,
    members: op.members.map((m) => m.entryId),
    results: op.members.filter((m) => m.result).map((m) => m.result!),
  };
}
