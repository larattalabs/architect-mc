// End to end through the BUILT bundle, the way the mod's launcher runs it: `node dist/main.mjs
// --port 0 --data --library --kit --backend sim --parent-pid`. Covers the esbuild bundle (ws in an
// ESM bundle, the version from package.json), the files it writes (client.token and sidecar.json,
// 0600 token), the token check over a real socket, a sim design installed in the library through
// the fixture kit CLI, auth.set never leaking the key, a second sidecar on a taken port leaving the
// first one alone, the shutdown message, and exiting when the parent pid is gone.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
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
    await until(() => fs.existsSync(path.join(data, 'sidecar.json')) && fs.existsSync(path.join(data, 'client.token')), 15_000);
    const run = JSON.parse(fs.readFileSync(path.join(data, 'sidecar.json'), 'utf8')) as { pid: number; port: number; version: string; startedAt: number };
    port = run.port;
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
    await until(() => fs.existsSync(path.join(data2, 'sidecar.json')), 15_000);
    const t0 = Date.now();
    await new Promise((r) => parent.on('exit', r));
    const code = await Promise.race([q.exit, new Promise((r) => setTimeout(() => r('timeout'), 12_000))]);
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(12_000);
    expect(q.out.join('')).toMatch(/parent pid \d+ is gone/);
  }, 30_000);
});
