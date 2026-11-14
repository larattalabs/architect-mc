// (7c AU) Program authoring, `Regions.authorProgram` (docs/CONTRACT.md "Phase 7c" §3 row 13, S-7c-5; "Slice AU as built"): an authoring
// session writes a region program for a part no catalogue kind fits.
//
//   region.author   ack {designId, adopted?}; a design of kind "program" (design.upsert) whose `result` is {outcome: AUTHORED|NOT_SHOWN, ...}
//                   (below), `program` its record (AuthorState). The design id is the authored program's id.
//
// Rounds (the rounds harness, jobs/rounds.ts; at most AUTHOR_ROUNDS = 4, a caller may ask fewer with ext architect_mc:authorRounds; no
// critic): each round's structured job answers {source, reason}; the helper's checker (Regions.authorCheck: kit/tools/region.mjs
// author-check IN THE PLAN SANDBOX) lints the source (kit/lib/plan/authored.mjs: the realise lint's forms and the plan-path rules), plans it
// over the claim's survey with the Style's roles and runs the region checker (its errors and its M3 support rules). No findings: the
// session ends AUTHORED {programId, sha, source, reason}; the mod installs the source world-local, owned by the caller, and a plan names it
// {template: authored, params: {id, sha}}. Findings: the next round gets the program and the findings. After the last round with findings:
// NOT_SHOWN with them (the design is done either way; a budget stop fails it, with the NOT_SHOWN result).
//
// Result: {outcome, programId?, sha?, source?, reason, rounds, findings (the last round's), history [{round, sha, findings: n}], cost (usd),
// planId?, partId?}. The record is the state: a restart re-enters at the first round without an answer or a check (the check is
// deterministic: the same source, survey and Style give the same findings).
//
// Sim backend: ext["architect:simAuthor"] = [answer per round] ({source, reason}; a later round reuses the last) scripts the rounds;
// otherwise the stand-in answers SIM_SOURCE (a paved court with a lot), every round. Never a model.
import path from 'node:path';
import fs from 'node:fs';
import type { z } from 'zod';
import { isFinalJob } from './jobs/book.js';
import { finishRound, roundsCost, startRound, type RoundJob, type RoundRecord } from './jobs/rounds.js';
import { AUTHORED_SOURCE_MAX, type Cost, type Design, type DesignRequest, type RegionAuthorMsg } from './protocol.js';
import { ClientError } from './errors.js';
import type { Sidecar } from './sidecar.js';
import { truncate } from './util/text.js';
import { isFinalDesign } from './designs.js';
import { surveySummary } from './regiondesign.js';

type AuthorMsg = z.infer<typeof RegionAuthorMsg>;

/** The job owner of an authoring round. */
export const AUTHOR_OWNER = 'architect:region.author';
/** At most this many rounds (the contract's "checker-driven rounds, at most 4"). */
export const AUTHOR_ROUNDS = 4;
/** `ext["architect_mc:authorRounds"]`: the caller's round cap, 1 to AUTHOR_ROUNDS. */
export const EXT_AUTHOR_ROUNDS = 'architect_mc:authorRounds';
/** The kit file holding the author's prompt text (`## system`, `## answer`, `## repair`). */
export const AUTHOR_PROMPTS = path.join('prompts', 'author.md');
/** The closed import list and Math members (kit/lib/plan/authored.mjs's; the prompt names them). */
export const AUTHOR_IMPORTS = ['../lib/region/program.mjs', '../lib/region/geom.mjs', '../lib/noise.mjs'];
export const AUTHOR_MATH = ['floor', 'ceil', 'round', 'trunc', 'sign', 'sqrt', 'abs', 'min', 'max', 'imul'];

export interface AuthorText {
  system: string;
  answer: string;
  repair: string;
}
const textCache = new Map<string, AuthorText>();
/** Reads `kit/prompts/author.md` (once per kit dir), `{imports}` and `{math}` filled in. Throws when the kit lacks it or a section. */
export function authorText(kitDir: string): AuthorText {
  const file = path.join(kitDir, AUTHOR_PROMPTS);
  const hit = textCache.get(file);
  if (hit) return hit;
  let src: string;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`the kit has no ${AUTHOR_PROMPTS} (an older kit)`);
  }
  const out: Record<string, string[]> = {};
  let cur: string | undefined;
  for (const line of src.split('\n')) {
    const m = /^## (system|answer|repair)\s*$/.exec(line);
    if (m) cur = m[1]!;
    else if (cur) (out[cur] ??= []).push(line);
  }
  const get = (k: string) => {
    const t = (out[k] ?? []).join('\n').trim().replaceAll('{imports}', AUTHOR_IMPORTS.map((x) => `'${x}'`).join(', ')).replaceAll('{math}', AUTHOR_MATH.join(', '));
    if (!t) throw new Error(`${AUTHOR_PROMPTS} has no "## ${k}" section`);
    return t;
  };
  const t = { system: get('system'), answer: get('answer'), repair: get('repair') };
  textCache.set(file, t);
  return t;
}

/** The answer's schema: the program's whole source, and why. */
export const AUTHOR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'reason'],
  properties: {
    source: { type: 'string', description: 'the complete region program: one ES module (export const id, params, default (ctx) => Region)' },
    reason: { type: 'string', description: 'one or two sentences: what it builds (or what this round changed)' },
  },
};

export interface AuthorFinding {
  rule: string;
  message: string;
  line?: number;
}

/** An authoring round: the harness's record plus the source it answered; `check` is {sha, findings, irSha?, cells?}. */
export interface AuthorRound extends RoundRecord {
  source?: string;
  reason?: string;
}

/** What a program design keeps in its record (`design.program`). */
export interface AuthorState {
  brief: string;
  claim: AuthorMsg['claim'];
  surveyBlobId: string;
  surveySummary?: string;
  style?: { id: string; version: number };
  model: string;
  budgetUsd?: number;
  owner?: string;
  opKey?: string;
  planId?: string;
  partId?: string;
  maxRounds: number;
  rounds: AuthorRound[];
}

// ---- pure helpers (tested) ----------------------------------------------------------------------------

/** The caller's round cap (ext architect_mc:authorRounds: an integer 1-4; absent: 4); anything else refuses FIELD_LIMIT. */
export function authorRounds(ext: Record<string, unknown> | undefined): number {
  const v = ext?.[EXT_AUTHOR_ROUNDS];
  if (v === undefined) return AUTHOR_ROUNDS;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > AUTHOR_ROUNDS) throw new ClientError(`FIELD_LIMIT: ext ${EXT_AUTHOR_ROUNDS} must be an integer from 1 to ${AUTHOR_ROUNDS}`);
  return v;
}

export interface AuthorInput {
  brief: string;
  claim: AuthorMsg['claim'];
  summary: string;
  style?: string;
  roles: string[];
  partId?: string;
  answer: string;
}

/** Round 1's prompt: the brief, the claim, the land, the Style's roles, the closing text. */
export function authorPrompt(i: AuthorInput): string {
  const c = i.claim;
  return [
    '## The request',
    i.brief,
    ...(i.partId ? ['', `(for the plan part \`${i.partId}\`, which no catalogue kind fits)`] : []),
    '',
    '## The claim',
    `x ${c.minX}..${c.maxX}, z ${c.minZ}..${c.maxZ} (${c.maxX - c.minX + 1} x ${c.maxZ - c.minZ + 1} columns), y ${c.minY}..${c.maxY}. The program plans this claim as a whole-claim zone.`,
    '',
    '## The land (the survey)',
    i.summary || '(no summary)',
    '',
    '## Roles',
    `${i.style ? `The Style ${i.style}: ` : 'The default roles: '}${i.roles.join(', ')}`,
    '',
    i.answer,
  ].join('\n');
}

/** A later round's prompt: round 1's, the last program and its findings, the closing text. */
export function authorRepairPrompt(first: string, prev: AuthorRound, closing: string): string {
  const findings = (prev.check?.findings as AuthorFinding[] | undefined) ?? [];
  return [
    first,
    '',
    `## Round ${prev.n}'s program`,
    '```js',
    prev.source ?? '',
    '```',
    '',
    `## The checker's findings (${findings.length})`,
    ...(prev.error ? [`- the round failed: ${prev.error}`] : []),
    ...findings.map((f) => `- ${f.rule}${f.line ? ` (line ${f.line})` : ''}: ${f.message}`),
    '',
    closing,
  ].join('\n');
}

/** The opKey body of an authoring request: the request without its key and its blob ids (re-uploaded per call). */
export function authorKeyBody(msg: Record<string, unknown>): Record<string, unknown> {
  const { opKey: _k, surveyBlobId: _s, surveySummary: _m, id: _i, v: _v, ...rest } = msg;
  return rest;
}

/** The sim stand-in's program (kit/test/fixtures/au/courtyard.mjs): a paved court at the claim's centre with a lot beside it. */
export const SIM_SOURCE = `import { region } from '../lib/region/program.mjs';

export const id = 'au_courtyard';
export const params = { size: { type: 'int', min: 8, max: 48, default: 16, label: 'Court size' } };
export const catalogue = { claim: { min: [32, 32], max: [512, 512] } };

export default function courtyard(ctx) {
  const { claim, survey, params: P } = ctx;
  const r = region(ctx);
  r.stages(['ground', 'lots']);
  const cx = claim.minX + Math.floor((claim.maxX - claim.minX + 1) / 2), cz = claim.minZ + Math.floor((claim.maxZ - claim.minZ + 1) / 2);
  const h = Math.floor(P.size / 2);
  const y = survey.heightAt(cx, cz);
  r.part('court', { stage: 'ground' }).platform([[cx - h, cz - h], [cx + h, cz - h], [cx + h, cz + h], [cx - h, cz + h]], y, { material: 'path' });
  r.part('lots', { stage: 'ground' }).lot('lot_1', { at: [cx - 4, cz + h + 3], size: [9, 9], front: 'north', max: [9, 10, 9], brief: 'Gatehouse', stage: 'lots' });
  r.anchor('entrance', [cx, cz + h + 1]);
  r.anchor('spawn', [cx + 1, cz + h + 1]);
  return r;
}
`;
export function simAuthor(): { source: string; reason: string } {
  return { source: SIM_SOURCE, reason: 'the sim stand-in: a paved court at the claim\'s centre with a lot beside it' };
}

/** The findings of a round's check (none when it has no check). */
export function roundFindings(r: AuthorRound | undefined): AuthorFinding[] {
  return Array.isArray(r?.check?.findings) ? (r.check.findings as AuthorFinding[]) : [];
}
const clean = (r: AuthorRound | undefined) => !!r && !r.error && !!r.check && roundFindings(r).length === 0 && typeof r.source === 'string';

// ---- the designs ----------------------------------------------------------------------------------------

export class AuthorDesigns {
  private driving = new Map<string, Promise<void>>();

  constructor(private sc: Sidecar) {}

  roundJob(model: string, system: string): RoundJob {
    return { kind: 'structured', system, schema: AUTHOR_SCHEMA, model, maxTurns: 3, owner: AUTHOR_OWNER, what: 'author' };
  }

  /** region.author: refused at once (no Claude, a bad survey or Style, a bad round cap), adopted by its key, else a design that runs. */
  request(msg: AuthorMsg): { designId: string; adopted?: boolean } {
    const sc = this.sc;
    const key = msg.opKey;
    const body = authorKeyBody(msg as unknown as Record<string, unknown>);
    const prior = key ? sc.opKeys.check('author', msg.owner, key, body) : undefined;
    const pd = prior ? sc.designs.get(prior) : undefined;
    if (pd) {
      sc.log.info(`design ${pd.id}: authoring adopted by opKey ${key} (${pd.status})`);
      return { designId: pd.id, adopted: true };
    }
    const maxRounds = authorRounds(msg.ext as Record<string, unknown> | undefined);
    try {
      authorText(sc.config.kitDir);
    } catch (e) {
      throw new ClientError((e as Error).message);
    }
    if (!sc.regions.kitInfo().caps.authorCheck) throw new ClientError(`the kit (${sc.regions.kitInfo().kitVersion}) has no authoring checker (region.mjs author-check)`);
    sc.ensureClaudeAvailable();
    try {
      surveySummary(sc.blobs.read(msg.surveyBlobId));
    } catch (e) {
      throw new ClientError(`survey ${msg.surveyBlobId}: ${(e as Error).message}`);
    }
    const style = msg.style ? sc.bibleIndex.resolve(msg.style).pin : undefined;
    const model = msg.model ?? sc.config.regions.designModel ?? sc.config.jobs.model;
    const c = msg.claim;
    const size = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
    const req: DesignRequest = {
      type: 'program',
      style: truncate(style?.id ?? 'program', 40),
      features: [],
      maxSize: { x: size(c.maxX - c.minX + 1, 7, 96), y: size(c.maxY - c.minY + 1, 6, 64), z: size(c.maxZ - c.minZ + 1, 7, 96) },
      name: truncate(msg.brief, 40),
      notes: truncate(msg.brief, 2000),
      model,
      ...(msg.budgetUsd !== undefined ? { budgetUsd: msg.budgetUsd } : {}),
      ...(msg.owner ? { owner: msg.owner } : {}),
      ...(msg.ext ? { ext: msg.ext } : {}),
      ...(key ? { opKey: key } : {}),
    } as DesignRequest;
    const st: AuthorState = {
      brief: msg.brief,
      claim: msg.claim,
      surveyBlobId: msg.surveyBlobId,
      ...(msg.surveySummary ? { surveySummary: msg.surveySummary } : {}),
      ...(style ? { style } : {}),
      model,
      ...(msg.budgetUsd !== undefined ? { budgetUsd: msg.budgetUsd } : {}),
      ...(msg.owner ? { owner: msg.owner } : {}),
      ...(key ? { opKey: key } : {}),
      ...(msg.planId ? { planId: msg.planId } : {}),
      ...(msg.partId ? { partId: msg.partId } : {}),
      maxRounds,
      rounds: [],
    };
    const d = sc.designs.create(req, undefined, { kind: 'program', program: st as unknown as Record<string, unknown> });
    if (key) sc.opKeys.record('author', msg.owner, key, body, d.id);
    sc.designs.update(d.id, { status: 'designing', step: 'authoring the program' });
    sc.log.info(`design ${d.id}: authoring requested ("${truncate(msg.brief, 80)}", claim ${c.maxX - c.minX + 1}x${c.maxZ - c.minZ + 1}, ${model}, at most ${maxRounds} rounds${msg.budgetUsd !== undefined ? `, budget $${msg.budgetUsd}` : ''})`);
    void this.drive(d.id);
    return { designId: d.id, ...(key ? { adopted: false } : {}) };
  }

  /** After a restart: every unfinished program design carries on. */
  resume(): void {
    for (const d of this.sc.designs.active()) if (d.kind === 'program') void this.drive(d.id);
  }

  /** design.cancel of a program design: its running round's job is cancelled too. */
  cancelled(d: Design): void {
    for (const r of this.state(d)?.rounds ?? []) {
      const j = this.sc.jobs.book.get(r.jobId);
      if (j && !isFinalJob(j)) {
        try {
          this.sc.jobs.cancel(r.jobId);
        } catch {
          /* already ending */
        }
      }
    }
  }

  private state(d: Design): AuthorState {
    return d.program as unknown as AuthorState;
  }

  private save(id: string, st: AuthorState, patch: Parameters<Sidecar['designs']['update']>[1] = {}): void {
    this.sc.designs.update(id, { ...patch, program: structuredClone(st) as unknown as Record<string, unknown> });
    this.sc.store.markDirty();
  }

  private cost(st: AuthorState): Cost {
    return roundsCost(st.rounds);
  }

  private left(st: AuthorState): number | undefined {
    return st.budgetUsd !== undefined ? Math.round((st.budgetUsd - this.cost(st).usd) * 1e6) / 1e6 : undefined;
  }

  private fail(id: string, st: AuthorState, error: string, result?: Record<string, unknown>): void {
    this.sc.log.warn(`design ${id}: authoring failed: ${truncate(error, 300)}`);
    this.sc.designs.update(id, { status: 'failed', step: error === 'budget' ? 'stopped by its budget' : 'failed', error, cost: this.cost(st), program: structuredClone(st) as unknown as Record<string, unknown>, ...(result ? { result: { ...result, cost: this.cost(st).usd } } : {}) });
  }

  async drive(id: string): Promise<void> {
    const running = this.driving.get(id);
    if (running) return running;
    const p: Promise<void> = (async () => {
      try {
        await this.run(id);
      } catch (e) {
        const d = this.sc.designs.get(id);
        this.sc.log.error(`design ${id}: ${(e as Error).stack ?? e}`);
        if (d && !isFinalDesign(d)) this.fail(id, this.state(d), `internal error: ${(e as Error).message}`);
      } finally {
        this.driving.delete(id);
      }
    })();
    this.driving.set(id, p);
    return p;
  }

  private async run(id: string): Promise<void> {
    const sc = this.sc;
    const d0 = sc.designs.get(id);
    if (!d0 || isFinalDesign(d0) || d0.kind !== 'program') return;
    const st = this.state(d0);
    const ext = (d0.request.ext ?? {}) as Record<string, unknown>;
    let summary = st.surveySummary ?? '';
    try {
      summary = summary || surveySummary(sc.blobs.read(st.surveyBlobId));
    } catch (e) {
      return this.fail(id, st, `survey ${st.surveyBlobId}: ${(e as Error).message}`);
    }
    let roles: string[] = ['rock', 'surface', 'subsurface', 'rubble', 'rail', 'structure', 'path', 'foundation'];
    let text: AuthorText;
    try {
      if (st.style) roles = Object.keys(sc.bibleIndex.resolve(st.style).info.roles ?? {}).sort();
      text = authorText(sc.config.kitDir);
    } catch (e) {
      return this.fail(id, st, (e as Error).message);
    }
    const job = this.roundJob(st.model, text.system);
    const first = authorPrompt({ brief: st.brief, claim: st.claim, summary, style: st.style ? `${st.style.id} v${st.style.version}` : undefined, roles, partId: st.partId, answer: text.answer });
    const scripted = ext['architect:simAuthor'];
    const sim = sc.designerName() === 'sim' ? (Array.isArray(scripted) && scripted.length ? scripted : [simAuthor()]) : undefined;

    for (let i = 0; i < st.maxRounds; i++) {
      let r = st.rounds[i];
      if (!r) {
        const prev = st.rounds[i - 1];
        if (clean(prev)) break;
        const left = this.left(st);
        if (left !== undefined && left <= 0) return this.fail(id, st, 'budget', this.outcome(id, st));
        const prompt = prev ? authorRepairPrompt(first, prev, text.repair) : first;
        try {
          r = startRound(sc, job, { designId: id, n: i + 1, prompt, budgetUsd: left, ...(sim ? { simAnswer: sim[Math.min(i, sim.length - 1)] } : {}) });
        } catch (e) {
          return this.fail(id, st, `round ${i + 1} did not start: ${(e as Error).message}`);
        }
        st.rounds.push(r);
        this.save(id, st, { status: 'designing', step: i === 0 ? 'authoring the program' : `repairing the program (round ${i + 1} of ${st.maxRounds})` });
      }
      if (r.answer === undefined && r.error === undefined) {
        const how = await finishRound(sc, id, r);
        if (how === 'gone') return;
        if (how === 'done') {
          const a = (r.answer ?? {}) as Record<string, unknown>;
          (r as AuthorRound).source = typeof a.source === 'string' ? a.source : '';
          if (typeof a.reason === 'string') (r as AuthorRound).reason = truncate(a.reason, 2000);
          // the record keeps the source; the answer's copy is dropped (it is the same string)
          r.answer = { reason: (r as AuthorRound).reason ?? '' };
        }
        this.save(id, st, { cost: this.cost(st) });
      }
      if (r.error !== undefined) {
        if (r.error === 'budget') return this.fail(id, st, 'budget', this.outcome(id, st));
        return this.fail(id, st, `round ${r.n} failed: ${r.error}`, this.outcome(id, st));
      }
      if (!r.check) {
        const src = (r as AuthorRound).source ?? '';
        sc.designs.update(id, { status: 'checking', step: `checking the program (round ${r.n})` });
        if (Buffer.byteLength(src, 'utf8') > AUTHORED_SOURCE_MAX) r.check = { findings: [{ rule: 'size', message: `the source is more than ${AUTHORED_SOURCE_MAX} bytes` }] };
        else if (!src.trim()) r.check = { findings: [{ rule: 'exports', message: 'the answer held no source' }] };
        else {
          try {
            r.check = await sc.regions.authorCheck(path.join(sc.config.dataDir, 'regions', 'author', id, `round-${r.n}`), { source: src, surveyBlobId: st.surveyBlobId, claim: st.claim, ...(st.style ? { style: st.style } : {}) });
          } catch (e) {
            return this.fail(id, st, `round ${r.n}'s check did not run: ${(e as Error).message}`, this.outcome(id, st));
          }
        }
        const cur = sc.designs.get(id);
        if (!cur || isFinalDesign(cur)) return;
        this.save(id, st, { status: 'designing', step: `round ${r.n} checked: ${roundFindings(r).length ? `${roundFindings(r).length} finding(s)` : 'clean'}` });
      }
    }
    const result = this.outcome(id, st);
    const cost = this.cost(st);
    sc.log.info(`design ${id}: authoring ${String(result.outcome)} ($${cost.usd.toFixed(4)}, ${st.rounds.length} round${st.rounds.length === 1 ? '' : 's'})`);
    sc.designs.update(id, { status: 'done', step: result.outcome === 'AUTHORED' ? 'authored a program' : 'no program passed the checker', cost, program: structuredClone(st) as unknown as Record<string, unknown>, result: { ...result, cost: cost.usd } });
  }

  /** The result from the record: AUTHORED (the last round clean) or NOT_SHOWN with the last round's findings. */
  private outcome(id: string, st: AuthorState): Record<string, unknown> {
    const last = st.rounds[st.rounds.length - 1] as AuthorRound | undefined;
    const history = st.rounds.map((r) => ({ round: r.n, ...(typeof r.check?.sha === 'string' ? { sha: r.check.sha } : {}), ...(r.error ? { error: r.error } : { findings: roundFindings(r).length }) }));
    const base = { rounds: st.rounds.length, history, ...(st.planId ? { planId: st.planId } : {}), ...(st.partId ? { partId: st.partId } : {}) };
    if (clean(last)) return { outcome: 'AUTHORED', programId: id, sha: String(last!.check!.sha), source: last!.source, reason: last!.reason ?? '', findings: [], ...base };
    return { outcome: 'NOT_SHOWN', reason: last ? (last.error ? `round ${last.n} failed: ${last.error}` : `no round's program passed the checker (round ${last.n}: ${roundFindings(last).length} finding(s))`) : 'no round answered', findings: roundFindings(last), ...base };
  }
}
