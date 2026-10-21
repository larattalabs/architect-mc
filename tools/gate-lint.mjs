#!/usr/bin/env node
// Fast checks P2: the lints' calibration probes in game (docs/FAST-CHECKS.md "Structure lint" -> "Calibration probe"; docs/GATES.md
// "Fast checks (P2)"), headless on the gate server, $0. The lints (tools/lint.mjs) stand in for in-game rows only while their models
// match this Minecraft version: the block-light model (kit light over the virtual world), the movers (vanilla villagers across the
// kit's decks: t3a-probe, k1b-probe) and the block registry (voc-registry). Each probe's verdict goes into the calibration record
// kit/test/fixtures/lint/calibration.json (Minecraft version, per probe pass, run, date) with `record` (CALIBRATION_WRITE=1, the
// release tier's last step). tools/lib/p2-trim.mjs reads it: a probe that failed, or a record for another Minecraft version, sends
// every trimmed P2 row back in game (the -smoke steps run the full in-game assertions) and FAILs the lint steps until recalibrated.
//
//   node tools/gate-lint.mjs light     each lamp fixture (fixtures.mjs: lantern post, soul lantern post, torch post, end rod, bollard,
//                                      hanging lantern) set over grass on a flat world by commands, the box dumped with its block
//                                      light, against the kit's light over the same blocks (check.mjs's propagation: emission, cost,
//                                      opacity): every cell of every lamp's 15-box equal
//   node tools/gate-lint.mjs record    the calibration record from this run's probe results (light.json here; t3a-probe, k1b-probe,
//                                      voc-registry from their own evidence dirs under the run's OUT): written with CALIBRATION_WRITE=1
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_OUT = process.env.GATELINT_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate-lint');
process.env.GATE6B_SIDECAR_PORT ??= '8896';
process.env.GATE6B_DEV_PORT ??= '8897';
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, fails, leaveWorld, log, results, root, state, tp } = L;
L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const FLAT = 'G6B Flat Base';
const CAL = path.join(root, 'kit', 'test', 'fixtures', 'lint', 'calibration.json');

const steps = {};
async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data, error;
  log(`== ${name}`);
  try { data = await steps[name](); } catch (e) { log(String(e?.stack ?? e)); error = String(e?.stack ?? e); check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`); }
  L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };

// ------------------------------------------------------------------ light

steps.light = async () => {
  await ensure();
  const { FIXTURES, fixtureFor, fixtureCells } = await imp('lib/region/fixtures.mjs');
  const { decodeArwd, Palette } = await imp('lib/region/vworld.mjs');
  const roles = { lantern_post: 'minecraft:lantern', soul_lantern_post: 'minecraft:soul_lantern', torch_post: 'minecraft:torch', end_rod: 'minecraft:end_rod', bollard: 'minecraft:glowstone', hanging_lantern: 'minecraft:lantern[hanging=true]' };
  await L.fresh('G6B P2 Light Probe', FLAT);
  await L.setRules('exact');
  // the flat base's ground: grass at y = g; lamps 24 apart along x (their lights never meet), each at x0 + 24 i, z0
  const x0 = 9000, z0 = 9000;
  await tp(x0 + 60, 90, z0);
  await call('dev.waitChunks', { timeoutMs: 120_000 }, 150_000).catch(() => null);
  const probe = path.join(OUT, 'light-ground.arwd.gz');
  await call('dev.region.dump', { box: [x0, -64, z0, x0, 120, z0], file: probe }, 120_000);
  const gd = await decodeArwd(fs.readFileSync(probe));
  let g = -64;
  for (let y = 120; y >= -64; y--) if (!/air$/.test(gd.palette[gd.cells[gd.at(x0, y, z0)]])) { g = y; break; }
  const placed = [];
  FIXTURES.forEach((kind, i) => {
    const f = fixtureFor(roles[kind], 'minecraft:oak_fence');
    const fc = fixtureCells(f, [x0 + 24 * i, g + 1, z0], { arm: 'north' });
    placed.push({ kind, fixture: f, ...fc });
  });
  for (const p of placed) for (const [x, y, z, s] of p.cells) await cmd(`/setblock ${x} ${y} ${z} ${s}`);
  await L.settle(3000);
  const box = [x0 - 16, g - 2, z0 - 16, x0 + 24 * (FIXTURES.length - 1) + 16, g + 18, z0 + 16];
  const file = path.join(OUT, 'light-probe.arwd.gz');
  await call('dev.region.dump', { box, file, light: true }, 600_000);
  const d = await decodeArwd(fs.readFileSync(file));
  // the kit's light over the dumped blocks (check.mjs blockLight's propagation: emission per state, opacity, cost), from the emitters
  const P = new Palette();
  const idx = d.palette.map((s) => P.of(s));
  const B = d.box;
  const W = B.maxX - B.minX + 1, H = B.maxY - B.minY + 1, D = B.maxZ - B.minZ + 1;
  const at = (x, y, z) => ((x - B.minX) * D + (z - B.minZ)) * H + (y - B.minY);
  const kl = new Uint8Array(W * H * D);
  const q = [];
  for (let x = B.minX; x <= B.maxX; x++) for (let z = B.minZ; z <= B.maxZ; z++) for (let y = B.minY; y <= B.maxY; y++) { const e = P.emit[idx[d.cells[d.at(x, y, z)]]]; if (e > 0) { kl[at(x, y, z)] = e; q.push([x, y, z]); } }
  for (let lv = 15; lv >= 2; lv--) for (const [x, y, z] of q.filter(([a, b, c]) => kl[at(a, b, c)] === lv)) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < B.minX || nx > B.maxX || ny < B.minY || ny > B.maxY || nz < B.minZ || nz > B.maxZ) continue;
      const n = idx[d.cells[d.at(nx, ny, nz)]];
      if (P.opaque[n]) continue;
      const v = lv - P.cost[n];
      if (v > kl[at(nx, ny, nz)]) { kl[at(nx, ny, nz)] = v; q.push([nx, ny, nz]); }
    }
  }
  const per = {};
  let cells = 0, differ = 0;
  const first = [];
  for (const p of placed) {
    const [lx, ly, lz] = p.lightAt;
    let n = 0, bad = 0;
    for (let x = lx - 15; x <= lx + 15; x++) for (let z = lz - 15; z <= lz + 15; z++) for (let y = Math.max(B.minY, ly - 3); y <= Math.min(B.maxY, ly + 15); y++) {
      if (x < B.minX || x > B.maxX || z < B.minZ || z > B.maxZ) continue;
      const s = idx[d.cells[d.at(x, y, z)]];
      if (P.opaque[s]) continue; // the light inside an opaque block is 0 in both
      n++;
      const game = d.light[d.at(x, y, z)], kit = kl[at(x, y, z)];
      if (game !== kit) { bad++; if (first.length < 12) first.push({ kind: p.kind, pos: [x, y, z], game, kit, state: d.palette[d.cells[d.at(x, y, z)]] }); }
    }
    per[p.kind] = { level: p.fixture.level, cells: n, differ: bad, gameAtLight: d.light[d.at(lx, ly, lz)] };
    cells += n; differ += bad;
    check(bad === 0, `light (${p.kind}, level ${p.fixture.level}): the game's block light equals the kit's at every one of ${n} open cells round it${bad ? ` (${bad} differ: ${JSON.stringify(first.filter((f) => f.kind === p.kind).slice(0, 3))})` : ''}`);
  }
  await leaveWorld();
  return { ground: g, box, per, cells, differ, first, pass: differ === 0 };
};

// ------------------------------------------------------------------ the calibration record

/** A probe step's verdict from its evidence JSON (results: every check ok). */
function verdictOf(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const res = Object.values(j.results ?? {});
    return { pass: res.length > 0 && res.every((r) => r.ok) && !j.error, checks: res.length, head: j.head ?? null, file: path.relative(path.resolve(OUT, '..'), file) };
  } catch { return null; }
}

steps.record = async () => {
  const gp = fs.readFileSync(path.join(root, 'mod', 'gradle.properties'), 'utf8');
  const minecraft = /minecraft_version\s*=\s*(\S+)/.exec(gp)?.[1];
  const ev = path.resolve(OUT, '..'); // the shard's evidence dir: the probes' own subdirs beside this one
  const probes = {
    light: verdictOf(path.join(OUT, 'light.json')),
    't3a-probe': verdictOf(path.join(ev, 'gate6c-t3a', 'probe.json')),
    'k1b-probe': verdictOf(path.join(ev, 'gate7a-k1b', 'probe.json')),
    'voc-registry': verdictOf(path.join(ev, 'gate6c-voc', 'registry.json')),
  };
  const missing = Object.entries(probes).filter(([, v]) => !v).map(([k]) => k);
  const pass = !missing.length && Object.values(probes).every((v) => v.pass);
  const rec = { $comment: 'The P2 lints\' calibration (tools/gate-lint.mjs record; docs/GATES.md "Fast checks (P2)"). tools/lib/p2-trim.mjs: valid only for this Minecraft version and with every probe passing; else the -smoke steps run the full in-game rows and the lint steps FAIL until a release run passes them again.', minecraft, pass, date: new Date().toISOString().slice(0, 10), head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), probes, ...(missing.length ? { missing } : {}) };
  check(!missing.length, `record: every probe ran (${missing.length ? `missing ${missing.join(', ')}` : Object.keys(probes).join(', ')})`);
  check(pass, `record: every probe passes on Minecraft ${minecraft} (${Object.entries(probes).map(([k, v]) => `${k} ${v ? (v.pass ? 'PASS' : 'FAIL') : 'missing'}`).join(', ')})`);
  if (process.env.CALIBRATION_WRITE === '1') { fs.writeFileSync(CAL, `${JSON.stringify(rec, null, 1)}\n`); log(`  wrote ${path.relative(root, CAL)} (commit it)`); }
  L.write('calibration.json', rec);
  return rec;
};

const name = process.argv[2];
if (!steps[name]) { console.error(`usage: node tools/gate-lint.mjs <${Object.keys(steps).join('|')}>`); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
