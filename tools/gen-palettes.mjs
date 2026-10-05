#!/usr/bin/env node
// Exports the kit's palettes for the mod's Variants dialog (docs/CONTRACT.md "Variants…": preset chips plus advanced
// wood/stone/roof/accent dropdowns "from the kit's lists"). The mod's Gradle build runs it and bundles the result as
// assets/architect_mc/palettes.json; the mod prefers a sidecar snapshot.palettes when one is sent.
//
//   node tools/gen-palettes.mjs [--kit <kitDir>] [--out <file>]     (default: ../kit, stdout)
//
// Output: {"presets": {"<name>": {wood, stone, roof, accent}}, "woods": [...], "stones": [...], "roofs": [...]}.
// Preset inputs are read from each PALETTES entry (wood/stoneName/roofName/accentWood, or an `inputs` object if the kit
// records one); the stone and roof lists are candidates that the kit's palette() accepts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const kitDir = path.resolve(opt('kit', path.join(here, '..', 'kit')));
const out = opt('out', null);

const kit = await import(pathToFileURL(path.join(kitDir, 'lib', 'kit.mjs')).href);
const { PALETTES, WOODS, palette } = kit;
if (!PALETTES || typeof palette !== 'function') throw new Error(`${kitDir}/lib/kit.mjs exports no PALETTES / palette()`);

const strip = (s) => (typeof s === 'string' ? s.replace(/^minecraft:/, '') : undefined);
const presets = {};
for (const [name, p] of Object.entries(PALETTES)) {
  const src = p.inputs && typeof p.inputs === 'object' ? p.inputs : p;
  presets[name] = {
    wood: strip(src.wood),
    stone: strip(src.stoneName ?? src.stone),
    roof: strip(src.roofName ?? src.roof),
    accent: strip(src.accentWood ?? src.accent),
  };
}

const ok = (o) => {
  try {
    palette(o);
    return true;
  } catch {
    return false;
  }
};
const STONES = ['cobblestone', 'mossy_cobblestone', 'stone', 'stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'smooth_stone',
  'andesite', 'polished_andesite', 'diorite', 'polished_diorite', 'granite', 'polished_granite', 'cobbled_deepslate', 'polished_deepslate',
  'deepslate_bricks', 'deepslate_tiles', 'tuff', 'polished_tuff', 'tuff_bricks', 'bricks', 'mud_bricks', 'sandstone', 'smooth_sandstone',
  'cut_sandstone', 'red_sandstone', 'smooth_red_sandstone', 'blackstone', 'polished_blackstone', 'polished_blackstone_bricks', 'nether_bricks',
  'red_nether_bricks', 'end_stone_bricks', 'prismarine', 'prismarine_bricks', 'quartz_block', 'purpur_block', 'resin_bricks'];
const ROOF_BLOCKS = ['deepslate_tiles', 'deepslate_bricks', 'cobbled_deepslate', 'bricks', 'mud_bricks', 'stone_bricks', 'mossy_stone_bricks',
  'cobblestone', 'mossy_cobblestone', 'smooth_sandstone', 'red_sandstone', 'blackstone', 'polished_blackstone_bricks', 'nether_bricks',
  'red_nether_bricks', 'prismarine_bricks', 'dark_prismarine', 'end_stone_bricks', 'quartz_block', 'purpur_block', 'cut_copper', 'tuff_bricks',
  'resin_bricks'];
const woods = (WOODS ?? []).filter((w) => ok({ wood: w }));
const stones = STONES.filter((s) => ok({ stone: s }));
const roofs = [...woods, ...ROOF_BLOCKS].filter((r) => ok({ roof: r }));
for (const p of Object.values(presets)) {
  if (p.stone && !stones.includes(p.stone)) stones.push(p.stone);
  if (p.roof && !roofs.includes(p.roof)) roofs.push(p.roof);
}

const json = JSON.stringify({ presets, woods, stones, roofs}, null, 2) + '\n';
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, json);
  console.error(`gen-palettes: ${Object.keys(presets).length} presets, ${woods.length} woods, ${stones.length} stones, ${roofs.length} roofs -> ${out}`);
} else {
  process.stdout.write(json);
}
