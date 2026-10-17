// (6c T3a) The bridge rules of the checker (docs/CONTRACT.md "Phase 6c slice T3" §5): for every bridge the plan meta records
// (`meta.bridges`, written by lib/connectors/bridgeGeom.mjs bridgeSpan), read from the world's blocks (the virtual world at plan time,
// a realised dump world in the gate, so the plan's numbers are only its inputs: n, the landings, the width, the form, the supports it
// claims):
//   M10:bridge  each walk cell's surface (a bottom slab an odd half block, a full block an even one) on §3's formula (a beam straight,
//               an arch's camber), adjacent cells (landings included) within one half block, the span in 1..32 (an arch 4..24); a
//               beam's supports at most 8 deck cells apart, each pier solid (no gravity block) from the deck down to 2 under the
//               pre-region ground, at most 24 tall; an arch's ring and spandrels solid from the intrados to the deck; no cell written
//               where the pre-region world held water, lava or ice; over water, the clear cells under the bridge (a beam everywhere,
//               an arch over the middle third of the water's run) at least the asked clearance
//   M8          a barrier (rail) beside every deck cell on both edges
//   M6          2 clear over every walk cell
// Per bridge `metrics.bridges.per` records the counts (cells, wrong, missing, maxStep, railed, headroom, piersOk, bodyOk, wet,
// under). Warnings, as M10. Called by checkRegion (check.mjs); leaves `vw` as it found it.
import { profile, y2Of, rightOf } from '../connectors/ropeGeom.mjs';
import { BRIDGE, sagFor, piersFor } from '../connectors/bridgeGeom.mjs';
import { F_WRITTEN } from './vworld.mjs';

const nameOf = (s) => String(s ?? '').replace(/\[.*$/, '');
const ICE = /(^|:)(ice|packed_ice|blue_ice|frosted_ice)$/;

/** The bridge rules: findings `M10:bridge`, `M8`, `M6` and `metrics.bridges`. */
export function bridgeRules({ ir, vw, bridges, want, findings, metrics, finding }) {
  const P = vw.pal, out = [];
  const push = (rule, m, count, sample, message) => { if (want.has(rule.replace(/:.*$/, ''))) findings.push(finding(rule, m.part ?? null, m.stage ?? null, count, sample, message)); };
  const wetBase = (x, y, z) => { const b = vw.base(x, y, z); return P.fluid[b] || ICE.test(nameOf(P.states[b])); };
  for (const m of bridges) {
    const pid = m.id;
    const { n, rise, from, dir, lo, hi, form } = m;
    const [x0, y0, z0] = from, [dx, dz] = dir, [rx, rz] = rightOf(dir);
    const want2 = [...profile(n, y0, rise, sagFor(form, n)), 2 * (y0 + rise)];
    const yHi = Math.max(y0, y0 + rise) + 4, yLo = Math.min(y0, y0 + rise) - 6;
    const surface = (x, z) => {
      for (let y = yHi; y >= yLo; y--) {
        const b = vw.get(x, y, z);
        if (P.air[b] || P.passable[b]) continue;
        if (!(P.floor[b] || P.half[b])) return null;
        if (!P.passable[vw.get(x, y + 1, z)] || !P.passable[vw.get(x, y + 2, z)]) return null;
        return y2Of(y, P.half[b]);
      }
      return null;
    };
    const row = { path: pid, form, n, rise, width: hi - lo + 1, cells: 0, wrong: 0, missing: 0, maxStep: 0, railed: 0, headroom: 0, piers: (m.piers ?? []).length, piersOk: 0, bodyOk: true, wet: 0, under: null };
    const wrong = [], missing = [];
    for (let v = lo; v <= hi; v++) {
      let prev = null;
      for (let i = 0; i <= n + 1; i++) {
        const x = x0 + dx * i + rx * v, z = z0 + dz * i + rz * v;
        const got = surface(x, z);
        if (i > 0 && i <= n) {
          row.cells++;
          if (got === null) { row.missing++; missing.push([x, Math.floor(want2[i] / 2), z]); }
          else if (got !== want2[i]) { row.wrong++; wrong.push([x, Math.floor((got + 1) / 2), z]); }
        }
        if (got !== null && prev !== null) row.maxStep = Math.max(row.maxStep, Math.abs(got - prev));
        prev = got;
      }
    }
    const spanOk = n >= BRIDGE.spanMin && n <= BRIDGE.spanMax && (form !== 'arch' || (n >= BRIDGE.archMin && n <= BRIDGE.archMax));
    if (!spanOk) push('M10:bridge', m, 1, [from], `bridge ${pid}: span ${n} is outside ${form === 'arch' ? `${BRIDGE.archMin}..${BRIDGE.archMax} (an arch)` : `${BRIDGE.spanMin}..${BRIDGE.spanMax}`}`);
    if (row.missing) push('M10:bridge', m, row.missing, missing, `bridge ${pid}: ${row.missing} of ${row.cells} deck cell(s) hold no walk surface in the deck's range`);
    if (row.wrong) push('M10:bridge', m, row.wrong, wrong, `bridge ${pid}: ${row.wrong} of ${row.cells} deck cell(s) off the ${form}'s profile`);
    if (row.maxStep > 1) push('M10:bridge', m, 1, [from], `bridge ${pid}: adjacent deck cells differ by ${row.maxStep} half blocks (at most 1)`);
    // supports: a beam's piers (at most pierEvery deck cells apart, the landings counted), each solid, no gravity block, from the deck
    // down to 2 under the pre-region ground, at most pierDepth tall
    const badSup = [];
    if (form === 'beam') {
      const idx = [0, ...(m.piers ?? []).map((q) => q.i).sort((a, b) => a - b), n + 1];
      for (let t = 1; t < idx.length; t++) if (idx[t] - idx[t - 1] > BRIDGE.pierEvery) badSup.push({ why: 'spacing', from: idx[t - 1], to: idx[t] });
      if ((m.piers ?? []).length < piersFor(n)) badSup.push({ why: 'count', have: (m.piers ?? []).length, need: piersFor(n) });
      const byPier = new Map();
      for (const [x, py0, py1, z, i] of m.pierCols ?? []) {
        let ok = py1 - py0 + 1 <= BRIDGE.pierDepth;
        for (let y = py0; y <= py1 && ok; y++) { const b = vw.get(x, y, z); if (!P.solid[b] || P.gravity[b] || P.fluid[b]) ok = false; }
        // 2 deep: the pier's bottom 2 cells stood in the pre-region ground (solid there), and solid ground under the pier
        const base0 = vw.base(x, py0, z), base1 = vw.base(x, py0 + 1, z), under = vw.get(x, py0 - 1, z);
        if (!P.solid[base0] || !P.solid[base1] || P.fluid[base0] || P.fluid[base1]) ok = false;
        if (!P.solid[under] || P.gravity[under] || P.fluid[under]) ok = false;
        if (wetBase(x, py0, z) || wetBase(x, py1, z)) ok = false;
        byPier.set(i, (byPier.get(i) ?? true) && ok);
      }
      for (const q of m.piers ?? []) { if (byPier.get(q.i)) row.piersOk++; else badSup.push({ why: 'pier', i: q.i, at: [q.x, q.y0, q.z] }); }
    } else if (form === 'arch') {
      for (const [x, by0, by1, z] of m.body ?? []) for (let y = by0; y <= by1; y++) { const b = vw.get(x, y, z); if (!P.solid[b] || P.gravity[b]) { row.bodyOk = false; badSup.push({ why: 'ring', at: [x, y, z] }); break; } }
    }
    if (badSup.length) push('M10:bridge', m, badSup.length, badSup.slice(0, 8).map((q) => q.at ?? from), `bridge ${pid}: ${badSup.length} support fault(s): ${badSup.slice(0, 4).map((q) => (q.why === 'spacing' ? `deck cells ${q.from}..${q.to} unsupported (more than ${BRIDGE.pierEvery})` : q.why === 'count' ? `${q.have} pier(s), at least ${q.need}` : q.why === 'pier' ? `pier at deck cell ${q.i} not solid from the deck to 2 under the ground (or over ${BRIDGE.pierDepth} tall, or on water)` : 'the arch ring is not solid')).join('; ')}`);
    // no cell written where the pre-region world held water, lava or ice (the bridge's own part)
    const wetCells = [];
    const pi = ir.parts.findIndex((q) => q.id === m.part);
    const b = m.box;
    if (b && pi >= 0) for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) for (let y = b.minY; y <= b.maxY; y++) {
      if (!(vw.flags(x, y, z) & F_WRITTEN) || vw.partAt(x, y, z) !== pi) continue;
      if (wetBase(x, y, z)) wetCells.push([x, y, z]);
    }
    row.wet = wetCells.length;
    if (wetCells.length) push('M10:bridge', m, wetCells.length, wetCells.slice(0, 8), `bridge ${pid}: ${wetCells.length} cell(s) written in water, lava or ice (writes in water wait for H)`);
    // the clearance over water: per water column under the span, the clear cells between the water's surface (its top fluid or ice
    // cell in the pre-region world) and the bridge's lowest solid cell over it
    const wetCols = [];
    for (let i = 1; i <= n; i++) {
      const x = x0 + dx * i, z = z0 + dz * i;
      let top = null;
      for (let y = Math.min(y0, y0 + rise) + 2; y >= yLo - 40; y--) { if (wetBase(x, y, z)) { top = y; break; } if (P.solid[vw.base(x, y, z)]) break; }
      if (top === null) continue;
      let low = null;
      for (let y = top + 1; y <= yHi; y++) if (P.solid[vw.get(x, y, z)]) { low = y; break; }
      wetCols.push({ i, clear: low === null ? 99 : low - top - 1 });
    }
    if (wetCols.length) {
      const first = wetCols[0].i, last = wetCols[wetCols.length - 1].i, third = Math.floor((last - first + 1) / 3);
      const judged = wetCols.filter((c) => form !== 'arch' || (c.i >= first + third && c.i <= last - third));
      const have = Math.min(...judged.map((c) => c.clear));
      row.under = { need: m.clearance ?? BRIDGE.clearance, have };
      if (have < row.under.need) push('M10:bridge', m, 1, [from], `bridge ${pid}: ${have} clear cell(s) over the water under it, asked ${row.under.need}${form === 'arch' ? ' (the middle third)' : ''}`);
    }
    // rails on both edges of every deck cell (a barrier at the feet cell beside the deck: M8's 1.5) and 2 clear over every walk cell
    for (let i = 1; i <= n; i++) {
      const x = x0 + dx * i, z = z0 + dz * i;
      const feet = (xx, zz) => { const s = surface(xx, zz); return s === null ? null : Math.floor((s + 1) / 2) + 1; };
      let ok = true;
      for (const v of [lo - 1, hi + 1]) {
        const f = feet(x + rx * (v < lo ? lo : hi), z + rz * (v < lo ? lo : hi));
        if (f === null || !P.barrier[vw.get(x + rx * v, f, z + rz * v)]) ok = false;
      }
      if (ok) row.railed++;
      let clear = true;
      for (let v = lo; v <= hi; v++) { const f = feet(x + rx * v, z + rz * v); if (f === null || !P.passable[vw.get(x + rx * v, f, z + rz * v)] || !P.passable[vw.get(x + rx * v, f + 1, z + rz * v)]) clear = false; }
      if (clear) row.headroom++;
    }
    if (row.railed < n) push('M8', m, n - row.railed, [from], `bridge ${pid}: ${n - row.railed} of ${n} deck cell(s) without a rail on both edges`);
    if (row.headroom < n) push('M6', m, n - row.headroom, [from], `bridge ${pid}: ${n - row.headroom} of ${n} deck cell(s) without 2 clear over the walk`);
    row.ok = spanOk && !row.missing && !row.wrong && row.maxStep <= 1 && !badSup.length && !row.wet && (!row.under || row.under.have >= row.under.need);
    out.push(row);
  }
  metrics.bridges = { bridges: out.length, ok: out.filter((r) => r.ok).length, per: out };
}
