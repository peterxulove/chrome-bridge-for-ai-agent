/**
 * 桥接服务自测（不需要 Chrome）
 *
 * 自己起一个隔离的桥接实例（独立端口），避免影响正在使用的那个。
 * 覆盖：握手、指令往返、参数透传、错误回传、超时兜底、心跳探活、Origin 校验。
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.TEST_PORT || 8799);
const SERVER = fileURLToPath(new URL('../server/bridge.mjs', import.meta.url));

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? '  → ' + detail : ''}`);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个桥接实例，返回 { child, base } */
async function startServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CB_PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return { child, base: `http://127.0.0.1:${port}`, log: () => log };
    } catch {}
    await wait(150);
  }
  child.kill();
  throw new Error(`桥接服务没在 ${port} 起来：\n${log}`);
}

/** 用原始 socket 发一个带指定 Origin 的 WebSocket 升级请求，返回状态行 */
function tryOrigin(port, origin) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(
        `GET /ext HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
        (origin ? `Origin: ${origin}\r\n` : '') + '\r\n',
      );
    });
    let buf = '';
    s.on('data', (d) => { buf += d.toString(); });
    s.on('close', () => resolve(buf.split('\r\n')[0]));
    s.on('error', () => resolve('ERR'));
    setTimeout(() => { s.destroy(); resolve(buf.split('\r\n')[0] || 'TIMEOUT'); }, 1200);
  });
}

// ---------- 起一个隔离的桥接实例（放开无 Origin，方便用脚本当假扩展） ----------
const { child, base: BASE } = await startServer(PORT, { CB_ALLOW_NO_ORIGIN: '1' });
console.log(`（已在 ${PORT} 端口起了隔离的桥接实例）`);

try {
  // ---------- 假扩展 ----------
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ext`);
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (!msg.id) return;
    let reply = { id: msg.id, ok: true, echoed: msg.cmd, gotArgs: msg.args };
    if (msg.cmd === 'tabs.list') {
      reply.tabs = [{ id: 101, title: '广州新闻（测试）', url: 'https://example.com/gz', active: true }];
    }
    if (msg.cmd === 'boom') reply = { id: msg.id, ok: false, error: '故意抛错' };
    if (msg.cmd === 'no-such-cmd') reply = { id: msg.id, ok: false, error: `unknown_cmd: ${msg.cmd}` };
    if (msg.cmd === 'silent') return; // 不回，验证超时
    ws.send(JSON.stringify(reply));
  });

  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true });
  });
  ws.send(JSON.stringify({ type: 'hello', version: '0.0.1-test' }));
  await wait(200);

  const cmd = async (body) => {
    const r = await fetch(`${BASE}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  console.log('\n[1] 指令往返');
  const h = await (await fetch(`${BASE}/health`)).json();
  ok('扩展被识别为已连接', h.extensionConnected === true, `version=${h.extension?.version}`);

  const t = await cmd({ cmd: 'tabs.list' });
  ok('tabs.list 正常返回', t.status === 200 && t.body.tabs?.[0]?.id === 101);

  const a = await cmd({ cmd: 'page.eval', args: { tabId: 101, code: '1+1' } });
  ok('参数被完整透传', a.body.gotArgs?.tabId === 101 && a.body.gotArgs?.code === '1+1');

  const b = await cmd({ cmd: 'boom' });
  ok('扩展侧错误回传为 500', b.status === 500 && b.body.ok === false, b.body.error);

  const nc = await cmd({ cmd: 'no-such-cmd' });
  ok('未知指令有明确报错', nc.status === 500, nc.body.error);

  console.log('\n[2] 超时与心跳探活');
  const to = await cmd({ cmd: 'silent', timeout: 900 });
  ok('超时被兜住（503）', to.status === 503 && /timeout/.test(to.body.error), to.body.error);

  // 把假扩展的连接掐掉，服务应在心跳周期内自己摘掉这个死连接
  process.stdout.write('  等待心跳探活（约 35 秒）… ');
  ws.close();
  await wait(35000);
  const h2 = await (await fetch(`${BASE}/health`)).json();
  ok('死连接被心跳摘掉', h2.extensionConnected === false, `extensionConnected=${h2.extensionConnected}`);

  console.log('\n[3] Origin 安全校验（当前实例已放开无 Origin）');
  const evil = await tryOrigin(PORT, 'https://evil.example.com');
  ok('恶意网页 Origin 被拒绝', /403/.test(evil), evil);

  const good = await tryOrigin(PORT, 'chrome-extension://abcdefghijklmnop');
  ok('扩展 Origin 被接受', /101/.test(good), good);
} finally {
  try { child.kill(); } catch {}
}

// ---------- 严格模式（默认配置）下的 Origin 校验 ----------
console.log('\n[4] 严格模式：无 Origin 必须被拒');
{
  const strictPort = PORT + 1;
  const { child: strict } = await startServer(strictPort);
  try {
    const none = await tryOrigin(strictPort, '');
    ok('无 Origin 的连接被拒绝', /403/.test(none), none);
    const good = await tryOrigin(strictPort, 'chrome-extension://abcdefghijklmnop');
    ok('扩展 Origin 仍被接受', /101/.test(good), good);
  } finally {
    try { strict.kill(); } catch {}
  }
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
