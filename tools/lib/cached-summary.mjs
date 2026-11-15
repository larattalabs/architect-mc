// (GI2, a GX leftover) A run whose every selected step is CACHED ran nothing and used to exit before its run dir existed: no
// summary.json (an agent waiting on it never woke) and no SUMMARY.md. gate-run now writes both, through these two functions.
import fs from 'node:fs';
import path from 'node:path';

/** The CACHED table's lines, as SUMMARY.md prints it (shared with gate-run's summaryMd). */
export function cachedTableLines(cached, { explicit = false } = {}) {
  if (!cached?.length) return [];
  const lines = ['', `### CACHED (${cached.length}): skipped, a PASS is recorded for the same key${explicit ? ' (an explicit list: own steps always ran, strict-tier steps took exact keys only)' : ''}`, '', '| step | key | PASS at | head | source run | evidence |', '|---|---|---|---|---|---|'];
  for (const h of cached) lines.push(`| ${h.id} | ${String(h.key).slice(0, 12)} | ${h.at} | ${String(h.head).slice(0, 9)} | \`${path.basename(String(h.run ?? '?'))}\` | \`${h.log ?? h.run}\` |`);
  return lines;
}

/**
 * Writes <out>/summary.json (state done, verdict PASS, no steps) and <out>/SUMMARY.md for an all-CACHED run. -> { json, md }.
 * run: { chain, head, range, startedAt, cached: [hit], explicit, worktree }.
 */
export function writeAllCachedSummary(out, run) {
  fs.mkdirSync(out, { recursive: true });
  const now = new Date().toISOString();
  const summary = {
    chain: run.chain, state: 'done', verdict: 'PASS', allCached: true, head: run.head ?? null, range: run.range ?? null, worktree: run.worktree ?? null,
    startedAt: run.startedAt ?? now, endedAt: now, durationSeconds: 0, steps: [], counts: {}, cached: run.cached ?? [],
  };
  const md = [
    `# gate-run ${run.chain}: PASS (every selected step CACHED, nothing ran)`, '',
    `Head ${String(run.head ?? '?').slice(0, 9)}${run.range ? `, range ${run.range}` : ''}; ${now}.`,
    ...cachedTableLines(run.cached, { explicit: run.explicit }), '',
  ].join('\n');
  const json = path.join(out, 'summary.json');
  fs.writeFileSync(json, `${JSON.stringify(summary, null, 1)}\n`);
  fs.writeFileSync(path.join(out, 'SUMMARY.md'), md);
  return { json, md: path.join(out, 'SUMMARY.md') };
}
