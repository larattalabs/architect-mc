// Slice LC3 gate (docs/CONTRACT.md "### Slice LC3 as built"; Steward's S-M5-12): a removal's boxes are SEALED, no item enters a holder
// there until the removal ends. Registered into tools/gate6dgr.mjs. Headless server, creative, the sim sidecar: $0. Strict (removal, crash).
//
//   node tools/gate6dgr.mjs lc3seal  (lc3-seal)  lc3_big, a 48-cube creative site (a sliced RestoreJob removes it) with a chest C on its north
//                                                edge and a lectern. C's menu opened before the removal; the removal paused before any
//                                                write (dev.removal.pause). While paused: C's open menu is closed (stillValid false); a
//                                                hopper set outside the box with 4 diamonds pushes nothing into C; a hopper set inside picks
//                                                up no item entity; a Transfer API insert into C inserts 0; the player's hand into C (no menu),
//                                                a book onto the lectern, beef onto a campfire, a diamond into a decorated pot, a shelf, a disc
//                                                into a jukebox, a book into a chiseled bookshelf, a filled shulker box placed on the floor, a
//                                                diamond into an item frame: every one refused, the item still in the hand (or the source).
//                                                Then the restore resumed to 1000 cells and paused again, saved, the JVM halted: after the
//                                                restart the same box is sealed (from the queue file) and refuses again. Resumed: removed; the
//                                                seal lifts (a chest set at C takes the outside hopper's 4 diamonds; a hand opens its menu).
//   node tools/gate6dgr.mjs lc3undo  (lc3-undo)  a creative flat_village town (cottage_1 = rs_hut). A stage undo as a revision undoes its own
//                                                stage (Groups.undoStage, ownStage) and then the region Remove (the group undo), each paused
//                                                in its first member's restore: a chest set inside a sealed box refuses the player's hand and a
//                                                Transfer API insert; resumed, each ends removed and the seal lifts.
//
// Evidence: artifacts/gate6d-gr/<step>.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';

const DIAMOND = 'minecraft:diamond';
const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];

export async function registerLC3(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, CX, CZ, CLAIM, haltWait } = h;
  const ctx = { L, OUT: h.OUT, imp: h.imp };
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const seal = () => call('dev.seal.state', {}, 10_000);
  const holder = (pos) => call('dev.seal.holder', { pos }, 10_000).catch((e) => ({ error: String(e) }));
  const use = (pos, item, extra = {}) => call('dev.seal.use', { pos, item, ...extra }, 30_000).catch((e) => ({ error: String(e) }));
  const boxOf = (st, id) => (st.sealed ?? []).find((x) => x.id === id)?.box?.split(' ').map((c) => c.split(',').map(Number));
  /** A refused use: nothing in the holder, the item still in the hand, no menu, a refusal counted. */
  const refused = (u, item, n = 1) => !u.error && !u.menuOpened && u.hand?.item === item && u.hand?.count === n && sum(u.after?.holds) === sum(u.before?.holds) && u.refused > 0;
  async function until(f, tries = 240, ms = 500) {
    for (let i = 0; i < tries; i++) {
      const v = await f();
      if (v) return v;
      await L.sleep(ms);
    }
    return null;
  }

  /** lc3_big: a 48-cube creative site (its restore box over SYNC_CELLS: a sliced RestoreJob) with a chest on its north edge and a lectern. */
  async function bigEntry() {
    const { Blueprint, PALETTES } = await h.imp('lib/kit.mjs');
    const { writeBlueprint } = await h.imp('lib/write.mjs');
    const bp = new Blueprint({ id: 'lc3_big', name: 'LC3 Big', description: 'A large test box with a chest and a lectern (slice LC3).', type: 'storage_hall',
      profile: [], tags: ['test'], size: [48, 48, 48], groundY: 1, front: 'south', palette: PALETTES.rustic, approach: false });
    bp.part('floor', () => { for (let x = 0; x < 48; x++) for (let z = 0; z < 48; z++) bp.set(x, 0, z, 'minecraft:stone'); });
    bp.part('core', () => {
      bp.set(2, 1, 0, 'minecraft:chest', { facing: 'south' });
      bp.set(4, 1, 2, 'minecraft:lectern', { facing: 'south' });
      bp.set(22, 1, 2, 'minecraft:stone'); // an item frame's support
    });
    const dir = path.join(L.LIBRARY, 'lc3_big');
    fs.rmSync(dir, { recursive: true, force: true });
    const w = writeBlueprint(bp, dir);
    const j = JSON.parse(fs.readFileSync(w.jsonPath, 'utf8'));
    j.givenProgram = { sha: 'gate-fixture', opKey: 'gate.lc3.big' };
    fs.writeFileSync(w.jsonPath, `${JSON.stringify(j, null, 2)}\n`);
    await L.cmd('/architect reload');
    await L.settle(1500);
  }

  /** Every insertion path into the paused removal's box, refused; answers the per-path results. */
  async function attempts(tag, b, C, L4) {
    const at = (dx, dy, dz) => [b[0] + dx, b[1] + dy, b[2] + dz];
    const r = {};
    // the hand into C (opening its menu), the lectern, and holders set now inside the box
    r.chest = await use(C, DIAMOND);
    r.lectern = await use(L4, 'minecraft:writable_book');
    const set = async (rel, block) => { const p = at(...rel); await cmd(`/setblock ${p.join(' ')} ${block}`); return p; };
    r.campfire = await use(await set([10, 1, 2], 'minecraft:campfire[lit=true]'), 'minecraft:beef');
    r.pot = await use(await set([12, 1, 2], 'minecraft:decorated_pot'), DIAMOND);
    r.bookshelf = await use(await set([14, 1, 2], 'minecraft:chiseled_bookshelf[facing=south]'), 'minecraft:book', { face: 'south' });
    r.jukebox = await use(await set([16, 1, 2], 'minecraft:jukebox'), 'minecraft:music_disc_cat');
    r.shelf = await use(await set([18, 1, 2], 'minecraft:oak_shelf[facing=south]'), DIAMOND, { face: 'south' });
    r.barrel = await use(await set([20, 1, 6], 'minecraft:barrel'), DIAMOND);
    for (const [k, item] of [['chest', DIAMOND], ['lectern', 'minecraft:writable_book'], ['campfire', 'minecraft:beef'], ['pot', DIAMOND], ['bookshelf', 'minecraft:book'],
      ['jukebox', 'minecraft:music_disc_cat'], ['shelf', DIAMOND], ['barrel', DIAMOND]]) {
      check(refused(r[k], item), `${tag}: the player's ${item} into the ${k} in the removal's box refused (${r[k].result}): still in the hand (${json(r[k].hand)}), the holder as before (${json(r[k].after?.holds)}), no menu`, r[k]);
    }
    // a filled shulker box placed on the floor inside the box
    const fl = at(26, 0, 6);
    r.shulker = await use(fl, 'minecraft:shulker_box', { contents: { [DIAMOND]: 2 }, face: 'up' });
    check(!r.shulker.error && r.shulker.nextAfter === r.shulker.nextBefore && r.shulker.hand?.item === 'minecraft:shulker_box' && r.shulker.refused > 0,
      `${tag}: a shulker box holding 2 diamonds placed into the box refused (${r.shulker.nextBefore} -> ${r.shulker.nextAfter}, the hand ${json(r.shulker.hand)})`, r.shulker);
    // an item frame hanging inside the box
    const fr = at(22, 1, 3);
    await cmd(`/summon minecraft:item_frame ${fr.join(' ')} {Facing:3b}`);
    await L.settle(500);
    r.frame = await call('dev.seal.frame', { pos: fr, item: DIAMOND }, 30_000).catch((e) => ({ error: String(e) }));
    check(!r.frame.error && r.frame.frameItem?.count === 0 && r.frame.hand?.item === DIAMOND && r.frame.hand?.count === 1,
      `${tag}: a diamond into an empty item frame in the box refused (${r.frame.result}): the frame empty, the diamond in the hand`, r.frame);
    // the Fabric Transfer API (a pipe mod) into C
    r.transfer = await call('dev.seal.transfer', { pos: C, item: DIAMOND, count: 2 }, 30_000).catch((e) => ({ error: String(e) }));
    check(r.transfer.guardApplied && r.transfer.inserted === 0 && sum(r.transfer.holder?.holds) === 0, `${tag}: a Transfer API insert of 2 diamonds into C inserts 0 (${json(r.transfer)})`, r.transfer);
    return r;
  }

  // ------------------------------------------------------------------ lc3-seal

  steps.lc3seal = async () => {
    await ensure();
    const name = 'G6B LC3 Seal';
    const out = {};
    await L.fresh(name, G.FLAT);
    await L.setRules('exact');
    await bigEntry();
    const g = await groundY(CX, CZ);
    const origin = [CX, g, CZ];
    const view = [CX + 24, g + 40, CZ - 16];
    await L.tp(...view);
    await L.settle(2000);
    const v = await call('dev.pl.place', { blueprint: 'lc3_big', origin, mode: 'instant', check: true }, 300_000);
    const b = v.box;
    check(Array.isArray(b), `lc3_big's box at ${json(origin)}: ${json(b)} (${json(v.refusals ?? []).slice(0, 200)})`, v);
    if (!Array.isArray(b)) { await L.leaveWorld(); return out; }
    const p = await call('dev.pl.place', { blueprint: 'lc3_big', origin, mode: 'instant' }, 900_000);
    // placed once its record stands and no job runs (a 48-cube site places over ticks)
    const ready = p.placed && await until(async () => {
      const rec = await call('dev.pl.record', { site: p.site }, 10_000).catch(() => null);
      const st = await seal();
      return rec && !rec.error && !(st.jobs ?? []).length ? true : null;
    }, 300, 1000);
    check(p.placed && !!ready, `lc3_big placed (${p.site}) at ${json(b)}`, p);
    if (!ready) { await L.leaveWorld(); return out; }
    const site = p.site;
    const C = [b[0] + 2, b[1] + 1, b[2]], L4 = [b[0] + 4, b[1] + 1, b[2] + 2];
    out.c0 = await holder(C);
    check(out.c0.holder && sum(out.c0.holds) === 0 && !out.c0.sealed, `C at ${C.join(',')} is the site's empty chest, not sealed before the removal (${json(out.c0)})`, out.c0);
    // the menu opened before the removal began (the player within reach of C, outside the box: the menu is valid by distance)
    await L.tp(C[0] + 0.5, C[1], C[2] - 4);
    await L.settle(1000);
    const m0 = await call('dev.seal.menu', { pos: C, open: true }, 10_000);
    check(m0.open && m0.valid, `C's menu open for the player before the removal (${json(m0)})`, m0);
    await call('dev.removal.pause', { site, after: 0 }, 10_000);
    call('dev.pl.remove', { site }, 1_800_000).then((x) => { out.removeAnswer = x; }).catch((e) => { out.removeAnswer = { error: String(e) }; });
    const s0 = await until(async () => { const st = await seal(); return boxOf(st, site) ? st : null; });
    check(!!s0, `the removal of ${site} started (a sliced RestoreJob) and its box is sealed (${json(s0?.sealed)})`, s0);
    if (!s0) { await L.leaveWorld(); return out; }
    const sb = boxOf(s0, site);
    log(`  sealed box ${json(sb)}; jobs ${json(s0.jobs)}`);
    await L.settle(1000);
    // the open menu: invalid, closed by the server's tick
    out.menu = await call('dev.seal.menu', { pos: C }, 10_000);
    check(!out.menu.open || !out.menu.valid, `C's open menu no longer valid once sealed: its clicks refused, closed (${json(out.menu)})`, out.menu);
    // automation: a hopper set just outside the box, north of C, holding 4 diamonds, facing C
    const outside = [C[0], C[1], sb[0][2] - 1];
    check(sb[0][2] === C[2], `C stands on the sealed box's north face (z ${C[2]} = ${sb[0][2]}): ${outside.join(',')} is outside`);
    await cmd(`/setblock ${outside.join(' ')} minecraft:hopper[facing=south]{Items:[{Slot:0b,id:"${DIAMOND}",count:4}]}`);
    // a hopper set inside the box, an item entity dropped on it
    const hin = [b[0] + 30, b[1] + 1, b[2] + 2];
    await cmd(`/setblock ${hin.join(' ')} minecraft:hopper[facing=down]`);
    await cmd(`/summon minecraft:item ${hin[0] + 0.5} ${hin[1] + 1.2} ${hin[2] + 0.5} {Item:{id:"minecraft:flint",count:3},PickupDelay:32767s}`);
    await L.settle(4000);
    const ho = await holder(outside), hc = await holder(C), hi = await holder(hin);
    const near = (await call('dev.items.near', { pos: hin, radius: 2 }, 60_000)).items ?? {};
    out.automation = { outside: ho.holds, C: hc.holds, inside: hi.holds, near };
    check(ho.holds?.[DIAMOND] === 4 && sum(hc.holds) === 0, `the outside hopper pushed nothing into sealed C in 4 s: it holds its 4 diamonds, C ${json(hc.holds)}`, out.automation);
    check(sum(hi.holds) === 0 && near['minecraft:flint'] === 3, `the hopper inside the box picked up none of the 3 flint lying on it (still an item entity: ${json(near)})`, out.automation);
    await cmd(`/kill @e[type=item,x=${hin[0]},y=${hin[1]},z=${hin[2]},distance=..3]`); // (an item thrown into a box being removed: the drop clear's, a leftover)
    out.paused = await attempts('paused', b, C, L4);
    // across a crash: the restore resumed to 1000 cells and paused again, saved, halted; the restart re-seals the box from the queue file
    await call('dev.removal.pause', { site, after: 1000 }, 10_000);
    const mid = await until(async () => { const st = await seal(); const j = (st.jobs ?? []).find((x) => x.site === site); return j && j.progress >= 1000 ? j : null; });
    check(!!mid, `the restore wrote ${mid?.progress} cells and paused mid-write (${json(mid)})`, mid);
    await cmd('/save-all flush');
    await L.settle(1500);
    await call('dev.stockpile.halt', { mode: 'now' }, 10_000).catch(() => null);
    const down = await haltWait();
    check(down, 'halted mid-removal (nothing saved after the flush)');
    if (!down) { await L.leaveWorld(); return out; }
    await L.openWorld(name);
    await L.tp(...view);
    await L.settle(4000);
    const s1 = await until(async () => { const st = await seal().catch(() => null); return st && boxOf(st, site) ? st : null; }, 60, 1000);
    out.afterRestart = { sealed: s1?.sealed ?? null, jobs: s1?.jobs ?? null, pause: s1?.pause ?? null };
    check(!!s1 && json(boxOf(s1, site)) === json(sb), `after the restart the removal resumes from the queue file and the same box is sealed again (${json(out.afterRestart)})`, out.afterRestart);
    const u1 = await use(C, DIAMOND);
    check(refused(u1, DIAMOND), `after the restart: the player's diamond into C refused (still in the hand, C ${json(u1.after?.holds)})`, u1);
    const t1 = await call('dev.seal.transfer', { pos: C, item: DIAMOND, count: 2 }, 30_000).catch((e) => ({ error: String(e) }));
    check(t1.inserted === 0, `after the restart: a Transfer API insert into C inserts 0 (${json(t1)})`, t1);
    await L.settle(3000);
    const ho1 = await holder(outside), hc1 = await holder(C);
    check(ho1.holds?.[DIAMOND] === 4 && sum(hc1.holds) === 0, `after the restart the outside hopper still holds its 4 diamonds, C nothing (${json(ho1.holds)} / ${json(hc1.holds)})`, { ho1, hc1 });
    out.afterRestart.use = u1;
    // resumed: removed; the seal lifts
    await call('dev.removal.pause', { site, off: true }, 10_000);
    const gone = await until(async () => { const r = await call('dev.pl.record', { site }, 10_000).catch(() => null); return !r || r.refused || r.error ? true : null; }, 300, 1000);
    check(!!gone, `resumed: ${site} removed (its record gone)`);
    await L.settle(3000);
    const s2 = await seal();
    check(!(s2.sealed ?? []).length, `nothing sealed once the removal ended (${json(s2.sealed)})`, s2);
    await cmd(`/setblock ${C.join(' ')} minecraft:chest[facing=south]`);
    await L.settle(4000);
    const c2 = await holder(C), ho2 = await holder(outside);
    const u2 = await use(C, DIAMOND);
    out.lift = { C: c2.holds, outside: ho2.holds, use: u2, refusedPaths: s2.refused };
    check(c2.holds?.[DIAMOND] === 4 && sum(ho2.holds) === 0 && u2.menuOpened && !u2.refused, `the seal lifted: a chest set at C took the outside hopper's 4 diamonds, and the player's use opens its menu (${json(out.lift)})`, out.lift);
    log(`  refusals by path: ${json(s2.refused)}`);
    await L.leaveWorld();
    spendZero();
    return out;
  };

  // ------------------------------------------------------------------ lc3-undo

  /** A paused removal's first sealed box: a chest set inside it refuses the hand and a Transfer API insert. */
  async function sealedChest(tag, only = null) {
    const st = await until(async () => { const s = await seal(); return (s.sealed ?? []).length && (s.jobs ?? []).some((j) => !only || j.site === only) ? s : null; }, 600, 500);
    check(!!st, `${tag}: the removal started and its boxes are sealed (${json(st?.sealed)}; jobs ${json(st?.jobs)})`, st);
    if (!st) return null;
    const first = (st.jobs.find((j) => !only || j.site === only) ?? st.jobs[0]).site;
    const e = st.sealed.find((x) => x.id === first) ?? st.sealed[0];
    const [mn, mx] = e.box.split(' ').map((c) => c.split(',').map(Number));
    const P = [Math.floor((mn[0] + mx[0]) / 2), Math.min(mx[1], mn[1] + 2), Math.floor((mn[2] + mx[2]) / 2)];
    await cmd(`/setblock ${P.join(' ')} minecraft:chest`);
    const u = await use(P, DIAMOND);
    const t = await call('dev.seal.transfer', { pos: P, item: DIAMOND, count: 2 }, 30_000).catch((x) => ({ error: String(x) }));
    check(refused(u, DIAMOND) && t.inserted === 0, `${tag}: a chest set at ${P.join(',')} in ${e.id}'s sealed box (the paused member ${first}) refuses the player's diamond (in the hand: ${json(u.hand)}) and a Transfer API insert (${t.inserted})`, { u, t, sealed: st.sealed.map((x) => x.id) });
    return { sealed: st.sealed.map((x) => x.id), first, at: P, use: u, transfer: t };
  }

  steps.lc3undo = async () => {
    await ensure();
    const name = 'G6B LC3 Undo';
    const out = {};
    await L.fresh(name, G.FLAT);
    await L.setRules('exact');
    await G.designs(ctx);
    await L.tp(CX + 80, 80, CZ + 56);
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: 'rs_hut' } });
    const st = await L.waitRegion(region, 1_800_000);
    const hut = st.view.lots.find((l) => l.id === 'cottage_1')?.siteId;
    check(st.view.state === 'PLACED' && !!hut, `the town ${region} PLACED; cottage_1 = rs_hut (${hut})`, st.view.lots);
    if (!hut) { await L.leaveWorld(); return out; }
    // a revision's undo of its own stage (Groups.undoStage, ownStage), paused in its first member's restore
    await call('dev.removal.pause', { site: hut, after: 0 }, 10_000);
    const fu = call('dev.removal.undoStage', { site: hut }, 3_600_000).catch((e) => ({ error: String(e) }));
    out.revision = await sealedChest('revision undo', hut);
    check(out.revision?.first === hut, `revision undo: rs_hut's own restore (${hut}) paused, its box sealed (${json(out.revision?.sealed)})`, out.revision);
    await call('dev.removal.pause', { site: hut, off: true }, 10_000);
    out.revision && (out.revision.answer = await fu);
    check(out.revision?.answer?.removed === true, `revision undo: resumed, the stage undone (${json(out.revision?.answer)})`, out.revision);
    await L.settle(3000);
    const s1 = await seal();
    check(!(s1.sealed ?? []).length, `revision undo: nothing sealed once it ended (${json(s1.sealed)})`, s1);
    // the region Remove (the group's undo), paused in its first member's restore
    await call('dev.removal.pause', { site: '*', after: 0 }, 10_000);
    const fr = call('dev.region.remove', { region, requester: G.OWNER }, 3_600_000).catch((e) => ({ error: String(e) }));
    out.group = await sealedChest('group undo');
    await call('dev.removal.pause', { site: '*', off: true }, 10_000);
    out.group && (out.group.answer = await fr);
    const end = await until(async () => { const r = await call('dev.region.state', { region }, 60_000).catch(() => null); return !r?.view || ['REMOVED', 'PARTIAL', 'FAILED'].includes(r.view.state) ? (r?.view?.state ?? 'gone') : null; }, 600, 1000);
    check(['REMOVED', 'gone'].includes(end), `group undo: resumed, the region removed (${end}; ${json(out.group?.answer).slice(0, 200)})`, out.group);
    await L.settle(3000);
    const s2 = await seal();
    check(!(s2.sealed ?? []).length, `group undo: nothing sealed once it ended (${json(s2.sealed)}); refusals ${json(s2.refused)}`, s2);
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
