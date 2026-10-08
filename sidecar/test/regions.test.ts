// (6a) Region programs in the sidecar, against the FAKE kit (test/fixtures/kit: tools/region.mjs, regions/fake_basic.mjs,
// lib/realise.mjs, lib/region/pack.mjs): the region.* schemas, region.plan (success, the sandbox, failures on the sim
// backend, the limits), the tile pool (frames, sha, crash, timeout, out of memory), the window and backpressure,
// ir_unknown, release, a connection going away, and determinism across worker counts and order.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FEATURES, parseClientMessage, ServerMessage, toProtocol1, type Outbound, type Protocol } from '../src/protocol.js';
import { canonicalJson, permissionFlag, sha256 } from '../src/regions.js';
import type { ClientHandle } from '../src/server.js';
import { SimDesigner } from '../src/sim.js';
import { makeSidecar, until, type Harness } from './helpers.js';

// ---- helpers ----------------------------------------------------------------------------------------

/** An ARSV columns buffer (kit/REGIONS.md "Columns codec"). */
export function arsv(minX: number, minZ: number, width: number, depth: number, ground: (i: number, j: number) => number = () => 64): Buffer {
  const n = width * depth;
  const b = Buffer.alloc(28 + n * 7);
  b.write('ARSV', 0, 'latin1');
  b[4] = 1;
  b.writeInt32LE(minX, 8);
  b.writeInt32LE(minZ, 12);
  b.writeInt32LE(width, 16);
  b.writeInt32LE(depth, 20);
  b.writeInt32LE(1, 24);
  for (let j = 0; j < depth; j++)
    for (let i = 0; i < width; i++) {
      const k = i + j * width;
      const g = ground(i, j);
      b.writeInt16LE(g, 28 + k * 2);
      b.writeInt16LE(g, 28 + n * 2 + k * 2);
      b.writeInt16LE(g, 28 + n * 4 + k * 2);
    }
  return b;
}

/** A tile's heights: its 80x80 window. */
export function tileHeights(key: string, salt = 0): string {
  const [tx, tz] = key.split(',').map(Number) as [number, number];
  return arsv(64 * tx - 8, 64 * tz - 8, 80, 80, (i, j) => 60 + ((i * 7 + j * 3 + salt + tx * 5 + tz) % 9)).toString('base64');
}

interface FakeClient extends ClientHandle {
  sent: Outbound[];
  open: boolean;
  /** when set, sendFlushed waits for this before resolving (a client that stopped reading) */
  gate?: Promise<void>;
}

let nextClient = 1000;
function fakeClient(opts: { flushed?: boolean } = {}): FakeClient {
  const c: FakeClient = {
    id: nextClient++,
    name: 'mod',
    protocol: 2 as Protocol,
    paused: false,
    open: true,
    sent: [],
    send(m) {
      if (c.open) c.sent.push(m);
    },
  };
  if (opts.flushed)
    c.sendFlushed = async (m) => {
      if (c.open) c.sent.push(m);
      if (c.gate) await c.gate;
    };
  return c;
}

/** Run a client message through the real parser and the sidecar; the ack. */
async function call(h: Harness, msg: Record<string, unknown>, client?: ClientHandle): Promise<{ ok: boolean; error?: string; result?: Record<string, unknown> }> {
  const parsed = parseClientMessage(JSON.stringify({ v: 1, id: 'q', ...msg }));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  let ack: { ok: boolean; error?: string; result?: Record<string, unknown> } | undefined;
  await h.sc.handle(parsed.msg, (m) => {
    if (m.type === 'ack') ack = { ok: m.ok, ...(m.error ? { error: m.error } : {}), ...(m.result ? { result: m.result } : {}) };
  }, client);
  return ack!;
}

const CLAIM = { minX: 0, minZ: 0, maxX: 127, maxZ: 127, minY: -64, maxY: 319 };

function putSurvey(h: Harness): string {
  const b = arsv(0, 0, 128, 128);
  return h.sc.blobs.put({ kind: 'survey', chunks: [b.toString('base64')] }).blobId;
}

type Planned = Extract<Outbound, { type: 'region.planned' }>;
type Failed = Extract<Outbound, { type: 'region.failed' }>;
type TileMsg = Extract<Outbound, { type: 'region.tile' }>;
type TileErr = Extract<Outbound, { type: 'region.tile.error' }>;

async function plan(h: Harness, over: Record<string, unknown> = {}): Promise<{ ack: Awaited<ReturnType<typeof call>>; planned?: Planned; failed?: Failed; ms: number }> {
  const t0 = Date.now();
  const ack = await call(h, { type: 'region.plan', program: 'fake_basic', params: {}, claim: CLAIM, surveyBlobId: putSurvey(h), ...over });
  if (!ack.ok) return { ack, ms: Date.now() - t0 };
  const planId = ack.result!.planId as string;
  await until(() => h.events.some((e) => (e.type === 'region.planned' || e.type === 'region.failed') && e.planId === planId), 60_000);
  const ms = Date.now() - t0;
  const planned = h.events.find((e): e is Planned => e.type === 'region.planned' && e.planId === planId);
  const failed = h.events.find((e): e is Failed => e.type === 'region.failed' && e.planId === planId);
  return { ack, ...(planned ? { planned } : {}), ...(failed ? { failed } : {}), ms };
}

/** Reassemble a tile's frames: {gz, payload, sha, count} (checks seq, more and the per-frame size). */
function assemble(frames: TileMsg[]): { gz: Buffer; payload: Buffer; sha: string; count: number } {
  const sorted = [...frames].sort((a, b) => a.seq - b.seq);
  sorted.forEach((f, i) => {
    expect(f.seq).toBe(i);
    expect(f.more).toBe(i < sorted.length - 1);
    expect(Buffer.from(f.data, 'base64').length).toBeLessThanOrEqual(1024 * 1024);
    expect(f.sha).toBe(sorted[0]!.sha);
    expect(f.count).toBe(sorted[0]!.count);
  });
  const gz = Buffer.concat(sorted.map((f) => Buffer.from(f.data, 'base64')));
  const payload = zlib.gunzipSync(gz);
  return { gz, payload, sha: sorted[0]!.sha, count: sorted[0]!.count };
}

function tileAnswers(c: FakeClient, planId: string) {
  const frames = c.sent.filter((m): m is TileMsg => m.type === 'region.tile' && m.planId === planId);
  const errors = c.sent.filter((m): m is TileErr => m.type === 'region.tile.error' && m.planId === planId);
  const done = new Set([...frames.filter((f) => !f.more).map((f) => `${f.key}|${f.stage}|${f.set}`), ...errors.map((e) => `${e.key}|${e.stage}|${e.set}`)]);
  return { frames, errors, done };
}

function tilesReq(planId: string, irSha: string, keys: string[], extra: Record<string, unknown> = {}) {
  return { type: 'region.tiles.request', planId, irSha, tiles: keys.map((key) => ({ key, stage: 'ground', set: 'terrain', heights: tileHeights(key) })), ...extra };
}

// ---- schemas ----------------------------------------------------------------------------------------

describe('region.* schemas', () => {
  const ok = (m: Record<string, unknown>, p: Protocol = 2) => parseClientMessage(JSON.stringify({ v: 1, ...m }), p).ok;

  it('accepts the messages of kit/REGIONS.md and refuses bad fields', () => {
    const plan = { type: 'region.plan', program: 'mega_bench', params: { a: 1 }, seed: '18446744073709551615', claim: CLAIM, surveyBlobId: 'b1' };
    expect(ok(plan)).toBe(true);
    expect(ok({ ...plan, seed: 12 })).toBe(true);
    expect(ok({ ...plan, seed: '-1' })).toBe(false);
    expect(ok({ ...plan, claim: { ...CLAIM, maxX: -5 } })).toBe(false);
    expect(ok({ ...plan, claim: { ...CLAIM, maxX: 5000 } })).toBe(false);
    expect(ok({ ...plan, roles: { rock: 'minecraft:stone', stair: 'minecraft:oak_stairs[facing=north,half=bottom]' } })).toBe(true);
    expect(ok({ ...plan, roles: { rock: 'stone; rm -rf' } })).toBe(false);
    const sha = 'a'.repeat(64);
    const req = { type: 'region.tiles.request', planId: 'p1', irSha: sha, tiles: [{ key: '-2,5', stage: 'ground', set: 'terrain', heights: 'QVJTVg==' }] };
    expect(ok(req)).toBe(true);
    expect(ok({ ...req, ir: '{"format":1}' })).toBe(true);
    expect(ok({ ...req, ir: { format: 1 } })).toBe(true);
    expect(ok({ ...req, irSha: 'xyz' })).toBe(false);
    expect(ok({ ...req, planId: '../etc' })).toBe(false);
    expect(ok({ ...req, tiles: [{ ...req.tiles[0], key: '1;2' }] })).toBe(false);
    expect(ok({ ...req, tiles: [{ ...req.tiles[0], set: 'roof' }] })).toBe(false);
    expect(ok({ ...req, tiles: [] })).toBe(false);
    expect(ok({ ...req, tiles: Array.from({ length: 65 }, () => req.tiles[0]) })).toBe(false);
    expect(ok({ type: 'region.release', planId: 'p1' })).toBe(true);
    // protocol 1 has none of them
    expect(ok(plan, 1)).toBe(false);
    expect(ok({ type: 'region.release', planId: 'p1' }, 1)).toBe(false);
  });

  it('validates the outbound messages; protocol 1 never sees them', () => {
    const sha = 'b'.repeat(64);
    const planned = { v: 1, type: 'region.planned', planId: 'p1', irSha: sha, ir: '{}', lots: [], stages: ['a'], anchors: {}, budget: {}, tiles: {}, notes: [] };
    expect(ServerMessage.safeParse(planned).success).toBe(true);
    expect(ServerMessage.safeParse({ ...planned, irBlobId: 'b2' }).success).toBe(false);
    const { ir: _ir, ...noIr } = planned;
    expect(ServerMessage.safeParse(noIr).success).toBe(false);
    expect(ServerMessage.safeParse({ ...noIr, irBlobId: 'b2' }).success).toBe(true);
    const tile = { v: 1, type: 'region.tile', planId: 'p1', key: '0,0', stage: 'ground', set: 'path', seq: 0, more: false, data: 'AAAA', count: 3, sha };
    expect(ServerMessage.safeParse(tile).success).toBe(true);
    expect(ServerMessage.safeParse({ ...tile, data: 'A'.repeat(1_400_000) }).success).toBe(false);
    expect(ServerMessage.safeParse({ v: 1, type: 'region.tile.error', planId: 'p1', key: '0,0', stage: 'ground', set: 'terrain', message: 'x' }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: 1, type: 'region.failed', planId: 'p1', message: 'x' }).success).toBe(true);
    for (const m of [planned, tile, { v: 1, type: 'region.failed', planId: 'p1', message: 'x' }]) expect(toProtocol1(m)).toBeUndefined();
    expect(FEATURES).toContain('region.plan');
    expect(FEATURES).toContain('region.tiles');
  });

  it('canonical JSON sorts keys and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 'x' }], e: 1.5 })).toBe('{"a":[1,{"c":"x","d":2}],"b":1,"e":1.5}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

// ---- region.plan ------------------------------------------------------------------------------------

describe('region.plan (fake kit, sim backend)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = makeSidecar(['--backend', 'sim']);
    await h.sc.start(new SimDesigner(h.sc, 20));
  });
  afterAll(async () => {
    await h.sc.regions.idle();
    await h.close();
  });

  it('plans a bundled program: the plan dir, region.planned with the IR and its fields', async () => {
    const r = await plan(h, { params: { notes: ['hello'] }, seed: '42', roles: { rock: 'minecraft:stone' } });
    expect(r.ack.ok).toBe(true);
    expect(r.ack.result).toMatchObject({ seed: '42' });
    expect(r.failed).toBeUndefined();
    const p = r.planned!;
    expect(p.ir).toBeDefined();
    expect(p.irBlobId).toBeUndefined();
    expect(sha256(p.ir!)).toBe(p.irSha);
    const ir = JSON.parse(p.ir!) as Record<string, unknown>;
    expect(canonicalJson(ir)).toBe(p.ir);
    expect(ir).toMatchObject({ format: 1, seed: '42', roles: { rock: 'minecraft:stone' }, claim: CLAIM });
    expect(p.stages).toEqual(['ground']);
    expect(p.lots).toHaveLength(1);
    expect(p.anchors).toHaveProperty('entrance');
    expect(p.budget).toMatchObject({ cells: 100 });
    expect(p.tiles).toEqual({ ground: { terrain: ['0,0'], path: [] } });
    expect(p.notes).toEqual(['fake plan of fake_basic', 'hello']);
    const dir = h.sc.regions.planDir(p.planId);
    for (const f of ['program.mjs', 'survey.bin', 'params.json', 'bible.json', 'request.json', 'ir.json', 'plan.json']) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    expect(sha256(fs.readFileSync(path.join(dir, 'ir.json')))).toBe(p.irSha);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'))).toMatchObject({ planId: p.planId, ok: true, irSha: p.irSha });
    console.log(`[numbers] fake plan (fake_basic): ${r.ms} ms round trip, ${p.ms} ms in the child`);
  });

  it('resolves bible roles (request roles win) and picks a u64 seed when none is given', async () => {
    const r = await plan(h, { bible: 'rustic', roles: { rock: 'minecraft:tuff' } });
    expect(r.planned).toBeDefined();
    const ir = JSON.parse(r.planned!.ir!) as { roles: Record<string, string>; seed: string };
    expect(ir.roles.rock).toBe('minecraft:tuff');
    expect(Object.keys(ir.roles).length).toBeGreaterThan(1);
    expect(ir.seed).toMatch(/^\d{1,20}$/);
    expect(BigInt(ir.seed) <= 0xffffffffffffffffn).toBe(true);
    const bible = JSON.parse(fs.readFileSync(path.join(h.sc.regions.planDir(r.planned!.planId), 'bible.json'), 'utf8')) as Record<string, unknown>;
    expect(bible).toMatchObject({ id: 'rustic', version: 1 });
  });

  it('runs a program under <gameDir>/architect/regions/programs and refuses anything else', async () => {
    const dir = h.cfg.regions.programsDir;
    fs.mkdirSync(path.join(dir, 'mine'), { recursive: true });
    fs.copyFileSync(path.join(h.cfg.kitDir, 'regions', 'fake_basic.mjs'), path.join(dir, 'mine', 'town.mjs'));
    const r = await plan(h, { program: path.join(dir, 'mine', 'town.mjs') });
    expect(r.planned, r.failed?.message).toBeDefined();
    const rel = await plan(h, { program: 'mine/town.mjs' });
    expect(rel.planned).toBeDefined();
    // outside: a parent path, an absolute path elsewhere, a link out, not .mjs, a missing bundled id, a bad blob
    const outside = path.join(h.root, 'evil.mjs');
    fs.copyFileSync(path.join(h.cfg.kitDir, 'regions', 'fake_basic.mjs'), outside);
    fs.symlinkSync(outside, path.join(dir, 'link.mjs'));
    for (const program of ['../evil.mjs', outside, 'link.mjs', 'mine/town.js', 'no_such_program', 'Bad-Id']) {
      const a = await plan(h, { program });
      expect(a.ack.ok, program).toBe(false);
    }
    const nb = await call(h, { type: 'region.plan', program: 'fake_basic', params: {}, claim: CLAIM, surveyBlobId: 'bnosuchblob' });
    expect(nb).toMatchObject({ ok: false });
    expect(nb.error).toMatch(/no blob/);
    expect((await call(h, { type: 'region.plan', program: 'fake_basic', params: {}, claim: CLAIM, surveyBlobId: putSurvey(h), bible: 'no_such_bible' })).ok).toBe(false);
  });

  it('fails the plan with the kit\'s message when the program throws (sim backend)', async () => {
    const r = await plan(h, { params: { throw: 'the moat needs water' } });
    expect(r.ack.ok).toBe(true);
    expect(r.planned).toBeUndefined();
    expect(r.failed!.message).toContain('the moat needs water');
    expect(JSON.parse(fs.readFileSync(path.join(h.sc.regions.planDir(r.failed!.planId), 'plan.json'), 'utf8'))).toMatchObject({ ok: false });
  });

  it('runs the program sandboxed: no network, no files outside the plan dir', async () => {
    const net = await plan(h, { params: { net: true } });
    expect(net.failed!.message).toMatch(/fetch is not a function|network/);
    const target = path.join(h.root, 'escaped.txt');
    const w = await plan(h, { params: { writeOutside: target } });
    expect(w.failed!.message).toMatch(/ERR_ACCESS_DENIED|permission|Access to this API has been restricted/i);
    expect(fs.existsSync(target)).toBe(false);
    const rd = await plan(h, { params: { readOutside: path.join(h.cfg.dataDir, 'state.json') } });
    expect(rd.failed!.message).toMatch(/ERR_ACCESS_DENIED|permission|Access to this API has been restricted/i);
  });

  it('enforces the IR limit (4 MB) and sends a big IR as a blob (over 1 MB)', async () => {
    const big = await plan(h, { params: { pad: 1_500_000 } });
    expect(big.planned, big.failed?.message).toBeDefined();
    expect(big.planned!.ir).toBeUndefined();
    const blob = h.sc.blobs.get(big.planned!.irBlobId!);
    expect(blob).toMatchObject({ kind: 'region.ir', ext: 'json' });
    expect(sha256(fs.readFileSync(h.sc.blobs.file(big.planned!.irBlobId!)))).toBe(big.planned!.irSha);
    const over = await plan(h, { params: { pad: 4 * 1024 * 1024 + 10 } });
    expect(over.failed!.message).toMatch(/more than the limit of 4194304 bytes/);
  });

  it('enforces the heap limit (injectable; 1 GB by default)', async () => {
    const keep = h.cfg.regions.planHeapMb;
    h.cfg.regions.planHeapMb = 64;
    try {
      const r = await plan(h, { params: { hog: true } });
      expect(r.failed!.message).toBe('the plan ran out of memory (64 MB heap)');
    } finally {
      h.cfg.regions.planHeapMb = keep;
    }
  });

  it('picks the permission flag this node knows, and refuses to plan without one', () => {
    expect(permissionFlag(new Set(['--permission', '--experimental-permission']))).toBe('--permission');
    expect(permissionFlag(new Set(['--experimental-permission']))).toBe('--experimental-permission');
    expect(permissionFlag(new Set())).toBeUndefined();
    expect(permissionFlag()).toBeDefined();
  });

  it('enforces the time limit (injectable; 30 s by default)', async () => {
    expect(h.cfg.regions.planMs).toBe(30_000);
    expect(h.cfg.regions.planHeapMb).toBe(1024);
    const keep = h.cfg.regions.planMs;
    h.cfg.regions.planMs = 1500;
    try {
      const t0 = Date.now();
      const r = await plan(h, { params: { loop: true } });
      expect(r.failed!.message).toMatch(/longer than 1.5 s/);
      expect(Date.now() - t0).toBeLessThan(10_000);
    } finally {
      h.cfg.regions.planMs = keep;
    }
  });
});

// ---- tiles ------------------------------------------------------------------------------------------

describe('region.tiles (fake kit)', () => {
  let h: Harness;
  let planned: Planned;
  beforeAll(async () => {
    h = makeSidecar(['--backend', 'sim']);
    h.cfg.regions.workers = 2;
    h.cfg.regions.window = 4;
    await h.sc.start(new SimDesigner(h.sc, 20));
    planned = (await plan(h, { seed: '7' })).planned!;
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers ir_unknown, then takes the IR with the request (text or object), and refuses a wrong IR', async () => {
    const c = fakeClient();
    const ir = planned.ir!;
    const sha = sha256(ir);
    // an unknown sha (the cache is by sha: a known IR works under any plan id)
    const unknown = await call(h, tilesReq('pnosuchplan', 'c'.repeat(64), ['0,0']), c);
    expect(unknown).toMatchObject({ ok: false, error: 'ir_unknown' });
    expect(await call(h, tilesReq(planned.planId, 'c'.repeat(64), ['0,0']), c)).toMatchObject({ ok: false, error: 'ir_unknown' });
    expect(sha).toBe(planned.irSha);
    // the plan dir's IR under its own sha works without `ir`
    expect(await call(h, tilesReq(planned.planId, planned.irSha, ['0,0']), c)).toMatchObject({ ok: true, result: { accepted: 1 } });
    // a fresh sidecar would not know a plan it never made: simulate with another plan id and a changed IR
    const other = JSON.parse(ir) as Record<string, unknown>;
    other.seed = '8';
    const otherJson = canonicalJson(other);
    const otherSha = sha256(otherJson);
    expect((await call(h, tilesReq('pelsewhere', otherSha, ['0,0']), c)).error).toBe('ir_unknown');
    expect(await call(h, tilesReq('pelsewhere', otherSha, ['0,0'], { ir: 'x' + otherJson }), c)).toMatchObject({ ok: false });
    expect(await call(h, tilesReq('pelsewhere', otherSha, ['0,0'], { ir: otherJson }), c)).toMatchObject({ ok: true, result: { accepted: 1 } });
    // cached now: no ir needed
    expect(await call(h, tilesReq('pelsewhere', otherSha, ['1,0']), c)).toMatchObject({ ok: true });
    // the object form hashes as canonical JSON
    other.seed = '9';
    expect(await call(h, tilesReq('pobj', sha256(canonicalJson(other)), ['0,0'], { ir: other }), c)).toMatchObject({ ok: true });
    // heights must be ARSV
    expect(await call(h, { ...tilesReq(planned.planId, planned.irSha, ['0,0']), tiles: [{ key: '0,0', stage: 'ground', set: 'terrain', heights: Buffer.from('nope').toString('base64') }] }, c)).toMatchObject({ ok: false });
    await until(() => tileAnswers(c, planned.planId).done.size === 1 && tileAnswers(c, 'pelsewhere').done.size === 2 && tileAnswers(c, 'pobj').done.size === 1);
    // the same tile under different IRs differs
    const a = assemble(tileAnswers(c, planned.planId).frames.filter((f) => f.key === '0,0'));
    const b = assemble(tileAnswers(c, 'pelsewhere').frames.filter((f) => f.key === '0,0'));
    expect(a.sha).not.toBe(b.sha);
  });

  it('streams a tile as frames of at most 1 MB with the sha of the uncompressed payload', async () => {
    const c = fakeClient();
    expect(await call(h, tilesReq(planned.planId, planned.irSha, ['3,-2', '95,95']), c)).toMatchObject({ ok: true, result: { accepted: 2 } });
    await until(() => tileAnswers(c, planned.planId).done.size === 2, 20_000);
    const { frames, errors } = tileAnswers(c, planned.planId);
    expect(errors).toEqual([]);
    const small = assemble(frames.filter((f) => f.key === '3,-2'));
    expect(frames.filter((f) => f.key === '3,-2')).toHaveLength(1);
    expect(small.payload.toString('latin1', 0, 4)).toBe('ARTL');
    expect(crypto.createHash('sha256').update(small.payload).digest('hex')).toBe(small.sha);
    expect(small.gz[9]).toBe(255);
    expect(small.gz.readUInt32LE(4)).toBe(0);
    const bigFrames = frames.filter((f) => f.key === '95,95');
    expect(bigFrames.length).toBe(3);
    const big = assemble(bigFrames);
    expect(big.payload.length).toBe(2_500_008);
    expect(crypto.createHash('sha256').update(big.payload).digest('hex')).toBe(big.sha);
    // every frame is a valid outbound message
    for (const f of frames) expect(ServerMessage.safeParse({ v: 1, ...f }).success).toBe(true);
  });

  it('a throwing, crashing, timed-out or out-of-memory tile answers region.tile.error; the others go on', async () => {
    h.cfg.regions.tileMs = 1000;
    h.cfg.regions.tileHeapMb = 64;
    // a fresh pool picks the limits up
    await h.sc.regions.close();
    const c = fakeClient();
    const keys = ['0,0', '99,99', '1,0', '98,98', '2,0', '97,97', '3,0', '96,96', '4,0'];
    expect(await call(h, tilesReq(planned.planId, planned.irSha, keys), c)).toMatchObject({ ok: true, result: { accepted: 9 } });
    await until(() => tileAnswers(c, planned.planId).done.size === 9, 40_000);
    const { frames, errors } = tileAnswers(c, planned.planId);
    const err = (k: string) => errors.find((e) => e.key === k)?.message ?? '';
    expect(err('99,99')).toContain('fake evaluator refused tile 99,99');
    expect(err('98,98')).toMatch(/exited|crashed/);
    expect(err('97,97')).toMatch(/longer than 1 s/);
    expect(err('96,96')).toMatch(/out of memory \(64 MB per worker\)/);
    expect(errors).toHaveLength(4);
    expect(new Set(frames.map((f) => f.key))).toEqual(new Set(['0,0', '1,0', '2,0', '3,0', '4,0']));
    const stats = h.sc.regions.poolStats()!;
    expect(stats.replaced).toBeGreaterThanOrEqual(3);
    expect(stats.workers).toBeLessThanOrEqual(2);
    // and the pool still works
    const c2 = fakeClient();
    await call(h, tilesReq(planned.planId, planned.irSha, ['5,0']), c2);
    await until(() => tileAnswers(c2, planned.planId).frames.length === 1);
    h.cfg.regions.tileMs = 2000;
    h.cfg.regions.tileHeapMb = 256;
  });
});

describe('the window and backpressure', () => {
  let h: Harness;
  let slow: Planned;
  beforeAll(async () => {
    h = makeSidecar(['--backend', 'sim']);
    h.cfg.regions.workers = 4;
    h.cfg.regions.window = 2;
    await h.sc.start(new SimDesigner(h.sc, 20));
    slow = (await plan(h, { params: { slowMs: 60 } })).planned!;
  });
  afterAll(async () => {
    await h.close();
  });

  it('holds at most W tiles per plan; requests beyond W queue and are all answered', async () => {
    const c = fakeClient({ flushed: true });
    const keys = Array.from({ length: 10 }, (_, i) => `${i},1`);
    expect(await call(h, tilesReq(slow.planId, slow.irSha, keys), c)).toMatchObject({ ok: true, result: { accepted: 10 } });
    await until(() => tileAnswers(c, slow.planId).done.size === 10, 20_000);
    expect(h.sc.regions.peakActive).toBe(2);
  });

  it('a client that stops reading stops the evaluation at W tiles', async () => {
    let open!: () => void;
    const c = fakeClient({ flushed: true });
    c.gate = new Promise<void>((r) => {
      open = r;
    });
    const before = h.sc.regions.poolStats()!.tiles;
    const keys = Array.from({ length: 8 }, (_, i) => `${i},2`);
    await call(h, tilesReq(slow.planId, slow.irSha, keys), c);
    await until(() => c.sent.length === 2, 10_000);
    await new Promise((r) => setTimeout(r, 600));
    // two tiles sent and not flushed: nothing more is evaluated
    expect(h.sc.regions.poolStats()!.tiles - before).toBe(2);
    expect(c.sent).toHaveLength(2);
    c.gate = undefined;
    open();
    await until(() => tileAnswers(c, slow.planId).done.size === 8, 20_000);
    expect(h.sc.regions.poolStats()!.tiles - before).toBe(8);
  });

  it('refuses a runaway client beyond 256 waiting tiles', async () => {
    const c = fakeClient({ flushed: true });
    c.gate = new Promise<void>(() => undefined); // never reads
    for (let i = 0; i < 4; i++) expect((await call(h, tilesReq(slow.planId, slow.irSha, Array.from({ length: 64 }, (_, k) => `${k},${10 + i}`)), c)).ok).toBe(true);
    const over = await call(h, tilesReq(slow.planId, slow.irSha, ['0,99']), c);
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/too many tiles/);
    h.sc.regions.clientGone(c);
  });

  it('a connection that goes away loses its queued and in-flight tiles; others go on', async () => {
    const a = fakeClient({ flushed: true });
    const b = fakeClient({ flushed: true });
    await call(h, tilesReq(slow.planId, slow.irSha, Array.from({ length: 8 }, (_, i) => `${i},3`)), a);
    await call(h, tilesReq(slow.planId, slow.irSha, Array.from({ length: 4 }, (_, i) => `${i},4`)), b);
    await until(() => a.sent.length >= 1);
    a.open = false;
    h.sc.clientGone(a);
    const sentA = a.sent.length;
    const before = h.sc.regions.poolStats()!.tiles;
    await until(() => tileAnswers(b, slow.planId).done.size === 4, 20_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(a.sent.length).toBe(sentA);
    expect(sentA).toBeLessThan(8);
    // A's queue was dropped: at most its in-flight window (2) was evaluated after it left, plus B's 4
    expect(h.sc.regions.poolStats()!.tiles - before).toBeLessThanOrEqual(4 + 2);
  });

  it('region.release drops the queued tiles and the cached IR; the plan dir still answers', async () => {
    const c = fakeClient({ flushed: true });
    await call(h, tilesReq(slow.planId, slow.irSha, Array.from({ length: 8 }, (_, i) => `${i},5`)), c);
    await until(() => c.sent.length >= 1);
    const rel = await call(h, { type: 'region.release', planId: slow.planId }, c);
    expect(rel.ok).toBe(true);
    expect(rel.result!.dropped as number).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 400));
    expect(tileAnswers(c, slow.planId).done.size).toBeLessThan(8);
    // from the plan dir again
    const c2 = fakeClient();
    expect(await call(h, tilesReq(slow.planId, slow.irSha, ['0,6']), c2)).toMatchObject({ ok: true });
    await until(() => tileAnswers(c2, slow.planId).done.size === 1);
    // an IR that only came with a request is gone after release
    const ir = JSON.parse(slow.ir!) as Record<string, unknown>;
    ir.seed = '12345';
    const json = canonicalJson(ir);
    expect(await call(h, tilesReq('ponly', sha256(json), ['0,0'], { ir: json }), c2)).toMatchObject({ ok: true });
    await call(h, { type: 'region.release', planId: 'ponly' }, c2);
    expect((await call(h, tilesReq('ponly', sha256(json), ['0,0']), c2)).error).toBe('ir_unknown');
  });
});

// ---- determinism ------------------------------------------------------------------------------------

describe('determinism across worker counts, order and restarts', () => {
  const hs: Harness[] = [];
  afterEach(async () => {
    for (const h of hs.splice(0)) await h.close();
  });

  async function evaluate(workers: number, keys: string[], seed: string): Promise<Map<string, { sha: string; gz: string }>> {
    const h = makeSidecar(['--backend', 'sim']);
    hs.push(h);
    h.cfg.regions.workers = workers;
    h.cfg.regions.window = 16;
    await h.sc.start(new SimDesigner(h.sc, 20));
    const p = (await plan(h, { seed })).planned!;
    const c = fakeClient();
    for (let i = 0; i < keys.length; i += 64) await call(h, tilesReq(p.planId, p.irSha, keys.slice(i, i + 64)), c);
    await until(() => tileAnswers(c, p.planId).done.size === new Set(keys).size, 30_000);
    const out = new Map<string, { sha: string; gz: string }>();
    const { frames } = tileAnswers(c, p.planId);
    for (const k of new Set(keys)) {
      const fs = frames.filter((f) => f.key === k);
      if (!fs.length) continue;
      const t = assemble(fs);
      out.set(k, { sha: t.sha, gz: crypto.createHash('sha256').update(t.gz).digest('hex') });
    }
    return out;
  }

  it('the same bytes for 1 and 4 workers, forward and shuffled, with a crash in the middle', async () => {
    const keys = [] as string[];
    for (let x = -3; x < 3; x++) for (let z = -2; z < 2; z++) keys.push(`${x},${z}`);
    const shuffled = [...keys];
    let s = 12345;
    for (let i = shuffled.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) % 2 ** 31;
      const j = s % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const withCrash = [...shuffled.slice(0, 7), '98,98', ...shuffled.slice(7)];
    const a = await evaluate(1, keys, '99');
    const b = await evaluate(4, withCrash, '99');
    expect(a.size).toBe(keys.length);
    for (const k of keys) expect(b.get(k), k).toEqual(a.get(k));
    expect(b.has('98,98')).toBe(false);
  });
});

// ---- through the WebSocket server (every outbound message validated) --------------------------------

describe('region.* over the WebSocket server (validateOutbound)', () => {
  it('plans and streams with every frame schema-checked; a dropped socket drops its tiles', async () => {
    const { SidecarServer } = await import('../src/server.js');
    const WebSocket = (await import('ws')).default;
    const h = makeSidecar(['--backend', 'sim']);
    h.cfg.regions.window = 1;
    const token = 'region-token-0123456789';
    const server = new SidecarServer(h.sc, { host: '127.0.0.1', port: 0, token, validateOutbound: true, log: h.log });
    await server.start();
    await h.sc.start(new SimDesigner(h.sc, 20));
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      const msgs: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
      ws.on('message', (d) => msgs.push(JSON.parse(d.toString()) as Record<string, unknown>));
      await new Promise<void>((r) => ws.once('open', () => r()));
      const send = (o: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, ...o }));
      send({ type: 'hello', client: 'mod', token, protocols: [1, 2] });
      await until(() => msgs.some((m) => m.type === 'snapshot'));
      expect(msgs[0]!.features).toEqual(expect.arrayContaining(['region.plan', 'region.tiles']));
      send({ type: 'region.plan', id: 'p', program: 'fake_basic', params: { slowMs: 50 }, claim: CLAIM, surveyBlobId: putSurvey(h) });
      await until(() => msgs.some((m) => m.type === 'region.planned'), 30_000);
      const planned = msgs.find((m) => m.type === 'region.planned')!;
      send({ id: 't', ...tilesReq(planned.planId as string, planned.irSha as string, ['0,0', '95,95', '99,99']) });
      await until(() => msgs.filter((m) => (m.type === 'region.tile' && !m.more) || m.type === 'region.tile.error').length === 3, 30_000);
      expect(msgs.find((m) => m.type === 'ack' && m.re === 't')).toMatchObject({ ok: true, result: { accepted: 3 } });
      expect(msgs.find((m) => m.type === 'region.tile.error')).toMatchObject({ key: '99,99', stage: 'ground', set: 'terrain' });
      expect(h.log.lines.some((l) => /violates protocol/.test(l))).toBe(false);
      // close mid-stream: the rest is discarded
      send({ id: 't2', ...tilesReq(planned.planId as string, planned.irSha as string, Array.from({ length: 20 }, (_, i) => `${i},7`)) });
      await until(() => msgs.some((m) => m.type === 'region.tile' && m.key === '0,7'));
      ws.close();
      await until(() => server.clientCount === 0);
      const before = h.sc.regions.poolStats()!.tiles;
      await new Promise((r) => setTimeout(r, 500));
      // at most the one tile (W = 1) that was in flight when the socket closed
      expect(h.sc.regions.poolStats()!.tiles - before).toBeLessThanOrEqual(1);
      expect(msgs.filter((m) => m.type === 'region.tile').length).toBeLessThan(23);
    } finally {
      await server.stop();
      await h.close();
    }
  });
});
