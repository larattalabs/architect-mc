// The Claude designer on massing jobs and detail passes, with a scripted fake `query()` (no API calls): a massing turn
// runs with the massing model, effort and maxTurns and the massing system prompt, only its massing file is writable,
// and it installs as a massing version; a detail pass whose design breaks the hard size cap fails its round with the
// conformance errors, gets them in the fix prompt, and passes in the next round with the conformance recorded.
import fs from 'node:fs';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeDesigner } from '../src/claude/designer.js';
import { DesignRequest } from '../src/protocol.js';
import { makeSidecar, request, until, type Harness } from './helpers.js';

let n = 0;
const sid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const msg = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: sid(), ...o }) as unknown as SDKMessage;
const init = (s: string) => msg({ type: 'system', subtype: 'init', session_id: s, model: 'fake', cwd: '', tools: [] });
const ok = (s: string, cost = 0.05) => msg({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 3, total_cost_usd: cost, session_id: s, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });
type Script = (prompt: string, opts: Options) => AsyncGenerator<SDKMessage>;
interface Call {
  prompt: string;
  opts: Options;
}
const canUse = (opts: Options, tool: string, input: Record<string, unknown>) => opts.canUseTool!(tool, input, { signal: new AbortController().signal, toolUseID: 'x', requestId: 'r' } as never) as Promise<{ behavior: string }>;

describe('Claude designer: massings and detail passes (fake SDK)', () => {
  let h: Harness;
  let script: Script;
  const calls: Call[] = [];

  beforeAll(async () => {
    h = makeSidecar(['--backend', 'claude']);
    h.sc.config.designConcurrency = 1;
    const queryFn = ({ prompt, options }: { prompt: string; options: Options }) => {
      calls.push({ prompt: String(prompt), opts: options });
      return Object.assign(script(String(prompt), options), { close() {}, accountInfo: async () => ({ email: 'x' }) });
    };
    const designer = new ClaudeDesigner(h.sc, { queryFn: queryFn as never, skipAuthCheck: true });
    h.sc.setAuthSettings('sk-ant-stored-key', undefined);
    await h.sc.start(designer);
  });
  afterAll(async () => {
    await h.close();
  });
  const finished = (id: string) => until(() => ['done', 'failed'].includes(h.sc.designs.get(id)!.status), 30_000);

  it('a massing turn: the massing model, effort low, 20 turns, its own prompt; installed as a massing version', async () => {
    const verdicts: Record<string, string> = {};
    script = async function* (_prompt, opts) {
      const s = sid();
      yield init(s);
      const cwd = opts.cwd!;
      const file = path.join(cwd, 'kit', 'designs', 'mas_lakeside_cabin.mjs');
      verdicts.own = (await canUse(opts, 'Write', { file_path: file, content: 'x' })).behavior;
      verdicts.other = (await canUse(opts, 'Write', { file_path: path.join(cwd, 'kit', 'designs', 'gen_x.mjs'), content: 'x' })).behavior;
      fs.writeFileSync(file, fs.readFileSync(path.join(cwd, 'kit', 'massings', 'cabin_massing.mjs'), 'utf8').replace("export const id = 'cabin_massing'", "export const id = 'mas_lakeside_cabin'"));
      yield ok(s);
    };
    const d = h.sc.requestDesign(DesignRequest.parse(request({ massing: true, context: { site: 'lakeshore' } })));
    await finished(d.id);
    const done = h.sc.designs.get(d.id)!;
    expect(done.status, done.error).toBe('done');
    expect(done.massing).toEqual({ id: 'mas_lakeside_cabin', version: 1 });
    const o = calls[0]!.opts;
    expect(o).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low', maxTurns: 20 });
    expect((o.systemPrompt as { append: string }).append).toMatch(/massing designer/);
    expect(calls[0]!.prompt).toMatch(/Make the massing described in BRIEF.md as kit\/designs\/mas_lakeside_cabin.mjs/);
    expect(verdicts).toEqual({ own: 'allow', other: 'deny' });
    const brief = fs.readFileSync(path.join(h.cfg.dataDir, 'designs', d.id, 'BRIEF.md'), 'utf8');
    expect(brief).toMatch(/maximum size: x <= 40, y <= 20, z <= 40\*\* \(the whole template, roofs and overhangs included\)\. This is a hard limit/);
    expect(brief).toContain('--profile massing --max 40,20,40 --type cabin');
    expect(brief).toContain('"site": "lakeshore"');
    expect(brief).toContain('kit/massings/cabin_massing.mjs');
    expect(h.sc.massings.get('mas_lakeside_cabin')).toMatchObject({ version: 1, cost: { usd: 0.05 } });
  });

  it('a massing turn that writes no massing fails the round and is asked again', async () => {
    let round = 0;
    script = async function* (prompt, opts) {
      const s = sid();
      yield init(s);
      round++;
      const file = path.join(opts.cwd!, 'kit', 'designs', 'mas_plain.mjs');
      // round 1: an ordinary design, not a massing
      if (round === 1) fs.writeFileSync(file, "import { blueprint } from '../lib/kit.mjs';\nexport const id = 'mas_plain';\nexport default () => blueprint({ id, name: 'X', type: 'cabin', size: { x: 9, y: 7, z: 9 } });\n");
      else {
        expect(prompt).toMatch(/not a massing/);
        fs.writeFileSync(file, fs.readFileSync(path.join(opts.cwd!, 'kit', 'massings', 'cabin_massing.mjs'), 'utf8').replace("export const id = 'cabin_massing'", "export const id = 'mas_plain'"));
      }
      yield ok(s, 0.02 * round);
    };
    const d = h.sc.requestDesign(DesignRequest.parse(request({ massing: true, name: 'Plain' })));
    await finished(d.id);
    expect(h.sc.designs.get(d.id)!.status, h.sc.designs.get(d.id)!.error).toBe('done');
    expect(round).toBe(2);
  });

  it('a detail pass over the hard cap fails its round with the conformance errors, then passes; conformance is recorded', async () => {
    let round = 0;
    const prompts: string[] = [];
    script = async function* (prompt, opts) {
      const s = sid();
      yield init(s);
      round++;
      prompts.push(prompt);
      const bp = /kit\/designs\/(gen_[a-z0-9_]+)\.mjs/.exec(prompt)?.[1] ?? 'gen_lakeside_cabin';
      const floors = round === 1 ? 3 : 1;
      fs.writeFileSync(path.join(opts.cwd!, 'kit', 'designs', `${bp}.mjs`), fs.readFileSync(path.join(opts.cwd!, 'kit', 'designs', 'cabin.mjs'), 'utf8').replace("export const id = 'cabin'", `export const id = '${bp}'`).replace("default: 1, label: 'Floors'", `default: ${floors}, label: 'Floors'`));
      yield ok(s);
    };
    const d = h.sc.requestDesign(DesignRequest.parse(request({ fromMassing: 'mas_lakeside_cabin' })));
    await finished(d.id);
    const done = h.sc.designs.get(d.id)!;
    expect(done.status, done.error).toBe('done');
    expect(round).toBe(2);
    expect(prompts[1]).toMatch(/did not pass[\s\S]*size/);
    expect(done.conformance).toEqual({ ok: true, errors: [], issues: [] });
    // the brief's build command carries the hard cap (11x9x13 + 2) and --massing
    expect(fs.readFileSync(path.join(h.cfg.dataDir, 'designs', d.id, 'BRIEF.md'), 'utf8')).toContain('--max 13,11,15 --type cabin --massing massing/mas_lakeside_cabin.blueprint.json');
    expect(h.sc.massings.get('mas_lakeside_cabin')!.detail).toMatchObject({ designId: d.id, status: 'done' });
  });
});
