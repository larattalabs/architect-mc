// (7c PAY stage 2, docs/CONTRACT.md "Phase 7c" §4) The items after P1: their jobs, budgets and inputs, pure (tools/gate7cpay.mjs runs
// them). Every item runs on `--backend sim` ($0, its dry run) or `--backend claude` (paid: the coordinator's recorded go `<item>:go`).
// Budgets per job sum to at most the item's ceiling (1.2 x its share; tools/lib/pay-ledger.mjs ceilingOf), so every job of an item can
// be open at once.

/** P2: the six briefs (S4 has no program: 7b's N-7b-3, skipped), each with its own format 3 settlement Style made first. */
export const P2_SCENARIOS = Object.freeze([
  { key: 's1', scenario: 's1_floating_islands', via: 'design' },
  { key: 's2', scenario: 's2_ice_spikes', via: 'design' },
  { key: 's5', scenario: 's5_treehouses', via: 'design' },
  // the plan path forced on two scenarios (§5): Regions.compose with the template pick skipped, images on (P4's "on" arm); the land the
  // compose read is saved for P4 (both arms clone one saved world)
  { key: 's3', scenario: 's3_monastery', via: 'compose', saveWorld: true },
  { key: 's6', scenario: 's6_cave_city', via: 'compose', saveWorld: true, designs: true },
]);
/** The world P2 saves for a plan-path scenario and P4 clones (tools/scenarios.mjs --save-world). */
export const p4World = (key) => `G6B PAY P2 ${key} land`;

export const BUDGETS = Object.freeze({
  P2: { style: 2.0, pick: 0.25, compose: 1.2, design: 5.0, maxDesigns: 4 },
  P3: { author: 6.0 },
  P4: { compose: 1.2 },
  P5: { style: 1.8 },
  P6: { design: 7.0 },
});
/** Each item's jobs at their budgets (the worst case, every job open): {item: [{step, capUsd}]}. */
export function jobsOf(item) {
  const b = BUDGETS[item];
  if (item === 'P2') {
    return [
      ...P2_SCENARIOS.map((s) => ({ step: `P2:style:${s.key}`, capUsd: b.style })),
      ...P2_SCENARIOS.map((s) => ({ step: `P2:brief:${s.key}`, capUsd: s.via === 'compose' ? b.compose : b.pick })),
      ...Array.from({ length: b.maxDesigns }, (_, i) => ({ step: `P2:design:${i + 1} (S6's site archetypes, as many as the composed plan's fits, at most ${b.maxDesigns})`, capUsd: b.design })),
    ];
  }
  if (item === 'P3') return P3_SESSIONS.map((s) => ({ step: `P3:author:${s.key}`, capUsd: b.author }));
  if (item === 'P4') return P2_SCENARIOS.filter((s) => s.saveWorld).map((s) => ({ step: `P4:compose:${s.key}`, capUsd: b.compose }));
  if (item === 'P5') return P5_STYLES.map((s) => ({ step: `P5:style:${s.key}`, capUsd: b.style }));
  if (item === 'P6') return [{ step: 'P6:composite', capUsd: b.design }];
  return [];
}
export const worstCase = (item) => Math.round(jobsOf(item).reduce((a, j) => a + j.capUsd, 0) * 1e6) / 1e6;

/**
 * P3: two authoring sessions on builder-written briefs no program fits (never a scenario brief), over pinned calibration claims. The
 * contract's sea stack has no pinned site: volume_site (rock, air and water, 6b gate item 7) is the nearest; crater_site is the open
 * ground Steward's crater gate pinned (crater_works is the program the brief says not to use).
 */
export const P3_SESSIONS = Object.freeze([
  { key: 'stack', site: 'volume_site', brief: 'A small monastery on a rock stack above the water: a chapel, a cloister and a few cells on the top, and a stair cut down the rock to a landing at the water.' },
  { key: 'crater', site: 'crater_site', brief: 'A town round a crater lake: houses on a ring street round the rim, a jetty on the lake, and a road down from the rim to the water. Not a mine or a works.' },
]);

/** P5: the settlement Style job on two scenarios with N-7c-4's references (three gpt-image-2 images each); the off arm is P2's Style. */
export const P5_STYLES = Object.freeze([
  { key: 's3', scenario: 's3_monastery', refs: ['S3-monastery-1', 'S3-monastery-2', 'S3-monastery-3'] },
  { key: 's5', scenario: 's5_treehouses', refs: ['S5-treehouse-1', 'S5-treehouse-2', 'S5-treehouse-3'] },
]);

/** P6: one landmark past the cap as a Composite (Opus), for S3's summit; not gating; only when the ledger reads at most $50 after P5. */
export const P6_REQUEST = Object.freeze({
  type: 'tower', style: 'medieval', bible: 'medieval', features: [], maxSize: { x: 96, y: 64, z: 96 }, name: 'PAY summit keep',
  notes: "The landmark on the monastery hill's summit: a great keep and its curtain wall, about 120 long, past one template's size: past the cap, this request allows a Composite.",
  ext: { 'architect_mc:allowComposite': true },
});

/** The scenario's one-line brief without its version note (tools/lib/scenario-br.mjs briefText's rule). */
export const briefOf = (sc) => String(sc.brief).replace(/\s*\((S\d+ v\d+|[A-Z]\d+)[^)]*\)\s*$/, '').trim();
