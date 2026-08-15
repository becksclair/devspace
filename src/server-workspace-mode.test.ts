import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.js";
import {
  GatewayExecutionRouter,
  type ExecutionTarget,
  type ExecutorResult,
} from "./gateway-router.js";
import type { GatewayWorkspaceStore, PublicWorkspaceBinding } from "./gateway-workspace-store.js";
import { SqliteOAuthStateStore } from "./oauth-store.js";
import { normalizeRootPolicies } from "./roots.js";
import { createServer } from "./server.js";

class MemoryStore implements GatewayWorkspaceStore {
  readonly rows = new Map<string, PublicWorkspaceBinding>();
  save(binding: PublicWorkspaceBinding): void { this.rows.set(binding.publicWorkspaceId, binding); }
  get(id: string): PublicWorkspaceBinding | undefined { return this.rows.get(id); }
  findByExecutor(machineId: string, executorWorkspaceId: string): PublicWorkspaceBinding | undefined {
    return Array.from(this.rows.values()).find((row) => row.machineId === machineId && row.executorWorkspaceId === executorWorkspaceId);
  }
  touch(id: string): void {
    const row = this.rows.get(id);
    if (row) row.lastUsedAt = new Date().toISOString();
  }
  delete(id: string): void { this.rows.delete(id); }
  deleteByExecutor(machineId: string, executorWorkspaceId: string): void {
    for (const [id, row] of this.rows) {
      if (row.machineId === machineId && row.executorWorkspaceId === executorWorkspaceId) this.rows.delete(id);
    }
  }
  ping(): void {}
  close(): void {}
}

const stateDir = mkdtempSync(join(tmpdir(), "devspace-workspace-mode-test-"));
const removeUiFixture = installUiFixture();
const accessToken = "test-workspace-mode-token";
const publicBaseUrl = "http://127.0.0.1:7676";
const protocolVersion = "2025-03-26";
const rootPolicies = normalizeRootPolicies([{ path: process.cwd(), access: "read-write" }]);
const config = {
  host: "127.0.0.1",
  port: 7676,
  oauth: {
    ownerToken: "test-owner-token-that-is-long-enough",
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 2592000,
    scopes: ["devspace"],
    allowedRedirectHosts: [],
  },
  allowedRoots: [process.cwd()],
  rootPolicies,
  allowedHosts: ["127.0.0.1"],
  publicBaseUrl,
  minimalTools: false,
  toolNaming: "short",
  widgets: "workspace",
  annotationProfile: "standard",
  stateDir,
  worktreeRoot: join(stateDir, "worktrees"),
  skillsEnabled: false,
  skillPaths: [],
  agentDir: stateDir,
  globalInstructionsFile: join(stateDir, "AGENTS.md"),
  logging: {
    level: "silent",
    format: "json",
    requests: false,
    assets: false,
    toolCalls: false,
    shellCommands: false,
    trustProxy: false,
  },
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
  sessions: {
    idleTtlSeconds: 1800,
    sweepIntervalSeconds: 60,
  },
} satisfies ServerConfig;

assert.throws(
  () => createServer(config),
  /DEVSPACE_WIDGETS=workspace is only supported in gateway mode/,
);

const privateWorkspaceId = "private-workspace";
const target: ExecutionTarget = {
  async execute(tool, args): Promise<ExecutorResult> {
    if (tool === "open_workspace") {
      return {
        content: [{ type: "text", text: "opened" }],
        structuredContent: {
          workspaceId: privateWorkspaceId,
          root: "/workspace",
          canonicalRoot: "/workspace",
          mode: "checkout",
          agentsFiles: [],
          availableAgentsFiles: [],
          skills: [],
          skillDiagnostics: [],
          capabilities: {
            logicalRoot: "/workspace",
            canonicalRoot: "/workspace",
            fileAccess: "read-write",
            mountReadOnly: false,
            runtime: {
              shellPath: "/bin/bash",
              shellMode: "service",
              tmux: true,
              userSystemd: false,
              privilegeEscalation: "available",
              filteredSecretNames: [],
            },
            warnings: [],
          },
          instruction: "reuse workspace",
        },
      };
    }
    if (tool === "run_shell") {
      return { content: [{ type: "text", text: "one\ntwo" }] };
    }
    return { content: [{ type: "text", text: String(args.workspaceId ?? "") }] };
  },
};

const store = new MemoryStore();
const router = new GatewayExecutionRouter(
  [{ id: "saga", displayName: "Saga", aliases: [], canonical: true }],
  new Map([["saga", target]]),
  store,
);
const oauthStore = new SqliteOAuthStateStore(stateDir);
oauthStore.saveToken({
  tokenHash: createHash("sha256").update(accessToken).digest("base64url"),
  tokenType: "access",
  clientId: "test-client",
  scopes: ["devspace"],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  resource: new URL(`${publicBaseUrl}/mcp`),
});
oauthStore.close();

const running = createServer(config, { gatewayRouter: router, role: "gateway" });
const httpServer = running.app.listen(0, config.host);
try {
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  const address = httpServer.address() as AddressInfo;
  const endpoint = `http://${config.host}:${address.port}/mcp`;
  const init = await postMcp(endpoint, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "workspace-mode-test", version: "1.0.0" },
    },
  });
  const sessionId = init.headers.get("mcp-session-id");
  assert.ok(sessionId);
  await init.text();
  await postMcp(endpoint, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);

  const tools = await rpc(endpoint, sessionId, 2, "tools/list", {});
  const byName = new Map((tools.result?.tools ?? []).map((tool: { name: string }) => [tool.name, tool]));
  const open = byName.get("open_workspace") as { _meta?: Record<string, unknown> } | undefined;
  const bash = byName.get("bash") as { _meta?: Record<string, unknown> } | undefined;
  const status = byName.get("workspace_status") as { _meta?: Record<string, unknown> } | undefined;
  const activity = byName.get("workspace_activity") as { _meta?: { ui?: { visibility?: string[] }; "openai/outputTemplate"?: string } } | undefined;
  assert.equal(typeof open?._meta?.["openai/outputTemplate"], "string");
  assert.equal(bash?._meta?.["openai/outputTemplate"], undefined);
  assert.equal(status?._meta?.["openai/outputTemplate"], undefined);
  assert.deepEqual(activity?._meta?.ui?.visibility, ["app"]);
  assert.equal(activity?._meta?.["openai/outputTemplate"], undefined);

  const opened = await rpc(endpoint, sessionId, 3, "tools/call", {
    name: "open_workspace",
    arguments: { path: "/workspace" },
  });
  const workspaceId = opened.result?.structuredContent?.workspaceId;
  assert.equal(typeof workspaceId, "string");

  await rpc(endpoint, sessionId, 4, "tools/call", {
    name: "bash",
    arguments: { workspaceId, command: "printf 'one\\ntwo\\n'" },
  });
  const activityResult = await rpc(endpoint, sessionId, 5, "tools/call", {
    name: "workspace_activity",
    arguments: { workspaceId, afterSeq: 0, waitMs: 0 },
  });
  const events = activityResult.result?.structuredContent?.events as Array<Record<string, unknown>>;
  assert.deepEqual(events.map((event) => [event.tool, event.status]), [
    ["run_shell", "running"],
    ["run_shell", "success"],
  ]);
  assert.equal(events[1]?.detail, "2 lines");
  assert.equal(events[1]?.label, "printf 'one\\ntwo\\n'");
} finally {
  await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  running.close?.();
  rmSync(stateDir, { recursive: true, force: true });
  removeUiFixture();
}

function installUiFixture(): () => void {
  const distDir = join(fileURLToPath(new URL("../", import.meta.url)), "dist");
  const uiDir = join(distDir, "ui");
  const viteDir = join(uiDir, ".vite");
  const assetsDir = join(uiDir, "assets");
  const manifestPath = join(viteDir, "manifest.json");
  const assetPath = join(assetsDir, "workspace-app-test.js");
  if (existsSync(manifestPath)) return () => {};

  const existed = {
    dist: existsSync(distDir),
    ui: existsSync(uiDir),
    vite: existsSync(viteDir),
    assets: existsSync(assetsDir),
    asset: existsSync(assetPath),
  };
  mkdirSync(viteDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(assetPath, "export {};\n");
  writeFileSync(manifestPath, JSON.stringify({
    "workspace-app.html": {
      file: "assets/workspace-app-test.js",
      isEntry: true,
    },
  }));

  return () => {
    rmSync(manifestPath, { force: true });
    if (!existed.asset) rmSync(assetPath, { force: true });
    if (!existed.vite) rmSync(viteDir, { recursive: true, force: true });
    if (!existed.assets) rmSync(assetsDir, { recursive: true, force: true });
    if (!existed.ui) rmSync(uiDir, { recursive: true, force: true });
    if (!existed.dist) rmSync(distDir, { recursive: true, force: true });
  };
}

async function rpc(endpoint: string, sessionId: string, id: number, method: string, params: unknown): Promise<any> {
  const response = await postMcp(endpoint, { jsonrpc: "2.0", id, method, params }, sessionId);
  assert.equal(response.status, 200);
  return parseSsePayload(await response.text());
}

function postMcp(endpoint: string, body: unknown, sessionId?: string): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(sessionId ? { "mcp-protocol-version": protocolVersion, "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

function parseSsePayload(responseText: string): any {
  const dataLine = responseText.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`SSE response contained no data line: ${responseText}`);
  return JSON.parse(dataLine.slice("data: ".length));
}
