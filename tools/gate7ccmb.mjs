#!/usr/bin/env node
// Slice CM-b gate (7c composites, placement; docs/CONTRACT.md "Phase 7c" §3 row 6, "Slice CM-b as built") against the headless server of the
// CM-b run worktree (GATE6B_RUN, default `../architect-mc-CM-b-run`; the sim sidecar, no Claude, apitest on the classpath). $0.
//
//   node tools/gate7ccmb.mjs <step>
//     ingame   (cmb-ingame)  the composite castle (CM-a's, 121 long) from a sim design group item (sim:composite): one entry for the one
//                            item (itemKey == lotId: the entry's groupItem, the only entry bound to it), its module entries hidden from
//                            Library.list but readable, CompositeInfo.of(entry) its wire, the feature "composites"; placed through
//                            Sites.place as ONE site group (one stage per module, LAYER on the seams: a seam cell's stack is 2) and
//                            removed exactly in both orders: whole first (Sites.remove of the handle, rotation 0) and module first
//                            (undoStage of the last module, then Sites.remove of the rest, rotation 1), E-flat 0 each; a module refused at
//                            fit (a chest in the east module's box) names it and places nothing; JOINT_MISMATCH (the east module's arch
//                            made 2 wide on disk) names the module and the port and places nothing; survival: refused NOT_ALLOWED naming
//                            the composite
//     crash    (cmb-crash)   (strict) a clean placement's hash recorded and removed; then /save-all flush, kill point CM1+save (the first
//                            module placed and the queue file written, the next module not started), restart: the composite's batch
//                            resumes, every module stands, verifies, and the area equals the clean placement's hash; Sites.remove of the
//                            whole is E-flat 0. The server log is searched for "does not match its blueprint" (slice JR's symptom)
//     report                 REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7c-cmb/<step>.json in the main checkout (GATE7CCMB_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-CM-b-run');
process.env.GATE6B_OUT = process.env.GATE7CCMB_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7c-cmb');
process.env.GATE6B_SIDECAR_PORT ??= '8916';
process.env.GATE6B_DEV_PORT ??= '8917';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, LIBRARY, GAME_DIR, check, connect, log, results, root, state, call, cmd, sleep } = L;

L.refuseKeys();
const FLAT = 'G6B Flat Base';
const OWNER = 'apitest:village/1'; // apitest's owner for an "owned" placement (the remove's requester)
const X0 = 12_000;
const Z0 = 12_000;
/** The castle union (CM-a): 121 x 15 x 27; its modules 41 wide at union x 0, 40 and 80. */
const U = { x: 121, y: 15, z: 27 };
const MODULES = ['west', 'centre', 'east'];

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice CM-b is $0: the sim sidecar, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ the apitest mod (the public API only)

const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args.slice(0, 120)}: no JSON answer: ${JSON.stringify(r).slice(0, 400)}`);
  return JSON.parse(line);
};
const result = async (pending, timeoutMs = 300_000) => {
  const key = pending?.pending;
  if (!key) return pending;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api(`get ${key}`);
    if (r && r.value !== undefined && r.value !== null) return r.value;
    if (r && r.error) return { error: r.error };
    await sleep(500);
  }
  throw new Error(`no result for ${key}`);
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

// ------------------------------------------------------------------ the world

function asId(nbt) {
  const bs = /^Block\{([a-z0-9_.-]+:[a-z0-9_./-]+)\}/.exec(nbt);
  if (bs) return bs[1].replace(/^minecraft:/, '');
  return (/(?:Name|id)\s*:\s*["']?([a-z0-9_.-]+:[a-z0-9_./-]+)/i.exec(nbt)?.[1] ?? nbt).replace(/^minecraft:/, '');
}
async function groundY() {
  const h = await call('dev.box.hash', { min: [X0, -64, Z0], max: [X0, 250, Z0], cells: true }, 120_000);
  let g = -64;
  for (const l of h.cells ?? []) { const [k, ...rest] = l.split(' '); const y = Number(k.split(',')[1]); if (asId(rest.join(' ')) !== 'air' && y > g) g = y; }
  return g;
}
/** The area a placement at rotation `turns` may touch (the approach and the foundation included): the union's box grown by 12, rows gy-6..gy+20. */
const areaOf = (gy, turns = 0) => (turns % 2 === 0 ? [X0 - 12, gy - 6, Z0 - 12, X0 + U.x + 11, gy + U.y + 5, Z0 + U.z + 11]
  : [X0 - 12, gy - 6, Z0 - 12, X0 + U.z + 11, gy + U.y + 5, Z0 + U.x + 11]);
const hashOf = async (b) => (await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] }, 600_000)).sha256;
/** The cells that differ (a few named) between the world now and a cell map taken before. */
async function cellsOf(b) {
  const h = await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]], cells: true }, 600_000);
  return new Map((h.cells ?? []).map((l) => { const sp = l.indexOf(' '); return [l.slice(0, sp), l.slice(sp + 1).split(' be=')[0]]; }));
}
function diff(a, b) {
  const out = [];
  let n = 0;
  for (const [k, v] of a) if (b.get(k) !== v) { n++; if (out.length < 6) out.push(`${k} ${v} -> ${b.get(k)}`); }
  return { n, first: out };
}
/** E-flat: 0 when the area's hash is the baseline's; else the differing cells counted against the baseline map. */
async function eflat(area, h0, c0) {
  const h = await hashOf(area);
  if (h === h0) return { n: 0, first: [] };
  return diff(c0, await cellsOf(area));
}
async function freshFlat(name) {
  await L.fresh(name, FLAT);
  await L.setRules('exact');
  await L.tp(X0 + 60, 0, Z0 + 60);
  await L.settle(3000);
  const gy = await groundY();
  await L.tp(X0 + 60, gy + 40, Z0 + 60, 0, 90);
  await L.settle(3000);
  return gy;
}

// ------------------------------------------------------------------ the castle in the library (a sim design group item)

/** A design group of one item whose sim design returns the composite castle; the installed entry id and the group. */
async function installCastle(tag) {
  const req = { name: `CM-b ${tag}`, bible: 'oak', items: [{ itemKey: 'lot_keep', type: 'castle', name: 'Keep', size: [96, 64, 96], ext: { 'architect:sim': 'composite', lot: 'keep' } }] };
  const gid = await result(await api(`group cmb${tag} ${b64(req)}`), 120_000);
  if (typeof gid !== 'string') throw new Error(`group refused: ${JSON.stringify(gid)}`);
  let g = null;
  const end = Date.now() + 600_000;
  while (Date.now() < end) {
    g = await api(`groupget ${gid}`);
    if (g && ['DONE', 'FAILED', 'CANCELLED'].includes(g.status)) break;
    await sleep(2000);
  }
  return { gid, g, entry: g?.items?.[0]?.entryId ?? null };
}

const placeArgs = (entry, x, y, z, mode, actor, turns) => `${entry} ${x} ${y} ${z} ${mode} owned ${actor} ${turns}`;
const place = async (entry, x, y, z, { mode = 'INSTANT', actor = 'actor', turns = 0 } = {}) => result(await api(`place ${placeArgs(entry, x, y, z, mode, actor, turns)}`), 600_000);
const groupOf = (g) => api(`sgroup ${g}`);

async function verifyAll(sites) {
  const out = {};
  for (const s of sites) {
    const v = await call('dev.site.verify', { site: s }, 300_000);
    out[s] = { owned: v.owned, mismatches: v.mismatches };
  }
  return out;
}

// ------------------------------------------------------------------ ingame

steps.ingame = async () => {
  await ensure();
  spendZero();
  const out = {};
  const gy = await freshFlat('G6B CMB Ingame');
  const inst = await installCastle(`i${Date.now().toString(36)}`);
  const E = inst.entry;
  const items = inst.g?.items ?? [];
  check(inst.g?.status === 'DONE' && items.length === 1 && items[0].itemKey === 'lot_keep' && !!E, `the sim design group's one item (lot_keep) is done with one entry: ${E}`, { status: inst.g?.status, items: items.map((i) => [i.itemKey, i.entryId]) });
  if (!E) return out;
  await cmd('/reload');
  await L.settle(2000);
  const e = await api(`entry ${E}`);
  const all = await api('entries');
  const mods = MODULES.map((m) => `${E}__${m}`);
  const bound = [];
  for (const id of all) {
    const j = path.join(LIBRARY, id, `${id}.blueprint.json`);
    if (fs.existsSync(j) && JSON.parse(fs.readFileSync(j, 'utf8')).groupItem === 'lot_keep') bound.push(id);
  }
  check(e?.groupItem === 'lot_keep' && e?.size === `${U.x}x${U.y}x${U.z}` && bound.length === 1 && bound[0] === E, `itemKey == lotId: the composite ${E} (${e?.size}) is the one entry bound to item lot_keep`, { groupItem: e?.groupItem, bound });
  const listed = mods.filter((m) => all.includes(m));
  const readable = [];
  for (const m of mods) if ((await api(`entry ${m}`))?.id === m) readable.push(m);
  check(all.includes(E) && listed.length === 0 && readable.length === 3, `Library.list shows ${E} and hides its 3 module entries (each still readable by id)`, { listed, readable });
  const ci = await api(`compinfo ${E}`);
  check(ci.feature === true && JSON.stringify(ci.info?.modules) === JSON.stringify(mods) && ci.info?.joints?.length === 2 && ci.info?.union?.maxX === U.x - 1,
    'CompositeInfo.of(entry): the modules in support order, 2 joints, the union; the feature "composites" is advertised', ci);
  out.entry = { id: E, size: e?.size, info: ci.info };

  const area = areaOf(gy, 0);
  const c0 = await cellsOf(area);
  const h0 = await hashOf(area);
  const area1 = areaOf(gy, 1);
  const c1 = await cellsOf(area1);
  const h1 = await hashOf(area1);
  out.area = { rot0: area, cells0: c0.size, rot1: area1, cells1: c1.size };

  // whole first (rotation 0): Sites.place -> one group; Sites.remove(handle)
  const chk = await api(`check ${placeArgs(E, X0, gy, Z0, 'INSTANT', 'actor', 0)}`);
  check((chk.refusals ?? []).length === 0, 'Sites.check of the composite: no refusal (every module checked)', chk);
  const p1 = await place(E, X0, gy, Z0);
  const g1 = p1.siteId;
  const grp1 = g1 ? await groupOf(g1) : null;
  check(p1.placed && !!grp1 && JSON.stringify((grp1.stages ?? []).map((s) => s.name)) === JSON.stringify(MODULES) && (grp1.sites ?? []).length === 3,
    `whole first: placed as ONE site group ${g1}: stages ${(grp1?.stages ?? []).map((s) => `${s.name}:${s.state}`).join(' ')}, ${grp1?.sites?.length} sites`, { p1, grp1 });
  if (grp1) {
    const v = await verifyAll(grp1.sites);
    const seam = await api(`stack ${X0 + 40} ${gy + 3} ${Z0 + 2}`);
    check(Object.values(v).every((x) => x.mismatches === 0) && seam.length === 2, `every module verifies (0 mismatches) and the west/centre seam cell's stack is ${seam.length} (LAYER)`, { v, seam });
    out.wholeFirst = { group: g1, verify: v, seam };
  }
  const r1 = g1 ? await result(await api(`remove ${g1} ${OWNER} noforce`), 600_000) : null;
  await L.settle(1500);
  const e1 = await eflat(area, h0, c0);
  const gone1 = g1 ? (await groupOf(g1))?.state : null;
  check(!!r1?.removed && e1.n === 0, `whole first: Sites.remove(${g1}) removes the whole; E-flat 0 (group ${gone1})`, { r1, first: e1.first });
  out.wholeFirst = { ...out.wholeFirst, eflat: e1.n, groupState: gone1 };

  // module first (rotation 1): undoStage of the last module, then Sites.remove of the rest
  const p2 = await place(E, X0, gy, Z0, { turns: 1 });
  const g2 = p2.siteId;
  const grp2 = g2 ? await groupOf(g2) : null;
  check(p2.placed && (grp2?.sites ?? []).length === 3, `module first: placed at rotation 1 as group ${g2}`, { p2 });
  const u = g2 ? await result(await api(`sundo ${g2} east`), 600_000) : null;
  const grp2b = g2 ? await groupOf(g2) : null;
  const left = (grp2b?.stages ?? []).filter((s) => s.name !== 'east').flatMap((s) => s.sites ?? []);
  const vLeft = await verifyAll(left.length ? left : (grp2b?.sites ?? []).slice(0, 2));
  check(!!u?.removed && (grp2b?.stages ?? []).find((s) => s.name === 'east')?.state === 'UNDONE' && Object.values(vLeft).every((x) => x.mismatches === 0),
    'module first: undoStage(east) removes the east module; its stage is UNDONE and the two modules left still verify (the seam handed back)', { u, stages: grp2b?.stages, vLeft });
  const r2 = g2 ? await result(await api(`remove ${g2} ${OWNER} noforce`), 600_000) : null;
  await L.settle(1500);
  const e2 = await eflat(area1, h1, c1);
  check(!!r2?.removed && e2.n === 0, `module first: Sites.remove(${g2}) removes the rest; E-flat 0`, { r2, first: e2.first });
  out.moduleFirst = { group: g2, eflat: e2.n };

  // a module refused at fit: a chest in the east module's box; nothing placed
  const groupsBefore = (await api(`sgroups ${OWNER}`)).length;
  const chest = [X0 + 100, gy + 2, Z0 + 12];
  await cmd(`/setblock ${chest[0]} ${chest[1]} ${chest[2]} minecraft:chest`);
  const h0chest = await hashOf(area);
  const p3 = await place(E, X0, gy, Z0);
  const groupsAfter = (await api(`sgroups ${OWNER}`)).length;
  const names = (p3.refusals ?? []).map((x) => `${x.reason}: ${x.message}`);
  check(!p3.placed && names.length > 0 && names.every((n) => /module east \(/.test(n)) && groupsAfter === groupsBefore && (await hashOf(area)) === h0chest,
    'a module refused at fit names it (module east), and nothing is placed (no group, the area unchanged)', { names, groupsBefore, groupsAfter });
  out.fitRefused = names;
  await cmd(`/setblock ${chest[0]} ${chest[1]} ${chest[2]} minecraft:air`);

  // JOINT_MISMATCH at place time: the east module's arch made 2 wide on disk (a broken install), refused naming the module and the port
  const ej = path.join(LIBRARY, `${E}__east`, `${E}__east.blueprint.json`);
  const saved = fs.readFileSync(ej, 'utf8');
  const bad = JSON.parse(saved);
  for (const p of bad.ports ?? []) if (p.name === 'arch_w') p.width = 2;
  fs.writeFileSync(ej, `${JSON.stringify(bad, null, 2)}\n`);
  await cmd('/reload');
  await L.settle(2000);
  const p4 = await place(E, X0, gy, Z0);
  const j4 = (p4.refusals ?? []).find((x) => x.reason === 'JOINT_MISMATCH');
  check(!p4.placed && !!j4 && /module east port arch_w/.test(j4.message) && (await hashOf(area)) === h0, 'JOINT_MISMATCH at place time names the module and the port; nothing placed', { refusals: p4.refusals });
  out.jointMismatch = j4?.message ?? null;
  fs.writeFileSync(ej, saved);
  await cmd('/reload');
  await L.settle(2000);

  // survival (S-7c-6): composites stay out of survival in 7c
  await call('dev.survival.set', { on: true });
  const p5 = await place(E, X0, gy, Z0, { mode: 'AUTO' });
  const p6 = await place(E, X0, gy, Z0, { mode: 'INSTANT', actor: 'noactor' });
  await call('dev.survival.set', { on: false });
  const s5 = (p5.refusals ?? []).map((x) => `${x.reason}: ${x.message}`);
  const s6 = (p6.refusals ?? []).map((x) => `${x.reason}: ${x.message}`);
  check(!p5.placed && s5.some((n) => n.startsWith('NOT_ALLOWED') && n.includes(`composite ${E}`)) && !p6.placed && s6.some((n) => n.startsWith('NOT_ALLOWED') && n.includes(`composite ${E}`)) && (await hashOf(area)) === h0,
    'survival: a construction request and an actorless INSTANT are refused NOT_ALLOWED naming the composite; nothing placed', { s5, s6 });
  out.survival = { construction: s5, actorless: s6 };
  await L.leaveWorld();
  return out;
};

// ------------------------------------------------------------------ crash (strict)

/** The composite's module sites standing now (dev.sites.state), by blueprint. */
async function moduleSites(E) {
  const st = await call('dev.sites.state', {}, 60_000);
  return (st.sites ?? []).filter((x) => String(x.blueprint).startsWith(`${E}__`));
}

steps.crash = async () => {
  await ensure();
  spendZero();
  const out = {};
  const world = 'G6B CMB Crash CM1_save';
  const gy = await freshFlat(world);
  const inst = await installCastle(`c${Date.now().toString(36)}`);
  const E = inst.entry;
  check(!!E, `the castle installed: ${E}`);
  if (!E) return out;
  await cmd('/reload');
  await L.settle(2000);
  const area = areaOf(gy);
  const c0 = await cellsOf(area);
  const h0 = await hashOf(area);
  // the reference: a clean placement at the same origin, its hash, then its exact removal
  const p0 = await place(E, X0, gy, Z0);
  const hC = await hashOf(area);
  const r0 = p0.siteId ? await result(await api(`remove ${p0.siteId} ${OWNER} noforce`), 600_000) : null;
  await L.settle(1500);
  const e0 = await eflat(area, h0, c0);
  check(p0.placed && !!r0?.removed && e0.n === 0, `the clean placement (group ${p0.siteId}) is recorded and removed exactly (E-flat 0)`, { p0, first: e0.first });
  // the crash: an explicit save point, then the kill between the first and the second module
  const logFile = path.join(GAME_DIR, 'logs', 'latest.log');
  await cmd('/save-all flush');
  await L.settle(1000);
  await call('dev.journal.killAt', { point: 'CM1+save' }, 10_000);
  api(`place ${placeArgs(E, X0, gy, Z0, 'INSTANT', 'actor', 0)}`).catch(() => null);
  let down = false;
  for (let i = 0; i < 120 && !down; i++) {
    await sleep(2000);
    const st = await call('dev.state', {}, 10_000).catch(() => null);
    down = !!st && st.inWorld === false;
  }
  check(down, 'CM1+save: the kill point halted the server between two modules');
  const killLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  out.killLine = (killLog.match(/.*kill point CM1.*$/m) ?? [null])[0];
  if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await L.leaveWorld(); return out; }
  await L.openWorld(world);
  await L.tp(X0 + 60, gy + 40, Z0 + 60, 0, 90);
  await L.settle(3000);
  // the batch resumes after the load: wait for every module placed
  let sites = [];
  const end = Date.now() + 600_000;
  while (Date.now() < end) {
    sites = await moduleSites(E);
    if (sites.length === 3 && sites.every((s) => !s.placing)) break;
    await sleep(2000);
  }
  const groups = [...new Set(sites.map((s) => s.group ?? s.member?.group).filter(Boolean))];
  let g = groups[0] ?? null;
  if (!g) {
    const all = await api(`sgroups ${OWNER}`);
    g = all.find((x) => x.ext?.['architect_mc:compositeSite']?.entry === E && x.state === 'ACTIVE')?.group ?? null;
  }
  const grp = g ? await groupOf(g) : null;
  const v = await verifyAll(grp?.sites ?? sites.map((s) => s.id));
  const h1 = await hashOf(area);
  check(sites.length === 3 && !!grp && (grp.stages ?? []).every((s) => s.state === 'PLACED') && Object.values(v).every((x) => x.mismatches === 0) && h1 === hC,
    `after the restart the composite's batch resumed: 3 modules stand in group ${g} (${(grp?.stages ?? []).map((s) => `${s.name}:${s.state}`).join(' ')}), each verifies, and the area equals the clean placement's hash`, { sites: sites.map((s) => [s.id, s.blueprint]), v, same: h1 === hC });
  out.resumed = { group: g, verify: v, sameAsClean: h1 === hC };
  const r = g ? await result(await api(`remove ${g} ${OWNER} noforce`), 600_000) : null;
  await L.settle(1500);
  const e = await eflat(area, h0, c0);
  check(!!r?.removed && e.n === 0, `Sites.remove(${g}) of the recovered composite is exact (E-flat 0 over ${c0.size} cells)`, { r, first: e.first });
  out.eflat = e.n;
  const logNow = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const jr = logNow.split('\n').filter((l) => /does not match its blueprint/.test(l));
  out.jrSymptom = jr.slice(0, 5);
  log(jr.length ? `NOTE: "does not match its blueprint" after the restart (slice JR's symptom): ${jr.length} line(s)` : 'no "does not match its blueprint" line after the restart');
  await L.leaveWorld();
  return out;
};

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => /^(ingame|crash)\.json$/.test(f));
  const lines = ['# Gate slice CM-b', '', `head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
  for (const f of files.sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    lines.push(`## ${j.step} (${Math.round(j.seconds)} s, head ${String(j.head).slice(0, 10)})`, '');
    for (const [m, r] of Object.entries(j.results ?? {})) lines.push(`- ${r?.ok ? 'ok  ' : 'FAIL'} ${m}`);
    lines.push('');
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
  return { files };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7ccmb.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
