// Phase 6c slice F3-c (docs/CONTRACT.md "Phase 6c slice F3: forms II" §3.4, §6, §10 items 3, 4 and 6 for coral): coral in game, headless,
// $0. `coralItems(ctx)` (ctx as tools/gate6ckc.mjs builds it: {L, OUT, KIT, imp, json, root, check, log, core}, core = gate6chy-core.mjs),
// wired into tools/gate6cf3.mjs's `ingame` step by the F3 builder. Every run goes through gate6chy-b.mjs realiseFixture (Regions.checkPlan's
// two-plan flow, realiseApproved with the artifact, the fluid guards flat, every body's census against its prediction: a decor cell of a
// body holds its own decor, waterlogged, a source):
//   item 3  v73 (a coral pond and a coral fountain), exact rules: READY, PLACED, every body settled, census equal to `predicted` with the
//           decor, the realised decor cells equal the virtual ones by state, M19 0 on the dump straight after the settle; then (item 6)
//           live coral killed by a player-like /setblock (dead variants of bed blocks, plants and fans), Regions.remove (the drain
//           first, then the decor and the bed restored): E-flat 0, the dead ones counted ours (StillOurs via Coral.canonical)
//   item 4  v73 again at default rules: a 2-minute stand at random_tick_speed 3: 0 live coral turned dead, M19 0
//   c01     the coral pond on the frozen site 2026101102 under its ice cap (exact rules, the site's own ground): every pickle 1 to a
//           cluster, the cap all ice with block light at most 10 over it (M17 0), M19 0
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;
const FROZEN_SEED = '2026101102';
const D6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** The dead variant of a live coral state (the same properties), or null. */
export function deadOf(state) {
  const m = /^minecraft:((tube|brain|bubble|fire|horn)_coral(_block|_fan|_wall_fan)?)(\[.*\])?$/.exec(state);
  return m ? `minecraft:dead_${m[1]}${m[4] ?? ''}` : null;
}

/** A dump of `box` (ARWD, block light), decoded: {at(x, y, z) -> state, light(x, y, z), file}. */
async function dumpOf(ctx, box, name) {
  const file = path.join(ctx.OUT, `f3c-${name}.arwd.gz`);
  await ctx.L.call('dev.region.dump', { box, file, light: true }, 1_800_000);
  const { decodeArwd } = await ctx.imp('lib/region/vworld.mjs');
  const d = await decodeArwd(fs.readFileSync(file));
  const inBox = (x, y, z) => x >= d.box.minX && x <= d.box.maxX && y >= d.box.minY && y <= d.box.maxY && z >= d.box.minZ && z <= d.box.maxZ;
  return {
    file, box: d.box,
    at: (x, y, z) => (inBox(x, y, z) ? d.palette[d.cells[d.at(x, y, z)]] : null),
    light: (x, y, z) => (inBox(x, y, z) && d.light ? d.light[d.at(x, y, z)] : null),
    each(fn) { for (let x = d.box.minX; x <= d.box.maxX; x++) for (let z = d.box.minZ; z <= d.box.maxZ; z++) for (let y = d.box.minY; y <= d.box.maxY; y++) fn(x, y, z, d.palette[d.cells[d.at(x, y, z)]]); },
  };
}

/** M19 (checkForms.mjs formRules) over a realised dump: every live coral cell in the box. Returns {corals, dead, cells (<= 16)}. */
async function m19Of(ctx, dump) {
  const { formRules, isLiveCoralBlock, isLiveCoralPlant } = await ctx.imp('lib/region/checkForms.mjs');
  const isWater = (x, y, z) => { const s = dump.at(x, y, z); return !!s && (s === 'minecraft:water' || s.startsWith('minecraft:water[') || /waterlogged=true/.test(s) || s.startsWith('minecraft:bubble_column')); };
  const out = formRules({
    each: (fn) => dump.each((x, y, z, s) => { if (isLiveCoralBlock(s) || isLiveCoralPlant(s)) fn(x, y, z, s, 0); }),
    stateAt: (x, y, z) => { const s = dump.at(x, y, z); return !s || s === 'minecraft:air' ? null : s; },
    isWater,
  });
  const cells = [...out.m19.values()].flat();
  return { corals: out.metrics.M19.corals, dead: out.metrics.M19.dead, cells: cells.slice(0, 16) };
}

/** The decor cells of the region's bodies (core.bodiesOf reads `decor` [[x, y, z, state]]), with the body each stands in. */
const decorOf = (bodies) => bodies.flatMap((b) => (b.decor ?? []).map((c) => ({ body: b.id, c, state: c[3] })));

/** Item 3's checks while the region stands (straight after the settle): the decor by state, M19 on the dump, the census's decor. */
async function standing(ctx, tag, r, item) {
  const { check, json } = ctx;
  const o = {};
  const decor = decorOf(r.bodies);
  o.decor = { cells: decor.length, bodies: [...new Set(decor.map((d) => d.body))] };
  check(decor.length > 0, `${item} (${tag}): the realised IR's bodies carry the coral as their own decor set (${decor.length} cell(s) in ${json(o.decor.bodies)})`);
  const box = ctx.core.boxAround(r.bodies.flatMap((b) => [...b.cells, ...b.shell]), 2);
  const dump = await dumpOf(ctx, box, `${tag}-after`);
  const differ = decor.filter((d) => dump.at(d.c[0], d.c[1], d.c[2]) !== d.state);
  o.equal = { equal: decor.length - differ.length, differ: differ.length, sample: differ.slice(0, 8).map((d) => [k3(d.c), d.state, dump.at(d.c[0], d.c[1], d.c[2])]) };
  check(differ.length === 0, `${item} (${tag}): every realised decor cell equals the virtual one by state (${o.equal.equal}/${decor.length}; waterlogged plants, fans, wall fans and pickles in the body's cells, coral blocks in its bed)`, o.equal.sample);
  // the census with the decor: realiseFixture's census already required every body cell to hold its source (a decor cell its decor)
  const cen = {};
  for (const b of r.bodies.filter((q) => (q.decor ?? []).length)) {
    const c = await ctx.core.censusOf(ctx, b, null, r.bodies);
    const water = (b.decor ?? []).filter((d) => b.cells.some((q) => q[0] === d[0] && q[1] === d[1] && q[2] === d[2])).length;
    cen[b.id] = { ok: c.ok, sources: c.sources, decor: c.decor, waterDecor: water, cells: b.cells.length, ice: b.ice.length, flowing: c.flowing, predicted: b.predicted.length, mismatch: c.mismatch.length };
  }
  o.census = cen;
  check(Object.keys(cen).length > 0 && Object.values(cen).every((c) => c.ok && c.sources + c.ice === c.cells && c.decor === c.waterDecor && c.flowing === c.predicted),
    `${item} (${tag}): each coral body's census equals its prediction with the decor counted as sources (body: sources + ice = cells, decor sources, flowing = predicted: ${json(Object.entries(cen).map(([k, v]) => [k, v.sources, v.ice, v.cells, v.decor, v.flowing, v.predicted]))})`, cen);
  o.m19 = await m19Of(ctx, dump);
  check(o.m19.corals > 0 && o.m19.dead === 0, `${item} (${tag}): M19 on the dump straight after the settle: ${o.m19.dead} of ${o.m19.corals} live coral cell(s) would die (no water beside a block, a plant not waterlogged)`, o.m19.cells);
  return { o, dump, box, decor };
}

export async function coralItems(ctx) {
  const { L, check, json, log } = ctx;
  const B = await import('./gate6chy-b.mjs');
  const out = {};
  const v73 = B.fixture(ctx, 'valid/v73_f3_coral_pond.json');

  // ---- item 3 and item 6: exact rules, the standing checks, a player-like kill, Regions.remove E-flat 0
  try {
    out.v73 = await B.realiseFixture(ctx, 'f3c-v73', v73, {
      rules: 'exact',
      after: async (r) => {
        const s = await standing(ctx, 'f3c-v73', r, 'item 3');
        // item 6: kill some coral the way a player would (/setblock its dead variant, with neighbour updates): 6 bed blocks and 6 plants or
        // fans of the pond, 2 bed blocks of the fountain; each must still be the region's and go back with the removal
        const pick = (body, live) => s.decor.filter((d) => d.body === body && live(d.state)).slice(0, 6);
        const killed = [...pick('w_pond', (st) => /_coral_block$/.test(st)), ...pick('w_pond', (st) => /_coral(_fan|_wall_fan)?\[/.test(st)), ...pick('w_fount', (st) => /_coral_block$/.test(st)).slice(0, 2)];
        for (const d of killed) await L.cmd(`/setblock ${d.c[0]} ${d.c[1]} ${d.c[2]} ${deadOf(d.state)}`);
        await sleep(2000);
        const dd = await dumpOf(ctx, s.box, 'f3c-v73-killed');
        const dead = killed.filter((d) => dd.at(d.c[0], d.c[1], d.c[2]) === deadOf(d.state)).length;
        check(killed.length >= 8 && dead === killed.length, `item 6 (f3c-v73): ${dead}/${killed.length} live coral cell(s) killed by a player-like /setblock (dead variants of bed blocks, plants and fans) before the removal`, killed.slice(0, 4).map((d) => [k3(d.c), d.state]));
        return { ...s.o, killed: killed.map((d) => [k3(d.c), d.state, deadOf(d.state)]), dead };
      },
    });
    const u = out.v73?.undo;
    if (u) check(u.state === 'REMOVED' && u.mismatches === 0, `item 6 (f3c-v73): with its pond drained by the removal (the sources first, then the decor and the bed), every coral cell restored, the dead ones counted ours (Coral.canonical): E-flat ${u.mismatches} (${u.seconds} s)`, u.sample);
  } catch (e) { check(false, `items 3/6 (v73): ${String(e?.stack ?? e).slice(0, 400)}`); try { await L.leaveWorld(); } catch { /* left */ } }

  // ---- item 4: the stand at default random ticks
  try {
    out.stand = await B.realiseFixture(ctx, 'f3c-v73-stand', v73, {
      rules: 'default', noUndo: true,
      after: async (r) => {
        const s = await standing(ctx, 'f3c-v73-stand', r, 'item 4');
        await L.cmd('/gamerule random_tick_speed 3');
        const t0 = Date.now();
        await sleep(120_000);
        const d1 = await dumpOf(ctx, s.box, 'f3c-v73-stand-2min');
        const lives = s.decor.filter((d) => !/^minecraft:sea_pickle/.test(d.state));
        const died = lives.filter((d) => d1.at(d.c[0], d.c[1], d.c[2]) === deadOf(d.state));
        const changed = s.decor.filter((d) => d1.at(d.c[0], d.c[1], d.c[2]) !== d.state);
        const m19 = await m19Of(ctx, d1);
        check(died.length === 0 && m19.dead === 0, `item 4 (f3c-v73-stand): after a 2-minute stand at random_tick_speed 3 (${Math.round((Date.now() - t0) / 1000)} s): ${died.length} of ${lives.length} live coral turned dead, ${changed.length} decor cell(s) changed at all; M19 ${m19.dead} of ${m19.corals}`, changed.slice(0, 8).map((d) => [k3(d.c), d.state, d1.at(d.c[0], d.c[1], d.c[2])]));
        return { ...s.o, stand: { lives: lives.length, died: died.length, changed: changed.length, m19 } };
      },
    });
  } catch (e) { check(false, `item 4 (stand): ${String(e?.stack ?? e).slice(0, 400)}`); try { await L.leaveWorld(); } catch { /* left */ } }

  // ---- c01: the frozen site, under the ice cap
  try {
    const c01 = B.fixture(ctx, 'f3/c01_cold_coral.json');
    const base = await L.seedBase(FROZEN_SEED);
    out.c01 = await B.realiseFixture(ctx, 'f3c-c01', c01, {
      base, at: true, rules: 'exact', noUndo: true,
      after: async (r) => {
        const s = await standing(ctx, 'f3c-c01', r, 'c01');
        const pond = r.bodies.find((b) => (b.decor ?? []).length);
        const pickles = (pond?.decor ?? []).filter((d) => d[3].startsWith('minecraft:sea_pickle'));
        const one = pickles.filter((d) => s.dump.at(d[0], d[1], d[2]) === 'minecraft:sea_pickle[pickles=1,waterlogged=true]').length;
        check(pond?.ice?.length > 0 && pickles.length > 0 && one === pickles.length, `c01: the pond is capped (${pond?.ice?.length ?? 0} ice cells) and every sea pickle under the cap is 1 to a cluster in the world (${one}/${pickles.length}: light 6)`);
        // M17 on the realised world: every cap cell still ice, its block light at most 10 (ice melts over 10)
        const caps = (pond?.ice ?? []).map((c) => ({ c, st: s.dump.at(c[0], c[1], c[2]), light: s.dump.light(c[0], c[1], c[2]) }));
        const notIce = caps.filter((q) => q.st !== 'minecraft:ice');
        const maxLight = Math.max(0, ...caps.map((q) => q.light ?? 0));
        const lit = caps.filter((q) => (q.light ?? 0) > 10);
        check(notIce.length === 0 && lit.length === 0, `c01: M17 0 on the realised world: ${caps.length} cap cell(s), ${notIce.length} not ice, ${lit.length} at block light over 10 (the highest ${maxLight})`, [...notIce, ...lit].slice(0, 8));
        // and nothing beside a pickle is lit past it (light 6 at the pickle, 5 a step)
        const nearPickle = pickles.map((d) => Math.max(...D6.map(([dx, dy, dz]) => s.dump.light(d[0] + dx, d[1] + dy, d[2] + dz) ?? 0)));
        log(`  c01: light beside each pickle ${json(nearPickle)}`);
        return { ...s.o, pickles: pickles.length, one, caps: caps.length, maxLight };
      },
    });
  } catch (e) { check(false, `c01: ${String(e?.stack ?? e).slice(0, 400)}`); try { await L.leaveWorld(); } catch { /* left */ } }
  return out;
}
