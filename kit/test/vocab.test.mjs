// (6c VOC) The block vocabulary (docs/CONTRACT.md "Phase 6c slice VOC" §1-§3, §6; gate items 1, 3, 4): the drift test (gen-vocab.mjs
// --check --no-jar against the committed kit/vocab/edges.json: every generated copy up to date, no jar needed), every block classified,
// every table row with a why, the hand families inside generated ones (or each split listed with its evidence), palette() unchanged, one
// source for the survival data, and the facts the contract names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BLOCKS } from '../lib/blocks.mjs';
import * as V from '../lib/vocab.mjs';
import { CREATIVE_ONLY, COSTS } from '../lib/vocab/survival.mjs';
import { RARITY_DEFAULTS, validateRarity } from '../lib/vocab/rarity.mjs';
import { AUTHORED_STYLES, PALETTES, paletteFromBible, STONE_FAMILIES, WOODS, woodFamilyOf } from '../lib/kit.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(KIT, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ids = Object.keys(BLOCKS).sort();

test('the drift test: gen-vocab.mjs --check --no-jar (every generated file equals what the committed edges and tables give)', () => {
  const r = spawnSync(process.execPath, [path.join(KIT, 'tools', 'gen-vocab.mjs'), '--check', '--no-jar'], { encoding: 'utf8', timeout: 300_000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('the two runs are one function: generateAll over the committed edges is deterministic', async () => {
  const G = await import('../tools/gen-vocab.mjs');
  const base = G.stripVocab(read('kit/lib/blocks.mjs'));
  const edges = JSON.parse(read('kit/vocab/edges.json'));
  const a = await G.generateAll(base, edges, G.readTables());
  const b = await G.generateAll(base, edges, G.readTables());
  for (const f of Object.keys(a.files)) assert.equal(a.files[f], b.files[f], f);
  // stripVocab then the section back: blocks.mjs exactly
  assert.equal(a.files[G.OUT.blocks], read('kit/lib/blocks.mjs'));
  // gen-blocks.mjs keeps the vocabulary section when it regenerates the rest
  assert.equal(G.carryVocab(base, read('kit/lib/blocks.mjs')), read('kit/lib/blocks.mjs'));
});

test('item 1: every block has fam, sv (and t, col, rt, wx, be, ft, ff only with values in their sets); 0 unclassified', () => {
  assert.equal(ids.length, 1286);
  for (const id of ids) {
    const b = BLOCKS[id];
    assert.ok(typeof b.fam === 'string' && /^[a-z0-9_]+$/.test(b.fam), `${id} fam`);
    assert.ok(V.SURVIVAL_CLASSES.includes(b.sv), `${id} sv ${b.sv}`);
    if (b.t !== undefined) assert.ok(['uncommon', 'rare', 'precious'].includes(b.t), `${id} t`);
    if (b.col !== undefined) assert.ok(V.DYES.includes(b.col), `${id} col`);
    for (const k of ['rt', 'be', 'ft']) if (b[k] !== undefined) assert.equal(b[k], 1, `${id} ${k}`);
    if (b.wx !== undefined) for (const t of Object.values(b.wx)) assert.ok(BLOCKS[`minecraft:${t}`], `${id} wx ${t}`);
    if (b.ff !== undefined) assert.ok(Array.isArray(b.ff) && b.ff.length, `${id} ff`);
  }
  // 26.3's default world needs no feature flag for any block
  assert.equal(ids.filter((id) => BLOCKS[id].ff).length, 0);
});

test('item 1: every tiers, roles, survival, hazards and modifiers row has a why, every override its evidence; keys resolve', async () => {
  const G = await import('../tools/gen-vocab.mjs');
  const t = G.readTables();
  assert.deepEqual(G.tableProblems(t), []);
  const fams = new Set(ids.map((id) => BLOCKS[id].fam));
  for (const r of t.tiers.rows) {
    assert.ok(t.tiers.tiers.includes(r.tier), r.key);
    if (r.key.startsWith('fam:')) assert.ok(fams.has(r.key.slice(4)), `${r.key}: no such family`);
  }
  for (const r of t.hazards.rows) assert.ok(V.hazardBlocks(r).length > 0, r.block);
  assert.equal(V.hazardBlocks(V.hazardOf('concrete_powder')).length, 16);
  for (const r of t.roles.rows) for (const c of [...(r.all ?? []), ...(r.any ?? [])]) assert.ok(V.ROLE_CHECKS.includes(c), c);
});

test('item 3: every STONE_FAMILIES and WOODS family inside one generated family, or each split listed with its recipe evidence', async () => {
  const G = await import('../tools/gen-vocab.mjs');
  const { report } = await G.generateAll(G.stripVocab(read('kit/lib/blocks.mjs')), JSON.parse(read('kit/vocab/edges.json')), G.readTables());
  assert.equal(report.hand.length, Object.keys(STONE_FAMILIES).length + WOODS.length);
  for (const h of report.hand) {
    const members = h.kind === 'stone' ? STONE_FAMILIES[h.hand].map((b) => `minecraft:${b}`) : ids.filter((id) => woodFamilyOf(id) === h.hand);
    const split = new Set(h.splits.map((s) => `minecraft:${s.block}`));
    for (const m of members) assert.ok(split.has(m) || BLOCKS[m].fam === h.family, `${h.hand}: ${m} is ${BLOCKS[m].fam}, not ${h.family}, and not listed`);
    for (const s of h.splits) assert.ok(s.why && /smelted|recipe|no recipe/.test(s.why), `${h.hand}: ${s.block} split without evidence`);
  }
  // the woods split nothing; the splits are the smelted members, gilded_blackstone and the two-material ones (as built)
  for (const h of report.hand.filter((x) => x.kind === 'wood')) assert.deepEqual(h.splits, [], h.hand);
  assert.deepEqual(report.hand.flatMap((h) => h.splits.map((s) => s.block)).sort(), ['cracked_deepslate_bricks', 'cracked_deepslate_tiles', 'cracked_nether_bricks',
    'cracked_polished_blackstone_bricks', 'cracked_stone_bricks', 'dark_prismarine', 'gilded_blackstone', 'prismarine_bricks', 'red_nether_bricks', 'smooth_basalt', 'smooth_quartz',
    'smooth_red_sandstone', 'smooth_sandstone', 'smooth_stone']);
  // 26.3's stonecutter makes cobblestone from stone (cobblestone_from_stone_stonecutting), so the hand `cobblestone` is inside `stone`
  assert.deepEqual(report.merged, [{ family: 'stone', alsoHolds: ['cobblestone'] }]);
  assert.equal(V.familyOf('cobblestone'), 'stone');
  // the hand-kept families and their names are unchanged (palette() and paletteFamilies still read them)
  assert.equal(V.familyOf('oak_planks'), 'oak');
  assert.equal(V.familyOf('deepslate_tiles'), 'deepslate');
});

test('item 3: every built-in palette and every built-in and scenario bible\'s palette() is byte-identical to v0.37.0', () => {
  const want = JSON.parse(read('kit/test/fixtures/vocab/palettes-v0370.json')).palettes;
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const got = {};
  for (const n of Object.keys(PALETTES).sort()) got[`preset:${n}`] = sha(JSON.stringify(PALETTES[n]));
  for (const bdir of ['kit/bibles', 'scenarios/bibles']) {
    const abs = path.join(ROOT, bdir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.json')).sort()) {
      const bible = JSON.parse(fs.readFileSync(path.join(abs, f), 'utf8'));
      let v;
      try { v = JSON.stringify(paletteFromBible({ id: f.replace(/\.json$/, ''), version: 1, ...bible })); } catch (e) { v = `throws ${e.message}`; }
      got[`${bdir}/${f}`] = sha(v);
    }
  }
  // (Style unification U0) the fixture stays as recorded: every palette in it is byte-identical; the only new ones are the
  // authored built-in Styles (kit.mjs AUTHORED_STYLES)
  const kept = Object.fromEntries(Object.keys(want).map((k) => [k, got[k]]));
  assert.deepEqual(kept, want);
  assert.deepEqual(Object.keys(got).filter((k) => !(k in want)).sort(), AUTHORED_STYLES.map((n) => `preset:${n}`).sort());
});

test('item 4: one source: check.mjs and bom.mjs hold no literal list; creativeOnly = the 35 of phase 3, no 26.3 additions; COSTS = survival_items costs', () => {
  for (const f of ['kit/lib/check.mjs', 'kit/lib/connectors/bom.mjs']) {
    const s = read(f);
    assert.ok(!/'(minecraft:)?bedrock'|'(minecraft:)?structure_void'/.test(s), `${f} lists creative-only blocks`);
    assert.ok(!/'minecraft:dirt_path': 'minecraft:dirt'/.test(s), `${f} lists costs`);
    assert.ok(/from '\.\.?\/(\.\.\/)?vocab\/survival\.mjs'/.test(s), `${f} imports kit/lib/vocab/survival.mjs`);
  }
  const items = JSON.parse(read('mod/src/main/resources/data/architect_mc/survival_items.json'));
  assert.deepEqual(items.costs, COSTS);
  assert.deepEqual(items.creativeOnly, [...CREATIVE_ONLY, 'architect_mc:construction_crate']);
  assert.equal(items.creativeOnly.length, 35);
  const phase3 = ['bedrock', 'barrier', 'light', 'structure_block', 'structure_void', 'jigsaw', 'test_block', 'test_instance_block', 'command_block',
    'chain_command_block', 'repeating_command_block', 'spawner', 'trial_spawner', 'vault', 'budding_amethyst', 'reinforced_deepslate', 'end_portal_frame',
    'end_portal', 'end_gateway', 'nether_portal', 'petrified_oak_slab', 'infested_stone', 'infested_cobblestone', 'infested_stone_bricks',
    'infested_mossy_stone_bricks', 'infested_cracked_stone_bricks', 'infested_chiseled_stone_bricks', 'infested_deepslate', 'suspicious_sand',
    'suspicious_gravel', 'frogspawn', 'chorus_plant', 'player_head', 'player_wall_head'].map((b) => `minecraft:${b}`).sort();
  assert.deepEqual([...CREATIVE_ONLY].sort(), phase3);
  for (const id of ids) assert.equal(BLOCKS[id].sv === 'none', CREATIVE_ONLY.has(id), id);
  assert.equal(Object.keys(COSTS).length, 28);
});

test('the tiers the contract names (§2.2): a beacon precious, a sea lantern rare, red concrete and a cut copper stair uncommon; iron\'s lanterns and chains uncommon', () => {
  assert.equal(V.tierOf('beacon'), 'precious');
  assert.equal(V.tierOf('sea_lantern'), 'rare');
  assert.equal(V.tierOf('red_concrete'), 'uncommon');
  assert.equal(V.tierOf('cut_copper_stairs'), 'uncommon');
  assert.equal(V.tierOf('lantern'), 'uncommon');
  assert.equal(V.tierOf('iron_chain'), 'uncommon');
  assert.equal(V.tierOf('diamond_block'), 'precious');
  assert.equal(V.tierOf('purpur_block'), 'rare');
  assert.equal(V.tierOf('blackstone'), 'uncommon');
  assert.equal(V.tierOf('stone_bricks'), 'common');
  assert.equal(V.tierOf('oak_planks'), 'common');
  // waxing doesn't raise a tier (honeycomb is common); white wool is spun from string (common), dyed wool is uncommon
  assert.equal(V.tierOf('waxed_cut_copper'), V.tierOf('cut_copper'));
  assert.equal(V.tierOf('white_wool'), 'common');
  assert.equal(V.tierOf('red_wool'), 'uncommon');
});

test('families, colours, survival, fittings and drift: the facts §0-§2 name', () => {
  for (const [b, f] of [['copper_block', 'copper'], ['oxidized_cut_copper_stairs', 'copper'], ['copper_bulb', 'copper'], ['red_concrete', 'concrete'],
    ['white_concrete_slab', 'concrete'], ['red_terracotta', 'terracotta'], ['terracotta', 'terracotta'], ['red_glazed_terracotta', 'glazed_terracotta'],
    ['red_wool', 'wool'], ['red_carpet', 'wool'], ['red_stained_glass_pane', 'stained_glass'], ['cinnabar_bricks', 'cinnabar'], ['polished_sulfur', 'sulfur'],
    ['iron_bars', 'iron'], ['ice', 'ice'], ['blue_ice', 'ice']]) assert.equal(V.familyOf(b), f, b);
  assert.equal(V.colourOf('light_gray_concrete'), 'light_gray');
  assert.equal(V.colourOf('red_sandstone'), null);
  assert.equal(V.colourOf('blue_ice'), null);
  assert.equal(V.colourOf('white_tulip'), null);
  assert.equal(V.familyOf('red_sandstone'), 'red_sandstone');
  assert.equal(V.survivalOf('bedrock'), 'none');
  assert.equal(V.survivalOf('grass_block'), 'cost');
  assert.equal(V.survivalOf('ice'), 'silk');
  assert.equal(V.survivalOf('stone'), 'craft');
  assert.equal(V.survivalOf('wall_torch'), 'craft'); // its BOM item, the torch
  assert.ok(V.isFitting('oak_door') && V.isFitting('glass_pane') && V.isFitting('lantern') && V.isFitting('red_bed'));
  assert.ok(!V.isFitting('stone_bricks') && !V.isFitting('sea_lantern') && !V.isFitting('glowstone'));
  assert.ok(V.drifts('copper_block') && V.drifts('farmland') && V.drifts('oak_leaves') && !V.drifts('oak_leaves[persistent=true]'));
  assert.ok(!V.drifts('waxed_copper_block') && !V.drifts('oxidized_copper') && !V.drifts('wheat') && !V.drifts('stone'));
  assert.deepEqual(V.weatheringOf('copper_block'), { next: 'minecraft:exposed_copper', waxed: 'minecraft:waxed_copper_block' });
  assert.ok(V.hasBlockEntity('chest') && !V.hasBlockEntity('stone'));
});

test('role fitness (§2.3) reports, never changes a block', () => {
  assert.deepEqual(V.fitsRole('wall', 'stone_bricks'), { ok: true, failed: [] });
  assert.deepEqual(V.fitsRole('wall', 'sand').failed, ['notGravity']);
  assert.deepEqual(V.fitsRole('path', 'gravel').failed, ['notGravity']);
  assert.ok(V.fitsRole('roof', 'dark_oak_planks').ok);
  assert.ok(V.fitsRole('light', 'soul_lantern').ok && !V.fitsRole('light', 'stone').ok);
  assert.ok(V.fitsRole('rail', 'spruce_fence').ok && !V.fitsRole('rail', 'stone').ok);
  assert.ok(V.fitsRole('surface', 'snow_block').ok);
  assert.deepEqual(V.fitsRole('accent', 'bedrock').failed, ['obtainable']);
  assert.deepEqual(V.fitsRole('wall', 'not_a_block').failed, ['known']);
});

test('the rarity member\'s schema and defaults (§4.1, the shared interface with VOC-b)', () => {
  assert.deepEqual(RARITY_DEFAULTS, { uncommonShareMax: 0.1, rareShareMax: 0.02, preciousMax: 0, preciousRegionMax: 0, coloursMax: 3, rareFamiliesMax: 2 });
  const ok = validateRarity({ colours: ['white', 'light_gray', 'black'], preciousMax: 1, allow: ['amethyst_block', '#minecraft:wool'], families: { concrete: 0.5 } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.rarity.uncommonShareMax, 0.1);
  const bad = validateRarity({ rareShareMax: 0.5, colours: ['mauve'], coloursMax: 0, allow: ['not_a_block'], extra: 1 });
  assert.equal(bad.rarity, null);
  for (const p of ['rarity: unknown field \'extra\'', 'rarity.rareShareMax', 'rarity.colours', 'rarity.coloursMax', 'rarity.allow']) assert.ok(bad.errors.some((e) => e.startsWith(p)), p);
});
