// (8c WM) A worker_threads simulator for wm.test.mjs's 1-vs-4-workers test: {seeds} -> [{seed, sha}] (the sha of the predicted, converted
// and foreign cells of a wm body over the test's random scene of that seed).
import { parentPort, workerData } from 'node:worker_threads';
import crypto from 'node:crypto';
import { simulate, WM_MODEL, FACE } from '../../../lib/fluids/sim.mjs';

const k3 = (x, y, z) => `${x},${y},${z}`;
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function world(seed) {
  const rnd = lcg(seed);
  const floor = new Map();
  for (let x = -10; x <= 10; x++) for (let z = -10; z <= 10; z++) floor.set(`${x},${z}`, 60 + Math.floor(rnd() * 3));
  const wls = new Map();
  for (let i = 0; i < 3; i++) { const x = Math.floor(rnd() * 21) - 10, z = Math.floor(rnd() * 21) - 10; wls.set(k3(x, floor.get(`${x},${z}`) + 1, z), rnd() < 0.5 ? 0 : FACE.down); }
  const at = (x, y, z) => (wls.has(k3(x, y, z)) || Math.abs(x) > 10 || Math.abs(z) > 10 || y <= floor.get(`${x},${z}`) ? 'stop' : 'open');
  const cells = [];
  for (let i = 0; i < 3; i++) { const x = Math.floor(rnd() * 9) - 4, z = Math.floor(rnd() * 9) - 4; const c = [x, floor.get(`${x},${z}`) + 1, z]; if (!wls.has(k3(...c)) && !cells.some((q) => k3(...q) === k3(...c))) cells.push(c); }
  return { w: { at, wl: (x, y, z) => wls.get(k3(x, y, z)) ?? null }, cells };
}
const out = workerData.seeds.map((seed) => {
  const { w, cells } = world(seed);
  const b = simulate(w, [{ id: 'b', fluid: 'water', level: 64, cells, model: WM_MODEL }]).bodies[0];
  return { seed, sha: crypto.createHash('sha256').update(JSON.stringify([b.predicted, b.converted, b.foreign])).digest('hex') };
});
parentPort.postMessage(out);
