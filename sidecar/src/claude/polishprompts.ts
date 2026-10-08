// (5b) The polish prompts (docs/CONTRACT.md "Phase 5b", §3 "The polish turn", "Targets" and "Routing free text"):
// the polish system prompt (appended to the claude_code preset), POLISH.md (the step's brief in the scratch dir), the
// step and fix-turn prompts, and the scoping call (prompt, system, schema).
//
// STATUS: FROZEN 2026-10-08 after development (0 of 7 dev steps accepted: the critic). They were developed on designs outside the 18 eval briefs and frozen in the paid prompt-development
// step (contract "Prompt development"); their hashes (POLISH_PROMPT_HASHES) are recorded in every polish result, so a
// result says which drafts made it. Nothing here is tuned against the eval set.
import crypto from 'node:crypto';
import type { CritiqueIssue } from '../protocol.js';

export const POLISH_PROMPTS_STATUS = 'frozen';

export const POLISH_SYSTEM = [
  'You are polishing an existing Minecraft building made with the Architect blueprint kit: a targeted edit, not a redesign.',
  'A critic named one problem with one part of the building. You fix that problem inside the parts you are allowed to change and keep every other cell exactly as it is.',
  'The critic looks at the same renders again and accepts your step only when the problem it named is clearly gone. A token tweak that leaves the problem visible fails: make the change the fix needs, even when that means rewriting the allowed part (its code is yours to rework).',
  'Edit the building, do not rebuild it: outside the allowed parts nothing changes. Keep the part names, the front, the frame (`origin`, the entrance feet row), the params, the palette and the size limit. To grow toward -x, -y or -z, raise `origin`; never move existing coordinates.',
  'When the problem is clutter, remove before adding. No new motifs.',
  'Work only in your scratch directory with the kit and node, without network access. Read POLISH.md first: it has the problem, the allowed parts, the rules and the commands. End only when the diff command reports no violation and the check is OK, with a one-line summary of what you changed.',
].join('\n');

export interface PolishBriefInput {
  bp: string;
  issue: CritiqueIssue | null;
  /** the free-text request (notes), restated by the scoping call */
  request?: string | undefined;
  allowed: string[];
  maxNewParts: number;
  maxChangedShare: number;
  maxSize?: { x: number; y: number; z: number } | undefined;
  /** the base's warnings by rule (the new version may not have more of any) */
  baseWarnings: Record<string, number>;
  views: string[];
  step: number;
  maxSteps: number;
  /** the diff command (relative to the scratch dir) */
  diffCommand: string;
  buildCommand: string;
}

/** POLISH.md: the step's brief. */
export function polishBrief(i: PolishBriefInput): string {
  const t = i.issue;
  const warn = Object.entries(i.baseWarnings);
  return [
    `# Polish step ${i.step} of ${i.maxSteps}: kit/designs/${i.bp}.mjs`,
    '',
    'BRIEF.md is the original request. kit/designs/' + i.bp + '.mjs is the installed design (the base): you change it in place.',
    '',
    '## The problem',
    '',
    t ? `- [${t.priority}] ${t.part ? `part \`${t.part}\`` : 'the whole building'}, seen in ${t.view}: ${t.what}` : `- ${i.request ?? '(none)'}`,
    t ? `- The critic's suggested fix: ${t.fix}` : '',
    i.request && t ? `- The player asked: ${i.request}` : '',
    `- The base renders the critic saw are in polish/base/ (${i.views.join(', ')}), with the slices in polish/base/slices.txt: Read them.`,
    '',
    '## What you may change',
    '',
    `- Only the cells of these parts: ${i.allowed.length ? i.allowed.map((p) => `\`${p}\``).join(', ') : '(none named)'}${i.maxNewParts ? `, plus at most ${i.maxNewParts} new part${i.maxNewParts === 1 ? '' : 's'} with new names (lower_snake_case)` : ''}.`,
    '- Every other cell stays exactly as it is: same block, same state. A cell in no part counts as outside: write new cells inside a `bp.part(...)`.',
    `- At most ${Math.round(i.maxChangedShare * 100)}% of the base's cells may change.`,
    '- Keep `front`, `groundY`, the params and their defaults, the palette roles and the values. Keep every part name. To grow toward -x, -y or -z, raise `origin`; never move existing coordinates.',
    i.maxSize ? `- The size limit is ${i.maxSize.x}x${i.maxSize.y}x${i.maxSize.z}.` : '',
    '- When the problem is clutter, remove before adding. No new motifs.',
    '',
    '## How the step is judged',
    '',
    '- The critic renders your version with the same views and is asked whether this problem is resolved. A small tweak that leaves it visible is not accepted, and nothing from the step is kept.',
    '- Inside the allowed parts you may rework the code as much as the fix needs (move, reshape or rebuild the part); the limits are the parts and the share of changed cells.',
    '- Work in this order: (1) say in one sentence what the part must look like for the problem to be gone; (2) change the part\'s code to that, as one coherent edit (a shape or size problem: change its dimensions, overhang, pitch or position; clutter: delete; a hidden element: clear what hides it); (3) build, check, diff, render, compare. Avoid many small cosmetic touches: they rarely change what the critic sees.',
    '- Also not accepted: a new P0 problem, or a building that looks worse overall.',
    '',
    '## Check before you end',
    '',
    `1. Build and check: \`${i.buildCommand}\` ("check: OK" is required${warn.length ? `; no more warnings of any rule than the base has: ${warn.map(([k, n]) => `${k} ${n}`).join(', ')}` : '; no new warnings'}).`,
    `2. Compare with the base: \`${i.diffCommand}\`. It must print \`scope: OK\`; otherwise it lists the violations (cells outside the allowed parts, a removed part, too many changes, the frame): undo them.`,
    '3. Render yours (`node kit/render.mjs kit/out/' + i.bp + '.nbt --views iso,front`) and Read them next to polish/base/. Ask: would the critic still write the problem above about this version? If yes, change more; if no, end with a one-line summary of the change.',
    '',
  ]
    .filter((l, k, a) => l !== '' || a[k - 1] !== '')
    .join('\n');
}

export function polishStepPrompt(bp: string): string {
  return `Polish kit/designs/${bp}.mjs: read POLISH.md, then BRIEF.md, kit/PLAYBOOK.md and the base renders in polish/base/. Fix the problem POLISH.md names within its allowed parts, run its two commands until the check is OK and the diff says "scope: OK", and end with a one-line summary.`;
}

export function polishFixPrompt(bp: string, problem: string, turn: number, max: number): string {
  return [
    `The sidecar checked your edit of kit/designs/${bp}.mjs and it is not accepted yet (fix turn ${turn} of ${max}):`,
    '',
    problem,
    '',
    'Fix exactly this (undo changes outside the allowed parts first), run the two commands in POLISH.md again, and end with a one-line summary.',
  ].join('\n');
}

export const POLISH_RESTART_PROMPT = 'The sidecar restarted while you were polishing this design. Re-read POLISH.md and kit/designs/ to see where you were, finish the edit, run the two commands in POLISH.md until both pass, and end with a one-line summary.';

// ---- the scoping call (notes without parts): a structured job --------------------------------------------------

export const SCOPING_SYSTEM = [
  "You route a player's change request for an existing Minecraft building made of named parts.",
  'A polish is a local edit: it changes at most 3 existing parts and adds at most 2 new ones, and keeps the look (materials, style) and the structure.',
  'A request to change the whole look (another style, other materials everywhere) is a re-skin; a structural rebuild (another shape, another storey count, moving the entrance) is a remix. Those do not fit a polish.',
  'Answer with your structured output only.',
].join('\n');

export function scopingPrompt(i: { request: string; parts: Array<{ name: string; box?: number[]; cells?: number }>; type: string; maxNewParts: number }): string {
  return [
    `The building: a ${i.type}. Its named parts (name, box [x0,y0,z0,x1,y1,z1], cells):`,
    ...i.parts.map((p) => `- ${p.name}${p.box ? ` ${JSON.stringify(p.box)}` : ''}${p.cells !== undefined ? `, ${p.cells} cells` : ''}`),
    '',
    `The player asks: "${i.request}"`,
    '',
    'The images: iso (front-left, the entrance side) and front (the front elevation).',
    '',
    `Answer: parts = the existing part names the change touches (at most 3); newParts = new part names it needs (at most ${i.maxNewParts}, lower_snake_case, none of the existing names); restated = the request as one concrete instruction for the designer (<= 200 chars); fits = whether it is a local polish; suggest = "polish", or "reskin" for a whole-look change, or "remix" for a structural rebuild; reason = one sentence.`,
  ].join('\n');
}

export function scopingSchema(maxNewParts: number): Record<string, unknown> {
  const name = { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['parts', 'newParts', 'restated', 'fits', 'suggest', 'reason'],
    properties: {
      parts: { type: 'array', items: name, maxItems: 3 },
      newParts: { type: 'array', items: name, maxItems: maxNewParts },
      restated: { type: 'string', maxLength: 200 },
      fits: { type: 'boolean' },
      suggest: { type: 'string', enum: ['polish', 'reskin', 'remix'] },
      reason: { type: 'string', maxLength: 300 },
    },
  };
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** A fixed sample input: the hashes cover the templates' text (stable across the bundle and the sources). */
const SAMPLE_ISSUE: CritiqueIssue = { priority: 'P1', part: 'roof', view: 'iso', what: 'WHAT', fix: 'FIX' };
const SAMPLE_BRIEF: PolishBriefInput = { bp: 'BP', issue: SAMPLE_ISSUE, request: 'REQUEST', allowed: ['roof', 'porch'], maxNewParts: 2, maxChangedShare: 0.5, maxSize: { x: 1, y: 2, z: 3 }, baseWarnings: { rule: 1 }, views: ['iso', 'front'], step: 1, maxSteps: 2, diffCommand: 'DIFF', buildCommand: 'BUILD' };

/** The hashes of the polish prompts (recorded in every polish result). */
export const POLISH_PROMPT_HASHES: Record<string, string> = {
  status: POLISH_PROMPTS_STATUS,
  system: sha(POLISH_SYSTEM),
  brief: sha(polishBrief(SAMPLE_BRIEF) + polishBrief({ ...SAMPLE_BRIEF, issue: null, maxNewParts: 0, maxSize: undefined, baseWarnings: {} })),
  step: sha(polishStepPrompt('BP') + polishFixPrompt('BP', 'PROBLEM', 1, 2) + POLISH_RESTART_PROMPT),
  scoping: sha(SCOPING_SYSTEM + scopingPrompt({ request: 'REQUEST', parts: [{ name: 'main', box: [0, 0, 0, 1, 1, 1], cells: 8 }], type: 'house', maxNewParts: 2 }) + JSON.stringify(scopingSchema(2))),
};
