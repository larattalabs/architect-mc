// (GM-c) The drawbridge's steps of tools/gate7agm.mjs (docs/CONTRACT.md "Slice GM" §2's drawbridge row, §5, §7 item 9, §8, §9, §10 item 5,
// §13 item 6): cprobe (the walk probe: the probe's deck over a moat 5 wide and 3 deep, lowered and raised, judged by vanilla's villager
// navigation and the kit's player and villager walks); cunit (gm-c-unit: kit/test/gm-c.test.mjs with GM-a's, GM-b's and T3a's tests, the
// Java GateMechTest and MechWaitSayTest); cingame (gm-c-ingame: v7a_gm_drawbridge realised in creative, 10 lever toggles by real use from
// both banks, the walks lowered and raised, Regions.remove raised and lowered: E-flat 0 with the moat's water); csurvival (gm-c-survival:
// the circuit held for the deck built and its whole bill, charged once = the plan's bill, the INSTANT twin, the removal raised).
// $0: no Claude call.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { testConcurrencyArgs } from './cpu-budget.mjs';

/** Registers the GM-c steps on `steps`. `h`: the driver's helpers (as registerGmB), plus snap, sb, fill, world, use. */
export async function registerGmC(steps, h) {
  const { L, call, check, cmd, log, root, OUT, json, stateAt, snap, sb, fill, world, use, freeze, unfreeze, step, items } = h;
  const KIT = path.join(root, 'kit');
  const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
  const ensure = async () => { if (!L.state.dev) await L.connect(); };
  const wait = (ms, label) => L.gameWait(ms, { real: L.settle, label });

  /** Vanilla villager navigation and the kit's walks between two feet cells over a dump of `box`. */
  async function walks(box, from, to, claimBox, tag) {
    const v = await call('dev.nav.villager', { from, to, range: 32, cells: true }, 120_000);
    const v2 = await call('dev.nav.villager', { from: to, to: from, range: 32 }, 120_000);
    const { decodeArwd, dumpWorld } = await imp('lib/region/vworld.mjs');
    const { walkGraph, nodeReached } = await imp('lib/region/check.mjs');
    const f = path.join(OUT, `gmc-${tag}.arwd.gz`);
    await call('dev.region.dump', { box, file: f }, 600_000);
    const d = await decodeArwd(fs.readFileSync(f));
    const world = dumpWorld(d, d, claimBox);
    const out = { villager: [!!v.canReach, !!v2.canReach], path: (v.cells ?? []).map((c) => c.join(',')) };
    for (const mover of ['player', 'villager']) out[`kit_${mover}`] = nodeReached(walkGraph(world, [from], { mover }), to);
    return out;
  }

  /**
   * The walk probe (GM-c, before any GM-c build work, as GM-a's gm-probe): the probe's drawbridge (gmCircuit.drawbridgeCells, 5 cells
   * over a moat 5 wide and 3 deep, the bank buses and two levers) with the side lanes capped by fences one over the deck row, lowered
   * and raised: vanilla's villager navigation (range 32: the moat runs 80 either way, so no way round) and the kit's player and
   * villager walks from 3 before the near bank to 3 past the far one.
   */
  steps.cprobe = async () => {
    await ensure();
    const GMC = await imp('lib/connectors/gmCircuit.mjs');
    const out = {};
    const X = 7500, Z = 7000;
    const g = await world(X, Z), y = g;
    await call('dev.tp', { x: X + 2, y: g + 8, z: Z + 12 }, 30_000).catch(() => L.tp(X + 2, g + 8, Z + 12));
    const ZA = Z - 80, ZB = Z + 81;
    await fill([X, g - 4, ZA], [X + 4, g - 4, ZB], 'minecraft:stone');
    await fill([X, g - 3, ZA], [X + 4, g - 1, ZB], 'minecraft:water');
    await fill([X, g, ZA], [X + 4, g + 3, ZB], 'minecraft:air');
    for (const [i, dy, z, st] of GMC.drawbridgeCells(5, {})) await sb(X + i, y + dy, Z + z, st);
    for (const bx of [X - 2, X + 6]) {
      for (let z = -3; z <= 4; z++) await sb(bx, y + 1, Z + z, 'minecraft:redstone_wire');
      for (const z of [-3, 4]) await sb(bx === X - 2 ? X - 1 : X + 5, y + 1, Z + z, 'minecraft:redstone_wire');
    }
    // the caps: a fence over every side-lane cell (no walk along the repeaters)
    for (let i = 0; i < 5; i++) for (const z of [-3, -2, -1, 2, 3, 4]) await sb(X + i, y + 1, Z + z, 'minecraft:oak_fence');
    await sb(X - 3, y + 1, Z + 6, 'minecraft:lever[face=floor,facing=east,powered=false]');
    await sb(X - 3, y + 1, Z + 5, 'minecraft:redstone_wire');
    await sb(X - 2, y + 1, Z + 5, 'minecraft:redstone_wire');
    await wait(2000, 'gmc settles');
    const box = [X - 8, g - 5, Z - 10, X + 12, g + 4, Z + 11];
    const claimBox = { minX: box[0], minZ: box[2], maxX: box[3], maxZ: box[5], minY: box[1], maxY: box[4] };
    const from = [X - 4, y + 1, Z], to = [X + 8, y + 1, Z];
    const deck = async () => { const b = await snap(X, y, Z, X + 4, y, Z + 1); return Object.values(b).filter((v) => v.startsWith('iron_trapdoor')).map((v) => (/open=true/.test(v) ? 1 : 0)); };
    out.lowered = await walks(box, from, to, claimBox, 'lowered');
    out.deckLowered = await deck();
    log(`  cprobe lowered: ${json(out.lowered)} deck ${json(out.deckLowered)}`);
    await use([X - 3, y + 1, Z + 6]);
    await wait(1500, 'gmc raised');
    out.deckRaised = await deck();
    out.raised = await walks(box, from, to, claimBox, 'raised');
    log(`  cprobe raised: ${json(out.raised)} deck ${json(out.deckRaised)}`);
    check(out.deckLowered.length === 10 && out.deckLowered.every((v) => v === 0) && out.deckRaised.every((v) => v === 1), `cprobe: the lever (real use) raises all 10 trapdoors (${json(out.deckRaised)})`);
    check(out.lowered.villager[0] && out.lowered.villager[1] && out.lowered.kit_villager && out.lowered.kit_player, `cprobe: lowered, vanilla's villager both ways and the kit's walks cross (${json(out.lowered)})`);
    check(!out.raised.villager[0] && !out.raised.villager[1] && !out.raised.kit_villager, `cprobe: raised, vanilla's villager and the kit's villager walk do not cross (${json(out.raised)})`);
    out.kitPlayerRaised = out.raised.kit_player;
    await L.leaveWorld();
    return out;
  };

  // ------------------------------------------------------------------ gm-c-unit (offline)

  const spendZero = () => fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice GM-c is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
  steps.cunit = async () => {
    const out = {};
    const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), 'kit/test/gm-c.test.mjs', 'kit/test/gm-b.test.mjs', 'kit/test/gm-a.test.mjs', 'kit/test/plan-t3a.test.mjs', 'kit/test/t3-foundation.test.mjs'], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
    const t = `${r.stdout}${r.stderr}`;
    const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
    out.kit = { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
    check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 10, `gm-c (kit): the catalogue flip, both spellings, the deck and circuit writes, the bill, the siteplan, the walks lowered and raised, the deck's checks, the circuit's reach, determinism; GM-a's, GM-b's and T3a's tests: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
    const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.join(root, '.gradle-home') };
    const j = spawnSync(path.join(root, 'mod', 'gradlew'), ['--offline', '--no-daemon', 'test', '--tests', 'dev.larattalabs.architect.region.GateMechTest', '--tests', 'dev.larattalabs.architect.site.MechWaitSayTest'], { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 });
    out.java = `${j.stdout}${j.stderr}`.trim().split('\n').slice(-6);
    check(j.status === 0, 'gm-c (Java): GateMechTest (the drawbridge circuit read from the IR, its bill and report) and MechWaitSayTest (the drawbridge named in its waits)', out.java);
    spendZero();
    return out;
  };

  // ------------------------------------------------------------------ gm-c-ingame and gm-c-survival

  const core = await import('./gate6chy-core.mjs');
  const B = await import('./gate6chy-b.mjs');
  const G = await import('./gate6crs-game.mjs');
  const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };
  const runsOf = (flat) => { const out = []; for (let i = 0; i + 3 < (flat ?? []).length; i += 4) for (let y = flat[i + 2]; y <= flat[i + 3]; y++) out.push([flat[i], y, flat[i + 1]]); return out; };
  const killMobs = () => cmd('/kill @e[type=!minecraft:player]');
  const waitPlaced = (region) => L.waitRegion(region, 3_600_000, async (x) => { if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(x?.waiting?.reason)) await killMobs(); });
  const FXN = 'valid/v7a_gm_drawbridge';

  /** The fixture checked (and realised): {fx, s, ck, sha, a (the drawbridge's answer), b (its span), m (its mechanism), box, region?, pre?}. */
  async function moat(tag, { creative = true, realise = true, name = FXN } = {}) {
    const fx = G.fixture(ctx, name);
    const s = await G.site(ctx, `gmc ${tag}`, fx, { creative });
    await G.designs(ctx);
    await cmd('/time set 6000');
    await cmd('/weather clear');
    const ck = await call('dev.region.checkPlan', { plan: s.wp.plan, claim: s.W.claim, owner: G.OWNER, anchors: s.wp.anchors, load: 'generate' }, 1_800_000);
    fs.writeFileSync(path.join(OUT, `gmc-${tag}-check.json`), `${JSON.stringify(ck, null, 1)}\n`);
    const sha = ck.check?.artifactSha;
    const a = (ck.check?.parts ?? []).find((q) => q.part === 'drawbridge') ?? null;
    const b = a?.geometry?.bridges?.[0] ?? null;
    const out = { fx, s, ck, sha, a, b, m: b?.mechanism ?? null, box: G.boxOf(s.W) };
    if (!realise || !sha) return out;
    out.pre = await G.snap(ctx, out.box, `gmc-${tag}-pre`);
    await killMobs();
    out.region = await G.realise(ctx, sha, fx.lotEntries);
    out.st = await waitPlaced(out.region);
    await L.settle(3000);
    return out;
  }
  /** The deck's trapdoors (the lowered state's runs) and the walk's two landings (feet cells) and the levers. */
  function deckOf(c) {
    const deck = runsOf(c.m.states.lowered);
    const lever = (side) => c.m.triggers.find((t) => t.side === side).at;
    return { deck, near: lever('near'), far: lever('far'), from: [c.b.from[0], c.b.from[1] + 1, c.b.from[2]], to: [c.b.to[0], c.b.to[1] + 1, c.b.to[2]] };
  }
  const opened = async (d) => { let n = 0; for (const q of d.deck) if (/open=true/.test(await stateAt(...q))) n++; return n; };
  /** Vanilla villager navigation both ways, and the kit's walks over a dump of the bridge's box. */
  async function crossings(c, d, tag) {
    const v1 = !!(await call('dev.nav.villager', { from: d.from, to: d.to, range: 48 }, 120_000)).canReach;
    const v2 = !!(await call('dev.nav.villager', { from: d.to, to: d.from, range: 48 }, 120_000)).canReach;
    const xs = [d.from[0], d.to[0]], zs = [d.from[2], d.to[2]];
    const box = [Math.min(...xs) - 14, d.from[1] - 8, Math.min(...zs) - 14, Math.max(...xs) + 14, d.from[1] + 6, Math.max(...zs) + 14];
    const { decodeArwd, dumpWorld } = await imp('lib/region/vworld.mjs');
    const { walkGraph, nodeReached } = await imp('lib/region/check.mjs');
    const f = path.join(OUT, `gmc-${tag}.arwd.gz`);
    await call('dev.region.dump', { box, file: f }, 600_000);
    const dd = await decodeArwd(fs.readFileSync(f));
    const vw = dumpWorld(dd, dd, { minX: box[0], minY: box[1], minZ: box[2], maxX: box[3], maxY: box[4], maxZ: box[5] });
    const out = { vanilla: [v1, v2] };
    for (const mover of ['villager', 'player']) out[mover] = [nodeReached(walkGraph(vw, [d.from], { mover }), d.to), nodeReached(walkGraph(vw, [d.to], { mover }), d.from)];
    return out;
  }
  async function removeCheck(c, tag, at) {
    await cmd('/kill @e[type=minecraft:item]');
    const rm = await G.remove(ctx, c.region);
    const df = await G.diff(ctx, c.box, c.pre);
    const it = await items(...at, 24);
    const water = df.list.filter((q) => /water/.test(JSON.stringify(q))).length;
    const rec = { removed: rm.removed, mismatches: df.mismatches, water, list: df.list.slice(0, 12), classes: df.classes, items: it.stacks ?? 0 };
    check(rm.removed && df.mismatches === 0, `${tag}: Regions.remove: E-flat ${df.mismatches} over the claim (the moat's water and the deck included)`, df.list.slice(0, 8));
    check(!rec.items, `${tag}: the removal dropped no item (${rec.items})`);
    return rec;
  }

  steps.cingame = async () => {
    await ensure();
    await L.leaveWorld().catch(() => null);
    const out = {};
    // ---- raised: realise, toggles from both banks, walks both states, remove raised
    {
      const rec = (out.raised = {});
      const c = await moat('a');
      rec.check = { overall: c.ck.check?.overall, class: c.a?.class, block: c.a?.block, n: c.b?.n, trapdoors: c.b?.trapdoors, crossing: c.b?.crossing ?? null };
      check(c.ck.check?.overall === 'READY' && c.a?.class === 'fits' && c.a?.block === 'connector.drawbridge' && c.m?.kind === 'drawbridge' && c.b?.crossing?.deck === 'trapdoor', `v7a_gm_drawbridge checks READY in game, the drawbridge fits (block connector.drawbridge, the trapdoor deck: ${json(rec.check)})`);
      check(c.st?.view?.state === 'PLACED', `realiseApproved: ${c.st?.view?.state}`);
      if (c.region) {
        const d = deckOf(c);
        const st = await call('dev.region.state', { region: c.region }, 60_000);
        rec.report = (st.view?.ext ?? st.record?.ext ?? {})['architect_mc:gateMechanism']?.drawbridge ?? null;
        check(rec.report?.kind === 'drawbridge' && rec.report?.cells === runsOf(c.m.cells).length, `the region's report names the drawbridge's circuit (${json(rec.report)})`);
        rec.levers = [await stateAt(...d.near), await stateAt(...d.far)];
        rec.rest = await opened(d);
        check(rec.levers.every((x) => /lever/.test(x) && /powered=false/.test(x)) && rec.rest === 0 && d.deck.length === 2 * c.b.trapdoors, `at rest: both levers off, the deck lowered (${rec.rest} of ${d.deck.length} trapdoors open)`, rec.levers);
        // still: nothing round the deck changes in 40 ticks after the realise
        const xs = runsOf(c.m.cells), bb = [Math.min(...xs.map((q) => q[0])) - 1, Math.min(...xs.map((q) => q[1])) - 1, Math.min(...xs.map((q) => q[2])) - 1, Math.max(...xs.map((q) => q[0])) + 1, Math.max(...xs.map((q) => q[1])) + 1, Math.max(...xs.map((q) => q[2])) + 1];
        await freeze();
        const f0 = await G.snap(ctx, bb, 'gmc-still');
        await step(40);
        const dd = await G.diff(ctx, bb, f0);
        await unfreeze();
        rec.still = dd.mismatches;
        check(dd.mismatches === 0, `nothing round the deck changes in the 40 ticks after the realise (${dd.mismatches})`, dd.list.slice(0, 6));
        rec.lowered = await crossings(c, d, 'lowered');
        check(rec.lowered.villager[0] && rec.lowered.villager[1], `lowered: the kit's villager walk crosses the deck both ways (${json(rec.lowered)})`);
        check(rec.lowered.vanilla[0] && rec.lowered.vanilla[1], `lowered: vanilla's villager navigation crosses both ways (${json(rec.lowered.vanilla)})`);
        // 10 toggles by real use: 5 from the near bank's lever, 5 from the far one's (each on, then off)
        let bad = 0;
        const cyc = [];
        for (let i = 0; i < 10; i++) {
          const lv = i < 5 ? d.near : d.far;
          await use(lv); await wait(1500, 'raise');
          const up = await opened(d);
          await use(lv); await wait(1500, 'lower');
          const down = await opened(d);
          cyc.push([i < 5 ? 'near' : 'far', up, down]);
          if (up !== d.deck.length || down !== 0) bad++;
        }
        rec.toggles = { n: 10, bad, cycles: cyc };
        check(bad === 0, `10 toggles by real use (5 near lever, 5 far): every trapdoor raised, then lowered (${bad} wrong: ${json(cyc)})`);
        // raised (the near lever on): 0 walks cross
        await use(d.near); await wait(1500, 'raise');
        rec.raisedDeck = await opened(d);
        rec.raisedWalks = await crossings(c, d, 'raised');
        check(rec.raisedDeck === d.deck.length && !rec.raisedWalks.villager[0] && !rec.raisedWalks.villager[1], `raised: the kit's villager walk crosses 0 ways (${json(rec.raisedWalks)})`);
        // (recorded, not judged: vanilla's navigator takes a trapdoor, open or closed, as floor; the player swims H's moat)
        rec.notes = { vanillaRaised: rec.raisedWalks.vanilla, playerRaised: rec.raisedWalks.player };
        const it0 = await items(...d.near, 24);
        rec.items = it0.stacks ?? 0;
        check(!rec.items, `no item dropped while it ran (${rec.items})`);
        rec.eflat = await removeCheck(c, 'remove raised', d.near);
      }
      await L.leaveWorld();
    }
    // ---- lowered: realise, one toggle there and back, remove lowered
    {
      const rec = (out.lowered = {});
      const c = await moat('b');
      check(c.st?.view?.state === 'PLACED', `(lowered) realiseApproved: ${c.st?.view?.state}`);
      if (c.region) {
        const d = deckOf(c);
        await use(d.far); await wait(1500, 'raise');
        await use(d.far); await wait(1500, 'lower');
        rec.deck = await opened(d);
        check(rec.deck === 0, `(lowered) after a toggle there and back the deck is lowered (${rec.deck} open)`);
        rec.eflat = await removeCheck(c, 'remove lowered', d.near);
      }
      await L.leaveWorld();
    }
    spendZero();
    return out;
  };

  const evApi = async (args) => { const r = await L.cmd(`/apitest ${args}`); const line = (r.messages ?? []).find((m) => m.startsWith('[') || m.startsWith('{')); return line ? JSON.parse(line) : null; };
  const mechWaits = async (region, key) => ((await evApi('events 0')) ?? []).filter((e) => e.event === 'ITEM_WAITING' && (e.key ?? e.itemKey) === key && (e.ext?.['architect_mc:region'] ?? region) === region);

  steps.csurvival = async () => {
    await ensure();
    await L.leaveWorld().catch(() => null);
    const out = {};
    const tag = 'sv';
    const fx = G.fixture(ctx, FXN);
    const T = await G.twin(ctx, `gmc-${tag}`, fx, fx.lotEntries);
    const c = await moat(tag, { creative: false, realise: false });
    const bomParts = c.ck.check?.cost?.bomParts ?? {};
    const planBill = bomParts['mech:drawbridge'] ?? null;
    out.check = { overall: c.ck.check?.overall, survival: c.ck.check?.survival, planBill, cost: c.m?.cost ?? null, partBom: c.a?.cost?.bom ?? null, survivalBom: c.ck.check?.cost?.bom ?? null };
    check(c.ck.check?.survival === true && c.ck.check?.overall === 'READY' && c.m?.kind === 'drawbridge' && !!planBill, `${tag}: READY in survival; the plan's bill names the drawbridge's circuit (cost.bomParts mech:drawbridge ${json(planBill)})`);
    check(!!planBill && G.same(planBill, c.m.cost.bom.max) && G.same(c.m.cost.bom.min, c.m.cost.bom.max), `${tag}: the plan bill = the circuit's mechanism.cost (exact: min = max) (${json(G.minus(planBill, c.m?.cost?.bom?.max))})`);
    // the path part's bill too (the aprons and trapdoors, charged through the construction queue): iron trapdoors are the drawbridge's only
    const trapN = 2 * (c.b?.trapdoors ?? -1);
    out.check.trapdoors = { survivalBom: c.ck.check?.cost?.bom?.['minecraft:iron_trapdoor'] ?? null, partBom: c.a?.cost?.bom?.['minecraft:iron_trapdoor'] ?? null, want: trapN };
    check(out.check.trapdoors.survivalBom === trapN && out.check.trapdoors.partBom === trapN, `${tag}: the survival check's cost.bom and the part's cost.bom name the deck's ${trapN} iron trapdoors (${json(out.check.trapdoors)})`);
    const pathBill = G.minus(c.a?.cost?.bom ?? {}, c.m?.cost?.bom?.max ?? {});
    out.check.pathBill = pathBill;
    check(Object.values(pathBill).every((n) => n > 0) && pathBill['minecraft:iron_trapdoor'] === trapN, `${tag}: the part's cost.bom = the path part's bill (aprons and trapdoors: ${json(pathBill)}) + the circuit's mechanism.cost`);
    if (!c.sha) { await L.leaveWorld(); return out; }
    c.pre = await G.snap(ctx, c.box, `gmc-${tag}-pre`);
    const crates = await G.pile(ctx, c.s, 8);
    await killMobs();
    const cons = new G.Conservation(ctx, c.box);
    await cons.start();
    await evApi('events clear').catch(() => null);
    const region = await G.realise(ctx, c.sha, fx.lotEntries);
    const d = deckOf(c);
    const mechView = async () => (await call('dev.gm.state', { region, lot: 'drawbridge' }, 30_000)).mechanism ?? {};
    // phase A: everything fed but the circuit's bill: it waits for the deck, then its whole bill, nothing of it written
    const seen = { built: false, stock: false, written: false, item: [] };
    let bill = null;
    const end = Date.now() + 5_400_000;
    while (Date.now() < end) {
      const st = await G.regionState(ctx, region);
      if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(st?.view?.waiting?.reason)) await killMobs();
      const v = await mechView();
      bill ??= v.record?.bill ?? null;
      const it = v.item ?? {};
      if (it.status === 'WAITING' && /to be built/.test(it.message ?? '')) seen.built = true;
      if (it.status === 'WAITING' && /in the stockpile/.test(it.message ?? '')) { seen.stock = true; out.stockWait = it.message; }
      if (it.status !== 'PLACED' && it.status !== 'PLACING' && /lever/.test(await stateAt(...d.near))) seen.written = true;
      const k = `${it.status}:${(it.message ?? '').slice(0, 50)}`;
      if (seen.item.at(-1) !== k) seen.item.push(k);
      if (seen.stock || ['PLACED', 'FAILED', 'PARTIAL'].includes(st.view.state)) break;
      const ps = await G.pileState(ctx);
      const need = {};
      for (const [i, n] of Object.entries(ps.outstanding ?? {})) { const lack = n - (ps.stock?.[i] ?? 0) - (bill?.[i] ?? 0); if (lack > 0) need[i] = lack; }
      if (Object.keys(need).length) await cons.insert(`stockpile:${G.OWNER}`, need);
      await L.sleep(3000);
    }
    out.hold = { ...seen, bill };
    await L.sleep(8000);
    const ev = await mechWaits(region, 'mech:drawbridge');
    const billEv = ev.filter((e) => e.ext?.['architect_mc:waitsFor']?.kind === 'bill');
    out.waits = { events: ev.length, bill: billEv.length, say: billEv[0]?.ext?.['architect_mc:waitsFor']?.say ?? null };
    check(seen.stock && !seen.written, `${tag}: the circuit is held: it waits for its whole bill (${(out.stockWait ?? '').slice(0, 160)}), nothing of it written meanwhile`, seen);
    check(billEv.length === 1 && /drawbridge waits for .* in the stockpile$/.test(out.waits.say ?? ''), `${tag}: the move to the bill wait is announced once, naming the drawbridge (${json(out.waits)})`);
    check(!!bill && G.same(bill, planBill), `${tag}: the held bill = the plan's (${json(G.minus(bill, planBill))})`);
    // phase B: fed; charged at once, then written
    const f = await G.feed(ctx, region, { cons, fraction: 1, timeoutMs: 3_600_000 });
    out.state = f.last.st.view.state;
    check(out.state === 'PLACED', `${tag}: fed and built in survival: ${out.state} (${f.waves} waves)`);
    const v = await mechView();
    const st = await call('dev.region.state', { region }, 60_000);
    const rep = (st.view?.ext ?? st.record?.ext ?? {})['architect_mc:gateMechanism']?.drawbridge ?? null;
    out.mech = { record: v.record, built: v.built, report: rep };
    const charged = v.record?.charged ?? null;
    check(!!charged && G.same(charged, planBill) && G.same(charged, rep?.bom), `${tag}: charged once = the plan's bill = the region's report, item for item (${json(G.minus(charged, planBill))})`);
    check(!!charged && G.same(charged, v.built), `${tag}: the built circuit (read from the world) = what was charged (${json(G.minus(v.built, charged))})`);
    // (conservation is judged on the drawbridge's own items, its path part's bill and its circuit's; the walled town and moat without a
    // drawbridge lose dirt and cobblestone under the same measure (gm-c-survctl on h/v45b_moat_road), recorded here, not GM-c's)
    const mine = new Set([...Object.keys(c.a?.cost?.bom ?? {}), ...Object.keys(planBill ?? {})]);
    const own = (p) => Object.fromEntries(Object.entries(p.diff).filter(([k]) => mine.has(k)));
    out.consBuilt = await cons.point('built');
    const aud = await cons.parts();
    out.paidTrapdoors = aud.paidStanding?.['minecraft:iron_trapdoor'] ?? 0;
    check(out.paidTrapdoors === trapN, `${tag}: the audit's paid standing iron trapdoors after the build = the deck's ${trapN} (${out.paidTrapdoors})`);
    out.consBuiltOther = Object.fromEntries(Object.entries(out.consBuilt.diff).filter(([k]) => !mine.has(k)));
    check(out.consBuilt.identity && !Object.keys(own(out.consBuilt)).length, `${tag}: conservation exact after the build on the drawbridge's items (${[...mine].length}): ${json(own(out.consBuilt))}; the rest recorded (the town and moat's, as the control): ${json(out.consBuiltOther)}`);
    const tw = await G.twinDiff(ctx, T.box, T.file, crates);
    out.twin = tw;
    check(tw.mismatches === 0, `${tag}: the survival build equals its INSTANT twin cell for cell (the crates aside): ${tw.mismatches} differ`, tw.list);
    // removal raised (the near lever on: the deck's trapdoors open, in the path part): the refund is the charge; E-flat 0; nothing dropped
    await use(d.near); await wait(1500, 'raise');
    out.raisedDeck = await opened(d);
    await cmd('/kill @e[type=minecraft:item]');
    const rmP = G.remove(ctx, region);
    let sv = null;
    for (let k = 0; k < 600 && !sv?.refund; k++) { sv = (await mechView().catch(() => ({}))).record ?? sv; if (!sv?.refund) await L.sleep(100); }
    const rm = await rmP;
    const e = await G.diff(ctx, c.box, c.pre);
    const ef = e.list.filter((q) => !crates.some((k2) => k2.join(',') === q.pos));
    const p2 = await cons.point('removed');
    const it1 = await items(...d.near, 24);
    out.removal = { raised: out.raisedDeck, removed: rm.removed, eflat: ef.length, list: ef.slice(0, 8), refund: sv?.refund ?? null, cons: p2, items: it1.stacks ?? 0 };
    check(out.raisedDeck === d.deck.length, `${tag}: raised before the removal (${out.raisedDeck} of ${d.deck.length} open)`);
    check(rm.removed && ef.length === 0, `${tag}: Regions.remove (raised): E-flat ${ef.length} (the crates aside)`, ef.slice(0, 8));
    check(!!sv?.refund && G.same(sv.refund, charged), `${tag}: the removal's refund = the charge, item for item (${sv?.refund ? json(G.minus(sv.refund, charged)) : 'not read'})`);
    out.consRemovedOther = Object.fromEntries(Object.entries(p2.diff).filter(([k]) => !mine.has(k)));
    check(p2.identity && !Object.keys(own(p2)).length, `${tag}: conservation exact after the removal on the drawbridge's items (the path part's refund with its trapdoors open included): ${json(own(p2))}; the rest recorded: ${json(out.consRemovedOther)}`);
    check(!out.removal.items, `${tag}: no item dropped (${out.removal.items})`);
    await L.leaveWorld();
    spendZero();
    return out;
  };

  /**
   * (recorded, not a gate item) The survival control: h/v45b_moat_road (the same walled town and moat, a road crossing it on T3's fallback
   * bridge, no drawbridge) built and removed in survival with the same conservation measure, so a conservation finding in csurvival can
   * be told apart from the drawbridge's.
   */
  steps.csurvctl = async () => {
    await ensure();
    await L.leaveWorld().catch(() => null);
    const name = 'h/v45b_moat_road';
    const fx = G.fixture(ctx, name);
    const c = await moat('ctl', { creative: false, realise: false, name });
    const out = { overall: c.ck.check?.overall };
    if (!c.sha) { await L.leaveWorld(); return out; }
    c.pre = await G.snap(ctx, c.box, 'gmc-ctl-pre');
    await G.pile(ctx, c.s, 8);
    await killMobs();
    const cons = new G.Conservation(ctx, c.box);
    await cons.start();
    const region = await G.realise(ctx, c.sha, fx.lotEntries);
    const f = await G.feed(ctx, region, { cons, fraction: 1, timeoutMs: 3_600_000 });
    out.state = f.last.st.view.state;
    out.built = await cons.point('built');
    await G.remove(ctx, region);
    out.removed = await cons.point('removed');
    log(`  csurvctl: ${json(out)}`);
    check(out.state === 'PLACED', `control: v45b built in survival (${out.state}); conservation built ${json(out.built.diff)}, removed ${json(out.removed.diff)} (recorded)`);
    await L.leaveWorld();
    return out;
  };
}
