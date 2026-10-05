#!/usr/bin/env node
// Writes the survival equivalence table (docs/CONTRACT.md phase 3 "Equivalents") to
// mod/src/main/resources/data/architect_mc/equivalents.json. Curated, ONE WAY ONLY (raw -> processed), at vanilla yields:
//   - crafting: 1 log / wood / stem / hyphae (stripped too) = 4 planks; 1 bamboo block = 2 bamboo planks; 1 planks = 2 slabs
//   - stonecutter: 1 stone-family block = 2 slabs / 1 stairs / 1 wall / 1 of the next block in its family (stone -> stone
//     bricks -> ...); chains are followed by the mod (stone -> stone bricks -> stone brick slab x2 = the stonecutter's yield)
// Nothing converts back, nothing skips smelting (cobblestone never becomes stone), no fractional yields (stairs from planks,
// panes, carpets are left out). Every id is checked against the kit's 26.3 block table.
//
//   node tools/gen-equivalents.mjs [--check]     (--check: exit 1 when the file on disk differs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'mod', 'src', 'main', 'resources', 'data', 'architect_mc', 'equivalents.json');
const { BLOCKS } = await import(pathToFileURL(path.join(here, '..', 'kit', 'lib', 'blocks.mjs')).href);

const rules = [];
const mc = (id) => `minecraft:${id}`;
const rule = (from, to, y) => rules.push({ from: mc(from), to: mc(to), yield: y });

// ---- wood (crafting)
for (const w of ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']) {
  for (const log of [`${w}_log`, `${w}_wood`, `stripped_${w}_log`, `stripped_${w}_wood`]) rule(log, `${w}_planks`, 4);
  rule(`${w}_planks`, `${w}_slab`, 2);
}
for (const w of ['crimson', 'warped']) {
  for (const log of [`${w}_stem`, `${w}_hyphae`, `stripped_${w}_stem`, `stripped_${w}_hyphae`]) rule(log, `${w}_planks`, 4);
  rule(`${w}_planks`, `${w}_slab`, 2);
}
rule('bamboo_block', 'bamboo_planks', 2);
rule('stripped_bamboo_block', 'bamboo_planks', 2);
rule('bamboo_planks', 'bamboo_slab', 2);

// ---- stone families (stonecutter: slab x2, stairs x1, wall x1, next block x1)
/** base block, its slab/stairs/wall prefix (null = none), and the blocks the stonecutter makes 1:1 from it */
const fam = (base, prefix, { wall = true, stairs = true, slab = true, makes = [] } = {}) => {
  if (prefix) {
    if (slab) rule(base, `${prefix}_slab`, 2);
    if (stairs) rule(base, `${prefix}_stairs`, 1);
    if (wall) rule(base, `${prefix}_wall`, 1);
  }
  for (const m of makes) rule(base, m, 1);
};
fam('stone', 'stone', { wall: false, makes: ['stone_bricks'] });
fam('stone_bricks', 'stone_brick', { makes: ['chiseled_stone_bricks'] });
fam('cobblestone', 'cobblestone');
fam('mossy_cobblestone', 'mossy_cobblestone');
fam('mossy_stone_bricks', 'mossy_stone_brick');
fam('smooth_stone', 'smooth_stone', { wall: false, stairs: false });
for (const s of ['', 'red_']) {
  fam(`${s}sandstone`, `${s}sandstone`, { makes: [`cut_${s}sandstone`, `chiseled_${s}sandstone`] });
  fam(`cut_${s}sandstone`, `cut_${s}sandstone`, { wall: false, stairs: false });
  fam(`smooth_${s}sandstone`, `smooth_${s}sandstone`, { wall: false });
}
for (const s of ['granite', 'diorite', 'andesite']) {
  fam(s, s, { makes: [`polished_${s}`] });
  fam(`polished_${s}`, `polished_${s}`, { wall: false });
}
fam('cobbled_deepslate', 'cobbled_deepslate', { makes: ['polished_deepslate', 'deepslate_bricks', 'deepslate_tiles', 'chiseled_deepslate'] });
fam('polished_deepslate', 'polished_deepslate', { makes: ['deepslate_bricks', 'deepslate_tiles'] });
fam('deepslate_bricks', 'deepslate_brick', { makes: ['deepslate_tiles'] });
fam('deepslate_tiles', 'deepslate_tile');
fam('bricks', 'brick');
fam('mud_bricks', 'mud_brick');
fam('blackstone', 'blackstone', { makes: ['polished_blackstone', 'polished_blackstone_bricks', 'chiseled_polished_blackstone'] });
fam('polished_blackstone', 'polished_blackstone', { makes: ['polished_blackstone_bricks', 'chiseled_polished_blackstone'] });
fam('polished_blackstone_bricks', 'polished_blackstone_brick');
fam('nether_bricks', 'nether_brick', { makes: ['chiseled_nether_bricks'] });
fam('red_nether_bricks', 'red_nether_brick');
fam('quartz_block', 'quartz', { wall: false, makes: ['quartz_bricks', 'quartz_pillar', 'chiseled_quartz_block'] });
fam('smooth_quartz', 'smooth_quartz', { wall: false });
fam('prismarine', 'prismarine');
fam('prismarine_bricks', 'prismarine_brick', { wall: false });
fam('dark_prismarine', 'dark_prismarine', { wall: false });
fam('purpur_block', 'purpur', { wall: false, makes: ['purpur_pillar'] });
fam('end_stone', null, { makes: ['end_stone_bricks'] });
fam('end_stone_bricks', 'end_stone_brick');
fam('tuff', 'tuff', { makes: ['polished_tuff', 'tuff_bricks', 'chiseled_tuff'] });
fam('polished_tuff', 'polished_tuff', { makes: ['tuff_bricks', 'chiseled_tuff_bricks'] });
fam('tuff_bricks', 'tuff_brick', { makes: ['chiseled_tuff_bricks'] });
fam('resin_bricks', 'resin_brick', { makes: ['chiseled_resin_bricks'] });

const bad = rules.flatMap((r) => [r.from, r.to]).filter((id) => !BLOCKS[id]);
if (bad.length) {
  console.error(`unknown ids: ${[...new Set(bad)].join(', ')}`);
  process.exit(1);
}
const seen = new Set();
for (const r of rules) {
  const k = `${r.from}>${r.to}`;
  if (seen.has(k)) throw new Error(`duplicate rule ${k}`);
  seen.add(k);
}
const json = JSON.stringify({
  _comment: 'GENERATED by tools/gen-equivalents.mjs: one way only (raw -> processed), vanilla crafting/stonecutter yields. Edit the script, not this file.',
  rules,
}, null, 1) + '\n';
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (cur !== json) {
    console.error(`${out} is stale: run node tools/gen-equivalents.mjs`);
    process.exit(1);
  }
  console.log(`equivalents: ${rules.length} rules, up to date`);
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, json);
  console.log(`wrote ${rules.length} rules to ${path.relative(process.cwd(), out)}`);
}
