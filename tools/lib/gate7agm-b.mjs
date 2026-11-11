// (GM-b) The K1 swing gate's steps of tools/gate7agm.mjs (docs/CONTRACT.md "Slice GM" §17): gm-b-unit (the kit's gm-b tests, the Java
// GateMechTest), gm-b-ingame (a town in a wall 3 thick with a player-only road through a mech swing gate, realised through checkPlan and
// realiseApproved in creative: the button and lever by real use, 20 cycles each, the plate, vanilla's villager blocked outside the closed
// gate and passing the held-open one, the villager-edge and thin-wall fallbacks to the wooden door; undo with the gate closed, open and
// mid-move: E-flat 0, no drop), gm-b-survival (held for the wall built and its whole bill, charged once = the check's bill = built,
// refunded at removal) and gm-b-look (the gallery: client). $0: the sim sidecar, no Claude.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { testConcurrencyArgs } from './cpu-budget.mjs';

/** Registers the GM-b steps on `steps`. `h`: the driver's helpers (as registerGmA). */
export async function registerGmB(steps, h) {
  const { L, call, check, cmd, log, root, OUT, json, stateAt, freeze, unfreeze, step, items } = h;
  const KIT = path.join(root, 'kit');
  const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
  const core = await import('./gate6chy-core.mjs');
  const B = await import('./gate6chy-b.mjs');
  const G = await import('./gate6crs-game.mjs');
  const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };
  const runsOf = (flat) => { const out = []; for (let i = 0; i + 3 < (flat ?? []).length; i += 4) for (let y = flat[i + 2]; y <= flat[i + 3]; y++) out.push([flat[i], y, flat[i + 1]]); return out; };
  const spendZero = () => fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice GM-b is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
  const ensure = async () => { if (!L.state.dev) await L.connect(); };
  const use = (at) => call('dev.pt.uses', { ops: [{ item: 'minecraft:stick', at, on: at, face: 'up' }] }, 30_000);
  const killMobs = () => cmd('/kill @e[type=!minecraft:player]');
  const waitPlaced = (region) => L.waitRegion(region, 3_600_000, async (x) => { if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(x?.waiting?.reason)) await killMobs(); });

  // ------------------------------------------------------------------ gm-b-unit (offline)

  steps.bunit = async () => {
    const out = {};
    const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), 'kit/test/gm-b.test.mjs', 'kit/test/gm-a.test.mjs', 'kit/test/plan-k1a.test.mjs'], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
    const t = `${r.stdout}${r.stderr}`;
    const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
    out.kit = { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
    check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 10, `gm-b (kit): the plan member and catalogue limit, the swing's frame (every facing), the IR write and the wall writing none of its cells, the bill, the siteplan, S-THEME, the villager, thin-wall, width and MOVER answers, at gates, determinism; GM-a's and K1a's tests unchanged: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
    const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.join(root, '.gradle-home') };
    const j = spawnSync(path.join(root, 'mod', 'gradlew'), ['--offline', '--no-daemon', 'test', '--tests', 'dev.larattalabs.architect.region.GateMechTest'], { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 });
    out.java = `${j.stdout}${j.stderr}`.trim().split('\n').slice(-6);
    check(j.status === 0, 'gm-b (Java): GateMechTest (the K1 swing write read from the IR, written whole, its exact bill, its report)', out.java);
    spendZero();
    return out;
  };

  // ------------------------------------------------------------------ in game

  /** A GM-b fixture checked (and realised): {fx, s, ck, sha, g (the gate's answer), m (its mechanism), box, region?, st?, pre?}. */
  async function town(name, { tag, creative = true, realise = true, bible = null } = {}) {
    const fx = G.fixture(ctx, `gm/${name}`);
    const s = await G.site(ctx, `gmb ${tag}`, fx, { creative });
    await G.designs(ctx);
    await cmd('/time set 6000');
    await cmd('/weather clear');
    const ck = await call('dev.region.checkPlan', { plan: s.wp.plan, claim: s.W.claim, owner: G.OWNER, anchors: s.wp.anchors, load: 'generate', ...(bible ? { bible } : {}) }, 1_800_000);
    fs.writeFileSync(path.join(OUT, `gmb-${tag}-check.json`), `${JSON.stringify(ck, null, 1)}\n`);
    const sha = ck.check?.artifactSha;
    const g = (ck.check?.parts ?? []).find((a) => a.part === 'east_gate') ?? null;
    const box = G.boxOf(s.W);
    const out = { fx, s, ck, sha, g, m: g?.geometry?.mechanism ?? null, box };
    if (!realise || !sha) return out;
    out.pre = await G.snap(ctx, box, `gmb-${tag}-pre`);
    await killMobs();
    out.region = await G.realise(ctx, sha, fx.lotEntries);
    out.st = await waitPlaced(out.region);
    await L.settle(3000);
    return out;
  }

  /** The swing's cells from its record: the doors (lower halves), the triggers, outside and inside walk points. */
  function swingOf(m) {
    const t = (k) => m.triggers.find((q) => q.kind === k).at;
    const btn = t('button'), lever = t('lever'), plate = t('plate');
    const doors = runsOf(m.states.closed).filter((q) => q[1] === plate[1]);
    const dx = Math.sign(btn[0] - lever[0]), dz = Math.sign(btn[2] - lever[2]);
    const outside = [btn[0] + 3 * dx, plate[1], btn[2] + 3 * dz], inside = [lever[0] - 3 * dx, plate[1], lever[2] - 3 * dz];
    return { btn, lever, plate, doors, outside, inside };
  }
  const doorsOpen = async (sw) => { let n = 0; for (const q of sw.doors) if (/open=true/.test(await stateAt(...q))) n++; return n; };
  const villager = async (from, to) => !!(await call('dev.nav.villager', { from, to, range: 128 }, 120_000)).canReach;
  const wait = (ms, label) => L.gameWait(ms, { real: L.settle, label });

  /** Removal of a realised town and its E-flat, with no item dropped. */
  async function removeCheck(c, tag) {
    const rm = await G.remove(ctx, c.region);
    const d = await G.diff(ctx, c.box, c.pre);
    const it = await items(...(c.sw?.btn ?? c.g.geometry.at), 24);
    const rec = { removed: rm.removed, mismatches: d.mismatches, list: d.list.slice(0, 12), classes: d.classes, items: { stacks: it.stacks ?? 0, items: it.items ?? null } };
    check(rm.removed && d.mismatches === 0, `${tag}: Regions.remove: E-flat ${d.mismatches} over the claim`, d.list.slice(0, 8));
    check(!rec.items.stacks, `${tag}: the removal dropped no item (${json(rec.items)})`);
    return rec;
  }

  steps.bingame = async () => {
    await ensure();
    await L.leaveWorld().catch(() => null);
    const out = {};
    const only = process.env.GMB_INGAME_ONLY ? new Set(process.env.GMB_INGAME_ONLY.split(',')) : null;
    // ---- the K1 swing in creative: the doors by the button, lever and plate; villagers blocked; 20 cycles each
    if (!only || only.has('swing')) {
      const rec = {};
      out.swing = rec;
      const c = await town('gmb_k1_swing', { tag: 'swing' });
      rec.check = { overall: c.ck.check?.overall, gate: c.g?.class, deviations: c.g?.deviations ?? null, kind: c.m?.kind ?? null };
      check(c.ck.check?.overall === 'READY' && c.g?.class === 'fits' && c.m?.kind === 'swing', `swing: gmb_k1_swing checks READY, the gate fits with its swing, no mechanism deviation (${json(rec.check)})`);
      check(c.st?.view?.state === 'PLACED', `swing: realiseApproved: ${c.st?.view?.state}`);
      if (c.region) {
        const sw = (c.sw = swingOf(c.m));
        const st = await call('dev.region.state', { region: c.region }, 60_000);
        rec.report = (st.view?.ext ?? st.record?.ext ?? {})['architect_mc:gateMechanism']?.east_gate ?? null;
        rec.cells = [];
        for (const q of runsOf(c.m.cells)) rec.cells.push([q.join(','), await stateAt(...q)]);
        check(rec.report?.kind === 'swing' && rec.report?.cells === runsOf(c.m.cells).length && rec.cells.filter(([, s]) => /iron_door/.test(s)).length === 4 && rec.cells.some(([, s]) => /lever/.test(s)), `swing: the region's report (${json(rec.report)}); the doors, mullion, transom, button, lever and plate stand where the record says`, rec.cells);
        rec.rest = await doorsOpen(sw);
        check(rec.rest === 0, `swing: at rest the iron doors are shut (${rec.rest} open)`);
        // still: nothing in the swing's box changes in 40 ticks after the realise
        const xs = runsOf(c.m.cells), bb = [Math.min(...xs.map((q) => q[0])) - 1, Math.min(...xs.map((q) => q[1])), Math.min(...xs.map((q) => q[2])) - 1, Math.max(...xs.map((q) => q[0])) + 1, Math.max(...xs.map((q) => q[1])), Math.max(...xs.map((q) => q[2])) + 1];
        await freeze();
        const f0 = await G.snap(ctx, bb, 'gmb-swing-still');
        await step(40);
        const dd = await G.diff(ctx, bb, f0);
        await unfreeze();
        rec.still = dd.mismatches;
        check(dd.mismatches === 0, `swing: nothing in the swing's box changes in the 40 ticks after the realise (${dd.mismatches})`, dd.list.slice(0, 6));
        // villagers: blocked from outside while closed (both ways for the vanilla navigator), pass the held-open gate
        rec.villagerClosed = [await villager(sw.outside, sw.inside), await villager(sw.inside, sw.outside)];
        check(!rec.villagerClosed[0] && !rec.villagerClosed[1], `swing: closed, vanilla's villager navigation cannot cross the gate either way (${json(rec.villagerClosed)})`);
        // the button: 20 presses by real use, open then shut on release
        let bad = 0;
        for (let i = 0; i < 20; i++) {
          await use(sw.btn);
          await wait(400, 'button');
          const o = await doorsOpen(sw);
          await wait(2500, 'button releases');
          const s2 = await doorsOpen(sw);
          if (o !== sw.doors.length || s2 !== 0) bad++;
        }
        rec.button = { n: 20, bad };
        check(bad === 0, `swing: 20 button presses by real use (outside): the doors open, then shut when it releases (${bad} wrong)`);
        // the inside lever: 20 cycles by real use
        bad = 0;
        for (let i = 0; i < 20; i++) {
          await use(sw.lever); await wait(500, 'lever on');
          const o = await doorsOpen(sw);
          if (i === 0) { rec.villagerOpen = [await villager(sw.outside, sw.inside), await villager(sw.inside, sw.outside)]; }
          await use(sw.lever); await wait(500, 'lever off');
          const s2 = await doorsOpen(sw);
          if (o !== sw.doors.length || s2 !== 0) bad++;
        }
        rec.lever = { n: 20, bad };
        check(bad === 0, `swing: 20 cycles of the inside lever by real use: held open, then shut (${bad} wrong)`);
        check(rec.villagerOpen?.[0] && rec.villagerOpen?.[1], `swing: held open by the lever, vanilla's villager crosses both ways (${json(rec.villagerOpen)})`);
        // the plate: a villager inside on it opens the doors (anyone inside, §2)
        await cmd(`/summon minecraft:villager ${sw.plate[0] + 0.5} ${sw.plate[1]} ${sw.plate[2] + 0.5} {NoAI:1b}`);
        await wait(1000, 'plate');
        rec.plate = await doorsOpen(sw);
        await killMobs();
        await wait(2000, 'plate releases');
        rec.plateAfter = await doorsOpen(sw);
        check(rec.plate >= 1 && rec.plateAfter === 0, `swing: a villager on the inside plate opens the door beside it (iron doors do not open as a pair: ${rec.plate} of ${sw.doors.length}); off it, shut (${rec.plateAfter})`);
        const it0 = await items(...sw.btn, 24);
        rec.items = { stacks: it0.stacks ?? 0, items: it0.items ?? null };
        check(!rec.items.stacks, `swing: no item dropped while it ran (${json(rec.items)})`);
        rec.eflat = await removeCheck(c, 'swing (closed)');
      }
      await L.leaveWorld();
    }
    // ---- the fallbacks: a villager crossing, a wall 2 thick: the wooden door, adjusted, deviation mechanism; villagers pass it
    for (const [name, tag, why] of [['gmb_k1_villager', 'villager', 'villager'], ['gmb_k1_thin', 'thin', 'thickness']]) {
      if (only && !only.has(tag)) continue;
      const rec = {};
      out[tag] = rec;
      const c = await town(name, { tag });
      rec.check = { overall: c.ck.check?.overall, gate: c.g?.class, deviations: c.g?.deviations ?? null, door: c.g?.geometry?.door, mechanism: c.m };
      check(c.ck.check?.overall === 'READY' && c.g?.class === 'adjusted' && (c.g.deviations ?? []).some((d) => d.what === 'mechanism' && d.why === why && d.gate === 'east_gate') && c.g.geometry?.door === 'door' && !c.m, `${tag}: ${name} READY, the gate adjusted back to the wooden door with deviation mechanism (why ${why}) and a note (${json(c.g?.deviations)}; ${json((c.g?.notes ?? []).filter((n) => /wooden door/.test(n)))})`);
      if (c.region) {
        check(c.st?.view?.state === 'PLACED', `${tag}: realised (${c.st?.view?.state})`);
        const st = await call('dev.region.state', { region: c.region }, 60_000);
        rec.report = (st.view?.ext ?? st.record?.ext ?? {})['architect_mc:gateMechanism'] ?? null;
        // the gate's cells: wooden doors, no iron one
        const meta = c.g.geometry;
        const y = meta.at[1];
        const doors = [];
        for (let x = meta.at[0] - 2; x <= meta.at[0] + 2; x++) for (let z = meta.at[2] - 2; z <= meta.at[2] + 2; z++) { const s = await stateAt(x, y, z); if (/_door\[/.test(s)) doors.push([x, y, z, s]); }
        rec.doors = doors;
        check(!rec.report && doors.length >= 2 && doors.every((d) => !/iron_door/.test(d[3])), `${tag}: no mechanism written (${json(rec.report)}); the gate's doors are wooden (${doors.length}: ${json([...new Set(doors.map((d) => d[3].replace(/\[.*$/, '')))])})`);
        rec.eflat = await removeCheck(c, tag);
      }
      await L.leaveWorld();
    }
    spendZero();
    return out;
  };

  // ------------------------------------------------------------------ undo (the verifier re-runs it)

  steps.bundo = async () => {
    await ensure();
    await L.leaveWorld().catch(() => null);
    const out = {};
    const modes = process.env.GMB_UNDO_ONLY ? process.env.GMB_UNDO_ONLY.split(',') : ['closed', 'open', 'midmove'];
    for (const mode of modes) {
      const c = await town('gmb_k1_swing', { tag: `undo-${mode}` });
      if (!c.region) { check(false, `undo ${mode}: no region`); await L.leaveWorld(); continue; }
      const sw = (c.sw = swingOf(c.m));
      const rec = { mode };
      if (mode === 'open') { await use(sw.lever); await wait(500, 'lever on'); rec.open = await doorsOpen(sw); check(rec.open === sw.doors.length, `undo open: the lever holds the doors open (${rec.open})`); }
      if (mode === 'midmove') {
        // the button pressed under /tick freeze, stepped until the doors swing open with its release still scheduled, then removed with
        // the clock running (the button powered, its unpress tick pending)
        await freeze();
        await use(sw.btn);
        let t;
        for (t = 1; t <= 10; t++) { await step(1); if ((await doorsOpen(sw)) === sw.doors.length) break; }
        rec.openAt = t;
        rec.button = await stateAt(...sw.btn);
        check(/powered=true/.test(rec.button) && t <= 10, `undo midmove: the button pressed (${rec.button.replace(/^.*\[/, '[')}), the doors open at tick ${t}, its release pending`);
        const rmP = G.remove(ctx, c.region);
        await L.settle(300);
        await unfreeze();
        await rmP;
        const d = await G.diff(ctx, c.box, c.pre);
        const it = await items(...sw.btn, 24);
        rec.eflat = { mismatches: d.mismatches, list: d.list.slice(0, 12), items: { stacks: it.stacks ?? 0 } };
        check(d.mismatches === 0, `undo midmove (removed with the button pressed and the doors open): E-flat ${d.mismatches}`, d.list.slice(0, 8));
        check(!it.stacks, `undo midmove: no item dropped (${json(it)})`);
        out[mode] = rec;
        await L.leaveWorld();
        continue;
      }
      await cmd('/kill @e[type=minecraft:item]');
      rec.eflat = await removeCheck(c, `undo ${mode}`);
      out[mode] = rec;
      await L.leaveWorld();
    }
    spendZero();
    return out;
  };

  // ------------------------------------------------------------------ gm-b-survival (the verifier re-runs it)

  // (slice WE) the apitest event log: ITEM_WAITING of the mechanism item, its reason, waitsFor and message
  const evApi = async (args) => { const r = await L.cmd(`/apitest ${args}`); const line = (r.messages ?? []).find((m) => m.startsWith('[') || m.startsWith('{')); return line ? JSON.parse(line) : null; };
  const mechWaits = async (region, key) => ((await evApi('events 0')) ?? []).filter((e) => e.event === 'ITEM_WAITING' && (e.key ?? e.itemKey) === key && (e.ext?.['architect_mc:region'] ?? region) === region);
  const SAY_SUBJECT = /^[A-Z][^]*'s (portcullis|sliding gate|swing gate) waits for /;
  // (NM) an unnamed gate the wall cut on its own: "<the wall>'s first swing gate waits for ...", never its id
  const SAY_AUTO = /^[A-Z][^]*'s first swing gate waits for /;
  const checkMechWaits = async (tag, region, key, stockWait, SAY = SAY_SUBJECT) => {
    await L.sleep(8000); // many polls (every 20 s of re-checks, 3 s here) of the bill wait: it must not fire again
    const ev = await mechWaits(region, key);
    const bill = ev.filter((e) => e.ext?.['architect_mc:waitsFor']?.kind === 'bill');
    const lot = ev.filter((e) => e.ext?.['architect_mc:waitsFor']?.kind !== 'bill' && e.ext?.['architect_mc:waitsFor']?.say);
    const w = bill[0]?.ext?.['architect_mc:waitsFor'];
    check(bill.length === 1 && bill[0].reason === 'SITE_BUSY' && SAY.test(w?.say ?? '') && / in the stockpile$/.test(w?.say ?? '') && Object.keys(w?.missing ?? {}).length > 0 && (bill[0].message ?? '').startsWith(w.say),
      `${tag}: the move to the bill wait fires ITEM_WAITING once (SITE_BUSY, waitsFor.kind bill, ${bill.length} event(s) over the polls), saying ${json(w?.say)}, missing ${json(w?.missing)}`, { ev: ev.length });
    const missingText = Object.entries(w?.missing ?? {}).every(([i, n]) => (w?.say ?? '').includes(`${n} \u00d7 `));
    check(missingText && !/_|minecraft:/.test(w?.say ?? ''), `${tag}: the say names each missing item by its player-facing name with its count (no ids)`);
    check(lot.every((e) => SAY.test(e.ext['architect_mc:waitsFor'].say) && / to be built$/.test(e.ext['architect_mc:waitsFor'].say) && !/_/.test(e.ext['architect_mc:waitsFor'].say)),
      `${tag}: the first wait says the mechanism and what it waits for (${lot.length} event(s): ${json(lot[0]?.ext?.['architect_mc:waitsFor']?.say ?? null)})`);
    return { events: ev.length, bill: bill.length, lot: lot.length, say: w?.say ?? null, lotSay: lot[0]?.ext?.['architect_mc:waitsFor']?.say ?? null };
  };

  steps.bsurvival = async () => {
    await ensure();
    await L.leaveWorld().catch(() => null);
    const out = {};
    const tag = 'sv-k1';
    const name = 'gmb_k1_swing';
    const fx = G.fixture(ctx, `gm/${name}`);
    const T = await G.twin(ctx, `gmb-${tag}`, fx, fx.lotEntries);
    const c = await town(name, { tag, creative: false, realise: false });
    const bomParts = c.ck.check?.cost?.bomParts ?? {};
    const planBill = bomParts['mech:east_gate'] ?? null;
    out.check = { overall: c.ck.check?.overall, survival: c.ck.check?.survival, planBill, cost: c.m?.cost ?? null };
    check(c.ck.check?.survival === true && c.ck.check?.overall === 'READY' && c.m?.kind === 'swing' && !!planBill, `${tag}: READY in survival; the plan's bill names the swing (cost.bomParts mech:east_gate ${json(planBill)})`);
    check(!!planBill && G.same(planBill, c.m.cost.bom.max) && G.same(c.m.cost.bom.min, c.m.cost.bom.max), `${tag}: the plan bill = the gate's mechanism.cost (exact: min = max) (${json(G.minus(planBill, c.m?.cost?.bom?.max))})`);
    if (!c.sha) { await L.leaveWorld(); return out; }
    c.pre = await G.snap(ctx, c.box, `gmb-${tag}-pre`);
    const crates = await G.pile(ctx, c.s, 8);
    await killMobs();
    const cons = new G.Conservation(ctx, c.box);
    await cons.start();
    await evApi('events clear').catch(() => null);
    const region = await G.realise(ctx, c.sha, fx.lotEntries);
    const sw = swingOf(c.m);
    const mechView = async () => (await call('dev.gm.state', { region, lot: 'east_gate' }, 30_000)).mechanism ?? {};
    // phase A: everything fed but the swing's bill: it waits for the wall, then for its whole bill, nothing of it written
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
      if (it.status !== 'PLACED' && it.status !== 'PLACING' && /lever/.test(await stateAt(...sw.lever))) seen.written = true;
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
    out.waits = await checkMechWaits(`${tag}`, region, 'mech:east_gate');
    check(seen.stock && !seen.written, `${tag}: the swing is held: it waits for its whole bill (${(out.stockWait ?? '').slice(0, 160)}), nothing of it written meanwhile (the wall first: ${seen.built ? 'seen waiting for it' : 'built before the swing was reached'})`, seen);
    check(!!bill && G.same(bill, planBill), `${tag}: the held bill = the plan's (${json(G.minus(bill, planBill))})`);
    // phase B: fed; charged at once, then written
    const f = await G.feed(ctx, region, { cons, fraction: 1, timeoutMs: 3_600_000 });
    out.state = f.last.st.view.state;
    check(out.state === 'PLACED', `${tag}: fed and built in survival: ${out.state} (${f.waves} waves)`);
    const v = await mechView();
    const st = await call('dev.region.state', { region }, 60_000);
    const rep = (st.view?.ext ?? st.record?.ext ?? {})['architect_mc:gateMechanism']?.east_gate ?? null;
    out.mech = { record: v.record, built: v.built, cells: v.cells, report: rep };
    const charged = v.record?.charged ?? null;
    check(!!charged && G.same(charged, planBill) && G.same(charged, rep?.bom), `${tag}: charged once = the plan's bill = the region's report, item for item (${json(G.minus(charged, planBill))})`);
    check(!!charged && G.same(charged, v.built), `${tag}: the built swing (read from the world) = what was charged (${json(G.minus(v.built, charged))})`);
    out.consBuilt = await cons.point('built');
    check(G.exact(out.consBuilt), `${tag}: conservation exact after the build: ${json(out.consBuilt.diff)}`);
    const d = await G.twinDiff(ctx, T.box, T.file, crates);
    out.twin = d;
    check(d.mismatches === 0, `${tag}: the survival build equals its INSTANT twin cell for cell (the crates aside): ${d.mismatches} differ`, d.list);
    // removal with the gate held open (the lever on): the refund is the charge; E-flat 0; nothing dropped
    await use(sw.lever); await wait(500, 'lever on');
    await cmd('/kill @e[type=minecraft:item]');
    const rmP = G.remove(ctx, region);
    let sv = null;
    for (let k = 0; k < 600 && !sv?.refund; k++) { sv = (await mechView().catch(() => ({}))).record ?? sv; if (!sv?.refund) await L.sleep(100); }
    const rm = await rmP;
    const e = await G.diff(ctx, c.box, c.pre);
    const ef = e.list.filter((q) => !crates.some((k2) => k2.join(',') === q.pos));
    const p2 = await cons.point('removed');
    const it1 = await items(...sw.btn, 24);
    out.removal = { removed: rm.removed, eflat: ef.length, list: ef.slice(0, 8), refund: sv?.refund ?? null, cons: p2, items: { stacks: it1.stacks ?? 0 } };
    check(rm.removed && ef.length === 0, `${tag}: Regions.remove (the gate held open): E-flat ${ef.length} (the crates aside)`, ef.slice(0, 8));
    check(!!sv?.refund && G.same(sv.refund, charged), `${tag}: the removal's refund = the charge, item for item (${sv?.refund ? json(G.minus(sv.refund, charged)) : 'not read'})`);
    check(G.exact(p2), `${tag}: conservation exact after the removal: ${json(p2.diff)}`);
    check(!out.removal.items.stacks, `${tag}: no item dropped (${json(out.removal.items)})`);
    await L.leaveWorld();
    out.auto = await autoGateWaits();
    spendZero();
    return out;
  };

  /**
   * (NM) The same swing as an unnamed gate (nm_auto_swing: the wall cuts curtain_g1 for the road's crossing): everything is fed but its bill, and
   * its two waits say "<the wall>'s first swing gate", never "curtain g1" (the first wait for the wall, the move to the bill wait for its items).
   */
  async function autoGateWaits() {
    const tag = 'sv-nm';
    const name = 'nm_auto_swing';
    const fx = G.fixture(ctx, `gm/${name}`);
    const c = await town(name, { tag, creative: false, realise: false });
    check(c.ck.check?.survival === true && c.ck.check?.overall === 'READY' && !!(c.ck.check?.cost?.bomParts ?? {})['mech:curtain_g1'], `${tag}: READY in survival; the unnamed gate curtain_g1 has its swing bill (${json(Object.keys(c.ck.check?.cost?.bomParts ?? {}))})`);
    if (!c.sha) { await L.leaveWorld(); return null; }
    await G.pile(ctx, c.s, 8);
    await killMobs();
    const cons = new G.Conservation(ctx, c.box);
    await cons.start();
    await evApi('events clear').catch(() => null);
    const region = await G.realise(ctx, c.sha, fx.lotEntries);
    const mechView = async () => (await call('dev.gm.state', { region, lot: 'curtain_g1' }, 30_000)).mechanism ?? {};
    let bill = null, stockWait = null;
    const end = Date.now() + 5_400_000;
    while (Date.now() < end) {
      const st = await G.regionState(ctx, region);
      if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(st?.view?.waiting?.reason)) await killMobs();
      const v = await mechView();
      bill ??= v.record?.bill ?? null;
      const it = v.item ?? {};
      if (it.status === 'WAITING' && /in the stockpile/.test(it.message ?? '')) { stockWait = it.message; break; }
      if (['PLACED', 'FAILED', 'PARTIAL'].includes(st.view.state)) break;
      const ps = await G.pileState(ctx);
      const need = {};
      for (const [i, n] of Object.entries(ps.outstanding ?? {})) { const lack = n - (ps.stock?.[i] ?? 0) - (bill?.[i] ?? 0); if (lack > 0) need[i] = lack; }
      if (Object.keys(need).length) await cons.insert(`stockpile:${G.OWNER}`, need);
      await L.sleep(3000);
    }
    check(!!stockWait && SAY_AUTO.test(stockWait) && !/curtain|_g\d/i.test(stockWait), `${tag}: the unnamed gate's bill wait names it by its wall's gate order (${json(stockWait)})`);
    const waits = await checkMechWaits(tag, region, 'mech:curtain_g1', null, SAY_AUTO);
    await L.leaveWorld();
    return { stockWait, waits };
  }

  // ------------------------------------------------------------------ gm-b-look (client; Noah's gallery)

  const LOOK_BIBLES = [null, 'g7ak1_infernal', 'g7ak1_coastal'];
  function installBible(id) {
    const dst = path.join(L.GAME_DIR, 'architect', 'bibles', id, 'versions', '1');
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(path.join(root, 'scenarios', 'bibles', `${id}.json`), path.join(dst, 'bible.json'));
  }
  async function shot(name, eye, at) {
    await call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator', fov: 70 }, 60_000);
    await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
    await L.settle(1500);
    const r = await call('dev.screenshot', { name: `gmb_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
    const dir = path.join(OUT, 'look-b');
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, `${name}.png`);
    fs.copyFileSync(r.path, dst);
    return { name, eye, at, file: dst, width: r.width, height: r.height };
  }

  steps.blook = async () => {
    await ensure();
    await L.leaveWorld().catch(() => null);
    const out = { shots: [], runs: {} };
    for (const b of LOOK_BIBLES) if (b) installBible(b);
    for (const bible of LOOK_BIBLES) {
      const btag = bible ? bible.replace(/^g7ak1_/, '') : 'default';
      const tag = `k1swing_${btag}`;
      const c = await town('gmb_k1_swing', { tag: `look-${btag}`, bible });
      out.runs[tag] = { state: c.st?.view?.state ?? null, kind: c.m?.kind ?? null };
      check(c.st?.view?.state === 'PLACED' && c.m?.kind === 'swing', `look (${tag}): realised with its swing (recorded; Noah approves)`);
      if (!c.region) { await L.leaveWorld(); continue; }
      const sw = swingOf(c.m);
      const ox = Math.sign(sw.btn[0] - sw.lever[0]), oz = Math.sign(sw.btn[2] - sw.lever[2]);
      const sx = oz, sz = ox;
      const gate = [sw.btn[0] + 0.5, sw.plate[1] + 1.5, sw.btn[2] + 0.5];
      const road = [sw.btn[0] + ox * 12 + 0.5, sw.plate[1] + 4, sw.btn[2] + oz * 12 + 0.5];
      out.shots.push(await shot(`${tag}_closed`, road, gate));
      await use(sw.lever); await wait(600, 'lever');
      out.shots.push(await shot(`${tag}_open`, road, gate));
      out.shots.push(await shot(`${tag}_passage_inside`, [sw.lever[0] - ox * 4 + 0.5, sw.plate[1] + 1.6, sw.lever[2] - oz * 4 + 0.5], [sw.btn[0] + 0.5, sw.plate[1] + 1.2, sw.btn[2] + 0.5]));
      await use(sw.lever); await wait(600, 'lever');
      out.shots.push(await shot(`${tag}_inside_closed`, [sw.lever[0] - ox * 4 + 0.5, sw.plate[1] + 1.6, sw.lever[2] - oz * 4 + 0.5], [sw.btn[0] + 0.5, sw.plate[1] + 1.2, sw.btn[2] + 0.5]));
      out.shots.push(await shot(`${tag}_button`, [sw.btn[0] + ox * 2.5 + sx * 1.5 + 0.5, sw.btn[1] + 0.3, sw.btn[2] + oz * 2.5 + sz * 1.5 + 0.5], [sw.btn[0] + 0.5, sw.btn[1] + 0.5, sw.btn[2] + 0.5]));
      // the toggle strip: the button pressed, frame by frame under /tick freeze
      await freeze();
      await use(sw.btn);
      for (let t = 0; t < 4; t++) { await step(2); out.shots.push(await shot(`${tag}_strip_${t}`, road, gate)); }
      await unfreeze();
      await call('dev.release', {}).catch(() => null);
      await L.leaveWorld();
    }
    fs.mkdirSync(path.join(OUT, 'look-b'), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'look-b', 'look.json'), JSON.stringify(out, null, 2));
    spendZero();
    return out;
  };
}
