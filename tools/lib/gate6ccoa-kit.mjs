// (6c close-out A) The kit items' byte identity (docs/CONTRACT.md "Phase 6c close-out A" §11 item 10): every committed plan fixture
// planned here and on a base checkout (a detached worktree ../architect-mc-coA-base at the merge base with origin/main), compared as
// S3's gate did (answers, overall, the IR with kitVersion normalised, the first plan's IR), plus the artifact (kitVersion and catalogueVersion normalised: its palette rows). $0, no game.
//   unchanged(root, {check, log, only, moved})   moved: {fixture: 'the item that moves it, and why'} (named, not judged)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fixtures, planFixture } from './gate6ckc-kit.mjs';
import { normSiblingIr } from './batch-0410.mjs';
import { identicalToBase, skippedLine, syncBaseTree } from './base-tree.mjs';
import { F7A_MOVED, f7aAskLine } from './f7a-norm.mjs'; // (7a foundation) its named movers and ask movers
import { THEME_REST_MOVED } from './theme-rest-norm.mjs'; // (theme rest) the tunnel fixtures' flush lamp
import { clAskLine } from './fl-norm.mjs'; // (7a CL) its three ask movers compare by part and kind

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/** The artifact compared with its kitVersion, catalogueVersion, api and irSha normalised (§5's catalogue bump moves every artifact's
 *  number; a release's version bump moves its api and kitVersion, and so the IR's sha: release v0.42.0). */
const normArt = (a) => normSiblingIr(JSON.stringify(a ?? null)).replace(/"catalogueVersion":\d+/g, '"catalogueVersion":"*"').replace(/"api":"\d+\.\d+\.\d+"/g, '"api":"*"')
  .replace(/"irSha":"[0-9a-f]{64}"/g, '"irSha":"*"'); // (the IR itself is compared kitVersion-normalised above; its sha holds the kitVersion)

/** The base worktree ../architect-mc-coA-base at the merge base of HEAD and origin/main (base-tree.mjs: the run's GATE_MERGE_BASE under gate-run). */
export function baseTree(root) {
  return syncBaseTree(root, path.resolve(root, '..', 'architect-mc-coA-base'));
}

export async function unchanged(root, { check = null, log = console.log, only = null, moved = {} } = {}) {
  // (speed audit D, K1) base kit and scenarios trees identical to HEAD's: the loop can only agree
  const sk = identicalToBase(root);
  if (sk) {
    const n = fixtures(root).filter(([name]) => !only || only.test(name)).length;
    if (check) check(true, skippedLine(sk));
    log(skippedLine(sk));
    return { base: sk.base, head: sk.head, fixtures: {}, n, same: n, differ: [], skipped: true };
  }
  const { dir: baseDir, base } = baseTree(root);
  const H = (d) => import(pathToFileURL(path.join(d, 'kit', 'test', 'plan-helpers.mjs')).href);
  const [hNew, hOld] = [await H(root), await H(baseDir)];
  const sig = (r) => ({ answers: sha256(JSON.stringify(r.check.parts)), overall: r.check.overall, ir: sha256(normSiblingIr(r.res.irJson)), first: r.first && r.first !== r ? sha256(normSiblingIr(r.first.res?.irJson ?? JSON.stringify(r.first))) : null, art: sha256(normArt(r.artifact)) });
  const out = { base, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), fixtures: {} };
  for (const [name, fx] of fixtures(root)) {
    if (only && !only.test(name)) continue;
    const existsOld = fs.existsSync(path.join(baseDir, 'kit', 'test', 'fixtures', 'plan', name));
    let a = null, b = null, err = null;
    try { a = sig((await planFixture(hNew, root, fx)).r); } catch (e) { err = `head: ${String(e.message).slice(0, 160)}`; }
    if (existsOld) { try { b = sig((await planFixture(hOld, baseDir, fx)).r); } catch (e) { err = (err ? `${err}; ` : '') + `base: ${String(e.message).slice(0, 160)}`; } }
    const same = !!a && !!b && a.answers === b.answers && a.overall === b.overall && a.ir === b.ir && a.first === b.first && a.art === b.art;
    out.fixtures[name] = { existsOld, same, ...(err ? { err } : {}), ...(a && b && !same ? { head: a, base: b } : {}), ...(!existsOld && a ? { overall: a.overall } : {}) };
    if (!existsOld) { log(`note ${name}: new on this branch (${a ? a.overall : err})`); continue; }
    if (moved[name]) { out.fixtures[name].moved = moved[name]; log(`note ${name}: ${same ? 'byte-identical' : 'differs'}; ${moved[name]}`); continue; }
    if (check) check(same || (!a && !b), `${name}: ${same ? 'byte-identical (answers, overall, IR, first plan)' : !a && !b ? `errors on both (${err})` : `DIFFERS ${err ?? ''}`}`);
  }
  const rows = Object.entries(out.fixtures).filter(([, r]) => r.existsOld);
  out.n = rows.length;
  out.same = rows.filter(([, r]) => r.same).length;
  out.differ = rows.filter(([, r]) => !r.same).map(([k]) => k);
  return out;
}

// ------------------------------------------------------------------ (6c close-out A) the gate's offline step and the palette in game

/** The fixtures close-out A moves by name, with why (item 10: named, not judged; each is judged by its own item). */
export const MOVED = Object.freeze({
  'asks/arcology.json': '§6: Steward re-recorded it (0c8f4a8)', 'asks/end_city_ruins.json': '§6: re-recorded', 'asks/one_block.json': '§6: re-recorded',
  'asks/redstone_gate.json': '§6: re-recorded; §4: gate_road ends on an unplaced lot: blocked',
  'asks/rival_families.json': '§6: re-recorded', 'asks/spiral_town.json': '§6: re-recorded', 'asks/swamp_stilts.json': '§6: re-recorded',
  'asks/terraced_hill.json': '§6: re-recorded; §4: switchback_street blocked', 'asks/treetop_village.json': '§6: re-recorded',
  'asks/two_districts.json': '§6: re-recorded; §4: east_street blocked', 'asks/underwater_domes.json': '§6: re-recorded', 'asks/upside_down.json': '§6: re-recorded',
  'asks/mage_exiles.json': '§5: its artifact\'s palette row gains over: all (answers and IR identical)',
  'valid/v64_vocc_copper.json': '§5: the artifact\'s palette row gains over: all', 'valid/v65_vocc_nowood.json': '§5: the artifact\'s palette row gains over: all',
  'vocc/r03_entry.json': '§5: the artifact\'s palette row gains over: all', 'vocc/r04_lenient.json': '§5: the artifact\'s palette row gains over: all',
  // ((7a foundation) the fixtures its catalogue changes move by name: tools/lib/f7a-norm.mjs)
  ...THEME_REST_MOVED,
  ...F7A_MOVED,
});
/** The three lines §4 moves in the 59 asks as Steward recorded them now (Steward's own count, refused 9 -> 6). */
export const ASKS_MOVED = Object.freeze(['redstone_gate/gate_road', 'terraced_hill/switchback_street', 'two_districts/east_street']);

/** The 59 asks' table on a copy of the base kit with this tree's asks (the "before" of item 6): an APFS clone in os.tmpdir(). */
async function asksBefore(root, baseDir) {
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-asks-'));
  const kit = path.join(tmp, 'kit');
  execFileSync('cp', ['-c', '-R', path.join(baseDir, 'kit'), kit]);
  for (const f of fs.readdirSync(path.join(root, 'kit', 'test', 'fixtures', 'plan', 'asks'))) {
    fs.copyFileSync(path.join(root, 'kit', 'test', 'fixtures', 'plan', 'asks', f), path.join(kit, 'test', 'fixtures', 'plan', 'asks', f));
  }
  const { asksGap } = await import('./gate6chy-b.mjs');
  try { return await asksGap(kit, { current: true }); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** coa-unit's kit half: items 4, 5, 7, 9 (kit tests), 6 (the asks tables), 10 (byte identity), the catalogue diff. */
export async function unit(root, { check, log, OUT, nodeTest }) {
  const out = {};
  out.kit = nodeTest(['kit/test/coa.test.mjs', 'kit/test/vocc.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 10, `items 4, 5, 7, 9 (kit, coa.test.mjs and vocc.test.mjs): blocked routes to an unplaced lot or district (b01, b02), rule.palette over and exempt ways/forms and the lenient string scope (p01-p03), the catalogue bump alone, the grove pond near the stone placed with 0 LEAK and the only lot-clear site chosen (n01, n02), a district route kept out of a protected rect (d01): ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  // item 6: the asks before (the base kit, these asks) and after (HEAD), both committed
  const { asksGap } = await import('./gate6chy-b.mjs');
  const F = path.join(root, 'kit', 'test', 'fixtures', 'plan', 'coa');
  const before = await asksBefore(root, baseTree(root).dir), after = await asksGap(path.join(root, 'kit'), { current: true });
  fs.writeFileSync(path.join(OUT, 'coa-asks-before.txt'), before.text);
  fs.writeFileSync(path.join(OUT, 'coa-asks-after.txt'), after.text);
  // ((7a foundation) its ask movers compare without their `until` (rail_1: until 7a -> CR): tools/lib/f7a-norm.mjs)
  const lines = (t) => new Map(t.split('\n').filter((l) => l.includes('/') && !l.startsWith('#') && !l.startsWith('  ')).map((l) => [l.split(' ')[0], f7aAskLine(l)]));
  const f7n = (t) => t.split('\n').map(f7aAskLine).join('\n');
  const lb = lines(before.text), la = lines(after.text);
  const moved = [...la].filter(([k, v]) => lb.get(k) !== v).map(([k]) => k).sort();
  out.asks = { before: before.text.split('\n')[0], after: after.text.split('\n')[0], moved };
  const cb = fs.readFileSync(path.join(F, 'asks-before.txt'), 'utf8'), ca = fs.readFileSync(path.join(F, 'asks-after.txt'), 'utf8');
  // ((7a foundation) a base past close-out A (main since v0.42.0): its table is the committed after; nothing moves, noted as FL's item 8)
  // ((7a CL, on main since v0.44.0; nightly 2026-10-25) a base past CL answers its three climbs (cave_ladders blocked, quarter_stair and
  // long_stair refused NO_CLIMB; unsupported in the committed after): past close-out A, the tables compare without CL's lines' answers, its
  // gap-table rows and the tally line, as fl-norm's flAsksFilter does for the other slices' asks items)
  const cln = (t) => t.split('\n').filter((l) => !/^# 59 asks/.test(l) && !/^\s+connector\.(stair|ladder)\s+\d+$/.test(l)).map((l) => clAskLine(f7aAskLine(l))).join('\n');
  const pastCoa = cln(before.text) === cln(ca);
  if (pastCoa) {
    check(cln(after.text) === cln(ca), `item 6: the base is past close-out A: the 59 asks' table on the base and here equal the committed asks-after.txt (${out.asks.after.slice(2)})`);
    check(after.malformed === 0 && moved.length === 0, `item 6, §4: the base is past close-out A: 0 malformed, nothing moves (${moved.join(', ') || 'nothing moved'})`);
  } else check(f7n(before.text) === f7n(cb) && f7n(after.text) === f7n(ca), `item 6: the 59 asks' tables equal the committed ones (fixtures/plan/coa/asks-before.txt on the base kit, asks-after.txt here): ${out.asks.before.slice(2)} -> ${out.asks.after.slice(2)}`);
  if (!pastCoa) check(after.malformed === 0 && JSON.stringify(moved) === JSON.stringify([...ASKS_MOVED].sort()) && moved.every((k) => / blocked DEPENDENCY/.test(la.get(k))),
    `item 6, §4: 0 malformed; exactly the three routes on an unplaced lot move refused NO_ROOM -> blocked: ${moved.join(', ')}`, moved.map((k) => [lb.get(k), la.get(k)]));
  // item 10: byte identity but the named movers
  const u = await unchanged(root, { check, log, moved: MOVED });
  out.unchanged = { base: u.base, n: u.n, same: u.same, differ: u.differ.filter((k) => !MOVED[k]), moved: u.differ.filter((k) => MOVED[k]) };
  fs.writeFileSync(path.join(OUT, 'coa-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  check(out.unchanged.differ.length === 0, `item 10: ${u.same} of ${u.n} committed plan fixtures byte-identical to ${u.base.slice(0, 8)}; the rest exactly the named movers (${out.unchanged.moved.join(', ')})`);
  return out;
}

// ------------------------------------------------------------------ item 5 in game: VOC-c's r03 with over: "lots"

const VOCC_CLAIM = [9600, 9000, 9839, 9159];

/** r03 (a required copper rule over a provisional hall) with `over: "lots"`: READY; realiseApproved with an oak hall refuses PALETTE, copper PLACED. */
export async function paletteInGame(ctx, { OWNER }) {
  const { L, check, imp } = ctx;
  const root = ctx.root;
  const out = {};
  const D = await imp('test/fixtures/vocab/vocc-designs.mjs');
  const { writeBlueprint } = await imp('lib/write.mjs');
  for (const [id, mk] of Object.entries(D.VOCC_DESIGNS)) { fs.rmSync(path.join(L.LIBRARY, id), { recursive: true, force: true }); writeBlueprint(mk(), path.join(L.LIBRARY, id)); }
  const bible = 'g6cvocc_copper';
  const bdir = path.join(L.GAME_DIR, 'architect', 'bibles', bible, 'versions', '1');
  fs.mkdirSync(bdir, { recursive: true });
  fs.copyFileSync(path.join(root, 'scenarios', 'bibles', `${bible}.json`), path.join(bdir, 'bible.json'));
  await L.cmd('/architect reload');
  await L.ensureBase('G6B Flat Base');
  await L.fresh('G6B COA Palette', 'G6B Flat Base');
  await L.setRules('exact');
  await L.tp((VOCC_CLAIM[0] + VOCC_CLAIM[2]) >> 1, 0, (VOCC_CLAIM[1] + VOCC_CLAIM[3]) >> 1);
  const fx = JSON.parse(fs.readFileSync(path.join(root, 'kit', 'test', 'fixtures', 'plan', 'vocc', 'r03_entry.json'), 'utf8'));
  const plan = JSON.parse(JSON.stringify(fx.plan));
  plan.planId = 'coa_r03_over_lots';
  for (const r of plan.rules ?? []) if (r.kind === 'palette') r.over = 'lots';
  const H = await imp('test/plan-helpers.mjs');
  const anchors = H.stewardAnchors({ minX: VOCC_CLAIM[0], minZ: VOCC_CLAIM[1], maxX: VOCC_CLAIM[2], maxZ: VOCC_CLAIM[3] });
  const c = await L.call('dev.region.checkPlan', { plan, claim: VOCC_CLAIM, owner: OWNER, anchors, load: 'generate', bible }, 900_000);
  const rule = (c.check?.parts ?? []).find((p) => p.block === 'rule.palette');
  out.check = { overall: c.check?.overall, rule };
  check(c.check?.overall === 'READY' && rule?.class === 'fits', `item 5 (in game): r03 with over: "lots" checks READY, the rule fits over no part (${c.check?.overall}, ${rule?.class}, ${JSON.stringify(rule?.measured ?? null)})`);
  const art = (await L.call('dev.region.artifact', { sha: c.check.artifactSha, body: true })).artifact;
  const row = (art?.body?.palette ?? [])[0];
  check(row?.over === 'lots' && row.partsCells === 0, `item 5: the artifact's palette row says over lots with 0 part cells (${JSON.stringify(row && { over: row.over, partsCells: row.partsCells, lots: row.lots })})`);
  const bad = await L.call('dev.region.realiseApproved', { sha: c.check.artifactSha, lotEntries: { hall: 'vocc_oak_cabin' } }, 300_000);
  check(bad.reason === 'PALETTE', `item 5: realiseApproved with the hall bound to the oak cabin refuses PALETTE (${(bad.refused ?? bad.region ?? '').slice(0, 160)})`);
  const good = await L.call('dev.region.realiseApproved', { sha: c.check.artifactSha, lotEntries: { hall: 'vocc_copper_cabin' } }, 300_000);
  const st = good.region ? await L.waitRegion(good.region, 3_600_000, async (s) => { if (s.waiting?.OCCUPIED) await L.cmd('/kill @e[type=!minecraft:player]'); }) : null;
  check(st?.view?.state === 'PLACED', `item 5: with the copper cabin: ${good.region ?? good.refused} ${st?.view?.state ?? ''}`);
  if (good.region) await L.call('dev.region.remove', { region: good.region, requester: OWNER }, 3_600_000);
  return out;
}
