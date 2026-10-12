// A minimal RFC 6455 WebSocket server (text frames, ping/pong, close; no extensions) for the headless host
// (tools/run-headless-server.mjs), so tools/ keeps needing no npm install. Loopback only. One JSON object per text frame is
// the DevBridge's protocol; this module only moves text.
//
//   const srv = await listen({ port, host: '127.0.0.1', verify: (req) => true|false,
//     onOpen: (conn, req) => {}, onText: (conn, text) => {}, onClose: (conn) => {} });
//   conn.send(text); conn.close();

import crypto from 'node:crypto';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(op, payload) {
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | op, n]);
  else if (n < 65536) head = Buffer.from([0x80 | op, 126, n >> 8, n & 255]);
  else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | op;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

class Conn {
  constructor(sock) {
    this.sock = sock;
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.partOp = 0;
  }

  send(text) {
    if (!this.open) return;
    try {
      this.sock.write(frame(0x1, Buffer.from(text, 'utf8')));
    } catch {
      // closed under us
    }
  }

  close(code = 1000) {
    if (!this.open) return;
    this.open = false;
    try {
      this.sock.end(frame(0x8, Buffer.from([code >> 8, code & 255])));
    } catch {
      // gone
    }
  }
}

export function listen({ port, host = '127.0.0.1', verify = () => true, onOpen = () => {}, onText = () => {}, onClose = () => {} }) {
  const server = http.createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('DevBridge: WebSocket only\n');
  });
  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers.origin || !verify(req)) {
      sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.setNoDelay(true);
    const conn = new Conn(sock);
    const end = () => {
      if (conn.ended) return;
      conn.ended = true;
      conn.open = false;
      onClose(conn);
    };
    sock.on('close', end);
    sock.on('error', end);
    sock.on('data', (chunk) => {
      conn.buf = Buffer.concat([conn.buf, chunk]);
      for (;;) {
        const b = conn.buf;
        if (b.length < 2) return;
        const fin = (b[0] & 0x80) !== 0;
        const op = b[0] & 0x0f;
        const masked = (b[1] & 0x80) !== 0;
        let len = b[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (b.length < 4) return;
          len = b.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (b.length < 10) return;
          len = Number(b.readBigUInt64BE(2));
          off = 10;
        }
        const maskOff = off;
        if (masked) off += 4;
        if (b.length < off + len) return;
        const payload = Buffer.from(b.subarray(off, off + len));
        if (masked) for (let i = 0; i < len; i++) payload[i] ^= b[maskOff + (i % 4)];
        conn.buf = b.subarray(off + len);
        if (op === 0x8) {
          conn.close();
          return;
        }
        if (op === 0x9) {
          try {
            sock.write(frame(0xa, payload));
          } catch {
            // gone
          }
          continue;
        }
        if (op === 0xa) continue;
        if (op === 0x1 || op === 0x2) {
          conn.parts = [payload];
          conn.partOp = op;
        } else if (op === 0x0) {
          conn.parts.push(payload);
        } else {
          continue;
        }
        if (fin) {
          const text = Buffer.concat(conn.parts).toString('utf8');
          conn.parts = [];
          onText(conn, text);
        }
      }
    });
    onOpen(conn, req);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
