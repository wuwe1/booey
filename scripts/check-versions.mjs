// Two numbers, five files. This asserts they agree, because every way they can
// disagree is a silent failure at a different layer:
//
//   PROTOCOL_VERSION mismatch  → the daemon closes the socket with 4000 and the
//                                extension stops reconnecting *permanently*
//   package/manifest mismatch  → a user cannot tell which extension build is
//                                loaded in which browser
//
// The package version and the protocol version are INDEPENDENT (the package is
// on normal semver; the protocol is a wire number that only moves when the wire
// moves). `package.json#booey.protocolVersion` is the published statement of
// which protocol a release speaks, and it must match the constants in the code —
// otherwise the field is a lie a consumer would read and pin against.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const json = (p) => JSON.parse(read(p));

// The extension ID Chrome derives from manifest.key. It is pinned because the
// ID is what chrome.storage.local is scoped to: change it and every browser
// silently forgets its browserId and its label, and has to be relabeled by
// hand. Without the key at all, the ID comes from the install *path*, so simply
// moving the directory (repo → node_modules) would do the same damage.
const EXTENSION_ID = "dnjdeckelhabngmngmmmhgjnkfhadabl";

function extensionIdFromKey(base64Key) {
  const hash = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex");
  return [...hash.slice(0, 32)]
    .map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
    .join("");
}

const problems = [];
const pkg = json("package.json");
const manifest = json("extension/manifest.json");

if (!manifest.key) {
  problems.push(
    "extension/manifest.json has no `key` — the extension ID would fall back to " +
      "being derived from the install path, and every browser loses its id/label on a move",
  );
} else if (extensionIdFromKey(manifest.key) !== EXTENSION_ID) {
  problems.push(
    `extension/manifest.json key yields id ${extensionIdFromKey(manifest.key)}, expected ` +
      `${EXTENSION_ID} — a new key means every browser must be relabeled; if that is really ` +
      "intended, update EXTENSION_ID in this script in the same commit",
  );
}

if (manifest.version !== pkg.version) {
  problems.push(
    `extension/manifest.json version ${manifest.version} !== package.json ${pkg.version}`,
  );
}

const protoOf = (file, re) => {
  const m = read(file).match(re);
  return m ? Number(m[1]) : null;
};
const sources = {
  "daemon/config.ts": protoOf("daemon/config.ts", /PROTOCOL_VERSION\s*=\s*(\d+)/),
  "extension/background.js": protoOf("extension/background.js", /PROTOCOL_VERSION\s*=\s*(\d+)/),
  "daemon/test-mock-ext.ts": protoOf("daemon/test-mock-ext.ts", /PROTOCOL_VERSION\s*=\s*(\d+)/),
};
for (const [file, v] of Object.entries(sources)) {
  if (v === null) problems.push(`${file}: no PROTOCOL_VERSION found`);
}
const distinct = [...new Set(Object.values(sources).filter((v) => v !== null))];
if (distinct.length > 1) {
  problems.push(`PROTOCOL_VERSION disagrees: ${JSON.stringify(sources)}`);
}

const declared = pkg.booey?.protocolVersion;
if (typeof declared !== "number") {
  problems.push("package.json is missing booey.protocolVersion");
} else if (distinct.length === 1 && distinct[0] !== declared) {
  problems.push(
    `package.json booey.protocolVersion ${declared} !== PROTOCOL_VERSION ${distinct[0]} — ` +
      "a protocol bump has to be declared in the package too (see docs/SPEC.md)",
  );
}

if (problems.length) {
  for (const p of problems) console.error("version:check FAIL —", p);
  process.exit(1);
}
console.log(
  `version:check OK — package ${pkg.version} (speaks protocol v${distinct[0]}), ` +
    `manifest ${manifest.version}, extension id ${EXTENSION_ID}`,
);
