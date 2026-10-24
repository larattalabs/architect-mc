// Style unification U0 (docs/STYLE-UNIFY.md, docs/CONTRACT.md "Style unification"): the built-in Styles' metadata, the
// authored Styles, the four main rows' fan-out (mainOf, editMain, provenanceOf) and the table the mod reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_BIBLES, builtinBible, styleFieldsErrors, validateBible } from '../lib/bible.mjs';
import { AUTHORED_STYLES, PALETTES, PALETTE_PRESETS, WOODS, palette, variant } from '../lib/kit.mjs';
import { FEATURE_IDS, MAX_SUGGESTED_FEATURES, STYLE_META, editMain, fanOut, mainOf, provenanceOf, styleTable } from '../lib/styles.mjs';
import { fitsRole } from '../lib/vocab.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-styles-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('the six word-only chips are authored built-in Styles: valid, no role warnings, sensible roles', () => {
  assert.deepEqual([...AUTHORED_STYLES].sort(), ['cozy', 'fantasy', 'japanese', 'medieval', 'modern', 'nordic']);
  for (const n of AUTHORED_STYLES) {
    assert.ok(PALETTE_PRESETS[n] && BUILTIN_BIBLES.includes(n), n);
    const b = builtinBible(n);
    const v = validateBible(b); // the test house included (bible.mjs frame check)
    assert.ok(v.ok, `${n}: ${v.errors.join('; ')}`);
    assert.deepEqual(v.warnings, [], `${n}: ${v.warnings.join('; ')}`);
    const r = b.roles;
    assert.notEqual(r.wall, r.wall_alt, `${n}: wall differs from wall_alt`);
    assert.ok(variant(r.roof, 'stairs') && variant(r.roof, 'slab'), `${n}: the roof has stairs and a slab`);
    assert.ok(fitsRole('light', r.light).ok, `${n}: the light gives light`);
    assert.equal(b.origin, 'builtin');
  }
  // Modern: concrete walls, a flat roof language and no pitch
  const m = builtinBible('modern');
  assert.equal(m.roles.wall, 'minecraft:white_concrete');
  assert.equal(m.proportions.roofPitch, 0);
  assert.match(m.roofLanguage, /flat/);
  // the style chips of the mod (DesignSpec.STYLES) all have a built-in Style now
  const spec = read('mod/src/main/java/dev/larattalabs/architect/design/DesignSpec.java');
  const chips = [...spec.slice(spec.indexOf('STYLES = List.of('), spec.indexOf('FEATURES = List.of(')).matchAll(/new Choice\("([a-z_]+)"/g)].map((x) => x[1]);
  assert.ok(chips.length >= 8, chips.join(', '));
  for (const c of chips) assert.ok(PALETTE_PRESETS[c], `style chip ${c} has a built-in Style`);
});

test('every built-in Style has metadata: tags, suggestedFeatures (DesignSpec.FEATURES ids, at most 6), a blurb', () => {
  const spec = read('mod/src/main/java/dev/larattalabs/architect/design/DesignSpec.java');
  const feats = [...spec.slice(spec.indexOf('FEATURES = List.of('), spec.indexOf('PROFILE_RULES')).matchAll(/new Choice\("([a-z_]+)"/g)].map((x) => x[1]);
  assert.deepEqual(feats, [...FEATURE_IDS], 'FEATURE_IDS = DesignSpec.FEATURES');
  assert.deepEqual(Object.keys(STYLE_META).sort(), Object.keys(PALETTE_PRESETS).sort());
  for (const [n, m] of Object.entries(STYLE_META)) {
    assert.ok(m.tags.length >= 1 && m.blurb.length > 0, n);
    assert.ok(m.suggestedFeatures.length <= MAX_SUGGESTED_FEATURES, n);
    for (const f of m.suggestedFeatures) assert.ok(FEATURE_IDS.includes(f), `${n}: ${f}`);
    assert.deepEqual(styleFieldsErrors(builtinBible(n)), [], n);
  }
});

test('the optional Style fields are typed: tags, suggestedFeatures, blurb, basedOn, origin', () => {
  const b = builtinBible('oak');
  const bad = (o) => validateBible({ ...b, builtin: undefined, ...o }).errors;
  assert.deepEqual(bad({ basedOn: { id: 'oak', version: 1 }, origin: 'hand' }), []);
  assert.ok(bad({ tags: ['x'.repeat(41)] }).some((e) => /^tags/.test(e)));
  assert.ok(bad({ suggestedFeatures: ['porch', 'moat'] }).some((e) => /moat is not a feature id/.test(e)));
  assert.ok(bad({ suggestedFeatures: ['porch', 'porch'] }).some((e) => /duplicate/.test(e)));
  assert.ok(bad({ suggestedFeatures: FEATURE_IDS.slice(0, 7) }).some((e) => /at most 6/.test(e)));
  assert.ok(bad({ blurb: 'x'.repeat(201) }).some((e) => /^blurb/.test(e)));
  assert.ok(bad({ basedOn: { id: 'Oak', version: 1 } }).some((e) => /^basedOn/.test(e)));
  assert.ok(bad({ basedOn: { id: 'oak' } }).some((e) => /^basedOn/.test(e)));
  assert.ok(bad({ origin: 'steward' }).some((e) => /^origin/.test(e)));
});

test('fanOut(inputs) is palette(inputs).roles over every wood x a stone and roof sample', () => {
  let n = 0;
  for (const wood of WOODS) {
    for (const stone of ['cobblestone', 'stone_bricks', 'deepslate_tiles', 'sandstone', 'bricks', 'smooth_quartz', 'mud_bricks']) {
      for (const roof of [undefined, 'oak', 'deepslate_tiles', 'cut_copper']) {
        for (const accent of [undefined, 'spruce']) {
          const i = { wood, stone, ...(roof ? { roof } : {}), ...(accent ? { accent } : {}) };
          assert.deepEqual(fanOut(i), { ...palette(i).roles }, JSON.stringify(i));
          n++;
        }
      }
    }
  }
  assert.ok(n > 600);
});

test('mainOf reads the four rows back from roles: every preset without extras round-trips its inputs', () => {
  for (const [n, p] of Object.entries(PALETTES)) {
    const m = mainOf(p.roles);
    const { wood, stone, roof, accent } = p.inputs;
    assert.deepEqual(m, { wood, stone, roof, accent }, n);
  }
});

test('editMain re-derives only the roles that still follow; a Style-set role stays', () => {
  const med = PALETTES.medieval.roles;
  const w = editMain(med, 'wood', 'birch');
  assert.equal(w.wall, 'minecraft:white_terracotta', 'medieval wall is set by the Style');
  assert.equal(w.frame, 'minecraft:birch_log');
  assert.equal(w.floor, 'minecraft:birch_planks');
  assert.equal(w.accent, med.accent);
  assert.equal(med.frame, 'minecraft:dark_oak_log', 'the input is not changed');
  // a stripped log stays a stripped log (modern's frame)
  assert.equal(editMain(PALETTES.modern.roles, 'wood', 'spruce').frame, 'minecraft:stripped_spruce_log');
  // stone: foundation and a family trim move; a trim of another family (brick's polished_deepslate) stays
  const c = editMain(PALETTES.cherry.roles, 'stone', 'deepslate_bricks');
  assert.equal(c.foundation, 'minecraft:deepslate_bricks');
  assert.equal(c.trim, 'minecraft:polished_deepslate');
  assert.equal(editMain(PALETTES.brick.roles, 'stone', 'stone_bricks').trim, 'minecraft:polished_deepslate');
  // roof and accent fill one role each
  assert.equal(editMain(med, 'roof', 'deepslate_tiles').roof, 'minecraft:deepslate_tiles');
  assert.equal(editMain(med, 'roof', 'cherry').roof, 'minecraft:cherry_planks');
  assert.equal(editMain(med, 'accent', 'cherry').accent, 'minecraft:cherry_planks');
  // the edited roles still build a palette and pass the test house
  for (const n of Object.keys(PALETTES)) {
    for (const [f, v] of [['wood', 'jungle'], ['stone', 'polished_blackstone_bricks'], ['roof', 'deepslate_tiles'], ['accent', 'acacia']]) {
      const r = editMain(PALETTES[n].roles, f, v);
      const vb = validateBible({ id: 'mix', name: 'Mix', roles: r });
      assert.ok(vb.ok, `${n} ${f}=${v}: ${vb.errors.join('; ')}`);
    }
  }
  assert.throws(() => editMain(med, 'wood', 'stone_bricks'), /unknown wood/);
  assert.throws(() => editMain(med, 'stone', 'glass'), /stairs and slab/);
  assert.throws(() => editMain(med, 'roof', 'glass'), /stairs\/slab/);
  assert.throws(() => editMain(med, 'colour', 'red'), /field must be/);
});

test('provenanceOf: follows wood / follows stone, else from the Style, else by hand', () => {
  const base = PALETTES.medieval.roles;
  const p0 = provenanceOf(base, base);
  assert.equal(p0.frame, 'follows_wood');
  assert.equal(p0.foundation, 'follows_stone');
  assert.equal(p0.wall, 'style');
  const hand = { ...base, light: 'minecraft:soul_lantern' };
  assert.equal(provenanceOf(hand, base).light, 'hand');
  assert.equal(provenanceOf(editMain(base, 'wood', 'birch'), base).frame, 'follows_wood');
  assert.equal(provenanceOf(editMain(base, 'roof', 'oak'), base).roof, 'hand');
  assert.equal(provenanceOf(hand).light, 'style', 'no base: everything not following is the Style\'s');
});

test('the mod\'s fallback palettes and the parity cases are what tools/gen-palettes.mjs makes now', () => {
  const gen = (args) => spawnSync(process.execPath, [path.join(ROOT, 'tools/gen-palettes.mjs'), ...args], { encoding: 'utf8' });
  const f1 = path.join(tmp, 'p.json');
  const f2 = path.join(tmp, 'parity.json');
  assert.equal(gen(['--out', f1]).status, 0);
  assert.equal(gen(['--parity', f2]).status, 0);
  const msg = 'stale: run node tools/gen-palettes.mjs --out mod/src/main/resources/assets/architect_mc/palettes-fallback.json and --parity kit/test/fixtures/style-parity.json';
  assert.equal(fs.readFileSync(f1, 'utf8'), read('mod/src/main/resources/assets/architect_mc/palettes-fallback.json'), msg);
  assert.equal(fs.readFileSync(f2, 'utf8'), read('kit/test/fixtures/style-parity.json'), msg);
  const j = JSON.parse(fs.readFileSync(f1, 'utf8'));
  assert.deepEqual(Object.keys(j.presets), Object.keys(PALETTE_PRESETS));
  assert.deepEqual(j.presets.desert.roles, { ...PALETTES.desert.roles });
  assert.deepEqual(j.styles, styleTable());
});
