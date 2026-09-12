#!/usr/bin/env node
/**
 * cb — Chrome Bridge 命令行客户端
 *
 * 把指令 POST 给本地桥接服务，由 Chrome 扩展执行。
 * 所有子命令都支持 `--json` 输出原始回包。
 *
 * 用法见 `cb help`。
 */

import fs from 'node:fs';

const PORT = Number(process.env.CB_PORT || 8777);
const BASE = `http://127.0.0.1:${PORT}`;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const args = argv.filter((a) => !a.startsWith('--'));
const sub = args.shift();

const wantJson = flags.has('--json');
const TIMEOUT = Number(process.env.CB_TIMEOUT || 45000);

function die(msg) {
  console.error(`错误：${msg}`);
  process.exit(1);
}

async function call(cmd, cmdArgs = {}, timeout = TIMEOUT) {
  let res;
  try {
    res = await fetch(`${BASE}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd, args: cmdArgs, timeout }),
    });
  } catch (e) {
    die(`连不上桥接服务 ${BASE} —— 先启动它：node server/bridge.mjs（${e.message}）`);
  }
  const body = await res.json().catch(() => ({}));
  if (!body.ok) die(body.error || `HTTP ${res.status}`);
  return body;
}

const needTab = () => {
  const id = Number(args[0]);
  if (!Number.isFinite(id)) die('需要一个 tabId 参数（用 `cb tabs` 查看）');
  return id;
};

const HELP = `cb — 通过本地桥接服务操作 Chrome

  cb health                     桥接与扩展连接状态
  cb tabs                       列出所有标签页（含 tabId）
  cb open <url>                 新开标签页并等待加载
  cb info <tabId>               标签页的 url / 标题 / 状态
  cb goto <tabId> <url>         当前标签页跳转
  cb text <tabId> [selector]    取页面可见文本
  cb html <tabId> [selector]    取页面 HTML
  cb snapshot <tabId>           列出可交互元素（带 @ref）
  cb click <tabId> <sel|@ref>   真实鼠标点击
  cb type <tabId> <sel|@ref> <text> [--submit]   聚焦输入
  cb scroll <tabId> [y]         滚动
  cb shot <tabId> [out.png] [--full] [--jpeg]    截图
  cb eval <tabId> <js>          在页面里求值（走 CDP，不受 CSP 限制）
  cb cdp <tabId> <Method> [json]  直接下发任意 CDP 命令
  cb raw <cmd> [jsonArgs]       直接下发任意桥接指令

  全局：--json 输出原始回包；CB_PORT / CB_TIMEOUT 环境变量`;

if (!sub || sub === 'help' || flags.has('--help')) {
  console.log(HELP);
  process.exit(0);
}

const out = (obj, human) => {
  if (wantJson) console.log(JSON.stringify(obj, null, 2));
  else console.log(human ?? JSON.stringify(obj, null, 2));
};

switch (sub) {
  case 'health': {
    const r = await fetch(`${BASE}/health`).then((x) => x.json()).catch(() => null);
    if (!r) die(`连不上桥接服务 ${BASE}`);
    out(r, r.extensionConnected
      ? `桥接正常，扩展已连接（v${r.extension?.version || '?'}）`
      : '桥接在跑，但扩展没连上 —— 检查扩展是否已加载、是否被停用');
    break;
  }

  case 'tabs': {
    const r = await call('tabs.list');
    out(r, r.tabs.map((t) => `${String(t.id).padStart(5)}  ${t.active ? '*' : ' '}  ${(t.title || '(无标题)').slice(0, 60)}\n         ${t.url}`).join('\n'));
    break;
  }

  case 'open': {
    const url = args[0] || die('需要 url');
    const r = await call('tab.open', { url, active: !flags.has('--background') });
    out(r, `已打开 tabId=${r.tabId}  ${r.url}`);
    break;
  }

  case 'info': {
    const r = await call('page.info', { tabId: needTab() });
    out(r, `tabId=${r.tabId}\n标题: ${r.title}\n地址: ${r.url}\n状态: ${r.status}`);
    break;
  }

  case 'goto': {
    const tabId = needTab();
    const url = args[1] || die('需要 url');
    const r = await call('tab.goto', { tabId, url }, 60000);
    out(r, `已跳转 → ${r.url}\n标题: ${r.title}`);
    break;
  }

  case 'text': {
    const r = await call('page.text', { tabId: needTab(), selector: args[1] });
    out(r, r.text);
    break;
  }

  case 'html': {
    const r = await call('page.html', { tabId: needTab(), selector: args[1] });
    out(r, r.html);
    break;
  }

  case 'snapshot': {
    const r = await call('page.snapshot', { tabId: needTab() });
    out(r, [
      `URL: ${r.url}`,
      `标题: ${r.title}`,
      ...r.elements.map((e) => `@${e.ref}  <${e.tag}${e.type ? ' type=' + e.type : ''}>  ${e.label}${e.href ? '  → ' + e.href : ''}`),
    ].join('\n'));
    break;
  }

  case 'click': {
    const tabId = needTab();
    const target = args[1] || die('需要 selector 或 @ref');
    const key = target.startsWith('@') ? { ref: target.slice(1) } : { selector: target };
    const r = await call('page.click', { tabId, ...key });
    out(r, `已点击 ${target}  (${r.x},${r.y})`);
    break;
  }

  case 'type': {
    const tabId = needTab();
    const target = args[1] || die('需要 selector 或 @ref');
    const text = args[2] ?? '';
    const key = target.startsWith('@') ? { ref: target.slice(1) } : { selector: target };
    const r = await call('page.type', { tabId, ...key, text, submit: flags.has('--submit') });
    out(r, `已在 ${target} 输入 ${r.typed} 个字符${r.submit ? ' 并回车' : ''}`);
    break;
  }

  case 'scroll': {
    const tabId = needTab();
    const y = Number(args[1] ?? 800);
    const r = await call('page.scroll', { tabId, y });
    out(r, `已滚动 ${y}px`);
    break;
  }

  case 'shot': {
    const tabId = needTab();
    const format = flags.has('--jpeg') ? 'jpeg' : 'png';
    const file = args[1] || `/tmp/cb-shot-${tabId}-${Date.now()}.${format === 'jpeg' ? 'jpg' : 'png'}`;
    const r = await call('page.screenshot', { tabId, format, full: flags.has('--full') }, 60000);
    fs.writeFileSync(file, Buffer.from(r.base64, 'base64'));
    out({ file, bytes: Buffer.from(r.base64, 'base64').length }, `截图已保存：${file}`);
    break;
  }

  case 'eval': {
    const tabId = needTab();
    const code = args.slice(1).join(' ') || die('需要 JS 表达式');
    const r = await call('page.eval', { tabId, code });
    out(r, typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2));
    break;
  }

  case 'cdp': {
    const tabId = needTab();
    const method = args[1] || die('需要 CDP 方法名，例如 Page.navigate');
    let params = {};
    if (args[2]) {
      try { params = JSON.parse(args[2]); } catch { die('第三个参数必须是 JSON'); }
    }
    const r = await call('cdp.send', { tabId, method, params }, 60000);
    out(r, JSON.stringify(r.result, null, 2));
    break;
  }

  case 'raw': {
    const cmd = args[0] || die('需要指令名');
    let cmdArgs = {};
    if (args[1]) {
      try { cmdArgs = JSON.parse(args[1]); } catch { die('第二个参数必须是 JSON'); }
    }
    out(await call(cmd, cmdArgs));
    break;
  }

  default:
    die(`未知子命令：${sub}\n\n${HELP}`);
}
