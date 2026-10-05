#!/usr/bin/env node
// README survival screenshots (docs/img/readme/site-*.jpg, crate.jpg, hoppers.jpg, library-survival.jpg), step by step
// against a dev client in a fresh survival world with cheats for the dev tool. No Claude: the bundled cabin is placed, and
// the library holds copies of the Town House design. Never a real world.
//
//   ARCHITECT_PORT=7990 ARCHITECT_DEV_PORT=7991 ARCHITECT_SHOTS_DIR=$PWD/artifacts/readme \
//     ARCHITECT_AUTOWORLD_NAME="README Survival" ARCHITECT_AUTOWORLD_MODE=survival ARCHITECT_AUTOWORLD_CHEATS=1 \
//     tools/run-p3-client.sh
//   ARCHITECT_DEV_PORT=7991 node tools/readme-survival.mjs <step>
//
// Steps, in order:
//   setup     gamerules (no command feedback, no mobs, fixed time), the toggle is on
//   library   the Library detail of the Town House in this survival world: "Needs: N items", Place construction site
//   place     place the cabin site at gate 3's spot (seed 2026, origin 0,116,12)
//   clear     chop the trees between the camera and the site (CLEAR); shot of the fresh site (the "before")
//   feed      a hopper chain from two chests holding about half of each BOM item (part as logs); runs until it stalls
//   shots     the stalled site (ghost + HUD line), the hopper chain, the crate screen
//   finish    top the chests up with the rest of the BOM; runs until built; shot of the finished site (the "after")
// Camera positions are below (CAMS); shots land in $ARCHITECT_SHOTS_DIR/raw/.

import { DevClient } from './lib/devclient.mjs';

const ORIGIN = [0, 116, 12];
const SITE = process.env.README_SITE ?? 's1';
const CAMS = {
  site: { x: 15.5, y: 126, z: 36.5, lookAt: { x: 5, y: 120, z: 18 }, fov: 70, mode: 'spectator' },
};
// The spot is in a forest: trees in front of the camera are cleared (leaves and logs only, outside the snapshot box, plus
// one oak beside the approach path that the site keeps as terrain), as a player would chop them.
const CLEAR = [[-12, 110, 5, -1, 145, 50], [11, 110, 5, 28, 145, 50], [0, 110, 28, 10, 145, 50], [-2, 117, 23, 8, 132, 28]];

const step = process.argv[2];
const dev = await DevClient.connect({ timeoutMs: 60_000 });
const call = (type, payload = {}, timeoutMs) => dev.call(type, payload, timeoutMs ? { timeoutMs } : {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmd = (c) => call('dev.command', { cmd: c });
const shot = (name, hud = true, frames = 8) => call('dev.screenshot', { name: `raw/${name}`, hideHud: !hud, frames, waitChunks: true }, 120_000);
const at = (p) => p.join(' ');
const cam = (c) => call('dev.camera', { mode: 'keep', ...c });

/** The hopper chain (as gate3.mjs): crate <- H1 <- H2, each hopper fed by a chest above it. */
function chain(crate) {
  const [x, y, z] = crate;
  return { h1: [x, y, z + 1], c1: [x, y + 1, z + 1], h2: [x, y, z + 2], c2: [x, y + 1, z + 2] };
}

/** Stacks for a set of items: planks partly as logs (1 log = 4 planks, one way), logs first. */
function stacks(items) {
  const chest = { ...items };
  for (const [planks, log] of [['minecraft:spruce_planks', 'minecraft:spruce_log'], ['minecraft:dark_oak_planks', 'minecraft:dark_oak_log']]) {
    const n = chest[planks] ?? 0;
    const l = Math.floor(n / 4);
    if (l > 0) {
      chest[planks] = n - l * 4;
      if (chest[planks] === 0) delete chest[planks];
      chest[log] = (chest[log] ?? 0) + l;
    }
  }
  const out = [];
  const order = Object.keys(chest).sort((a, b) => (a.endsWith('_log') ? 0 : 1) - (b.endsWith('_log') ? 0 : 1) || a.localeCompare(b));
  for (const item of order) {
    for (let n = chest[item]; n > 0; n -= 64) out.push([item, Math.min(n, 64)]);
  }
  return out;
}

async function fill(ch, list) {
  let slot = 0;
  let target = ch.c1;
  for (const [item, n] of list) {
    if (slot === 27) {
      if (target === ch.c2) throw new Error('more than 2 chests');
      slot = 0;
      target = ch.c2;
    }
    await cmd(`/item replace block ${at(target)} container.${slot} with ${item} ${n}`);
    slot++;
  }
}

async function runUntil(done, maxSecs = 600) {
  await cmd('/tick sprint 12000');
  let st;
  let same = 0;
  let last = -1;
  for (let i = 0; i < maxSecs; i++) {
    await sleep(1000);
    st = await call('dev.site.state', { site: SITE });
    if (done(st)) break;
    same = st.built === last ? same + 1 : 0;
    last = st.built;
    if (same >= 5) break;
  }
  await cmd('/tick sprint stop');
  return st;
}

switch (step) {
  case 'setup': {
    for (const c of ['/gamerule send_command_feedback false', '/gamerule spawn_mobs false', '/gamerule random_tick_speed 0',
      '/gamerule advance_time false', '/gamerule advance_weather false', '/time set 3000', '/weather clear',
      '/kill @e[type=!minecraft:player,distance=..200]', '/kill @e[type=minecraft:item]', '/effect give @s minecraft:night_vision infinite 0 true']) {
      await cmd(c);
    }
    console.log(JSON.stringify(await call('dev.survival.state')));
    break;
  }
  case 'library': {
    await call('dev.ui.open', { tab: 'library' });
    await call('dev.library.filter', { reset: true });
    await call('dev.library.select', { entry: process.argv[3] ?? 'gen_gate_two_house' });
    await sleep(800);
    console.log(JSON.stringify(await shot(process.argv[4] ?? 'library_survival')));
    break;
  }
  case 'place': {
    await cam(CAMS.site);
    await call('dev.waitChunks', {}, 40_000).catch(() => null);
    await call('dev.build.start', { blueprint: 'cabin', origin: ORIGIN, turns: 0 });
    for (let i = 0; i < 40 && !(await call('dev.build.state')).ready; i++) await sleep(250);
    const r = await call('dev.build.confirm', {}, 60_000);
    const st = await call('dev.site.state', { site: SITE });
    console.log(JSON.stringify({ placed: r.placed, siteId: r.siteId, message: r.message, queue: st.queue, bomTotal: st.bomTotal, crate: st.crate }));
    break;
  }
  case 'clear': {
    for (const box of CLEAR) {
      for (const t of ['leaves', 'logs']) await cmd(`/fill ${box.join(' ')} minecraft:air replace #minecraft:${t}`);
    }
    await cmd('/kill @e[type=minecraft:item]');
    await cam(CAMS.site);
    await sleep(1500);
    console.log(JSON.stringify(await shot('site_before')));
    break;
  }
  case 'feed': {
    const st = await call('dev.site.state', { site: SITE });
    const crate = [st.crate.x, st.crate.y, st.crate.z];
    const ch = chain(crate);
    for (const [p, b] of [[ch.h1, 'hopper[facing=north]'], [ch.h2, 'hopper[facing=north]'], [ch.c1, 'chest[facing=south]'], [ch.c2, 'chest[facing=south]']]) {
      await cmd(`/setblock ${at(p)} minecraft:${b}`);
    }
    const half = Object.fromEntries(Object.entries(st.bom).map(([k, v]) => [k, Math.ceil(v / 2)]));
    await fill(ch, stacks(half));
    await cam({ x: crate[0] + 6, y: crate[1] + 8, z: crate[2] + 10, yaw: 150, pitch: 30 });
    const end = await runUntil((s) => s.state === 'built', 300);
    console.log(JSON.stringify({ crate, built: end.built, queue: end.queue, percent: end.percent, state: end.state }));
    break;
  }
  case 'shots': {
    const st = await call('dev.site.state', { site: SITE });
    console.log(JSON.stringify({ built: st.built, queue: st.queue, percent: st.percent }));
    const crate = [st.crate.x, st.crate.y, st.crate.z];
    await cam(CAMS.site);
    await sleep(1500);
    console.log(JSON.stringify(await shot('site_mid')));
    await cam({ x: crate[0] + 4.5, y: crate[1] + 3.2, z: crate[2] + 6.5, lookAt: { x: crate[0] + 0.5, y: crate[1] + 0.8, z: crate[2] + 1.5 }, fov: 70 });
    await sleep(800);
    console.log(JSON.stringify(await shot('hoppers')));
    await call('dev.crate.open', { site: SITE });
    await sleep(1000);
    console.log(JSON.stringify(await shot('crate')));
    await call('dev.screen', { open: null });
    break;
  }
  case 'finish': {
    const st = await call('dev.site.state', { site: SITE });
    const crate = [st.crate.x, st.crate.y, st.crate.z];
    const missing = {};
    for (const r of st.rows ?? []) if (r.missing > 0) missing[r.item] = r.missing;
    console.log(JSON.stringify({ missing }));
    await fill(chain(crate), stacks(missing));
    const end = await runUntil((s) => s.state === 'built', 300);
    console.log(JSON.stringify({ built: end.built, queue: end.queue, state: end.state }));
    await cmd('/kill @e[type=minecraft:item]');
    await cam(CAMS.site);
    await sleep(1500);
    console.log(JSON.stringify(await shot('site_after')));
    break;
  }
  default:
    console.error('steps: setup | library | place | feed | shots | finish');
    process.exitCode = 2;
}
dev.close();
