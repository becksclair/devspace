import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./config.js";
import { SqliteOAuthStateStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { DEVSPACE_VERSION } from "./version.js";
import { normalizeRootPolicies } from "./roots.js";

const stateDir = await mkdtemp(join(tmpdir(), "devspace-mcp-routing-test-"));
const accessToken = "test-access-token";
const protocolVersion = "2025-03-26";
const publicBaseUrl = "http://127.0.0.1:7676";
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
  rootPolicies: normalizeRootPolicies([{ path: process.cwd(), access: "read-write" }]),
  allowedHosts: ["127.0.0.1"],
  publicBaseUrl,
  minimalTools: true,
  toolNaming: "short",
  widgets: "off",
  annotationProfile: "trusted-owner",
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
  sessions: {
    idleTtlSeconds: 1800,
    sweepIntervalSeconds: 60,
  },
  logging: {
    level: "silent",
    format: "json",
    requests: false,
    assets: false,
    toolCalls: false,
    shellCommands: false,
    trustProxy: false,
  },
} satisfies ServerConfig;

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

const { app } = createServer(config);
const httpServer = app.listen(0, config.host);

try {
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });

  const address = httpServer.address() as AddressInfo;
  const baseUrl = `http://${config.host}:${address.port}`;
  const endpoint = `${baseUrl}/mcp`;
  const healthResponse = await fetch(`${baseUrl}/healthz`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    ok: true,
    name: "devspace",
    version: DEVSPACE_VERSION,
  });
  const initializeRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "routing-test", version: "1.0.0" },
    },
  };

  const invalidBatchResponse = await postMcp(endpoint, [
    { jsonrpc: "2.0", id: 2, method: "ping" },
    { ...initializeRequest, id: 3 },
  ]);
  assert.equal(invalidBatchResponse.status, 400);
  assert.equal(invalidBatchResponse.headers.get("mcp-session-id"), null);
  assert.deepEqual(await invalidBatchResponse.json(), {
    jsonrpc: "2.0",
    error: {
      code: -32600,
      message: "Invalid Request: Only one initialization request is allowed",
    },
    id: null,
  });

  const batchResponse = await postMcp(endpoint, [initializeRequest]);
  const batchSessionId = await assertInitialized(batchResponse, 1);
  await closeSession(endpoint, batchSessionId);

  const scalarResponse = await postMcp(endpoint, { ...initializeRequest, id: 4 });
  const scalarSessionId = await assertInitialized(scalarResponse, 4);
  const initializedResponse = await postMcp(
    endpoint,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    scalarSessionId,
  );
  assert.ok(initializedResponse.status === 200 || initializedResponse.status === 202);
  const toolsResponse = await postMcp(
    endpoint,
    { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
    scalarSessionId,
  );
  assert.equal(toolsResponse.status, 200);
  const toolsPayload = parseSsePayload(await toolsResponse.text()) as {
    result?: { tools?: Array<{ name?: string; description?: string; annotations?: Record<string, boolean> }> };
  };
  const tools = toolsPayload.result?.tools ?? [];
  const toolNames = new Set(tools.map((tool) => tool.name));
  const descriptions = new Map(tools.map((tool) => [tool.name, tool.description ?? ""]));
  const annotations = new Map(tools.map((tool) => [tool.name, tool.annotations]));
  for (const name of [
    "workspace_status", "close_workspace",
    "terminal_start", "terminal_read", "terminal_write", "terminal_resize", "terminal_status", "terminal_close",
  ]) {
    assert.equal(toolNames.has(name), true, `${name} should be exposed over MCP`);
  }
  assert.deepEqual(annotations.get("write"), {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(annotations.get("edit"), {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.match(descriptions.get("bash") ?? "", /Prefer terminal_start.*network interruption/);
  assert.match(descriptions.get("terminal_start") ?? "", /builds.*network interruptions/);
  assert.deepEqual(annotations.get("bash"), {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
  assert.deepEqual(annotations.get("close_workspace"), {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
  await closeSession(endpoint, scalarSessionId);
} finally {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(stateDir, { recursive: true, force: true });
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

function parseSsePayload(responseText: string): unknown {
  const dataLine = responseText.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`SSE response contained no data line: ${responseText}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

async function assertInitialized(response: Response, expectedId: number): Promise<string> {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId);

  const responseText = await response.text();
  const payload = parseSsePayload(responseText) as {
    id?: number;
    result?: { serverInfo?: { name?: string; version?: string } };
  };
  assert.equal(payload.id, expectedId);
  assert.equal(payload.result?.serverInfo?.name, "devspace");
  assert.equal(payload.result?.serverInfo?.version, DEVSPACE_VERSION);
  return sessionId;
}

async function closeSession(endpoint: string, sessionId: string): Promise<void> {
  const response = await fetch(endpoint, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "mcp-protocol-version": protocolVersion,
      "mcp-session-id": sessionId,
    },
  });
  assert.equal(response.status, 200);
}
