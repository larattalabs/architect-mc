#!/usr/bin/env node
// Scene screenshot runner: drives the DevBridge through a list of shots and writes PNGs (the mod writes them to
// <repo>/artifacts/shots/, or ARCHITECT_SHOTS_DIR). The game must be running (gradlew runClient).
// Slim port of AgentCraft's tools/shoot.mjs (MIT).
//
//   node tools/shoot.mjs scene.json [--only a,b] [--port N] [--manifest out.json] [--prefix p/] [--release]
//
// Scene: {"setup": ["/time set 6000", ...], "shots": [{"name", "camera": {x,y,z,yaw,pitch | lookAt:{x,y,z}, fov?},
//   "commands"?: [...], "ui"?: "design"|"library"|"designs"|"status" (opens the Architect screen), "uiClicks"?: [ids],
//   "screen"?: name|null, "hideHud"?: true, "frames"?: 3, "delayMs"?: 0, "waitChunks"?: true}]} or a bare array of shots.
// Prints a JSON summary; exit code 1 if a shot failed.

import fs from 'node:fs';
import { DevClient, DEFAULT_PORT } from './lib/devclient.mjs';

const argv = process.argv.slice(2);
let sceneFile = null;
let only = null;
let port = DEFAULT_PORT;
let manifest = null;
let prefix = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--only') only = new Set(argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
  else if (a === '--port') port = Number(argv[++i]);
  else if (a === '--manifest') manifest = argv[++i];
  else if (a === '--prefix') prefix = argv[++i];
  else if (!a.startsWith('--') && !sceneFile) sceneFile = a;
}
if (!sceneFile) {
  console.error('usage: node tools/shoot.mjs <scene.json> [--only a,b] [--port N] [--manifest out.json] [--prefix p/] [--release]');
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(sceneFile, 'utf8'));
const scene = Array.isArray(raw) ? { shots: raw } : raw;
const log = (m) => process.stderr.write(`[shoot] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dev = await DevClient.connect({ port, timeoutMs: 120_000, onWait: (ms) => log(`waiting for DevBridge (${Math.round(ms / 1000)}s)...`) });
await dev.waitInWorld({ timeoutMs: 300_000 });
const results = [];
try {
  for (const cmd of scene.setup ?? []) await dev.call('dev.command', { cmd });
  for (const shot of scene.shots ?? []) {
    if (only && !only.has(shot.name)) continue;
    const r = { name: prefix + shot.name, ok: false };
    try {
      for (const cmd of shot.commands ?? []) await dev.call('dev.command', { cmd });
      if (shot.camera) await dev.call('dev.camera', { mode: 'keep', ...shot.camera });
      if (shot.ui) await dev.call('dev.ui.open', { tab: shot.ui });
      for (const id of shot.uiClicks ?? []) await dev.call('dev.ui.click', { control: id });
      if (shot.screen !== undefined) await dev.call('dev.screen', { open: shot.screen });
      if (shot.delayMs) await sleep(shot.delayMs);
      const res = await dev.call('dev.screenshot', {
        name: prefix + shot.name, hideHud: shot.hideHud ?? !shot.ui, frames: shot.frames ?? 3, waitChunks: shot.waitChunks ?? true,
      });
      Object.assign(r, { ok: true, path: res.path, width: res.width, height: res.height });
      if (shot.ui) await dev.call('dev.screen', { open: null });
    } catch (e) {
      r.error = e.message;
      if ((await dev.health()).stalled) { r.hung = true; results.push(r); break; }
    }
    log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.error ? ': ' + r.error : ''}`);
    results.push(r);
  }
  if (argv.includes('--release')) await dev.request('dev.release', {}).catch(() => {});
} finally {
  dev.close();
}
const summary = { ok: results.every((r) => r.ok), scene: sceneFile, shots: results };
if (manifest) fs.writeFileSync(manifest, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
