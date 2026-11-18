// (8cF, docs/CONTRACT.md "Phase 8c" slice 8cF) Phase 8c's frozen shapes: the flowing-water members of a fluid op, its open enums, the
// cost limits by name, and the UNSETTLED answer (Steward's S-8c-2). Shapes only: no model here. The kit lane's model (WM: levels,
// conversion, the wash rule, a typed UNSETTLED from `steady`) and settle (SE: the bounds and caps) build these answers through
// unsettledAnswer; the planner (RV) writes the op members. Pure, no imports of compile.mjs or program.mjs.
//
// The op members 8c adds to a `fluid` op (each only when given: every H, HY and IRR op is byte for byte as before):
//   flow       an open enum: "current" (a river reach: its spill is a long current, runs of at most 7 cells each ending in a 1-block
//              step, chained to the next source reach) or "level"; unknown values are noted by a consumer, never refused
//   kind       the body kind, an open enum (BODY_KINDS): siteplan's kinds plus "river", "basin" and "header"
//   lip        "form": a fall off a plan form (8a's cliff, crater rim or island rim), the header pool in the form's top
//   on         {part}: that host form's plan part id
//   wash       runs: natural washable cells of the predicted flow (a plant, torch, rail, carpet) cleared to air by an earlier stage as
//              IF_NATURAL writes, journaled (§2.4); the mod counts them (`washed`) and re-checks the predicted cells at the gate
//   converted  runs: predicted conversions (2 horizontal sources beside, a solid or a source under) the planner lifted into written
//              sources; each is one of `cells`
// A flow or lip member makes the IR require `flowingWater` (realise.mjs walkKinds); a frozen volume with `levels: true` (ARVX version 4)
// makes it require `volume:levels`. Body ids stay `<part>_r<k>` (body.mjs reachId).

/** The flow enum's values 8c writes (open: a consumer keeps an unknown one). */
export const FLOWS = Object.freeze(['current', 'level']);
/** The body kinds (open). */
export const BODY_KINDS = Object.freeze(['pond', 'fountain', 'waterfall', 'moat', 'course', 'river', 'basin', 'header', 'farm_pond', 'well']);
/** The lip values (open): "form" is 8c's; a waterfall's lip is otherwise its own (H's lip run, `lip: existing` reads a 2.5D drop). */
export const LIPS = Object.freeze(['form']);
/** The op members 8c adds (each only when given). */
export const FLOWING_MEMBERS = Object.freeze(['flow', 'kind', 'lip', 'on', 'wash', 'converted']);
/** The IR kinds (realise.mjs KINDS_FORMAT2, IrStale.KINDS_FORMAT2). */
export const FLOWING_KIND = 'flowingWater';
export const LEVELS_KIND = 'volume:levels';

/**
 * §2.6's cost limits (constants; slice SE measures them and records them in its as-built). Per body: settle rounds (settleBound x 4),
 * predicted flowing cells, chunks under the ticket; per region: flowing cells and river bodies. The region's two span parts: repairing
 * one part can't fix them.
 */
export const LIMITS = Object.freeze({ cellsPerBody: 4096, chunksPerBody: 64, regionCells: 32768, regionBodies: 8, roundsFactor: 4 });
/** UNSETTLED's caps (evidence.cap): which limit the settle step hit. */
export const UNSETTLED_CAPS = Object.freeze(['rounds', 'cells', 'chunks', 'regionCells', 'regionBodies']);
const REGION_CAPS = new Set(['regionCells', 'regionBodies']);

/** The limit a cap names (rounds: the body's own maxRounds, given). */
export function capLimit(cap, rounds = null) {
  switch (cap) {
    case 'rounds': return rounds;
    case 'cells': return LIMITS.cellsPerBody;
    case 'chunks': return LIMITS.chunksPerBody;
    case 'regionCells': return LIMITS.regionCells;
    case 'regionBodies': return LIMITS.regionBodies;
    default: return null;
  }
}

/**
 * The UNSETTLED answer of a part (§2.5, Steward's S-8c-2): `refused` with one reason {code: 'UNSETTLED', message, say, evidence: {body,
 * cap, limit, regionWide, cells, rounds, sample}} and, when the kit found one, `wouldFit` [{part, fragment, why: 'shorter' | 'source',
 * cells}] (a shorter river, or one more source reach). Deterministic: re-asking the same part answers the same, so a consumer never
 * retries it on its own. `say` is the player's line: "...; a shorter one fits" with a wouldFit, "...; it waits" without one.
 * Throws on an unknown cap (a builder's error, not a player's).
 */
export function unsettledAnswer({ part, body = null, cap, cells = 0, rounds = 0, sample = [], wouldFit = null, maxRounds = null, label = 'the river' }) {
  if (!UNSETTLED_CAPS.includes(cap)) throw new Error(`unsettledAnswer: cap must be one of ${UNSETTLED_CAPS.join(', ')} (got ${cap})`);
  if (typeof part !== 'string' || !part) throw new Error('unsettledAnswer: part is the plan part id');
  const regionWide = REGION_CAPS.has(cap);
  const limit = capLimit(cap, maxRounds);
  const what = {
    rounds: `its water didn't settle within ${limit ?? 'its'} rounds`,
    cells: `its predicted flow is ${cells} cells (at most ${LIMITS.cellsPerBody} per body)`,
    chunks: `its watch set spans more than ${LIMITS.chunksPerBody} chunks`,
    regionCells: `the region's flowing water would pass ${LIMITS.regionCells} cells`,
    regionBodies: `the region would hold more than ${LIMITS.regionBodies} river bodies`,
  }[cap];
  const fits = Array.isArray(wouldFit) && wouldFit.length ? wouldFit.map((w) => ({ part, ...w })) : null;
  const say = `${label[0].toUpperCase()}${label.slice(1)} was too long to settle here; ${fits ? 'a shorter one fits' : 'it waits'}`;
  const reason = {
    code: 'UNSETTLED',
    message: `${body ? `body ${body}: ` : ''}${what}${regionWide ? ' (a region-wide limit: repairing this part alone does not fix it)' : ''}`,
    say,
    evidence: { body, cap, limit, regionWide, cells, rounds, sample: sample.slice(0, 16) },
  };
  return { class: 'refused', reasons: [reason], ...(fits ? { wouldFit: fits } : {}) };
}

/** Whether a fluid op is 8c's flowing water: a `flow` member, or `lip: "form"` (realise.mjs walkKinds inlines the same test). */
export function isFlowingOp(o) {
  return !!o && o.op === 'fluid' && (typeof o.flow === 'string' || o.lip === 'form');
}

/** The realise-time typed whys of the fluids rows (RegionFluids.WHYS; open). */
export const WHYS = Object.freeze(['foreign_water', 'census_drift', 'escaped', 'uncontained', 'upstream', 'lot_removed', 'wash', 'bubble']);
