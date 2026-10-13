// 6c PT gate item 12: a dedicated server of the same Minecraft and Fabric API but WITHOUT Architect (nor devserver, apitest or lab-ui),
// started on a copy of a world to see what becomes of the chunks' `architect_mc:placed` attachment. Built from the headless launch
// (mod/build/headless-launch*.json): the mod's own class dirs and jars leave the classpath, and the dev launch config loses its class
// path groups. Commands go to the server's console (stdin). Its game port is used for nothing (port 0: the system picks a free one).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Starts the server in `gameDir` (it holds saves/<world>) and returns {send(cmd), waitFor(re, ms), stop(), log()}. `root`: the checkout
 * whose mod/build/headless-launch*.json is used. `eula`: Noah's own acceptance file (copied, as the headless host does).
 */
export async function startNoMod({ root, gameDir, world, port = 8915, eula, logFile }) {
  const modDir = path.join(root, 'mod');
  const lf = ['headless-launch-noapitest.json', 'headless-launch.json'].map((f) => path.join(modDir, 'build', f)).find((f) => fs.existsSync(f));
  if (!lf) throw new Error('no mod/build/headless-launch*.json (run a headless server once)');
  const launch = JSON.parse(fs.readFileSync(lf, 'utf8'));
  const ours = (p) => p.startsWith(path.join(root, 'mod', 'build')) || p.startsWith(path.join(root, 'devserver')) || p.startsWith(path.join(root, 'apitest'))
    || /lab[_-]ui/.test(path.basename(p)) || /architect_(mc|devserver|apitest)/.test(path.basename(p));
  const classpath = launch.classpath.filter((p) => !ours(p));
  const removed = launch.classpath.filter(ours);
  // the dev launch config without the class path groups (they name the mod's dirs)
  const cfgArg = launch.jvmArgs.find((a) => a.startsWith('-Dfabric.dli.config='));
  const cfgIn = cfgArg.slice('-Dfabric.dli.config='.length);
  const cfgOut = path.join(gameDir, 'nomod-launch.cfg');
  const cfg = fs.readFileSync(cfgIn, 'utf8').split('\n').filter((l) => !/^\s*fabric\.classPathGroups=/.test(l)).join('\n');
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(cfgOut, cfg);
  const jvmArgs = launch.jvmArgs.filter((a) => !a.startsWith('@')).map((a) => (a === cfgArg ? `-Dfabric.dli.config=${cfgOut}` : a));
  if (!/^\s*eula\s*=\s*true\s*$/m.test(fs.readFileSync(eula, 'utf8'))) throw new Error(`no accepted EULA at ${eula}`);
  fs.copyFileSync(eula, path.join(gameDir, 'eula.txt'));
  fs.writeFileSync(path.join(gameDir, 'server.properties'), [
    '# 6c PT item 12: a server without Architect', 'online-mode=false', 'server-ip=127.0.0.1', `server-port=${port}`, `level-name=${world}`,
    'enable-rcon=false', 'enable-query=false', 'enable-status=false', 'sync-chunk-writes=true', 'max-tick-time=-1', 'spawn-protection=0',
    'pause-when-empty-seconds=0', 'view-distance=4', 'simulation-distance=4', ''].join('\n'));
  fs.rmSync(path.join(gameDir, 'saves', world, 'session.lock'), { force: true });
  const out = [];
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE)/.test(k) || /^ARCHITECT_/.test(k)) delete env[k];
  const proc = spawn(launch.java, ['-Xmx2G', ...jvmArgs, '-cp', classpath.join(path.delimiter), launch.mainClass, '--nogui', '--universe', 'saves', '--world',
    world], { cwd: gameDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const onData = (b) => {
    const t = b.toString();
    out.push(t);
    if (logFile) fs.appendFileSync(logFile, t);
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const exited = new Promise((r) => proc.on('exit', (code, sig) => r({ code, sig })));
  const text = () => out.join('');
  const waitFor = async (re, ms = 300_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (re.test(text())) return true;
      if (proc.exitCode !== null) throw new Error(`the no-mod server exited (${proc.exitCode}):\n${text().slice(-3000)}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`timed out waiting for ${re} from the no-mod server:\n${text().slice(-3000)}`);
  };
  const send = (cmd) => proc.stdin.write(`${cmd}\n`);
  return {
    pid: proc.pid, removed, classpath: classpath.length, send, waitFor, log: text,
    async stop() {
      if (proc.exitCode === null) send('stop');
      const r = await Promise.race([exited, new Promise((res) => setTimeout(() => res(null), 120_000))]);
      if (r === null && proc.exitCode === null) {
        proc.kill('SIGTERM'); // our own pid only
        await exited;
      }
      return text();
    },
  };
}

/**
 * A chunk's NBT read straight from its region file (`<world>/region/r.<rx>.<rz>.mca`; zlib, gzip or raw), as plain objects
 * (kit/lib/nbt.mjs); null when the chunk is not in the file.
 */
export async function readChunk(worldDir, cx, cz) {
  const zlib = await import('node:zlib');
  const { decode, plain } = await import('../../kit/lib/nbt.mjs');
  // 26.x keeps the overworld's regions under dimensions/minecraft/overworld/region (older worlds: region/)
  const dims = path.join(worldDir, 'dimensions', 'minecraft', 'overworld', 'region');
  const f = path.join(fs.existsSync(dims) ? dims : path.join(worldDir, 'region'), `r.${cx >> 5}.${cz >> 5}.mca`);
  if (!fs.existsSync(f)) return null;
  const b = fs.readFileSync(f);
  const i = ((cx & 31) + (cz & 31) * 32) * 4;
  const off = (b[i] << 16 | b[i + 1] << 8 | b[i + 2]) * 4096;
  if (!off) return null;
  const len = b.readUInt32BE(off);
  const kind = b[off + 4];
  const data = b.subarray(off + 5, off + 4 + len);
  const raw = kind === 2 ? zlib.inflateSync(data) : kind === 1 ? zlib.gunzipSync(data) : kind === 3 ? data : null;
  if (!raw) throw new Error(`chunk ${cx}, ${cz}: compression ${kind} is not read here`);
  return plain(decode(raw));
}

/** The chunk's `fabric:attachments` keys (empty when it has none). */
export function attachmentKeys(chunk) {
  return Object.keys(chunk?.['fabric:attachments'] ?? {}).sort();
}
