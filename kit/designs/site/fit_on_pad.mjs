// Stilt house (7b SV, fit on_pad): a gabled house on a deck over the edge of a pond, built into the 7bF fixture `grove`. It is an ordinary
// pad design (today's placement: clear above the ground row, ground approach), with one site-aware part: stilts that run from the deck
// down through the air and the water to the site's ground (lib/siteHelpers.mjs stilts), long over the pond and short on the bank. Its
// front faces north, away from the pond, where a short stair comes down to the ground.
import { Blueprint, PALETTES } from '../../lib/kit.mjs';

export const id = 'fit_on_pad';
export const fit = 'on_pad';
export const exampleSite = 'grove';
/** The warnings (rule names) of the template-only check (no composite until SC): none: it checks clean on the template alone. kit/tools/examples.mjs holds them exact. */
export const templateOnlyWarnings = [];

export default function build({ palette = PALETTES.rustic, site } = {}) {
  const p = palette;
  const ground = site.surface(0, 0); // the bank's top row (soil)
  const groundY = ground + 1; // the feet row on the ground
  const deckY = groundY + 2; // the deck: two rows of stilts above the ground
  const X0 = 3, X1 = 12, Z0 = 8, Z1 = 14; // the house's walls (its south half over the pond)
  const roofY = deckY + 4;
  const D = 7; // the door column
  const bp = new Blueprint({
    id, name: 'Stilt House', description: 'A gabled house on a deck over the edge of a pond, on stilts down to the ground and the pond bed.',
    type: 'cabin', tags: ['site', 'stilts', 'water', 'small'], site, palette: p, groundY, front: 'north',
    interior: [X0 + 1, deckY + 1, Z0 + 1, X1 - 1, roofY - 1, Z1 - 1],
    approach: { length: 3, width: 2 },
  });

  bp.part('stilts', () => {
    const pts = [];
    for (const x of [X0 - 1, D - 1, D + 2, X1 + 1]) for (const z of [Z0 - 3, Z0 + 1, Z1 - 2, Z1 + 1]) pts.push([x, z]);
    bp.stilts(pts, deckY - 1);
  });

  bp.part('deck', () => {
    bp.floor(X0 - 1, Z0 - 3, X1 + 1, Z1 + 1, deckY, p.floor);
    for (let x = X0 - 1; x <= X1 + 1; x++) for (const z of [Z0 - 3, Z1 + 1]) if (!(z === Z0 - 3 && (x === D || x === D + 1))) bp.set(x, deckY + 1, z, p.fence);
    for (let z = Z0 - 2; z <= Z1; z++) for (const x of [X0 - 1, X1 + 1]) bp.set(x, deckY + 1, z, p.fence);
    // the stair down to the ground, two wide
    for (const x of [D, D + 1]) {
      bp.stairs(x, deckY - 1, Z0 - 4, 'south');
      bp.set(x, deckY - 2, Z0 - 4, p.floor); // under the upper step
      bp.stairs(x, deckY - 2, Z0 - 5, 'south');
    }
  });

  bp.part('main', () => {
    bp.walls(X0, Z0, X1, Z1, deckY + 1, roofY - 1);
    bp.carve([X0 + 1, deckY + 1, Z0 + 1, X1 - 1, roofY - 1, Z1 - 1]);
    bp.floor(X0 + 1, Z0 + 1, X1 - 1, Z1 - 1, roofY, p.floor); // the ceiling
  });

  bp.part('roof', () => {
    bp.roofGable(X0 - 1, Z0 - 1, X1 + 1, Z1 + 1, roofY, { ridge: 'x', pitch: 1 });
  }, { roof: 'gable' });

  bp.part('openings', () => {
    bp.door(D, deckY + 1, Z0, 'north');
    for (const x of [X0 + 2, X1 - 2]) for (const z of [Z0, Z1]) bp.window(x, deckY + 2, z, x, deckY + 2, z);
    for (const x of [X0, X1]) bp.window(x, deckY + 2, Z0 + 3, x, deckY + 2, Z0 + 3);
    bp.lantern(X0 - 1, deckY + 2, Z0 - 3);
  });

  bp.part('furnishings', () => {
    bp.bed(X1 - 1, deckY + 1, Z1 - 1, 'south', 'red');
    bp.chair(X0 + 1, deckY + 1, Z1 - 1, 'north');
    bp.ceilingLights(X0 + 1, Z0 + 1, X1 - 1, Z1 - 1, roofY - 1, { spacing: 5 });
  });

  bp.spot('entrance', D, Z0 - 1, 0, { y: deckY + 1 });
  bp.spot('spawn', D, Z0 - 6, 0, { y: groundY });
  bp.camera('overview', [X1 + 10, roofY + 6, Z1 + 10], [(X0 + X1) / 2, deckY, (Z0 + Z1) / 2]);
  return bp;
}
