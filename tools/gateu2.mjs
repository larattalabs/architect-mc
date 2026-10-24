#!/usr/bin/env node
// Style unification U2 in-game step (docs/CONTRACT.md "Style unification U2" gate; DEV MODE: the slice's own step), on a CLIENT of a gate
// shard (the Design tab and the Variants dialog are client screens; the sim sidecar, no Claude: $0). Through the screens' DevBridge hooks
// (dev.design.*, dev.library.variants.*), driving the StyleForm behind them:
//   1. the Design tab with a Style: the chip medieval picks the built-in Style (materials, its suggested features marked as the Style's);
//      free text means no Style (no palette); the chip again keeps the features; the request carries withStyle (the roles inline) and
//      no bible; the design is done, its entry records the palette and pins medieval v1, has no bible/ folder and is built of its materials;
//   2. a custom mix: Wood -> birch and a hand-set light: the frame follows the wood, the Style's wall stays, the Wood row shows birch;
//      the request is the mix based on medieval; the design is done and built of the mix;
//   3. Save as style…: a new hand-made Style (bible.save: origin hand, editable, basedOn medieval v1, the form's features suggested);
//      the form then picks it (no longer a mix); its version folder is on disk;
//   4. a variant re-skin: the Variants dialog of design 1 with the saved Style (unedited: the 4b re-skin, bible: id); the variant is built
//      of its materials; a Wood edit in the dialog turns the request into the roles inline (the custom mix based on it).
//
//   node tools/gateu2.mjs ingame        (gate-chains.json step u2-ingame)
//
// Evidence: <GATE6B_OUT>/u2-ingame.json, all.log.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const L = await import('./lib/run6b.mjs');
const { call, check, connect, log, results, root, state } = L;
L.refuseKeys();
const GAME = process.env.ARCHITECT_GAME_DIR ? path.resolve(process.env.ARCHITECT_GAME_DIR) : L.GAME_DIR;
const LIB = path.join(GAME, 'architect', 'library');
const BIBLES = path.join(GAME, 'architect', 'bibles');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entryJson = (id) => JSON.parse(fs.readFileSync(path.join(LIB, id, `${id}.blueprint.json`), 'utf8'));
const materials = (j) => JSON.stringify(j.materials ?? {});

async function designDone(designId, timeoutMs = 600_000) {
  const end = Date.now() + timeoutMs;
  let s;
  while (Date.now() < end) {
    s = await call('dev.style.designState', { designId });
    if (['DONE', 'FAILED', 'CANCELLED'].includes(s.status)) return s;
    await sleep(2000);
  }
  return { ...s, status: 'TIMEOUT' };
}

const steps = {};
steps.ingame = async () => {
  const data = {};
  await call('dev.ui.open', { tab: 'design' });
  // ---- 1. the Design tab with a Style
  let st = await call('dev.design.fill', { reset: true, buildingType: 'cabin', style: 'medieval', size: 'M', name: 'U2 Daub Cabin', massingFirst: false });
  let f = st.form;
  data.pick = f.styleForm;
  check(f.styleForm?.style?.id === 'medieval' && f.styleForm.style.kind === 'preset' && f.styleChip === 'medieval', '1: the chip medieval picks the built-in Style', f.styleForm?.style);
  check(JSON.stringify(f.features) === '["porch","chimney","balcony"]' && f.styleForm.featureProvenance.chimney === 'style' && f.styleForm.featureProvenance.porch === 'hand',
    '1: its suggested features join the player\'s porch, marked as the Style\'s', { features: f.features, provenance: f.styleForm.featureProvenance });
  check(f.request?.palette?.bible?.id === 'medieval' && f.request.palette.bible.roles?.wall === 'minecraft:white_terracotta' && !f.request.bible && f.request.style === 'medieval',
    '1: the request carries withStyle(medieval): the roles inline, no bible', f.request?.palette);
  st = await call('dev.design.fill', { style: 'a hobbit hole under a hill' });
  check(!st.form.request?.palette && st.form.request?.style === 'a hobbit hole under a hill' && st.form.styleChip == null, '1: free text means no Style: the words go, no palette', st.form.request);
  st = await call('dev.design.fill', { style: 'medieval' });
  check(!!st.form.request?.palette && JSON.stringify(st.form.features) === '["porch","chimney","balcony"]', '1: the chip again: the Style back, the features as they were');
  const s1 = await call('dev.design.submit', {}, 30_000);
  check(!!s1.sent?.designId && !s1.sent.error, `1: Design it -> ${s1.sent?.designId}`, s1.sent);
  const d1 = s1.sent?.designId ? await designDone(s1.sent.designId) : { status: 'NONE' };
  data.design1 = d1;
  check(d1.status === 'DONE' && !!d1.entryId, '1: the design is done', { status: d1.status, error: d1.error });
  check(d1.request?.palette?.bible?.id === 'medieval' && !d1.request?.bible, '1: the sidecar got the palette and no bible', d1.request?.palette?.bible?.id);
  if (d1.entryId) {
    const j = entryJson(d1.entryId);
    data.entry1 = { palette: j.palette, bible: j.bible, materials: j.materials };
    check(j.palette?.bible?.id === 'medieval' && j.bible?.id === 'medieval' && j.bible?.version === 1, '1: the entry records the palette and pins medieval v1', { palette: j.palette?.bible?.id, bible: j.bible });
    check(!fs.existsSync(path.join(LIB, d1.entryId, 'bible')), '1: no bible/ folder: never set mode');
    const m = materials(j);
    check(/dark_oak_log/.test(m) && /stone_bricks/.test(m) && !/cobblestone/.test(m), '1: built of the Style\'s materials (dark_oak_log, stone_bricks; no cobblestone)', j.materials);
  }

  // ---- 2. a custom mix
  st = await call('dev.design.fill', { name: 'U2 Birch Mix', styleOps: [['main', 'wood', 'birch'], ['role', 'light', 'soul_lantern']] });
  f = st.form;
  data.mix = f.styleForm;
  const r = f.request?.palette?.bible?.roles ?? {};
  check(f.styleForm?.mix === true && f.request?.palette?.bible?.id === 'medieval', '2: a custom mix based on medieval', { mix: f.styleForm?.mix, id: f.request?.palette?.bible?.id });
  check(r.frame === 'minecraft:birch_log' && r.floor === 'minecraft:birch_planks' && r.wall === 'minecraft:white_terracotta' && r.light === 'minecraft:soul_lantern',
    '2: the frame and floor follow the wood, the Style\'s wall stays, the light is the player\'s', r);
  const pv = f.styleForm?.provenance ?? {};
  check(pv.frame === 'follows_wood' && pv.wall === 'style' && pv.light === 'hand' && f.styleForm.main?.wood === 'birch' && f.styleForm.mainProvenance?.wood === 'hand',
    '2: provenance: frame follows Wood, wall from the Style, light by hand; the Wood row shows birch (stored)', { pv, main: f.styleForm?.main });
  const s2 = await call('dev.design.submit', {}, 30_000);
  const d2 = s2.sent?.designId ? await designDone(s2.sent.designId) : { status: 'NONE' };
  data.design2 = d2;
  check(d2.status === 'DONE' && !!d2.entryId && d2.request?.palette?.bible?.roles?.frame === 'minecraft:birch_log', '2: the custom mix design is done', { status: d2.status, error: d2.error });
  if (d2.entryId) {
    const j = entryJson(d2.entryId);
    const m = materials(j);
    check(j.palette?.bible?.roles?.frame === 'minecraft:birch_log' && j.bible?.id === 'medieval', '2: the entry records the mix and pins the Style it is based on', { palette: j.palette?.bible?.roles?.frame, bible: j.bible });
    check(/birch_log/.test(m) && !/"minecraft:dark_oak_log"/.test(m), '2: built of the mix (birch_log; no dark_oak_log)', j.materials);
  }

  // ---- 3. Save as style…
  const sv = await call('dev.design.saveStyle', { name: 'U2 Birch Daub' }, 60_000);
  data.save = { saved: sv.saved, request: sv.request, refused: sv.refused, after: sv.form?.styleForm };
  const saved = sv.saved ?? {};
  check(!sv.refused && saved.origin === 'hand' && saved.editable === true && saved.version === 1 && saved.basedOn === 'medieval v1', '3: Save as style… makes a hand-made Style v1 based on medieval v1', sv.refused ?? saved);
  check(JSON.stringify(saved.suggestedFeatures) === '["porch","chimney","balcony"]' && saved.roles?.frame === 'minecraft:birch_log' && saved.roles?.light === 'minecraft:soul_lantern',
    '3: it carries the mix\'s roles and the form\'s features as its suggestions', { sf: saved.suggestedFeatures, frame: saved.roles?.frame });
  check(JSON.stringify(sv.request?.tags) === JSON.stringify(data.pick?.save?.tags) && sv.request?.origin === 'hand', '3: the bible.save request keeps medieval\'s tags, origin hand', sv.request?.tags);
  const af = sv.form?.styleForm;
  check(af?.style?.id === saved.styleId && af?.style?.kind === 'bible' && af?.mix === false && sv.form?.request?.palette?.bible?.id === saved.styleId,
    '3: the form now picks the saved Style (no longer a mix) and would send it', af?.style);
  if (saved.styleId) {
    const bj = path.join(BIBLES, saved.styleId, 'versions', '1', 'bible.json');
    const b = fs.existsSync(bj) ? JSON.parse(fs.readFileSync(bj, 'utf8')) : null;
    check(b?.origin === 'hand' && b?.basedOn?.id === 'medieval', '3: v1 is on disk (origin hand, basedOn medieval)', b ? { origin: b.origin, basedOn: b.basedOn } : bj);
  }

  // ---- 4. a variant re-skin with the saved Style
  if (d1.entryId && saved.styleId) {
    await call('dev.ui.open', { tab: 'library' });
    await call('dev.library.variants.open', { entry: d1.entryId });
    let vs = await call('dev.library.variants.set', { bible: saved.styleId });
    let v = vs.variants;
    data.variant = v;
    check(v?.style?.mode === 'variant' && v.style.style?.id === saved.styleId && v.request?.bible === saved.styleId && !v.request?.palette,
      '4: the saved Style picked in the Variants dialog: a re-skin (bible: id), materials only', v?.request);
    vs = await call('dev.library.variants.set', { wood: 'spruce' });
    const vr = vs.variants?.request;
    check(vr?.palette?.bible?.id === saved.styleId && vr.palette.bible.roles?.frame === 'minecraft:spruce_log' && vr.palette.bible.roles?.wall === 'minecraft:white_terracotta',
      '4: a Wood edit in the dialog: the roles inline, based on the saved Style (frame spruce, wall kept)', vr?.palette);
    vs = await call('dev.library.variants.set', { bible: saved.styleId });
    check(vs.variants?.request?.bible === saved.styleId, '4: picking the Style again reverts the edit (the re-skin again)', vs.variants?.request);
    const sub = await call('dev.library.variants.submit', {}, 30_000);
    const w = sub.jobId ? await call('dev.library.wait', { jobId: sub.jobId, timeoutMs: 180_000 }, 200_000) : {};
    data.variantJob = w;
    check(w.status === 'done' && !!w.blueprintId, `4: the variant is done (${w.blueprintId})`, w);
    if (w.blueprintId) {
      const m = materials(entryJson(w.blueprintId));
      check(/birch_log/.test(m) && !/"minecraft:dark_oak_log"/.test(m), '4: the variant is built of the saved Style\'s materials (birch_log frame; no dark_oak_log)', entryJson(w.blueprintId).materials);
    }
  }
  return data;
};

async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data, error;
  log(`== u2 ${name}`);
  try {
    if (!state.dev) await connect();
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  L.write?.(`u2-${name}.json`, { step: `u2-${name}`, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}

const name = process.argv[2];
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!steps[name]) {
    console.error(`usage: node tools/gateu2.mjs <${Object.keys(steps).join(' | ')}>`);
    process.exit(2);
  }
  await run(name);
  const f = L.fails();
  log(f ? `${f} FAILURE(S)` : 'all checks passed');
  if (state.dev) await state.dev.close?.();
  process.exit(f ? 1 : 0);
}
