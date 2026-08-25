// One number lives in five places. This asserts they agree, because every way
// they can disagree is a silent failure at a different layer:
//
//   PROTOCOL_VERSION mismatch  → the daemon closes the socket with 4000 and the
//                                extension stops reconnecting *permanently*
//   package/manifest mismatch  → a user cannot tell which extension build is
//                                loaded in which browser
//
// The package major IS the protocol version: `@wuwe1/cdp-relay@6` means "talks
// to a v6 extension". That is the whole versioning contract (README, CLAUDE.md).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const json = (p) => JSON.parse(read(p));

const problems = [];
const pkg = json("package.json");
const manifest = json("extension/manifest.json");

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

const pkgMajor = Number(pkg.version.split(".")[0]);
if (distinct.length === 1 && distinct[0] !== pkgMajor) {
  problems.push(
    `package major ${pkgMajor} !== PROTOCOL_VERSION ${distinct[0]} — ` +
      `a protocol bump is a major bump (see docs/SPEC.md)`,
  );
}

if (problems.length) {
  for (const p of problems) console.error("version:check FAIL —", p);
  process.exit(1);
}
console.log(
  `version:check OK — package ${pkg.version}, protocol v${distinct[0]}, manifest ${manifest.version}`,
);
