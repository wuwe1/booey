// ExtConn — one connected browser extension (one browser profile).
//
// Owns everything that used to be daemon-global single-ext state, now scoped
// per connection so multiple browsers run concurrently:
//   - the WS to this ext
//   - identity {id, label} from hello
//   - per-conn command scheduler (message id ↔ waiter, per-tab lanes)
//   - attachedTabs + per-tab event cache (ring buffers)
//
// CONCURRENCY (protocol v3)
// Every command carries a message id and responses quote it, so more than one
// command can be in flight at a time. Three levels:
//
//   between browsers  parallel  — separate ExtConns, always was
//   between tabs      parallel  — separate lanes, new in v3
//   within one tab    depends   — ordered commands serialize, reads overlap
//
// v2 kept exactly one command in flight per browser and paired responses
// positionally. That capped a browser at one round-trip at a time and, worse,
// mis-paired: a command abandoned on timeout still got an answer later, which
// then resolved the *next* command's waiter and shifted every response after it
// by one. Ids remove the failure mode outright — an answer for a retired id has
// nowhere to land and is dropped.

import { httpError } from "./http-error.mjs";
import { RingBuffer } from "./ring-buffer.mjs";
import {
  PROTOCOL_VERSION,
  CMD_TIMEOUT_MS,
  EVENT_CACHE_CAP,
  MAX_INFLIGHT_PER_TAB,
  UNORDERED_CDP_METHODS,
  DIRTY_EVENT_METHODS,
  expandEventSelectors,
} from "./config.mjs";

/** Lane key for commands that address the browser rather than a tab. */
const BROWSER_LANE = "browser";

export class ExtConn {
  /**
   * @param {import("ws").WebSocket} ws
   * @param {{ onHello: (c: ExtConn) => void, onClose: (c: ExtConn) => void, log: (...a: any[]) => void }} hooks
   */
  constructor(ws, { onHello, onClose, log }) {
    this.ws = ws;
    this.id = null; // assigned on hello
    this.label = "";
    this.helloed = false;
    this.lastSeen = Date.now();
    /** @type {Array<{tabId:number,url:string,title:string}>} */
    this.tabs = [];
    /** @type {Set<number>} */
    this.attachedTabs = new Set();
    this.nextMsgId = 1;
    /**
     * In-flight commands across every lane, keyed by wire message id.
     * @type {Map<number, {lane:Lane, ordered:boolean, resolve:Function, reject:Function, timer:any}>}
     */
    this.inflight = new Map();
    /** @type {Map<number|string, Lane>} tabId (or BROWSER_LANE) → lane */
    this.lanes = new Map();
    /** @type {Map<number, RingBuffer>} tabId → event ring buffer */
    this.events = new Map();
    /**
     * tabId → the expanded selector list in force for that tab. One owner per
     * tab, last writer wins: no refcounting, because a tab already has a single
     * owner for everything else that matters (focus, navigation, dialogs).
     * @type {Map<number, string[]>}
     */
    this.subscriptions = new Map();
    /** @type {{matchedEvents:number,filteredEvents:number,droppedEvents:number}|null} last stats from a pong */
    this.stats = null;
    /**
     * tabId → { revision, lastDirty }. `revision` is monotonic and bumped by any
     * event in DIRTY_EVENT_METHODS.
     *
     * Monotonic counter rather than a boolean dirty flag on purpose: a flag needs
     * someone to clear it, and the moment two callers share a tab there is no
     * answer to who that is. A counter is read-and-compare — every caller keeps
     * its own baseline and nobody can clear anyone else's.
     * @type {Map<number, {revision:number, lastDirty:{method:string, ts:number}|null}>}
     */
    this.pageState = new Map();

    this._onHello = onHello;
    this._onClose = onClose;
    this._log = log;
    this._closed = false;

    ws.on("message", (data) => this._onMessage(data.toString("utf8")));
    ws.on("close", () => this._handleClose());
    ws.on("error", (e) => log(`[${this.name}] ws error: ${e.message}`));
  }

  /** Human-friendly handle for logs: label, else id, else pending. */
  get name() {
    return this.label || this.id || "(pending)";
  }

  /** @param {any} msg */
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  // ---- command scheduler ----

  /**
   * Send a command to the ext and resolve with its response.
   *
   * `ordered` commands hold their tab exclusively: nothing else in that lane
   * starts until they finish, and they wait for the lane to drain first. That is
   * the default, because CDP's racy surfaces — input dispatch, navigation, focus,
   * dialogs — are all tab-scoped. Unordered commands (pure reads) overlap up to
   * MAX_INFLIGHT_PER_TAB.
   *
   * @param {any} msg
   * @param {boolean} [ordered]
   * @param {number} [timeoutMs] override CMD_TIMEOUT_MS for this one command
   * @returns {Promise<any>}
   */
  callExt(msg, ordered = true, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.helloed) return reject(httpError(503, "extension not ready", { code: "EXT_NOT_READY" }));
      const id = this.nextMsgId++;
      const lane = this._lane(typeof msg.tabId === "number" ? msg.tabId : BROWSER_LANE);
      const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : CMD_TIMEOUT_MS;
      lane.queue.push({ id, msg: { ...msg, id }, ordered, timeoutMs: budget, resolve, reject });
      this._pumpLane(lane);
    });
  }

  /** @param {number|string} key @returns {Lane} */
  _lane(key) {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { key, inflight: new Set(), orderedInflight: false, queue: [] };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  /** @param {Lane} lane */
  _pumpLane(lane) {
    if (this._closed) return;
    while (lane.queue.length > 0) {
      if (lane.orderedInflight) return; // an exclusive command owns the lane
      const head = lane.queue[0];
      if (head.ordered) {
        if (lane.inflight.size > 0) return; // let the reads finish first
        lane.queue.shift();
        this._dispatch(lane, head);
        return; // exclusive: nothing else starts behind it
      }
      if (lane.inflight.size >= MAX_INFLIGHT_PER_TAB) return;
      lane.queue.shift();
      this._dispatch(lane, head);
    }
    this._reapLane(lane);
  }

  /** @param {Lane} lane @param {any} entry */
  _dispatch(lane, entry) {
    const { id, msg, ordered, timeoutMs, resolve, reject } = entry;
    const timer = setTimeout(() => {
      // The ext has no cancel; it may still answer this id later. Retiring the id
      // here means that answer lands nowhere, which is exactly what we want.
      this._settle(id, (w) => w.reject(httpError(504, `timeout after ${timeoutMs}ms`, { code: "TIMEOUT" })));
    }, timeoutMs);
    this.inflight.set(id, { lane, ordered, resolve, reject, timer });
    lane.inflight.add(id);
    if (ordered) lane.orderedInflight = true;
    try {
      this.send(msg);
    } catch (e) {
      this._settle(id, (w) => w.reject(httpError(503, "extension send failed: " + e.message)));
    }
  }

  /**
   * Retire one in-flight id, run `finish` on its waiter, and refill its lane.
   * Every exit path for a command goes through here. Unknown ids are a no-op, so
   * a late or duplicated response is harmless.
   * @param {number} id
   * @param {(w: {resolve:Function, reject:Function}) => void} finish
   */
  _settle(id, finish) {
    const w = this.inflight.get(id);
    if (!w) return false;
    this.inflight.delete(id);
    clearTimeout(w.timer);
    w.lane.inflight.delete(id);
    if (w.ordered) w.lane.orderedInflight = false;
    finish(w);
    this._pumpLane(w.lane);
    return true;
  }

  /** Drop a lane once it holds nothing, so tab churn doesn't grow the map. */
  _reapLane(lane) {
    if (lane.queue.length === 0 && lane.inflight.size === 0) this.lanes.delete(lane.key);
  }

  // ---- high-level operations (keep the HTTP layer thin) ----

  /**
   * @param {number} tabId
   * @param {string[]|null} [events] selectors or preset names; null → DEFAULT_EVENTS
   */
  async attach(tabId, events) {
    const selectors = expandEventSelectors(events ?? null);
    if (this.attachedTabs.has(tabId)) {
      // Already attached: honour the subscription the caller just asked for
      // rather than silently keeping whatever the first attach set up.
      if (events != null) return this.setEvents(tabId, events);
      return { ok: true, result: { events: this.subscriptions.get(tabId) ?? selectors } };
    }
    const r = await this.callExt({ type: "attach", tabId, events: selectors });
    if (!r.ok) return r;
    this.attachedTabs.add(tabId);
    this.subscriptions.set(tabId, selectors);
    this.clearTabCache(tabId);
    return { ok: true, result: { events: selectors, ...(r.result || {}) } };
  }

  /**
   * Replace a tab's event subscription wholesale. Declarative on purpose: the
   * daemon pushes the desired end state and the ext diffs it, so a reconnect is
   * repaired by re-pushing rather than by replaying a history of changes.
   * @param {number} tabId @param {string[]} events
   */
  async setEvents(tabId, events) {
    if (!this.attachedTabs.has(tabId)) throw httpError(409, `tab ${tabId} not attached`, { code: "TAB_NOT_ATTACHED" });
    const selectors = expandEventSelectors(events);
    const r = await this.callExt({ type: "events.set", tabId, events: selectors });
    if (!r.ok) return r;
    this.subscriptions.set(tabId, selectors);
    return { ok: true, result: { events: selectors, ...(r.result || {}) } };
  }

  /** @param {number} tabId @returns {string[]} */
  subscription(tabId) {
    return this.subscriptions.get(tabId) ?? [];
  }

  /** @param {number} tabId */
  async detach(tabId) {
    if (!this.attachedTabs.has(tabId)) return { ok: true };
    const r = await this.callExt({ type: "detach", tabId });
    this.attachedTabs.delete(tabId);
    this.subscriptions.delete(tabId);
    this.clearTabCache(tabId);
    return r.ok ? { ok: true } : r;
  }

  /**
   * @param {number} tabId
   * @param {string} method
   * @param {any} [params]
   * @param {{ordered?:boolean, timeoutMs?:number, sessionId?:string}} [opts]
   *   ordered   — override the UNORDERED_CDP_METHODS classification
   *   timeoutMs — override the daemon-wide command timeout
   *   sessionId — address a flat auto-attached session (an OOPIF or worker)
   *               instead of the tab's own session
   */
  async sendCdp(tabId, method, params, opts = {}) {
    if (!this.attachedTabs.has(tabId)) throw httpError(409, `tab ${tabId} not attached`, { code: "TAB_NOT_ATTACHED" });
    const exclusive = opts.ordered ?? !UNORDERED_CDP_METHODS.has(method);
    const msg = { type: "cdp", tabId, method, params: params ?? {} };
    if (opts.sessionId) msg.sessionId = opts.sessionId;
    // Lane is still the tab: an OOPIF's session shares the tab's focus, dialogs,
    // and navigation, so ordering has to be decided at tab granularity.
    return this.callExt(msg, exclusive, opts.timeoutMs);
  }

  /**
   * Open a background tab. CDP has no browser-level target creation available to
   * us — the ext attaches per tab, so `Target.createTarget` is out of reach — but
   * `chrome.tabs.create` is an extension API and needs no debugger attachment.
   *
   * `active: false` is the whole point: Chrome activates and foregrounds any tab
   * opened by a user gesture, which interrupts someone actually using the
   * browser. This is the browser lane, not a tab lane; there is no tab yet.
   * @param {string} url
   */
  async openTab(url) {
    return this.callExt({ type: "open-tab", url });
  }

  async listTabs() {
    const r = await this.callExt({ type: "list-tabs" });
    if (r.ok) this.tabs = r.result?.tabs || [];
    return r;
  }

  // ---- inbound message dispatch ----

  /** @param {string} raw */
  _onMessage(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      this._log(`[${this.name}] non-json from ext, ignoring`);
      return;
    }
    this.lastSeen = Date.now();
    // v3 shapes: has `id` → command response; has `type` → push. Never both.
    if (typeof m.id === "number") {
      // chrome.debugger's own failures stay a 200 + ok:false business branch
      // (they are not infra failures), but they get a code like everything else.
      if (m.ok === false && m.error && typeof m.error === "object" && !m.error.code) {
        m.error.code = "DEBUGGER_ERROR";
      }
      // The wire id is how the daemon pairs the response; it means nothing to an
      // HTTP caller. Strip it here rather than leaking internal plumbing into
      // the public contract.
      const { id: _wireId, ...payload } = m;
      if (!this._settle(m.id, (w) => w.resolve(payload))) {
        this._log(`[${this.name}] response for retired id ${m.id} — dropping`);
      }
      return;
    }
    if (typeof m.type === "string") {
      this._handlePush(m);
      return;
    }
    this._log(`[${this.name}] message with neither id nor type — dropping`);
  }

  /** @param {any} m */
  _handlePush(m) {
    switch (m.type) {
      case "hello":
        return this._handleHello(m);
      case "tabs-changed":
        this.tabs = Array.isArray(m.tabs) ? m.tabs : [];
        return;
      case "event":
        if (typeof m.tabId === "number") {
          const ev = { method: m.method, params: m.params, ts: Date.now() };
          if (m.sessionId) ev.sessionId = m.sessionId; // came from an OOPIF/worker session
          this.cacheEvent(m.tabId, ev);
          if (DIRTY_EVENT_METHODS.has(m.method)) this.bumpRevision(m.tabId, m.method, ev.ts);
        }
        return;
      case "detached":
        if (typeof m.tabId === "number") {
          this.attachedTabs.delete(m.tabId);
          this.clearTabCache(m.tabId);
          this.subscriptions.delete(m.tabId);
          this._log(`[${this.name}] tab ${m.tabId} detached: ${m.reason || "unknown"}`);
          // Fail this tab's work now rather than letting each command sit out its
          // full CMD_TIMEOUT_MS. chrome.debugger does answer these (with an error)
          // once it notices, but that can be seconds — and a caller waiting 30s on
          // a tab the browser already took away learns nothing by waiting.
          this.failTab(m.tabId, `tab ${m.tabId} detached: ${m.reason || "unknown"}`);
        }
        return;
      case "pong":
        // The ext rides its event counters on the heartbeat. matched/filtered is
        // the subscription filter's whole justification, so keep it visible.
        if (m.stats && typeof m.stats === "object") this.stats = m.stats;
        return;
      default:
        this._log(`[${this.name}] unknown push type: ${m.type}`);
    }
  }

  /** @param {any} m */
  _handleHello(m) {
    if (m.version !== PROTOCOL_VERSION) {
      this._log(`[${this.name}] hello version mismatch: got ${m.version}, want ${PROTOCOL_VERSION}; closing`);
      this.close(4000, "version mismatch");
      return;
    }
    if (typeof m.id !== "string" || !m.id) {
      this._log(`[${this.name}] hello missing id; closing`);
      this.close(4000, "missing id");
      return;
    }
    this.id = m.id;
    this.label = typeof m.label === "string" ? m.label : "";
    this.tabs = Array.isArray(m.tabs) ? m.tabs : [];
    const wasHelloed = this.helloed;
    this.helloed = true;
    this._log(`[${this.name}] hello ok (${this.tabs.length} tabs)${wasHelloed ? " [re-hello]" : ""}`);
    this._onHello(this); // registry registers under this.id (may kick a same-id stale conn)
  }

  // ---- page revision ----

  /** @param {number} tabId @param {string} method @param {number} ts */
  bumpRevision(tabId, method, ts) {
    const st = this.pageState.get(tabId) ?? { revision: 0, lastDirty: null };
    st.revision++;
    st.lastDirty = { method, ts };
    this.pageState.set(tabId, st);
  }

  /**
   * @param {number} tabId
   * @returns {{tabId:number, attached:boolean, revision:number, lastDirty:any, events:string[], url:string}}
   */
  page(tabId) {
    const st = this.pageState.get(tabId) ?? { revision: 0, lastDirty: null };
    const tab = this.tabs.find((t) => t.tabId === tabId);
    return {
      tabId,
      attached: this.attachedTabs.has(tabId),
      revision: st.revision,
      lastDirty: st.lastDirty,
      events: this.subscription(tabId),
      url: tab?.url ?? "",
    };
  }

  // ---- event cache (per tab) ----

  /** @param {number} tabId @param {{method:string,params:any,ts:number}} ev */
  cacheEvent(tabId, ev) {
    let rb = this.events.get(tabId);
    if (!rb) {
      rb = new RingBuffer(EVENT_CACHE_CAP);
      this.events.set(tabId, rb);
    }
    rb.push(ev);
  }

  /**
   * Incremental read. `since` is a previous read's `nextSeq`; 0 pulls everything
   * still held. `truncated` says the ring overwrote events the caller had not
   * seen yet — the difference between "nothing happened" and "you missed it".
   * @param {number} tabId
   * @param {{since?:number, filterRe?:RegExp|null}} [opts]
   */
  readEvents(tabId, { since = 0, filterRe = null } = {}) {
    const rb = this.events.get(tabId);
    if (!rb) return { events: [], nextSeq: 0, dropped: 0, truncated: false };
    return rb.readSince(since, filterRe ? (e) => filterRe.test(e.method) : undefined);
  }

  /** @param {number} tabId */
  clearTabCache(tabId) {
    this.events.delete(tabId);
    // The revision counts changes to a page we were watching. Detaching or
    // re-attaching ends that observation, so the count starts over rather than
    // letting a stale baseline look valid across the gap.
    this.pageState.delete(tabId);
  }

  eventCount() {
    let n = 0;
    for (const rb of this.events.values()) n += rb.length;
    return n;
  }

  // ---- lifecycle ----

  /**
   * Fail every command belonging to one tab, leaving the other lanes running.
   * @param {number} tabId @param {string} reason
   */
  failTab(tabId, reason) {
    const lane = this.lanes.get(tabId);
    if (!lane) return;
    const queued = lane.queue.splice(0);
    for (const e of queued) e.reject(httpError(409, reason, { code: "TAB_DETACHED", retriable: true }));
    for (const id of [...lane.inflight]) this._settle(id, (w) => w.reject(httpError(409, reason, { code: "TAB_DETACHED", retriable: true })));
    this._reapLane(lane);
  }

  /** Reject every queued + in-flight command. Idempotent. @param {string} reason */
  failAll(reason) {
    // Drain the queues first: settling an in-flight command pumps its lane, and a
    // lane with work left would happily dispatch it down a connection we are in
    // the middle of tearing down.
    for (const lane of this.lanes.values()) {
      const queued = lane.queue.splice(0);
      for (const e of queued) e.reject(httpError(503, reason, { code: "EXT_DISCONNECTED" }));
    }
    for (const id of [...this.inflight.keys()]) this._settle(id, (w) => w.reject(httpError(503, reason, { code: "EXT_DISCONNECTED" })));
    this.lanes.clear();
  }

  /** Actively close this connection. @param {number} code @param {string} reason */
  close(code, reason) {
    this.failAll(reason || "closed");
    try {
      this.ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  _handleClose() {
    if (this._closed) return;
    this._closed = true;
    this._log(`[${this.name}] disconnected`);
    this.failAll("ext disconnected");
    this._onClose(this);
  }
}

/**
 * @typedef {Object} Lane
 * @property {number|string} key
 * @property {Set<number>} inflight
 * @property {boolean} orderedInflight
 * @property {Array<{id:number,msg:any,ordered:boolean,resolve:Function,reject:Function}>} queue
 */
