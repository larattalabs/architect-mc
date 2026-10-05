// The Claude job driver: every job, structured or agent, runs through the Agent SDK's query(),
// never the raw Messages API, so the opt-in claude-login mode works for jobs too
// (docs/CONTRACT.md "Jobs (R2)").
//
//   structured  outputFormat {type: 'json_schema', schema}; tools: [] (no built-in tools); a small
//               maxTurns; the answer is the result message's structured_output
//   agent       tools: [] as well, plus an in-process MCP server ("architect_job") made from the
//               spec's tools and job_status; each call goes to the client (runner.ts)
//
// Built-in tools are off at the source (tools: []). The refuse-by-default policy stays as the
// second line of defence: hooks and canUseTool allow only this job's own MCP tools and the SDK's
// internal StructuredOutput tool (the carrier of outputFormat answers), and deny everything else.
// The MCP tool-call timeout is unbounded (MCP_TOOL_TIMEOUT is removed from the CLI env and the
// server sets no timeout), because the runner keeps its own clock that stops while the game is
// paused.
import type { CanUseTool, McpServerConfig, Options, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { z as Z } from 'zod';
import { VERSION } from '../config.js';
import type { Logger } from '../context.js';
import type { ClaudeDesigner } from '../claude/designer.js';
import { connectorHook, denyHook } from '../claude/permissions.js';
import { loadSdk, loadZod, type Sdk } from '../claude/sdk.js';
import { foremanPrivateVerdict, type Verdict } from '../policy.js';
import { truncate } from '../util/text.js';
import type { DriverQuery, DriverTool, JobDriver } from './driver.js';

export const JOB_MCP_SERVER = 'architect_job';
/** the SDK's internal tool that carries an outputFormat answer (in the CLI: `name: "StructuredOutput"`) */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/** Is this a tool a job may call: its own MCP tools, or the structured-output carrier? */
export function jobToolAllowed(toolName: string, ownTools: string[]): boolean {
  if (toolName === STRUCTURED_OUTPUT_TOOL) return true;
  const prefix = `mcp__${JOB_MCP_SERVER}__`;
  return toolName.startsWith(prefix) && ownTools.includes(toolName.slice(prefix.length));
}

/** The job's own guard: anything but its tools is refused (hooks and canUseTool). */
export function jobVerdict(toolName: string, ownTools: string[]): Verdict | undefined {
  if (jobToolAllowed(toolName, ownTools)) return undefined;
  return { action: 'deny', reason: `${toolName} is not available in this job: use only the tools you were given.` };
}

/**
 * A zod object for a tool's JSON Schema (the SDK's MCP server takes zod and turns it back into the
 * JSON Schema the model sees). zod's fromJSONSchema keeps the schema; anything it cannot read, or a
 * non-object schema, becomes a loose object, so the arguments always pass through unstripped.
 */
export function zodInputFor(z: typeof Z, schema: Record<string, unknown>): Z.ZodType {
  try {
    if (schema.type === 'object' || (schema.properties && typeof schema.properties === 'object')) {
      const s = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
      if (s instanceof z.ZodObject) {
        z.toJSONSchema(s); // the SDK converts it back: fail here, not there
        return s;
      }
    }
  } catch {
    /* fall through */
  }
  return z.looseObject({});
}

/** What the driver needs from the Claude designer: the query function, the CLI env and process control. */
export type ClaudeHost = Pick<ClaudeDesigner, 'queryFunction' | 'cliEnv' | 'spawner' | 'abortTurn' | 'reap' | 'policyContext'>;

export class ClaudeJobDriver implements JobDriver {
  readonly name = 'claude' as const;

  constructor(
    private host: ClaudeHost,
    private log: Logger,
    private sdkLoader: () => Promise<Sdk | undefined> = loadSdk,
  ) {}

  async mcpServer(tools: DriverTool[]): Promise<McpServerConfig> {
    const sdk = await this.sdkLoader();
    if (!sdk) throw new Error('the Claude Agent SDK is not installed');
    const { z } = await loadZod();
    return sdk.createSdkMcpServer({
      name: JOB_MCP_SERVER,
      version: VERSION,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        // a zod object (the MCP server accepts one); typed as the SDK's raw-shape parameter
        inputSchema: zodInputFor(z, t.inputSchema) as unknown as Z.ZodRawShape,
        handler: async (args: unknown) => {
          const a = await t.call(args);
          return a.ok ? { content: [{ type: 'text' as const, text: JSON.stringify(a.result ?? null) }] } : { content: [{ type: 'text' as const, text: a.error }], isError: true };
        },
      })),
    });
  }

  canUseTool(ownTools: string[], abort: AbortController): CanUseTool {
    return async (toolName, input): Promise<PermissionResult> => {
      if (abort.signal.aborted) return { behavior: 'deny', message: 'The job was stopped.', interrupt: true };
      const v = jobVerdict(toolName, ownTools);
      if (!v) return { behavior: 'allow', updatedInput: input };
      this.log.info(`job blocked: ${toolName} (${truncate(v.reason, 160)})`);
      return { behavior: 'deny', message: v.reason };
    };
  }

  /** The SDK options of a job query (tests read them through a fake query function). */
  async options(q: DriverQuery, entry: Parameters<ClaudeHost['spawner']>[0]): Promise<Options> {
    const own = q.tools.map((t) => t.name);
    const report = (tool: string, why: string) => this.log.info(`job ${q.jobId} blocked: ${tool} (${truncate(why, 160)})`);
    const env = this.host.cliEnv(q.cwd);
    delete env.MCP_TOOL_TIMEOUT;
    const ctx = this.host.policyContext(q.cwd, JOB_MCP_SERVER);
    return {
      cwd: q.cwd,
      model: q.model,
      ...(q.effort ? { effort: q.effort } : {}),
      maxTurns: q.maxTurns,
      ...(q.maxBudgetUsd !== undefined ? { maxBudgetUsd: q.maxBudgetUsd } : {}),
      ...(q.schema ? { outputFormat: { type: 'json_schema' as const, schema: q.schema } } : {}),
      tools: [],
      settingSources: [],
      permissionMode: 'default',
      canUseTool: this.canUseTool(own, q.abort),
      strictMcpConfig: true,
      mcpServers: own.length ? { [JOB_MCP_SERVER]: await this.mcpServer(q.tools) } : {},
      hooks: {
        PreToolUse: [
          { hooks: [denyHook((tool, input) => foremanPrivateVerdict(tool, input, ctx), report)] },
          { hooks: [connectorHook([JOB_MCP_SERVER], (tool, server) => report(tool, `MCP server "${server}" is not available`))] },
          { hooks: [denyHook((tool) => jobVerdict(tool, own), report)] },
        ],
      },
      ...(q.system ? { systemPrompt: q.system } : {}),
      abortController: q.abort,
      env,
      spawnClaudeCodeProcess: this.host.spawner(entry, `job ${q.jobId}`),
      ...(q.resume ? { resume: q.resume } : {}),
    };
  }

  async *query(q: DriverQuery): AsyncGenerator<SDKMessage> {
    const entry = { abort: q.abort } as Parameters<ClaudeHost['spawner']>[0] & { abort: AbortController };
    const options = await this.options(q, entry);
    const it = this.host.queryFunction()({ prompt: q.prompt, options });
    const close = () => {
      this.host.abortTurn(entry!, 'cancel');
      try {
        it.close();
      } catch {
        /* already closed */
      }
    };
    if (q.abort.signal.aborted) close();
    else q.abort.signal.addEventListener('abort', close, { once: true });
    try {
      for await (const m of it) {
        if (q.abort.signal.aborted) break;
        yield m;
      }
    } finally {
      q.abort.signal.removeEventListener('abort', close);
      if (q.abort.signal.aborted) void this.host.reap(entry!);
    }
  }
}
