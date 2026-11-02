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
steps.outside = async () => {
  await ensure();
  const X = 7200, Z = 7000, out = { cycles: [] };
  const g = await world(X, Z), F = g + 1;
  await tp(X + 12, F + 4, Z + 14);
  const rig = await liftRig(X, Z, F, { glue: true });
  const box = () => snap(X - 1, F, Z, X + 1, F + 9, Z + 1);
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
  log(`  OUTSIDE THE CONTRACT slime column, 3 pistons, C at F+8: ${out.cycles.length} cycles, ${bad} bad; raise ${out.raiseTicks} ticks, lower ${out.lowerTicks}`);
  log(`  rec  ${json(out.firstBad ?? { closed: closed0, raised: raised0 }).slice(0, 1500)}`);
  await L.leaveWorld();
  return out;
};

steps.probe = async () => {
  await steps.rules();
  await steps.extender();
  await steps.outside();
};

// ------------------------------------------------------------------ housekeeping

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  await L.startClient(process.argv[3] ?? FLAT, { backend: 'sim', env: { HEADLESS_SIDECAR: 'stub' } });
  return { head, pids: L.clientPids() };
};
steps.stop = async () => { try { await connect(10_000); } catch { /* by PID below */ } await L.stopClient(); };
steps.base = async () => { await ensure(); await L.ensureBase(FLAT); };

const name = process.argv[2];
if (!steps[name]) { console.error(`steps: ${Object.keys(steps).join(' ')}`); process.exit(2); }
await run(name);
L.state.dev?.close?.();
process.exit(L.fails() ? 1 : 0);
