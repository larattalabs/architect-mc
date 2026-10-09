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
//   region.release       drops the plan's queued tiles (this connection) and its cached IR. The plan dir stays.
//
// Nothing persists per connection: a connection that goes away loses its queued and in-flight tiles; the plan dirs and
// the IR cache stay. Planning never calls Claude, on either backend.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BlobStore } from './blobs.js';
import type { BibleIndex } from './bibles.js';
import type { Config } from './config.js';
import type { Logger } from './context.js';
import { minimalEnv, outputTail } from './designs.js';
import { ClientError } from './errors.js';
import { IR_INLINE_BYTES, MAX_TILE_FRAME_BYTES, REGION_PROGRAM_ID, type Outbound, type RegionPlanMsg, type RegionTilesRequestMsg } from './protocol.js';
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
  stage: string;
  set: 'terrain' | 'path';
  heights: Buffer;
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

export class Regions {
  private pool: TilePool | undefined;
  private irs = new Map<string, { json: string; plans: Set<string> }>();
  private sessions = new Map<string, Session>();
  private planSlots = 0;
  private planWaiters: Array<() => void> = [];
  private running = new Set<Promise<void>>();
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
    const planId = `p${this.host.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    fs.mkdirSync(this.planDir(planId), { recursive: true });
    const dir = fs.realpathSync(this.planDir(planId));
    fs.copyFileSync(program.file, path.join(dir, 'program.mjs'));
    fs.writeFileSync(path.join(dir, 'survey.bin'), survey);
    fs.writeFileSync(path.join(dir, 'params.json'), JSON.stringify(msg.params));
    const hasBible = !!bible || Object.keys(roles).length > 0;
    if (hasBible) fs.writeFileSync(path.join(dir, 'bible.json'), JSON.stringify({ ...(bible ? { id: bible.id, version: bible.version } : {}), roles }));
    const request = { planId, program: program.label, bundled: program.bundled, params: msg.params, seed, claim: msg.claim, surveyBlobId: msg.surveyBlobId, ...(bible ? { bible } : {}), roles, createdAt: this.host.now() };
    fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(request, null, 2));
    this.host.log.info(`region plan ${planId}: ${program.label}, claim ${msg.claim.minX},${msg.claim.minZ}..${msg.claim.maxX},${msg.claim.maxZ} y ${msg.claim.minY}..${msg.claim.maxY}, seed ${seed}${bible ? `, bible ${bible.id} v${bible.version}` : ''}`);
    const p = this.withPlanSlot(() => this.runPlan(planId, dir, program, { seed, claim: msg.claim, hasBible, request }));
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

  private async withPlanSlot(fn: () => Promise<void>): Promise<void> {
    while (this.planSlots >= this.cfg.planConcurrency) await new Promise<void>((r) => this.planWaiters.push(r));
    this.planSlots++;
    try {
      await fn();
    } finally {
      this.planSlots--;
      this.planWaiters.shift()?.();
    }
  }

  /**
   * The kit CLI's arguments (kit/REGIONS.md "Plan CLI"). The one place that knows the CLI's shape:
   *   plan <program.mjs> --params <f> --survey <f> --seed <u64> --claim minX,minZ,maxX,maxZ,minY,maxY [--bible <f>] --out <planDir> --json
   */
  planArgs(dir: string, program: ProgramRef, o: { seed: string; claim: PlanMsg['claim']; hasBible: boolean }): string[] {
    const c = o.claim;
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
      '--out',
      dir,
      '--json',
    ];
  }

  private async runPlan(planId: string, dir: string, program: ProgramRef, o: { seed: string; claim: PlanMsg['claim']; hasBible: boolean; request: Record<string, unknown> }): Promise<void> {
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
      const kit = fs.realpathSync(this.host.config.kitDir);
      const script = path.join(kit, 'tools', 'region.mjs');
      if (!fs.existsSync(script)) return fail('the kit has no tools/region.mjs (an older kit)');
      const perm = permissionFlag();
      if (!perm) return fail(`region planning needs Node's permission model (Node 22.13 or later; this is ${process.version})`);
      const reads = [kit, dir, ...(program.bundled ? [] : [fs.realpathSync(this.cfg.programsDir)])];
      const flags = [perm, ...reads.map((r) => `--allow-fs-read=${r}`), `--allow-fs-write=${dir}`, `--max-old-space-size=${this.cfg.planHeapMb}`, `--import=data:text/javascript,${encodeURIComponent(NO_NETWORK)}`];
      // a stale ir.json from nowhere must not count
      fs.rmSync(path.join(dir, 'ir.json'), { force: true });
      const r = await run(process.execPath, [...flags, script, ...this.planArgs(dir, program, o)], { cwd: dir, env: minimalEnv(), timeoutMs: this.cfg.planMs });
      const ms = Date.now() - t0;
      const out = lastJson(r.stdout);
      if (r.timedOut) return fail(`the plan took longer than ${this.cfg.planMs / 1000} s and was stopped`);
      if (/heap out of memory|ERR_WORKER_OUT_OF_MEMORY|Allocation failed/i.test(r.stderr)) return fail(`the plan ran out of memory (${this.cfg.planHeapMb} MB heap)`);
      if (r.code !== 0 || (out && out.ok === false)) {
        const msg = (typeof out?.error === 'string' && out.error) || (typeof out?.message === 'string' && out.message) || outputTail(`${r.stdout}\n${r.stderr}`) || `the plan exited with code ${r.code}`;
        return fail(msg);
      }
      const irFile = path.join(dir, 'ir.json');
      if (!fs.existsSync(irFile)) return fail('the kit did not write ir.json');
      const size = fs.statSync(irFile).size;
      if (size > this.cfg.irMaxBytes) return fail(`the IR is ${size} bytes, more than the limit of ${this.cfg.irMaxBytes} bytes (4 MB)`);
      const bytes = fs.readFileSync(irFile);
      const irSha = sha256(bytes);
      if (typeof out?.irSha === 'string' && out.irSha !== irSha) return fail(`the kit reported irSha ${out.irSha} but ir.json hashes to ${irSha}`);
      let ir: Record<string, unknown>;
      try {
        ir = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      } catch (e) {
        return fail(`ir.json is not JSON: ${(e as Error).message}`);
      }
      if (!ir || typeof ir !== 'object' || ir.format !== 1) return fail('the program did not return a Region IR (format 1)');
      const notes = Array.isArray(out?.notes) ? out.notes.map((n) => (typeof n === 'string' ? n : JSON.stringify(n))) : [];
      const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
      let kitPlan: Record<string, unknown> = {};
      try {
        kitPlan = obj(JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')));
      } catch {
        /* the kit wrote none */
      }
      const json = bytes.toString('utf8');
      this.cacheIr(irSha, json, planId);
      const inline = bytes.length <= IR_INLINE_BYTES;
      const irBlobId = inline ? undefined : this.host.blobs.putBytes(bytes, 'region.ir', 'json');
      fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ ...kitPlan, planId, ok: true, irSha, irBytes: bytes.length, ...(irBlobId ? { irBlobId } : {}), notes, ms, request: o.request }, null, 2));
      this.host.log.info(`region plan ${planId} done in ${ms} ms: IR ${bytes.length} bytes, sha ${irSha.slice(0, 12)}${irBlobId ? `, blob ${irBlobId}` : ''}`);
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
      } as Outbound);
    } catch (e) {
      this.host.log.error(`region plan ${planId}: ${(e as Error).stack ?? e}`);
      fail(`internal error: ${(e as Error).message}`);
    }
  }

  // ---- the IR cache ---------------------------------------------------------------------------------

  private cacheIr(irSha: string, json: string, planId?: string): string {
    let e = this.irs.get(irSha);
    if (e) this.irs.delete(irSha);
    else e = { json, plans: new Set() };
    if (planId) e.plans.add(planId);
    this.irs.set(irSha, e);
    // (a job holds its own reference to the JSON, and the pool re-sends an IR a worker was told to drop)
    while (this.irs.size > IR_CACHE_SIZE) {
      const oldest = this.irs.keys().next().value as string;
      this.irs.delete(oldest);
      this.pool?.dropIr(oldest);
    }
    return e.json;
  }

  /** The IR JSON for a request: the cache, the plan dir, or the request's own `ir`; else `ir_unknown`. */
  resolveIr(planId: string, irSha: string, ir: TilesMsg['ir']): string {
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
      if (!parsed || typeof parsed !== 'object' || (parsed as { format?: unknown }).format !== 1) throw new ClientError('ir is not a Region IR (format 1)');
      return this.cacheIr(irSha, json, planId);
    }
    throw new ClientError('ir_unknown');
  }

  // ---- region.tiles.request -------------------------------------------------------------------------

  tiles(msg: TilesMsg, client: ClientHandle | undefined): { accepted: number } {
    if (!client) throw new ClientError('region.tiles.request needs a connection');
    const irJson = this.resolveIr(msg.planId, msg.irSha, msg.ir);
    const jobs: Job[] = msg.tiles.map((t) => {
      const heights = Buffer.from(t.heights, 'base64');
      if (heights.length < 28 || heights.toString('latin1', 0, 4) !== 'ARSV') throw new ClientError(`tile ${t.key}: heights are not an ARSV buffer`);
      return { irSha: msg.irSha, irJson, key: t.key, stage: t.stage, set: t.set, heights };
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
    this.pool ??= new TilePool({ kitDir: this.host.config.kitDir, size: this.cfg.workers, tileMs: this.cfg.tileMs, heapMb: this.cfg.tileHeapMb, log: this.host.log });
    return this.pool;
  }

  private pump(s: Session): void {
    while (!s.closed && s.active < this.cfg.window && s.queue.length) {
      const job = s.queue.shift()!;
      s.active++;
      s.peak = Math.max(s.peak, s.active);
      this.peakActive = Math.max(this.peakActive, s.active);
      void this.getPool()
        .evaluate({ irSha: job.irSha, irJson: () => job.irJson, key: job.key, stage: job.stage, set: job.set, heights: job.heights })
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
    const head = { planId: s.planId, key: job.key, stage: job.stage, set: job.set };
    if (!res.ok) {
      this.host.log.warn(`region plan ${s.planId} tile ${job.key} (${job.stage}/${job.set}) failed: ${truncate(res.message, 300)}`);
      await sendFlushed(s.client, { type: 'region.tile.error', ...head, message: truncate(res.message, 4000) } as Outbound);
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

  release(planId: string, client: ClientHandle | undefined): { planId: string; dropped: number } {
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
      if (e.plans.size) continue;
      this.irs.delete(sha);
      this.pool?.dropIr(sha);
    }
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
  poolStats(): { workers: number; started: number; replaced: number; tiles: number; failed: number } | undefined {
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
function lastJson(stdout: string): Record<string, unknown> | undefined {
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
