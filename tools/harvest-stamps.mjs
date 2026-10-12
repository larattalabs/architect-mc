#!/usr/bin/env node
// Harvest the stamp library (docs/CONTRACT.md 6c F2 §4; SETTLEMENTS §9.4) from the player's own game, through the DevBridge hook
// dev.feature.stamp: each library feature placed in a scratch superflat world at a fixed spot over its ground template, the cells it
// wrote captured as <dir>/<feature>/<seed>.bin. Local-only (Noah, N-F2-1): the default dir is the game's architect/stamps, never
// kit/stamps in the repo or the jar. $0: no Claude call.
//
//   node tools/harvest-stamps.mjs [--dir <dir>] [--seeds 8] [--only oak,birch] [--twice] [--out <file.json>]
//
// The connected game (ARCHITECT_DEV_PORT; a dev client or tools/run-headless-server.mjs) must be in a superflat world: the hook
// rewrites the box at the spot and refuses any other world. `--twice` harvests every stamp a second time into a temp dir and compares
// the bytes (gate item 6: re-harvesting on the same version gives the same bytes). Exit 0 when every stamp was placed (and, with
// --twice, every pair is byte-identical); 1 otherwise.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DevClient } from './lib/devclient.mjs';
import { LIBRARY, SEEDS } from './lib/stamp-library.mjs';


const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE)/.test(k)) delete process.env[k];

const nSeeds = Number(opt('seeds', SEEDS));
const only = opt('only') ? String(opt('only')).split(',').map((s) => (s.includes(':') ? s : `minecraft:${s}`)) : null;
const lib = LIBRARY.filter((e) => !only || only.includes(e.feature));
const seeds = Array.from({ length: nSeeds }, (_, i) => i + 1);
const dir = opt('dir') ? path.resolve(String(opt('dir'))) : null;
const sha = (b) => createHash('sha256').update(b).digest('hex');

const dev = await DevClient.connect({ timeoutMs: 120_000 });
const out = { at: new Date().toISOString(), seeds, features: [] };
let bad = 0;
try {
  await dev.call('dev.camera', { x: 8.5, y: -40, z: 8.5, yaw: 0, pitch: 30 }).catch(() => null);
  const tmp = opt('twice') ? fs.mkdtempSync(path.join(os.tmpdir(), 'stamps-twice-')) : null;
  for (const e of lib) {
    const r = await dev.call('dev.feature.stamp', { feature: e.feature, seeds, ground: e.ground, ...(dir ? { dir } : {}) }, 600_000);
    const row = { feature: e.feature, ground: e.ground, dir: r.dir, minecraft: r.minecraft, stamps: r.stamps };
    for (const s of r.stamps) {
      if (!s.placed || !s.cells) { bad++; console.log(`FAIL ${e.feature} seed ${s.seed}: placed ${s.placed}, ${s.cells} cells`); }
      else console.log(`ok   ${e.feature} seed ${s.seed}: ${s.cells} cells, size ${s.size.join('x')}, root ${s.root.join(',')}, palette ${s.palette}${s.blockEntities ? `, ${s.blockEntities} block-entity cells left out` : ''}${s.edge ? `, ${s.edge} cells on the box edge` : ''}`);
    }
    if (tmp) {
      const r2 = await dev.call('dev.feature.stamp', { feature: e.feature, seeds, ground: e.ground, dir: tmp }, 600_000);
      row.twice = r2.stamps.map((s2) => {
        const s1 = r.stamps.find((x) => x.seed === s2.seed);
        if (!s1?.file || !s2.file) return { seed: s2.seed, same: !s1?.file && !s2.file };
        const a = fs.readFileSync(s1.file), b = fs.readFileSync(s2.file);
        const same = Buffer.compare(a, b) === 0;
        if (!same) bad++;
        console.log(`${same ? 'ok  ' : 'FAIL'} re-harvest ${e.feature} seed ${s2.seed}: ${same ? 'the same bytes' : 'DIFFERENT bytes'} (${sha(a).slice(0, 12)} / ${sha(b).slice(0, 12)})`);
        return { seed: s2.seed, same, sha: sha(a), sha2: sha(b), bytes: a.length };
      });
    }
    out.features.push(row);
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
} finally {
  dev.close();
}
out.failures = bad;
if (opt('out')) fs.writeFileSync(path.resolve(String(opt('out'))), `${JSON.stringify(out, null, 2)}\n`);
console.log(`harvest: ${out.features.reduce((a, f) => a + f.stamps.filter((s) => s.placed && s.cells).length, 0)} stamps over ${lib.length} features; ${bad} failure(s)`);
process.exit(bad ? 1 : 0);
