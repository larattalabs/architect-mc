#!/usr/bin/env node
// Slice PL2 gate (a one-ended port link: the region ladder up to a site lot's walk port; docs/CONTRACT.md "Slice PL2 as built") against
// the headless server of the run worktree (GATE6B_RUN; the sim sidecar, no Claude). LP's harness (tools/gate7blp.mjs ingame): a flat
// world with a giant tree built by commands, SV's trunk house built on the lot's Site and bound. $0: no Claude call anywhere.
//
//   node tools/gate7cpl2.mjs <step>
//     unit     (pl2-unit)    offline: kit/test/pl2.test.mjs (the port ladder: plan time recorded, realise written, IR v2 = IR v1 plus the
//                            link, M10:climb clean, the refusals, a region-made form's foot, plan/0's fixtures/plan/pl2/) with lp.test and
//                            cn.test (two-ended links unchanged)
//     ingame   (pl2-ingame)  a Steward-shaped plan/0 (an elevated zone, one canopy hut, a connector.ladder from the ground anchor to the
//                            hut's walk_w) through Regions.checkPlan (READY, the ladder fits) then realiseApproved: NO_LINK first (the hut
//                            bound to a copy without its port: refused NO_LINK {lot: hut_a, port: walk_w}, nothing written, no region);
//                            then PLACED from IR v2 (link_up in site_links, linked), the realise report's architect_mc:links row (kind
//                            ladder, to.ground, its foot), every link cell in the world as the IR writes it, none in the lot's box, the
//                            rungs ladders against the post; dev.climb's physics probe up the rungs (recorded); Remove E-flat 0
//     report                 REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7c-pl2/<step>.json in the main checkout (GATE7CPL2_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-PL2-run');
process.env.GATE6B_OUT = process.env.GATE7CPL2_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7c-pl2');
process.env.GATE6B_SIDECAR_PORT ??= '9092';
process.env.GATE6B_DEV_PORT ??= '9093';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, fails, log, results, root, state } = L;

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const FLAT = 'G6B Flat Base';
const OWNER = 'test:pl2';
const TX = 9700, TZ = 9700;

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice PL2 is $0: sim only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ offline

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}

steps.unit = async () => {
  const out = {};
  const files = ['kit/test/pl2.test.mjs', 'kit/test/lp.test.mjs', 'kit/test/cn.test.mjs'];
  out.kit = kitReuse(root, files) ?? nodeTest(files);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 20, `kit: pl2.test.mjs (the port ladder: recorded at plan time, written at realise, IR v2 = IR v1 plus the link, M10:climb clean, NO_CLIMB/SPAN/ANCHOR/WATER, NO_PORT at realise, a region-made form's foot, plan/0's pl2 fixtures READY and realised clean) with lp.test and cn.test: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
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
function regionIr(world, region) {
  return JSON.parse(fs.readFileSync(path.join(L.SAVES, world, 'architect-regions', region, 'ir.json'), 'utf8'));
}
function linkCells(ir) {
  const out = [];
  for (const p of ir.parts.filter((q) => q.stage === 'site_links')) for (const op of p.ops) for (let t = 0; t < (op.cols ?? []).length; t += 5) for (let y = op.cols[t + 2]; y <= op.cols[t + 3]; y++) out.push({ at: [op.cols[t], y, op.cols[t + 1]], state: op.materials[op.cols[t + 4]] });
  return out;
}

// ------------------------------------------------------------------ the plan

/** A plan/0 with an elevated zone `canopy` (one hut) near the anchor and a ladder from the ground (the anchor) up to the hut's walk_w. */
const ladderPlan = () => ({ schemaVersion: 'plan/0', planId: 'pl2_canopy', zones: [{ id: 'canopy', kind: 'standard', size: { preset: 'M' }, where: { near: { anchor: 'grove', within: 8 } },
  program: { layout: 'elevated', lots: [{ id: 'hut_a', type: 'cabin', role: 'canopy_hut', size: [17, 17], villager: 'dwelling', brief: 'A small home on its tree\'s platform.' }] } }],
  connectors: [{ id: 'up', kind: 'ladder', from: { anchor: 'grove' }, to: { part: 'hut_a', port: 'walk_w' } }] });

/** A fresh flat world with one giant tree (a 3x3 oak trunk 20 tall, a 23x23 persistent leaf layer 5 thick): a 17-wide hut on it. */
async function oneTree(world) {
  await L.fresh(world, FLAT);
  await L.setRules('exact');
  await L.tp(TX - 20, 0, TZ - 30);
  const gy = await groundY();
  await cmd(`/fill ${TX - 1} ${gy + 1} ${TZ - 1} ${TX + 1} ${gy + 20} ${TZ + 1} minecraft:oak_log`);
  await cmd(`/fill ${TX - 11} ${gy + 21} ${TZ - 11} ${TX + 11} ${gy + 25} ${TZ + 11} minecraft:oak_leaves[persistent=true]`);
  await L.settle(1500);
  const claim = [TX - 64, TZ - 64, TX + 63, TZ + 63];
  return { gy, anchor: [TX - 16, gy + 1, TZ], claim, claimBox: [claim[0], gy - 4, claim[1], claim[2], gy + 60, claim[3]] };
}

/** checkPlan of the plan; its artifact's site lot; SV's trunk house built on the lot's Site into the library (and a copy without its port). */
async function planAndDesign(W, tag) {
  const ck = await call('dev.region.checkPlan', { plan: ladderPlan(), claim: W.claim, owner: OWNER, anchors: { grove: W.anchor }, load: 'generate' }, 1_800_000);
  fs.writeFileSync(path.join(OUT, `${tag}-check.json`), `${JSON.stringify(ck, null, 1)}\n`);
  const art = ck.check?.artifactSha ? (await call('dev.region.artifact', { sha: ck.check.artifactSha, body: true }, 60_000)).artifact : null;
  const lot = (art?.body?.lots ?? []).find((l) => l.id === 'hut_a') ?? null;
  if (!lot) return { ck, art, lot };
  const { Site } = await imp('lib/site.mjs');
  const { writeBlueprint } = await imp('lib/write.mjs');
  const ex = await imp('designs/site/fit_wrap_trunk.mjs');
  let file = volumeFile(lot.site.volumeSha);
  if (!file) {
    const sv = await call('dev.survey.volume', { box: arr(lot.site.volume), load: 'loaded' }, 600_000);
    check(sv.sha === lot.site.volumeSha, `${tag}: Survey.volume of hut_a's site volume has the plan's sha (${String(sv.sha).slice(0, 12)})`);
    file = volumeFile(lot.site.volumeSha);
  }
  check(!!file, `${tag}: hut_a's frozen site volume is in the world (architect/volumes)`);
  if (!file) return { ck, art, lot };
  for (const [bid, noport] of [['pl2_hut_a', false], ['pl2_hut_a_noport', true]]) {
    const bp = ex.default({ site: new Site(fs.readFileSync(file), lot.site) });
    bp.id = bid;
    const dir = path.join(L.LIBRARY, bid);
    fs.rmSync(dir, { recursive: true, force: true });
    writeBlueprint(bp, dir);
    if (noport) {
      const side = path.join(dir, `${bid}.blueprint.json`);
      const sj = JSON.parse(fs.readFileSync(side, 'utf8'));
      sj.ports = [];
      fs.writeFileSync(side, `${JSON.stringify(sj, null, 1)}\n`);
    }
  }
  await call('dev.pl.reload', {}, 60_000);
  return { ck, art, lot, ready: true };
}

steps.ingame = async () => {
  await ensure();
  spendZero();
  const out = {};
  const world = 'G6B PL2 Ingame';
  const W = await oneTree(world);
  out.groundY = W.gy;
  const P = await planAndDesign(W, 'ingame');
  const up = P.ck.check?.parts?.find((p) => p.part === 'up');
  const canopy = P.ck.check?.parts?.find((p) => p.part === 'canopy');
  out.check = { overall: P.ck.check?.overall, canopy: canopy?.class, up: up?.class, link: up?.geometry?.link, reasons: up?.reasons };
  check(P.ck.check?.overall === 'READY' && canopy?.class === 'fits' && up?.class === 'fits' && up?.geometry?.link?.to?.ground === true && !!P.lot,
    `the plan through Regions.checkPlan: ${P.ck.check?.overall}; canopy ${canopy?.class}, the ladder ${up?.class} (${json(up?.geometry?.link)})`, out.check);
  check(!!P.ready, 'SV\'s trunk house built on hut_a\'s Site into the library (pl2_hut_a, pl2_hut_a_noport)');
  if (!P.ready || up?.class !== 'fits') return out;
  const snap = path.join(OUT, 'ingame-snap.gz');
  await call('dev.region.hash', { box: W.claimBox, mode: 'snap', file: snap }, 3_600_000);
  // ---- NO_LINK: the hut bound to a copy without its port: refused before any write, no region
  const before = (await call('dev.region.list', {}, 60_000)).regions.length;
  const nl = await call('dev.region.realiseApproved', { sha: P.ck.check.artifactSha, lotEntries: { hut_a: 'pl2_hut_a_noport' } }, 600_000);
  const d0 = await call('dev.region.hash', { box: W.claimBox, mode: 'diff', file: snap }, 3_600_000);
  const after = (await call('dev.region.list', {}, 60_000)).regions.length;
  let detail = null;
  try { detail = JSON.parse(nl.detail ?? 'null'); } catch { /* not JSON */ }
  out.noLink = { refused: nl.refused ?? null, reason: nl.reason ?? null, detail, written: d0.mismatches, regions: [before, after] };
  check(!nl.region && nl.reason === 'NO_LINK' && detail?.lot === 'hut_a' && detail?.port === 'walk_w' && d0.mismatches === 0 && after === before,
    `NO_LINK: hut_a bound to its house without the port: refused ${nl.reason} detail ${json(detail)} (${String(nl.refused ?? '').slice(0, 160)}); ${d0.mismatches} cells written, no region`, out.noLink);
  // ---- realised from IR v2
  const rr = await call('dev.region.realiseApproved', { sha: P.ck.check.artifactSha, lotEntries: { hut_a: 'pl2_hut_a' } }, 600_000);
  if (!rr.region) { check(false, `realiseApproved refused (${json(rr)})`); return out; }
  const st = await L.waitRegion(rr.region, 3_600_000);
  await L.settle(3000);
  check(st.view.state === 'PLACED', `realiseApproved with the house bound: ${st.view.state}`);
  const ir = regionIr(world, rr.region);
  const rows = st.view.ext?.['architect_mc:links'] ?? [];
  out.report = rows;
  out.ir = { stages: ir.stages, linkParts: ir.parts.filter((p) => p.stage === 'site_links').map((p) => p.id), linked: Object.keys(ir.linked?.lots ?? {}), portLinks: ir.portLinks, irSha: st.view.irSha };
  check(ir.stages.includes('site_links') && json(out.ir.linkParts) === json(['link_up']) && json(out.ir.linked) === json(['hut_a']) && json(ir.portLinks?.[0]?.to) === json({ ground: true }),
    `the region's IR is IR v2: site_links holds ${json(out.ir.linkParts)}, linked ${json(out.ir.linked)}, the port link's to ${json(ir.portLinks?.[0]?.to)} (irSha ${String(st.view.irSha).slice(0, 12)})`, out.ir);
  const row = rows[0];
  check(rows.length === 1 && row?.id === 'up' && row.kind === 'ladder' && row.from?.lot === 'hut_a' && row.from?.port === 'walk_w' && row.to?.ground === true && Array.isArray(row.to?.foot) && row.part === 'link_up',
    `the realise report's $.links[] (RegionView.ext architect_mc:links): ${json(rows).slice(0, 300)}`);
  // the ladder in the world: every link cell as the IR writes it, none in the lot's box; the rungs ladders from the foot to the port's feet
  const cells = linkCells(ir);
  const box = arr(P.lot.box);
  const world1 = cells.length ? await cellsOf([Math.min(...cells.map((c) => c.at[0])), Math.min(...cells.map((c) => c.at[1])), Math.min(...cells.map((c) => c.at[2])), Math.max(...cells.map((c) => c.at[0])), Math.max(...cells.map((c) => c.at[1])), Math.max(...cells.map((c) => c.at[2]))]) : new Map();
  // (a ladder's facing too: its face is the post)
  const facingOf = (s) => /facing=([a-z]+)/.exec(String(s ?? ''))?.[1] ?? null;
  const wrong = cells.filter((c) => { const got = world1.get(k3(...c.at)) ?? 'minecraft:air'; return idOf(got) !== idOf(c.state) || (idOf(c.state) === 'ladder' && facingOf(got) !== facingOf(c.state)); });
  const inLot = cells.filter((c) => inBox(box, c.at));
  const rungs = cells.filter((c) => idOf(c.state) === 'ladder');
  const top = row ? Math.max(...rungs.map((c) => c.at[1])) : null;
  out.ladder = { cells: cells.length, wrong: wrong.length, firstWrong: wrong.slice(0, 4), inLot: inLot.length, rungs: rungs.length, top, portFeet: row?.from?.at?.[1], foot: row?.to?.foot };
  check(rungs.length >= 3 && wrong.length === 0 && inLot.length === 0 && top === row?.from?.at?.[1] && rungs.every((c) => c.at[0] === row.from.out[0] && c.at[2] === row.from.out[2]),
    `the ladder stands: ${cells.length} link cells as the IR writes them (${wrong.length} differ), none in the lot's box (K5); ${rungs.length} rungs in the port's out column up to its feet y ${top}`, out.ladder);
  // (recorded) dev.climb's physics probe: up the rungs and off into the port cell
  if (row) {
    const fx = row.from.at[0] - row.from.out[0], fz = row.from.at[2] - row.from.out[2];
    const pr = await call('dev.climb', { flights: [{ x: row.from.out[0], z: row.from.out[2], y0: row.to.foot[1], y1: top }], face: [-fx, -fz], exit: [...row.from.at] }, 180_000).catch((e) => ({ error: String(e.message ?? e) }));
    out.climb = pr;
    check(true, `(shown, recorded) dev.climb's physics probe up the ladder: ${pr.error ? `harness gap (${pr.error.slice(0, 160)})` : `flights ${json((pr.flights ?? []).map((f) => [f.reached, f.ticks]))}, exited ${pr.exited ?? null}, ok ${pr.ok}`}`);
  }
  const rec = await call('dev.sl.lot', { region: rr.region, lot: 'hut_a' }, 60_000);
  check(rec.known && rec.entry === 'pl2_hut_a', `hut_a: placed with ${rec.entry} (${rec.state})`, { state: rec.state, entry: rec.entry });
  const rm = await removeRegion(rr.region);
  const d = await call('dev.region.hash', { box: W.claimBox, mode: 'diff', file: snap }, 3_600_000);
  out.remove = { removed: rm.removed, mismatches: d.mismatches, list: (d.list ?? []).slice(0, 8) };
  check(rm.removed !== false && d.mismatches === 0, `Regions.remove: E-flat ${d.mismatches} over the claim`, out.remove);
  await L.leaveWorld?.();
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
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7c-PL2 (the port ladder)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7cpl2.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
