// popup.js — status & identity panel for the cdp-relay extension.
//
// Read-only except for the label editor and a manual reconnect. Talks to
// background via chrome.runtime.sendMessage; works whether the daemon is up or
// not (daemon state is shown as info). Debugging a page goes through real
// DevTools or the CLI — the popup intentionally does not attach or inspect.

const $ = (id) => document.getElementById(id);
const bg = (msg) => chrome.runtime.sendMessage(msg);

let fullId = "";

// ---- identity (browser id + label) ----

async function refreshIdentity() {
  const { id, label } = await bg({ type: "get-identity" });
  fullId = id || "";
  $("browser-id").textContent = id ? id.slice(0, 8) + "…" : "?";
  $("browser-id").title = id ? `${id} — click to copy` : "";
  if (document.activeElement !== $("label-input")) $("label-input").value = label || "";
}

$("browser-id").addEventListener("click", async () => {
  if (!fullId) return;
  try {
    await navigator.clipboard.writeText(fullId);
    flash("id-copied", "copied");
  } catch {
    /* clipboard may be unavailable; selecting the text still works */
  }
});

async function saveLabel() {
  await bg({ type: "set-label", label: $("label-input").value.trim() });
  flash("label-saved", "✓ saved");
}

$("label-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveLabel();
});
$("label-input").addEventListener("blur", saveLabel);

function flash(id, text) {
  const el = $(id);
  el.textContent = text;
  setTimeout(() => (el.textContent = ""), 1500);
}

// ---- daemon status + warning banner ----

async function refreshDaemon() {
  const r = await bg({ type: "daemon-status" });
  const pill = $("daemon-pill");
  $("daemon-port").textContent = r.port;
  $("proto").textContent = "v" + r.version;
  pill.classList.remove("offline", "halted", "connecting");
  const warn = $("warn");
  warn.classList.remove("show");

  if (r.wsConnected) {
    $("daemon-state").textContent = "online";
  } else if (r.stoppedReconnecting) {
    $("daemon-state").textContent = "halted";
    pill.classList.add("halted");
    warn.classList.add("show");
    warn.textContent =
      `Halted: protocol mismatch (ext speaks v${r.version}). Reload the extension ` +
      `and restart the daemon so both agree, then press ⟳.`;
  } else {
    $("daemon-state").textContent = "offline";
    pill.classList.add("offline");
  }
}

$("reconnect").addEventListener("click", async () => {
  await bg({ type: "reconnect-daemon" });
  setTimeout(refreshDaemon, 300);
});

// ---- counters ----

async function refreshStatus() {
  const s = await bg({ type: "status" });
  $("attached").textContent = s.attached?.length || 0;
  $("c-matched").textContent = s.matchedEvents || 0;
  $("c-filtered").textContent = s.filteredEvents || 0;
  $("c-dropped").textContent = s.droppedEvents || 0;
}

// ---- refresh loop ----

function refreshAll() {
  refreshDaemon();
  refreshStatus();
}

setInterval(refreshAll, 1500);
refreshIdentity();
refreshAll();
