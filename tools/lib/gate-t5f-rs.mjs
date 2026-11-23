// (slice T5Fa, CONTRACT T5F §7) The failing-first rows on rs03_water in survival (its paid lava pit and its grate), run by
// tools/gate6crs.mjs (steps t5*). Each row has a precondition check (it must PASS: the scenario really happened) and a target check (red on
// dc814bb1 + the T5Fa hooks commit for the reason the contract names, green on T5Fb/T5Fc). A row whose target needs a structure T5F has not
// built yet probes for it first and fails "not built: ..." without running the scenario. Hooks: docs in the T5Fa prep notes
// (architect-T5F-prep-notes.md) and each hook's own help text (SliceT5FDev).
//
// H: {ctx, G, L, check, log, json, sleep, cmd, entriesOf, rsTilesWritten, waitHalt, LAVA}

import fs from 'node:fs';
import path from 'node:path';

const ck = (c) => [c[0] >> 4, c[2] >> 4];
const key = (xz) => `${xz[0]},${xz[1]}`;

/** The lava cells by chunk: [{chunk: [x,z], cells}], sorted by chunk. */
function byChunk(cells) {
  const m = new Map();
  for (const c of cells) {
    const k = key(ck(c));
    if (!m.has(k)) m.set(k, { chunk: ck(c), cells: [] });
    m.get(k).cells.push(c);
  }
  return [...m.values()].sort((a, b) => a.chunk[0] - b.chunk[0] || a.chunk[1] - b.chunk[1]);
}

/** The highest cell of a list (a pit's top layer: open above, where the player's bucket and a dispenser reach). */
const top = (cells) => [...cells].sort((a, b) => b[1] - a[1] || a[0] - b[0] || a[2] - b[2])[0];

async function kinds(H) {
  return (await H.L.call('dev.txn.kinds', {}, 10_000).catch(() => ({ kinds: [] }))).kinds ?? [];
}

const lavaStock = async (H) => (await H.G.pileState(H.ctx)).stock?.['minecraft:lava_bucket'] ?? 0;
const barsStock = async (H) => (await H.G.pileState(H.ctx)).stock?.['minecraft:iron_bars'] ?? 0;

async function lavaAt(H, cells) {
  const out = [];
  for (const c of cells) {
    const r = await H.L.call('dev.fluid.census', { box: [c[0], c[1], c[2], c[0], c[1], c[2]] }, 60_000);
    const s = r.fluids.find((q) => q[0] === c[0] && q[1] === c[1] && q[2] === c[2])?.[3] ?? 'none';
    if (H.LAVA(s)) out.push(c);
  }
  return out;
}

async function waitState(H, region, states, ms = 900_000) {
  for (let i = 0; i < ms / 1000; i++) {
    const x = await H.L.call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = x?.view?.state;
    if (!s || states.includes(s)) return s ?? 'REMOVED';
    await H.sleep(1000);
  }
  return 'timeout';
}


/** The record's other chunks: every chunk holding the region's water (its drain W writes and receipts every chunk of the record). */
async function waterChunks(H, box, not) {
  const c = await H.L.call('dev.fluid.census', { box }, 600_000);
  const m = new Map();
  for (const [x, y, z, st] of c.fluids) if (String(st).startsWith('minecraft:water')) { const k = key(ck([x, y, z])); m.set(k, ck([x, y, z])); }
  m.delete(key(not));
  return [...m.values()];
}

/** Placed in full (every stage, the lava standing), then every chunk and the stockpile saved: {s, box, region, lava, charged}. */
async function placed(H, tag) {
  const { ctx, G, L } = H;
  const fx = G.fixture(ctx, 'rs03_water');
  const entries = H.entriesOf(fx);
  const s = await G.site(ctx, tag, fx);
  if (Object.keys(entries).length) await G.designs(ctx);
  const box = G.boxOf(s.W);
  const k = await G.check(ctx, tag, s);
  await G.pile(ctx, s, 4);
  const region = await G.realise(ctx, k.check.artifactSha, entries);
  await G.feed(ctx, region, { fraction: 1, timeoutMs: 2_400_000 });
  const c0 = await L.call('dev.fluid.census', { box }, 600_000);
  const lava = c0.fluids.filter(([, , , st]) => H.LAVA(st));
  const charged = (await G.rsState(ctx, region)).record?.charged?.['minecraft:lava_bucket'] ?? 0;
  await save(H);
  return { s, box, region, lava, charged };
}

async function save(H) {
  await H.L.call('dev.stockpile.save', {}, 300_000).catch(() => null);
  await H.cmd('/save-all flush');
  await H.sleep(1500);
}

/**
 * After a halt (no JVM runs until dev.world.open starts one): `flags` ({holdDrain?, holdWrite?, holdSettle?, holdChunk?, writeTrace?,
 * forceTrace?}) written to <gameDir>/architect/t5f-test-flags.json, applied by the new JVM's txn core before its recovery (FluidTestFlags).
 */
async function reopen(H, world, flags = null) {
  if (flags) {
    const dir = path.join(H.L.GAME_DIR, 'architect');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 't5f-test-flags.json'), JSON.stringify(flags));
  }
  await H.L.openWorld(world);
}

// ------------------------------------------------------------------ P1-1: the tile's ACTIVE without its chunk

/**
 * t5-tile-k4 / t5-tile-k4-rm (P1-1). rs03 in survival. At the fluids gate (dev.fluid.saveAtGate {drop}) every chunk is saved and the
 * claim's chunks are armed as lost: from then on the fluids stage's writes there never reach disk (every barrier still acknowledged). The
 * tiles write the lava, the write held; the tiles' journal entries go ACTIVE (durable). Then a save and a halt (dev.chunk.halt save): the
 * on-disk state of a crash at the fluids tile's K4 with its chunk lost (ACTIVE durable, the cells not), reached without arming K4 (global:
 * it halts at the first tile of any stage; a fluids-only alias needs InfraJob, a T4 file).
 * Restart with the write held (t5f-test-flags.json): the precondition (the lava absent, ACTIVE entries). Then `rm` false: the write runs
 * and must write the lost cells (red on 8cT: writeBody skips them as journaled); `rm` true: removed before the write, the refund must
 * include the lost paid cells as u (red on 8cT: the scoop refunds an absent charged cell only when the journal says unwritten).
 */
export async function tileK4(H, rm) {
  const { ctx, G, L, check, log, json } = H;
  const tag = rm ? 'rs03t5k4rm' : 'rs03t5k4';
  const out = {};
  const fx = G.fixture(ctx, 'rs03_water');
  const entries = H.entriesOf(fx);
  try {
    const s = await G.site(ctx, tag, fx);
    if (Object.keys(entries).length) await G.designs(ctx);
    const box = G.boxOf(s.W);
    const k = await G.check(ctx, tag, s);
    await G.pile(ctx, s, 4);
    await L.call('dev.fluid.saveAtGate', { drop: [box[0], box[2], box[3], box[5]] }, 10_000);
    await L.call('dev.fluid.hold', { write: true }, 10_000);
    const region = await G.realise(ctx, k.check.artifactSha, entries);
    let writing = null;
    await G.feed(ctx, region, { fraction: 1, timeoutMs: 2_400_000, until: (st) => !!writing || ['PLACED', 'PARTIAL', 'FAILED'].includes(st.view.state),
      extra: async () => { const x = await L.call('dev.fluid.state', { region }, 10_000).catch(() => null); if (x?.phase === 'writing') writing = x; return {}; } });
    let lava = [], last = -1, stable = 0;
    for (let i = 0; i < 120 && stable < 3; i++) {
      const c = await L.call('dev.fluid.census', { box }, 600_000);
      lava = c.fluids.filter(([, , , st]) => H.LAVA(st));
      stable = lava.length > 0 && lava.length === last ? stable + 1 : 0;
      last = lava.length;
      await H.sleep(5000);
    }
    const charged = (await G.rsState(ctx, region)).record?.charged?.['minecraft:lava_bucket'] ?? 0;
    const activeOf = async () => { const js = await L.call('dev.journal.state', {}, 60_000); const es = js.entries ?? []; return { active: es.filter((e) => e.status === 'ACTIVE').length, total: es.length, sample: es.slice(-3).map((e) => [e.site, e.group ?? null, e.kind, e.status]) }; };
    const j1 = await activeOf();
    const dropped = (await L.call('dev.chunk.drop', { chunks: [] }, 10_000)).dropped ?? [];
    out.pre = { lava: lava.length, charged, journal: j1, dropped: dropped.length, split: byChunk(lava).map((g) => [key(g.chunk), g.cells.length]) };
    check(lava.length === charged && charged > 0 && j1.active > 0 && dropped.length > 0, `K4 (${tag}): the precondition before the halt: ${lava.length} lava written by the tiles of ${charged} charged, ${j1.active} of ${j1.total} journal entries ACTIVE (${json(j1.sample)}), ${dropped.length} chunk(s) of the claim armed lost at the gate`);
    L.call('dev.chunk.halt', { save: true }, 60_000).catch(() => null);
    out.halted = await H.waitHalt('dev.chunk.halt');
    await reopen(H, s.world, { holdWrite: true, holdSettle: true, writeTrace: true });
    await H.sleep(5000);
    const lost = lava.length - (await lavaAt(H, lava)).length;
    const j2 = await activeOf();
    out.restart = { lost, of: lava.length, journal: j2 };
    check(lost === lava.length && j2.active > 0, `K4 (${tag}): the precondition after the restart: ${lost} of ${lava.length} lava cell(s) lost with their chunks' snapshots, ${j2.active} journal entries still ACTIVE (the journal apart from the chunk)`);
    if (!rm) {
      await L.call('dev.fluid.hold', { write: false, settle: true }, 10_000);
      let fs1 = null;
      for (let i = 0; i < 180; i++) { fs1 = await L.call('dev.fluid.state', { region }, 10_000).catch(() => null); if (fs1?.phase === 'settling' || fs1?.phase === 'settled' || fs1?.phase === 'done') break; await H.sleep(1000); }
      await H.sleep(3000);
      const back = (await lavaAt(H, lava)).length;
      const trace = (await L.call('dev.fluid.writeTrace', { on: false }, 10_000)).cells ?? [];
      const lavaKeys = new Set(lava.map((c) => `${c[0]},${c[1]},${c[2]}`));
      const lavaTraced = trace.filter((c) => lavaKeys.has(`${c[0]},${c[1]},${c[2]}`)).length;
      out.written = { phase: fs1?.phase, back, of: lava.length, charged, traced: trace.length, lavaTraced };
      log(`  K4 (${tag}): ${json(out)}`);
      check(trace.length > 0, `K4 (${tag}): the precondition: the stage's write ran after the restart (Architect's traced writes ${trace.length}: the lost water, which no journal guards)`);
      check(back === charged, `K4 (${tag}, P1-1): the stage's write writes the lost cells again (mark none, cell open: §3.3 row 1): ${back} of ${charged} standing, ${lavaTraced} lava cell(s) in Architect's writes (red on 8cT: writeBody skips them as journaled)`);
      const s0 = await lavaStock(H);
      await G.remove(ctx, region);
      const got = (await lavaStock(H)) - s0;
      out.refund = got;
      check(got === charged, `K4 (${tag}) conservation: removed after the write: refunded ${got} of ${charged} charged`);
    } else {
      const standing = (await lavaAt(H, lava)).length;
      const s0 = await lavaStock(H);
      await G.remove(ctx, region);
      const got = (await lavaStock(H)) - s0;
      out.removed = { standing, refunded: got, charged, lost };
      log(`  K4 (${tag}): ${json(out)}`);
      check(got === charged, `K4 (${tag}, P1-1) conservation: removed before the write: refunded ${got} = the ${standing} standing + the ${lost} lost (paid, never delivered: u) == ${charged} charged (red on 8cT: the lost cells are journaled, refunded 0: ${charged - got} short)`);
    }
  } finally {
    await L.call('dev.fluid.hold', { write: false, settle: false }, 10_000).catch(() => null);
    await L.call('dev.chunk.drop', { off: true }, 10_000).catch(() => null);
  }
  return out;
}

// ------------------------------------------------------------------ P1-2a: evidence ahead of the mutation

/**
 * t5-drain-hold (P1-2a). Placed, saved; the removal's drain held at another chunk of the record (dev.fluid.holdChunk: on 8cT inside its
 * seen loop, so the chunks before it already carry their seen counts), tried chunk by chunk until the pit's chunk C is among those counted
 * before the hold; the player buckets a lava source in C; released. Conservation: refunded + the player's 1 == charged (red on 8cT: C's
 * seen count was written before the hold and kept: one minted). rs03's pit stands in one chunk: the record's water chunks give the second.
 */
export async function drainHold(H) {
  const { L, check, log, json } = H;
  const out = {};
  const p = await placed(H, 'rs03t5dh');
  const groups = byChunk(p.lava);
  const C = groups[0];
  const others = C ? await waterChunks(H, p.box, C.chunk) : [];
  out.split = { lava: groups.map((g) => [key(g.chunk), g.cells.length]), others: others.map(key) };
  check(!!C && others.length > 0 && p.lava.length === p.charged && p.charged > 0, `DH: the precondition: placed, ${p.lava.length} lava of ${p.charged} charged in ${json(out.split.lava)}; the record's other chunk(s) ${json(out.split.others)}`);
  if (!C || !others.length) return out;
  const s0 = await lavaStock(H);
  let bucket = null;
  try {
    let before = [], tried = [];
    L.call('dev.region.remove', { region: p.region, requester: H.G.OWNER }, 3_600_000).catch(() => null);
    for (const x of others.slice(0, 6)) {
      await L.call('dev.fluid.holdChunk', { x: x[0], z: x[1] }, 10_000);
      tried.push(key(x));
      for (let i = 0; i < 45 && !before.includes(key(C.chunk)); i++) { await H.sleep(1000); before = (await L.call('dev.fluid.holdChunk', {}, 10_000)).before ?? []; }
      if (before.includes(key(C.chunk))) break;
    }
    out.held = { tried, before };
    const counted = before.includes(key(C.chunk));
    const standing = counted ? await lavaAt(H, C.cells) : [];
    if (counted && standing.length) bucket = await L.call('dev.player.bucket', { at: top(standing) }, 30_000);
    out.bucket = bucket;
    // (T5Fc fix round) on T5F a chunk's count and its drain are one apply: a chunk counted before the hold holds no source of ours to take,
    // so the 8cT window (counted, then harvested) is closed by construction; the conservation below still gates
    out.closedByConstruction = counted && !standing.length;
    check(counted && (bucket?.hand === 'minecraft:lava_bucket' || out.closedByConstruction), `DH: the precondition: the drain held at ${tried.at(-1)} with the pit's chunk ${key(C.chunk)} counted before it (${json(before)}); the player bucketed a source there (${json(bucket)}), or none stands (T5F: counted = drained in one apply)`);
    await L.call('dev.fluid.holdChunk', { off: true }, 10_000);
    out.final = await waitState(H, p.region, ['REMOVED', 'PARTIAL', 'FAILED']);
    await L.settle(2000);
  } finally {
    await L.call('dev.fluid.holdChunk', { off: true }, 10_000).catch(() => null);
  }
  const got = (await lavaStock(H)) - s0;
  const taken = bucket?.hand === 'minecraft:lava_bucket' ? 1 : 0;
  out.refund = { got, taken, charged: p.charged };
  log(`  DH: ${json(out)}`);
  check(got + taken === p.charged, `DH (P1-2a) conservation: refunded ${got} + the player's ${taken} == charged ${p.charged} (red on 8cT: the seen count saved before the hold is kept: ${got + taken - p.charged > 0 ? `minted ${got + taken - p.charged}` : 'exact'})`);
  return out;
}

/**
 * t5-drain-fl5 (P1-2a, the FL5+save path). Placed, saved; removed with FL5+save armed: on 8cT the drain's one apply writes every chunk's
 * seen count first, drains the course's head, then FL5 saves everything while the lava pit (later in the reverse write order) still stands.
 * Restart with the drain held (dev.fluid.hold drain, armed in the new JVM before the world opens); a dispenser takes a lava source;
 * released. Conservation: refunded + the dispenser's 1 == charged (red on 8cT: the saved seen count is kept). Needs rs03 to be an ordered
 * record whose head is not the pit (FL5 fires only on `st.ordered && i > 0`): the precondition says whether it is.
 */
export async function drainFl5(H) {
  const { ctx, L, check, log, json } = H;
  const out = {};
  const p = await placed(H, 'rs03t5fl5');
  check(p.lava.length === p.charged && p.charged > 0, `FL5: the precondition: placed, ${p.lava.length} lava of ${p.charged} charged`);
  const s0 = await lavaStock(H);
  await L.call('dev.journal.killAt', { point: 'FL5+save' }, 10_000);
  L.call('dev.region.remove', { region: p.region, requester: H.G.OWNER }, 3_600_000).catch(() => null);
  out.halted = await H.waitHalt('FL5+save');
  if (!out.halted) { check(false, 'FL5: the precondition: FL5 reached (an ordered record, its head drained before the pit)'); return out; }
  let disp = null, got = 0;
  try {
    await reopen(H, p.s.world, { holdDrain: true });
    const standing = await lavaAt(H, p.lava);
    out.standing = standing.length;
    const cell = standing.length ? top(standing) : null;
    if (cell) disp = await L.call('dev.dispense', { at: cell, item: 'minecraft:bucket' }, 30_000);
    await H.sleep(2500);
    const items = disp ? (await L.call('dev.dispense', { read: disp.dispenser }, 10_000)).items : {};
    out.dispensed = { cell, disp, items };
    const took = items['minecraft:lava_bucket'] ?? 0;
    check(standing.length > 0 && took === 1, `FL5: the precondition after the restart: ${standing.length} lava still stand (the head drained, the pit not); a dispenser took 1 (${json(items)})`);
    await L.call('dev.fluid.hold', { drain: false }, 10_000);
    out.final = await waitState(H, p.region, ['REMOVED', 'PARTIAL', 'FAILED']);
    await L.settle(2000);
    got = (await lavaStock(H)) - s0;
    out.refund = { got, took, charged: p.charged };
    log(`  FL5: ${json(out)}`);
    check(got + took === p.charged, `FL5 (P1-2a) conservation: refunded ${got} + the dispenser's ${took} == charged ${p.charged} (red on 8cT: the seen count FL5 saved is kept)`);
  } finally {
    await L.call('dev.fluid.hold', { drain: false }, 10_000).catch(() => null);
  }
  return out;
}

// ------------------------------------------------------------------ P1-2b: replay per record, not per chunk

/**
 * t5-drain-mixed (P1-2b). Placed, saved; removed with a water chunk B's writes dropped and TX:fluid.drain:apply:0+save armed: the pit's chunk
 * A on disk drained with its receipt, chunk B at its earlier save (no receipt). Restart with the drain held; a dispenser puts lava into a
 * chunk-A own cell (air now); released. The dispensed lava stays (no mark: never ours; chunk A's receipt present: never re-run) (red on 8cT:
 * the aggregate W's probe is ABSENT (B lacks the receipt), its apply redoes chunk A, and ownStillOurs calls the lava ours).
 */
export async function drainMixed(H) {
  const { L, check, log, json } = H;
  const out = {};
  const p = await placed(H, 'rs03t5dm');
  const groups = byChunk(p.lava);
  const A = groups[0];
  const others = A ? await waterChunks(H, p.box, A.chunk) : [];
  const B = others[0];
  out.split = { lava: groups.map((g) => [key(g.chunk), g.cells.length]), dropped: B ? key(B) : null };
  check(!!A && !!B, `DM: the precondition: the pit in ${json(out.split.lava)}, a water chunk of the record to lose (${out.split.dropped})`);
  if (!A || !B) return out;
  const s0 = await lavaStock(H);
  try {
    await L.call('dev.chunk.drop', { chunks: [B] }, 10_000);
    await L.call('dev.journal.killAt', { point: 'TX:fluid.drain:apply:0+save' }, 10_000);
    L.call('dev.region.remove', { region: p.region, requester: H.G.OWNER }, 3_600_000).catch(() => null);
    out.halted = await H.waitHalt('TX:fluid.drain:apply:0+save');
    await reopen(H, p.s.world, { holdDrain: true });
    const aStand = (await lavaAt(H, A.cells)).length;
    const bWater = (await H.L.call('dev.fluid.census', { box: [B[0] * 16, -64, B[1] * 16, B[0] * 16 + 15, 320, B[1] * 16 + 15] }, 600_000)).fluids.filter(([, , , st]) => String(st).startsWith('minecraft:water')).length;
    out.restart = { aStand, bWater };
    const cell = top(A.cells).slice(0, 3);
    const disp = await L.call('dev.dispense', { at: cell, item: 'minecraft:lava_bucket' }, 30_000).catch((e) => ({ error: String(e.message ?? e) }));
    await H.sleep(2500);
    const placedLava = (await lavaAt(H, [cell])).length === 1;
    out.dispensed = { cell, disp, placedLava };
    check(aStand === 0 && bWater > 0 && placedLava, `DM: the precondition: chunk ${key(A.chunk)} drained on disk (${aStand} lava standing), chunk ${key(B)} at its earlier save (${bWater} water cell(s)); a dispenser put lava at ${cell.join(',')} (${placedLava})`);
    await L.call('dev.fluid.hold', { drain: false }, 10_000);
    // judged when the drain txn has retired (the record drained), before the settle wait and the solids restore (the tile entry's undo
    // writes its own before-state over the cell afterwards, whatever stands there: not the drain's doing)
    let drained = null;
    for (let i = 0; i < 600 && !drained; i++) {
      const x = await L.call('dev.fluid.state', { region: p.region }, 10_000).catch(() => null);
      if (x && (x.removal === 'drained' || x.removal === 'done' || (x.bodies ?? []).some((b) => b.state === 'drained'))) drained = x;
      else await H.sleep(250);
    }
    const stays = (await lavaAt(H, [cell])).length === 1;
    out.final = await waitState(H, p.region, ['REMOVED', 'PARTIAL', 'FAILED']);
    await L.settle(2000);
    const staysAfterRemoved = (await lavaAt(H, [cell])).length === 1;
    const got = (await lavaStock(H)) - s0;
    out.after = { drainedSeen: drained ? { removal: drained.removal ?? null } : null, stays, staysAfterRemoved, refunded: got, charged: p.charged };
    log(`  DM: ${json(out)}`);
    check(!!drained, `DM: the precondition: the record read drained after the replay (${json(out.after.drainedSeen)})`);
    check(stays, `DM (P1-2b): the dispensed lava at ${cell.join(',')} stays through the drain's replay, judged as the record reads drained (red on 8cT: the aggregate W re-drains chunk ${key(A.chunk)} and erases it); after REMOVED: ${staysAfterRemoved} (recorded)`);
    check(got === p.charged, `DM (P1-2b) conservation: refunded ${got} == charged ${p.charged} (the dispensed bucket stands, the dispenser's)`);
  } finally {
    await L.call('dev.fluid.hold', { drain: false }, 10_000).catch(() => null);
    await L.call('dev.chunk.drop', { off: true }, 10_000).catch(() => null);
  }
  return out;
}

// ------------------------------------------------------------------ P1-2c: money before the barrier

/**
 * t5-scoop-barrier (P1-2c, N4). Placed, saved; the pit's chunk armed lost (dev.chunk.drop: no later save reaches it); removed and halted
 * bare at TX:fluid.drain:barrier:effects. On 8cT the drain txn's pile.scoop
 * has applied by then (the ledger saved at once) while the drained chunks are not on disk: the restart finds the lava standing and the
 * refund in the pile. With the drain held, the player buckets a restored source; released. Conservation: refunded + the player's 1 ==
 * charged (red on 8cT: the scoop already paid every cell, the restored source is taken as well: +1). On T5F the scoop is its own txn, not
 * begun before the drain's EFFECTS_DONE: the refund comes from the replayed receipts.
 */
export async function scoopBarrier(H) {
  const { ctx, L, check, log, json } = H;
  const out = {};
  const p = await placed(H, 'rs03t5sb');
  check(p.lava.length === p.charged && p.charged > 0, `SB: the precondition: placed, ${p.lava.length} lava of ${p.charged} charged`);
  const s0 = await lavaStock(H);
  let bucket = null;
  const C = byChunk(p.lava)[0];
  try {
    // the pit's chunk never saved after the placed save (8cT's ledger write and its other saves would otherwise flush it): the drain's
    // chunk is the one the barrier has not covered yet when the scoop's L is already durable
    if (C) await L.call('dev.chunk.drop', { chunks: [C.chunk] }, 10_000);
    await L.call('dev.journal.killAt', { point: 'TX:fluid.drain:barrier:effects' }, 10_000);
    L.call('dev.region.remove', { region: p.region, requester: H.G.OWNER }, 3_600_000).catch(() => null);
    out.halted = await H.waitHalt('TX:fluid.drain:barrier:effects');
    await reopen(H, p.s.world, { holdDrain: true });
    const standing = await lavaAt(H, p.lava);
    const paidEarly = (await lavaStock(H)) - s0;
    out.restart = { standing: standing.length, paidEarly };
    if (standing.length) bucket = await L.call('dev.player.bucket', { at: top(standing) }, 30_000);
    out.bucket = bucket;
    check(standing.length > 0 && bucket?.hand === 'minecraft:lava_bucket', `SB: the precondition: the drain's chunks lost with the halt (${standing.length} lava standing again; already in the pile: ${paidEarly}); the player bucketed one (${json(bucket)})`);
    await L.call('dev.fluid.hold', { drain: false }, 10_000);
    out.final = await waitState(H, p.region, ['REMOVED', 'PARTIAL', 'FAILED']);
    await L.settle(2000);
  } finally {
    await L.call('dev.fluid.hold', { drain: false }, 10_000).catch(() => null);
    await L.call('dev.chunk.drop', { off: true }, 10_000).catch(() => null);
  }
  const got = (await lavaStock(H)) - s0;
  const taken = bucket?.hand === 'minecraft:lava_bucket' ? 1 : 0;
  out.refund = { got, taken, charged: p.charged };
  log(`  SB: ${json(out)}`);
  check(got + taken === p.charged, `SB (P1-2c) conservation: refunded ${got} + the player's ${taken} == charged ${p.charged} (red on 8cT: the in-txn scoop paid before the barrier: ${got + taken - p.charged > 0 ? `minted ${got + taken - p.charged}` : 'exact'})`);
  return out;
}

// ------------------------------------------------------------------ P2-a: the grate's bars

/**
 * t5-grate-broken (P2-a, A; a REGRESSION row, green on dc814bb1: rule 5). The tiles wrote the grate (the write held); the player breaks 2
 * bars (a real break with an iron pickaxe: the bars in their inventory); released. The bars are not written again, and the removal's
 * refund excludes them. The contract expected red ("writeBody's guard covers only journaled bars"), but rs03's bars are the tiles' and so
 * journaled: 8cT's guard holds here. The grate case the journal gets wrong (ACTIVE, the chunk lost) is t5-tile-k4's for the lava.
 */
export async function grateBroken(H) {
  const { ctx, G, L, check, log, json } = H;
  const out = {};
  const fx = G.fixture(ctx, 'rs03_water');
  const entries = H.entriesOf(fx);
  try {
    const w = await H.rsTilesWritten('rs03t5gb', fx, entries);
    const rec = (await G.rsState(ctx, w.region)).record ?? {};
    const chargedBars = rec.charged?.['minecraft:iron_bars'] ?? 0;
    const bars = (await L.call('dev.blocks.find', { box: w.box, block: 'minecraft:iron_bars' }, 60_000)).cells ?? [];
    out.pre = { bars: bars.length, chargedBars };
    const pick = bars.slice(0, 2);
    const broke = [];
    for (const c of pick) broke.push(await L.call('dev.player.break', { at: c }, 30_000));
    const held = broke.reduce((a, b) => a + (b.collected?.['minecraft:iron_bars'] ?? 0), 0);
    out.broke = { cells: pick, held, answers: broke.map((b) => ({ broken: b.broken, wouldDrop: b.wouldDrop, after: b.after, collected: b.collected })) };
    check(bars.length >= 2 && chargedBars > 0 && held === 2, `GB: the precondition: the tiles wrote ${bars.length} bar(s) (${chargedBars} charged); the player broke 2 and holds ${held}`);
    await L.call('dev.fluid.hold', { write: false, settle: true }, 10_000);
    let fs1 = null;
    for (let i = 0; i < 180; i++) { fs1 = await L.call('dev.fluid.state', { region: w.region }, 10_000).catch(() => null); if (fs1?.phase === 'settling' || fs1?.phase === 'settled') break; await H.sleep(1000); }
    await H.sleep(3000);
    const now = (await L.call('dev.blocks.find', { box: w.box, block: 'minecraft:iron_bars' }, 60_000)).cells ?? [];
    const rewritten = pick.filter((c) => now.some((q) => q[0] === c[0] && q[1] === c[1] && q[2] === c[2])).length;
    out.after = { phase: fs1?.phase, rewritten };
    check(rewritten === 0, `GB (P2-a): the broken bars are never written again: ${rewritten} of 2 rewritten (a regression: 8cT's journal guard covers the tiles' bars)`);
    const b0 = await barsStock(H);
    await G.remove(ctx, w.region);
    const got = (await barsStock(H)) - b0;
    out.refund = { got, held, chargedBars };
    log(`  GB: ${json(out)}`);
    check(got + held === chargedBars, `GB (A) conservation: bars refunded ${got} + the player's ${held} == charged ${chargedBars}`);
  } finally {
    await L.call('dev.fluid.hold', { write: false, settle: false }, 10_000).catch(() => null);
  }
  return out;
}

// ------------------------------------------------------------------ S3 / S4 / Q1-Q3: the removal's answers

/**
 * t5-s3a (S3 a, c): the removal future, undoRevision's and RemovalFinished complete only after region.scoop reaches EFFECTS_DONE, with one
 * refund total. Not built until T5Fc (the kind region.scoop). Green: with a kill-point trace on, the trace at the future's completion holds
 * TX:region.scoop:effects, and the refund == charged.
 */
export async function s3a(H) {
  const { L, check, log, json } = H;
  const ks = await kinds(H);
  if (!ks.includes('region.scoop')) { check(false, `S3a: not built: the txn kind region.scoop (T5Fc; kinds now ${json(ks)})`); return { kinds: ks }; }
  const p = await placed(H, 'rs03t5s3a');
  const s0 = await lavaStock(H);
  await L.call('dev.txn.trace', { on: true }, 10_000);
  const r = await L.call('dev.region.remove', { region: p.region, requester: H.G.OWNER }, 3_600_000);
  const trace = (await L.call('dev.txn.trace', { on: false }, 10_000)).trace ?? []; // (T5Fc fix round) the hook answers `trace`
  const got = (await lavaStock(H)) - s0;
  const refundLava = r.refund?.['minecraft:lava_bucket'] ?? null;
  const out = { scoopDone: trace.includes('TX:region.scoop:effects'), refundLava, got, charged: p.charged };
  log(`  S3a: ${json(out)}`);
  check(out.scoopDone, `S3a (a): the removal future completed after region.scoop's EFFECTS_DONE (TX:region.scoop:effects in the trace)`);
  check(got === p.charged && (refundLava === null || refundLava >= p.charged), `S3a (c): one refund total per removal: ${got} == ${p.charged} charged (the RemoveResult's lava ${refundLava})`);
  return out;
}

/**
 * t5-s3b (S3 b, c; the coordinator's crash row at TX:fluid.drain:effects -> region.scoop:begin): halted bare after the drain's EFFECTS_DONE,
 * before the scoop's persist; recovery begins the scoop from the durable receipt index, and RemovalFinished carries its total, once.
 * Not built until T5Fc (region.scoop, and a way to read RemovalFinished: dev.api.removalEvents).
 */
export async function s3b(H) {
  const { L, check, log, json } = H;
  const ks = await kinds(H);
  if (!ks.includes('region.scoop')) { check(false, `S3b: not built: the txn kind region.scoop (T5Fc; kinds now ${json(ks)})`); return { kinds: ks }; }
  const ev0 = await L.call('dev.api.removalEvents', {}, 10_000).catch((e) => ({ error: String(e.message ?? e) }));
  if (ev0.error) { check(false, `S3b: not built: dev.api.removalEvents (the RemovalFinished events seen; T5Fc): ${ev0.error}`); return {}; }
  const p = await placed(H, 'rs03t5s3b');
  const s0 = await lavaStock(H);
  await L.call('dev.journal.killAt', { point: 'TX:fluid.drain:effects' }, 10_000);
  L.call('dev.region.remove', { region: p.region, requester: H.G.OWNER }, 3_600_000).catch(() => null);
  const halted = await H.waitHalt('TX:fluid.drain:effects');
  await reopen(H, p.s.world);
  const fin = await waitState(H, p.region, ['REMOVED', 'PARTIAL', 'FAILED']);
  await L.settle(2000);
  const got = (await lavaStock(H)) - s0;
  const ev = (await L.call('dev.api.removalEvents', { region: p.region }, 10_000)).events ?? [];
  const lava = ev.map((e) => e.refund?.['minecraft:lava_bucket'] ?? 0);
  const out = { halted, fin, got, charged: p.charged, events: ev.length, lava };
  log(`  S3b: ${json(out)}`);
  check(got === p.charged, `S3b (b): the scoop begun by recovery from the receipt index: refunded ${got} == ${p.charged}`);
  check(ev.length === 1 && lava[0] === p.charged, `S3b (b, c): one RemovalFinished, carrying the scoop's total: ${ev.length} event(s), lava ${json(lava)}`);
  return out;
}

/**
 * t5-taken (S4, Q2): a player buckets one written lava source; Regions.remove's RemoveResult carries fluidsTaken {lava_bucket: 1} and
 * fluidsTakenCells 1, report only (the refund is the standing cells'). Not built until T5Fc (RemoveResult.fluidsTaken, fluidsTakenCells).
 */
export async function taken(H) {
  const { L, check, log, json } = H;
  const p = await placed(H, 'rs03t5tk');
  const b = await L.call('dev.player.bucket', { at: top(p.lava) }, 30_000);
  check(b?.hand === 'minecraft:lava_bucket', `TAKEN: the precondition: the player bucketed one of ${p.lava.length} (${json(b)})`);
  await save(H);
  const s0 = await lavaStock(H);
  const r = await L.call('dev.region.remove', { region: p.region, requester: H.G.OWNER }, 3_600_000);
  await waitState(H, p.region, ['REMOVED', 'PARTIAL', 'FAILED']);
  const got = (await lavaStock(H)) - s0;
  const out = { fluidsTaken: r.fluidsTaken, fluidsTakenCells: r.fluidsTakenCells, refunded: got, charged: p.charged };
  log(`  TAKEN: ${json(out)}`);
  if (!('fluidsTaken' in r) || !('fluidsTakenCells' in r)) {
    check(false, `TAKEN (S4/Q2): not built: RemoveResult.fluidsTaken / fluidsTakenCells (T5Fc) absent from Regions.remove's answer (${json(Object.keys(r))})`);
    return out;
  }
  check(r.fluidsTaken?.['minecraft:lava_bucket'] === 1 && r.fluidsTakenCells === 1, `TAKEN (S4/Q2): fluidsTaken ${json(r.fluidsTaken)} (lava_bucket 1) and fluidsTakenCells ${r.fluidsTakenCells} (1)`);
  check(got === p.charged - 1, `TAKEN conservation: refunded ${got} == ${p.charged} - 1 (report only: the taken cell is never refunded)`);
  return out;
}

/**
 * t5-tombstone (8cS Q1): after REMOVED, the region's tombstone keeps its final architect_mc:fluids rows (each body's final state; a capped
 * removal's foreign and foreignCount), and fluidsRemoval is null. Read two ways: the tombstone on disk (architect-regions/<id>/removed.json,
 * its ext) and the API's view (dev.region.state, when it serves a tombstone at all: on dc814bb1 it does not). On dc814bb1 the rows are
 * kept but stale (the placement's `settled`, never the removal's final states). The capped foreign part is not exercised here.
 */
export async function tombstone(H) {
  const { L, check, log, json } = H;
  const p = await placed(H, 'rs03t5q1');
  const live = (await L.call('dev.region.state', { region: p.region }, 60_000)).view?.ext?.['architect_mc:fluids'] ?? [];
  await L.call('dev.region.remove', { region: p.region, requester: H.G.OWNER }, 3_600_000);
  const fin = await waitState(H, p.region, ['REMOVED', 'PARTIAL', 'FAILED']);
  await L.settle(2000);
  const st = await L.call('dev.region.state', { region: p.region }, 60_000).catch((e) => ({ error: String(e.message ?? e) }));
  const f = path.join(L.SAVES, p.s.world, 'architect-regions', p.region, 'removed.json');
  const disk = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  const rows = disk?.ext?.['architect_mc:fluids'] ?? null;
  const viewRows = st.view?.ext?.['architect_mc:fluids'] ?? null;
  const fr = disk?.ext?.['architect_mc:fluidsRemoval'] ?? null;
  const out = { fin, view: st.view ? { state: st.view.state, rows: viewRows ? viewRows.length : null } : (st.error ?? 'no view'), tombstone: !!disk, liveRows: live.length, rows: rows ? rows.map((r) => [r.body, r.state, r.foreignCount ?? null]) : null, fluidsRemoval: fr };
  log(`  Q1: ${json(out)}`);
  check(fin === 'REMOVED' && !!disk && live.length > 0, `Q1: the precondition: placed with ${live.length} fluids row(s), removed, its tombstone on disk (${f}: ${!!disk})`);
  check(!!rows && rows.length === live.length && rows.every((r) => r.state), `Q1: the tombstone keeps its final fluids rows: ${rows ? rows.length : 'none'} of ${live.length} (${json(out.rows)})`);
  const stale = (rows ?? []).filter((r) => r.state === 'settled' || r.state === 'written' || r.state === 'pending');
  check(!!rows && stale.length === 0, `Q1: the rows are the removal's final truth, frozen at its done (each body drained, none still reads its placement state): ${stale.length} of ${rows ? rows.length : 0} still read ${json([...new Set(stale.map((r) => r.state))])}`);
  check(fr === null, `Q1: fluidsRemoval is null on the tombstone (${json(fr)})`);
  return out;
}

/**
 * (slice T5Fc, contract §7 TX matrix: fluid.drain and region.scoop on rs03 in survival) rs03 placed (lava and grate charged), removed and
 * halted at each point, +save and bare: the restart replays the open txns; the region ends REMOVED, the lava refunded exactly once
 * (the pile's lava buckets back by the charge: no mint, no loss) and one REMOVAL_FINISHED carrying it (S3 c).
 */
export async function removeTx(H, points) {
  const { L, check, log, json } = H;
  const out = {};
  for (const p0 of points) {
    for (const point of [`${p0}+save`, p0]) {
      const tag = `rs03t5rx${p0.replace(/[^a-z]/gi, '').slice(-12)}${point.endsWith('+save') ? 's' : 'b'}`;
      const p = await placed(H, tag);
      const s0 = await lavaStock(H);
      await L.call('dev.journal.killAt', { point }, 10_000);
      L.call('dev.region.remove', { region: p.region, requester: H.G.OWNER }, 3_600_000).catch(() => null);
      const halted = await H.waitHalt(point);
      if (!halted) {
        check(false, `RX (${point}): the precondition: the kill point halted the server`);
        continue;
      }
      await reopen(H, p.s.world);
      const fin = await waitState(H, p.region, ['REMOVED', 'PARTIAL', 'FAILED']);
      await L.settle(2000);
      const got = (await lavaStock(H)) - s0;
      const ev = (await L.call('dev.api.removalEvents', { region: p.region }, 10_000).catch(() => ({ events: [] }))).events ?? [];
      out[tag] = { fin, got, charged: p.charged, events: ev.length };
      log(`  RX: ${json(out[tag])}`);
      check(fin === 'REMOVED' && got === p.charged, `RX (${point}): replayed once: ${fin}, lava refunded ${got} == ${p.charged} charged`);
      check(ev.length <= 1 && ev.every((e) => (e.refund?.['minecraft:lava_bucket'] ?? 0) === p.charged), `RX (${point}): at most one REMOVAL_FINISHED this session, carrying the whole refund (S3 c): ${json(ev.map((e) => e.refund))}`);
    }
  }
  return out;
}
