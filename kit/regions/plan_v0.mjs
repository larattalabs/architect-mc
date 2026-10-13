// plan_v0 (docs/CONTRACT.md "Phase 6c slice P0: plan check v0" §5): the bundled composite program a geometric plan (`plan/0`,
// kit/schemas/plan.json) compiles through. One region over the request's claim (S-P0-1): zones as V's street layout in their own
// rects (or, N-P0-1, a whole-claim template as the sole zone), T1's relief around zones, 6a's terrace and F1's spikes beside them,
// and every street, road and path as T2 routes between them. Regions.checkPlan plans it (no realise); the approved artifact is
// this plan's own IR. Its params are the plan and the frozen inputs (kit/lib/plan/compile.mjs reads them):
//   plan        the plan/0 JSON (at most 64 KB)
//   anchors     {name: [x, y, z]} the caller's named positions (PlanRequest.anchors)
//   protected   [{id, rect: [x0, z0, x1, z1]}] the protected areas meeting the claim (any owner: features and obstacles)
//   regions     [{id, rect}] other owners' standing regions meeting the claim (obstacles)
//   budget      {maxNodes, maxEdges, maxCells, maxMs, maxHeapMb} (each at most §7's default)
//   bible       {id, version} | null, and fingerprint: {sha} the protection fingerprint (recorded in the artifact and the cache key)
// The answers, geometry and the IR parts each plan part wrote go to meta.planCheck; tools/region.mjs then adds the cost, the tile
// shas, the overall result and the artifact (kit/lib/plan/finish.mjs).
import { region } from '../lib/region/program.mjs';
import { runCheck } from '../lib/plan/compile.mjs';
import * as craterWorks from './crater_works.mjs';
import * as riftCity from './rift_city.mjs';
import * as floatingIslands from './floating_islands.mjs';

export const id = 'plan_v0';
export const description = 'A geometric plan (plan/0) compiled to one region: zones, relief, terraces, spikes and routes (6c P0).';
/** Not in Regions.design's pick: plans come through Regions.checkPlan. */
export const catalogue = false;
export const passes = ['relief', 'route'];

const J = (maxChars) => ({ type: 'json', default: null, ...(maxChars ? { maxChars } : {}) });
export const params = {
  plan: { ...J(262144), label: 'The plan (plan/0)' },
  anchors: { ...J(16384), label: 'Named anchors' },
  protected: { ...J(65536), label: 'Protected areas' },
  regions: { ...J(65536), label: 'Other regions' },
  budget: { ...J(), label: 'Check budget' },
  bible: { ...J(), label: 'Bible' },
  fingerprint: { ...J(), label: 'Protection fingerprint' },
};

/** N-P0-1: the whole-claim templates (named programs a zone may use as its sole program). */
export const TEMPLATES = new Map([['crater_works', craterWorks], ['rift_city', riftCity], ['floating_islands', floatingIslands]]);

export default function planV0(ctx) {
  const P = ctx.params;
  const list = (v, k) => (v && Array.isArray(v[k]) ? v[k] : []);
  const inputs = {
    plan: P.plan ?? {}, anchors: P.anchors?.anchors ?? {}, protected: list(P.protected, 'areas'), regions: list(P.regions, 'regions'),
    budget: P.budget ?? {}, bible: P.bible ?? null, fingerprint: P.fingerprint?.sha ?? null,
  };
  const { region: r, record } = runCheck(ctx, inputs, { makeRegion: () => region(ctx), templates: TEMPLATES });
  r.meta.planCheck = record;
  return r;
}
