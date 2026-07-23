// Shared daemon constants. See ../docs/SPEC.md for the protocol contract.

export const PROTOCOL_VERSION = 2; // bumped from 1: hello now carries {id, label}
export const DEFAULT_PORT = 9224; // 9223 is used by the legacy v1 relay in listo; keep them separate

export const CMD_TIMEOUT_MS = 30_000;     // per-command in-flight timeout
export const HEARTBEAT_MS = 25_000;       // daemon→ext ping cadence (keeps MV3 SW alive)
export const NO_DATA_TIMEOUT_MS = 60_000; // close a conn that goes silent this long
export const EVENT_CACHE_CAP = 1000;      // per-(browser,tab) event ring-buffer capacity
