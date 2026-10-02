# Booey

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

Three layers, each usable on its own:

| | | |
|---|---|---|
| **L1** transport | multiplexed CDP RPC, per-tab concurrency, event subscriptions | `/send` `/events` |
| **L2** page model | snapshot → flat nodes + LLM-facing indexed text + stable element identity | `/snapshot` |
| **L3** actions | eleven element actions, replayed with a three-level fallback | `/act` |

It is **not** an agent: no LLM, no agent loop, no action cache. Those belong to
the caller ([design doc](docs/booey-design.md) §6.3 / §11).

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
# from the repo (no registry account needed — the package builds on install)
npm install github:wuwe1/booey#v1.0.0
# or, once published
npm install @wuwe1/booey
```

Installing from the git tag means the package builds itself in `prepare`, and
**pnpm blocks dependency lifecycle scripts by default** — the install fails
outright. Allow this one package to build:

```yaml
# pnpm-workspace.yaml
allowBuilds:
  "@wuwe1/booey": true
```

Installing from the npm registry needs none of that: that tarball is already
built.

**The daemon and the extension have to speak the same protocol version.** They
ship in the same tarball, so the only way to get that wrong is to update the
package and not reload the extension — and then the daemon closes the socket
with code `4000` and the extension stops reconnecting *permanently*. Reload the
extension when you bump the package, and run `booey doctor`, which exists to
catch exactly this.

The package version is ordinary semver and moves independently of the wire.
Each release states its protocol in `package.json` → `booey.protocolVersion`:

| package | protocol |
|---|---|
| 1.x | v6 |

Then load the extension **in each browser** — it can't ride along with npm,
because Chrome needs a human to point at a directory:

```sh
npx booey ext path      # → …/node_modules/@wuwe1/booey/extension
```

`chrome://extensions` → enable Developer mode → "Load unpacked" → that path.
Open the popup and set a **label**. Repeat per browser/profile.

The manifest pins a `key`, so the extension ID is fixed
(`dnjdeckelhabngmngmmmhgjnkfhadabl`) no matter which directory you load it from.
That matters because the browser's persistent id and its label live in
`chrome.storage.local`, which is scoped to the extension ID — without the pin,
the ID comes from the install path and moving the directory would silently reset
every browser's identity.

```sh
npx booey doctor        # daemon up? extension loaded? protocol versions agreed?
```

## Quick start

```sh
# 1. start the daemon (one, shared by all browsers)
npx booey daemon start

# 2. see who's connected
npx booey browsers
# → [{ "id": "…", "label": "shopee-A", "attached": [], "tabCount": 7 }, …]

# 3. list tabs in a specific browser, attach, and run JS
npx booey tabs --browser shopee-A
npx booey attach 1734 --browser shopee-A
npx booey eval 1734 "document.title" --browser shopee-A

# 4. another browser, in parallel — independent scheduler
npx booey eval 980 "location.href" --browser shopee-B
```

When only **one** browser is connected, `--browser` is optional. Set
`BOOEY_BROWSER` to avoid repeating the flag.

## Using it from code

The typed client ships with the protocol, in this repo, so a wire change and the
client it breaks land in the same commit.

```ts
import { RelayClient } from "@wuwe1/booey";

const relay = new RelayClient({ browser: "shopee-A" });      // or $BOOEY_BROWSER
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

Talking to the daemon over plain HTTP is equally supported and equally stable —
the client is a convenience, not a gate. Endpoints are in the SPEC.

Package entry points:

| specifier | what |
|---|---|
| `@wuwe1/booey` | the typed client (`RelayClient`, error types, `NodeRecord`/`Snapshot`/action types) |
| `@wuwe1/booey/daemon` | the daemon bootstrap — importing it starts a server (embedders normally spawn it instead) |
| `@wuwe1/booey/mock-ext` | the protocol test double, for testing a consumer without a real browser |
| `@wuwe1/booey/extension/*` | the unpacked extension's files |

## Docs

- [`docs/SPEC.md`](docs/SPEC.md) — protocol v6: WS/HTTP contract, concurrency
  model, event subscriptions, sessions, page model, actions, error codes.
- [`docs/booey-design.md`](docs/booey-design.md) — why it is shaped this
  way, with the measured numbers behind each choice, and what is deliberately
  not built.

## Development

No build step: Node ≥22.18 runs the `.ts` directly (type stripping).

```sh
npm install
node daemon/server.ts 9224          # or: node cli/booey.ts daemon start
npm run check                        # version sync + typecheck + lint + tests + packaging
```

A build exists only at publish time (`npm run build` → `dist/`), because Node
refuses to strip types for files under `node_modules` — a consumer needs real
`.js` + `.d.ts`. `npm run test:pack` installs the packed tarball the way a
consumer would and drives the daemon, client, and CLI out of `node_modules`.

### Testing without a real browser

```sh
node daemon/server.ts 9229 &
node daemon/test-mock-ext.ts 9229 browser-A shopee-A &
node daemon/test-mock-ext.ts 9229 browser-B shopee-B &
node cli/booey.ts --port 9229 browsers
node cli/booey.ts --port 9229 eval 1001 "x" --browser shopee-A
```

Mocks cover the protocol layer only. Anything involving a real page — the
snapshot pipeline, actions, OOPIFs — has to be checked against a browser with
the extension loaded.

### Releasing

1. Bump `version` in `package.json` **and** `extension/manifest.json` (they must
   match); if the wire changed, bump `booey.protocolVersion` with it.
   `npm run version:check` enforces both.
2. `npm run check`.
3. Tag `v<version>` and push — CI builds the release and attaches the extension
   zip (`booey ext zip` locally does the same).

## License

MIT — see [LICENSE](LICENSE).
