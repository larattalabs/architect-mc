// Inverted house (7c US, rule.suspended): a gabled cottage built standing and turned upside down with bp.invert(), hung by its old floor
// from the rock overhang of the 7bF fixture `overhang`. After the flip the old floor slab bears on the rock ceiling, the room hangs under
// it, the old attic deck is the floor you walk on and the gable roof is a keel pointing at the drop (its stairs and its lining now
// upside down). What the flip carries: the roof's stairs (half top), the attic hatch (a trapdoor, now in the floor), the door (written
// under the deck, so its halves swap and it stands on the new floor), the windows and the lanterns (standing on the old floor, hanging
// from the new ceiling). Written after the flip, on the new floor: the ladder from the site's walk port up through the keel, the balcony
// on two chains, the bed and the spots.
import { Blueprint, PALETTES } from '../../lib/kit.mjs';

export const id = 'fit_suspend_inverted';
export const fit = 'suspend';
export const exampleSite = 'overhang';

export default function build({ palette = PALETTES.rustic, site } = {}) {
  const p = palette;
  const H = site.size.y;
  const hang = site.hangPoints(); // the four hang points on the overhang's underside (kept: above the lot, never written)
  const hatch = site.port('down');
  const xs = [...new Set(hang.map((c) => c[0]))].sort((a, b) => a - b);
  const zs = [...new Set(hang.map((c) => c[2]))].sort((a, b) => a - b);
  const X0 = xs[0], X1 = xs[xs.length - 1], Z0 = zs[0], Z1 = zs[zs.length - 1]; // the walls under the hang points
  const ceil = Math.min(...hang.map((c) => c[1])); // the underside's row (the row over the lot)
  const up = (u) => H - 1 - u; // a standing row's row after the flip
  // standing: the floor slab on row 0 (after the flip the row under the rock), walls 1..4, the attic deck on row 5, the gable from row 6
  const floor = up(5); // the floor after the flip
  const [hx, , hz] = hatch.at;
  const D = hx - 1; // the door column
  const bp = new Blueprint({
    id, name: 'Inverted House', description: 'A gabled cottage hung upside down from a rock overhang: its old floor bears on the rock, its roof points at the drop; in by a ladder through the keel or the balcony.',
    type: 'cabin', tags: ['site', 'hanging', 'inverted', 'small'], site, palette: p, groundY: floor + 1, front: 'south',
    interior: [X0 + 1, 1, Z0 + 1, X1 - 1, 4, Z1 - 1],
  });

  // ---- the standing cottage (rows from the bottom up), turned over below
  bp.part('main', () => {
    bp.floor(X0, Z0, X1, Z1, 0, p.planks);
    bp.walls(X0, Z0, X1, Z1, 1, 4);
    bp.carve([X0 + 1, 1, Z0 + 1, X1 - 1, 4, Z1 - 1]);
    bp.floor(X0, Z0, X1, Z1, 5, p.floor);
  });
  bp.part('roof', () => {
    bp.roofGable(X0 - 1, Z0 - 1, X1 + 1, Z1 + 1, 6, { ridge: 'x' });
  }, { roof: 'gable' });
  bp.part('openings', () => {
    // the door under the deck: after the flip its lower half stands on the new floor
    bp.door(D, 3, Z1, 'south');
    for (const x of [X0 + 2, X1 - 2]) bp.window(x, 2, Z1, x, 3, Z1);
    for (const x of [X0, X1]) bp.window(x, 2, Z0 + 2, x, 3, Z0 + 3);
  });
  bp.part('hatch', () => {
    // the attic hatch, shut: after the flip a top-half trapdoor flush in the floor over the ladder
    bp.set(hx, 5, hz, p.trapdoor, { facing: 'north', half: 'bottom', open: 'false' });
  });
  bp.part('lights', () => {
    // standing lanterns on the floor slab: after the flip they hang from the new ceiling
    for (const x of [X0 + 3, X1 - 3]) bp.lantern(x, 1, Math.floor((Z0 + Z1) / 2), false);
  });

  bp.invert();

  // ---- written on the hung house (rows after the flip)
  bp.part('hatch', () => {
    // a ladder from the walk port up through the keel to the trapdoor, on a post of the frame role
    bp.post(hx, hz + 1, hatch.at[1], floor - 1);
    bp.ladder(hx, hz, hatch.at[1], floor - 1, 'north');
  });
  bp.part('balcony', () => {
    bp.floor(D - 2, Z1 + 1, D + 3, Z1 + 2, floor, p.floor);
    for (let x = D - 2; x <= D + 3; x++) bp.set(x, floor + 1, Z1 + 2, p.fence);
    for (const x of [D - 2, D + 3]) bp.set(x, floor + 1, Z1 + 1, p.fence);
  });
  bp.part('chains', () => {
    for (const x of [D - 2, D + 3]) bp.hangChain(x, Z1 + 2, ceil - 1, floor + 2);
  });
  bp.part('furnishings', () => {
    bp.bed(X0 + 1, floor + 1, Z0 + 1, 'north', 'red');
    bp.chair(X1 - 1, floor + 1, Z0 + 1, 'south');
  });

  bp.port(hatch.name, 'architect:walk', ...hatch.at, 'down');
  bp.spot('entrance', D, Z1 + 1, 180, { y: floor + 1 });
  bp.spot('spawn', D + 1, Z1 + 1, 180, { y: floor + 1 });
  bp.camera('overview', [X0 - 8, floor + 2, Z1 + 14], [(X0 + X1) / 2, floor, (Z0 + Z1) / 2]);
  return bp;
}
