// The headless gate host (docs/GATES.md "Headless gates"): one dedicated Minecraft server per world, behind the DevBridge's
// WebSocket, so the gate drivers (tools/gate*.mjs, apitest.mjs, scenarios.mjs) talk to it exactly as to a dev client.
//
// It owns the DevBridge port (ARCHITECT_DEV_PORT) and the token file (<gameDir>/architect/devbridge.token) for its whole life.
// The server JVM (Loom's runServer command, resolved once by `gradlew headlessLaunch`, then started directly) runs the
// devserver mod: a line-JSON bridge on a Unix socket (no TCP port), a bot player and the sidecar link. Requests go through to
// it; the host itself answers what a client's title screen would:
//   dev.world.open {name, mode?, preset?, seed?, cheats?}  open that world (created when missing, as AutoWorld)
//   dev.world.leave                                         save and stop the world (the "title screen": restore worlds now)
//   dev.quit                                                save, stop, exit (the sidecar exits with this process: its parent)
//   dev.state / dev.ping / dev.help                         also while no server process runs ({inWorld: false})
// Worlds switch inside one server process, as a client's integrated server does (the devserver's DevServer.openWorld runs
// the dedicated server's Main again; its KeepExecutorsMixin keeps the shared executors): a switch costs a world load, not a
// JVM start. A server process that dies (a crash test's halt) is started again by the next dev.world.open.
//
// The EULA: the server only starts when Noah's own acceptance file exists (ARCHITECT_SERVER_EULA, default
// ~/Developer/_infra/minecraft-server/eula.txt, `eula=true`); it is copied into the run dir. Agents never write one.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { listen } from './wsserver.mjs';
import zlib from 'node:zlib';
import { decode as decodeNbt, plain as plainNbt } from '../../kit/lib/nbt.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

export const DEFAULT_EULA = path.join(os.homedir(), 'Developer', '_infra', 'minecraft-server', 'eula.txt');

/** The flat meadow of AutoWorld (client): bedrock, 124 stone, 3 dirt, grass at y=64, plains, no features or structures. */
const FLAT_SETTINGS = JSON.stringify({
  layers: [{ block: 'minecraft:bedrock', height: 1 }, { block: 'minecraft:stone', height: 124 }, { block: 'minecraft:dirt', height: 3 },
    { block: 'minecraft:grass_block', height: 1 }],
  biome: 'minecraft:plains', features: false, lakes: false, structure_overrides: [],
});

/** AutoWorldSpec.from for the dev.world.open fields (and the ARCHITECT_AUTOWORLD_* environment). */
export function worldSpec(raw) {
  const name = (raw.name ?? '').trim() || 'Architect Dev';
  if (name.length > 64 || name.startsWith('.') || /[/\\:*?"<>|]/.test(name) || /[ .]$/.test(name)) throw new Error(`bad world name: ${name}`);
  const p = (raw.preset ?? 'normal').trim().toLowerCase();
  const preset = ['', 'flat', 'superflat'].includes(p) ? 'flat' : ['normal', 'natural', 'default'].includes(p) ? 'normal' : null;
  if (!preset) throw new Error(`preset must be flat or normal: ${raw.preset}`);
  const m = (raw.mode ?? '').trim().toLowerCase();
  const mode = ['', 'creative'].includes(m) ? 'creative' : m === 'survival' ? 'survival' : m === 'hardcore' ? 'hardcore' : null;
  if (!mode) throw new Error(`mode must be creative, survival or hardcore: ${raw.mode}`);
  // level-seed is parsed as AutoWorldSpec.parseSeed does (a long, else String.hashCode)
  const seed = (raw.seed ?? '').toString().trim() || (preset === 'flat' ? 'architect-dev' : '2026');
  const c = raw.cheats === undefined || raw.cheats === null || raw.cheats === '' ? null : String(raw.cheats).toLowerCase();
  const cheats = c === null ? mode !== 'hardcore' : ['1', 'true', 'on', 'yes'].includes(c);
  return { name, preset, mode, seed, cheats };
}

/**
 * (housekeeping 3) An existing world's game mode from its level.dat (Data.GameType 1: creative, else survival; hardcore 1 in
 * Data.difficulty_settings, or Data itself: hardcore), or null when there is no world (a new one takes the spec's) or it can't be read.
 */
export function levelMode(worldDir) {
  const f = path.join(worldDir, 'level.dat');
  if (!fs.existsSync(f)) return null;
  try {
    const raw = fs.readFileSync(f);
    const b = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
    const d = plainNbt(decodeNbt(b)).Data ?? {};
    // (26.3 keeps the flag in difficulty_settings; older level.dat files at the top of Data)
    if (Number(d.difficulty_settings?.hardcore ?? d.hardcore ?? 0) === 1) return 'hardcore';
    return Number(d.GameType ?? 0) === 1 ? 'creative' : 'survival';
  } catch {
    return null;
  }
}

function serverProperties(spec, o) {
  const props = {
    'online-mode': 'false', 'server-ip': '127.0.0.1', 'server-port': String(o.gamePort),
    'level-name': spec.name, 'level-seed': spec.seed, 'level-type': spec.preset === 'flat' ? 'minecraft\\:flat' : 'minecraft\\:normal',
    'generator-settings': spec.preset === 'flat' ? FLAT_SETTINGS.replace(/:/g, '\\:') : '{}',
    gamemode: spec.mode === 'creative' ? 'creative' : 'survival', hardcore: String(spec.mode === 'hardcore'),
    difficulty: spec.mode === 'hardcore' ? 'hard' : 'peaceful',
    // the dev client's integrated server: render distance 16 (view distance), simulation distance 10, no sync writes on macOS
    'view-distance': String(o.viewDistance), 'simulation-distance': String(o.simulationDistance), 'sync-chunk-writes': 'false',
    'pause-when-empty-seconds': '0',
    // no watchdog: an integrated server has none, and a long hook (a 1000x1000 dev.region.hash) runs on the server thread
    'max-tick-time': '-1', 'spawn-protection': '0', 'max-players': '4', 'enable-command-block': 'true', 'allow-flight': 'true',
    'enable-query': 'false', 'enable-rcon': 'false', 'enable-status': 'false', 'white-list': 'false', 'enforce-secure-profile': 'false',
    motd: 'Architect headless gate server', 'op-permission-level': '4', 'function-permission-level': '2', 'log-ips': 'false',
  };
  return `# written by tools/lib/server-host.mjs for "${spec.name}"\n${Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

/**
 * Runs the host until dev.quit (or a signal). opts: root (the checkout the server runs from), devPort, sidecarPort, sidecar
 * ('stub' | 'sim'), apitest (bool), world ({name, mode, preset, seed, cheats}), xmx, eula, env (extra JVM environment).
 */
export async function runHost(opts) {
  const root = opts.root;
  const modDir = path.join(root, 'mod');
  const gameDir = path.join(modDir, 'run');
  const log = (...a) => console.log(`[${stamp()}] [headless] ${a.join(' ')}`);
  const eula = opts.eula ?? process.env.ARCHITECT_SERVER_EULA ?? DEFAULT_EULA;
  let eulaText = '';
  try {
    eulaText = fs.readFileSync(eula, 'utf8');
  } catch {
    // refused below
  }
  if (!/^\s*eula\s*=\s*true\s*$/m.test(eulaText)) {
    throw new Error(`no accepted Minecraft EULA at ${eula}: a dedicated server needs eula=true there, written by Noah himself (agents never write it)`);
  }
  fs.mkdirSync(path.join(gameDir, 'architect'), { recursive: true });
  fs.copyFileSync(eula, path.join(gameDir, 'eula.txt'));

  // 1. the server's java command (compiles the run checkout's HEAD, as a client script's runClient does)
  const launchFile = path.join(modDir, 'build', opts.apitest ? 'headless-launch.json' : 'headless-launch-noapitest.json');
  const gradleEnv = { ...process.env, ARCHITECT_HEADLESS: '1', ARCHITECT_APITEST: opts.apitest ? '1' : '0',
    JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.join(root, '.gradle-home') };
  const t0 = Date.now();
  log(`gradlew headlessLaunch (apitest ${opts.apitest ? 'on' : 'off'})`);
  const g = spawnSync('./gradlew', ['--offline', '--no-daemon', '-q', 'headlessLaunch'], { cwd: modDir, env: gradleEnv, stdio: 'inherit' });
  if (g.status !== 0) throw new Error(`gradlew headlessLaunch failed (${g.status})`);
  const launch = JSON.parse(fs.readFileSync(launchFile, 'utf8'));
  log(`launch resolved in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // 2. the token: the drivers read it from the game dir, the JVM gets it in its environment
  const token = crypto.randomBytes(32).toString('hex');
  const tokenFile = path.join(gameDir, 'architect', 'devbridge.token');
  fs.rmSync(tokenFile, { force: true });
  fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });

  const viewDistance = Number(process.env.ARCHITECT_BOT_VIEW_DISTANCE || 16);
  const simulationDistance = Number(process.env.ARCHITECT_SIMULATION_DISTANCE || 10);
  // the JVM's line bridge: a Unix socket (no TCP port); macOS caps socket paths near 104 bytes
  let socketPath = path.join(gameDir, 'architect', 'devserver.sock');
  if (Buffer.byteLength(socketPath) > 100) socketPath = path.join(os.tmpdir(), `architect-devserver-${process.pid}.sock`);

  // ---------------------------------------------------------------- the server process
  let jvm = null; // { proc, sock, pending: Map, spec, startedAt, up, expectedExit, exited: Promise }
  let quitting = false;
  let nextId = 1;
  const stats = { starts: 0, opens: 0, lastStopMs: null };

  function writeProperties(spec) {
    // (housekeeping 3) an existing world opens in its own game mode, as a client's AutoWorld opens it: the dedicated server takes its
    // default game type from server.properties, so a survival world opened by name alone (the host's creative launch world's spec)
    // ran with a creative default and AUTO placed an INSTANT road where the client builds a construction road (y-ingame `once`)
    const own = levelMode(path.join(gameDir, 'saves', spec.name));
    // the devserver mod opens no game port (NoTcpListenerMixin): this number is never bound
    fs.writeFileSync(path.join(gameDir, 'server.properties'), serverProperties(own ? { ...spec, mode: own } : spec, { gamePort: 25565, viewDistance, simulationDistance }));
    fs.rmSync(path.join(gameDir, 'saves', spec.name, 'session.lock'), { force: true });
  }

  /** Opens a world: in the running server process (a switch, as a client's), else in a new one. */
  async function openWorld(spec) {
    if (jvm?.sock) {
      writeProperties(spec);
      stats.opens++;
      const r = await ask('dev.host.open', { world: spec.name }, 30_000);
      if (!r.ok) throw new Error(r.error);
      log(`opening "${spec.name}" in server pid ${jvm.proc.pid} (${spec.mode}, ${spec.preset})`);
      return;
    }
    if (jvm) throw new Error('the headless server is still starting');
    await startServer(spec);
  }

  async function startServer(spec) {
    if (jvm) throw new Error('already in a world (dev.world.leave first)');
    writeProperties(spec);
    stats.opens++;
    fs.rmSync(socketPath, { force: true });
    const jvmArgs = launch.jvmArgs.filter((a) => !a.startsWith('@'));
    const args = [`-Xmx${opts.xmx ?? process.env.ARCHITECT_XMX ?? '4G'}`, ...jvmArgs, '-cp', launch.classpath.join(path.delimiter), launch.mainClass,
      '--nogui', '--universe', 'saves', '--world', spec.name];
    const env = { ...process.env, ...(opts.env ?? {}), ARCHITECT_HEADLESS: '1', ARCHITECT_DEV_TOKEN: token, ARCHITECT_DEVSERVER_SOCKET: socketPath,
      ARCHITECT_HOST_PID: String(process.pid), ARCHITECT_PORT: String(opts.sidecarPort),
      ARCHITECT_NODE: process.execPath, ARCHITECT_BOT_VIEW_DISTANCE: String(viewDistance) };
    for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE)/.test(k) || k === 'AWS_BEARER_TOKEN_BEDROCK') delete env[k];
    const started = Date.now();
    const proc = spawn(launch.java, args, { cwd: gameDir, env, stdio: ['pipe', 'inherit', 'inherit'] });
    stats.starts++;
    const me = { proc, sock: null, pending: new Map(), spec, startedAt: started, up: false, expectedExit: false, readyAt: null };
    me.exited = new Promise((resolve) => proc.on('exit', (code, sig) => resolve({ code, sig })));
    jvm = me;
    log(`server pid ${proc.pid} starting "${spec.name}" (${spec.mode}, ${spec.preset}; no game port)`);
    me.exited.then(({ code, sig }) => {
      for (const [, p] of me.pending) p.reply({ ok: false, error: 'the headless server exited' });
      me.pending.clear();
      if (jvm === me) jvm = null;
      log(`server pid ${proc.pid} exited (${sig ?? code})${me.expectedExit ? '' : ' UNEXPECTEDLY'}`);
    });
    // connect the line bridge once it listens
    (async () => {
      while (jvm === me) {
        if (fs.existsSync(socketPath)) {
          try {
            await connectJvm(me, socketPath);
            log(`server bridge up after ${((Date.now() - started) / 1000).toFixed(1)} s`);
            return;
          } catch (e) {
            log(`server bridge connect failed: ${e.message}`);
          }
        }
        await sleep(250);
      }
    })();
  }

  function connectJvm(me, socket) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ path: socket });
      let buf = '';
      let hello = false;
      sock.on('connect', () => sock.write(JSON.stringify({ token }) + '\n'));
      sock.on('error', (e) => {
        if (!hello) reject(e);
      });
      sock.on('close', () => {
        if (me.sock === sock) me.sock = null;
      });
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (!hello) {
            hello = true;
            if (!msg.ok) {
              reject(new Error(msg.error ?? 'refused'));
              return;
            }
            me.sock = sock;
            me.up = true;
            resolve();
            continue;
          }
          const p = me.pending.get(String(msg.id));
          if (!p) continue;
          me.pending.delete(String(msg.id));
          p.reply(msg);
        }
      });
    });
  }

  /** Sends one request to the server; reply(msg) gets the answer with the server's id (the caller restores its own). */
  function forward(req, reply) {
    const me = jvm;
    if (!me || !me.sock) {
      reply({ ok: false, error: me ? 'the headless server is still starting (dev.state until ready)' : 'not in a world: the headless server is stopped (dev.world.open first)' });
      return;
    }
    const id = `h${nextId++}`;
    me.pending.set(id, { reply });
    me.sock.write(JSON.stringify({ ...req, id }) + '\n');
  }
  const ask = (type, payload = {}, timeoutMs = 30_000) => new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs);
    forward({ type, ...payload }, (m) => {
      clearTimeout(t);
      resolve(m);
    });
  });

  /** Saves and stops the world; the server process stays for the next (a client's title screen). */
  async function leaveWorld() {
    if (!jvm?.sock) return false;
    const t = Date.now();
    const r = await ask('dev.host.leave', {}, 300_000);
    stats.lastStopMs = Date.now() - t;
    log(`left the world in ${(stats.lastStopMs / 1000).toFixed(1)} s${r.ok ? '' : ` (${r.error})`}`);
    return !!r.ok;
  }

  async function stopServer(why) {
    const me = jvm;
    if (!me) return false;
    me.expectedExit = true;
    const t = Date.now();
    log(`stopping server pid ${me.proc.pid} (${why})`);
    if (me.sock) await ask('dev.host.stop', {}, 15_000);
    else {
      try {
        me.proc.stdin.write('stop\n');
      } catch {
        // gone
      }
    }
    const done = await Promise.race([me.exited.then(() => true), sleep(180_000).then(() => false)]);
    if (!done) {
      log(`server pid ${me.proc.pid} did not stop in 180 s: SIGTERM`);
      me.proc.kill('SIGTERM');
      if (!(await Promise.race([me.exited.then(() => true), sleep(30_000).then(() => false)]))) {
        log(`server pid ${me.proc.pid}: SIGKILL`);
        me.proc.kill('SIGKILL');
        await me.exited;
      }
    }
    stats.lastStopMs = Date.now() - t;
    log(`server stopped in ${(stats.lastStopMs / 1000).toFixed(1)} s`);
    return true;
  }

  // ---------------------------------------------------------------- the DevBridge's WebSocket

  const hostState = () => ({
    inWorld: false, ready: false, loading: !!jvm, paused: false, headless: true, screen: null, player: null, world: null,
    phase: jvm ? 'starting' : 'title', host: { pid: process.pid, starts: stats.starts, opens: stats.opens, lastStopMs: stats.lastStopMs },
  });
  const HOST_HELP = {
    'dev.world.open': '{name?, mode?, preset?, seed?, cheats?} - (headless host) start the server on that world (created when missing)',
    'dev.world.leave': '{} - (headless host) save and stop the server',
    'dev.quit': '{} - (headless host) save, stop the server and exit',
  };

  const server = await listen({
    port: opts.devPort,
    verify: (req) => {
      const q = (req.url ?? '').split('?')[1] ?? '';
      const t = new URLSearchParams(q).get('token') ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      return t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
    },
    onOpen: (conn) => conn.send(JSON.stringify({ type: 'dev.hello', protocol: 1, mod: 'architect_mc', headless: true, inWorld: !!jvm?.up })),
    onText: (conn, text) => {
      let req;
      try {
        req = JSON.parse(text);
      } catch {
        conn.send(JSON.stringify({ ok: false, error: 'invalid JSON' }));
        return;
      }
      const id = req.id;
      const type = req.type;
      const answer = (o) => conn.send(JSON.stringify({ ...o, id, type, ok: o.ok ?? true }));
      const fail = (e) => answer({ ok: false, error: String(e?.message ?? e) });
      const up = jvm?.sock;
      switch (type) {
        case 'dev.world.open': {
          let spec;
          try {
            // fields left out keep the host's world (a client's AutoWorld falls back to ARCHITECT_AUTOWORLD_*)
            const given = Object.fromEntries(['name', 'mode', 'preset', 'seed', 'cheats'].filter((k) => req[k] !== undefined && req[k] !== null).map((k) => [k, req[k]]));
            spec = worldSpec({ ...(opts.world ?? {}), ...given });
          } catch (e) {
            fail(e);
            return;
          }
          openWorld(spec).then(() => answer({ opening: true, headless: true }), fail);
          return;
        }
        case 'dev.world.leave':
          leaveWorld().then((was) => answer({ left: was }), fail);
          return;
        case 'dev.quit':
          quitting = true;
          answer({ quitting: true });
          stopServer('dev.quit').finally(() => shutdown(0));
          return;
        case 'dev.state':
        case 'dev.ping':
          if (up) {
            forward(req, (m) => conn.send(JSON.stringify({ ...m, id })));
          } else if (type === 'dev.ping') {
            answer({ pong: true, frame: 0, msSinceLastFrame: 0, stalled: false, quitting, headless: true });
          } else {
            answer(hostState());
          }
          return;
        case 'dev.help':
          if (up) {
            forward(req, (m) => {
              if (m.ok && m.commands) Object.assign(m.commands, HOST_HELP);
              conn.send(JSON.stringify({ ...m, id }));
            });
          } else {
            answer({ commands: HOST_HELP, screens: {} });
          }
          return;
        default:
          forward(req, (m) => conn.send(JSON.stringify({ ...m, id, type: m.type ?? type })));
      }
    },
  });
  log(`DevBridge (headless) on ws://127.0.0.1:${opts.devPort}; sidecar port ${opts.sidecarPort} (${opts.sidecar}); game dir ${gameDir}`);

  let shuttingDown = false;
  async function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    await stopServer('host exit').catch(() => null);
    server.close();
    fs.rmSync(tokenFile, { force: true });
    log('host exits');
    process.exit(code);
  }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));
  process.on('SIGHUP', () => {});

  if (opts.world) await startServer(worldSpec(opts.world));
  return { shutdown };
}
