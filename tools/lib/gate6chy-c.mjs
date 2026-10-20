// (6c HY) HY-c's items of the HY gate (tools/gate6chy.mjs; docs/CONTRACT.md "Phase 6c slice HY" §14, §15). Slice HY-c owns this file.
// `items` maps a step of the driver (unit, ingame, crash, natural, cold, look) to a list of {name, async run(ctx)}: each runs after
// HY-core's items of that step, with ctx = {L (tools/lib/run6b.mjs), OUT, KIT, imp, json, root, check, log, core} (core: HY-core's
// helpers, tools/lib/gate6chy-core.mjs: planCheck through Regions.checkPlan, realiseApproved, census, snapshots, removal).
//
// HY-c's items (the water gate, wall.water_gate, §8.3): hy_gate_demo (kit/regions/hy_gate_demo.mjs: a walled yard, a still reach laid
// across the wall's south side by kit/lib/fluids/handgate.mjs) on the flat base (raised by 5 layers if it is a superflat 3 over bedrock:
// the reach is sunk 2 deep), every realise through Regions.checkPlan and realiseApproved with the approval artifact:
//   unit    kit/test/hy-c.test.mjs (the crossing, the grate, the lintel, closure, gates.max, sealed walls, the broken variants caught,
//           the wire shapes, determinism), K1a's wall tests and the K1 batch test
//   ingame  item 14 and item 9's water-gate row, under the exact rules: READY, PLACED, the reach settled; the grate censused as
//           sources (bars joined); the lintel and wall over it; vanilla dev.nav.villager never through the grate; the push stand
//           (zombies, villagers, a spider pushed at the grate from inside for 20 s: none beyond it) with its negative control (the
//           no_grate variant: the same push gets through); the sealed wall and the wall at its gates.max refuse it UNREACHABLE
//           {kind: wall} through Regions.checkPlan; Regions.remove restores the box exactly (E-flat 0 by state, the lintel and grate
//           included)
//   look    the castle with its moat (client, recorded not judged), three bibles
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k2 = (x, z) => `${x},${z}`;
/** hy_gate_demo's claim on the flat world (128 x 112), clear of HY-core's (9300..9395, 9000..9063). */
export const CLAIM = [9500, 9000, 9627, 9111];
/** Layers a superflat ground is raised by (dirt, grass on top) over the claim and 8 round it. */
const RAISE = 5;
const LOOK_BIBLES = [null, 'g7ak1_infernal', 'g7ak1_coastal'];

async function demoOf(ctx) {
  return import(pathToFileURL(path.join(ctx.KIT, 'regions', 'hy_gate_demo.mjs')).href);
}

/** A fresh flat world with the claim's ground raised (so a reach 2 deep stands over bedrock's dirt), its rules; returns g. */
async function freshGate(ctx, name, rules = 'exact') {
  const { L, core } = ctx;
  await L.fresh(name, core.FLAT);
  if (rules === 'exact') await L.setRules('exact');
  else { await L.cmd('/weather clear'); await L.cmd('/time set 6000'); }
  // the ground from the survey (HY-core's groundOf); a superflat ground (3 over bedrock) is raised by RAISE layers first, so a reach 2
  // deep and its floor stand in dirt
  let g = await core.groundOf(ctx, CLAIM);
  if (g < -55) {
    for (let x = CLAIM[0] - 8; x <= CLAIM[2] + 8; x += 32) for (let z = CLAIM[1] - 8; z <= CLAIM[3] + 8; z += 32) {
      const x1 = Math.min(CLAIM[2] + 8, x + 31), z1 = Math.min(CLAIM[3] + 8, z + 31);
      await L.cmd(`/fill ${x} ${g} ${z} ${x1} ${g + RAISE - 1} ${z1} minecraft:dirt`);
      await L.cmd(`/fill ${x} ${g + RAISE} ${z} ${x1} ${g + RAISE} ${z1} minecraft:grass_block`);
    }
    await L.settle(2000);
    g = await core.groundOf(ctx, CLAIM);
  }
  return g;
}

/** hy_gate_demo's plan through Regions.checkPlan (the two-plan flow). */
async function checkGate(ctx, tag, params = {}, extra = {}) {
  const { L, OUT, core } = ctx;
  const demo = await demoOf(ctx);
  const { plan, anchors } = demo.hyGatePlan({ minX: CLAIM[0], minZ: CLAIM[1], maxX: CLAIM[2], maxZ: CLAIM[3] }, params);
  const c = await L.call('dev.region.checkPlan', { plan, claim: CLAIM, owner: core.OWNER, anchors, load: 'generate', ...extra }, 900_000);
  fs.writeFileSync(path.join(OUT, `hyc-${tag}-check.json`), `${JSON.stringify(c, null, 1)}\n`);
  return c;
}

/** The approval artifact the sidecar saved for a check: the plan dir's artifact.json whose bytes hash to `sha`, or null. */
function findArtifact(L, sha) {
  const dir = path.join(L.SIDECAR_DATA, 'regions', 'plans');
  for (const d of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const f = path.join(dir, d, 'artifact.json');
    if (!fs.existsSync(f)) continue;
    const b = fs.readFileSync(f);
    if (createHash('sha256').update(b).digest('hex') === sha) return JSON.parse(b.toString('utf8'));
  }
  return null;
}

const boxOf = (g) => [CLAIM[0] - 8, g - 8, CLAIM[1] - 8, CLAIM[2] + 8, g + 40, CLAIM[3] + 8];

/** The water gate's geometry from a realised region: the reach body, the wall's water gate, the axis and the inside's sign. */
function gateGeometry(r) {
  const body = r.bodies.find((b) => b.id === 'race_r1');
  const meta = JSON.parse(fs.readFileSync(path.join(r.planDir, 'meta.json'), 'utf8'));
  const wall = (meta.walls ?? []).find((w) => w.id === 'castle');
  const wg = wall?.waterGates?.[0];
  if (!body || !wg) return null;
  const xs = body.cells.map((c) => c[0]), zs = body.cells.map((c) => c[2]);
  const along = Math.max(...zs) - Math.min(...zs) > Math.max(...xs) - Math.min(...xs) ? 'z' : 'x';
  const ix = along === 'z' ? 2 : 0;
  const gv = wg.cells.map((c) => (along === 'z' ? c[1] : c[0]));
  const lo = Math.min(...gv), hi = Math.max(...gv);
  const inside = wall.inside; // [x0, z0, x1, z1]
  const mid = along === 'z' ? (inside[1] + inside[3]) / 2 : (inside[0] + inside[2]) / 2;
  const inSign = mid < lo ? -1 : 1; // the inside lies toward -axis when its centre is before the grate
  const lanes = [...new Set(body.cells.map((c) => (along === 'z' ? c[0] : c[2])))].sort((a, b) => a - b);
  return { body, wall, wg, along, ix, lo, hi, inSign, lanes, meta, grateCols: new Set(wg.cells.map(([x, z]) => k2(x, z))) };
}

/**
 * The push stand: mobs dropped into the reach 2 cells inside the grate, pushed at it (Motion toward outside, every 150 ms for 20 s; their
 * AI on), then counted beyond the grate's outer face. A lane's centre and a lane boundary (between two bars' posts) each.
 */
async function pushStand(ctx, G, tag) {
  const { L } = ctx;
  await L.cmd('/difficulty normal');
  await L.cmd('/time set 18000');
  const out = G.inSign < 0 ? 1 : -1; // the outward sign along the axis
  const startV = out > 0 ? G.lo - 2 : G.hi + 2;
  const y = G.body.level - 1;
  const mid = G.lanes[(G.lanes.length - 1) >> 1];
  const spots = [['zombie', mid + 0.5], ['zombie', mid + 1.0], ['villager', mid + 0.5], ['villager', mid], ['spider', mid + 0.5]];
  for (const [t, lat] of spots) {
    const [x, z] = G.along === 'z' ? [lat, startV + 0.5] : [startV + 0.5, lat];
    await L.cmd(`/summon minecraft:${t} ${x} ${y} ${z} {PersistenceRequired:1b,Tags:["hyc_push"],Silent:1b}`);
  }
  const m = G.along === 'z' ? `0.0d,0.0d,${(0.35 * out).toFixed(2)}d` : `${(0.35 * out).toFixed(2)}d,0.0d,0.0d`;
  const t0 = Date.now();
  while (Date.now() - t0 < 20_000) { await L.cmd(`/execute as @e[tag=hyc_push] run data merge entity @s {Motion:[${m}]}`); await sleep(150); }
  const pos = (await L.cmd('/execute as @e[tag=hyc_push] run data get entity @s Pos')).messages ?? [];
  const mobs = pos.map((p, i) => {
    const v = (/\[([^\]]*)\]/.exec(p)?.[1] ?? '').split(',').map((s) => Number.parseFloat(s));
    const a = G.along === 'z' ? v[2] : v[0];
    const beyond = out > 0 ? a > G.hi + 1 : a < G.lo;
    return { pos: v.map((q) => Math.round(q * 100) / 100), beyond };
  });
  await L.cmd('/kill @e[tag=hyc_push]');
  await L.cmd('/time set 6000');
  return { tag, summoned: spots.length, alive: mobs.length, beyond: mobs.filter((q) => q.beyond).length, mobs };
}

/** Vanilla's villager from the reach's inside bank to its outside bank: canReach, and no path cell in the grate's columns. */
async function navAcross(ctx, G) {
  const { L } = ctx;
  const out = G.inSign < 0 ? 1 : -1;
  const lat = G.lanes[0] - 1; // the bank beside the first lane
  const vIn = out > 0 ? G.lo - 3 : G.hi + 3, vOut = out > 0 ? G.hi + 3 : G.lo - 3;
  const feet = (v) => (G.along === 'z' ? [lat - 1, G.body.level + 2, v] : [v, G.body.level + 2, lat - 1]);
  const water = (v) => (G.along === 'z' ? [G.lanes[1] ?? G.lanes[0], G.body.level, v] : [v, G.body.level, G.lanes[1] ?? G.lanes[0]]);
  const res = {};
  for (const [k, a, b] of [['bank', feet(vIn), feet(vOut)], ['water', water(vIn), water(vOut)]]) {
    const r = await L.call('dev.nav.villager', { from: a, to: b, range: 256, cells: true }, 120_000).catch((e) => ({ error: String(e.message ?? e) }));
    const cells = r.cells ?? [];
    res[k] = { canReach: !!r.canReach, nodes: r.nodes ?? null, throughGrate: cells.filter(([x, y, z]) => G.grateCols.has(k2(x, z)) && y <= G.wg.lintel).length, error: r.error };
  }
  return res;
}

async function gateIngame(ctx) {
  const { L, check, json, core } = ctx;
  const out = {};
  // ---- refusals through Regions.checkPlan: a sealed wall, a wall at its gates.max
  {
    await freshGate(ctx, 'G6B HYc Refuse', 'default');
    for (const v of ['sealed', 'max']) {
      const c = await checkGate(ctx, v, { variant: v });
      const a = (c.check?.parts ?? []).find((q) => q.part === 'race');
      out[v] = { overall: c.check?.overall ?? null, race: a ? { class: a.class, reasons: a.reasons } : null };
      check(a?.class === 'refused' && a.reasons?.[0]?.code === 'UNREACHABLE' && a.reasons[0].evidence?.kind === 'wall' && a.reasons[0].evidence?.why === v, `item 14 (${v}): Regions.checkPlan refuses the water gate under ${v === 'sealed' ? 'a sealed wall (S-K1-1)' : 'a wall at its gates.max'}: ${a?.class} ${a?.reasons?.[0]?.code} ${json(a?.reasons?.[0]?.evidence ?? null)}`);
    }
    await L.leaveWorld();
  }
  // ---- the water gate: exact rules, realised from its approval artifact, censused, crossed, pushed, removed exactly
  {
    const g = await freshGate(ctx, 'G6B HYc Gate', 'exact');
    const c = await checkGate(ctx, 'gate', {});
    const parts = (c.check?.parts ?? []).map((a) => [a.part, a.class]);
    const wallA = (c.check?.parts ?? []).find((a) => a.part === 'castle');
    out.check = { overall: c.check?.overall ?? null, parts, volumePass: c.volumePass ?? null, crossing: wallA?.geometry?.crossing ?? null, waterGates: wallA?.geometry?.waterGates ?? null };
    check(c.check?.overall === 'READY' && parts.every(([, k]) => k === 'fits'), `item 9 (water gate): hy_gate_demo through Regions.checkPlan's two-plan flow: ${out.check.overall} (${json(parts)}; volumes ${json(c.volumePass ?? null)})`);
    // (§10) the reach's approval guard: per body, flat runs (H RC3)
    const art = c.check?.artifactSha ? findArtifact(L, c.check.artifactSha) : null;
    const guards = (art?.guards ?? []).filter((q) => q.body === 'race_r1');
    out.check.guards = guards.map((q) => ({ part: q.part, body: q.body, kind: q.kind, runs: q.runs?.length }));
    check(guards.length === 1 && guards[0].kind === 'body' && guards[0].fluids === true && Array.isArray(guards[0].runs) && guards[0].runs.every(Number.isInteger), `item 9 (water gate): the reach's guard is per body and flat ({part, body, kind: body, fluids, volume, runs}: ${json(out.check.guards)})`);
    check(json(wallA?.geometry?.crossing) === json({ type: 'wall', over: 'course', gate: 'water', course: 'race' }), `item 14: the wall's answer carries crossing ${json(wallA?.geometry?.crossing ?? null)}`);
    const box = boxOf(g);
    const file = await core.snap(ctx, box, 'hyc-gate');
    const r = await core.realiseApproved(ctx, c.check?.artifactSha);
    if (r.refused) { check(false, `item 9: realiseApproved refused (${json(r.refused)})`); return out; }
    r.planDir = path.join(L.SIDECAR_DATA, 'regions', 'plans', r.planId);
    out.realise = { region: r.region, state: r.view.state, fluids: r.fluids };
    check(r.view.state === 'PLACED' && r.fluids.length === 1 && r.fluids.every((x) => x.state === 'settled'), `item 9: realised from the approved artifact, PLACED with the reach settled (${r.view.state}; ${json(r.fluids.map((x) => [x.part, x.body, x.state, x.settledAt]))})`);
    const G = gateGeometry(r);
    check(!!G, 'item 14: the realised plan carries the water gate (meta walls[].waterGates, the reach race_r1)');
    if (!G) return out;
    const cen = await core.censusOf(ctx, G.body, null, r.bodies);
    const grateStates = G.body.grate.map(([x, y, z]) => cen.fluids.get(`${x},${y},${z}`) ?? 'none');
    const joined = grateStates.filter((s) => /^minecraft:iron_bars\[/.test(s) && /waterlogged=true/.test(s) && (s.match(/(east|west|north|south)=true/g) ?? []).length >= 2).length;
    out.census = { ok: cen.ok, sources: cen.sources, mismatch: cen.mismatch, outside: cen.outside, ticks: cen.ticks, grate: G.body.grate.length, joined, sample: grateStates.slice(0, 3) };
    check(cen.ok && cen.ticks === 0 && cen.sources === G.body.cells.length, `item 14: the reach's census equals its plan: ${cen.sources}/${G.body.cells.length} sources (the ${G.body.grate.length} grate cells as waterlogged bars), 0 outside, no fluid tick (${json(cen.mismatch)})`);
    check(joined === G.body.grate.length, `item 14: every grate cell is joined bars (${joined}/${G.body.grate.length}; e.g. ${grateStates[0]}): unjoined posts let a 0.6-wide mob through (HANDOFF-HYc's probe)`);
    // the lintel and the wall over the grate
    let lintel = 0;
    for (const [x, z] of G.wg.cells) { const res = await L.cmd(`/execute unless block ${x} ${G.wg.lintel} ${z} minecraft:air`); if (Number(res.result) > 0 || res.success) lintel++; }
    out.lintel = { cells: G.wg.cells.length, solid: lintel, y: G.wg.lintel };
    check(lintel === G.wg.cells.length, `item 14: the lintel stands over every grate column at the reach's open top y ${G.wg.lintel} (${lintel}/${G.wg.cells.length})`);
    // vanilla's villager never through the grate
    out.nav = await navAcross(ctx, G);
    check(Object.values(out.nav).every((v) => !v.error && v.throughGrate === 0), `item 14: vanilla dev.nav.villager from the reach's inside to its outside (bank and water) never paths through the grate or under the lintel (${json(out.nav)})`);
    // the push stand
    out.push = await pushStand(ctx, G, 'grate');
    check(out.push.alive >= 3 && out.push.beyond === 0, `item 14: the push stand: ${out.push.alive} of ${out.push.summoned} mobs (zombies, villagers, a spider) pushed at the grate from inside for 20 s, ${out.push.beyond} beyond it (${json(out.push.mobs.map((q) => q.pos))})`);
    const rm = await core.removeWait(ctx, r.region);
    await sleep(3000);
    const df = await core.diff(ctx, box, file);
    out.undo = { state: rm.state, seconds: rm.seconds, mismatches: df.mismatches, classes: df.classes, sample: df.sample };
    check(rm.state === 'REMOVED' && df.mismatches === 0, `item 14 / 5: Regions.remove restores the box exactly under the exact rules, the lintel, the wall over it and the grate included: E-flat ${df.mismatches} (fluid cells by state; ${rm.seconds} s)`, df.sample);
    await L.leaveWorld();
  }
  // ---- the negative control: the same push through open water under the lintel (no_grate) gets through
  {
    await freshGate(ctx, 'G6B HYc Open', 'exact');
    const c = await checkGate(ctx, 'open', { variant: 'no_grate' });
    const r = await core.realiseApproved(ctx, c.check?.artifactSha);
    if (r.refused || !c.check?.artifactSha) { check(false, `item 14 (control): no_grate did not realise (${json(r.refused ?? c.check?.overall)})`); return out; }
    r.planDir = path.join(L.SIDECAR_DATA, 'regions', 'plans', r.planId);
    const G = gateGeometry(r);
    out.control = await pushStand(ctx, G, 'open');
    check(out.control.beyond >= 1, `item 14 (negative control): with the water under the lintel left open, the same push gets ${out.control.beyond} of ${out.control.alive} mobs through (so the grate's 0 is the grate's)`);
    await core.removeWait(ctx, r.region);
    await L.leaveWorld();
  }
  return out;
}

// ------------------------------------------------------------------ the look (client)

function installBible(ctx, id) {
  const dst = path.join(ctx.L.GAME_DIR, 'architect', 'bibles', id, 'versions', '1');
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(ctx.root, 'scenarios', 'bibles', `${id}.json`), path.join(dst, 'bible.json'));
}

async function shot(ctx, name, eye, at) {
  const { L, OUT } = ctx;
  await L.call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator', fov: 70 }, 60_000);
  await L.call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
  await L.settle(1500);
  const r = await L.call('dev.screenshot', { name: `hyc_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
  const dir = path.join(OUT, 'look-hyc');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `${name}.png`);
  fs.copyFileSync(r.path, dst);
  return { name, eye, at, file: dst };
}

async function gateLook(ctx) {
  const { L, check, json, core } = ctx;
  const out = { shots: [], bibles: {} };
  for (const b of LOOK_BIBLES) if (b) installBible(ctx, b);
  for (const bible of LOOK_BIBLES) {
    const tag = bible ?? 'default';
    await freshGate(ctx, `G6B HYc Look ${tag}`, 'exact');
    const c = await checkGate(ctx, `look-${tag}`, { moat: true }, bible ? { bible } : {});
    const ok = c.check?.artifactSha && (c.check.parts ?? []).every((a) => ['fits', 'adjusted'].includes(a.class));
    check(!!ok, `look (${tag}): the castle with its moat and water gate checks (${c.check?.overall}; ${json((c.check?.parts ?? []).map((a) => [a.part, a.class]))}; recorded, not judged)`);
    if (!ok) { await L.leaveWorld(); continue; }
    const r = await core.realiseApproved(ctx, c.check.artifactSha);
    if (r.refused) { await L.leaveWorld(); continue; }
    r.planDir = path.join(L.SIDECAR_DATA, 'regions', 'plans', r.planId);
    const G = gateGeometry(r);
    out.bibles[tag] = { state: r.view.state, fluids: r.fluids.map((x) => [x.body, x.state]) };
    await L.cmd('/time set 6000');
    if (!G) continue;
    const out1 = G.inSign < 0 ? 1 : -1;
    const [cx, cz] = [G.wg.cells.reduce((s, q) => s + q[0], 0) / G.wg.cells.length, G.wg.cells.reduce((s, q) => s + q[1], 0) / G.wg.cells.length];
    const y = G.wg.lintel;
    const P = (a, lat, dy) => (G.along === 'z' ? [cx + lat, y + dy, cz + a * out1] : [cx + a * out1, y + dy, cz + lat]);
    for (const [name, eye, at] of [
      ['outside', P(14, 6, 5), P(0, 0, 0)],
      ['low', P(3, 0, 0.6), P(0, 0, -0.6)],
      ['inside', P(-12, -5, 6), P(0, 0, 1)],
      ['high', P(30, 18, 26), P(-6, 0, 0)],
    ]) out.shots.push({ bible: tag, ...(await shot(ctx, `${tag}_${name}`, eye, at)) });
    await L.leaveWorld();
  }
  check(out.shots.length > 0, `look: ${out.shots.length} shot(s) of the water gate in the castle wall over the moat (recorded, Noah's call)`);
  return out;
}

/** kit tests: hy-c.test.mjs, and K1a's wall tests (line.mjs/wall.mjs/checkWalls.mjs moved) with the K1 and T3 batch tests. */
async function gateUnit(ctx) {
  const { root, check } = ctx;
  const run = (files) => {
    const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
    const t = `${r.stdout}${r.stderr}`;
    const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
    return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
  };
  const out = {};
  out.hyc = run(['kit/test/hy-c.test.mjs']);
  check(out.hyc.code === 0 && out.hyc.fail === 0 && out.hyc.pass >= 7, `item 14 (kit, HY-c): the crossing, the grate, the lintel (the wall never on the course), M2:wall closure 0 with the grate, gates.max and sealed walls refused UNREACHABLE {kind: wall}, no_lintel/lintel_low/no_grate caught, the wire shapes, determinism: ${out.hyc.pass} pass, ${out.hyc.fail} fail`, out.hyc.failing);
  const k1 = ['kit/test/plan-k1a.test.mjs', 'kit/test/k1-foundation.test.mjs', 'kit/test/plan-k1-batch.test.mjs', 'kit/test/plan-t3-batch.test.mjs'].filter((f) => fs.existsSync(path.join(root, f)));
  out.k1 = run(k1);
  check(out.k1.code === 0 && out.k1.fail === 0, `K1a's wall tests after HY-c's wall.mjs (${k1.join(', ')}): ${out.k1.pass} pass, ${out.k1.fail} fail`, out.k1.failing);
  return out;
}

export const items = {
  unit: [{ name: 'hyc-unit', run: gateUnit }],
  ingame: [{ name: 'hyc-water-gate', run: gateIngame }],
  look: [{ name: 'hyc-look', run: gateLook }],
};
