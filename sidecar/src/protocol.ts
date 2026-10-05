// Architect wire protocol (docs/CONTRACT.md "Protocol"), version 1. Ported from AgentCraft's
// foreman/src/protocol.ts (design messages only).
//
// Transport: ws://127.0.0.1:<port>, one JSON object per text frame:
//   { "v": 1, "type": "<type>", "id"?: "<client correlation id>", ...payload }
// Conventions: timestamps are integer epoch ms; unknown fields are ignored (zod strips them);
// optional fields are omitted, never null (except `auth.set.apiKey: null`, which clears the key).
import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

const Ts = z.number().int().nonnegative();
const Id = z.string().min(1).max(64);

// ---- enums -----------------------------------------------------------------------------------

export const BUILDING_TYPES = ['house', 'cabin', 'cottage', 'tower', 'shop', 'tavern', 'barn', 'smithy', 'chapel', 'gatehouse', 'custom'] as const;
export const BuildingType = z.enum(BUILDING_TYPES);
export type BuildingType = z.infer<typeof BuildingType>;

export const DesignStatus = z
  .enum(['queued', 'designing', 'checking', 'rendering', 'done', 'failed', 'cancelled'])
  .describe('queued -> designing (the design agent works) -> checking (the sidecar re-runs the checker with a pristine kit) -> rendering (previews) -> done; or failed / cancelled. done, failed and cancelled are final.');
export type DesignStatus = z.infer<typeof DesignStatus>;

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

export const DesignRequest = z
  .object({
    type: BuildingType,
    style: z.string().trim().min(1).max(40).describe('"rustic", "medieval", "modern", ... (chips or any text)'),
    materials: z.string().trim().max(200).optional().describe('free text, e.g. "spruce and cobblestone"'),
    features: z.array(z.string().regex(FEATURE_RE)).max(6).describe('porch, chimney, balcony, garden, skylights, courtyard, big_windows, basement, ...'),
    maxSize: z.object({ x: Size(7, 96), y: Size(6, 64), z: Size(7, 96) }).describe('the largest template allowed (including roof overhangs, porch, garden)'),
    plot: Plot.optional(),
    remix: z.string().regex(/^[a-z0-9_]+$/).max(64).optional().describe('start from this library id'),
    name: z.string().trim().min(1).max(40).optional().describe('display name; also names the id (gen_<slug>)'),
    notes: z.string().max(2000).optional(),
  })
  .superRefine((r, ctx) => {
    if (new Set(r.features).size !== r.features.length) ctx.addIssue({ code: 'custom', path: ['features'], message: 'duplicate feature' });
  });
export type DesignRequest = z.infer<typeof DesignRequest>;

export const Design = z.object({
  id: Id.describe('"d<n>"'),
  request: DesignRequest,
  status: DesignStatus,
  step: z.string().describe('one line of progress'),
  blueprintId: z.string().optional().describe('done: the new library id (gen_<slug>, gen_<slug>_2, ...)'),
  size: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).optional(),
  previews: z.array(z.string()).optional().describe('done: absolute paths of the preview PNGs in <library>/<id>/'),
  error: z.string().optional(),
  createdAt: Ts,
  updatedAt: Ts,
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
  name: z.string().optional().describe('(addition) the name asked for'),
  blueprintId: z.string().optional().describe('done: the new library id'),
  size: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).optional(),
  previews: z.array(z.string()).optional().describe('(addition) done: absolute paths of the preview PNGs'),
  error: z.string().optional().describe('failed: why, with the checker lines'),
  createdAt: Ts,
  updatedAt: Ts,
});
export type Variant = z.infer<typeof Variant>;

/** (addition) What the kit offers a palette picker: the presets and the accepted woods / stones / roofs. */
export const KitInfo = z.object({
  palettes: z.array(z.object({ name: z.string(), preset: z.string().optional(), wood: z.string(), stone: z.string(), roof: z.string(), accent: z.string() })),
  choices: z.object({ woods: z.array(z.string()), stones: z.array(z.string()), roofs: z.array(z.string()) }),
});
export type KitInfo = z.infer<typeof KitInfo>;

// ---- messages --------------------------------------------------------------------------------

const envelope = <T extends string>(type: T) => ({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal(type),
  id: z.string().max(200).optional().describe('client correlation id; answered with `ack` {re: id}'),
});

// sidecar -> client
export const SnapshotMsg = z.object({
  ...envelope('snapshot'),
  version: z.string(),
  status: Status,
  designs: z.array(Design),
  variants: z.array(Variant).describe('the last 20 variant/import jobs plus any unfinished one'),
  kit: KitInfo.optional().describe('(addition) the palette presets and choices, when the kit could describe them'),
});
export const StatusMsg = z.object({ ...envelope('status'), status: Status });
export const DesignUpsertMsg = z.object({ ...envelope('design.upsert'), design: Design });
export const VariantUpsertMsg = z.object({ ...envelope('variant.upsert'), variant: Variant });
export const AckMsg = z.object({
  ...envelope('ack'),
  re: z.string().describe('the `id` of the client message'),
  ok: z.boolean(),
  error: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional().describe('design.request: {designId}; variant.request / import.request: {variantId}'),
});
export const ErrorMsg = z.object({ ...envelope('error'), message: z.string(), re: z.string().optional() });

export const ServerMessage = z.discriminatedUnion('type', [SnapshotMsg, StatusMsg, DesignUpsertMsg, VariantUpsertMsg, AckMsg, ErrorMsg]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// client -> sidecar
export const HelloMsg = z.object({
  ...envelope('hello'),
  client: z.string().max(40).optional().describe('"mod" | "cli"'),
  version: z.string().max(80).optional().describe('the client version (informational)'),
  token: z.string().max(200).optional().describe('the contents of <data>/client.token'),
});
export const DesignRequestMsg = z.object({ ...envelope('design.request'), request: DesignRequest });
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
});
export const ImportRequestMsg = z.object({
  ...envelope('import.request'),
  path: z.string().min(1).max(4096).describe("an absolute .nbt path in <gameDir>/architect/imports/ or a world's generated/<namespace>/structures/"),
});

export const ClientMessage = z.discriminatedUnion('type', [HelloMsg, DesignRequestMsg, DesignCancelMsg, AuthSetMsg, ShutdownMsg, VariantRequestMsg, ImportRequestMsg]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** A server message without the envelope's `v` (added by the sender). */
export type Outbound = ServerMessage extends infer M ? (M extends { v: 1 } ? Omit<M, 'v'> : never) : never;

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * Parse a client frame. The error text names fields and rules only, never the values sent (an
 * `auth.set` frame carries an API key).
 */
export function parseClientMessage(raw: unknown): { ok: true; msg: ClientMessage } | { ok: false; error: string; id?: string } {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'invalid JSON' };
    }
  }
  const id = data && typeof data === 'object' && typeof (data as { id?: unknown }).id === 'string' ? ((data as { id: string }).id.slice(0, 200)) : undefined;
  const r = ClientMessage.safeParse(data);
  if (r.success) return { ok: true, msg: r.data };
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
