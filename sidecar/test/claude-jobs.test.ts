// Claude jobs through the Agent SDK with a scripted fake `query()` (no API calls): the options
// are exactly what the SDK types ask for (outputFormat, tools: [], maxBudgetUsd, the in-process MCP
// server), the guards refuse everything but the job's own tools, structured_output is validated
// again (one re-ask on a miss), the SDK's error subtypes map to failures, a usage limit holds the
// job, and the MCP server built from a JSON Schema tool passes its arguments through unstripped.
import fs from 'node:fs';
import path from 'node:path';
import type { HookInput, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeDesigner } from '../src/claude/designer.js';
import { ClaudeJobDriver, JOB_MCP_SERVER, STRUCTURED_OUTPUT_TOOL, zodInputFor } from '../src/jobs/claude.js';
import type { DriverQuery } from '../src/jobs/driver.js';
import { DesignRequest, JobSpec, type Outbound } from '../src/protocol.js';
import type { ClientHandle } from '../src/server.js';
import { makeSidecar, request, until, type Harness } from './helpers.js';

let n = 0;
const sid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const msg = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: sid(), ...o }) as unknown as SDKMessage;
const init = (s: string) => msg({ type: 'system', subtype: 'init', session_id: s, model: 'fake', cwd: '', tools: [] });
const usage = (k: number) => ({ 'claude-sonnet-5-5': { inputTokens: 100 * k, outputTokens: 10 * k, cacheReadInputTokens: 50 * k, cacheCreationInputTokens: 20 * k, webSearchRequests: 0, costUSD: 0.01 * k, contextWindow: 1, maxOutputTokens: 1 } });
const result = (s: string, subtype: string, o: Record<string, unknown> = {}) =>
  msg({ type: 'result', subtype, is_error: subtype !== 'success', result: '', num_turns: 2, total_cost_usd: 0.01, session_id: s, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: usage(1), permission_denials: [], ...(subtype === 'success' ? {} : { errors: [subtype] }), ...o });

type Script = (prompt: string, opts: Options) => AsyncGenerator<SDKMessage>;
interface Call {
  prompt: string;
  opts: Options;
}

type ToolServer = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> } };

const canUse = (opts: Options, tool: string, input: Record<string, unknown> = {}) => opts.canUseTool!(tool, input, { signal: new AbortController().signal, toolUseID: 'x', requestId: 'r' } as never) as Promise<{ behavior: string; message?: string }>;

async function runHooks(opts: Options, tool: string, input: Record<string, unknown> = {}): Promise<string[]> {
  const out: string[] = [];
  for (const m of opts.hooks!.PreToolUse!) {
    for (const hook of m.hooks) {
      const r = (await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, session_id: 's', transcript_path: '', cwd: opts.cwd!, tool_use_id: 't' } as unknown as HookInput, 't', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
      if (r.hookSpecificOutput?.permissionDecision) out.push(r.hookSpecificOutput.permissionDecision);
    }
  }
  return out;
}

/** A fake client connection that answers tool calls. */
function fakeClient(answer: (m: Extract<Outbound, { type: 'job.tool.call' }>) => unknown, onSend?: (m: Outbound) => void): ClientHandle & { sent: Outbound[] } {
  const sent: Outbound[] = [];
  const c = {
    id: 99,
    name: 'mod',
    protocol: 2 as const,
    paused: false,
    open: true,
    sent,
    send(m: Outbound) {
      sent.push(m);
      onSend?.(m);
      if (m.type === 'job.tool.call') setTimeout(() => answer(m), 5);
    },
  };
  return c;
}

describe('Claude jobs (fake SDK)', () => {
  let h: Harness;
  let calls: Call[];
  let script: Script;

  beforeAll(async () => {
    calls = [];
    h = makeSidecar(['--backend', 'claude']);
    h.sc.endpoint = { port: 7890, tokenFile: path.join(h.cfg.dataDir, 'client.token') };
    const queryFn = ({ prompt, options }: { prompt: string; options: Options }) => {
      calls.push({ prompt: String(prompt), opts: options });
      const it = script(String(prompt), options);
      return Object.assign(it, { close() {}, accountInfo: async () => ({ email: 'x' }) });
    };
    const designer = new ClaudeDesigner(h.sc, { queryFn: queryFn as never, skipAuthCheck: true });
    h.sc.setAuthSettings('sk-ant-stored-key', undefined);
    await h.sc.start(designer);
  });
  afterAll(async () => {
    await h.close();
  });
  afterEach(() => {
    calls.length = 0;
  });

  const job = (o: Record<string, unknown>) => JobSpec.parse({ prompt: 'do it', ...o });
  const final = (id: string) => until(() => ['done', 'failed', 'cancelled'].includes(h.sc.jobs.book.get(id)!.status), 20_000);
  const schema = { type: 'object', properties: { name: { type: 'string' }, floors: { type: 'integer', minimum: 1 } }, required: ['name', 'floors'], additionalProperties: false };

  it('structured: outputFormat json_schema, tools [], maxBudgetUsd, small maxTurns, no MCP; the answer is structured_output', async () => {
    script = async function* (_p, opts) {
      const s = sid();
      yield init(s);
      yield result(s, 'success', { structured_output: { name: 'Mill', floors: 2 } });
      void opts;
    };
    const j = h.sc.jobs.run(job({ kind: 'structured', schema, budgetUsd: 0.5 }), undefined);
    await final(j.id);
    const o = calls[0]!.opts;
    expect(o.outputFormat).toEqual({ type: 'json_schema', schema });
    expect(o.tools).toEqual([]);
    expect(o.maxBudgetUsd).toBe(0.5);
    expect(o.maxTurns).toBe(4);
    expect(o.model).toBe('claude-sonnet-5-5');
    expect(o.mcpServers).toEqual({});
    expect(o.settingSources).toEqual([]);
    expect(o.permissionMode).toBe('default');
    expect(o.env!.MCP_TOOL_TIMEOUT).toBeUndefined();
    expect(o.cwd).toBe(fs.realpathSync(path.join(h.cfg.dataDir, 'jobs', j.id)));
    expect(typeof o.systemPrompt).toBe('string');
    // the guards: only the structured-output carrier and the job's own tools
    expect((await canUse(o, STRUCTURED_OUTPUT_TOOL)).behavior).toBe('allow');
    for (const t of ['Read', 'Bash', 'Write', 'WebFetch', 'mcp__architect__design_status', 'mcp__other__x']) expect((await canUse(o, t)).behavior).toBe('deny');
    expect(await runHooks(o, STRUCTURED_OUTPUT_TOOL)).toEqual([]);
    expect(await runHooks(o, 'Bash', { command: 'ls' })).toContain('deny');
    const done = h.sc.jobs.book.get(j.id)!;
    expect(done).toMatchObject({ status: 'done', result: { name: 'Mill', floors: 2 }, cost: { usd: 0.01, inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 20, turns: 2 } });
  });

  it('structured: a schema miss is asked once more in the same session, then fails', async () => {
    let k = 0;
    script = async function* (_p, opts) {
      const s = opts.resume ?? sid();
      yield init(s);
      k++;
      yield result(s, 'success', { structured_output: k === 1 ? { name: 'Mill' } : { name: 'Mill', floors: 3 } });
    };
    const j = h.sc.jobs.run(job({ kind: 'structured', schema }), undefined);
    await final(j.id);
    expect(h.sc.jobs.book.get(j.id)).toMatchObject({ status: 'done', result: { name: 'Mill', floors: 3 } });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.opts.resume).toBe(calls[0] && (h.sc.jobs.book.work(j.id)!.sessionId));
    expect(calls[1]!.prompt).toMatch(/floors: required/);

    k = 0;
    calls.length = 0;
    script = async function* (_p, opts) {
      const s = opts.resume ?? sid();
      yield init(s);
      yield result(s, 'success', { structured_output: { name: 7 } });
    };
    const j2 = h.sc.jobs.run(job({ kind: 'structured', schema }), undefined);
    await final(j2.id);
    expect(h.sc.jobs.book.get(j2.id)!.status).toBe('failed');
    expect(h.sc.jobs.book.get(j2.id)!.error).toMatch(/did not match the schema/);
    expect(calls).toHaveLength(2);
  });

  it('maps error_max_structured_output_retries, error_max_budget_usd and error_max_turns to failures', async () => {
    for (const [subtype, error] of [
      ['error_max_structured_output_retries', /error_max_structured_output_retries/],
      ['error_max_budget_usd', /^budget$/],
      ['error_max_turns', /ran out of turns/],
    ] as const) {
      script = async function* () {
        const s = sid();
        yield init(s);
        yield result(s, subtype, { total_cost_usd: 0.03, modelUsage: usage(3) });
      };
      const j = h.sc.jobs.run(job({ kind: 'structured', schema, budgetUsd: 1 }), undefined);
      await final(j.id);
      const got = h.sc.jobs.book.get(j.id)!;
      expect(got.status).toBe('failed');
      expect(got.error).toMatch(error);
      expect(got.cost.usd).toBe(0.03);
    }
  });

  it('agent: tools [], the in-process MCP server with the spec tools + job_status, each call goes to the client', async () => {
    const client = fakeClient((m) => h.sc.jobs.toolResult(m.jobId, m.callId, { trees: 12, input: m.input }, undefined));
    let toolText = '';
    let statusText = '';
    script = async function* (_p, opts) {
      const s = sid();
      yield init(s);
      const server = opts.mcpServers![JOB_MCP_SERVER] as unknown as ToolServer;
      statusText = (await server.instance._registeredTools.job_status!.handler({ step: 'surveying' }, {})).content[0]!.text;
      toolText = (await server.instance._registeredTools.count_trees!.handler({ radius: 8 }, {})).content[0]!.text;
      yield msg({ type: 'assistant', session_id: s, message: { content: [{ type: 'text', text: 'There are 12 trees.' }] } });
      yield result(s, 'success', { result: 'There are 12 trees.' });
    };
    const spec = job({ kind: 'agent', owner: 'steward_mc:test', tools: [{ name: 'count_trees', description: 'Count trees', inputSchema: { type: 'object', properties: { radius: { type: 'integer' } }, required: ['radius'] } }] });
    const j = h.sc.jobs.run(spec, client);
    await final(j.id);
    const o = calls[0]!.opts;
    expect(o.tools).toEqual([]);
    expect(o.outputFormat).toBeUndefined();
    expect(o.maxTurns).toBe(40);
    expect(o.strictMcpConfig).toBe(true);
    expect(Object.keys(o.mcpServers!)).toEqual([JOB_MCP_SERVER]);
    expect(Object.keys((o.mcpServers![JOB_MCP_SERVER] as unknown as ToolServer).instance._registeredTools).sort()).toEqual(['count_trees', 'job_status']);
    expect((await canUse(o, `mcp__${JOB_MCP_SERVER}__count_trees`)).behavior).toBe('allow');
    expect((await canUse(o, `mcp__${JOB_MCP_SERVER}__job_status`)).behavior).toBe('allow');
    expect((await canUse(o, `mcp__${JOB_MCP_SERVER}__nope`)).behavior).toBe('deny');
    expect((await canUse(o, 'Bash', { command: 'ls' })).behavior).toBe('deny');
    expect(statusText).toBe('"ok"');
    expect(JSON.parse(toolText)).toEqual({ trees: 12, input: { radius: 8 } });
    const call = client.sent.find((m) => m.type === 'job.tool.call')!;
    expect(call).toMatchObject({ type: 'job.tool.call', jobId: j.id, name: 'count_trees', input: { radius: 8 }, owner: 'steward_mc:test', timeoutMs: 60_000 });
    expect(h.sc.jobs.book.get(j.id)).toMatchObject({ status: 'done', result: { text: 'There are 12 trees.' } });
    expect(h.events.some((e) => e.type === 'job.event' && e.jobId === j.id && e.kind === 'step')).toBe(true);
    expect(h.events.some((e) => e.type === 'job.event' && e.jobId === j.id && e.kind === 'text')).toBe(true);
  });

  it('a usage limit holds the job (held, usageLimitUntil) and resumes its session after the reset', async () => {
    let k = 0;
    let resetAt = 0;
    script = async function* (_p, opts) {
      const s = opts.resume ?? sid();
      yield init(s);
      if (++k === 1) {
        resetAt = Date.now() + 400;
        yield msg({ type: 'rate_limit_event', session_id: s, rate_limit_info: { status: 'rejected', resetsAt: resetAt, rateLimitType: 'five_hour' } });
        yield result(s, 'success', { is_error: true, result: 'Claude AI usage limit reached', total_cost_usd: 0, modelUsage: {} });
        return;
      }
      yield result(s, 'success', { structured_output: { name: 'Mill', floors: 1 } });
    };
    const j = h.sc.jobs.run(job({ kind: 'structured', schema }), undefined);
    await until(() => h.sc.jobs.book.get(j.id)!.status === 'held');
    expect(h.sc.jobs.book.get(j.id)!.usageLimitUntil).toBe(resetAt);
    expect(h.sc.status().usageLimitUntil).toBe(resetAt);
    await final(j.id);
    expect(h.sc.jobs.book.get(j.id)!.status).toBe('done');
    expect(h.sc.jobs.book.get(j.id)!.usageLimitUntil).toBeUndefined();
    expect(calls[1]!.opts.resume).toBeDefined();
  });

  it('the budget is cumulative across query() calls: a resume gets only what is left, and a spent budget never starts another', async () => {
    const hold = async function* (s: string, usd: number) {
      yield msg({ type: 'rate_limit_event', session_id: s, rate_limit_info: { status: 'rejected', resetsAt: Date.now() + 300, rateLimitType: 'five_hour' } });
      yield result(s, 'success', { is_error: true, result: 'Claude AI usage limit reached', total_cost_usd: usd, modelUsage: usage(usd * 100) });
    };
    // 1) $0.30 spent, held; the resume gets maxBudgetUsd 0.20 and reports the session total (0.45, the earlier 0.30 included)
    let k = 0;
    script = async function* (_p, opts) {
      const s = opts.resume ?? sid();
      yield init(s);
      if (++k === 1) return yield* hold(s, 0.3);
      yield result(s, 'success', { structured_output: { name: 'Mill', floors: 1 }, total_cost_usd: 0.45, modelUsage: usage(45) });
    };
    const j = h.sc.jobs.run(job({ kind: 'structured', schema, budgetUsd: 0.5 }), undefined);
    await final(j.id);
    expect(calls.map((c) => c.opts.maxBudgetUsd)).toEqual([0.5, 0.2]);
    expect(h.sc.jobs.book.get(j.id)).toMatchObject({ status: 'done', cost: { usd: 0.45, inputTokens: 4500 } });

    // 2) the first query spends the whole budget and is held: the resume does not start, the job fails "budget"
    calls.length = 0;
    k = 0;
    script = async function* (_p, opts) {
      const s = opts.resume ?? sid();
      yield init(s);
      if (++k === 1) return yield* hold(s, 0.3);
      yield result(s, 'success', { structured_output: { name: 'Mill', floors: 1 } });
    };
    const j2 = h.sc.jobs.run(job({ kind: 'structured', schema, budgetUsd: 0.3 }), undefined);
    await final(j2.id);
    expect(calls).toHaveLength(1);
    expect(h.sc.jobs.book.get(j2.id)).toMatchObject({ status: 'failed', error: 'budget', cost: { usd: 0.3 } });
  });

  it('designs v2: the request model and budget reach the SDK; the design records cost with cache tokens; ext lands on the entry', async () => {
    script = async function* (prompt, opts) {
      const s = sid();
      yield init(s);
      const bp = /kit\/designs\/(gen_[a-z0-9_]+)\.mjs/.exec(prompt)![1]!;
      fs.writeFileSync(path.join(opts.cwd!, 'kit', 'designs', `${bp}.mjs`), `import { blueprint } from '../lib/kit.mjs';\nexport const id = '${bp}';\nexport default () => blueprint({ id, name: 'X', type: 'cabin', size: {x:9,y:7,z:9} });\n`);
      yield result(s, 'success', { result: 'done', total_cost_usd: 0.2, modelUsage: usage(20) });
    };
    const d = h.sc.requestDesign(DesignRequest.parse(request({ name: 'Budget Cabin', model: 'claude-haiku-5', budgetUsd: 1.5, owner: 'steward_mc:x', ext: { 'steward_mc:lot': 'L3' } })));
    await until(() => ['done', 'failed'].includes(h.sc.designs.get(d.id)!.status), 30_000);
    const got = h.sc.designs.get(d.id)!;
    expect(got.status).toBe('done');
    expect(calls[0]!.opts.model).toBe('claude-haiku-5');
    expect(calls[0]!.opts.maxBudgetUsd).toBe(1.5);
    expect(got.cost).toEqual({ usd: 0.2, inputTokens: 2000, outputTokens: 200, cacheReadTokens: 1000, cacheWriteTokens: 400, turns: 2 });
    const entry = JSON.parse(fs.readFileSync(path.join(h.cfg.libraryDir, got.blueprintId!, `${got.blueprintId}.blueprint.json`), 'utf8')) as Record<string, unknown>;
    expect(entry.ext).toEqual({ 'steward_mc:lot': 'L3' });
    expect(entry.request).toMatchObject({ owner: 'steward_mc:x', budgetUsd: 1.5 });
  });

  it('a design whose budget is spent fails with "budget"', async () => {
    script = async function* () {
      const s = sid();
      yield init(s);
      yield result(s, 'error_max_budget_usd', { total_cost_usd: 0.11, modelUsage: usage(11) });
    };
    const d = h.sc.requestDesign(DesignRequest.parse(request({ name: 'Broke Cabin', budgetUsd: 0.1 })));
    await until(() => ['done', 'failed'].includes(h.sc.designs.get(d.id)!.status), 30_000);
    expect(h.sc.designs.get(d.id)).toMatchObject({ status: 'failed', error: 'budget' });
    expect(h.sc.designs.get(d.id)!.cost!.usd).toBe(0.11);
  });
});

describe('the job MCP server built from JSON Schema (real SDK server, MCP client)', () => {
  it('lists the tool with its schema and passes the arguments through unstripped', async () => {
    const got: unknown[] = [];
    const driver = new ClaudeJobDriver({} as never, { info() {}, warn() {}, error() {}, debug() {} });
    const inputSchema = { type: 'object', properties: { radius: { type: 'integer', minimum: 1, description: 'blocks' }, kinds: { type: 'array', items: { type: 'string', enum: ['oak', 'birch'] } } }, required: ['radius'] };
    const weird = { type: 'object', properties: { x: { $ref: '#/nowhere' } } };
    const tools: DriverQuery['tools'] = [
      { name: 'count_trees', description: 'Count trees', inputSchema, call: async (a) => (got.push(a), { ok: true, result: { n: 3 } }) },
      { name: 'odd', description: 'An odd schema', inputSchema: weird, call: async (a) => (got.push(a), { ok: false, error: 'nope' }) },
      { name: 'loose', description: 'No schema to speak of', inputSchema: {}, call: async (a) => (got.push(a), { ok: true, result: null }) },
    ];
    const cfg = (await driver.mcpServer(tools)) as unknown as { instance: { connect(t: unknown): Promise<void> } };
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await cfg.instance.connect(st);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(ct);
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    expect(names).toEqual(['count_trees', 'loose', 'odd']);
    const ct3 = listed.tools.find((t) => t.name === 'count_trees')!;
    expect(ct3.inputSchema).toMatchObject({ type: 'object', properties: { radius: { type: 'integer', minimum: 1 }, kinds: { type: 'array' } }, required: ['radius'] });
    const r1 = await client.callTool({ name: 'count_trees', arguments: { radius: 5, kinds: ['oak'] } });
    expect(r1.isError).toBeFalsy();
    expect(JSON.parse((r1.content as Array<{ text: string }>)[0]!.text)).toEqual({ n: 3 });
    const r2 = await client.callTool({ name: 'loose', arguments: { anything: { goes: [1, 2] } } });
    expect(r2.isError).toBeFalsy();
    const r3 = await client.callTool({ name: 'odd', arguments: { x: 1, extra: true } });
    expect(r3.isError).toBe(true);
    expect(got).toEqual([{ radius: 5, kinds: ['oak'] }, { anything: { goes: [1, 2] } }, { x: 1, extra: true }]);
    await client.close();
  });

  it('zodInputFor falls back to a loose object for a schema zod cannot read', () => {
    const s = zodInputFor(z, { type: 'object', properties: { a: { type: 'nonsense' } } });
    expect(s.parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('createSdkMcpServer is the one the driver uses (the SDK is installed for these tests)', () => {
    expect(typeof createSdkMcpServer).toBe('function');
  });
});
