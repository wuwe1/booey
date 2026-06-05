// ExtConn — one connected browser extension (one browser profile).
//
// Owns everything that used to be daemon-global single-ext state, now scoped
// per connection so multiple browsers run concurrently:
//   - the WS to this ext
//   - identity {id, label} from hello
//   - per-conn strict-serial command scheduler (inflight + pending FIFO)
//   - attachedTabs + per-tab event cache (ring buffers)
//
// Different ExtConns are independent: each is serial internally, but the daemon
// can have one command in flight to browser A while another flies to browser B.

import { httpError } from "./http-error.mjs";
import { RingBuffer } from "./ring-buffer.mjs";
import { PROTOCOL_VERSION, CMD_TIMEOUT_MS, EVENT_CACHE_CAP } from "./config.mjs";

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
    /** @type {{resolve:Function,reject:Function,timer:any}|null} */
    this.inflight = null;
    /** @type {Array<{msg:any,resolve:Function,reject:Function}>} */
    this.pending = [];
    /** @type {Map<number, RingBuffer>} tabId → event ring buffer */
    this.events = new Map();

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

  // ---- per-conn serial command scheduler ----

  /**
   * Send a command to the ext and resolve with its response. Strict serial:
   * one command in flight at a time, the rest queue.
   * @param {any} msg
   * @returns {Promise<any>}
   */
  callExt(msg) {
    return new Promise((resolve, reject) => {
      if (!this.helloed) return reject(httpError(503, "extension not ready"));
      this.pending.push({ msg, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    if (this.inflight || this.pending.length === 0 || !this.helloed) return;
    const { msg, resolve, reject } = this.pending.shift();
    const timer = setTimeout(() => {
      // Drop the waiter so a late response isn't mis-paired with the next command.
      if (this.inflight && this.inflight.reject === reject) {
        this.inflight = null;
        reject(httpError(504, "timeout"));
        this._pump();
      }
    }, CMD_TIMEOUT_MS);
    this.inflight = { resolve, reject, timer };
    try {
      this.send(msg);
    } catch (e) {
      clearTimeout(timer);
      this.inflight = null;
      reject(httpError(503, "extension send failed: " + e.message));
      this._pump();
    }
  }

  // ---- high-level operations (keep the HTTP layer thin) ----

  /** @param {number} tabId */
  async attach(tabId) {
    if (this.attachedTabs.has(tabId)) return { ok: true };
    const r = await this.callExt({ type: "attach", tabId });
    if (!r.ok) return r;
    this.attachedTabs.add(tabId);
    this.clearTabCache(tabId);
    return { ok: true };
  }

  /** @param {number} tabId */
  async detach(tabId) {
    if (!this.attachedTabs.has(tabId)) return { ok: true };
    const r = await this.callExt({ type: "detach", tabId });
    this.attachedTabs.delete(tabId);
    this.clearTabCache(tabId);
    return r.ok ? { ok: true } : r;
  }

  /**
   * @param {number} tabId
   * @param {string} method
   * @param {any} [params]
   */
  async sendCdp(tabId, method, params) {
    if (!this.attachedTabs.has(tabId)) throw httpError(409, `tab ${tabId} not attached`);
    return this.callExt({ type: "cdp", tabId, method, params: params ?? {} });
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
    // Push messages carry `type`; command responses are `ok`-shaped (no type).
    if (typeof m.type === "string") {
      this._handlePush(m);
      return;
    }
    if (!this.inflight) {
      this._log(`[${this.name}] response with no inflight — dropping`);
      return;
    }
    clearTimeout(this.inflight.timer);
    const { resolve } = this.inflight;
    this.inflight = null;
    resolve(m);
    this._pump();
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
          this.cacheEvent(m.tabId, { method: m.method, params: m.params, ts: Date.now() });
        }
        return;
      case "detached":
        if (typeof m.tabId === "number") {
          this.attachedTabs.delete(m.tabId);
          this.clearTabCache(m.tabId);
          this._log(`[${this.name}] tab ${m.tabId} detached: ${m.reason || "unknown"}`);
        }
        return;
      case "pong":
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
    this._pump();
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

  /** @param {number} tabId @param {RegExp|null} [filterRe] */
  getEvents(tabId, filterRe) {
    const rb = this.events.get(tabId);
    if (!rb) return [];
    const arr = rb.toArray();
    return filterRe ? arr.filter((e) => filterRe.test(e.method)) : arr;
  }

  /** @param {number} tabId */
  clearTabCache(tabId) {
    this.events.delete(tabId);
  }

  eventCount() {
    let n = 0;
    for (const rb of this.events.values()) n += rb.length;
    return n;
  }

  // ---- lifecycle ----

  /** Reject every queued + in-flight command. Idempotent. @param {string} reason */
  failAll(reason) {
    if (this.inflight) {
      clearTimeout(this.inflight.timer);
      this.inflight.reject(httpError(503, reason));
      this.inflight = null;
    }
    for (const p of this.pending) p.reject(httpError(503, reason));
    this.pending = [];
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
