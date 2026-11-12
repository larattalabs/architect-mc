#!/usr/bin/env node
// Slice LP gate (7b link pass; docs/CONTRACT.md "Phase 7b" slice LP row 10, changes 3 and 4, "Slice LP as built") against the headless
// server of the LP run worktree (GATE6B_RUN, default `../architect-mc-LP-run`; the sim sidecar, no Claude). Ports 8896 (sidecar) / 8897
// (DevBridge) by default; the verifier runs `remove` on its own (8910/8911). $0: no Claude call anywhere.
//
//   node tools/gate7blp.mjs <step>
//     unit     (lp-unit)    offline: kit/test/lp.test.mjs (every port connector's guarantees re-checked by the region checker against the
//                           port endpoints: branch_walk, catwalk, tunnel.under; K5; the ends; NO_LINK; the replay guard; plan/0's answers;
//                           change 4) with the 7b tests it touches; the sidecar's region.link with the real kit; the Java ApiLPTest and
//                           ApiSLTest; byte identity of every committed plan fixture against SL's head (the named movers aside); the asks
//     ingame   (lp-ingame)  on a flat world with two giant trees built by commands: a Steward-shaped plan/0 (an elevated zone, two canopy
//                           huts, a branch_walk between them) through Regions.checkPlan (READY; the walk fits) then realiseApproved: SV's
//                           trunk house built on each lot's Site and bound; NO_LINK first (hut_b bound to a copy without its port: refused
//                           NO_LINK {lot: hut_b, port: walk_w}, nothing written, no region); then PLACED from IR v2 (the region's IR the
//                           plan's plus link_walk in site_links, `linked`), the realise report's architect_mc:links row, the walk's cells
//                           in the world (deck under every path cell, chains, rails), none inside a lot's box; Remove E-flat 0
//     remove   (lp-remove)  removal order (the verifier re-runs it): the same plan realised twice on a fresh world: region first
//                           (Regions.remove: E-flat 0 over the claim) and houses first (Sites.remove of hut_b, then hut_a: the walk stands
//                           and each lot's cells are its site's again; then Regions.remove: E-flat 0)
//     gr       (lp-gr)      the GR revision byte item (change 4): a town realised through checkPlan/realiseApproved and a growth of two
//                           lots through a revision plan, twice on identical fresh worlds: once as LP realises it, once with the link
//                           hook bypassed (the realise as before LP): no link pass ran (dev.lp.stats), the revision's IR has no site_links
//                           stage and no portLinks, and the world after the growth is cell for cell the same both ways; undo exact
//     report                REPORT.md over the step JSONs
//   (AD row 7 is the step lp-ad: `GATE6DAD_LP=1 node tools/gate6dad.mjs ingame`, AD's own rows 2-6c again on LP, plus row 7's checks.)
//
// Evidence: artifacts/gate7b-lp/<step>.json in the main checkout (GATE7BLP_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-LP-run');
process.env.GATE6B_OUT = process.env.GATE7BLP_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7b-lp');
process.env.GATE6B_SIDECAR_PORT ??= '8896';
process.env.GATE6B_DEV_PORT ??= '8897';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, fails, log, results, root, state } = L;

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const FLAT = 'G6B Flat Base';
const OWNER = 'test:lp';
const TX = 9600, TZ = 9600;
/** SL's head: LP's base until SL is on main (then the merge base with main). */
const SL_HEAD = '51fddf7c';

/** The fixtures that move by name (byte identity against SL's head). */
export const LP_MOVED = Object.freeze({
  'asks/secret_tunnels.json': 'LP: its three tunnels under flat ground answer refused NO_FEATURE {tunnel.under} (supported between site lots\' cellar doors; was unsupported until 7b); the IR unchanged',
  'extension/e17_tunnel_under.json': 'LP: its tunnel under flat ground answers refused NO_FEATURE {tunnel.under} (was unsupported until 7b)',
  'tunnel/tn10_tunnel_under.json': 'LP: flat ends answer refused NO_FEATURE {tunnel.under} (was unsupported until 7b)',
});

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice LP is $0: sim only, no Claude call' }, null, 2)}\n`);
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
  out.kit = kitOnce(['kit/test/lp.test.mjs', 'kit/test/sl.test.mjs', 'kit/test/f7b-foundation.test.mjs', 'kit/test/t3-foundation.test.mjs', 'kit/test/plan-t3a.test.mjs', 'kit/test/plan-t3b.test.mjs', 'kit/test/f7a-foundation.test.mjs', 'kit/test/gm-c.test.mjs', 'kit/test/cl.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 40, `kit: lp.test.mjs (every port connector's guarantees re-checked against the port endpoints: branch_walk M10:branch_walk, catwalk M10:catwalk, tunnel.under M3/M4:tunnel; K5 and the ends; NO_LINK {lot, port}; the replay guard; determinism; plan/0's answers; change 4) and the 7b, T3 and catalogue tests it touches: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const sc = spawnSync('npx', ['vitest', 'run', 'test/regions-link.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 1_800_000 });
  out.sidecar = { code: sc.status, tail: `${sc.stdout}${sc.stderr}`.split('\n').filter((l) => /Tests|FAIL|✓|×/.test(l)).slice(0, 10) };
  check(sc.status === 0, 'sidecar: region.link with the real kit (the plan\'s portLinks and plan-args.json; IR v2 answered and cached; noLink {lot, port}; another irSha refused)', out.sidecar.tail);
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', '-q', '--tests', 'dev.larattalabs.architect.region.ApiLPTest', '--tests', 'dev.larattalabs.architect.region.ApiSLTest'], { cwd: path.join(root, 'mod'), encoding: 'utf8', env, timeout: 1_800_000 });
  out.java = { code: g.status, tail: `${g.stdout}${g.stderr}`.split('\n').filter((l) => /FAIL|error/i.test(l)).slice(0, 10) };
  check(g.status === 0, 'Java: ApiLPTest (which IRs run the pass, the lots and the input, the feature linkPass, NO_LINK last) and ApiSLTest', out.java.tail);
  // byte identity against SL's head (LP's base) until SL is on main, then the merge base
  let onMain = false;
  try { execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', SL_HEAD, 'origin/main']); onMain = true; } catch { /* not yet */ }
  const saved = process.env.GATE_MERGE_BASE;
  if (!onMain) process.env.GATE_MERGE_BASE = execFileSync('git', ['-C', root, 'rev-parse', SL_HEAD]).toString().trim();
  try {
    const K = await import('./lib/gate7a-kit.mjs');
    const u = await K.unchanged(root, { check, log, base: 'LP', except: LP_MOVED, mergedIf: 'kit/lib/region/links.mjs' });
    out.unchanged = { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, moved: u.moved };
    fs.writeFileSync(path.join(OUT, 'lp-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  } finally {
    if (saved === undefined) delete process.env.GATE_MERGE_BASE; else process.env.GATE_MERGE_BASE = saved;
  }
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
function diff(a, b, max = 8) {
  const out = [];
  let n = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = norm(a.get(k) ?? 'minecraft:air'), y = norm(b.get(k) ?? 'minecraft:air');
    if (x !== y) { n++; if (out.length < max) out.push(`${k} ${x} -> ${y}`); }
  }
  return { n, first: out };
}
async function groundY(x = TX + 30, z = TZ + 30) {
  const h = await call('dev.box.hash', { min: [x, -64, z], max: [x, 250, z], cells: true }, 120_000);
  let g = -64;
  for (const l of h.cells ?? []) { const [k, ...rest] = l.split(' '); const y = Number(k.split(',')[1]); if (idOf(asState(rest.join(' '))) !== 'air' && y > g) g = y; }
  return g;
}
const arr = (b) => [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ];
const inBox = (b, [x, y, z]) => x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5];
function volumeFile(sha) {
  for (const w of fs.existsSync(L.SAVES) ? fs.readdirSync(L.SAVES) : []) {
    const f = path.join(L.SAVES, w, 'architect', 'volumes', `${sha}.bin`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
async function removeRegion(region) {
  const r = await call('dev.region.remove', { region, requester: OWNER }, 4 * 3_600_000);
  for (let i = 0; i < 2400; i++) {
    const st = await call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || ['REMOVED', 'PARTIAL', 'FAILED'].includes(s)) break;
    await L.sleep(500);
  }
  await L.settle(3000);
  return r;
}

// ------------------------------------------------------------------ the two-lot plan

/** A plan/0 with an elevated zone `canopy` (two huts) near the anchor and a branch_walk between the huts. */
const linkedPlan = () => ({ schemaVersion: 'plan/0', planId: 'lp_canopy', zones: [{ id: 'canopy', kind: 'standard', size: { preset: 'M' }, where: { near: { anchor: 'grove', within: 8 } },
  program: { layout: 'elevated', lots: ['hut_a', 'hut_b'].map((id) => ({ id, type: 'cabin', role: 'canopy_hut', size: [9, 9], villager: 'dwelling', brief: 'A small home on its tree\'s platform.' })) } }],
  connectors: [{ id: 'walk', kind: 'branch_walk', from: { part: 'hut_a' }, to: { part: 'hut_b' } }] });

/** A fresh flat world with two giant trees 16 apart (3x3 oak trunks 20 tall, 15x15 persistent leaf layers 5 thick). */
async function twoTrees(world) {
  await L.fresh(world, FLAT);
  await L.setRules('exact');
  await L.tp(TX - 20, 0, TZ - 30);
  const gy = await groundY();
  for (const x of [TX - 8, TX + 8]) {
    await cmd(`/fill ${x - 1} ${gy + 1} ${TZ - 1} ${x + 1} ${gy + 20} ${TZ + 1} minecraft:oak_log`);
    await cmd(`/fill ${x - 7} ${gy + 21} ${TZ - 7} ${x + 7} ${gy + 25} ${TZ + 7} minecraft:oak_leaves[persistent=true]`);
  }
  await L.settle(1500);
  const claim = [TX - 80, TZ - 80, TX + 79, TZ + 79];
  return { gy, anchor: [TX, gy + 1, TZ], claim, claimBox: [claim[0], gy - 4, claim[1], claim[2], gy + 60, claim[3]] };
}

/** checkPlan of the two-lot plan; its artifact's two site lots; SV's trunk house built on each lot's Site into the library. */
async function planAndDesigns(W, tag) {
  const ck = await call('dev.region.checkPlan', { plan: linkedPlan(), claim: W.claim, owner: OWNER, anchors: { grove: W.anchor }, load: 'generate' }, 1_800_000);
  fs.writeFileSync(path.join(OUT, `${tag}-check.json`), `${JSON.stringify(ck, null, 1)}\n`);
  const art = ck.check?.artifactSha ? (await call('dev.region.artifact', { sha: ck.check.artifactSha, body: true }, 60_000)).artifact : null;
  const lots = new Map((art?.body?.lots ?? []).map((l) => [l.id, l]));
  const { Site } = await imp('lib/site.mjs');
  const { writeBlueprint } = await imp('lib/write.mjs');
  const ex = await imp('designs/site/fit_wrap_trunk.mjs');
  const entries = {};
  for (const [id, lot] of lots) {
    // (the site volume is frozen into architect/volumes the first time a check or placement needs it: Survey.volume of the lot's volume
    // box freezes the same cells, as SL's gate reads them; its sha is the plan's)
    let file = volumeFile(lot.site.volumeSha);
    if (!file) {
      const sv = await call('dev.survey.volume', { box: arr(lot.site.volume), load: 'loaded' }, 600_000);
      check(sv.sha === lot.site.volumeSha, `${tag}: Survey.volume of ${id}'s site volume has the plan's sha (${String(sv.sha).slice(0, 12)})`);
      file = volumeFile(lot.site.volumeSha);
    }
    check(!!file, `${tag}: ${id}'s frozen site volume is in the world (architect/volumes)`);
    if (!file) continue;
    const bp = ex.default({ site: new Site(fs.readFileSync(file), lot.site) });
    bp.id = `lp_${id}`;
    const dir = path.join(L.LIBRARY, bp.id);
    fs.rmSync(dir, { recursive: true, force: true });
    writeBlueprint(bp, dir);
    entries[id] = { id: bp.id, bp, dir };
  }
  // a copy of hut_b's house without its port (NO_LINK at realise)
  if (entries.hut_b) {
    const bp = ex.default({ site: new Site(fs.readFileSync(volumeFile(lots.get('hut_b').site.volumeSha)), lots.get('hut_b').site) });
    bp.id = 'lp_hut_b_noport';
    const dir = path.join(L.LIBRARY, bp.id);
    fs.rmSync(dir, { recursive: true, force: true });
    writeBlueprint(bp, dir);
    const side = path.join(dir, `${bp.id}.blueprint.json`);
    const sj = JSON.parse(fs.readFileSync(side, 'utf8'));
    sj.ports = [];
    fs.writeFileSync(side, `${JSON.stringify(sj, null, 1)}\n`);
  }
  await call('dev.pl.reload', {}, 60_000);
  return { ck, art, lots, entries };
}

/** The region's IR (its save's ir.json) and its link parts' cells. */
function regionIr(world, region) {
  return JSON.parse(fs.readFileSync(path.join(L.SAVES, world, 'architect-regions', region, 'ir.json'), 'utf8'));
}
function linkCells(ir) {
  const out = [];
  for (const p of ir.parts.filter((q) => q.stage === 'site_links')) for (const op of p.ops) for (let t = 0; t < (op.cols ?? []).length; t += 5) for (let y = op.cols[t + 2]; y <= op.cols[t + 3]; y++) out.push({ at: [op.cols[t], y, op.cols[t + 1]], state: op.materials[op.cols[t + 4]] });
  return out;
}

steps.ingame = async () => {
  await ensure();
  spendZero();
  const out = {};
  const world = 'G6B LP Ingame';
  const W = await twoTrees(world);
  out.groundY = W.gy;
  const P = await planAndDesigns(W, 'ingame');
  const walk = P.ck.check?.parts?.find((p) => p.part === 'walk');
  const canopy = P.ck.check?.parts?.find((p) => p.part === 'canopy');
  out.check = { overall: P.ck.check?.overall, canopy: canopy?.class, walk: walk?.class, link: walk?.geometry?.link, lots: [...P.lots.keys()] };
  check(P.ck.check?.overall === 'READY' && canopy?.class === 'fits' && walk?.class === 'fits' && P.lots.size === 2, `the two-lot plan through Regions.checkPlan: ${P.ck.check?.overall}; canopy ${canopy?.class}, walk ${walk?.class} (${json(walk?.geometry?.link)})`, out.check);
  check(!!P.entries.hut_a && !!P.entries.hut_b, 'SV\'s trunk house built on each lot\'s Site into the library (lp_hut_a, lp_hut_b, lp_hut_b_noport)');
  if (P.lots.size !== 2 || !P.entries.hut_a || !P.entries.hut_b) return out;
  const snap = path.join(OUT, 'ingame-snap.gz');
  await call('dev.region.hash', { box: W.claimBox, mode: 'snap', file: snap }, 3_600_000);
  const stats0 = await call('dev.lp.stats', {}, 30_000);
  // ---- NO_LINK: hut_b bound to a copy without its port: refused before any write, no region
  const before = (await call('dev.region.list', {}, 60_000)).regions.length;
  const nl = await call('dev.region.realiseApproved', { sha: P.ck.check.artifactSha, lotEntries: { hut_a: 'lp_hut_a', hut_b: 'lp_hut_b_noport' } }, 600_000);
  const d0 = await call('dev.region.hash', { box: W.claimBox, mode: 'diff', file: snap }, 3_600_000);
  const after = (await call('dev.region.list', {}, 60_000)).regions.length;
  let detail = null;
  try { detail = JSON.parse(nl.detail ?? 'null'); } catch { /* not JSON */ }
  out.noLink = { refused: nl.refused ?? null, reason: nl.reason ?? null, detail, written: d0.mismatches, regions: [before, after] };
  check(!nl.region && nl.reason === 'NO_LINK' && detail?.lot === 'hut_b' && detail?.port === 'walk_w' && d0.mismatches === 0 && after === before,
    `NO_LINK: hut_b bound to its house without the port: refused ${nl.reason} detail ${json(detail)} (${String(nl.refused ?? '').slice(0, 160)}); ${d0.mismatches} cells written, no region`, out.noLink);
  // ---- realised from IR v2
  const rr = await call('dev.region.realiseApproved', { sha: P.ck.check.artifactSha, lotEntries: { hut_a: 'lp_hut_a', hut_b: 'lp_hut_b' } }, 600_000);
  if (!rr.region) { check(false, `realiseApproved refused (${json(rr)})`); return out; }
  const st = await L.waitRegion(rr.region, 3_600_000);
  await L.settle(3000);
  const stats1 = await call('dev.lp.stats', {}, 30_000);
  check(st.view.state === 'PLACED' && stats1.calls - stats0.calls === 2 && stats1.noLinks - stats0.noLinks === 1, `realiseApproved with both houses bound: ${st.view.state}; the link pass ran for both realises (${stats1.calls - stats0.calls} calls, ${stats1.noLinks - stats0.noLinks} NO_LINK)`, { stats0, stats1 });
  const ir = regionIr(world, rr.region);
  const rows = st.view.ext?.['architect_mc:links'] ?? [];
  out.report = rows;
  out.ir = { stages: ir.stages, linkParts: ir.parts.filter((p) => p.stage === 'site_links').map((p) => p.id), linked: Object.keys(ir.linked?.lots ?? {}), irSha: st.view.irSha };
  check(ir.stages.includes('site_links') && json(out.ir.linkParts) === json(['link_walk']) && json(out.ir.linked) === json(['hut_a', 'hut_b']) && Array.isArray(ir.portLinks),
    `the region's IR is IR v2: stage site_links holds ${json(out.ir.linkParts)}, linked ${json(out.ir.linked)} (irSha ${String(st.view.irSha).slice(0, 12)})`, out.ir);
  const row = rows[0];
  check(rows.length === 1 && row?.id === 'walk' && row.kind === 'branch_walk' && row.from?.port === 'walk_w' && row.to?.port === 'walk_w' && row.part === 'link_walk', `the realise report's $.links[] (RegionView.ext architect_mc:links): ${json(rows).slice(0, 300)}`);
  // the walk in the world: every link cell as the IR writes it, none in a lot's box, the ends the cells outside the ports
  const cells = linkCells(ir);
  const boxes = [...P.lots.values()].map((l) => l.box);
  const world1 = await cellsOf([Math.min(...cells.map((c) => c.at[0])), Math.min(...cells.map((c) => c.at[1])), Math.min(...cells.map((c) => c.at[2])), Math.max(...cells.map((c) => c.at[0])), Math.max(...cells.map((c) => c.at[1])), Math.max(...cells.map((c) => c.at[2]))]);
  const wrong = cells.filter((c) => idOf(world1.get(k3(...c.at))) !== idOf(c.state));
  const inLot = cells.filter((c) => boxes.some((b) => inBox(b, c.at)));
  const ends = [row.from, row.to].map((e) => { const b = P.lots.get(e.lot).box; return inBox(b, e.at) && !inBox(b, e.out); });
  out.walk = { cells: cells.length, wrong: wrong.length, firstWrong: wrong.slice(0, 4), inLot: inLot.length, ends };
  check(cells.length > 40 && wrong.length === 0 && inLot.length === 0 && ends.every(Boolean), `the walk stands: ${cells.length} link cells as the IR writes them (${wrong.length} differ), none inside a lot's box (K5), each end the cell just outside its port`, out.walk);
  // the houses as their lots' records name them, and the walk's ends meet their ports
  for (const id of ['hut_a', 'hut_b']) {
    const rec = await call('dev.sl.lot', { region: rr.region, lot: id }, 60_000);
    check(rec.known && rec.entry === `lp_${id}`, `${id}: placed with ${rec.entry} (${rec.state})`, { state: rec.state, entry: rec.entry });
  }
  const rm = await removeRegion(rr.region);
  const d = await call('dev.region.hash', { box: W.claimBox, mode: 'diff', file: snap }, 3_600_000);
  out.remove = { removed: rm.removed, mismatches: d.mismatches, list: (d.list ?? []).slice(0, 8) };
  check(rm.removed !== false && d.mismatches === 0, `Regions.remove: E-flat ${d.mismatches} over the claim`, out.remove);
  await L.leaveWorld?.();
  return out;
};

steps.remove = async () => {
  await ensure();
  spendZero();
  const out = {};
  const world = 'G6B LP Remove';
  const W = await twoTrees(world);
  const P = await planAndDesigns(W, 'remove');
  check(P.ck.check?.overall === 'READY' && P.lots.size === 2 && !!P.entries.hut_a && !!P.entries.hut_b, `the two-lot plan checked (${P.ck.check?.overall}) and both houses built`);
  if (!P.entries.hut_a || !P.entries.hut_b) return out;
  const B0 = await cellsOf(W.claimBox);
  const realise = async (tag) => {
    const rr = await call('dev.region.realiseApproved', { sha: P.ck.check.artifactSha, lotEntries: { hut_a: 'lp_hut_a', hut_b: 'lp_hut_b' } }, 600_000);
    if (!rr.region) throw new Error(`${tag}: realiseApproved refused (${json(rr)})`);
    const st = await L.waitRegion(rr.region, 3_600_000);
    await L.settle(3000);
    check(st.view.state === 'PLACED', `${tag}: realised ${rr.region} from IR v2: ${st.view.state}`);
    return { region: rr.region, ir: regionIr(world, rr.region) };
  };
  // ---- region first
  {
    const R = await realise('region first');
    const rm = await removeRegion(R.region);
    const d = diff(B0, await cellsOf(W.claimBox));
    out.regionFirst = { removed: rm.removed, eflat: d.n, first: d.first };
    check(rm.removed !== false && d.n === 0, `region first: Regions.remove E-flat ${d.n} over the claim (the walk, both houses)`, d.first);
  }
  // ---- houses first: hut_b, then hut_a, then the region
  {
    const R = await realise('houses first');
    const cells = linkCells(R.ir);
    const walkBox = [Math.min(...cells.map((c) => c.at[0])), Math.min(...cells.map((c) => c.at[1])), Math.min(...cells.map((c) => c.at[2])), Math.max(...cells.map((c) => c.at[0])), Math.max(...cells.map((c) => c.at[1])), Math.max(...cells.map((c) => c.at[2]))];
    const r = {};
    for (const id of ['hut_b', 'hut_a']) {
      const rec = await call('dev.sl.lot', { region: R.region, lot: id }, 60_000);
      const lb = arr(P.lots.get(id).box);
      const sr = await call('dev.rv.siteRemove', { site: rec.siteId, force: true, requester: OWNER }, 600_000);
      await L.settle(3000);
      const lotNow = await cellsOf(lb);
      const lotBefore = new Map([...B0].filter(([k]) => inBox(lb, k.split(',').map(Number))));
      const dl = diff(lotBefore, lotNow);
      const w = await cellsOf(walkBox);
      const standing = cells.filter((c) => idOf(w.get(k3(...c.at))) === idOf(c.state)).length;
      r[id] = { site: rec.siteId, removed: sr.removed ?? sr.ok ?? null, refused: sr.refused ?? null, lotDiff: dl.n, first: dl.first, walk: `${standing}/${cells.length}` };
      check(!sr.refused && dl.n === 0 && standing === cells.length, `houses first: Sites.remove of ${id}'s house: its lot box is its site's again (${dl.n} differ); the walk stands (${standing} of ${cells.length} cells)`, r[id]);
    }
    const rm = await removeRegion(R.region);
    const d = diff(B0, await cellsOf(W.claimBox));
    r.region = { removed: rm.removed, eflat: d.n, first: d.first };
    check(rm.removed !== false && d.n === 0, `houses first: then Regions.remove: E-flat ${d.n} over the claim`, d.first);
    out.housesFirst = r;
  }
  await L.leaveWorld?.();
  return out;
};

// ------------------------------------------------------------------ gr: the GR revision byte item (change 4)

const GCX = 11200, GCZ = 11200;
const P0_LOT = (id) => ({ id, type: 'house', size: [9, 9] });
const P0_TOWN = { schemaVersion: 'plan/0', planId: 'gr_town', zones: [{ id: 'town', program: { lots: [P0_LOT('h1'), P0_LOT('h2'), P0_LOT('h3')] }, where: { near: { anchor: 'claim_center', within: 8 } } }] };
const P0_CLAIM = [GCX, GCZ, GCX + 159, GCZ + 111];
const STUB = 'g6a_stub_9';
const grownPlan = (parent, lots, n = 1) => ({ ...P0_TOWN, zones: [{ ...P0_TOWN.zones[0], program: { lots: [...P0_TOWN.zones[0].program.lots, ...lots] } }], revision: { n, parentArtifact: parent } });
async function grCheck(plan) {
  const r = await call('dev.region.checkPlan', { plan, claim: P0_CLAIM, owner: OWNER }, 900_000);
  return r.check ?? r;
}
async function rvWait(region, rid, timeoutMs = 1_800_000) {
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < timeoutMs) {
    st = await call('dev.rv.state', { region }, 60_000);
    const r = st.revisions.find((x) => x.rid === rid);
    if (st.busy === null && r && !['ACCEPTED', 'PLACING'].includes(r.state)) return { st, r };
    await L.sleep(L.pollDelayMs(Date.now() - t0));
  }
  throw new Error(`revision ${rid} of ${region} did not end`);
}

/** The town and its growth on a fresh world; the world after the growth (cells), the revision's IR, the link calls made. */
async function grOnce(world, bypass) {
  await call('dev.lp.bypass', { on: bypass }, 30_000);
  try {
    await L.fresh(world, FLAT);
    await L.setRules('exact');
    await L.tp(GCX + 80, 60, GCZ + 56);
    const gy = await groundY(GCX + 4, GCZ + 4);
    const BOX = [P0_CLAIM[0] - 8, gy - 12, P0_CLAIM[1] - 8, P0_CLAIM[2] + 8, gy + 24, P0_CLAIM[3] + 8];
    const s0 = await call('dev.lp.stats', {}, 30_000);
    const c0 = await grCheck(P0_TOWN);
    const ra = await call('dev.region.realiseApproved', { sha: c0.artifactSha, lotEntries: { h1: STUB } }, 300_000);
    const st0 = await L.waitRegion(ra.region, 3_600_000);
    const S0 = await cellsOf(BOX);
    const c1 = await grCheck(grownPlan(c0.artifactSha, [P0_LOT('h4'), P0_LOT('h5')]));
    const r1 = await call('dev.region.realiseApproved', { sha: c1.artifactSha, lotEntries: { h4: STUB } }, 300_000);
    const rs = await call('dev.rv.state', { region: ra.region }, 60_000);
    const w = await rvWait(ra.region, rs.revisions.at(-1).rid);
    await L.settle(3000);
    const S1 = await cellsOf(BOX);
    const rvIr = (await call('dev.rv.ir', { region: ra.region, rid: w.r.rid }, 60_000)).ir;
    const s1 = await call('dev.lp.stats', {}, 30_000);
    const u = await call('dev.rv.undo', { region: ra.region, toPosition: 0 }, 4 * 3_600_000);
    const du = diff(S0, await cellsOf(BOX));
    await removeRegion(ra.region);
    return { town: { overall: c0.overall, state: st0.view.state }, growth: { overall: c1.overall, region: r1.region, state: w.r.state, rid: w.r.rid }, S1, rvIr, calls: s1.calls - s0.calls, undo: { removed: u.removed, diff: du.n, first: du.first } };
  } finally {
    await call('dev.lp.bypass', { on: false }, 30_000);
  }
}

steps.gr = async () => {
  await ensure();
  spendZero();
  const out = {};
  const A = await grOnce('G6B LP GR', false);
  const B = await grOnce('G6B LP GR Bypass', true);
  for (const [tag, x] of [['with LP', A], ['bypassed', B]]) {
    out[tag] = { town: x.town, growth: x.growth, calls: x.calls, undo: x.undo, rvStages: x.rvIr?.stages, portLinks: !!x.rvIr?.portLinks, linked: !!x.rvIr?.linked };
    check(x.town.overall === 'READY' && x.town.state === 'PLACED' && x.growth.overall === 'READY' && x.growth.state === 'PLACED', `${tag}: the town realised (${x.town.state}) and its growth of h4, h5 realised (${x.growth.state}, rid ${x.growth.rid})`, out[tag]);
    check(x.calls === 0 && !(x.rvIr?.stages ?? []).includes('site_links') && !x.rvIr?.portLinks && !x.rvIr?.linked, `${tag}: no link pass ran (${x.calls} calls); the revision's IR has no site_links stage, portLinks or linked`);
    check(x.undo.removed !== false && x.undo.diff === 0, `${tag}: the growth undone: the world before it (${x.undo.diff} differ)`, x.undo.first);
  }
  const d = diff(B.S1, A.S1);
  out.bytes = { cells: A.S1.size, differ: d.n, first: d.first, rvIrSame: json(A.rvIr) === json(B.rvIr) };
  check(d.n === 0 && A.S1.size === B.S1.size && out.bytes.rvIrSame, `the revision realised with LP is byte for byte the realise before LP: ${A.S1.size} cells over the claim + 8, ${d.n} differ; the revision IRs equal (${out.bytes.rvIrSame})`, d.first);
  await L.leaveWorld?.();
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'ingame', 'remove', 'gr']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7b-LP (the link pass)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7blp.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
