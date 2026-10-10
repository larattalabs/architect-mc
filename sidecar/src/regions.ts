// (6a) Region programs in the sidecar (docs/CONTRACT.md "Phase 6 contract": §1 "Where programs run", §3 "Streaming",
// §6 "Sidecar protocol (2, additive)"; kit/REGIONS.md "Sidecar protocol"):
//
//   region.plan          ack {planId, seed} at once; then the kit's plan CLI (`node <kit>/tools/region.mjs plan ...`) runs in
//                        a child process under Node's permission model (reads: the kit, the plan dir and, for a program
//                        of the player's, the programs dir; writes: the plan dir only; no child processes, no workers,
//                        network calls refused), a minimal environment, `--max-old-space-size` and a time limit; the
//                        plan dir <data>/regions/plans/<planId>/ keeps program.mjs (a copy), survey.bin, params.json,
//                        bible.json, ir.json and plan.json; then `region.planned` or `region.failed` (broadcast).
//   region.tiles.request ack {accepted}, or `ir_unknown`; then one `region.tile` (frames) or `region.tile.error` per tile.
//                        At most `regionWindow` tiles per plan and connection are being evaluated or sent at once (a tile
//                        holds its slot until its last frame is flushed to the socket); the rest wait in a queue.
//   region.release       drops the plan's queued tiles (this connection) and its cached IR (with `evict`, also when other
//                        plans share it). The plan dir stays.
//
// (6b, CONTRACT "# Phase 6b contract" §1.1 "Sidecar", §2.2, §2.4, §3, §6.4; kit/REGIONS.md "# Phase 6b additions"):
//
//   - the kit's KIT_VERSION, IR_FORMATS and KINDS_FORMAT2 are read once (a sandboxed child, never imported here) for the
//     hello snapshot; IRs of every format the kit reads are accepted (`format: 2` included);
//   - region.plan gains `check` (default true) and `volumes`; the plan CLI gets `--blobs-out <planDir>/blobs` and
//     `--volumes <planDir>/volumes`; after a good plan the kit's `check` and then `preview` run in the same sandbox
//     (their own time limit, regionCheckMs, together), with `region.progress` at planning / checking / rendering;
//     `region.planned` carries the side blobs (each also a blob-store blob of kind region.blob), the report, the
//     previews and the site plan;
//   - region.check / region.preview re-run the kit over the plan dir;
//   - tile requests resolve the IR first (`ir_unknown`), then every side blob the IR names (plan dir, the blob cache
//     <data>/regions/blobs/<sha>.bin, or the request's `blobs`), else `blob_unknown <sha>,<sha>...`; the bytes go to a
//     worker once per IR (shared memory);
//   - ghost tiles (`preview: true`): no heights; windows from the plan dir's survey.bin (the kit's windowFromSurvey, in
//     the worker), every stage up to the requested one, both sets unless one is named; frames carry `preview: true`.
//
// Nothing persists per connection: a connection that goes away loses its queued and in-flight tiles; the plan dirs and
// the IR cache stay. Planning never calls Claude, on either backend.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { BlobStore } from './blobs.js';
import type { BibleIndex } from './bibles.js';
import type { Config } from './config.js';
import type { Logger } from './context.js';
import { minimalEnv, outputTail } from './designs.js';
import { ClientError } from './errors.js';
import { parseCatalogue, type CatalogueProgram } from './regiondesign.js';
import { IR_INLINE_BYTES, MAX_TILE_FRAME_BYTES, PREVIEW_VIEWS, REGION_PROGRAM_ID, type Outbound, type RegionPlanMsg, type RegionTilesRequestMsg } from './protocol.js';
import type { ClientHandle } from './server.js';
import { TilePool, type TileResult } from './regionpool.js';
import { run } from './util/proc.js';
import { isInsideOrEqual } from './util/fsx.js';
import { truncate } from './util/text.js';
import type { z } from 'zod';

type PlanMsg = z.infer<typeof RegionPlanMsg>;
type TilesMsg = z.infer<typeof RegionTilesRequestMsg>;

/** Tiles one connection may have queued or in flight per plan (the mod keeps W outstanding; this only stops a runaway client). */
export const MAX_PENDING_TILES = 256;
/** IRs kept in memory (each at most 4 MB of JSON). */
export const IR_CACHE_SIZE = 8;
/** (6b) The blob store kind of a region side blob (kit/REGIONS.md "Protocol (2, additive)"). */
export const REGION_BLOB_KIND = 'region.blob';
/** (6b) A frozen ARVX volume decompresses to at most this (the mod's 268M-cell limit is about 0.2 bytes of runs per natural cell). */
const MAX_VOLUME_RAW_BYTES = 512 * 1024 * 1024;

/** Refuses networking inside the plan child (Node 24's permission model has no network switch). Loaded with --import. */
const NO_NETWORK = [
  "import net from 'node:net'; import tls from 'node:tls'; import dgram from 'node:dgram'; import dns from 'node:dns'; import http from 'node:http'; import https from 'node:https';",
  "import { syncBuiltinESMExports } from 'node:module';",
  "const no = () => { throw Object.assign(new Error('network access is not allowed in a region plan'), { code: 'ERR_ACCESS_DENIED' }); };",
  'net.connect = net.createConnection = net.createServer = no; net.Socket.prototype.connect = no; net.Server.prototype.listen = no;',
  'tls.connect = tls.createServer = no; dgram.createSocket = no; dns.lookup = dns.resolve = no; dns.promises.lookup = dns.promises.resolve = no;',
  'http.request = http.get = http.createServer = https.request = https.get = https.createServer = no;',
  "for (const k of ['fetch', 'WebSocket', 'EventSource']) { try { Object.defineProperty(globalThis, k, { value: undefined, configurable: false, writable: false }); } catch {} }",
  'syncBuiltinESMExports();',
].join('\n');

/** (6b) Prints the kit's version constants as one JSON line; run in a read-only sandbox (argv[1] = the kit dir). */
const KIT_INFO = [
  "import path from 'node:path'; import { pathToFileURL } from 'node:url';",
  'const kit = process.argv[1]; const out = {};',
  "try { const p = await import(pathToFileURL(path.join(kit, 'lib', 'region', 'plan.mjs')).href); if (typeof p.KIT_VERSION === 'string') out.kitVersion = p.KIT_VERSION; } catch (e) { out.planError = String(e?.message ?? e); }",
  "try { const r = await import(pathToFileURL(path.join(kit, 'lib', 'realise.mjs')).href); if (Array.isArray(r.IR_FORMATS)) out.irFormats = [...r.IR_FORMATS]; if (Array.isArray(r.KINDS_FORMAT2)) out.irKinds = [...r.KINDS_FORMAT2]; } catch (e) { out.realiseError = String(e?.message ?? e); }",
  'console.log(JSON.stringify(out));',
].join('\n');

/** Node's permission switch: `--permission` (Node >= 22.13 / 23.5), `--experimental-permission` before that, or none. */
export function permissionFlag(flags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags): string | undefined {
  if (flags.has('--permission')) return '--permission';
  if (flags.has('--experimental-permission')) return '--experimental-permission';
  return undefined;
}

/** Canonical JSON (keys sorted, no whitespace): the IR's identity (REGIONS.md "The Region IR"). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('canonical JSON has no NaN or Infinity');
    return JSON.stringify(v) ?? 'null';
  }
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export function sha256(data: string | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** (6b) What the sidecar's kit says about itself (the hello snapshot, the format gate) and which 6b commands it has. */
export interface KitInfo {
  /** KIT_VERSION of kit/lib/region/plan.mjs, 'unknown' without one */
  kitVersion: string;
  /** IR_FORMATS of kit/lib/realise.mjs, [1] without one */
  irFormats: number[];
  /** KINDS_FORMAT2, [] without one */
  irKinds: string[];
  /** the plan CLI takes --blobs-out / --volumes; the kit has check, preview, catalogue (tools/region.mjs and the modules) */
  caps: { blobsOut: boolean; volumes: boolean; check: boolean; preview: boolean; catalogue: boolean };
}

/** (6b) The side blob shas a format-2 IR names (`blobs: {name: {sha, bytes, kind}}`); format-1 blobs are inline: none. */
export function sideBlobs(ir: Record<string, unknown>): Array<{ name: string; sha: string; bytes: number; kind: string }> {
  if (typeof ir.format !== 'number' || ir.format < 2 || !ir.blobs || typeof ir.blobs !== 'object' || Array.isArray(ir.blobs)) return [];
  const out: Array<{ name: string; sha: string; bytes: number; kind: string }> = [];
  for (const [name, b] of Object.entries(ir.blobs as Record<string, unknown>)) {
    if (!b || typeof b !== 'object') continue;
    const e = b as { sha?: unknown; bytes?: unknown; kind?: unknown; data?: unknown };
    if (typeof e.sha !== 'string' || e.data !== undefined) continue;
    out.push({ name, sha: e.sha, bytes: typeof e.bytes === 'number' ? e.bytes : -1, kind: typeof e.kind === 'string' ? e.kind : 'field' });
  }
  return out;
}

const SHA_RE = /^[0-9a-f]{64}$/;

/** What the sidecar needs from its host (the Sidecar). */
export interface RegionsHost {
  config: Config;
  blobs: BlobStore;
  bibleIndex: Pick<BibleIndex, 'resolve'>;
  log: Logger;
  emit(m: Outbound): void;
  now(): number;
}

interface Job {
  irSha: string;
  irJson: string;
  key: string;
  /** a ghost tile: every stage up to this one when given (else every stage) */
  stage: string | undefined;
  /** a ghost tile: this set when given (else both) */
  set: 'terrain' | 'path' | undefined;
  /** absent for a ghost tile */
  heights: Buffer | undefined;
  /** (6b) the IR's side blobs, by sha (shipped to a worker with the IR) */
  blobs: (() => Record<string, Uint8Array>) | undefined;
  /** (6b) a ghost tile: the plan survey */
  survey: { id: string; bytes: () => Uint8Array } | undefined;
}

interface Session {
  client: ClientHandle;
  planId: string;
  queue: Job[];
  /** tiles being evaluated or sent */
  active: number;
  /** the most ever active at once (tests, numbers) */
  peak: number;
  closed: boolean;
}

interface ProgramRef {
  /** the file the plan runs (a bundled program runs from the kit, so its relative imports resolve) */
  file: string;
  bundled: boolean;
  label: string;
}

interface IrEntry {
  json: string;
  plans: Set<string>;
  /** (6b) side blob shas (format 2), parsed once */
  shas?: string[];
  /** (6b) verified side blob files, by sha */
  files: Map<string, string>;
  /** (6b) the bytes in shared memory, made when a worker first needs them */
  shared?: Record<string, Uint8Array>;
}

type KitRun = { ok: true; out: Record<string, unknown>; ms: number } | { ok: false; message: string; ms: number };

export class Regions {
  private pool: TilePool | undefined;
  private irs = new Map<string, IrEntry>();
  private sessions = new Map<string, Session>();
  private planSlots = 0;
  private planWaiters: Array<() => void> = [];
  private running = new Set<Promise<void>>();
  /** (6b) plans whose plan, check or previews are still running */
  private planning = new Set<string>();
  /** (6b) one region.check / region.preview at a time per plan */
  private planLocks = new Map<string, Promise<unknown>>();
  /** (6b) plan surveys in shared memory for ghost tiles, by planId (small LRU) */
  private surveys = new Map<string, { id: string; bytes: Uint8Array; mtimeMs: number }>();
  private info: KitInfo | undefined;
  /** (tests, numbers) the most tiles ever active for one plan and connection */
  peakActive = 0;

  constructor(private host: RegionsHost) {}

  private get cfg() {
    return this.host.config.regions;
  }

  plansDir(): string {
    return path.join(this.host.config.dataDir, 'regions', 'plans');
  }

  planDir(planId: string): string {
    return path.join(this.plansDir(), planId);
  }

  /** (6b) The side-blob cache: <data>/regions/blobs/<sha>.bin */
  blobCacheDir(): string {
    return path.join(this.host.config.dataDir, 'regions', 'blobs');
  }

  // ---- (6b) the kit's versions ----------------------------------------------------------------------

  /**
   * The kit's KIT_VERSION / IR_FORMATS / KINDS_FORMAT2, read once (the first hello or plan) by a child process that may only
   * read the kit: kit code never runs in the sidecar's own process. A kit without them: 'unknown', [1], [].
   */
  kitInfo(): KitInfo {
    if (this.info) return this.info;
    const kit = this.host.config.kitDir;
    const info: KitInfo = { kitVersion: 'unknown', irFormats: [1], irKinds: [], caps: { blobsOut: false, volumes: false, check: false, preview: false, catalogue: false } };
    let tool = '';
    try {
      tool = fs.readFileSync(path.join(kit, 'tools', 'region.mjs'), 'utf8');
    } catch {
      /* an older kit */
    }
    // the CLI's 6b commands and flags (an older kit exits 2 on an unknown flag, so they are passed only when it has them)
    info.caps = {
      blobsOut: tool.includes('blobs-out'),
      volumes: /['"]?volumes['"]?\s*:/.test(tool) || tool.includes("'--volumes'"),
      check: fs.existsSync(path.join(kit, 'lib', 'region', 'check.mjs')) && /['"]check['"]/.test(tool),
      preview: fs.existsSync(path.join(kit, 'lib', 'region', 'preview.mjs')) && /['"]preview['"]/.test(tool),
      catalogue: /['"]catalogue['"]/.test(tool),
    };
    const perm = permissionFlag();
    try {
      const realKit = fs.existsSync(kit) ? fs.realpathSync(kit) : kit;
      const r = spawnSync(process.execPath, [...(perm ? [perm, `--allow-fs-read=${realKit}`] : []), '--input-type=module', '-e', KIT_INFO, realKit], { env: minimalEnv(), timeout: 20_000, encoding: 'utf8', windowsHide: true });
      const out = lastJson(r.stdout ?? '') ?? {};
      if (typeof out.kitVersion === 'string' && out.kitVersion) info.kitVersion = out.kitVersion;
      if (Array.isArray(out.irFormats) && out.irFormats.every((f) => Number.isInteger(f))) info.irFormats = (out.irFormats as number[]).slice().sort((a, b) => a - b);
      if (Array.isArray(out.irKinds)) info.irKinds = out.irKinds.map(String);
      if (out.planError || out.realiseError || r.status !== 0) this.host.log.debug(`kit info: ${truncate(String(out.planError ?? out.realiseError ?? r.stderr ?? ''), 200)}`);
    } catch (e) {
      this.host.log.warn(`kit info: ${(e as Error).message}`);
    }
    if (!info.irFormats.includes(1)) info.irFormats = [1, ...info.irFormats];
    this.info = info;
    this.host.log.info(`kit ${info.kitVersion}: IR formats ${info.irFormats.join(', ')}${info.caps.check ? ', checker' : ''}${info.caps.preview ? ', previews' : ''}${info.caps.catalogue ? ', catalogue' : ''}`);
    return info;
  }

  /** (6b) An IR format this sidecar's kit reads. */
  private formatOk(format: unknown): boolean {
    return typeof format === 'number' && this.kitInfo().irFormats.includes(format);
  }

  // ---- region.plan --------------------------------------------------------------------------------

  /** Check the request, write the plan dir's inputs and start the plan run; answers at once. */
  plan(msg: PlanMsg): { planId: string; seed: string } {
    if (msg.bibleVersion !== undefined && !msg.bible) throw new ClientError('bibleVersion needs bible');
    const program = this.resolveProgram(msg.program);
    const survey = this.host.blobs.read(msg.surveyBlobId);
    let bible: { id: string; version: number } | undefined;
    let roles: Record<string, string> = {};
    if (msg.bible) {
      const r = this.host.bibleIndex.resolve(msg.bibleVersion ? { id: msg.bible, version: msg.bibleVersion } : msg.bible);
      bible = r.pin;
      roles = { ...r.info.roles };
    }
    roles = { ...roles, ...(msg.roles ?? {}) };
    // no seed: the kit's default, fnv64(programId, canonical(params), claim) (CONTRACT §1 "Seeds and determinism"); never random
    const seed = msg.seed !== undefined ? BigInt(msg.seed).toString() : 'default';
    if (seed !== 'default' && BigInt(seed) > 0xffffffffffffffffn) throw new ClientError('seed is larger than a u64');
    // (6b) frozen volumes: the blob's gzip ARVX, checked against its sha (of the UNCOMPRESSED bytes) before anything is written
    const volumes = (msg.volumes ?? []).map((v) => {
      const gz = this.host.blobs.read(v.blobId);
      let raw: Buffer;
      try {
        raw = zlib.gunzipSync(gz, { maxOutputLength: MAX_VOLUME_RAW_BYTES });
      } catch (e) {
        throw new ClientError(`volume ${v.name ?? v.sha.slice(0, 12)}: blob ${v.blobId} is not a gzip ARVX file (${(e as Error).message})`);
      }
      if (raw.toString('latin1', 0, 4) !== 'ARVX') throw new ClientError(`volume ${v.name ?? v.sha.slice(0, 12)}: blob ${v.blobId} is not an ARVX file`);
      const got = sha256(raw);
      if (got !== v.sha) throw new ClientError(`volume ${v.name ?? v.sha.slice(0, 12)}: blob ${v.blobId}'s ARVX hashes to ${got}, not ${v.sha}`);
      return { ...v, gz };
    });
    const info = this.kitInfo();
    if (volumes.length && !info.caps.volumes) throw new ClientError(`the kit (${info.kitVersion}) cannot read volumes (its plan CLI has no --volumes)`);
    const check = msg.check !== false;
    const planId = `p${this.host.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    fs.mkdirSync(this.planDir(planId), { recursive: true });
    const dir = fs.realpathSync(this.planDir(planId));
    fs.copyFileSync(program.file, path.join(dir, 'program.mjs'));
    fs.writeFileSync(path.join(dir, 'survey.bin'), survey);
    fs.writeFileSync(path.join(dir, 'params.json'), JSON.stringify(msg.params));
    if (info.caps.blobsOut) fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
    if (volumes.length) {
      fs.mkdirSync(path.join(dir, 'volumes'), { recursive: true });
      for (const v of volumes) fs.writeFileSync(path.join(dir, 'volumes', `${v.sha}.bin`), v.gz);
    }
    const hasBible = !!bible || Object.keys(roles).length > 0;
    if (hasBible) fs.writeFileSync(path.join(dir, 'bible.json'), JSON.stringify({ ...(bible ? { id: bible.id, version: bible.version } : {}), roles }));
    const request = {
      planId,
      program: program.label,
      bundled: program.bundled,
      params: msg.params,
      seed,
      claim: msg.claim,
      surveyBlobId: msg.surveyBlobId,
      ...(bible ? { bible } : {}),
      roles,
      check,
      ...(volumes.length ? { volumes: volumes.map((v) => ({ ...(v.name ? { name: v.name } : {}), sha: v.sha, blobId: v.blobId, box: v.box })) } : {}),
      createdAt: this.host.now(),
    };
    fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(request, null, 2));
    this.host.log.info(`region plan ${planId}: ${program.label}, claim ${msg.claim.minX},${msg.claim.minZ}..${msg.claim.maxX},${msg.claim.maxZ} y ${msg.claim.minY}..${msg.claim.maxY}, seed ${seed}${bible ? `, bible ${bible.id} v${bible.version}` : ''}${volumes.length ? `, ${volumes.length} volume${volumes.length === 1 ? '' : 's'}` : ''}${check ? '' : ', no check'}`);
    this.planning.add(planId);
    const p = this.withPlanSlot(() => this.runPlan(planId, dir, program, { seed, claim: msg.claim, hasBible, request, check, volumes: volumes.length > 0 })).finally(() => this.planning.delete(planId));
    this.running.add(p);
    void p.finally(() => this.running.delete(p));
    return { planId, seed };
  }

  /** A bundled id (kit/regions/<id>.mjs) or a .mjs under <gameDir>/architect/regions/programs; anything else is refused. */
  resolveProgram(program: string): ProgramRef {
    if (REGION_PROGRAM_ID.test(program)) {
      const file = path.join(this.host.config.kitDir, 'regions', `${program}.mjs`);
      if (!fs.existsSync(file)) throw new ClientError(`no bundled region program "${program}" (kit/regions/${program}.mjs)`);
      return { file: fs.realpathSync(file), bundled: true, label: program };
    }
    const dir = this.cfg.programsDir;
    const refuse = () => new ClientError(`a region program is a bundled id ([a-z][a-z0-9_]{0,47}) or a .mjs file under ${dir}`);
    if (!program.endsWith('.mjs')) throw refuse();
    const file = path.resolve(dir, program);
    if (!isInsideOrEqual(file, dir) || !fs.existsSync(dir)) throw refuse();
    let real: string;
    try {
      real = fs.realpathSync(file);
    } catch {
      throw new ClientError(`no region program ${file}`);
    }
    // through a link out of the programs dir: refused
    if (!isInsideOrEqual(real, fs.realpathSync(dir)) || !fs.statSync(real).isFile()) throw refuse();
    return { file: real, bundled: false, label: path.relative(dir, file).split(path.sep).join('/') };
  }

  private async withPlanSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.planSlots >= this.cfg.planConcurrency) await new Promise<void>((r) => this.planWaiters.push(r));
    this.planSlots++;
    try {
      return await fn();
    } finally {
      this.planSlots--;
      this.planWaiters.shift()?.();
    }
  }

  /** (6b) One region.check / region.preview at a time per plan (they write the same files). */
  private withPlanLock<T>(planId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.planLocks.get(planId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.planLocks.set(planId, tail);
    void tail.then(() => {
      if (this.planLocks.get(planId) === tail) this.planLocks.delete(planId);
    });
    return next;
  }

  /**
   * The kit CLI's arguments (kit/REGIONS.md "Plan CLI"). The one place that knows the CLI's shape:
   *   plan <program.mjs> --params <f> --survey <f> --seed <u64> --claim minX,minZ,maxX,maxZ,minY,maxY [--bible <f>] --out <planDir> --json
   *   (6b) [--blobs-out <planDir>/blobs] [--volumes <planDir>/volumes]
   */
  planArgs(dir: string, program: ProgramRef, o: { seed: string; claim: PlanMsg['claim']; hasBible: boolean; volumes?: boolean }): string[] {
    const c = o.claim;
    const caps = this.kitInfo().caps;
    return [
      'plan',
      program.file,
      '--params',
      path.join(dir, 'params.json'),
      '--survey',
      path.join(dir, 'survey.bin'),
      ...(o.seed === 'default' ? [] : ['--seed', o.seed]),
      '--claim',
      [c.minX, c.minZ, c.maxX, c.maxZ, c.minY, c.maxY].join(','),
      ...(o.hasBible ? ['--bible', path.join(dir, 'bible.json')] : []),
      ...(caps.blobsOut ? ['--blobs-out', path.join(dir, 'blobs')] : []),
      ...(o.volumes ? ['--volumes', path.join(dir, 'volumes')] : []),
      '--out',
      dir,
      '--json',
    ];
  }

  /** (6b) `check <ir.json> --survey <f> [--blobs <dir>] [--volumes <dir>] --out <planDir> --json` */
  checkArgs(dir: string): string[] {
    return ['check', path.join(dir, 'ir.json'), '--survey', path.join(dir, 'survey.bin'), ...this.sideDirArgs(dir), '--out', dir, '--json'];
  }

  /** (6b) `preview <ir.json> --survey <f> [--blobs <dir>] [--volumes <dir>] --views a,b [--axes <f>] --out <planDir> --json` */
  previewArgs(dir: string, views: readonly string[], axesFile?: string): string[] {
    return ['preview', path.join(dir, 'ir.json'), '--survey', path.join(dir, 'survey.bin'), ...this.sideDirArgs(dir), '--views', views.join(','), ...(axesFile ? ['--axes', axesFile] : []), '--out', dir, '--json'];
  }

  private sideDirArgs(dir: string): string[] {
    const has = (d: string) => {
      try {
        return fs.readdirSync(path.join(dir, d)).some((f) => f.endsWith('.bin'));
      } catch {
        return false;
      }
    };
    return [...(has('blobs') ? ['--blobs', path.join(dir, 'blobs')] : []), ...(has('volumes') ? ['--volumes', path.join(dir, 'volumes')] : [])];
  }

  /**
   * Run `node <kit>/tools/region.mjs <args>` in the plan sandbox: reads the kit, the plan dir (and `extraReads`), writes
   * the plan dir only, no network, a minimal environment, a heap cap and a wall-clock limit. The last JSON line of stdout.
   */
  private async runKit(dir: string, args: string[], o: { timeoutMs: number; heapMb: number; extraReads?: string[]; what: string }): Promise<KitRun> {
    const t0 = Date.now();
    const ms = () => Date.now() - t0;
    const kit = fs.realpathSync(this.host.config.kitDir);
    const script = path.join(kit, 'tools', 'region.mjs');
    if (!fs.existsSync(script)) return { ok: false, message: 'the kit has no tools/region.mjs (an older kit)', ms: ms() };
    const perm = permissionFlag();
    if (!perm) return { ok: false, message: `region planning needs Node's permission model (Node 22.13 or later; this is ${process.version})`, ms: ms() };
    if (o.timeoutMs <= 0) return { ok: false, message: `no time was left for the ${o.what}`, ms: 0 };
    const reads = [kit, dir, ...(o.extraReads ?? [])];
    const flags = [perm, ...reads.map((r) => `--allow-fs-read=${r}`), `--allow-fs-write=${dir}`, `--max-old-space-size=${o.heapMb}`, `--import=data:text/javascript,${encodeURIComponent(NO_NETWORK)}`];
    const r = await run(process.execPath, [...flags, script, ...args], { cwd: dir, env: minimalEnv(), timeoutMs: o.timeoutMs });
    const out = lastJson(r.stdout);
    if (r.timedOut) return { ok: false, message: `the ${o.what} took longer than ${Math.round(o.timeoutMs / 100) / 10} s and was stopped`, ms: ms() };
    if (/heap out of memory|ERR_WORKER_OUT_OF_MEMORY|Allocation failed/i.test(r.stderr)) return { ok: false, message: `the ${o.what} ran out of memory (${o.heapMb} MB heap)`, ms: ms() };
    if (r.code !== 0 || (out && out.ok === false)) {
      const msg = (typeof out?.error === 'string' && out.error) || (typeof out?.message === 'string' && out.message) || outputTail(`${r.stdout}\n${r.stderr}`) || `the ${o.what} exited with code ${r.code}`;
      return { ok: false, message: msg, ms: ms() };
    }
    return { ok: true, out: out ?? {}, ms: ms() };
  }

  private async runPlan(
    planId: string,
    dir: string,
    program: ProgramRef,
    o: { seed: string; claim: PlanMsg['claim']; hasBible: boolean; request: Record<string, unknown>; check: boolean; volumes: boolean },
  ): Promise<void> {
    const t0 = Date.now();
    const fail = (message: string) => {
      this.host.log.warn(`region plan ${planId} failed: ${truncate(message.split('\n')[0] ?? message, 300)}`);
      try {
        fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ planId, ok: false, message, ms: Date.now() - t0, request: o.request }, null, 2));
      } catch {
        /* the plan dir is gone */
      }
      this.host.emit({ type: 'region.failed', planId, message: truncate(message, 4000) } as Outbound);
    };
    try {
      this.progress(planId, 'planning');
      // a stale ir.json from nowhere must not count
      fs.rmSync(path.join(dir, 'ir.json'), { force: true });
      const r = await this.runKit(dir, this.planArgs(dir, program, o), { timeoutMs: this.cfg.planMs, heapMb: this.cfg.planHeapMb, extraReads: program.bundled ? [] : [fs.realpathSync(this.cfg.programsDir)], what: 'plan' });
      const ms = Date.now() - t0;
      if (!r.ok) return fail(r.message);
      const out = r.out;
      const irFile = path.join(dir, 'ir.json');
      if (!fs.existsSync(irFile)) return fail('the kit did not write ir.json');
      const size = fs.statSync(irFile).size;
      if (size > this.cfg.irMaxBytes) return fail(`the IR is ${size} bytes, more than the limit of ${this.cfg.irMaxBytes} bytes (4 MB)`);
      const bytes = fs.readFileSync(irFile);
      const irSha = sha256(bytes);
      if (typeof out.irSha === 'string' && out.irSha !== irSha) return fail(`the kit reported irSha ${out.irSha} but ir.json hashes to ${irSha}`);
      let ir: Record<string, unknown>;
      try {
        ir = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      } catch (e) {
        return fail(`ir.json is not JSON: ${(e as Error).message}`);
      }
      if (!ir || typeof ir !== 'object' || !this.formatOk(ir.format)) return fail(`the program did not return a Region IR (format ${this.kitInfo().irFormats.join(' or ')})`);
      const notes = Array.isArray(out.notes) ? out.notes.map((n) => (typeof n === 'string' ? n : JSON.stringify(n))) : [];
      const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
      let kitPlan: Record<string, unknown> = {};
      try {
        kitPlan = obj(JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')));
      } catch {
        /* the kit wrote none */
      }
      // (6b) side blobs: every one the IR names is in blobs/<sha>.bin, hashes to its name, within the limits
      const side = sideBlobs(ir);
      const files = new Map<string, string>();
      let total = 0;
      for (const b of side) {
        if (!SHA_RE.test(b.sha)) return fail(`side blob ${b.name}: ${b.sha} is not a sha`);
        const f = path.join(dir, 'blobs', `${b.sha}.bin`);
        if (!fs.existsSync(f)) return fail(`side blob ${b.name} (${b.sha.slice(0, 12)}) is not in the plan dir's blobs/`);
        const st = fs.statSync(f);
        if (st.size > this.cfg.blobMaxBytes) return fail(`side blob ${b.name} is ${st.size} bytes, more than ${this.cfg.blobMaxBytes} (16 MB)`);
        if (!files.has(b.sha)) total += st.size;
        if (total > this.cfg.blobsMaxBytes) return fail(`the plan's side blobs are more than ${this.cfg.blobsMaxBytes} bytes (64 MB) in all`);
        const got = sha256(fs.readFileSync(f));
        if (got !== b.sha) return fail(`side blob ${b.name}: blobs/${b.sha.slice(0, 12)}.bin hashes to ${got}`);
        if (b.bytes >= 0 && b.bytes !== st.size) return fail(`side blob ${b.name}: the IR says ${b.bytes} bytes, the file has ${st.size}`);
        files.set(b.sha, f);
      }
      const blobIds = new Map<string, string>();
      const blobs = side.map((b) => {
        let id = blobIds.get(b.sha);
        if (!id) {
          id = this.host.blobs.putBytes(fs.readFileSync(files.get(b.sha)!), REGION_BLOB_KIND, 'bin');
          blobIds.set(b.sha, id);
        }
        return { name: b.name, sha: b.sha, bytes: fs.statSync(files.get(b.sha)!).size, kind: b.kind, blobId: id };
      });
      const json = bytes.toString('utf8');
      this.cacheIr(irSha, json, planId, files);
      const inline = bytes.length <= IR_INLINE_BYTES;
      const irBlobId = inline ? undefined : this.host.blobs.putBytes(bytes, 'region.ir', 'json');
      const irFormat = ir.format as number;
      const requires = Array.isArray(ir.requires) ? ir.requires.map(String) : [];
      const needVolumes = Array.isArray(kitPlan.needVolumes) ? kitPlan.needVolumes : Array.isArray(out.needVolumes) ? out.needVolumes : [];
      this.host.log.info(`region plan ${planId} planned in ${ms} ms: IR format ${irFormat}, ${bytes.length} bytes, sha ${irSha.slice(0, 12)}${irBlobId ? `, blob ${irBlobId}` : ''}${blobs.length ? `, ${blobs.length} side blob${blobs.length === 1 ? '' : 's'}` : ''}`);
      // (6b) the checker, then the previews: their own limit, together
      const checked = o.check ? await this.checkAndRender(planId, dir) : {};
      fs.writeFileSync(
        path.join(dir, 'plan.json'),
        JSON.stringify(
          { ...kitPlan, planId, ok: true, irSha, irBytes: bytes.length, irFormat, requires, ...(irBlobId ? { irBlobId } : {}), blobs, notes, ms, ...(checked.checkMs !== undefined ? { checkMs: checked.checkMs } : {}), ...(checked.renderMs !== undefined ? { renderMs: checked.renderMs } : {}), ...(checked.checkError ? { checkError: checked.checkError } : {}), request: o.request },
          null,
          2,
        ),
      );
      this.host.emit({
        type: 'region.planned',
        planId,
        irSha,
        ...(inline ? { ir: json } : { irBlobId: irBlobId! }),
        lots: Array.isArray(ir.lots) ? ir.lots : [],
        stages: Array.isArray(ir.stages) ? ir.stages.map(String) : [],
        anchors: obj(ir.anchors),
        budget: obj(ir.budget),
        tiles: obj(ir.tiles),
        notes,
        ms,
        irFormat,
        requires,
        kitVersion: typeof ir.kitVersion === 'string' ? ir.kitVersion : this.kitInfo().kitVersion,
        blobs,
        needVolumes,
        ...(checked.report ? { report: checked.report } : {}),
        ...(checked.previews ? { previews: checked.previews } : {}),
        ...(checked.sitePlan ? { sitePlan: checked.sitePlan } : {}),
        ...(checked.checkMs !== undefined ? { checkMs: checked.checkMs } : {}),
        ...(checked.renderMs !== undefined ? { renderMs: checked.renderMs } : {}),
        ...(checked.checkError ? { checkError: truncate(checked.checkError, 4000) } : {}),
      } as Outbound);
    } catch (e) {
      this.host.log.error(`region plan ${planId}: ${(e as Error).stack ?? e}`);
      fail(`internal error: ${(e as Error).message}`);
    }
  }

  private progress(planId: string, phase: 'planning' | 'checking' | 'rendering'): void {
    this.host.emit({ type: 'region.progress', planId, phase } as Outbound);
  }

  /**
   * (6b) After a good plan: the kit's check, then every preview, in the plan sandbox, within regionCheckMs together. A
   * failure is reported (`checkError`), not a failed plan: the IR is good.
   */
  private async checkAndRender(planId: string, dir: string): Promise<{ report?: Record<string, unknown>; previews?: Record<string, string[]>; sitePlan?: Record<string, unknown>; checkMs?: number; renderMs?: number; checkError?: string }> {
    const caps = this.kitInfo().caps;
    if (!caps.check && !caps.preview) return { checkError: `the kit (${this.kitInfo().kitVersion}) has no checker or previews yet` };
    const end = Date.now() + this.cfg.checkMs;
    const out: Awaited<ReturnType<Regions['checkAndRender']>> = {};
    const errors: string[] = [];
    if (caps.check) {
      this.progress(planId, 'checking');
      const c = await this.runCheck(dir, end - Date.now());
      out.checkMs = c.ms;
      if (c.ok) out.report = c.report;
      else errors.push(`check: ${c.message}`);
    } else errors.push('check: the kit has no checker yet');
    if (caps.preview) {
      this.progress(planId, 'rendering');
      const p = await this.runPreview(dir, PREVIEW_VIEWS, undefined, end - Date.now());
      out.renderMs = p.ms;
      if (p.ok) {
        out.previews = p.paths;
        if (p.sitePlan) out.sitePlan = p.sitePlan;
      } else errors.push(`previews: ${p.message}`);
    } else errors.push('previews: the kit has no renderer yet');
    if (errors.length) {
      out.checkError = errors.join('; ');
      this.host.log.warn(`region plan ${planId}: ${truncate(out.checkError, 300)}`);
    } else this.host.log.info(`region plan ${planId} checked in ${out.checkMs} ms (${String(out.report?.errors ?? '?')} errors, ${String(out.report?.warnings ?? '?')} warnings), rendered in ${out.renderMs} ms`);
    return out;
  }

  private async runCheck(dir: string, timeoutMs: number): Promise<{ ok: true; report: Record<string, unknown>; ms: number } | { ok: false; message: string; ms: number }> {
    fs.rmSync(path.join(dir, 'report.json'), { force: true });
    const r = await this.runKit(dir, this.checkArgs(dir), { timeoutMs, heapMb: this.cfg.checkHeapMb, what: 'check' });
    if (!r.ok) return r;
    try {
      const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) as unknown;
      if (!report || typeof report !== 'object' || Array.isArray(report)) return { ok: false, message: 'report.json is not an object', ms: r.ms };
      return { ok: true, report: report as Record<string, unknown>, ms: r.ms };
    } catch (e) {
      return { ok: false, message: `the kit wrote no report.json (${(e as Error).message})`, ms: r.ms };
    }
  }

  private async runPreview(dir: string, views: readonly string[], axes: number[][][] | undefined, timeoutMs: number): Promise<{ ok: true; paths: Record<string, string[]>; sitePlan?: Record<string, unknown>; ms: number } | { ok: false; message: string; ms: number }> {
    let axesFile: string | undefined;
    if (axes) {
      axesFile = path.join(dir, 'axes.json');
      fs.writeFileSync(axesFile, JSON.stringify(axes));
    }
    const r = await this.runKit(dir, this.previewArgs(dir, views, axesFile), { timeoutMs, heapMb: this.cfg.checkHeapMb, what: 'previews' });
    if (!r.ok) return r;
    // only files in the plan dir are handed on
    const paths: Record<string, string[]> = {};
    const raw = r.out.paths && typeof r.out.paths === 'object' && !Array.isArray(r.out.paths) ? (r.out.paths as Record<string, unknown>) : {};
    for (const [view, list] of Object.entries(raw)) {
      const arr = (Array.isArray(list) ? list : [list]).filter((p): p is string => typeof p === 'string').map((p) => path.resolve(dir, p));
      const inside = arr.filter((p) => isInsideOrEqual(p, dir) && fs.existsSync(p));
      if (inside.length) paths[view] = inside;
    }
    let sitePlan: Record<string, unknown> | undefined;
    if (views.includes('siteplan')) {
      try {
        const sp = JSON.parse(fs.readFileSync(path.join(dir, 'siteplan.json'), 'utf8')) as unknown;
        if (sp && typeof sp === 'object' && !Array.isArray(sp)) sitePlan = sp as Record<string, unknown>;
      } catch {
        /* none written */
      }
    }
    return { ok: true, paths, ...(sitePlan ? { sitePlan } : {}), ms: r.ms };
  }

  /** (6b) A finished, good plan's dir (region.check / region.preview / ghost tiles), else a ClientError. */
  private finishedPlanDir(planId: string): string {
    const d = this.planDir(planId);
    if (!fs.existsSync(d)) throw new ClientError(`no plan "${planId}"`);
    if (this.planning.has(planId)) throw new ClientError(`plan ${planId} is still being planned`);
    if (!fs.existsSync(path.join(d, 'ir.json')) || !fs.existsSync(path.join(d, 'survey.bin'))) throw new ClientError(`plan ${planId} has no IR (it failed)`);
    return fs.realpathSync(d);
  }

  // ---- (6b) region.check, region.preview -------------------------------------------------------------

  /** region.check {planId} -> {report}: the kit's check over the plan dir (the IR, survey, blobs and volumes there). */
  async check(planId: string): Promise<{ report: Record<string, unknown>; ms: number }> {
    const dir = this.finishedPlanDir(planId);
    const info = this.kitInfo();
    if (!info.caps.check) throw new ClientError(`the kit (${info.kitVersion}) has no checker (kit/lib/region/check.mjs)`);
    return this.withPlanLock(planId, () =>
      this.withPlanSlot(async () => {
        const r = await this.runCheck(dir, this.cfg.checkMs);
        if (!r.ok) throw new ClientError(`check: ${r.message}`);
        return { report: r.report, ms: r.ms };
      }),
    );
  }

  /** region.preview {planId, views?, axes?} -> {paths, sitePlan}: re-rendered on demand. */
  async preview(planId: string, views: readonly string[] | undefined, axes: number[][][] | undefined): Promise<{ paths: Record<string, string[]>; sitePlan?: Record<string, unknown>; ms: number }> {
    const dir = this.finishedPlanDir(planId);
    const info = this.kitInfo();
    if (!info.caps.preview) throw new ClientError(`the kit (${info.kitVersion}) has no previews (kit/lib/region/preview.mjs)`);
    const v = views?.length ? [...new Set(views)] : [...PREVIEW_VIEWS];
    return this.withPlanLock(planId, () =>
      this.withPlanSlot(async () => {
        const r = await this.runPreview(dir, v, axes, this.cfg.checkMs);
        if (!r.ok) throw new ClientError(`previews: ${r.message}`);
        return { paths: r.paths, ...(r.sitePlan ? { sitePlan: r.sitePlan } : {}), ms: r.ms };
      }),
    );
  }

  // ---- (6b) the catalogue (region.design) -------------------------------------------------------------

  /** `region.mjs catalogue --json` in the sandbox (reads the kit; writes only <data>/regions/catalogue). */
  async catalogue(): Promise<CatalogueProgram[]> {
    const info = this.kitInfo();
    if (!info.caps.catalogue) throw new Error(`the kit (${info.kitVersion}) has no catalogue (tools/region.mjs catalogue)`);
    const dir = path.join(this.host.config.dataDir, 'regions', 'catalogue');
    fs.mkdirSync(dir, { recursive: true });
    const r = await this.runKit(fs.realpathSync(dir), ['catalogue', '--json'], { timeoutMs: Math.max(30_000, this.cfg.planMs), heapMb: this.cfg.planHeapMb, what: 'catalogue' });
    if (!r.ok) throw new Error(r.message);
    return parseCatalogue(r.out);
  }

  // ---- the IR cache ---------------------------------------------------------------------------------

  private cacheIr(irSha: string, json: string, planId?: string, files?: Map<string, string>): IrEntry {
    let e = this.irs.get(irSha);
    if (e) this.irs.delete(irSha);
    else e = { json, plans: new Set(), files: new Map() };
    if (planId) e.plans.add(planId);
    for (const [sha, f] of files ?? []) e.files.set(sha, f);
    this.irs.set(irSha, e);
    // (a job holds its own reference to the JSON, and the pool re-sends an IR a worker was told to drop)
    while (this.irs.size > IR_CACHE_SIZE) {
      const oldest = this.irs.keys().next().value as string;
      this.irs.delete(oldest);
      this.pool?.dropIr(oldest);
    }
    return e;
  }

  /** The IR JSON for a request: the cache, the plan dir, or the request's own `ir`; else `ir_unknown`. */
  resolveIr(planId: string, irSha: string, ir: TilesMsg['ir']): string {
    return this.resolveIrEntry(planId, irSha, ir).json;
  }

  private resolveIrEntry(planId: string, irSha: string, ir: TilesMsg['ir']): IrEntry {
    const hit = this.irs.get(irSha);
    if (hit) return this.cacheIr(irSha, hit.json, planId);
    const file = path.join(this.planDir(planId), 'ir.json');
    if (fs.existsSync(file)) {
      const bytes = fs.readFileSync(file);
      if (sha256(bytes) === irSha) return this.cacheIr(irSha, bytes.toString('utf8'), planId);
    }
    if (ir !== undefined) {
      let json: string;
      if (typeof ir === 'string') json = ir;
      else {
        try {
          json = canonicalJson(ir);
        } catch (e) {
          throw new ClientError(`ir: ${(e as Error).message}`);
        }
      }
      const got = sha256(json);
      if (got !== irSha) throw new ClientError(`ir does not match irSha (it hashes to ${got})`);
      if (Buffer.byteLength(json) > this.cfg.irMaxBytes) throw new ClientError(`ir is larger than ${this.cfg.irMaxBytes} bytes`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new ClientError('ir is not JSON');
      }
      if (!parsed || typeof parsed !== 'object' || !this.formatOk((parsed as { format?: unknown }).format)) throw new ClientError(`ir is not a Region IR (format ${this.kitInfo().irFormats.join(' or ')})`);
      return this.cacheIr(irSha, json, planId);
    }
    throw new ClientError('ir_unknown');
  }

  /**
   * (6b) Every side blob the IR names, by sha -> a verified file: the plan dir's blobs/, the blob cache, or the request's
   * `blobs` (blob-store ids, checked by sha and then copied into the cache). Any missing: `blob_unknown <sha>,<sha>...`.
   */
  private resolveBlobs(planId: string, e: IrEntry, given: Record<string, string> | undefined): void {
    if (!e.shas) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(e.json) as Record<string, unknown>;
      } catch {
        /* checked when it was cached */
      }
      e.shas = [...new Set(sideBlobs(parsed).map((b) => b.sha))].filter((s) => SHA_RE.test(s));
    }
    if (!e.shas.length) return;
    const missing: string[] = [];
    for (const sha of e.shas) {
      const known = e.files.get(sha);
      if (known && fs.existsSync(known)) continue;
      e.files.delete(sha);
      e.shared = undefined;
      const found = [path.join(this.planDir(planId), 'blobs', `${sha}.bin`), path.join(this.blobCacheDir(), `${sha}.bin`)].find((f) => {
        try {
          return fs.statSync(f).size <= this.cfg.blobMaxBytes && sha256(fs.readFileSync(f)) === sha;
        } catch {
          return false;
        }
      });
      if (found) {
        e.files.set(sha, found);
        continue;
      }
      const id = given?.[sha];
      if (id) {
        const bytes = this.host.blobs.read(id);
        const got = sha256(bytes);
        if (got !== sha) throw new ClientError(`blob ${id} hashes to ${got}, not ${sha}`);
        if (bytes.length > this.cfg.blobMaxBytes) throw new ClientError(`blob ${id} is ${bytes.length} bytes, more than ${this.cfg.blobMaxBytes} (16 MB)`);
        fs.mkdirSync(this.blobCacheDir(), { recursive: true });
        const f = path.join(this.blobCacheDir(), `${sha}.bin`);
        const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, f);
        e.files.set(sha, f);
        continue;
      }
      missing.push(sha);
    }
    if (missing.length) throw new ClientError(`blob_unknown ${missing.join(',')}`);
  }

  /** (6b) The side blobs' bytes in shared memory (one copy for every worker), made on first use. */
  private sharedBlobs(e: IrEntry): Record<string, Uint8Array> {
    if (e.shared) return e.shared;
    const out: Record<string, Uint8Array> = {};
    for (const [sha, f] of e.files) {
      const b = fs.readFileSync(f);
      const u = new Uint8Array(new SharedArrayBuffer(b.length));
      u.set(b);
      out[sha] = u;
    }
    e.shared = out;
    return out;
  }

  /** (6b) A plan's survey (ghost tiles), in shared memory, re-read when the file changed. */
  private planSurvey(planId: string): { id: string; bytes: Uint8Array } {
    const f = path.join(this.planDir(planId), 'survey.bin');
    let st: fs.Stats;
    try {
      st = fs.statSync(f);
    } catch {
      throw new ClientError(`plan ${planId} has no survey (the plan dir is gone): ghost tiles need it`);
    }
    const hit = this.surveys.get(planId);
    if (hit && hit.mtimeMs === st.mtimeMs) {
      this.surveys.delete(planId);
      this.surveys.set(planId, hit);
      return hit;
    }
    const b = fs.readFileSync(f);
    if (b.length < 28 || b.toString('latin1', 0, 4) !== 'ARSV') throw new ClientError(`plan ${planId}'s survey is not an ARSV buffer`);
    const bytes = new Uint8Array(new SharedArrayBuffer(b.length));
    bytes.set(b);
    const s = { id: `${planId}:${sha256(b).slice(0, 16)}`, bytes, mtimeMs: st.mtimeMs };
    this.surveys.set(planId, s);
    while (this.surveys.size > 4) this.surveys.delete(this.surveys.keys().next().value as string);
    return s;
  }

  // ---- region.tiles.request -------------------------------------------------------------------------

  tiles(msg: TilesMsg, client: ClientHandle | undefined): { accepted: number } {
    if (!client) throw new ClientError('region.tiles.request needs a connection');
    // the IR first (ir_unknown), then its side blobs (blob_unknown): the mod re-sends in that order
    const e = this.resolveIrEntry(msg.planId, msg.irSha, msg.ir);
    this.resolveBlobs(msg.planId, e, msg.blobs);
    const irJson = e.json;
    const blobs = e.shas?.length ? () => this.sharedBlobs(e) : undefined;
    let survey: Job['survey'];
    if (msg.preview) {
      const s = this.planSurvey(msg.planId);
      survey = { id: s.id, bytes: () => s.bytes };
    }
    const jobs: Job[] = msg.tiles.map((t) => {
      if (msg.preview) return { irSha: msg.irSha, irJson, key: t.key, stage: t.stage, set: t.set, heights: undefined, blobs, survey };
      const heights = Buffer.from(t.heights!, 'base64');
      if (heights.length < 28 || heights.toString('latin1', 0, 4) !== 'ARSV') throw new ClientError(`tile ${t.key}: heights are not an ARSV buffer`);
      return { irSha: msg.irSha, irJson, key: t.key, stage: t.stage!, set: t.set!, heights, blobs, survey: undefined };
    });
    const s = this.session(client, msg.planId);
    if (s.queue.length + s.active + jobs.length > MAX_PENDING_TILES) throw new ClientError(`too many tiles waiting for plan ${msg.planId} (at most ${MAX_PENDING_TILES}; keep at most regionWindow = ${this.cfg.window} outstanding)`);
    s.queue.push(...jobs);
    this.pump(s);
    return { accepted: jobs.length };
  }

  private session(client: ClientHandle, planId: string): Session {
    const k = `${client.id}\u0000${planId}`;
    let s = this.sessions.get(k);
    if (!s || s.closed) {
      s = { client, planId, queue: [], active: 0, peak: 0, closed: false };
      this.sessions.set(k, s);
    }
    return s;
  }

  private getPool(): TilePool {
    if (!this.pool) {
      const slowTiles = this.cfg.testSlowTiles;
      if (slowTiles > 0) this.host.log.warn(`test hook ARCHITECT_TEST_SLOW_TILES=${slowTiles}: the first ${slowTiles} evaluations of each region tile overrun their limit`);
      this.pool = new TilePool({ kitDir: this.host.config.kitDir, size: this.cfg.workers, tileMs: this.cfg.tileMs, heapMb: this.cfg.tileHeapMb, retryPauseMs: this.cfg.tileRetryPauseMs, slowTiles, log: this.host.log });
    }
    return this.pool;
  }

  private pump(s: Session): void {
    while (!s.closed && s.active < this.cfg.window && s.queue.length) {
      const job = s.queue.shift()!;
      s.active++;
      s.peak = Math.max(s.peak, s.active);
      this.peakActive = Math.max(this.peakActive, s.active);
      void this.getPool()
        .evaluate({
          irSha: job.irSha,
          irJson: () => job.irJson,
          key: job.key,
          stage: job.stage,
          set: job.set,
          ...(job.heights ? { heights: job.heights } : {}),
          ...(job.blobs ? { blobs: job.blobs } : {}),
          ...(job.survey ? { survey: job.survey } : {}),
        })
        .then((res) => this.deliver(s, job, res))
        .catch((e) => this.host.log.error(`region tile ${job.key}: ${(e as Error).stack ?? e}`))
        .finally(() => {
          s.active--;
          this.pump(s);
        });
    }
  }

  /** Send a tile's frames (or its error); resolves once the last frame is flushed to the socket. */
  private async deliver(s: Session, job: Job, res: TileResult): Promise<void> {
    if (s.closed || !s.client.open) return; // the connection went away: discarded
    const head = { planId: s.planId, key: job.key, stage: job.stage ?? '*', set: job.set ?? '*', ...(job.survey ? { preview: true } : {}) };
    if (!res.ok) {
      this.host.log.warn(`region plan ${s.planId} tile ${job.key} (${head.stage}/${head.set}${job.survey ? ', ghost' : ''}) failed: ${truncate(res.message, 300)}`);
      // (6c 0a) code: 'timeout' (over its limit in every attempt: the mod waits TILE_SLOW) or 'error'; attempts: evaluations made
      await sendFlushed(s.client, { type: 'region.tile.error', ...head, message: truncate(res.message, 4000), code: res.code, attempts: Math.max(1, res.attempts) } as Outbound);
      return;
    }
    const n = Math.max(1, Math.ceil(res.gz.length / MAX_TILE_FRAME_BYTES));
    for (let seq = 0; seq < n; seq++) {
      if (s.closed || !s.client.open) return;
      const data = res.gz.subarray(seq * MAX_TILE_FRAME_BYTES, (seq + 1) * MAX_TILE_FRAME_BYTES).toString('base64');
      await sendFlushed(s.client, { type: 'region.tile', ...head, seq, more: seq < n - 1, data, count: res.count, sha: res.sha } as Outbound);
    }
  }

  // ---- release, connections, shutdown ---------------------------------------------------------------

  release(planId: string, client: ClientHandle | undefined, evict = false): { planId: string; dropped: number } {
    let dropped = 0;
    for (const [k, s] of this.sessions) {
      if (s.planId !== planId || (client && s.client.id !== client.id)) continue;
      dropped += s.queue.length;
      s.queue = [];
      s.closed = true;
      this.sessions.delete(k);
    }
    for (const [sha, e] of this.irs) {
      if (!e.plans.has(planId)) continue;
      e.plans.delete(planId);
      if (e.plans.size && !evict) continue;
      this.irs.delete(sha);
      this.pool?.dropIr(sha);
    }
    this.surveys.delete(planId);
    return { planId, dropped };
  }

  clientGone(client: ClientHandle): void {
    for (const [k, s] of this.sessions) {
      if (s.client.id !== client.id) continue;
      s.closed = true;
      s.queue = [];
      this.sessions.delete(k);
    }
  }

  /** Workers alive and what they did (tests, numbers). */
  poolStats(): { workers: number; started: number; replaced: number; tiles: number; failed: number; retries: number } | undefined {
    return this.pool ? { workers: this.pool.workers, ...this.pool.stats } : undefined;
  }

  /** Wait for running plans (tests). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) {
      s.closed = true;
      s.queue = [];
    }
    this.sessions.clear();
    await this.pool?.close();
    this.pool = undefined;
  }
}

/** The client's send-and-flush when it has one (the WebSocket server), else a plain send. */
function sendFlushed(c: ClientHandle, m: Outbound): Promise<void> {
  if (c.sendFlushed) return c.sendFlushed(m).catch(() => undefined);
  c.send(m);
  return Promise.resolve();
}

/** The last JSON object line of a tool's stdout. */
export function lastJson(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]!) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>;
    } catch {
      /* not it */
    }
  }
  return undefined;
}
