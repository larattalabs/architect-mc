// floating_islands: golden scenario S1 v1, "a hamlet on floating islands, linked by stone" (docs/CONTRACT.md 6b §4.2,
// SETTLEMENTS §16.2; rope bridges are a 7a connector, so S1 in 6b is "S1 v1: stone links"). Over the claim's centre:
//   - a larger hub island at `altitude` with two lot pads; 4-8 smaller islands on a ring around it, each with one lot pad,
//     at heights within 8 of the hub's (floatingIsland v1: warped top and underside, roots, rim rails, lamp posts);
//   - stone links: a bridge with `supports: 'ends'` (no pillars) from the hub to every satellite and between ring
//     neighbours that are close enough (whole deck at most maxSpan 24), each end on a flat landing pad;
//   - a square spiral stair from the ground up to the hub (so `entrance` and `spawn` are on the ground), joined to the
//     hub's landing by a short bridge;
//   - lots on the island pads (`pad: {fill: 'none'}`), and 6 fixed cameras (`cam_*`).
// Stages: islands (the forms), ways (bridges, the spiral), lots.
import { region } from '../lib/region/program.mjs';
import { compassDir } from '../lib/region/geom.mjs';

export const id = 'floating_islands';

export const params = {
  islands: { type: 'int', min: 5, max: 9, default: 7, label: 'Islands' },
  spread: { type: 'int', min: 0, max: 8, default: 2, label: 'Extra spacing' },
  altitude: { type: 'int', min: 150, max: 200, default: 168, label: 'Hub altitude' },
};

export const catalogue = {
  description: 'Floating islands: 5-9 small separate sky islands (no pillars, nothing under them) around a larger hub island, each with one or two building lots, joined by stone bridges, with a spiral stair up from the ground. For scattered hamlets or outposts on several small islands in the sky, over plains or ocean.',
  needs: { minFlat: 0.6, water: 'ok', relief: 'low' },
  claim: { min: [200, 200], max: [320, 320] },
};

const LOT = 9; // lot footprint (a 9x9 child)
const BRIEFS = ['Hub hall', 'Sky market', 'Cottage', 'Workshop', 'Lookout house', 'Bakery', 'Smithy', 'Chapel', 'Granary', 'Inn'];

export default function floatingIslands(ctx) {
  const { claim, survey, params: P, rng } = ctx;
  const r = region(ctx);
  r.stages(['islands', 'ways', 'lots']);
  const round = (v) => Math.floor(v + 0.5);
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const cx = claim.minX + Math.floor(W / 2), cz = claim.minZ + Math.floor(D / 2);
  const ground = survey.stats(claim.minX, claim.minZ, claim.maxX, claim.maxZ);
  const alt = Math.max(P.altitude, ground.maxTop + 40);
  if (alt + 30 > claim.maxY) throw new Error(`floating_islands: the claim's y range ends at ${claim.maxY}, under the islands (${alt + 30})`);
  const ir = rng('islands');
  const n = P.islands - 1;
  const HUB = { x: cx, z: cz, y: alt, rx: 26, rz: 24 };
  const satR = (k) => 11 + (k % 3); // 11..13
  // the ring: close enough that a hub link's whole deck is at most 24
  // a satellite's distance: its link deck (4-connected cells between the landings, r - 4 in from each rim) at most 24
  const deckCells = (d, a, rr) => { const u = compassDir(a); const l = d - (Math.min(HUB.rx, HUB.rz) - 4) - (rr - 4); return Math.abs(round(u[0] * l)) + Math.abs(round(u[1] * l)) + 1; };
  const ring = HUB.rx + 13 + 8 + P.spread;
  const islands = [{ id: 'hub', ...HUB, pads: [], lots: [] }];
  for (let k = 0; k < n; k++) {
    const a = (360 * k) / n + 20;
    const d = compassDir(a);
    const rr = satR(k);
    const dy = ir.int(-6, 6);
    let dist = ring;
    while (deckCells(dist, a, rr) > 22 && dist > HUB.rx + rr + 6) dist--;
    islands.push({ id: `isle_${k + 1}`, x: round(cx + d[0] * dist), z: round(cz + d[1] * dist), y: alt + dy, rx: rr, rz: rr, angle: a, pads: [], lots: [] });
  }
  // links: hub to each satellite, and ring neighbours when their gap allows a deck of at most 24
  const links = [];
  const landing = (isl, toward, half = 2) => {
    const dx = toward.x - isl.x, dz = toward.z - isl.z, l = Math.sqrt(dx * dx + dz * dz);
    const rr = Math.min(isl.rx, isl.rz) - 4;
    const px = round(isl.x + (dx / l) * rr), pz = round(isl.z + (dz / l) * rr);
    isl.pads.push({ at: [px - half, pz - half], size: [2 * half + 1, 2 * half + 1], landing: true });
    return [px, pz];
  };
  for (let k = 1; k <= n; k++) links.push([islands[0], islands[k]]);
  for (let k = 1; k <= n; k++) {
    const a = islands[k], b = islands[(k % n) + 1];
    if (a === b) continue;
    const gap = Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z)) - a.rx - b.rx;
    const ml = Math.abs(a.x - b.x) + Math.abs(a.z - b.z) - (a.rx - 4) * 1.4 - (b.rx - 4) * 1.4;
    if (gap > 4 && ml <= 20 && Math.abs(a.y - b.y) <= gap) links.push([a, b]);
  }
  const linkEnds = links.map(([a, b]) => [landing(a, b), landing(b, a)]);
  // the spiral tower stands under the hub's centre and winds up through it, coming out on its top
  const tower = { x: cx, z: cz };
  // lots: two on the hub (west and north-east), one on each satellite (away from its landings)
  const lotPad = (isl, ox, oz) => { const px = isl.x + ox - (LOT >> 1) - 1, pz = isl.z + oz - (LOT >> 1) - 1; isl.pads.push({ at: [px, pz], size: [LOT + 2, LOT + 2] }); isl.lots.push([px + 1, pz + 1]); };
  lotPad(islands[0], -16, 0);
  lotPad(islands[0], 16, 0);
  for (let k = 1; k <= n; k++) {
    const isl = islands[k];
    const out = compassDir(isl.angle);
    lotPad(isl, round(out[0] * 2), round(out[1] * 2));
  }
  // ---- islands (forms)
  for (const isl of islands) {
    const res = r.floatingIsland(isl.id, {
      at: [isl.x, isl.y, isl.z], r: [isl.rx, isl.rz], thickness: isl.id === 'hub' ? 18 : 12,
      top: { relief: 1, pads: isl.pads, edge: 'rail', lights: 7 }, underside: { taper: 0.75, roots: isl.id === 'hub' ? 0 : 4 }, // the hub's centre holds the tower
      // the island's anchor (an M2 node) on its first landing, where a visitor arrives
      anchorAt: isl.id === 'hub' ? [isl.x + 9, isl.z + 9] : [isl.pads[0].at[0] + 2, isl.pads[0].at[1] + 2],
    }, { stage: 'islands' });
    isl.top = res.pads[0]?.y ?? isl.y;
  }
  // ---- ways: bridges ('ends') and the spiral
  const ways = r.part('links', { stage: 'ways', set: 'path' });
  links.forEach(([a, b], i) => {
    const [pa, pb] = linkEnds[i];
    ways.bridge([[pa[0], a.y, pa[1]], [pb[0], b.y, pb[1]]], { width: 3, supports: { style: 'ends' }, maxSpan: 24, lights: 8, over: 'ours', id: `link_${a.id}_${b.id}` });
  });
  const A = 6;
  const gY = Math.max(survey.heightAt(tower.x, tower.z), ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => survey.heightAt(tower.x + sx * A, tower.z + sz * A)));
  const tw = r.part('tower', { stage: 'ways', set: 'path' });
  const st = tw.spiralTower({ center: [tower.x, tower.z], half: A, top: alt, bottom: gY - 12, ground: (x, z) => survey.heightAt(x, z), start: 0, lights: 8, id: 'tower_stair' });
  // ---- anchors and cameras
  const b = st.bottom;
  const ex = b.x + b.out[0] * 4, ez = b.z + b.out[1] * 4;
  r.anchor('entrance', [ex, ez]);
  r.anchor('spawn', [ex + 2, ez]);
  const cams = [[0, 'south'], [90, 'west'], [180, 'north'], [270, 'east']];
  for (const [a, name] of cams) { const d = compassDir(a + 180); r.anchor(`cam_${name}`, [round(cx + d[0] * (ring + 40)), alt + 25, round(cz + d[1] * (ring + 40))]); }
  r.anchor('cam_high', [cx, Math.min(claim.maxY - 1, alt + 60), cz + 30]);
  r.anchor('cam_ground', [ex + 6, gY + 3, ez + 6]);
  // ---- lots on the pads
  const lp = r.part('lot_pads', { stage: 'islands' });
  let li = 0;
  for (const isl of islands) for (const [x0, z0] of isl.lots) {
    const fx = cx - (x0 + LOT / 2), fz = cz - (z0 + LOT / 2);
    const front = isl.id === 'hub' ? (Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? 'east' : 'west') : (fz > 0 ? 'south' : 'north'))
      : (Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? 'east' : 'west') : (fz > 0 ? 'south' : 'north'));
    lp.lot(`lot_${++li}`, { at: [x0, z0], size: [LOT, LOT], floor: isl.y + 1, front, max: [LOT, 12, LOT], brief: BRIEFS[(li - 1) % BRIEFS.length], stage: 'lots', pad: { fill: 'none', edge: 'wall', maxCut: 64, maxFill: 64 } });
  }
  return r;
}
