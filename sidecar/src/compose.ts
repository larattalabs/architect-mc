// (7c CO) The standalone composer, `Regions.compose` (docs/CONTRACT.md "Phase 7c" §3 row 12, S-7c-2; "Slice CO as built"): for a player
// or a test with no Steward (Steward's PlanWriter keeps composing plan/0 itself).
//
//   region.compose          ack {designId, adopted?}; a design of kind "settlement" (design.upsert) whose `result` is
//                           {outcome: PICKED|COMPOSED|NO_PLAN, ...} (below), `settlement` its record (ComposeState)
//   region.compose.checked  the mod's check of the round in `settlement.awaiting` ({designId, round, check | refused})
//
// 1. The template pick first: a region.design (TC: the scenario programs, the claim's land check) the sidecar starts with the same brief,
//    claim, volume, Style, owner and budget (`plan: false`, the mod plans a fit). A fit ends the design PICKED {program, params, reason,
//    pick: {designId}}; the mod then plans the program over the claim (its planId joins the result, as 6b's).
// 2. Without a fit: the inputs, once (kept in the record): the claim's affordances (the kit's analysis of the volume, TC's), the top 60
//    of them (planImages.mjs's rankAffordances: score, then id), and with `images` the planning images (a top hillshade numbering them,
//    two sections, an iso; kit/lib/region/planImages.mjs) as blobs.
// 3. Round 1: a structured job (the rounds harness, jobs/rounds.ts) writes a plan/0 document: system = plan/0#compact (the one-line
//    catalogue, 7cF) + the composer's system text (kit/prompts/composer.md, then a caller's rules); the prompt holds the brief, the claim, the Style's roles, the survey summary, the affordances, the
//    pick's closest program, and the images come before it as image blocks. The design waits `checking` with `awaiting {round, plan}`;
//    the mod runs Regions.checkPlan over the plan (the Overworld, no caller anchors, the owner, the Style) and answers
//    region.compose.checked.
// 4. A READY check with an artifact ends the design COMPOSED. Otherwise ONE repair round (a caller may ask for 0-2: ext
//    architect_mc:repairRounds): the first prompt, the round's plan, the check's
//    typed answers (each part not fits/adjusted: class, block, reasons, wouldFit, blockedBy, deviations), and the catalogue's long text
//    (planCatalogueKinds) of the kinds the plan used and the check answered; its plan is checked the same way.
// 5. Still not READY: NO_PLAN with the best round's plan and check (READY, NEEDS_REPAIR, REQUIRED_BLOCKED, INCOMPLETE, MALFORMED, a
//    refused check last; a tie goes to the later round) and `waits`: its parts not fits/adjusted, each with its block and the
//    catalogue's `until`.
//
// Result: {outcome, reason, cost (usd), rounds, history [{round, overall | refused, planSha?}], pick {designId, outcome, program, fits,
// reason}, plan?, check?, round?, waits?, images? [{name, blobId}]}. The plan is the job's answer as written: no id, time or key is
// stamped into it, so the same answers give the same plan bytes with the images on or off. Cost: the pick's and every round's, summed; `budgetUsd` caps them together (a round gets what
// is left; nothing left: the design fails "budget").
//
// Sim backend: ext["architect:simCompose"] = [answer per round] ({plan, reason}; a later round reuses the last) scripts the rounds;
// otherwise the stand-in (simCompose) answers a small plan (a lots zone at the claim's centre and a path from its south edge), the same
// every round. ext["architect:simAnswers"] scripts the pick (region.design's). Never a model.
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { z } from 'zod';
import { addCost, zeroCost } from './jobs/cost.js';
import { isFinalJob } from './jobs/book.js';
import { finishRound, roundsCost, startRound, type RoundJob, type RoundRecord } from './jobs/rounds.js';
import type { Cost, Design, DesignRequest, RegionComposeCheckedMsg, RegionComposeMsg } from './protocol.js';
import { ClientError } from './errors.js';
import type { Sidecar } from './sidecar.js';
import { truncate } from './util/text.js';
import { isFinalDesign } from './designs.js';
import { affordanceSummary, surveySummary } from './regiondesign.js';
import type { PlanImages } from './regions.js';

type ComposeMsg = z.infer<typeof RegionComposeMsg>;
type CheckedMsg = z.infer<typeof RegionComposeCheckedMsg>;

/** The job owner of a composing round. */
export const COMPOSE_OWNER = 'architect:region.compose';
/** Repair rounds after the first (the contract's "one repair round"). */
export const REPAIR_ROUNDS = 1;
/** The rounds in all, by default (a caller may ask for 0 to MAX_REPAIR_ROUNDS repairs: ext architect_mc:repairRounds). */
export const COMPOSE_ROUNDS = 1 + REPAIR_ROUNDS;
/** The composer's system refs: plan/0's compact form (its catalogue one line per kind). */
export const COMPOSE_REFS = ['plan/0#compact'];
/** The affordances the composer is shown (the kit's PLAN_IMAGE_AFFORDANCES). */
export const COMPOSE_AFFORDANCES = 60;
/** A repair prompt's catalogue long text is at most this many characters. */
export const KINDS_TEXT_MAX = 60_000;
/** The built-in anchors (with a caller's own, composeHints.anchors, the only ones a composed plan may name). */
export const BUILTIN_ANCHORS = ['claim_center', 'claim_n', 'claim_e', 'claim_s', 'claim_w'];

/** The kit file holding the composer's prompt text (its `## system`, `## answer` and `## repair` sections). */
export const COMPOSER_PROMPTS = path.join('prompts', 'composer.md');

/** The composer's prompt text, from the kit. */
export interface ComposerText {
  system: string;
  answer: string;
  repair: string;
}

const textCache = new Map<string, ComposerText>();
/** Reads `kit/prompts/composer.md` (once per kit dir): its three sections, `{anchors}` filled in. Throws when the kit lacks one. */
export function composerText(kitDir: string): ComposerText {
  const file = path.join(kitDir, COMPOSER_PROMPTS);
  const hit = textCache.get(file);
  if (hit) return hit;
  let src: string;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`the kit has no ${COMPOSER_PROMPTS} (an older kit)`);
  }
  const out: Record<string, string[]> = {};
  let cur: string | undefined;
  for (const line of src.split('\n')) {
    const m = /^## (system|answer|repair)\s*$/.exec(line);
    if (m) cur = m[1]!;
    else if (cur) (out[cur] ??= []).push(line);
  }
  const get = (k: string) => {
    const t = (out[k] ?? []).join('\n').trim().replaceAll('{anchors}', BUILTIN_ANCHORS.join(', '));
    if (!t) throw new Error(`${COMPOSER_PROMPTS} has no "## ${k}" section`);
    return t;
  };
  const t = { system: get('system'), answer: get('answer'), repair: get('repair') };
  textCache.set(file, t);
  return t;
}

// ---- the caller's ext keys (ComposeRequest.EXT_*; documented in "Slice CO as built") ------------------------------------

/** `ext["architect_mc:composeHints"]`: the caller's structured hints ({zones, parts, ...}), shown to every round as JSON. */
export const EXT_HINTS = 'architect_mc:composeHints';
/** `ext["architect_mc:composeSystem"]`: the caller's rules, appended to the composer's system prompt. */
export const EXT_SYSTEM = 'architect_mc:composeSystem';
/** `ext["architect_mc:repairRounds"]`: repair rounds after the first, 0 to MAX_REPAIR_ROUNDS (default REPAIR_ROUNDS). */
export const EXT_REPAIRS = 'architect_mc:repairRounds';
/** The hints are at most this many characters as JSON. */
export const HINTS_MAX = 16_000;
/** The caller's rules are at most this many characters (with plan/0#compact and the composer's own, well under JOB_SYSTEM_MAX). */
export const CALLER_SYSTEM_MAX = 30_000;
/** At most this many repair rounds (Steward's PlanWriter repairs up to 2). */
export const MAX_REPAIR_ROUNDS = 2;

/** At most this many caller anchors (PlanRequest's ANCHORS_MAX). */
export const ANCHORS_MAX = 64;
const ANCHOR_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/** The caller's options (callerOptions). */
export interface CallerOptions {
  hints?: Record<string, unknown>;
  /** composeHints.anchors: the caller's named positions, checked with every round's plan (PlanRequest.anchors) */
  anchors?: Record<string, [number, number, number]>;
  system?: string;
  repairs: number;
}

/**
 * `composeHints.anchors`: {name: [x, y, z]} (names [a-z][a-z0-9_]{0,31}, not a built-in one, at most 64; integer block positions), the
 * caller's named places (Steward's `stone`, `player`): the composer may name them, and the mod checks each round with them. Throws.
 */
export function hintAnchors(raw: unknown): Record<string, [number, number, number]> {
  const bad = (why: string) => new ClientError(`FIELD_LIMIT: ext["${EXT_HINTS}"].anchors ${why}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('is an object {name: [x, y, z]}');
  const out: Record<string, [number, number, number]> = {};
  const names = Object.keys(raw).sort();
  if (names.length > ANCHORS_MAX) throw bad(`has ${names.length} anchors (at most ${ANCHORS_MAX})`);
  for (const n of names) {
    const v = (raw as Record<string, unknown>)[n];
    if (!ANCHOR_NAME.test(n) || BUILTIN_ANCHORS.includes(n)) throw bad(`"${n}": a name is [a-z][a-z0-9_]{0,31} and not built in`);
    if (!Array.isArray(v) || v.length !== 3 || !v.every((c) => Number.isInteger(c) && Math.abs(c as number) <= 30_000_000)) throw bad(`"${n}" is [x, y, z] in integer blocks`);
    out[n] = [v[0] as number, v[1] as number, v[2] as number];
  }
  return out;
}

/** The caller's ext members the composer reads, validated: {hints?, system?, repairs}. Throws a ClientError (FIELD_LIMIT) naming the key. */
export function callerOptions(ext: Record<string, unknown> | undefined): CallerOptions {
  const e = ext ?? {};
  const out: CallerOptions = { repairs: REPAIR_ROUNDS };
  const h = e[EXT_HINTS];
  if (h !== undefined) {
    if (!h || typeof h !== 'object' || Array.isArray(h)) throw new ClientError(`FIELD_LIMIT: ext["${EXT_HINTS}"] is an object ({zones, parts, ...})`);
    const n = JSON.stringify(h).length;
    if (n > HINTS_MAX) throw new ClientError(`FIELD_LIMIT: ext["${EXT_HINTS}"] is ${n} characters as JSON (at most ${HINTS_MAX})`);
    const { anchors: an, ...rest } = h as Record<string, unknown>;
    if (an !== undefined) out.anchors = hintAnchors(an);
    if (Object.keys(rest).length) out.hints = rest;
  }
  const sy = e[EXT_SYSTEM];
  if (sy !== undefined) {
    if (typeof sy !== 'string') throw new ClientError(`FIELD_LIMIT: ext["${EXT_SYSTEM}"] is a string`);
    if (sy.length > CALLER_SYSTEM_MAX) throw new ClientError(`FIELD_LIMIT: ext["${EXT_SYSTEM}"] is ${sy.length} characters (at most ${CALLER_SYSTEM_MAX})`);
    if (sy.trim()) out.system = sy.trim();
  }
  const r = e[EXT_REPAIRS];
  if (r !== undefined) {
    if (typeof r !== 'number' || !Number.isInteger(r) || r < 0 || r > MAX_REPAIR_ROUNDS) throw new ClientError(`FIELD_LIMIT: ext["${EXT_REPAIRS}"] is an integer 0 to ${MAX_REPAIR_ROUNDS}`);
    out.repairs = r;
  }
  return out;
}

/** A round's system text (after the refs' blocks): the composer's, then the caller's rules under their own heading. */
export function composeSystemText(text: ComposerText, callerSystem?: string): string {
  return callerSystem ? `${text.system}\n\n## The caller's rules (they add to the rules above)\n\n${callerSystem}` : text.system;
}

/** The answer's schema: the plan, and why. */
export const COMPOSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['plan', 'reason'],
  properties: {
    plan: { type: 'object', description: 'the plan: one plan/0 document ({"schemaVersion": "plan/0", "zones": [...], "connectors": [...], "forms": [...], "rules": [...]})' },
    reason: { type: 'string', description: 'one or two sentences: what the plan builds and what it leaves waiting' },
  },
};

/** The check's classes, best first: a round's place in this order (then the later round) picks the best plan. */
const OVERALL_RANK = ['READY', 'NEEDS_REPAIR', 'REQUIRED_BLOCKED', 'INCOMPLETE', 'MALFORMED'];
const GOOD = new Set(['fits', 'adjusted']);

/** An affordance as the composer keeps it (id, kind, box, metrics, score). */
export interface ComposeAffordance {
  id: string;
  kind: string;
  box: Record<string, number>;
  metrics: Record<string, unknown>;
  score?: number;
}

/** A composing round: the harness's record plus the plan it answered (validated as far as an object). */
export interface ComposeRound extends RoundRecord {
  plan?: Record<string, unknown>;
  reason?: string;
}

/** What a settlement design keeps in its record (`design.settlement`). */
export interface ComposeState {
  brief: string;
  claim: ComposeMsg['claim'];
  surveyBlobId: string;
  volume?: { blobId: string; sha: string };
  style?: { id: string; version: number };
  images: boolean;
  model: string;
  budgetUsd?: number;
  owner?: string;
  opKey?: string;
  /** the template pick's design and, once it ended, its answer */
  pick?: { designId: string; outcome?: string; program?: string | null; params?: unknown; fits?: boolean; reason?: string; cost?: Cost; error?: string };
  affordances?: ComposeAffordance[];
  affordanceError?: string;
  planImages?: { images: Array<{ name: string; blobId: string; pixelSha: string; width: number; height: number }>; labels: PlanImages['labels'] };
  planImagesError?: string;
  rounds: ComposeRound[];
  /** repair rounds after the first (ext architect_mc:repairRounds; default REPAIR_ROUNDS) */
  repairs?: number;
  /** the caller's anchors (composeHints.anchors): the mod checks every round with them */
  anchors?: Record<string, [number, number, number]>;
  /** the players' builds meeting the claim, as the mod sent them (id, kind, bounds, entrances) */
  builds?: Array<Record<string, unknown>>;
  /** while the mod checks a round's plan */
  awaiting?: { round: number; plan: Record<string, unknown> };
}

// ---- pure helpers (tested) ----------------------------------------------------------------------------

/** The kit's affordance list -> what the record keeps (with a box; at most 160: AF's 16 per kind over 10 kinds). */
export function keepComposeAffordances(raw: unknown): ComposeAffordance[] {
  if (!Array.isArray(raw)) return [];
  const out: ComposeAffordance[] = [];
  for (const a of raw.slice(0, 160)) {
    if (!a || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    const b = o.box as Record<string, unknown> | undefined;
    if (typeof o.id !== 'string' || typeof o.kind !== 'string' || !b || typeof b !== 'object' || !['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].every((k) => Number.isFinite(b[k]))) continue;
    out.push({ id: o.id, kind: o.kind, box: Object.fromEntries(['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].map((k) => [k, Number(b[k])])), metrics: o.metrics && typeof o.metrics === 'object' ? (o.metrics as Record<string, unknown>) : {}, ...(typeof o.score === 'number' ? { score: o.score } : {}) });
  }
  return out;
}

/** The kit's ranking (planImages.mjs rankAffordances): score descending, then id ascending; the first `n`. */
export function rankAffordances<T extends { id: string; score?: number }>(list: readonly T[], n = COMPOSE_AFFORDANCES): T[] {
  return [...list].sort((a, b) => (Number(b.score ?? 0) - Number(a.score ?? 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, Math.max(0, n));
}

const boxText = (b: Record<string, number>) => `x ${b.minX}..${b.maxX} y ${b.minY}..${b.maxY} z ${b.minZ}..${b.maxZ}`;
const metricsText = (m: Record<string, unknown>) => Object.entries(m).filter(([, v]) => typeof v === 'number' || typeof v === 'string').map(([k, v]) => `${k} ${String(v)}`).join(', ');

/** The numbered affordance list (the images' numbers), or why there is none. */
export function affordanceList(list: ComposeAffordance[] | undefined, note?: string): string {
  if (!list) return `not analysed${note ? ` (${note})` : ''}`;
  if (!list.length) return 'none found';
  return rankAffordances(list).map((a, i) => `${i + 1}. ${a.kind} ${a.id}: ${boxText(a.box)}${Object.keys(a.metrics).length ? ` (${metricsText(a.metrics)})` : ''}`).join('\n');
}

export interface ComposeInput {
  brief: string;
  claim: ComposeMsg['claim'];
  summary: string;
  style?: string | undefined;
  roles: string[];
  affordances?: ComposeAffordance[] | undefined;
  affordanceNote?: string | undefined;
  images: string[];
  pick?: ComposeState['pick'];
  /** the caller's structured hints (ext architect_mc:composeHints, without its anchors) */
  hints?: Record<string, unknown> | undefined;
  /** the caller's anchors (composeHints.anchors) */
  anchors?: Record<string, [number, number, number]> | undefined;
  /** the players' builds in the claim (the mod's) */
  builds?: Array<Record<string, unknown>> | undefined;
  /** the closing "How to answer" text (composer.md's `answer`) */
  answer: string;
}

/** Round 1's prompt. Pure: the same inputs give the same text (the images are named, never described by content). */
export function composePrompt(i: ComposeInput): string {
  const c = i.claim;
  const w = c.maxX - c.minX + 1, d = c.maxZ - c.minZ + 1;
  const pick = i.pick;
  return [
    'Compose the plan for this settlement.',
    '',
    '## Request',
    `brief: ${i.brief}`,
    '',
    '## Claim',
    `x ${c.minX}..${c.maxX}, z ${c.minZ}..${c.maxZ} (${w}x${d} columns), y ${c.minY}..${c.maxY}; north is -z`,
    `anchors: ${BUILTIN_ANCHORS.join(', ')} (built in)${i.anchors && Object.keys(i.anchors).length ? `; the caller's: ${Object.entries(i.anchors).map(([n, p]) => `${n} at ${p.join(' ')}`).join(', ')}` : ''}; none other`,
    '',
    '## Style',
    i.style ? `${i.style}; roles: ${i.roles.join(', ') || 'none'}` : `none (the default roles: ${i.roles.join(', ')})`,
    '',
    '## Site survey',
    i.summary.trimEnd(),
    '',
    `## Site affordances (the land features found in the claim's 3D volume, the best ${COMPOSE_AFFORDANCES} by score${i.images.length ? '; the images number them the same way' : ''})`,
    affordanceList(i.affordances, i.affordanceNote),
    '',
    ...(i.builds?.length ? ['## The player\'s own builds in the claim (keep every part clear of them and their doors; name one as a feature {build: {id}}, a target {build: id} or an endpoint {build: id, port: "door"})', ...i.builds.map((b) => `- ${String(b.id)} (${String(b.kind ?? 'build')}): bounds ${JSON.stringify(b.bounds ?? null)}${Array.isArray(b.entrances) && b.entrances.length ? `, doors ${JSON.stringify(b.entrances)}` : ''}`), ''] : []),
    ...(i.images.length ? ['## Planning images', `${i.images.length} images come before this text: ${i.images.join(', ')}. top: a hillshade, north up, each affordance framed and numbered; section-1: a cut west to east through the claim's middle; section-2: north to south; iso: the land from the south-west.`, ''] : []),
    '## The template pick',
    pick?.program ? `no bundled template fits (the closest: ${pick.program}${pick.reason ? `; ${pick.reason}` : ''}), so compose the settlement from plan/0's parts.` : 'no bundled template fits, so compose the settlement from plan/0\'s parts.',
    '',
    ...(i.hints ? ['## The caller\'s hints (structured; follow them where the land and the catalogue allow)', JSON.stringify(i.hints), ''] : []),
    i.answer,
  ].join('\n');
}

/** One part's typed answer as the repair prompt states it (only what the composer can act on). */
export function partAnswerLine(p: Record<string, unknown>): string {
  const bits: string[] = [`- ${String(p.part)}: ${String(p.class)}${p.block ? ` (${String(p.block)})` : ''}${p.required === true ? ', required' : ''}`];
  const reasons = Array.isArray(p.reasons) ? (p.reasons as Array<Record<string, unknown>>) : [];
  for (const r of reasons.slice(0, 8)) bits.push(`  - ${String(r.code ?? 'REASON')}${r.path ? ` at ${String(r.path)}` : ''}: ${truncate(String(r.message ?? ''), 600)}`);
  if (p.wouldFit !== undefined && p.wouldFit !== null) bits.push(`  - would fit: ${truncate(JSON.stringify(p.wouldFit), 600)}`);
  if (Array.isArray(p.blockedBy) && p.blockedBy.length) bits.push(`  - blocked by: ${truncate(JSON.stringify(p.blockedBy), 600)}`);
  if (Array.isArray(p.deviations) && p.deviations.length) bits.push(`  - deviations: ${truncate(JSON.stringify(p.deviations), 600)}`);
  return bits.join('\n');
}

/** A plan's catalogue kinds: each part's `<family>.<kind>` (a zone without a kind: zone.standard), its program template, sorted. */
export function planKinds(plan: unknown): string[] {
  const out = new Set<string>();
  if (!plan || typeof plan !== 'object') return [];
  const p = plan as Record<string, unknown>;
  for (const [fam, family] of [['zones', 'zone'], ['connectors', 'connector'], ['forms', 'form'], ['rules', 'rule']] as const) {
    for (const part of Array.isArray(p[fam]) ? (p[fam] as unknown[]) : []) {
      if (!part || typeof part !== 'object') continue;
      const q = part as Record<string, unknown>;
      const kind = typeof q.kind === 'string' ? q.kind : family === 'zone' ? 'standard' : null;
      if (kind) out.add(`${family}.${kind}`);
      const prog = q.program as Record<string, unknown> | undefined;
      if (family === 'zone' && prog && typeof prog === 'object' && typeof prog.template === 'string') out.add(`program.${prog.template}`);
    }
  }
  return [...out].sort();
}

/** The kinds a repair round gets the long text of: the plan's and every answered part's block. Sorted. */
export function repairKinds(plan: unknown, check: Record<string, unknown> | undefined): string[] {
  const out = new Set(planKinds(plan));
  for (const p of Array.isArray(check?.parts) ? (check.parts as Array<Record<string, unknown>>) : []) if (typeof p?.block === 'string') out.add(p.block);
  return [...out].sort();
}

/** The repair round's prompt: round 1's, the plan, the typed answers, the catalogue's long text of `kinds`. Pure. */
export function repairPrompt(first: string, round: ComposeRound, kindsText: string, closing: string): string {
  const check = round.check;
  const parts = Array.isArray(check?.parts) ? (check.parts as Array<Record<string, unknown>>) : [];
  const bad = parts.filter((p) => !GOOD.has(String(p.class)));
  const notes = Array.isArray(check?.notes) ? (check.notes as unknown[]).map(String) : [];
  return [
    first,
    '',
    `## Your plan (round ${round.n})`,
    truncate(JSON.stringify(round.plan ?? null), 70_000),
    '',
    '## The check',
    round.refused ? `the check did not run: ${round.refused}` : `overall: ${String(check?.overall ?? 'unknown')}; ${parts.length - bad.length} of ${parts.length} part(s) fit or adjusted`,
    ...bad.map(partAnswerLine),
    ...(notes.length ? ['notes:', ...notes.slice(0, 12).map((n) => `- ${truncate(n, 600)}`)] : []),
    ...(check?.malformed ? [`malformed: ${truncate(JSON.stringify(check.malformed), 2000)}`] : []),
    '',
    '## The catalogue\'s long text of the kinds above',
    kindsText || 'none',
    '',
    closing,
  ].join('\n');
}

/** A round's rank (lower is better): its check's overall in OVERALL_RANK, a refused or missing check last. */
export function roundRank(r: ComposeRound): number {
  if (r.refused || !r.check) return OVERALL_RANK.length;
  const i = OVERALL_RANK.indexOf(String(r.check.overall));
  return i < 0 ? OVERALL_RANK.length : i;
}

/** The best round: the best rank, a tie to the later round. */
export function bestRound(rounds: readonly ComposeRound[]): ComposeRound | undefined {
  let best: ComposeRound | undefined;
  for (const r of rounds) if (r.plan && (!best || roundRank(r) <= roundRank(best))) best = r;
  return best;
}

/** What waits in a check: every part not fits/adjusted, with its block and the catalogue's `until` for it. */
export function waitsOf(check: Record<string, unknown> | undefined, until: Map<string, string>): Array<Record<string, unknown>> {
  const parts = Array.isArray(check?.parts) ? (check.parts as Array<Record<string, unknown>>) : [];
  return parts
    .filter((p) => !GOOD.has(String(p.class)))
    .map((p) => ({ part: p.part, class: p.class, ...(typeof p.block === 'string' ? { block: p.block } : {}), ...(typeof p.block === 'string' && until.has(p.block) ? { until: until.get(p.block) } : {}), ...(p.required === true ? { required: true } : {}) }));
}

/** The check as the record keeps it (what the repair prompt and the result read): the members that matter, bounded. */
export function keepCheck(c: Record<string, unknown>): Record<string, unknown> {
  const parts = Array.isArray(c.parts) ? (c.parts as Array<Record<string, unknown>>) : [];
  return {
    ...(typeof c.checkId === 'string' ? { checkId: c.checkId } : {}),
    overall: typeof c.overall === 'string' ? c.overall : 'MALFORMED',
    ...(typeof c.planSha === 'string' ? { planSha: c.planSha } : {}),
    ...(typeof c.artifactSha === 'string' ? { artifactSha: c.artifactSha } : {}),
    parts: parts.slice(0, 256).map((p) => Object.fromEntries(['part', 'block', 'class', 'required', 'reasons', 'wouldFit', 'blockedBy', 'deviations'].filter((k) => p[k] !== undefined).map((k) => [k, p[k]]))),
    notes: (Array.isArray(c.notes) ? (c.notes as unknown[]).map(String) : []).slice(0, 32),
    ...(c.malformed ? { malformed: c.malformed } : {}),
    ...(c.cost && typeof c.cost === 'object' ? { cost: c.cost } : {}),
  };
}

/** The sim stand-in's plan: a lots zone at the claim's centre and a path to it from the claim's south edge. */
export const SIM_PLAN: Record<string, unknown> = {
  schemaVersion: 'plan/0',
  zones: [{ id: 'town', required: true, program: { lots: [1, 2, 3].map((n) => ({ id: `h${n}`, type: 'house', size: [9, 9] })) }, where: { near: { anchor: 'claim_center', within: 8 } } }],
  connectors: [{ id: 'lane', kind: 'path', from: { anchor: 'claim_s' }, to: { part: 'town' } }],
};
/** The sim stand-in's answer (every round the same). */
export function simCompose(): { plan: Record<string, unknown>; reason: string } {
  return { plan: structuredClone(SIM_PLAN), reason: 'the sim stand-in: three houses at the claim\'s centre and a path from its south edge' };
}

/** The opKey body of a compose request: the request without its key and its blob ids (re-uploaded per call; the volume by its sha). */
export function composeKeyBody(msg: Record<string, unknown>): Record<string, unknown> {
  const { opKey: _k, surveyBlobId: _s, surveySummary: _m, id: _i, v: _v, ...rest } = msg;
  const vol = rest.volume as Record<string, unknown> | undefined;
  return { ...rest, ...(vol && typeof vol === 'object' ? { volume: { sha: vol.sha } } : {}) };
}

// ---- the designs ----------------------------------------------------------------------------------------

/** The kit's catalogue module (planCatalogueKinds), imported once per kit dir. */
const catalogueModules = new Map<string, Promise<Record<string, unknown>>>();
async function kitKinds(kitDir: string, kinds: string[]): Promise<{ entries: Array<Record<string, unknown>> }> {
  const file = path.join(kitDir, 'lib', 'plan', 'catalogue.mjs');
  let mod = catalogueModules.get(file);
  if (!mod) {
    mod = import(pathToFileURL(file).href) as Promise<Record<string, unknown>>;
    catalogueModules.set(file, mod);
  }
  const fn = (await mod).planCatalogueKinds;
  if (typeof fn !== 'function') throw new Error('the kit has no planCatalogueKinds (7cF)');
  return (fn as (k: string[]) => { entries: Array<Record<string, unknown>> })(kinds);
}

export class ComposeDesigns {
  private driving = new Map<string, Promise<void>>();

  constructor(private sc: Sidecar) {}

  /** The job every round runs (its system and schema; the model the request's). */
  roundJob(model: string, system: string): RoundJob {
    return { kind: 'structured', system, systemRefs: [...COMPOSE_REFS], schema: COMPOSE_SCHEMA, model, maxTurns: 3, owner: COMPOSE_OWNER, what: 'compose' };
  }

  /** region.compose: refused at once (no Claude, a bad survey, Style or volume), adopted by its key, else a design that runs at once. */
  request(msg: ComposeMsg): { designId: string; adopted?: boolean } {
    const sc = this.sc;
    const key = msg.opKey;
    const body = composeKeyBody(msg as unknown as Record<string, unknown>);
    const prior = key ? sc.opKeys.check('compose', msg.owner, key, body) : undefined;
    const pd = prior ? sc.designs.get(prior) : undefined;
    if (pd) {
      sc.log.info(`design ${pd.id}: compose adopted by opKey ${key} (${pd.status})`);
      return { designId: pd.id, adopted: true };
    }
    if (msg.volume && !sc.blobs.get(msg.volume.blobId)) throw new ClientError(`volume: no blob "${msg.volume.blobId}"`);
    const opts = callerOptions(msg.ext as Record<string, unknown> | undefined);
    try {
      composerText(sc.config.kitDir);
    } catch (e) {
      throw new ClientError((e as Error).message);
    }
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
      type: 'settlement',
      style: truncate(style?.id ?? 'settlement', 40),
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
    const st: ComposeState = {
      brief: msg.brief,
      claim: msg.claim,
      surveyBlobId: msg.surveyBlobId,
      ...(msg.volume ? { volume: { blobId: msg.volume.blobId, sha: msg.volume.sha } } : {}),
      ...(style ? { style } : {}),
      images: msg.images === true,
      model,
      ...(msg.budgetUsd !== undefined ? { budgetUsd: msg.budgetUsd } : {}),
      ...(msg.owner ? { owner: msg.owner } : {}),
      ...(key ? { opKey: key } : {}),
      rounds: [],
      repairs: opts.repairs,
      ...(opts.anchors && Object.keys(opts.anchors).length ? { anchors: opts.anchors } : {}),
      ...(msg.builds?.length ? { builds: msg.builds.map((b) => Object.fromEntries(['id', 'kind', 'bounds', 'entrances'].filter((k) => b[k] !== undefined).map((k) => [k, b[k]]))) } : {}),
    };
    const d = sc.designs.create(req, undefined, { kind: 'settlement', settlement: st as unknown as Record<string, unknown> });
    if (key) sc.opKeys.record('compose', msg.owner, key, body, d.id);
    sc.designs.update(d.id, { status: 'designing', step: 'picking a region template first' });
    sc.log.info(`design ${d.id}: compose requested ("${truncate(msg.brief, 80)}", claim ${c.maxX - c.minX + 1}x${c.maxZ - c.minZ + 1}, ${model}, images ${st.images ? 'on' : 'off'}${msg.budgetUsd !== undefined ? `, budget $${msg.budgetUsd}` : ''})`);
    void this.drive(d.id);
    return { designId: d.id, ...(key ? { adopted: false } : {}) };
  }

  /** region.compose.checked: the mod's check of the awaited round; the design carries on. */
  checked(msg: CheckedMsg): { designId: string; round: number } {
    const d = this.sc.designs.get(msg.designId);
    if (!d || d.kind !== 'settlement') throw new ClientError(`no settlement design "${msg.designId}"`);
    if (isFinalDesign(d)) throw new ClientError(`design ${d.id} is already ${d.status}`);
    const st = this.state(d);
    if (!st.awaiting || st.awaiting.round !== msg.round) throw new ClientError(`design ${d.id} is not waiting for the check of round ${msg.round}${st.awaiting ? ` (it waits for round ${st.awaiting.round})` : ''}`);
    if (!msg.check === !msg.refused) throw new ClientError('region.compose.checked needs one of check and refused');
    const r = st.rounds[msg.round - 1]!;
    if (msg.check) r.check = keepCheck(msg.check);
    else r.refused = truncate(msg.refused!, 2000);
    delete st.awaiting;
    this.save(d.id, st, { status: 'designing', step: `round ${msg.round} checked: ${r.refused ? 'refused' : String(r.check?.overall)}` });
    void this.drive(d.id);
    return { designId: d.id, round: msg.round };
  }

  /** After a restart: every unfinished settlement design carries on (a round waiting for its check waits again). */
  resume(): void {
    for (const d of this.sc.designs.active()) if (d.kind === 'settlement') void this.drive(d.id);
  }

  /** design.cancel of a settlement design: its pick and its running round's job are cancelled too. */
  cancelled(d: Design): void {
    const st = this.state(d);
    if (st?.pick?.designId) {
      const p = this.sc.designs.get(st.pick.designId);
      if (p && !isFinalDesign(p)) {
        try {
          this.sc.cancelDesign(p.id);
        } catch {
          /* already ending */
        }
      }
    }
    for (const r of st?.rounds ?? []) {
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

  private state(d: Design): ComposeState {
    return d.settlement as unknown as ComposeState;
  }

  private save(id: string, st: ComposeState, patch: Parameters<Sidecar['designs']['update']>[1] = {}): void {
    this.sc.designs.update(id, { ...patch, settlement: structuredClone(st) as unknown as Record<string, unknown> });
    this.sc.store.markDirty();
  }

  private cost(st: ComposeState): Cost {
    return addCost(st.pick?.cost ?? zeroCost(), roundsCost(st.rounds));
  }

  private fail(id: string, st: ComposeState, error: string, result?: Record<string, unknown>): void {
    this.sc.log.warn(`design ${id}: compose failed: ${truncate(error, 300)}`);
    this.sc.designs.update(id, { status: 'failed', step: error === 'budget' ? 'stopped by its budget' : 'failed', error, cost: this.cost(st), settlement: structuredClone(st) as unknown as Record<string, unknown>, ...(result ? { result } : {}) });
  }

  private done(id: string, st: ComposeState, step: string, result: Record<string, unknown>): void {
    const cost = this.cost(st);
    this.sc.log.info(`design ${id}: compose ${String(result.outcome)} ($${cost.usd.toFixed(4)}, ${st.rounds.length} round${st.rounds.length === 1 ? '' : 's'})`);
    this.sc.designs.update(id, { status: 'done', step, cost, settlement: structuredClone(st) as unknown as Record<string, unknown>, result: { ...result, cost: cost.usd } });
  }

  /** The pick, the inputs, the rounds and the outcome; safe to call again (it carries on from the record). */
  async drive(id: string): Promise<void> {
    const running = this.driving.get(id);
    if (running) return running;
    // (`await this.run` always yields once, so the map holds p before its finally runs)
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

  /** What the budget has left (undefined: no budget). */
  private left(st: ComposeState): number | undefined {
    return st.budgetUsd !== undefined ? Math.round((st.budgetUsd - this.cost(st).usd) * 1e6) / 1e6 : undefined;
  }

  private async run(id: string): Promise<void> {
    const sc = this.sc;
    const d0 = sc.designs.get(id);
    if (!d0 || isFinalDesign(d0) || d0.kind !== 'settlement') return;
    const st = this.state(d0);
    const ext = (d0.request.ext ?? {}) as Record<string, unknown>;

    // 1. the template pick
    if (!st.pick) {
      const pick = sc.regionDesigns.request({
        v: 1, type: 'region.design', brief: st.brief, claim: st.claim, surveyBlobId: st.surveyBlobId,
        ...(st.volume ? { volume: st.volume } : {}),
        ...(st.style ? { bible: st.style.id, bibleVersion: st.style.version } : {}),
        model: st.model, ...(st.budgetUsd !== undefined ? { budgetUsd: st.budgetUsd } : {}), requireFit: false, plan: false,
        ...(st.owner ? { owner: st.owner } : {}), ...(Object.keys(ext).length ? { ext } : {}),
      } as Parameters<Sidecar['regionDesigns']['request']>[0]);
      st.pick = { designId: pick.id };
      this.save(id, st, { step: `picking a region template first (${pick.id})` });
    }
    if (st.pick.outcome === undefined && st.pick.error === undefined) {
      await sc.regionDesigns.drive(st.pick.designId);
      const pd = sc.designs.get(st.pick.designId);
      const cur = sc.designs.get(id);
      if (!cur || isFinalDesign(cur)) return;
      if (!pd) {
        st.pick.error = 'the pick\'s design is gone';
      } else if (!isFinalDesign(pd)) {
        return this.fail(id, st, `the pick (${pd.id}) did not end (${pd.status})`);
      } else {
        st.pick.cost = pd.cost ?? zeroCost();
        const r = (pd.result ?? {}) as Record<string, unknown>;
        if (pd.status === 'done') {
          st.pick.outcome = String(r.outcome);
          st.pick.program = typeof r.program === 'string' ? r.program : null;
          st.pick.params = r.params ?? {};
          st.pick.fits = r.fits === true;
          if (typeof r.reason === 'string') st.pick.reason = truncate(r.reason, 2000);
        } else st.pick.error = pd.error ?? pd.status;
      }
      this.save(id, st, { cost: this.cost(st) });
    }
    if (st.pick.error === 'budget') return this.fail(id, st, 'budget');
    const pickOut = { designId: st.pick.designId, outcome: st.pick.outcome ?? 'FAILED', program: st.pick.program ?? null, fits: st.pick.fits === true, ...(st.pick.reason ? { reason: st.pick.reason } : {}), ...(st.pick.error ? { error: st.pick.error } : {}) };
    if (st.pick.outcome === 'PICKED' && st.pick.fits) {
      return this.done(id, st, `picked ${String(st.pick.program)}`, { outcome: 'PICKED', fits: true, program: st.pick.program, params: st.pick.params, reason: st.pick.reason ?? '', rounds: 0, pick: pickOut });
    }

    // 2. the inputs, once
    if (st.volume && st.affordances === undefined && st.affordanceError === undefined) {
      sc.designs.update(id, { status: 'designing', step: 'reading the claim\'s land features' });
      try {
        st.affordances = keepComposeAffordances((await sc.regions.claimAffordances(st.volume.blobId, st.volume.sha)).affordances);
      } catch (e) {
        st.affordanceError = truncate((e as Error).message, 500);
      }
      this.save(id, st);
    }
    if (st.images && !st.planImages && st.planImagesError === undefined) {
      sc.designs.update(id, { status: 'designing', step: 'rendering the planning images' });
      try {
        const pi = await sc.regions.planImages(sc.blobs.file(st.surveyBlobId), st.affordances ?? [], path.join(sc.config.dataDir, 'regions', 'planimages', id));
        st.planImages = { images: pi.images.map(({ file: _f, ...im }) => im), labels: pi.labels };
      } catch (e) {
        st.planImagesError = truncate((e as Error).message, 500);
        sc.log.warn(`design ${id}: the planning images failed: ${st.planImagesError}`);
      }
      this.save(id, st);
    }
    let summary: string;
    try {
      summary = surveySummary(sc.blobs.read(st.surveyBlobId));
    } catch (e) {
      return this.fail(id, st, `survey ${st.surveyBlobId}: ${(e as Error).message}`);
    }
    let roles: string[] = ['rock', 'surface', 'subsurface', 'rubble', 'rail', 'structure'];
    if (st.style) {
      try {
        roles = Object.keys(sc.bibleIndex.resolve(st.style).info.roles ?? {}).sort();
      } catch (e) {
        return this.fail(id, st, (e as Error).message);
      }
    }
    const images = (st.planImages?.images ?? []).filter((im) => sc.blobs.get(im.blobId));
    let text: ComposerText;
    let opts: ReturnType<typeof callerOptions>;
    try {
      text = composerText(sc.config.kitDir);
      opts = callerOptions(ext);
    } catch (e) {
      return this.fail(id, st, (e as Error).message);
    }
    const job = this.roundJob(st.model, composeSystemText(text, opts.system));
    const rounds = 1 + (st.repairs ?? REPAIR_ROUNDS);
    const first = composePrompt({
      brief: st.brief, claim: st.claim, summary, style: st.style ? `${st.style.id} v${st.style.version}` : undefined, roles,
      affordances: st.affordances, affordanceNote: st.affordanceError ?? (st.volume ? undefined : 'the mod sent no volume of the claim'),
      images: images.map((im) => im.name), pick: st.pick, hints: opts.hints, anchors: st.anchors, builds: st.builds, answer: text.answer,
    });
    const scripted = ext['architect:simCompose'];
    const sim = sc.designerName() === 'sim' ? (Array.isArray(scripted) && scripted.length ? scripted : [simCompose()]) : undefined;

    // 3-4. the rounds
    for (let i = 0; i < rounds; i++) {
      let r = st.rounds[i];
      if (!r) {
        const prev = st.rounds[i - 1];
        if (prev && !prev.refused && prev.check && String(prev.check.overall) === 'READY' && prev.check.artifactSha) break;
        const left = this.left(st);
        if (left !== undefined && left <= 0) return this.fail(id, st, 'budget', this.outcome(st, pickOut, await this.until(st)));
        let prompt = first;
        if (prev) {
          const kinds = repairKinds(prev.plan, prev.check);
          let kindsText = '';
          try {
            kindsText = truncate(JSON.stringify((await kitKinds(sc.config.kitDir, kinds)).entries), KINDS_TEXT_MAX);
          } catch (e) {
            kindsText = `unavailable (${(e as Error).message})`;
          }
          prompt = repairPrompt(first, prev, kindsText, text.repair);
        }
        try {
          r = startRound(sc, job, {
            designId: id, n: i + 1, prompt, budgetUsd: left,
            images: images.map((im) => ({ file: sc.blobs.file(im.blobId), label: `planning image ${im.name}` })),
            ...(sim ? { simAnswer: sim[Math.min(i, sim.length - 1)] } : {}),
          });
        } catch (e) {
          return this.fail(id, st, `round ${i + 1} did not start: ${(e as Error).message}`);
        }
        st.rounds.push(r);
        this.save(id, st, { status: 'designing', step: i === 0 ? 'composing the plan' : `repairing the plan (round ${i + 1} of ${rounds})` });
      }
      if (r.answer === undefined && r.error === undefined) {
        const how = await finishRound(sc, id, r);
        if (how === 'gone') return;
        if (how === 'done') {
          const a = (r.answer ?? {}) as Record<string, unknown>;
          (r as ComposeRound).plan = a.plan && typeof a.plan === 'object' && !Array.isArray(a.plan) ? (a.plan as Record<string, unknown>) : {};
          if (typeof a.reason === 'string') (r as ComposeRound).reason = truncate(a.reason, 2000);
        }
        this.save(id, st, { cost: this.cost(st) });
      }
      if (r.error !== undefined) return this.fail(id, st, r.error === 'budget' ? 'budget' : `round ${r.n} failed: ${r.error}`, this.outcome(st, pickOut, await this.until(st)));
      if (!r.check && !r.refused) {
        // the mod checks it (DesignsImpl -> Composes), then region.compose.checked carries on
        st.awaiting = { round: r.n, plan: (r as ComposeRound).plan ?? {} };
        this.save(id, st, { status: 'checking', step: `checking the plan (round ${r.n})` });
        return;
      }
    }

    // 5. the outcome
    const result = this.outcome(st, pickOut, await this.until(st));
    this.done(id, st, result.outcome === 'COMPOSED' ? 'composed a plan' : 'no plan checks ready', result);
  }

  /** The catalogue's `until` per kind (the waits' slices). */
  private async until(st: ComposeState): Promise<Map<string, string>> {
    const kinds = new Set<string>();
    for (const r of st.rounds) for (const p of Array.isArray(r.check?.parts) ? (r.check.parts as Array<Record<string, unknown>>) : []) if (typeof p.block === 'string') kinds.add(p.block);
    const out = new Map<string, string>();
    if (!kinds.size) return out;
    try {
      for (const e of (await kitKinds(this.sc.config.kitDir, [...kinds])).entries) if (typeof e.until === 'string') out.set(String(e.id), e.until);
    } catch {
      /* no until: the waits carry their blocks only */
    }
    return out;
  }

  /** The result from the record: COMPOSED (the last round READY with an artifact) or NO_PLAN with the best round. */
  private outcome(st: ComposeState, pick: Record<string, unknown>, until: Map<string, string>): Record<string, unknown> {
    const last = st.rounds[st.rounds.length - 1] as ComposeRound | undefined;
    const ready = last && !last.refused && last.check && String(last.check.overall) === 'READY' && typeof last.check.artifactSha === 'string';
    const best = ready ? last : bestRound(st.rounds as ComposeRound[]);
    const images = st.planImages ? { images: st.planImages.images.map((im) => ({ name: im.name, blobId: im.blobId })) } : {};
    // every round's answer, in order: what each check said (the repair's evidence without the record)
    const history = st.rounds.map((r) => ({ round: r.n, ...(r.refused ? { refused: r.refused } : { overall: String(r.check?.overall ?? 'unchecked') }), ...(typeof r.check?.planSha === 'string' ? { planSha: r.check.planSha } : {}) }));
    const base = { rounds: st.rounds.length, history, pick, ...images };
    if (ready && last) return { outcome: 'COMPOSED', reason: last.reason ?? '', plan: last.plan, check: last.check, round: last.n, ...base };
    return {
      outcome: 'NO_PLAN',
      reason: best ? `no round's plan checked READY; the best is round ${best.n} (${best.refused ? `refused: ${best.refused}` : String(best.check?.overall)})` : 'no round answered a plan',
      ...(best ? { plan: best.plan, ...(best.check ? { check: best.check } : {}), ...(best.refused ? { refused: best.refused } : {}), round: best.n, waits: waitsOf(best.check, until) } : { waits: [] }),
      ...base,
    };
  }
}
