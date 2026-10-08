// Auth mode (ported from AgentCraft's claude-auth.test.ts): API key / cloud provider by default; the
// claude.ai CLI login only with --use-claude-login / useClaudeLogin. Plus Architect's key from the
// in-game settings, the status line, and the SDK being absent.
import { afterEach, describe, expect, it } from 'vitest';
import { authEnv, authSourceOf, detectApiAuth, withAuthMode, ARCHITECT_NO_API_AUTH_MESSAGE } from '../src/claude/auth.js';
import { ClaudeDesigner } from '../src/claude/designer.js';
import { setSdkLoaderForTests } from '../src/claude/sdk.js';
import { classifyFailure, probeFailure } from '../src/claude/failures.js';
import { fillLoginEnv, noLoginMessage } from '../src/claude/loginenv.js';
import { makeSidecar, until, type Harness } from './helpers.js';

describe('detectApiAuth / withAuthMode (as AgentCraft)', () => {
  it('finds an API key, a cloud provider switch or a gateway, and nothing else', () => {
    expect(detectApiAuth({ ANTHROPIC_API_KEY: 'sk-ant-x' })).toEqual({ ok: true, source: 'API key' });
    expect(detectApiAuth({ CLAUDE_CODE_USE_BEDROCK: '1' })).toEqual({ ok: true, source: 'Amazon Bedrock' });
    expect(detectApiAuth({ CLAUDE_CODE_USE_VERTEX: 'true' })).toEqual({ ok: true, source: 'Google Vertex AI' });
    expect(detectApiAuth({ CLAUDE_CODE_USE_BEDROCK: '0' })).toEqual({ ok: false });
    expect(detectApiAuth({ ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://gw' })).toEqual({ ok: true, source: 'API gateway' });
    expect(detectApiAuth({ ANTHROPIC_API_KEY: '  ', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' })).toEqual({ ok: false });
  });

  it('drops the claude.ai login token from agent processes unless opted in', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth', ANTHROPIC_API_KEY: 'k' };
    expect(withAuthMode(env, false)).toEqual({ ANTHROPIC_API_KEY: 'k' });
    expect(withAuthMode(env, true)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth' });
  });

  it('under --use-claude-login strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN (any case), keeps the rest', () => {
    const env = { ANTHROPIC_API_KEY: 'k', anthropic_auth_token: 't', ANTHROPIC_BASE_URL: 'https://gw', PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1' };
    const out = withAuthMode(env, true);
    expect(out).toEqual({ ANTHROPIC_BASE_URL: 'https://gw', PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1' });
    expect(JSON.stringify(out)).not.toContain('"k"');
  });
});

describe('the key from the in-game settings', () => {
  it('fills in for a missing ANTHROPIC_API_KEY in API mode only; the environment wins', () => {
    expect(authEnv({ PATH: '/bin' }, { useClaudeLogin: false, storedKey: 'stored' })).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'stored' });
    expect(authEnv({ ANTHROPIC_API_KEY: 'env' }, { useClaudeLogin: false, storedKey: 'stored' })).toEqual({ ANTHROPIC_API_KEY: 'env' });
    expect(authEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'o' }, { useClaudeLogin: true, storedKey: 'stored' })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'o' });
  });

  it('names the source for the status line', () => {
    expect(authSourceOf({}, { useClaudeLogin: false })).toEqual({ ok: false });
    expect(authSourceOf({}, { useClaudeLogin: false, storedKey: 'k' })).toEqual({ ok: true, source: 'API key' });
    expect(authSourceOf({ ANTHROPIC_API_KEY: 'k' }, { useClaudeLogin: false, storedKey: 'k2' })).toEqual({ ok: true, source: 'API key (environment)' });
    expect(authSourceOf({ CLAUDE_CODE_USE_BEDROCK: '1' }, { useClaudeLogin: false })).toEqual({ ok: true, source: 'Amazon Bedrock' });
    expect(authSourceOf({}, { useClaudeLogin: true })).toEqual({ ok: true, source: 'claude login (personal use)' });
  });
});

describe('ClaudeDesigner.checkAuth', () => {
  let h: Harness | undefined;
  const saved = { key: process.env.ANTHROPIC_API_KEY, bedrock: process.env.CLAUDE_CODE_USE_BEDROCK, base: process.env.ANTHROPIC_BASE_URL };
  afterEach(async () => {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.bedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
    else process.env.CLAUDE_CODE_USE_BEDROCK = saved.bedrock;
    if (saved.base === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved.base;
    setSdkLoaderForTests(undefined);
    await h?.close();
    h = undefined;
  });
  const clean = () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
  };

  let queried = 0;
  let accountInfo: () => Promise<Record<string, unknown>> = async () => ({ email: 'x@example.com', organization: 'Acme', subscriptionType: 'max' });
  const fakeQuery = () => {
    queried++;
    return { close() {}, accountInfo: () => accountInfo() };
  };

  it('without an API key (and no opt-in): missing, and never touches the CLI login', async () => {
    clean();
    h = makeSidecar();
    queried = 0;
    const b = new ClaudeDesigner(h.sc, { queryFn: fakeQuery as never });
    expect(await b.checkAuth()).toBe(false);
    expect(queried).toBe(0);
    expect(h.sc.status()).toMatchObject({ auth: 'missing', useClaudeLogin: false, message: ARCHITECT_NO_API_AUTH_MESSAGE });
  });

  it('with ANTHROPIC_API_KEY it checks access and reports the source', async () => {
    clean();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    h = makeSidecar();
    queried = 0;
    const checked: string[] = [];
    const b = new ClaudeDesigner(h.sc, { queryFn: fakeQuery as never, keyCheck: async (k) => (checked.push(k), 'ok') });
    expect(await b.checkAuth()).toBe(true);
    expect(queried).toBe(1);
    expect(checked).toEqual(['sk-ant-test']);
    expect(h.sc.status()).toMatchObject({ auth: 'ok', authSource: 'API key (environment)', sdk: 'ready', message: 'Acme' });
  });

  it('a key set in game (auth.set) is checked right away against the API; a bad one fails, clearing it goes back to missing', async () => {
    clean();
    h = makeSidecar();
    // the CLI finds any key; the API decides whether it is valid
    const b = new ClaudeDesigner(h.sc, { queryFn: fakeQuery as never, keyCheck: async (k) => (k === 'sk-ant-good' ? 'ok' : 'invalid') });
    await h.sc.start(b);
    expect(h.sc.status().auth).toBe('missing');
    await h.sc.handle({ v: 1, type: 'auth.set', apiKey: 'sk-ant-bad' }, () => undefined);
    await until(() => h!.sc.status().auth === 'failed');
    expect(h.sc.status()).toMatchObject({ auth: 'failed', authSource: 'API key' });
    expect(h.sc.status().message).toMatch(/Claude API check failed: Invalid API key/);
    expect(h.sc.status().message).not.toContain('sk-ant-bad');
    expect(() => h!.sc.requestDesign({ type: 'cabin', style: 'x', features: [], maxSize: { x: 10, y: 10, z: 10 } })).toThrow(/Claude is not available/);
    await h.sc.handle({ v: 1, type: 'auth.set', apiKey: 'sk-ant-good' }, () => undefined);
    await until(() => h!.sc.status().auth === 'ok');
    await h.sc.handle({ v: 1, type: 'auth.set', apiKey: null }, () => undefined);
    await until(() => h!.sc.status().auth === 'missing');
  });

  it('the key check failing on the network is not a bad key: checking, then retried', async () => {
    clean();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    h = makeSidecar();
    let up = false;
    const b = new ClaudeDesigner(h.sc, { queryFn: fakeQuery as never, authRetryMs: 100, keyCheck: async () => (up ? 'ok' : { unreachable: 'fetch failed' }) });
    expect(await b.checkAuth()).toBe(false);
    expect(h.sc.status()).toMatchObject({ auth: 'checking' });
    expect(h.sc.status().message).toMatch(/could not be reached \(fetch failed\)/);
    up = true;
    await until(() => h!.sc.status().auth === 'ok', 5000);
    await b.stop();
  });

  it('no key check for a gateway, a cloud provider or the login', async () => {
    clean();
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    h = makeSidecar();
    const b = new ClaudeDesigner(h.sc, { queryFn: fakeQuery as never, keyCheck: async () => 'invalid' });
    expect(await b.checkAuth()).toBe(true);
    expect(h.sc.status()).toMatchObject({ auth: 'ok', authSource: 'Amazon Bedrock' });
  });

  it('a network failure is not a bad key: it stays checking and retries', async () => {
    clean();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    h = makeSidecar();
    let fail = true;
    accountInfo = async () => {
      if (fail) throw new Error('fetch failed: ECONNREFUSED');
      return { organization: 'Acme' };
    };
    const b = new ClaudeDesigner(h.sc, { queryFn: fakeQuery as never, authRetryMs: 100, keyCheck: async () => 'ok' });
    expect(await b.checkAuth()).toBe(false);
    expect(h.sc.status().auth).toBe('checking');
    expect(h.sc.status().message).toMatch(/could not be reached/);
    fail = false;
    await until(() => h!.sc.status().auth === 'ok', 5000);
    await b.stop();
    accountInfo = async () => ({ email: 'x@example.com', organization: 'Acme', subscriptionType: 'max' });
  });

  it('--use-claude-login uses the CLI login (personal use) even without a key', async () => {
    clean();
    h = makeSidecar(['--use-claude-login']);
    const b = new ClaudeDesigner(h.sc, { queryFn: fakeQuery as never });
    expect(await b.checkAuth()).toBe(true);
    expect(h.sc.status()).toMatchObject({ auth: 'ok', useClaudeLogin: true, authSource: 'claude login (personal use)', message: 'Acme · max' });
  });

  it('without the SDK installed: status still serves (sdk missing), designs wait', async () => {
    clean();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    h = makeSidecar();
    setSdkLoaderForTests(async () => undefined);
    const b = new ClaudeDesigner(h.sc);
    expect(await b.checkAuth()).toBe(false);
    expect(h.sc.status()).toMatchObject({ auth: 'checking', sdk: 'missing' });
    expect(h.sc.status().message).toMatch(/Waiting for the Claude Agent SDK/);
    await b.stop();
  });
});

describe('(5b F2) the claude login without USER/LOGNAME', () => {
  const os = () => ({ username: 'noah', homedir: '/Users/noah' });

  it('fills USER and LOGNAME from the OS user, HOME from its home dir, only where unset or empty', () => {
    const env: Record<string, string | undefined> = { PATH: '/bin', HOME: '/Users/noah' };
    expect(fillLoginEnv(env, os)).toEqual({ filled: ['USER', 'LOGNAME'], name: 'noah' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/Users/noah', USER: 'noah', LOGNAME: 'noah' });
    const scrubbed: Record<string, string | undefined> = { USER: '' };
    expect(fillLoginEnv(scrubbed, os)).toEqual({ filled: ['HOME', 'USER', 'LOGNAME'], name: 'noah' });
    expect(scrubbed).toMatchObject({ HOME: '/Users/noah', USER: 'noah', LOGNAME: 'noah' });
    // nothing missing: nothing changes
    const full = { USER: 'a', LOGNAME: 'a', HOME: '/h' };
    expect(fillLoginEnv(full, os)).toEqual({ filled: [] });
    expect(full).toEqual({ USER: 'a', LOGNAME: 'a', HOME: '/h' });
    // no OS user name (no passwd entry): the basename of HOME
    const e2: Record<string, string | undefined> = { HOME: '/home/steve' };
    expect(fillLoginEnv(e2, () => ({}))).toEqual({ filled: ['USER', 'LOGNAME'], name: 'steve' });
  });

  it('the no-login message names the user and HOME, says when the sidecar filled a variable, and stays an auth failure', () => {
    expect(noLoginMessage({ USER: 'noah', HOME: '/Users/noah' }, { filled: [] })).toBe(
      'The claude CLI found no login (user noah, HOME /Users/noah). Log in by running `claude` and `/login` in a terminal as this user. If Minecraft starts from a scrubbed environment, keep HOME, USER and LOGNAME.',
    );
    expect(noLoginMessage({ USER: 'noah', HOME: '/Users/noah' }, { filled: ['USER', 'LOGNAME'], name: 'noah' })).toMatch(/\(The sidecar filled in USER, LOGNAME from the OS: noah\.\)$/);
    expect(probeFailure('not logged in')).toBe('auth');
    expect(classifyFailure({ authFailed: 'not logged in', errors: [], isError: true } as never)).toBe('auth');
  });

  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });
  const noLogin = () => ({ close() {}, accountInfo: async () => ({ apiKeySource: 'none', tokenSource: 'none' }) });

  it('login mode, no login found, a variable filled: auth failed with the new message (account info injected)', async () => {
    h = makeSidecar(['--use-claude-login']);
    const env: Record<string, string | undefined> = { HOME: '/Users/noah', PATH: '/bin' };
    const b = new ClaudeDesigner(h.sc, { queryFn: noLogin as never, loginEnv: { env, userInfo: os } });
    expect(await b.checkAuth()).toBe(false);
    expect(env.USER).toBe('noah');
    expect(env.LOGNAME).toBe('noah');
    expect(h.sc.status().auth).toBe('failed');
    expect(h.sc.status().message).toBe(
      'The claude CLI found no login (user noah, HOME /Users/noah). Log in by running `claude` and `/login` in a terminal as this user. If Minecraft starts from a scrubbed environment, keep HOME, USER and LOGNAME. (The sidecar filled in USER, LOGNAME from the OS: noah.)',
    );
    expect(h.log.lines.some((l) => /USER\/LOGNAME were unset; using noah from the OS/.test(l))).toBe(true);
    expect(b.blocked()).toMatch(/found no login/);
  });

  it('login mode, no login found, nothing filled: the message without the note', async () => {
    h = makeSidecar(['--use-claude-login']);
    const env: Record<string, string | undefined> = { HOME: '/Users/noah', USER: 'noah', LOGNAME: 'noah' };
    const b = new ClaudeDesigner(h.sc, { queryFn: noLogin as never, loginEnv: { env, userInfo: os } });
    expect(await b.checkAuth()).toBe(false);
    expect(h.sc.status()).toMatchObject({ auth: 'failed' });
    expect(h.sc.status().message).toMatch(/^The claude CLI found no login \(user noah, HOME \/Users\/noah\)\..*keep HOME, USER and LOGNAME\.$/);
    expect(h.log.lines.some((l) => /were unset/.test(l))).toBe(false);
  });

  it('login mode with a login: the fill happens before the probe and the CLI env carries it', async () => {
    h = makeSidecar(['--use-claude-login']);
    const env: Record<string, string | undefined> = { HOME: '/Users/noah' };
    let seen: Record<string, string | undefined> | undefined;
    const q = (o: { options: { env: Record<string, string | undefined> } }) => {
      seen = { ...env };
      void o;
      return { close() {}, accountInfo: async () => ({ email: 'x@example.com', organization: 'Acme' }) };
    };
    const b = new ClaudeDesigner(h.sc, { queryFn: q as never, loginEnv: { env, userInfo: os } });
    expect(await b.checkAuth()).toBe(true);
    expect(seen).toMatchObject({ USER: 'noah', LOGNAME: 'noah' });
  });
});
