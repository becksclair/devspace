// Pins the per-tool metadata every MCP host sees in tools/list, over HTTP, for every widgets mode,
// annotation profile, and tool mode (standalone and gateway), including the bridged node_repl,
// sky-cua (a fake stdio binary), and T3 (an offline bridge serving its static catalog) tools:
// every tool states readOnlyHint, destructiveHint, and openWorldHint explicitly.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnnotationProfile, ServerConfig, WidgetMode } from "./config.js";
import { GatewayExecutionRouter, type ExecutionTarget } from "./gateway-router.js";
import type { GatewayWorkspaceStore, PublicWorkspaceBinding } from "./gateway-workspace-store.js";
import { SqliteOAuthStateStore } from "./oauth-store.js";
import { normalizeRootPolicies } from "./roots.js";
import { createServer } from "./server.js";
import { T3Bridge, T3_TOOL_NAMES } from "./t3-bridge.js";

const accessToken = "tool-metadata-test-access-token";
const protocolVersion = "2025-11-25";
const publicBaseUrl = "http://127.0.0.1:7676";
const HINTS = ["readOnlyHint", "destructiveHint", "openWorldHint"] as const;

interface WireTool {
  name: string;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

// Widgets need the manifest entry and its asset; write placeholders when there is no UI build.
const uiDir = join(fileURLToPath(new URL("../dist/", import.meta.url)), "ui");
const manifestPath = join(uiDir, ".vite", "manifest.json");
const placeholderUi = !existsSync(manifestPath);
const createdDist = !existsSync(join(uiDir, ".."));
const createdUi = !existsSync(uiDir);
if (placeholderUi) {
  await mkdir(join(uiDir, ".vite"), { recursive: true });
  await mkdir(join(uiDir, "assets"), { recursive: true });
  await writeFile(join(uiDir, "assets", "workspace-app-placeholder.js"), "export {};\n");
  await writeFile(manifestPath, JSON.stringify({ "workspace-app.html": { file: "assets/workspace-app-placeholder.js" } }));
}

// A stdio MCP server standing in for sky-cua: one tool with full upstream hints, one read-only,
// one with no annotations, and one whose annotations carry only a title.
const fakeSkyRoot = await mkdtemp(join(tmpdir(), "devspace-fake-sky-cua-"));
const fakeSkyBin = join(fakeSkyRoot, "bin", "sky-cua-client");
const FAKE_SKY_TOOLS = ["phone_pointer", "status", "browser_navigate", "observe"];
await mkdir(join(fakeSkyRoot, "bin"));
await writeFile(fakeSkyBin, `#!/usr/bin/env node
const tools = [
  { name: "phone_pointer", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  { name: "status", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "browser_navigate", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
  { name: "observe", inputSchema: { type: "object", properties: {} }, annotations: { title: "Observe" } },
];
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const result = message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-sky-cua", version: "0.0.0" } }
      : message.method === "tools/list" ? { tools } : message.method === "ping" ? {} : undefined;
    process.stdout.write(JSON.stringify(result
      ? { jsonrpc: "2.0", id: message.id, result }
      : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } }) + "\\n");
  }
});
`);
await chmod(fakeSkyBin, 0o755);

class MemoryStore implements GatewayWorkspaceStore {
  readonly rows = new Map<string, PublicWorkspaceBinding>();
  save(binding: PublicWorkspaceBinding): void { this.rows.set(binding.publicWorkspaceId, binding); }
  get(id: string): PublicWorkspaceBinding | undefined { return this.rows.get(id); }
  findByExecutor(): PublicWorkspaceBinding | undefined { return undefined; }
  touch(): void {}
  delete(id: string): void { this.rows.delete(id); }
  deleteByExecutor(): void {}
  ping(): void {}
  close(): void {}
}

function configFor(stateDir: string, widgets: WidgetMode, annotationProfile: AnnotationProfile, minimalTools: boolean): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7676,
    oauth: {
      ownerToken: "tool-metadata-test-owner-token-long-enough",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 2592000,
      scopes: ["devspace"],
      allowedRedirectHosts: [],
    },
    allowedRoots: [process.cwd()],
    rootPolicies: normalizeRootPolicies([{ path: process.cwd(), access: "read-write" }]),
    allowedHosts: ["127.0.0.1"],
    publicBaseUrl,
    minimalTools,
    toolNaming: "short",
    widgets,
    annotationProfile,
    stateDir,
    worktreeRoot: join(stateDir, "worktrees"),
    skillsEnabled: false,
    skillPaths: [],
    agentDir: stateDir,
    globalInstructionsFile: join(stateDir, "AGENTS.md"),
    shell: { mode: "service" },
    secretNames: ["DEVSPACE_OAUTH_OWNER_TOKEN"],
    terminals: {
      backend: "tmux",
      runtimeDir: join(stateDir, "terminal-runtime"),
      maxPerWorkspace: 2,
      maxTotal: 4,
      idleTtlSeconds: 3600,
      useUserSystemd: false,
    },
    maintenance: {
      intervalSeconds: 3600,
      closedSessionTtlSeconds: 604800,
      checkoutIdleTtlSeconds: 2592000,
      isolatedIdleTtlSeconds: 604800,
    },
    sessions: { idleTtlSeconds: 1800, sweepIntervalSeconds: 60 },
    logging: { level: "silent", format: "json", requests: false, assets: false, toolCalls: false, shellCommands: false, trustProxy: false },
    skyCua: { projectRoot: fakeSkyRoot, binPath: fakeSkyBin },
    t3: { enabled: true, cliPath: join(fakeSkyRoot, "no-t3-cli"), runtimeFile: join(fakeSkyRoot, "no-t3-runtime.json") },
  };
}

async function post(endpoint: string, body: unknown, sessionId?: string): Promise<{ sessionId?: string; result?: unknown; error?: unknown }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(sessionId ? { "mcp-protocol-version": protocolVersion, "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${JSON.stringify(body)} answered HTTP ${response.status}`);
  const text = await response.text();
  const data = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("");
  const message = data ? (JSON.parse(data) as { result?: unknown; error?: unknown }) : undefined;
  return { sessionId: response.headers.get("mcp-session-id") ?? undefined, result: message?.result, error: message?.error };
}

async function listTools(widgets: WidgetMode, profile: AnnotationProfile, minimalTools: boolean, gateway: boolean): Promise<WireTool[]> {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-tool-metadata-"));
  const store = new SqliteOAuthStateStore(stateDir);
  store.saveToken({
    tokenHash: createHash("sha256").update(accessToken).digest("base64url"),
    tokenType: "access",
    clientId: "tool-metadata-test-client",
    scopes: ["devspace"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    resource: new URL(`${publicBaseUrl}/mcp`),
  });
  store.close();
  const config = configFor(stateDir, widgets, profile, minimalTools);
  const t3Bridge = new T3Bridge({
    config: config.t3!,
    label: "tool-metadata-test",
    secretNames: [],
    catalogTimeoutMs: 50,
    resolveOrigin: async () => { throw new Error("T3 is offline in this test"); },
  });
  const target: ExecutionTarget = { async execute() { return { content: [{ type: "text", text: "unused" }] }; } };
  const gatewayRouter = gateway
    ? new GatewayExecutionRouter([{ id: "local", displayName: "Local", aliases: [], canonical: true }], new Map([["local", target]]), new MemoryStore())
    : undefined;
  const running = createServer(config, gateway ? { t3Bridge, gatewayRouter, role: "gateway" } : { t3Bridge });
  const httpServer = running.app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("listening", resolve);
      httpServer.once("error", reject);
    });
    const endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
    const initialized = await post(endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "tool-metadata-test", version: "1.0.0" } },
    });
    assert.ok(initialized.sessionId, "initialize assigns a session");
    await post(endpoint, { jsonrpc: "2.0", method: "notifications/initialized" }, initialized.sessionId);
    const listed = await post(endpoint, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, initialized.sessionId);
    assert.equal(listed.error, undefined, "tools/list succeeds");
    return (listed.result as { tools: WireTool[] }).tools;
  } finally {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeAllConnections();
    });
    running.close?.();
    await rm(stateDir, { recursive: true, force: true });
  }
}

const cases: Array<{ widgets: WidgetMode; gateway: boolean }> = [
  { widgets: "off", gateway: false },
  { widgets: "changes", gateway: false },
  { widgets: "full", gateway: false },
  { widgets: "workspace", gateway: true },
  { widgets: "full", gateway: true },
];

try {
  for (const { widgets, gateway } of cases) {
    for (const profile of ["standard", "trusted-owner"] as const) {
      for (const minimalTools of [false, true]) {
        const label = `${gateway ? "gateway" : "standalone"} widgets=${widgets} profile=${profile} minimal=${minimalTools}`;
        const tools = await listTools(widgets, profile, minimalTools, gateway);
        const names = new Set(tools.map((tool) => tool.name));
        for (const name of [...FAKE_SKY_TOOLS, ...T3_TOOL_NAMES, "js", "js_reset", "js_add_node_module_dir"]) {
          assert.ok(names.has(name), `${label}: bridged tool ${name} is listed`);
        }
        if (gateway) assert.ok(names.has("show_changes"), `${label}: show_changes is listed`);
        if (widgets === "workspace") assert.ok(names.has("workspace_activity"), `${label}: workspace_activity is listed`);

        for (const tool of tools) {
          for (const hint of HINTS) {
            assert.equal(typeof tool.annotations?.[hint], "boolean", `${label}: ${tool.name} states ${hint} explicitly`);
          }
          if (tool.annotations?.readOnlyHint === true) {
            assert.equal(tool.annotations.destructiveHint, false, `${label}: read-only ${tool.name} is not destructive`);
          }
        }
        process.stdout.write(`ok - ${label}: ${tools.length} tools state all three hints\n`);
      }
    }
  }
} finally {
  await rm(fakeSkyRoot, { recursive: true, force: true });
  if (placeholderUi) {
    if (createdDist) await rm(join(uiDir, ".."), { recursive: true, force: true });
    else if (createdUi) await rm(uiDir, { recursive: true, force: true });
    else await Promise.all([manifestPath, join(uiDir, "assets", "workspace-app-placeholder.js")].map((path) => rm(path, { force: true })));
  }
}

process.stdout.write("server-tool-metadata.test: all checks passed\n");
