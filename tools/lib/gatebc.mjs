// Slice BC+ gate (docs/CONTRACT.md "Slice BC+, bill bounds and exact quotes"), registered into tools/gate6dgr.mjs (GR's town, growth and
// survival helpers, IG's irrigated farm lot). Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs bcrelay   (bc-relay)   S-M5-10: a survival V town fed until built; an irrigated farm lot grown (IG's crop_farm
//                                                  20 x 21 with IRR's field entry), quoted and realised; fed everything but its wheat
//                                                  seeds, so the site waits with bare farmland and no water (the fluids stage is last);
//                                                  random ticks on (random_tick_speed 300) until vanilla dried some of its farmland back
//                                                  to dirt; then fed the rest: PLACED; consumed equals the quote item for item (no
//                                                  dried cell re-laid and paid again); undoRevision: what it consumed comes back exactly
//
// Evidence: artifacts/gate6d-gr/bcrelay.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';
import { terrainShape } from './quote-terrain.mjs';

/** IG's irrigated farm lot (Steward's crop farm ask) and IRR's field entry at its size. */
const FARM = { id: 'farm_bc', type: 'crop_farm', size: [20, 21], irrigate: true };
const FIELD = 'bc_field_20x21';
const TOWN_LOTS = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];

export async function registerBC(steps, h) {
  const { L, call, check, cmd, log, json, OUT, G, ensure, spendZero, groundY, BOXOF, CX, CZ, CLAIM, growPlan, rvWait, root, cellsOf } = h;
  const ctx = { L, OUT, KIT: path.join(root, 'kit'), imp: h.imp };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const idOf = (s) => String(s).replace(/\[.*$/, '').replace(/^minecraft:/, '');

  async function installField() {
    const { buildField } = await import('./gate6cirr-game.mjs');
    const r = await buildField(ctx, FIELD, { width: FARM.size[0], depth: FARM.size[1] }, 'wheat', path.join(OUT, 'fields', FIELD));
    const lib = path.join(L.LIBRARY, FIELD);
    fs.rmSync(lib, { recursive: true, force: true });
    fs.mkdirSync(lib, { recursive: true });
    for (const f of fs.readdirSync(r.dir)) fs.copyFileSync(path.join(r.dir, f), path.join(lib, f));
    await L.cmd('/architect reload');
    await L.settle(1500);
    return r.bp;
  }

  /** The lot's floor layer: {farmland, dirt} counts over the lot's box at its floor. */
  async function floor(lot) {
    const b = lot.box;
    const c = await cellsOf([b[0], lot.floorY, b[2], b[3], lot.floorY, b[5]]);
    let farmland = 0, dirt = 0;
    for (const s of c.values()) { const id = idOf(s); if (id === 'farmland') farmland++; else if (id === 'dirt') dirt++; }
    return { farmland, dirt };
  }

  /** One feed wave of what the owner's targets lack, less the `skip` items. Returns what went in. */
  async function feedWave(skip) {
    const ps = await pile();
    const need = {};
    for (const [it, n] of Object.entries(ps.outstanding ?? {})) {
      const lack = n - (ps.stock?.[it] ?? 0);
      if (lack > 0 && !skip.has(it)) need[it] = lack;
    }
    if (!Object.keys(need).length) return { need, acc: {}, ps };
    const acc = (await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: need, exact: true }, 120_000)).accepted ?? {};
    return { need, acc, ps };
  }

  // (QL-b) qlb-lot: Steward's crop-farm-067 world (a COPY: the source is never opened or changed), its set_2 growth plans quoted again in
  // a few seconds apart, each lot's bill taken apart (dev.qlb.lotBill: template, fill, approach, the template cells billed as another state,
  // mobs). Steward's own plans (planned before lotGround) are recorded; a fresh growth with rv3's request is judged: priced over its pads'
  // ground, every quote bills 210 dirt (template 205 + shell 5, what the realise consumed). $0.
  steps.qlblot = async () => {
    await ensure();
    const out = { pairs: [] };
    const { execFileSync } = await import('node:child_process');
    const os = await import('node:os');
    const SRC = path.join(os.homedir(), 'Developer', 'LarattaLabs', 'Minecraft', '_work', 'steward-cf067', 'mod', 'run');
    const W = 'G6B QLB cf067';
    const dst = path.join(L.SAVES, W);
    check(fs.existsSync(path.join(SRC, 'saves', 'Steward E2E', 'level.dat')), `Steward's cf067 world is there to copy: ${SRC}`);
    await L.leaveWorld();
    fs.rmSync(dst, { recursive: true, force: true });
    execFileSync('cp', ['-c', '-R', path.join(SRC, 'saves', 'Steward E2E'), dst]);
    fs.rmSync(path.join(dst, 'session.lock'), { force: true });
    for (const e of ['crop_farm', 'crop_farm_kv_295', 'crop_farm_kv_296', 'crop_farm_kv_297']) {
      fs.rmSync(path.join(L.LIBRARY, e), { recursive: true, force: true });
      execFileSync('cp', ['-c', '-R', path.join(SRC, 'architect', 'library', e), path.join(L.LIBRARY, e)]);
    }
    await L.openWorld(W);
    await L.cmd('/architect reload');
    await L.settle(2000);
    const PLANS = [
      { planId: 'pmwh3cnmi899bae', lot: 'gb1794702197830_1', entry: 'crop_farm_kv_295', label: 'rv1 wheat (quoted 210)' },
      { planId: 'pmwh3ex8kc61d60', lot: 'gb1794702303198_1', entry: 'crop_farm_kv_297', label: 'rv3 carrots (quoted 209, consumed 205 + 5)' },
    ];
    const near = () => L.tp(1810, 80, 71966);
    const away = () => L.tp(1810, 80, 71966 - 140);
    const lotOf = (r, p) => r.lots?.[p.lot] ?? null;
    const brief = (d) => d && { template: d.template, fill: d.fill, approach: d.approach, other: d.other, masked: d.maskedTemplateCells, changed: d.changed,
      fillN: d.fillCells?.n, cutN: d.cutCells?.n, pathN: d.approachPath?.n, apprFillN: d.approachFill?.n, mobs: d.mobs, why: d.why, origin: d.origin };
    await near();
    for (const p of PLANS) {
      const r = await call('dev.qlb.lotBill', { planId: p.planId, lotEntries: { [p.lot]: p.entry } }, 120_000);
      out[p.planId] = { label: p.label, bom: r.bom, bomParts: r.bomParts, exact: r.exact, refused: r.refused, lot: lotOf(r, p) };
      log(`${p.label}: bom dirt ${r.bom?.['minecraft:dirt']} (${r.refused ?? 'quoted'}); lot ${JSON.stringify(brief(lotOf(r, p))).slice(0, 1500)}`);
    }
    // (QL-b D'') a fresh growth with rv3's request (Steward's spec, read from the copy's plan): its plan keeps the lot's ground (lotGround), so the
    // quote prices the lot over the pads' grass: 10 pairs 5 s apart (5 near, 5 away) bill the template's 205 + the shell's 5 dirt, none moves
    const old = JSON.parse(fs.readFileSync(path.join(dst, 'architect-regions', 'plans', `${PLANS[1].planId}.json`), 'utf8'));
    const grow = old.ir?.params?.spec?.grow;
    const ext = Object.fromEntries(Object.entries(old.ext ?? {}).filter(([k]) => !k.startsWith('architect_mc:'))); // Architect's own keys are refused
    const g = await call('dev.rv.plan', { region: 'rg1', program: 'plan_v0', params: { grow }, ext }, 900_000);
    out.fresh = { planId: g.planId, refused: g.refused ?? null, lots: (g.lots ?? []).map((l) => l.id) };
    check(!g.refused && !!g.planId, `a fresh growth with rv3's request planned: ${g.refused ?? g.planId}`, out.fresh);
    if (g.refused) { await L.leaveWorld(); spendZero(); return out; }
    const P = { planId: g.planId, lot: (g.lots ?? [])[0]?.id ?? PLANS[1].lot, entry: PLANS[1].entry };
    for (let i = 0; i < 10; i++) {
      if (i === 5) await away();
      const a = await call('dev.qlb.lotBill', { planId: P.planId, lotEntries: { [P.lot]: P.entry } }, 120_000);
      await sleep(5000);
      const b = await call('dev.qlb.lotBill', { planId: P.planId, lotEntries: { [P.lot]: P.entry } }, 120_000);
      const da = a.bom?.['minecraft:dirt'], db = b.bom?.['minecraft:dirt'];
      const pair = { i, where: i < 5 ? 'near' : 'away', dirt: [da, db], moved: da !== db, ground: lotOf(a, P)?.groundCells ?? 0, lotDirt: lotOf(a, P)?.template?.['minecraft:dirt'],
        a: brief(lotOf(a, P)), b: da !== db ? brief(lotOf(b, P)) : undefined, parts: da !== db ? [a.bomParts, b.bomParts] : undefined, notes: i === 0 ? a.notes : undefined };
      out.pairs.push(pair);
      log(`pair ${i} (${pair.where}): dirt ${da} -> ${db}${pair.moved ? ' MOVED' : ''}; lot dirt ${pair.lotDirt}, ground cells ${pair.ground}; changed ${JSON.stringify(pair.a?.changed ?? []).slice(0, 400)}`);
    }
    out.moved = out.pairs.filter((x) => x.moved).length;
    const dirts = out.pairs.flatMap((x) => x.dirt);
    check(out.pairs.length === 10 && out.pairs.every((x) => x.ground > 0), `QL-b: the fresh growth's lot is priced over its pads' ground (${out.pairs[0]?.ground} cells)`, { ground: out.pairs.map((x) => x.ground) });
    check(out.moved === 0 && dirts.every((d) => d === 210) && out.pairs.every((x) => x.lotDirt === 205),
      `QL-b D'': every quote bills 210 dirt (the template's 205, as consumed, + the shell's 5) and none moves: ${JSON.stringify(dirts)}`, { dirts });
    await L.leaveWorld();
    spendZero();
    return out;
  };

  steps.bcrelay = async () => {
    await ensure();
    const out = {};
    const SW = 'G6B BC Relay';
    await G.survivalBase(ctx);
    await L.fresh(SW, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    await installField();
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN_LOTS }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const region = await L.realise(p0.planId, { load: 'bounded:512', lots: {} });
    const f0 = await G.feed({ L }, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
    check(f0.last.st.view.state === 'PLACED' && f0.last.rs.build?.done, `the survival V town built: ${f0.last.st.view.state} (${f0.waves} feed waves)`);
    // the irrigated growth, quoted and realised with the field entry
    const g = await growPlan(region, { lots: [FARM] });
    check(!g.refused && g.revisionOf?.rid >= 1, `the irrigated farm growth planned: ${g.refused ?? `${g.planId} rid ${g.revisionOf?.rid}`}`);
    if (g.refused) { await L.leaveWorld(); spendZero(); return out; }
    const rid = g.revisionOf.rid;
    const lot = (g.lots ?? []).find((l) => l.id === FARM.id);
    const entries = { [FARM.id]: FIELD };
    const q = await call('dev.region.quote', { planId: g.planId, lotEntries: entries }, 300_000);
    out.quote = { bom: q.bom, exact: q.exact, notes: q.notes, refused: q.refused };
    check(!q.refused && q.bom?.['minecraft:dirt'] > 0 && q.bom?.['minecraft:wheat_seeds'] > 0, `the growth quoted: ${json(q.bom)} (exact ${q.exact})`, out.quote);
    // (QL) the module's quote (the crop field entry on an irrigated growth): its terrain part within its bill
    out.quote.terrain = q.terrain;
    check(terrainShape(q).length === 0, `QL: the farm growth's quote has a terrain part within its bill: ${json(q.terrain)}${terrainShape(q).length ? `; ${json(terrainShape(q))}` : ''}`);
    // the town's leftover dirt out of the stockpile (to the player), so the growth's shells wait for theirs (Steward's half-fed round)
    const left0 = (await pile()).stock?.['minecraft:dirt'] ?? 0;
    if (left0 > 0) await call('dev.stockpile.withdraw', { owner: G.OWNER, items: { 'minecraft:dirt': left0 } }, 60_000);
    out.withdrawn = { dirt: left0, after: (await pile()).stock?.['minecraft:dirt'] ?? 0 };
    const ps0 = await pile();
    const r = await call('dev.region.realise', { planId: g.planId, lots: entries }, 300_000);
    check(!r.refused, `the growth realised with the quoted entry: ${r.refused ?? r.region}`);
    // the street stage's shells put down first (IRR: shells, then the lot): fed half their dirt, then random ticks on, so grass spreads over
    // the dirt they laid while they wait (Steward's half-fed round: a shell paid 1-3 dirt again)
    const DIRT = 'minecraft:dirt';
    for (let i = 0; i < 90; i++) {
      const ps = await pile();
      if ((ps.outstanding?.[DIRT] ?? 0) > 0) break;
      await sleep(2000);
    }
    const psS = await pile();
    const shellDirt = (psS.outstanding?.[DIRT] ?? 0) - (psS.stock?.[DIRT] ?? 0);
    const halfDirt = Math.floor(shellDirt / 2);
    if (halfDirt > 0) await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: { [DIRT]: halfDirt }, exact: true }, 120_000);
    await sleep(8000);
    await cmd('/gamerule random_tick_speed 300');
    await sleep(60_000);
    await cmd('/gamerule random_tick_speed 0');
    await sleep(3000);
    const psS1 = await pile();
    out.shells = { outstandingDirt: shellDirt, fedDirt: halfDirt, consumed: G.minus(psS1.ledger?.consumed ?? {}, ps0.ledger?.consumed ?? {}), outstandingAfter: psS1.outstanding?.[DIRT] ?? 0 };
    // (recorded, not judged: in this town the shells' dirt comes from the realise's own stock; the grass-over-our-dirt rule is RelayBCTest's)
    log(`note: the shells waited half-fed (${halfDirt} of ${shellDirt} dirt) with random ticks on (random_tick_speed 300) for 60 s: ${json(out.shells)}`);
    // fed all but the seeds, until only the seeds are outstanding: the farm's site waits with its farmland laid, nothing planted, no water
    const SEEDS = 'minecraft:wheat_seeds';
    const skip = new Set([SEEDS]);
    let waves = 0, laid = { farmland: 0, dirt: 0 }, only = false;
    for (const t0 = Date.now(); Date.now() - t0 < 1_800_000;) {
      const w = await feedWave(skip);
      if (Object.keys(w.acc).length) waves++;
      const left = Object.entries(w.ps.outstanding ?? {}).filter(([it, n]) => it !== SEEDS && n - (w.ps.stock?.[it] ?? 0) > 0);
      laid = await floor(lot);
      if (!left.length && laid.farmland > 0 && (w.ps.outstanding?.[SEEDS] ?? 0) > 0) { only = true; break; }
      await sleep(3000);
    }
    await sleep(5000);
    const wait0 = await floor(lot);
    out.waiting = { waves, only, floor: wait0, outstanding: (await pile()).outstanding };
    check(only && wait0.farmland > 0, `fed all but the seeds (${waves} waves): the farm waits on ${SEEDS} only, its floor laid (${wait0.farmland} farmland, ${wait0.dirt} dirt)`, out.waiting);
    // vanilla dries the bare farmland: random ticks on until some of it is dirt again (no water: the fluids stage is last)
    await cmd('/gamerule random_tick_speed 300');
    let dried = wait0;
    for (let i = 0; i < 40; i++) {
      await sleep(3000); // (up to 2 min at random_tick_speed 300)
      dried = await floor(lot);
      if (dried.dirt - wait0.dirt >= 20) break;
    }
    await cmd('/gamerule random_tick_speed 0');
    await sleep(5000); // the builder sees the dried cells
    const psMid = await pile();
    out.dried = { floor: dried, consumedSoFar: G.minus(psMid.ledger?.consumed ?? {}, ps0.ledger?.consumed ?? {}), outstanding: psMid.outstanding };
    check(dried.dirt - wait0.dirt >= 1, `vanilla dried the bare farmland: ${dried.dirt - wait0.dirt} floor cells went back to dirt (${dried.farmland} farmland left)`, out.dried);
    check((psMid.outstanding?.['minecraft:dirt'] ?? 0) === 0, `the dried cells ask no new dirt while the site waits: outstanding ${json(psMid.outstanding)}`, out.dried);
    // the rest fed: built; consumed equals the quote
    const f1 = await G.feed({ L }, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
    const w = await rvWait(region, rid, 1_800_000);
    const after = await floor(lot);
    const ps1 = await pile();
    const paid = G.minus(ps1.ledger?.consumed ?? {}, ps0.ledger?.consumed ?? {});
    out.placed = { state: w.r.state, waves: f1.waves, floor: after, paid, diff: G.minus(paid, q.bom ?? {}) };
    check(w.r.state === 'PLACED' && f1.last.rs.build?.done, `fed the rest (${f1.waves} waves): the growth ${w.r.state}; its floor ${after.farmland} farmland, ${after.dirt} dirt`, out.placed);
    check(after.dirt === 0 && after.farmland > 0, `S-M5-10: every dried field cell tilled again before its crop (free): ${after.farmland} farmland, ${after.dirt} dirt`, out.placed);
    check(G.same(paid, q.bom ?? {}), `S-M5-10: consumed equals the quote item for item (no dried cell re-laid and paid again): quote ${json(q.bom)}, consumed ${json(paid)}`, out.placed);
    // undone: what it consumed comes back exactly
    const u = await call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000);
    await L.settle(3000);
    const ps2 = await pile();
    const back = G.minus(ps2.ledger?.returned ?? {}, ps1.ledger?.returned ?? {});
    out.undo = { removed: u.removed, refund: u.refund, returned: back, paid };
    check(u.removed === true && G.same(back, paid), `S-M5-10: undone; the refund equals what was consumed: consumed ${json(paid)}, returned ${json(back)}`, { ...out.undo, diff: G.minus(back, paid) });
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
