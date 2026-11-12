#!/usr/bin/env node
// Slice SL gate (7b site lots; docs/CONTRACT.md "Phase 7b" slice SL row 9, "Slice SL as built") against the headless server of the SL run
// worktree (GATE6B_RUN, default `../architect-mc-SL-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). Ports
// 8896 (sidecar) / 8897 (DevBridge) by default. $0: no Claude call anywhere.
//
//   node tools/gate7bsl.mjs <step>
//     unit     (sl-unit)    offline: kit/test/sl.test.mjs (r.siteLot, the reserved box and host, layout.elevated's answers, the artifact's
//                           lots[].site, the catalogue flip) and the 7b/P0 tests it touches; the Java ApiSLTest and Api7bFTest; byte
//                           identity: every committed plan fixture planned here and on the merge base (../architect-mc-SL-main) identical
//                           but the named ones (SL_MOVED); the 59 asks re-made here and on the merge base: only the asks that waited on
//                           layout.elevated move, 0 malformed, the after table equal to kit/test/fixtures/plan/sl/asks-after.txt
//     ingame   (sl-ingame)  on a flat world (headless, exact rules), a giant tree built by commands (a 3x3 log trunk 20 tall, a 15x15
//                           persistent leaf layer 5 thick): one Steward-shaped plan/0 per new answer of layout.elevated through
//                           Regions.checkPlan then realiseApproved:
//                             fits     one canopy hut: a wrap_trunk site lot; LotSpec.site (dev.sl.plan) is the artifact's site; the
//                                      mod's own Survey.volume of the lot's volume has the plan's sha (the kit's cut = the mod's freeze);
//                                      Regions.affordances answers the plan's; SV's fit_wrap_trunk built on the lot's Site (a $0 site
//                                      variant) and bound; a bundled design of another size and a copy bound to another volume refused
//                                      at bind (nothing written); realiseApproved PLACED: the lot's record at the site's frame with
//                                      architect_mc:site, the template's cells written, every other cell of the site volume unchanged
//                                      (KEEP: the trunk and leaves), Remove E-flat 0 over the claim
//                             adjusted two huts on one tree: one placed (the count tolerance), realised with no entry: nothing
//                                      written (a site lot writes no pad), E-flat 0
//                             refused  a zone over open flat land (required false): refused NO_FEATURE; realiseApproved writes nothing
//                           and a Steward-shaped massingFirst group with the fits plan's site lot as an item (Steward's DS answers,
//                           2026-11-12): the site item waits while the other item's massing designs and awaits approval, then designs
//                           in one pass (no massing) in the same group after the approval
//     report                REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7b-sl/<step>.json in the main checkout (GATE7BSL_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-SL-run');
process.env.GATE6B_OUT = process.env.GATE7BSL_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7b-sl');
process.env.GATE6B_SIDECAR_PORT ??= '8896';
process.env.GATE6B_DEV_PORT ??= '8897';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, fails, log, results, root, state } = L;

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
/** JSON with object keys sorted (the mod's wire and the kit's may order members differently). */
const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));
const FLAT = 'G6B Flat Base';
const OWNER = 'test:sl';
/** The tree's axis on the flat world. */
const TX = 9600, TZ = 9600;

/** The fixtures that move by name (byte identity): the recorded asks that waited on layout.elevated. (e15 lost its elevated zone, but
 * both sides plan the head's fixture, so it does not move.) */
export const SL_MOVED = Object.freeze({
  'asks/treetop_village.json': 'SL: canopy (layout.elevated) answers refused NO_FEATURE on the flat asks claim (was unsupported until 7b); its bridges stay blocked DEPENDENCY',
  'asks/swamp_stilts.json': 'SL: hollow (layout.elevated) answers refused NO_FEATURE on the flat asks claim (was unsupported until 7b); its bridges stay blocked DEPENDENCY',
  'asks/upside_down.json': 'SL: hanging_village (layout.elevated) answers refused NO_FEATURE on the flat asks claim (was unsupported until 7b); its bridge stays blocked DEPENDENCY',
});
const ASKS_MOVE = /^(treetop_village|swamp_stilts|upside_down)\//;

const steps = {};
async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data, error;
  log(`== ${name}`);
  try {
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  if (name !== 'report') L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice SL is $0: sim only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ offline

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);

steps.unit = async () => {
  const out = {};
  out.kit = kitOnce(['kit/test/sl.test.mjs', 'kit/test/f7b-foundation.test.mjs', 'kit/test/af-affordances.test.mjs', 'kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/f7a-foundation.test.mjs', 'kit/test/gm-c.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 30, `kit: sl.test.mjs (r.siteLot's site wire, the cut volume, keep cells, default ports, refusals; the reserved box and its host; layout.elevated fits, adjusted, refused, the first plan's VOLUME, connectors until LP; the artifact's lots[].site; the catalogue flip) and the 7b/P0 tests it touches: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', '-q', '--tests', 'dev.larattalabs.architect.region.ApiSLTest', '--tests', 'dev.larattalabs.architect.api.Api7bFTest'], { cwd: path.join(root, 'mod'), encoding: 'utf8', env, timeout: 1_800_000 });
  out.java = { code: g.status, tail: `${g.stdout}${g.stderr}`.split('\n').filter((l) => /FAIL|error/i.test(l)).slice(0, 10) };
  check(g.status === 0, 'Java: ApiSLTest (LotSpec.site from the IR, the bind check, the general freeze box, the region volume lookup, hasElevated, the feature) and Api7bFTest', out.java.tail);
  // byte identity against the merge base, the named exceptions aside
  const K = await import('./lib/gate7a-kit.mjs');
  const u = await K.unchanged(root, { check, log, base: 'SL', except: SL_MOVED, mergedIf: 'kit/lib/region/siteLots.mjs' });
  out.unchanged = { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, moved: u.moved };
  fs.writeFileSync(path.join(OUT, 'sl-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  // the 59 asks on the merge base and here
  const B = await import('./lib/gate6chy-b.mjs');
  // (current: the asks as they stand: the three that wait on layout.elevated are among Steward's 12 re-recorded plans (close-out A))
  const before = await B.asksGap(path.join(path.resolve(root, '..', 'architect-mc-SL-main'), 'kit'), { current: true }), after = await B.asksGap(KIT, { current: true });
  fs.writeFileSync(path.join(OUT, 'sl-asks-before.txt'), before.text);
  fs.writeFileSync(path.join(OUT, 'sl-asks-after.txt'), after.text);
  const lines = (t) => new Map(t.split('\n').filter((l) => /^[a-z_0-9]+\/[a-z_0-9]+ /.test(l)).map((l) => [l.split(' ')[0], l]));
  const lb = lines(before.text), la = lines(after.text);
  const moved = [...new Set([...la.keys(), ...lb.keys()])].filter((k) => lb.get(k) !== la.get(k));
  const F = path.join(KIT, 'test', 'fixtures', 'plan', 'sl');
  out.asks = { moved, malformed: after.malformed, committedAfter: fs.existsSync(path.join(F, 'asks-after.txt')) && fs.readFileSync(path.join(F, 'asks-after.txt'), 'utf8') === after.text, committedBefore: fs.existsSync(path.join(F, 'asks-before.txt')) && fs.readFileSync(path.join(F, 'asks-before.txt'), 'utf8') === before.text };
  check(after.malformed === 0 && moved.length > 0 && moved.every((k) => ASKS_MOVE.test(k)) && out.asks.committedAfter && out.asks.committedBefore,
    `the 59 asks on the merge base and here: 0 malformed; only the asks that waited on layout.elevated move (${moved.join(', ')}); both tables equal fixtures/plan/sl/asks-{before,after}.txt (${out.asks.committedBefore}, ${out.asks.committedAfter})`);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ cells

function norm(s) {
  const m = /^([^[]+)(?:\[([^\]]*)\])?$/.exec(String(s));
  if (!m) return String(s);
  const id = m[1].includes(':') ? m[1] : `minecraft:${m[1]}`;
  const props = m[2] ? m[2].split(',').filter(Boolean).sort() : [];
  return props.length ? `${id}[${props.join(',')}]` : id;
}
function asState(nbt) {
  const bs = /^Block\{([a-z0-9_.-]+:[a-z0-9_./-]+)\}(\[[^\]]*\])?/.exec(nbt);
  if (bs) return norm(`${bs[1]}${bs[2] ?? ''}`);
  const n = /(?:Name|id)\s*:\s*["']?([a-z0-9_.-]+:[a-z0-9_./-]+)/i.exec(nbt)?.[1];
  if (!n) return nbt;
  const pm = /properties\s*:\s*\{([^}]*)\}/i.exec(nbt)?.[1];
  const props = pm ? [...pm.matchAll(/["']?([a-z0-9_]+)["']?\s*:\s*["']?([a-z0-9_]+)["']?/g)].map((m) => `${m[1]}=${m[2]}`).sort() : [];
  return props.length ? `${n}[${props.join(',')}]` : n;
}
const idOf = (s) => String(s).replace(/\[.*$/, '').replace(/^minecraft:/, '');
const k3 = (x, y, z) => `${x},${y},${z}`;
async function cellsOf(b) {
  const h = await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]], cells: true }, 300_000);
  return new Map((h.cells ?? []).map((l) => { const sp = l.indexOf(' '); return [l.slice(0, sp), asState(l.slice(sp + 1).split(' be=')[0])]; }));
}
function diff(a, b, skip = null) {
  const out = [];
  let n = 0;
  for (const [k, v] of a) {
    if (skip?.has(k)) continue;
    if (b.get(k) !== v) { n++; if (out.length < 6) out.push(`${k} ${v} -> ${b.get(k)}`); }
  }
  return { n, first: out };
}
async function groundY() {
  const h = await call('dev.box.hash', { min: [TX + 30, -64, TZ + 30], max: [TX + 30, 250, TZ + 30], cells: true }, 120_000);
  let g = -64;
  for (const l of h.cells ?? []) { const [k, ...rest] = l.split(' '); const y = Number(k.split(',')[1]); if (idOf(asState(rest.join(' '))) !== 'air' && y > g) g = y; }
  return g;
}
const arr = (b) => [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ];
/** A frozen volume's file in the run's saves (architect/volumes/<sha>.bin of any world), or null. */
function volumeFile(sha) {
  for (const w of fs.existsSync(L.SAVES) ? fs.readdirSync(L.SAVES) : []) {
    const f = path.join(L.SAVES, w, 'architect', 'volumes', `${sha}.bin`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// ------------------------------------------------------------------ in game

/** A plan/0 with one elevated zone `canopy` near the anchor `at` (lots: [[id, size]]). */
function elevatedPlan(lots, { required = true } = {}) {
  return { schemaVersion: 'plan/0', planId: 'sl_canopy', zones: [{ id: 'canopy', kind: 'standard', required, size: { preset: 'M' }, where: { near: { anchor: 'grove', within: 8 } },
    program: { layout: 'elevated', lots: lots.map(([id, size]) => ({ id, type: 'cabin', role: 'canopy_hut', size, villager: 'dwelling', brief: 'A small home on its tree\'s platform.' })) } }] };
}

async function checkPlan(tag, plan, anchor, claim) {
  const ck = await call('dev.region.checkPlan', { plan, claim, owner: OWNER, anchors: { grove: anchor }, load: 'generate' }, 1_800_000);
  fs.writeFileSync(path.join(OUT, `${tag}-check.json`), `${JSON.stringify(ck, null, 1)}\n`);
  return ck;
}

steps.ingame = async () => {
  await ensure();
  spendZero();
  const out = {};
  await L.fresh('G6B SL Ingame', FLAT);
  await L.setRules('exact');
  await L.tp(TX - 20, 0, TZ - 30);
  const gy = await groundY();
  out.groundY = gy;
  // the giant tree: a 3x3 oak trunk 20 tall, a 15x15 persistent leaf layer 5 thick over it
  await cmd(`/fill ${TX - 1} ${gy + 1} ${TZ - 1} ${TX + 1} ${gy + 20} ${TZ + 1} minecraft:oak_log`);
  await cmd(`/fill ${TX - 7} ${gy + 21} ${TZ - 7} ${TX + 7} ${gy + 25} ${TZ + 7} minecraft:oak_leaves[persistent=true]`);
  await L.settle(1500);
  const anchor = [TX, gy + 1, TZ];
  const claim = [TX - 80, TZ - 80, TX + 79, TZ + 79];
  const claimBox = [claim[0], gy - 4, claim[1], claim[2], gy + 60, claim[3]];

  // ---- fits: one canopy hut, realised with SV's trunk house built on its site
  {
    const r = {};
    const ck = await checkPlan('fits', elevatedPlan([['hut', [17, 17]]]), anchor, claim);
    const a = ck.check?.parts?.find((p) => p.part === 'canopy');
    r.check = { overall: ck.check?.overall, canopy: a?.class, notes: a?.notes, reasons: a?.reasons };
    check(ck.check?.overall === 'READY' && a?.class === 'fits', `fits: an elevated zone over the tree through Regions.checkPlan: ${ck.check?.overall}, canopy ${a?.class} ${json(a?.reasons ?? a?.notes)}`);
    const art = ck.check?.artifactSha ? await call('dev.region.artifact', { sha: ck.check.artifactSha, body: true }, 60_000) : null;
    const lot = art?.artifact?.body?.lots?.find((l) => l.id === 'hut');
    r.lot = lot ? { box: lot.box, front: lot.front, affordance: lot.affordance, fit: lot.site?.fit, frame: lot.site?.frame, volume: lot.site?.volume, sha: lot.site?.volumeSha, keep: lot.site?.keepCritical?.length, ports: lot.site?.ports } : null;
    check(!!lot?.site && lot.site.fit === 'wrap_trunk' && lot.site.lotId === 'hut' && json(lot.site.frame.origin) === json(lot.box.slice(0, 3)) && lot.site.keepCritical.length > 0 && json(lot.fitBox) === json(lot.box) && lot.entrance === null && ['canopy', 'trunk'].includes(lot.affordance?.kind),
      `fits: the artifact's lots[] hut carries site (wrap_trunk, its frame at the box's corner, ${lot?.site?.keepCritical?.length} keep-critical logs), fitBox = box, no entrance, affordance ${json(lot?.affordance)}`, r.lot);
    if (!lot?.site) { out.fits = r; return out; }
    // the mod's own freeze of the lot's volume has the plan's sha (the kit cut it from the zone's volume)
    const sv = await call('dev.survey.volume', { box: arr(lot.site.volume), load: 'loaded' }, 600_000);
    r.survey = { sha: sv.sha, missing: sv.missingColumns };
    check(sv.sha === lot.site.volumeSha && sv.missingColumns === 0, `fits: Survey.volume of the lot's site volume freezes the plan's sha (${String(sv.sha).slice(0, 12)}): the kit's cut equals the mod's survey`, { sv: sv.sha, plan: lot.site.volumeSha });
    // (Steward's DS answers 2026-11-12) a Steward-shaped massingFirst group with the site lot as an item: it waits for the group's
    // massing step, then designs in one pass in the same group (the sim designer)
    {
      const gq = await call('dev.sl.group', { name: 'sl_mf', items: [{ key: 'hall', size: [20, 24, 20] }, { key: 'hut', site: lot.site }] }, 120_000);
      const G = { groupId: gq.groupId ?? null, refused: gq.refused ?? null };
      check(!!gq.groupId, `massingFirst: Designs.requestGroup of a massingFirst group with the site lot as an item is accepted (${gq.refused ?? gq.groupId})`, G);
      if (gq.groupId) {
        const st0 = await call('dev.sl.groupState', { groupId: gq.groupId }, 60_000);
        const hut0 = st0.items?.find((x) => x.key === 'hut');
        G.first = { hall: st0.items?.find((x) => x.key === 'hall')?.stage, hut: { designId: hut0?.designId, step: hut0?.step } };
        let st = st0;
        for (let t = 0; t < 120 && st.status !== 'AWAITING_APPROVAL' && !['DONE', 'FAILED', 'CANCELLED'].includes(st.status); t++) { await L.sleep(2000); st = await call('dev.sl.groupState', { groupId: gq.groupId }, 60_000); }
        const hutA = st.items?.find((x) => x.key === 'hut');
        G.awaiting = { status: st.status, awaiting: st.awaiting, hutDesign: hutA?.designId };
        check(G.first.hall === 'MASSING' && hut0?.designId === '' && st.status === 'AWAITING_APPROVAL' && json(st.awaiting) === json(['hall']) && hutA?.designId === '',
          `massingFirst: the hall's massing designs and awaits approval while the site item waits with no design (${hut0?.step})`, G);
        const ap = await call('dev.sl.approve', { groupId: gq.groupId, approve: ['hall'] }, 60_000);
        for (let t = 0; t < 300 && !['DONE', 'FAILED', 'CANCELLED'].includes(st.status); t++) { await L.sleep(2000); st = await call('dev.sl.groupState', { groupId: gq.groupId }, 60_000); }
        const hutE = st.items?.find((x) => x.key === 'hut');
        G.end = { approved: ap.approved ?? ap.refused, status: st.status, hut: { status: hutE?.status, designIds: hutE?.designIds, entryId: hutE?.entryId, step: hutE?.step } };
        check(!!ap.approved && ['DONE', 'FAILED'].includes(st.status) && hutE?.designIds?.length === 1 && hutE.designId !== '',
          `massingFirst: after approval the site item designs in one pass (one design, no massing) in the same group; the group ends ${st.status} (hut ${hutE?.status}: ${String(hutE?.step).slice(0, 120)})`, G.end);
        if (hutE?.entryId) {
          const en = await call('dev.ds.entry', { entryId: hutE.entryId }, 60_000).catch(() => null);
          G.binding = en?.binding ?? null;
          check(en?.binding?.volumeSha === lot.site.volumeSha && en.binding.lotId === 'hut', 'massingFirst: the site item\'s entry is bound to the lot (SiteBinding: the lot volume\'s sha, lot hut)', G.binding);
        }
      }
      r.massingFirst = G;
    }
    // SV's trunk house built on the lot's Site (a $0 site variant), written to the library as sl_hut, bound by its sidecar site
    const file = volumeFile(lot.site.volumeSha);
    check(!!file, 'fits: the frozen volume file is in the world (architect/volumes)', { file });
    const { Site } = await imp('lib/site.mjs');
    const { writeBlueprint } = await imp('lib/write.mjs');
    const ex = await imp('designs/site/fit_wrap_trunk.mjs');
    const site = new Site(fs.readFileSync(file), lot.site);
    const bp = ex.default({ site });
    bp.id = 'sl_hut';
    const dir = path.join(L.LIBRARY, bp.id);
    fs.rmSync(dir, { recursive: true, force: true });
    writeBlueprint(bp, dir);
    // a copy bound to another volume (its sidecar site's sha changed): SITE_MISMATCH at bind
    const bp2 = ex.default({ site });
    bp2.id = 'sl_hut_other';
    const dir2 = path.join(L.LIBRARY, bp2.id);
    fs.rmSync(dir2, { recursive: true, force: true });
    writeBlueprint(bp2, dir2);
    const side2 = path.join(dir2, `${bp2.id}.blueprint.json`);
    const sj = JSON.parse(fs.readFileSync(side2, 'utf8'));
    sj.site.volumeSha = 'f'.repeat(64);
    sj.site.volumeBlobId = `local:${'f'.repeat(64)}`;
    fs.writeFileSync(side2, `${JSON.stringify(sj, null, 1)}\n`);
    await call('dev.pl.reload', {}, 60_000);
    const snap = path.join(OUT, 'fits-snap.gz');
    await call('dev.region.hash', { box: claimBox, mode: 'snap', file: snap }, 3_600_000);
    // refused at bind, nothing written: a bundled design of another size; the copy bound to another volume
    for (const [entry, re, why] of [['fit_wrap_trunk', /size|box|LOT_TOO_SMALL|SITE_MISMATCH/i, 'a design of another size (the trunk fixture\'s 16x20x16)'], ['sl_hut_other', /SITE_MISMATCH/, 'a design bound to another volume']]) {
      const rr = await call('dev.region.realiseApproved', { sha: ck.check.artifactSha, lotEntries: { hut: entry } }, 300_000);
      const d0 = await call('dev.region.hash', { box: claimBox, mode: 'diff', file: snap }, 3_600_000);
      r[`bind_${entry}`] = { region: rr.region ?? null, refused: rr.refused ?? null, mismatches: d0.mismatches };
      check(!rr.region && re.test(json(rr.refused ?? rr)) && d0.mismatches === 0, `fits: realiseApproved with ${why} is refused at bind (${json(rr.refused ?? rr).slice(0, 200)}); nothing written`, r[`bind_${entry}`]);
    }
    // realised with the trunk house
    const before = await cellsOf(arr(lot.site.volume));
    const rr = await call('dev.region.realiseApproved', { sha: ck.check.artifactSha, lotEntries: { hut: 'sl_hut' } }, 300_000);
    if (!rr.region) { check(false, `fits: realiseApproved refused (${json(rr.refused ?? rr)})`); out.fits = r; return out; }
    const st = await L.waitRegion(rr.region, 3_600_000);
    r.state = st.view.state;
    check(st.view.state === 'PLACED', `fits: realiseApproved with the site variant bound: ${st.view.state}`);
    await L.settle(3000);
    const rec = await call('dev.sl.lot', { region: rr.region, lot: 'hut' }, 60_000);
    r.record = { state: rec.state, entry: rec.entry, origin: rec.site?.origin, rotation: rec.site?.rotation, binding: rec.site?.ext?.['architect_mc:site'] ?? null };
    check(rec.known && json(rec.site?.origin) === json(lot.site.frame.origin) && /none/i.test(String(rec.site?.rotation ?? 'none')) && rec.site?.ext?.['architect_mc:site']?.volumeSha === lot.site.volumeSha && rec.site?.ext?.['architect_mc:site']?.lotId === 'hut',
      `fits: the lot's site stands at the site's frame ${json(lot.site.frame.origin)}, its record ext carries architect_mc:site (the volume's sha, lot hut)`, r.record);
    // LotSpec.site (the API's RegionPlan view) is the artifact's site
    const pv = await call('dev.sl.plan', { plan: st.view.planId }, 60_000).catch((e) => ({ error: String(e.message ?? e) }));
    const ps = pv.lots?.find((l) => l.id === 'hut');
    r.view = { known: pv.known, site: !!ps?.site, error: pv.error };
    check(pv.known && canon(ps?.site) === canon(lot.site), 'fits: RegionPlan.lots() hut has LotSpec.site equal to the artifact\'s site (SiteSpec.fromWire)', { view: ps?.site?.volumeSha, error: pv.error });
    // the plan's affordances through Regions.affordances (AF's accessor; its first in-game plan)
    const af = await call('dev.af.affordances', { plan: st.view.planId }, 60_000).catch((e) => ({ error: String(e.message ?? e) }));
    r.affordances = { known: af.known, n: af.affordances?.length, error: af.error };
    check(af.known && (af.affordances ?? []).some((x) => x.id === lot.affordance.id), `fits: Regions.affordances(plan) answers the plan's ${af.affordances?.length} affordances, the lot's among them`, r.affordances);
    const after = await cellsOf(arr(lot.site.volume));
    const o = lot.site.frame.origin;
    const w = new Map();
    for (const [k, c] of bp.cells) { const [x, y, z] = k.split(',').map(Number); w.set(k3(o[0] + x, o[1] + y, o[2] + z), c.state?.name ?? c.name ?? String(c)); }
    let wrong = 0;
    for (const [k, b] of w) if (idOf(after.get(k)) !== idOf(b)) wrong++;
    const kd = diff(before, after, new Set(w.keys()));
    const keep = lot.site.keepCritical.filter(([x, y, z]) => idOf(after.get(k3(x, y, z))) !== 'oak_log').length;
    r.cells = { written: w.size, wrong, changedUnwritten: kd.n, first: kd.first, keepLost: keep };
    check(w.size > 100 && wrong === 0 && kd.n === 0 && keep === 0, `fits: KEEP: the ${w.size} written cells hold the template; every other cell of the ${before.size}-cell site volume is unchanged (the ${lot.site.keepCritical.length} trunk logs and the leaves among them)`, r.cells);
    const rm = await call('dev.region.remove', { region: rr.region, requester: OWNER }, 3_600_000);
    await L.settle(5000);
    const d = await call('dev.region.hash', { box: claimBox, mode: 'diff', file: snap }, 3_600_000);
    r.exact = { removed: rm.removed, mismatches: d.mismatches, list: (d.list ?? []).slice(0, 10) };
    check(rm.removed && d.mismatches === 0, `fits: Regions.remove E-flat ${d.mismatches} over the claim`, r.exact);
    out.fits = r;
  }

  // ---- adjusted: two huts on one tree: one placed; realised with no entry: nothing written
  {
    const r = {};
    const ck = await checkPlan('adjusted', elevatedPlan([['hut_a', [17, 17]], ['hut_b', [17, 17]]]), anchor, claim);
    const a = ck.check?.parts?.find((p) => p.part === 'canopy');
    r.check = { overall: ck.check?.overall, canopy: a?.class, deviations: a?.deviations, notes: a?.notes };
    const art = ck.check?.artifactSha ? await call('dev.region.artifact', { sha: ck.check.artifactSha, body: true }, 60_000) : null;
    const ids = (art?.artifact?.body?.lots ?? []).map((l) => l.id);
    r.lots = ids;
    check(a?.class === 'adjusted' && a.deviations?.[0]?.what === 'count' && a.deviations[0].value === 1 && ids.length === 1 && !!art.artifact.body.lots[0].site,
      `adjusted: two huts on one tree: canopy adjusted (count ${a?.deviations?.[0]?.value}), the artifact holds ${ids.join(', ')} with its site`, r.check);
    if (ck.check?.artifactSha) {
      const snap = path.join(OUT, 'adjusted-snap.gz');
      await call('dev.region.hash', { box: claimBox, mode: 'snap', file: snap }, 3_600_000);
      const rr = await call('dev.region.realiseApproved', { sha: ck.check.artifactSha }, 300_000);
      r.region = rr.region ?? null;
      if (rr.region) {
        const st = await L.waitRegion(rr.region, 3_600_000);
        await L.settle(2000);
        const d0 = await call('dev.region.hash', { box: claimBox, mode: 'diff', file: snap }, 3_600_000);
        const rm = await call('dev.region.remove', { region: rr.region, requester: OWNER }, 3_600_000);
        await L.settle(3000);
        const d = await call('dev.region.hash', { box: claimBox, mode: 'diff', file: snap }, 3_600_000);
        r.realised = { state: st.view.state, written: d0.mismatches, removed: rm.removed, eflat: d.mismatches };
        check(st.view.state === 'PLACED' && d0.mismatches === 0 && rm.removed && d.mismatches === 0, `adjusted: realiseApproved with no entry: ${st.view.state}, ${d0.mismatches} cells written (a site lot writes no pad), removed E-flat ${d.mismatches}`, r.realised);
      } else check(false, `adjusted: realiseApproved refused (${json(rr.refused ?? rr)})`);
    }
    out.adjusted = r;
  }

  // ---- refused: a zone over open flat land
  {
    const r = {};
    const meadow = [TX + 50, gy + 1, TZ + 50];
    const ck = await call('dev.region.checkPlan', { plan: elevatedPlan([['hut', [9, 9]]], { required: false }), claim, owner: OWNER, anchors: { grove: meadow }, load: 'generate' }, 1_800_000);
    fs.writeFileSync(path.join(OUT, 'refused-check.json'), `${JSON.stringify(ck, null, 1)}\n`);
    const a = ck.check?.parts?.find((p) => p.part === 'canopy');
    r.check = { overall: ck.check?.overall, canopy: a?.class, reasons: a?.reasons?.map((x) => x.code), artifactSha: ck.check?.artifactSha ?? null };
    check(a?.class === 'refused' && a.reasons?.[0]?.code === 'NO_FEATURE', `refused: an elevated zone over open flat land: ${a?.class} ${a?.reasons?.[0]?.code} (${String(a?.reasons?.[0]?.message ?? '').slice(0, 160)})`, r.check);
    if (ck.check?.artifactSha) {
      const snap = path.join(OUT, 'refused-snap.gz');
      await call('dev.region.hash', { box: claimBox, mode: 'snap', file: snap }, 3_600_000);
      const rr = await call('dev.region.realiseApproved', { sha: ck.check.artifactSha }, 300_000);
      let state = null;
      if (rr.region) { const st = await L.waitRegion(rr.region, 3_600_000); state = st.view.state; }
      await L.settle(2000);
      const d0 = await call('dev.region.hash', { box: claimBox, mode: 'diff', file: snap }, 3_600_000);
      if (rr.region) await call('dev.region.remove', { region: rr.region, requester: OWNER }, 3_600_000);
      r.realise = { region: rr.region ?? null, refused: rr.refused ?? null, state, written: d0.mismatches };
      check(d0.mismatches === 0, `refused: realiseApproved of its artifact (${rr.region ? state : `refused ${json(rr.refused).slice(0, 120)}`}) writes nothing in the claim`, r.realise);
    } else check(true, `refused: no artifact (${ck.check?.overall}): nothing to realise`);
    out.refused = r;
  }
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'ingame']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7b-SL (site lots)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7bsl.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
