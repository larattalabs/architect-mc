// Sidecar entry point (docs/CONTRACT.md "Sidecar process"):
//
//   node dist/main.mjs --port 7890 --data <dir> --library <dir> --kit <dir>
//                      [--use-claude-login] [--parent-pid <pid>] [--backend claude|sim]
//
// Start-up order: bind the port first; only then write <data>/client.token (0600) and
// <data>/sidecar.json. A second sidecar that finds the port taken exits with code 3 and touches
// neither file, so the running one (and the mod's connection to it) is never disturbed. On exit
// each file is removed only if it is still ours.
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeDesigner } from './claude/designer.js';
import { newToken, removeClientToken, writeClientToken } from './clienttoken.js';
import { ConfigError, HELP, loadConfig, VERSION, type Config } from './config.js';
import { consoleLogger } from './context.js';
import { pidAlive, removeRunFile, writeRunFile } from './runfile.js';
import { SidecarServer } from './server.js';
import { Sidecar } from './sidecar.js';
import { SimDesigner } from './sim.js';
import { Store } from './store.js';

export const EXIT_PORT_IN_USE = 3;
export const EXIT_USAGE = 2;
const PARENT_CHECK_MS = 5000;

export async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  let cfg: Config;
  try {
    cfg = loadConfig(argv);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`${e.message}\n\n${HELP}`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    throw e;
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const log = consoleLogger('sidecar', { debug: cfg.debug, file: path.join(cfg.dataDir, 'logs', 'sidecar.log') });
  if (!fs.existsSync(path.join(cfg.kitDir, 'build.mjs'))) log.warn(`no build.mjs in the kit at ${cfg.kitDir}: designs will fail until it is there`);

  const store = new Store(cfg.dataDir);
  const sidecar = new Sidecar(cfg, store, log);
  const designer = cfg.backend === 'sim' ? new SimDesigner(sidecar, cfg.simStepMs) : new ClaudeDesigner(sidecar);
  const token = newToken(); // never logged
  const server = new SidecarServer(sidecar, { host: cfg.host, port: cfg.port, token, validateOutbound: cfg.debug, log });

  try {
    await server.start();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') log.error(`port ${cfg.port} is already in use (another sidecar? see ${path.join(cfg.dataDir, 'sidecar.json')})`);
    else log.error(`could not listen on ${cfg.host}:${cfg.port}: ${(e as Error).message}`);
    store.close();
    process.exitCode = code === 'EADDRINUSE' ? EXIT_PORT_IN_USE : 1;
    return;
  }
  const tokenFile = writeClientToken(cfg.dataDir, token);
  writeRunFile(cfg.dataDir, { pid: process.pid, port: server.port, version: VERSION, startedAt: Date.now() });
  sidecar.endpoint = { port: server.port, tokenFile };
  log.info(`Architect sidecar ${VERSION} | designer ${cfg.backend} | ws://${cfg.host}:${server.port} | data ${cfg.dataDir} | library ${cfg.libraryDir} | kit ${cfg.kitDir}`);

  let shuttingDown = false;
  const shutdown = async (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${why}: shutting down (state is saved; unfinished designs resume on the next start)`);
    const force = setTimeout(() => process.exit(0), 8000);
    force.unref();
    try {
      await server.stop();
      await sidecar.close();
    } finally {
      removeClientToken(tokenFile, token);
      removeRunFile(cfg.dataDir, process.pid);
      clearTimeout(force);
      process.exit(0);
    }
  };
  sidecar.onShutdown = () => void shutdown('shutdown message');
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
  process.on('uncaughtException', (e) => log.error(`uncaught: ${e.stack ?? e}`));
  process.on('unhandledRejection', (e) => log.error(`unhandled rejection: ${(e as Error)?.stack ?? e}`));

  if (cfg.parentPid) {
    const ppid = cfg.parentPid;
    if (!pidAlive(ppid)) {
      void shutdown(`parent pid ${ppid} is gone`);
      return;
    }
    const t = setInterval(() => {
      if (!pidAlive(ppid)) {
        clearInterval(t);
        void shutdown(`parent pid ${ppid} is gone`);
      }
    }, PARENT_CHECK_MS);
  }

  await sidecar.start(designer);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
