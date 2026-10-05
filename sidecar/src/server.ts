// WebSocket server (ported from AgentCraft's foreman/src/server.ts): ws://127.0.0.1:<port>.
//
// A client must send `hello` with the client token (clienttoken.ts) first. Anything before a valid
// hello is refused, and a hello with a missing or wrong token gets an `error` and the connection is
// closed (code 4001). A valid hello is answered with a `snapshot`; after that the client gets every
// broadcast (`status`, `design.upsert`, ...). Any browser Origin (also `null`) and non-loopback Host
// headers are rejected at the upgrade, so a web page cannot reach the sidecar.
//
// Protocol (docs/CONTRACT.md "Versioning"): the hello's `protocols` picks the connection's
// protocol. A protocol-1 connection (no `protocols`) parses frames with the phase 1-3 messages only
// and gets every outbound message through `toProtocol1`: no job.* messages, no v2 fields.
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { tokenMatches } from './clienttoken.js';
import type { Logger } from './context.js';
import { chooseProtocol, parseClientMessage, PROTOCOL_VERSION, PROTOCOLS, ServerMessage, toProtocol1, type ClientMessage, type Outbound, type Protocol } from './protocol.js';

/** A connected client, as the sidecar core sees it. */
export interface ClientHandle {
  readonly id: number;
  /** the hello's `client` ("mod", "cli"; "client" when absent) */
  readonly name: string;
  readonly protocol: Protocol;
  /** `client.paused` (the game is paused): tool-call clocks of this client stop */
  paused: boolean;
  /** still connected and trusted */
  readonly open: boolean;
  send(m: Outbound): void;
}

/** What the server drives (the Sidecar). */
export interface ServerTarget {
  /** a validated message from a client that sent a valid hello (hello included) */
  handle(msg: ClientMessage, reply: (m: Outbound) => void, client?: ClientHandle): Promise<void>;
  subscribe(fn: (m: Outbound) => void): () => void;
  /** a trusted client disconnected */
  clientGone?(client: ClientHandle): void;
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
export const NO_COMMON_PROTOCOL = `refused: no common protocol (this sidecar speaks ${PROTOCOLS.join(', ')})`;
export const CLOSE_BAD_TOKEN = 4001;
export const CLOSE_BAD_PROTOCOL = 4002;
/** One frame. Blobs bigger than this go as several `blob.put` frames (`more: true`). */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

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

class Client implements ClientHandle {
  /** sent a hello with the right token */
  trusted = false;
  name = 'client';
  label: string;
  alive = true;
  protocol: Protocol = 1;
  paused = false;

  constructor(
    readonly ws: WebSocket,
    readonly id: number,
    private server: SidecarServer,
  ) {
    this.label = `client#${id}`;
  }

  get open(): boolean {
    return this.trusted && this.ws.readyState === this.ws.OPEN;
  }

  send(m: Outbound): void {
    this.server.sendTo(this, m);
  }
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
        maxPayload: MAX_FRAME_BYTES,
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
    const client = new Client(ws, this.nextId++, this);
    this.clients.add(client);
    this.opts.log.info(`client #${client.id} connected from ${req.socket.remoteAddress ?? '?'}`);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      client.alive = true;
      if (isBinary) {
        this.sendTo(client, { type: 'error', message: 'binary frames are not supported' });
        return;
      }
      // (the raw frame is never logged: an auth.set carries an API key)
      const parsed = parseClientMessage(data.toString(), client.trusted ? client.protocol : 2);
      if (!parsed.ok) {
        if (!client.trusted) return this.refuse(client, HELLO_FIRST, parsed.id);
        this.sendTo(client, { type: 'error', message: `bad message: ${parsed.error}`, ...(parsed.id ? { re: parsed.id } : {}) });
        if (parsed.id) this.sendTo(client, { type: 'ack', re: parsed.id, ok: false, error: parsed.error });
        return;
      }
      const msg = parsed.msg;
      if (msg.type === 'hello') {
        if (!tokenMatches(this.opts.token, msg.token)) {
          this.opts.log.warn(`client #${client.id}: hello ${msg.token ? 'with a wrong' : 'without a'} client token: refused`);
          this.sendTo(client, { type: 'error', message: TOKEN_REFUSED, ...(msg.id ? { re: msg.id } : {}) });
          if (msg.id) this.sendTo(client, { type: 'ack', re: msg.id, ok: false, error: TOKEN_REFUSED });
          client.ws.close(CLOSE_BAD_TOKEN, 'bad client token');
          return;
        }
        const protocol = chooseProtocol(msg.protocols);
        if (protocol === undefined) {
          this.opts.log.warn(`client #${client.id}: hello offers protocols ${JSON.stringify(msg.protocols)}: none in common`);
          this.sendTo(client, { type: 'error', message: NO_COMMON_PROTOCOL, ...(msg.id ? { re: msg.id } : {}) });
          if (msg.id) this.sendTo(client, { type: 'ack', re: msg.id, ok: false, error: NO_COMMON_PROTOCOL });
          client.ws.close(CLOSE_BAD_PROTOCOL, 'no common protocol');
          return;
        }
        client.trusted = true;
        client.protocol = protocol;
        client.name = msg.client ?? 'client';
        client.label = `${client.name}#${client.id}${msg.version ? ` (${msg.version})` : ''}`;
        this.opts.log.info(`hello from ${client.label}, protocol ${protocol}`);
      } else if (!client.trusted) return this.refuse(client, HELLO_FIRST, msg.id);
      void this.target.handle(msg, (out) => this.sendTo(client, out), client).catch((e) => this.opts.log.error(`handling ${msg.type}: ${(e as Error).message}`));
    });
    ws.on('close', () => {
      this.clients.delete(client);
      this.opts.log.info(`client #${client.id} disconnected`);
      if (client.trusted) {
        try {
          this.target.clientGone?.(client);
        } catch (e) {
          this.opts.log.error(`clientGone: ${(e as Error).message}`);
        }
      }
    });
    ws.on('error', (e) => this.opts.log.warn(`client #${client.id}: ${e.message}`));
  }

  private refuse(client: Client, why: string, re: string | undefined): void {
    this.sendTo(client, { type: 'error', message: why, ...(re ? { re } : {}) });
    if (re) this.sendTo(client, { type: 'ack', re, ok: false, error: why });
  }

  /** The frame for a protocol, or undefined when that protocol has no such message. */
  private serialize(m: Outbound, protocol: Protocol): string | undefined {
    const full = { v: PROTOCOL_VERSION, ...m } as Record<string, unknown>;
    if (this.opts.validateOutbound) {
      const r = ServerMessage.safeParse(full);
      if (!r.success) {
        this.opts.log.error(`outbound ${m.type} violates protocol: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        throw new Error(`outbound ${m.type} violates protocol`);
      }
    }
    if (protocol === 1) {
      const v1 = toProtocol1(full);
      return v1 ? JSON.stringify(v1) : undefined;
    }
    return JSON.stringify(full);
  }

  sendTo(c: Client, m: Outbound): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    const s = this.serialize(m, c.protocol);
    if (s !== undefined) c.ws.send(s);
  }

  broadcast(m: Outbound): void {
    const frames = new Map<Protocol, string | undefined>();
    for (const c of this.clients) {
      if (!c.trusted || c.ws.readyState !== c.ws.OPEN) continue;
      if (!frames.has(c.protocol)) frames.set(c.protocol, this.serialize(m, c.protocol));
      const s = frames.get(c.protocol);
      if (s !== undefined) c.ws.send(s);
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
