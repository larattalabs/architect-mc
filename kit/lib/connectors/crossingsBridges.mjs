// (6c T3a) crossings_demo's bridge half (docs/CONTRACT.md "Phase 6c slice T3" §10): T3a owns this file and kit/regions/crossings_demo.mjs;
// the tunnel half is lib/connectors/crossingsTunnels.mjs (T3b).
//   flat variant (the claim's west half): two ravine sections raised in stage `ground` (banks `bank` high, written into the shared base so
//                 the route pass meets them, T1's lesson): a 24-wide gap crossed by a beam (3 piers) and a 16-wide one by an arch, each a
//                 bridge edge between the lips (3 wide: a villager road), with a fence round each bank's top but at the landing
//   river / frozen (natural): the claim's best straight crossing of its water (a run of 4..18 water columns with dry, tree-free land
//                 for 12 cells past each bank; the frozen variant takes a frozen run), crossed by an arch between anchors 8 past
//                 the banks (the route's approach finds the landings)
import { BRIDGE, checkBridge, emitRouteBridges, surveyLand } from './bridgeGeom.mjs';

/** The flat variant's sections: the gap (= the span in deck cells) and its form. */
export const SECTIONS = Object.freeze([{ n: 24, form: 'beam' }, { n: 16, form: 'arch' }]);
const LEN = 24; // each section's length along the ravine (x)
const STEP = 48; // section centres apart (x)

/**
 * The straight crossings of the claim's water: [{axis, line, from, len, water, minBank, level, pad}] best first: the lowest water (the
 * river, not a mountain pool), then the lowest landing level over it (pads 3 cells off it, at most 8 over the ground they stand on), then the lowest pad, then the longest run, then the
 * line, the start and the axis. `frozen`: only runs whose middle column is frozen.
 */
export function pickCrossings(S, claim, { frozen = false, minLen = 4, maxLen = 18, dry = 10, margin = 4 } = {}) {
  const out = [];
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  for (const axis of ['z', 'x']) {
    const A = axis === 'z' ? W : D, B = axis === 'z' ? D : W;
    for (let a = margin; a < A - margin; a++) {
      const xz = (b) => (axis === 'z' ? [claim.minX + a, claim.minZ + b] : [claim.minX + b, claim.minZ + a]);
      let s = -1;
      for (let b = 0; b <= B; b++) {
        const wet = b < B && S.waterAt(...xz(b));
        if (wet && s < 0) s = b;
        if (wet || s < 0) continue;
        const len = b - s, e = b;
        const begin = s;
        s = -1;
        if (len < minLen || len > maxLen || begin - dry < margin || e + dry > B - margin) continue;
        if (frozen && !S.frozenAt(...xz(begin + (len >> 1)))) continue;
        let ok = true;
        // dry land on the line for `dry` cells past each bank; no trunk across the deck's width (3) plus the rails
        for (const [b0, b1] of [[begin - dry, begin - 1], [e, e + dry - 1]]) for (let t = b0; t <= b1 && ok; t++) for (let v = -2; v <= 2 && ok; v++) {
          const [x, z] = xz(t), [xx, zz] = axis === 'z' ? [x + v, z] : [x, z + v];
          if ((v === 0 && S.waterAt(xx, zz)) || S.topAt(xx, zz) > S.groundAt(xx, zz) || S.missingAt?.(xx, zz)) ok = false;
        }
        if (!ok) continue;
        const water = S.groundAt(...xz(begin));
        const minBank = Math.min(S.groundAt(...xz(begin - 1)), S.groundAt(...xz(e))) - water;
        // the landing pads (3 cells off the water, 3 deep, the deck's width plus the rails): their level L and their tallest column
        let L = water + BRIDGE.clearance + 5, lowG = Infinity;
        for (const [t0, away] of [[begin - 3, -1], [e + 2, 1]]) for (let d = 0; d <= 2; d++) for (let v = -2; v <= 2; v++) {
          const [x, z] = xz(t0 + away * d), [xx, zz] = axis === 'z' ? [x + v, z] : [x, z + v];
          L = Math.max(L, S.groundAt(xx, zz)); lowG = Math.min(lowG, S.groundAt(xx, zz));
          if (S.waterAt(xx, zz)) lowG = -Infinity; // a pad is never written in water
        }
        if (L - lowG > 8) continue;
        out.push({ axis, line: axis === 'z' ? claim.minX + a : claim.minZ + a, from: axis === 'z' ? claim.minZ + begin : claim.minX + begin, len, water, minBank, level: L, pad: L - lowG });
      }
    }
  }
  out.sort((p, q) => p.water - q.water || (p.level - p.water) - (q.level - q.water) || p.pad - q.pad || q.len - p.len || p.line - q.line || p.from - q.from || (p.axis < q.axis ? -1 : p.axis > q.axis ? 1 : 0));
  return out;
}

/**
 * The bridge section (stage `ground`): `{nodes, edges, input, note}` for crossings_demo. `opts`: {rect: [x0, z0, x1, z1], variant: flat |
 * river | frozen | hill, base: {minX, minZ, width, depth, values}, P: params}.
 */
export function bridgeSection(ctx, r, { rect, variant, base, P }) {
  const { survey: S } = ctx;
  if (variant === 'hill') return { nodes: {}, edges: [], input: null, note: null };
  if (variant === 'flat') return flatSection(ctx, r, rect, base, P);
  const picks = pickCrossings(S, ctx.claim, variant === 'frozen' ? { frozen: true, minLen: 8 } : { maxLen: 20, dry: 5 });
  // the first crossing (of the best 40) whose arch passes §3's checks over the survey with its pads
  const c = picks.slice(0, 40).find((q) => archFits(S, q));
  if (!c) return { nodes: {}, edges: [], input: null, note: `crossings_demo (${variant}): no straight crossing of the water takes an arch` };
  // the landings 3 cells off the water (a walk keeps its half width plus one from water), each on a level pad raised in stage
  // `ground` (the foundation role, in the shared base) to L: the higher bank, and high enough for the arch's clearance over the water
  const at = (t) => (c.axis === 'z' ? [c.line, c.from + t] : [c.from + t, c.line]);
  const lat = (x, z, v) => (c.axis === 'z' ? [x + v, z] : [x, z + v]);
  const ends = [{ t: -3, away: -1 }, { t: c.len + 2, away: 1 }];
  let L = c.water + BRIDGE.clearance + 5;
  for (const e of ends) for (let d = 0; d <= 2; d++) for (let v = -2; v <= 2; v++) { const [x, z] = lat(...at(e.t + e.away * d), v); L = Math.max(L, S.groundAt(x, z)); }
  const pad = r.part('pads', { stage: 'ground' });
  const mats = [r.material('foundation', 'pad'), r.material('path', 'pad')];
  const cols = [];
  for (const e of ends) for (let d = 0; d <= 2; d++) for (let v = -2; v <= 2; v++) {
    const [x, z] = lat(...at(e.t + e.away * d), v), g = S.groundAt(x, z);
    if (g >= L) continue;
    base.values[(x - base.minX) + (z - base.minZ) * base.width] += L - g;
    cols.push(x, z, g + 1, L - 1, 0, x, z, L, L, 1);
  }
  if (cols.length) { pad._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: mats, cond: 0, walk: false }); (r.meta.parts.pads ??= {}).kind = 'add'; }
  const [ax, az] = at(ends[0].t), [bx, bz] = at(ends[1].t);
  const nodes = { cross_a: { at: [ax, L + 1, az], kind: 'junction' }, cross_b: { at: [bx, L + 1, bz], kind: 'junction' } };
  const edges = [{ id: 'cross_arch', from: 'cross_a', to: 'cross_b', width: 3, movers: ['player', 'villager'], spans: ['bridge'], once: 'bridge', approach: 0, t3: { bridge: { form: 'arch', clearance: BRIDGE.clearance, width: 3 } } }];
  r.meta.crossings = { ...(r.meta.crossings ?? {}), river: { ...c, level: L, anchors: [nodes.cross_a.at, nodes.cross_b.at] } };
  return { nodes, edges, input: null, note: `${variant}: the ${c.len}-wide run at ${c.axis === 'z' ? `x ${c.line}, z ${c.from}` : `z ${c.line}, x ${c.from}`} (water at ${c.water}, banks ${c.minBank} over it), landings at ${L}` };
}

/** Whether an arch of the crossing's span (the run plus 2 dry cells each side) passes checkBridge over the survey with its pads at the level. */
function archFits(S, c) {
  const at = (t) => (c.axis === 'z' ? [c.line, c.from + t] : [c.from + t, c.line]);
  const dir = c.axis === 'z' ? [0, 1] : [1, 0];
  const pads = new Set();
  for (const [t0, away] of [[-3, -1], [c.len + 2, 1]]) for (let d = 0; d <= 2; d++) for (let v = -2; v <= 2; v++) {
    const [x, z] = at(t0 + away * d);
    pads.add(c.axis === 'z' ? `${x + v},${z}` : `${x},${z + v}`);
  }
  const g = (x, z) => (pads.has(`${x},${z}`) ? Math.max(c.level, S.groundAt(x, z)) : S.groundAt(x, z));
  const land = surveyLand({ ...S, groundAt: g, topAt: (x, z) => (pads.has(`${x},${z}`) ? g(x, z) : S.topAt(x, z)) });
  const [ax, az] = at(-3);
  return checkBridge(land, [ax, c.level, az], dir, c.len + 4, 0, 3, { form: 'arch', clearance: BRIDGE.clearance }).ok;
}

function flatSection(ctx, r, rect, base, P) {
  const { survey: S } = ctx;
  const [x0r, z0r, x1r, z1r] = rect;
  if (x1r - x0r + 1 < 112 || z1r - z0r + 1 < 80) throw new Error(`crossings_demo (flat): the bridge half needs 112x80 (got ${x1r - x0r + 1}x${z1r - z0r + 1})`);
  const H = P.bank ?? 16;
  const cz = z0r + ((z1r - z0r + 1) >> 1), x0 = x0r + 32;
  const banks = SECTIONS.map((sec, s) => {
    const xc = x0 + s * STEP, zn = cz - (sec.n >> 1) - 1, zs = zn + sec.n + 1;
    return { s, ...sec, xc, zn, zs, rects: [[xc - (LEN >> 1), zn - 15, xc + (LEN >> 1) - 1, zn], [xc - (LEN >> 1), zs, xc + (LEN >> 1) - 1, zs + 15]] };
  });
  const part = r.part('banks', { stage: 'ground' });
  const mats = [r.material('surface', 'bank'), r.material('subsurface', 'bank'), r.material('rock', 'bank')];
  const cols = [];
  for (const b of banks) for (const [ax, az, bx, bz] of b.rects) for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) {
    base.values[(x - base.minX) + (z - base.minZ) * base.width] += H;
    const g = S.groundAt(x, z);
    cols.push(x, z, g + 1, g + H - 4, 2, x, z, g + H - 3, g + H - 1, 1, x, z, g + H, g + H, 0);
  }
  part._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: mats, cond: 0, walk: false });
  (r.meta.parts.banks ??= {}).kind = 'add';
  // a fence round each bank's top (the drop is H), but at the landing (the deck's 3 lanes and its rails), a lantern on every 6th post
  const fence = r.part('bank_rails', { stage: 'ground' });
  const fcols = [], fmats = [r.material('rail', 'bank rail'), 'minecraft:lantern[hanging=false,waterlogged=false]'];
  for (const b of banks) b.rects.forEach(([ax, az, bx, bz], side) => {
    const lip = side === 0 ? bz : az;
    let k = 0;
    const post = (x, z) => {
      if (z === lip && x >= b.xc - 3 && x <= b.xc + 1) return;
      const y = S.groundAt(x, z) + H + 1;
      fcols.push(x, z, y, y, 0);
      if (k++ % 6 === 0) fcols.push(x, z, y + 1, y + 1, 1);
    };
    for (let x = ax; x <= bx; x++) { post(x, az); post(x, bz); }
    for (let z = az + 1; z < bz; z++) { post(ax, z); post(bx, z); }
  });
  fence._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: fcols, materials: fmats, cond: 0, walk: false });
  const nodes = {}, edges = [];
  for (const b of banks) {
    const xm = b.xc - 1;
    nodes[`bn${b.s}`] = { at: [xm, S.groundAt(xm, b.zn) + H + 1, b.zn], kind: 'junction' };
    nodes[`bs${b.s}`] = { at: [xm, S.groundAt(xm, b.zs) + H + 1, b.zs], kind: 'junction' };
    edges.push({ id: `${b.form}_${b.n}`, from: `bn${b.s}`, to: `bs${b.s}`, width: 3, movers: ['player', 'villager'], spans: ['bridge'], once: 'bridge', approach: 0, t3: { bridge: { form: b.form, clearance: BRIDGE.clearance, width: 3 } } });
  }
  r.meta.crossings = { ...(r.meta.crossings ?? {}), bank: H, sections: banks.map((b) => ({ n: b.n, form: b.form, x: b.xc - 1, zn: b.zn, zs: b.zs })) };
  return { nodes, edges, input: null, note: `flat: banks ${H} high, gaps ${banks.map((b) => `${b.n} (${b.form})`).join(', ')}` };
}

/** The bridges the route pass found, emitted in `stage` (part `links_bridges`). */
export function emitDemoBridges(r, { stage, light } = {}) {
  return emitRouteBridges(r, { stage, part: 'links_bridges', prefix: 'bridge_', ...(light === null ? { style: { light: null } } : {}) });
}
