// Test fixture: `node kit/tools/bible.mjs builtin` prints the built-in bibles (the real kit's palette presets).
const roles = (wood, stone, roof) => ({ wall: `minecraft:${wood}_planks`, wall_alt: `minecraft:stripped_${wood}_log`, trim: `minecraft:${stone}`, roof: `minecraft:${roof}_planks`, floor: `minecraft:${wood}_planks`, frame: `minecraft:${wood}_log`, accent: `minecraft:${roof}_planks`, light: 'minecraft:lantern', glass: 'minecraft:glass_pane', foundation: `minecraft:${stone}`, path: 'minecraft:dirt_path' });
if (process.argv[2] !== 'builtin') {
  console.error('usage: node kit/tools/bible.mjs builtin');
  process.exit(2);
}
console.log(
  JSON.stringify({
    bibles: [
      { id: 'rustic', name: 'Rustic', version: 1, scope: 'building', roles: roles('spruce', 'cobblestone', 'dark_oak') },
      { id: 'birch', name: 'Birch', version: 1, scope: 'building', roles: roles('birch', 'polished_andesite', 'dark_oak') },
    ],
  }),
);
