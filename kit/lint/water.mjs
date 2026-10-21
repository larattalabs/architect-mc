// The water lint (docs/FAST-CHECKS.md "4. Water lint (P3)"; gate step `water-lint`): every committed plan with fluid bodies through the
// two-plan flow, the checker's M25 and M20 on its virtual world, and the rules the in-game census and breach steps used to prove copy by
// copy, now over every body offline:
//   W1 containment  M25 (leak, convert, mix, shell, keep, wet, trap, exit, clear) and M20 clean on every valid plan; every broken variant
//                   (the demos' variants, the refused and clear fixtures) caught by its rule or answered with its code
//   W2 census       every body's recorded prediction (the IR's `predicted`, what the realise's census compares the world with) equals
//                   vanilla's steady state recomputed over the same world, inside the conservative reach (M25:model); its settle bound is
//                   settleBound(path) and covers the steady state's own settle (calibrated: kit/lint/water-calibration.json, the in-game
//                   settles the release-tier probe measured)
//   W3 breach       the single breach of every shell cell at or under the surface: vanilla's flow from the opened cell (the steady state,
//                   not the reach) stays in the body's cells, spill and recorded breach reach, inside its watch box (cells, shell, spill,
//                   breach grown by WATCH_GROW): what the census watches; an irrigation body's stays inside its own lot (IRR's broken side)
//   W4 fire         M20 on every lava body (its exposed cells' fire reach), with the flammable variants caught
//   W5 fed          the source/flowing distinction and foreign sources: "what this source fed" (attribution: the flow present only
//                   because of this body's sources), over generated breach and drain cases; written to kit/lint/fixtures/drain-cases.json,
//                   which RegionFluidsLintTest drives through the mod's real RegionFluids.breachTake and drain
// The world the lint simulates in is built exactly as checkFluids.mjs's fluidRules builds it (`at` and `solid`, an irrigated field's floor
// a stop); W2's equality with the IR's own prediction, which the planner made through fluidRules' path, is the guard that the two agree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRegion } from '../lib/region/check.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { fillMissing } from '../lib/region/plan.mjs';
import { asColumns } from '../lib/region/pack.mjs';
import { bodiesOf } from '../lib/region/checkFluids.mjs';
import { kindOf } from '../lib/fluids/world.mjs';
import { irFields } from '../lib/fluids/irrfield.mjs';
import { reach, settleBound, simulate, steady, WATCH_GROW, mapWorld } from '../lib/fluids/sim.mjs';

export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(KIT, '..');
const FIX = path.join(KIT, 'test', 'fixtures', 'plan');
const k3 = (x, y, z) => `${x},${y},${z}`;
const kc = (c) => `${c[0]},${c[1]},${c[2]}`;
const un3 = (k) => k.split(',').map(Number);
const D6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** A plan fixture or program carries fluid parts (the trigger checkPlanVolumes uses, widened to irrigation and courses). */
const FLUID = /"kind":\s*"(pond|fountain|waterfall|moat|channel|quay)"|"(farmPond|irrigate)":\s*true/;

/**
 * The corpus: every committed plan fixture with a fluid part (kit/test/fixtures/plan/**), plus the demos h_core_demo and hy_core_demo
 * with each broken variant, and water_demo's flat settlement. Sorted, deterministic. A fixture added later joins by itself.
 */
export function corpus() {
  const out = [];
  for (const d of fs.readdirSync(FIX).filter((x) => fs.statSync(path.join(FIX, x)).isDirectory()).sort()) {
    for (const f of fs.readdirSync(path.join(FIX, d)).filter((x) => x.endsWith('.json')).sort()) {
      const text = fs.readFileSync(path.join(FIX, d, f), 'utf8');
      if (!FLUID.test(text)) continue;
      const fx = JSON.parse(text);
      if (!(fx.plan ?? fx.answer?.plan)) continue;
      out.push({ name: `${d}/${f}`, kind: 'fixture', fx, dir: d });
    }
  }
  out.push({ name: 'demo/h_core_demo', kind: 'h_core' });
  for (const [variant, rules] of Object.entries(H_VARIANTS)) out.push({ name: `demo/h_core_demo:${variant}`, kind: 'h_core', variant, rules });
  out.push({ name: 'demo/hy_core_demo', kind: 'hy_core' });
  for (const [variant, rules] of Object.entries(HY_VARIANTS)) out.push({ name: `demo/hy_core_demo:${variant}`, kind: 'hy_core', variant, rules });
  out.push({ name: 'demo/water_demo:flat', kind: 'water_demo' });
  return out;
}

/** The demos' broken variants and the rules each must raise (h-core.test, hy-core.test). */
export const H_VARIANTS = Object.freeze({
  no_shell_cell: ['M25:shell', 'M25:leak'], predict_short: ['M25:leak'], sand_shell: ['M25:shell'], two_source_corner: ['M25:convert'],
  lava_near_water: ['M25:mix'], flammable_rim: ['M20'], roofed_pond: ['M25:trap'], no_exit: ['M25:exit'],
});
export const HY_VARIANTS = Object.freeze({ predict_short: ['M25:leak'], no_lining_cell: ['M25:shell', 'M25:leak'], sand_lining: ['M25:shell'], thin_weir: ['M25:shell', 'M25:keep'], wrong_order: ['M25:order'] });

/** Plans one corpus entry through the two-plan flow: {ir, meta, blobs, volumes (decoded), survey (columns), answers}. */
export async function planEntry(e) {
  const H = await import('../test/plan-helpers.mjs');
  if (e.kind === 'fixture') {
    const fx = e.fx;
    const plan = fx.plan ?? fx.answer?.plan;
    const on = fx.on ?? (e.dir === 'asks' ? 'asks' : undefined);
    const s = fx.terrain ? H.flatSurvey(fx.terrain) : on === 'asks' ? H.asksSurvey() : on === 'flat' ? H.flatSurvey() : on ? H.goldenSurvey(on) : H.flatSurvey();
    const o = { survey: s.bytes, claim: s.claim, anchors: { ...H.stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], builds: fx.builds ?? [], ...(fx.standing ? { standing: fx.standing } : {}), ...(fx.biomes ? { biomes: fx.biomes } : {}),
      ...(fx.style ? { style: H.fixtureStyle(fx) } : {}), ...(fx.lotDesigns ? { lotBlocks: await H.fixtureLotBlocks(fx) } : {}) };
    const r = await H.checkPlanVolumes(plan, { ...o, volume: fx.volume ?? {} });
    return { ir: r.res.ir, meta: r.res.meta, blobs: r.res.blobs, volumes: (r.volumes ?? []).map((v) => v.decoded), survey: fillMissing(asColumns(s.bytes)).columns, answers: r.check.parts ?? [], overall: r.check.overall, expect: fx.expect ?? null };
  }
  if (e.kind === 'h_core') {
    const { planTwice } = await import('../test/h-helpers.mjs');
    const { columnsOf, worldOf } = await import('../test/region-helpers.mjs');
    const demo = await import('../regions/h_core_demo.mjs');
    const CLAIM = { minX: 0, minZ: 0, maxX: 95, maxZ: 95, minY: -64, maxY: 319 };
    const SURVEY = columnsOf(worldOf({ flat: 64 }), 0, 0, 96, 96, 1);
    const params = e.variant ? { variant: e.variant, lava: ['lava_near_water', 'flammable_rim'].includes(e.variant) } : {};
    const p = await planTwice({ program: demo, programSource: fs.readFileSync(path.join(KIT, 'regions', 'h_core_demo.mjs'), 'utf8'), params, survey: SURVEY, seed: '7', claim: CLAIM, node: 'test' });
    return { ir: p.ir, meta: p.meta, blobs: p.blobs, volumes: p.volumes.map((v) => v.decoded), survey: SURVEY, answers: [], overall: null, expect: null };
  }
  if (e.kind === 'hy_core') {
    const { planHy } = await import('../test/hy-helpers.mjs');
    const p = await planHy(e.variant ? { variant: e.variant } : {});
    return { ir: p.ir, meta: p.meta, blobs: p.blobs, volumes: p.volumes.map((v) => v.decoded), survey: fillMissing(asColumns(p.world.survey)).columns, answers: [], overall: null, expect: null };
  }
  if (e.kind === 'water_demo') {
    const { waterPlan } = await import('../regions/water_demo.mjs');
    const s = H.flatSurvey({ W: 256, D: 176, x0: 7000, z0: 7000 });
    const { plan, anchors } = waterPlan({ minX: s.claim.minX, minZ: s.claim.minZ, maxX: s.claim.maxX, maxZ: s.claim.maxZ }, { variant: 'flat', only: 'all', cx: -30000000, cz: -30000000 });
    const r = await H.checkPlanVolumes(plan, { survey: s.bytes, claim: s.claim, anchors: { ...H.stewardAnchors(s.claim), ...anchors }, volume: {} });
    return { ir: r.res.ir, meta: r.res.meta, blobs: r.res.blobs, volumes: (r.volumes ?? []).map((v) => v.decoded), survey: fillMissing(asColumns(s.bytes)).columns, answers: r.check.parts ?? [], overall: r.check.overall, expect: null };
  }
  throw new Error(`corpus entry ${e.name}`);
}

/** The fluid world fluidRules simulates in (checkFluids.mjs): `at` and `solid` over the virtual world, an irrigated field's floor a stop. */
export function fluidWorld(ir, vw) {
  const P = vw.pal;
  const fields = irFields(ir);
  const fieldAt = (x, y, z) => { for (const f of fields) if (y === f.floorY && x >= f.field.x0 && x <= f.field.x1 && z >= f.field.z0 && z <= f.field.z1 && !f.cells.has(k3(x, y, z))) return true; return false; };
  return {
    fields,
    at: fields.length ? (x, y, z) => (fieldAt(x, y, z) ? 'stop' : kindOf(P, vw.get(x, y, z))) : (x, y, z) => kindOf(P, vw.get(x, y, z)),
    solid: fields.length ? (x, y, z) => fieldAt(x, y, z) || P.solid[vw.get(x, y, z)] : (x, y, z) => P.solid[vw.get(x, y, z)],
  };
}

/** The bodies as simulate() takes them (a course's lining with its shell, its plan joins declared), as fluidRules passes them. */
export function simBodies(bodies) {
  return bodies.map((b) => (b.course
    ? { id: b.id, part: b.part, irPart: b.irPart, fluid: b.fluid, level: b.level, cells: b.cells, shell: [...b.shell, ...b.lining], spill: b.spill, joins: [...b.joins, ...b.planJoins.flatMap((q) => q.cells)], spillLands: b.planJoins.length > 0 }
    : { id: b.id, part: b.part, irPart: b.irPart, fluid: b.fluid, level: b.level, cells: b.cells, shell: b.shell, spill: b.spill, joins: b.joins }));
}

/** The calibration the release-tier probe recorded (kit/lint/water-calibration.json): in-game settle ticks per probed body. */
export function calibration() {
  const f = path.join(KIT, 'lint', 'water-calibration.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { settles: {} };
}

/**
 * The lint of one planned entry: {bodies: n, findings: [{rule, body, message}], checker: [checkRegion's M25/M20 findings], breaches}.
 * `full`: the breach of every shell cell (release); else every shell cell whose opening a flow can enter is still run, the trivial ones (no
 * neighbour a flow can enter but the body itself) are counted by the same shortcut sim.mjs's breachReach takes.
 */
export function lintPlanned(p, { full = false, maxBreach = 400 } = {}) {
  const out = { bodies: 0, findings: [], checker: [], breaches: { opened: 0, trivial: 0, sampled: 0, skipped: 0 }, metrics: {} };
  const bodies = bodiesOf(p.ir);
  out.bodies = bodies.length;
  if (!bodies.length && !(Array.isArray(p.meta?.wet) && p.meta.wet.length)) return out;
  const blobs = (sha) => (p.blobs instanceof Map ? p.blobs.get(sha) : p.blobs?.[sha]) ?? null;
  const filled = fillMissing(p.survey).columns;
  const { vw } = buildVirtual({ ir: p.ir, survey: p.survey, filled, blobs, volumes: p.volumes });
  const rep = checkRegion({ ir: p.ir, survey: p.survey, blobs, volumes: p.volumes, meta: p.meta, world: vw, prefix: false, rules: ['M25', 'M20'] });
  out.checker = rep.findings.filter((f) => /^M25|^M20/.test(f.rule)).map((f) => ({ rule: f.rule, severity: f.severity, count: f.count, message: f.message, sample: f.sample?.slice(0, 4) }));
  out.metrics = rep.metrics?.M25 ?? {};
  if (!bodies.length) return out;
  const W = fluidWorld(p.ir, vw);
  const sb = simBodies(bodies);
  const sim = simulate({ at: W.at, solid: W.solid }, sb);
  const add = (rule, body, message) => out.findings.push({ rule, body, message });
  const cal = calibration();
  const fluidOf = new Map();
  for (const b of bodies) for (const c of b.cells) fluidOf.set(kc(c), b.fluid);
  bodies.forEach((b, i) => {
    const s = sim.bodies[i];
    // W2: the census's prediction is vanilla's steady state, recomputed; inside the reach; the settle bound
    const recorded = new Map((b.predicted ?? []).map(([x, y, z, lv]) => [k3(x, y, z), lv]));
    const now = new Map(s.predicted.map(([x, y, z, lv]) => [k3(x, y, z), lv]));
    const miss = [...now].filter(([k, lv]) => recorded.get(k) !== lv).map(([k]) => k);
    const extra = [...recorded.keys()].filter((k) => !now.has(k));
    if (miss.length || extra.length) add('W2:census', b.id, `the IR's prediction differs from vanilla's steady state recomputed: ${miss.length} cell(s) missing or at another level (${miss.slice(0, 4).join(' ')}), ${extra.length} extra (${extra.slice(0, 4).join(' ')})`);
    const reached = new Set(s.reached.map(kc));
    const outside = [...now.keys()].filter((k) => !reached.has(k));
    if (outside.length) add('W2:model', b.id, `${outside.length} predicted cell(s) outside the conservative reach`);
    if (b.settleTicks !== settleBound(b.fluid, s.path)) add('W2:settle', b.id, `settleTicks ${b.settleTicks} is not settleBound(${b.fluid}, path ${s.path}) = ${settleBound(b.fluid, s.path)}`);
    // the steady state's own settle (its last scheduled tick), from the body's sources alone, never beyond the bound
    const own = new Set(b.cells.map(kc));
    const others = new Map([...fluidOf].filter(([k]) => !own.has(k)));
    const at = (x, y, z) => { const k = k3(x, y, z); if (own.has(k)) return b.fluid; const o = others.get(k); return o ?? W.at(x, y, z); };
    const st = steady(at, b.cells, b.fluid);
    if (st.ticks > b.settleTicks) add('W2:settle', b.id, `vanilla's steady state settles at tick ${st.ticks}, past the bound ${b.settleTicks}`);
    const measured = cal.settles?.[`${p.name ?? ''}#${b.id}`];
    if (measured !== undefined && measured > b.settleTicks) add('W2:settle', b.id, `the probe measured a settle of ${measured} ticks in game, past the bound ${b.settleTicks}`);
    // W3: the single breach per shell cell: vanilla's flow from it stays where the census watches
    if (b.shell.length || b.lining.length) {
      const allowed = new Set([...b.cells, ...b.spill, ...b.joins, ...(b.watch ?? []), ...b.planJoins.flatMap((q) => q.cells)].map(kc));
      const box = new Set();
      for (const c of [...b.cells, ...b.shell, ...b.lining, ...b.spill, ...(b.watch ?? [])]) for (let dx = -WATCH_GROW; dx <= WATCH_GROW; dx++) for (let dy = -WATCH_GROW; dy <= WATCH_GROW; dy++) for (let dz = -WATCH_GROW; dz <= WATCH_GROW; dz++) box.add(k3(c[0] + dx, c[1] + dy, c[2] + dz));
      const field = W.fields.find((f) => f.bodies.has(b.id));
      const candidates = [...b.shell, ...b.lining].filter((c) => c[1] <= b.level);
      let ran = 0;
      for (const c of candidates) {
        out.breaches.opened++;
        const opened = kc(c);
        const atB = (x, y, z) => { const k = k3(x, y, z); return k === opened ? 'open' : at(x, y, z); };
        // the trivial breach: nothing a flow can enter beside the opened cell (sim.mjs's shortcut): the flow is the cell itself
        if (!D6.some(([dx, dy, dz]) => { const w = atB(c[0] + dx, c[1] + dy, c[2] + dz); return (w === 'open' || w === `flowing_${b.fluid}`) && !own.has(k3(c[0] + dx, c[1] + dy, c[2] + dz)); })) {
          out.breaches.trivial++;
          continue;
        }
        if (!full && ran >= maxBreach) { out.breaches.skipped++; continue; }
        ran++;
        out.breaches.sampled++;
        const sb2 = steady(atB, b.cells, b.fluid);
        const flow = [...sb2.cells.keys()].filter((k) => !own.has(k) && k !== opened);
        const leak = flow.filter((k) => !allowed.has(k));
        if (leak.length) add('W3:breach', b.id, `opening ${opened}: vanilla's flow reaches ${leak.length} cell(s) outside its cells, spill and recorded breach reach (${leak.slice(0, 4).join(' ')})`);
        const unwatched = flow.filter((k) => !box.has(k));
        if (unwatched.length) add('W3:watch', b.id, `opening ${opened}: ${unwatched.length} flow cell(s) outside the census's watch box`);
        if (field) {
          const fb = field.box;
          const away = flow.map(un3).filter(([x, , z]) => x < fb.minX || x > fb.maxX || z < fb.minZ || z > fb.maxZ);
          if (away.length) add('W3:irr', b.id, `opening ${opened} (a farmland side): ${away.length} flow cell(s) outside its own lot ${field.lot}`);
        }
      }
    }
  });
  return out;
}

// ------------------------------------------------------------------ W5: what this source fed

/**
 * Attribution: which water of the steady state over `sources` (own and foreign) this body's sources fed. own: [[x, y, z]], foreign: [[x, y,
 * z]] (a pond's sources, a player's bucket, a waterlogged block), at: the world (an opened breach included). Returns {all: Map k -> level
 * (0 source, 1..7 flowing, 8 falling), foreignOnly: Map, ownOnly: Set (flowing cells foreign water alone never reaches), raised: Set (cells
 * both reach where this body's water stands higher than foreign water alone would leave: its flow, which a drain may take; foreign water
 * refills its own level), joint: Set (cells both reach at the level foreign water alone leaves: the foreign water's, never taken)}.
 */
export function fedBy(at, own, foreign, fluid = 'water') {
  const all = steady(at, [...own, ...foreign], fluid).cells;
  const fo = foreign.length ? steady(at, foreign, fluid).cells : new Map();
  const ownSet = new Set(own.map(kc));
  const amount = (lv) => (lv === 0 || lv === 8 ? 8 : 8 - lv);
  const ownOnly = new Set(), raised = new Set(), joint = new Set();
  for (const [k, lv] of all) {
    if (lv === 0 || ownSet.has(k)) continue;
    if (!fo.has(k)) ownOnly.add(k);
    else if (amount(lv) > amount(fo.get(k)) || (lv === 8 && fo.get(k) !== 8)) raised.add(k);
    else joint.add(k);
  }
  return { all, foreignOnly: fo, ownOnly, raised, joint };
}

/**
 * The generated drain cases (W5): an irrigation-like body (one source in a basin on a pad, its shell the basin's sides) with one side
 * broken, its breach flowing over the pad and off its edge; then each with a foreign feeder or holder: a pond's sources, a player's bucket,
 * a waterlogged block (a source, not a liquid), water there before the realise, another body's cell, and the body's source already
 * drained. Every case carries the world's fluid cells (amount, source, liquid), the body's seeds, the foreign set, the box, and the kit's
 * attribution: `ownOnly` (the flow only this body fed: a drain may take it, and must, when nothing foreign touches the flow) and `never`
 * (sources, foreign cells, and every cell foreign water feeds: a drain never takes them).
 * Plus the stray pass's cases (the H batch, bcdc7097): a body with a spout whose prediction is recorded, a player's bucket in its watch box
 * with its own flow, and a natural flowing cell in its watched set at another level: the drain must restore the recorded cells exactly and
 * never write the player's water.
 */
export function drainCases() {
  const cases = [];
  // the pad: a raised floor of 15 x 11 at y 63 (x -2..12, z -5..5), air over it; the ground one under its edge (a falling cell off it)
  const pad = (x, y, z) => (y <= 62 ? 'stop' : y === 63 && x >= -2 && x <= 12 && z >= -5 && z <= 5 ? 'stop' : 'open');
  // the body: its source at 0,64,0 in a basin whose sides (shell) stand at x -1, z +-1 and x 1 (the broken side opened)
  const src = [[0, 64, 0]];
  const shell = [[-1, 64, 0], [1, 64, 0], [0, 64, -1], [0, 64, 1], [0, 63, 0]];
  const broken = '1,64,0';
  const extra = new Map([['-1,64,0', 'stop'], ['0,64,-1', 'stop'], ['0,64,1', 'stop']]);
  const base = (x, y, z) => { const k = k3(x, y, z); if (k === broken) return 'open'; return extra.get(k) ?? pad(x, y, z); };
  const box = [-12, 52, -14, 22, 66, 14]; // the lot's box grown by 8, 12 under its floor to 1 over (RegionFluids.breachFlow)
  const variants = [
    { name: 'bare', foreign: [], logged: [], before: [], others: [], drained: false },
    { name: 'pond', foreign: [[5, 64, 2], [6, 64, 2], [5, 64, 3], [6, 64, 3]], logged: [], before: [], others: [], drained: false, walls: [[4, 64, 2], [7, 64, 2], [4, 64, 3], [7, 64, 3], [5, 64, 4], [6, 64, 4]] },
    { name: 'player-bucket', foreign: [[8, 64, 1]], logged: [], before: [], others: [], drained: false },
    { name: 'waterlogged', foreign: [[3, 64, 1]], logged: [[3, 64, 1]], before: [], others: [], drained: false },
    { name: 'before', foreign: [], logged: [], before: [[4, 64, -3]], others: [], drained: false },
    { name: 'other-body', foreign: [[6, 64, -2]], logged: [], before: [], others: [[6, 64, -2]], drained: false },
    { name: 'drained', foreign: [], logged: [], before: [], others: [], drained: true },
    { name: 'pond-and-player', foreign: [[5, 64, 2], [6, 64, 2], [5, 64, 3], [6, 64, 3], [10, 64, -1]], logged: [], before: [], others: [], drained: false, walls: [[4, 64, 2], [7, 64, 2], [4, 64, 3], [7, 64, 3], [5, 64, 4], [6, 64, 4]] },
  ];
  for (const v of variants) {
    const walls = new Set((v.walls ?? []).map(kc));
    const before = new Map(v.before.map((c) => [kc(c), 'flowing_water']));
    const at = (x, y, z) => { const k = k3(x, y, z); if (walls.has(k)) return 'stop'; return before.get(k) ?? base(x, y, z); };
    const f = fedBy(at, src, v.foreign);
    const cells = [];
    const logged = new Set(v.logged.map(kc));
    for (const [k, lv] of f.all) {
      if (v.drained && k === kc(src[0])) continue;
      const [x, y, z] = un3(k);
      cells.push({ at: [x, y, z], amount: lv === 0 || lv === 8 ? 8 : 8 - lv, source: lv === 0, liquid: !logged.has(k) });
    }
    for (const c of v.before) cells.push({ at: c, amount: 3, source: false, liquid: true });
    const foreignSet = new Set([...v.before.map(kc), ...v.others.map(kc)]);
    // never: a foreign source or cell, and water at the level foreign water alone leaves (the foreign water's own); may: the flow this body
    // alone fed, and cells it raised above what foreign water alone leaves
    const never = new Set([...[...f.foreignOnly.keys()].filter((k) => !f.raised.has(k)), ...f.joint, ...foreignSet, ...v.foreign.map(kc)]);
    const ownOnly = [...f.ownOnly].filter((k) => !never.has(k));
    const may = [...ownOnly, ...[...f.raised].filter((k) => !never.has(k))];
    cases.push({ name: `breach/${v.name}`, kind: 'breach', own: src, seeds: [src, shell, []], foreign: [...foreignSet].map(un3), box, cells: cells.sort((a, b) => kc(a.at) < kc(b.at) ? -1 : 1),
      ownOnly: ownOnly.map(un3).sort(), may: may.map(un3).sort(), never: [...never].map(un3).sort(), complete: v.foreign.length === 0 && v.before.length === 0 && v.others.length === 0 });
  }
  // the stray pass (H): a spout on a pillar over a sunk basin (its predicted flow down the pillar's sides), a player's bucket in the watch box
  const strays = [];
  {
    const ground = (x, y) => (y <= 63 ? 'stop' : 'open');
    const m = new Map();
    for (let x = 8; x <= 12; x++) for (let z = 8; z <= 12; z++) if (x !== 10 || z !== 10) m.set(`${x},63,${z}`, 'water');
    m.set('10,63,10', 'stop'); m.set('10,64,10', 'stop'); m.set('10,65,10', 'stop');
    const w = mapWorld(m, (x, y, z) => ground(x, y, z));
    const spout = [[10, 66, 10]];
    const sim = simulate(w, [{ id: 's', fluid: 'water', level: 66, cells: spout }]);
    const predicted = sim.bodies[0].predicted.map(([x, y, z]) => [x, y, z]);
    // the player's bucket on the basin's far rim, inside the watch box (cells, spill grown by 2), with its own flow on the ground
    const bucket = [[13, 64, 12]];
    const f = fedBy(w.at, spout, bucket);
    const cells = [];
    for (const [k, lv] of f.all) { const [x, y, z] = un3(k); cells.push({ at: [x, y, z], amount: lv === 0 || lv === 8 ? 8 : 8 - lv, source: lv === 0, liquid: true }); }
    // a natural flowing cell recorded in the watched set at level 3 before, the body's flow raised it (the drain must restore 3)
    const watched = [[9, 66, 9]];
    const playerOnly = [...f.foreignOnly.keys()].filter((k) => !f.raised.has(k) && !predicted.some((c) => kc(c) === k));
    strays.push({ name: 'strays/spout-and-bucket', kind: 'strays', cells: cells.sort((a, b) => kc(a.at) < kc(b.at) ? -1 : 1), body: spout, before: ['minecraft:air'], watch: watched, watchBefore: ['minecraft:water[level=3]'],
      watchNow: 'minecraft:water[level=6]', predicted: predicted.sort(), never: playerOnly.map(un3).sort() });
  }
  return [...cases, ...strays];
}

/** The committed cases file the mod's RegionFluidsLintTest reads. */
export const DRAIN_CASES = path.join(KIT, 'lint', 'fixtures', 'drain-cases.json');

export function drainCasesJson() {
  return `${JSON.stringify({ about: 'generated by kit/lint/water.mjs drainCases() (W5); node kit/lint/water.mjs --write regenerates it; RegionFluidsLintTest drives the mod\'s RegionFluids.breachTake and drain over it', cases: drainCases() })}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(DRAIN_CASES), { recursive: true });
  fs.writeFileSync(DRAIN_CASES, drainCasesJson());
  console.log(`wrote ${DRAIN_CASES}`);
}

export { reach };
