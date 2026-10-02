// createDaemon 的单测：内嵌库形态能起、能关、端口能回收，占用端口会 reject。
// 协议行为由 integration/client 套件覆盖，这里只盯「可内嵌」这条路径的生命周期。

import assert from "node:assert/strict";
import { test } from "node:test";
import { createDaemon } from "../daemon/create.ts";

const silent = () => {};

/** 取一个空闲端口：起一个 daemon、记下端口、关掉。 */
async function freePort(): Promise<number> {
  const d = await createDaemon({ port: 0, log: silent });
  const port = (d.httpServer.address() as { port: number }).port;
  await d.close();
  return port;
}

test("createDaemon starts, serves /status, and close() frees the port", async () => {
  const port = await freePort();

  const d = await createDaemon({ port, log: silent });
  try {
    assert.equal(d.port, port);

    const res = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { port: number; version: number; browserCount: number };
    assert.equal(body.port, port);
    assert.equal(typeof body.version, "number");
    assert.equal(body.browserCount, 0);
  } finally {
    await d.close();
  }

  // The port is genuinely released: a fresh daemon can bind it again.
  const again = await createDaemon({ port, log: silent });
  await again.close();
});

test("createDaemon rejects with EADDRINUSE when the port is taken", async () => {
  const port = await freePort();
  const first = await createDaemon({ port, log: silent });
  try {
    await assert.rejects(
      () => createDaemon({ port, log: silent }),
      (e: NodeJS.ErrnoException) => e.code === "EADDRINUSE",
    );
  } finally {
    await first.close();
  }
});

test("POST /shutdown without onShutdown closes the daemon, not the process", async () => {
  const port = await freePort();
  const d = await createDaemon({ port, log: silent });

  const res = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  // The default onShutdown just close()s (after a 50ms flush). Poll until the
  // port stops answering — proof the process stayed alive to run this assertion.
  const gone = await waitUntilDown(port, 2000);
  assert.ok(gone, "daemon should have shut down its own listener");
  // No trailing close(): the default onShutdown already closed it (clearing the
  // heartbeat and freeing the port). `d` is referenced only to hold the handle.
  void d;
});

async function waitUntilDown(port: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/status`);
    } catch {
      return true; // connection refused ⇒ listener gone
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
