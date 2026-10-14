#!/usr/bin/env node
// Phase 6c slice P0 gate (docs/CONTRACT.md "Phase 6c slice P0: plan check v0" §8) against the headless server (or a dev client) of the
// P0 run worktree (`../architect-mc-P0-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). Ports 8906
// (sidecar) / 8907 (DevBridge) by default. $0: no Claude call anywhere; spend.json reads $0.00.
//
//   node tools/gate6cp0.mjs <step>
//     unit       the kit's P0 tests (items 1-3, 7-11: fixtures, the seven classes, determinism, incomplete, cache, catalogue and its diff,
//                Steward's 59 recorded plans with the gap table; the op goldens), the catalogue-diff tool on the committed fixtures, the
//                sidecar's plan-check test (ajv 2020-12 over the fixtures, a check through the sidecar), api-compat --gate6cp0 (item 13)
//     ingame     on the flat world (S7's flat claim): a crafted plan checked 3 times under /tick freeze (item 3 in game: one IR, one
//                artifact sha), keys (idempotence, conflict, an in-flight twin, cancel), then item 4 (realiseApproved: the region's irSha
//                and every tile sha equal the artifact's; the realised world equals the check's virtual world over the written cells;
//                Regions.remove restores the world hash: E-flat 0), item 5 (a block changed in a planned tile, then a protected area over
//                the zone: ARTIFACT_STALE, nothing written; recheck, approve, realise), item 6 (realiseApproved with a key, the world
//                stopped mid-realise, reload: realiseByKey finds it and it completes; checkByKey after the reload), pins and the tombstone
//                (ARTIFACT_UNAPPROVED), planImages
//     natural    item 4 on S3's pinned claim (a fresh copy of the seed world): check, realiseApproved, irSha and tile shas against the
//                artifact, realised vs virtual over the written cells (at most 0.01% differ), the removal's E-normal all classified
//     report     REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-p0/<step>.json in the main checkout (GATE6CP0_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-P0-run');
process.env.GATE6B_OUT = process.env.GATE6CP0_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-p0');
process.env.GATE6B_SIDECAR_PORT ??= '8906';
process.env.GATE6B_DEV_PORT ??= '8907';
const L = await import('./lib/run6b.mjs');
const { OUT, bar, call, check, cmd, connect, fails, leaveWorld, log, results, root, state, tp } = L;

L.refuseKeys();
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const OWNER = 'test:p0';
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => JSON.stringify(o).replaceAll(' ', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lots = (n, p = 'h') => Array.from({ length: n }, (_, i) => ({ id: `${p}${i + 1}`, type: i % 2 ? 'house' : 'cottage', size: [9, 9] }));

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
  L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice P0 is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}
const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args}: no JSON answer: ${JSON.stringify(r).slice(0, 400)}`);
  return JSON.parse(line);
};
const planDir = (planId) => path.join(L.SIDECAR_DATA, 'regions', 'plans', planId);

// ------------------------------------------------------------------ offline

function sh(cmdline, opts = {}) {
  const r = spawnSync('bash', ['-c', cmdline], { cwd: root, encoding: 'utf8', timeout: 3_600_000, env: { ...process.env, JAVA_HOME }, ...opts });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

steps.unit = async () => {
  const out = {};
  const k = sh('node --test kit/test/plan-p0.test.mjs kit/test/plan-ops.test.mjs kit/test/scenario-goldens.test.mjs');
  fs.writeFileSync(path.join(OUT, 'unit-kit.log'), k.out);
  const pass = Number(/^ℹ pass (\d+)/m.exec(k.out)?.[1] ?? 0), fail = Number(/^ℹ fail (\d+)/m.exec(k.out)?.[1] ?? 1);
  out.kit = { pass, fail };
  check(k.code === 0 && fail === 0 && pass > 0, `items 1-3, 7-12 (kit): plan-p0, plan-ops and scenario-goldens: ${pass} pass, ${fail} fail`);
  const gap = k.out.split('\n').filter((l) => /^# /.test(l)).map((l) => l.slice(2));
  out.asks = gap;
  fs.writeFileSync(path.join(OUT, 'asks-gap-table.txt'), `${gap.join('\n')}\n`);
  check(gap.some((l) => /^59 asks: /.test(l)), `item 11: the 59 recorded plans' table (${gap.find((l) => /^59 asks/.test(l)) ?? 'missing'})`);
  const d = sh('node tools/plan-catalogue-diff.mjs kit/test/fixtures/plan/catalogue-p0.json kit/schemas/plan-catalogue.golden.json --pending kit/test/fixtures/plan/pending-two-districts.json');
  fs.writeFileSync(path.join(OUT, 'catalogue-diff.txt'), d.out);
  out.catalogueDiff = d.out;
  check(d.code === 0 && /reserved -> supported: endpoint\.region, program\.districts\n/.test(d.out) && /recheck \(pending parts now supported\): craftsmen_district \{program\.districts\}/.test(d.out) && /^added: none$/m.test(d.out),
    'item 9: tools/plan-catalogue-diff.mjs lists exactly endpoint.region and program.districts reserved -> supported, and flags the pending part');
  const s = sh('cd sidecar && npx vitest run test/plan-check.test.ts');
  fs.writeFileSync(path.join(OUT, 'unit-sidecar.log'), s.out);
  check(s.code === 0 && /Tests\s+\d+ passed/.test(s.out), `item 1 (ajv 2020-12) and the sidecar half: ${(/Tests\s+[^\n]+/.exec(s.out) ?? ['?'])[0]}`);
  sh(`cd mod && GRADLE_USER_HOME=${path.join(root, '.gradle-home')} ./gradlew compileJava compileClientJava --offline -q`);
  const a = sh(`node tools/api-compat.mjs --gate6cp0`);
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), a.out);
  check(a.code === 0 && /all 4 checks clean/.test(a.out), `item 13: api-compat against the 0.25.0, 0.24.0 and 0.23.0 apitest jars and the 0.25.0 surface: ${a.out.trim().split('\n').pop()}`);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game helpers

async function checkPlan(plan, claim, extra = {}) {
  const r = await call('dev.region.checkPlan', { plan, claim, owner: OWNER, ...extra }, 900_000);
  if (r.refused) return r;
  log(`  check ${r.check.checkId}: ${r.check.overall} ${r.check.parts.map((p) => `${p.part}:${p.class}`).join(' ')} artifact ${r.check.artifactSha?.slice(0, 12) ?? '-'} (${Math.round(r.ms)} ms)`);
  return r.check;
}
async function waitPlaced(region) {
  return L.waitRegion(region, 3 * 3_600_000, async (s) => { if (s.waiting?.OCCUPIED) await cmd('/kill @e[type=!minecraft:player]'); });
}
/**
 * The realised world against the check's virtual world over every written cell outside the lot boxes (realised without entries: the lots
 * are their pads, which are plan cells under the boxes): {written, differ, kept, road, share, first}. A cell that
 * differs but holds what it held before the realise is `kept` (the op's condition skipped it: a structure, or a block that is not
 * natural, which the survey can't see); `differ` counts the rest (unclassified), and `share` is differ / written.
 */
async function realisedVsVirtual(pdir, afterFile, beforeFile = null) {
  const { buildVirtual, decodeArwd } = await imp('lib/region/vworld.mjs');
  const ir = JSON.parse(fs.readFileSync(path.join(pdir, 'ir.json'), 'utf8'));
  const blobs = (sha) => { const f = path.join(pdir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw } = buildVirtual({ ir, survey: fs.readFileSync(path.join(pdir, 'survey.bin')), blobs });
  const d = await decodeArwd(fs.readFileSync(afterFile));
  const b = d.box;
  const pre = beforeFile ? await decodeArwd(fs.readFileSync(beforeFile)) : null;
  const inLot = (x, y, z) => ir.lots.some((l) => x >= l.box.minX && x <= l.box.maxX && y >= l.box.minY && y <= l.box.maxY && z >= l.box.minZ && z <= l.box.maxZ);
  // 4e ground roads (the village street) follow the realised ground at realise (4e's rule; T2 as built): their cells within 2 of the
  // road's centre line are classed `road`, recorded
  const { centreCells } = await imp('lib/region/geom.mjs');
  const roadCols = new Set();
  for (const r of ir.roads ?? []) for (const c of centreCells(r.points.map((q) => [q[0], q[2]])).cells) for (let dx = -2 - (r.width >> 1); dx <= 2 + (r.width >> 1); dx++) for (let dz = -2 - (r.width >> 1); dz <= 2 + (r.width >> 1); dz++) roadCols.add(`${c.x + dx},${c.z + dz}`);
  let written = 0, differ = 0, kept = 0, road = 0;
  const first = [];
  // the same block: the name, and every property the plan names (the world's state lists every property, the plan only the ones it sets;
  // the rest are the block's defaults or its neighbour-dependent ones: fence and pane connections, stair shape, snowy grass)
  const parse = (st) => { const m = /^([^[]+)(?:\[(.*)\])?$/.exec(st); return { name: m[1], props: Object.fromEntries((m[2] ? m[2].split(',') : []).map((kv) => kv.split('='))) }; };
  const same = (want, got) => { if (want === got) return true; const a = parse(want), b = parse(got); return a.name === b.name && Object.entries(a.props).every(([k, v]) => b.props[k] === v); };
  const at = (x, y, z) => (x - b.minX) * (b.maxZ - b.minZ + 1) * (b.maxY - b.minY + 1) + (z - b.minZ) * (b.maxY - b.minY + 1) + (y - b.minY);
  vw.eachWritten((x, y, z, idx) => {
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ || inLot(x, y, z)) return;
    written++;
    const want = vw.pal.states[idx], got = d.palette[d.cells[d.at ? d.at(x, y, z) : at(x, y, z)]];
    if (!same(want, got) && pre && pre.palette[pre.cells[pre.at(x, y, z)]] === got) { kept++; return; }
    if (!same(want, got) && roadCols.has(`${x},${z}`)) { road++; return; }
    if (!same(want, got)) { differ++; if (first.length < 12) first.push({ pos: [x, y, z], want, got }); }
  });
  return { written, differ, kept, road, share: written ? differ / written : 0, first };
}
/** A column's ground in a plan's survey. */
async function groundAt(pdir, x, z) {
  const { decodeColumns } = await imp('lib/region/pack.mjs');
  const c = decodeColumns(fs.readFileSync(path.join(pdir, 'survey.bin')));
  return c.ground[Math.floor((x - c.minX) / c.resolution) + Math.floor((z - c.minZ) / c.resolution) * c.width];
}
/** The artifact's tile shas against the ones the realise received: {tiles, equal, missing, differ}. */
function compareTiles(artifact, got) {
  const want = {};
  for (const [stage, sets] of Object.entries(artifact.region.tiles)) for (const [set, keys] of Object.entries(sets)) for (const [k, sha] of Object.entries(keys)) want[`${stage}|${set}|${k}`] = sha;
  const differ = Object.keys(want).filter((k) => got[k] !== undefined && got[k] !== want[k]);
  const missing = Object.keys(want).filter((k) => got[k] === undefined);
  return { tiles: Object.keys(want).length, received: Object.keys(got).length, equal: Object.keys(want).length - differ.length - missing.length, missing, differ };
}

// the crafted S7 flat plan: a zone near the stone with its pads blended, a path from the south, a rock spire in the north
const S7 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's7_flat_village.json'), 'utf8')).fixture.claim;
const S7_PLAN = { schemaVersion: 'plan/0', planId: 'gate_p0_s7', zones: [{ id: 'town', required: true, program: { lots: lots(4) }, where: { near: { anchor: 'stone', within: 16 } }, ext: { 'steward_mc:zone': 'Z1' } }],
  connectors: [{ id: 'lane', kind: 'path', from: { anchor: 'claim_s' }, to: { part: 'town' } }],
  forms: [{ id: 'blend', kind: 'relief', around: ['town'], radius: 8 }, { id: 'spire', kind: 'rock_spire', preset: 'hoodoo', where: { near: { anchor: 'claim_n', within: 12 } } }] };
const centre = (c) => [(c[0] + c[2]) >> 1, (c[1] + c[3]) >> 1];

steps.ingame = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B P0 Ingame', FLAT);
  await L.setRules('exact');
  const claim = [...S7];
  const [cx, cz] = centre(claim);
  await tp(cx, 0, cz);
  const anchors = { stone: [cx, -60, cz] };
  // ---- item 3 in game: three checks under /tick freeze give one IR and one artifact
  await cmd('/tick freeze');
  const c3 = [];
  try { for (let i = 0; i < 3; i++) c3.push(await checkPlan(S7_PLAN, claim, { anchors })); } finally { await cmd('/tick unfreeze'); }
  const c1 = c3[0];
  out.checks = c3.map((c) => ({ checkId: c.checkId, overall: c.overall, artifactSha: c.artifactSha }));
  check(c1.overall === 'READY' && c1.parts.every((p) => p.class === 'fits'), `item 4: the S7 flat plan checks READY (${c1.parts.map((p) => `${p.part}:${p.class}`).join(' ')})`, c1.parts);
  check(c3.every((c) => c.artifactSha && c.artifactSha === c1.artifactSha) && c3.every((c) => c.checkId !== c1.checkId || c === c1), `item 3 (in game): 3 checks, one artifact sha ${c1.artifactSha?.slice(0, 12)}`);
  const irs = c3.map((c) => JSON.parse(fs.readFileSync(path.join(planDir(c.checkId), 'artifact.json'), 'utf8')).region.irSha);
  check(new Set(irs).size === 1, `item 3 (in game): one IR sha over the 3 checks (${irs[0].slice(0, 12)})`);
  const ext = c1.parts.find((p) => p.part === 'town').ext;
  check(json(ext) === json({ 'steward_mc:zone': 'Z1' }), `the part's ext echoed unchanged (${json(ext)})`);
  check(!!c1.preview?.classMap?.path && fs.existsSync(c1.preview.classMap.path) && (c1.preview.siteplan?.planParts ?? []).length >= 2, `the light preview: the class map ${c1.preview?.classMap?.width}x${c1.preview?.classMap?.height} and the site plan's part rects`);
  const img = await call('dev.region.planImages', { checkId: c1.checkId, views: ['top', 'iso'] }, 300_000);
  check(!!img.images?.top?.length && img.images.top.every((p) => fs.existsSync(p)), `images on request: planImages top and iso (${json(Object.keys(img.images ?? {}))})`);
  // ---- keys: idempotence, conflict, an in-flight twin, cancel
  const K = `steward.p0.${Date.now().toString(36)}`;
  const twinA = call('dev.region.checkPlan', { plan: S7_PLAN, claim, owner: OWNER, anchors, opKey: K }, 900_000);
  await sleep(200);
  const twinB = call('dev.region.checkPlan', { plan: S7_PLAN, claim, owner: OWNER, anchors, opKey: K }, 900_000);
  const [ta, tb] = await Promise.all([twinA, twinB]);
  check(ta.check && tb.check && ta.check.checkId === tb.check.checkId, `keys: an in-flight twin with the same key and body shares the check (${ta.check?.checkId}, ${tb.check?.checkId})`);
  const again = await call('dev.region.checkPlan', { plan: S7_PLAN, claim, owner: OWNER, anchors, opKey: K }, 900_000);
  check(again.check?.checkId === ta.check?.checkId, `keys: the same key and body returns the same check (${again.check?.checkId})`);
  const other = await call('dev.region.checkPlan', { plan: { ...S7_PLAN, planId: 'other' }, claim, owner: OWNER, anchors, opKey: K }, 900_000);
  check(other.reason === 'OP_KEY_CONFLICT', `keys: the same key with another body refuses OP_KEY_CONFLICT (${other.refused?.slice(0, 120)})`);
  const otherOwner = await call('dev.region.checkPlan', { plan: { ...S7_PLAN, planId: 'other' }, claim, owner: 'test:p0b', anchors, opKey: K }, 900_000);
  check(!!otherOwner.check, 'keys: another owner\'s key is its own (owner scope)');
  const KC = `${K}.cancel`;
  const pend = call('dev.region.checkPlan', { plan: S7_PLAN, claim, owner: OWNER, anchors, opKey: KC }, 900_000);
  await sleep(150);
  const cc = await call('dev.region.cancelCheck', { owner: OWNER, opKey: KC });
  const cres = await pend;
  check(cc.cancelled === true && /CANCELLED/.test(cres.refused ?? ''), `cancel: cancelCheck stops a running check (cancelled ${cc.cancelled}; its answer ${cres.refused ?? cres.check?.overall})`);
  const kb = await call('dev.region.checkByKey', { owner: OWNER, opKey: KC });
  check(kb.check === null, 'cancel: nothing kept for the cancelled check (checkByKey empty)');
  const ff = await call('dev.region.checkPlan', { plan: S7_PLAN, claim, owner: OWNER, anchors, cancelAfterMs: 0 }, 900_000);
  check(/CANCELLED/.test(ff.refused ?? ''), `cancel: future.cancel(true) answers CANCELLED (${ff.refused})`);
  // ---- item 4: approve (the artifact), realise, the irSha and tile shas, realised vs virtual, the exact undo
  const sha = c1.artifactSha;
  const art = (await call('dev.region.artifact', { sha, body: true })).artifact;
  check(!!art && !art.removed && art.body.region.irSha === irs[0] && fs.existsSync(path.join(planDir(art.planId), 'ir.json')), `the artifact is kept by its sha (${sha.slice(0, 12)}, plan ${art?.planId})`);
  const ir = JSON.parse(fs.readFileSync(path.join(planDir(c1.checkId), 'ir.json'), 'utf8'));
  const box = [claim[0] - 8, ir.claim.minY, claim[1] - 8, claim[2] + 8, ir.claim.maxY, claim[3] + 8];
  const before = path.join(OUT, 'ingame-before.arwd.gz'), after = path.join(OUT, 'ingame-after.arwd.gz');
  await call('dev.region.dump', { box, file: before, light: false }, 900_000);
  const h0 = await call('dev.region.hash', { box }, 3_600_000);
  // (realised without entries: every lot a pad, so every written cell is the plan's; entries are bound in items 5 and 6)
  const rr = await call('dev.region.realiseApproved', { sha }, 300_000);
  check(!!rr.region, `item 4: realiseApproved queued region ${rr.region ?? rr.refused}`);
  const st = await waitPlaced(rr.region);
  check(st.view.state === 'PLACED' && st.view.irSha === art.body.region.irSha, `item 4: ${st.view.state}; the region's irSha equals the artifact's (${st.view.irSha?.slice(0, 12)})`);
  const ts = await call('dev.region.tileShas', { region: rr.region });
  out.tiles = compareTiles(art.body, ts.tiles);
  check(out.tiles.tiles > 0 && out.tiles.equal === out.tiles.tiles, `item 4: every tile sha the realise received equals the artifact's (${out.tiles.equal}/${out.tiles.tiles}; missing ${out.tiles.missing.length}, differ ${out.tiles.differ.length})`, out.tiles);
  await call('dev.region.dump', { box, file: after, light: false }, 900_000);
  out.virtual = await realisedVsVirtual(planDir(c1.checkId), after, before);
  check(out.virtual.written > 0 && out.virtual.differ === 0 && out.virtual.kept === 0 && out.virtual.road === 0, `item 4: the realised world equals the check's virtual world over ${out.virtual.written} written cells (E-flat: ${out.virtual.differ} differ)`, out.virtual.first);
  const ref = (await call('dev.region.artifact', { sha })).artifact;
  check(ref.regions.includes(rr.region), `retention: the standing region refers to the artifact (${json(ref.regions)})`);
  await cmd('/kill @e[type=!minecraft:player]');
  const rm = await call('dev.region.remove', { region: rr.region, requester: OWNER }, 3_600_000);
  await L.settle(3000);
  const h1 = await call('dev.region.hash', { box }, 3_600_000);
  out.undo = { removed: rm.removed, restored: rm.restored, same: h0.sha256 === h1.sha256 };
  check(rm.removed && h0.sha256 === h1.sha256, `item 4: Regions.remove restores the world hash (E-flat 0; ${rm.restored} cells restored)`);
  // ---- item 5: a block changed in a planned tile, then a protected area over the zone: ARTIFACT_STALE and nothing written
  const town = c1.parts.find((p) => p.part === 'town').geometry;
  const [zx, zz] = [(town.rect[0] + town.rect[2]) >> 1, (town.rect[1] + town.rect[3]) >> 1];
  const gy = await groundAt(planDir(c1.checkId), zx, zz);
  const regionsBefore = (await call('dev.region.list', {})).regions?.length ?? null;
  await cmd(`/setblock ${zx} ${gy + 1} ${zz} minecraft:stone`);
  const h2 = await call('dev.region.hash', { box }, 3_600_000);
  const s1 = await call('dev.region.realiseApproved', { sha, fill: ['g6a_stub_9'] }, 300_000);
  const h3 = await call('dev.region.hash', { box }, 3_600_000);
  const regionsAfter = (await call('dev.region.list', {})).regions?.length ?? null;
  out.staleBlock = { refused: s1.refused, region: s1.region ?? null };
  check(s1.reason === 'ARTIFACT_STALE' && /\(\s*-?\d+, -?\d+\)/.test(s1.refused) && h2.sha256 === h3.sha256 && regionsBefore === regionsAfter,
    `item 5: a block placed on a planned tile (${zx}, ${gy + 1}, ${zz}): ARTIFACT_STALE naming the column, nothing written (hash equal, ${regionsAfter} regions) (${s1.refused?.slice(0, 160)})`);
  await cmd(`/setblock ${zx} ${gy + 1} ${zz} minecraft:air`);
  const area = { owner: OWNER, id: 'p0', x0: zx - 2, z0: zz - 2, x1: zx + 2, z1: zz + 2, label: 'P0_area' };
  await api(`unprotect ${OWNER} p0`).catch(() => null);
  await api(`protect ${json(area)}`);
  const s2 = await call('dev.region.realiseApproved', { sha, fill: ['g6a_stub_9'] }, 300_000);
  const h4 = await call('dev.region.hash', { box }, 3_600_000);
  out.staleArea = { refused: s2.refused };
  check(s2.reason === 'ARTIFACT_STALE' && /protect/i.test(s2.refused) && /p0/.test(s2.refused) && h4.sha256 === h0.sha256, `item 5: a protected area added over the zone: ARTIFACT_STALE naming it, nothing written (${s2.refused?.slice(0, 160)})`);
  await api(`unprotect ${OWNER} p0`);
  const re = await checkPlan(S7_PLAN, claim, { anchors });
  check(re.artifactSha === sha, `item 5: the recheck (land and protection back) answers the same artifact (${re.artifactSha?.slice(0, 12)})`);
  const r2 = await call('dev.region.realiseApproved', { sha: re.artifactSha, fill: ['g6a_stub_9'] }, 300_000);
  const st2 = r2.region ? await waitPlaced(r2.region) : null;
  check(st2?.view.state === 'PLACED', `item 5: recheck, approve, realise works (${r2.region} ${st2?.view.state ?? r2.refused})`);
  const rm2 = await call('dev.region.remove', { region: r2.region, requester: OWNER }, 3_600_000);
  await L.settle(3000);
  const h5 = await call('dev.region.hash', { box }, 3_600_000);
  check(rm2.removed && h5.sha256 === h0.sha256, 'item 5: and its removal is exact (E-flat 0)');
  // ---- item 6: realiseApproved with a key, the world stopped mid-realise, reload: realiseByKey finds it and it completes
  const RK = `steward.p0r.${Date.now().toString(36)}`;
  await call('dev.region.holdRealise', { on: true });
  await call('dev.placement.slow', { on: true }).catch(() => null);
  const held = call('dev.region.realiseApproved', { sha, fill: ['g6a_stub_9'], opKey: RK }, 900_000).catch((e) => ({ refused: String(e?.message ?? e) }));
  let region = null;
  for (let i = 0; i < 240 && !region; i++) {
    region = ((await call('dev.region.list', {})).regions ?? []).find((v) => (v.planId ?? v.view?.planId) === c1.checkId && !['REMOVED'].includes(v.state ?? v.view?.state))?.id ?? null;
    if (!region) region = (await call('dev.region.realiseByKey', { owner: OWNER, opKey: RK })).region?.id ?? null;
    if (!region) await sleep(500);
  }
  check(!!region, `item 6: the keyed realise wrote its region record (${region}) while its future is held`);
  await call('dev.world.leave', {}, 300_000);
  for (let i = 0; i < 600 && (await call('dev.state')).inWorld; i++) await sleep(500);
  const heldAns = await held;
  await call('dev.world.open', { name: 'G6B P0 Ingame' }, 30_000);
  await L.waitInWorld();
  await call('dev.placement.slow', { on: false }).catch(() => null);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
  check(/WORLD_STOPPED/.test(heldAns.refused ?? ''), `item 6: the held realiseApproved failed WORLD_STOPPED at the stop (${heldAns.refused?.slice(0, 100)})`);
  const found = await call('dev.region.realiseByKey', { owner: OWNER, opKey: RK });
  check(found.region?.id === region, `item 6: after the reload Regions.realiseByKey finds it (${found.region?.id} ${found.region?.state})`);
  const done = await waitPlaced(region);
  check(done.view.state === 'PLACED', `item 6: the interrupted realise resumes and completes (${done.view.state})`);
  const kb2 = await call('dev.region.checkByKey', { owner: OWNER, opKey: K });
  check(kb2.check?.checkId === ta.check.checkId, `item 6: checkByKey finds the keyed check after the reload (${kb2.check?.checkId})`);
  const same = await call('dev.region.realiseApproved', { sha, fill: ['g6a_stub_9'], opKey: RK }, 300_000);
  check(same.region === region, `item 6: realiseApproved again with the key returns the region (${same.region ?? same.refused})`);
  const rm3 = await call('dev.region.remove', { region, requester: OWNER }, 3_600_000);
  await L.settle(3000);
  const h6 = await call('dev.region.hash', { box }, 3_600_000);
  check(rm3.removed && h6.sha256 === h0.sha256, 'item 6: the resumed region\'s removal is exact (E-flat 0)');
  // ---- pins and the tombstone
  const p1 = (await call('dev.region.pinArtifact', { sha, owner: OWNER, on: true })).artifact;
  const p2 = (await call('dev.region.pinArtifact', { sha, owner: OWNER, on: true })).artifact;
  check(json(p1.pinnedBy) === json([OWNER]) && json(p2.pinnedBy) === json([OWNER]), `pins: pinArtifact holds it, idempotent (${json(p2.pinnedBy)})`);
  const u1 = (await call('dev.region.pinArtifact', { sha, owner: OWNER, on: false })).artifact;
  check(u1.removed === true && u1.removedAt > 0, `pins: unpinning the last pin of an unreferenced artifact removes it, leaving a tombstone (removedAt ${u1.removedAt})`);
  const gone = await call('dev.region.realiseApproved', { sha }, 300_000);
  check(gone.reason === 'ARTIFACT_UNAPPROVED' && /removed/.test(gone.refused), `pins: realiseApproved on the tombstone refuses ARTIFACT_UNAPPROVED (${gone.refused?.slice(0, 100)})`);
  const unk = await call('dev.region.realiseApproved', { sha: 'f'.repeat(64) }, 300_000);
  check(unk.reason === 'ARTIFACT_UNAPPROVED', 'pins: an unknown sha refuses ARTIFACT_UNAPPROVED');
  const big = await call('dev.region.checkPlan', { plan: { schemaVersion: 'plan/0', notes: 'x'.repeat(2000), ext: { 'steward_mc:pad': 'y'.repeat(70000) } }, claim, owner: OWNER, anchors }, 300_000);
  check(big.reason === 'FIELD_LIMIT', `a plan over 64 KB refuses FIELD_LIMIT (${big.refused?.slice(0, 100)})`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ S3 (natural): item 4

const S3 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'route_demo.json'), 'utf8'));
const S3_PLAN = { schemaVersion: 'plan/0', planId: 'gate_p0_s3', zones: [{ id: 'hamlet', program: { lots: lots(3) }, where: { near: { anchor: 'stone', within: 40 } } }],
  forms: [{ id: 'blend', kind: 'relief', around: ['hamlet'], radius: 10 }] };

steps.natural = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B P0 S3', await L.seedBase(SEED));
  await L.setRules('default');
  const claim = [...S3.fixture.claim];
  const [cx, cz] = centre(claim);
  await tp(cx, S3.fixture.yRange[1], cz);
  await L.settle(60_000);
  // the stone on route_demo's hall pad (a pinned clean site: no structure, no ice under the hamlet)
  const anchors = { stone: [S3.params.hallX + 4, 100, S3.params.hallZ + 4] };
  // the land must not move between the check and the realise (the stale rule is exact; a tile's heights are frozen when it is asked):
  // ticks frozen from the check until the realised dump (placement runs on the server tick, which freezing does not stop)
  await cmd('/tick freeze');
  let c, rr, art, st;
  try {
    c = await checkPlan(S3_PLAN, claim, { anchors });
    out.check = { overall: c.overall, parts: c.parts.map((p) => `${p.part}:${p.class}`), artifactSha: c.artifactSha };
    check(['READY', 'NEEDS_REPAIR'].includes(c.overall) && !!c.artifactSha, `item 4 (S3): the plan checks ${c.overall} (${out.check.parts.join(' ')}) with an artifact`);
    art = (await call('dev.region.artifact', { sha: c.artifactSha, body: true })).artifact;
    const ir = JSON.parse(fs.readFileSync(path.join(planDir(c.checkId), 'ir.json'), 'utf8'));
    out.box = [claim[0] - 8, ir.claim.minY, claim[1] - 8, claim[2] + 8, ir.claim.maxY, claim[3] + 8];
    await call('dev.region.dump', { box: out.box, file: path.join(OUT, 'natural-before.arwd.gz'), light: false }, 900_000);
    await call('dev.region.hash', { box: out.box, mode: 'snap', file: path.join(OUT, 'natural-snap.gz') }, 4 * 3_600_000);
    await cmd('/kill @e[type=!minecraft:player]');
    rr = await call('dev.region.realiseApproved', { sha: c.artifactSha }, 300_000);
    check(!!rr.region, `item 4 (S3): realiseApproved queued ${rr.region ?? rr.refused}`);
    st = await waitPlaced(rr.region);
  } catch (e) {
    await cmd('/tick unfreeze');
    throw e;
  }
  check(st.view.state === 'PLACED' && st.view.irSha === art.body.region.irSha, `item 4 (S3): ${st.view.state}; irSha equals the artifact's`);
  const ts = await call('dev.region.tileShas', { region: rr.region });
  out.tiles = compareTiles(art.body, ts.tiles);
  check(out.tiles.equal === out.tiles.tiles, `item 4 (S3): every tile sha equals the artifact's (${out.tiles.equal}/${out.tiles.tiles})`, out.tiles);
  const after = path.join(OUT, 'natural-after.arwd.gz');
  await call('dev.region.dump', { box: out.box, file: after, light: false }, 900_000);
  await cmd('/tick unfreeze');
  out.virtual = await realisedVsVirtual(planDir(c.checkId), after, path.join(OUT, 'natural-before.arwd.gz'));
  out.skipped = st.view.cellsSkipped ?? {};
  const skips = Object.values(out.skipped).reduce((a, b) => a + b, 0);
  check(out.virtual.kept <= skips, `item 4 (S3): every cell kept by its condition is one the realise counted as skipped (${out.virtual.kept} kept, ${skips} skipped: ${json(out.skipped)})`);
  check(out.virtual.written > 0 && out.virtual.share <= 0.0001, `item 4 (S3): the realised world equals the virtual world over ${out.virtual.written} written cells: ${out.virtual.differ} unclassified (${(100 * out.virtual.share).toFixed(4)}%, at most 0.01%), ${out.virtual.kept} kept by their op's condition (a structure or a non-natural block the survey can't see), ${out.virtual.road} on 4e ground roads (they follow the realised ground)`, out.virtual.first);
  await cmd('/kill @e[type=!minecraft:player]');
  await L.settle(5000);
  const rm = await call('dev.region.remove', { region: rr.region, requester: OWNER }, 4 * 3_600_000);
  await L.settle(10_000);
  const diff = await call('dev.region.hash', { box: out.box, mode: 'diff', file: path.join(OUT, 'natural-snap.gz') }, 4 * 3_600_000);
  // T2's `melt` world class (scenarios.mjs meltOf, as built): a snow layer gone to air at a cell the plan never writes, lit over 11 by
  // a light the plan placed (emission minus the Manhattan distance); any written cell stays unclassified
  const { buildVirtual, F_WRITTEN } = await imp('lib/region/vworld.mjs');
  const pdir = planDir(c.checkId);
  const irN = JSON.parse(fs.readFileSync(path.join(pdir, 'ir.json'), 'utf8'));
  const { vw } = buildVirtual({ ir: irN, survey: fs.readFileSync(path.join(pdir, 'survey.bin')), blobs: (s) => { const f = path.join(pdir, 'blobs', `${s}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; } });
  const lights = [];
  vw.eachWritten((x, y, z, idx) => { const em = vw.pal.emit[idx]; if (em > 11) lights.push([x, y, z, em]); });
  const lit = (x, y, z) => lights.some(([lx, ly, lz, em]) => em - (Math.abs(lx - x) + Math.abs(ly - y) + Math.abs(lz - z)) > 11);
  const list = (diff.list ?? []).map((m) => {
    if (m.class !== 'none' || !/^minecraft:snow\[/.test(m.was) || !/^minecraft:(air|cave_air)$/.test(m.now)) return m;
    const [x, y, z] = m.pos.split(',').map(Number);
    return !(vw.flags(x, y, z) & F_WRITTEN) && lit(x, y, z) ? { ...m, class: 'melt' } : m;
  });
  const melted = list.filter((m) => m.class === 'melt').length;
  const classes = { ...(diff.classes ?? {}) };
  if (melted) { classes.none -= melted; classes.melt = (classes.melt ?? 0) + melted; }
  diff.classes = classes;
  out.exact = { removed: rm.removed, restored: rm.restored, mismatches: diff.mismatches, classes, list: list.filter((m) => m.class === 'none' || m.class === 'melt').slice(0, 40) };
  check(rm.removed && (diff.classes?.none ?? 0) === 0, `item 4 (S3): Regions.remove: E-normal ${diff.mismatches} mismatches, all classified (${json(diff.classes)})`, out.exact.list);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'ingame', 'natural']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 6c-P0 (plan check v0)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};
void bar;

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cp0.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
