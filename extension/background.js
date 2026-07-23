// cdp-relay extension background — see ../docs/SPEC.md for protocol.
//
// Two consumers:
//   1. daemon (WS at ws://127.0.0.1:<port>/ext) — primary, agent flow
//   2. popup (chrome.runtime.onMessage) — fallback when daemon is dead
//
// chrome.debugger state is single source of truth; either consumer can attach.
// Events from chrome.debugger.onEvent fan out to both: local buffer (for popup)
// and WS push (for daemon).
//
// IDENTITY (multi-browser): this build is installed unchanged in every browser.
// Each profile mints a persistent random id in chrome.storage.local on first run;
// since storage is per-profile, two browsers running the same build get distinct
// ids automatically. The id (+ optional user label) is sent in hello, letting one
// daemon address multiple browsers. Do NOT bake an id into the build — the
// extension build id is identical across browsers and can't tell them apart.

const PROTOCOL_VERSION = 2;
const DEFAULT_PORT = 9224; // must match daemon/config.mjs; 9223 is the legacy v1 relay
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
const LOCAL_EVENT_CAP = 500;
const LOCAL_REQUEST_CAP = 500;

// MV3 SW lifecycle: SW dies after ~30s idle. setTimeout/setInterval don't survive
// SW death. chrome.alarms DO — they re-fire on schedule and resurrect dead SW.
// We use alarms for keep-alive (every 24s wake → check WS → reconnect if dead).
const KEEPALIVE_ALARM = "cdp-relay-keepalive";
const KEEPALIVE_PERIOD_MIN = 0.4; // 24s — under SW 30s idle threshold

// ---- identity (persistent, per-profile) ----
let identity = null; // { id, label }

async function ensureIdentity() {
  if (identity) return identity;
  const got = await chrome.storage.local.get(["cdpRelayId", "cdpRelayLabel"]);
  let id = got.cdpRelayId;
  if (!id) {
    id = crypto.randomUUID();
    await chrome.storage.local.set({ cdpRelayId: id });
    log("minted new browser id", id);
  }
  identity = { id, label: got.cdpRelayLabel || "" };
  return identity;
}

async function setLabel(label) {
  await ensureIdentity();
  identity.label = String(label || "");
  await chrome.storage.local.set({ cdpRelayLabel: identity.label });
  // Re-hello so the daemon picks up the new label immediately (same id → no kick).
  sendHelloToDaemon();
}

// ---- state ----
const attachedTabs = new Set();        // tabId
const localEvents = [];                // raw CDP events for popup
const localRequests = new Map();       // requestId -> {…} for popup

// ---- daemon WS client ----
let ws = null;
let wsReconnectAttempt = 0;
let wsReconnectTimer = null;
let stoppedReconnecting = false;       // version mismatch → permanent stop

function daemonPort() {
  return DEFAULT_PORT;
}

function connectDaemon() {
  if (stoppedReconnecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const port = daemonPort();
  const url = `ws://127.0.0.1:${port}/ext`;
  log(`connecting to daemon ${url}`);
  try {
    ws = new WebSocket(url);
  } catch (e) {
    log("ws ctor threw:", e.message);
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    wsReconnectAttempt = 0;
    log("ws open, sending hello");
    sendHelloToDaemon();
  };
  ws.onmessage = (ev) => handleDaemonMessage(ev.data);
  ws.onerror = (e) => log("ws error", e?.message || "(no message)");
  ws.onclose = (ev) => {
    log(`ws close code=${ev.code} reason=${ev.reason || "(none)"}`);
    if (ev.code === 4000) {
      log("version mismatch, not reconnecting");
      stoppedReconnecting = true;
      return;
    }
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (wsReconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** wsReconnectAttempt, RECONNECT_MAX_MS);
  wsReconnectAttempt++;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectDaemon();
  }, delay);
}

// chrome.alarms keep-alive: fires every ~24s even after SW death, resurrecting
// SW + retrying connect. SPEC's heartbeat (daemon→ext ping) keeps SW alive during
// normal operation; alarms cover the SW-already-dead case.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (stoppedReconnecting) return;
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    log("alarm tick: ws not open, attempting reconnect");
    connectDaemon();
  }
});

function sendToDaemon(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch (e) {
    log("ws send failed:", e.message);
    return false;
  }
}

async function sendHelloToDaemon() {
  const { id, label } = await ensureIdentity();
  const tabs = await listTabsForDaemon();
  sendToDaemon({ type: "hello", version: PROTOCOL_VERSION, id, label, tabs });
}

async function listTabsForDaemon() {
  const tabs = await new Promise((r) => chrome.tabs.query({}, r));
  return tabs.map((t) => ({ tabId: t.id, url: t.url || "", title: t.title || "" }));
}

function pushTabsChanged() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  listTabsForDaemon().then((tabs) => sendToDaemon({ type: "tabs-changed", tabs }));
}

// ---- daemon → ext command dispatch ----

async function handleDaemonMessage(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  switch (m.type) {
    case "ping":
      sendToDaemon({ type: "pong" });
      return;
    case "list-tabs": {
      const tabs = await listTabsForDaemon();
      sendToDaemon({ ok: true, result: { tabs } });
      return;
    }
    case "attach":
      try {
        await attach(m.tabId);
        sendToDaemon({ ok: true, result: {} });
      } catch (e) {
        sendToDaemon({ ok: false, error: { message: String(e) } });
      }
      return;
    case "detach":
      try {
        await detach(m.tabId);
        sendToDaemon({ ok: true, result: {} });
      } catch (e) {
        sendToDaemon({ ok: false, error: { message: String(e) } });
      }
      return;
    case "cdp":
      try {
        const result = await sendCdp(m.tabId, m.method, m.params || {});
        sendToDaemon({ ok: true, result });
      } catch (e) {
        sendToDaemon({ ok: false, error: { message: String(e) } });
      }
      return;
    default:
      log("daemon sent unknown type:", m.type);
  }
}

// ---- chrome.debugger plumbing ----

function attach(tabId) {
  return new Promise((resolve, reject) => {
    if (attachedTabs.has(tabId)) return resolve();
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || "";
        if (msg.includes("already attached")) {
          attachedTabs.add(tabId);
          return resolve();
        }
        return reject(msg);
      }
      attachedTabs.add(tabId);
      Promise.all([
        sendCdp(tabId, "Network.enable", {}),
        sendCdp(tabId, "Runtime.enable", {}),
        sendCdp(tabId, "Page.enable", {}),
      ]).then(() => resolve()).catch(reject);
    });
  });
}

function detach(tabId) {
  return new Promise((resolve) => {
    if (!attachedTabs.has(tabId)) return resolve();
    chrome.debugger.detach({ tabId }, () => {
      attachedTabs.delete(tabId);
      resolve();
    });
  });
}

function sendCdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError.message);
      resolve(result);
    });
  });
}

// ---- event fanout ----

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  sendToDaemon({ type: "event", tabId, method, params });

  localEvents.push({ ts: Date.now(), tabId, method, params });
  if (localEvents.length > LOCAL_EVENT_CAP) localEvents.shift();

  if (method === "Network.requestWillBeSent") {
    const r = {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      headers: params.request.headers,
      postData: params.request.postData,
      type: params.type,
      ts: params.timestamp,
      status: null,
      mimeType: null,
      responseHeaders: null,
      tabId,
    };
    localRequests.set(params.requestId, r);
    if (localRequests.size > LOCAL_REQUEST_CAP) {
      const oldest = localRequests.keys().next().value;
      localRequests.delete(oldest);
    }
  } else if (method === "Network.responseReceived") {
    const r = localRequests.get(params.requestId);
    if (r) {
      r.status = params.response.status;
      r.mimeType = params.response.mimeType;
      r.responseHeaders = params.response.headers;
    }
  } else if (method === "Network.loadingFailed") {
    const r = localRequests.get(params.requestId);
    if (r) r.failed = params.errorText;
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  attachedTabs.delete(tabId);
  log(`debugger detached from tab ${tabId}: ${reason}`);
  sendToDaemon({ type: "detached", tabId, reason: String(reason) });
});

// ---- tabs lifecycle → tabs-changed ----

chrome.tabs.onCreated.addListener(pushTabsChanged);
chrome.tabs.onRemoved.addListener(pushTabsChanged);
chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
  if (changeInfo.url || changeInfo.title) pushTabsChanged();
});

// ---- popup message API (fallback) ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "get-identity": {
          const { id, label } = await ensureIdentity();
          sendResponse({ id, label });
          break;
        }
        case "set-label":
          await setLabel(msg.label);
          sendResponse({ ok: true });
          break;
        case "daemon-status":
          sendResponse({
            wsState: ws ? ws.readyState : -1,
            wsConnected: !!(ws && ws.readyState === WebSocket.OPEN),
            port: daemonPort(),
            stoppedReconnecting,
          });
          break;
        case "list-tabs":
          sendResponse({ tabs: await listTabsForDaemon() });
          break;
        case "attach":
          await attach(msg.tabId);
          sendResponse({ ok: true });
          break;
        case "detach":
          await detach(msg.tabId);
          sendResponse({ ok: true });
          break;
        case "send":
          sendResponse({ ok: true, result: await sendCdp(msg.tabId, msg.method, msg.params) });
          break;
        case "list-requests":
          sendResponse({ requests: [...localRequests.values()] });
          break;
        case "get-body":
          sendResponse({
            ok: true,
            result: await sendCdp(msg.tabId, "Network.getResponseBody", { requestId: msg.requestId }),
          });
          break;
        case "clear":
          localRequests.clear();
          localEvents.length = 0;
          sendResponse({ ok: true });
          break;
        case "status":
          sendResponse({
            attached: [...attachedTabs],
            requestCount: localRequests.size,
            eventCount: localEvents.length,
          });
          break;
        case "reconnect-daemon":
          stoppedReconnecting = false;
          wsReconnectAttempt = 0;
          if (ws) try { ws.close(); } catch {}
          connectDaemon();
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ error: "unknown message type: " + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // async response
});

// ---- bootstrap ----

function log(...args) {
  console.log("[cdp-relay]", ...args);
}

connectDaemon();
log("background loaded, protocol version", PROTOCOL_VERSION);
