// (6a) A tile evaluation worker (worker_threads), started by src/regionpool.ts. Plain ESM with no
// imports from src/: the build copies it next to dist/main.mjs, and both src/ and dist/ resolve it as
// `new URL('./region-worker.mjs', import.meta.url)`.
//
// It runs only Architect's kit code: `<kit>/lib/realise.mjs` (evalTile) and, when the kit has it,
// `<kit>/lib/region/pack.mjs` (gzipPinned). The payload bytes are the kit's; this worker hashes them
// (SHA-256, checked against the kit's own sha) and compresses them, and never re-encodes them.
//
// Messages from the pool:
//   {type: 'ir', irSha, irJson}            cache a parsed IR (sent once per worker and IR)
//   {type: 'drop', irSha}                  forget it
//   {type: 'tile', id, irSha, key, stage, set, heights: Uint8Array}
// To the pool:
//   {type: 'ready'} | {type: 'fatal', message}
//   {type: 'done', id, gz: Uint8Array (transferred), count, sha, ms} | {type: 'fail', id, message}
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';

const kitDir = workerData.kitDir;
/** irSha -> parsed IR */
const irs = new Map();

/** gzip level 6, mtime 0, OS byte 255: the kit's gzipPinned when it has none of its own (REGIONS.md). */
function gzipFallback(buf) {
  const gz = zlib.gzipSync(buf, { level: 6 });
  gz.writeUInt32LE(0, 4);
  gz[9] = 255;
  return gz;
}

let realise;
let gzipPinned = gzipFallback;
const ready = (async () => {
  realise = await import(pathToFileURL(path.join(kitDir, 'lib', 'realise.mjs')).href);
  if (typeof realise.evalTile !== 'function') throw new Error('the kit\'s lib/realise.mjs has no evalTile');
  try {
    const pack = await import(pathToFileURL(path.join(kitDir, 'lib', 'region', 'pack.mjs')).href);
    if (typeof pack.gzipPinned === 'function') gzipPinned = pack.gzipPinned;
  } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  }
})();

ready.then(
  () => parentPort.postMessage({ type: 'ready' }),
  (e) => parentPort.postMessage({ type: 'fatal', message: `the kit's evaluator could not be loaded: ${e?.message ?? e}` }),
);

function message(e) {
  return e instanceof Error ? e.message : String(e);
}

parentPort.on('message', async (m) => {
  if (m.type === 'ir') {
    if (!irs.has(m.irSha)) irs.set(m.irSha, JSON.parse(m.irJson));
    return;
  }
  if (m.type === 'drop') {
    irs.delete(m.irSha);
    return;
  }
  if (m.type !== 'tile') return;
  const t0 = performance.now();
  try {
    await ready;
    const ir = irs.get(m.irSha);
    if (!ir) throw new Error(`the worker has no IR ${m.irSha.slice(0, 12)}`);
    const heights = Buffer.from(m.heights.buffer, m.heights.byteOffset, m.heights.byteLength);
    const r = await realise.evalTile(ir, m.key, heights, { stage: m.stage, set: m.set });
    if (!r || !(r.payload instanceof Uint8Array)) throw new Error('evalTile returned no payload');
    const sha = crypto.createHash('sha256').update(r.payload).digest('hex');
    if (typeof r.sha === 'string' && r.sha !== sha) throw new Error(`evalTile's sha ${r.sha} is not the payload's ${sha}`);
    const gzBuf = gzipPinned(r.payload);
    // an exact-size copy: a pooled Buffer would transfer (and detach) its whole pool
    const gz = new Uint8Array(gzBuf.byteLength);
    gz.set(gzBuf);
    parentPort.postMessage({ type: 'done', id: m.id, gz, count: Number(r.count) || 0, sha, ms: Math.round(performance.now() - t0) }, [gz.buffer]);
  } catch (e) {
    parentPort.postMessage({ type: 'fail', id: m.id, message: message(e) });
  }
});
