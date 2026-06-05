// popup.js — fallback debug UI for cdp-relay extension
//
// Talks to background via chrome.runtime.sendMessage. Independent of daemon —
// works whether daemon is alive or not. Daemon state shown only as info.

let currentTabId = null;
let allRequests = [];
let selectedReqId = null;

const $ = (id) => document.getElementById(id);

async function bg(msg) {
  return await chrome.runtime.sendMessage(msg);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ---- identity (browser id + label) ----

async function refreshIdentity() {
  const { id, label } = await bg({ type: "get-identity" });
  $("browser-id").textContent = id ? id.slice(0, 8) : "?";
  $("browser-id").title = id || "";
  if (document.activeElement !== $("label-input")) $("label-input").value = label || "";
}

$("save-label").addEventListener("click", async () => {
  await bg({ type: "set-label", label: $("label-input").value.trim() });
  const saved = $("label-saved");
  saved.textContent = "✓ saved";
  setTimeout(() => (saved.textContent = ""), 1500);
});

$("label-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("save-label").click();
});

// ---- daemon status pill + footer ----

async function refreshDaemon() {
  const r = await bg({ type: "daemon-status" });
  const pill = $("daemon-pill");
  const state = $("daemon-state");
  const port = $("daemon-port");
  const footer = $("footer-daemon");
  port.textContent = r.port;
  pill.classList.remove("offline", "connecting");
  if (r.wsConnected) {
    state.textContent = "online";
    footer.textContent = `● :${r.port}`;
    footer.style.color = "var(--green)";
  } else if (r.stoppedReconnecting) {
    state.textContent = "halted";
    pill.classList.add("offline");
    footer.textContent = `✕ :${r.port} (halt)`;
    footer.style.color = "var(--red)";
  } else {
    state.textContent = "offline";
    pill.classList.add("offline");
    footer.textContent = `✕ :${r.port}`;
    footer.style.color = "var(--red)";
  }
}

$("reconnect").addEventListener("click", async () => {
  await bg({ type: "reconnect-daemon" });
  setTimeout(refreshDaemon, 300);
});

// ---- attach / detach ----

function setAttachStatus(html, color) {
  const el = $("attach-status");
  el.innerHTML = html;
  el.querySelector(".dot").style.color = color || "var(--fg-5)";
}

$("attach").addEventListener("click", async () => {
  const tab = await getActiveTab();
  currentTabId = tab.id;
  setAttachStatus(`<span class="dot">●</span>attaching ${tab.id}…`, "var(--orange)");
  const r = await bg({ type: "attach", tabId: tab.id });
  if (r.error || r.ok === false) {
    setAttachStatus(`<span class="dot">●</span>err: ${escapeHtml(String(r.error || "?")).slice(0, 60)}`, "var(--red)");
    currentTabId = null;
  } else {
    setAttachStatus(`<span class="dot">●</span>tab ${tab.id}`, "var(--green)");
  }
  refresh();
});

$("detach").addEventListener("click", async () => {
  if (currentTabId == null) return;
  await bg({ type: "detach", tabId: currentTabId });
  setAttachStatus('<span class="dot">●</span>not attached', "var(--fg-5)");
  currentTabId = null;
});

$("clear").addEventListener("click", async () => {
  await bg({ type: "clear" });
  allRequests = [];
  selectedReqId = null;
  $("detail-text").value = "";
  $("detail-summary").textContent = "(click a row)";
  render();
});

$("filter").addEventListener("input", render);

// ---- mode tabs ----

document.querySelectorAll(".modetab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".modetab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".pane").forEach((x) => {
      x.classList.remove("active");
      x.style.display = "none";
    });
    t.classList.add("active");
    const pane = $("pane-" + t.dataset.pane);
    pane.classList.add("active");
    pane.style.display = "flex";
  });
});

// ---- network list ----

async function refresh() {
  const r = await bg({ type: "list-requests" });
  allRequests = r.requests || [];
  render();
  updateFooterStats();
}

function render() {
  const filter = $("filter").value.toLowerCase().trim();
  const list = $("list");
  const filtered = allRequests.filter((r) => !filter || r.url.toLowerCase().includes(filter));
  $("net-count").textContent = filtered.length;

  // efficient enough for ~500 rows
  list.innerHTML = "";
  for (const r of filtered.slice(-200)) {
    const div = document.createElement("div");
    div.className = "nrow" + (r.requestId === selectedReqId ? " selected" : "");
    const m = (r.method || "").toUpperCase();
    const statClass = r.status ? `s-${Math.floor(r.status / 100)}xx` : (r.failed ? "s-err" : "s-pending");
    const statText = r.status ? r.status : (r.failed ? "ERR" : "•••");
    const path = urlPath(r.url);
    div.innerHTML =
      `<span class="m-${m}">${escapeHtml(m)}</span>` +
      `<span class="${statClass}">${statText}</span>` +
      `<span class="url" title="${escapeHtml(r.url)}">${escapeHtml(path)}</span>` +
      `<span class="size">${formatSize(r)}</span>`;
    div.addEventListener("click", () => selectRequest(r.requestId));
    list.appendChild(div);
  }
  list.scrollTop = list.scrollHeight;

  // last-row hint in footer
  const last = allRequests[allRequests.length - 1];
  if (last) {
    const m = (last.method || "").toUpperCase();
    const stat = last.status || (last.failed ? "ERR" : "•••");
    $("footer-last").textContent = `LAST: ${m} ${stat} ${urlPath(last.url).slice(0, 40)}`;
  }
}

function urlPath(u) {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u || "";
  }
}

function formatSize(r) {
  // we don't currently track encodedDataLength — show "—"
  return r.failed ? "ERR" : (r.status ? "—" : "");
}

async function selectRequest(requestId) {
  selectedReqId = requestId;
  render();
  const req = allRequests.find((r) => r.requestId === requestId);
  if (!req) return;

  $("detail-summary").textContent = `${req.method || ""} ${req.status || (req.failed ? "ERR" : "PEND")} · ${urlPath(req.url).slice(0, 60)}`;

  const lines = [
    `${req.method} ${req.url}`,
    `Status: ${req.status || "(pending)"}  ${req.failed ? "FAILED: " + req.failed : ""}`,
    `Type: ${req.type || "?"}  MIME: ${req.mimeType || "?"}`,
    "",
    "--- Request headers ---",
    formatHeaders(req.headers),
  ];
  if (req.postData) lines.push("", "--- Post data ---", req.postData);
  lines.push("", "--- Response headers ---", formatHeaders(req.responseHeaders));

  if (req.status && currentTabId != null) {
    lines.push("", "--- Response body (loading…) ---");
    $("detail-text").value = lines.join("\n");
    const r = await bg({ type: "get-body", tabId: currentTabId, requestId });
    if (r.error || r.ok === false) {
      lines.push(`(error: ${r.error || "?"})`);
    } else if (r.result) {
      const body = r.result.base64Encoded
        ? `(binary, ${r.result.body.length} bytes base64)`
        : r.result.body;
      lines[lines.length - 1] = "--- Response body ---";
      lines.push((body || "").slice(0, 8000));
    }
  }
  $("detail-text").value = lines.join("\n");
}

function formatHeaders(h) {
  if (!h) return "(none)";
  return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\n");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---- eval pane ----

async function runEval() {
  if (currentTabId == null) {
    $("eval-out").textContent = "(not attached — click ⟨A⟩ ATTACH first)";
    return;
  }
  const expression = $("eval-input").value;
  if (!expression.trim()) return;
  const awaitPromise = $("eval-await").checked;
  const r = await bg({
    type: "send",
    tabId: currentTabId,
    method: "Runtime.evaluate",
    params: { expression, awaitPromise, returnByValue: true, generatePreview: true },
  });
  if (r.error || r.ok === false) {
    $("eval-out").textContent = "ERROR: " + (r.error || "?");
    return;
  }
  const ex = r.result?.exceptionDetails;
  const res = r.result?.result;
  if (ex) {
    $("eval-out").textContent = "EXCEPTION: " + (ex.exception?.description || ex.text);
  } else {
    $("eval-out").textContent = formatValue(res);
  }
}

$("eval-input").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    runEval();
  }
});

function formatValue(res) {
  if (!res) return "(no result)";
  if (res.value !== undefined) {
    return typeof res.value === "object" ? JSON.stringify(res.value, null, 2) : String(res.value);
  }
  return res.description || res.type || "(unknown)";
}

// ---- footer stats ----

async function updateFooterStats() {
  const s = await bg({ type: "status" });
  $("footer-attached").textContent = s.attached?.length || 0;
  $("footer-reqs").textContent = s.requestCount || 0;
}

// ---- auto refresh ----

setInterval(() => {
  if (currentTabId != null) refresh();
  refreshDaemon();
}, 1500);

// ---- init ----

(async () => {
  refreshIdentity();
  refreshDaemon();
  const s = await bg({ type: "status" });
  if (s.attached?.length) {
    const tab = await getActiveTab();
    if (s.attached.includes(tab.id)) {
      currentTabId = tab.id;
      setAttachStatus(`<span class="dot">●</span>tab ${tab.id} (restored)`, "var(--green)");
      refresh();
    } else {
      setAttachStatus(`<span class="dot">●</span>${s.attached.length} other tab(s)`, "var(--orange)");
    }
  }
  updateFooterStats();
})();
