// (7c CO) The rounds harness: a design that runs one model job per round, each round's answer checked outside the job (the mod's
// Regions.checkPlan for the composer; AU's checker for program authoring), the next round's prompt built from that check. CO's composer
// (compose.ts) is its first user: one structured job per round, rounds = 1 + REPAIR_ROUNDS; AU (program authoring) builds on it with an
// agent job per round and its own round count. Frozen by CO's as-built (docs/CONTRACT.md "Slice CO as built", "The harness").
//
//   RoundJob     what every round's job is: kind, system (and systemRefs, expanded first), schema, model, maxTurns, owner
//   RoundRecord  what a design keeps per round, in its record: n (1-based), jobId, answer, cost, error, then the outside check
//                (`check`, or `refused` when it could not run)
//   startRound   starts round n's job (`sc.jobs.runInternal`, tag "design <id> <what> round <n>"), within what the budget has left
//   finishRound  waits for the round's job and records its answer (or error) and cost; a design ended meanwhile answers 'gone'
//   roundsCost   the rounds' summed cost
//
// The record is the state: a restart re-enters at the first round without an answer (its job is waited for again) or without a check
// (the checker is asked again). The harness never reads the answer: the caller validates it and decides what the check is.
import { addCost, zeroCost } from './cost.js';
import type { Cost, Job, JobSpec } from '../protocol.js';
import type { Sidecar } from '../sidecar.js';
import { isFinalDesign } from '../designs.js';

/** Every round's job. */
export interface RoundJob {
  kind: JobSpec['kind'];
  /** the caller's system prompt (after the refs' blocks); a structured job's whole system is at most JOB_SYSTEM_MAX */
  system: string;
  systemRefs?: string[];
  schema: Record<string, unknown>;
  model: string;
  maxTurns: number;
  /** the jobs' owner (job records, logs) */
  owner: string;
  /** what the rounds are, for the job tag ("compose", "author") */
  what: string;
}

/** One round, as the design's record keeps it. */
export interface RoundRecord {
  n: number;
  jobId: string;
  answer?: unknown;
  cost?: Cost;
  error?: string;
  /** the outside check of this round's answer */
  check?: Record<string, unknown>;
  /** the check could not run: why */
  refused?: string;
}

/** Starts round `n`'s job for design `designId`. `budgetUsd`: what is left for it (undefined: no cap). Throws when the job can't start. */
export function startRound(
  sc: Sidecar,
  job: RoundJob,
  r: { designId: string; n: number; prompt: string; budgetUsd?: number | undefined; images?: Array<{ file: string; label: string }>; simAnswer?: unknown },
): RoundRecord {
  const spec = {
    kind: job.kind,
    prompt: r.prompt,
    system: job.system,
    ...(job.systemRefs?.length ? { systemRefs: job.systemRefs } : {}),
    model: job.model,
    schema: job.schema,
    maxTurns: job.maxTurns,
    owner: job.owner,
    tag: `design ${r.designId} ${job.what} round ${r.n}`,
    ...(r.budgetUsd !== undefined ? { budgetUsd: r.budgetUsd } : {}),
  } as JobSpec;
  const j: Job = sc.jobs.runInternal(spec, { ...(r.images?.length ? { images: r.images } : {}), ...(r.simAnswer !== undefined ? { simAnswer: r.simAnswer } : {}) });
  return { n: r.n, jobId: j.id };
}

/** Waits for the round's job; fills `answer` (done) or `error` (the job's error or status, "budget" for its budget) and `cost`. */
export async function finishRound(sc: Sidecar, designId: string, rec: RoundRecord): Promise<'done' | 'error' | 'gone'> {
  const job = await sc.jobs.waitFinal(rec.jobId);
  const d = sc.designs.get(designId);
  if (!d || isFinalDesign(d)) return 'gone';
  rec.cost = job.cost ?? zeroCost();
  if (job.status !== 'done') {
    rec.error = job.error ?? job.status;
    return 'error';
  }
  rec.answer = job.result ?? null;
  return 'done';
}

/** The rounds' summed cost. */
export function roundsCost(rounds: readonly RoundRecord[]): Cost {
  return rounds.reduce((c, r) => addCost(c, r.cost ?? zeroCost()), zeroCost());
}
