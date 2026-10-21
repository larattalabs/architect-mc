// (6c F3 §10 item 14) The look (recorded; N-F3-2's scale and look are Noah's call at the gallery): on a client, each fixture realised
// on a flat world through Regions.checkPlan and realiseApproved, then camera shots of every grown form: each giant tree species and
// mushroom (grove_demo's plan on its flat claim: the eight overworld species and both mushrooms), the nether's giants (v77), roots
// down a bank (v74), the cave's stalactites (v75, lit by night vision), a coral pond (the coral lane's v73, when present). Writes
// look/<name>.png and look-shots.json (each shot's name, what, eye and target) under the step's OUT.
import fs from 'node:fs';
import path from 'node:path';
import { buildWorld, fixture, grownCells } from './gate6cf3-game.mjs';

/** The look's fixtures: [tag, plan source, what]. */
async function lookSet(ctx) {
  const { GROVE_PLAN } = await ctx.imp('regions/grove_demo.mjs');
  const set = [
    ['grove', { on: 'flat', terrain: { W: 192, D: 192, x0: 3392, z0: -1536 }, plan: GROVE_PLAN }, 'every overworld giant tree species and both giant mushrooms (grove_demo on its flat claim)'],
    ['nether', fixture(ctx, 'valid/v77_f3_nether.json'), 'the nether\'s giants: crimson and warped (v77)'],
    ['bank', fixture(ctx, 'valid/v74_f3_roots_bank.json'), 'roots down an 8-high bank (v74)'],
    ['cave', fixture(ctx, 'valid/v75_f3_stalactites.json'), 'stalactites in a cave (v75)'],
  ];
  const coral = path.join(ctx.KIT, 'test', 'fixtures', 'plan', 'valid', 'v73_f3_coral_pond.json');
  if (fs.existsSync(coral)) set.push(['coral', JSON.parse(fs.readFileSync(coral, 'utf8')), 'coral in a pond and a fountain (v73)']);
  return set;
}

export async function look(ctx) {
  const { L, OUT, log, check, core } = ctx;
  const B = await import('./gate6chy-b.mjs');
  const dir = path.join(OUT, 'look');
  fs.mkdirSync(dir, { recursive: true });
  const shots = [];
  const shot = async (name, eye, at, what, fov = 70) => {
    await L.call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator', fov }, 60_000);
    await L.call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
    await L.settle(2500);
    const q = await L.call('dev.screenshot', { name: `f3_${name}`, frames: 12, chunkTimeoutMs: 60_000 }, 180_000);
    const file = path.join(dir, `${name}.png`);
    fs.copyFileSync(q.path, file);
    log(`  shot ${name}`);
    shots.push({ name, what, eye, at, file: path.relative(OUT, file) });
  };
  for (const [tag, fx, what] of await lookSet(ctx)) {
    await L.fresh(`G6B F3 look ${tag}`, core.FLAT);
    await L.setRules('exact');
    const { W } = await buildWorld(ctx, fx);
    const wp = await B.worldPlan(ctx, fx, W);
    const ck = await L.call('dev.region.checkPlan', { plan: wp.plan, claim: W.claim, owner: core.OWNER, anchors: wp.anchors, load: 'generate' }, 1_800_000);
    if (ck.check?.overall !== 'READY') { check(false, `item 14 (${tag}): the look's plan is ${ck.check?.overall}`); await L.leaveWorld(); continue; }
    const r = await core.realiseApproved(ctx, ck.check.artifactSha);
    if (r.refused || r.view.state !== 'PLACED') { check(false, `item 14 (${tag}): not placed (${JSON.stringify(r.refused ?? r.view.state)})`); await L.leaveWorld(); continue; }
    const g = await grownCells(ctx, path.join(L.SIDECAR_DATA, 'regions', 'plans', r.planId), r.ir);
    await L.cmd('/time set 6000');
    await L.cmd('/weather clear');
    if (tag === 'cave') await L.cmd('/effect give @s minecraft:night_vision infinite 0 true');
    // each form: from outside the group (along the line from the group's middle through the form), back by its size, a little over its
    // middle, so no other form stands between (a cave form: from inside the cave, level)
    let ga = [Infinity, Infinity], gb = [-Infinity, -Infinity];
    for (const k of g.cells.keys()) { const c = k.split(',').map(Number); ga = [Math.min(ga[0], c[0]), Math.min(ga[1], c[2])]; gb = [Math.max(gb[0], c[0]), Math.max(gb[1], c[2])]; }
    const gmid = [(ga[0] + gb[0]) / 2, (ga[1] + gb[1]) / 2];
    for (const f of g.byForm) {
      let a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
      for (const k of f.cells.keys()) { const c = k.split(',').map(Number); for (let i = 0; i < 3; i++) { a[i] = Math.min(a[i], c[i]); b[i] = Math.max(b[i], c[i]); } }
      const mid = [(a[0] + b[0]) / 2 + 0.5, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + 0.5];
      const span = Math.max(b[0] - a[0], b[1] - a[1], b[2] - a[2], 6);
      const name = `${tag}_${f.id.replace(/^f_/, '')}`;
      const desc = `${f.generator} ${f.id}: ${f.cells.size} cells, ${b[1] - a[1] + 1} high, ${Math.max(b[0] - a[0], b[2] - a[2]) + 1} across`;
      if (f.generator === 'stalactites' || f.generator === 'roots') {
        const eye = f.generator === 'roots' ? [mid[0] - 10, mid[1] + 1, mid[2] + 4] : [mid[0] + 8, mid[1] - 1, mid[2] + 8];
        await shot(name, eye, mid, desc);
      } else {
        const d = span * 0.9 + 8;
        let vx = mid[0] - gmid[0], vz = mid[2] - gmid[1];
        const n = Math.sqrt(vx * vx + vz * vz);
        if (n < 4) { vx = 0.7; vz = 0.7; } else { vx /= n; vz /= n; }
        await shot(name, [mid[0] + d * vx, a[1] + span * 0.45 + 2, mid[2] + d * vz], [mid[0], a[1] + (b[1] - a[1]) * 0.45, mid[2]], desc);
      }
    }
    // coral (v73): no grown form; the decor of each body (the body op's `decor`), shot over the water and from under its surface
    if (tag === 'coral') {
      const { bodiesOf } = await import('./gate6chy-core.mjs');
      for (const b of bodiesOf(r.ir).filter((q) => q.decor.length)) {
        let a = [Infinity, Infinity, Infinity], z = [-Infinity, -Infinity, -Infinity];
        for (const c of b.decor) for (let i = 0; i < 3; i++) { a[i] = Math.min(a[i], c[i]); z[i] = Math.max(z[i], c[i]); }
        const mid = [(a[0] + z[0]) / 2 + 0.5, a[1] + 0.5, (a[2] + z[2]) / 2 + 0.5];
        const span = Math.max(z[0] - a[0], z[2] - a[2], 6);
        const top = Math.max(...b.cells.map((c) => c[1]));
        const desc = `coral in ${b.id} (${b.part}): ${b.decor.length} decor cells, ${span + 1} across`;
        await shot(`coral_${b.part}_over`, [mid[0] + span * 0.5, top + span * 0.7 + 4, mid[2] + span * 0.7], mid, `${desc}: over the water`);
        // under the surface: the body's top-level water cell nearest a point off the patch's corner (an eye in the water, not the shell)
        const want = [mid[0] + span * 0.5, mid[2] + span * 0.5];
        const water = b.cells.filter((c) => c[1] === top && !b.decor.some((d) => d[0] === c[0] && d[1] === c[1] && d[2] === c[2]));
        const w = water.reduce((m, c) => (Math.hypot(c[0] + 0.5 - want[0], c[2] + 0.5 - want[1]) < Math.hypot(m[0] + 0.5 - want[0], m[2] + 0.5 - want[1]) ? c : m), water[0]);
        if (w) await shot(`coral_${b.part}_under`, [w[0] + 0.5, top + 0.4, w[2] + 0.5], mid, `${desc}: under the surface`, 75);
      }
    }
    // an overview of the fixture (grown forms only)
    if (g.cells.size) {
      let a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
      for (const k of g.cells.keys()) { const c = k.split(',').map(Number); for (let i = 0; i < 3; i++) { a[i] = Math.min(a[i], c[i]); b[i] = Math.max(b[i], c[i]); } }
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const span = Math.max(b[0] - a[0], b[2] - a[2], 16);
      if (tag === 'bank') await shot(`${tag}_overview`, [mid[0] - 22, b[1] + 6, mid[2] + 10], mid, `${what}: overview`, 75);
      else if (tag !== 'cave') await shot(`${tag}_overview`, [mid[0] + span * 0.6, b[1] + span * 0.35, mid[2] + span * 0.8], mid, `${what}: overview`, 75);
    }
    await L.leaveWorld();
  }
  fs.writeFileSync(path.join(OUT, 'look-shots.json'), `${JSON.stringify(shots, null, 1)}\n`);
  check(shots.length >= 10, `item 14 (recorded): ${shots.length} shots for the gallery (look/, look-shots.json): ${shots.map((s) => s.name).join(', ')}`);
  return { shots: shots.length, dir };
}
