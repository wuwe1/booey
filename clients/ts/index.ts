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
  | "NO_BROWSER"          // nothing connected
  | "UNKNOWN_BROWSER"     // selector matched no browser
  | "AMBIGUOUS_BROWSER"   // selector needed, or matched several
  | "EXT_NOT_READY"       // connected but pre-hello
  | "EXT_DISCONNECTED"    // the browser went away mid-command
  | "TAB_NOT_ATTACHED"    // attach before sending
  | "TAB_DETACHED"        // the debugger was taken away (DevTools opened, tab closed)
  | "TIMEOUT"             // no answer within the command budget
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "INTERNAL"
  | "DEBUGGER_ERROR"      // chrome.debugger refused the command
  | "UNREACHABLE";        // the daemon itself isn't answering (client-side)

/** A transport / daemon / debugger failure. Distinct from a page-level error. */
export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly retriable: boolean;
  readonly status?: number;

  constructor(message: string, code: RelayErrorCode = "INTERNAL", retriable = false, status?: number) {
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
export type EventSelector = "nav" | "net" | "console" | (string & {});

export interface Subscription {
  /** The expanded selector list now in force. */
  events: string[];
  /** CDP domains actually enabled on the tab. */
  enabled: string[];
  /** Domains the browser refused — almost always a typo'd domain name. */
  failed: Array<{ domain: string; message: string }>;
}

export interface RelayEvent {
  seq: number;
  method: string;
  params: unknown;
  ts: number;
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

  private async req<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    this.beforeRequest?.();
    // The browser selector rides the query string on GET and the body on POST.
    let url = this.base + path;
    let payload = body;
    if (this.browser) {
      if (method === "GET") url += `${path.includes("?") ? "&" : "?"}browser=${encodeURIComponent(this.browser)}`;
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
      throw new RelayError(`daemon ${res.status}: ${text.slice(0, 200)}`, "INTERNAL", false, res.status);
    }
    if (!res.ok) {
      const e = json as { error?: string; code?: RelayErrorCode; retriable?: boolean };
      throw new RelayError(e.error ?? res.statusText, e.code ?? "INTERNAL", e.retriable ?? false, res.status);
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
    if (!r.ok) throw new RelayError(`${method}: ${r.error.message}`, r.error.code ?? "DEBUGGER_ERROR", false);
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
    if (!freshHit) throw new RelayError(`no tab matching ${urlRe} — open the site and log in first`, "NOT_FOUND", false);
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
      if (!seen) throw new RelayError(`tab ${tab.tabId} vanished right after opening ${url}`, "NOT_FOUND", false);
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
  async attach(tabId: number, opts: { events?: EventSelector[] } = {}): Promise<Subscription> {
    const r = await this.req<{ ok: true; result: Subscription }>("POST", "/attach", {
      tabId,
      ...(opts.events ? { events: opts.events } : {}),
    });
    return r.result;
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
    const r = await this.req<{ ok: true; result: Subscription }>("POST", "/events/subscribe", { tabId, events });
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
  async readEvents(tabId: number, opts: { since?: number; filter?: string | RegExp } = {}): Promise<EventPage> {
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
