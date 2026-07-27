#!/usr/bin/env node
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] || ".");
const manifest = JSON.parse(readFileSync(join(root, "artifact.json"), "utf8"));
if (manifest.service_id !== "devspace" || manifest.node_major !== 24 || manifest.protocol_major !== 1) throw new Error("invalid artifact manifest");
await import(join(root, "node_modules/better-sqlite3/lib/index.js"));
for (const [role, port] of [["node", 17679], ["gateway", 17676]]) {
  const config = join(root, `.smoke-${role}.json`);
  const state = join(root, `.smoke-state-${role}`);
  const value = role === "node"
    ? { role, port, machineId: "smoke", nodeTokenEnv: "SMOKE_TOKEN", allowedRoots: [root], stateDir: state, worktreeRoot: join(root, "worktrees") }
    : { role, host: "127.0.0.1", port, publicBaseUrl: `http://127.0.0.1:${port}`, stateDir: state, machines: [{ id: "smoke", displayName: "Smoke", canonical: true, kind: "local", allowedRoots: [root], stateDir: join(root, "local-state"), worktreeRoot: join(root, "local-worktrees") }] };
  writeFileSync(config, JSON.stringify(value));
  const child = spawn(process.execPath, [join(root, "dist/cli.js"), role, "--config", config], {
    cwd: root,
    env: {
      ...process.env,
      SMOKE_TOKEN: "smoke-token",
      DEVSPACE_OAUTH_OWNER_TOKEN: "smoke-owner-token-that-is-long-enough",
      DEVSPACE_CONFIG_DIR: join(root, ".smoke-empty-config"),
    },
    stdio: "ignore",
  });
  try {
    const endpoint = role === "node" ? `http://127.0.0.1:${port}/internal/v1/hello` : `http://127.0.0.1:${port}/healthz`;
    const response = await poll(endpoint, role === "node" ? { "X-DevSpace-Node-Token": "smoke-token" } : {});
    const identity = await response.json();
    if (identity.sourceCommit !== manifest.source_commit || identity.protocolMajor !== manifest.protocol_major) {
      throw new Error(`${role} runtime identity does not match artifact.json`);
    }
    if (role === "node" && identity.toolContractHash !== manifest.tool_contract_hash) {
      throw new Error("node tool contract does not match artifact.json");
    }
  } finally {
    await stopChild(child);
    for (const path of [config, state, join(root, "local-state"), join(root, "local-worktrees"), join(root, "worktrees"), join(root, ".smoke-empty-config")]) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

const leftovers = readdirSync(root).filter((name) => name.startsWith(".smoke-"));
if (leftovers.length) throw new Error(`smoke cleanup left staging files: ${leftovers.join(", ")}`);

async function poll(url, headers) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`runtime smoke endpoint did not become healthy: ${url}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 5000)),
  ]);
  if (timedOut && child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}
