// Compatibility gate: drives lilto's OWN client (test/fixtures/lilto-client.ts,
// a verbatim copy) against this daemon.
//
// lilto is the main consumer and is meant to point at this daemon with zero
// changes on its side — `LILTO_RELAY=http://127.0.0.1:<port>` and nothing else.
// The daemon has since moved from protocol v2 to v4; every one of those steps
// had to stay invisible from the other end of the HTTP surface. This file is
// what makes that claim checkable rather than aspirational.
//
//   node test/compat-lilto.mjs [port]
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isRelayConnectionFailure,
  PageJsError,
  RelayClient,
  RelayError,
} from "./fixtures/lilto-client.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || 9232);
const procs = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnNode(args, env) {
  const p = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ...env },
  });
  procs.push(p);
  return p;
}
const cleanup = () => {
  for (const p of procs) {
    try {
      p.kill("SIGKILL");
    } catch {}
  }
};

async function pollUntil(fn, tries = 100, gap = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await wait(gap);
  }
  return null;
}

let pass = 0,
  fail = 0;
const chk = (n, got, want) => {
  if (got === want) {
    console.log("PASS", n);
    pass++;
  } else {
    console.log(`FAIL ${n} — got [${got}] want [${want}]`);
    fail++;
  }
};
const chkc = (n, got, sub) => {
  if (String(got).includes(sub)) {
    console.log("PASS", n);
    pass++;
  } else {
    console.log(`FAIL ${n} — got [${got}] want contains [${sub}]`);
    fail++;
  }
};

try {
  spawnNode(["daemon/server.ts", String(PORT)]);
  // The mock ext has no reconnect: if it is spawned before the daemon is
  // listening it takes an ECONNREFUSED and exits. Wait for the port first.
  if (!(await pollUntil(async () => (await fetch(`http://127.0.0.1:${PORT}/status`)).ok))) {
    throw new Error("daemon never came up");
  }
  spawnNode(["daemon/test-mock-ext.ts", String(PORT), "browser-A", "shopee-A"]);

  const relay = new RelayClient({ base: `http://127.0.0.1:${PORT}`, browser: "shopee-A" });
  if (!(await pollUntil(async () => (await relay.browsers()).length === 1)))
    throw new Error("browser never registered");

  // --- discovery: the three tab paths lilto actually uses ---
  chk("browsers()", (await relay.browsers()).length, 1);

  // cachedTabs() must read the ext's pushed snapshot, NOT round-trip to the ext.
  // The mock returns an extra tab only via a real list-tabs, so the two paths are
  // distinguishable — check the cached one FIRST, before a live call refreshes it.
  const cached = await relay.cachedTabs();
  chk(
    "cachedTabs() does not round-trip to the ext",
    cached.some((t) => t.url === "mock://fresh-only"),
    false,
  );
  chk("cachedTabs() still returns the snapshot", cached.length >= 2, true);
  const fresh = await relay.tabs();
  chk(
    "tabs() does round-trip",
    fresh.some((t) => t.url === "mock://fresh-only"),
    true,
  );
  chk("findTab() by url regex", (await relay.findTab(/seller\.shopee\.tw/)).tabId, 1001);

  // --- the two CDP methods lilto uses, through its own wrappers ---
  await relay.attach(1001);
  chkc("eval()", await relay.eval(1001, "document.title"), "shopee-A (mock)");
  await relay.navigate(1001, "https://seller.shopee.tw/portal/product/list");
  chk("navigate() resolves", true, true);

  // evalFn is lilto's real primitive: a repo function shipped into the page.
  chkc("evalFn()", await relay.evalFn(1001, (a, b) => a + b, "x", "y"), "shopee-A (mock)");

  // --- open-tab: needed by openTab/findOrOpenTab, absent before this version ---
  const opened = await relay.openTab("https://example.com/probe");
  chkc("openTab() — /open-tab must exist", opened.url, "example.com/probe");
  chk(
    "findOrOpenTab() reuses the open one",
    (await relay.findOrOpenTab(/example\.com\/probe/, "https://example.com/probe")).tabId,
    opened.tabId,
  );

  // --- error contract: `error` must still be a plain string ---
  try {
    await relay.eval(9999, "1");
    chk("eval on unattached tab throws", false, true);
  } catch (e) {
    chk("...as RelayError", e instanceof RelayError, true);
    chkc("...with a readable message", e.message, "not attached");
    chk("...classified retriable-ish by lilto's own regex", isRelayConnectionFailure(e), true);
  }

  // Page JS exceptions stay a 200 + exceptionDetails, so lilto's own split
  // between RelayError and PageJsError keeps working.
  try {
    await relay.eval(1001, "THROW");
    chk("page exception throws", false, true);
  } catch (e) {
    chk("...as PageJsError, not RelayError", e instanceof PageJsError, true);
    chkc("...carrying the page's description", e.message, "mock page blew up");
  }

  // --- daemon down: the message lilto's connection-failure test keys on ---
  const dead = new RelayClient({ base: "http://127.0.0.1:9", timeoutMs: 500 });
  try {
    await dead.browsers();
    chk("unreachable daemon throws", false, true);
  } catch (e) {
    chk("...recognized as a connection failure", isRelayConnectionFailure(e), true);
  }

  console.log(`\n===== COMPAT PASS=${pass} FAIL=${fail} =====`);
} catch (e) {
  console.log("HARNESS ERROR:", e.message);
  fail++;
} finally {
  cleanup();
  await wait(100);
  process.exit(fail ? 1 : 0);
}
