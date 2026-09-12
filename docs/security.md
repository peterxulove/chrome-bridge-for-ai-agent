# Security

What this tool can do, what it can't, and what you're accepting by running it.

---

## Threat model

**In scope**

- A **malicious web page** trying to reach the bridge port and issue commands.
- **Other local processes** trying to impersonate the extension.
- **Supply-chain** risk from dependencies.
- Accidental exposure of credentials or browsing data.

**Out of scope**

- An attacker who already has code execution as your user. At that point they can read your
  Chrome profile directly; the bridge adds nothing.
- Site-side bot detection and its consequences for your account (see [Site risk](#site-risk)).

---

## Controls

### 1. Loopback only

The bridge calls `server.listen(PORT, '127.0.0.1')`. It is not reachable from your LAN or the
internet. There is no configuration to change this.

### 2. Origin validation on the WebSocket handshake

`/ext` accepts a connection only when the `Origin` header matches `chrome-extension://…`:

```js
const originOk = /^chrome-extension:\/\//.test(origin) ||
  (!origin && process.env.CB_ALLOW_NO_ORIGIN === '1');
if (!originOk) {
  socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
  socket.destroy();
  return;
}
```

Browsers always send `Origin` on WebSocket handshakes, and a page cannot forge it. So even if a
page guesses `127.0.0.1:8777`, it gets a 403.

`CB_ALLOW_NO_ORIGIN=1` exists only so the automated test suite can act as a fake extension.
**Don't set it in normal use** — it would let any local process connect.

### 3. No data leaves the machine

- The extension makes **no network requests of its own**. Grep the source: there is exactly one
  WebSocket URL, `ws://127.0.0.1:8777/ext`.
- It **reads no cookies** and never touches `chrome.cookies`.
- No telemetry, no analytics, no update check, no remote config.
- Nothing is written to disk except screenshots you explicitly request, and the bridge log.

### 4. Zero dependencies

There is no `package.json` and no `node_modules`. The WebSocket server is implemented locally in
`server/ws-lite.mjs`. Nothing can be poisoned upstream because there is no upstream.

### 5. Optional shared secret

Set `CB_TOKEN` to require an `x-cb-token` header on HTTP requests:

```bash
CB_TOKEN=$(openssl rand -hex 24) node server/bridge.mjs
```

Useful on a shared machine with multiple user accounts.

---

## Permissions the extension requests

| Permission | Why it's needed | Risk |
|---|---|---|
| `debugger` | The core mechanism. Enables `Runtime.evaluate` (CSP-free JS), `Input.dispatch*` (trusted events), `Page.captureScreenshot`, and full CDP passthrough | **Broad.** While attached to a tab, the extension can do anything DevTools can |
| `<all_urls>` | So the agent can operate on any site you point it at | Broad, but the extension doesn't read pages on its own — only when a command arrives |
| `tabs` | List tabs, open/close/navigate | Low |
| `alarms` | Periodic reconnect check if the service worker sleeps | Low |
| `storage` | Persist connection status for the popup | Low |

Chrome shows a prominent warning at install time because of `debugger`. That warning is accurate:
this extension can, on demand, control your browser. It only ever does so in response to a
command from the local bridge.

### When the debugger is attached

Chrome displays a "Chrome is being debugged" infobar on affected tabs, and the extension icon
shows a badge. Both are Chrome's own indicators — you can always tell when it's active.

### Turning it off

Disable the extension at `chrome://extensions`. That instantly removes all capability: the
bridge will report `extensionConnected: false` and every command will fail. Nothing persists.

---

## Audit

The skill packaging of this project was audited with a static supply-chain review:

- **P0 (blocking): 0**
- **P1 (worth noting): 2** — the `debugger` + `<all_urls>` capability, and the fact that the
  bridge is unauthenticated by default (relying on loopback isolation)
- **Score: 92/100**

Full report: [security-audit.zh-CN.md](security-audit.zh-CN.md) (Chinese).

---

## Site risk

Some sites detect automation and may rate-limit or suspend accounts. Realistic guidance:

- **Keep it human-paced.** Don't fire hundreds of commands per minute.
- **Prefer official APIs** for bulk data collection. This tool is for "operate the browser like
  a person", not for crawling.
- **Understand what you're automating.** Logging into a third-party service and scripting it may
  violate that service's terms, independently of anything this tool does.

This is your account and your call — the tool doesn't hide what it is.

---

## Reporting a vulnerability

Open an issue, or if it's sensitive, use GitHub's private vulnerability reporting on this repo.
Please include reproduction steps and the affected version.
