// npm run build: bundle src/main.ts into dist/main.mjs (ESM, node >= 22), plus dist/region-worker.mjs (copied). The Agent SDK stays
// external (installed by `npm ci --omit=dev` next to dist/); ws and zod are bundled, so the sidecar
// starts and serves status even before the SDK is installed. ws is CommonJS: the banner gives the
// bundle a real `require` for the node built-ins it loads; its optional native helpers stay external
// (ws falls back when they are missing).
import { build } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, 'src', 'main.ts')],
  outfile: path.join(root, 'dist', 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@anthropic-ai/claude-agent-sdk', 'bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __architectCreateRequire } from 'node:module'; const require = __architectCreateRequire(import.meta.url);" },
  legalComments: 'none',
  // (5b) the critic hash (src/critichash.ts): sha256 of "sidecar/src/critic.ts" + its bytes, as eval.mjs provenance() has it
  define: { __ARCHITECT_CRITIC_HASH__: JSON.stringify(crypto.createHash('sha256').update('sidecar/src/critic.ts').update(fs.readFileSync(path.join(root, 'src', 'critic.ts'))).digest('hex')) },
  logLevel: 'warning',
});
// (6a) the region tile worker is plain ESM loaded by URL next to main.mjs (src/regionpool.ts WORKER_URL)
fs.copyFileSync(path.join(root, 'src', 'region-worker.mjs'), path.join(root, 'dist', 'region-worker.mjs'));
console.log(`built ${path.relative(process.cwd(), path.join(root, 'dist', 'main.mjs'))}`);
