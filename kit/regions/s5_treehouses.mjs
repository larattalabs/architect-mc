// s5_treehouses (7b SB, docs/CONTRACT.md "Phase 7b" §3 row 11, SETTLEMENTS §16.2 S5 "a village in the crowns of giant trees"): the
// golden scenario S5's bundled program, not a catalogue program. The grove is the scenario's sculpt (kit/regions/s5_grove_sculpt.mjs:
// six giant oaks written as natural land before the plan, "Slice SB as built"); `params.grove` is that sculpt's record (its layout:
// the trees and the shared deck floor), so the village plans on exactly the trees the sculpt grew. Each tree holds a wrap_trunk site
// lot (a house round its trunk, under its crown) on the shared floor; branch walks (LP) join each facing pair's walk ports. Deterministic: no Math.random, no clock.
import { region } from '../lib/region/program.mjs';
import { TREE, groveLayout } from './s5_grove_sculpt.mjs';
import { VC } from '../lib/region/volume.mjs';

export const id = 's5_treehouses';
export const description = 'S5 treehouse village: houses round the trunks of giant oaks, joined by branch walks (7b SB).';
/**
 * (7c TC) In Regions.design's pick (the template catalogue). Its land is scenario setup, not generator output (SB reading 2): six giant
 * oaks with straight trunks, so `needs.affordances` asks AF for six tall trunks and a pick over land without them can't fit. `grove`
 * (the sculpt's record) is not pickable: a picked S5 finds its grove in the land (groveFromLand).
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

/** The highest SOIL or ROCK cell of column (x, z) under open air in a volume (the ramp's tongue top), or null. */
function soilTop(v, x, z) {
  const b = v.box;
  if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return null;
  const base = ((x - b.minX) * v.depth + (z - b.minZ)) * v.height;
  for (let j = v.height - 2; j >= 0; j--) {
    const c = v.classes[base + j], up = v.classes[base + j + 1];
    if ((c === VC.SOIL || c === VC.ROCK) && (up === VC.AIR || up === VC.PLANT)) return b.minY + j;
  }
  return null;
}

/** The rounded centre of the LOG cells on row y within 6 of [x, z] (the sculpt's axisAt, read from the land), or null. */
function logAxis(v, y, [ax, az]) {
  const b = v.box;
  if (y < b.minY || y > b.maxY) return null;
  let n = 0, sx = 0, sz = 0;
  for (let x = ax - 6; x <= ax + 6; x++) for (let z = az - 6; z <= az + 6; z++) {
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    if (v.classes[((x - b.minX) * v.depth + (z - b.minZ)) * v.height + (y - b.minY)] === VC.LOG) { n++; sx += x; sz += z; }
  }
  return n ? [Math.round(sx / n), Math.round(sz / n)] : null;
}

/**
 * (7c TC) The grove from the land, for a template pick (no `params.grove`): AF's trunks (height >= 24, the catalogue's need) nearest the
 * claim's centre laid out as the sculpt lays them (two rows of TREE.cols, TREE.spacing apart along x, the rows TREE.pairGap apart, within
 * 3); each pair's deck read from its ramp's tongue in the volume (its top is the walk's feet row, deck + 2; with no ramp, groveLayout's
 * rule from the survey); each tree's axis the centre of its logs one row over the deck (the sculpt's own definition); the ramps as the
 * sculpt records them. The same record params.grove carries, so the lots land on the trees standing there. Null when the land has no such
 * grove. Pure.
 */
export function groveFromLand(claim, survey, trunks, v) {
  const cx = (claim.minX + claim.maxX) >> 1, cz = (claim.minZ + claim.maxZ) >> 1;
  const [W, , D] = TREE.box;
  const tall = trunks.filter((a) => a.kind === 'trunk' && a.metrics.height >= 24).map((a) => ({ id: a.id, x: a.metrics.axis[0], z: a.metrics.axis[1], foot: a.anchors[0] }));
  const near = (a, x, z) => Math.abs(a.x - x) <= 3 && Math.abs(a.z - z) <= 3;
  // every tall trunk as the grove's north-west tree: the five others where the layout puts them; the set nearest the claim's centre wins
  let best = null;
  for (const nw of tall) {
    const set = [];
    for (let j = 0; j < TREE.rows; j++) for (let i = 0; i < TREE.cols; i++) {
      const x = nw.x + i * TREE.spacing, z = nw.z + j * TREE.pairGap;
      const m = tall.filter((a) => near(a, x, z)).sort((a, b) => Math.abs(a.x - x) + Math.abs(a.z - z) - (Math.abs(b.x - x) + Math.abs(b.z - z)) || (a.id < b.id ? -1 : 1))[0];
      if (m) set.push(m);
    }
    if (set.length !== TREE.rows * TREE.cols || new Set(set.map((a) => a.id)).size !== set.length) continue;
    const mx = set.reduce((s, a) => s + a.x, 0) / set.length, mz = set.reduce((s, a) => s + a.z, 0) / set.length;
    const d = Math.abs(mx - cx) + Math.abs(mz - cz);
    if (!best || d < best.d) best = { set, d };
  }
  if (!best) return null;
  const T = best.set;
  const footMax = (x, z) => { let m = -Infinity; for (let u = -(W >> 1); u <= W >> 1; u++) for (let w = -(D >> 1); w <= D >> 1; w++) m = Math.max(m, survey.heightAt(x + u, z + w)); return m; };
  const trees = T.map((a, i) => ({ id: `t${i + 1}`, trunk: a.id, at: [a.x, survey.heightAt(a.x, a.z), a.z] }));
  const ramps = [];
  for (let i = 0; i < TREE.cols; i++) {
    const n = trees[i], s = trees[TREE.cols + i];
    // the deck: the ramp's tongue (east of the pair, in the gap between the boxes) stands at the walk's feet row, deck + 2
    const zg0 = n.at[2] - (D >> 1) + D, zg1 = s.at[2] - (D >> 1) - 1, zc = (zg0 + zg1) >> 1;
    const xr = Math.max(n.at[0], s.at[0]) + 3;
    const top = soilTop(v, xr, zc);
    let deck;
    if (top !== null && top > Math.max(n.at[1], s.at[1]) + 1) deck = top - 2;
    else {
      const g = Math.max(n.at[1], s.at[1]), f = Math.max(footMax(n.at[0], n.at[2]), footMax(s.at[0], s.at[2]));
      deck = g + TREE.deckOver > f + 2 ? g + TREE.deckOver : f + 2;
    }
    n.deckY = s.deckY = deck;
  }
  for (const t of trees) {
    t.axis = logAxis(v, t.deckY + 1, [t.at[0], t.at[2]]);
    if (!t.axis) return null;
  }
  for (let i = 0; i < TREE.cols; i++) {
    const n = trees[i], s = trees[TREE.cols + i];
    const zg0 = n.axis[1] - (D >> 1) + D, zg1 = s.axis[1] - (D >> 1) - 1;
    const x0 = Math.max(n.axis[0], s.axis[0]) + 1, xe = Math.max(n.axis[0], s.axis[0]) + (W >> 1);
    ramps.push({ pair: [n.id, s.id], x0, xe, gap: [zg0, zg1], top: n.deckY + 2 });
  }
  const mid = (TREE.cols - 1) >> 1;
  const centre = [trees[mid].axis[0], (trees[mid].axis[1] + trees[TREE.cols + mid].axis[1]) >> 1];
  return { centre, deckY: trees[mid].deckY, ramps, trees };
}

export default function s5Treehouses(ctx) {
  const { claim, survey, params: P } = ctx;
  const r = region(ctx);
  r.stages(['ground', 'lots']);
  // (7c TC) a template pick sends no grove: the grove is found in the land (groveFromLand: AF's trunks, the decks read from the ramps),
  // groveLayout(survey) only when the land has no such trunks. The recorded params.grove path is unchanged.
  let probe = null, G = P?.grove?.trees ? P.grove : null;
  if (!G) {
    const st = survey.stats(claim.minX, claim.minZ, claim.maxX, claim.maxZ);
    probe = { minX: claim.minX, maxX: claim.maxX, minZ: claim.minZ, maxZ: claim.maxZ, minY: Math.max(claim.minY, st.minFloor - 16), maxY: Math.min(claim.maxY, st.maxTop + 72) };
    const pv = r.needVolume(probe);
    if (!pv) { // (the first plan asks for the land; the second finds the grove in it)
      const cx = (claim.minX + claim.maxX) >> 1, cz = (claim.minZ + claim.maxZ) >> 1;
      r.anchor('entrance', [cx, survey.heightAt(cx, cz) + 1, cz]);
      r.anchor('spawn', [cx, survey.heightAt(cx, cz) + 1, cz]);
      return r;
    }
    const trunks = r.affordances(probe, { kinds: ['trunk'] });
    G = groveFromLand(claim, survey, trunks, pv) ?? groveLayout(claim, survey);
  }
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
  const vbc = { minX: Math.max(claim.minX, vb.minX), maxX: Math.min(claim.maxX, vb.maxX), minZ: Math.max(claim.minZ, vb.minZ), maxZ: Math.min(claim.maxZ, vb.maxZ), minY: vb.minY, maxY: vb.maxY };
  // (7c TC) found in the land: the probe's volume serves the lots too when it holds their box (no third plan)
  const inProbe = probe && vbc.minX >= probe.minX && vbc.maxX <= probe.maxX && vbc.minZ >= probe.minZ && vbc.maxZ <= probe.maxZ && vbc.minY >= probe.minY && vbc.maxY <= probe.maxY;
  const v = r.needVolume(inProbe ? probe : vbc);
  if (!v) return r;
  for (const l of lots) {
    r.siteLot(l.id, { fit: 'wrap_trunk', box: l.box, rotation: rotationOfRow(l.row), stage: 'lots', brief: 'A home round its tree\'s trunk under the crown, its walk port out to the branch walks.', ext: { 'architect_mc:sb': { role: 'dwelling', tree: l.tree } } });
  }
  for (const [a, b] of walkPairs()) r.portLink(`walk_${a}_${b}`, { kind: 'branch_walk', from: { lot: `tree_${a}` }, to: { lot: `tree_${b}` } });
  return r;
}
