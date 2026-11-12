#!/usr/bin/env node
// M5 slice GP gate (given-program designs and keyed variants; docs/CONTRACT.md "M5 support", Steward's S-M5-1) against the headless server
// of the GP run worktree (GATE6B_RUN, default `../architect-mc-GP-run`; the sim sidecar, no Claude). $0: no Claude call anywhere. Ports
// 8906/8907.
//
//   node tools/gatem5gp.mjs <step>
//     start [world] | stop | base      the headless server and the base worlds (G6B Flat Base)
//     unit      (gp-unit)              offline: kit/test/gp.test.mjs (a program is given its lot's reserved cells; ignoring them is the
//                                      checker's `reserved`; values outside its params) and sidecar/test/programs.test.ts (the helper
//                                      alone on the real kit: install, sha, sandbox, typed refusals, variants, variantByKey, a restart, a kill)
//     ingame    (gp-ingame)            a Steward-shaped module program (kit/test/fixtures/gp/gp_crop_field.mjs, a fenced lit crop field)
//                                      through the mod's public API (dev.gp.*): Designs.fromProgram installs it at $0 (the entry's
//                                      givenProgram.sha = the source's sha256, program/source.mjs the exact source; the key replays,
//                                      another body OP_KEY_CONFLICT; params outside its schema PROGRAM_REFUSED params with a typed finding);
//                                      a keyed Designs.variant with other params, a Style and the lot's reserved cells (installed, its
//                                      derivation a VARIANT with the recipe); a program ignoring them PROGRAM_REFUSED reserved; the server
//                                      restarts; Designs.variantByKey finds the variant (an unknown key: empty); placed on flat ground (the
//                                      reserved cells keep the ground, the field around them farmed); Remove exact (the box's hash as before)
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate-m5-gp/<step>.json in the main checkout (GATEM5GP_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-GP-run');
process.env.GATE6B_OUT = process.env.GATEM5GP_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate-m5-gp');
process.env.GATE6B_SIDECAR_PORT ??= '8906';
process.env.GATE6B_DEV_PORT ??= '8907';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient, call } = L;

L.refuseKeys();
const KIT = path.join(root, 'kit');
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const FLAT = 'G6B Flat Base';
const WORLD = 'G6B GP Field';
const SOURCE = fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'gp', 'gp_crop_field.mjs'), 'utf8');
const IGNORES = SOURCE.replace("if (!keep.has(`${x},${y},${z}`)) bp.set(x, y, z, block, props);", 'bp.set(x, y, z, block, props);').replace("export const id = 'gp_crop_field'", "export const id = 'gp_ignores'");
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
/** Steward's key shape (MODULES.md 4.2 step 3: `steward.<build>.module.<lotId>`) and an owner scope */
const OWNER = 'steward:gate';
const KEY_ENTRY = 'steward.gate.catalog.crop_farm_1';
const KEY_VARIANT = 'steward.gate.module.lot_3';
/** an 11 x 11 lot (side 9 + the fence ring), its front south; its middle field cell (the farmland and the cell above it) reserved */
const RESERVED = { front: 'south', size: [11, 11], cells: [[5, -1, 5], [5, 0, 5]] };
const STYLE = { id: 'fortress' };
const CX = 200, CZ = 200;

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice GP is $0: given programs and the sim only, no Claude call' }, null, 2)}\n`);
}

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B GP Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  await L.ensureBase(FLAT);
  spendZero();
  return { worlds: [FLAT] };
};

function nodeTest(files, timeout = 1_800_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
steps.unit = async () => {
  const out = {};
  out.kit = nodeTest(['kit/test/gp.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 3, `the kit gives a program its lot's reserved cells (kit/test/gp.test.mjs: left air and the checker passes; ignored: the checker's reserved; values outside its params): ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const v = spawnSync('npx', ['vitest', 'run', 'test/programs.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 1_800_000 });
  const t = `${v.stdout}${v.stderr}`;
  out.sidecar = { code: v.status, tests: (/Tests\s+(.*)$/m.exec(t) ?? [])[1] ?? '?' };
  check(v.status === 0, `the helper's given programs (sidecar/test/programs.test.ts on the real kit: install and sha, the key, params, the sandbox, a variant with a bible and reserved cells, reserved refused, not_given, no_entry, program_stale, variantByKey after a restart, a kill between install and record): ${out.sidecar.tests}`);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game

const entryFile = (id) => {
  const f = path.join(L.LIBRARY, id, `${id}.blueprint.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};
/** A dev.box.hash cell line's block id ("minecraft:x"). */
const idOf = (line) => (/(?:Block\{|Name\s*:\s*["']?)([a-z0-9_.-]+:[a-z0-9_./-]+)/.exec(line)?.[1] ?? line).replace(/^minecraft:/, '');
async function cells(b) {
  const h = await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]], cells: true }, 300_000);
  return new Map((h.cells ?? []).map((l) => { const sp = l.indexOf(' '); return [l.slice(0, sp), idOf(l.slice(sp + 1))]; }));
}
const hashOf = async (b) => (await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] }, 300_000)).sha256;
async function groundY() {
  const c = await cells([CX, -64, CZ, CX, 250, CZ]);
  let g = -64;
  for (const [k, id] of c) { const y = Number(k.split(',')[1]); if (id !== 'air' && y > g) g = y; }
  return g;
}

steps.ingame = async () => {
  await ensure();
  const out = {};
  await L.fresh(WORLD, FLAT);
  await L.setRules('exact');
  await L.tp(CX, 0, CZ - 20);

  // 1. fromProgram: installed at $0, the sha and the exact source kept; the key replays; another body conflicts
  const a = await call('dev.gp.fromProgram', { source: SOURCE, params: { side: 9, crop: 'carrots' }, opKey: KEY_ENTRY, owner: OWNER }, 300_000);
  check(!!a.entryId && !a.refused, `Designs.fromProgram installed the module program as ${a.entryId} in ${a.ms} ms${a.refused ? ` (refused ${a.refused} ${a.detail})` : ''}`, a);
  const entryId = a.entryId;
  const e1 = entryFile(entryId) ?? {};
  const kept = path.join(L.LIBRARY, entryId ?? '-', 'program', 'source.mjs');
  check(e1.givenProgram?.sha === sha256(SOURCE) && e1.givenProgram?.opKey === KEY_ENTRY && fs.existsSync(kept) && fs.readFileSync(kept, 'utf8') === SOURCE,
    `the entry records the program's sha (givenProgram.sha ${String(e1.givenProgram?.sha).slice(0, 12)} = sha256 of the source) and keeps its exact source as program/source.mjs`, e1.givenProgram);
  check(json(e1.values) === json({ side: 9, crop: 'carrots' }) && e1.type === 'crop_field' && json(e1.size) === json({ x: 11, y: 3, z: 11 }), `its values, the program's own type and size: ${json(e1.values)}, ${e1.type}, ${json(e1.size)}`);
  const again = await call('dev.gp.fromProgram', { source: SOURCE, params: { side: 9, crop: 'carrots' }, opKey: KEY_ENTRY, owner: OWNER }, 300_000);
  const other = await call('dev.gp.fromProgram', { source: SOURCE, params: { side: 7 }, opKey: KEY_ENTRY, owner: OWNER }, 300_000);
  check(again.entryId === entryId && /^OP_KEY_CONFLICT/.test(other.refused ?? ''), `the same key and body answer ${again.entryId}; another body under the key is refused ${String(other.refused).slice(0, 40)}`, { again, other });
  const bad = await call('dev.gp.fromProgram', { source: SOURCE, params: { side: 99 }, opKey: 'gate.gp.badparams' }, 300_000);
  check(/^PROGRAM_REFUSED/.test(bad.refused ?? '') && bad.detail === 'params' && bad.findings?.[0]?.rule === 'params' && /side must be an integer 5\.\.27/.test(bad.findings?.[0]?.message ?? ''),
    `params outside the program's schema: PROGRAM_REFUSED ${bad.detail}, the typed finding ${json(bad.findings?.[0]?.rule)}: ${String(bad.findings?.[0]?.message).slice(0, 80)}`, bad);
  out.fromProgram = { entryId, sha: e1.givenProgram?.sha, ms: a.ms };

  // 2. the keyed variant: other params, a Style, the lot's reserved cells
  const v = await call('dev.gp.variant', { entryId, params: { crop: 'wheat' }, bible: STYLE, reserved: RESERVED, opKey: KEY_VARIANT, owner: OWNER }, 300_000);
  check(!!v.entryId && !v.refused, `Designs.variant (crop wheat, Style ${STYLE.id}, 2 reserved cells) installed ${v.entryId} in ${v.ms} ms${v.refused ? ` (refused ${v.refused} ${v.detail})` : ''}`, v);
  const variantId = v.entryId;
  const e2 = entryFile(variantId) ?? {};
  const d2 = await call('dev.ds.entry', { entryId: variantId });
  check(e2.givenProgram?.sha === sha256(SOURCE) && json(e2.reserved) === json(RESERVED) && e2.bible?.id === STYLE.id && json(e2.values) === json({ side: 9, crop: 'wheat' }),
    `the variant records the same program sha, the reserved cells, the Style ${e2.bible?.id} v${e2.bible?.version} and its values ${json(e2.values)}`);
  check(d2.known && d2.derivation?.kind === 'VARIANT' && d2.derivation?.source === entryId && d2.derivation?.recipe?.programSha === sha256(SOURCE) && json(d2.derivation?.recipe?.reserved) === json(RESERVED),
    `the loaded entry's derivation: a VARIANT of ${d2.derivation?.source} v${d2.derivation?.sourceVersion}, its recipe the params, Style, reserved cells, sha and key`, d2.derivation);
  const ign = await call('dev.gp.fromProgram', { source: IGNORES, params: {}, opKey: 'gate.gp.ignores' }, 300_000);
  const iv = ign.entryId ? await call('dev.gp.variant', { entryId: ign.entryId, params: {}, reserved: RESERVED, opKey: 'gate.gp.ignores.v' }, 300_000) : { refused: 'no entry' };
  check(/^PROGRAM_REFUSED/.test(iv.refused ?? '') && iv.detail === 'reserved' && json(iv.findings?.map((f) => f.rule)) === json(['reserved']),
    `a program that ignores the reserved cells: PROGRAM_REFUSED ${iv.detail}, findings ${json(iv.findings?.map((f) => f.rule))}`, iv);
  const ng = await call('dev.gp.variant', { entryId: 'cabin', params: {}, opKey: 'gate.gp.cabin' }, 120_000);
  check(/^PROGRAM_REFUSED/.test(ng.refused ?? '') && ng.detail === 'not_given', `a variant of a bundled example (cabin): PROGRAM_REFUSED ${ng.detail}`, ng);

  // 3. the server restarts; variantByKey finds the variant
  await stopClient();
  await startClient(WORLD, { backend: 'sim' });
  await L.setRules('exact');
  const k1 = await call('dev.gp.byKey', { opKey: KEY_VARIANT, owner: OWNER }, 120_000);
  const k0 = await call('dev.gp.byKey', { opKey: 'gate.gp.never', owner: OWNER }, 120_000);
  const kScope = await call('dev.gp.byKey', { opKey: KEY_VARIANT }, 120_000);
  check(k1.found && k1.entryId === variantId && k0.found === false && kScope.found === false,
    `after the restart, Designs.variantByKey(${OWNER}, ${KEY_VARIANT}) = ${k1.entryId}; an unknown key and the player's scope: empty`, { k1, k0, kScope });
  const replay = await call('dev.gp.variant', { entryId, params: { crop: 'wheat' }, bible: STYLE, reserved: RESERVED, opKey: KEY_VARIANT, owner: OWNER }, 300_000);
  check(replay.entryId === variantId && fs.readdirSync(L.LIBRARY).filter((d) => d.startsWith(`${entryId}_kv`)).length === 1, `the variant call replayed after the restart answers ${replay.entryId}; the library holds one variant`);

  // 4. placed on flat ground, then Remove exact
  const g = await groundY();
  const origin = [CX, g, CZ];
  const area = [CX - 3, g - 3, CZ - 3, CX + 13, g + 5, CZ + 13];
  await L.tp(CX + 5, g + 20, CZ - 10);
  await L.settle(1500);
  const h0 = await hashOf(area);
  const before = await cells(area);
  const p = await call('dev.pl.place', { blueprint: variantId, origin }, 300_000);
  check(p.placed, `Sites.place of ${variantId} at ${json(origin)}: placed ${p.site}`, p);
  await L.settle(1500);
  const after = await cells(area);
  const at = (x, y, z) => `${origin[0] + x},${origin[1] + y},${origin[2] + z}`;
  // the reserved frame cells [5,-1,5] and [5,0,5] are the template's (5,0,5) and (5,1,5) (groundY 1, the lot = the template)
  const res = [at(5, 0, 5), at(5, 1, 5)];
  const field = [at(4, 0, 5), at(4, 1, 5), at(5, 0, 4), at(5, 1, 4)];
  const keptGround = res.every((k) => after.get(k) === before.get(k));
  const farmed = after.get(field[0]) === 'farmland' && after.get(field[1]) === 'wheat' && after.get(field[2]) === 'farmland' && after.get(field[3]) === 'wheat';
  check(keptGround && farmed, `placed: the reserved cells keep the ground (${res.map((k) => `${k} ${after.get(k)}`).join(', ')}); the field around them is farmland and wheat`, { res: res.map((k) => [k, before.get(k), after.get(k)]), field: field.map((k) => [k, after.get(k)]) });
  const lamps = [at(0, 2, 0), at(10, 2, 0), at(0, 2, 10), at(10, 2, 10)].map((k) => after.get(k));
  check(lamps.every((l) => l && l !== 'air'), `the shell is styled from the Style's roles: corner lamps ${json([...new Set(lamps)])}`);
  const rm = await call('dev.pl.remove', { site: p.site }, 600_000);
  await L.settle(1500);
  const h1 = await hashOf(area);
  check(rm.removed && h1 === h0, `Remove is exact: the ${before.size}-cell box's hash is as before (${String(h0).slice(0, 12)})`, { rm, h0, h1 });
  out.placed = { site: p.site, origin, removed: rm.removed };
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
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# M5 GP gate\n\n| step | ok | failed | time |\n|---|---|---|---|\n${rows.join('\n')}\n`);
  return { rows };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gatem5gp.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
const bad = Object.values(results).filter((r) => !r.ok).length;
process.exit(bad ? 1 : 0);
