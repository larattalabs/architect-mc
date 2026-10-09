#!/usr/bin/env node
// node kit/tools/gen-blocks.mjs [--server-jar <jar>] [--java <bin>] [--work <dir>] [--reuse] [--dump-only]
//
// Generates kit/lib/blocks.mjs from vanilla 26.3:
//   1. the data generator report (`java -DbundlerMainClass=net.minecraft.data.Main -jar server.jar --reports`):
//      reports/blocks.json = every block, its property domains and its default state;
//   2. kit/tools/BlockDump.java run against the (unobfuscated) server classes: the block's Java class chain (its
//      family), the default state's collision boxes, light emission per state, light dampening, shape occlusion,
//      redstone conductivity, the block's item.
// The collision class, light behaviour and support rule are derived per block family (see `classify`). The API
// (normalize, qualify, ...) comes from kit/tools/blocks.template.mjs; the data replaces its DATA marker.
// The jars are never copied into the repo: they come from the Loom cache or Mojang (see mcjar.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MC_VERSION, findJar, findJava, openZip, parseArgs, workDir } from './mcjar.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../lib/blocks.mjs');
const TEMPLATE = path.join(HERE, 'blocks.template.mjs');
const VOXEL_OUT = path.resolve(HERE, '../voxel_classes.json');

/**
 * (6b) Every vanilla block tag, resolved (`#minecraft:x` references expanded): {tag: [blockId...]}, read from the
 * server jar's built-in data pack (BlockDump runs without data packs, so its BlockState.is(tag) is always false).
 */
export function readBlockTags(serverClassesJar) {
  const zip = openZip(serverClassesJar);
  const raw = {};
  const pre = 'data/minecraft/tags/block/';
  for (const n of zip.names()) {
    if (!n.startsWith(pre) || !n.endsWith('.json')) continue;
    raw[`minecraft:${n.slice(pre.length, -5)}`] = JSON.parse(zip.read(n).toString('utf8')).values.map((v) => (typeof v === 'string' ? v : v.id));
  }
  const out = {};
  const resolve = (t, seen = new Set()) => {
    if (out[t]) return out[t];
    if (seen.has(t)) throw new Error(`tag cycle at ${t}`);
    seen.add(t);
    const set = new Set();
    for (const v of raw[t] ?? []) {
      if (v.startsWith('#')) for (const x of resolve(v.slice(1), seen)) set.add(x);
      else set.add(v.includes(':') ? v : `minecraft:${v}`);
    }
    return (out[t] = [...set].sort());
  };
  for (const t of Object.keys(raw).sort()) resolve(t);
  return out;
}

function listJars(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJars(p));
    else if (e.name.endsWith('.jar')) out.push(p);
  }
  return out;
}

/** Run the report generator + the dumper in `work`; returns { report, dump }. */
export async function collect(o = {}) {
  const work = workDir(o.work);
  const reportPath = path.join(work, 'generated/reports/blocks.json');
  const dumpPath = path.join(work, 'blockdump.json');
  if (!(o.reuse && fs.existsSync(reportPath) && fs.existsSync(dumpPath))) {
    const jar = await findJar('server', o['server-jar'], work);
    const java = findJava(o.java);
    const local = path.join(work, 'server.jar');
    fs.copyFileSync(jar, local);
    console.error(`reports: ${jar} (java ${java})`);
    execFileSync(java, ['-DbundlerMainClass=net.minecraft.data.Main', '-jar', 'server.jar', '--reports'], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] });
    const serverClasses = path.join(work, 'versions', MC_VERSION, `server-${MC_VERSION}.jar`);
    const cp = [serverClasses, ...listJars(path.join(work, 'libraries'))].join(path.delimiter);
    console.error('dump: BlockDump.java');
    execFileSync(java, ['-cp', cp, path.join(HERE, 'BlockDump.java'), dumpPath], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  const tags = readBlockTags(path.join(work, 'versions', MC_VERSION, `server-${MC_VERSION}.jar`));
  return { report: JSON.parse(fs.readFileSync(reportPath, 'utf8')), dump: JSON.parse(fs.readFileSync(dumpPath, 'utf8')), tags, work };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const { report, dump, tags, work } = await collect(o);
  console.error(`${Object.keys(report).length} blocks in the report, ${Object.keys(dump).length} dumped (work dir ${work})`);
  if (o['dump-only']) return;
  const { generate, voxelClasses } = await import('./classify.mjs');
  const src = generate(report, dump, fs.readFileSync(TEMPLATE, 'utf8'), tags);
  fs.writeFileSync(OUT, src);
  const vc = voxelClasses(report, dump, tags);
  fs.writeFileSync(VOXEL_OUT, `${JSON.stringify(vc, null, 1)}\n`);
  console.error(`wrote ${path.relative(process.cwd(), VOXEL_OUT)} (${Object.keys(vc.blocks).length} natural blocks)`);
  console.error(`wrote ${path.relative(process.cwd(), OUT)} (${(src.length / 1024).toFixed(0)} KB)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
