// Slice OC (docs/GATES.md "Harnesses clear the box"): the shared clear-the-box rule of the test harnesses (tools/lib/clearBox.mjs):
// the box and its margin, the selectors with their exemptions (villagers always, a step's own types and tags), where the player goes,
// which answers trigger it, the pause for a step that tests a wait, and the watcher's re-arm after a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBox, expandBox, mobSelector, killCommands, playerTarget, waitReason, parsePos, createClearer, createWatcher, DEFAULT_EXEMPT_TYPES,
} from '../../tools/lib/clearBox.mjs';

const claim = { minX: 100, minY: -64, minZ: 200, maxX: 163, maxY: 320, maxZ: 263 };

test('normalizeBox reads every claim shape and refuses garbage', () => {
  assert.deepEqual(normalizeBox([10, 20, 5, 8]), { x0: 5, x1: 10, y0: -64, y1: 320, z0: 8, z1: 20 });
  assert.deepEqual(normalizeBox(claim), { x0: 100, x1: 163, y0: -64, y1: 320, z0: 200, z1: 263 });
  assert.deepEqual(normalizeBox({ x0: 1, y0: 2, z0: 3, x1: 4, y1: 5, z1: 6 }), { x0: 1, x1: 4, y0: 2, y1: 5, z0: 3, z1: 6 });
  assert.equal(normalizeBox(null), null);
  assert.equal(normalizeBox({ foo: 1 }), null);
  assert.equal(normalizeBox([1, 2, 'a', 4]), null);
});

test('the kill selector spans the box plus the margin and never names the player or a villager', () => {
  const box = expandBox(normalizeBox(claim), 2);
  const sel = mobSelector(box);
  assert.match(sel, /^@e\[type=!minecraft:player,type=!minecraft:villager,/);
  assert.match(sel, /x=98,y=-66,z=198,dx=68,dy=389,dz=68\]$/);
  assert.ok(DEFAULT_EXEMPT_TYPES.includes('minecraft:villager'));
});

test('a step can exempt types and tags; the selector keeps them', () => {
  const sel = mobSelector(null, { types: ['iron_golem', 'minecraft:cat'], tags: ['mover'] });
  assert.equal(sel, '@e[type=!minecraft:player,type=!minecraft:villager,type=!minecraft:iron_golem,type=!minecraft:cat,tag=!mover]');
  assert.doesNotMatch(mobSelector(null), /tag=/);
});

test('a clear also kills the drops and the orbs inside the same box (unless kept)', () => {
  const box = expandBox(normalizeBox(claim), 2);
  const c = killCommands(box);
  assert.equal(c.length, 3);
  assert.match(c[1], /type=minecraft:item,x=98/);
  assert.match(c[2], /type=minecraft:experience_orb,x=98/);
  assert.equal(killCommands(box, { keepItems: true }).length, 1);
});

test('the player moves to just past the nearest edge, at its own height; a clear player stays', () => {
  const box = normalizeBox(claim);
  assert.deepEqual(playerTarget(box, { x: 104, y: 90, z: 230 }), { x: 88, z: 230, y: 90 }); // nearest edge: west
  assert.deepEqual(playerTarget(box, { x: 130, y: 90, z: 261 }), { x: 130, z: 276, y: 90 }); // south
  assert.equal(playerTarget(box, { x: 500, y: 70, z: 500 }), null);
  assert.deepEqual(playerTarget(box, null), { x: 131.5, z: 276, y: null }); // unknown position: past the south edge
});

test('a big claim sends the player straight up, not hundreds of blocks away; above the claim nothing moves', () => {
  const big = normalizeBox({ minX: 0, minY: -27, minZ: 0, maxX: 399, maxY: 167, maxZ: 399 });
  assert.deepEqual(playerTarget(big, { x: 200, y: 90, z: 200 }), { x: 200, z: 200, y: 175 });
  assert.deepEqual(playerTarget(big, { x: 3, y: 90, z: 200 }), { x: -12, z: 200, y: 90 }); // near an edge: walks out
  assert.equal(playerTarget(big, { x: 200, y: 180, z: 200 }), null);
});

test('only OCCUPIED and PLAYER_IN_BOX answers count, in the three shapes the drivers see', () => {
  assert.equal(waitReason({ view: { waiting: { reason: 'OCCUPIED' } } }), 'OCCUPIED');
  assert.equal(waitReason({ waiting: { reason: 'PLAYER_IN_BOX' } }), 'PLAYER_IN_BOX');
  assert.equal(waitReason({ waiting: { OCCUPIED: 2 } }), 'OCCUPIED');
  assert.equal(waitReason({ view: { waiting: { reason: 'NOT_LOADED' } } }), null);
  assert.equal(waitReason({ view: {} }), null);
  assert.deepEqual(parsePos('Steward has the following entity data: [12.5d, 70.0d, -3.25d]'), { x: 12.5, y: 70, z: -3.25 });
});

function rig(pos = null) {
  const cmds = [];
  const logs = [];
  const cmd = async (c) => { cmds.push(c); return c.startsWith('/data get') ? { messages: pos ? [`[${pos.x}d, ${pos.y}d, ${pos.z}d]`] : [] } : { messages: [] }; };
  let t = 0;
  const clearer = createClearer({ cmd, log: (m) => logs.push(m), now: () => t, minGapMs: 3000 });
  return { cmds, logs, clearer, tick: (ms) => { t += ms; } };
}

test('OCCUPIED kills the box mobs and drops, spares villagers, and is logged and counted', async () => {
  const r = rig();
  const st = { view: { id: 'r1', claim, waiting: { reason: 'OCCUPIED', message: 'in the box: pig' } } };
  assert.equal(await r.clearer.onState(st), 'OCCUPIED');
  assert.equal(r.cmds.length, 3);
  assert.ok(r.cmds[0].includes('type=!minecraft:villager') && r.cmds[0].includes('x=98'));
  assert.match(r.logs[0], /box-clear: r1 waits OCCUPIED: killed mobs and drops in the box \[98,198 \.\. 165,265\]/);
  assert.equal(r.clearer.stats.byReason.OCCUPIED, 1);
  assert.equal(r.clearer.stats.events[0].message, 'in the box: pig');
});

test('PLAYER_IN_BOX moves the player out and kills nothing', async () => {
  const r = rig({ x: 104, y: 90, z: 230 });
  assert.equal(await r.clearer.onState({ view: { id: 'r2', claim, waiting: { reason: 'PLAYER_IN_BOX' } } }), 'PLAYER_IN_BOX');
  assert.deepEqual(r.cmds, ['/data get entity @p Pos', '/tp @p 88 90 230']);
  assert.equal(r.clearer.stats.playerMoves, 1);
  assert.match(r.logs[0], /moved the player from 104,90,230 to 88,90,230/);
});

test('an answer repeated within the gap is acted on once; later again (the answer is repeated until it clears)', async () => {
  const r = rig();
  const st = { view: { id: 'r3', claim, waiting: { reason: 'OCCUPIED' } } };
  await r.clearer.onState(st);
  r.tick(1000);
  assert.equal(await r.clearer.onState(st), null);
  r.tick(3000);
  assert.equal(await r.clearer.onState(st), 'OCCUPIED');
  assert.equal(r.clearer.stats.clears, 2);
});

test('exempt() keeps a step\'s entities alone while it runs; pause() makes the clearer do nothing', async () => {
  const r = rig();
  const st = { view: { id: 'r4', claim, waiting: { reason: 'OCCUPIED' } } };
  await r.clearer.exempt({ types: ['cow'], tags: ['mover'] }, async () => { await r.clearer.onState(st); });
  assert.ok(r.cmds[0].includes('type=!minecraft:cow') && r.cmds[0].includes('tag=!mover'));
  r.tick(5000);
  r.cmds.length = 0;
  await r.clearer.onState(st);
  assert.ok(!r.cmds[0].includes('minecraft:cow'), 'the exemption ended with the step');
  r.tick(5000);
  r.cmds.length = 0;
  await r.clearer.pause(async () => { assert.equal(await r.clearer.onState(st), null); assert.equal(await r.clearer.preClear(claim), false); });
  assert.equal(r.cmds.length, 0);
  assert.equal(r.clearer.paused, false);
});

test('preClear empties the claim and moves the player out before the realise', async () => {
  const r = rig({ x: 130, y: 100, z: 230 });
  await r.clearer.preClear(claim, 'before r5');
  assert.ok(r.cmds[0].startsWith('/kill @e[type=!minecraft:player'));
  assert.ok(r.cmds.some((c) => c.startsWith('/tp @p ')));
});

test('spawnOff turns natural spawning off on a pre-clear, only when the caller owns the world', async () => {
  const cmds = [];
  const mk = (spawnOff) => createClearer({ cmd: async (c) => { cmds.push(c); return { messages: [] }; }, spawnOff });
  await mk(false).preClear(claim);
  assert.ok(!cmds.some((c) => c.includes('gamerule')));
  await mk(true).preClear(claim);
  assert.ok(cmds.includes('/gamerule spawn_mobs false'));
});

test('an unreadable claim on PLAYER_IN_BOX still moves the player (48 up)', async () => {
  const r = rig();
  await r.clearer.onState({ view: { id: 'r6', waiting: { reason: 'PLAYER_IN_BOX' } } });
  assert.deepEqual(r.cmds, ['/tp @p ~ ~48 ~']);
});

test('the watcher clears waiting regions from a list, skips a failed tick and re-arms on a new client', async () => {
  const r = rig();
  let views = [{ id: 'a', claim, waiting: { reason: 'OCCUPIED' } }, { id: 'b', claim, waiting: { reason: 'NOT_LOADED' } }, { id: 'c', claim }];
  let client = { n: 1 };
  let down = false;
  const logs = [];
  const w = createWatcher({ list: async () => { if (down) throw new Error('closed'); return views; }, clearer: r.clearer, log: (m) => logs.push(m), identity: () => client });
  await w.tick();
  assert.equal(r.clearer.stats.byReason.OCCUPIED, 1);
  assert.equal(r.clearer.stats.clears, 1, 'only the OCCUPIED region');
  down = true; // the game restarting
  await w.tick();
  down = false;
  client = { n: 2 }; // a new client after the restart
  r.tick(10_000);
  await w.tick();
  assert.equal(w.rearmed, 1);
  assert.ok(logs.some((l) => /re-armed/.test(l)));
  assert.equal(r.clearer.stats.byReason.OCCUPIED, 2, 'it acts again on the new client');
  w.start();
  assert.equal(w.running, true);
  w.stop();
  assert.equal(w.running, false);
});
