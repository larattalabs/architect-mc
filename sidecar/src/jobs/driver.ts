// What runs a job's query: the Claude driver (claude.ts, the Agent SDK's query()) or the sim
// (sim.ts, no Claude). Both yield the SDK's message stream (system init, assistant, result with
// total_cost_usd / modelUsage / structured_output), so the runner treats them alike.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { JobKind } from '../protocol.js';

export type ToolAnswer = { ok: true; result: unknown } | { ok: false; error: string };

/** A tool the agent can call: a mod-provided one (forwarded to the client) or job_status. */
export interface DriverTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(input: unknown): Promise<ToolAnswer>;
}

export interface ResumeAnswer {
  callId: string;
  name: string;
  result?: unknown;
  error?: string;
}

export interface DriverQuery {
  jobId: string;
  kind: JobKind;
  prompt: string;
  system?: string | undefined;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined;
  maxTurns: number;
  /** what is left of the job's budget (the SDK's maxBudgetUsd counts only this query) */
  maxBudgetUsd?: number | undefined;
  /** structured: required; agent: optional (a final JSON answer) */
  schema?: Record<string, unknown> | undefined;
  /** agent: the mod-provided tools plus job_status; structured: none */
  tools: DriverTool[];
  /** the job's scratch dir */
  cwd: string;
  /** an SDK session to resume */
  resume?: string | undefined;
  /** answers to the calls that were pending when the sidecar stopped (also in the prompt) */
  resumeAnswers?: ResumeAnswer[] | undefined;
  abort: AbortController;
}

export interface JobDriver {
  readonly name: 'claude' | 'sim';
  query(q: DriverQuery): AsyncIterable<SDKMessage>;
}
