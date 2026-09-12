# Chrome Bridge for AI Agents

**把「你已经登录好的那个 Chrome」交给 AI 智能体操作。**

Chrome Bridge 让本机 AI 智能体驱动你日常在用的 Chrome —— 读页面、点击、输入、滚动、
截图、执行任意 JS，或直接下发 CDP 命令。因为扩展**跑在你的浏览器里**，
每个请求都天然带着**你自己的 Cookie**，所以需要登录的页面（X/推特、内部后台、SaaS 控制台）
直接就能用。

没有云服务，不需要 API Key，不用导出 Cookie。所有通信都留在 `127.0.0.1`。

[English →](README.md) · [详细使用文档](docs/usage.zh-CN.md) · [安全说明](docs/security.md)

---

## 为什么需要它

大多数浏览器自动化方案都栽在同一件事上：**你没有登录态。**

- 无头爬虫撞上登录墙；
- 社交平台的公开镜像要么已死、要么挡在机器人防护后面；
- 导出 Cookie 既脆弱，又会把凭据落到磁盘上；
- Chrome 136 起，默认配置目录下的 `--remote-debugging-port` 会被直接忽略。

Chrome Bridge 绕开了全部这些问题。扩展装在你日常的浏览器配置里，
主动**向外**连一个极小的本地桥接服务，智能体再通过 HTTP 跟它对话。

## 架构

```
┌─────────────┐   HTTP    ┌──────────────────┐   WebSocket   ┌──────────────────┐   CDP   ┌─────────┐
│   AI 智能体  │ ────────▶ │    桥接服务       │ ◀──────────── │    Chrome 扩展    │ ──────▶ │  标签页  │
│  (cb CLI)   │  127.0.0.1│  (零依赖 Node)    │  127.0.0.1    │   (MV3, SW)      │         │         │
└─────────────┘   :8777   └──────────────────┘    /ext       └──────────────────┘         └─────────┘
```

- **桥接服务**（`server/bridge.mjs`）—— HTTP 收指令，WebSocket 连扩展。只监听回环地址；
  校验 WebSocket 的 `Origin`，普通网页永远连不进来；15 秒心跳探活，死连接自动摘掉。
- **Chrome 扩展**（`extension/`）—— Manifest V3 service worker，主动连桥接，
  用 `chrome.debugger`（即 CDP）执行操作。
- **CLI**（`cli/cb.mjs`）—— 给智能体用的入口。
- **`server/ws-lite.mjs`** —— 自己实现的最小 WebSocket 服务端（RFC 6455）。
  整个项目**零 npm 依赖**。

### 为什么走 CDP 而不是 `chrome.scripting`？

`chrome.debugger` 能做到内容脚本做不到的事：

| 能力 | 为什么重要 |
|---|---|
| `Runtime.evaluate` | 不受页面 CSP 限制，不会有 `unsafe-eval` 问题 |
| `Input.dispatchMouseEvent` / `insertText` | 产生的是**可信事件**，有交互检测的站点依然会响应 |
| `Page.captureScreenshot` | 真实截图，支持整页 |
| 完整 CDP 直通 | DevTools 能做的，智能体都能做 |

## 快速开始

**环境要求**：Node.js 18+（推荐 22+）、Google Chrome。

### 1. 启动桥接服务

```bash
git clone https://github.com/peterxulove/chrome-bridge-for-ai-agent.git
cd chrome-bridge-for-ai-agent
./start-bridge.sh          # 监听 127.0.0.1:8777，幂等，已在跑会直接返回
```

### 2. 加载扩展

Chrome 137 起已移除 `--load-extension`，所以这是**一次性手动步骤**：

1. 打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选择本仓库的 `extension/` 目录

扩展的 service worker 会自动连上桥接服务。点扩展图标可以看连接状态和标签页 ID。

### 3. 验证

```bash
node cli/cb.mjs health     # → extensionConnected: true
node cli/cb.mjs tabs       # 列出所有标签页及其 tabId
```

### 4. 开始用

```bash
node cli/cb.mjs open https://example.com     # → { "tabId": 1234, ... }
node cli/cb.mjs text 1234                    # 读页面文本
node cli/cb.mjs snapshot 1234                # 列出可交互元素（带 @ref）
node cli/cb.mjs click 1234 @e3               # 真实鼠标点击
node cli/cb.mjs type 1234 @e7 "你好" --submit
node cli/cb.mjs shot 1234 page.png --full    # 截图
```

## 命令速查

| 命令 | 说明 |
|---|---|
| `cb health` | 桥接与扩展连接状态 |
| `cb tabs` | 列出所有标签页（含 `tabId`） |
| `cb open <url>` | 新开标签页并等待加载，返回 `tabId` |
| `cb info <tabId>` | 标签页的 URL / 标题 / 状态 |
| `cb goto <tabId> <url>` | 当前标签页跳转 |
| `cb text <tabId> [selector]` | 可见文本 |
| `cb html <tabId> [selector]` | HTML 源码 |
| `cb snapshot <tabId>` | 可交互元素列表，带 `@ref` 与坐标 |
| `cb click <tabId> <selector\|@ref>` | 真实鼠标点击 |
| `cb type <tabId> <selector\|@ref> <text> [--submit]` | 聚焦并输入 |
| `cb scroll <tabId> [y]` | 按像素滚动 |
| `cb shot <tabId> [out.png] [--full] [--jpeg]` | 截图存盘 |
| `cb eval <tabId> <js>` | 在页面内求值 |
| `cb cdp <tabId> <Method> [json]` | 下发任意 CDP 命令 |
| `cb raw <cmd> [jsonArgs]` | 下发任意桥接指令 |

任意命令加 `--json` 输出原始回包。详细用法、实战示例和故障排查见
[详细使用文档](docs/usage.zh-CN.md)。

## 作为 WorkBuddy 技能使用

本仓库同时是一个自包含的[智能体技能](skill/SKILL.md)。安装到 WorkBuddy AI：

```bash
./install.sh     # 复制到 ~/.workbuddy-ai/skills/chrome-bridge/
```

技能里写清楚了**什么时候该用浏览器**、怎么用，以及抓取登录后页面时踩过的那些坑。

## 安全设计

- 桥接服务**只监听 `127.0.0.1`**，不会暴露到你的局域网。
- WebSocket 握手**校验 `Origin`**，只接受 `chrome-extension://` 来源。
  恶意网页即使猜到端口也连不进来。
- 扩展**不读取任何 Cookie，也不向任何地方发送数据**。没有遥测、没有外部端点、
  没有第三方依赖可供投毒。
- 可用 `CB_TOKEN` 环境变量启用共享密钥鉴权。
- `debugger` 权限确实很宽 —— 这是「可信输入事件」和「绕过 CSP 求值」的前提。
  在共用机器上部署前请先读[安全说明](docs/security.md)。

## 已知限制

- **`chrome://` 页面无法附加调试器。** Chrome 的限制，会报 `debugger_attach_failed`。
- **目标标签页开着 DevTools 时无法附加**，需先关掉。
- 附加期间标签页顶部会出现「正在调试此浏览器」提示条，这是 Chrome 的行为，不是本工具。
- **后台标签页会被节流** —— 用 `active: false` 打开的标签页，滚动加载不出新内容。
  需要懒加载的场景请用前台标签页。
- **`--load-extension` 已失效**（Chrome 137+），连
  `--disable-features=DisableLoadExtensionCommandLineSwitch` 这个逃生开关也没用了。只能手动加载。

## 开发与测试

```bash
node tests/test-bridge.mjs      # 桥接协议、超时、心跳、Origin 校验（不需要 Chrome）
node tests/test-extension.mjs   # 扩展逻辑，对着桩化的 chrome API + 假 DOM 跑
node tests/e2e.mjs              # 真浏览器端到端（需先加载扩展）
```

`test-extension.mjs` 把真正的 `background.js` 放进 Node `vm` 上下文里跑，
注入假的 `chrome` 对象和假 DOM —— 这样指令路由错误、生成的表达式字符串错误
**不用开浏览器就能暴露**。`e2e.mjs` 则驱动真实标签页：打开测试页、点按钮、往输入框打字，
并验证页面自己的事件处理器确实被触发了。

![端到端测试](docs/images/e2e-screenshot.png)

## 许可

[MIT](LICENSE)
