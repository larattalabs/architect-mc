// The sim job driver (no Claude), for tests and offline work. It yields the SDK's message stream
// the way the Claude driver does, so the runner cannot tell them apart:
//
//   - structured: one step, then a result whose `structured_output` is built from the schema
//     (schema.ts sampleFromSchema)
//   - agent: calls each mod-provided tool once, in the order declared, with an input built from its
//     inputSchema, and ends with a result whose text is `{"results":[{tool, result | error}]}`
//   - every step adds `simJobStepUsd` (default $0.01) and some tokens to the reported cost, and the
//     sim honours maxBudgetUsd like the SDK (error_max_budget_usd once this query spent more)
//   - a session (its next tool, results and cost) is kept in <scratch>/sim-sessions.json, so a
//     resumed session continues from its saved total, as the SDK's do
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { JOB_STATUS_TOOL } from '../protocol.js';
import type { DriverQuery, JobDriver } from './driver.js';
import { sampleFromSchema } from './schema.js';

interface SimSession {
  next: number;
  results: Array<{ tool: string; result?: unknown; error?: string }>;
  usd: number;
  steps: number;
}

const SIM_MODEL = 'sim';

function load(file: string): Record<string, SimSession> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, SimSession>;
  } catch {
    return {};
  }
}

const msg = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: crypto.randomUUID(), ...o }) as unknown as SDKMessage;

export class SimJobDriver implements JobDriver {
  readonly name = 'sim' as const;

  constructor(
    /** ms per step */
    private stepMs = 400,
    /** estimated USD per step */
    private stepUsd = 0.01,
  ) {}

  async *query(q: DriverQuery): AsyncGenerator<SDKMessage> {
    const file = path.join(q.cwd, 'sim-sessions.json');
    const sessions = load(file);
    const sessionId = q.resume && sessions[q.resume] ? q.resume : crypto.randomUUID();
    const st: SimSession = (sessions[sessionId] ??= { next: 0, results: [], usd: 0, steps: 0 });
    const save = () => fs.writeFileSync(file, JSON.stringify(sessions));
    const startUsd = st.usd;
    const step = () => {
      st.usd = Math.round((st.usd + this.stepUsd) * 1e6) / 1e6;
      st.steps++;
      save();
    };
    const over = () => q.maxBudgetUsd !== undefined && st.usd - startUsd > q.maxBudgetUsd + 1e-9;
    const result = (subtype: string, extra: Record<string, unknown> = {}) =>
      msg({
        type: 'result',
        subtype,
        is_error: subtype !== 'success',
        session_id: sessionId,
        num_turns: st.steps,
        total_cost_usd: st.usd,
        duration_ms: 1,
        duration_api_ms: 1,
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {
          [SIM_MODEL]: { inputTokens: 1000 * st.steps, outputTokens: 100 * st.steps, cacheReadInputTokens: 500 * st.steps, cacheCreationInputTokens: 200 * st.steps, webSearchRequests: 0, costUSD: st.usd, contextWindow: 200_000, maxOutputTokens: 32_000 },
        },
        permission_denials: [],
        ...(subtype === 'success' ? {} : { errors: [subtype] }),
        ...extra,
      });
    const pause = () => new Promise<void>((r) => setTimeout(r, this.stepMs));
    save();
    yield msg({ type: 'system', subtype: 'init', session_id: sessionId, model: SIM_MODEL, cwd: q.cwd, tools: q.tools.map((t) => `mcp__sim__${t.name}`) });

    // answers to the calls that were waiting when the helper restarted
    for (const a of q.resumeAnswers ?? []) {
      st.results.push({ tool: a.name, ...(a.error !== undefined ? { error: a.error } : { result: a.result }) });
      st.next++;
      step();
    }
    if (over()) return yield result('error_max_budget_usd');

    if (q.kind === 'structured') {
      await pause();
      if (q.abort.signal.aborted) return;
      step();
      if (over()) return yield result('error_max_budget_usd');
      yield msg({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'sim: answering to the schema' }] } });
      yield result('success', { result: '', structured_output: sampleFromSchema(q.schema ?? { type: 'object' }) });
      return;
    }

    const status = q.tools.find((t) => t.name === JOB_STATUS_TOOL);
    const tools = q.tools.filter((t) => t.name !== JOB_STATUS_TOOL);
    if (status) await status.call({ step: `sim: calling ${tools.length} tool${tools.length === 1 ? '' : 's'}` });
    while (st.next < tools.length) {
      if (q.abort.signal.aborted) return;
      const t = tools[st.next]!;
      const input = sampleFromSchema(t.inputSchema);
      yield msg({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: `sim_${st.next}`, name: `mcp__sim__${t.name}`, input }] } });
      const a = await t.call(input);
      if (q.abort.signal.aborted) return;
      st.results.push({ tool: t.name, ...(a.ok ? { result: a.result } : { error: a.error }) });
      st.next++;
      step();
      if (over()) return yield result('error_max_budget_usd');
      await pause();
    }
    if (q.abort.signal.aborted) return;
    step();
    if (over()) return yield result('error_max_budget_usd');
    const text = JSON.stringify({ results: st.results });
    yield msg({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text }] } });
    yield result('success', { result: text, ...(q.schema ? { structured_output: sampleFromSchema(q.schema) } : {}) });
  }
}
