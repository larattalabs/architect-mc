// (6c close-out B, PLAN "Queued from slice S3": the kit's volume classes vs the mod's natural rule) The kit's write conditions over every
// block of kit/lib/blocks.mjs (each block's default state through the virtual world's Palette: IF_NATURAL is `natural`, IF_SOLID_NATURAL
// natural, not air, not a fluid, solid). The mod's CellCond.passes must agree block for block (mod NaturalDriftTest reads this fixture,
// as MaskPatternDriftTest reads kit/test/fixtures/mp). This test keeps the fixture current: NATURAL_DRIFT_WRITE=1 rewrites it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCKS, tagBlocks, voxelClassOf } from '../lib/blocks.mjs';
import { Palette } from '../lib/region/vworld.mjs';

// the tags the mod's rule reads (TerrainFit.flags and TerrainFit.natural); a tag added there must be added here
export const MOD_TAGS = Object.freeze(['minecraft:substrate_overworld', 'minecraft:dirt', 'minecraft:sand', 'minecraft:base_stone_overworld', 'minecraft:base_stone_nether',
  'minecraft:flowers', 'minecraft:saplings', 'minecraft:snow', 'minecraft:ores', 'minecraft:leaves', 'minecraft:logs', 'minecraft:terracotta',
  'minecraft:coral_blocks', 'minecraft:crops', 'minecraft:cave_vines']);
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'natural', 'conds.json');

export function rows() {
  const pal = new Palette();
  const out = [];
  for (const id of Object.keys(BLOCKS).sort()) {
    const i = pal.of(id);
    const natural = pal.natural[i];
    out.push({ id, v: pal.air[i] ? 'AIR' : voxelClassOf(id), natural, solidNatural: natural && !pal.air[i] && !pal.fluid[i] && pal.solid[i] });
  }
  return out;
}

test('the kit write conditions per block equal fixtures/natural/conds.json (the mod NaturalDriftTest reads it)', () => {
  // the vanilla block tags (blocks.mjs, from the 26.3 data pack): a unit test has no data pack, so the mod test binds these first
  const tags = Object.fromEntries(MOD_TAGS.map((t) => [t, tagBlocks(t)]));
  const now = `${JSON.stringify({ note: 'kit/test/natural-drift.test.mjs: each block default state, the kit IF_NATURAL and IF_SOLID_NATURAL; the vanilla block tags', tags, blocks: rows() }, null, 0).replaceAll('},{', '},\n{').replaceAll('],"', '],\n"')}\n`;
  if (process.env.NATURAL_DRIFT_WRITE === '1') fs.writeFileSync(FILE, now);
  assert.equal(fs.readFileSync(FILE, 'utf8'), now, 'the kit natural rule moved: re-run with NATURAL_DRIFT_WRITE=1 and run the mod NaturalDriftTest');
});
