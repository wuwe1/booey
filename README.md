# Booey

Drive **any number of already-logged-in browsers** from one local process, over
the Chrome DevTools Protocol, through a browser extension that bridges
`chrome.debugger`. There is no `--remote-debugging-port`, no lost session, and no
SMS/IVS re-auth: you attach to the user's *real* browser.

```
caller (CLI / agent) ──HTTP──▶ daemon ──WS──▶ extension ──chrome.debugger──▶ tab
```

Booey uses an extension, not `--remote-debugging-port`, for two reasons.
`chrome.debugger`'s `Runtime.evaluate` is privileged: it ignores the page CSP. And
it attaches to the browser you are already logged into. (The cost: Chrome shows an
"an extension is debugging this browser" banner while it is attached.)

Three layers, each usable on its own:

| | | |
|---|---|---|
| **L1** transport | multiplexed CDP RPC, per-tab concurrency, event subscriptions | `/send` `/events` |
| **L2** page model | snapshot → flat nodes + LLM-facing indexed text + stable element identity | `/snapshot` |
| **L3** actions *(optional)* | eleven element actions, replayed with a four-level fallback | `/act` |

**To read data, use L1 + L2.** L3 is the optional top layer. It pays off only for
the "same action task, run repeatedly, must survive a redesign" pattern. Its value
is the heal and the cache migration, not the action vocabulary. A read-only or
one-shot consumer never touches it.

Booey is **not** an agent: no LLM, no agent loop, no action cache. Those belong to
the caller ([design doc](docs/booey-design.md) §6.3 / §11).

## Multi-browser

One daemon, many browsers, at the same time. **Build the extension once and load
the same build in every browser.** You do not package a separate extension per
browser. Each browser profile mints its own persistent random id on first run.
The profile stores it in that profile's `chrome.storage.local`, which is isolated,
so two browsers that run the identical build stay distinct automatically. Give
each one a human label in the popup (`shopee-A`, `shopee-B`), and address it by
label or by id.

- one WS connection per browser, each scheduled on its own
- browser A's slow command never blocks browser B; within a browser, one tab's
  slow command never blocks another tab (see SPEC's concurrency model)
- works across Chromium-family browsers (Chrome / Edge / Brave / …) and across
  separate profiles of the same browser

## Install

```sh
# from the repo (no registry account needed — the package builds on install)
npm install github:wuwe1/booey#v1.0.0
# or, once published
npm install @wuwe1/booey
```

An install from the git tag builds the package itself in `prepare`. pnpm blocks
dependency build scripts by default, so that install fails outright. Allow this
one package to build:

```yaml
# pnpm-workspace.yaml
allowBuilds:
  "@wuwe1/booey": true
```

An install from the npm registry needs none of that, because that tarball is
already built.

**The daemon and the extension must speak the same protocol version.** They ship
in the same tarball, so the one way to get this wrong is to update the package and
not reload the extension. Then the daemon closes the socket with code `4000`, and
the extension stops reconnecting for good. Reload the extension when you bump the
package, and run `booey doctor`, which exists to catch exactly this.

The package version is ordinary semver and moves on its own, apart from the wire.
Each release states its protocol in `package.json` → `booey.protocolVersion`:

| package | protocol |
|---|---|
| 1.x | v6 |

Then load the extension **in each browser**. It cannot ride along with npm,
because Chrome needs a human to point at a directory:

```sh
npx booey ext path      # → …/node_modules/@wuwe1/booey/extension
```

`chrome://extensions` → enable Developer mode → "Load unpacked" → that path. Open
the popup and set a **label**. Repeat per browser or profile.

The manifest pins a `key`, so the extension ID is fixed
(`dnjdeckelhabngmngmmmhgjnkfhadabl`) whatever directory you load it from. This
matters because the browser's persistent id and its label live in
`chrome.storage.local`, which is scoped to the extension ID. Without the pin, the
ID comes from the install path, and to move the directory would silently reset
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
`BOOEY_BROWSER` so you do not repeat the flag.

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

For data extraction, thin L1/L2 helpers remove the boilerplate. `withTab` attaches
and detaches for you; `waitForResponse` grabs an API body (more durable than the
rendered DOM); `waitForSelector` and `settled({net})` wait for the data to arrive:

```ts
const data = await relay.withTab(/seller\.shopee/, async (tab) => {
  await relay.subscribe(tab.tabId, ["net"]);          // subscribe before the request
  const r = await relay.waitForResponse(tab.tabId, /\/api\/product\/list/);
  return r.json;                                       // parsed body
}, { openUrl: "https://seller.shopee.tw/" });
```

Over a `Snapshot`, `nodesByRole` / `nodesByText` / `interactiveNodes` / `newNodes`
query the page model directly, for deterministic reads with no LLM.

Failures split three ways: `PageJsError` (the page's JS threw), `RelayError` with
`.code` and `.retriable` (transport / daemon / debugger), and a plain resolved
value. Branch on `.code`, never on the message text.

For repeated L3 actions, `relay.agent({ llm, cache })` runs the self-maintaining
loop (snapshot → infer → act → heal → migrate cache). You inject the LLM and the
cache; neither enters the daemon. See SPEC's "The agent loop".

```ts
const agent = relay.agent({ llm, cache });
const r = await agent.do(tab.tabId, "add the first item to the cart");
```

To talk to the daemon over plain HTTP is equally supported and equally stable. The
client is a convenience, not a gate. The endpoints are in the SPEC.

Package entry points:

| specifier | what |
|---|---|
| `@wuwe1/booey` | the typed client (`RelayClient`, the error types, `NodeRecord`/`Snapshot`/action types, `agent`) |
| `@wuwe1/booey/daemon` | `createDaemon` — the embeddable daemon (see SPEC's "Embedding the daemon") |
| `@wuwe1/booey/mock-ext` | the protocol test double, to test a consumer without a real browser |
| `@wuwe1/booey/extension/*` | the unpacked extension's files |

## Docs

- [`docs/SPEC.md`](docs/SPEC.md) — protocol v6: the WS/HTTP contract, the
  concurrency model, event subscriptions, sessions, the page model, actions, and
  the error codes.
- [`docs/booey-design.md`](docs/booey-design.md) — why it is shaped this way, with
  the measured numbers behind each choice, and what is deliberately not built
  (Chinese).

## Development

No build step: Node 22.18 or later runs the `.ts` files directly (type stripping).

```sh
npm install
node daemon/server.ts 9224          # or: node cli/booey.ts daemon start
npm run check                        # version sync + typecheck + lint + tests + packaging
```

A build exists only at publish time (`npm run build` → `dist/`), because Node does
not strip types for files under `node_modules`; a consumer needs real `.js` and
`.d.ts`. `npm run test:pack` installs the packed tarball the way a consumer would
and drives the daemon, the client, and the CLI out of `node_modules`.

### Testing without a real browser

```sh
node daemon/server.ts 9229 &
node daemon/test-mock-ext.ts 9229 browser-A shopee-A &
node daemon/test-mock-ext.ts 9229 browser-B shopee-B &
node cli/booey.ts --port 9229 browsers
node cli/booey.ts --port 9229 eval 1001 "x" --browser shopee-A
```

The mocks cover the protocol layer only. Anything that involves a real page — the
snapshot pipeline, actions, OOPIFs — you must check against a browser with the
extension loaded.

### Releasing

1. Bump `version` in `package.json` **and** `extension/manifest.json` (they must
   match). If the wire changed, bump `booey.protocolVersion` with it.
   `npm run version:check` enforces both.
2. Run `npm run check`.
3. Tag `v<version>` and push. CI builds the release and attaches the extension zip
   (`booey ext zip` does the same locally).

## License

MIT — see [LICENSE](LICENSE).
