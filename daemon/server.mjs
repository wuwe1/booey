// cdp-relay daemon — multi-browser. See ../docs/SPEC.md for the protocol.
//
// One HTTP server + one WS server (path /ext) on the same port. Each browser
// extension opens its own /ext WS and is wrapped in an ExtConn; the registry
// addresses them by id/label. The HTTP layer here is a thin router: resolve the
// target browser, delegate to its ExtConn, translate httpCode → response.

import http from "node:http";
import { WebSocketServer } from "ws";
import { ExtConn } from "./ext-conn.mjs";
import { ExtRegistry } from "./registry.mjs";
import { httpError } from "./http-error.mjs";
import { PROTOCOL_VERSION, DEFAULT_PORT, HEARTBEAT_MS, NO_DATA_TIMEOUT_MS } from "./config.mjs";

const PORT = Number(process.env.CDP_RELAY_PORT || process.argv[2] || DEFAULT_PORT);

function log(...args) {
  console.error(`[cdp-relay ${new Date().toISOString()}]`, ...args);
}

const registry = new ExtRegistry({ log });

// ---- http helpers ----

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
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

function sendJson(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw httpError(400, "tabId must be a number");
  return n;
}

function statusSnapshot() {
  const browsers = registry.list();
  return {
    port: PORT,
    version: PROTOCOL_VERSION,
    browserCount: browsers.length,
    browsers,
  };
}

// ---- routing ----

async function handleHttp(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method.toUpperCase();
  const path = url.pathname;

  // Endpoints that don't target a specific browser.
  if (method === "GET" && path === "/browsers") return sendJson(res, 200, { browsers: registry.list() });
  if (method === "GET" && path === "/status") return sendJson(res, 200, statusSnapshot());
  if (method === "POST" && path === "/shutdown") {
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 50); // let the response flush first
    return;
  }

  // GET endpoints take the browser selector from the query string.
  if (method === "GET" && path === "/tabs") {
    const conn = registry.resolve(url.searchParams.get("browser"));
    const r = await conn.listTabs();
    return sendJson(res, 200, r.ok ? { tabs: conn.tabs } : r);
  }
  if (method === "GET" && path === "/events") {
    const conn = registry.resolve(url.searchParams.get("browser"));
    const tabId = num(url.searchParams.get("tabId"));
    const filter = url.searchParams.get("filter");
    let re = null;
    if (filter) {
      try {
        re = new RegExp(filter);
      } catch (e) {
        throw httpError(400, "invalid filter regex: " + e.message);
      }
    }
    return sendJson(res, 200, { events: conn.getEvents(tabId, re) });
  }

  // POST endpoints take the browser selector from the body.
  if (method === "POST") {
    const body = await readBody(req);
    if (path === "/attach") {
      const conn = registry.resolve(body.browser);
      return sendJson(res, 200, await conn.attach(num(body.tabId)));
    }
    if (path === "/detach") {
      const conn = registry.resolve(body.browser);
      return sendJson(res, 200, await conn.detach(num(body.tabId)));
    }
    if (path === "/send") {
      const conn = registry.resolve(body.browser);
      const cdpMethod = String(body.method || "");
      if (!cdpMethod) throw httpError(400, "missing method");
      return sendJson(res, 200, await conn.sendCdp(num(body.tabId), cdpMethod, body.params));
    }
    if (path === "/events/clear") {
      const conn = registry.resolve(body.browser);
      conn.clearTabCache(num(body.tabId));
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: "not found" });
}

// ---- bootstrap ----

const httpServer = http.createServer((req, res) => {
  handleHttp(req, res).catch((e) => {
    const code = e?.httpCode || 500;
    if (code === 500) log("unhandled http error:", e);
    try {
      sendJson(res, code, { error: e?.message || String(e) });
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

// Heartbeat / liveness across all connections.
setInterval(() => {
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

httpServer.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    log(`port ${PORT} already in use`);
    process.exit(1);
  }
  log("http server error:", e);
});

httpServer.listen(PORT, "127.0.0.1", () => {
  log(`daemon up :${PORT} (ws path /ext), protocol v${PROTOCOL_VERSION}`);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
