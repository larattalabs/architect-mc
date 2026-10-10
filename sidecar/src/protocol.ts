// Architect wire protocol (docs/CONTRACT.md "Protocol" and "Phase 4a contract: public API"). Ported
// from AgentCraft's foreman/src/protocol.ts (design messages only).
//
// Transport: ws://127.0.0.1:<port>, one JSON object per text frame:
//   { "v": 1, "type": "<type>", "id"?: "<client correlation id>", ...payload }
// `v` is the envelope version and stays 1. The PROTOCOL (what messages and fields a client gets) is
// negotiated per connection: `hello.protocols: [1, 2]` picks the highest both sides speak, and the
// v2 snapshot answers `protocol` and `features`. A client that sends no `protocols` is protocol 1
// and gets exactly the phase 1-3 messages (see `toProtocol1`).
// Conventions: timestamps are integer epoch ms; unknown fields are ignored (zod strips them);
// optional fields are omitted, never null (except `auth.set.apiKey: null`, which clears the key).
import { z } from 'zod';

/** The envelope version (`v`), unchanged by protocol 2. */
export const PROTOCOL_VERSION = 1 as const;
/** The protocols this sidecar speaks (hello.protocols picks one). */
export const PROTOCOLS = [1, 2] as const;
export type Protocol = (typeof PROTOCOLS)[number];
/** What a protocol-2 snapshot lists in `features`. */
export const FEATURES = ['job.run', 'job.tools', 'blobs', 'budget', 'designs.v2', 'bibles', 'design.groups', 'named.parts', 'open.types', 'estimates', 'reskin', 'massing', 'critique', 'critique.report', 'job.images', 'bible.admin', 'bible.restraint', 'entry.versions', 'entry.delta', 'design.polish', 'critique.polish', 'region.plan', 'region.tiles', 'region.check', 'region.preview', 'region.design', 'region.blobs', 'ir.format2', 'copies', 'smallEffort', 'versionOf'] as const;

const Ts = z.number().int().nonnegative();
const Id = z.string().min(1).max(64);

// ---- enums -----------------------------------------------------------------------------------

export const BUILDING_TYPES = ['house', 'cabin', 'cottage', 'tower', 'shop', 'tavern', 'barn', 'smithy', 'chapel', 'gatehouse', 'custom'] as const;
export const BuildingType = z.enum(BUILDING_TYPES);
export type BuildingType = z.infer<typeof BuildingType>;

export const DesignStatus = z
  .enum(['queued', 'designing', 'checking', 'rendering', 'critiquing', 'done', 'failed', 'cancelled'])
  .describe('queued -> designing (the design agent works) -> checking (the sidecar re-runs the checker with a pristine kit) -> rendering (previews) -> [critiquing (5a: the critic looks at the renders) -> designing (a revision) -> ...] -> done; or failed / cancelled. done, failed and cancelled are final. A protocol-1 client sees critiquing as rendering.');
export type DesignStatus = z.infer<typeof DesignStatus>;
/** What protocol 1 knows (no critiquing). */
export const DesignStatusV1 = z.enum(['queued', 'designing', 'checking', 'rendering', 'done', 'failed', 'cancelled']);

export const AuthState = z.enum(['ok', 'missing', 'failed', 'checking']);
export type AuthState = z.infer<typeof AuthState>;

// ---- records ---------------------------------------------------------------------------------

export const Status = z.object({
  auth: AuthState,
  authSource: z.string().optional().describe('"API key", "claude login (personal use)", "Amazon Bedrock", ...'),
  useClaudeLogin: z.boolean(),
  sdk: z.enum(['ready', 'missing']).describe('@anthropic-ai/claude-agent-sdk resolvable'),
  designing: Id.optional().describe('the running design id'),
  queued: z.number().int().nonnegative(),
  usageLimitUntil: Ts.optional(),
  designingIds: z.array(Id).optional().describe('(4b addition) every running design (the pool runs up to designConcurrency); `designing` is the first'),
  backend: z.enum(['claude', 'sim']).optional().describe('(addition) which designer runs the jobs'),
  message: z.string().optional().describe('(addition) one human line about auth / the SDK, for the Status tab'),
});
export type Status = z.infer<typeof Status>;

const Size = (lo: number, hi: number) => z.number().int().min(lo).max(hi);

/** A marked plot (the mod's DesignSpec.Plot), informational for the designer. */
export const Plot = z.object({
  minX: z.number().int().optional(),
  y: z.number().int().optional(),
  minZ: z.number().int().optional(),
  dx: z.number().int().positive(),
  dz: z.number().int().positive(),
  height: z.number().int().positive().optional(),
  front: z.enum(['north', 'south', 'east', 'west']).optional(),
  dimension: z.string().max(200).optional(),
});
export type Plot = z.infer<typeof Plot>;

export const FEATURE_RE = /^[a-z][a-z0-9_]{0,31}$/;

const DesignRequestBase = z.object({
  type: BuildingType,
  style: z.string().trim().min(1).max(40).describe('"rustic", "medieval", "modern", ... (chips or any text)'),
  materials: z.string().trim().max(200).optional().describe('free text, e.g. "spruce and cobblestone"'),
  features: z.array(z.string().regex(FEATURE_RE)).max(6).describe('porch, chimney, balcony, garden, skylights, courtyard, big_windows, basement, ...'),
  maxSize: z.object({ x: Size(7, 96), y: Size(6, 64), z: Size(7, 96) }).describe('the largest template allowed (including roof overhangs, porch, garden)'),
  plot: Plot.optional(),
  remix: z.string().regex(/^[a-z0-9_]+$/).max(64).optional().describe('start from this library id'),
  name: z.string().trim().min(1).max(40).optional().describe('display name; also names the id (gen_<slug>)'),
  notes: z.string().max(2000).optional(),
});

function noDuplicateFeatures(r: { features: string[] }, ctx: z.RefinementCtx): void {
  if (new Set(r.features).size !== r.features.length) ctx.addIssue({ code: 'custom', path: ['features'], message: 'duplicate feature' });
}

/** A design request as protocol 1 knows it. A protocol-1 client's requests are parsed with this, so v2 fields are dropped. */
export const DesignRequestV1 = DesignRequestBase.superRefine(noDuplicateFeatures);

/** (protocol 2) namespaced metadata (`"steward_mc:lot": "L3"`) that Architect never interprets; at most 64 KB as JSON. */
export const Ext = z.record(z.string().min(1).max(200), z.unknown()).refine((v) => JSON.stringify(v).length <= 64 * 1024, 'ext is larger than 64 KB');
export type Ext = z.infer<typeof Ext>;

export const ModelId = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:@/[\]-]+$/, 'not a model id');
const BudgetUsd = z.number().positive().max(1000);
const Owner = z.string().trim().min(1).max(200);

/** (4b, R4) a building type: a preset or an open type (`hellish_lair`). */
export const OPEN_TYPE = /^[a-z][a-z0-9_]{0,39}$/;
export const OpenType = z.string().regex(OPEN_TYPE, 'a type is a preset or a short open type ([a-z][a-z0-9_]{0,39})');
/** (4b, R4) one checker rule of an open type's profile. */
export const PROFILE_RULE = /^(door|roof_closed|floors_reachable|lit|no_floating|interior|min_interior_volume:\d{1,5}|passage:\d{1,2}x\d{1,2}|tall:\d+(\.\d+)?)$/;
export const Profile = z.array(z.string().regex(PROFILE_RULE, 'a profile rule is door, roof_closed, floors_reachable, lit, no_floating, interior, min_interior_volume:<n>, passage:<w>x<h> or tall:<ratio>')).min(1).max(12);
export const BIBLE_ID = /^[a-z0-9_]{1,64}$/;
export const BibleId = z.string().regex(BIBLE_ID, 'bible ids are [a-z0-9_]{1,64}');
export const ItemKey = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:/-]+$/, 'item keys are [A-Za-z0-9_.:/-]{1,100}');
/** (0b) a group item's key as the sidecar reports it: a caller's key, or an expanded `<key>#<n>` (count) */
export const GroupItemKey = z.string().min(1).max(104).regex(/^[A-Za-z0-9_.:/-]+(#[0-9]{1,2})?$/, 'group item keys are <itemKey> or <itemKey>#<n>');
/** (0b, C8) a group item's effort: auto (small by the size rule when smallBySize is set), standard or small */
export const ItemEffort = z.enum(['auto', 'standard', 'small']);
export type ItemEffort = z.infer<typeof ItemEffort>;
export const ItemRole = z.enum(['landmark', 'ordinary']);
export type ItemRole = z.infer<typeof ItemRole>;
/** (4c) a massing id: mas_<slug> (stable across versions) */
export const MASSING_ID = /^[a-z0-9_]{1,64}$/;
export const MassingId = z.string().regex(MASSING_ID, 'massing ids are [a-z0-9_]{1,64}');
/** (4c) group / design context: text up to 4000 chars, or JSON (at most 4000 chars as JSON) */
export const MAX_CONTEXT = 4000;
export const Context = z.union([
  z.string().trim().min(1).max(MAX_CONTEXT),
  z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= MAX_CONTEXT, `context JSON is longer than ${MAX_CONTEXT} chars`),
]);
export type Context = z.infer<typeof Context>;

/** (protocol 2) the SDK's estimate: total_cost_usd plus the modelUsage token totals. Not a billing statement. */
export const Cost = z.object({
  usd: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
});
export type Cost = z.infer<typeof Cost>;

// ---- phase 5a: critique (docs/CONTRACT.md "Phase 5a contract") ------------------------------

/** The fixed critic views (render.mjs --views); phase 6 adds section. */
export const CRITIQUE_VIEWS = ['iso', 'iso_back', 'front', 'top', 'cutaway'] as const;
export const CritiqueView = z.enum(CRITIQUE_VIEWS);
export type CritiqueView = z.infer<typeof CritiqueView>;
export const CritiqueMode = z.enum(['off', 'report', 'loop', 'polish']);
export type CritiqueMode = z.infer<typeof CritiqueMode>;
export const CritiqueSpec = z
  .object({
    mode: CritiqueMode.describe('off | report (one critic call, no revision) | loop (revise until it ships, a round cap, a budget or the clock stops it) | (5b) polish (round 0 installs with a report, then a polish of the new entry: targeted steps, at most one new version)'),
    maxRevisions: z.number().int().min(0).max(3).optional().describe('default 2 (a massing: 1); (5b) mode polish: maxSteps (1..3)'),
    model: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:@/[\]-]+$/, 'not a model id').optional().describe('the critic model (default config critique.model, claude-sonnet-5-5)'),
    effort: z.enum(['low', 'medium', 'high']).optional().describe('default medium'),
    budgetUsd: z.number().positive().max(1000).optional().describe("cap on the loop's own spend (critic calls plus revision turns); default 1.0x round 0's cost"),
    maxMinutes: z.number().positive().max(240).optional().describe('default 15: the loop ends at the first round boundary after this'),
    shipScore: z.number().min(1).max(10).optional().describe('default 7.0: ship when the mean score reaches it, no score is below shipScore - 2 and there is no P0'),
    views: z.array(CritiqueView).min(1).max(5).optional().describe('default every view'),
    neighbours: z.boolean().optional().describe('send the finished siblings\' renders (default true in groups)'),
    extraCriteria: z.array(z.string().trim().min(1).max(200)).max(3).optional().describe('up to 3 extra rubric lines, each scored on its own'),
  })
  .refine((c) => !c.views || new Set(c.views).size === c.views.length, 'duplicate view');
export type CritiqueSpec = z.infer<typeof CritiqueSpec>;

export const END_REASONS = ['ship', 'max_revisions', 'budget', 'time', 'regressed', 'check_failed', 'critic_failed', 'report', 'off'] as const;
export const EndReason = z.enum(END_REASONS);
export type EndReason = z.infer<typeof EndReason>;
export const IssuePriority = z.enum(['P0', 'P1', 'P2']);
export const CritiqueIssue = z.object({
  priority: IssuePriority,
  part: z.string().max(64).nullable().describe('a named part of the blueprint, or null for the whole building'),
  view: z.string().max(40),
  what: z.string().max(200),
  fix: z.string().max(200),
});
export type CritiqueIssue = z.infer<typeof CritiqueIssue>;
export const CritiqueRound = z.object({
  n: z.number().int().min(0),
  verdict: z.enum(['ship', 'iterate']).nullable().describe("the model's own verdict (the sidecar decides; null: no critic answer)"),
  overall: z.number().nullable().describe('the mean of the present scores (null: not scored)'),
  scores: z.record(z.string(), z.number()),
  issues: z.array(CritiqueIssue),
  resolved: z.array(z.number().int()),
  summary: z.string().max(400).optional(),
  ship: z.boolean().describe("the sidecar's ship rule held"),
  cost: z.number().nonnegative().describe("USD of this round's critic call plus the revision that made it"),
  ms: z.number().int().nonnegative().describe('wall time of the revision and the critic call'),
  kept: z.boolean().describe('the round passed the check and is kept in the scratch dir (rounds/<n>/)'),
  notes: z.array(z.string()).optional().describe('e.g. an unknown part name became null'),
  unknownParts: z.number().int().optional(),
  error: z.string().optional().describe('why the round has no verdict (check failed, critic failed)'),
});
export type CritiqueRound = z.infer<typeof CritiqueRound>;
export const CritiqueRecord = z.object({
  mode: CritiqueMode,
  rounds: z.array(CritiqueRound),
  best: z.number().int().optional().describe('the round that installs (or installed)'),
  end: EndReason.optional().describe('set when the loop has ended'),
  overall: z.number().nullable().optional().describe("the best round's overall"),
  pending: z.enum(['critic', 'revise']).optional().describe('what the loop does next (absent once it ended)'),
  cost: z.object({ critic: Cost, revise: Cost }),
});
export type CritiqueRecord = z.infer<typeof CritiqueRecord>;

// ---- phase 5b: entry versions and polish (docs/CONTRACT.md "Phase 5b", §1, §3, §5) ----------------------------

export const PartName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'a part name is [a-z][a-z0-9_]{0,39}');
export const PolishSpec = z.object({
  fromVersion: z.number().int().min(1).optional().describe('the version polished (default the head)'),
  critique: z.enum(['reuse', 'fresh']).optional().describe("reuse (default): the head's critique.json when it is not stale, else a report runs first"),
  target: z
    .object({
      issues: z.array(z.number().int().min(0)).min(1).max(3).optional().describe('indexes into the verdict issues, one per step, in this order'),
      parts: z.array(PartName).min(1).max(3).optional().describe('the parts the change may touch (with notes: skips the scoping call)'),
      notes: z.string().trim().min(1).max(500).optional().describe('a free-text change ("make the porch less cluttered"); without parts a scoping call picks them'),
    })
    .optional(),
  maxSteps: z.number().int().min(1).max(3).optional().describe('default 2'),
  maxNewParts: z.number().int().min(0).max(2).optional().describe('default 2'),
  maxChangedShare: z.number().min(0.05).max(1).optional().describe('default 0.5: an edit, not a rebuild'),
  model: ModelId.optional().describe("the polish model (default the entry's designer model)"),
  effort: z.enum(['low', 'medium', 'high']).optional().describe('default medium'),
  budgetUsd: BudgetUsd.optional(),
  maxMinutes: z.number().positive().max(240).optional().describe('default 15'),
  apply: z.object({ sites: z.union([z.array(z.string().min(1).max(200)).max(256), z.literal('all')]), preview: z.boolean().optional().describe('default true') }).optional().describe('the mod applies: carried in the design record'),
});
export type PolishSpec = z.infer<typeof PolishSpec>;
export const POLISH_ENDS = ['polished', 'no_target', 'not_resolved', 'scope_failed', 'check_failed', 'base_drift', 'budget', 'time', 'critic_failed'] as const;
export const PolishEnd = z.enum(POLISH_ENDS);
export type PolishEnd = z.infer<typeof PolishEnd>;
export const PolishStep = z.object({
  n: z.number().int().min(1),
  target: CritiqueIssue.nullable().describe('the issue this step fixes (null: none)'),
  targetIndex: z.number().int().nullable().optional().describe("its index in the base verdict's issues"),
  allowedParts: z.array(z.string()),
  accepted: z.boolean(),
  overall: z.number().nullable().describe("the fresh critic's overall (null: no verdict)"),
  changedCells: z.number().int().nonnegative(),
  cost: Cost,
  ms: z.number().int().nonnegative(),
  failure: z.string().nullable().describe('scope_failed / check_failed / not_resolved / new_p0 / regressed / critic_failed / budget / ... (null: accepted)'),
  fixTurns: z.number().int().nonnegative().optional(),
});
export type PolishStep = z.infer<typeof PolishStep>;
export const PolishRecord = z.object({
  entryId: z.string(),
  fromVersion: z.number().int().min(1),
  steps: z.array(PolishStep),
  end: PolishEnd.optional().describe('set once the polish ended'),
  installedVersion: z.number().int().nullable(),
  apply: PolishSpec.shape.apply.optional(),
  untargetable: z.number().int().nonnegative().optional().describe('open issues with part null (not targeted by default)'),
  scoping: z.object({ parts: z.array(z.string()), newParts: z.array(z.string()), restated: z.string(), fits: z.boolean(), suggest: z.enum(['polish', 'reskin', 'remix']), reason: z.string() }).optional(),
  baseOverall: z.number().nullable().optional(),
  overall: z.number().nullable().optional().describe('the installed (or base) overall'),
  report: z.boolean().optional().describe('a fresh report ran first'),
  prompts: z.record(z.string(), z.string()).optional().describe('hashes of the polish prompts (drafts until frozen)'),
  note: z.string().optional(),
});
export type PolishRecord = z.infer<typeof PolishRecord>;
export const LineageEntry = z.object({
  n: z.number().int().min(1),
  createdAt: z.number(),
  by: z.enum(['design', 'polish', 'revert', 'migrated']),
  parent: z.number().int().nullable(),
  designId: z.string().optional(),
  summary: z.string(),
  nbtSha256: z.string(),
  criticHash: z.string().optional(),
});

export const DesignRequest = DesignRequestBase.extend({
  type: OpenType.describe('(protocol 2: any open type; protocol 1: the 11 presets) the building type'),
  profile: Profile.optional().describe('(4b, R4) an open type: the checker rules it wants (default door, lit, no_floating); preset types ignore it'),
  owner: Owner.optional().describe('(protocol 2) who asked, by convention "<modid>:<thing>"; absent = the player'),
  ext: Ext.optional().describe("(protocol 2) merged into the installed entry's blueprint JSON `ext`; kept through variants and imports"),
  model: ModelId.optional().describe('(protocol 2) the design model (default: config designModel)'),
  budgetUsd: BudgetUsd.optional().describe('(protocol 2) hard stop on the estimated cost (USD) of this design, across resumes'),
  bible: BibleId.optional().describe('(4b) design with this style bible (its roles, prose and components); a group sets it'),
  bibleVersion: z.number().int().min(1).optional().describe('(4b) the bible version (default: its latest when the request is made; the sidecar pins it)'),
  group: z.string().max(200).optional().describe('(4b) set by the sidecar: the group this design belongs to (design.request refuses it)'),
  itemKey: ItemKey.optional().describe('(4b) set by the sidecar for a group item: the caller\'s key'),
  wave: z.number().int().min(0).max(8).optional().describe('(4b) a group item\'s wave (0 = anchor)'),
  role: ItemRole.optional().describe('(4b) a group item\'s role'),
  massing: z.boolean().optional().describe('(4c) true: a massing job (false = absent): a coarse volume design (kit/lib/massing.mjs), installed into <gameDir>/architect/massings/<id>/'),
  fromMassing: MassingId.optional().describe('(4c) the detail pass of this massing (binding: part names, boxes, size, roof forms)'),
  massingVersion: z.number().int().min(1).optional().describe('(4c) with fromMassing: the massing version (default: its latest; the sidecar pins it)'),
  context: Context.optional().describe('(4c) text (<= 4000 chars) or JSON for the brief: site, purpose, neighbour lots; a group sets it on every item'),
  redirect: z.object({ fromVersion: z.number().int().min(1), notes: z.string().max(2000) }).optional().describe('(4c) set by the sidecar: a massing redirect (the version it starts from and the notes)'),
  critique: CritiqueSpec.optional().describe('(5a) critique this design: report (one critic call) or loop (revise on the verdict); default off'),
  effort: z.enum(['standard', 'small']).optional().describe('(0b, C8) set by the sidecar for a group item: small = the bounded SMALL detail pass (2 rounds, 40 turns, medium, $1.50)'),
  versionOf: z.object({ entryId: z.string().regex(/^[a-z0-9_]+$/).max(64), siteId: z.string().min(1).max(200).optional() }).optional().describe('(0b, C13) design the next version of this entry (notes = the change request); the site files come with it'),
}).superRefine(noDuplicateFeatures).superRefine((r, ctx) => {
  if (r.massing && r.fromMassing) ctx.addIssue({ code: 'custom', path: ['fromMassing'], message: 'a request is a massing or the detail of one, not both' });
  if (r.massingVersion !== undefined && !r.fromMassing) ctx.addIssue({ code: 'custom', path: ['massingVersion'], message: 'massingVersion needs fromMassing' });
});
export type DesignRequest = z.infer<typeof DesignRequest>;


/** (4c) the kit's massing conformance result (`build.mjs --massing <file> --json`) */
export const Conformance = z.object({ ok: z.boolean(), errors: z.array(z.string()), issues: z.array(z.string()) });
export type Conformance = z.infer<typeof Conformance>;

const designFields = {
  id: Id.describe('"d<n>"'),
  step: z.string().describe('one line of progress'),
  blueprintId: z.string().optional().describe('done: the new library id (gen_<slug>, gen_<slug>_2, ...)'),
  size: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).optional(),
  previews: z.array(z.string()).optional().describe('done: absolute paths of the preview PNGs in <library>/<id>/'),
  error: z.string().optional().describe('failed: why ("budget" when the budget stopped it)'),
  createdAt: Ts,
  updatedAt: Ts,
};
/** A design record as protocol 1 sends it. */
export const DesignV1 = z.object({ ...designFields, status: DesignStatusV1, request: DesignRequestV1 });
export const Design = z.object({
  ...designFields,
  status: DesignStatus,
  request: DesignRequest,
  cost: Cost.optional().describe('(protocol 2) the estimated cost so far, with cache tokens'),
  massing: z.object({ id: MassingId, version: z.number().int().min(1) }).optional().describe('(4c) a massing job: the massing (id, version) it makes; it never gets a blueprintId'),
  conformance: Conformance.optional().describe('(4c) a detail pass: the massing conformance result (errors failed a round; issues are warnings)'),
  critique: CritiqueRecord.optional().describe('(5a) the critique rounds, the best round, the end reason and the split cost'),
  critiqueOf: z.string().optional().describe('(5a) a report critique of this library entry (design.critique): no new entry'),
  kind: z.enum(['polish', 'region']).optional().describe('(5b) polish: a polish of a library entry (design.polish): no new entry, at most one new version; (6b) region: a template pick (region.design), `region` and `result` say what'),
  polish: PolishRecord.optional().describe('(5b) the polish: steps, end, installed version, the apply intent'),
  region: z.record(z.string(), z.unknown()).optional().describe('(6b) a region design: the request (brief, card, claim, surveyBlobId, bible, mustPass, requireFit, plan) and its tries'),
  result: z.record(z.string(), z.unknown()).optional().describe('(6b) a region design: {outcome: PICKED|NO_TEMPLATE, fits, program, params, reason, cost, planId?, tries}'),
});
export type Design = z.infer<typeof Design>;

// ---- variants and imports (phase 2, docs/CONTRACT.md "Variants without Claude") -------------

export const LIBRARY_ID = /^[a-z0-9_]+$/;

export const VariantStatus = z
  .enum(['queued', 'building', 'done', 'failed'])
  .describe('queued -> building (copy the source, build + check with a pristine kit, render, install) -> done | failed. done and failed are final.');
export type VariantStatus = z.infer<typeof VariantStatus>;

const BlockName = z.string().min(1).max(64).regex(/^[a-z0-9_:]+$/);

/** A preset name (kit PALETTE_PRESETS) or palette inputs; anything else the kit refuses with a reason. */
export const PaletteSpec = z.union([
  z.string().min(1).max(32).regex(/^[a-z0-9_]+$/),
  z.object({ preset: z.string().min(1).max(32).regex(/^[a-z0-9_]+$/).optional(), wood: BlockName.optional(), stone: BlockName.optional(), roof: BlockName.optional(), accent: BlockName.optional() }),
]);
export type PaletteSpec = z.infer<typeof PaletteSpec>;

/** Param values ({ floors: 2, porch: false, roof: 'hip' }); the kit checks them against the design's params. */
export const ParamValues = z
  .record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,31}$/), z.union([z.number().int().min(-1000).max(1000), z.boolean(), z.string().max(32)]))
  .refine((v) => Object.keys(v).length <= 16, 'at most 16 values');
export type ParamValues = z.infer<typeof ParamValues>;

export const Variant = z.object({
  id: Id.describe('"v<n>"'),
  kind: z.enum(['variant', 'import']).describe('(addition) a variant of a library entry, or an imported .nbt'),
  from: z.string().min(1).max(4096).describe('variant: the library id it is made from; import: the absolute .nbt path'),
  status: VariantStatus,
  step: z.string().describe('one line of progress'),
  palette: PaletteSpec.optional().describe('(addition) variant: the palette asked for'),
  values: ParamValues.optional().describe('(addition) variant: the param values asked for'),
  name: z.string().optional().describe("(addition) the name asked for; when done, the new entry's display name (variant) or name (import)"),
  blueprintId: z.string().optional().describe('done: the new library id'),
  size: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).optional(),
  previews: z.array(z.string()).optional().describe('(addition) done: absolute paths of the preview PNGs'),
  error: z.string().optional().describe('failed: why, with the checker lines'),
  bible: z.object({ id: BibleId, version: z.number().int().min(1) }).optional().describe('(4b) a re-skin: the bible (and version) it is built with'),
  reskin: Id.optional().describe('(4b) the reskin.request this variant belongs to'),
  copy: z
    .object({
      group: z.string(),
      itemKey: GroupItemKey,
      archetype: GroupItemKey,
      ordinal: z.number().int().min(1),
      attempts: z.number().int().min(0).optional(),
      recipe: z.record(z.string(), z.unknown()).optional().describe('the recipe that built (or the last one tried)'),
      fallbackReason: z.enum(['size', 'conformance', 'check']).optional().describe('failed: why every recipe failed'),
      plan: z.record(z.string(), z.unknown()).optional().describe("the runner's inputs: the copy item's request, the archetype's massing"),
    })
    .optional()
    .describe('(0b) a copy in a design group: built from its archetype entry with a recipe'),
  createdAt: Ts,
  updatedAt: Ts,
});
export type Variant = z.infer<typeof Variant>;

// ---- phase 4b: style bibles, design groups, estimates, re-skins (docs/CONTRACT.md "Phase 4b contract") ----

export const BiblePin = z.object({ id: BibleId, version: z.number().int().min(1) });
export type BiblePin = z.infer<typeof BiblePin>;
/** A bible reference in a request: an id (its latest version) or { id, version }. */
export const BibleRef = z.union([BibleId, z.object({ id: BibleId, version: z.number().int().min(1).optional() })]);
export type BibleRef = z.infer<typeof BibleRef>;

export const MAX_GROUP_ITEMS = 24;

export const GroupItemInput = DesignRequestBase.extend({
  type: OpenType,
  profile: Profile.optional(),
  itemKey: ItemKey.optional().describe("the caller's key, unique in the group (default item<n>)"),
  ext: Ext.optional(),
  role: ItemRole.optional().describe('landmark (default model claude-opus-5-5) or ordinary (claude-sonnet-5-5, the default)'),
  model: ModelId.optional(),
  wave: z.number().int().min(1).max(8).optional().describe('default 1; a wave starts when the previous one is done or failed'),
  anchor: z.boolean().optional().describe('true = wave 0 (designed first; later waves see its render)'),
  owner: Owner.optional(),
  budgetUsd: BudgetUsd.optional(),
  critique: CritiqueSpec.optional().describe("(5a) this item's critique (wins over the group's)"),
  count: z.number().int().min(1).max(MAX_GROUP_ITEMS).optional().describe('(0b, C1) placements of this item: <key>, <key>#2 ... <key>#n; every copyCap-th starts a new archetype, the others are $0 copies'),
  copyOf: ItemKey.optional().describe("(0b, C1) this item is a copy of that item's archetype (counts toward its copyCap)"),
  effort: ItemEffort.optional().describe('(0b, C8) default auto'),
}).superRefine(noDuplicateFeatures);
export type GroupItemInput = z.infer<typeof GroupItemInput>;

export const GroupRequest = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().describe('ignored when taken; the sidecar answers the id it used'),
    name: z.string().trim().min(1).max(60),
    bible: BibleRef.describe('the style bible every item designs with (pinned to its version now)'),
    owner: Owner.optional(),
    ext: Ext.optional(),
    concurrency: z.number().int().min(1).max(6).optional().describe('default 3; the sidecar-wide designConcurrency caps all groups'),
    budgetUsd: BudgetUsd.optional().describe("hard cap on the group's total; queued items are cancelled with error \"budget\" when it is reached"),
    items: z.array(GroupItemInput).min(1).max(MAX_GROUP_ITEMS),
    massingFirst: z.boolean().optional().describe('(4c) every item gets a massing first (in waves); then the group awaits approval (group.approve)'),
    approvalUi: z.enum(['architect', 'owner']).optional().describe('(4c) who approves: architect (the mod\'s UI, default) or owner (only group.approve with the group\'s owner)'),
    maxRedirects: z.number().int().min(0).max(10).optional().describe('(4c) redirect rounds per item (default 3)'),
    context: Context.optional().describe('(4c) goes into every item\'s brief (massing and detail)'),
    critique: CritiqueSpec.optional().describe('(5a) the default critique of the items (an item\'s own spec wins); default off'),
    copyCap: z.number().int().min(1).max(3).optional().describe('(0b, C1) placements per design (an archetype and its copies); default 3, 1 = all originals'),
    smallBySize: z.boolean().optional().describe('(0b, C2/C8) an item whose maxSize footprint fits 11 x 9 either way is small: no report critique, the SMALL detail pass'),
  })
  .superRefine((g, ctx) => {
    const keys = g.items.map((it, i) => it.itemKey ?? `item${i + 1}`);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['items'], message: 'duplicate itemKey' });
    if (g.approvalUi === 'owner' && !g.owner) ctx.addIssue({ code: 'custom', path: ['approvalUi'], message: 'approvalUi "owner" needs the group\'s owner' });
  });
export type GroupRequest = z.infer<typeof GroupRequest>;

export const GroupStatus = z
  .enum(['queued', 'running', 'held_usage', 'paused_budget', 'awaiting_approval', 'done', 'failed', 'cancelled'])
  .describe('held_usage: a usage limit holds every item; paused_budget: the soft budget stopped dispatching (extend / resume); awaiting_approval (4c, massingFirst): an item waits for group.approve and no massing of the group is still open; done: every item ended and at least one is done; failed: none is; done, failed and cancelled are final');
export type GroupStatus = z.infer<typeof GroupStatus>;

export const GroupItem = z.object({
  itemKey: GroupItemKey,
  ext: Ext.optional(),
  designId: z.union([Id, z.literal('')]).describe('the item\'s current design ("" for a copy: it has a variant job)'),
  entryId: z.string().optional().describe('done: the library entry'),
  status: DesignStatus,
  step: z.string(),
  cost: Cost,
  wave: z.number().int().min(0),
  role: ItemRole,
  model: z.string(),
  type: z.string(),
  name: z.string().optional(),
  error: z.string().optional(),
  stage: z.enum(['massing', 'approval', 'detail', 'copy']).optional().describe('(4c, massingFirst) massing: its massing (or a redirect) is designing; approval: it waits for group.approve; detail: its detail pass; (0b) copy: a copy waiting for or building from its archetype'),
  massing: z.object({ id: MassingId, version: z.number().int().min(1) }).optional().describe('(4c) the item\'s massing (the latest version)'),
  rounds: z.number().int().min(0).optional().describe('(4c) redirect rounds so far (capped at the group\'s maxRedirects)'),
  designIds: z.array(Id).optional().describe('(4c) every design of the item, oldest first (massings, redirects, the detail); designId is the latest'),
  critique: z.object({ rounds: z.number().int(), best: z.number().int().optional(), end: EndReason.optional(), overall: z.number().nullable().optional() }).optional().describe('(5a) the critique summary of its design'),
  kind: z.enum(['original', 'copy', 'fallback']).optional().describe('(0b, C1) original (absent = original), copy (a $0 variant of its archetype) or fallback (a copy whose recipes all failed, or promoted: an original)'),
  copyOf: GroupItemKey.optional().describe("(0b) a copy or fallback: its archetype's itemKey"),
  variantJob: Id.optional().describe('(0b) a copy: its variant job'),
  fallbackReason: z.string().optional().describe('(0b) a fallback: size | conformance | check | promoted, with the message'),
  effort: z.enum(['standard', 'small']).optional().describe('(0b, C8) the effort its detail pass runs with'),
  recipe: z.record(z.string(), z.unknown()).optional().describe('(0b) a copy: its recipe (shift, values, mirror, ...)'),
});
export type GroupItem = z.infer<typeof GroupItem>;

export const Group = z.object({
  id: Id.describe('"g<n>"'),
  name: z.string(),
  bible: BiblePin,
  owner: z.string().optional(),
  ext: Ext.optional(),
  concurrency: z.number().int(),
  budgetUsd: z.number().optional(),
  softBudgetFraction: z.number(),
  status: GroupStatus,
  reason: z.string().optional().describe('why it is paused / failed / cancelled ("budget", ...)'),
  items: z.array(GroupItem),
  designs: z.array(z.object({ id: Id, status: DesignStatus, step: z.string() })).describe('(contract shape) the items as designs'),
  wave: z.number().int().optional().describe('the wave running now'),
  done: z.number().int(),
  failed: z.number().int(),
  cost: Cost.describe('the sum of the items'),
  usageLimitUntil: Ts.optional(),
  massingFirst: z.boolean().optional().describe('(4c)'),
  approvalUi: z.enum(['architect', 'owner']).optional().describe('(4c) default architect'),
  maxRedirects: z.number().int().optional().describe('(4c) massingFirst: redirect rounds per item'),
  context: Context.optional().describe('(4c)'),
  awaiting: z.array(GroupItemKey).optional().describe('(4c) the items waiting for group.approve'),
  copyCap: z.number().int().optional().describe('(0b) placements per design'),
  smallBySize: z.boolean().optional().describe('(0b)'),
  createdAt: Ts,
  updatedAt: Ts,
});
export type Group = z.infer<typeof Group>;

/** (4c) a massing version (docs/CONTRACT.md "4c review folded in" item 2); listed by massing.list, sent by massing.upsert. */
export const Massing = z.object({
  id: MassingId,
  version: z.number().int().min(1),
  versions: z.array(z.number().int()).describe('every installed version of this massing'),
  designId: Id.describe('the massing job (design) that made this version'),
  type: z.string(),
  name: z.string().optional(),
  itemKey: ItemKey.optional(),
  ext: Ext.optional(),
  owner: z.string().optional(),
  group: z.string().optional(),
  bible: BiblePin.optional().describe('the bible pin'),
  parts: z.record(z.string(), z.unknown()).describe('the named masses: { <name>: { box, cells, ... } } from the blueprint JSON'),
  size: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  request: DesignRequest,
  cost: Cost,
  dir: z.string().describe('absolute path of the version folder (<massings>/<id>/versions/<v>/); <massings>/<id>/ holds a copy of the latest'),
  nbt: z.string().describe('absolute path of the .nbt in the version folder'),
  previews: z.array(z.string()),
  redirect: z.object({ fromVersion: z.number().int(), notes: z.string() }).optional().describe('this version is a redirect of fromVersion'),
  detail: z.object({ designId: Id, status: DesignStatus, entryId: z.string().optional(), at: Ts.optional() }).optional().describe('the latest detail pass made from this massing (any version)'),
  createdAt: Ts,
});
export type Massing = z.infer<typeof Massing>;

const CritiqueFigures = {
  critiqueUsdLow: z.number().optional().describe('(5a) the critique loop on top of the design figures (absent: critique off)'),
  critiqueUsdHigh: z.number().optional(),
  critiqueMinutesLow: z.number().optional().describe('(5a) the wall time the critique adds'),
  critiqueMinutesHigh: z.number().optional(),
};
const PolishFigures = {
  polishUsdLow: z.number().optional().describe('(5b) a polish (design.estimate {polish}), on its own'),
  polishUsdHigh: z.number().optional(),
  polishMinutesLow: z.number().optional(),
  polishMinutesHigh: z.number().optional(),
};
export const Estimate = z.object({
  ...PolishFigures,
  usdLow: z.number(),
  usdHigh: z.number(),
  minutesLow: z.number(),
  minutesHigh: z.number(),
  basis: z.string().describe('what it is computed from: "seed" values or "<n> measured" designs per model, the concurrency, the usage limit'),
  ...CritiqueFigures,
  items: z
    .array(z.object({ itemKey: z.string().optional(), usdLow: z.number(), usdHigh: z.number(), minutesLow: z.number(), minutesHigh: z.number(), ...CritiqueFigures }))
    .optional()
    .describe('(5a) per item (a group estimate), the design figures and the critique figures'),
});
export type Estimate = z.infer<typeof Estimate>;

export const BibleScope = z.enum(['building', 'settlement']);
export const BibleRequest = z.object({
  prompt: z.string().trim().min(1).max(2000).describe('what the place is ("weathered fishing village on stilts")'),
  name: z.string().trim().min(1).max(40).optional(),
  owner: Owner.optional(),
  ext: Ext.optional(),
  model: ModelId.optional().describe('default config bibleModel (claude-opus-5-5)'),
  budgetUsd: BudgetUsd.optional(),
  references: z.array(z.string().regex(LIBRARY_ID).max(64)).max(8).optional().describe('library entries whose look to learn from'),
  scope: BibleScope.optional().describe('settlement: also the macro roles rock, surface, subsurface, rubble, rail, structure'),
  seedPreset: z.string().regex(/^[a-z0-9_]{1,32}$/).optional().describe('start from a built-in bible (the palette presets)'),
  critique: z.object({ mode: z.enum(['off', 'report']), model: ModelId.optional() }).optional().describe('(5a) report: the bible job ends with one critic call on sheet.png, stored in bible.json critique'),
});
export type BibleRequest = z.infer<typeof BibleRequest>;

export const BibleInfo = z.object({
  id: BibleId,
  name: z.string(),
  version: z.number().int(),
  versions: z.array(z.number().int()),
  builtin: z.boolean(),
  scope: BibleScope,
  prompt: z.string().optional(),
  roles: z.record(z.string(), z.string()),
  prose: z.string().optional().describe('bible.md (at most 8000 characters)'),
  sheetPath: z.string().optional().describe('absolute path of sheet.png'),
  dir: z.string().optional().describe('absolute path of the version folder'),
  components: z.array(z.string()),
  owner: z.string().optional(),
  ext: Ext.optional(),
  createdAt: Ts.optional(),
  cost: Cost.optional(),
  format: z.number().int().optional().describe('(5a) the bible format: 1 (4b) or 2 (with restraint)'),
  restraint: z
    .object({ heroMotifs: z.array(z.string()), accentShareMax: z.number(), detailDensity: z.enum(['sparse', 'moderate', 'rich']), windowsPerFacadeMin: z.number().int() })
    .optional()
    .describe('(5a) the effective restraint (a format-1 bible: the defaults, hero motifs = its first 3 motifs)'),
  archived: z.boolean().optional().describe('(5a) hidden from the pickers (bible.archive); its entries are unaffected'),
  critique: z.record(z.string(), z.unknown()).optional().describe('(5a) the sheet critique (overall, scores, issues), when the bible job had one'),
});
export type BibleInfo = z.infer<typeof BibleInfo>;

export const BibleJobStatus = z
  .enum(['queued', 'drafting', 'components', 'checking', 'rendering', 'done', 'failed', 'cancelled'])
  .describe('queued -> drafting (the structured bible) -> components (the agent writes components.mjs) -> checking (the component frame, pristine kit) -> rendering (sheet) -> done; failed and cancelled; done, failed and cancelled are final');
export type BibleJobStatus = z.infer<typeof BibleJobStatus>;

export const BibleJob = z.object({
  id: Id.describe('"b<n>"'),
  kind: z.enum(['request', 'revise']),
  bibleId: BibleId.describe('the bible it makes (request: reserved at once) or revises'),
  version: z.number().int().min(1).describe('the version it makes'),
  request: BibleRequest.extend({ notes: z.string().max(4000).optional() }),
  status: BibleJobStatus,
  step: z.string(),
  error: z.string().optional(),
  cost: Cost,
  rounds: z.number().int().optional().describe('component rounds so far'),
  usageLimitUntil: Ts.optional(),
  bible: BibleInfo.optional().describe('done: the installed bible'),
  createdAt: Ts,
  updatedAt: Ts,
});
export type BibleJob = z.infer<typeof BibleJob>;

export const ReskinFrom = z
  .object({
    group: z.string().max(64).optional(),
    bible: BibleId.optional(),
    bibleVersion: z.number().int().min(1).optional(),
    entries: z.array(z.string().regex(LIBRARY_ID).max(64)).max(64).optional(),
  })
  .refine((f) => !!(f.group || f.bible || f.entries?.length), 'from needs a group, a bible or entries');
export type ReskinFrom = z.infer<typeof ReskinFrom>;

export const Reskin = z.object({
  id: Id.describe('"r<n>"'),
  bible: BiblePin,
  from: ReskinFrom,
  status: z.enum(['building', 'done', 'failed']),
  step: z.string(),
  variants: z.array(Id),
  entries: z.array(z.string()).describe('the new library entries, as they finish'),
  done: z.number().int(),
  failed: z.number().int(),
  error: z.string().optional(),
  createdAt: Ts,
  updatedAt: Ts,
});
export type Reskin = z.infer<typeof Reskin>;

/** What `node kit/tools/describe.mjs --palettes` prints. */
export const KitPalettes = z.object({
  palettes: z.array(z.object({ name: z.string(), preset: z.string().optional(), wood: z.string(), stone: z.string(), roof: z.string(), accent: z.string() })),
  choices: z.object({ woods: z.array(z.string()), stones: z.array(z.string()), roofs: z.array(z.string()) }),
});
export type KitPalettes = z.infer<typeof KitPalettes>;

/** (addition) What the mod's palette picker shows: the kit's presets (inputs) and what a custom palette accepts. */
export const PaletteInfo = z.object({
  presets: z.record(z.string(), z.object({ wood: z.string(), stone: z.string(), roof: z.string(), accent: z.string() })),
  woods: z.array(z.string()),
  stones: z.array(z.string()),
  roofs: z.array(z.string()),
});
export type PaletteInfo = z.infer<typeof PaletteInfo>;

// ---- jobs and blobs (protocol 2, docs/CONTRACT.md "Jobs (R2): protocol 2") ------------------

/** A tool result or a job result larger than this (as JSON) is refused / goes to a blob. */
export const MAX_RESULT_BYTES = 256 * 1024;
/** One blob chunk, decoded. */
export const MAX_CHUNK_BYTES = 1024 * 1024;
/** One blob, in all. */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;
/** A JSON Schema object (validated by the sidecar's own subset validator, src/jobs/schema.ts). */
export const JsonSchema = z.record(z.string(), z.unknown());
export const BLOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const BlobId = z.string().regex(BLOB_ID, 'blob ids are [A-Za-z0-9_-]{1,64}');
export const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** The tool every agent job gets for progress lines. */
export const JOB_STATUS_TOOL = 'job_status';

export const JobTool = z.object({
  name: z.string().regex(TOOL_NAME, 'tool names are [A-Za-z0-9_-]{1,64}').refine((n) => n !== JOB_STATUS_TOOL, `"${JOB_STATUS_TOOL}" is the sidecar's own tool`),
  description: z.string().max(4000),
  inputSchema: JsonSchema.describe('JSON Schema of the input object'),
  timeoutMs: z.number().int().min(100).max(24 * 3600_000).optional().describe('default 60000; counts only while the client is connected and not paused'),
  readOnly: z.boolean().optional().describe('the mod may run the handler off the server thread'),
});
export type JobTool = z.infer<typeof JobTool>;

export const JobKind = z.enum(['structured', 'agent']);
/** (5a) images per job (JobSpec.images) and their size */
export const MAX_JOB_IMAGES = 8;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export type JobKind = z.infer<typeof JobKind>;

export const JobSpec = z
  .object({
    kind: JobKind,
    prompt: z.string().min(1).max(200_000),
    system: z.string().max(50_000).optional(),
    model: ModelId.optional().describe('default config jobModel ("claude-sonnet-5-5")'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    schema: JsonSchema.optional().describe('structured: required, the answer must validate; agent: optional, asks for a final JSON answer'),
    tools: z.array(JobTool).max(64).optional().describe('agent: the mod-provided tools'),
    budgetUsd: BudgetUsd.optional().describe('hard stop on the estimated cost, across resumes'),
    maxTurns: z.number().int().min(1).max(500).optional(),
    owner: Owner.optional(),
    tag: z.string().max(200).optional(),
    group: z.string().max(200).optional().describe('reserved for 4b'),
    ext: Ext.optional(),
    blobs: z.array(BlobId).max(32).optional().describe('copied into the job scratch dir as blobs/<id>.<ext>'),
    images: z
      .array(z.object({ blob: BlobId, label: z.string().trim().min(1).max(200) }))
      .max(MAX_JOB_IMAGES)
      .optional()
      .describe('(5a) PNG or JPEG blobs (at most 8, 5 MB each) sent as image content blocks before the prompt text, each after its label'),
  })
  .superRefine((s, ctx) => {
    if (s.kind === 'structured' && !s.schema) ctx.addIssue({ code: 'custom', path: ['schema'], message: 'a structured job needs a schema' });
    if (s.kind === 'structured' && s.tools?.length) ctx.addIssue({ code: 'custom', path: ['tools'], message: 'a structured job has no tools (use an agent job)' });
    const names = (s.tools ?? []).map((t) => t.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', path: ['tools'], message: 'duplicate tool name' });
    if (s.blobs && new Set(s.blobs).size !== s.blobs.length) ctx.addIssue({ code: 'custom', path: ['blobs'], message: 'duplicate blob id' });
    if (s.images?.length && s.kind !== 'structured' && s.kind !== 'agent') ctx.addIssue({ code: 'custom', path: ['images'], message: 'images need a job kind' });
  });
export type JobSpec = z.infer<typeof JobSpec>;

export const JobStatus = z
  .enum(['queued', 'running', 'waiting_tool', 'held', 'done', 'failed', 'cancelled'])
  .describe('queued -> running <-> waiting_tool -> done | failed | cancelled; held = waiting for a usage limit to reset. done, failed and cancelled are final.');
export type JobStatus = z.infer<typeof JobStatus>;

export const Job = z.object({
  id: Id.describe('"j<n>"'),
  spec: z.record(z.string(), z.unknown()).describe('the JobSpec, its prompt cut at 2000 chars'),
  status: JobStatus,
  step: z.string(),
  result: z.unknown().optional().describe('done: structured -> the validated JSON; agent -> { text, json? }'),
  resultBlob: BlobId.optional().describe('(addition) done: the result was larger than 256 KB and is in this blob instead'),
  error: z.string().optional().describe('failed: why ("budget" when the budget stopped it)'),
  cost: Cost,
  usageLimitUntil: Ts.optional().describe('(addition) held: when the usage limit resets'),
  createdAt: Ts,
  updatedAt: Ts,
});
export type Job = z.infer<typeof Job>;

// ---- phase 6a: region programs (docs/CONTRACT.md "Phase 6 contract" §6, kit/REGIONS.md "Sidecar protocol") ----

/** A plan id (the sidecar picks it; it names <data>/regions/plans/<planId>/). */
export const PLAN_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const PlanId = z.string().regex(PLAN_ID, 'plan ids are [A-Za-z0-9_-]{1,64}');
/** A bundled region program: kit/regions/<id>.mjs */
export const REGION_PROGRAM_ID = /^[a-z][a-z0-9_]{0,47}$/;
/** A tile key: "<tx>,<tz>" (tile = 64x64 columns, tx = floor(x / 64)). */
export const TILE_KEY = /^-?\d{1,7},-?\d{1,7}$/;
export const TileKey = z.string().regex(TILE_KEY, 'a tile key is "<tx>,<tz>"');
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'a sha is 64 lowercase hex digits');
export const TileSet = z.enum(['terrain', 'path']);
export const StageName = z.string().min(1).max(64);
/** The largest region claim the sidecar accepts (the mod refuses over 1024 unless -Darchitect.dev.bigRegions=true: 2048). */
export const MAX_CLAIM_COLUMNS = 2048;
export const RegionClaim = z
  .object({ minX: z.number().int(), minZ: z.number().int(), maxX: z.number().int(), maxZ: z.number().int(), minY: z.number().int().min(-2048).max(4096), maxY: z.number().int().min(-2048).max(4096) })
  .refine((c) => c.minX <= c.maxX && c.minZ <= c.maxZ && c.minY <= c.maxY, 'a claim needs min <= max on every axis')
  .refine((c) => c.maxX - c.minX < MAX_CLAIM_COLUMNS && c.maxZ - c.minZ < MAX_CLAIM_COLUMNS, `a claim is at most ${MAX_CLAIM_COLUMNS}x${MAX_CLAIM_COLUMNS} columns`);
export type RegionClaim = z.infer<typeof RegionClaim>;
/** A block state string ("minecraft:stone", "minecraft:oak_stairs[facing=north,half=bottom]"). */
const BlockState = z.string().min(1).max(256).regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+(\[[a-z0-9_]+=[a-z0-9_]+(,[a-z0-9_]+=[a-z0-9_]+)*\])?$/, 'not a block state');
/** One frame of a packed tile: base64 of at most 1 MB of gzip bytes. */
export const MAX_TILE_FRAME_BYTES = 1024 * 1024;
/** A tile's heights: base64 of an ARSV columns buffer (80x80 window: 44,828 bytes; at most 256 KB). */
export const MAX_TILE_HEIGHTS_BYTES = 256 * 1024;
/** Tiles in one region.tiles.request. */
export const MAX_TILES_PER_REQUEST = 64;
/** The IR (canonical JSON) is at most this; over 1 MB it travels as a blob (irBlobId). */
export const MAX_IR_BYTES = 4 * 1024 * 1024;
export const IR_INLINE_BYTES = 1024 * 1024;
/** (6b) a ghost tile's stage or set when the request named none: every stage / both sets. */
export const TileOrAll = z.union([TileSet, z.literal('*')]);
/** (6b) a box of whole blocks (inclusive). */
export const VolumeBox = z
  .object({ minX: z.number().int(), minY: z.number().int(), minZ: z.number().int(), maxX: z.number().int(), maxY: z.number().int(), maxZ: z.number().int() })
  .refine((b) => b.minX <= b.maxX && b.minY <= b.maxY && b.minZ <= b.maxZ, 'a box needs min <= max on every axis');
/** (6b) a side blob of a plan (kit/REGIONS.md "Side blobs"). */
export const PlannedBlob = z.object({ name: z.string(), sha: z.string(), bytes: z.number().int().nonnegative(), kind: z.string(), blobId: z.string() });
/** (6b) the preview views (kit/REGIONS.md "Kit CLI and modules (6b)"). */
export const PREVIEW_VIEWS = ['top', 'section', 'iso', 'siteplan'] as const;
export const PreviewView = z.enum(PREVIEW_VIEWS);
/** (6b) section axes: at most 4 polylines of 2..64 [x, y, z] points. */
export const SectionAxes = z.array(z.array(z.tuple([z.number().int(), z.number().int(), z.number().int()])).min(2).max(64)).min(1).max(4);
const Base64 = (maxBytes: number) => z.string().max(Math.ceil(maxBytes / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'not base64');

// ---- messages --------------------------------------------------------------------------------

const envelope = <T extends string>(type: T) => ({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal(type),
  id: z.string().max(200).optional().describe('client correlation id; answered with `ack` {re: id}'),
});

// sidecar -> client
const snapshotFields = {
  ...envelope('snapshot'),
  version: z.string(),
  status: Status,
  variants: z.array(Variant).describe('the last 20 variant/import jobs plus any unfinished one'),
  palettes: PaletteInfo.optional().describe('(addition) the kit palette presets and choices, when the kit could describe them'),
};
export const SnapshotMsgV1 = z.object({ ...snapshotFields, designs: z.array(DesignV1) });
export const SnapshotMsg = z.object({
  ...snapshotFields,
  designs: z.array(Design),
  protocol: z.number().int().optional().describe('(protocol 2) the protocol chosen for this connection'),
  features: z.array(z.string()).optional().describe('(protocol 2) e.g. "job.run", "job.tools", "blobs", "budget", "designs.v2"'),
  jobs: z.array(Job).optional().describe('(protocol 2) the last 20 jobs plus any unfinished one'),
  groups: z.array(Group).optional().describe('(4b) the last 20 design groups plus any unfinished one'),
  bibles: z.array(BibleJob).optional().describe('(4b) the last 20 bible jobs plus any unfinished one'),
  bibleIndex: z.array(BibleInfo).optional().describe('(4b) every installed bible (latest version) and the built-in ones'),
  reskins: z.array(Reskin).optional().describe('(4b) the last 20 re-skins plus any unfinished one'),
  massings: z.array(Massing).optional().describe('(4c) the latest version of every open massing (not detailed, its group not final) plus the last 20'),
  kitVersion: z.string().optional().describe("(6b) the sidecar kit's KIT_VERSION (kit/lib/region/plan.mjs), 'unknown' when the kit has none"),
  irFormats: z.array(z.number().int()).optional().describe("(6b) the IR formats the sidecar kit's evaluator reads (IR_FORMATS; [1] for an older kit)"),
  irKinds: z.array(z.string()).optional().describe('(6b) the format-2 kinds the sidecar kit knows (KINDS_FORMAT2)'),
});
export const StatusMsg = z.object({ ...envelope('status'), status: Status });
export const DesignUpsertMsgV1 = z.object({ ...envelope('design.upsert'), design: DesignV1 });
export const DesignUpsertMsg = z.object({ ...envelope('design.upsert'), design: Design });
export const VariantUpsertMsg = z.object({ ...envelope('variant.upsert'), variant: Variant });
export const AckMsg = z.object({
  ...envelope('ack'),
  re: z.string().describe('the `id` of the client message'),
  ok: z.boolean(),
  error: z.string().optional(),
  code: z.string().optional().describe('(0b) a typed refusal: COPY_REFUSED | VERSION_REFUSED (the mod maps it to Reason)'),
  detail: z.string().optional().describe('(0b) the refusal sub-code (landmark, unknown, self, cap; bundled, no_source, massing, copy, busy, site_mismatch, group, base_moved)'),
  result: z.record(z.string(), z.unknown()).optional().describe('design.request: {designId}; variant.request / import.request: {variantId}; job.run: {jobId}; blob.put: {blobId, size, complete}'),
});
export const ErrorMsg = z.object({ ...envelope('error'), message: z.string(), re: z.string().optional() });
export const JobUpsertMsg = z.object({ ...envelope('job.upsert'), job: Job });
export const JobEventMsg = z.object({
  ...envelope('job.event'),
  jobId: Id,
  kind: z.enum(['text', 'step', 'tool']),
  data: z.record(z.string(), z.unknown()).describe('text: {text}; step: {step}; tool: {phase: call|result|error|timeout, name, callId}'),
});
export const JobToolCallMsg = z.object({
  ...envelope('job.tool.call'),
  jobId: Id,
  callId: Id,
  name: z.string(),
  input: z.unknown(),
  owner: z.string().optional().describe("(addition) the job's spec.owner, so the client can find the handler (owner, name)"),
  timeoutMs: z.number().int().optional().describe('(addition) the tool timeout in force'),
});

export const GroupUpsertMsg = z.object({ ...envelope('group.upsert'), group: Group });
export const BibleUpsertMsg = z.object({ ...envelope('bible.upsert'), bible: BibleJob });
export const BibleIndexMsg = z.object({ ...envelope('bible.index'), bibles: z.array(BibleInfo).describe('every installed bible and the built-in ones (sent when one is installed)') });
export const ReskinUpsertMsg = z.object({ ...envelope('reskin.upsert'), reskin: Reskin });
export const MassingUpsertMsg = z.object({ ...envelope('massing.upsert'), massing: Massing });
export const MassingRemovedMsg = z.object({ ...envelope('massing.removed'), massingId: MassingId, reason: z.enum(['deleted', 'gc']) });
// 6a regions (sidecar -> client)
export const RegionPlannedMsg = z
  .object({
    ...envelope('region.planned'),
    planId: PlanId,
    irSha: Sha256Hex.describe('SHA-256 (hex) of the canonical IR JSON (ir.json), the plan\'s identity'),
    ir: z.string().optional().describe('the exact ir.json text (canonical JSON; its SHA-256 is irSha), when it is at most 1 MB'),
    irBlobId: BlobId.optional().describe('instead of ir when the IR is over 1 MB: the blob (<data>/blobs/<id>) holding the exact ir.json bytes'),
    lots: z.array(z.unknown()),
    stages: z.array(z.string()),
    anchors: z.record(z.string(), z.unknown()),
    budget: z.record(z.string(), z.unknown()),
    tiles: z.record(z.string(), z.unknown()).describe('{"<stage>": {terrain: [key], path: [key]}}, from the IR'),
    notes: z.array(z.string()),
    ms: z.number().int().nonnegative().optional().describe('(addition) the plan run\'s wall time'),
    // (6b) kit/REGIONS.md "Protocol (2, additive)"
    irFormat: z.number().int().min(1).optional().describe('(6b) the IR format (1|2)'),
    requires: z.array(z.string()).optional().describe('(6b) the format-2 kinds the IR uses ([] for format 1)'),
    kitVersion: z.string().optional().describe("(6b) the IR's kitVersion"),
    blobs: z.array(PlannedBlob).optional().describe('(6b) the side blobs (each also a blob-store blob of kind region.blob)'),
    needVolumes: z.array(VolumeBox).optional().describe('(6b) boxes the program asked for with r.needVolume'),
    report: z.record(z.string(), z.unknown()).optional().describe('(6b) report.json (absent with check: false or when the check failed)'),
    previews: z.record(z.string(), z.array(z.string())).optional().describe('(6b) {top: [path], section: [path...], iso: [path], siteplan: [svgPath, pngPath]} (absolute paths in the plan dir)'),
    sitePlan: z.record(z.string(), z.unknown()).optional().describe('(6b) siteplan.json'),
    checkMs: z.number().int().nonnegative().optional().describe('(6b) the check run\'s wall time'),
    renderMs: z.number().int().nonnegative().optional().describe('(6b) the preview run\'s wall time'),
    checkError: z.string().optional().describe('(6b addition) the check or the previews failed (the plan itself is good): why'),
  })
  .refine((m) => (m.ir === undefined) !== (m.irBlobId === undefined), 'exactly one of ir and irBlobId');
export const RegionProgressMsg = z.object({ ...envelope('region.progress'), planId: PlanId, phase: z.enum(['planning', 'checking', 'rendering']) });
export const RegionFailedMsg = z.object({ ...envelope('region.failed'), planId: PlanId, message: z.string() });
export const RegionTileMsg = z.object({
  ...envelope('region.tile'),
  planId: PlanId,
  key: TileKey,
  stage: StageName.describe("the request's stage; (6b) a ghost tile without one: '*' (every stage)"),
  set: TileOrAll.describe("the request's set; (6b) a ghost tile without one: '*' (both sets)"),
  preview: z.literal(true).optional().describe('(6b) a ghost tile (region.tiles.request preview: true): evaluated over the plan survey'),
  seq: z.number().int().nonnegative().describe('the frame number, from 0'),
  more: z.boolean().describe('true on every frame but the last'),
  data: Base64(MAX_TILE_FRAME_BYTES).describe('base64 of a slice of gzipPinned(payload), at most 1 MB of gzip bytes'),
  count: z.number().int().nonnegative().describe('cells in the tile'),
  sha: Sha256Hex.describe('SHA-256 of the whole UNCOMPRESSED ARTL payload'),
});
export const RegionTileErrorMsg = z.object({ ...envelope('region.tile.error'), planId: PlanId, key: TileKey, stage: StageName, set: TileOrAll, preview: z.literal(true).optional(), message: z.string() });
export const EntryVersionedMsg = z.object({ ...envelope('entry.versioned'), entryId: z.string(), version: z.number().int().min(1), from: z.number().int().min(1).describe('the head before'), by: z.enum(['design', 'polish', 'revert', 'migrated']), designId: z.string().optional() });

export const ServerMessage = z.discriminatedUnion('type', [SnapshotMsg, StatusMsg, DesignUpsertMsg, VariantUpsertMsg, AckMsg, ErrorMsg, JobUpsertMsg, JobEventMsg, JobToolCallMsg, GroupUpsertMsg, BibleUpsertMsg, BibleIndexMsg, ReskinUpsertMsg, MassingUpsertMsg, MassingRemovedMsg, EntryVersionedMsg, RegionPlannedMsg, RegionFailedMsg, RegionTileMsg, RegionTileErrorMsg, RegionProgressMsg]);
export type ServerMessage = z.infer<typeof ServerMessage>;
/** What protocol 1 knows: the phase 1-3 messages, with their phase 1-3 fields. */
export const ServerMessageV1 = z.discriminatedUnion('type', [SnapshotMsgV1, StatusMsg, DesignUpsertMsgV1, VariantUpsertMsg, AckMsg, ErrorMsg]);

// client -> sidecar
export const HelloMsg = z.object({
  ...envelope('hello'),
  client: z.string().max(40).optional().describe('"mod" | "cli"; the same name after a restart gets pending tool calls re-sent'),
  version: z.string().max(80).optional().describe('the client version (informational)'),
  token: z.string().max(200).optional().describe('the contents of <data>/client.token'),
  protocols: z.array(z.number().int().min(1).max(1000)).min(1).max(16).optional().describe('(protocol 2) the protocols the client speaks, e.g. [1, 2]; absent = [1]'),
});
const designRequestMsg = { ...envelope('design.request') };
export const DesignRequestMsgV1 = z.object({ ...designRequestMsg, request: DesignRequestV1 });
export const DesignRequestMsg = z.object({ ...designRequestMsg, request: DesignRequest });
export const DesignCancelMsg = z.object({ ...envelope('design.cancel'), designId: Id });
export const AuthSetMsg = z.object({
  ...envelope('auth.set'),
  apiKey: z.string().trim().min(1).max(500).nullable().optional().describe('a string sets the key, null clears it, absent keeps it'),
  useClaudeLogin: z.boolean().optional(),
});
export const ShutdownMsg = z.object({ ...envelope('shutdown') });
export const VariantRequestMsg = z.object({
  ...envelope('variant.request'),
  from: z.string().min(1).max(64).regex(LIBRARY_ID).describe('the library id to vary'),
  palette: PaletteSpec.optional(),
  values: ParamValues.optional(),
  name: z.string().trim().min(1).max(40).optional().describe('the displayName of the new entry (default: "<name> (<palette>, floors 2)")'),
  bible: BibleRef.optional().describe('(4b) a re-skin: build with this bible\'s roles (excludes palette); the design keeps its own components'),
});
export const ImportRequestMsg = z.object({
  ...envelope('import.request'),
  path: z.string().min(1).max(4096).describe("an absolute .nbt path in <gameDir>/architect/imports/, <gameDir>/architect/exports/ or a world's generated/<namespace>/structure(s)/"),
});
export const JobRunMsg = z.object({ ...envelope('job.run'), job: JobSpec });
export const JobCancelMsg = z.object({ ...envelope('job.cancel'), jobId: Id });
export const JobToolResultMsg = z.object({
  ...envelope('job.tool.result'),
  jobId: Id,
  callId: Id,
  result: z.unknown().optional().describe('any JSON, at most 256 KB'),
  error: z.string().max(10_000).optional().describe('the tool failed: the agent gets this text as an error'),
});
const base64 = z.string().max(Math.ceil(MAX_CHUNK_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'not base64');
export const BlobPutMsg = z
  .object({
    ...envelope('blob.put'),
    blobId: BlobId.optional().describe('absent: the sidecar picks one; an existing finished blob with this id is replaced'),
    kind: z.string().min(1).max(40).regex(/^[a-z0-9_.:-]+$/).optional().describe('required on the first frame, e.g. "survey"'),
    owner: Owner.optional(),
    ext: z.string().regex(/^[a-z0-9]{1,8}$/).optional().describe('(addition) the file extension in a job scratch dir; default json for data, bin for chunks'),
    data: z.unknown().optional().describe('a JSON blob, whole'),
    chunks: z.array(base64).max(64).optional().describe('binary, base64, at most 1 MB each (decoded)'),
    more: z.boolean().optional().describe('(addition) chunks only: more frames follow with the same blobId; the last frame omits it'),
  })
  .superRefine((m, ctx) => {
    const hasData = m.data !== undefined;
    if (hasData === (m.chunks !== undefined)) ctx.addIssue({ code: 'custom', path: ['data'], message: 'send exactly one of data and chunks' });
    if (hasData && m.more) ctx.addIssue({ code: 'custom', path: ['more'], message: 'more is for chunks only' });
  });
export const BlobDeleteMsg = z.object({ ...envelope('blob.delete'), blobId: BlobId });
export const ClientPausedMsg = z.object({ ...envelope('client.paused'), paused: z.boolean() });
// 4b
export const DesignGroupMsg = z.object({ ...envelope('design.group'), group: GroupRequest });
export const GroupCancelMsg = z.object({ ...envelope('group.cancel'), groupId: Id });
export const GroupExtendMsg = z.object({ ...envelope('group.extend'), groupId: Id, budgetUsd: BudgetUsd });
export const GroupResumeMsg = z.object({ ...envelope('group.resume'), groupId: Id });
export const DesignEstimateMsg = z
  .object({ ...envelope('design.estimate'), group: GroupRequest.optional(), request: DesignRequest.optional(), polish: PolishSpec.optional().describe('(5b) a polish of entryId'), entryId: z.string().regex(LIBRARY_ID).max(64).optional().describe('(5b) with polish') })
  .refine((m) => [m.group, m.request, m.polish].filter((x) => x !== undefined).length === 1, 'send exactly one of group, request and polish');
export const BibleRequestMsg = z.object({ ...envelope('bible.request'), request: BibleRequest });
export const BibleReviseMsg = z.object({ ...envelope('bible.revise'), id: BibleId, notes: z.string().trim().min(1).max(4000), model: ModelId.optional(), budgetUsd: BudgetUsd.optional(), critique: z.object({ mode: z.enum(['off', 'report']), model: ModelId.optional() }).optional().describe('(5a) a sheet critique at the end') });
export const BibleEstimateMsg = z.object({ ...envelope('bible.estimate'), request: BibleRequest.optional() });
export const BibleCancelMsg = z.object({ ...envelope('bible.cancel'), jobId: Id });
export const ReskinRequestMsg = z.object({ ...envelope('reskin.request'), bibleId: BibleId, version: z.number().int().min(1).optional(), from: ReskinFrom });
// 4c
export const MassingRedirectMsg = z.object({
  ...envelope('massing.redirect'),
  massingId: MassingId,
  notes: z.string().trim().min(1).max(2000),
  owner: Owner.optional().describe('a group massing with approvalUi "owner": must be the group\'s owner'),
  model: ModelId.optional(),
  budgetUsd: BudgetUsd.optional(),
});
export const MassingListMsg = z.object({ ...envelope('massing.list'), owner: Owner.optional(), massingId: MassingId.optional().describe('every version of this massing (default: the latest of each)') });
export const MassingDeleteMsg = z.object({ ...envelope('massing.delete'), massingId: MassingId });
export const GroupPromoteCopyMsg = z.object({
  ...envelope('group.promoteCopy'),
  groupId: Id,
  itemKey: GroupItemKey,
  reason: z.string().trim().min(1).max(500).describe('why (e.g. a fitToLot failure at placement)'),
});
export const GroupApproveMsg = z.object({
  ...envelope('group.approve'),
  groupId: Id,
  approve: z.array(GroupItemKey).max(MAX_GROUP_ITEMS).optional().describe('items whose detail pass starts'),
  redirect: z.record(GroupItemKey, z.string().trim().min(1).max(2000)).optional().describe('itemKey -> notes: a new massing version'),
  cancel: z.array(GroupItemKey).max(MAX_GROUP_ITEMS).optional().describe('(addition) items to drop (they end cancelled)'),
  owner: Owner.optional().describe('who approves: must be the group\'s owner when its approvalUi is "owner"'),
});

// 5a
export const DesignCritiqueMsg = z.object({ ...envelope('design.critique'), entryId: z.string().regex(LIBRARY_ID).max(64), spec: CritiqueSpec.optional().describe('mode must be report (the default); the model, effort, views and extraCriteria apply') });
export const BibleDeleteMsg = z.object({ ...envelope('bible.delete'), id: BibleId, owner: Owner.optional().describe("required for another owner's bible") });
export const BibleArchiveMsg = z.object({ ...envelope('bible.archive'), id: BibleId, archived: z.boolean() });
// 5b
const EntryId = z.string().regex(LIBRARY_ID).max(64);
export const EntryVersionsMsg = z.object({ ...envelope('entry.versions'), entryId: EntryId });
export const EntryDeltaMsg = z.object({ ...envelope('entry.delta'), entryId: EntryId, from: z.number().int().min(1), to: z.number().int().min(1) });
export const EntryRevertMsg = z.object({ ...envelope('entry.revert'), entryId: EntryId, toVersion: z.number().int().min(1) });
export const EntryPinsMsg = z.object({ ...envelope('entry.pins'), pins: z.record(EntryId, z.array(z.number().int().min(1)).max(4096)).describe('every entry version a standing site pins (sent at connect and when they change)') });
export const DesignPolishMsg = z.object({ ...envelope('design.polish'), entryId: EntryId, spec: PolishSpec.optional(), owner: Owner.optional(), ext: Ext.optional() });

// 6a regions (client -> sidecar)
export const RegionPlanMsg = z.object({
  ...envelope('region.plan'),
  program: z.string().min(1).max(4096).describe('a bundled program id (kit/regions/<id>.mjs, [a-z][a-z0-9_]{0,47}) or a .mjs path under <gameDir>/architect/regions/programs'),
  params: z.record(z.string().max(64), z.unknown()).refine((v) => JSON.stringify(v).length <= 64 * 1024, 'params are larger than 64 KB').describe("the program's params (JSON)"),
  seed: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]).optional().describe('a u64 as a decimal string (a safe integer is accepted); absent: the sidecar picks one'),
  claim: RegionClaim,
  surveyBlobId: BlobId.describe('the plan survey: an ARSV columns blob'),
  bible: BibleId.optional().describe("the bible whose roles the program resolves (its latest version unless bibleVersion)"),
  bibleVersion: z.number().int().min(1).optional(),
  roles: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), BlockState).refine((r) => Object.keys(r).length <= 128, 'at most 128 roles').optional().describe("role -> block state; wins over the bible's"),
  check: z.boolean().optional().describe('(6b) run the checker and the previews after the plan (default true; false = ext["architect_mc:check"] = false)'),
  volumes: z
    .array(z.object({ name: z.string().min(1).max(64).optional(), sha: Sha256Hex.describe('SHA-256 of the UNCOMPRESSED ARVX bytes'), blobId: BlobId.describe('the gzip ARVX file'), box: VolumeBox }))
    .max(16)
    .optional()
    .describe('(6b) frozen volumes the program may read (the second plan of the two-plan flow)'),
});
export const RegionTileReq = z.object({
  key: TileKey,
  stage: StageName.optional().describe('required unless preview; (6b) a ghost tile: every stage up to and including this one (absent: every stage)'),
  set: TileSet.optional().describe('required unless preview; (6b) a ghost tile: this set only (absent: both)'),
  heights: Base64(MAX_TILE_HEIGHTS_BYTES).optional().describe("base64 ARSV: the tile's 80x80 window at resolution 1 (required unless preview)"),
});
export const RegionTilesRequestMsg = z
  .object({
    ...envelope('region.tiles.request'),
    planId: PlanId,
    irSha: Sha256Hex,
    ir: z.union([z.string().max(MAX_IR_BYTES), z.record(z.string(), z.unknown())]).optional().describe('the IR, when the sidecar answered ir_unknown: the ir.json text (preferred) or its JSON object (hashed as canonical JSON)'),
    blobs: z
      .record(Sha256Hex, BlobId)
      .refine((b) => Object.keys(b).length <= 256, 'at most 256 blobs')
      .optional()
      .describe('(6b) sha -> blob-store id: the side blobs the sidecar answered blob_unknown for (uploaded with blob.put, kind region.blob)'),
    preview: z.boolean().optional().describe('(6b) ghost tiles: evaluated over the plan dir survey, no heights'),
    tiles: z.array(RegionTileReq).min(1).max(MAX_TILES_PER_REQUEST),
  })
  .superRefine((m, ctx) => {
    if (m.preview) return;
    m.tiles.forEach((t, i) => {
      for (const k of ['stage', 'set', 'heights'] as const) if (t[k] === undefined) ctx.addIssue({ code: 'custom', path: ['tiles', i, k], message: `${k} is required (unless preview)` });
    });
  });
export const RegionReleaseMsg = z.object({
  ...envelope('region.release'),
  planId: PlanId,
  /** (6b) Also forget an IR other plans share (DevBridge dev.region.drop: the next tile must meet ir_unknown). */
  evict: z.boolean().optional(),
});
// 6b regions (client -> sidecar)
export const RegionCheckMsg = z.object({ ...envelope('region.check'), planId: PlanId });
export const RegionPreviewMsg = z.object({
  ...envelope('region.preview'),
  planId: PlanId,
  views: z.array(PreviewView).min(1).max(4).optional().describe('default all four'),
  axes: SectionAxes.optional().describe('section axes (default: the kit picks)'),
});
export const RegionDesignCard = z.object({
  site: z.string().trim().min(1).max(200).optional(),
  purpose: z.string().trim().min(1).max(200).optional(),
  style: z.string().trim().min(1).max(200).optional(),
  text: z.string().trim().min(1).max(2000).optional().describe("the player's own words"),
});
export const RegionDesignMsg = z.object({
  ...envelope('region.design'),
  brief: z.string().trim().min(1).max(2000),
  card: RegionDesignCard.optional().describe('(S-6b-2) the caller\'s card fields: they reach the pick as written'),
  claim: RegionClaim,
  surveyBlobId: BlobId.describe('the plan survey: an ARSV columns blob'),
  bible: BibleId.optional(),
  bibleVersion: z.number().int().min(1).optional(),
  mustPass: z.array(z.string().trim().min(1).max(64)).max(32).optional().describe('checker rules the caller needs to pass (told to the pick; recorded)'),
  model: ModelId.optional().describe('default config regionDesignModel, else jobModel (Sonnet)'),
  budgetUsd: BudgetUsd.optional().describe('hard stop on the estimated cost of the pick, across its tries'),
  requireFit: z.boolean().optional().describe('true: no fit fails the design (error NO_TEMPLATE); default false: done with outcome NO_TEMPLATE'),
  plan: z.boolean().optional().describe('default true: a fit starts region.plan with the program and params'),
  owner: Owner.optional(),
  ext: Ext.optional().describe('kept on the design; on the sim backend only, ext["architect:simAnswers"] scripts the pick answers per try'),
});

export const ClientMessage = z.discriminatedUnion('type', [
  HelloMsg,
  DesignRequestMsg,
  DesignCancelMsg,
  AuthSetMsg,
  ShutdownMsg,
  VariantRequestMsg,
  ImportRequestMsg,
  JobRunMsg,
  JobCancelMsg,
  JobToolResultMsg,
  BlobPutMsg,
  BlobDeleteMsg,
  ClientPausedMsg,
  DesignGroupMsg,
  GroupCancelMsg,
  GroupExtendMsg,
  GroupResumeMsg,
  DesignEstimateMsg,
  BibleRequestMsg,
  BibleReviseMsg,
  BibleEstimateMsg,
  BibleCancelMsg,
  ReskinRequestMsg,
  MassingRedirectMsg,
  MassingListMsg,
  MassingDeleteMsg,
  GroupApproveMsg,
  GroupPromoteCopyMsg,
  DesignCritiqueMsg,
  BibleDeleteMsg,
  BibleArchiveMsg,
  EntryVersionsMsg,
  EntryDeltaMsg,
  EntryRevertMsg,
  EntryPinsMsg,
  DesignPolishMsg,
  RegionPlanMsg,
  RegionTilesRequestMsg,
  RegionReleaseMsg,
  RegionCheckMsg,
  RegionPreviewMsg,
  RegionDesignMsg,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
/** What a protocol-1 client may send (exactly the phase 1-3 messages and fields). */
export const ClientMessageV1 = z.discriminatedUnion('type', [HelloMsg, DesignRequestMsgV1, DesignCancelMsg, AuthSetMsg, ShutdownMsg, VariantRequestMsg, ImportRequestMsg]);

/** A server message without the envelope's `v` (added by the sender). */
export type Outbound = ServerMessage extends infer M ? (M extends { v: 1 } ? Omit<M, 'v'> : never) : never;

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** The protocol both sides speak: the highest of `offered` this sidecar knows (absent = 1), or undefined. */
export function chooseProtocol(offered: number[] | undefined): Protocol | undefined {
  if (!offered) return 1;
  const common = PROTOCOLS.filter((p) => offered.includes(p));
  return common.length ? (Math.max(...common) as Protocol) : undefined;
}

/**
 * A full (protocol 2) message as a protocol-1 client gets it: undefined for messages protocol 1
 * does not have (job.*), and the phase 1-3 fields only (no `cost`, no v2 request fields, no
 * snapshot `protocol` / `features` / `jobs`).
 */
export function toProtocol1(full: Record<string, unknown>): Record<string, unknown> | undefined {
  // (4c) massing jobs and detail passes are protocol-2 work: a protocol-1 client never sees them
  // (5a) and a report critique of a library entry (design.critique)
  // (5b) and polish designs
  const v2Only = (d: unknown) => !!d && typeof d === 'object' && (!!(d as { critiqueOf?: unknown }).critiqueOf || (d as { kind?: unknown }).kind === 'polish' || (d as { kind?: unknown }).kind === 'region' || !!(((d as { request?: Record<string, unknown> }).request ?? {}).massing || ((d as { request?: Record<string, unknown> }).request ?? {}).fromMassing));
  // (5a) critiquing is a protocol-2 status: protocol 1 sees rendering, with the step text
  const v1Status = (d: unknown) => (d && typeof d === 'object' && (d as { status?: unknown }).status === 'critiquing' ? { ...(d as Record<string, unknown>), status: 'rendering' } : d);
  if (full.type === 'design.upsert' && v2Only(full.design)) return undefined;
  if (full.type === 'design.upsert') full = { ...full, design: v1Status(full.design) };
  if (full.type === 'snapshot' && Array.isArray(full.designs)) full = { ...full, designs: (full.designs as unknown[]).filter((d) => !v2Only(d)).map(v1Status) };
  const r = ServerMessageV1.safeParse(full);
  return r.success ? (r.data as Record<string, unknown>) : undefined;
}

/**
 * Parse a client frame (for a protocol-1 client: with the phase 1-3 messages only, so v2 fields
 * are dropped and v2 messages fail as unknown types). The error text names fields and rules only,
 * never the values sent (an `auth.set` frame carries an API key).
 */
export function parseClientMessage(raw: unknown, protocol: Protocol = 2): { ok: true; msg: ClientMessage } | { ok: false; error: string; id?: string } {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'invalid JSON' };
    }
  }
  const id = data && typeof data === 'object' && typeof (data as { id?: unknown }).id === 'string' ? (data as { id: string }).id.slice(0, 200) : undefined;
  const r = (protocol === 1 ? ClientMessageV1 : ClientMessage).safeParse(data);
  if (r.success) return { ok: true, msg: r.data as ClientMessage };
  return { ok: false, error: formatZodError(r.error), ...(id ? { id } : {}) };
}

export function parseServerMessage(raw: unknown): { ok: true; msg: ServerMessage } | { ok: false; error: string } {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'invalid JSON' };
    }
  }
  const r = ServerMessage.safeParse(data);
  if (r.success) return { ok: true, msg: r.data };
  return { ok: false, error: formatZodError(r.error) };
}
