// ExtRegistry — tracks all live ext connections and resolves a caller's
// browser selector (id | label | omitted) to a single ExtConn.
//
// Two collections:
//   - conns: every live connection, helloed or not (heartbeat iterates this)
//   - byId:  helloed connections keyed by their stable browserId
//
// Addressing rules (see resolve): omitted selector auto-picks when exactly one
// browser is connected; otherwise the caller must name one. Matches the
// chrome-devtools-mcp "optional sessionId, default-if-single" shape.

import type { ExtConn } from "./ext-conn.ts";
import { httpError } from "./http-error.ts";

export interface BrowserInfo {
  id: string;
  label: string;
  attached: number[];
  tabCount: number;
  inflight: number;
  subscriptions: Record<string, string[]>;
  stats: { matchedEvents: number; filteredEvents: number; droppedEvents: number } | null;
}

export class ExtRegistry {
  /** Every live connection, helloed or not (heartbeat iterates this). */
  conns: Set<ExtConn>;
  /** Helloed connections keyed by their stable browserId. */
  byId: Map<string, ExtConn>;
  log: (...args: any[]) => void;

  constructor({ log }: { log: (...args: any[]) => void }) {
    this.conns = new Set();
    this.byId = new Map();
    this.log = log;
  }

  /** Register a freshly-accepted (not-yet-helloed) connection. */
  add(conn: ExtConn): void {
    this.conns.add(conn);
  }

  /**
   * Called when a conn completes hello. Same-id reconnect kicks the stale conn
   * so a browser that drops + reconnects keeps its identity (no id drift).
   */
  onHello(conn: ExtConn): void {
    const existing = this.byId.get(conn.id!);
    if (existing && existing !== conn) {
      this.log(`replacing stale conn for browser ${conn.id} (${existing.label || "no label"})`);
      existing.close(4002, "replaced");
    }
    this.byId.set(conn.id!, conn);
  }

  /** Drop a connection from both collections. Idempotent. */
  remove(conn: ExtConn): void {
    this.conns.delete(conn);
    if (conn.id && this.byId.get(conn.id) === conn) this.byId.delete(conn.id);
  }

  /** Helloed connections. */
  ready(): ExtConn[] {
    return [...this.byId.values()];
  }

  /**
   * Resolve a selector to exactly one connected browser.
   * @param selector browserId, label, or empty
   * @throws 503 none / 404 unknown / 400 ambiguous
   */
  resolve(selector: string | null | undefined): ExtConn {
    const ready = this.ready();
    if (selector == null || selector === "") {
      if (ready.length === 1) return ready[0]!;
      if (ready.length === 0) throw httpError(503, "no browser connected", { code: "NO_BROWSER" });
      const names = ready.map((c) => c.label || c.id).join(", ");
      throw httpError(
        400,
        `${ready.length} browsers connected (${names}); specify browser=<id|label>`,
        { code: "AMBIGUOUS_BROWSER" },
      );
    }
    // Exact id wins.
    const byId = this.byId.get(selector);
    if (byId) return byId;
    // Otherwise match by label.
    const byLabel = ready.filter((c) => c.label === selector);
    if (byLabel.length === 1) return byLabel[0]!;
    if (byLabel.length > 1)
      throw httpError(
        400,
        `ambiguous label "${selector}" (${byLabel.length} matches); use the browser id`,
        { code: "AMBIGUOUS_BROWSER" },
      );
    throw httpError(404, `no browser matching "${selector}"`, { code: "UNKNOWN_BROWSER" });
  }

  /** Discovery view. */
  list(): BrowserInfo[] {
    return this.ready().map((c) => ({
      id: c.id!,
      label: c.label,
      attached: [...c.attachedTabs],
      tabCount: c.tabs.length,
      inflight: c.inflight.size, // concurrent commands right now; 0..n since v3
      subscriptions: Object.fromEntries(c.subscriptions),
      stats: c.stats, // ext-side event counters, refreshed on each pong
    }));
  }
}
