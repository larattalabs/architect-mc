// Carved room (7b SV, fit carve_into): a hall cut into the rock of a hill, built into the 7bF fixture `tunnel_hill`. The rock stays as
// its walls and ceiling (carveRoom writes air only where the site is solid; exposed soil round it is lined with the foundation role);
// the room gets a written floor, and its south face becomes a framed facade (facadeOnFace) with the door at the site's door port and a
// window either side. A step outside the door meets the ground in front of the cut face.
import { Blueprint, PALETTES } from '../../lib/kit.mjs';

export const id = 'fit_carve_into';
export const fit = 'carve_into';
export const exampleSite = 'tunnel_hill';
/** The warnings (rule names) of the template-only check (no composite until SC): the rock is the room's walls and ceiling, and only the composite (SC) sees it. kit/tools/examples.mjs holds them exact. */
export const templateOnlyWarnings = ['enclosure', 'enclosure'];

export const params = {
  depth: { type: 'int', min: 6, max: 10, default: 10, label: 'Depth' },
};

export default function build({ palette = PALETTES.rustic, site, depth = 10 } = {}) {
  const p = palette;
  const face = site.face('south'); // the cut face
  const door = site.port('door_s');
  const Zf = face.at; // the face's row (solid): the facade replaces its surface
  const D = door.at[0]; // the door column
  const floorY = 0; // the floor row; feet on row 1
  const X0 = D - 4, X1 = D + 4, Z0 = Zf - depth, Y1 = floorY + 4;
  const bp = new Blueprint({
    id, name: 'Carved Hall', description: 'A hall cut into the rock of a hill: the rock is its walls and ceiling, the cut face its facade.',
    type: 'cabin', tags: ['site', 'carved', 'small'], site, palette: p, groundY: floorY + 1, front: 'south',
    interior: [X0, floorY + 1, Z0, X1, Y1 - 1, Zf - 1],
  });

  bp.part('room', () => {
    bp.carveRoom([X0, floorY + 1, Z0, X1, Y1, Zf - 1]);
    bp.floor(X0, Z0, X1, Zf - 1, floorY, p.floor);
    // pillars of the frame role along the side walls carry beams under the ceiling (the rock is the roof); lanterns hang from the beams
    for (let z = Z0 + 2; z < Zf - 1; z += 3) {
      for (const x of [X0, X1]) bp.post(x, z, floorY + 1, Y1);
      bp.beam(X0 + 1, Y1, z, X1 - 1, z);
      for (const x of [D - 2, D + 2]) bp.lantern(x, Y1 - 1, z, true); // hanging from the beam
    }
  });

  bp.part('facade', () => {
    // the face round the doorway: the trim role, the door's jambs in the frame role
    bp.facadeOnFace(face, {
      u0: X0 - 1, u1: X1 + 1, y0: floorY, y1: Y1 + 1,
      block: (u, y) => (y === Y1 + 1 || y === floorY ? p.stoneTrim : u === D - 1 || u === D + 1 ? p.frame : p.wall),
    });
    bp.door(D, floorY + 1, Zf, 'south');
    bp.set(D, floorY + 2 + 1, Zf, p.frame); // the lintel over the door
    for (const x of [D - 3, D + 3]) bp.window(x, floorY + 2, Zf, x, floorY + 2, Zf);
    bp.stairs(D, floorY, Zf + 1, 'north', { block: p.stoneStairs }); // the step down to the ground in front
    bp.lantern(D + 2, floorY + 3, Zf + 1);
    bp.set(D + 2, floorY + 2, Zf + 1, p.stoneWall);
    bp.set(D + 2, floorY + 1, Zf + 1, p.stoneWall);
    bp.set(D + 2, floorY, Zf + 1, p.stone);
  });

  bp.part('furnishings', () => {
    bp.bed(X0 + 1, floorY + 1, Zf - 1, 'south', 'red'); // its head against the facade
    bp.chair(X1 - 1, floorY + 1, Z0 + 1, 'south');
  });

  bp.port('door_s', 'door', D, floorY + 1, Zf, 'south');
  bp.spot('entrance', D, Zf + 1, 180, { y: floorY + 1 });
  bp.spot('spawn', D, Zf - 2, 180, { y: floorY + 1 });
  bp.camera('overview', [D - 8, 8, Zf + 14], [D, 2, Zf - 3]);
  return bp;
}
