// (6c F2) The first stamp library (docs/CONTRACT.md 6c F2 §4): the vanilla features the harvester captures and their ground
// templates (DevBridge dev.feature.stamp: a mycelium or grass pad, a stone mass, a stone cave pocket). Shared by
// tools/harvest-stamps.mjs and tools/gate6cf2.mjs. The harvested stamps are local-only (Noah, N-F2-1).
export const LIBRARY = Object.freeze([
  { feature: 'minecraft:huge_brown_mushroom', ground: 'mycelium' },
  { feature: 'minecraft:huge_red_mushroom', ground: 'mycelium' },
  { feature: 'minecraft:dripstone_cluster', ground: 'cave' },
  { feature: 'minecraft:fossil_coal', ground: 'stone' },
  { feature: 'minecraft:oak', ground: 'grass_block' },
  { feature: 'minecraft:birch', ground: 'grass_block' },
  { feature: 'minecraft:spruce', ground: 'grass_block' },
  { feature: 'minecraft:acacia', ground: 'grass_block' },
  { feature: 'minecraft:dark_oak', ground: 'grass_block' },
]);
/** Seeds per feature (CONTRACT F2 §4: 8 each). */
export const SEEDS = 8;
