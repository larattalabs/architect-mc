// (6c H) The checker's fluid rules (docs/CONTRACT.md "Phase 6c slice H" §2, §9) on the virtual world (vworld.mjs), over the frozen
// volumes the IR records: M25 (containment: leak, convert, mix, shell, keep with the single breach, wet, trap, exit) per body, and M20
// (no flammable block within the fire reach of exposed lava, an error for lava bodies). M17 (planned light over planned ice; lava is
// light 15) is check.mjs's own rule: the ice cap and the lava are written cells there.
//
// A body comes from the IR's `fluid` ops (kit/lib/fluids/body.mjs); a wet write from the plan meta's `wet` records ({id, part, kind,
// columns: [[x, z, y0, y1]]}: the columns a pier, a harbour wall section or a quay writes through natural water). Runs only when the
// plan has either, so every other plan's report is unchanged. A body without a frozen volume over its box is a finding (M25:shell
// "no volume"), never a pass (§9).
import { simulate } from '../fluids/sim.mjs';
import { FLUID_OP, fromRuns } from '../fluids/body.mjs';
import { VC, classAt } from './volume.mjs';
import { F_WRITTEN } from './vworld.mjs';
import { kindOf } from '../fluids/world.mjs';

export { kindOf } from '../fluids/world.mjs';

/** (6c H, M20) The fire reach of an exposed lava cell, from 26.3's LavaFluid.randomTick (read in its bytecode): nextInt(3) steps, each
 * one up and at most one aside, light an air cell beside a flammable block (so the fire is at most 2 up and 2 aside, the block it lights
 * at most 3 aside and 0..3 up); with no step, three tries one aside at the lava's level light the air over a flammable block there. So a
 * flammable block within 3 sideways (Chebyshev), up to 3 above; 1 below is kept as a margin (vanilla lights nothing under the lava's
 * level). Gate item 13's probe confirms it in game (the posts the lava lit itself; fire's own spread is recorded apart). */
export const FIRE_REACH = Object.freeze({ side: 3, below: 1, above: 3 });

const k3 = (x, y, z) => `${x},${y},${z}`;
const D6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** The bodies of an IR (its `fluid` ops), with their IR part index. */
export function bodiesOf(ir) {
  const out = [];
  ir.parts.forEach((p, pi) => {
    for (const o of p.ops ?? []) {
      if (o.op !== FLUID_OP) continue;
      out.push({ id: o.id, part: o.part ?? null, irPart: p.id, pi, fluid: o.fluid, level: o.level, cells: fromRuns(o.cells), shell: fromRuns(o.shell), spill: fromRuns(o.spill), joins: fromRuns(o.joins), watch: fromRuns(o.watch), ice: fromRuns(o.ice), predicted: o.predicted ?? [], settleTicks: o.settleTicks });
    }
  });
  return out;
}

/**
 * The fluid rules. `args`: check.mjs's ({ir, vw, meta, volumes (decoded, by name), want, findings, metrics, partStage, finding}).
 * Adds findings; fills metrics.M25 ({bodies: [{id, cells, shell, spill, joins, watch, settleTicks, predicted}], wet}) and metrics.M20.
 */
export function fluidRules({ ir, vw, meta, vols, want, findings, metrics, finding }) {
  const P = vw.pal;
  const bodies = bodiesOf(ir);
  const wet = Array.isArray(meta?.wet) ? meta.wet : [];
  if (!bodies.length && !wet.length) return;
  const volumeList = [...(vols?.values?.() ?? [])];
  const volClass = (x, y, z) => { for (const v of volumeList) { const c = classAt(v, x, y, z); if (c !== VC.MISSING) return c; } return VC.MISSING; };
  const covered = (x, y, z) => volClass(x, y, z) !== VC.MISSING;
  const c = ir.claim;
  // what is never the plan's own: keep-out (the owner's areas the plan honoured, the protected rects), lot boxes and their aprons, kept
  // columns, another owner's cells and players' blocks in the frozen volumes, and the claim's outer ring
  const keepRects = [...(ir.keepOut ?? []), ...(meta?.planCheck?.protectedRects ?? [])];
  const keptCols = new Set();
  for (const p of ir.parts) for (const kp of p.keep ?? []) for (let x = kp.box.minX; x <= kp.box.maxX; x++) for (let z = kp.box.minZ; z <= kp.box.maxZ; z++) keptCols.add(`${x},${z}`);
  const lots = ir.lots ?? [];
  const keep = (x, y, z) => {
    if (x <= c.minX || x >= c.maxX || z <= c.minZ || z >= c.maxZ) return 'claim ring';
    for (const r of keepRects) if (x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]) return 'keep-out';
    for (const l of lots) { const b = l.box; if (x >= b.minX - 1 && x <= b.maxX + 1 && z >= b.minZ - 1 && z <= b.maxZ + 1 && y >= b.minY - 1 && y <= b.maxY + 1) return 'lot'; }
    if (keptCols.has(`${x},${z}`)) return 'kept';
    const vc = volClass(x, y, z);
    if (vc === VC.OWNED) return 'owned';
    if (vc === VC.PLAYER) return 'player';
    if (vc === VC.BLOCK_ENTITY) return 'block entity';
    return null;
  };
  const fluidsStage = ir.stages.indexOf('fluids');
  const stageOfPart = (pi) => (pi < 0 ? -1 : ir.stages.indexOf(ir.parts[pi]?.stage));
  const planPartOf = (pi) => (pi < 0 ? null : meta?.planCheck?.partOf?.[ir.parts[pi]?.id] ?? null);
  const shellCheck = (x, y, z, b) => {
    if (!(vw.flags(x, y, z) & F_WRITTEN)) return 'not written';
    const pi = vw.partAt(x, y, z);
    if (fluidsStage >= 0 && stageOfPart(pi) >= fluidsStage) return 'not written before the fluids stage';
    const i = vw.get(x, y, z);
    if (!P.fs[i]) return 'not fluid-stopping';
    if (P.gravity[i]) return 'a gravity block';
    const own = b.part ? planPartOf(pi) : null;
    if (b.part && own && own !== b.part) return "another part's";
    return null;
  };
  const surface = (x, y, z) => { const a = vw.get(x, y + 1, z); return !P.fs[a] && !P.fluid[a] && !P.water[a]; };
  const exit = (x, y, z) => {
    if (vw.lotAt(x, y, z)) return false;
    const a = vw.get(x, y, z), h = vw.get(x, y + 1, z), f = vw.get(x, y - 1, z);
    return P.vpass[a] && P.vpass[h] && !P.fluid[a] && !P.water[a] && P.floor[f] && !P.fluid[f];
  };
  const world = { at: (x, y, z) => kindOf(P, vw.get(x, y, z)), keep, shell: shellCheck, surface, exit, solid: (x, y, z) => P.solid[vw.get(x, y, z)] };
  const sim = simulate(world, bodies.map((b) => ({ id: b.id, part: b.part, fluid: b.fluid, level: b.level, cells: b.cells, shell: b.shell, spill: b.spill, joins: b.joins })), { breach: true });
  const per = [];
  if (want.has('M25')) {
    for (const f of sim.findings) findings.push(finding(f.rule, bodies.find((b) => b.id === f.body)?.irPart ?? null, 'fluids', f.count, f.sample, `body ${f.body}: ${f.message}`));
    // no frozen volume over a body's box (its cells, shell and the 2-cell buffer): a finding, never a pass (§9)
    for (const b of bodies) {
      const miss = [];
      for (const q of [...b.cells, ...b.shell]) if (!covered(q[0], q[1], q[2])) { miss.push(q); if (miss.length >= 16) break; }
      if (miss.length) findings.push(finding('M25:shell', b.irPart, 'fluids', miss.length, miss, `body ${b.id}: no volume: ${miss.length}+ cell(s) of its cells and shell outside every frozen volume the plan read (a body is checked against the frozen world, never a 2.5D guess)`));
    }
  }
  bodies.forEach((b, i) => {
    const s = sim.bodies[i];
    per.push({ id: b.id, part: b.part, fluid: b.fluid, cells: b.cells.length, shell: b.shell.length, spill: b.spill.length, joins: b.joins.length, watch: b.watch.length, reached: s.reached.length, breach: s.breach?.length ?? 0, settleTicks: b.settleTicks, predicted: b.predicted.length, predictedNow: s.predicted.length });
  });
  // ---- M25:wet: the plan meta's wet writes (piers, harbour walls, quays) through natural water
  const wetBad = [];
  const wetWhy = new Map();
  let wetCells = 0;
  if (wet.length) {
    for (const w of wet) {
      for (const [x, z, y0, y1] of w.columns ?? []) {
        for (let y = y0; y <= y1; y++) {
          const before = vw.base(x, y, z);
          const bk = kindOf(P, before);
          const was = bk === 'water' || bk === 'flowing_water' || bk === 'lava' || bk === 'flowing_lava' || P.states[before] === 'minecraft:ice' || P.states[before].startsWith('minecraft:bubble_column');
          if (!was) continue;
          const written = (vw.flags(x, y, z) & F_WRITTEN) !== 0;
          if (!written) continue;
          wetCells++;
          const now = vw.get(x, y, z);
          const why = bk === 'flowing_water' ? 'flowing' : bk === 'lava' || bk === 'flowing_lava' ? 'lava' : P.states[before].startsWith('minecraft:bubble_column') ? 'bubble column'
            : P.air[now] ? 'air under the surface' : P.water[now] && !P.fluid[now] ? 'waterlogged' : !P.fs[now] || P.states[now].includes('waterlogged=') ? 'not a full, non-waterloggable block' : null;
          if (why) { wetBad.push([x, y, z]); wetWhy.set(why, (wetWhy.get(why) ?? 0) + 1); }
        }
      }
    }
    if (want.has('M25') && wetBad.length) findings.push(finding('M25:wet', null, null, wetBad.length, wetBad, `${wetBad.length} wet write cell(s): ${[...wetWhy].map(([k, n]) => `${k} ${n}`).join(', ')}`));
  }
  metrics.M25 = { bodies: per, wet: { records: wet.length, cells: wetCells, bad: wetBad.length } };
  // ---- M20 fire: no flammable block within the fire reach of exposed lava (an error for lava bodies)
  const lavaBodies = bodies.filter((b) => b.fluid === 'lava');
  if (lavaBodies.length) {
    const bad = [];
    const seen = new Set();
    let exposed = 0;
    for (const b of lavaBodies) for (const [x, y, z] of b.cells) {
      if (!D6.some(([dx, dy, dz]) => P.air[vw.get(x + dx, y + dy, z + dz)])) continue;
      exposed++;
      for (let dx = -FIRE_REACH.side; dx <= FIRE_REACH.side; dx++) for (let dz = -FIRE_REACH.side; dz <= FIRE_REACH.side; dz++) for (let dy = -FIRE_REACH.below; dy <= FIRE_REACH.above; dy++) {
        const kk = k3(x + dx, y + dy, z + dz);
        if (seen.has(kk)) continue;
        seen.add(kk);
        if (P.flammable[vw.get(x + dx, y + dy, z + dz)]) bad.push([x + dx, y + dy, z + dz]);
      }
    }
    metrics.M20 = { exposed, flammable: bad.length, reach: FIRE_REACH };
    if (want.has('M20') && bad.length) findings.push(finding('M20', lavaBodies[0].irPart, 'fluids', bad.length, bad, `${bad.length} flammable block(s) within the fire reach of exposed lava (${FIRE_REACH.side} sideways, ${FIRE_REACH.below} below to ${FIRE_REACH.above} above)`));
  }
}
