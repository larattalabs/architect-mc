// Slice T2b part 2b gate (docs/CONTRACT.md "Slice T2b part 2b as built"): a removed crate-fed construction site's crate settles once
// through the crate.settle txn (its stock and its refunds owed, or credited to a pile; its cell restored; never an item entity), after the
// removal's own commit. Ported from slice CXD's cxd-crash (origin/slice/CXD tools/lib/gatemcxd.mjs: fill, playerSite, the sharedCrate
// batch); the owed model is T2b's owed collectibles (dev.stockpile.owed), not CXD's records. Registered into tools/gate6dgr.mjs.
// Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs txncrashcrate   (txn-crash-crate)   one survival world; per row a crate-fed construction site (rs_hut), paused,
//   part of its bill in its crate (/save-all flush: the baseline), then:
//     S-<point>[s]  a player's site (/architect place) deconstructed alone, halted at K5, K6, R4 (the restore written, nothing settled) and
//                   every traced TX:crate.settle:* point, bare and +save (s); the world opened again, the recovery waited out
//     G-<point>[s]  the same for a group's shared crate (an actorless batch, sharedCrate) removed with its group (sgremove)
//     P1-1..P1-4    one row per P1 of CXD's last GPT review: (1) the evidence of a pickup is the owed ledger (collected, then a halt +save:
//                   paid once); (2) a settle whose barrier fails after its decision is held, never discarded (then a halt +save); (3) a
//                   two-member group's refunds are keyed effects, never queue amounts (halted at GM, bare and +save: the first member written and settled, the second not); (4) a
//                   removal ended before its commit (dev.journal.failNextCommit) never touched the crate (the builder then consumes)
//     MF1, MF2, MF4 the coordinator's must-fix rows: a held crate never funds a placement; an adoption that skips a held crate keeps every
//                   reference to it; the last road over a held crate stays BUILDING. A crate is held by a test.move out of it with
//                   every txn barrier refused (dev.txn.failBarrier: the move aborts, its take compensated, the hold kept until one works)
//     MF3           a completed site's crate leftovers (dev.site.finish over a stocked crate) go through crate.settle: owed, never dropped
//   judged: the units (crate stock + placed + owed + ground + inventory) after = before, item for item; no item entity near the crate
//   (rule R-5: nothing dropped); txn open 0; a gone site's crate cell restored and its owed entry naming the site. On the base (main's
//   take-at-prepare + drop) the TX rows are N/A (no crate.settle kind): the trace finds none.
//
//   GATE_TCC_PARTS=S,G,P1,MF (default all) or a list of row tags limits the rows.
// Evidence: <out>/txncrashcrate.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import path from 'node:path';
import { secondCrash, txnOpenOnDisk, killMarker, KILL_MARKER } from './second-crash.mjs';

export async function registerTCC(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, CX, CZ, cellsOf } = h;
  const ctx = { L, OUT: h.OUT, imp: h.imp };
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const pick = (m, items) => Object.fromEntries(items.filter((k) => m?.[k]).map((k) => [k, m[k]]));
  const api = async (args) => {
    const r = await cmd(`/apitest ${args}`);
    const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
    if (line === undefined) throw new Error(`/apitest ${args.slice(0, 120)}: no JSON answer: ${JSON.stringify(r).slice(0, 400)}`);
    return JSON.parse(line);
  };
  const later = async (args, timeoutMs = 600_000) => {
    const pd = await api(args);
    if (!pd?.pending) return pd;
    for (const end = Date.now() + timeoutMs; Date.now() < end; await L.sleep(500)) {
      const r = await api(`get ${pd.pending}`);
      if (r && r.value !== undefined && r.value !== null) return r.value;
    }
    throw new Error(`no result for ${pd.pending}`);
  };
  const wait = (ms) => call('dev.wait', { ms }, 60_000);
  // a halt waited at most 90 s (the shared haltWait's 6 min would trip the runner's 5 min stall guard on a point never reached)
  const haltWait = async () => {
    for (let i = 0; i < 45; i++) {
      await L.sleep(2000);
      const st = await call('dev.state', {}, 10_000).catch(() => null);
      if (st && st.inWorld === false) return true;
    }
    return false;
  };
  // (slice T4R-D fix round, SPD) the host has no server process now (a headless host's phase 'title'; a client: not in a world)
  const serverGone = async () => { const st = await call('dev.state', {}, 10_000).catch(() => null); return !!st && (st.headless ? st.phase === 'title' : st.inWorld === false); };
  const siteState = async (site) => call('dev.site.state', { site }, 60_000).catch(() => null);
  const owedAll = async () => (await call('dev.stockpile.owed', {}, 30_000).catch(() => null)) ?? { owed: [], total: {} };
  const txn = async () => call('dev.txn.state', {}, 30_000).catch(() => ({ openCount: -1 }));
  const cellOf = async (cp) => (await call('dev.txn.cells', { cells: [cp] }, 30_000).catch(() => ({})))[cp.join(',')] ?? {};
  const isCrate = (c) => /crate/.test(String(c?.be ?? '')) || /crate/.test(String(c?.state ?? ''));

  /** The crate's own stock (dev.txn.cells: its ledger, whether a site still reads it or not), item -> units. */
  const crateItems = async (cp) => {
    const out = {};
    for (const v of Object.values((await cellOf(cp)).slots ?? {})) {
      const m = /^(\S+) x(\d+)$/.exec(String(v));
      if (m) out[m[1]] = (out[m[1]] ?? 0) + Number(m[2]);
    }
    return out;
  };
  // (last round) each site's box, read while it stands: its placed items are counted from the blocks in the world, never its ledger (a
  // record that vanished must not hide a block still standing)
  const BOXES = {};
  const boxOf = async (site) => {
    if (!BOXES[site]) {
      const v = ((await api('sites').catch(() => ({ all: [] }))).all ?? []).find((x) => x.id === site);
      const m = v && /minX=(-?\d+), minY=(-?\d+), minZ=(-?\d+), maxX=(-?\d+), maxY=(-?\d+), maxZ=(-?\d+)/.exec(v.box);
      if (m) BOXES[site] = m.slice(1, 7).map(Number);
    }
    return BOXES[site] ?? null;
  };
  /** Blocks of {@code items} standing in {@code site}'s box (a block id counted as its item: cobblestone, glass_pane, copper_block, gravel). */
  async function standing(site, items) {
    const b = await boxOf(site);
    if (!b) return {};
    const out = {};
    for (const st of (await cellsOf(b)).values()) {
      // (slice T4R-N) a two-block block (a door) is one item: its upper half is not counted again (counted twice, a popped door half's
      // stray item on the ground balanced the books)
      if (/half=upper/.test(String(st))) continue;
      const id = String(st).replace(/\[.*$/, '').replace(/(^|:)wall_torch$/, '$1torch'); // (T4b) a wall torch is its torch item
      const full = id.includes(':') ? id : `minecraft:${id}`;
      if (items.includes(full)) out[full] = (out[full] ?? 0) + 1;
    }
    return out;
  }

  /** The units of {@code items} for {@code sites}: their crate's stock, the blocks standing in their boxes, the owed total, the ground near the crate, the inventory. */
  async function parts(sites, cp, items) {
    let placed = {};
    const st = {};
    for (const s of sites) {
      const v = await siteState(s);
      st[s] = v ? v.state : null;
      placed = G.plus(placed, await standing(s, items));
    }
    const stock = await crateItems(cp);
    const ow = await owedAll();
    const near = await call('dev.items.near', { pos: cp, radius: 8 }, 30_000);
    const cell = await cellOf(cp);
    // (T4b fix round) owed counted from the entries naming these sites (an earlier row's held txn that finishes later is not this row's)
    const own = {};
    for (const e of ow.owed ?? []) if (sites.includes(e.site)) for (const [k2, v] of Object.entries(e.items ?? {})) own[k2] = (own[k2] ?? 0) + v;
    const p = { stock: pick(stock, items), placed: pick(placed, items), owed: pick(own, items), ground: pick(near.items ?? {}, items),
      inventory: pick(near.inventory ?? {}, items), states: st, crate: isCrate(cell), owedEntries: (ow.owed ?? []).filter((e) => sites.includes(e.site)) };
    p.total = [p.stock, p.placed, p.owed, p.ground, p.inventory].reduce((a, b) => G.plus(a, b), {});
    return p;
  }

  /** A site's crate: paused, part of its bill in it ({@code build}: a first part placed first, so it has refunds). Its cell and the items. */
  async function fill(tag, site, build = false, stock = true) {
    for (let i = 0; i < 120; i++) {
      if ((await siteState(site))?.state === 'building') break;
      await L.sleep(1000);
    }
    await boxOf(site);
    await call('dev.stockpile.pause', { site, paused: true }, 60_000);
    const st0 = await siteState(site);
    const give = {};
    for (const [k, v] of Object.entries(st0?.bom ?? {}).slice(0, 3)) give[k] = Math.max(1, Math.floor(v / 2));
    if (build) {
      const first = {};
      for (const [k, v] of Object.entries(give)) first[k] = Math.max(1, Math.floor(v / 2));
      await call('dev.crate.insert', { site, items: first, exact: true }, 120_000);
      await call('dev.stockpile.pause', { site, paused: false }, 60_000);
      for (let i = 0; i < 30; i++) {
        if (sum((await siteState(site))?.ledger?.stock) === 0) break;
        await L.sleep(500);
      }
      await call('dev.stockpile.pause', { site, paused: true }, 60_000);
      await wait(1000);
    }
    if (!stock) return null; // (a shared crate's earlier member: its first part placed; the stock goes in once, for the last)
    const ins = await call('dev.crate.insert', { site, items: give, exact: true }, 120_000);
    await wait(1500);
    const st1 = await siteState(site);
    const cp = [st1.crate.x, st1.crate.y, st1.crate.z];
    check(st1.crate.present && sum(st1.ledger?.stock) > 0, `${tag}: ${site}'s crate at ${cp} holds ${sum(st1.ledger?.stock)} item(s) (inserted ${json(ins.accepted ?? give)})${build ? `, ${sum(st1.ledger?.placed)} placed` : ''}`);
    return { cp, items: Object.keys(give) };
  }

  /** A player's construction rs_hut (/architect place: the placer's UUID, no site owner) in front of {@code origin}; its id. */
  async function playerSite(tag, origin) {
    await L.tp(origin[0], origin[1] + 1, origin[2]);
    await cmd(`/tp @s ${origin[0]} ${origin[1] + 1} ${origin[2]} 0 0`).catch(() => null);
    const r = await cmd('/architect place rs_hut');
    const id = /Construction site (\S+) /.exec((r.messages ?? []).join(' '))?.[1] ?? null;
    check(!!id, `${tag}: a player's construction rs_hut at ${origin}: ${id ?? json(r.messages).slice(0, 200)}`);
    return id;
  }

  /** An actorless batch of rs_huts from one shared crate; {@code n} members ({@code owner}: the batch's owner). Its sites and group. */
  async function groupSites(tag, at, n = 1, owner = null) {
    const items = Array.from({ length: n }, (_, i) => ({ key: `h${i + 1}`, bp: 'rs_hut', at: [at[0] + 14 * i, at[1], at[2]], rot: 0, mode: 'CONSTRUCTION' }));
    const spec = { id: `tcc${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}${Date.now() % 100000}`, proximity: false, sharedCrate: true, items, ...(owner ? { owner } : {}) };
    const bid = await later(`bqueue ${JSON.stringify(spec)}`, 120_000);
    let bv;
    for (let i = 0; i < 120; i++) { bv = await api(`batch ${bid}`); if (bv.items?.every((x) => x.site)) break; await L.sleep(1000); }
    const sites = (bv?.items ?? []).map((x) => x.site).filter(Boolean);
    check(sites.length === n, `${tag}: ${n} actorless construction rs_hut(s) from their group's shared crate (${sites.join(',')}, group ${bv?.group})`, bv);
    return { sites, group: bv?.group };
  }

  /** Waits out the recovery after a restart (txn open 0, and the removal settled or the site standing), at most {@code ms}. */
  async function settleWait(sites, cp, group, ms = 40_000) {
    let t, gs = null;
    for (const end = Date.now() + ms; Date.now() < end; await L.sleep(1000)) {
      t = await txn();
      if (group) gs = (await api(`sgroup ${group}`).catch(() => null))?.state ?? null;
      const stands = (await Promise.all(sites.map(siteState))).some(Boolean);
      const crate = isCrate(await cellOf(cp));
      if (t.openCount === 0 && t.recovered !== false && (!group || !gs || ['REMOVED', 'PARTIAL', 'FAILED', 'ACTIVE'].includes(gs)) && (stands || !crate)) break;
    }
    if (group && gs === 'ACTIVE') {
      // planned again after the restart (its undo never committed): the group's removal runs to its end, then it is judged
      await later(`sgremove ${group}`, 600_000).catch(() => null);
      for (let i = 0; i < 40 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
      gs = (await api(`sgroup ${group}`).catch(() => null))?.state ?? null;
    }
    return { txn: t, group: gs };
  }

  function judge(out, tag, n, before, after, { committedOk = true, standsStock = true } = {}) {
    n.before = before;
    n.after = after;
    out[tag] = n;
    const gone = Object.values(after.states).every((s) => s === null);
    log(`  ${tag}: before ${json(before.total)}; after ${json(after.total)} (stock ${json(after.stock)}, placed ${json(after.placed)}, owed ${json(after.owed)}, ground ${json(after.ground)}, inv ${json(after.inventory)}; ${gone ? 'gone' : json(after.states)}; crate ${after.crate ? 'stands' : 'restored'}; txn open ${n.txn?.openCount})`);
    check(G.same(after.total, before.total), `${tag}: paid exactly once: after ${json(after.total)} = before ${json(before.total)} (stock + placed + owed + ground + inventory)`, n);
    check(sum(after.ground) === 0, `${tag}: nothing dropped as an item entity near the crate (${json(after.ground)})`, n);
    check((n.txn?.openCount ?? 0) === 0, `${tag}: no txn left open (${n.txn?.openCount})`, n.txn);
    if (gone && committedOk) {
      const own = after.owedEntries.filter((e) => e.reason === 'crate_settle' || e.reason === 'group_refund');
      check(!after.crate && (sum(after.owed) === sum(before.owed) || own.length > 0 && own.every((e) => !!e.site)),
        `${tag}: committed: the crate's cell restored (${after.crate ? 'a crate still stands' : 'restored'}), its stock owed to the site's recipient (${own.length} entr${own.length === 1 ? 'y' : 'ies'} naming ${json([...new Set(own.map((e) => e.site))])}${own.some((e) => e.region) ? ', region ' + own.find((e) => e.region).region : ''})`, after.owedEntries);
    }
    if (!gone && standsStock) check(after.crate && G.same(after.stock, before.stock), `${tag}: not committed: the site stands (${json(after.states)}), its crate holds its stock again ${json(after.stock)}`, n);
  }

  /** One crash row: the baseline, {@code point} armed, {@code remove}, the halt, the world again, the recovery, the judgement. */
  async function crashRow(out, tag, W, sites, point, remove, group = null, build = false) {
    for (const s of sites.slice(0, -1)) await fill(tag, s, build, false);
    const { cp, items } = await fill(tag, sites[sites.length - 1], build);
    await cmd('/save-all flush').catch(() => null);
    await wait(2000);
    const before = await parts(sites, cp, items);
    await call('dev.journal.killAt', { point }, 10_000);
    const m = await remove().catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
    const down = await haltWait();
    // a txn point an effect's probe skips on this path is never reached (the group's shared crate: its CRATE entry is released by the
    // group removal first, so the R effect probes APPLIED): recorded, and the row judged as the removal left it; a removal point must halt
    if (down || !point.startsWith('TX:')) check(down, `${tag}: halted at ${point} (${json(m).slice(0, 160)})`);
    else log(`  ${tag}: ${point} not reached on this path (its effect's probe answered APPLIED); judged without a restart`);
    if (!down) {
      // never reached: the removal ran past it (judged as it stands, no restart), so the row still says where the stock went
      await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
      const r0 = await settleWait(sites, cp, group);
      const pts = await call('dev.txn.points', { kind: 'crate.settle' }, 10_000).catch(() => null);
      judge(out, tag, { tag, point, sites, group, crate: cp, removal: m, txn: r0.txn, groupEnd: r0.group, halted: false, reached: pts }, before, await parts(sites, cp, items));
      return;
    }
    await L.openWorld(path.basename(W.dir));
    await L.tp(...W.at);
    const r = await settleWait(sites, cp, group);
    const after = await parts(sites, cp, items);
    judge(out, tag, { tag, point, sites, group, crate: cp, removal: m, txn: r.txn, groupEnd: r.group }, before, after);
  }

  const P = (process.env.GATE_TCC_PARTS ?? 'S,G,P1,MF,FR,LR').split(',');
  const want = (tag) => P.includes(tag) || P.includes(tag.split('-')[0]) || P.includes(tag.replace(/[0-9-].*$/, ''));

  steps.txncrashcrate = async () => {
    await ensure();
    const out = { rows: {} };
    const R = out.rows;
    await G.survivalBase(ctx);
    const name = 'G6B TXN crash crate';
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await G.designs(ctx);
    const gy = await groundY();
    const W = { dir: path.join(L.SAVES, name), at: [CX + 40, gy + 2, CZ + 60] };
    await L.tp(...W.at);
    let k = 0;
    const slot = () => { const i = k++; return [CX + 24 * (i % 6), gy + 1, CZ + 40 + 40 * Math.floor(i / 6)]; };
    const single = async (tag) => {
      const origin = slot();
      const site = await playerSite(tag, origin);
      W.at = [origin[0], gy + 2, origin[2] - 6];
      await L.tp(...W.at);
      return site;
    };
    const grouped = async (tag, n = 1, owner = null) => {
      const gat = slot();
      if (n > 1) k++; // a wider slot
      W.at = [gat[0] + 3, gy + 2, gat[2] + 24];
      await L.tp(...W.at);
      return groupSites(tag, gat, n, owner);
    };

    // ---------------------------------------------------------------- the trace: a clean single removal's TX:crate.settle points
    let points = [];
    {
      const site = await single('trace');
      if (site) {
        const { cp, items } = await fill('trace', site);
        const before = await parts([site], cp, items);
        await call('dev.txn.trace', { on: true }, 10_000);
        const rm = await call('dev.site.deconstruct', { site }, 60_000).catch((e) => ({ error: String(e) }));
        await wait(3000);
        points = ((await call('dev.txn.trace', { on: false }, 10_000).catch(() => ({}))).trace ?? []).filter((p) => p.startsWith('TX:crate.settle:'));
        const after = await parts([site], cp, items);
        out.trace = { points, removal: rm };
        log(`  trace: ${points.length} crate.settle point(s): ${points.join(' ') || '(none: no crate.settle kind on this build)'}`);
        judge(R, 'trace', { tag: 'trace', sites: [site], txn: await txn() }, before, after);
      }
    }
    const removalPoints = ['K5', 'K6', 'R4'];
    const all = [...removalPoints, ...points];
    // ---------------------------------------------------------------- single
    for (const p of all) {
      for (const v of ['', '+save']) {
        const tag = `S-${p.replace(/^TX:crate\.settle:/, 'TX:')}${v ? 's' : ''}`;
        if (!want(tag)) continue;
        const site = await single(tag);
        if (site) await crashRow(R, tag, W, [site], p + v, () => call('dev.site.deconstruct', { site }, 60_000));
      }
    }
    // ---------------------------------------------------------------- group (a shared crate, one member)
    for (const p of all) {
      for (const v of ['', '+save']) {
        const tag = `G-${p.replace(/^TX:crate\.settle:/, 'TX:')}${v ? 's' : ''}`;
        if (!want(tag)) continue;
        const g = await grouped(tag);
        if (g.sites.length) await crashRow(R, tag, W, g.sites, p + v, () => api(`sgremove ${g.group}`), g.group);
      }
    }
    // ---------------------------------------------------------------- P1-1: the pickup's evidence is the owed ledger
    if (want('P1-1')) {
      const tag = 'P1-1';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site);
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const before = await parts([site], cp, items);
        const rm = await call('dev.site.deconstruct', { site }, 60_000).catch((e) => ({ error: String(e) }));
        await wait(2000);
        // a pickup: the player on the crate's cell (any drop there is picked up); the site's owed entries collected (the give's own save)
        await L.tp(cp[0] + 0.5, cp[1] + 1, cp[2] + 0.5);
        await wait(2000);
        const collected = [];
        for (const e of (await owedAll()).owed ?? []) {
          if (e.site === site) collected.push(await call('dev.owed.collect', { recipient: e.recipient, key: e.key }, 120_000).catch((x) => ({ error: String(x) })));
        }
        const mid = await parts([site], cp, items);
        log(`  ${tag}: after the pickup: ${json(mid.total)} (inventory ${json(mid.inventory)}, owed ${json(mid.owed)}, ground ${json(mid.ground)})`);
        call('dev.txn.halt', { save: true }, 10_000).catch(() => null); // the chunks saved (an autosave), the players' files not
        const down = await haltWait();
        check(down, `${tag}: halted (+save) after the pickup`);
        if (down) {
          await L.openWorld(name);
          await L.tp(...W.at);
          const r = await settleWait([site], cp, null);
          const after = await parts([site], cp, items);
          judge(R, tag, { tag, sites: [site], removal: rm, collected, mid, txn: r.txn }, before, after);
          check(G.same(after.inventory, mid.inventory) && G.same(after.owed, mid.owed),
            `${tag}: the pickup survived the crash as it was before it (inventory ${json(after.inventory)} = ${json(mid.inventory)}, owed ${json(after.owed)})`, { mid, after });
        }
      }
    }
    // ---------------------------------------------------------------- P1-2: a settle whose barrier fails after its decision is held
    if (want('P1-2')) {
      const tag = 'P1-2';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site);
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const before = await parts([site], cp, items);
        const fb = await call('dev.txn.failBarrier', { skip: 1, n: 200 }, 10_000).catch((e) => ({ error: String(e) }));
        const rm = await call('dev.site.deconstruct', { site }, 60_000).catch((e) => ({ error: String(e) }));
        await wait(1500);
        const t1 = await txn();
        const mid = await parts([site], cp, items);
        log(`  ${tag}: barrier refused after the decision (${json(fb)}): txn open ${t1.openCount}, held ${t1.heldCount}; ground ${json(mid.ground)}`);
        check(sum(mid.ground) === 0 && (t1.heldCount ?? 0) >= 1, `${tag}: the settle held, never discarded: held ${t1.heldCount}, nothing dropped (${json(mid.ground)})`, { t1, mid });
        call('dev.txn.halt', { save: true }, 10_000).catch(() => null);
        const down = await haltWait();
        check(down, `${tag}: halted (+save) while held`);
        if (down) {
          await L.openWorld(name);
          await L.tp(...W.at);
          const r = await settleWait([site], cp, null);
          judge(R, tag, { tag, sites: [site], removal: rm, mid, held: t1, txn: r.txn }, before, await parts([site], cp, items));
        }
      }
    }
    // ---------------------------------------------------------------- P1-3: a two-member group's refunds, halted between the members
    if (want('P1-3')) {
      for (const point of ['GM', 'GM+save']) {
        const tag = `P1-3${point.endsWith('+save') ? 's' : ''}`;
        const g = await grouped(tag, 2);
        if (g.sites.length === 2) await crashRow(R, tag, W, g.sites, point, () => api(`sgremove ${g.group}`), g.group, true);
      }
    }
    // ---------------------------------------------------------------- P1-4: a removal that ends before its commit never touched the crate
    if (want('P1-4')) {
      const tag = 'P1-4';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site);
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const before = await parts([site], cp, items);
        await call('dev.journal.failNextCommit', {}, 10_000);
        const rm = await call('dev.site.deconstruct', { site }, 60_000).catch((e) => ({ error: String(e).slice(0, 200) }));
        await wait(1500);
        await call('dev.stockpile.pause', { site, paused: false }, 60_000).catch(() => null); // the builder consumes what the crate holds
        for (let i = 0; i < 30; i++) {
          if (sum((await siteState(site))?.ledger?.stock) === 0) break;
          await L.sleep(500);
        }
        const mid = await parts([site], cp, items);
        call('dev.txn.halt', { save: true }, 10_000).catch(() => null);
        const down = await haltWait();
        check(down, `${tag}: halted (+save) after the builder consumed (removal: ${json(rm).slice(0, 160)})`);
        if (down) {
          await L.openWorld(name);
          await L.tp(...W.at);
          const r = await settleWait([site], cp, null);
          // the builder consumed the stock after the refused removal: the units are placed now, not in the crate
          judge(R, tag, { tag, sites: [site], removal: rm, mid, txn: r.txn }, before, await parts([site], cp, items), { standsStock: false });
          check(rm.removed === false, `${tag}: the removal ended before its commit (${json(rm).slice(0, 120)})`, rm);
        }
      }
    }
    // ---------------------------------------------------------------- the must-fix rows: a crate held by an aborted test.move out of it
    const hold = async (tag, cp, item) => {
      const chest = [cp[0], cp[1] + 4, cp[2]];
      await cmd(`/setblock ${chest.join(' ')} minecraft:chest`);
      // every txn barrier refused (dev.txn.failBarrier), not /save-off: an adoption's own ledger save must still work under the hold
      await call('dev.txn.failBarrier', { n: 1_000_000 }, 10_000);
      const r = await call('dev.txn.run', { from: cp, to: chest, items: { [item]: 1 } }, 120_000).catch((e) => ({ error: String(e) }));
      const t = await txn();
      log(`  ${tag}: the crate held: ${json(r).slice(0, 160)}; txn open ${t.openCount}, held ${t.heldCount}`);
      check(t.openCount >= 1, `${tag}: the crate at ${cp} held by an open txn (open ${t.openCount}: ${r.status ?? r.error ?? ''})`, t);
      return chest;
    };
    const unhold = async () => {
      await call('dev.txn.failBarrier', { n: 0 }, 10_000);
      for (let i = 0; i < 60 && (await txn()).openCount > 0; i++) await L.sleep(1000);
    };
    if (want('MF1')) {
      const tag = 'MF1';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site);
        await hold(tag, cp, items[0]);
        const s0 = await siteState(site);
        await call('dev.stockpile.pause', { site, paused: false }, 60_000);
        await wait(6000);
        const s1 = await siteState(site);
        R[tag] = { s0: { built: s0?.built, stock: s0?.ledger?.stock, placed: s0?.ledger?.placed }, s1: { built: s1?.built, stock: s1?.ledger?.stock, placed: s1?.ledger?.placed } };
        check(G.same(s1?.ledger?.stock, s0?.ledger?.stock) && G.same(s1?.ledger?.placed, s0?.ledger?.placed) && s1?.built === s0?.built,
          `${tag}: a held crate funds nothing (and nothing is placed for free): over 6 s unpaused, stock ${json(s1?.ledger?.stock)} = ${json(s0?.ledger?.stock)}, placed ${sum(s1?.ledger?.placed)} = ${sum(s0?.ledger?.placed)}, cells built ${s1?.built} = ${s0?.built}`, R[tag]);
        await unhold();
        await wait(4000);
        const s2 = await siteState(site);
        R[tag].s2 = { built: s2?.built, stock: s2?.ledger?.stock, placed: s2?.ledger?.placed };
        check(sum(s2?.ledger?.placed) > sum(s0?.ledger?.placed) || s2?.built > s1?.built, `${tag}: released, the site builds from it again (placed ${sum(s2?.ledger?.placed)})`, R[tag]);
        await call('dev.stockpile.pause', { site, paused: true }, 60_000).catch(() => null);
      }
    }
    if (want('MF2')) {
      const tag = 'MF2';
      const owner = 'tcc:mf2'; // a stockpile owner is <modid>:<thing>
      const g = await grouped(tag, 1, owner);
      if (g.sites.length) {
        const site = g.sites[0];
        const { cp, items } = await fill(tag, site);
        const s0 = await siteState(site);
        const c0 = (await cellOf(cp)).slots ?? {};
        await hold(tag, cp, items[0]);
        const sp = slot();
        const cr = await call('dev.stockpile.create', { owner, crates: [[sp[0], sp[1], sp[2]]] }, 120_000).catch((e) => ({ refused: String(e) }));
        const ad = await call('dev.stockpile.adopt', { owner }, 120_000).catch((e) => ({ refused: String(e) }));
        await wait(1500);
        const s1 = await siteState(site);
        const c1 = (await cellOf(cp)).slots ?? {};
        const grp = await api(`sgroup ${g.group}`).catch(() => null);
        // the crate's own ledger (dev.txn.cells): the site's state reads its owner's pile once one exists
        R[tag] = { create: cr, adopt: ad, s0: s0?.crate, s1: s1?.crate, crate0: c0, crate1: c1, group: grp };
        log(`  ${tag}: adopt with the crate held: ${json(ad).slice(0, 200)}; the site's crate ${json(s1?.crate)}`);
        check(!!s1?.crate?.present && s1.crate.x === cp[0] && s1.crate.z === cp[2] && Object.keys(c0).length > 0 && json(c1) === json(c0),
          `${tag}: an adoption that skips a held crate keeps its references: the site still builds from its crate at ${cp} (${json(s1?.crate)}), the crate's stock unchanged ${json(c1)}`, R[tag]);
        await unhold();
      }
    }
    if (want('MF4')) {
      const tag = 'MF4';
      const at = slot();
      k += 2;
      const y = gy + 1;
      const X = at[0], Z = at[2] + 20;
      await cmd(`/fill ${X - 3} ${y - 1} ${Z - 3} ${X + 30} ${y - 1} ${Z + 3} minecraft:stone`);
      W.at = [X + 10, y + 1, Z + 6];
      await L.tp(...W.at);
      const road = { points: [[X, y, Z], [X + 26, y, Z]], width: 1, mode: 'AUTO' };
      const bid = await later(`bqueue ${json({ id: `tccmf4${Date.now() % 100000}`, proximity: false, sharedCrate: true, autoApprove: true, crateAt: [X + 10, y, Z - 8],
        items: [{ key: 'h1', bp: 'rs_hut', at: [X, y, Z - 24], rot: 0, mode: 'CONSTRUCTION' }, { key: 'r1', road }] })}`, 120_000);
      let bv;
      for (let i = 0; i < 120; i++) { bv = await api(`batch ${bid}`); if (bv.items?.every((x) => x.site || x.status === 'FAILED')) break; await L.sleep(1000); }
      const it = Object.fromEntries((bv?.items ?? []).map((x) => [x.key, x]));
      const roadId = it.r1?.site, hut = it.h1?.site;
      check(!!roadId && !!hut, `${tag}: a group with a hut and a construction road from one shared crate (${hut}, ${roadId}; ${json(bv?.items?.map((x) => [x.key, x.status, x.reason]))})`, bv);
      if (roadId && hut) {
        await call('dev.stockpile.pause', { site: roadId, paused: true }, 60_000).catch(() => null);
        const { cp, items } = await fill(tag, hut);
        await call('dev.site.finish', { site: hut }, 60_000);
        await wait(1500);
        await hold(tag, cp, items[0]);
        const fin = await call('dev.site.finish', { site: roadId }, 60_000).catch((e) => ({ error: String(e) }));
        await wait(3000);
        const rv = (await api('sites')).all.find((s) => s.id === roadId);
        R[tag] = { finish: fin, held: rv?.state, crate: isCrate(await cellOf(cp)) };
        check(rv?.state === 'BUILDING' && R[tag].crate, `${tag}: the last road over a held crate stays BUILDING (${rv?.state}; the crate ${R[tag].crate ? 'stands' : 'is gone'})`, R[tag]);
        await unhold();
        let done;
        for (let i = 0; i < 30; i++) { done = (await api('sites')).all.find((s) => s.id === roadId); if (done?.state === 'BUILT') break; await L.sleep(1000); }
        R[tag].after = done?.state;
        check(done?.state === 'BUILT' && !isCrate(await cellOf(cp)), `${tag}: released, the road completes: ${done?.state}, its crate settled`, R[tag]);
      }
    }
    // ---------------------------------------------------------------- MF3: a completed site's leftovers through crate.settle
    if (want('MF3')) {
      const tag = 'MF3';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site);
        await cmd('/save-all flush').catch(() => null);
        const before = await parts([site], cp, items);
        const fin = await call('dev.site.finish', { site }, 60_000).catch((e) => ({ error: String(e) }));
        await wait(3000);
        const st = await siteState(site);
        const after = await parts([site], cp, items);
        // built: the site stands BUILT; its placed cells were finished free, so only the crate's stock moves: from the crate to the owed ledger
        const left = G.plus(before.stock, {});
        const owedNow = G.plus(after.owed, Object.fromEntries(Object.entries(before.owed).map(([k2, v]) => [k2, -v])));
        R[tag] = { finish: fin, state: st?.state, before, after, owedNew: owedNow };
        log(`  ${tag}: finished ${json(fin)}: ${st?.state}; leftovers ${json(left)}, owed new ${json(owedNow)}, ground ${json(after.ground)}, crate ${after.crate ? 'stands' : 'restored'}`);
        check(st?.state === 'built' || st?.state === 'BUILT', `${tag}: the site is built (${st?.state})`, st);
        check(sum(after.ground) === 0 && G.same(owedNow, left) && !after.crate, `${tag}: the crate's leftovers ${json(left)} owed (new ${json(owedNow)}), none dropped (${json(after.ground)}), its cell restored`, R[tag]);
      }
    }
    // ================================================================ (fix round) FR rows: each red on 2c4c59aa, green after
    const noBarriers = (n) => call('dev.txn.failBarrier', { n }, 10_000);
    const roadGroup = async (tag) => {
      // a hut and a paid construction road (stone under it: a gravel surface) from one shared crate
      const at = slot();
      k += 2;
      const y = gy + 1, X = at[0], Z = at[2] + 20;
      await cmd(`/fill ${X - 3} ${y - 1} ${Z - 3} ${X + 30} ${y - 1} ${Z + 3} minecraft:stone`);
      W.at = [X + 10, y + 1, Z + 6];
      await L.tp(...W.at);
      const road = { points: [[X, y, Z], [X + 26, y, Z]], width: 1, mode: 'AUTO' };
      const bid = await later(`bqueue ${json({ id: `tcc${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}${Date.now() % 100000}`, proximity: false, sharedCrate: true,
        autoApprove: true, crateAt: [X + 10, y, Z - 8], items: [{ key: 'h1', bp: 'rs_hut', at: [X, y, Z - 24], rot: 0, mode: 'CONSTRUCTION' }, { key: 'r1', road }] })}`, 120_000);
      let bv;
      for (let i = 0; i < 120; i++) { bv = await api(`batch ${bid}`); if (bv.items?.every((x) => x.site || x.status === 'FAILED')) break; await L.sleep(1000); }
      const it = Object.fromEntries((bv?.items ?? []).map((x) => [x.key, x]));
      check(!!it.r1?.site && !!it.h1?.site, `${tag}: a hut and a construction road from one shared crate (${it.h1?.site}, ${it.r1?.site})`, bv);
      return { hut: it.h1?.site, road: it.r1?.site, group: bv?.group };
    };
    const roadState = async (id) => (await api('sites')).all.find((x) => x.id === id) ?? null;
    /** A road's units: the crate's stock, the owed total, the ground near the crate and near the road, the inventory; whether it stands. */
    const roadParts = async (roadId, cp, items, mid) => {
      const ow = await owedAll();
      const near = await call('dev.items.near', { pos: cp, radius: 8 }, 30_000);
      const nearR = await call('dev.items.near', { pos: mid, radius: 16 }, 30_000);
      const rv = await roadState(roadId);
      return { stands: !!rv, state: rv?.state ?? null, crate: isCrate(await cellOf(cp)), stock: pick(await crateItems(cp), items), owed: pick(ow.total, items),
        ground: pick(G.plus(near.items ?? {}, nearR.items ?? {}), items), inventory: pick(near.inventory ?? {}, items) };
    };
    /** The road paid for some cells (part of its bill inserted and built, then paused) and more stock in the crate: what was paid, what is stock. */
    const payRoad = async (tag, g) => {
      await call('dev.stockpile.pause', { site: g.road, paused: true }, 60_000).catch(() => null);
      const bill = (await api(`stock ${g.group}`)).outstandingBySite?.[g.road] ?? {};
      const half = {};
      for (const [kk, v] of Object.entries(bill)) half[kk] = Math.max(1, Math.floor(v / 2));
      const a1 = (await call('dev.crate.insert', { site: g.road, items: half, exact: true }, 120_000)).accepted ?? {};
      await call('dev.stockpile.pause', { site: g.road, paused: false }, 60_000);
      const cpos = (await api(`stock ${g.group}`)).crate;
      const cp = typeof cpos === 'string' ? cpos.split(',').map(Number) : Array.isArray(cpos) ? cpos : [cpos?.x, cpos?.y, cpos?.z];
      for (let i = 0; i < 60; i++) { if (sum(await crateItems(cp)) === 0) break; await L.sleep(500); }
      await call('dev.stockpile.pause', { site: g.road, paused: true }, 60_000);
      const left = await crateItems(cp);
      const a2 = (await call('dev.crate.insert', { site: g.road, items: half, exact: true }, 120_000)).accepted ?? {};
      await wait(1500);
      const items = Object.keys(bill);
      const paid = G.plus(pick(a1, items), Object.fromEntries(Object.entries(pick(left, items)).map(([x, v]) => [x, -v])));
      check(sum(paid) > 0 && sum(await crateItems(cp)) > 0, `${tag}: ${g.road} paid for ${json(paid)} (built from the crate), the crate at ${cp} holds ${json(await crateItems(cp))}`, { a1, a2, left });
      return { cp, items, paid };
    };
    const roadMid = (g) => W.at;
    // ---------------------------------------------------------------- FR-a1 (P1-a): a completing site, both barriers refused
    if (want('FR-a1')) {
      const tag = 'FR-a1';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site);
        const before = await parts([site], cp, items);
        await noBarriers(1_000_000); // the settle's prepare barrier and its compensation's barrier: every barrier refused
        const fin = await call('dev.site.finish', { site }, 60_000).catch((e) => ({ error: String(e) }));
        await wait(3000);
        const st = await siteState(site);
        const mid = await parts([site], cp, items);
        R[tag] = { finish: fin, state: st?.state, before, mid };
        // dev.site.finish places the rest free: the blocks it put down are not the crate's units, so this row counts crate + owed + ground + inventory
        const units = (x) => [x.stock, x.owed, x.ground, x.inventory].reduce((a, b) => G.plus(a, b), {});
        before.total = units(before);
        mid.total = units(mid);
        check(st?.state === 'building' && mid.crate && G.same(mid.total, before.total) && sum(mid.ground) === 0,
          `${tag}: a completing site whose settle's barriers are refused stays BUILDING (${st?.state}), its crate kept (${mid.crate ? 'stands' : 'gone'}), nothing lost: ${json(mid.total)} = ${json(before.total)}`, R[tag]);
        await noBarriers(0);
        let s2;
        for (let i = 0; i < 30; i++) { s2 = await siteState(site); if (s2?.state === 'built') break; await L.sleep(1000); }
        const after = await parts([site], cp, items);
        after.total = units(after);
        R[tag].after = after;
        check(s2?.state === 'built' && !after.crate && G.same(after.total, before.total) && sum(after.ground) === 0,
          `${tag}: barriers working again, it completes once: ${s2?.state}, leftovers owed (${json(after.owed)}), ${json(after.total)} = ${json(before.total)}`, R[tag]);
      }
    }
    // ---------------------------------------------------------------- FR-a2 (P1-a): the last road over a crate, both barriers refused
    if (want('FR-a2')) {
      const tag = 'FR-a2';
      const g = await roadGroup(tag);
      if (g.road) {
        await call('dev.stockpile.pause', { site: g.road, paused: true }, 60_000).catch(() => null);
        const { cp, items } = await fill(tag, g.hut);
        await call('dev.site.finish', { site: g.hut }, 60_000);
        await wait(1500);
        const b0 = await roadParts(g.road, cp, items, roadMid(g));
        await noBarriers(1_000_000);
        const fin = await call('dev.site.finish', { site: g.road }, 60_000).catch((e) => ({ error: String(e) }));
        await wait(3000);
        const m0 = await roadParts(g.road, cp, items, roadMid(g));
        R[tag] = { finish: fin, before: b0, mid: m0 };
        check(m0.state === 'BUILDING' && m0.crate && G.same(m0.stock, b0.stock) && G.same(m0.owed, b0.owed) && sum(m0.ground) === 0,
          `${tag}: the last road over a crate whose settle's barriers are refused stays BUILDING (${m0.state}), the crate kept with its stock ${json(m0.stock)} (${m0.crate ? 'stands' : 'gone'}), nothing owed or dropped`, R[tag]);
        await noBarriers(0);
        let done;
        for (let i = 0; i < 30; i++) { done = await roadState(g.road); if (done?.state === 'BUILT') break; await L.sleep(1000); }
        const a0 = await roadParts(g.road, cp, items, roadMid(g));
        check(done?.state === 'BUILT' && !a0.crate && G.same(G.plus(a0.owed, a0.stock), G.plus(b0.owed, b0.stock)), `${tag}: barriers working again, the road completes and its crate's stock is owed once (${done?.state}, owed ${json(a0.owed)})`, a0);
      }
    }
    // ---------------------------------------------------------------- FR-b (P1-b): a paid road removal halted at decided; a shared crate's road
    for (const v of ['', '+save']) {
      const tag = `FR-b1${v ? 's' : ''}`;
      if (!want(tag)) continue;
      const g = await roadGroup(tag);
      if (!g.road) continue;
      await call('dev.stockpile.pause', { site: g.road, paused: true }, 60_000).catch(() => null);
      await fill(tag, g.hut);
      await call('dev.site.finish', { site: g.hut }, 60_000); // the hut built: the road is the last to build from the crate
      await wait(1500);
      const { cp, items, paid } = await payRoad(tag, g);
      await cmd('/save-all flush').catch(() => null);
      await wait(2000);
      const before = await roadParts(g.road, cp, items, roadMid(g));
      await call('dev.journal.killAt', { point: 'TX:crate.settle:decided' + v }, 10_000);
      const m = await api(`remove ${g.road} - noforce`).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
      const down = await haltWait();
      check(down, `${tag}: halted at TX:crate.settle:decided${v} in the paid road's removal (${json(m).slice(0, 120)})`);
      if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); continue; }
      await L.openWorld(name);
      await L.tp(...W.at);
      await settleWait([], cp, null, 30_000);
      for (let i = 0; i < 40 && (await roadState(g.road)); i++) await L.sleep(1000); // the removal job resumes
      await wait(2000);
      const after = await roadParts(g.road, cp, items, roadMid(g));
      const owedNew = G.plus(after.owed, Object.fromEntries(Object.entries(before.owed).map(([x, n]) => [x, -n])));
      const want2 = G.plus(before.stock, paid); // the crate's stock and the paid cells' refunds, once
      R[tag] = { before, after, paid, owedNew };
      log(`  ${tag}: after the restart: road ${after.stands ? after.state : 'gone'}, owed new ${json(owedNew)} (stock ${json(before.stock)} + paid ${json(paid)}), ground ${json(after.ground)}`);
      check(after.stands ? sum(owedNew) === 0 || G.same(owedNew, before.stock) : G.same(owedNew, want2),
        `${tag}: paid once: ${after.stands ? 'the road stands, so its refunds are not owed' : 'the road is gone'} (owed new ${json(owedNew)}; stock ${json(before.stock)}, paid cells ${json(paid)})`, R[tag]);
      check(sum(after.ground) === 0, `${tag}: nothing dropped (${json(after.ground)})`, R[tag]);
    }
    if (want('FR-b2')) {
      const tag = 'FR-b2';
      const g = await roadGroup(tag);
      if (g.road) {
        await call('dev.stockpile.pause', { site: g.hut, paused: true }, 60_000).catch(() => null); // the hut still builds: the crate is shared
        const { cp, items, paid } = await payRoad(tag, g);
        const before = await roadParts(g.road, cp, items, roadMid(g));
        const m = await later(`remove ${g.road} - noforce`, 120_000).catch((e) => ({ error: String(e) }));
        for (let i = 0; i < 30 && (await roadState(g.road)); i++) await L.sleep(1000);
        await wait(2000);
        const after = await roadParts(g.road, cp, items, roadMid(g));
        const owedNew = G.plus(after.owed, Object.fromEntries(Object.entries(before.owed).map(([x, n]) => [x, -n])));
        R[tag] = { removal: m, before, after, paid, owedNew };
        log(`  ${tag}: a shared crate's road removed: ${json(m).slice(0, 160)}; ground ${json(after.ground)}, owed new ${json(owedNew)}`);
        check(!after.stands && G.same(owedNew, paid) && sum(after.ground) === 0 && after.crate && G.same(after.stock, before.stock),
          `${tag}: a shared crate's road removed: its refunds ${json(paid)} owed (${json(owedNew)}), none dropped (${json(after.ground)}); the crate stays for the hut with its stock`, R[tag]);
      }
    }
    // ---------------------------------------------------------------- FR-c (P1-c): paid cells' refunds across K6 (commit durable, record not)
    for (const v of ['', '+save']) {
      const tag = `FR-c${v ? 's' : ''}`;
      if (!want(tag)) continue;
      const site = await single(tag);
      if (site) await crashRow(R, tag, W, [site], 'K6' + v, () => call('dev.site.deconstruct', { site }, 60_000), null, true);
    }
    // ---------------------------------------------------------------- FR-d (P2-a): an aborted collect gives nothing and says so
    if (want('FR-d')) {
      const tag = 'FR-d';
      await cmd('/clear @s');
      const key = `test:owed/fr-d-${Date.now() % 100000}`;
      const P0 = 'minecraft:oak_planks';
      const ad = await call('dev.owed.add', { key, items: { [P0]: 6 }, at: W.at }, 30_000);
      for (let i = 0; i < 5; i++) { const b = await call('dev.stockpile.barrier', { run: true }, 120_000).catch(() => null); if (b?.last?.outcome === 'OK') break; await wait(1000); }
      await noBarriers(1); // the collect's first barrier refused: it aborts (nothing given); its abort's barrier works
      const r = await call('dev.owed.collect', { recipient: ad.recipient, key }, 120_000).catch((e) => ({ error: String(e) }));
      const inv = ((await call('dev.items.near', { pos: W.at, radius: 2 }, 30_000)).inventory ?? {})[P0] ?? 0;
      const ow = ((await owedAll()).owed ?? []).find((e) => e.key === key);
      await noBarriers(1);
      const c = await cmd(`/architect collect "${key}"`).catch((e) => ({ messages: [String(e)] }));
      const said = (c.messages ?? []).join(' ');
      const inv2 = ((await call('dev.items.near', { pos: W.at, radius: 2 }, 30_000)).inventory ?? {})[P0] ?? 0;
      R[tag] = { r, inv, owed: ow?.items, said, inv2 };
      check(sum(r.given) === 0 && inv === 0 && (ow?.items?.[P0] ?? 0) === 6, `${tag}: an aborted collect reports nothing given (${json(r.given)}, ${r.status} ${r.why ?? ''}); inventory ${inv}, still owed ${ow?.items?.[P0]}`, R[tag]);
      check(!/Collected [1-9]/.test(said) && inv2 === 0, `${tag}: /architect collect, aborted, does not say it collected: "${said.slice(0, 160)}" (inventory ${inv2})`, R[tag]);
      await noBarriers(0);
      await cmd('/clear @s');
    }
    // ---------------------------------------------------------------- FR-e (P2-b): owed amounts never in the refund totals
    if (want('FR-e')) {
      const tag = 'FR-e';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site);
        const before = await parts([site], cp, items);
        const rm = await later(`remove ${site} - noforce`, 120_000).catch((e) => ({ error: String(e) }));
        await wait(2000);
        const after = await parts([site], cp, items);
        const owedNew = sum(after.owed) - sum(before.owed);
        R[tag] = { removal: rm, owedNew };
        check(rm.removed === true && owedNew > 0 && (rm.refundTotal ?? -1) === 0,
          `${tag}: a crate-fed removal with nothing credited: refund total ${rm.refundTotal} (owed ${owedNew} listed apart, never in it)`, R[tag]);
      }
    }
    // ================================================================ (last round) LR rows: each red on 47587b40, green after
    const ps = (o) => call('dev.stockpile.ps', o, 10_000);
    /** A player's site built whole from its crate (its full bill inserted, then built: every cell paid); its crate settled at completion. */
    const builtPaid = async (tag) => {
      const site = await single(tag);
      if (!site) return null;
      await boxOf(site);
      for (let i = 0; i < 60; i++) { if ((await siteState(site))?.state === 'building') break; await L.sleep(1000); }
      const st0 = await siteState(site);
      const cp = [st0.crate.x, st0.crate.y, st0.crate.z];
      await call('dev.crate.insert', { site, items: st0.bom ?? {}, exact: false }, 120_000);
      let st;
      for (let i = 0; i < 240; i++) { st = await siteState(site); if (st?.state === 'built') break; await L.sleep(1000); }
      check(st?.state === 'built', `${tag}: ${site} built from its crate, every cell paid (${st?.state}, placed ${sum(st?.ledger?.placed)})`, st);
      return { site, cp, items: Object.keys(st0.bom ?? {}) };
    };
    // ---------------------------------------------------------------- LR-1 (P1 1): the stash save refused: the removal does not commit
    if (want('LR-1')) {
      const tag = 'LR-1';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site, true); // a first part paid and placed: refunds to stash
        const before = await parts([site], cp, items);
        await ps({ failLedgerWrites: 1000 });
        const rm = await call('dev.site.deconstruct', { site }, 60_000).catch((e) => ({ error: String(e).slice(0, 200) }));
        await ps({ failLedgerWrites: 0 });
        await wait(1500);
        const after = await parts([site], cp, items);
        R[tag] = { removal: rm, before, after };
        log(`  ${tag}: the ledger's writes refused: ${json(rm).slice(0, 200)}; ${json(after.states)}`);
        check(rm.removed === false && after.states[site] && after.crate && G.same(after.total, before.total),
          `${tag}: a removal whose refund stash can't be saved confirmed does not commit: removed ${rm.removed}, the site ${json(after.states)}, crate ${after.crate ? 'stands' : 'gone'}, ${json(after.total)} = ${json(before.total)}`, R[tag]);
      }
    }
    // ---------------------------------------------------------------- LR-2 (P1 2): K6 on a completed paid site, brought back: no refund
    for (const v of ['', '+save']) {
      const tag = `LR-2${v ? 's' : ''}`;
      if (!want(tag)) continue;
      const b = await builtPaid(tag);
      if (!b) continue;
      await cmd('/save-all flush').catch(() => null);
      await wait(2000);
      const before = await parts([b.site], b.cp, b.items);
      await call('dev.journal.killAt', { point: 'K6' + v }, 10_000);
      const m = await call('dev.site.deconstruct', { site: b.site }, 60_000).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
      const down = await haltWait();
      check(down, `${tag}: halted at K6${v} in the built site's removal (${json(m).slice(0, 120)})`);
      if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); continue; }
      await L.openWorld(name);
      await L.tp(...W.at);
      await settleWait([b.site], b.cp, null, 30_000);
      await wait(3000);
      const after = await parts([b.site], b.cp, b.items);
      const owedNew = sum(after.owed) - sum(before.owed);
      R[tag] = { before, after, owedNew };
      log(`  ${tag}: after the restart: ${json(after.states)}, standing ${json(after.placed)}, owed new ${owedNew}; parts: stock ${json(after.stock)}, owed ${json(after.owed)}, ground ${json(after.ground)}, inventory ${json(after.inventory)}; entries ${json((after.owedEntries ?? []).map((e) => [e.key, e.reason, e.items?.['minecraft:oak_door'] ?? 0]))}; before ${json(before.placed)} stock ${json(before.stock)}`);
      check(G.same(after.total, before.total), `${tag}: paid exactly once: ${json(after.total)} = ${json(before.total)} (blocks standing + owed + stock)`, R[tag]);
      check(sum(after.placed) === 0 || owedNew === 0, `${tag}: no refund owed while the building stands (standing ${sum(after.placed)}, owed new ${owedNew})`, R[tag]);
    }
    // ---------------------------------------------------------------- LR-3 (P1 3): a paid road killed after its restore, before its settle's intent, its queue write failing
    for (const v of ['', '+save']) {
      const tag = `LR-3${v ? 's' : ''}`;
      if (!want(tag)) continue;
      const g = await roadGroup(tag);
      if (!g.road) continue;
      await call('dev.stockpile.pause', { site: g.road, paused: true }, 60_000).catch(() => null);
      await fill(tag, g.hut);
      await call('dev.site.finish', { site: g.hut }, 60_000);
      await wait(1500);
      const { cp, items, paid } = await payRoad(tag, g);
      await cmd('/save-all flush').catch(() => null);
      await wait(2000);
      const before = await roadParts(g.road, cp, items, roadMid(g));
      // (slice T4a) since the PSVLC3 merge a removal job waits, untouched, for a confirmed queue write before it plans (PSV's preflight): a
      // failing queue file no longer loses the job, it holds the removal back. The row keeps its point with the queue writing.
      await call('dev.journal.killAt', { point: 'R4' + v }, 10_000);
      const m = await api(`remove ${g.road} - noforce`).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
      const down = await haltWait();
      check(down, `${tag}: halted at R4${v} (the road's restore written, its settle not begun) (${json(m).slice(0, 120)})`);
      if (!down) { await ps({ failQueueWrites: false }); await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); continue; }
      await L.openWorld(name);
      await L.tp(...W.at);
      await settleWait([], cp, null, 30_000);
      for (let i = 0; i < 30 && (await roadState(g.road)); i++) await L.sleep(1000);
      await wait(3000);
      const after = await roadParts(g.road, cp, items, roadMid(g));
      const owedNew = G.plus(after.owed, Object.fromEntries(Object.entries(before.owed).map(([x, n]) => [x, -n])));
      R[tag] = { before, after, paid, owedNew };
      log(`  ${tag}: after the restart: road ${after.stands ? after.state : 'gone'}, crate ${after.crate ? 'stands ' + json(after.stock) : 'settled'}, owed new ${json(owedNew)}, ground ${json(after.ground)}`);
      check(after.stands ? sum(owedNew) === 0 && after.crate && G.same(after.stock, before.stock) : G.same(owedNew, G.plus(before.stock, paid)),
        `${tag}: paid once: ${after.stands ? 'the road stands again, nothing owed, the crate keeps its stock' : 'the road is gone: its stock and its paid cells owed'} (owed new ${json(owedNew)}; stock ${json(before.stock)}, paid ${json(paid)})`, R[tag]);
      check(sum(after.ground) === 0, `${tag}: nothing dropped (${json(after.ground)})`, R[tag]);
    }
    // ---------------------------------------------------------------- LR-4 (group report P2): a crate-fed group without a pile reports its owed keys
    if (want('LR-4')) {
      const tag = 'LR-4';
      const g = await grouped(tag);
      if (g.sites.length) {
        const { cp, items } = await fill(tag, g.sites[0], true);
        const before = await parts(g.sites, cp, items);
        const rm = await later(`sgremove ${g.group}`, 600_000).catch((e) => ({ error: String(e) }));
        await wait(2000);
        const after = await parts(g.sites, cp, items);
        R[tag] = { removal: rm, before, after };
        log(`  ${tag}: the group removed: refund ${json(rm.refund)}, owed ${json(rm.owed)}; owed now ${json(after.owed)}`);
        check(rm.removed === true && Array.isArray(rm.owed) && rm.owed.length > 0 && (rm.refundTotal ?? 0) === 0 && sum(after.owed) > sum(before.owed),
          `${tag}: a crate-fed group's removal reports its owed keys (${json(rm.owed)}), refund total ${rm.refundTotal} (owed listed apart)`, R[tag]);
      }
    }
    // ================================================================ (slice T4a) T4 rows: removal refunds against blocks still standing.
    // Recorded red at T4a (T2's removal runtime + PSVLC3 + the hooks commit); T4b makes them green. Each judges conservation from the blocks
    // standing in the world (never a record) and "no refund paid while its paid blocks stand".
    const fs = await import('node:fs');
    /** A player's site built to about {@code frac} of its bill from its crate, then paused with more stock in the crate. */
    const partBuilt = async (tag, site, frac) => {
      for (let i = 0; i < 120; i++) { if ((await siteState(site))?.state === 'building') break; await L.sleep(1000); }
      await boxOf(site);
      await call('dev.stockpile.pause', { site, paused: true }, 60_000);
      const st0 = await siteState(site);
      const bom = st0?.bom ?? {};
      const part = {};
      for (const [kk, v] of Object.entries(bom)) { const n = Math.floor(v * frac); if (n > 0) part[kk] = n; }
      await call('dev.crate.insert', { site, items: part, exact: true }, 120_000);
      await call('dev.stockpile.pause', { site, paused: false }, 60_000);
      for (let i = 0; i < 90; i++) { if (sum((await siteState(site))?.ledger?.stock) === 0) break; await L.sleep(500); }
      await call('dev.stockpile.pause', { site, paused: true }, 60_000);
      const extra = {};
      for (const [kk, v] of Object.entries(bom).slice(0, 2)) extra[kk] = Math.max(1, Math.floor(v / 4));
      await call('dev.crate.insert', { site, items: extra, exact: true }, 120_000);
      await wait(1500);
      const st1 = await siteState(site);
      const cp = [st1.crate.x, st1.crate.y, st1.crate.z];
      const items = Object.keys(bom);
      check(sum(st1.ledger?.placed) > 0, `${tag}: ${site} built to about ${Math.round(frac * 100)}% (${sum(st1.ledger?.placed)} placed of ${sum(bom)}), its crate holding ${sum(st1.ledger?.stock)}`, st1);
      return { cp, items };
    };
    /** Judges a T4 row: conservation over the standing blocks, and no refund owed while any paid block of a removed site stands. */
    const judgeT4 = (tag, n, before, after) => {
      const owedNew = sum(after.owed) - sum(before.owed);
      n.before = before; n.after = after; n.owedNew = owedNew;
      R[tag] = n;
      log(`  ${tag}: before ${json(before.total)}; after ${json(after.total)} (placed ${json(after.placed)}, owed new ${owedNew}, stock ${json(after.stock)}, ground ${json(after.ground)}; ${json(after.states)})`);
      check(G.same(after.total, before.total), `${tag}: paid exactly once: ${json(after.total)} = ${json(before.total)} (blocks standing + crate + owed + ground + inventory)`, n);
      check(sum(after.placed) === 0 || owedNew <= sum(before.stock), `${tag}: no refund owed while ${sum(after.placed)} paid block(s) stand (owed new ${owedNew}, the crate's stock ${sum(before.stock)})`, n);
      check(sum(after.ground) === 0, `${tag}: nothing dropped (${json(after.ground)})`, n);
    };
    /** K6 on {@code sites} (removing {@code target}), then optional dev-start.json, the world again (twice when the start itself halts). */
    const k6Row = async (tag, sites, target, cp, items, { point = 'K6', start = null, after = null, expectHeld = false, reopenAfter = null } = {}) => {
      await cmd('/save-all flush').catch(() => null);
      await wait(2000);
      const before = await parts(sites, cp, items);
      await call('dev.journal.killAt', { point }, 10_000);
      const m = await call('dev.site.deconstruct', { site: target }, 60_000).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
      const down = await haltWait();
      check(down, `${tag}: halted at ${point} (${json(m).slice(0, 120)})`);
      if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); return; }
      const arch = path.join(W.dir, 'architect');
      if (start) { fs.mkdirSync(arch, { recursive: true }); fs.writeFileSync(path.join(arch, 'dev-start.json'), JSON.stringify(start)); }
      if (after) after();
      let halts = 0;
      if (start?.killAt?.startsWith('TX:')) {
        // (T4b fix round) a txn point on the first ticks after the start: the world opens, then it halts there; then the world again.
        // (slice T4R-D fix round, SPD) openWorld fails as soon as the host has no server process (it used to poll 15 minutes past the halt)
        await L.openWorld(name).catch(() => null);
        const again = await haltWait() && await serverGone();
        halts += again ? 1 : 0;
        check(again, `${tag}: the start's removal txn halted at ${start.killAt}`);
        await L.sleep(3000);
        await L.openWorld(name);
      } else if (start?.killAt) {
        // the start itself halts (SERVER_STARTED, before the world is ready): the open never completes. (slice T4R-D fix round, SPD) openWorld
        // fails as soon as the headless host has no server process; 200 s is only its bound now (a timeout is a FAIL, never a halt)
        const op = L.openWorld(name).then(() => 'open', (e) => `error: ${String(e?.message ?? e).slice(0, 120)}`);
        const r0 = await Promise.race([op, L.sleep(200_000).then(() => 'timeout')]);
        const again = r0.startsWith('error') && await serverGone();
        halts += again ? 1 : 0;
        check(again, `${tag}: the start halted at ${start.killAt} (the open answered ${r0})`);
        await L.sleep(3000);
        await L.openWorld(name);
      } else {
        await L.openWorld(name);
      }
      await L.tp(...W.at);
      await settleWait(sites, cp, null, 30_000);
      await wait(4000);
      const after1 = await parts(sites, cp, items);
      const t1 = await txn();
      if (expectHeld) {
        // (T4b fix round) the fault fired: nothing paid, its paid blocks still standing; its txn held (a W that failed) or, a txn crashed
        // before its decision (aborted by recovery), the next not begun while the evidence is unknown
        const owedNew = sum(after1.owed) - sum(before.owed);
        const open = expectHeld === 'open' ? t1.openCount > 0 : true;
        const standing = reopenAfter ? true : sum(after1.placed) > 0; // (a held txn after its restore reached the disk: its refunds in transit)
        check(open && owedNew === 0 && standing, `${tag}: the W can't act and holds: txn open ${t1.openCount}, owed new ${owedNew}, ${sum(after1.placed)} paid block(s) standing`, { t1, after1 });
      }
      if (!reopenAfter) judgeT4(tag, { tag, point, start, removal: m, txn: t1, halts }, before, after1); // else judged once it completes
      if (reopenAfter) {
        // the fault cleared (the file put back): the removal completes, paid exactly once
        await L.leaveWorld();
        reopenAfter();
        await L.openWorld(name);
        await L.tp(...W.at);
        await settleWait(sites, cp, null, 30_000);
        await wait(4000);
        judgeT4(`${tag}-after`, { tag: `${tag}-after`, txn: await txn() }, before, await parts(sites, cp, items));
      }
    };
    // T4-keep (finding 1a): about 40% built: K6 reads neither restored nor standing (KEEP), and the KEEP path settles its stash
    for (const v of ['', '+save']) {
      const tag = `T4-keep${v ? 's' : ''}`;
      if (!want(tag)) continue;
      const site = await single(tag);
      if (!site) continue;
      const { cp, items } = await partBuilt(tag, site, 0.4);
      await k6Row(tag, [site], site, cp, items, { point: 'K6' + v });
    }
    // T4-shared (finding 1b): a member of a shared crate (the other still building), about 15% built, removed alone, K6
    if (want('T4-shared')) {
      const tag = 'T4-shared';
      const g = await grouped(tag, 2);
      if (g.sites.length === 2) {
        const [a, b] = g.sites;
        await boxOf(b);
        const { cp, items } = await partBuilt(tag, a, 0.15);
        await k6Row(tag, [a], a, cp, items);
      }
    }
    // T4-2nd (finding 2a): mostly unbuilt (RELEASE: the start writes the committed restore), the start halted at KS1 (its release on disk,
    // the restore's chunks not), then the world again
    if (want('T4-2nd')) {
      const tag = 'T4-2nd';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await partBuilt(tag, site, 0.1);
        await k6Row(tag, [site], site, cp, items, { start: { killAt: 'KS1' } });
      }
    }
    // T4-wnf (finding 2b): as T4-2nd, the start's write-now failing: the record stays pending, unsettled (and the queued settle must not pay)
    if (want('T4-wnf')) {
      const tag = 'T4-wnf';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await partBuilt(tag, site, 0.1);
        await k6Row(tag, [site], site, cp, items, { start: { failWriteNow: true }, expectHeld: 'open' });
      }
    }
    // T4-2nd-b (fix round): a second crash between the new W and the credit's publication: at the start, the removal txn halted after its W
    // applied (in memory), then the world again: paid exactly once
    if (want('T4-2nd-b')) {
      const tag = 'T4-2nd-b';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await partBuilt(tag, site, 0.4);
        await k6Row(tag, [site], site, cp, items, { start: { killAt: 'TX:removal.site:apply:1' } }); // (T4R-D) the owner txn: effect 0 is its D (group.undo), 1 its first W
      }
    }
    // T4-nojournal (fix round, finding 2): a removal txn decided (its W not yet on disk: halted at its decision), then the world opened with
    // its journal unreadable: the W probe must hold (unknown), never read "released": nothing paid; with the journal back it completes once
    if (want('T4-nojournal')) {
      const tag = 'T4-nojournal';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await partBuilt(tag, site, 0.4);
        const jf = path.join(W.dir, 'architect-journal', 'journal.json');
        await k6Row(tag, [site], site, cp, items, { point: 'TX:removal.site:decided', expectHeld: 'open',
          after: () => { fs.copyFileSync(jf, jf + '.t4keep'); fs.writeFileSync(jf, '{ not json'); },
          reopenAfter: () => { fs.copyFileSync(jf + '.t4keep', jf); } });
      }
    }
    // T4-mine (fix round, finding 3): a crate-fed road's removal paused before its first write; a player breaks one of its paid blocks: the
    // box is held from the tally on (refused), so the refund stays true; else (the base) the block drops and its refund is paid too
    if (want('T4-mine')) {
      const tag = 'T4-mine';
      const g = await roadGroup(tag);
      if (g.road) {
        await call('dev.stockpile.pause', { site: g.road, paused: true }, 60_000).catch(() => null);
        await fill(tag, g.hut);
        await call('dev.site.finish', { site: g.hut }, 60_000);
        await wait(1500);
        const { cp, items, paid } = await payRoad(tag, g);
        const rv = await roadState(g.road);
        const m = rv && /minX=(-?\d+), minY=(-?\d+), minZ=(-?\d+), maxX=(-?\d+), maxY=(-?\d+), maxZ=(-?\d+)/.exec(rv.box);
        const rbox = m ? m.slice(1, 7).map(Number) : null;
        const standingRoad = async () => {
          const out = {}, at = [];
          for (const [k2, st] of (await cellsOf(rbox)).entries()) {
            const id = String(st).replace(/\[.*$/, '');
            const full = id.includes(':') ? id : `minecraft:${id}`;
            if (items.includes(full)) { out[full] = (out[full] ?? 0) + 1; at.push(k2); }
          }
          return { out, at };
        };
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const b0 = await roadParts(g.road, cp, items, W.at);
        const s0 = await standingRoad();
        const before = { ...b0, placed: s0.out, total: [b0.stock, s0.out, b0.owed, b0.ground, b0.inventory].reduce((a, c) => G.plus(a, c), {}) };
        await call('dev.removal.pause', { site: g.road, after: 0 }, 10_000);
        const rm = api(`remove ${g.road} - noforce`).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
        await wait(3000);
        const cell = s0.at[0];
        const at = typeof cell === 'string' ? cell.split(',').map(Number) : null;
        const br = at ? await call('dev.pt.breaks', { at: [at], placer: 'T4Miner' }, 60_000).catch((e) => ({ error: String(e) })) : { error: 'no paid cell' };
        await wait(1500);
        const drop = at ? (await call('dev.items.near', { pos: at, radius: 3 }, 30_000)).items ?? {} : {};
        await call('dev.removal.pause', { site: g.road, off: true }, 10_000);
        await rm;
        for (let i = 0; i < 60 && (await roadState(g.road)); i++) await L.sleep(1000);
        await wait(4000);
        const a0 = await roadParts(g.road, cp, items, W.at);
        const sa = await standingRoad();
        const nearCell = at ? pick((await call('dev.items.near', { pos: at, radius: 3 }, 30_000)).items ?? {}, items) : {};
        const after = { ...a0, placed: sa.out, ground: G.plus(a0.ground, nearCell), states: { [g.road]: a0.state }, total: [a0.stock, sa.out, a0.owed, a0.ground, nearCell, a0.inventory].reduce((x, c) => G.plus(x, c), {}) };
        log(`  ${tag}: a player broke ${at} while the removal waited: ${json(br)} (dropped ${json(drop)})`);
        check((br.broken ?? 0) === 0, `${tag}: the break in the held removal box is refused (${json(br)})`, br);
        judgeT4(tag, { tag, paid, break: br, txn: await txn() }, before, after);
      }
    }
    // (slice T4R-M) row T4-legacy retired: it judged the pre-T4R conversion, which is gone (a pre-T4R removal runs main's path: T4RM-legacy-*)
    // A stockpile's construction road, about half paid and built, every target paused (T4-pileroad, T4-lastcrate)
    const pileRoad = async (tag, owner) => {
      const at = slot();
      k += 2;
      const y = gy + 1, X = at[0], Z = at[2] + 20;
      await cmd(`/fill ${X - 3} ${y - 1} ${Z - 3} ${X + 30} ${y - 1} ${Z + 3} minecraft:stone`);
      W.at = [X + 10, y + 1, Z + 6];
      await L.tp(...W.at);
      const crate = [X + 10, y, Z - 8];
      await call('dev.stockpile.create', { owner, crates: [crate] }, 120_000).catch((e) => ({ refused: String(e) }));
      const road = { points: [[X, y, Z], [X + 26, y, Z]], width: 1, mode: 'AUTO' };
      const bid = await later(`bqueue ${json({ id: `tcct4pr${Date.now() % 100000}`, proximity: false, owner, autoApprove: true, items: [{ key: 'r1', road }] })}`, 120_000);
      let bv;
      for (let i = 0; i < 120; i++) { bv = await api(`batch ${bid}`); if (bv.items?.every((x) => x.site || x.status === 'FAILED')) break; await L.sleep(1000); }
      const rid = bv?.items?.[0]?.site;
      check(!!rid, `${tag}: a construction road fed from the stockpile of ${owner} (${rid})`, bv);
      if (!rid) return null;
      const pst = async () => (await call('dev.stockpile.state', { owner }, 60_000).catch(() => ({}))).stockpile ?? {};
      for (let i = 0; i < 60; i++) { const rv0 = await roadState(rid).catch(() => null); if (rv0 && !/plac/i.test(String(rv0.state))) break; await L.sleep(1000); }
      await call('dev.stockpile.pause', { site: rid, paused: true }, 60_000).catch(() => null);
      const bill = (await api(`stock ${bv.group}`).catch(() => ({}))).outstandingBySite?.[rid] ?? {};
      const half = {};
      for (const [kk, v] of Object.entries(bill)) half[kk] = Math.max(1, Math.floor(v / 2));
      await call('dev.crate.insert', { site: `stockpile:${owner}`, items: half, exact: true }, 120_000).catch(() => null);
      await call('dev.stockpile.pause', { site: rid, paused: false }, 60_000).catch(() => null);
      for (let i = 0; i < 60; i++) { if (sum((await pst()).stock) === 0) break; await L.sleep(500); }
      await call('dev.stockpile.pause', { site: rid, paused: true }, 60_000).catch(() => null);
      const items = Object.keys(bill);
      const rv = await roadState(rid);
      const mm = rv && /minX=(-?\d+), minY=(-?\d+), minZ=(-?\d+), maxX=(-?\d+), maxY=(-?\d+), maxZ=(-?\d+)/.exec(rv.box);
      const rbox = mm ? mm.slice(1, 7).map(Number) : [X - 1, y - 1, Z - 2, X + 27, y + 1, Z + 2];
      const rparts = async () => {
        const placed = {};
        for (const st of (await cellsOf(rbox)).values()) {
          const id = String(st).replace(/\[.*$/, '');
          const full = id.includes(':') ? id : `minecraft:${id}`;
          if (items.includes(full)) placed[full] = (placed[full] ?? 0) + 1;
        }
        const near = await call('dev.items.near', { pos: W.at, radius: 24 }, 30_000);
        const mine = {};
        for (const e of (await owedAll()).owed ?? []) if (e.site === rid) for (const [k2, v] of Object.entries(e.items ?? {})) mine[k2] = (mine[k2] ?? 0) + v;
        const p = { stock: pick((await pst()).stock ?? {}, items), placed, owed: pick(mine, items), ground: pick(near.items ?? {}, items), inventory: {},
          states: { [rid]: (await roadState(rid))?.state ?? null } };
        p.total = [p.stock, p.placed, p.owed, p.ground].reduce((a, b) => G.plus(a, b), {});
        return p;
      };
      await cmd('/save-all flush').catch(() => null);
      await wait(2000);
      const before = await rparts();
      check(sum(before.placed) > 0, `${tag}: ${rid} paid for ${sum(before.placed)} cell(s) from the stockpile`, before);
      return { rid, rparts, before, crate, pst, owner, rbox };
    };
    // (T4 final round) the road removed for good: no record, no paid block standing, its refund credited into the stockpile (stock = before's
    // stock + the paid blocks that stood), nothing owed or dropped
    const roadFinished = async (tag, pr, after) => {
      check(!(await roadState(pr.rid).catch(() => null)), `${tag}: ${pr.rid} removed (no record left; the review's green run ended BUILDING)`, after.states);
      check(sum(after.placed) === 0, `${tag}: no paid block of ${pr.rid} stands (${json(after.placed)})`, after);
      check(G.same(after.stock, G.plus(pr.before.stock, pr.before.placed)), `${tag}: its refund credited into the stockpile: ${json(after.stock)} = ${json(G.plus(pr.before.stock, pr.before.placed))}`, after);
    };
    /** (T4 final round) The removal's job queued (the row's precondition: the review's T4-pileroad never removed its road, refused as not its owner's). */
    const removalQueued = async (tag, rid, rm) => {
      let j = null;
      for (let i = 0; i < 10 && !j; i++) { j = ((await call('dev.placement.jobs', {}, 30_000).catch(() => ({ jobs: [] }))).jobs ?? []).find((x) => x.site === rid) ?? null; if (!j) await L.sleep(500); }
      check(!!j, `${tag}: the removal of ${rid} queued (${json(j)}; ${json(rm).slice(0, 160)})`, { j, rm });
      return j;
    };
    const roadGone = async (rid, s = 120) => { for (let i = 0; i < s && (await roadState(rid).catch(() => null)); i++) await L.sleep(1000); };
    // T4-pileroad (fix round, finding 5): a stockpile's road removed with its credit save refused, then the game halted unsaved: its refund
    // intent is the removal.road stash (durable before the job), paid exactly once after the restart (the base: the refund lost). (T4 final
    // round) judged only once the road is removed for good: REMOVED, no paid block standing, the refund credited
    if (want('T4-pileroad')) {
      const tag = 'T4-pileroad';
      const pr = await pileRoad(tag, 'tcc:t4road');
      if (pr) {
        const { rid, rparts, before } = pr;
        // the job queued and paused before its first write (its stash saved), then every ledger write failing (its chunks flush, its ledger
        // does not: the review's case), then the job runs and the game halts unsaved
        await call('dev.removal.pause', { site: rid, after: 0 }, 10_000);
        const rm = await api(`remove ${rid} ${pr.owner} noforce`).catch((e) => ({ error: String(e?.message ?? e).slice(0, 160) }));
        await removalQueued(tag, rid, rm);
        await wait(2000);
        await ps({ failLedgerOnly: 1000 }); // the ledger's writes only (the queue file and txn.json still write)
        await call('dev.removal.pause', { site: rid, off: true }, 10_000);
        await wait(5000);
        call('dev.txn.halt', { save: false }, 10_000).catch(() => null);
        const down = await haltWait();
        check(down, `${tag}: halted unsaved after the removal (${json(rm).slice(0, 160)})`);
        if (down) {
          await L.openWorld(name);
          await L.tp(...W.at);
          await roadGone(rid);
          for (let i = 0; i < 30 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
          await wait(5000);
          const after = await rparts();
          judgeT4(tag, { tag, removal: rm, txn: await txn() }, { ...before }, after);
          await roadFinished(tag, pr, after);
        }
      }
    }
    // T4-lastcrate (T4 final round, P1 1): a stockpile road's removal paused after its commit (its refund stash durable, the road pending, so
    // nothing of the pile builds); removing the pile's last crate must be refused while the stash credits into it (the base: the pile ends
    // and its refund has no pile to go to); then the removal finishes, the refund credited into the same pile
    if (want('T4-lastcrate')) {
      const tag = 'T4-lastcrate';
      const owner = 'tcc:t4last';
      const pr = await pileRoad(tag, owner);
      if (pr) {
        const { rid, rparts, before, crate, pst } = pr;
        await call('dev.removal.pause', { site: rid, after: 0 }, 10_000);
        const rm = await api(`remove ${rid} ${pr.owner} noforce`).catch((e) => ({ error: String(e?.message ?? e).slice(0, 160) }));
        await removalQueued(tag, rid, rm);
        await wait(3000);
        const rc = await call('dev.stockpile.removecrate', { owner, pos: crate, force: true }, 60_000).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
        const ps1 = await pst();
        R[tag] = { removal: rm, removeCrate: rc, pile: ps1 };
        check(!rc.removed && (ps1.crates ?? []).length === 1, `${tag}: the last crate's removal refused while the removal's stash credits into the pile (${json(rc).slice(0, 200)})`, rc);
        await call('dev.removal.pause', { site: rid, off: true }, 10_000);
        await roadGone(rid);
        for (let i = 0; i < 30 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
        await wait(3000);
        const after = await rparts();
        judgeT4(tag, { tag, removal: rm, removeCrate: rc, txn: await txn() }, { ...before }, after);
        await roadFinished(tag, pr, after);
      }
    }
    // (slice T4R-M) row T4-legacyroad retired: it judged the pre-T4R conversion, which is gone (a pre-T4R removal runs main's path: T4RM-legacy-*)
    // ================================================================ (slice T4R) T4R rows: the T4 batch's surviving P1s (T4-combined-final-a0ab7efc).
    // Recorded red on a0ab7efc + the T4R hooks commit; green on slice/T4R. Each logs "ROW <id>" and judges conservation where it moves items.
    const evs = async () => ((await api('events').catch(() => [])) ?? []).filter((e) => e.event === 'REMOVAL_FINISHED');
    const rowLog = (id, what) => log(`  ROW ${id}: ${what}`);
    // T4R-group-crash (P1-1): a group of two from one shared crate; the member written first (h2, placed last) mostly unbuilt; its restore in RAM,
    // its settle's barrier refused, the advanced queue saved, then a bare crash before any chunk save (GQ). The base pays its refund while
    // its paid blocks stand (the start's threshold reads it restored and releases it); green: no credit before its W receipts, exact
    if (want('T4R-group-crash')) {
      const tag = 'T4R-group-crash';
      const g = await grouped(tag, 2);
      if (g.sites.length === 2) {
        const [a, b] = g.sites;
        await boxOf(a);
        await call('dev.stockpile.pause', { site: a, paused: true }, 60_000).catch(() => null);
        const { cp, items } = await partBuilt(tag, b, 0.15);
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const before = await parts([a, b], cp, items);
        await call('dev.txn.failBarrier', { n: 1_000_000 }, 10_000);
        await call('dev.journal.killAt', { point: 'GQ' }, 10_000);
        const m = await api(`sgremove ${g.group}`).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
        const down = await haltWait();
        check(down, `${tag}: halted at GQ (${b}'s restore in memory, its settle held, the advanced queue saved) (${json(m).slice(0, 120)})`);
        rowLog(tag, `halted ${down}`);
        if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await call('dev.txn.failBarrier', { n: 0 }, 10_000); }
        else {
          await L.openWorld(name);
          await L.tp(...W.at);
          await settleWait([a, b], cp, g.group, 60_000);
          for (let i = 0; i < 60 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
          await wait(4000);
          judgeT4(tag, { tag, removal: m, txn: await txn() }, before, await parts([a, b], cp, items));
        }
      }
    }
    // T4R-stage-convert (R1: group/stage credits convert like single removals): a stockpile-fed stage member about 40% built; its stage's undo
    // paused after its refunds were tallied (dev.removal.pause group:<id>), a player breaks one of its paid blocks, the undo goes on: its credit
    // pays min(planned, found) (the base: planned, the broken block's item kept besides)
    if (want('T4R-stage-convert')) {
      const tag = 'T4R-stage-convert';
      const owner = 'tcc:t4rstage';
      const sp = slot();
      await call('dev.stockpile.create', { owner, crates: [[sp[0], sp[1], sp[2]]] }, 120_000).catch((e) => ({ refused: String(e) }));
      const gat = slot();
      W.at = [gat[0] + 3, gy + 2, gat[2] + 24];
      await L.tp(...W.at);
      const bid = await later(`bqueue ${json({ id: `tcct4rst${Date.now() % 100000}`, proximity: false, owner, autoApprove: true,
        items: [{ key: 'h1', bp: 'rs_hut', at: [gat[0], gat[1], gat[2]], rot: 0, mode: 'CONSTRUCTION', stage: 's1' }], stages: [{ name: 's1', items: ['h1'] }] })}`, 120_000);
      let bv;
      for (let i = 0; i < 120; i++) { bv = await api(`batch ${bid}`); if (bv.items?.every((x) => x.site || x.status === 'FAILED')) break; await L.sleep(1000); }
      const site = bv?.items?.[0]?.site;
      check(!!site, `${tag}: a stockpile-fed construction rs_hut in stage s1 (${site}, group ${bv?.group})`, bv);
      if (site) {
        for (let i = 0; i < 60; i++) { if ((await siteState(site))?.state === 'building') break; await L.sleep(1000); }
        const box = await boxOf(site);
        await call('dev.stockpile.pause', { site, paused: true }, 60_000);
        const bom = (await siteState(site))?.bom ?? {};
        const part = {};
        for (const [kk, v] of Object.entries(bom)) { const n = Math.floor(v * 0.4); if (n > 0) part[kk] = n; }
        await call('dev.crate.insert', { site: `stockpile:${owner}`, items: part, exact: true }, 120_000).catch(() => null);
        await call('dev.stockpile.pause', { site, paused: false }, 60_000);
        const pst = async () => (await call('dev.stockpile.state', { owner }, 60_000).catch(() => ({}))).stockpile ?? {};
        for (let i = 0; i < 90; i++) { if (sum((await pst()).stock) === 0) break; await L.sleep(500); }
        await call('dev.stockpile.pause', { site, paused: true }, 60_000);
        const items = Object.keys(bom);
        const mid = [Math.floor((box[0] + box[3]) / 2), box[1], Math.floor((box[2] + box[5]) / 2)];
        const sparts = async () => {
          const near = await call('dev.items.near', { pos: mid, radius: 32 }, 30_000);
          const p = { stock: pick((await pst()).stock ?? {}, items), placed: pick(await standing(site, items), items), owed: {}, ground: pick(near.items ?? {}, items),
            inventory: pick(near.inventory ?? {}, items), states: { [site]: (await siteState(site))?.state ?? null } };
          p.total = [p.stock, p.placed, p.ground, p.inventory].reduce((x, y) => G.plus(x, y), {});
          return p;
        };
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const before = await sparts();
        check(sum(before.placed) > 0, `${tag}: ${site} about 40% built from the stockpile (${sum(before.placed)} placed)`, before);
        await call('dev.removal.pause', { site: `group:${bv.group}` }, 10_000);
        const pend = await api(`sundo ${bv.group} s1`).catch((e) => ({ error: String(e) }));
        await wait(4000);
        let at = null, brokenItem = null;
        for (const [k2, st] of (await cellsOf(box)).entries()) {
          const id = String(st).replace(/\[.*$/, '');
          const full = id.includes(':') ? id : `minecraft:${id}`;
          if (items.includes(full)) { at = typeof k2 === 'string' ? k2.split(',').map(Number) : null; brokenItem = full; break; }
        }
        const br = at ? await call('dev.pt.breaks', { at: [at], placer: 'T4RMiner' }, 60_000).catch((e) => ({ error: String(e) })) : { error: 'no paid cell' };
        await wait(1000);
        const drop = at ? (await call('dev.items.near', { pos: at, radius: 3 }, 30_000)).items ?? {} : {};
        rowLog(tag, `a player broke ${at} while the stage's undo waited after its tally: ${json(br)}; dropped near it ${json(drop)}`);
        await call('dev.removal.pause', { site: `group:${bv.group}`, off: true }, 10_000);
        let res = null;
        for (let i = 0; i < 240 && pend?.pending; i++) { const r = await api(`get ${pend.pending}`); if (r && r.value) { res = r.value; break; } await L.sleep(500); }
        await wait(4000);
        const after = await sparts();
        if ((br.broken ?? 0) > 0 && sum(drop) === 0 && brokenItem) {
          // the breaking player (dev.pt.breaks' fake player) keeps the block's item: counted as its inventory
          after.inventory = G.plus(after.inventory, { [brokenItem]: 1 });
          after.total = G.plus(after.total, { [brokenItem]: 1 });
        }
        R[tag] = { removal: res, break: br, before, after };
        rowLog(tag, `undo ${json(res).slice(0, 200)}; before ${json(before.total)} after ${json(after.total)}`);
        judgeT4(tag, { tag, removal: res, break: br, txn: await txn() }, before, after);
      }
    }
    // (slice T4R-M) rows T4R-legacyroad-fail and -window retired: it judged the pre-T4R conversion, which is gone (a pre-T4R removal runs main's path: T4RM-legacy-*)
    // T4R-visible + T4R-wnf-complete (P1-3, P1-4): T4-wnf extended: K6 on a mostly unbuilt site, the start's W write failing (held, decided):
    // Sites.get through the API returns it, status removing with held(decided) (T4-wnf's s7:null becomes non-null); the fault cleared, it
    // completes: absent, REMOVAL_FINISHED received with its full result (restore count > 0), exact
    if (want('T4R-visible')) {
      const tag = 'T4R-visible';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await partBuilt(tag, site, 0.1);
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const before = await parts([site], cp, items);
        await call('dev.journal.killAt', { point: 'K6' }, 10_000);
        const m = await call('dev.site.deconstruct', { site }, 60_000).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
        const down = await haltWait();
        check(down, `${tag}: halted at K6 (${json(m).slice(0, 120)})`);
        if (down) {
          const arch = path.join(W.dir, 'architect');
          fs.mkdirSync(arch, { recursive: true });
          fs.writeFileSync(path.join(arch, 'dev-start.json'), JSON.stringify({ failWriteNow: true }));
          await L.openWorld(name);
          await L.tp(...W.at);
          await wait(8000);
          const v1 = await api(`site ${site}`).catch((e) => ({ error: String(e) }));
          rowLog(tag, `held: lookup ${json(v1).slice(0, 300)}`);
          const listed = ((await api('sites').catch(() => ({ all: [] }))).all ?? []).some((x) => x.id === site);
          rowLog(tag, `held: listed ${listed}`);
          check(listed, `${tag}: (fix round, R3's P2) the held, decided site stays listed too (Sites.list)`);
          check(v1 && v1.id === site && v1.statusState === 'removing' && /held\(decided\)/.test(String(v1.statusReason)),
            `${tag}: a held, decided removal's site is returned by lookup with status removing and held(decided) (${json(v1 && { state: v1.statusState, reason: v1.statusReason })})`, v1);
          await L.leaveWorld();
          await L.openWorld(name);
          await L.tp(...W.at);
          await settleWait([site], cp, null, 40_000);
          for (let i = 0; i < 30 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
          await wait(4000);
          const v2 = await api(`site ${site}`).catch((e) => ({ error: String(e) }));
          check(v2 === null, `${tag}: retired: absent from lookup (${json(v2).slice(0, 160)})`, v2);
          const fin = (await evs()).filter((e) => e.id === site);
          rowLog('T4R-wnf-complete', `events ${json(fin).slice(0, 400)}`);
          check(fin.length >= 1 && (fin[0].result?.restored ?? 0) > 0 && fin[0].kind === 'site',
            `T4R-wnf-complete: the fault cleared, it completed: REMOVAL_FINISHED kind site for ${site} with its full result (restored ${fin[0]?.result?.restored}, owed ${json(fin[0]?.result?.owed)})`, fin);
          judgeT4('T4R-wnf-complete', { tag: 'T4R-wnf-complete', removal: m, txn: await txn() }, before, await parts([site], cp, items));
        } else {
          await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
        }
      }
    }
    // T4R-finish-road (P1-4): a stockpile road's removal paused after its commit (the road pending, its stash durable), halted unsaved, its job
    // dropped from the queue offline: at the start the road's recovery (CrateSettle.resumeInfra) restores and credits it and must emit
    // REMOVAL_FINISHED with its refund (the base: none)
    if (want('T4R-finish-road')) {
      const tag = 'T4R-finish-road';
      const pr = await pileRoad(tag, 'tcc:t4rfroad');
      if (pr) {
        const { rid, rparts, before } = pr;
        await call('dev.removal.pause', { site: rid, after: 0 }, 10_000);
        const rm = await api(`remove ${rid} ${pr.owner} noforce`).catch((e) => ({ error: String(e?.message ?? e).slice(0, 160) }));
        await removalQueued(tag, rid, rm);
        await wait(4000);
        call('dev.txn.halt', { save: false }, 10_000).catch(() => null);
        const down = await haltWait();
        check(down, `${tag}: halted with the road pending after its commit`);
        if (down) {
          const qf = path.join(W.dir, 'architect-queue.json');
          const q = JSON.parse(fs.readFileSync(qf, 'utf8'));
          const n0 = (q.jobs ?? []).length;
          q.jobs = (q.jobs ?? []).filter((j) => j.siteId !== rid);
          fs.writeFileSync(qf, JSON.stringify(q, null, 2));
          try { fs.unlinkSync(path.join(W.dir, 'architect', 'dev-removal-pause.json')); } catch { /* none */ }
          check(n0 > q.jobs.length, `${tag}: its job dropped from the queue offline (a job lost; the pending road and its stash stay)`);
          await L.openWorld(name);
          await L.tp(...W.at);
          await roadGone(rid, 60);
          for (let i = 0; i < 30 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
          await wait(4000);
          const fin = (await evs()).filter((e) => e.id === rid);
          rowLog(tag, `events ${json(fin).slice(0, 400)}`);
          check(fin.length >= 1 && (fin[0].result?.refundTotal ?? 0) > 0, `${tag}: the recovered road emits REMOVAL_FINISHED with its refund (${json(fin[0]?.result?.refund ?? null)})`, fin);
          const after = await rparts();
          judgeT4(tag, { tag, removal: rm, txn: await txn() }, { ...before }, after);
        }
      }
    }
    // T4R-finish-crash (P1-4): a crate-fed group removed; a crash after the finished removal's queue save, before its REMOVAL_FINISHED is
    // delivered (GE): after the restart the event fires (at least once)
    if (want('T4R-finish-crash')) {
      const tag = 'T4R-finish-crash';
      const g = await grouped(tag, 1);
      if (g.sites.length) {
        const { cp, items } = await partBuilt(tag, g.sites[0], 0.4);
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const before = await parts(g.sites, cp, items);
        await call('dev.journal.killAt', { point: 'GE' }, 10_000);
        const m = await api(`sgremove ${g.group}`).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
        const down = await haltWait();
        check(down, `${tag}: halted at GE (the removal finished, its queue save on disk, its event not delivered)`);
        if (down) {
          await L.openWorld(name);
          await L.tp(...W.at);
          for (let i = 0; i < 40 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
          await wait(5000);
          const fin = (await evs()).filter((e) => e.id === g.group);
          rowLog(tag, `events after the restart ${json(fin).slice(0, 300)}`);
          check(fin.length >= 1 && fin[0].kind === 'group', `${tag}: REMOVAL_FINISHED kind group for ${g.group} fires after the restart (${fin.length})`, fin);
          judgeT4(tag, { tag, removal: m, txn: await txn() }, before, await parts(g.sites, cp, items));
        } else {
          await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
        }
      }
    }
    // T4R-region-kind (P1-4): a region's group (its batch ext names the region) removed: exactly one REMOVAL_FINISHED, kind region
    if (want('T4R-region-kind')) {
      const tag = 'T4R-region-kind';
      const gat = slot();
      W.at = [gat[0] + 3, gy + 2, gat[2] + 24];
      await L.tp(...W.at);
      const region = `t4rreg${Date.now() % 100000}`;
      const bid = await later(`bqueue ${json({ id: `tcct4rrk${Date.now() % 100000}`, proximity: false, ext: { 'architect_mc:region': region },
        items: [{ key: 'h1', bp: 'rs_hut', at: [gat[0], gat[1], gat[2]], rot: 0, mode: 'CONSTRUCTION' }] })}`, 120_000);
      let bv;
      for (let i = 0; i < 120; i++) { bv = await api(`batch ${bid}`); if (bv.items?.every((x) => x.site || x.status === 'FAILED')) break; await L.sleep(1000); }
      check(!!bv?.group, `${tag}: a group whose ext names region ${region} (${bv?.group})`, bv);
      if (bv?.group) {
        const rm = await later(`sgremove ${bv.group}`, 600_000).catch((e) => ({ error: String(e) }));
        await wait(3000);
        const fin = (await evs()).filter((e) => e.id === bv.group || e.id === region);
        rowLog(tag, `removal ${json(rm).slice(0, 120)}; events ${json(fin.map((e) => [e.kind, e.id]))}`);
        check(fin.length === 1 && fin[0].kind === 'region' && fin[0].id === region, `${tag}: exactly one REMOVAL_FINISHED, kind region (${json(fin.map((e) => [e.kind, e.id]))})`, fin);
      }
    }
    // T4R-crate-unrelated (R7, Steward 5(b)): a pile with two crates; a stockpile-fed site's removal held (every txn barrier refused, it holds
    // pile:<owner>); removing the pile's other crate succeeds (the base: refused, any open txn on the pile); its last crate is still refused
    if (want('T4R-crate-unrelated')) {
      const tag = 'T4R-crate-unrelated';
      const owner = 'tcc:t4rcrate';
      const sp = slot();
      const c1 = [sp[0], sp[1], sp[2]], c2 = [sp[0] + 2, sp[1], sp[2]];
      await call('dev.stockpile.create', { owner, crates: [c1, c2] }, 120_000).catch((e) => ({ refused: String(e) }));
      const g = await grouped(tag, 1, owner);
      const site = g.sites[0];
      if (site) {
        for (let i = 0; i < 60; i++) { if ((await siteState(site))?.state === 'building') break; await L.sleep(1000); }
        await boxOf(site);
        await call('dev.stockpile.pause', { site, paused: true }, 60_000);
        const bom = (await siteState(site))?.bom ?? {};
        const part = {};
        for (const [kk, v] of Object.entries(bom)) { const n = Math.floor(v * 0.2); if (n > 0) part[kk] = n; }
        await call('dev.crate.insert', { site: `stockpile:${owner}`, items: part, exact: true }, 120_000).catch(() => null);
        await call('dev.stockpile.pause', { site, paused: false }, 60_000);
        const pst = async () => (await call('dev.stockpile.state', { owner }, 60_000).catch(() => ({}))).stockpile ?? {};
        for (let i = 0; i < 90; i++) { if (sum((await pst()).stock) === 0) break; await L.sleep(500); }
        await call('dev.stockpile.pause', { site, paused: true }, 60_000);
        await call('dev.txn.failBarrier', { n: 1_000_000 }, 10_000);
        const rm = await call('dev.site.deconstruct', { site }, 60_000).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
        await wait(2000);
        const t1 = await txn();
        const rc2 = await call('dev.stockpile.removecrate', { owner, pos: c2, force: false }, 60_000).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
        const rc1 = await call('dev.stockpile.removecrate', { owner, pos: c1, force: true }, 60_000).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
        await call('dev.txn.failBarrier', { n: 0 }, 10_000);
        for (let i = 0; i < 30 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
        R[tag] = { removal: rm, open: t1.openCount, other: rc2, last: rc1, pile: await pst() };
        rowLog(tag, `removal ${json(rm).slice(0, 120)}; open ${t1.openCount}; other crate ${json(rc2).slice(0, 160)}; last ${json(rc1).slice(0, 160)}`);
        check(t1.openCount > 0, `${tag}: the removal's txn is open and held (${t1.openCount})`, t1);
        check(rc2.removed === true, `${tag}: removing the pile's other crate succeeds while an unrelated removal is held (${json(rc2).slice(0, 200)})`, rc2);
        check(!rc1.removed, `${tag}: its last crate is still refused while the held removal credits the pile (${json(rc1).slice(0, 200)})`, rc1);
      }
    }
    // T4R-nojournal (T4-nojournal reworked): halted at K6 (its undo committed, its restore not written: every paid block stands), the world
    // opened with its journal unreadable: held, nothing paid, the paid blocks still standing; the journal back: completes once, exact
    if (want('T4R-nojournal')) {
      const tag = 'T4R-nojournal';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await partBuilt(tag, site, 0.4);
        const jf = path.join(W.dir, 'architect-journal', 'journal.json');
        await k6Row(tag, [site], site, cp, items, { point: 'K6', expectHeld: true,
          after: () => { fs.copyFileSync(jf, jf + '.t4keep'); fs.writeFileSync(jf, '{ not json'); },
          reopenAfter: () => { fs.copyFileSync(jf + '.t4keep', jf); } });
      }
    }
    // ================================================================ (slice T4R fix round) rows for the early review's P1s
    const minerKept = (br, drop, item) => ((br?.broken ?? 0) > 0 && sum(drop) === 0 && item ? { [item]: 1 } : {});
    // T4R-cargo-key (P1-5, P2 coverage): a data-bearing stack owed whole through the removal.cargo txn, collected back exactly; the same holder
    // slot refilled and owed again under the same source key must make a new collectible (the base: its owe probes APPLIED on the ended key,
    // the second stack lost); a crash right after a take (before its owe) gives the stack back at recovery
    if (want('T4R-cargo-key')) {
      const tag = 'T4R-cargo-key';
      const sp = slot();
      const pos = [sp[0], gy + 1, sp[2]];
      W.at = [pos[0] + 2, gy + 2, pos[2] + 2];
      await L.tp(...W.at);
      const rec = 'tcc:t4rcargo';
      const key = `cargo:t4rtarget@1:${pos.join(',')}#0`;
      const put = (name) => cmd(`/item replace block ${pos.join(' ')} container.0 with minecraft:diamond_sword[custom_name="${name}"]`);
      const inv = async () => String(((await cmd('/data get entity @p Inventory').catch(() => ({ messages: [] }))).messages ?? []).join(' '));
      const slot0 = async () => String(((await cmd(`/data get block ${pos.join(' ')} Items`).catch(() => ({ messages: [] }))).messages ?? []).join(' '));
      const mine = async () => ((await owedAll()).owed ?? []).filter((e) => e.recipient === rec);
      await cmd(`/setblock ${pos.join(' ')} minecraft:chest`);
      const collectAll = async () => { for (const e of await mine()) await call('dev.owed.collect', { recipient: rec, key: e.key }, 120_000).catch((x) => ({ error: String(x) })); };
      await put('Excalibur');
      const o1 = await call('dev.cargo.owe', { pos, slot: 0, recipient: rec, key }, 30_000).catch((e) => ({ error: String(e) }));
      const e1 = await mine();
      await collectAll();
      const i1 = await inv();
      await put('Durendal');
      const o2 = await call('dev.cargo.owe', { pos, slot: 0, recipient: rec, key }, 30_000).catch((e) => ({ error: String(e) }));
      const e2 = await mine();
      await collectAll();
      const i2 = await inv();
      const s2 = await slot0();
      R[tag] = { o1, e1, o2, e2 };
      rowLog(tag, `first owe ${json(o1).slice(0, 200)}; entries ${json(e1.map((e) => e.key))}; second owe ${json(o2).slice(0, 200)}; entries ${json(e2.map((e) => e.key))}`);
      check(/Excalibur/.test(i1), `${tag}: the first data-bearing stack owed whole and collected back exactly (Excalibur in the player's inventory)`, { i1: i1.slice(0, 300) });
      check(e2.length >= 1 && /Durendal/.test(i2) && !/Durendal/.test(s2), `${tag}: the same slot refilled and owed under the same source key makes a new collectible, collected back exactly (entries ${json(e2.map((e) => e.key))}; Durendal ${/Durendal/.test(i2) ? 'in the inventory' : 'LOST'})`, { e2, i2: i2.slice(0, 300), s2 });
      // recover: halted right after the take (its owe not applied), the world again: recovery gives the stack back (undecided: compensated)
      await put('Joyeuse');
      await cmd('/save-all flush').catch(() => null);
      await call('dev.journal.killAt', { point: 'TX:removal.cargo:apply:0' }, 10_000);
      call('dev.cargo.owe', { pos, slot: 0, recipient: rec, key: `${key}-r` }, 30_000).catch(() => null);
      const down = await haltWait();
      check(down, `${tag}: halted right after the cargo take`);
      if (down) {
        await L.openWorld(name);
        await L.tp(...W.at);
        for (let i = 0; i < 30 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
        await wait(2000);
        const s3 = await slot0();
        const e3 = (await mine()).filter((e) => e.key.endsWith(`${key}-r`)); // (T4R-L) only the halted take's own entry
        rowLog(tag, `after the restart: slot ${s3.slice(0, 200)}; owed ${json(e3.map((e) => e.key))}`);
        check(/Joyeuse/.test(s3) || e3.length > 0, `${tag}: recovery keeps the stack: back in its slot (compensated) or owed (${/Joyeuse/.test(s3) ? 'back in the slot' : json(e3.map((e) => e.key))})`, { s3: s3.slice(0, 300), e3 });
      } else {
        await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
      }
    }
    // (slice T4R-M) rows T4R-legacygroup and T4R-legacyroad-partial retired: it judged the pre-T4R conversion, which is gone (a pre-T4R removal runs main's path: T4RM-legacy-*)
    // T4R-health (P1-3, Changes §7): each participant store unreadable at a start makes Sites.loadHealthy() false (sites, queue, stockpiles,
    // txn.json); each file put back after its start
    if (want('T4R-health')) {
      const tag = 'T4R-health';
      const files = { sites: 'architect-sites.json', queue: 'architect-queue.json', stockpiles: path.join('architect', 'stockpiles.json'), txn: path.join('architect', 'txn.json') };
      const h0 = await api('health').catch((e) => ({ error: String(e) }));
      check(h0.loadHealthy === true, `${tag}: healthy before (${json(h0)})`, h0);
      for (const [k2, f] of Object.entries(files)) {
        await L.leaveWorld();
        const p = path.join(W.dir, f);
        const had = fs.existsSync(p);
        if (had) fs.copyFileSync(p, p + '.t4rkeep');
        fs.writeFileSync(p, '{ not json');
        await L.openWorld(name);
        await wait(3000);
        const h = await api('health').catch((e) => ({ error: String(e) }));
        rowLog(tag, `${k2} unreadable: ${json(h)}`);
        check(h.loadHealthy === false, `${tag}: ${k2} (${f}) unreadable: loadHealthy false (${json(h)})`, h);
        await L.leaveWorld();
        if (had) fs.copyFileSync(p + '.t4rkeep', p); else fs.unlinkSync(p);
        await L.openWorld(name);
        await L.tp(...W.at);
      }
    }
    // ================================================================ (slice T4R-L) rows for the T4R final check of 9913d902 (legacy-only round).
    // Recorded red on 9913d902 + the T4R-L hooks commit; green on the T4R-L fixes. GATE_TCC_PARTS=T4RL (step t4rl-crash).
    /** A stockpile of {@code owner} feeding a group of {@code n} rs_huts, about 30% built and paused; its parts over the group's sites. */
    const pileGroup = async (tag, owner, n) => {
      const sp = slot();
      await call('dev.stockpile.create', { owner, crates: [[sp[0], sp[1], sp[2]]] }, 120_000).catch((e) => ({ refused: String(e) }));
      const g = await grouped(tag, n, owner);
      if (g.sites.length !== n) return null;
      const pst = async () => (await call('dev.stockpile.state', { owner }, 60_000).catch(() => ({}))).stockpile ?? {};
      const boms = {};
      for (const site of g.sites) {
        for (let i = 0; i < 60; i++) { if ((await siteState(site))?.state === 'building') break; await L.sleep(1000); }
        await boxOf(site);
        await call('dev.stockpile.pause', { site, paused: true }, 60_000);
        boms[site] = (await siteState(site))?.bom ?? {};
      }
      const part = {};
      for (const bom of Object.values(boms)) for (const [kk, v] of Object.entries(bom)) { const c = Math.floor(v * 0.3); if (c > 0) part[kk] = (part[kk] ?? 0) + c; }
      await call('dev.crate.insert', { site: `stockpile:${owner}`, items: part, exact: true }, 120_000).catch(() => null);
      for (const site of g.sites) await call('dev.stockpile.pause', { site, paused: false }, 60_000);
      for (let i = 0; i < 120; i++) { if (sum((await pst()).stock) === 0) break; await L.sleep(500); }
      for (const site of g.sites) await call('dev.stockpile.pause', { site, paused: true }, 60_000);
      const items = [...new Set(Object.values(boms).flatMap((b) => Object.keys(b)))];
      const box = await boxOf(g.sites[0]);
      const mid = [Math.floor((box[0] + box[3]) / 2), box[1], Math.floor((box[2] + box[5]) / 2)];
      const gparts = async () => {
        const near = await call('dev.items.near', { pos: mid, radius: 48 }, 30_000);
        let placed = {};
        const states = {};
        for (const site of g.sites) { placed = G.plus(placed, pick(await standing(site, items), items)); states[site] = (await siteState(site))?.state ?? null; }
        const p = { stock: pick((await pst()).stock ?? {}, items), placed, owed: {}, ground: pick(near.items ?? {}, items), inventory: {}, states };
        p.total = [p.stock, p.placed, p.ground].reduce((x, y) => G.plus(x, y), {});
        return p;
      };
      /** A paid cell of {@code site} standing (the highest: its before is air), as [x, y, z] and its item. */
      const paidCell = async (site) => {
        let at = null, item = null;
        for (const [k2, st] of (await cellsOf(await boxOf(site))).entries()) {
          const id = String(st).replace(/\[.*$/, '');
          const full = id.includes(':') ? id : `minecraft:${id}`;
          const c = typeof k2 === 'string' ? k2.split(',').map(Number) : null;
          if (c && items.includes(full) && (!at || c[1] > at[1])) { at = c; item = full; }
        }
        return { at, item };
      };
      return { g, items, gparts, pst, paidCell };
    };
    const groupDone = async (sites, s = 180) => {
      for (let i = 0; i < s && (await Promise.all(sites.map(siteState))).some(Boolean); i++) await L.sleep(1000);
      for (let i = 0; i < 60 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
      await wait(4000);
    };
    // (slice T4R-M) rows T4RL-reattach and T4RL-premined retired: it judged the pre-T4R conversion, which is gone (a pre-T4R removal runs main's path: T4RM-legacy-*)
    // T4RL-refused (P1-1's second half): a group member's restore write refused by a hold that is not its removal's (dev.removal.holdBox over
    // one paid cell, as an unrelated removal's held box): the write must surface (no markRestored), the W hold and retry, nothing paid for
    // that block while it stands; the hold dropped, it completes exactly. The base: the refused write returned normally, markRestored made
    // the W receipt it and the block's refund was paid while it stood
    if (want('T4RL-refused')) {
      const tag = 'T4RL-refused';
      const owner = 'tcc:t4rlrf';
      const pg = await pileGroup(tag, owner, 1);
      if (pg) {
        const { g, gparts, paidCell, pst } = pg;
        const { at, item } = await paidCell(g.sites[0]);
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const before = await gparts();
        const hb = await call('dev.removal.holdBox', { cells: at ? [at] : [] }, 10_000).catch((e) => ({ error: String(e) }));
        check((hb.held ?? 0) === 1, `${tag}: a hold that is no removal's over the paid cell ${at} (${item}) (${json(hb)})`, hb);
        api(`sgremove ${g.group} - ${owner}`).catch(() => null);
        await wait(12000);
        const cellNow = at ? String((await cellsOf([at[0], at[1], at[2], at[0], at[1], at[2]])).values().next().value ?? '') : '';
        const mid = await gparts();
        const t1 = await txn();
        const paidNow = sum(mid.stock) - sum(before.stock);
        rowLog(tag, `held: the cell ${at} holds ${cellNow}; stock +${paidNow}; placed ${json(mid.placed)}; txn open ${t1.openCount}`);
        const over = Object.entries(mid.total).filter(([k2, v]) => v > (before.total[k2] ?? 0));
        check(over.length === 0, `${tag}: while its write is refused nothing is paid beside the block standing there (over before: ${json(over)}; ${json(mid.total)} vs ${json(before.total)})`, { mid, t1 });
        await call('dev.removal.holdBox', { off: true }, 10_000).catch(() => null);
        await groupDone(g.sites);
        judgeT4(tag, { tag, held: { cellNow, paidNow, open: t1.openCount }, txn: await txn() }, before, await gparts());
      }
    }
    // T4RL-fin (P2): a single removal's completion parts (restored, kept, hand-down, cascade) durable with its stash before its commit: halted
    // at K6 (bare), the stockpiles file on disk holds them, and the recovered REMOVAL_FINISHED reports them. The base added them after K6 (in
    // memory): the file had none and the recovery's fallback counted every journal cell restored
    if (want('T4RL-fin')) {
      const tag = 'T4RL-fin';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await partBuilt(tag, site, 0.4);
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const before = await parts([site], cp, items);
        await call('dev.journal.killAt', { point: 'K6' }, 10_000);
        const m = await call('dev.site.deconstruct', { site }, 60_000).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
        const down = await haltWait();
        check(down, `${tag}: halted at K6 (${json(m).slice(0, 120)})`);
        if (down) {
          const root = JSON.parse(fs.readFileSync(path.join(W.dir, 'architect', 'stockpiles.json'), 'utf8'));
          // (slice T4R-D) the completion parts live in the call's owner record (removals[removal:<site>@<undo>].members[site].fin)
          const own = Object.values(root.removals ?? {}).find((r) => r?.members?.[site]) ?? null;
          const st = own?.members?.[site] ?? root.crateSettles?.[site] ?? null;
          const f = st?.fin ?? null;
          rowLog(tag, `the stash on disk at K6: fin ${json(f)}`);
          check(!!f && Number.isInteger(f.restored) && Number.isInteger(f.kept) && f.handed && Array.isArray(f.cascaded),
            `${tag}: the durable stash on disk at K6 holds its completion parts (restored, kept, hand-down, cascade) (${json(f)})`, { st });
          await L.openWorld(name);
          await L.tp(...W.at);
          await settleWait([site], cp, null, 40_000);
          for (let i = 0; i < 30 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
          await wait(4000);
          const ev = (await evs()).filter((e) => e.id === site);
          rowLog(tag, `events ${json(ev).slice(0, 300)}`);
          check(ev.length >= 1 && !!f && ev[0].result?.restored === f.restored && (ev[0].result?.kept ?? 0) === f.kept,
            `${tag}: the recovered REMOVAL_FINISHED reports the parts recorded before the commit (restored ${ev[0]?.result?.restored} = ${f?.restored}, kept ${ev[0]?.result?.kept} = ${f?.kept})`, ev);
          judgeT4(tag, { tag, removal: m, txn: await txn() }, before, await parts([site], cp, items));
        } else {
          await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
        }
      }
    }
    // T4RL-cargo (P2): a group removal's data cargo owed (removal.cargo, through the queued removal's own cargo step), halted right after its
    // owe applied: the queue file on disk already links the owed key to the removal, and its REMOVAL_FINISHED lists it. The base saved the
    // link with the next queue save, after the cargo txn committed: the halt lost it
    if (want('T4RL-cargo')) {
      const tag = 'T4RL-cargo';
      const g = await grouped(tag, 1);
      const sp = slot();
      const pos = [sp[0], gy + 1, sp[2]];
      const rec = 'tcc:t4rlcargo';
      const key = `cargo:t4rltarget@1:${pos.join(',')}#0`;
      await cmd(`/setblock ${pos.join(' ')} minecraft:chest`);
      await cmd(`/item replace block ${pos.join(' ')} container.0 with minecraft:diamond_sword[custom_name="Tizona"]`);
      for (let i = 0; i < 60 && g.sites[0]; i++) { if ((await siteState(g.sites[0]))?.state === 'building') break; await L.sleep(1000); }
      check(!!g.sites[0] && !!(await siteState(g.sites[0])), `${tag}: the group's site stands before its removal (${json(g.sites)})`);
      if (g.group && g.sites[0]) {
        await call('dev.removal.pause', { site: `group:${g.group}` }, 10_000);
        api(`sgremove ${g.group}`).catch(() => null);
        let queued = false;
        for (let i = 0; i < 30 && !queued; i++) {
          await L.sleep(1000);
          queued = ((JSON.parse(fs.readFileSync(path.join(W.dir, 'architect-queue.json'), 'utf8')).removals) ?? []).some((r) => r.group === g.group);
        }
        check(queued, `${tag}: the group's removal queued and paused before its plan (${g.group})`);
        await call('dev.journal.killAt', { point: 'TX:removal.cargo:apply:1' }, 10_000);
        call('dev.cargo.owe', { pos, slot: 0, recipient: rec, key, group: g.group }, 30_000).catch(() => null);
        const down = await haltWait();
        check(down, `${tag}: halted right after the cargo owe applied`);
        if (down) {
          const q = JSON.parse(fs.readFileSync(path.join(W.dir, 'architect-queue.json'), 'utf8'));
          const r = (q.removals ?? []).find((x) => x.group === g.group);
          const linked = (r?.cargoOwed ?? []).filter((k2) => k2.endsWith(`:${key}`));
          rowLog(tag, `the queue on disk at the halt: cargoOwed ${json(r?.cargoOwed ?? null)}`);
          check(linked.length === 1, `${tag}: the queue file on disk links the owed key to the removal before its owe could commit (${json(r?.cargoOwed ?? null)})`, { r });
          await L.openWorld(name);
          await L.tp(...W.at);
          await call('dev.removal.pause', { site: `group:${g.group}`, off: true }, 10_000).catch(() => null);
          await groupDone(g.sites);
          const owed = ((await owedAll()).owed ?? []).filter((e) => e.recipient === rec && e.key.endsWith(`:${key}`));
          const ev = (await evs()).filter((e) => e.id === g.group);
          rowLog(tag, `owed ${json(owed.map((e) => e.key))}; events ${json(ev).slice(0, 300)}`);
          check(owed.length === 1, `${tag}: the stack owed once after the recovery (${json(owed.map((e) => e.key))})`, owed);
          check(ev.length >= 1 && (ev[0].result?.owed ?? []).some((k2) => k2.endsWith(`:${key}`)), `${tag}: its REMOVAL_FINISHED lists the cargo's owed key (${json(ev[0]?.result?.owed ?? null)})`, ev);
        } else {
          await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
        }
      }
    }
    // ================================================================ (slice T4R-M) rows for the final check of eca131b6 (NOT SAFE; Noah's design:
    // no old-world conversion). A removal a pre-T4R build left in flight finishes on main's path (main's accounting, no T4R txn of any kind);
    // only removals started after the upgrade use T4R's txns, and a new removal never takes a hold over an in-flight removal's area.
    // Recorded red on eca131b6 + the T4R-M hooks commit; green on the T4R-M fixes. GATE_TCC_PARTS=T4RM (step t4rm-crash).
    /** Main's (v0.89.0) Groups.Removal.toJson keys: anything else this build writes is stripped from a fabricated main entry. */
    const MAIN_REMOVAL_KEYS = ['group', 'stage', 'sites', 'requester', 'force', 'covered', 'started', 'current', 'waited', 'refund', 'planned',
      'plannedSites', 'undo', 'undoSites', 'handed', 'restoredCells', 'keptCells', 'dec', 'credit', 'stalled'];
    /** Main's (v0.89.0) RestoreJob.toJson keys. */
    const MAIN_JOB_KEYS = ['kind', 'siteId', 'batchId', 'itemKey', 'group', 'phase', 'why', 'requeue', 'dropsBefore', 'handed', 'credit', 'type'];
    const qFile = () => path.join(W.dir, 'architect-queue.json');
    const sFile = () => path.join(W.dir, 'architect', 'stockpiles.json');
    const tFile = () => path.join(W.dir, 'architect', 'txn.json');
    /**
     * The halted world's group removals of {@code groups} turned main-shaped offline: each member's pile stash a main decCredit, every field
     * main's serializer lacks stripped (the txn marker included), and DR-S's pending credit for each target key in its pile's ledger (main's
     * holdPending, saved before the commit). Returns the credits made, by key.
     */
    const mainGroupQueue = (owner, groups) => {
      const q = JSON.parse(fs.readFileSync(qFile(), 'utf8'));
      const root = JSON.parse(fs.readFileSync(sFile(), 'utf8'));
      const credits = {};
      for (const r of q.removals ?? []) {
        if (!groups.includes(r.group)) continue;
        for (const [id, st] of Object.entries(r.settle ?? {})) {
          if (!st?.pileKey) continue;
          r.credit = r.credit ?? {};
          r.credit[id] = { owner, key: st.pileKey, items: st.refund ?? {}, at: st.pos ?? 0 };
          credits[st.pileKey] = { items: st.refund ?? {}, at: st.pos ?? 0 };
        }
        for (const k2 of Object.keys(r)) if (!MAIN_REMOVAL_KEYS.includes(k2)) delete r[k2];
      }
      for (const po of root.stockpiles ?? []) {
        if (po.owner !== owner) continue;
        po.ledger = po.ledger ?? {};
        po.ledger.pendingCredit = { ...(po.ledger.pendingCredit ?? {}), ...credits };
      }
      fs.writeFileSync(qFile(), JSON.stringify(q, null, 2));
      fs.writeFileSync(sFile(), JSON.stringify(root, null, 2));
      return credits;
    };
    /** The txn file's next id (null: none). */
    const txnNext = () => { try { return JSON.parse(fs.readFileSync(tFile(), 'utf8')).next ?? 0; } catch { return 0; } };
    /** Every txn (open, retiring, done) begun since id {@code next0}, as {id, kind, key}. */
    const txnsSince = (next0) => {
      let t = {};
      try { t = JSON.parse(fs.readFileSync(tFile(), 'utf8')); } catch { return []; }
      return [...(t.open ?? []), ...(t.retiring ?? []), ...(t.done ?? [])].filter((e) => Number(String(e.id).replace(/^tx-/, '')) >= next0)
        .map((e) => ({ id: e.id, kind: e.kind ?? null, key: e.key ?? null }));
    };
    /** No removal txn (removal.group, removal.road, removal.site, crate.settle of a removal) began since {@code next0}. */
    const noRemovalTxn = (tag, next0) => {
      const all = txnsSince(next0);
      const bad = all.filter((e) => /^removal\./.test(e.kind ?? '') || /^(group:|pile-refund:|crate-refund:|settle:|crate-settle)/.test(e.key ?? ''));
      rowLog(tag, `txns since tx-${next0}: ${json(all)}`);
      check(bad.length === 0, `${tag}: the pre-T4R removal ran on main's path: no removal txn began (${json(bad)})`, all);
    };
    const minus = (a, b) => Object.fromEntries(Object.entries(a ?? {}).map(([k2, v]) => [k2, v - (b?.[k2] ?? 0)]).filter(([, v]) => v !== 0));

    // T4RM-legacy-group (P1-1, P1-2's legacy side): a pre-T4R group removal of one stockpile member, halted at K6 by main (its undo committed,
    // nothing written), its queue main-shaped offline. It must finish on main's path: its decCredit credited once its restore is written,
    // exactly as tallied, conserved, and no T4R txn (eca131b6 converted it into a removal.group txn with load-time holds and W-time valuation)
    if (want('T4RM-legacy-group')) {
      const tag = 'T4RM-legacy-group';
      const owner = 'tcc:t4rmlg';
      const pg = await pileGroup(tag, owner, 1);
      if (pg) {
        const { g, gparts } = pg;
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const before = await gparts();
        await call('dev.journal.killAt', { point: 'K6' }, 10_000);
        const m = await api(`sgremove ${g.group} - ${owner}`).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
        const down = await haltWait();
        check(down, `${tag}: halted at K6 (${json(m).slice(0, 120)})`);
        if (down) {
          const next0 = txnNext();
          const credits = mainGroupQueue(owner, [g.group]);
          const credit = Object.values(credits).reduce((a, c) => G.plus(a, c.items), {});
          check(Object.keys(credits).length === 1, `${tag}: the queued removal main-shaped offline (decCredit ${json(credits)}, DR-S's pending credit)`);
          await L.openWorld(name);
          await L.tp(...W.at);
          await groupDone(g.sites);
          const after = await gparts();
          const refunded = minus(after.stock, before.stock);
          rowLog(tag, `refunded ${json(refunded)}; credit ${json(credit)}; placed ${json(after.placed)}`);
          check(G.same(refunded, credit), `${tag}: main's credit, once its restore is written: refunded ${json(refunded)} = the queued credit ${json(credit)}`, { refunded, credit });
          judgeT4(tag, { tag, removal: m, credits, txn: await txn() }, before, after);
          noRemovalTxn(tag, next0);
          const pend = (JSON.parse(fs.readFileSync(sFile(), 'utf8')).stockpiles ?? []).find((p) => p.owner === owner)?.ledger?.pendingCredit ?? {};
          check(Object.keys(credits).every((k2) => !pend[k2]), `${tag}: no pending credit left (${json(Object.keys(pend))})`, pend);
        } else {
          await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
        }
      }
    }
    // T4RM-legacy-road (P1-3's legacy side): a pre-T4R standalone stockpile road removal whose job restored 8 cells before the upgrade (paused
    // there, saved), main-shaped offline (C29's credit, no stash). Main's path pays the C29 credit whole after its last write, no T4R txn
    if (want('T4RM-legacy-road')) {
      const tag = 'T4RM-legacy-road';
      const owner = 'tcc:t4rmlr';
      const pr = await pileRoad(tag, owner);
      if (pr) {
        const { rid, rparts, before } = pr;
        await call('dev.removal.pause', { site: rid, after: 8 }, 10_000);
        const rm = await api(`remove ${rid} ${pr.owner} noforce`).catch((e) => ({ error: String(e?.message ?? e).slice(0, 160) }));
        await removalQueued(tag, rid, rm);
        await wait(5000);
        const mid0 = await rparts();
        call('dev.txn.halt', { save: true }, 10_000).catch(() => null);
        const down = await haltWait();
        check(down, `${tag}: halted (+save) with the road's restore paused after 8 cells (${sum(mid0.placed)} of ${sum(before.placed)} standing)`);
        if (down) {
          const next0 = txnNext();
          const q = JSON.parse(fs.readFileSync(qFile(), 'utf8'));
          const root = JSON.parse(fs.readFileSync(sFile(), 'utf8'));
          const st = root.crateSettles?.[rid];
          let credit = null;
          for (const j of q.jobs ?? []) {
            if (j.siteId !== rid || !j.settle?.pileKey) continue;
            j.credit = { owner, key: j.settle.pileKey, items: j.settle.refund ?? {}, at: j.settle.pos ?? 0 };
            credit = j.credit.items;
            for (const k2 of Object.keys(j)) if (!MAIN_JOB_KEYS.includes(k2)) delete j[k2];
          }
          if (credit && st) {
            delete root.crateSettles[rid];
            fs.writeFileSync(sFile(), JSON.stringify(root, null, 2));
            fs.writeFileSync(qFile(), JSON.stringify(q, null, 2));
          }
          try { fs.unlinkSync(path.join(W.dir, 'architect', 'dev-removal-pause.json')); } catch { /* none */ }
          check(!!credit && !!st, `${tag}: the queued job main-shaped offline (C29's credit ${json(credit)}, no stash)`, { st });
          await L.openWorld(name);
          await L.tp(...W.at);
          await roadGone(rid);
          for (let i = 0; i < 40 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
          await wait(4000);
          const after = await rparts();
          const refunded = minus(after.stock, before.stock);
          rowLog(tag, `refunded ${json(refunded)}; C29 credit ${json(credit)}; standing at the halt ${json(mid0.placed)}`);
          check(G.same(refunded, credit ?? {}), `${tag}: main's C29 credit paid whole after the last write: ${json(refunded)} = ${json(credit)}`, { refunded, credit });
          judgeT4(tag, { tag, removal: rm, txn: await txn() }, { ...before }, after);
          await roadFinished(tag, pr, after);
          noRemovalTxn(tag, next0);
        }
      }
    }
    // T4RM-legacy-single: a pre-T4R single stockpile site removal halted at R4 +save (its restore written and saved, its refund J2's held
    // pending credit, no stash, as main saves it): main's path settles it at the start (the Sites check reads it restored and releases it,
    // settlePendingCredits books the credit once), no T4R txn
    if (want('T4RM-legacy-single')) {
      const tag = 'T4RM-legacy-single';
      const owner = 'tcc:t4rmls';
      const pg = await pileGroup(tag, owner, 1);
      if (pg) {
        const { g, gparts } = pg;
        const site = g.sites[0];
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const before = await gparts();
        await call('dev.journal.killAt', { point: 'R4+save' }, 10_000);
        const m = await call('dev.site.deconstruct', { site }, 60_000).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
        const down = await haltWait();
        check(down, `${tag}: halted at R4 +save (${json(m).slice(0, 120)})`);
        if (down) {
          const next0 = txnNext();
          const root = JSON.parse(fs.readFileSync(sFile(), 'utf8'));
          // (slice T4R-D) this build saves an owner record (removals), not a per-site stash: its member's settle is the pile stash
          const ownKey = Object.keys(root.removals ?? {}).find((k) => root.removals[k]?.members?.[site]);
          const st = ownKey ? root.removals[ownKey].members[site].settle : root.crateSettles?.[site];
          let credit = null;
          if (st?.pileKey) {
            for (const po of root.stockpiles ?? []) {
              if (po.owner !== owner) continue;
              po.ledger = po.ledger ?? {};
              po.ledger.pendingCredit = { ...(po.ledger.pendingCredit ?? {}), [st.pileKey]: { items: st.refund ?? {}, at: st.pos } };
              credit = st.refund ?? {};
            }
            if (root.crateSettles) delete root.crateSettles[site];
            if (ownKey) delete root.removals[ownKey]; // main has no owner record
            fs.writeFileSync(sFile(), JSON.stringify(root, null, 2));
            // its pending record as main saves it: no settle stash on it
            const sf2 = path.join(W.dir, 'architect-sites.json');
            const sr = JSON.parse(fs.readFileSync(sf2, 'utf8'));
            for (const pe of sr.pending ?? []) if (pe?.site?.id === site) delete pe.settle;
            fs.writeFileSync(sf2, JSON.stringify(sr, null, 2));
          }
          check(!!credit, `${tag}: the removal's stash main-shaped offline: J2's pending credit ${json(credit)}`, st);
          await L.openWorld(name);
          await L.tp(...W.at);
          for (let i = 0; i < 60 && (await siteState(site)); i++) await L.sleep(1000);
          check(!(await siteState(site)), `${tag}: ${site} removed (released by main's settle)`);
          for (let i = 0; i < 30 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
          await wait(5000);
          const after = await gparts();
          const refunded = minus(after.stock, before.stock);
          rowLog(tag, `refunded ${json(refunded)}; pending credit ${json(credit)}`);
          check(G.same(refunded, credit ?? {}), `${tag}: main's settle booked the pending credit once: ${json(refunded)} = ${json(credit)}`, { refunded, credit });
          judgeT4(tag, { tag, removal: m, txn: await txn() }, before, after);
          noRemovalTxn(tag, next0);
        } else {
          await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
        }
      }
    }
    /**
     * Two stockpile construction roads of one owner in two batches (two groups): road 1 straight along x, built whole; road 2 a U LAYERed
     * over it, crossing it twice, about half paid. Road 2's box (its U's bounding box) holds road 1's cells between the crossings; road 1's
     * box (its line) holds road 2's crossing cells: each removal writes inside the other's member box (its removal's hold).
     */
    const pileRoads2 = async (tag, owner) => {
      const at = slot();
      k += 2;
      const y = gy + 1, X = at[0], Z = at[2] + 20;
      await cmd(`/fill ${X - 3} ${y - 1} ${Z - 6} ${X + 30} ${y - 1} ${Z + 6} minecraft:stone`);
      W.at = [X + 10, y + 1, Z + 9];
      await L.tp(...W.at);
      const crate = [X + 10, y, Z - 9];
      await call('dev.stockpile.create', { owner, crates: [crate] }, 120_000).catch((e) => ({ refused: String(e) }));
      const pst = async () => (await call('dev.stockpile.state', { owner }, 60_000).catch(() => ({}))).stockpile ?? {};
      const roads = [];
      const specs = [[1, [[X, y, Z], [X + 26, y, Z]]], [2, [[X + 6, y, Z - 4], [X + 6, y, Z + 4], [X + 20, y, Z + 4], [X + 20, y, Z - 4]]]];
      for (const [n, points] of specs) {
        const road = { points, width: 1, mode: 'AUTO' };
        const bid = await later(`bqueue ${json({ id: `tcct4rm${n}x${Date.now() % 100000}`, proximity: false, owner, autoApprove: true, overlap: 'LAYER', items: [{ key: `r${n}`, road }] })}`, 120_000);
        let bv;
        for (let i = 0; i < 120; i++) { bv = await api(`batch ${bid}`); if (bv.items?.every((x) => x.site || x.status === 'FAILED')) break; await L.sleep(1000); }
        const rid = bv?.items?.[0]?.site;
        check(!!rid, `${tag}: road ${n} fed from the stockpile of ${owner} (${rid}; ${json(bv?.items?.[0] ?? null).slice(0, 300)})`, bv);
        if (!rid) return null;
        for (let i = 0; i < 60; i++) { const rv0 = await roadState(rid).catch(() => null); if (rv0 && !/plac/i.test(String(rv0.state))) break; await L.sleep(1000); }
        const bill = (await api(`stock ${bv.group}`).catch(() => ({}))).outstandingBySite?.[rid] ?? {};
        roads.push({ rid, group: bv.group, bill });
        if (n === 1) {
          // road 1 built whole (a construction road still building can't be layered over)
          await call('dev.crate.insert', { site: `stockpile:${owner}`, items: bill, exact: true }, 120_000).catch(() => null);
          for (let i = 0; i < 120; i++) { if (!/build/i.test(String((await roadState(rid).catch(() => null))?.state ?? 'building')) && sum((await pst()).stock) === 0) break; await L.sleep(1000); }
          rowLog(tag, `road 1 ${rid}: ${json(await roadState(rid).catch(() => null)).slice(0, 200)}`);
        } else {
          await call('dev.stockpile.pause', { site: rid, paused: true }, 60_000).catch(() => null);
        }
      }
      const half = {};
      for (const [kk, v] of Object.entries(roads[1].bill)) half[kk] = Math.max(1, Math.floor(v / 2));
      await call('dev.crate.insert', { site: `stockpile:${owner}`, items: half, exact: true }, 120_000).catch(() => null);
      await call('dev.stockpile.pause', { site: roads[1].rid, paused: false }, 60_000).catch(() => null);
      for (let i = 0; i < 90; i++) { if (sum((await pst()).stock) === 0) break; await L.sleep(500); }
      await call('dev.stockpile.pause', { site: roads[1].rid, paused: true }, 60_000).catch(() => null);
      const items = [...new Set(roads.flatMap((r) => Object.keys(r.bill)))];
      for (const r of roads) {
        const rv = await roadState(r.rid);
        const mm = rv && /minX=(-?\d+), minY=(-?\d+), minZ=(-?\d+), maxX=(-?\d+), maxY=(-?\d+), maxZ=(-?\d+)/.exec(rv.box);
        r.box = mm ? mm.slice(1, 7).map(Number) : null;
      }
      const all = [Math.min(...roads.map((r) => r.box?.[0] ?? X)), y - 2, Z - 6, Math.max(...roads.map((r) => r.box?.[3] ?? X + 27)), y + 2, Z + 6];
      const placedIn = async (b) => {
        const placed = {};
        for (const st of (await cellsOf(b)).values()) {
          const id = String(st).replace(/\[.*$/, '');
          const full = id.includes(':') ? id : `minecraft:${id}`;
          if (items.includes(full)) placed[full] = (placed[full] ?? 0) + 1;
        }
        return placed;
      };
      const rparts = async () => {
        const near = await call('dev.items.near', { pos: W.at, radius: 24 }, 30_000);
        const p = { stock: pick((await pst()).stock ?? {}, items), placed: await placedIn(all), owed: {}, ground: pick(near.items ?? {}, items), inventory: {},
          states: Object.fromEntries(await Promise.all(roads.map(async (r) => [r.rid, (await roadState(r.rid).catch(() => null))?.state ?? null]))) };
        p.total = [p.stock, p.placed, p.ground].reduce((a, b) => G.plus(a, b), {});
        return p;
      };
      await cmd('/save-all flush').catch(() => null);
      await wait(2000);
      const before = await rparts();
      // the precondition: each road's box (its removal's member hold) covers paid cells of the other road
      const cross = [];
      for (const [a, b] of [[0, 1], [1, 0]]) {
        const ab = roads[a].box, bb = roads[b].box;
        const inter = ab && bb ? [Math.max(ab[0], bb[0]), Math.max(ab[1], bb[1]), Math.max(ab[2], bb[2]), Math.min(ab[3], bb[3]), Math.min(ab[4], bb[4]), Math.min(ab[5], bb[5])] : null;
        cross.push(inter && inter[0] <= inter[3] && inter[1] <= inter[4] && inter[2] <= inter[5] ? sum(await placedIn(inter)) : 0);
      }
      rowLog(tag, `roads ${json(roads.map((r) => ({ rid: r.rid, group: r.group, box: r.box })))}; paid blocks in the boxes' overlap ${json(cross)}; placed ${json(before.placed)}`);
      check(sum(before.placed) > 0 && roads.every((r) => r.box) && cross.every((c) => c > 0), `${tag}: two paid roads, each one's box holding paid cells of the other (${json(cross)})`, before);
      return { roads, rparts, before, pst };
    };
    const bothGone = async (roads, s = 150) => {
      for (let i = 0; i < s; i++) {
        const left = (await Promise.all(roads.map((r) => roadState(r.rid).catch(() => null)))).filter(Boolean);
        if (left.length === 0 && (await txn()).openCount === 0) return true;
        await L.sleep(1000);
      }
      return false;
    };
    const overlapJudge = async (tag, pr, extra) => {
      const done = await bothGone(pr.roads);
      const after = await pr.rparts();
      const t = await txn();
      rowLog(tag, `both removed ${done}; states ${json(after.states)}; txn open ${t.openCount} held ${t.heldCount} ${json((t.open ?? []).map((x) => ({ id: x.id, kind: x.kind, held: x.held })))}`);
      check(done, `${tag}: both overlapping removals finish (no removal holds the other: states ${json(after.states)}, open txns ${t.openCount}, held ${t.heldCount})`, { after, t });
      check(sum(after.placed) === 0, `${tag}: no paid block of either road stands (${json(after.placed)})`, after);
      check(G.same(after.stock, G.plus(pr.before.stock, pr.before.placed)), `${tag}: both refunds credited once: ${json(after.stock)} = ${json(G.plus(pr.before.stock, pr.before.placed))}`, after);
      judgeT4(tag, { tag, ...extra, txn: t }, pr.before, after);
    };
    // T4RM-overlap-new (P1-2 for new removals): two new group removals over overlapping boxes (two parallel stockpile roads, each road's box
    // holding the other's cells). The first's restore paused until the second has started: both must finish. eca131b6 admitted both
    // removal.group txns (only identical resource strings conflict), each held its member box, and each one's restore was refused in the
    // other's box: both held for good
    if (want('T4RM-overlap-new')) {
      const tag = 'T4RM-overlap-new';
      const pr = await pileRoads2(tag, 'tcc:t4rmon');
      if (pr) {
        const [a, b] = pr.roads;
        await call('dev.removal.pause', { site: a.rid, after: 0 }, 10_000);
        const ra = api(`sgremove ${a.group} - tcc:t4rmon keep`).catch((e) => ({ error: String(e) }));
        await wait(8000);
        const rb = api(`sgremove ${b.group} - tcc:t4rmon keep`).catch((e) => ({ error: String(e) }));
        await wait(15000);
        const t1 = await txn();
        rowLog(tag, `with ${a.rid}'s restore paused: open txns ${json((t1.open ?? []).map((x) => ({ id: x.id, kind: x.kind, held: x.held, resources: x.resources })))}`);
        await call('dev.removal.pause', { site: a.rid, off: true }, 10_000).catch(() => null);
        await overlapJudge(tag, pr, { ra: await Promise.race([ra, L.sleep(1000).then(() => 'pending')]), rb: await Promise.race([rb, L.sleep(1000).then(() => 'pending')]) });
      }
    }
    // T4RM-overlap-legacy (the coexistence rule): a pre-T4R group removal of road A (halted at K6, main-shaped offline, its restore paused
    // across the start) and a new group removal of road B whose box overlaps A's: the new one waits for the pre-T4R one, which finishes on
    // main's path; then the new one finishes. Both exact, no removal txn for A
    if (want('T4RM-overlap-legacy')) {
      const tag = 'T4RM-overlap-legacy';
      const owner = 'tcc:t4rmol';
      const pr = await pileRoads2(tag, owner);
      if (pr) {
        const [a, b] = pr.roads;
        await call('dev.removal.pause', { site: a.rid, after: 0 }, 10_000);
        await call('dev.journal.killAt', { point: 'K6' }, 10_000);
        const ra = await api(`sgremove ${a.group} - ${owner} keep`).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
        const down = await haltWait();
        check(down, `${tag}: road ${a.rid}'s group removal halted at K6 (${json(ra).slice(0, 120)})`);
        if (down) {
          const next0 = txnNext();
          const credits = mainGroupQueue(owner, [a.group]);
          check(Object.keys(credits).length === 1, `${tag}: its queue entry main-shaped offline (${json(credits)})`);
          await L.openWorld(name);
          await L.tp(...W.at);
          await wait(3000);
          // the coexistence rule: a new standalone removal over the pre-T4R removal's area is refused while it runs, nothing changed
          const solo = await later(`remove ${b.rid} ${owner} noforce keep`, 60_000).catch((e) => ({ error: String(e?.message ?? e) }));
          rowLog(tag, `a new standalone removal of ${b.rid} while the pre-T4R removal of ${a.group} runs: ${json(solo).slice(0, 300)}`);
          check(/Not ?yet/.test(json(solo)) && !!(await roadState(b.rid).catch(() => null)), `${tag}: a new removal over a pre-T4R removal's area is refused while it runs (SITE_BUSY, ${b.rid} stands): ${json(solo).slice(0, 200)}`, solo);
          const rb = api(`sgremove ${b.group} - ${owner} keep`).catch((e) => ({ error: String(e) }));
          await wait(15000);
          const t1 = await txn();
          rowLog(tag, `with the pre-T4R removal's restore paused: open txns ${json((t1.open ?? []).map((x) => ({ id: x.id, kind: x.kind, held: x.held })))}`);
          await call('dev.removal.pause', { site: a.rid, off: true }, 10_000).catch(() => null);
          await overlapJudge(tag, pr, { rb: await Promise.race([rb, L.sleep(1000).then(() => 'pending')]) });
          const legacyTx = txnsSince(next0).filter((e) => (e.key ?? '').startsWith(`group:${a.group}`));
          check(legacyTx.length === 0, `${tag}: no removal.group txn for the pre-T4R removal of ${a.group} (${json(legacyTx)})`, legacyTx);
        } else {
          await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
          await call('dev.removal.pause', { site: a.rid, off: true }, 10_000).catch(() => null);
        }
      }
    }
    // T4RM-fin (the final check's test gap): a single removal's completion parts recovered after K6 equal the parts of a clean twin removal
    // (computed at its call from its plan, not from a saved fin) and are non-trivial: kept = the cells a player changed, a hand-down to a
    // LAYERed site on top (KEEP), and a cascade of it (CASCADE). The base's T4RL-fin used kept 0, no hand-down, no cascade
    if (want('T4RM-fin')) {
      const tag = 'T4RM-fin';
      /**
       * A stockpile-fed rs_hut built whole (a paid removal: its pile stash carries fin), a gatehouse LAYERed on it (instant), two of its
       * standing paid blocks outside the gatehouse's box replaced by sponge.
       */
      const fixture = async (sub) => {
        const owner = `tcc:t4rmfin${sub.replace(/[^a-z]/g, '')}`;
        const pg = await pileGroup(`${tag}-${sub}`, owner, 1);
        if (!pg) return null;
        const site = pg.g.sites[0];
        const bom = (await siteState(site))?.bom ?? {};
        await call('dev.crate.insert', { site: `stockpile:${owner}`, items: bom, exact: true }, 120_000).catch(() => null);
        await call('dev.stockpile.pause', { site, paused: false }, 60_000);
        for (let i = 0; i < 240; i++) { if ((await siteState(site))?.state === 'built') break; await L.sleep(1000); }
        const built = (await siteState(site))?.state === 'built';
        const b = await boxOf(site);
        const top = await later(`place cabin ${b[0] + 1} ${b[1] + 1} ${b[2] + 1} INSTANT unowned actor 0 force layer`, 120_000).catch((e) => ({ error: String(e) }));
        const tb = top?.siteId ? await boxOf(top.siteId) : null;
        const inTop = (c) => tb && c[0] >= tb[0] && c[0] <= tb[3] && c[1] >= tb[1] && c[1] <= tb[4] && c[2] >= tb[2] && c[2] <= tb[5];
        const changed = [];
        for (const [k2, st] of (await cellsOf(b)).entries()) {
          const id = String(st).replace(/\[.*$/, '');
          const full = id.includes(':') ? id : `minecraft:${id}`;
          const c = typeof k2 === 'string' ? k2.split(',').map(Number) : null;
          if (c && pg.items.includes(full) && !inTop(c) && changed.length < 2) changed.push(c);
        }
        // a player's change: the paid block broken and a sponge placed there by a player (its placement record: a player's block the undo keeps)
        for (const c of changed) {
          await call('dev.pt.breaks', { at: [c], placer: 'T4RMPlayer' }, 60_000).catch(() => null);
          await call('dev.pt.uses', { ops: [{ item: 'minecraft:sponge', at: c, on: [c[0], c[1] - 1, c[2]], face: 'up', placer: 'T4RMPlayer' }] }, 60_000).catch(() => null);
        }
        await cmd(`/kill @e[type=minecraft:item,x=${b[0]},y=${b[1]},z=${b[2]},distance=..32]`).catch(() => null);
        rowLog(tag, `${sub}: ${site} built ${built}; on top ${json(top).slice(0, 300)} (${json(tb)}); changed ${json(changed)}`);
        return { site, owner, items: pg.items, top: top?.siteId ?? null, changed, built };
      };
      for (const mode of ['keep', 'cascade']) {
        const twin = await fixture(`${mode}-twin`);
        const crash = await fixture(`${mode}-crash`);
        if (!twin || !crash) continue;
        check(!!twin.top && !!crash.top && twin.changed.length === 2 && crash.changed.length === 2, `${tag} ${mode}: the fixture: a site LAYERed on top (${twin.top}, ${crash.top}), two cells changed by a player`, { twin, crash });
        const stockOf = async (o) => (await call('dev.stockpile.state', { owner: o }, 60_000).catch(() => ({}))).stockpile?.stock ?? {};
        const groundOf = async (site) => { const bb = await boxOf(site); return (await call('dev.items.near', { pos: [Math.floor((bb[0] + bb[3]) / 2), bb[1], Math.floor((bb[2] + bb[5]) / 2)], radius: 24 }, 30_000).catch(() => ({}))).items ?? {}; };
        // (slice T4R-D, re-pointed) the player's blocks are owed to their placer (reason player_blocks), never dropped: moved = stock + ground + owed
        const placer = (await call('dev.pt.uuid', { name: 'T4RMPlayer' }, 10_000).catch(() => ({}))).uuid;
        const owedTo = async () => (await call('dev.stockpile.owed', { recipient: placer }, 30_000).catch(() => ({}))).total ?? {};
        const t0 = { stock: await stockOf(twin.owner), ground: await groundOf(twin.site), owed: await owedTo() };
        const clean = await later(`remove ${twin.site} ${twin.owner} noforce ${mode}`, 120_000).catch((e) => ({ error: String(e) }));
        await wait(3000);
        const tGround = minus(await groundOf(twin.site), t0.ground);
        const tOwed = minus(await owedTo(), t0.owed);
        const tMoved = G.plus(G.plus(minus(await stockOf(twin.owner), t0.stock), tGround), tOwed);
        check(!tGround['minecraft:sponge'] && tOwed['minecraft:sponge'] === 2, `${tag} ${mode}: the clean twin owes the player's 2 sponges to their placer, none dropped (owed ${json(tOwed)}, ground ${json(tGround)})`, { tOwed, tGround });
        check((clean.owedParts ?? []).some((pp) => pp.reason === 'player_blocks' && pp.recipient === placer && pp.items?.['minecraft:sponge'] === 2) && !(clean.refund ?? {})['minecraft:sponge'],
          `${tag} ${mode}: the clean twin's result: sponge in owedParts (player_blocks, to the placer), not in refund (${json(clean.owedParts)}; refund ${json(clean.refund)})`, clean);
        const c0 = { stock: await stockOf(crash.owner), ground: await groundOf(crash.site), owed: await owedTo() };
        rowLog(tag, `${mode} clean twin: ${json(clean).slice(0, 300)}; moved into stock and onto the ground ${json(tMoved)}`);
        check(G.same(G.plus(clean.refund ?? {}, tOwed), tMoved), `${tag} ${mode}: the clean twin's result refund + its player's owed is what it moved (stock + dropped + owed): ${json(clean.refund)} + ${json(tOwed)} = ${json(tMoved)}`, { clean, tMoved });
        await call('dev.journal.killAt', { point: 'K6' }, 10_000);
        api(`remove ${crash.site} ${crash.owner} noforce ${mode}`).catch(() => null);
        const down = await haltWait();
        check(down, `${tag} ${mode}: halted at K6`);
        if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); continue; }
        await L.openWorld(name);
        await L.tp(...W.at);
        for (let i = 0; i < 60 && (await siteState(crash.site)); i++) await L.sleep(1000);
        for (let i = 0; i < 30 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
        await wait(4000);
        const ev = (await evs()).filter((e) => e.id === crash.site);
        const res = ev[0]?.result ?? {};
        const cOwed = minus(await owedTo(), c0.owed);
        const cMoved = G.plus(G.plus(minus(await stockOf(crash.owner), c0.stock), minus(await groundOf(crash.site), c0.ground)), cOwed);
        check(G.same(cOwed, tOwed), `${tag} ${mode}: the recovered removal owes the player's blocks as the clean twin (${json(cOwed)} = ${json(tOwed)})`, { cOwed, tOwed });
        check(json(res.owedParts ?? []) === json(clean.owedParts ?? []) || G.same((res.owedParts ?? []).find((x) => x.reason === 'player_blocks')?.items ?? {}, (clean.owedParts ?? []).find((x) => x.reason === 'player_blocks')?.items ?? {}),
          `${tag} ${mode}: T4RD-api-recovered: the recovered event's owedParts carry the player_blocks part as the clean twin (${json(res.owedParts)})`, { res, clean });
        const rr = await api(`removalResult site ${crash.site}`).catch(() => null);
        check(rr && G.same(rr.refund ?? {}, res.refund ?? {}) && !(rr.refund ?? {})['minecraft:sponge'], `${tag} ${mode}: T4RD-api-recovered: Sites.removalResult = the event's result, refund without the player's blocks (${json(rr)})`, { rr, res });
        // (slice T4R-N, the final check of f7607b13's P1-2) conservation against the clean twin: a K6-recovered removal gives back the player's
        // blocks as the clean twin does (dropped, in its refund) and drops nothing extra (a cascaded instant site's attached blocks never pop as
        // items). Recorded red on f7607b13 + the T4R-N tests commit (sponge=2 missing; cascade: carpets, a door, a torch extra)
        rowLog(tag, `${mode} recovered: moved into stock and onto the ground ${json(cMoved)}; its event's refund ${json(res.refund)}; the clean twin moved ${json(tMoved)}`);
        check(G.same(minus(await stockOf(crash.owner), c0.stock), minus(await stockOf(twin.owner), t0.stock)), `${tag} ${mode}: the recovered removal credited what the clean twin credited`, { cMoved, tMoved });
        check(G.same(cMoved, tMoved), `${tag} ${mode}: conservation: the recovered removal moved what the clean twin moved (stock + ground): ${json(cMoved)} = ${json(tMoved)}`, { cMoved, tMoved });
        rowLog(tag, `${mode} recovered event: ${json(ev).slice(0, 400)}`);
        const handed = res.handedDown ?? res.handed ?? {};
        const cleanHanded = clean.handedDown ?? clean.handed ?? {};
        check(ev.length === 1, `${tag} ${mode}: one REMOVAL_FINISHED after the recovery (${ev.length})`, ev);
        check(G.same(res.refund ?? {}, clean.refund ?? {}), `${tag} ${mode}: the recovered event's refund is the clean twin's (${json(res.refund)} = ${json(clean.refund)})`, { res, clean });
        // a construction site's undo drops a player's block in its cells (PLAYER_DROP, in its refund), it never keeps it: its kept is 0 by design
        check((res.kept ?? -1) === (clean.kept ?? -2), `${tag} ${mode}: kept as the clean twin (recovered ${res.kept}, clean twin ${clean.kept}; the player's ${crash.changed.length} blocks dropped, not kept)`, { res, clean });
        check(res.restored === clean.restored && res.restored > 0, `${tag} ${mode}: restored as the clean twin (${res.restored} = ${clean.restored})`, { res, clean });
        if (mode === 'keep') {
          check(sum(handed) > 0 && sum(handed) === sum(cleanHanded) && Object.keys(handed).length === 1, `${tag} keep: a hand-down to the site on top, as the clean twin (${json(handed)} vs ${json(cleanHanded)})`, { res, clean });
          check((res.cascaded ?? []).length === 0, `${tag} keep: no cascade (${json(res.cascaded)})`, res);
        } else {
          check(json(res.cascaded ?? []) === json([crash.top]) && json(clean.cascaded ?? []) === json([twin.top]), `${tag} cascade: the site on top cascaded (${json(res.cascaded)}; twin ${json(clean.cascaded)})`, { res, clean });
        }
      }
    }
    // ------------------------------------------------------------------ slice T4R-D (GATE_TCC_PARTS=T4RD, step t4rd-crash)
    // One owner record and one owner txn per single removal; the player's blocks owed once from chunk receipts (pfound/@pgone) behind the
    // barrier, never dropped. Red on 8cc24326 (the merged head: T4R-N's per-member txns, the player's blocks dropped); green on slice/T4R.
    if (want('T4RD')) {
      const tag0 = 'T4RD';
      /** A stockpile-fed rs_hut built whole, two of its paid blocks replaced by a player's sponges ({@code placer}: a fake player's name, or the client). */
      const t4rdFixture = async (sub, placer, top = false, paidTop = false) => {
        const owner = `tcc:t4rd${sub.replace(/[^a-z]/g, '')}`;
        const pg = await pileGroup(`${tag0}-${sub}`, owner, 1);
        if (!pg) return null;
        const site = pg.g.sites[0];
        const bom = (await siteState(site))?.bom ?? {};
        await call('dev.crate.insert', { site: `stockpile:${owner}`, items: bom, exact: true }, 120_000).catch(() => null);
        await call('dev.stockpile.pause', { site, paused: false }, 60_000);
        for (let i = 0; i < 240; i++) { if ((await siteState(site))?.state === 'built') break; await L.sleep(1000); }
        const b = await boxOf(site);
        let topId = null;
        if (top && !paidTop) {
          const t = await later(`place cabin ${b[0] + 1} ${b[1] + 1} ${b[2] + 1} INSTANT unowned actor 0 force layer`, 120_000).catch((e) => ({ error: String(e) }));
          topId = t?.siteId ?? null;
        } else if (top) {
          // (T4R-N P1-1's shape) a PAID member on top: a construction site of the same owner, LAYERed on the base and built from its pile
          const t = await later(`place rs_hut ${b[0] + 1} ${b[1] + 1} ${b[2] + 1} CONSTRUCTION owned actor 0 force layer owner=${owner}`, 120_000).catch((e) => ({ error: String(e) }));
          topId = t?.siteId ?? null;
          if (topId) {
            for (let i = 0; i < 60; i++) { if ((await siteState(topId))?.state === 'building') break; await L.sleep(1000); }
            const tbom = (await siteState(topId))?.bom ?? {};
            await call('dev.crate.insert', { site: `stockpile:${owner}`, items: tbom, exact: true }, 120_000).catch(() => null);
            await call('dev.stockpile.pause', { site: topId, paused: false }, 60_000).catch(() => null);
            for (let i = 0; i < 240; i++) { if ((await siteState(topId))?.state === 'built') break; await L.sleep(1000); }
          }
          rowLog(tag0, `${sub}: paid top ${json(t).slice(0, 200)}; state ${(await siteState(topId))?.state}`);
        }
        const tb = topId ? await boxOf(topId) : null;
        const inTop = (c) => tb && c[0] >= tb[0] && c[0] <= tb[3] && c[1] >= tb[1] && c[1] <= tb[4] && c[2] >= tb[2] && c[2] <= tb[5];
        const changed = [];
        for (const [k2, st] of (await cellsOf(b)).entries()) {
          const id = String(st).replace(/\[.*$/, '');
          const full = id.includes(':') ? id : `minecraft:${id}`;
          const c = typeof k2 === 'string' ? k2.split(',').map(Number) : null;
          if (c && pg.items.includes(full) && !inTop(c) && changed.length < 2) changed.push(c);
        }
        const pl = placer ? { placer } : {};
        for (const c of changed) {
          await call('dev.pt.breaks', { at: [c], ...pl }, 60_000).catch(() => null);
          await call('dev.pt.uses', { ops: [{ item: 'minecraft:sponge', at: c, on: [c[0], c[1] - 1, c[2]], face: 'up', ...pl }] }, 60_000).catch(() => null);
        }
        await cmd(`/kill @e[type=minecraft:item,x=${b[0]},y=${b[1]},z=${b[2]},distance=..32]`).catch(() => null);
        rowLog(tag0, `${sub}: ${site} on top ${topId}; changed ${json(changed)}`);
        return { site, owner, items: pg.items, changed, top: topId, group: pg.g.group };
      };
      const owedOf = async (rcpt) => (await call('dev.stockpile.owed', { recipient: rcpt }, 30_000).catch(() => ({}))).total ?? {};
      const groundAt = async (site) => { const bb = await boxOf(site); return (await call('dev.items.near', { pos: [Math.floor((bb[0] + bb[3]) / 2), bb[1], Math.floor((bb[2] + bb[5]) / 2)], radius: 24 }, 30_000).catch(() => ({}))); };
      const reopen = async () => { await L.openWorld(name); await L.tp(...W.at); for (let i = 0; i < 30 && (await txn()).openCount !== 0; i++) await L.sleep(1000); await wait(4000); };
      const owners = async () => (await call('dev.removal.owners', {}, 30_000).catch(() => ({}))).owners ?? null;

      // T4RD-2crash (T4R-N's second-crash split, design D1a's table): the W's chunk durable, its OWE not (kill at its apply after a save), then
      // a second crash at the recovered member barrier (the OWE booked, the ledger not saved). Fed9d672: 0 or 2 sponges; T4R-D: owed exactly 2
      // (two cells), once, nothing on the ground. And the 'chunk lost' variant (kill at the apply without a save): owed 2.
      for (const [sub, first] of [['2crash', 'TX:removal.site:apply:1+save'], ['lost', 'TX:removal.site:apply:1']]) {
        const tag = `T4RD-${sub}`;
        if (!want(tag)) continue;
        const placer = (await call('dev.pt.uuid', { name: 'T4RDPlayer' }, 10_000).catch(() => ({}))).uuid;
        const f = await t4rdFixture(sub, 'T4RDPlayer');
        if (!f) continue;
        check(f.changed.length === 2, `${tag}: the fixture: two paid cells replaced by the player's sponges`, f);
        const o0 = await owedOf(placer);
        const g0 = (await groundAt(f.site)).items ?? {};
        await call('dev.journal.killAt', { point: first }, 10_000);
        api(`remove ${f.site} ${f.owner} noforce keep`).catch(() => null);
        let down = await haltWait();
        check(down, `${tag}: halted at ${first}`);
        if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); continue; }
        if (sub === '2crash') {
          // the second crash: the recovered owner txn's member barrier after its OWE (the ledger not yet saved)
          const fs = await import('node:fs');
          const arch = path.join(W.dir, 'architect');
          fs.mkdirSync(arch, { recursive: true });
          // (slice T4R-D last round, P2) the start-armed kill's proof: no old marker counts, only the one this start writes at its halt
          const point = 'TX:recover:removal.site:barrier:member';
          fs.rmSync(path.join(arch, KILL_MARKER), { force: true });
          fs.writeFileSync(path.join(arch, 'dev-start.json'), JSON.stringify({ killAt: point }));
          // the world halts during its start (the recovery runs at the load). (slice T4R-D fix round, SPD) openWorld fails as soon as the
          // headless host has no server; 5 minutes is only its bound, and the halt is the host showing no server (a fixed minute, then a
          // not-in-world check, passed while a slow start was still going and the next open found it starting)
          // (slice T4R-D narrowing round, P2-4) it counts only when it happened: the open refused (not timed out, not opened), no server
          // left, and the recovered removal.site txn still open in txn.json on disk; anything else FAILS the row
          const sc = await secondCrash({ open: () => L.openWorld(name), sleep: L.sleep, serverGone, boundMs: 300_000,
            txnOpen: () => txnOpenOnDisk(path.join(arch, 'txn.json'), 'removal.site'), marker: () => killMarker(arch), point });
          down = sc.down;
          rowLog(tag, `second crash at the recovered member barrier: ${down} (${sc.why})`);
          check(down, `${tag}: the second crash happened at the recovered member barrier (${sc.why})`, sc);
          if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); continue; }
        }
        await reopen();
        await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
        const ow = minus(await owedOf(placer), o0);
        const gr = minus((await groundAt(f.site)).items ?? {}, g0);
        const t1 = await txn();
        rowLog(tag, `owed to the placer ${json(ow)}; ground ${json(gr)}; txn open ${t1.openCount}; owners ${json(await owners())}`);
        check(ow['minecraft:sponge'] === 2, `${tag}: the player's 2 sponges owed exactly once (owed ${ow['minecraft:sponge'] ?? 0})`, { ow, gr });
        check(!gr['minecraft:sponge'], `${tag}: none dropped as an item entity (${json(gr)})`, { gr });
        check(t1.openCount === 0, `${tag}: the owner txn retired (open ${t1.openCount})`, t1);
      }

      // T4RD-cascade-R3 (T4R-N P1-1): a CASCADE pair, killed at R3a (the records pending, nothing written): one owner txn writes both after the
      // restart, nothing held for good, the player's blocks owed once
      if (want('T4RD-cascade-R3')) {
        const tag = 'T4RD-cascade-R3';
        const placer = (await call('dev.pt.uuid', { name: 'T4RDPlayer' }, 10_000).catch(() => ({}))).uuid;
        const f = await t4rdFixture('cascr', 'T4RDPlayer', true, true);
        if (f) {
          check(!!f.top && (await siteState(f.top))?.state === 'built', `${tag}: the fixture: a PAID construction site built on top (${f.top})`, f);
          const o0 = await owedOf(placer);
          await call('dev.journal.killAt', { point: 'R3a' }, 10_000);
          api(`remove ${f.site} ${f.owner} noforce cascade`).catch(() => null);
          const down = await haltWait();
          check(down, `${tag}: halted at R3a`);
          if (down) {
            await reopen();
            for (let i = 0; i < 60 && (await siteState(f.site)); i++) await L.sleep(1000);
            const t1 = await txn();
            const ow = minus(await owedOf(placer), o0);
            const ev = (await evs()).filter((e) => e.id === f.site || e.id === f.top);
            rowLog(tag, `txn ${json({ open: t1.openCount, held: t1.heldCount })}; owed ${json(ow)}; events ${json(ev).slice(0, 400)}; owners ${json(await owners())}`);
            check(t1.openCount === 0 && (t1.heldCount ?? 0) === 0, `${tag}: nothing held for good after the restart (open ${t1.openCount}, held ${t1.heldCount})`, t1);
            check(ow['minecraft:sponge'] === 2, `${tag}: the player's sponges owed exactly once (${json(ow)})`, ow);
            check(!(await siteState(f.site)) && (!f.top || !(await siteState(f.top))), `${tag}: both members removed`, f);
            check(ev.filter((e) => e.id === f.site).length === 1 && (!f.top || ev.filter((e) => e.id === f.top).length === 1), `${tag}: one REMOVAL_FINISHED per member (${ev.length})`, ev);
            check(((await owners()) ?? []).length === 0, `${tag}: the owner record forgotten (RD2)`, await owners());
          } else {
            await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
          }
        }
      }

      // T4RD-retire-collect (Steward P3-3) and T4RD-autocollect: the player's own blocks (placed by the client's player) come back into the
      // inventory after retirement (live); a kill between RD2 and the collect leaves them owed, collected once at the next join
      for (const sub of ['autocollect', 'retire-collect', 'full']) {
        const tag = `T4RD-${sub}`;
        if (!want(tag)) continue;
        const me = (await call('dev.state', {}, 10_000).catch(() => ({}))).playerUuid ?? (await call('dev.pt.uuid', { name: 'bot' }, 10_000).catch(() => ({}))).uuid;
        // the client's own name as the placer: a fake player with the client's (offline) UUID, so the recipient is online (auto-collect)
        const lst = (await cmd('/list uuids').catch(() => ({ messages: [] }))).messages ?? [];
        const myName = (/:\s*([A-Za-z0-9_]+)\s*\(/.exec(lst.join(' ')) ?? [])[1] ?? 'bot';
        const f = await t4rdFixture(sub.replace(/-/g, ''), myName);
        rowLog(tag, `placer ${myName} (${json(lst).slice(0, 120)})`);
        if (!f) continue;
        if (sub === 'full') { await cmd('/clear @s').catch(() => null); await cmd('/give @s minecraft:dirt 2304').catch(() => null); } // every main slot full: nothing fits (nothing to stack on)
        const inv0 = (await groundAt(f.site)).inventory ?? {};
        const gr0 = (await groundAt(f.site)).items ?? {};
        if (sub === 'retire-collect') await call('dev.journal.killAt', { point: 'RD2' }, 10_000);
        const r = await later(`remove ${f.site} ${f.owner} noforce keep`, 120_000).catch((e) => ({ error: String(e) }));
        if (sub === 'retire-collect') {
          const down = await haltWait();
          check(down, `${tag}: halted at RD2`);
          if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); continue; }
          const fs = await import('node:fs');
          const mid = JSON.parse(fs.readFileSync(path.join(W.dir, 'architect', 'stockpiles.json'), 'utf8'));
          const owedMid = (mid.owed?.entries ?? []).filter((e) => e.reason === 'player_blocks').map((e) => e.items);
          rowLog(tag, `on disk at the halt: player_blocks owed ${json(owedMid)}`);
          check(owedMid.some((m) => m['minecraft:sponge'] === 2), `${tag}: still owed on disk between retirement and the collect`, mid.owed);
          await reopen();
          await wait(4000);
        } else {
          await wait(3000);
        }
        const inv = minus((await groundAt(f.site)).inventory ?? {}, inv0);
        const left = Object.values((await call('dev.stockpile.owed', {}, 30_000).catch(() => ({ owed: [] }))).owed ?? []).filter((e) => e.reason === 'player_blocks' && e.key?.includes(f.site));
        const gr = minus((await groundAt(f.site)).items ?? {}, gr0);
        rowLog(tag, `result ${json(r).slice(0, 300)}; inventory gained ${json(inv)}; still owed ${json(left)}; ground ${json(gr)}`);
        check(!gr['minecraft:sponge'], `${tag}: never dropped (${json(gr)})`, gr);
        if (sub === 'full') {
          // (parent's condition on auto-collect) a full inventory: nothing given, nothing dropped, all of it stays owed
          check(!inv['minecraft:sponge'] && left.length === 1 && left[0].items?.['minecraft:sponge'] === 2, `${tag}: inventory full: the 2 sponges stay owed (${json(left)}), none given (${json(inv)})`, { inv, left });
          await cmd('/clear @s minecraft:dirt').catch(() => null);
          continue;
        }
        check(inv['minecraft:sponge'] === 2, `${tag}: the player's 2 sponges came back into the inventory exactly once (${json(inv)})`, { inv });
        check(left.length === 0, `${tag}: nothing left owed (${json(left)})`, left);
      }

      // T4RDF-group-collect (slice T4R-D fix round, P2-1): the player's own blocks in a GROUP's member come back into the inventory once the
      // group's txn retired, the player online all along (no join): auto-collect after a group's retirement, as after a single removal's.
      // Red on d004407a: only single removals auto-collected; the group's sponges stayed owed until a join or /architect collect
      if (want('T4RDF-group-collect')) {
        const tag = 'T4RDF-group-collect';
        const lst = (await cmd('/list uuids').catch(() => ({ messages: [] }))).messages ?? [];
        const myName = (/:\s*([A-Za-z0-9_]+)\s*\(/.exec(lst.join(' ')) ?? [])[1] ?? 'bot';
        const f = await t4rdFixture('groupcollect', myName);
        if (f && f.group) {
          check(f.changed.length === 2, `${tag}: the fixture: two paid cells replaced by the player's sponges`, f);
          const inv0 = (await groundAt(f.site)).inventory ?? {};
          const gr0 = (await groundAt(f.site)).items ?? {};
          const rm = await later(`sgremove ${f.group} noforce ${f.owner}`, 600_000).catch((e) => ({ error: String(e) }));
          let inv = {};
          for (let i = 0; i < 30; i++) { // bounded: 30 s after the group's removal answered; not back by then is a FAIL
            inv = minus((await groundAt(f.site)).inventory ?? {}, inv0);
            if (inv['minecraft:sponge'] === 2) break;
            await L.sleep(1000);
          }
          const left = Object.values((await call('dev.stockpile.owed', {}, 30_000).catch(() => ({ owed: [] }))).owed ?? []).filter((e) => e.reason === 'player_blocks'
            && (e.items?.['minecraft:sponge'] ?? 0) > 0 && String(e.key ?? '').includes(f.group));
          const gr = minus((await groundAt(f.site)).items ?? {}, gr0);
          rowLog(tag, `group ${f.group} removed ${json(rm).slice(0, 200)}; inventory gained ${json(inv)}; still owed ${json(left)}; ground ${json(gr)}`);
          check(!gr['minecraft:sponge'], `${tag}: never dropped (${json(gr)})`, gr);
          check(inv['minecraft:sponge'] === 2, `${tag}: the group's 2 sponges came back into the online player's inventory, once (${json(inv)})`, { inv, left });
          check(left.length === 0, `${tag}: nothing of them left owed (${json(left)})`, left);
        } else {
          check(false, `${tag}: the fixture (a one-site pile group)`, f);
        }
      }
    }
    // (T4-road, finding 3a, dropped at T4a: its precondition, a road removal's job lost to a failing queue file, can't arise since the
    // PSVLC3 merge, whose preflight confirms the job's queue write before it plans; LR-3/LR-3s cover the road's resumed job. The majority
    // rule is TxnRemovalModelT4Test's 3a; the sweep's absence rule is T4-corrupt's.)
    // T4-corrupt (finding 3b; last: it leaves the world's sites file broken): K6 on a 40% site, its sites file unreadable at the start: the
    // sweep reads the empty registry as "gone" and pays the durable stash
    if (want('T4-corrupt')) {
      const tag = 'T4-corrupt';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await partBuilt(tag, site, 0.4);
        const sf = path.join(W.dir, 'architect-sites.json');
        await k6Row(tag, [site], site, cp, items, { after: () => { fs.copyFileSync(sf, sf + '.t4keep'); fs.writeFileSync(sf, '{ not json'); } });
      }
    }
    await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
    await L.leaveWorld();
    const rows = Object.values(R);
    out.summary = { points: points.length, rows: rows.length };
    log(`  txn-crash-crate: ${json(out.summary)}`);
    spendZero();
    return out;
  };
}
