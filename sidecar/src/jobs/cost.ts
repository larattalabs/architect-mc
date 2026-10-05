// Cost accounting for jobs and designs (docs/CONTRACT.md "Jobs (R2)": cost with cache tokens, the
// budget across resumes).
//
// The SDK's result message carries `total_cost_usd`, `num_turns` and `modelUsage` (per model:
// inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD; see
// sdk.d.ts ModelUsage). All of them are cumulative for ONE query() call, and "a resumed or forked
// session continues from the total its transcript saved, when it has one (so the first result
// already carries the earlier turns; maxBudgetUsd counts only the spend since this query() call
// started)". So a CostMeter keeps what earlier query() calls of the same job committed, and for a
// resumed query decides from its first result whether the SDK's totals already include them.
import type { Cost } from '../protocol.js';

export const zeroCost = (): Cost => ({ usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 });

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function addCost(a: Cost, b: Cost): Cost {
  return {
    usd: round6(a.usd + b.usd),
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    turns: a.turns + b.turns,
  };
}

function maxCost(a: Cost, b: Cost): Cost {
  return {
    usd: round6(Math.max(a.usd, b.usd)),
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: Math.max(a.cacheWriteTokens, b.cacheWriteTokens),
    turns: Math.max(a.turns, b.turns),
  };
}

const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * The cost a result message reports (this query() call so far): `total_cost_usd`, `num_turns`, and
 * the token totals summed over `modelUsage` (falling back to the main loop's `usage` when
 * modelUsage is empty).
 */
export function costFromResult(msg: { total_cost_usd?: unknown; num_turns?: unknown; modelUsage?: unknown; usage?: unknown }): Cost {
  const c = zeroCost();
  c.usd = round6(num(msg.total_cost_usd));
  c.turns = int(msg.num_turns);
  const mu = msg.modelUsage && typeof msg.modelUsage === 'object' ? Object.values(msg.modelUsage as Record<string, Record<string, unknown>>) : [];
  if (mu.length) {
    for (const m of mu) {
      if (!m || typeof m !== 'object') continue;
      c.inputTokens += int(m.inputTokens);
      c.outputTokens += int(m.outputTokens);
      c.cacheReadTokens += int(m.cacheReadInputTokens);
      c.cacheWriteTokens += int(m.cacheCreationInputTokens);
    }
  } else if (msg.usage && typeof msg.usage === 'object') {
    const u = msg.usage as Record<string, unknown>;
    c.inputTokens = int(u.input_tokens);
    c.outputTokens = int(u.output_tokens);
    c.cacheReadTokens = int(u.cache_read_input_tokens);
    c.cacheWriteTokens = int(u.cache_creation_input_tokens);
  }
  return c;
}

/**
 * The cost of a job (or design) across its query() calls. `committed` is what earlier calls
 * counted; `begin(resumed)` starts a call; `observe(result)` gives the job's total so far;
 * `commit()` ends the call.
 *
 * A resumed call whose first result reports at least the committed spend is taken to include it
 * (the SDK continued from the transcript's saved total); otherwise its totals are added on top.
 */
export class CostMeter {
  private current: Cost | undefined;
  private includesPrior: boolean | undefined;
  private resumed = false;

  constructor(public committed: Cost = zeroCost()) {}

  begin(resumed: boolean): void {
    this.current = undefined;
    this.includesPrior = undefined;
    this.resumed = resumed;
  }

  /** this query's cumulative cost (a result message) -> the job's total */
  observe(queryCost: Cost): Cost {
    if (this.includesPrior === undefined) this.includesPrior = this.resumed && this.committed.usd > 0 && queryCost.usd + 1e-9 >= this.committed.usd;
    this.current = queryCost;
    return this.total();
  }

  total(): Cost {
    if (!this.current) return { ...this.committed };
    return this.includesPrior ? maxCost(this.committed, this.current) : addCost(this.committed, this.current);
  }

  /** the query ended: what it reported becomes committed */
  commit(): Cost {
    this.committed = this.total();
    this.current = undefined;
    this.includesPrior = undefined;
    return this.committed;
  }

  /** what is left of `budgetUsd` (<= 0: spent) */
  remaining(budgetUsd: number): number {
    return round6(budgetUsd - this.total().usd);
  }
}
