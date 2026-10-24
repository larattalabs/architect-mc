#!/usr/bin/env node
// Style unification U0+U1 in-game step (docs/CONTRACT.md "Style unification" gate; DEV MODE: the slice's own step), against the headless
// server of a gate shard (the sim sidecar, no Claude: $0). Through the API, with the U1 DevBridge hooks (SliceU1Dev):
//   1. Bibles.usable lists the built-in Styles, the six authored ones among them;
//   2. a materials-only design with the built-in Style medieval (DesignRequest.withStyle): done; the entry records the palette with the
//      roles inline and the Style's pin, has no bible/ folder (never set mode), and is built of the Style's materials;
//   3. a variant with the Style's roles after a main-row edit (Wood -> birch, StyleRoles.editMain in Java): the frame follows the wood,
//      the wall (set by the Style) stays, and the variant is built of them;
//   4. a bible.save round trip: a hand-made Style saved (v1), saved again (v2) with v1's folder byte-unchanged, read back at both
//      versions, listed as usable; a built-in id refused; a design with the saved Style's roles (materials only) done.
//
//   node tools/gateu1.mjs ingame        (gate-chains.json step u1-ingame)
//
// Evidence: <GATE6B_OUT>/u1-ingame.json, all.log.
import crypto from 'node:crypto';
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
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function tree(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[path.relative(dir, f)] = sha(f); } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

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
  // 1. the usable Styles
  const u = await call('dev.style.get', { usable: true });
  data.usable = u.usable;
  for (const id of ['rustic', 'desert', 'medieval', 'nordic', 'japanese', 'cozy', 'fantasy', 'modern']) check(u.usable?.includes(id), `1: Bibles.usable lists the built-in Style ${id}`);
  const med = await call('dev.style.get', { style: 'medieval' });
  check(med.builtin === true && med.origin === 'builtin' && med.editable === false && med.roles?.wall === 'minecraft:white_terracotta', '1: medieval is a built-in, Duplicate-only Style with its authored roles', med);

  // 2. a materials-only design with medieval
  const d = await call('dev.style.design', { style: 'medieval', name: 'U1 Daub Cabin', buildingType: 'cabin' }, 120_000);
  check(!!d.designId && !d.refused, '2: Designs.request with withStyle(medieval) accepted', d);
  const dd = d.designId ? await designDone(d.designId) : { status: 'NONE' };
  data.design = dd;
  check(dd.status === 'DONE' && !!dd.entryId, '2: the materials-only design is done', { status: dd.status, error: dd.error });
  check(!dd.request?.bible && dd.request?.palette?.bible?.id === 'medieval', '2: the request carries palette (roles inline) and no bible', dd.request?.palette);
  if (dd.entryId) {
    const j = entryJson(dd.entryId);
    data.entry = { palette: j.palette, bible: j.bible, materials: j.materials };
    check(j.palette?.bible?.roles?.wall === 'minecraft:white_terracotta' && j.palette?.bible?.id === 'medieval', '2: the entry records the palette with the roles inline', j.palette);
    check(j.bible?.id === 'medieval' && j.bible?.version === 1, '2: the entry pins the Style the roles came from (medieval v1)', j.bible);
    check(!fs.existsSync(path.join(LIB, dd.entryId, 'bible')), '2: no bible/ folder: never bible set mode');
    check(/white_terracotta/.test(materials(j)) && /dark_oak_log/.test(materials(j)), '2: built of the Style\'s materials (white_terracotta wall, dark_oak_log frame)', j.materials);
  }

  // 3. a variant with the roles after a main-row edit
  if (dd.entryId) {
    const v = await call('dev.style.variant', { entryId: dd.entryId, style: 'medieval', edits: [['wood', 'birch']] }, 200_000);
    data.variant = v;
    check(!!v.entryId && !v.refused, '3: Library.makeVariant with the edited roles inline accepted and installed', v);
    check(v.roles?.frame === 'minecraft:birch_log' && v.roles?.wall === 'minecraft:white_terracotta', '3: editMain: the frame follows the wood, the Style\'s wall stays', v.roles);
    check(v.provenance?.frame === 'follows_wood' && v.provenance?.wall === 'style', '3: provenance: frame follows wood, wall from the Style', v.provenance);
    if (v.entryId) {
      const j = entryJson(v.entryId);
      check(j.palette?.bible?.roles?.frame === 'minecraft:birch_log', '3: the variant records the edited roles as its palette', j.palette);
      check(/birch_log/.test(materials(j)) && /white_terracotta/.test(materials(j)), '3: the variant is built of the edited roles (birch_log frame, white_terracotta wall)', j.materials);
    }
  }

  // 4. bible.save round trip
  const roles = { ...(med.roles ?? {}), frame: 'minecraft:spruce_log', floor: 'minecraft:spruce_planks' };
  const s1 = await call('dev.style.save', { style: { name: 'U1 Alpine', roles, tags: ['cold', 'timber'], suggestedFeatures: ['chimney'], basedOn: { id: 'medieval', version: 1 } } });
  data.save1 = s1;
  check(!s1.refused && s1.version === 1 && s1.origin === 'hand' && s1.editable === true, '4: bible.save makes a hand-made Style v1 (origin hand, editable)', s1);
  if (s1.id) {
    const v1dir = path.join(BIBLES, s1.id, 'versions', '1');
    const before = tree(v1dir);
    check(Object.keys(before).includes('bible.json'), '4: v1 is on disk', before);
    const s2 = await call('dev.style.save', { bibleId: s1.id, style: { name: 'U1 Alpine', roles: { ...roles, light: 'minecraft:soul_lantern' }, tags: ['cold'] } });
    data.save2 = s2;
    check(!s2.refused && s2.version === 2 && JSON.stringify(s2.versions) === '[1,2]', '4: a second save is v2', s2);
    check(JSON.stringify(tree(v1dir)) === JSON.stringify(before), '4: v1\'s folder is byte-unchanged by the second save');
    const g1 = await call('dev.style.get', { style: s1.id, version: 1 });
    const g2 = await call('dev.style.get', { style: s1.id });
    check(g1.roles?.light === 'minecraft:lantern' && g2.roles?.light === 'minecraft:soul_lantern' && g2.version === 2, '4: read back at v1 and at its head v2', { g1: g1.roles?.light, g2: g2.roles?.light });
    const u2 = await call('dev.style.get', { usable: true });
    check(u2.usable?.includes(s1.id), '4: the saved Style is usable');
    const bad = await call('dev.style.save', { bibleId: 'medieval', style: { name: 'Medieval', roles } });
    check(!!bad.refused && /built-in/.test(bad.refused), '4: saving over a built-in id is refused', bad);
    const d2 = await call('dev.style.design', { style: s1.id, name: 'U1 Alpine Cabin', buildingType: 'cabin' }, 120_000);
    const dd2 = d2.designId ? await designDone(d2.designId) : { status: 'NONE' };
    data.design2 = dd2;
    check(dd2.status === 'DONE' && dd2.request?.palette?.bible?.id === s1.id && dd2.request?.palette?.bible?.version === 2 && !dd2.request?.bible,
      '4: a materials-only design with the saved Style (its head, v2) is done', { status: dd2.status, error: dd2.error, palette: dd2.request?.palette?.bible?.id });
  }
  return data;
};

async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data, error;
  log(`== u1 ${name}`);
  try {
    if (!state.dev) await connect();
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  L.write?.(`u1-${name}.json`, { step: `u1-${name}`, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}

const name = process.argv[2];
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!steps[name]) {
    console.error(`usage: node tools/gateu1.mjs <${Object.keys(steps).join(' | ')}>`);
    process.exit(2);
  }
  await run(name);
  const f = L.fails();
  log(f ? `${f} FAILURE(S)` : 'all checks passed');
  if (state.dev) await state.dev.close?.();
  process.exit(f ? 1 : 0);
}
