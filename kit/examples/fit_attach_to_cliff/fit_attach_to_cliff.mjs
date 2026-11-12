// Cliff house (7b SV, fit attach_to_cliff): a one-room house hung on a south-facing rock face, built into the 7bF fixture `cliff_face`
// (or any attach_to_cliff site of the same shape). The roof is a deck flush with the clifftop, where the walk port arrives; an outside
// stair on the east side runs down to a balcony and the front door. The house's north wall stands against the face, floor joists run
// into the rock (beamInto) and knee braces (bracket) bear on the face under the floor.
//
// Read from the site, not assumed: the face (site.face('south')), the clifftop row (site.surface at the port's column) and the port.
// Every block comes from the palette's roles. The template is the lot box; the site's cells it does not write stay (fit keep).
import { Blueprint, PALETTES } from '../../lib/kit.mjs';

export const id = 'fit_attach_to_cliff';
export const fit = 'attach_to_cliff';
/** The 7bF fixture this example is built into (kit/tools/examples.mjs). */
export const exampleSite = 'cliff_face';
/** The warnings (rule names) of the template-only check (no composite until SC): none: it checks clean on the template alone. kit/tools/examples.mjs holds them exact. */
export const templateOnlyWarnings = [];

export default function build({ palette = PALETTES.rustic, site } = {}) {
  const p = palette;
  const face = site.face('south'); // the rock face the house hangs on
  const port = site.port('walk_top'); // where the walk arrives, on the clifftop
  const F = face.at + 1; // the first open row in front of the face: the house's north wall
  const top = site.surface(port.at[0], port.at[2]); // the clifftop row: the roof deck is flush with it
  const deck = top; // the roof deck's row (feet on it at top + 1, the port's row)
  const floorY = deck - 4; // the floor row (feet 3 rows under the ceiling)
  const X0 = 2, X1 = 11, Z1 = F + 6; // the house's walls
  const bp = new Blueprint({
    id, name: 'Cliff House', description: 'A one-room house hung on a rock face: a roof deck at the clifftop, an outside stair down to a balcony and the front door.',
    type: 'cabin', tags: ['site', 'cliff', 'small'], site, palette: p, groundY: floorY + 1, front: 'south',
    interior: [X0 + 1, floorY + 1, F + 1, X1 - 1, deck - 1, Z1 - 1],
  });

  bp.part('frame', () => {
    // floor joists run north into the rock; knee braces bear on the face under the floor's corners
    for (const x of [X0 + 1, Math.floor((X0 + X1) / 2), X1 - 2]) bp.beamInto(x, floorY - 1, Z1 + 1, 'north');
    for (const x of [X0, X1, X1 + 2]) bp.bracket(x, floorY - 3, F, 'south', { len: 3 });
  });

  bp.part('main', () => {
    bp.floor(X0, F, X1, Z1, floorY, p.floor);
    bp.walls(X0, F, X1, Z1, floorY + 1, deck - 1);
    bp.carve([X0 + 1, floorY + 1, F + 1, X1 - 1, deck - 1, Z1 - 1]);
  });

  bp.part('openings', () => {
    const D = Math.floor((X0 + X1) / 2);
    bp.door(D, floorY + 1, Z1, 'south');
    for (const x of [X0 + 2, X1 - 2]) bp.window(x, floorY + 2, Z1, x, floorY + 2, Z1);
    for (const x of [X0, X1]) bp.window(x, floorY + 2, F + 3, x, floorY + 2, F + 3);
  });

  bp.part('roof_deck', () => {
    bp.floor(X0, F, X1, Z1, deck, p.floor);
    bp.floor(X1 + 1, F, X1 + 2, F, deck, p.floor); // the landing to the outside stair
    for (let x = X0; x <= X1; x++) bp.set(x, deck + 1, Z1, p.fence);
    for (let z = F + 1; z < Z1; z++) { bp.set(X0, deck + 1, z, p.fence); bp.set(X1, deck + 1, z, p.fence); }
  }, { roof: 'flat' });

  bp.part('stair', () => {
    // down the east side from the landing to the balcony row: one row per cell south
    const sx = X1 + 2;
    bp.floor(X1 + 1, F, sx, Z1, floorY, p.floor); // the strip beside the house, two wide, under the stair
    for (let k = 1; k <= 4; k++) {
      bp.stairs(sx, deck - k, F + k, 'north');
      if (k < 4) bp.set(sx, deck - k - 1, F + k, p.floor); // the stringer under each step
    }
  });

  bp.part('balcony', () => {
    bp.floor(X0, Z1 + 1, X1 + 2, Z1 + 2, floorY, p.floor);
    for (let x = X0; x <= X1 + 2; x++) bp.set(x, floorY + 1, Z1 + 2, p.fence);
    bp.set(X0, floorY + 1, Z1 + 1, p.fence);
    bp.lantern(X1 + 2, floorY + 2, Z1 + 2);
  });

  bp.part('furnishings', () => {
    bp.bed(X0 + 1, floorY + 1, F + 1, 'north', 'red');
    bp.chair(X1 - 1, floorY + 1, F + 1, 'south');
    bp.ceilingLights(X0 + 1, F + 1, X1 - 1, Z1 - 1, deck - 1);
  });

  const D = Math.floor((X0 + X1) / 2);
  bp.port('walk_top', 'architect:walk', ...port.at, port.facing);
  bp.spot('entrance', D, Z1 + 1, 180, { y: floorY + 1 });
  bp.spot('spawn', port.at[0], F + 1, 180, { y: deck + 1 });
  bp.camera('overview', [-10, deck + 6, Z1 + 16], [(X0 + X1) / 2, floorY, F + 3]);
  return bp;
}
