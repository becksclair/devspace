#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commit = process.argv[2] || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("source commit must be a full 40-character hexadecimal commit");
const output = resolve(process.env.OUTPUT_DIR || join(root, ".artifacts"));
mkdirSync(output, { recursive: true });
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lockBytes = readFileSync(join(root, "package-lock.json"));
const lockHash = `sha256:${createHash("sha256").update(lockBytes).digest("hex")}`;
const toolContractHash = readToolContractHash();
const manifest = {
  schema_version: "saga-service-artifact/v1", service_id: "devspace", source_commit: commit,
  package_version: packageJson.version, package_lock_sha256: lockHash, platform: "linux-amd64",
  node_major: 24, protocol_major: 1, tool_contract_hash: toolContractHash,
  entrypoints: { gateway: ["node", "dist/cli.js", "gateway"], node: ["node", "dist/cli.js", "node"] },
  health_path: "/healthz",
};
const stage = join(output, `.stage-${process.pid}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
try {
  cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
  cpSync(join(root, "package.json"), join(stage, "package.json"));
  cpSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));
  writeFileSync(join(stage, "dist/build-metadata.js"), `export const PROTOCOL_MAJOR = 1;\nexport function toolContractHash() { return ${JSON.stringify(toolContractHash)}; }\nexport function getBuildMetadata(role) { return { protocolMajor: 1, packageVersion: ${JSON.stringify(packageJson.version)}, sourceCommit: ${JSON.stringify(commit)}, toolContractHash: ${JSON.stringify(toolContractHash)}, ...(role ? { role } : {}) }; }\n`);
  const install = spawnSync(process.env.npm_execpath ? process.execPath : "npm", process.env.npm_execpath
    ? [process.env.npm_execpath, "ci", "--omit=dev", "--ignore-scripts=false"]
    : ["ci", "--omit=dev", "--ignore-scripts=false"], { cwd: stage, stdio: "inherit" });
  if (install.status !== 0) throw new Error(`production dependency install failed (${install.status ?? "signal"})`);
  writeFileSync(join(stage, "artifact.json"), `${JSON.stringify(manifest)}\n`);
  const smoke = spawnSync(process.execPath, [join(root, "scripts/smoke-runtime-artifact.mjs"), stage], { stdio: "inherit" });
  if (smoke.status !== 0) throw new Error("runtime artifact smoke test failed");
  const name = `devspace-linux-amd64-${commit}.tar.gz`;
  const archive = join(output, name);
  const tar = spawnSync("tar", ["-C", stage, "--sort=name", "--format=pax", "--pax-option=delete=atime,delete=ctime", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-cf", "-", "."], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 * 1024 });
  if (tar.status !== 0 || !tar.stdout) throw new Error(`tar creation failed: ${tar.stderr?.toString() || tar.error?.message || "unknown error"}`);
  const gzip = spawnSync("gzip", ["-n", "-c"], { input: tar.stdout, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1024 * 1024 * 1024 });
  if (gzip.status !== 0 || !gzip.stdout) throw new Error(`gzip creation failed: ${gzip.stderr?.toString() || gzip.error?.message || "unknown error"}`);
  writeFileSync(archive, gzip.stdout);
  const digest = createHash("sha256").update(gzip.stdout).digest("hex");
  writeFileSync(`${archive}.sha256`, `${digest}  ${name}\n`);
  console.log(`${archive}\n${digest}`);
} finally { rmSync(stage, { recursive: true, force: true }); }

function readToolContractHash() {
  const file = join(root, "dist/tool-contract.js");
  if (!existsSync(file)) throw new Error("dist/tool-contract.js is missing; run npm run build:check first");
  // Importing the built module is the authoritative, stable contract implementation.
  const hash = execFileSync(process.execPath, ["--input-type=module", "-e", 'import { TOOL_CONTRACT_HASH } from "./dist/tool-contract.js"; console.log(TOOL_CONTRACT_HASH)'], { cwd: root, encoding: "utf8" }).trim();
  const bare = hash.startsWith("sha256:") ? hash.slice(7) : hash;
  if (!/^[0-9a-f]{64}$/.test(bare)) throw new Error("tool contract hash is not a lowercase SHA-256");
  return `sha256:${bare}`;
}
