#!/usr/bin/env node
// The headless counterpart of tools/run-gate*-client.sh (docs/GATES.md "Headless gates"): a dedicated server with the
// devserver mod behind the DevBridge's WebSocket (tools/lib/server-host.mjs), from this checkout, in mod/run (its saves/, its
// architect/ dir and token, as a dev client's). The gate drivers connect to ARCHITECT_DEV_PORT as to a client.
//
//   ARCHITECT_DEV_PORT=8943 ARCHITECT_PORT=8942 HEADLESS_SIDECAR=sim ARCHITECT_AUTOWORLD_NAME="G6A Flat Base" tools/run-headless-server.mjs
//
// HEADLESS_SIDECAR: sim (the real sidecar, --backend sim; as run-gate6a/6b-client.sh) | stub (the stub sidecar; as
// run-gate4d/4e/5b-client.sh). ARCHITECT_APITEST=0 leaves the apitest mod off the classpath (apijars puts an old jar in
// mod/run/mods). ARCHITECT_XMX caps the heap (4G). The Minecraft EULA: ARCHITECT_SERVER_EULA (Noah's own file; see the host).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHost } from './lib/server-host.mjs';

const W = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE)/.test(k)) delete env[k];
const kind = env.HEADLESS_SIDECAR ?? 'sim';
const sidecarEnv = {};
if (kind === 'stub') {
  sidecarEnv.ARCHITECT_SIDECAR_DIR = env.ARCHITECT_SIDECAR_DIR ?? path.join(W, 'mod', 'src', 'test', 'resources', 'stub-sidecar');
  sidecarEnv.STUB_COPY_FROM = env.STUB_COPY_FROM ?? path.join(W, 'kit', 'examples', 'cabin');
} else if (kind === 'sim') {
  sidecarEnv.ARCHITECT_SIDECAR_DIR = env.ARCHITECT_SIDECAR_DIR ?? path.join(W, 'sidecar');
  sidecarEnv.ARCHITECT_SIDECAR_BACKEND = 'sim';
  if (!fs.existsSync(path.join(sidecarEnv.ARCHITECT_SIDECAR_DIR, 'dist', 'main.mjs'))) {
    console.error(`no ${sidecarEnv.ARCHITECT_SIDECAR_DIR}/dist/main.mjs (cd sidecar && npm run build)`);
    process.exit(1);
  }
} else {
  console.error(`HEADLESS_SIDECAR must be sim or stub: ${kind}`);
  process.exit(2);
}
sidecarEnv.ARCHITECT_KIT_DIR = env.ARCHITECT_KIT_DIR ?? path.join(W, 'kit');
sidecarEnv.ARCHITECT_SHOTS_DIR = env.ARCHITECT_SHOTS_DIR ?? path.join(W, 'artifacts', 'headless', 'shots');

try {
  await runHost({
    root: W,
    devPort: Number(env.ARCHITECT_DEV_PORT || 8943),
    sidecarPort: Number(env.ARCHITECT_PORT || 8942),
    sidecar: kind,
    apitest: (env.ARCHITECT_APITEST ?? '1') !== '0',
    xmx: env.ARCHITECT_XMX,
    env: sidecarEnv,
    world: { name: env.ARCHITECT_AUTOWORLD_NAME, mode: env.ARCHITECT_AUTOWORLD_MODE, preset: env.ARCHITECT_AUTOWORLD_PRESET,
      seed: env.ARCHITECT_AUTOWORLD_SEED, cheats: env.ARCHITECT_AUTOWORLD_CHEATS },
  });
} catch (e) {
  console.error(`run-headless-server: ${e.message}`);
  process.exit(1);
}
