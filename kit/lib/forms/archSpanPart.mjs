// (7c PF, docs/CONTRACT.md "Phase 7c" §2: promoted forms as ordinary `form.<name>` entries) plan/0's `form.arch_span`: the promoted
// archSpan module (kit/lib/forms/archSpan.mjs, kit/lib/forms/CANDIDATES.md) as a plan part. compile.mjs resolves it as a rect of
// length by width along its axis from its locator (clear of the zones and forms placed before it, dry, its ground at most DROP under its
// springing) and calls emitArchSpan in the forms stage. Its masonry is the Style's structure role (a rail parapet: rail), written as a
// built form (r.form's `terrain: false`): in survival a construction target, never free. Deterministic (the module is).
import { fnv64 } from '../noise.mjs';
import { DROP } from './archSpan.mjs';

/** The module's defaults for what the part leaves out (archSpanParams: length 48, width 5, axis x). */
export const ARCH_SPAN_DEFAULTS = Object.freeze({ axis: 'x', length: 48, width: 5 });
/** The part's own members the module reads (each passed through when given; the seed picks the rest). */
export const ARCH_SPAN_OWN = Object.freeze(['axis', 'length', 'width', 'height', 'tiers', 'bays', 'pier', 'profile', 'parapet', 'spandrel', 'species']);

/** The rect's sides [w (x), d (z)]: length along the axis, width across it. */
export function archSpanSide(part) {
  const axis = part.axis ?? ARCH_SPAN_DEFAULTS.axis;
  const L = part.length ?? ARCH_SPAN_DEFAULTS.length, W = part.width ?? ARCH_SPAN_DEFAULTS.width;
  return axis === 'x' ? [L, W] : [W, L];
}

/** The site of a rect: its springing (one over the highest ground under it) and its drop (the springing over the lowest ground's top + 1). */
export function archSpanSite(env, rect) {
  let lo = Infinity, hi = -Infinity;
  for (let z = rect.minZ; z <= rect.maxZ; z++) for (let x = rect.minX; x <= rect.maxX; x++) { const g = env.S.groundAt(x, z); if (g < lo) lo = g; if (g > hi) hi = g; }
  return { y: hi + 1, drop: hi - lo, ok: hi - lo <= DROP };
}

/** The notes an arch span's answer carries: the params it does not read. */
export function archSpanNotes(part) {
  const keys = Object.keys(part.params ?? {}).sort();
  return keys.length ? [`params ${keys.join(', ')}: not read (the arch span's own members are ${ARCH_SPAN_OWN.join(', ')})`] : [];
}

/**
 * Emit a resolved arch span `p` (its resolution `f`: rect, y) as form part `id` through r.archSpan (the module's VERSION in ir.forms).
 * K: {env, r, ctx, stageOf}. Returns `{geometry, notes}` for the answer (throws on a module error: the caller rolls back and refuses).
 */
export function emitArchSpan(K, p, f, id) {
  const { env, r, ctx } = K;
  const part = p.part, rect = f.rect;
  const axis = part.axis ?? ARCH_SPAN_DEFAULTS.axis;
  const length = part.length ?? ARCH_SPAN_DEFAULTS.length, width = part.width ?? ARCH_SPAN_DEFAULTS.width;
  const half = width >> 1;
  // the module's frame: u along the axis from `at`, the deck's rows at -half .. width - 1 - half across it
  const at = axis === 'x' ? [rect.minX, f.y, rect.minZ + half] : [rect.minX + half, f.y, rect.minZ];
  const params = { at, axis, length, width, seed: fnv64(ctx.seed ?? '', 'archSpan', p.id).hex, groundAt: (x, z) => env.S.groundAt(x, z) };
  for (const k of ['height', 'tiers', 'bays', 'pier', 'profile', 'parapet', 'spandrel', 'species']) if (part[k] !== undefined) params[k] = part[k];
  const gen = r.archSpan(id, params, { stage: K.stageOf('forms'), terrain: false });
  (r.meta.parts[id] ??= {}).archSpan = { version: gen.version, species: gen.species, tiers: gen.stats.tiers.length };
  const P = gen.params;
  return {
    geometry: {
      archSpan: {
        at, axis, length, width, height: P.height, tiers: P.tiers, profile: P.profile, parapet: P.parapet, species: gen.species,
        bays: gen.stats.tiers.map((t) => t.bays), version: gen.version, deckY: at[1] + P.height,
      },
    },
    notes: [],
  };
}
