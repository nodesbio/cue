#!/usr/bin/env node
/**
 * Drive the G1 HUD from the terminal while the dev build is running.
 *
 *   node scripts/hud.mjs serve              # start bridge; leave running
 *   node scripts/hud.mjs text "hello"
 *   node scripts/hud.mjs test | clear | dashboard | status | logs [n]
 *
 * `serve` holds the WebSocket the phone connects to (port 8910) and exposes
 * a local HTTP control port (8911) the one-shot commands post to.
 */
import ws from 'ws'; // transitive ws@7 (CJS): Server, not WebSocketServer
import http from 'node:http';
const WebSocketServer = ws.Server;

const WS_PORT = 8910;
const CTL_PORT = 8911;
const [, , cmd, ...rest] = process.argv;

if (!cmd) {
  console.error('usage: hud.mjs serve | text "..." | test | clear | dashboard | status | logs [n]');
  process.exit(1);
}

if (cmd === 'serve') {
  let phone = null;
  const pending = new Map();
  let nextId = 1;

  const wss = new WebSocketServer({ port: WS_PORT });
  wss.on('connection', (sock, req) => {
    phone = sock;
    console.log(`[hud] phone connected from ${req.socket.remoteAddress}`);
    sock.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      p(msg);
    });
    sock.on('close', () => { if (phone === sock) phone = null; console.log('[hud] phone disconnected'); });
  });

  http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!phone) { res.writeHead(503); res.end(JSON.stringify({ ok: false, error: 'phone not connected' })); return; }
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); res.writeHead(504); res.end(JSON.stringify({ ok: false, error: 'timeout' })); }, 15000);
      pending.set(id, (msg) => { clearTimeout(timer); res.writeHead(200); res.end(JSON.stringify(msg)); });
      phone.send(JSON.stringify({ id, ...JSON.parse(body) }));
    });
  }).listen(CTL_PORT, '127.0.0.1');

  console.log(`[hud] listening ws:${WS_PORT} ctl:${CTL_PORT} — waiting for phone`);
} else {
  const payload = { cmd };
  if (cmd === 'text') {
    // optional leading --ns=0x51 to override the newScreen byte
    const nsArg = rest.find((a) => a.startsWith('--ns='));
    if (nsArg) payload.ns = Number(nsArg.slice(5));
    payload.text = rest.filter((a) => !a.startsWith('--ns=')).join(' ');
  }
  if (cmd === 'logs' && rest[0]) payload.tail = Number(rest[0]);

  const res = await fetch(`http://127.0.0.1:${CTL_PORT}/`, { method: 'POST', body: JSON.stringify(payload) })
    .catch(() => { console.error('[hud] bridge not running — start it with: node scripts/hud.mjs serve'); process.exit(1); });
  const msg = await res.json();
  if (!msg.ok) { console.error(`[hud] error: ${msg.error}`); process.exit(1); }
  const r = msg.result;
  console.log(Array.isArray(r) ? r.join('\n') : typeof r === 'string' ? r : JSON.stringify(r, null, 2));
}
