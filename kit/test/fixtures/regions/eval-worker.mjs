// A worker_threads tile evaluator for the golden test: {irJson, seed, jobs: [{key, stage, set}]} -> [{key, stage, set, sha, count}].
import { parentPort, workerData } from 'node:worker_threads';
import { evalTile } from '../../../lib/realise.mjs';
import { synthTileWindow } from '../../../lib/region/synth.mjs';

const ir = JSON.parse(workerData.irJson);
// (6b) side blobs by sha, for format-2 IRs
const blobs = workerData.blobs ? (sha) => workerData.blobs[sha] : undefined;
const out = workerData.jobs.map(({ key, stage, set }) => {
  const r = evalTile(ir, key, synthTileWindow(key, workerData.seed), { stage, set, blobs });
  return { key, stage, set, sha: r.sha, count: r.count, bytes: r.payload.length };
});
parentPort.postMessage(out);
