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

import type { WebSocket } from "ws";
import {
  type Action,
  type ActionDraft,
  type ActionResult,
  resolveDrafts,
  TERMINATES_SEQUENCE,
} from "./actions.ts";
import {
  CMD_TIMEOUT_MS,
  DEFAULT_EVENTS,
  DIRTY_EVENT_METHODS,
  EVENT_CACHE_CAP,
  expandEventSelectors,
  MAX_INFLIGHT_PER_TAB,
  PROTOCOL_VERSION,
  UNORDERED_CDP_METHODS,
} from "./config.ts";
import { httpError } from "./http-error.ts";
import { buildSnapshot, type NodeRecord, type Snapshot } from "./page-model.ts";
import { RingBuffer } from "./ring-buffer.ts";

/** Lane key for commands that address the browser rather than a tab. */
const BROWSER_LANE = "browser";

export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
}

export interface ExtStats {
  matchedEvents: number;
  filteredEvents: number;
  droppedEvents: number;
}

export interface PageStateEntry {
  revision: number;
  lastDirty: { method: string; ts: number } | null;
}

export interface PageInfo {
  tabId: number;
  attached: boolean;
  revision: number;
  lastDirty: { method: string; ts: number } | null;
  events: string[];
  url: string;
}

/** One flat auto-attached target: an OOPIF or worker. Keyed on targetId. */
export interface SessionInfo {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
  openedAt: number;
}

export interface CachedEvent {
  method: string;
  params: any;
  ts: number;
  sessionId?: string;
}

/** A command's waiter: promise resolve/reject + its lane + ordering + timer. */
export interface Waiter {
  lane: Lane;
  ordered: boolean;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface QueueEntry {
  id: number;
  msg: any;
  ordered: boolean;
  timeoutMs: number;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}

export interface Lane {
  key: number | string;
  inflight: Set<number>;
  orderedInflight: boolean;
  queue: QueueEntry[];
}

/** A command's answer from the ext: ok:true carries `result`, ok:false carries `error`. */
export interface ExtResult {
  ok: boolean;
  result?: any;
  error?: { message: string; code?: string };
}

export class ExtConn {
  ws: WebSocket;
  /** Assigned on hello. */
  id: string | null;
  label: string;
  helloed: boolean;
  lastSeen: number;
  tabs: TabInfo[];
  attachedTabs: Set<number>;
  nextMsgId: number;
  /** In-flight commands across every lane, keyed by wire message id. */
  inflight: Map<number, Waiter>;
  /** tabId (or BROWSER_LANE) → lane. */
  lanes: Map<number | string, Lane>;
  /** tabId → event ring buffer. */
  events: Map<number, RingBuffer>;
  /**
   * tabId → the expanded selector list in force for that tab. One owner per tab,
   * last writer wins: no refcounting, because a tab already has a single owner
   * for everything else that matters (focus, navigation, dialogs).
   */
  subscriptions: Map<number, string[]>;
  /** Last stats from a pong. */
  stats: ExtStats | null;
  /**
   * tabId → { revision, lastDirty }. `revision` is monotonic and bumped by any
   * event in DIRTY_EVENT_METHODS.
   *
   * Monotonic counter rather than a boolean dirty flag on purpose: a flag needs
   * someone to clear it, and the moment two callers share a tab there is no
   * answer to who that is. A counter is read-and-compare — every caller keeps
   * its own baseline and nobody can clear anyone else's.
   */
  pageState: Map<number, PageStateEntry>;
  /**
   * tabId → targetId → session. Keyed on **targetId, not sessionId**: the
   * sessionId is reissued every time the debugger reattaches, while the targetId
   * keeps naming the same live frame. The sessionId is that frame's current
   * address, not its identity.
   *
   * Neither survives a reload: the frame is destroyed and a new one is created,
   * so both ids change (measured — targetId B359EA19D0 → 2B3BA7C45B across one
   * Page.reload). "Stable across reattach" is not "stable across navigation";
   * nothing here is a durable handle on a frame.
   */
  sessions: Map<number, Map<string, SessionInfo>>;
  /** tabId → 最近一次快照及其 revision。GET /snapshot 靠它判断是否 stale。 */
  snapshots: Map<number, { revision: number; snapshot: Snapshot }>;

  _onHello: (c: ExtConn) => void;
  _onClose: (c: ExtConn) => void;
  _log: (...a: any[]) => void;
  _closed: boolean;

  constructor(
    ws: WebSocket,
    hooks: {
      onHello: (c: ExtConn) => void;
      onClose: (c: ExtConn) => void;
      log: (...a: any[]) => void;
    },
  ) {
    const { onHello, onClose, log } = hooks;
    this.ws = ws;
    this.id = null;
    this.label = "";
    this.helloed = false;
    this.lastSeen = Date.now();
    this.tabs = [];
    this.attachedTabs = new Set();
    this.nextMsgId = 1;
    this.inflight = new Map();
    this.lanes = new Map();
    this.events = new Map();
    this.subscriptions = new Map();
    this.stats = null;
    this.pageState = new Map();
    this.sessions = new Map();
    this.snapshots = new Map();

    this._onHello = onHello;
    this._onClose = onClose;
    this._log = log;
    this._closed = false;

    ws.on("message", (data) => this._onMessage(data.toString("utf8")));
    ws.on("close", () => this._handleClose());
    ws.on("error", (e) => log(`[${this.name}] ws error: ${e.message}`));
  }

  /** Human-friendly handle for logs: label, else id, else pending. */
  get name(): string {
    return this.label || this.id || "(pending)";
  }

  send(msg: any): void {
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
   * @param msg the wire command (without an id — one is added here)
   * @param ordered take the tab exclusively
   * @param timeoutMs override CMD_TIMEOUT_MS for this one command
   */
  callExt(msg: any, ordered = true, timeoutMs?: number): Promise<ExtResult> {
    return new Promise((resolve, reject) => {
      if (!this.helloed)
        return reject(httpError(503, "extension not ready", { code: "EXT_NOT_READY" }));
      const id = this.nextMsgId++;
      const lane = this._lane(typeof msg.tabId === "number" ? msg.tabId : BROWSER_LANE);
      const budget =
        timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : CMD_TIMEOUT_MS;
      lane.queue.push({ id, msg: { ...msg, id }, ordered, timeoutMs: budget, resolve, reject });
      this._pumpLane(lane);
    });
  }

  _lane(key: number | string): Lane {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { key, inflight: new Set(), orderedInflight: false, queue: [] };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  _pumpLane(lane: Lane): void {
    if (this._closed) return;
    while (lane.queue.length > 0) {
      if (lane.orderedInflight) return; // an exclusive command owns the lane
      const head = lane.queue[0]!;
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

  _dispatch(lane: Lane, entry: QueueEntry): void {
    const { id, msg, ordered, timeoutMs, resolve, reject } = entry;
    const timer = setTimeout(() => {
      // The ext has no cancel; it may still answer this id later. Retiring the id
      // here means that answer lands nowhere, which is exactly what we want.
      this._settle(id, (w) =>
        w.reject(httpError(504, `timeout after ${timeoutMs}ms`, { code: "TIMEOUT" })),
      );
    }, timeoutMs);
    this.inflight.set(id, { lane, ordered, resolve, reject, timer });
    lane.inflight.add(id);
    if (ordered) lane.orderedInflight = true;
    try {
      this.send(msg);
    } catch (e) {
      this._settle(id, (w) =>
        w.reject(httpError(503, "extension send failed: " + (e as Error).message)),
      );
    }
  }

  /**
   * Retire one in-flight id, run `finish` on its waiter, and refill its lane.
   * Every exit path for a command goes through here. Unknown ids are a no-op, so
   * a late or duplicated response is harmless.
   */
  _settle(id: number, finish: (w: Waiter) => void): boolean {
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
  _reapLane(lane: Lane): void {
    if (lane.queue.length === 0 && lane.inflight.size === 0) this.lanes.delete(lane.key);
  }

  // ---- high-level operations (keep the HTTP layer thin) ----

  /**
   * @param tabId
   * @param events selectors or preset names; null → DEFAULT_EVENTS
   * @param sessions also flat auto-attach, so out-of-process iframes become
   *   addressable. Implies the `targets` preset — without those events the pool
   *   cannot be maintained, and a caller asking for sessions but not getting
   *   Target events would silently get an empty pool.
   */
  async attach(tabId: number, events: string[] | null, sessions = false): Promise<ExtResult> {
    const requested = events ?? null;
    const withTargets = sessions ? [...(requested ?? DEFAULT_EVENTS), "targets"] : requested;
    const selectors = expandEventSelectors(withTargets);
    if (this.attachedTabs.has(tabId)) {
      // Already attached: honour the subscription the caller just asked for
      // rather than silently keeping whatever the first attach set up.
      if (requested != null || sessions) {
        const r = await this.setEvents(tabId, selectors);
        if (!r.ok || !sessions) return r;
        return this.enableSessions(tabId);
      }
      return { ok: true, result: { events: this.subscriptions.get(tabId) ?? selectors } };
    }
    const r = await this.callExt({ type: "attach", tabId, events: selectors });
    if (!r.ok) return r;
    this.attachedTabs.add(tabId);
    this.subscriptions.set(tabId, selectors);
    this.clearTabCache(tabId);
    const base = { ok: true, result: { events: selectors, ...(r.result || {}) } };
    if (!sessions) return base;
    const s = await this.enableSessions(tabId);
    if (!s.ok) return s;
    return { ok: true, result: { ...base.result, sessions: s.result.sessions } };
  }

  /**
   * Replace a tab's event subscription wholesale. Declarative on purpose: the
   * daemon pushes the desired end state and the ext diffs it, so a reconnect is
   * repaired by re-pushing rather than by replaying a history of changes.
   */
  async setEvents(tabId: number, events: string[]): Promise<ExtResult> {
    if (!this.attachedTabs.has(tabId))
      throw httpError(409, `tab ${tabId} not attached`, { code: "TAB_NOT_ATTACHED" });
    const selectors = expandEventSelectors(events);
    const r = await this.callExt({ type: "events.set", tabId, events: selectors });
    if (!r.ok) return r;
    this.subscriptions.set(tabId, selectors);
    return { ok: true, result: { events: selectors, ...(r.result || {}) } };
  }

  subscription(tabId: number): string[] {
    return this.subscriptions.get(tabId) ?? [];
  }

  async detach(tabId: number): Promise<ExtResult> {
    if (!this.attachedTabs.has(tabId)) return { ok: true };
    const r = await this.callExt({ type: "detach", tabId });
    this.attachedTabs.delete(tabId);
    this.subscriptions.delete(tabId);
    this.clearTabCache(tabId);
    return r.ok ? { ok: true } : r;
  }

  /**
   * @param opts.ordered override the UNORDERED_CDP_METHODS classification
   * @param opts.timeoutMs override the daemon-wide command timeout
   * @param opts.sessionId address a flat auto-attached session (an OOPIF or
   *   worker) instead of the tab's own session
   */
  async sendCdp(
    tabId: number,
    method: string,
    params?: any,
    opts: { ordered?: boolean; timeoutMs?: number; sessionId?: string } = {},
  ): Promise<ExtResult> {
    if (!this.attachedTabs.has(tabId))
      throw httpError(409, `tab ${tabId} not attached`, { code: "TAB_NOT_ATTACHED" });
    const exclusive = opts.ordered ?? !UNORDERED_CDP_METHODS.has(method);
    const msg: { type: string; tabId: number; method: string; params: any; sessionId?: string } = {
      type: "cdp",
      tabId,
      method,
      params: params ?? {},
    };
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
   */
  async openTab(url: string): Promise<ExtResult> {
    return this.callExt({ type: "open-tab", url });
  }

  async listTabs(): Promise<ExtResult> {
    const r = await this.callExt({ type: "list-tabs" });
    if (r.ok) this.tabs = r.result?.tabs || [];
    return r;
  }

  // ---- inbound message dispatch ----

  _onMessage(raw: string): void {
    let m: any;
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

  _handlePush(m: any): void {
    switch (m.type) {
      case "hello":
        this._handleHello(m);
        return;
      case "tabs-changed":
        this.tabs = Array.isArray(m.tabs) ? m.tabs : [];
        return;
      case "event":
        if (typeof m.tabId === "number") {
          this._trackSession(m.tabId, m.method, m.params);
          const ev: CachedEvent = { method: m.method, params: m.params, ts: Date.now() };
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

  _handleHello(m: any): void {
    if (m.version !== PROTOCOL_VERSION) {
      this._log(
        `[${this.name}] hello version mismatch: got ${m.version}, want ${PROTOCOL_VERSION}; closing`,
      );
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
    this._log(
      `[${this.name}] hello ok (${this.tabs.length} tabs)${wasHelloed ? " [re-hello]" : ""}`,
    );
    this._onHello(this); // registry registers under this.id (may kick a same-id stale conn)
  }

  // ---- session pool (out-of-process iframes, workers) ----
  //
  // Fed entirely by Target events, the way browser-use's SessionManager is: the
  // pool then reflects browser reality rather than a list we tried to keep in
  // step by hand. Nothing here polls.

  _trackSession(tabId: number, method: string, params: any): void {
    if (!method.startsWith("Target.") || !params) return;
    if (method === "Target.attachedToTarget") {
      const info = params.targetInfo || {};
      if (!params.sessionId || !info.targetId) return;
      const pool = this.sessions.get(tabId) ?? new Map<string, SessionInfo>();
      pool.set(info.targetId, {
        sessionId: params.sessionId,
        targetId: info.targetId,
        type: info.type || "",
        url: info.url || "",
        openedAt: Date.now(),
      });
      this.sessions.set(tabId, pool);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const pool = this.sessions.get(tabId);
      if (!pool) return;
      // detachedFromTarget carries sessionId and (usually) targetId. Fall back to
      // a sessionId scan so a payload without targetId still evicts.
      const targetId =
        params.targetId ??
        [...pool.values()].find((x) => x.sessionId === params.sessionId)?.targetId;
      if (targetId) pool.delete(targetId);
      if (pool.size === 0) this.sessions.delete(tabId);
      return;
    }
    if (method === "Target.targetInfoChanged") {
      const info = params.targetInfo || {};
      const existing = this.sessions.get(tabId)?.get(info.targetId);
      if (existing) existing.url = info.url || existing.url; // a frame navigated
    }
  }

  sessionList(tabId: number): SessionInfo[] {
    return [...(this.sessions.get(tabId)?.values() ?? [])];
  }

  /**
   * Turn on flat auto-attach for a tab. Idempotent — Target.setAutoAttach is,
   * and re-sending it is how a caller repairs the pool after a reload.
   */
  async enableSessions(tabId: number): Promise<ExtResult> {
    if (!this.attachedTabs.has(tabId))
      throw httpError(409, `tab ${tabId} not attached`, { code: "TAB_NOT_ATTACHED" });
    const r = await this.sendCdp(tabId, "Target.setAutoAttach", {
      autoAttach: true,
      flatten: true,
      // Pausing every new target until we release it would hold up page loads
      // the caller never asked us to inspect. Opt-in territory, not a default.
      waitForDebuggerOnStart: false,
    });
    if (!r.ok) return r;
    return { ok: true, result: { sessions: this.sessionList(tabId) } };
  }

  // ---- page model (snapshot) ----

  /**
   * 取当前页面所有 frame（主 + session 池里的 OOPIF）的三棵树，合并成 NodeRecord
   * 快照并跨 frame 拼接，然后缓存。快照是「某 revision 的页面照片」，页面一旦被
   * dirty 事件 bump 了 revision，这张照片就 stale 了。
   */
  async snapshot(tabId: number): Promise<ExtResult> {
    if (!this.attachedTabs.has(tabId))
      throw httpError(409, `tab ${tabId} not attached`, { code: "TAB_NOT_ATTACHED" });
    // 主 frame 是 frameOrdinal 0；session 池里的每个 OOPIF 各占一个 frame，带着
    // 自己的 sessionId（ext 才能精确进到那个进程）。拼接是 daemon 的活，见
    // page-model 的 stitchFrames。worker 没有 DOM（发 DOM.getDocument 会 -32601），
    // 页面模型只关心 iframe/frame，跳过 worker。
    const frames: Array<{ frameOrdinal: number; sessionId?: string }> = [{ frameOrdinal: 0 }];
    for (const s of this.sessions.get(tabId)?.values() ?? []) {
      if (s.type !== "iframe" && s.type !== "frame") continue;
      frames.push({ frameOrdinal: frames.length, sessionId: s.sessionId });
    }
    const r = await this.callExt({ type: "snapshot", tabId, frames });
    if (!r.ok) return r;
    const revision = this.pageState.get(tabId)?.revision ?? 0;
    const prev = this.snapshots.get(tabId)?.snapshot;
    const prevIds = prev ? new Set(prev.nodes.map((n) => n.id)) : undefined;
    const snap = buildSnapshot(r.result?.frames ?? [], revision, prevIds);
    this.snapshots.set(tabId, { revision, snapshot: snap });
    return { ok: true, result: snap };
  }

  /**
   * 读缓存的快照。`stale` 表示缓存的 revision 已落后于当前 revision——页面在
   * 快照之后又动过，调用方手上的 index/xpath 可能已经失效。没有缓存时 404。
   */
  snapshotRead(tabId: number): { tabId: number; snapshot: Snapshot; stale: boolean } {
    const cached = this.snapshots.get(tabId);
    if (!cached)
      throw httpError(404, `no snapshot cached for tab ${tabId}; POST /snapshot first`, {
        code: "NOT_FOUND",
      });
    const current = this.pageState.get(tabId)?.revision ?? 0;
    return { tabId, snapshot: cached.snapshot, stale: current !== cached.revision };
  }

  // ---- actions (L3) ----

  /**
   * 用缓存的 selectorMap 把一批 ActionDraft（LLM 的 {index, method, args}）补成
   * 完整 Action。没有缓存或 index 失效都 409——前者要先 snapshot，后者要重新
   * snapshot + 重新推理。
   */
  resolveActions(tabId: number, drafts: ActionDraft[]): Action[] {
    const cached = this.snapshots.get(tabId);
    if (!cached)
      throw httpError(409, `no snapshot cached for tab ${tabId}; POST /snapshot first`, {
        code: "CONFLICT",
      });
    const actions = resolveDrafts(drafts, cached.snapshot.selectorMap);
    if (!actions)
      throw httpError(409, "selectorMap stale; re-snapshot and re-infer", { code: "CONFLICT" });
    return actions;
  }

  /**
   * 执行一批 Action，带三级回退和批量守卫（设计文档 §6.2 / §6.4）。
   *
   * 三级回退：
   *   1. xpath 定位 → 执行（零成本）
   *   2. xpath 失效 → 重新 snapshot，按 elementHash 找新 xpath（零 LLM）★
   *   3. elementHash 也没了 → 返回 needsInference，让调用方重新推理（一次 LLM）
   *
   * 批量守卫：terminatesSequence 的动作执行后丢弃队列剩余；每个动作后 revision
   * 变了（页面动了）也中断——URL 变化会通过 frameNavigated 反映成 revision bump。
   */
  async act(tabId: number, actions: Action[]): Promise<ExtResult> {
    if (!this.attachedTabs.has(tabId))
      throw httpError(409, `tab ${tabId} not attached`, { code: "TAB_NOT_ATTACHED" });
    const baseline = this.pageState.get(tabId)?.revision ?? 0;
    const results: ActionResult[] = [];
    for (const action of actions) {
      let loc = await this._locate(tabId, action.xpath);
      let healed = false;
      if (!loc) {
        // 第二级：elementHash 重定位。重新取树，找同 hash 的节点拿新 xpath。
        const r = await this.snapshot(tabId);
        if (r.ok) {
          const nodes = (r.result?.nodes ?? []) as NodeRecord[];
          const node = nodes.find((n) => n.elementHash === action.elementHash);
          if (node && node.xp !== action.xpath) {
            action.xpath = node.xp;
            loc = await this._locate(tabId, node.xp);
            healed = true;
          }
        }
      }
      if (!loc) {
        results.push({
          ok: false,
          method: action.method,
          needsInference: true,
          error: "element not found",
        });
        break;
      }
      const r = await this._dispatchAction(tabId, action, loc);
      results.push({
        ok: r.ok,
        method: action.method,
        ...(healed ? { healed: true } : {}),
        ...(r.ok ? {} : { error: r.error }),
      });
      if (TERMINATES_SEQUENCE.has(action.method)) break;
      // 运行时守卫：页面动了就停，保留已成功的部分结果。
      if ((this.pageState.get(tabId)?.revision ?? 0) !== baseline) {
        results.push({
          ok: false,
          method: action.method,
          interrupted: true,
          error: "page changed",
        });
        break;
      }
    }
    return { ok: true, result: { results } };
  }

  // ---- 动作的 CDP 执行 ----

  /** xpath → 元素中心坐标（先 scrollIntoView）。找不到返回 null。 */
  async _locate(tabId: number, xpath: string): Promise<{ x: number; y: number } | null> {
    const r = await this.sendCdp(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const el = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (!el) return null;
        if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(); else if (el.scrollIntoView) el.scrollIntoView();
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`,
      returnByValue: true,
    });
    if (!r.ok) return null;
    const v = r.result?.result?.value;
    return v && typeof v.x === "number" && typeof v.y === "number" ? { x: v.x, y: v.y } : null;
  }

  async _dispatchAction(
    tabId: number,
    action: Action,
    loc: { x: number; y: number },
  ): Promise<{ ok: boolean; error?: string }> {
    switch (action.method) {
      case "click":
        return this._click(tabId, loc.x, loc.y);
      case "doubleClick": {
        const first = await this._click(tabId, loc.x, loc.y);
        if (!first.ok) return first;
        return this._click(tabId, loc.x, loc.y);
      }
      case "hover":
        return this._hover(tabId, loc.x, loc.y);
      case "fill":
        return this._fill(tabId, action.xpath, action.args[0] ?? "");
      case "type":
        return this._type(tabId, action.xpath, action.args[0] ?? "");
      case "press":
        return this._press(tabId, action.args[0] ?? "");
      case "scrollTo":
        return this._scrollTo(tabId, action.xpath);
      case "selectOption":
        return this._selectOption(tabId, action.xpath, action.args[0] ?? "");
      default:
        return { ok: false, error: `unsupported method: ${action.method}` };
    }
  }

  async _click(tabId: number, x: number, y: number): Promise<{ ok: boolean; error?: string }> {
    await this.sendCdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.sendCdp(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    const r = await this.sendCdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error?.message };
  }

  async _hover(tabId: number, x: number, y: number): Promise<{ ok: boolean; error?: string }> {
    const r = await this.sendCdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    return r.ok ? { ok: true } : { ok: false, error: r.error?.message };
  }

  /** 在页面里对 xpath 元素执行一段函数体（`el` 已指向该元素）。 */
  async _evalOnXpath(
    tabId: number,
    xpath: string,
    fn: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const r = await this.sendCdp(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const el = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (!el) return false;
        ${fn}
      })()`,
      returnByValue: true,
    });
    if (!r.ok) return { ok: false, error: r.error?.message };
    return r.result?.result?.value === false
      ? { ok: false, error: "element not found" }
      : { ok: true };
  }

  _fill(tabId: number, xpath: string, value: string): Promise<{ ok: boolean; error?: string }> {
    return this._evalOnXpath(
      tabId,
      xpath,
      `const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;`,
    );
  }

  async _type(
    tabId: number,
    xpath: string,
    text: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const focus = await this._evalOnXpath(tabId, xpath, "el.focus(); return true;");
    if (!focus.ok) return focus;
    const r = await this.sendCdp(tabId, "Input.insertText", { text });
    return r.ok ? { ok: true } : { ok: false, error: r.error?.message };
  }

  async _press(tabId: number, key: string): Promise<{ ok: boolean; error?: string }> {
    const down = await this.sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key });
    if (!down.ok) return { ok: false, error: down.error?.message };
    const up = await this.sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key });
    return up.ok ? { ok: true } : { ok: false, error: up.error?.message };
  }

  _scrollTo(tabId: number, xpath: string): Promise<{ ok: boolean; error?: string }> {
    return this._evalOnXpath(
      tabId,
      xpath,
      "if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(); else el.scrollIntoView(); return true;",
    );
  }

  _selectOption(
    tabId: number,
    xpath: string,
    value: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this._evalOnXpath(
      tabId,
      xpath,
      `el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;`,
    );
  }

  // ---- page revision ----

  bumpRevision(tabId: number, method: string, ts: number): void {
    const st = this.pageState.get(tabId) ?? { revision: 0, lastDirty: null };
    st.revision++;
    st.lastDirty = { method, ts };
    this.pageState.set(tabId, st);
  }

  page(tabId: number): PageInfo {
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

  cacheEvent(tabId: number, ev: CachedEvent): void {
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
   */
  readEvents(
    tabId: number,
    { since = 0, filterRe = null }: { since?: number; filterRe?: RegExp | null } = {},
  ): { events: any[]; nextSeq: number; dropped: number; truncated: boolean } {
    const rb = this.events.get(tabId);
    if (!rb) return { events: [], nextSeq: 0, dropped: 0, truncated: false };
    return rb.readSince(since, filterRe ? (e) => filterRe.test(e.method) : undefined);
  }

  clearTabCache(tabId: number): void {
    this.events.delete(tabId);
    // The revision counts changes to a page we were watching. Detaching or
    // re-attaching ends that observation, so the count starts over rather than
    // letting a stale baseline look valid across the gap.
    this.pageState.delete(tabId);
    // Sessions die with the attachment; keeping them would hand out sessionIds
    // the browser has already invalidated.
    this.sessions.delete(tabId);
    // A snapshot is a picture of a page at one revision; drop it with the rest.
    this.snapshots.delete(tabId);
  }

  eventCount(): number {
    let n = 0;
    for (const rb of this.events.values()) n += rb.length;
    return n;
  }

  // ---- lifecycle ----

  /**
   * Fail every command belonging to one tab, leaving the other lanes running.
   */
  failTab(tabId: number, reason: string): void {
    const lane = this.lanes.get(tabId);
    if (!lane) return;
    const queued = lane.queue.splice(0);
    for (const e of queued)
      e.reject(httpError(409, reason, { code: "TAB_DETACHED", retriable: true }));
    for (const id of [...lane.inflight])
      this._settle(id, (w) =>
        w.reject(httpError(409, reason, { code: "TAB_DETACHED", retriable: true })),
      );
    this._reapLane(lane);
  }

  /** Reject every queued + in-flight command. Idempotent. */
  failAll(reason: string): void {
    // Drain the queues first: settling an in-flight command pumps its lane, and a
    // lane with work left would happily dispatch it down a connection we are in
    // the middle of tearing down.
    for (const lane of this.lanes.values()) {
      const queued = lane.queue.splice(0);
      for (const e of queued) e.reject(httpError(503, reason, { code: "EXT_DISCONNECTED" }));
    }
    for (const id of [...this.inflight.keys()])
      this._settle(id, (w) => w.reject(httpError(503, reason, { code: "EXT_DISCONNECTED" })));
    this.lanes.clear();
  }

  /** Actively close this connection. */
  close(code: number, reason: string): void {
    this.failAll(reason || "closed");
    try {
      this.ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  _handleClose(): void {
    if (this._closed) return;
    this._closed = true;
    this._log(`[${this.name}] disconnected`);
    this.failAll("ext disconnected");
    this._onClose(this);
  }
}
