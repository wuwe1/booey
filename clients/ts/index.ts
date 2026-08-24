/**
 * cdp-relay typed client.
 *
 * The daemon's HTTP surface is the contract (see ../../docs/SPEC.md); this is
 * the supported way to speak it. It lives in this repo, not in each consumer,
 * so a protocol change updates the client in the same commit that breaks it.
 *
 *   caller ──HTTP──▶ daemon ──WS──▶ extension ──chrome.debugger──▶ tab
 *
 * Only the first hop is ours. The daemon binds 127.0.0.1 and has no auth
 * (same-host trust).
 *
 * The shape of this API is deliberately not "a CDP client". What a consumer
 * actually wants from an already-logged-in browser is: find the tab, run this
 * code in it, read what came back. `send()` is the escape hatch for the rest.
 */

// ---- errors ----

/**
 * Machine-readable failure classes. Branch on these, never on message text:
 * messages get reworded, and a caller that regex-matches them breaks silently
 * when they do.
 */
export type RelayErrorCode =
  | "NO_BROWSER" // nothing connected
  | "UNKNOWN_BROWSER" // selector matched no browser
  | "AMBIGUOUS_BROWSER" // selector needed, or matched several
  | "EXT_NOT_READY" // connected but pre-hello
  | "EXT_DISCONNECTED" // the browser went away mid-command
  | "TAB_NOT_ATTACHED" // attach before sending
  | "TAB_DETACHED" // the debugger was taken away (DevTools opened, tab closed)
  | "TIMEOUT" // no answer within the command budget
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "INTERNAL"
  | "DEBUGGER_ERROR" // chrome.debugger refused the command
  | "UNREACHABLE"; // the daemon itself isn't answering (client-side)

/** A transport / daemon / debugger failure. Distinct from a page-level error. */
export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly retriable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    code: RelayErrorCode = "INTERNAL",
    retriable = false,
    status?: number,
  ) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.retriable = retriable;
    this.status = status;
  }
}

/**
 * The page's own JavaScript threw. This is a business outcome, not an
 * infrastructure failure — the relay worked perfectly and the page said no.
 * Keeping the two apart is the difference between "retry" and "fix the script".
 */
export class PageJsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageJsError";
  }
}

const CONNECTION_CODES: ReadonlySet<string> = new Set([
  "UNREACHABLE",
  "NO_BROWSER",
  "UNKNOWN_BROWSER",
  "EXT_NOT_READY",
  "EXT_DISCONNECTED",
  "TAB_DETACHED",
  "TIMEOUT",
]);

/** True when the browser link is the problem, rather than the page or the call. */
export function isRelayConnectionFailure(error: unknown): boolean {
  return error instanceof RelayError && CONNECTION_CODES.has(error.code);
}

// ---- types ----

export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
}

export interface BrowserInfo {
  id: string;
  label: string;
  attached: number[];
  tabCount: number;
  inflight: number;
  subscriptions: Record<string, string[]>;
  stats: { matchedEvents: number; filteredEvents: number; droppedEvents: number } | null;
}

/** A preset name, or a raw `Domain.method` / `Domain.*` selector. */
export type EventSelector = "nav" | "net" | "console" | "dom" | "targets" | (string & {});

/** A flat auto-attached target: an out-of-process iframe, or a worker. */
export interface Session {
  /** The frame's current address. Reissued on reattach — do not persist it. */
  sessionId: string;
  /**
   * Names the same live frame across a reattach, so key in-flight state on this
   * rather than on sessionId. It does **not** survive the frame being destroyed:
   * a reload replaces the target and changes this too. Neither id is a durable
   * handle on "that iframe" across navigation.
   */
  targetId: string;
  type: string;
  url: string;
  openedAt: number;
}

export interface Subscription {
  /** The expanded selector list now in force. */
  events: string[];
  /** CDP domains actually enabled on the tab. */
  enabled: string[];
  /** Domains the browser refused — almost always a typo'd domain name. */
  failed: Array<{ domain: string; message: string }>;
  /** Present when attached with `sessions: true`. */
  sessions?: Session[];
}

export interface RelayEvent {
  seq: number;
  method: string;
  params: unknown;
  ts: number;
}

export interface PageState {
  tabId: number;
  attached: boolean;
  /** Monotonic; bumped by navigation / load / document-swap events. */
  revision: number;
  /** What bumped it last, or null if nothing has. */
  lastDirty: { method: string; ts: number } | null;
  /** Selectors in force — revision fidelity is bounded by this. */
  events: string[];
  url: string;
}

/** 一个合并后的元素节点（设计文档 §5.2 的 NodeRecord）。 */
export interface NodeRecord {
  /** `${frameOrdinal}-${backendNodeId}`，单次快照内的稳定地址。 */
  id: string;
  /** 父节点的 id；根元素为 null。 */
  parent: string | null;
  tag: string;
  /** AX role，无则空串。 */
  role: string;
  /** AX accessible name，无则空串。 */
  name: string;
  /** 白名单属性（id/class/type/aria-* 等）。 */
  attrs: Record<string, string>;
  /** [x, y, width, height]，来自 DOMSnapshot；无几何则为 null。 */
  rect: [number, number, number, number] | null;
  /** 可见（有几何，或 AX 非 ignored）。 */
  vis: boolean;
  /** 可交互（可见且 role 属于交互集合）。 */
  int: boolean;
  /** frame 内相对 XPath（兄弟序号，如 /html[1]/body[1]/button[1]）。 */
  xp: string;
  /** 稳定身份：跨快照/跨会话认出「同一个元素」。sha256 前 16 hex。 */
  elementHash: string;
  /** 只基于父分支路径（rootTag/.../selfTag）的哈希，用于结构指纹。 */
  parentBranchHash: string;
}

export interface Snapshot {
  revision: number;
  url: string;
  frames: Array<{ frameOrdinal: number; url: string }>;
  nodes: NodeRecord[];
}

export interface SnapshotState {
  tabId: number;
  snapshot: Snapshot;
  /** 页面在快照之后又动过（revision 前进）——手上的 index/xpath 可能已失效。 */
  stale: boolean;
}

export interface EventPage {
  events: RelayEvent[];
  /** Pass as `since` next time to read only what is new. */
  nextSeq: number;
  /** How many events the ring has overwritten on this tab, ever. */
  dropped: number;
  /** The ring ate events this reader had not seen. Holes, not silence. */
  truncated: boolean;
}

export interface RelayOptions {
  /** Daemon base URL. Default: $CDP_RELAY_URL, else http://127.0.0.1:9224 */
  base?: string;
  /** Target browser: its id or its label. Optional when only one is connected. */
  browser?: string;
  /** Client-side cap on a single HTTP request. Separate from the command budget. */
  timeoutMs?: number;
  /** Runs before every request. A lease holder can throw here to stop the call. */
  beforeRequest?: () => void;
}

// ---- client ----

const DEFAULT_BASE = "http://127.0.0.1:9224";

export class RelayClient {
  private readonly base: string;
  private readonly browser?: string;
  private readonly timeoutMs?: number;
  private readonly beforeRequest?: () => void;

  constructor(opts: RelayOptions = {}) {
    this.base = opts.base ?? process.env.CDP_RELAY_URL ?? DEFAULT_BASE;
    this.browser = opts.browser ?? process.env.CDP_RELAY_BROWSER ?? undefined;
    this.timeoutMs = opts.timeoutMs;
    this.beforeRequest = opts.beforeRequest;
  }

  /** The browser selector this client is pinned to, if any. */
  selector(): string | undefined {
    return this.browser;
  }

  private async req<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    this.beforeRequest?.();
    // The browser selector rides the query string on GET and the body on POST.
    let url = this.base + path;
    let payload = body;
    if (this.browser) {
      if (method === "GET")
        url += `${path.includes("?") ? "&" : "?"}browser=${encodeURIComponent(this.browser)}`;
      else payload = { browser: this.browser, ...body };
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: payload ? { "content-type": "application/json" } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
        signal: this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined,
      });
    } catch (e) {
      throw new RelayError(
        `daemon unreachable at ${this.base} (${(e as Error).message})`,
        "UNREACHABLE",
        true,
      );
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RelayError(
        `daemon ${res.status}: ${text.slice(0, 200)}`,
        "INTERNAL",
        false,
        res.status,
      );
    }
    if (!res.ok) {
      const e = json as { error?: string; code?: RelayErrorCode; retriable?: boolean };
      throw new RelayError(
        e.error ?? res.statusText,
        e.code ?? "INTERNAL",
        e.retriable ?? false,
        res.status,
      );
    }
    return json as T;
  }

  /** POST /send, unwrapping the ok:false business branch into a RelayError. */
  private async cdp<T>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    opts: { ordered?: boolean; timeoutMs?: number; sessionId?: string } = {},
  ): Promise<T> {
    const r = await this.req<
      { ok: true; result: T } | { ok: false; error: { message: string; code?: RelayErrorCode } }
    >("POST", "/send", {
      tabId,
      method,
      params: params ?? {},
      ...(opts.ordered === undefined ? {} : { ordered: opts.ordered }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
    });
    if (!r.ok)
      throw new RelayError(
        `${method}: ${r.error.message}`,
        r.error.code ?? "DEBUGGER_ERROR",
        false,
      );
    return r.result;
  }

  // ---- discovery ----

  async browsers(): Promise<BrowserInfo[]> {
    return (await this.req<{ browsers: BrowserInfo[] }>("GET", "/browsers")).browsers;
  }

  /**
   * @param opts.fresh false reads the snapshot the extension pushes on every tab
   *   change instead of round-tripping to it. Up to one debounce interval stale,
   *   one fewer round-trip — the right default for "is the site already open".
   */
  async tabs(opts: { fresh?: boolean } = {}): Promise<TabInfo[]> {
    const path = opts.fresh === false ? "/tabs?fresh=0" : "/tabs";
    return (await this.req<{ tabs: TabInfo[] }>("GET", path)).tabs;
  }

  /** First tab whose URL matches. Checks the pushed snapshot before asking. */
  async findTab(urlRe: RegExp): Promise<TabInfo> {
    const cached = await this.tabs({ fresh: false });
    const hit = cached.find((t) => urlRe.test(t.url));
    if (hit) return hit;
    // Not in the snapshot: a tab opened moments ago may not have been pushed yet.
    const fresh = await this.tabs();
    const freshHit = fresh.find((t) => urlRe.test(t.url));
    if (!freshHit)
      throw new RelayError(
        `no tab matching ${urlRe} — open the site and log in first`,
        "NOT_FOUND",
        false,
      );
    return freshHit;
  }

  /**
   * Open a tab in the background.
   *
   * Goes through the extension's chrome.tabs.create, not a page's window.open:
   * Chrome foregrounds anything opened by a user gesture, which interrupts
   * whoever is using the browser. The new tab inherits the profile's cookies —
   * that is why "already logged in" survives.
   */
  async openTab(url: string, opts: { timeoutMs?: number } = {}): Promise<TabInfo> {
    const r = await this.req<{ ok: true; result: { tab: TabInfo } }>("POST", "/open-tab", { url });
    const tab = r.result?.tab;
    if (!tab) throw new RelayError(`open-tab returned no tab for ${url}`, "INTERNAL", false);

    // chrome.tabs.create returns before navigation, so the URL is usually still
    // blank at this instant. Wait for the extension to report the real one.
    const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      const seen = (await this.tabs()).find((t) => t.tabId === tab.tabId);
      if (seen?.url && seen.url !== "about:blank") return seen;
      if (!seen)
        throw new RelayError(
          `tab ${tab.tabId} vanished right after opening ${url}`,
          "NOT_FOUND",
          false,
        );
      await sleep(300);
    }
    return tab;
  }

  async findOrOpenTab(urlRe: RegExp, openUrl: string): Promise<TabInfo> {
    try {
      return await this.findTab(urlRe);
    } catch {
      return await this.openTab(openUrl);
    }
  }

  // ---- attachment ----

  /**
   * Attach the debugger and set the tab's event subscription.
   *
   * Subscriptions are **not retroactive** — subscribe before the traffic you
   * want to see. Default is `nav` (page lifecycle only); ask for `net` if you
   * intend to read requests.
   */
  async attach(
    tabId: number,
    opts: { events?: EventSelector[]; sessions?: boolean } = {},
  ): Promise<Subscription> {
    const r = await this.req<{ ok: true; result: Subscription }>("POST", "/attach", {
      tabId,
      ...(opts.events ? { events: opts.events } : {}),
      ...(opts.sessions ? { sessions: true } : {}),
    });
    return r.result;
  }

  /**
   * Out-of-process iframes and workers attached to this tab.
   *
   * A tab-scoped attachment cannot see inside a cross-**site** iframe — Chrome
   * puts it in its own process, and `DOM.getDocument` on the tab returns the host
   * page only. Pass the `sessionId` from here to `send()` to reach inside it.
   *
   * Note cross-*origin* is not enough: site isolation works on scheme + eTLD+1,
   * so `a.example.com` inside `example.com` stays in the same process and never
   * shows up here. Its content is already in the tab's own DOM tree.
   *
   * Requires having attached with `sessions: true` (or calling
   * `enableSessions`); otherwise this is always empty.
   */
  async sessions(tabId: number): Promise<Session[]> {
    return (await this.req<{ sessions: Session[] }>("GET", `/sessions?tabId=${tabId}`)).sessions;
  }

  /** Turn on flat auto-attach for an already-attached tab. Idempotent. */
  async enableSessions(tabId: number): Promise<Session[]> {
    const r = await this.req<{ ok: true; result: { sessions: Session[] } }>(
      "POST",
      "/sessions/enable",
      { tabId },
    );
    return r.result.sessions;
  }

  async detach(tabId: number): Promise<void> {
    await this.req("POST", "/detach", { tabId });
  }

  // ---- running code in the page ----

  /**
   * Evaluate an expression in the page's MAIN world and return its value.
   *
   * chrome.debugger's Runtime.evaluate is privileged: it ignores the page's CSP.
   * That is the reason this whole design exists rather than content-script
   * injection.
   *
   * A page-level exception raises PageJsError; anything else raises RelayError.
   */
  async eval<T>(
    tabId: number,
    expression: string,
    opts: { awaitPromise?: boolean; userGesture?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const result = await this.cdp<{
      result?: { value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(
      tabId,
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: opts.awaitPromise ?? false,
        userGesture: opts.userGesture ?? false,
      },
      { timeoutMs: opts.timeoutMs },
    );
    const ex = result.exceptionDetails;
    if (ex) throw new PageJsError(ex.exception?.description ?? ex.text);
    return result.result?.value as T;
  }

  /**
   * Ship a function from your own source into the page and call it there.
   *
   * `fn.toString()` is the mechanism, so **fn must be self-contained**: imports,
   * module constants, and closure variables are all free variables once it lands
   * in the page, and become ReferenceErrors. Pass everything through `args`,
   * which are JSON-serialized into the call.
   *
   * (Technique borrowed from lilto's client, where it is the primary primitive.)
   */
  async evalFn<A extends readonly unknown[], R>(
    tabId: number,
    fn: (...args: A) => R,
    ...args: A
  ): Promise<Awaited<R>> {
    const call = `(${fn.toString()})(${args.map((a) => JSON.stringify(a) ?? "undefined").join(",")})`;
    // Whether fn returns a promise can't be decided statically, so always await;
    // awaitPromise is a no-op for a plain value.
    return await this.eval<Awaited<R>>(tabId, call, { awaitPromise: true });
  }

  /**
   * Navigate via CDP rather than by setting location.href in the old page.
   * Page.navigate does not need the page's main thread, which matters when the
   * page you are leaving is the one that is wedged. Does not wait for load.
   */
  async navigate(tabId: number, url: string): Promise<void> {
    const r = await this.cdp<{ errorText?: string }>(tabId, "Page.navigate", { url });
    if (r.errorText) throw new RelayError(`Page.navigate: ${r.errorText}`, "DEBUGGER_ERROR", false);
  }

  /** PNG bytes, base64-decoded. */
  async screenshot(tabId: number): Promise<Uint8Array> {
    const r = await this.cdp<{ data: string }>(tabId, "Page.captureScreenshot");
    return Uint8Array.from(Buffer.from(r.data, "base64"));
  }

  // ---- events ----

  /** Replace the tab's subscription. Last writer wins; there is no refcounting. */
  async subscribe(tabId: number, events: EventSelector[]): Promise<Subscription> {
    const r = await this.req<{ ok: true; result: Subscription }>("POST", "/events/subscribe", {
      tabId,
      events,
    });
    return r.result;
  }

  async subscription(tabId: number): Promise<string[]> {
    return (await this.req<{ events: string[] }>("GET", `/events/subscribe?tabId=${tabId}`)).events;
  }

  /**
   * Read cached events. Pass the previous page's `nextSeq` as `since` to get
   * only what is new. **Check `truncated`** — it is the only thing separating
   * "nothing happened" from "the ring overwrote it before you looked".
   */
  async readEvents(
    tabId: number,
    opts: { since?: number; filter?: string | RegExp } = {},
  ): Promise<EventPage> {
    const parts = [`tabId=${tabId}`];
    if (opts.since) parts.push(`since=${opts.since}`);
    if (opts.filter) {
      const re = typeof opts.filter === "string" ? opts.filter : opts.filter.source;
      parts.push(`filter=${encodeURIComponent(re)}`);
    }
    return await this.req<EventPage>("GET", `/events?${parts.join("&")}`);
  }

  async clearEvents(tabId: number): Promise<void> {
    await this.req("POST", "/events/clear", { tabId });
  }

  // ---- page revision ----

  /**
   * What the daemon knows about this tab's structural state.
   *
   * `revision` is the useful field: read it before an action and after, and a
   * change means the page moved underneath you. That is the difference between
   * "the click did nothing" and "the click opened a dialog and every index you
   * were holding is now wrong".
   *
   * Fidelity is bounded by the subscription: the default `nav` catches
   * navigation and load; add `dom` to catch document swaps.
   */
  async page(tabId: number): Promise<PageState> {
    return await this.req<PageState>("GET", `/page?tabId=${tabId}`);
  }

  async revision(tabId: number): Promise<number> {
    return (await this.page(tabId)).revision;
  }

  /**
   * 合并三棵 CDP 树（DOM + Accessibility + DOMSnapshot）成一份页面快照。
   *
   * `nodes` 是扁平的 NodeRecord，`id` 是 `${frameOrdinal}-${backendNodeId}`，
   * `xp` 是兄弟序号 XPath。这是 L2 页面模型的数据管线（设计文档里程碑 C）。
   * 每次 POST 都重新取树并缓存到 daemon。
   */
  async snapshot(tabId: number): Promise<Snapshot> {
    const r = await this.req<{ ok: true; result: Snapshot }>("POST", "/snapshot", { tabId });
    return r.result;
  }

  /** 读 daemon 缓存的快照（不重新取树）。`stale` = 页面在快照后又动过。 */
  async snapshotRead(tabId: number): Promise<SnapshotState> {
    return await this.req<SnapshotState>("GET", `/snapshot?tabId=${tabId}`);
  }

  /**
   * Wait until the page stops changing — no dirtying event for `quietMs`.
   *
   * This is the honest version of `sleep(3000)` after a click. It watches CDP
   * events, which come from the browser process, so it keeps working in a
   * background tab where page timers are throttled to death and any in-page
   * polling would stall.
   *
   * Returns `quiet: false` if `timeoutMs` ran out while the page was still
   * churning — a page that never settles is a real answer, not an error.
   */
  async settled(
    tabId: number,
    opts: { quietMs?: number; timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ revision: number; quiet: boolean }> {
    const quietMs = opts.quietMs ?? 500;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const pollMs = opts.pollMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let last = await this.revision(tabId);
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const current = await this.revision(tabId);
      if (current !== last) {
        last = current;
        lastChange = Date.now();
        continue;
      }
      if (Date.now() - lastChange >= quietMs) return { revision: last, quiet: true };
    }
    return { revision: last, quiet: false };
  }

  // ---- escape hatch ----

  /**
   * Send any CDP command. Everything above is a shortcut over this.
   *
   * @param opts.ordered take the tab exclusively (default: decided by method —
   *   pure reads overlap, everything else serializes)
   * @param opts.timeoutMs override the daemon's command budget for this one call
   * @param opts.sessionId address a flat auto-attached session (an out-of-process
   *   iframe or a worker) instead of the tab's own session. Get one from a
   *   Target.attachedToTarget event after Target.setAutoAttach({flatten:true}).
   */
  async send<T = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    opts: { ordered?: boolean; timeoutMs?: number; sessionId?: string } = {},
  ): Promise<T> {
    return await this.cdp<T>(tabId, method, params, opts);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
