// Slice FL gate (docs/CONTRACT.md "### Slice FL as built"; Steward's S-M5-17): a fill site's containers take no item before the fill,
// registered into tools/gate6dgr.mjs (GR's survival town and feed helpers). Headless server, the sim sidecar: $0. Strict (the fill contract).
//
//   node tools/gate6dgr.mjs flsurvival  (fl-survival)  a survival flat_village town with cottage_1 bound to fl_hall (gate-local, shaped like
//                                                      Steward's storage_hall@2 line: an undeclared input chest on line hopper 0, a line of 4
//                                                      undeclared hoppers facing east into an undeclared overflow chest, a declared filter
//                                                      hopper F under each line hopper, the lever lock beside line hopper 0). The blocks fed,
//                                                      not the fill: every cell stands (the lever powered; line hopper 0's state recorded).
//                                                      Then 64 cobblestone into the input chest and 5 into line hopper 2 (no lock beside it):
//                                                      after 40 s no F holds anything, no fill_blocked, the 69 cobblestone in the hall's other
//                                                      containers. The fill fed: filled once (paid = the declaration), unlocked, BUILT; each F
//                                                      exactly its declaration; the 69 cobblestone still there (none lost, none minted); the
//                                                      town PLACED and consumed = the quote, item for item. (S-M5-18) The land check: the lot's
//                                                      changed = the undeclared containers holding cobblestone (the filled Fs are the site's).
//
// Evidence: artifacts/gate6d-gr/<step>.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';

const FILL = { 'minecraft:flint': 18, 'minecraft:clay_ball': 18, 'minecraft:bone': 18, 'minecraft:feather': 18, 'minecraft:paper': 16 };
const FILTERS = ['minecraft:flint', 'minecraft:clay_ball', 'minecraft:bone', 'minecraft:feather'];
const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];
const ENTRY = 'fl_hall';
const COBBLE = 'minecraft:cobblestone';

export async function registerFL(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, CX, CZ, CLAIM } = h;
  const ctx = { L, OUT: h.OUT, imp: h.imp };
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const fk = (site) => call('dev.fk.state', { site }, 30_000);
  const box = (pos) => call('dev.fk.container', { pos }, 30_000);
  const only = (m, keys) => Object.fromEntries(Object.entries(m ?? {}).filter(([k]) => keys.includes(k)));
  const FK = Object.keys(FILL);
  const exactly = (s) => (s.containers ?? []).every((c) => G.same(c.holds, c.declared));
  const P = (at) => at.split(',').map(Number);

  /**
   * fl_hall (template, front south): x 0..5, y 0..4, z 0..3. Floor at y0. Core at z 1: stone (0,1) (0,2), the lever (0,3) on the stone
   * (floor, unpowered in the template: the lock); per slot x 1..4 stone (x,1), the declared filter hopper F (x,2) facing down onto it, the
   * line hopper (x,3) facing east; the overflow chest (5,3) on stone (5,1) (5,2); the input chest (1,4) on line hopper 0. Powered, the
   * lever disables line hopper 0 (beside it) and F0 (through its stone); line hoppers 1-3 and F1-F3 are beside no lock.
   */
  async function entry() {
    await G.designs(ctx);
    const { Blueprint, PALETTES } = await h.imp('lib/kit.mjs');
    const { writeBlueprint } = await h.imp('lib/write.mjs');
    const { checkBlueprint } = await h.imp('lib/check.mjs');
    const p = PALETTES.rustic;
    const bp = new Blueprint({ id: ENTRY, name: 'Filter Line', description: 'A hopper line over 4 filter hoppers, locked by a lever until filled.',
      type: 'storage_hall', profile: ['no_floating'], tags: ['module', 'storage'], size: [6, 5, 4], groundY: 1, front: 'south', palette: p, approach: false });
    bp.part('shell', () => { for (let x = 0; x < 6; x++) for (let z = 0; z < 4; z++) bp.set(x, 0, z, p.floor ?? p.path); });
    const containers = [];
    bp.part('core', () => {
      bp.set(0, 1, 1, 'minecraft:stone');
      bp.set(0, 2, 1, 'minecraft:stone');
      bp.set(0, 3, 1, 'minecraft:lever', { face: 'floor', facing: 'east', powered: 'false' });
      for (let i = 0; i < 4; i++) {
        const x = i + 1;
        bp.set(x, 1, 1, 'minecraft:stone');
        bp.set(x, 2, 1, 'minecraft:hopper', { facing: 'down', enabled: 'true' });
        bp.set(x, 3, 1, 'minecraft:hopper', { facing: 'east', enabled: 'true' });
        containers.push({ at: [x, 2, 1], items: [{ slot: 0, id: FILTERS[i], count: 18 }, ...[1, 2, 3, 4].map((slot) => ({ slot, id: 'minecraft:paper', count: 1 }))] });
      }
      bp.set(5, 1, 1, 'minecraft:stone');
      bp.set(5, 2, 1, 'minecraft:stone');
      bp.set(5, 3, 1, 'minecraft:chest', { facing: 'south' });
      bp.set(1, 4, 1, 'minecraft:chest', { facing: 'south' });
    });
    bp.fillContainers({ containers, locks: [{ at: [0, 3, 1], locked: { powered: 'true' } }] });
    bp.spot('entrance', 1, 3, 180);
    bp.spot('spawn', 1, 3, 180);
    const ck = checkBlueprint(bp, {});
    check(ck.ok, `fl_hall (a hopper line over 4 declared filter hoppers, an input and an overflow chest, the lever lock) checks clean: ${ck.errors.slice(0, 3).join('; ') || 'OK'}`);
    const dir = path.join(L.LIBRARY, ENTRY);
    fs.rmSync(dir, { recursive: true, force: true });
    const w = writeBlueprint(bp, dir);
    const j = JSON.parse(fs.readFileSync(w.jsonPath, 'utf8'));
    j.givenProgram = { sha: 'gate-fixture', opKey: 'gate.fl.hall' };
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

  /** The hall's cells by world position, from the declared hoppers (rotation-safe: the row's step vector). */
  function cells(s) {
    const F = s.containers.map((c) => P(c.at));
    const d = [0, 1, 2].map((k) => (F[3][k] - F[0][k]) / 3);
    const line = F.map((f) => [f[0], f[1] + 1, f[2]]);
    return { F, line, input: [F[0][0], F[0][1] + 2, F[0][2]], overflow: [F[3][0] + d[0], F[3][1] + 1, F[3][2] + d[2]] };
  }

  /** Cobblestone in the hall: per container (F, line, the chests) and as item entities near it. */
  async function cobble(c) {
    const at = { input: c.input, overflow: c.overflow };
    c.line.forEach((p, i) => { at[`line${i}`] = p; });
    c.F.forEach((p, i) => { at[`F${i}`] = p; });
    const per = {};
    for (const [k, p] of Object.entries(at)) per[k] = (await box(p)).holds?.[COBBLE] ?? 0;
    const loose = (await call('dev.items.near', { pos: c.input, radius: 24 }, 60_000)).items?.[COBBLE] ?? 0;
    const inF = c.F.reduce((n, _, i) => n + per[`F${i}`], 0);
    return { per, loose, inF, total: sum(per) + loose };
  }

  // ------------------------------------------------------------------ fl-survival

  steps.flsurvival = async () => {
    await ensure();
    const out = {};
    const name = 'G6B FL Lock';
    await G.survivalBase(ctx);
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await entry();
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const q = await call('dev.region.quote', { planId: p0.planId, lotEntries: { cottage_1: ENTRY } }, 300_000);
    check(!q.refused && G.same(q.bomParts?.['fill:cottage_1'], FILL), `the town quoted with cottage_1: fl_hall: fill:cottage_1 is the declaration ${json(q.bomParts?.['fill:cottage_1'])}`, q.refused);
    const ps0 = await pile();
    const region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: ENTRY } });
    let site = null;
    for (let i = 0; i < 360 && !site; i++) {
      for (const id of Object.keys((await pile()).targets ?? {})) if ((await fk(id)).hasFill) { site = id; break; }
      if (!site) { await deliver({ fill: false }); await L.sleep(2500); }
    }
    check(!!site, `fl_hall's site joined the feed (${site})`);
    if (!site) { await L.leaveWorld(); return out; }
    // the blocks fed, never the fill: every cell stands (survival construction, the fill not yet run)
    let t = null;
    for (let i = 0; i < 400; i++) {
      await deliver({ fill: false });
      t = (await pile()).targets?.[site];
      if (t && t.queued > 0 && t.built === t.queued) break;
      await L.sleep(2500);
    }
    await L.sleep(9000);
    let s = await fk(site);
    const c = cells(s);
    const l0 = await box(c.line[0]);
    out.beforeFill = { state: s.state, phase: s.phase ?? null, lever: s.locks?.map((l) => l.state), line0: l0.state, F: s.containers.map((x) => x.holds), built: t };
    log(`  fl: before the fill: ${json(out.beforeFill)}`);
    check(t?.built === t?.queued && s.state === 'BUILDING' && !s.phase && s.containers.every((x) => sum(x.holds) === 0) && (s.locks ?? []).every((l) => /powered=true/.test(l.state ?? '')),
      `every fl_hall cell stands, the fill not fed: BUILDING (${s.state}, phase ${s.phase ?? 'none'}), every F empty, the lever built locked (${(s.locks ?? []).map((l) => l.state).join(',')}); line hopper 0 beside it: ${l0.state}`, out.beforeFill);
    // mid-build cargo: 64 cobblestone into the input chest, 5 directly into line hopper 2 (no lock beside it)
    await call('dev.fk.container', { pos: c.input, add: { [COBBLE]: 64 } }, 30_000);
    await call('dev.fk.container', { pos: c.line[2], add: { [COBBLE]: 5 } }, 30_000);
    await L.sleep(40_000); // 8 ticks a hopper move: 69 items through a 4-hopper line in well under 40 s
    s = await fk(site);
    const k1 = await cobble(c);
    out.midBuild = { cobble: k1, wait: s.wait, F: s.containers.map((x) => x.holds), state: s.state, held: s.held };
    log(`  fl: 40 s after the cargo: ${json(out.midBuild)}`);
    check(s.containers.every((x) => sum(x.holds) === 0) && k1.inF === 0 && !s.wait?.blocked && (s.held ?? 0) > 0,
      `S-M5-17: 64 cobblestone into the input chest and 5 into line hopper 2, mid-build: no fill container took any (F holds ${s.containers.map((x) => json(x.holds)).join(' ')}); no fill_blocked (${s.wait?.blocked ?? 'none'}); insertions held ${s.held ?? 'n/a'}`, out.midBuild);
    check(k1.total === 69, `the 69 cobblestone are all in the hall's other containers or loose by it (${json(k1.per)}, loose ${k1.loose}): none lost, none minted`, k1);
    // the fill fed: filled once, unlocked, BUILT
    let fed = {};
    for (let i = 0; i < 150; i++) {
      s = await fk(site);
      if (s.state === 'BUILT' && s.phase === 'UNLOCKED') break;
      fed = G.plus(fed, await deliver({ fill: true }));
      await L.sleep(2000);
    }
    out.afterFill = { state: s.state, phase: s.phase, filled: s.filled, paid: only(s.paid, FK), holds: s.containers.map((x) => x.holds), lever: s.locks?.map((l) => l.state), wait: s.wait };
    check(s.state === 'BUILT' && s.phase === 'UNLOCKED' && s.filled === true && exactly(s) && (s.locks ?? []).every((l) => /powered=false/.test(l.state ?? '')) && G.same(only(s.paid, FK), FILL),
      `the fill fed: filled once and unlocked, then BUILT (${s.state}, ${s.phase}; the marker ${s.filled}); each F exactly its declaration (${s.containers.map((x) => json(x.holds)).join(' ')}); paid for the fill ${json(only(s.paid, FK))}; the lever ${(s.locks ?? []).map((l) => l.state).join(',')}`, out.afterFill);
    await L.sleep(20_000); // the unlocked line runs: a filled F has no room for cobblestone
    const k2 = await cobble(c);
    s = await fk(site);
    out.afterUnlock = { cobble: k2, holds: s.containers.map((x) => x.holds) };
    check(k2.total === 69 && k2.inF === 0 && exactly(s), `after the unlock the line ran: the 69 cobblestone still in the hall (${json(k2.per)}, loose ${k2.loose}), none in an F; each F still exactly its declaration`, out.afterUnlock);
    const r0 = await G.feed({ L }, region, { fraction: 1, until: (st, rs) => st.view.state === 'PLACED' && rs.build?.done, timeoutMs: 900_000, every: 2500 });
    const ps1 = await pile();
    const consumed = G.minus(ps1.ledger?.consumed ?? {}, ps0.ledger?.consumed ?? {});
    out.consumed = { consumed: sum(consumed), quote: sum(q.bom), diff: G.minus(consumed, q.bom), cobble: consumed[COBBLE] ?? 0, quoteCobble: q.bom?.[COBBLE] ?? 0 };
    check(r0.last.st.view.state === 'PLACED' && G.same(consumed, q.bom),
      `the town PLACED; consumed = the quote item for item, the fill once (${sum(consumed)} = ${sum(q.bom)}; differ ${json(G.minus(consumed, q.bom))}): the player's cobblestone never billed or credited`, out.consumed);
    // (S-M5-18) the land check: each filled F (exactly its fill) is the site's, not changed; the undeclared containers holding the
    // player's cobblestone (built empty) are what the lot reads changed
    const lc = await call('dev.region.landCheck', { region }, 900_000);
    const lot = (lc.lots ?? []).find((x) => x.lot === 'cottage_1');
    const k3 = await cobble(c);
    const cargoCells = Object.entries(k3.per).filter(([k, n]) => !k.startsWith('F') && n > 0).length;
    out.landCheck = { lot, cargoCells, per: k3.per };
    check(lot && lot.changed === cargoCells && k3.inF === 0,
      `S-M5-18: the land check reads fl_hall's 4 filled F hoppers (each exactly its fill) as the site's: the lot's changed ${lot?.changed} = the ${cargoCells} undeclared container(s) holding the player's cobblestone (${json(k3.per)})`, out.landCheck);
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
