# CLAUDE.md

Guidance for AI coding agents in this repo. Keep it correct. Update it in the
same change that makes it wrong. The prose is Simplified Technical English (short
active sentences, one idea each); keep it that way.

## What this is

Booey drives many already-logged-in browsers from one local process. It uses the
Chrome DevTools Protocol. A browser extension bridges `chrome.debugger`. One
daemon controls many browsers. It addresses each browser by id or label. The
browsers run at the same time. Booey does not use `--remote-debugging-port`, and
it does not lose sessions.

Segments: `caller (CLI/agent) ──HTTP──▶ daemon ──WS──▶ extension ──chrome.debugger──▶ tab`.

`docs/SPEC.md` is the protocol contract: the wire schema, the HTTP endpoints, the
addressing, the error codes, and the close codes. Read it before you change the
daemon, the extension, or the CLI. This file is orientation. SPEC.md is the
source of truth.

## Commands

```sh
npm install                                      # `ws` (runtime) + typescript/biome/@types/node (dev)
npm run check                                     # THE gate: version:check + typecheck + lint + unit + test + test:pack
npm test                                          # integration + client + lilto compat (see Testing)
npm run test:pack                                 # packs the tarball, installs it, drives it from node_modules
npm run version:check                             # package/manifest/PROTOCOL_VERSION agree
npm run typecheck                                 # tsc --noEmit — strict
npm run lint / npm run format                     # biome (lint / format)
npm run build                                     # dist/ — publish-time only, never needed to develop

node daemon/server.ts [port]                     # run the daemon (default 9224)
node daemon/test-mock-ext.ts <port> <id> <label> # a fake browser (protocol test double)
node cli/booey.ts <command> [--browser <id|label>] [--port N]   # the CLI; `cli/booey help`
node cli/booey.ts ext path                   # where to point "Load unpacked"
node cli/booey.ts doctor                     # daemon/extension/protocol-version check
```

Development needs no build step. Node 22.18 or later runs the `.ts` files
directly, because it strips the types. A build is only for publishing (see
Distribution): Node does not strip types under `node_modules`, so the tarball
must carry real `.js` and `.d.ts` files. No file in the repo imports `dist/`. If
you must build to test something, that is a defect in what you test.

## Layout

```
clients/ts/         the supported typed client — ships with the protocol,
                    not vendored per consumer. Node runs the .ts directly.
daemon/
  config.ts        protocol constants + event presets + selector expansion
  http-error.ts    Error + httpCode + machine-readable `code` / `retriable`
  ring-buffer.ts   O(1) fixed-capacity FIFO (event cache)
  ext-conn.ts      ExtConn — one browser: serial scheduler + attach + event cache + act
  registry.ts      ExtRegistry — Map<id,ExtConn> + selector (id|label) resolution
  page-model.ts    three trees → NodeRecord[] → indexedText + selectorMap; fuzzy relocate
  actions.ts       the closed action vocabulary + resolve/fallback types
  create.ts        createDaemon(): the embeddable daemon (router + WS + heartbeat)
  server.ts        standalone entry; port/signals/exit over createDaemon
  test-mock-ext.ts protocol test double; pass id/label to simulate a browser
extension/          MV3: background.js (identity + WS client + debugger bridge),
                    offscreen-heartbeat.{html,js}, popup.{html,js}, manifest.json
cli/booey.ts        Node CLI over the HTTP API
scripts/check-versions.mjs  the one number that lives in five files
test/integration.mjs  protocol-level end-to-end harness
test/client.mjs       drives clients/ts against the daemon
test/compat-lilto.mjs drives lilto's OWN client (a frozen copy) — see below
test/*.test.ts        unit tests (page-model, actions, fuzzy, agent, create-daemon)
test/pack.mjs         packs + installs the tarball, drives it from node_modules
docs/SPEC.md        protocol contract (authoritative)
docs/booey-design.md  why it is shaped this way + measured numbers (Chinese)
.github/workflows/  ci (checks on push) + release (tag → GH release + ext zip)
dist/               build output, gitignored, publish only
```

## Architecture notes

- **One WS connection per browser**, wrapped in an `ExtConn`. The daemon's HTTP
  layer is a thin router: it resolves the target browser through `ExtRegistry`, it
  calls that `ExtConn`, and it maps `httpCode` to the response.
- **Concurrency has three levels.** Browsers run in parallel (separate
  `ExtConn`s). Tabs run in parallel (separate lanes in one `ExtConn`). In one tab,
  ordered commands run one at a time, but listed reads overlap. The classification
  is in `UNORDERED_CDP_METHODS` (`daemon/config.ts`). A command is ordered by
  default. Add a method to that list only if it is a pure read with no focus,
  input, or navigation effect. Do not add a shared or global command queue.
- **Every command carries a message id.** `_settle(id, …)` is the one exit path
  for a command in flight (response, timeout, detach, disconnect). The daemon
  drops a response that quotes a retired id. That is what makes it safe to give up
  on a command.
- **Browser identity** is a persistent random value. Each profile mints it in
  `chrome.storage.local` on first run. Every browser runs the same extension
  build. Per-profile storage makes the ids distinct on its own. Never put an id in
  the build: the build id is the same in every browser.
- **The daemon subscribes to events; it does not take a firehose.** `attach`
  takes an `events` list of selectors or presets (default `nav`). The extension
  enables only the implied domains. It drops an unsubscribed event before it
  stringifies, sends, or stores it. Ownership is per tab, last writer wins. Do not
  add refcounting. `Runtime` stays off by default: `Runtime.evaluate` is a
  command and does not need the domain enabled.
- **The event cache** is a ring buffer per `(browserId, tabId)`
  (`ring-buffer.ts`), O(1) push, with a monotonic seq. `/events?since=` is an
  incremental pull. `truncated` tells the caller the ring overwrote events it had
  not read. Never drop that flag: lost events and silence must not look the same.
- **L3 is the optional top layer, not the main path.** To read data, use L1
  (`send`/`evalFn`) and L2 (`snapshot`). L3 (`/act`, `agent()`) is worth it only
  for a repeated action that must survive a redesign. Its value is the four-level
  heal and the cache migration, not the action vocabulary. Do not route reads
  through `/act`. A read-only or one-shot consumer never calls it.
- **The extension serializes nothing.** It answers each command as it arrives and
  quotes the id back. The daemon makes all ordering decisions.

## The lilto compatibility gate

lilto is the main consumer. It must keep working with no change on its side. It
runs its own `src/relay/client.ts`. To point it here, set
`LILTO_RELAY=http://127.0.0.1:9224` and nothing else.

`test/fixtures/lilto-client.ts` is a verbatim frozen copy of that file.
`test/compat-lilto.mjs` drives it against this daemon. Rules:

- **Never edit the fixture to make a test pass.** A failure there means the
  daemon broke compatibility. Fix the daemon. Re-copy the file only after lilto
  itself changes, and say so in the commit.
- Error responses keep `error` as a plain string. `code` and `retriable` are
  extra fields next to it. lilto reads `json.error` directly. If that field ever
  became an object, lilto would show `[object Object]`.
- A `Runtime.evaluate` page exception stays a 200 with `exceptionDetails`. lilto
  splits `RelayError` from `PageJsError` by that field.
- `/tabs?fresh=0` and `/open-tab` exist because lilto calls them. `fresh=0` must
  not round-trip to the extension. The mock adds an extra tab only on a real
  `list-tabs`, which keeps that assertion honest.

## Distribution

The package is `@wuwe1/booey`, from `github.com/wuwe1/booey`. A consumer can also
install the git tag directly; `prepare` builds it on install. So the npm registry
is optional.

- **The package version and the protocol version are independent.** The package
  uses normal semver (1.0.0 is the first release). `PROTOCOL_VERSION` is a wire
  number; it moves only when the wire moves. `package.json` →
  `booey.protocolVersion` states which protocol a release speaks.
  `scripts/check-versions.mjs` checks it against the three in-code constants, and
  checks package.json against `extension/manifest.json`. It runs first in
  `npm run check`. The daemon and the extension ship together, so a version
  mismatch almost always means a human did not reload the extension. That is why
  `doctor` exists.
- **Node does not strip types under `node_modules`**
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). That one fact is why `dist/`
  exists. `tsconfig.build.json` turns on `rewriteRelativeImportExtensions`, so the
  source keeps honest `./config.ts` specifiers and the build emits `./config.js`.
  Never "fix" this by rewriting imports to `.js`.
- **A git-tag install builds on the consumer's machine** (`prepare`). pnpm blocks
  dependency build scripts by default. The install then fails until the consumer
  allows this package to build (`allowBuilds` in `pnpm-workspace.yaml`; verified
  on pnpm 11, both the failure and the fix). npm has no such gate. A registry
  publish removes the whole problem, because that tarball arrives prebuilt. That
  is the strongest reason to turn on `NPM_PUBLISH`.
- **`test/pack.mjs` is the only test that sees the published shape.** It packs the
  tarball, extracts it into a `node_modules`, and drives the daemon, the client,
  and the CLI from there. A packaging mistake is invisible everywhere else and
  shows up in the consumer on install day.
- **The extension cannot reach a browser through npm.** Chrome needs a human to
  point "Load unpacked" at a directory. The extension rides in the tarball anyway,
  and `booey ext path` prints where it landed. The tag's GH release carries a zip.
- **`extension/manifest.json` pins `key`.** This fixes the extension ID at
  `dnjdeckelhabngmngmmmhgjnkfhadabl`. `chrome.storage.local` holds the browserId
  and the label, scoped to that ID. An unpinned (path-derived) ID means that
  moving the directory wipes every browser's identity. `version:check` fails if
  the key is removed or yields a different ID. To change it on purpose, update
  `EXTENSION_ID` in `scripts/check-versions.mjs` and relabel every browser by
  hand. The private key is `extension-key.pem` at the repo root. It is gitignored.
  You do not need it for "Load unpacked", only to pack a CRX with this same ID.
  Keep a backup outside the repo. Never commit or publish it.
- **`booey doctor`** exists for the typical failure here: you update the daemon,
  you do not reload the extension, the socket closes with `4000`, the extension
  gives up for good, and the symptom is "nothing happens".
- To release: bump both versions, run `npm run check`, tag `v<version>`, and push.
  `.github/workflows/release.yml` builds the GH release. The npm publish is gated
  on the repo variable `NPM_PUBLISH`.

## Testing

`npm test` runs three suites in order. Expect `PASS=55` (protocol), `PASS=83`
(client), and `PASS=16` (lilto compat), all with `FAIL=0` and exit 0.
`npm run test:pack` is separate (`PASS=13`) because it builds a tarball — see
Distribution. `npm run test:unit` runs the pure-function unit tests.

`test/integration.mjs` spawns the real daemon and two mock-ext processes. It
asserts multi-browser addressing (by id and by label), the error codes (400
ambiguous, 404 unknown, 409 not-attached), event-cache isolation, the three
concurrency levels, response pairing across a give-up, detach-cancels-inflight,
event subscription and filtering, the `/events` cursor, the CLI round-trip, and
same-id reconnect.

The daemon under test uses `BOOEY_CMD_TIMEOUT_MS=500` (give-up path) and
`BOOEY_EVENT_CACHE_CAP=4` (ring truncation), so both are reachable in the suite.
The timing assertions have teeth, checked by mutation: an empty
`UNORDERED_CDP_METHODS` fails "intra-tab reads overlap"; positional response
pairing fails "next command gets its OWN answer"; removing the extension-side
event filter fails "unsubscribed method never crosses the wire". Keep them that
way. An assertion that passes under the bug it names is worse than none.

Mock-ext test hooks: a method with a numeric `params.ms` answers after that
delay, but it does not change what it answers. So a test can time a real method
with its real ordered/unordered class. `Test.noReply` never answers.
`Test.detach` pushes `detached` and never answers. The mock runs the same
subscription filter as the real extension (or the filter tests assert nothing). It
re-emits its event burst on every subscription change, so a test can advance the
`/events` cursor without a reattach.

- The suites await readiness by `setTimeout` polling, not by shell `sleep`. Some
  sandboxes block foreground `sleep`, which breaks timing-based shell tests
  without a message.
- The mocks cover the protocol layer only. A real-browser end-to-end test needs
  you to load `extension/` into a real browser with a logged-in session. It
  cannot be self-verified here.

## Conventions

- **TypeScript in `daemon/`, `cli/`, `clients/`; plain JS in `extension/`.** Node
  22.18 or later runs the `.ts` files directly (type stripping, no build step), so
  use only erasable syntax: no `enum`, `namespace`, decorators, or
  parameter-properties, and import with real `.ts` extensions. Keep JSDoc where it
  helps an editor. Keep runtime dependencies near zero (`ws` only); the
  typecheck/lint tools are dev-only.
- **A protocol change is a six-file edit.** Bump `PROTOCOL_VERSION` in
  `daemon/config.ts`, `extension/background.js`, and `daemon/test-mock-ext.ts`
  (all three must match, or the daemon closes with code `4000`). Bump
  `booey.protocolVersion` in `package.json`. Bump the package version and the
  `extension/manifest.json` version together (semver, independent of the wire
  number). Then update `docs/SPEC.md`. `npm run version:check` catches five of the
  six. A daemon and an extension on different versions do not talk.
- **Keep `docs/SPEC.md` in sync** with any change to the WS messages, the HTTP
  endpoints, the error codes, or the addressing. It is the contract other code is
  written against. Drift is a real defect.
- **Two docs, two jobs. Do not merge them and do not duplicate across them.**
  `docs/SPEC.md` is normative and present-tense: what the wire, the endpoints, and
  the error codes are, in English. `docs/booey-design.md` is the reasoning: why
  this shape, what was measured (with numbers), what was rejected, and what is
  left unbuilt, in Chinese. They cover the same features on purpose. When they
  disagree, SPEC wins and the design doc gets a dated revision note; do not
  silently rewrite it, because the superseded reasoning is the useful part.
- **LLM 推理与动作缓存是调用方的**（设计文档 §6.3 / §11）。daemon 提供快照、`/act`
  重放 + 四级回退，不内置 LLM、不内置 `key → Action[]` 缓存 KV——lilto 等调用方自己
  存、命中就重放、`needsInference` 时重新推理并写回。别把这两层拖回 daemon。
- Match the style of the code around you (small functions, early returns, the
  same comment density).

## Gotchas

- **`/send` needs the tab attached first.** If it is not, you get a 409. Attach
  before you eval.
- **The page `revision` sees only what is subscribed.** An unsubscribed dirtying
  event never reaches the daemon, so `nav` alone under-reports document swaps.
  Never present the revision as more precise than the subscription allows.
- **Subscriptions are not retroactive.** Subscribe before the traffic you want.
  `booey net list` fails loudly when Network is not subscribed, rather than
  return an empty list that reads like "no requests happened".
- **`Network.disable` drops the response-body buffer.** Fetch the bodies before
  you narrow a subscription away from Network.
- **`hello` must carry a non-empty `id` and the current `version`.** If not, the
  daemon closes with `4000` and the extension stops reconnecting for good.
- **One debugger per tab.** If the user opens DevTools on an attached tab, Chrome
  detaches us (`onDetach`).
- **`Target` has no `enable` method** (`-32601`). Its events come from
  `setAutoAttach`. `NO_ENABLE_DOMAINS` in the extension skips it, so it lands in
  neither `enabled` nor `failed`. The mock rejects `Target.enable` for the same
  reason; without that, nothing holds the skip in place.
- **Cross-origin is not cross-site.** Site isolation is scheme + eTLD+1, so
  `a.example.com` inside `example.com` stays in one process and never becomes an
  OOPIF. Do not test OOPIF handling against a subdomain iframe.
- **A tab attachment does not reach into out-of-process iframes.** Anything
  cross-site (payments, embedded logins, ad slots) needs
  `Target.setAutoAttach{flatten:true}` and a `sessionId` on the command. Key
  long-lived state on `targetId`, not `sessionId`; the sessionId changes on
  reattach.
- **`Runtime.evaluate` through `chrome.debugger` bypasses page CSP.** That is the
  whole reason for this design. Do not switch to `executeScript` injection, which
  the page CSP controls.
- **chrome.debugger shows a yellow "an extension is debugging this browser"
  banner** while attached. You cannot hide it. It is an accepted cost.
- **The MV3 service worker dies after about 30s idle.** Keep all three defenses:
  the offscreen-document heartbeat (a 1s Port message — prevention), the
  daemon-to-extension 25s ping, and `chrome.alarms` (resurrection only). Chrome
  clamps alarm periods to a 30s floor, so the alarm cannot prevent SW death; it
  only shortens the outage after it. A request for 0.4min gives you 0.5min.
- **Same-id reconnect** kicks the stale connection (`4002`) and keeps the
  identity. State is keyed on the persistent id, not the connection order. Do not
  change that.
- PID and log files are per port: `/tmp/booey-<port>.{pid,log}`.

## Git

One developer. Commit to `main` directly (no branch, no PR). The commit subject is
`type: description`. Do not add a `Co-Authored-By` trailer. Push only when the
user asks.

Tags are releases: `v<version>`, matching `package.json`. Tag only when the user
asks. A pushed tag triggers `.github/workflows/release.yml`.

## Working with the user

- **Verify before you say done and before you commit.** `npm run check` must be
  green (version sync, typecheck, lint, unit tests, all suites, and the packaging
  test). An edit can mis-apply without a message on a large file, so re-read the
  region after you edit it.
- **Observation is not inference.** Confirm command output by reading the files.
  Do not trust a terminal echo that may be scrambled.
- **Explain before you edit.** For non-trivial work, state what and why, then stop
  for the user's go-ahead before you implement or deploy.
- **Ask in plain text.** Do not use structured question UIs.
- **Look at open-source precedents before you design.** Dispatch a background
  subagent to research, with sources, rather than invent from scratch. The
  `browserbase/stagehand` and `browser-use` checkouts live in
  `~/Developer/browser_agent/`; the design doc holds the measured numbers behind
  the v3/v4/v6 choices.
- Early stage: breaking changes are fine at the protocol layer, because the daemon
  and the extension ship together. The HTTP surface is different: lilto is on the
  other side of it and does not ship with us. See the compatibility gate above.
