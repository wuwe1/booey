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
node cli/cdp-relay.ts <command> [--browser <id|label>] [--port N]   # the CLI; `cli/cdp-relay help`
node cli/cdp-relay.ts ext path                   # where to point "Load unpacked"
node cli/cdp-relay.ts doctor                     # daemon/extension/protocol-version check
```

**No build step in development** — Node ≥22.18 runs `.ts` directly via type
stripping. A build exists only for publishing (see Distribution): Node refuses
to strip types under `node_modules`, so the tarball must carry real `.js` +
`.d.ts`. Nothing in the repo imports `dist/`; if you find yourself building to
test something, that's a bug in what you're testing.

## Layout

```
clients/ts/         the supported typed client — ships with the protocol,
                    not vendored per consumer. Node runs the .ts directly.
daemon/
  config.ts        protocol constants + event presets + selector expansion
  http-error.ts    Error + httpCode + machine-readable `code` / `retriable`
  ring-buffer.ts   O(1) fixed-capacity FIFO (event cache)
  ext-conn.ts      ExtConn — one browser: serial scheduler + attach + event cache
  registry.ts      ExtRegistry — Map<id,ExtConn> + selector (id|label) resolution
  create.ts        createDaemon(): the embeddable daemon (router + WS + heartbeat)
  server.ts        standalone entry; port/signals/exit over createDaemon
  test-mock-ext.ts protocol test double; pass id/label to simulate a browser
extension/          MV3: background.js (identity + WS client + debugger bridge),
                    offscreen-heartbeat.{html,js}, popup.{html,js}, manifest.json
cli/cdp-relay.ts    Node CLI over the HTTP API
scripts/check-versions.mjs  the one number that lives in five files
test/integration.mjs  protocol-level end-to-end harness
test/client.mjs       drives clients/ts against the daemon
test/compat-lilto.mjs drives lilto's OWN client (a frozen copy) — see below
test/pack.mjs         packs + installs the tarball, drives it from node_modules
docs/SPEC.md        protocol contract (authoritative)
docs/cdp-relay-design.md  why it is shaped this way + measured numbers (see Docs)
.github/workflows/  ci (checks on push) + release (tag → GH release + ext zip)
dist/               build output, gitignored, publish only
```

## Architecture notes

- **One WS connection per browser**, wrapped in an `ExtConn`. The daemon's HTTP
  layer is a thin router: resolve the target browser via `ExtRegistry`, delegate
  to that `ExtConn`, translate `httpCode` → response.
- **Concurrency is three-level** (v3): browsers parallel (separate `ExtConn`s),
  tabs parallel (separate lanes inside one `ExtConn`), and within a tab ordered
  commands serialize while listed reads overlap. Classification lives in
  `UNORDERED_CDP_METHODS` (`daemon/config.ts`) and **defaults to ordered** — add
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
- **Event cache** is a per-`(browserId, tabId)` ring buffer (`ring-buffer.ts`),
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

## Distribution

Published as **`@wuwe1/cdp-relay`** from this repo (`github.com/wuwe1/cdp-relay`);
consumers can equally install the git tag directly (`prepare` builds on install),
which is why the npm registry is optional here.

- **Package version and protocol version are independent.** The package is on
  ordinary semver (1.0.0 is the first release); `PROTOCOL_VERSION` is a wire
  number that moves only when the wire moves. The published statement of which
  protocol a release speaks is `package.json` → `cdpRelay.protocolVersion`, and
  `scripts/check-versions.mjs` enforces it against the three in-code constants,
  plus package.json ↔ `extension/manifest.json`. It runs first in `npm run check`.
  Daemon and extension ship together, so the only realistic way to get a version
  mismatch is a human not reloading the extension — hence `doctor`.
- **Node will not type-strip under `node_modules`**
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). That single fact is why
  `dist/` exists. `tsconfig.build.json` turns on `rewriteRelativeImportExtensions`
  so the source keeps its honest `./config.ts` specifiers and the emit gets
  `./config.js`. **Never** "fix" this by rewriting imports to `.js`.
- **A git-tag install builds on the consumer's machine** (`prepare`), and
  **pnpm blocks dependency lifecycle scripts by default** — the install fails
  until the consumer allows this package to build (`allowBuilds` in
  `pnpm-workspace.yaml`; verified against pnpm 11, both the failure and the fix).
  npm has no such gate. Publishing to the registry removes the whole problem,
  since that tarball arrives prebuilt — the strongest argument for actually
  turning on `NPM_PUBLISH`.
- **`test/pack.mjs` is the only test that sees the published shape.** It packs,
  extracts into a `node_modules`, and drives daemon + client + CLI from there.
  A packaging mistake is invisible everywhere else in this repo and shows up in
  the consumer, on install day.
- **The extension cannot ship through npm to a browser** — Chrome needs a human
  pointing "Load unpacked" at a directory. It rides in the tarball anyway, and
  `cdp-relay ext path` prints where it landed; the tag's GH release carries a zip.
- **`extension/manifest.json` pins `key`**, fixing the extension ID at
  `dnjdeckelhabngmngmmmhgjnkfhadabl`. `chrome.storage.local` — where the
  browserId and label live — is scoped to that ID, so an unpinned (path-derived)
  ID means moving the directory wipes every browser's identity. `version:check`
  fails if the key is removed or produces a different ID; changing it on purpose
  means updating `EXTENSION_ID` in `scripts/check-versions.mjs` **and** relabeling
  every browser by hand. The matching private key is `extension-key.pem` at the
  repo root — gitignored, not needed for "Load unpacked", only for ever packing a
  CRX with this same ID. Keep a backup outside the repo; never commit or publish it.
- **`cdp-relay doctor`** exists for the characteristic failure of this
  arrangement: daemon updated, extension not reloaded ⇒ close `4000` ⇒ the
  extension gives up permanently and the symptom is "nothing happens".
- Release = bump both versions → `npm run check` → tag `v<version>` → push.
  `.github/workflows/release.yml` builds the GH release; npm publish is gated on
  the repo variable `NPM_PUBLISH`.

## Testing

`npm test` (`test/integration.mjs`) spawns the real daemon + two mock-ext
processes and asserts multi-browser addressing (by id and label), error codes
(400 ambiguous / 404 unknown / 409 not-attached), event-cache isolation, the
three concurrency levels, response pairing across a give-up, detach-cancels-
inflight, event subscription/filtering, the `/events` cursor, the CLI round-trip,
and same-id reconnect. `npm test` runs three suites in order — expect
`PASS=55` (protocol), `PASS=71` (client), `PASS=16` (lilto compat), all
`FAIL=0`, exit 0. `npm run test:pack` is separate (`PASS=13`) because it builds
a tarball — see Distribution.

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

- **TypeScript in `daemon/`, `cli/`, `clients/`; plain JS in `extension/`.** Node
  ≥22.18 runs `.ts` directly (type stripping — no build/emit step), so use only
  erasable syntax: no `enum`/`namespace`/decorators/parameter-properties, and
  import with real `.ts` extensions. JSDoc stays where it helps editors. Keep
  runtime deps near-zero (`ws` only); typecheck/lint tooling is dev-only.
- **Protocol changes are a six-file edit:** bump `PROTOCOL_VERSION` in
  `daemon/config.ts`, `extension/background.js`, **and**
  `daemon/test-mock-ext.ts` (all must match, or the daemon closes with code
  `4000`), bump `cdpRelay.protocolVersion` in `package.json`, and bump the
  package + `extension/manifest.json` versions together (semver, independent of
  the wire number), then update `docs/SPEC.md`. `npm run version:check` catches
  five of the six. A daemon and extension on
  mismatched versions will not talk.
- **Keep `docs/SPEC.md` in sync** with any change to the WS messages, HTTP
  endpoints, error codes, or addressing. It is the contract other code is written
  against; drift is a real bug.
- **Two docs, two jobs — don't merge them and don't duplicate across them.**
  `docs/SPEC.md` is normative and present-tense: what the wire, the endpoints,
  and the error codes *are*, in English. `docs/cdp-relay-design.md` is the
  reasoning: why this shape, what was measured (with numbers), what was rejected,
  what is deliberately not built, in Chinese. They cover the same features on
  purpose; when they say different things, **SPEC wins and the design doc gets a
  dated revision note** rather than a silent rewrite — the superseded reasoning
  is the useful part.
- **LLM 推理与动作缓存是调用方的**（设计文档 §6.3 / §11）。daemon 提供快照、`/act`
  重放 + 三级回退，不内置 LLM、不内置 `key → Action[]` 缓存 KV——lilto 等调用方自己
  存、命中就重放、`needsInference` 时重新推理并写回。别把这两层拖回 daemon。
- Match the style of surrounding code (small functions, early returns, the existing
  comment density).

## Gotchas

- **`/send` requires the tab be attached first** — otherwise 409. Attach before eval.
- **The page `revision` only sees what is subscribed.** An unsubscribed dirtying
  event never reaches the daemon, so `nav` alone under-reports document swaps.
  Never present the revision as more precise than the subscription allows.
- **Subscriptions are not retroactive.** Subscribe before the traffic you want,
  not after. `cdp-relay net list` fails loudly when Network isn't subscribed
  rather than returning an empty list that reads like "no requests happened".
- **`Network.disable` drops the response-body buffer** — fetch bodies before
  narrowing a subscription away from Network.
- **`hello` must carry a non-empty `id` and the current `version`**, else the daemon closes
  `4000` and the extension stops reconnecting permanently.
- **One debugger per tab.** If the user opens DevTools on an attached tab, Chrome
  detaches us (`onDetach`).
- **`Target` has no `enable` method** (`-32601`). Its events come from
  `setAutoAttach`; `NO_ENABLE_DOMAINS` in the extension skips it so it lands in
  neither `enabled` nor `failed`. The mock rejects `Target.enable` for the same
  reason — without that, nothing holds the skip in place.
- **Cross-origin is not cross-site.** Site isolation is scheme + eTLD+1, so
  `a.example.com` inside `example.com` is same-process and never becomes an
  OOPIF. Don't test OOPIF handling against a subdomain iframe.
- **A tab attachment does not reach into out-of-process iframes.** Anything
  cross-site (payments, embedded logins, ad slots) needs
  `Target.setAutoAttach{flatten:true}` and a `sessionId` on the command. Key
  long-lived state on `targetId`, not `sessionId` — the latter changes on
  reattach.
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

Tags are releases: `v<version>`, matching `package.json`. Tag only when the
user asks — pushing a tag triggers `.github/workflows/release.yml`.

## Working with the user

- **Verify before claiming done and before committing:** `npm run check` green
  (version sync + typecheck + lint + unit tests + all suites + the packaging test). Edits can silently mis-apply
  on large files — re-read the region after editing to confirm it landed.
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
- **v5** `cdp` commands and events carry an optional `sessionId`, so a flat
  auto-attached out-of-process iframe can be addressed. Verified end to end on a
  real OOPIF — see SPEC's "Sessions" section. Same release adds the per-tab page
  `revision` (`GET /page`), the `dom` event preset, and `attach({sessions:true})`
  with a per-tab session pool (`GET /sessions`).
- **v6** the `snapshot` command + `POST/GET /snapshot`: the L2 page-model
  pipeline (design doc milestones C/D/E). The ext fetches the three trees per
  frame (`DOM.getDocument` + `Accessibility.getFullAXTree` +
  `DOMSnapshot.captureSnapshot`) and the daemon (`daemon/page-model.ts`) merges
  them into flat `NodeRecord`s — id/parent/tag/role/name/attrs/rect/vis/int/xp,
  plus `elementHash`/`parentBranchHash` (browser-use's `compute_stable_hash` /
  `parent_branch_hash`: sha256 of the tag path + static attrs + ax name, dynamic
  classes filtered) and sibling-index XPath, with OOPIF frames stitched under
  their iframe hosts (XPath prefixed, stagehand's `prefixXPath`) — then
  serializes them into `indexedText` + `selectorMap` (the `[12]<button …>` form
  an LLM reads, `*` marking new nodes). A per-tab snapshot cache is keyed to the
  page `revision`. Also adds the L3 action layer (`POST /act`, milestone F):
  `daemon/actions.ts` holds the closed eleven-element-action vocabulary; the
  executor (`ExtConn.act`) runs each action with the three-level fallback
  (xpath → elementHash re-locate → `needsInference`) and the batch guards
  (`terminatesSequence` + a page-`revision` re-check that keeps partial results).
  Not protocol, same release: the repo became a publishable package
  (`@wuwe1/cdp-relay`, first release 1.0.0, declaring protocol v6 in
  `cdpRelay.protocolVersion`) — see Distribution.

v3 and v4 were motivated by an audit against `browserbase/stagehand` and
`browser-use` (see `docs/cdp-relay-design.md`, which also carries the measured
numbers behind these choices; the reference checkouts live in
`~/Developer/browser_agent/`).

## Provenance

Ported from `listo` repo's `dev/cdp-relay/` (single-browser, protocol v1) and
rewritten for multi-browser (protocol v2). The original lives at
`~/Developer/listo/dev/cdp-relay/`. A separate copy of the daemon is embedded in
`listo-agent`'s Electron main (`src/main/cdp-relay-daemon.ts`) and is **not** yet
upgraded to v2 — out of scope unless explicitly asked.
