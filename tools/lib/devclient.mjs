// DevBridge client: connects to the mod's localhost WebSocket (default ws://127.0.0.1:7891) and sends JSON
// requests matched by id. Used by devcli.mjs, shoot.mjs and QA tooling. Ported from AgentCraft's tools (MIT);
// uses Node's built-in WebSocket (Node 22+), so tools/ needs no npm install.
//
//   import { DevClient } from './lib/devclient.mjs';
//   const dev = await DevClient.connect({ timeoutMs: 120_000 });
//   const st = await dev.call('dev.state');
//   await dev.call('dev.camera', { x: 0, y: 70, z: 0, yaw: 0, pitch: 10 });
//   const shot = await dev.call('dev.screenshot', { name: 'hello' });
//   dev.close();

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The DevBridge shared secret: ARCHITECT_DEV_TOKEN, else the file the mod writes to
 * <gameDir>/architect/devbridge.token (game dir: ARCHITECT_GAME_DIR, default <repo>/mod/run).
 * Re-read on every connect attempt (the game may start, or restart with a new token, meanwhile).
 */
export function readToken() {
  const env = process.env.ARCHITECT_DEV_TOKEN?.trim();
  if (env) return env;
  const gameDir = process.env.ARCHITECT_GAME_DIR || path.join(repoRoot, 'mod', 'run');
  try {
    return fs.readFileSync(path.join(gameDir, 'architect', 'devbridge.token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export const DEFAULT_PORT = Number(process.env.ARCHITECT_DEV_PORT || 7891);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DevError extends Error {
  constructor(message, response) {
    super(message);
    this.name = 'DevError';
    this.response = response;
  }
}

export class DevClient {
  constructor(ws, hello) {
    this.ws = ws;
    this.hello = hello;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.closeWaiters = [];
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new DevError('DevBridge connection closed'));
      }
      this.pending.clear();
      for (const w of this.closeWaiters) w();
    });
    ws.addEventListener('error', () => {});
  }

  /**
   * Connect, retrying until the bridge is up (the game may still be starting).
   * @param {{port?:number, host?:string, timeoutMs?:number, retryMs?:number, token?:string, onWait?:(elapsedMs:number)=>void}} opts
   */
  static async connect(opts = {}) {
    const port = opts.port ?? DEFAULT_PORT;
    const host = opts.host ?? '127.0.0.1';
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const retryMs = opts.retryMs ?? 500;
    const start = Date.now();
    let lastErr;
    let lastNotice = 0;
    while (true) {
      try {
        return await DevClient.#tryConnect(`ws://${host}:${port}`, opts.token ?? readToken());
      } catch (err) {
        lastErr = err;
      }
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) {
        throw new DevError(`DevBridge not reachable on ws://${host}:${port} after ${Math.round(elapsed / 1000)}s (${lastErr?.message ?? lastErr})${readToken() ? '' : '; no DevBridge token found (set ARCHITECT_DEV_TOKEN or ARCHITECT_GAME_DIR, or start the game so it writes mod/run/architect/devbridge.token)'}`);
      }
      if (opts.onWait && elapsed - lastNotice >= 10_000) {
        lastNotice = elapsed;
        opts.onWait(elapsed);
      }
      await sleep(retryMs);
    }
  }

  static #tryConnect(url, token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(token ? `${url}/?token=${encodeURIComponent(token)}` : url);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(err);
      };
      ws.addEventListener('error', () => fail(new Error('connection failed (bridge down, or a missing/wrong token)')), { once: true });
      // The server greets with {type:"dev.hello"} right after the handshake.
      ws.addEventListener('message', (ev) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        let hello = null;
        try { hello = JSON.parse(String(ev.data)); } catch {}
        resolve(new DevClient(ws, hello));
      }, { once: true });
      const timer = setTimeout(() => fail(new Error('no dev.hello within 5s')), 5000);
    });
  }

  #onMessage(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.id == null) return; // events (dev.hello etc.)
    const p = this.pending.get(String(msg.id));
    if (!p) return;
    this.pending.delete(String(msg.id));
    clearTimeout(p.timer);
    p.resolve(msg);
  }

  /** Send a request and resolve with the raw response ({ok:true,...} or {ok:false,error}). */
  request(type, payload = {}, opts = {}) {
    if (this.closed) return Promise.reject(new DevError('DevBridge connection closed'));
    const id = String(this.nextId++);
    const timeoutMs = opts.timeoutMs ?? 180_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DevError(`${type} timed out after ${timeoutMs}ms (client side)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, id, type }));
    });
  }

  /** Like request() but throws DevError when the response is not ok. */
  async call(type, payload = {}, opts = {}) {
    const res = await this.request(type, payload, opts);
    if (!res.ok) throw new DevError(`${type} failed: ${res.error}`, res);
    return res;
  }

  /** Liveness check that works even when the game is hung (dev.ping is answered on the socket thread). */
  async health({ timeoutMs = 5_000 } = {}) {
    try {
      const p = await this.request('dev.ping', {}, { timeoutMs });
      return { ok: !!p.ok, stalled: !!p.stalled, msSinceLastFrame: p.msSinceLastFrame ?? null, frame: p.frame ?? null, quitting: !!p.quitting };
    } catch (e) {
      return { ok: false, stalled: null, error: e.message };
    }
  }

  /** Throws DevError (with .hung = true) when the render thread has been stuck for at least minMs. */
  async assertNotHung(minMs = 30_000) {
    const h = await this.health();
    if (h.ok && h.stalled && h.msSinceLastFrame >= minMs) {
      const err = new DevError(`game is hung: the render thread has not finished a frame for ${h.msSinceLastFrame} ms (relaunch it; dev.quit force-exits)`, h);
      err.hung = true;
      throw err;
    }
    return h;
  }

  /** Wait until the player is in a world (poll dev.state). Fails fast if the game hangs. */
  async waitInWorld({ timeoutMs = 300_000, pollMs = 1000, onWait } = {}) {
    const start = Date.now();
    let lastNotice = 0;
    while (true) {
      const st = await this.request('dev.state', {}, { timeoutMs: 15_000 }).catch((e) => ({ ok: false, error: e.message }));
      if (st.ok && (st.ready ?? (st.inWorld && !st.loading))) return st;
      if (!st.ok) await this.assertNotHung();
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) throw new DevError(`not in a world after ${Math.round(elapsed / 1000)}s`, st);
      if (onWait && elapsed - lastNotice >= 10_000) {
        lastNotice = elapsed;
        onWait(elapsed, st);
      }
      await sleep(pollMs);
    }
  }

  /** Resolves when the server closes the socket (e.g. after dev.quit). */
  waitClosed(timeoutMs = 60_000) {
    if (this.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.closeWaiters.push(() => { clearTimeout(timer); resolve(true); });
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}
