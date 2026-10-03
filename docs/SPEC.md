# Booey SPEC (protocol v6)

This is the contract between the three segments: daemon, extension, and CLI. It
covers only the contract — the message schema, the HTTP endpoints, the error
codes, and the addressing. The design rationale and the history live in the git
log. The prose is Simplified Technical English; keep it that way.

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
between tabs       parallel   separate lanes
within one tab     mixed      ordered commands serialize,
                              listed reads overlap up to 8
```

A command is ordered by default. A command is unordered only when its method is
in `UNORDERED_CDP_METHODS` (`daemon/config.ts`). An ordered command holds its tab
alone: it waits until the lane is empty, and no command starts behind it until it
answers. This covers every command that can conflict in a tab: input dispatch,
navigation, focus, and dialogs. The unordered list holds pure reads
(`Accessibility.*`, `DOMSnapshot.captureSnapshot`, `DOM.get*`,
`Page.captureScreenshot`, and so on). A page model needs one AX tree per frame,
and to serialize those reads would cost one full relay round-trip each.

`POST /send` accepts `"ordered": true|false` to override the class for one
command.

## Event subscriptions

To attach a tab subscribes it to a set of events. Nothing is retroactive: a
subscription covers only the traffic after it starts.

A **selector** is `Domain.method` or `Domain.*`. The list drives two things:

| | derived from | controls |
|---|---|---|
| **domains to enable** | the `Domain` part of every selector | what Chrome generates at all |
| **methods to forward** | the whole selector | what crosses the ext → daemon wire |

The extension filters events before it stringifies, sends, or stores them. An
event that nobody subscribed to costs one `Set.has` lookup and nothing more.

**Presets** (`EVENT_PRESETS` in `daemon/config.ts`):

| preset | selectors | enables |
|---|---|---|
| `nav` (**attach default**) | `Page.frameNavigated` `Page.loadEventFired` `Page.domContentEventFired` `Page.javascriptDialogOpening` | `Page` |
| `net` | `Network.requestWillBeSent` `Network.responseReceived` `Network.loadingFinished` `Network.loadingFailed` | `Network` |
| `console` | `Runtime.consoleAPICalled` `Runtime.exceptionThrown` | `Runtime` |
| `dom` | `DOM.documentUpdated` | `DOM` |
| `targets` | `Target.attachedToTarget` `Target.detachedFromTarget` `Target.targetInfoChanged` | — (see below) |

`net` leaves out `Network.dataReceived` on purpose. That event fires per data
chunk. It is the largest single source of event volume, and nothing here consumes
it. `Runtime` is off by default. It exists to deliver console events, and
`Runtime.evaluate` does not need the domain enabled.

**Ownership is per tab, last writer wins.** There is no refcounting. A tab
already has one owner for focus, navigation, and dialogs, and the daemon is the
only event subscriber. (The popup is a status panel, not a consumer.) Each
`events.set` replaces the tab's whole subscription.

**Validation.** A malformed selector or an unknown preset is a 400. Only the
browser can catch a well-formed selector that names a domain that does not exist
(`Netwrok.*`). So `Domain.enable` failures come back in `result.failed`. A typo'd
domain must not become a subscription that silently matches nothing.

## Page revision

Every tab carries a monotonic `revision`. Any event that means "what you knew
about this page's structure may be stale" bumps it:

```
DOM.documentUpdated · Page.frameNavigated · Page.loadEventFired
Page.domContentEventFired · Page.navigatedWithinDocument
```

```
GET /page?browser=<>&tabId=N
  → { tabId, attached, revision, lastDirty: {method, ts} | null, events, url }
```

Read it before an action and after it. A change means the page moved under you.
This separates "the click did nothing" from "the click opened a dialog and every
index you hold is now wrong". A URL comparison alone does not catch the second
case.

It is a **counter, not a dirty flag**. A flag needs someone to clear it, and once
two callers share a tab there is no owner to clear it. Each caller keeps its own
baseline, and no caller can clear another caller's baseline.

**The fidelity is bounded by the subscription.** The extension drops an
unsubscribed event, and the daemon never learns of it. Measured on a real page
reload: `nav` alone bumps twice; `nav,dom` bumps four times. Ask for `dom` if you
need document-level precision.

The counter resets on attach, detach, and `detached`. Those end the observation,
so a baseline from before the gap must not read as "unchanged" across it.

`clients/ts` builds `settled(tabId, {quietMs})` on this. It waits until no
dirtying event occurs for `quietMs`. It is a correct replacement for
`sleep(3000)` after a click. It watches CDP events on the browser-process side,
not page timers, so it keeps working in a background tab where in-page polling is
throttled almost to a stop.

## Multi-browser model

One daemon serves many browsers at once. Every browser runs the same extension
build. On first run, each profile mints a persistent random **`browserId`** in
`chrome.storage.local`, so per-profile storage makes the ids distinct on its own.
A browser may also carry a user-set **`label`**. Both travel in `hello`.

- **One WS connection per browser.** The daemon wraps each one in an independent
  `ExtConn` with its own command scheduler, attached-tab set, and event cache.
- **No shared queue across browsers.** Each `ExtConn` schedules on its own.
- **Addressing.** A caller selects a target with a `browser` value: its
  `browserId` or its `label`. If the caller omits it, the daemon auto-selects when
  exactly one browser is connected, and otherwise returns a 400.
- **Reconnect keeps identity.** A browser that drops and reconnects sends the same
  `browserId`. The daemon replaces the stale `ExtConn` (close `4002`) and keeps
  the same addressable identity. The id does not drift.

Two constraints hold throughout: the daemon binds `127.0.0.1` with no auth
(same-host trust), and only one debugger can attach to a tab.

## daemon ↔ ext (WS over JSON)

WS path: `ws://127.0.0.1:<port>/ext`. Every command carries a monotonic `id` (a
number, per connection), and its response quotes it. The shape of a message tells
it apart:

- has `id` → a **command** (daemon→ext) or a **response** (ext→daemon)
- has `type`, no `id` → a **push** (`hello` / `event` / `tabs-changed` / `detached` / `pong` / `ping`)

Ids make more than one command in flight possible. They also make it safe to give
up on a command: the daemon drops a response that quotes a **retired id**.

The extension does **not** serialize commands. It answers whatever the daemon
sends, in whatever order the answers come back. The daemon makes all ordering
decisions.

### Hello (first message after connect, required)

```js
{ type: "hello", version: 6, id: "<browserId>", label: "<string>", tabs: [{ tabId, url, title }, ...] }
```

Here `id` is the **browserId** (a string). It is not the numeric message id on
commands.

`version` must equal `6`, and `id` must be a non-empty string. If not, the daemon
closes with code `4000` (version/id mismatch), and the extension stops
reconnecting. `label` may be `""`. A second hello on the same connection is
allowed (for example, after the user edits the label) and updates the label in
place.

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

`params` may be omitted (treated as `{}`). The extension ignores a command
without an `id`. `attach` and `events.set` answer with
`{ enabled: [domain], failed: [{domain, message}] }`. The extension diffs the
wanted domain set against what is enabled now and emits only the difference, so to
re-push the same state is free and repairs drift after a reconnect.

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

`pong` carries the extension's event counters. The ratio of `matched` to
`filtered` is the whole reason the subscription filter exists. They surface on
`/status`.

### Heartbeat / liveness

Three mechanisms keep the MV3 service worker up. The last is the weakest:

1. **offscreen heartbeat** (ext-local). An offscreen document holds a runtime
   Port and posts on it every 1s. Port traffic resets the SW idle timer, so the
   countdown never starts. This is prevention.
2. **daemon → ext `ping` every 25s**, answered with `pong`. It has the same
   effect while a daemon is connected. It is also the daemon's liveness probe.
3. **`chrome.alarms`** — resurrection, not prevention. It wakes a SW that already
   died, so it can reconnect. Chrome clamps alarm periods to a **30s minimum**, so
   recovery can take up to about 30s whatever you request. That gap is why (1)
   exists.
- The daemon closes a connection that is silent for 60s (`4003`).
- Close codes: `4000` version/id mismatch (permanent stop) · `4001` non-local
  origin · `4002` replaced by same-id reconnect · `4003` silent.

## CLI ↔ daemon (HTTP)

Every browser-scoped endpoint takes an optional `browser` selector (`?browser=`
on GET, a `"browser"` field on POST). Omit it when only one browser is connected.

```
GET  /browsers                                   → { browsers: [{id, label, attached:[tabId], tabCount, inflight}] }
GET  /status                                     → { port, version, browserCount, browsers:[...] }
POST /shutdown                                   → { ok: true }

GET  /tabs?browser=<id|label>[&fresh=0]          → { tabs: [{tabId, url, title}] }
GET  /page?browser=<>&tabId=N                    → { tabId, attached, revision, lastDirty, events, url }
GET  /snapshot?browser=<>&tabId=N                → { tabId, snapshot, stale }
POST /snapshot       {browser?, tabId}           → { ok: true, result: Snapshot }
POST /act            {browser?, tabId, actions:[{index?, method, args?, xpath?, elementHash?, fingerprint?}]}
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

`fresh=0` on `/tabs` returns the snapshot the extension pushes on every tab
change, instead of a round-trip to it. This is one fewer hop, and up to one
debounce interval stale. `/open-tab` uses `chrome.tabs.create({active:false})`.
CDP has no browser-level target creation that a per-tab attachment can reach, and
a tab opened by a page's `window.open` gets foregrounded, which interrupts the
user.

`timeoutMs` on `/send` overrides `CMD_TIMEOUT_MS` for one command.

## Sessions (out-of-process iframes)

A tab-scoped attachment cannot see inside an out-of-process iframe. This is
verified on a page at `127.0.0.1` that frames `example.com` (a different eTLD+1,
so Chrome puts it in its own process):

```
DOM.getDocument {depth:-1, pierce:true} on the tab session
  → sees the host page's elements
  → does NOT see anything inside the iframe
```

The way in is a flat auto-attach, then to address the session it produces:

```jsonc
POST /send {"tabId":N, "method":"Target.setAutoAttach",
            "params":{"autoAttach":true,"flatten":true,"waitForDebuggerOnStart":false}}

// subscribe to "Target.*" and read the event:
{ "method":"Target.attachedToTarget",
  "params":{ "sessionId":"14ECF1C2BE72…", "targetInfo":{"type":"iframe","url":"https://example.com/"} } }

POST /send {"tabId":N, "method":"DOM.getDocument", "sessionId":"14ECF1C2BE72…"}
  → the iframe's own document, and only that
```

`chrome.debugger.sendCommand` takes a `DebuggerSession` (Chrome 125+), so it
honours the `sessionId` and does not ignore it. A bogus one answers
`-32001 Session with given id not found.`

An event from such a session carries `sessionId` next to `tabId`.

### The session pool

`attach` with `sessions: true` does the whole job: it adds the `targets` preset,
sends `Target.setAutoAttach{flatten:true}`, and maintains a pool per tab from the
Target events. Nothing polls.

```
POST /attach   {tabId, events?, sessions: true}  → { ok, result:{ events, enabled, failed, sessions } }
GET  /sessions?browser=<>&tabId=N                → { tabId, sessions: [Session] }
POST /sessions/enable {browser?, tabId}          → { ok, result:{ sessions } }   // idempotent

Session = { sessionId, targetId, type, url, openedAt }
```

The pool is **keyed on `targetId`, not `sessionId`**. The debugger reissues a
sessionId on every reattach, but the targetId keeps naming the same live frame.
**Neither id survives a reload.** The frame is destroyed and a new one is created,
so both ids change (measured: `B359EA19D0` → `2B3BA7C45B` across one
`Page.reload`). Stable across a reattach is not stable across a navigation.
Neither id is a durable handle on "that iframe".

The pool is emptied on attach, detach, and `detached`, because those invalidate
every sessionId in it.

**`Target` has no `enable` method.** Its events come from `setAutoAttach`, so the
extension skips it when it reconciles domains, and it appears in neither `enabled`
nor `failed`. (`Target.enable` answers `-32601`. A permanent entry in `failed`
would teach callers to ignore a field whose whole job is to flag a typo'd domain.)

**Cross-origin is not enough; it must be cross-site.** Site isolation works on
scheme + eTLD+1, so `a.example.com` framed in `example.com` stays in the same
process and never appears in the pool. Its content is already in the tab's own DOM
tree. Of 13 real tabs surveyed, the three with "cross-origin" iframes were all
same-site subdomains; a genuine OOPIF needed a purpose-built page.

`waitForDebuggerOnStart` is off. To pause every new target until we release it
would stall page loads the caller never asked us to inspect.

**The lane granularity is still the tab.** An OOPIF's session shares the tab's
focus, dialogs, and navigation, so the daemon decides ordering per tab. A session
is an address, not a concurrency domain.

Note that `sessionId` changes across a detach/reattach, but `targetInfo.targetId`
does not. Key anything that must survive a reattach on the target.

`/events` is an **incremental pull**: pass the previous read's `nextSeq` as
`since` to get only what is new. `since=0` (or omitted) returns everything still
held. `filter` is a regex matched against `method`.

- `dropped` — how many events the ring has overwritten on this tab, ever.
- `truncated` — **the ring overwrote events this caller had not read yet.**
  Without it, lost events and silence look the same.

The event cache is per `(browserId, tabId)`, a ring buffer (cap 1000; override
with `BOOEY_EVENT_CACHE_CAP`). It is cleared on `attach`, `detach`, an ext
`detached` push, and `events/clear`.

## Page model (snapshot)

A `snapshot` merges the three CDP trees into flat `NodeRecord`s (design doc §5.2).
The extension stays thin: it fetches the trees and returns them raw. The daemon
does all the merging, the XPath, and the identity.

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

`frames[0]` is the main frame (`frameOrdinal: 0`, no `sessionId`). Later entries
address flat auto-attached OOPIF sessions, one per pool entry; the daemon appends
them from its session pool. For each frame the extension concurrently sends
`DOM.getDocument{depth:-1,pierce:true}`, `Accessibility.getFullAXTree`, and
`DOMSnapshot.captureSnapshot{includeDOMRects, includePaintOrder}`, and returns the
three trees untouched.

The daemon then stitches the frames together. It re-parents each OOPIF frame's
root onto the `iframe`/`frame` host in the parent frame whose `src` matches the
child frame's `url`, and it prefixes the child's XPath with the host's XPath
(stagehand's `prefixXPath`). Host matching by URL is a heuristic: two same-URL
iframes would be ambiguous. This is rare in practice, and the mock controls it
exactly.

The daemon merges the trees keyed on `backendNodeId`. The DOM tree is the spine.
AX nodes attach `role`/`name` by `backendDOMNodeId`. The snapshot attaches `rect`
by `backendNodeId`. The result is a flat `NodeRecord[]`:

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

`elementHash` is the stable identity (design doc §5.3c). It is
`sha256(parentBranchPath|attributes|ax_name)` cut to the first 16 hex characters.
The `class` attribute is first filtered through the 20 dynamic-state substrings
(`hover`/`focus`/`loading`/…), so page-state churn does not change the identity.
`parentBranchHash` is the same hash over just the tag path, for structure
fingerprints. Both follow browser-use's `compute_stable_hash` /
`parent_branch_hash`. The values stay strings (browser-use converts to int only
because a Python `__hash__` must return one).

A `Snapshot` is a picture of the page at one `revision`. `POST /snapshot` stores
it keyed to the revision at capture time. `GET /snapshot` returns the cached one
and sets `stale` when the revision has since advanced: the page moved after the
snapshot, so any `index`/`xp` a caller holds may be wrong. The cache is cleared on
attach, detach, and `detached` (the same as the event cache).

The snapshot also carries the LLM-facing serialization (design doc §5.3a/b):

```jsonc
{
  "indexedText": "[1]<button id=add-cart type=submit>加入购物车</button>\n\t[2]<a href=/cart>A</a>",
  "selectorMap": { "1": { /* NodeRecord */ }, "2": { /* NodeRecord */ } }
}
```

`indexedText` gives a 1-based `index` to every visible, meaningful node (one that
is interactive, or has an AX role or name). A structural container (`div`/`span`)
does not take a line, but it still indents its children, so the tree shape
survives. A leading `*` (`*[5]<…>`) marks a node that is new since the previous
snapshot (browser-use's `is_new`, keyed on `frameOrdinal-backendNodeId`).
`selectorMap[index]` is the NodeRecord to act on. The index is the only thing an
LLM needs to say; the daemon resolves it to `xp`/`elementHash`.

## Actions (L3)

> **L3 is the optional top layer.** To read data, use L1 (`send` / `evalFn`) and
> L2 (`snapshot`); L3 adds nothing there. L3 pays off for one pattern only: **the
> same action task, run repeatedly, that must survive a site redesign.** Its value
> is the four-level heal and the cache migration below, not the action vocabulary
> (an agent can click through L1 `Input.dispatchMouseEvent`). A read-only or
> one-shot consumer never needs to call `/act`.

`POST /act` runs a batch of actions against a snapshot's `selectorMap`. An action
is either `{index, method, args}` (the daemon resolves the index to
`xpath`/`elementHash`/`fingerprint`) or a full
`{method, xpath, elementHash, args, fingerprint?}`. The method vocabulary is
closed (stagehand's eleven element actions): `click / fill / type / press /
scrollTo / selectOption / hover / doubleClick / dragAndDrop / nextChunk /
prevChunk`.

`fingerprint` carries the element's fuzzy-matchable identity:
`{tag, role, name, attrs, tagPath, parentBranchHash}`. It enables the fuzzy
relocation level below. The daemon fills it when it resolves by `index`. A caller
that replays a cached action includes the fingerprint it stored (from the
snapshot, or from a prior result's `relocated`) to get fuzzy healing. To omit it
is valid; that action just skips the fuzzy level.

Four-level fallback (design doc §6.2). Levels 2 and 2.5 cost no LLM round-trip:

```
1.   xpath locates the element            → execute                      zero cost
2.   xpath stale → re-snapshot, find by elementHash → new xpath          ★ zero LLM
2.5  elementHash gone → fuzzy-match fingerprint (similarity) → new xpath  ★ zero LLM
3.   fuzzy below threshold                → needsInference    one LLM (caller re-infers)
```

Level 2.5 scores every visible or interactive node against the fingerprint
(Sørensen–Dice on name, attrs, and tag path, weighted toward the AX name and the
stable attrs). It uses the top match only when the match clears `0.72` **and**
leads the runner-up by `0.12`. This is stricter than a scraper, because to click
the wrong element is not reversible; an unclear match defers to the LLM instead of
a guess.

A result is
`{ok, method, healed?, healMethod?, score?, relocated?, interrupted?, needsInference?, error?}`.
`healed` marks a relocation (level 2 or 2.5). `healMethod` is `"exact"` or
`"fuzzy"`. `score` is the fuzzy confidence. On any heal, `relocated` carries the
element's new identity `{xpath, elementHash, fingerprint}`. The caller writes it
back to its cached action, so the identity migrates with the site and the next run
hits level 1 directly. `needsInference` marks the final level.

Batch guards (design doc §6.4): a `terminatesSequence` method (`navigate` /
`goBack` / `goForward` / `switchTab` / `submit`) discards the rest of the queue.
After every action the daemon re-checks the page `revision`. If it moved
(navigation, dialog, async refresh), the daemon drops the remaining actions and
marks them `interrupted: true`. It keeps the successful results so far. `POST /act`
needs a cached snapshot when any action uses `index` (409 otherwise). The LLM
side (`observe`/`extract`) is the caller's: the daemon supplies the snapshot and
resolves indices; it does not call an LLM.

## Idempotency

- `attach` when already attached → 200 `{ok:true}` (no-op)
- `detach` when not attached → 200 `{ok:true}` (no-op)
- `daemon start` when already running → the CLI errors `daemon already running`, exit 1

## Giving up on a command

Two things retire a command before it answers. In both cases the daemon retires
the id, so the answer goes nowhere (chrome.debugger may still deliver it).

- **Timeout.** No response within `CMD_TIMEOUT_MS` (default 30s; override with the
  `BOOEY_CMD_TIMEOUT_MS` env var; a malformed value is ignored with a warning)
  → 504.
- **Tab detached.** An ext `detached` push fails that tab's in-flight and queued
  commands at once with a 409, and leaves the other tabs' lanes running. Without
  this, one tab that loses its debugger (most often the user opens DevTools) would
  leave callers to wait out the full timeout.

## Errors

Every error response carries three fields:

```jsonc
{ "error": "tab 1734 not attached", "code": "TAB_NOT_ATTACHED", "retriable": false }
```

- **`error`** — human-readable, and only that. It gets reworded, so nothing should
  parse it. (`code` exists because callers would otherwise regex the message, and
  then a rewording breaks them without a sign.)
- **`code`** — the closed set below. Branch on this.
- **`retriable`** — whether the same call could plausibly work on a retry.

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
| `CONFLICT` | 409 | no cached snapshot for an index action; stale selectorMap | |
| `INTERNAL` | 500 | | |
| `DEBUGGER_ERROR` | **200** | chrome.debugger refused the command | |

`DEBUGGER_ERROR` is a 200 with `ok:false`, a business branch, not a 5xx. 5xx is
reserved for infra failure. It appears as `{ ok:false, error:{ message, code } }`.

A **page-level JavaScript exception is not an error here.** `Runtime.evaluate`
returns a 200 with `exceptionDetails` in the result. The relay worked; the page
said no. Clients turn that into their own error type (`PageJsError` in
`clients/ts`).

## Clients

`clients/ts` is the supported client. It lives here, not in each consumer, so a
protocol change updates it in the same commit that breaks it. Node runs the `.ts`
directly (native type stripping, no build step).

```ts
import { RelayClient } from "@wuwe1/booey";        // published package
// import { RelayClient } from "../clients/ts/index.ts";   // in-repo
const relay = new RelayClient({ browser: "shopee-A" });
const tab = await relay.findOrOpenTab(/seller\.shopee\.tw/, "https://seller.shopee.tw/");
await relay.attach(tab.tabId, { events: ["net"] });
const title = await relay.evalFn(tab.tabId, () => document.title);
```

### The agent loop (`relay.agent`)

For the L3 action flow, `relay.agent({ llm, cache })` wraps the whole
self-maintaining loop — snapshot → infer → act → heal → migrate cache. You
**inject** the LLM and the cache; neither enters the daemon. This is a
client-side convenience over the bare layers:

```ts
const agent = relay.agent({ llm, cache });   // llm: {infer(ctx)}, cache: {get,set}
const r = await agent.do(tab.tabId, "add the first item to the cart");
// r: { ok, fromCache, reinferred, results, actions, summary }
```

`do()` keys the cache on `cacheKey(normalizeUrl(url), instruction)` (it strips
volatile query params). A cache hit **replays** the stored actions with no
snapshot and no LLM, and leans on `/act`'s four-level heal; any `relocated` result
migrates the cache in place. A miss (or a replay that returns `needsInference`)
takes a snapshot, calls `llm.infer({ instruction, indexedText, url, snapshot })`,
executes, and writes the resolved actions back. `cacheKey`, `normalizeUrl`, and
`summarizeActions` are exported for a caller that wants the pieces without the
loop.

### Embedding the daemon

The daemon can run in-process instead of as a separate `node daemon/server.ts`
process. A consumer that is the daemon's only caller can skip the standalone
process (and its PID/port management):

```ts
import { createDaemon } from "@wuwe1/booey/daemon";
const daemon = await createDaemon({ port: 9224 });   // resolves once listening
// ... talk to 127.0.0.1:9224 as usual (RelayClient, CLI, raw HTTP) ...
await daemon.close();                                 // frees the port
```

`createDaemon` installs no signal handlers and never calls `process.exit`. It
rejects on `EADDRINUSE`. The extension still connects over the `/ext` WS, so the
embedding process hosts that port: embedding removes the separate process, not the
port. `daemon/server.ts` is the thin standalone entry built on this.

## File structure

```
booey/
├── docs/SPEC.md          # this file
├── clients/ts/index.ts   # supported typed client (published as the package root)
├── daemon/
│   ├── config.ts         # protocol constants + event presets + selector expansion
│   ├── http-error.ts     # Error + httpCode + machine-readable code / retriable
│   ├── ring-buffer.ts    # O(1) fixed-cap FIFO (event cache)
│   ├── ext-conn.ts       # ExtConn: one browser — scheduler + attach + event cache + act
│   ├── page-model.ts     # three trees → NodeRecord[] → indexedText + selectorMap; fuzzy relocate
│   ├── actions.ts        # the closed action vocabulary + its metadata
│   ├── registry.ts       # ExtRegistry: Map<id,ExtConn> + selector resolution
│   ├── create.ts         # createDaemon(): embeddable daemon (router + WS + heartbeat)
│   ├── server.ts         # standalone entry: port/signals/exit over createDaemon
│   └── test-mock-ext.ts  # protocol test double (multi-instance)
├── extension/            # plain JS, shipped uncompiled
│   ├── manifest.json
│   ├── background.js     # identity + daemon WS client + chrome.debugger bridge
│   ├── offscreen-heartbeat.{html,js}  # SW keep-alive Port
│   ├── popup.html
│   └── popup.js          # status / identity panel (daemon state, counters, label editor)
└── cli/booey.ts      # entry; subcommands
```

Everything in `daemon/`, `clients/`, and `cli/` is TypeScript that Node runs
directly (type stripping, no build step in development). `npm run build` emits
`dist/` for publishing only. Node will not strip types under `node_modules`, so
the published package must carry real `.js` and `.d.ts` files.

PID/log per port: `/tmp/booey-<port>.pid` · `/tmp/booey-<port>.log`.

## CLI surface

```
booey daemon start|stop|status [--port 9224]
booey browsers                                # list connected browsers

booey tabs [--browser <id|label>]
booey attach <tabId> [--events nav,net] [--browser <id|label>]
booey detach <tabId> [--browser <id|label>]
booey events show|subscribe <tabId> [<selectors>]
booey eval <tabId> <js> [--await] [--browser <id|label>]
booey net <tabId> {list|body|clear} [--filter <re>] [--since <seq>] [<requestId>] [--browser <id|label>]
booey screenshot <tabId> [<path>] [--browser <id|label>]
booey nav <tabId> <url> [--browser <id|label>]
booey send <tabId> <Method> [<params-json>] [--browser <id|label>]

booey ext path|zip [<out.zip>]                # locate / package the extension
booey doctor                                  # daemon + extension + protocol-version check
```

The CLI does not cover `/snapshot`, `/act`, `/page`, or `/sessions`. Reach those
over HTTP or through `clients/ts`.

`--browser` may also come from the env var `BOOEY_BROWSER`. Output is JSON-line by
default (`--pretty` for human reading).
