// Slice LC3 gate (docs/CONTRACT.md "### Slice LC3 as built"; Steward's S-M5-12): a removal's boxes are SEALED, no item enters a holder
// there until the removal ends. Registered into tools/gate6dgr.mjs. Headless server, creative, the sim sidecar: $0. Strict (removal, crash).
//
//   node tools/gate6dgr.mjs lc3seal  (lc3-seal)  lc3_big, a 48-cube creative site (a sliced RestoreJob removes it) with a chest C on its north
//                                                edge and a lectern. C's menu opened before the removal; the removal paused before any
//                                                write (dev.removal.pause). While paused: C's open menu is closed (stillValid false); a
//                                                hopper set outside the box with 4 diamonds pushes nothing into C; a hopper set inside picks
//                                                up no item entity; a Transfer API insert into C inserts 0; the player's hand into C (no menu),
//                                                a book onto the lectern, beef onto a campfire, a diamond into a decorated pot, a shelf, a disc
//                                                into a jukebox, a book into a chiseled bookshelf, a filled shulker box placed on the floor and by a dispenser outside, a
//                                                diamond into an item frame: every one refused, the item still in the hand (or the source).
//                                                Then the restore resumed to 1000 cells and paused again, saved, the JVM halted: after the
//                                                restart the same box is sealed (from the queue file) and refuses again. Resumed: removed; the
//                                                seal lifts (a chest set at C takes the outside hopper's 4 diamonds; a hand opens its menu).
//   node tools/gate6dgr.mjs lc3undo  (lc3-undo)  a creative flat_village town (cottage_1 = rs_hut). A stage undo as a revision undoes its own
//                                                stage (Groups.undoStage, ownStage) and then the region Remove (the group undo), each paused
//                                                in its first member's restore: a chest set inside a sealed box refuses the player's hand and a
//                                                Transfer API insert; resumed, each ends removed and the seal lifts.
//                                                (LC3 fix) In the group undo member A runs to its end while B stays paused: A's box stays
//                                                sealed, and again after a flush, a halt and a restart, until the removal ends.
//                                                (LC3 fix 2) A second town's group removal forced STALLED (dev.undo.failRestore skip 1): a chest
//                                                with 5 diamonds in written member A's box sealed; /architect removal abandon <group>: the chest
//                                                opens with its items once the queue file is written; the diamonds taken out, a halt and a
//                                                restart: nothing resumes, the chest stands empty, the unwritten member has no record, a second
//                                                abandon refused (so is one for a group with no stalled removal).
//   (LC3 fix) lc3-seal also: a powered shelf outside chained into the box (the hotbar swap refused), a hopper and a hopper minecart below
//   sealed chests (nothing pulled), a sealed hopper pushing out (nothing), a crafter firing into the box (no craft, nothing consumed or
//   dropped), an active vault in the box (no key taken); each with a control outside the box that works.
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
    // a dispenser set just outside the box, facing in, holding a filled shulker box, powered: it places nothing into the box
    const front = at(6, 1, 0), disp = [front[0], front[1], front[2] - 1], power = [front[0] - 1, front[1], front[2] - 1];
    await cmd(`/setblock ${disp.join(' ')} minecraft:dispenser[facing=south]{Items:[{Slot:0b,id:"minecraft:shulker_box",count:1,components:{"minecraft:container":[{slot:0,item:{id:"${DIAMOND}",count:2}}]}}]}`);
    await cmd(`/setblock ${power.join(' ')} minecraft:redstone_block`);
    await L.settle(1500);
    const dh = await holder(disp), fc = await holder(front);
    r.dispenser = { dispenser: dh.holds, front: fc.block };
    check(dh.holds?.['minecraft:shulker_box'] === 1 && fc.block === 'minecraft:air', `${tag}: a powered dispenser outside the box places no filled shulker box into it (the dispenser ${json(dh.holds)}, the cell ${fc.block})`, r.dispenser);
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

  /**
   * (LC3 fix: review findings 1, 3, 4, 5) Paths the first build missed, each with a control outside the box that shows the path works when
   * nothing is sealed: a powered shelf chain reaching into the box, extraction out of a sealed holder (a hopper below a sealed chest, a hopper
   * minecart below one, a sealed hopper pushing out), a crafter firing into the box, a vault inside it.
   */
  async function fixCases(tag, sb, C) {
    const [X0, Y0, Z0] = sb[0];
    const Y = C[1];
    const r = {};
    const nearOf = async (pos, radius = 2) => (await call('dev.items.near', { pos, radius }, 60_000)).items ?? {};
    const inBox = (p) => p[0] >= sb[0][0] && p[0] <= sb[1][0] && p[1] >= sb[0][1] && p[1] <= sb[1][1] && p[2] >= sb[0][2] && p[2] <= sb[1][2];
    // 1. a powered shelf chain: the outside shelf at minX - 1 chained to two inside; the whole hotbar swap refused
    const Zs = Z0 + 24;
    const sh = [[X0 - 1, Y, Zs], [X0, Y, Zs], [X0 + 1, Y, Zs]];
    for (const p of sh) await cmd(`/setblock ${p.join(' ')} minecraft:oak_shelf[facing=south]`);
    for (const p of sh) await cmd(`/setblock ${p[0]} ${p[1]} ${p[2] - 1} minecraft:redstone_block`);
    await L.settle(1000);
    const sIn = await holder(sh[1]);
    const chained = /powered=true/.test(sIn.state ?? '') && !/side_chain=unconnected/.test(sIn.state ?? '');
    check(chained && sIn.sealed && !inBox(sh[0]), `${tag}: shelves chained and powered across the box's west face (inside: ${sIn.state}, sealed ${sIn.sealed}; outside ${sh[0].join(',')})`, sIn);
    r.shelf = await use(sh[0], DIAMOND, { face: 'south', fillHotbar: true });
    const inside = sum((await holder(sh[1])).holds) + sum((await holder(sh[2])).holds);
    const outsideShelf = sum((await holder(sh[0])).holds);
    r.shelf.inside = inside;
    check(!r.shelf.error && inside === 0 && outsideShelf === 0 && r.shelf.hotbar === 9 && r.shelf.refused > 0,
      `${tag}: a powered outside shelf chained into the box swaps nothing (inside shelves ${inside}, outside ${outsideShelf}, the hotbar ${r.shelf.hotbar} of 9 diamonds)`, r.shelf);
    // 3. extraction: a hopper below a sealed chest (and its control outside the box), a hopper minecart below one, a sealed hopper pushing out
    const Ze = Z0 + 10;
    const full = (p) => `/setblock ${p.join(' ')} minecraft:chest{Items:[{Slot:0b,id:"${DIAMOND}",count:2}]}`;
    const c1 = [X0 + 5, Y0, Ze], h1 = [X0 + 5, Y0 - 1, Ze];
    const c2 = [X0 + 8, Y0, Ze], m2 = [X0 + 8, Y0 - 1, Ze];
    const c0 = [X0 - 3, Y0, Ze], h0 = [X0 - 3, Y0 - 1, Ze];
    const h3 = [X0, Y, Z0 + 12], c3 = [X0 - 1, Y, Z0 + 12];
    for (const p of [c1, c2, c0]) await cmd(full(p));
    await cmd(`/setblock ${h1.join(' ')} minecraft:hopper[facing=down]`);
    await cmd(`/setblock ${h0.join(' ')} minecraft:hopper[facing=down]`);
    await cmd(`/setblock ${m2.join(' ')} minecraft:air`);
    await cmd(`/summon minecraft:hopper_minecart ${m2[0] + 0.5} ${m2[1]} ${m2[2] + 0.5}`);
    await cmd(`/setblock ${c3.join(' ')} minecraft:chest`);
    await cmd(`/setblock ${h3.join(' ')} minecraft:hopper[facing=west]{Items:[{Slot:0b,id:"${DIAMOND}",count:2}]}`);
    await L.settle(4000);
    const x1 = await holder(c1), y1 = await holder(h1), x2 = await holder(c2), x0 = await holder(c0), y0 = await holder(h0), y3 = await holder(h3), x3 = await holder(c3);
    r.extract = { sealedChest: x1.holds, hopperBelow: y1.holds, minecartChest: x2.holds, control: { chest: x0.holds, hopper: y0.holds }, sealedHopper: y3.holds, outsideChest: x3.holds };
    check(x1.sealed && !inBox(h1) && x1.holds?.[DIAMOND] === 2 && sum(y1.holds) === 0, `${tag}: a hopper below a sealed chest pulls nothing out of it in 4 s (the chest ${json(x1.holds)}, the hopper ${json(y1.holds)})`, r.extract);
    check(x2.sealed && x2.holds?.[DIAMOND] === 2, `${tag}: a hopper minecart below a sealed chest pulls nothing out of it (${json(x2.holds)})`, r.extract);
    check(!x0.sealed && sum(x0.holds) === 0 && y0.holds?.[DIAMOND] === 2, `${tag}: control: a hopper below a chest outside the box pulled its 2 diamonds (${json(r.extract.control)})`, r.extract);
    check(y3.sealed && !x3.sealed && y3.holds?.[DIAMOND] === 2 && sum(x3.holds) === 0, `${tag}: a sealed hopper pushes nothing out of the box (the hopper ${json(y3.holds)}, the chest outside ${json(x3.holds)})`, r.extract);
    // 4. a crafter outside the box firing into a sealed chest crafts nothing (9 iron ingots kept, no output dropped); its control crafts
    const ingots = Array.from({ length: 9 }, (_, i) => `{Slot:${i}b,id:"minecraft:iron_ingot",count:1}`).join(',');
    const crafter = (p) => `/setblock ${p.join(' ')} minecraft:crafter[orientation=east_up]{Items:[${ingots}]}`;
    const k1 = [X0 - 1, Y, Z0 + 16], t1 = [X0, Y, Z0 + 16];
    const k0 = [X0 - 5, Y, Z0 + 20], t0 = [X0 - 4, Y, Z0 + 20];
    await cmd(`/setblock ${t1.join(' ')} minecraft:chest`);
    await cmd(`/setblock ${t0.join(' ')} minecraft:chest`);
    await cmd(crafter(k1));
    await cmd(crafter(k0));
    await cmd(`/setblock ${k1[0] - 1} ${k1[1]} ${k1[2]} minecraft:redstone_block`);
    await cmd(`/setblock ${k0[0] - 1} ${k0[1]} ${k0[2]} minecraft:redstone_block`);
    await L.settle(2500);
    const kk1 = await holder(k1), tt1 = await holder(t1), kk0 = await holder(k0), tt0 = await holder(t0);
    const n1 = await nearOf(t1, 3);
    r.crafter = { crafter: kk1.holds, chest: tt1.holds, near: n1, control: { crafter: kk0.holds, chest: tt0.holds } };
    check(!kk1.sealed && tt1.sealed && kk1.holds?.['minecraft:iron_ingot'] === 9 && sum(tt1.holds) === 0 && !n1['minecraft:iron_block'] && !n1['minecraft:iron_ingot'],
      `${tag}: a powered crafter firing into the box crafts nothing: its 9 iron ingots kept, the sealed chest ${json(tt1.holds)}, nothing dropped (${json(n1)})`, r.crafter);
    check(sum(kk0.holds) === 0 && tt0.holds?.['minecraft:iron_block'] === 1, `${tag}: control: a crafter outside crafted an iron block into its chest (${json(r.crafter.control)})`, r.crafter);
    // 5. a vault inside the box takes no key; its control outside takes one (both active: the player within range)
    // (each set ACTIVE in the use's own server call: a headless player's detection is not waited for)
    const v1 = [C[0] + 6, Y, C[2]], v0 = [C[0] + 6, Y, C[2] - 3];
    await cmd(`/setblock ${v1.join(' ')} minecraft:vault[facing=north]`);
    await cmd(`/setblock ${v0.join(' ')} minecraft:vault[facing=north]`);
    await L.settle(1000);
    const vs1 = await holder(v1), vs0 = await holder(v0);
    r.vault = await use(v1, 'minecraft:trial_key', { face: 'north', vaultActive: true });
    r.vaultControl = await use(v0, 'minecraft:trial_key', { face: 'north', vaultActive: true });
    check(vs1.sealed && /vault_state=active/.test(r.vault.vaultState ?? '') && r.vault.hand?.item === 'minecraft:trial_key' && r.vault.hand?.count === 1 && r.vault.refused > 0,
      `${tag}: an active vault in the box takes no key (the hand ${json(r.vault.hand)}, ${r.vault.vaultState})`, r.vault);
    check(!vs0.sealed && /vault_state=active/.test(r.vaultControl.vaultState ?? '') && r.vaultControl.hand?.count === 0, `${tag}: control: an active vault outside took the key (the hand ${json(r.vaultControl.hand)})`, r.vaultControl);
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
    out.fix = await fixCases('paused', sb, C);
    await L.tp(C[0] + 0.5, C[1], C[2] - 4);
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
    // (LC3 fix, review 2) member A (the first) runs to its end, B pauses before any write: A stays sealed while the removal is in the queue,
    // across a crash (a restart can write A again), and unseals only when the removal ends
    const A = out.group?.first;
    let halted = false;
    if (A) {
      await call('dev.removal.pause', { site: A, after: 2_000_000_000 }, 10_000);
      const st = await until(async () => { const x = await seal(); return (x.jobs ?? []).length && !(x.jobs ?? []).some((j) => j.site === A) ? x : null; }, 600, 500);
      const B = st?.jobs?.[0]?.site;
      check(!!st && B !== A, `group undo: member ${A} written and out of the queue's jobs, member ${B} paused before its writes (${json(st?.jobs)})`, st);
      const aSealed = async (t) => {
        const x = await seal();
        const e = (x.sealed ?? []).find((y) => y.id === A);
        if (!e) return { sealed: (x.sealed ?? []).map((y) => y.id) };
        const P = e.cell.split(',').map(Number);
        await cmd(`/setblock ${P.join(' ')} minecraft:chest`);
        const u = await use(P, DIAMOND);
        const t2 = await call('dev.seal.transfer', { pos: P, item: DIAMOND, count: 2 }, 30_000).catch((y) => ({ error: String(y) }));
        await cmd(`/setblock ${P.join(' ')} minecraft:air`);
        return { sealed: (x.sealed ?? []).map((y) => y.id), at: P, use: u, transfer: t2, ok: refused(u, DIAMOND) && t2.inserted === 0 };
      };
      out.writtenA = await aSealed('before');
      check(!!out.writtenA.ok, `group undo: written member ${A} still sealed while ${B} is paused: a chest in its box refuses the hand and a Transfer API insert (${json(out.writtenA).slice(0, 300)})`, out.writtenA);
      await cmd('/save-all flush');
      await L.settle(1500);
      await call('dev.stockpile.halt', { mode: 'now' }, 10_000).catch(() => null);
      const down = await haltWait();
      check(down, 'group undo: halted with A written and B paused');
      halted = !!down;
      if (down) {
        await L.openWorld(name);
        await L.tp(CX + 80, 80, CZ + 56);
        await L.settle(4000);
        const x1 = await until(async () => { const x = await seal().catch(() => null); return x && (x.sealed ?? []).length ? x : null; }, 60, 1000);
        // a written member the start's settle released (its record gone: nothing can write it again) needs no seal; one still pending
        // (a restart could write it again) must be sealed
        const mA = (x1?.members ?? []).find((m) => m.id === A);
        out.writtenAfterRestart = { member: mA ?? null };
        if (mA?.pending) {
          Object.assign(out.writtenAfterRestart, await aSealed('after'));
          check(!!out.writtenAfterRestart.ok, `group undo: after the restart written member ${A} is still pending and sealed again from the queue file (${json(out.writtenAfterRestart).slice(0, 300)})`, out.writtenAfterRestart);
        } else {
          check(!!mA && !mA.standing && !mA.sealed, `group undo: after the restart written member ${A} was settled at the start (its record released: no restart can write it again), so it is no longer sealed (${json(mA)})`, out.writtenAfterRestart);
        }
        check((x1?.members ?? []).every((m) => !m.pending || m.sealed), `group undo: after the restart every member whose record is still pending is sealed (${json(x1?.members)})`, x1?.members);
      }
      await call('dev.removal.pause', { site: A, off: true }, 10_000);
    }
    await call('dev.removal.pause', { site: '*', off: true }, 10_000);
    // (after a halt the first world's call never answers: the region's state decides below)
    out.group && (out.group.answer = halted ? await Promise.race([fr, L.sleep(5000).then(() => ({ halted: true }))]) : await fr);
    const end = await until(async () => { const r = await call('dev.region.state', { region }, 60_000).catch(() => null); return !r?.view || ['REMOVED', 'PARTIAL', 'FAILED'].includes(r.view.state) ? (r?.view?.state ?? 'gone') : null; }, 600, 1000);
    check(['REMOVED', 'gone'].includes(end), `group undo: resumed, the region removed (${end}; ${json(out.group?.answer).slice(0, 200)})`, out.group);
    await L.settle(3000);
    const s2 = await seal();
    check(!(s2.sealed ?? []).length, `group undo: nothing sealed once it ended (${json(s2.sealed)}); refusals ${json(s2.refused)}`, s2);
    await L.leaveWorld();
    out.abandon = await abandonCase();
    spendZero();
    return out;
  };

  // (LC3 fix 2, GPT P1 #2) /architect removal abandon: a group removal forced STALLED (member A written, B's restore broken mid-write) keeps
  // a chest in A's box sealed; abandoned, the chest opens with its items, nothing replays after a halt and a restart, a second abandon refused
  async function abandonCase() {
    const name = 'G6B LC3 Abandon';
    const out = {};
    // (the runner's json() drops whitespace: compare without it)
    const says = (r, t) => json(r?.messages ?? []).replace(/\s/g, '').includes(t.replace(/\s/g, ''));
    await L.fresh(name, G.FLAT);
    await L.setRules('exact');
    await G.designs(ctx);
    await L.tp(CX + 80, 80, CZ + 56);
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: 'rs_hut' } });
    const st = await L.waitRegion(region, 1_800_000);
    check(st.view.state === 'PLACED', `abandon: the town ${region} PLACED`, st.view.lots);
    if (st.view.state !== 'PLACED') { await L.leaveWorld(); return out; }
    const none = await cmd('/architect removal abandon g999');
    out.unknown = none;
    check(says(none, 'No stalled removal of g999'), `abandon: refused for a group with no stalled removal (${json(none.messages)})`, none);
    await call('dev.undo.failRestore', { skip: 1 }, 10_000); // the first member's restore finishes, the next breaks mid-write
    const fr = call('dev.region.remove', { region, requester: G.OWNER }, 3_600_000).catch((e) => ({ error: String(e) }));
    const x0 = await until(async () => { const x = await seal(); return (x.stalled ?? []).length ? x : null; }, 600, 1000);
    await call('dev.undo.failRestore', { skip: -1 }, 10_000);
    out.answer = await Promise.race([fr, L.sleep(30_000).then(() => ({ waited: true }))]);
    const sr = x0?.stalled?.[0];
    out.stalled = sr ?? null;
    check(!!sr && sr.written.length > 0 && sr.unwritten.length > 0, `abandon: the group removal STALLED with member(s) ${json(sr?.written)} written and ${json(sr?.unwritten)} not (${json(out.answer).slice(0, 200)})`, x0);
    if (!sr || !sr.written.length) { await L.leaveWorld(); return out; }
    const A = sr.written[0];
    const B = sr.unwritten[0];
    const e = (x0.sealed ?? []).find((y) => y.id === A);
    check(!!e, `abandon: written member ${A}'s box is sealed while the removal is stalled (${json((x0.sealed ?? []).map((y) => y.id))})`, x0.sealed);
    if (!e) { await L.leaveWorld(); return out; }
    const P = e.cell.split(',').map(Number);
    await cmd(`/setblock ${P.join(' ')} minecraft:chest`);
    await cmd(`/item replace block ${P.join(' ')} container.0 with ${DIAMOND} 5`); // an admin command: the chest's contents (a restored terrain chest)
    const u0 = await use(P, DIAMOND);
    const h0 = await holder(P);
    check(refused(u0, DIAMOND) && h0.holds?.[DIAMOND] === 5, `abandon: the chest at ${P.join(',')} in ${A}'s box is sealed (the hand refused, ${json(h0.holds)} kept)`, { u0, h0 });
    const r1 = await cmd(`/architect removal abandon ${sr.group}${sr.stage ? ' ' + sr.stage : ''}`);
    out.abandon = r1;
    check(r1.success !== false && says(r1, 'abandoned the stalled'), `abandon: /architect removal abandon ${sr.group} accepted (${json(r1.messages).slice(0, 300)})`, r1);
    const x1 = await until(async () => { const x = await seal(); return !(x.sealed ?? []).length && !(x.lingering ?? []).length && !(x.stalled ?? []).length ? x : null; }, 120, 500);
    check(!!x1 && !x1.queueWriteFailing, `abandon: the removal left the queue and, once its queue file generation was written, nothing is sealed or lingering (written ${x1?.queueWritten}, requested ${x1?.queueRequested})`, x1);
    const h1 = await holder(P);
    await cmd(`/setblock ${P[0]} ${P[1] + 1} ${P[2]} minecraft:air`); // a chest under a solid block never opens
    const u1 = await use(P, DIAMOND);
    out.open = { h1, u1 };
    check(h1.holds?.[DIAMOND] === 5 && !u1.error && u1.refused === 0 && u1.menuOpened, `abandon: the chest opens again with its items intact (${json(h1.holds)}; ${json(u1).slice(0, 400)})`, { h1, u1 });
    await call('dev.seal.menu', { pos: P, close: true }, 10_000).catch(() => null);
    await cmd(`/item replace block ${P.join(' ')} container.0 with minecraft:air`); // the diamonds taken out: a replay would bring the chest's cell back
    const h2 = await holder(P);
    check(!h2.holds?.[DIAMOND], `abandon: the diamonds taken out (${json(h2.holds)})`, h2);
    const s1 = await call('dev.sites.state', {}, 30_000);
    out.records = { A: json(s1).includes(`"${A}"`), B: json(s1).includes(`"${B}"`) };
    check(!json((s1.pending ?? []).map((p) => p.site?.id ?? p.id)).includes(`"${B}"`) && !json((s1.sites ?? []).map((p) => p.id)).includes(`"${B}"`), `abandon: unwritten member ${B}'s record dropped (left standing as it is, no record to write it again)`, s1.pending);
    await cmd('/save-all flush');
    await L.settle(1500);
    await call('dev.stockpile.halt', { mode: 'now' }, 10_000).catch(() => null);
    const down = await haltWait();
    check(down, 'abandon: halted after the abandon');
    if (!down) { await L.leaveWorld().catch(() => null); return out; }
    await L.openWorld(name);
    await L.tp(CX + 80, 80, CZ + 56);
    await L.settle(6000);
    const x2 = await seal();
    const h3 = await holder(P);
    out.afterRestart = { seal: x2, chest: h3 };
    check(!(x2.sealed ?? []).length && !(x2.stalled ?? []).length && !(x2.jobs ?? []).length, `abandon: after the restart nothing resumes and nothing is sealed (${json(x2.sealed)}; jobs ${json(x2.jobs)})`, x2);
    check(/chest/.test(h3.block ?? '') && !h3.holds?.[DIAMOND], `abandon: after the restart the chest at ${P.join(',')} still stands, empty: nothing replayed (${h3.block} ${json(h3.holds)})`, h3);
    const s2 = await call('dev.sites.state', {}, 30_000);
    check(!json((s2.sites ?? []).map((p) => p.id)).includes(`"${B}"`) && !json((s2.pending ?? []).map((p) => p.site?.id ?? p.id)).includes(`"${B}"`), `abandon: after the restart unwritten member ${B} has no record (none came back from the journal)`, s2);
    const r2 = await cmd(`/architect removal abandon ${sr.group}${sr.stage ? ' ' + sr.stage : ''}`);
    out.second = r2;
    check(says(r2, 'No stalled removal'), `abandon: a second abandon is refused (${json(r2.messages)})`, r2);
    await L.leaveWorld();
    return out;
  }
}
