// The WebSocket server in-process: hello + client token, refusals, origin / host checks, the sim
// designer end to end, and auth.set never leaking the key.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CLOSE_BAD_TOKEN, HELLO_FIRST, SidecarServer, TOKEN_REFUSED } from '../src/server.js';
import { ServerMessage, type ServerMessage as SM } from '../src/protocol.js';
import { SimDesigner } from '../src/sim.js';
import { makeSidecar, request, until, type Harness } from './helpers.js';

interface Conn {
  ws: WebSocket;
  msgs: SM[];
  closed: { code?: number };
  send(o: Record<string, unknown>): void;
}

async function connect(port: number, headers: Record<string, string> = {}): Promise<Conn> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  const msgs: SM[] = [];
  const closed: { code?: number } = {};
  ws.on('message', (d) => {
    const parsed = ServerMessage.safeParse(JSON.parse(d.toString()));
    if (!parsed.success) throw new Error(`bad server message: ${d.toString()}`);
    msgs.push(parsed.data);
  });
  ws.on('close', (code) => {
    closed.code = code;
  });
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  return { ws, msgs, closed, send: (o) => ws.send(JSON.stringify({ v: 1, ...o })) };
}

describe('WebSocket server + sim designer', () => {
  let h: Harness;
  let server: SidecarServer;
  const token = 'test-token-0123456789';

  beforeAll(async () => {
    h = makeSidecar(['--backend', 'sim']);
    server = new SidecarServer(h.sc, { host: '127.0.0.1', port: 0, token, validateOutbound: true, log: h.log });
    await server.start();
    await h.sc.start(new SimDesigner(h.sc, 20));
  });
  afterAll(async () => {
    await server.stop();
    await h.close();
  });

  it('refuses a hello with a wrong or missing token, and closes', async () => {
    for (const t of ['wrong', undefined]) {
      const c = await connect(server.port);
      c.send({ type: 'hello', id: 'h1', client: 'mod', version: '0.1.0', ...(t ? { token: t } : {}) });
      await until(() => c.closed.code !== undefined);
      expect(c.closed.code).toBe(CLOSE_BAD_TOKEN);
      expect(c.msgs.map((m) => m.type)).toEqual(['error', 'ack']);
      expect(c.msgs[0]).toMatchObject({ type: 'error', message: TOKEN_REFUSED });
      expect(c.msgs.some((m) => m.type === 'snapshot')).toBe(false);
    }
  });

  it('refuses anything before a valid hello, and sends no broadcasts', async () => {
    const c = await connect(server.port);
    c.send({ type: 'design.request', id: 'r1', request: request() });
    c.send({ type: 'auth.set', id: 'a1', apiKey: 'sk-ant-nope' });
    c.send({ type: 'shutdown', id: 's1' });
    await until(() => c.msgs.length >= 6);
    expect(c.msgs.filter((m) => m.type === 'ack').every((m) => m.type === 'ack' && !m.ok && m.error === HELLO_FIRST)).toBe(true);
    expect(h.sc.designs.list()).toHaveLength(0);
    c.ws.close();
  });

  it('rejects browser origins and non-loopback hosts at the upgrade', async () => {
    await expect(connect(server.port, { Origin: 'https://evil.example' })).rejects.toThrow();
    await expect(connect(server.port, { Origin: 'null' })).rejects.toThrow();
    await expect(connect(server.port, { Host: 'evil.example:7890' })).rejects.toThrow();
  });

  it('hello -> snapshot; design.request -> upserts -> done, installed in the library', async () => {
    const c = await connect(server.port);
    c.send({ type: 'hello', client: 'mod', version: '0.1.0', token });
    await until(() => c.msgs.some((m) => m.type === 'snapshot'));
    const snap = c.msgs.find((m) => m.type === 'snapshot')!;
    expect(snap).toMatchObject({ type: 'snapshot', status: { auth: 'ok', backend: 'sim', queued: 0, useClaudeLogin: false } });
    c.send({ type: 'design.request', id: 'r1', request: request({ type: 'tower', name: 'Watch Tower', maxSize: { x: 20, y: 30, z: 20 } }) });
    await until(() => c.msgs.some((m) => m.type === 'ack' && m.re === 'r1'));
    const ack = c.msgs.find((m) => m.type === 'ack' && m.re === 'r1');
    expect(ack).toMatchObject({ ok: true, result: { designId: 'd1' } });
    await until(() => c.msgs.some((m) => m.type === 'design.upsert' && ['done', 'failed'].includes(m.design.status)), 20_000);
    const ups = c.msgs.filter((m): m is Extract<SM, { type: 'design.upsert' }> => m.type === 'design.upsert');
    const statuses = [...new Set(ups.map((u) => u.design.status))];
    expect(statuses).toEqual(['queued', 'designing', 'checking', 'rendering', 'done']);
    const done = ups.at(-1)!.design;
    expect(done.blueprintId).toBe('gen_watch_tower');
    expect(done.size).toEqual({ x: 7, y: 20, z: 7 });
    const dir = path.join(h.cfg.libraryDir, 'gen_watch_tower');
    expect(fs.readdirSync(dir).sort()).toEqual(['gen_watch_tower.blueprint.json', 'gen_watch_tower.mjs', 'gen_watch_tower.nbt', 'gen_watch_tower.preview-front.png', 'gen_watch_tower.preview-iso.png', 'gen_watch_tower.preview-top.png']);
    expect(done.previews).toEqual(['front', 'iso', 'top'].map((v) => path.join(dir, `gen_watch_tower.preview-${v}.png`)));
    // status messages followed the queue
    expect(c.msgs.some((m) => m.type === 'status' && m.status.designing === 'd1')).toBe(true);
    c.ws.close();
  });

  it('a type without an example falls back to the cabin; a cancel stops a job', async () => {
    const c = await connect(server.port);
    c.send({ type: 'hello', token });
    c.send({ type: 'design.request', id: 'r2', request: request({ type: 'chapel', name: undefined, style: 'gothic' }) });
    await until(() => c.msgs.some((m) => m.type === 'ack' && m.re === 'r2'));
    const id2 = (c.msgs.find((m) => m.type === 'ack' && m.re === 'r2') as unknown as { result: { designId: string } }).result.designId;
    await until(() => h.sc.designs.get(id2)?.status === 'done', 20_000);
    expect(h.sc.designs.get(id2)!.blueprintId).toBe('gen_gothic_chapel');
    expect(h.sc.designs.get(id2)!.step).toContain('copied cabin (no chapel example)');

    c.send({ type: 'design.request', id: 'r3', request: request({ name: 'Doomed' }) });
    await until(() => c.msgs.some((m) => m.type === 'ack' && m.re === 'r3'));
    const id3 = (c.msgs.find((m) => m.type === 'ack' && m.re === 'r3') as unknown as { result: { designId: string } }).result.designId;
    c.send({ type: 'design.cancel', id: 'c3', designId: id3 });
    await until(() => c.msgs.some((m) => m.type === 'ack' && m.re === 'c3'));
    await new Promise((r) => setTimeout(r, 300));
    expect(h.sc.designs.get(id3)!.status).toBe('cancelled');
    expect(fs.existsSync(path.join(h.cfg.libraryDir, 'gen_doomed'))).toBe(false);
    c.send({ type: 'design.cancel', id: 'c4', designId: id3 });
    await until(() => c.msgs.some((m) => m.type === 'ack' && m.re === 'c4'));
    expect(c.msgs.find((m) => m.type === 'ack' && m.re === 'c4')).toMatchObject({ ok: false, error: `design ${id3} is already cancelled` });
    c.ws.close();
  });

  it('auth.set stores the key 0600 and never logs or echoes it', async () => {
    const c = await connect(server.port);
    c.send({ type: 'hello', token });
    const key = 'sk-ant-SENTINEL-KEY-4242';
    c.send({ type: 'auth.set', id: 'a1', apiKey: key, useClaudeLogin: true });
    await until(() => c.msgs.some((m) => m.type === 'ack' && m.re === 'a1'));
    await until(() => c.msgs.some((m) => m.type === 'status' && m.status.useClaudeLogin));
    const file = path.join(h.cfg.dataDir, 'secrets.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ apiKey: key, useClaudeLogin: true });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(c.msgs)).not.toContain('SENTINEL');
    expect(h.log.lines.join('\n')).not.toContain('SENTINEL');
    h.store.flush();
    expect(fs.readFileSync(path.join(h.cfg.dataDir, 'state.json'), 'utf8')).not.toContain('SENTINEL');
    c.send({ type: 'auth.set', id: 'a2', apiKey: null, useClaudeLogin: false });
    await until(() => c.msgs.some((m) => m.type === 'ack' && m.re === 'a2'));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ useClaudeLogin: false });
    c.ws.close();
  });
});
