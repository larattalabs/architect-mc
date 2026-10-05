// The Claude backend of a bible job (bibles.ts runs the job; this does its two Claude passes):
//
//   draft       a structured query through the Agent SDK (the job driver, outputFormat json_schema, no tools): the
//               bible JSON (roles, proportions, roof language, silhouette, motifs, tiers, lighting, avoid, extra
//               components) plus its prose; one re-ask in the same session when the kit refuses it
//   components  an agent turn in the scratch kit (the designer's turn runner and policy) that may write only
//               bible/components.mjs; it runs the component frame itself and looks at the sheet
import fs from 'node:fs';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CORE_ROLES, MACRO_ROLES, REQUIRED_COMPONENTS, type BibleBackend, type BiblePass, type DraftResult, type PassResult } from '../bibles.js';
import { costFromResult, CostMeter } from '../jobs/cost.js';
import type { BibleJob } from '../protocol.js';
import type { Sidecar } from '../sidecar.js';
import { truncate } from '../util/text.js';
import type { ClaudeDesigner, Running } from './designer.js';
import { StreamMapper, type TurnStats } from './stream.js';

/**
 * The JSON schema of the structured pass. It keeps to what phase 4a proved on real Claude (types, required, minLength /
 * maxLength / maxItems, descriptions): no `pattern`, no numeric bounds, no schema-valued additionalProperties. The kit
 * validates the blocks and the rest afterwards (one re-ask on a miss).
 */
export function bibleSchema(scope: 'building' | 'settlement'): Record<string, unknown> {
  const roleNames = [...CORE_ROLES, ...(scope === 'settlement' ? MACRO_ROLES : [])];
  const block = { type: 'string', description: 'a vanilla Minecraft 26.3 block id, "minecraft:..."' };
  return {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 40, description: 'a short evocative name for the style' },
      roles: {
        type: 'object',
        properties: Object.fromEntries(roleNames.map((r) => [r, block])),
        required: roleNames,
        description: 'role -> block id; extra named roles may be added the same way (e.g. "banner", "rail_post")',
      },
      proportions: {
        type: 'object',
        properties: {
          storey: { type: 'integer', description: 'blocks per storey, 3-8' },
          roofPitch: { type: 'number', description: 'rise per block in, 0.5-2' },
          overhang: { type: 'integer', description: '0-3' },
          windowRhythm: { type: 'integer', description: 'a window every n blocks, 1-8' },
          plinth: { type: 'integer', description: 'plinth height, 0-3' },
        },
        required: ['storey', 'roofPitch', 'overhang', 'windowRhythm', 'plinth'],
      },
      roofLanguage: { type: 'string', maxLength: 200 },
      silhouette: { type: 'string', maxLength: 200 },
      motifs: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 8 },
      tiers: { type: 'object', properties: { humble: { type: 'array', items: { type: 'string' } }, important: { type: 'array', items: { type: 'string' } } }, required: ['humble', 'important'], description: 'role names' },
      lighting: { type: 'string', maxLength: 200 },
      avoid: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 8 },
      components: { type: 'array', items: { type: 'string', description: 'lower_snake_case' }, maxItems: 10, description: `the component library: always ${REQUIRED_COMPONENTS.join(', ')}, plus up to 4 the style needs` },
      prose: { type: 'string', minLength: 200, maxLength: 6000, description: 'bible.md for designers (markdown): mood, silhouette, what each material means, do and don\'t' },
    },
    required: ['name', 'roles', 'proportions', 'roofLanguage', 'silhouette', 'motifs', 'tiers', 'lighting', 'avoid', 'components', 'prose'],
  };
}

export const BIBLE_DRAFT_SYSTEM = [
  "You are Architect's style-bible author. A style bible makes many separately designed Minecraft buildings read as ONE place: shared materials (roles), proportions, roof language, silhouette, motifs and a small component library.",
  'Answer with the structured output only, exactly as its schema asks. Every role is a real vanilla Minecraft 26.3 block id (minecraft:...): full blocks for wall, wall_alt, trim, floor, frame, accent and foundation; the roof role must be a block that has stairs and slab variants (e.g. minecraft:deepslate_tiles, minecraft:dark_oak_planks, minecraft:mud_bricks); glass is a pane (minecraft:glass_pane or a stained one); light is a light source (minecraft:lantern, minecraft:soul_lantern, minecraft:shroomlight, minecraft:sea_lantern, ...); path is a walkable ground block (minecraft:dirt_path, minecraft:coarse_dirt, minecraft:gravel, ...). Pick a frame or accent of wood (a log, stem or planks) so doors, stairs and fences follow the style.',
].join('\n');

export function draftPrompt(job: BibleJob, ctx: { seed?: { id: string; roles: Record<string, string> } | undefined; references?: Array<{ id: string; name: string; materials: string[] }>; previous?: { json: string; prose: string } | undefined }): string {
  const r = job.request;
  const lines = [
    job.kind === 'revise' ? `Revise the style bible below into version ${job.version}. What to change: ${r.notes}` : `Write a style bible for: "${r.prompt}".`,
    r.name ? `Its name: "${r.name}".` : '',
    `Scope: ${r.scope ?? 'building'}${r.scope === 'settlement' ? ' (also fill the macro roles rock, surface, subsurface, rubble, rail, structure: the terrain, ground cover, spoil, track and engineering blocks of the place)' : ''}.`,
    ctx.seed ? `Start from the built-in bible "${ctx.seed.id}" (roles: ${JSON.stringify(ctx.seed.roles)}) and change what the prompt asks for.` : '',
    ctx.references?.length ? `Learn from these existing buildings of the library: ${ctx.references.map((x) => `${x.name} (${x.id}): ${x.materials.slice(0, 10).join(', ')}`).join('; ')}.` : '',
    ctx.previous ? `The current version:\n${ctx.previous.json}\n\nIts prose:\n${truncate(ctx.previous.prose, 4000)}` : '',
    'Make the roles distinctive and coherent (a limited palette reads as one place): what is humble (sheds, houses) and what is important (the landmark, the hall) goes in `tiers` as role names. Proportions are in blocks: storey height, roof pitch (1 = one block up per block in), overhang, window rhythm (a window every n blocks), plinth height.',
    'The prose (bible.md) is for the building designers: the mood in two sentences, the silhouette, what each role is used for, the roof and window language, the components and how to use them, and a short do / don\'t list. No more than about 500 words.',
  ];
  return lines.filter(Boolean).join('\n\n');
}

export function draftRetryPrompt(errors: string[]): string {
  return `The kit refused that bible:\n${errors.map((e) => `- ${e}`).join('\n')}\nAnswer again with every role a valid vanilla block (the roof one with stairs and slab variants), matching the schema exactly.`;
}

export function bibleSystemPrompt(): string {
  return [
    "# You are Architect's component designer",
    'You write the component library of a Minecraft style bible: small reusable building parts (windows, door surrounds, lantern posts, roof trim, chimneys, ...) as code with the Architect blueprint kit. Every building of the set will use them, so they must be well made, consistent with the bible and correct for any position and facing.',
    'Your working directory is a scratch folder (not a repository): BIBLE.md (your brief: read it first), bible/bible.json and bible/bible.md (the bible), bible/components.mjs (your file), kit/ (the kit: README.md, lib/kit.mjs helpers, lib/components.mjs rules, the reference library kit/bibles/rustic/components.mjs, tools/components.mjs, the checker lib/check.mjs).',
    'Write only bible/components.mjs. Your turn ends when every component passes the component check and the sheet looks right.',
  ].join('\n');
}

/** BIBLE.md: the component pass's brief. */
export function componentsBrief(bible: Record<string, unknown>): string {
  const comps = Array.isArray(bible.components) ? (bible.components as string[]) : [...REQUIRED_COMPONENTS];
  const extra = comps.filter((c) => !(REQUIRED_COMPONENTS as readonly string[]).includes(c));
  return [
    `# Component brief: ${String(bible.name ?? bible.id)}`,
    '',
    'Write `bible/components.mjs`: the component library of this style bible (bible/bible.json, bible/bible.md: read both first).',
    '',
    '## What a components module is',
    '',
    '- It exports functions `(bp, at, opts)` that place a small part on a Blueprint `bp`, read `kit/lib/components.mjs` (its header lists every rule and what `at` is for each component) and the reference library `kit/bibles/rustic/components.mjs` (yours starts as a copy of it: rework it into this bible\'s style).',
    `- Required: ${REQUIRED_COMPONENTS.map((c) => `\`${c}\``).join(', ')}.${extra.length ? ` This bible also lists ${extra.map((c) => `\`${c}\``).join(', ')}: write them too, and give each a slot in \`export const meta = { <name>: { slot: 'wall' | 'door' | 'ground' | 'roof' | 'side' } }\` so the test frame knows where to put it.` : ''}`,
    '- **No imports at all** (the file is copied between folders). Materials come from the palette `bp.p` (built from the bible\'s roles: `bp.p.wall`, `bp.p.plaster` (wall_alt), `bp.p.stoneTrim` (trim), `bp.p.roofStairs` / `bp.p.roofSlab` / `bp.p.roofBlock`, `bp.p.floor`, `bp.p.frame`, `bp.p.log`, `bp.p.planks`, `bp.p.stairs`, `bp.p.slab`, `bp.p.fence`, `bp.p.trapdoor`, `bp.p.accentPlanks`, `bp.p.accentSlab`, `bp.p.light`, `bp.p.pane`, `bp.p.foundation`, `bp.p.stone`, `bp.p.stoneStairs`, `bp.p.stoneSlab`, `bp.p.stoneWall`, `bp.p.path`) and the raw roles `bp.p.roles.<role>`; directions from `bp.kit` (`DIR`, `OPPOSITE`, `CW`, `CCW`, `cellsOf`). Never a hard-coded wood or stone id (the checker warns): the same components must re-skin under another bible. Decor blocks (chains, lanterns, iron bars, campfires, flower pots, ...) are fine.',
    '- Work for every facing (north, south, east, west): derive the wall direction from `at.facing` as the reference does.',
    '- Nothing may float: every block must touch the building or the ground through other blocks; attachables (lanterns, torches, trapdoors, buttons) need their support.',
    '- Keep them small: a component writes a few to a few dozen cells, never removes the door it frames, and never blocks the entrance.',
    '',
    '## The check (the sidecar runs the same with a fresh kit)',
    '',
    '- `node kit/tools/components.mjs bible/components.mjs --bible bible/bible.json --out sheet` builds each component into a test frame (a small house in the bible\'s roles), checks it and writes `sheet/sheet.png` (a swatch of the roles, then one tile per component). Every component must pass (no errors); fix the warnings too.',
    '- Read `sheet/sheet.png` and make the parts look like the bible: its motifs, roof language, lighting, tiers.',
    '- Report progress with the `bible_status` tool (one short line). No network, no installs, no git, no subagents; nobody can answer questions during the job.',
    '- Finish with ONE line: what the components look like.',
    '',
    '## The bible',
    '',
    '```json',
    JSON.stringify({ name: bible.name, roles: bible.roles, proportions: bible.proportions, roofLanguage: bible.roofLanguage, silhouette: bible.silhouette, motifs: bible.motifs, tiers: bible.tiers, lighting: bible.lighting, avoid: bible.avoid, components: comps }, null, 2),
    '```',
    '',
  ].join('\n');
}

export function componentsPrompt(): string {
  return 'Write the component library described in BIBLE.md as bible/components.mjs. Read BIBLE.md, bible/bible.md, kit/lib/components.mjs and the reference kit/bibles/rustic/components.mjs (your file starts as a copy of it), rework every component into this style, run the component check, look at sheet/sheet.png and iterate until every component passes and it looks right. End with a one-line summary.';
}

export function componentsFixPrompt(problem: string, round: number, max: number): string {
  return `The sidecar re-ran the component check with a fresh copy of the kit and it did not pass (round ${round} of ${max}):\n${problem}\n\nFix bible/components.mjs (only that file counts), run the check from BIBLE.md until it passes, look at the sheet again, then end with a one-line summary.`;
}

export const COMPONENTS_RESTART_PROMPT = 'The sidecar restarted while you were working on the components. Re-check where you were (bible/components.mjs, BIBLE.md) and continue until the component check passes and the sheet looks right, then end with a one-line summary.';

function tryJson(text: string): unknown {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t)?.[1];
  for (const s of [fenced, t]) {
    if (!s) continue;
    try {
      return JSON.parse(s) as unknown;
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

export class ClaudeBibleBackend implements BibleBackend {
  readonly name = 'claude' as const;
  private aborts = new Map<string, { abort: AbortController; turn?: Running }>();

  constructor(
    private sc: Sidecar,
    private designer: ClaudeDesigner,
  ) {}

  cancel(jobId: string): void {
    const a = this.aborts.get(jobId);
    if (!a) return;
    if (a.turn) this.designer.abortTurn(a.turn, 'cancel');
    a.abort.abort();
  }

  /** stop every pass (shutdown) */
  stopAll(): void {
    for (const a of this.aborts.values()) {
      if (a.turn) this.designer.abortTurn(a.turn, 'shutdown');
      a.abort.abort();
    }
  }

  private model(job: BibleJob): string {
    return job.request.model ?? this.sc.config.bibleModel;
  }

  /** The outcome of a pass that did not succeed (undefined = it did). */
  private ended(id: string, stats: TurnStats, aborted: 'cancel' | 'shutdown' | undefined, budget: number | undefined, spent: number): PassResult | undefined {
    if (aborted === 'shutdown') return { ok: false, outcome: 'stopped' };
    if (aborted === 'cancel' || this.sc.bibles.get(id)?.status === 'cancelled') return { ok: false, outcome: 'finished' };
    if (stats.limited) {
      this.designer.noteLimit(stats);
      return { ok: false, outcome: 'requeue' };
    }
    if (stats.authFailed) return { ok: false, outcome: 'finished', error: `Claude authentication failed (${stats.authFailed})` };
    if (stats.subtype === 'error_max_budget_usd' || (budget !== undefined && spent >= budget && stats.subtype !== 'success')) return { ok: false, outcome: 'finished', error: 'budget' };
    return undefined;
  }

  async draft(p: BiblePass): Promise<DraftResult> {
    const { job, work } = p;
    const driver = this.sc.jobs.driver;
    if (!driver) return { ok: false, outcome: 'requeue' };
    const scope = job.request.scope ?? 'building';
    const resume = p.retryErrors ? work.draftSession : undefined;
    const abort = new AbortController();
    this.aborts.set(job.id, { abort });
    const mapper = new StreamMapper(this.sc.log, `bible ${job.id} draft`, (rl) => {
      if (rl.status === 'rejected') this.designer.noteLimit({ ...mapper.stats, limited: true, rateLimit: rl });
    });
    const meter = new CostMeter(work.cost);
    meter.begin(!!resume);
    let structured: unknown;
    let thrown: string | undefined;
    try {
      const prompt = p.retryErrors ? draftRetryPrompt(p.retryErrors) : draftPrompt(job, this.draftContext(job));
      const q = driver.query({ jobId: job.id, kind: 'structured', prompt, system: BIBLE_DRAFT_SYSTEM, model: this.model(job), effort: 'medium', maxTurns: 6, maxBudgetUsd: p.budgetLeft, schema: bibleSchema(scope), tools: [], cwd: p.scratch, resume, abort });
      for await (const msg of q) {
        if (abort.signal.aborted) break;
        mapper.handle(msg);
        const sid = (msg as { session_id?: string }).session_id;
        if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init' && sid) work.draftSession = sid;
        if (msg.type === 'result') {
          this.sc.bibles.setCost(job.id, meter.observe(costFromResult(msg as unknown as Record<string, unknown>)));
          structured = (msg as { structured_output?: unknown }).structured_output;
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) thrown = (e as Error).message ?? String(e);
    } finally {
      this.aborts.delete(job.id);
    }
    work.cost = meter.commit();
    this.sc.bibles.setCost(job.id, work.cost);
    const stats = mapper.stats;
    if (thrown) {
      stats.isError = true;
      stats.errors.push(thrown);
    }
    const end = this.ended(job.id, stats, abort.signal.aborted ? (this.sc.bibles.get(job.id)?.status === 'cancelled' ? 'cancel' : 'shutdown') : undefined, job.request.budgetUsd, work.cost.usd);
    if (end && !end.ok) return end;
    if (stats.isError || stats.subtype !== 'success') return { ok: false, outcome: 'finished', error: truncate([stats.subtype && stats.subtype !== 'success' ? stats.subtype : '', ...stats.errors].filter(Boolean).join(': ') || 'the draft ended without a result', 1500) };
    const out = structured ?? (stats.resultText ? tryJson(stats.resultText) : undefined);
    if (!out || typeof out !== 'object' || Array.isArray(out)) return { ok: false, outcome: 'finished', error: 'the draft has no structured bible' };
    const { prose, ...bible } = out as Record<string, unknown>;
    return { ok: true, bible, prose: typeof prose === 'string' ? prose : '' };
  }

  /** The seed roles, the references' materials and (a revise) the previous version for the draft prompt. */
  private draftContext(job: BibleJob): Parameters<typeof draftPrompt>[1] {
    const r = job.request;
    const seed = r.seedPreset ? this.sc.bibleIndex.get(r.seedPreset) : undefined;
    const references = (r.references ?? []).flatMap((id) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(this.sc.config.libraryDir, id, `${id}.blueprint.json`), 'utf8')) as { name?: string; materials?: string[] };
        return [{ id, name: j.name ?? id, materials: Array.isArray(j.materials) ? j.materials : [] }];
      } catch {
        return [];
      }
    });
    let previous: { json: string; prose: string } | undefined;
    if (job.kind === 'revise') {
      try {
        const prev = this.sc.bibleIndex.resolve({ id: job.bibleId, version: job.version - 1 });
        previous = { json: fs.readFileSync(prev.files.json, 'utf8'), prose: prev.files.md && fs.existsSync(prev.files.md) ? fs.readFileSync(prev.files.md, 'utf8') : '' };
      } catch {
        previous = undefined;
      }
    }
    return { ...(seed ? { seed: { id: seed.id, roles: seed.roles } } : {}), ...(references.length ? { references } : {}), ...(previous ? { previous } : {}) };
  }

  async components(p: BiblePass): Promise<PassResult> {
    const { job, work, scratch } = p;
    fs.writeFileSync(path.join(scratch, 'BIBLE.md'), componentsBrief(work.bible ?? {}));
    const sessionKey = `bible:${job.id}`;
    const resume = this.sc.store.data.sessions[sessionKey]?.sessionId;
    const prompt = work.problem && work.round > 1 ? componentsFixPrompt(work.problem, work.round, 3) : resume ? COMPONENTS_RESTART_PROMPT : componentsPrompt();
    const turn: Running = { abort: new AbortController() };
    this.aborts.set(job.id, { abort: turn.abort, turn });
    const meter = new CostMeter(work.cost);
    meter.begin(!!resume);
    let res: { stats: TurnStats; reason?: string };
    try {
      const mcp = await this.designer.statusMcp('bible_status', 'Report one short line of progress on the component library (shown to the player).', (step) => this.sc.bibles.update(job.id, { step }));
      res = await this.designer.runTurn(turn, {
        id: job.id,
        bp: '_bible',
        sessionKey,
        cwd: scratch,
        prompt,
        mcp,
        model: this.model(job),
        ...(p.budgetLeft !== undefined ? { maxBudgetUsd: p.budgetLeft } : {}),
        own: path.join('bible', 'components.mjs'),
        system: bibleSystemPrompt(),
        label: `bible ${job.id}`,
        ...(resume ? { resume } : {}),
        onMessage: (msg: SDKMessage) => {
          if (msg.type === 'result') this.sc.bibles.setCost(job.id, meter.observe(costFromResult(msg as unknown as Record<string, unknown>)));
        },
      });
    } finally {
      this.aborts.delete(job.id);
    }
    work.cost = meter.commit();
    this.sc.bibles.setCost(job.id, work.cost);
    const reason = res.reason === 'cancel' || res.reason === 'shutdown' ? res.reason : undefined;
    // the budget ran out during the pass: what the agent wrote is still checked (the runner fails the job with
    // "budget" only when the check fails and nothing is left for another round)
    if (!reason && !res.stats.limited && !res.stats.authFailed && res.stats.subtype === 'error_max_budget_usd') {
      this.sc.log.warn(`bible ${job.id}: the budget ran out during the component pass; checking what is there`);
      return { ok: true };
    }
    const end = this.ended(job.id, res.stats, reason, job.request.budgetUsd, work.cost.usd);
    if (end) return end;
    // a turn that ended in an error still gets its file checked (it may have written it before)
    return { ok: true };
  }
}
