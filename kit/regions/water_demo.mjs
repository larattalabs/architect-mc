// water_demo (docs/CONTRACT.md "Phase 6c slice H" §14): the water bodies' gate fixture, bundled and not in the catalogue. It writes a
// plan/0 of H's parts for its variant and compiles it exactly as Regions.checkPlan does (kit/lib/plan/compile.mjs runCheck, the real
// generators of kit/lib/fluids), so a body here is planned, checked, realised and undone through the same code as a plan's.
//   flat     (E-flat, a flat claim of at least 224x160): a natural pond, a built pool, a lava pit, a fountain, a waterfall from a sculpted
//            outcrop into a pond basin, and a small walled yard ringed by a moat with one road crossing it on a bridge (landing at the
//            wall's gate). H-b adds its quay and harbour wall beside a synthetic lake (`wet: true`, its half).
//   natural  (S3's pinned claim): a pond on the river's bank and a waterfall from a natural drop (lip existing) into a pond.
//   cold     (a frozen claim: S7's rejected site 2026101102, S2's ice spikes): a pond in the freezing biome, capped with ice; `twin`
//            adds an uncapped twin (item 4's freezing probe).
// `only` keeps one body (pond, pool, pit, fountain, waterfall, moat) for a gate round of its own; `cx`/`cz` move the layout's centre.
import { region } from '../lib/region/program.mjs';
import { runCheck } from '../lib/plan/compile.mjs';

export const id = 'water_demo';
export const description = 'H\'s water bodies through the plan compiler: pond, pool, lava pit, fountain, waterfall, moat (6c H).';
export const catalogue = false;
export const passes = ['relief', 'route', 'districts'];

const AUTO = -30000000;
export const params = {
  variant: { type: 'enum', options: ['flat', 'natural', 'cold'], default: 'flat', label: 'Variant' },
  only: { type: 'enum', options: ['all', 'pond', 'pool', 'pit', 'fountain', 'waterfall', 'moat'], default: 'all', label: 'One body' },
  cx: { type: 'int', min: -30000000, max: 30000000, default: AUTO, label: 'Centre x' },
  cz: { type: 'int', min: -30000000, max: 30000000, default: AUTO, label: 'Centre z' },
  // (cold) the uncapped twin pond of item 4 (the freezing probe: its surface left open, ext architect_mc:unsafe noCap)
  twin: { type: 'bool', default: false, omitDefault: true, label: 'Uncapped twin (cold)' },
};

/** The plan/0 of a variant over a claim (its anchors as [x, y, z]; the y is the compiler's own). */
export function waterPlan(claim, P) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const cx = P.cx === AUTO ? claim.minX + (W >> 1) : P.cx, cz = P.cz === AUTO ? claim.minZ + (D >> 1) : P.cz;
  const at = (dx, dz) => [cx + dx, 65, cz + dz];
  const anchors = {}, forms = [], zones = [], connectors = [];
  const want = (k) => P.only === 'all' || P.only === k;
  const near = (name, dx, dz, within = 8) => { anchors[name] = at(dx, dz); return { near: { anchor: name, within } }; };
  if (P.variant === 'flat') {
    if (W < 224 || D < 160) throw new Error(`water_demo flat needs a claim of at least 224x160 (got ${W}x${D})`);
    if (want('pond')) forms.push({ id: 'pond', kind: 'pond', size: { w: 11, d: 9 }, depth: 3, where: near('pond_at', -84, -48) });
    if (want('pool')) forms.push({ id: 'pool', kind: 'pond', edge: 'built', size: { w: 7, d: 5 }, depth: 2, where: near('pool_at', -84, -8) });
    if (want('pit')) forms.push({ id: 'pit', kind: 'pond', fluid: 'lava', depth: 2, where: near('pit_at', -84, 36) });
    if (want('fountain')) forms.push({ id: 'fountain', kind: 'fountain', basin: 5, spout: 3, where: near('fountain_at', -44, -48) });
    if (want('waterfall')) forms.push({ id: 'falls', kind: 'waterfall', drop: 7, width: 3, lip: 'sculpt', basin: 'pond', where: near('falls_at', -44, 8, 12) });
    if (want('moat')) {
      zones.push({ id: 'yard', where: near('yard_at', 40, 0, 4), program: { lots: [{ id: 'y1', type: 'house', size: [9, 9] }, { id: 'y2', type: 'cottage', size: [9, 9] }] } });
      connectors.push({ id: 'yard_wall', kind: 'wall', where: { around: { feature: { part: 'yard' }, ring: [3, 5] } }, height: 5 });
      connectors.push({ id: 'moat', kind: 'channel', where: { around: { feature: { part: 'yard' }, ring: [6, 16] } } });
      anchors.road_end = [claim.maxX - 6, 65, cz];
      connectors.push({ id: 'road', kind: 'road', width: 3, from: { anchor: 'road_end' }, to: { part: 'yard' } });
    }
  } else if (P.variant === 'natural') {
    if (want('pond')) forms.push({ id: 'pond', kind: 'pond', size: { w: 9, d: 7 }, depth: 2, where: { near: { feature: { water: { body: 'river' } }, within: 12 } } });
    if (want('waterfall')) forms.push({ id: 'falls', kind: 'waterfall', drop: 6, width: 3, lip: 'existing', basin: 'pond' });
  } else {
    if (want('pond')) forms.push({ id: 'pond', kind: 'pond', size: { w: 9, d: 7 }, depth: 2, where: near('pond_at', 0, 0, 24) });
    if (P.twin) forms.push({ id: 'twin', kind: 'pond', size: { w: 7, d: 5 }, depth: 2, where: near('twin_at', 0, 24, 24), ext: { 'architect_mc:unsafe': { noCap: true } } });
  }
  return { plan: { schemaVersion: 'plan/0', planId: `water_demo_${P.variant}`, zones, forms, connectors }, anchors };
}

export default function waterDemo(ctx) {
  const { plan, anchors } = waterPlan(ctx.claim, ctx.params);
  const { region: r, record } = runCheck(ctx, { plan, anchors, protected: [], regions: [], builds: [], standing: [], budget: {}, bible: null, fingerprint: null }, { makeRegion: () => region(ctx) });
  r.meta.planCheck = record;
  const bad = record.answers.filter((a) => !['fits', 'adjusted'].includes(a.class));
  if (bad.length) r.note(`water_demo: ${bad.map((a) => `${a.part} ${a.class} ${a.reasons?.[0]?.code ?? ''}`).join('; ')}`);
  // the cameras: high over the centre, and one over each body
  const c = ctx.claim, cy = Math.min(c.maxY, ctx.survey.groundAt((c.minX + c.maxX) >> 1, (c.minZ + c.maxZ) >> 1) + 48);
  r.anchor('cam_high', [(c.minX + c.maxX) >> 1, cy, c.minZ + 4]);
  for (const a of record.answers) {
    const g = a.geometry?.rect;
    if (!g || !a.geometry.bodies) continue;
    const x = (g[0] + g[2]) >> 1, z = g[3] + 10;
    const name = `cam_${a.part}`.slice(0, 32);
    if (z <= c.maxZ) r.anchor(name, [x, Math.min(c.maxY, ctx.survey.groundAt(x, Math.min(z, c.maxZ)) + 9), z]);
  }
  return r;
}
