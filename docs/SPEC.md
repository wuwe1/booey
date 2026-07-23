# cdp-relay SPEC (protocol v2)

Contract between the three segments: daemon / ext / CLI. This file is the
**contract** only — message schema, HTTP endpoints, error codes, addressing.
Design rationale and history live in git log.

```
caller (CLI / agent) ──HTTP──▶ daemon ──WS──▶ ext ──chrome.debugger──▶ tab
```

| segment | protocol |
|---|---|
| CLI ↔ daemon | HTTP (synchronous) |
| daemon ↔ ext | WebSocket (JSON) |
| ext ↔ tab | chrome.debugger |

## Multi-browser model (new in v2)

One daemon serves **many browsers at once**. Each browser runs the same
extension build; on first run each profile mints a persistent random
**`browserId`** in `chrome.storage.local` (per-profile storage ⇒ distinct ids
for free) and may carry a user-set **`label`**. Both travel in `hello`.

- **One WS connection per browser.** The daemon wraps each in an independent
  `ExtConn` with its own command scheduler, attached-tab set, and event cache.
- **Per-browser serial, cross-browser parallel.** Each `ExtConn` keeps one
  command in flight; different browsers run concurrently. No shared queue.
- **Addressing.** Callers select a target with a `browser` value = its
  `browserId` **or** its `label`. Omitted ⇒ the daemon auto-selects when exactly
  one browser is connected, else returns 400.
- **Reconnect keeps identity.** A browser that drops and reconnects sends the
  same `browserId`; the daemon replaces the stale `ExtConn` (close `4002`) and
  keeps the same addressable identity — no id drift.

Constraints carried over: daemon binds `127.0.0.1`, no auth (same-host trust);
each tab can be attached by only one debugger.

## daemon ↔ ext (WS over JSON)

WS path: `ws://127.0.0.1:<port>/ext`. No message id. Ext→daemon messages are
disambiguated by **shape**:

- has `type` → **push** (`hello` / `event` / `tabs-changed` / `detached` / `pong`)
- no `type`, has `ok` → **response** to the most recent command

### Hello (first message after connect, required)

```js
{ type: "hello", version: 2, id: "<browserId>", label: "<string>", tabs: [{ tabId, url, title }, ...] }
```

`version` must equal `2` and `id` must be a non-empty string, else the daemon
closes with code `4000` (version/id mismatch ⇒ ext stops reconnecting). `label`
may be `""`. A second hello on the same connection (e.g. after the user edits
the label) is allowed and updates the label in place.

### Daemon → Ext

```js
{ type: "cdp",       tabId, method, params }   // forward any CDP command
{ type: "attach",    tabId }
{ type: "detach",    tabId }
{ type: "list-tabs" }
{ type: "ping" }
```

`params` may be omitted (treated as `{}`).

### Ext → Daemon

```js
// command response (next ok-shaped message after a command)
{ ok: true,  result: {...} }
{ ok: false, error: { message } }              // chrome.debugger error, no code

// pushes (no corresponding request)
{ type: "hello", version: 2, id, label, tabs }
{ type: "event", tabId, method, params }
{ type: "tabs-changed", tabs: [...] }
{ type: "detached", tabId, reason }
{ type: "pong" }
```

### Heartbeat / liveness

- daemon → ext `ping` every 25s; ext replies `pong`. Keeps the MV3 service
  worker alive during normal operation (the extension also self-revives via
  `chrome.alarms` every 24s when the SW has already died).
- A connection silent for 60s is closed (`4003`).
- Close codes: `4000` version/id mismatch (permanent stop) · `4001` non-local
  origin · `4002` replaced by same-id reconnect · `4003` silent.

## CLI ↔ daemon (HTTP)

Every browser-scoped endpoint takes an optional `browser` selector (`?browser=`
on GET, `"browser"` field on POST). Omit when only one browser is connected.

```
GET  /browsers                                   → { browsers: [{id, label, attached:[tabId], tabCount}] }
GET  /status                                     → { port, version, browserCount, browsers:[...] }
POST /shutdown                                   → { ok: true }

GET  /tabs?browser=<id|label>                    → { tabs: [{tabId, url, title}] }
POST /attach        {browser?, tabId}            → { ok: true }
POST /detach        {browser?, tabId}            → { ok: true }
POST /send          {browser?, tabId, method, params?}
                                                 → { ok: true, result } | { ok: false, error:{message} }
GET  /events?browser=<>&tabId=N&filter=<re>      → { events: [{method, params, ts}] }
POST /events/clear  {browser?, tabId}            → { ok: true }
```

`/events` is a **batch pull** (returns the whole matching FIFO; repeated pulls
return the same data). `filter` is a regex matched against `method`. Event cache
is per `(browserId, tabId)`, a fixed-capacity ring buffer (cap 1000, oldest
dropped on overflow).

Cache lifecycle: cleared on `attach` / `detach` / ext `detached` push /
`events/clear`.

## Idempotency

- `attach` already attached → 200 `{ok:true}` (no-op)
- `detach` not attached → 200 `{ok:true}` (no-op)
- `daemon start` when already running → CLI errors `daemon already running`, exit 1

## Command timeout

After forwarding a command to an ext, 30s without a response → 504
`{error:"timeout"}`; the waiter is dropped so a late response isn't mis-paired.

## Error codes

| case | HTTP | body |
|---|---|---|
| no browser connected | 503 | `{ error: "no browser connected" }` |
| ext not ready (pre-hello) | 503 | `{ error: "extension not ready" }` |
| ambiguous / unspecified selector | 400 | `{ error: "N browsers connected (...); specify browser=<id\|label>" }` |
| unknown browser selector | 404 | `{ error: "no browser matching \"...\"" }` |
| tab not attached (send) | 409 | `{ error: "tab N not attached" }` |
| chrome.debugger error | 200 | `{ ok: false, error: { message } }` (passthrough) |
| command timeout | 504 | `{ error: "timeout" }` |
| internal error | 500 | `{ error: "..." }` |
| path not found | 404 | `{ error: "not found" }` |

`/send` chrome.debugger errors use 200 + `ok:false` (a business branch), not
5xx (reserved for infra failure).

## File structure

```
cdp-relay/
├── docs/SPEC.md          # this file
├── daemon/
│   ├── config.mjs        # protocol constants
│   ├── http-error.mjs    # Error + httpCode
│   ├── ring-buffer.mjs   # O(1) fixed-cap FIFO (event cache)
│   ├── ext-conn.mjs      # ExtConn: one browser — scheduler + attach + event cache
│   ├── registry.mjs      # ExtRegistry: Map<id,ExtConn> + selector resolution
│   ├── server.mjs        # HTTP + WS bootstrap, thin router
│   └── test-mock-ext.mjs # protocol test double (multi-instance)
├── extension/
│   ├── manifest.json
│   ├── background.js     # identity + daemon WS client + chrome.debugger bridge
│   ├── popup.html
│   └── popup.js          # debug fallback + label editor
└── cli/cdp-relay         # entry; subcommands
```

PID/log per port: `/tmp/cdp-relay-<port>.pid` · `/tmp/cdp-relay-<port>.log`.

## CLI surface

```
cdp-relay daemon start|stop|status [--port 9224]
cdp-relay browsers                                # list connected browsers

cdp-relay tabs [--browser <id|label>]
cdp-relay attach|detach <tabId> [--browser <id|label>]
cdp-relay eval <tabId> <js> [--await] [--browser <id|label>]
cdp-relay net <tabId> {list|body|clear} [--filter <re>] [<requestId>] [--browser <id|label>]
cdp-relay screenshot <tabId> [<path>] [--browser <id|label>]
cdp-relay nav <tabId> <url> [--browser <id|label>]
cdp-relay send <tabId> <Method> [<params-json>] [--browser <id|label>]
```

`--browser` may also be supplied via env `CDP_RELAY_BROWSER`. Output is
JSON-line by default (`--pretty` for human reading).
