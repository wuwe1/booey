#!/usr/bin/env node
import { Buffer } from "node:buffer";
// booey CLI — see ../docs/SPEC.md for protocol contract.
//
// Multi-browser: pick a target with --browser <id|label>. When exactly one
// browser is connected the flag is optional (the daemon auto-selects).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Two layouts: the repo (cli/ next to daemon/, .ts) and the published package
// (dist/cli/ next to dist/daemon/, .js). Probe rather than branch on a flag —
// there is nothing at runtime that reliably says which one we are in.
function firstExisting(...paths: string[]): string {
  return paths.find((p) => existsSync(p)) || paths[paths.length - 1]!;
}

const DAEMON_SCRIPT = firstExisting(
  resolve(__dirname, "..", "daemon", "server.ts"),
  resolve(__dirname, "..", "daemon", "server.js"),
);
// The extension is shipped verbatim (never compiled), so it sits at the package
// root — one level up from cli/, two from dist/cli/.
const EXTENSION_DIR = firstExisting(
  resolve(__dirname, "..", "extension"),
  resolve(__dirname, "..", "..", "extension"),
);
const DEFAULT_PORT = 9224; // match daemon/config.ts; 9223 is the legacy v1 relay

// ---- arg parse ----

function parseArgs(argv: string[]): { args: string[]; flags: Record<string, any> } {
  const args: string[] = [];
  const flags: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          // known boolean flags don't consume the next token
          if (a === "--await" || a === "--pretty") {
            flags[a.slice(2)] = true;
          } else {
            flags[a.slice(2)] = next;
            i++;
          }
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

const { args, flags } = parseArgs(process.argv.slice(2));
const PRETTY = !!flags.pretty;
const PORT = Number(flags.port || process.env.BOOEY_PORT || DEFAULT_PORT);
const BROWSER = flags.browser || process.env.BOOEY_BROWSER || "";
const PID_FILE = `/tmp/booey-${PORT}.pid`;
const LOG_FILE = `/tmp/booey-${PORT}.log`;

function out(obj: any): void {
  if (PRETTY) {
    console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  } else {
    console.log(typeof obj === "string" ? obj : JSON.stringify(obj));
  }
}

function fail(msg: string, code = 1): never {
  console.error("booey:", msg);
  process.exit(code);
}

// ---- browser selector threading ----

// Append ?browser= to a GET path (when a target is specified).
function browserQuery(extra = ""): string {
  const params: string[] = [];
  if (BROWSER) params.push(`browser=${encodeURIComponent(BROWSER)}`);
  if (extra) params.push(extra);
  return params.length ? "?" + params.join("&") : "";
}

// Add `browser` to a POST body (when a target is specified).
function withBrowser(body: any): any {
  return BROWSER ? { ...body, browser: BROWSER } : body;
}

// ---- HTTP client ----

async function api(path: string, opts: RequestInit = {}): Promise<{ status: number; body: any }> {
  const url = `http://127.0.0.1:${PORT}${path}`;
  let res: Response;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    fail(`daemon unreachable on :${PORT} (${(e as Error).message}). Try: booey daemon start`);
  }
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

async function get(path: string): Promise<{ status: number; body: any }> {
  return api(path, { method: "GET" });
}
async function post(path: string, body: any): Promise<{ status: number; body: any }> {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

function ensureOk(r: { status: number; body: any }, ctx: string): any {
  if (r.status >= 400) fail(`${ctx}: HTTP ${r.status} ${r.body?.error || ""}`);
  return r.body;
}

// ---- daemon control ----

async function daemonStatus() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/status`);
    if (!res.ok) throw new Error("not ok");
    const body = (await res.json()) as any;
    return { running: true, ...body };
  } catch {
    const pid = pidFromFile();
    if (pid && processAlive(pid)) {
      return { running: true, port: PORT, pid, note: "process alive but /status unreachable" };
    }
    return { running: false, port: PORT };
  }
}

function pidFromFile(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const n = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startDaemon() {
  const existing = pidFromFile();
  if (existing && processAlive(existing)) {
    fail(`daemon already running on :${PORT} (pid ${existing})`);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/status`);
    if (res.ok) fail(`port :${PORT} already serving (not our pid file?). Stop manually first.`);
  } catch {}

  const fd = await import("node:fs");
  const log = fd.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [DAEMON_SCRIPT, String(PORT)], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, BOOEY_PORT: String(PORT) },
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid), "utf8");
  for (let i = 0; i < 30; i++) {
    await sleep(50);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/status`);
      if (r.ok) return { ok: true, pid: child.pid, port: PORT, log: LOG_FILE };
    } catch {}
  }
  fail(`daemon spawned (pid ${child.pid}) but not responding on :${PORT}; check ${LOG_FILE}`);
}

async function stopDaemon() {
  let stopped = false;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/shutdown`, { method: "POST" });
    if (r.ok) stopped = true;
  } catch {}
  const pid = pidFromFile();
  if (pid && processAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
      stopped = true;
    } catch {}
    for (let i = 0; i < 20; i++) {
      if (!processAlive(pid)) break;
      await sleep(50);
    }
  }
  if (existsSync(PID_FILE)) {
    try {
      unlinkSync(PID_FILE);
    } catch {}
  }
  return { ok: true, stopped };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// The extension is plain JS and ships uncompiled, so its PROTOCOL_VERSION is
// only readable as source. Cheap, and it is the number that actually decides
// whether a browser can connect.
function bundledExtProtocol(): number | null {
  try {
    const src = readFileSync(resolve(EXTENSION_DIR, "background.js"), "utf8");
    const m = src.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function pkgVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(resolve(dirname(EXTENSION_DIR), "package.json"), "utf8"));
    return pkg.version || null;
  } catch {
    return null;
  }
}

// ---- subcommands ----

const cmds: Record<string, () => Promise<void>> = {
  async daemon() {
    const sub = args[1];
    if (sub === "start") return out(await startDaemon());
    if (sub === "stop") return out(await stopDaemon());
    if (sub === "status") return out(await daemonStatus());
    fail(`daemon: expected start|stop|status, got ${sub || "(nothing)"}`);
  },

  // Where the extension lives, so a user can point "Load unpacked" at it even
  // when the package sits somewhere inside node_modules.
  async ext() {
    const sub = args[1] || "path";
    if (sub === "path") return out(EXTENSION_DIR);
    if (sub === "zip") {
      const dest = resolve(String(args[2] || `booey-ext-${pkgVersion() || "dev"}.zip`));
      const { status, error } = spawnSync(
        "zip",
        ["-qr", dest, ".", "-x", ".*", "-x", "__MACOSX/*"],
        { cwd: EXTENSION_DIR, stdio: "inherit" },
      );
      if (error || status !== 0)
        fail(`ext zip: needs the \`zip\` command (${error?.message || `exit ${status}`})`);
      return out({ ok: true, zip: dest });
    }
    fail(`ext: expected path|zip, got ${sub}`);
  },

  // Version drift is this system's characteristic failure: the daemon updates
  // with npm, the extension only when a human reloads it. A mismatched ext is
  // closed with 4000 and stops reconnecting, which looks like "nothing happens".
  async doctor() {
    const bundled = bundledExtProtocol();
    const daemon = await daemonStatus();
    const problems: string[] = [];
    if (!daemon.running) {
      problems.push(`no daemon on :${PORT} — start it with \`booey daemon start\``);
    } else if (bundled !== null && daemon.version !== bundled) {
      problems.push(
        `daemon speaks protocol v${daemon.version} but the bundled extension speaks v${bundled} — ` +
          `reload ${EXTENSION_DIR} in every browser (chrome://extensions)`,
      );
    } else if (!daemon.browserCount) {
      problems.push(
        "daemon is up but no browser is connected — load the extension " +
          `(booey ext path) and check its popup. A protocol mismatch closes the socket ` +
          "with 4000 and the extension then stops retrying.",
      );
    }
    out({
      cli: { version: pkgVersion(), root: dirname(EXTENSION_DIR) },
      extension: { dir: EXTENSION_DIR, protocolVersion: bundled },
      daemon: { port: PORT, running: !!daemon.running, protocolVersion: daemon.version ?? null },
      browsers: (daemon.browsers || []).map((b: any) => ({
        id: b.id,
        label: b.label,
        tabCount: b.tabCount,
      })),
      problems,
    });
    if (problems.length) process.exitCode = 1;
  },

  async browsers() {
    const r = await get("/browsers");
    out(ensureOk(r, "browsers").browsers || []);
  },

  async tabs() {
    const r = await get("/tabs" + browserQuery());
    out(ensureOk(r, "tabs").tabs || []);
  },

  async attach() {
    const tabId = numArg(1, "tabId");
    const events = flags.events
      ? String(flags.events)
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined;
    const r = ensureOk(
      await post("/attach", withBrowser({ tabId, ...(events ? { events } : {}) })),
      "attach",
    );
    warnFailedDomains(r);
    out(r);
  },

  async events() {
    const sub = args[1];
    const tabId = numArg(2, "tabId");
    if (sub === "show") {
      out(ensureOk(await get(`/events/subscribe${browserQuery(`tabId=${tabId}`)}`), "events show"));
      return;
    }
    if (sub === "subscribe") {
      const spec = args[3];
      if (!spec)
        fail(
          "events subscribe: expected <selectors>, comma-separated (e.g. net,nav or 'Network.*')",
        );
      const list = spec
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const r = ensureOk(
        await post("/events/subscribe", withBrowser({ tabId, events: list })),
        "events subscribe",
      );
      warnFailedDomains(r);
      out(r);
      return;
    }
    fail(`events: expected show|subscribe, got ${sub || "(nothing)"}`);
  },

  async detach() {
    const tabId = numArg(1, "tabId");
    out(ensureOk(await post("/detach", withBrowser({ tabId })), "detach"));
  },

  async eval() {
    const tabId = numArg(1, "tabId");
    const expression = args[2];
    if (!expression) fail("eval: expected <js>");
    const r = await post(
      "/send",
      withBrowser({
        tabId,
        method: "Runtime.evaluate",
        params: {
          expression,
          awaitPromise: !!flags.await,
          returnByValue: true,
          generatePreview: true,
        },
      }),
    );
    const body = ensureOk(r, "eval");
    if (body.ok === false) {
      out({ ok: false, error: body.error });
      process.exitCode = 2;
      return;
    }
    const ex = body.result?.exceptionDetails;
    if (ex) {
      out({ ok: false, exception: ex.exception?.description || ex.text, stack: ex.stackTrace });
      process.exitCode = 2;
      return;
    }
    const val = body.result?.result;
    if (PRETTY) {
      console.log(formatEval(val));
    } else {
      out({ ok: true, value: val?.value, type: val?.type, description: val?.description });
    }
  },

  async net() {
    const tabId = numArg(1, "tabId");
    const sub = args[2];
    if (sub === "list") {
      // Nothing is captured retroactively. With no Network subscription this
      // would return an empty list that reads exactly like "the page made no
      // requests" — say which one it is.
      const subState = ensureOk(
        await get(`/events/subscribe${browserQuery(`tabId=${tabId}`)}`),
        "net list",
      );
      if (!((subState.events || []) as string[]).some((sel) => sel.startsWith("Network."))) {
        fail(
          `no Network subscription on tab ${tabId} — run \`booey attach ${tabId} --events net\` ` +
            "BEFORE the traffic you want to capture (subscriptions are not retroactive)",
        );
      }
      const parts = [`tabId=${tabId}`];
      if (flags.filter) parts.push(`filter=${encodeURIComponent(flags.filter)}`);
      if (flags.since) parts.push(`since=${encodeURIComponent(flags.since)}`);
      const body = ensureOk(await get(`/events${browserQuery(parts.join("&"))}`), "net list");
      const requests = aggregateRequests(body.events || []);
      if (body.truncated) {
        process.stderr.write(
          `warning: the event ring overwrote ${body.dropped} events on tab ${tabId} before this pull — the list below has holes\n`,
        );
      }
      out(
        PRETTY
          ? requests
          : { requests, nextSeq: body.nextSeq, dropped: body.dropped, truncated: body.truncated },
      );
      return;
    }
    if (sub === "body") {
      const requestId = args[3];
      if (!requestId) fail("net body: expected <requestId>");
      const r = await post(
        "/send",
        withBrowser({
          tabId,
          method: "Network.getResponseBody",
          params: { requestId },
        }),
      );
      const body = ensureOk(r, "net body");
      if (body.ok === false) {
        out({ ok: false, error: body.error });
        process.exitCode = 2;
        return;
      }
      const result = body.result || {};
      const decoded = result.base64Encoded
        ? Buffer.from(result.body || "", "base64").toString("utf8")
        : result.body || "";
      if (PRETTY) {
        console.log(decoded);
      } else {
        out({ ok: true, body: decoded, base64Encoded: !!result.base64Encoded });
      }
      return;
    }
    if (sub === "clear") {
      out(ensureOk(await post("/events/clear", withBrowser({ tabId })), "net clear"));
      return;
    }
    fail(`net: expected list|body|clear, got ${sub || "(nothing)"}`);
  },

  async screenshot() {
    const tabId = numArg(1, "tabId");
    const path = args[2] || `/tmp/booey-${Date.now()}.png`;
    const r = await post(
      "/send",
      withBrowser({
        tabId,
        method: "Page.captureScreenshot",
        params: {},
      }),
    );
    const body = ensureOk(r, "screenshot");
    if (body.ok === false) {
      out({ ok: false, error: body.error });
      process.exitCode = 2;
      return;
    }
    const data = body.result?.data;
    if (!data) fail("screenshot: no data in response");
    writeFileSync(path, Buffer.from(data, "base64"));
    out({ ok: true, path });
  },

  async nav() {
    const tabId = numArg(1, "tabId");
    const url = args[2];
    if (!url) fail("nav: expected <url>");
    const r = await post(
      "/send",
      withBrowser({
        tabId,
        method: "Page.navigate",
        params: { url },
      }),
    );
    out(ensureOk(r, "nav"));
  },

  async send() {
    const tabId = numArg(1, "tabId");
    const method = args[2];
    if (!method) fail("send: expected <Method>");
    let params = {};
    if (args[3]) {
      try {
        params = JSON.parse(args[3]);
      } catch (e) {
        fail(`send: invalid params JSON: ${(e as Error).message}`);
      }
    }
    const r = await post("/send", withBrowser({ tabId, method, params }));
    out(ensureOk(r, "send"));
  },

  async help() {
    printHelp();
  },
};

function numArg(i: number, name: string): number {
  const v = Number(args[i]);
  if (!Number.isFinite(v)) fail(`expected <${name}> as 1st arg`);
  return v;
}

/** Surface domains the browser refused to enable — usually a typo'd domain name. */
function warnFailedDomains(r: any): void {
  const failed = r?.result?.failed;
  if (!Array.isArray(failed) || failed.length === 0) return;
  for (const f of failed)
    process.stderr.write(`warning: could not enable ${f.domain} — ${f.message}\n`);
}

function aggregateRequests(events: any[]): any[] {
  const map = new Map();
  for (const ev of events) {
    const p = ev.params || {};
    const id = p.requestId;
    if (!id) continue;
    if (!map.has(id)) map.set(id, { requestId: id });
    const r = map.get(id);
    if (ev.method === "Network.requestWillBeSent") {
      r.method = p.request?.method;
      r.url = p.request?.url;
      r.type = p.type;
      r.ts = p.timestamp;
      r.t0 = ev.ts;
    } else if (ev.method === "Network.responseReceived") {
      r.status = p.response?.status;
      r.mimeType = p.response?.mimeType;
      r.statusText = p.response?.statusText;
    } else if (ev.method === "Network.loadingFinished") {
      r.encodedDataLength = p.encodedDataLength;
      r.t1 = ev.ts;
    } else if (ev.method === "Network.loadingFailed") {
      r.failed = p.errorText;
      r.t1 = ev.ts;
    }
  }
  return [...map.values()];
}

function formatEval(val: any): string {
  if (!val) return "(no result)";
  if (val.value !== undefined) {
    return typeof val.value === "object" ? JSON.stringify(val.value, null, 2) : String(val.value);
  }
  return val.description || val.type || "(unknown)";
}

function printHelp() {
  console.log(`booey — CDP via browser-extension relay (see docs/SPEC.md)

DAEMON
  booey daemon start [--port 9224]
  booey daemon stop
  booey daemon status

BROWSERS
  booey browsers                       # list connected browsers [{id, label, attached}]

TABS / ATTACH        (add --browser <id|label> when >1 browser is connected)
  booey tabs
  booey attach <tabId> [--events nav,net]     # default: nav (Page lifecycle)
  booey detach <tabId>
  booey events show <tabId>
  booey events subscribe <tabId> <selectors>  # presets: nav / net / console
                                                 # or "Domain.method" / "Domain.*"

INSPECT
  booey eval <tabId> <js> [--await]
  booey net <tabId> list [--filter <re>] [--since <seq>]
  booey net <tabId> body <requestId>
  booey net <tabId> clear
  booey screenshot <tabId> [<path>]
  booey nav <tabId> <url>

ESCAPE
  booey send <tabId> <Method> [<params-json>]

SETUP
  booey ext path                       # where to point chrome://extensions "Load unpacked"
  booey ext zip [<out.zip>]            # package extension/ for distribution
  booey doctor                         # daemon / extension / protocol-version check

GLOBAL
  --browser <id|label>   target browser (optional when only one is connected;
                         or env BOOEY_BROWSER)
  --port <N>             daemon port (default 9224; or env BOOEY_PORT)
  --pretty               pretty-print output (default JSON-line)
`);
}

// ---- dispatch ----

const cmd = args[0];
if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
  printHelp();
  process.exit(0);
}
if (!(cmd in cmds)) fail(`unknown command: ${cmd}. Try: booey help`);

cmds[cmd]!().catch((e) => fail((e as Error)?.message || String(e)));
