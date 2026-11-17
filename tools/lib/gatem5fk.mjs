// M5 FK gate (docs/CONTRACT.md "M5 support", "### FK contract"; Steward's S-M5-3): filled containers of a given-program entry, registered
// into tools/gate6dgr.mjs (GR's survival town and feed helpers). Headless server, the sim sidecar: $0. Strict (journal, billing, crash replay).
//
//   node tools/gate6dgr.mjs fkunit      (fk-unit)      kit fk.test (bp.fillContainers, the checker's rule fill), FillsFKTest (the mod's checks, the
//                                                      lock rule, ours-or-cargo, the marker and the custody in the ledger), ApiFKTest; api-compat
//   node tools/gate6dgr.mjs fksurvival  (fk-survival)  a survival flat_village town with cottage_1 bound to fk_hall (4 declared filter hoppers,
//                                                      a lever lock): quoted (the fill:cottage_1 piece); the town's blocks fed but not the fill
//                                                      (its items are no block's): every fk cell stands, the site BUILDING and waiting; an item
//                                                      put in a declared hopper: the typed wait fill_blocked with that cell; taken out; the fill
//                                                      fed: filled once, the lever unlocked, BUILT; consumed = the quote item for item; the player
//                                                      takes 8 flint from a hopper; one extra clay ball in another refuses the removal as cargo
//                                                      (nothing written); taken out; the region removed: refund = consumed less the 8 flint, no
//                                                      item dropped, the custody gone; a restart gives nothing again. Then the creative twin: the
//                                                      entry placed instant: filled, unlocked; Remove exact
//   node tools/gate6dgr.mjs fkcrash     (fk-crash)     the same town, a halt with nothing saved (no save after the baseline's /save-all flush):
//                                                      FK1 after the FILLING record, FK2 the fill charged and written in memory, FK3 inside the
//                                                      commit (chunks flushed, the ledger not), FK4 after the commit before the unlock; FKC1 a
//                                                      removal's custody saved, before its world write; FKC2 the restore written, before the
//                                                      credit. Each: the saved ledger off the disk; after the restart filled exactly once (FK1-4:
//                                                      consumed since the saved state = the fill once or none, the hoppers exactly their
//                                                      declaration, the lever unlocked) or refunded exactly once (FKC1-2: what came back = what
//                                                      the town consumed, item for item; no custody left; nothing dropped);
//                                                      (J2) CS1: the fk_hall site removed on its own, halted inside its credit's save:
//                                                      the credit pending on disk books once at the start (= its paid record)
//                                                      (OVF) CS1o: the same into a full stockpile (capacity 0, TEST): the whole refund
//                                                      returned into the stock once, past capacity; no item entity (before: dropped twice)
//
// Evidence: artifacts/gate6d-gr/<step>.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const FLINT = 'minecraft:flint', CLAY = 'minecraft:clay_ball';
/** fk_hall at slots 4, count 18: four hoppers of 18 filter items and 4 papers each */
const FILL = { 'minecraft:flint': 18, 'minecraft:clay_ball': 18, 'minecraft:bone': 18, 'minecraft:feather': 18, 'minecraft:paper': 16 };
const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];

export async function registerFK(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, hashOf, groundY, BOXOF, CX, CZ, CLAIM, haltWait, root } = h;
  const ctx = { L, OUT: h.OUT, imp: h.imp };
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const fk = (site) => call('dev.fk.state', { site }, 30_000);
  const hand = (at, o) => call('dev.fk.container', { pos: at.split(',').map(Number), ...o }, 30_000);
  const ledgerOf = (rootJson) => (rootJson?.stockpiles ?? []).find((p) => p.owner === G.OWNER)?.ledger ?? null;
  const savedLedger = (name) => ledgerOf(JSON.parse(fs.readFileSync(path.join(L.SAVES, name, 'architect', 'stockpiles.json'), 'utf8')));
  const only = (m, keys) => Object.fromEntries(Object.entries(m ?? {}).filter(([k]) => keys.includes(k)));
  const FK = Object.keys(FILL);

  /** fk_hall, built from the kit's fixture program (kit/test/fixtures/fk) at slots 4, count 18, written to the library; its sidecar
   *  marked as a given program's entry (`givenProgram`, as Designs.fromProgram records it: sidecar test programs.test.ts shows the install
   *  keeps `fill` with it). */
  async function entry() {
    await G.designs(ctx);
    const src = fs.readFileSync(path.join(root, 'kit', 'test', 'fixtures', 'fk', 'fk_hall.mjs'), 'utf8')
      .replaceAll("'../lib/", `'${pathToFileURL(path.join(root, 'kit', 'lib')).href}/`);
    const tmp = path.join(h.OUT, 'fk_hall.mjs');
    fs.writeFileSync(tmp, src);
    const mod = await import(`${pathToFileURL(tmp).href}?t=${Date.now()}`);
    const { writeBlueprint } = await h.imp('lib/write.mjs');
    const { checkBlueprint } = await h.imp('lib/check.mjs');
    const bp = mod.default({ slots: 4, count: 18 });
    const ck = checkBlueprint(bp, {});
    check(ck.ok, `fk_hall (the fixture program, slots 4, count 18) checks clean, its fill rule included: ${ck.errors.slice(0, 3).join('; ') || 'OK'}`);
    const dir = path.join(L.LIBRARY, 'fk_hall');
    fs.rmSync(dir, { recursive: true, force: true });
    const w = writeBlueprint(bp, dir);
    const j = JSON.parse(fs.readFileSync(w.jsonPath, 'utf8'));
    j.givenProgram = { sha: 'gate-fixture', opKey: 'gate.fk.hall' };
    fs.writeFileSync(w.jsonPath, `${JSON.stringify(j, null, 2)}\n`);
    await L.cmd('/architect reload');
    await L.settle(1500);
    return j;
  }

  /** A fresh survival world with the stockpile and fk_hall; the town planned (cottage_1: fk_hall), quoted, realised. */
  async function town(name) {
    await G.survivalBase(ctx);
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    const j = await entry();
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `${name}: a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const q = await call('dev.region.quote', { planId: p0.planId, lotEntries: { cottage_1: 'fk_hall' } }, 300_000);
    const ps0 = await pile();
    const region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: 'fk_hall' } });
    return { name, gy, region, q, ps0, entry: j, crates, BOX: BOXOF(CLAIM, gy), dir: path.join(L.SAVES, name) };
  }

  /** The fk_hall site among the stockpile's targets (the one with a fill). */
  async function fkSite() {
    // the lots stage is put down once the ground and street stages are built: feed those (never the fill's items) meanwhile
    const seen = new Set();
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

  /** Delivers what the targets lack, the fill's items left out (`fill` false) or only them (`fill` true). */
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

  /** Feeds the town's blocks (never the fill's items) until every target but fk_hall is built and fk_hall's cells all stand. */
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
    check(t && t.built === t.queued, `${tag}: the town's blocks fed (the fill's items held back): every fk_hall cell stands (${t?.built}/${t?.queued})`, t);
    return t;
  }

  /** Waits until fk_hall is BUILT and UNLOCKED (the fill fed if it waits for it), at most `ms`. */
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

  const leverUnlocked = (s) => (s.locks ?? []).every((l) => /powered=false/.test(l.state ?? ''));
  const exactly = (s) => (s.containers ?? []).every((c) => G.same(c.holds, c.declared));

  // ------------------------------------------------------------------ fk-unit

  steps.fkunit = async () => {
    const out = {};
    out.kit = h.nodeTest(['kit/test/fk.test.mjs']);
    check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 6, `kit fk.test (bp.fillContainers' sidecar member, template coordinates; the checker's rule fill: every refusal, a lock only on a lever's powered; mirror/invert refuse a fill): ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
    out.java = await h.javaTests(['*FillsFKTest*', '*ApiFKTest*', '*StockpilePaidJRTest*'], 10);
    check(out.java.ok, `FillsFKTest (given-program only, the mod's own checks, a kept lock, ours while within the declaration; the custody refunds once with the blocks, capped by paid; the marker and custody saved), ApiFKTest, StockpilePaidJRTest: ${out.java.tests} tests, ${out.java.failures} failures (${out.java.names.join('; ')})`, out.java.tail);
    const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` };
    const J = h.apiJars();
    out.apicompat = [...J.jars.map((j) => ['tools/api-compat.mjs', j]), ['tools/api-compat.mjs', '--surface', J.surface]].map((args) => {
      const ac = fs.existsSync(args.at(-1)) ? spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 900_000, env }) : { status: -1, stdout: `missing ${args.at(-1)}`, stderr: '' };
      return { args: args.slice(1).map((a) => path.basename(a)), code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter(Boolean).slice(-3) };
    });
    check(out.apicompat.every((a) => a.code === 0), 'api-compat: binary compatible (FK adds two Limits constants, SiteWait components with the old constructor kept)', out.apicompat);
    spendZero();
    return out;
  };

  // ------------------------------------------------------------------ fk-survival (and the creative twin)

  steps.fksurvival = async () => {
    await ensure();
    const out = {};
    const W = await town('G6B FK Survival');
    const q = W.q;
    out.quote = { bom: q.bom, fill: q.bomParts?.['fill:cottage_1'], exact: q.exact, refused: q.refused };
    check(!q.refused && G.same(q.bomParts?.['fill:cottage_1'], FILL), `the town's plan quoted with cottage_1: fk_hall: the piece fill:cottage_1 is the declaration's items ${json(q.bomParts?.['fill:cottage_1'])}`, out.quote);
    const site = await fkSite();
    check(!!site, `fk_hall's site joined the feed (${site})`);
    if (!site) { await L.leaveWorld(); return out; }
    await blocksBuilt('fk-survival', site);
    await L.sleep(9000); // the wait latches after 100 ticks without a placement
    let s = await fk(site);
    out.beforeFill = s;
    const next = Object.fromEntries((s.wait?.nextNeeded ?? []).map((x) => [x.item, x.count]));
    check(s.state === 'BUILDING' && !s.phase && s.containers.every((c) => sum(c.holds) === 0) && s.wait?.waiting === true && !s.wait?.blocked && G.same(only(next, FK), FILL),
      `every cell stands, the fill not fed: the site still BUILDING (${s.state}, phase ${s.phase ?? 'none'}), its hoppers empty, waiting for the fill's items (waiting ${s.wait?.waiting}, next ${json(s.wait?.nextNeeded ?? [])})`, s);
    // a declared container with an item in it at the fill: never filled over; the typed wait fill_blocked names it
    const h0 = s.containers[0].at;
    await hand(h0, { add: { [FLINT]: 1 } });
    await deliver({ fill: true });
    await L.sleep(5000);
    s = await fk(site);
    out.blocked = s.wait;
    check(s.state === 'BUILDING' && s.wait?.blocked === 'fill_blocked' && json(s.wait?.blockedCells) === json([h0]) && G.same(s.containers[0].holds, { [FLINT]: 1 }),
      `a flint put in the hopper at ${h0} before the fill: not filled over it; the typed wait blocked ${s.wait?.blocked}, cells ${json(s.wait?.blockedCells)}`, s.wait);
    await hand(h0, { take: { [FLINT]: 1 } });
    const f = await filled(site);
    s = f.s;
    out.afterFill = s;
    check(s.state === 'BUILT' && s.phase === 'UNLOCKED' && exactly(s) && leverUnlocked(s) && s.filled === true && !s.wait?.blocked,
      `the flint taken out: filled once and unlocked, then BUILT (${s.state}, ${s.phase}); each hopper holds exactly its declaration (${s.containers.map((c) => json(c.holds)).join(' ')}); the lever ${s.locks.map((l) => l.state).join(',')}; the ledger's marker ${s.filled}`, s);
    const r0 = await G.feed({ L }, W.region, { fraction: 1, until: (st, rs) => st.view.state === 'PLACED' && rs.build?.done, timeoutMs: 900_000, every: 2500 });
    const ps1 = await pile();
    const consumed = G.minus(ps1.ledger?.consumed ?? {}, W.ps0.ledger?.consumed ?? {});
    out.consumed = consumed;
    check(r0.last.st.view.state === 'PLACED' && G.same(consumed, q.bom), `the town PLACED; consumed equals the quote item for item, the fill included (consumed ${sum(consumed)} units, quote ${sum(q.bom)}; differ ${json(G.minus(consumed, q.bom))})`, { consumed, quote: q.bom });
    check(G.same(only(s.paid, FK), FILL), `the fill billed under the site's key ${s.key}: its paid record holds ${json(only(s.paid, FK))}`);
    // the player takes 8 flint (ours: still within the declaration); one more clay ball than declared in another (cargo)
    const [hA, hB] = [s.containers[0].at, s.containers[1].at];
    await hand(hA, { take: { [FLINT]: 8 } });
    await hand(hB, { add: { [CLAY]: 1 } });
    const psB = await pile();
    const refused = await call('dev.region.remove', { region: W.region, requester: G.OWNER }, 600_000);
    await L.settle(2000);
    const stB = await call('dev.region.state', { region: W.region }, 60_000);
    const psB2 = await pile();
    s = await fk(site);
    out.cargo = { refused, state: stB.view?.state, holds: s.containers.map((c) => c.holds) };
    check(stB.view?.state === 'PLACED' && refused.removed !== true && json(refused).includes('cargo') && G.same(psB.ledger?.returned, psB2.ledger?.returned) && G.same(s.containers[1].holds, G.plus(FILL_OF(1), { [CLAY]: 1 })) && sum(s.custody) === 0,
      `one clay ball over the hopper's declaration at ${hB}: the removal refused as cargo, nothing written (the region ${stB.view?.state}; refunded nothing; the custody empty; the hoppers as they were): ${json(refused).slice(0, 240)}`, out.cargo);
    await hand(hB, { take: { [CLAY]: 1 } });
    // the region removed: the hoppers' contents into custody in the credit's tick, refunded with the blocks once
    const near = [Number(hA.split(',')[0]), Number(hA.split(',')[1]), Number(hA.split(',')[2])];
    await cmd('/kill @e[type=item]');
    const psR0 = await pile();
    const rm = await G.remove(ctx, W.region);
    const stR = await call('dev.region.state', { region: W.region }, 60_000);
    const psR1 = await pile();
    const back = G.minus(G.plus(psR1.ledger?.returned, psR1.ledger?.refundOverflow), G.plus(psR0.ledger?.returned, psR0.ledger?.refundOverflow));
    const items = (await call('dev.items.near', { pos: near, radius: 24 }, 60_000)).items ?? {};
    const want = G.minus(consumed, { [FLINT]: 8 });
    out.removed = { rm, state: stR.view?.state, back, want, items, custody: (await pile()).ledger?.custody ?? null };
    check(['REMOVED', undefined].includes(stR.view?.state) && G.same(back, want) && sum(only(items, FK)) === 0 && !psR1.ledger?.custody,
      `the region removed (${stR.view?.state ?? 'gone'}): what came back = consumed less the 8 flint the player took, item for item (${sum(back)} = ${sum(want)}; differ ${json(G.minus(back, want))}); none of the fill's items dropped (${json(only(items, FK))}); no custody left`, out.removed);
    // a restart gives nothing again
    const l1 = (await pile()).ledger;
    await L.leaveWorld();
    await L.openWorld(W.name);
    await L.tp(CX + 80, 80, CZ + 56);
    await L.settle(4000);
    const l2 = (await pile()).ledger;
    check(json(l2) === json(l1), `after a restart the ledger is unchanged (nothing given twice)`, { l1, l2 });
    await L.leaveWorld();

    // the creative twin: the entry placed instant (no bill): filled and unlocked in the tick it is placed; Remove exact
    const CW = 'G6B FK Creative';
    await L.fresh(CW, G.FLAT);
    await entry();
    const g = await groundY();
    const origin = [CX, g, CZ];
    const area = [CX - 3, g - 3, CZ - 3, CX + 12, g + 8, CZ + 12];
    await L.tp(CX + 4, g + 20, CZ - 10);
    await L.settle(1500);
    const hc0 = await hashOf(area);
    const p = await call('dev.pl.place', { blueprint: 'fk_hall', origin, mode: 'instant' }, 300_000);
    await L.settle(1500);
    const c = p.site ? await fk(p.site) : {};
    out.creative = { placed: p.placed, site: p.site, state: c };
    check(p.placed && c.state === 'INSTANT' && c.phase === 'UNLOCKED' && exactly(c) && leverUnlocked(c), `creative: fk_hall placed instant (${p.site}): filled at once (${(c.containers ?? []).map((x) => json(x.holds)).join(' ')}), unlocked (${(c.locks ?? []).map((l) => l.state).join(',')}), phase ${c.phase}`, c);
    // (XR) another writer over a filled site's declared cell is refused before any write: a cell site over a hopper, a site layered over
    // the lever (a creative world: both writers may place instantly here)
    if (c.containers?.length) {
      const [hx, hy, hz] = c.containers[2].at.split(',').map(Number);
      const [lx, ly, lz] = c.locks[0].at.split(',').map(Number);
      const ow1 = await call('dev.cells.place', { kind: 'test:fk', cells: [[hx, hy, hz, 'minecraft:stone']], overlap: 'LAYER', force: true, naturalOnly: false }, 120_000).catch((e) => ({ error: String(e) }));
      const ow2 = await call('dev.pl.place', { blueprint: 'rs_shed', origin: [lx - 1, ly - 2, lz - 1], overlap: 'layer', force: true, mode: 'instant' }, 300_000).catch((e) => ({ error: String(e) }));
      await L.settle(1500);
      const cx = await fk(p.site);
      out.overwrite = { cells: ow1, site: ow2 };
      check(ow1.placed !== true && /filled\s*container\s*at/.test(json(ow1)) && ow2.placed !== true && /(filled\s*container|lock\s*cell)\s*at/.test(json(ow2)) && exactly(cx) && leverUnlocked(cx),
        `another writer over the fill's cells is refused before any write: a cell site over the hopper at ${hx},${hy},${hz} (${json(ow1.refusals ?? ow1).slice(0, 200)}); a site layered over the lever (${json(ow2.refusals ?? ow2).slice(0, 200)}); the hoppers and the lever as they were`, out.overwrite);
    }
    const rmc = p.site ? await call('dev.pl.remove', { site: p.site }, 600_000) : {};
    await L.settle(1500);
    const hc1 = await hashOf(area);
    const ci = (await call('dev.items.near', { pos: origin, radius: 16 }, 60_000)).items ?? {};
    check(rmc.removed && hc1 === hc0 && sum(only(ci, FK)) === 0, `creative: Remove (the declared hoppers holding their fill: not cargo) is exact: the box's hash as before; nothing dropped (${json(only(ci, FK))})`, { rmc, hc0, hc1 });
    await L.leaveWorld();
    spendZero();
    return out;
  };

  /** One hopper's declaration (fk_hall's i-th slot item 18 and 4 papers). */
  function FILL_OF(i) {
    const items = ['minecraft:flint', 'minecraft:clay_ball', 'minecraft:bone', 'minecraft:feather'];
    return { [items[i]]: 18, 'minecraft:paper': 4 };
  }

  // ------------------------------------------------------------------ (slice FKR, S-M5-15) fk-approved: the fill through realiseApproved

  /** The same town as plan/0 (one zone near the claim's centre), checked into an artifact; cottage_1 is one of its provisional lots. */
  const APPROVED = { schemaVersion: 'plan/0', planId: 'gate_fkr', zones: [{ id: 'town', required: true, program: { lots: TOWN.map(({ landmark, ...l }) => l) }, where: { near: { anchor: 'claim_center', within: 8 } } }] };
  const lockedLever = (s) => (s.locks ?? []).length > 0 && (s.locks ?? []).every((l) => /powered=true/.test(l.state ?? ''));

  async function approvedCheck(tag) {
    const ck = await call('dev.region.checkPlan', { plan: APPROVED, claim: CLAIM, owner: G.OWNER, load: 'generate' }, 1_800_000);
    const lot = ck.check?.parts?.find((p) => p.part === 'town');
    check(ck.check?.overall === 'READY' && !!ck.check?.artifactSha, `${tag}: Regions.checkPlan of the plan/0 town: ${ck.check?.overall ?? ck.refused} (town ${lot?.class}), artifact ${ck.check?.artifactSha?.slice(0, 12) ?? '-'}`, ck.check ?? ck);
    return ck.check;
  }

  steps.fkapproved = async () => {
    await ensure();
    const out = {};
    // survival: a fresh world, the stockpile, fk_hall; the plan checked (survival), quoted by its artifact, realised by realiseApproved
    const name = 'G6B FK Approved';
    await G.survivalBase(ctx);
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await entry();
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `fk-approved: a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    const c = await approvedCheck('fk-approved');
    if (!c?.artifactSha) { await L.leaveWorld(); return out; }
    out.check = { overall: c.overall, survival: c.survival, sha: c.artifactSha };
    check(c.survival === true, `fk-approved: the check answered in survival (${c.survival})`);
    const lots = { cottage_1: 'fk_hall' };
    const q = await call('dev.region.quote', { sha: c.artifactSha, lotEntries: lots }, 300_000);
    out.quote = { bom: q.bom, fill: q.bomParts?.['fill:cottage_1'], exact: q.exact, refused: q.refused, parts: Object.keys(q.bomParts ?? {}) };
    check(!q.refused && G.same(q.bomParts?.['fill:cottage_1'], FILL), `Regions.quoteApproved(artifact, cottage_1: fk_hall): the piece fill:cottage_1 is the declaration's items ${json(q.bomParts?.['fill:cottage_1'])} (exact ${q.exact})`, out.quote);
    const ps0 = await pile();
    const ra = await call('dev.region.realiseApproved', { sha: c.artifactSha, lotEntries: lots, opKey: 'gate.fkr.1' }, 300_000);
    out.region = ra.region ?? ra.refused ?? ra;
    check(!!ra.region, `Regions.realiseApproved with cottage_1 (a provisional lot) bound to fk_hall: region ${ra.region ?? json(ra)}`);
    if (!ra.region) { await L.leaveWorld(); return out; }
    const site = await fkSite();
    check(!!site, `fk_hall's site (the approved lot) joined the feed (${site})`);
    if (!site) { await L.leaveWorld(); return out; }
    await blocksBuilt('fk-approved', site);
    await L.sleep(9000);
    let s = await fk(site);
    out.beforeFill = s;
    check(s.state === 'BUILDING' && !s.phase && s.containers.length === 4 && s.containers.every((c2) => sum(c2.holds) === 0) && lockedLever(s) && s.filled !== true,
      `every cell stands, the fill not fed: BUILDING (${s.state}, phase ${s.phase ?? 'none'}), the hoppers empty, the lever locked (${(s.locks ?? []).map((l) => l.state).join(',')}), not filled`, s);
    const f = await filled(site);
    s = f.s;
    out.afterFill = s;
    check(s.state === 'BUILT' && s.phase === 'UNLOCKED' && exactly(s) && leverUnlocked(s) && s.filled === true && !s.wait?.blocked && G.same(only(s.paid, FK), FILL),
      `the fill fed: filled once and unlocked, then BUILT (${s.state}, ${s.phase}); each hopper exactly its declaration (${s.containers.map((c2) => json(c2.holds)).join(' ')}); the lever ${s.locks.map((l) => l.state).join(',')}; the marker ${s.filled}; paid under ${s.key}: ${json(only(s.paid, FK))}`, s);
    const r0 = await G.feed({ L }, ra.region, { fraction: 1, until: (st, rs) => st.view.state === 'PLACED' && rs.build?.done, timeoutMs: 900_000, every: 2500 });
    const ps1 = await pile();
    const consumed = G.minus(ps1.ledger?.consumed ?? {}, ps0.ledger?.consumed ?? {});
    out.consumed = consumed;
    const s1 = await fk(site);
    check(r0.last.st.view.state === 'PLACED' && s1.state === 'BUILT' && s1.phase === 'UNLOCKED' && G.same(consumed, q.bom), `the region PLACED after the unlock (the site ${s1.state}, ${s1.phase}); consumed equals quoteApproved item for item, the fill included (consumed ${sum(consumed)}, quote ${sum(q.bom)}; differ ${json(G.minus(consumed, q.bom))})`, { consumed, quote: q.bom });
    // a cargo put-in: one clay ball over a hopper's declaration refuses the removal, nothing written
    const hB = s1.containers[1].at;
    await hand(hB, { add: { [CLAY]: 1 } });
    const psB = await pile();
    const refused = await call('dev.region.remove', { region: ra.region, requester: G.OWNER }, 600_000);
    await L.settle(2000);
    const stB = await call('dev.region.state', { region: ra.region }, 60_000);
    const psB2 = await pile();
    const sB = await fk(site);
    out.cargo = { refused, state: stB.view?.state, holds: sB.containers.map((x) => x.holds) };
    check(stB.view?.state === 'PLACED' && refused.removed !== true && json(refused).includes('cargo') && G.same(psB.ledger?.returned, psB2.ledger?.returned) && G.same(sB.containers[1].holds, G.plus(FILL_OF(1), { [CLAY]: 1 })) && sum(sB.custody) === 0,
      `one clay ball over the declaration at ${hB}: the removal refused as cargo, nothing written (the region ${stB.view?.state}; refunded nothing; no custody): ${json(refused).slice(0, 240)}`, out.cargo);
    await hand(hB, { take: { [CLAY]: 1 } });
    // Regions.remove of the whole region: the hoppers' contents captured into custody, refunded with the blocks once
    const near = s1.containers[0].at.split(',').map(Number);
    await cmd('/kill @e[type=item]');
    const psR0 = await pile();
    const rm = await G.remove(ctx, ra.region);
    const stR = await call('dev.region.state', { region: ra.region }, 60_000);
    const psR1 = await pile();
    const back = G.minus(G.plus(psR1.ledger?.returned, psR1.ledger?.refundOverflow), G.plus(psR0.ledger?.returned, psR0.ledger?.refundOverflow));
    const items = (await call('dev.items.near', { pos: near, radius: 24 }, 60_000)).items ?? {};
    out.removed = { rm, state: stR.view?.state, back, items: only(items, FK), custody: psR1.ledger?.custody ?? null };
    check(['REMOVED', undefined].includes(stR.view?.state) && G.same(back, consumed) && G.same(only(back, FK), FILL) && sum(only(items, FK)) === 0 && !psR1.ledger?.custody,
      `Regions.remove (${stR.view?.state ?? 'gone'}): what came back = consumed, item for item (${sum(back)} = ${sum(consumed)}; differ ${json(G.minus(back, consumed))}), the hoppers' fill among it (${json(only(back, FK))}); none dropped (${json(only(items, FK))}); no custody left`, out.removed);
    // items in = items out: everything delivered since the start is in the stockpile again (stock, or the refund's overflow)
    const dIn = G.minus(psR1.ledger?.delivered, ps0.ledger?.delivered);
    const dOut = G.plus(G.minus(psR1.stock, ps0.stock), G.minus(psR1.ledger?.refundOverflow, ps0.ledger?.refundOverflow));
    out.conservation = { in: sum(dIn), out: sum(dOut), diff: G.minus(dIn, dOut) };
    check(G.same(dIn, dOut), `items in = items out: delivered since the start ${sum(dIn)} = in the stockpile now ${sum(dOut)} (differ ${json(out.conservation.diff)})`, out.conservation);
    await L.leaveWorld();

    // the creative instant variant: the same artifact flow in a creative world: the lot's site filled and unlocked at once; Remove exact
    const CW = 'G6B FK Approved Creative';
    await L.fresh(CW, G.FLAT);
    await entry();
    await L.tp(CX + 80, 80, CZ + 56);
    const g = await groundY();
    const BOX = BOXOF(CLAIM, g);
    const h0 = await hashOf(BOX);
    const cc = await approvedCheck('fk-approved creative');
    const rc = cc?.artifactSha ? await call('dev.region.realiseApproved', { sha: cc.artifactSha, lotEntries: lots, opKey: 'gate.fkr.c' }, 300_000) : {};
    const stc = rc.region ? await L.waitRegion(rc.region, 3_600_000) : null;
    const cSite = stc?.view?.lots?.find((l) => l.id === 'cottage_1')?.siteId ?? null;
    const cs = cSite ? await fk(cSite) : {};
    out.creative = { region: rc.region ?? rc, state: stc?.view?.state, site: cSite, fk: cs };
    check(stc?.view?.state === 'PLACED' && ['INSTANT', 'BUILT'].includes(cs.state) && cs.phase === 'UNLOCKED' && exactly(cs) && leverUnlocked(cs) && (cs.containers ?? []).length === 4,
      `creative: realiseApproved PLACED (${stc?.view?.state}); cottage_1's site ${cSite} filled at once (${(cs.containers ?? []).map((x) => json(x.holds)).join(' ')}), unlocked (${(cs.locks ?? []).map((l) => l.state).join(',')}), ${cs.state}`, out.creative);
    if (rc.region) {
      const rmc = await G.remove(ctx, rc.region);
      const h1 = await hashOf(BOX);
      const ci = (await call('dev.items.near', { pos: (cs.containers?.[0]?.at ?? `${CX},${g},${CZ}`).split(',').map(Number), radius: 24 }, 60_000)).items ?? {};
      out.creative.removed = { rmc, h0, h1, items: only(ci, FK) };
      check(rmc.removed !== false && h1 === h0 && sum(only(ci, FK)) === 0, `creative: Regions.remove is exact: the claim box's hash as before; none of the fill's items dropped (${json(only(ci, FK))})`, out.creative.removed);
    }
    await L.leaveWorld();
    spendZero();
    return out;
  };

  // ------------------------------------------------------------------ fk-crash

  async function restart(name) {
    await L.openWorld(name);
    await L.tp(CX + 80, 60, CZ + 56);
    await L.settle(4000);
  }

  async function halt(tag) {
    const down = await haltWait();
    check(down, `${tag}: the kill point halted the server`);
    return down;
  }

  /** FK1..FK4: the town's blocks built, the baseline saved, the fill fed with the kill point armed; the restart finishes it once. */
  async function fillCase(point) {
    const tag = point;
    const W = await town(`G6B FK ${tag}`);
    const site = await fkSite();
    if (!site) { check(false, `${tag}: no fk_hall site`); await L.leaveWorld(); return null; }
    await blocksBuilt(tag, site);
    // the site paused, the fill's items delivered (a paused target still takes them), the baseline saved with them in the stock, the kill
    // point armed, then the site resumed: its next tick runs the fill step and halts (the resume's reply may never come)
    const pr = await call('dev.stockpile.pause', { owner: G.OWNER, site, paused: true }, 60_000);
    check(!pr.refused, `${tag}: ${site} paused: ${json(pr.refused ?? 'paused')}`);
    const acc = await deliver({ fill: true });
    check(G.same(acc, FILL), `${tag}: the fill's items delivered to the stockpile while it is paused (${json(acc)})`);
    await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
    await cmd('/save-all flush').catch(() => null);
    const B = savedLedger(W.name);
    await call('dev.journal.killAt', { point }, 10_000);
    call('dev.stockpile.pause', { owner: G.OWNER, site, paused: false }, 60_000).catch(() => null);
    if (!(await halt(tag))) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await L.leaveWorld(); return null; }
    const S = savedLedger(W.name);
    const sitesFile = JSON.parse(fs.readFileSync(path.join(W.dir, 'architect-sites.json'), 'utf8'));
    const rec = JSON.stringify(sitesFile).match(/"architect_mc:fillState":\{"phase":"(\w+)"/)?.[1] ?? null;
    const markerSaved = (S?.filled ?? []).some((k) => k.startsWith(`site:${site}@`));
    log(`  ${tag}: saved: phase ${rec}, marker ${markerSaved}, consumed of the fill ${json(only(G.minus(S.consumed, B.consumed), FK))}`);
    await restart(W.name);
    const f = await filled(site, { ms: 300_000 });
    const s = f.s;
    const L2 = (await pile()).ledger;
    const charged = only(G.minus(L2.consumed, S.consumed), FK);
    const paidGain = only(G.minus(L2.paid?.[s.key] ?? {}, S.paid?.[s.key] ?? {}), FK);
    const stockS = only(G.minus(G.plus(S.delivered, S.returned), G.plus(S.consumed, G.plus(S.withdrawn, S.dropped))), FK);
    const stockF = only((await pile()).stock, FK);
    const res = { saved: { phase: rec, marker: markerSaved, filledBefore: sum(only(G.minus(S.consumed, B.consumed), FK)) }, refed: f.fed, charged, paidGain, stockS, stockF, holds: s.containers?.map((c) => c.holds), phase: s.phase, state: s.state };
    out_log(tag, res);
    // exactly once against the saved state: with the commit on disk nothing more is charged; without it, the fill is charged once now
    const wantCharged = markerSaved ? {} : FILL;
    check(s.state === 'BUILT' && s.phase === 'UNLOCKED' && exactly(s) && leverUnlocked(s), `${tag}: after the restart the fill ends once: BUILT, UNLOCKED, each hopper exactly its declaration (${(s.containers ?? []).map((c) => json(c.holds)).join(' ')}), the lever unlocked`, s);
    check(G.same(charged, wantCharged) && G.same(paidGain, wantCharged), `${tag}: charged since the saved state: ${json(charged)} (the commit ${markerSaved ? 'on disk: nothing more' : 'not on disk: the fill once'}); the key's record gained the same (${json(paidGain)})`, res);
    // items in = items out (the fill's items): saved stock + fed again after the restart = stock now + charged now
    check(G.same(G.plus(stockS, f.fed), G.plus(stockF, charged)), `${tag}: items in = items out for the fill's items: saved stock ${json(stockS)} + fed after the restart ${json(f.fed)} = stock now ${json(stockF)} + charged now ${json(charged)} (no mint, no loss)`, res);
    await L.leaveWorld();
    return res;
  }

  /** FKC1, FKC2: the town built and filled, the baseline saved, the region removed with the kill point armed; the restart refunds once. */
  async function removalCase(point) {
    const tag = point;
    const W = await town(`G6B FK ${tag}`);
    const site = await fkSite();
    if (!site) { check(false, `${tag}: no fk_hall site`); await L.leaveWorld(); return null; }
    await blocksBuilt(tag, site);
    await filled(site);
    const r0 = await G.feed({ L }, W.region, { fraction: 1, until: (st, rs) => st.view.state === 'PLACED' && rs.build?.done, timeoutMs: 900_000, every: 2500 });
    check(r0.last.st.view.state === 'PLACED', `${tag}: the town built and filled (PLACED)`);
    const at = (await fk(site)).containers[0].at.split(',').map(Number);
    await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
    await cmd('/kill @e[type=item]');
    await cmd('/save-all flush').catch(() => null);
    const B = savedLedger(W.name);
    const consumed = G.minus(B.consumed, W.ps0.ledger?.consumed ?? {});
    await call('dev.journal.killAt', { point }, 10_000);
    call('dev.region.remove', { region: W.region, requester: G.OWNER }, 600_000).catch(() => null);
    if (!(await halt(tag))) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await L.leaveWorld(); return null; }
    const S = savedLedger(W.name);
    const savedCustody = Object.values(S.custody ?? {}).reduce((a, m) => G.plus(a, m), {});
    log(`  ${tag}: saved: custody ${json(savedCustody)}, returned since the baseline ${sum(G.minus(S.returned, B.returned))}`);
    await restart(W.name);
    // the removal resumes from the queue file (or, when it had not been saved, the custody went back at load and it is asked again)
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
    const res = { savedCustody, state: st?.view?.state ?? 'gone', back: sum(back), consumed: sum(consumed), diff: G.minus(back, consumed), items: only(items, FK), custody: F.custody ?? null };
    out_log(tag, res);
    check(sum(savedCustody) > 0 || point !== 'FKC1', `${tag}: the custody (${json(savedCustody)}) was on disk at the halt`, res);
    check(['REMOVED', 'gone'].includes(res.state) && G.same(back, consumed) && !F.custody && sum(only(items, FK)) === 0,
      `${tag}: after the restart the removal ends once (${res.state}): what came back = what the town consumed, item for item (${sum(back)} = ${sum(consumed)}; differ ${json(res.diff)}): no mint, no loss; no custody left; none of the fill's items dropped`, res);
    await L.leaveWorld();
    return res;
  }

  /**
   * (J2 item 2, kill point CS1) The fk_hall site removed on its own (dev.pl.remove: Sites.removeDetailed, a single site's deconstruct):
   * the town built and filled, the baseline saved, the removal halted inside its credit's save (the players and the restored chunks on
   * disk, the ledger not). Before J2 the restart settled the site removed and nothing credited it: its blocks' refund and its custody lost.
   * As built the saved ledger holds the credit pending (with the custody, saved before the commit) and the start books it once: what came
   * back = the site's paid record, item for item; no custody, nothing pending; none of the fill's items dropped.
   */
  async function singleCase(point, { full = false } = {}) {
    const tag = full ? `${point}o` : point;
    const W = await town(`G6B FK ${tag}`);
    const site = await fkSite();
    if (!site) { check(false, `${tag}: no fk_hall site`); await L.leaveWorld(); return null; }
    await blocksBuilt(tag, site);
    await filled(site);
    const r0 = await G.feed({ L }, W.region, { fraction: 1, until: (st, rs) => st.view.state === 'PLACED' && rs.build?.done, timeoutMs: 900_000, every: 2500 });
    check(r0.last.st.view.state === 'PLACED', `${tag}: the town built and filled (PLACED)`);
    const at = (await fk(site)).containers[0].at.split(',').map(Number);
    await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
    await cmd('/kill @e[type=item]');
    await cmd('/save-all flush').catch(() => null);
    const B = savedLedger(W.name);
    const key = Object.keys(B.paid ?? {}).find((k) => k.startsWith(`site:${site}@`));
    const paid = B.paid?.[key] ?? {};
    check(!!key && sum(paid) > 0, `${tag}: ${site}'s paid record on disk: ${key} (${sum(paid)} units)`);
    // (slice OVF) CS1o: the stockpile full (capacity 0 stacks, TEST; for the halted run), so the whole refund is past
    // capacity. Before OVF it dropped as items before the credit's save: the halt left them in the saved chunks and the start dropped them again
    if (full) await call('dev.stockpile.ps', { capacity: 0 }, 30_000);
    await call('dev.journal.killAt', { point }, 10_000);
    call('dev.pl.remove', { site, requester: G.OWNER, force: false }, 600_000).catch(() => null);
    if (!(await halt(tag))) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); if (full) await call('dev.stockpile.ps', { capacity: -1 }, 30_000).catch(() => null); await L.leaveWorld(); return null; }
    const S = savedLedger(W.name);
    const pend = S.pendingCredit?.[key] ?? null;
    log(`  ${tag}: saved: pending ${json(pend)}, custody ${json(S.custody?.[key] ?? null)}, credited ${(S.credited ?? []).includes?.(key)}`);
    check(!!pend && sum(S.custody?.[key]) > 0, `${tag}: at the halt the saved ledger holds ${key}'s credit pending (${sum(pend?.items)} units) and its custody (${sum(S.custody?.[key])})`, { pend, custody: S.custody?.[key] });
    await restart(W.name);
    await L.settle(4000);
    const F = (await pile()).ledger;
    const back = G.minus(G.plus(F.returned, F.refundOverflow), G.plus(B.returned, B.refundOverflow));
    const items = (await call('dev.items.near', { pos: at, radius: 24 }, 60_000)).items ?? {};
    const gone = await fk(site).then((x) => x?.state ?? 'gone', () => 'gone');
    const res = { key, paid: sum(paid), back: sum(back), diff: G.minus(back, paid), pending: F.pendingCredit ?? null, custody: F.custody ?? null, items: only(items, FK), site: gone };
    if (full) {
      // every item entity at the crates (the overflow's drop point) and at the site: none (the refund is all in the stock, once). The
      // restart is a new server process, so the TEST capacity is back at the crates' (the start's settle credited within it); set to 0
      // again, the pile reads over capacity and says so
      await call('dev.stockpile.ps', { capacity: 0 }, 30_000);
      const P = await pile();
      const atCrates = (await call('dev.items.near', { pos: W.crates[0], radius: 16 }, 60_000)).items ?? {};
      const ents = G.plus(atCrates, items);
      const returned = G.minus(F.returned, B.returned);
      Object.assign(res, { atCrates, returned: sum(returned), overflow: sum(G.minus(F.refundOverflow, B.refundOverflow)), used: P.usedStacks, capacity: P.capacityStacks });
      await call('dev.stockpile.ps', { capacity: -1 }, 30_000);
      out_log(tag, res);
      check(G.same(returned, paid) && sum(ents) === 0 && !F.pendingCredit?.[key] && !F.custody?.[key] && P.usedStacks > P.capacityStacks && P.overCapacity === true && /over capacity/.test(P.capacityLabel ?? ''),
        `${tag}: a refund into a full stockpile halted at CS1 is paid once: returned into the stock = ${site}'s paid record, item for item (${sum(returned)} = ${sum(paid)}); no item entity at the crates or the site (${json(ents)}; before OVF: the overflow dropped before the halt and again at the start); the stock over capacity and shown so (${P.capacityLabel}; overCapacity ${P.overCapacity})`, res);
      await L.leaveWorld();
      return res;
    }
    out_log(tag, res);
    check(G.same(back, paid) && !F.custody?.[key] && !F.pendingCredit?.[key] && sum(only(items, FK)) === 0,
      `${tag}: after the restart the removal's credit booked once: what came back = ${site}'s paid record, item for item (${sum(back)} = ${sum(paid)}; differ ${json(res.diff)}): no loss, no mint; no custody, nothing pending; none of the fill's items dropped`, res);
    await L.leaveWorld();
    return res;
  }

  const LOGS = {};
  function out_log(tag, res) {
    LOGS[tag] = res;
    log(`  ${tag}: ${json(res).slice(0, 600)}`);
  }

  steps.fkcrash = async () => {
    await ensure();
    const out = {};
    for (const p of ['FK1', 'FK2', 'FK3', 'FK4']) out[p] = await fillCase(p);
    for (const p of ['FKC1', 'FKC2']) out[p] = await removalCase(p);
    if (process.env.GATE_FK_ONLY !== 'fill') out.CS1 = await singleCase('CS1'); // (J2) a single site's credit save halted
    if (process.env.GATE_FK_ONLY !== 'fill') out.CS1o = await singleCase('CS1', { full: true }); // (OVF) the same into a full stockpile
    spendZero();
    return out;
  };
}
