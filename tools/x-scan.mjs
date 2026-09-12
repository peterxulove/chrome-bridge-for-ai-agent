/**
 * 用 Chrome Bridge 抓 x.com 搜索结果（登录态）。
 *
 * 用法: node x-scan.mjs "<查询>" [top|live] [滚动轮次]
 * 输出: 每条含 handle / 时间 / 点赞数 / 正文，便于后续过滤
 */
const PORT = Number(process.env.CB_PORT || 8777);
const BASE = `http://127.0.0.1:${PORT}`;

const cmd = async (c, args = {}, timeout = 60000) => {
  const r = await fetch(`${BASE}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: c, args, timeout }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${c}: ${j.error}`);
  return j;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const EXTRACT = `(() => {
  const out = [];
  for (const a of document.querySelectorAll('article')) {
    let handle = '';
    for (const el of a.querySelectorAll('a[href]')) {
      const h = el.getAttribute('href') || '';
      if (/^\\/[A-Za-z0-9_]{1,15}$/.test(h)) { handle = h.slice(1); break; }
    }
    const t = a.querySelector('time');
    const likeEl = a.querySelector('[data-testid="like"]');
    const likeLabel = likeEl ? (likeEl.getAttribute('aria-label') || '') : '';
    const m = likeLabel.match(/^([\\d.,]+)/);
    out.push({
      handle,
      at: t ? t.getAttribute('datetime') : '',
      likes: m ? Number(m[1].replace(/[,.]/g, '')) : 0,
      text: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
    });
  }
  return out;
})()`;

const [query, mode = 'live', rounds = '8'] = process.argv.slice(2);
if (!query) {
  console.error('用法: node x-scan.mjs "<查询>" [top|live] [滚动轮次]');
  process.exit(1);
}

const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query`
  + (mode === 'live' ? '&f=live' : '');

// 必须用前台标签页：Chrome 会节流后台页的渲染与滚动，导致滚动加载不出新内容
const { tabId } = await cmd('tab.open', { url, active: true }, 60000);
console.error(`# 查询「${query}」 mode=${mode} tabId=${tabId}`);

await wait(5000);

const seen = new Map();
for (let i = 0; i < Number(rounds); i++) {
  const { result } = await cmd('page.eval', { tabId, code: EXTRACT });
  for (const t of result || []) {
    const key = (t.handle || '') + '|' + t.text.slice(0, 80);
    if (t.text && !seen.has(key)) seen.set(key, t);
  }
  await cmd('page.eval', { tabId, code: '(()=>{window.scrollBy(0,1600);return window.scrollY})()' });
  await wait(1400);
}

console.error(`# 累计 ${seen.size} 条（已去重）\n`);
console.log(JSON.stringify([...seen.values()], null, 1));

await cmd('tab.close', { tabId });
