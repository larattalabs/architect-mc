// Shared helpers for the generators: find (or download) the 26.3 jars, find Java 25, read entries from a jar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

export const MC_VERSION = '26.3';
const HOME = os.homedir();

/** Where a previous Loom build may have cached the jars (first hit wins). */
const LOOM_DIRS = [
  path.join(HOME, '.gradle/caches/fabric-loom', MC_VERSION),
  path.join(HOME, 'Developer/agentcraft/.gradle-home/caches/fabric-loom', MC_VERSION),
];

/** The working dir for generator scratch (jar extraction, reports). Outside the repo. */
export function workDir(arg) {
  const d = arg ?? path.join(os.tmpdir(), `architect-gen-${MC_VERSION}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Parse `--key value` / `--flag` arguments. */
export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o[k] = argv[++i];
    else o[k] = true;
  }
  return o;
}

async function download(kind, dest) {
  const manifest = await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json();
  const v = manifest.versions.find((q) => q.id === MC_VERSION);
  if (!v) throw new Error(`version ${MC_VERSION} not in Mojang's manifest`);
  const meta = await (await fetch(v.url)).json();
  const url = meta.downloads?.[kind]?.url;
  if (!url) throw new Error(`no ${kind} download for ${MC_VERSION}`);
  console.error(`downloading ${url}`);
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

/**
 * The vanilla server (bundler) or client jar: `--server-jar` / `--client-jar`, the Loom caches, else a download from
 * Mojang's piston-meta into the work dir.
 */
export async function findJar(kind, explicit, work) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`no such jar: ${explicit}`);
    return explicit;
  }
  const name = kind === 'server' ? 'minecraft-server.jar' : 'minecraft-client.jar';
  for (const d of LOOM_DIRS) if (fs.existsSync(path.join(d, name))) return path.join(d, name);
  const dest = path.join(work, `${kind}-${MC_VERSION}.jar`);
  if (fs.existsSync(dest)) return dest;
  return download(kind, dest);
}

/** A Java >= 25 binary: `--java`, $JAVA, Homebrew openjdk@25, $JAVA_HOME, else `java` on PATH. */
export function findJava(explicit) {
  const cands = [explicit, process.env.JAVA, '/opt/homebrew/opt/openjdk@25/bin/java', '/usr/local/opt/openjdk@25/bin/java',
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin/java'), 'java'].filter(Boolean);
  for (const c of cands) {
    try {
      const out = execFileSync(c, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      void out;
      return c;
    } catch (e) {
      if (e.stderr && /version "(\d+)/.test(e.stderr) && Number(/version "(\d+)/.exec(e.stderr)[1]) >= 25) return c;
      if (e.status === 0) return c;
    }
  }
  throw new Error('no Java 25 found (pass --java or set JAVA)');
}

/** Minimal zip reader: { names(), read(name) -> Buffer | null }. Stored and deflated entries only. */
export function openZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error(`${file}: not a zip`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${file}: bad central directory`);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    entries.set(name, { method, csize, off });
    p += 46 + nlen + xlen + clen;
  }
  return {
    names: () => [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const lnl = buf.readUInt16LE(e.off + 26);
      const lxl = buf.readUInt16LE(e.off + 28);
      const start = e.off + 30 + lnl + lxl;
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) return zlib.inflateRawSync(data);
      throw new Error(`${name}: unsupported zip method ${e.method}`);
    },
  };
}
