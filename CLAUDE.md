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
daemon/
  config.mjs        protocol constants (PROTOCOL_VERSION, timeouts, cache cap)
  http-error.mjs    Error + httpCode helper
  ring-buffer.mjs   O(1) fixed-capacity FIFO (event cache)
  ext-conn.mjs      ExtConn — one browser: serial scheduler + attach + event cache
  registry.mjs      ExtRegistry — Map<id,ExtConn> + selector (id|label) resolution
  server.mjs        HTTP + WS bootstrap; thin router that delegates to ExtConn
  test-mock-ext.mjs protocol test double; pass id/label to simulate a browser
extension/          MV3: background.js (identity + WS client + debugger bridge),
                    popup.{html,js} (debug fallback + label editor), manifest.json
cli/cdp-relay       Node CLI over the HTTP API
test/integration.mjs  end-to-end test harness
docs/SPEC.md        protocol contract (authoritative)
```

## Architecture notes

- **One WS connection per browser**, wrapped in an `ExtConn`. The daemon's HTTP
  layer is a thin router: resolve the target browser via `ExtRegistry`, delegate
  to that `ExtConn`, translate `httpCode` → response.
- **Per-browser serial, cross-browser parallel.** Each `ExtConn` keeps one command
  in flight (its own `inflight`/`pending`); different browsers run concurrently.
  Do **not** introduce a shared/global command queue — it would serialize browsers.
- **Browser identity** is a persistent random value minted in each profile's
  `chrome.storage.local` on first run. Same extension build installed everywhere;
  per-profile storage makes ids distinct automatically. Never bake an id into the
  build (the extension build id is identical across browsers).
- **Event cache** is a per-`(browserId, tabId)` ring buffer (`ring-buffer.mjs`),
  O(1) push. `/events` is a repeatable batch pull (re-pulling returns the same data).

## Testing

`npm test` (`test/integration.mjs`) spawns the real daemon + two mock-ext
processes and asserts multi-browser addressing (by id and label), error codes
(400 ambiguous / 404 unknown / 409 not-attached), event-cache isolation,
concurrency, the CLI round-trip, and same-id reconnect. Expect `PASS=22 FAIL=0`,
exit 0.

- Readiness is awaited via `setTimeout` polling, **not** shell `sleep` (some
  sandboxes block foreground `sleep`, which silently breaks timing-based shell tests).
- Mocks cover the protocol layer only. **Real-browser end-to-end** requires
  manually loading `extension/` into a real browser and a logged-in session;
  it cannot be self-verified here.

## Conventions

- **Plain ES modules (`.mjs`), Node ≥18.** No TypeScript, no bundler. JSDoc on
  exported classes for editor types. Keep dependencies near-zero (`ws` only).
- **Protocol changes are a three-file edit:** bump `PROTOCOL_VERSION` in
  `daemon/config.mjs` **and** `extension/background.js` (they must match, or the
  daemon closes the ext with code `4000`), and update `docs/SPEC.md`. A daemon and
  extension on mismatched versions will not talk.
- **Keep `docs/SPEC.md` in sync** with any change to the WS messages, HTTP
  endpoints, error codes, or addressing. It is the contract other code is written
  against; drift is a real bug.
- Match the style of surrounding code (small functions, early returns, the existing
  comment density).

## Gotchas

- **`/send` requires the tab be attached first** — otherwise 409. Attach before eval.
- **`hello` must carry a non-empty `id` and `version: 2`**, else the daemon closes
  `4000` and the extension stops reconnecting permanently.
- **One debugger per tab.** If the user opens DevTools on an attached tab, Chrome
  detaches us (`onDetach`).
- **`Runtime.evaluate` via `chrome.debugger` bypasses page CSP** — that is the
  whole reason for this design. Do not switch to `executeScript` injection (subject
  to page CSP).
- **chrome.debugger shows a yellow "an extension is debugging this browser" banner**
  while attached. It cannot be hidden; accepted cost.
- **MV3 service worker dies after ~30s idle.** `chrome.alarms` (24s) plus the
  daemon→ext 25s ping keep it alive — keep both mechanisms.
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
- Early stage: **breaking changes are fine** — no back-compat or migrations needed yet.

## Provenance

Ported from `listo` repo's `dev/cdp-relay/` (single-browser, protocol v1) and
rewritten for multi-browser (protocol v2). The original lives at
`~/Developer/listo/dev/cdp-relay/`. A separate copy of the daemon is embedded in
`listo-agent`'s Electron main (`src/main/cdp-relay-daemon.ts`) and is **not** yet
upgraded to v2 — out of scope unless explicitly asked.
