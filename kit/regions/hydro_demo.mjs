// hydro_demo (docs/CONTRACT.md "Phase 6c slice HY" §14): HY-b's courses as a bundled program, not in the catalogue.
//   flat     (a flat claim of at least 240x160): four terraces sculpted in stage `ground` (16, 11, 6 and 3 over the plain) carry a brook
//            from a spring through two falls of 5 and two riffles (flow: riffles) to a terminal pool, laid by the region primitive
//            r.course along a polyline over the sculpted ground; on the plain beside it a built canal (level, structure lining, trim
//            coping). E-flat: the terraces are the program's own writes.
//   The natural (S3's pinned claim, N-HY-1: as a site only) and cold (the frozen site 2026101102) sites are the gate's plan/0 fixtures
//   (fixtures/plan/hy/n01_s3_natural.json, hy/c01_cold.json) through Regions.checkPlan, not this program.
// The plan fixtures (fixtures/plan/valid/v50..v60, hy/) carry every other kind (races, ditches, weirs, joins, overflows, rim falls, bridged
// roads) through the plan compiler; this program is the look's and the goldens' one-piece course.
import { region } from '../lib/region/program.mjs';

export const id = 'hydro_demo';
export const description = 'HY-b\'s courses: a brook down four sculpted terraces (falls and riffles) and a built canal (6c HY).';
export const catalogue = false;

const AUTO = -30000000;
export const params = {
  canal: { type: 'bool', default: true, label: 'The built canal' },
  cx: { type: 'int', min: -30000000, max: 30000000, default: AUTO, label: 'Centre x' },
  cz: { type: 'int', min: -30000000, max: 30000000, default: AUTO, label: 'Centre z' },
};

/** The terraces (x ranges from the claim's west edge + 8, heights over the plain). */
export const TERRACES = Object.freeze([[0, 49, 16], [50, 99, 11], [100, 149, 6], [150, 189, 3]]);

export default function hydroDemo(ctx) {
  const { claim, survey, params: P } = ctx;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 240 || D < 160) throw new Error(`hydro_demo flat needs a claim of at least 240x160 (got ${W}x${D})`);
  const cx = P.cx === AUTO ? claim.minX + (W >> 1) : P.cx, cz = P.cz === AUTO ? claim.minZ + (D >> 1) : P.cz;
  const x0 = cx - 112;
  const r = region(ctx);
  r.stages(['ground', 'forms', 'fluids']);
  const g0 = survey.groundAt(cx, cz);
  // the terraces: dirt with grass on top, from the plain up (the program's own ground)
  const z0 = cz - 60, z1 = cz + 10;
  const ter = r.part('terraces', { stage: 'ground' });
  const cols = [];
  const top = (x, z) => {
    if (z < z0 || z > z1) return null;
    for (const [a, b, h] of TERRACES) if (x >= x0 + a && x <= x0 + b) return g0 + h;
    return null;
  };
  for (let x = x0; x <= x0 + 189; x++) for (let z = z0; z <= z1; z++) {
    const t = top(x, z);
    if (t === null) continue;
    cols.push(x, z, survey.groundAt(x, z) + 1, t - 1, 0, x, z, t, t, 1);
  }
  ter.columns({ abs: 0 }, { abs: 0 }, cols, ['minecraft:dirt', 'minecraft:grass_block'], { cond: 0 });
  (r.meta.parts[ter.id] ??= {}).kind = 'add';
  const sculpted = { groundAt: (x, z) => top(x, z) ?? survey.groundAt(x, z), topAt: (x, z) => top(x, z) ?? survey.topAt(x, z) };
  // the brook: west to east along the terraces' middle, a spring on the top terrace, a terminal pool on the plain
  const bz = cz - 25;
  const brook = r.course([[x0 + 15, bz], [x0 + 215, bz]], { id: 'brook', look: 'natural', flow: 'riffles', stage: 'forms', survey: sculpted });
  // the canal: built, level, on the plain to the south
  const canal = !P.canal ? null : r.course([[x0 + 40, cz + 40], [x0 + 200, cz + 40]], { id: 'canal', look: 'built', flow: 'level', stage: 'forms', from: { kind: 'spring' }, to: { kind: 'pool' } });
  for (const c of [brook, canal]) if (c?.refused) r.note(`hydro_demo: ${c.id} refused ${c.refused.code}: ${c.refused.message}`);
  r.anchor('entrance', [cx, g0 + 1, cz + 60]);
  r.anchor('spawn', [cx, g0 + 1, cz + 60]);
  r.anchor('cam_high', [cx, g0 + 40, cz + 70]);
  r.anchor('cam_falls', [x0 + 60, g0 + 22, bz + 18]);
  r.anchor('cam_riffle', [x0 + 160, g0 + 12, bz + 14]);
  r.anchor('cam_canal', [x0 + 120, g0 + 10, cz + 52]);
  return r;
}
