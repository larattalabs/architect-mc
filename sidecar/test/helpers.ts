import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import type { Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { Store } from '../src/store.js';

export const SIDECAR_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FIXTURE_KIT = path.join(SIDECAR_ROOT, 'test', 'fixtures', 'kit');

export function tempDir(prefix = 'arch-test-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export async function until(cond: () => boolean, timeoutMs = 10_000, stepMs = 25): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** A copy of the fixture kit (tests may change it). */
export function copyKit(into: string): string {
  const kit = path.join(into, 'kit');
  fs.cpSync(FIXTURE_KIT, kit, { recursive: true });
  return kit;
}

export interface Harness {
  root: string;
  cfg: Config;
  store: Store;
  sc: Sidecar;
  events: Outbound[];
  log: ReturnType<typeof memoryLogger>;
  close(): Promise<void>;
}

/** A Sidecar over temp dirs (data, library, a copy of the fixture kit); no server. */
export function makeSidecar(extraArgs: string[] = []): Harness {
  const root = tempDir();
  const kit = copyKit(root);
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', kit, '--port', '0', ...extraArgs], {});
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const store = new Store(cfg.dataDir, { debounceMs: 5 });
  const log = memoryLogger();
  const sc = new Sidecar(cfg, store, log);
  const events: Outbound[] = [];
  sc.subscribe((m) => events.push(m));
  return {
    root,
    cfg,
    store,
    sc,
    events,
    log,
    close: async () => {
      await sc.close();
      rmrf(root);
    },
  };
}

export function request(over: Record<string, unknown> = {}) {
  return { type: 'cabin' as const, style: 'rustic', materials: 'spruce and cobblestone', features: ['porch', 'chimney'], maxSize: { x: 40, y: 20, z: 40 }, name: 'Lakeside Cabin', notes: 'a reading nook', ...over };
}
