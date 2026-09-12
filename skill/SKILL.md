---
name: chrome-bridge
agent_created: true
description: 操作本机 Chrome 浏览器。通过「Chrome 扩展 + 本地桥接服务」把用户真实浏览器的控制权交给智能体，用的是用户自己的登录态，因此能访问需要登录的站点（x.com、内部系统、后台等）。触发场景：需要打开/切换标签页、读取页面内容、点击、输入、滚动、截图、执行页面 JS、下发任意 CDP 命令；或需要抓取登录后才能看到的页面（例如「上 X 搜一下…」「登录后才能看的后台数据」）。
---

# Chrome Bridge — 操作本机 Chrome

## 它解决什么问题

默认情况下智能体抓不了需要登录的页面：x.com、内部后台、SaaS 控制台，抓取工具拿到的只有登录墙。
本技能把「用户已经登录好的那个 Chrome」变成可控浏览器 —— 扩展跑在用户浏览器里，
**用的是用户自己的 Cookie**，所以登录态天然可用。

## 架构

```
智能体 → cb.mjs (CLI) → HTTP 127.0.0.1:8777 → 桥接服务 → WebSocket → Chrome 扩展 → CDP → 标签页
```

- **桥接服务** `scripts/bridge.mjs`：只监听回环地址；WebSocket 仅接受 `chrome-extension://` 来源，
  网页无法连入。15 秒心跳探活，扩展假死会被摘掉。
- **Chrome 扩展** `extension/`：MV3，service worker 主动连桥接；用 `chrome.debugger`（CDP）执行操作。
- **CLI** `scripts/cb.mjs`：给智能体用的命令行入口。

## 前置条件（缺一不可）

1. **桥接服务在跑**。先执行 `start-bridge.sh`（幂等，已在跑会直接返回）。
2. **扩展已加载**。Chrome 137 起已移除 `--load-extension`，**无法用命令行加载**，
   必须由用户手动加载一次：打开 `chrome://extensions` → 右上角打开「开发者模式」→
   「加载已解压的扩展程序」→ 选择本技能的 `extension` 目录。
   加载后扩展的 service worker 会自动连上桥接。
3. 用 `node scripts/cb.mjs health` 确认 `extensionConnected: true`。

### ⚠️ 启动桥接服务的方式（踩过的坑）

**智能体侧启动**：必须用后台任务方式启动（Bash 工具的 `run_in_background`）。
实测这个执行环境会在**每条命令结束时回收整个进程组**，`nohup` + `disown` **也救不了** ——
命令返回后进程立刻消失，下一次命令里 `/health` 就连不上了。

```bash
# 智能体侧：后台常驻启动
cd <技能目录> && node scripts/bridge.mjs      # 用 run_in_background 执行
```

**用户侧启动**：用户在**自己的终端**里跑 `start-bridge.sh`，`nohup` 是正常生效的，
服务会一直挂着，不受上述限制。

## 命令

```bash
NODE=<node 可执行文件>
CB="$NODE <技能目录>/scripts/cb.mjs"

$CB health                          # 桥接 + 扩展连接状态
$CB tabs                            # 列出标签页（拿到 tabId）
$CB open <url>                      # 新开标签页并等待加载，返回 tabId
$CB info <tabId>                    # 该标签页的 url / 标题 / 状态
$CB goto <tabId> <url>              # 当前标签页跳转
$CB text <tabId> [selector]         # 读可见文本
$CB html <tabId> [selector]         # 读 HTML
$CB snapshot <tabId>                # 列出可交互元素，带 @ref 和坐标
$CB click <tabId> <selector|@ref>   # 真实鼠标点击
$CB type <tabId> <selector|@ref> <text> [--submit]
$CB scroll <tabId> [y]
$CB shot <tabId> [out.png] [--full] [--jpeg]
$CB eval <tabId> <js>               # 页面内求值
$CB cdp <tabId> <Method> [json]     # 任意 CDP 命令
$CB raw <cmd> [jsonArgs]            # 任意桥接指令
```

所有命令加 `--json` 输出原始回包，便于脚本解析。

## 推荐工作流

**抓登录后才可见的内容**（例如 x.com 搜索）：

1. `$CB open "https://x.com/search?q=关键词&f=live"` → 记下返回的 `tabId`
2. `$CB text <tabId>` → 页面可见文本，直接读结果
3. 需要翻页/展开时：`$CB scroll <tabId> 1500` 再 `$CB text <tabId>`
4. 读完 `$CB raw tab.close '{"tabId":<tabId>}'` 收尾

**要点击或输入**：先 `$CB snapshot <tabId>` 拿到 `@ref`，再用 `@ref` 操作，比写选择器稳。
点击走的是 CDP 的真实鼠标事件，不是 synthetic click，能触发站点的交互逻辑。

**遇到 SPA 动态加载**：`text` 拿到的是当前 DOM 快照，先用 `$CB eval <tabId> "document.querySelectorAll('article').length"` 判断内容是否已渲染，必要时 `$CB raw tab.wait '{"tabId":N,"ms":1500}'`。

## 已知限制（踩过的坑，别重复试）

- **后台标签页会被 Chrome 节流**：用 `active: false` 开的标签页，滚动**加载不出新内容**
  （实测滚动 15 轮只拿到 5 条，改成前台立刻变成 63 条）。
  需要滚动加载的场景，一律用 `tab.open` 的 `active: true`（默认值）。
- **chrome:// 页面无法附加调试器**，会报 `debugger_attach_failed`。这是 Chrome 的限制。
- **同一标签页开了 DevTools 时无法附加**，需先关掉 DevTools。
- 首次对某标签页执行操作时，Chrome 顶部会出现「正在调试此浏览器」提示条，属正常现象。
- 扩展加载后如果桥接服务重启过，等几秒会自动重连；也可在扩展弹窗点「重新连接桥接服务」。
- **不要用 `curl` 探测 `127.0.0.1` 的端口来判断占用** —— 本机命令走 HTTP 代理，
  curl 会拿到代理生成的错误体且退出码仍为 0。要加 `--noproxy '*'`。
- Node 的 `fetch` 不走 `HTTP_PROXY` 环境变量，所以 CLI 访问 127.0.0.1 不受代理影响。

## 实战配方：抓 x.com 的搜索结果

x.com 上中文城市名（如「广州」）的搜索**被机器人严重刷屏**：
「最新」时间线里 60 多条帖子全是 1 分钟内的 0–8 赞模板帖，基本无有效信息；
「Top」标签页又返回历史高赞（可能是一年前的），时效性差。

**有效组合**：`关键词 since:YYYY-MM-DD min_faves:N` + `Top` 排序。三者叠加才拿得到可读内容。

已经封装成现成工具，直接用：

```bash
# 用法: node tools/x-scan.mjs "<查询>" [top|live] [滚动轮次]
node tools/x-scan.mjs "广州 since:2026-09-08 min_faves:15" top 20 > /tmp/gz.json
```

输出是 JSON 数组，每条含 `handle` / `at` / `likes` / `text`，便于再按点赞数过滤。
工具内部已处理「前台标签页 + 多轮滚动累积去重 + 收尾关标签页」。

手动实现的话，关键三步：

```bash
# 1. 前台打开搜索页（必须 active，否则滚动加载不出内容）
#    f=live 是最新排序；不带 f 参数是 Top（互动量排序）
$CB open "https://x.com/search?q=%E5%B9%BF%E5%B7%9E%20since%3A2026-09-08%20min_faves%3A15&src=typed_query"

# 2. 反复「取快照 → 滚动」累积。注意 DOM 只保留约 11 条，必须多轮累积去重
$CB eval <tabId> "Array.from(document.querySelectorAll('article')).map(a=>({h:[...a.querySelectorAll('a[href]')].map(x=>x.getAttribute('href')).find(x=>/^\/[A-Za-z0-9_]{1,15}$/.test(x)), t:a.querySelector('time')?.getAttribute('datetime'), text:a.innerText.replace(/\s+/g,' ').slice(0,400)}))"
$CB eval <tabId> "(()=>{window.scrollBy(0,1600);return window.scrollY})()"

# 3. 收尾
$CB raw tab.close '{"tabId":<tabId>}'
```

取点赞数用于质量过滤：`a.querySelector('[data-testid="like"]')?.getAttribute('aria-label')`。

## 自检

```bash
node tests/test-bridge.mjs      # 桥接协议 + Origin 校验（不需要 Chrome）
node tests/test-extension.mjs   # 扩展逻辑离线验证（假 chrome API + 假 DOM）
node tests/e2e.mjs              # 真 Chrome 端到端（需要扩展已加载）
```
