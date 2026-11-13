// Castle (7c CM-a): the hand-written composite, 121 long, past the 96 cap. Three modules of one long fortified hall, each 41 x 15 x 27
// (within the cap), side by side on x and sharing a seam layer: the west and east cross walls of the centre module are the east wall of
// the west module and the west wall of the east module (x = 40 and x = 80 in the union). An arch 3 wide and 4 tall runs through each
// seam wall: a joint (`architect:joint`) on each side, joined in the composite.
//
//   union x ->  0      6 .......... 40 ......... 80 .......... 114   120
//   z=0..6      [tower]                                          [tower]       solid stone towers at the four outer corners
//   z=2         north wall, windows, crenellated parapet (crenels on even union x)
//   z=11..13    ...... arch ........ arch ......                               the joints (rows 1..4)
//   z=17..22                  [gate tower x 56..64]                            over the front door (union x 60)
//   z=22        south wall (front), the door at union x 60
//   z=23..26    the approach: entrance (60, 1, 24), spawn (60, 1, 25)
//
// Rows: y0 the ground (stone under the hall, the palette's path outside), y1..7 the hall, y8 the roof deck, y9 the parapet, y10 the
// crenels; the corner towers rise to row 13 with crenels on 14, the gate tower to row 12 with crenels on 13. The hall is lit by
// hanging lanterns every 4 cells (union x = 2 mod 4, never on a seam) in three rows. Every pattern is laid out in union coordinates, so
// the cells both modules write on a seam agree. Every material comes from the palette.
import { Blueprint, PALETTES } from '../../lib/kit.mjs';
import { Composite, joint } from '../../lib/composite.mjs';

export const id = 'castle';

const W = 41; // a module's width (x); neighbours share its last column
const D = 27; // depth (z)
const H = 15; // height (y)
const ZN = 2; // the north wall
const ZS = 22; // the south (front) wall
/** The union's checker rules: the defaults plus the roof, the floors reached through the arches and the interior written. */
const PROFILE = ['door', 'roof_closed', 'floors_reachable', 'lit', 'interior', 'no_floating'];
const ARCH = { z: 11, y: 1, width: 3, height: 4 };

/** One module of the hall; `ox` its union x. */
function section(p, { name, ox, westEnd = false, eastEnd = false, gate = false, west = null, east = null }) {
  const X = W - 1;
  const bp = new Blueprint({
    id: `castle_${name}`,
    name: `Castle (${name})`,
    type: 'castle',
    size: [W, H, D],
    groundY: 1,
    front: 'south',
    palette: p,
    interior: [1, 1, ZN + 1, X - 1, 7, ZS - 1],
  });
  const even = (x) => (x + ox) % 2 === 0;

  bp.part('hall', () => {
    bp.floor(0, 0, X, D - 1, 0, p.path);
    bp.floor(0, ZN, X, ZS, 0, p.stone);
    bp.floor(1, ZN + 1, X - 1, ZS - 1, 0, p.planks);
    bp.walls(0, ZN, X, ZS, 1, 7, { block: p.stone, corners: p.stone });
    bp.carve([1, 1, ZN + 1, X - 1, 7, ZS - 1]); // the hall's air, written so placement clears it
    // the arches through the seam walls
    for (const x of [west ? 0 : null, east ? X : null]) {
      if (x === null) continue;
      bp.carve([x, ARCH.y, ARCH.z, x, ARCH.y + ARCH.height - 1, ARCH.z + ARCH.width - 1]);
    }
  });

  bp.part('roof', () => {
    bp.floor(0, ZN, X, ZS, 8, p.stone);
    for (let x = 0; x <= X; x++) {
      for (const z of [ZN, ZS]) {
        bp.set(x, 9, z, p.stone);
        if (even(x)) bp.set(x, 10, z, p.stone);
      }
    }
    for (const [x, on] of [[0, westEnd], [X, eastEnd]]) {
      if (!on) continue;
      for (let z = ZN; z <= ZS; z++) {
        bp.set(x, 9, z, p.stone);
        if (z % 2 === 0) bp.set(x, 10, z, p.stone);
      }
    }
  }, { roof: 'flat' });

  if (westEnd || eastEnd || gate) {
    bp.part('towers', () => {
      const tower = (x0, z0, x1, z1, top) => {
        bp.fill([x0, 1, z0, x1, top, z1], p.stone);
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
          const edge = x === x0 || x === x1 || z === z0 || z === z1;
          if (edge && (x + ox + z) % 2 === 0) bp.set(x, top + 1, z, p.stone);
        }
      };
      if (westEnd) { tower(0, 0, 6, 6, 13); tower(0, 18, 6, 24, 13); }
      if (eastEnd) { tower(X - 6, 0, X, 6, 13); tower(X - 6, 18, X, 24, 13); }
      if (gate) {
        bp.fill([16, 9, 17, 24, 12, ZS], p.stone);
        for (let x = 16; x <= 24; x++) for (let z = 17; z <= ZS; z++) {
          const edge = x === 16 || x === 24 || z === 17 || z === ZS;
          if (edge && (x + ox + z) % 2 === 0) bp.set(x, 13, z, p.stone);
        }
      }
    });
  }

  bp.part('openings', () => {
    // windows on the long walls (union x = 3 mod 6, clear of the towers and the seams)
    for (let x = 1; x < X; x++) {
      if ((x + ox) % 6 !== 3) continue;
      for (const z of [ZN, ZS]) {
        if ((westEnd && x <= 6) || (eastEnd && x >= X - 6) || (gate && z === ZS && x >= 16 && x <= 24)) continue;
        for (let y = 3; y <= 5; y++) bp.set(x, y, z, p.pane);
      }
    }
    // hanging lanterns from the deck (union x = 2 mod 4), three rows
    for (let x = 1; x < X; x++) {
      if ((x + ox) % 4 !== 2) continue;
      for (const z of [6, 12, 18]) {
        const inTower = (z <= 6 || z >= 18) && ((westEnd && x <= 6) || (eastEnd && x >= X - 6));
        if (!inTower) bp.lantern(x, 7, z, true);
      }
    }
    if (gate) {
      bp.door(20, 1, ZS, 'south');
      bp.spot('entrance', 20, 24, 0);
      bp.spot('spawn', 20, 25, 0);
    }
  });

  if (west) joint(bp, west, 0, ARCH.y, ARCH.z, 'west', { width: ARCH.width, height: ARCH.height });
  if (east) joint(bp, east, X, ARCH.y, ARCH.z, 'east', { width: ARCH.width, height: ARCH.height });
  return bp;
}

/** The castle composite (the palette's roles; default the fortress preset). */
export default function build({ palette: p = PALETTES.fortress } = {}) {
  const c = new Composite({
    id,
    name: 'Castle',
    description: 'A long fortified hall past the template cap: three modules joined by arches, corner towers and a gate tower over the door.',
    type: 'castle',
    profile: PROFILE,
    tags: ['medieval', 'stone', 'fortification', 'composite'],
    front: 'south',
    palette: p,
  });
  c.module('west', section(p, { name: 'west', ox: 0, westEnd: true, east: 'arch_e' }), { at: [0, 0, 0] });
  c.module('centre', section(p, { name: 'centre', ox: 40, gate: true, west: 'arch_w', east: 'arch_e' }), { at: [40, 0, 0] });
  c.module('east', section(p, { name: 'east', ox: 80, eastEnd: true, west: 'arch_w' }), { at: [80, 0, 0] });
  c.join('west.arch_e', 'centre.arch_w');
  c.join('centre.arch_e', 'east.arch_w');
  return c;
}
