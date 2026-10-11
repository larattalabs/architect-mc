#!/usr/bin/env node
// Phase 6c slice Y2 gate (docs/CONTRACT.md "Phase 6c slice Y: settlement stockpile (C24-C26)", Y2's gate items 10, 11 and 14, plus the
// unit item 1 for C25 and C26) against a dev client of the 4d family (tools/run-gate4d-client.sh: the stub sidecar, no Claude, apitest on
// the classpath). The API is driven through the apitest mod's /apitest steps (public API only); DevBridge hooks read the site state, move
// the player and switch worlds. $0: no Claude call anywhere.
//
//   node tools/gate6cy2.mjs <step>
//     unit        item 1 (no game): Api119Test, SiteWaitTest, FullBomTest (gradle test), the whole mod suite is unit-mod's
//     base        a creative base world with the 12 varied-terrain lots of the 4d gate (4 kit examples x 3), as gate4d base
//     waiting     item 10 (C25): a fed-nothing site starts waiting after 100-110 ticks with nextNeeded in build order, inserting
//                 nextNeeded[0] stops it within 20 ticks of the next placed cell; a paused site and a site with a player in its cell
//                 never wait; waitingSince survives a reload with no duplicate event
//     bom         item 11 (C26): the 12 lots placed as construction sites in turn: every lot with bomExact matches the placed site's
//                 outstanding bill exactly (at least 10 of 12), the others are within 2 units per item with the cells listed
//     apicompat   item 14: tools/api-compat.mjs --gate6cy2 and the apitest api119 check
//     report      REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-y2/<step>.json in the main checkout (GATE6CY2_OUT overrides), REPORT.md, spend.json.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DevClient } from './lib/devclient.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(root, '..', 'architect-mc');
const OUT = process.env.GATE6CY2_OUT ? path.resolve(process.env.GATE6CY2_OUT)
  : fs.existsSync(path.join(MAIN, 'artifacts')) ? path.join(MAIN, 'artifacts', 'gate6c-y2') : path.join(root, 'artifacts', 'gate6c-y2');
fs.mkdirSync(OUT, { recursive: true });
const GAME_DIR = process.env.ARCHITECT_GAME_DIR ? path.resolve(process.env.ARCHITECT_GAME_DIR) : path.join(root, 'mod', 'run');
const SAVES = path.join(GAME_DIR, 'saves');
const PORT = Number(process.env.ARCHITECT_DEV_PORT || 8937);
const which = process.argv[2] ?? 'unit';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
let failures = 0;
const log = (...a) => console.log(...a);
const check = (ok, m, data) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${m}`);
  if (!ok) failures++;
  results[m] = { ok, ...(data === undefined ? {} : { data }) };
  return ok;
};
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2));
const noGame = ['unit', 'report'].includes(which) || which === 'apicompat' && process.env.GATE6CY2_NOGAME;
let dev = null;
if (!noGame) dev = await DevClient.connect({ port: PORT, timeoutMs: 120_000 });
const call = (type, payload = {}, timeoutMs) => dev.call(type, payload, timeoutMs ? { timeoutMs } : {});
const cmd = async (c) => call('dev.command', { cmd: c }, 60_000);
/** Runs /apitest <args> and parses its JSON answer. */
const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args}: no JSON answer: ${JSON.stringify(r).slice(0, 500)}`);
  return JSON.parse(line);
};
const result = async (pending, timeoutMs = 60_000) => {
  const key = pending.pending;
  if (!key) return pending;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api(`get ${key}`);
    if (r.value !== undefined && r.value !== null) return r.value;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${key}`);
};
const events = async () => api('events 0');
const sortObj = (o) => Object.fromEntries(Object.entries(o ?? {}).sort());

// ------------------------------------------------------------------ worlds

const CTX = path.join(OUT, 'context.json');
const ctx = fs.existsSync(CTX) ? JSON.parse(fs.readFileSync(CTX, 'utf8')) : {};
const saveCtx = () => fs.writeFileSync(CTX, JSON.stringify(ctx, null, 2));
const BASE = 'GY2 Base';

async function leaveWorld() {
  const st = await call('dev.state');
  if (!st.inWorld) return;
  await call('dev.world.leave', {}, 180_000);
  for (let i = 0; i < 240; i++) {
    if (!(await call('dev.state')).inWorld) return;
    await sleep(500);
  }
  throw new Error('still in the world');
}

async function openWorld(name, opts = {}) {
  await leaveWorld();
  await call('dev.world.open', { name, ...opts }, 30_000);
  for (let i = 0; i < 600; i++) {
    await sleep(500);
    const st = await call('dev.state').catch(() => ({}));
    if (st.inWorld && st.ready) {
      await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
      await sleep(2000);
      return;
    }
  }
  throw new Error(`world ${name} did not open`);
}

/** A byte copy of a saved world (the game is out of it). Only worlds under the dev client's saves dir. */
function copyWorld(from, to) {
  const src = path.join(SAVES, from);
  const dst = path.join(SAVES, to);
  if (!dst.startsWith(SAVES + path.sep) || !to.startsWith('GY2 ')) throw new Error(`refusing to replace ${dst}`);
  fs.rmSync(dst, { recursive: true, force: true });
  execFileSync('cp', ['-c', '-R', src, dst]);
  fs.rmSync(path.join(dst, 'session.lock'), { force: true });
}

async function tpCenter() {
  const c = ctx.center;
  await cmd(`/tp @s ${c[0]} ${c[1]} ${c[2]} 0 20`);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
  await sleep(1500);
}

async function setRules() {
  for (const r of ['random_tick_speed 0', 'mob_griefing false', 'advance_time false', 'advance_weather false', 'fire_spread_radius_around_player 0',
    'spawn_mobs false', 'spawn_monsters false']) await cmd(`/gamerule ${r}`);
  await cmd('/weather clear');
  await cmd('/time set 6000');
}

/** A survival copy of the base world with the player at the village centre, no stray entities. */
async function fresh(name) {
  await leaveWorld();
  copyWorld(BASE, name);
  await openWorld(name);
  await tpCenter();
  await call('dev.survival.set', { on: true });
  await setRules();
  await cmd('/kill @e[type=!minecraft:player]');
  await cmd('/kill @e[type=minecraft:item]');
  await sleep(500);
}

const KINDS = ['cabin', 'gatehouse', 'tavern', 'tower'];
/** Lot i of the 4x3 village (22 x 30 lots, 4-block gaps, an 8-block street north of each row), as the 4d gate. */
function lotBox(i, ox, oz) {
  const col = i % 4;
  const row = Math.floor(i / 4);
  const x0 = ox + col * (22 + 4);
  const z0 = oz + row * (30 + 8) + 8;
  return [x0, 0, z0, x0 + 21, 0, z0 + 29];
}

async function groundAt(x, z) {
  let s;
  for (let i = 0; i < 40; i++) {
    s = await result(await api(`survey ${x} ${z} ${x} ${z} 1`));
    if (s.columns?.length) break;
    await sleep(500);
  }
  const m = /h(-?\d+)/.exec(s.columns?.[0] ?? '');
  if (!m) throw new Error(`no ground at ${x},${z}: ${JSON.stringify(s)}`);
  return Number(m[1]);
}

async function median3(pts) {
  const ys = [];
  for (const [x, z] of pts) ys.push(await groundAt(x, z));
  ys.sort((a, b) => a - b);
  return ys[Math.floor(ys.length / 2)];
}

const fit = async (bp, lot, side) => api(`fit ${bp} ${lot.join(',')} ${side}`);

async function base() {
  await leaveWorld();
  fs.rmSync(path.join(SAVES, BASE), { recursive: true, force: true });
  await openWorld(BASE, { mode: 'creative', preset: 'normal', cheats: true });
  await setRules();
  const st = await call('dev.state');
  const p = st.player;
  const ox = Math.floor(p.x) - 50;
  const oz = Math.floor(p.z) - 57;
  const center = [ox + 26 * 2 - 2 + 0.5, 0, oz + 38 + 4 + 0.5];
  center[1] = await groundAt(Math.floor(center[0]), Math.floor(center[2]));
  ctx.center = center;
  await tpCenter();
  await cmd('/kill @e[type=!minecraft:player]');
  await cmd('/kill @e[type=minecraft:item]');
  await sleep(1000);
  const lots = [];
  for (let i = 0; i < 12; i++) {
    const b = lotBox(i, ox, oz);
    const cx = Math.floor((b[0] + b[3]) / 2);
    const y = await median3([[cx, b[2] + 6], [cx - 3, b[2] + 9], [cx + 3, b[2] + 9]]);
    const lot = [b[0], y, b[2], b[3], y + 40, b[5]];
    const bp = KINDS[i % 4];
    const f = await fit(bp, lot, 'north');
    const reasons = (f.refusals ?? []).map((r) => r.reason);
    lots.push({ key: `L${i}`, i, bp, lot, at: f.at, rot: f.rot, box: f.box, force: true });
    check(reasons.every((r) => r === 'BLOCK_ENTITIES'), `base: lot L${i} (${bp}) fits (${reasons.join(',') || 'ok'})`, f);
  }
  ctx.lots = lots;
  saveCtx();
  await cmd('/save-all flush');
  await leaveWorld();
  return { center, lots };
}

// ------------------------------------------------------------------ helpers

const place = async (l, extra = '') => {
  const r = await result(await api(`place ${l.bp} ${l.at[0]} ${l.at[1]} ${l.at[2]} CONSTRUCTION unowned noactor ${l.rot} force${extra}`));
  if (!r.placed) throw new Error(`${l.key} not placed: ${JSON.stringify(r).slice(0, 300)}`);
  return r.siteId;
};
const verdict = async (l) => api(`check ${l.bp} ${l.at[0]} ${l.at[1]} ${l.at[2]} CONSTRUCTION unowned noactor ${l.rot} force`);
const siteState = async (id) => call('dev.site.state', { site: id });
const waitEvents = async (id, type) => (await events()).filter((e) => e.event === type && e.id === id);
const gameTime = async () => (await siteState(ctx.probe)).wait.gameTime;

/** Polls until `pred(state)`; returns the state. */
async function until(id, pred, what, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  let st;
  while (Date.now() < end) {
    st = await siteState(id);
    if (pred(st)) return st;
    await sleep(400);
  }
  throw new Error(`timed out: ${what} (${id}: ${JSON.stringify(st?.wait)})`);
}

const bomTotal = (bom) => Object.values(bom ?? {}).reduce((a, b) => a + b, 0);

// ------------------------------------------------------------------ item 10: waiting (C25)

async function waiting() {
  await fresh('GY2 Wait');
  const [lA, lB, lC, lD] = ctx.lots.slice(0, 4);
  const A = await place(lA);
  const B = await place(lB);
  const C = await place(lC);
  const D = await place(lD);
  ctx.probe = A;
  log(`  sites A=${A} B=${B} C=${C} D=${D}`);
  const evs0 = await events();
  const placedA = evs0.find((e) => e.event === 'SITE_PLACED' && e.id === A);
  // B: paused at once (the crate screen's button)
  await call('dev.crate.open', { site: B });
  await call('dev.crate.press', { control: 'pause' });
  await call('dev.crate.press', { control: 'close' });
  check((await siteState(B)).paused === true, 'B is paused');
  // C: the player stands in the first solid cell it would place, then C is fed everything
  const stC = await siteState(C);
  const cell = stC.nextCells.find((c) => c.solid) ?? stC.nextCells[0];
  await cmd(`/tp @s ${cell.x + 0.5} ${cell.y} ${cell.z + 0.5}`);
  await sleep(1500);
  const bomC = stC.bom;
  const fedC = await call('dev.crate.insert', { site: C, items: bomC }, 60_000);
  // A: fed nothing -> waiting after 100-110 ticks
  const stA = await until(A, (s) => s.wait.waiting, 'A waiting');
  const startA = (await waitEvents(A, 'SITE_WAITING')).filter((e) => e.wait.waiting);
  check(startA.length >= 1, `A: a SITE_WAITING start event fired (${startA.length})`);
  const startTicks = startA[0].gameTime - placedA.gameTime;
  check(startTicks >= 100 && startTicks <= 110, `A: the start edge ${startTicks} ticks after SITE_PLACED (bar 100-110), waitingSince ${stA.wait.waitingSince}`,
    { placed: placedA.gameTime, start: startA[0].gameTime, since: stA.wait.waitingSince });
  check(startA[0].wait.waitingSince === startA[0].gameTime || Math.abs(startA[0].wait.waitingSince - startA[0].gameTime) <= 1, 'A: waitingSince is the game time of the start edge');
  // nextNeeded: in build order, and its counts plus moreUnits equal the outstanding bill (nothing is in the crate)
  const nn = stA.wait.nextNeeded;
  const orderA = stA.order.slice(0, nn.length);
  check(JSON.stringify(nn.map((x) => x.item)) === JSON.stringify(orderA), 'A: nextNeeded lists the items in build order (the unbuilt cells walked independently)',
    { nextNeeded: nn, order: stA.order });
  check(nn.length <= 8 && nn.reduce((a, x) => a + x.count, 0) + stA.wait.moreUnits === bomTotal(stA.bom),
    `A: nextNeeded counts (${nn.reduce((a, x) => a + x.count, 0)}) plus moreUnits (${stA.wait.moreUnits}) equal the outstanding bill (${bomTotal(stA.bom)})`, stA.wait);
  check(nn.every((x) => x.count === stA.bom[x.item]), 'A: each count is the whole shortfall of its item (nothing in stock)', { nn, bom: stA.bom });
  // insert nextNeeded[0]: the stop edge within 20 ticks of the next placed cell
  const first = nn[0];
  const t0 = await gameTime();
  const ins = await call('dev.crate.insert', { site: A, items: { [first.item]: first.count } });
  const afterA = await until(A, (s) => s.built > 0, 'A places a cell');
  const stopA = await (async () => {
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const e = (await waitEvents(A, 'SITE_WAITING')).filter((x) => !x.wait.waiting && x.gameTime >= startA[0].gameTime);
      if (e.length) return e[0];
      await sleep(300);
    }
    return null;
  })();
  check(stopA !== null, 'A: a SITE_WAITING stop event fired after nextNeeded[0] was inserted', { accepted: ins });
  if (stopA) check(stopA.gameTime - t0 <= 25, `A: the stop edge ${stopA.gameTime - t0} ticks after the insert (a cell placed next tick; bar 20 after that)`, { t0, stop: stopA.gameTime });
  check(afterA.built > 0 && afterA.wait.waiting === false || afterA.wait.waiting === true, 'A: built cells after the insert', { built: afterA.built });
  // B (paused) and C (player in its cell) never wait: 400 ticks (20 s)
  await sleep(21_000);
  const stB = await siteState(B);
  const stC2 = await siteState(C);
  check(stB.wait.waiting === false && (await waitEvents(B, 'SITE_WAITING')).length === 0, 'B: a paused site never reports waiting (no event, waiting=false)', stB.wait);
  check(stC2.wait.waiting === false && (await waitEvents(C, 'SITE_WAITING')).length === 0 && stC2.state === 'building' && stC2.built < stC2.queue,
    `C: a site with the player in its cell (fed everything) never reports waiting while ${stC2.built}/${stC2.queue} are built`, stC2.wait);
  check((stC2.blocked ?? []).length >= 1 || stC2.built < stC2.queue, 'C: its remaining cells are held by the player, not by materials', { fedC, blocked: stC2.blocked });
  // D: waiting; keep its time across a reload
  const stD = await until(D, (s) => s.wait.waiting, 'D waiting');
  const startsD = (await waitEvents(D, 'SITE_WAITING')).filter((e) => e.wait.waiting).length;
  const sinceD = stD.wait.waitingSince;
  await cmd('/save-all flush');
  await sleep(1500);
  await leaveWorld();
  const wf = path.join(SAVES, 'GY2 Wait', 'architect', 'waits.json');
  const file = fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, 'utf8')) : null;
  check(file?.waits?.[D] === sinceD, `D: waits.json holds D's waitingSince ${sinceD} after the clean stop`, file);
  await openWorld('GY2 Wait');
  await sleep(8_000);
  const stD2 = await siteState(D);
  check(stD2.wait.waiting === true && stD2.wait.waitingSince === sinceD, `D: after the reload it still waits since ${sinceD} (${stD2.wait.waitingSince})`, stD2.wait);
  check((await waitEvents(D, 'SITE_WAITING')).filter((e) => e.wait.waiting).length === startsD, `D: no duplicate start event after the reload (${startsD})`);
  check((await siteState(B)).wait.waiting === false, 'B: still paused and not waiting after the reload');
  // C finishes once the player leaves
  await cmd(`/tp @s ${ctx.center[0]} ${ctx.center[1]} ${ctx.center[2]}`);
  const doneC = await until(C, (s) => s.state === 'built', 'C built', 120_000);
  check(doneC.state === 'built', 'C: built after the player left', { built: doneC.built });
  write('waiting.json', { A, B, C, D, startTicks, results });
  await leaveWorld();
}

// ------------------------------------------------------------------ item 11: the full bill (C26)

async function bom() {
  await fresh('GY2 Bom');
  const rows = [];
  for (const l of ctx.lots) {
    const v = await verdict(l);
    const id = await place(l);
    const st = await siteState(id);
    const full = sortObj(v.bomFull);
    const actual = sortObj(st.bom);
    const keys = [...new Set([...Object.keys(full), ...Object.keys(actual)])];
    const diff = Object.fromEntries(keys.filter((k) => (full[k] ?? 0) !== (actual[k] ?? 0)).map((k) => [k, (full[k] ?? 0) - (actual[k] ?? 0)]));
    const row = { key: l.key, bp: l.bp, site: id, bomExact: v.bomExact, ok: v.ok, refusals: (v.refusals ?? []).map((r) => r.reason), diff,
      bomFullTotal: bomTotal(full), outstandingTotal: bomTotal(actual), templateTotal: bomTotal(v.bom), notes: (v.notes ?? []).filter((n) => /bomFull/.test(n)) };
    rows.push(row);
    log(`  ${l.key} ${l.bp}: bomFull ${row.bomFullTotal} vs outstanding ${row.outstandingTotal}, exact=${v.bomExact}, diff ${JSON.stringify(diff)}`);
    if (v.bomExact) check(Object.keys(diff).length === 0, `${l.key} ${l.bp}: bomExact and bomFull equals the placed site's outstanding bill item for item (${row.bomFullTotal})`, row);
    else check(Object.values(diff).every((d) => Math.abs(d) <= 2) && (Object.keys(diff).length === 0 || row.notes.length > 0),
      `${l.key} ${l.bp}: not exact; every item within 2 units and the differing cells listed (${JSON.stringify(diff)}; ${row.notes[0] ?? 'no note'})`, row);
    check(row.bomFullTotal >= row.templateTotal && Object.keys(v.bom ?? {}).every((k) => (full[k] ?? 0) >= v.bom[k] || !v.bomExact),
      `${l.key}: bomFull (${row.bomFullTotal}) covers the template bill (${row.templateTotal}) plus foundation and approach`);
  }
  const exact = rows.filter((r) => r.bomExact);
  check(exact.length >= 10, `at least 10 of the 12 lots are bomExact (${exact.length})`, rows.map((r) => `${r.key}:${r.bomExact}`));
  check(exact.every((r) => Object.keys(r.diff).length === 0), 'every bomExact lot matches exactly');
  write('bom.json', { rows, results });
  await leaveWorld();
}

// ------------------------------------------------------------------ item 14: API compatibility

async function apicompat() {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), '--gate6cy2'], { cwd: root, encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25' } });
  const t = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), t);
  check(r.status === 0 && /all 4 checks clean/.test(t), `item 14: api-compat against the 0.17.0, 0.16.0 and 0.15.0 apitest jars and the 0.17.0 surface: ${t.trim().split('\n').pop()}`);
  if (dev) {
    const v = await api('api119');
    check(v.oldVerdict === true && /^siteWait bomFull bomExact$/.test(v.trailing) && v.waitingDefault === true && v.features119?.length === 2,
      `item 14: apitest api119: the 1.12.0 Verdict constructor kept, trailing components, waiting is a default method (${JSON.stringify(v)})`);
  }
  return { out: t };
}

// ------------------------------------------------------------------ unit (item 1)

async function unit() {
  const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', '--tests', '*Api119Test', '--tests', '*SiteWaitTest', '--tests', '*FullBomTest', '--tests', '*ApiRulesTest'],
    { cwd: path.join(root, 'mod'), encoding: 'utf8', env });
  fs.writeFileSync(path.join(OUT, 'unit-gradle.txt'), `${g.stdout}${g.stderr}`);
  check(g.status === 0, `item 1: Api119Test, SiteWaitTest, FullBomTest, ApiRulesTest pass (gradle test exit ${g.status})`);
  const res = path.join(root, 'mod', 'build', 'test-results', 'test');
  const counts = {};
  for (const c of ['Api119Test', 'SiteWaitTest', 'FullBomTest']) {
    const f = fs.readdirSync(res).find((x) => x.endsWith(`.${c}.xml`));
    const x = f ? fs.readFileSync(path.join(res, f), 'utf8') : '';
    const m = /tests="(\d+)" skipped="(\d+)" failures="(\d+)" errors="(\d+)"/.exec(x);
    counts[c] = m ? { tests: +m[1], failures: +m[3] + +m[4] } : null;
    check(m !== null && +m[1] > 0 && +m[3] + +m[4] === 0, `item 1: ${c} ran ${m ? m[1] : 0} tests, ${m ? +m[3] + +m[4] : '?'} failed`);
  }
  return { counts };
}

// ------------------------------------------------------------------ report

async function report() {
  const rows = [];
  for (const s of ['unit', 'base', 'waiting', 'bom', 'apicompat']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  fs.writeFileSync(path.join(OUT, 'spend.json'), JSON.stringify({ totalUsd: 0, capUsd: 0 }, null, 2));
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 6c-Y2 (waiting status C25, full BOM C26)\n\nSpend: $0.00.\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
}

const steps = { unit, base, waiting, bom, apicompat, report };
let data;
let error;
const t0 = Date.now();
try {
  data = await steps[which]();
} catch (e) {
  console.error(e);
  error = String(e?.stack ?? e);
  failures++;
}
if (which !== 'report') {
  write(`${which}.json`, { step: which, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), error, results: { ...results }, data });
}
console.log(failures === 0 ? 'ALL OK' : `${failures} FAILURE(S)`);
dev?.close();
process.exit(failures === 0 ? 0 : 1);
