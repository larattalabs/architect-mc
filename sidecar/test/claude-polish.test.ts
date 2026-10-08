// Phase 5b: a polish through the Claude designer with a scripted fake `query()` (no API calls): the polish turn's
// options (a fresh session in the polish scratch dir, the polish system prompt, the design permission policy: only
// kit/designs/<id>.mjs is writable), POLISH.md and the base renders, the critic as a structured job, the scope check and
// one new version. The fake "designer" re-materials the roof (inside the allowed part).
import fs from 'node:fs';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeDesigner } from '../src/claude/designer.js';
import { POLISH_SYSTEM } from '../src/claude/polishprompts.js';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { criticHash } from '../src/critichash.js';
import { Sidecar } from '../src/sidecar.js';
import { Store } from '../src/store.js';
import { sha256File } from '../src/versions.js';
import { rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.resolve(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'tools', 'diff.mjs'));

let n = 0;
const sid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const msg = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: sid(), ...o }) as unknown as SDKMessage;
const result = (s: string, extra: Record<string, unknown> = {}) => msg({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 2, total_cost_usd: 0.05, session_id: s, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [], ...extra });

describe.skipIf(!hasKit)('polish through the Claude designer (fake SDK)', () => {
  let root: string;
  let sc: Sidecar;
  const turns: Array<{ prompt: string; opts: Options; polishMd: string; base: string[] }> = [];
  let denied: string | undefined;

  beforeAll(async () => {
    root = tempDir('arch-cpolish-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'claude'], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    cfg.claude.designModel = 'fake-designer';
    sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    // the entry "inn": the kit tavern, with a fresh critique.json naming the roof
    const dir = path.join(cfg.libraryDir, 'inn');
    fs.mkdirSync(dir, { recursive: true });
    const ex = path.join(KIT, 'examples', 'tavern');
    for (const f of fs.readdirSync(ex)) fs.copyFileSync(path.join(ex, f), path.join(dir, f.replace(/^tavern/, 'inn')));
    fs.writeFileSync(path.join(dir, 'inn.mjs'), fs.readFileSync(path.join(dir, 'inn.mjs'), 'utf8').replace("export const id = 'tavern'", "export const id = 'inn'"));
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'inn.blueprint.json'), 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(path.join(dir, 'inn.blueprint.json'), JSON.stringify({ ...j, id: 'inn', source: 'inn.mjs' }, null, 2));
    fs.writeFileSync(path.join(dir, 'critique.json'), JSON.stringify({ format: 2, entryId: 'inn', entryVersion: 1, criticHash: criticHash(), entryRevision: sha256File(path.join(dir, 'inn.nbt')), verdict: { overall: 5, scores: { silhouette: 5 }, issues: [{ priority: 'P1', part: 'roof', view: 'iso', what: 'the roof reads flat', fix: 'use the stone for the roof' }], summary: 's' } }));
    const queryFn = ({ prompt, options }: { prompt: string; options: Options }) => {
      async function* run(): AsyncGenerator<SDKMessage> {
        const s = sid();
        yield msg({ type: 'system', subtype: 'init', session_id: s, model: 'fake', cwd: options.cwd ?? '', tools: [] });
        const of = (options as { outputFormat?: { schema?: { properties?: { scores?: { required?: string[] } } } } }).outputFormat;
        if (of) {
          // the critic (a structured job): the roof issue (index 0) is resolved, the overall goes up
          const dims = of.schema?.properties?.scores?.required ?? ['silhouette'];
          yield result(s, { structured_output: { scores: Object.fromEntries(dims.map((d) => [d, 7])), issues: [], resolved: [0], verdict: 'iterate', summary: 'better' }, total_cost_usd: 0.02 });
          return;
        }
        const cwd = options.cwd!;
        turns.push({ prompt: String(prompt), opts: options, polishMd: fs.readFileSync(path.join(cwd, 'POLISH.md'), 'utf8'), base: fs.readdirSync(path.join(cwd, 'polish', 'base')).sort() });
        // the policy: the kit is not writable, the design is
        const deny = await options.canUseTool!('Write', { file_path: path.join(cwd, 'kit', 'lib', 'kit.mjs'), content: 'x' }, { signal: new AbortController().signal, toolUseID: 'x', requestId: 'r' } as never);
        denied = deny?.behavior;
        const f = path.join(cwd, 'kit', 'designs', 'inn.mjs');
        const src = fs.readFileSync(f, 'utf8');
        fs.writeFileSync(f, src.replace("gable: infill, gableInset: 1, gableFrom: 11 });", "gable: infill, gableInset: 1, gableFrom: 11, stairs: p.stoneStairs, slab: p.stoneSlab, full: p.stone, lining: p.stone });"));
        yield result(s);
      }
      return Object.assign(run(), { close() {}, accountInfo: async () => ({ email: 'x' }) });
    };
    await sc.start(new ClaudeDesigner(sc, { queryFn: queryFn as never, skipAuthCheck: true }));
    sc.setAuthSettings('sk-ant-test-key', undefined);
  }, 60_000);
  afterAll(async () => {
    await sc.close();
    rmrf(root);
  });

  it('one step: POLISH.md and the base renders, the polish system prompt and policy, the scope check, v2 installed', async () => {
    const d = sc.polishes.request('inn', { maxSteps: 1, budgetUsd: 3 });
    await until(() => ['done', 'failed', 'cancelled'].includes(sc.designs.get(d.id)!.status), 120_000);
    const done = sc.designs.get(d.id)!;
    expect(done.status, done.error).toBe('done');
    expect(done.polish).toMatchObject({ end: 'polished', installedVersion: 2 });
    expect(done.polish!.report).toBeUndefined(); // the fresh critique.json was reused
    expect(turns.length).toBe(1);
    const t = turns[0]!;
    expect((t.opts.systemPrompt as { append: string }).append).toBe(POLISH_SYSTEM);
    expect(t.opts.resume).toBeUndefined();
    expect(t.opts.model).toBe('fake-designer');
    expect(t.polishMd).toMatch(/\[P1\] part `roof`, seen in iso: the roof reads flat/);
    expect(t.polishMd).toMatch(/Only the cells of these parts: `roof`/);
    expect(t.polishMd).toMatch(/node kit\/tools\/diff\.mjs polish\/base\/inn\.nbt kit\/out\/inn\.nbt --scope roof/);
    expect(t.base).toEqual(expect.arrayContaining(['inn.nbt', 'inn.parts.nbt', 'inn.preview-iso.png', 'slices.txt']));
    expect(denied).toBe('deny');
    const delta = JSON.parse(fs.readFileSync(path.join(sc.config.libraryDir, 'inn', 'versions', '2', 'delta.json'), 'utf8')) as { parts: Record<string, { status: string }> };
    expect(Object.entries(delta.parts).filter(([, p]) => p.status !== 'UNCHANGED').map(([k]) => k)).toEqual(['roof']);
    expect(done.cost!.usd).toBeGreaterThan(0);
  }, 120_000);
});
