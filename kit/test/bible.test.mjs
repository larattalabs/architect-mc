// Phase 4b (docs/CONTRACT.md "Phase 4b contract: style bibles and design groups"): material roles and built-in bibles,
// byte-identical preset builds, named parts, open types with profiles, and the component test frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDesign } from '../build.mjs';
import { BUILTIN_BIBLES, builtinBible, builtinComponentsFile, validateBible } from '../lib/bible.mjs';
import { checkBlueprint } from '../lib/check.mjs';
import { buildFrame, checkComponents, loadComponents, REQUIRED_COMPONENTS } from '../lib/components.mjs';
import { Blueprint, CORE_ROLES, MACRO_ROLES, PALETTES, PALETTE_PRESETS, palette, resolvePalette } from '../lib/kit.mjs';
import { decodePng } from '../lib/png.mjs';
import { presetBuilds, FIXTURE } from '../tools/preset-builds.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-bible-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const run = (script, args) => spawnSync(process.execPath, [path.join(KIT, script), ...args], { encoding: 'utf8' });

/** The contract's example bible. */
const ASHFALL = {
  id: 'bib_ashfall', name: 'Ashfall', version: 3, prompt: 'hellish evil lair, mining facility',
  roles: {
    wall: 'minecraft:blackstone', wall_alt: 'minecraft:polished_blackstone_bricks', trim: 'minecraft:basalt', roof: 'minecraft:deepslate_tiles',
    floor: 'minecraft:polished_basalt', frame: 'minecraft:crimson_stem', accent: 'minecraft:crimson_planks', light: 'minecraft:shroomlight',
    glass: 'minecraft:red_stained_glass_pane', foundation: 'minecraft:blackstone', path: 'minecraft:coarse_dirt',
  },
  proportions: { storey: 4, roofPitch: 1.0, overhang: 1, windowRhythm: 3, plinth: 1 },
  roofLanguage: 'steep gable', silhouette: 'tall, narrow, spiky ridges', motifs: ['chimney vents', 'chain lanterns'],
  tiers: { humble: ['wall_alt', 'accent'], important: ['wall', 'trim'] }, lighting: 'low, warm, from below', avoid: ['white', 'bright wood'],
  components: ['window', 'door_surround', 'lantern_post', 'roof_trim', 'chimney'],
};

// ---------------------------------------------------------------- roles, built-in bibles, byte identity

test('the presets still build byte-identically (template and sidecar, every example, every corner)', async () => {
  const want = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const got = await presetBuilds();
  const diff = Object.keys({ ...want, ...got }).filter((k) => JSON.stringify(want[k]) !== JSON.stringify(got[k]));
  assert.deepEqual(diff, [], `${diff.length} builds differ from before style bibles`);
});

test('every preset is a built-in bible: the same palette fields and the same templates', async () => {
  for (const n of Object.keys(PALETTE_PRESETS)) {
    const p = PALETTES[n];
    const b = palette({ bible: n });
    for (const k of Object.keys(p)) if (!['inputs', 'with', 'roles'].includes(k)) assert.deepEqual(b[k], p[k], `${n}.${k}`);
    assert.deepEqual(b.roles, p.roles, n);
    assert.deepEqual(palette({ bible: builtinBible(n) }).roles, p.roles);
  }
  const want = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const got = await presetBuilds({ palette: (preset) => ({ bible: preset }) });
  const diff = Object.keys(want).filter((k) => want[k].nbt !== got[k].nbt);
  assert.deepEqual(diff, [], 'templates built under a built-in bible differ from the preset');
});

test('palette({ bible }): every field from a role, extra roles kept, inputs round-trip', () => {
  const p = palette({ bible: ASHFALL });
  assert.equal(p.wall, 'minecraft:blackstone');
  assert.equal(p.plaster, 'minecraft:polished_blackstone_bricks');
  assert.equal(p.stoneTrim, 'minecraft:basalt');
  assert.equal(p.roofStairs, 'minecraft:deepslate_tile_stairs');
  assert.equal(p.frame, 'minecraft:crimson_stem');
  assert.equal(p.planks, 'minecraft:crimson_planks');
  assert.equal(p.log, 'minecraft:crimson_stem');
  assert.equal(p.door, 'minecraft:crimson_door');
  assert.equal(p.pane, 'minecraft:red_stained_glass_pane');
  assert.equal(p.glass, 'minecraft:red_stained_glass');
  assert.equal(p.stone, 'minecraft:blackstone');
  assert.equal(p.stoneStairs, 'minecraft:blackstone_stairs');
  assert.equal(p.light, 'minecraft:shroomlight');
  assert.deepEqual(p.bible, { id: 'bib_ashfall', version: 3 });
  assert.deepEqual(resolvePalette(JSON.parse(JSON.stringify(p.inputs))).roles, p.roles);
  const extra = palette({ bible: { ...ASHFALL, roles: { ...ASHFALL.roles, banner: 'red_banner', rail: 'minecraft:rail' } } });
  assert.equal(extra.roles.banner, 'minecraft:red_banner');
  // a roof named by its stairs is the stairs' full block
  assert.equal(palette({ bible: { ...ASHFALL, roles: { ...ASHFALL.roles, roof: 'minecraft:deepslate_tile_stairs' } } }).roofBlock, 'minecraft:deepslate_tiles');
  for (const [bad, re] of [
    [{ ...ASHFALL, roles: { ...ASHFALL.roles, wall: 'minecraft:not_a_block' } }, /not a vanilla block/],
    [{ ...ASHFALL, roles: { ...ASHFALL.roles, roof: 'minecraft:glass' } }, /no stairs\/slab/],
    [{ ...ASHFALL, roles: { wall: 'minecraft:stone' } }, /no roles/],
    ['nope', /unknown built-in bible/],
  ]) assert.throws(() => palette({ bible: bad }), re, JSON.stringify(bad).slice(0, 60));
  assert.throws(() => palette({ bible: 'rustic', wood: 'oak' }), /no other inputs/);
});

test('a bible build records palette.bible and bible, and the checker reads it back (no palette warning)', async () => {
  const bp = await loadDesign('cabin', { palette: { bible: ASHFALL } });
  const sc = JSON.parse(JSON.stringify(bp.sidecar()));
  assert.deepEqual(sc.bible, { id: 'bib_ashfall', version: 3 });
  assert.equal(sc.palette.bible.roles.wall, 'minecraft:blackstone');
  const r = checkBlueprint(bp);
  assert.ok(r.ok, r.errors.join(' | '));
  assert.deepEqual(r.warnings.filter((w) => /palette/.test(w)), []);
  // build.mjs --bible <file> does the same through the CLI
  const f = path.join(tmp, 'ashfall.json');
  fs.writeFileSync(f, JSON.stringify(ASHFALL));
  const c = run('build.mjs', ['tower', '--out', tmp, '--bible', f, '--json']);
  const j = JSON.parse(c.stdout.trim().split('\n').pop());
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(j.sidecar, 'utf8')).bible, { id: 'bib_ashfall', version: 3 });
  assert.equal(run('build.mjs', ['tower', '--out', tmp, '--bible', 'cherry', '--json']).status, 0);
  assert.equal(run('build.mjs', ['tower', '--bible', 'nope', '--json']).status, 2);
  assert.equal(run('build.mjs', ['tower', '--bible', 'cherry', '--palette', 'oak', '--json']).status, 2);
});

test('validateBible: roles, macro roles for a settlement, the typed rest', () => {
  const ok = validateBible(ASHFALL);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.bible.components.slice(0, 5), REQUIRED_COMPONENTS);
  const short = validateBible({ ...ASHFALL, roles: { ...ASHFALL.roles, wall: 'stone' } });
  assert.equal(short.bible.roles.wall, 'minecraft:stone');
  const cases = [
    [{ ...ASHFALL, roles: { wall: 'minecraft:stone' } }, /missing wall_alt/],
    [{ ...ASHFALL, roles: { ...ASHFALL.roles, Bad: 'minecraft:stone' } }, /name 'Bad'/],
    [{ ...ASHFALL, roles: { ...ASHFALL.roles, flag: 'minecraft:mod_block' } }, /not a vanilla block/],
    [{ ...ASHFALL, tiers: { humble: ['nonsense'] } }, /not a role/],
    [{ ...ASHFALL, name: '' }, /name/],
    [{ ...ASHFALL, proportions: { storey: 'tall' } }, /proportions.storey/],
    [{ ...ASHFALL, id: 'Bad Id' }, /id/],
  ];
  for (const [b, re] of cases) {
    const r = validateBible(b);
    assert.ok(!r.ok && r.errors.some((e) => re.test(e)), `${re}: ${r.errors.join(' | ')}`);
  }
  // roles that cannot build a sound house are refused at once (the component check could not fix them)
  for (const [roles, re] of [
    [{ light: 'minecraft:candle' }, /light:/],
    [{ path: 'minecraft:oak_fence' }, /approach\.block/],
    [{ foundation: 'minecraft:glass' }, /foundationBlock/],
  ]) {
    const r = validateBible({ ...ASHFALL, roles: { ...ASHFALL.roles, ...roles } });
    assert.ok(!r.ok && r.errors.some((e) => /test house/.test(e) && re.test(e)), `${JSON.stringify(roles)}: ${r.errors.join(' | ')}`);
  }
  const town = validateBible(ASHFALL, { scope: 'settlement' });
  assert.ok(!town.ok && town.errors.some((e) => /macro roles; missing rock, surface/.test(e)), town.errors.join(' | '));
  const macro = Object.fromEntries(MACRO_ROLES.map((r, i) => [r, ['minecraft:stone', 'minecraft:grass_block', 'minecraft:dirt', 'minecraft:cobblestone', 'minecraft:rail', 'minecraft:oak_planks'][i]]));
  assert.ok(validateBible({ ...ASHFALL, roles: { ...ASHFALL.roles, ...macro } }, { scope: 'settlement' }).ok);
  assert.deepEqual(CORE_ROLES.length, 11);
  // the CLI
  const f = path.join(tmp, 'b.json');
  fs.writeFileSync(f, JSON.stringify({ ...ASHFALL, roles: { ...ASHFALL.roles, roof: 'glass' } }));
  const c = run('tools/bible.mjs', ['validate', f]);
  assert.equal(c.status, 1);
  assert.match(JSON.parse(c.stdout).errors.join(' '), /roof/);
  const all = JSON.parse(run('tools/bible.mjs', ['builtin']).stdout);
  assert.deepEqual(all.bibles.map((b) => b.id), BUILTIN_BIBLES);
  assert.ok(all.bibles.find((b) => b.id === 'rustic').componentsFile.endsWith(path.join('bibles', 'rustic', 'components.mjs')));
});

// ---------------------------------------------------------------- named parts

test('bp.part records boxes and cell counts; the checker warns about too few parts or too many cells outside', () => {
  const p = PALETTES.rustic;
  const make = (fn) => {
    const bp = new Blueprint({ id: 'p', type: 'custom', size: [5, 6, 7], palette: p, interior: [1, 1, 1, 3, 3, 3] });
    fn(bp);
    bp.spot('entrance', 2, 5, 180);
    bp.spot('spawn', 2, 6, 180);
    return bp;
  };
  const hut = (bp) => {
    bp.floor(0, 0, 4, 6, 0, p.stone);
    bp.carve([1, 1, 1, 3, 3, 3]);
    bp.walls(0, 0, 4, 4, 1, 3);
    bp.door(2, 1, 4, 'south');
    bp.lantern(2, 3, 2, true);
  };
  const two = make((bp) => {
    bp.part('main', () => hut(bp));
    bp.part('roof', () => bp.floor(0, 0, 4, 4, 4, p.planks));
    // a later write elsewhere takes the cell over; nested parts give the innermost
    bp.part('roof', () => bp.part('vent', () => bp.set(2, 5, 2, p.stone)));
  });
  const sc = two.sidecar();
  assert.deepEqual(Object.keys(sc.parts), ['main', 'roof', 'vent']);
  assert.deepEqual(sc.parts.roof, { box: [0, 4, 0, 4, 4, 4], cells: 25 });
  assert.deepEqual(sc.parts.vent, { box: [2, 5, 2, 2, 5, 2], cells: 1 });
  assert.equal(sc.parts.main.cells + 25 + 1, two.cells.size);
  assert.deepEqual(checkBlueprint(two).warnings, []);
  const one = checkBlueprint(make((bp) => { bp.part('main', () => { hut(bp); bp.floor(0, 0, 4, 4, 4, p.planks); bp.set(2, 5, 2, p.stone); }); }));
  assert.ok(one.warnings.some((w) => /1 named part;/.test(w)), one.warnings.join(' | '));
  const outside = checkBlueprint(make((bp) => { hut(bp); bp.floor(0, 0, 4, 4, 4, p.planks); bp.set(2, 5, 2, p.stone); bp.part('door', () => bp.door(2, 1, 4, 'south')); bp.part('light', () => bp.lantern(2, 3, 2, true)); }));
  assert.ok(outside.warnings.some((w) => /outside every named part/.test(w)), outside.warnings.join(' | '));
  const none = checkBlueprint(make((bp) => { hut(bp); bp.floor(0, 0, 4, 4, 4, p.planks); bp.set(2, 5, 2, p.stone); }));
  assert.ok(none.warnings.some((w) => /no named parts/.test(w)));
  assert.throws(() => make((bp) => bp.part('Bad', () => {})), /part name/);
});

test('the four examples declare at least 2 parts with under 20% of their cells outside', async () => {
  for (const id of ['cabin', 'tower', 'tavern', 'gatehouse']) {
    const bp = await loadDesign(id);
    const sc = bp.sidecar();
    const inParts = Object.values(sc.parts).reduce((a, p) => a + p.cells, 0);
    assert.ok(Object.keys(sc.parts).length >= 2, id);
    assert.ok(bp.cells.size - inParts <= 0.2 * bp.cells.size, `${id}: ${bp.cells.size - inParts} of ${bp.cells.size} outside`);
    const shipped = JSON.parse(fs.readFileSync(path.join(KIT, 'examples', id, `${id}.blueprint.json`), 'utf8'));
    assert.deepEqual(shipped.parts, JSON.parse(JSON.stringify(sc.parts)), `${id}: kit/examples is out of date (node kit/tools/examples.mjs)`);
  }
});

// ---------------------------------------------------------------- open types

/** A small open-type building (walls, door, light, roof), each optional. */
function lair({ type = 'hellish_lair', profile, door = true, light = true, interior = true, height = 4 } = {}) {
  const p = PALETTES.crimson;
  const bp = new Blueprint({ id: 'lair', type, ...(profile ? { profile } : {}), size: [7, height + 1, 9], palette: p, ...(interior ? { interior: [1, 1, 1, 5, height - 1, 5] } : {}) });
  bp.part('main', () => {
    bp.floor(0, 0, 6, 8, 0, p.stone);
    bp.carve([1, 1, 1, 5, height - 1, 5]);
    bp.walls(0, 0, 6, 6, 1, height - 1);
    if (door) bp.door(3, 1, 6, 'south');
    if (light) bp.lantern(3, height - 1, 3, true);
  });
  bp.part('roof', () => bp.floor(0, 0, 6, 6, height, p.planks));
  bp.spot('entrance', 3, 7, 180);
  bp.spot('spawn', 3, 8, 180);
  return bp;
}

test('open types: any short type; without a profile: door, lit and no_floating', () => {
  const ok = checkBlueprint(lair());
  assert.deepEqual([ok.errors, ok.warnings], [[], []]);
  assert.equal(lair().sidecar().type, 'hellish_lair');
  assert.ok(checkBlueprint(lair({ door: false })).errors.some((e) => /no outside door/.test(e)));
  assert.ok(checkBlueprint(lair({ light: false })).errors.some((e) => /light:/.test(e)));
  assert.ok(checkBlueprint(lair({ interior: false })).errors.some((e) => /interior is required: the profile of 'hellish_lair' has lit/.test(e)));
  const floating = lair();
  floating.part('main', () => floating.set(0, 4, 8, 'minecraft:stone'));
  assert.ok(checkBlueprint(floating).warnings.some((w) => /floating/.test(w)));
  assert.throws(() => new Blueprint({ id: 'x', type: 'Bad Type', size: [1, 1, 1] }), /type/);
});

test('open types: profile rules from the menu; preset types keep their own profiles', () => {
  // only the listed rules: no door needed, no light needed
  assert.deepEqual(checkBlueprint(lair({ profile: ['no_floating'], door: false, light: false, interior: false })).errors, []);
  const tall = checkBlueprint(lair({ profile: ['door', 'lit', 'tall:3'] }));
  assert.ok(tall.warnings.some((w) => /tall:3 wants at least/.test(w)), tall.warnings.join(' | '));
  const vol = checkBlueprint(lair({ profile: ['door', 'lit', 'min_interior_volume:500'] }));
  assert.ok(vol.warnings.some((w) => /under the 500/.test(w)), vol.warnings.join(' | '));
  const pass = checkBlueprint(lair({ profile: ['door', 'passage:3x3'] }));
  assert.ok(pass.warnings.some((w) => /no passage through/.test(w)), pass.warnings.join(' | '));
  const reach = checkBlueprint(lair({ profile: ['door', 'lit', 'floors_reachable', 'roof_closed'] }));
  assert.deepEqual(reach.warnings, []);
  assert.throws(() => lair({ profile: ['door', 'flying'] }), /unknown rule 'flying'/);
  assert.throws(() => lair({ profile: ['passage:wide'] }), /passage needs/);
  // the request's profile must match the design's
  const mismatch = checkBlueprint(lair({ profile: ['door', 'lit'] }), { profile: ['door', 'lit', 'no_floating'] });
  assert.ok(mismatch.errors.some((e) => /profile/.test(e)), mismatch.errors.join(' | '));
  // a preset type ignores a profile (a cabin still needs its interior and light)
  const cabin = checkBlueprint(lair({ type: 'cabin', profile: ['no_floating'], light: false }));
  assert.ok(cabin.errors.some((e) => /light:/.test(e)));
});

// ---------------------------------------------------------------- components

const REF = builtinComponentsFile('rustic');

test('the test frame passes on its own, with no warnings, under every built-in bible', () => {
  for (const n of BUILTIN_BIBLES) {
    const r = checkBlueprint(buildFrame(palette({ bible: n })));
    assert.deepEqual([r.errors, r.warnings], [[], []], n);
  }
});

test('the reference components pass their frames under every built-in bible and a generated one', async () => {
  for (const n of [...BUILTIN_BIBLES, ASHFALL]) {
    const r = await checkComponents(REF, palette({ bible: n }));
    assert.ok(r.ok, `${n.id ?? n}: ${r.errors.join(' | ')}`);
    assert.deepEqual(r.components.map((c) => c.name).sort(), [...REQUIRED_COMPONENTS].sort());
    assert.deepEqual(r.warnings, [], `${n.id ?? n}`);
  }
});

test('the component frame fails a component that throws, imports, breaks the building or is missing', async () => {
  const write = (name, body) => { const f = path.join(tmp, `${name}.mjs`); fs.writeFileSync(f, body); return f; };
  const base = fs.readFileSync(REF, 'utf8');
  const throws = await checkComponents(write('throws', base.replace('export function chimney(bp, at) {', "export function chimney(bp, at) {\n  throw new Error('no chimney today');")), PALETTES.rustic);
  assert.ok(!throws.ok && throws.errors.some((e) => /chimney threw: no chimney today/.test(e)), throws.errors.join(' | '));
  const breaks = await checkComponents(write('breaks', `${base}\nexport function doorway(bp, at) { bp.set(at.x, at.y, at.z, 'minecraft:air'); bp.set(at.x, at.y + 1, at.z, 'minecraft:air'); }\nexport const meta = { doorway: { slot: 'door' } };\n`), PALETTES.rustic);
  assert.ok(!breaks.ok && breaks.errors.some((e) => /^doorway: .*(no outside door|door)/.test(e)), breaks.errors.join(' | '));
  const hardcoded = await checkComponents(write('hard', `${base}\nexport function bench(bp, at) { bp.set(at.x, at.y, at.z, 'minecraft:oak_slab', { type: 'bottom' }); }\n`), PALETTES.rustic);
  assert.ok(hardcoded.ok && hardcoded.warnings.some((w) => /bench: palette: .*wood 'oak'/.test(w)), hardcoded.warnings.join(' | '));
  const imports = await loadComponents(write('imports', `import fs from 'node:fs';\n${base}`));
  assert.ok(imports.errors.some((e) => /must not import/.test(e)));
  const missing = await loadComponents(write('missing', base.replace('export function chimney', 'function chimney')));
  assert.ok(missing.errors.some((e) => /lacks chimney/.test(e)));
});

test('tools/components.mjs: JSON line, sheet.png, exit codes', () => {
  const out = path.join(tmp, 'sheet');
  const c = run('tools/components.mjs', [REF, '--bible', 'dark', '--out', out, '--json']);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  const j = JSON.parse(c.stdout.trim());
  assert.equal(j.ok, true);
  assert.equal(j.components.length, 5);
  const png = decodePng(fs.readFileSync(j.sheet));
  assert.ok(png.width > 600 && png.height > 300, `${png.width}x${png.height}`);
  const bad = path.join(tmp, 'bad.mjs');
  fs.writeFileSync(bad, 'export function window(bp, at) { throw new Error("x"); }\n');
  assert.equal(run('tools/components.mjs', [bad, '--json']).status, 1);
  assert.equal(run('tools/components.mjs', [REF, '--bible', 'nope', '--json']).status, 2);
});
