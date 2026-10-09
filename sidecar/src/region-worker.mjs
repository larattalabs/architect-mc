// (6a) A tile evaluation worker (worker_threads), started by src/regionpool.ts. Plain ESM with no
// imports from src/: the build copies it next to dist/main.mjs, and both src/ and dist/ resolve it as
// `new URL('./region-worker.mjs', import.meta.url)`.
//
// It runs only Architect's kit code: `<kit>/lib/realise.mjs` (evalTile) and, when the kit has it,
// `<kit>/lib/region/pack.mjs` (gzipPinned). The payload bytes are the kit's; this worker hashes them
// (SHA-256, checked against the kit's own sha) and compresses them, and never re-encodes them.
//
// Messages from the pool:
//   {type: 'ir', irSha, irJson, blobs?}    cache a parsed IR (sent once per worker and IR); (6b) blobs: {sha: Uint8Array}
//                                          the IR's side blobs (shared memory), handed to evalTile as {blobs: sha -> bytes}
//   {type: 'drop', irSha}                  forget it
//   {type: 'survey', id, bytes}            (6b) cache a plan survey (ghost tiles; the last 4)
//   {type: 'tile', id, irSha, key, stage, set, heights: Uint8Array}
//   {type: 'tile', id, irSha, key, stage?, set?, preview: true, surveyId}
//                                          (6b) a ghost tile: the window is the kit's windowFromSurvey(survey, key); every
//                                          stage up to `stage` (a copy of the IR with the later stages' parts left out,
//                                          cached), both sets unless `set`
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
/** (6b) irSha -> (sha -> Uint8Array) */
const blobMaps = new Map();
/** (6b) `${irSha}|${stage}` -> the IR cut after that stage (one object, so the kit compiles it once) */
const upTo = new Map();
/** (6b) survey id -> bytes (the last WORKER_SURVEYS = 4) */
const surveys = new Map();
let surveyLib;

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
    if (m.blobs) blobMaps.set(m.irSha, new Map(Object.entries(m.blobs)));
    return;
  }
  if (m.type === 'drop') {
    irs.delete(m.irSha);
    blobMaps.delete(m.irSha);
    for (const k of upTo.keys()) if (k.startsWith(`${m.irSha}|`)) upTo.delete(k);
    return;
  }
  if (m.type === 'survey') {
    surveys.set(m.id, m.bytes);
    while (surveys.size > 4) surveys.delete(surveys.keys().next().value);
    return;
  }
  if (m.type !== 'tile') return;
  const t0 = performance.now();
  try {
    await ready;
    let ir = irs.get(m.irSha);
    if (!ir) throw new Error(`the worker has no IR ${m.irSha.slice(0, 12)}`);
    const bm = blobMaps.get(m.irSha);
    const blobOpt = bm ? { blobs: (sha) => bm.get(sha) } : {};
    let r;
    if (m.preview) {
      const survey = surveys.get(m.surveyId);
      if (!survey) throw new Error(`the worker has no survey ${m.surveyId}`);
      surveyLib ??= await import(pathToFileURL(path.join(kitDir, 'lib', 'region', 'survey.mjs')).href);
      if (typeof surveyLib.windowFromSurvey !== 'function') throw new Error("the kit's lib/region/survey.mjs has no windowFromSurvey");
      const window = surveyLib.windowFromSurvey(Buffer.from(survey.buffer, survey.byteOffset, survey.byteLength), m.key);
      if (m.stage !== undefined) {
        const k = `${m.irSha}|${m.stage}`;
        let cut = upTo.get(k);
        if (!cut) {
          const stages = Array.isArray(ir.stages) ? ir.stages : [];
          const at = stages.indexOf(m.stage);
          if (at < 0) throw new Error(`the IR has no stage '${m.stage}'`);
          const keep = new Set(stages.slice(0, at + 1));
          cut = { ...ir, parts: (ir.parts ?? []).filter((p) => keep.has(p.stage)) };
          upTo.set(k, cut);
        }
        ir = cut;
      }
      r = await realise.evalTile(ir, m.key, window, { ...(m.set !== undefined ? { set: m.set } : {}), ...blobOpt });
    } else {
      const heights = Buffer.from(m.heights.buffer, m.heights.byteOffset, m.heights.byteLength);
      r = await realise.evalTile(ir, m.key, heights, { stage: m.stage, set: m.set, ...blobOpt });
    }
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
