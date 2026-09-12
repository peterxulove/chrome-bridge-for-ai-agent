const $ = (id) => document.getElementById(id);

async function render() {
  const { status = {} } = await chrome.storage.session.get('status');
  const on = !!status.connected;

  $('dot').className = 'dot' + (on ? ' on' : '');
  $('state').textContent = on ? '已连接桥接服务' : '未连接';
  $('at').textContent = status.at ? new Date(status.at).toLocaleTimeString('zh-CN') : '—';

  if (!on && status.error) {
    $('state').textContent = status.error === 'bridge_unreachable'
      ? '连不上桥接服务（先启动它）'
      : '未连接';
  }

  const tabs = await chrome.tabs.query({});
  $('tabs').innerHTML = '';
  for (const t of tabs) {
    const div = document.createElement('div');
    div.className = 'tab' + (t.active ? ' act' : '');
    div.innerHTML = `<span class="tid">${t.id}</span><span class="ttext"></span>`;
    div.querySelector('.ttext').textContent = t.title || t.url || '(无标题)';
    div.title = t.url || '';
    $('tabs').appendChild(div);
  }

  const info = await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null);
  $('attached').textContent = info?.attached?.length ?? 0;
}

$('reconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => {});
  $('state').textContent = '重连中…';
  setTimeout(render, 900);
});

$('openbridge').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://127.0.0.1:8777/' });
});

render();
setInterval(render, 2000);
