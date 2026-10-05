// Launch flags (docs/CONTRACT.md "Sidecar process") and the optional <data>/config.json.
//
//   node dist/main.mjs --port 7890 --data <dir> --library <dir> --kit <dir>
//                      [--use-claude-login] [--parent-pid <pid>] [--backend claude|sim] [--debug]
//
// <data>/config.json (optional, hand-edited): { "designModel", "effort", "maxTurns", "maxBudgetUsd",
// "simStepMs" }. ARCHITECT_DESIGN_MODEL overrides designModel.
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
}

export const HELP = `Architect sidecar ${VERSION}

  node dist/main.mjs --port 7890 --data <dir> --library <dir> --kit <dir>
                     [--use-claude-login] [--parent-pid <pid>] [--backend claude|sim] [--debug]

  --port <n>           WebSocket port on 127.0.0.1 (default 7890, or ARCHITECT_PORT; 0 = any free port)
  --data <dir>         sidecar data: state.json, client.token, sidecar.json, secrets.json, logs/, designs/
  --library <dir>      the design library (<gameDir>/architect/library): installs go to <library>/<id>/
  --kit <dir>          the blueprint kit (kit/build.mjs, kit/render.mjs, kit/lib, kit/designs)
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
const VALUE_FLAGS = new Set(['port', 'data', 'library', 'kit', 'parent-pid', 'backend']);

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
