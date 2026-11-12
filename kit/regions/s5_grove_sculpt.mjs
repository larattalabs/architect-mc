// s5_grove_sculpt (7b SB, "Slice SB as built"): S5's giant trees (SETTLEMENTS §16.2 S5: "a forest location, pinned; giant trees
// generated"), not a catalogue program. Before S5 is planned the scenario harness writes this program's cells into the world as natural,
// unowned land with vanilla /fill (tools/lib/scenario-sculpt.mjs), as S6's cavern and S3's flat hill: a wrap_trunk site lot's Site is
// the land read at plan time, so its host tree must stand there before the plan (a giant tree the village's own region grew would not be
// in it). The program: six F3 `giantTree` oaks in three facing pairs (two rows of three), on the dry, level spot nearest the claim's
// centre; each tree's height chosen so its first branches clear the shared deck box (the houses' boxes share one floor y, so the branch
// walks between their ports are level); the natural forest's trees cleared round each one (air over the volume's LOG and LEAVES cells
// within TREE.clear columns of a site), so a house's site holds its own tree only. Deterministic: no Math.random, no clock.
import { region } from '../lib/region/program.mjs';
import { VC } from '../lib/region/volume.mjs';
import { giantTree } from '../lib/forms/giantTree.mjs';
import { fnv64 } from '../lib/noise.mjs';

/** A tree's logs on row y within `r` of its foot, as a sorted key list (one string). */
function trunkRow(cells, y, at, r) {
  const out = [];
  for (const [k, st] of cells) {
    const [x, yy, z] = k.split(',').map(Number);
    if (yy === y && /_(log|wood)\b/.test(st) && Math.abs(x - at[0]) <= r && Math.abs(z - at[2]) <= r) out.push(`${x},${z}`);
  }
  return out.sort().join(';');
}

/** The centre [x, z] of a tree's logs on row y within 6 of its foot (rounded), else the foot. */
function axisAt(cells, y, at) {
  let n = 0, sx = 0, sz = 0;
  for (const [k, st] of cells) {
    const [x, yy, z] = k.split(',').map(Number);
    if (yy === y && /_(log|wood)\b/.test(st) && Math.abs(x - at[0]) <= 6 && Math.abs(z - at[2]) <= 6) { n++; sx += x; sz += z; }
  }
  return n ? [Math.round(sx / n), Math.round(sz / n)] : [at[0], at[2]];
}

export const id = 's5_grove_sculpt';
export const description = 'S5\'s giant trees (7b SB): six F3 giant oaks in a clearing, written as natural land before the village is planned.';
export const catalogue = false;
export const params = {};

/** The grove's numbers: the sites' offsets from the grove's centre, the house box (x, h, z), its floor over the highest tree's ground. */
export const TREE = Object.freeze({
  preset: 'oak', spacing: 26, pairGap: 20, rows: 2, cols: 3, box: Object.freeze([17, 8, 17]), deckOver: 4, clear: 20, search: 56, step: 4, branchOver: 1, seeds: 12, taller: 12,
});

/** The tree sites' offsets [dx, dz] from the grove's centre (row-major from the north-west): TREE.spacing apart along x, the two rows
 * TREE.pairGap apart (each column a pair of houses facing each other across a short walk). */
export function siteOffsets() {
  const out = [];
  for (let j = 0; j < TREE.rows; j++) for (let i = 0; i < TREE.cols; i++) out.push([(i - (TREE.cols - 1) / 2) * TREE.spacing, (j - (TREE.rows - 1) / 2) * TREE.pairGap]);
  return out;
}

/** The first branch row over the ground of a giant oak of height h (lib/forms/giantTree.mjs: the colonisation starts). */
export function branchStart(h) {
  const top = Math.max(6, Math.round(h * 0.6)); // the oak preset's `top` 0.6
  return Math.max(4, top - Math.round(h * 0.18));
}

/**
 * The grove from the survey: the centre (searched on a TREE.step grid within TREE.search of the claim's centre) whose six sites are dry
 * (no water within 12) with the least spread of ground within a pair (each pair's walk is level; pairs may stand at different heights),
 * then the least roughness under the houses, then nearest the centre. Each pair's deck floor clears the ground under both its houses by 2
 * and its trees' feet by TREE.deckOver; each tree's height is the least whose branches start TREE.branchOver over its house box. Pure.
 * Returns {centre, deckY (the middle pair's), spread, trees [{id, at, height, deckY}]} (the program adds each tree's `axis` at the deck).
 */
export function groveLayout(claim, survey) {
  const cx = claim.minX + Math.floor((claim.maxX - claim.minX + 1) / 2), cz = claim.minZ + Math.floor((claim.maxZ - claim.minZ + 1) / 2);
  const off = siteOffsets();
  const half = Math.floor(TREE.box[0] / 2), reach = half + 8 + 2;
  const footMax = (x, z) => { let b = -Infinity; for (let u = -half; u <= half; u++) for (let v = -half; v <= half; v++) b = Math.max(b, survey.heightAt(x + u, z + v)); return b; };
  let best = null;
  for (let dz = -TREE.search; dz <= TREE.search; dz += TREE.step) for (let dx = -TREE.search; dx <= TREE.search; dx += TREE.step) {
    const ox = cx + dx, oz = cz + dz;
    let ok = true, rough = 0;
    const g = [];
    for (const [sx, sz] of off) {
      const x = ox + sx, z = oz + sz;
      if (x - reach < claim.minX || x + reach > claim.maxX || z - reach < claim.minZ || z + reach > claim.maxZ) { ok = false; break; }
      for (let u = -12; u <= 12 && ok; u += 2) for (let v = -12; v <= 12; v += 2) if (survey.waterAt(x + u, z + v)) { ok = false; break; }
      if (!ok) break;
      g.push(survey.heightAt(x, z));
      let a = Infinity, b = -Infinity;
      for (let u = -half; u <= half; u += 2) for (let v = -half; v <= half; v += 2) { const h = survey.heightAt(x + u, z + v); a = Math.min(a, h); b = Math.max(b, h); }
      rough += b - a;
    }
    if (!ok) continue;
    let spread = 0;
    for (let i = 0; i < TREE.cols; i++) spread = Math.max(spread, Math.abs(g[i] - g[TREE.cols + i]));
    const score = [spread, rough, Math.abs(dx) + Math.abs(dz)];
    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])))) best = { ox, oz, score };
  }
  if (!best) return null;
  const at = off.map(([sx, sz]) => { const x = best.ox + sx, z = best.oz + sz; return [x, survey.heightAt(x, z), z]; });
  const deck = [];
  for (let i = 0; i < TREE.cols; i++) {
    const n = at[i], s = at[TREE.cols + i];
    deck[i] = deck[TREE.cols + i] = Math.max(n[1], s[1]) + TREE.deckOver > Math.max(footMax(n[0], n[2]), footMax(s[0], s[2])) + 2 ? Math.max(n[1], s[1]) + TREE.deckOver : Math.max(footMax(n[0], n[2]), footMax(s[0], s[2])) + 2;
  }
  const trees = at.map((a, i) => {
    let h = 24;
    while (h < 64 && a[1] + branchStart(h) < deck[i] + TREE.box[1] + TREE.branchOver) h++;
    return { id: `t${i + 1}`, at: a, height: h, deckY: deck[i] };
  });
  return { centre: [best.ox, best.oz], spread: best.score[0], deckY: deck[(TREE.cols - 1) >> 1], trees };
}

export default function s5GroveSculpt(ctx) {
  const { claim, survey } = ctx;
  const r = region(ctx);
  r.stages(['clear', 'trees']);
  const G = groveLayout(claim, survey);
  if (!G) throw new Error('s5_grove_sculpt: no dry spot for the grove near the claim\'s centre');
  r.meta.sb = { scenario: 's5', sculpt: 'grove', ...G };
  r.anchor('entrance', [G.centre[0], survey.heightAt(G.centre[0], G.centre[1]) + 1, G.centre[1]]);
  r.anchor('spawn', [G.centre[0], survey.heightAt(G.centre[0], G.centre[1]) + 1, G.centre[1]]);
  // the clearing: the natural trees' logs within TREE.clear columns of a site and leaves within 6 more (from the volume over the grove)
  const xs = G.trees.map((t) => t.at[0]), zs = G.trees.map((t) => t.at[2]), gs = G.trees.map((t) => t.at[1]);
  const cr = TREE.clear + 6;
  const vb = { minX: Math.max(claim.minX, Math.min(...xs) - cr), maxX: Math.min(claim.maxX, Math.max(...xs) + cr), minZ: Math.max(claim.minZ, Math.min(...zs) - cr), maxZ: Math.min(claim.maxZ, Math.max(...zs) + cr), minY: Math.min(...gs) - 4, maxY: Math.max(...gs) + 64 };
  const v = r.needVolume(vb);
  if (v) {
    const clear = r.part('clearing', { stage: 'clear' });
    const b = v.box;
    for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) {
      const d = Math.min(...G.trees.map((t) => Math.max(Math.abs(t.at[0] - x), Math.abs(t.at[2] - z))));
      if (d > TREE.clear + 6) continue; // (logs within TREE.clear; leaves 6 further: a cleared tree's leaves would decay after the snapshot)
      let y0 = null;
      for (let y = b.minY; y <= b.maxY + 1; y++) {
        const c = y <= b.maxY ? v.classes[((x - b.minX) * v.depth + (z - b.minZ)) * v.height + (y - b.minY)] : VC.AIR;
        const tree = (c === VC.LOG && d <= TREE.clear) || c === VC.LEAVES;
        if (tree && y0 === null) y0 = y;
        if (!tree && y0 !== null) { clear.fill({ kind: 'box', min: [x, { abs: y0 }, z], max: [x, { abs: y - 1 }, z] }, null, { cond: 0 }); y0 = null; }
      }
    }
  }
  // each tree's height and seed: the first (height from the least that clears the box up to TREE.taller more, then seed 0..TREE.seeds-1)
  // whose trunk stands straight through the house's box: the same cross-section of logs on every row of the box (no branch, root,
  // taper step or lean inside the house; SV's trunk house rings one round trunk); its axis (the centre of those logs) centres the box
  const [W, H, D] = TREE.box;
  for (const t of G.trees) {
    let pick = null;
    for (let h = t.height; h <= Math.min(64, t.height + TREE.taller) && !pick; h++) for (let k = 0; k < TREE.seeds && !pick; k++) {
      const seed = fnv64(ctx.seed, 'giantTree', t.id, h, k).hex;
      const gen = giantTree({ at: t.at, preset: TREE.preset, height: h, seed }, { groundAt: (x, z) => survey.heightAt(x, z) });
      const rows = [];
      for (let y = t.deckY; y < t.deckY + H; y++) rows.push(trunkRow(gen.cells, y, t.at, W >> 1));
      if (rows[0].length && rows.every((q) => q === rows[0])) pick = { seed, h, k, axis: axisAt(gen.cells, t.deckY + 1, t.at), straight: true };
    }
    if (!pick) pick = { seed: fnv64(ctx.seed, 'giantTree', t.id, t.height, 0).hex, h: t.height, k: 0, axis: null, straight: false };
    const gen = r.giantTree(t.id, { at: t.at, preset: TREE.preset, height: pick.h, seed: pick.seed }, { stage: 'trees' });
    Object.assign(t, { height: pick.h, seed: pick.k, axis: pick.axis ?? axisAt(gen.cells, t.deckY + 1, t.at), straight: pick.straight });
  }
  // the ramps: the land's way up (as S6's ramp is). Each pair's houses face each other across a gap TREE.pairGap - box wide, where the
  // village's branch walk runs at the houses' feet row (deckY + 2). An earthen ramp meets it from the east: a tongue between the two
  // house boxes whose top is the walk's feet row (a solid cell beside the deck: the walk rails every open side, so a ramp is a cell the
  // walk leaves open and a player steps down from), then a mound falling one row per column east and sideways to the ground (no drop
  // over 1). Grass on top, dirt under (the surface and subsurface roles). Recorded in meta.sb.ramps.
  const ramp = r.part('ramps', { stage: 'trees' });
  G.ramps = [];
  for (let i = 0; i < TREE.cols; i++) {
    const n = G.trees[i], s = G.trees[TREE.cols + i];
    const fy = n.deckY + 2; // (the pair's walk: its feet row)
    const zg0 = n.axis[1] - (D >> 1) + D, zg1 = s.axis[1] - (D >> 1) - 1; // the gap's rows between the boxes
    const zc = (zg0 + zg1) >> 1, hw = (zg1 - zg0) >> 1;
    const x0 = Math.max(n.axis[0], s.axis[0]) + 1, xe = Math.max(n.axis[0], s.axis[0]) + (W >> 1); // the tongue: east of the deck to the boxes' east edge
    const cells = [];
    for (let x = x0; x <= xe + (fy - 0) && x <= claim.maxX - 1; x++) {
      for (let z = zc - hw - (fy - G.trees[i].at[1]) - 2; z <= zc + hw + (fy - G.trees[i].at[1]) + 2; z++) {
        if (x <= xe && (z < zg0 || z > zg1)) continue; // (beside the boxes only the gap)
        const top = fy - Math.max(0, x - xe) - Math.max(0, Math.abs(z - zc) - hw);
        const g = survey.heightAt(x, z);
        if (top <= g) continue;
        if (g + 1 <= top - 1) ramp.fill({ kind: 'box', min: [x, { abs: g + 1 }, z], max: [x, { abs: top - 1 }, z] }, 'subsurface', { cond: 0 });
        ramp.fill({ kind: 'box', min: [x, { abs: top }, z], max: [x, { abs: top }, z] }, 'surface', { cond: 0 });
        cells.push([x, z, top]);
      }
    }
    G.ramps.push({ pair: [n.id, s.id], x0, xe, gap: [zg0, zg1], top: fy, columns: cells.length });
  }
  r.meta.sb.ramps = G.ramps;
  return r;
}
