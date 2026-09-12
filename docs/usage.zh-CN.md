# 详细使用文档

面向使用者的完整指南。想看架构和设计取舍，去 [README](../README.zh-CN.md)；
想看桥接协议和二次开发，去 [protocol.md](protocol.md)。

---

## 目录

1. [安装](#1-安装)
2. [启动桥接服务](#2-启动桥接服务)
3. [加载 Chrome 扩展](#3-加载-chrome-扩展)
4. [连通性自检](#4-连通性自检)
5. [命令详解](#5-命令详解)
6. [实战场景](#6-实战场景)
7. [故障排查](#7-故障排查)
8. [性能与注意事项](#8-性能与注意事项)

---

## 1. 安装

### 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | 18+（推荐 22+） | 桥接服务与 CLI 都只需要 Node 内置模块，**无需 npm install** |
| Google Chrome | 116+ | 扩展依赖 MV3 service worker 的 WebSocket 保活（Chrome 116 起） |

### 获取代码

```bash
git clone https://github.com/peterxulove/chrome-bridge-for-ai-agent.git
cd chrome-bridge-for-ai-agent
```

项目是**零依赖**的 —— 没有 `package.json`、没有 `node_modules`、不用 `npm install`。
（WebSocket 服务端是自实现的 `server/ws-lite.mjs`。）

### 作为 WorkBuddy 技能安装（可选）

如果你在 WorkBuddy AI 里用，可以一键装成技能：

```bash
./install.sh                      # 默认装到 ~/.workbuddy-ai/skills/chrome-bridge/
./install.sh /path/to/skills/dir  # 或指定目录
```

装好后，智能体在遇到「需要登录态网页」的任务时会自动想到它。

---

## 2. 启动桥接服务

### 方式 A：用脚本（推荐）

```bash
./start-bridge.sh
```

脚本是**幂等**的：已经在跑就直接返回，不会起第二个实例。

### 方式 B：直接跑

```bash
node server/bridge.mjs
```

前台运行，`Ctrl-C` 停止。日志会打印连接状态，适合调试。

### 方式 C：开机自启（macOS launchd）

如果想让它在后台常驻，写一个 launchd plist：

```bash
cat > ~/Library/LaunchAgents/com.local.chrome-bridge.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local.chrome-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/绝对路径/server/bridge.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/chrome-bridge.log</string>
  <key>StandardErrorPath</key><string>/tmp/chrome-bridge.err</string>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.local.chrome-bridge.plist
```

把 `ProgramArguments` 里的两个路径换成你机器上的真实路径。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CB_PORT` | `8777` | 监听端口 |
| `CB_TOKEN` | 空 | 设置后，HTTP 请求必须带 `x-cb-token` 头 |
| `CB_TIMEOUT` | `30000` | 单条指令的默认超时（毫秒） |
| `CB_ALLOW_NO_ORIGIN` | 未设置 | 设为 `1` 时允许无 `Origin` 的 WebSocket 连接。**仅供自动化测试，日常别开** |

> ⚠️ 智能体执行环境的一个坑：如果你的命令是在 AI 智能体的沙箱里跑的，
> **每条命令结束时整个进程组会被回收** —— `nohup` + `disown` 也救不了。
> 智能体侧需要用「后台任务」方式启动；你自己在终端里跑 `start-bridge.sh` 则不受影响。

---

## 3. 加载 Chrome 扩展

> **为什么必须手动加载？** Chrome 137 起移除了 `--load-extension` 命令行开关，
> 连官方的逃生开关 `--disable-features=DisableLoadExtensionCommandLineSwitch` 也已失效
> （在 Chrome 152 上实测确认，无头和有界面模式都一样）。所以这一步无法自动化。

1. 地址栏输入 `chrome://extensions` 回车
2. 打开右上角的 **开发者模式**
3. 点左上角 **加载已解压的扩展程序**
4. 在文件选择框里选中本仓库的 **`extension/`** 目录（注意选目录本身，不是里面的文件）
5. 列表里出现 **Chrome Bridge — 智能体浏览器控制桥** 即成功

### 确认扩展在工作

点浏览器工具栏上的扩展图标，弹窗会显示：

- **已连接桥接服务** —— 绿灯，说明桥接通了
- **桥接地址** `127.0.0.1:8777`
- **已调试标签页** —— 当前被附加调试器的标签页数量
- **当前标签页** 列表（带 ID，方便你对照 CLI 输出）

如果显示「连不上桥接服务」，说明桥接服务没起来 —— 回到[第 2 步](#2-启动桥接服务)。

弹窗里还有个 **重新连接桥接服务** 按钮，桥接服务重启过之后点一下即可。

### 关于权限提示

安装时 Chrome 会提示扩展可以「读取和更改您在所有网站上的所有数据」以及调试相关权限。
这是 `debugger` + `<all_urls>` 权限导致的，属于**功能必需** —— 详见[安全说明](security.md)。

---

## 4. 连通性自检

```bash
node cli/cb.mjs health
```

期望输出：

```
桥接正常，扩展已连接（v1.0.0）
```

也可以直接打 HTTP 接口看原始状态：

```bash
curl -s --noproxy '*' http://127.0.0.1:8777/health
```

```json
{
  "ok": true,
  "extensionConnected": true,
  "extension": { "origin": "chrome-extension://…", "version": "1.0.0" },
  "port": 8777,
  "pending": 0
}
```

> **`--noproxy '*'` 很重要。** 如果你本机配了 HTTP 代理（`HTTP_PROXY` 环境变量），
> `curl` 会把 `127.0.0.1` 的请求也发给代理，拿到的是代理生成的错误体，
> **而且退出码仍然是 0** —— 会让你误判成「端口被占用」或「服务正常」。
> 加 `--noproxy '*'` 强制直连。

浏览器里也可以直接访问 `http://127.0.0.1:8777/` 看一个状态页。

---

## 5. 命令详解

所有命令都支持 `--json` 输出原始回包（便于脚本解析）。

### `cb health`

桥接与扩展的连接状态。**任何操作之前先跑这个。**

### `cb tabs`

列出所有标签页：

```
 1234  *  GitHub · Where software is built
         https://github.com/
 1240     Google
         https://www.google.com/
```

第一列是 `tabId`，第二列 `*` 表示当前激活的标签页。

### `cb open <url>`

新开标签页并等待加载完成，返回 `tabId`。

```bash
node cli/cb.mjs open https://example.com
# 已打开 tabId=1234  https://example.com/
```

- 加 `--background` 会在后台打开（**注意**：后台标签页会被 Chrome 节流，
  需要滚动加载内容时别用这个）

### `cb info <tabId>` / `cb goto <tabId> <url>`

查看标签页信息 / 让已有标签页跳转。

```bash
node cli/cb.mjs info 1234
node cli/cb.mjs goto 1234 https://example.com/other
```

### `cb text <tabId> [selector]`

取可见文本（`document.body.innerText`）。传 `selector` 则只取该元素的文本。

```bash
node cli/cb.mjs text 1234
node cli/cb.mjs text 1234 "article"
```

### `cb html <tabId> [selector]`

取 HTML 源码。需要解析结构化字段（JSON-LD、meta）时用它。

### `cb snapshot <tabId>`

**最常用的命令之一。** 列出页面上所有可见的可交互元素，每个带一个 `@ref`：

```
URL: https://example.com/login
标题: 登录

@e1  <a>  首页  → https://example.com/
@e2  <input type=text>  用户名
@e3  <input type=password>  密码
@e4  <button>  登录
```

拿到 `@ref` 之后就可以用它来点击/输入 —— **比手写 CSS 选择器稳得多**，
因为 `@ref` 是运行时绑定到具体元素的，不怕类名变化。

### `cb click <tabId> <selector|@ref>`

**真实鼠标点击**（`Input.dispatchMouseEvent`），不是 `element.click()`。
会先把元素滚动到视口中央，再在元素中心点按下并松开。

```bash
node cli/cb.mjs click 1234 @e4
node cli/cb.mjs click 1234 "button.submit"
```

> 为什么要用真实鼠标事件？很多站点（尤其是 SPA）会检查 `event.isTrusted`，
> 或者在 `mousedown`/`mouseup` 上挂逻辑。合成事件会被直接忽略。

### `cb type <tabId> <selector|@ref> <text> [--submit]`

聚焦目标元素、清空、输入文本。加 `--submit` 会再按一次回车。

```bash
node cli/cb.mjs type 1234 @e2 "myuser"
node cli/cb.mjs type 1234 @e3 "mypassword" --submit
```

输入走的是 CDP 的 `Input.insertText`，会触发页面的 `input` 事件，
React/Vue 这类受控组件也能正常收到。

### `cb scroll <tabId> [y]`

按像素滚动，默认 800。

```bash
node cli/cb.mjs scroll 1234 1500
```

### `cb shot <tabId> [out.png] [--full] [--jpeg]`

截图存盘。默认存到 `/tmp/cb-shot-<tabId>-<时间戳>.png`。

```bash
node cli/cb.mjs shot 1234 page.png
node cli/cb.mjs shot 1234 full.png --full    # 整页截图
node cli/cb.mjs shot 1234 page.jpg --jpeg    # 体积更小
```

### `cb eval <tabId> <js>`

在页面上下文里求值，走 CDP `Runtime.evaluate`，**不受页面 CSP 限制**。

```bash
node cli/cb.mjs eval 1234 "document.title"
node cli/cb.mjs eval 1234 "document.querySelectorAll('article').length"
node cli/cb.mjs eval 1234 "({url: location.href, h: document.body.scrollHeight})"
```

返回值会被序列化成 JSON，所以可以直接返回对象和数组。

### `cb cdp <tabId> <Method> [json]`

**逃生舱。** 直接下发任意 CDP 命令：

```bash
node cli/cb.mjs cdp 1234 Page.getLayoutMetrics
node cli/cb.mjs cdp 1234 Runtime.evaluate '{"expression":"1+1","returnByValue":true}'
node cli/cb.mjs cdp 1234 Network.enable
node cli/cb.mjs cdp 1234 Emulation.setDeviceMetricsOverride '{"width":390,"height":844,"deviceScaleFactor":3,"mobile":true}'
```

上面最后一条可以把标签页切成手机视口 —— 用来抓移动端页面。

### `cb raw <cmd> [jsonArgs]`

直接下发桥接指令，用于 `cb` 没封装的命令：

```bash
node cli/cb.mjs raw tab.reload '{"tabId":1234}'
node cli/cb.mjs raw tab.wait '{"tabId":1234,"ms":2000}'
node cli/cb.mjs raw tab.close '{"tabId":1234}'
node cli/cb.mjs raw debug.detach '{"tabId":1234}'
```

完整指令列表见 [protocol.md](protocol.md)。

---

## 6. 实战场景

### 场景一：抓需要登录的页面（X / 推特）

这是本工具最初要解决的问题。**关键在于搜索算子**：

```bash
# 打开搜索页（前台！后台标签页滚动加载不出内容）
node cli/cb.mjs open "https://x.com/search?q=%E5%B9%BF%E5%B7%9E%20since%3A2026-09-08%20min_faves%3A15&src=typed_query"
# → tabId=1234

# 读页面
node cli/cb.mjs text 1234
```

**为什么必须加 `since:` 和 `min_faves:`？**

实测：X 上中文城市名的搜索**被机器人严重刷屏**。

- 「最新」时间线（URL 带 `&f=live`）：63 条帖子**全部是 1 分钟内的新帖，点赞 0–8**，
  内容是模板化的美食接龙、色情引流、"城市名堆砌"式蹭词 —— 基本无有效信息
- 「Top」标签页（不带 `f` 参数）：返回**历史高赞**，可能是一年前的，时效性差

**有效组合是三者叠加**：`关键词 since:YYYY-MM-DD min_faves:N` + Top 排序。

仓库里已经封装好了工具：

```bash
node tools/x-scan.mjs "广州 since:2026-09-08 min_faves:15" top 20 > /tmp/gz.json
```

输出是 JSON 数组，每条含 `handle` / `at` / `likes` / `text`，便于再按点赞数过滤。
工具内部处理了「前台标签页 + 多轮滚动累积去重 + 收尾关标签页」。

> **DOM 只保留约 11 条。** x.com 是虚拟列表，`document.querySelectorAll('article')`
> 永远只能拿到当前可见的那几条。必须**边滚边抓、跨轮次去重**。

### 场景二：填表单并提交

```bash
TAB=$(node cli/cb.mjs open https://example.com/login --json | python3 -c "import sys,json;print(json.load(sys.stdin)['tabId'])")
node cli/cb.mjs snapshot $TAB          # 看有哪些字段，拿到 @ref
node cli/cb.mjs type $TAB @e2 "myuser"
node cli/cb.mjs type $TAB @e3 "mypassword"
node cli/cb.mjs click $TAB @e4         # 点登录按钮
node cli/cb.mjs text $TAB              # 看结果
```

### 场景三：批量截图存档

```bash
for url in https://example.com https://example.org https://example.net; do
  TAB=$(node cli/cb.mjs open "$url" --json | python3 -c "import sys,json;print(json.load(sys.stdin)['tabId'])")
  node cli/cb.mjs shot $TAB "shot-$(echo $url | sed 's|https://||;s|/|_|g').png" --full
  node cli/cb.mjs raw tab.close "{\"tabId\":$TAB}" > /dev/null
done
```

### 场景四：抓懒加载列表

```bash
TAB=1234
for i in $(seq 1 10); do
  node cli/cb.mjs eval $TAB "document.querySelectorAll('article').length"
  node cli/cb.mjs eval $TAB "(()=>{window.scrollBy(0,1600);return window.scrollY})()"
  sleep 1.5
done
```

---

## 7. 故障排查

| 症状 | 原因 | 解法 |
|---|---|---|
| `连不上桥接服务 127.0.0.1:8777` | 桥接没启动 | `./start-bridge.sh` |
| `extension_not_connected` | 扩展没加载 / 被停用 / 桥接重启过 | 检查 `chrome://extensions` 里扩展是否启用；点扩展弹窗的「重新连接桥接服务」 |
| `桥接在跑，但扩展没连上` | 同上 | 同上 |
| `debugger_attach_failed` | 目标是 `chrome://` 页面，或该标签页开着 DevTools | 换成普通网页；关掉 DevTools |
| 指令一直超时 | 标签页已关闭，或页面在弹原生对话框 | `cb tabs` 确认标签页还在；关掉弹窗 |
| 滚动不加载新内容 | 标签页是后台的，被 Chrome 节流 | 用 `cb open`（默认前台），别加 `--background` |
| `curl` 探测本地端口结果反常 | 本机代理拦截了 `127.0.0.1` | 加 `--noproxy '*'` |
| 扩展加载后没反应 | service worker 被浏览器休眠了 | 点扩展图标唤醒；或重新加载扩展 |
| 元素找不到 | 页面还没渲染完 / 在 iframe 里 | 先 `cb eval <tabId> "document.querySelectorAll('article').length"` 判断渲染状态；加 `cb raw tab.wait '{"tabId":N,"ms":1500}'` |

### 看桥接服务的日志

```bash
tail -f /tmp/chrome-bridge.log
```

日志会记录扩展连接/断开、被拒绝的 Origin、心跳超时等事件。

### 重新加载扩展

改过 `extension/` 下的代码后，去 `chrome://extensions` 点该扩展卡片上的**刷新图标**，
然后点扩展弹窗的「重新连接桥接服务」。

---

## 8. 性能与注意事项

- **每条指令一次往返。** 桥接 → 扩展 → CDP → 页面 → 原路返回。本地回环，通常几毫秒到几十毫秒。
- **`page.snapshot` 有上限**，默认最多 200 个元素。
- **截图返回 base64**，整页截图可能几 MB。CLI 会自动落盘，不用担心终端输出。
- **超时默认 30 秒**，`open` / `goto` / `shot` 内部放宽到 25–60 秒。
  需要更久可以设 `CB_TIMEOUT` 环境变量。
- **同时只有一个扩展连接。** 新连接会顶掉旧的（多开浏览器时注意）。
- **不要拿它做高频轮询。** 这是「像人一样操作浏览器」的工具，不是爬虫框架。
  大批量抓取请考虑官方 API。
- **站点风控。** 部分站点对自动化检测严格，存在账号风险。请自行判断，控制频率。

---

## 下一步

- [桥接协议与指令参考](protocol.md) —— 想自己写客户端或加指令
- [安全说明](security.md) —— 权限模型、审计结论
- [README](../README.zh-CN.md) —— 架构与设计取舍
