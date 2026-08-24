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
//   Test.dirty    {method}  emit one dirtying event (default Page.loadEventFired)
//   Test.detachSession      emit Target.detachedFromTarget for the fake OOPIF
//   Test.sessionEcho        echo back whichever sessionId the command carried
// Target.setAutoAttach announces one fake OOPIF, like a real browser would;
// Target.enable is rejected, because the real browser has no such method.
//   Test.noReply          never reply
//   Test.detach           push `detached` for the tab, then never reply
// Every subscription change re-emits the fake event burst, so a test can advance
// the /events cursor without reattaching.
import WebSocket from "ws";

const PROTOCOL_VERSION = 6;
const PORT = Number(process.argv[2] || 9229);
const ID = process.argv[3] || `mock-${process.pid}`;
const LABEL = process.argv[4] || "";

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ext`);

const FAKE_TABS = [
  {
    tabId: 1001,
    url: "https://seller.shopee.tw/portal/product/list",
    title: `${LABEL || ID} 賣場`,
  },
  { tabId: 1002, url: "chrome://newtab/", title: "New Tab" },
];

const attached = new Set();
let nextFakeTabId = 2001;
const FRESH_ONLY_TAB = { tabId: 1999, url: "mock://fresh-only", title: "only via list-tabs" };
/** tabId → {exact:Set, wild:Set, domains:Set} — mirrors the real ext's filter */
const subs = new Map();

function setSubscription(
  tabId: number,
  selectors: string[],
): { enabled: string[]; failed: { domain: string; message: string }[] } {
  const exact = new Set<string>();
  const wild = new Set<string>();
  const domains = new Set<string>();
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
  const failed = [...domains]
    .filter((d) => d === "Bogus")
    .map((d) => ({ domain: d, message: `'${d}.enable' wasn't found` }));
  // Target is skipped rather than enabled, mirroring NO_ENABLE_DOMAINS in the
  // extension: it must appear in NEITHER list.
  const enabled = [...domains].filter((d) => d !== "Bogus" && d !== "Target").sort();
  return { enabled, failed };
}

function subscribed(tabId: number, method: string): boolean {
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

function send(msg: any): void {
  ws.send(JSON.stringify(msg));
}

// Emits the same three Network events plus one Page event, each only if the
// tab's subscription covers it — the filter is the ext's job, so the double
// must do it too or the test asserts nothing.
function pushFakeEvents(tabId: number): void {
  setTimeout(() => {
    const emit = (method: string, params: any) => {
      if (subscribed(tabId, method)) send({ type: "event", tabId, method, params });
    };
    emit("Page.loadEventFired", { timestamp: Date.now() / 1000 });
    emit("Network.requestWillBeSent", {
      requestId: "REQ-001",
      request: {
        method: "GET",
        url: "https://seller.shopee.tw/api/v3/opt/mpsku/list/v2/get_product_extensive_info",
      },
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
function resultFor(m: any): any {
  switch (m.method) {
    case "Runtime.evaluate": {
      const expr = String(m.params?.expression || "");
      // An expression containing THROW comes back shaped like a real page
      // exception, so a client's exceptionDetails handling can be exercised.
      if (expr.includes("THROW")) {
        return {
          result: { type: "object", subtype: "error" },
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "Error: mock page blew up" },
          },
        };
      }
      // Action 执行器发来的表达式：locate 返回坐标，其它（fill/scroll/select）返回 true。
      // xpath 含 "STALE" 时返回 null，模拟「页面改版、xpath 失效」，触发三级回退。
      if (expr.includes("getBoundingClientRect")) {
        if (expr.includes("STALE")) return { result: { type: "object", value: null } };
        return { result: { type: "object", value: { x: 10, y: 10 } } };
      }
      if (expr.includes("document.evaluate")) {
        return { result: { type: "boolean", value: true } };
      }
      return { result: { type: "string", value: `${LABEL || ID} (mock)` } };
    }
    case "Network.getResponseBody":
      return { body: '{"data":{"products":[]},"code":0}', base64Encoded: false };
    case "Page.captureScreenshot":
      return {
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
      };
    default:
      return { mock: true, method: m.method };
  }
}

/** @returns {Promise<any>|any} the `result` payload, or null to answer nothing */
function runCdp(m: any): any {
  if (m.method === "Test.noReply") return null;
  // Chrome has no Target.enable — Target events come from setAutoAttach. The
  // real browser answers -32601, so the double must too, or the extension's
  // NO_ENABLE_DOMAINS skip has nothing holding it in place.
  if (m.method === "Target.enable")
    throw new Error(`{"code":-32601,"message":"'Target.enable' wasn't found"}`);
  if (m.method === "Target.setAutoAttach") {
    // Announce one fake OOPIF, the way a real browser would on auto-attach.
    if (subscribed(m.tabId, "Target.attachedToTarget")) {
      send({
        type: "event",
        tabId: m.tabId,
        method: "Target.attachedToTarget",
        params: {
          sessionId: `SESS-${m.tabId}-1`,
          targetInfo: { targetId: `TGT-${m.tabId}-1`, type: "iframe", url: "https://example.com/" },
        },
      });
    }
    return {};
  }
  if (m.method === "Test.detachSession") {
    if (subscribed(m.tabId, "Target.detachedFromTarget")) {
      send({
        type: "event",
        tabId: m.tabId,
        method: "Target.detachedFromTarget",
        params: { sessionId: `SESS-${m.tabId}-1`, targetId: `TGT-${m.tabId}-1` },
      });
    }
    return {};
  }
  if (m.method === "Test.sessionEcho") {
    // Answers differently depending on whether a sessionId came along, so a test
    // can prove the field actually reached the far end.
    return { sawSessionId: m.sessionId ?? null };
  }
  if (m.method === "Test.dirty") {
    // Emit a dirtying event, subject to the tab's subscription like any other.
    const method = m.params?.method || "Page.loadEventFired";
    if (subscribed(m.tabId, method)) send({ type: "event", tabId: m.tabId, method, params: {} });
    return { emitted: method };
  }
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
async function handleCommand(m: any): Promise<any> {
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
    case "snapshot": {
      // 主 frame：button + iframe 宿主（src 指向子 frame url）；带 sessionId 的子 frame：
      // 一个 input。这样 daemon 的 stitchFrames 能把子 frame 根挂到 iframe 下、XPath 加前缀。
      const frames = (Array.isArray(m.frames) ? m.frames : [{ frameOrdinal: 0 }]).map((f: any) => {
        if (f.sessionId) {
          return {
            frameOrdinal: f.frameOrdinal,
            url: "https://example.com/",
            dom: {
              nodeType: 9,
              nodeName: "#document",
              backendNodeId: 1,
              children: [
                {
                  nodeType: 1,
                  nodeName: "html",
                  localName: "html",
                  backendNodeId: 2,
                  children: [
                    {
                      nodeType: 1,
                      nodeName: "body",
                      localName: "body",
                      backendNodeId: 3,
                      children: [
                        {
                          nodeType: 1,
                          nodeName: "input",
                          localName: "input",
                          backendNodeId: 4,
                          attributes: ["type", "text", "placeholder", "iframe 里的输入"],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            ax: {
              nodes: [
                {
                  backendDOMNodeId: 4,
                  role: { value: "textbox" },
                  name: { value: "子 frame 输入" },
                  ignored: false,
                },
              ],
            },
            snapshot: {
              documents: [
                {
                  nodes: { backendNodeId: [4] },
                  layout: { nodeIndex: [0], bounds: [[10, 10, 200, 30]] },
                },
              ],
            },
          };
        }
        return {
          frameOrdinal: f.frameOrdinal,
          url: "https://seller.shopee.tw/portal/product/list",
          dom: {
            nodeType: 9,
            nodeName: "#document",
            backendNodeId: 1,
            children: [
              {
                nodeType: 1,
                nodeName: "html",
                localName: "html",
                backendNodeId: 2,
                children: [
                  {
                    nodeType: 1,
                    nodeName: "body",
                    localName: "body",
                    backendNodeId: 3,
                    children: [
                      {
                        nodeType: 1,
                        nodeName: "button",
                        localName: "button",
                        backendNodeId: 4,
                        attributes: ["id", "add-cart", "type", "submit", "class", "btn primary"],
                      },
                      {
                        nodeType: 1,
                        nodeName: "iframe",
                        localName: "iframe",
                        backendNodeId: 5,
                        attributes: ["src", "https://example.com/"],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          ax: {
            nodes: [
              {
                backendDOMNodeId: 4,
                role: { value: "button" },
                name: { value: "加入购物车" },
                ignored: false,
              },
            ],
          },
          snapshot: {
            documents: [
              {
                nodes: { backendNodeId: [4] },
                layout: { nodeIndex: [0], bounds: [[120, 480, 96, 36]] },
              },
            ],
          },
        };
      });
      return { frames };
    }
    default:
      throw new Error("unknown command type: " + m.type);
  }
}

ws.on("message", (data) => {
  let m: any;
  try {
    m = JSON.parse(data.toString("utf8"));
  } catch {
    return;
  }
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

function log(...args: any[]): void {
  console.error(`[mock-ext ${LABEL || ID}]`, ...args);
}
