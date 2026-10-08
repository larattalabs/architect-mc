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

// ---- (6a) region columns -------------------------------------------------------------------------

/** An ARSV columns buffer (kit/REGIONS.md "Columns codec"). */
export function arsv(minX: number, minZ: number, width: number, depth: number, ground: (i: number, j: number) => number = () => 64, resolution = 1): Buffer {
  const n = width * depth;
  const b = Buffer.alloc(28 + n * 7);
  b.write('ARSV', 0, 'latin1');
  b[4] = 1;
  b.writeInt32LE(minX, 8);
  b.writeInt32LE(minZ, 12);
  b.writeInt32LE(width, 16);
  b.writeInt32LE(depth, 20);
  b.writeInt32LE(resolution, 24);
  for (let j = 0; j < depth; j++)
    for (let i = 0; i < width; i++) {
      const k = i + j * width;
      const g = ground(i, j);
      b.writeInt16LE(g, 28 + k * 2);
      b.writeInt16LE(g, 28 + n * 2 + k * 2);
      b.writeInt16LE(g, 28 + n * 4 + k * 2);
    }
  return b;
}

/** A tile's heights: its 80x80 window. */
export function tileHeights(key: string, salt = 0): string {
  const [tx, tz] = key.split(',').map(Number) as [number, number];
  return arsv(64 * tx - 8, 64 * tz - 8, 80, 80, (i, j) => 60 + ((i * 7 + j * 3 + salt + tx * 5 + tz) % 9)).toString('base64');
}

