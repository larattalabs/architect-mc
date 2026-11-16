// Slice LC gate (docs/CONTRACT.md "### Slice LC as built"; Steward's S-M5-12 and S-M5-13): a removal's late cargo, registered into
// tools/gate6dgr.mjs (GR's survival town and feed helpers). Headless server, the sim sidecar: $0. Strict (removal, refunds, crash replay).
//
//   node tools/gate6dgr.mjs lcsurvival  (lc-survival)  a survival flat_village town with cottage_1 bound to lc_hall (fk_hall at slots 4,
//                                                      count 18, plus an undeclared input chest), built and filled. (S-M5-13) a stage undo
//                                                      (Groups.undoStage as a revision undoes its stage) with dev.removal.failAfterCustody:
//                                                      ends unwritten, the custody written back (each hopper exactly its declaration, no
//                                                      custody, nothing refunded). (S-M5-12) the stage undo again with dev.removal.lateCargo:
//                                                      right after the custody take, 3 diamonds into the input chest (not a fill container) and
//                                                      5 flint into the emptied declared hopper (its own declared item): removed; the 8 items
//                                                      handed out at the site (none erased); then the rest of the region removed: what came
//                                                      back over both = consumed, item for item, no custody. A second town: the same with the
//                                                      region Remove (the whole group): 2 diamonds in the chest, 4 bone in a hopper.
//   node tools/gate6dgr.mjs lccrash     (lc-crash)     the town built and filled, the baseline saved; dev.removal.failAfterCustody with kill
//                                                      point LC1 (the custody saved, then written back in memory, nothing saved since): the
//                                                      region Remove halts; after the restart the removal resumes or is asked again: what
//                                                      came back = consumed, item for item; no custody; none of the fill's items dropped.
//                                                      (fix b5b) LC3: the hall site removed alone (the atomic path) with late cargo, halted
//                                                      at CS1 inside its credit's save: the cargo is on disk with the restore.
//
// Evidence: artifacts/gate6d-gr/<step>.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FILL = { 'minecraft:flint': 18, 'minecraft:clay_ball': 18, 'minecraft:bone': 18, 'minecraft:feather': 18, 'minecraft:paper': 16 };
const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];
const ENTRY = 'lc_hall';
const DIAMOND = 'minecraft:diamond', FLINT = 'minecraft:flint', BONE = 'minecraft:bone';

export async function registerLC(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, CX, CZ, CLAIM, haltWait, root } = h;
  const ctx = { L, OUT: h.OUT, imp: h.imp };
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const fk = (site) => call('dev.fk.state', { site }, 30_000);
  const only = (m, keys) => Object.fromEntries(Object.entries(m ?? {}).filter(([k]) => keys.includes(k)));
  const ledgerOf = (rootJson) => (rootJson?.stockpiles ?? []).find((p) => p.owner === G.OWNER)?.ledger ?? null;
  const savedLedger = (name) => ledgerOf(JSON.parse(fs.readFileSync(path.join(L.SAVES, name, 'architect', 'stockpiles.json'), 'utf8')));
  const FK = Object.keys(FILL);
  const backOf = (a, b) => G.minus(G.plus(a.returned, a.refundOverflow), G.plus(b.returned, b.refundOverflow));
  const exactly = (s) => (s.containers ?? []).every((c) => G.same(c.holds, c.declared));
  const P = (at) => at.split(',').map(Number);

  /** lc_hall: fk_hall (the kit fixture program, slots 4, count 18) plus an undeclared chest (the hall's input chest) at template (5, 1, 1). */
  async function entry() {
    await G.designs(ctx);
    const src = fs.readFileSync(path.join(root, 'kit', 'test', 'fixtures', 'fk', 'fk_hall.mjs'), 'utf8')
      .replaceAll("'../lib/", `'${pathToFileURL(path.join(root, 'kit', 'lib')).href}/`);
    const tmp = path.join(h.OUT, 'lc_hall.mjs');
    fs.writeFileSync(tmp, src);
    const mod = await import(`${pathToFileURL(tmp).href}?t=${Date.now()}`);
    const { writeBlueprint } = await h.imp('lib/write.mjs');
    const { checkBlueprint } = await h.imp('lib/check.mjs');
    const bp = mod.default({ slots: 4, count: 18 });
    bp.id = ENTRY;
    bp.part('input', () => bp.set(5, 1, 1, 'minecraft:chest', { facing: 'south' }));
    const ck = checkBlueprint(bp, {});
    check(ck.ok, `lc_hall (fk_hall + an undeclared input chest) checks clean: ${ck.errors.slice(0, 3).join('; ') || 'OK'}`);
    const dir = path.join(L.LIBRARY, ENTRY);
    fs.rmSync(dir, { recursive: true, force: true });
    const w = writeBlueprint(bp, dir);
    const j = JSON.parse(fs.readFileSync(w.jsonPath, 'utf8'));
    j.givenProgram = { sha: 'gate-fixture', opKey: 'gate.lc.hall' };
    fs.writeFileSync(w.jsonPath, `${JSON.stringify(j, null, 2)}\n`);
    await L.cmd('/architect reload');
    await L.settle(1500);
  }

  async function deliver({ fill = false } = {}) {
    const ps = await pile();
    const need = {};
    for (const [it, n] of Object.entries(ps.outstanding ?? {})) {
      if (FK.includes(it) !== fill) continue;
      const lack = n - (ps.stock?.[it] ?? 0);
      if (lack > 0) need[it] = lack;
    }
    if (!Object.keys(need).length) return {};
    return (await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: need, exact: true }, 120_000)).accepted ?? {};
  }

  /** A survival town with lc_hall in cottage_1, built, filled and PLACED; the baseline ledger before the realise. */
  async function town(name) {
    await G.survivalBase(ctx);
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await entry();
    await call('dev.removal.state', { clear: true }, 10_000);
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `${name}: a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    await call('dev.region.quote', { planId: p0.planId, lotEntries: { cottage_1: ENTRY } }, 300_000);
    const ps0 = await pile();
    const region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: ENTRY } });
    // the fill site joins once the ground and street stages are built (its items held back meanwhile)
    let site = null;
    for (let i = 0; i < 360 && !site; i++) {
      for (const id of Object.keys((await pile()).targets ?? {})) if ((await fk(id)).hasFill) { site = id; break; }
      if (!site) { await deliver({ fill: false }); await L.sleep(2500); }
    }
    check(!!site, `${name}: lc_hall's site joined the feed (${site})`);
    if (!site) return null;
    let s;
    for (let i = 0; i < 600; i++) {
      s = await fk(site);
      if (s.state === 'BUILT' && s.phase === 'UNLOCKED') break;
      await deliver({ fill: false });
      await deliver({ fill: true });
      await L.sleep(2500);
    }
    const r0 = await G.feed({ L }, region, { fraction: 1, until: (st, rs) => st.view.state === 'PLACED' && rs.build?.done, timeoutMs: 900_000, every: 2500 });
    s = await fk(site);
    check(r0.last.st.view.state === 'PLACED' && s.phase === 'UNLOCKED' && exactly(s), `${name}: the town PLACED; lc_hall filled and unlocked, each hopper exactly its declaration`, s);
    // the input chest: the hoppers run along template x 1..4 at y2; the chest is at x 5, y 1 (the same z)
    const h0 = P(s.containers[0].at), h3 = P(s.containers[3].at);
    const d = [0, 1, 2].map((k) => (h3[k] - h0[k]) / 3);
    const chest = [h0[0] + 4 * d[0], h0[1] - 1, h0[2] + 4 * d[2]];
    const ch = await call('dev.fk.container', { pos: chest }, 30_000);
    check(!ch.error && sum(ch.holds) === 0, `${name}: lc_hall's undeclared input chest at ${chest.join(',')} stands empty (${json(ch)})`);
    await cmd('/kill @e[type=item]');
    return { name, gy, region, site, ps0, chest, s, dir: path.join(L.SAVES, name) };
  }

  /** Item entities within 64 of the hook's drop cell (the last late cargo handed out), or of `at` when none was handed out. */
  const near = async (at) => {
    const last = (await call('dev.removal.state', {}, 10_000).catch(() => ({}))).last;
    const pos = last?.at ? P(last.at) : at;
    return (await call('dev.items.near', { pos, radius: 64 }, 60_000)).items ?? {};
  };

  // ------------------------------------------------------------------ lc-survival

  steps.lcsurvival = async () => {
    await ensure();
    const out = {};
    // town A: the stage undo (the path a region's undoRevision takes: Groups.undoStage, ownStage)
    const A = await town('G6B LC Undo');
    if (A) {
      const s = A.s;
      const h0 = P(s.containers[0].at);
      const psA = await pile();
      // S-M5-13: the next removal ends unwritten after its custody is saved; the custody written back
      await call('dev.removal.failAfterCustody', { site: A.site }, 10_000);
      const u1 = await call('dev.removal.undoStage', { site: A.site }, 1_800_000);
      await L.settle(2000);
      const s1 = await fk(A.site);
      const ps1 = await pile();
      out.failAfterCustody = { u1, holds: s1.containers?.map((c) => c.holds), custody: s1.custody, back: backOf(ps1.ledger, psA.ledger) };
      // (the later stage, props, is undone first and refunds its own cells: only the fill site's key is judged here)
      check(u1.removed === false && /failAfterCustody/.test(json(u1)) && exactly(s1) && sum(s1.custody) === 0 && G.same(s1.paid, s.paid) && s1.state === 'BUILT',
        `S-M5-13: dev.removal.failAfterCustody: the stage undo ended unwritten after the custody take (${json(u1.blockers ?? u1.error).slice(0, 200)}); the custody written back: each hopper exactly its declaration, no custody, the site's paid record untouched (nothing credited), the site ${s1.state}`, out.failAfterCustody);
      // S-M5-12: the stage undo again, with late cargo put in right after the custody take (ticks before the restore)
      await call('dev.removal.lateCargo', { site: A.site, pos: A.chest, items: { [DIAMOND]: 3 } }, 10_000);
      await call('dev.removal.lateCargo', { site: A.site, pos: h0, items: { [FLINT]: 5 } }, 10_000);
      const u2 = await call('dev.removal.undoStage', { site: A.site }, 1_800_000);
      await L.settle(3000);
      const st2 = await call('dev.removal.state', {}, 10_000);
      const items2 = await near(h0);
      out.undoLate = { u2, last: st2.last, items: only(items2, [DIAMOND, ...FK]) };
      check(u2.removed === true, `the stage undo with late cargo armed: removed (${json(u2).slice(0, 200)})`, u2);
      check((items2[DIAMOND] ?? 0) === 3 && (items2[FLINT] ?? 0) === 5 && sum(only(items2, FK)) === 5,
        `S-M5-12 (undo): the late cargo is not erased: 3 diamonds put into the input chest (a non-fill container) and 5 flint into the emptied declared hopper after the custody take are handed out at the site (items near: ${json(out.undoLate.items)}; the hook's record ${json(st2.last)})`, out.undoLate);
      const rmA = await G.remove(ctx, A.region);
      const psA2 = await pile();
      const consumed = G.minus(psA.ledger?.consumed ?? {}, A.ps0.ledger?.consumed ?? {});
      const back = backOf(psA2.ledger, psA.ledger);
      out.undoBack = { rm: rmA?.removed ?? rmA, back: sum(back), consumed: sum(consumed), diff: G.minus(back, consumed), custody: psA2.ledger?.custody ?? null };
      check(G.same(back, consumed) && !psA2.ledger?.custody,
        `the stage undo then the region's removal: what came back = what the town consumed, item for item (${sum(back)} = ${sum(consumed)}; differ ${json(out.undoBack.diff)}); no custody left`, out.undoBack);
      await L.leaveWorld();
    }
    // town B: the region Remove (the whole group's undo)
    const B = await town('G6B LC Remove');
    if (B) {
      const h2 = P(B.s.containers[2].at);
      const psB = await pile();
      await call('dev.removal.lateCargo', { site: B.site, pos: B.chest, items: { [DIAMOND]: 2 } }, 10_000);
      await call('dev.removal.lateCargo', { site: B.site, pos: h2, items: { [BONE]: 4 } }, 10_000);
      const rm = await G.remove(ctx, B.region);
      await L.settle(3000);
      const st = await call('dev.region.state', { region: B.region }, 60_000).catch(() => null);
      const psB2 = await pile();
      const consumed = G.minus(psB.ledger?.consumed ?? {}, B.ps0.ledger?.consumed ?? {});
      const back = backOf(psB2.ledger, psB.ledger);
      const items = await near(h2);
      const last = (await call('dev.removal.state', {}, 10_000)).last;
      out.removeLate = { rm: rm?.removed ?? rm, state: st?.view?.state ?? 'gone', back: sum(back), consumed: sum(consumed), diff: G.minus(back, consumed), items: only(items, [DIAMOND, ...FK]), last, custody: psB2.ledger?.custody ?? null };
      check((items[DIAMOND] ?? 0) === 2 && (items[BONE] ?? 0) === 4 && sum(only(items, FK)) === 4,
        `S-M5-12 (Remove): the late cargo is not erased: 2 diamonds in the input chest and 4 bone in the emptied declared hopper, put in after the custody take, handed out at the site (items near: ${json(out.removeLate.items)}; record ${json(last)})`, out.removeLate);
      check(['REMOVED', 'gone'].includes(out.removeLate.state) && G.same(back, consumed) && !psB2.ledger?.custody,
        `the region removed (${out.removeLate.state}): what came back = what the town consumed, item for item (${sum(back)} = ${sum(consumed)}; differ ${json(out.removeLate.diff)}); no custody left`, out.removeLate);
      await L.leaveWorld();
    }
    spendZero();
    return out;
  };

  // ------------------------------------------------------------------ lc-crash

  steps.lccrash = async () => {
    await ensure();
    const out = {};
    if (process.env.GATE_LC_ONLY === 'lc3') { // (fix b5b) the atomic path's case alone
      out.LC3 = await cargoAtCreditSave();
      spendZero();
      return out;
    }
    if (process.env.GATE_LC_ONLY === 'lc4') { // (LC2) the sliced restore's case alone
      out.LC4 = await replayOverTerrainChest();
      spendZero();
      return out;
    }
    const W = await town('G6B LC Crash');
    if (!W) return out;
    const at = P(W.s.containers[0].at);
    await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
    await cmd('/save-all flush');
    const B = savedLedger(W.name);
    const consumed = G.minus(B.consumed, W.ps0.ledger?.consumed ?? {});
    await call('dev.removal.failAfterCustody', { site: W.site }, 10_000);
    await call('dev.journal.killAt', { point: 'LC1' }, 10_000);
    call('dev.region.remove', { region: W.region, requester: G.OWNER }, 600_000).catch(() => null);
    const down = await haltWait();
    check(down, 'LC1: the kill point halted the server (the custody saved, then written back in memory only)');
    if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await L.leaveWorld(); return out; }
    const S = savedLedger(W.name);
    const savedCustody = Object.values(S.custody ?? {}).reduce((a, m) => G.plus(a, m), {});
    check(sum(savedCustody) > 0, `LC1: the custody was on disk at the halt (${json(savedCustody)})`);
    await L.openWorld(W.name);
    await L.tp(CX + 80, 60, CZ + 56);
    await L.settle(4000);
    const s0 = await fk(W.site).catch(() => null);
    out.afterRestart = { phase: s0?.phase, holds: s0?.containers?.map((c) => c.holds), custody: s0?.custody };
    log(`  LC1 after the restart: ${json(out.afterRestart)}`);
    // the removal resumes from the queue file, or (not saved) the custody went back at load and it is asked again: the retry
    let st = await call('dev.region.state', { region: W.region }, 60_000).catch(() => null);
    for (let i = 0; i < 600 && st?.view && !['REMOVED', 'PARTIAL', 'FAILED'].includes(st.view.state); i++) {
      if (i === 15 && st.view.state === 'PLACED') {
        check(exactly(await fk(W.site)), 'LC1: the region stands after the restart: its hoppers hold exactly their declarations (the custody written back at load) before the retry');
        await G.remove(ctx, W.region);
      }
      await L.sleep(1000);
      st = await call('dev.region.state', { region: W.region }, 60_000).catch(() => null);
    }
    await L.settle(2000);
    const F = (await pile()).ledger;
    const back = backOf(F, B);
    const items = (await call('dev.items.near', { pos: at, radius: 64 }, 60_000)).items ?? {};
    out.LC1 = { savedCustody, state: st?.view?.state ?? 'gone', back: sum(back), consumed: sum(consumed), diff: G.minus(back, consumed), items: only(items, FK), custody: F.custody ?? null };
    check(['REMOVED', 'gone'].includes(out.LC1.state) && G.same(back, consumed) && !F.custody && sum(only(items, FK)) === 0,
      `LC1: after the restart and the retry the removal ends once (${out.LC1.state}): what came back = what the town consumed, item for item (${sum(back)} = ${sum(consumed)}; differ ${json(out.LC1.diff)}): items in = items out; no custody; none of the fill's items dropped`, out.LC1);
    await L.leaveWorld();
    out.LC2 = await failThenHalt();
    out.LC3 = await cargoAtCreditSave();
    out.LC4 = await replayOverTerrainChest();
    spendZero();
    return out;
  };

  /** (LC2) lc_big: a 48-cube creative site (its restore box over SYNC_CELLS: removed by a sliced RestoreJob) with a chest and a lectern. */
  async function bigEntry() {
    const { Blueprint, PALETTES } = await h.imp('lib/kit.mjs');
    const { writeBlueprint } = await h.imp('lib/write.mjs');
    const bp = new Blueprint({ id: 'lc_big', name: 'LC Big', description: 'A large test box with a chest and a lectern (slice LC2).', type: 'storage_hall',
      profile: [], tags: ['test'], size: [48, 48, 48], groundY: 1, front: 'south', palette: PALETTES.rustic, approach: false });
    bp.part('floor', () => { for (let x = 0; x < 48; x++) for (let z = 0; z < 48; z++) bp.set(x, 0, z, 'minecraft:stone'); });
    bp.part('core', () => { bp.set(2, 1, 2, 'minecraft:chest', { facing: 'south' }); bp.set(4, 1, 2, 'minecraft:lectern', { facing: 'south' }); });
    const dir = path.join(L.LIBRARY, 'lc_big');
    fs.rmSync(dir, { recursive: true, force: true });
    const w = writeBlueprint(bp, dir);
    const j = JSON.parse(fs.readFileSync(w.jsonPath, 'utf8'));
    j.givenProgram = { sha: 'gate-fixture', opKey: 'gate.lc.big' };
    fs.writeFileSync(w.jsonPath, `${JSON.stringify(j, null, 2)}\n`);
    await L.cmd('/architect reload');
    await L.settle(1500);
  }

  const holderAt = (pos) => call('dev.removal.holder', { pos }, 10_000).catch((e) => ({ error: String(e) }));
  const total = (hd, item) => (hd?.slots ?? []).filter((s) => s[1] === item).reduce((n, s) => n + s[2], 0);
  async function pauseWait(site, cond) {
    for (let i = 0; i < 300; i++) {
      const st = (await call('dev.removal.state', {}, 10_000)).pause?.[site];
      if (st && cond(st)) return st;
      await L.sleep(500);
    }
    return null;
  }

  /**
   * (LC2, the v0.73.0 RC fix review's #5 and LC-2 #4/#6) LC4, creative: a terrain barrel holding 2 diamonds, lc_big forced over it (its own
   * chest replaces it; the snapshot keeps the barrel's diamonds; a chest of the same state would keep its block entity, a blocker at removal). The removal (a sliced RestoreJob) paused before any write
   * (dev.removal.pause): late cargo after the blocker scan, ticks before the writes: 2 diamonds into the site's own chest in the slot the
   * terrain's sit in (contents equal to the restored ones), a book on its own lectern, and a new chest with 3 flint at an unwritten cell
   * (a holder placed between a sliced restore's ticks). Resumed, it stops right after writing the own chest (the terrain's 2 diamonds back,
   * its write mark set); the 2 restored diamonds moved to slot 5 (a player's menu); /save-all flush; the JVM halted; the restart writes
   * the restore again from its start. Judged after it: diamonds = 4 (the terrain's 2 in the chest, the late 2 handed out; before LC2: 2,
   * the late ones erased; per slot or without the mark: 6); the book and the 3 flint handed out once; the new chest gone with the write.
   */
  async function replayOverTerrainChest() {
    const name = 'G6B LC Replay';
    await L.fresh(name, G.FLAT);
    await L.setRules('exact');
    await bigEntry();
    await call('dev.removal.state', { clear: true }, 10_000);
    const g = await groundY(CX, CZ);
    const origin = [CX, g, CZ];
    await L.tp(CX + 24, g + 40, CZ - 16);
    await L.settle(2000);
    const v = await call('dev.pl.place', { blueprint: 'lc_big', origin, mode: 'instant', check: true }, 300_000);
    const b = v.box;
    check(Array.isArray(b), `LC4: lc_big's box at ${json(origin)}: ${json(b)} (${json(v.refusals ?? []).slice(0, 200)})`, v);
    if (!Array.isArray(b)) { await L.leaveWorld(); return null; }
    const PC = [b[0] + 2, b[1] + 1, b[2] + 2], PL = [b[0] + 4, b[1] + 1, b[2] + 2], PR = [b[0] + 20, b[1] + 1, b[2] + 20];
    const mid = [Math.floor((b[0] + b[3]) / 2), b[1], Math.floor((b[2] + b[5]) / 2)];
    await cmd(`/setblock ${PC.join(' ')} minecraft:barrel`); // another block: the site's chest replaces it (the snapshot keeps its diamonds)
    const t0 = await call('dev.removal.holder', { pos: PC, items: { [DIAMOND]: 2 } }, 10_000);
    check(total(t0, DIAMOND) === 2, `LC4: a terrain barrel at ${PC.join(',')} holds 2 diamonds (${json(t0.slots)})`, t0);
    const p = await call('dev.pl.place', { blueprint: 'lc_big', origin, mode: 'instant', force: true }, 900_000);
    let own = null;
    for (let i = 0; i < 240 && p.placed; i++) {
      const rec = await call('dev.pl.record', { site: p.site }, 10_000).catch(() => null);
      own = await holderAt(PC);
      if (rec && !rec.refused && own.holder && total(own, DIAMOND) === 0 && !Sites_placing(rec)) break;
      await L.sleep(1000);
    }
    check(p.placed && own?.holder && total(own, DIAMOND) === 0, `LC4: lc_big forced over it (${p.site}): its own chest stands there empty (${json(own)})`, { p, own });
    if (!p.placed) { await L.leaveWorld(); return null; }
    const site = p.site;
    await cmd('/kill @e[type=item]');
    await call('dev.removal.pause', { site }, 10_000);
    call('dev.pl.remove', { site }, 1_800_000).catch(() => null);
    const w0 = await pauseWait(site, (s) => s.waiting);
    check(!!w0, `LC4: the removal's restore paused before any write (${json(w0)})`);
    // late cargo, after the blocker scan, ticks before the writes
    const a = await call('dev.removal.holder', { pos: PC, items: { [DIAMOND]: 2 } }, 10_000);
    const l = await call('dev.removal.holder', { pos: PL, items: { 'minecraft:writable_book': 1 } }, 10_000);
    await cmd(`/setblock ${PR.join(' ')} minecraft:chest`);
    const r = await call('dev.removal.holder', { pos: PR, items: { [FLINT]: 3 } }, 10_000);
    check(total(a, DIAMOND) === 2 && total(l, 'minecraft:writable_book') === 1 && total(r, FLINT) === 3,
      `LC4: late cargo while paused: 2 diamonds in the site's own chest (slot 0, as the terrain's), a book on its own lectern, a new chest with 3 flint at ${PR.join(',')}`, { a, l, r });
    await call('dev.removal.pause', { site, after: PC }, 10_000);
    const w1 = await pauseWait(site, (s) => s.reached && s.waiting);
    const m0 = await holderAt(PC);
    check(!!w1 && total(m0, DIAMOND) === 2, `LC4: the restore stopped right after writing the own chest's cell: the terrain barrel back with its 2 diamonds (${json(m0.slots)})`, { w1, m0 });
    const mv = await call('dev.removal.holder', { pos: PC, move: [0, 5] }, 10_000);
    const nearMid = (await call('dev.items.near', { pos: mid, radius: 64 }, 60_000)).items ?? {};
    log(`  LC4 before the halt: chest ${json(mv.slots)}; items near ${json(nearMid)}`);
    await cmd('/save-all flush');
    await L.settle(1500);
    await call('dev.stockpile.halt', { mode: 'now' }, 10_000).catch(() => null);
    const down = await haltWait();
    check(down, 'LC4: halted mid-restore (the moved diamonds and the drops so far on disk)');
    if (!down) { await L.leaveWorld(); return null; }
    await L.openWorld(name);
    await L.tp(CX + 24, g + 40, CZ - 16);
    await L.settle(4000);
    let rec = null;
    for (let i = 0; i < 300; i++) {
      rec = await call('dev.pl.record', { site }, 10_000).catch(() => null);
      if (!rec || rec.refused || rec.error) break;
      await L.sleep(1000);
    }
    await L.settle(3000);
    const end = await holderAt(PC);
    const items = (await call('dev.items.near', { pos: mid, radius: 64 }, 60_000)).items ?? {};
    const rEnd = await holderAt(PR);
    const res = { chest: end.slots ?? null, items: only(items, [DIAMOND, FLINT, 'minecraft:writable_book']), rAfter: rEnd.holder ?? null, recordAfter: rec };
    log(`  LC4 after the restart: ${json(res)}`);
    const diamonds = total(end, DIAMOND) + (items[DIAMOND] ?? 0);
    check(total(end, DIAMOND) === 2 && (items[DIAMOND] ?? 0) === 2,
      `LC4: the own chest's matching late cargo handed out and the moved restored diamonds not taken again: the terrain's 2 in the chest, the late 2 at the site (${diamonds} of 4; before LC2 2, per slot or without the write mark 6)`, res);
    check((items['minecraft:writable_book'] ?? 0) === 1 && (items[FLINT] ?? 0) === 3 && !res.rAfter,
      `LC4: the lectern's book and the 3 flint of the chest placed between ticks handed out once; that chest gone with the write (${json(res)})`, res);
    await L.leaveWorld();
    return res;
  }

  /** Whether a dev.pl.record answer is a site still being placed. */
  function Sites_placing(rec) { return rec?.placing === true; }

  /**
   * (fix b5b, the GPT review's finding 2) LC3: the lc_hall site removed on its own (dev.pl.remove: Sites.removeDetailed, the atomic path, a
   * stockpile deconstruct) with late cargo armed (3 diamonds into its input chest right after the custody take), halted at CS1 inside its
   * credit's save (the players and the restored chunks with their entities on disk, the ledger not). Before the fix the cargo dropped after
   * that save: the restart found the chest gone and no diamonds. Judged: exactly the 3 diamonds at the site after the restart (none lost,
   * none twice); the credit booked once (what came back = the site's paid record); none of the fill's items dropped.
   */
  async function cargoAtCreditSave() {
    const W = await town('G6B LC Crash LC3');
    if (!W) return null;
    await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
    await cmd('/kill @e[type=item]');
    await cmd('/save-all flush');
    const B = savedLedger(W.name);
    const key = Object.keys(B.paid ?? {}).find((k) => k.startsWith(`site:${W.site}@`));
    const paid = B.paid?.[key] ?? {};
    check(!!key && sum(paid) > 0, `LC3: ${W.site}'s paid record on disk: ${key} (${sum(paid)} units)`);
    await call('dev.removal.lateCargo', { site: W.site, pos: W.chest, items: { [DIAMOND]: 3 } }, 10_000);
    await call('dev.journal.killAt', { point: 'CS1' }, 10_000);
    call('dev.pl.remove', { site: W.site, requester: G.OWNER, force: false }, 600_000).catch(() => null);
    const down = await haltWait();
    check(down, 'LC3: the kill point CS1 halted the server inside the removal credit\'s save');
    if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await L.leaveWorld(); return null; }
    const S = savedLedger(W.name);
    check(!!S.pendingCredit?.[key], `LC3: at the halt the saved ledger holds ${key}'s credit pending`, S.pendingCredit?.[key] ?? null);
    await L.openWorld(W.name);
    await L.tp(W.chest[0], W.chest[1] + 2, W.chest[2]);
    await L.settle(4000);
    const F = (await pile()).ledger;
    const back = backOf(F, B);
    const items = (await call('dev.items.near', { pos: W.chest, radius: 64 }, 60_000)).items ?? {};
    const ch = await call('dev.fk.container', { pos: W.chest }, 30_000).catch(() => ({ error: 'none' }));
    const res = { key, paid: sum(paid), back: sum(back), diff: G.minus(back, paid), diamonds: items[DIAMOND] ?? 0, fill: only(items, FK), chest: ch.error ? 'gone' : ch.holds,
      pending: F.pendingCredit?.[key] ?? null };
    log(`  LC3 after the restart: ${json(res)}`);
    check(res.diamonds === 3, `LC3: the late cargo survives the halt inside the credit's save: ${res.diamonds} of 3 diamonds at the site after the restart (none lost, none twice; the chest ${json(res.chest)})`, res);
    check(G.same(back, paid) && !res.pending && sum(res.fill) === 0,
      `LC3: the credit booked once: what came back = ${W.site}'s paid record, item for item (${sum(back)} = ${sum(paid)}; differ ${json(res.diff)}); nothing pending; none of the fill's items dropped`, res);
    await L.leaveWorld();
    return res;
  }

  /**
   * LC2: dev.removal.failAfterCustody with no kill point: the region Remove answers unwritten (the custody written back in memory), then
   * the JVM is halted with nothing saved since. After the restart: the custody on disk goes back at load (the region stands, its hoppers
   * exactly their declarations, no custody), or, should the failed removal still be queued, it resumes (reported, not hidden); then the
   * retry: back = consumed, item for item.
   */
  async function failThenHalt() {
    const W = await town('G6B LC Crash LC2');
    if (!W) return null;
    const at = P(W.s.containers[0].at);
    await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
    await cmd('/save-all flush');
    const B = savedLedger(W.name);
    const consumed = G.minus(B.consumed, W.ps0.ledger?.consumed ?? {});
    await call('dev.removal.failAfterCustody', { site: W.site }, 10_000);
    const rm = await call('dev.region.remove', { region: W.region, requester: G.OWNER }, 600_000).catch((e) => ({ error: String(e) }));
    const s1 = await fk(W.site);
    check(rm.removed !== true && /failAfterCustody/.test(json(rm)) && exactly(s1) && sum(s1.custody) === 0,
      `LC2: the region Remove answered unwritten after its custody take (${json(rm).slice(0, 200)}); the custody written back in memory (hoppers exactly their declarations, no custody)`, { rm, s1 });
    await call('dev.stockpile.halt', { mode: 'now' }, 10_000).catch(() => null);
    const down = await haltWait();
    check(down, 'LC2: dev.stockpile.halt halted the server, nothing saved since the write-back');
    if (!down) { await L.leaveWorld(); return null; }
    const S = savedLedger(W.name);
    const savedCustody = Object.values(S.custody ?? {}).reduce((a, m) => G.plus(a, m), {});
    await L.openWorld(W.name);
    await L.tp(CX + 80, 60, CZ + 56);
    await L.settle(4000);
    const st0 = await call('dev.region.state', { region: W.region }, 60_000).catch(() => null);
    const s2 = await fk(W.site).catch(() => null);
    const F0 = (await pile()).ledger;
    const res = { savedCustody, stateAfterRestart: st0?.view?.state ?? 'gone', holds: s2?.containers?.map((c) => c.holds), custody: F0.custody ?? null };
    log(`  LC2 after the restart: ${json(res)}`);
    check(res.stateAfterRestart === 'PLACED' && s2 && exactly(s2) && !F0.custody,
      `LC2: after the restart the region still stands (${res.stateAfterRestart}; the failed removal is not resumed) and the custody on disk (${sum(savedCustody)} units) went back at load: hoppers exactly their declarations, no custody`, res);
    if (res.stateAfterRestart === 'PLACED') await G.remove(ctx, W.region);
    let st = await call('dev.region.state', { region: W.region }, 60_000).catch(() => null);
    for (let i = 0; i < 300 && st?.view && !['REMOVED', 'PARTIAL', 'FAILED'].includes(st.view.state); i++) {
      await L.sleep(1000);
      st = await call('dev.region.state', { region: W.region }, 60_000).catch(() => null);
    }
    await L.settle(2000);
    const F = (await pile()).ledger;
    const back = backOf(F, B);
    const items = (await call('dev.items.near', { pos: at, radius: 64 }, 60_000)).items ?? {};
    Object.assign(res, { state: st?.view?.state ?? 'gone', back: sum(back), consumed: sum(consumed), diff: G.minus(back, consumed), items: only(items, FK), custodyEnd: F.custody ?? null });
    check(['REMOVED', 'gone'].includes(res.state) && G.same(back, consumed) && !F.custody && sum(only(items, FK)) === 0,
      `LC2: write-back, restart, retry: the removal ends once (${res.state}): what came back = what the town consumed, item for item (${sum(back)} = ${sum(consumed)}; differ ${json(res.diff)}); no custody; none of the fill's items dropped`, res);
    await L.leaveWorld();
    return res;
  }
}
