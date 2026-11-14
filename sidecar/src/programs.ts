// (M5 GP, docs/CONTRACT.md "M5 support" slice GP, Steward's S-M5-1) Given-program designs and keyed variants, $0, no Claude:
//
//   - design.fromProgram {source, params, bible?, opKey, owner?}: the caller's kit design program (its source; the parameter schema is
//     the program's own `export const params`, as for every kit design) built with `params` as its values and the bible's roles, checked
//     by the pristine kit's checker, rendered, and installed as a new library entry (no group, no approval)
//   - design.variant {entryId, params, bible?, reserved?, opKey, owner?}: a given-program entry's program re-run with other params, another
//     bible (null: the entry's own) and the lot's reserved cells (`--reserved`, the lot's frame; the program is given them and the checker
//     refuses a design writing one), installed as a new entry (`derivation.kind: 'variant'`); `Library.makeVariant` is unchanged
//   - design.variantByKey {opKey, owner?}: the keyed variant's operation, from its file (after a restart too); {} when never made
//   - the program runs in the plan sandbox (Node's permission model: it reads and writes only its scratch dir, no child processes, no
//     network, the plan's heap and time limits), with a fresh copy of the pristine kit, as kit/build.mjs in a child with a minimal env
//   - the entry records the program's sha (sha256 of the caller's exact source bytes, the 7c AU rule) in `givenProgram {sha, opKey}`
//     and keeps the exact source as `program/source.mjs`; a variant reads that file, refuses `program_stale` when its sha is not the
//     recorded one, and records the same sha
//   - refusals: PROGRAM_REFUSED with a detail (the first finding's rule for a checker refusal: `reserved`, `size`, `sidecar`,
//     `structure`, `blocks`, `anchors`, `massing`, `check`; `params` or `palette` for values or a bible the program can't take;
//     `program` when it threw; `timeout`; `program_stale`; `not_given` for a variant of an entry that is not a given program) and the
//     checker's errors as typed findings {rule, severity, message}; an unknown entry is VERSION_REFUSED no_entry (UNKNOWN_BLUEPRINT in
//     the mod); an unknown bible a plain refusal
//   - one persisted operation per (owner, kind, opKey), <data>/programs/<id>.json, with the body's hash; the same key and body answers
//     the first operation in any state, another body op_key_conflict; the ack carries the operation; a running one reports done through
//     follow.upsert (the API's operation channel, as DS's site variants); a restart resumes it; a kill between the install and the record
//     finds the installed entry by its `programOp`
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkDesign, freeLibraryId, installDesign, KIT, refreshKit, renderPreviews, sandboxFlags, slugify, withDesignId, type CheckResult } from './designs.js';
import { ClientError, RefusedError } from './errors.js';
import { bodyHash, OP_KEY_CONFLICT } from './opkeys.js';
import { NO_NETWORK, permissionFlag } from './regions.js';
import { findVariantSource, isExt, normalizeKitImports, VariantRefused } from './variants.js';
import { truncate } from './util/text.js';
import { writeFileAtomic } from './util/fsx.js';
import type { Outbound, ProgramBible, Reserved } from './protocol.js';
import type { Logger } from './context.js';
import type { Config } from './config.js';

/** The most a given program's source may be (UTF-16 units; the mod's Limits.PROGRAM_SOURCE_MAX). */
export const PROGRAM_SOURCE_MAX = 262_144;
/** The most its params may be, as JSON (Limits.PROGRAM_PARAMS_MAX). */
export const PROGRAM_PARAMS_MAX = 16_384;
/** Where an entry keeps the caller's exact source. */
export const PROGRAM_FILE = path.join('program', 'source.mjs');

export type ProgramKind = 'program' | 'variant';

export interface ProgramFinding {
  rule: string;
  severity: 'error';
  message: string;
}

export interface ProgramRefusal {
  code: 'PROGRAM_REFUSED';
  detail: string;
  message: string;
  findings: ProgramFinding[];
}

export interface ProgramOp {
  id: string;
  kind: ProgramKind;
  opKey: string;
  owner?: string;
  hash: string;
  /** program: the caller's source (kept until done; the entry keeps it after) */
  source?: string;
  /** program: its sha256 */
  programSha?: string;
  /** variant: the source entry */
  entryId?: string;
  params: Record<string, unknown>;
  bible?: ProgramBible;
  reserved?: Reserved;
  status: 'running' | 'done';
  newEntryId?: string;
  refused?: ProgramRefusal;
  createdAt: number;
  updatedAt: number;
}

export interface ProgramHost {
  readonly config: Config;
  readonly log: Logger;
  readonly bibleIndex: { resolve(ref: { id: string; version: number } | string): { pin: { id: string; version: number }; files: { json: string }; info: { name?: string } } };
  now(): number;
  emit(msg: Outbound): void;
  entryHead(entryId: string): number;
  kitHas(flag: string): boolean;
}

export const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** What the ack and follow.upsert carry. */
export function programView(op: ProgramOp): Record<string, unknown> {
  return {
    id: op.id,
    kind: op.kind === 'program' ? 'fromProgram' : 'keyedVariant',
    status: op.status,
    opKey: op.opKey,
    ...(op.entryId ? { entryId: op.entryId } : {}),
    ...(op.programSha ? { programSha: op.programSha } : {}),
    ...(op.newEntryId ? { newEntryId: op.newEntryId } : {}),
    ...(op.refused ? { refused: op.refused } : {}),
  };
}

/** The rule a checker error line belongs to (check.mjs prints plain lines; their prefix names the rule). Pure. */
export function findingRule(msg: string): string {
  const m = msg.trim();
  if (/^reserved:/.test(m)) return 'reserved';
  if (/^size \S+ exceeds the (limit|maximum)/.test(m)) return 'size';
  if (/^values:/.test(m)) return 'params';
  if (/^palette:/.test(m)) return 'palette';
  if (/^massing:/.test(m)) return 'massing';
  if (/^sidecar:/.test(m)) return 'sidecar';
  if (/^(structure:|blocks\[|duplicate block|block at \S+ outside|no blocks)/.test(m)) return 'structure';
  if (/^(palette\[|unknown or non-vanilla blocks)/.test(m)) return 'blocks';
  if (/^(missing required anchor|anchor )/.test(m)) return 'anchors';
  if (/^fill:/.test(m)) return 'fill';
  if (/^design \S+ threw|^kit\/designs\//.test(m)) return 'program';
  return 'check';
}

/** A failed build as a typed refusal (pure but for the check result). */
export function refusalOf(res: CheckResult, what: string): ProgramRefusal {
  const errs = res.errors?.length ? res.errors : [];
  const findings: ProgramFinding[] = errs.slice(0, 50).map((e) => ({ rule: findingRule(e), severity: 'error', message: truncate(e.replace(/\s+/g, ' ').trim(), 600) }));
  let detail: string;
  if (res.timedOut) detail = 'timeout';
  else if (res.code === 1) detail = findings[0]?.rule ?? 'check';
  else if (findings.some((f) => f.rule === 'params' || f.rule === 'palette')) detail = findings.find((f) => f.rule === 'params' || f.rule === 'palette')!.rule;
  else detail = 'program';
  if (detail === 'program' && !findings.length) findings.push({ rule: 'program', severity: 'error', message: truncate((res.problem ?? 'the program failed').replace(/\s+/g, ' ').trim(), 600) });
  const message = `${what}: ${truncate((res.problem ?? findings.map((f) => f.message).join('; ')).replace(/\s+/g, ' ').trim(), 600)}`;
  return { code: 'PROGRAM_REFUSED', detail, message, findings };
}

/** The `export const id = '...'` a program declares (its library id base), else `given`. */
export function declaredId(source: string): string {
  const m = /export\s+const\s+id\s*=\s*(['"`])([a-z0-9_]{1,48})\1/.exec(source);
  return m?.[2] ?? 'given';
}

/** A synchronous typed refusal (before the ack). */
export class ProgramRefused extends RefusedError {
  constructor(detail: string, message: string) {
    super('PROGRAM_REFUSED', detail, message);
  }
}

/**
 * A given program's source checks (PROGRAM_REFUSED `program`): its length, a default export, and (SA, A25) well-formed UTF-16: a lone
 * surrogate does not round-trip through UTF-8 (the file on disk, the mod's wire), so the recorded sha would later read `program_stale`.
 */
export function checkProgramSource(source: string): void {
  if (source.length > PROGRAM_SOURCE_MAX) throw new ProgramRefused('program', `the program is ${source.length} characters (at most ${PROGRAM_SOURCE_MAX})`);
  const bad = loneSurrogate(source);
  if (bad >= 0) throw new ProgramRefused('program', `the program has a lone UTF-16 surrogate at character ${bad} (U+${source.charCodeAt(bad).toString(16).toUpperCase()}): it is not text that survives UTF-8; remove or escape it`);
  if (!/export\s+default\b/.test(source)) throw new ProgramRefused('program', 'the program has no default export (a kit design program: `export default function build({ palette, ...values })`)');
}

/** The index of the first lone UTF-16 surrogate in a string, or -1. */
export function loneSurrogate(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      return i;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return i;
  }
  return -1;
}

export class Programs {
  private queue: string[] = [];
  private runP: Promise<void> | undefined;
  private stopped = false;
  private taken = new Set<string>();

  constructor(private host: ProgramHost) {}

  private dir(): string {
    return path.join(this.host.config.dataDir, 'programs');
  }

  private file(id: string): string {
    return path.join(this.dir(), `${id}.json`);
  }

  get(id: string): ProgramOp | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as ProgramOp;
    } catch {
      return undefined;
    }
  }

  private save(op: ProgramOp): void {
    op.updatedAt = this.host.now();
    fs.mkdirSync(this.dir(), { recursive: true });
    writeFileAtomic(this.file(op.id), `${JSON.stringify(op, null, 1)}\n`);
  }

  /** One file per (owner, kind, opKey). */
  keyId(kind: ProgramKind, owner: string | undefined, opKey: string): string {
    return `${kind === 'program' ? 'gp' : 'kv'}${crypto.createHash('sha256').update(`${kind}|${owner ?? ''}|${opKey}`).digest('hex').slice(0, 20)}`;
  }

  /** The operation a key names (same key and body: it; another body: op_key_conflict; none: undefined). */
  private prior(kind: ProgramKind, owner: string | undefined, opKey: string, body: Record<string, unknown>): ProgramOp | undefined {
    const prior = this.get(this.keyId(kind, owner, opKey));
    if (!prior) return undefined;
    if (prior.hash !== bodyHash(body)) throw new ClientError(`${OP_KEY_CONFLICT}: opKey "${opKey}" (${kind === 'program' ? 'fromProgram' : 'variant'}${owner ? `, ${owner}` : ''}) was used for another ${kind === 'program' ? 'given program' : 'keyed variant'}${prior.entryId ? ` (${prior.entryId})` : ''}`);
    this.host.log.info(`${kind} ${prior.id}: replayed by opKey ${opKey} (${prior.status})`);
    return prior;
  }

  private sandboxReady(): void {
    if (!permissionFlag()) throw new ClientError(`given programs run in Node's permission model (Node 22.13 or later; this is ${process.version})`);
  }

  private checkBible(bible: ProgramBible | undefined): void {
    if (bible) this.host.bibleIndex.resolve(pinRef(bible)); // ClientError when there is no such bible / version
  }

  /** design.fromProgram */
  fromProgram(source: string, params: Record<string, unknown>, bible: ProgramBible | undefined, opKey: string, owner?: string): ProgramOp {
    const body = { type: 'design.fromProgram', source, params, ...(bible ? { bible } : {}) };
    // (SA, A25) the source's own checks run before a replay too: a replay gets the answer a fresh request would (an operation kept from
    // before a check was added is refused, not returned)
    checkProgramSource(source);
    const prior = this.prior('program', owner, opKey, body);
    if (prior) return prior;
    this.sandboxReady();
    this.checkBible(bible);
    const now = this.host.now();
    const op: ProgramOp = { id: this.keyId('program', owner, opKey), kind: 'program', opKey, ...(owner ? { owner } : {}), hash: bodyHash(body), source, programSha: sha256(source), params, ...(bible ? { bible } : {}), status: 'running', createdAt: now, updatedAt: now };
    this.save(op);
    this.host.log.info(`given program ${op.id}: ${declaredId(source)} (sha ${op.programSha!.slice(0, 12)})`);
    this.enqueue(op.id);
    return op;
  }

  /** design.variant */
  variant(entryId: string, params: Record<string, unknown>, bible: ProgramBible | undefined, reserved: Reserved | undefined, opKey: string, owner?: string): ProgramOp {
    const body = { type: 'design.variant', entryId, params, ...(bible ? { bible } : {}), ...(reserved ? { reserved } : {}) };
    const prior = this.prior('variant', owner, opKey, body);
    if (prior) return prior;
    const src = this.programOf(entryId);
    if (reserved && !this.host.kitHas('--reserved')) throw new ClientError("this helper's kit cannot check reserved cells (no build.mjs --reserved)");
    this.sandboxReady();
    this.checkBible(bible);
    const now = this.host.now();
    const op: ProgramOp = { id: this.keyId('variant', owner, opKey), kind: 'variant', opKey, ...(owner ? { owner } : {}), hash: bodyHash(body), entryId, programSha: src.sha, params, ...(bible ? { bible } : {}), ...(reserved ? { reserved } : {}), status: 'running', createdAt: now, updatedAt: now };
    this.save(op);
    this.host.log.info(`keyed variant ${op.id}: ${entryId} (opKey ${opKey})`);
    this.enqueue(op.id);
    return op;
  }

  /** design.variantByKey: the keyed variant's operation, or undefined when this key never made one. */
  variantByKey(opKey: string, owner?: string): ProgramOp | undefined {
    return this.get(this.keyId('variant', owner, opKey));
  }

  /** A given-program entry's exact source, its sha checked against the recorded one. Throws the typed refusals. */
  private programOf(entryId: string): { source: string; sha: string; entry: Record<string, unknown>; dir: string } {
    let src;
    try {
      src = findVariantSource(this.host.config.libraryDir, this.host.config.kitDir, entryId);
    } catch (e) {
      const msg = (e as Error).message;
      if (e instanceof VariantRefused && /^no library entry/.test(msg)) throw new RefusedError('VERSION_REFUSED', 'no_entry', msg);
      throw new ProgramRefused('not_given', `${entryId} is not a given-program entry (${msg})`);
    }
    const entry = src.entry ?? {};
    const gp = entry.givenProgram as { sha?: unknown } | undefined;
    const dir = path.dirname(src.sourceFile);
    const file = path.join(dir, PROGRAM_FILE);
    if (src.bundled || !gp || typeof gp.sha !== 'string' || !fs.existsSync(file)) throw new ProgramRefused('not_given', `${entryId} is not a given-program entry (Designs.fromProgram makes one); its variants are Library.makeVariant`);
    const source = fs.readFileSync(file, 'utf8');
    const sha = sha256(source);
    if (sha !== gp.sha) throw new ProgramRefused('program_stale', `${entryId}'s program/source.mjs is not the program it was made from (sha ${sha.slice(0, 12)}, recorded ${gp.sha.slice(0, 12)})`);
    return { source, sha, entry, dir };
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
      // inside the request they ran before the design.fromProgram / design.variant ack was written; under load the ack missed the mod's 20 s window
      await new Promise<void>((r) => setImmediate(r));
      try {
        while (!this.stopped && this.queue.length) {
          const next = this.queue.shift()!;
          try {
            await this.run(next);
          } catch (e) {
            this.host.log.warn(`given program ${next}: stopped: ${(e as Error).message}`);
          }
        }
      } finally {
        this.runP = undefined;
      }
    })();
  }

  private finish(op: ProgramOp, out: { newEntryId: string } | { refused: ProgramRefusal }): void {
    op.status = 'done';
    if ('newEntryId' in out) op.newEntryId = out.newEntryId;
    else op.refused = { ...out.refused, message: truncate(out.refused.message.replace(/\s+/g, ' ').trim(), 800) };
    // the entry keeps the source (program/source.mjs); the operation file needs only its sha
    delete op.source;
    this.save(op);
    this.host.log.info(`${op.kind} ${op.id}: ${op.newEntryId ? `installed ${op.newEntryId}` : `refused ${op.refused!.code} ${op.refused!.detail}`}`);
    this.host.emit({ type: 'follow.upsert', follow: programView(op) } as Outbound);
  }

  private refuse(op: ProgramOp, detail: string, message: string): void {
    this.finish(op, { refused: { code: 'PROGRAM_REFUSED', detail, message, findings: [{ rule: detail, severity: 'error', message: truncate(message, 600) }] } });
  }

  private async run(id: string): Promise<void> {
    const op = this.get(id);
    if (!op || op.status !== 'running') return;
    const cfg = this.host.config;
    // the program and what the entry is made from
    let source: string;
    let base: string;
    let entry: Record<string, unknown> = {};
    if (op.kind === 'program') {
      source = op.source ?? '';
      base = slugify(declaredId(source), 48) || 'given';
    } else {
      try {
        const p = this.programOf(op.entryId!);
        if (p.sha !== op.programSha) return this.refuse(op, 'program_stale', `${op.entryId}'s program changed since the variant was asked for (sha ${p.sha.slice(0, 12)}, asked ${op.programSha!.slice(0, 12)})`);
        source = p.source;
        entry = p.entry;
      } catch (e) {
        if (e instanceof RefusedError) return this.refuse(op, e.code === 'VERSION_REFUSED' ? 'no_entry' : e.detail, e.message);
        throw e;
      }
      base = `${op.entryId!.slice(0, 56)}_kv`;
    }
    // a resume after a kill between the install and the record: the entry this operation installed
    const done = this.installedBy(op, base);
    if (done) return this.finish(op, { newEntryId: done });
    const perm = permissionFlag();
    if (!perm) return this.refuse(op, 'sandbox', `given programs run in Node's permission model (this is ${process.version})`);
    const scratch = path.join(cfg.dataDir, 'program-scratch', id);
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    const bp = freeLibraryId(cfg.libraryDir, base, this.taken);
    this.taken.add(bp);
    try {
      const work = fs.realpathSync(scratch);
      refreshKit(cfg.kitDir, work);
      const design = path.join(work, KIT, 'designs', `${bp}.mjs`);
      fs.writeFileSync(design, withDesignId(normalizeKitImports(source), bp));
      fs.mkdirSync(path.join(work, 'program'), { recursive: true });
      fs.writeFileSync(path.join(work, PROGRAM_FILE), source);
      // the bible: asked, else (a variant) the entry's own pin, else the program's default palette
      const pin = op.bible ?? (op.kind === 'variant' && isPin(entry.bible) ? entry.bible : undefined);
      let bibleArgs: string[] = [];
      let biblePin: { id: string; version: number } | undefined;
      let bibleName: string | undefined;
      if (pin) {
        let target;
        try {
          target = this.host.bibleIndex.resolve(pinRef(pin));
        } catch (e) {
          return this.refuse(op, 'palette', `the bible ${pin.id}${pin.version ? ` v${pin.version}` : ''}: ${(e as Error).message}`);
        }
        fs.copyFileSync(target.files.json, path.join(work, 'program-bible.json'));
        bibleArgs = ['--bible', 'program-bible.json'];
        biblePin = target.pin;
        bibleName = target.info.name;
      }
      const baseValues = op.kind === 'variant' && entry.values && typeof entry.values === 'object' ? (entry.values as Record<string, unknown>) : {};
      const values = { ...baseValues, ...op.params };
      const extra = [
        ...bibleArgs,
        ...(Object.keys(values).length ? ['--values', JSON.stringify(values)] : []),
        ...(op.reserved ? ['--reserved', JSON.stringify(op.reserved)] : []),
      ];
      const flags = sandboxFlags(work, cfg.regions.planHeapMb, NO_NETWORK, perm)!;
      // no request: the program's own type and profile stand (no --type, no --profile, no --max)
      const res = await checkDesign(cfg.kitDir, work, bp, {}, cfg.regions.planMs, extra, flags);
      if (!res.ok) return this.finish(op, { refused: refusalOf(res, op.kind === 'program' ? 'the given program did not pass' : `the variant of ${op.entryId} did not pass`) });
      const rp = await renderPreviews(work, res.nbt!, Math.max(cfg.regions.planMs, 60_000));
      if (this.stopped) return;
      const sc = res.sidecar!;
      const name = typeof sc.name === 'string' ? sc.name : bp;
      const sourceVersion = op.kind === 'variant' ? this.host.entryHead(op.entryId!) : undefined;
      const givenProgram = { sha: op.programSha!, opKey: op.opKey, ...(op.owner ? { owner: op.owner } : {}) };
      const installed = installDesign({
        library: cfg.libraryDir,
        baseId: bp,
        taken: new Set([...this.taken].filter((x) => x !== bp)),
        nbt: res.nbt!,
        sidecar: sc,
        source: design,
        previews: rp.files,
        files: [{ from: path.join(work, PROGRAM_FILE), to: PROGRAM_FILE }],
        meta: {
          name,
          description: typeof sc.description === 'string' ? sc.description : undefined,
          createdAt: this.host.now(),
          extra: {
            givenProgram,
            programOp: op.id,
            values,
            ...(biblePin ? { bible: biblePin } : {}),
            ...(op.reserved ? { reserved: op.reserved } : {}),
            ...(op.kind === 'variant'
              ? {
                  variantOf: op.entryId,
                  variantOfVersion: sourceVersion,
                  derivation: { source: op.entryId, sourceVersion, kind: 'variant', recipe: { values: op.params, ...(biblePin ? { bible: biblePin } : {}), ...(op.reserved ? { reserved: op.reserved } : {}), programSha: op.programSha, opKey: op.opKey } },
                  displayName: truncate(`${typeof entry.name === 'string' ? entry.name : name}${bibleName ? ` (${bibleName})` : ''}`, 80),
                  ...(isExt(entry.ext) ? { ext: entry.ext } : {}),
                }
              : {}),
          },
        },
      });
      this.finish(op, { newEntryId: installed.blueprintId });
    } finally {
      this.taken.delete(bp);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** The library entry an operation installed (its `programOp`), if a kill came between the install and the record. */
  private installedBy(op: ProgramOp, base: string): string | undefined {
    const lib = this.host.config.libraryDir;
    if (!fs.existsSync(lib)) return undefined;
    for (const d of fs.readdirSync(lib).filter((x) => x === base || x.startsWith(`${base}_`)).sort()) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(lib, d, `${d}.blueprint.json`), 'utf8')) as { programOp?: string };
        if (j.programOp === op.id) return d;
      } catch {
        /* not it */
      }
    }
    return undefined;
  }
}

function isPin(v: unknown): v is { id: string; version: number } {
  return !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' && Number.isInteger((v as { version?: unknown }).version);
}

/** A bible as the index resolves it: a pin, or the id alone for its latest version. */
function pinRef(b: ProgramBible): { id: string; version: number } | string {
  return b.version ? { id: b.id, version: b.version } : b.id;
}
