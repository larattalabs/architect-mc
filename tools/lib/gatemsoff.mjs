// Slice SOFF gate: while any level has saving off (/save-off, or another mod's noSave), Architect admits no operation that changes the
// stockpile ledger or moves paid items (SaveHold), and no ledger save publishes over a save that did not write every level with the
// players (SaveEvidence). saveAllChunks skips a level with saving off unless forced, so before SOFF the ledger went on disk ahead of the
// world (a mint, a loss); with SOFF's first round alone (551ed9ac) inserts went on while their credit could not be saved (a loss).
// Registered into tools/gate6dgr.mjs (GR's survival town and halt helpers). Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs soffcrash   (soff-crash)   one survival world, a stockpile of 4 crates, a town realised with every target paused.
//     Each case: a baseline (/save-all flush, saving on: the disk ledger read back), the case, a halt with nothing else saved, the world
//     opened again (saving on: the flags are not kept), then conservation over everything the items can be in near the claim (chests,
//     hoppers and other containers, item entities, the player's inventory, the stockpile) and the disk ledger at the halt against the
//     snapshot the hold says is durable:
//       P  a hopper line into a crate, /save-off, 25 s (the periodic save ticking): the crates take nothing while held
//       A  the same with the periodic save off and a vanilla autosave (dev.stockpile.ps autosave)
//       M  mixed dimensions: the Nether's saving turned off directly (dev.stockpile.ps noSave, as another mod would), the Overworld on,
//          then a hopper line into an Overworld crate, an autosave: held in every dimension (the ledger is shared)
//       D  a deposit (Insert from inventory) admitted just before /save-off, then an autosave and a logout (both save the player): /save-off
//          saved the pending deposit first, so the disk ledger holds it
//       F  saving on: a deposit, then another mod's raw saveAllChunks(true, true, true) (no players): no ledger publish over it
//       B  targets unpaused and fed, /save-off: no feed, no fill, no payment while held; /save-on: held until a confirmed save, then the
//          build resumes; the ledger's identity holds after a halt
//       W  the region removed (credit), the inventory full, /save-off, a Take: refused naming the dimension and /save-on
//     (slice SOFF2, failing-first on 987eb93e; TEST hooks in dev.stockpile.ps, SaveTestHooks):
//       N  saving on, a deposit, an autosave inside whose player save (before the players are written) another mod runs a raw
//          saveAllChunks(true, true, true), then a halt: no ledger publish rides on it (the players were not saved with it)
//       E  the same raw save from inside the autosave's BEFORE_SAVE: exactly one ledger publish (the autosave's own; the nested save's
//          record is its own, never the outer one's)
//       X  a pending ledger, /save-off, and an Insert from inventory from inside /save-off's own barrier (BEFORE_SAVE of its chunk
//          save): refused (admission closed before the barrier); a halt then is exact
//       S  targets fed and building, a flush, more cells built, an autosave halted before its ledger (AS1: the world ahead of the
//          ledger), the world opened again with every level's saving off: the start's reconcile finds the ahead cells against the
//          books the world was saved with (not the release's refreshed ones); after /save-on and the release no cell stands unpaid
//     B also compares the cell books, custody and fill markers, and asserts the build's resumed progress after the release.
//
// Evidence: artifacts/gate6d-gr/soffcrash.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';

export async function registerSOFF(steps, h) {
  const { L, call, check, cmd, log, OUT, json, G, ensure, spendZero, groundY, CX, CZ, CLAIM, haltWait } = h;
  const caps = (await import('./gatebcc.mjs')).bccCaps({ call, check, json, G, owner: G.OWNER, log });
  const ctx = { L, OUT, imp: h.imp };
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];
  const ledgerOf = (root) => (root?.stockpiles ?? []).find((p) => p.owner === G.OWNER)?.ledger ?? null;
  const saved = async () => call('dev.stockpile.saved', {}, 60_000);
  const ps = async (o) => call('dev.stockpile.ps', o, 120_000);
  const audit = async (box) => call('dev.stockpile.audit', { owner: G.OWNER, ...(box ? { min: box.min, max: box.max } : {}) }, 60_000);
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  /** The ledger's item records (what conservation is judged on; the cell books and keys aside). */
  const books = (l) => json(sorted(Object.fromEntries(['delivered', 'returned', 'consumed', 'withdrawn', 'dropped', 'refundOverflow', 'paid'].map((k) => [k, l?.[k] ?? {}]))));
  /** (SOFF2) B's comparison: the item records plus the cell books, custody and fill markers. */
  const booksAll = (l) => json(sorted(Object.fromEntries(['delivered', 'returned', 'consumed', 'withdrawn', 'dropped', 'refundOverflow', 'paid', 'cells', 'custody', 'filled', 'provided', 'heldProvided', 'pendingCredit'].map((k) => [k, l?.[k] ?? {}]))));
  /** (SOFF2) every target the stockpile feeds now (the feed order at the start, and any that joined since). */
  const targetIds = async () => {
    const st = (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
    return [...new Set([...(st.feedOrder ?? []), ...Object.keys(st.targets ?? {})])];
  };
  const targetsLine = async () => json(Object.fromEntries(Object.entries((await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile?.targets ?? {})
    .map(([k, x]) => [k, [x.built, x.queued, x.paused ? 'paused' : 'on', x.frontierLoaded ? 'loaded' : 'unloaded', x.reserves ? 'reserves' : '-', json(x.outstanding ?? {}).slice(0, 80)]])));
  /** (SOFF2) What the targets still lack beyond the stock, per item. */
  const lacking = async () => {
    const st = (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
    let want = {};
    for (const x of Object.values(st.targets ?? {})) want = G.plus(want, x.outstanding ?? {});
    const o = {};
    for (const [it, v] of Object.entries(want)) { const l = v - (st.stock?.[it] ?? 0); if (l > 0) o[it] = l; }
    return o;
  };
  /** (SOFF2) The item the targets lack most now, and up to a stack of it: an Insert from inventory takes it. */
  const needed = async () => {
    const [it, n] = Object.entries(await lacking()).sort((a, b) => b[1] - a[1])[0] ?? [];
    return it ? [it, Math.min(64, n)] : [null, 0];
  };
  const unpauseAll = async () => { for (const id of await targetIds()) await call('dev.stockpile.pause', { owner: G.OWNER, site: id, paused: false }, 60_000).catch(() => null); };
  const pauseAll = async () => { for (const id of await targetIds()) await call('dev.stockpile.pause', { owner: G.OWNER, site: id, paused: true }, 60_000).catch(() => null); };
  /** (SOFF2) The build's progress: every unit the targets consumed so far (a target leaves the feed once built, so not its cells). */
  const builtSum = async () => sum((await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile?.ledger?.consumed ?? {});
  const pos = (m) => Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => v > 0));
  /** (as gatem5rl's) standing paid cells against the targets' paid records. */
  function balance(a) {
    const l = a.ledger ?? {};
    const standing = G.plus(a.paidStanding ?? {}, {});
    for (const k of ['fluidStanding', 'mechStanding']) for (const [it, n] of Object.entries(a[k] ?? {})) standing[it] = (standing[it] ?? 0) - n;
    const paid = Object.values(l.paid ?? {}).reduce((x, m) => G.plus(x, m), {});
    return { standing: sum(standing), paid: sum(paid), dupe: pos(G.minus(standing, paid)), dupeUnits: sum(pos(G.minus(standing, paid))), doubleUnits: sum(pos(G.minus(paid, standing))) };
  }
  let W;
  const diskLedger = () => ledgerOf(JSON.parse(fs.readFileSync(path.join(W.dir, 'architect', 'stockpiles.json'), 'utf8')));

  async function halt(tag, { send = true } = {}) {
    if (send) call('dev.stockpile.halt', {}, 10_000).catch(() => null); // the halt drops the call (else a hook halted it)
    const down = await haltWait();
    check(down, `${tag}: halted with nothing else saved`);
    if (!down) return null;
    const disk = diskLedger();
    await L.openWorld(path.basename(W.dir));
    await L.tp(W.at[0], W.at[1], W.at[2]);
    await call('dev.wait', { ms: 3000 }, 30_000);
    await caps.afterRestart(tag); // (BC-c) the reconcile inside the region's maxBill
    return { disk };
  }

  /** Per item over `items`: containers + item entities + the player's inventory + the stock, in the claim's box. */
  async function totals(items) {
    const a = await audit(W.box);
    const t = {};
    for (const k of items) t[k] = (a.containers?.[k] ?? 0) + (a.entities?.[k] ?? 0) + (a.inventory?.[k] ?? 0) + (a.stock?.[k] ?? 0);
    return { t, stock: Object.fromEntries(items.map((k) => [k, a.stock?.[k] ?? 0])), inv: Object.fromEntries(items.map((k) => [k, a.inventory?.[k] ?? 0])), ledger: a.ledger, identity: a.identity };
  }
  const same = (a, b) => json(sorted(a)) === json(sorted(b));

  /**
   * One case: the baseline, `body()` (returns its notes; `expectDisk`: 'baseline' or 'live' (the ledger at the halt)), the halt, the
   * world opened again, conservation and the disk ledger. `held`: the hold must be on during the body.
   */
  async function crashCase(tag, items, body, { expectDisk = 'baseline', selfHalt = false } = {}) {
    await cmd('/save-all flush').catch(() => null);
    await call('dev.wait', { ms: 1500 }, 30_000);
    const base = diskLedger();
    const s0 = await saved();
    const c0 = await totals(items);
    const n = { tag, items, before: c0.t };
    Object.assign(n, (await body(n, s0)) ?? {});
    if (selfHalt) {
      // (SOFF2) the body's hook halts the server: no live read; the disk ledger must be the baseline
      const hx = await halt(tag, { send: false });
      if (!hx) return n;
      const c2 = await totals(items);
      n.after = c2.t;
      const d = Object.fromEntries(items.map((k) => [k, (c2.t[k] ?? 0) - (c0.t[k] ?? 0)]));
      n.mintUnits = sum(Object.fromEntries(Object.entries(d).filter(([, v]) => v > 0)));
      n.lossUnits = -sum(Object.fromEntries(Object.entries(d).filter(([, v]) => v < 0)));
      log(`  ${tag}: before ${json(c0.t)}; after the restart ${json(c2.t)}; minted ${n.mintUnits}, lost ${n.lossUnits}`);
      check(n.mintUnits === 0 && n.lossUnits === 0, `${tag}: conservation: containers + entities + inventory + stock after the restart = the baseline (minted ${n.mintUnits}, lost ${n.lossUnits})`, n);
      n.diskMatches = books(hx.disk) === books(base);
      check(n.diskMatches, `${tag}: the disk ledger at the halt equals the baseline (nothing published over the raw save)`, { disk: books(hx.disk), expect: books(base) });
      return n;
    }
    const c1 = await totals(items);
    const s1 = await saved();
    n.live = c1.t;
    n.hold = s1.hold ?? null;
    check(same(c1.t, c0.t), `${tag}: live totals conserved ${json(c0.t)} -> ${json(c1.t)}`, n);
    const expect = expectDisk === 'live' ? c1.ledger : base;
    const hx = await halt(tag);
    if (!hx) return n;
    const c2 = await totals(items);
    n.after = c2.t;
    const d = Object.fromEntries(items.map((k) => [k, (c2.t[k] ?? 0) - (c0.t[k] ?? 0)]));
    n.mintUnits = sum(Object.fromEntries(Object.entries(d).filter(([, v]) => v > 0)));
    n.lossUnits = -sum(Object.fromEntries(Object.entries(d).filter(([, v]) => v < 0)));
    log(`  ${tag}: before ${json(c0.t)}; live ${json(c1.t)}; after the restart ${json(c2.t)}; minted ${n.mintUnits}, lost ${n.lossUnits}`);
    check(n.mintUnits === 0 && n.lossUnits === 0, `${tag}: conservation: containers + entities + inventory + stock after the restart = the baseline (minted ${n.mintUnits}, lost ${n.lossUnits})`, n);
    n.diskMatches = books(hx.disk) === books(expect);
    check(n.diskMatches, `${tag}: the disk ledger at the halt equals the ${expectDisk === 'live' ? 'live ledger (its changes saved first)' : 'baseline (nothing published while held)'}`, { disk: books(hx.disk), expect: books(expect) });
    return n;
  }
  const heldNow = async (tag) => {
    const s = await saved();
    check(s.hold?.state === 'HELD', `${tag}: the hold is on (${json(s.hold)})`);
    return s;
  };

  steps.soffcrash = async () => {
    await ensure();
    const out = {};
    await G.survivalBase(ctx);
    const name = 'G6B SOFF crash';
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await G.designs(ctx);
    const gy = await groundY();
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const at = [CLAIM[0] - 3, gy + 2, CLAIM[1] - 3];
    await L.tp(CX + 80, 80, CZ + 56);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `SOFF: a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const region = await caps.realise(L, p0.planId, { load: 'bounded:512', lots: { cottage_1: 'rs_hut' } });
    await L.tp(...at);
    W = { dir: path.join(L.SAVES, name), at, region, box: { min: [CLAIM[0] - 12, gy - 1, CLAIM[1] - 12], max: [CLAIM[0] + 4, gy + 6, CLAIM[1] + 4] } };
    const st0 = (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
    const feedOrder = st0.feedOrder ?? [];
    for (const id of feedOrder) await call('dev.stockpile.pause', { owner: G.OWNER, site: id, paused: true }, 60_000);
    const need = st0.outstanding ?? {};
    const items = Object.entries(need).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    log(`  SOFF: ${feedOrder.length} target(s) paused; the need ${json(need)}`);
    check(items.length > 0 && sum(need) >= 100, `SOFF: the town needs at least 100 units (${sum(need)})`);
    if (!items.length) return out;

    // a hopper line over crate k: its chest (filled with a quarter of the need) before the baseline, the hopper under it in the case
    const chest = async ([x, y, z]) => {
      await cmd(`/setblock ${x} ${y + 2} ${z} minecraft:chest`);
      let slot = 0;
      for (const k of items) {
        for (let left = Math.floor(need[k] / 4); left > 0 && slot < 27; slot++, left -= 64) await cmd(`/item replace block ${x} ${y + 2} ${z} container.${slot} with ${k} ${Math.min(64, left)}`);
      }
    };
    const hopper = async ([x, y, z]) => cmd(`/setblock ${x} ${y + 1} ${z} minecraft:hopper[facing=down]`);
    const unline = async ([x, y, z]) => {
      await cmd(`/setblock ${x} ${y + 2} ${z} minecraft:air`);
      await cmd(`/setblock ${x} ${y + 1} ${z} minecraft:air`);
    };
    const stockOf = async () => sum((await audit()).stock ?? {});

    // ---------------------------------------------------------------- P, A: a hopper line with saving off
    for (const [tag, viaAutosave] of [['P', false], ['A', true]]) {
      await ps({ noPeriodic: viaAutosave, resetPeriodic: true });
      await chest(crates[0]);
      out[tag] = await crashCase(tag, items, async (n, s0) => {
        const k0 = await stockOf();
        await cmd('/save-off');
        await hopper(crates[0]);
        await call('dev.wait', { ms: viaAutosave ? 15_000 : 25_000 }, 60_000);
        if (viaAutosave) await ps({ autosave: true });
        const s = await heldNow(tag);
        n.taken = (await stockOf()) - k0;
        n.ledgerSavesWhileOff = s.saves - s0.saves;
        check(n.taken === 0 && n.ledgerSavesWhileOff === 0, `${tag}: while saving is off the crates took ${n.taken} (held) and no ledger save ran (${n.ledgerSavesWhileOff}); ${viaAutosave ? 'an autosave' : `${s.periodicSaves} periodic tick(s)`}`, n);
      });
      await unline(crates[0]);
    }
    await ps({ noPeriodic: false });

    // ---------------------------------------------------------------- M: the Nether off directly, the Overworld on
    await chest(crates[1]);
    out.M = await crashCase('M', items, async (n, s0) => {
      const k0 = await stockOf();
      await ps({ noSave: { 'minecraft:the_nether': true } });
      await hopper(crates[1]);
      await call('dev.wait', { ms: 15_000 }, 60_000);
      await ps({ autosave: true });
      const s = await heldNow('M');
      n.taken = (await stockOf()) - k0;
      n.ledgerSavesWhileOff = s.saves - s0.saves;
      check(n.taken === 0, `M: with the Nether's saving off, an Overworld crate took ${n.taken} (held in every dimension: the ledger is shared)`, n);
    });
    await unline(crates[1]);

    // ---------------------------------------------------------------- D: a deposit just before /save-off, then an autosave and a logout
    const [B] = items;
    {
      const k = Math.min(64, Math.max(1, Math.floor((need[B] ?? 0) / 4)));
      await cmd(`/give @s ${B} ${k}`);
      out.D = await crashCase('D', [B], async (n) => {
        const ins = await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, inventory: true }, 120_000);
        await cmd('/save-off'); // the same moment: no periodic save between
        await ps({ autosave: true });
        await call('dev.bot.relog', {}, 10_000).catch(() => null);
        for (let i = 0; i < 60 && !(await call('dev.state', {}, 10_000).catch(() => null))?.player; i++) await L.sleep(1000);
        const s = await heldNow('D');
        n.moved = ins.moved;
        n.savingOffBarriers = s.hold?.savingOffBarriers;
        check(ins.moved > 0 && (s.hold?.savingOffBarriers ?? 0) >= 1, `D: ${ins.moved} deposited, then /save-off saved them first (${s.hold?.savingOffBarriers} barrier(s)); an autosave and a logout while held`, n);
      }, { expectDisk: 'live' });
    }

    // ---------------------------------------------------------------- F: saving on, a deposit, another mod's forced chunk save (no players)
    {
      const k = Math.min(64, Math.max(1, Math.floor((need[B] ?? 0) / 4)));
      await cmd(`/give @s ${B} ${k}`);
      await cmd('/save-all flush').catch(() => null);
      await ps({ noPeriodic: true });
      out.F = await crashCase('F', [B], async (n, s0) => {
        const ins = await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, inventory: true }, 120_000);
        await ps({ rawForceSave: true });
        const s = await saved();
        n.moved = ins.moved;
        n.ledgerSaves = s.saves - s0.saves;
        check(ins.moved > 0 && n.ledgerSaves === 0, `F: ${ins.moved} deposited; a raw saveAllChunks(true, true, true) published no ledger (${n.ledgerSaves}): its players were not saved`, { n, lastSave: s.lastSave });
      });
      await ps({ noPeriodic: false });
    }

    // ---------------------------------------------------------------- B: a build fed, then /save-off: nothing moves while held
    {
      // (SOFF2) every target the stockpile feeds now unpaused (the street's roads joined after the start's), what they lack delivered:
      // the build is running when saving goes off, with stock left for it after the release
      await unpauseAll();
      await call('dev.wait', { ms: 1500 }, 30_000);
      const lackB = await lacking();
      await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: lackB, exact: true }, 120_000);
      const bB0 = await builtSum();
      for (let i = 0; i < 20 && (await builtSum()) <= bB0; i++) await L.sleep(1000);
      log(`  B: delivered ${json(lackB)}; targets ${await targetsLine()}`);
      await cmd('/save-all flush').catch(() => null);
      await cmd('/save-off');
      const a0 = await audit();
      const built0 = await builtSum();
      await call('dev.wait', { ms: 15_000 }, 60_000);
      const a1 = await audit();
      const built1 = await builtSum();
      await heldNow('B');
      const n = { tag: 'B', before: booksAll(a0.ledger), held: booksAll(a1.ledger), built0, built1 };
      check(booksAll(a0.ledger) === booksAll(a1.ledger) && built1 === built0, `B: while saving is off no feed, fill or payment changed the ledger, its cell books, custody or fill markers (15 s, targets unpaused); consumed ${built0} -> ${built1}`, n);
      await cmd('/save-on');
      let s;
      for (let i = 0; i < 30; i++) {
        s = await saved();
        if (s.hold?.state === 'OPEN') break;
        await L.sleep(1000);
      }
      check(s.hold?.state === 'OPEN' && (s.hold?.releases ?? 0) >= 1, `B: /save-on: released after a confirmed save (${json(s.hold)})`, n);
      let a2, built2 = built1;
      for (let i = 0; i < 20 && built2 <= built1; i++) {
        await call('dev.wait', { ms: 1500 }, 30_000);
        built2 = await builtSum();
      }
      a2 = await audit();
      n.built2 = built2;
      n.resumed = booksAll(a2.ledger) !== booksAll(a1.ledger) && built2 > built1;
      check(n.resumed, `B: after the release the build resumed: consumed ${built1} -> ${built2} units, the ledger moved (${books(a2.ledger) !== books(a1.ledger)})`, n);
      log(`  B: after the release: targets ${await targetsLine()}`);
      await pauseAll();
      await cmd('/save-all flush').catch(() => null);
      const hx = await halt('B');
      if (hx) {
        const a3 = await audit();
        n.identity = a3.identity;
        check(a3.identity !== false, `B: after a halt the ledger's identity holds (${a3.identity})`, n);
      }
      out.B = n;
    }

    // ---------------------------------------------------------------- (SOFF2) N, E: another mod's raw forced save inside a save
    {
      await ps({ noPeriodic: true });
      const [IN, kN] = await needed();
      check(!!IN, `N: an item the targets still lack (${IN} x${kN})`);
      await cmd(`/give @s ${IN ?? B} ${Math.max(1, kN)}`);
      out.N = await crashCase('N', [IN ?? B], async (n) => {
        const ins = await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, inventory: true }, 120_000);
        n.moved = ins.moved;
        check(ins.moved > 0, `N: ${ins.moved} deposited (pending); then an autosave whose player save runs a raw saveAllChunks(true, true, true) and halts`, n);
        ps({ rawSaveIn: 'playerSave', haltAfter: true, autosave: true }).catch(() => null); // the hook halts the server inside
      }, { selfHalt: true });
      await ps({ noPeriodic: true });
      const [IE, kE] = await needed();
      check(!!IE, `E: an item the targets still lack (${IE} x${kE})`);
      await cmd(`/give @s ${IE ?? B} ${Math.max(1, kE)}`);
      out.E = await crashCase('E', [IE ?? B], async (n, s0) => {
        const ins = await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, inventory: true }, 120_000);
        await ps({ rawSaveIn: 'beforeSave', autosave: true });
        const s = await saved();
        n.moved = ins.moved;
        n.ledgerSaves = s.saves - s0.saves;
        n.rawSaves = s.testHooks?.rawSaves;
        check(ins.moved > 0 && (s.testHooks?.rawSaves ?? 0) >= 1 && n.ledgerSaves === 1, `E: ${ins.moved} deposited; an autosave with a raw forced save inside its BEFORE_SAVE: exactly one ledger publish, the autosave's own (${n.ledgerSaves}; raw saves ${n.rawSaves})`, { n, lastSave: s.lastSave });
      }, { expectDisk: 'live' });
      await ps({ noPeriodic: false });
    }

    // ---------------------------------------------------------------- (SOFF2) X: an insert inside /save-off's own barrier
    {
      await ps({ noPeriodic: true });
      const [IX, kX] = await needed();
      check(!!IX, `X: an item the targets still lack (${IX} x${kX})`);
      await cmd(`/give @s ${IX ?? B} ${Math.max(1, kX)}`);
      out.X = await crashCase('X', [IX ?? B], async (n) => {
        await ps({ depositInSavingOffBarrier: `stockpile:${G.OWNER}`, markUnsaved: true });
        await cmd('/save-off');
        const s = await heldNow('X');
        n.deposits = s.testHooks?.deposits;
        n.moved = s.testHooks?.depositMoved;
        n.savingOffBarriers = s.hold?.savingOffBarriers;
        check((n.deposits ?? 0) >= 1 && n.moved === 0, `X: an Insert from inventory inside /save-off's own barrier moved ${n.moved} (admission closed before the barrier; barriers ${n.savingOffBarriers}, hook fired ${n.deposits})`, n);
      }, { expectDisk: 'live' });
      await ps({ noPeriodic: false });
    }

    // ---------------------------------------------------------------- (SOFF2) S: the start with saving off after an unclean stop
    {
      // paused: what they lack delivered and saved (the baseline); then unpaused: the cells they build next are on no saved ledger
      await pauseAll();
      await call('dev.wait', { ms: 1500 }, 30_000);
      const lack = await lacking();
      await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: lack, exact: true }, 120_000);
      await ps({ noPeriodic: true });
      await unpauseAll(); // (the feed order's own save with the world, before any cell is built)
      await cmd('/save-all flush').catch(() => null);
      const sS = await saved();
      const atSave = await builtSum();
      for (let i = 0; i < 10 && (await builtSum()) <= atSave; i++) await L.sleep(700);
      await call('dev.wait', { ms: 2000 }, 30_000);
      const atHalt = await builtSum();
      const sS2 = await saved();
      log(`  S: delivered ${json(lack)}; targets ${await targetsLine()}`);
      const n = { tag: 'S', atSave, atHalt, ledgerSavesBetween: sS2.saves - sS.saves };
      check(atHalt > atSave, `S: cells built after the save (consumed ${atSave} -> ${atHalt}; ledger saves between ${n.ledgerSavesBetween})`, n);
      await ps({ savingOffAtStart: true, haltBeforeAutosaveLedger: true });
      ps({ autosave: true }).catch(() => null); // AS1: the autosave's chunks written, halted before its ledger
      const down = await haltWait();
      check(down, `S: halted at AS1 (the world ahead of the ledger)`);
      if (down) {
        await L.openWorld(path.basename(W.dir));
        await L.tp(W.at[0], W.at[1], W.at[2]);
        await call('dev.wait', { ms: 3000 }, 30_000);
        const s1 = await saved();
        n.startsOff = s1.testHooks?.startsOff;
        n.holdAtStart = s1.hold;
        check(s1.hold?.state === 'HELD' && (s1.testHooks?.startsOff ?? 0) >= 1, `S: the world opened with saving off (${n.startsOff} level(s)); held (${json(s1.hold)})`, n);
        await cmd('/save-on');
        let s2;
        for (let i = 0; i < 30; i++) {
          s2 = await saved();
          if (s2.hold?.state === 'OPEN') break;
          await L.sleep(1000);
        }
        await caps.afterRestart('S');
        const a = await audit();
        const rc = a.reconciled ?? {};
        n.reconciled = rc;
        n.ahead = Object.values(rc).reduce((x, r) => x + (r.aheadCells ?? 0), 0);
        n.balance = balance(a);
        n.uncleanStart = a.uncleanStart;
        log(`  S: released ${json(s2?.hold)}; reconciled ${json(rc).slice(0, 400)}; balance ${json(n.balance)}`);
        check(s2?.hold?.state === 'OPEN', `S: /save-on: released after a confirmed save (${json(s2?.hold)})`, n);
        check(n.ahead > 0, `S: the start's reconcile found the cells built after the save (${atHalt - atSave} units) against the saved books: ${n.ahead} ahead (unclean ${n.uncleanStart})`, n);
        check(n.balance.dupeUnits === 0 && a.identity !== false, `S: after the release no cell stands unpaid (standing ${n.balance.standing}, paid ${n.balance.paid}; dupe ${n.balance.dupeUnits}: ${json(n.balance.dupe)}; identity ${a.identity})`, n);
      }
      out.S = n;
      await pauseAll();
      await ps({ noPeriodic: false });
    }

    // ---------------------------------------------------------------- W: a Take onto the ground with saving off
    await call('dev.region.remove', { region, requester: G.OWNER }, 600_000).catch(() => null);
    let rs;
    for (let i = 0; i < 300; i++) {
      rs = await call('dev.region.state', { region }, 60_000).catch(() => null);
      if (!rs?.view?.state || ['REMOVED', 'PARTIAL', 'FAILED'].includes(rs.view.state)) break;
      await L.sleep(2000);
    }
    const credit = ((await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {}).credit ?? {};
    const [T, kT] = Object.entries(credit).sort((a, b) => b[1] - a[1])[0] ?? [];
    check((kT ?? 0) > 1, `W: the region removed (${rs?.view?.state ?? 'gone'}); credit ${json(credit)}`);
    if (T) {
      const junk = ['minecraft:dirt', 'minecraft:cobblestone', 'minecraft:sand', 'minecraft:gravel'].find((x) => x !== T && !credit[x]);
      await cmd('/clear @s');
      await cmd(`/give @s ${junk} 2304`); // the 36 main slots full: a Take would drop on the ground
      out.W = await crashCase('W', [T], async (n, s0) => {
        await cmd('/save-off');
        const w = await call('dev.stockpile.withdraw', { owner: G.OWNER, items: { [T]: Math.floor(kT / 2) } }, 120_000).catch((e) => ({ refused: { message: String(e?.message ?? e) } }));
        await call('dev.wait', { ms: 12_000 }, 30_000);
        const s = await saved();
        n.withdraw = w;
        n.ledgerSavesWhileOff = s.saves - s0.saves;
        const msg = w.refused?.message ?? '';
        check(!!w.refused && msg.includes('/save-on') && msg.includes('minecraft:overworld'), `W: the Take refused while saving is off, naming the dimension and /save-on: ${json(w.refused ?? w.withdrawn)}`, n);
        check(n.ledgerSavesWhileOff === 0, `W: no ledger save while saving was off (${n.ledgerSavesWhileOff})`, n);
      });
    }
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
