#!/usr/bin/env node
// Phase 3 gate dry run (docs/CONTRACT.md "Phase 3 gate"), step by step against a running dev client (tools/run-p3-client.sh,
// DevBridge on ARCHITECT_DEV_PORT). Every step writes its evidence to artifacts/gate3-dryrun/<step>.json and prints a summary.
// No Claude: the bundled cabin is placed. Steps (run in this order; relaunch the client where noted):
//
//   node tools/gate3.mjs survival-pre        fresh survival world: toggle on by default, gamerules, terrain cells before
//   node tools/gate3.mjs survival-place      place the cabin construction site (UI path), ghost + BOM recorded
//   (quit + relaunch the same world)
//   node tools/gate3.mjs survival-relog      the ghost survived the relog
//   node tools/gate3.mjs survival-feed       a hopper chain from chests holding exactly the BOM (part as logs); runs until built
//   node tools/gate3.mjs survival-mine       mine 3 placed blocks (the player keeps the items)
//   node tools/gate3.mjs survival-decon      deconstruct: refund = BOM - 3 mined; terrain back exactly (hopper chain cells aside)
//   (quit; launch a creative world with the same seed)
//   node tools/gate3.mjs creative            toggle off by default; instant placement at the same spot = the finished site, cell
//                                            for cell (BE NBT included); place / stand / remove restores box + 7 exactly
//   (quit; launch a hardcore world, ARCHITECT_DEV_HARDCORE=1)
//   node tools/gate3.mjs hardcore            toggle on, can't be changed without cheats; a site places, takes items, deconstructs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevClient } from './lib/devclient.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'artifacts', 'gate3-dryrun');
fs.mkdirSync(OUT, { recursive: true });

// the spot (same seed 2026 in every gate world): the cabin's rotated box minimum, no rotation
const ORIGIN = [0, 116, 12];
// the snapshot box (template + foundation + approach) grown by 7, crate and hopper chain included
const REGION = { min: [-7, 108, 5], max: [17, 134, 36] };
const SITE = process.env.GATE3_SITE ?? 's1';

const step = process.argv[2];
const dev = await DevClient.connect({ timeoutMs: 60_000 });
const call = (type, payload = {}, timeoutMs) => dev.call(type, payload, timeoutMs ? { timeoutMs } : {});
const save = (name, obj) => fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(obj, null, 1) + '\n');
const load = (name) => JSON.parse(fs.readFileSync(path.join(OUT, `${name}.json`), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmd = async (c, asPlayer = false) => {
  const r = await call('dev.command', { cmd: c, asPlayer });
  return { cmd: c, success: r.success, messages: r.messages };
};
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exitCode = 1;
};
const check = (ok, m) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${m}`);
  if (!ok) process.exitCode = 1;
  return ok;
};

async function cells(min, max) {
  const r = await call('dev.box.hash', { min, max, cells: true }, 120_000);
  const map = {};
  for (const line of r.cells) {
    const sp = line.indexOf(' ');
    map[line.slice(0, sp)] = line.slice(sp + 1);
  }
  return { sha256: r.sha256, air: r.air, blockEntities: r.blockEntities, cells: map };
}

function diff(a, b, ignore = new Set()) {
  const out = [];
  for (const k of Object.keys(a)) if (!ignore.has(k) && a[k] !== b[k]) out.push({ at: k, before: a[k], after: b[k] });
  return out;
}

async function siteState() {
  return call('dev.site.state', { site: SITE });
}

async function place() {
  await call('dev.build.start', { blueprint: 'cabin', origin: ORIGIN, turns: 0 });
  for (let i = 0; i < 40; i++) {
    const st = await call('dev.build.state');
    if (st.ready) break;
    await sleep(250);
  }
  return call('dev.build.confirm', {}, 60_000);
}

async function gamerules() {
  return [await cmd('/gamerule random_tick_speed 0'), await cmd('/gamerule advance_time false'), await cmd('/time set 6000'),
    await cmd('/gamerule spawn_mobs false')];
}

/** The hopper chain: crate <- H1 <- H2, each hopper fed by a chest above it; z grows away from the site. */
function chain(crate) {
  const [x, y, z] = crate;
  return {
    h1: [x, y, z + 1], c1: [x, y + 1, z + 1],
    h2: [x, y, z + 2], c2: [x, y + 1, z + 2],
  };
}

const at = (p) => p.join(' ');
const key = (p) => p.join(',');

switch (step) {
  case 'survival-pre': {
    const sv = await call('dev.survival.state');
    check(sv.survival === true, `the toggle is on by default in a fresh survival world (${JSON.stringify(sv)})`);
    const rules = await gamerules();
    await call('dev.camera', { x: 5, y: 130, z: 40, yaw: 180, pitch: 30, mode: 'keep' }).catch(() => null);
    await call('dev.waitChunks', {}, 40_000).catch(() => null);
    const pre = await cells(REGION.min, REGION.max);
    save('survival-pre', { survival: sv, gamerules: rules, region: REGION, ...pre });
    console.log(`terrain before: ${pre.sha256} (${Object.keys(pre.cells).length} cells, ${pre.blockEntities} block entities)`);
    break;
  }
  case 'survival-place': {
    const r = await place();
    check(r.placed === true && r.siteId === SITE, `placed: ${r.message}`);
    const st = await siteState();
    check(st.state === 'building', `state building, queue ${st.queue}, built ${st.built}, BOM ${st.bomTotal} items`);
    await sleep(1500);
    const gh = await call('dev.ghosts.state');
    const g = gh.ghosts.find((x) => x.site === SITE);
    check(!!g && g.remaining === st.queue, `the client holds the ghost: ${g ? `${g.remaining} remaining cells, HUD "${g.hud}"` : 'none'}`);
    const sites = await call('dev.sites.state');
    save('survival-place', { place: r, site: st, ghosts: gh, record: sites.sites.find((s) => s.id === SITE) });
    break;
  }
  case 'survival-relog': {
    await sleep(3000);
    const gh = await call('dev.ghosts.state');
    const st = await siteState();
    const g = gh.ghosts.find((x) => x.site === SITE);
    check(!!g && g.cells === st.queue && g.remaining === st.queue - st.built, `after the relog the ghost is back: ${JSON.stringify(g)}`);
    const sites = await call('dev.sites.state');
    save('survival-relog', { ghosts: gh, site: st, reports: sites.reports });
    break;
  }
  case 'survival-feed': {
    const st = await siteState();
    const bom = st.bom;
    const crate = [st.crate.x, st.crate.y, st.crate.z];
    // part of the planks as logs (one way: 1 log = 4 planks): the planks the design needs beyond its own logs
    const chest = { ...bom };
    const logs = {};
    for (const [planks, log] of [['minecraft:spruce_planks', 'minecraft:spruce_log'], ['minecraft:dark_oak_planks', 'minecraft:dark_oak_log']]) {
      const n = chest[planks] ?? 0;
      const l = Math.floor(n / 4);
      if (l > 0) {
        chest[planks] = n - l * 4;
        if (chest[planks] === 0) delete chest[planks];
        chest[log] = (chest[log] ?? 0) + l;
        logs[log] = l;
      }
    }
    // stacks, logs first (so a log never arrives when only a few planks are still missing)
    const stacks = [];
    const order = Object.keys(chest).sort((a, b) => (a.endsWith('_log') ? 0 : 1) - (b.endsWith('_log') ? 0 : 1) || a.localeCompare(b));
    for (const item of order) {
      let n = chest[item];
      const max = /(_bed|_door|campfire|bookshelf)$/.test(item) ? 64 : 64;
      while (n > 0) {
        const c = Math.min(n, max);
        stacks.push([item, c]);
        n -= c;
      }
    }
    const ch = chain(crate);
    const placed = [];
    // the chain: setblock (dev, cheats) the hoppers and chests; hopper 1 points into the crate (north), hopper 2 into hopper 1
    placed.push(await cmd(`/setblock ${at(ch.h1)} minecraft:hopper[facing=north]`));
    placed.push(await cmd(`/setblock ${at(ch.h2)} minecraft:hopper[facing=north]`));
    placed.push(await cmd(`/setblock ${at(ch.c1)} minecraft:chest[facing=south]`));
    placed.push(await cmd(`/setblock ${at(ch.c2)} minecraft:chest[facing=south]`));
    // fill: chest 1 gets the first 27 stacks (logs first), chest 2 the rest; then the hoppers start pulling
    const fills = [];
    let slot = 0;
    let target = ch.c1;
    const chests = { [key(ch.c1)]: {}, [key(ch.c2)]: {} };
    for (const [item, n] of stacks) {
      if (slot === 27) {
        slot = 0;
        target = ch.c2;
      }
      if (target === ch.c2 && slot === 27) throw new Error('the BOM needs more than 2 chests');
      fills.push(await cmd(`/item replace block ${at(target)} container.${slot} with ${item} ${n}`));
      chests[key(target)][item] = (chests[key(target)][item] ?? 0) + n;
      slot++;
    }
    const bad = [...placed, ...fills].filter((x) => !x.success);
    check(bad.length === 0, `hopper chain and ${stacks.length} stacks in 2 chests (${bad.length} commands failed${bad.length ? ': ' + JSON.stringify(bad[0]) : ''})`);
    // the player stays next to it (hoppers and the builder only run in ticking chunks)
    await call('dev.camera', { x: crate[0] + 6, y: crate[1] + 8, z: crate[2] + 10, yaw: 150, pitch: 30, mode: 'keep' }).catch(() => null);
    const t0 = Date.now();
    const sprint = await cmd('/tick sprint 12000');
    let last;
    let midShot = null;
    for (let i = 0; i < 600; i++) {
      await sleep(1000);
      last = await siteState();
      if (!midShot && last.percent >= 40 && last.percent <= 75) {
        midShot = { percent: last.percent };
      }
      if (last.state === 'built') break;
    }
    await cmd('/tick sprint stop');
    const secs = Math.round((Date.now() - t0) / 1000);
    check(last.state === 'built', `built in ${secs}s of real time (tick sprint): ${last.built}/${last.queue} cells`);
    // what is left: chests and hoppers empty, no credit (the crate dropped its leftovers when it went)
    const leftover = [];
    for (const p of [ch.c1, ch.c2, ch.h1, ch.h2]) {
      const r = await cmd(`/data get block ${at(p)} Items`);
      leftover.push({ at: key(p), items: r.messages.join(' ') });
    }
    const empty = leftover.every((l) => /no elements|\[\]/i.test(l.items));
    check(empty, `chests and hoppers are empty: ${leftover.map((l) => l.items).join(' | ')}`);
    const drops = await cmd(`/execute if entity @e[type=item,x=${crate[0] - 3},y=${crate[1] - 3},z=${crate[2] - 3},dx=7,dy=7,dz=7]`);
    check(!drops.success || /fail/i.test(drops.messages.join(' ')), `no leftover items dropped at the crate (credit 0): ${drops.messages.join(' ')}`);
    save('survival-feed', { bom, chests, logsAsEquivalents: logs, stacks: stacks.length, chain: ch, commands: [...placed, ...fills.slice(0, 3)], sprint,
      final: last, seconds: secs, leftover, drops });
    // the finished site's cells (the comparison with the instant placement)
    const rec = (await call('dev.sites.state')).sites.find((s) => s.id === SITE);
    const sb = rec.snapshotBox ?? rec.box;
    const built = await cells([sb.minX, sb.minY, sb.minZ], [sb.maxX, sb.maxY, sb.maxZ]);
    save('survival-built-cells', { snapshotBox: sb, ...built });
    console.log(`finished site cells: ${built.sha256} (${Object.keys(built.cells).length} cells, ${built.blockEntities} block entities)`);
    break;
  }
  case 'survival-mine': {
    const b = load('survival-built-cells');
    const full = /^\{id:"minecraft:(spruce_planks|spruce_log|stripped_spruce_log|dark_oak_planks)"/;
    const attachy = /(torch|lantern|door|bed|carpet|pane|pot|ladder|sign|button|trapdoor|fence|stairs|slab|campfire|chest|barrel|plate)/;
    const picks = [];
    const sb = b.snapshotBox;
    for (const [k, v] of Object.entries(b.cells)) {
      const [x, y, z] = k.split(',').map(Number);
      if (!full.test(v) || y < sb.minY + 3 || x < sb.minX + 1 || x > sb.maxX - 1 || z < sb.minZ + 1) continue;
      const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([dx, dy, dz]) => b.cells[`${x + dx},${y + dy},${z + dz}`] ?? '');
      if (nb.some((n) => attachy.test(n))) continue;
      if (picks.some((p) => Math.abs(p[0] - x) + Math.abs(p[1] - y) + Math.abs(p[2] - z) < 3)) continue;
      picks.push([x, y, z, v]);
      if (picks.length === 3) break;
    }
    check(picks.length === 3, `3 placed full blocks to mine: ${picks.map((p) => p.slice(0, 3).join(',') + ' ' + p[3].match(/minecraft:[a-z_]+/)[0]).join('; ')}`);
    const inv0 = await cmd('/data get entity @s Inventory');
    const mined = [];
    for (const [x, y, z, v] of picks) {
      await call('dev.camera', { x: x + 0.5, y: y + 1, z: z + 3.5, yaw: 180, pitch: 20, mode: 'keep' }).catch(() => null);
      const r = await call('dev.site.mine', { pos: [x, y, z] });
      mined.push({ at: [x, y, z], was: v, ...r });
    }
    const inv1 = await cmd('/data get entity @s Inventory');
    check(mined.every((m) => m.mined && m.pickedUp >= 1), `mined 3 and picked up the drops: ${mined.map((m) => m.drops.join('+')).join(', ')}`);
    save('survival-mine', { mined, inventoryBefore: inv0.messages, inventoryAfter: inv1.messages });
    break;
  }
  case 'survival-decon': {
    const fed = load('survival-feed');
    const mine = load('survival-mine');
    const pre = load('survival-pre');
    const minedItems = {};
    for (const m of mine.mined) {
      const id = m.was.match(/minecraft:[a-z_]+/)[0];
      minedItems[id] = (minedItems[id] ?? 0) + 1;
    }
    const expected = { ...fed.bom };
    for (const [k, v] of Object.entries(minedItems)) expected[k] -= v;
    for (const k of Object.keys(expected)) if (expected[k] === 0) delete expected[k];
    await call('dev.camera', { x: 5, y: 130, z: 45, yaw: 180, pitch: 30, mode: 'keep' }).catch(() => null);
    const r = await call('dev.site.deconstruct', { site: SITE }, 60_000);
    check(r.removed === true, `deconstructed: ${r.message ?? r.restoreBox}`);
    const t = r.tally ?? {};
    const refund = t.refund ?? {};
    const keys = new Set([...Object.keys(refund), ...Object.keys(expected)]);
    const mism = [...keys].filter((k) => (refund[k] ?? 0) !== (expected[k] ?? 0)).map((k) => `${k}: refund ${refund[k] ?? 0}, expected ${expected[k] ?? 0}`);
    const total = (m) => Object.values(m).reduce((a, b) => a + b, 0);
    check(mism.length === 0, `refund = BOM - 3 mined: ${total(refund)} items = ${total(fed.bom)} - ${total(minedItems)} ${mism.length ? '; ' + mism.join('; ') : ''}`);
    check(total(t.playerBlocks ?? {}) === 0, `no player's blocks dropped (${JSON.stringify(t.playerBlocks)}); crate stock ${JSON.stringify(t.crateStock)}`);
    check((t.missingOrMined ?? -1) === 3, `3 queued cells missing (the mined ones), not refunded again: ${t.missingOrMined}`);
    // the refund items lie at the crate's cell
    await sleep(1500);
    const crate = fed.final.crate;
    // what the player really gets: the refund items lying at the crate's cell after the restore's drop cleanup (3 ticks), then
    // picked up: the inventory must hold exactly the BOM (the refund plus the 3 mined blocks already held)
    const placeRec = load('survival-place');
    const cp = [placeRec.site.crate.x, placeRec.site.crate.y, placeRec.site.crate.z];
    await sleep(2000);
    const lying = await call('dev.items.near', { pos: cp, radius: 6 });
    const lyingMism = [...new Set([...Object.keys(lying.items), ...Object.keys(expected)])].filter((k) => (lying.items[k] ?? 0) !== (expected[k] ?? 0));
    check(lyingMism.length === 0, `the refund lies at the crate's cell as items, exactly: ${total(lying.items)} items in ${lying.stacks} stacks${lyingMism.length ? '; differ: ' + lyingMism.join(', ') : ''}`);
    await cmd(`/tp @s ${cp[0] + 0.5} ${cp[1]} ${cp[2] + 0.5}`);
    await sleep(3000);
    const after = await call('dev.items.near', { pos: cp, radius: 6 });
    const invMism = [...new Set([...Object.keys(after.inventory), ...Object.keys(fed.bom)])].filter((k) => (after.inventory[k] ?? 0) !== (fed.bom[k] ?? 0));
    check(after.stacks === 0 && invMism.length === 0, `picked up: the player's inventory holds exactly the BOM (${total(after.inventory)} items = ${total(fed.bom)}), ${after.stacks} stacks left${invMism.length ? '; differ: ' + invMism.map((k) => `${k} ${after.inventory[k] ?? 0}/${fed.bom[k] ?? 0}`).join(', ') : ''}`);
    const items = { lying, after };
    // terrain: the region as before, except the hopper chain cells; then put those back and the whole region matches
    await sleep(500);
    const post = await cells(REGION.min, REGION.max);
    const chainCells = new Set(Object.values(fed.chain).map(key));
    const d = diff(pre.cells, post.cells, chainCells);
    check(d.length === 0, `terrain restored exactly over the snapshot box + 7 (${Object.keys(post.cells).length} cells; ${d.length} differ outside the hopper chain${d.length ? ': ' + JSON.stringify(d.slice(0, 3)) : ''})`);
    const restore = [];
    for (const k of chainCells) {
      const [x, y, z] = k.split(',');
      const st = pre.cells[k].replace(/ be=.*$/, '');
      const m = st.match(/^\{id:"([^"]+)"(?:,[Pp]roperties:\{(.*)\})?\}$/);
      const props = m[2] ? '[' + m[2].replace(/"/g, '').replace(/:/g, '=') + ']' : '';
      restore.push(await cmd(`/setblock ${x} ${y} ${z} ${m[1]}${props}`));
    }
    const post2 = await cells(REGION.min, REGION.max);
    check(post2.sha256 === pre.sha256, `after putting the 4 hopper-chain cells back: region hash ${post2.sha256} ${post2.sha256 === pre.sha256 ? '==' : '!='} before ${pre.sha256}`);
    save('survival-decon', { deconstruct: r, minedItems, expectedRefund: expected, mismatches: mism, refundItemsAtCrate: items, terrainDiff: d,
      restoreChain: restore, postSha: post.sha256, post2Sha: post2.sha256, preSha: pre.sha256 });
    break;
  }
  case 'creative':
  case 'instant': {
    // creative: a fresh creative world (same seed): the toggle is off by default and placement is instant. World generation
    // is not cell-exact across worlds (leaf litter, a tree), so the cell comparison there counts only cells whose terrain matched.
    // instant: a copy of the survival world after the gate (its terrain proven restored exactly) with the toggle off: the
    // same terrain, so the finished construction site must equal the instant placement in every cell of the snapshot box.
    const exact = step === 'instant';
    const sv = await call('dev.survival.state');
    check(sv.survival === false, exact ? `the toggle is off in the copied world (${JSON.stringify(sv)})`
      : `the toggle is off by default in a creative world (${JSON.stringify(sv)})`);
    const rules = await gamerules();
    await call('dev.camera', { x: 5, y: 130, z: 40, yaw: 180, pitch: 30, mode: 'keep' }).catch(() => null);
    await call('dev.waitChunks', {}, 40_000).catch(() => null);
    const pre = await cells(REGION.min, REGION.max);
    let sPre = null;
    try {
      sPre = load('survival-pre');
    } catch {}
    const sameTerrain = !!sPre && sPre.sha256 === pre.sha256;
    if (exact) check(sameTerrain, `the same terrain as the survival world before its site (${pre.sha256})`);
    else console.log(`note same seed; terrain ${sameTerrain ? 'identical' : 'not cell-identical (world generation)'}: ${pre.sha256}`);
    const r = await place();
    check(r.placed === true && !/Construction site/.test(r.message), `placed instantly: ${r.message}`);
    const rec = (await call('dev.sites.state')).sites.find((s) => s.id === r.siteId);
    check(!rec.construction, 'an instant site has no construction data');
    const sb = rec.snapshotBox ?? rec.box;
    const inst = await cells([sb.minX, sb.minY, sb.minZ], [sb.maxX, sb.maxY, sb.maxZ]);
    let built = null;
    try {
      built = load('survival-built-cells');
    } catch {}
    let cmp = null;
    if (built) {
      const all = diff(inst.cells, built.cells);
      // cells whose terrain differed between the two worlds before placing are not the site's doing
      const terrainDiff = new Set(sPre ? Object.keys(sPre.cells).filter((k) => sPre.cells[k] !== pre.cells[k]) : []);
      const d = all.filter((x) => !terrainDiff.has(x.at));
      const sameBox = JSON.stringify(built.snapshotBox) === JSON.stringify(sb);
      cmp = { sameBox, differing: all.length, terrainDiffCells: terrainDiff.size, differingOutsideTerrainDiff: d.length, first: d.slice(0, 10) };
      check(sameBox && d.length === 0 && (!exact || all.length === 0), `the finished construction site equals the instant placement cell for cell, BE NBT included: ${Object.keys(inst.cells).length} cells, ${inst.blockEntities} block entities, ${all.length} differ${exact ? '' : ` (${terrainDiff.size} cells of the region had other terrain before; ${d.length} differ elsewhere)`}${d.length ? ': ' + JSON.stringify(d.slice(0, 3)) : ''}`);
    }
    // place / stand / remove: the snapshot box + 7 comes back byte-exact
    await sleep(3000);
    const rm = await call('dev.sites.remove', { site: r.siteId }, 60_000);
    await sleep(1000);
    const post = await cells(REGION.min, REGION.max);
    const d2 = diff(pre.cells, post.cells);
    check(rm.removed && post.sha256 === pre.sha256, `instant Remove restores the snapshot box + 7 exactly (${post.sha256 === pre.sha256 ? 'same hash' : d2.length + ' cells differ'})`);
    save(step, { survival: sv, gamerules: rules, place: r, instantCellsSha: inst.sha256, instantBlockEntities: inst.blockEntities, compare: cmp,
      remove: rm, preSha: pre.sha256, postSha: post.sha256, removeDiff: d2.slice(0, 20) });
    save(`${step}-instant-cells`, { snapshotBox: sb, ...inst });
    break;
  }
  case 'regression': {
    // instant placement unchanged with the toggle off: place, stand under 300x random ticks for 30 s, remove; the snapshot
    // box + 7 must come back exactly (phase 2's exact-Remove property, LeafGuard included)
    const sv = await call('dev.survival.state');
    check(sv.survival === false, `the toggle is off (${JSON.stringify(sv)})`);
    await call('dev.camera', { x: 5, y: 130, z: 40, yaw: 180, pitch: 30, mode: 'keep' }).catch(() => null);
    await cmd('/kill @e[type=item]');
    await cmd('/gamerule random_tick_speed 0');
    const pre = await cells(REGION.min, REGION.max);
    const r = await place();
    check(r.placed === true && !/Construction site/.test(r.message), `placed instantly: ${r.message}`);
    const ticks = [await cmd('/gamerule random_tick_speed 300')];
    await sleep(30_000);
    ticks.push(await cmd('/gamerule random_tick_speed 0'));
    await sleep(1000);
    const rm = await call('dev.sites.remove', { site: r.siteId }, 60_000);
    await sleep(1500);
    const post = await cells(REGION.min, REGION.max);
    const all = diff(pre.cells, post.cells);
    // nature, not the site: grass under a world-generated log or other opaque block turns to dirt on its first random tick
    // (random ticks were off since the world was made), outside the snapshot box
    const rec = (await call('dev.sites.state')).pending.map((p) => p.site).find((x) => x.id === r.siteId);
    const sb = rec?.snapshotBox ?? rec?.box;
    const inBox = (k) => {
      const [x, y, z] = k.split(',').map(Number);
      return sb && x >= sb.minX && x <= sb.maxX && y >= sb.minY && y <= sb.maxY && z >= sb.minZ && z <= sb.maxZ;
    };
    const covered = (k) => {
      const [x, y, z] = k.split(',').map(Number);
      return /oak_log|_log"|stone|dirt"|deepslate/.test(pre.cells[`${x},${y + 1},${z}`] ?? '');
    };
    const natural = all.filter((c) => /grass_block/.test(c.before) && /minecraft:dirt"/.test(c.after) && covered(c.at) && !inBox(c.at));
    const d = all.filter((c) => !natural.includes(c));
    check(rm.removed && d.length === 0, `place, stand 30 s at 300x random ticks, remove: the snapshot box + 7 is back exactly (${d.length} of ${Object.keys(pre.cells).length} cells differ${d.length ? ': ' + JSON.stringify(d.slice(0, 5)) : ''}; ${natural.length} natural change(s) outside the box: grass under a world-generated log turned to dirt${natural.length ? ' ' + natural.map((c) => c.at).join(' ') : ''})`);
    save('regression', { survival: sv, place: r, randomTicks: ticks, remove: rm, preSha: pre.sha256, postSha: post.sha256, diff: d.slice(0, 50), differing: d.length, natural });
    break;
  }
  case 'extras-insert': {
    // not in the gate: Insert from inventory (only what the site needs leaves the inventory) and a crate removed by /setblock
    await cmd('/kill @e[type=item]');
    await call('dev.camera', { x: 5, y: 130, z: 40, yaw: 180, pitch: 30, mode: 'keep' }).catch(() => null);
    const r = await place();
    check(r.placed === true && /Construction site/.test(r.message), `placed: ${r.message}`);
    const id = r.siteId;
    const st0 = await call('dev.site.state', { site: id });
    const cp = [st0.crate.x, st0.crate.y, st0.crate.z];
    const give = [await cmd('/clear @s'), await cmd('/give @s minecraft:spruce_log 10'), await cmd('/give @s minecraft:cobblestone 64'),
      await cmd('/give @s minecraft:diamond 5')];
    await cmd(`/tp @s ${cp[0] + 0.5} ${cp[1]} ${cp[2] + 2.5}`);
    await call('dev.crate.open', { site: id });
    await sleep(1000);
    const pressed = await call('dev.crate.press', { control: 'insert' });
    await sleep(1500);
    const inv = await call('dev.items.near', { pos: cp, radius: 2 });
    const scr = await call('dev.crate.state');
    check((inv.inventory['minecraft:spruce_log'] ?? 0) === 0 && inv.inventory['minecraft:cobblestone'] === 25 && inv.inventory['minecraft:diamond'] === 5,
      `Insert from inventory moved only what the site needs: inventory now ${JSON.stringify(inv.inventory)}; "${scr.flash}"`);
    await call('dev.screen', { open: null });
    await sleep(2000);
    const st1 = await call('dev.site.state', { site: id });
    await cmd(`/setblock ${cp.join(' ')} minecraft:air`);
    await sleep(2500);
    const st2 = await call('dev.site.state', { site: id });
    const gh = await call('dev.ghosts.state');
    const g = gh.ghosts.find((x) => x.site === id);
    check(st2.crate.missing === true && st2.notes.some((n) => /crate missing/.test(n)) && /crate missing/.test(g?.hud ?? ''),
      `crate removed by /setblock: state ${JSON.stringify(st2.crate)}, note "${st2.notes[0]}", HUD "${g?.hud}"`);
    save('extras-insert', { place: r, give, pressed: pressed.flash, inventory: inv.inventory, before: st1.built, crateGone: st2.crate, notes: st2.notes, hud: g?.hud,
      ledgerBefore: st1.ledger });
    break;
  }
  case 'extras-missing': {
    // after a relog: the world-start report names the missing crate; Deconstruct from the Library refunds placed cells only
    const sites = await call('dev.sites.state');
    const rec = sites.sites.find((x) => x.construction && x.construction.state === 'building');
    const id = rec.id;
    check(/crate missing/.test(sites.reports[id] ?? ''), `world-start report: ${sites.reports[id]}`);
    const before = load('extras-insert');
    const st = await call('dev.site.state', { site: id });
    const rm = await call('dev.sites.remove', { site: id }, 60_000);
    const tally = (await call('dev.site.state', { site: id }).catch((e) => ({ error: e.message })));
    const cp = [rec.construction.crate.pos[0], rec.construction.crate.pos[1], rec.construction.crate.pos[2]];
    await sleep(1500);
    const lying = await call('dev.items.near', { pos: cp, radius: 6 });
    const cell = await cmd(`/execute if block ${cp.join(' ')} minecraft:air`);
    check(rm.removed === true, `Deconstruct (Library path) works with the crate missing: ${rm.restoreBox ?? rm.message}; items at the crate cell ${JSON.stringify(lying.items)} (placed cells only: ${st.built} built cells)`);
    check(cell.success, `the crate cell keeps what replaced the crate (air here): ${cell.messages.join(' ')}`);
    save('extras-missing', { report: sites.reports[id], built: st.built, remove: rm, refundLying: lying, crateCell: cell, after: tally, insertStep: before.inventory });
    break;
  }
  case 'hardcore': {
    const sv = await call('dev.survival.state');
    check(sv.survival === true && sv.mayToggle === false, `hardcore: the toggle is on by default and the player may not change it (${JSON.stringify(sv)})`);
    const off = await cmd('/architect survival off', true);
    check(!off.success, `/architect survival off without cheats is refused: ${off.messages.join(' ')}`);
    const show = await cmd('/architect survival', true);
    check(show.success, `/architect survival (show) works without cheats: ${show.messages.join(' ')}`);
    const finish = await cmd(`/architect site finish ${SITE}`, true);
    await call('dev.camera', { x: 5, y: 130, z: 40, yaw: 180, pitch: 30, mode: 'keep' }).catch(() => null);
    await call('dev.waitChunks', {}, 40_000).catch(() => null);
    const r = await place();
    check(r.placed === true && /Construction site/.test(r.message), `a construction site places without cheats: ${r.message}`);
    const fin = await cmd(`/architect site finish ${SITE}`, true);
    check(!fin.success, `/architect site finish without cheats is refused: ${fin.messages.join(' ')}`);
    const ins = await call('dev.crate.insert', { site: SITE, items: { 'minecraft:cobblestone': 64, 'minecraft:spruce_log': 30 } });
    await sleep(4000);
    const st = await siteState();
    check(st.built > 0, `it builds from what the crate holds: ${st.built}/${st.queue} cells, accepted ${JSON.stringify(ins.accepted)}`);
    const open = await call('dev.crate.open', { site: SITE });
    await sleep(1500);
    await call('dev.crate.press', { control: 'deconstruct' });
    await call('dev.crate.press', { control: 'deconstruct' });
    await sleep(2500);
    const sites = await call('dev.sites.state');
    check(!sites.sites.some((s) => s.id === SITE), `deconstructed from the crate screen (no cheats); last tally ${JSON.stringify((await call('dev.ghosts.state')).ghosts)}`);
    save('hardcore', { survival: sv, toggleOff: off, show, finishBefore: finish, place: r, finish: fin, insert: ins, state: st, sites });
    break;
  }
  default:
    console.error('usage: node tools/gate3.mjs survival-pre|survival-place|survival-relog|survival-feed|survival-mine|survival-decon|creative|hardcore');
    process.exitCode = 2;
}
dev.close();
