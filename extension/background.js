/**
 * Chrome Bridge — 扩展执行端（MV3 service worker）
 *
 * 职责：主动连上本地桥接服务（ws://127.0.0.1:8777/ext），
 * 接收指令 → 通过 chrome.debugger(CDP) 操作标签页 → 回传结果。
 *
 * 为什么要走 CDP 而不是纯 scripting：
 *   - Runtime.evaluate 不受页面 CSP 限制
 *   - Input.dispatchMouseEvent / insertText 产生的是「可信事件」，
 *     比 synthetic click 更能骗过真实站点的交互检测
 *   - 能截图、能读无障碍树
 */

const BRIDGE_URL = 'ws://127.0.0.1:8777/ext';
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 15000;

let ws = null;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;
let pingTimer = null;

const attached = new Set();

// ------------------------------------------------------------ 状态上报

async function setStatus(patch) {
  try {
    const { status = {} } = await chrome.storage.session.get('status');
    await chrome.storage.session.set({ status: { ...status, ...patch, at: Date.now() } });
  } catch {}
}

// ------------------------------------------------------------ CDP 基础

function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    const m = String(e?.message || e);
    if (!/already attached/i.test(m)) {
      throw new Error(`debugger_attach_failed: ${m}（若是 chrome:// 页面或已开 DevTools，无法附加）`);
    }
  }
  attached.add(tabId);
  await cdp(tabId, 'Page.enable').catch(() => {});
  await cdp(tabId, 'Runtime.enable').catch(() => {});
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

async function evalRaw(tabId, expression) {
  await ensureAttached(tabId);
  const r = await cdp(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description || d.text || 'evaluate_error');
  }
  return r.result?.value;
}

/** 求值并把结果序列化成可 JSON 传输的形式 */
async function evalJson(tabId, expression) {
  const wrapped =
    `JSON.stringify((() => { const __v = (${expression}); return __v === undefined ? null : __v; })())`;
  const s = await evalRaw(tabId, wrapped);
  if (s === undefined || s === null || s === '') return null;
  try { return JSON.parse(s); } catch { return s; }
}

const J = (v) => JSON.stringify(v);

async function waitForLoad(tabId, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') return t;
    } catch { /* 标签页可能已关闭 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// ------------------------------------------------------------ 指令实现

const handlers = {
  async ping() {
    return { pong: true, at: Date.now() };
  },

  async 'tabs.list'() {
    const tabs = await chrome.tabs.query({});
    return {
      tabs: tabs.map((t) => ({
        id: t.id, windowId: t.windowId, active: t.active,
        title: t.title, url: t.url, status: t.status,
      })),
    };
  },

  async 'tab.open'({ url, active = true } = {}) {
    const t = await chrome.tabs.create({ url: url || 'about:blank', active });
    if (url) await waitForLoad(t.id, 20000);
    return { tabId: t.id, url: (await chrome.tabs.get(t.id)).url };
  },

  async 'tab.close'({ tabId } = {}) {
    await chrome.tabs.remove(tabId);
    attached.delete(tabId);
    return { closed: tabId };
  },

  async 'tab.activate'({ tabId } = {}) {
    const t = await chrome.tabs.update(tabId, { active: true });
    if (t?.windowId != null) {
      try { await chrome.windows.update(t.windowId, { focused: true }); } catch {}
    }
    return { active: tabId };
  },

  async 'tab.reload'({ tabId } = {}) {
    await chrome.tabs.reload(tabId);
    await waitForLoad(tabId);
    return { reloaded: tabId };
  },

  async 'tab.goto'({ tabId, url, wait = true } = {}) {
    await chrome.tabs.update(tabId, { url });
    if (wait) await waitForLoad(tabId, 25000);
    const t = await chrome.tabs.get(tabId);
    return { tabId, url: t.url, title: t.title, status: t.status };
  },

  async 'tab.wait'({ tabId, ms = 1000 } = {}) {
    await new Promise((r) => setTimeout(r, Math.min(ms, 60000)));
    return { waited: ms };
  },

  async 'page.info'({ tabId } = {}) {
    const t = await chrome.tabs.get(tabId);
    return { tabId: t.id, url: t.url, title: t.title, status: t.status };
  },

  async 'page.text'({ tabId, selector } = {}) {
    const expr = selector
      ? `(() => { const el = document.querySelector(${J(selector)}); return el ? el.innerText : null; })()`
      : `document.body ? document.body.innerText : ''`;
    return { text: (await evalJson(tabId, expr)) || '' };
  },

  async 'page.html'({ tabId, selector } = {}) {
    const expr = selector
      ? `(() => { const el = document.querySelector(${J(selector)}); return el ? el.outerHTML : null; })()`
      : `document.documentElement.outerHTML`;
    return { html: (await evalJson(tabId, expr)) || '' };
  },

  async 'page.eval'({ tabId, code } = {}) {
    return { result: await evalJson(tabId, code) };
  },

  async 'page.snapshot'({ tabId, limit = 200 } = {}) {
    const data = await evalJson(tabId, `(() => {
      const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=checkbox],[contenteditable=true]';
      const out = [];
      window.__cbRefs = {};
      let i = 0;
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        const ref = 'e' + (++i);
        window.__cbRefs[ref] = el;
        const label = String(
          el.innerText || el.value || el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') || el.getAttribute('title') || ''
        ).replace(/\\s+/g, ' ').trim().slice(0, 100);
        out.push({
          ref, tag: el.tagName.toLowerCase(), type: el.type || '',
          label, href: el.href || '',
          x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
        });
        if (out.length >= ${Number(limit) || 200}) break;
      }
      return { url: location.href, title: document.title, elements: out };
    })()`);
    return data || { url: '', title: '', elements: [] };
  },

  async 'page.click'({ tabId, selector, ref } = {}) {
    await ensureAttached(tabId);
    const target = ref || selector;
    const rect = await evalJson(tabId, `(() => {
      const el = ${ref
        ? `(window.__cbRefs || {})[${J(ref)}]`
        : `document.querySelector(${J(selector)})`};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!rect || rect.w < 1) throw new Error(`element_not_found_or_invisible: ${target}`);
    const x = Math.round(rect.x), y = Math.round(rect.y);
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return { clicked: target, x, y };
  },

  async 'page.type'({ tabId, selector, ref, text = '', submit = false, clear = true } = {}) {
    await ensureAttached(tabId);
    const target = ref || selector;
    const ok = await evalJson(tabId, `(() => {
      const el = ${ref
        ? `(window.__cbRefs || {})[${J(ref)}]`
        : `document.querySelector(${J(selector)})`};
      if (!el) return false;
      el.focus();
      if (el.isContentEditable) { if (${clear}) el.textContent = ''; }
      else if ('value' in el) { if (${clear}) el.value = ''; }
      return true;
    })()`);
    if (!ok) throw new Error(`element_not_found: ${target}`);
    if (text) await cdp(tabId, 'Input.insertText', { text });
    if (submit) {
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key });
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    }
    return { typed: text.length, target, submit };
  },

  async 'page.scroll'({ tabId, x = 0, y = 800 } = {}) {
    await ensureAttached(tabId);
    await evalJson(tabId, `(() => { window.scrollBy(${Number(x)}, ${Number(y)}); return true; })()`);
    return { scrolled: { x, y } };
  },

  async 'page.screenshot'({ tabId, format = 'png', quality = 80, full = false } = {}) {
    await ensureAttached(tabId);
    const params = { format, captureBeyondViewport: !!full };
    if (format === 'jpeg') params.quality = quality;
    if (full) {
      const m = await cdp(tabId, 'Page.getLayoutMetrics').catch(() => null);
      const cs = m?.cssContentSize || m?.contentSize;
      if (cs) {
        params.clip = { x: 0, y: 0, width: cs.width, height: cs.height, scale: 1 };
      }
    }
    const r = await cdp(tabId, 'Page.captureScreenshot', params);
    return { format, base64: r.data };
  },

  async 'cdp.send'({ tabId, method, params = {} } = {}) {
    if (!method) throw new Error('missing_method');
    await ensureAttached(tabId);
    const r = await cdp(tabId, method, params);
    return { result: r };
  },

  async 'debug.detach'({ tabId } = {}) {
    try { await chrome.debugger.detach({ tabId }); } catch {}
    attached.delete(tabId);
    return { detached: tabId };
  },
};

async function dispatch(cmd, args) {
  const fn = handlers[cmd];
  if (!fn) throw new Error(`unknown_cmd: ${cmd}`);
  return fn(args || {});
}

// ------------------------------------------------------------ WebSocket

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
}

function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectDelay = RECONNECT_MIN;
    setStatus({ connected: true, error: null });
    ws.send(JSON.stringify({
      type: 'hello',
      version: chrome.runtime.getManifest().version,
      ua: navigator.userAgent,
    }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'heartbeat', at: Date.now() }));
    }, 20000);
  };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || !msg.id) return;
    let reply;
    try {
      const data = await dispatch(msg.cmd, msg.args);
      // 注意：业务字段必须放在 id / ok 之前，
      // 否则像 tab.open 返回的 data.id（标签页 id）会覆盖掉请求 id，导致回包对不上。
      const payload = Array.isArray(data)
        ? { data }
        : (data && typeof data === 'object' ? data : { data });
      reply = { ...payload, id: msg.id, ok: true };
    } catch (e) {
      reply = { id: msg.id, ok: false, error: String(e?.message || e) };
    }
    try { ws.send(JSON.stringify(reply)); } catch {}
  };

  ws.onclose = () => {
    clearInterval(pingTimer);
    setStatus({ connected: false, error: 'bridge_closed' });
    scheduleReconnect();
  };

  ws.onerror = () => {
    setStatus({ connected: false, error: 'bridge_unreachable' });
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'reconnect') {
    reconnectDelay = RECONNECT_MIN;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    try { ws?.close(); } catch {}
    ws = null;
    connect();
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === 'status') {
    sendResponse({
      connected: !!(ws && ws.readyState === 1),
      attached: [...attached],
    });
    return true;
  }
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms?.create('cb-keepalive', { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((a) => {
  if (a.name === 'cb-keepalive') connect();
});

connect();
