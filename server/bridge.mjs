#!/usr/bin/env node
/**
 * Chrome Bridge — 本地桥接服务（零依赖）
 *
 *   Chrome 扩展（service worker）  ──ws://127.0.0.1:8777/ext──▶  本服务
 *   智能体 / 脚本                  ──POST http://127.0.0.1:8777/cmd──▶  本服务
 *
 * 只监听回环地址；WebSocket 只接受 chrome-extension:// 来源，避免被任意网页利用。
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { acceptUpgrade } from './ws-lite.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.CB_PORT || 8777);
const TOKEN = process.env.CB_TOKEN || '';
const DEFAULT_TIMEOUT = Number(process.env.CB_TIMEOUT || 30000);

let extSocket = null;
let extInfo = null;
let hbTimer = null;
const pending = new Map();

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(stamp(), ...a);

/** 探活：扩展的浏览器 WebSocket 会自动回 pong，收不到就判定它已经死了 */
function stopHeartbeat() {
  clearInterval(hbTimer);
  hbTimer = null;
}

function startHeartbeat(ws) {
  stopHeartbeat();
  let alive = true;
  ws.on('pong', () => { alive = true; });
  hbTimer = setInterval(() => {
    if (ws.readyState !== 1) return stopHeartbeat();
    if (!alive) {
      log('扩展心跳超时，判定为断开');
      try { ws.close(1001, 'no pong'); } catch {}
      if (extSocket === ws) extSocket = null;
      return stopHeartbeat();
    }
    alive = false;
    try { ws.ping(); } catch { alive = true; }
  }, 15000);
}

function sendToExtension(cmd, args = {}, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (!extSocket || extSocket.readyState !== 1) {
      return reject(new Error('extension_not_connected'));
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout after ${timeout}ms (cmd=${cmd})`));
    }, timeout);
    pending.set(id, { resolve, timer });
    extSocket.send(JSON.stringify({ id, cmd, args }));
  });
}

// ---------------------------------------------------------------- HTTP

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const isUp = () => !!(extSocket && extSocket.readyState === 1);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (TOKEN && req.headers['x-cb-token'] !== TOKEN) {
    return json(res, 401, { ok: false, error: 'bad_token' });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      extensionConnected: isUp(),
      extension: extInfo,
      port: PORT,
      pending: pending.size,
    });
  }

  if (req.method === 'GET' && url.pathname === '/') {
    const up = isUp();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>Chrome Bridge</title>
<style>body{font:15px/1.8 -apple-system,"PingFang SC",system-ui,sans-serif;max-width:660px;margin:64px auto;padding:0 24px;color:#111}
code{background:#f2f3f5;padding:2px 6px;border-radius:4px}
.ok{color:#0a7a3d;font-weight:600}.bad{color:#c0392b;font-weight:600}
pre{background:#f7f8fa;padding:14px;border-radius:8px;overflow:auto}</style>
<h2>Chrome Bridge</h2>
<p>扩展连接状态：<span class="${up ? 'ok' : 'bad'}">${up ? '已连接' : '未连接'}</span></p>
<p>监听 <code>${HOST}:${PORT}</code>　·　扩展端 <code>ws://${HOST}:${PORT}/ext</code></p>
<pre>curl -s http://127.0.0.1:${PORT}/health

curl -s -X POST http://127.0.0.1:${PORT}/cmd \\
  -H 'content-type: application/json' \\
  -d '{"cmd":"tabs.list"}'</pre>`);
  }

  if (req.method === 'POST' && url.pathname === '/cmd') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { ok: false, error: 'invalid_json' });
    }
    const { cmd, args, timeout } = payload || {};
    if (!cmd) return json(res, 400, { ok: false, error: 'missing_cmd' });

    try {
      const reply = await sendToExtension(cmd, args || {}, timeout || DEFAULT_TIMEOUT);
      return json(res, reply.ok ? 200 : 500, reply);
    } catch (err) {
      return json(res, 503, { ok: false, error: String(err.message || err) });
    }
  }

  json(res, 404, { ok: false, error: 'not_found' });
});

// ---------------------------------------------------------------- Upgrade

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname !== '/ext') {
    socket.destroy();
    return;
  }

  const origin = req.headers.origin || '';
  // 浏览器页面一定带 Origin；不带 Origin 的是本机命令行客户端（仅调试时放行）
  const originOk = /^chrome-extension:\/\//.test(origin) ||
    (!origin && process.env.CB_ALLOW_NO_ORIGIN === '1');
  if (!originOk) {
    log(`拒绝非扩展来源: origin=${origin || '(空)'}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  acceptUpgrade(req, socket, head, (ws) => {
    if (extSocket && extSocket.readyState === 1) {
      log('已有扩展连接，顶掉旧的');
      try { extSocket.close(1000, 'replaced'); } catch {}
    }
    extSocket = ws;
    extInfo = { origin, at: Date.now() };
    startHeartbeat(ws);
    log(`扩展已连接 (${origin})`);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'hello') {
        extInfo = { ...extInfo, version: msg.version, ua: msg.ua };
        log(`扩展版本 ${msg.version}`);
        return;
      }
      if (msg.type === 'heartbeat') return;

      const slot = pending.get(msg.id);
      if (!slot) return;
      clearTimeout(slot.timer);
      pending.delete(msg.id);
      slot.resolve(msg);
    });

    ws.on('close', () => {
      if (extSocket === ws) {
        extSocket = null;
        stopHeartbeat();
        log('扩展连接已断开');
      }
    });
    ws.on('error', () => {});
  });
});

server.listen(PORT, HOST, () => {
  log(`Chrome Bridge 已启动 → http://${HOST}:${PORT}   扩展端 ws://${HOST}:${PORT}/ext`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('正在关闭…');
    try { extSocket?.close(1000, 'server shutdown'); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1200);
  });
}
