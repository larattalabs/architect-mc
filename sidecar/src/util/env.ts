// Variables that never reach a process the sidecar starts (the design agent's CLI, the kit checker
// and renderer): the client token tools may take from the environment. scrubEnv runs on the FINAL
// environment of every spawn.

export const SECRET_ENV_VARS = ['ARCHITECT_CLIENT_TOKEN'];

export function isSecretEnvVar(name: string): boolean {
  return SECRET_ENV_VARS.includes(name.toUpperCase());
}

/** A copy of `env` without the secret variables (any letter case: Windows names are case-insensitive). */
export function scrubEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  for (const k of Object.keys(out)) if (isSecretEnvVar(k)) delete out[k];
  return out;
}

/** `env` with `dir` first on PATH (the key keeps its spelling: `Path` on Windows). */
export function withPathFirst(env: Record<string, string | undefined>, dir: string): Record<string, string | undefined> {
  const out = { ...env };
  const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const sep = process.platform === 'win32' ? ';' : ':';
  const rest = (out[key] ?? '').split(sep).filter((p) => p && p !== dir);
  out[key] = [dir, ...rest].join(sep);
  return out;
}
