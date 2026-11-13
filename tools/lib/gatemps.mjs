// Slice PS gate (docs/CONTRACT.md "Slice PS, ledger saves"): a crash never loses more than about 10 s of a stockpile's deliveries and
// never dupes them (F4 b, the periodic ledger save), and a finished undo's refund survives a crash right after it (N1).
// Registered into tools/gate6dgr.mjs (GR's survival town and halt helpers). Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs pscrash   (ps-crash)   two parts:
//     hopper  one survival world, a stockpile of 4 crates, a town realised with every target paused (nothing consumed: the stock moves only
//             by the deliveries), a chest over a hopper over two of the crates (one line per case, about 2.5 items/s). Two cases, each: /save-all flush (the
//             baseline: chunks and ledger on disk), the hoppers delivering for 25 s, a halt with nothing else saved (dev.stockpile.halt),
//             the world opened again, chests + hoppers + stock counted (one line per case: the paused town's first wave caps the need):
//               H0  the periodic save off (dev.stockpile.ps noPeriodic: the code before PS): the measured loss, never a dupe
//               H1  as built: lost at most the last ~10 s of deliveries (12.5 s at the measured rate), never a dupe; the periodic saves'
//                   count and cost recorded
//     k5end   two survival worlds, each: a town built in survival (fed until built), /save-all flush (the ledger saved with what the town
//             consumed, as an autosave would), the region removed to the end (REMOVED: the removal has left the queue file), 12 s for
//             the restored chunks' eager saves, a halt with nothing else saved, the world opened again:
//               K5E0  the refund credit's save off and the periodic save off (the code before PS): the refund lost (the repro)
//               K5E   the periodic save off, the credit's save on (N1's fix alone): the stock after the restart equals the stock before the
//                     halt (the refund kept), and the town stays removed
//
// Evidence: artifacts/gate6d-gr/pscrash.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';

export async function registerPS(steps, h) {
  const { L, call, check, cmd, log, OUT, json, G, ensure, spendZero, groundY, BOXOF, CX, CZ, CLAIM, haltWait, cellsOf, diff } = h;
  const ctx = { L, OUT, imp: h.imp };
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const pos = (m) => Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => v > 0));
  const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];
  const ledgerOf = (root) => (root?.stockpiles ?? []).find((p) => p.owner === G.OWNER)?.ledger ?? null;
  const saved = async () => call('dev.stockpile.saved', {}, 60_000);
  const ps = async (o) => call('dev.stockpile.ps', o, 30_000);
  const audit = async (box) => call('dev.stockpile.audit', { owner: G.OWNER, ...(box ? { min: box.min, max: box.max } : {}) }, 60_000);
  /** stock with overflow (refundOverflow drops as items: it came back too) */
  const backOf = (a) => G.plus(a.stock ?? {}, a.ledger?.refundOverflow ?? {});

  async function halt(tag, W) {
    call('dev.stockpile.halt', {}, 10_000).catch(() => null); // the halt drops the call
    const down = await haltWait();
    check(down, `${tag}: halted with nothing else saved`);
    if (!down) return null;
    const disk = JSON.parse(fs.readFileSync(path.join(W.dir, 'architect', 'stockpiles.json'), 'utf8'));
    await L.openWorld(path.basename(W.dir));
    await L.tp(W.at[0], W.at[1], W.at[2]);
    await call('dev.wait', { ms: 3000 }, 30_000);
    return { diskLedger: ledgerOf(disk), diskFormat: disk.format };
  }

  async function survivalWorld(name) {
    await G.survivalBase(ctx);
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await G.designs(ctx);
    const gy = await groundY();
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const at = [CLAIM[0] - 3, gy + 2, CLAIM[1] - 3];
    await L.tp(CX + 80, 80, CZ + 56);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `${name}: a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    return { gy, crates, at, dir: path.join(L.SAVES, name), BOX: BOXOF(CLAIM, gy) };
  }

  // ---------------------------------------------------------------- hopper: deliveries and a crash (F4 b)
  async function hopperPart(out) {
    const name = 'G6B PS hopper';
    const W = await survivalWorld(name);
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: 'rs_hut' } });
    await L.tp(...W.at);
    const st0 = (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
    for (const id of st0.feedOrder ?? []) await call('dev.stockpile.pause', { owner: G.OWNER, site: id, paused: true }, 60_000);
    const need = st0.outstanding ?? {};
    // the paused town's need (its first wave's items) caps what the crates take: one hopper line per case (~2.5 items/s, ~60 in 25 s),
    // each case's chest filled with half of the need, so both cases deliver throughout
    const items = Object.entries(need).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const n = sum(need);
    const item = items.join('+');
    log(`  hopper: ${(st0.feedOrder ?? []).length} target(s) paused; the need ${json(need)}`);
    check(items.length > 0 && n >= 100, `hopper: the town needs at least 100 units (${n}: two cases of ~60 deliveries each)`);
    if (!items.length) return;
    const lines = W.crates.slice(0, 2);
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
    const box = { min: [Math.min(...xs), W.gy + 2, W.crates[0][2]], max: [Math.max(...xs), W.gy + 3, W.crates[0][2]] };
    const totals = async () => {
      const a = await audit(box);
      const cont = sum(Object.fromEntries(items.map((k) => [k, a.containers?.[k] ?? 0])));
      const stock = sum(Object.fromEntries(items.map((k) => [k, a.stock?.[k] ?? 0])));
      return { cont, stock, total: cont + stock };
    };

    for (const [k, [tag, noPeriodic]] of [['H0', true], ['H1', false]].entries()) {
      await ps({ noPeriodic, resetPeriodic: true });
      await fill(lines[k]);
      const cPre = await totals(); // just before the flush: what the flush saves (the line has barely started)
      await cmd('/save-all flush');
      const s0 = await saved();
      const c0 = await totals();
      const tStart = Date.now();
      await call('dev.wait', { ms: 25_000 }, 60_000);
      const c1 = await totals();
      const s1 = await saved();
      const secs = (Date.now() - tStart) / 1000;
      const delivered = c1.stock - c0.stock;
      const rate = delivered / secs;
      const n1 = { tag, item, noPeriodic, preFlush: cPre, before: c0, live: c1, delivered, secs, rate, ledgerSaves: s1.saves - s0.saves, periodicSaves: s1.periodicSaves,
        lastPeriodicMs: s1.lastPeriodicMs, maxPeriodicMs: s1.maxPeriodicMs, medianPeriodicMs: s1.medianPeriodicMs };
      check(delivered > 0 && c1.cont > 0 && c1.total === c0.total, `${tag}: the hopper line delivered ${delivered} in ${secs.toFixed(1)} s (${rate.toFixed(2)}/s), still delivering at the halt (${c1.cont} left); live totals conserved (${c0.total} -> ${c1.total})`, n1);
      if (noPeriodic) check(s1.periodicSaves === 0, `${tag}: no periodic save ran (the code before PS): ${s1.periodicSaves}`, n1);
      else check(s1.periodicSaves >= 2, `${tag}: the periodic save ran ${s1.periodicSaves} time(s) in ${secs.toFixed(0)} s (median ${Number(s1.medianPeriodicMs).toFixed(1)} ms, max ${Number(s1.maxPeriodicMs).toFixed(1)} ms)`, n1);
      const hx = await halt(tag, W);
      if (!hx) return;
      const c2 = await totals();
      const loss = c0.total - c2.total;
      Object.assign(n1, hx, { after: c2, lossUnits: Math.max(0, loss), mintUnits: Math.max(0, -loss), lossSeconds: rate > 0 ? Math.max(0, loss) / rate : null,
        autosaved: n1.ledgerSaves > (noPeriodic ? 0 : s1.periodicSaves) });
      log(`  ${tag}: before the flush ${json(cPre)}; after it ${json(c0)}; live at the halt ${json(c1)}; after the restart ${json(c2)}; lost ${n1.lossUnits} (${n1.lossSeconds?.toFixed(1)} s of deliveries), minted ${n1.mintUnits}`);
      check(n1.mintUnits === 0, `${tag}: no dupe: chest + hopper + stock after the restart ${c2.total} <= ${c0.total} at the baseline (minted ${n1.mintUnits})`, n1);
      if (noPeriodic) check(true, `${tag}: before PS a crash lost ${n1.lossUnits} of the ${c1.stock - cPre.stock} delivered since the flush (${n1.lossSeconds?.toFixed(1)} s; autosaved: ${n1.autosaved})`, n1);
      else check(n1.lossUnits <= Math.ceil(rate * 12.5), `${tag}: lost at most the last ~10 s of deliveries: ${n1.lossUnits} <= ${Math.ceil(rate * 12.5)} (12.5 s at ${rate.toFixed(2)}/s; ${n1.lossSeconds?.toFixed(1)} s)`, n1);
      out[tag] = n1;
    }
    await L.leaveWorld();
  }

  // ---------------------------------------------------------------- k5end: a finished undo's refund and a crash (N1)
  async function k5endPart(out) {
    for (const [tag, noCreditSave] of [['K5E0', true], ['K5E', false]]) {
      const W = await survivalWorld(`G6B PS ${tag}`);
      const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
      const region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: 'rs_hut' } });
      const S0 = await cellsOf(W.BOX);
      const f = await G.feed({ L }, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
      check(f.last.st.view.state === 'PLACED' && f.last.rs.build?.done, `${tag}: fed until built (${f.waves} waves): ${f.last.st.view.state}`);
      await ps({ noPeriodic: true, noCreditSave });
      await cmd('/save-all flush'); // the ledger saved with the consumption (as an autosave after the build)
      await call('dev.wait', { ms: 2000 }, 30_000);
      const s0 = await saved();
      const a0 = await audit();
      await call('dev.region.remove', { region, requester: G.OWNER }, 3_600_000).catch(() => null);
      let st;
      for (let i = 0; i < 900; i++) {
        st = await call('dev.region.state', { region }, 60_000).catch(() => null);
        if (!st?.view?.state || ['REMOVED', 'PARTIAL', 'FAILED'].includes(st.view.state)) break;
        await L.sleep(2000);
      }
      check(!st?.view?.state || st.view.state === 'REMOVED', `${tag}: the region removed to the end: ${st?.view?.state ?? 'gone'}`);
      await call('dev.wait', { ms: 12_000 }, 60_000); // the restored chunks' eager saves
      const a1 = await audit();
      const s1 = await saved();
      const refund = G.minus(backOf(a1), backOf(a0));
      const n1 = { tag, noCreditSave, refund, refundUnits: sum(pos(refund)), ledgerSaves: s1.saves - s0.saves, worldSaves: s1.worldSaves - s0.worldSaves,
        lastWorldSaveMs: s1.lastWorldSaveMs, maxWorldSaveMs: s1.maxWorldSaveMs };
      check(n1.refundUnits > 0, `${tag}: the removal refunded ${n1.refundUnits} item(s) into the stock live (${n1.worldSaves} save(s) with the world since the baseline)`, n1);
      W.at = [CX + 80, 60, CZ + 56];
      const hx = await halt(tag, W);
      if (!hx) { await L.leaveWorld(); continue; }
      await call('dev.wait', { ms: 5000 }, 30_000);
      const a2 = await audit();
      const d = G.minus(backOf(a2), backOf(a1));
      const wd = diff(S0, await cellsOf(W.BOX));
      Object.assign(n1, hx, { delta: d, lossUnits: sum(pos(G.minus({}, d))), mintUnits: sum(pos(d)), worldDiff: wd.n, identity: a2.identity });
      log(`  ${tag}: refund live ${json(refund)}; after the restart vs before the halt ${json(d)} (lost ${n1.lossUnits}, minted ${n1.mintUnits}); the world vs before the town ${wd.n} differ`);
      check(wd.n === 0, `${tag}: the town stays removed after the restart (${wd.n} cells differ from before it)`, wd.first);
      if (noCreditSave) {
        const autosaved = n1.ledgerSaves > 0;
        check(n1.lossUnits > 0 || autosaved, `${tag}: before PS the refund was lost on the crash: lost ${n1.lossUnits} of ${n1.refundUnits} (ledger saves since the baseline: ${n1.ledgerSaves})`, n1);
      } else {
        check(n1.worldSaves >= 1, `${tag}: the refund credit saved the ledger with the world (${n1.worldSaves} save(s); last ${Number(n1.lastWorldSaveMs).toFixed(1)} ms, max ${Number(n1.maxWorldSaveMs).toFixed(1)} ms)`, n1);
        check(n1.lossUnits === 0 && n1.mintUnits === 0 && a2.identity !== false, `${tag}: the refund kept: the stock after the restart equals the stock before the halt (lost ${n1.lossUnits}, minted ${n1.mintUnits}; identity ${a2.identity})`, n1);
      }
      out[tag] = n1;
      await L.leaveWorld();
    }
  }

  steps.pscrash = async () => {
    await ensure();
    const out = {};
    const parts = (process.env.GATE_PS_PARTS ?? 'hopper,k5end').split(',');
    if (parts.includes('hopper')) await hopperPart(out);
    if (parts.includes('k5end')) await k5endPart(out);
    spendZero();
    return out;
  };
}
