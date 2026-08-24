// Shared daemon constants. See ../docs/SPEC.md for the protocol contract.

import { httpError } from "./http-error.mjs";

export const PROTOCOL_VERSION = 5; // bumped from 4: cdp commands may carry a sessionId (see SPEC.md)
export const DEFAULT_PORT = 9224; // 9223 is used by the legacy v1 relay in listo; keep them separate

/**
 * Parse a positive-finite number from the environment, falling back
 * on anything malformed. A bad value here is worse than no value: NaN would make
 * every command time out instantly, Infinity would make none of them ever time
 * out. Same defensive shape browser-use uses for BROWSER_USE_CDP_TIMEOUT_S.
 * @param {string} name @param {number} fallback
 */
function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[cdp-relay] ignoring ${name}=${JSON.stringify(raw)} (not a positive finite number); using ${fallback}`);
    return fallback;
  }
  return n;
}

export const CMD_TIMEOUT_MS = envNum("CDP_RELAY_CMD_TIMEOUT_MS", 30_000); // per-command in-flight timeout
export const HEARTBEAT_MS = 25_000;       // daemon→ext ping cadence (keeps MV3 SW alive)
export const NO_DATA_TIMEOUT_MS = 60_000; // close a conn that goes silent this long
export const EVENT_CACHE_CAP = envNum("CDP_RELAY_EVENT_CACHE_CAP", 1000); // per-(browser,tab) ring capacity
export const MAX_INFLIGHT_PER_TAB = 8;    // cap on concurrent unordered commands per tab

/**
 * CDP methods safe to run concurrently within one tab: pure reads with no focus,
 * input, or navigation semantics. Everything not listed here is treated as
 * ordered (serialized per tab), so the default is always the safe one.
 *
 * The payoff is real: a page model wants one Accessibility.getFullAXTree per
 * frame (browser-use fans these out with asyncio.gather), and serializing them
 * costs one full relay round-trip each.
 */
export const UNORDERED_CDP_METHODS = new Set([
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "Accessibility.getRootAXNode",
  "Accessibility.queryAXTree",
  "Browser.getVersion",
  "CSS.getComputedStyleForNode",
  "CSS.getInlineStylesForNode",
  "CSS.getMatchedStylesForNode",
  "DOM.describeNode",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.getDocument",
  "DOM.getFrameOwner",
  "DOM.getNodeForLocation",
  "DOM.getOuterHTML",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.resolveNode",
  "DOMSnapshot.captureSnapshot",
  "Network.getCookies",
  "Network.getRequestPostData",
  "Network.getResponseBody",
  "Page.captureScreenshot",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Page.getResourceTree",
  "Runtime.getProperties",
  "Target.getTargetInfo",
  "Target.getTargets",
]);

// ---- event subscriptions ----
//
// A selector is "Domain.method" or "Domain.*". Two levels come out of the same
// list and both matter:
//   - the DOMAINS to enable, which decides what Chrome bothers to generate
//   - the METHODS to forward, which decides what crosses the SW → daemon wire
//
// v3 and earlier enabled Network + Runtime + Page on every attach and forwarded
// every event. Runtime was the expensive one: it exists to deliver
// Runtime.consoleAPICalled (every console.log on the page, with object previews)
// and nothing in this project ever read it. Runtime.evaluate is a command and
// does not need the domain enabled.

/** Named recipes, so callers don't reach for "Domain.*". */
export const EVENT_PRESETS = {
  // Page lifecycle. Cheap, and the basis for knowing when a tab moved.
  nav: [
    "Page.frameNavigated",
    "Page.loadEventFired",
    "Page.domContentEventFired",
    "Page.javascriptDialogOpening",
  ],
  // Exactly the four the CLI's request aggregator consumes. Deliberately omits
  // Network.dataReceived, which fires per data chunk and is the single largest
  // source of event volume with no consumer.
  net: [
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Network.loadingFinished",
    "Network.loadingFailed",
  ],
  console: ["Runtime.consoleAPICalled", "Runtime.exceptionThrown"],
  // Document-level structure changes. Enabling DOM without calling
  // DOM.getDocument is cheap: CDP only reports child-node mutations for nodes it
  // has already handed out, so in practice this is just documentUpdated.
  dom: ["DOM.documentUpdated"],
};

/**
 * Events that mean "whatever you knew about this page's structure may be stale".
 *
 * Each one bumps the tab's revision (see ExtConn). A caller compares the
 * revision before and after an action; different means the page moved under it.
 *
 * Fidelity scales with the subscription: `nav` (the default) catches navigation
 * and load, `dom` adds document swaps. An unsubscribed event cannot bump
 * anything — the extension drops it before the daemon ever sees it — so a caller
 * that needs document-level precision has to ask for `dom`.
 *
 * Deliberately conservative: Page.frameNavigated fires for subframes too, and we
 * count those. A false "changed" costs one re-read; a false "unchanged" costs a
 * click on the wrong element.
 */
export const DIRTY_EVENT_METHODS = new Set([
  "DOM.documentUpdated",
  "Page.domContentEventFired",
  "Page.frameNavigated",
  "Page.loadEventFired",
  "Page.navigatedWithinDocument",
]);

/** What `attach` subscribes to when the caller says nothing. */
export const DEFAULT_EVENTS = ["nav"];

const SELECTOR_RE = /^[A-Za-z][A-Za-z0-9]*\.(\*|[A-Za-z][A-Za-z0-9]*)$/;

/**
 * Resolve preset names and validate selectors. Returns a sorted, de-duplicated
 * list. Throws on anything unrecognized rather than silently subscribing to
 * nothing — a typo'd selector that quietly matches no events is the worst
 * possible failure here, because it looks exactly like "the page did nothing".
 * @param {unknown} input
 * @returns {string[]}
 */
export function expandEventSelectors(input) {
  if (input == null) return expandEventSelectors(DEFAULT_EVENTS);
  if (!Array.isArray(input)) throw httpError(400, "events must be an array of selectors or preset names");
  const out = new Set();
  for (const raw of input) {
    if (typeof raw !== "string" || !raw) throw httpError(400, `bad event selector: ${JSON.stringify(raw)}`);
    const preset = EVENT_PRESETS[raw];
    if (preset) {
      for (const sel of preset) out.add(sel);
      continue;
    }
    if (!SELECTOR_RE.test(raw)) {
      throw httpError(
        400,
        `bad event selector ${JSON.stringify(raw)} — want "Domain.method", "Domain.*", or a preset (${Object.keys(EVENT_PRESETS).join(" / ")})`,
      );
    }
    out.add(raw);
  }
  return [...out].sort();
}

/** The CDP domains that must be enabled to produce these selectors. */
export function domainsForSelectors(selectors) {
  return [...new Set(selectors.map((s) => s.slice(0, s.indexOf("."))))].sort();
}
