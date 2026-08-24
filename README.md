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
- browser A's slow command never blocks browser B, and within a browser one
  tab's slow command never blocks another tab (see SPEC's concurrency model)
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
node cli/cdp-relay.ts daemon start

# 2. see who's connected
node cli/cdp-relay.ts browsers
# → [{ "id": "…", "label": "shopee-A", "attached": [], "tabCount": 7 }, …]

# 3. list tabs in a specific browser, attach, and run JS
node cli/cdp-relay.ts tabs --browser shopee-A
node cli/cdp-relay.ts attach 1734 --browser shopee-A
node cli/cdp-relay.ts eval 1734 "document.title" --browser shopee-A

# 4. another browser, in parallel — independent scheduler
node cli/cdp-relay.ts eval 980 "location.href" --browser shopee-B
```

When only **one** browser is connected, `--browser` is optional. Set
`CDP_RELAY_BROWSER` to avoid repeating the flag.

## Using it from code

`clients/ts` is the supported client — typed, no build step (Node strips the
types natively), shipped with the protocol so it can't drift from it.

```ts
import { RelayClient } from "./clients/ts/index.ts";

const relay = new RelayClient({ browser: "shopee-A" });      // or $CDP_RELAY_BROWSER
const tab = await relay.findOrOpenTab(/seller\.shopee\.tw/, "https://seller.shopee.tw/");
await relay.attach(tab.tabId, { events: ["net"] });          // default is "nav"

// Ship a function from your own source into the logged-in page.
const skus = await relay.evalFn(tab.tabId, (sel) =>
  [...document.querySelectorAll(sel)].map((e) => e.textContent), ".sku");

const page = await relay.readEvents(tab.tabId, { filter: /responseReceived/ });
if (page.truncated) console.warn(`lost ${page.dropped} events`);
```

Failures split three ways: `PageJsError` (the page's JS threw), `RelayError`
with `.code` + `.retriable` (transport / daemon / debugger), and a plain
resolved value. Branch on `.code`, never on the message text.

## Docs

- [`docs/SPEC.md`](docs/SPEC.md) — protocol v4: WS/HTTP contract, concurrency
  model, event subscriptions, addressing, error codes, file map.

## Testing without a real browser

```sh
node daemon/server.ts 9229 &
node daemon/test-mock-ext.ts 9229 browser-A shopee-A &
node daemon/test-mock-ext.ts 9229 browser-B shopee-B &
node cli/cdp-relay.ts --port 9229 browsers
node cli/cdp-relay.ts --port 9229 eval 1001 "x" --browser shopee-A
```
