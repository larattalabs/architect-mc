#!/usr/bin/env node
// A stub of the Architect sidecar for the mod's launcher and Status-tab tests (not shipped): the command line, files and
// WebSocket protocol of docs/CONTRACT.md "Sidecar process" / "Protocol", with no Claude behind it. Node core only (a
// hand-rolled RFC 6455 server). Point the game at it with ARCHITECT_SIDECAR_DIR=<this folder's parent>.
//
//   node dist/main.mjs --port 7890 --data <dir> --library <dir> [--kit <dir>] [--parent-pid <pid>] [--use-claude-login]
//
// design.request "designs" by copying STUB_COPY_FROM (a library folder with <id>.nbt + <id>.blueprint.json) into the
// library under gen_<slug of the name or type>, after a few progress steps; without STUB_COPY_FROM it fails the design.
//
// Phase 2 (docs/CONTRACT.md "Variants without Claude", "Import / export"), enough to drive the mod's UI:
// - variant.request {from, palette?, values?, name?} copies the source entry (library/<from>, else <kit>/examples/<from>)
//   under <from>_<palette> (or _v2, _v3...) with variantOf, displayName "<name> (<palette>, floors 2)", the palette and
//   values recorded, user metadata dropped. The blocks are NOT rebuilt (no kit run): same template, new entry.
//   STUB_FAIL_VARIANT=1 fails every variant with checker-like error lines.
// - import.request {path} reads the .nbt's size (kit/lib/nbt.mjs) and installs imp_<file name> as a custom entry
//   (groundY 1, front south, entrance at the front centre, spawn 2 out, "imported": true).
// Both report through variant.upsert and snapshot.variants; acks carry {variantId}.

import { createServer } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const port = Number(opt('port', '7890'));
const data = path.resolve(opt('data', './stub-data'));
const library = path.resolve(opt('library', './stub-library'));
const parentPid = Number(opt('parent-pid', '0'));
const here = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
const log = (...m) => console.log(new Date().toISOString(), '[stub-sidecar]', ...m);

fs.mkdirSync(data, { recursive: true });
const token = crypto.randomBytes(24).toString('hex');
fs.writeFileSync(path.join(data, 'client.token'), token, { mode: 0o600 });
fs.chmodSync(path.join(data, 'client.token'), 0o600);

let secrets = {};
try { secrets = JSON.parse(fs.readFileSync(path.join(data, 'secrets.json'), 'utf8')); } catch {}
const status = () => ({
  auth: secrets.apiKey || secrets.useClaudeLogin || args.includes('--use-claude-login') ? 'ok' : 'missing',
  authSource: secrets.apiKey ? 'API key' : secrets.useClaudeLogin || args.includes('--use-claude-login') ? 'claude login (personal use)' : undefined,
  useClaudeLogin: !!(secrets.useClaudeLogin || args.includes('--use-claude-login')),
  sdk: 'missing',
  queued: 0,
});
const designs = [];
const variants = [];
let nextVariant = 1;
const kitDir = opt('kit') ? path.resolve(opt('kit')) : null;
let nextDesign = 1;
const clients = new Set();

// ------------------------------------------------------------------ WebSocket (RFC 6455, text frames)

function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => {
    const b = Buffer.alloc(10);
    b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2);
    return b;
  })();
  return Buffer.concat([head, payload]);
}

function send(sock, obj) {
  if (!sock.destroyed) sock.write(frame(JSON.stringify({ v: 1, ...obj })));
}

function broadcast(obj) {
  for (const c of clients) if (c.hello) send(c.sock, obj);
}

const server = createServer((req, res) => { res.writeHead(426); res.end('websocket only'); });
server.on('upgrade', (req, sock) => {
  const host = (req.headers.host || '').split(':')[0];
  if (req.headers.origin || !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = { sock, hello: false };
  clients.add(client);
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = (buf[1] & 0x80) !== 0;
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      }
      buf = buf.subarray(need);
      if (op === 0x8) { sock.end(Buffer.from([0x88, 0])); return; }
      if (op === 0x9) { sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 0x1) onText(client, payload.toString('utf8'));
    }
  });
  sock.on('close', () => clients.delete(client));
  sock.on('error', () => clients.delete(client));
});

// ------------------------------------------------------------------ protocol

function onText(client, text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  const ack = (ok, extra = {}) => m.id != null && send(client.sock, { type: 'ack', re: String(m.id), ok, ...extra });
  if (!client.hello) {
    if (m.type !== 'hello' || m.token !== token) {
      send(client.sock, { type: 'error', message: 'hello with a valid token first', re: m.id == null ? undefined : String(m.id) });
      return;
    }
    client.hello = true;
    log(`hello from ${m.client} ${m.version}`);
    send(client.sock, { type: 'snapshot', version, status: status(), designs, variants: variants.slice(-20) });
    return;
  }
  switch (m.type) {
    case 'auth.set': {
      if (typeof m.apiKey === 'string') secrets.apiKey = m.apiKey;
      if (m.apiKey === null) delete secrets.apiKey;
      if (typeof m.useClaudeLogin === 'boolean') secrets.useClaudeLogin = m.useClaudeLogin;
      fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify(secrets), { mode: 0o600 });
      log(`auth.set (key ${secrets.apiKey ? 'set' : 'not set'}, useClaudeLogin ${!!secrets.useClaudeLogin})`); // never the key
      ack(true);
      broadcast({ type: 'status', status: status() });
      break;
    }
    case 'design.request': {
      const id = `d${nextDesign++}`;
      const now = Date.now();
      const d = { id, request: m.request, status: 'queued', step: 'queued', createdAt: now, updatedAt: now };
      designs.push(d);
      ack(true, { result: { designId: id, id } });
      broadcast({ type: 'design.upsert', design: d });
      simulate(d);
      break;
    }
    case 'design.cancel': {
      const d = designs.find((x) => x.id === m.designId);
      if (d && ['queued', 'designing', 'checking', 'rendering'].includes(d.status)) {
        Object.assign(d, { status: 'cancelled', step: 'cancelled', updatedAt: Date.now() });
        broadcast({ type: 'design.upsert', design: d });
        ack(true);
      } else ack(false, { error: 'no running design ' + m.designId });
      break;
    }
    case 'variant.request': {
      if (typeof m.from !== 'string' || !/^[a-z0-9_]+$/.test(m.from)) { ack(false, { error: 'variant.request needs from: a library id' }); break; }
      const v = newVariant({ from: m.from });
      ack(true, { result: { variantId: v.id, id: v.id } });
      runVariant(v, m);
      break;
    }
    case 'import.request': {
      if (typeof m.path !== 'string' || !m.path.endsWith('.nbt')) { ack(false, { error: 'import.request needs path: an absolute .nbt path' }); break; }
      const v = newVariant({ path: m.path, kind: 'import' });
      ack(true, { result: { variantId: v.id, id: v.id } });
      runImport(v, m.path);
      break;
    }
    case 'shutdown':
      ack(true);
      log('shutdown requested');
      setTimeout(() => process.exit(0), 100);
      break;
    default:
      ack(false, { error: 'unknown message ' + m.type });
  }
}

function simulate(d) {
  const steps = [['designing', 'writing the design'], ['checking', 'running the checker'], ['rendering', 'rendering previews']];
  let i = 0;
  const tick = () => {
    if (d.status === 'cancelled') return;
    if (i < steps.length) {
      Object.assign(d, { status: steps[i][0], step: steps[i][1], updatedAt: Date.now() });
      broadcast({ type: 'design.upsert', design: d });
      i++;
      setTimeout(tick, 800);
      return;
    }
    const from = process.env.STUB_COPY_FROM;
    try {
      if (!from) throw new Error('stub: STUB_COPY_FROM is not set, nothing to copy');
      const srcId = path.basename(from);
      const slug = String(d.request?.name || d.request?.type || 'building').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'building';
      let id = `gen_${slug}`;
      for (let n = 2; fs.existsSync(path.join(library, id)); n++) id = `gen_${slug}_${n}`;
      const out = path.join(library, id);
      fs.mkdirSync(out, { recursive: true });
      for (const f of fs.readdirSync(from)) {
        const target = f.replace(srcId, id);
        if (f.endsWith('.blueprint.json')) {
          const sc = JSON.parse(fs.readFileSync(path.join(from, f), 'utf8'));
          Object.assign(sc, { id, name: d.request?.name || sc.name, type: d.request?.type || sc.type, createdAt: Date.now(), request: d.request });
          fs.writeFileSync(path.join(out, target), JSON.stringify(sc, null, 2));
        } else {
          fs.copyFileSync(path.join(from, f), path.join(out, target));
        }
      }
      const sc = JSON.parse(fs.readFileSync(path.join(out, `${id}.blueprint.json`), 'utf8'));
      Object.assign(d, { status: 'done', step: 'installed in the library', blueprintId: id, size: sc.size, updatedAt: Date.now() });
    } catch (e) {
      Object.assign(d, { status: 'failed', step: 'failed', error: e.message, updatedAt: Date.now() });
    }
    broadcast({ type: 'design.upsert', design: d });
  };
  setTimeout(tick, 500);
}

// ------------------------------------------------------------------ variants and imports

function newVariant(extra) {
  const now = Date.now();
  const v = { id: `v${nextVariant++}`, ...extra, status: 'queued', step: 'queued', createdAt: now, updatedAt: now };
  variants.push(v);
  broadcast({ type: 'variant.upsert', variant: v });
  return v;
}

function update(v, fields) {
  Object.assign(v, fields, { updatedAt: Date.now() });
  broadcast({ type: 'variant.upsert', variant: v });
}

function sourceDir(id) {
  const user = path.join(library, id);
  if (fs.existsSync(path.join(user, `${id}.blueprint.json`))) return user;
  if (kitDir) {
    const ex = path.join(kitDir, 'examples', id);
    if (fs.existsSync(path.join(ex, `${id}.blueprint.json`))) return ex;
  }
  return null;
}

function freeId(base, firstSuffix) {
  if (!firstSuffix && !fs.existsSync(path.join(library, base))) return base;
  for (let n = 2; ; n++) {
    const id = `${base}_v${n}`;
    if (!fs.existsSync(path.join(library, id))) return id;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runVariant(v, m) {
  try {
    await sleep(400);
    update(v, { status: 'building', step: 'building with the palette and values' });
    await sleep(900);
    const src = sourceDir(m.from);
    if (!src) throw new Error(`no library entry ${m.from}`);
    if (process.env.STUB_FAIL_VARIANT === '1') {
      const err = new Error('check: FAILED');
      err.lines = ['error: door: no outside door on the front face (stub)', 'error: light: 3 dark interior cells (stub)'];
      throw err;
    }
    const sc = JSON.parse(fs.readFileSync(path.join(src, `${m.from}.blueprint.json`), 'utf8'));
    if (sc.imported || !sc.source) throw new Error(`${m.from} has no source to re-run`);
    const pal = m.palette;
    const palLabel = typeof pal === 'string' ? pal : pal && typeof pal === 'object' ? (pal.wood || pal.stone || 'custom') : null;
    const values = m.values && typeof m.values === 'object' ? m.values : {};
    const id = freeId(palLabel ? `${m.from}_${palLabel.replace(/[^a-z0-9_]/g, '_')}` : `${m.from}`, !palLabel);
    const bits = [];
    if (palLabel) bits.push(palLabel);
    for (const [k, val] of Object.entries(values)) bits.push(typeof val === 'boolean' ? `${k} ${val ? 'on' : 'off'}` : `${k} ${val}`);
    const baseName = m.name || sc.name || m.from;
    const out = path.join(library, id);
    fs.mkdirSync(out, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      if (!f.startsWith(m.from + '.') && !f.startsWith(m.from + '-')) continue;
      const target = id + f.slice(m.from.length);
      if (f.endsWith('.blueprint.json')) continue;
      fs.copyFileSync(path.join(src, f), path.join(out, target));
    }
    const presetInputs = typeof pal === 'string' ? { preset: pal } : pal && typeof pal === 'object' ? { ...pal } : {};
    const next = { ...sc, id, source: sc.source ? `${id}.mjs` : sc.source, createdAt: Date.now(), variantOf: m.from,
      displayName: m.name ? m.name : `${baseName} (${bits.join(', ') || 'copy'})`,
      palette: pal ? presetInputs : sc.palette, values: { ...(sc.values || {}), ...values } };
    delete next.favorite;
    delete next.userTags;
    fs.writeFileSync(path.join(out, `${id}.blueprint.json`), JSON.stringify(next, null, 2));
    log(`variant ${v.id}: ${m.from} -> ${id}`);
    update(v, { status: 'done', step: 'installed in the library', blueprintId: id, size: next.size, name: next.displayName });
  } catch (e) {
    update(v, { status: 'failed', step: 'failed', error: e.lines ? e.lines.join('\n') : e.message, errors: e.lines });
  }
}

async function runImport(v, file) {
  try {
    await sleep(300);
    update(v, { status: 'building', step: 'checking the structure (custom profile)' });
    await sleep(700);
    if (!kitDir) throw new Error('stub: no --kit, cannot read NBT');
    const { parse, plain } = await import(path.join(kitDir, 'lib', 'nbt.mjs'));
    const tag = plain(parse(fs.readFileSync(file)));
    const [sx, sy, sz] = (tag.size || []).map(Number);
    if (!(sx > 0 && sy > 0 && sz > 0)) throw new Error(`${path.basename(file)} has no structure size`);
    const slug = path.basename(file, '.nbt').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'structure';
    const id = freeId(`imp_${slug}`, false);
    const out = path.join(library, id);
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(file, path.join(out, `${id}.nbt`));
    const name = path.basename(file, '.nbt').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const sc = {
      id, name, description: `Imported from ${path.basename(file)}.`, type: 'custom', tags: ['imported'],
      size: { x: sx, y: sy, z: sz }, groundY: Math.min(1, sy - 1), front: 'south', materials: [],
      anchors: { entrance: { x: sx / 2, y: 1, z: sz + 0.5, yaw: 0, pitch: 0 }, spawn: { x: sx / 2, y: 1, z: sz + 2.5, yaw: 180, pitch: 0 } },
      imported: true, createdAt: Date.now(),
    };
    fs.writeFileSync(path.join(out, `${id}.blueprint.json`), JSON.stringify(sc, null, 2));
    log(`import ${v.id}: ${file} -> ${id}`);
    update(v, { status: 'done', step: 'installed in the library', blueprintId: id, size: sc.size, name });
  } catch (e) {
    update(v, { status: 'failed', step: 'failed', error: e.message });
  }
}

server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(path.join(data, 'sidecar.json'), JSON.stringify({ pid: process.pid, port, version, startedAt: Date.now() }));
  log(`listening on 127.0.0.1:${port}, data ${data}, library ${library}, kit ${opt('kit')}, parent ${parentPid}`);
});
server.on('error', (e) => { log('listen failed:', e.message); process.exit(1); });

if (parentPid > 0) {
  setInterval(() => {
    try { process.kill(parentPid, 0); } catch { log(`parent ${parentPid} is gone; exiting`); process.exit(0); }
  }, 5000);
}
