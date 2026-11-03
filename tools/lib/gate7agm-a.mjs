// (7a GM-a) The GM-a steps of tools/gate7agm.mjs (docs/CONTRACT.md "Slice GM" §10 items 1-4 and 7-8 under §12-§15): gm-unit (the kit,
// the Java, api-compat, byte identity), gm-ingame (the castle with a mechanism gatehouse realised through checkPlan and realiseApproved:
// the sensor's rung or the levers-only fallback, no block moving after the realise, real lever and button uses, the day cycle, the closed
// passage blocking villagers and players, the open one passing them, the plain [11, 13] passage), gm-undo (Regions.remove open, closed
// and mid-move: E-flat 0), gm-look (the gallery: client). $0: the sim sidecar, no Claude.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { testConcurrencyArgs } from './cpu-budget.mjs';
import { kitReuse } from './kit-reuse.mjs';

/**
 * Registers the GM-a steps on `steps`. `h`: the driver's helpers {L, call, check, cmd, log, root, OUT, json, snap, stateAt, freeze,
 * unfreeze, step, items}.
 */
export async function registerGmA(steps, h) {
  const { L, call, check, cmd, log, root, OUT, json, stateAt, freeze, unfreeze, step, items } = h;
  const KIT = path.join(root, 'kit');
  const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
  const core = await import('./gate6chy-core.mjs');
  const B = await import('./gate6chy-b.mjs');
  const G = await import('./gate6crs-game.mjs');
  const D = await import('./gate7ak3-designs.mjs');
  const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };
  const runsOf = (flat) => { const out = []; for (let i = 0; i + 3 < (flat ?? []).length; i += 4) for (let y = flat[i + 2]; y <= flat[i + 3]; y++) out.push([flat[i], y, flat[i + 1]]); return out; };
  const spendZero = () => fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice GM is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
  const ensure = async () => { if (!L.state.dev) await L.connect(); };
  const flip = (at) => call('dev.pt.uses', { ops: [{ item: 'minecraft:stick', at, on: at, face: 'up' }] }, 30_000);

  // ------------------------------------------------------------------ gm-unit (offline)

  function nodeTest(files, timeout = 3_600_000) {
    const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
    const t = `${r.stdout}${r.stderr}`;
    const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
    return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
  }
  const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);

  steps.unit = async () => {
    const out = {};
    out.gm = kitOnce(['kit/test/gm-a.test.mjs', 'kit/test/gm.test.mjs']);
    check(out.gm.code === 0 && out.gm.fail === 0 && out.gm.pass >= 21, `item 1 (kit): gm-a and gm tests (the rungs and the base settled, the layouts behind every rung linted, levers-only a fixed point, the roles of every bible with no immovable leaf, the brief lines, the plan member, the artifact's mechanism and the envelope in the reserved cells, the IR write data, the graph state and movers, the siteplan schema, S-THEME on the mechanism, [11, 13] plain with deviation mechanism, NO_ROOM on a required wall, slide and swing, the stub, determinism): ${out.gm.pass} pass, ${out.gm.fail} fail`, out.gm.failing);
    out.k3 = kitOnce(['kit/test/k3.test.mjs', 'kit/test/plan-k1a.test.mjs', 'kit/test/k2.test.mjs', 'kit/test/region-lint.test.mjs']);
    check(out.k3.code === 0 && out.k3.fail === 0, `item 1 (kit): K3's, K1a's and K2's wall tests and the realise lint unchanged: ${out.k3.pass} pass, ${out.k3.fail} fail`, out.k3.failing);
    const lint = spawnSync(process.execPath, ['tools/lint.mjs', 'structure', '--only', 'p0:k3,p0:valid/1,p0:valid/2,p0:valid/3,p0:valid/4,p0:valid/5,p0:valid/6'], { cwd: root, encoding: 'utf8', timeout: 1_800_000 });
    out.lint = `${lint.stdout}${lint.stderr}`.trim().split('\n').slice(-16);
    check(lint.status === 0, 'item 1 (lint): the structure lint\'s p0:k3 and p0:valid (S-THEME clean with the new UNTHEMED_OK set)', out.lint);
    const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.join(root, '.gradle-home') };
    const j = spawnSync(path.join(root, 'mod', 'gradlew'), ['--offline', '--no-daemon', 'test', '--tests', 'dev.larattalabs.architect.region.GateMechTest', '--tests', 'dev.larattalabs.architect.api.ApiGMTest', '--tests', 'dev.larattalabs.architect.region.PlanChecksK3Test', '--tests', 'dev.larattalabs.architect.api.ApiK3Test', '--tests', 'dev.larattalabs.architect.site.LotMaskTest'], { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 });
    out.java = `${j.stdout}${j.stderr}`.trim().split('\n').slice(-6);
    check(j.status === 0, 'item 1 (Java): GateMechTest (the bind rule: roof at 10, at depth + 7, above it, a crenel gap, a block over the sensor; the plan\'s cells), ApiGMTest (the feature gateMechanisms), PlanChecksK3Test, ApiK3Test, LotMaskTest', out.java);
    const jars = [path.join(root, 'artifacts', 'gate6d-rv', 'jars'), path.join(root, '..', 'architect-mc', 'artifacts', 'gate6d-rv', 'jars')].find((d) => fs.existsSync(path.join(d, 'architect_apitest-0.47.0.jar')));
    out.compat = {};
    if (jars) for (const [name, args] of [['apitest 0.47.0', [path.join(jars, 'architect_apitest-0.47.0.jar')]], ['apitest 0.45.0', [path.join(jars, 'architect_apitest-0.45.0.jar')]], ['surface 0.47.0', ['--surface', path.join(jars, 'architect_mc-0.47.0.jar')]]]) {
      const c = spawnSync(process.execPath, ['tools/api-compat.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 1_800_000 });
      out.compat[name] = { status: c.status, tail: `${c.stdout}${c.stderr}`.trim().split('\n').slice(-4) };
    }
    check(!!jars && Object.values(out.compat).length === 3 && Object.values(out.compat).every((c) => c.status === 0), `item 1: api-compat clean against the archived 0.47.0 and 0.45.0 apitest jars and the 0.47.0 surface (${jars ? json(Object.fromEntries(Object.entries(out.compat).map(([k, v]) => [k, v.status]))) : 'no archived jars'})`, out.compat);
    spendZero();
    return out;
  };

  steps.unchanged = async () => {
    const K = await import('./gate7a-kit.mjs');
    const u = await K.unchanged(root, { check, log, base: 'GM', except: {}, mergedIf: 'kit/lib/connectors/gmGate.mjs' });
    fs.writeFileSync(path.join(OUT, 'gm-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
    return { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ };
  };

  // ------------------------------------------------------------------ in game

  async function kitK() {
    const kit = await imp('lib/kit.mjs');
    const style = await imp('lib/connectors/style.mjs');
    return { Blueprint: kit.Blueprint, palette: kit.palette, variant: kit.variant, shapeOf: style.shapeOf, doorOf: style.doorOf };
  }
  /** The stub designs of the castle's wall lots, the gatehouse's deck at `roof` (CONTRACT GM §15), in a bible's roles: {lot: entry}. */
  async function writeDesigns(lots, { tag, roof, bible = null }) {
    const K = await kitK();
    const { resolveRoles } = await imp('lib/region/plan.mjs');
    const { writeBlueprint } = await imp('lib/write.mjs');
    const roles = resolveRoles(bible ? JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'bibles', `${bible}.json`), 'utf8')).roles : {});
    const ids = {};
    for (const l of lots.filter((q) => q.onWall)) {
      const id = `gm_${tag}_${l.id}`.replace(/[^a-z0-9_]/g, '_').slice(0, 60);
      const bp = l.onWall.passage ? D.gatehouseDesign(K, id, l, roles, { roof }) : D.towerDesign(K, id, l, roles, { roof: !bible });
      const dir = path.join(L.LIBRARY, id);
      fs.rmSync(dir, { recursive: true, force: true });
      writeBlueprint(bp, dir);
      ids[l.id] = id;
    }
    await cmd('/architect reload');
    await L.settle(1500);
    return ids;
  }
  async function artifactLots(sha) {
    const a = await call('dev.region.artifact', { sha, body: true }, 120_000);
    const find = (o) => (o && typeof o === 'object' ? (Array.isArray(o.lots) && o.lots.some((l) => l?.onWall)) ? o.lots : Object.values(o).map(find).find(Boolean) : null);
    return find(a) ?? [];
  }
  const killMobs = () => cmd('/kill @e[type=!minecraft:player]');
  const waitPlaced = (region) => L.waitRegion(region, 3_600_000, async (x) => { if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(x?.waiting?.reason)) await killMobs(); });

  /** A castle fixture checked and realised with the stub designs: {s, ck, sha, lots, gl, m, region, st, pre, box}. */
  async function castle(name, { tag, roof, creative = true, realise = true, bible = null } = {}) {
    const fx = G.fixture(ctx, `gm/${name}`);
    const s = await G.site(ctx, `gm ${tag}`, fx, { creative });
    await G.designs(ctx);
    await cmd('/time set 6000');
    await cmd('/weather clear');
    const ck = await call('dev.region.checkPlan', { plan: s.wp.plan, claim: s.W.claim, owner: G.OWNER, anchors: s.wp.anchors, load: 'generate', ...(bible ? { bible } : {}) }, 1_800_000);
    fs.writeFileSync(path.join(OUT, `gm-${tag}-check.json`), `${JSON.stringify(ck, null, 1)}\n`);
    const sha = ck.check?.artifactSha;
    const lots = sha ? await artifactLots(sha) : [];
    const gl = lots.find((l) => l.id === 'gatehouse_1');
    const m = gl?.onWall?.passage?.mechanism ?? null;
    const box = G.boxOf(s.W);
    box[4] = Math.max(box[4], s.W.maxY + 48);
    const out = { fx, s, ck, sha, lots, gl, m, box };
    if (!realise || !sha) return out;
    out.ids = await writeDesigns(lots, { tag, roof, bible });
    out.entries = { ...fx.lotEntries, ...out.ids };
    out.pre = await G.snap(ctx, box, `gm-${tag}-pre`);
    out.beforeDump = path.join(OUT, `gm-${tag}-before.arwd.gz`);
    await call('dev.region.dump', { box, file: out.beforeDump }, 1_800_000);
    await killMobs();
    out.region = await G.realise(ctx, sha, out.entries);
    out.st = await waitPlaced(out.region);
    await L.settle(3000);
    return out;
  }

  /** The gate's state from the world: the lane cells (closed: a leaf in each; open: air), the recess, the levers, the sensor. */
  function gateCells(m) {
    const open = new Set(runsOf(m.states.open).map((c) => c.join(',')));
    const lanes = runsOf(m.states.closed).filter((c) => !open.has(c.join(',')));
    return { lanes, recess: runsOf(m.states.open), levers: m.triggers.filter((t) => t.kind === 'lever').map((t) => t.at), rungs: m.triggers.find((t) => t.kind === 'daylight')?.rungs ?? [] };
  }
  async function readGate(m) {
    const g = gateCells(m);
    const st = [];
    for (const c of g.lanes) st.push(await stateAt(...c));
    const filled = st.filter((s) => s !== 'air' && !/^(minecraft:)?air$/.test(s)).length;
    return { open: filled === 0, closed: filled === g.lanes.length, filled, of: g.lanes.length, moving: st.some((s) => /moving_piston|piston_head/.test(s)) };
  }
  /** A box's states (the envelope's bounding box) for the no-move check. */
  function envBox(m) {
    const c = runsOf(m.cells);
    const xs = c.map((q) => q[0]), ys = c.map((q) => q[1]), zs = c.map((q) => q[2]);
    return [Math.min(...xs), Math.min(...ys), Math.min(...zs), Math.max(...xs), Math.max(...ys), Math.max(...zs)];
  }
  const flipW = async (at) => { await flip(at); await L.gameWait(1500, { real: L.settle, label: 'gm flip' }); };
  const timeW = async (t) => { await cmd(`/time set ${t}`); await L.gameWait(3000, { real: L.settle, label: 'gm sensor ticks' }); };

  /** Lever (useItemOn) to leaves settled, tick by tick under /tick freeze: {ticks, first, settled}. */
  async function leverTrace(m, at, want) {
    await freeze();
    await flip(at);
    let first = null, t = 0;
    for (t = 1; t <= 60; t++) {
      await step(1);
      const g = await readGate(m);
      if (first === null && (g.moving || g.filled !== (want === 'open' ? gateCells(m).lanes.length : 0))) first = t;
      if (!g.moving && (want === 'open' ? g.open : g.closed)) break;
    }
    await unfreeze();
    return { ticks: t, first, ok: t <= 60 };
  }

  /** Vanilla villager paths and the kit's player walk through the passage, inside to outside (the back port to beyond the front port). */
  async function crossings(gl, box, s, tag, beforeDump) {
    const ps = gl.onWall.passage;
    const out = {};
    const v = await call('dev.nav.villager', { from: ps.back, to: ps.front, range: 128 }, 120_000);
    const v2 = await call('dev.nav.villager', { from: ps.front, to: ps.back, range: 128 }, 120_000);
    out.villager = [!!v.canReach, !!v2.canReach];
    // the kit's player and villager walks over a dump of the box (no lot box an obstacle: the designs' own blocks are judged)
    const { decodeArwd, dumpWorld } = await imp('lib/region/vworld.mjs');
    const { walkGraph, nodeReached } = await imp('lib/region/check.mjs');
    const f = path.join(OUT, `gm-${tag}-walk.arwd.gz`);
    await call('dev.region.dump', { box, file: f }, 1_800_000);
    const d = await decodeArwd(fs.readFileSync(f));
    const d0 = await decodeArwd(fs.readFileSync(beforeDump));
    const claim = { minX: s.W.claim[0], minZ: s.W.claim[1], maxX: s.W.claim[2], maxZ: s.W.claim[3], minY: box[1], maxY: box[4] };
    // (the pristine dump as the base: the written columns are walked from their lowest written cell, as the realised check does)
    const world = dumpWorld(d0, d, claim);
    for (const mover of ['player', 'villager']) {
      const g = walkGraph(world, [ps.back], { mover });
      out[`kit_${mover}`] = nodeReached(g, ps.front);
    }
    return out;
  }

  /** The day cycle (§2a) on a realised gate: the 13 steps of gm-fit, through real lever uses. */
  async function dayCycle(m, tag) {
    const [A, Bv] = gateCells(m).levers;
    const rows = [];
    const note = async (what, want) => { const g = await readGate(m); const ok = want === 'closed' ? g.closed : g.open; rows.push({ what, want, ok, filled: g.filled }); log(`  ${tag} ${what}: ${ok ? 'ok' : 'WRONG'} (${g.filled}/${g.of} lane cells filled)`); return ok; };
    await note('rest at day', 'open');
    await flipW(A); await note('day, the outside lever -> override closed', 'closed');
    await flipW(A); await note('day, the outside lever again -> open', 'open');
    await flipW(Bv); await note('day, the inside lever -> closed', 'closed');
    await flipW(A); await note('day, the outside lever -> open (either lever toggles)', 'open');
    await timeW(14000); await note('dusk, no override -> closed', 'closed');
    await timeW(1000); await note('dawn -> open', 'open');
    await flipW(Bv); await note('day, the inside lever -> override closed', 'closed');
    await timeW(14000); await note('dusk with a closed override -> closed (the sensor takes over)', 'closed');
    await flipW(A); await note('night, the outside lever -> override open', 'open');
    await timeW(1000); await note('dawn with an open override -> open (override cleared)', 'open');
    await flipW(A); await note('day after the reset, the outside lever -> closed (a fresh override)', 'closed');
    await flipW(Bv); await note('day, the inside lever -> open', 'open');
    return rows;
  }

  /** 20 cycles through each lever by real use (the levers alternating), the leaves checked after each flip. */
  async function cycles(m, n = 20) {
    const [A, Bv] = gateCells(m).levers;
    let bad = 0, firstBad = null;
    for (let c = 1; c <= n; c++) {
      await flipW(c % 2 ? A : Bv); const a = await readGate(m);
      await flipW(c % 2 ? Bv : A); const b = await readGate(m);
      if (!(a.closed && b.open)) { bad++; firstBad ??= { c, a, b }; }
    }
    return { n, bad, firstBad };
  }

  /** No block in the envelope's box moves in the 40 ticks after the realise (a day realise; under /tick freeze, then 40 steps). */
  async function still(m, tag) {
    const b = envBox(m);
    await freeze();
    const f0 = await G.snap(ctx, b, `gm-${tag}-still`);
    await step(40);
    const d = await G.diff(ctx, b, f0);
    await unfreeze();
    return { box: b, mismatches: d.mismatches, list: d.list.slice(0, 8) };
  }

  /** The sensor's cell, the levers-only deviation and the dropped count from the region's ext and the lot site. */
  async function report(region) {
    const st = await call('dev.region.state', { region }, 60_000);
    const ext = st.view?.ext ?? st.record?.ext ?? {};
    return ext['architect_mc:gateMechanism']?.gatehouse_1 ?? null;
  }

  const GM_CASES = [
    // [fixture, tag, stub roof row, kind, expect]
    ['gm_castle_17x15', 'p17x15', 12, 'portcullis', { rung: 12 }],
    ['gm_castle_13x7', 'p13x7', 10, 'portcullis', { rung: 10 }],
    ['gm_castle_13x7', 'p13x7hi', 16, 'portcullis', { leversOnly: true }],
    ['gm_castle_slide', 'slide', 11, 'slide', { rung: 11 }],
  ];

  steps.ingame = async () => {
    await ensure();
    await L.leaveWorld().catch(() => null);
    const out = {};
    const only = process.env.GM_INGAME_ONLY ? new Set(process.env.GM_INGAME_ONLY.split(',')) : null;
    for (const [name, tag, roof, kind, want] of GM_CASES) {
      if (only && !only.has(tag)) continue;
      const rec = {};
      out[tag] = rec;
      const c = await castle(name, { tag, roof });
      const w = (c.ck.check?.parts ?? []).find((a) => a.part === 'curtain_wall');
      rec.check = { overall: c.ck.check?.overall, wall: w?.class, mechanism: w?.geometry?.wallLots?.find((q) => q.lot === 'gatehouse_1')?.passage?.mechanism ?? null };
      check(c.ck.check?.overall === 'READY' && !!c.m && c.m.kind === kind, `${tag}: ${name} checks READY through Regions.checkPlan, the gatehouse's passage carries its ${kind} (${json(rec.check)})`);
      if (!c.region) { await L.leaveWorld(); continue; }
      rec.state = c.st.view.state;
      check(c.st.view.state === 'PLACED', `${tag}: realiseApproved with the GM stub designs (the gatehouse's deck at row ${roof}): ${c.st.view.state}`);
      rec.report = await report(c.region);
      const g = gateCells(c.m);
      const sensors = [];
      for (const r of g.rungs) if (/daylight_detector/.test(await stateAt(...r))) sensors.push(r);
      rec.sensors = sensors;
      if (want.leversOnly) {
        check(rec.report?.deviation === 'mechanism.sensor' && sensors.length === 0, `${tag}: a roof above depth + 7 (row ${roof}): levers-only, deviation mechanism.sensor, no sensor block on any rung (${json(rec.report)}, ${sensors.length} sensors)`);
      } else {
        const r0 = c.gl.onWall.floorY + want.rung;
        check(rec.report?.roof === r0 && sensors.length === 1 && sensors[0][1] === r0, `${tag}: the sensor at its rung (roof row ${want.rung}, y ${r0}), one sensor block (${json(rec.report)}, ${json(sensors)})`);
      }
      rec.still = await still(c.m, tag);
      check(rec.still.mismatches === 0, `${tag}: no block in the mechanism's box moves in the 40 ticks after a day realise (${rec.still.mismatches} differ)`, rec.still.list);
      const g0 = await readGate(c.m);
      check(g0.open, `${tag}: at rest by day the gate is open (${g0.filled}/${g0.of} lane cells filled)`);
      rec.trace = { close: await leverTrace(c.m, g.levers[0], 'closed'), open: await leverTrace(c.m, g.levers[0], 'open') };
      log(`  ${tag} lever to settled leaves: close ${json(rec.trace.close)} open ${json(rec.trace.open)}`);
      check(rec.trace.close.ok && rec.trace.open.ok, `${tag}: the outside lever (a real use) closes and opens the gate (lever to settled leaves: ${rec.trace.close.ticks} and ${rec.trace.open.ticks} ticks, recorded)`);
      // closed: the passage blocks the villager (vanilla and the kit's) and the player; open: both pass
      await flipW(g.levers[0]);
      rec.closed = await crossings(c.gl, c.box, c.s, `${tag}-closed`, c.beforeDump);
      await flipW(g.levers[0]);
      rec.open = await crossings(c.gl, c.box, c.s, `${tag}-open`, c.beforeDump);
      check(!rec.closed.villager[0] && !rec.closed.villager[1] && !rec.closed.kit_player && !rec.closed.kit_villager, `${tag}: closed, the passage blocks vanilla's villager both ways and the kit's player and villager walks (${json(rec.closed)})`);
      check(rec.open.villager[0] && rec.open.villager[1] && rec.open.kit_player && rec.open.kit_villager, `${tag}: open, vanilla's villager and the kit's walks pass both ways (${json(rec.open)})`);
      rec.cycles = await cycles(c.m, 20);
      check(rec.cycles.bad === 0, `${tag}: 20 cycles through the two levers by real use, ${rec.cycles.bad} with a misplaced leaf`, rec.cycles.firstBad);
      if (!want.leversOnly) {
        rec.day = await dayCycle(c.m, tag);
        check(rec.day.every((x) => x.ok), `${tag}: the day cycle (§2a): ${rec.day.filter((x) => x.ok).length}/${rec.day.length} steps (dusk closes, dawn opens, either lever overrides until the next transition)`, rec.day.filter((x) => !x.ok));
      } else {
        // levers-only: dusk does not close it (no sensor), the levers still toggle
        await timeW(14000);
        const n = await readGate(c.m);
        await timeW(6000);
        check(n.open, `${tag}: levers-only, dusk leaves the gate open (no sensor; ${n.filled}/${n.of})`);
      }
      const it0 = await items(...c.gl.onWall.passage.front, 24);
      rec.items = { stacks: it0.stacks ?? 0, items: it0.items ?? null };
      check(!rec.items.stacks, `${tag}: no item dropped while it ran (${json(rec.items)})`);
      // removal of the realised castle (open), E-flat 0
      await cmd('/kill @e[type=minecraft:item]');
      const rm = await G.remove(ctx, c.region);
      const d = await G.diff(ctx, c.box, c.pre);
      const it1 = await items(...c.gl.onWall.passage.front, 24);
      rec.eflat = { removed: rm.removed, mismatches: d.mismatches, list: d.list.slice(0, 12), items: { stacks: it1.stacks ?? 0, items: it1.items ?? null } };
      check(rm.removed && d.mismatches === 0, `${tag}: Regions.remove (the gate open): E-flat ${d.mismatches} over the claim`, d.list.slice(0, 8));
      check(!rec.eflat.items.stacks, `${tag}: the removal dropped no item (${json(rec.eflat.items)})`);
      await L.leaveWorld();
    }
    // the [11, 13] gatehouse: the plain passage, deviation mechanism
    if (!only || only.has('plain')) {
      const c = await castle('gm_castle_11x13', { tag: 'plain', roof: 10, realise: false });
      const w = (c.ck.check?.parts ?? []).find((a) => a.part === 'curtain_wall');
      out.plain = { overall: c.ck.check?.overall, wall: w?.class, deviations: w?.deviations, mechanism: c.m };
      check(c.ck.check?.overall === 'READY' && w?.class === 'adjusted' && (w.deviations ?? []).some((x) => x.what === 'mechanism' && x.lot === 'gatehouse_1' && x.need === 13) && !c.m, `plain: the [11, 13] gatehouse (11 along the wall) keeps the plain passage, deviation mechanism (${json(w?.deviations?.filter((x) => x.what === 'mechanism'))})`);
      await L.leaveWorld();
    }
    // swing: the button (a real use) opens, the plate (a villager on it) opens, the inside lever holds it
    if (!only || only.has('swing')) out.swing = await swing();
    spendZero();
    return out;
  };

  async function swing() {
    const rec = {};
    const c = await castle('gm_castle_swing', { tag: 'swing', roof: 9 });
    check(c.st?.view?.state === 'PLACED' && c.m?.kind === 'swing', `swing: realised (${c.st?.view?.state})`);
    if (!c.region) { await L.leaveWorld(); return rec; }
    const doors = runsOf(c.m.states.closed).filter((q) => q[1] === c.gl.onWall.floorY);
    const doorOpen = async () => { let n = 0; for (const q of doors) if (/open=true/.test(await stateAt(...q))) n++; return n; };
    rec.rest = await doorOpen();
    check(rec.rest === 0, `swing: at rest the iron doors are shut (${rec.rest} open)`);
    const btn = c.m.triggers.find((t) => t.kind === 'button').at, lever = c.m.triggers.find((t) => t.kind === 'lever').at, plate = c.m.triggers.find((t) => t.kind === 'plate').at;
    let bad = 0;
    for (let i = 0; i < 20; i++) {
      await flip(btn);
      await L.gameWait(400, { real: L.settle, label: 'button' });
      const o = await doorOpen();
      await L.gameWait(2500, { real: L.settle, label: 'button releases' });
      const s2 = await doorOpen();
      if (o !== doors.length || s2 !== 0) bad++;
    }
    rec.button = { n: 20, bad };
    check(bad === 0, `swing: 20 button presses by real use: the doors open, then shut when it releases (${bad} wrong)`);
    await flipW(lever);
    rec.lever = await doorOpen();
    await flipW(lever);
    rec.leverOff = await doorOpen();
    check(rec.lever === doors.length && rec.leverOff === 0, `swing: the inside lever holds the doors open, and off shuts them (${rec.lever}, ${rec.leverOff})`);
    await cmd(`/summon minecraft:villager ${plate[0] + 0.5} ${plate[1]} ${plate[2] + 0.5} {NoAI:1b}`);
    await L.gameWait(1000, { real: L.settle, label: 'plate' });
    rec.plate = await doorOpen();
    await killMobs();
    await L.gameWait(2000, { real: L.settle, label: 'plate releases' });
    check(rec.plate >= 1, `swing: a villager on the inside plate opens the doors (${rec.plate} open)`);
    const rm = await G.remove(ctx, c.region);
    const d = await G.diff(ctx, c.box, c.pre);
    rec.eflat = { removed: rm.removed, mismatches: d.mismatches, list: d.list.slice(0, 12) };
    check(rm.removed && d.mismatches === 0, `swing: Regions.remove: E-flat ${d.mismatches}`, d.list.slice(0, 8));
    await L.leaveWorld();
    return rec;
  }

  // ------------------------------------------------------------------ undo (item 4; the verifier re-runs it)

  steps.undo = async () => {
    await ensure();
    await L.leaveWorld().catch(() => null);
    const out = {};
    for (const mode of ['open', 'closed', 'midmove', 'lane']) {
      const c = await castle('gm_castle_13x7', { tag: `undo-${mode}`, roof: 10 });
      if (!c.region) { check(false, `undo ${mode}: no region`); await L.leaveWorld(); continue; }
      const g = gateCells(c.m);
      const rec = { mode };
      if (mode === 'closed') { await flipW(g.levers[0]); rec.gate = await readGate(c.m); }
      if (mode === 'lane') {
        // (§7 items 7-8) a player's block in a lane (placed by a real use on the lane's floor), then the gate closed: the leaf shoves it
        // and the mullion along the plane d = 1, inside u in [-4, 4]; the removal restores the envelope (the box comes back exactly)
        const lane = g.lanes.find((q) => q[1] === c.gl.onWall.floorY);
        await call('dev.pt.uses', { ops: [{ item: 'minecraft:cobblestone', at: lane, on: [lane[0], lane[1] - 1, lane[2]], face: 'up' }] }, 30_000);
        rec.placed = await stateAt(...lane);
        await flipW(g.levers[0]);
        rec.gate = await readGate(c.m);
        const env = new Set(runsOf(c.m.cells).map((q) => q.join(',')));
        const bb = envBox(c.m);
        const out = [];
        for (let x = bb[0] - 1; x <= bb[3] + 1; x++) for (let z = bb[2] - 1; z <= bb[5] + 1; z++) {
          const k = `${x},${lane[1]},${z}`;
          if (!env.has(k) && /cobblestone/.test(await stateAt(x, lane[1], z))) out.push(k);
        }
        rec.leaked = out;
        check(/cobblestone/.test(rec.placed) && out.length === 0, `item 4 (lane): a player's cobblestone in a lane, the gate closed: nothing shoved out of the envelope (${json(rec.gate)}, outside: ${out.length})`);
      }
      if (mode === 'midmove') {
        // the lever flipped under /tick freeze, stepped to the first tick a leaf moves, then removed with the clock running
        await freeze();
        await flip(g.levers[0]);
        let t = 0, gs = null;
        for (t = 1; t <= 60; t++) { await step(1); gs = await readGate(c.m); if (gs.moving || gs.filled > 0) break; }
        rec.movingAt = t; rec.gate = gs;
        await step(1);
        rec.gate2 = await readGate(c.m);
        await unfreeze();
      }
      await cmd('/kill @e[type=minecraft:item]');
      const rm = await G.remove(ctx, c.region);
      const d = await G.diff(ctx, c.box, c.pre);
      rec.eflat = { removed: rm.removed, mismatches: d.mismatches, list: d.list.slice(0, 16), classes: d.classes };
      const it1 = await items(...c.gl.onWall.passage.front, 24);
      rec.items = { stacks: it1.stacks ?? 0, items: it1.items ?? null };
      out[mode] = rec;
      check(rm.removed && d.mismatches === 0, `item 4 (${mode}${mode === 'midmove' ? `, removed ${rec.movingAt + 1} ticks into a toggle (moving ${rec.gate2?.moving})` : ''}): Regions.remove E-flat ${d.mismatches} over the claim`, d.list.slice(0, 8));
      check(!rec.items.stacks, `item 4 (${mode}): no item dropped by the removal (${json(rec.items)})`);
      await L.leaveWorld();
    }
    spendZero();
    return out;
  };

  // ------------------------------------------------------------------ the look (client; recorded, Noah approves: N-GM-1)

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
    const r = await call('dev.screenshot', { name: `gm_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
    const dir = path.join(OUT, 'look');
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, `${name}.png`);
    fs.copyFileSync(r.path, dst);
    return { name, eye, at, file: dst, width: r.width, height: r.height };
  }

  steps.look = async () => {
    await ensure();
    await L.leaveWorld().catch(() => null);
    const out = { shots: [], runs: {} };
    for (const b of LOOK_BIBLES) if (b) installBible(b);
    const kinds = (process.env.GM_LOOK_KINDS ?? 'portcullis,slide,swing').split(',');
    const fxOf = { portcullis: ['gm_castle_17x15', 12], slide: ['gm_castle_slide', 11], swing: ['gm_castle_swing', 9] };
    for (const bible of LOOK_BIBLES) for (const kind of kinds) {
      const btag = bible ? bible.replace(/^g7ak1_/, '') : 'default';
      const tag = `${kind}_${btag}`;
      const [name, roof] = fxOf[kind];
      const c = await castle(name, { tag: `look-${tag}`, roof, bible });
      out.runs[tag] = { state: c.st?.view?.state ?? null, kind: c.m?.kind ?? null };
      check(c.st?.view?.state === 'PLACED', `look (${tag}): realised (recorded, Noah approves: N-GM-1)`);
      if (!c.region) { await L.leaveWorld(); continue; }
      const ps = c.gl.onWall.passage;
      const [fx0, fy, fz] = ps.front, [bx, , bz] = ps.back;
      const ox = Math.sign(fx0 - bx), oz = Math.sign(fz - bz);
      const sx = oz, sz = ox; // across the passage
      const g = gateCells(c.m);
      const road = [fx0 + ox * 14 + 0.5, fy + 4, fz + oz * 14 + 0.5], gate = [fx0 + 0.5, fy + 2, fz + 0.5];
      const toggle = async () => { if (kind === 'swing') await flip(c.m.triggers.find((t) => t.kind === 'lever').at); else await flip(g.levers[0]); };
      out.shots.push(await shot(`${tag}_open`, road, gate));
      await toggle(); await L.gameWait(1500, { real: L.settle, label: 'toggle' });
      out.shots.push(await shot(`${tag}_closed`, road, gate));
      await toggle(); await L.gameWait(1500, { real: L.settle, label: 'toggle' });
      out.shots.push(await shot(`${tag}_passage_inside`, [bx - ox * 2 + 0.5, fy + 1.6, bz - oz * 2 + 0.5], [fx0 + 0.5, fy + 1.4, fz + 0.5]));
      if (kind !== 'swing') {
        const lv = g.levers[0];
        out.shots.push(await shot(`${tag}_lever`, [lv[0] + ox * 2.5 + sx * 1.5 + 0.5, lv[1] - 0.5, lv[2] + oz * 2.5 + sz * 1.5 + 0.5], [lv[0] + 0.5, lv[1] + 0.3, lv[2] + 0.5]));
        // the toggle strip: the leaves sliding into the jambs, frame by frame under /tick freeze
        await freeze();
        await flip(g.levers[0]);
        const strip = [];
        for (let t = 0; t < 8; t++) { await step(2); strip.push(await shot(`${tag}_strip_${t}`, road, gate)); }
        await unfreeze();
        out.shots.push(...strip);
        await flipW(g.levers[0]);
        if (!bible) {
          // dusk: the gate closing, and the sensor cell on the roof
          await cmd('/time set 13000');
          await L.gameWait(3000, { real: L.settle, label: 'dusk' });
          out.shots.push(await shot(`${tag}_dusk`, road, gate));
          const sn = c.m.triggers.find((t) => t.kind === 'daylight');
          const rep = await report(c.region);
          const sc = rep?.sensor ?? sn.at;
          out.shots.push(await shot(`${tag}_sensor`, [sc[0] + ox * 6 + sx * 4 + 0.5, sc[1] + 5, sc[2] + oz * 6 + sz * 4 + 0.5], [sc[0] + 0.5, sc[1], sc[2] + 0.5]));
          await cmd('/time set 6000');
        }
      } else {
        await flip(c.m.triggers.find((t) => t.kind === 'button').at);
        const strip = [];
        for (let t = 0; t < 4; t++) strip.push(await shot(`${tag}_strip_${t}`, road, gate));
        out.shots.push(...strip);
      }
      await call('dev.release', {}).catch(() => null);
      await L.leaveWorld();
    }
    fs.mkdirSync(path.join(OUT, 'look'), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'look', 'look.json'), JSON.stringify(out, null, 2));
    spendZero();
    return out;
  };

  steps.areport = async () => {
    const rows = ['| step | result | head |', '|---|---|---|'];
    for (const s of ['unit', 'unchanged', 'ingame', 'undo', 'look']) {
      const f = path.join(OUT, `${s}.json`);
      if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const res = Object.entries(j.results ?? {});
      const bad = res.filter(([, r]) => !r.ok);
      rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
      for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
    }
    fs.writeFileSync(path.join(OUT, 'REPORT-GM-a.md'), `# GM-a gate\n\n${rows.join('\n')}\n`);
    return { rows: rows.length };
  };
  void execFileSync;
}
