// (slice T5Fa, CONTRACT T5F §7) The failing-first rows on rs03_water in survival (its paid lava pit and its grate), run by
// tools/gate6crs.mjs (steps t5*). Each row has a precondition check (it must PASS: the scenario really happened) and a target check (red on
// dc814bb1 + the T5Fa hooks commit for the reason the contract names, green on T5Fb/T5Fc). A row whose target needs a structure T5F has not
// built yet probes for it first and fails "not built: ..." without running the scenario. Hooks: docs in the T5Fa prep notes
// (architect-T5F-prep-notes.md) and each hook's own help text (SliceT5FDev).
//
// H: {ctx, G, L, check, log, json, sleep, cmd, entriesOf, rsTilesWritten, waitHalt, LAVA}

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

/** After a halt: the JVM is up again (not in a world); `before` arms TEST flags in the new JVM, then the world opens. */
async function reopen(H, world, before = async () => {}) {
  await before();
  await H.L.openWorld(world);
}

// ------------------------------------------------------------------ P1-1: the tile's ACTIVE without its chunk

/**
 * t5-tile-k4 / t5-tile-k4-rm (P1-1). rs03 in survival; a save at the fluids gate (dev.fluid.saveAtGate: every earlier stage on disk); the
 * tiles write the lava, the write held (journal ACTIVE for the tiles). Then chunk B's snapshot is lost (dev.chunk.drop) and the rest saved
 * and halted (dev.chunk.halt save): the on-disk state of a bare crash at the fluids tile's K4 (ACTIVE durable, the chunk not), reached
 * without arming K4 (global: it would halt at the first tile of any stage; a fluids-only K4 alias needs InfraJob, a T4 file).
 * Restart with the write held: the precondition (B's lava absent, the tiles' entries ACTIVE). Then `rm` false: the write runs and must
 * write B's cells (red: RegionFluids writeBody skips them as journaled); `rm` true: removed before the write, the refund must include B's
 * paid cells as u (red: the scoop refunds an absent charged cell only when the journal says unwritten).
 */
export async function tileK4(H, rm) {
  const { ctx, G, L, check, log, json } = H;
  const tag = rm ? 'rs03t5k4rm' : 'rs03t5k4';
  const out = {};
  const fx = G.fixture(ctx, 'rs03_water');
  const entries = H.entriesOf(fx);
  await L.call('dev.fluid.saveAtGate', {}, 10_000);
  try {
    const w = await H.rsTilesWritten(tag, fx, entries);
    const charged = (await G.rsState(ctx, w.region)).record?.charged?.['minecraft:lava_bucket'] ?? 0;
    const groups = byChunk(w.lava);
    const B = groups.at(-1);
    out.split = groups.map((g) => [key(g.chunk), g.cells.length]);
    const js = await L.call('dev.journal.state', {}, 60_000);
    const active = (js.entries ?? []).filter((e) => String(e.site).includes(w.region) && String(e.site).includes('fluids') && e.status === 'ACTIVE').length;
    out.pre = { lava: w.lava.length, charged, active, split: out.split };
    check(!!B && w.lava.length === charged && charged > 0 && active > 0, `K4 (${tag}): the precondition before the halt: ${w.lava.length} lava written by the tiles of ${charged} charged, ${active} fluids tile entr(y/ies) ACTIVE, per chunk ${json(out.split)}`);
    if (!B) return out;
    await L.call('dev.chunk.drop', { chunks: [B.chunk] }, 10_000);
    L.call('dev.chunk.halt', { save: true }, 60_000).catch(() => null);
    out.halted = await H.waitHalt('dev.chunk.halt');
    await reopen(H, w.s.world, async () => { await L.call('dev.fluid.hold', { write: true, settle: true }, 10_000); });
    await H.sleep(5000);
    const lost = B.cells.length - (await lavaAt(H, B.cells)).length;
    const js2 = await L.call('dev.journal.state', {}, 60_000);
    const active2 = (js2.entries ?? []).filter((e) => String(e.site).includes(w.region) && String(e.site).includes('fluids') && e.status === 'ACTIVE').length;
    out.restart = { lost, of: B.cells.length, active: active2 };
    check(lost === B.cells.length && active2 > 0, `K4 (${tag}): the precondition after the restart: chunk ${key(B.chunk)}'s ${lost} of ${B.cells.length} lava cell(s) lost with its snapshot, ${active2} fluids tile entr(y/ies) still ACTIVE (the journal apart from the chunk)`);
    if (!rm) {
      await L.call('dev.fluid.hold', { write: false, settle: true }, 10_000);
      let fs1 = null;
      for (let i = 0; i < 180; i++) { fs1 = await L.call('dev.fluid.state', { region: w.region }, 10_000).catch(() => null); if (fs1?.phase === 'settling' || fs1?.phase === 'settled' || fs1?.phase === 'done') break; await H.sleep(1000); }
      await H.sleep(3000);
      const back = (await lavaAt(H, B.cells)).length;
      const all = (await lavaAt(H, w.lava)).length;
      out.written = { phase: fs1?.phase, back, of: B.cells.length, all, charged };
      log(`  K4 (${tag}): ${json(out)}`);
      check(back === B.cells.length && all === charged, `K4 (${tag}, P1-1): the stage's write writes chunk ${key(B.chunk)}'s lost cells again (mark none, cell open: §3.3 row 1): ${back} of ${B.cells.length} written, ${all} of ${charged} standing (red on 8cT: writeBody skips them as journaled)`);
      const s0 = await lavaStock(H);
      await G.remove(ctx, w.region);
      const got = (await lavaStock(H)) - s0;
      out.refund = got;
      check(got === charged, `K4 (${tag}) conservation: removed after the write: refunded ${got} of ${charged} charged (every paid cell standing, then scooped)`);
    } else {
      const standing = (await lavaAt(H, w.lava)).length;
      const s0 = await lavaStock(H);
      await G.remove(ctx, w.region);
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
 * t5-drain-hold (P1-2a). Placed (the lava over 2 chunks), saved; the removal's drain held at one chunk (dev.fluid.holdChunk: on 8cT inside
 * its seen loop, so the chunks before it already carry their seen counts); the player buckets a source in a chunk whose evidence was
 * saved before the hold; released. Conservation: refunded + the player's 1 == charged (red on 8cT: the chunk's seen count was written
 * before the hold and kept: refunded == charged, one minted).
 */
export async function drainHold(H) {
  const { ctx, L, check, log, json } = H;
  const out = {};
  const p = await placed(H, 'rs03t5dh');
  const groups = byChunk(p.lava);
  out.split = groups.map((g) => [key(g.chunk), g.cells.length]);
  check(groups.length >= 2 && p.lava.length === p.charged && p.charged > 0, `DH: the precondition: placed, ${p.lava.length} lava of ${p.charged} charged over ${groups.length} chunk(s) ${json(out.split)} (2 wanted)`);
  if (groups.length < 2) return out;
  const s0 = await lavaStock(H);
  let bucket = null;
  try {
    let hold = groups[1];
    await L.call('dev.fluid.holdChunk', { x: hold.chunk[0], z: hold.chunk[1] }, 10_000);
    L.call('dev.region.remove', { region: p.region, requester: H.G.OWNER }, 3_600_000).catch(() => null);
    let before = [];
    for (let i = 0; i < 60 && !before.length; i++) {
      await H.sleep(1000);
      before = (await L.call('dev.fluid.holdChunk', {}, 10_000)).before ?? [];
      if (i === 25 && !before.length) { hold = groups[0]; await L.call('dev.fluid.holdChunk', { x: hold.chunk[0], z: hold.chunk[1] }, 10_000); }
    }
    out.held = { at: key(hold.chunk), before };
    const A = groups.find((g) => before.includes(key(g.chunk)));
    const cell = A ? top(A.cells) : null;
    if (cell) bucket = await L.call('dev.player.bucket', { at: cell }, 30_000);
    out.bucket = bucket;
    check(!!A && bucket?.hand === 'minecraft:lava_bucket', `DH: the precondition: the drain held at chunk ${out.held.at} with chunk(s) ${json(before)} counted before it; the player bucketed ${cell ? cell.join(',') : 'nothing'} there (${json(bucket)})`);
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
    await reopen(H, p.s.world, async () => { await L.call('dev.fluid.hold', { drain: true }, 10_000); });
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
 * t5-drain-mixed (P1-2b). Placed (2 chunks), saved; removed with chunk B's writes dropped and TX:fluid.drain:apply:0+save armed: chunk A on
 * disk drained with its receipt, chunk B at its earlier save (lava standing, no receipt). Restart with the drain held; a dispenser puts lava
 * into a chunk-A own cell (air now); released. The dispensed lava stays (no mark: never ours; chunk A's receipt present: never re-run)
 * (red on 8cT: the aggregate W's probe is ABSENT (B lacks the receipt), its apply redoes chunk A, and ownStillOurs calls the lava ours).
 */
export async function drainMixed(H) {
  const { ctx, L, check, log, json } = H;
  const out = {};
  const p = await placed(H, 'rs03t5dm');
  const groups = byChunk(p.lava);
  out.split = groups.map((g) => [key(g.chunk), g.cells.length]);
  check(groups.length >= 2, `DM: the precondition: the lava over ${groups.length} chunk(s) ${json(out.split)} (2 wanted)`);
  if (groups.length < 2) return out;
  const [A, B] = groups;
  const s0 = await lavaStock(H);
  try {
    await L.call('dev.chunk.drop', { chunks: [B.chunk] }, 10_000);
    await L.call('dev.journal.killAt', { point: 'TX:fluid.drain:apply:0+save' }, 10_000);
    L.call('dev.region.remove', { region: p.region, requester: H.G.OWNER }, 3_600_000).catch(() => null);
    out.halted = await H.waitHalt('TX:fluid.drain:apply:0+save');
    await reopen(H, p.s.world, async () => { await L.call('dev.fluid.hold', { drain: true }, 10_000); });
    const aStand = (await lavaAt(H, A.cells)).length, bStand = (await lavaAt(H, B.cells)).length;
    out.restart = { aStand, bStand };
    const cell = top(A.cells);
    const disp = await L.call('dev.dispense', { at: cell, item: 'minecraft:lava_bucket' }, 30_000).catch((e) => ({ error: String(e.message ?? e) }));
    await H.sleep(2500);
    const placedLava = (await lavaAt(H, [cell])).length === 1;
    out.dispensed = { cell, disp, placedLava };
    check(aStand === 0 && bStand === B.cells.length && placedLava, `DM: the precondition: chunk ${key(A.chunk)} drained on disk (${aStand} standing), chunk ${key(B.chunk)} not (${bStand} of ${B.cells.length}); a dispenser put lava at ${cell.join(',')} (${placedLava})`);
    await L.call('dev.fluid.hold', { drain: false }, 10_000);
    out.final = await waitState(H, p.region, ['REMOVED', 'PARTIAL', 'FAILED']);
    await L.settle(2000);
    const stays = (await lavaAt(H, [cell])).length === 1;
    const got = (await lavaStock(H)) - s0;
    out.after = { stays, refunded: got, charged: p.charged };
    log(`  DM: ${json(out)}`);
    check(stays, `DM (P1-2b): the dispensed lava at ${cell.join(',')} stays after the replay (red on 8cT: the aggregate W re-drains chunk ${key(A.chunk)} and erases it)`);
    check(got === p.charged, `DM (P1-2b) conservation: refunded ${got} == charged ${p.charged} (the dispensed bucket is the dispenser's, standing)`);
  } finally {
    await L.call('dev.fluid.hold', { drain: false }, 10_000).catch(() => null);
    await L.call('dev.chunk.drop', { off: true }, 10_000).catch(() => null);
  }
  return out;
}

// ------------------------------------------------------------------ P1-2c: money before the barrier

/**
 * t5-scoop-barrier (P1-2c, N4). Placed, saved; removed and halted bare at TX:fluid.drain:barrier:effects. On 8cT the drain txn's pile.scoop
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
  try {
    await L.call('dev.journal.killAt', { point: 'TX:fluid.drain:barrier:effects' }, 10_000);
    L.call('dev.region.remove', { region: p.region, requester: H.G.OWNER }, 3_600_000).catch(() => null);
    out.halted = await H.waitHalt('TX:fluid.drain:barrier:effects');
    await reopen(H, p.s.world, async () => { await L.call('dev.fluid.hold', { drain: true }, 10_000); });
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
 * t5-grate-broken (P2-a, A). The tiles wrote the grate (the write held); the player breaks 2 bars (a real break with an iron pickaxe: the
 * bars in their inventory); released. The bars are not written again, and the removal's refund excludes them (red on 8cT: writeBody's
 * journal guard covers only bars the journal says the tiles wrote; a broken bar's cell is open and rewritten).
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
    out.broke = { cells: pick, held };
    check(bars.length >= 2 && chargedBars > 0 && held === 2, `GB: the precondition: the tiles wrote ${bars.length} bar(s) (${chargedBars} charged); the player broke 2 and holds ${held}`);
    await L.call('dev.fluid.hold', { write: false, settle: true }, 10_000);
    let fs1 = null;
    for (let i = 0; i < 180; i++) { fs1 = await L.call('dev.fluid.state', { region: w.region }, 10_000).catch(() => null); if (fs1?.phase === 'settling' || fs1?.phase === 'settled') break; await H.sleep(1000); }
    await H.sleep(3000);
    const now = (await L.call('dev.blocks.find', { box: w.box, block: 'minecraft:iron_bars' }, 60_000)).cells ?? [];
    const rewritten = pick.filter((c) => now.some((q) => q[0] === c[0] && q[1] === c[1] && q[2] === c[2])).length;
    out.after = { phase: fs1?.phase, rewritten };
    check(rewritten === 0, `GB (P2-a): the broken bars are never written again: ${rewritten} of 2 rewritten (red on 8cT: the open rule rewrites them)`);
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
  const trace = (await L.call('dev.txn.trace', { on: false }, 10_000)).points ?? [];
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
 * removal's foreign and foreignCount), and fluidsRemoval is null. The rows are read from dev.region.state once the removal future completed.
 */
export async function tombstone(H) {
  const { L, check, log, json } = H;
  const p = await placed(H, 'rs03t5q1');
  const live = (await L.call('dev.region.state', { region: p.region }, 60_000)).view?.ext?.['architect_mc:fluids'] ?? [];
  await L.call('dev.region.remove', { region: p.region, requester: H.G.OWNER }, 3_600_000);
  const fin = await waitState(H, p.region, ['REMOVED', 'PARTIAL', 'FAILED']);
  await L.settle(2000);
  const st = await L.call('dev.region.state', { region: p.region }, 60_000).catch((e) => ({ error: String(e.message ?? e) }));
  const rows = st.view?.ext?.['architect_mc:fluids'] ?? null;
  const fr = st.view?.fluidsRemoval ?? st.fluidsRemoval ?? null;
  const out = { fin, state: st.view?.state ?? st.error, liveRows: live.length, rows: rows ? rows.map((r) => [r.body, r.state, r.foreignCount ?? null]) : null, fluidsRemoval: fr };
  log(`  Q1: ${json(out)}`);
  check(fin === 'REMOVED' && live.length > 0, `Q1: the precondition: placed with ${live.length} fluids row(s), removed (${fin})`);
  check(!!rows && rows.length === live.length && rows.every((r) => r.state), `Q1: the tombstone keeps its final fluids rows: ${rows ? rows.length : 'none'} of ${live.length} (${json(out.rows)})`);
  check(fr === null, `Q1: fluidsRemoval is null on the tombstone (${json(fr)})`);
  return out;
}
