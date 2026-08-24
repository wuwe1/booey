// Mock ext: connects to the daemon and pretends to be the chrome.debugger bridge.
// Validates the daemon ↔ ext protocol (incl. multi-browser addressing and the v3
// message-id scheduling) without loading the real extension.
//
//   node server.mjs 9229                          # daemon
//   node test-mock-ext.mjs 9229 browser-A shopee-A # one mock browser
//   node test-mock-ext.mjs 9229 browser-B shopee-B # a second, concurrently
//
// Test-only CDP methods, used by test/integration.mjs to exercise paths a
// well-behaved browser never takes:
//   Test.sleep    { ms }  reply after a delay — for concurrency timing
//   Test.late     { ms }  reply after a delay the daemon will have given up on
//   Test.noReply          never reply
//   Test.detach           push `detached` for the tab, then never reply
// Every subscription change re-emits the fake event burst, so a test can advance
// the /events cursor without reattaching.
import WebSocket from "ws";

const PROTOCOL_VERSION = 5;
const PORT = Number(process.argv[2] || 9229);
const ID = process.argv[3] || `mock-${process.pid}`;
const LABEL = process.argv[4] || "";

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ext`);

const FAKE_TABS = [
  { tabId: 1001, url: "https://seller.shopee.tw/portal/product/list", title: `${LABEL || ID} 賣場` },
  { tabId: 1002, url: "chrome://newtab/", title: "New Tab" },
];

const attached = new Set();
let nextFakeTabId = 2001;
const FRESH_ONLY_TAB = { tabId: 1999, url: "mock://fresh-only", title: "only via list-tabs" };
/** tabId → {exact:Set, wild:Set, domains:Set} — mirrors the real ext's filter */
const subs = new Map();

function setSubscription(tabId, selectors) {
  const exact = new Set();
  const wild = new Set();
  const domains = new Set();
  for (const sel of selectors || []) {
    const dot = sel.indexOf(".");
    const domain = sel.slice(0, dot);
    domains.add(domain);
    if (sel.slice(dot + 1) === "*") wild.add(domain);
    else exact.add(sel);
  }
  subs.set(tabId, { exact, wild, domains });
  // A domain the real ext could not enable comes back as `failed`; "Bogus" is
  // the mock's stand-in for a typo'd domain name.
  const failed = [...domains].filter((d) => d === "Bogus").map((d) => ({ domain: d, message: `'${d}.enable' wasn't found` }));
  return { enabled: [...domains].filter((d) => d !== "Bogus").sort(), failed };
}

function subscribed(tabId, method) {
  const e = subs.get(tabId);
  if (!e) return false;
  if (e.exact.has(method)) return true;
  const dot = method.indexOf(".");
  return dot > 0 && e.wild.has(method.slice(0, dot));
}

ws.on("open", () => {
  log("connected, sending hello");
  send({ type: "hello", version: PROTOCOL_VERSION, id: ID, label: LABEL, tabs: FAKE_TABS });
});

function send(msg) {
  ws.send(JSON.stringify(msg));
}

// Emits the same three Network events plus one Page event, each only if the
// tab's subscription covers it — the filter is the ext's job, so the double
// must do it too or the test asserts nothing.
function pushFakeEvents(tabId) {
  setTimeout(() => {
    const emit = (method, params) => {
      if (subscribed(tabId, method)) send({ type: "event", tabId, method, params });
    };
    emit("Page.loadEventFired", { timestamp: Date.now() / 1000 });
    emit("Network.requestWillBeSent", {
      requestId: "REQ-001",
      request: { method: "GET", url: "https://seller.shopee.tw/api/v3/opt/mpsku/list/v2/get_product_extensive_info" },
      type: "XHR",
      timestamp: Date.now() / 1000,
    });
    emit("Network.responseReceived", {
      requestId: "REQ-001",
      response: { status: 200, statusText: "OK", mimeType: "application/json" },
    });
    emit("Network.loadingFinished", { requestId: "REQ-001", encodedDataLength: 4321 });
    // Never subscribed by any preset: proves the filter drops rather than that
    // the mock simply doesn't produce noise.
    emit("Network.dataReceived", { requestId: "REQ-001", dataLength: 512 });
    log(`pushed fake events for tab ${tabId}`);
  }, 200);
}

/** The answer this method would give, ignoring timing. */
function resultFor(m) {
  switch (m.method) {
    case "Runtime.evaluate":
      // An expression containing THROW comes back shaped like a real page
      // exception, so a client's exceptionDetails handling can be exercised.
      if (String(m.params?.expression || "").includes("THROW")) {
        return {
          result: { type: "object", subtype: "error" },
          exceptionDetails: { text: "Uncaught", exception: { description: "Error: mock page blew up" } },
        };
      }
      return { result: { type: "string", value: `${LABEL || ID} (mock)` } };
    case "Network.getResponseBody":
      return { body: '{"data":{"products":[]},"code":0}', base64Encoded: false };
    case "Page.captureScreenshot":
      return { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=" };
    default:
      return { mock: true, method: m.method };
  }
}

/** @returns {Promise<any>|any} the `result` payload, or null to answer nothing */
function runCdp(m) {
  if (m.method === "Test.noReply") return null;
  if (m.method === "Test.detach") {
    send({ type: "detached", tabId: m.tabId, reason: "canceled_by_user" });
    return null;
  }
  // `params.ms` delays ANY method without changing what it answers. That lets a
  // test put a real method (and its real classification as ordered/unordered) on
  // a stopwatch, instead of only ever timing a synthetic Test.* method.
  const ms = m.params?.ms;
  if (typeof ms === "number") {
    return new Promise((r) => setTimeout(() => r(resultFor(m)), ms));
  }
  return resultFor(m);
}

// Mirrors the real ext: no per-command serialization here. Whatever the daemon
// sends concurrently is handled concurrently, and every response quotes its id.
async function handleCommand(m) {
  switch (m.type) {
    case "list-tabs":
      // FRESH_ONLY_TAB is returned by an actual list-tabs round-trip but never
      // included in hello / tabs-changed pushes. That is what makes `fresh=0`
      // (read the pushed snapshot, don't ask the ext) distinguishable from a
      // plain /tabs — otherwise both return the same thing and a test asserting
      // "fresh=0 works" would pass with the feature deleted.
      return { tabs: [...FAKE_TABS, FRESH_ONLY_TAB] };
    case "open-tab": {
      // Actually add it, so a caller polling /tabs for the new tab converges.
      const tab = { tabId: nextFakeTabId++, url: m.url, title: `mock ${m.url}` };
      FAKE_TABS.push(tab);
      send({ type: "tabs-changed", tabs: FAKE_TABS });
      return { tab };
    }
    case "attach": {
      attached.add(m.tabId);
      const r = setSubscription(m.tabId, m.events);
      pushFakeEvents(m.tabId);
      return r;
    }
    case "events.set": {
      if (!attached.has(m.tabId)) throw new Error(`tab ${m.tabId} not attached`);
      const r = setSubscription(m.tabId, m.events);
      pushFakeEvents(m.tabId); // a fresh burst per subscription change, so tests can advance the cursor
      return r;
    }
    case "detach":
      attached.delete(m.tabId);
      subs.delete(m.tabId);
      return {};
    case "cdp":
      return await runCdp(m);
    default:
      throw new Error("unknown command type: " + m.type);
  }
}

ws.on("message", (data) => {
  let m;
  try { m = JSON.parse(data.toString("utf8")); } catch { return; }
  if (m.type === "ping") {
    send({ type: "pong", stats: { matchedEvents: 0, filteredEvents: 0, droppedEvents: 0 } });
    return;
  }
  log("←", JSON.stringify(m));
  if (typeof m.id !== "number") {
    log("command with no id, ignoring");
    return;
  }
  handleCommand(m).then(
    (result) => {
      if (result === null) return; // deliberately silent
      send({ id: m.id, ok: true, result });
    },
    (e) => send({ id: m.id, ok: false, error: { message: String(e?.message || e) } }),
  );
});

ws.on("close", (code, reason) => {
  log(`closed code=${code} reason=${reason || "(none)"}`);
  process.exit(0);
});
ws.on("error", (e) => log("error:", e.message));

function log(...args) {
  console.error(`[mock-ext ${LABEL || ID}]`, ...args);
}
