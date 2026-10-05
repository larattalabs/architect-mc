#!/usr/bin/env node
// Phase 2 library check, headless through the DevBridge (docs/CONTRACT.md "Mod: library screen"). Run against a dev client
// started with tools/run-p2-client.sh (stub sidecar, ports 7990/7991), in a dev world only.
//
//   ARCHITECT_DEV_PORT=7991 ARCHITECT_GAME_DIR=mod/run node tools/p2-library-check.mjs before   designs, metadata, variants,
//                                                                    remix, export, import, reload, delete; saves the state
//   (restart the client)
//   ARCHITECT_DEV_PORT=7991 ARCHITECT_GAME_DIR=mod/run node tools/p2-library-check.mjs after    metadata survived the restart
//
// Screenshots go where the mod writes them (ARCHITECT_SHOTS_DIR, artifacts/mod-p2 with run-p2-client.sh); JSON evidence to
// <shots>/../mod-p2/*.json. Exit code 1 when a check fails.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevClient, DEFAULT_PORT } from './lib/devclient.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gameDir = path.resolve(process.env.ARCHITECT_GAME_DIR || path.join(repo, 'mod', 'run'));
const outDir = path.join(repo, 'artifacts', 'mod-p2');
fs.mkdirSync(outDir, { recursive: true });
const phase = process.argv[2] || 'before';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);
let failed = 0;
const check = (ok, what, detail) => {
  if (!ok) failed++;
  log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail === undefined ? '' : ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`);
};
const save = (name, obj) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(obj, null, 2));

const dev = await DevClient.connect({ port: DEFAULT_PORT, timeoutMs: 120_000 });
await dev.waitInWorld({ timeoutMs: 300_000 });
const call = (type, payload = {}) => dev.call(type, payload);
const shot = async (name) => {
  await call('dev.wait', { frames: 8 });
  const r = await call('dev.screenshot', { name, hideHud: false, waitChunks: false });
  log(`shot ${r.path}`);
};
const state = () => call('dev.library.state');
const card = (st, id) => st.cards.find((c) => c.id === id);

async function design(fields) {
  const r = await call('dev.design.submit', { fields: { reset: true, ...fields } });
  const id = r.sent.designId;
  for (let i = 0; i < 60; i++) {
    const s = await call('dev.sidecar.state');
    const d = s.designs.find((x) => x.id === id);
    if (d && d.status === 'done' && d.blueprintId) {
      await sleep(800); // the reload after done
      return d.blueprintId;
    }
    if (d && d.status === 'failed') throw new Error(`design ${id} failed: ${d.error}`);
    await sleep(500);
  }
  throw new Error(`design ${id} did not finish`);
}

try {
  await call('dev.command', { cmd: '/time set 6000' });
  if (phase === 'before') {
    // ------------------------------------------------------------ designs (stub "Claude")
    const cabin = await design({ buildingType: 'cabin', style: 'rustic', name: 'Lakeside Cabin', notes: 'by the lake' });
    const tower = await design({ buildingType: 'tower', style: 'medieval', name: 'Watch Post', size: 'L' });
    check(cabin === 'gen_lakeside_cabin' && tower === 'gen_watch_post', 'two designs installed', [cabin, tower]);

    // ------------------------------------------------------------ metadata: a user entry (in place) and a bundled one (overlay)
    await call('dev.library.filter', { reset: true });
    await call('dev.library.favorite', { entry: cabin, on: true });
    await call('dev.library.tag', { entry: cabin, tags: ['mine', 'lake side'] });
    await call('dev.library.rename', { entry: cabin, name: 'Lakeside Retreat' });
    await call('dev.library.favorite', { entry: 'cabin', on: true });
    await call('dev.library.tag', { entry: 'cabin', tags: 'Mine, classic' });
    await call('dev.library.rename', { entry: 'cabin', name: "Grandpa's Cabin" });
    await call('dev.library.tag', { entry: tower, tags: ['tall'] });
    let st = await call('dev.library.select', { entry: cabin });
    const sc = JSON.parse(fs.readFileSync(path.join(gameDir, 'architect', 'library', cabin, `${cabin}.blueprint.json`), 'utf8'));
    check(sc.favorite === true && sc.displayName === 'Lakeside Retreat' && JSON.stringify(sc.userTags) === '["mine","lake_side"]' && sc.params,
      'user entry edited in place, other keys kept', { favorite: sc.favorite, displayName: sc.displayName, userTags: sc.userTags, params: !!sc.params });
    const ov = JSON.parse(fs.readFileSync(path.join(gameDir, 'architect', 'library-meta.json'), 'utf8'));
    check(ov.entries?.cabin?.displayName === "Grandpa's Cabin" && ov.entries.cabin.favorite === true, 'bundled entry in the overlay', ov.entries?.cabin);
    await shot('p2_01_library_grid');

    // ------------------------------------------------------------ filters
    st = await call('dev.library.filter', { tag: 'mine', favorites: true });
    check(st.cards.map((c) => c.id).sort().join() === ['cabin', cabin].sort().join(), 'filter: tag mine + starred', st.cards.map((c) => c.id));
    await call('dev.ui.click', { control: 'filter:tag' });
    await shot('p2_02_library_filters_tag_popup');
    await call('dev.ui.click', { control: 'option:tag:mine' });
    st = await call('dev.library.filter', { reset: true, text: 'watch' });
    check(st.cards.length === 2, 'search "watch" (Watch Post + Watchtower)', st.cards.map((c) => c.id));
    st = await call('dev.library.filter', { reset: true, sort: 'size' });
    check(st.cards[0].id === cabin || st.cards[0].size <= st.cards[st.cards.length - 1].size, 'sort by size', st.cards.map((c) => c.id + ' ' + c.size));
    await call('dev.library.filter', { reset: true });

    // ------------------------------------------------------------ detail + rename editor
    await call('dev.library.select', { entry: cabin });
    await call('dev.ui.click', { control: 'view:top' });
    await shot('p2_03_detail_top_view');
    await call('dev.ui.click', { control: 'view:iso' });
    await call('dev.ui.click', { control: 'rename' });
    await call('dev.type', { text: ' by the Lake' });
    await shot('p2_03b_detail_rename_editor');
    await call('dev.key', { key: 'escape' }); // cancels: the name stays
    st = await state();
    check(st.selected.name === 'Lakeside Retreat', 'Esc cancels a rename', st.selected.name);

    // ------------------------------------------------------------ variants
    st = await call('dev.library.variants.open', { entry: cabin });
    check(st.variants.params.length === 4, 'controls from params', st.variants.params.map((p) => p.kind + ':' + p.name));
    await call('dev.library.variants.set', { preset: 'birch' });
    await shot('p2_04_variants_dialog');
    await call('dev.ui.click', { control: 'palette:wood' });
    await shot('p2_04b_variants_wood_dropdown');
    await call('dev.ui.click', { control: 'option:palette:wood:cherry' });
    await call('dev.library.variants.set', { preset: 'birch' });
    let r = await call('dev.library.variants.submit');
    await call('dev.wait', { frames: 4 });
    await shot('p2_05_designs_variant_progress');
    let w = await call('dev.library.wait', { jobId: r.jobId });
    check(w.status === 'done', 'variant 1 (birch palette)', w.blueprintId);
    const v1 = w.blueprintId;
    await call('dev.library.variants.open', { entry: cabin });
    await call('dev.library.variants.set', { preset: 'dark' });
    w = await call('dev.library.wait', { jobId: (await call('dev.library.variants.submit')).jobId });
    check(w.status === 'done', 'variant 2 (dark palette)', w.blueprintId);
    await call('dev.library.variants.open', { entry: cabin });
    st = await call('dev.library.variants.set', { steps: { floors: 1 } });
    check(JSON.stringify(st.variants.request) === JSON.stringify({ from: cabin, values: { floors: 2 } }), 'param change sends only floors', st.variants.request);
    w = await call('dev.library.wait', { jobId: (await call('dev.library.variants.submit')).jobId });
    check(w.status === 'done', 'variant 3 (floors 2)', w.blueprintId);
    await call('dev.ui.open', { tab: 'designs' });
    await shot('p2_05b_designs_variants_done');
    st = await call('dev.library.filter', { reset: true, text: 'lakeside' });
    const vcard = card(st, v1);
    check(vcard && vcard.badge === 'VARIANT', 'variant listed with a badge', vcard);
    st = await call('dev.library.select', { entry: v1 });
    check(st.selected.provenance.startsWith('variant of'), 'provenance', st.selected.provenance);
    await shot('p2_06_variant_in_library');

    // ------------------------------------------------------------ remix
    r = await call('dev.library.remix', { entry: cabin });
    check(r.remix === cabin && r.notes === '' && r.focus === 'notes' && r.screenTab === 'design', 'remix prefill', { remix: r.remix, focus: r.focus,
      type: r.type, style: r.style, name: r.name });
    await shot('p2_07_remix_prefilled');
    await call('dev.design.fill', { reset: true });

    // ------------------------------------------------------------ export
    await call('dev.library.filter', { reset: true });
    r = await call('dev.library.export', { entry: v1 });
    const files = r.files.map((f) => ({ f, exists: fs.existsSync(f) }));
    check(files.every((x) => x.exists) && fs.existsSync(r.worldFile) && r.structureLoads, 'export files + structure loads', r);
    save('export.json', { ...r, files });
    await shot('p2_08_export_done');

    // ------------------------------------------------------------ import
    const imports = path.join(gameDir, 'architect', 'imports');
    fs.mkdirSync(imports, { recursive: true });
    fs.copyFileSync(path.join(repo, 'kit', 'examples', 'tower', 'tower.nbt'), path.join(imports, 'Old Tower.nbt'));
    st = await call('dev.library.import.list');
    check(st.importList.some((x) => x.where === 'world' && x.structureId === `architect_mc:${v1}`) && st.importList.some((x) => x.where === 'imports'),
      'import list: imports/ + this world', st.importList.map((x) => x.label));
    await shot('p2_09_import_list');
    r = await call('dev.library.import.pick', { path: path.join(gameDir, 'saves', 'Architect Dev', 'generated', 'architect_mc', 'structure', `${v1}.nbt`) });
    w = await call('dev.library.wait', { jobId: r.jobId });
    check(w.status === 'done', 'import of the exported structure', w.blueprintId);
    st = await call('dev.library.select', { entry: w.blueprintId });
    check(st.selected.badge === 'IMPORTED' && st.selected.canVariant === false, 'imported: badge, no variants', st.selected);
    await call('dev.ui.open', { tab: 'library' });
    await shot('p2_10_imported_entry');

    // ------------------------------------------------------------ reload keeps metadata, delete
    await call('dev.command', { cmd: '/architect reload' });
    await sleep(1000);
    st = await state();
    check(card(st, cabin)?.name === 'Lakeside Retreat' && card(st, 'cabin')?.name === "Grandpa's Cabin" && card(st, 'cabin')?.favorite,
      '/architect reload keeps metadata', [card(st, cabin), card(st, 'cabin')]);
    st = await call('dev.library.delete', { entry: tower });
    check(!card(st, tower) && fs.readdirSync(path.join(gameDir, 'architect', 'library-trash')).some((d) => d.startsWith(tower)), 'delete to the trash');
    try {
      await call('dev.library.delete', { entry: 'tower' });
      check(false, 'a bundled entry refuses delete');
    } catch (e) {
      check(/bundled/.test(e.message), 'a bundled entry refuses delete', e.message);
    }
    save('state-before-restart.json', await state());
  } else {
    // ------------------------------------------------------------ after a client restart
    const before = JSON.parse(fs.readFileSync(path.join(outDir, 'state-before-restart.json'), 'utf8'));
    await call('dev.library.filter', { reset: true });
    const st = await state();
    save('state-after-restart.json', st);
    const pick = (s) => s.cards.map((c) => [c.id, c.name, c.favorite, c.userTags.join(','), c.badge]).sort();
    check(JSON.stringify(pick(before)) === JSON.stringify(pick(st)), 'names, stars, tags, badges identical after the restart', pick(st));
    await call('dev.library.filter', { favorites: true });
    await call('dev.library.select', { entry: 'gen_lakeside_cabin' });
    await shot('p2_11_after_restart_starred');
    await call('dev.library.filter', { reset: true });
  }
} catch (e) {
  failed++;
  log(`FAIL ${e.message}`);
} finally {
  dev.close();
}
log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
