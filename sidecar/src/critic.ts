// The critic (docs/CONTRACT.md "Phase 5a contract", "The critic"): what it is asked, the verdict schema, how the
// sidecar reads a verdict (part grounding, the ship rule) and the designer's revision prompt. Pure functions: the loop
// itself is critique.ts.
//
// The critic is a structured job (a fresh query per round, no session), with fixed renders as image blocks, the
// blueprint summary (JSON), layered ASCII slices, the brief, the style bible and, from round 1 on, the previous round's
// issues. It never sees the designer's transcript or the source. The sidecar, not the model, decides "ship".
import type { CritiqueIssue, CritiqueRound, DesignRequest } from './protocol.js';
import { BUILDING_TYPES } from './protocol.js';
import { truncate } from './util/text.js';

export const CRITIC_DIMS = ['silhouette', 'legibility', 'craft', 'materials', 'brief'] as const;
export const MASSING_DIMS = ['silhouette', 'brief', 'site'] as const;
export const SHEET_DIMS = ['legibility', 'restraint', 'craft'] as const;
export const MAX_ISSUES = 6;
export const SUMMARY_MAX_CHARS = 4000;
export const SLICES_MAX_CHARS = 8000;

const DIM_TEXT: Record<string, string> = {
  silhouette: 'massing and roof read as the type, good proportions from far away',
  legibility: 'doors, windows and the entrance read clearly; no visual noise',
  craft: 'no floating or stray blocks, finished corners, blocks facing the right way',
  materials: 'a three-tone hierarchy (frame, infill, trim), the palette and its roles used with restraint',
  brief: 'it does what was asked (type, style, features, notes)',
  bible: 'it follows the style bible (roles, proportions, roof language, hero motifs) without over-decorating',
  set: 'it belongs with the neighbouring buildings of the set (scale, roof language, materials)',
  interior: 'the interior is furnished, lit, and its floors connect',
  site: 'it fits its site and the group context (lot, street side, neighbours)',
  restraint: 'each component reads at one block\'s scale; few motifs, used with restraint',
};

/** Does the request's type have the interior rule (a preset other than custom, or an open type that needs one)? */
export function hasInterior(req: Pick<DesignRequest, 'type' | 'profile'>): boolean {
  if ((BUILDING_TYPES as readonly string[]).includes(req.type)) return req.type !== 'custom';
  const p = req.profile ?? ['door', 'lit', 'no_floating'];
  return p.some((r) => /^(interior|lit|floors_reachable|roof_closed|min_interior_volume)/.test(r));
}

export interface CriticContext {
  kind: 'design' | 'massing' | 'sheet';
  request?: DesignRequest | undefined;
  /** the bible's name and files' text, when the design has one */
  bible?: { name: string; json: string; prose?: string | undefined } | undefined;
  neighbours: number;
  views: string[];
  parts: string[];
  extraCriteria: string[];
  summary?: string | undefined;
  slices?: string | undefined;
  /** the previous round's issues (round 1 and later) */
  previous?: CritiqueIssue[] | undefined;
  round: number;
  /** a report critique of an existing entry */
  report?: boolean;
  /** the bible job's prompt (a sheet critique) */
  biblePrompt?: string | undefined;
}

/** The score keys of a verdict, in order. */
export function dimsFor(c: Pick<CriticContext, 'kind' | 'request' | 'bible' | 'neighbours' | 'extraCriteria'>): string[] {
  if (c.kind === 'sheet') return [...SHEET_DIMS];
  const base: string[] = c.kind === 'massing' ? [...MASSING_DIMS] : [...CRITIC_DIMS];
  if (c.kind === 'design') {
    if (c.bible) base.push('bible');
    if (c.neighbours > 0) base.push('set');
    if (c.request && hasInterior(c.request)) base.push('interior');
  }
  c.extraCriteria.forEach((_x, i) => base.push(`x${i + 1}`));
  return base;
}

/** The verdict's JSON schema (structured output); the sidecar validates it again. */
export function verdictSchema(dims: string[], views: string[]): Record<string, unknown> {
  const score = { type: 'integer', minimum: 1, maximum: 10 };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['scores', 'issues', 'resolved', 'verdict', 'summary'],
    properties: {
      scores: { type: 'object', additionalProperties: false, required: dims, properties: Object.fromEntries(dims.map((d) => [d, score])) },
      issues: {
        type: 'array',
        maxItems: MAX_ISSUES,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['priority', 'part', 'view', 'what', 'fix'],
          properties: {
            priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
            part: { anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }] },
            view: { type: 'string', enum: [...views, 'slices', 'summary', 'neighbours'] },
            what: { type: 'string', maxLength: 200 },
            fix: { type: 'string', maxLength: 200 },
          },
        },
      },
      resolved: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: MAX_ISSUES },
      verdict: { type: 'string', enum: ['ship', 'iterate'] },
      summary: { type: 'string', maxLength: 300 },
    },
  };
}

export const CRITIC_SYSTEM = [
  "You are Architect's design critic: a strict, fair reviewer of Minecraft buildings made by another designer.",
  'You judge only what was built, from fixed renders (flat-colour, one colour per block), layered ASCII slices and a blueprint summary. You never see the code.',
  'Score each dimension 1-10 (5 = acceptable, 7 = good, 9 = excellent; most first attempts are 5-7). List at most 6 concrete issues, worst first, each tied to a named part (or null for the whole building) and the view that shows it, with a fix the designer can act on in one turn.',
  'P0 = a player would call it broken (an unreadable or blocked entrance, a floating mass, a hole in the roof). P1 = clearly worse than it should be. P2 = polish.',
  'Prefer fewer, clearer issues. When clutter is the problem, the fix is to remove, not to add. Never ask for new motifs.',
  'Answer with your structured output only.',
].join('\n');

/** The critic's prompt text (the images come before it, each after its label). */
export function criticPrompt(c: CriticContext): string {
  const dims = dimsFor(c);
  const r = c.request;
  const lines: string[] = [];
  if (c.kind === 'sheet') {
    lines.push('# Review a style bible\'s component sheet', '', `The sheet (sheet.png) shows the shared components every building of a set will use (windows, door surrounds, lantern posts, roof trim, chimneys, ...). The bible was asked for: "${truncate(c.biblePrompt ?? '', 600)}".`, '');
  } else {
    lines.push(`# Review ${c.kind === 'massing' ? 'a massing (the coarse volumes of a building, before detail; judge only the volumes, roof forms and main openings)' : 'a building design'}${c.report ? ' (a report: no revision follows)' : ''}`, '');
    if (r) {
      lines.push('## The brief', '');
      lines.push(`- type: ${r.type}${r.profile ? ` (profile ${r.profile.join(', ')})` : ''}; style: "${r.style}"${r.materials ? `; materials: "${r.materials}"` : ''}`);
      if (r.features.length) lines.push(`- features: ${r.features.join(', ')}`);
      lines.push(`- maximum size: ${r.maxSize.x}x${r.maxSize.y}x${r.maxSize.z}${r.name ? `; name: "${r.name}"` : ''}`);
      if (r.notes) lines.push(`- notes: ${truncate(r.notes, 1500)}`);
      if (r.group) lines.push(`- a ${r.role ?? 'ordinary'} building of a set (item ${r.itemKey ?? '?'}, wave ${r.wave ?? 1})`);
      if (r.context !== undefined) lines.push(`- context: ${truncate(typeof r.context === 'string' ? r.context : JSON.stringify(r.context), 1500)}`);
      lines.push('');
    }
  }
  if (c.bible) {
    lines.push(`## The style bible: ${c.bible.name}`, '', '```json', truncate(c.bible.json, 5000), '```', '');
    if (c.bible.prose) lines.push(truncate(c.bible.prose, 3000), '');
  }
  if (c.kind !== 'sheet') {
    lines.push('## The views', '', `Images: ${c.views.join(', ')}${c.neighbours ? `, then ${c.neighbours} neighbour render${c.neighbours === 1 ? '' : 's'} (iso views of finished buildings of the same set)` : ''}. iso = front-left from above (the entrance side), iso_back = back-right, front = the front elevation, top = from above (north at the top), cutaway = iso with the near walls and the rows above the interior removed. The front faces south (the bottom of the top view).`, '');
  }
  if (c.summary) lines.push('## The blueprint summary', '', '```json', c.summary, '```', '');
  if (c.slices) lines.push('## Layered ASCII slices (north at the top, west at the left; one letter per block, see the legend)', '', '```', c.slices, '```', '');
  if (c.parts.length) lines.push(`Named parts (use these names in issues, or null for the whole building): ${c.parts.join(', ')}.`, '');
  if (c.previous?.length) {
    lines.push(`## The previous round's issues (round ${c.round - 1})`, '', 'The designer revised the building to fix these. In `resolved`, list the indexes of the ones that are now fixed; repeat an issue only if it is still there.', '');
    c.previous.forEach((i, k) => lines.push(`${k}. [${i.priority}] ${i.part ?? 'whole building'} (${i.view}): ${i.what}`));
    lines.push('');
  }
  lines.push('## Score these', '');
  for (const d of dims) {
    const x = /^x(\d)$/.exec(d);
    lines.push(`- \`${d}\`: ${x ? `the extra criterion "${c.extraCriteria[Number(x[1]) - 1]}"` : DIM_TEXT[d] ?? d}`);
  }
  lines.push('', `verdict: "ship" when it is good enough that a player would be happy with it as it is, else "iterate". summary: one or two sentences.`);
  return lines.join('\n');
}

export interface ReadVerdict {
  verdict: 'ship' | 'iterate' | null;
  scores: Record<string, number>;
  overall: number | null;
  issues: CritiqueIssue[];
  resolved: number[];
  summary?: string;
  notes: string[];
  unknownParts: number;
  ship: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The ship rule (the sidecar's, not the model's): overall >= shipScore, no score below shipScore - 2, no P0. */
export function shipRule(scores: Record<string, number>, issues: CritiqueIssue[], shipScore: number): boolean {
  const v = Object.values(scores);
  if (!v.length) return false;
  const overall = v.reduce((a, b) => a + b, 0) / v.length;
  return overall >= shipScore - 1e-9 && Math.min(...v) >= shipScore - 2 - 1e-9 && !issues.some((i) => i.priority === 'P0');
}

/**
 * Read a verdict (already schema-validated): unknown part names become null with a note (they count against the
 * critic's part grounding), scores outside the asked dimensions are dropped, overall is the mean of the present scores.
 */
export function readVerdict(raw: unknown, ctx: { dims: string[]; parts: string[]; shipScore: number; previousCount: number }): ReadVerdict {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = (o.scores && typeof o.scores === 'object' ? o.scores : {}) as Record<string, unknown>;
  const scores: Record<string, number> = {};
  for (const d of ctx.dims) {
    const v = s[d];
    if (typeof v === 'number' && Number.isFinite(v)) scores[d] = Math.max(1, Math.min(10, Math.round(v)));
  }
  const notes: string[] = [];
  let unknownParts = 0;
  const issues: CritiqueIssue[] = (Array.isArray(o.issues) ? o.issues : []).slice(0, MAX_ISSUES).flatMap((x) => {
    if (!x || typeof x !== 'object') return [];
    const i = x as Record<string, unknown>;
    const priority = i.priority === 'P0' || i.priority === 'P1' || i.priority === 'P2' ? i.priority : 'P2';
    let part = typeof i.part === 'string' && i.part.trim() ? i.part.trim() : null;
    if (part !== null && !ctx.parts.includes(part)) {
      notes.push(`unknown part "${truncate(part, 40)}" became null`);
      unknownParts++;
      part = null;
    }
    return [{ priority, part, view: truncate(String(i.view ?? 'iso'), 40), what: truncate(String(i.what ?? ''), 200), fix: truncate(String(i.fix ?? ''), 200) }];
  });
  // worst first
  issues.sort((a, b) => a.priority.localeCompare(b.priority));
  const resolved = (Array.isArray(o.resolved) ? o.resolved : []).filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < ctx.previousCount);
  const v = Object.values(scores);
  const overall = v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null;
  const verdict = o.verdict === 'ship' || o.verdict === 'iterate' ? o.verdict : null;
  return {
    verdict,
    scores,
    overall,
    issues,
    resolved: [...new Set(resolved)],
    ...(typeof o.summary === 'string' ? { summary: truncate(o.summary, 300) } : {}),
    notes,
    unknownParts,
    ship: v.length === ctx.dims.length && shipRule(scores, issues, ctx.shipScore),
  };
}

/** The designer's revision prompt (same session), built from the verdict. */
export function revisionPrompt(bp: string, round: CritiqueRound, n: number, max: number): string {
  const issues = round.issues.map((i, k) => `${k + 1}. [${i.priority}] ${i.part ? `part \`${i.part}\`` : 'the whole building'}, seen in ${i.view}: ${i.what} -> ${i.fix}`);
  const scores = Object.entries(round.scores).map(([k, v]) => `${k} ${v}`).join(', ');
  return [
    `A critic reviewed the renders of your design (round ${round.n}) and it goes back to you for revision ${n} of ${max}.`,
    '',
    `Scores (1-10): ${scores}${round.overall !== null ? `; overall ${round.overall}` : ''}.${round.summary ? ` "${round.summary}"` : ''}`,
    '',
    'Issues, worst first:',
    ...issues,
    '',
    'Rules for this revision:',
    '- Fix every P0 and P1; fix P2s where it is cheap.',
    `- Keep the part names, the front and the size limit; keep kit/designs/${bp}.mjs parametric and palette-driven.`,
    '- When the issue is clutter, remove before adding. No new motifs.',
    `- The critic saw the PNGs in critique/${round.n}/ (and the slices in critique/${round.n}/slices.txt): Read them to see what it means.`,
    `- Then build and check as BRIEF.md says ("check: OK" is required), look at your renders again, and end with a one-line summary of what you changed.`,
  ].join('\n');
}

export const REVISION_RESTART_PROMPT =
  'The sidecar restarted while you were revising this design after the critique. Re-check where you were (kit/designs/, the critique in critique/), finish the revision, build and check it until the check is OK, then end with a one-line summary.';

/**
 * The blueprint summary for the critic (JSON, at most 4000 chars): type and profile, size and maxSize, front, the
 * named parts, the most used blocks, the checker warnings (attach and facing included), massing conformance and the
 * kit metrics.
 */
export function blueprintSummary(input: {
  sidecar: Record<string, unknown>;
  request?: DesignRequest | undefined;
  warnings: string[];
  metrics?: Record<string, unknown> | undefined;
  conformance?: unknown;
}): string {
  const sc = input.sidecar;
  const parts = sc.parts && typeof sc.parts === 'object' ? Object.entries(sc.parts as Record<string, { box?: number[]; cells?: number }>).map(([name, p]) => ({ name, box: p?.box, cells: p?.cells })) : [];
  const m = input.metrics ?? {};
  const { topBlocks, ...metrics } = m as Record<string, unknown>;
  const out: Record<string, unknown> = {
    type: sc.type,
    ...(sc.profile ? { profile: sc.profile } : {}),
    size: sc.size,
    ...(input.request ? { maxSize: input.request.maxSize } : {}),
    front: sc.front,
    parts,
    ...(topBlocks ? { topBlocks } : {}),
    warnings: input.warnings.slice(0, 20),
    ...(input.conformance ? { conformance: input.conformance } : {}),
    metrics,
  };
  let s = JSON.stringify(out);
  // shrink until it fits: fewer warnings, then fewer parts
  while (s.length > SUMMARY_MAX_CHARS && (out.warnings as string[]).length > 3) {
    out.warnings = (out.warnings as string[]).slice(0, Math.floor((out.warnings as string[]).length / 2));
    s = JSON.stringify(out);
  }
  while (s.length > SUMMARY_MAX_CHARS && (out.parts as unknown[]).length > 4) {
    out.parts = (out.parts as unknown[]).slice(0, (out.parts as unknown[]).length - 2);
    s = JSON.stringify(out);
  }
  return s.length > SUMMARY_MAX_CHARS ? s.slice(0, SUMMARY_MAX_CHARS) : s;
}

/**
 * (sim) The scripted verdict for a round: the request's notes may say `sim:critique=<r0>/<r1>/...`, where each token is
 * a score for every dimension (`7.5`), optionally with `!P0` (a P0 issue), `?part` (an issue on an unknown part) or
 * the token `fail` (the critic call fails). Without a script the sim critic gives 8 everywhere (ships at round 0).
 */
export function simVerdict(notes: string | undefined, round: number, dims: string[], parts: string[]): unknown {
  const m = /sim:critique=([^\s;]+)/.exec(notes ?? '');
  const tokens = m ? m[1]!.split('/') : ['8'];
  const tok = tokens[Math.min(round, tokens.length - 1)]!;
  if (tok === 'fail') return { simFail: 'the simulated critic failed' };
  const num = Number(/^[\d.]+/.exec(tok)?.[0] ?? '8');
  const score = Math.max(1, Math.min(10, Math.round(num)));
  // an uneven split keeps the mean at `num` when it is a half (7.5 -> 7 and 8)
  const scores = Object.fromEntries(dims.map((d, i) => [d, Number.isInteger(num) ? score : i % 2 ? Math.ceil(num) : Math.floor(num)]));
  const issues: CritiqueIssue[] = [];
  if (tok.includes('!P0')) issues.push({ priority: 'P0', part: parts[0] ?? null, view: 'iso', what: 'the entrance is blocked (simulated)', fix: 'open the door way' });
  if (tok.includes('?part')) issues.push({ priority: 'P1', part: 'no_such_part', view: 'front', what: 'a part the blueprint does not have (simulated)', fix: 'none' });
  if (num < 7) issues.push({ priority: 'P1', part: parts[0] ?? null, view: 'front', what: 'the front reads flat (simulated)', fix: 'add depth to the facade' });
  return { scores, issues, resolved: round > 0 ? [0] : [], verdict: num >= 7 ? 'ship' : 'iterate', summary: `simulated verdict ${tok} (round ${round})` };
}
