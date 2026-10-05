// WebSocket server (ported from AgentCraft's foreman/src/server.ts): ws://127.0.0.1:<port>.
//
// A client must send `hello` with the client token (clienttoken.ts) first. Anything before a valid
// hello is refused, and a hello with a missing or wrong token gets an `error` and the connection is
// closed (code 4001). A valid hello is answered with a `snapshot`; after that the client gets every
// broadcast (`status`, `design.upsert`). Any browser Origin (also `null`) and non-loopback Host
// headers are rejected at the upgrade, so a web page cannot reach the sidecar.
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { tokenMatches } from './clienttoken.js';
import type { Logger } from './context.js';
import { parseClientMessage, PROTOCOL_VERSION, ServerMessage, type ClientMessage, type Outbound } from './protocol.js';

/** What the server drives (the Sidecar). */
export interface ServerTarget {
  /** a validated message from a client that sent a valid hello (hello included) */
  handle(msg: ClientMessage, reply: (m: Outbound) => void): Promise<void>;
  subscribe(fn: (m: Outbound) => void): () => void;
}

export interface ServerOptions {
  host: string;
  port: number;
  /** the client token every hello must carry */
  token: string;
  /** validate every outbound message against the schema (tests/dev) */
  validateOutbound?: boolean;
  log: Logger;
}

/** Host header values a local client sends (DNS rebinding sends the attacker's host name). */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export const TOKEN_REFUSED = 'refused: hello needs the client token from <data>/client.token';
export const HELLO_FIRST = 'refused: send hello with the client token first';
export const CLOSE_BAD_TOKEN = 4001;

/**
 * Why a WebSocket upgrade is refused, or undefined to accept. The mod (Java HttpClient) and our
 * tools send no Origin header; every browser does, and a sandboxed iframe, a data: URL or a
 * file:// page sends the literal `null`, so any Origin at all is a web page. The Host must be a
 * loopback name, so a DNS-rebinding page cannot reach us under its own name.
 */
export function refuseReason(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  if (origin !== undefined) return `browser origin ${origin || '(empty)'}`;
  const host = req.headers.host ?? '';
  if (!LOOPBACK_HOST.test(host)) return `non-loopback Host header ${host || '(none)'}`;
  return undefined;
}

interface Client {
  ws: WebSocket;
  id: number;
  /** sent a hello with the right token */
  trusted: boolean;
  name: string;
  alive: boolean;
}

export class SidecarServer {
  private wss: WebSocketServer | undefined;
  private clients = new Set<Client>();
  private unsub: (() => void) | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private nextId = 1;
  port = 0;

  constructor(
    private target: ServerTarget,
    private opts: ServerOptions,
  ) {}

  get clientCount(): number {
    return [...this.clients].filter((c) => c.trusted).length;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: this.opts.host,
        port: this.opts.port,
        maxPayload: 1024 * 1024,
        verifyClient: (info: { origin?: string; req: IncomingMessage }) => {
          const why = refuseReason(info.req);
          if (!why) return true;
          this.opts.log.warn(`rejected WebSocket: ${why}`);
          return false;
        },
      });
      this.wss = wss;
      wss.once('error', (e) => reject(e));
      wss.once('listening', () => {
        const addr = wss.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        wss.on('error', (e) => this.opts.log.error(`ws server: ${e.message}`));
        resolve(this.port);
      });
      wss.on('connection', (ws, req) => this.onConnection(ws, req));
      this.unsub = this.target.subscribe((m) => this.broadcast(m));
      this.heartbeat = setInterval(() => {
        for (const c of this.clients) {
          if (!c.alive) {
            c.ws.terminate();
            continue;
          }
          c.alive = false;
          try {
            c.ws.ping();
          } catch {
            /* ignore */
          }
        }
      }, 15_000);
      this.heartbeat.unref?.();
    });
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const client: Client = { ws, id: this.nextId++, trusted: false, name: `client#${this.nextId - 1}`, alive: true };
    this.clients.add(client);
    this.opts.log.info(`client #${client.id} connected from ${req.socket.remoteAddress ?? '?'}`);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      client.alive = true;
      if (isBinary) {
        this.send(client, { type: 'error', message: 'binary frames are not supported' });
        return;
      }
      // (the raw frame is never logged: an auth.set carries an API key)
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) {
        if (!client.trusted) return this.refuse(client, HELLO_FIRST, parsed.id);
        this.send(client, { type: 'error', message: `bad message: ${parsed.error}`, ...(parsed.id ? { re: parsed.id } : {}) });
        if (parsed.id) this.send(client, { type: 'ack', re: parsed.id, ok: false, error: parsed.error });
        return;
      }
      const msg = parsed.msg;
      if (msg.type === 'hello') {
        if (!tokenMatches(this.opts.token, msg.token)) {
          this.opts.log.warn(`client #${client.id}: hello ${msg.token ? 'with a wrong' : 'without a'} client token: refused`);
          this.send(client, { type: 'error', message: TOKEN_REFUSED, ...(msg.id ? { re: msg.id } : {}) });
          if (msg.id) this.send(client, { type: 'ack', re: msg.id, ok: false, error: TOKEN_REFUSED });
          client.ws.close(CLOSE_BAD_TOKEN, 'bad client token');
          return;
        }
        client.trusted = true;
        client.name = `${msg.client ?? 'client'}#${client.id}${msg.version ? ` (${msg.version})` : ''}`;
        this.opts.log.info(`hello from ${client.name}`);
      } else if (!client.trusted) return this.refuse(client, HELLO_FIRST, msg.id);
      void this.target.handle(msg, (out) => this.send(client, out)).catch((e) => this.opts.log.error(`handling ${msg.type}: ${(e as Error).message}`));
    });
    ws.on('close', () => {
      this.clients.delete(client);
      this.opts.log.info(`client #${client.id} disconnected`);
    });
    ws.on('error', (e) => this.opts.log.warn(`client #${client.id}: ${e.message}`));
  }

  private refuse(client: Client, why: string, re: string | undefined): void {
    this.send(client, { type: 'error', message: why, ...(re ? { re } : {}) });
    if (re) this.send(client, { type: 'ack', re, ok: false, error: why });
  }

  private serialize(m: Outbound): string {
    const full = { v: PROTOCOL_VERSION, ...m };
    if (this.opts.validateOutbound) {
      const r = ServerMessage.safeParse(full);
      if (!r.success) {
        this.opts.log.error(`outbound ${m.type} violates protocol: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        throw new Error(`outbound ${m.type} violates protocol`);
      }
    }
    return JSON.stringify(full);
  }

  private send(c: Client, m: Outbound): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    c.ws.send(this.serialize(m));
  }

  broadcast(m: Outbound): void {
    let s: string | undefined;
    for (const c of this.clients) {
      if (!c.trusted || c.ws.readyState !== c.ws.OPEN) continue;
      s ??= this.serialize(m);
      c.ws.send(s);
    }
  }

  async stop(): Promise<void> {
    this.unsub?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) {
      try {
        c.ws.close(1001, 'sidecar shutting down');
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      const t = setTimeout(() => {
        for (const c of this.clients) c.ws.terminate();
        resolve();
      }, 1000);
      t.unref?.();
      this.wss.close(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
