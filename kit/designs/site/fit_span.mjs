// Span house (7b SV, fit span): a gabled house across a rift between two rock rims, built into the 7bF fixture `rift_site`. Its floor
// bears on both rims; joists under it run out from the middle into the rock on either side (beamInto), and a door at each end opens onto
// a landing at the site's walk ports, where the graph arrives on both sides.
import { Blueprint, PALETTES } from '../../lib/kit.mjs';

export const id = 'fit_span';
export const fit = 'span';
export const exampleSite = 'rift_site';

export default function build({ palette = PALETTES.rustic, site } = {}) {
  const p = palette;
  const w = site.port('w'), e = site.port('e'); // the walk ports at the two ends
  const rimW = site.face('east'), rimE = site.face('west'); // the rift's two faces (the west rim faces east)
  const floorY = w.at[1] - 1; // the floor row: the ports' feet stand on it
  const Zm = w.at[2]; // the door row
  const X0 = rimW.at, X1 = rimE.at + 1; // the walls stand on the rims' edges
  const Z0 = Zm - 3, Z1 = Zm + 3;
  const roofY = floorY + 4;
  const bp = new Blueprint({
    id, name: 'Span House', description: 'A gabled house across a rift: its floor bears on both rims and a door at each end meets the walk.',
    type: 'cabin', tags: ['site', 'bridge', 'small'], site, palette: p, groundY: floorY + 1, front: 'west',
    interior: [X0 + 1, floorY + 1, Z0 + 1, X1 - 1, roofY - 1, Z1 - 1],
  });

  bp.part('frame', () => {
    // joists from the middle of the gap out into each rim
    const mid = Math.floor((rimW.at + rimE.at) / 2);
    for (const z of [Z0, Zm, Z1]) {
      bp.beamInto(mid, floorY - 1, z, 'west');
      bp.beamInto(mid + 1, floorY - 1, z, 'east');
    }
  });

  bp.part('main', () => {
    bp.floor(X0, Z0, X1, Z1, floorY, p.floor);
    bp.walls(X0, Z0, X1, Z1, floorY + 1, roofY - 1);
    bp.carve([X0 + 1, floorY + 1, Z0 + 1, X1 - 1, roofY - 1, Z1 - 1]);
    bp.floor(X0 + 1, Z0 + 1, X1 - 1, Z1 - 1, roofY, p.floor); // the ceiling
  });

  bp.part('roof', () => {
    bp.roofGable(X0, Z0, X1, Z1, roofY, { ridge: 'x', pitch: 1 });
  }, { roof: 'gable' });

  bp.part('openings', () => {
    bp.door(X0, floorY + 1, Zm, 'west');
    bp.door(X1, floorY + 1, Zm, 'east');
    for (let x = X0 + 2; x <= X1 - 2; x += 3) for (const z of [Z0, Z1]) bp.window(x, floorY + 2, z, x, floorY + 2, z);
  });

  bp.part('landings', () => {
    // the cells between each door and its port, on the rim
    bp.floor(w.at[0], Zm - 1, X0 - 1, Zm + 1, floorY, p.path);
    bp.floor(X1 + 1, Zm - 1, e.at[0], Zm + 1, floorY, p.path);
  });

  bp.part('furnishings', () => {
    bp.bed(X0 + 1, floorY + 1, Z0 + 1, 'west', 'red');
    bp.chair(X1 - 1, floorY + 1, Z1 - 1, 'north');
    bp.ceilingLights(X0 + 1, Z0 + 1, X1 - 1, Z1 - 1, roofY - 1, { spacing: 5 });
  });

  bp.port(w.name, 'architect:walk', ...w.at, w.facing);
  bp.port(e.name, 'architect:walk', ...e.at, e.facing);
  bp.spot('entrance', X0 - 1, Zm, -90, { y: floorY + 1 });
  bp.spot('spawn', X1 + 1, Zm, 90, { y: floorY + 1 });
  bp.camera('overview', [X0 - 6, roofY + 6, Z1 + 12], [(X0 + X1) / 2, floorY, Zm]);
  return bp;
}
