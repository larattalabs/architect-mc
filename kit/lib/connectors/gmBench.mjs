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
  // the detectors: lever on block M, trapdoor beside M, observer watching the trapdoor, out east
  B(-2, -1); put(-2, 0, -2, `${W}lever[face=wall,facing=north,powered=false]`, { t: 'lever', mount: [-2, 0, -1] });
  put(-1, 0, -1, `${W}iron_trapdoor[facing=north,half=bottom]`, { t: 'trap' }); put(0, 0, -1, `${W}observer[facing=west]`, { t: 'obs', f: 'w', label: 'P', stop: true });
  B(-2, 2); put(-2, 0, 3, `${W}lever[face=wall,facing=south,powered=false]`, { t: 'lever', mount: [-2, 0, 2] });
  put(-1, 0, 2, `${W}iron_trapdoor[facing=north,half=bottom]`, { t: 'trap' }); put(0, 0, 2, `${W}observer[facing=west]`, { t: 'obs', f: 'w', label: 'P', stop: true });
  w(1, -1); w(1, 0); w(1, 1); w(1, 2);
  rep(2, 0, 'w', 3);
  for (let x = 3; x <= 28; x++) { if (x === 15) rep(x, 0, 'w', 1); else w(x, 0, { expect: ['P'] }); }
  rep(29, 0, 'w', 1);
  B(30, 0, { name: 'BC', expect: ['P', 'Q'] });
  torch(31, 0, 'east', [30, 0, 0], { label: 'nC', stop: true });
  rep(32, 0, 'w', 1, { expect: ['nC'] });
  rep(33, 0, 'n', 1, { name: 'RG', label: 'G', stop: true });
  w(33, -1, { name: 'D', expect: ['S', 'nG', 'nQ'] });
  put(33, 0, -2, `${W}comparator[facing=north,mode=subtract]`, { t: 'cmp', f: 'n' });
  for (let z = -8; z <= -3; z++) w(33, z, { expect: ['S'] });
  rep(33, -9, 'n', 1, {}); put(33, 0, -10, `${W}daylight_detector[inverted=true]`, { t: 'sensor', label: 'S' });
  put(34, 0, -8, `${W}observer[facing=west]`, { t: 'obs', f: 'w', label: 'Q', stop: true });
  w(35, -8, { expect: ['Q'] }); rep(36, -8, 'w', 4);
  for (let z = -12; z <= -1; z++) w(37, z, { expect: ['Q'] });
  for (let x = 30; x <= 36; x++) w(x, -12, { expect: ['Q'] });
  for (let z = -11; z <= -2; z++) w(30, z, { expect: ['Q'] });
  rep(30, -1, 'n', 1);
  torch(34, -1, 'west', [35, 0, -1], { label: 'nG', stop: true });
  torch(34, -2, 'west', [35, 0, -2], { label: 'nQ', stop: true });
  B(35, -1, { name: 'B1', expect: ['G', 'Q'] }); B(35, -2, { name: 'B2', expect: ['Q'] });
  rep(36, -1, 'e', 1); rep(36, -2, 'e', 1);
  // G: out of R_G south, to B1, and the bench's output lane (z 6, west)
  w(33, 1, { expect: ['G'] }); w(34, 1, { expect: ['G'] }); w(35, 1, { expect: ['G'] }); rep(35, 0, 's', 1); // (a repeater: B1 is strongly powered by Q', and a dust beside it would read that)
  for (let z = 2; z <= 6; z++) w(33, z, { expect: ['G'] });
  for (let x = -3; x <= 32; x++) { if (x === 19 || x === 5) rep(x, 6, 'e', 1); else w(x, 6, { expect: ['G'] }); }
  return out;
}
