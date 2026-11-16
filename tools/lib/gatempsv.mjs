// Slice PSV gate: a group removal's undo commits only once the queue file holding its planned undo (and its refund credits) is confirmed
// written. On 97d04b80 a failed queue write still let the commit go (the saver's turn counted as written): after a crash the loaded queue
// lacked the removal's undo identity and its credits. Registered into tools/gate6dgr.mjs (GR's survival town and halt helpers). Headless
// server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs psvcrash   (psv-crash)   two survival worlds, each: a town built in survival (fed until built), the periodic
//   ledger save off, /save-all flush (the baseline), every queue file write failing (dev.queue.writes fail), the region's removal asked
//   (not awaited), 20 s:
//     the removal waits: the town's cells unchanged (no undo committed), the region not REMOVED, the queue write failing; then
//       PSV1  a halt with nothing else saved while it fails, the world opened again (the writes as normal), the removal asked again: REMOVED,
//             the world as before the town, the refund booked once (no item refunded beyond what the town consumed; identity holds)
//       PSV2  the failure cleared: the retry (every 5 s) writes the queue file and the removal commits and ends REMOVED live; 12 s, a halt
//             with nothing else saved, the world opened again: the town stays removed, the stock after the restart equals the stock before
//             the halt (the refund kept, once)
//
// Evidence: artifacts/gate6d-gr/psvcrash.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import path from 'node:path';

export async function registerPSV(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, BOXOF, CX, CZ, CLAIM, haltWait, cellsOf, diff } = h;
  const caps = (await import('./gatebcc.mjs')).bccCaps({ call, check, json, G, owner: G.OWNER, log });
  const ctx = { L, OUT: h.OUT, imp: h.imp };
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const pos = (m) => Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => v > 0));
  const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];
  const ps = async (o) => call('dev.stockpile.ps', o, 30_000);
  const writes = async (o = {}) => call('dev.queue.writes', o, 10_000);
  const audit = async () => call('dev.stockpile.audit', { owner: G.OWNER }, 60_000);
  const backOf = (a) => G.plus(a.stock ?? {}, a.ledger?.refundOverflow ?? {});
  const stateOf = async (region) => (await call('dev.region.state', { region }, 60_000).catch(() => null))?.view?.state ?? null;

  async function untilEnded(region, n = 900) {
    let st;
    for (let i = 0; i < n; i++) {
      st = await stateOf(region);
      if (!st || ['REMOVED', 'PARTIAL', 'FAILED'].includes(st)) break;
      await L.sleep(2000);
    }
    return st;
  }

  async function halt(tag, W) {
    call('dev.stockpile.halt', {}, 10_000).catch(() => null); // the halt drops the call
    const down = await haltWait();
    check(down, `${tag}: halted with nothing else saved`);
    if (!down) return false;
    await L.openWorld(path.basename(W.dir));
    await L.tp(W.at[0], W.at[1], W.at[2]);
    await call('dev.wait', { ms: 3000 }, 30_000);
    await caps.afterRestart(tag);
    return true;
  }

  async function survivalWorld(name) {
    await G.survivalBase(ctx);
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await G.designs(ctx);
    const gy = await groundY();
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    await L.tp(CX + 80, 80, CZ + 56);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `${name}: a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    return { gy, crates, at: [CX + 80, 60, CZ + 56], dir: path.join(L.SAVES, name), BOX: BOXOF(CLAIM, gy) };
  }

  /** No item refunded beyond what the town consumed from the stockpile (a refund booked twice would exceed it). */
  function onceCheck(tag, refund, consumed) {
    const over = Object.entries(pos(refund)).filter(([k, v]) => v > (consumed[k] ?? 0)).map(([k, v]) => `${k} ${v} > ${consumed[k] ?? 0}`);
    check(sum(pos(refund)) > 0 && over.length === 0, `${tag}: the refund booked once: ${sum(pos(refund))} item(s), none beyond what the town consumed${over.length ? ` (over: ${over.join(', ')})` : ''}`, { refund, consumed });
  }

  async function oneCase(out, tag) {
    const W = await survivalWorld(`G6B PSV ${tag}`);
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const S0 = await cellsOf(W.BOX);
    const region = await caps.realise(L, p0.planId, { load: 'bounded:512', lots: { cottage_1: 'rs_hut' } });
    const f = await G.feed({ L }, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
    check(f.last.st.view.state === 'PLACED' && f.last.rs.build?.done, `${tag}: fed until built (${f.waves} waves): ${f.last.st.view.state}`);
    await ps({ noPeriodic: true, noCreditSave: false });
    await cmd('/save-all flush');
    await call('dev.wait', { ms: 2000 }, 30_000);
    const a0 = await audit();
    const cap = a0.ledger?.consumed ?? {}; // what the town consumed from the stockpile (a refund booked twice would exceed it)
    check(sum(cap) > 0, `${tag}: the town consumed ${sum(cap)} item(s) from the stockpile`);
    const S1 = await cellsOf(W.BOX);
    const w0 = await writes({ fail: 1_000_000 });
    log(`  ${tag}: queue writes before the failure ${json(w0)}`);
    call('dev.region.remove', { region, requester: G.OWNER }, 3_600_000).catch(() => null);
    await call('dev.wait', { ms: 20_000 }, 60_000);
    const w1 = await writes();
    const st1 = await stateOf(region);
    const d1 = diff(S1, await cellsOf(W.BOX));
    const n = { tag, region, w0, w1, stateWhileFailing: st1, cellsChangedWhileFailing: d1.n };
    check(w1.writeFailing === true && w1.writtenGen <= w0.writtenGen, `${tag}: every queue write fails (written gen ${w0.writtenGen} -> ${w1.writtenGen}, requested ${w1.requestedGen})`, w1);
    check(d1.n === 0 && st1 !== 'REMOVED', `${tag}: no undo committed while the queue file can't be written: ${d1.n} town cell(s) changed, the region ${st1}`, d1.first);
    if (tag === 'PSV1') {
      const ok = await halt(tag, W);
      if (!ok) { out[tag] = n; return; }
      n.afterRestart = await writes();
      n.stateAfterRestart = await stateOf(region);
      call('dev.region.remove', { region, requester: G.OWNER }, 3_600_000).catch(() => null);
      n.final = await untilEnded(region);
      check(!n.final || n.final === 'REMOVED', `${tag}: the removal asked again after the restart ends REMOVED (after the restart: ${n.stateAfterRestart}): ${n.final ?? 'gone'}`);
      await call('dev.wait', { ms: 5000 }, 30_000);
      const a2 = await audit();
      const refund = G.minus(backOf(a2), backOf(a0));
      const wd = diff(S0, await cellsOf(W.BOX));
      Object.assign(n, { refund, refundUnits: sum(pos(refund)), worldDiff: wd.n, identity: a2.identity });
      check(wd.n === 0, `${tag}: the world as before the town (${wd.n} cells differ)`, wd.first);
      onceCheck(tag, refund, cap);
      check(a2.identity !== false, `${tag}: the stockpile's identity holds (${a2.identity})`);
    } else {
      const wc = await writes({ fail: 0 });
      n.final = await untilEnded(region, 450);
      const w2 = await writes();
      n.w2 = w2;
      check(w2.writeFailing === false && w2.writtenGen > w1.writtenGen, `${tag}: the failure cleared, the retry wrote the queue file (written gen ${w1.writtenGen} -> ${w2.writtenGen}; ${json(wc)})`, w2);
      check(!n.final || n.final === 'REMOVED', `${tag}: the removal committed after the retry and ended: ${n.final ?? 'gone'}`);
      await call('dev.wait', { ms: 12_000 }, 60_000); // the restored chunks' eager saves
      const a1 = await audit();
      const refund = G.minus(backOf(a1), backOf(a0));
      onceCheck(tag, refund, cap);
      const ok = await halt(tag, W);
      if (!ok) { out[tag] = n; return; }
      await call('dev.wait', { ms: 5000 }, 30_000);
      const a2 = await audit();
      const d = G.minus(backOf(a2), backOf(a1));
      const wd = diff(S0, await cellsOf(W.BOX));
      Object.assign(n, { refund, refundUnits: sum(pos(refund)), delta: d, lossUnits: sum(pos(G.minus({}, d))), mintUnits: sum(pos(d)), worldDiff: wd.n,
        identity: a2.identity, stateAfterRestart: await stateOf(region) });
      check(wd.n === 0, `${tag}: the town stays removed after the restart (${wd.n} cells differ from before it; region ${n.stateAfterRestart ?? 'gone'})`, wd.first);
      check(n.lossUnits === 0 && n.mintUnits === 0 && a2.identity !== false, `${tag}: the refund kept once: the stock after the restart equals the stock before the halt (lost ${n.lossUnits}, minted ${n.mintUnits}; identity ${a2.identity})`, n);
    }
    log(`  ${tag}: ${json({ ...n, w0: undefined })}`);
    out[tag] = n;
    await ps({ noPeriodic: false, noCreditSave: false }).catch(() => null);
    await L.leaveWorld();
  }

  steps.psvcrash = async () => {
    await ensure();
    const out = {};
    const parts = (process.env.GATE_PSV_PARTS ?? 'PSV1,PSV2').split(',');
    for (const tag of parts) {
      try {
        await oneCase(out, tag);
      } catch (e) {
        check(false, `${tag}: ${String(e?.message ?? e).slice(0, 300)}`);
        out[tag] = { error: String(e?.stack ?? e) };
        await L.leaveWorld().catch(() => null);
      }
    }
    spendZero();
    return out;
  };
}
