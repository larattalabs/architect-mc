// FK-b gate (docs/CONTRACT.md "### FK-b contract" 8): module-provided fill items, registered into tools/gate6dgr.mjs beside FK's
// (tools/lib/gatem5fk.mjs, whose town it mirrors). Headless server, the sim sidecar: $0. Strict (billing, refunds, crash replay).
//
//   node tools/gate6dgr.mjs fkbunit      (fkb-unit)      kit fk.test (the provided findings, the allow-list mirror), FillsFKBTest, ApiFKBTest,
//                                                        FillsFKTest; api-compat
//   node tools/gate6dgr.mjs fkbsurvival  (fkb-survival)  a survival town with cottage_1 bound to fk_hall provided 1 (4 filter hoppers: 18 of a
//                                                        filter item and 4 module-provided petrified slabs each): the quote and the bill the
//                                                        filter items only; consumed = the quote; the hoppers the plan, slabs included; the
//                                                        guard on (the Transfer API one applied); every menu take of a slab refused as the
//                                                        player's real menu clicks (pickup, shift-click, number-key and offhand swap, Q,
//                                                        ctrl-Q, double-click collect), a filter item's pickup allowed; a hopper minecart under
//                                                        a filter hopper pulls no slab; a Transfer API extraction moves no slab and does move a
//                                                        filter item; the negative case (a hopper set by command holding slabs: vanilla); the
//                                                        region removed: refund = the billed part only, no slab anywhere; a bad declaration
//                                                        refused (kit and mod, 0 cells). Then the repair cycle: a town built and filled, a filter
//                                                        hopper broken by the player and another by TNT (slabs stripped, filter items dropped,
//                                                        no slab entity), the region removed and grown again (a new key): the slabs the plan,
//                                                        the new bill the filter items only, consumed = the quote
//   node tools/gate6dgr.mjs fkbcrash     (fkb-crash)     FK2, FK3 at the fill and FKC1, FKC2 at the removal with slabs (no duplicate, no loss of
//                                                        slabs or billed items; no slab refunded or dropped), and the strip's crash case: a filter
//                                                        hopper broken and the JVM halted before any save: after the restart it stands with its
//                                                        slabs, no slab entity, no heldProvided
//
// Evidence: artifacts/gate6d-gr/<step>.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const SLAB = 'minecraft:petrified_oak_slab';
const FLINT = 'minecraft:flint';
const FILTERS = ['minecraft:flint', 'minecraft:clay_ball', 'minecraft:bone', 'minecraft:feather'];
/** fk_hall slots 4, count 18, provided 1: the bill (the filter items) and the slabs (4 per hopper, unbilled) */
const BILL = Object.fromEntries(FILTERS.map((k) => [k, 18]));
const SLABS = 16;
const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];

export async function registerFKB(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, CX, CZ, CLAIM, haltWait, root } = h; // h.hashOf: the creative box's hash
  const ctx = { L, OUT: h.OUT, imp: h.imp };
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const fk = (site) => call('dev.fk.state', { site }, 30_000);
  const hand = (at, o) => call('dev.fk.container', { pos: P(at), ...o }, 30_000);
  const P = (at) => (Array.isArray(at) ? at : at.split(',').map(Number));
  const ledgerOf = (rootJson) => (rootJson?.stockpiles ?? []).find((p) => p.owner === G.OWNER)?.ledger ?? null;
  const savedLedger = (name) => ledgerOf(JSON.parse(fs.readFileSync(path.join(L.SAVES, name, 'architect', 'stockpiles.json'), 'utf8')));
  const only = (m, keys) => Object.fromEntries(Object.entries(m ?? {}).filter(([k]) => keys.includes(k)));
  const FK = Object.keys(BILL);
  const ALL = [...FK, SLAB];
  const slabsOf = (s) => (s.containers ?? []).reduce((n, c) => n + (c.holds?.[SLAB] ?? 0), 0);
  const exactly = (s) => (s.containers ?? []).every((c) => G.same(c.holds, c.declared));
  const slabsNear = async (at) => call('dev.fk.slabs', { pos: P(at) }, 30_000);

  /** fk_hall provided 1 (the fixture program, kit/test/fixtures/fk), written to the library as a given program's entry. */
  async function entry({ mutate, keepId = false } = {}) {
    await G.designs(ctx);
    const src = fs.readFileSync(path.join(root, 'kit', 'test', 'fixtures', 'fk', 'fk_hall.mjs'), 'utf8')
      .replaceAll("'../lib/", `'${pathToFileURL(path.join(root, 'kit', 'lib')).href}/`);
    const tmp = path.join(h.OUT, 'fkb_hall.mjs');
    fs.writeFileSync(tmp, src);
    const mod = await import(`${pathToFileURL(tmp).href}?t=${Date.now()}`);
    const { writeBlueprint } = await h.imp('lib/write.mjs');
    const { checkBlueprint } = await h.imp('lib/check.mjs');
    const bp = mod.default({ slots: 4, count: 18, provided: 1 });
    if (mutate) mutate(bp);
    const ck = checkBlueprint(bp, {});
    const id = mutate && !keepId ? 'fkb_bad' : 'fk_hall';
    if (mutate && !keepId) bp.id = id;
    const dir = path.join(L.LIBRARY, id);
    fs.rmSync(dir, { recursive: true, force: true });
    const w = writeBlueprint(bp, dir);
    const j = JSON.parse(fs.readFileSync(w.jsonPath, 'utf8'));
    j.givenProgram = { sha: 'gate-fixture', opKey: `gate.fkb.${id}` };
    if (mutate && !keepId) j.id = id;
    fs.writeFileSync(w.jsonPath, `${JSON.stringify(j, null, 2)}\n`);
    await L.cmd('/architect reload');
    await L.settle(1500);
    return { j, ck };
  }

  /** The town planned (cottage_1: fk_hall), quoted, realised, in the current world. */
  async function grow(name, gy) {
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const q = await call('dev.region.quote', { planId: p0.planId, lotEntries: { cottage_1: 'fk_hall' } }, 300_000);
    const ps0 = await pile();
    const region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: 'fk_hall' } });
    return { name, gy, region, q, ps0, dir: path.join(L.SAVES, name) };
  }

  /** A fresh survival world with the stockpile and fk_hall provided 1; the town grown. */
  async function town(name, { mutate } = {}) {
    await G.survivalBase(ctx);
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    const { ck } = await entry(mutate ? { mutate, keepId: true } : {});
    check(ck.ok, `${name}: fk_hall (provided 1: petrified slabs declared provided) checks clean: ${ck.errors.slice(0, 3).join('; ') || 'OK'}`);
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `${name}: a stockpile of 4 crates: ${json(cr.refused ?? 'made')}`);
    return { ...(await grow(name, gy)), crates };
  }

  async function fkSite(skip = new Set()) {
    const seen = new Set(skip);
    for (let i = 0; i < 360; i++) {
      for (const id of Object.keys((await pile()).targets ?? {})) {
        if (seen.has(id)) continue;
        const s = await fk(id);
        if (s.hasFill) return id;
        if (s.state === 'BUILT') seen.add(id);
      }
      await deliver({ fill: false });
      await L.sleep(2500);
    }
    return null;
  }

  /** Delivers what the targets lack: the filter items (`fill` true) or everything else. Never a slab (never outstanding). */
  async function deliver({ fill = false } = {}) {
    const ps = await pile();
    const need = {};
    for (const [it, n] of Object.entries(ps.outstanding ?? {})) {
      if (it === SLAB) { check(false, `a petrified slab is never outstanding (outstanding ${json(ps.outstanding)})`); continue; }
      if (FK.includes(it) !== fill) continue;
      const lack = n - (ps.stock?.[it] ?? 0);
      if (lack > 0) need[it] = lack;
    }
    if (!Object.keys(need).length) return {};
    return (await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: need, exact: true }, 120_000)).accepted ?? {};
  }

  async function blocksBuilt(tag, site) {
    let t = null;
    for (let i = 0; i < 400; i++) {
      await deliver({ fill: false });
      const ps = await pile();
      t = ps.targets?.[site];
      const others = Object.entries(ps.targets ?? {}).filter(([k]) => k !== site);
      if (t && t.queued > 0 && t.built === t.queued && others.every(([, x]) => (x.built ?? 0) >= (x.queued ?? 0))) break;
      await L.sleep(2500);
    }
    check(t && t.built === t.queued, `${tag}: the town's blocks fed: every fk_hall cell stands (${t?.built}/${t?.queued})`, t);
    return t;
  }

  async function filled(site, { ms = 300_000, feed = true } = {}) {
    let s;
    let fed = {};
    const end = Date.now() + ms;
    for (; Date.now() < end;) {
      s = await fk(site);
      if (s.state === 'BUILT' && s.phase === 'UNLOCKED') break;
      if (feed) fed = G.plus(fed, await deliver({ fill: true }));
      await L.sleep(2000);
    }
    return { s, fed };
  }

  /**
   * (FK-b fix) A declared hopper swapped for an empty dropper between the builder's rescans, the site resumed in the same server task
   * with its bill in the stock: the fill finds the swapped block and writes nothing (no provided item ever in the dropper); the hopper
   * put back, the fill goes on. Returns what it delivered.
   */
  async function swapCase(tag, site) {
    const s0 = await fk(site);
    const at = s0.containers?.[2]?.at; // a hopper away from the lever (the lock disables the first)
    const pr = await call('dev.stockpile.pause', { owner: G.OWNER, site, paused: true }, 60_000);
    check(!pr.refused, `${tag}: ${site} paused for the swap`);
    const fed = await deliver({ fill: true });
    const r0 = (await call('dev.fk.guard', {}, 10_000)).swapRefused;
    let sw = null;
    for (let i = 0; i < 20 && !sw?.swapped; i++) {
      sw = await call('dev.fk.swap', { pos: P(at), block: 'minecraft:dropper', site }, 30_000);
      if (sw?.error) break;
    }
    await L.sleep(3000);
    const r1 = (await call('dev.fk.guard', {}, 10_000)).swapRefused;
    const inDropper = (await hand(at, {})).holds ?? {};
    const s1 = await fk(site);
    const sl = await slabsNear(at);
    const res = { at, swap: sw, refused: r1 - r0, inDropper, phase: s1.phase ?? null, provided: s1.provided ?? null, slabs: sl };
    log(`  ${tag} swap: ${json(res)}`);
    check(sw?.swapped === true && sw.block === 'minecraft:dropper' && r1 - r0 >= 1 && sum(inDropper) === 0 && slabsOf(s1) === 0 && s1.phase == null
      && sl.entities === 0 && sl.player === 0,
      `${tag}: a declared hopper swapped for an empty dropper mid-fill (${at}): the fill saw the swap (${r1 - r0} refused attempt(s)) and wrote nothing: the dropper holds ${json(inDropper)}, no slab in any container (${slabsOf(s1)}), phase ${s1.phase ?? 'none'}, no slab loose or with the player`, res);
    await cmd(`/setblock ${P(at).join(' ')} minecraft:hopper[facing=down]`);
    return fed;
  }

  /** A town built, filled and PLACED; its fk site. */
  async function built(W, tag, skip, { swap = false } = {}) {
    const site = await fkSite(skip);
    check(!!site, `${tag}: fk_hall's site joined the feed (${site})`);
    if (!site) return null;
    await blocksBuilt(tag, site);
    const fed0 = swap ? await swapCase(tag, site) : {};
    const f = await filled(site);
    f.fed = G.plus(fed0, f.fed);
    const r0 = await G.feed({ L }, W.region, { fraction: 1, until: (st, rs) => st.view.state === 'PLACED' && rs.build?.done, timeoutMs: 900_000, every: 2500 });
    check(r0.last.st.view.state === 'PLACED', `${tag}: the town PLACED`);
    return { site, s: await fk(site), fed: f.fed };
  }

  // ------------------------------------------------------------------ fkb-unit

  steps.fkbunit = async () => {
    const out = {};
    out.kit = h.nodeTest(['kit/test/fk.test.mjs']);
    check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 10, `kit fk.test (FK's cases plus FK-b's: provided beside billed items, provided only, the four new findings, the allow-list = Limits.FILL_PROVIDED_ITEMS, fk_hall provided 1): ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
    out.java = await h.javaTests(['*FillsFKBTest*', '*ApiFKBTest*', '*FillsFKTest*', '*ApiFKTest*'], 20);
    check(out.java.ok, `FillsFKBTest (the split, the mod's refusals, provided/heldProvided saved and dropped at the credit refunding nothing, the Transfer API guard's target in our Fabric API), ApiFKBTest, FillsFKTest, ApiFKTest: ${out.java.tests} tests, ${out.java.failures} failures (${out.java.names.join('; ')})`, out.java.tail);
    const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` };
    const J = h.apiJars();
    out.apicompat = [...J.jars.map((j) => ['tools/api-compat.mjs', j]), ['tools/api-compat.mjs', '--surface', J.surface]].map((args) => {
      const ac = fs.existsSync(args.at(-1)) ? spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 900_000, env }) : { status: -1, stdout: `missing ${args.at(-1)}`, stderr: '' };
      return { args: args.slice(1).map((a) => path.basename(a)), code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter(Boolean).slice(-3) };
    });
    check(out.apicompat.every((a) => a.code === 0), 'api-compat: binary compatible (FK-b adds Limits.FILL_PROVIDED_ITEMS)', out.apicompat);
    spendZero();
    return out;
  };

  // ------------------------------------------------------------------ fkb-survival

  steps.fkbsurvival = async () => {
    await ensure();
    const out = {};
    const W = await town('G6B FKB Survival');
    const q = W.q;
    out.quote = { bom: q.bom, fill: q.bomParts?.['fill:cottage_1'], refused: q.refused };
    check(!q.refused && G.same(q.bomParts?.['fill:cottage_1'], BILL) && !(SLAB in (q.bom ?? {})),
      `the quote: the piece fill:cottage_1 is the filter items only ${json(q.bomParts?.['fill:cottage_1'])}; no slab anywhere in the bill`, out.quote);
    const b = await built(W, 'fkb-survival', undefined, { swap: true });
    if (!b) { await L.leaveWorld(); return out; }
    let s = b.s;
    const site = b.site;
    out.afterFill = s;
    const ps1 = await pile();
    const consumed = G.minus(ps1.ledger?.consumed ?? {}, W.ps0.ledger?.consumed ?? {});
    out.consumed = consumed;
    check(G.same(consumed, q.bom) && !(SLAB in consumed) && G.same(b.fed, BILL), `consumed = the quote item for item (${sum(consumed)} = ${sum(q.bom)}; differ ${json(G.minus(consumed, q.bom))}); fed for the fill: the filter items only ${json(b.fed)}; no slab consumed`, { consumed, quote: q.bom, fed: b.fed });
    check(s.phase === 'UNLOCKED' && exactly(s) && slabsOf(s) === SLABS && G.same(only(s.paid, ALL), BILL) && G.same(s.provided, { [SLAB]: SLABS }) && s.guarded === 4,
      `filled: each hopper holds its plan, slabs included (${s.containers.map((c) => json(c.holds)).join(' ')}); paid[key] the filter items only ${json(only(s.paid, ALL))}; the ledger's provided ${json(s.provided)}; ${s.guarded} declared containers guarded`, s);
    const g = await call('dev.fk.guard', {}, 10_000);
    out.guard = g;
    check(g.transferGuardApplied === true, `the Fabric Transfer API guard applied in our build (dev.fk.guard ${json(g)})`, g);

    // menu takes of a slab, as the player's real menu clicks
    const A = s.containers[0].at;
    const takes = {};
    for (const click of ['pickup', 'quick', 'swap', 'offhand', 'throw', 'throwAll', 'collect']) {
      takes[click] = await call('dev.fk.take', { pos: P(A), slot: 1, click }, 30_000);
    }
    out.takes = takes;
    const refused = Object.entries(takes).every(([, t]) => !t.error && t.mode === 'survival' && t.creative === false && t.containerSlabsLost === 0 && t.slabsGained === 0 && t.slabEntitiesGained === 0);
    check(refused, `every menu take of a slab from ${A} refused for the survival player (pickup, shift-click, swap, offhand, Q, ctrl-Q, double-click collect): ${Object.entries(takes).map(([k, t]) => `${k}: lost ${t.containerSlabsLost}, gained ${t.slabsGained}/${t.slabEntitiesGained}${t.error ? ` ${t.error}` : ''}`).join('; ')}`, takes);
    const tf = await call('dev.fk.take', { pos: P(A), slot: 0, click: 'pickup' }, 30_000);
    out.takeFilter = tf;
    check(/minecraft:flint x18/.test(tf.carried ?? '') && G.same(tf.restored, tf.before), `a filter item's pickup is allowed (carried ${tf.carried}; put back: ${json(tf.restored)})`, tf);
    // a hopper minecart under the filter hopper pulls the filter item, never a slab
    const pl = await call('dev.fk.pull', { pos: P(A), n: 6 }, 30_000);
    out.pull = pl;
    check(!(SLAB in (pl.pulled ?? {})) && (pl.after?.[SLAB] ?? 0) === 4, `a hopper minecart under ${A} pulled ${json(pl.pulled)}: no slab (the hopper keeps its 4)`, pl);
    if (pl.pulled?.[FLINT]) await hand(A, { add: { [FLINT]: pl.pulled[FLINT] } }); // the pulled filter items back
    // the Fabric Transfer API (ItemStorage.SIDED)
    const ts = await call('dev.fk.transfer', { pos: P(A), item: SLAB, max: 64 }, 30_000);
    const tfl = await call('dev.fk.transfer', { pos: P(A), item: FLINT, max: 4 }, 30_000);
    out.transfer = { slab: ts, flint: tfl };
    check(ts.extracted === 0 && tfl.extracted === 4, `a Transfer API extraction from ${A}: slabs ${ts.extracted} (none), flint ${tfl.extracted} (a filter item moves)`, out.transfer);

    // the negative case: a hopper set by command, holding slabs, not a fill container: vanilla
    const [nx, ny, nz] = [CLAIM[0] - 6, W.gy + 4, CLAIM[1] - 10];
    await cmd(`/setblock ${nx} ${ny} ${nz} minecraft:hopper[facing=down]`);
    await cmd(`/setblock ${nx} ${ny - 1} ${nz} minecraft:air`);
    await hand([nx, ny, nz], { clear: true, add: { [SLAB]: 4 } });
    const nt = await call('dev.fk.take', { pos: [nx, ny, nz], slot: 0, click: 'pickup' }, 30_000);
    await hand([nx, ny, nz], { clear: true, add: { [SLAB]: 4 } });
    const np = await call('dev.fk.pull', { pos: [nx, ny, nz], n: 2 }, 30_000);
    await cmd('/kill @e[type=item]');
    const nb = await call('dev.fk.break', { pos: [nx, ny, nz] }, 30_000);
    await L.settle(800);
    const ne = await slabsNear([nx, ny, nz]);
    out.negative = { take: nt, pull: np, brk: nb, near: ne };
    check(nt.mode === 'survival' && nt.slabsGained === 4 && np.pulled?.[SLAB] === 2 && nb.broken === true && nb.stripped === 0 && ne.entities === 2,
      `negative: a hopper set by command holding slabs behaves as vanilla: taken (${nt.slabsGained}), pulled by a minecart (${json(np.pulled)}), dropped at its break (${ne.entities} slab entities, none stripped)`, out.negative);
    await cmd('/kill @e[type=item]');
    await cmd(`/clear @a ${SLAB}`);


    // the region removed: the filter items refunded, the slabs taken and refunded never; no slab anywhere
    const near = P(A);
    await cmd('/kill @e[type=item]');
    const psR0 = await pile();
    await G.remove(ctx, W.region);
    const stR = await call('dev.region.state', { region: W.region }, 60_000).catch(() => null);
    const psR1 = await pile();
    const back = G.minus(G.plus(psR1.ledger?.returned, psR1.ledger?.refundOverflow), G.plus(psR0.ledger?.returned, psR0.ledger?.refundOverflow));
    const items = (await call('dev.items.near', { pos: near, radius: 24 }, 60_000)).items ?? {};
    const sl = await slabsNear(A);
    const sx = await fk(site).catch(() => ({}));
    out.removed = { state: stR?.view?.state, back, consumed, items, slabs: sl, ledger: { custody: psR1.ledger?.custody, provided: psR1.ledger?.provided, heldProvided: psR1.ledger?.heldProvided } };
    check(['REMOVED', undefined].includes(stR?.view?.state) && G.same(back, consumed) && !(SLAB in back) && sum(only(items, ALL)) === 0 && sl.player === 0 && sl.entities === 0
      && !psR1.ledger?.custody && !psR1.ledger?.provided && !psR1.ledger?.heldProvided,
      `the region removed (${stR?.view?.state ?? 'gone'}): refund = consumed, the billed part only (${sum(back)} = ${sum(consumed)}; differ ${json(G.minus(back, consumed))}; no slab refunded); nothing dropped (${json(only(items, ALL))}); the player ${sl.player} and the item entities ${sl.entities} slabs; no custody, provided or heldProvided left`, out.removed);
    out.siteAfter = sx;
    await L.leaveWorld();

    // the repair cycle: break two filter hoppers (the player, TNT), remove the region, grow it again under a new key
    const R = await town('G6B FKB Repair');
    const rb = await built(R, 'repair');
    if (rb) {
      const s0 = rb.s;
      const [hA, , hC] = s0.containers.map((c) => c.at);
      await cmd('/kill @e[type=item]');
      const st0 = (await call('dev.fk.guard', {}, 10_000)).stripped;
      const br = await call('dev.fk.break', { pos: P(hA) }, 30_000);
      await L.settle(1000);
      const afterBreak = { near: await slabsNear(hA), items: (await call('dev.items.near', { pos: P(hA), radius: 8 }, 60_000)).items ?? {} };
      const [cx, cy, cz] = P(hC);
      await cmd(`/summon minecraft:tnt ${cx + 0.5} ${cy} ${cz + 1.5} {fuse:1}`);
      await L.settle(3000);
      const s1 = await fk(rb.site);
      const gone = (s1.containers ?? []).filter((c) => c.holds === undefined || c.holds === null).length;
      const st1 = (await call('dev.fk.guard', {}, 10_000)).stripped;
      const afterTnt = await slabsNear(hC);
      out.breaks = { br, afterBreak, gone, stripped: st1 - st0, afterTnt, holds: s1.containers?.map((c) => c.holds ?? null) };
      check(br.broken === true && br.stripped === 4 && afterBreak.near.entities === 0 && (afterBreak.items[FILTERS[0]] ?? 0) === 18,
        `the player breaks the filter hopper at ${hA}: its 4 slabs stripped (${br.stripped}), its 18 flint dropped as the player's goods (${afterBreak.items[FILTERS[0]] ?? 0}), no slab entity (${afterBreak.near.entities})`, out.breaks);
      check(gone >= 2 && st1 - st0 === 4 * gone && afterTnt.entities === 0 && afterTnt.player === 0,
        `TNT at ${hC}: ${gone - 1} more declared hopper(s) gone, all stripped (${st1 - st0} = 4 x ${gone}); no slab entity (${afterTnt.entities}), the player ${afterTnt.player}`, out.breaks);
      await cmd('/kill @e[type=item]');
      await G.remove(ctx, R.region);
      const g2 = await grow(R.name, R.gy);
      const rb2 = await built(g2, 'repair: grown again', new Set());
      if (rb2) {
        const s2 = rb2.s;
        const ps2 = await pile();
        const consumed2 = G.minus(ps2.ledger?.consumed ?? {}, g2.ps0.ledger?.consumed ?? {});
        const sl2 = await slabsNear(s2.containers[0].at);
        out.repair = { key0: s0.key, key: s2.key, fill: g2.q.bomParts?.['fill:cottage_1'], fed: rb2.fed, consumed2, quote2: g2.q.bom, holds: s2.containers.map((c) => c.holds), slabs: sl2 };
        check(s2.key !== s0.key && G.same(g2.q.bomParts?.['fill:cottage_1'], BILL) && G.same(rb2.fed, BILL) && G.same(consumed2, g2.q.bom) && exactly(s2) && slabsOf(s2) === SLABS && sl2.player === 0 && sl2.entities === 0,
          `repair, one cycle: grown again under a new key (${s0.key} -> ${s2.key}); the new bill the filter items only ${json(g2.q.bomParts?.['fill:cottage_1'])} (fed ${json(rb2.fed)}); consumed = the quote (differ ${json(G.minus(consumed2, g2.q.bom))}); the slabs exactly the plan (${slabsOf(s2)}); no slab with the player or loose`, out.repair);
      }
    }
    await L.leaveWorld();

    // creative: the entry placed instant fills its slabs (guarded); a bad declaration is refused by the kit and by the mod before any write
    await L.fresh('G6B FKB Creative', G.FLAT);
    await entry();
    const cg = await groundY();
    const origin = [CX, cg, CZ];
    const area = [CX - 3, cg - 3, CZ - 3, CX + 12, cg + 8, CZ + 12];
    await L.tp(CX + 4, cg + 20, CZ - 10);
    await L.settle(1500);
    const pc = await call('dev.pl.place', { blueprint: 'fk_hall', origin, mode: 'instant' }, 300_000);
    await L.settle(1500);
    const c = pc.site ? await fk(pc.site) : {};
    out.creative = { placed: pc.placed, phase: c.phase, slabs: slabsOf(c), guarded: c.guarded };
    check(pc.placed && c.phase === 'UNLOCKED' && exactly(c) && slabsOf(c) === SLABS && c.guarded === 4,
      `creative: fk_hall provided 1 placed instant: filled with its slabs (${slabsOf(c)}), ${c.guarded} declared containers guarded`, out.creative);
    if (pc.site) await call('dev.pl.remove', { site: pc.site }, 600_000);
    await L.settle(1500);
    const h0 = await h.hashOf(area);
    const bad1 = await entry({ mutate: (bp) => { bp.fillSpec.containers[0].items[1] = { slot: 1, id: 'minecraft:diamond', count: 1, provided: true }; } });
    const pBad1 = await call('dev.pl.place', { blueprint: 'fkb_bad', origin, mode: 'instant' }, 120_000).catch((e) => ({ error: String(e) }));
    const bad2 = await entry({ mutate: (bp) => { bp.fillSpec.containers[0].items[1] = { slot: 1, id: SLAB, count: 1 }; } });
    const pBad2 = await call('dev.pl.place', { blueprint: 'fkb_bad', origin, mode: 'instant' }, 120_000).catch((e) => ({ error: String(e) }));
    await L.settle(1000);
    const h1 = await h.hashOf(area);
    const kitNo = [bad1.ck.errors.find((e) => /can't be module-provided/.test(e)), bad2.ck.errors.find((e) => /is creative-only/.test(e))];
    out.bad = { kit: kitNo, place1: pBad1, place2: pBad2, hashSame: h0 === h1 };
    check(kitNo.every(Boolean) && pBad1.placed !== true && /can't be module-provided/.test(JSON.stringify(pBad1)) && pBad2.placed !== true && /creative-only/.test(JSON.stringify(pBad2)) && h0 === h1,
      `a bad declaration is refused: by the kit (${kitNo.join(' | ')}); by the mod before any write, NOT_ALLOWED (${json(pBad1.refusals ?? pBad1).slice(0, 160)}; ${json(pBad2.refusals ?? pBad2).slice(0, 160)}); 0 cells written (the box's hash unchanged: ${h0 === h1})`, out.bad);
    await L.leaveWorld();
    spendZero();
    return out;
  };

  // ------------------------------------------------------------------ fkb-crash

  async function restart(name) {
    await L.openWorld(name);
    await L.tp(CX + 80, 60, CZ + 56);
    await L.settle(4000);
  }

  async function halt(tag) {
    const down = await haltWait();
    check(down, `${tag}: the halt stopped the server`);
    return down;
  }

  /** FK2, FK3 with slabs: the fill fed with the kill point armed; the restart ends it once. */
  async function fillCase(point) {
    const tag = `${point}+slabs`;
    const W = await town(`G6B FKB ${point}`);
    const site = await fkSite();
    if (!site) { check(false, `${tag}: no fk_hall site`); await L.leaveWorld(); return null; }
    await blocksBuilt(tag, site);
    const pr = await call('dev.stockpile.pause', { owner: G.OWNER, site, paused: true }, 60_000);
    check(!pr.refused, `${tag}: ${site} paused`);
    const acc = await deliver({ fill: true });
    check(G.same(acc, BILL), `${tag}: the filter items delivered while it is paused (${json(acc)})`);
    await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
    await cmd('/save-all flush');
    await call('dev.journal.killAt', { point }, 10_000);
    call('dev.stockpile.pause', { owner: G.OWNER, site, paused: false }, 60_000).catch(() => null);
    if (!(await halt(tag))) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await L.leaveWorld(); return null; }
    const S = savedLedger(W.name);
    const markerSaved = (S?.filled ?? []).some((k) => k.startsWith(`site:${site}@`));
    await restart(W.name);
    const f = await filled(site, { ms: 300_000 });
    const s = f.s;
    const L2 = (await pile()).ledger;
    const charged = only(G.minus(L2.consumed, S.consumed), ALL);
    const stockS = only(G.minus(G.plus(S.delivered, S.returned), G.plus(S.consumed, G.plus(S.withdrawn, S.dropped))), FK);
    const stockF = only((await pile()).stock, FK);
    const sl = await slabsNear(s.containers?.[0]?.at ?? CLAIM);
    const res = { markerSaved, charged, fed: f.fed, holds: s.containers?.map((c) => c.holds), provided: s.provided, slabs: sl };
    log(`  ${tag}: ${json(res).slice(0, 600)}`);
    const want = markerSaved ? {} : BILL;
    check(s.state === 'BUILT' && s.phase === 'UNLOCKED' && exactly(s) && slabsOf(s) === SLABS && G.same(s.provided, { [SLAB]: SLABS }),
      `${tag}: after the restart the fill ends once: each hopper exactly its plan, the slabs ${slabsOf(s)} (no duplicate, no loss); the ledger's provided ${json(s.provided)}`, res);
    check(G.same(charged, want) && G.same(G.plus(stockS, f.fed), G.plus(stockF, only(charged, FK))) && sl.player === 0 && sl.entities === 0,
      `${tag}: charged since the saved state ${json(charged)} (the commit ${markerSaved ? 'on disk: nothing more' : 'not on disk: the bill once'}; never a slab); items in = items out for the filter items; no slab loose or with the player`, res);
    await L.leaveWorld();
    return res;
  }

  /** FKC1, FKC2 with slabs: the region removed with the kill point armed; the restart refunds the billed part once. */
  async function removalCase(point) {
    const tag = `${point}+slabs`;
    const W = await town(`G6B FKB ${point}`);
    const b = await built(W, tag);
    if (!b) { await L.leaveWorld(); return null; }
    const at = P(b.s.containers[0].at);
    await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
    await cmd('/kill @e[type=item]');
    await cmd('/save-all flush');
    const B = savedLedger(W.name);
    const consumed = G.minus(B.consumed, W.ps0.ledger?.consumed ?? {});
    await call('dev.journal.killAt', { point }, 10_000);
    call('dev.region.remove', { region: W.region, requester: G.OWNER }, 600_000).catch(() => null);
    if (!(await halt(tag))) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await L.leaveWorld(); return null; }
    const S = savedLedger(W.name);
    const savedHeld = Object.values(S.heldProvided ?? {}).reduce((a, m) => G.plus(a, m), {});
    const savedCustody = Object.values(S.custody ?? {}).reduce((a, m) => G.plus(a, m), {});
    await restart(W.name);
    let st = await call('dev.region.state', { region: W.region }, 60_000).catch(() => null);
    for (let i = 0; i < 600 && st?.view && !['REMOVED', 'PARTIAL', 'FAILED'].includes(st.view.state); i++) {
      if (i === 15 && st.view.state === 'PLACED') await G.remove(ctx, W.region);
      await L.sleep(1000);
      st = await call('dev.region.state', { region: W.region }, 60_000).catch(() => null);
    }
    await L.settle(2000);
    const F = (await pile()).ledger;
    const back = G.minus(G.plus(F.returned, F.refundOverflow), G.plus(B.returned, B.refundOverflow));
    const items = (await call('dev.items.near', { pos: at, radius: 24 }, 60_000)).items ?? {};
    const sl = await slabsNear(at);
    const res = { savedCustody, savedHeld, state: st?.view?.state ?? 'gone', back: sum(back), consumed: sum(consumed), diff: G.minus(back, consumed), items: only(items, ALL), slabs: sl, left: { custody: F.custody, provided: F.provided, heldProvided: F.heldProvided } };
    log(`  ${tag}: ${json(res).slice(0, 600)}`);
    check(point !== 'FKC1' || (sum(savedCustody) > 0 && savedHeld[SLAB] === SLABS), `${tag}: the custody (${json(savedCustody)}) and the held slabs (${json(savedHeld)}) were on disk at the halt`, res);
    check(['REMOVED', 'gone'].includes(res.state) && G.same(back, consumed) && !(SLAB in back) && sum(only(items, ALL)) === 0 && sl.player === 0 && sl.entities === 0 && !F.custody && !F.provided && !F.heldProvided,
      `${tag}: after the restart the removal ends once (${res.state}): refund = consumed, the billed part only (${sum(back)} = ${sum(consumed)}; differ ${json(res.diff)}; no slab refunded); nothing dropped; no slab loose or with the player; no custody, provided or heldProvided left`, res);
    await L.leaveWorld();
    return res;
  }

  /** The strip's crash case: a filter hopper broken and the JVM halted before any save; the restart finds it standing with its slabs. */
  async function stripCase() {
    const tag = 'STRIP-halt';
    const W = await town('G6B FKB STRIP');
    const b = await built(W, tag);
    if (!b) { await L.leaveWorld(); return null; }
    const A = b.s.containers[0].at;
    await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
    await cmd('/kill @e[type=item]');
    await cmd('/save-all flush');
    call('dev.fk.break', { pos: P(A), halt: true }, 30_000).catch(() => null);
    if (!(await halt(tag))) { await L.leaveWorld(); return null; }
    const S = savedLedger(W.name);
    const ev = (() => { try { return JSON.parse(fs.readFileSync(path.join(W.dir, 'fkb-strip-halt.json'), 'utf8')); } catch { return null; } })();
    check(ev?.broken === true && ev?.stripped === 4, `${tag}: the break happened and stripped its 4 slabs before the halt (${json(ev)})`, ev);
    await restart(W.name);
    const s = await fk(b.site);
    const sl = await slabsNear(A);
    const res = { holdsA: s.containers?.[0]?.holds, slabs: sl, heldProvided: S.heldProvided ?? null, provided: s.provided, phase: s.phase };
    log(`  ${tag}: ${json(res)}`);
    check(G.same(s.containers?.[0]?.holds, s.containers?.[0]?.declared) && sl.entities === 0 && sl.player === 0 && !S.heldProvided && G.same(s.provided, { [SLAB]: SLABS }),
      `${tag}: after the restart the broken hopper stands as saved with its slabs (${json(res.holdsA)}); no slab entity (${sl.entities}), none with the player; no heldProvided; provided[key] unchanged ${json(s.provided)}`, res);
    await L.leaveWorld();
    return res;
  }

  /**
   * (FK-b fix) FK3 with somewhere to eject: fk_hall with a chest under its third hopper (that hopper pushes down into it). The world is
   * saved ahead of the ledger at FK3; at the restart the reconcile runs at the start of the first tick, before the hopper can move an
   * item: the fill clears and fills once (the bill once), and no slab ever leaves a declared hopper (the chest gets the billed item only).
   */
  async function ejectCase() {
    const tag = 'FK3-eject';
    let chestAt = null;
    const W = await town('G6B FKB FK3 eject', { mutate: (bp) => bp.set(3, 1, 1, 'minecraft:chest', { facing: 'south' }) });
    const site = await fkSite();
    if (!site) { check(false, `${tag}: no fk_hall site`); await L.leaveWorld(); return null; }
    await blocksBuilt(tag, site);
    const at = (await fk(site)).containers?.[2]?.at;
    const ap = P(at);
    chestAt = [ap[0], ap[1] - 1, ap[2]];
    const pr = await call('dev.stockpile.pause', { owner: G.OWNER, site, paused: true }, 60_000);
    check(!pr.refused, `${tag}: ${site} paused`);
    const acc = await deliver({ fill: true });
    check(G.same(acc, BILL), `${tag}: the filter items delivered while it is paused (${json(acc)})`);
    await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
    await cmd('/save-all flush');
    await call('dev.journal.killAt', { point: 'FK3' }, 10_000);
    call('dev.stockpile.pause', { owner: G.OWNER, site, paused: false }, 60_000).catch(() => null);
    if (!(await halt(tag))) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await L.leaveWorld(); return null; }
    const S = savedLedger(W.name);
    const markerSaved = (S?.filled ?? []).some((k) => k.startsWith(`site:${site}@`));
    await restart(W.name);
    const f = await filled(site, { ms: 300_000 });
    await L.sleep(4000); // the hopper has had time to push (one item per 8 ticks)
    const s = await fk(site);
    const chest = (await hand(chestAt, {})).holds ?? {};
    const L2 = (await pile()).ledger;
    const charged = only(G.minus(L2.consumed, S.consumed), ALL);
    const sl = await slabsNear(at);
    const res = { markerSaved, chest, charged, fed: f.fed, phase: s.phase, holds: s.containers?.map((c) => c.holds), provided: s.provided, slabs: sl };
    log(`  ${tag}: ${json(res).slice(0, 700)}`);
    check(!markerSaved && s.state === 'BUILT' && s.phase === 'UNLOCKED' && slabsOf(s) === SLABS && G.same(s.provided, { [SLAB]: SLABS }) && G.same(charged, BILL),
      `${tag}: the world saved ahead of the ledger (marker on disk: ${markerSaved}); after the restart the fill ends once (${s.phase}): the slabs ${slabsOf(s)} in the declared hoppers, the bill charged once ${json(charged)}`, res);
    check(!(SLAB in chest) && sl.entities === 0 && sl.player === 0 && (chest[FILTERS[2]] ?? 0) > 0,
      `${tag}: the hopper over the chest pushed its billed item (${chest[FILTERS[2]] ?? 0} ${FILTERS[2]}) and never a slab (the chest ${json(chest)}); no slab loose or with the player`, res);
    await L.leaveWorld();
    return res;
  }

  steps.fkbcrash = async () => {
    await ensure();
    const out = {};
    for (const p of ['FK2', 'FK3']) out[p] = await fillCase(p);
    out.FK3eject = await ejectCase();
    for (const p of ['FKC1', 'FKC2']) out[p] = await removalCase(p);
    out.STRIP = await stripCase();
    spendZero();
    return out;
  };
}
