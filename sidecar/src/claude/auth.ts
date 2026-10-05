// How the agents authenticate with Claude.
//
// Default: API authentication, the way Anthropic's Agent SDK docs require for third-party tools:
// ANTHROPIC_API_KEY, or a cloud provider (Amazon Bedrock, Google Vertex, Microsoft Foundry, Claude
// Platform on AWS). The user's claude.ai login (the `claude` CLI's subscription/OAuth session) is
// only used when explicitly opted into with --use-claude-login, for one's own personal use:
// "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai
// login or rate limits for their products" (https://code.claude.com/docs/en/agent-sdk/overview).

/** Env switches the Agent SDK / Claude Code CLI read to use a cloud provider instead of the Claude API. */
export const PROVIDER_SWITCHES: Record<string, string> = {
  CLAUDE_CODE_USE_BEDROCK: 'Amazon Bedrock',
  CLAUDE_CODE_USE_VERTEX: 'Google Vertex AI',
  CLAUDE_CODE_USE_FOUNDRY: 'Microsoft Foundry',
  CLAUDE_CODE_USE_ANTHROPIC_AWS: 'Claude Platform on AWS',
};

/** Variables that carry a claude.ai (subscription) login into the CLI; removed unless opted in. */
export const CLAUDE_LOGIN_VARS = ['CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * Variables that make the CLI bill an API key / gateway instead of the claude.ai login; removed
 * under --use-claude-login (a key left in the shell would silently bypass the login and its plan).
 */
export const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export type ApiAuth = { ok: true; source: string } | { ok: false };

const truthy = (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false';

/** Which API authentication the environment provides, if any. */
export function detectApiAuth(env: NodeJS.ProcessEnv = process.env): ApiAuth {
  if (env.ANTHROPIC_API_KEY?.trim()) return { ok: true, source: 'API key' };
  for (const [k, name] of Object.entries(PROVIDER_SWITCHES)) if (truthy(env[k])) return { ok: true, source: name };
  if (env.ANTHROPIC_AUTH_TOKEN?.trim() && env.ANTHROPIC_BASE_URL?.trim()) return { ok: true, source: 'API gateway' };
  return { ok: false };
}

/**
 * The environment for agent CLI processes: in API mode, no claude.ai login token is passed on (the
 * CLI then authenticates with the key/provider); with --use-claude-login no API key or auth token
 * is passed on (the CLI then uses the login). Applied to the FINAL environment (after repoSettings
 * env), so a repository cannot bring a key back in. The values are never logged.
 */
export function withAuthMode(env: Record<string, string | undefined>, useClaudeLogin: boolean): Record<string, string | undefined> {
  const out = { ...env };
  const drop = useClaudeLogin ? API_KEY_VARS : CLAUDE_LOGIN_VARS;
  for (const k of Object.keys(out)) if (drop.includes(k.toUpperCase())) delete out[k];
  return out;
}

export const NO_API_AUTH_MESSAGE =
  'No Claude API key. Set ANTHROPIC_API_KEY (from console.anthropic.com) or a cloud provider ' +
  '(CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY), then restart the Foreman. For your own personal ' +
  'use only, --use-claude-login uses your claude.ai login instead. The sim backend works without either.';

// ---- Architect additions ----------------------------------------------------------------------
// Where the key comes from (docs/CONTRACT.md "Sidecar process"): ANTHROPIC_API_KEY from the
// environment, else the key from the in-game settings (<data>/secrets.json), else a cloud-provider
// switch. The claude.ai login only with --use-claude-login / useClaudeLogin, for personal use.

export const ARCHITECT_NO_API_AUTH_MESSAGE =
  'No Claude API key. Enter one in the Status tab (from console.anthropic.com), or set ANTHROPIC_API_KEY ' +
  'or a cloud provider (CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY) before starting the game. For your own ' +
  'personal use only, "Use my Claude login" uses your local `claude` login instead.';

export interface AuthInputs {
  /** --use-claude-login, or useClaudeLogin in secrets.json */
  useClaudeLogin: boolean;
  /** the key from secrets.json */
  storedKey?: string | undefined;
}

/**
 * The environment the design agent's CLI gets for authentication: the stored key fills in for a
 * missing ANTHROPIC_API_KEY (API mode only), then withAuthMode drops what the mode must not use.
 */
export function authEnv(base: Record<string, string | undefined>, a: AuthInputs): Record<string, string | undefined> {
  const env = { ...base };
  if (!a.useClaudeLogin && !env.ANTHROPIC_API_KEY?.trim() && a.storedKey) env.ANTHROPIC_API_KEY = a.storedKey;
  return withAuthMode(env, a.useClaudeLogin);
}

/** The Anthropic API key design turns will use, when that is the auth (not a gateway, provider or login). */
export function directApiKey(base: NodeJS.ProcessEnv, a: AuthInputs): string | undefined {
  if (a.useClaudeLogin || base.ANTHROPIC_BASE_URL?.trim()) return undefined;
  return base.ANTHROPIC_API_KEY?.trim() || a.storedKey || undefined;
}

export type KeyCheck = (key: string) => Promise<'ok' | 'invalid' | { unreachable: string }>;

/**
 * Is this API key valid? The CLI's account info only says that it found a key, so the sidecar asks
 * the API itself: GET /v1/models (free; the key travels only in its header). 401/403 = invalid;
 * a network error or a 5xx = unreachable (retried later).
 */
export const checkApiKey: KeyCheck = async (key) => {
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) return 'invalid';
    if (res.ok) return 'ok';
    return { unreachable: `HTTP ${res.status}` };
  } catch (e) {
    return { unreachable: (e as Error).message || 'network error' };
  }
};

/** What authenticates design turns, for the status line (ok false = nothing). */
export function authSourceOf(base: NodeJS.ProcessEnv, a: AuthInputs): { ok: boolean; source?: string } {
  if (a.useClaudeLogin) return { ok: true, source: 'claude login (personal use)' };
  if (base.ANTHROPIC_API_KEY?.trim()) return { ok: true, source: 'API key (environment)' };
  if (a.storedKey) return { ok: true, source: 'API key' };
  const api = detectApiAuth(base);
  return api.ok ? { ok: true, source: api.source } : { ok: false };
}
