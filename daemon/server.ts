// booey daemon — standalone entry. See ../docs/SPEC.md for the protocol.
//
// Thin wrapper over createDaemon (daemon/create.ts): it owns the things a
// long-running process owns — port from argv/env, signal handlers, exit on bind
// failure, and a /shutdown that exits. All the daemon itself lives in create.ts
// so it can also be embedded in another process (import { createDaemon }).

import { DEFAULT_PORT } from "./config.ts";
import { createDaemon } from "./create.ts";

const port = Number(process.env.BOOEY_PORT || process.argv[2] || DEFAULT_PORT);

function log(...args: any[]): void {
  console.error(`[booey ${new Date().toISOString()}]`, ...args);
}

let daemon: Awaited<ReturnType<typeof createDaemon>>;
try {
  daemon = await createDaemon({ port, log, onShutdown: () => process.exit(0) });
} catch (e) {
  if ((e as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    log(`port ${port} already in use`);
    process.exit(1);
  }
  throw e;
}

const shutdown = () => void daemon.close().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
