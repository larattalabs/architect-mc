// Slice SAD gate (docs/CONTRACT.md "Slice SAD: survival adoption"): a survival (Supplied) street town adopted as a region and grown
// from materials; items in = items out against the saved state at every halt. Registered into tools/gate6dgr.mjs (GR's survival town,
// growth and kill-point helpers; IG's field, cabin and growth helpers). Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs sadunit      (sad-unit)      RegionAdoptSurvivalSADTest, RegionAdoptTest; api-compat (no API change)
//   node tools/gate6dgr.mjs sadsurvival  (sad-survival)  rows 2-5 and 7: a Supplied street town in survival (one instant build; one
//                                                       construction build with a shared crate: its road and one lot BUILT, one lot still
//                                                       building) refused while the crate stands, then adopted after adoptCrates: 0 cells,
//                                                       0 journal entries, the paid records unchanged, RegionView.build survival with the
//                                                       lot building (built false, percent < 100); fed until it finishes (consumed = its
//                                                       outstanding; built, 100); grown by a plain lot and an irrigated lot (IG-b's stages),
//                                                       fed partly, halted with nothing saved, the reconcile at the restart, fed the rest:
//                                                       consumed since the saved baseline = the quote; the growth's undo halted at RVU2 with
//                                                       nothing saved, resumed: E-flat 0, no water, back = what the saved ledger says it
//                                                       consumed; Regions.remove: E-flat 0 against the world before the settlement, the paid
//                                                       records refunded item for item
//   node tools/gate6dgr.mjs sadcrash     (sad-crash)     row 6: the adoption halted with nothing saved at AD3 (the journal write: rolled
//                                                       back) and at AD4 (the sites file moved: rolled forward); memberships agree; stock,
//                                                       paid records and returned equal the saved ledger's; the building lot then builds
//                                                       from the stockpile; Regions.remove exact
//   node tools/gate6dgr.mjs sadinstant   (sad-instant)   row 6b: an all-instant street town adopted in survival, grown by a plain lot from
//                                                       materials (consumed = quote), the growth undone (refund = consumed); the instant lots
//                                                       stand and refund nothing; Regions.remove E-flat 0
//   node tools/gate6dgr.mjs adpdefer|adpforward|adpcomplete|adproad (adp-*)  slice ADP: adoptCrates and its crates (the ADP block at the end)
//
// Evidence: artifacts/gate6d-gr/<step>.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function registerSAD(steps, h) {
  const { L, call, check, cmd, log, OUT, json, G, ensure, spendZero, groundY, BOXOF, CX, CZ, growPlan, rvState, rvWait, root, cellsOf, diff, haltWait, removeRegion, ig } = h;
  const ctx = { L, OUT, KIT: path.join(root, 'kit'), imp: h.imp };
  // (BC-c) row 4's growth realises under a maxBill (its quote); every halt's restart reads the cap back
  const caps = (await import('./gatebcc.mjs')).bccCaps({ call, check, json, G, owner: G.OWNER, log });
  const OWNER = G.OWNER;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const pile = async () => (await call('dev.stockpile.state', { owner: OWNER }, 60_000)).stockpile ?? {};
  const savedNow = async () => call('dev.stockpile.saved', { owner: OWNER }, 60_000);
  const ledgerOf = (rootJ) => (rootJ?.stockpiles ?? []).find((p) => p.owner === OWNER)?.ledger ?? null;
  const paidSum = (l) => Object.values(l?.paid ?? {}).reduce((a, m) => G.plus(a, m), {});
  function stockOf(l) {
    const o = {};
    for (const k of new Set([...Object.keys(l?.delivered ?? {}), ...Object.keys(l?.returned ?? {})])) {
      const s = (l.delivered?.[k] ?? 0) + (l.returned?.[k] ?? 0) - (l.consumed?.[k] ?? 0) - (l.withdrawn?.[k] ?? 0) - (l.dropped?.[k] ?? 0);
      if (s) o[k] = s;
    }
    return o;
  }
  const backOf = (l) => G.plus(stockOf(l), l?.refundOverflow ?? {});
  const siteState = (id) => call('dev.site.state', { site: id }, 60_000);
  const api = async (args) => {
    const r = await cmd(`/apitest ${args}`);
    const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
    if (line === undefined) throw new Error(`/apitest ${args.slice(0, 120)}: no JSON answer: ${JSON.stringify(r).slice(0, 400)}`);
    return JSON.parse(line);
  };
  const later = async (args, timeoutMs = 600_000) => {
    const pd = await api(args);
    if (!pd?.pending) return pd;
    for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(500)) {
      const r = await api(`get ${pd.pending}`);
      if (r && r.value !== undefined && r.value !== null) return r.value;
    }
    throw new Error(`no result for ${pd.pending}`);
  };
  const isBlock = async ([x, y, z], block) => { const r = await L.cmd(`/execute if block ${x} ${y} ${z} ${block}`); return !!(r?.success || Number(r?.result) > 0); };
  const pause = (site, paused) => call('dev.stockpile.pause', { site, paused }, 60_000);
  const rs = (region) => call('dev.rs.state', { region }, 120_000);
  const LOT = { sx: 15, sz: 17 };
  // the settlement's box (AD's claim) and the world box judged for E-flat; the crates stand outside both
  const TCLAIM = [CX, CZ, CX + 160, CZ + 96];
  const BOX = (gy) => BOXOF(TCLAIM, gy);
  const PILE_AT = (gy) => [0, 1, 2, 3].map((k) => [CX - 30 + 2 * k, gy + 1, CZ - 30]);
  const CRATE_AT = (gy) => [CX - 30, gy + 1, CZ - 24];

  function apiCompat() {
    const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` };
    const J = h.apiJars();
    return [...J.jars.map((j) => ['tools/api-compat.mjs', j]), ['tools/api-compat.mjs', '--surface', J.surface]].map((args) => {
      const ac = fs.existsSync(args.at(-1)) ? spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 900_000, env }) : { status: -1, stdout: `missing ${args.at(-1)}`, stderr: '' };
      return { args: args.slice(1).map((a) => path.basename(a)), code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter(Boolean).slice(-3) };
    });
  }

  steps.sadunit = async () => {
    const out = {};
    out.java = await h.javaTests(['*RegionAdoptSurvivalSADTest*', '*RegionAdoptTest*', '*StockpileAdoptSADTest*', '*StockpileRepairSADTest*', '*StockpileLegacyJRbTest*'], 12);
    check(out.java.ok, `RegionAdoptSurvivalSADTest (a construction site adopts in survival only, never with a live crate, a building one needs the stockpile; a joined shared-crate group adopts; the region is survival exactly when the world is) RegionAdoptTest, StockpileAdoptSADTest (a joined crate credited once across a save), StockpileRepairSADTest (the start's repair names nothing on an ordinary world), StockpileLegacyJRbTest: ${out.java.tests} tests, ${out.java.failures} failures`, out.java.tail);
    out.apicompat = apiCompat();
    check(out.apicompat.every((a) => a.code === 0), 'api-compat: binary compatible (SAD changes no API type)', out.apicompat);
    spendZero();
    return out;
  };

  /** A fresh survival world (G.SURV's copy), the owner's cabin entry and RS's designs installed: {gy, dir}. */
  async function world(name) {
    await G.survivalBase(ctx);
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await cmd('/op @s').catch(() => null);
    await G.designs(ctx);
    await L.tp(CX + 80, 80, CZ + 48);
    const gy = await groundY(CX + 4, CZ + 4);
    return { gy, dir: path.join(L.SAVES, name) };
  }

  /** The town's lot layout (AD's: 15 x 17, alternating north and south of the street, lotGap 3): 4 lots, the street's line. */
  function layout(gy) {
    const sz = CZ + 48;
    const lots = [];
    let xn = CX + 12, xs = CX + 12;
    for (let i = 0; i < 4; i++) {
      const north = i % 2 === 0;
      const x = north ? xn : xs;
      lots.push({ id: `house_${i + 1}`, x, z: north ? sz - 3 - LOT.sz + 1 : sz + 3, sx: LOT.sx, sz: LOT.sz, north });
      if (north) xn = x + LOT.sx + 3; else xs = x + LOT.sx + 3;
    }
    const x0 = Math.min(...lots.map((l) => l.x)), x1 = Math.max(...lots.map((l) => l.x + l.sx - 1));
    const xm = lots[1].x + LOT.sx; // the first two lots' end: street | street#2
    return { sz, lots, x0, x1, xm, y: gy + 1 };
  }

  /** One Steward build through dev.ad.settlement; instant builds with the survival toggle off (no actor needed), construction ones on. */
  async function build(T, entry, lots, spans, b, { keys, construction = false, sharedCrate = false, crateAt = null, waitDone = true } = {}) {
    if (!construction) await call('dev.survival.set', { on: false });
    const q = await call('dev.ad.settlement', { owner: OWNER, entry, streetZ: T.sz, y: T.y, lots, spans, settlement: 'sad', build: b, ...(keys ? { keys } : {}),
      ...(construction ? { mode: 'construction', sharedCrate, ...(crateAt ? { crateAt } : {}) } : {}) }, 120_000);
    if (q.refused) { if (!construction) await call('dev.survival.set', { on: true }); throw new Error(`build ${b} was refused: ${q.refused}`); }
    const t0 = Date.now();
    let bt;
    for (; Date.now() - t0 < 900_000;) {
      bt = await call('dev.ad.batch', { batchId: q.batchId }, 10_000);
      if (['DONE', 'CANCELLED', 'FAILED'].includes(bt.status) || (!waitDone && bt.items.every((i) => i.site))) break;
      await sleep(L.pollDelayMs(Date.now() - t0));
    }
    // (the toggle back on only once every item is put down: an instant item put down in a survival world needs an actor)
    if (!construction) await call('dev.survival.set', { on: true });
    const ids = Object.fromEntries(bt.items.map((i) => [i.key, i.site]));
    check(bt.items.every((i) => i.site && i.status !== 'FAILED'), `build ${b} (${construction ? 'from materials' : 'instant'}): ${bt.items.length} items put down in group ${bt.group}: ${json(bt.items.map((i) => [i.key, i.status, i.reason ?? '']))}`);
    return { ids, group: bt.group, batchId: q.batchId };
  }

  /** Inserts a construction target's missing items into its crate (or the stockpile), `share` of each (1 = all). */
  async function feedSite(site, share = 1, into = null) {
    const s = await siteState(site);
    const want = Object.fromEntries((s.rows ?? []).map((r) => [r.item, share >= 1 ? r.missing : Math.ceil(r.missing * share)]).filter(([, n]) => n > 0));
    if (!Object.keys(want).length) return {};
    return (await call('dev.crate.insert', { site: into ?? site, items: want, exact: true }, 120_000)).accepted ?? {};
  }
  async function builtWait(site, timeoutMs = 900_000) {
    const t0 = Date.now();
    let s;
    for (; Date.now() - t0 < timeoutMs;) { s = await siteState(site); if (s.state === 'BUILT' || s.state === 'built') return s; await sleep(2000); }
    return s;
  }
  /** Feeds the stockpile what its fed targets still lack until `done()` (the stockpile's own targets, no region needed). */
  async function feedPile(done, timeoutMs = 1_800_000) {
    const t0 = Date.now();
    for (; Date.now() - t0 < timeoutMs;) {
      if (await done()) return true;
      const ps = await pile();
      const need = {};
      for (const [it, n] of Object.entries(ps.outstanding ?? {})) { const lack = n - (ps.stock?.[it] ?? 0); if (lack > 0) need[it] = lack; }
      if (Object.keys(need).length) await call('dev.crate.insert', { site: `stockpile:${OWNER}`, items: need, exact: true }, 120_000);
      await sleep(2500);
    }
    return false;
  }

  /** The adoption request of the town (both street pieces, the four lots). */
  const adoptReq = (T, ids) => ({ owner: OWNER, claim: TCLAIM, geometry: { streetZ: T.sz, xLo: T.x0, xHi: T.x1 }, roads: [ids.street, ids['street#2']],
    lots: Object.fromEntries(T.lots.map((l) => [l.id, ids[l.id]])) });

  /** The saved baseline: /save-all flush, PS's periodic save off (the crash window), the saved file's ledger and save count. */
  async function baseline(tag) {
    await cmd('/save-all flush').catch(() => null);
    await call('dev.wait', { ms: 2000 }, 30_000);
    const ps = await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
    const s = await savedNow();
    const live = await pile();
    const l = ledgerOf(s.file);
    check(l && G.same(l.consumed, live.ledger?.consumed) && G.same(l.delivered, live.ledger?.delivered) && ps.noPeriodic === true,
      `${tag}: the baseline: the ledger saved by /save-all flush equals the live one (save #${s.saves}); PS's periodic save off for the window`, { saved: l, live: live.ledger });
    return { ledger: l, saves: s.saves };
  }
  /** The halt (a kill point armed by `arm`, or dev.stockpile.halt), the saved ledger read off the disk, the world reopened. */
  async function halt(tag, W, b0, go, { savedByOp = false } = {}) {
    const s1 = await savedNow();
    check(s1.saves === b0.saves, `${tag}: nothing saved the ledger between the baseline and the halt's operation (save #${b0.saves} -> #${s1.saves})${savedByOp ? '; the operation saves it once before its kill point' : ''}`);
    go();
    const down = await haltWait();
    check(down, `${tag}: the server halted with nothing saved`);
    if (!down) return null;
    const Ld = ledgerOf(JSON.parse(fs.readFileSync(path.join(W.dir, 'architect', 'stockpiles.json'), 'utf8')));
    await L.openWorld(path.basename(W.dir));
    await L.tp(CX + 80, 80, CZ + 48);
    await sleep(3000);
    await caps.afterRestart(tag); // (BC-c) the reconcile inside the growth's maxBill
    return Ld;
  }

  /**
   * The Supplied town: build b1 instant (street, street#2, house_1, house_2), build b2 from materials with a shared crate (house_3,
   * house_4); house_3 fed to BUILT, house_4 a third fed and paused (still building). `pileFirst` makes the stockpile before
   * b2 (no crate: b2 draws from it).
   */
  async function suppliedTown(tag, W, { pileFirst = false, own = false } = {}) {
    const T = layout(W.gy);
    const B0 = await cellsOf(BOX(W.gy));
    const entry = await ig.installCabin('sad_cabin');
    if (pileFirst) {
      const cr = await call('dev.stockpile.create', { owner: OWNER, crates: PILE_AT(W.gy) }, 120_000);
      check(!cr.refused, `${tag}: a stockpile of 4 crates for ${OWNER} (before build b2: it draws from it)`);
    }
    const [l1, l2, l3, l4] = T.lots;
    // (the street pieces are instant: a construction road reports no material rows to feed it by; b2's lots share one crate)
    const b1 = await build(T, entry, [l1, l2], [[T.x0, T.xm], [T.xm + 1, T.x1]], 'b1');
    // (ADP) own: each lot of b2 with its own crate (no shared crate)
    const b2 = await build(T, entry, [l3, l4], [], 'b2', { construction: true, sharedCrate: !pileFirst && !own, crateAt: pileFirst || own ? null : CRATE_AT(W.gy), waitDone: false });
    const ids = { ...b1.ids, ...b2.ids };
    await pause(ids.house_4, true);
    const s4 = await siteState(ids.house_4);
    check(!!s4.state && s4.state !== 'instant' && (pileFirst || s4.crate?.present === true), `${tag}: house_4 is a construction site (${s4.state}, ${pileFirst ? 'from the stockpile' : `the shared crate ${json(s4.crate)}`}), paused`, s4);
    // house_3 fed to BUILT
    for (const id of [ids.house_3]) {
      // (its own rows only: the stockpile's outstanding also lists the paused house_4)
      for (let i = 0; i < 6; i++) { await feedSite(id, 1, pileFirst ? `stockpile:${OWNER}` : null); const s = await siteState(id); if (['BUILT', 'built'].includes(s.state)) break; await sleep(5000); }
      const s = await builtWait(id);
      check(['BUILT', 'built'].includes(s.state), `${tag}: house_3 built from materials (${s.state}, ${s.built}/${s.queue})`);
    }
    // house_4: a third fed, then paused again while still building
    await pause(ids.house_4, false);
    if (pileFirst) {
      const s = await siteState(ids.house_4);
      const third = Object.fromEntries((s.rows ?? []).map((r) => [r.item, Math.ceil(r.missing / 3)]).filter(([, n]) => n > 0));
      await call('dev.crate.insert', { site: `stockpile:${OWNER}`, items: third, exact: true }, 120_000);
    } else await feedSite(ids.house_4, 1 / 3);
    let s;
    for (let i = 0; i < 60; i++) { s = await siteState(ids.house_4); if (s.built > 0 && i >= 10) break; await sleep(2000); }
    await pause(ids.house_4, true);
    s = await siteState(ids.house_4);
    check(s.built > 0 && s.built < s.queue && !['BUILT', 'built'].includes(s.state), `${tag}: house_4 part built and still building (${s.built}/${s.queue}, ${s.state}), paused`, s);
    return { T, ids, B0, entry, b1, b2 };
  }

  steps.sadsurvival = async () => {
    await ensure();
    const out = {};
    const W = await world('G6B SAD Survival');
    const { T, ids, B0, b1, b2 } = await suppliedTown('town', W);
    const req = adoptReq(T, ids);
    // the crate still stands: refused before anything is written
    const S_pre = await cellsOf(BOX(W.gy));
    const r0 = await call('dev.ad.adopt', req, 900_000);
    out.refusedLive = r0.refused ?? null;
    check(String(r0.refused ?? '').startsWith('NOT_ALLOWED') && /adoptCrates/.test(r0.refused), `row 2: Regions.adopt with the shared crate standing refused (${r0.refused})`);
    check(diff(S_pre, await cellsOf(BOX(W.gy))).n === 0, 'row 2: the refused adoption wrote nothing');
    // the stockpile, the crates joined (adoptCrates), then the adoption
    const cr = await call('dev.stockpile.create', { owner: OWNER, crates: PILE_AT(W.gy) }, 120_000);
    check(!cr.refused, `row 2: a stockpile of 4 crates for ${OWNER}`);
    // (coordinator) adoptCrates halted before its save (kill SAC1: the crates joined in memory, their cells restored, nothing saved):
    // the restart has the crate standing with its own ledger, and the stockpile as saved
    const bS = await baseline('SAC1');
    const crate0 = await siteState(ids.house_4);
    await call('dev.journal.killAt', { point: 'SAC1' }, 10_000);
    const LdS = await halt('SAC1', W, bS, () => call('dev.stockpile.adopt', { owner: OWNER }, 120_000).catch(() => null));
    if (LdS) {
      const la = (await pile()).ledger ?? {};
      const c1 = await siteState(ids.house_4);
      out.sac1 = { crate: [crate0.crate, c1.crate], crateLedger: [crate0.ledger, c1.ledger], stock: [stockOf(LdS), stockOf(la)] };
      check(c1.crate?.present === true && G.same(c1.ledger?.stock, crate0.ledger?.stock) && G.same(c1.ledger?.placed, crate0.ledger?.placed) && G.same(stockOf(LdS), stockOf(la))
        && json(LdS.paid ?? {}) === json(la.paid ?? {}), `SAC1: after the unclean restart the shared crate stands with its ledger as before (stock ${sum(c1.ledger?.stock)}, placed ${sum(c1.ledger?.placed)}), the stockpile and its paid records as saved: no mint, no loss`, out.sac1);
    }
    const p0 = await pile();
    const crateBefore = await siteState(ids.house_4);
    // SAC2: halted between adoptCrates' two saves (the ledger joined and saved with the world; the groups' crates cleared, the sites' crate
    // references not yet): the restart has the stock and the records as saved; the next adoptCrates repairs the references, crediting nothing twice
    const bS2 = await baseline('SAC2');
    await call('dev.journal.killAt', { point: 'SAC2' }, 10_000);
    const Ld2 = await halt('SAC2', W, bS2, () => call('dev.stockpile.adopt', { owner: OWNER }, 120_000).catch(() => null), { savedByOp: true });
    let la2 = null;
    if (Ld2) {
      la2 = (await pile()).ledger ?? {};
      const moved2 = G.plus(G.minus(stockOf(Ld2), stockOf(p0.ledger)), G.minus(Ld2.dropped ?? {}, p0.ledger?.dropped ?? {}));
      out.sac2 = { moved: moved2, crateStock: crateBefore.ledger?.stock, records: Object.keys(Ld2.paid ?? {}), sameAsSaved: json(Ld2) === json(la2) };
      check(json(Ld2.paid ?? {}) === json(la2.paid ?? {}) && G.same(stockOf(Ld2), stockOf(la2)) && G.same(moved2, crateBefore.ledger?.stock ?? {})
        && Object.keys(Ld2.paid ?? {}).some((k) => k.startsWith(`site:${ids.house_3}@`)), `SAC2: after the unclean restart the stockpile holds the crate's stock once (${json(moved2)}) and the keyed records (${Object.keys(Ld2.paid ?? {}).length}) as saved`, out.sac2);
      // the world's start repaired the references before any reader: no crate-fed path is left to double-spend the joined crate
      const s3w = await siteState(ids.house_3);
      const s4w = await siteState(ids.house_4);
      const ow = (await pile()).feedOrder ?? [];
      out.sac2.atStart = { s3: s3w.crate, s4: s4w.crate, order: ow };
      check(s3w.crate?.x === undefined && s4w.crate?.x === undefined && ow.includes(ids.house_4) && !ow.includes(ids.house_3),
        `SAC2: the world's start cleared both crate references (the ledger had joined that crate) before any feed, refund or undo; house_4 in the feed order, house_3 not (${json(ow)})`, out.sac2.atStart);
    }
    const ac = await call('dev.stockpile.adopt', { owner: OWNER }, 120_000);
    check(!ac.refused, `row 2: adoptCrates joined the shared crate to the stockpile (${json(ac.refused ?? 'joined')})`);
    const p1 = await pile();
    if (la2) {
      const s3r = await siteState(ids.house_3);
      const s4r = await siteState(ids.house_4);
      check(json(p1.ledger?.paid ?? {}) === json(la2.paid ?? {}) && G.same(stockOf(p1.ledger), stockOf(la2)) && s3r.crate?.x === undefined && s4r.crate?.x === undefined,
        'SAC2: a later adoptCrates credits nothing twice (records and stock unchanged; both references clear)', { s3: s3r.crate, s4: s4r.crate });
    }
    // (no adoption yet: an older survival world's crate) the crate's stock moved once: into the stock, or dropped
    {
      const moved = G.plus(G.minus(stockOf(p1.ledger), stockOf(p0.ledger)), G.minus(p1.ledger?.dropped ?? {}, p0.ledger?.dropped ?? {}));
      out.leftover = { crateStock: crateBefore.ledger?.stock, moved };
      check(G.same(moved, crateBefore.ledger?.stock ?? {}), `the crate's leftover stock moved into the stockpile exactly once (stocked or dropped: ${json(moved)}; the crate held ${json(crateBefore.ledger?.stock)})`, out.leftover);
      const f1 = await savedNow();
      const ac2 = await call('dev.stockpile.adopt', { owner: OWNER }, 120_000);
      const p1b = await pile();
      const f2 = await savedNow();
      const o1 = (await pile()).feedOrder ?? [];
      out.again = { refused: ac2.refused ?? null, same: json(p1.ledger) === json(p1b.ledger), saved: json(ledgerOf(f1.file)) === json(ledgerOf(f2.file)) };
      check(!ac2.refused && json(p1.ledger) === json(p1b.ledger) && json(ledgerOf(f1.file)) === json(ledgerOf(f2.file)) && json(p1.stock) === json(p1b.stock) && o1.includes(ids.house_4),
        'adoptCrates a second time is a no-op: the ledger, its paid records and the stock equal, the saved ledger byte-equal, the feed order unchanged', out.again);
    }
    // (amendment 1) the BUILT house_3 on the shared crate: a paid record within its paid standing, its crate reference cleared, no feed
    const rec3 = Object.entries(p1.ledger?.paid ?? {}).find(([k]) => k.startsWith(`site:${ids.house_3}@`));
    const s3 = await siteState(ids.house_3);
    const order = (await pile()).feedOrder ?? [];
    out.built3 = { record: rec3, crate: s3.crate, order, placedOnCrate: crate0.ledger?.placed };
    check(!!rec3 && sum(rec3[1]) > 0 && s3.crate?.present === false && s3.crate?.x === undefined && !order.includes(ids.house_3) && order.includes(ids.house_4),
      `amendment 1: the BUILT house_3 got a paid record from the shared crate (${rec3 ? sum(rec3[1]) : 0} units), its crate reference cleared, and it joins no feed (feed order ${json(order)})`, out.built3);
    const keyedAll = Object.values(p1.ledger?.paid ?? {}).reduce((a, m) => G.plus(a, m), {});
    check(Object.entries(keyedAll).every(([k, v]) => v <= (crate0.ledger?.placed?.[k] ?? 0)), `amendment 1: the records keyed from the crate stay within its placed counts (capped): ${json(G.minus(crate0.ledger?.placed, keyedAll))} left unkeyed`);
    const S1 = await cellsOf(BOX(W.gy));
    const sites = Object.values(ids);
    const st0 = await call('dev.ad.state', { sites }, 60_000);
    const a = await call('dev.ad.adopt', req, 900_000);
    check(!a.refused && a.state === 'PLACED', `row 2: Regions.adopt of the Supplied town (2 instant lots, 2 lots from materials, one building; 2 street pieces): ${a.region} ${a.state ?? a.refused}`);
    if (a.refused) { await L.leaveWorld(); spendZero(); return out; }
    const region = a.region;
    const st1 = await call('dev.ad.state', { sites }, 60_000);
    const d1 = diff(S1, await cellsOf(BOX(W.gy)));
    const p2 = await pile();
    const b = (await rs(region)).build;
    out.adopt = { region, entries: [st0.entries, st1.entries], agree: st1.agree, cells: d1.n, paid: [paidSum(p1.ledger), paidSum(p2.ledger)], build: b };
    check(d1.n === 0 && st1.entries === st0.entries && st1.agree !== false, `row 2: the adoption wrote no cell (${d1.n} differ) and no journal entry (${st0.entries} -> ${st1.entries}); memberships agree (${st1.agree})`, d1.first);
    check(G.same(p1.ledger?.paid ? paidSum(p1.ledger) : {}, paidSum(p2.ledger)) && json(p1.ledger?.paid) === json(p2.ledger?.paid), `row 2: the paid records unchanged by the adoption (${Object.keys(p2.ledger?.paid ?? {}).length} records, ${sum(paidSum(p2.ledger))} units)`);
    check(!!b && b.built === false && b.percent < 100, `row 2 (S-SAD-2): RegionView.build of the adopted region is survival and counts the building lot: built ${b?.built}, percent ${b?.percent}`, b);
    // row 3: the building lot fed to BUILT under the region's group
    await pause(ids.house_4, false);
    const c3 = p2.ledger?.consumed ?? {};
    const out3 = p2.outstanding ?? {};
    const ok3 = await feedPile(async () => ['BUILT', 'built'].includes((await siteState(ids.house_4)).state));
    const p3 = await pile();
    const b3 = (await rs(region)).build;
    const used3 = G.minus(p3.ledger?.consumed ?? {}, c3);
    out.finish = { ok: ok3, outstanding: out3, consumed: used3, build: b3 };
    check(ok3 && G.same(used3, out3), `row 3: house_4 built from the stockpile under the region's group: consumed ${json(used3)} = its outstanding at the adoption ${json(out3)}`, out.finish);
    check(b3?.built === true && b3?.percent === 100, `row 3 (S-SAD-2): RegionView.build then reads built ${b3?.built}, percent ${b3?.percent}`, b3);
    // row 4: a growth by a plain lot and an irrigated lot (IG-b's stages), fed partly, halted unsaved, reconciled, fed the rest
    const bp = await ig.installField();
    const plain = { id: 'hb', type: 'house', size: [9, 9], villager: 'dwelling' };
    const g = await growPlan(region, { lots: [ig.FARM, plain] });
    check(!g.refused && g.revisionOf?.rid >= 1 && json(g.stages) === json(['adopted', 'street', 'lots', 'props', 'fluids']), `row 4: the survival growth planned (planned in survival, a survival region: no NOT_ALLOWED): ${g.refused ?? `${g.planId} rid ${g.revisionOf?.rid}, stages ${json(g.stages)}`}`);
    if (g.refused) { await L.leaveWorld(); spendZero(); return out; }
    const lot = (g.lots ?? []).find((l) => l.id === ig.FARM.id);
    const P = { g, lot, irr: lot?.ext?.['architect_mc:lotIrrigation'] };
    const entries = { [ig.FARM.id]: ig.FIELD, hb: 'rs_hut' };
    const q = await call('dev.region.quote', { planId: g.planId, lotEntries: entries }, 300_000);
    check(!q.refused && q.survival === true && sum(q.bom) > 0, `row 4: the growth quoted in survival: ${sum(q.bom)} units, exact ${q.exact}`, q.bom);
    const S0 = await cellsOf(BOX(W.gy));
    const c0 = (await pile()).ledger?.consumed ?? {};
    const r = await call('dev.region.realise', { planId: g.planId, lots: entries, maxBill: q.bom }, 300_000); // (BC-c) under its quote
    check(!r.refused, `row 4: the growth realised under its quote as maxBill: ${r.refused ?? r.region}`);
    await caps.track(region);
    for (let i = 0; i < 90; i++) { if (sum((await pile()).outstanding) > 0) break; await sleep(2000); }
    const b4 = await baseline('row 4');
    const ps = await pile();
    const half = {};
    for (const [it, n] of Object.entries(ps.outstanding ?? {})) { const lack = n - (ps.stock?.[it] ?? 0); if (lack > 1) half[it] = Math.floor(lack / 2); }
    await call('dev.crate.insert', { site: `stockpile:${OWNER}`, items: half, exact: true }, 120_000);
    await sleep(15_000);
    const live4 = await pile();
    const Ld4 = await halt('row 4', W, b4, () => call('dev.stockpile.halt', { mode: 'now' }, 10_000).catch(() => null));
    if (Ld4) {
      out.grow = { fedLive: G.minus(live4.ledger?.consumed, b4.ledger.consumed), savedConsumed: G.minus(Ld4.consumed, b4.ledger.consumed) };
      const f = await G.feed({ L }, region, { fraction: 1, timeoutMs: 2_400_000, every: 2500 });
      const w = await rvWait(region, g.revisionOf.rid, 1_800_000);
      check(w.r.state === 'PLACED' && f.last.rs.build?.done, `row 4: after the unclean restart, fed the rest (${f.waves} waves): the growth ${w.r.state}`);
      out.grow.placed = await ig.placedChecks(region, P, bp, 'row 4');
      const p4 = await pile();
      const paid = G.minus(p4.ledger?.consumed ?? {}, c0);
      const audit = await call('dev.stockpile.audit', { owner: OWNER }, 120_000);
      out.grow.consumed = paid;
      out.grow.quote = q.bom;
      out.grow.identity = audit.identity;
      check(G.same(paid, q.bom) && audit.identity !== false, `row 4: consumed since the saved baseline equals the quote item for item, across the partial feed, the unsaved halt (live ${sum(out.grow.fedLive)} units fed, ${sum(out.grow.savedConsumed)} in the saved ledger) and the reconcile: quote ${json(q.bom)}, consumed ${json(paid)}; identity ${audit.identity}`, { diff: G.minus(paid, q.bom) });
      // row 5: the growth's undo halted at RVU2 with nothing saved
      const b5 = await baseline('row 5');
      await call('dev.journal.killAt', { point: 'RVU2' }, 10_000);
      const Ld5 = await halt('row 5', W, b5, () => call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000).catch(() => null));
      if (Ld5) {
        let s;
        const t0 = Date.now();
        for (; Date.now() - t0 < 1_800_000;) { s = await rvState(region); if (s.busy === null) break; await sleep(L.pollDelayMs(Date.now() - t0)); }
        await L.settle(3000);
        const La = (await pile()).ledger ?? {};
        const back = G.minus(backOf(La), backOf(Ld5));
        const consumedSaved = G.minus(Ld5.consumed, c0);
        const d = diff(S0, await cellsOf(BOX(W.gy)));
        const water = await ig.waterIn(BOX(W.gy));
        out.undo = { position: s?.position, states: s?.revisions?.map((x) => [x.rid, x.state]), diff: d.n, water: water.length, back, consumedSaved };
        check(s?.busy === null && s?.position === 0 && d.n === 0 && water.length === 0, `row 5: the undo halted at RVU2 (nothing saved) resumed: position ${s?.position}, E-flat ${d.n} over the growth, no water (${water.length})`, d.first);
        check(G.same(back, consumedSaved) && G.same(consumedSaved, q.bom), `row 5: items in = items out against the saved state: back ${json(back)} = what the saved ledger says the growth consumed ${json(consumedSaved)} (= the quote)`, { mint: G.minus(back, consumedSaved) });
      }
    }
    // (amendment 1) the BUILT house_3 removed alone after the adoption: its refund comes out of the stockpile within its record
    {
      const q3 = await pile();
      const r3 = Object.entries(q3.ledger?.paid ?? {}).find(([k]) => k.startsWith(`site:${ids.house_3}@`));
      await call('dev.sites.remove', { site: ids.house_3, force: true }, 600_000);
      for (let i = 0; i < 120; i++) { const sv = await call('dev.sites.state', {}, 30_000); if (!JSON.stringify(sv.sites ?? []).includes(`"${ids.house_3}"`)) break; await sleep(1000); }
      await L.settle(3000);
      const q4 = await pile();
      const back3 = G.minus(backOf(q4.ledger), backOf(q3.ledger));
      const left = Object.entries(q4.ledger?.paid ?? {}).find(([k]) => k.startsWith(`site:${ids.house_3}@`));
      out.remove3 = { record: r3?.[1], back: back3, left: left?.[1] ?? null };
      check(!!r3 && G.same(back3, r3[1]) && !left, `amendment 1: house_3 removed after the adoption refunded its record from the stockpile, item for item (${sum(back3)} units = record ${sum(r3?.[1])}), the record spent`, out.remove3);
    }
    // row 7: Regions.remove: E-flat 0 against the world before the settlement; every paid record refunded
    const pr = await pile();
    const paidBefore = paidSum(pr.ledger);
    const rmr = await removeRegion(region, OWNER);
    const pa = await pile();
    const back7 = G.minus(backOf(pa.ledger), backOf(pr.ledger));
    const d7 = diff(B0, await cellsOf(BOX(W.gy)));
    out.remove = { removed: rmr?.removed ?? rmr, diff: d7.n, paid: paidBefore, back: back7, paidAfter: paidSum(pa.ledger) };
    check(rmr?.removed === true && d7.n === 0, `row 7: Regions.remove of the adopted town: E-flat ${d7.n} against the world before the settlement`, d7.first);
    check(G.same(back7, paidBefore) && sum(back7) > 0, `row 7: the refund equals every paid record of the town item for item: back ${json(back7)}, paid ${json(paidBefore)} (the instant lots refund nothing)`, out.remove);
    await L.leaveWorld();
    spendZero();
    return out;
  };

  steps.sadcrash = async () => {
    await ensure();
    const out = {};
    const W = await world('G6B SAD Crash');
    const { T, ids, B0, b1, b2 } = await suppliedTown('crash', W);
    const req = adoptReq(T, ids);
    const cr = await call('dev.stockpile.create', { owner: OWNER, crates: PILE_AT(W.gy) }, 120_000);
    const ac = await call('dev.stockpile.adopt', { owner: OWNER }, 120_000);
    check(!cr.refused && !ac.refused, `crash: the stockpile made and the shared crate joined (adoptCrates): ${json(cr.refused ?? ac.refused ?? 'ok')}`);
    const sites = Object.values(ids);
    let region = null;
    // a clean save, leave and reopen first: a load compacts the journal's index (the entry count drops at the first reopen of a world that
    // built from materials), so the crash cases compare loads with loads
    await cmd('/save-all flush').catch(() => null);
    await L.leaveWorld();
    await L.openWorld(path.basename(W.dir));
    await L.tp(CX + 80, 80, CZ + 48);
    await sleep(3000);
    for (const point of ['AD3', 'AD4']) {
      const b0 = await baseline(point);
      const before = await call('dev.ad.state', { sites }, 60_000);
      await call('dev.journal.killAt', { point }, 10_000);
      const Ld = await halt(point, W, b0, () => call('dev.ad.adopt', req, 900_000).catch(() => null));
      if (!Ld) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); continue; }
      const st = await call('dev.ad.state', { sites }, 60_000);
      const la = (await pile()).ledger ?? {};
      const regions = (await call('dev.region.list', {}, 60_000).catch(() => ({}))).regions ?? [];
      const adopted = regions.filter((x) => x.ext?.['architect_mc:adopted'] && x.state !== 'REMOVED');
      const fwd = point === 'AD4';
      out[point] = { agree: st.agree, intents: st.intents, regions: adopted.map((x) => [x.id, x.state]), entries: [before.entries, st.entries],
        stock: [stockOf(Ld), stockOf(la)], paid: [paidSum(Ld), paidSum(la)], returned: [Ld.returned, la.returned] };
      out[point].nextId = [before.nextId, st.nextId];
      check(st.agree !== false && (st.intents ?? []).length === 0 && st.entries === before.entries && st.nextId === before.nextId, `${point}: after the unclean restart the adoption recovered (no intent left), every membership agrees (${st.agree}), no journal entry written (${before.entries} -> ${st.entries} entries, next id ${before.nextId} -> ${st.nextId})`, out[point]);
      check(fwd ? adopted.length === 1 && adopted[0].state === 'PLACED' : adopted.length === 0, `${point}: ${fwd ? 'rolled forward: one adopted region PLACED' : 'rolled back: no region'} (${json(out[point].regions)})`);
      check(G.same(stockOf(Ld), stockOf(la)) && json(Ld.paid) === json(la.paid) && G.same(Ld.returned, la.returned) && G.same(Ld.consumed, la.consumed),
        `${point}: items in = items out against the saved state: stock, every paid record, consumed and returned as the saved ledger has them (no mint, no loss)`, out[point]);
      if (fwd) region = adopted[0]?.id ?? null;
    }
    if (region) {
      const b = (await rs(region)).build;
      check(!!b && b.built === false, `the rolled-forward region is survival and counts its building lot (built ${b?.built}, percent ${b?.percent})`, b);
      await pause(ids.house_4, false);
      const c0 = (await pile()).ledger?.consumed ?? {};
      const o0 = (await pile()).outstanding ?? {};
      const ok = await feedPile(async () => ['BUILT', 'built'].includes((await siteState(ids.house_4)).state));
      const used = G.minus((await pile()).ledger?.consumed ?? {}, c0);
      check(ok && G.same(used, o0), `after the recovered adoption, house_4 built from the stockpile: consumed ${json(used)} = its outstanding ${json(o0)}`);
      // un-adopt, then the old builds undone (Steward's undo of its own build): the crate-fed lots refund once, from their records
      const un = await call('dev.ad.unadopt', { region }, 300_000);
      check(!un.refused, `the recovered region un-adopted: the sites back in their groups (${json(un.refused ?? un.groups)})`);
      const pr = await pile();
      const recs = Object.entries(pr.ledger?.paid ?? {}).filter(([k]) => k.startsWith(`site:${ids.house_3}@`) || k.startsWith(`site:${ids.house_4}@`));
      const want = recs.reduce((a, [, m]) => G.plus(a, m), {});
      const u2 = await later(`sundo ${b2.group} stage1 force`);
      await L.settle(3000);
      const pm = await pile();
      const back2 = G.minus(backOf(pm.ledger), backOf(pr.ledger));
      const left = Object.keys(pm.ledger?.paid ?? {}).filter((k) => k.startsWith(`site:${ids.house_3}@`) || k.startsWith(`site:${ids.house_4}@`));
      out.undoB2 = { result: u2, back: back2, records: Object.fromEntries(recs), left };
      check(recs.length === 2 && G.same(back2, want) && left.length === 0, `undo of the old build b2 after the un-adoption: house_3 (BUILT, its crate keyed) and house_4 refunded once from the stockpile, item for item their records (${sum(back2)} units = ${sum(want)}), the records spent`, out.undoB2);
      const u1 = await later(`sundo ${b1.group} stage1 force`);
      const u1s = await later(`sundo ${b1.group} street force`);
      await L.settle(3000);
      const pz = await pile();
      const back1 = G.minus(backOf(pz.ledger), backOf(pm.ledger));
      const d = diff(B0, await cellsOf(BOX(W.gy)));
      out.undoB1 = { result: [u1, u1s], back: back1, diff: d.n };
      check(sum(back1) === 0 && d.n === 0, `the instant build b1 undone: nothing refunded (${json(back1)}); E-flat ${d.n} against the world before the settlement`, out.undoB1);
      const pz2 = await pile();
      check(json(pz.ledger) === json(pz2.ledger), 'nothing refunded twice: the ledger holds still after the undos');
    }
    await L.leaveWorld();
    spendZero();
    return out;
  };

  steps.sadinstant = async () => {
    await ensure();
    const out = {};
    const W = await world('G6B SAD Instant');
    const T = layout(W.gy);
    const B0 = await cellsOf(BOX(W.gy));
    const entry = await ig.installCabin('sad_cabin');
    const [l1, l2, l3, l4] = T.lots;
    const b1 = await build(T, entry, [l1, l2], [[T.x0, T.xm]], 'b1');
    const b2 = await build(T, entry, [l3, l4], [[T.xm + 1, T.x1]], 'b2', { keys: ['street#2'] });
    const ids = { ...b1.ids, ...b2.ids };
    const cr = await call('dev.stockpile.create', { owner: OWNER, crates: PILE_AT(W.gy) }, 120_000);
    check(!cr.refused, `a stockpile of 4 crates for ${OWNER}`);
    const a = await call('dev.ad.adopt', adoptReq(T, ids), 900_000);
    check(!a.refused && a.state === 'PLACED', `row 6b: an all-instant street town adopted in survival: ${a.region} ${a.state ?? a.refused}`);
    if (a.refused) { await L.leaveWorld(); spendZero(); return out; }
    const region = a.region;
    const b = (await rs(region)).build;
    check(!!b && b.built === true && b.percent === 100, `row 6b: the region is survival (RegionView.build ${json(b && { built: b.built, percent: b.percent })}): nothing to build, its instant lots counted as nothing`, b);
    const S0 = await cellsOf(BOX(W.gy));
    const g = await growPlan(region, { lots: [{ id: 'hb', type: 'house', size: [9, 9], villager: 'dwelling' }] });
    check(!g.refused, `row 6b: a growth planned in survival: ${g.refused ?? `${g.planId} rid ${g.revisionOf?.rid}`}`);
    if (!g.refused) {
      const q = await call('dev.region.quote', { planId: g.planId, lotEntries: { hb: 'rs_hut' } }, 300_000);
      const p0 = await pile();
      await call('dev.region.realise', { planId: g.planId, lots: { hb: 'rs_hut' } }, 300_000);
      const f = await G.feed({ L }, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
      const w = await rvWait(region, g.revisionOf.rid, 1_800_000);
      const p1 = await pile();
      const used = G.minus(p1.ledger?.consumed ?? {}, p0.ledger?.consumed ?? {});
      out.grow = { quote: q.bom, consumed: used, state: w.r.state, waves: f.waves };
      check(w.r.state === 'PLACED' && !q.refused && sum(q.bom) > 0 && G.same(q.bom, used), `row 6b: grown from materials: ${w.r.state}; consumed = quote: ${json(used)}`, out.grow);
      // the lamp case (run 2's finding): a verge column meets a paid prop's cell; the props stage comes after the verges, so the lamp stands
      const rvir = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', g.planId, 'ir.json'), 'utf8'));
      const colsOf = (id) => (rvir.parts.find((pt) => pt.id === id)?.ops ?? []).flatMap((o) => { const c = o.cols ?? []; const r = []; for (let i = 0; i + 4 < c.length; i += 5) r.push(c.slice(i, i + 5)); return r.map((x) => ({ x: x[0], z: x[1], y0: x[2], y1: x[3], k: x[4], mats: o.materials })); });
      const props = colsOf(`rv${g.revisionOf.rid}_props`);
      const verges = new Set(colsOf(`rv${g.revisionOf.rid}_verges`).map((v) => `${v.x},${v.z}`));
      const met = props.filter((pc) => verges.has(`${pc.x},${pc.z}`));
      let standing = 0;
      for (const pc of met) if (await isBlock([pc.x, pc.y0, pc.z], String(pc.mats?.[pc.k] ?? '').replace(/\[.*$/, ''))) standing++;
      out.lamp = { stages: g.stages, met: met.map((pc) => [pc.x, pc.y0, pc.z, String(pc.mats?.[pc.k] ?? '')]), standing };
      check(json(g.stages) === json(['adopted', 'props']) && met.length >= 1 && standing === met.length, `row 6b (the lamp): the growth's props in their own stage (${json(g.stages)}); ${met.length} prop cell(s) on a verge column, ${standing} standing as planned (the verge never wrote over the paid lamp; consumed = quote above)`, out.lamp);
      const u = await call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000);
      await L.settle(3000);
      const p2 = await pile();
      const back = G.minus(backOf(p2.ledger), backOf(p1.ledger));
      const d = diff(S0, await cellsOf(BOX(W.gy)));
      const lv = (await call('dev.region.state', { region }, 60_000)).view?.lots ?? [];
      out.undo = { removed: u.removed, back, diff: d.n, lots: lv.map((l) => [l.id, l.state]) };
      check(u.removed === true && G.same(back, used) && d.n === 0 && T.lots.every((l) => lv.find((x) => x.id === l.id)?.state === 'placed'),
        `row 6b: the growth undone: refund ${json(back)} = consumed; E-flat ${d.n} against the town before it; the instant lots stand (${json(out.undo.lots)})`, out.undo);
    }
    const pr = await pile();
    const rmr = await removeRegion(region, OWNER);
    const pa = await pile();
    const back = G.minus(backOf(pa.ledger), backOf(pr.ledger));
    const d = diff(B0, await cellsOf(BOX(W.gy)));
    out.remove = { diff: d.n, back };
    check(rmr?.removed === true && d.n === 0 && sum(back) === 0, `row 6b: Regions.remove: E-flat ${d.n}; the instant lots refunded nothing (${json(back)})`, out.remove);
    await L.leaveWorld();
    spendZero();
    return out;
  };

  // ------------------------------------------------------------------ (slice ADP) adoptCrates and its crates
  // adp-defer   A: the shared crate unreadable (owner tag changed): deferred, intact (halts SAC1, SAC2); B: its chunk unloaded, halts SAC1
  //             and ADP1 (inside the credit's save) roll back, then the live call adopts it once; C: a third call adds nothing
  // adp-forward a fresh town per kill point ADP2 (the credit saved, the crate full), ADP3 (inside the take's save), SAC2 (the records):
  //             after the unclean restart the start's repair finishes or clears it: the crate's stock once, the references cleared
  // adp-complete a lot with its own crate, unreadable: adoptCrates defers it, the lot finished: the crate still stands with its stock;
  //             Regions.adopt refuses while it stands; its tag back, adoptCrates takes it once
  // adp-road    a construction road built from a shared crate beside a building house: adopted, the BUILT road gets its paid record;
  //             after a restart its removal refunds its paid cells into the stockpile
  // Conservation (rule 18) after every case: the audit's standing parts (stock, paid cells standing, crate stock, item entities, containers,
  // inventory) over the fixture's box equal what they were before it.
  const ADP_BOX = (gy) => ({ min: [CX - 45, gy - 12, CZ - 45], max: [CX + 175, gy + 40, CZ + 110] });
  const crateBlock = 'architect_mc:construction_crate';
  const audit = (area) => call('dev.stockpile.audit', { owner: OWNER, min: area.min, max: area.max }, 120_000);
  const standing = (a) => {
    let t = {};
    for (const m of [a.inventory, a.containers, a.entities, a.stock, a.paidStanding, a.legacyCrateStock]) t = G.plus(t, m ?? {});
    for (const k of Object.keys(t)) if (!t[k]) delete t[k];
    return t;
  };
  function conserver(out, area, H0) {
    return async (tag) => {
      const a = await audit(area);
      const h = standing(a);
      const d = G.minus(h, H0);
      for (const k of Object.keys(d)) if (!d[k]) delete d[k];
      out.conserve = { ...(out.conserve ?? {}), [tag]: { diff: d, identity: a.identity } };
      check(Object.keys(d).length === 0 && a.identity !== false, `${tag}: conservation: what stands (stock, paid cells standing, crate stock, item entities, containers, inventory: ${sum(h)}) equals what stood before (${sum(H0)}): ${json(d)}`, out.conserve[tag]);
    };
  }
  const tagOf = async (at) => json((await cmd(`/data get block ${at.join(' ')} Site`).catch((e) => ({ messages: [String(e)] }))).messages ?? []);
  const retag = (at, t) => cmd(`/data merge block ${at.join(' ')} {Site:"${t}"}`).catch(() => null);
  const ledgerSame = (a, b) => G.same(a?.delivered, b?.delivered) && G.same(a?.dropped ?? {}, b?.dropped ?? {}) && json(a?.paid ?? {}) === json(b?.paid ?? {}) && G.same(stockOf(a), stockOf(b));
  async function away(at) {
    await L.tp(CX + 4000, 120, CZ + 4000);
    let ld = true;
    for (let i = 0; i < 40 && ld; i++) {
      const r = await L.cmd(`/execute if loaded ${at.join(' ')}`).catch(() => null);
      ld = !!(r?.success || Number(r?.result) > 0);
      if (ld) await sleep(3000);
    }
    return !ld;
  }
  /** A fresh Supplied town (the shared crate, or own crates), the stockpile, the crate's cell, tag and ledger, the conservation baseline. */
  async function adpTown(name, opts = {}) {
    const out = {};
    const W = await world(name);
    const town = await suppliedTown('adp', W, opts);
    const cr = await call('dev.stockpile.create', { owner: OWNER, crates: PILE_AT(W.gy) }, 120_000);
    check(!cr.refused, `ADP: a stockpile of 4 crates for ${OWNER}`);
    const s40 = await siteState(town.ids.house_4);
    const at = [s40.crate?.x, s40.crate?.y, s40.crate?.z];
    const tag = opts.own ? town.ids.house_4 : `group:${town.b2.group}`;
    const got = await tagOf(at);
    out.tag = { at, tag, got };
    check(s40.crate?.present === true && got.includes(tag) && sum(s40.ledger?.stock) > 0,
      `ADP: the crate at ${json(at)} stands, owned by ${tag}, holding ${sum(s40.ledger?.stock)} items (placed ${sum(s40.ledger?.placed)})`, out.tag);
    const area = ADP_BOX(W.gy);
    const H0 = standing(await audit(area));
    return { out, W, ...town, s40, at, tag, area, conserve: conserver(out, area, H0), p0: await pile() };
  }
  /** After the crate's adoption: its stock moved once, its cell restored, both references cleared, house_4 fed (when building), house_3 paid. */
  async function adoptedOnce(label, F, { building = true } = {}) {
    const pB = await pile();
    const moved = G.plus(G.minus(stockOf(pB.ledger), stockOf(F.p0.ledger)), G.minus(pB.ledger?.dropped ?? {}, F.p0.ledger?.dropped ?? {}));
    const s3 = await siteState(F.ids.house_3);
    const s4 = await siteState(F.ids.house_4);
    const stands = await isBlock(F.at, crateBlock);
    const rec3 = Object.entries(pB.ledger?.paid ?? {}).find(([k]) => k.startsWith(`site:${F.ids.house_3}@`));
    const r = { moved, crateStock: F.s40.ledger?.stock, refs: [s3.crate, s4.crate], order: pB.feedOrder, stands, rec3: rec3 ? sum(rec3[1]) : 0 };
    F.out[label] = r;
    check(G.same(moved, F.s40.ledger?.stock ?? {}) && !stands, `${label}: the crate's stock moved exactly once (${json(moved)}; it held ${json(F.s40.ledger?.stock)}), its cell restored`, r);
    check(s4.crate?.x === undefined && (!building || ((pB.feedOrder ?? []).includes(F.ids.house_4) && !(pB.feedOrder ?? []).includes(F.ids.house_3))),
      `${label}: the crate references cleared${building ? `; house_4 in the feed order, the BUILT house_3 not (${json(pB.feedOrder ?? [])})` : ''}`, r);
    return pB;
  }

  steps.adpdefer = async () => {
    await ensure();
    const F = await adpTown('G6B ADP Defer');
    const { out, W, ids, at, tag, s40, conserve, p0 } = F;
    // A: the crate unreadable (its owner tag is not its group's)
    const mA = await cmd(`/data merge block ${at.join(' ')} {Site:"adp:other"}`);
    check(mA?.success !== false, `ADP A: the crate's owner tag changed to adp:other (${json(mA?.messages ?? [])})`);
    for (const [kp, savedByOp] of [['SAC1', false], ['SAC2', true]]) {
      const b = await baseline(`ADP A ${kp}`);
      await call('dev.journal.killAt', { point: kp }, 10_000);
      const Ld = await halt(`ADP A ${kp}`, W, b, () => call('dev.stockpile.adopt', { owner: OWNER }, 120_000).catch(() => null), { savedByOp });
      if (!Ld) continue;
      const stands = await isBlock(at, crateBlock);
      const r3 = await siteState(ids.house_3);
      const r4 = await siteState(ids.house_4);
      out[`A${kp}`] = { stands, refs: [r3.crate, r4.crate], same: ledgerSame(Ld, b.ledger) };
      check(stands && ledgerSame(Ld, b.ledger) && r3.crate?.x === at[0] && r4.crate?.x === at[0], `ADP A ${kp}: after the unclean restart the unreadable crate stands, the saved ledger as before, both references kept`, out[`A${kp}`]);
      await retag(at, tag);
      await conserve(`ADP A ${kp}`);
      await retag(at, 'adp:other');
    }
    const aA = await call('dev.stockpile.adopt', { owner: OWNER }, 120_000);
    const pA = await pile();
    const standsA = await isBlock(at, crateBlock);
    const s3A = await siteState(ids.house_3);
    const s4A = await siteState(ids.house_4);
    out.A = { refused: aA.refused ?? null, stands: standsA, refs: [s3A.crate, s4A.crate], order: pA.feedOrder, same: ledgerSame(pA.ledger, p0.ledger) };
    check(!aA.refused && standsA && ledgerSame(pA.ledger, p0.ledger), `ADP A: adoptCrates with the crate unreadable left it standing (${standsA}) and the stockpile's ledger unchanged`, out.A);
    check(s3A.crate?.x === at[0] && s4A.crate?.x === at[0] && json(pA.feedOrder ?? []) === json(p0.feedOrder ?? []), `ADP A: both sites keep their crate reference; the feed order unchanged (${json(pA.feedOrder ?? [])})`, out.A);
    await retag(at, tag);
    const s4B0 = await siteState(ids.house_4);
    check(s4B0.crate?.present === true && G.same(s4B0.ledger?.stock, s40.ledger?.stock) && G.same(s4B0.ledger?.placed, s40.ledger?.placed),
      `ADP A: with its tag back the crate reads again, its stock (${sum(s4B0.ledger?.stock)}) and placed counts as before`, { stock: s4B0.ledger?.stock });
    await conserve('ADP A');
    // B: the crate's chunk unloaded; halts SAC1 (before the credit's save) and ADP1 (inside it: the chunks written, the ledger not) roll back
    for (const kp of ['SAC1', 'ADP1']) {
      const b = await baseline(`ADP B ${kp}`);
      const unloaded = await away(at);
      await call('dev.journal.killAt', { point: kp }, 10_000);
      const Ld = await halt(`ADP B ${kp}`, W, b, () => call('dev.stockpile.adopt', { owner: OWNER }, 120_000).catch(() => null));
      if (!Ld) continue;
      const stands = await isBlock(at, crateBlock);
      const c = await siteState(ids.house_4);
      out[`B${kp}`] = { unloaded, stands, crateStock: c.ledger?.stock, same: ledgerSame(Ld, b.ledger) };
      check(stands && G.same(c.ledger?.stock, s40.ledger?.stock) && ledgerSame(Ld, b.ledger), `ADP B ${kp} (chunk ${unloaded ? 'unloaded' : 'loaded'}): after the unclean restart the crate stands with its stock (${sum(c.ledger?.stock)}), the saved ledger as before (nothing credited)`, out[`B${kp}`]);
      await conserve(`ADP B ${kp}`);
    }
    // B live: adopted once
    const unloaded = await away(at);
    const aB = await call('dev.stockpile.adopt', { owner: OWNER }, 120_000);
    await L.tp(CX + 80, 80, CZ + 48);
    await sleep(3000);
    check(!aB.refused, `ADP B: adoptCrates with the crate's chunk ${unloaded ? 'unloaded' : 'still loaded (unloading not shown)'} (${json(aB.refused ?? 'adopted')})`);
    const pB = await adoptedOnce('ADP B', F);
    check(out['ADP B'].rec3 > 0, `ADP B: the BUILT house_3 on the out-of-range crate got its paid record (${out['ADP B'].rec3} units)`, out['ADP B']);
    await conserve('ADP B');
    // C: again: nothing more
    const aC = await call('dev.stockpile.adopt', { owner: OWNER }, 120_000);
    const pC = await pile();
    out.C = { refused: aC.refused ?? null };
    check(!aC.refused && ledgerSame(pC.ledger, pB.ledger) && json(pC.feedOrder) === json(pB.feedOrder), 'ADP C: adoptCrates a third time adds nothing (delivered, dropped, paid records, stock, feed order)', out.C);
    await conserve('ADP C');
    await L.leaveWorld();
    spendZero();
    return out;
  };

  steps.adpforward = async () => {
    await ensure();
    const all = {};
    for (const [kp, savedByOp] of [['ADP2', true], ['ADP3', true], ['SAC2', true]]) {
      const F = await adpTown(`G6B ADP Fwd ${kp}`);
      const b = await baseline(`ADP ${kp}`);
      const unloaded = await away(F.at);
      await call('dev.journal.killAt', { point: kp }, 10_000);
      const Ld = await halt(`ADP ${kp}`, F.W, b, () => call('dev.stockpile.adopt', { owner: OWNER }, 120_000).catch(() => null), { savedByOp });
      if (Ld) {
        const pB = await adoptedOnce(`ADP ${kp} (chunk ${unloaded ? 'unloaded' : 'loaded'}) after the unclean restart`, F);
        F.out.rec3 = Object.entries(pB.ledger?.paid ?? {}).some(([k]) => k.startsWith(`site:${F.ids.house_3}@`));
        check(F.out.rec3, `ADP ${kp}: the BUILT house_3 has its paid record`);
        await F.conserve(`ADP ${kp}`);
        const again = await call('dev.stockpile.adopt', { owner: OWNER }, 120_000);
        const pC = await pile();
        check(!again.refused && ledgerSame(pC.ledger, pB.ledger), `ADP ${kp}: a later adoptCrates credits nothing twice`);
        await F.conserve(`ADP ${kp} again`);
      }
      all[kp] = F.out;
      await L.leaveWorld();
    }
    spendZero();
    return all;
  };

  steps.adpcomplete = async () => {
    await ensure();
    const F = await adpTown('G6B ADP Complete', { own: true });
    const { out, ids, at, tag, s40, conserve, T } = F;
    await retag(at, 'adp:other');
    const a1 = await call('dev.stockpile.adopt', { owner: OWNER }, 120_000);
    check(!a1.refused && await isBlock(at, crateBlock), `ADP complete: adoptCrates defers house_4's own crate (unreadable): it stands`);
    await pause(ids.house_4, false);
    const fin = await call('dev.site.finish', { site: ids.house_4 }, 120_000);
    const s4 = await builtWait(ids.house_4, 300_000);
    const stands = await isBlock(at, crateBlock);
    await retag(at, tag);
    const s4b = await siteState(ids.house_4);
    out.complete = { finish: fin.refused ?? 'ok', state: s4.state, stands, crate: s4b.crate, stock: s4b.ledger?.stock };
    check(['BUILT', 'built'].includes(s4.state) && stands && s4b.crate?.present === true && G.same(s4b.ledger?.stock, s40.ledger?.stock),
      `ADP complete: house_4 finished (${s4.state}) while its crate was deferred: the crate still stands with its stock (${sum(s4b.ledger?.stock)}; base restored its cell)`, out.complete);
    await conserve('ADP complete: finished');
    // Regions.adopt refuses while a BUILT lot's crate stands (whatever its tag)
    await retag(at, 'adp:other');
    const S0 = await cellsOf(BOX(F.W.gy));
    const r0 = await call('dev.ad.adopt', adoptReq(T, ids), 900_000);
    out.region = r0.refused ?? r0.state ?? null;
    check(String(r0.refused ?? '').startsWith('NOT_ALLOWED') && diff(S0, await cellsOf(BOX(F.W.gy))).n === 0,
      `ADP complete: Regions.adopt with house_4's crate standing (another tag) refused, nothing written (${out.region})`, out.region);
    await retag(at, tag);
    const a2 = await call('dev.stockpile.adopt', { owner: OWNER }, 120_000);
    check(!a2.refused, `ADP complete: with its tag back adoptCrates takes it (${json(a2.refused ?? 'adopted')})`);
    await adoptedOnce('ADP complete: adopted', F, { building: false });
    const p = await pile();
    const rec4 = Object.entries(p.ledger?.paid ?? {}).find(([k]) => k.startsWith(`site:${ids.house_4}@`));
    check(!!rec4 && sum(rec4[1]) > 0, `ADP complete: the BUILT house_4 got its paid record (${rec4 ? sum(rec4[1]) : 0} units)`);
    await conserve('ADP complete: adopted');
    await L.leaveWorld();
    spendZero();
    return out;
  };

  steps.adproad = async () => {
    await ensure();
    const out = {};
    const W = await world('G6B ADP Road');
    const entry = await ig.installCabin('sad_cabin');
    await call('dev.survival.set', { on: true });
    const X = CX + 20, Z = CZ + 20;
    await cmd('/gamemode creative');
    await L.tp(X + 20.5, W.gy + 30, Z + 10.5, 0, 89);
    const y = await groundY(X, Z) + 1;
    await cmd(`/fill ${X - 3} ${y - 1} ${Z - 3} ${X + 42} ${y - 1} ${Z + 3} minecraft:stone`);
    await cmd(`/fill ${X - 3} ${y} ${Z - 3} ${X + 42} ${y + 3} ${Z + 3} minecraft:air`);
    await L.settle(2000);
    const road = { points: [[X, y, Z], [X + 39, y, Z]], width: 1, owner: OWNER, mode: 'CONSTRUCTION' };
    const rc = await api(`roadcheck ${json(road)}`);
    check(rc.ok && rc.construction && sum(rc.bom) > 0, `ADP road: a paid construction road (BOM ${json(rc.bom)})`, rc.refusals);
    const area = { min: [CX - 45, y - 12, Z - 60], max: [X + 60, y + 30, Z + 20] };
    const batch = { owner: OWNER, sharedCrate: true, autoApprove: true, crateAt: [X + 20, y, Z - 10], items: [
      { key: 'h1', bp: entry, at: [X, y, Z - 40], mode: 'AUTO' }, { key: 'r1', road: { ...road, mode: 'AUTO' } }] };
    const bid = await later(`bqueue ${json(batch)}`);
    let bv;
    for (let i = 0; i < 120; i++) { bv = await api(`batch ${bid}`); if (bv.items?.every((it) => ['PLACED', 'FAILED'].includes(it.status))) break; await sleep(1000); }
    const items = Object.fromEntries((bv.items ?? []).map((it) => [it.key, it]));
    check(['h1', 'r1'].every((k) => items[k]?.status === 'PLACED'), `ADP road: the batch placed (${json(bv.items?.map((i) => [i.key, i.status, i.reason]))})`);
    const roadId = items.r1?.site, h1 = items.h1?.site;
    if (!roadId || !h1) { await L.leaveWorld(); spendZero(); return out; }
    await pause(h1, true);
    const ins = await call('dev.crate.insert', { site: roadId, items: rc.bom }, 60_000);
    let rv;
    for (let i = 0; i < 180; i++) { rv = (await api('sites')).all.find((s) => s.id === roadId); if (rv?.state === 'BUILT') break; await sleep(1000); }
    check(rv?.state === 'BUILT' && G.same(ins.accepted, rc.bom), `ADP road: ${roadId} fed its BOM and BUILT (${rv?.state}); house ${h1} still building on the shared crate`);
    const cr = await call('dev.stockpile.create', { owner: OWNER, crates: PILE_AT(W.gy) }, 120_000);
    check(!cr.refused, `ADP road: a stockpile for ${OWNER}`);
    const H0 = standing(await audit(area));
    const conserve = conserver(out, area, H0);
    const ac = await call('dev.stockpile.adopt', { owner: OWNER }, 120_000);
    const p1 = await pile();
    const rec = Object.entries(p1.ledger?.paid ?? {}).find(([k]) => k.startsWith(`road:${roadId}@`));
    out.adopt = { refused: ac.refused ?? null, record: rec ?? null, order: p1.feedOrder };
    check(!ac.refused && !!rec && G.same(rec[1], rc.bom) && !(p1.feedOrder ?? []).includes(roadId) && (p1.feedOrder ?? []).includes(h1),
      `ADP road: adoptCrates keyed the BUILT road's paid record (${rec ? json(rec[1]) : 'none'}; its BOM ${json(rc.bom)}); it joins no feed, the house does`, out.adopt);
    await conserve('ADP road: adopted');
    // a clean restart, then the road removed: its paid cells refunded into the stockpile
    const dir = path.basename(W.dir);
    await L.leaveWorld();
    await L.openWorld(dir);
    await L.tp(X + 20.5, y + 30, Z + 10.5, 0, 89);
    await sleep(3000);
    const before = await pile();
    const rm = await later(`remove ${roadId} ${OWNER} noforce`);
    await L.settle(3000);
    const after = await pile();
    const back = G.minus(stockOf(after.ledger), stockOf(before.ledger));
    out.remove = { removed: rm.removed, back };
    check(rm.removed && G.same(back, rc.bom), `ADP road: after the restart the road's removal refunded its paid cells into the stockpile (${json(back)}; base: 0)`, out.remove);
    await conserve('ADP road: removed');
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
