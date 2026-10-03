// Exercises the shipped client (clients/ts) against the real daemon + mock ext.
//
// The client is part of this repo's contract, not a convenience wrapper: a
// protocol change that the client doesn't follow should fail here rather than
// in a consumer.
//
//   node test/client.mjs [port]
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isRelayConnectionFailure,
  PageJsError,
  RelayClient,
  RelayError,
} from "../clients/ts/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || 9233);
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
  spawnNode(["daemon/server.ts", String(PORT)], { BOOEY_CMD_TIMEOUT_MS: "800" });
  if (!(await pollUntil(async () => (await fetch(`http://127.0.0.1:${PORT}/status`)).ok)))
    throw new Error("daemon never came up");
  spawnNode(["daemon/test-mock-ext.ts", String(PORT), "browser-A", "shopee-A"]);

  const relay = new RelayClient({ base: `http://127.0.0.1:${PORT}`, browser: "shopee-A" });
  if (!(await pollUntil(async () => (await relay.browsers()).length === 1)))
    throw new Error("browser never registered");

  // ---- discovery ----
  chk(
    "tabs({fresh:false}) reads the snapshot",
    (await relay.tabs({ fresh: false })).some((t) => t.url === "mock://fresh-only"),
    false,
  );
  chk(
    "tabs() round-trips",
    (await relay.tabs()).some((t) => t.url === "mock://fresh-only"),
    true,
  );
  chk("findTab", (await relay.findTab(/seller\.shopee\.tw/)).tabId, 1001);

  // ---- attach returns the subscription it actually installed ----
  const sub = await relay.attach(1001, { events: ["net"] });
  chk("attach reports enabled domains", sub.enabled.includes("Network"), true);
  chk("attach expands the preset", sub.events.includes("Network.responseReceived"), true);
  chk("attach reports no failures", sub.failed.length, 0);

  // ---- running code ----
  chkc("eval", await relay.eval(1001, "document.title"), "shopee-A (mock)");
  chkc("evalFn", await relay.evalFn(1001, (a) => a, "arg"), "shopee-A (mock)");
  await relay.navigate(1001, "https://seller.shopee.tw/portal");
  chk("navigate resolves", true, true);
  chk("screenshot returns bytes", (await relay.screenshot(1001)).byteLength > 0, true);

  // ---- events, with the cursor ----
  await wait(350);
  const p1 = await relay.readEvents(1001);
  chk("readEvents returns the burst", p1.events.length, 3);
  chk("...not truncated", p1.truncated, false);
  await relay.subscribe(1001, ["net"]);
  await wait(350);
  const p2 = await relay.readEvents(1001, { since: p1.nextSeq });
  chk("cursor returns only new events", p2.events.length, 3);
  chk("cursor advances", p2.nextSeq > p1.nextSeq, true);
  chk(
    "filter narrows",
    (await relay.readEvents(1001, { filter: /responseReceived/ })).events.every(
      (e) => e.method === "Network.responseReceived",
    ),
    true,
  );
  chkc(
    "subscription() reads back",
    (await relay.subscription(1001)).join(),
    "Network.requestWillBeSent",
  );

  // ---- sessions (out-of-process iframes) ----
  // Without sessions:true nothing auto-attaches, so the pool must stay empty
  // rather than quietly reporting stale or invented targets.
  chk("no session pool without sessions:true", (await relay.sessions(1002)).length, 0);

  const withSessions = await relay.attach(1002, { events: ["nav"], sessions: true });
  chk(
    "sessions:true implies the targets preset",
    withSessions.events.includes("Target.attachedToTarget"),
    true,
  );
  // Target has no enable method — its events come from setAutoAttach. It must
  // show up in neither list: reporting it as failed would put a permanent entry
  // in `failed`, whose whole job is to flag a typo'd domain name.
  chk("Target is not reported as enabled", withSessions.enabled.includes("Target"), false);
  chk("...nor as failed", JSON.stringify(withSessions.failed).includes("Target"), false);
  await wait(200);
  const pool = await relay.sessions(1002);
  chk("auto-attach populated the pool", pool.length, 1);
  chk("...keyed on a stable targetId", pool[0].targetId, "TGT-1002-1");
  chkc("...carrying the frame's url", pool[0].url, "example.com");

  // The sessionId has to actually reach chrome.debugger, not be dropped en route.
  const echoed = await relay.send(1002, "Test.sessionEcho", {}, { sessionId: pool[0].sessionId });
  chk("sessionId reaches the extension", echoed.sawSessionId, pool[0].sessionId);
  const noSession = await relay.send(1002, "Test.sessionEcho", {});
  chk("...and is absent when not asked for", noSession.sawSessionId, null);

  await relay.send(1002, "Test.detachSession", {});
  await wait(200);
  chk("detachedFromTarget evicts it", (await relay.sessions(1002)).length, 0);

  // Sessions die with the attachment; handing out invalidated sessionIds after a
  // reattach would be worse than reporting none.
  await relay.attach(1002, { events: ["nav"], sessions: true });
  await wait(200);
  chk("re-attach repopulates from scratch", (await relay.sessions(1002)).length, 1);
  await relay.detach(1002);
  chk("detach empties the pool", (await relay.sessions(1002)).length, 0);

  // ---- page revision ----
  // The subscription bounds what can bump it: an unsubscribed dirtying event is
  // dropped in the extension and the daemon never learns of it.
  await relay.subscribe(1001, ["nav", "dom"]);
  const p0 = await relay.page(1001);
  chk("page() reports the tab", p0.tabId, 1001);
  chk("page() reports attached", p0.attached, true);
  const r0 = p0.revision;

  await relay.send(1001, "Test.dirty", { method: "Page.loadEventFired" });
  await wait(200);
  const r1 = await relay.revision(1001);
  chk("a dirtying event bumps the revision", r1 > r0, true);
  chkc(
    "...and says what did it",
    (await relay.page(1001)).lastDirty?.method,
    "Page.loadEventFired",
  );

  await relay.send(1001, "Test.dirty", { method: "DOM.documentUpdated" });
  await wait(200);
  chk("dom preset catches document swaps too", (await relay.revision(1001)) > r1, true);

  const r2 = await relay.revision(1001);
  await relay.send(1001, "Runtime.evaluate", { expression: "1" });
  await wait(200);
  chk("a plain command does NOT bump it", await relay.revision(1001), r2);

  // An event nobody subscribed to cannot bump anything.
  await relay.subscribe(1001, ["net"]);
  const r3 = await relay.revision(1001);
  await relay.send(1001, "Test.dirty", { method: "Page.loadEventFired" });
  await wait(200);
  chk("unsubscribed dirtying event is invisible", await relay.revision(1001), r3);

  // Re-attaching ends the observation, so the count starts over. Otherwise a
  // caller holding a baseline from before the gap would read "unchanged" across
  // a detach — the one answer that must never be wrong.
  await relay.subscribe(1001, ["nav", "dom"]);
  await relay.send(1001, "Test.dirty", {});
  await wait(200);
  chk("revision is non-zero before detaching", (await relay.revision(1001)) > 0, true);
  await relay.detach(1001);
  await relay.attach(1001, { events: ["nav", "dom"] });
  chk("re-attaching resets the revision", await relay.revision(1001), 0);

  // settled(): quiet page returns fast; churning page reports quiet:false.
  await relay.subscribe(1001, ["nav", "dom"]);
  const tQuiet = Date.now();
  const quiet = await relay.settled(1001, { quietMs: 300, timeoutMs: 5000, pollMs: 50 });
  chk(`settled() returns quiet on a still page (${Date.now() - tQuiet}ms)`, quiet.quiet, true);

  const churn = setInterval(() => {
    relay.send(1001, "Test.dirty", {}).catch(() => {});
  }, 100);
  const busy = await relay.settled(1001, { quietMs: 400, timeoutMs: 1500, pollMs: 50 });
  clearInterval(churn);
  chk("settled() reports quiet:false while the page churns", busy.quiet, false);
  await wait(600);

  // ---- v6: snapshot (page model) ----
  const snap = await relay.snapshot(1001);
  const snapBtn = snap.nodes.find((n) => n.tag === "button");
  chk("snapshot returns nodes", snap.nodes.length > 0, true);
  chkc("snapshot merges role+name", `${snapBtn.role}:${snapBtn.name}`, "button:加入购物车");
  chk("snapshot XPath sibling-indexed", snapBtn.xp, "/html[1]/body[1]/button[1]");
  chk("snapshot rect from DOMSnapshot", JSON.stringify(snapBtn.rect), "[120,480,96,36]");
  chk("snapshot marks the button interactive", snapBtn.int, true);
  chk("snapshot carries a 16-hex elementHash", /^[0-9a-f]{16}$/.test(snapBtn.elementHash), true);
  chk("snapshot carries indexedText", snap.indexedText.includes("[1]<button"), true);
  chk("snapshot selectorMap maps index→node", snap.selectorMap["1"]?.tag, "button");
  chk("snapshot revision matches page revision", snap.revision, await relay.revision(1001));

  const sr1 = await relay.snapshotRead(1001);
  chk("snapshotRead serves the cache", sr1.snapshot.nodes.length, snap.nodes.length);
  chk("snapshotRead not stale when quiet", sr1.stale, false);
  await relay.send(1001, "Test.dirty", { method: "Page.loadEventFired" });
  await wait(200);
  chk("snapshotRead stale after a dirty event", (await relay.snapshotRead(1001)).stale, true);

  // ---- cross-frame snapshot（OOPIF 拼到宿主 iframe 下）----
  await relay.attach(1002, { events: ["nav"], sessions: true });
  await wait(200);
  const snap2 = await relay.snapshot(1002);
  const childInput = snap2.nodes.find((n) => n.tag === "input");
  chk("cross-frame snapshot stitches the OOPIF input", childInput !== undefined, true);
  chk(
    "...with a host-prefixed XPath",
    childInput.xp,
    "/html[1]/body[1]/iframe[1]/html[1]/body[1]/input[1]",
  );

  // ---- v6: actions (L3) ----
  await relay.subscribe(1001, ["nav", "dom"]);
  const snapForAct = await relay.snapshot(1001);
  const results = await relay.act(1001, [{ index: 1, method: "click" }]);
  chk("act click succeeds", results[0].ok, true);
  chk("...no healing needed on a fresh xpath", results[0].healed === true, false);

  // 三级回退第二级：xpath 失效 → elementHash 重定位（healed:true，零 LLM）。
  const btnHash = snapForAct.selectorMap[1].elementHash;
  const healed = await relay.act(1001, [
    { method: "click", xpath: "/html[1]/body[1]/STALE[1]", elementHash: btnHash },
  ]);
  chk("stale xpath heals via elementHash", healed[0].ok, true);
  chk("...and marks healed", healed[0].healed, true);

  // 2.5 级：xpath 和 elementHash 都失效，但指纹还在 → 按相似度模糊重定位（零 LLM）。
  const btn = snapForAct.selectorMap[1];
  const fp = {
    tag: btn.tag,
    role: btn.role,
    name: btn.name,
    attrs: btn.attrs,
    tagPath: btn.xp.replace(/\[\d+\]/g, ""),
    parentBranchHash: btn.parentBranchHash,
  };
  const fuzzy = await relay.act(1001, [
    {
      method: "click",
      xpath: "/html[1]/body[1]/STALE[1]",
      elementHash: "0000000000000000",
      fingerprint: fp,
    },
  ]);
  chk("stale xpath+hash heals via fuzzy fingerprint", fuzzy[0].ok, true);
  chk("...marked healMethod fuzzy", fuzzy[0].healMethod, "fuzzy");
  chk(
    "...returns relocated identity for cache migration",
    typeof fuzzy[0].relocated?.elementHash === "string",
    true,
  );

  // 最后一级：xpath / elementHash / 指纹都对不上 → needsInference。
  const gone = await relay.act(1001, [
    { method: "click", xpath: "/html[1]/body[1]/STALE[1]", elementHash: "0000000000000000" },
  ]);
  chk("missing element reports needsInference", gone[0].needsInference, true);
  chk("...and fails", gone[0].ok, false);

  // ---- orchestrator: 注入 llm + cache 的自维护循环 ----
  let inferCalls = 0;
  const llm = {
    infer: () => {
      inferCalls++;
      return [{ index: 1, method: "click" }];
    },
  };
  const store = new Map();
  const cache = {
    get: (k) => store.get(k) ?? null,
    set: (k, v) => void store.set(k, v),
  };
  const agent = relay.agent({ llm, cache });

  // 首次：未命中 → 快照 + 推理 + 执行 + 写回缓存。
  const a1 = await agent.do(1001, "点那个按钮");
  chk("agent first run: reinferred", a1.reinferred, true);
  chk("agent first run: not from cache", a1.fromCache, false);
  chk("agent first run: ok", a1.ok, true);
  chk("agent first run: llm called once", inferCalls, 1);
  chk("agent first run: cache written", store.size, 1);

  // 再次：命中缓存 → 重放（零 LLM、零快照）。
  const a2 = await agent.do(1001, "点那个按钮");
  chk("agent second run: from cache", a2.fromCache, true);
  chk("agent second run: not reinferred", a2.reinferred, false);
  chk("agent second run: ok", a2.ok, true);
  chk("agent second run: llm NOT called again", inferCalls, 1);

  // ---- errors carry codes, not prose ----
  try {
    await relay.eval(9999, "1");
    chk("unattached tab throws", false, true);
  } catch (e) {
    chk("...RelayError", e instanceof RelayError, true);
    chk("...code TAB_NOT_ATTACHED", e.code, "TAB_NOT_ATTACHED");
    chk("...not retriable", e.retriable, false);
  }
  try {
    await relay.eval(1001, "THROW");
    chk("page exception throws", false, true);
  } catch (e) {
    chk("...PageJsError, not RelayError", e instanceof PageJsError, true);
    chk("...not a connection failure", isRelayConnectionFailure(e), false);
  }
  try {
    await relay.send(1001, "Test.noReply", {}, { timeoutMs: 200 });
    chk("per-command timeout fires", false, true);
  } catch (e) {
    chk("...code TIMEOUT", e.code, "TIMEOUT");
    chk("...marked retriable", e.retriable, true);
    chkc("...names the budget it used, not the daemon default", e.message, "200ms");
    chk("...classified as a connection failure", isRelayConnectionFailure(e), true);
  }
  // ---- L1 ergonomics: network capture + waits (single browser, tab 1001) ----
  await relay.subscribe(1001, ["net"]); // mock re-emits its net burst on a sub change
  const resp = await relay.waitForResponse(1001, /get_product_extensive_info/, { timeoutMs: 3000 });
  chk("waitForResponse matches the api url", /get_product_extensive_info/.test(resp.url), true);
  chk("...carries status", resp.status, 200);
  chk("...body parsed as json", resp.json?.code, 0);

  const captured = await relay.captureResponses(1001, /get_product_extensive_info/, {
    settleMs: 400,
    timeoutMs: 3000,
  });
  chk("captureResponses collects the matching call", captured.length >= 1, true);

  chk(
    "waitForSelector resolves",
    await relay.waitForSelector(1001, ".price", { timeoutMs: 2000 }),
    true,
  );

  const s = await relay.settled(1001, { quietMs: 300, timeoutMs: 3000, net: true });
  chk("settled({net}) goes quiet", s.quiet, true);

  await relay.subscribe(1001, ["nav"]); // drop Network
  try {
    await relay.waitForResponse(1001, /x/, { timeoutMs: 500 });
    chk("waitForResponse without net subscription throws", false, true);
  } catch (e) {
    chk("...code BAD_REQUEST (subscribe net first)", e.code, "BAD_REQUEST");
  }

  // ---- withTab: attach, run, and detach only what it attached ----
  let gotTab = 0;
  await relay.withTab(1001, async (t) => {
    gotTab = t.tabId;
  });
  chk("withTab passes the tab to fn", gotTab, 1001);
  chk("withTab leaves a pre-attached tab attached", (await relay.page(1001)).attached, true);

  await relay.detach(1001);
  await relay.withTab(1001, async () => {});
  chk("withTab detaches a tab it attached itself", (await relay.page(1001)).attached, false);

  const twoBrowsers = new RelayClient({ base: `http://127.0.0.1:${PORT}` });
  spawnNode(["daemon/test-mock-ext.ts", String(PORT), "browser-B", "shopee-B"]);
  await pollUntil(async () => (await twoBrowsers.browsers()).length === 2);
  try {
    await twoBrowsers.tabs();
    chk("ambiguous selector throws", false, true);
  } catch (e) {
    chk("...code AMBIGUOUS_BROWSER", e.code, "AMBIGUOUS_BROWSER");
  }
  const dead = new RelayClient({ base: "http://127.0.0.1:9", timeoutMs: 500 });
  try {
    await dead.browsers();
    chk("unreachable daemon throws", false, true);
  } catch (e) {
    chk("...code UNREACHABLE", e.code, "UNREACHABLE");
    chk("...retriable", e.retriable, true);
  }

  console.log(`\n===== CLIENT PASS=${pass} FAIL=${fail} =====`);
} catch (e) {
  console.log("HARNESS ERROR:", e.message);
  fail++;
} finally {
  cleanup();
  await wait(100);
  process.exit(fail ? 1 : 0);
}
