// Protocol 2 over a real WebSocket with the sim backend (docs/CONTRACT.md "Phase 4a contract"):
// negotiation (a protocol-1 client sees exactly the phase 1-3 messages), structured and agent jobs
// with a tool round trip, the paused clock, a disconnect with the call re-sent on reconnect,
// resume after a sidecar restart, the budget stop, blobs (put, chunks, delete, the scratch copy and
// a kit script reading one), result-size limits, and a design's ext landing on its entry.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { FEATURES, MAX_RESULT_BYTES } from '../src/protocol.js';
import { CLOSE_BAD_PROTOCOL, NO_COMMON_PROTOCOL, SidecarServer } from '../src/server.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { copyKit, request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const TOKEN = 'test-token-protocol-2';
const KIT_BLOBS = path.join(SIDECAR_ROOT, '..', 'kit', 'lib', 'blobs.mjs');

type Msg = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Conn {
  ws: WebSocket;
  msgs: Msg[];
  closed: { code?: number };
  send(o: Record<string, unknown>): void;
  /** the first message matching, waiting for it */
  next(pred: (m: Msg) => boolean, timeoutMs?: number): Promise<Msg>;
  ack(id: string): Promise<Msg>;
}

async function connect(port: number): Promise<Conn> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const msgs: Msg[] = [];
  const closed: { code?: number } = {};
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString()) as Msg));
  ws.on('close', (code) => {
    closed.code = code;
  });
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  const c: Conn = {
    ws,
    msgs,
    closed,
    send: (o) => ws.send(JSON.stringify({ v: 1, ...o })),
    next: async (pred, timeoutMs = 15_000) => {
      await until(() => msgs.some(pred), timeoutMs);
      return msgs.find(pred)!;
    },
    ack: (id) => c.next((m) => m.type === 'ack' && m.re === id),
  };
  return c;
}

/** hello as the mod sends it: protocols [1, 2] (or none: a protocol-1 client) */
async function hello(port: number, opts: { protocols?: number[]; client?: string } = {}): Promise<Conn> {
  const c = await connect(port);
  c.send({ type: 'hello', id: 'h', client: opts.client ?? 'mod', version: '0.4.0', token: TOKEN, ...(opts.protocols ? { protocols: opts.protocols } : {}) });
  await c.next((m) => m.type === 'snapshot');
  return c;
}

interface Env {
  root: string;
  sc: Sidecar;
  server: SidecarServer;
  port: number;
  /** stop this sidecar (state saved), as a restart would */
  stop(): Promise<void>;
}

/** A sidecar (sim backend, fixture kit) plus its server over `root` (reused across restarts). */
async function startEnv(root: string, port = 0): Promise<Env> {
  const kit = fs.existsSync(path.join(root, 'kit')) ? path.join(root, 'kit') : copyKit(root);
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', kit, '--port', String(port), '--backend', 'sim'], {});
  cfg.simStepMs = 20;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const store = new Store(cfg.dataDir, { debounceMs: 5 });
  const sc = new Sidecar(cfg, store, memoryLogger());
  const server = new SidecarServer(sc, { host: '127.0.0.1', port, token: TOKEN, validateOutbound: true, log: sc.log });
  await server.start();
  await sc.start(new SimDesigner(sc, 20));
  return {
    root,
    sc,
    server,
    port: server.port,
    stop: async () => {
      await server.stop();
      await sc.close();
    },
  };
}

const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `the ${name} tool`, inputSchema: { type: 'object', properties: { radius: { type: 'integer', minimum: 4 } }, required: ['radius'] }, ...extra });
const schema = { type: 'object', properties: { name: { type: 'string', minLength: 5 }, floors: { type: 'integer', minimum: 2, maximum: 3 }, style: { enum: ['rustic', 'modern'] }, rooms: { type: 'array', minItems: 2, items: { type: 'string' } } }, required: ['name', 'floors', 'style', 'rooms'], additionalProperties: false };

async function runJob(c: Conn, id: string, job: Record<string, unknown>): Promise<string> {
  c.send({ type: 'job.run', id, job });
  const a = await c.ack(id);
  expect(a, JSON.stringify(a)).toMatchObject({ ok: true });
  return a.result.jobId as string;
}

const jobDone = (c: Conn, jobId: string) => c.next((m) => m.type === 'job.upsert' && m.job.id === jobId && ['done', 'failed', 'cancelled'].includes(m.job.status), 20_000).then((m) => m.job as Msg);

describe('protocol 2 over a WebSocket (sim backend)', () => {
  let env: Env;
  beforeAll(async () => {
    env = await startEnv(tempDir('arch-p2-'));
  });
  afterAll(async () => {
    await env.stop();
    rmrf(env.root);
  });

  it('negotiation: [1, 2] -> protocol 2 with features and jobs; an unknown set is refused', async () => {
    const c = await hello(env.port, { protocols: [1, 2] });
    const snap = c.msgs.find((m) => m.type === 'snapshot')!;
    expect(snap).toMatchObject({ protocol: 2, features: [...FEATURES], jobs: [] });
    expect(FEATURES).toEqual(['job.run', 'job.tools', 'blobs', 'budget', 'designs.v2']);
    c.ws.close();
    const bad = await connect(env.port);
    bad.send({ type: 'hello', id: 'h', token: TOKEN, protocols: [3, 4] });
    await until(() => bad.closed.code !== undefined);
    expect(bad.closed.code).toBe(CLOSE_BAD_PROTOCOL);
    expect(bad.msgs.find((m) => m.type === 'ack')).toMatchObject({ ok: false, error: NO_COMMON_PROTOCOL });
  });

  it('a protocol-1 client gets exactly the phase 1-3 messages and fields, even while a v2 client runs jobs and v2 designs', async () => {
    const v1 = await hello(env.port);
    const v2 = await hello(env.port, { protocols: [1, 2] });
    const snap1 = v1.msgs.find((m) => m.type === 'snapshot')!;
    expect(Object.keys(snap1).sort()).toEqual(['designs', 'status', 'type', 'v', 'variants', 'version']);
    expect(Object.keys(snap1.status).sort()).toEqual(['auth', 'authSource', 'backend', 'message', 'queued', 'sdk', 'useClaudeLogin']);
    // v2 messages from a v1 client fail exactly as an unknown type does
    v1.send({ type: 'job.run', id: 'j', job: { kind: 'structured', prompt: 'x', schema } });
    v1.send({ type: 'no.such.thing', id: 'u' });
    const [ja, ua] = [await v1.ack('j'), await v1.ack('u')];
    expect(ja.ok).toBe(false);
    expect(ja.error).toBe(ua.error);
    // a v2 design (owner, ext, budget) and a v2 job
    v2.send({ type: 'design.request', id: 'd', request: request({ name: 'Owned Mill', owner: 'steward_mc:s1', ext: { 'steward_mc:lot': 'L1' }, budgetUsd: 2, model: 'claude-haiku-5', bible: 'b1', group: 'g1' }) });
    const designId = (await v2.ack('d')).result.designId as string;
    const jobId = await runJob(v2, 'r', { kind: 'structured', prompt: 'a concept card', schema });
    await jobDone(v2, jobId);
    await v2.next((m) => m.type === 'design.upsert' && m.design.id === designId && m.design.status === 'done', 20_000);
    await v1.next((m) => m.type === 'design.upsert' && m.design.id === designId && m.design.status === 'done');
    // the v1 client: no job.* frames, designs without cost or v2 request fields
    expect(v1.msgs.filter((m) => String(m.type).startsWith('job.'))).toEqual([]);
    for (const m of v1.msgs.filter((x) => x.type === 'design.upsert')) {
      expect(Object.keys(m.design).sort()).toEqual(expect.arrayContaining(['createdAt', 'id', 'request', 'status', 'step', 'updatedAt']));
      expect(m.design.cost).toBeUndefined();
      for (const k of ['owner', 'ext', 'budgetUsd', 'model', 'bible', 'group']) expect(m.design.request[k]).toBeUndefined();
    }
    // the v2 client: the same design with cost and its v2 fields
    const d2 = v2.msgs.filter((m) => m.type === 'design.upsert' && m.design.id === designId).at(-1)!.design;
    expect(d2.request).toMatchObject({ owner: 'steward_mc:s1', ext: { 'steward_mc:lot': 'L1' }, budgetUsd: 2, model: 'claude-haiku-5', bible: 'b1', group: 'g1' });
    expect(d2.cost).toEqual({ usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 3 });
    // the design's ext landed on its entry
    const entry = JSON.parse(fs.readFileSync(path.join(env.sc.config.libraryDir, d2.blueprintId, `${d2.blueprintId}.blueprint.json`), 'utf8'));
    expect(entry.ext).toEqual({ 'steward_mc:lot': 'L1' });
    // a v1 client's design.request drops v2 fields
    v1.send({ type: 'design.request', id: 'd1', request: request({ name: 'Plain Hut', owner: 'sneaky', ext: { a: 1 } }) });
    const id1 = (await v1.ack('d1')).result.designId as string;
    expect(env.sc.designs.get(id1)!.request.owner).toBeUndefined();
    expect(env.sc.designs.get(id1)!.request.ext).toBeUndefined();
    v1.send({ type: 'design.cancel', id: 'c1', designId: id1 });
    await v1.ack('c1');
    v1.ws.close();
    v2.ws.close();
  });

  it('a structured job (sim): a fixed object built to the schema, validated, with cost and cache tokens', async () => {
    const c = await hello(env.port, { protocols: [1, 2] });
    const jobId = await runJob(c, 'r', { kind: 'structured', prompt: 'a concept card', schema, owner: 'steward_mc:x', tag: 'card' });
    const j = await jobDone(c, jobId);
    expect(j.status).toBe('done');
    expect(j.result).toEqual({ name: 'sim-sim', floors: 2, style: 'rustic', rooms: ['sim', 'sim'] });
    expect(j.cost).toEqual({ usd: 0.01, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 200, turns: 1 });
    expect(j.spec).toMatchObject({ kind: 'structured', owner: 'steward_mc:x', tag: 'card' });
    const statuses = c.msgs.filter((m) => m.type === 'job.upsert' && m.job.id === jobId).map((m) => m.job.status);
    expect(statuses[0]).toBe('queued');
    expect(statuses).toContain('running');
    c.ws.close();
  });

  it('refuses a bad spec, missing blobs, a job_status tool of its own', async () => {
    const c = await hello(env.port, { protocols: [1, 2] });
    c.send({ type: 'job.run', id: 'a', job: { kind: 'structured', prompt: 'x' } });
    c.send({ type: 'job.run', id: 'b', job: { kind: 'agent', prompt: 'x', blobs: ['bnope'] } });
    c.send({ type: 'job.run', id: 'c', job: { kind: 'agent', prompt: 'x', tools: [tool('job_status')] } });
    expect((await c.ack('a')).error).toMatch(/needs a schema/);
    expect((await c.ack('b')).error).toMatch(/no finished blob "bnope"/);
    expect((await c.ack('c')).error).toMatch(/sidecar's own tool/);
    c.ws.close();
  });

  it('an agent job calls each tool once, in order, and the client answers over the socket', async () => {
    const c = await hello(env.port, { protocols: [1, 2] });
    const jobId = await runJob(c, 'r', { kind: 'agent', prompt: 'survey the site', owner: 'steward_mc:s', tools: [tool('count_trees'), tool('find_water', { timeoutMs: 5000 })] });
    const call1 = await c.next((m) => m.type === 'job.tool.call' && m.name === 'count_trees');
    expect(call1).toMatchObject({ jobId, name: 'count_trees', input: { radius: 4 }, owner: 'steward_mc:s', timeoutMs: 60_000 });
    await c.next((m) => m.type === 'job.upsert' && m.job.id === jobId && m.job.status === 'waiting_tool');
    c.send({ type: 'job.tool.result', id: 't1', jobId, callId: call1.callId, result: { trees: 12 } });
    expect((await c.ack('t1')).ok).toBe(true);
    const call2 = await c.next((m) => m.type === 'job.tool.call' && m.name === 'find_water');
    expect(call2.timeoutMs).toBe(5000);
    c.send({ type: 'job.tool.result', id: 't2', jobId, callId: call2.callId, error: 'no water in range' });
    const j = await jobDone(c, jobId);
    expect(j.status).toBe('done');
    expect(j.result.json).toEqual({ results: [{ tool: 'count_trees', result: { trees: 12 } }, { tool: 'find_water', error: 'no water in range' }] });
    expect(j.result.text).toBe(JSON.stringify(j.result.json));
    expect(j.cost.usd).toBe(0.03);
    // a late or unknown answer is refused
    c.send({ type: 'job.tool.result', id: 't3', jobId, callId: call1.callId, result: 1 });
    expect((await c.ack('t3')).error).toMatch(/no pending tool call/);
    const events = c.msgs.filter((m) => m.type === 'job.event' && m.jobId === jobId);
    expect(events.filter((e) => e.kind === 'tool').map((e) => `${e.data.phase}:${e.data.name}`)).toEqual(['call:count_trees', 'result:count_trees', 'call:find_water', 'error:find_water']);
    expect(events.some((e) => e.kind === 'step')).toBe(true);
    c.ws.close();
  });

  it('the tool clock stops while the game is paused: a pause longer than the timeout, then resume and complete', async () => {
    const c = await hello(env.port, { protocols: [1, 2] });
    const jobId = await runJob(c, 'r', { kind: 'agent', prompt: 'x', tools: [tool('slow', { timeoutMs: 400 })] });
    const call = await c.next((m) => m.type === 'job.tool.call');
    c.send({ type: 'client.paused', id: 'p', paused: true });
    await c.ack('p');
    await new Promise((r) => setTimeout(r, 1200));
    expect(env.sc.jobs.book.get(jobId)!.status).toBe('waiting_tool');
    c.send({ type: 'client.paused', id: 'u', paused: false });
    await c.ack('u');
    c.send({ type: 'job.tool.result', id: 't', jobId, callId: call.callId, result: 'slow but fine' });
    expect((await c.ack('t')).ok).toBe(true);
    const j = await jobDone(c, jobId);
    expect(j.result.json.results).toEqual([{ tool: 'slow', result: 'slow but fine' }]);
    // without a pause the same timeout ends the call with an error the agent sees
    const j2 = await runJob(c, 'r2', { kind: 'agent', prompt: 'x', tools: [tool('slow', { timeoutMs: 300 })] });
    const done2 = await jobDone(c, j2);
    expect(done2.status).toBe('done');
    expect(done2.result.json.results[0].error).toMatch(/timed out after 0s|timed out/);
    expect(c.msgs.some((m) => m.type === 'job.event' && m.jobId === j2 && m.data.phase === 'timeout')).toBe(true);
    c.ws.close();
  });

  it('a client that disconnects mid-call gets the call again when it reconnects (same client name); the clock waits', async () => {
    const c = await hello(env.port, { protocols: [1, 2], client: 'mod' });
    const jobId = await runJob(c, 'r', { kind: 'agent', prompt: 'x', tools: [tool('ask', { timeoutMs: 500 })] });
    const call = await c.next((m) => m.type === 'job.tool.call');
    c.ws.close();
    await new Promise((r) => setTimeout(r, 1000)); // longer than the timeout: no client, no clock
    expect(env.sc.jobs.book.get(jobId)!.status).toBe('waiting_tool');
    const other = await hello(env.port, { protocols: [1, 2], client: 'cli' });
    await new Promise((r) => setTimeout(r, 100));
    expect(other.msgs.some((m) => m.type === 'job.tool.call')).toBe(false);
    const again = await hello(env.port, { protocols: [1, 2], client: 'mod' });
    const resent = await again.next((m) => m.type === 'job.tool.call');
    expect(resent).toMatchObject({ jobId, callId: call.callId, name: 'ask', input: call.input });
    again.send({ type: 'job.tool.result', id: 't', jobId, callId: call.callId, result: 'answered after a reconnect' });
    const j = await jobDone(again, jobId);
    expect(j.result.json.results).toEqual([{ tool: 'ask', result: 'answered after a reconnect' }]);
    other.ws.close();
    again.ws.close();
  });

  it('the budget stop: the sim reports a growing cost; the job fails with "budget" and keeps its cost', async () => {
    const c = await hello(env.port, { protocols: [1, 2] });
    const jobId = await runJob(c, 'r', { kind: 'agent', prompt: 'x', budgetUsd: 0.015, tools: [tool('a'), tool('b'), tool('c')] });
    for (let i = 0; i < 2; i++) {
      const call = await c.next((m) => m.type === 'job.tool.call' && m.jobId === jobId && !m.answered);
      call.answered = true;
      c.send({ type: 'job.tool.result', jobId, callId: call.callId, result: i });
    }
    const j = await jobDone(c, jobId);
    expect(j).toMatchObject({ status: 'failed', error: 'budget' });
    expect(j.cost.usd).toBe(0.02);
    expect(c.msgs.filter((m) => m.type === 'job.tool.call' && m.jobId === jobId).map((m) => m.name)).toEqual(['a', 'b']);
    c.ws.close();
  });

  it('result sizes: a tool answer over 256 KB is refused (the call keeps waiting); a job result over 256 KB goes to a blob', async () => {
    const c = await hello(env.port, { protocols: [1, 2] });
    const jobId = await runJob(c, 'r', { kind: 'agent', prompt: 'x', tools: [tool('big'), tool('bigger')] });
    const call = await c.next((m) => m.type === 'job.tool.call' && m.name === 'big');
    c.send({ type: 'job.tool.result', id: 'over', jobId, callId: call.callId, result: 'x'.repeat(MAX_RESULT_BYTES + 1) });
    expect((await c.ack('over')).error).toMatch(/more than 262144: put it in a blob/);
    // just under the limit each; together the final result is over it
    const half = 'y'.repeat(MAX_RESULT_BYTES - 100);
    c.send({ type: 'job.tool.result', id: 'ok', jobId, callId: call.callId, result: half });
    expect((await c.ack('ok')).ok).toBe(true);
    const call2 = await c.next((m) => m.type === 'job.tool.call' && m.name === 'bigger');
    c.send({ type: 'job.tool.result', jobId, callId: call2.callId, result: half });
    const j = await jobDone(c, jobId);
    expect(j.status).toBe('done');
    expect(j.result).toBeUndefined();
    expect(j.resultBlob).toMatch(/^b[0-9a-f]{16}$/);
    const stored = JSON.parse(env.sc.blobs.read(j.resultBlob).toString('utf8'));
    expect(stored.json.results.map((r: Msg) => r.result.length)).toEqual([half.length, half.length]);
    expect(env.sc.blobs.get(j.resultBlob)).toMatchObject({ kind: 'job.result', ext: 'json' });
    c.ws.close();
  });

  it('blobs: put (JSON and chunks over several frames), delete, the scratch copy, and a kit script reading a survey', async () => {
    const c = await hello(env.port, { protocols: [1, 2] });
    const survey = { area: { minX: 0, minZ: 0, maxX: 2, maxZ: 1 }, resolution: 1, width: 3, depth: 2, height: [64, 65, 66, 64, 64, 70], water: [0, 0, 0, 1, 0, 0], natural: [1, 1, 1, 1, 1, 0] };
    c.send({ type: 'blob.put', id: 'p1', kind: 'survey', owner: 'steward_mc:s', data: survey });
    const p1 = await c.ack('p1');
    expect(p1).toMatchObject({ ok: true, result: { complete: true } });
    const surveyId = p1.result.blobId as string;
    expect(env.sc.blobs.get(surveyId)).toMatchObject({ kind: 'survey', owner: 'steward_mc:s', ext: 'json', size: JSON.stringify(survey).length });
    // binary in chunks over two frames, with a chosen id
    const bytes = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256));
    c.send({ type: 'blob.put', id: 'c1', blobId: 'heightmap_1', kind: 'heightmap', ext: 'bin', chunks: [bytes.subarray(0, 1000).toString('base64'), bytes.subarray(1000, 2000).toString('base64')], more: true });
    expect((await c.ack('c1')).result).toEqual({ blobId: 'heightmap_1', size: 2000, complete: false });
    expect(env.sc.blobs.get('heightmap_1')).toBeUndefined();
    c.send({ type: 'blob.put', id: 'c2', blobId: 'heightmap_1', chunks: [bytes.subarray(2000).toString('base64')] });
    expect((await c.ack('c2')).result).toEqual({ blobId: 'heightmap_1', size: 3000, complete: true });
    expect(env.sc.blobs.read('heightmap_1').equals(bytes)).toBe(true);
    // refusals: no kind, both data and chunks, an oversized chunk
    c.send({ type: 'blob.put', id: 'e1', data: 1 });
    c.send({ type: 'blob.put', id: 'e2', kind: 'x', data: 1, chunks: [] });
    c.send({ type: 'blob.put', id: 'e3', kind: 'x', chunks: [Buffer.alloc(1024 * 1024 + 3).toString('base64')] });
    expect((await c.ack('e1')).error).toMatch(/needs a kind/);
    expect((await c.ack('e2')).error).toMatch(/exactly one of data and chunks/);
    expect((await c.ack('e3')).ok).toBe(false);
    // a job lists them: copied into its scratch dir as blobs/<id>.<ext>
    const jobId = await runJob(c, 'r', { kind: 'structured', prompt: 'x', schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, blobs: [surveyId, 'heightmap_1'] });
    await jobDone(c, jobId);
    const scratch = path.join(env.sc.config.dataDir, 'jobs', jobId);
    expect(fs.readdirSync(path.join(scratch, 'blobs')).sort()).toEqual(['heightmap_1.bin', `${surveyId}.json`].sort());
    // a kit program run in the scratch dir reads the survey through kit/lib/blobs.mjs
    const script = path.join(scratch, 'water.mjs');
    fs.writeFileSync(script, `import { readBlob } from ${JSON.stringify(new URL(`file://${KIT_BLOBS}`).href)};\nconst s = readBlob(process.argv[2]);\nconst hm = readBlob('heightmap_1');\nconsole.log(JSON.stringify({ wet: s.water.filter(Boolean).length, max: Math.max(...s.height), bytes: hm.length }));\n`);
    const out = execFileSync(process.execPath, [script, surveyId], { cwd: scratch, encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual({ wet: 1, max: 70, bytes: 3000 });
    // delete
    c.send({ type: 'blob.delete', id: 'd', blobId: 'heightmap_1' });
    expect((await c.ack('d')).ok).toBe(true);
    expect(fs.existsSync(path.join(env.sc.config.dataDir, 'blobs', 'heightmap_1'))).toBe(false);
    c.send({ type: 'blob.delete', id: 'd2', blobId: 'heightmap_1' });
    expect((await c.ack('d2')).error).toMatch(/no blob/);
    c.ws.close();
  });

  it('cancel stops a job that waits for a tool', async () => {
    const c = await hello(env.port, { protocols: [1, 2] });
    const jobId = await runJob(c, 'r', { kind: 'agent', prompt: 'x', tools: [tool('never')] });
    const call = await c.next((m) => m.type === 'job.tool.call' && m.jobId === jobId);
    c.send({ type: 'job.cancel', id: 'x', jobId });
    expect((await c.ack('x')).ok).toBe(true);
    const j = await jobDone(c, jobId);
    expect(j.status).toBe('cancelled');
    c.send({ type: 'job.tool.result', id: 'late', jobId, callId: call.callId, result: 1 });
    expect((await c.ack('late')).ok).toBe(false);
    c.ws.close();
  });
});

describe('resume after a sidecar restart (sim backend)', () => {
  let root: string;
  let env: Env | undefined;
  beforeEach(() => {
    root = tempDir('arch-restart-');
  });
  afterEach(async () => {
    await env?.stop();
    env = undefined;
    rmrf(root);
  });

  it('a pending tool call survives the restart, is re-sent on hello, and the session continues with its answer', async () => {
    env = await startEnv(root);
    let c = await hello(env.port, { protocols: [1, 2] });
    const jobId = await runJob(c, 'r', { kind: 'agent', prompt: 'x', budgetUsd: 1, tools: [tool('first'), tool('second')] });
    const first = await c.next((m) => m.type === 'job.tool.call' && m.name === 'first');
    c.send({ type: 'job.tool.result', jobId, callId: first.callId, result: 'one' });
    const second = await c.next((m) => m.type === 'job.tool.call' && m.name === 'second');
    const before = env.sc.jobs.book.work(jobId)!;
    expect(before.pending.map((p) => p.callId)).toEqual([second.callId]);
    expect(before.sessionId).toBeDefined();
    c.ws.close();
    await env.stop();

    env = await startEnv(root);
    expect(env.sc.jobs.book.get(jobId)!.status).not.toBe('done');
    c = await hello(env.port, { protocols: [1, 2] });
    // the snapshot lists the unfinished job; the call comes again, same id
    expect(c.msgs.find((m) => m.type === 'snapshot')!.jobs.map((j: Msg) => j.id)).toContain(jobId);
    const resent = await c.next((m) => m.type === 'job.tool.call');
    expect(resent).toMatchObject({ jobId, callId: second.callId, name: 'second' });
    c.send({ type: 'job.tool.result', jobId, callId: second.callId, result: 'two' });
    const j = await jobDone(c, jobId);
    expect(j.status).toBe('done');
    expect(j.result.json.results).toEqual([{ tool: 'first', result: 'one' }, { tool: 'second', result: 'two' }]);
    // one session throughout, and the cost is not counted twice: 3 steps of $0.01
    expect(env.sc.jobs.book.work(jobId)!.sessionId).toBe(before.sessionId);
    expect(j.cost.usd).toBe(0.03);
    expect(env.sc.jobs.book.work(jobId)!.pending).toEqual([]);
    c.ws.close();
  });

  it('after a restart the resumed session continues its saved cost, and the budget still stops it', async () => {
    env = await startEnv(root);
    let c = await hello(env.port, { protocols: [1, 2] });
    // $0.01 per step. Tool a (0.01), then the restart. The interrupted query never reported its cost, so the resumed
    // query gets the whole budget as maxBudgetUsd (the SDK counts only its own spend) and reports the session's
    // total, which includes the 0.01: b (0.02), c (0.03), the answer step (0.04) is 0.03 past its start > 0.025.
    const jobId = await runJob(c, 'r', { kind: 'agent', prompt: 'x', budgetUsd: 0.025, tools: [tool('a'), tool('b'), tool('c')] });
    const a = await c.next((m) => m.type === 'job.tool.call' && m.name === 'a');
    c.send({ type: 'job.tool.result', jobId, callId: a.callId, result: 1 });
    await c.next((m) => m.type === 'job.tool.call' && m.name === 'b');
    c.ws.close();
    await env.stop();
    env = await startEnv(root);
    c = await hello(env.port, { protocols: [1, 2] });
    const b = await c.next((m) => m.type === 'job.tool.call' && m.name === 'b');
    c.send({ type: 'job.tool.result', jobId, callId: b.callId, result: 2 });
    const cc = await c.next((m) => m.type === 'job.tool.call' && m.name === 'c');
    c.send({ type: 'job.tool.result', jobId, callId: cc.callId, result: 3 });
    const j = await jobDone(c, jobId);
    expect(j).toMatchObject({ status: 'failed', error: 'budget' });
    expect(j.cost.usd).toBe(0.04);
    c.ws.close();
  });
});
