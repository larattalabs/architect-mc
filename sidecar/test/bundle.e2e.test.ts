// End to end through the BUILT bundle, the way the mod's launcher runs it: `node dist/main.mjs
// --port 0 --data --library --kit --backend sim --parent-pid`. Covers the esbuild bundle (ws in an
// ESM bundle, the version from package.json), the files it writes (client.token and sidecar.json,
// 0600 token), the token check over a real socket, a sim design installed in the library through
// the fixture kit CLI, auth.set never leaking the key, a second sidecar on a taken port leaving the
// first one alone, the shutdown message, and exiting when the parent pid is gone.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '../src/protocol.js';
import { copyKit, request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const MAIN = path.join(SIDECAR_ROOT, 'dist', 'main.mjs');
const VERSION = (JSON.parse(fs.readFileSync(path.join(SIDECAR_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

interface Proc {
  child: ChildProcess;
  out: string[];
  exit: Promise<number | null>;
}

function startSidecar(args: string[]): Proc {
  const child = spawn(process.execPath, [MAIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' } });
  const out: string[] = [];
  child.stdout!.on('data', (d) => out.push(String(d)));
  child.stderr!.on('data', (d) => out.push(String(d)));
  const exit = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
  return { child, out, exit };
}

/**
 * Wait until this child is up: its own sidecar.json (pid = the child's), which records the port it bound (every sidecar
 * here starts on --port 0, so test runs in other checkouts never collide). A child that exits first is reported as a
 * startup failure with its exit code and output, not as a timeout.
 */
async function ready(p: Proc, data: string, timeoutMs = 15_000): Promise<number> {
  const file = path.join(data, 'sidecar.json');
  const run = (): { pid: number; port: number } | undefined => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; port: number };
    } catch {
      return undefined;
    }
  };
  const exited = () => p.child.exitCode !== null || p.child.signalCode !== null;
  await until(() => run()?.pid === p.child.pid || exited(), timeoutMs);
  if (exited()) throw new Error(`the sidecar exited (${p.child.exitCode ?? p.child.signalCode}) before it was ready:\n${p.out.join('').slice(-1500)}`);
  return run()!.port;
}

async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const msgs: ServerMessage[] = [];
  const closed: { code?: number } = {};
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString()) as ServerMessage));
  ws.on('close', (code) => {
    closed.code = code;
  });
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  return { ws, msgs, closed, send: (o: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, ...o })) };
}

describe('dist/main.mjs (sim backend, fixture kit)', () => {
  let root: string;
  let data: string;
  let library: string;
  let kit: string;
  let p: Proc;
  let port: number;
  let token: string;

  beforeAll(async () => {
    execFileSync(process.execPath, [path.join(SIDECAR_ROOT, 'scripts', 'build.mjs')], { cwd: SIDECAR_ROOT, stdio: 'pipe' });
    root = tempDir('arch-e2e-');
    data = path.join(root, 'sidecar-data');
    library = path.join(root, 'library');
    kit = copyKit(root);
    p = startSidecar(['--port', '0', '--data', data, '--library', library, '--kit', kit, '--backend', 'sim', '--parent-pid', String(process.pid)]);
    port = await ready(p, data);
    await until(() => fs.existsSync(path.join(data, 'client.token')), 15_000);
    token = fs.readFileSync(path.join(data, 'client.token'), 'utf8').trim();
  }, 60_000);

  afterAll(async () => {
    if (p && p.child.exitCode === null) p.child.kill('SIGKILL');
    rmrf(root);
  });

  it('writes sidecar.json and an owner-only client.token', () => {
    const run = JSON.parse(fs.readFileSync(path.join(data, 'sidecar.json'), 'utf8')) as Record<string, unknown>;
    expect(run).toMatchObject({ pid: p.child.pid, port, version: VERSION });
    expect(typeof run.startedAt).toBe('number');
    expect(port).toBeGreaterThan(0);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(data, 'client.token')).mode & 0o777).toBe(0o600);
  });

  it('refuses a wrong token', async () => {
    const c = await connect(port);
    c.send({ type: 'hello', client: 'mod', version: 'test', token: 'not-the-token' });
    await until(() => c.closed.code !== undefined);
    expect(c.closed.code).toBe(4001);
    expect(c.msgs.map((m) => m.type)).toEqual(['error']);
  });

  it('hello -> snapshot, design.request -> design.upsert progression -> done, files in the library', async () => {
    const c = await connect(port);
    c.send({ type: 'hello', client: 'mod', version: 'test', token });
    await until(() => c.msgs.some((m) => m.type === 'snapshot'));
    expect(c.msgs[0]).toMatchObject({ type: 'snapshot', version: VERSION, status: { auth: 'ok', backend: 'sim', sdk: 'ready', queued: 0 } });
    c.send({ type: 'design.request', id: 'r1', request: request({ name: 'Lakeside Cabin' }) });
    await until(() => c.msgs.some((m) => m.type === 'design.upsert' && ['done', 'failed'].includes(m.design.status)), 30_000);
    const ack = c.msgs.find((m) => m.type === 'ack');
    expect(ack).toMatchObject({ type: 'ack', re: 'r1', ok: true, result: { designId: 'd1' } });
    const ups = c.msgs.filter((m): m is Extract<ServerMessage, { type: 'design.upsert' }> => m.type === 'design.upsert');
    expect([...new Set(ups.map((u) => u.design.status))]).toEqual(['queued', 'designing', 'checking', 'rendering', 'done']);
    const d = ups.at(-1)!.design;
    expect(d).toMatchObject({ id: 'd1', blueprintId: 'gen_lakeside_cabin', size: { x: 11, y: 9, z: 13 } });
    const dir = path.join(library, 'gen_lakeside_cabin');
    expect(fs.readdirSync(dir).sort()).toEqual(['gen_lakeside_cabin.blueprint.json', 'gen_lakeside_cabin.mjs', 'gen_lakeside_cabin.nbt', 'gen_lakeside_cabin.preview-front.png', 'gen_lakeside_cabin.preview-iso.png', 'gen_lakeside_cabin.preview-top.png']);
    const sc = JSON.parse(fs.readFileSync(path.join(dir, 'gen_lakeside_cabin.blueprint.json'), 'utf8')) as Record<string, unknown>;
    expect(sc).toMatchObject({ id: 'gen_lakeside_cabin', name: 'Lakeside Cabin', type: 'cabin', source: 'gen_lakeside_cabin.mjs', request: { type: 'cabin', name: 'Lakeside Cabin' } });
    // the checker ran with this node first on PATH, in a minimal env (the sidecar itself got a minimal PATH)
    const env = JSON.parse(fs.readFileSync(path.join(data, 'designs', 'd1', 'check', 'env.json'), 'utf8')) as Record<string, string>;
    expect(env.PATH!.split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
    c.ws.close();
  });

  it('auth.set: the key lands in secrets.json (0600) only', async () => {
    const c = await connect(port);
    c.send({ type: 'hello', token });
    c.send({ type: 'auth.set', id: 'a1', apiKey: 'sk-ant-E2E-SENTINEL' });
    await until(() => c.msgs.some((m) => m.type === 'ack' && m.re === 'a1'));
    const secrets = path.join(data, 'secrets.json');
    expect(fs.readFileSync(secrets, 'utf8')).toContain('sk-ant-E2E-SENTINEL');
    if (process.platform !== 'win32') expect(fs.statSync(secrets).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(c.msgs)).not.toContain('SENTINEL');
    expect(p.out.join('')).not.toContain('SENTINEL');
    expect(fs.readFileSync(path.join(data, 'logs', 'sidecar.log'), 'utf8')).not.toContain('SENTINEL');
    await until(() => fs.readFileSync(path.join(data, 'state.json'), 'utf8').includes('"d1"'));
    expect(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).not.toContain('SENTINEL');
    c.ws.close();
  });

  it('a second sidecar on the same port exits 3 and leaves the token and run file alone', async () => {
    const before = { token: fs.readFileSync(path.join(data, 'client.token'), 'utf8'), run: fs.readFileSync(path.join(data, 'sidecar.json'), 'utf8') };
    const second = startSidecar(['--port', String(port), '--data', data, '--library', library, '--kit', kit, '--backend', 'sim']);
    expect(await second.exit).toBe(3);
    expect(fs.readFileSync(path.join(data, 'client.token'), 'utf8')).toBe(before.token);
    expect(fs.readFileSync(path.join(data, 'sidecar.json'), 'utf8')).toBe(before.run);
  });

  it('shutdown stops it and removes its token and run file', async () => {
    const c = await connect(port);
    c.send({ type: 'hello', token });
    c.send({ type: 'shutdown', id: 's1' });
    expect(await p.exit).toBe(0);
    expect(fs.existsSync(path.join(data, 'client.token'))).toBe(false);
    expect(fs.existsSync(path.join(data, 'sidecar.json'))).toBe(false);
  });

  it('exits when the parent pid is gone', async () => {
    const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: 'ignore' });
    const data2 = path.join(root, 'data2');
    const q = startSidecar(['--port', '0', '--data', data2, '--library', library, '--kit', kit, '--backend', 'sim', '--parent-pid', String(parent.pid)]);
    await ready(q, data2);
    const t0 = Date.now();
    await new Promise((r) => parent.on('exit', r));
    const code = await Promise.race([q.exit, new Promise((r) => setTimeout(() => r('timeout'), 12_000))]);
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(12_000);
    expect(q.out.join('')).toMatch(/parent pid \d+ is gone/);
  }, 30_000);
});

// Protocol 2 through the built bundle (an ephemeral port): negotiation (a protocol-1 client unchanged), a blob, an agent job
// whose tool call survives a SIGKILL of the sidecar (re-sent on hello after the restart, same call id), and a
// structured job.
describe('dist/main.mjs, protocol 2 (sim backend)', () => {
  let port = 0;
  let root: string;
  let data: string;
  let p: Proc | undefined;
  const args = () => ['--port', '0', '--data', data, '--library', path.join(root, 'library'), '--kit', path.join(root, 'kit'), '--backend', 'sim'];
  const tokenOf = () => fs.readFileSync(path.join(data, 'client.token'), 'utf8').trim();
  type M = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const find = (msgs: unknown[], pred: (m: M) => boolean) => (msgs as M[]).find(pred);
  async function start(): Promise<void> {
    if (fs.existsSync(path.join(data, 'sidecar.json'))) fs.rmSync(path.join(data, 'sidecar.json'));
    p = startSidecar(args());
    port = await ready(p, data);
  }
  async function hello2(client = 'mod') {
    const c = await connect(port);
    c.send({ type: 'hello', client, version: 'e2e', token: tokenOf(), protocols: [1, 2] });
    await until(() => c.msgs.some((m) => m.type === 'snapshot'));
    return c;
  }

  beforeAll(async () => {
    if (!fs.existsSync(MAIN)) execFileSync(process.execPath, [path.join(SIDECAR_ROOT, 'scripts', 'build.mjs')], { cwd: SIDECAR_ROOT, stdio: 'pipe' });
    root = tempDir('arch-e2e-p2-');
    data = path.join(root, 'sidecar-data');
    copyKit(root);
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ simStepMs: 20 }));
    await start();
  }, 60_000);

  afterAll(async () => {
    if (p && p.child.exitCode === null) p.child.kill('SIGKILL');
    rmrf(root);
  });

  it('negotiates protocol 2; a protocol-1 hello gets the phase 1-3 snapshot', async () => {
    const v2 = await hello2();
    expect(find(v2.msgs, (m) => m.type === 'snapshot')).toMatchObject({ protocol: 2, features: ['job.run', 'job.tools', 'blobs', 'budget', 'designs.v2', 'bibles', 'design.groups', 'named.parts', 'open.types', 'estimates', 'reskin', 'massing', 'critique', 'critique.report', 'job.images', 'bible.admin', 'bible.restraint', 'entry.versions', 'entry.delta', 'design.polish', 'critique.polish', 'region.plan', 'region.tiles', 'region.check', 'region.preview', 'region.design', 'region.blobs', 'ir.format2', 'estimate.kinds', 'opKeys', 'group.breakdown', 'copies', 'smallEffort', 'versionOf'], jobs: [] });
    const v1 = await connect(port);
    v1.send({ type: 'hello', client: 'mod', version: 'old', token: tokenOf() });
    await until(() => v1.msgs.some((m) => m.type === 'snapshot'));
    expect(Object.keys(find(v1.msgs, (m) => m.type === 'snapshot')!).sort()).toEqual(['designs', 'status', 'type', 'v', 'variants', 'version']);
    v1.ws.close();
    v2.ws.close();
  });

  it('(6a) region.plan and region.tiles through the bundle: the worker module resolves next to dist/main.mjs', async () => {
    expect(fs.existsSync(path.join(SIDECAR_ROOT, 'dist', 'region-worker.mjs'))).toBe(true);
    const c = await hello2();
    const v1 = await connect(port);
    v1.send({ type: 'hello', client: 'mod', version: 'old', token: tokenOf() });
    await until(() => v1.msgs.some((m) => m.type === 'snapshot'));
    const ackOf = async (id: string) => {
      await until(() => find(c.msgs, (m) => m.type === 'ack' && m.re === id) !== undefined, 20_000);
      return find(c.msgs, (m) => m.type === 'ack' && m.re === id)!;
    };
    // an ARSV survey (128x128) and a tile's 80x80 window
    const arsvBuf = (minX: number, minZ: number, w: number, d: number) => {
      const b = Buffer.alloc(28 + w * d * 7);
      b.write('ARSV', 0, 'latin1');
      b[4] = 1;
      b.writeInt32LE(minX, 8);
      b.writeInt32LE(minZ, 12);
      b.writeInt32LE(w, 16);
      b.writeInt32LE(d, 20);
      b.writeInt32LE(1, 24);
      return b;
    };
    c.send({ type: 'blob.put', id: 'sv', kind: 'survey', chunks: [arsvBuf(0, 0, 128, 128).toString('base64')] });
    const blobId = (await ackOf('sv')).result.blobId as string;
    c.send({ type: 'region.plan', id: 'rp', program: 'fake_basic', params: {}, seed: '5', claim: { minX: 0, minZ: 0, maxX: 127, maxZ: 127, minY: -64, maxY: 319 }, surveyBlobId: blobId });
    const planId = (await ackOf('rp')).result.planId as string;
    await until(() => find(c.msgs, (m) => m.type === 'region.planned' && m.planId === planId) !== undefined, 30_000);
    const planned = find(c.msgs, (m) => m.type === 'region.planned')!;
    c.send({ type: 'region.tiles.request', id: 'rt', planId, irSha: planned.irSha, tiles: ['0,0', '95,95'].map((key) => ({ key, stage: 'ground', set: 'terrain', heights: arsvBuf(64 * Number(key.split(',')[0]) - 8, 64 * Number(key.split(',')[1]) - 8, 80, 80).toString('base64') })) });
    expect((await ackOf('rt')).result).toEqual({ accepted: 2 });
    await until(() => (c.msgs as M[]).filter((m) => m.type === 'region.tile' && !m.more).length === 2, 30_000);
    for (const key of ['0,0', '95,95']) {
      const frames = (c.msgs as M[]).filter((m) => m.type === 'region.tile' && m.key === key).sort((a, b) => a.seq - b.seq);
      const payload = zlib.gunzipSync(Buffer.concat(frames.map((f) => Buffer.from(f.data as string, 'base64'))));
      expect(crypto.createHash('sha256').update(payload).digest('hex')).toBe(frames[0]!.sha);
      expect(frames.length).toBe(key === '95,95' ? 3 : 1);
    }
    c.send({ type: 'region.release', id: 'rr', planId });
    expect((await ackOf('rr')).ok).toBe(true);
    // a protocol-1 client sees none of it
    expect(v1.msgs.some((m) => (m.type as string).startsWith('region.'))).toBe(false);
    v1.ws.close();
    c.ws.close();
  }, 60_000);

  it('an agent job with a blob; SIGKILL mid tool call; restart (a new ephemeral port); the call is re-sent and the job completes', async () => {
    let c = await hello2();
    c.send({ type: 'blob.put', id: 'b', kind: 'survey', data: { width: 2, depth: 1, height: [64, 66] } });
    await until(() => c.msgs.some((m) => m.type === 'ack' && m.re === 'b'));
    const blobId = (find(c.msgs, (m) => m.type === 'ack' && m.re === 'b')!.result as M).blobId as string;
    c.send({ type: 'job.run', id: 'j', job: { kind: 'agent', prompt: 'plan the site', blobs: [blobId], tools: [{ name: 'probe', description: 'probe', inputSchema: { type: 'object', properties: { x: { type: 'integer' } } } }] } });
    await until(() => c.msgs.some((m) => m.type === 'job.tool.call'));
    const call = find(c.msgs, (m) => m.type === 'job.tool.call')!;
    const jobId = call.jobId as string;
    expect(fs.existsSync(path.join(data, 'jobs', jobId, 'blobs', `${blobId}.json`))).toBe(true);
    p!.child.kill('SIGKILL');
    await p!.exit;
    await start();
    c = await hello2();
    expect((find(c.msgs, (m) => m.type === 'snapshot')!.jobs as M[]).find((j) => j.id === jobId)).toBeDefined();
    await until(() => c.msgs.some((m) => m.type === 'job.tool.call'), 15_000);
    expect(find(c.msgs, (m) => m.type === 'job.tool.call')).toMatchObject({ jobId, callId: call.callId, name: 'probe' });
    c.send({ type: 'job.tool.result', jobId, callId: call.callId, result: { ok: true } });
    await until(() => c.msgs.some((m) => m.type === 'job.upsert' && m.job.id === jobId && ['done', 'failed'].includes(m.job.status)), 20_000);
    const done = (c.msgs as M[]).filter((m) => m.type === 'job.upsert' && m.job.id === jobId).at(-1)!.job;
    expect(done).toMatchObject({ status: 'done', result: { json: { results: [{ tool: 'probe', result: { ok: true } }] } } });
    // a structured job too
    c.send({ type: 'job.run', id: 's', job: { kind: 'structured', prompt: 'card', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } });
    await until(() => c.msgs.some((m) => m.type === 'job.upsert' && m.job.spec.kind === 'structured' && m.job.status === 'done'), 20_000);
    expect((c.msgs as M[]).filter((m) => m.type === 'job.upsert' && m.job.spec.kind === 'structured').at(-1)!.job.result).toEqual({ name: 'sim' });
    c.send({ type: 'shutdown', id: 'x' });
    expect(await p!.exit).toBe(0);
  }, 60_000);
});

// Phase 4b through the built bundle (an ephemeral port), with the REAL kit and --debug (every outbound message is validated
// against its schema): estimates, a bible job (sim backend: a fixed bible through the real component frame and sheet),
// a design group with an anchor wave that survives a SIGKILL mid-group (itemKey and ext intact), and a re-skin of the
// collection to a built-in bible.
const REAL_KIT = path.join(SIDECAR_ROOT, '..', 'kit');
describe.skipIf(!fs.existsSync(path.join(REAL_KIT, 'tools', 'components.mjs')))('dist/main.mjs, phase 4b (sim backend, real kit)', () => {
  let port = 0;
  let root: string;
  let data: string;
  let p: Proc | undefined;
  const args = () => ['--port', '0', '--data', data, '--library', path.join(root, 'library'), '--kit', REAL_KIT, '--backend', 'sim', '--debug'];
  const tokenOf = () => fs.readFileSync(path.join(data, 'client.token'), 'utf8').trim();
  type M = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const last = (msgs: unknown[], pred: (m: M) => boolean) => (msgs as M[]).filter(pred).at(-1);
  async function start(): Promise<void> {
    if (fs.existsSync(path.join(data, 'sidecar.json'))) fs.rmSync(path.join(data, 'sidecar.json'));
    p = startSidecar(args());
    port = await ready(p, data);
  }
  async function hello2() {
    const c = await connect(port);
    c.send({ type: 'hello', client: 'mod', version: 'e2e', token: tokenOf(), protocols: [1, 2] });
    await until(() => c.msgs.some((m) => m.type === 'snapshot'));
    return c;
  }
  const ack = async (c: Awaited<ReturnType<typeof hello2>>, id: string) => {
    await until(() => c.msgs.some((m) => m.type === 'ack' && m.re === id), 15_000);
    return (c.msgs as M[]).find((m) => m.type === 'ack' && m.re === id)!;
  };

  beforeAll(async () => {
    if (!fs.existsSync(MAIN)) execFileSync(process.execPath, [path.join(SIDECAR_ROOT, 'scripts', 'build.mjs')], { cwd: SIDECAR_ROOT, stdio: 'pipe' });
    root = tempDir('arch-e2e-4b-');
    data = path.join(root, 'sidecar-data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ simStepMs: 150, designConcurrency: 3 }));
    await start();
  }, 60_000);

  afterAll(async () => {
    if (p && p.child.exitCode === null) p.child.kill('SIGKILL');
    rmrf(root);
  });

  it('estimates, a bible, a group across a SIGKILL, a re-skin', async () => {
    let c = await hello2();
    const snap = (c.msgs as M[]).find((m) => m.type === 'snapshot')!;
    expect(snap).toMatchObject({ protocol: 2, groups: [], bibles: [], reskins: [] });
    expect((snap.bibleIndex as M[]).map((b) => b.id)).toEqual(expect.arrayContaining(['rustic', 'oak', 'cherry', 'fortress']));
    // estimates
    c.send({ type: 'bible.estimate', id: 'be', request: { prompt: 'x' } });
    expect((await ack(c, 'be')).result).toMatchObject({ usdLow: 1.16, usdHigh: 1.55, minutesLow: 5, minutesHigh: 8 });
    // a bible
    c.send({ type: 'bible.request', id: 'b', request: { prompt: 'weathered fishing village on stilts', name: 'Stilts', ext: { 'steward_mc:k': 1 } } });
    const b = (await ack(c, 'b')).result as M;
    expect(b).toMatchObject({ bibleId: 'bib_stilts', version: 1 });
    await until(() => c.msgs.some((m) => m.type === 'bible.upsert' && m.bible.id === b.jobId && ['done', 'failed'].includes(m.bible.status)), 30_000);
    const bj = last(c.msgs, (m) => m.type === 'bible.upsert' && m.bible.id === b.jobId)!.bible;
    expect(bj.status, bj.error).toBe('done');
    expect(fs.existsSync(bj.bible.sheetPath)).toBe(true);
    expect(path.dirname(path.dirname(path.dirname(bj.bible.sheetPath)))).toBe(path.join(root, 'bibles', 'bib_stilts'));
    // bible.index follows the job's done upsert: wait for it (the order of the two frames is not fixed)
    await until(() => c.msgs.some((m) => m.type === 'bible.index' && (m.bibles as M[]).some((x) => x.id === b.bibleId)), 10_000);
    expect(last(c.msgs, (m) => m.type === 'bible.index')!.bibles.map((x: M) => x.id)).toContain('bib_stilts');
    // a group: an anchor wave, then two items
    const group = {
      name: 'Stilt Village',
      bible: 'bib_stilts',
      ext: { 'steward_mc:settlement': 'S1' },
      items: [
        { itemKey: 'hall', type: 'tavern', style: 'fishing', features: [], maxSize: { x: 64, y: 40, z: 64 }, anchor: true, role: 'landmark', ext: { 'steward_mc:lot': 'L1' } },
        { itemKey: 'hut', type: 'cabin', style: 'fishing', features: [], maxSize: { x: 64, y: 40, z: 64 }, ext: { 'steward_mc:lot': 'L2' } },
        { itemKey: 'watch', type: 'tower', style: 'fishing', features: [], maxSize: { x: 64, y: 40, z: 64 }, ext: { 'steward_mc:lot': 'L3' } },
      ],
    };
    c.send({ type: 'design.estimate', id: 'ge', group });
    expect((await ack(c, 'ge')).result).toMatchObject({ minutesLow: 16, basis: expect.stringMatching(/2 waves/) });
    c.send({ type: 'design.group', id: 'g', group });
    const g = (await ack(c, 'g')).result as M;
    expect(g.itemKeys).toEqual(['hall', 'hut', 'watch']);
    expect(g.designIds).toHaveLength(3);
    // SIGKILL once the anchor is done and the second wave runs
    await until(() => c.msgs.some((m) => m.type === 'group.upsert' && m.group.id === g.groupId && m.group.done >= 1 && m.group.items.some((i: M) => i.status === 'designing')), 30_000);
    p!.child.kill('SIGKILL');
    await p!.exit;
    await start();
    c = await hello2();
    const back = ((c.msgs as M[]).find((m) => m.type === 'snapshot')!.groups as M[]).find((x) => x.id === g.groupId)!;
    expect(back.items.map((i: M) => [i.itemKey, i.ext])).toEqual([['hall', { 'steward_mc:lot': 'L1' }], ['hut', { 'steward_mc:lot': 'L2' }], ['watch', { 'steward_mc:lot': 'L3' }]]);
    expect(back.ext).toEqual({ 'steward_mc:settlement': 'S1' });
    await until(() => c.msgs.some((m) => m.type === 'group.upsert' && m.group.id === g.groupId && ['done', 'failed'].includes(m.group.status)), 40_000);
    const gd = last(c.msgs, (m) => m.type === 'group.upsert' && m.group.id === g.groupId)!.group;
    expect(gd).toMatchObject({ status: 'done', done: 3, failed: 0, bible: { id: 'bib_stilts', version: 1 } });
    for (const it of gd.items) {
      const e = JSON.parse(fs.readFileSync(path.join(root, 'library', it.entryId, `${it.entryId}.blueprint.json`), 'utf8'));
      expect(e).toMatchObject({ bible: { id: 'bib_stilts', version: 1 }, group: g.groupId, groupItem: it.itemKey, ext: it.ext });
      expect(Object.keys(e.parts ?? {}).length).toBeGreaterThanOrEqual(2);
    }
    // re-skin the collection to a built-in bible: free, checked
    c.send({ type: 'reskin.request', id: 'r', bibleId: 'cherry', from: { group: g.groupId } });
    const r = (await ack(c, 'r')).result as M;
    expect(r.variantIds).toHaveLength(3);
    await until(() => c.msgs.some((m) => m.type === 'reskin.upsert' && m.reskin.id === r.reskinId && m.reskin.status !== 'building'), 30_000);
    expect(last(c.msgs, (m) => m.type === 'reskin.upsert' && m.reskin.id === r.reskinId)!.reskin).toMatchObject({ status: 'done', done: 3, bible: { id: 'cherry', version: 1 } });
    // nothing failed an outbound schema check (--debug validates every message)
    expect(p!.out.join('')).not.toMatch(/violates protocol/);
    c.send({ type: 'shutdown', id: 'x' });
    expect(await p!.exit).toBe(0);
  }, 150_000);
});

// Phase 4c through the built bundle (an ephemeral port), with the REAL kit (its example massings) and --debug (every outbound
// message is validated against its schema): a massing, a redirect, massing.list, a detail pass from it (conformance), a
// massingFirst group with approvalUi "owner" across a SIGKILL while it awaits approval (approve 2, redirect 1, then the
// last), estimates with the massing pass, and massing.delete.
describe.skipIf(!fs.existsSync(path.join(REAL_KIT, 'lib', 'massing.mjs')))('dist/main.mjs, phase 4c (sim backend, real kit)', () => {
  let port = 0;
  let root: string;
  let data: string;
  let p: Proc | undefined;
  const args = () => ['--port', '0', '--data', data, '--library', path.join(root, 'library'), '--kit', REAL_KIT, '--backend', 'sim', '--debug'];
  const tokenOf = () => fs.readFileSync(path.join(data, 'client.token'), 'utf8').trim();
  type M = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const last = (msgs: unknown[], pred: (m: M) => boolean) => (msgs as M[]).filter(pred).at(-1);
  async function start(): Promise<void> {
    if (fs.existsSync(path.join(data, 'sidecar.json'))) fs.rmSync(path.join(data, 'sidecar.json'));
    p = startSidecar(args());
    port = await ready(p, data);
  }
  async function hello2() {
    const c = await connect(port);
    c.send({ type: 'hello', client: 'mod', version: 'e2e', token: tokenOf(), protocols: [1, 2] });
    await until(() => c.msgs.some((m) => m.type === 'snapshot'));
    return c;
  }
  type C = Awaited<ReturnType<typeof hello2>>;
  const ack = async (c: C, id: string) => {
    await until(() => c.msgs.some((m) => m.type === 'ack' && m.re === id), 15_000);
    return (c.msgs as M[]).find((m) => m.type === 'ack' && m.re === id)!;
  };
  const designDone = (c: C, id: string) => until(() => (c.msgs as M[]).some((m) => m.type === 'design.upsert' && m.design.id === id && ['done', 'failed'].includes(m.design.status)), 40_000);
  const groupAt = (c: C, id: string, st: string[], pred: (g: M) => boolean = () => true) => until(() => (c.msgs as M[]).some((m) => m.type === 'group.upsert' && m.group.id === id && st.includes(m.group.status) && pred(m.group)), 60_000);

  beforeAll(async () => {
    if (!fs.existsSync(MAIN)) execFileSync(process.execPath, [path.join(SIDECAR_ROOT, 'scripts', 'build.mjs')], { cwd: SIDECAR_ROOT, stdio: 'pipe' });
    root = tempDir('arch-e2e-4c-');
    data = path.join(root, 'sidecar-data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ simStepMs: 100, designConcurrency: 3 }));
    await start();
  }, 60_000);

  afterAll(async () => {
    if (p && p.child.exitCode === null) p.child.kill('SIGKILL');
    rmrf(root);
  });

  it('a massing, a redirect, a detail pass; a massingFirst group with owner approval across a SIGKILL; delete', async () => {
    let c = await hello2();
    const snap = (c.msgs as M[]).find((m) => m.type === 'snapshot')!;
    expect(snap.features).toContain('massing');
    expect(snap.massings).toEqual([]);
    const req = { type: 'tavern', style: 'rustic', features: [], maxSize: { x: 64, y: 40, z: 64 }, name: 'Inn' };
    c.send({ type: 'design.estimate', id: 'me', request: { ...req, massing: true } });
    expect((await ack(c, 'me')).result).toMatchObject({ usdLow: 0.12, usdHigh: 0.3, minutesLow: 1, minutesHigh: 3 });
    // a massing
    c.send({ type: 'design.request', id: 'm', request: { ...req, massing: true, ext: { 'steward_mc:lot': 'L9' } } });
    const m = (await ack(c, 'm')).result as M;
    expect(m).toMatchObject({ massingId: 'mas_inn', version: 1 });
    await designDone(c, m.designId);
    expect(last(c.msgs, (x) => x.type === 'design.upsert' && x.design.id === m.designId)!.design).toMatchObject({ status: 'done', massing: { id: 'mas_inn', version: 1 } });
    await until(() => (c.msgs as M[]).some((x) => x.type === 'massing.upsert' && x.massing.id === 'mas_inn'));
    expect(fs.existsSync(path.join(root, 'massings', 'mas_inn', 'mas_inn.nbt'))).toBe(true);
    // a redirect
    c.send({ type: 'massing.redirect', id: 'r', massingId: 'mas_inn', notes: 'hip the roof' });
    const r = (await ack(c, 'r')).result as M;
    expect(r).toMatchObject({ massingId: 'mas_inn', version: 2 });
    await designDone(c, r.designId);
    c.send({ type: 'massing.list', id: 'l', massingId: 'mas_inn' });
    expect(((await ack(c, 'l')).result as M).massings.map((x: M) => x.version)).toEqual([1, 2]);
    // the detail pass from v1 (the example pair conforms)
    c.send({ type: 'design.request', id: 'd', request: { ...req, fromMassing: 'mas_inn', massingVersion: 1 } });
    const d = (await ack(c, 'd')).result as M;
    await designDone(c, d.designId);
    const dd = last(c.msgs, (x) => x.type === 'design.upsert' && x.design.id === d.designId)!.design;
    expect(dd, dd.error).toMatchObject({ status: 'done', conformance: { ok: true, errors: [] } });
    // a massingFirst group, approved by its owner only
    const item = (itemKey: string, type: string, o: M = {}) => ({ itemKey, type, style: 'rustic', features: [], maxSize: { x: 64, y: 40, z: 64 }, ...o });
    const group = {
      name: 'Crossroads',
      bible: 'oak',
      owner: 'steward_mc:s1',
      massingFirst: true,
      approvalUi: 'owner',
      context: 'a crossroads hamlet; the street runs along the south side',
      items: [item('inn', 'tavern', { anchor: true, role: 'landmark', ext: { 'steward_mc:lot': 'L1' } }), item('watch', 'tower', { ext: { 'steward_mc:lot': 'L2' } }), item('gate', 'gatehouse', { ext: { 'steward_mc:lot': 'L3' } })],
    };
    c.send({ type: 'design.estimate', id: 'ge', group });
    expect(((await ack(c, 'ge')).result as M).basis).toMatch(/massing first: 3 massings/);
    c.send({ type: 'design.group', id: 'g', group });
    const g = (await ack(c, 'g')).result as M;
    await groupAt(c, g.groupId, ['awaiting_approval']);
    // SIGKILL while it awaits approval
    p!.child.kill('SIGKILL');
    await p!.exit;
    await start();
    c = await hello2();
    const back = ((c.msgs as M[]).find((x) => x.type === 'snapshot')!.groups as M[]).find((x) => x.id === g.groupId)!;
    expect(back).toMatchObject({ status: 'awaiting_approval', awaiting: ['inn', 'watch', 'gate'], approvalUi: 'owner' });
    expect(back.items.map((i: M) => [i.itemKey, i.ext])).toEqual([['inn', { 'steward_mc:lot': 'L1' }], ['watch', { 'steward_mc:lot': 'L2' }], ['gate', { 'steward_mc:lot': 'L3' }]]);
    c.send({ type: 'group.approve', id: 'a0', groupId: g.groupId, approve: ['inn'] });
    expect(await ack(c, 'a0')).toMatchObject({ ok: false, error: expect.stringMatching(/owner only/) });
    c.send({ type: 'group.approve', id: 'a1', groupId: g.groupId, owner: 'steward_mc:s1', approve: ['inn', 'watch'], redirect: { gate: 'make it wider' } });
    expect((await ack(c, 'a1')).result).toMatchObject({ redirected: { gate: { version: 2 } } });
    await groupAt(c, g.groupId, ['awaiting_approval', 'running', 'queued'], (x) => x.items[2].stage === 'approval' && x.items[2].massing.version === 2);
    c.send({ type: 'group.approve', id: 'a2', groupId: g.groupId, owner: 'steward_mc:s1', approve: ['gate'] });
    expect((await ack(c, 'a2')).ok).toBe(true);
    await groupAt(c, g.groupId, ['done', 'failed']);
    const gd = last(c.msgs, (x) => x.type === 'group.upsert' && x.group.id === g.groupId)!.group;
    expect(gd).toMatchObject({ status: 'done', done: 3, failed: 0 });
    expect(gd.items.map((i: M) => i.rounds)).toEqual([0, 0, 1]);
    // delete: a stand-alone massing goes at once
    c.send({ type: 'massing.delete', id: 'x', massingId: 'mas_inn' });
    expect((await ack(c, 'x')).result).toMatchObject({ massingId: 'mas_inn', versions: 2 });
    await until(() => (c.msgs as M[]).some((x) => x.type === 'massing.removed' && x.massingId === 'mas_inn'));
    expect(fs.existsSync(path.join(root, 'massings', 'mas_inn'))).toBe(false);
    // nothing failed an outbound schema check (--debug validates every message)
    expect(p!.out.join('')).not.toMatch(/violates protocol/);
    c.send({ type: 'shutdown', id: 'q' });
    expect(await p!.exit).toBe(0);
  }, 180_000);
});
