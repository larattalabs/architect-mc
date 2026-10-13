// brush: one terrain brush stroke as a region (docs/CONTRACT.md "Phase 6c slice B"). The mod plans it for `Regions.brush` and
// `/architect brush` over the brush's box plus 8 (the claim), with the request as params, and realises it at once; the region is
// one stroke (S-B-1), undone by `Regions.remove` in any order. No Claude call. Every kind's non-local work runs here at plan time
// (lib/region/brush.mjs) and lands as `columns` ops, so masks and patterns (MP) shape every stroke:
//   smooth, erode, blend, raise, lower  the surface: the column's new ground (fill: the pattern, else the subsurface role under
//                                       the surface role; cut: air down to the new ground)
//   overlay                             the top `strength` cells of each column: the pattern, else the surface/subsurface roles
//   melt                                exposed cells (4+ air neighbours of 6) removed, `strength` rounds (the frozen volume)
//   cave_carve                          a seeded worm from the centre (the frozen volume): capsules, a levelled floor, stopped
//                                       short of water, lava and unknown cells, floating bits removed
// Every op is ALWAYS_OURS: natural cells and the same owner's earlier strokes; the mod skips every other owned cell, and only a
// `player_blocks` stroke (permission 2) may clear unowned non-natural cells (TileCheck reads the stroke's flag).
import { region } from '../lib/region/program.mjs';
import { BRUSH_KINDS, BRUSH_LIMITS, BRUSH_SHAPES, DESTRUCTION, blend, brushBox, caveWorm, cellCols, erode, heightCols, melt, needsVolume, raiseLower,
  smooth, surfaceGrid, volumeBox } from '../lib/region/brush.mjs';
import { classAt } from '../lib/region/volume.mjs';

export const id = 'brush';
export const catalogue = false;

const XZ = 30000000;
export const params = {
  kind: { type: 'enum', options: [...BRUSH_KINDS], default: 'smooth', label: 'Kind' },
  shape: { type: 'enum', options: [...BRUSH_SHAPES], default: 'sphere', label: 'Shape' },
  cx: { type: 'int', min: -XZ, max: XZ, default: 0, label: 'Centre x' },
  cy: { type: 'int', min: -2048, max: 4096, default: 64, label: 'Centre y' },
  cz: { type: 'int', min: -XZ, max: XZ, default: 0, label: 'Centre z' },
  radius: { type: 'int', min: BRUSH_LIMITS.radiusMin, max: BRUSH_LIMITS.radiusMax, default: 8, label: 'Radius' },
  strength: { type: 'int', min: BRUSH_LIMITS.strengthMin, max: BRUSH_LIMITS.strengthMax, default: 4, label: 'Strength' },
  mask: { type: 'json', default: null, label: 'Mask' },
  pattern: { type: 'json', default: null, label: 'Pattern' },
  destruction: { type: 'enum', options: [...DESTRUCTION], default: 'natural_only', label: 'Destruction' },
};

export default function brush(ctx) {
  const { claim, survey, params: P } = ctx;
  const b = { cx: P.cx, cy: P.cy, cz: P.cz, radius: P.radius, shape: P.shape };
  const r = region(ctx);
  r.stages(['stroke']);
  const mask = P.mask ? r.mask(P.mask, 'brush mask') : undefined;
  const pat = P.pattern ? r.pattern(P.pattern, 'brush pattern') : null;
  const box = brushBox(b, claim);
  // the frozen volume (MELT, CAVE_CARVE, a block or class mask): the brush box plus VOLUME_PAD, with block ids; the mod samples the
  // same box before it plans (a plan without it leaves the stroke empty and asks for it: the two-plan flow)
  let vol = null;
  if (needsVolume(P.kind, P.mask)) {
    vol = r.needVolume(volumeBox(b, claim), { blocks: true });
    if (!vol) r.note('brush: the stroke needs a frozen volume (the game samples it and plans again)');
  }
  const ground = (x, z) => (x < claim.minX || x > claim.maxX || z < claim.minZ || z > claim.maxZ || survey.missingAt(x, z) ? null : survey.groundAt(x, z));
  // water (frozen too) and lava columns keep their surface (bit 3 of the survey flags is lava)
  const C = survey.columns;
  const lava = (x, z) => (C.flags[Math.floor((z - C.minZ) / C.resolution) * C.width + Math.floor((x - C.minX) / C.resolution)] & 8) !== 0;
  const wet = (x, z) => survey.waterAt(x, z) || lava(x, z);
  const part = r.part('stroke', { stage: 'stroke', mask });
  const COND_OURS = 3;
  const stats = { kind: P.kind, shape: P.shape, radius: P.radius, strength: P.strength, destruction: P.destruction };
  const surfaceKind = ['smooth', 'erode', 'blend', 'raise', 'lower'].includes(P.kind);
  if (surfaceKind) {
    const grid = surfaceGrid(b, ground, wet);
    const h = P.kind === 'smooth' ? smooth(grid, P.strength)
      : P.kind === 'erode' ? erode(grid, P.strength)
        : P.kind === 'blend' ? blend(grid, P.strength)
          : raiseLower(grid, P.strength, P.kind === 'raise' ? 1 : -1, P.shape);
    const hc = heightCols(grid, h, { pattern: !!pat });
    part.columns({ surface: 0 }, { surface: 0 }, hc.cols, [null, 'surface', 'subsurface', pat ?? 'subsurface'], { cond: COND_OURS });
    Object.assign(stats, { columns: grid.inside.reduce((a, v) => a + v, 0), moved: hc.moved, raised: hc.raised, lowered: hc.lowered });
  } else if (P.kind === 'overlay') {
    const grid = surfaceGrid(b, ground, wet);
    const cols = [];
    for (let j = 0; j < grid.D; j++) {
      for (let i = 0; i < grid.W; i++) {
        const k = i + j * grid.W;
        if (!grid.inside[k]) continue;
        const x = grid.minX + i, z = grid.minZ + j;
        if (pat) cols.push(x, z, 1 - P.strength, 0, 2);
        else cols.push(x, z, 1 - P.strength, -1, 1, x, z, 0, 0, 0);
      }
    }
    part.columns({ surface: 0 }, { surface: 0 }, cols, ['surface', 'subsurface', pat ?? 'surface'], { cond: COND_OURS });
    stats.columns = cols.length / (pat ? 5 : 10);
  } else if (vol) {
    const cls = (x, y, z) => classAt(vol, x, y, z);
    if (P.kind === 'melt') {
      const m = melt(b, P.strength, cls, P.destruction);
      part.columns(0, 0, cellCols(m.cells), [null], { cond: COND_OURS });
      Object.assign(stats, { cells: m.cells.length, rounds: m.rounds });
    } else {
      const w = caveWorm(b, P.strength, cls, ctx.rng('cave'), { minX: vol.box.minX, minY: vol.box.minY, minZ: vol.box.minZ, maxX: vol.box.maxX, maxY: vol.box.maxY, maxZ: vol.box.maxZ }, P.destruction);
      part.columns(0, 0, cellCols(w.cells), [null], { cond: COND_OURS });
      Object.assign(stats, { cells: w.cells.length, points: w.points.length, tube: w.tube, stopped: w.stopped, floating: w.floating });
      if (w.stopped !== null) r.note(`brush: the worm stopped before segment ${w.stopped} (water, lava or an unknown cell within one block)`);
    }
  }
  r.note(`brush ${JSON.stringify(stats)}`);
  // the anchors the IR needs: the centre column's top
  const ax = Math.max(claim.minX, Math.min(claim.maxX, P.cx)), az = Math.max(claim.minZ, Math.min(claim.maxZ, P.cz));
  const ay = Math.max(claim.minY, Math.min(claim.maxY, (ground(ax, az) ?? P.cy) + 1));
  r.anchor('entrance', [ax, ay, az]);
  r.anchor('spawn', [ax, ay, az]);
  r.budget(Math.max(1, (box.maxX - box.minX + 1) * (box.maxZ - box.minZ + 1) * (box.maxY - box.minY + 1 + 2 * BRUSH_LIMITS.strengthMax)));
  return r;
}
