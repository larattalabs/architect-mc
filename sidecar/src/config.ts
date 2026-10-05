// Launch flags (docs/CONTRACT.md "Sidecar process") and the optional <data>/config.json.
//
//   node dist/main.mjs --port 7890 --data <dir> --library <dir> --kit <dir>
//                      [--use-claude-login] [--parent-pid <pid>] [--backend claude|sim] [--debug] [--bibles <dir>] [--massings <dir>]
//
// <data>/config.json (optional, hand-edited): { "designModel", "effort", "maxTurns", "maxBudgetUsd",
// "simStepMs", "jobModel", "jobConcurrency", "simJobStepUsd" }. ARCHITECT_DESIGN_MODEL overrides
// designModel, ARCHITECT_JOB_MODEL jobModel.
import fs from 'node:fs';
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
  };
}

function readConfigFile(dataDir: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
