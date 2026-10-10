#!/usr/bin/env node
// find-site (docs/CONTRACT.md 6b §8.1): survey a grid of candidate claims in a scratch world of the pinned seed, score them
// by the scenario's needs, and record the winner and its survey sha in the scenario file. It runs once per scenario; after
// that the pinned file, not this tool, is the source of truth.
//
//   node tools/find-site.mjs <scenario>      (a client of the 6b run worktree must be up, in a world of the pinned seed)
//
// A scenario is scenarios/<id>.json (the golden scenarios S1-S6) or scenarios/sites/<id>.json (gate sites: the crater and
// rift sites, the volume fixture, the pick sites). Its `needs`:
//   {size: [w, d], relief: [min, max] (height range over the claim), biomes: {any: [substring...], share: 0..1},
//    waterMax, waterMin, treesMin, naturalMin (percent), avoidStructures: true, center: [x, z] (the spiral's centre), stopAt}
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCENARIO_DIR = path.join(root, 'scenarios');
const SITES_DIR = path.join(SCENARIO_DIR, 'sites');

export function scenarioFile(id) {
  const a = path.join(SCENARIO_DIR, `${id}.json`), b = path.join(SITES_DIR, `${id}.json`);
  if (fs.existsSync(a)) return a;
  if (fs.existsSync(b)) return b;
  throw new Error(`no scenario or site ${id} (scenarios/<id>.json or scenarios/sites/<id>.json)`);
}
export const readScenario = (id) => JSON.parse(fs.readFileSync(scenarioFile(id), 'utf8'));

/** Parse 4a's Sample.summary(): heights, water/tree/natural shares, biome shares, the grid. */
export function parseSummary(text) {
  const out = { biomes: {}, grid: [] };
  const h = /height (-?\d+)\.\.(-?\d+), mean ([\d.]+); water (\d+)%, trees (\d+)%, natural (\d+)%/.exec(text);
  if (h) Object.assign(out, { min: +h[1], max: +h[2], mean: +h[3], water: +h[4], trees: +h[5], natural: +h[6] });
  const b = /biomes: (.*)/.exec(text);
  if (b && b[1] !== 'none') for (const part of b[1].split(', ')) { const m = /(\S+) (\d+)%/.exec(part); if (m) out.biomes[m[1]] = +m[2]; }
  const m = /missing/.exec(text);
  const miss = /(\d+) missing/.exec(text);
  out.missing = miss ? +miss[1] : 0;
  void m;
  return out;
}

/** Score a surveyed candidate against the needs: null = rejected, else higher is better. */
export function score(s, needs) {
  if (s.min === undefined || s.missing > 0) return null;
  const relief = s.max - s.min;
  if (needs.relief && (relief < needs.relief[0] || relief > needs.relief[1])) return null;
  if (needs.waterMax !== undefined && s.water > needs.waterMax) return null;
  if (needs.waterMin !== undefined && s.water < needs.waterMin) return null;
  if (needs.treesMin !== undefined && s.trees < needs.treesMin) return null;
  if (needs.treesMax !== undefined && s.trees > needs.treesMax) return null;
  if (needs.naturalMin !== undefined && s.natural < needs.naturalMin) return null;
  let share = 1;
  if (needs.biomes) {
    share = Object.entries(s.biomes).filter(([b]) => needs.biomes.any.some((k) => b.includes(k))).reduce((a, [, v]) => a + v, 0) / 100;
    if (share < needs.biomes.share) return null;
  }
  // prefer the target relief's middle, the biome share, and natural land
  const mid = needs.relief ? (needs.relief[0] + needs.relief[1]) / 2 : relief;
  return Math.round((share * 100 - Math.abs(relief - mid) + (s.natural ?? 100) / 10) * 100) / 100;
}

/** Candidate claim origins: a square spiral of steps of `step` around (0, 0). */
export function candidates(n, step) {
  const out = [[0, 0]];
  let x = 0, z = 0, len = 1, dir = 0;
  const D = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  while (out.length < n) {
    for (let r = 0; r < 2 && out.length < n; r++) {
      for (let i = 0; i < len && out.length < n; i++) { x += D[dir][0]; z += D[dir][1]; out.push([x * step, z * step]); }
      dir = (dir + 1) % 4;
    }
    len++;
  }
  return out;
}

/**
 * Find and pin a site. `io` = {call, cmd, tp, log} from tools/lib/run6b.mjs (a client in a world of the pinned seed).
 * Returns {claim, score, tried, summary, surveySha}.
 */
export async function findSite(id, io) {
  const file = scenarioFile(id);
  const sc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const needs = sc.needs;
  const [w, d] = needs.size;
  let best = null, tried = 0;
  const [c0x, c0z] = needs.center ?? [0, 0]; // (a spiral round another point: where an earlier search saw the biome)
  for (const [ox0, oz0] of candidates(needs.candidates ?? 30, needs.step ?? 448)) {
    const ox = ox0 + c0x, oz = oz0 + c0z;
    tried++;
    const x0 = ox - Math.floor(w / 2), z0 = oz - Math.floor(d / 2), x1 = x0 + w - 1, z1 = z0 + d - 1;
    await io.tp(ox + 0.5, 220, oz + 0.5);
    const r = await io.cmd(`/apitest survey ${x0} ${z0} ${x1} ${z1} 4 bounded:64`);
    const key = (r.messages ?? []).find((m) => m.startsWith('{'));
    let sample = key ? JSON.parse(key) : null;
    if (sample?.pending) {
      for (let i = 0; i < 600; i++) {
        const g = await io.cmd(`/apitest get ${sample.pending}`);
        const line = (g.messages ?? []).find((m) => m.startsWith('{'));
        const v = line ? JSON.parse(line) : null;
        if (v?.value) { sample = v.value; break; }
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
    if (!sample?.summary) { io.log(`  ${id}: candidate ${x0},${z0}: no survey`); continue; }
    const s = parseSummary(sample.summary);
    const sc0 = score(s, needs);
    io.log(`  ${id}: candidate ${x0},${z0} relief ${s.max - s.min}, water ${s.water}%, trees ${s.trees}%, natural ${s.natural}%, biomes ${JSON.stringify(s.biomes)} -> ${sc0}`);
    if (sc0 !== null && (!best || sc0 > best.score)) best = { claim: [x0, z0, x1, z1], score: sc0, summary: sample.summary, stats: s };
    if (best && needs.stopAt !== undefined && best.score >= needs.stopAt) break;
  }
  if (!best) return { claim: null, tried };
  const surveySha = crypto.createHash('sha256').update(best.summary).digest('hex');
  const y = [Math.max(-64, best.stats.min - 40), Math.min(319, Math.max(best.stats.max + 40, needs.yTop ?? 0))];
  sc.fixture = { ...(sc.fixture ?? {}), claim: best.claim, yRange: y, foundBy: `find-site ${id} @ seed ${sc.world?.seed}`, surveySha, score: best.score, stats: best.stats };
  fs.writeFileSync(file, `${JSON.stringify(sc, null, 2)}\n`);
  return { claim: best.claim, score: best.score, tried, surveySha };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lib = await import('./lib/run6b.mjs');
  await lib.connect();
  const r = await findSite(process.argv[2], { call: lib.call, cmd: lib.cmd, tp: lib.tp, log: lib.log });
  console.log(JSON.stringify(r));
  lib.state.dev?.close();
}
