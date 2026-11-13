// (7c TC, docs/CONTRACT.md "Phase 7c", "Slice TC as built") The words the sim backend's stand-in pick matches against a brief, per
// catalogue program (sidecar/src/regiondesign.ts simPick). Never shown to the model. Kept out of the program files so a program's
// source (its programSha, and the IR shas and goldens that record it) moves only when the program does.
export const PICK_KEYWORDS = Object.freeze({
  crater_works: ['crater', 'meteor', 'pit', 'mine', 'mining', 'quarry', 'bowl', 'lair', 'facility', 'excavation'],
  flat_village: ['village', 'hamlet', 'farm', 'farming', 'street', 'square', 'flat', 'plains', 'meadow', 'cottage', 'cottages', 'villagers', 'town'],
  floating_islands: ['floating', 'islands', 'island', 'sky', 'skies', 'hamlet', 'clouds', 'flying', 'airborne', 'archipelago'],
  ice_outpost: ['ice', 'spikes', 'spike', 'frozen', 'snow', 'snowy', 'tundra', 'frontier', 'outpost', 'camp', 'arctic', 'glacier', 'polar'],
  rift_city: ['rift', 'chasm', 'canyon', 'gorge', 'ravine', 'gully', 'cleft', 'ledges', 'walls'],
  s5_treehouses: ['treehouse', 'treehouses', 'tree', 'trees', 'treetop', 'treetops', 'canopy', 'crowns', 'crown', 'giant', 'branches', 'forest', 'grove'],
  s6_cave_city: ['cave', 'caves', 'cavern', 'underground', 'carved', 'mountain', 'dwarf', 'dwarven', 'hold', 'subterranean', 'inside', 'beneath', 'mine'],
  sky_isle: ['sky', 'citadel', 'castle', 'fortress', 'aerie', 'floating', 'rock', 'great', 'single'],
  terraced_monastery: ['monastery', 'abbey', 'temple', 'monks', 'monk', 'cloister', 'hermitage', 'shrine', 'terraced', 'terraces', 'mountainside', 'cliff', 'slope'],
  walled_hill: ['walled', 'wall', 'walls', 'hill', 'hilltop', 'fortified', 'castle', 'ramparts', 'town'],
});
