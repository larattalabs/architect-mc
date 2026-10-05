// What a design turn may do. Every tool call goes through three PreToolUse hooks (they run for
// every call, also ones the CLI would allow by itself) and then canUseTool:
//
//   mcpGate          only the sidecar's own MCP server (design_status), fail-closed (ported from
//                    AgentCraft's agents/claude/permissions.ts)
//   private guard    the sidecar's own files (client.token, secrets.json, state.json, ...) and port
//                    are off limits (policy.ts foremanPrivateVerdict, ported)
//   design guard     (new) file edits only to the job's own kit/designs/<id>.mjs; no git at all;
//                    no subagents, web tools or skills
//   canUseTool       AgentCraft's worker policy (policy.ts classifyToolUse) with cwd = the scratch
//                    dir; whatever it would ask about is refused, since nobody can answer a prompt
//
// Bash commands may still write inside the scratch dir (build.mjs writes kit/out, the renderer
// writes previews/): the sidecar re-checks the design with a pristine kit in a child process, so
// whatever else the agent changes in its copy of the kit does not count.
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { splitSegments, type Verdict } from '../policy.js';
import { isInsideOrEqual } from '../util/fsx.js';

/** Where an MCP tool comes from, as the CLI reports it on hook input (`mcp_server`). */
export interface McpProvenance {
  name: string;
  source: string;
}

/**
 * Fail-closed gate for MCP tools: an `mcp__*` tool runs only when it belongs to a server the sidecar
 * configured itself (never with claude.ai provenance). Anything else is refused.
 */
export function mcpGate(toolName: string, prov: McpProvenance | undefined, servers: string[]): { allow: true } | { allow: false; server: string; reason: string } {
  if (!toolName.startsWith('mcp__')) return { allow: true };
  const named = servers.find((s) => toolName.startsWith(`mcp__${s}__`));
  if (prov) {
    if (prov.source !== 'claudeai' && servers.includes(prov.name) && (!named || named === prov.name)) return { allow: true };
    return { allow: false, server: prov.name, reason: `The MCP server "${prov.name}" (${prov.source}) is not available in a design job.` };
  }
  if (named) return { allow: true };
  const server = toolName.slice(5).split('__')[0] || toolName;
  return { allow: false, server, reason: `The MCP tool ${toolName} has no known origin and is not from the sidecar's own server, so it is refused.` };
}

export function connectorHook(servers: string[], report: (toolName: string, server: string) => void): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const prov = (input as { mcp_server?: McpProvenance }).mcp_server;
    const v = mcpGate(input.tool_name, prov, servers);
    if (v.allow) return {};
    report(input.tool_name, v.server);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: v.reason } };
  };
}

/** A PreToolUse hook that denies whatever `check` denies (the private guard, the design guard). */
export function denyHook(check: (toolName: string, input: Record<string, unknown>) => Verdict | undefined, report: (toolName: string, reason: string) => void): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const toolInput = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>;
    const v = check(input.tool_name, toolInput);
    if (!v || v.action !== 'deny') return {};
    report(input.tool_name, v.reason);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: v.reason } };
  };
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const OFF_TOOLS: Record<string, string> = {
  Agent: 'Subagents are not available in a design job; do the work directly.',
  Task: 'Subagents are not available in a design job; do the work directly.',
  WebFetch: 'There is no network access in a design job.',
  WebSearch: 'There is no network access in a design job.',
  Skill: 'Skills are not available in a design job.',
  NotebookEdit: 'Only your design module can be written.',
};

/** `p` resolved through links as far as it exists. */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  try {
    while (!fs.existsSync(cur)) {
      const up = path.dirname(cur);
      if (up === cur) return p;
      rest.unshift(path.basename(cur));
      cur = up;
    }
    return path.join(fs.realpathSync.native(cur), ...rest);
  } catch {
    return p;
  }
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Does a shell command run git anywhere (any segment, any wrapper path like /usr/bin/git)? */
export function runsGit(command: string): boolean {
  let segs: string[];
  try {
    segs = splitSegments(command);
  } catch {
    segs = command.split(/[;&|\n()]+/);
  }
  for (const seg of segs) {
    const words = seg.replace(/[$`(]/g, ' ').trim().split(/\s+/).filter(Boolean);
    // skip env assignments and common wrappers
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || ['env', 'command', 'exec', 'nohup', 'time', 'xargs', 'sudo', 'timeout'].includes(words[i]!))) i++;
    const w = words[i];
    if (w && /(^|[\\/])git(\.exe)?$/i.test(w.replace(/^['"]|['"]$/g, ''))) return true;
  }
  return /\bgit\s+(push|commit|add|init|clone|fetch|pull|remote|config|checkout|reset)\b/.test(command);
}

/**
 * The design job's own rules on top of the worker policy: undefined = no objection. `cwd` is the
 * scratch dir, `bp` the id the agent builds under.
 */
export function designVerdict(toolName: string, input: Record<string, unknown>, ctx: { cwd: string; bp: string }): Verdict | undefined {
  if (toolName in OFF_TOOLS) return { action: 'deny', reason: OFF_TOOLS[toolName]! };
  if (EDIT_TOOLS.has(toolName)) {
    const own = path.join(ctx.cwd, 'kit', 'designs', `${ctx.bp}.mjs`);
    const p = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : '';
    const abs = p ? path.resolve(ctx.cwd, p) : '';
    // compared through links (the scratch dir may be reached by a link and by its real path alike)
    if (abs && samePath(realish(abs), realish(own)) && isInsideOrEqual(realish(abs), realish(ctx.cwd))) return undefined;
    return { action: 'deny', reason: `Only kit/designs/${ctx.bp}.mjs is yours to write in a design job (not ${p || 'a file without a path'}). Use node kit/build.mjs and kit/render.mjs for everything else.` };
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (runsGit(command)) return { action: 'deny', reason: 'No git in a design job: the scratch folder is not a repository.' };
  }
  return undefined;
}
