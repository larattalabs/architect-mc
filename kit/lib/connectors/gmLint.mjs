// (7a GM) A static cross-talk check for gate circuits (the layouts of gmCircuit.mjs): which signal sources can reach which cell, by the
// 26.3 redstone rules the probe confirmed (dust steps, cut cells, strong and weak power, torches, diodes, observers). It does not simulate
// timing; it answers "can net A's signal get into net B", so a layout can be laid out and checked before it goes to the server.
//
//   lint(cells, {conductors}) -> {nets: Map<key, Set<label>>, problems: [...]}
//   cells: Map "x,y,z" -> {t: 'block'|'nc'|'air'|'dust'|'rep'|'cmp'|'torch'|'obs'|'lever'|'trap'|'piston'|'door'|'sensor', f?: dir, label?, mount?}
//   dir: 'n','s','e','w','u','d' (n = -z, s = +z, e = +x, w = -x, u = +y, d = -y)

export const DIRS = { n: [0, 0, -1], s: [0, 0, 1], e: [1, 0, 0], w: [-1, 0, 0], u: [0, 1, 0], d: [0, -1, 0] };
export const OPP = { n: 's', s: 'n', e: 'w', w: 'e', u: 'd', d: 'u' };
const H = ['n', 's', 'e', 'w'];
const add = (p, d) => [p[0] + DIRS[d][0], p[1] + DIRS[d][1], p[2] + DIRS[d][2]];
const key = (p) => p.join(',');
const parse = (k) => k.split(',').map(Number);

export function lint(cells) {
  const at = (p) => cells.get(key(p)) ?? { t: 'air' };
  const cond = (c) => c.t === 'block';
  const sturdy = (c) => c.t === 'block' || c.t === 'nc' || c.t === 'obs' || c.t === 'piston';
  const connectsTo = (c, dirFromDust) => {
    if (c.t === 'dust') return true;
    if (c.t === 'rep') return c.f === dirFromDust || c.f === OPP[dirFromDust]; // along its axis
    if (c.t === 'obs') return c.f === dirFromDust; // the observer's back faces the dust: f is the face it watches, so its back is OPP(f)
    return ['torch', 'cmp', 'lever', 'sensor'].includes(c.t);
  };
  const problems = [];
  // dust connections: per dust, the dirs it points (for power out) and its wire neighbours (for wire power in)
  const dustInfo = new Map();
  for (const [k, c] of cells) {
    if (c.t !== 'dust') continue;
    const p = parse(k);
    if (!sturdy(at(add(p, 'd')))) problems.push(`dust ${k} has no support`);
    const sides = [], wires = [];
    const aboveCond = cond(at(add(p, 'u')));
    for (const h of H) {
      const n = add(p, h), cn = at(n);
      if (cn.t === 'dust') { sides.push(h); wires.push(key(n)); continue; }
      if (connectsTo(cn, h)) { sides.push(h); continue; }
      const up = add(n, 'u');
      if (!aboveCond && sturdy(cn) && at(up).t === 'dust') { sides.push(h); }
      if (!cond(cn) && at(add(n, 'd')).t === 'dust') { sides.push(h); }
      // wire reads (power flow into this dust)
      if (cond(cn) && !aboveCond && at(up).t === 'dust') wires.push(key(up));
      if (!cond(cn) && at(add(n, 'd')).t === 'dust') wires.push(key(add(n, 'd')));
    }
    let point = sides.length === 0 ? [...H] : sides.length === 1 ? [sides[0], OPP[sides[0]]] : sides;
    dustInfo.set(k, { point: [...new Set(point)], wires });
  }
  // the influence graph: edges src -> dst carrying "signal" (taint)
  const edges = new Map();
  const edge = (a, b, why) => { if (!edges.has(a)) edges.set(a, []); edges.get(a).push([b, why]); };
  const strongInto = new Map(); // block key -> sources that power it strongly
  const powerBlock = (bk, src, strong) => { edge(src, bk, strong ? 'strong' : 'weak'); if (strong) strongInto.set(bk, true); };
  for (const [k, c] of cells) {
    const p = parse(k);
    if (c.t === 'dust') {
      const di = dustInfo.get(k);
      powerBlock(key(add(p, 'd')), k, false);
      for (const h of di.point) { const n = add(p, h); const cn = at(n); if (cond(cn)) powerBlock(key(n), k, false); else if (cn.t !== 'air') edge(k, key(n), 'dust->comp'); }
      for (const w of di.wires) edge(w, k, 'wire');
    } else if (c.t === 'rep' || c.t === 'cmp') {
      const front = add(p, OPP[c.f]); // f = toward the input
      if (cond(at(front))) powerBlock(key(front), k, true); else edge(k, key(front), 'diode');
    } else if (c.t === 'obs') {
      const back = add(p, OPP[c.f]);
      if (cond(at(back))) powerBlock(key(back), k, true); else edge(k, key(back), 'observer');
    } else if (c.t === 'torch') {
      const above = add(p, 'u');
      if (cond(at(above))) powerBlock(key(above), k, true);
      for (const d of Object.keys(DIRS)) { const n = add(p, d); if (key(n) === key(c.mount ?? [NaN])) continue; const cn = at(n); if (d === 'u' && cond(cn)) continue; if (!cond(cn) && cn.t !== 'air') edge(k, key(n), 'torch'); }
      if (c.mount) edge(key(c.mount), k, 'mount');
    } else if (c.t === 'lever' || c.t === 'sensor') {
      if (c.mount && cond(at(c.mount))) powerBlock(key(c.mount), k, true);
      for (const d of Object.keys(DIRS)) { const n = add(p, d); const cn = at(n); if (!cond(cn) && cn.t !== 'air') edge(k, key(n), c.t); }
    }
  }
  // a powered block passes power to its neighbours: components (all), and dust only when strongly powered
  for (const [k, c] of cells) {
    if (!cond(c)) continue;
    const p = parse(k);
    for (const d of Object.keys(DIRS)) {
      const n = add(p, d), cn = at(n);
      if (cn.t === 'dust') { if (strongInto.get(k)) edge(k, key(n), 'strong-block->dust'); continue; }
      if (cn.t === 'torch') { if (key(cn.mount ?? [NaN]) === k) edge(k, key(n), 'mount'); continue; }
      if (['rep', 'cmp'].includes(cn.t)) { if (key(add(n, cn.f)) === k) edge(k, key(n), 'block->diode back'); continue; }
      if (['piston', 'trap', 'door'].includes(cn.t)) edge(k, key(n), 'block->actuator');
    }
  }
  // a lock or a comparator side: diodes and dust beside them (approximate: any diode pointing in, any dust beside a comparator)
  // taint propagation from labelled sources
  const nets = new Map();
  for (const [k, c] of cells) if (c.label) {
    const seen = new Set([k]);
    const q = [k];
    while (q.length) {
      const cur = q.shift();
      if (!nets.has(cur)) nets.set(cur, new Set());
      nets.get(cur).add(c.label);
      const cc = cells.get(cur);
      if (cur !== k && cc?.stop) continue; // an inverter or a memory: its output is its own label
      for (const [nx] of edges.get(cur) ?? []) if (!seen.has(nx)) { seen.add(nx); q.push(nx); }
    }
  }
  for (const [k, c] of cells) if (c.expect) {
    const got = [...(nets.get(k) ?? [])].sort();
    const want = [...c.expect].sort();
    if (got.join() !== want.join()) problems.push(`${k} (${c.t}${c.name ? ' ' + c.name : ''}) carries [${got}] expected [${want}]`);
  }
  return { nets, problems, dustInfo, edges };
}
