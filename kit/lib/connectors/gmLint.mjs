// (7a GM) A static check for gate circuits (the layouts of gmCircuit.mjs and the bench of gmBench.mjs): which signal sources can
// reach which cell, by the 26.3 redstone rules that gm-probe confirmed, plus the placement rules of HANDOFF-GM "Step 1b fit analysis".
// It does not simulate timing (gmCircuit.latchTiming does the static timing; the server does the rest). It answers "can net A's
// signal get into cell B", "is every part supported and mounted", "is anything visible", so a layout is checked before it goes to
// the server, and checked again by gm-unit.
//
//   lint(cells, opts) -> {nets: Map<key, Set<label>>, problems: [...], edges, dustInfo}
//   cells: Map "x,y,z" -> {t, f?, mount?, label?, stop?, expect?, name?}
//     t: 'block' (a full conductor) | 'nc' (a sturdy non-conductor) | 'air' | 'dust' | 'rep' | 'cmp' | 'torch' | 'obs' | 'lever' |
//        'trap' | 'piston' | 'door' | 'sensor'
//     f: for rep and cmp the direction toward the INPUT (Minecraft's `facing`); for obs the direction it WATCHES (its face); for
//        piston the direction it pushes
//     mount: [x,y,z] the block a torch or lever hangs on (a torch whose mount is below it stands; else it is a wall torch)
//   opts.solid(key) -> true when an unlisted cell is a full block (a gatehouse's own fill), default: unlisted cells are air
//   opts.envelope: Set of keys a circuit may influence; any edge from a listed cell into a cell outside it (other than air) is a problem
//   dir: 'n','s','e','w','u','d' (n = -z, s = +z, e = +x, w = -x, u = +y, d = -y)
//
// The rules (each named in the problem it reports):
//   DUST-SUPPORT     dust, a repeater and a comparator stand on a sturdy block; a torch or a lever hangs on a full block
//   DUST-CONNECT     dust links to dust beside it, one up (the cell above the lower dust free) and one down (the cell beside the upper
//                    dust free); to a repeater only along its axis; to a comparator on any side; to an observer only at its back
//   DUST-POINT       dust powers the block under it and the cells it points at: its links, both ways along a single link, all four
//                    sides when it has none
//   STRONG           repeater, comparator and observer outputs, a torch's block above and a lever's mount are strongly powered;
//                    a strongly powered block powers dust on all six sides, a weakly powered one (dust on or into it) does not
//   CMP-SIDE         a comparator's side reads only dust, diodes and redstone blocks: a torch or a powered block beside it is
//                    not read (26.3), and a torch there is reported
//   LOCK             a repeater locks only from a diode facing into its side
//   OBS              an observer fires on a change of the cell it watches (dust, a diode, a torch, a lever, a trapdoor, a piston)
//   ACTUATOR         a trapdoor, door or piston beside any powered cell (block, dust pointing in, torch, lever, diode output)
//                    reacts; a piston also by quasi-connectivity from the cell above it
//   EXPECT           a cell with `expect` carries exactly those labels
//   ENVELOPE         nothing reaches out of opts.envelope

export const DIRS = { n: [0, 0, -1], s: [0, 0, 1], e: [1, 0, 0], w: [-1, 0, 0], u: [0, 1, 0], d: [0, -1, 0] };
export const OPP = { n: 's', s: 'n', e: 'w', w: 'e', u: 'd', d: 'u' };
const H = ['n', 's', 'e', 'w'];
const ALL = Object.keys(DIRS);
const add = (p, d) => [p[0] + DIRS[d][0], p[1] + DIRS[d][1], p[2] + DIRS[d][2]];
const key = (p) => p.join(',');
const parse = (k) => k.split(',').map(Number);
const dirTo = (a, b) => ALL.find((d) => key(add(a, d)) === key(b));
const DIODES = ['rep', 'cmp'];
const ACTUATORS = ['trap', 'piston', 'door'];
const CHANGING = ['dust', 'rep', 'cmp', 'torch', 'lever', 'trap', 'piston', 'door', 'sensor', 'obs'];

export function lint(cells, opts = {}) {
  const solid = opts.solid ?? (() => false);
  const at = (p) => cells.get(key(p)) ?? (solid(key(p)) ? { t: 'block', implicit: true } : { t: 'air' });
  const cond = (c) => c.t === 'block';
  const sturdy = (c) => c.t === 'block' || c.t === 'nc' || c.t === 'obs' || c.t === 'piston';
  const problems = [];
  const P = (rule, msg) => problems.push(`${rule}: ${msg}`);
  // a diode's input side, output side and side axis
  const backOf = (p, c) => add(p, c.f);
  const frontOf = (p, c) => add(p, OPP[c.f]);
  const isSide = (p, c, q) => { const d = dirTo(p, q); return d && H.includes(d) && d !== c.f && d !== OPP[c.f]; };

  // ---- support and mounts
  for (const [k, c] of cells) {
    const p = parse(k);
    if (['dust', 'rep', 'cmp'].includes(c.t) && !sturdy(at(add(p, 'd')))) P('DUST-SUPPORT', `${c.t} ${k}${c.name ? ` (${c.name})` : ''} has no sturdy block under it`);
    if (['torch', 'lever'].includes(c.t)) {
      if (!c.mount) P('DUST-SUPPORT', `${c.t} ${k} names no mount`);
      else if (!cond(at(c.mount)) || !dirTo(p, c.mount)) P('DUST-SUPPORT', `${c.t} ${k} hangs on ${key(c.mount)}, which is not a full block beside it`);
      else if (c.t === 'torch' && dirTo(p, c.mount) === 'u') P('DUST-SUPPORT', `torch ${k} cannot hang under its mount`);
    }
    if (DIODES.includes(c.t) && !H.includes(c.f)) P('DUST-SUPPORT', `${c.t} ${k} faces ${c.f}: diodes are horizontal`);
  }

  // ---- dust links (DUST-CONNECT) and where each dust points (DUST-POINT)
  const connectsTo = (c, h) => { // c is the neighbour in direction h from the dust
    if (c.t === 'dust') return true;
    if (c.t === 'rep') return c.f === h || c.f === OPP[h];
    if (c.t === 'obs') return c.f === h; // its back (the output) faces the dust
    return ['torch', 'cmp', 'lever', 'sensor'].includes(c.t);
  };
  const dustInfo = new Map();
  for (const [k, c] of cells) {
    if (c.t !== 'dust') continue;
    const p = parse(k);
    const links = [], wires = [];
    const aboveCond = cond(at(add(p, 'u')));
    for (const h of H) {
      const n = add(p, h), cn = at(n);
      if (connectsTo(cn, h)) { links.push(h); if (cn.t === 'dust') wires.push(key(n)); continue; }
      const up = add(n, 'u'), dn = add(n, 'd');
      if (!aboveCond && sturdy(cn) && at(up).t === 'dust') { links.push(h); wires.push(key(up)); continue; }
      if (!cond(cn) && at(dn).t === 'dust') { links.push(h); wires.push(key(dn)); }
    }
    const point = links.length === 0 ? [...H] : links.length === 1 ? [links[0], OPP[links[0]]] : links;
    dustInfo.set(k, { point: [...new Set(point)], links, wires });
  }

  // ---- the influence graph
  const edges = new Map();
  const edge = (a, b, why) => { if (!edges.has(a)) edges.set(a, []); edges.get(a).push([b, why]); };
  const strong = new Set(); // blocks strongly powered by something
  const intoCell = (srcKey, srcP, n, why, { strongInto = false } = {}) => { // srcKey powers the cell n (by being next to it)
    const cn = at(n), nk = key(n);
    if (cond(cn)) { edge(srcKey, nk, strongInto ? 'strong' : 'weak'); if (strongInto) strong.add(nk); return; }
    if (cn.t === 'dust') { edge(srcKey, nk, why); return; }
    if (cn.t === 'rep') {
      if (key(backOf(n, cn)) === key(srcP)) edge(srcKey, nk, `${why}->rep in`);
      else if (isSide(n, cn, srcP) && DIODES.includes(at(srcP).t) && key(frontOf(srcP, at(srcP))) === nk) edge(srcKey, nk, 'LOCK');
      return;
    }
    if (cn.t === 'cmp') {
      if (key(backOf(n, cn)) === key(srcP)) edge(srcKey, nk, `${why}->cmp back`);
      else if (isSide(n, cn, srcP)) {
        const s = at(srcP);
        if (s.t === 'dust' || (DIODES.includes(s.t) && key(frontOf(srcP, s)) === nk)) edge(srcKey, nk, 'CMP-SIDE');
        else if (s.t === 'torch') P('CMP-SIDE', `torch ${key(srcP)} beside comparator ${nk}'s side is not read on 26.3 (put dust between)`);
      }
      return;
    }
    if (ACTUATORS.includes(cn.t)) { edge(srcKey, nk, `${why}->${cn.t}`); return; }
  };
  for (const [k, c] of cells) {
    const p = parse(k);
    if (c.t === 'dust') {
      const di = dustInfo.get(k);
      intoCell(k, p, add(p, 'd'), 'dust');
      for (const h of di.point) intoCell(k, p, add(p, h), 'dust');
      for (const w of di.wires) edge(k, w, 'wire');
    } else if (DIODES.includes(c.t)) {
      intoCell(k, p, frontOf(p, c), c.t, { strongInto: true });
    } else if (c.t === 'obs') {
      const w = add(p, c.f);
      if (CHANGING.includes(at(w).t)) edge(key(w), k, 'OBS');
      intoCell(k, p, add(p, OPP[c.f]), 'obs', { strongInto: true });
    } else if (c.t === 'torch') {
      const mk = key(c.mount ?? [NaN, NaN, NaN]);
      const standing = c.mount && dirTo(p, c.mount) === 'd';
      for (const d of ALL) {
        const n = add(p, d);
        if (key(n) === mk) continue;
        if (d === 'u') { intoCell(k, p, n, 'torch', { strongInto: true }); continue; }
        if (d === 'd' && standing) continue;
        if (cond(at(n))) continue; // a torch beside a block does not power it
        intoCell(k, p, n, 'torch');
      }
    } else if (c.t === 'lever') {
      for (const d of ALL) {
        const n = add(p, d);
        if (c.mount && key(n) === key(c.mount)) intoCell(k, p, n, 'lever', { strongInto: true });
        else if (!cond(at(n))) intoCell(k, p, n, 'lever');
      }
    } else if (c.t === 'sensor') {
      for (const d of ALL) { const n = add(p, d); if (!cond(at(n))) intoCell(k, p, n, 'sensor'); }
    }
  }
  // a powered block: its mounted torches, the diodes reading it from their back, actuators beside it (and a piston under it by
  // quasi-connectivity), and (strong only) dust on all six sides. A block counts as powered once any edge reaches it.
  const blocksPowered = new Set([...edges.values()].flat().map(([b]) => b).filter((b) => cond(at(parse(b)))));
  for (const bk of blocksPowered) {
    const p = parse(bk);
    for (const d of ALL) {
      const n = add(p, d), cn = at(n), nk = key(n);
      if (cn.t === 'dust') { if (strong.has(bk)) edge(bk, nk, 'strong-block->dust'); continue; }
      if (cn.t === 'torch') { if (key(cn.mount ?? [NaN]) === bk) edge(bk, nk, 'mount'); continue; }
      if (DIODES.includes(cn.t)) { if (key(backOf(n, cn)) === bk) edge(bk, nk, 'block->diode in'); continue; }
      if (ACTUATORS.includes(cn.t)) edge(bk, nk, `block->${cn.t}`);
      const below = at(add(n, 'd'));
      if (below.t === 'piston' && d !== 'd') edge(bk, key(add(n, 'd')), 'quasi-connectivity');
    }
  }
  // quasi-connectivity from non-block sources into the cell above a piston
  for (const [k, c] of cells) {
    if (c.t !== 'piston') continue;
    const above = key(add(parse(k), 'u'));
    for (const [src, outs] of edges) for (const [dst] of outs) if (dst === above && !cond(at(parse(above)))) edge(src, k, 'quasi-connectivity');
  }

  // ---- taint from labelled sources
  const nets = new Map();
  for (const [k, c] of cells) if (c.label) {
    const seen = new Set([k]);
    const q = [k];
    while (q.length) {
      const cur = q.shift();
      if (!nets.has(cur)) nets.set(cur, new Set());
      nets.get(cur).add(c.label);
      const cc = cells.get(cur);
      if (cur !== k && cc?.stop) continue; // an inverter, a memory or a pulse source: its output is its own label
      for (const [nx] of edges.get(cur) ?? []) if (!seen.has(nx)) { seen.add(nx); q.push(nx); }
    }
  }
  for (const [k, c] of cells) if (c.expect) {
    const got = [...(nets.get(k) ?? [])].sort();
    const want = [...c.expect].sort();
    if (got.join() !== want.join()) P('EXPECT', `${k} (${c.t}${c.name ? ' ' + c.name : ''}) carries [${got}] expected [${want}]`);
  }
  if (opts.envelope) {
    for (const [a, outs] of edges) {
      if (!opts.envelope.has(a) || !cells.has(a)) continue;
      for (const [b, why] of outs) if (!opts.envelope.has(b) && at(parse(b)).t !== 'air') P('ENVELOPE', `${a} reaches ${b} outside the envelope (${why})`);
    }
  }
  return { nets, problems: [...new Set(problems)], dustInfo, edges };
}

/**
 * HIDDEN: every cell of a gate that is not a plain block lies inside the box and off its faces (d = 0 and d = depth-1, u = +-half,
 * the floor and the roof), except the cells named in `allowed` (the passage, the lintel triggers, the sensor). Cells in the local
 * frame [u, d, r, state] (gmCircuit's), `box` = {half, depth, roof} (u in [-half, half], d in [0, depth-1], rows up to the roof row).
 */
export function hiddenProblems(cells, box, allowed = new Set()) {
  const out = [];
  for (const [u, d, r, s] of cells) {
    const k = `${u},${d},${r}`;
    if (allowed.has(k)) continue;
    const plain = !/redstone|repeater|comparator|observer|torch|lever|piston|daylight|trapdoor|^minecraft:air$/.test(s);
    if (plain) continue;
    if (Math.abs(u) >= box.half || d <= 0 || d >= box.depth - 1 || r >= box.roof) out.push(`HIDDEN: ${k} ${s.replace('minecraft:', '').replace(/\[.*/, '')} is on a face or outside the box`);
  }
  return out;
}

/**
 * (LV) The steady state of a small circuit with its levers set: the signal levels lint's reach cannot give (a comparator in subtract mode,
 * dust decay), so a unit can check a circuit's output in every lever state (the drawbridge's two-way levers). Same cells and the same 26.3
 * rules as `lint` (its dust links and points), plus `on` on a lever and `t: 'fence'` (a non-conductor that holds nothing). Levels by fixed-point
 * iteration: dust = the best of its sources (a strongly powered block beside it, a lever, a lit torch, a diode facing into it) and its wires
 * less 1; a repeater 15 when its back gives a signal (no locking: a circuit that locks one is out of scope); a comparator (subtract)
 * rear - max(sides), its sides reading dust and diodes facing in only; a torch lit unless its mount is powered. A block's level: the strong
 * power into it (a diode facing in, a lever on it, a lit torch under it) or dust on it or pointing into it. Returns {level(key), powered(key)
 * (an actuator's input: any neighbour's signal into it), stable (false: it did not settle, e.g. a clock), problems (lint's)}.
 */
export function settleSignals(cells, { iters = 400 } = {}) {
  const L = lint(cells, {});
  const at = (k) => cells.get(k) ?? { t: 'air' };
  const val = new Map();
  for (const [k, c] of cells) {
    if (c.t === 'dust' || c.t === 'rep' || c.t === 'cmp') val.set(k, 0);
    if (c.t === 'torch') val.set(k, 15);
  }
  const front = (k, c) => key(add(parse(k), OPP[c.f]));
  const back = (k, c) => key(add(parse(k), c.f));
  const isDiode = (c) => c.t === 'rep' || c.t === 'cmp';
  const strongInto = (bk) => {
    let best = 0;
    for (const d of ALL) {
      const nk = key(add(parse(bk), d)), c = cells.get(nk);
      if (!c) continue;
      if (isDiode(c) && front(nk, c) === bk) best = Math.max(best, val.get(nk));
      if (c.t === 'torch' && d === 'd' && val.get(nk) && key(c.mount) !== bk) best = 15;
      if (c.t === 'lever' && c.on && key(c.mount) === bk) best = 15;
    }
    return best;
  };
  const weakInto = (bk) => {
    let best = 0;
    for (const d of ALL) {
      const nk = key(add(parse(bk), d)), c = cells.get(nk);
      if (c?.t !== 'dust' || !val.get(nk)) continue;
      if (d === 'u' || L.dustInfo.get(nk).point.includes(OPP[d])) best = Math.max(best, val.get(nk));
    }
    return best;
  };
  const blockLevel = (k) => Math.max(strongInto(k), weakInto(k));
  // the signal the cell srcK gives into its neighbour intoK
  const signal = (srcK, intoK) => {
    const c = cells.get(srcK);
    if (!c) return 0;
    const d = ALL.find((x) => key(add(parse(srcK), x)) === intoK);
    if (c.t === 'block') return blockLevel(srcK);
    if (c.t === 'dust') return d === 'd' || L.dustInfo.get(srcK).point.includes(d) ? val.get(srcK) : 0;
    if (isDiode(c)) return front(srcK, c) === intoK ? val.get(srcK) : 0;
    if (c.t === 'torch') return val.get(srcK) && key(c.mount) !== intoK && !(d === 'd' && dirTo(parse(srcK), c.mount) === 'd') ? 15 : 0;
    if (c.t === 'lever') return c.on ? 15 : 0;
    return 0;
  };
  const input = (k) => { const b = at(k); return b.t === 'dust' ? val.get(k) : 0; };
  let stable = false;
  for (let it = 0; it < iters && !stable; it++) {
    const next = new Map();
    for (const [k, c] of cells) {
      if (c.t === 'torch') next.set(k, blockLevel(key(c.mount)) > 0 ? 0 : 15);
      else if (c.t === 'rep') { const b = back(k, c); next.set(k, Math.max(input(b), signal(b, k)) > 0 ? 15 : 0); }
      else if (c.t === 'cmp') {
        const b = back(k, c), rear = Math.max(input(b), signal(b, k));
        let side = 0;
        for (const h of H) {
          if (h === c.f || h === OPP[c.f]) continue;
          const nk = key(add(parse(k), h)), s = cells.get(nk);
          if (s?.t === 'dust') side = Math.max(side, val.get(nk));
          if (s && isDiode(s) && front(nk, s) === k) side = Math.max(side, val.get(nk));
        }
        next.set(k, Math.max(0, rear - side));
      } else if (c.t === 'dust') {
        let best = 0;
        for (const d of ALL) {
          const nk = key(add(parse(k), d)), s = cells.get(nk);
          if (!s) continue;
          if (s.t === 'block') best = Math.max(best, strongInto(nk));
          else if (s.t === 'lever' && s.on) best = 15;
          else if (s.t === 'torch' && val.get(nk) && key(s.mount) !== k && !(d === 'u' && dirTo(parse(nk), s.mount) === 'd')) best = 15;
          else if (isDiode(s) && front(nk, s) === k) best = Math.max(best, val.get(nk));
        }
        for (const w of L.dustInfo.get(k).wires) best = Math.max(best, (val.get(w) ?? 0) - 1);
        next.set(k, best);
      }
    }
    stable = true;
    for (const [k, v] of next) if (val.get(k) !== v) { val.set(k, v); stable = false; }
  }
  const powered = (k) => ALL.some((d) => signal(key(add(parse(k), d)), k) > 0);
  return { level: (k) => (cells.get(k)?.t === 'block' ? blockLevel(k) : val.get(k) ?? 0), powered, stable, problems: L.problems };
}
