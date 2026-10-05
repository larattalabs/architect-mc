// The Claude designer with a scripted fake `query()` (no API calls): the fake designer writes a
// design module into its scratch dir; the sidecar re-checks it with a pristine kit, renders and
// installs it into the library without overwriting anything. Also: the turn's options (env, PATH,
// tools, hooks), the permission refusals, fix rounds, cancel, the usage-limit hold, and resuming
// the session after a restart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookInput, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeDesigner } from '../src/claude/designer.js';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import type { Design, Outbound } from '../src/protocol.js';
import { DesignRequest } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { Store } from '../src/store.js';
import { makeSidecar, request, rmrf, tempDir, copyKit, until, type Harness } from './helpers.js';

type ToolServer = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } };
async function callTool(options: Options, name: string, args: Record<string, unknown>): Promise<string> {
  const server = options.mcpServers!.architect as unknown as ToolServer;
  const res = await server.instance._registeredTools[name]!.handler(args, {});
  return res.content.map((c) => c.text).join('\n');
}

let n = 0;
const sid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const msg = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: sid(), ...o }) as unknown as SDKMessage;
const init = (s: string) => msg({ type: 'system', subtype: 'init', session_id: s, model: 'fake', cwd: '', tools: [] });
const toolUse = (s: string, name: string, input: Record<string, unknown>) => msg({ type: 'assistant', session_id: s, message: { content: [{ type: 'tool_use', id: `tu${n}`, name, input }] } });
const ok = (s: string, text = 'A cosy cabin, 9x7x9.') => msg({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 4, total_cost_usd: 0.02, session_id: s, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });

type Script = (prompt: string, opts: Options) => AsyncGenerator<SDKMessage>;
interface Call {
  prompt: string;
  opts: Options;
}

function fakeQuery(script: () => Script, calls: Call[]) {
  return ({ prompt, options }: { prompt: string; options: Options }) => {
    calls.push({ prompt: String(prompt), opts: options });
    const it = script()(String(prompt), options);
    return Object.assign(it, { close() {}, accountInfo: async () => ({ email: 'x' }) });
  };
}

/** The design id the prompt / brief asks for. */
const bpOf = (text: string) => /kit\/designs\/(gen_[a-z0-9_]+)\.mjs/.exec(text)?.[1];

/** What the fake designer writes: a small cabin under the new id. */
function writeDesign(cwd: string, bp: string, size = { x: 9, y: 7, z: 9 }, type = 'cabin'): void {
  fs.writeFileSync(path.join(cwd, 'kit', 'designs', `${bp}.mjs`), `import { blueprint } from '../lib/kit.mjs';\nexport const id = '${bp}';\nexport default () => blueprint({ id, name: 'X', type: '${type}', size: ${JSON.stringify(size)} });\n`);
}

const canUse = (opts: Options, tool: string, input: Record<string, unknown>) => opts.canUseTool!(tool, input, { signal: new AbortController().signal, toolUseID: 'x', requestId: 'r' } as never) as Promise<{ behavior: string; message?: string }>;

async function runHooks(opts: Options, tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string[]> {
  const out: string[] = [];
  for (const m of opts.hooks!.PreToolUse!) {
    for (const hook of m.hooks) {
      const r = (await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, session_id: 's', transcript_path: '', cwd: opts.cwd!, tool_use_id: 't', ...extra } as unknown as HookInput, 't', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
      if (r.hookSpecificOutput?.permissionDecision) out.push(r.hookSpecificOutput.permissionDecision);
    }
  }
  return out;
}

describe('Claude designer (fake SDK)', () => {
  let h: Harness;
  let calls: Call[];
  let script: Script;

  beforeAll(async () => {
    calls = [];
    h = makeSidecar(['--backend', 'claude']);
    h.sc.config.claude.designModel = 'fake-designer';
    h.sc.endpoint = { port: 7890, tokenFile: path.join(h.cfg.dataDir, 'client.token') };
    const designer = new ClaudeDesigner(h.sc, { queryFn: fakeQuery(() => script, calls) as never, skipAuthCheck: true });
    // an API key from the in-game settings (skipAuthCheck: no probe)
    h.sc.setAuthSettings('sk-ant-stored-key', undefined);
    await h.sc.start(designer);
  });
  afterAll(async () => {
    await h.close();
  });
  afterEach(() => {
    calls.length = 0;
  });

  const statuses = (id: string) => h.events.filter((e): e is Extract<Outbound, { type: 'design.upsert' }> => e.type === 'design.upsert' && e.design.id === id).map((e) => e.design.status);
  const req = (over: Record<string, unknown> = {}) => DesignRequest.parse(request(over));
  const finished = (id: string) => until(() => ['done', 'failed'].includes(h.sc.designs.get(id)!.status), 30_000);

  it('designs, re-checks with a pristine kit, renders and installs without overwriting', async () => {
    fs.mkdirSync(path.join(h.cfg.libraryDir, 'gen_lakeside_cabin'), { recursive: true });
    fs.writeFileSync(path.join(h.cfg.libraryDir, 'gen_lakeside_cabin', 'gen_lakeside_cabin.nbt'), 'an older one');
    const verdicts: Record<string, { behavior: string; message?: string }> = {};
    let hooks: Record<string, string[]> = {};
    script = async function* (prompt, opts) {
      const s = sid();
      yield init(s);
      const cwd = opts.cwd!;
      yield toolUse(s, 'Read', { file_path: path.join(cwd, 'BRIEF.md') });
      const bp = bpOf(prompt)!;
      await callTool(opts, 'design_status', { step: 'sketching a cabin' });
      writeDesign(cwd, bp);
      yield toolUse(s, 'Write', { file_path: path.join(cwd, 'kit', 'designs', `${bp}.mjs`), content: '...' });
      // tampering with the kit does not help: the sidecar checks with a fresh copy
      fs.writeFileSync(path.join(cwd, 'kit', 'build.mjs'), 'process.exit(0);\n');
      verdicts.own = await canUse(opts, 'Write', { file_path: path.join(cwd, 'kit', 'designs', `${bp}.mjs`), content: 'x' });
      verdicts.ownRelative = await canUse(opts, 'Edit', { file_path: `kit/designs/${bp}.mjs`, old_string: 'a', new_string: 'b' });
      verdicts.kitFile = await canUse(opts, 'Edit', { file_path: path.join(cwd, 'kit', 'lib', 'kit.mjs'), old_string: 'a', new_string: 'b' });
      verdicts.outside = await canUse(opts, 'Write', { file_path: path.join(os.homedir(), 'architect-design-test-never-written.nbt'), content: 'x' });
      verdicts.build = await canUse(opts, 'Bash', { command: `node kit/build.mjs ${bp} --max 40,20,40 --type cabin` });
      verdicts.render = await canUse(opts, 'Bash', { command: `node kit/render.mjs kit/out/${bp}.nbt --out previews` });
      verdicts.readKit = await canUse(opts, 'Read', { file_path: path.join(cwd, 'kit', 'lib', 'kit.mjs') });
      verdicts.curl = await canUse(opts, 'Bash', { command: 'curl https://example.com' });
      verdicts.git = await canUse(opts, 'Bash', { command: 'git init && git add .' });
      verdicts.npm = await canUse(opts, 'Bash', { command: 'npm install left-pad' });
      verdicts.secrets = await canUse(opts, 'Read', { file_path: path.join(cwd, '..', '..', 'secrets.json') });
      verdicts.token = await canUse(opts, 'Bash', { command: 'cat ../../client.token' });
      verdicts.web = await canUse(opts, 'WebFetch', { url: 'https://example.com' });
      verdicts.agent = await canUse(opts, 'Agent', { prompt: 'x' });
      hooks = {
        own: await runHooks(opts, 'Write', { file_path: path.join(cwd, 'kit', 'designs', `${bp}.mjs`) }),
        kitFile: await runHooks(opts, 'Write', { file_path: path.join(cwd, 'kit', 'build.mjs') }),
        token: await runHooks(opts, 'Read', { file_path: path.join(h.cfg.dataDir, 'client.token') }),
        git: await runHooks(opts, 'Bash', { command: 'cd kit && /usr/bin/git status' }),
        mcpOwn: await runHooks(opts, 'mcp__architect__design_status', { step: 'x' }, { mcp_server: { name: 'architect', source: 'sdk' } }),
        mcpOther: await runHooks(opts, 'mcp__github__create_issue', {}, { mcp_server: { name: 'github', source: 'user' } }),
      };
      yield toolUse(s, 'Bash', { command: `node kit/build.mjs ${bp}` });
      yield ok(s);
    };
    const d = h.sc.requestDesign(req());
    await finished(d.id);
    const done = h.sc.designs.get(d.id)!;
    expect(done.status, done.error).toBe('done');
    expect(done.blueprintId).toBe('gen_lakeside_cabin_2');
    expect(fs.readFileSync(path.join(h.cfg.libraryDir, 'gen_lakeside_cabin', 'gen_lakeside_cabin.nbt'), 'utf8')).toBe('an older one');
    expect(done.size).toEqual({ x: 9, y: 7, z: 9 });
    const dir = path.join(h.cfg.libraryDir, 'gen_lakeside_cabin_2');
    expect(done.previews).toEqual(['front', 'iso', 'top'].map((v) => path.join(dir, `gen_lakeside_cabin_2.preview-${v}.png`)));
    const sc = JSON.parse(fs.readFileSync(path.join(dir, 'gen_lakeside_cabin_2.blueprint.json'), 'utf8')) as Record<string, unknown>;
    expect(sc).toMatchObject({ id: 'gen_lakeside_cabin_2', name: 'Lakeside Cabin', type: 'cabin', source: 'gen_lakeside_cabin_2.mjs', request: req() });
    expect(typeof sc.createdAt).toBe('number');
    expect(fs.readFileSync(path.join(dir, 'gen_lakeside_cabin_2.mjs'), 'utf8')).toContain("export const id = 'gen_lakeside_cabin_2'");

    // permissions: only its own design file, kit commands, no network / git / installs / private files / web / subagents
    expect(verdicts.own!.behavior).toBe('allow');
    expect(verdicts.ownRelative!.behavior).toBe('allow');
    expect(verdicts.build!.behavior).toBe('allow');
    expect(verdicts.render!.behavior).toBe('allow');
    expect(verdicts.readKit!.behavior).toBe('allow');
    for (const k of ['kitFile', 'outside', 'curl', 'git', 'npm', 'secrets', 'token', 'web', 'agent']) expect(verdicts[k]!.behavior, k).toBe('deny');
    expect(verdicts.kitFile!.message).toMatch(/Only kit\/designs\/gen_lakeside_cabin_2\.mjs is yours/);
    expect(verdicts.curl!.message).toMatch(/Nobody can approve permission prompts here/);
    expect(hooks).toEqual({ own: [], kitFile: ['deny'], token: ['deny'], git: ['deny'], mcpOwn: [], mcpOther: ['deny'] });

    // the turn: scratch dir, design model, effort, no web/subagents, only the design tool server
    expect(calls).toHaveLength(1);
    const opts = calls[0]!.opts;
    const scratch = path.join(h.cfg.dataDir, 'designs', d.id);
    expect(opts.cwd).toBe(scratch);
    expect(opts.model).toBe('fake-designer');
    expect(opts.effort).toBe('high');
    expect(opts.tools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash']));
    for (const t of ['WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill']) expect(opts.tools as string[]).not.toContain(t);
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch', 'Agent', 'Task']));
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.settingSources).toEqual([]);
    expect(opts.permissionMode).toBe('default');
    expect(Object.keys(opts.mcpServers!)).toEqual(['architect']);
    expect(opts.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
    // env: this node first on PATH, git kept in the scratch dir, the stored key, nothing secret of ours
    const env = opts.env!;
    expect(env.PATH!.split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
    expect(env.GIT_CEILING_DIRECTORIES).toBe(path.dirname(scratch));
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toMatch(/^architect-sidecar\//);
    expect(env.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY?.trim() ? process.env.ANTHROPIC_API_KEY : 'sk-ant-stored-key');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ARCHITECT_CLIENT_TOKEN).toBeUndefined();
    // the scratch dir
    const brief = fs.readFileSync(path.join(scratch, 'BRIEF.md'), 'utf8');
    expect(brief).toContain('gen_lakeside_cabin_2');
    expect(brief).toContain('x <= 40, y <= 20, z <= 40');
    expect(brief).toContain('render.mjs');
    expect(brief).toContain('porch (a covered porch');
    expect(fs.existsSync(path.join(scratch, 'CONTRACT.md'))).toBe(true);
    // the kit was restored for the check
    expect(fs.readFileSync(path.join(scratch, 'kit', 'build.mjs'), 'utf8')).not.toBe('process.exit(0);\n');

    const seq = statuses(d.id);
    expect(seq[0]).toBe('queued');
    expect(seq).toEqual(expect.arrayContaining(['designing', 'checking', 'rendering']));
    expect(seq.at(-1)).toBe('done');
    const steps = h.events.filter((e) => e.type === 'design.upsert' && e.design.id === d.id).map((e) => (e as { design: Design }).design.step);
    expect(steps).toContain('sketching a cabin');
    expect(steps).toContain('writing the design');
    // the stored key never reaches a log line or state.json
    expect(h.log.lines.join('\n')).not.toContain('sk-ant-stored-key');
    h.store.flush();
    expect(fs.readFileSync(path.join(h.cfg.dataDir, 'state.json'), 'utf8')).not.toContain('sk-ant-stored-key');
    expect(h.store.data.sessions[`design:${d.id}`]).toMatchObject({ turns: 4, costUsd: 0.02 });
  });

  it('a failed check goes back to the designer in the same session; then it passes', async () => {
    const sessions: string[] = [];
    script = async function* (prompt, opts) {
      const s = opts.resume ?? sid();
      sessions.push(s);
      yield init(s);
      if (prompt.startsWith('The sidecar re-checked')) writeDesign(opts.cwd!, bpOf(prompt)!);
      yield ok(s, 'done (I think)');
    };
    const d = h.sc.requestDesign(req({ name: 'Second Try' }));
    await finished(d.id);
    expect(h.sc.designs.get(d.id)!.status).toBe('done');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toMatch(/there is no kit\/designs\/gen_second_try\.mjs/);
    expect(calls[1]!.opts.resume).toBe(sessions[0]);
  });

  it('a design too big or of the wrong type is sent back with the checker problem', async () => {
    script = async function* (prompt, opts) {
      const s = opts.resume ?? sid();
      yield init(s);
      if (!prompt.startsWith('The sidecar re-checked')) writeDesign(opts.cwd!, bpOf(prompt)!, { x: 30, y: 7, z: 9 }, 'barn');
      else writeDesign(opts.cwd!, bpOf(prompt)!, { x: 9, y: 7, z: 9 }, 'barn');
      yield ok(s);
    };
    const d = h.sc.requestDesign(req({ name: 'Tiny Plot', maxSize: { x: 20, y: 20, z: 20 } }));
    await until(() => calls.length >= 3);
    expect(calls[1]!.prompt).toMatch(/exceeds --max 20x20x20/);
    expect(calls[2]!.prompt).toMatch(/type is barn, expected cabin/);
    h.sc.cancelDesign(d.id);
    await until(() => h.sc.designs.get(d.id)!.status === 'cancelled');
    await until(() => !h.sc.status().designing);
  });

  it('gives up after the last round with the checker output', async () => {
    script = async function* (_prompt, opts) {
      const s = opts.resume ?? sid();
      yield init(s);
      yield ok(s);
    };
    const d = h.sc.requestDesign(req({ name: 'Never' }));
    await finished(d.id);
    expect(h.sc.designs.get(d.id)!.status).toBe('failed');
    expect(h.sc.designs.get(d.id)!.error).toMatch(/there is no/);
    expect(calls).toHaveLength(4);
    expect(fs.existsSync(path.join(h.cfg.libraryDir, 'gen_never'))).toBe(false);
  });

  it('cancel stops the running turn and drops the queued one; nothing lands in the library', async () => {
    let aborted = 0;
    script = async function* (prompt, opts) {
      const s = sid();
      yield init(s);
      writeDesign(opts.cwd!, bpOf(prompt)!);
      await new Promise<void>((resolve) => opts.abortController!.signal.addEventListener('abort', () => resolve(), { once: true }));
      aborted++;
      yield ok(s);
    };
    const before = fs.readdirSync(h.cfg.libraryDir).sort();
    const a = h.sc.requestDesign(req({ name: 'Cancel Me' }));
    const b = h.sc.requestDesign(req({ name: 'Queued Too' }));
    await until(() => calls.length === 1 && h.sc.designs.get(a.id)!.status === 'designing');
    expect(h.sc.designs.get(b.id)!.status).toBe('queued');
    expect(h.sc.status()).toMatchObject({ designing: a.id, queued: 1 });
    h.sc.cancelDesign(b.id);
    h.sc.cancelDesign(a.id);
    await until(() => aborted === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.sc.designs.get(a.id)!.status).toBe('cancelled');
    expect(h.sc.designs.get(b.id)!.status).toBe('cancelled');
    expect(calls).toHaveLength(1);
    expect(fs.readdirSync(h.cfg.libraryDir).sort()).toEqual(before);
  });

  it('a usage limit puts the job back in the queue; it resumes the session after the reset', async () => {
    const at: number[] = [];
    let resetAt = 0;
    script = async function* (_prompt, opts) {
      const s = opts.resume ?? sid();
      at.push(Date.now());
      yield init(s);
      if (at.length === 1) {
        resetAt = Date.now() + 300;
        yield msg({ type: 'rate_limit_event', session_id: s, rate_limit_info: { status: 'rejected', resetsAt: resetAt, rateLimitType: 'five_hour' } });
        yield msg({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached', num_turns: 1, total_cost_usd: 0, session_id: s, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });
        return;
      }
      writeDesign(opts.cwd!, bpOf(fs.readFileSync(path.join(opts.cwd!, 'BRIEF.md'), 'utf8'))!);
      yield ok(s);
    };
    const d = h.sc.requestDesign(req({ name: 'Limited' }));
    await until(() => h.sc.designs.get(d.id)!.status === 'queued' && h.sc.designs.get(d.id)!.step.startsWith('usage limit'));
    expect(h.sc.status().usageLimitUntil).toBe(resetAt);
    await finished(d.id);
    expect(h.sc.designs.get(d.id)!.status).toBe('done');
    expect(at[1]!).toBeGreaterThanOrEqual(resetAt);
    expect(calls[1]!.opts.resume).toBeDefined();
    expect(calls[1]!.prompt).toMatch(/sidecar restarted/);
    expect(h.sc.status().usageLimitUntil).toBeUndefined();
  });
});

describe('Claude designer across a restart', () => {
  it('a design interrupted by a shutdown resumes its session on the next start', async () => {
    const root = tempDir();
    const kit = copyKit(root);
    const args = ['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', kit];
    const calls: Call[] = [];
    let script: Script = async function* (_prompt, opts) {
      yield init('11111111-1111-4111-8111-111111111111');
      await new Promise<void>((resolve) => opts.abortController!.signal.addEventListener('abort', () => resolve(), { once: true }));
    };
    const boot = async () => {
      const cfg = loadConfig(args, {});
      const store = new Store(cfg.dataDir, { debounceMs: 5 });
      const sc = new Sidecar(cfg, store, memoryLogger());
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      await sc.start(new ClaudeDesigner(sc, { queryFn: fakeQuery(() => script, calls) as never, skipAuthCheck: true }));
      return sc;
    };
    try {
      process.env.CLAUDE_CODE_USE_BEDROCK = '1'; // some API auth, so the designer may start
      let sc = await boot();
      const d = sc.requestDesign(DesignRequest.parse(request({ name: 'Survivor' })));
      await until(() => calls.length === 1);
      await sc.close();
      expect(sc.designs.get(d.id)!.status).toBe('designing');
      script = async function* (prompt, opts) {
        yield init(opts.resume!);
        writeDesign(opts.cwd!, bpOf(fs.readFileSync(path.join(opts.cwd!, 'BRIEF.md'), 'utf8'))!);
        yield ok(opts.resume!);
      };
      sc = await boot();
      await until(() => ['done', 'failed'].includes(sc.designs.get(d.id)!.status), 30_000);
      expect(sc.designs.get(d.id)!.status).toBe('done');
      expect(calls[1]!.opts.resume).toBe('11111111-1111-4111-8111-111111111111');
      expect(calls[1]!.prompt).toMatch(/sidecar restarted/);
      await sc.close();
    } finally {
      delete process.env.CLAUDE_CODE_USE_BEDROCK;
      rmrf(root);
    }
  });
});
