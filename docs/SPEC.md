# cdp-relay SPEC (protocol v6)

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

## Concurrency model

```
between browsers   parallel   separate ExtConns
between tabs       parallel   separate lanes                      (new in v3)
within one tab     mixed      ordered commands serialize,
                              listed reads overlap up to 8         (new in v3)
```

A command is **ordered** unless its method appears in `UNORDERED_CDP_METHODS`
(`daemon/config.ts`) — the default is always the serializing one. Ordered
commands hold their tab exclusively: they wait for the lane to drain and nothing
starts behind them until they answer. That covers everything with tab-scoped
race surface (input dispatch, navigation, focus, dialogs). The unordered list is
pure reads (`Accessibility.*`, `DOMSnapshot.captureSnapshot`, `DOM.get*`,
`Page.captureScreenshot`, …); a page model wants one AX tree per frame, and
serializing those costs a full relay round-trip each.

`POST /send` accepts `"ordered": true|false` to override the classification for
one command.

## Event subscriptions

Attaching subscribes the tab to a set of events. **Nothing is retroactive** — a
subscription only covers traffic after it is in force.

A **selector** is `Domain.method` or `Domain.*`. The list drives two things:

| | derived from | controls |
|---|---|---|
| **domains to enable** | the `Domain` part of every selector | what Chrome generates at all |
| **methods to forward** | the whole selector | what crosses the ext → daemon wire |

Filtering happens **in the extension, before any stringify/send/store**. An event
nobody subscribed to costs one `Set.has` and nothing else.

**Presets** (`EVENT_PRESETS` in `daemon/config.ts`):

| preset | selectors | enables |
|---|---|---|
| `nav` (**attach default**) | `Page.frameNavigated` `Page.loadEventFired` `Page.domContentEventFired` `Page.javascriptDialogOpening` | `Page` |
| `net` | `Network.requestWillBeSent` `Network.responseReceived` `Network.loadingFinished` `Network.loadingFailed` | `Network` |
| `console` | `Runtime.consoleAPICalled` `Runtime.exceptionThrown` | `Runtime` |
| `dom` | `DOM.documentUpdated` | `DOM` |
| `targets` | `Target.attachedToTarget` `Target.detachedFromTarget` `Target.targetInfoChanged` | — (see below) |

`net` deliberately omits `Network.dataReceived`, which fires per data chunk and
is the largest single source of event volume with no consumer here. `Runtime` is
off by default: it exists to deliver console events, and **`Runtime.evaluate`
does not need the domain enabled**.

**Ownership is per tab, last writer wins.** No refcounting — a tab already has a
single owner for focus, navigation, and dialogs. The extension unions the
daemon's set with the popup's, since those are genuinely separate consumers.

**Validation.** A malformed selector or unknown preset is a 400. A well-shaped
selector naming a domain that does not exist (`Netwrok.*`) can only be caught by
the browser, so `Domain.enable` failures come back in `result.failed` — a typo'd
domain must not degrade into a subscription that silently matches nothing.

## Page revision

Every tab carries a monotonic `revision`, bumped by any event that means "what
you knew about this page's structure may be stale":

```
DOM.documentUpdated · Page.frameNavigated · Page.loadEventFired
Page.domContentEventFired · Page.navigatedWithinDocument
```

```
GET /page?browser=<>&tabId=N
  → { tabId, attached, revision, lastDirty: {method, ts} | null, events, url }
```

Read it before an action and after; a change means the page moved underneath
you. That is the difference between "the click did nothing" and "the click
opened a dialog and every index you were holding is now wrong" — the second of
which URL comparison alone does not catch.

A **counter, not a dirty flag**: a flag needs someone to clear it, and once two
callers share a tab there is no answer to who. Every caller keeps its own
baseline and nobody can clear anyone else's.

**Fidelity is bounded by the subscription.** An unsubscribed event is dropped in
the extension and the daemon never learns of it. Measured on a real page reload:
`nav` alone bumps twice, `nav,dom` bumps four times. Ask for `dom` if you need
document-level precision.

The counter resets on attach / detach / `detached`: those end the observation, so
a baseline taken before the gap must not read as "unchanged" across it.

`clients/ts` builds `settled(tabId, {quietMs})` on this — wait until no dirtying
event for `quietMs`. It is the honest version of `sleep(3000)` after a click, and
because it watches CDP events (browser-process side) rather than page timers, it
keeps working in a background tab where in-page polling is throttled to a halt.

## Multi-browser model (since v2)

One daemon serves **many browsers at once**. Each browser runs the same
extension build; on first run each profile mints a persistent random
**`browserId`** in `chrome.storage.local` (per-profile storage ⇒ distinct ids
for free) and may carry a user-set **`label`**. Both travel in `hello`.

- **One WS connection per browser.** The daemon wraps each in an independent
  `ExtConn` with its own command scheduler, attached-tab set, and event cache.
- **No shared queue across browsers.** Each `ExtConn` schedules independently.
- **Addressing.** Callers select a target with a `browser` value = its
  `browserId` **or** its `label`. Omitted ⇒ the daemon auto-selects when exactly
  one browser is connected, else returns 400.
- **Reconnect keeps identity.** A browser that drops and reconnects sends the
  same `browserId`; the daemon replaces the stale `ExtConn` (close `4002`) and
  keeps the same addressable identity — no id drift.

Constraints carried over: daemon binds `127.0.0.1`, no auth (same-host trust);
each tab can be attached by only one debugger.

## daemon ↔ ext (WS over JSON)

WS path: `ws://127.0.0.1:<port>/ext`. Every command carries a monotonic
`id` (number, per connection) and its response quotes it. Messages are
disambiguated by **shape**:

- has `id` → **command** (daemon→ext) or **response** (ext→daemon)
- has `type`, no `id` → **push** (`hello` / `event` / `tabs-changed` / `detached` / `pong` / `ping`)

Ids are what make more than one command in flight possible, and they are also
what makes giving up on one safe: a response quoting a **retired id is dropped**.
v2 paired responses positionally, so an answer to a command the daemon had
already abandoned would resolve the *next* command's waiter and shift every
response after it by one.

The ext does **not** serialize commands. It answers whatever the daemon sends,
in whatever order the answers come back; ordering is entirely the daemon's job.

### Hello (first message after connect, required)

```js
{ type: "hello", version: 6, id: "<browserId>", label: "<string>", tabs: [{ tabId, url, title }, ...] }
```

Note `id` here is the **browserId** (a string), unrelated to the numeric message
id on commands.

`version` must equal `6` and `id` must be a non-empty string, else the daemon
closes with code `4000` (version/id mismatch ⇒ ext stops reconnecting). `label`
may be `""`. A second hello on the same connection (e.g. after the user edits
the label) is allowed and updates the label in place.

### Daemon → Ext

```js
{ id, type: "cdp",        tabId, method, params, sessionId? }  // forward any CDP command
{ id, type: "attach",     tabId, events: [selector] }
{ id, type: "events.set", tabId, events: [selector] }  // replace the subscription
{ id, type: "detach",     tabId }
{ id, type: "list-tabs" }
{ id, type: "snapshot",   tabId, frames: [{frameOrdinal, sessionId?}] }  // fetch the three trees
{ type: "ping" }                                   // push: no id, answered by `pong`
```

`params` may be omitted (treated as `{}`). A command without an `id` is ignored
by the ext. `attach` and `events.set` answer with
`{ enabled: [domain], failed: [{domain, message}] }` — the ext diffs the desired
domain set against what is currently enabled and emits only the difference, so
re-pushing the same state is free and repairs drift after a reconnect.

### Ext → Daemon

```js
// command response — `id` is the id of the command it answers
{ id, ok: true,  result: {...} }
{ id, ok: false, error: { message } }          // chrome.debugger error, no code

// pushes (no corresponding request)
{ type: "hello", version: 6, id, label, tabs }
{ type: "event", tabId, method, params, sessionId? }   // sessionId ⇒ from an OOPIF/worker
{ type: "tabs-changed", tabs: [...] }
{ type: "detached", tabId, reason }
{ type: "pong", stats: { matchedEvents, filteredEvents, droppedEvents } }
```

`pong` carries the ext's event counters (`matched` vs `filtered` is the
subscription filter's whole justification); they surface on `/status`.

### Heartbeat / liveness

Three overlapping mechanisms keep the MV3 service worker up, weakest last:

1. **offscreen heartbeat** (ext-local) — an offscreen document holds a runtime
   Port and posts on it every 1s. Port traffic resets the SW idle timer, so the
   countdown never starts. Prevention.
2. **daemon → ext `ping` every 25s**, answered with `pong`. Same effect while a
   daemon is connected; also the daemon's liveness probe.
3. **`chrome.alarms`** — resurrection, not prevention: wakes an already-dead SW
   so it can reconnect. Chrome clamps alarm periods to a **30s minimum**, so
   recovery latency is up to ~30s regardless of what is requested. That gap is
   why (1) exists.
- A connection silent for 60s is closed (`4003`).
- Close codes: `4000` version/id mismatch (permanent stop) · `4001` non-local
  origin · `4002` replaced by same-id reconnect · `4003` silent.

## CLI ↔ daemon (HTTP)

Every browser-scoped endpoint takes an optional `browser` selector (`?browser=`
on GET, `"browser"` field on POST). Omit when only one browser is connected.

```
GET  /browsers                                   → { browsers: [{id, label, attached:[tabId], tabCount, inflight}] }
GET  /status                                     → { port, version, browserCount, browsers:[...] }
POST /shutdown                                   → { ok: true }

GET  /tabs?browser=<id|label>[&fresh=0]          → { tabs: [{tabId, url, title}] }
GET  /page?browser=<>&tabId=N                    → { tabId, attached, revision, lastDirty, events, url }
GET  /snapshot?browser=<>&tabId=N                → { tabId, snapshot, stale }
POST /snapshot       {browser?, tabId}           → { ok: true, result: Snapshot }
POST /act            {browser?, tabId, actions:[{index?, method, args?, xpath?, elementHash?}]}
                                                 → { ok: true, result:{ results:[ActionResult] } }
GET  /sessions?browser=<>&tabId=N                → { tabId, sessions: [{sessionId, targetId, type, url, openedAt}] }
POST /sessions/enable  {browser?, tabId}         → { ok: true, result:{ sessions } }
POST /open-tab      {browser?, url}              → { ok: true, result:{tab} }
POST /attach        {browser?, tabId, events?, sessions?}
                                                 → { ok: true, result:{events, enabled, failed, sessions?} }
POST /detach        {browser?, tabId}            → { ok: true }
POST /send          {browser?, tabId, method, params?, ordered?, timeoutMs?, sessionId?}
                                                 → { ok: true, result } | { ok: false, error:{message, code} }

POST /events/subscribe {browser?, tabId, events} → { ok: true, result:{events, enabled, failed} }
GET  /events/subscribe?browser=<>&tabId=N        → { tabId, events: [selector] }
GET  /events?browser=<>&tabId=N&since=<seq>&filter=<re>
                                                 → { events:[{seq, method, params, ts}],
                                                     nextSeq, dropped, truncated }
POST /events/clear  {browser?, tabId}            → { ok: true }
```

`fresh=0` on `/tabs` returns the snapshot the ext pushes on every tab change
instead of round-tripping to it: one fewer hop, up to one debounce interval
stale. `/open-tab` uses `chrome.tabs.create({active:false})` — CDP has no
browser-level target creation reachable from a per-tab attachment, and a tab
opened by a page's `window.open` gets foregrounded, interrupting the user.

`timeoutMs` on `/send` overrides `CMD_TIMEOUT_MS` for one command.

## Sessions (out-of-process iframes)

A tab-scoped attachment cannot see inside an out-of-process iframe. Verified, on
a page at `127.0.0.1` framing `example.com` (different eTLD+1, so Chrome puts it
in its own process):

```
DOM.getDocument {depth:-1, pierce:true} on the tab session
  → sees the host page's elements
  → does NOT see anything inside the iframe
```

The way in is a flat auto-attach, then addressing the resulting session:

```jsonc
POST /send {"tabId":N, "method":"Target.setAutoAttach",
            "params":{"autoAttach":true,"flatten":true,"waitForDebuggerOnStart":false}}

// subscribe to "Target.*" and read the event:
{ "method":"Target.attachedToTarget",
  "params":{ "sessionId":"14ECF1C2BE72…", "targetInfo":{"type":"iframe","url":"https://example.com/"} } }

POST /send {"tabId":N, "method":"DOM.getDocument", "sessionId":"14ECF1C2BE72…"}
  → the iframe's own document, and only that
```

`chrome.debugger.sendCommand` takes a `DebuggerSession` (Chrome 125+), so the
`sessionId` is genuinely honoured, not ignored — a bogus one answers
`-32001 Session with given id not found.`

Events originating from such a session carry `sessionId` alongside `tabId`.

### The session pool

`attach` with `sessions: true` does the whole job — it adds the `targets` preset,
sends `Target.setAutoAttach{flatten:true}`, and maintains a pool per tab from the
Target events. Nothing polls.

```
POST /attach   {tabId, events?, sessions: true}  → { ok, result:{ events, enabled, failed, sessions } }
GET  /sessions?browser=<>&tabId=N                → { tabId, sessions: [Session] }
POST /sessions/enable {browser?, tabId}          → { ok, result:{ sessions } }   // idempotent

Session = { sessionId, targetId, type, url, openedAt }
```

The pool is **keyed on `targetId`, not `sessionId`**: a sessionId is reissued
every time the debugger reattaches, while the targetId keeps naming the same live
frame. **Neither survives a reload** — the frame is destroyed and a new one is
created, so both ids change (measured: `B359EA19D0` → `2B3BA7C45B` across one
`Page.reload`). *Stable across reattach* is not *stable across navigation*;
neither id is a durable handle on "that iframe".

The pool is emptied on attach / detach / `detached`, because those invalidate
every sessionId in it.

**`Target` has no `enable` method.** Its events come from `setAutoAttach`, so the
extension skips it when reconciling domains — it appears in neither `enabled` nor
`failed`. (`Target.enable` answers `-32601`; a permanent entry in `failed` would
train callers to ignore a field whose whole job is flagging a typo'd domain.)

**Cross-origin is not enough — it has to be cross-site.** Site isolation works on
scheme + eTLD+1, so `a.example.com` framed in `example.com` stays in the same
process and never appears in the pool. Its content is already in the tab's own
DOM tree. Of 13 real tabs surveyed, the three with "cross-origin" iframes were
all same-site subdomains; a genuine OOPIF needed a purpose-built page.

`waitForDebuggerOnStart` is left off: pausing every new target until we release
it would stall page loads the caller never asked us to inspect.

**Lane granularity is still the tab.** An OOPIF's session shares the tab's focus,
dialogs, and navigation, so ordering has to be decided at tab granularity — a
session is an address, not a concurrency domain.

Note `sessionId` changes across detach/reattach; `targetInfo.targetId` does not.
Anything that needs to survive a reattach should key on the target.

`/events` is an **incremental pull**: pass the previous read's `nextSeq` as
`since` to get only what is new; `since=0` (or omitted) returns everything still
held. `filter` is a regex matched against `method`.

- `dropped` — how many events the ring has overwritten on this tab, ever.
- `truncated` — **the ring overwrote events this caller had not read yet**.
  Without it, losing events and nothing happening look identical.

Event cache is per `(browserId, tabId)`, a ring buffer (cap 1000; override with
`CDP_RELAY_EVENT_CACHE_CAP`). Cleared on `attach` / `detach` / ext `detached`
push / `events/clear`.

## Page model (snapshot)

v6 adds the first half of the L2 page model: a `snapshot` that merges the three
CDP trees into flat `NodeRecord`s (design doc §5.2). The extension stays thin —
it fetches the trees and returns them raw; all merging, XPath, and identity are
the daemon's.

```
POST /snapshot {browser?, tabId}
  → { ok: true, result: Snapshot }          // re-fetches the trees, caches, returns
GET  /snapshot?browser=<>&tabId=N
  → { tabId, snapshot: Snapshot, stale }    // reads the cache; no tree round-trip
```

The ext command behind it:

```js
{ id, type: "snapshot", tabId, frames: [{ frameOrdinal, sessionId? }] }
// → { frames: [{ frameOrdinal, url, dom, ax, snapshot }] }
```

`frames[0]` is the main frame (`frameOrdinal: 0`, no `sessionId`); further entries
address flat auto-attached OOPIF sessions, one per pool entry (the daemon appends
them from its session pool). For each frame the ext concurrently sends
`DOM.getDocument{depth:-1,pierce:true}`, `Accessibility.getFullAXTree`, and
`DOMSnapshot.captureSnapshot{includeDOMRects, includePaintOrder}`, and returns the
three trees untouched.

The daemon then stitches the frames together: each OOPIF frame's root is re-parented
onto the `iframe`/`frame` host in the parent frame whose `src` matches the child
frame's `url`, and the child's XPath gets the host's XPath as a prefix (stagehand's
`prefixXPath`). Host matching by URL is a heuristic — two same-URL iframes would be
ambiguous; rare in practice, and the mock controls it exactly.

The daemon merges the trees keyed on `backendNodeId` — the DOM tree is the spine,
AX nodes attach `role`/`name` by `backendDOMNodeId`, the snapshot attaches `rect`
by `backendNodeId` — and emits a flat `NodeRecord[]`:

```jsonc
{
  "id": "0-1847",              // frameOrdinal-backendNodeId (stagehand EncodedId)
  "parent": "0-1840",          // parent's id, null for the root element
  "tag": "button",
  "role": "button",            // AX role, "" when absent
  "name": "加入购物车",        // AX accessible name, "" when absent
  "attrs": { "id": "add-cart", "type": "submit" },  // whitelist
  "rect": [120, 480, 96, 36],  // [x,y,w,h] from DOMSnapshot, null without geometry
  "vis": true,                 // has geometry, or AX non-ignored
  "int": true,                 // visible and an interactive role
  "xp": "/html[1]/body[1]/button[1]",  // sibling-index XPath (stagehand algorithm)
  "elementHash": "9f3a…",      // sha256(tagPath|sortedAttrs|ax_name) first 16 hex
  "parentBranchHash": "7c2b…"  // sha256(tagPath) first 16 hex
}
```

`elementHash` is the stable identity (design doc §5.3c): it is
`sha256(parentBranchPath|attributes|ax_name)` truncated to the first 16 hex
characters, with the `class` attribute filtered through the 20 dynamic-state
substrings first (`hover`/`focus`/`loading`/…), so page state churn doesn't
change identity. `parentBranchHash` is the same over just the tag path, for
structure fingerprints. Both follow browser-use's `compute_stable_hash` /
`parent_branch_hash`; the values stay strings (browser-use converts to int only
because Python `__hash__` must return one).

A `Snapshot` is a picture of the page at one `revision`. `POST /snapshot` stores
it keyed to the revision at capture time; `GET /snapshot` returns the cached one
with `stale` set when the revision has since advanced — the page moved after the
snapshot, so any `index`/`xp` a caller is holding may be wrong. The cache is
cleared on attach / detach / `detached` (same as the event cache).

The snapshot also carries the LLM-facing serialization (design doc §5.3a/b):

```jsonc
{
  "indexedText": "[1]<button id=add-cart type=submit>加入购物车</button>\n\t[2]<a href=/cart>A</a>",
  "selectorMap": { "1": { /* NodeRecord */ }, "2": { /* NodeRecord */ } }
}
```

`indexedText` assigns a 1-based `index` to every visible, meaningful node
(interactive, or with an AX role/name); structural containers (`div`/`span`)
don't take a line but still indent their children, so the tree shape survives.
A leading `*` (`*[5]<…>`) marks nodes new since the previous snapshot (browser-use's
`is_new`, keyed on `frameOrdinal-backendNodeId`). `selectorMap[index]` is the
NodeRecord to act on — the index is the only thing an LLM needs to say; the daemon
resolves it to `xp`/`elementHash`.

## Actions (L3)

`POST /act` runs a batch of actions against a snapshot's `selectorMap`. Each
action is either `{index, method, args}` (the daemon resolves the index to
`xpath`/`elementHash`) or a full `{method, xpath, elementHash, args}`. The method
vocabulary is closed (stagehand's eleven element actions): `click / fill / type /
press / scrollTo / selectOption / hover / doubleClick / dragAndDrop / nextChunk /
prevChunk`.

Three-level fallback (design doc §6.2) — the second level is the one that costs
no LLM round-trip:

```
1. xpath locates the element            → execute          zero cost
2. xpath stale → re-snapshot, find elementHash → new xpath → execute   ★ zero LLM
3. elementHash gone                     → needsInference   one LLM (caller re-infers)
```

A result is `{ok, method, healed?, interrupted?, needsInference?, error?}`.
`healed` marks level 2; `needsInference` marks level 3.

Batch guards (design doc §6.4): a `terminatesSequence` method (`navigate` /
`goBack` / `goForward` / `switchTab` / `submit`) discards the rest of the queue,
and after every action the daemon re-checks the page `revision` — if it moved
(navigation, dialog, async refresh), the remaining actions are dropped with
`interrupted: true`. Successful results so far are kept. `POST /act` requires a
cached snapshot (409 otherwise); the LLM side (`observe`/`extract`) is the
caller's — the daemon supplies the snapshot and resolves indices, it does not
call an LLM.

## Idempotency

- `attach` already attached → 200 `{ok:true}` (no-op)
- `detach` not attached → 200 `{ok:true}` (no-op)
- `daemon start` when already running → CLI errors `daemon already running`, exit 1

## Giving up on a command

Two things retire a command before it answers. In both cases the id is retired,
so the answer — which chrome.debugger may still deliver — lands nowhere.

- **Timeout.** `CMD_TIMEOUT_MS` (default 30s, override with the
  `CDP_RELAY_CMD_TIMEOUT_MS` env var; malformed values are ignored with a
  warning) without a response → 504.
- **Tab detached.** An ext `detached` push fails that tab's in-flight and queued
  commands immediately with 409, leaving other tabs' lanes running. Without
  this, one tab losing its debugger (the user opening DevTools, most commonly)
  would leave callers waiting out the full timeout.

## Errors

Every error response carries three fields:

```jsonc
{ "error": "tab 1734 not attached", "code": "TAB_NOT_ATTACHED", "retriable": false }
```

- **`error`** — human-readable, and *only* that. It gets reworded; nothing should
  parse it. (`code` exists because callers otherwise regex the message, and then
  a rewording silently breaks them.)
- **`code`** — the closed set below. Branch on this.
- **`retriable`** — whether retrying the same call could plausibly work.

| code | HTTP | when | retriable |
|---|---|---|---|
| `NO_BROWSER` | 503 | nothing connected | ✓ |
| `UNKNOWN_BROWSER` | 404 | selector matched no browser | |
| `AMBIGUOUS_BROWSER` | 400 | selector omitted with >1, or matched several | |
| `EXT_NOT_READY` | 503 | connected but pre-hello | ✓ |
| `EXT_DISCONNECTED` | 503 | the browser went away mid-command | ✓ |
| `TAB_NOT_ATTACHED` | 409 | `/send` or subscribe before `/attach` | |
| `TAB_DETACHED` | 409 | debugger taken away (DevTools opened, tab closed) | ✓ |
| `TIMEOUT` | 504 | no answer within the command budget | ✓ |
| `BAD_REQUEST` | 400 | malformed body, bad selector, bad regex | |
| `NOT_FOUND` | 404 | unknown path | |
| `INTERNAL` | 500 | | |
| `DEBUGGER_ERROR` | **200** | chrome.debugger refused the command | |

`DEBUGGER_ERROR` is a 200 + `ok:false` business branch, not a 5xx — 5xx is
reserved for infra failure. It appears as `{ ok:false, error:{ message, code } }`.

A **page-level JavaScript exception is not an error here**: `Runtime.evaluate`
returns 200 with `exceptionDetails` in the result. The relay worked; the page
said no. Clients turn that into their own error type (`PageJsError` in
`clients/ts`).

## Clients

`clients/ts` is the supported client. It lives here, not in each consumer, so a
protocol change updates it in the same commit that breaks it. Node runs the
`.ts` directly (native type stripping, no build step).

```ts
import { RelayClient } from "@wuwe1/cdp-relay";        // published package
// import { RelayClient } from "../clients/ts/index.ts";   // in-repo
const relay = new RelayClient({ browser: "shopee-A" });
const tab = await relay.findOrOpenTab(/seller\.shopee\.tw/, "https://seller.shopee.tw/");
await relay.attach(tab.tabId, { events: ["net"] });
const title = await relay.evalFn(tab.tabId, () => document.title);
```

## File structure

```
cdp-relay/
├── docs/SPEC.md          # this file
├── clients/ts/index.ts   # supported typed client (published as the package root)
├── daemon/
│   ├── config.ts         # protocol constants + event presets + selector expansion
│   ├── http-error.ts     # Error + httpCode + machine-readable code / retriable
│   ├── ring-buffer.ts    # O(1) fixed-cap FIFO (event cache)
│   ├── ext-conn.ts       # ExtConn: one browser — scheduler + attach + event cache + act
│   ├── page-model.ts     # three trees → NodeRecord[] → indexedText + selectorMap
│   ├── actions.ts        # the closed action vocabulary + its metadata
│   ├── registry.ts       # ExtRegistry: Map<id,ExtConn> + selector resolution
│   ├── server.ts         # HTTP + WS bootstrap, thin router
│   └── test-mock-ext.ts  # protocol test double (multi-instance)
├── extension/            # plain JS, shipped uncompiled
│   ├── manifest.json
│   ├── background.js     # identity + daemon WS client + chrome.debugger bridge
│   ├── offscreen-heartbeat.{html,js}  # SW keep-alive Port
│   ├── popup.html
│   └── popup.js          # debug fallback + label editor
└── cli/cdp-relay.ts      # entry; subcommands
```

Everything in `daemon/`, `clients/`, and `cli/` is TypeScript that Node runs
directly (type stripping, no build step in development). `npm run build` emits
`dist/` for publishing only — Node will not strip types under `node_modules`,
so the published package must carry real `.js` + `.d.ts`.

PID/log per port: `/tmp/cdp-relay-<port>.pid` · `/tmp/cdp-relay-<port>.log`.

## CLI surface

```
cdp-relay daemon start|stop|status [--port 9224]
cdp-relay browsers                                # list connected browsers

cdp-relay tabs [--browser <id|label>]
cdp-relay attach <tabId> [--events nav,net] [--browser <id|label>]
cdp-relay detach <tabId> [--browser <id|label>]
cdp-relay events show|subscribe <tabId> [<selectors>]
cdp-relay eval <tabId> <js> [--await] [--browser <id|label>]
cdp-relay net <tabId> {list|body|clear} [--filter <re>] [--since <seq>] [<requestId>] [--browser <id|label>]
cdp-relay screenshot <tabId> [<path>] [--browser <id|label>]
cdp-relay nav <tabId> <url> [--browser <id|label>]
cdp-relay send <tabId> <Method> [<params-json>] [--browser <id|label>]

cdp-relay ext path|zip [<out.zip>]                # locate / package the extension
cdp-relay doctor                                  # daemon + extension + protocol-version check
```

The CLI does not cover `/snapshot`, `/act`, `/page`, or `/sessions` — those are
reached over HTTP or through `clients/ts`.

`--browser` may also be supplied via env `CDP_RELAY_BROWSER`. Output is
JSON-line by default (`--pretty` for human reading).
