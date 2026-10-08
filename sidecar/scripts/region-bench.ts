// (6a) Region plan + tile throughput bench (CONTRACT §7 "tile evaluation": >= 45k cells/s with 4 workers on mega_bench;
// sidecar RSS <= 1.5 GB). No game, no Claude: a Sidecar in-process over temp dirs, a synthetic ARSV survey and synthetic
// tile heights, every tile of every stage and set the IR lists, streamed through the real window and pool.
//
//   node --import tsx scripts/region-bench.ts --kit <kitDir> [--program mega_bench] [--params '{}'] [--seed 1]
//        [--claim minX,minZ,maxX,maxZ,minY,maxY] [--workers 1,4] [--window 4] [--limit <tiles>] [--json <file>]
//
// Prints the plan time, then per worker count: tiles, cells, wall, cells/s, gzip bytes per cell, peak
// RSS (the workers are threads, so the process RSS covers them), and whether every tile's sha matched the first run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import type { Outbound, Protocol } from '../src/protocol.js';
import type { ClientHandle } from '../src/server.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';

const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const kit = path.resolve(flag('kit') ?? path.join(import.meta.dirname, '..', '..', 'kit'));
const program = flag('program', 'mega_bench')!;
const params = JSON.parse(flag('params', '{}')!) as Record<string, unknown>;
const seed = flag('seed', '1')!;
const c = (flag('claim', '0,0,1023,1023,-64,319')!).split(',').map(Number) as [number, number, number, number, number, number];
const claim = { minX: c[0], minZ: c[1], maxX: c[2], maxZ: c[3], minY: c[4], maxY: c[5] };
const workerCounts = flag('workers', '1,4')!.split(',').map(Number);
const window = Number(flag('window', '4'));
const limit = flag('limit') ? Number(flag('limit')) : Infinity;
const jsonOut = flag('json');

/** ARSV with a gentle synthetic terrain (ground 62..78, a lake where it dips under 64). */
function arsv(minX: number, minZ: number, w: number, d: number, res: number): Buffer {
  const n = w * d;
  const b = Buffer.alloc(28 + n * 7);
  b.write('ARSV', 0, 'latin1');
  b[4] = 1;
  b.writeInt32LE(minX, 8);
  b.writeInt32LE(minZ, 12);
  b.writeInt32LE(w, 16);
  b.writeInt32LE(d, 20);
  b.writeInt32LE(res, 24);
  for (let j = 0; j < d; j++)
    for (let i = 0; i < w; i++) {
      const x = minX + i * res;
      const z = minZ + j * res;
      const k = i + j * w;
      const g = 70 + Math.round(6 * Math.sin(x / 97) + 5 * Math.cos(z / 73) + 2 * Math.sin((x + z) / 31));
      const water = g < 64;
      b.writeInt16LE(water ? 63 : g, 28 + k * 2);
      b.writeInt16LE(water ? 63 : g + ((x * 31 + z * 17) % 23 === 0 ? 6 : 0), 28 + n * 2 + k * 2);
      b.writeInt16LE(water ? g : g, 28 + n * 4 + k * 2);
      b[28 + n * 6 + k] = water ? 1 : 0;
    }
  return b;
}

function surveyFor(): Buffer {
  const w = claim.maxX - claim.minX + 1;
  const d = claim.maxZ - claim.minZ + 1;
  const res = w <= 256 && d <= 256 ? 1 : 4;
  return arsv(claim.minX, claim.minZ, Math.ceil(w / res), Math.ceil(d / res), res);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arch-region-bench-')));
let rssPeak = 0;
const sampler = setInterval(() => {
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
}, 50);

async function makeSidecar(workers: number): Promise<Sidecar> {
  const dir = path.join(root, `w${workers}`);
  const cfg = loadConfig(['--data', path.join(dir, 'data'), '--library', path.join(dir, 'library'), '--kit', kit, '--backend', 'sim'], {});
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  cfg.regions.workers = workers;
  cfg.regions.window = window;
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 50 }), memoryLogger());
  await sc.start(new SimDesigner(sc, 5));
  return sc;
}

type Planned = Extract<Outbound, { type: 'region.planned' }>;

async function planOn(sc: Sidecar): Promise<{ planned: Planned; ms: number }> {
  const events: Outbound[] = [];
  sc.subscribe((m) => events.push(m));
  const blobId = sc.blobs.putBytes(surveyFor(), 'survey', 'bin');
  const t0 = performance.now();
  let ack: Record<string, unknown> | undefined;
  await sc.handle({ v: 1, type: 'region.plan', id: 'p', program, params, seed, claim, surveyBlobId: blobId } as never, (m) => {
    if (m.type === 'ack') ack = m as unknown as Record<string, unknown>;
  });
  if (!ack?.ok) throw new Error(`region.plan refused: ${String(ack?.error)}`);
  const planId = (ack.result as { planId: string }).planId;
  for (;;) {
    const e = events.find((m) => (m.type === 'region.planned' || m.type === 'region.failed') && m.planId === planId);
    if (e?.type === 'region.failed') throw new Error(`plan failed: ${e.message}`);
    if (e) return { planned: e as Planned, ms: Math.round(performance.now() - t0) };
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tileList(p: Planned): Array<{ key: string; stage: string; set: 'terrain' | 'path' }> {
  const out: Array<{ key: string; stage: string; set: 'terrain' | 'path' }> = [];
  for (const [stage, sets] of Object.entries(p.tiles as Record<string, { terrain?: string[]; path?: string[] }>))
    for (const set of ['terrain', 'path'] as const) for (const key of sets[set] ?? []) out.push({ key, stage, set });
  return out.slice(0, limit);
}

async function stream(sc: Sidecar, p: Planned, tiles: ReturnType<typeof tileList>) {
  const answers = new Map<string, { frames: Buffer[]; count: number; sha: string; at: number } | { error: string }>();
  let done = 0;
  const client: ClientHandle = {
    id: 1,
    name: 'bench',
    protocol: 2 as Protocol,
    paused: false,
    open: true,
    send() {},
    async sendFlushed(m) {
      if (m.type === 'region.tile') {
        const k = `${m.stage}|${m.set}|${m.key}`;
        const a = (answers.get(k) as { frames: Buffer[]; count: number; sha: string; at: number } | undefined) ?? { frames: [], count: m.count, sha: m.sha, at: 0 };
        a.frames.push(Buffer.from(m.data, 'base64'));
        answers.set(k, a);
        if (!m.more) {
          a.at = performance.now();
          done++;
        }
      } else if (m.type === 'region.tile.error') {
        answers.set(`${m.stage}|${m.set}|${m.key}`, { error: m.message });
        done++;
      }
    },
  };
  const heights = new Map<string, string>();
  for (const t of tiles) {
    if (heights.has(t.key)) continue;
    const [tx, tz] = t.key.split(',').map(Number) as [number, number];
    heights.set(t.key, arsv(64 * tx - 8, 64 * tz - 8, 80, 80, 1).toString('base64'));
  }
  const t0 = performance.now();
  // the mod's way: keep W outstanding, ask for one more as one is answered
  let next = 0;
  let asked = 0;
  const ask = async (n: number) => {
    const batch = tiles.slice(next, next + n);
    next += batch.length;
    if (!batch.length) return;
    asked += batch.length;
    await sc.handle({ v: 1, type: 'region.tiles.request', id: 't', planId: p.planId, irSha: p.irSha, tiles: batch.map((t) => ({ ...t, heights: heights.get(t.key)! })) } as never, () => {}, client);
  };
  await ask(window);
  while (done < tiles.length) {
    if (asked - done < window && next < tiles.length) await ask(window - (asked - done));
    else await new Promise((r) => setTimeout(r, 1));
  }
  const wall = performance.now() - t0;
  let cells = 0;
  let gzBytes = 0;
  const errors: string[] = [];
  const shas: Record<string, string> = {};
  for (const [k, a] of answers) {
    if ('error' in a) {
      errors.push(`${k}: ${a.error}`);
      continue;
    }
    cells += a.count;
    gzBytes += a.frames.reduce((s, f) => s + f.length, 0);
    shas[k] = a.sha;
  }
  return { wall, cells, gzBytes, errors, shas };
}

const report: Record<string, unknown> = { kit, program, params, seed, claim, window, node: process.version, cores: os.availableParallelism() };
try {
  const first = await makeSidecar(workerCounts[0]!);
  const { planned, ms } = await planOn(first);
  const tiles = tileList(planned);
  console.log(`plan: ${ms} ms (child ${planned.ms} ms), IR ${planned.ir ? Buffer.byteLength(planned.ir) : 'blob'} bytes, ${planned.stages.length} stages, ${tiles.length} tile evaluations`);
  report.planMs = ms;
  report.planChildMs = planned.ms;
  report.tileEvaluations = tiles.length;
  let golden: Record<string, string> | undefined;
  const runs: Record<string, unknown>[] = [];
  for (const [i, w] of workerCounts.entries()) {
    const sc = i === 0 ? first : await makeSidecar(w);
    const p = i === 0 ? planned : (await planOn(sc)).planned;
    if (p.irSha !== planned.irSha) throw new Error(`the IR differs between plan runs: ${p.irSha} vs ${planned.irSha}`);
    rssPeak = process.memoryUsage().rss;
    const r = await stream(sc, p, tiles);
    const same = golden ? Object.keys(golden).every((k) => golden![k] === r.shas[k]) && Object.keys(r.shas).length === Object.keys(golden).length : true;
    golden ??= r.shas;
    const row = { workers: w, tiles: tiles.length, cells: r.cells, wallMs: Math.round(r.wall), cellsPerSec: Math.round(r.cells / (r.wall / 1000)), gzBytesPerCell: r.cells ? +(r.gzBytes / r.cells).toFixed(3) : null, rssPeakMb: Math.round(rssPeak / 1048576), errors: r.errors.length, shasMatchFirst: same };
    console.log(JSON.stringify(row));
    if (r.errors.length) console.log(`  errors: ${r.errors.slice(0, 5).join(' | ')}`);
    runs.push(row);
    await sc.close();
  }
  report.runs = runs;
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
} finally {
  clearInterval(sampler);
  fs.rmSync(root, { recursive: true, force: true });
}
