// (6d LCi) The in-game coverage slice LC shipped without (docs/CONTRACT.md "Slice LC as built", Open (1); "Slice LCi as built"), as two
// steps of tools/gate6dlc.mjs (headless, $0):
//
//   castle    (lc-castle)    items 1 and 2 on gm_castle_13x7 (creative: a K3 castle, its K2 walk wall, four towers and a gatehouse with
//                            a GM portcullis): the fresh castle reports no change; the gate open, closed (the lever powered, the pistons
//                            extended), mid-move (moving pistons, under /tick freeze) and closed by the sensor at dusk: the same report
//                            each time; a player's block in an open lane is the player's (§2); a player who mines a piston is `removed`
//                            in `mech:gatehouse_1`; the wall: player breaks `removed` in the wall's part (by the kit's writers), a broken
//                            wall cell re-filled by the player `playerPlaced`, a block on a cell the region never wrote not reported; a
//                            tower's broken and re-filled cells in its LotLand row (its standing lower); each landCheck writes nothing
//   survival  (lc-survival)  item 3 on rs02_walled (survival, RS's half-fed fixture): mid-build (some targets built, some waiting) and
//                            fully built: no change on either; a player's block on a waiting cell is not land change (the target has
//                            not built it); a paid block taken up from a built target is `removed` in its part (and the target stays
//                            built); re-filled by the player `playerPlaced`; a lot's broken cell in its LotLand row
//
// Expected numbers come from the world (dumps before and after each change), the kit's writers (the castle's tile parts), RS's targets
// (dev.rs.cells: a target's part and its cells) and the journal's stacks (dev.journal.at), never from LandCheck's own code.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Registers `castle` and `survival` on `steps`. `h`: the driver's helpers {L, call, check, cmd, log, OUT, json, imp, norm, idOf, AIRS,
 * partsOracle, landCheck, noWrite, strip, listing, listDiff, spendZero, ensure}.
 */
export async function registerLC2(steps, h) {
  const { L, call, check, cmd, log, OUT, json, imp, norm, idOf, AIRS, partsOracle, landCheck, noWrite, strip, listing, listDiff, spendZero, ensure } = h;
  const root = L.root;
  const KIT = path.join(root, 'kit');
  const core = await import('./gate6chy-core.mjs');
  const B = await import('./gate6chy-b.mjs');
  const G = await import('./gate6crs-game.mjs');
  const D = await import('./gate7ak3-designs.mjs');
  const { gameTime } = await import('./sprint.mjs');
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const runsOf = (flat) => { const out = []; for (let i = 0; i + 3 < (flat ?? []).length; i += 4) for (let y = flat[i + 2]; y <= flat[i + 3]; y++) out.push([flat[i], y, flat[i + 1]]); return out; };
  const key = (c) => `${c[0]},${c[1]},${c[2]}`;
  const isAir = (s) => AIRS.has(idOf(norm(s ?? 'minecraft:air')));

  // ------------------------------------------------------------------ world reads

  /** A box's states from a dump: a getter "x,y,z" -> canonical state (outside the box: undefined). */
  async function dumpOf(box, name) {
    const f = path.join(OUT, `${name}.arwd.gz`);
    await call('dev.region.dump', { box, file: f }, 1_800_000);
    const d = await decodeArwd(fs.readFileSync(f));
    const get = (k) => {
      const [x, y, z] = String(k).split(',').map(Number);
      if (x < d.box.minX || x > d.box.maxX || y < d.box.minY || y > d.box.maxY || z < d.box.minZ || z > d.box.maxZ) return undefined;
      return norm(d.palette[d.cells[d.at(x, y, z)]]);
    };
    return { get, box: d.box };
  }
  const stateAt = async (c) => (await dumpOf([c[0], c[1], c[2], c[0], c[1], c[2]], 'cell')).get(key(c)) ?? 'minecraft:air';
  /** The changed cells of a box between two dumps: [[key, before, after]]. */
  async function changed(box, before, name) {
    const after = await dumpOf(box, name);
    const out = [];
    for (let x = box[0]; x <= box[3]; x++) for (let y = box[1]; y <= box[4]; y++) for (let z = box[2]; z <= box[5]; z++) {
      const k = `${x},${y},${z}`;
      if (before.get(k) !== after.get(k)) out.push([k, before.get(k), after.get(k)]);
    }
    return { list: out, after };
  }
  const around = (c, r = 2) => [c[0] - r, c[1] - r, c[2] - r, c[0] + r, c[1] + r, c[2] + r];
  /** The cell's journal stack (bottom first) and its top entry of `group` (ACTIVE). */
  async function topOf(c, group) {
    const r = await call('dev.journal.at', { x: c[0], y: c[1], z: c[2] }, 30_000);
    const st = r.stack ?? r.entries ?? [];
    const top = st.at(-1) ?? null;
    return { stack: st, top, ours: !!top && top.group === group && /ACTIVE/i.test(String(top.status ?? 'ACTIVE')) };
  }
  /** Columns' journal stacks: "x,y,z" -> top entry {group, site, entry, layer}. */
  async function tops(cols) {
    const out = new Map();
    for (let i = 0; i < cols.length; i += 64) {
      const st = await call('dev.journal.columns', { runs: cols.slice(i, i + 64).map(([x, z]) => [x, z, x, z]) }, 120_000);
      for (const c of st.cells ?? []) out.set(`${c.x},${c.y},${c.z}`, c.stack.at(-1));
    }
    return out;
  }
  // (an attached or falling block beside a cell to break would change more than the cell itself: such cells are not picked)
  const LOOSE = /torch|lantern|door|pane|bars|redstone|repeater|comparator|lever|button|pressure_plate|rail|carpet|ladder|sign|banner|flower|grass$|fern|bush|sapling|sand$|gravel|concrete_powder|anvil|bed|vine|snow|chain|bell|campfire|candle|pot|sensor|piston|tripwire|scaffolding|torchflower|lily|kelp|seagrass|cactus|cane|bamboo|crop|wheat|carrot|potato|beetroot|stem|button|_wall_|hanging/;
  const loose = (s) => LOOSE.test(idOf(norm(s ?? '')));
  /** A cell whose break leaves its neighbours as they stand: itself solid and not loose, nothing loose beside or on it. */
  async function quiet(c, get = null) {
    const g = get ?? (await dumpOf(around(c, 1), 'quiet')).get;
    const s = g(key(c));
    if (!s || isAir(s) || loose(s)) return false;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (loose(g(key([c[0] + dx, c[1] + dy, c[2] + dz])))) return false;
    return true;
  }
  const breaks = (at) => call('dev.pt.breaks', { at, placer: 'LCAlex' }, 600_000);
  const places = async (ops) => (await call('dev.pt.uses', { ops: ops.map(([c, item]) => ({ item, at: c.slice(0, 3), placer: 'LCAlex' })) }, 600_000)).results ?? [];
  const flip = (at) => call('dev.pt.uses', { ops: [{ item: 'minecraft:stick', at, on: at, face: 'up' }] }, 30_000);
  const ptCount = async (box) => (await call('dev.pt.cells', { box }, 60_000)).tracked ?? null;

  // ------------------------------------------------------------------ report arithmetic

  const ZERO = { cells: 0, changed: 0, removed: 0, playerPlaced: 0, volatileChanged: 0 };
  const row = (r, p) => r.parts.find((q) => q.part === p) ?? null;
  const lot = (r, id) => r.lots.find((q) => q.lot === id) ?? null;
  const counts = (p) => ({ changed: p.changed, removed: p.removed, playerPlaced: p.playerPlaced, volatileChanged: p.volatileChanged });
  const anyChange = (r) => r.parts.filter((p) => p.changed + p.removed + p.playerPlaced + p.volatileChanged).map((p) => [p.part, p.removed, p.playerPlaced, p.changed, p.volatileChanged])
    .concat(r.lots.filter((l) => l.changed + l.playerPlaced).map((l) => [`lot:${l.lot}`, l.changed, l.playerPlaced]));
  /** Two reports equal in every count (parts with their cells, lots with standing): [ok, the rows that differ]. */
  function same(a, b) {
    const diff = [];
    const pk = new Set([...a.parts.map((p) => p.part), ...b.parts.map((p) => p.part)]);
    for (const p of pk) {
      const x = row(a, p), y = row(b, p);
      const fx = x ? { cells: x.cells, ...counts(x), kinds: x.kinds } : null;
      const fy = y ? { cells: y.cells, ...counts(y), kinds: y.kinds } : null;
      if (json(fx) !== json(fy)) diff.push({ part: p, a: fx, b: fy });
    }
    const lk = new Set([...a.lots.map((l) => l.lot), ...b.lots.map((l) => l.lot)]);
    for (const l of lk) {
      const x = lot(a, l), y = lot(b, l);
      const fx = x && { changed: x.changed, playerPlaced: x.playerPlaced, standing: x.standing }, fy = y && { changed: y.changed, playerPlaced: y.playerPlaced, standing: y.standing };
      if (json(fx) !== json(fy)) diff.push({ lot: l, a: fx, b: fy });
    }
    if (a.unloaded !== b.unloaded || a.cellsChecked !== b.cellsChecked) diff.push({ cellsChecked: [a.cellsChecked, b.cellsChecked], unloaded: [a.unloaded, b.unloaded] });
    return [diff.length === 0, diff];
  }
  /**
   * `got` equals `base` plus `delta` ({parts: {part: {removed, playerPlaced, changed, kinds}}, lots: {lot: {changed, playerPlaced}}}),
   * every other part and lot as in `base` (standing aside: compared by the caller); [ok, the rows that differ].
   */
  function plusDelta(got, base, delta) {
    const diff = [];
    const pk = new Set([...got.parts.map((p) => p.part), ...base.parts.map((p) => p.part), ...Object.keys(delta.parts ?? {})]);
    for (const p of pk) {
      const g = row(got, p), b = row(base, p) ?? { ...ZERO, kinds: {} }, d = delta.parts?.[p] ?? {};
      const want = { changed: b.changed + (d.changed ?? 0), removed: b.removed + (d.removed ?? 0), playerPlaced: b.playerPlaced + (d.playerPlaced ?? 0), volatileChanged: b.volatileChanged };
      const wk = { ...(b.kinds ?? {}) };
      for (const [k, v] of Object.entries(d.kinds ?? {})) wk[k] = (wk[k] ?? 0) + v;
      const sortK = (o) => json(Object.fromEntries(Object.entries(o ?? {}).sort()));
      const ok = !!g && json(counts(g)) === json(want) && sortK(g.kinds) === sortK(wk);
      if (!ok) diff.push({ part: p, got: g && { ...counts(g), kinds: g.kinds }, want: { ...want, kinds: wk } });
    }
    const lk = new Set([...got.lots.map((l) => l.lot), ...base.lots.map((l) => l.lot)]);
    for (const l of lk) {
      const g = lot(got, l), b = lot(base, l) ?? { changed: 0, playerPlaced: 0 }, d = delta.lots?.[l] ?? {};
      const want = { changed: b.changed + (d.changed ?? 0), playerPlaced: b.playerPlaced + (d.playerPlaced ?? 0) };
      if (!g || g.changed !== want.changed || g.playerPlaced !== want.playerPlaced) diff.push({ lot: l, got: g && { changed: g.changed, playerPlaced: g.playerPlaced }, want });
    }
    return [diff.length === 0, diff];
  }
  const addTo = (delta, kind, name, field, n = 1, kindKey = null) => {
    const o = ((delta[kind] ??= {})[name] ??= {});
    o[field] = (o[field] ?? 0) + n;
    if (kindKey) (o.kinds ??= {})[kindKey] = (o.kinds[kindKey] ?? 0) + n;
  };
  /** One changed region cell classified as §2 does, from the world alone: the player's record, air or fluid, else changed. */
  const classOf = (after, ptKeys, k) => (ptKeys.has(k) ? 'playerPlaced' : isAir(after) ? 'removed' : 'changed');

  /** noWrite where a survival builder may still save its files: two listings without a landCheck first (drift recorded, then judged
   * against it). */
  async function noWriteLive(region, box, worldDir, label) {
    const dirs = [path.join(worldDir, 'architect-regions', region), path.join(worldDir, 'architect-journal')];
    await call('dev.wait', { ms: 1500 }, 30_000);
    const a0 = dirs.map(listing);
    await call('dev.wait', { ms: 4000 }, 30_000);
    const a1 = dirs.map(listing);
    const drift = dirs.map((d, i) => listDiff(a0[i], a1[i])).flat();
    if (drift.length) log(`  ${label}: the region's files moved by themselves (no landCheck) in 4 s: ${drift.slice(0, 4).join('; ')}`);
    return { drift, report: drift.length ? null : await noWrite(region, box, worldDir, label) };
  }

  // ------------------------------------------------------------------ the castle (items 1 and 2)

  async function kitK() {
    const kit = await imp('lib/kit.mjs');
    const style = await imp('lib/connectors/style.mjs');
    return { Blueprint: kit.Blueprint, palette: kit.palette, variant: kit.variant, shapeOf: style.shapeOf, doorOf: style.doorOf };
  }
  /** GM-a's stub designs of the castle's wall lots (tools/lib/gate7agm-a.mjs writeDesigns), the gatehouse's deck at `roof`. */
  async function writeDesigns(lots, { tag, roof }) {
    const K = await kitK();
    const { resolveRoles } = await imp('lib/region/plan.mjs');
    const { writeBlueprint } = await imp('lib/write.mjs');
    const roles = resolveRoles({});
    const ids = {};
    for (const l of lots.filter((q) => q.onWall)) {
      const id = `lc_${tag}_${l.id}`.replace(/[^a-z0-9_]/g, '_').slice(0, 60);
      const bp = l.onWall.passage ? D.gatehouseDesign(K, id, l, roles, { roof }) : D.towerDesign(K, id, l, roles, { roof: true });
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
  /** Exactly n game ticks under /tick freeze. */
  async function tickStep(n = 1) {
    const t0 = await gameTime(cmd);
    await cmd(`/tick step ${n}`);
    for (let i = 0; i < 400; i++) {
      const t = await gameTime(cmd);
      if (t !== null && t0 !== null && t - t0 >= n) return;
      await sleep(25);
    }
    throw new Error(`/tick step ${n} did not advance`);
  }

  steps.castle = async () => {
    await ensure();
    await L.leaveWorld().catch(() => null);
    const out = {};
    const fx = G.fixture(ctx, 'gm/gm_castle_13x7');
    const s = await G.site(ctx, 'lc castle', fx, { creative: true });
    await G.designs(ctx);
    await cmd('/time set 6000');
    await cmd('/weather clear');
    const ck = await call('dev.region.checkPlan', { plan: s.wp.plan, claim: s.W.claim, owner: G.OWNER, anchors: s.wp.anchors, load: 'generate' }, 1_800_000);
    fs.writeFileSync(path.join(OUT, 'lc-castle-check.json'), `${JSON.stringify(ck, null, 1)}\n`);
    const sha = ck.check?.artifactSha;
    const lots = sha ? await artifactLots(sha) : [];
    const gl = lots.find((l) => l.id === 'gatehouse_1');
    const m = gl?.onWall?.passage?.mechanism ?? null;
    check(ck.check?.overall === 'READY' && !!m && m.kind === 'portcullis', `the castle (gm_castle_13x7: K3 wall lots on a K2 walk wall, a portcullis gatehouse) checks READY: ${ck.check?.overall}, mechanism ${m?.kind}`);
    if (!m) return out;
    const box = G.boxOf(s.W);
    box[4] = Math.max(box[4], s.W.maxY + 48);
    const cx = Math.round((s.W.claim[0] + s.W.claim[2]) / 2), cz = Math.round((s.W.claim[1] + s.W.claim[3]) / 2);
    const gy = s.W.maxY; // the flat terrain's top (grass)
    const pre = await dumpOf(box, 'lc-castle-pre');
    const ids = await writeDesigns(lots, { tag: 'c', roof: 10 });
    const region = await G.realise(ctx, sha, { ...fx.lotEntries, ...ids });
    const st = await L.waitRegion(region, 3_600_000);
    await L.settle(3000);
    check(st.view.state === 'PLACED', `the castle ${region} realised with GM-a's stub designs: ${st.view.state}`);
    await L.tp(cx, gy + 30, cz);
    const group = st.view.groupId;
    const planDir = path.join(L.SIDECAR_DATA, 'regions', 'plans', ck.check.checkId ?? st.view.planId);
    const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
    const own = await partsOracle(ir, pre.get, gy);
    out.oracleParts = [...new Set(own.part.values())].sort();
    const rr = await call('dev.region.realised', { region }, 600_000);
    const tileSites = new Set((rr.tiles ?? []).flatMap((t) => String(t.site ?? '').split(',').filter(Boolean)));
    log(`  the castle's tile parts (the kit's writers): ${json(out.oracleParts)}; ${tileSites.size} tile sites`);

    // ---- the fresh castle
    const lc0 = await landCheck(region);
    out.lc0 = strip(lc0);
    const mechPart = 'mech:gatehouse_1';
    // (the wall's parts the kit's writers name and the castle holds on top: a wall lot's own part, wl_*, is under its lot's site)
    const wallParts = out.oracleParts.filter((p) => /wall/.test(p) && row(lc0, p)?.cells > 0);
    const reportedOk = lc0.parts.every((p) => out.oracleParts.includes(p.part) || p.part === mechPart || (ir.roads ?? []).some((r) => r.id === p.part) || /^route_/.test(p.part));
    check(anyChange(lc0).length === 0 && lc0.unloaded === 0 && lc0.cellsChecked > 0, `the fresh castle reports no change: ${lc0.parts.length} parts (${json(lc0.parts.map((p) => [p.part, p.cells]))}), lots ${json(lc0.lots.map((l) => [l.lot, l.standing]))}, ${lc0.cellsChecked} cells checked, ${lc0.unloaded} unloaded`, anyChange(lc0));
    check(!!row(lc0, mechPart) && row(lc0, mechPart).cells > 0 && !row(lc0, 'unattributed') && wallParts.length > 0 && reportedOk,
      `the parts: ${mechPart} (${row(lc0, mechPart)?.cells ?? 0} cells), the wall's ${json(wallParts.map((p) => [p, row(lc0, p)?.cells ?? 0]))} (named by the kit's writers), every part one the kit's writers, the IR's roads or the mechanism name, none unattributed`, lc0.parts.map((p) => p.part));
    const wallLots = lots.filter((l) => l.onWall).map((l) => l.id);
    check(wallLots.length === 5 && wallLots.every((id) => { const l = lot(lc0, id); return l && l.siteId && l.standing >= 0.8 && l.changed === 0 && l.playerPlaced === 0; }),
      `the wall's lots (K3: 4 towers and the gatehouse) report in lots[], standing as built and unchanged: ${json(wallLots.map((id) => [id, lot(lc0, id)?.standing, lot(lc0, id)?.changed]))}`);

    // ---- item 1: the gate's own states are the region's (GM §4 item 4)
    const open = new Set(runsOf(m.states.open).map(key));
    const lanes = runsOf(m.states.closed).filter((c) => !open.has(key(c)));
    const levers = m.triggers.filter((t) => t.kind === 'lever').map((t) => t.at);
    const env = runsOf(m.cells);
    const xs = env.map((q) => q[0]), ys = env.map((q) => q[1]), zs = env.map((q) => q[2]);
    const envBox = [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.min(...zs) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1, Math.max(...zs) + 1];
    const readGate = async () => {
      const d = await dumpOf(envBox, 'lc-gate');
      const st2 = lanes.map((c) => d.get(key(c)) ?? 'minecraft:air');
      const filled = st2.filter((x) => !isAir(x)).length;
      let moving = false;
      for (const c of env) if (/moving_piston/.test(d.get(key(c)) ?? '')) { moving = true; break; }
      return { open: filled === 0, closed: filled === lanes.length, filled, of: lanes.length, moving };
    };
    const flipW = async (at) => { await flip(at); await L.gameWait(1500, { real: L.settle, label: 'lc flip' }); };
    const states = {};
    const g0 = await readGate();
    states.open = { gate: g0, same: same(lc0, lc0) };
    check(g0.open, `item 1: by day at rest the portcullis is open (${g0.filled}/${g0.of} lane cells filled)`);
    await flipW(levers[0]);
    const g1 = await readGate();
    const lcClosed = await landCheck(region);
    states.closed = { gate: g1, same: same(lc0, lcClosed) };
    check(g1.closed && states.closed.same[0], `item 1: the outside lever (a real use) closes it (${g1.filled}/${g1.of} lanes, the lever powered, the pistons extended): the same report as the open gate`, states.closed.same[1]);
    // mid-move: under /tick freeze, the lever used and one tick stepped: moving pistons in the envelope while landCheck reads it
    await cmd('/tick freeze');
    let gm = null, lcMove = null;
    try {
      await flip(levers[0]);
      for (let t = 0; t < 12; t++) { await tickStep(1); gm = await readGate(); if (gm.moving) { gm.tick = t + 1; break; } }
      lcMove = await landCheck(region);
    } finally {
      await cmd('/tick unfreeze');
    }
    await L.gameWait(2000, { real: L.settle, label: 'lc settle' });
    states.moving = { gate: gm, same: same(lc0, lcMove) };
    check(!!gm?.moving && states.moving.same[0], `item 1: mid-move (frozen ${gm?.tick ?? '12+'} tick(s) after the lever: moving pistons ${gm?.moving}, ${gm?.filled}/${gm?.of} lanes filled): the same report`, states.moving.same[1]);
    const g2 = await readGate();
    check(g2.open, `item 1: then open again (${g2.filled}/${g2.of})`);
    // dusk: the daylight sensor closes it (no lever); dawn opens it
    await cmd('/time set 14000');
    await L.gameWait(3000, { real: L.settle, label: 'lc dusk' });
    const g3 = await readGate();
    const lcDusk = await landCheck(region);
    states.dusk = { gate: g3, same: same(lc0, lcDusk) };
    check(g3.closed && states.dusk.same[0], `item 1: at dusk the sensor closes it (${g3.filled}/${g3.of}; the sensor and its wire powered): the same report`, states.dusk.same[1]);
    await cmd('/time set 1000');
    await L.gameWait(3000, { real: L.settle, label: 'lc dawn' });
    const g4 = await readGate();
    check(g4.open, `item 1: dawn opens it (${g4.filled}/${g4.of})`);
    const leverPt = await ptCount([...levers[0], ...levers[0]]);
    check(leverPt === 0, `item 1: a lever used by a player carries no PT record (${leverPt} tracked at ${json(levers[0])}): its use is not a placement`);
    out.states = states;

    // a player's block in an open lane cell: the player's (§2: a PT record is playerPlaced; GM §4 item 4 excuses state, not blocks)
    const lane = lanes.find((c) => true);
    const laneRes = await places([[lane, 'minecraft:cobblestone']]);
    const lcLane = await landCheck(region);
    const dLane = {};
    if (laneRes[0]?.tracked) addTo(dLane, 'parts', mechPart, 'playerPlaced');
    out.lane = { at: lane, placed: laneRes[0], report: row(lcLane, mechPart) };
    check(!!laneRes[0]?.tracked && plusDelta(lcLane, lc0, dLane)[0], `item 1: a player's cobblestone in an open lane cell ${json(lane)} (tracked ${!!laneRes[0]?.tracked}): ${mechPart} playerPlaced ${row(lcLane, mechPart)?.playerPlaced}, everything else as before`, plusDelta(lcLane, lc0, dLane)[1]);
    await breaks([lane]);
    await L.settle(1500);
    const lcLane2 = await landCheck(region);
    check(same(lc0, lcLane2)[0], 'item 1: the player takes it back: the report as the fresh castle\'s', same(lc0, lcLane2)[1]);

    // ---- item 2: the wall and its lots (standing wall unchanged: lc0 above)
    let base = lcLane2;
    const delta = {};
    const ptKeys = new Set();
    // wall cells held on top by a tile of the region, of a wall part by the kit's writers, standing as written, open above, quiet
    const cand = [];
    for (const [k, p] of own.part) {
      if (!wallParts.includes(p)) continue;
      cand.push([...k.split(',').map(Number), p]);
    }
    cand.sort((a, b) => b[1] - a[1] || a[0] - b[0] || a[2] - b[2]);
    const tp0 = await tops([...new Map(cand.map((c) => [`${c[0]},${c[2]}`, [c[0], c[2]]])).values()].slice(0, 2000));
    const wallDump = await dumpOf([s.W.claim[0] - 2, gy - 4, s.W.claim[1] - 2, s.W.claim[2] + 2, gy + 24, s.W.claim[3] + 2], 'lc-castle-wall');
    const picks = [];
    const usedCols = new Set();
    for (const c of cand) {
      if (picks.length >= 4) break;
      const k = key(c);
      const t = tp0.get(k);
      if (!t || t.group !== group || !tileSites.has(t.site)) continue;
      if (norm(wallDump.get(k) ?? 'minecraft:air') !== own.exp.get(k) || isAir(own.exp.get(k))) continue;
      if (!isAir(wallDump.get(key([c[0], c[1] + 1, c[2]])))) continue;
      if (usedCols.has(`${c[0] >> 2},${c[2] >> 2}`)) continue;
      if (!(await quiet(c, wallDump.get))) continue;
      usedCols.add(`${c[0] >> 2},${c[2] >> 2}`);
      picks.push(c);
    }
    check(picks.length === 4, `item 2: 4 wall cells (the kit's writers: ${json([...new Set(picks.map((c) => c[3]))])}) held on top by the region's tiles, open above: ${json(picks.map((c) => c.slice(0, 3)))}`);
    // a cell above the wall's top that the region never wrote (no entry of the group in its stack): a player's block there is not ours
    let never = null;
    for (const c of picks) {
      const up = [c[0], c[1] + 1, c[2]];
      const t = await topOf(up, group);
      if (!t.stack.some((e) => e.group === group)) { never = up; break; }
    }
    // a gap the region wrote (its top entry a tile of the group, written air): a player's block there is playerPlaced
    let gap = null;
    for (const [k, p] of own.part) {
      if (!isAir(own.exp.get(k))) continue;
      const c = k.split(',').map(Number);
      const t = tp0.get(k);
      if (!t || t.group !== group || !tileSites.has(t.site) || !isAir(wallDump.get(k))) continue;
      gap = [...c, p];
      if (wallParts.includes(p)) break;
    }
    out.wall = { picks, never, gap };
    // the player breaks 3, breaks and re-fills 1 with cobblestone; a block on the never-written cell; one in the written gap
    const before = await Promise.all(picks.map((c) => dumpOf(around(c), `lc-w-${c[0]}-${c[1]}-${c[2]}`)));
    const br = await breaks(picks.map((c) => c.slice(0, 3)));
    const refill = await places([[picks[3], 'minecraft:cobblestone'], ...(never ? [[never, 'minecraft:cobblestone']] : []), ...(gap ? [[gap, 'minecraft:cobblestone']] : [])]);
    await L.settle(1500);
    check(br.broken === 4 && refill.every((r) => r?.tracked), `item 2: a player broke ${br.broken} wall cells and placed ${refill.filter((r) => r?.tracked).length} tracked cobblestone (one re-fill${never ? ', one on a cell above the wall the region never wrote' : ''}${gap ? `, one in a gap the region wrote air in (${gap[3]})` : ''})`, refill);
    if (refill[0]?.tracked) ptKeys.add(key(picks[3]));
    if (gap && refill.at(-1)?.tracked) ptKeys.add(key(gap));
    // the expected change: every cell of the boxes round the picks that changed, held on top by the region, by the kit's part
    const seen = new Set();
    const stray = [];
    for (let i = 0; i < picks.length; i++) {
      const ch = await changed(around(picks[i]), before[i], `lc-w2-${i}`);
      for (const [k, , now] of ch.list) {
        if (seen.has(k)) continue;
        seen.add(k);
        if (never && k === key(never)) continue;
        if (!ptKeys.has(k) && !isAir(now) && idOf(norm(now)) === idOf(norm(before[i].get(k)))) continue; // a shape property (connections)
        const p = own.part.get(k);
        if (!p) { stray.push(k); continue; }
        const cls = classOf(now, ptKeys, k);
        addTo(delta, 'parts', p, cls, 1, cls === 'changed' ? idOf(norm(now)) : null);
      }
    }
    if (gap && !seen.has(key(gap))) addTo(delta, 'parts', gap[3], 'playerPlaced');
    const lcWall = await landCheck(region);
    out.wall.delta = JSON.parse(JSON.stringify(delta));
    const [okW, dW] = plusDelta(lcWall, base, delta);
    check(okW && stray.length === 0, `item 2: the wall's report: ${json(wallParts.map((p) => [p, row(lcWall, p) && counts(row(lcWall, p))]))} = before + the world's change attributed by the kit's writers (${json(delta.parts)}); ${never ? `the block on the never-written cell ${json(never)} not reported; ` : ''}${stray.length} changed cells the kit does not attribute`, { dW, stray });
    if (!never) log('  item 2: no never-written cell above the picked wall cells (each holds a group entry): that case not shown');
    if (!gap) log('  item 2: no written-air cell of the region standing open: the written-gap case not shown');
    base = lcWall;

    // a tower lot: two of its cells broken by the player, one re-filled: its LotLand row (changed 1, playerPlaced 1), its standing lower
    const towerId = 'tower_1';
    const tl = lot(lc0, towerId);
    const tlot = lots.find((l) => l.id === towerId);
    const tb = tlot?.box ?? tlot?.rect ?? null;
    const tcols = [];
    if (Array.isArray(tb) && tb.length >= 4) {
      const [x0, z0, x1, z1] = tb.length === 4 ? tb : [tb[0], tb[2], tb[3], tb[5]];
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) tcols.push([x, z]);
    }
    const ttop = await tops(tcols);
    const tdump = tcols.length ? await dumpOf([Math.min(...tcols.map((c) => c[0])) - 1, gy - 4, Math.min(...tcols.map((c) => c[1])) - 1, Math.max(...tcols.map((c) => c[0])) + 1, gy + 40, Math.max(...tcols.map((c) => c[1])) + 1], 'lc-tower') : null;
    const tpicks = [];
    for (const [k, t] of [...ttop.entries()].sort((a, b) => Number(b[0].split(',')[1]) - Number(a[0].split(',')[1]))) {
      if (tpicks.length >= 2) break;
      if (!t || t.site !== tl?.siteId) continue;
      const c = k.split(',').map(Number);
      if (!isAir(tdump.get(key([c[0], c[1] + 1, c[2]]))) || !(await quiet(c, tdump.get))) continue;
      if (tpicks.some((q) => Math.abs(q[0] - c[0]) + Math.abs(q[2] - c[2]) < 3)) continue;
      tpicks.push(c);
    }
    check(tpicks.length === 2, `item 2: 2 cells of ${towerId} (site ${tl?.siteId}, its lot box ${json(tb)}) held on top by its site, open above: ${json(tpicks)}`);
    const tdelta = {};
    if (tpicks.length === 2) {
      const tb0 = await Promise.all(tpicks.map((c) => dumpOf(around(c, 1), `lc-t-${c.join('-')}`)));
      const tbr = await breaks(tpicks);
      const tre = await places([[tpicks[1], 'minecraft:cobblestone']]);
      await L.settle(1500);
      const tpt = new Set(tre[0]?.tracked ? [key(tpicks[1])] : []);
      const tseen = new Set();
      for (let i = 0; i < 2; i++) {
        const ch = await changed(around(tpicks[i], 1), tb0[i], `lc-t2-${i}`);
        for (const [k, , now] of ch.list) {
          if (tseen.has(k)) continue;
          tseen.add(k);
          const t = ttop.get(k);
          if (t?.site !== tl.siteId) continue;
          if (!tpt.has(k) && !isAir(now) && idOf(norm(now)) === idOf(norm(tb0[i].get(k)))) continue;
          const cls = classOf(now, tpt, k);
          addTo(tdelta, 'lots', towerId, cls === 'playerPlaced' ? 'playerPlaced' : 'changed');
        }
      }
      const lcTower = await landCheck(region);
      const [okT, dT] = plusDelta(lcTower, base, tdelta);
      const tl2 = lot(lcTower, towerId);
      out.tower = { picks: tpicks, broken: tbr.broken, refill: tre[0], delta: tdelta, row: tl2 };
      check(okT && tbr.broken === 2 && !!tre[0]?.tracked && tl2.standing < tl.standing && tl2.standing >= 0, `item 2: ${towerId}'s LotLand: changed ${tl2.changed}, playerPlaced ${tl2.playerPlaced} (= the world's change ${json(tdelta.lots)}), standing ${tl.standing} -> ${tl2.standing}; every part and other lot as before`, dT);
      base = lcTower;
    }

    // ---- item 1: a player who mines a piston: removed in the mechanism's part (the moving and trigger cells aside, as built)
    const vol = new Set([...runsOf(m.states.open), ...runsOf(m.states.closed)].map(key));
    for (const t of m.triggers ?? []) { if (t.at) vol.add(key(t.at)); for (const r of t.rungs ?? []) vol.add(key(r)); }
    const envDump = await dumpOf(envBox, 'lc-env');
    const pistons = [];
    for (const c of env) {
      if (vol.has(key(c)) || !/(^|:)(sticky_)?piston(\[|$)/.test(envDump.get(key(c)) ?? '')) continue;
      const t = await topOf(c, group);
      if (t.ours && /mechanism/.test(String(t.top.kind ?? ''))) { pistons.push(c); break; }
    }
    check(pistons.length === 1, `item 1: a piston of the mechanism held on top by its site (${json(pistons[0])}: ${envDump.get(key(pistons[0] ?? [0, 0, 0]))})`);
    if (pistons.length) {
      const mdelta = {};
      await breaks(pistons);
      await L.settle(2000);
      const ch = await changed(envBox, envDump, 'lc-env2');
      const mtops = new Map();
      for (const [k, , now] of ch.list) {
        const c = k.split(',').map(Number);
        if (vol.has(k)) continue;
        const t = mtops.get(k) ?? (await topOf(c, group));
        if (!t.ours || !/mechanism/.test(String(t.top.kind ?? ''))) continue;
        // the mechanism's dynamic state (GM §4 item 4) is not a change: a moving piston, a property flip of the same block
        const was = envDump.get(k);
        if (/moving_piston|piston_head/.test(now ?? '') || idOf(norm(was)) === idOf(norm(now))) continue;
        const cls = classOf(now, new Set(), k);
        addTo(mdelta, 'parts', mechPart, cls, 1, cls === 'changed' ? idOf(norm(now)) : null);
      }
      const lcPiston = await landCheck(region);
      const [okM, dM] = plusDelta(lcPiston, base, mdelta);
      out.piston = { at: pistons[0], changed: ch.list.length, delta: mdelta, row: row(lcPiston, mechPart) };
      check(okM && (mdelta.parts?.[mechPart]?.removed ?? 0) >= 1, `item 1: the player mined the piston ${json(pistons[0])}: ${mechPart} removed ${row(lcPiston, mechPart)?.removed} (= the world's change in its envelope ${json(mdelta.parts)}), every other part and lot as before`, dM);
      base = lcPiston;
    }

    // as built (recorded, not judged): a lever the player breaks is a trigger cell, never judged, so it does not show
    {
      const lv = levers[1] ?? levers[0];
      await breaks([lv]);
      await L.settle(1500);
      const lcLever = await landCheck(region);
      const [eq, d] = same(base, lcLever);
      out.leverBroken = { at: lv, now: await stateAt(lv), sameAsBefore: eq, diff: d };
      log(`  (recorded) a player broke the lever ${json(lv)} (now ${out.leverBroken.now}): the report ${eq ? 'unchanged (a trigger cell is never judged, as built)' : `moved ${json(d)}`}`);
      base = lcLever;
    }

    // ---- nothing written by any of these calls
    const wd = (await call('dev.region.landCheck', { region }, 900_000)).worldDir;
    await noWrite(region, box, wd, 'the castle');
    spendZero();
    return out;
  };

  // ------------------------------------------------------------------ survival (item 3)

  /** RS item 6's half feed (tools/gate6crs.mjs halfFeed): half of the whole bill, fed in waves of what the targets lack. */
  async function halfFeed(ck) {
    const half = {};
    const whole = G.plus(ck.check.cost.bom, {});
    for (const [it, n] of Object.entries((await G.pileState(ctx)).outstanding ?? {})) whole[it] = Math.max(whole[it] ?? 0, n);
    for (const [it, n] of Object.entries(whole)) if (Math.floor(n / 2) > 0) half[it] = Math.floor(n / 2);
    let acc = {};
    for (let k = 0; k < 200; k++) {
      const ps = await G.pileState(ctx);
      const need = {};
      for (const [it, n] of Object.entries(ps.outstanding ?? {})) {
        const left = (half[it] ?? 0) - (acc[it] ?? 0);
        const lack = Math.min(left, n - (ps.stock?.[it] ?? 0));
        if (lack > 0) need[it] = lack;
      }
      if (!Object.keys(need).length) { if (k > 3) break; await sleep(4000); continue; }
      acc = G.plus(acc, (await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: need, exact: true }, 120_000)).accepted ?? {});
      await sleep(3000);
    }
    return { half, acc };
  }
  /** The builder until the built count stops moving (4 reads in a row). */
  async function idle(region) {
    let last = -1, still = 0;
    for (let k = 0; k < 120 && still < 4; k++) {
      await sleep(4000);
      const rs = await G.rsState(ctx, region);
      const built = (rs.targets ?? []).reduce((a, t) => a + t.built, 0);
      still = built === last ? still + 1 : 0;
      last = built;
    }
  }
  /** Every target's cells (dev.rs.cells: [x, y, z, flags], 1 held, 2 built, 4 a cut), its part, and whether it is done. */
  async function targetCells(region) {
    const rc = await call('dev.rs.cells', { region }, 120_000);
    const rs = await G.rsState(ctx, region);
    const done = new Map((rs.targets ?? []).map((t) => [t.target ?? t.id, !!t.done]));
    return (rc.targets ?? []).map((t) => ({ target: t.target, part: t.part, done: done.get(t.target) ?? null, cells: t.cells ?? [] }));
  }

  steps.survival = async () => {
    await ensure();
    await L.leaveWorld().catch(() => null);
    const out = {};
    const fx = G.fixture(ctx, 'rs02_walled');
    const s = await G.site(ctx, 'lc rs02', fx);
    await G.designs(ctx);
    const box = G.boxOf(s.W);
    const cx = Math.round((s.W.claim[0] + s.W.claim[2]) / 2), cz = Math.round((s.W.claim[1] + s.W.claim[3]) / 2);
    const ck = await G.check(ctx, 'lc-rs02', s);
    check(!!ck.check?.artifactSha, `rs02_walled checks in survival: ${ck.check?.overall}`);
    await G.pile(ctx, s, 4);
    const region = await G.realise(ctx, ck.check.artifactSha, fx.lotEntries ?? {});
    await G.waitFor(ctx, region, (st2, rs) => (rs.targets ?? []).length > 0, { timeoutMs: 900_000 });
    // every target's cells while all of them wait (done targets' runs are gone later)
    const tc0 = await targetCells(region);
    const fed = await halfFeed(ck);
    await idle(region);
    await L.tp(cx, s.W.maxY + 30, cz);
    const group = (await G.regionState(ctx, region)).view?.groupId;
    const tcH = await targetCells(region);
    const tcAll = new Map(tc0.map((t) => [t.target, t]));
    const done = tcH.filter((t) => t.done), waiting = tcH.filter((t) => t.done === false);
    out.mid = { fed: fed.acc, targets: tcH.map((t) => [t.target, t.part, t.done, t.cells.filter((c) => c[3] & 2).length, t.cells.length]) };
    check(done.length > 0 && waiting.length > 0, `item 3: rs02_walled half fed (${Object.values(fed.acc).reduce((a, b) => a + b, 0)} items), the builder idle: ${done.length} target(s) built (${json([...new Set(done.map((t) => t.part))])}), ${waiting.length} waiting (${json([...new Set(waiting.map((t) => t.part))])})`);

    // ---- mid-build: no change; a target still building is not the region's land yet
    const lcA = await landCheck(region);
    out.lcA = strip(lcA);
    const una = row(lcA, 'unattributed');
    out.mid.unattributed = una?.cells ?? 0;
    check(anyChange(lcA).length === 0 && lcA.unloaded === 0 && lcA.cellsChecked > 0, `item 3, mid-build: no change: ${lcA.parts.length} parts (${json(lcA.parts.map((p) => [p.part, p.cells]))}), lots ${json(lcA.lots.map((l) => [l.lot, l.state, l.changed]))}, ${lcA.cellsChecked} cells checked, ${lcA.unloaded} unloaded`, anyChange(lcA));
    log(`  item 3, mid-build: ${out.mid.unattributed} cells unattributed (tiles whose targets are not all built, as built: RS's WRITTEN set includes their targets' cells)`);
    const wd = (await call('dev.region.landCheck', { region }, 900_000)).worldDir;
    out.mid.nowrite = (await noWriteLive(region, box, wd, 'item 3, mid-build')).drift;

    // a waiting cell (a paid cell of a target not built yet, air now, its top writer the target): a player's block there is not land change
    let wcell = null;
    for (const t of waiting) {
      for (const c of t.cells) {
        if (c[3] & 7) continue;
        const now = await stateAt(c);
        if (!isAir(now)) continue;
        const tp = await topOf(c, group);
        if (tp.top?.site !== t.target) continue;
        wcell = { at: c.slice(0, 3), target: t.target, part: t.part };
        break;
      }
      if (wcell) break;
    }
    check(!!wcell, `item 3: a waiting paid cell (its target ${wcell?.target} of ${wcell?.part} not built, air now, the target on top of its journal stack): ${json(wcell?.at)}`);
    if (wcell) {
      const r = await places([[wcell.at, 'minecraft:cobblestone']]);
      await L.settle(1500);
      const lcW = await landCheck(region);
      out.waiting = { ...wcell, tracked: !!r[0]?.tracked };
      check(!!r[0]?.tracked && same(lcA, lcW)[0], `item 3: a player's cobblestone on that waiting cell (tracked ${!!r[0]?.tracked}): not reported (the cell is the target's to build; "not counted yet" while it builds): the report as before`, same(lcA, lcW)[1]);
      await breaks([wcell.at]);
      await L.settle(1500);
    }

    // a paid block taken up from a built target: removed in its part; the target stays built; put back by the console: as before
    let pcell = null;
    for (const t of done) {
      const all = tcAll.get(t.target)?.cells ?? [];
      for (const c of all) {
        if (c[3] & 5) continue;
        const tp = await topOf(c, group);
        if (tp.top?.site !== t.target) continue;
        const d = await dumpOf(around(c, 1), 'lc-p');
        if (!(await quiet(c, d.get))) continue;
        pcell = { at: c.slice(0, 3), target: t.target, part: t.part, was: d.get(key(c)), dump: d };
        break;
      }
      if (pcell) break;
    }
    check(!!pcell, `item 3: a paid cell of a built target (${pcell?.target} of ${pcell?.part}, ${pcell?.was}): ${json(pcell?.at)}`);
    if (pcell) {
      await breaks([pcell.at]);
      await L.settle(1500);
      const ch0 = await changed(around(pcell.at, 1), pcell.dump, 'lc-p2');
      const ch = { list: ch0.list.filter(([, was, now]) => isAir(now) || idOf(norm(now)) !== idOf(norm(was))) };
      const lcP = await landCheck(region);
      const tAfter = (await targetCells(region)).find((t) => t.target === pcell.target);
      const pd = {};
      addTo(pd, 'parts', pcell.part, 'removed', ch.list.length);
      out.paidMid = { ...pcell, dump: undefined, changed: ch.list.map((q) => q[0]), row: row(lcP, pcell.part), stillDone: tAfter?.done };
      check(ch.list.length === 1 && plusDelta(lcP, lcA, pd)[0] && tAfter?.done === true, `item 3, mid-build: the player took up ${pcell.was} at ${json(pcell.at)}: ${pcell.part} removed ${row(lcP, pcell.part)?.removed}, every other part and lot as before; the target still built (${tAfter?.done})`, plusDelta(lcP, lcA, pd)[1]);
      await cmd(`/setblock ${pcell.at.join(' ')} ${pcell.was}`);
      await L.settle(1500);
      const lcP2 = await landCheck(region);
      check(same(lcA, lcP2)[0], 'item 3, mid-build: the block put back (the console, the same state): the report as before', same(lcA, lcP2)[1]);
    }

    // ---- fully built: no change, no part unattributed
    const fd = await G.feed(ctx, region, { timeoutMs: 1_800_000 });
    await L.settle(3000);
    check(fd.last.st.view.state === 'PLACED' && fd.last.rs.build?.done, `item 3: the rest fed: ${fd.last.st.view.state}, done ${fd.last.rs.build?.done}`);
    const lcB = await landCheck(region);
    out.lcB = strip(lcB);
    check(anyChange(lcB).length === 0 && lcB.unloaded === 0 && !row(lcB, 'unattributed') && lcB.cellsChecked > lcA.cellsChecked, `item 3, fully built: no change, no cell unattributed: ${lcB.parts.length} parts (${json(lcB.parts.map((p) => [p.part, p.cells]))}), lots ${json(lcB.lots.map((l) => [l.lot, l.state, l.standing]))}, ${lcB.cellsChecked} cells checked (${lcA.cellsChecked} mid-build)`, anyChange(lcB));

    // fully built: a paid block taken up (removed), another re-filled by the player (playerPlaced), a lot's cell broken (its row)
    const tcB = new Map((await targetCells(region)).map((t) => [t.target, t]));
    const pc = [];
    for (const t of tc0) {
      if (pc.length >= 2) break;
      if (tcB.get(t.target)?.done === false) continue;
      for (const c of t.cells) {
        if (c[3] & 5) continue;
        if (pc.some((q) => Math.abs(q.at[0] - c[0]) + Math.abs(q.at[1] - c[1]) + Math.abs(q.at[2] - c[2]) < 4)) continue;
        const tp = await topOf(c, group);
        if (tp.top?.site !== t.target) continue;
        const d = await dumpOf(around(c, 1), 'lc-b');
        if (!(await quiet(c, d.get))) continue;
        pc.push({ at: c.slice(0, 3), part: t.part, target: t.target, dump: d });
        if (pc.length >= 2) break;
      }
    }
    // a lot cell: the top of a built lot's site (h1)
    const l1 = lot(lcB, 'h1');
    const st1 = await G.regionState(ctx, region);
    const lbox = st1.record?.lots?.h1?.box ?? st1.view?.lots?.find?.((l) => l.id === 'h1')?.box ?? null;
    let lcell = null;
    if (l1?.siteId) {
      const site = await call('dev.site.state', { site: l1.siteId }, 60_000).catch(() => null);
      const sb = site?.box ?? site?.bounds ?? lbox;
      const cols = [];
      if (Array.isArray(sb) && sb.length === 6) for (let x = sb[0]; x <= sb[3]; x++) for (let z = sb[2]; z <= sb[5]; z++) cols.push([x, z]);
      const lt = await tops(cols);
      const ld = cols.length ? await dumpOf([sb[0] - 1, sb[1] - 1, sb[2] - 1, sb[3] + 1, sb[4] + 1, sb[5] + 1], 'lc-lot') : null;
      for (const [k, t] of [...lt.entries()].sort((a, b) => Number(b[0].split(',')[1]) - Number(a[0].split(',')[1]))) {
        if (t?.site !== l1.siteId) continue;
        const c = k.split(',').map(Number);
        if (!isAir(ld.get(key([c[0], c[1] + 1, c[2]]))) || !(await quiet(c, ld.get))) continue;
        lcell = { at: c, dump: await dumpOf(around(c, 1), 'lc-l') };
        break;
      }
      out.lotBox = sb;
    }
    check(pc.length === 2 && !!lcell, `item 3, fully built: 2 paid cells of built targets (${json(pc.map((q) => [q.part, q.at]))}) and a cell of lot h1's site (${json(lcell?.at)})`);
    if (pc.length === 2 && lcell) {
      const fdelta = {};
      await breaks([pc[0].at, pc[1].at, lcell.at]);
      const re = await places([[pc[1].at, 'minecraft:cobblestone']]);
      await L.settle(2000);
      const pts = new Set(re[0]?.tracked ? [key(pc[1].at)] : []);
      for (const q of pc) {
        const ch = await changed(around(q.at, 1), q.dump, 'lc-b2');
        for (const [k, was, now] of ch.list) if (pts.has(k) || isAir(now) || idOf(norm(now)) !== idOf(norm(was))) addTo(fdelta, 'parts', q.part, classOf(now, pts, k), 1, classOf(now, pts, k) === 'changed' ? idOf(norm(now)) : null);
      }
      const chl = await changed(around(lcell.at, 1), lcell.dump, 'lc-l2');
      addTo(fdelta, 'lots', 'h1', 'changed', chl.list.filter(([, was, now]) => isAir(now) || idOf(norm(now)) !== idOf(norm(was))).length);
      const lcC = await landCheck(region);
      const [okC, dC] = plusDelta(lcC, lcB, fdelta);
      out.built = { picks: pc.map((q) => ({ at: q.at, part: q.part })), lot: lcell.at, delta: fdelta, refill: re[0] };
      check(okC && !!re[0]?.tracked && lot(lcC, 'h1').standing <= l1.standing, `item 3, fully built: the player took up ${pc[0].part} ${json(pc[0].at)} (removed), took up and re-filled ${pc[1].part} ${json(pc[1].at)} with cobblestone (playerPlaced) and broke lot h1's ${json(lcell.at)}: the report = before + ${json(fdelta)}; h1 standing ${l1.standing} -> ${lot(lcC, 'h1').standing}`, dC);
    }
    out.built ??= {};
    out.built.nowrite = (await noWriteLive(region, box, wd, 'item 3, fully built')).drift;
    spendZero();
    return out;
  };
}
