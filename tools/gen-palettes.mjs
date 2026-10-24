#!/usr/bin/env node
// Exports the kit's palettes for the mod's Variants dialog (docs/CONTRACT.md "Variants…": preset chips plus advanced
// wood/stone/roof/accent dropdowns "from the kit's lists"). The mod's Gradle build runs it and bundles the result as
// assets/architect_mc/palettes.json; the mod prefers a sidecar snapshot.palettes when one is sent.
//
//   node tools/gen-palettes.mjs [--kit <kitDir>] [--out <file>]     (default: ../kit, stdout)
//
//   node tools/gen-palettes.mjs --parity <file>                     the Style parity cases (kit/test/fixtures/style-parity.json)
//
// Output: {"presets": {"<name>": {wood, stone, roof, accent, roles, tags, suggestedFeatures, blurb}}, "woods": [...],
// "stones": [...], "roofs": [...], "styles": <kit/lib/styles.mjs styleTable()>}. (Style unification U0) `roles` and the metadata
// are the built-in Styles' (presets with extras, e.g. desert's plaster, are only right as roles); `styles` is the fan-out table
// mod/.../library/StyleRoles.java reads. The same output is checked in as the mod's fallback
// (mod/src/main/resources/assets/architect_mc/palettes-fallback.json; kit/test/styles.test.mjs holds it current).
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

const styles = await import(pathToFileURL(path.join(kitDir, 'lib', 'styles.mjs')).href).catch(() => null);
const parityOut = opt('parity', null);
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
  const meta = styles?.styleMeta?.(name);
  if (p.roles) presets[name].roles = { ...p.roles };
  if (meta) Object.assign(presets[name], { tags: [...meta.tags], suggestedFeatures: [...meta.suggestedFeatures], blurb: meta.blurb });
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

if (parityOut) {
  fs.mkdirSync(path.dirname(parityOut), { recursive: true });
  const pc = parityCases();
  // one set and one case per line: small, and a diff shows which case moved
  const lines = ['{', ` "note": ${JSON.stringify(pc.note)},`, ' "sets": {', Object.entries(pc.sets).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n'), ' },', ' "cases": [', pc.cases.map((c) => `  ${JSON.stringify(c)}`).join(',\n'), ' ],',
    ' "formStyles": {', Object.entries(pc.formStyles).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n'), ' },',
    ' "forms": [', pc.forms.map((c) => ['  {', `   "name": ${JSON.stringify(c.name)}, "start": ${JSON.stringify(c.start)}, "ops": ${JSON.stringify(c.ops)},`,
      `   "initial": ${JSON.stringify(c.initial)},`, '   "views": [', c.views.map((v) => `    ${JSON.stringify(v)}`).join(',\n'), '   ]', '  }'].join('\n')).join(',\n'), ' ]', '}'];
  fs.writeFileSync(parityOut, `${lines.join('\n')}\n`);
  console.error(`gen-palettes: parity cases -> ${parityOut}`);
  process.exit(0);
}

const json = JSON.stringify({ presets, woods, stones, roofs, ...(styles?.styleTable ? { styles: styles.styleTable() } : {}) }, null, 2) + '\n';
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, json);
  console.error(`gen-palettes: ${Object.keys(presets).length} presets, ${woods.length} woods, ${stones.length} stones, ${roofs.length} roofs -> ${out}`);
} else {
  process.stdout.write(json);
}

/**
 * The Style parity cases (Style unification U0): every built-in Style's roles, main rows and provenance, and editMain of each
 * main row to a few values, with the provenance after it. StyleRolesTest (mod) replays them through the table.
 */
function parityCases() {
  const { mainOf, editMain, provenanceOf } = styles;
  const values = { wood: ['oak', 'spruce', 'birch', 'crimson', 'bamboo'], stone: ['cobblestone', 'deepslate_bricks', 'sandstone', 'polished_tuff', 'bricks'],
    roof: ['dark_oak', 'deepslate_tiles', 'smooth_sandstone', 'cut_copper'], accent: ['spruce', 'cherry', 'warped'] };
  const sets = Object.entries(PALETTES).map(([n, p]) => [`preset:${n}`, { ...p.roles }]);
  // a Claude-made bible's roles (the contract's Ashfall: a stone wall, a stem frame) and a hand mix
  sets.push(['bible:ashfall', { wall: 'minecraft:blackstone', wall_alt: 'minecraft:polished_blackstone_bricks', trim: 'minecraft:basalt', roof: 'minecraft:deepslate_tiles',
    floor: 'minecraft:polished_basalt', frame: 'minecraft:crimson_stem', accent: 'minecraft:crimson_planks', light: 'minecraft:shroomlight',
    glass: 'minecraft:red_stained_glass_pane', foundation: 'minecraft:blackstone', path: 'minecraft:coarse_dirt' }]);
  sets.push(['mix:stone_cottage', { ...PALETTES.oak.roles, wall: 'minecraft:stone_bricks', frame: 'minecraft:stripped_oak_log' }]);
  const cases = [];
  for (const [name, roles] of sets) {
    cases.push({ set: name, main: mainOf(roles), provenance: provenanceOf(roles, roles) });
    for (const [field, vs] of Object.entries(values)) {
      for (const v of vs) {
        let out;
        try {
          const r = editMain(roles, field, v);
          out = { roles: r, main: mainOf(r), provenance: provenanceOf(r, roles) };
        } catch (e) {
          out = { error: e.message };
        }
        cases.push({ set: name, edit: [field, v], ...out });
      }
    }
  }
  for (const bad of [['wood', 'stone_bricks'], ['stone', 'glass'], ['roof', 'glass']]) {
    cases.push({ set: 'preset:rustic', edit: bad, error: (() => { try { editMain(PALETTES.rustic.roles, ...bad); return 'none'; } catch (e) { return e.message; } })() });
  }
  const f = formCases(Object.fromEntries(sets));
  return { note: 'generated by tools/gen-palettes.mjs --parity (kit/lib/styles.mjs): the Style fan-out cases the mod replays (StyleRolesTest) and the Style form op sequences (StyleFormTest)', sets: Object.fromEntries(sets), cases, formStyles: f.styles, forms: f.forms };
}

/**
 * (Style unification U2) The Style form's parity cases: op sequences from a start state, with the view (formView) after each op, or
 * {error: true} when the op is refused (the state then stays). `pick` names a Style of `formStyles`. StyleFormTest replays them.
 */
function formCases(sets) {
  const { formNew, formApply, formView, presetStyle, formStyle } = styles;
  const fs = {};
  for (const n of Object.keys(PALETTES)) fs[n] = presetStyle(n);
  fs.ashfall = formStyle({ id: 'bib_ashfall', name: 'Ashfall', version: 3, kind: 'bible', roles: sets['bible:ashfall'], suggestedFeatures: ['basement', 'chimney'], tags: ['nether', 'foundry'] });
  fs.cottage = formStyle({ id: 'bib_stone_cottage', name: 'Stone cottage', version: 2, kind: 'bible', roles: sets['mix:stone_cottage'], suggestedFeatures: ['garden', 'chimney', 'porch', 'balcony'], tags: ['rustic', 'stone'] });
  fs.inputs = formStyle({ kind: 'inputs', inputs: { wood: 'cherry', stone: 'bricks', roof: 'deepslate_tiles', accent: 'oak' } });
  const forms = [];
  const run = (name, start, ops) => {
    let st = formNew({ ...start, style: start.style ? fs[start.style] : null });
    const views = [];
    for (const op of ops) {
      try {
        st = formApply(st, op[0] === 'pick' ? ['pick', fs[op[1]]] : op);
        views.push(formView(st));
      } catch {
        views.push({ error: true });
      }
    }
    forms.push({ name, start, initial: formView(formNew({ ...start, style: start.style ? fs[start.style] : null })), ops, views });
  };
  run('new: pick, edit each row, a hand role, swap keeps the player\'s picks, untick stays off, revert', { mode: 'new', features: ['porch'] }, [
    ['pick', 'rustic'], ['main', 'wood', 'birch'], ['main', 'stone', 'deepslate_bricks'], ['main', 'roof', 'deepslate_tiles'], ['main', 'accent', 'cherry'],
    ['role', 'light', 'soul_lantern'], ['pick', 'medieval'], ['feature', 'chimney'], ['pick', 'japanese'], ['feature', 'basement'], ['pick', 'cottage'],
    ['main', 'wood', 'spruce'], ['revert'], ['pick', 'cottage'], ['unpick'], ['pick', 'modern']]);
  run('new: a hand-set role never moves a main row (the U01 drift)', { mode: 'new', style: 'oak', features: [] }, [
    ['role', 'frame', 'birch_log'], ['main', 'wood', 'spruce'], ['main', 'wood', 'oak'], ['role', 'foundation', 'mossy_cobblestone'], ['main', 'stone', 'bricks'],
    ['revert']]);
  run('new: a Style-set wall stays, a stripped log stays one', { mode: 'new', style: 'medieval', features: ['garden'] }, [
    ['main', 'wood', 'birch'], ['main', 'wood', 'dark_oak'], ['pick', 'modern'], ['main', 'wood', 'spruce'], ['main', 'stone', 'polished_tuff'], ['pick', 'ashfall'],
    ['main', 'wood', 'warped'], ['main', 'stone', 'sandstone']]);
  run('new: features: at most 6, the list set, refusals', { mode: 'new', features: ['porch', 'garden', 'skylights', 'basement', 'courtyard'] }, [
    ['pick', 'modern'], ['feature', 'chimney'], ['feature', 'porch'], ['feature', 'chimney'], ['feature', 'moat'], ['features', ['porch', 'balcony']], ['pick', 'cottage'],
    ['features', ['porch', 'porch', 'garden']], ['main', 'wood', 'stone_bricks'], ['main', 'stone', 'glass'], ['main', 'roof', 'glass'], ['main', 'colour', 'red'],
    ['role', 'Bad', 'stone'], ['role', 'wall', 'Bad Block']]);
  run('variant: a preset entry, inputs, back to it, another preset, a preset with extras', { mode: 'variant', style: 'rustic' }, [
    ['main', 'wood', 'cherry'], ['main', 'wood', 'spruce'], ['pick', 'birch'], ['pick', 'rustic'], ['pick', 'desert'], ['main', 'wood', 'oak'],
    ['pick', 'medieval'], ['main', 'wood', 'birch'], ['revert'], ['role', 'light', 'soul_lantern'], ['feature', 'porch']]);
  run('variant: an installed Style re-skin, edited, a hand role', { mode: 'variant', style: 'brick' }, [
    ['pick', 'ashfall'], ['main', 'roof', 'oak'], ['revert'], ['pick', 'cottage'], ['role', 'wall', 'calcite'], ['pick', 'brick']]);
  run('variant: an entry with plain inputs', { mode: 'variant', style: 'inputs' }, [
    ['main', 'roof', 'spruce'], ['role', 'light', 'glowstone'], ['main', 'roof', 'deepslate_tiles'], ['pick', 'cherry'], ['main', 'stone', 'cobblestone']]);
  run('variant: an entry with no palette', { mode: 'variant' }, [['main', 'wood', 'oak'], ['pick', 'dark'], ['main', 'accent', 'birch'], ['unpick']]);
  // every built-in Style: picked on a new form, each row edited once
  for (const n of Object.keys(PALETTES)) {
    run(`new: ${n}, each row`, { mode: 'new', features: [] }, [['pick', n], ['main', 'wood', 'jungle'], ['main', 'stone', 'polished_blackstone_bricks'], ['main', 'roof', 'cut_copper'],
      ['main', 'accent', 'acacia'], ['role', 'path', 'gravel'], ['revert']]);
  }
  return { styles: fs, forms };
}
