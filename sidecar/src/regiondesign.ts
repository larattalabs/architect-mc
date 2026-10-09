// (6b) Template-first `Regions.design` (docs/CONTRACT.md "# Phase 6b contract" §7.1 and "Changes from Steward's review of
// 6b" S-6b-2, S-6b-3; kit/REGIONS.md "Protocol (2, additive)": region.design):
//
//   region.design  ack {designId}; a design of kind "region" (design.upsert) whose `result` is
//                  {outcome: PICKED|NO_TEMPLATE, fits, program, params, reason, cost, planId?, tries}.
//
// One structured job (job runner, JSON schema {fits, program, params, reason}; the sidecar's configured auth like every
// job) picks a bundled program from the kit's catalogue (`node kit/tools/region.mjs catalogue --json`, sandboxed) given the
// brief, the caller's card fields, the survey summary (stats and a 64x64 ASCII grid, from the ARSV survey blob), the claim,
// the bible's role names and the rules the caller must pass. The answer is validated against the catalogue (unknown program,
// unknown param, wrong type, out of range, a fit outside the program's claim range); an invalid answer gets ONE more job
// with the errors, then the outcome is NO_TEMPLATE. With a valid fit (and `plan` not false) the sidecar starts region.plan
// itself (no further model call) and names its planId. Without a fit the result still offers the closest program and
// params, with fits: false and the reason (S-6b-3). `requireFit: true` makes no fit a failed design (error NO_TEMPLATE).
//
// Cost: the jobs' estimated USD summed (design.cost is the summed Cost, result.cost its usd); `budgetUsd` stops it like
// any 4a budget (a try gets what is left; nothing left: the design fails "budget").
//
// Sim backend: ext["architect:simAnswers"] = [answer for try 1, answer for try 2] scripts the pick ({simFail} fails a
// try's job); otherwise the sim answers from the schema (fits, the first program, no params).
import type { z } from 'zod';
import { addCost, zeroCost } from './jobs/cost.js';
import { isFinalJob } from './jobs/book.js';
import type { Cost, Design, DesignRequest, Job, RegionDesignMsg } from './protocol.js';
import { ClientError } from './errors.js';
import type { Sidecar } from './sidecar.js';
import { truncate } from './util/text.js';
import { isFinalDesign } from './designs.js';

type DesignMsg = z.infer<typeof RegionDesignMsg>;

/** The job owner of a pick (job records, logs). */
export const PICK_OWNER = 'architect:region.design';
/** Tries per design: the pick plus one retry with the validation errors. */
export const MAX_TRIES = 2;
/** The ASCII grid's largest side (4a's Sample.SUMMARY_GRID). */
export const SUMMARY_GRID = 64;

export const PICK_SYSTEM =
  'You work inside the Architect Minecraft mod. You pick one bundled region program (a template for a whole site: terrain, paths and building lots) for a request, or say that none fits. Answer with your structured output only, exactly as its schema asks.';

// ---- the catalogue ------------------------------------------------------------------------------------

export interface CatalogueParam {
  type: string;
  min?: number;
  max?: number;
  default?: unknown;
  options?: string[];
  label?: string;
}
export interface CatalogueProgram {
  id: string;
  description: string;
  params: Record<string, CatalogueParam>;
  needs?: Record<string, unknown>;
  claim?: { min?: [number, number]; max?: [number, number] };
}

/** The `catalogue --json` output -> programs (malformed entries are dropped). */
export function parseCatalogue(out: Record<string, unknown>): CatalogueProgram[] {
  const list = Array.isArray(out.programs) ? out.programs : [];
  const progs: CatalogueProgram[] = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    const params: Record<string, CatalogueParam> = {};
    if (o.params && typeof o.params === 'object' && !Array.isArray(o.params))
      for (const [k, v] of Object.entries(o.params as Record<string, unknown>)) if (v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string') params[k] = v as CatalogueParam;
    const pair = (v: unknown) => (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number') ? (v as [number, number]) : undefined);
    const c = o.claim && typeof o.claim === 'object' ? (o.claim as Record<string, unknown>) : {};
    const min = pair(c.min);
    const max = pair(c.max);
    progs.push({
      id: o.id,
      description: typeof o.description === 'string' ? o.description : '',
      params,
      ...(o.needs && typeof o.needs === 'object' && !Array.isArray(o.needs) ? { needs: o.needs as Record<string, unknown> } : {}),
      ...(min || max ? { claim: { ...(min ? { min } : {}), ...(max ? { max } : {}) } } : {}),
    });
  }
  return progs;
}

function describeParam(name: string, p: CatalogueParam): string {
  const def = p.default !== undefined ? `, default ${JSON.stringify(p.default)}` : '';
  if (p.type === 'int' || p.type === 'number' || p.type === 'float') return `${name}: ${p.type === 'int' ? 'integer' : 'number'} ${p.min ?? '?'}..${p.max ?? '?'}${def}`;
  if (p.type === 'bool') return `${name}: true or false${def}`;
  if (p.type === 'enum') return `${name}: one of ${(p.options ?? []).join(', ')}${def}`;
  return `${name}: ${p.type}${def}`;
}

/** A program in the prompt: id, description, params with ranges, needs, claim range. */
export function describeProgram(p: CatalogueProgram): string {
  const lines = [`- ${p.id}: ${p.description || '(no description)'}`];
  const params = Object.entries(p.params);
  lines.push(`  params: ${params.length ? params.map(([k, v]) => describeParam(k, v)).join('; ') : 'none'}`);
  if (p.needs) lines.push(`  needs: ${Object.entries(p.needs).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ')}`);
  if (p.claim) lines.push(`  claim: ${p.claim.min ? `${p.claim.min[0]}x${p.claim.min[1]}` : 'any'} to ${p.claim.max ? `${p.claim.max[0]}x${p.claim.max[1]}` : 'any'} columns (x by z)`);
  return lines.join('\n');
}

// ---- validation -------------------------------------------------------------------------------------

export interface PickAnswer {
  fits: boolean;
  program: string;
  params: Record<string, unknown>;
  reason: string;
}

/** Why an answer is not a valid pick for this catalogue and claim ([] = valid). A fit must also hold the claim. */
export function validatePick(answer: unknown, programs: CatalogueProgram[], claimSize: [number, number]): string[] {
  const errors: string[] = [];
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return ['the answer is not an object'];
  const a = answer as Record<string, unknown>;
  if (typeof a.fits !== 'boolean') errors.push('fits must be true or false');
  if (typeof a.reason !== 'string' || !a.reason.trim()) errors.push('reason must be a sentence');
  const prog = programs.find((p) => p.id === a.program);
  if (!prog) {
    errors.push(`program "${String(a.program)}" is not in the catalogue (${programs.map((p) => p.id).join(', ')})`);
    return errors;
  }
  if (!a.params || typeof a.params !== 'object' || Array.isArray(a.params)) {
    errors.push('params must be an object');
    return errors;
  }
  for (const [k, v] of Object.entries(a.params as Record<string, unknown>)) {
    const p = prog.params[k];
    if (!p) {
      errors.push(`${prog.id} has no param "${k}" (it has ${Object.keys(prog.params).join(', ') || 'none'})`);
      continue;
    }
    if (p.type === 'int') {
      if (!Number.isInteger(v)) errors.push(`${k} must be an integer (got ${JSON.stringify(v)})`);
      else if ((p.min !== undefined && (v as number) < p.min) || (p.max !== undefined && (v as number) > p.max)) errors.push(`${k} must be ${p.min ?? '-inf'}..${p.max ?? 'inf'} (got ${v as number})`);
    } else if (p.type === 'number' || p.type === 'float') {
      if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${k} must be a number (got ${JSON.stringify(v)})`);
      else if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max)) errors.push(`${k} must be ${p.min ?? '-inf'}..${p.max ?? 'inf'} (got ${v})`);
    } else if (p.type === 'bool') {
      if (typeof v !== 'boolean') errors.push(`${k} must be true or false (got ${JSON.stringify(v)})`);
    } else if (p.type === 'enum') {
      if (typeof v !== 'string' || !(p.options ?? []).includes(v)) errors.push(`${k} must be one of ${(p.options ?? []).join(', ')} (got ${JSON.stringify(v)})`);
    }
  }
  if (a.fits === true && prog.claim) {
    const [w, d] = claimSize;
    const lo = prog.claim.min;
    const hi = prog.claim.max;
    if ((lo && (w < lo[0] || d < lo[1])) || (hi && (w > hi[0] || d > hi[1])))
      errors.push(`${prog.id} takes a claim of ${lo ? `${lo[0]}x${lo[1]}` : 'any'} to ${hi ? `${hi[0]}x${hi[1]}` : 'any'} columns; this claim is ${w}x${d}, so it does not fit`);
  }
  return errors;
}

/** The valid part of an answer's params (a closest-program offer after the tries ran out). */
export function cleanParams(params: unknown, prog: CatalogueProgram | undefined): Record<string, unknown> {
  if (!prog || !params || typeof params !== 'object' || Array.isArray(params)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (!prog.params[k]) continue;
    const one = { ...prog, params: { [k]: prog.params[k]! } };
    if (!validatePick({ fits: false, program: prog.id, params: { [k]: v }, reason: 'x' }, [one], [0, 0]).length) out[k] = v;
  }
  return out;
}

/** The structured output schema of a pick. */
export function pickSchema(programs: CatalogueProgram[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      fits: { type: 'boolean', description: 'true only when the program really builds what the request asks for, on this site and claim' },
      program: { type: 'string', enum: programs.map((p) => p.id), description: 'the best program, or the closest one when none fits' },
      params: { type: 'object', description: "the program's own params, within their ranges; leave one out for its default" },
      reason: { type: 'string', maxLength: 1000, description: 'one or two sentences: why it fits, or why none does' },
    },
    required: ['fits', 'program', 'params', 'reason'],
    additionalProperties: false,
  };
}

// ---- the survey summary -------------------------------------------------------------------------------

/**
 * 4a's `Sample.summary()` over an ARSV survey (kit/REGIONS.md "Columns codec"): the area, the height range and mean, the
 * water / tree / lava shares, the ground slope, and an ASCII grid of at most 64x64 (north up, x to the right): 0-9 the
 * ground from the lowest to the highest, ~ water, T trees, L lava, ? missing. ARSV has no biomes and no top blocks, so
 * those lines of 4a's summary are absent; heights are the region's ground (water counts as ground: its top).
 */
export function surveySummary(buf: Buffer): string {
  if (buf.length < 28 || buf.toString('latin1', 0, 4) !== 'ARSV') throw new Error('the survey is not an ARSV buffer');
  const minX = buf.readInt32LE(8);
  const minZ = buf.readInt32LE(12);
  const width = buf.readInt32LE(16);
  const depth = buf.readInt32LE(20);
  const res = buf.readInt32LE(24);
  const n = width * depth;
  if (width <= 0 || depth <= 0 || buf.length < 28 + n * 7) throw new Error('the survey is truncated');
  const ground = (k: number) => buf.readInt16LE(28 + k * 2);
  const flags = (k: number) => buf[28 + n * 6 + k]!;
  const WATER = 1;
  const MISSING = 2;
  const TREE = 4;
  const LAVA = 8;
  let present = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let water = 0;
  let tree = 0;
  let lava = 0;
  for (let k = 0; k < n; k++) {
    const f = flags(k);
    if (f & MISSING) continue;
    present++;
    const g = ground(k);
    min = Math.min(min, g);
    max = Math.max(max, g);
    sum += g;
    if (f & WATER) water++;
    if (f & TREE) tree++;
    if (f & LAVA) lava++;
  }
  const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((100 * a) / b));
  const lines: string[] = [];
  lines.push(`survey x ${minX}..${minX + (width - 1) * res}, z ${minZ}..${minZ + (depth - 1) * res}, resolution ${res}: ${width}x${depth} columns, ${n - present} missing`);
  if (!present) {
    lines.push('no loaded columns');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`height ${min}..${max}, mean ${(sum / present).toFixed(1)}; water ${pct(water, present)}%, trees ${pct(tree, present)}%, lava ${pct(lava, present)}%`);
  // the ground slope: the largest ground step to a neighbouring sample (missing neighbours skipped)
  const slopes: number[] = [];
  for (let j = 0; j < depth; j++)
    for (let i = 0; i < width; i++) {
      const k = i + j * width;
      if (flags(k) & MISSING) continue;
      let s = 0;
      for (const [a, b] of [
        [i - 1, j],
        [i + 1, j],
        [i, j - 1],
        [i, j + 1],
      ] as const) {
        if (a < 0 || b < 0 || a >= width || b >= depth) continue;
        const kk = a + b * width;
        if (!(flags(kk) & MISSING)) s = Math.max(s, Math.abs(ground(kk) - ground(k)));
      }
      slopes.push(s);
    }
  slopes.sort((a, b) => a - b);
  const q = (p: number) => slopes[Math.min(slopes.length - 1, Math.floor(p * slopes.length))]!;
  lines.push(`slope (largest ground step to a neighbouring sample, ${res} block${res === 1 ? '' : 's'} apart): median ${q(0.5)}, 90th percentile ${q(0.9)}, max ${slopes[slopes.length - 1]}; flat (step <= 1) ${pct(slopes.filter((s) => s <= 1).length, slopes.length)}%`);
  const step = Math.max(1, Math.ceil(Math.max(width, depth) / SUMMARY_GRID));
  lines.push(`height grid (1 char = ${step} sample column${step === 1 ? '' : 's'}; 0 = y ${min}, 9 = y ${max}; ~ water, T trees, L lava, ? missing):`);
  for (let j = 0; j < depth; j += step) {
    let row = '';
    for (let i = 0; i < width; i += step) {
      const k = i + j * width;
      const f = flags(k);
      if (f & MISSING) row += '?';
      else if (f & WATER) row += '~';
      else if (f & LAVA) row += 'L';
      else if (f & TREE) row += 'T';
      else row += String(max === min ? 0 : Math.round((9 * (ground(k) - min)) / (max - min)));
    }
    lines.push(row);
  }
  return `${lines.join('\n')}\n`;
}

// ---- the prompt -------------------------------------------------------------------------------------

export interface PickInput {
  brief: string;
  card?: DesignMsg['card'];
  claim: DesignMsg['claim'];
  summary: string;
  roles: string[];
  bible?: string | undefined;
  mustPass: string[];
  programs: CatalogueProgram[];
}

export function pickPrompt(i: PickInput): string {
  const c = i.claim;
  const w = c.maxX - c.minX + 1;
  const d = c.maxZ - c.minZ + 1;
  const card = i.card ? Object.entries(i.card).filter(([, v]) => typeof v === 'string' && v.trim()) : [];
  return [
    'Pick the bundled region program (a site template) that best fits this request, or say that none fits.',
    '',
    '## Request',
    `brief: ${i.brief}`,
    ...(card.length ? ['card (the caller\'s own fields, as written):', ...card.map(([k, v]) => `  ${k}: ${v}`)] : []),
    ...(i.mustPass.length ? [`must pass checker rules: ${i.mustPass.join(', ')}`] : []),
    '',
    '## Claim',
    `x ${c.minX}..${c.maxX}, z ${c.minZ}..${c.maxZ} (${w}x${d} columns), y ${c.minY}..${c.maxY}`,
    '',
    '## Style bible',
    i.bible ? `${i.bible}; roles: ${i.roles.join(', ') || 'none'}` : `none (the default roles: ${i.roles.join(', ') || 'rock, surface, subsurface, rubble, rail, structure'})`,
    '',
    '## Site survey',
    i.summary.trimEnd(),
    '',
    '## Catalogue (the only programs there are)',
    ...i.programs.map(describeProgram),
    '',
    '## How to answer',
    "- fits: true only when the program builds what the request asks for (its kind of site, not just a word in common), and the site and the claim are within the program's needs and claim range. A single building, or anything no program builds, does not fit.",
    '- program: the best program; when none fits, still the closest one.',
    "- params: only that program's params, each within its range; leave a param out to use its default. Size them to the claim and the site.",
    '- reason: one or two sentences.',
  ].join('\n');
}

export function retryPrompt(first: string, answer: unknown, errors: string[]): string {
  return `${first}\n\n## Your previous answer\n${truncate(JSON.stringify(answer ?? null), 4000)}\n\nIt is not valid:\n${errors.map((e) => `- ${e}`).join('\n')}\nAnswer again, fixing these.`;
}

// ---- the designs ------------------------------------------------------------------------------------

interface Try {
  jobId: string;
  answer?: unknown;
  errors?: string[];
  cost?: Cost;
  error?: string;
}

/** What a region design keeps in its record (`design.region`). */
export interface RegionState {
  brief: string;
  card?: DesignMsg['card'];
  claim: DesignMsg['claim'];
  surveyBlobId: string;
  bible?: { id: string; version: number };
  mustPass: string[];
  requireFit: boolean;
  plan: boolean;
  model: string;
  budgetUsd?: number;
  tries: Try[];
}

export class RegionDesigns {
  private driving = new Set<string>();

  constructor(private sc: Sidecar) {}

  /** region.design: refused at once (no Claude, a bad survey or bible), else a design that runs at once. */
  request(msg: DesignMsg): Design {
    const sc = this.sc;
    if (msg.bibleVersion !== undefined && !msg.bible) throw new ClientError('bibleVersion needs bible');
    sc.ensureClaudeAvailable();
    const survey = sc.blobs.read(msg.surveyBlobId);
    try {
      surveySummary(survey);
    } catch (e) {
      throw new ClientError(`survey ${msg.surveyBlobId}: ${(e as Error).message}`);
    }
    const bible = msg.bible ? sc.bibleIndex.resolve(msg.bibleVersion ? { id: msg.bible, version: msg.bibleVersion } : msg.bible).pin : undefined;
    const model = msg.model ?? sc.config.regions.designModel ?? sc.config.jobs.model;
    const c = msg.claim;
    const size = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
    // the record's building-shaped request (Design.request): what the pick is about, in its fields
    const req: DesignRequest = {
      type: 'region',
      style: truncate(msg.card?.style ?? 'region', 40),
      features: [],
      maxSize: { x: size(c.maxX - c.minX + 1, 7, 96), y: size(c.maxY - c.minY + 1, 6, 64), z: size(c.maxZ - c.minZ + 1, 7, 96) },
      name: truncate(msg.card?.purpose ?? msg.brief, 40),
      notes: truncate(msg.brief, 2000),
      model,
      ...(msg.budgetUsd !== undefined ? { budgetUsd: msg.budgetUsd } : {}),
      ...(msg.owner ? { owner: msg.owner } : {}),
      ...(msg.ext ? { ext: msg.ext } : {}),
    } as DesignRequest;
    const region: RegionState = {
      brief: msg.brief,
      ...(msg.card ? { card: msg.card } : {}),
      claim: msg.claim,
      surveyBlobId: msg.surveyBlobId,
      ...(bible ? { bible } : {}),
      mustPass: msg.mustPass ?? [],
      requireFit: msg.requireFit === true,
      plan: msg.plan !== false,
      model,
      ...(msg.budgetUsd !== undefined ? { budgetUsd: msg.budgetUsd } : {}),
      tries: [],
    };
    const d = sc.designs.create(req, undefined, { kind: 'region', region: region as unknown as Record<string, unknown> });
    sc.designs.update(d.id, { status: 'designing', step: 'picking a region template' });
    sc.log.info(`design ${d.id}: region pick requested ("${truncate(msg.brief, 80)}", claim ${c.maxX - c.minX + 1}x${c.maxZ - c.minZ + 1}, ${model}${msg.budgetUsd !== undefined ? `, budget $${msg.budgetUsd}` : ''})`);
    void this.drive(d.id);
    return sc.designs.get(d.id)!;
  }

  /** After a restart: every unfinished region design carries on (a try's job that was running is waited for). */
  resume(): void {
    for (const d of this.sc.designs.active()) if (d.kind === 'region') void this.drive(d.id);
  }

  private state(d: Design): RegionState {
    return d.region as unknown as RegionState;
  }

  private save(id: string, st: RegionState, patch: Parameters<Sidecar['designs']['update']>[1] = {}): void {
    this.sc.designs.update(id, { ...patch, region: structuredClone(st) as unknown as Record<string, unknown> });
    this.sc.store.markDirty();
  }

  private cost(st: RegionState): Cost {
    return st.tries.reduce((c, t) => addCost(c, t.cost ?? zeroCost()), zeroCost());
  }

  private fail(id: string, st: RegionState, error: string, result?: Record<string, unknown>): void {
    const cost = this.cost(st);
    this.sc.log.warn(`design ${id}: region pick failed: ${truncate(error, 300)}`);
    this.sc.designs.update(id, { status: 'failed', step: error === 'budget' ? 'stopped by its budget' : 'failed', error, cost, region: structuredClone(st) as unknown as Record<string, unknown>, ...(result ? { result } : {}) });
  }

  /** The pick, its retry and the outcome; safe to call again after a restart (it carries on from the record). */
  async drive(id: string): Promise<void> {
    if (this.driving.has(id)) return;
    this.driving.add(id);
    try {
      await this.run(id);
    } catch (e) {
      const d = this.sc.designs.get(id);
      this.sc.log.error(`design ${id}: ${(e as Error).stack ?? e}`);
      if (d && !isFinalDesign(d)) this.fail(id, this.state(d), `internal error: ${(e as Error).message}`);
    } finally {
      this.driving.delete(id);
    }
  }

  private async run(id: string): Promise<void> {
    const sc = this.sc;
    const d0 = sc.designs.get(id);
    if (!d0 || isFinalDesign(d0) || d0.kind !== 'region') return;
    const st = this.state(d0);
    // the inputs: the catalogue, the survey summary, the bible's role names
    sc.designs.update(id, { status: 'designing', step: 'reading the template catalogue' });
    let programs: CatalogueProgram[];
    try {
      programs = await sc.regions.catalogue();
    } catch (e) {
      return this.fail(id, st, `the catalogue: ${(e as Error).message}`);
    }
    if (!programs.length) return this.fail(id, st, 'the kit has no bundled programs in its catalogue');
    let summary: string;
    try {
      summary = surveySummary(sc.blobs.read(st.surveyBlobId));
    } catch (e) {
      return this.fail(id, st, `survey ${st.surveyBlobId}: ${(e as Error).message}`);
    }
    let roles: string[] = ['rock', 'surface', 'subsurface', 'rubble', 'rail', 'structure'];
    if (st.bible) {
      try {
        roles = Object.keys(sc.bibleIndex.resolve(st.bible).info.roles ?? {}).sort();
      } catch (e) {
        return this.fail(id, st, (e as Error).message);
      }
    }
    const claimSize: [number, number] = [st.claim.maxX - st.claim.minX + 1, st.claim.maxZ - st.claim.minZ + 1];
    const first = pickPrompt({ brief: st.brief, card: st.card, claim: st.claim, summary, roles, bible: st.bible ? `${st.bible.id} v${st.bible.version}` : undefined, mustPass: st.mustPass, programs });
    const schema = pickSchema(programs);
    const sim = sc.designs.get(id)?.request.ext?.['architect:simAnswers'];
    const simAnswers = Array.isArray(sim) ? sim : undefined;

    let valid: PickAnswer | undefined;
    for (let i = 0; i < MAX_TRIES && !valid; i++) {
      let t = st.tries[i];
      if (!t) {
        const spent = this.cost(st).usd;
        const left = st.budgetUsd !== undefined ? Math.round((st.budgetUsd - spent) * 1e6) / 1e6 : undefined;
        if (left !== undefined && left <= 0) return this.fail(id, st, 'budget');
        const prev = st.tries[i - 1];
        const prompt = i === 0 ? first : retryPrompt(first, prev?.answer, prev?.errors ?? []);
        let job: Job;
        try {
          job = sc.jobs.runInternal(
            { kind: 'structured', prompt, system: PICK_SYSTEM, model: st.model, schema, maxTurns: 3, owner: PICK_OWNER, tag: `design ${id} region pick try ${i + 1}`, ...(left !== undefined ? { budgetUsd: left } : {}) },
            simAnswers && simAnswers.length ? { simAnswer: simAnswers[Math.min(i, simAnswers.length - 1)] } : {},
          );
        } catch (e) {
          return this.fail(id, st, `the pick did not start: ${(e as Error).message}`);
        }
        t = { jobId: job.id };
        st.tries.push(t);
        this.save(id, st, { step: i === 0 ? 'picking a region template' : `picking again (try ${i + 1} of ${MAX_TRIES}): the answer did not validate` });
      }
      if (t.answer === undefined && t.error === undefined) {
        const job = await sc.jobs.waitFinal(t.jobId);
        const cur = sc.designs.get(id);
        if (!cur || isFinalDesign(cur)) return; // cancelled meanwhile
        t.cost = job.cost ?? zeroCost();
        if (job.status !== 'done') {
          t.error = job.error ?? job.status;
          this.save(id, st, { cost: this.cost(st) });
          return this.fail(id, st, t.error === 'budget' ? 'budget' : `the pick failed: ${t.error}`);
        }
        t.answer = job.result ?? null;
        t.errors = validatePick(t.answer, programs, claimSize);
        this.save(id, st, { cost: this.cost(st) });
        if (t.errors.length) sc.log.warn(`design ${id}: pick try ${i + 1} is not valid: ${truncate(t.errors.join('; '), 300)}`);
      } else if (t.error !== undefined) return this.fail(id, st, t.error === 'budget' ? 'budget' : `the pick failed: ${t.error}`);
      if (t.errors && !t.errors.length) valid = t.answer as PickAnswer;
    }

    const cost = this.cost(st);
    const tries = st.tries.length;
    let result: Record<string, unknown>;
    if (valid && valid.fits) {
      result = { outcome: 'PICKED', fits: true, program: valid.program, params: valid.params, reason: valid.reason, cost: cost.usd, tries };
      if (st.plan) {
        try {
          const p = sc.regions.plan({ v: 1, type: 'region.plan', program: valid.program, params: valid.params, claim: st.claim, surveyBlobId: st.surveyBlobId, ...(st.bible ? { bible: st.bible.id, bibleVersion: st.bible.version } : {}) });
          result.planId = p.planId;
        } catch (e) {
          result.planError = (e as Error).message;
          sc.designs.update(id, { cost, region: structuredClone(st) as unknown as Record<string, unknown> });
          return this.fail(id, st, `picked ${valid.program}, but the plan did not start: ${(e as Error).message}`, result);
        }
      }
    } else if (valid) {
      result = { outcome: 'NO_TEMPLATE', fits: false, program: valid.program, params: valid.params, reason: valid.reason, cost: cost.usd, tries };
    } else {
      // the tries ran out: the closest offer that validates as far as it goes
      const last = (st.tries[st.tries.length - 1]?.answer ?? {}) as Record<string, unknown>;
      const prog = programs.find((p) => p.id === last.program);
      const why = st.tries[st.tries.length - 1]?.errors ?? [];
      result = {
        outcome: 'NO_TEMPLATE',
        fits: false,
        program: prog ? prog.id : null,
        params: cleanParams(last.params, prog),
        reason: truncate(`no valid pick after ${tries} tries (${why.join('; ')})${typeof last.reason === 'string' && last.reason ? `; the model said: ${last.reason}` : ''}`, 2000),
        cost: cost.usd,
        tries,
      };
    }
    const outcome = result.outcome as string;
    sc.log.info(`design ${id}: region pick ${outcome}${result.program ? ` ${String(result.program)}` : ''}${result.planId ? `, plan ${String(result.planId)}` : ''} ($${cost.usd.toFixed(4)}, ${tries} tr${tries === 1 ? 'y' : 'ies'})`);
    if (outcome === 'NO_TEMPLATE' && st.requireFit) return this.fail(id, st, `NO_TEMPLATE: ${String(result.reason)}`, result);
    sc.designs.update(id, {
      status: 'done',
      step: outcome === 'PICKED' ? `picked ${String(result.program)}${result.planId ? `; planning ${String(result.planId)}` : ''}` : `no template fits${result.program ? ` (closest: ${String(result.program)})` : ''}`,
      cost,
      region: structuredClone(st) as unknown as Record<string, unknown>,
      result,
    });
  }

  /** design.cancel of a region design: its running try's job is cancelled too. */
  cancelled(d: Design): void {
    for (const t of (this.state(d)?.tries ?? [])) {
      const j = this.sc.jobs.book.get(t.jobId);
      if (j && !isFinalJob(j)) {
        try {
          this.sc.jobs.cancel(t.jobId);
        } catch {
          /* already ending */
        }
      }
    }
  }
}
