// All-in-Node integration test: spawns the real daemon + two mock-ext processes
// and asserts multi-browser addressing / isolation / concurrency / reconnect.
//
//   npm test            # or: node test/integration.mjs [port]
//
// Uses setTimeout-based polling for readiness (no shell `sleep`).
import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || 9231);
const base = `http://127.0.0.1:${PORT}`;
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
function cleanup() {
  for (const p of procs) {
    try {
      p.kill("SIGKILL");
    } catch {}
  }
}

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
async function jget(path) {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json() };
}
async function jpost(path, body) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
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
const cli = (...a) =>
  execFileSync(process.execPath, ["cli/cdp-relay", "--port", String(PORT), ...a], {
    cwd: ROOT,
  }).toString();

try {
  // CMD_TIMEOUT_MS is shortened so the "daemon gave up on a command" path is
  // reachable inside a test run. Every other command here answers instantly.
  // CMD_TIMEOUT_MS is shortened so the "daemon gave up on a command" path is
  // reachable inside a test run; the cache is shrunk so ring truncation is too.
  spawnNode(["daemon/server.mjs", String(PORT)], {
    CDP_RELAY_CMD_TIMEOUT_MS: "500",
    CDP_RELAY_EVENT_CACHE_CAP: "4",
  });
  if (!(await pollUntil(async () => (await jget("/status")).status === 200)))
    throw new Error("daemon never came up");

  spawnNode(["daemon/test-mock-ext.mjs", String(PORT), "browser-A", "shopee-A"]);
  spawnNode(["daemon/test-mock-ext.mjs", String(PORT), "browser-B", "shopee-B"]);
  if (!(await pollUntil(async () => (await jget("/browsers")).body.browsers.length === 2)))
    throw new Error("two browsers never registered");

  // discovery
  const browsers = (await jget("/browsers")).body.browsers;
  chk("browsers count=2", browsers.length, 2);
  chkc("has shopee-A", JSON.stringify(browsers), "shopee-A");
  chkc("has shopee-B", JSON.stringify(browsers), "shopee-B");

  // addressing (eval via /send requires attach first)
  await jpost("/attach", { browser: "shopee-A", tabId: 1001, events: ["net"] });
  await jpost("/attach", { browser: "shopee-B", tabId: 1002 });
  const evalReq = (tabId, browser) =>
    jpost("/send", { browser, tabId, method: "Runtime.evaluate", params: { expression: "x" } });
  chkc(
    "eval A by label",
    (await evalReq(1001, "shopee-A")).body.result.result.value,
    "shopee-A (mock)",
  );
  chkc(
    "eval B by label",
    (await evalReq(1002, "shopee-B")).body.result.result.value,
    "shopee-B (mock)",
  );
  chkc(
    "eval A by id",
    (await evalReq(1001, "browser-A")).body.result.result.value,
    "shopee-A (mock)",
  );

  // error codes
  const amb = await jpost("/send", { tabId: 1001, method: "Runtime.evaluate", params: {} });
  chk("ambiguous status 400", amb.status, 400);
  chkc("ambiguous msg", amb.body.error, "specify browser");
  chk(
    "unknown status 404",
    (await jpost("/send", { browser: "nope", tabId: 1001, method: "Runtime.evaluate", params: {} }))
      .status,
    404,
  );
  chk(
    "not-attached status 409",
    (await jpost("/send", { browser: "shopee-B", tabId: 1001, method: "Page.reload", params: {} }))
      .status,
    409,
  );

  // tabs per browser
  chkc("tabs A", JSON.stringify((await jget("/tabs?browser=shopee-A")).body.tabs), "shopee-A");
  chkc("tabs B", JSON.stringify((await jget("/tabs?browser=shopee-B")).body.tabs), "shopee-B");

  // event cache isolation
  await wait(350); // mock pushes events 200ms after attach
  const evA = (await jget("/events?browser=shopee-A&tabId=1001")).body;
  chkc("A has REQ-001", JSON.stringify(evA.events), "REQ-001");
  chk("B 1001 empty", (await jget("/events?browser=shopee-B&tabId=1001")).body.events.length, 0);

  // ---- v4: event subscriptions ----

  // Subscribed to `net` — the 3 aggregator methods arrive...
  chk("net preset delivers 3 events", evA.events.length, 3);
  // ...and Network.dataReceived, which no preset covers, is dropped at the ext.
  chk(
    "unsubscribed method never crosses the wire",
    JSON.stringify(evA.events).includes("dataReceived"),
    false,
  );
  // Page.loadEventFired is not in `net` either, so it is absent too.
  chk(
    "only subscribed domains delivered",
    JSON.stringify(evA.events).includes("loadEventFired"),
    false,
  );

  // Default subscription is `nav`: attaching without asking gets no Network at all.
  await jpost("/attach", { browser: "shopee-B", tabId: 1001 });
  await wait(350);
  const defB = (await jget("/events?browser=shopee-B&tabId=1001")).body;
  chk("default attach yields Page lifecycle only", defB.events.length, 1);
  chkc("...and it is loadEventFired", JSON.stringify(defB.events), "loadEventFired");
  chk(
    "default subscription is nav",
    JSON.stringify(
      (await jget("/events/subscribe?browser=shopee-B&tabId=1001")).body.events,
    ).includes("Network."),
    false,
  );

  // Bad selectors are rejected loudly rather than subscribing to nothing.
  const badSel = await jpost("/events/subscribe", {
    browser: "shopee-B",
    tabId: 1001,
    events: ["bogus-preset"],
  });
  chk("bad selector status 400", badSel.status, 400);
  chkc("bad selector message names the presets", badSel.body.error, "preset");

  // A well-shaped but nonexistent domain can only be caught by the browser.
  const badDom = await jpost("/events/subscribe", {
    browser: "shopee-B",
    tabId: 1001,
    events: ["Bogus.*"],
  });
  chkc("unknown domain reported as failed", JSON.stringify(badDom.body.result?.failed), "Bogus");

  // Cursor: a second burst is readable incrementally, without re-reading the first.
  chk("first pull nextSeq", evA.nextSeq, 3);
  await jpost("/events/subscribe", { browser: "shopee-A", tabId: 1001, events: ["net"] });
  await wait(350);
  const inc = (await jget(`/events?browser=shopee-A&tabId=1001&since=${evA.nextSeq}`)).body;
  chk("since cursor returns only the new events", inc.events.length, 3);
  chk("since cursor starts at seq 4", inc.events[0].seq, 4);
  chk("incremental pull is not truncated", inc.truncated, false);

  // Same buffer read from 0: cap is 4, six events were pushed, so it has holes
  // and says so instead of quietly returning a short list.
  const full = (await jget("/events?browser=shopee-A&tabId=1001")).body;
  chk("full pull reports truncation", full.truncated, true);
  chk("full pull reports how many were lost", full.dropped, 2);

  // Subscription state survives being asked for.
  chkc(
    "subscription is readable",
    JSON.stringify((await jget("/events/subscribe?browser=shopee-A&tabId=1001")).body.events),
    "Network.responseReceived",
  );

  // concurrency
  const [ra, rb] = await Promise.all([evalReq(1001, "shopee-A"), evalReq(1002, "shopee-B")]);
  chkc("parallel A", ra.body.result.result.value, "shopee-A (mock)");
  chkc("parallel B", rb.body.result.result.value, "shopee-B (mock)");

  // status
  const st = (await jget("/status")).body;
  chk("status browserCount", st.browserCount, 2);
  chk("status browsers carry subscriptions", typeof st.browsers[0].subscriptions, "object");

  // ---- v3: message ids, per-tab lanes, give-up semantics ----
  const now = () => process.hrtime.bigint();
  const msSince = (t) => Number(process.hrtime.bigint() - t) / 1e6;
  const sendA = (tabId, method, params, extra = {}) =>
    jpost("/send", { browser: "shopee-A", tabId, method, params, ...extra });

  await jpost("/attach", { browser: "shopee-A", tabId: 1002 });

  // Two tabs of the SAME browser. Under v2's single in-flight slot these
  // serialized; that was the cap this protocol bump exists to remove.
  let t = now();
  const cross = await Promise.all([
    sendA(1001, "Runtime.evaluate", { expression: "x", ms: 150 }),
    sendA(1002, "Runtime.evaluate", { expression: "x", ms: 150 }),
  ]);
  const crossMs = msSince(t);
  chk(
    "cross-tab both answered",
    cross.every((r) => r.body.ok === true),
    true,
  );
  chkc("cross-tab A answer correct", cross[0].body.result.result.value, "shopee-A (mock)");
  chk(`cross-tab overlapped (${crossMs.toFixed(0)}ms, serial would be ~300)`, crossMs < 280, true);

  // Within one tab, reads on the UNORDERED_CDP_METHODS list overlap...
  t = now();
  await Promise.all([
    sendA(1001, "Accessibility.getFullAXTree", { ms: 150 }),
    sendA(1001, "Accessibility.getFullAXTree", { ms: 150 }),
  ]);
  const readMs = msSince(t);
  chk(`intra-tab reads overlap (${readMs.toFixed(0)}ms)`, readMs < 280, true);

  // ...while anything else takes the tab exclusively.
  t = now();
  await Promise.all([
    sendA(1001, "Input.dispatchMouseEvent", { ms: 120 }),
    sendA(1001, "Input.dispatchMouseEvent", { ms: 120 }),
  ]);
  const writeMs = msSince(t);
  chk(
    `intra-tab writes serialize (${writeMs.toFixed(0)}ms, concurrent would be ~120)`,
    writeMs > 200,
    true,
  );

  // The `ordered` override forces a read to serialize too.
  t = now();
  await Promise.all([
    sendA(1001, "Accessibility.getFullAXTree", { ms: 120 }, { ordered: true }),
    sendA(1001, "Accessibility.getFullAXTree", { ms: 120 }, { ordered: true }),
  ]);
  const forcedMs = msSince(t);
  chk(`ordered:true override serializes (${forcedMs.toFixed(0)}ms)`, forcedMs > 200, true);

  // Give-up must not corrupt the stream: the abandoned command's answer arrives
  // (700ms) BEFORE the next command's own answer (~905ms). Pairing responses
  // positionally, as v2 did, would hand the stale one to the wrong caller.
  const late = sendA(1001, "Test.late", { ms: 700 });
  chk("abandoned command reports 504", (await late).status, 504);
  const afterLate = await sendA(1001, "Runtime.evaluate", { expression: "x", ms: 400 });
  chkc("next command gets its OWN answer", afterLate.body.result?.result?.value, "shopee-A (mock)");

  // A tab taken away mid-command fails now, not after CMD_TIMEOUT_MS.
  t = now();
  const gone = await sendA(1001, "Test.detach", {});
  const goneMs = msSince(t);
  chk("detached tab fails inflight with 409", gone.status, 409);
  chk(`...promptly (${goneMs.toFixed(0)}ms, timeout would be 500)`, goneMs < 300, true);
  await jpost("/attach", { browser: "shopee-A", tabId: 1001 });

  chk(
    "status reports inflight count",
    typeof (await jget("/status")).body.browsers[0].inflight,
    "number",
  );
  // The daemon↔ext message id is internal plumbing and must not reach a caller.
  chk(
    "send response carries no wire id",
    "id" in (await sendA(1001, "Runtime.evaluate", {})).body,
    false,
  );
  chk("status version", (await jget("/status")).body.version, 5);

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
