// (slice T5Fa, CONTRACT T5F §7) The failing-first rows on h_core_demo (a creative flat world: its pond, spout and lava pit), run by
// tools/gate6ch.mjs (steps t5*). As in gate-t5f-rs.mjs: a precondition check that must PASS, then the target check (red on dc814bb1 + the
// T5Fa hooks commit for the contract's reason).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CLAIM, OWNER, censusOf, crashAt, demoBox, diff, freshFlat, planDemo, realiseWait, removeWait, snap } from './gate6ch-core.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;

async function waitDown(ctx) {
  for (let i = 0; i < 180; i++) {
    await sleep(2000);
    const s = await ctx.L.call('dev.state', {}, 10_000).catch(() => null);
    if (s && s.inWorld === false) return true;
  }
  return false;
}

async function sourcesOf(ctx, cells, fluid = 'minecraft:water') {
  const set = new Set(cells.map(k3));
  const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]), zs = cells.map((c) => c[2]);
  const box = [Math.min(...xs), Math.min(...ys), Math.min(...zs), Math.max(...xs), Math.max(...ys), Math.max(...zs)];
  const c = await ctx.L.call('dev.fluid.census', { box }, 120_000);
  return c.fluids.filter(([x, y, z, s]) => set.has(`${x},${y},${z}`) && (s === fluid || s === `${fluid}[level=0]`)).map(([x, y, z]) => [x, y, z]);
}

/** A pond cell on its top layer with the fewest horizontal neighbours in the pond (an edge or corner source). */
function edgeCell(body) {
  const own = new Set(body.cells.map(k3));
  const ymax = Math.max(...body.cells.map((c) => c[1]));
  const n = (c) => [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => own.has(`${c[0] + dx},${c[1]},${c[2] + dz}`)).length;
  return body.cells.filter((c) => c[1] === ymax).sort((a, b) => n(a) - n(b) || a[0] - b[0] || a[2] - b[2])[0];
}

/**
 * t5-water-bucket (P2-a, N3). h_core_demo's pond: vanilla's infinite-source rule off for the row (gamerule water_source_conversion false,
 * so only Architect can put a source back); the tiles write the water, the write held; the player buckets an edge source; the write
 * released with Architect's writes traced (dev.fluid.writeTrace). Architect never writes that cell (red on 8cT: writeBody's open rule
 * writes it: water has no provenance). The ordered variant with a waiting-reach clear (a CLEARED reach written again) is T5Fb's regression.
 */
export async function waterBucket(ctx) {
  const { L, check, log, json } = ctx;
  const out = {};
  const world = 'G6B H T5WB';
  await freshFlat(ctx, world, 'exact');
  await L.cmd('/gamerule water_source_conversion false');
  const d = await planDemo(ctx, { lava: true });
  const pond = d.bodies.find((b) => b.id === 'pond') ?? d.bodies.find((b) => b.fluid !== 'lava');
  await L.call('dev.fluid.hold', { write: true }, 10_000);
  try {
    const region = await L.realise(d.p.planId);
    for (let i = 0; i < 300; i++) { if ((await sourcesOf(ctx, pond.cells)).length >= pond.cells.length) break; await sleep(2000); }
    const cell = edgeCell(pond);
    await L.call('dev.fluid.writeTrace', { on: true }, 10_000);
    const b = await L.call('dev.player.bucket', { at: cell }, 30_000);
    await sleep(3000);
    const empty = !(await sourcesOf(ctx, [cell])).length;
    out.pre = { cell, bucket: b, empty, pondCells: pond.cells.length };
    check(/success|consume/i.test(String(b?.result)) && empty, `WB: the precondition: the tiles wrote the pond, the player bucketed the edge source ${cell.join(',')} (${b?.result}, ${b?.gameMode}); it stays empty with the write held (${empty})`);
    await L.call('dev.fluid.hold', { write: false }, 10_000);
    let fs1 = null;
    for (let i = 0; i < 180; i++) { fs1 = await L.call('dev.fluid.state', { region }, 10_000).catch(() => null); const pb = (fs1?.bodies ?? []).find((x) => x.id === pond.id); if (pb && pb.state !== 'pending' && pb.state !== 'checked') break; await sleep(1000); }
    await sleep(3000);
    const trace = (await L.call('dev.fluid.writeTrace', { on: false }, 10_000)).cells ?? [];
    const wrote = trace.some((c) => k3(c) === k3(cell));
    out.after = { pond: (fs1?.bodies ?? []).find((x) => x.id === pond.id)?.state, traced: trace.length, wrote, source: (await sourcesOf(ctx, [cell])).length };
    log(`  WB: ${json(out)}`);
    check(!wrote, `WB (P2-a, N3): Architect never writes the bucketed cell ${cell.join(',')} (traced writes ${trace.length}; red on 8cT: writeBody writes it again)`);
    await removeWait(ctx, region).catch(() => null);
  } finally {
    await L.call('dev.fluid.hold', { write: false }, 10_000).catch(() => null);
    await L.call('dev.fluid.writeTrace', { on: false }, 10_000).catch(() => null);
    await L.leaveWorld().catch(() => null);
  }
  return out;
}

/**
 * t5-force-lost (P2-b). h_core_demo: the tiles write the bodies (the write held), every chunk saved; the bodies' chunks armed lost
 * (dev.chunk.drop); released with TX:fluid.write:barrier:effects armed (bare): the write txn's R (fluid.written) durable through
 * DurableFile, its forced ticks scheduled in memory only, the chunks not on disk (a halt at apply:1 is too early on 8cT: the R's save is
 * not durable yet and the replay re-runs it). The restart (forced passes traced, dev.fluid.forceTrace, armed in the new JVM before the world opens) replays the txn: the forced
 * ticks come back with each chunk's W (red on 8cT: the W is redone, the R's probe reads APPLIED and is skipped, nothing forces: forceBody
 * never runs). A trace, not the settle, is the target, so the still pond is a valid body here (the contract's flowing body would also read
 * its predicted levels; recorded, not judged).
 */
export async function forceLost(ctx) {
  const { L, check, log, json } = ctx;
  const out = {};
  const world = 'G6B H T5FZ';
  await freshFlat(ctx, world, 'exact');
  const d = await planDemo(ctx, { lava: true });
  const pond = d.bodies.find((b) => b.id === 'pond') ?? d.bodies[0];
  await L.call('dev.fluid.hold', { write: true }, 10_000);
  let region = null;
  try {
    region = await L.realise(d.p.planId);
    for (let i = 0; i < 300; i++) { if ((await sourcesOf(ctx, pond.cells)).length >= pond.cells.length) break; await sleep(2000); }
    await L.call('dev.stockpile.save', {}, 300_000).catch(() => null);
    await L.cmd('/save-all flush');
    await sleep(1500);
    // the bodies' chunks never reach disk from here (the barrier still acknowledged): at TX:fluid.write:barrier:effects the R is durable
    // (fluids.json through DurableFile), the chunks are not
    const chunks = [...new Map(d.bodies.flatMap((b) => [...b.cells, ...b.shell]).map((c) => [`${c[0] >> 4},${c[2] >> 4}`, [c[0] >> 4, c[2] >> 4]])).values()];
    await L.call('dev.chunk.drop', { chunks }, 10_000);
    await L.call('dev.journal.killAt', { point: 'TX:fluid.write:barrier:effects' }, 10_000);
    await L.call('dev.fluid.hold', { write: false }, 10_000);
    out.halted = await waitDown(ctx);
    check(out.halted, `FZ: the precondition: TX:fluid.write:barrier:effects reached and the JVM halted bare (the bodies' ${chunks.length} chunk(s) kept off disk)`);
    if (!out.halted) return out;
    // the new JVM, before the world opens (its recovery replays the write txn): the replay's forced passes traced (FluidTestFlags)
    fs.mkdirSync(path.join(L.GAME_DIR, 'architect'), { recursive: true });
    fs.writeFileSync(path.join(L.GAME_DIR, 'architect', 't5f-test-flags.json'), JSON.stringify({ forceTrace: true }));
    await L.openWorld(world);
    await L.tp((CLAIM[0] + CLAIM[2]) / 2, 120, (CLAIM[1] + CLAIM[3]) / 2);
    let fs1 = null;
    for (let i = 0; i < 60; i++) { fs1 = await L.call('dev.fluid.state', { region }, 10_000).catch(() => null); if (fs1) break; await sleep(1000); }
    await sleep(20_000);
    const forced = (await L.call('dev.fluid.forceTrace', {}, 10_000)).forced ?? [];
    const rec = path.join(L.SAVES, world, 'architect-regions', region, 'fluids.json');
    const disk = fs.existsSync(rec) ? JSON.parse(fs.readFileSync(rec, 'utf8')) : {};
    const fs2 = await L.call('dev.fluid.state', { region }, 10_000).catch(() => null);
    out.after = { writeTxnOnDisk: Object.values(disk.bodies ?? {}).some((b) => !!b?.writeTxn), phase: fs2?.phase, bodies: (fs2?.bodies ?? []).map((b) => [b.id, b.state]), forced };
    log(`  FZ: ${json(out)}`);
    check(out.after.writeTxnOnDisk, `FZ: the precondition: the R (fluid.written: writeTxn) durable in fluids.json after the restart (${out.after.writeTxnOnDisk})`);
    check(forced.some((f) => f.startsWith(`${pond.id}@`)), `FZ (P2-b): the replay forces ${pond.id} again (the ticks with its chunk's W): forced passes ${json(forced)} (red on 8cT: the R skipped, none)`);
  } finally {
    await L.call('dev.fluid.hold', { write: false }, 10_000).catch(() => null);
    await L.call('dev.fluid.forceTrace', { on: false }, 10_000).catch(() => null);
    await L.call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
    await L.call('dev.chunk.drop', { off: true }, 10_000).catch(() => null);
    if (region) await removeWait(ctx, region).catch(() => null);
    await L.leaveWorld().catch(() => null);
  }
  return out;
}

/**
 * t5-kn (Steward S1, 8cS Q3): halted at TX:fluid.write:place+save, the kill point's log line reads "reached (k of n)": n counts the write
 * txn's fluid.place (body, chunk) Ws only (never clear or force), k those applied with their receipt, 1 <= k < n for a body across a chunk
 * border ("(1 of 2)"), "(1 of 1)" for one chunk. Red on 8cT: the line names no progress ("not built").
 */
export async function killProgress(ctx) {
  const { L, check, log, json } = ctx;
  const out = {};
  const world = 'G6B H T5KN';
  await freshFlat(ctx, world, 'exact');
  const d = await planDemo(ctx, { lava: true });
  const logFile = path.join(L.GAME_DIR, 'logs', 'latest.log');
  const mark = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const t0 = Date.now();
  await crashAt(ctx, world, 'TX:fluid.write:place+save', async () => { await L.realise(d.p.planId); });
  // the halted JVM's log: a restart may have rotated latest.log; read the newest logs that mention the point
  const dir = path.join(L.GAME_DIR, 'logs');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.log') || f.endsWith('.log.gz')).map((f) => path.join(dir, f)) : [];
  let lines = [];
  for (const f of files) {
    if (fs.statSync(f).mtimeMs < t0 - 5000) continue; // this row's logs only (a restart rotates latest.log into a .gz)
    const t = f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(f)).toString('utf8') : fs.readFileSync(f, 'utf8');
    lines.push(...t.split('\n').filter((x) => x.includes('kill point TX:fluid.write:place+save')));
  }
  void mark;
  const m = lines.map((x) => /reached \((\d+) of (\d+)\)/.exec(x)).find(Boolean);
  const chunks = new Set(d.bodies.flatMap((b) => b.cells.map((c) => `${b.id}|${c[0] >> 4},${c[2] >> 4}`)));
  out.lines = lines.slice(-3);
  out.placeWs = chunks.size;
  log(`  KN: ${json(out)}`);
  check(lines.length > 0, `KN: the precondition: the kill point's log line found (${lines.length})`);
  if (!m) { check(false, `KN (S1/Q3): not built: the line names no progress "reached (k of n)" (${json(out.lines)})`); return out; }
  const k = Number(m[1]), n = Number(m[2]);
  out.k = k; out.n = n;
  check(n === chunks.size && k >= 1 && (n === 1 ? k === 1 : k < n), `KN (S1/Q3): reached (${k} of ${n}): n == the place Ws (body, chunk) ${chunks.size}, 1 <= k < n`);
  await L.leaveWorld().catch(() => null);
  return out;
}

/**
 * (slice T5Fb, contract §7 "TX matrix", fluid.write) h_core_demo realised and halted at each of `points` (each bare and +save): the start
 * replays the write txn (the Ws whose receipt is missing, each chunk's writes with its forced ticks), PLACED, every body settled, every
 * census equal, 0 fluid outside; every standing body cell carries WROTE (dev.fluid.marks: the marks reach disk with their chunk) and no
 * mark is WROTE over a cell not standing; Regions.remove REMOVED and E-flat 0 (conservation: the world as it was).
 */
export async function writeTx(ctx, points) {
  const { L, check, json } = ctx;
  const out = {};
  for (const p0 of points) {
    for (const point of [`TX:fluid.write:${p0}+save`, `TX:fluid.write:${p0}`]) {
      const bare = !point.endsWith('+save');
      const tag = `${p0.replace(/[^a-z]/gi, '')}-${bare ? 'bare' : 'save'}`;
      const world = `G6B H T5WX ${tag}`;
      await freshFlat(ctx, world, 'exact');
      const d = await planDemo(ctx, { lava: true });
      const box = demoBox(d.bodies);
      const file = await snap(ctx, box, `h-t5wx-${tag}`);
      let r = null;
      await crashAt(ctx, world, point, async () => { r = await L.realise(d.p.planId); });
      r ??= (await L.call('dev.region.list', {}, 60_000)).regions?.at(-1)?.id;
      const st = await L.waitRegion(r, 3_600_000);
      const fl = st.view.ext?.['architect_mc:fluids'] ?? [];
      let mism = 0, outside = 0;
      for (const b of d.bodies) { const c = await censusOf(ctx, b, null, d.bodies); mism += c.mismatch.length; outside += c.outsideCount; }
      const mk = await L.call('dev.fluid.marks', { region: r }, 30_000).catch((e) => ({ error: e.message }));
      const bodies = mk.bodies ?? [];
      const unmarked = bodies.reduce((a, b) => a + (b.standing - b.wroteStanding), 0);
      const takenWrote = bodies.reduce((a, b) => a + b.takenWrote, 0);
      const rm = await removeWait(ctx, r).catch((e) => ({ state: `error ${e.message}` }));
      await sleep(3000);
      const dx = await diff(ctx, box, file);
      out[tag] = { state: st.view.state, fluids: fl.map((x) => [x.body, x.state]), mism, outside, marks: bodies.map((b) => [b.id, b.cells, b.wroteStanding, b.standing]), removal: rm.state, mismatches: dx.mismatches };
      // (as t8wr, recorded with its reason) a bare halt may lose an earlier stage's chunks (the shell), so a body can end drained there
      check((bare || st.view.state === 'PLACED') && fl.length === 4 && fl.every((x) => x.state === 'settled' || (bare && x.state === 'drained')) && mism === 0 && outside === 0, `WX (${point}): the start replays the write txn: ${st.view.state}, bodies ${json(out[tag].fluids)}, census mismatches ${mism}, fluid outside ${outside}`);
      check(mk.prov === true && bodies.length === 4 && unmarked === 0 && takenWrote === 0, `WX (${point}): every standing body cell carries WROTE(R) and none over a cell not standing (I1): unmarked ${unmarked}, WROTE-not-standing ${takenWrote} (${json(out[tag].marks)})`);
      check(rm.state === 'REMOVED' && (bare || dx.mismatches === 0), `WX (${point}) conservation: Regions.remove: ${rm.state}, E-flat ${dx.mismatches}${bare ? ' (recorded: a bare halt may lose the earlier stages chunks, as t8wr)' : ''}`, dx.sample);
      await L.leaveWorld();
    }
  }
  return out;
}

/**
 * (slice T5Fb, contract §4.7 and §7 "TX matrix", fluid.adopt) h_core_demo realised, then its record made to read as one saved before T5F
 * (dev.fluid.unprov: marks removed, prov dropped) with the player's bucket taking one pond source first; the adoption halted at each
 * of `points` (bare and +save): after the start the record is adopted (prov), every standing cell WROTE, the bucketed cell WROTE too
 * (N2 (b): an ACTIVE tile entry wrote it: harvested, never refilled), Architect never writes it again; Regions.remove REMOVED, the pond
 * cell aside E-flat 0.
 */
export async function adoptTx(ctx, points) {
  const { L, check, json } = ctx;
  const out = {};
  for (const p0 of points) {
    for (const point of [`TX:fluid.adopt:${p0}+save`, `TX:fluid.adopt:${p0}`]) {
      const bare = !point.endsWith('+save');
      const tag = `${p0.replace(/[^a-z]/gi, '')}-${bare ? 'bare' : 'save'}`;
      const world = `G6B H T5AX ${tag}`;
      await freshFlat(ctx, world, 'exact');
      await L.cmd('/gamerule water_source_conversion false');
      const d = await planDemo(ctx, { lava: true });
      const pond = d.bodies.find((b) => b.id === 'pond') ?? d.bodies.find((b) => b.fluid !== 'lava');
      const r = await realiseWait(ctx, d.p.planId);
      const cell = edgeCell(pond);
      const b = await L.call('dev.player.bucket', { at: cell }, 30_000);
      await sleep(2000);
      await L.call('dev.stockpile.save', {}, 300_000).catch(() => null);
      await L.cmd('/save-all flush');
      await sleep(1500);
      // the kill point armed first: the adoption begins on the tick after the unprov (its answer may be lost with the halt)
      let un = null;
      await crashAt(ctx, world, point, async () => { un = await L.call('dev.fluid.unprov', { region: r.region }, 30_000); });
      let mk = null;
      for (let i = 0; i < 60; i++) { mk = await L.call('dev.fluid.marks', { region: r.region }, 30_000).catch(() => null); if (mk?.prov) break; await sleep(1000); }
      const bodies = mk?.bodies ?? [];
      const pb = bodies.find((x) => x.id === pond.id) ?? {};
      const unmarked = bodies.reduce((a, x) => a + (x.standing - x.wroteStanding), 0);
      await L.call('dev.fluid.writeTrace', { on: true }, 10_000);
      await sleep(5000);
      const trace = (await L.call('dev.fluid.writeTrace', { on: false }, 10_000)).cells ?? [];
      const rewrote = trace.some((c) => k3(c) === k3(cell));
      out[tag] = { bucket: b?.result, unprov: un, prov: mk?.prov, pond: pb, unmarked, rewrote };
      check(/success|consume/i.test(String(b?.result)) && (un === null || (un.marksRemoved > 0 && un.saved === true)), `AX (${point}): the precondition: a pond source bucketed, the record unprov'd (${json(un)}; null: the answer lost with the halt)`);
      check(mk?.prov === true && unmarked === 0 && pb.takenWrote === 1, `AX (${point}): adopted after the start: prov ${mk?.prov}, every standing cell WROTE (unmarked ${unmarked}), the bucketed cell WROTE (N2 b: ${pb.takenWrote})`);
      check(!rewrote, `AX (${point}): Architect never writes the bucketed cell ${k3(cell)} again (traced ${trace.length})`);
      const rm = await removeWait(ctx, r.region).catch((e) => ({ state: `error ${e.message}` }));
      out[tag].removal = rm.state;
      check(rm.state === 'REMOVED', `AX (${point}): Regions.remove after the adoption: ${rm.state}`);
      await L.leaveWorld();
    }
  }
  return out;
}

export { OWNER };
