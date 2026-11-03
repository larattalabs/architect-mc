// (7a GM) The §2a day-cycle logic as a free bench (gm-probe, before it is fitted into an envelope): two levers read by trapdoors and
// observers (P, a pulse per flip), an inverted daylight sensor cleaned by a repeater and read by an observer (Q, a pulse per transition),
// and a repeater-lock D latch holding G (power = closed): clock C = P' or Q' (lengthened pulses), data = Q' ? S : not G.
//   P'  = P lengthened to 6 ticks (RP, delay 3);  Q' = Q lengthened to 8 ticks (RQ, delay 4)
//   BC  = P' or Q'; T5 = not BC; RL (T5) locks R_G whenever no pulse is on
//   D   = T1 or CMP;  T1 = not (G or Q') (torch on B1);  CMP = S - T2 (subtract), T2 = not Q' (torch on B2)
// Local frame: x east, z south, y 0 the component row on a floor at y -1. Each cell: {x, y, z, state, lint} (lint: gmLint's form).
const W = 'minecraft:';
export function benchCells() {
  const out = [];
  const put = (x, y, z, state, lint) => out.push({ x, y, z, state, lint });
  const w = (x, z, lint = {}) => put(x, 0, z, `${W}redstone_wire`, { t: 'dust', ...lint });
  const B = (x, z, lint = {}) => put(x, 0, z, `${W}stone`, { t: 'block', ...lint });
  const rep = (x, z, f, delay, lint = {}) => put(x, 0, z, `${W}repeater[facing=${{ n: 'north', s: 'south', e: 'east', w: 'west' }[f]},delay=${delay}]`, { t: 'rep', f, ...lint });
  const torch = (x, z, facing, mount, lint = {}) => put(x, 0, z, `${W}redstone_wall_torch[facing=${facing}]`, { t: 'torch', mount, ...lint });
  // the detectors (east end): a lever on block M, a trapdoor beside M, an observer watching the trapdoor, its output west
  B(46, -1); put(46, 0, -2, `${W}lever[face=wall,facing=north,powered=false]`, { t: 'lever', mount: [46, 0, -1] });
  put(45, 0, -1, `${W}iron_trapdoor[facing=north,half=bottom]`, { t: 'trap' }); put(44, 0, -1, `${W}observer[facing=east]`, { t: 'obs', f: 'e', label: 'P', stop: true });
  B(46, 2); put(46, 0, 3, `${W}lever[face=wall,facing=south,powered=false]`, { t: 'lever', mount: [46, 0, 2] });
  put(45, 0, 2, `${W}iron_trapdoor[facing=north,half=bottom]`, { t: 'trap' }); put(44, 0, 2, `${W}observer[facing=east]`, { t: 'obs', f: 'e', label: 'P', stop: true });
  for (let z = -1; z <= 2; z++) w(43, z, { expect: ['P'] });
  rep(42, 0, 'e', 3);
  for (let x = 35; x <= 41; x++) w(x, 0, { expect: ['P'] });
  rep(34, 0, 'e', 1);
  // the core
  B(33, 0, { name: 'BC', expect: ['P', 'Q'] });
  torch(32, 0, 'west', [33, 0, 0], { label: 'nC', stop: true });
  rep(31, 0, 'e', 1, { expect: ['nC'] });
  rep(30, 0, 'n', 1, { name: 'RG', label: 'G', stop: true });
  w(30, -1, { name: 'D', expect: ['S', 'nG', 'nQ'] });
  put(30, 0, -2, `${W}comparator[facing=north,mode=subtract]`, { t: 'cmp', f: 'n' });
  w(31, -2, { name: 'notQ to the CMP side', expect: ['nQ'] });
  torch(32, -2, 'west', [33, 0, -2], { label: 'nQ', stop: true });
  B(33, -2, { name: 'B2', expect: ['Q'] });
  rep(34, -2, 'e', 1); rep(33, -1, 'n', 1); // Q' into B2, and B2 into BC
  torch(29, -1, 'east', [28, 0, -1], { label: 'nG', stop: true });
  B(28, -1, { name: 'B1', expect: ['G', 'Q'] });
  rep(27, -1, 'w', 1); // Q' into B1
  w(30, 1, { expect: ['G'] }); w(29, 1, { expect: ['G'] }); w(28, 1, { expect: ['G'] }); rep(28, 0, 's', 1); // G into B1
  // S and Q: the inverted sensor, RS, the S column into CMP's back; OS watches it
  put(30, 0, -10, `${W}daylight_detector[inverted=true]`, { t: 'sensor', label: 'S' });
  rep(30, -9, 'n', 1);
  for (let z = -8; z <= -3; z++) w(30, z, { expect: ['S'] });
  put(31, 0, -6, `${W}observer[facing=west]`, { t: 'obs', f: 'w', label: 'Q', stop: true });
  w(32, -6, { expect: ['Q'] }); rep(33, -6, 'w', 4);
  w(34, -6, { expect: ['Q'] });
  for (let z = -12; z <= -2; z++) w(35, z, { expect: ['Q'] });
  for (let x = 25; x <= 34; x++) { if (x === 30) rep(x, -12, 'e', 1); else w(x, -12, { expect: ['Q'] }); } // (repeaters: the loop is ~30 cells)
  for (let z = -11; z <= -1; z++) { if (z === -6) rep(25, z, 'n', 1); else w(25, z, { expect: ['Q'] }); }
  w(26, -1, { expect: ['Q'] });
  // G out: south from (30,1) to z 6, then west to x -3 (repeaters every 8)
  for (let z = 2; z <= 6; z++) w(30, z, { expect: ['G'] });
  for (let x = -3; x <= 29; x++) { if ([27, 19, 11, 3].includes(x)) rep(x, 6, 'e', 1); else w(x, 6, { expect: ['G'] }); }
  return out;
}
/** The bench's levers (local) and R_G's cell. */
export const BENCH = Object.freeze({ leverA: [46, 0, -2], leverB: [46, 0, 3], rg: [30, 0, 0], sensor: [30, 0, -10] });
