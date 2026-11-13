// s5_treehouses (7b SB, docs/CONTRACT.md "Phase 7b" §3 row 11, SETTLEMENTS §16.2 S5 "a village in the crowns of giant trees"): the
// golden scenario S5's bundled program, not a catalogue program. The grove is the scenario's sculpt (kit/regions/s5_grove_sculpt.mjs:
// six giant oaks written as natural land before the plan, "Slice SB as built"); `params.grove` is that sculpt's record (its layout:
// the trees and the shared deck floor), so the village plans on exactly the trees the sculpt grew. Each tree holds a wrap_trunk site
// lot (a house round its trunk, under its crown) on the shared floor; branch walks (LP) join each facing pair's walk ports. Deterministic: no Math.random, no clock.
import { region } from '../lib/region/program.mjs';
import { TREE, groveLayout } from './s5_grove_sculpt.mjs';

export const id = 's5_treehouses';
export const description = 'S5 treehouse village: houses round the trunks of giant oaks, joined by branch walks (7b SB).';
/**
 * (7c TC) In Regions.design's pick (the template catalogue). Its land is scenario setup, not generator output (SB reading 2): six giant
 * oaks with straight trunks, so `needs.affordances` asks AF for six tall trunks and a pick over land without them can't fit. `grove`
 * (the sculpt's record) is not pickable.
 */
export const catalogue = {
  description: 'A treehouse village: six houses wrapped round the trunks of six giant trees in three facing pairs, under their crowns on a shared deck floor, each pair joined by a railed branch walk, with paths up the ramps to the decks. For a village in the treetops or crowns of giant trees. It builds on giant trees that are already standing (it grows none): the land must have them.',
  needs: { water: 'none near the trees', relief: 'low', affordances: { trunk: { count: 6, min: { height: 24 } } } },
  claim: { min: [160, 160], max: [256, 256] },
  keywords: ['treehouse', 'treehouses', 'tree', 'trees', 'treetop', 'treetops', 'canopy', 'crowns', 'crown', 'giant', 'branches', 'forest', 'grove'],
};
export const params = {
  grove: { type: 'json', default: null, pick: false, label: 'The grove (the sculpt\'s record)' },
};

/**
 * The branch walks: each column's pair (the north house's walk port turned to face south, the south one's north, across the pair's gap).
 * SV's trunk house has one walk port, so a house joins one walk. Lot ids `tree_<n>` (row-major).
 */
export function walkPairs() {
  const out = [];
  for (let i = 0; i < TREE.cols; i++) out.push([i + 1, TREE.cols + i + 1]);
  return out;
}
/** A house's frame rotation: its walk port (west in the design) turned to face its pair (the north row south, the south row north). */
export const rotationOfRow = (j) => (j === 0 ? 'counterclockwise_90' : 'clockwise_90');

export default function s5Treehouses(ctx) {
  const { claim, survey, params: P } = ctx;
  const r = region(ctx);
  r.stages(['ground', 'lots']);
  const G = P?.grove?.trees ? P.grove : groveLayout(claim, survey);
  if (!G) throw new Error('s5_treehouses: no grove (give the sculpt\'s record as params.grove)');
  const [W, H, D] = TREE.box;
  // a house's box: centred on its tree's trunk axis at the deck (the sculpt's record), on the shared floor
  const boxOn = ([ax, az], y) => [ax - (W >> 1), y, az - (D >> 1), ax - (W >> 1) + W - 1, y + H - 1, az - (D >> 1) + D - 1];
  const lots = G.trees.map((t, i) => ({ id: `tree_${i + 1}`, tree: t.id, row: Math.floor(i / TREE.cols), box: boxOn(t.axis ?? [t.at[0], t.at[2]], t.deckY ?? G.deckY) }));
  r.meta.sb = { scenario: 's5', deckY: G.deckY, ramps: G.ramps ?? [], centre: G.centre, trees: G.trees.map((t) => t.id), dwellings: lots.map((l) => l.id), fitCalledFor: { wrap_trunk: lots.map((l) => l.id), suspend: [] } };
  // the way in: on the ground south of the grove (the ramps climb from the east to each pair's walk)
  const [gx, gz] = G.centre;
  const ez = gz + TREE.pairGap + 4;
  r.anchor('entrance', [gx, survey.heightAt(gx, ez) + 1, ez]);
  r.anchor('spawn', [gx + 2, survey.heightAt(gx + 2, ez) + 1, ez]);
  r.anchor('hub', [gx, G.deckY + 2, gz]); // (the middle pair's walk: the cameras aim at it; an M2 node, reached up the ramp)
  // the cameras round the grove, kept inside the claim
  const cam = (n, x, y, z) => r.anchor(n, [Math.max(claim.minX + 1, Math.min(claim.maxX - 1, x)), y, Math.max(claim.minZ + 1, Math.min(claim.maxZ - 1, z))]);
  cam('cam_high', gx, G.deckY + 40, gz + 70);
  cam('cam_n', gx, G.deckY + 14, gz - 60);
  cam('cam_s', gx, G.deckY + 14, gz + 60);
  cam('cam_e', gx + 70, G.deckY + 18, gz);
  cam('cam_w', gx - 70, G.deckY + 18, gz);
  cam('cam_deck', gx, G.deckY + 4, gz);
  // the grove's volume: every house's site (its box + 8) and the walks between them, up to the crowns
  const xs = lots.flatMap((l) => [l.box[0], l.box[3]]), zs = lots.flatMap((l) => [l.box[2], l.box[5]]);
  const vb = { minX: Math.min(...xs) - 12, maxX: Math.max(...xs) + 12, minZ: Math.min(...zs) - 12, maxZ: Math.max(...zs) + 12, minY: Math.min(...lots.map((l) => l.box[1])) - 12, maxY: Math.max(...lots.map((l) => l.box[4])) + 24 };
  // the lane: a path on the ground along the grove's south side, from its west end past the last ramp's foot (the region's own cells)
  const lane = r.part('lane', { stage: 'ground', set: 'path' });
  const lx0 = Math.min(...lots.map((l) => l.box[0])), lx1 = Math.max(...lots.map((l) => l.box[3])) + 12;
  for (let x = lx0; x <= Math.min(claim.maxX - 1, lx1); x++) lane.fill({ kind: 'box', min: [x, { surface: 0 }, ez - 1], max: [x, { surface: 0 }, ez + 1] }, 'path', { cond: 1 });
  // the ramps' paths: the path role on the tongue and down the middle of each ramp's mound (the sculpt's ramps). The walker reads a
  // column from its written cells or its top, and under a giant crown the column's top is the leaves: a written path is what makes the
  // sculpted ramp walkable to it (as S6's street does the hall)
  for (const [i, rp] of (G.ramps ?? []).entries()) {
    const zc = (rp.gap[0] + rp.gap[1]) >> 1;
    const run = r.part(`ramp_path_${i + 1}`, { stage: 'ground', set: 'path' });
    for (let x = rp.x0; x <= Math.min(claim.maxX - 1, rp.xe + 24); x++) {
      if (x > rp.xe && survey.heightAt(x, zc) !== rp.top - (x - rp.xe)) break; // (past the mound's foot: the ground is the land's)
      run.fill({ kind: 'box', min: [x, { surface: 0 }, zc - 1], max: [x, { surface: 0 }, zc + 1] }, 'path', { cond: 1 });
    }
  }
  const v = r.needVolume({ minX: Math.max(claim.minX, vb.minX), maxX: Math.min(claim.maxX, vb.maxX), minZ: Math.max(claim.minZ, vb.minZ), maxZ: Math.min(claim.maxZ, vb.maxZ), minY: vb.minY, maxY: vb.maxY });
  if (!v) return r;
  for (const l of lots) {
    r.siteLot(l.id, { fit: 'wrap_trunk', box: l.box, rotation: rotationOfRow(l.row), stage: 'lots', brief: 'A home round its tree\'s trunk under the crown, its walk port out to the branch walks.', ext: { 'architect_mc:sb': { role: 'dwelling', tree: l.tree } } });
  }
  for (const [a, b] of walkPairs()) r.portLink(`walk_${a}_${b}`, { kind: 'branch_walk', from: { lot: `tree_${a}` }, to: { lot: `tree_${b}` } });
  return r;
}
