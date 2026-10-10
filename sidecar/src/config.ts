// Launch flags (docs/CONTRACT.md "Sidecar process") and the optional <data>/config.json.
//
//   node dist/main.mjs --port 7890 --data <dir> --library <dir> --kit <dir>
//                      [--use-claude-login] [--parent-pid <pid>] [--backend claude|sim] [--debug] [--bibles <dir>] [--massings <dir>]
//
// <data>/config.json (optional, hand-edited): { "designModel", "effort", "maxTurns", "maxBudgetUsd",
// "simStepMs", "jobModel", "jobConcurrency", "simJobStepUsd", (6a) "regionWorkers", "regionWindow", ... }.
// ARCHITECT_DESIGN_MODEL overrides designModel, ARCHITECT_JOB_MODEL jobModel, (6c 0a) ARCHITECT_SIM_COSTS simCosts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function readVersion(): string {
  try {
    // src/config.ts and dist/main.mjs both sit one level below sidecar/package.json
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();
export const DEFAULT_PORT = 7890;
export const DEFAULT_DESIGN_MODEL = 'claude-opus-5-5';
export const DEFAULT_JOB_MODEL = 'claude-sonnet-5-5';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ClaudeConfig {
  designModel: string;
  effort: Effort;
  /** agent steps per design turn */
  maxTurns: number;
  /** optional spend cap per design turn (USD) */
  maxBudgetUsd?: number;
  /** --use-claude-login (secrets.json may also opt in; see auth) */
  useClaudeLoginFlag: boolean;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  libraryDir: string;
  kitDir: string;
  parentPid?: number;
  backend: 'claude' | 'sim';
  debug: boolean;
  claude: ClaudeConfig;
  /** sim: ms per fake progress step */
  simStepMs: number;
  /** (protocol 2) Claude jobs */
  jobs: JobsConfig;
  /** (4b) design and bible jobs running at once, shared round-robin by groups and single designs (config designConcurrency) */
  designConcurrency: number;
  /** (4b) <gameDir>/architect/bibles (the library dir's sibling; --bibles overrides) */
  biblesDir: string;
  /** (4b) the default model of a bible job (config bibleModel) */
  bibleModel: string;
  /** (4b) design groups */
  groups: GroupsConfig;
  /** sim: the cost a sim design / bible pass reports (config simDesignUsd, default 0) */
  simDesignUsd: number;
  /** sim: how long a simulated usage limit lasts (config simLimitMs) */
  simLimitMs: number;
  /** (4c) massing jobs */
  massing: MassingConfig;
  /** (5a) the critic */
  critique: CritiqueConfig;
  /** (5b) polish: config polish.model (default: the entry's designer model) and polish.scopingModel (default Sonnet) */
  polish: { model?: string | undefined; scopingModel: string };
  /** (6a) region programs: planning and tile evaluation */
  regions: RegionsConfig;
  /**
   * (6c 0a, C4) sim only: the notional per-item costs (config simCosts, env ARCHITECT_SIM_COSTS, which wins); undefined =
   * "zero", the default, where the older simDesignUsd / simJobStepUsd step costs apply unchanged
   */
  simCosts?: SimCosts | undefined;
}

export interface RegionsConfig {
  /** <gameDir>/architect/regions/programs (the library dir's sibling): where non-bundled programs may live */
  programsDir: string;
  /** tile evaluation workers (config regionWorkers, 1-16; default min(4, cores/2)) */
  workers: number;
  /** evaluated tiles held per plan and connection (config regionWindow, 1-16, default 4) */
  window: number;
  /** a plan run's time limit in ms (config regionPlanMs, default 30000; enforced as wall clock) */
  planMs: number;
  /** a plan run's heap (--max-old-space-size, config regionPlanHeapMb, default 1024) */
  planHeapMb: number;
  /** the largest IR (config regionIrMaxBytes, default 4 MB) */
  irMaxBytes: number;
  /** one tile's evaluation limit in ms (config regionTileMs, default 2000) */
  tileMs: number;
  /** one worker's heap (resourceLimits.maxOldGenerationSizeMb, config regionTileHeapMb, default 256) */
  tileHeapMb: number;
  /** plan runs at once (config regionPlanConcurrency, default 2) */
  planConcurrency: number;
  /** (6b) the checker and the previews after a plan, together: wall clock (config regionCheckMs, default 180000) */
  checkMs: number;
  /** (6b) the checker's and the renderer's heap (config regionCheckHeapMb, default 2048) */
  checkHeapMb: number;
  /** (6b) one side blob / a plan's side blobs in all (16 MB / 64 MB, CONTRACT 6b §2.2) */
  blobMaxBytes: number;
  blobsMaxBytes: number;
  /** (6b) region.design: the pick model (config regionDesignModel, default jobModel: Sonnet) */
  designModel?: string | undefined;
}

/** The default worker count: min(4, cores / 2), at least 1. */
export function defaultRegionWorkers(): number {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

function regionsConfig(file: Record<string, unknown>, libraryDir: string): RegionsConfig {
  const int = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
  return {
    programsDir: path.join(path.dirname(libraryDir), 'regions', 'programs'),
    workers: int(file.regionWorkers, defaultRegionWorkers(), 1, 16),
    window: int(file.regionWindow, 4, 1, 16),
    planMs: int(file.regionPlanMs, 30_000, 100, 600_000),
    planHeapMb: int(file.regionPlanHeapMb, 1024, 64, 8192),
    irMaxBytes: int(file.regionIrMaxBytes, 4 * 1024 * 1024, 1024, 4 * 1024 * 1024),
    tileMs: int(file.regionTileMs, 2000, 50, 60_000),
    tileHeapMb: int(file.regionTileHeapMb, 256, 16, 4096),
    planConcurrency: int(file.regionPlanConcurrency, 2, 1, 8),
    checkMs: int(file.regionCheckMs, 180_000, 100, 1_800_000),
    checkHeapMb: int(file.regionCheckHeapMb, 2048, 64, 16384),
    blobMaxBytes: 16 * 1024 * 1024,
    blobsMaxBytes: 64 * 1024 * 1024,
    ...(typeof file.regionDesignModel === 'string' && file.regionDesignModel.trim() ? { designModel: file.regionDesignModel.trim() } : {}),
  };
}

export interface CritiqueConfig {
  /** the critic model (config critique.model, default claude-sonnet-5-5) */
  model: string;
  /** (config critique.effort, default medium) */
  effort: 'low' | 'medium' | 'high';
}

export interface MassingConfig {
  /** <gameDir>/architect/massings (the library dir's sibling; --massings overrides) */
  dir: string;
  /** the default model of a massing job (config massingModel, default claude-sonnet-5-5) */
  model: string;
  /** (config massingEffort, default low) */
  effort: Effort;
  /** agent steps per massing turn (config massingMaxTurns, default 20) */
  maxTurns: number;
  /** redirect rounds per group item unless the group says (config maxRedirects, default 3) */
  maxRedirects: number;
}

export interface GroupsConfig {
  /** the default model of a landmark item (config landmarkModel) */
  landmarkModel: string;
  /** the default model of an ordinary item (config ordinaryModel) */
  ordinaryModel: string;
  /** the soft budget: dispatching pauses at this fraction of a group's budgetUsd (config softBudgetFraction, default 0.8) */
  softBudgetFraction: number;
}

export interface JobsConfig {
  /** the default model of a job (config jobModel, ARCHITECT_JOB_MODEL) */
  model: string;
  /** structured jobs running at once (config jobConcurrency); agent jobs share the design queue's one slot */
  concurrency: number;
  /** sim: the estimated cost of each step (config simJobStepUsd) */
  simStepUsd: number;
}

export const HELP = `Architect sidecar ${VERSION}

  node dist/main.mjs --port 7890 --data <dir> --library <dir> --kit <dir>
                     [--use-claude-login] [--parent-pid <pid>] [--backend claude|sim] [--debug]

  --port <n>           WebSocket port on 127.0.0.1 (default 7890, or ARCHITECT_PORT; 0 = any free port)
  --data <dir>         sidecar data: state.json, client.token, sidecar.json, secrets.json, logs/, designs/
  --library <dir>      the design library (<gameDir>/architect/library): installs go to <library>/<id>/
  --kit <dir>          the blueprint kit (kit/build.mjs, kit/render.mjs, kit/lib, kit/designs)
  --bibles <dir>       style bibles (default: <library>/../bibles, i.e. <gameDir>/architect/bibles)
  --massings <dir>     massings (default: <library>/../massings, i.e. <gameDir>/architect/massings)
  --use-claude-login   use your local \`claude\` login instead of an API key (personal use only)
  --parent-pid <pid>   exit when this process is gone (checked every 5 s)
  --backend <name>     claude (default) or sim (no Claude: installs a kit example; tests, offline UI work)
  --debug              verbose logging
`;

export class ConfigError extends Error {}

export function parseFlags(argv: string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new ConfigError(`unexpected argument ${a}`);
    const eq = a.indexOf('=');
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i++;
    } else flags[name] = true;
  }
  return flags;
}

const BOOL_FLAGS = new Set(['use-claude-login', 'debug', 'help']);
const VALUE_FLAGS = new Set(['port', 'data', 'library', 'kit', 'parent-pid', 'backend', 'bibles', 'massings']);

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  const flags = parseFlags(argv);
  for (const [k, v] of Object.entries(flags)) {
    if (BOOL_FLAGS.has(k)) {
      if (v !== true) throw new ConfigError(`--${k} takes no value`);
    } else if (VALUE_FLAGS.has(k)) {
      if (v === true) throw new ConfigError(`--${k} needs a value`);
    } else throw new ConfigError(`unknown flag --${k}`);
  }
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
  const need = (k: string) => {
    const v = str(k);
    if (!v) throw new ConfigError(`--${k} <dir> is required`);
    return path.resolve(v);
  };
  const portRaw = str('port') ?? env.ARCHITECT_PORT ?? String(DEFAULT_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`bad port ${portRaw}`);
  const backend = str('backend') ?? 'claude';
  if (backend !== 'claude' && backend !== 'sim') throw new ConfigError(`--backend must be claude or sim (got ${backend})`);
  let parentPid: number | undefined;
  if (str('parent-pid') !== undefined) {
    parentPid = Number(str('parent-pid'));
    if (!Number.isInteger(parentPid) || parentPid <= 0) throw new ConfigError(`bad --parent-pid ${str('parent-pid')}`);
  }
  const dataDir = need('data');
  const file = readConfigFile(dataDir);
  const effort = typeof file.effort === 'string' && (EFFORTS as readonly string[]).includes(file.effort) ? (file.effort as Effort) : 'high';
  const model = env.ARCHITECT_DESIGN_MODEL?.trim() || (typeof file.designModel === 'string' && file.designModel.trim()) || DEFAULT_DESIGN_MODEL;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return {
    host: '127.0.0.1',
    port,
    dataDir,
    libraryDir: need('library'),
    kitDir: need('kit'),
    ...(parentPid ? { parentPid } : {}),
    backend,
    debug: flags.debug === true,
    claude: {
      designModel: model,
      effort,
      maxTurns: Math.round(num(file.maxTurns, 120)),
      ...(typeof file.maxBudgetUsd === 'number' && file.maxBudgetUsd > 0 ? { maxBudgetUsd: file.maxBudgetUsd } : {}),
      useClaudeLoginFlag: flags['use-claude-login'] === true,
    },
    simStepMs: num(file.simStepMs, 400),
    jobs: {
      model: env.ARCHITECT_JOB_MODEL?.trim() || (typeof file.jobModel === 'string' && file.jobModel.trim()) || DEFAULT_JOB_MODEL,
      concurrency: Math.max(1, Math.min(16, Math.round(num(file.jobConcurrency, 4)))),
      simStepUsd: typeof file.simJobStepUsd === 'number' && file.simJobStepUsd >= 0 ? file.simJobStepUsd : 0.01,
    },
    designConcurrency: Math.max(1, Math.min(16, Math.round(num(file.designConcurrency, 3)))),
    biblesDir: str('bibles') ? path.resolve(str('bibles')!) : path.join(path.dirname(need('library')), 'bibles'),
    bibleModel: (typeof file.bibleModel === 'string' && file.bibleModel.trim()) || DEFAULT_DESIGN_MODEL,
    groups: {
      landmarkModel: (typeof file.landmarkModel === 'string' && file.landmarkModel.trim()) || DEFAULT_DESIGN_MODEL,
      ordinaryModel: (typeof file.ordinaryModel === 'string' && file.ordinaryModel.trim()) || DEFAULT_JOB_MODEL,
      softBudgetFraction: typeof file.softBudgetFraction === 'number' && file.softBudgetFraction > 0 && file.softBudgetFraction <= 1 ? file.softBudgetFraction : 0.8,
    },
    simDesignUsd: typeof file.simDesignUsd === 'number' && file.simDesignUsd >= 0 ? file.simDesignUsd : 0,
    simLimitMs: num(file.simLimitMs, 1500),
    massing: {
      dir: str('massings') ? path.resolve(str('massings')!) : path.join(path.dirname(need('library')), 'massings'),
      model: (typeof file.massingModel === 'string' && file.massingModel.trim()) || DEFAULT_JOB_MODEL,
      effort: typeof file.massingEffort === 'string' && (EFFORTS as readonly string[]).includes(file.massingEffort) ? (file.massingEffort as Effort) : 'low',
      maxTurns: Math.round(num(file.massingMaxTurns, 20)),
      maxRedirects: typeof file.maxRedirects === 'number' && Number.isInteger(file.maxRedirects) && file.maxRedirects >= 0 && file.maxRedirects <= 10 ? file.maxRedirects : 3,
    },
    critique: critiqueConfig(file),
    polish: polishConfig(file),
    regions: regionsConfig(file, need('library')),
    simCosts: backend === 'sim' ? simCostsConfig(env.ARCHITECT_SIM_COSTS?.trim() ? env.ARCHITECT_SIM_COSTS : file.simCosts) : undefined,
  };
}

/**
 * (6c 0a, C4) The sim's notional costs per item (USD). They are labelled `sim: true` (the estimate's basis, the log); nothing
 * is spent. bible: a bible job (its draft and components passes share it); massing: a massing (round 1); detail: a detail
 * pass or a single design (round 1); critique: one critic call (a report critique, a loop's critic, a bible sheet critique);
 * repair: one repair round (round 2 and later: `sim:repair`, a loop revision).
 */
export interface SimCosts {
  mode: 'measured' | 'custom';
  bible: number;
  massing: number;
  detail: number;
  critique: number;
  repair: number;
}

/** "measured": the midpoints of the seeds measured in Steward's phase 1 (2026-10-09), docs/CONTRACT.md 6c slice 0a §2. */
export const MEASURED_SIM_COSTS: SimCosts = { mode: 'measured', bible: 1.35, massing: 0.19, detail: 3.4, critique: 0.1, repair: 0.5 };
const SIM_COST_KEYS = ['bible', 'massing', 'detail', 'critique', 'repair'] as const;

/**
 * simCosts: absent or "zero" -> undefined; "measured" -> {@link MEASURED_SIM_COSTS}; an object with the five keys (USD, >= 0;
 * in the env, as JSON) -> those. Anything else is a ConfigError, so a typo does not silently run at $0.
 */
export function simCostsConfig(raw: unknown): SimCosts | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let v: unknown = raw;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === 'zero') return undefined;
    if (t === 'measured') return { ...MEASURED_SIM_COSTS };
    if (!t.startsWith('{')) throw new ConfigError(`simCosts must be "zero", "measured" or an object with ${SIM_COST_KEYS.join(', ')} (got ${JSON.stringify(t).slice(0, 80)})`);
    try {
      v = JSON.parse(t);
    } catch {
      throw new ConfigError('simCosts: not valid JSON');
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ConfigError(`simCosts must be "zero", "measured" or an object with ${SIM_COST_KEYS.join(', ')}`);
  const o = v as Record<string, unknown>;
  const out: SimCosts = { mode: 'custom', bible: 0, massing: 0, detail: 0, critique: 0, repair: 0 };
  for (const k of SIM_COST_KEYS) {
    const n = o[k];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1000) throw new ConfigError(`simCosts.${k} must be a number of USD from 0 to 1000 (got ${JSON.stringify(n)})`);
    out[k] = n;
  }
  const extra = Object.keys(o).filter((k) => !(SIM_COST_KEYS as readonly string[]).includes(k));
  if (extra.length) throw new ConfigError(`simCosts: unknown key${extra.length === 1 ? '' : 's'} ${extra.join(', ')}`);
  return out;
}

/** The log/basis label of the sim's notional costs. */
export function simCostsLabel(c: SimCosts): string {
  return `sim: true, notional sim costs "${c.mode}" (nothing is spent): bible $${c.bible}, massing $${c.massing}, detail $${c.detail}, critique $${c.critique}, repair round $${c.repair}`;
}

function critiqueConfig(file: Record<string, unknown>): CritiqueConfig {
  const c = file.critique && typeof file.critique === 'object' && !Array.isArray(file.critique) ? (file.critique as Record<string, unknown>) : {};
  const effort = c.effort === 'low' || c.effort === 'medium' || c.effort === 'high' ? c.effort : 'medium';
  return { model: (typeof c.model === 'string' && c.model.trim()) || DEFAULT_JOB_MODEL, effort };
}

function polishConfig(file: Record<string, unknown>): Config['polish'] {
  const c = file.polish && typeof file.polish === 'object' && !Array.isArray(file.polish) ? (file.polish as Record<string, unknown>) : {};
  return { ...(typeof c.model === 'string' && c.model.trim() ? { model: c.model.trim() } : {}), scopingModel: (typeof c.scopingModel === 'string' && c.scopingModel.trim()) || DEFAULT_JOB_MODEL };
}

function readConfigFile(dataDir: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
