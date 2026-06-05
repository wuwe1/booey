// All-in-Node integration test: spawns the real daemon + two mock-ext processes
// and asserts multi-browser addressing / isolation / concurrency / reconnect.
//
//   npm test            # or: node test/integration.mjs [port]
//
// Uses setTimeout-based polling for readiness (no shell `sleep`).
import { spawn, execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || 9231);
const base = `http://127.0.0.1:${PORT}`;
const procs = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnNode(args) {
  const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] });
  procs.push(p);
  return p;
}
function cleanup() { for (const p of procs) { try { p.kill("SIGKILL"); } catch {} } }

async function pollUntil(fn, tries = 100, gap = 50) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch {}
    await wait(gap);
  }
  return null;
}
async function jget(path) { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; }
async function jpost(path, body) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

let pass = 0, fail = 0;
const chk = (n, got, want) => { if (got === want) { console.log("PASS", n); pass++; } else { console.log(`FAIL ${n} — got [${got}] want [${want}]`); fail++; } };
const chkc = (n, got, sub) => { if (String(got).includes(sub)) { console.log("PASS", n); pass++; } else { console.log(`FAIL ${n} — got [${got}] want contains [${sub}]`); fail++; } };
const cli = (...a) => execFileSync(process.execPath, ["cli/cdp-relay", "--port", String(PORT), ...a], { cwd: ROOT }).toString();

try {
  spawnNode(["daemon/server.mjs", String(PORT)]);
  if (!(await pollUntil(async () => (await jget("/status")).status === 200))) throw new Error("daemon never came up");

  spawnNode(["daemon/test-mock-ext.mjs", String(PORT), "browser-A", "shopee-A"]);
  spawnNode(["daemon/test-mock-ext.mjs", String(PORT), "browser-B", "shopee-B"]);
  if (!(await pollUntil(async () => (await jget("/browsers")).body.browsers.length === 2))) throw new Error("two browsers never registered");

  // discovery
  const browsers = (await jget("/browsers")).body.browsers;
  chk("browsers count=2", browsers.length, 2);
  chkc("has shopee-A", JSON.stringify(browsers), "shopee-A");
  chkc("has shopee-B", JSON.stringify(browsers), "shopee-B");

  // addressing (eval via /send requires attach first)
  await jpost("/attach", { browser: "shopee-A", tabId: 1001 });
  await jpost("/attach", { browser: "shopee-B", tabId: 1002 });
  const evalReq = (tabId, browser) => jpost("/send", { browser, tabId, method: "Runtime.evaluate", params: { expression: "x" } });
  chkc("eval A by label", (await evalReq(1001, "shopee-A")).body.result.result.value, "shopee-A (mock)");
  chkc("eval B by label", (await evalReq(1002, "shopee-B")).body.result.result.value, "shopee-B (mock)");
  chkc("eval A by id", (await evalReq(1001, "browser-A")).body.result.result.value, "shopee-A (mock)");

  // error codes
  const amb = await jpost("/send", { tabId: 1001, method: "Runtime.evaluate", params: {} });
  chk("ambiguous status 400", amb.status, 400);
  chkc("ambiguous msg", amb.body.error, "specify browser");
  chk("unknown status 404", (await jpost("/send", { browser: "nope", tabId: 1001, method: "Runtime.evaluate", params: {} })).status, 404);
  chk("not-attached status 409", (await jpost("/send", { browser: "shopee-B", tabId: 1001, method: "Page.reload", params: {} })).status, 409);

  // tabs per browser
  chkc("tabs A", JSON.stringify((await jget("/tabs?browser=shopee-A")).body.tabs), "shopee-A");
  chkc("tabs B", JSON.stringify((await jget("/tabs?browser=shopee-B")).body.tabs), "shopee-B");

  // event cache isolation
  await wait(350); // mock pushes events 200ms after attach
  chkc("A has REQ-001", JSON.stringify((await jget("/events?browser=shopee-A&tabId=1001")).body.events), "REQ-001");
  chk("B 1001 empty", (await jget("/events?browser=shopee-B&tabId=1001")).body.events.length, 0);

  // concurrency
  const [ra, rb] = await Promise.all([evalReq(1001, "shopee-A"), evalReq(1002, "shopee-B")]);
  chkc("parallel A", ra.body.result.result.value, "shopee-A (mock)");
  chkc("parallel B", rb.body.result.result.value, "shopee-B (mock)");

  // status
  const st = (await jget("/status")).body;
  chk("status browserCount", st.browserCount, 2);
  chk("status version", st.version, 2);

  // CLI layer
  chkc("CLI eval A", cli("eval", "1001", "x", "--browser", "shopee-A"), "shopee-A (mock)");
  chkc("CLI browsers lists B", cli("browsers"), "shopee-B");

  // same-id reconnect keeps identity (kicks stale, updates label)
  spawnNode(["daemon/test-mock-ext.mjs", String(PORT), "browser-A", "shopee-A-renamed"]);
  const renamed = await pollUntil(async () => {
    const bs = (await jget("/browsers")).body.browsers;
    return bs.length === 2 && bs.some((b) => b.label === "shopee-A-renamed") ? bs : null;
  });
  chk("still 2 after reconnect", renamed ? renamed.length : -1, 2);
  chkc("label updated", JSON.stringify(renamed || []), "shopee-A-renamed");

  console.log(`\n===== RESULT PASS=${pass} FAIL=${fail} =====`);
} catch (e) {
  console.log("HARNESS ERROR:", e.message);
  fail++;
} finally {
  cleanup();
  await wait(100);
  process.exit(fail ? 1 : 0);
}
