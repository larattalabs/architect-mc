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
import { FEATURE_IDS, MAX_SUGGESTED_FEATURES, STYLE_META, editMain, editMainFrom, fanOut, formApply, formNew, formSaveRequest, formStyle, formView, mainOf, presetStyle, provenanceOf, styleTable } from '../lib/styles.mjs';
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

// ------------------------------------------------------------------ the Style form (Style unification U2)

const apply = (st, ...ops) => ops.reduce((s, op) => formApply(s, op), st);

test('U2 form: picking a Style fills the materials and its suggested features, marked from the Style', () => {
  const st = apply(formNew({ mode: 'new', features: ['porch'] }), ['pick', presetStyle('medieval')]);
  const v = formView(st);
  assert.equal(v.style.id, 'medieval');
  assert.deepEqual(v.roles, { ...PALETTES.medieval.roles });
  assert.deepEqual(v.main, { wood: 'dark_oak', stone: 'stone_bricks', roof: 'spruce', accent: 'spruce' });
  assert.deepEqual(v.features, ['porch', 'chimney', 'balcony']);
  assert.deepEqual(v.featureProvenance, { porch: 'hand', chimney: 'style', balcony: 'style' });
  assert.equal(v.provenance.frame, 'follows_wood');
  assert.equal(v.provenance.wall, 'style');
  assert.equal(v.mix, false);
  // unedited: withStyle (the roles inline, the Style's id and version)
  assert.deepEqual(v.request, { palette: { bible: { id: 'medieval', version: 1, roles: { ...PALETTES.medieval.roles } } } });
});

test('U2 form: an edit makes a custom mix based on the Style; revert undoes it; the main rows are stored, not read back', () => {
  let st = apply(formNew({ mode: 'new' }), ['pick', presetStyle('medieval')], ['main', 'wood', 'birch']);
  let v = formView(st);
  assert.equal(v.mix, true);
  assert.equal(v.roles.frame, 'minecraft:birch_log');
  assert.equal(v.roles.wall, 'minecraft:white_terracotta', 'the Style set the wall: it stays');
  assert.equal(v.mainProvenance.wood, 'hand');
  assert.equal(v.request.palette.bible.id, 'medieval', 'a custom mix names the Style it is based on');
  assert.equal(formView(apply(st, ['revert'])).mix, false);
  // the U01 drift: a hand-set frame of another wood does not move the Wood row, and a later Wood edit leaves it alone
  st = apply(formNew({ mode: 'new' }), ['pick', presetStyle('oak')], ['role', 'frame', 'birch_log']);
  assert.equal(mainOf(st.roles).wood, 'birch', 'read back from the roles, the Wood row would drift');
  v = formView(st);
  assert.equal(v.main.wood, 'oak');
  assert.equal(v.provenance.frame, 'hand');
  v = formView(apply(st, ['main', 'wood', 'spruce']));
  assert.equal(v.roles.frame, 'minecraft:birch_log');
  assert.equal(v.roles.wall, 'minecraft:spruce_planks');
  assert.equal(v.main.wood, 'spruce');
  // editMain is editMainFrom with the rows read back: the U1 cases are unchanged
  assert.deepEqual(editMain(PALETTES.medieval.roles, 'wood', 'birch'), editMainFrom(PALETTES.medieval.roles, 'wood', 'birch', 'dark_oak', ['frame', 'floor']));
});

test('U2 form: swapping Styles keeps the player\'s picks, replaces untouched suggestions, never re-adds one turned off', () => {
  let st = apply(formNew({ mode: 'new', features: ['porch'] }), ['pick', presetStyle('rustic')]);
  assert.deepEqual(st.features, ['porch', 'chimney']);
  st = apply(st, ['feature', 'chimney'], ['feature', 'garden'], ['pick', presetStyle('medieval')]);
  assert.deepEqual(st.features, ['porch', 'garden', 'balcony'], 'chimney was turned off: medieval does not add it back');
  st = apply(st, ['pick', presetStyle('japanese')]);
  assert.deepEqual(st.features, ['porch', 'garden', 'courtyard'], 'balcony (untouched) went; garden is the player\'s, not marked from japanese');
  assert.deepEqual(formView(st).featureProvenance, { porch: 'hand', garden: 'hand', courtyard: 'style' });
  // at most 6; picking the same Style again reverts the materials only
  st = apply(formNew({ mode: 'new', features: ['porch', 'garden', 'skylights', 'basement', 'courtyard'] }), ['pick', presetStyle('modern')]);
  assert.equal(st.features.length, 6);
  assert.throws(() => formApply(st, ['feature', 'chimney']), /at most 6/);
  const same = apply(st, ['main', 'wood', 'oak'], ['pick', presetStyle('modern')]);
  assert.deepEqual(same.features, st.features);
  assert.equal(formView(same).mix, false);
});

test('U2 form: variant mode: WHAT is fixed, a Style swap re-skins materials only, the smallest request', () => {
  const v0 = formNew({ mode: 'variant', style: presetStyle('rustic') });
  assert.deepEqual(formView(v0).request, {});
  assert.throws(() => formApply(v0, ['feature', 'porch']), /fixed/);
  assert.deepEqual(formView(apply(v0, ['pick', presetStyle('birch')])).request, { palette: 'birch' });
  assert.deepEqual(formView(apply(v0, ['main', 'wood', 'cherry'])).request, { palette: { wood: 'cherry', stone: 'cobblestone', roof: 'dark_oak', accent: 'dark_oak' } });
  // a preset with extras edited: the roles inline (inputs would lose desert's plaster)
  const d = formView(apply(v0, ['pick', presetStyle('desert')], ['main', 'wood', 'oak']));
  assert.equal(d.request.palette.bible.id, 'desert');
  assert.equal(d.request.palette.bible.roles.wall_alt, 'minecraft:smooth_sandstone');
  // an installed Style: unedited the 4b re-skin (bible: id), edited inline
  const ash = formStyle({ id: 'bib_ash', name: 'Ash', version: 2, kind: 'bible', roles: PALETTES.crimson.roles });
  assert.deepEqual(formView(apply(v0, ['pick', ash])).request, { bible: 'bib_ash' });
  assert.equal(formView(apply(v0, ['pick', ash], ['main', 'roof', 'oak'])).request.palette.bible.version, 2);
});

test('U2 form: Save as style is a bible.save request: roles, tags, suggestedFeatures, basedOn, origin hand', () => {
  const st = apply(formNew({ mode: 'new', features: ['garden'] }), ['pick', presetStyle('medieval')], ['main', 'wood', 'birch']);
  const s = formSaveRequest(st, 'Birch daub');
  assert.deepEqual(s, { name: 'Birch daub', roles: { ...st.roles }, tags: [...STYLE_META.medieval.tags], suggestedFeatures: ['garden', 'chimney', 'balcony'], basedOn: { id: 'medieval', version: 1 }, origin: 'hand' });
  assert.equal(formSaveRequest(st).name, 'Medieval mix');
  const vb = validateBible({ id: 'bib_birch_daub', ...s });
  assert.ok(vb.ok, vb.errors.join('; '));
  assert.equal(formSaveRequest(formNew({ mode: 'new' })), null);
});
