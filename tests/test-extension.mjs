/**
 * 扩展逻辑离线验证
 *
 * 思路：把 background.js 放进一个 Node vm 上下文，注入假的 chrome API、
 * 假 WebSocket、假 DOM，然后逐条下发指令，检查它到底调了哪些 chrome API、
 * 生成并执行了什么表达式、回传了什么结果。
 *
 * 这样能验证到真正的风险点：指令路由、参数透传、生成的表达式字符串是否正确。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../extension/background.js', import.meta.url));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
};

// ---------------------------------------------------------------- 假 DOM

function makeEl(tag, opts = {}) {
  return {
    tagName: tag.toUpperCase(),
    type: opts.type || '',
    value: opts.value ?? '',
    innerText: opts.innerText || '',
    href: opts.href || '',
    isContentEditable: false,
    _attrs: opts.attrs || {},
    getAttribute(k) { return this._attrs[k] ?? null; },
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 30, right: 110, bottom: 50 }),
    scrollIntoView() {}, focus() {},
  };
}

const ELS = {
  button: makeEl('button', { innerText: '点我一下', attrs: { 'aria-label': '点我一下' } }),
  input: makeEl('input', { type: 'text', attrs: { placeholder: '在这里输入' } }),
  a: makeEl('a', { innerText: '新闻链接', href: 'https://example.com/news' }),
};

const documentStub = {
  title: 'Chrome Bridge 测试页',
  body: { innerText: 'Chrome Bridge 测试页\n点我一下\n未点击' },
  documentElement: { outerHTML: '<html><body>stub</body></html>' },
  querySelector: (sel) => {
    const map = { button: ELS.button, input: ELS.input, a: ELS.a, '#btn': ELS.button, '#inp': ELS.input };
    return map[sel] ?? null;
  },
  querySelectorAll: () => [ELS.a, ELS.button, ELS.input],
};

// ---------------------------------------------------------------- 假 chrome

const calls = [];
let attached = new Set();
const tabs = new Map([
  [101, { id: 101, windowId: 1, active: true, title: '已有标签页', url: 'https://example.com/', status: 'complete' }],
]);

const chromeStub = {
  runtime: {
    getManifest: () => ({ version: '1.0.0' }),
    onStartup: { addListener() {} },
    onInstalled: { addListener() {} },
    onMessage: { addListener() {} },
  },
  tabs: {
    async query() { return [...tabs.values()]; },
    async get(id) {
      if (!tabs.has(id)) throw new Error('No tab with id: ' + id);
      return tabs.get(id);
    },
    async create({ url, active }) {
      const id = 200 + tabs.size;
      tabs.set(id, { id, windowId: 1, active: !!active, title: '新标签页', url, status: 'complete' });
      return tabs.get(id);
    },
    async update(id, props) {
      const t = tabs.get(id);
      if (props.url) { t.url = props.url; t.status = 'complete'; }
      return t;
    },
    async remove(id) { tabs.delete(id); },
    async reload(id) { calls.push(['tabs.reload', id]); },
  },
  windows: { async update() {} },
  storage: {
    session: {
      _d: {},
      async get(k) { return { [k]: this._d[k] }; },
      async set(o) { Object.assign(this._d, o); },
    },
  },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  debugger: {
    onDetach: { addListener() {} },
    async attach(target) {
      if (attached.has(target.tabId)) {
        throw new Error('Another debugger is already attached to the tab with id: ' + target.tabId);
      }
      attached.add(target.tabId);
      calls.push(['debugger.attach', target.tabId]);
    },
    async detach(target) { attached.delete(target.tabId); },
    async sendCommand(target, method, params) {
      calls.push(['cdp', method, params]);
      if (method === 'Page.enable' || method === 'Runtime.enable') return {};

      if (method === 'Runtime.evaluate') {
        const ctx = vm.createContext({
          document: documentStub,
          location: { href: 'file:///tmp/cb-test-page.html' },
          window: {},
          getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
          JSON, Math, String, Number, Boolean, Array, Object, Date, RegExp, Error,
        });
        try {
          const value = vm.runInContext(params.expression, ctx, { timeout: 2000 });
          return { result: { value } };
        } catch (e) {
          return { exceptionDetails: { text: String(e.message) } };
        }
      }

      if (method === 'Page.captureScreenshot') {
        return { data: Buffer.from('FAKE-PNG-DATA-'.repeat(200)).toString('base64') };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssContentSize: { width: 800, height: 1200 } };
      }
      if (method === 'Input.dispatchMouseEvent') return {};
      if (method === 'Input.insertText') { calls.push(['insertText', params.text]); return {}; }
      if (method === 'Input.dispatchKeyEvent') { calls.push(['key', params.key]); return {}; }
      return {};
    },
  },
};

// ---------------------------------------------------------------- 假 WebSocket

const sent = [];
let sock = null;
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    sock = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(d) { sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; this.onclose?.(); }
}

// ---------------------------------------------------------------- 装载

const sandbox = {
  chrome: chromeStub,
  WebSocket: FakeWebSocket,
  navigator: { userAgent: 'Mozilla/5.0 (TestHarness)' },
  console,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  JSON, Math, Date, Promise, Error, Object, Array, String, Number, Boolean, Buffer,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'background.js' });
await new Promise((r) => setTimeout(r, 30));

const call = async (cmd, args = {}) => {
  sent.length = 0;
  const id = 'test-' + Math.random();
  await sock.onmessage({ data: JSON.stringify({ id, cmd, args }) });
  const reply = sent.find((m) => m.id === id);
  if (!reply) {
    console.log(`     ⚠ ${cmd} 的回包 id 对不上（业务字段覆盖了请求 id？）原始回包: ${JSON.stringify(sent[0])}`);
  }
  return reply;
};

console.log('\n[1] 启动与握手');
check('连上了桥接地址', sock?.url === 'ws://127.0.0.1:8777/ext', sock?.url);
check('发出了 hello 握手', sent.some((m) => m.type === 'hello'), JSON.stringify(sent[0]));

console.log('\n[2] 基础指令');
let r = await call('ping');
check('ping 回 pong', r?.ok === true && r.pong === true);

r = await call('tabs.list');
check('tabs.list 返回标签页', Array.isArray(r?.tabs) && r.tabs[0].id === 101, JSON.stringify(r));

const opened = await call('tab.open', { url: 'https://example.com/x', active: true });
check('tab.open 建了新标签页', Number.isFinite(opened?.tabId) && opened.tabId !== 101, JSON.stringify(opened));
check('tab.open 回包 id 仍是请求 id（未被标签页 id 覆盖）', opened?.ok === true);

r = await call('page.info', { tabId: 101 });
check('page.info 返回 url/标题', r?.url === 'https://example.com/' && r.title === '已有标签页', JSON.stringify(r));

r = await call('tab.close', { tabId: opened.tabId });
check('tab.close 生效', r?.closed === opened.tabId, JSON.stringify(r));

console.log('\n[3] 读取与求值');
r = await call('page.text', { tabId: 101 });
check('page.text 取到正文', /测试页/.test(r?.text || ''), JSON.stringify(r?.text));

r = await call('page.eval', { tabId: 101, code: 'document.title' });
check('page.eval 返回标题', r?.result === 'Chrome Bridge 测试页', JSON.stringify(r));

r = await call('page.eval', { tabId: 101, code: '({a:1,b:[2,3]})' });
check('page.eval 能回传对象', r?.result?.a === 1 && r.result.b[1] === 3, JSON.stringify(r?.result));

r = await call('page.eval', { tabId: 101, code: 'nope.x.y' });
check('页面里抛错能被捕获', r?.ok === false, JSON.stringify(r?.error));

console.log('\n[4] 表达式生成是否正确（重点看引号转义）');
r = await call('page.text', { tabId: 101, selector: '#btn' });
check('带 selector 的取文本正常', r?.ok === true, JSON.stringify(r));

r = await call('page.click', { tabId: 101, selector: "button[data-x='a\"b']" });
check('选择器里的引号没把表达式弄坏（报的是找不到元素，不是语法错误）',
  r?.ok === false && /element_not_found_or_invisible/.test(r.error) && !/SyntaxError|Unexpected/.test(r.error),
  r?.error);

r = await call('page.type', { tabId: 101, selector: '#inp', text: '你好广州 "引号" \'单引\'', submit: true });
check('输入含引号的中文正常', r?.ok === true && r.typed > 0, JSON.stringify(r?.error || r));
check('真的把文本发给了 CDP insertText', calls.some((c) => c[0] === 'insertText' && c[1].includes('你好广州')));
check('submit 触发了回车', calls.some((c) => c[0] === 'key' && c[1] === 'Enter'));

console.log('\n[5] 快照 / 截图 / 任意 CDP');
r = await call('page.snapshot', { tabId: 101 });
check('快照列出可交互元素', r?.elements?.length === 3, JSON.stringify(r?.elements?.map((e) => e.ref)));
check('快照元素带 @ref 和坐标', r.elements[0].ref === 'e1' && Number.isFinite(r.elements[0].x));

r = await call('page.screenshot', { tabId: 101, format: 'png' });
check('截图返回 base64', typeof r?.base64 === 'string' && r.base64.length > 100);
check('截图结果没被 JSON 包坏', !/^"/.test(r.base64.slice(0, 1)));

r = await call('cdp.send', { tabId: 101, method: 'Page.getLayoutMetrics', params: {} });
check('任意 CDP 命令可下发', r?.result?.cssContentSize?.width === 800, JSON.stringify(r?.result));

console.log('\n[6] 错误处理');
r = await call('no-such-cmd', {});
check('未知指令返回明确错误', r?.ok === false && /unknown_cmd/.test(r.error), r?.error);

r = await call('page.info', { tabId: 99999 });
check('标签页不存在时错误可读', r?.ok === false, r?.error);

check('debugger.attach 只对每个 tab 调一次', calls.filter((c) => c[0] === 'debugger.attach').length === 1,
  JSON.stringify(calls.filter((c) => c[0] === 'debugger.attach')));

console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
