// (7b ST) The standalone player path's site spec (docs/CONTRACT.md "Phase 7b", slice ST; SETTLEMENTS §7.8): a player marks a plot,
// picks a fit and samples the site (Survey.site: the lot plus 8 frozen, AF's analysis, a proposed frame); this module turns that into
// the whole SiteSpec a design request carries: the frame, the ports and the keep-critical cells, with no region and no lot id.
//
// The port and keep rules are the 7bF fixtures' own (kit/tools/site-fixtures.mjs), written over the land instead of fixed numbers, so
// the six fixtures re-derive their own specs (bar the lot id) and every SV fit example (kit/designs/site/fit_*.mjs) builds on a
// standalone spec of the same shape. Deterministic; reads only the frozen volume.
//
// One rule per fit, in the design frame (front south, the lot box's minimum corner at 0,0,0; W x H x D the design-frame size):
//   attach_to_cliff  walk port `walk_top` (2x2, facing north: the clifftop behind) at [floor((W-1)/2), top+1, 1], top = the
//                    column's top solid cell; refused when that row is outside the lot (raise the height limit) or the column is open
//   carve_into       door port `door_s` (1x2, facing south) on the floor in front of the face: x = floor((W-1)/2), y = the front column's
//                    ground + 1, z = the last solid cell of that row before the front; refused without rock to carve
//   span             walk ports `walk_w`, `walk_e` (2x3) on the two rims at z = floor((D-1)/2), each one row above its rim's top
//   wrap_trunk       walk port `walk_w` (2x2, facing west) at [0, max(2, ground+1), floor((D-1)/2)]; keep-critical: every LOG cell
//                    of the lot (the host trunk); refused without logs in the lot
//   suspend          walk port `hatch` (1x1, facing down) at [floor(W/2), 0, floor(D/2)]; keep-critical: the four hang points, the
//                    first solid cell above the lot over the corners inset 2 (x) and 3 (z); refused when one has no rock over it
//   on_pad           no ports, no keep (the standalone on_pad path sends no site at all: ST's reading 1)
import { Site } from './site.mjs';
import { decodeArvx } from './region/volume.mjs';
import { analyseVolume, proposeFrame } from './region/affordances.mjs';
import { FIT_IDS, SITE_MARGIN } from './siteFits.mjs';

/** The lot box of a volume frozen as `lot + SITE_MARGIN` (Survey.site's box; the y may be clamped at the world's limits). */
export function lotOfVolume(box) {
  return { minX: box.minX + SITE_MARGIN, minY: box.minY + SITE_MARGIN, minZ: box.minZ + SITE_MARGIN, maxX: box.maxX - SITE_MARGIN, maxY: box.maxY - SITE_MARGIN, maxZ: box.maxZ - SITE_MARGIN };
}

const port = (name, kind, at, facing, width, height) => ({ name, kind, at, facing, width, height });
const WALK = 'architect:walk';

/** World cells sorted x, y, z (the trunk fixture's order; hang points keep their corner order, as the overhang fixture's). */
const sortCells = (cells) => cells.map((c) => [...c]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

/** The rules per fit: `(site) -> {ports, keepCritical (world cells)} | {reason}`. */
const RULES = {
  on_pad: () => ({ ports: [], keepCritical: [] }),
  attach_to_cliff(site) {
    const { x: W, y: H } = site.size;
    const x = Math.floor((W - 1) / 2), z = 1;
    const top = site.surface(x, z);
    if (top == null) return { reason: 'no clifftop behind the plot (the back of the lot is open air)' };
    if (top + 1 > H - 1) return { reason: `the clifftop is above the plot (${top + 2 - H} too high): raise the height limit` };
    if (top + 1 < 0) return { reason: 'the clifftop is below the plot: mark the plot lower, against the face' };
    return { ports: [port('walk_top', WALK, [x, top + 1, z], 'north', 2, 2)], keepCritical: [] };
  },
  carve_into(site) {
    const { x: W, y: H, z: D } = site.size;
    const x = Math.floor((W - 1) / 2);
    const ground = site.surface(x, D - 1, { below: H - 1 });
    const y = ground == null ? 0 : ground + 1;
    if (y < 0 || y > H - 3) return { reason: 'the ground in front of the face is outside the plot' };
    let z = -1;
    for (let k = D - 2; k >= 0; k--) if (site.solid(x, y, k)) { z = k; break; }
    if (z < 1) return { reason: 'no rock to carve into behind the front of the plot' };
    return { ports: [port('door_s', 'door', [x, y, z], 'south', 1, 2)], keepCritical: [] };
  },
  span(site) {
    const { x: W, y: H, z: D } = site.size;
    const z = Math.floor((D - 1) / 2);
    const rims = [[0, 'walk_w', 'west'], [W - 1, 'walk_e', 'east']].map(([x, name, facing]) => {
      const top = site.surface(x, z, { below: H - 1 });
      return { x, name, facing, top };
    });
    const bad = rims.find((r) => r.top == null || r.top + 1 < 0 || r.top + 1 > H - 3);
    if (bad) return { reason: `no rim to bear on at the ${bad.facing} end inside the plot` };
    return { ports: rims.map((r) => port(r.name, WALK, [r.x, r.top + 1, z], r.facing, 2, 3)), keepCritical: [] };
  },
  wrap_trunk(site) {
    const { y: H, z: D } = site.size;
    const logs = site.cellsOf('LOG');
    if (!logs.length) return { reason: 'no trunk in the plot (no logs inside the lot)' };
    const z = Math.floor((D - 1) / 2);
    const ground = site.surface(0, z, { below: H - 1 });
    const y = Math.max(2, ground == null ? 2 : ground + 1);
    if (y > H - 3) return { reason: 'the ground at the plot\'s west edge is too high for a deck' };
    return { ports: [port('walk_w', WALK, [0, y, z], 'west', 2, 2)], keepCritical: sortCells(logs.map(([a, b, c]) => site.toWorld(a, b, c))) };
  },
  suspend(site) {
    const { x: W, y: H, z: D } = site.size;
    const keep = [];
    for (const [x, z] of [[2, 3], [W - 3, 3], [2, D - 4], [W - 3, D - 4]]) {
      const c = site.ceiling(x, z, { above: H - 1 });
      if (c == null || c !== H) return { reason: 'no rock just above the plot to hang from (the underside must be the row over the plot\'s top)' };
      keep.push(site.toWorld(x, c, z));
    }
    return { ports: [port('hatch', WALK, [Math.floor(W / 2), 0, Math.floor(D / 2)], 'down', 1, 1)], keepCritical: keep };
  },
};


/**
 * The standalone site spec for `fit` over a frozen volume (decoded ARVX or its bytes): `{ok: true, spec, affordance}` (the SiteSpec wire:
 * `lotId` absent, `volumeBlobId` the given one or `local:<sha>`) or `{ok: false, reason}` in player words. `lot` defaults to the volume
 * minus the margin; `frame` defaults to AF's proposed frame (`proposeFrame`), and with none the reason says what the analysis lacked.
 * `affordances` may be passed when already analysed.
 */
export function standaloneSite(volume, { lot, fit, frame, affordances, volumeBlobId } = {}) {
  const v = volume instanceof Uint8Array && !volume.classes ? decodeArvx(volume) : volume;
  if (!FIT_IDS.includes(fit)) throw new Error(`standaloneSite: unknown fit ${JSON.stringify(fit)}`);
  const L = lot ?? lotOfVolume(v.box);
  let rotation = frame?.rotation, aff = null;
  if (!rotation) {
    const p = proposeFrame(affordances ?? analyseVolume(v), L, fit);
    if (!p) return { ok: false, reason: `no ${KIND_WORDS[fit]} at the plot: the analysis proposes no frame for ${fit}` };
    rotation = p.frame.rotation;
    aff = p.affordance;
  }
  const base = { volumeSha: v.sha, volumeBlobId: volumeBlobId ?? `local:${v.sha}`, volume: { ...v.box }, fit, frame: { origin: [L.minX, L.minY, L.minZ], rotation }, keepCritical: [], ports: [] };
  const site = new Site(v, { lot: L, spec: base });
  const r = RULES[fit](site);
  if (r.reason) return { ok: false, reason: r.reason };
  return { ok: true, affordance: aff, spec: { ...base, keepCritical: r.keepCritical, ports: r.ports } };
}

const KIND_WORDS = { on_pad: 'flat pad', carve_into: 'cliff face or cave', attach_to_cliff: 'cliff face', span: 'gap between two faces', wrap_trunk: 'giant trunk', suspend: 'overhang' };
