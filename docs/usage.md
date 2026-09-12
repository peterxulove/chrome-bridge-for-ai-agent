# Usage Guide

The complete guide for users. For architecture and design trade-offs see the
[README](../README.md); for the bridge protocol and extension development see [protocol.md](protocol.md).

---

## Contents

1. [Installation](#1-installation)
2. [Starting the bridge](#2-starting-the-bridge)
3. [Loading the extension](#3-loading-the-extension)
4. [Connectivity check](#4-connectivity-check)
5. [Command reference](#5-command-reference)
6. [Worked examples](#6-worked-examples)
7. [Troubleshooting](#7-troubleshooting)
8. [Performance notes](#8-performance-notes)

---

## 1. Installation

### Requirements

| Dependency | Version | Notes |
|---|---|---|
| Node.js | 18+ (22+ recommended) | The bridge and CLI use only Node built-ins — **no `npm install` needed** |
| Google Chrome | 116+ | The extension relies on MV3 service-worker WebSocket keepalive (Chrome 116+) |

### Get the code

```bash
git clone https://github.com/peterxulove/chrome-bridge-for-ai-agent.git
cd chrome-bridge-for-ai-agent
```

The project is **dependency-free** — no `package.json`, no `node_modules`, no `npm install`.
(The WebSocket server is a hand-rolled implementation in `server/ws-lite.mjs`.)

### Install as a WorkBuddy skill (optional)

If you use WorkBuddy AI, you can install this as a skill:

```bash
./install.sh                      # installs to ~/.workbuddy-ai/skills/chrome-bridge/
./install.sh /path/to/skills/dir  # or a custom location
```

Once installed, the agent will reach for the browser automatically when a task needs
login-gated pages.

---

## 2. Starting the bridge

### Option A: the script (recommended)

```bash
./start-bridge.sh
```

The script is **idempotent** — if the bridge is already running it just returns.

### Option B: run it directly

```bash
node server/bridge.mjs
```

Runs in the foreground; `Ctrl-C` stops it. Logs connection events, handy while debugging.

### Option C: run at login (macOS launchd)

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
    <string>/absolute/path/to/server/bridge.mjs</string>
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

Replace both paths in `ProgramArguments` with the real ones on your machine.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CB_PORT` | `8777` | Listening port |
| `CB_TOKEN` | empty | When set, HTTP requests must include an `x-cb-token` header |
| `CB_TIMEOUT` | `30000` | Default per-command timeout (ms) |
| `CB_ALLOW_NO_ORIGIN` | unset | Set to `1` to accept WebSocket connections without an `Origin` header. **Test automation only — don't enable it in normal use** |

> ⚠️ **Sandboxed-agent gotcha:** if you launch the bridge from inside an AI agent's sandbox,
> the whole process group is reclaimed when the command returns — `nohup` + `disown` won't
> save it. The agent must use a managed background task. Launching from your own terminal
> with `start-bridge.sh` is unaffected.

---

## 3. Loading the extension

> **Why is this manual?** Chrome 137 removed the `--load-extension` command-line switch, and the
> official escape hatch `--disable-features=DisableLoadExtensionCommandLineSwitch` no longer
> works either (verified on Chrome 152, both headless and headed). There is no way to automate
> this step.

1. Navigate to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the **`extension/`** folder in this repo (the folder itself, not a file inside it)
5. **Chrome Bridge** appears in the list — you're done

### Confirming it works

Click the extension icon in the toolbar. The popup shows:

- **Connected to bridge** — green dot means the bridge is reachable
- **Bridge address** `127.0.0.1:8777`
- **Debugged tabs** — how many tabs currently have the debugger attached
- **Open tabs** with their IDs, so you can cross-reference CLI output

If it says it can't reach the bridge, the bridge isn't running — go back to
[step 2](#2-starting-the-bridge). There's also a **Reconnect** button for after a bridge restart.

### About the permission prompt

Chrome will warn that the extension can "read and change all your data on all websites", plus
debugging-related permissions. This comes from the `debugger` and `<all_urls>` permissions and
is **required for the feature set** — see [security.md](security.md).

---

## 4. Connectivity check

```bash
node cli/cb.mjs health
```

Expected:

```
桥接正常，扩展已连接（v1.0.0）
```

Or hit the HTTP endpoint directly:

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

> **`--noproxy '*'` matters.** If your machine has an HTTP proxy configured (`HTTP_PROXY`),
> `curl` will route `127.0.0.1` requests through it and you'll get the proxy's own error body —
> **with exit code 0** — which makes you misread "port in use" or "service healthy".
> `--noproxy '*'` forces a direct connection.

You can also open `http://127.0.0.1:8777/` in a browser for a small status page.

---

## 5. Command reference

Every command accepts `--json` for the raw response (useful for scripting).

### `cb health`

Bridge and extension connection status. **Run this before anything else.**

### `cb tabs`

```
 1234  *  GitHub · Where software is built
         https://github.com/
 1240     Google
         https://www.google.com/
```

First column is the `tabId`; `*` marks the active tab.

### `cb open <url>`

Opens a new tab, waits for load, returns `tabId`.

```bash
node cli/cb.mjs open https://example.com
# 已打开 tabId=1234  https://example.com/
```

- `--background` opens it in the background (**note:** background tabs are throttled by
  Chrome — don't use this if you need scrolling to load content)

### `cb info <tabId>` / `cb goto <tabId> <url>`

Inspect a tab, or navigate an existing one.

```bash
node cli/cb.mjs info 1234
node cli/cb.mjs goto 1234 https://example.com/other
```

### `cb text <tabId> [selector]`

Visible text (`document.body.innerText`). With a `selector`, only that element's text.

### `cb html <tabId> [selector]`

HTML source. Use this when you need structured fields (JSON-LD, meta tags).

### `cb snapshot <tabId>`

**One of the most useful commands.** Lists every visible interactive element with a `@ref`:

```
URL: https://example.com/login
标题: Sign in

@e1  <a>  Home  → https://example.com/
@e2  <input type=text>  Username
@e3  <input type=password>  Password
@e4  <button>  Sign in
```

`@ref` handles are bound to elements at runtime, so they're **far more robust than CSS
selectors** — class names can change, refs can't drift.

### `cb click <tabId> <selector|@ref>`

A **real mouse click** (`Input.dispatchMouseEvent`), not `element.click()`. The element is
scrolled to the centre of the viewport first, then pressed and released at its centre point.

```bash
node cli/cb.mjs click 1234 @e4
node cli/cb.mjs click 1234 "button.submit"
```

> Why real input events? Many sites — especially SPAs — check `event.isTrusted`, or attach
> logic to `mousedown`/`mouseup`. Synthetic events are silently ignored.

### `cb type <tabId> <selector|@ref> <text> [--submit]`

Focuses the target, clears it, and types. `--submit` also presses Enter.

```bash
node cli/cb.mjs type 1234 @e2 "myuser"
node cli/cb.mjs type 1234 @e3 "mypassword" --submit
```

Typing uses CDP `Input.insertText`, which fires the page's `input` events — React/Vue
controlled components receive it correctly.

### `cb scroll <tabId> [y]`

Scrolls by pixels (default 800).

### `cb shot <tabId> [out.png] [--full] [--jpeg]`

Screenshot to disk. Defaults to `/tmp/cb-shot-<tabId>-<timestamp>.png`.

```bash
node cli/cb.mjs shot 1234 page.png
node cli/cb.mjs shot 1234 full.png --full    # full page
node cli/cb.mjs shot 1234 page.jpg --jpeg    # smaller file
```

### `cb eval <tabId> <js>`

Evaluates in the page context via CDP `Runtime.evaluate` — **not subject to the page's CSP**.

```bash
node cli/cb.mjs eval 1234 "document.title"
node cli/cb.mjs eval 1234 "document.querySelectorAll('article').length"
node cli/cb.mjs eval 1234 "({url: location.href, h: document.body.scrollHeight})"
```

Return values are JSON-serialised, so objects and arrays come back intact.

### `cb cdp <tabId> <Method> [json]`

**The escape hatch.** Send any CDP command:

```bash
node cli/cb.mjs cdp 1234 Page.getLayoutMetrics
node cli/cb.mjs cdp 1234 Runtime.evaluate '{"expression":"1+1","returnByValue":true}'
node cli/cb.mjs cdp 1234 Emulation.setDeviceMetricsOverride '{"width":390,"height":844,"deviceScaleFactor":3,"mobile":true}'
```

That last one switches the tab to a mobile viewport — handy for scraping mobile layouts.

### `cb raw <cmd> [jsonArgs]`

Send a bridge command the CLI doesn't wrap:

```bash
node cli/cb.mjs raw tab.reload '{"tabId":1234}'
node cli/cb.mjs raw tab.wait '{"tabId":1234,"ms":2000}'
node cli/cb.mjs raw tab.close '{"tabId":1234}'
node cli/cb.mjs raw debug.detach '{"tabId":1234}'
```

Full command list in [protocol.md](protocol.md).

---

## 6. Worked examples

### Example 1: Scraping a login-gated site (X / Twitter)

This is the problem the project was originally built for. **The search operators are the trick:**

```bash
node cli/cb.mjs open "https://x.com/search?q=guangzhou%20since%3A2026-09-08%20min_faves%3A15&src=typed_query"
# → tabId=1234
node cli/cb.mjs text 1234
```

**Why `since:` and `min_faves:` are mandatory:**

X's Chinese-language search for a city name is **heavily flooded by bots**.

- The **Latest** timeline (URL with `&f=live`) returned 63 posts — **all under a minute old,
  with 0–8 likes**, consisting of templated food-chat copy, adult-service spam, and
  keyword-stuffed city-name lists. Essentially no signal.
- The **Top** tab (no `f` param) returns **all-time top posts**, sometimes a year old — poor recency.

**The working combination is all three:** `keyword since:YYYY-MM-DD min_faves:N` + Top ordering.

A helper is included:

```bash
node tools/x-scan.mjs "广州 since:2026-09-08 min_faves:15" top 20 > /tmp/gz.json
```

Output is a JSON array with `handle` / `at` / `likes` / `text` per post, so you can filter
further by engagement. The tool handles "foreground tab + multi-round scroll accumulation +
dedupe + close tab" internally.

> **The DOM only holds ~11 posts.** x.com is a virtualised list, so
> `document.querySelectorAll('article')` only ever returns what's currently on screen.
> You must **scroll and collect across rounds, deduping as you go**.

### Example 2: Fill and submit a form

```bash
TAB=$(node cli/cb.mjs open https://example.com/login --json | python3 -c "import sys,json;print(json.load(sys.stdin)['tabId'])")
node cli/cb.mjs snapshot $TAB          # find the fields, get @refs
node cli/cb.mjs type $TAB @e2 "myuser"
node cli/cb.mjs type $TAB @e3 "mypassword"
node cli/cb.mjs click $TAB @e4         # click the sign-in button
node cli/cb.mjs text $TAB              # check the result
```

### Example 3: Batch screenshots

```bash
for url in https://example.com https://example.org https://example.net; do
  TAB=$(node cli/cb.mjs open "$url" --json | python3 -c "import sys,json;print(json.load(sys.stdin)['tabId'])")
  node cli/cb.mjs shot $TAB "shot-$(echo $url | sed 's|https://||;s|/|_|g').png" --full
  node cli/cb.mjs raw tab.close "{\"tabId\":$TAB}" > /dev/null
done
```

### Example 4: Scraping a lazy-loading list

```bash
TAB=1234
for i in $(seq 1 10); do
  node cli/cb.mjs eval $TAB "document.querySelectorAll('article').length"
  node cli/cb.mjs eval $TAB "(()=>{window.scrollBy(0,1600);return window.scrollY})()"
  sleep 1.5
done
```

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `连不上桥接服务 127.0.0.1:8777` | Bridge not running | `./start-bridge.sh` |
| `extension_not_connected` | Extension not loaded / disabled / bridge restarted | Check the extension is enabled at `chrome://extensions`; click **Reconnect** in the extension popup |
| Bridge is up but extension won't connect | Same as above | Same as above |
| `debugger_attach_failed` | Target is a `chrome://` page, or DevTools is open on that tab | Use a normal page; close DevTools |
| Commands time out | Tab was closed, or a native dialog is blocking the page | `cb tabs` to confirm the tab exists; dismiss the dialog |
| Scrolling loads nothing | Tab is in the background and throttled | Use `cb open` (foreground by default); don't pass `--background` |
| `curl` gives weird results probing local ports | A local HTTP proxy is intercepting `127.0.0.1` | Add `--noproxy '*'` |
| Extension loaded but unresponsive | Service worker went to sleep | Click the extension icon to wake it, or reload the extension |
| Element not found | Page not rendered yet, or element is inside an iframe | Check render state with `cb eval <tabId> "document.querySelectorAll('article').length"`; add `cb raw tab.wait '{"tabId":N,"ms":1500}'` |

### Bridge logs

```bash
tail -f /tmp/chrome-bridge.log
```

Logs extension connect/disconnect, rejected origins, and heartbeat timeouts.

### Reloading the extension

After editing anything under `extension/`, hit the **reload icon** on the extension's card at
`chrome://extensions`, then click **Reconnect** in the popup.

---

## 8. Performance notes

- **One round trip per command:** bridge → extension → CDP → page → back. Over loopback this is
  typically a few to a few tens of milliseconds.
- **`page.snapshot` is capped** at 200 elements by default.
- **Screenshots return base64** — a full-page capture can be several MB. The CLI writes it to
  disk so your terminal stays clean.
- **Default timeout is 30s**; `open` / `goto` / `shot` internally allow 25–60s. Override with
  `CB_TIMEOUT`.
- **Only one extension connection at a time.** A new one replaces the old (relevant if you run
  multiple browsers).
- **Don't poll at high frequency.** This is a "operate a browser like a human" tool, not a
  scraping framework. For bulk collection, prefer official APIs.
- **Site risk controls.** Some sites aggressively detect automation and may flag accounts.
  Use your judgement and throttle yourself.

---

## Next

- [Bridge protocol & command reference](protocol.md) — write your own client or add commands
- [Security](security.md) — permission model and audit results
- [README](../README.md) — architecture and design trade-offs
