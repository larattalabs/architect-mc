#!/usr/bin/env node
// Phase 7b slice ST gate (the standalone player path; docs/CONTRACT.md "Phase 7b" §3 row 8, N-7b-6) against a dev CLIENT of the ST run
// worktree (GATE6B_RUN, default `../architect-mc-ST-run`; the sim designer, no Claude): the plot marker, its HUD, the ghost and the Library
// are client UI, so this gate runs on a client (screenshots for the glance gallery). $0: no Claude call anywhere. Ports 8904/8905.
//
//   node tools/gate7bst.mjs <step>
//     start [world] | stop | base      the client and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit      (st-unit)              offline: kit/test/st.test.mjs (the standalone spec rules over the six 7bF fixtures and DS's cliffs, a
//                                      turned cliff, refusals, affordances.mjs --standalone) and sidecar/test/site-analyse.test.ts
//     ingame    (st-ingame)            in game, the sim designer: cliff_face built by /fill in a flat world; Mark a plot… on its lot, the fit
//                                      picker set to attach_to_cliff, the sample (the fixture's own sha, its walk_top port), the frame
//                                      confirmed; Design it (the sim) -> a site-bound entry with the PINNED badge; a plain placement refused;
//                                      Place on the plot -> the ghost on the site's frame; the drop warning provoked (and gone when the land
//                                      is back); placed (the record bound), Remove exact (the volume's hash as before); Site variant here
//                                      onto DS's cliff_east (a SITE derivation, placed and removed exact). Screenshots: the picker (GUI
//                                      scale 2 and 4), the frame, the ghost, the drop warning, the Library card and detail with the badge
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7b-st/<step>.json in the main checkout (GATE7BST_OUT overrides), shots/, all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-ST-run');
process.env.GATE6B_OUT = process.env.GATE7BST_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7b-st');
process.env.GATE6B_SIDECAR_PORT ??= '8904';
process.env.GATE6B_DEV_PORT ??= '8905';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient, call, cmd } = L;

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const SHOTS = path.join(OUT, 'shots');

const steps = {};
async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data, error;
  log(`== ${name}`);
  try {
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  if (!['stop', 'start'].includes(name)) L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice ST is $0: the sim designer only, no Claude call' }, null, 2)}\n`);
}

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B ST Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  for (const name of [BASE, FLAT]) await L.ensureBase(name);
  spendZero();
  return { worlds: [BASE, FLAT] };
};

// ------------------------------------------------------------------ offline

function nodeTest(files, timeout = 1_800_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
steps.unit = async () => {
  const out = {};
  out.kit = nodeTest(['kit/test/st.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 7, `the standalone spec (kit/test/st.test.mjs: the six 7bF fixtures and DS's cliffs re-derived, every fit example built on its derived spec, a turned cliff, the refusals, affordances.mjs --standalone): ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const v = spawnSync('npx', ['vitest', 'run', 'test/site-analyse.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 1_800_000 });
  const t = `${v.stdout}${v.stderr}`;
  out.sidecar = { code: v.status, tests: (/Tests\s+(.*)$/m.exec(t) ?? [])[1] ?? '?' };
  check(v.status === 0, `the helper's site.analyse with standalone (sidecar/test/site-analyse.test.ts): ${out.sidecar.tests}`);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ helpers

/** Builds a fixture volume's terrain by /fill (columns with the same runs along x merged): ROCK stone, SOIL dirt (gate7bds' builder). */
async function buildFixture(v) {
  const { VOXEL_CLASSES } = await imp('lib/region/volume.mjs');
  const BLOCK = { ROCK: 'stone', SOIL: 'dirt', LOG: 'oak_log', LEAVES: 'oak_leaves[persistent=true]', PLAYER: 'cobblestone' };
  const b = v.box, W = v.width, H = v.height, D = v.depth;
  const runsOf = (i, k) => {
    const out = [];
    for (let j = 0; j < H;) {
      const c = v.classes[(i * D + k) * H + j];
      let e = j;
      while (e + 1 < H && v.classes[(i * D + k) * H + e + 1] === c) e++;
      const name = VOXEL_CLASSES[c];
      if (name !== 'AIR') {
        if (!BLOCK[name]) throw new Error(`the fixture has ${name} cells (this builder writes ${Object.keys(BLOCK).join(', ')})`);
        out.push([j, e, BLOCK[name]]);
      }
      j = e + 1;
    }
    return out;
  };
  let fills = 0;
  for (let y = b.minY; y <= b.maxY; y += 16) { await cmd(`/fill ${b.minX} ${y} ${b.minZ} ${b.maxX} ${Math.min(b.maxY, y + 15)} ${b.maxZ} air`); fills++; }
  for (let k = 0; k < D; k++) {
    let i = 0;
    while (i < W) {
      const r = runsOf(i, k), key = json(r);
      let e = i;
      while (e + 1 < W && json(runsOf(e + 1, k)) === key) e++;
      for (const [j0, j1, blk] of r) { await cmd(`/fill ${b.minX + i} ${b.minY + j0} ${b.minZ + k} ${b.minX + e} ${b.minY + j1} ${b.minZ + k} ${blk}`); fills++; }
      i = e + 1;
    }
  }
  return fills;
}
const load = (dir) => ({ site: JSON.parse(fs.readFileSync(path.join(dir, 'site.json'), 'utf8')), file: path.join(dir, 'volume.bin') });
const volHash = async (b) => (await call('dev.box.hash', { min: [b.minX, b.minY, b.minZ], max: [b.maxX, b.maxY, b.maxZ] }, 300_000)).sha256;
async function shot(name, { hideHud = false } = {}) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const r = await call('dev.screenshot', { name: `st-${name}`, hideHud, frames: 6 }, 180_000);
  const dest = path.join(SHOTS, `st-${name}.png`);
  try { fs.copyFileSync(r.path, dest); } catch { /* the path the client gave stays the evidence */ }
  return fs.existsSync(dest) ? dest : r.path;
}
async function until(what, fn, ms = 120_000, every = 1000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`${what}: not after ${ms / 1000}s`);
    await call('dev.wait', { ms: every }, every + 30_000);
  }
}
async function waitDesign(id, ms = 600_000) {
  return until(`design ${id}`, async () => {
    const d = await call('dev.ds.design', { designId: id }, 30_000);
    return ['DONE', 'FAILED', 'CANCELLED'].includes(d.status) ? d : null;
  }, ms);
}
/** Mark a plot on a fixture's lot (its corners at the lot's ground row, height the lot's), with a fit: -> the plot state after the sample. */
async function markSitePlot(lot, fit, { shots = false, locked = false } = {}) {
  const H = lot.maxY - lot.minY + 1;
  if (!locked) {
    await call('dev.plot.start', { height: H });
  } else {
    await call('dev.plot.state');
  }
  await call('dev.plot.corner', { x: lot.minX, y: lot.minY, z: lot.minZ, confirm: true });
  if (!locked) await call('dev.plot.fit', { fit });
  let s = await call('dev.plot.corner', { x: lot.maxX, y: lot.minY, z: lot.maxZ, confirm: false });
  const picker = { phase: s.phase, fit: s.fit, height: s.height, plot: s.plot };
  const pics = {};
  if (shots) {
    pics.picker = await shot('picker');
    await call('dev.gui.scale', { scale: 4 });
    pics.picker4 = await shot('picker-gui4');
    await call('dev.gui.scale', { scale: 2 });
  }
  if (locked) {
    const nope = await call('dev.plot.fit', { fit: 'on_pad' }).then(() => null, (e) => String(e?.message ?? e));
    picker.lockRefused = nope;
  }
  // F keeps the plot: the picker cycles (Shift+F back) only in the corner steps; Enter on the second corner samples the site
  await call('dev.plot.corner', { x: lot.maxX, y: lot.minY, z: lot.maxZ, confirm: true });
  s = await until('the sample', async () => {
    const st = await call('dev.plot.state');
    return st.phase === 'frame' || (st.phase === 'second_corner' && /^Not a /.test(st.status ?? '')) ? st : null;
  }, 300_000);
  return { picker, frame: s, shots: pics };
}

// ------------------------------------------------------------------ in game (st-ingame)

steps.ingame = async () => {
  await ensure();
  const { decodeArvx } = await imp('lib/region/volume.mjs');
  const out = { shots: {} };
  await L.fresh('G6B ST Sites', FLAT);
  await L.setRules('exact');
  await call('dev.gui.scale', { scale: 2 });
  const cliff = load(path.join(KIT, 'test', 'fixtures', 'site', 'cliff_face'));
  const east = load(path.join(KIT, 'test', 'fixtures', 'ds', 'cliff_east'));
  for (const fx of [cliff, east]) {
    const v = decodeArvx(fs.readFileSync(fx.file));
    const b = v.box;
    await L.tp((b.minX + b.maxX) >> 1, b.maxY + 20, (b.minZ + b.maxZ) >> 1);
    fx.fills = await buildFixture(v);
    fx.box = b;
  }
  const lot = cliff.site.lot, vb = cliff.box;
  // stand in front of the face (south of it), looking north at the cliff
  await L.tp((lot.minX + lot.maxX) >> 1, lot.minY + 2, lot.maxZ + 14, 180, 15);
  await call('dev.wait', { ms: 2500 }, 30_000);

  // 1. Mark a plot… with the fit picker: attach_to_cliff on the cliff's lot; the sample proposes the frame with the fixture's own port
  const m = await markSitePlot(lot, 'attach_to_cliff', { shots: true });
  out.shots.picker = m.shots.picker;
  out.shots.picker4 = m.shots.picker4;
  check(m.picker.phase === 'second_corner' && m.picker.fit === 'attach_to_cliff' && m.picker.height === lot.maxY - lot.minY + 1,
    `the fit picker: attach_to_cliff picked on the second corner (on_pad is the default), height ${m.picker.height}`, m.picker);
  const f = m.frame;
  const { lotId, ...want } = cliff.site.spec;
  const got = f.site ?? {};
  check(f.phase === 'frame' && got.volumeSha === want.volumeSha && json(got.ports) === json(want.ports) && json(got.frame) === json(want.frame) && got.lotId == null,
    `the sample: Survey.site's path froze the lot + 8 to the fixture's own sha ${String(got.volumeSha).slice(0, 12)}; the frame ${json(got.frame?.rotation)} and walk_top ${json(got.ports?.[0]?.at)} as the fixture's; no lot id (standalone)`, { status: f.status, got: got && { ...got, volumeBlobId: undefined } });
  out.shots.frame = await shot('frame');
  let st = await call('dev.plot.enter');
  check(!st.active && st.lastSite?.volumeSha === want.volumeSha, `Enter confirmed the frame: the plot and its site went back to the Design form`, { status: st.status });
  const form = (await call('dev.design.state')).form;
  check(form.size === 'plot' && form.site?.fit === 'attach_to_cliff' && form.massingFirst === false, `the Design form carries the SiteSpec (size plot, fit ${form.site?.fit}); no massing pass for a site design`, { size: form.size, maxSize: form.maxSize, massingFirst: form.massingFirst, errors: form.errors });

  // 2. Design it (the sim): a site-bound entry, the lot's size, the pin badge
  const sent = await call('dev.design.submit', { fields: { buildingType: 'house', style: 'rustic', name: 'ST Cliff House', critique: false } }, 120_000);
  check(!!sent.sent?.designId && !sent.sent?.error, `Design it: the request with its site sent (${sent.sent?.designId}${sent.sent?.error ? `, ${sent.sent.error}` : ''})`, sent.sent);
  const d = sent.sent?.designId ? await waitDesign(sent.sent.designId) : {};
  const entryId = d.entryId;
  check(d.status === 'DONE' && !!entryId, `the sim designed it into the site: ${entryId} (${d.step})`);
  const e = d.entry ?? {};
  check(e.binding?.volumeSha === want.volumeSha && e.binding?.fit === 'attach_to_cliff' && e.binding?.lotId == null && json(e.size) === json({ x: 16, y: 22, z: 12 }),
    `the entry is bound to the sampled site (SiteBinding ${json(e.binding && { fit: e.binding.fit, lotId: e.binding.lotId ?? null })}) and exactly the lot: ${json(e.size)}`);
  await until('the entry loaded', async () => (await call('dev.st.state', { blueprint: entryId })).pinned ?? null, 60_000);
  await call('dev.ui.open', { tab: 'library' });
  await call('dev.library.select', { entry: entryId });
  await call('dev.wait', { ms: 1500 }, 30_000);
  const lib = await call('dev.library.state');
  const card = (lib.cards ?? lib.visible ?? []).find((c) => c.id === entryId) ?? lib.selected ?? {};
  check(card.badge === 'PINNED' && card.pinnedFit === 'attach_to_cliff', `the Library card shows the pin badge (${card.badge}, ${card.pinnedFit})`, { badge: card.badge, pinnedFit: card.pinnedFit });
  out.shots.library = await shot('library-pin');
  await call('dev.screen', { open: null });

  // 3. N-7b-6: a plain placement of a pinned entry is refused; Place on the plot puts the ghost on the site's frame
  const plain = await call('dev.build.start', { blueprint: entryId }).then((x) => ({ ok: true, x }), (err) => ({ ok: false, err: String(err?.message ?? err) }));
  check(!plain.ok && /pinned to its site/.test(plain.err), `a plain placement of the pinned entry is refused: "${(plain.err ?? '').slice(0, 120)}"`);
  const before = await volHash(vb);
  await call('dev.design.place', { blueprint: entryId });
  const ready = async () => {
    const b = await call('dev.build.state');
    return b.serverVerdict && b.site ? b : null;
  };
  let g = await until('the server verdict on the site', ready, 60_000);
  check(json(g.origin) === json(want.frame.origin) && g.site?.volumeSha === want.volumeSha, `the ghost sits on the site's frame ${json(g.origin)} (${g.rotation ?? g.turns}), with the site`, { origin: g.origin, rotation: g.rotation });
  const notes0 = [...(g.conflicts?.notes ?? []), ...(g.serverVerdict?.notes ?? [])];
  check(notes0.some((n) => /approach by port walk_top .*the way in is the player's to build/.test(n)) && !notes0.some((n) => /opens onto a drop/.test(n)) && (g.serverVerdict?.refusals ?? []).length === 0,
    `the verdict is clean: the port note, no drop warning (the clifftop stands behind the port)`, { notes: notes0, refusals: g.serverVerdict?.refusals });
  out.shots.ghost = await shot('ghost');
  const rot = await call('dev.build.rotate', { turns: 1 });
  check(/Pinned to its site/.test(rot.status ?? '') && json(rot.origin) === json(want.frame.origin), `rotate is refused on the site's frame ("${rot.status}")`);

  // 4. the drop warning: the floor in front of walk_top dug out (the land drifts too), then put back
  const p0 = want.ports[0];
  const floor = [lot.minX + p0.at[0], lot.minY + p0.at[1] - 1, lot.minZ + p0.at[2] - 1];
  await cmd(`/setblock ${floor.join(' ')} minecraft:air`);
  g = await until('the drop warning', async () => {
    const b = await call('dev.build.state');
    const n = [...(b.conflicts?.notes ?? []), ...(b.serverVerdict?.notes ?? [])];
    return n.some((x) => /opens onto a drop/.test(x)) && b.serverVerdict?.notes?.some((x) => /opens onto a drop/.test(x)) ? b : null;
  }, 60_000);
  const dropNote = (g.serverVerdict.notes ?? []).find((x) => /opens onto a drop/.test(x));
  check(!!dropNote && dropNote.includes('port walk_top faces north') && (g.conflicts?.notes ?? []).some((x) => /opens onto a drop/.test(x)),
    `the drop warning in the HUD and in the server's verdict: "${dropNote}" (with the dug cell the land drifted: ${(g.serverVerdict.refusals ?? []).map((r) => r.split(':')[0]).join(', ') || 'no refusal'})`);
  out.shots.drop = await shot('drop-warning');
  await cmd(`/setblock ${floor.join(' ')} minecraft:dirt`);
  g = await until('the land back', async () => {
    const b = await call('dev.build.state');
    const n = [...(b.conflicts?.notes ?? []), ...(b.serverVerdict?.notes ?? [])];
    return b.serverVerdict && !n.some((x) => /opens onto a drop/.test(x)) && (b.serverVerdict.refusals ?? []).length === 0 ? b : null;
  }, 60_000);
  check(true, `the land back: the warning gone, the verdict clean again`);

  // 5. place, the record bound, Remove exact
  const placed = await call('dev.build.confirm', {}, 120_000);
  const site = placed.siteId;
  check(!!site && placed.placed, `placed on its site: ${site} (${placed.message})`);
  const rec = site ? await call('dev.pl.record', { site }) : {};
  check(rec.bound && rec.ext?.['architect_mc:site']?.volumeSha === want.volumeSha && rec.ext['architect_mc:site'].fit === 'attach_to_cliff', `the record carries its binding (ext architect_mc:site, fit attach_to_cliff)`, rec.ext);
  const ver = site ? await call('dev.site.verify', { site }, 120_000) : {};
  check(ver.mismatches === 0, `dev.site.verify: ${ver.owned} owned cells, 0 mismatches`);
  await L.tp((lot.minX + lot.maxX) >> 1, lot.minY + 6, lot.maxZ + 20, 180, 10);
  out.shots.placed = await shot('placed', { hideHud: true });
  const rm = site ? await call('dev.sites.remove', { site }, 60_000) : {};
  await until('the removal', async () => (await volHash(vb)) === before || null, 120_000, 2000).catch(() => null);
  const after = await volHash(vb);
  check(rm.removed && after === before, `Remove is exact: the cliff's volume ${vb.maxX - vb.minX + 1}x${vb.maxY - vb.minY + 1}x${vb.maxZ - vb.minZ + 1} hashes as before (${before.slice(0, 12)})`, { rm, before, after });

  // 6. Site variant here (N-7b-6: a pinned entry elsewhere only as a site variant of it) onto DS's cliff_east
  const elot = east.site.lot;
  await L.tp((elot.minX + elot.maxX) >> 1, elot.minY + 2, elot.maxZ + 14, 180, 15);
  await call('dev.wait', { ms: 2500 }, 30_000);
  st = await call('dev.st.variant', { entryId, height: elot.maxY - elot.minY + 1 }); // the new lot's height (PgUp/PgDn), not the source's
  check(st.plot?.active && st.plot.fitLocked && st.plot.fit === 'attach_to_cliff', `Site variant here…: plot marking with the fit locked to the entry's (${st.plot?.fit})`);
  const vm = await markSitePlot(elot, 'attach_to_cliff', { locked: true });
  check(/fixed to attach_to_cliff/.test(vm.picker.lockRefused ?? ''), `the locked picker refuses another fit ("${vm.picker.lockRefused}")`);
  const sampledEast = vm.frame.phase === 'frame' && vm.frame.site?.volumeSha === east.site.spec.volumeSha;
  check(sampledEast, `cliff_east sampled to its own sha ${String(vm.frame.site?.volumeSha).slice(0, 12)}, the frame proposed (${vm.frame.phase}: ${vm.frame.status})`);
  if (!sampledEast) {
    await call('dev.plot.cancel').catch(() => null);
    throw new Error(`the variant's sample failed (${vm.frame.phase}: ${vm.frame.status}): the rest of the variant flow skipped`);
  }
  await call('dev.plot.enter');
  const vs = await until('the site variant', async () => {
    const s2 = await call('dev.st.state');
    if (s2.variantError) return s2;
    if (!s2.variantRunning && !s2.plot?.active && !s2.variantEntry && !s2.placingSite) throw new Error(`the variant flow ended without a variant (${s2.plot?.status})`);
    return !s2.variantRunning && s2.variantEntry && s2.placingSite ? s2 : null;
  }, 600_000);
  const vid = vs.variantEntry;
  check(!!vid && !vs.variantError && vs.placingSite?.volumeSha === east.site.spec.volumeSha, `the site variant ${vid} installed ($0) and its ghost started on cliff_east's frame${vs.variantError ? `: ${vs.variantError}` : ''}`);
  const ve = vid ? await call('dev.ds.entry', { entryId: vid }) : {};
  check(ve.derivation?.kind === 'SITE' && ve.derivation?.source === entryId && ve.binding?.volumeSha === east.site.spec.volumeSha, `a SITE derivation of ${entryId} bound to cliff_east (${json(ve.size)})`);
  const ebefore = await volHash(east.box);
  await until('the variant verdict', ready, 60_000);
  const vp = await call('dev.build.confirm', {}, 120_000);
  const vsite = vp.siteId;
  const vrec = vsite ? await call('dev.pl.record', { site: vsite }) : {};
  check(!!vsite && vrec.bound, `the variant placed on cliff_east (${vsite}, bound)`);
  const vrm = vsite ? await call('dev.sites.remove', { site: vsite }, 60_000) : {};
  await until('the variant removal', async () => (await volHash(east.box)) === ebefore || null, 120_000, 2000).catch(() => null);
  check(vrm.removed && (await volHash(east.box)) === ebefore, `the variant's Remove is exact (cliff_east's volume hashes as before)`);

  out.entry = { entryId, binding: e.binding, size: e.size, site, variant: vid };
  out.fixtures = { cliff_face: cliff.fills, cliff_east: east.fills };
  await L.leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'ingame']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const rs = Object.values(j.results ?? {});
    rows.push(`| ${s} | ${rs.filter((r) => r.ok).length} ok | ${rs.filter((r) => !r.ok).length} failed | ${j.seconds}s |`);
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# 7b ST gate\n\n| step | ok | failed | time |\n|---|---|---|---|\n${rows.join('\n')}\n`);
  return { rows };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7bst.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
const bad = Object.values(results).filter((r) => !r.ok).length;
process.exit(bad ? 1 : 0);
