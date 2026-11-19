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
  let W;
  const diskLedger = () => ledgerOf(JSON.parse(fs.readFileSync(path.join(W.dir, 'architect', 'stockpiles.json'), 'utf8')));

  async function halt(tag) {
    call('dev.stockpile.halt', {}, 10_000).catch(() => null); // the halt drops the call
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
  async function crashCase(tag, items, body, { expectDisk = 'baseline' } = {}) {
    await cmd('/save-all flush').catch(() => null);
    await call('dev.wait', { ms: 1500 }, 30_000);
    const base = diskLedger();
    const s0 = await saved();
    const c0 = await totals(items);
    const n = { tag, items, before: c0.t };
    Object.assign(n, (await body(n, s0)) ?? {});
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
      const k = Math.min(64, need[B] ?? 0);
      await cmd(`/give @s ${B} ${k}`);
      await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, inventory: true }, 120_000);
      for (const id of feedOrder) await call('dev.stockpile.pause', { owner: G.OWNER, site: id, paused: false }, 60_000);
      await call('dev.wait', { ms: 5000 }, 30_000);
      await cmd('/save-all flush').catch(() => null);
      await cmd('/save-off');
      const a0 = await audit();
      await call('dev.wait', { ms: 15_000 }, 60_000);
      const a1 = await audit();
      await heldNow('B');
      const n = { tag: 'B', before: books(a0.ledger), held: books(a1.ledger) };
      check(books(a0.ledger) === books(a1.ledger), `B: while saving is off no feed, fill or payment changed the ledger (15 s, targets unpaused)`, n);
      await cmd('/save-on');
      let s;
      for (let i = 0; i < 30; i++) {
        s = await saved();
        if (s.hold?.state === 'OPEN') break;
        await L.sleep(1000);
      }
      check(s.hold?.state === 'OPEN' && (s.hold?.releases ?? 0) >= 1, `B: /save-on: released after a confirmed save (${json(s.hold)})`, n);
      await call('dev.wait', { ms: 10_000 }, 30_000);
      const a2 = await audit();
      n.resumed = books(a2.ledger) !== books(a1.ledger);
      log(`  B: the ledger after the release ${n.resumed ? 'moved (the build resumed)' : 'unchanged'}`);
      for (const id of feedOrder) await call('dev.stockpile.pause', { owner: G.OWNER, site: id, paused: true }, 60_000);
      await cmd('/save-all flush').catch(() => null);
      const hx = await halt('B');
      if (hx) {
        const a3 = await audit();
        n.identity = a3.identity;
        check(a3.identity !== false, `B: after a halt the ledger's identity holds (${a3.identity})`, n);
      }
      out.B = n;
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
