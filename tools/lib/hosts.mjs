// Where a gate step runs (docs/GATES.md "Headless gates"): on a dev client, or on a headless server (a dedicated server with
// the devserver mod behind the same DevBridge: tools/run-headless-server.mjs). Used by tools/gate-run.mjs.
//
// A step's `host` in tools/gate-chains.json says where it can run:
//   "server"  converted: its checks pass headless (the same functional results as on a client; see the comparison in GATES.md)
//   "client"  needs a client: it renders (screenshots, galleries, the ghost) or drives the UI; `hostWhy` says what
//   (absent)  not converted yet: a client ("auto"), headless only with --host server
// The runner's --host (GATE_HOST) picks: auto (each step's host; the default), client (every step on a client, as before),
// server (every step not marked "client" headless: for trying a step out).
//
// A client entry of gate-chains.json gets a "<key>@server" twin: the headless script, the same world, its own family (a server
// and a client never switch worlds into one another), and HEADLESS_SIDECAR from the family (stub -> the stub sidecar, sim ->
// the sim backend). A `self` step (it starts its own clients, as apijars does) gets the step's `headlessEnv` instead (the
// driver's launch script override).

export const HEADLESS_SCRIPT = 'tools/run-headless-server.mjs';
export const HOST_MODES = ['auto', 'client', 'server'];

const sidecarOf = (family) => (family === 'stub' ? 'stub' : 'sim');

/** Rewrites cfg in place for the host mode; returns {mode, server: [step ids], client: [{id, why}]}. */
export function applyHosts(cfg, mode) {
  if (!HOST_MODES.includes(mode)) throw new Error(`--host must be one of ${HOST_MODES.join(', ')}: ${mode}`);
  for (const [key, c] of Object.entries({ ...cfg.clients })) {
    if (key.endsWith('@server')) continue;
    const family = c.family ?? key;
    cfg.clients[`${key}@server`] = {
      script: HEADLESS_SCRIPT, world: c.world, family: `${family}@server`,
      env: { ...(c.env ?? {}), HEADLESS_SIDECAR: sidecarOf(family) },
    };
  }
  const out = { mode, server: [], client: [] };
  for (const [id, s] of Object.entries(cfg.steps)) {
    const headless = mode === 'server' ? s.host !== 'client' : mode === 'auto' ? s.host === 'server' : false;
    if (s.client === 'none') continue;
    if (!headless) {
      out.client.push({ id, why: s.hostWhy ?? (s.host ? 'marked client' : 'not converted') });
      continue;
    }
    if (s.client === 'self') {
      s.env = { ...(s.env ?? {}), ...(s.headlessEnv ?? {}) };
    } else if (cfg.clients[s.client]) {
      s.client = `${s.client}@server`;
    }
    s.headless = true;
    out.server.push(id);
  }
  return out;
}
