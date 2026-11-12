// Hanging house (7b SV, fit suspend): a flat-roofed house hung on chains from a rock overhang, built into the 7bF fixture `overhang`. A
// chain rises from each roof corner to a hang point on the overhang's underside (the site's keep-critical cells), two more carry the
// balcony's front, and a ladder hangs from the floor down to the site's walk port (a hatch: the graph arrives from below).
import { Blueprint, PALETTES } from '../../lib/kit.mjs';

export const id = 'fit_suspend';
export const fit = 'suspend';
export const exampleSite = 'overhang';
/** The warnings (rule names) of the template-only check (no composite until SC): none: it checks clean on the template alone. kit/tools/examples.mjs holds them exact. */
export const templateOnlyWarnings = [];

export default function build({ palette = PALETTES.rustic, site } = {}) {
  const p = palette;
  const hang = site.hangPoints(); // the four hang points on the overhang's underside
  const hatch = site.port('down');
  const xs = [...new Set(hang.map((c) => c[0]))].sort((a, b) => a - b);
  const zs = [...new Set(hang.map((c) => c[2]))].sort((a, b) => a - b);
  const X0 = xs[0], X1 = xs[xs.length - 1], Z0 = zs[0], Z1 = zs[zs.length - 1]; // the house's walls under the hang points
  const ceil = Math.min(...hang.map((c) => c[1])); // the underside's row
  const floorY = 4, roofY = floorY + 4;
  const [hx, , hz] = hatch.at;
  const D = hx - 1; // the door column
  const bp = new Blueprint({
    id, name: 'Hanging House', description: 'A flat-roofed house hung on chains from a rock overhang, entered by a ladder from below or the balcony.',
    type: 'cabin', tags: ['site', 'hanging', 'small'], site, palette: p, groundY: floorY + 1, front: 'south',
    interior: [X0 + 1, floorY + 1, Z0 + 1, X1 - 1, roofY - 1, Z1 - 1],
  });

  bp.part('main', () => {
    bp.floor(X0, Z0, X1, Z1, floorY, p.floor);
    bp.walls(X0, Z0, X1, Z1, floorY + 1, roofY - 1);
    bp.carve([X0 + 1, floorY + 1, Z0 + 1, X1 - 1, roofY - 1, Z1 - 1]);
  });

  bp.part('roof', () => {
    bp.floor(X0, Z0, X1, Z1, roofY, p.roofBlock);
    for (let x = X0; x <= X1; x++) for (const z of [Z0, Z1]) bp.slab(x, roofY + 1, z, 'bottom', p.roofSlab);
    for (let z = Z0 + 1; z < Z1; z++) for (const x of [X0, X1]) bp.slab(x, roofY + 1, z, 'bottom', p.roofSlab);
  }, { roof: 'flat' });

  bp.part('chains', () => {
    // from each hang point (kept: never written) down to the roof corner under it
    for (const [x, , z] of hang) bp.hangChain(x, z, ceil - 1, roofY + 1);
    for (const x of [D - 2, D + 3]) bp.hangChain(x, Z1 + 2, ceil - 1, floorY + 2);
  });

  bp.part('balcony', () => {
    bp.floor(D - 2, Z1 + 1, D + 3, Z1 + 2, floorY, p.floor);
    for (let x = D - 2; x <= D + 3; x++) bp.set(x, floorY + 1, Z1 + 2, p.fence);
    for (const x of [D - 2, D + 3]) bp.set(x, floorY + 1, Z1 + 1, p.fence);
  });

  bp.part('hatch', () => {
    // a ladder from the walk port up through the floor, on a post of the frame role
    bp.post(hx, hz + 1, hatch.at[1], floorY - 1);
    bp.ladder(hx, hz, hatch.at[1], floorY, 'north');
  });

  bp.part('openings', () => {
    bp.door(D, floorY + 1, Z1, 'south');
    for (const x of [X0 + 2, X1 - 2]) bp.window(x, floorY + 2, Z1, x, floorY + 2, Z1);
    for (const x of [X0, X1]) bp.window(x, floorY + 2, Z0 + 2, x, floorY + 2, Z0 + 3);
  });

  bp.part('furnishings', () => {
    bp.bed(X0 + 1, floorY + 1, Z0 + 1, 'north', 'red');
    bp.chair(X1 - 1, floorY + 1, Z0 + 1, 'south');
    bp.ceilingLights(X0 + 1, Z0 + 1, X1 - 1, Z1 - 1, roofY - 1, { spacing: 6 });
  });

  bp.port(hatch.name, 'architect:walk', ...hatch.at, 'down');
  bp.spot('entrance', D, Z1 + 1, 180, { y: floorY + 1 });
  bp.spot('spawn', D + 1, Z1 + 1, 180, { y: floorY + 1 });
  bp.camera('overview', [X0 - 8, roofY + 4, Z1 + 14], [(X0 + X1) / 2, floorY, (Z0 + Z1) / 2]);
  return bp;
}
