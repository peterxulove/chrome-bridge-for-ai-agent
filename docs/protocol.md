# Bridge Protocol & Command Reference

For anyone writing their own client, extending the command set, or debugging the pipeline.

---

## Transport overview

```
client ──HTTP POST /cmd────────▶ bridge ──WebSocket {id,cmd,args}──▶ extension
       ◀──HTTP 200 {ok,...}────         ◀──WebSocket {id,ok,...}────
```

The bridge keeps a map of in-flight requests keyed by a UUID. When the extension replies with a
matching `id`, the bridge resolves the HTTP response. If no reply arrives before the timeout,
the request is rejected with `503`.

---

## HTTP API

Base: `http://127.0.0.1:8777` (override with `CB_PORT`). Binds to loopback only.

If `CB_TOKEN` is set, **every** request must carry `x-cb-token: <token>`, otherwise `401`.

### `GET /health`

```json
{
  "ok": true,
  "extensionConnected": true,
  "extension": { "origin": "chrome-extension://…", "at": 1789226208414, "version": "1.0.0", "ua": "…" },
  "port": 8777,
  "pending": 0
}
```

`extensionConnected` is only `true` while a live, heartbeating extension connection exists.

### `POST /cmd`

Request:

```json
{ "cmd": "page.text", "args": { "tabId": 1234 }, "timeout": 30000 }
```

- `cmd` (required) — command name, see below
- `args` (optional) — command-specific arguments
- `timeout` (optional) — per-request timeout in ms; defaults to `CB_TIMEOUT` (30000)

Success → `200`:

```json
{ "text": "…", "id": "b1f0…", "ok": true }
```

Extension-side failure → `500`:

```json
{ "id": "b1f0…", "ok": false, "error": "element_not_found: #submit" }
```

Bridge-side failure (no extension / timeout) → `503`:

```json
{ "ok": false, "error": "extension_not_connected" }
```

> **Field ordering matters.** Business fields are spread *before* `id` and `ok`, so a payload
> containing its own `id` (e.g. a tab id) cannot clobber the request id. This is why tab ids are
> returned as `tabId`, not `id`.

### `GET /`

A small HTML status page. Useful for a quick "is it alive" check in the browser.

---

## WebSocket endpoint

`ws://127.0.0.1:8777/ext`

### Handshake

The `Origin` header **must** be `chrome-extension://…`. Anything else — including a missing
`Origin`, unless `CB_ALLOW_NO_ORIGIN=1` — gets `403 Forbidden` and the socket is destroyed.

This is the main defence against a malicious web page connecting to a guessed port.

### Messages

**Extension → bridge, on connect:**

```json
{ "type": "hello", "version": "1.0.0", "ua": "Mozilla/5.0 …" }
```

**Bridge → extension, a command:**

```json
{ "id": "<uuid>", "cmd": "page.click", "args": { "tabId": 1234, "ref": "e4" } }
```

**Extension → bridge, a reply:**

```json
{ "id": "<uuid>", "ok": true, "clicked": "@e4", "x": 412, "y": 233 }
```

**Extension → bridge, keepalive (ignored):**

```json
{ "type": "heartbeat", "at": 1789226208414 }
```

### Liveness

The bridge sends a WebSocket **ping frame** every 15 seconds. Browsers answer pings with pongs
automatically (RFC 6455). If no pong arrives within one interval, the bridge closes the socket
and clears `extensionConnected` — this prevents a dead socket from holding the "connected" state
and making every subsequent command time out.

Only one extension connection is kept. A new connection replaces the old one.

---

## Commands

### Connection

| Command | Args | Returns |
|---|---|---|
| `ping` | — | `{ pong: true, at }` |

### Tabs

| Command | Args | Returns |
|---|---|---|
| `tabs.list` | — | `{ tabs: [{ id, windowId, active, title, url, status }] }` |
| `tab.open` | `{ url, active=true }` | `{ tabId, url }` |
| `tab.close` | `{ tabId }` | `{ closed }` |
| `tab.activate` | `{ tabId }` | `{ active }` |
| `tab.reload` | `{ tabId }` | `{ reloaded }` |
| `tab.goto` | `{ tabId, url, wait=true }` | `{ tabId, url, title, status }` |
| `tab.wait` | `{ tabId, ms=1000 }` | `{ waited }` (capped at 60s) |
| `page.info` | `{ tabId }` | `{ tabId, url, title, status }` |

### Page content

| Command | Args | Returns |
|---|---|---|
| `page.text` | `{ tabId, selector? }` | `{ text }` |
| `page.html` | `{ tabId, selector? }` | `{ html }` |
| `page.eval` | `{ tabId, code }` | `{ result }` (JSON-serialised) |
| `page.snapshot` | `{ tabId, limit=200 }` | `{ url, title, elements: [{ ref, tag, type, label, href, x, y }] }` |

### Interaction

| Command | Args | Returns |
|---|---|---|
| `page.click` | `{ tabId, selector? , ref? }` | `{ clicked, x, y }` |
| `page.type` | `{ tabId, selector? , ref? , text, submit=false, clear=true }` | `{ typed, target, submit }` |
| `page.scroll` | `{ tabId, x=0, y=800 }` | `{ scrolled }` |
| `page.screenshot` | `{ tabId, format='png', quality=80, full=false }` | `{ format, base64 }` |

`selector` and `ref` are mutually exclusive; `ref` (from `page.snapshot`) wins if both are given.

### Debugger

| Command | Args | Returns |
|---|---|---|
| `cdp.send` | `{ tabId, method, params={} }` | `{ result }` — raw CDP response |
| `debug.detach` | `{ tabId }` | `{ detached }` |

---

## How a command is executed

1. `ensureAttached(tabId)` — `chrome.debugger.attach({tabId}, '1.3')` if not already attached,
   then `Page.enable` + `Runtime.enable`. Already-attached errors are swallowed; other errors
   surface as `debugger_attach_failed`.
2. The handler runs, calling `chrome.debugger.sendCommand` as needed.
3. `evalJson(tabId, expr)` wraps the expression so results survive serialisation:

   ```js
   JSON.stringify((() => { const __v = (EXPR); return __v === undefined ? null : __v; })())
   ```

   This is what lets `page.eval` return objects and arrays over the wire.

### Why clicks and typing go through CDP

- **`page.click`** reads the element's bounding box via `Runtime.evaluate`, scrolls it to the
  viewport centre, then fires `Input.dispatchMouseEvent` for `mouseMoved` / `mousePressed` /
  `mouseReleased`. These are **trusted** events — sites that check `event.isTrusted` respond.
- **`page.type`** focuses and clears the element, then uses `Input.insertText` so the page's
  `input` event fires normally (React/Vue controlled inputs included). `submit: true` dispatches
  a real Enter `keyDown`/`keyUp` pair.

---

## Adding a command

1. Add a handler to the `handlers` map in `extension/background.js`:

   ```js
   async 'my.command'({ tabId, foo } = {}) {
     return { something: await evalJson(tabId, `…`) };
   }
   ```

   Throw an `Error` for failures — the dispatcher converts it into `{ ok: false, error }`.

2. **Do not return a top-level `id` field.** Use `tabId` or another name; `id` is reserved for
   the request correlation id.

3. If it's worth a CLI subcommand, add a case in `cli/cb.mjs`.

4. Add coverage in `tests/test-extension.mjs` — the stubbed `chrome` object makes this fast.

---

## `ws-lite.mjs`

A minimal RFC 6455 server implementation (~180 lines) so the project needs no dependencies:

- HTTP → WebSocket upgrade handshake (`Sec-WebSocket-Accept` from SHA-1 + GUID)
- Frame parsing: 7/16/64-bit lengths, client masking, continuation-frame reassembly
- Control frames: `close`, `ping` → `pong`, `pong` → `'pong'` event
- Server-to-client frames are unmasked, as the spec requires

It intentionally does **not** implement permessage-deflate, subprotocol negotiation, or
`Sec-WebSocket-Extensions`. Messages here are small JSON payloads; that's enough.
