// Offscreen keep-alive for the MV3 service worker.
//
// An offscreen document is an ordinary page: its timers are not torn down when
// the service worker idles out. Posting on a runtime Port once a second keeps
// the SW's idle timer from ever reaching ~30s, so the SW stays up instead of
// dying and waiting on chrome.alarms (floor: 30s) to be resurrected.
//
// Nothing is communicated. Delivery is the entire point.

const HEARTBEAT_PORT = "cdp-relay-heartbeat";
const HEARTBEAT_INTERVAL_MS = 1_000;
const RECONNECT_DELAY_MS = 250;

let port = null;

function beat() {
  // The port drops whenever the SW does recycle; reconnecting on the next tick
  // is what re-establishes the wake channel with the new SW instance.
  if (!port) return;
  try {
    port.postMessage({ t: Date.now() });
  } catch {
    port = null;
  }
}

function connect() {
  try {
    port = chrome.runtime.connect({ name: HEARTBEAT_PORT });
  } catch {
    setTimeout(connect, RECONNECT_DELAY_MS);
    return;
  }
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, RECONNECT_DELAY_MS);
  });
  beat();
}

connect();
setInterval(beat, HEARTBEAT_INTERVAL_MS);
