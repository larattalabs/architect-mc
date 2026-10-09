// FAKE kit/lib/realise.mjs (sidecar tests): a deterministic "ARTL" payload from (ir.seed, key, stage, set, heights).
// Special keys: 99,99 throws; 98,98 exits the thread (a crash); 97,97 spins (a timeout); 96,96 allocates until it
// runs out of memory; 95,95 gives an incompressible ~2.5 MB payload (3 frames); 94,94 is slow (300 ms);
// an IR with slowMs makes every tile take that long.
import crypto from 'node:crypto';

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s & 0xff;
  };
}

export function evalTile(ir, key, heights, opts = {}) {
  const stage = opts.stage ?? '*';
  const set = opts.set ?? '*';
  if (key === '99,99') throw new Error('fake evaluator refused tile 99,99');
  if (key === '98,98') process.exit(3);
  if (key === '97,97') for (;;);
  if (key === '96,96') { const hog = []; for (;;) hog.push(new Array(1e6).fill(Math.random())); }
  if (key === '94,94') { const end = Date.now() + 300; while (Date.now() < end); }
  if (ir.slowMs) { const end = Date.now() + ir.slowMs; while (Date.now() < end); }
  const h = crypto.createHash('sha256').update(`${ir.seed}|${key}|${stage}|${set}|`).update(heights).digest();
  let body;
  if (key === '95,95') {
    const next = prng(h.readUInt32LE(0));
    body = new Uint8Array(2_500_000);
    for (let i = 0; i < body.length; i++) body[i] = next();
  } else {
    const reps = 64 + (h[0] % 64);
    body = new Uint8Array(32 * reps);
    for (let i = 0; i < reps; i++) body.set(h, i * 32);
  }
  const payload = new Uint8Array(8 + body.length);
  payload.set([0x41, 0x52, 0x54, 0x4c, 1, 0, 0, 0]);
  payload.set(body, 8);
  const sha = crypto.createHash('sha256').update(payload).digest('hex');
  return { payload, count: body.length / 2, sha, notes: [] };
}
