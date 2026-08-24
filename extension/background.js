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

const PROTOCOL_VERSION = 5;
const DEFAULT_PORT = 9224; // must match daemon/config.mjs; 9223 is the legacy v1 relay
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
const LOCAL_REQUEST_CAP = 500;
// What the popup needs to draw its request list. The popup is an independent
// consumer living in this process, so it is unioned with the daemon's set rather
// than fighting over it.
const POPUP_EVENTS = [
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFailed",
];
const TABS_CHANGED_DEBOUNCE_MS = 150;
const WS_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024; // above this, shed events (never responses)

// MV3 SW lifecycle: the SW dies after ~30s idle, and setTimeout/setInterval do
// not survive that. Three overlapping mechanisms, weakest last:
//
//   1. offscreen heartbeat — an offscreen document holds a runtime Port and
//      posts on it every second. Port traffic resets the idle timer, so the SW
//      never starts the countdown. This is prevention.
//   2. daemon → ext ping every 25s — same effect while a daemon is connected.
//   3. chrome.alarms — resurrection, not prevention: it wakes a SW that already
//      died so it can reconnect. NOTE Chrome clamps alarm periods to a 30s
//      minimum, so asking for less does not get you less; the old 0.4min/"24s"
//      comment here was wrong. Recovery latency is therefore up to ~30s, which
//      is precisely why (1) exists.
const KEEPALIVE_ALARM = "cdp-relay-keepalive";
const KEEPALIVE_PERIOD_MIN = 0.5; // 30s — Chrome's floor; asking for less is ignored
// Domains that deliver events without an enable call. Target is the one that
// matters here: `Target.enable` does not exist in CDP (-32601), and its events
// flow from Target.setAutoAttach instead. Without this, every sessions:true
// attach reports a failed domain — and `failed` is supposed to mean "you typo'd
// a domain name", so a permanent entry there trains callers to ignore it.
const NO_ENABLE_DOMAINS = new Set(["Target"]);
const HEARTBEAT_PORT = "cdp-relay-heartbeat";
const HEARTBEAT_DOC = "offscreen-heartbeat.html";

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
const localRequests = new Map();       // requestId -> {…} for popup
let droppedEvents = 0;                 // events shed under WS backpressure
let matchedEvents = 0;                 // events that passed the subscription filter
let filteredEvents = 0;                // events dropped by the filter (the whole point)

// ---- event subscriptions ----
//
// Per tab: the daemon's desired selectors, the popup's, and the compiled union.
// Filtering happens in onEvent BEFORE any stringify, send, or store — an event
// nobody subscribed to must cost nothing beyond the listener call itself.
/** @type {Map<number, {daemon:string[], popup:string[], exact:Set<string>, wild:Set<string>, domains:Set<string>}>} */
const subs = new Map();
/** @type {Map<number, Set<string>>} tabId → CDP domains currently enabled on it */
const enabledDomains = new Map();

function subFor(tabId) {
  let e = subs.get(tabId);
  if (!e) {
    e = { daemon: [], popup: [], exact: new Set(), wild: new Set(), domains: new Set() };
    subs.set(tabId, e);
  }
  return e;
}

function compile(entry) {
  const exact = new Set();
  const wild = new Set();
  const domains = new Set();
  for (const sel of [...entry.daemon, ...entry.popup]) {
    const dot = sel.indexOf(".");
    const domain = sel.slice(0, dot);
    domains.add(domain);
    if (sel.slice(dot + 1) === "*") wild.add(domain);
    else exact.add(sel);
  }
  entry.exact = exact;
  entry.wild = wild;
  entry.domains = domains;
}

function matches(entry, method) {
  if (entry.exact.has(method)) return true;
  const dot = method.indexOf(".");
  return dot > 0 && entry.wild.has(method.slice(0, dot));
}

/**
 * Bring a tab's enabled CDP domains in line with its subscription. Declarative:
 * we diff the desired set against what is on and emit only the difference, so
 * calling this repeatedly is free and a re-push after reconnect self-heals.
 *
 * Returns which domains failed to enable — that is how a typo'd domain
 * ("Netwrok.*", shaped correctly so the daemon cannot reject it) surfaces as an
 * error instead of as a subscription that silently matches nothing.
 */
async function reconcile(tabId) {
  const entry = subFor(tabId);
  const want = new Set(entry.domains);
  const have = enabledDomains.get(tabId) ?? new Set();
  const failed = [];

  for (const domain of want) {
    if (have.has(domain) || NO_ENABLE_DOMAINS.has(domain)) continue;
    try {
      await sendCdp(tabId, `${domain}.enable`, {});
      have.add(domain);
    } catch (e) {
      failed.push({ domain, message: String(e?.message || e) });
    }
  }
  for (const domain of [...have]) {
    if (want.has(domain)) continue;
    try {
      await sendCdp(tabId, `${domain}.disable`, {});
    } catch {
      // A domain that refuses to disable is not worth failing the call over;
      // the filter still stops its events at the wire.
    }
    have.delete(domain);
  }
  enabledDomains.set(tabId, have);
  return { enabled: [...have].sort(), failed };
}


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

// chrome.alarms keep-alive: fires on schedule even after SW death, resurrecting
// the SW so it can reconnect. Covers the case where both the offscreen heartbeat
// and the daemon ping are gone (daemon down, offscreen creation failed).
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

// Events are lossy by nature (the daemon caches them in a bounded ring anyway),
// so when the socket backs up they are the right thing to shed. Command
// responses never go through here — dropping one would hang a caller.
function pushEventToDaemon(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > WS_BUFFER_LIMIT_BYTES) {
    droppedEvents++;
    if (droppedEvents % 500 === 1) {
      log(`ws backpressure (${ws.bufferedAmount} buffered), dropped ${droppedEvents} events so far`);
    }
    return;
  }
  sendToDaemon(msg);
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

// Coalesced: chrome.tabs.onUpdated fires on every title change, and each push
// costs a full chrome.tabs.query({}) plus a serialization of every tab. One page
// animating its title used to mean a continuous stream of full tab lists.
let tabsChangedTimer = null;
function pushTabsChanged() {
  if (tabsChangedTimer) return;
  tabsChangedTimer = setTimeout(() => {
    tabsChangedTimer = null;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    listTabsForDaemon().then((tabs) => sendToDaemon({ type: "tabs-changed", tabs }));
  }, TABS_CHANGED_DEBOUNCE_MS);
}

// ---- daemon → ext command dispatch ----

// v3: every command carries `id` and its response quotes it. Nothing here awaits
// anything else, so commands the daemon sends concurrently run concurrently —
// chrome.debugger.sendCommand is callback-based and takes as many in flight as
// we give it. Ordering, where it matters, is the daemon's job (see ExtConn lanes).
async function handleDaemonMessage(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.type === "ping") {
    // Counters ride the existing 25s heartbeat: the filter's whole value is the
    // ratio between these two, and it costs nothing to carry them here.
    sendToDaemon({ type: "pong", stats: { matchedEvents, filteredEvents, droppedEvents } });
    return;
  }
  if (typeof m.id !== "number") {
    log("daemon sent a command with no id, ignoring:", m.type);
    return;
  }
  try {
    sendToDaemon({ id: m.id, ok: true, result: await runCommand(m) });
  } catch (e) {
    sendToDaemon({ id: m.id, ok: false, error: { message: String(e?.message || e) } });
  }
}

async function runCommand(m) {
  switch (m.type) {
    case "list-tabs":
      return { tabs: await listTabsForDaemon() };
    case "open-tab": {
      // active:false is the point. Chrome activates and foregrounds any tab
      // opened via a page's window.open (it counts as a user gesture), which
      // interrupts whoever is actually using the browser. chrome.tabs.create is
      // an extension API: no debugger attachment needed, and no focus stolen.
      const t = await chrome.tabs.create({ url: m.url, active: false });
      return { tab: { tabId: t.id, url: t.url || "", title: t.title || "" } };
    }
    case "attach": {
      await attach(m.tabId);
      const entry = subFor(m.tabId);
      entry.daemon = Array.isArray(m.events) ? m.events : [];
      compile(entry);
      return await reconcile(m.tabId);
    }
    case "events.set": {
      if (!attachedTabs.has(m.tabId)) throw new Error(`tab ${m.tabId} not attached`);
      const entry = subFor(m.tabId);
      entry.daemon = Array.isArray(m.events) ? m.events : [];
      compile(entry);
      return await reconcile(m.tabId);
    }
    case "detach":
      await detach(m.tabId);
      return {};
    case "cdp":
      return await sendCdp(m.tabId, m.method, m.params || {}, m.sessionId);
    default:
      throw new Error("unknown command type: " + m.type);
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
      resolve();
    });
  });
}

function detach(tabId) {
  return new Promise((resolve) => {
    if (!attachedTabs.has(tabId)) return resolve();
    chrome.debugger.detach({ tabId }, () => {
      attachedTabs.delete(tabId);
      subs.delete(tabId);
      enabledDomains.delete(tabId);
      resolve();
    });
  });
}

// The first argument is a DebuggerSession, not just a Debuggee: since Chrome 125
// it takes an optional `sessionId` alongside the tabId. That is what lets us
// reach out-of-process iframes — after Target.setAutoAttach{flatten:true}, each
// OOPIF gets its own session, and a command addressed to the tab alone never
// reaches inside it.
function sendCdp(tabId, method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const target = sessionId ? { tabId, sessionId } : { tabId };
    chrome.debugger.sendCommand(target, method, params || {}, (result) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError.message);
      resolve(result);
    });
  });
}

// ---- event fanout ----

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  // Present when the event came from a flat auto-attached session (an OOPIF or
  // worker) rather than from the tab's own session.
  const sessionId = source.sessionId;
  const entry = subs.get(tabId);
  // Nothing subscribed to this: drop it here, before stringify, send, or store.
  // A domain stays enabled only while something wants it, but Chrome can still
  // deliver events for a domain mid-disable, and enable is per-domain while
  // subscriptions are per-method — so this filter is not redundant with it.
  if (!entry || !matches(entry, method)) {
    filteredEvents++;
    return;
  }
  matchedEvents++;
  if (entry.daemon.length > 0) {
    pushEventToDaemon({ type: "event", tabId, method, params, ...(sessionId ? { sessionId } : {}) });
  }
  if (entry.popup.length === 0) return;

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
        case "attach": {
          // The popup is its own subscriber: attaching from the popup turns on
          // exactly what the popup's request list needs, and detaching or
          // closing the popup is not required to give it back — the daemon's
          // subscription is unaffected either way.
          await attach(msg.tabId);
          const entry = subFor(msg.tabId);
          entry.popup = POPUP_EVENTS;
          compile(entry);
          sendResponse({ ok: true, ...(await reconcile(msg.tabId)) });
          break;
        }
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
          sendResponse({ ok: true });
          break;
        case "status":
          sendResponse({
            attached: [...attachedTabs],
            requestCount: localRequests.size,
            matchedEvents,
            filteredEvents,
            droppedEvents,
            subscriptions: [...subs].map(([tabId, e]) => ({
              tabId,
              daemon: e.daemon,
              popup: e.popup,
              domains: [...e.domains],
            })),
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

// ---- offscreen heartbeat (SW keep-alive) ----
//
// The offscreen document opens a Port and posts on it once a second. Receiving
// the message is itself the wake signal — the SW never has to do anything with
// it. Prevention beats the alarm's resurrection: a dead SW is a service gap of
// up to Chrome's 30s alarm floor, and reconnect on top of that.

let heartbeatPort = null;
let creatingHeartbeatDoc = null;

async function ensureHeartbeatDocument() {
  // chrome.offscreen is Chrome 109+, chrome.runtime.getContexts 116+. Below
  // either, fall back to the alarm + daemon ping and say so once.
  if (!chrome.offscreen || !chrome.runtime.getContexts) {
    log("offscreen API unavailable; SW keep-alive falls back to alarms + daemon ping");
    return;
  }
  try {
    const url = chrome.runtime.getURL(HEARTBEAT_DOC);
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    if (existing.length > 0) return;
    creatingHeartbeatDoc ??= chrome.offscreen
      .createDocument({
        url: HEARTBEAT_DOC,
        reasons: ["BLOBS"],
        justification: "Keep the service worker alive for long-running debugger sessions.",
      })
      .finally(() => {
        creatingHeartbeatDoc = null;
      });
    await creatingHeartbeatDoc;
  } catch (e) {
    // Racing with another creation attempt is fine; anything else is worth seeing.
    // Never throw: this runs unawaited at bootstrap and a rejection here would be
    // an unhandled rejection in the SW, not a failure anyone can act on.
    const msg = String(e?.message || e);
    if (!msg.includes("Only a single offscreen document")) {
      log("offscreen heartbeat unavailable:", msg);
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== HEARTBEAT_PORT) return;
  heartbeatPort = port;
  port.onMessage.addListener(() => {
    // Arrival is the wake signal; there is nothing to read.
  });
  port.onDisconnect.addListener(() => {
    if (heartbeatPort === port) heartbeatPort = null;
  });
});

chrome.runtime.onStartup.addListener(() => void ensureHeartbeatDocument());

// ---- bootstrap ----

function log(...args) {
  console.log("[cdp-relay]", ...args);
}

void ensureHeartbeatDocument();
connectDaemon();
log("background loaded, protocol version", PROTOCOL_VERSION);
