// Slice RL gate (docs/CONTRACT.md "Slice RL, reconcile at load"): after a halt with nothing saved and no undo, the blocks standing in the
// saved world and the items in the saved ledger never both exist (no dupe), and the builder never charges a cell the saved ledger already
// paid (no double charge). Registered into tools/gate6dgr.mjs (GR's survival town and feed helpers). Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs rlcrash   (rl-crash)   three survival towns (a flat_village region of a hall and a cottage), each realised, then:
//                                                  RL1  half of what it needs delivered, the ledger saved at once (/save-all flush, as an
//                                                       autosave) while the builder consumes it, the builder starved, 12 s for the chunks'
//                                                       eager saves, a halt with nothing saved; restarted, then fed until built
//                                                  RL2  all of it delivered and saved at once, built (BUILT recorded) after the save, 12 s,
//                                                       a halt with nothing saved; restarted
//                                                  RL3  all of it delivered, 1.5 s of building, then a halt straight after an autosave's
//                                                       chunk save without flush (the ledger on disk, the chunks maybe not); restarted, fed
//                                                       until built
//                                                  each: <world>/architect/stockpiles.json read off the disk before the restart; after it
//                                                  the paid cells standing equal the targets' paid records, item for item (no dupe, no
//                                                  double charge), what the targets consumed since the baseline equals what their records
//                                                  gained, and a second restart changes nothing (idempotent)
//
// Evidence: artifacts/gate6d-gr/rlcrash.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';

export async function registerRL(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, BOXOF, CX, CZ, CLAIM, haltWait } = h;
  const ctx = { L, OUT: h.OUT, imp: h.imp };
  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const audit = async () => call('dev.stockpile.audit', { owner: G.OWNER }, 120_000);
  const savedNow = async () => call('dev.stockpile.saved', { owner: G.OWNER }, 60_000);
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const pos = (m) => Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => v > 0));
  const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];
  const ledgerOf = (root) => (root?.stockpiles ?? []).find((p) => p.owner === G.OWNER)?.ledger ?? null;
  /** Every target's paid record, summed per item. */
  const paidSum = (l) => Object.values(l?.paid ?? {}).reduce((a, m) => G.plus(a, m), {});
  function stockOf(l) {
    const o = {};
    for (const k of new Set([...Object.keys(l?.delivered ?? {}), ...Object.keys(l?.returned ?? {})])) {
      const s = (l.delivered?.[k] ?? 0) + (l.returned?.[k] ?? 0) - (l.consumed?.[k] ?? 0) - (l.withdrawn?.[k] ?? 0) - (l.dropped?.[k] ?? 0);
      if (s) o[k] = s;
    }
    return o;
  }

  async function world(name) {
    await G.survivalBase(ctx);
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await G.designs(ctx);
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `${name}: a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: 'rs_hut' } });
    // the targets joined the feed: what they need is outstanding
    let ps;
    for (let i = 0; i < 60; i++) {
      ps = await G.pileState(ctx);
      if (sum(ps.outstanding) > 0) break;
      await L.sleep(1000);
    }
    check(sum(ps?.outstanding) > 0, `${name}: the town realised in survival; its targets need ${sum(ps?.outstanding)} units`);
    return { gy, BOX: BOXOF(CLAIM, gy), dir: path.join(L.SAVES, name), name, region };
  }

  /** Delivers `fraction` of what the targets still lack, in one insert. */
  async function deliver(fraction) {
    const ps = await G.pileState(ctx);
    const need = {};
    for (const [it, n] of Object.entries(ps.outstanding ?? {})) {
      const lack = n - (ps.stock?.[it] ?? 0);
      if (lack > 0) need[it] = fraction >= 1 ? lack : Math.max(1, Math.floor(lack * fraction));
    }
    const acc = (await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: need, exact: true }, 120_000)).accepted ?? {};
    return { need, acc };
  }

  /** Waits until the ledger's consumption stops moving for `quietMs` (the builder starved or done). */
  async function quiet(quietMs = 4000, timeoutMs = 600_000) {
    const end = Date.now() + timeoutMs;
    let last = null, since = Date.now();
    for (; Date.now() < end;) {
      const c = json((await pile()).ledger?.consumed ?? {});
      if (c !== last) { last = c; since = Date.now(); } else if (Date.now() - since >= quietMs) return true;
      await L.sleep(1000);
    }
    return false;
  }

  /** The conservation numbers of one audit against a ledger: standing paid cells vs the records. */
  function balance(a) {
    const l = a.ledger ?? {};
    const standing = G.plus(a.paidStanding ?? {}, {});
    for (const k of ['fluidStanding', 'mechStanding']) for (const [it, n] of Object.entries(a[k] ?? {})) standing[it] = (standing[it] ?? 0) - n;
    const paid = paidSum(l);
    const d = G.minus(standing, paid);
    return { standing: sum(standing), paid: sum(paid), dupe: pos(d), double: pos(G.minus(paid, standing)), dupeUnits: sum(pos(d)), doubleUnits: sum(pos(G.minus(paid, standing))), stock: a.stock ?? {} };
  }

  async function restart(W) {
    await L.openWorld(W.name);
    await L.tp(CX + 80, 60, CZ + 56);
    await L.settle(4000);
  }

  async function halt(tag, mode = 'now') {
    await call('dev.stockpile.halt', { mode }, 10_000).catch(() => null);
    const down = await haltWait();
    check(down, `${tag}: dev.stockpile.halt (${mode}) halted the server`);
    return down;
  }

  /** After the restart: the first audit (the reconcile's result), the build finished, the final audit, and a second restart. */
  async function after(tag, W, c, { feedAfter }) {
    const a1 = await audit();
    const b1 = balance(a1);
    log(`  ${tag}: after the restart: standing ${b1.standing}, paid records ${b1.paid}; standing unpaid ${json(b1.dupe)}; paid not standing ${json(b1.double)}; stock ${sum(b1.stock)}`);
    let f = null;
    if (feedAfter) {
      f = await G.feed({ L }, W.region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
      check(f.last.st.view.state === 'PLACED' && f.last.rs.build?.done, `${tag}: fed until built after the restart (${f.waves} waves): ${f.last.st.view.state}`);
    } else {
      // (RL) a reconciled target that owes items its stock holds charges them and is built again
      f = await G.feed({ L }, W.region, { fraction: 1, timeoutMs: 600_000, every: 2500 });
    }
    await quiet();
    const a2 = await audit();
    const b2 = balance(a2);
    const consumed = G.minus(a2.ledger?.consumed, c.b0.ledger.consumed);
    const gained = G.minus(paidSum(a2.ledger), paidSum(c.b0.ledger));
    log(`  ${tag}: built: standing ${b2.standing}, paid records ${b2.paid}; standing unpaid ${json(b2.dupe)}; paid not standing ${json(b2.double)}; consumed since the baseline ${sum(consumed)}, records gained ${sum(gained)}`);
    check(b2.dupeUnits === 0 && b2.doubleUnits === 0 && a2.identity !== false, `${tag}: built after the restart, the paid cells standing equal the targets' paid records item for item (standing ${b2.standing}, paid ${b2.paid}; dupe ${b2.dupeUnits}: ${json(b2.dupe)}; double charge ${b2.doubleUnits}: ${json(b2.double)}; identity ${a2.identity})`, { b1, b2 });
    check(G.same(consumed, gained), `${tag}: what the targets consumed since the baseline (${sum(consumed)}) is what their records gained (${sum(gained)}), item for item`, { consumed, gained });
    // idempotent: a clean stop and a second load change nothing
    await L.leaveWorld();
    await restart(W);
    await quiet();
    const a3 = await audit();
    const b3 = balance(a3);
    check(G.same(a3.ledger?.consumed, a2.ledger?.consumed) && G.same(a3.stock, a2.stock) && b3.dupeUnits === 0 && b3.doubleUnits === 0, `${tag}: a second load changes nothing (consumed ${sum(a3.ledger?.consumed)} = ${sum(a2.ledger?.consumed)}, stock ${sum(a3.stock)} = ${sum(a2.stock)})`, { b3 });
    return { b1, b2, b3, consumed, gained, waves: f?.waves };
  }

  steps.rlcrash = async () => {
    await ensure();
    const out = {};

    // RL1: the ledger saved mid-feed (half delivered and being consumed), starved, then a halt with nothing saved
    {
      const tag = 'RL1';
      const W = await world('G6B RL RL1');
      const d = await deliver(0.5);
      await cmd('/save-all flush');
      const b0 = { ledger: ledgerOf((await savedNow()).file) };
      check(sum(d.acc) > 0 && b0.ledger, `${tag}: half delivered (${sum(d.acc)} units) and the ledger saved at once (/save-all flush) while the builder consumes it`);
      check(await quiet(), `${tag}: the builder starved`);
      await call('dev.wait', { ms: 12_000 }, 60_000);
      const live = balance(await audit());
      if (await halt(tag)) {
        const Ld = ledgerOf(JSON.parse(fs.readFileSync(path.join(W.dir, 'architect', 'stockpiles.json'), 'utf8')));
        const n = { live, savedPaid: sum(paidSum(Ld)), savedStock: sum(stockOf(Ld)) };
        await restart(W);
        out[tag] = { ...n, ...(await after(tag, W, { b0 }, { feedAfter: true })) };
      }
      await L.leaveWorld();
    }

    // RL2: all delivered and saved at once, built after the save, then a halt
    {
      const tag = 'RL2';
      const W = await world('G6B RL RL2');
      const d = await deliver(1);
      await cmd('/save-all flush');
      const b0 = { ledger: ledgerOf((await savedNow()).file) };
      check(sum(d.acc) > 0 && b0.ledger, `${tag}: all delivered (${sum(d.acc)} units) and the ledger saved at once`);
      const f = await G.feed({ L }, W.region, { fraction: 1, timeoutMs: 900_000, every: 2500 });
      check(f.last.st.view.state === 'PLACED' && f.last.rs.build?.done && f.waves === 0, `${tag}: built from that delivery (${f.waves} more waves): ${f.last.st.view.state}`);
      await call('dev.wait', { ms: 12_000 }, 60_000);
      const live = balance(await audit());
      if (await halt(tag)) {
        const Ld = ledgerOf(JSON.parse(fs.readFileSync(path.join(W.dir, 'architect', 'stockpiles.json'), 'utf8')));
        const n = { live, savedPaid: sum(paidSum(Ld)), savedStock: sum(stockOf(Ld)) };
        await restart(W);
        out[tag] = { ...n, ...(await after(tag, W, { b0 }, { feedAfter: false })) };
      }
      await L.leaveWorld();
    }

    // RL3: the ledger ahead of the chunks: an autosave's chunk save without flush, then the halt at once
    {
      const tag = 'RL3';
      const W = await world('G6B RL RL3');
      await cmd('/save-all flush');
      const b0 = { ledger: ledgerOf((await savedNow()).file) };
      const d = await deliver(1);
      check(sum(d.acc) > 0, `${tag}: all delivered (${sum(d.acc)} units)`);
      await L.sleep(1500);
      const live = balance(await audit());
      if (await halt(tag, 'autosave')) {
        const Ld = ledgerOf(JSON.parse(fs.readFileSync(path.join(W.dir, 'architect', 'stockpiles.json'), 'utf8')));
        const n = { live, savedPaid: sum(paidSum(Ld)), savedStock: sum(stockOf(Ld)) };
        await restart(W);
        out[tag] = { ...n, ...(await after(tag, W, { b0 }, { feedAfter: true })) };
      }
      await L.leaveWorld();
    }
    spendZero();
    return out;
  };
}
