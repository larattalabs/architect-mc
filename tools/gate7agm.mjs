#!/usr/bin/env node
// Phase 7a slice GM gate (docs/CONTRACT.md "Slice GM, gate mechanisms" §10) against the headless server of the GM run worktree
// (`../architect-mc-GM-run`, a detached worktree at this checkout's HEAD; the stub sidecar, no Claude). Ports 8896 (sidecar) / 8897
// (DevBridge) by default (the runner sets its own). $0: no Claude call anywhere.
//
//   node tools/gate7agm.mjs <step>
//     start [world] | stop | base      the headless server and the flat base world
//     rules     (gm-probe)              §1's vanilla rules on the running 26.3 server: stroke 1, push 12, sticky pull 1, a retracted base moves
//                                       and an extended one does not, immovable blocks, a door destroyed by a piston, iron door and trapdoor
//                                       redstone-only, fence collision 1.5, wire on a piston, quasi-connectivity
//     extender  (gm-probe)              the lifting grid: the in-contract column (separate bars, sticky pistons above, no slime) stroked to the
//                                       end of the winch room, recorded cell by cell; the bar is a whole grid raised and lowered
//     outside   (recorded, never judged) designs outside the contract, measured so the coordinator and Noah can decide: the slime-row grid
//     probe                              rules + extender + outside
//     fit       (gm-fit, step 1b)       gateLayout in real gatehouse boxes (GM_FIT_BOXES, default 13x7x10,13x11x11,17x15x12; GM_FIT_KINDS):
//                                       the 13 §2a steps, 20 lever cycles, the latch windows' tick traces and slack (§14 item 3), a
//                                       natural dusk and dawn and a daytime storm (one edge each, no flicker), no item dropped
//     unit      (gm-unit, GM-a)         item 1 offline: kit/test/gm-a.test.mjs and gm.test.mjs, K3's wall tests, the structure lint, the Java
//                                       (GateMechTest, ApiGMTest, PlanChecksK3Test, ApiK3Test, LotMaskTest), api-compat
//     unchanged (gm-unit)               item 2: every committed plan fixture as on the merge base (no recorded wall names a mechanism)
//     ingame    (gm-ingame)             item 3 (headless): the castle with a 17x15 portcullis gatehouse (the sensor at roof 12), a 13x7 one
//                                       (roof 10), a 13x7 one roofed at 16 (levers-only, mechanism.sensor), a slide (13x11), the [11, 13]
//                                       plain passage (deviation mechanism) and a swing: realiseApproved, the rung or no sensor, 40 ticks
//                                       still, real lever uses (traced), closed blocks the villager and the player, open passes them,
//                                       20 cycles, the day cycle, no item dropped, removal E-flat 0; the swing's button, lever and plate
//     undo      (gm-ingame, item 4)     Regions.remove open, closed and mid-move (2 ticks into a toggle): E-flat 0 each (the verifier
//                                       re-runs it)
//     look      (gm-look, client)       item 8: the gallery per kind and bible (open, closed, the passage inside, the lever, the toggle
//                                       strip, dusk and the sensor)
//     areport                           REPORT-GM-a.md over the GM-a step JSONs
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7a-gm/<step>.json in the main checkout (GATE7AGM_OUT overrides), all.log, REPORT.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-GM-run');
process.env.GATE6B_OUT = process.env.GATE7AGM_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7a-gm');
process.env.GATE6B_SIDECAR_PORT ??= '8896';
process.env.GATE6B_DEV_PORT ??= '8897';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, log, results, root, state, tp } = L;
const { gameTime } = await import('./lib/sprint.mjs');

L.refuseKeys();
const FLAT = 'G6B Flat Base';
const WORLD = 'G6B GM Probe';
const { decodeArwd } = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'region', 'vworld.mjs')).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const steps = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensure = async () => { if (!state.dev) await connect(); };

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
  if (!['start', 'stop'].includes(name)) L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}

// ------------------------------------------------------------------ in game helpers

const sb = (x, y, z, s) => cmd(`/setblock ${x} ${y} ${z} ${s}`);
const fill = (a, b, s) => cmd(`/fill ${a.join(' ')} ${b.join(' ')} ${s}`);
/** The box's block states, {"x,y,z": state}, without air. */
async function snap(x0, y0, z0, x1, y1, z1) {
  const f = path.join(OUT, 'snap.arwd.gz');
  await call('dev.region.dump', { box: [x0, y0, z0, x1, y1, z1], file: f }, 60_000);
  const d = await decodeArwd(fs.readFileSync(f));
  const o = {};
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const s = d.palette[d.cells[d.at(x, y, z)]];
    if (s !== 'minecraft:air') o[`${x},${y},${z}`] = s.replace('minecraft:', '');
  }
  return o;
}
const stateAt = async (x, y, z) => (await snap(x, y, z, x, y, z))[`${x},${y},${z}`] ?? 'air';
const freeze = () => cmd('/tick freeze');
const unfreeze = () => cmd('/tick unfreeze');
/** Exactly n game ticks under /tick freeze. */
async function step(n = 1) {
  const t0 = await gameTime(cmd);
  await cmd(`/tick step ${n}`);
  for (let i = 0; i < 400; i++) {
    const t = await gameTime(cmd);
    if (t !== null && t0 !== null && t - t0 >= n) return;
    await sleep(25);
  }
  throw new Error(`/tick step ${n} did not advance`);
}
const items = (x, y, z, radius = 12) => call('dev.items.near', { pos: [x, y, z], radius }, 20_000);
const use = (at) => call('dev.pt.uses', { ops: [{ item: 'minecraft:stick', at, on: at, face: 'up' }] }, 30_000);

async function ground(X, Z) {
  const c = await snap(X, -70, Z, X, 100, Z);
  return Math.max(...Object.keys(c).map((k) => Number(k.split(',')[1])));
}
/** A clean probe world, the rules exact, the bot near the site. */
async function world(X, Z) {
  await L.leaveWorld(); // (before ensureBase: an unstamped base is moved aside, and the start may have it open)
  await L.ensureBase(FLAT);
  await L.fresh(WORLD, FLAT);
  await L.setRules('exact');
  await tp(X + 30, 60, Z + 30);
  return ground(X, Z);
}

// ------------------------------------------------------------------ §1's rules

steps.rules = async () => {
  await ensure();
  const X = 7000, Z = 7000, out = {};
  const g = await world(X, Z), y = g + 3;
  out.ground = g;
  await tp(X + 60, g + 12, Z + 20);
  const P = 'minecraft:sticky_piston', R = 'minecraft:piston';
  const row = async (x, z) => { const o = await snap(x - 1, y, z, x + 16, y, z); return Object.entries(o).map(([k, v]) => [Number(k.split(',')[0]) - x, v]); };
  const settle = () => L.gameWait(600, { real: L.settle, label: 'gm rule settles' });

  // stroke 1, sticky back
  await sb(X, y, Z, `${P}[facing=east]`); await sb(X + 1, y, Z, 'minecraft:stone');
  await sb(X - 1, y, Z, 'minecraft:redstone_block'); await settle();
  const ext = await row(X, Z);
  await sb(X - 1, y, Z, 'minecraft:air'); await settle();
  const ret = await row(X, Z);
  out.stroke = { ext, ret };
  check(ext.some(([d, s]) => d === 2 && s === 'stone') && !ext.some(([d, s]) => d > 2 && s === 'stone') && ret.some(([d, s]) => d === 1 && s === 'stone'), `rule: one stroke moves a block 1 cell and the sticky piston pulls it back (extended ${json(ext)}; retracted ${json(ret)})`);

  // push 12, not 13
  for (const [n, z] of [[12, Z + 4], [13, Z + 8]]) {
    await sb(X, y, z, `${R}[facing=east]`);
    await fill([X + 1, y, z], [X + n, y, z], 'minecraft:stone');
    await sb(X - 1, y, z, 'minecraft:redstone_block'); await settle();
    out[`push${n}`] = await stateAt(X, y, z);
  }
  check(/extended=true/.test(out.push12) && /extended=false/.test(out.push13), `rule: a piston pushes 12 and refuses 13 (${out.push12}; ${out.push13})`);

  // sticky pull 1: three separate bars under a downward sticky piston; pushed down one cell, then retracted
  const VX = X + 30, T = y + 8;
  await sb(VX, T, Z, `${P}[facing=down]`);
  await fill([VX, T - 3, Z], [VX, T - 1, Z], 'minecraft:iron_bars');
  await sb(VX + 1, T, Z, 'minecraft:redstone_block'); await settle();
  const col = async () => Object.entries(await snap(VX, T - 6, Z, VX, T, Z)).map(([k, v]) => [Number(k.split(',')[1]) - T, v.split('[')[0]]);
  const pushed = await col();
  await sb(VX + 1, T, Z, 'minecraft:air'); await settle();
  const pulled = await col();
  out.pull = { pushed, pulled };
  const barsAt = (c) => c.filter(([, s]) => s === 'iron_bars').map(([d]) => d).sort((a, b) => a - b);
  check(json(barsAt(pushed)) === '[-4,-3,-2]' && json(barsAt(pulled)) === '[-4,-3,-1]', `rule: a sticky piston pushes the 3 bars down one and pulls back ONE (bars at ${json(barsAt(pushed))} then ${json(barsAt(pulled))}, offsets from the piston)`);

  // a retracted base moves, an extended one does not
  await sb(X, y, Z + 12, `${R}[facing=east]`); await sb(X + 1, y, Z + 12, `${R}[facing=east]`);
  await sb(X - 1, y, Z + 12, 'minecraft:redstone_block'); await settle();
  const moved = await row(X, Z + 12);
  await sb(X, y, Z + 15, `${R}[facing=east]`); await sb(X + 1, y, Z + 15, `${R}[facing=east]`);
  await sb(X + 1, y + 1, Z + 15, 'minecraft:redstone_block'); await settle();
  await sb(X - 1, y, Z + 15, 'minecraft:redstone_block'); await settle();
  const held = await row(X, Z + 15);
  out.bases = { moved, held };
  check(moved.some(([d, s]) => d === 2 && /^piston\[/.test(s)) && held.some(([d, s]) => d === 0 && /extended=false/.test(s)), `rule: a retracted base moves, an extended one does not (${json(moved)}; ${json(held)})`);

  // immovable: obsidian, a chest
  for (const [b, z] of [['minecraft:obsidian', Z + 18], ['minecraft:chest', Z + 21]]) {
    await sb(X, y, z, `${R}[facing=east]`); await sb(X + 1, y, z, b);
    await sb(X - 1, y, z, 'minecraft:redstone_block'); await settle();
    out[b] = await stateAt(X, y, z);
    check(/extended=false/.test(out[b]), `rule: ${b} does not move (${out[b]})`);
  }

  // a door is destroyed
  const DX = X + 40;
  await sb(DX, y, Z, `${R}[facing=east]`); await sb(DX + 1, y - 1, Z, 'minecraft:stone');
  await sb(DX + 1, y, Z, 'minecraft:oak_door[half=lower,facing=east]'); await sb(DX + 1, y + 1, Z, 'minecraft:oak_door[half=upper,facing=east]');
  await sb(DX - 1, y, Z, 'minecraft:redstone_block'); await settle();
  out.door = { cell: await stateAt(DX + 1, y, Z), items: await items(DX + 1, y, Z, 6) };
  check(!/door/.test(out.door.cell), `rule: a door is destroyed by a piston (cell ${out.door.cell}, items ${json(out.door.items)})`);

  // iron door and trapdoor: a hand does nothing, redstone does
  const IX = X + 50;
  await sb(IX, y - 1, Z, 'minecraft:stone');
  await sb(IX, y, Z, 'minecraft:iron_door[half=lower,facing=east]'); await sb(IX, y + 1, Z, 'minecraft:iron_door[half=upper,facing=east]');
  await sb(IX, y, Z + 3, 'minecraft:iron_trapdoor[facing=east]');
  const u1 = await use([IX, y, Z]), u2 = await use([IX, y, Z + 3]); await settle();
  const hand = [await stateAt(IX, y, Z), await stateAt(IX, y, Z + 3)];
  await sb(IX - 1, y, Z, 'minecraft:redstone_block'); await sb(IX - 1, y, Z + 3, 'minecraft:redstone_block'); await settle();
  const pow = [await stateAt(IX, y, Z), await stateAt(IX, y, Z + 3)];
  out.iron = { u1, u2, hand, pow };
  check(hand.every((s) => /open=false/.test(s)) && pow.every((s) => /open=true/.test(s)), `rule: iron door and trapdoor open by redstone only (hand ${json(hand)}; powered ${json(pow)})`);

  // fence collision: an armor stand falls onto a fence
  const FX = X + 56;
  await sb(FX, y, Z, 'minecraft:oak_fence');
  await cmd(`/summon minecraft:armor_stand ${FX + 0.5} ${y + 3} ${Z + 0.5} {Tags:["gmf"]}`);
  await L.gameWait(3000, { real: L.settle, label: 'gm the stand falls' });
  const pos = await cmd(`/data get entity @e[tag=gmf,limit=1] Pos[1]`);
  const top = Number(/(-?\d+\.?\d*)d?\s*$/.exec((pos.messages ?? []).join(' ').trim())?.[1]);
  out.fence = { messages: pos.messages, top: top - y };
  check(Math.abs(top - y - 1.5) < 1e-6, `rule: a fence collides at 1.5 (an armor stand rests ${top - y} over its base)`);

  // wire on a piston, wire on a sleeper over a piston, quasi-connectivity
  const WX = X + 62;
  await sb(WX, y, Z, `${R}[facing=east]`); await sb(WX, y + 1, Z, 'minecraft:redstone_wire');
  await sb(WX, y + 1, Z - 1, 'minecraft:stone'); await sb(WX, y, Z - 1, 'minecraft:stone');
  await sb(WX, y + 1, Z - 1, 'minecraft:redstone_torch'); await settle();
  out.wireOn = await stateAt(WX, y, Z);
  await sb(WX, y, Z + 4, `${R}[facing=east]`); await sb(WX, y + 1, Z + 4, 'minecraft:stone'); await sb(WX, y + 2, Z + 4, 'minecraft:redstone_wire');
  await sb(WX, y + 2, Z + 3, 'minecraft:redstone_block'); await settle();
  out.wireSleeper = await stateAt(WX, y, Z + 4);
  await sb(WX, y, Z + 8, `${R}[facing=east]`); await sb(WX - 1, y + 1, Z + 8, 'minecraft:redstone_block'); await settle();
  const qcQuiet = await stateAt(WX, y, Z + 8);
  await sb(WX, y - 1, Z + 8, 'minecraft:stone'); await settle();
  const qcUpdated = await stateAt(WX, y, Z + 8);
  out.qc = { qcQuiet, qcUpdated };
  check(/extended=true/.test(out.wireOn), `rule: wire on a piston powers it (${out.wireOn})`);
  check(/extended=true/.test(out.wireSleeper), `rule: wire on a solid sleeper over a piston powers it (${out.wireSleeper})`);
  check(/extended=true/.test(qcUpdated), `rule: quasi-connectivity holds: power diagonal-above a piston fires it, on the next neighbour update (placed: ${qcQuiet}; after an update: ${qcUpdated})`);
  await L.leaveWorld();
  return out;
};

// ------------------------------------------------------------------ the lifting grid

/**
 * An inchworm of three downward sticky pistons A, B, C over a grid (the only way sticky pistons reel anything in by more than one cell):
 * A's retract pulls the head block 1; B's retract pulls A up 1; A re-extends to the block; C's retract pulls B up 1; and so on. F = floorY.
 * Closed: A at F+4 (head in the slot, F+3), B at F+6 (head F+5), C at F+8 (head F+7), all extended, each powered from the plane d=2.
 * The grid: `glue` makes the middle column slime. Rows above lintelY+4 (= F+7) leave the contract's envelope: C's base stands at F+8.
 */
async function liftRig(x, z, F, { glue }) {
  await fill([x - 1, F, z], [x + 1, F + 2, z], 'minecraft:iron_bars');
  if (glue) await sb(x, F - 1, z, 'minecraft:obsidian'); // (else the slime lifts the floor cell under it: measured, 2026-11-01)
  if (glue) await fill([x, F, z], [x, F + 2, z], 'minecraft:slime_block'); // (a slime only grabs when it is the one moved: the head must touch slime)
  const P = 'minecraft:sticky_piston';
  // written retracted and clear of the grid, then extended by power, so that nothing is pushed
  for (const y of [F + 4, F + 6, F + 8]) await sb(x, y, z, `${P}[facing=down]`);
  const rig = { x, z, F, power: new Set() };
  for (const y of [F + 8, F + 6, F + 4]) await setPower(rig, y, true);
  await L.gameWait(500, { real: L.settle, label: 'gm rig extends' });
  return rig;
}
async function setPower(rig, y, on) {
  await sb(rig.x, y, rig.z + 1, on ? 'minecraft:redstone_block' : 'minecraft:air');
  if (on) rig.power.add(y); else rig.power.delete(y);
}
const ACT = 3; // ticks a stroke needs (the piston's 2 ticks and one to land)
/** Grid bars by row, the rig's pistons, the movers left. */
async function readRig(rig) {
  const { x, z, F } = rig;
  const s = await snap(x - 1, F, z, x + 1, F + 9, z);
  const byRow = {};
  for (const [k, v] of Object.entries(s)) {
    const r = Number(k.split(',')[1]) - F;
    (byRow[r] ??= []).push(v.split('[')[0]);
  }
  return byRow;
}
const raiseSeq = (F) => [['A off', F + 4, false], ['B off', F + 6, false], ['A on', F + 5, true], ['A off', F + 5, false], ['C off', F + 8, false], ['B on', F + 7, true], ['B off', F + 7, false], ['A on', F + 6, true], ['A off', F + 6, false]];
async function raise(rig) {
  let ticks = 0;
  for (const [, y, on] of raiseSeq(rig.F)) { await setPower(rig, y, on); await step(ACT); ticks += ACT; }
  return ticks;
}
/**
 * Lowering. A sticky piston pulsed for less than its stroke lets go of its block (it "spits" it), so A's strokes down leave the grid where
 * they pushed it; C then B push the retracted A down after it; A's last stroke stays extended (closed rests powered).
 */
async function lower(rig) {
  const { F } = rig;
  let ticks = 0;
  const pulse = async (y) => { await setPower(rig, y, true); await step(1); await setPower(rig, y, false); await step(ACT); ticks += 1 + ACT; };
  const hold = async (y) => { await setPower(rig, y, true); await step(ACT); ticks += ACT; };
  await pulse(F + 6); // A at F+6 spits the grid down 1
  await hold(F + 8); // C pushes B and A down 1
  await pulse(F + 5); // A at F+5 spits the grid down 1
  await hold(F + 6); // B pushes A down 1
  await hold(F + 4); // A at F+4: the last stroke, held
  return ticks;
}

steps.extender = async () => {
  await ensure();
  const X = 7100, Z = 7000, out = {};
  const g = await world(X, Z), F = g + 1;
  await tp(X + 12, F + 4, Z + 14);
  await freeze();
  await unfreeze();
  const rig = await liftRig(X, Z, F, { glue: false });
  out.closed = await readRig(rig);
  await freeze();
  out.trace = [];
  for (const [what, y, on] of raiseSeq(F)) {
    await setPower(rig, y, on); await step(ACT);
    const r = await readRig(rig);
    out.trace.push({ what, rows: r });
  }
  await unfreeze();
  out.end = await readRig(rig);
  const barRows = Object.entries(out.end).filter(([, v]) => v.includes('iron_bars')).map(([r]) => Number(r));
  out.barRows = barRows;
  log(`  the in-contract column after the full inchworm: bars in rows ${json(barRows)}; ${json(out.end)}`);
  check(barRows.length === 3 && Math.min(...barRows) === 3, `extender: separate bars lift with sticky pistons from above (no slime): after the full 3-piston inchworm the bars stand in rows ${json(barRows)} over floorY (the bar: rows 3,4,5); the two lower bars cannot be reached past the first`, out.end);
  await L.leaveWorld();
  return out;
};

/** Outside the contract, recorded: a slime column down the middle of the grid glues it into one body that one chain of sticky pistons can reel in. */
async function outsideRun(X, Z, F, { walled }) {
  const out = { walled, cycles: [] };
  // walled: the gatehouse round the slot: the lintel beam (row 3) on both faces and the wall on the front face, rows 3-8
  if (walled) { await fill([X - 1, F + 3, Z - 1], [X + 1, F + 8, Z - 1], 'minecraft:stone'); await fill([X - 1, F + 3, Z + 1], [X + 1, F + 3, Z + 1], 'minecraft:stone'); }
  const rig = await liftRig(X, Z, F, { glue: true });
  const box = () => snap(X - 1, F, Z - 1, X + 1, F + 9, Z + 1);
  await freeze();
  await step(3);
  const closed0 = await box();
  let raised0 = null, bad = 0;
  out.raiseTicks = out.lowerTicks = 0;
  for (let c = 1; c <= 20; c++) {
    const rt = await raise(rig);
    await step(4);
    const up = await box();
    raised0 ??= up;
    const lt = await lower(rig);
    await step(4);
    const down = await box();
    const it = await items(X, F + 2, Z, 12);
    const rowsOf = (st) => Object.entries(st).filter(([k, v]) => /iron_bars|slime/.test(v) && Number(k.split(',')[2]) === Z).map(([k]) => Number(k.split(',')[1]) - F);
    const ok = Math.min(...rowsOf(up)) === 3 && Math.max(...rowsOf(up)) === 5 && rowsOf(up).length === 9 && Math.max(...rowsOf(down)) === 2 && rowsOf(down).length === 9 && json(up) === json(raised0) && json(down) === json(closed0) && !Object.values({ ...up, ...down }).some((v) => /moving_piston/.test(v)) && !it.stacks;
    out.raiseTicks = rt; out.lowerTicks = lt;
    out.cycles.push({ c, ok, items: it.stacks });
    if (!ok) { bad++; out.firstBad ??= { c, up, down, closed0, raised0, items: it.items }; break; }
  }
  await unfreeze();
  out.raised = raised0;
  out.closed = closed0;
  log(`  OUTSIDE THE CONTRACT slime column, 3 pistons, C at F+8, ${walled ? 'walled' : 'open air'}: ${out.cycles.length} cycles, ${bad} bad; raise ${out.raiseTicks} ticks, lower ${out.lowerTicks}`);
  log(`  rec  ${json(out.firstBad ?? { closed: closed0, raised: raised0 }).slice(0, 1500)}`);
  return out;
}
steps.outside = async () => {
  await ensure();
  const X = 7200, Z = 7000;
  const g = await world(X, Z), F = g + 1;
  await tp(X + 12, F + 4, Z + 14);
  const open = await outsideRun(X, Z, F, { walled: false });
  const walled = await outsideRun(X + 20, Z, F, { walled: true });
  await L.leaveWorld();
  return { open, walled };
};

// ------------------------------------------------------------------ §12: the sliding gates, wired

const GMC = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'connectors', 'gmCircuit.mjs')).href);
const W_ = 'minecraft:';

/** A gatehouse box of `wall` (u -5..5, d 0..2, rows -1..8), its passage cleared (u -1..1, rows 0..2), then `cells` written in order. */
async function gatehouse(X, F, Z, wall, cells) {
  await fill([X - 5, F - 1, Z], [X + 5, F + 8, Z + 2], wall);
  await fill([X - 1, F, Z - 1], [X + 1, F + 2, Z + 3], `${W_}air`);
  // the write order of §7 item 2: structure, pistons, the rest, then wire and triggers
  const rank = (s) => (/wire|repeater|comparator|observer|torch|lever|button|plate|daylight/.test(s) ? 3 : /piston/.test(s) ? 1 : /air/.test(s) ? 0 : /bars|fence/.test(s) ? 2 : 0);
  for (const c of [...cells].sort((a, b) => rank(a[3]) - rank(b[3]))) { const [x, y, z, st] = GMC.toWorld(c, X, F, Z); await sb(x, y, z, st); }
}
const gateBox = (X, F, Z) => snap(X - 5, F - 1, Z, X + 5, F + 8, Z + 2);
const ABBR = [[/^redstone_wire.*power=(\d+).*/, (m) => `w${m[1]}`], [/^sticky_piston\[extended=true.*/, () => 'P+'], [/^sticky_piston.*/, () => 'P-'], [/^piston_head.*/, () => 'hd'], [/^moving_piston.*/, () => 'MV'],
  [/^iron_bars.*/, () => '##'], [/^spruce_fence.*/, () => 'ff'], [/^stone_bricks/, () => 'sb'], [/^polished_andesite/, () => 'pa'], [/^stone$/, () => '..'], [/^observer.*powered=true.*/, () => 'O!'], [/^observer.*/, () => 'Ob'],
  [/^repeater.*powered=true.*/, () => 'R!'], [/^repeater.*/, () => 'Rp'], [/^comparator.*powered=true.*/, () => 'C!'], [/^comparator.*/, () => 'Cp'], [/^redstone_(wall_)?torch.*lit=true.*/, () => 'T!'], [/^redstone_(wall_)?torch.*/, () => 'To'],
  [/^lever.*powered=true.*/, () => 'L!'], [/^lever.*/, () => 'Lv'], [/^iron_trapdoor.*open=true.*/, () => 't!'], [/^iron_trapdoor.*/, () => 'tr'], [/^daylight.*/, () => 'DS'], [/.*slab.*/, () => 'sl']];
const abbr = (v) => { if (!v) return '  '; for (const [re, f] of ABBR) { const m = re.exec(v); if (m) return f(m); } return v.slice(0, 2); };
/** The box drawn plane by plane (rows top down, u -5..5). */
function draw(box, X, F, Z, planes = [1, 2]) {
  const lines = [];
  for (const d of planes) {
    lines.push(`d=${d}`);
    for (let r = 8; r >= -1; r--) { let l = `${String(r).padStart(2)} `; for (let u = -5; u <= 5; u++) l += abbr(box[`${X + u},${F + r},${Z + d}`]) + ' '; lines.push(l); }
  }
  return lines.join('\n');
}
/** The leaf columns: for each side the u where its three blocks stand (or 'mixed'). */
function leaves(box, X, F, Z, leaf) {
  leaf = leaf.replace('minecraft:', '');
  const o = {};
  for (const s of [-1, 1]) {
    const at = [];
    for (let r = 0; r <= 2; r++) {
      const us = [s, 2 * s].filter((u) => (box[`${X + u},${F + r},${Z + 1}`] ?? '').startsWith(leaf));
      at.push(us.length === 1 ? Math.abs(us[0]) : 'x');
    }
    o[s] = at.every((v) => v === at[0]) ? at[0] : `mixed ${at}`;
  }
  return o;
}
const flip = (at) => call('dev.pt.uses', { ops: [{ item: 'minecraft:stick', at, on: at, face: 'up' }] }, 30_000);

/** E2: the split grate's mechanism and its G feed in a stone gatehouse, G from a test lever on the bus (the logic comes next). */
steps.grate = async () => {
  await ensure();
  const out = {};
  const X = 7300, Z = 7000;
  const g = await world(X, Z), F = g + 1;
  await tp(X, F + 4, Z + 12);
  for (const [name, kind, wall, mats, ox] of [['stone bars', 'portcullis', `${W_}stone`, {}, 0], ['stone slide', 'slide', `${W_}stone`, {}, 20], ['fortress fence', 'portcullis', `${W_}stone_bricks`, { structure: `${W_}polished_andesite`, bar: `${W_}spruce_fence` }, 40]]) {
    const x0 = X + ox;
    const cells = [...GMC.slideCells(kind, mats).values()];
    // the test driver: a bus row 5 in d = 2 from u -3..3, on blocks, a lever on top of its middle block
    for (let u = -2; u <= 2; u++) { cells.push([u, 2, 4, gmMatsOf(mats).structure]); if (u) cells.push([u, 2, 5, `${W_}redstone_wire`]); }
    cells.push([0, 2, 5, gmMatsOf(mats).structure], [0, 2, 6, `${W_}lever[face=floor,facing=north,powered=false]`]);
    await gatehouse(x0, F, Z, wall, cells);
    await L.gameWait(2000, { real: L.settle, label: 'gm grate settles' });
    const leaf = kind === 'slide' ? gmMatsOf(mats).structure : gmMatsOf(mats).bar;
    const rest = await gateBox(x0, F, Z);
    const lev = [x0, F + 6, Z + 2];
    const rec = { cycles: [], restLeaves: leaves(rest, x0, F, Z, leaf) };
    let bad = 0;
    for (let c = 1; c <= 20; c++) {
      await flip(lev); await L.gameWait(1000, { real: L.settle, label: 'gm close' });
      const closed = await gateBox(x0, F, Z);
      await flip(lev); await L.gameWait(1000, { real: L.settle, label: 'gm open' });
      const open = await gateBox(x0, F, Z);
      const lc = leaves(closed, x0, F, Z, leaf), lo = leaves(open, x0, F, Z, leaf);
      const it = await items(x0, F + 2, Z + 1, 10);
      const ok = lc[-1] === 1 && lc[1] === 1 && lo[-1] === 2 && lo[1] === 2 && json(open) === json(rest) && !it.stacks;
      rec.cycles.push({ c, closed: lc, open: lo, items: it.stacks, same: json(open) === json(rest) });
      if (!ok) { bad++; rec.firstBad = { c, lc, lo, closed, open, rest }; log(`rest\n${draw(rest, x0, F, Z)}\nclosed\n${draw(closed, x0, F, Z)}\nopen\n${draw(open, x0, F, Z)}`); break; }
    }
    rec.bad = bad;
    // timing: ticks from the bus lever to the leaves settled closed, and open
    await freeze();
    await flip(lev); let tc = null; for (let t = 1; t <= 20 && tc === null; t++) { await step(1); const lc = leaves(await gateBox(x0, F, Z), x0, F, Z, leaf); if (lc[-1] === 1 && lc[1] === 1) tc = t; }
    await flip(lev); let to = null; for (let t = 1; t <= 20 && to === null; t++) { await step(1); const lo = leaves(await gateBox(x0, F, Z), x0, F, Z, leaf); if (lo[-1] === 2 && lo[1] === 2) to = t; }
    await unfreeze();
    rec.ticks = { close: tc, open: to };
    log(`  grate ${name}: G on the bus to the leaves closed ${tc} ticks, open ${to} ticks`);
    out[name] = rec;
    check(bad === 0 && rec.cycles.length === 20, `grate ${name}: ${rec.cycles.length} lever cycles, ${bad} bad (rest leaves ${json(rec.restLeaves)}${rec.firstBad ? `; first bad ${json({ c: rec.firstBad.c, closed: rec.firstBad.lc, open: rec.firstBad.lo })}` : ''})`);
  }
  await L.leaveWorld();
  return out;
};
const gmMatsOf = (m) => GMC.gmMats(m);

/**
 * E3: the §2a logic in open air (layout first, compaction after): two levers each read through an iron trapdoor by an observer (a pulse
 * per flip, P); the daylight sensor (inverted: power at night) cleaned by a repeater and read by an observer (a pulse per transition, Q);
 * a torch RS-NOR latch holds G; four subtract comparators steer the pulses: SET = (P - G) or (Q - notS), RESET = (P - notG) or (Q - S).
 */
async function logicRig(x, y, z) {
  const P = (dx, dy, dz, st) => sb(x + dx, y + dy, z + dz, st.startsWith('minecraft:') ? st : `minecraft:${st}`);
  await fill([x - 2, y - 1, z - 4], [x + 14, y - 1, z + 12], 'minecraft:stone');
  await fill([x - 2, y, z - 4], [x + 14, y + 4, z + 12], 'minecraft:air');
  // the levers, trapdoors, observers: P at x+3
  await P(0, 0, 0, 'stone'); await P(1, 0, 0, 'iron_trapdoor[facing=north,half=bottom]'); await P(0, 0, 4, 'stone'); await P(1, 0, 4, 'iron_trapdoor[facing=north,half=bottom]');
  // P bus x+3, z 0..4, and its two arms
  for (const dz of [0, 1, 2, 3, 4]) await P(3, 0, dz, 'redstone_wire');
  // comparators: C1 (set by P) at (5,0,1) back (4,0,1); C2 (reset by P) at (5,0,3) back (4,0,3)
  await P(4, 0, 1, 'redstone_wire'); await P(4, 0, 3, 'redstone_wire');
  await P(5, 0, 1, 'comparator[facing=west,mode=subtract]'); await P(5, 0, 3, 'comparator[facing=west,mode=subtract]');
  // Q: the sensor at (0,0,8) (inverted), cleaned by RS, observer OS watches the S dust (3,0,8) -> Q at (3,0,9)? (OS at (3,0,9) facing north, out (3,0,10))
  await P(1, 0, 8, 'redstone_wire'); await P(2, 0, 8, 'repeater[facing=west]'); await P(3, 0, 8, 'redstone_wire');
  // S runs east at z+8: (4..6,0,8); notS = torch on block (7,0,8) -> wall torch at (8,0,8) facing east
  for (const dx of [4, 5, 6]) await P(dx, 0, 8, 'redstone_wire');
  await P(7, 0, 8, 'stone');
  // Q bus z+10: (3,0,10) .. ; comparators C3 (set by Q) at (5,0,10)? back (4,0,10), side notS; C4 (reset by Q) at (5,0,12) back (4,0,12) side S
  await P(3, 0, 10, 'redstone_wire'); await P(3, 0, 11, 'redstone_wire'); await P(3, 0, 12, 'redstone_wire'); await P(4, 0, 10, 'redstone_wire'); await P(4, 0, 12, 'redstone_wire');
  await P(5, 0, 10, 'comparator[facing=west,mode=subtract]'); await P(5, 0, 12, 'comparator[facing=west,mode=subtract]');
  // C4's side S: (5,0,11) dust fed from S? S is at z+8. Bring S down x=6: (6,0,9) .. no: use (5,0,11) dust from (5,0,9)?? keep simple: S branch (6,0,8)->(6,0,9)->(6,0,10)?
  // notS for C3's side at (5,0,9): torch output... the notS torch at (8,0,8) feeds dust (8,0,9) -> (8..5?)
  // latch: block A at (9,0,2) [RESET in], torch Ta on A at (10,0,2) facing east = G; block B at (9,0,6) [SET in], torch Tb at (10,0,6) = notG
  await P(9, 0, 2, 'stone'); await P(9, 0, 6, 'stone');
  return { x, y, z };
}

/** The swing gate in a stone gatehouse: 20 cycles each of the button (outside), the lever (inside) and the plate (the bot stands on it). */
steps.swing = async () => {
  await ensure();
  const out = {};
  const X = 7400, Z = 7000;
  const g = await world(X, Z), F = g + 1;
  await tp(X, F + 4, Z + 12);
  await gatehouse(X, F, Z, `${W_}stone`, [...GMC.swingCells({}).values()]);
  await L.gameWait(2000, { real: L.settle, label: 'gm swing settles' });
  const doors = async () => { const b = await gateBox(X, F, Z); return [-1, 1].map((u) => /open=true/.test(b[`${X + u},${F},${Z + 1}`] ?? '') ? 'open' : /open=false/.test(b[`${X + u},${F},${Z + 1}`] ?? '') ? 'shut' : 'GONE'); };
  const rest = await gateBox(X, F, Z);
  out.rest = await doors();
  const runs = {};
  // the button: pressed, open within 2 ticks... recorded; open at +10, shut at +30
  runs.button = [];
  for (let c = 1; c <= 20; c++) {
    await flip([X, F + 1, Z]);
    await L.gameWait(500, { real: L.settle, label: 'gm button held' });
    const mid = await doors();
    await L.gameWait(1500, { real: L.settle, label: 'gm button released' });
    const after = await doors();
    runs.button.push({ mid, after, ok: json(mid) === '["open","open"]' && json(after) === '["shut","shut"]' });
  }
  runs.lever = [];
  for (let c = 1; c <= 20; c++) {
    await flip([X, F + 1, Z + 2]); await L.gameWait(300, { real: L.settle, label: 'gm lever on' });
    const on = await doors();
    await flip([X, F + 1, Z + 2]); await L.gameWait(300, { real: L.settle, label: 'gm lever off' });
    const off = await doors();
    runs.lever.push({ on, off, ok: json(on) === '["open","open"]' && json(off) === '["shut","shut"]' });
  }
  runs.plate = [];
  for (let c = 1; c <= 20; c++) {
    // (the bot player does not run its own physics, so a plate never sees it: a villager steps on, as a villager inside the wall would)
    await cmd(`/summon minecraft:villager ${X - 1 + 0.5} ${F + 0.2} ${Z + 2 + 0.5} {NoAI:1b,Silent:1b,Tags:["gmp"]}`); await L.gameWait(500, { real: L.settle, label: 'gm on the plate' });
    const on = await doors();
    await cmd('/tp @e[tag=gmp] ~ ~ ~4'); await L.gameWait(100, { real: L.settle, label: 'gm off' }); await cmd('/kill @e[tag=gmp]'); await L.gameWait(1500, { real: L.settle, label: 'gm off the plate' });
    const off = await doors();
    runs.plate.push({ on, off, ok: on[0] === 'open' && json(off) === '["shut","shut"]' });
  }
  const end = await gateBox(X, F, Z);
  out.runs = runs;
  out.items = (await items(X, F + 1, Z + 1, 8)).stacks;
  for (const [k2, v] of Object.entries(runs)) check(v.length === 20 && v.every((r) => r.ok), `swing ${k2}: ${v.filter((r) => r.ok).length}/20 cycles open then shut (${json(v.find((r) => !r.ok) ?? 'all ok')})`);
  check(json(end) === json(rest) && !out.items, `swing: the box after 60 cycles equals its rest state (${json(end) === json(rest)}), ${out.items} items`);
  await L.leaveWorld();
  return out;
};

/** The drawbridge deck over a moat 5 wide and 3 deep: two levers (the near bank, the gatehouse end), 20 raise/lower cycles, the ripple timed. */
steps.drawbridge = async () => {
  await ensure();
  const out = {};
  const X = 7500, Z = 7000;
  const g = await world(X, Z), y = g; // the deck row: the banks' top block row
  await tp(X + 2, g + 8, Z + 12);
  // the moat: water y g-3..g-1 over x X..X+4, z Z-8..Z+9; the bank row above it (y g) air over the moat
  await fill([X, g - 4, Z - 8], [X + 4, g - 4, Z + 9], `${W_}stone`);
  await fill([X, g - 3, Z - 8], [X + 4, g - 1, Z + 9], `${W_}water`);
  await fill([X, g, Z - 8], [X + 4, g + 3, Z + 9], `${W_}air`);
  for (const [i, dy, z, st] of GMC.drawbridgeCells(5, {})) await sb(X + i, y + dy, Z + z, st);
  // the bank buses: x X-2 (near) and X+6 (far) at y+1 on the ground, joined to both side buses; a lever on each
  for (const bx of [X - 2, X + 6]) {
    for (let z = -3; z <= 4; z++) await sb(bx, y + 1, Z + z, `${W_}redstone_wire`);
    for (const z of [-3, 4]) await sb(bx === X - 2 ? X - 1 : X + 5, y + 1, Z + z, `${W_}redstone_wire`);
  }
  await sb(X - 3, y + 1, Z, `${W_}lever[face=floor,facing=east,powered=false]`);
  await sb(X + 7, y + 1, Z, `${W_}lever[face=floor,facing=west,powered=false]`);
  await L.gameWait(2000, { real: L.settle, label: 'gm drawbridge settles' });
  const deck = async () => { const b = await snap(X, y, Z, X + 4, y, Z + 1); return Object.values(b).filter((v) => v.startsWith('iron_trapdoor')).map((v) => (/open=true/.test(v) ? 1 : 0)); };
  const rest = await snap(X - 3, y - 4, Z - 8, X + 7, y + 2, Z + 9);
  // the ripple, ticked: each cell's first open tick after the near lever
  await freeze();
  await flip([X - 3, y + 1, Z]);
  const firstOpen = {};
  for (let t = 1; t <= 20; t++) {
    await step(1);
    const b = await snap(X, y, Z, X + 4, y, Z + 1);
    for (const [kk, v] of Object.entries(b)) if (/open=true/.test(v) && firstOpen[kk] === undefined) firstOpen[kk] = t;
  }
  await flip([X - 3, y + 1, Z]);
  const firstShut = {};
  for (let t = 1; t <= 20; t++) {
    await step(1);
    const b = await snap(X, y, Z, X + 4, y, Z + 1);
    for (const [kk, v] of Object.entries(b)) if (/open=false/.test(v) && firstShut[kk] === undefined) firstShut[kk] = t;
  }
  await unfreeze();
  out.raiseTicks = firstOpen; out.lowerTicks = firstShut;
  const byCell = (m) => [0, 1, 2, 3, 4].map((i) => [m[`${X + i},${y},${Z}`], m[`${X + i},${y},${Z + 1}`]]);
  log(`  drawbridge ripple: raise ticks per cell ${json(byCell(firstOpen))}; lower ${json(byCell(firstShut))}`);
  check(byCell(firstOpen).every(([a2, b2], i) => a2 === GMC.drawbridgeTicks(i) && b2 === a2), `drawbridge: the ripple raises cell i at 2(i+2) ticks, both rows (${json(byCell(firstOpen))})`);
  // 20 cycles, the two levers alternating
  const cyc = [];
  for (let c = 1; c <= 20; c++) {
    const lev = c % 2 ? [X - 3, y + 1, Z] : [X + 7, y + 1, Z];
    await flip(lev); await L.gameWait(1500, { real: L.settle, label: 'gm raised' });
    const up = await deck();
    await flip(lev); await L.gameWait(1500, { real: L.settle, label: 'gm lowered' });
    const down = await deck();
    cyc.push({ c, ok: up.length === 10 && up.every((v) => v === 1) && down.every((v) => v === 0) });
  }
  const end = await snap(X - 3, y - 4, Z - 8, X + 7, y + 2, Z + 9);
  out.cycles = cyc;
  check(cyc.every((r) => r.ok), `drawbridge: ${cyc.filter((r) => r.ok).length}/20 lever cycles (near and far lever alternately) raise all 10 trapdoors and lower them`);
  check(json(end) === json(rest), `drawbridge: the moat box after the cycles equals its rest state (water included)`);
  await L.leaveWorld();
  return out;
};

/**
 * The §2a day cycle, wired: the logic bench (kit/lib/connectors/gmBench.mjs: lever detectors, the inverted daylight sensor, the D latch)
 * drives a real gate in a stone gatehouse through its G line. Levers are flipped with the fake player's useItemOn; time with /time set.
 */
const GMB = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'connectors', 'gmBench.mjs')).href);
async function dayRig(X, F, Z, kind) {
  // the gate: a stone gatehouse, the leaves' feed (slideCells) and the G line in d = 2, row 5 (u -2..4) entering from the east wall
  const cells = [...GMC.slideCells(kind, {}).values()];
  for (let u = -2; u <= 5; u++) cells.push([u, 2, 4, `${W_}stone`]);
  for (let u = -2; u <= 5; u++) cells.push([u, 2, 5, u === 0 || u === 4 ? `${W_}repeater[facing=east,delay=1]` : `${W_}redstone_wire`]);
  await gatehouse(X, F, Z, `${W_}stone`, cells);
  // the bench: floor at F+4 east of the box, components at F+5; local (x, z) -> world (X+9+x, Z-4+z)
  const BX = X + 9, BY = F + 5, BZ = Z - 4;
  await fill([X + 6, F + 4, Z - 18], [X + 58, F + 4, Z + 4], `${W_}stone`);
  await fill([X + 6, F + 5, Z - 18], [X + 58, F + 9, Z + 4], `${W_}air`);
  const rank = (st) => (/lever|daylight/.test(st) ? 4 : /observer/.test(st) ? 3 : /wire|repeater|comparator|torch/.test(st) ? 2 : /trapdoor/.test(st) ? 1 : 0);
  for (const c of [...GMB.benchCells()].sort((a, b) => rank(a.state) - rank(b.state))) await sb(BX + c.x, BY + c.y, BZ + c.z, c.state);
  const at = ([x, y, z]) => [BX + x, BY + y, BZ + z];
  return { lever: { A: at(GMB.BENCH.leverA), B: at(GMB.BENCH.leverB) }, rg: at(GMB.BENCH.rg), leaf: kind === 'slide' ? 'stone_bricks' : 'iron_bars' };
}
async function gateState(X, F, Z, leaf, rg) {
  const box = await gateBox(X, F, Z);
  const l = leaves(box, X, F, Z, leaf);
  const g = /powered=true/.test(await stateAt(...rg));
  return { closed: l[-1] === 1 && l[1] === 1, open: l[-1] === 2 && l[1] === 2, leaves: l, G: g };
}
steps.daycycle = async () => {
  await ensure();
  const out = {};
  for (const [kind, X] of [['portcullis', 7600], ['slide', 7700]]) {
    const Z = 7000;
    const g = await world(X, Z), F = g + 1;
    await tp(X + 20, F + 12, Z + 14);
    await cmd('/time set 6000');
    const rig = await dayRig(X, F, Z, kind);
    await L.gameWait(3000, { real: L.settle, label: 'gm day rig settles' });
    const st = () => gateState(X, F, Z, rig.leaf, rig.rg);
    const rec = { kind, steps: [] };
    const note = async (what, want) => { const s2 = await st(); const ok = want === 'closed' ? s2.closed && s2.G : s2.open && !s2.G; rec.steps.push({ what, want, ok, ...s2 }); log(`  ${kind} ${what}: ${ok ? 'ok' : 'WRONG'} want ${want} got ${json(s2)}`); return ok; };
    const flipW = async (lv) => { await flip(rig.lever[lv]); await L.gameWait(1500, { real: L.settle, label: 'gm flip' }); };
    const timeW = async (t) => { await cmd(`/time set ${t}`); await L.gameWait(3000, { real: L.settle, label: 'gm sensor ticks' }); };
    await note('rest at day', 'open');
    await flipW('A'); await note('day, lever A (outside) -> override closed', 'closed');
    await flipW('A'); await note('day, lever A again -> open', 'open');
    await flipW('B'); await note('day, lever B (inside) -> closed', 'closed');
    await flipW('A'); await note('day, lever A -> open (either lever toggles)', 'open');
    await timeW(14000); await note('dusk, no override -> closed', 'closed');
    await timeW(1000); await note('dawn -> open', 'open');
    await flipW('B'); await note('day, lever B -> override closed', 'closed');
    await timeW(14000); await note('dusk with a closed override -> closed (the sensor takes over)', 'closed');
    await flipW('A'); await note('night, lever A -> override open', 'open');
    await timeW(1000); await note('dawn with an open override -> open (override cleared)', 'open');
    await flipW('A'); await note('day after the reset, lever A -> closed (a fresh override)', 'closed');
    await flipW('B'); await note('day, lever B -> open', 'open');
    // 20 lever cycles through the logic, the levers alternating, with the leaves checked each time
    let bad = 0;
    for (let c = 1; c <= 20; c++) {
      await flipW(c % 2 ? 'A' : 'B'); const a2 = await st();
      await flipW(c % 2 ? 'B' : 'A'); const b2 = await st();
      if (!(a2.closed && b2.open)) { bad++; rec.firstBad ??= { c, a2, b2 }; }
    }
    rec.cycles = { n: 20, bad };
    // timing: ticks from a lever flip until the leaves stand closed, and open again
    await freeze();
    await flip(rig.lever.A); let tc = null;
    for (let t = 1; t <= 40 && tc === null; t++) { await step(1); if ((await st()).closed) tc = t; }
    await flip(rig.lever.A); let to = null;
    for (let t = 1; t <= 40 && to === null; t++) { await step(1); if ((await st()).open) to = t; }
    await unfreeze();
    rec.ticks = { close: tc, open: to };
    rec.items = (await items(X, F + 2, Z + 1, 10)).stacks;
    out[kind] = rec;
    check(rec.steps.every((s2) => s2.ok), `${kind} day cycle (§2a): ${rec.steps.filter((s2) => s2.ok).length}/${rec.steps.length} steps (sensor edges both ways, either lever overrides, the override cleared at the next transition)`);
    check(bad === 0, `${kind}: 20 lever cycles through the logic, ${bad} with a misplaced leaf${rec.firstBad ? ` (${json(rec.firstBad)})` : ''}`);
    check(tc !== null && to !== null && !rec.items, `${kind}: a flip closes in ${tc} ticks and opens in ${to} ticks (lever to settled leaves), ${rec.items} items`);
    await L.leaveWorld();
  }
  return out;
};

steps.daydebug = async () => {
  await ensure();
  const X = 7800, Z = 7000;
  const g = await world(X, Z), F = g + 1;
  await tp(X + 30, F + 12, Z + 4);
  await cmd('/time set 6000');
  const rig = await dayRig(X, F, Z, 'portcullis');
  await L.gameWait(3000, { real: L.settle, label: 'settle' });
  const BX = X + 9, BY = F + 5, BZ = Z - 4;
  const cellsW = { sens: [30, -10], RS: [30, -9], S: [30, -7], Q: [32, -6], Qp: [34, -6], B2rep: [34, -2], T2: [32, -2], CMP: [30, -2], D: [30, -1], BCrep: [33, -1], T5: [32, 0], RL: [31, 0], RG: [30, 0], T1: [29, -1], B1rep: [27, -1], Grep: [28, 0] };
  const trace = async (tag, n) => {
    await freeze();
    const rows = [];
    for (let t = 0; t <= n; t++) {
      const b = await snap(BX + 25, BY, BZ - 12, BX + 36, BY, BZ + 1);
      rows.push(`${String(t).padStart(3)} ` + Object.entries(cellsW).map(([k2, [x, z]]) => { const v = b[`${BX + x},${BY},${BZ + z}`] ?? ''; const m = /power=(\d+)/.exec(v); return `${k2}=${m ? m[1] : /powered=true|lit=true/.test(v) ? 1 : 0}`; }).join(' '));
      await step(1);
    }
    await unfreeze();
    log(`${tag}\n${rows.join('\n')}`);
  };
  await cmd('/time set 14000'); await L.gameWait(3000, { real: L.settle, label: 'dusk' });
  await flip(rig.lever.A); await L.gameWait(1500, { real: L.settle, label: 'flip' });
  log(`night with override open: ${json(await gateState(X, F, Z, rig.leaf, rig.rg))}`);
  await cmd('/time set 1000');
  await trace('dawn trace', 45);
  log(`after: ${json(await gateState(X, F, Z, rig.leaf, rig.rg))}`);
  await L.leaveWorld();
};

/** The lever detectors at a real gate: one observer pulse per flip, 20 flips a lever, and nothing else in the box moves. */
steps.detectors = async () => {
  await ensure();
  const out = {};
  const X = 7900, Z = 7000;
  const g = await world(X, Z), F = g + 1;
  await tp(X, F + 4, Z + 12);
  const cells = [...GMC.slideCells('portcullis', {}).values()];
  for (let u = -2; u <= 5; u++) { cells.push([u, 2, 4, `${W_}stone`]); cells.push([u, 2, 5, u === 0 || u === 4 ? `${W_}repeater[facing=east,delay=1]` : `${W_}redstone_wire`]); }
  cells.push(...GMC.detectorCells(3), [-1, 1, 5, `${W_}air`], [1, 1, 5, `${W_}air`]); // (the pulses' cells: stone there would carry them into the bus beside)
  await gatehouse(X, F, Z, `${W_}stone`, cells);
  const leaf0 = leaves(await gateBox(X, F, Z), X, F, Z, 'iron_bars');
  await L.gameWait(2000, { real: L.settle, label: 'settle' });
  const rest = await gateBox(X, F, Z);
  const res = {};
  for (const [name, lever, obs] of [['outside', [X - 1, F + 2, Z], [X - 1, F + 4, Z + 1]], ['inside', [X + 1, F + 2, Z + 2], [X + 1, F + 4, Z + 1]]]) {
    const pulses = [];
    await freeze();
    for (let c = 1; c <= 20; c++) {
      await flip(lever);
      const on = [];
      for (let t = 1; t <= 8; t++) { await step(1); if (/powered=true/.test(await stateAt(...obs))) on.push(t); }
      pulses.push(on);
    }
    await unfreeze();
    res[name] = pulses;
    check(pulses.every((p2) => p2.length === 2 && p2[1] === p2[0] + 1), `detector ${name}: 20 flips, each one observer pulse of 2 ticks (${json(pulses.slice(0, 3))}...)`);
  }
  await L.gameWait(1000, { real: L.settle, label: 'after' });
  const end = await gateBox(X, F, Z);
  const diff = Object.keys({ ...rest, ...end }).filter((k2) => rest[k2] !== end[k2] && !/lever|trapdoor|observer/.test(`${rest[k2]}${end[k2]}`));
  out.detectors = res; out.diff = diff;
  const leaf1 = leaves(end, X, F, Z, 'iron_bars');
  check(leaf0[-1] === 2 && leaf0[1] === 2 && leaf1[-1] === 2 && leaf1[1] === 2, `detectors: the leaves stay open through the build and the 40 flips (${json({ leaf0, leaf1 })})`);
  check(diff.length === 0, `detectors: after 40 flips (levers back off) nothing but the levers, trapdoors and observers changed in the box (${json(diff.slice(0, 5))})`);
  await L.leaveWorld();
  return out;
};

// gm-probe under §12 item 4: the lifting extender row is removed (steps extender and outside stay, as the record of why)
/** The settled states the probe saw, per kind and rest, in the local frame: written to <OUT>/gmSettled.json (copied into the kit by hand). */
steps.settled = async () => {
  await ensure();
  const X = 8000, Z = 7000;
  const g = await world(X, Z), F = g + 1;
  await tp(X, F + 4, Z + 12);
  const out = {};
  const local = (box, keys) => Object.fromEntries(keys.map((k2) => { const [u, d, r] = k2.split(',').map(Number); return [k2, `minecraft:${box[`${X + u},${F + r},${Z + d}`] ?? 'air'}`]; }));
  for (const kind of ['portcullis', 'slide']) {
    const lay = [...GMC.slideCells(kind, {}).values(), ...GMC.detectorCells(3)];
    const keys = lay.map(([u, d, r]) => `${u},${d},${r}`);
    const cells = [...lay, [-1, 1, 5, `${W_}air`], [1, 1, 5, `${W_}air`]];
    for (let u = -2; u <= 5; u++) { cells.push([u, 2, 4, `${W_}stone`]); if (u !== -3 && u !== 3 && u !== 0) cells.push([u, 2, 5, `${W_}redstone_wire`]); }
    cells.push([0, 2, 5, `${W_}stone`], [0, 2, 6, `${W_}lever[face=floor,facing=north,powered=false]`]);
    await gatehouse(X, F, Z, `${W_}stone`, cells);
    await L.gameWait(2000, { real: L.settle, label: 'settle' });
    const b0 = await gateBox(X, F, Z);
    log(`  ${kind} built:\n${draw(b0, X, F, Z, [0, 1, 2])}`);
    const open = local(b0, keys);
    await flip([X, F + 6, Z + 2]); await L.gameWait(2000, { real: L.settle, label: 'closed' });
    const closed = local(await gateBox(X, F, Z), keys);
    await flip([X, F + 6, Z + 2]); await L.gameWait(2000, { real: L.settle, label: 'open again' });
    const again = local(await gateBox(X, F, Z), keys);
    out[kind] = { open, closed, again };
    log(`  ${kind} open vs again: ${json(Object.keys(open).filter((k2) => open[k2] !== again[k2]).map((k2) => [k2, open[k2], again[k2]]))}`);
    check(json(open) === json(again), `${kind}: the open rest state is a fixed point (open, closed, open again: identical)`);
  }
  {
    const lay = [...GMC.swingCells({}).values()];
    const keys = lay.map(([u, d, r]) => `${u},${d},${r}`);
    await gatehouse(X + 20, F, Z, `${W_}stone`, lay);
    await L.gameWait(2000, { real: L.settle, label: 'settle' });
    const X2 = X + 20;
    const loc = (box) => Object.fromEntries(keys.map((k2) => { const [u, d, r] = k2.split(',').map(Number); return [k2, `minecraft:${box[`${X2 + u},${F + r},${Z + d}`] ?? 'air'}`]; }));
    const closed = loc(await gateBox(X2, F, Z));
    await flip([X2, F + 1, Z + 2]); await L.gameWait(1000, { real: L.settle, label: 'open' });
    const open = loc(await gateBox(X2, F, Z));
    await flip([X2, F + 1, Z + 2]); await L.gameWait(1000, { real: L.settle, label: 'closed again' });
    const again = loc(await gateBox(X2, F, Z));
    out.swing = { closed, open };
    check(json(closed) === json(again), 'swing: the closed rest state is a fixed point');
  }
  fs.writeFileSync(path.join(OUT, 'gmSettled.json'), JSON.stringify(out, null, 1));
  await L.leaveWorld();
  return { kinds: Object.keys(out) };
};

// ------------------------------------------------------------------ step 1b (CONTRACT GM §14): the gate and its logic in real gatehouses

/** A gatehouse box `half` x depth x roof (floor row -1, roof at row `roof`), its passage open, the hall above the logic block open, then
 * gateLayout's cells written in §7 item 2's order (structure, pistons, leaves, wire and diodes, triggers last). */
async function gmBox(X, F, Z, { half, depth, roof, kind }) {
  const lay = GMC.gateLayout(kind, { depth, roof });
  const M = gmMatsOf({});
  await fill([X - half, F - 1, Z], [X + half, F + roof, Z + depth - 1], M.structure);
  await fill([X - 1, F, Z - 2], [X + 1, F + 2, Z + depth + 1], `${W_}air`);
  if (roof - 1 >= 4) await fill([X - half + 1, F + 4, Z + 1], [X + half - 1, F + roof - 1, Z + depth - 2], `${W_}air`);
  // (observers go in with the structure: one is the floor of the S repeater; a pulse while building only sets G to the day's S)
  const rank = (st) => (/lever|daylight/.test(st) ? 5 : /wire|repeater|comparator|torch/.test(st) ? 3 : /bars|fence/.test(st) ? 2 : /piston/.test(st) ? 1 : 0);
  const cells = GMC.layoutCells(lay).sort((a, b) => rank(a[3]) - rank(b[3]));
  for (const c of cells) { const [x, y, z, st] = GMC.toWorld(c, X, F, Z); await sb(x, y, z, st); }
  return lay;
}
/** The gate's state: the leaves (open 2 / closed 1 per side), G (RG powered), and the logic's cells for a trace. */
async function fitState(X, F, Z, leaf) {
  const box = await snap(X - 5, F - 1, Z, X + 5, F + 8, Z + 2);
  const l = leaves(box, X, F, Z, leaf);
  const at = (u, d, r) => box[`${X + u},${F + r},${Z + d}`] ?? (d <= 2 ? 'air' : null);
  const lc = await snap(X - 5, F + 5, Z + 1, X, F + 7, Z + 4);
  const L2 = (u, d, r) => lc[`${X + u},${F + r},${Z + d}`] ?? 'air';
  const rg = L2(-1, 4, 7);
  return { closed: l[-1] === 1 && l[1] === 1, open: l[-1] === 2 && l[1] === 2, leaves: l, G: /powered=true/.test(rg), locked: /locked=true/.test(rg),
    T1: /lit=true/.test(L2(-2, 4, 6)), CMP: /powered=true/.test(L2(-3, 4, 7)), T5: /lit=true/.test(L2(-1, 2, 7)), T2: /lit=true/.test(L2(-3, 2, 7)), at };
}
/** A tick trace of one latch window: per tick RG's lock and output, D = T1 or CMP; the slack of §14 item 3 (start a = u0 - v0, end
 * (v1 + 4) - u1, RG's delay being 4 game ticks). `act` starts the window (a lever flip, a time jump). */
async function fitTrace(X, F, Z, leaf, act, n = 50) {
  await freeze();
  const rows = [];
  rows.push(await fitState(X, F, Z, leaf));
  await act();
  for (let t = 1; t <= n; t++) { await step(1); rows.push(await fitState(X, F, Z, leaf)); }
  await unfreeze();
  const D = rows.map((r) => r.T1 || r.CMP);
  const u0 = rows.findIndex((r) => !r.locked);
  const u1 = u0 < 0 ? -1 : rows.findIndex((r, i) => i > u0 && r.locked);
  let v0 = u0; while (v0 > 0 && D[v0 - 1] === D[u0]) v0--;
  const v0c = v0 === 0 && D.slice(0, u0 + 1).every((x) => x === D[u0]) ? null : v0; // D constant since before the window
  const v1 = u0 < 0 ? -1 : D.findIndex((x, i) => i > u0 && x !== D[u0]);
  const a = u0 < 0 ? null : v0c === null ? null : u0 - v0c;
  const endSlack = u0 < 0 || u1 < 0 ? null : v1 < 0 ? null : v1 + 4 - u1;
  const line = (k2) => rows.map((r) => (r[k2] ? 1 : 0)).join('');
  return { u0, u1, v0: v0c, v1, a, endSlack, G: line('G'), locked: line('locked'), D: D.map((x) => (x ? 1 : 0)).join(''), T1: line('T1'), CMP: line('CMP'), T5: line('T5'), T2: line('T2'),
    ok: u0 >= 0 && (a === null || a >= 1) && (endSlack === null || endSlack >= 1), first: { G: rows[0].G }, last: { G: rows[n].G, closed: rows[n].closed, open: rows[n].open } };
}
/** Count G's edges and the leaves' moves while time runs, sampled every `every` ticks for `n` samples. */
async function fitWatch(X, F, Z, leaf, n, every = 10) {
  await freeze();
  const g = [];
  let last = await fitState(X, F, Z, leaf);
  g.push(last.G ? 'C' : 'o');
  for (let i = 0; i < n; i++) { await step(every); last = await fitState(X, F, Z, leaf); g.push(last.G ? 'C' : 'o'); }
  await unfreeze();
  const seq = g.join('');
  // (the leaves move in 3 ticks: a sample may catch them moving, so only the last sample's leaves must match G)
  return { seq, edges: [...seq].filter((c, i) => i > 0 && c !== seq[i - 1]).length, mixed: !(last.G ? last.closed : last.open) };
}

steps.fitdebug = async () => {
  await ensure();
  const X = 9600, Z = 7000;
  const g = await world(X, Z), F = g + 1;
  await tp(X + 12, F + 14, Z - 10);
  await cmd('/time set 6000');
  await gmBox(X, F, Z, { half: 6, depth: 7, roof: 10, kind: 'portcullis' });
  await L.gameWait(3000, { real: L.settle, label: 'settle' });
  const cellsW = { sensor: [-4, 1, 10], raw9: [-4, 1, 9], RS: [-4, 2, 8], S3: [-4, 3, 8], S4: [-4, 4, 8], OS: [-4, 2, 7], RQ: [-4, 3, 6], QA: [-4, 4, 6], rB2: [-4, 1, 7], CMP: [-3, 4, 7], RG: [-1, 4, 7], T1: [-2, 4, 6], T2: [-3, 2, 7], T5: [-1, 2, 7] };
  const dump = async (tag) => { const o = {}; for (const [n2, [u, d, r]] of Object.entries(cellsW)) o[n2] = (await stateAt(X + u, F + r, Z + d)).replace(/minecraft:/, ''); log(`${tag}: ${json(o)}`); return o; };
  const out = { day: await dump('day') };
  await cmd('/time set 14000'); await L.gameWait(3000, { real: L.settle, label: 'night' });
  out.night = await dump('night');
  await cmd('/time set 18000'); await L.gameWait(3000, { real: L.settle, label: 'midnight' });
  out.midnight = await dump('midnight');
  await L.leaveWorld();
  return out;
};
const FIT_BOXES = (process.env.GM_FIT_BOXES ?? '13x7x10,13x11x11,17x15x12').split(',').map((b) => b.split('x').map(Number));
steps.fit = async () => {
  await ensure();
  const out = {};
  let bx = 0;
  for (const [W2, D2, R2] of FIT_BOXES) for (const kind of (process.env.GM_FIT_KINDS ?? 'portcullis,slide').split(',')) {
    const name = `${W2}x${D2}x${R2} ${kind}`;
    const X = 9000 + 60 * bx++, Z = 7000;
    const g = await world(X, Z), F = g + 1;
    await tp(X + 12, F + 14, Z - 10);
    await cmd('/time set 6000'); await cmd('/weather clear');
    const half = (W2 - 1) / 2;
    await gmBox(X, F, Z, { half, depth: D2, roof: R2, kind });
    await L.gameWait(3000, { real: L.settle, label: 'gm fit settles' });
    const leaf = kind === 'slide' ? 'stone_bricks' : 'iron_bars';
    const lever = { A: [X - 1, F + 2, Z], B: [X + 1, F + 2, Z + D2 - 1] };
    const st = () => fitState(X, F, Z, leaf);
    const rec = { box: [W2, D2, R2], kind, steps: [] };
    // the rest state as built and settled by day: every redstone part, compared with gmCircuit.settleLayout (§7 item 1)
    {
      const lay = GMC.gateLayout(kind, { depth: D2, roof: R2 });
      const pure = await GMC.settleLayout(lay);
      const dumpBox = await snap(X - half, F - 1, Z, X + half, F + R2, Z + D2 - 1);
      const diff = [];
      for (const [k2, want] of pure) { const [u, d, r] = k2.split(',').map(Number); const got = `minecraft:${dumpBox[`${X + u},${F + r},${Z + d}`] ?? 'air'}`; if (got !== want) diff.push([k2, want.replace('minecraft:', ''), got.replace('minecraft:', '')]); }
      rec.settled = { compared: pure.size, diff };
      log(`  ${name} settleLayout vs the built rest state: ${diff.length} of ${pure.size} differ ${json(diff.slice(0, 6))}`);
    }
    const note = async (what, want) => { const s2 = await st(); const ok = want === 'closed' ? s2.closed && s2.G : s2.open && !s2.G; rec.steps.push({ what, want, ok, leaves: s2.leaves, G: s2.G }); log(`  ${name} ${what}: ${ok ? 'ok' : 'WRONG'} (leaves ${json(s2.leaves)}, G ${s2.G})`); return ok; };
    const flipW = async (lv) => { await flip(lever[lv]); await L.gameWait(1500, { real: L.settle, label: 'gm flip' }); };
    const timeW = async (t) => { await cmd(`/time set ${t}`); await L.gameWait(3000, { real: L.settle, label: 'gm sensor ticks' }); };
    await note('rest at day', 'open');
    await flipW('A'); await note('day, lever A (outside) -> override closed', 'closed');
    await flipW('A'); await note('day, lever A again -> open', 'open');
    await flipW('B'); await note('day, lever B (inside) -> closed', 'closed');
    await flipW('A'); await note('day, lever A -> open (either lever toggles)', 'open');
    await timeW(14000); await note('dusk, no override -> closed', 'closed');
    await timeW(1000); await note('dawn -> open', 'open');
    await flipW('B'); await note('day, lever B -> override closed', 'closed');
    await timeW(14000); await note('dusk with a closed override -> closed (the sensor takes over)', 'closed');
    await flipW('A'); await note('night, lever A -> override open', 'open');
    await timeW(1000); await note('dawn with an open override -> open (override cleared)', 'open');
    await flipW('A'); await note('day after the reset, lever A -> closed (a fresh override)', 'closed');
    await flipW('B'); await note('day, lever B -> open', 'open');
    let bad = 0;
    for (let c = 1; c <= 20; c++) {
      await flipW(c % 2 ? 'A' : 'B'); const a2 = await st();
      await flipW(c % 2 ? 'B' : 'A'); const b2 = await st();
      if (!(a2.closed && b2.open)) { bad++; rec.firstBad ??= { c, a2: a2.leaves, b2: b2.leaves }; }
    }
    rec.cycles = { n: 20, bad };
    // tick traces of the latch windows (§14 item 3)
    rec.trace = {};
    rec.trace.lever = await fitTrace(X, F, Z, leaf, () => flip(lever.A));
    await flipW('A');
    await cmd('/time set 11500'); await L.gameWait(2000, { real: L.settle, label: 'before dusk' });
    rec.trace.dusk = await fitTrace(X, F, Z, leaf, () => cmd('/time set 14000'), 60);
    rec.trace.dawn = await fitTrace(X, F, Z, leaf, () => cmd('/time set 1000'), 60);
    await flipW('B'); // a closed override by day
    rec.trace.duskOverride = await fitTrace(X, F, Z, leaf, () => cmd('/time set 14000'), 60);
    await flipW('A'); // an open override at night
    rec.trace.dawnOverride = await fitTrace(X, F, Z, leaf, () => cmd('/time set 1000'), 60);
    for (const [k2, tr] of Object.entries(rec.trace)) log(`  ${name} trace ${k2}: a ${tr.a} end slack ${tr.endSlack} u ${tr.u0}..${tr.u1} v ${tr.v0}..${tr.v1}\n    G      ${tr.G}\n    locked ${tr.locked}\n    D      ${tr.D}`);
    // natural dusk and dawn (time runs), then a daytime storm and its clearing: G edges and leaf moves
    // (from clear day through dusk, and from deep night through dawn: the sensor's switch falls inside either window)
    // (the 'exact' rules stop the clock and the weather: they run for these watches only)
    await cmd('/gamerule advance_time true');
    await cmd('/time set 11000'); await L.gameWait(2000, { real: L.settle, label: 'pre-dusk' });
    rec.dusk = await fitWatch(X, F, Z, leaf, 360, 10);
    await cmd('/time set 21000'); await L.gameWait(2000, { real: L.settle, label: 'pre-dawn' });
    rec.dawn = await fitWatch(X, F, Z, leaf, 360, 10);
    await cmd('/gamerule advance_time false');
    await cmd('/time set 6000'); await L.gameWait(2000, { real: L.settle, label: 'noon' });
    const pre = await st();
    await cmd('/gamerule advance_weather true');
    await cmd('/weather thunder 2400');
    rec.storm = await fitWatch(X, F, Z, leaf, 80, 10);
    await cmd('/weather clear');
    rec.clear = await fitWatch(X, F, Z, leaf, 80, 10);
    await cmd('/gamerule advance_weather false');
    rec.storm.startOpen = pre.open;
    rec.items = (await items(X, F + 2, Z + 1, 12)).stacks;
    out[name] = rec;
    const traceOk = Object.values(rec.trace).every((t) => t.ok);
    check(rec.steps.every((s2) => s2.ok), `${name}: §2a ${rec.steps.filter((s2) => s2.ok).length}/${rec.steps.length} steps`);
    check(bad === 0, `${name}: 20 lever cycles through the logic, ${bad} with a misplaced leaf${rec.firstBad ? ` (${json(rec.firstBad)})` : ''}`);
    check(traceOk, `${name}: latch windows with at least 1 tick of slack: ${Object.entries(rec.trace).map(([k2, t]) => `${k2} a=${t.a} end=${t.endSlack}`).join(', ')}`);
    check(rec.dusk.seq[0] === 'o' && rec.dusk.edges === 1 && rec.dawn.seq[0] === 'C' && rec.dawn.edges === 1 && !rec.dusk.mixed && !rec.dawn.mixed, `${name}: natural dusk ${rec.dusk.edges} edge, dawn ${rec.dawn.edges} (one each: closes at dusk, opens at dawn, no flicker)`);
    check(rec.storm.edges <= 1 && rec.clear.edges <= 1 && !rec.storm.mixed && !rec.clear.mixed, `${name}: daytime storm ${rec.storm.edges} edge(s) (${rec.storm.seq.slice(-1) === 'C' ? 'closes' : 'stays open'}), clearing ${rec.clear.edges} (no flicker)`);
    check(!rec.items, `${name}: no item dropped (${json(rec.items)})`);
    check(rec.settled.diff.length === 0, `${name}: the pure settled rest state equals the built one (${rec.settled.compared} redstone parts, ${rec.settled.diff.length} differ)`);
    await L.leaveWorld();
  }
  return out;
};

steps.probe = async () => ({ rules: await steps.rules(), grate: await steps.grate(), detectors: await steps.detectors(), daycycle: await steps.daycycle(), swing: await steps.swing(), drawbridge: await steps.drawbridge() });

// ------------------------------------------------------------------ housekeeping

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  await L.startClient(process.argv[3] ?? FLAT, { backend: 'sim', env: { HEADLESS_SIDECAR: 'stub' } });
  return { head, pids: L.clientPids() };
};
steps.stop = async () => { try { await connect(10_000); } catch { /* by PID below */ } await L.stopClient(); };
steps.base = async () => { await ensure(); await L.ensureBase(FLAT); };

// ------------------------------------------------------------------ GM-a (CONTRACT GM §10 items 1-4, 7-8): tools/lib/gate7agm-a.mjs

{
  const { registerGmA } = await import('./lib/gate7agm-a.mjs');
  await registerGmA(steps, { L, call, check, cmd, log, root, OUT, json, stateAt, freeze, unfreeze, step, items });
}

const name = process.argv[2];
if (!steps[name]) { console.error(`steps: ${Object.keys(steps).join(' ')}`); process.exit(2); }
await run(name);
L.state.dev?.close?.();
process.exit(L.fails() ? 1 : 0);
