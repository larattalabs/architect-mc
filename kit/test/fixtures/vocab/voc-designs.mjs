// (6c VOC-b) The four VOC designs (docs/CONTRACT.md "Phase 6c slice VOC" §8 "Designs"), each in its style bible, and the broken twins
// of the building rules. Plain kit blueprints (lib/kit.mjs), deterministic, built from a bible's palette: the gate checks them in the kit
// (item 6), installs voc_tower and voc_copper_hall as the library entries v50's lots bind (item 8), places voc_shrine and voc_copper_hall in
// survival (item 11) and shoots all four (item 15).
//
//   voc_tower        g6cvoc_modern: a white-concrete tower, black-glass window bands, a light-grey roof
//   voc_shrine       g6cvoc_modern: one beacon on an iron base, in a small white room (its bible allows one precious cell)
//   voc_tent         g6cvoc_modern: a wool tent in four colours (the coherence twin: four colours, the bible names three)
//   voc_copper_hall  g6cvoc_copper: unwaxed copper walls (they weather: metrics.drift), a cut copper roof, lit copper bulbs
//
// Every design is one room with a door on the south front, an approach of 4 rows and an entrance and spawn on it (what fitToLot measures:
// the footprint includes the approach), lit inside.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blueprint, palette } from '../../../lib/kit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIBLES = path.resolve(HERE, '..', '..', '..', '..', 'scenarios', 'bibles');

/** A scenario bible (scenarios/bibles/<name>.json) with its id. */
export function vocBible(name) {
  return { id: name, version: 1, ...JSON.parse(fs.readFileSync(path.join(BIBLES, `${name}.json`), 'utf8')) };
}

/** The bible each design is checked against (its twin without `rarity`: `${bible}_free`). */
export const DESIGN_BIBLE = Object.freeze({ voc_tower: 'g6cvoc_modern', voc_shrine: 'g6cvoc_modern', voc_tent: 'g6cvoc_modern', voc_copper_hall: 'g6cvoc_copper' });

/** A one-room shell: walls x 0..X, z 0..Z, floor y 0, ceiling y H; a door on the south wall; the approach rows z Z+1..Z+4. */
function shell(bp, p, { X, Z, H, wall = p.wall, floor = p.floor, ceiling = p.roofBlock ?? p.wall, corners = p.frame }) {
  bp.part('main', () => {
    bp.room([0, 0, 0, X, H, Z], { wall, floor, ceiling, corners });
  });
  bp.part('openings', () => {
    bp.door(Math.floor(X / 2), 1, Z, 'south');
    bp.ceilingLights(1, 1, X - 1, Z - 1, H - 1, { spacing: 5 });
  });
  bp.part('approach', () => {
    bp.floor(Math.floor(X / 2) - 1, Z + 1, Math.floor(X / 2) + 1, Z + 4, 0, p.path);
  });
  bp.spot('entrance', Math.floor(X / 2), Z + 1, 180);
  bp.spot('spawn', Math.floor(X / 2), Z + 3, 180);
}

const base = (id, name, size, p, extra = {}) => new Blueprint({ id, name, description: name, type: 'custom', profile: ['door', 'lit'], size, origin: [0, 0, 0], groundY: 1, front: 'south', palette: p, approach: false, ...extra });

/** voc_tower: 7 x 7, 13 tall; three black-glass window bands. */
export function vocTower(bible = vocBible('g6cvoc_modern')) {
  const p = palette({ bible });
  const X = 6, Z = 6, H = 12;
  const bp = base('voc_tower', 'VOC Tower', [X + 1, H + 1, Z + 5], p, { interior: [1, 1, 1, X - 1, H - 1, Z - 1] });
  shell(bp, p, { X, Z, H, ceiling: p.trim });
  bp.part('windows', () => {
    for (const y of [3, 6, 9]) {
      for (let x = 1; x < X; x++) { bp.set(x, y, 0, p.glass); if (y > 3) bp.set(x, y, Z, p.glass); }
      for (let z = 1; z < Z; z++) { bp.set(0, y, z, p.glass); bp.set(X, y, z, p.glass); }
    }
  });
  return bp;
}

/** voc_shrine: 5 x 5, 6 tall; an iron base under one beacon. */
export function vocShrine(bible = vocBible('g6cvoc_modern'), { beacons = 1, floor = null } = {}) {
  const p = palette({ bible });
  const X = 4, Z = 4, H = 5;
  const bp = base('voc_shrine', 'VOC Shrine', [X + 1, H + 1, Z + 5], p, { interior: [1, 1, 1, X - 1, H - 1, Z - 1] });
  shell(bp, p, { X, Z, H, ceiling: p.trim, ...(floor ? { floor } : {}) });
  bp.part('altar', () => {
    bp.set(2, 1, 1, 'minecraft:iron_block');
    for (let i = 0; i < beacons; i++) bp.set(2 + (i % 2), 2 + Math.floor(i / 2), 1, 'minecraft:beacon');
  });
  return bp;
}

/** voc_tent: 7 x 5, 5 tall; walls in four wool colours. */
export function vocTent(bible = vocBible('g6cvoc_modern'), { colours = ['white', 'red', 'blue', 'yellow'] } = {}) {
  const p = palette({ bible });
  const X = 6, Z = 4, H = 4;
  const bp = base('voc_tent', 'VOC Tent', [X + 1, H + 1, Z + 5], p, { interior: [1, 1, 1, X - 1, H - 1, Z - 1] });
  shell(bp, p, { X, Z, H, wall: `minecraft:${colours[0]}_wool`, ceiling: `minecraft:${colours[1]}_wool`, corners: `minecraft:${colours[2]}_wool` });
  bp.part('stripes', () => {
    for (let x = 1; x < X; x += 2) for (let y = 1; y < H; y++) { bp.set(x, y, 0, `minecraft:${colours[3]}_wool`); }
  });
  return bp;
}

/** voc_copper_hall: 9 x 7, 6 tall; unwaxed copper walls, a cut copper ceiling, lit copper bulbs on the walls. */
export function vocCopperHall(bible = vocBible('g6cvoc_copper')) {
  const p = palette({ bible });
  const X = 8, Z = 6, H = 5;
  const bp = base('voc_copper_hall', 'VOC Copper Hall', [X + 1, H + 1, Z + 5], p, { interior: [1, 1, 1, X - 1, H - 1, Z - 1] });
  shell(bp, p, { X, Z, H, wall: 'minecraft:copper_block', ceiling: 'minecraft:cut_copper', corners: 'minecraft:waxed_cut_copper' });
  bp.part('bulbs', () => {
    for (const x of [2, X - 2]) bp.set(x, 3, 0, 'minecraft:copper_bulb', { lit: 'true', powered: 'false' });
    bp.set(0, 3, 3, 'minecraft:copper_bulb', { lit: 'true', powered: 'false' });
    bp.set(X, 3, 3, 'minecraft:copper_bulb', { lit: 'true', powered: 'false' });
    for (const x of [2, X - 2]) bp.set(x, 2, Z, 'minecraft:glass');
  });
  return bp;
}

/** The four designs by id. */
export const DESIGNS = Object.freeze({ voc_tower: vocTower, voc_shrine: vocShrine, voc_tent: vocTent, voc_copper_hall: vocCopperHall });

/**
 * The building rules' broken twins (§8 "Broken variants", the building ones), each with the rule that must catch it: `state`, `hazard`
 * (errors), `rarity`, `coherence` (warnings with the opted-in bible; metrics.rarity.over with its twin).
 */
export const BROKEN = Object.freeze({
  '_unsafe.waterloggedAir': { rule: 'state', make: () => { const bp = vocTower(); bp.part('main', () => bp.set(1, 1, 1, 'minecraft:light_gray_concrete_slab', { type: 'bottom', waterlogged: 'true' })); return bp; } },
  '_unsafe.halfDoor': { rule: 'state', make: () => { const bp = vocTower(); bp.part('main', () => bp.set(3, 2, 6, 'minecraft:white_concrete')); return bp; } },
  '_unsafe.powderByMoat': { rule: 'hazard', make: () => { const bp = vocTower(); bp.part('approach', () => { bp.set(1, 0, 9, 'minecraft:water'); bp.set(2, 0, 9, 'minecraft:white_concrete_powder'); }); return bp; } },
  '_unsafe.spongeByPond': { rule: 'hazard', make: () => { const bp = vocTower(); bp.part('approach', () => { bp.set(1, 0, 10, 'minecraft:water'); bp.set(5, 0, 10, 'minecraft:sponge'); }); return bp; } },
  '_unsafe.fireByPlanks': { rule: 'hazard', make: () => { const bp = vocCopperHall(); bp.part('main', () => { bp.set(1, 1, 1, 'minecraft:netherrack'); bp.set(1, 2, 1, 'minecraft:fire', { age: '0', east: 'false', north: 'false', south: 'false', up: 'false', west: 'false' }); bp.set(3, 1, 1, 'minecraft:oak_planks'); }); return bp; } },
  '_unsafe.overRare': { rule: 'rarity', bible: 'g6cvoc_modern', make: () => { const bp = vocTower(); bp.part('main', () => { for (let y = 1; y <= 11; y++) for (const x of [1, 5]) bp.set(x, y, 0, 'minecraft:gold_block'); }); return bp; } },
  '_unsafe.fiveColours': { rule: 'coherence', bible: 'g6cvoc_modern', make: () => { const bp = vocTent(); bp.part('stripes', () => bp.set(1, 2, 4, 'minecraft:lime_wool')); return bp; } },
  '_unsafe.diamondFloor': { rule: 'rarity', bible: 'g6cvoc_modern', make: () => vocShrine(vocBible('g6cvoc_modern'), { floor: 'minecraft:diamond_block' }) },
});
