// Slice SOFF gate: no Architect ledger save publishes the stockpile ledger while a level has saving off (/save-off). saveAllChunks skips
// such a level unless forced, and RegionDurability tracks only the writes that happened, so the ledger would be on disk ahead of the world
// it covers: a crash then mints (a hopper's source chest saved full, the ledger counting its deliveries) or loses (a Take's ground drop
// never saved, the ledger's debit on disk).
// Registered into tools/gate6dgr.mjs (GR's survival town and halt helpers). Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs soffcrash   (soff-crash)   one survival world, a stockpile of 4 crates, a town realised with every target paused
//     (nothing consumed), a chest over a hopper over two of the crates. Each case: /save-all flush (the baseline, saving on), /save-off, the
//     ledger change, a halt with nothing else saved (dev.stockpile.halt), the world opened again (saving is on again), conservation:
//       P  the hopper line delivering for 25 s, the periodic save ticking: chest + hopper + stock after the restart = the baseline
//          (before SOFF a mint: the periodic save wrote the deliveries, the chest's chunk was never saved)
//       A  the periodic save off, a vanilla autosave (dev.stockpile.ps autosave: unflushed, not forced): the same (before SOFF a mint
//          through the world save's callback)
//       W  the region removed (its stock becomes credit), the inventory full, a Take (withdraw) whose items drop on the ground: inventory
//          + stock + ground = the baseline (before SOFF a loss: the ledger's debit on disk, the dropped items never saved); refused with a
//          message naming the dimension and /save-on
//     and on the branch: no ledger save while saving was off, the refusals counted (dev.stockpile.saved savingOffRefusals).
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

  async function halt(tag, W) {
    call('dev.stockpile.halt', {}, 10_000).catch(() => null); // the halt drops the call
    const down = await haltWait();
    check(down, `${tag}: halted with nothing else saved`);
    if (!down) return null;
    const disk = JSON.parse(fs.readFileSync(path.join(W.dir, 'architect', 'stockpiles.json'), 'utf8'));
    await L.openWorld(path.basename(W.dir));
    await L.tp(W.at[0], W.at[1], W.at[2]);
    await call('dev.wait', { ms: 3000 }, 30_000);
    await caps.afterRestart(tag); // (BC-c) the reconcile inside the region's maxBill
    return { diskLedger: ledgerOf(disk) };
  }

  /** What happened to the ledger saves while saving was off: none on the branch, the refusals counted. */
  function offSaves(tag, s0, s1, n) {
    n.ledgerSavesWhileOff = s1.saves - s0.saves;
    n.savingOffRefusals = (s1.savingOffRefusals ?? NaN) - (s0.savingOffRefusals ?? NaN);
    check(n.ledgerSavesWhileOff === 0 && n.savingOffRefusals >= 1, `${tag}: no ledger save while saving was off (${n.ledgerSavesWhileOff} save(s)); ${n.savingOffRefusals} refusal(s) counted`, n);
  }

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
    const W = { dir: path.join(L.SAVES, name), at, region };
    const st0 = (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
    for (const id of st0.feedOrder ?? []) await call('dev.stockpile.pause', { owner: G.OWNER, site: id, paused: true }, 60_000);
    const need = st0.outstanding ?? {};
    const items = Object.entries(need).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    log(`  SOFF: ${(st0.feedOrder ?? []).length} target(s) paused; the need ${json(need)}`);
    check(items.length > 0 && sum(need) >= 100, `SOFF: the town needs at least 100 units (${sum(need)}: two hopper cases)`);
    if (!items.length) return out;

    // ---------------------------------------------------------------- P and A: a hopper line, saving off, a halt
    const lines = crates.slice(0, 2);
    for (const [x, y, z] of lines) {
      await cmd(`/setblock ${x} ${y + 1} ${z} minecraft:hopper[facing=down]`);
      await cmd(`/setblock ${x} ${y + 2} ${z} minecraft:chest`);
    }
    const fill = async ([x, y, z]) => {
      let slot = 0;
      for (const k of items) {
        for (let left = Math.floor(need[k] / 2); left > 0 && slot < 27; slot++, left -= 64) await cmd(`/item replace block ${x} ${y + 2} ${z} container.${slot} with ${k} ${Math.min(64, left)}`);
      }
    };
    const xs = lines.map((c) => c[0]);
    const box = { min: [Math.min(...xs), gy + 2, crates[0][2]], max: [Math.max(...xs), gy + 3, crates[0][2]] };
    const totals = async () => {
      const a = await audit(box);
      const cont = sum(Object.fromEntries(items.map((k) => [k, a.containers?.[k] ?? 0])));
      const stock = sum(Object.fromEntries(items.map((k) => [k, a.stock?.[k] ?? 0])));
      return { cont, stock, total: cont + stock };
    };
    for (const [k, [tag, viaAutosave]] of [['P', false], ['A', true]].entries()) {
      await ps({ noPeriodic: viaAutosave, resetPeriodic: true });
      await fill(lines[k]);
      await cmd('/save-all flush').catch(() => null);
      const s0 = await saved();
      const c0 = await totals();
      await cmd('/save-off');
      await call('dev.wait', { ms: viaAutosave ? 15_000 : 25_000 }, 60_000);
      if (viaAutosave) await ps({ autosave: true });
      const c1 = await totals();
      const s1 = await saved();
      const n = { tag, viaAutosave, before: c0, live: c1, delivered: c1.stock - c0.stock, periodicSaves: s1.periodicSaves };
      check(n.delivered > 0 && c1.total === c0.total, `${tag}: the hopper line delivered ${n.delivered} with saving off (${viaAutosave ? 'then a vanilla autosave' : `${s1.periodicSaves} periodic tick(s)`}); live totals conserved (${c0.total} -> ${c1.total})`, n);
      offSaves(tag, s0, s1, n);
      const hx = await halt(tag, W);
      if (!hx) return out;
      const c2 = await totals();
      Object.assign(n, hx, { after: c2, mintUnits: Math.max(0, c2.total - c0.total), lossUnits: Math.max(0, c0.total - c2.total) });
      log(`  ${tag}: baseline ${json(c0)}; live at the halt ${json(c1)}; after the restart ${json(c2)}; minted ${n.mintUnits}, lost ${n.lossUnits}`);
      check(c2.total === c0.total, `${tag}: conservation: chest + hopper + stock after the restart ${c2.total} = ${c0.total} at the baseline (minted ${n.mintUnits}, lost ${n.lossUnits})`, n);
      out[tag] = n;
    }
    await ps({ noPeriodic: false });

    // ---------------------------------------------------------------- W: a Take onto the ground with saving off, a halt
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
    if (!T) return out;
    const junk = ['minecraft:dirt', 'minecraft:cobblestone', 'minecraft:sand', 'minecraft:gravel'].find((x) => x !== T && !credit[x]);
    await cmd('/clear @s');
    await cmd(`/give @s ${junk} 2304`); // the 36 main slots full: the Take drops on the ground
    const count = async () => {
      const a = await audit();
      const near = await call('dev.items.near', { pos: at, radius: 12 }, 60_000).catch(() => null);
      return { inv: a.inventory?.[T] ?? 0, stock: a.stock?.[T] ?? 0, ground: near ? near.items?.[T] ?? 0 : NaN, junk: a.inventory?.[junk] ?? 0 };
    };
    await cmd('/save-all flush').catch(() => null);
    await call('dev.wait', { ms: 2000 }, 30_000);
    const s0 = await saved();
    const c0 = await count();
    check(c0.junk === 2304 && c0.inv === 0, `W: the inventory full of ${junk} (${c0.junk}), no ${T} in it`, c0);
    await cmd('/save-off');
    const w = await call('dev.stockpile.withdraw', { owner: G.OWNER, items: { [T]: Math.floor(kT / 2) } }, 120_000).catch((e) => ({ refused: { message: String(e?.message ?? e) } }));
    await call('dev.wait', { ms: 12_000 }, 30_000); // a periodic tick
    const c1 = await count();
    const s1 = await saved();
    const total = (c) => c.inv + c.stock + c.ground;
    const n = { tag: 'W', item: T, take: Math.floor(kT / 2), withdraw: w, before: c0, live: c1 };
    const msg = w.refused?.message ?? '';
    check(!!w.refused && msg.includes('/save-on') && msg.includes('minecraft:overworld'), `W: the Take refused while saving is off, naming the dimension and /save-on: ${json(w.refused ?? w.withdrawn)}`, n);
    check(total(c1) === total(c0), `W: live inventory + stock + ground conserved (${total(c0)} -> ${total(c1)})`, n);
    n.ledgerSavesWhileOff = s1.saves - s0.saves;
    check(n.ledgerSavesWhileOff === 0, `W: no ledger save while saving was off (${n.ledgerSavesWhileOff})`, n);
    const hx = await halt('W', W);
    if (hx) {
      const c2 = await count();
      const d = total(c2) - total(c0);
      Object.assign(n, hx, { after: c2, mintUnits: Math.max(0, d), lossUnits: Math.max(0, -d) });
      log(`  W: baseline ${json(c0)}; live ${json(c1)}; after the restart ${json(c2)}; minted ${n.mintUnits}, lost ${n.lossUnits}`);
      check(d === 0, `W: conservation: inventory + stock + ground ${T} after the restart ${total(c2)} = ${total(c0)} at the baseline (minted ${n.mintUnits}, lost ${n.lossUnits})`, n);
    }
    out.W = n;
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
