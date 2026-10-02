// booey daemon — embeddable factory. See ../docs/SPEC.md for the protocol.
//
// `createDaemon()` builds the whole daemon (HTTP router + /ext WS server +
// heartbeat) and returns a handle you can `close()`. It installs no signal
// handlers and never calls process.exit — that is the entry point's job
// (daemon/server.ts). A consumer that wants the daemon in-process (no separate
// node process) imports this directly:
//
//   import { createDaemon } from "@wuwe1/booey/daemon";
//   const d = await createDaemon({ port: 9224 });
//   // ... talk to 127.0.0.1:9224 over HTTP (e.g. via RelayClient) ...
//   await d.close();
//
// The HTTP layer is a thin router: resolve the target browser via the registry,
// delegate to its ExtConn, translate httpCode → response.

import http from "node:http";
import { WebSocketServer } from "ws";
import { DEFAULT_PORT, HEARTBEAT_MS, NO_DATA_TIMEOUT_MS, PROTOCOL_VERSION } from "./config.ts";
import { ExtConn } from "./ext-conn.ts";
import { httpError } from "./http-error.ts";
import { ExtRegistry } from "./registry.ts";

export interface DaemonOptions {
  /** TCP port to bind. Default `DEFAULT_PORT` (9224). */
  port?: number;
  /** Interface to bind. Default `127.0.0.1` (same-host trust; do not widen). */
  host?: string;
  /** Where diagnostics go. Default a timestamped console.error logger. */
  log?: (...args: any[]) => void;
  /**
   * What `POST /shutdown` does. The standalone entry passes `() => process.exit(0)`;
   * omitted (the embedded case) ⇒ `/shutdown` closes the daemon without touching
   * the host process.
   */
  onShutdown?: () => void;
}

export interface Daemon {
  registry: ExtRegistry;
  httpServer: http.Server;
  wss: WebSocketServer;
  port: number;
  /** Stop the heartbeat, close every ext connection, and free the port. */
  close(): Promise<void>;
}

function defaultLog(...args: any[]): void {
  console.error(`[booey ${new Date().toISOString()}]`, ...args);
}

/**
 * Build and start the daemon. Resolves once it is listening; rejects if the port
 * is taken (`EADDRINUSE`) or the socket otherwise fails to bind.
 */
export function createDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? "127.0.0.1";
  const log = opts.log ?? defaultLog;
  const registry = new ExtRegistry({ log });

  // ---- http helpers ----

  function readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const s = Buffer.concat(chunks).toString("utf8");
        if (!s) return resolve({});
        try {
          resolve(JSON.parse(s));
        } catch {
          reject(httpError(400, "invalid json body"));
        }
      });
      req.on("error", reject);
    });
  }

  function sendJson(res: http.ServerResponse, code: number, body: any): void {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function num(v: string | null): number {
    const n = Number(v);
    if (!Number.isFinite(n)) throw httpError(400, "tabId must be a number");
    return n;
  }

  function statusSnapshot() {
    const browsers = registry.list();
    return {
      port,
      version: PROTOCOL_VERSION,
      browserCount: browsers.length,
      browsers,
    };
  }

  // ---- routing ----

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const method = (req.method ?? "GET").toUpperCase();
    const path = url.pathname;

    // Endpoints that don't target a specific browser.
    if (method === "GET" && path === "/browsers")
      return sendJson(res, 200, { browsers: registry.list() });
    if (method === "GET" && path === "/status") return sendJson(res, 200, statusSnapshot());
    if (method === "POST" && path === "/shutdown") {
      sendJson(res, 200, { ok: true });
      // Let the response flush first. The standalone entry exits the process; the
      // embedded default just frees the port.
      setTimeout(() => (opts.onShutdown ?? (() => void close()))(), 50);
      return;
    }

    // GET endpoints take the browser selector from the query string.
    if (method === "GET" && path === "/tabs") {
      const conn = registry.resolve(url.searchParams.get("browser"));
      // fresh=0 reads the snapshot the ext pushes on every tabs-changed instead of
      // asking it again. Saves a round-trip on a hot path (find-the-tab runs before
      // basically everything), at the cost of being up to one debounce interval
      // stale — which for "is the site already open" is fine.
      if (url.searchParams.get("fresh") === "0") return sendJson(res, 200, { tabs: conn.tabs });
      const r = await conn.listTabs();
      return sendJson(res, 200, r.ok ? { tabs: conn.tabs } : r);
    }
    if (method === "GET" && path === "/events") {
      const conn = registry.resolve(url.searchParams.get("browser"));
      const tabId = num(url.searchParams.get("tabId"));
      const filter = url.searchParams.get("filter");
      const sinceRaw = url.searchParams.get("since");
      const since = sinceRaw == null || sinceRaw === "" ? 0 : num(sinceRaw);
      let re = null;
      if (filter) {
        try {
          re = new RegExp(filter);
        } catch (e) {
          throw httpError(400, "invalid filter regex: " + (e as Error).message);
        }
      }
      return sendJson(res, 200, conn.readEvents(tabId, { since, filterRe: re }));
    }
    if (method === "GET" && path === "/sessions") {
      const conn = registry.resolve(url.searchParams.get("browser"));
      const tabId = num(url.searchParams.get("tabId"));
      return sendJson(res, 200, { tabId, sessions: conn.sessionList(tabId) });
    }
    if (method === "GET" && path === "/page") {
      const conn = registry.resolve(url.searchParams.get("browser"));
      return sendJson(res, 200, conn.page(num(url.searchParams.get("tabId"))));
    }
    if (method === "GET" && path === "/snapshot") {
      const conn = registry.resolve(url.searchParams.get("browser"));
      return sendJson(res, 200, conn.snapshotRead(num(url.searchParams.get("tabId"))));
    }
    if (method === "GET" && path === "/events/subscribe") {
      const conn = registry.resolve(url.searchParams.get("browser"));
      const tabId = num(url.searchParams.get("tabId"));
      return sendJson(res, 200, { tabId, events: conn.subscription(tabId) });
    }

    // POST endpoints take the browser selector from the body.
    if (method === "POST") {
      const body = await readBody(req);
      if (path === "/attach") {
        const conn = registry.resolve(body.browser);
        return sendJson(
          res,
          200,
          await conn.attach(num(body.tabId), body.events ?? null, body.sessions === true),
        );
      }
      if (path === "/sessions/enable") {
        const conn = registry.resolve(body.browser);
        return sendJson(res, 200, await conn.enableSessions(num(body.tabId)));
      }
      if (path === "/open-tab") {
        const conn = registry.resolve(body.browser);
        const openUrl = String(body.url || "");
        if (!openUrl) throw httpError(400, "missing url");
        return sendJson(res, 200, await conn.openTab(openUrl));
      }
      if (path === "/events/subscribe") {
        const conn = registry.resolve(body.browser);
        if (!Array.isArray(body.events)) throw httpError(400, "events must be an array");
        return sendJson(res, 200, await conn.setEvents(num(body.tabId), body.events));
      }
      if (path === "/detach") {
        const conn = registry.resolve(body.browser);
        return sendJson(res, 200, await conn.detach(num(body.tabId)));
      }
      if (path === "/send") {
        const conn = registry.resolve(body.browser);
        const cdpMethod = String(body.method || "");
        if (!cdpMethod) throw httpError(400, "missing method");
        // `ordered` overrides the read/write classification in config.mjs: force a
        // read to take the tab exclusively, or let a caller that knows better
        // overlap something we default to serializing.
        const ordered = typeof body.ordered === "boolean" ? body.ordered : undefined;
        // Per-command timeout. The daemon-wide default is deliberately generous;
        // a caller that knows its command should be quick shouldn't have to wait
        // out a 30s budget to find out the page is wedged.
        const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
        return sendJson(
          res,
          200,
          await conn.sendCdp(num(body.tabId), cdpMethod, body.params, {
            ordered,
            timeoutMs,
            sessionId,
          }),
        );
      }
      if (path === "/events/clear") {
        const conn = registry.resolve(body.browser);
        conn.clearTabCache(num(body.tabId));
        return sendJson(res, 200, { ok: true });
      }
      if (path === "/snapshot") {
        const conn = registry.resolve(body.browser);
        return sendJson(res, 200, await conn.snapshot(num(body.tabId)));
      }
      if (path === "/act") {
        const conn = registry.resolve(body.browser);
        const tabId = num(body.tabId);
        if (!Array.isArray(body.actions)) throw httpError(400, "actions must be an array");
        const actions = conn.resolveActions(tabId, body.actions);
        return sendJson(res, 200, await conn.act(tabId, actions));
      }
    }

    return sendJson(res, 404, { error: "not found", code: "NOT_FOUND", retriable: false });
  }

  // ---- bootstrap ----

  const httpServer = http.createServer((req, res) => {
    handleHttp(req, res).catch((e) => {
      const status = e?.httpCode || 500;
      if (status === 500) log("unhandled http error:", e);
      try {
        // `error` stays a human-readable string — callers read that field and
        // reworded messages must not break them. `code`/`retriable` are additive,
        // and are what a caller should branch on instead of the message text.
        sendJson(res, status, {
          error: e?.message || String(e),
          code: e?.code || "INTERNAL",
          retriable: e?.retriable ?? false,
        });
      } catch {
        /* response already sent */
      }
    });
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ext" });

  wss.on("connection", (ws, req) => {
    const addr = req.socket.remoteAddress;
    if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") {
      log(`rejecting non-local ws from ${addr}`);
      ws.close(4001, "local only");
      return;
    }
    const conn = new ExtConn(ws, {
      onHello: (c) => registry.onHello(c),
      onClose: (c) => registry.remove(c),
      log,
    });
    registry.add(conn);
    log("ext connected (awaiting hello)");
  });

  // Heartbeat / liveness across all connections. unref so it never, on its own,
  // keeps an embedding host process alive.
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const conn of registry.conns) {
      if (now - conn.lastSeen > NO_DATA_TIMEOUT_MS) {
        log(`[${conn.name}] silent > ${NO_DATA_TIMEOUT_MS / 1000}s, closing`);
        conn.close(4003, "silent");
        continue;
      }
      try {
        conn.send({ type: "ping" });
      } catch {
        /* will be cleaned up on close */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  async function close(): Promise<void> {
    clearInterval(heartbeat);
    for (const conn of registry.conns) {
      try {
        conn.close(1001, "daemon closing");
      } catch {
        /* already gone */
      }
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
    // server.close() only stops accepting and then waits for existing sockets to
    // end on their own — an idle HTTP keep-alive (e.g. a fetch client's pooled
    // connection) would hold it open indefinitely. Force them shut so close()
    // reliably frees the port.
    httpServer.closeAllConnections?.();
    await closed;
  }

  return new Promise<Daemon>((resolve, reject) => {
    // Until it is listening, a bind failure (EADDRINUSE) is the caller's to
    // handle. The `ws` server re-emits the http server's bind error on the wss
    // instance too, so both sources must be covered or an unhandled 'error' event
    // crashes the process; `settled` dedupes the double-fire.
    let settled = false;
    const onEarlyError = (e: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      try {
        wss.close();
      } catch {
        /* nothing bound yet */
      }
      reject(e);
    };
    httpServer.once("error", onEarlyError);
    wss.once("error", onEarlyError);
    httpServer.listen(port, host, () => {
      if (settled) return;
      settled = true;
      httpServer.removeListener("error", onEarlyError);
      wss.removeListener("error", onEarlyError);
      httpServer.on("error", (e) => log("http server error:", e));
      wss.on("error", (e) => log("ws server error:", e));
      // Report the actual bound port — matters when the caller passed 0 (pick any
      // free port), which an embedder reasonably might.
      const addr = httpServer.address();
      const boundPort = addr && typeof addr === "object" ? addr.port : port;
      log(`daemon up :${boundPort} (ws path /ext), protocol v${PROTOCOL_VERSION}`);
      resolve({ registry, httpServer, wss, port: boundPort, close });
    });
  });
}
