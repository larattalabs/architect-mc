// A bible job on the Claude backend with a scripted fake `query()` (no API calls) and the real kit: the structured
// draft (a kit-refused role gets one re-ask in the same session), the agent pass that may write only
// bible/components.mjs, a failed component check going back to the agent, the install with its sheet, the cost, and the
// budget stop.
import fs from 'node:fs';
import path from 'node:path';
import type { HookInput, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeDesigner } from '../src/claude/designer.js';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { Sidecar } from '../src/sidecar.js';
import { Store } from '../src/store.js';
import { rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const REF = path.join(KIT, 'bibles', 'rustic', 'components.mjs');
const hasKit = fs.existsSync(path.join(KIT, 'tools', 'components.mjs'));

let n = 0;
const sid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const msg = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: sid(), ...o }) as unknown as SDKMessage;
const init = (s: string) => msg({ type: 'system', subtype: 'init', session_id: s, model: 'fake', cwd: '', tools: [] });
const result = (s: string, extra: Record<string, unknown> = {}) => msg({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 2, total_cost_usd: 0.05, session_id: s, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [], ...extra });

const DRAFT = {
  name: 'Stiltwater',
  roles: {
    wall: 'minecraft:spruce_planks', wall_alt: 'minecraft:mossy_cobblestone', trim: 'minecraft:stripped_spruce_log', roof: 'minecraft:glass',
    floor: 'minecraft:spruce_planks', frame: 'minecraft:spruce_log', accent: 'minecraft:dark_oak_planks', light: 'minecraft:lantern',
    glass: 'minecraft:glass_pane', foundation: 'minecraft:mossy_cobblestone', path: 'minecraft:coarse_dirt', pier: 'minecraft:spruce_fence',
  },
  proportions: { storey: 4, roofPitch: 1, overhang: 1, windowRhythm: 3, plinth: 2 },
  roofLanguage: 'steep, sagging gables', silhouette: 'crooked, on stilts', motifs: ['nets', 'lanterns on poles'],
  tiers: { humble: ['wall_alt'], important: ['wall', 'trim'] }, lighting: 'lanterns on poles', avoid: ['white'], components: ['window', 'door_surround', 'lantern_post', 'roof_trim', 'chimney'],
  prose: `# Stiltwater\n\n${'Weathered wood over the water. '.repeat(10)}`,
};

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

/** The PreToolUse hooks' decisions for a call ([] = no objection). */
async function runHooks(opts: Options, tool: string, input: Record<string, unknown>): Promise<string[]> {
  const out: string[] = [];
  for (const m of opts.hooks!.PreToolUse!) {
    for (const hook of m.hooks) {
      const r = (await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, session_id: 's', transcript_path: '', cwd: opts.cwd!, tool_use_id: 't' } as unknown as HookInput, 't', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
      if (r.hookSpecificOutput?.permissionDecision) out.push(r.hookSpecificOutput.permissionDecision);
    }
  }
  return out;
}

const canUse = (opts: Options, tool: string, input: Record<string, unknown>) => opts.canUseTool!(tool, input, { signal: new AbortController().signal, toolUseID: 'x', requestId: 'r' } as never) as Promise<{ behavior: string; message?: string }>;

describe.skipIf(!hasKit)('a bible job on the Claude backend (fake SDK, real kit)', () => {
  let root: string;
  let sc: Sidecar;
  let script: Script;
  const calls: Call[] = [];

  beforeAll(async () => {
    root = tempDir('arch-cbible-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'claude'], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    cfg.bibleModel = 'fake-opus';
    sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    sc.endpoint = { port: 7890, tokenFile: path.join(cfg.dataDir, 'client.token') };
    sc.setAuthSettings('sk-ant-stored-key', undefined);
    await sc.start(new ClaudeDesigner(sc, { queryFn: fakeQuery(() => script, calls) as never, skipAuthCheck: true }));
  });
  afterAll(async () => {
    await sc.close();
    rmrf(root);
  });

  it('drafts (one re-ask after the kit refuses a role), writes the components (one fix round), checks, renders and installs', async () => {
    const verdicts: Record<string, string> = {};
    const hooks: Record<string, string[]> = {};
    let drafts = 0;
    let rounds = 0;
    script = async function* (prompt, opts) {
      const s = opts.resume ?? sid();
      yield init(s);
      if (opts.outputFormat) {
        drafts++;
        // the first draft names a roof without stairs: the kit refuses it
        const roof = drafts === 1 ? 'minecraft:glass' : 'minecraft:dark_oak_planks';
        yield result(s, { structured_output: { ...DRAFT, roles: { ...DRAFT.roles, roof } } });
        return;
      }
      rounds++;
      const cwd = opts.cwd!;
      const own = path.join(cwd, 'bible', 'components.mjs');
      const v0 = await canUse(opts, 'Write', { file_path: own, content: 'x' });
      verdicts.own = v0.behavior;
      verdicts.design = (await canUse(opts, 'Write', { file_path: path.join(cwd, 'kit', 'designs', 'x.mjs'), content: 'x' })).behavior;
      verdicts.bibleJson = (await canUse(opts, 'Edit', { file_path: path.join(cwd, 'bible', 'bible.json'), old_string: 'a', new_string: 'b' })).behavior;
      verdicts.check = (await canUse(opts, 'Bash', { command: 'node kit/tools/components.mjs bible/components.mjs --bible bible/bible.json --out sheet' })).behavior;
      verdicts.readRef = (await canUse(opts, 'Read', { file_path: path.join(cwd, 'kit', 'bibles', 'rustic', 'components.mjs') })).behavior;
      verdicts.readSheet = (await canUse(opts, 'Read', { file_path: path.join(cwd, 'sheet', 'sheet.png') })).behavior;
      // the PreToolUse hooks (they run even for calls the CLI allows by itself)
      hooks.readRules = await runHooks(opts, 'Read', { file_path: path.join(cwd, 'kit', 'lib', 'components.mjs') });
      hooks.readRef = await runHooks(opts, 'Read', { file_path: path.join(cwd, 'kit', 'bibles', 'rustic', 'components.mjs') });
      hooks.readBrief = await runHooks(opts, 'Read', { file_path: path.join(cwd, 'BIBLE.md') });
      hooks.check = await runHooks(opts, 'Bash', { command: 'node kit/tools/components.mjs bible/components.mjs --bible bible/bible.json --out sheet' });
      hooks.own = await runHooks(opts, 'Write', { file_path: own, content: 'x' });
      hooks.bibleJson = await runHooks(opts, 'Edit', { file_path: path.join(cwd, 'bible', 'bible.json'), old_string: 'a', new_string: 'b' });
      hooks.design = await runHooks(opts, 'Write', { file_path: path.join(cwd, 'kit', 'designs', 'x.mjs'), content: 'x' });
      hooks.state = await runHooks(opts, 'Read', { file_path: path.join(sc.config.dataDir, 'state.json') });
      const ref = fs.readFileSync(REF, 'utf8');
      // round 1 leaves a broken chimney; round 2 fixes it
      fs.writeFileSync(own, rounds === 1 ? ref.replace('export function chimney(bp, at) {', "export function chimney(bp, at) {\n  throw new Error('chimney not finished');") : ref);
      // tampering with the bible does not count: the sidecar writes its own copy before the check
      fs.writeFileSync(path.join(cwd, 'bible', 'bible.json'), '{}');
      yield result(s);
    };
    const j = sc.bibles.request({ prompt: 'weathered fishing village on stilts, mossy and crooked' });
    expect(j.bibleId).toBe('bib_weathered_fishing_village_on');
    await until(() => ['done', 'failed'].includes(sc.bibles.get(j.id)!.status), 60_000);
    const done = sc.bibles.get(j.id)!;
    expect(done.status, done.error).toBe('done');
    // the passes: draft, re-ask (same session), components x2
    expect(drafts).toBe(2);
    expect(rounds).toBe(2);
    const draftCalls = calls.filter((c) => c.opts.outputFormat);
    expect(draftCalls[0]!.prompt).toContain('weathered fishing village on stilts');
    expect(draftCalls[1]!.prompt).toMatch(/The kit refused that bible/);
    expect(draftCalls[1]!.opts.resume).toBeDefined();
    expect(draftCalls[0]!.opts.tools).toEqual([]);
    expect(draftCalls[0]!.opts.model).toBe('fake-opus');
    const agent = calls.filter((c) => !c.opts.outputFormat);
    expect(agent[1]!.prompt).toMatch(/did not pass \(round 2 of 3\)[\s\S]*chimney not finished/);
    expect((agent[0]!.opts.systemPrompt as { append: string }).append).toMatch(/component designer/);
    expect(verdicts).toEqual({ own: 'allow', design: 'deny', bibleJson: 'deny', check: 'allow', readRef: 'allow', readSheet: 'allow' });
    expect(hooks).toEqual({ readRules: [], readRef: [], readBrief: [], check: [], own: [], bibleJson: ['deny'], design: ['deny'], state: ['deny'] });
    // installed
    const dir = path.join(sc.config.biblesDir, j.bibleId);
    const bible = JSON.parse(fs.readFileSync(path.join(dir, 'versions', '1', 'bible.json'), 'utf8')) as Record<string, unknown>;
    expect(bible).toMatchObject({ id: j.bibleId, version: 1, name: 'Stiltwater', roles: { roof: 'minecraft:dark_oak_planks', pier: 'minecraft:spruce_fence' } });
    expect(fs.readFileSync(path.join(dir, 'bible.md'), 'utf8')).toMatch(/Weathered wood/);
    expect(fs.readFileSync(path.join(dir, 'components.mjs'), 'utf8')).not.toMatch(/chimney not finished/);
    expect(fs.readFileSync(path.join(dir, 'sheet.png')).subarray(1, 4).toString()).toBe('PNG');
    expect(fs.readFileSync(path.join(sc.bibles.scratchDir(j.id), 'BIBLE.md'), 'utf8')).toMatch(/Component brief: Stiltwater/);
    // $0.05 per query; the re-asked draft resumes its session, whose total already includes the first draft
    expect(done.cost.usd).toBeCloseTo(0.15, 5);
    expect(done.rounds).toBe(2);
    // a real (claude) bible job is measured for the estimates
    expect(sc.estimates.samples('bible', 'fake-opus')).toHaveLength(1);
  }, 90_000);

  it('group items run concurrently on the Claude designer, each with the bible in its scratch dir and its own model', async () => {
    calls.length = 0;
    sc.config.designConcurrency = 2;
    let inside = 0;
    let both = false;
    script = async function* (prompt, opts) {
      const s = opts.resume ?? sid();
      yield init(s);
      const cwd = opts.cwd!;
      const bp = /kit\/designs\/(gen_[a-z0-9_]+)\.mjs/.exec(prompt)![1]!;
      inside++;
      // both items are inside a turn at the same time (two pool slots)
      await until(() => inside >= 2 || both, 10_000).catch(() => undefined);
      both = true;
      const src = fs.readFileSync(path.join(KIT, 'designs', 'cabin.mjs'), 'utf8').replace(/export const id = 'cabin'/, `export const id = '${bp}'`);
      fs.writeFileSync(path.join(cwd, 'kit', 'designs', `${bp}.mjs`), src);
      inside--;
      yield result(s);
    };
    const g = sc.groups.create({ name: 'Pair', bible: 'rustic', concurrency: 2, items: [{ type: 'cabin', style: 'rustic', features: [], maxSize: { x: 40, y: 30, z: 40 }, itemKey: 'a', role: 'landmark' }, { type: 'cabin', style: 'rustic', features: [], maxSize: { x: 40, y: 30, z: 40 }, itemKey: 'b' }] });
    await until(() => ['done', 'failed'].includes(sc.groups.get(g.id)!.status), 60_000);
    const f = sc.groups.get(g.id)!;
    expect(f.status, JSON.stringify(f.items.map((i) => i.error))).toBe('done');
    expect(both).toBe(true);
    expect(calls.map((c) => c.opts.model).sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    for (const c of calls) expect(fs.existsSync(path.join(c.opts.cwd!, 'bible', 'components.mjs'))).toBe(true);
    for (const it of f.items) {
      const e = JSON.parse(fs.readFileSync(path.join(sc.config.libraryDir, it.entryId!, `${it.entryId}.blueprint.json`), 'utf8')) as Record<string, unknown>;
      expect(e).toMatchObject({ bible: { id: 'rustic', version: 1 }, group: g.id, groupItem: it.itemKey });
    }
    // finished Claude designs feed the estimates (one per model here)
    expect(sc.estimates.samples('design', 'claude-opus-5-5')).toHaveLength(1);
    sc.config.designConcurrency = 3;
  }, 90_000);

  it('a component pass cut short by the budget is still checked, and installed when it passes', async () => {
    calls.length = 0;
    script = async function* (_prompt, opts) {
      const s = opts.resume ?? sid();
      yield init(s);
      if (opts.outputFormat) {
        yield result(s, { structured_output: { ...DRAFT, roles: { ...DRAFT.roles, roof: 'minecraft:spruce_planks' } }, total_cost_usd: 0.3 });
        return;
      }
      fs.writeFileSync(path.join(opts.cwd!, 'bible', 'components.mjs'), fs.readFileSync(REF, 'utf8'));
      yield result(s, { subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.7 });
    };
    const j = sc.bibles.request({ prompt: 'tight budget', budgetUsd: 1 });
    await until(() => ['done', 'failed'].includes(sc.bibles.get(j.id)!.status), 30_000);
    const done = sc.bibles.get(j.id)!;
    expect(done.status, done.error).toBe('done');
    expect(done.cost.usd).toBeCloseTo(1, 5);
  }, 60_000);

  it('the budget stops a bible job', async () => {
    calls.length = 0;
    script = async function* (_prompt, opts) {
      const s = opts.resume ?? sid();
      yield init(s);
      yield result(s, { structured_output: { ...DRAFT } }); // roof glass: refused, and the budget is spent
    };
    const j = sc.bibles.request({ prompt: 'a cheap one', budgetUsd: 0.04 });
    await until(() => ['done', 'failed'].includes(sc.bibles.get(j.id)!.status), 30_000);
    expect(sc.bibles.get(j.id)).toMatchObject({ status: 'failed', error: 'budget' });
    expect(calls).toHaveLength(1);
  }, 60_000);
});
