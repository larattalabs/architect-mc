// Slice HF gate (docs/CONTRACT.md "Slice HF, player saves with the ledger"): an explicit ledger save that persists an item move between
// a player's inventory and a stockpile also saves the players, so a crash after it neither dupes nor loses those items.
// Registered into tools/gate6dgr.mjs (GR's survival town and halt helpers). Headless server (a real ServerPlayer, saved to playerdata), the
// sim sidecar: $0.
//
//   node tools/gate6dgr.mjs hfcrash   (hf-crash)   one survival world, a stockpile of 4 crates, a town realised and every target paused (so
//                                                  nothing is consumed and the counts stay put); two cases, each: /save-all flush (the
//                                                  baseline: players, chunks and ledger on disk), a move, an explicit ledger save, a halt
//                                                  with nothing else saved (dev.stockpile.halt), stockpiles.json and playerdata read off the
//                                                  disk, the world opened again:
//                                                  D  "Insert from inventory" (the crate screen's path) of an item the town needs, then
//                                                     dev.stockpile.addcrate (what /steward stockpile <id> add calls): before HF a dupe
//                                                  L  "Insert from inventory", then a logout (vanilla saves that player) and a new join: before
//                                                     HF a loss (the player saved without the items, the ledger rewound)
//                                                  T  the region removed (its stock becomes credit), a Take (withdraw) into the inventory, a
//                                                     crate added: before HF a loss of the take
//                                                  X  dissolveStockpile to the player (its own explicit save): before HF a loss of the stock
//                                                  each: the player's inventory + the stock after the restart equal the totals before the
//                                                  move, item for item (no mint, no loss); the explicit save saved the players (playerdata's
//                                                  mtime moved) and its cost is recorded
//
// Evidence: artifacts/gate6d-gr/hfcrash.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';

export async function registerHF(steps, h) {
  const { L, call, check, cmd, log, OUT, json, G, ensure, spendZero, groundY, CX, CZ, CLAIM, haltWait } = h;
  const ctx = { L, OUT, imp: h.imp };
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const pos = (m) => Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => v > 0));
  const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];
  const ledgerOf = (root) => (root?.stockpiles ?? []).find((p) => p.owner === G.OWNER)?.ledger ?? null;

  /** The player's inventory and the stockpile's stock (with the ledger), live. */
  async function counts() {
    const a = await call('dev.stockpile.audit', { owner: G.OWNER }, 60_000);
    return { inv: a.inventory ?? {}, stock: a.stock ?? {}, ledger: a.ledger ?? null };
  }
  /** The bot's saved player file (the newest playerdata/*.dat): its mtime, ms. */
  function playerFile(dir) {
    const d = path.join(dir, 'playerdata');
    const fs0 = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.dat')) : [];
    const best = fs0.map((f) => ({ f, m: fs.statSync(path.join(d, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
    return best ?? { f: null, m: 0 };
  }
  const saved = async () => call('dev.stockpile.saved', {}, 60_000);

  /**
   * One case: the baseline (flush), `move()` (the item move and, inside or after it, the explicit save), a halt with nothing saved, the
   * disk read before the restart, the world opened again. `items`: the items the move concerns (the totals are judged on them).
   */
  async function crashCase(tag, W, items, move) {
    await cmd('/save-all flush');
    await call('dev.wait', { ms: 2000 }, 30_000);
    const s0 = await saved();
    const pf0 = playerFile(W.dir);
    const c0 = await counts();
    const total0 = G.plus(pick(c0.inv, items), pick(c0.stock, items));
    const m = await move();
    const c1 = await counts();
    const s1 = await saved();
    const pf1 = playerFile(W.dir);
    const explicit = s1.saves - s0.saves;
    check(explicit >= 1 && s1.worldSaves > s0.worldSaves, `${tag}: the move's explicit ledger save ran (${explicit} ledger save(s), ${s1.worldSaves - s0.worldSaves} with the world; ${Number(s1.lastWorldSaveMs).toFixed(1)} ms)`, { s0, s1 });
    const n = { tag, items, move: m, before: { inv: pick(c0.inv, items), stock: pick(c0.stock, items) }, live: { inv: pick(c1.inv, items), stock: pick(c1.stock, items) },
      ledgerSaves: explicit, worldSaves: s1.worldSaves - s0.worldSaves, playerSaves: (s1.playerSaves ?? 0) - (s0.playerSaves ?? 0),
      worldSaveMs: s1.lastWorldSaveMs, playerSaveMs: s1.lastPlayerSaveMs ?? null, maxPlayerSaveMs: s1.maxPlayerSaveMs ?? null,
      playerFile: pf1.f, playerFileMoved: pf1.m > pf0.m };
    call('dev.stockpile.halt', {}, 10_000).catch(() => null); // the halt drops the call
    const down = await haltWait();
    check(down, `${tag}: halted with nothing else saved`);
    if (!down) return null;
    const disk = JSON.parse(fs.readFileSync(path.join(W.dir, 'architect', 'stockpiles.json'), 'utf8'));
    n.diskLedger = ledgerOf(disk);
    n.playerFileAtHalt = playerFile(W.dir).m > pf0.m;
    await L.openWorld(path.basename(W.dir));
    await L.tp(W.at[0], W.at[1], W.at[2]);
    await call('dev.wait', { ms: 3000 }, 30_000);
    const c2 = await counts();
    const total2 = G.plus(pick(c2.inv, items), pick(c2.stock, items));
    const d = G.minus(total2, total0);
    Object.assign(n, { after: { inv: pick(c2.inv, items), stock: pick(c2.stock, items) }, total0, total2, delta: d, mintUnits: sum(pos(d)), lossUnits: sum(pos(G.minus({}, d))) });
    log(`  ${tag}: before ${json(n.before)}; live after the move ${json(n.live)}; after the restart ${json(n.after)}; delta ${json(d)}; player saves ${n.playerSaves} (${n.playerSaveMs} ms), playerdata moved ${n.playerFileMoved}`);
    check(n.playerSaves >= 1 && n.playerFileMoved, `${tag}: the explicit save saved the players (${n.playerSaves} player save(s), ${Number(n.playerSaveMs ?? NaN).toFixed(2)} ms; playerdata written: ${n.playerFileMoved})`, n);
    check(G.same(total2, total0), `${tag}: inventory + stock after the restart ${json(total2)} equal the totals before the move ${json(total0)} (minted ${n.mintUnits}, lost ${n.lossUnits})`, n);
    return n;
  }
  function pick(m, items) {
    const o = {};
    for (const k of items) if (m?.[k]) o[k] = m[k];
    return o;
  }

  steps.hfcrash = async () => {
    await ensure();
    const out = {};
    await G.survivalBase(ctx);
    const name = 'G6B HF crash';
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await G.designs(ctx);
    const gy = await groundY();
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const at = [CLAIM[0] - 3, gy + 2, CLAIM[1] - 3]; // within 16 blocks of the crates (Insert from inventory's reach)
    await L.tp(CX + 80, 80, CZ + 56);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `HF: a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: 'rs_hut' } });
    await L.tp(...at);
    const W = { dir: path.join(L.SAVES, name), at, region };
    // every target paused: the builder consumes nothing, so the stock moves only by the cases' own moves (a paused target still counts as
    // outstanding: the accept rule takes its items)
    const st0 = (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
    for (const id of st0.feedOrder ?? []) await call('dev.stockpile.pause', { owner: G.OWNER, site: id, paused: true }, 60_000);
    const need = st0.outstanding ?? {};
    const pickItem = (not) => Object.entries(need).filter(([k]) => !not.includes(k)).sort((a, b) => b[1] - a[1])[0];
    log(`  HF: ${(st0.feedOrder ?? []).length} target(s) paused; outstanding ${json(need)}`);

    const addCrateAt = (k) => [CLAIM[0] + 2 * k, gy + 1, CLAIM[1] - 6];
    const playerBack = async () => {
      for (let i = 0; i < 60; i++) {
        const st = await call('dev.state', {}, 10_000).catch(() => null);
        if (st?.player) return true;
        await L.sleep(1000);
      }
      return false;
    };

    // D (F1): Insert from inventory, then an explicit save (a crate added), then the halt
    const [A, kA] = pickItem([]) ?? [];
    {
      const n = Math.min(kA ?? 0, 64);
      check(n > 0, `D: the town needs ${A} x${kA}: ${n} given to the player`);
      await cmd(`/give @s ${A} ${n}`);
      out.D = await crashCase('D', W, [A], async () => {
        const ins = await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, inventory: true }, 120_000);
        const add = await call('dev.stockpile.addcrate', { owner: G.OWNER, pos: addCrateAt(1) }, 120_000);
        check(ins.moved > 0 && !add.refused, `D: ${ins.moved} item(s) moved from the inventory into the stockpile; a crate added (an explicit ledger save): ${json(add.refused ?? 'added')}`);
        return { moved: ins.moved, added: !add.refused };
      });
    }

    // L (F9): Insert from inventory, then a logout (the player saved) and a new join, then the halt
    // the same item when the town needs only one (what it still accepts: its need less the stock)
    const [B, kB] = pickItem([A]) ?? [A, kA];
    {
      const n = Math.min(Math.max(0, (kB ?? 0) - ((await counts()).stock[B] ?? 0)), 64);
      check(n > 0, `L: the town needs ${B} x${kB}: ${n} given to the player`);
      await cmd(`/give @s ${B} ${n}`);
      out.L = await crashCase('L', W, [B], async () => {
        const ins = await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, inventory: true }, 120_000);
        await call('dev.bot.relog', {}, 10_000);
        const back = await playerBack();
        await call('dev.wait', { ms: 2000 }, 30_000);
        check(ins.moved > 0 && back, `L: ${ins.moved} item(s) moved into the stockpile; the player logged out and joined again (${back})`);
        return { moved: ins.moved, relogged: back };
      });
    }

    // T (F5, Take): the region removed (its stock becomes credit), a withdraw into the inventory, an explicit save (a crate added), the halt
    {
      const r = await call('dev.region.remove', { region, requester: G.OWNER }, 600_000).catch((e) => ({ refused: String(e) }));
      let st;
      for (let i = 0; i < 300; i++) {
        st = await call('dev.region.state', { region }, 60_000).catch(() => null);
        if (!st?.view?.state || ['REMOVED', 'PARTIAL', 'FAILED'].includes(st.view.state)) break;
        await L.sleep(2000);
      }
      const p1 = (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
      const credit = p1.credit ?? {};
      const take = Math.floor((credit[A] ?? 0) / 2);
      check(take > 0, `T: the region removed (${st?.view?.state ?? 'gone'}${r?.refused ? `; ${r.refused}` : ''}); credit ${json(credit)}: take ${take} ${A}`);
      await cmd('/clear @s');
      out.T = await crashCase('T', W, [A], async () => {
        const w = await call('dev.stockpile.withdraw', { owner: G.OWNER, items: { [A]: take } }, 120_000);
        const add = await call('dev.stockpile.addcrate', { owner: G.OWNER, pos: addCrateAt(2) }, 120_000);
        check(!w.refused && (w.withdrawn?.[A] ?? 0) === take && !add.refused, `T: withdrew ${json(w.withdrawn ?? w.refused)} into the inventory; a crate added (an explicit ledger save): ${json(add.refused ?? 'added')}`);
        return { withdrawn: w.withdrawn ?? {}, added: !add.refused };
      });
    }

    // X (F5, dissolve): dissolveStockpile to the player (its own explicit save), then the halt
    {
      const stock = (await counts()).stock;
      const items = Object.keys(stock);
      check(sum(stock) > 0 && sum(stock) <= 30 * 64, `X: the stockpile holds ${sum(stock)} unit(s) (${json(stock)}): fits the inventory`);
      await cmd('/clear @s');
      out.X = await crashCase('X', W, items, async () => {
        const d = await call('dev.stockpile.dissolve', { owner: G.OWNER, toPlayer: true }, 120_000);
        check(!d.refused, `X: dissolved to the player: ${json(d.refused ?? d.out)}`);
        return { out: d.out ?? {} };
      });
    }
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
