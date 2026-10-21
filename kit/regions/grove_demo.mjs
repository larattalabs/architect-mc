// grove_demo (docs/CONTRACT.md 6c F3 §10.2): the forms II fixture, not a catalogue program. A plan of grown forms compiled as
// plan_v0 compiles a plan (kit/lib/plan/compile.mjs runCheck): every overworld tree species and both giant mushrooms on the claim's
// open land, each 8 or more off every natural tree (the survey's tree columns), clear of the claim's water and each other. On its
// forest site (scenarios/sites/grove.json: the plains south-east of S5's forest on the pinned seed, natural trees round it) and its
// flat variant. Its plan is GROVE_PLAN; the gate checks the same plan through Regions.checkPlan and realiseApproved in game (§10 item
// 5), and this program gives its scenario golden (item 11). Deterministic: no Math.random, no clock.
import { region } from '../lib/region/program.mjs';
import { runCheck } from '../lib/plan/compile.mjs';

export const id = 'grove_demo';
export const description = 'Forms II demo: every giant tree species and both giant mushrooms on open land (6c F3).';
export const catalogue = false;
export const passes = ['relief', 'route', 'districts'];
export const params = {
  set: { type: 'enum', options: ['all', 'trees', 'few'], default: 'all', label: 'Forms' },
};

const tree = (id, preset, extra = {}) => ({ id, kind: 'giant_tree', preset, where: { inside: { claim: true } }, ...extra });
const mush = (id, preset) => ({ id, kind: 'giant_mushroom', preset, where: { inside: { claim: true } } });

/** The grove's plan (plan/0): the eight overworld species, then the two mushrooms (the nether's giants are v77's). */
export function grovePlan(set = 'all') {
  const trees = [tree('g_oak', 'oak'), tree('g_spruce', 'spruce'), tree('g_birch', 'birch'), tree('g_jungle', 'jungle'), tree('g_dark_oak', 'dark_oak'),
    tree('g_cherry', 'cherry'), tree('g_mangrove', 'mangrove'), tree('g_pale_oak', 'pale_oak')];
  const forms = set === 'few' ? [trees[0], trees[1], mush('g_red', 'red')] : set === 'trees' ? trees : [...trees, mush('g_brown', 'brown'), mush('g_red', 'red')];
  return { schemaVersion: 'plan/0', planId: 'grove_demo', forms };
}
export const GROVE_PLAN = grovePlan('all');

export default function groveDemo(ctx) {
  const inputs = { plan: grovePlan(ctx.params?.set ?? 'all'), anchors: {}, protected: [], regions: [], builds: [], standing: [], budget: {}, bible: null, fingerprint: null };
  const { region: r, record } = runCheck(ctx, inputs, { makeRegion: () => region(ctx), templates: new Map() });
  r.meta.planCheck = record;
  return r;
}
