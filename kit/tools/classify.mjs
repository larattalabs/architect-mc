// Derives the kit's per-block facts from the 26.3 report + BlockDump output, and renders kit/lib/blocks.mjs.
// Pure (no I/O) so tests can feed it fixtures.

/** Java class (anywhere in the chain) -> family. First match along the chain (most specific class first) wins. */
const CLASS_FAMILY = {
  AirBlock: 'air', StructureVoidBlock: 'air', LightBlock: 'air',
  StairBlock: 'stairs', SlabBlock: 'slab', DoorBlock: 'door', TrapDoorBlock: 'trapdoor', FenceGateBlock: 'fence_gate',
  FenceBlock: 'fence', WallBlock: 'wall', IronBarsBlock: 'pane',
  WallTorchBlock: 'wall_torch', RedstoneWallTorchBlock: 'wall_torch', TorchBlock: 'torch', RedstoneTorchBlock: 'torch',
  ButtonBlock: 'button', LeverBlock: 'lever', GrindstoneBlock: 'grindstone',
  LadderBlock: 'ladder', LanternBlock: 'lantern', ChainBlock: 'chain',
  CarpetBlock: 'carpet', MossyCarpetBlock: 'carpet', BasePressurePlateBlock: 'pressure_plate', BaseRailBlock: 'rail',
  RedstoneWireBlock: 'redstone_wire', DiodeBlock: 'diode', CandleBlock: 'candle', CandleCakeBlock: 'cake', CakeBlock: 'cake',
  FlowerPotBlock: 'flower_pot',
  WallSkullBlock: 'wall_skull', SkullBlock: 'skull',
  WallBannerBlock: 'wall_banner', BannerBlock: 'banner',
  WallSignBlock: 'wall_sign', StandingSignBlock: 'sign', CeilingHangingSignBlock: 'hanging_sign', WallHangingSignBlock: 'wall_hanging_sign',
  AbstractBedBlock: 'bed',
  DoublePlantBlock: 'double_plant',
  BaseCoralWallFanBlock: 'wall_fan',
  CocoaBlock: 'cocoa', RodBlock: 'rod', AmethystClusterBlock: 'rod', TripWireHookBlock: 'wall_hook',
  MultifaceBlock: 'multiface', VineBlock: 'multiface',
  GrowingPlantHeadBlock: 'growing_plant', GrowingPlantBodyBlock: 'growing_plant',
  VegetationBlock: 'plant', BaseCoralPlantTypeBlock: 'plant', SugarCaneBlock: 'plant', CactusBlock: 'plant',
  BambooStalkBlock: 'plant', BambooSaplingBlock: 'plant', SnowLayerBlock: 'snow_layer', TripWireBlock: 'plant',
  SporeBlossomBlock: 'ceiling_plant', HangingRootsBlock: 'ceiling_plant', HangingMossBlock: 'ceiling_plant',
  ShelfMushroomBlock: 'wall_hook', ScaffoldingBlock: 'scaffolding', LiquidBlock: 'liquid', BubbleColumnBlock: 'liquid',
  BaseFireBlock: 'fire', TurtleEggBlock: 'plant', FrogspawnBlock: 'plant', SeaPickleBlock: 'plant', SnifferEggBlock: 'block',
  PointedDripstoneBlock: 'speleothem', SpeleothemBlock: 'speleothem',
  GlazedTerracottaBlock: 'block', HalfTransparentBlock: 'block',
};

/** Collision class by family (anything else comes from the default state's collision boxes). */
const FAMILY_COLLISION = {
  stairs: 'stairs', slab: 'slab', door: 'door', trapdoor: 'door', fence_gate: 'door', fence: 'thin', wall: 'thin', pane: 'thin',
  ladder: 'partial', scaffolding: 'partial',
};

export function familyOf(cls) {
  for (const c of cls) if (CLASS_FAMILY[c]) return CLASS_FAMILY[c];
  return 'block';
}

const r4 = (n) => Math.round(n * 10000) / 10000;

/** Coarse collision class from the default state's collision boxes. */
export function collisionFromBoxes(boxes) {
  if (!boxes.length) return 'none';
  if (boxes.length === 1 && boxes[0].join(',') === '0,0,0,1,1,1') return 'full';
  const top = Math.max(...boxes.map((b) => b[4]));
  if (top <= 0.1875) return 'low';
  return 'partial';
}

/** Smallest property subset that determines the emission, as { by: [props], v: { 'a,b': level } } or a constant. */
export function emissionRule(report, emit) {
  if (!emit.length) return 0;
  const states = report.states;
  const key = (s) => JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]]));
  const lvl = new Map(emit.map(([p, l]) => [key(p), l]));
  const levels = states.map((s) => lvl.get(key(s.properties ?? {})) ?? 0);
  if (levels.every((l) => l === levels[0])) return levels[0];
  const names = Object.keys(report.properties ?? {});
  const subsets = [];
  for (let m = 1; m < 1 << names.length; m++) subsets.push(names.filter((_, i) => m & (1 << i)));
  subsets.sort((a, b) => a.length - b.length);
  for (const sub of subsets) {
    const map = new Map();
    let ok = true;
    states.forEach((s, i) => {
      const k = sub.map((n) => s.properties[n]).join(',');
      if (map.has(k) && map.get(k) !== levels[i]) ok = false;
      map.set(k, levels[i]);
    });
    if (ok) return { by: sub, v: Object.fromEntries([...map].filter(([, l]) => l > 0)) };
  }
  throw new Error('emission rule not found');
}

/** One block's derived entry. */
export function classify(id, report, dump) {
  const family = familyOf(dump.cls);
  const props = report.properties ?? {};
  const def = (report.states.find((s) => s.default) ?? report.states[0]).properties ?? {};
  let collision = FAMILY_COLLISION[family] ?? collisionFromBoxes(dump.collision);
  if (family === 'air') collision = 'none';
  const top = dump.collision.length ? r4(Math.max(...dump.collision.map((b) => b[4]))) : 0;
  const optics = family === 'stairs' || family === 'slab' ? 'S' : dump.dampening >= 15 ? 'O' : 'C';
  const e = {
    id, family, collision, props, defaults: def, optics,
    conductor: !!dump.conductor, light: emissionRule(report, dump.emit), item: dump.item, top,
    dampening: dump.dampening,
  };
  return e;
}

const bare = (s) => s.replace(/^minecraft:/, '');

/** Encodes a block's properties as `name=v1|*v2` (the default starred). */
export function encodeProps(props, defaults) {
  return Object.entries(props).map(([k, vals]) => `${k}=${vals.map((v) => (v === defaults[k] ? `*${v}` : v)).join('|')}`).join(' ');
}

/** (6b) The voxel classes in ordinal order (CONTRACT §5, kit/REGIONS.md "ARVX"). */
export const VOXEL_CLASSES = ['AIR', 'ROCK', 'SOIL', 'LOOSE', 'ICE', 'SNOW', 'WATER', 'LAVA', 'LOG', 'LEAVES', 'PLANT', 'OWNED', 'PLAYER', 'BLOCK_ENTITY', 'MISSING'];

/** Worldgen rock outside the stone tags (TerrainFit.natural's tags plus these are ROCK). */
const EXTRA_ROCK = new Set(['calcite', 'dripstone_block', 'smooth_basalt', 'basalt', 'blackstone', 'magma_block', 'obsidian', 'crying_obsidian',
  'bedrock', 'amethyst_block', 'budding_amethyst', 'terracotta', 'end_stone', 'infested_stone', 'infested_cobblestone', 'infested_deepslate',
  'infested_stone_bricks', 'infested_mossy_stone_bricks', 'infested_cracked_stone_bricks', 'infested_chiseled_stone_bricks', 'sandstone',
  'red_sandstone', 'gilded_blackstone', 'soul_soil'].map((x) => `minecraft:${x}`));
const PLANT_FAMILIES = new Set(['plant', 'double_plant', 'growing_plant', 'multiface', 'ceiling_plant', 'cocoa', 'speleothem', 'snow_layer']);

/**
 * (6b) A natural block's voxel class, or null (a block entity, or a block a player builds with: PLAYER at runtime). The
 * rules follow the mod's TerrainFit (natural ground by tags, plants as replaceable, trees by the logs/leaves tags).
 */
export function voxelClassOf(id, dump, tags) {
  const has = (t) => (tags[`minecraft:${t}`] ?? []).includes(id);
  const is = (...names) => names.some((n) => id === `minecraft:${n}`);
  if (is('air', 'cave_air', 'void_air')) return 'AIR';
  if (is('water', 'bubble_column')) return 'WATER';
  if (is('lava')) return 'LAVA';
  if (dump.be) return null;
  if (has('logs') || is('mushroom_stem')) return 'LOG';
  if (has('leaves') || has('wart_blocks') || is('brown_mushroom_block', 'red_mushroom_block', 'shroomlight')) return 'LEAVES';
  if (is('ice', 'packed_ice', 'blue_ice', 'frosted_ice')) return 'ICE';
  if (has('snow') || is('snow_block', 'powder_snow')) return 'SNOW';
  if (has('sand') || is('gravel', 'suspicious_gravel', 'suspicious_sand')) return 'LOOSE';
  if (has('dirt') || has('substrate_overworld') || is('clay', 'farmland', 'dirt_path', 'mud', 'moss_block', 'rooted_dirt', 'muddy_mangrove_roots')) return 'SOIL';
  if (has('base_stone_overworld') || has('base_stone_nether') || has('ores') || has('terracotta') || EXTRA_ROCK.has(id) || /coral_block$/.test(id)) return 'ROCK';
  const fam = familyOf(dump.cls);
  if (dump.replaceable || has('flowers') || has('saplings') || PLANT_FAMILIES.has(fam) || is('sugar_cane', 'cactus', 'pumpkin', 'melon', 'sweet_berry_bush', 'bamboo', 'kelp', 'kelp_plant')) return 'PLANT';
  return null;
}

/** (6b) kit/voxel_classes.json: {format, classes, blocks: {id: class}} over the natural blocks. */
export function voxelClasses(report, dump, tags) {
  const blocks = {};
  for (const id of Object.keys(report).sort()) {
    const v = voxelClassOf(id, dump[id], tags);
    if (v) blocks[id] = v;
  }
  return { format: 1, note: 'GENERATED by kit/tools/gen-blocks.mjs (26.3); a block not listed is PLAYER; the mod bundles this file', classes: VOXEL_CLASSES, blocks };
}

export function generate(report, dump, template, tags = {}) {
  const lines = [];
  for (const id of Object.keys(report).sort()) {
    const d = dump[id];
    if (!d) throw new Error(`${id}: in the report but not dumped`);
    const c = classify(id, report[id], d);
    const extra = [`o: '${c.optics}'`];
    if (d.spawn) extra.push('sp: 1');
    const vc = voxelClassOf(id, d, tags);
    if (vc) extra.push(`v: '${vc}'`);
    if (c.conductor) extra.push('R: 1');
    if (c.light) extra.push(`L: ${JSON.stringify(c.light)}`);
    if (c.dampening > 0 && c.dampening < 15) extra.push(`d: ${c.dampening}`);
    if (c.collision !== 'full' && c.collision !== 'none' && c.top !== 1) extra.push(`h: ${c.top}`);
    if (c.item !== id) extra.push(`i: '${c.item === 'minecraft:air' ? '' : bare(c.item)}'`);
    lines.push(`b('${bare(id)}', '${c.collision}', '${c.family}', '${encodeProps(c.props, c.defaults)}', { ${extra.join(', ')} });`);
  }
  const marker = '/*@@DATA@@*/';
  if (!template.includes(marker)) throw new Error('template has no DATA marker');
  return template.replace(marker, () => `// ${lines.length} blocks (generated by kit/tools/gen-blocks.mjs from the vanilla 26.3 reports; do not edit)\n${lines.join('\n')}`);
}
