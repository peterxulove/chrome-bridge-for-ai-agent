/**
 * 端到端验证：真 Chrome + 真扩展 + 桥接服务 + CLI
 * 需要 Chrome 已经在跑（扩展已加载并连上桥接）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const NODE = process.execPath;
const CB = fileURLToPath(new URL('../cli/cb.mjs', import.meta.url));
const PAGE = 'file://' + fileURLToPath(new URL('./fixtures/test-page.html', import.meta.url));
const SHOT = process.env.CB_SHOT || '/tmp/cb-shot.png';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
};

const cb = (...args) => {
  const out = execFileSync(NODE, [CB, ...args, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
};
const cbText = (...args) =>
  execFileSync(NODE, [CB, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

console.log('\n[1] 连通性');
const h = cb('health');
check('扩展已连上桥接服务', h.extensionConnected === true, JSON.stringify(h.extension));

const before = cb('tabs').tabs.length;

console.log('\n[2] 打开页面与读取');
const opened = cb('open', PAGE);
const tabId = opened.tabId;
check('新开标签页成功', Number.isFinite(tabId), `tabId=${tabId}`);
check('页面已加载完成', /test-page\.html/.test(opened.url || ''), opened.url);

const text = cb('text', String(tabId)).text;
check('读到页面文本', text.includes('Chrome Bridge 测试页'), JSON.stringify(text.slice(0, 40)));
check('初始按钮状态正确', text.includes('未点击'));

const title = cb('eval', String(tabId), 'document.title').result;
check('eval 取到标题', title === 'Chrome Bridge 测试页', String(title));

const info = cb('info', String(tabId));
check('page.info 正常', info.tabId === tabId && info.status === 'complete');

console.log('\n[3] 快照与点击');
const snap = cb('snapshot', String(tabId));
const btn = snap.elements.find((e) => e.ref && e.tag === 'button');
check('快照里找到按钮', !!btn, JSON.stringify(snap.elements.slice(0, 3)));
if (btn) {
  const clicked = cb('click', String(tabId), '@' + btn.ref);
  check('按 @ref 点击成功', Number.isFinite(clicked.x), JSON.stringify(clicked));
  const after = cb('text', String(tabId)).text;
  check('点击真的触发了页面逻辑', after.includes('按钮已被点击'), JSON.stringify(after.match(/按钮状态：\S+/)?.[0]));
}

console.log('\n[4] 输入');
const typed = cb('type', String(tabId), '#inp', '你好广州');
check('输入指令返回正常', typed.typed === 4, JSON.stringify(typed));
const afterType = cb('text', String(tabId)).text;
check('输入事件被页面接收', afterType.includes('输入内容：你好广州'), JSON.stringify(afterType.match(/输入回显：\S+/)?.[0]));

console.log('\n[5] 截图与 CDP');
const shot = cb('shot', String(tabId), SHOT);
const size = fs.statSync(SHOT).size;
check('截图文件已生成且非空', size > 2000, `${size} bytes`);
check('截图是合法 PNG', fs.readFileSync(SHOT).subarray(1, 4).toString() === 'PNG');

const cdp = cb('cdp', String(tabId), 'Runtime.evaluate', JSON.stringify({ expression: '1+1', returnByValue: true }));
check('任意 CDP 命令可下发', cdp.result?.result?.value === 2, JSON.stringify(cdp.result?.result));

console.log('\n[6] 收尾');
const closed = cb('raw', 'tab.close', JSON.stringify({ tabId }));
check('关闭标签页成功', closed.closed === tabId);
const after = cb('tabs').tabs.length;
check('标签页数量回到初始值', after === before, `${before} → ${after}`);

console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
