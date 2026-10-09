// A worker_threads tile evaluator over a plan's own inputs (tools/scenarios.mjs determinism, kit/test/scenario-goldens):
// {irJson, survey (ARSV bytes), blobDir, jobs: [{key, stage, set}]} -> [{key, stage, set, sha, count}].
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { evalTile } from '../../kit/lib/realise.mjs';
import { windowFromSurvey } from '../../kit/lib/region/survey.mjs';

export function evalJobs({ irJson, survey, blobDir, jobs }) {
  const ir = JSON.parse(irJson);
  const blobs = (sha) => { const f = path.join(blobDir, `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const bytes = Buffer.from(survey);
  return jobs.map(({ key, stage, set }) => {
    const r = evalTile(ir, key, windowFromSurvey(bytes, key), { stage, set, blobs });
    return { key, stage, set, sha: r.sha, count: r.count };
  });
}

if (parentPort && workerData?.jobs) parentPort.postMessage(evalJobs(workerData));
