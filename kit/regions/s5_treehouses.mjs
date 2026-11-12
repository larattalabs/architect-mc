// s5_treehouses (7b SB, docs/CONTRACT.md "Phase 7b" §3 row 11, SETTLEMENTS §16.2 S5 "a village in the crowns of giant trees"): the
// golden scenario S5's bundled program, not a catalogue program. The grove is the scenario's sculpt (kit/regions/s5_grove_sculpt.mjs:
// six giant oaks written as natural land before the plan, "Slice SB as built"); `params.grove` is that sculpt's record (its layout:
// the trees and the shared deck floor), so the village plans on exactly the trees the sculpt grew. Each tree holds a wrap_trunk site
// lot (a house round its trunk, under its crown) on the shared floor; branch walks (LP) join each facing pair's walk ports. Deterministic: no Math.random, no clock.
import { region } from '../lib/region/program.mjs';
import { TREE, groveLayout } from './s5_grove_sculpt.mjs';

export const id = 's5_treehouses';
export const description = 'S5 treehouse village: houses round the trunks of giant oaks, joined by branch walks (7b SB).';
export const catalogue = false;
export const params = {
  grove: { type: 'json', default: null, label: 'The grove (the sculpt\'s record)' },
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
  const boxOn = ([ax, az]) => [ax - (W >> 1), G.deckY, az - (D >> 1), ax - (W >> 1) + W - 1, G.deckY + H - 1, az - (D >> 1) + D - 1];
  const lots = G.trees.map((t, i) => ({ id: `tree_${i + 1}`, tree: t.id, row: Math.floor(i / TREE.cols), box: boxOn(t.axis ?? [t.at[0], t.at[2]]) }));
  r.meta.sb = { scenario: 's5', deckY: G.deckY, centre: G.centre, trees: G.trees.map((t) => t.id), dwellings: lots.map((l) => l.id), fitCalledFor: { wrap_trunk: lots.map((l) => l.id), suspend: [] } };
  const [gx, gz] = G.centre;
  const gy = survey.heightAt(gx, gz) + 1;
  r.anchor('entrance', [gx, gy, gz]);
  r.anchor('spawn', [gx + 2, survey.heightAt(gx + 2, gz) + 1, gz]);
  r.anchor('cam_high', [gx, G.deckY + 40, gz + 70]);
  r.anchor('cam_n', [gx, G.deckY + 14, gz - 60]);
  r.anchor('cam_s', [gx, G.deckY + 14, gz + 60]);
  r.anchor('cam_e', [gx + 70, G.deckY + 18, gz]);
  r.anchor('cam_w', [gx - 70, G.deckY + 18, gz]);
  r.anchor('cam_deck', [gx, G.deckY + 4, gz]);
  // the grove's volume: every house's site (its box + 8) and the walks between them, up to the crowns
  const xs = lots.flatMap((l) => [l.box[0], l.box[3]]), zs = lots.flatMap((l) => [l.box[2], l.box[5]]);
  const vb = { minX: Math.min(...xs) - 12, maxX: Math.max(...xs) + 12, minZ: Math.min(...zs) - 12, maxZ: Math.max(...zs) + 12, minY: G.deckY - 12, maxY: G.deckY + H + 24 };
  const v = r.needVolume({ minX: Math.max(claim.minX, vb.minX), maxX: Math.min(claim.maxX, vb.maxX), minZ: Math.max(claim.minZ, vb.minZ), maxZ: Math.min(claim.maxZ, vb.maxZ), minY: vb.minY, maxY: vb.maxY });
  if (!v) return r;
  for (const l of lots) {
    r.siteLot(l.id, { fit: 'wrap_trunk', box: l.box, rotation: rotationOfRow(l.row), stage: 'lots', brief: 'A home round its tree\'s trunk under the crown, its walk port out to the branch walks.', ext: { 'architect_mc:sb': { role: 'dwelling', tree: l.tree } } });
  }
  for (const [a, b] of walkPairs()) r.portLink(`walk_${a}_${b}`, { kind: 'branch_walk', from: { lot: `tree_${a}` }, to: { lot: `tree_${b}` } });
  return r;
}
