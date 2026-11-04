import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./config.js";
import { SqliteOAuthStateStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { DEVSPACE_VERSION } from "./version.js";
import { normalizeRootPolicies } from "./roots.js";

const root = await mkdtemp(join(tmpdir(), "devspace-server-multi-read-test-"));
const project = join(root, "project");
const stateDir = join(root, "state");
await mkdir(project, { recursive: true });
await mkdir(stateDir, { recursive: true });
await writeFile(join(project, "a.txt"), "alpha\n");
await writeFile(join(project, "b.txt"), "beta\n");
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
  allowedRoots: [root],
  rootPolicies: normalizeRootPolicies([{ path: root, access: "read-write" }]),
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

type ToolResponse = {
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
};

type ReadResult = { path: string; status: string; content?: string };

try {
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });

  const address = httpServer.address() as AddressInfo;
  const endpoint = `http://${config.host}:${address.port}/mcp`;
  const initializeResponse = await postMcp(endpoint, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "multi-read-test", version: "1.0.0" },
    },
  });
  assert.equal(initializeResponse.status, 200);
  const sessionId = initializeResponse.headers.get("mcp-session-id");
  assert.ok(sessionId);
  await initializeResponse.text();
  const initializedResponse = await postMcp(
    endpoint,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  );
  assert.ok(initializedResponse.status === 200 || initializedResponse.status === 202);

  let nextId = 2;
  const opened = await callTool(endpoint, sessionId, nextId++, "open_workspace", { path: project });
  const workspaceId = opened.result?.structuredContent?.workspaceId;
  assert.equal(typeof workspaceId, "string", JSON.stringify(opened));

  // Mixed success and failure must not be rejected by output-schema validation.
  const mixed = await callTool(endpoint, sessionId, nextId++, "multi_read", {
    workspaceId,
    reads: [{ path: "a.txt" }, { path: "missing.txt" }],
  });
  assert.notEqual(mixed.result?.isError, true, JSON.stringify(mixed.result?.content));
  const mixedStructured = mixed.result?.structuredContent as { result?: unknown; results?: ReadResult[] };
  assert.equal(typeof mixedStructured.result, "string");
  assert.ok(
    (mixedStructured.result as string).startsWith("multi_read: 2 files, 1 ok, 1 error"),
    String(mixedStructured.result),
  );
  assert.equal(mixedStructured.results?.[0]?.status, "ok");
  assert.equal(mixedStructured.results?.[0]?.content, "alpha\n");
  assert.equal(mixedStructured.results?.[1]?.status, "error");

  // All files succeed.
  const allOk = await callTool(endpoint, sessionId, nextId++, "multi_read", {
    workspaceId,
    reads: [{ path: "a.txt" }, { path: "b.txt" }],
  });
  assert.notEqual(allOk.result?.isError, true, JSON.stringify(allOk.result?.content));
  const allOkResults = (allOk.result?.structuredContent as { results?: ReadResult[] }).results ?? [];
  assert.equal(allOkResults.length, 2);
  assert.ok(allOkResults.every((r) => r.status === "ok"));

  // All files fail: existing isError behaviour is preserved.
  const allFail = await callTool(endpoint, sessionId, nextId++, "multi_read", {
    workspaceId,
    reads: [{ path: "missing-1.txt" }, { path: "missing-2.txt" }],
  });
  assert.equal(allFail.result?.isError, true);

  await closeSession(endpoint, sessionId);
} finally {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(root, { recursive: true, force: true });
}

async function callTool(
  endpoint: string,
  sessionId: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const response = await postMcp(
    endpoint,
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    sessionId,
  );
  assert.equal(response.status, 200);
  return parseSsePayload(await response.text()) as ToolResponse;
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
