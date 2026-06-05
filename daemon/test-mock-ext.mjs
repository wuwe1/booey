// Mock ext: connects to the daemon and pretends to be the chrome.debugger bridge.
// Validates the daemon ↔ ext protocol (incl. multi-browser addressing) without
// loading the real extension.
//
//   node server.mjs 9229                          # daemon
//   node test-mock-ext.mjs 9229 browser-A shopee-A # one mock browser
//   node test-mock-ext.mjs 9229 browser-B shopee-B # a second, concurrently
import WebSocket from "ws";

const PROTOCOL_VERSION = 2;
const PORT = Number(process.argv[2] || 9229);
const ID = process.argv[3] || `mock-${process.pid}`;
const LABEL = process.argv[4] || "";

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ext`);

const FAKE_TABS = [
  { tabId: 1001, url: "https://seller.shopee.tw/portal/product/list", title: `${LABEL || ID} 賣場` },
  { tabId: 1002, url: "chrome://newtab/", title: "New Tab" },
];

const attached = new Set();

ws.on("open", () => {
  log("connected, sending hello");
  ws.send(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION, id: ID, label: LABEL, tabs: FAKE_TABS }));
});

function pushFakeEvents(tabId) {
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: "event",
      tabId,
      method: "Network.requestWillBeSent",
      params: {
        requestId: "REQ-001",
        request: { method: "GET", url: "https://seller.shopee.tw/api/v3/opt/mpsku/list/v2/get_product_extensive_info" },
        type: "XHR",
        timestamp: Date.now() / 1000,
      },
    }));
    ws.send(JSON.stringify({
      type: "event",
      tabId,
      method: "Network.responseReceived",
      params: {
        requestId: "REQ-001",
        response: { status: 200, statusText: "OK", mimeType: "application/json" },
      },
    }));
    ws.send(JSON.stringify({
      type: "event",
      tabId,
      method: "Network.loadingFinished",
      params: { requestId: "REQ-001", encodedDataLength: 4321 },
    }));
    log(`pushed 3 fake events for tab ${tabId}`);
  }, 200);
}

ws.on("message", (data) => {
  let m;
  try { m = JSON.parse(data.toString("utf8")); } catch { return; }
  if (m.type !== "ping") log("←", JSON.stringify(m));
  switch (m.type) {
    case "ping":
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    case "list-tabs":
      ws.send(JSON.stringify({ ok: true, result: { tabs: FAKE_TABS } }));
      return;
    case "attach":
      attached.add(m.tabId);
      ws.send(JSON.stringify({ ok: true, result: {} }));
      pushFakeEvents(m.tabId);
      return;
    case "detach":
      attached.delete(m.tabId);
      ws.send(JSON.stringify({ ok: true, result: {} }));
      return;
    case "cdp":
      if (m.method === "Runtime.evaluate") {
        ws.send(JSON.stringify({
          ok: true,
          result: { result: { type: "string", value: `${LABEL || ID} (mock)` } },
        }));
        return;
      }
      if (m.method === "Network.getResponseBody") {
        ws.send(JSON.stringify({
          ok: true,
          result: { body: '{"data":{"products":[]},"code":0}', base64Encoded: false },
        }));
        return;
      }
      if (m.method === "Page.captureScreenshot") {
        ws.send(JSON.stringify({
          ok: true,
          result: { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=" },
        }));
        return;
      }
      ws.send(JSON.stringify({ ok: true, result: { mock: true, method: m.method } }));
      return;
    default:
      log("mock-ext: unknown daemon msg", m);
  }
});

ws.on("close", (code, reason) => {
  log(`closed code=${code} reason=${reason || "(none)"}`);
  process.exit(0);
});
ws.on("error", (e) => log("error:", e.message));

function log(...args) {
  console.error(`[mock-ext ${LABEL || ID}]`, ...args);
}
