// F2 (docs/CONTRACT.md "Phase 5b", "F2: the claude login without USER/LOGNAME"): a client started from a scrubbed
// environment (`env -i`) without USER and LOGNAME did not find the claude login (likely the CLI's macOS keychain lookup).
// In login mode, before the auth check and every CLI spawn, the sidecar fills in what is missing from the OS:
//   - USER / LOGNAME (each one that is unset or empty) from os.userInfo().username, else the basename of HOME;
//   - HOME (unset or empty) from os.userInfo().homedir.
// It is logged once: "USER/LOGNAME were unset; using <name> from the OS". The fill is a pure function over (env, userInfo)
// so tests inject both; `ensureLoginEnv` applies it to the live environment (process.env by default).
import os from 'node:os';
import path from 'node:path';

export interface UserInfoLike {
  username?: string | undefined;
  homedir?: string | undefined;
}

export interface LoginEnvFill {
  /** the variables that were filled in (USER, LOGNAME, HOME) */
  filled: string[];
  /** the user name USER/LOGNAME got, when one of them was filled */
  name?: string;
}

const empty = (v: string | undefined) => v === undefined || v.trim() === '';

/** What the OS says about the current user (os.userInfo() throws without a passwd entry). */
export function osUserInfo(): UserInfoLike {
  try {
    const u = os.userInfo();
    return { username: u.username, homedir: u.homedir };
  } catch {
    return {};
  }
}

/** Fill USER, LOGNAME and HOME in `env` (in place) where they are unset or empty. Pure apart from `env`. */
export function fillLoginEnv(env: Record<string, string | undefined>, info: () => UserInfoLike): LoginEnvFill {
  const filled: string[] = [];
  let u: UserInfoLike | undefined;
  const user = () => (u ??= info());
  if (empty(env.HOME)) {
    const home = user().homedir;
    if (home && home.trim()) {
      env.HOME = home;
      filled.push('HOME');
    }
  }
  let name: string | undefined;
  if (empty(env.USER) || empty(env.LOGNAME)) {
    const fromOs = user().username;
    name = fromOs && fromOs.trim() ? fromOs : env.HOME && env.HOME.trim() ? path.basename(env.HOME) : undefined;
    if (name) {
      for (const k of ['USER', 'LOGNAME']) {
        if (empty(env[k])) {
          env[k] = name;
          filled.push(k);
        }
      }
    }
  }
  return { filled, ...(name && filled.some((k) => k !== 'HOME') ? { name } : {}) };
}

/** The live fill: applied once per environment object, logged once. */
const applied = new WeakMap<object, LoginEnvFill>();

export function ensureLoginEnv(log: { info(m: string): void } | undefined, env: Record<string, string | undefined> = process.env, info: () => UserInfoLike = osUserInfo): LoginEnvFill {
  const prev = applied.get(env);
  // once filled, keep the first result (a later call finds nothing missing, but the message must still say so)
  const now = fillLoginEnv(env, info);
  const merged: LoginEnvFill = prev ? { filled: [...new Set([...prev.filled, ...now.filled])], ...(prev.name ?? now.name ? { name: prev.name ?? now.name } : {}) } : now;
  applied.set(env, merged);
  if (now.filled.length) {
    const users = now.filled.filter((k) => k !== 'HOME');
    if (users.length) log?.info(`USER/LOGNAME were unset; using ${now.name} from the OS`);
    if (now.filled.includes('HOME')) log?.info(`HOME was unset; using ${env.HOME} from the OS`);
  }
  return merged;
}

/**
 * The auth check's message when the claude CLI reports no login (login mode). It stays an `auth` failure: the caller
 * passes it to markAuthFailed (failures.ts probeFailure classifies the probe's 'not logged in' as auth).
 */
export function noLoginMessage(env: Record<string, string | undefined>, fill: LoginEnvFill | undefined): string {
  const base = `The claude CLI found no login (user ${env.USER || '(unset)'}, HOME ${env.HOME || '(unset)'}). Log in by running \`claude\` and \`/login\` in a terminal as this user. If Minecraft starts from a scrubbed environment, keep HOME, USER and LOGNAME.`;
  const filled = fill?.filled ?? [];
  if (!filled.length) return base;
  return `${base} (The sidecar filled in ${filled.join(', ')} from the OS${fill?.name ? `: ${fill.name}` : ''}.)`;
}
