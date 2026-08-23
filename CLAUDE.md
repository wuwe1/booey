# CLAUDE.md

Guidance for AI coding agents working in this repo. Keep it accurate — update it
in the same change that invalidates it.

## What this is

`cdp-relay` drives **multiple already-logged-in browsers** from one local process
over the Chrome DevTools Protocol, through a browser extension that bridges
`chrome.debugger`. One daemon, many browsers, addressed by id/label, running
concurrently. No `--remote-debugging-port`, no lost sessions.

Three segments: `caller (CLI/agent) ──HTTP──▶ daemon ──WS──▶ extension ──chrome.debugger──▶ tab`.

**`docs/SPEC.md` is the authoritative protocol contract** (wire schema, HTTP
endpoints, addressing, error codes, close codes). Read it before touching the
daemon, extension, or CLI. This file is orientation; SPEC.md is the source of truth.

## Commands

```sh
npm install                                      # only dependency is `ws`
npm test                                          # integration test (see Testing)
node --check <file.mjs>                           # syntax-check (there is no build/TS step)

node daemon/server.mjs [port]                     # run the daemon (default 9223)
node daemon/test-mock-ext.mjs <port> <id> <label> # a fake browser (protocol test double)
cli/cdp-relay <command> [--browser <id|label>] [--port N]   # the CLI; `cli/cdp-relay help`
```

There is **no compiler and no lint step**. Validation = `node --check` on changed
files + `npm test` green.

## Layout

```
clients/ts/         the supported typed client — ships with the protocol,
                    not vendored per consumer. Node runs the .ts directly.
daemon/
  config.mjs        protocol constants + event presets + selector expansion
  http-error.mjs    Error + httpCode + machine-readable `code` / `retriable`
  ring-buffer.mjs   O(1) fixed-capacity FIFO (event cache)
  ext-conn.mjs      ExtConn — one browser: serial scheduler + attach + event cache
  registry.mjs      ExtRegistry — Map<id,ExtConn> + selector (id|label) resolution
  server.mjs        HTTP + WS bootstrap; thin router that delegates to ExtConn
  test-mock-ext.mjs protocol test double; pass id/label to simulate a browser
extension/          MV3: background.js (identity + WS client + debugger bridge),
                    offscreen-heartbeat.{html,js}, popup.{html,js}, manifest.json
cli/cdp-relay       Node CLI over the HTTP API
test/integration.mjs  protocol-level end-to-end harness
test/client.mjs       drives clients/ts against the daemon
test/compat-lilto.mjs drives lilto's OWN client (a frozen copy) — see below
docs/SPEC.md        protocol contract (authoritative)
```

## Architecture notes

- **One WS connection per browser**, wrapped in an `ExtConn`. The daemon's HTTP
  layer is a thin router: resolve the target browser via `ExtRegistry`, delegate
  to that `ExtConn`, translate `httpCode` → response.
- **Concurrency is three-level** (v3): browsers parallel (separate `ExtConn`s),
  tabs parallel (separate lanes inside one `ExtConn`), and within a tab ordered
  commands serialize while listed reads overlap. Classification lives in
  `UNORDERED_CDP_METHODS` (`daemon/config.mjs`) and **defaults to ordered** — add
  a method there only if it is a pure read with no focus/input/navigation
  semantics. Do **not** introduce a shared/global command queue.
- **Every command carries a message id**; `_settle(id, …)` is the single exit
  path for an in-flight command (response, timeout, detach, disconnect). A
  response quoting a retired id is dropped, which is what makes giving up safe.
- **Browser identity** is a persistent random value minted in each profile's
  `chrome.storage.local` on first run. Same extension build installed everywhere;
  per-profile storage makes ids distinct automatically. Never bake an id into the
  build (the extension build id is identical across browsers).
- **Events are subscribed, not firehosed** (v4). `attach` takes an `events` list
  of selectors/presets (default `nav`); the ext enables only the implied domains
  and drops unsubscribed events **before stringify/send/store**. Ownership is
  per-tab last-writer-wins — do not add refcounting. `Runtime` stays off by
  default: `Runtime.evaluate` is a command and does not need the domain enabled.
- **Event cache** is a per-`(browserId, tabId)` ring buffer (`ring-buffer.mjs`),
  O(1) push, with monotonic seq. `/events?since=` is an incremental pull;
  `truncated` tells the caller the ring ate events it had not read. Never drop
  that flag — losing events and nothing happening must not look identical.
- **The extension does not serialize anything.** It answers commands as they
  arrive and quotes the id back. All ordering decisions are the daemon's.

## The lilto compatibility gate

**lilto is the main consumer and must keep working with zero changes on its
side.** It runs its own `src/relay/client.ts`; pointing it here is a matter of
`LILTO_RELAY=http://127.0.0.1:9224` and nothing else.

`test/fixtures/lilto-client.ts` is a **verbatim frozen copy** of that file, and
`test/compat-lilto.mjs` drives it against this daemon. Rules:

- **Never edit the fixture to make a test pass.** A failure there means the
  daemon broke compatibility. Fix the daemon, or — only after lilto has actually
  been updated — re-copy the file and say so in the commit.
- Error responses keep `error` as a **plain string**. `code` / `retriable` are
  additive siblings. lilto reads `json.error` directly and would render
  `[object Object]` if that ever became structured.
- `Runtime.evaluate` page exceptions stay a **200 + `exceptionDetails`**. lilto
  splits `RelayError` from `PageJsError` itself by inspecting that field.
- `/tabs?fresh=0` and `/open-tab` exist because lilto calls them. `fresh=0` must
  genuinely *not* round-trip to the ext — the mock returns an extra tab only via
  a real `list-tabs`, which is what keeps that assertion honest.

## Testing

`npm test` (`test/integration.mjs`) spawns the real daemon + two mock-ext
processes and asserts multi-browser addressing (by id and label), error codes
(400 ambiguous / 404 unknown / 409 not-attached), event-cache isolation, the
three concurrency levels, response pairing across a give-up, detach-cancels-
inflight, event subscription/filtering, the `/events` cursor, the CLI round-trip,
and same-id reconnect. `npm test` runs three suites in order — expect
`PASS=50` (protocol), `PASS=28` (client), `PASS=16` (lilto compat), all
`FAIL=0`, exit 0.

The daemon under test runs with `CDP_RELAY_CMD_TIMEOUT_MS=500` (give-up path)
and `CDP_RELAY_EVENT_CACHE_CAP=4` (ring truncation) so both are reachable
in-suite. The timing assertions have teeth — verified by
mutation (emptying `UNORDERED_CDP_METHODS` fails "intra-tab reads overlap";
pairing responses positionally fails "next command gets its OWN answer"; removing
the ext-side event filter fails "unsubscribed method never crosses the wire").
Keep them that way: an assertion that passes under the bug it names is worse than
none.

Mock-ext test hooks: any method with a numeric `params.ms` answers after that
delay **without changing what it answers**, so a real method can be timed with
its real ordered/unordered classification. `Test.noReply` never answers;
`Test.detach` pushes `detached` and never answers. The mock implements the same
subscription filter as the real ext (otherwise the filter tests assert nothing)
and re-emits its event burst on every subscription change, so a test can advance
the `/events` cursor without reattaching.

- Readiness is awaited via `setTimeout` polling, **not** shell `sleep` (some
  sandboxes block foreground `sleep`, which silently breaks timing-based shell tests).
- Mocks cover the protocol layer only. **Real-browser end-to-end** requires
  manually loading `extension/` into a real browser and a logged-in session;
  it cannot be self-verified here.

## Conventions

- **Plain ES modules (`.mjs`), Node ≥18.** No TypeScript, no bundler. JSDoc on
  exported classes for editor types. Keep dependencies near-zero (`ws` only).
- **Protocol changes are a four-file edit:** bump `PROTOCOL_VERSION` in
  `daemon/config.mjs`, `extension/background.js`, **and**
  `daemon/test-mock-ext.mjs` (all must match, or the daemon closes with code
  `4000`), then update `docs/SPEC.md`. A daemon and extension on mismatched
  versions will not talk.
- **Keep `docs/SPEC.md` in sync** with any change to the WS messages, HTTP
  endpoints, error codes, or addressing. It is the contract other code is written
  against; drift is a real bug.
- Match the style of surrounding code (small functions, early returns, the existing
  comment density).

## Gotchas

- **`/send` requires the tab be attached first** — otherwise 409. Attach before eval.
- **Subscriptions are not retroactive.** Subscribe before the traffic you want,
  not after. `cdp-relay net list` fails loudly when Network isn't subscribed
  rather than returning an empty list that reads like "no requests happened".
- **`Network.disable` drops the response-body buffer** — fetch bodies before
  narrowing a subscription away from Network.
- **`hello` must carry a non-empty `id` and `version: 2`**, else the daemon closes
  `4000` and the extension stops reconnecting permanently.
- **One debugger per tab.** If the user opens DevTools on an attached tab, Chrome
  detaches us (`onDetach`).
- **`Runtime.evaluate` via `chrome.debugger` bypasses page CSP** — that is the
  whole reason for this design. Do not switch to `executeScript` injection (subject
  to page CSP).
- **chrome.debugger shows a yellow "an extension is debugging this browser" banner**
  while attached. It cannot be hidden; accepted cost.
- **MV3 service worker dies after ~30s idle.** Three mechanisms, keep all of
  them: the offscreen-document heartbeat (1s Port message — prevention), the
  daemon→ext 25s ping, and `chrome.alarms` (resurrection only). **Chrome clamps
  alarm periods to a 30s floor**, so the alarm cannot prevent SW death — it can
  only shorten the outage afterwards. Asking for 0.4min gets you 0.5min.
- **Same-id reconnect** kicks the stale connection (`4002`) and keeps the identity.
  State is keyed on the persistent id, not connection order — don't change that.
- PID/log files are per-port: `/tmp/cdp-relay-<port>.{pid,log}`.

## Git

Sole developer; commit to `main` directly (no branch/PR). Commit subject `type: description`.
Do **not** add a `Co-Authored-By` trailer. Push only when the user asks.

## Working with the user

- **Verify before claiming done and before committing:** `npm test` green +
  `node --check` clean. Edits can silently mis-apply on large files — re-read the
  region after editing to confirm it landed.
- **Observation ≠ inference.** Confirm command output by reading files; don't trust
  a possibly-scrambled terminal echo.
- **Explain before editing.** For non-trivial work, lay out what + why and stop for
  the user's go-ahead before implementing or deploying.
- **Ask in plain text.** Don't use structured question UIs.
- **Look at open-source precedents before designing** (dispatch a background
  subagent for research, with sources) rather than inventing from scratch.
- Early stage: **breaking changes are fine** at the protocol layer (daemon ↔ ext
  ship together). The **HTTP surface is different** — lilto is on the other side
  of it and does not ship with us. See the compatibility gate above.

## Protocol history

- **v1** (in `listo`) single browser.
- **v2** multi-browser: `hello` carries `{id, label}`; one command in flight per
  browser, responses paired positionally.
- **v3** every command carries a message id; per-tab lanes; ordered/unordered
  classification; `detached` cancels that tab's work; offscreen SW heartbeat.
- **v4** event subscriptions with presets, ext-side filtering, `/events` seq
  cursor with a `truncated` flag, `Runtime` off by default. Also (not protocol,
  same release): `/open-tab`, `/tabs?fresh=0`, per-command `timeoutMs`,
  structured error codes, and `clients/ts`.

v3 and v4 were motivated by an audit against `browserbase/stagehand` and
`browser-use` (see `~/Developer/browser_agent/docs/hitch-design.md`).

## Provenance

Ported from `listo` repo's `dev/cdp-relay/` (single-browser, protocol v1) and
rewritten for multi-browser (protocol v2). The original lives at
`~/Developer/listo/dev/cdp-relay/`. A separate copy of the daemon is embedded in
`listo-agent`'s Electron main (`src/main/cdp-relay-daemon.ts`) and is **not** yet
upgraded to v2 — out of scope unless explicitly asked.
