// Packaging smoke test: build the tarball, install it the way a consumer would,
// and drive the daemon + client + CLI *from inside node_modules*.
//
// This exists because of one hard fact: Node refuses to strip types for files
// under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). The repo
// runs .ts directly, so nothing else here would ever notice a package that
// ships sources instead of dist/, or an export map pointing at a .ts file —
// it would fail only in the consumer, on install day.
//
//   node test/pack.mjs [port]
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || 9243);
const PKG_NAME = "@wuwe1/cdp-relay";

let PASS = 0;
let FAIL = 0;
const procs = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(name, cond, detail = "") {
  if (cond) {
    PASS++;
    console.log(`  ok   ${name}`);
  } else {
    FAIL++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})\n${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

async function pollUntil(fn, tries = 100, gap = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return true;
    } catch {}
    await wait(gap); // not shell `sleep` — some sandboxes block it
  }
  return false;
}

// realpath: macOS hands out /var/... which is a symlink to /private/var/...,
// and the CLI resolves the real one — compare like for like.
const tmp = realpathSync(mkdtempSync(resolve(tmpdir(), "cdp-relay-pack-")));
const consumer = resolve(tmp, "consumer");
const installed = resolve(consumer, "node_modules", PKG_NAME);

function cleanup() {
  for (const p of procs) {
    try {
      p.kill("SIGKILL");
    } catch {}
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

console.log(`\n=== pack (port ${PORT}) ===`);

// 1. pack exactly what `npm publish` would send (this runs `prepare` → build)
const tarball = resolve(
  tmp,
  run("npm", ["pack", "--silent", "--pack-destination", tmp], { cwd: ROOT }),
);

// 2. install it the cheap way: extract into node_modules and drop `ws` beside it.
//    (`npm install <tarball>` would do the same thing plus a network round-trip.)
mkdirSync(installed, { recursive: true });
run("tar", ["-xzf", tarball, "-C", installed, "--strip-components=1"]);
cpSync(resolve(ROOT, "node_modules", "ws"), resolve(consumer, "node_modules", "ws"), {
  recursive: true,
});
writeFileSync(resolve(consumer, "package.json"), JSON.stringify({ type: "module" }) + "\n");

// 3. the tarball carries what a consumer needs — and the extension is one of them
const listed = run("tar", ["-tzf", tarball]).split("\n");
ok(
  "tarball ships dist/",
  listed.some((f) => f.startsWith("package/dist/clients/ts/index.js")),
);
ok(
  "tarball ships .d.ts",
  listed.some((f) => f.endsWith("dist/clients/ts/index.d.ts")),
);
ok("tarball ships extension/", listed.includes("package/extension/manifest.json"));
ok("tarball ships the SPEC", listed.includes("package/docs/SPEC.md"));
ok("tarball ships NO .ts sources", !listed.some((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")));

// 4. the import a consumer actually writes — the type-stripping trap lives here
const imported = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `import { RelayClient, RelayError, PageJsError } from "${PKG_NAME}";
     if (typeof RelayClient !== "function") throw new Error("no RelayClient");
     if (typeof RelayError !== "function") throw new Error("no RelayError");
     if (typeof PageJsError !== "function") throw new Error("no PageJsError");
     console.log("import-ok");`,
  ],
  { cwd: consumer, encoding: "utf8" },
);
ok(
  "import from node_modules works",
  imported.status === 0 && imported.stdout.includes("import-ok"),
  imported.stderr.trim().split("\n")[0],
);

// 5. the CLI, run from inside node_modules, finds the daemon and the extension
const bin = resolve(installed, "dist", "cli", "cdp-relay.js");
const extPath = run(process.execPath, [bin, "ext", "path"], { cwd: consumer });
ok("`ext path` resolves inside the package", extPath === resolve(installed, "extension"), extPath);

// 6. end to end from the installed copy: daemon + mock ext + client
function spawnInstalled(rel, args) {
  const p = spawn(process.execPath, [resolve(installed, rel), ...args], {
    cwd: consumer,
    stdio: ["ignore", "ignore", "ignore"],
  });
  procs.push(p);
  return p;
}

spawnInstalled("dist/daemon/server.js", [String(PORT)]);
const up = await pollUntil(async () => (await fetch(`http://127.0.0.1:${PORT}/status`)).ok);
ok("packaged daemon starts", up);

spawnInstalled("dist/daemon/test-mock-ext.js", [String(PORT), "browser-P", "packaged-A"]);
const connected = await pollUntil(async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/browsers`);
  const b = await r.json();
  return (b.browsers || []).length === 1;
});
ok("packaged mock ext connects (protocol versions agree)", connected);

if (up && connected) {
  const { RelayClient } = await import(resolve(installed, "dist/clients/ts/index.js"));
  const relay = new RelayClient({ base: `http://127.0.0.1:${PORT}`, browser: "packaged-A" });
  const tabs = await relay.tabs();
  ok("packaged client lists tabs", Array.isArray(tabs) && tabs.length > 0);
  if (tabs.length) {
    await relay.attach(tabs[0].tabId);
    const r = await relay.eval(tabs[0].tabId, "1+1");
    ok("packaged client evaluates through the packaged daemon", r !== undefined);
  }

  const doctor = spawnSync(process.execPath, [bin, "doctor", "--port", String(PORT)], {
    cwd: consumer,
    encoding: "utf8",
  });
  const report = JSON.parse(doctor.stdout || "{}");
  ok(
    "`doctor` reports a healthy install",
    doctor.status === 0 && report.problems?.length === 0,
    JSON.stringify(report.problems || doctor.stderr),
  );
  ok(
    "`doctor` sees the packaged extension's protocol version",
    report.extension?.protocolVersion === report.daemon?.protocolVersion,
    JSON.stringify({ ext: report.extension, daemon: report.daemon }),
  );
}

console.log(`\nPASS=${PASS} FAIL=${FAIL}`);
process.exit(FAIL ? 1 : 0);
