# cdp-relay

Drive **any number of already-logged-in browsers** from one local process, over
the Chrome DevTools Protocol — through a browser extension that bridges
`chrome.debugger`. No `--remote-debugging-port`, no lost sessions, no SMS/IVS
re-auth: you attach to the user's *real* browser.

```
caller (CLI / agent) ──HTTP──▶ daemon ──WS──▶ extension ──chrome.debugger──▶ tab
```

Why an extension and not `--remote-debugging-port`? Because `chrome.debugger`'s
`Runtime.evaluate` is privileged — it ignores page CSP — and it attaches to the
browser you're already logged into. (Cost: Chrome shows a "an extension is
debugging this browser" banner while attached.)

## Multi-browser

One daemon, many browsers, concurrently. **Build/install the extension once and
load the same build in every browser** — you do *not* package a separate
extension per browser. Each browser profile mints its own persistent random id
on first run (stored in that profile's `chrome.storage.local`, which is
isolated), so two browsers running the identical build are told apart
automatically. Give each a human label in the popup (`shopee-A`, `shopee-B`) and
address it by label or id.

- one WS connection per browser, each independently scheduled
- per-browser serial, cross-browser parallel — browser A's slow command never
  blocks browser B
- works across Chromium-family browsers (Chrome / Edge / Brave / …) and across
  separate profiles of the same browser

## Install

```sh
npm install            # just `ws`
```

Load the extension in each browser: `chrome://extensions` → enable Developer
mode → "Load unpacked" → select `extension/`. Open the popup and set a **label**.

## Quick start

```sh
# 1. start the daemon (one, shared by all browsers)
cli/cdp-relay daemon start

# 2. see who's connected
cli/cdp-relay browsers
# → [{ "id": "…", "label": "shopee-A", "attached": [], "tabCount": 7 }, …]

# 3. list tabs in a specific browser, attach, and run JS
cli/cdp-relay tabs --browser shopee-A
cli/cdp-relay attach 1734 --browser shopee-A
cli/cdp-relay eval 1734 "document.title" --browser shopee-A

# 4. another browser, in parallel — independent serial queue
cli/cdp-relay eval 980 "location.href" --browser shopee-B
```

When only **one** browser is connected, `--browser` is optional. Set
`CDP_RELAY_BROWSER` to avoid repeating the flag.

## Docs

- [`docs/SPEC.md`](docs/SPEC.md) — protocol v2: WS/HTTP contract, addressing,
  error codes, file map.

## Testing without a real browser

```sh
node daemon/server.mjs 9229 &
node daemon/test-mock-ext.mjs 9229 browser-A shopee-A &
node daemon/test-mock-ext.mjs 9229 browser-B shopee-B &
cli/cdp-relay --port 9229 browsers
cli/cdp-relay --port 9229 eval 1001 "x" --browser shopee-A
```
