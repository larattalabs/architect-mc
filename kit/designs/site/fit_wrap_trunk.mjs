// Trunk house (7b SV, fit wrap_trunk): a round room on a ring deck round a giant trunk, built into the 7bF fixture `trunk`. The trunk's
// logs are keep cells (never written: the site's keep-critical cells); the deck hugs the trunk and is braced to it, a balcony rings
// the room, and a walkway runs out west to the site's walk port, where a branch walk arrives.
import { Blueprint, PALETTES } from '../../lib/kit.mjs';

export const id = 'fit_wrap_trunk';
export const fit = 'wrap_trunk';
export const exampleSite = 'trunk';
/** The warnings (rule names) of the template-only check (no composite until SC): the trunk's cells inside the room are site, not template, and only the composite (SC) sees them. kit/tools/examples.mjs holds them exact. */
export const templateOnlyWarnings = ['enclosure', 'interior'];

export default function build({ palette = PALETTES.rustic, site } = {}) {
  const p = palette;
  const t = site.trunk(); // { cx, cz, radiusAt(y), y0, y1 }
  const walk = site.port('w');
  const floorY = walk.at[1] - 1; // the deck row: the port's feet stand on it
  const roofY = floorY + 4;
  const { cx, cz } = t;
  const R_WALL = 6, R_DECK = 7; // the room's wall ring and the balcony's edge (distance from the trunk's axis)
  const d = (x, z) => Math.hypot(x - cx, z - cz);
  const bp = new Blueprint({
    id, name: 'Trunk House', description: 'A round room on a ring deck round a giant trunk, with a balcony and a walkway out to the branch walk.',
    type: 'cabin', tags: ['site', 'tree', 'small'], site, palette: p, groundY: floorY + 1, front: 'west',
    interior: [cx - 3, floorY + 1, cz - 3, cx + 3, roofY - 1, cz + 3],
  });
  bp.keep(site.cellsOf('LOG')); // the host trunk: never written (the site's keep-critical cells are kept already)

  bp.part('deck', () => {
    bp.ringDeck(cx, cz, t.radiusAt(floorY), R_DECK, floorY, { rail: p.fence, brackets: 'trunk', braceLen: Math.min(2, floorY) });
    // the walkway out to the port, and the gap in the rail where it meets the balcony
    for (let x = walk.at[0]; x < cx - R_DECK + 1; x++) for (let z = walk.at[2]; z < walk.at[2] + walk.width; z++) bp.set(x, floorY, z, p.floor);
    for (let z = walk.at[2]; z < walk.at[2] + walk.width; z++) bp.unset(cx - R_DECK, floorY + 1, z);
  });

  bp.part('main', () => {
    for (let x = cx - R_WALL; x <= cx + R_WALL; x++) for (let z = cz - R_WALL; z <= cz + R_WALL; z++) {
      const r = d(x, z);
      if (r > R_WALL + 0.5) continue;
      for (let y = floorY + 1; y < roofY; y++) bp.put(x, y, z, r > R_WALL - 0.5 ? p.wall : 'minecraft:air');
    }
  });

  bp.part('roof', () => {
    bp.ringDeck(cx, cz, 0, R_WALL, roofY, { block: p.roofBlock, rail: p.roofSlab });
  }, { roof: 'flat' });

  bp.part('openings', () => {
    bp.door(cx - R_WALL, floorY + 1, walk.at[2] + 1, 'west');
    for (const [x, z] of [[cx + R_WALL, cz], [cx, cz - R_WALL], [cx, cz + R_WALL]]) bp.window(x, floorY + 2, z, x, floorY + 2, z);
  });

  bp.part('furnishings', () => {
    bp.bed(cx + 3, floorY + 1, cz - 4, 'north', 'red'); // its head against the wall ring
    bp.chair(cx - 3, floorY + 1, cz + 3, 'north');
    for (const [x, z] of [[cx - 3, cz - 3], [cx + 3, cz + 3], [cx - 4, cz], [cx + 4, cz]]) bp.lantern(x, roofY - 1, z, true);
  });

  bp.port(walk.name, 'architect:walk', ...walk.at, walk.facing);
  bp.spot('entrance', cx - R_DECK, walk.at[2] + 1, -90, { y: floorY + 1 });
  bp.spot('spawn', walk.at[0], walk.at[2], -90, { y: floorY + 1 });
  bp.camera('overview', [cx - 14, roofY + 8, cz + 14], [cx, floorY + 2, cz]);
  return bp;
}
