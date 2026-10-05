// Agent SDK stream messages -> turn stats + log lines (slimmed from AgentCraft's
// agents/claude/stream.ts: no avatars, no agent monitor; the design job logs to the sidecar log).
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../context.js';
import { firstLine, truncate } from '../util/text.js';
import { AUTH_ERRORS, isAuthText, isNetworkText } from './failures.js';

export interface TurnStats {
  sessionId?: string;
  resultText?: string;
  subtype?: string;
  isError: boolean;
  costUsd?: number;
  numTurns?: number;
  authFailed?: string;
  errors: string[];
  /** a usage/rate limit refused this turn (rate_limit_event "rejected" or an API rate_limit error) */
  limited?: boolean;
  /** the latest rate limit report seen in the turn */
  rateLimit?: RateLimitReport;
}

/** A plan usage report from the CLI (claude.ai subscription logins). */
export interface RateLimitReport {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  /** epoch ms */
  resetsAt?: number;
  type?: string;
  /** 0-1 */
  utilization?: number;
}

const LIMIT_RE = /usage limit|rate[ _-]?limit/i;

/**
 * A turn's error text that reports the plan's usage limit ("Claude AI usage limit reached|1759500000",
 * "rate_limit_error"): whether it is one, and when it resets if the text says.
 */
export function limitFromText(text: string): { limited: boolean; resetsAt?: number } {
  if (!LIMIT_RE.test(text)) return { limited: false };
  const at = resetsAtMs(Number(/\|(\d{9,13})\b/.exec(text)?.[1]));
  return at ? { limited: true, resetsAt: at } : { limited: true };
}

/** resetsAt arrives in epoch seconds; accept ms too. */
export function resetsAtMs(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return v < 1e12 ? v * 1000 : v;
}

interface Block {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  is_error?: boolean;
  content?: unknown;
}

/** The one argument worth logging for a tool call. */
function toolArg(input: Record<string, unknown>): string {
  for (const k of ['command', 'file_path', 'pattern', 'path', 'url', 'query', 'step']) if (typeof input[k] === 'string') return input[k] as string;
  return '';
}

export class StreamMapper {
  readonly stats: TurnStats = { isError: false, errors: [] };

  constructor(
    private log: Logger,
    private label: string,
    /** live usage reports, so the designer can react while the turn is still running */
    private onRateLimit?: (r: RateLimitReport) => void,
  ) {}

  handle(msg: SDKMessage): void {
    const id = this.label;
    switch (msg.type) {
      case 'system': {
        const m = msg as { subtype?: string; session_id?: string; model?: string; tool_name?: string; decision_reason?: string; message?: string };
        if (m.subtype === 'init' && m.session_id) {
          this.stats.sessionId = m.session_id;
          this.log.debug(`${id}: session ${m.session_id} (${m.model ?? '?'})`);
        } else if (m.subtype === 'permission_denied') {
          this.log.info(`${id}: denied ${m.tool_name ?? 'tool'}${m.decision_reason ?? m.message ? ` (${truncate(m.decision_reason ?? m.message ?? '', 160)})` : ''}`);
        }
        break;
      }
      case 'assistant': {
        if (msg.parent_tool_use_id) break;
        if (msg.error) {
          const err = String(msg.error);
          this.stats.errors.push(err);
          if (AUTH_ERRORS.has(err)) this.stats.authFailed = err;
          if (err === 'rate_limit') this.stats.limited = true;
          this.log.warn(`${id}: API error: ${err}`);
        }
        this.stats.sessionId ??= msg.session_id;
        for (const b of (msg.message?.content ?? []) as Block[]) {
          if (b.type === 'text' && b.text?.trim()) this.log.debug(`${id}: ${truncate(b.text.trim().replace(/\s+/g, ' '), 300)}`);
          else if (b.type === 'tool_use' && b.name) {
            const arg = b.input && typeof b.input === 'object' ? toolArg(b.input as Record<string, unknown>) : '';
            this.log.info(`${id}: ${b.name}${arg ? ` ${truncate(arg.replace(/\s+/g, ' '), 160)}` : ''}`);
          }
        }
        break;
      }
      case 'user': {
        if (msg.parent_tool_use_id) break;
        const content = (msg.message as { content?: unknown }).content;
        if (!Array.isArray(content)) break;
        for (const b of content as Block[]) {
          if (b.type === 'tool_result' && b.is_error) {
            const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Array<{ text?: string }>).map((c) => c.text ?? '').join(' ') : '';
            this.log.debug(`${id}: tool error: ${truncate(text.replace(/\s+/g, ' '), 300)}`);
          }
        }
        break;
      }
      case 'result': {
        this.stats.subtype = msg.subtype;
        this.stats.isError = msg.is_error || msg.subtype !== 'success';
        this.stats.costUsd = msg.total_cost_usd;
        this.stats.numTurns = msg.num_turns;
        this.stats.sessionId ??= msg.session_id;
        if (msg.subtype === 'success') {
          this.stats.resultText = msg.result;
          if (msg.is_error && isAuthText(msg.result)) this.stats.authFailed = firstLine(msg.result, 200);
        } else {
          this.stats.errors.push(...(msg.errors ?? []));
          const joined = (msg.errors ?? []).join(' ');
          if (isAuthText(joined)) this.stats.authFailed = firstLine(joined, 200);
        }
        if (this.stats.isError) {
          const l = limitFromText([this.stats.resultText ?? (msg.subtype === 'success' ? msg.result : ''), ...this.stats.errors].join(' '));
          if (l.limited) {
            this.stats.limited = true;
            if (l.resetsAt && !this.stats.rateLimit?.resetsAt) this.stats.rateLimit = { status: 'rejected', resetsAt: l.resetsAt };
          }
        }
        const cost = typeof msg.total_cost_usd === 'number' ? ` · $${msg.total_cost_usd.toFixed(3)}` : '';
        this.log.info(`${id}: turn ${msg.subtype === 'success' && !msg.is_error ? 'complete' : `ended: ${msg.subtype}`} (${msg.num_turns} steps${cost})`);
        break;
      }
      default: {
        const t = (msg as { type: string }).type;
        if (t === 'rate_limit_event') {
          const info = (msg as { rate_limit_info?: { status?: string; utilization?: number; rateLimitType?: string; resetsAt?: number } }).rate_limit_info;
          if (info?.status === 'allowed' || info?.status === 'allowed_warning' || info?.status === 'rejected') {
            const r: RateLimitReport = { status: info.status };
            const at = resetsAtMs(info.resetsAt);
            if (at) r.resetsAt = at;
            if (info.rateLimitType) r.type = info.rateLimitType;
            if (typeof info.utilization === 'number') r.utilization = info.utilization;
            this.stats.rateLimit = r;
            if (r.status === 'rejected') this.stats.limited = true;
            this.onRateLimit?.(r);
          }
          if (info?.status === 'rejected') this.log.warn(`${id}: rate limited (${info.rateLimitType ?? 'limit'})`);
        }
        if (t === 'auth_status') {
          const m = msg as { error?: string };
          // (a token refresh that failed on the network is not a bad login)
          if (m.error && (isAuthText(m.error) || !isNetworkText(m.error))) this.stats.authFailed = m.error;
        }
      }
    }
  }
}
