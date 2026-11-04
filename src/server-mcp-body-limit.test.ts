import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./config.js";
import { SqliteOAuthStateStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { normalizeRootPolicies } from "./roots.js";

const root = await mkdtemp(join(tmpdir(), "devspace-server-body-limit-test-"));
const project = join(root, "project");
const stateDir = join(root, "state");
await mkdir(project, { recursive: true });
await mkdir(stateDir, { recursive: true });
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

try {
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });

  const address = httpServer.address() as AddressInfo;
  const baseUrl = `http://${config.host}:${address.port}`;
  const endpoint = `${baseUrl}/mcp`;
  const initializeResponse = await postMcp(endpoint, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "body-limit-test", version: "1.0.0" },
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

  // A ~1 MiB write is well past body-parser's 100kb default but inside the SDK's 4 MiB limit.
  const largeContent = "0123456789abcdef".repeat(64 * 1024);
  const written = await callTool(endpoint, sessionId, nextId++, "write", {
    workspaceId,
    path: "large.txt",
    content: largeContent,
  });
  assert.notEqual(written.result?.isError, true, JSON.stringify(written.result?.content));
  assert.equal(await readFile(join(project, "large.txt"), "utf8"), largeContent);

  // Bodies over the SDK limit are still refused before reaching the transport.
  const oversized = await postMcp(
    endpoint,
    {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: {
        name: "write",
        arguments: { workspaceId, path: "oversized.txt", content: "x".repeat(4 * 1024 * 1024 + 1) },
      },
    },
    sessionId,
  );
  assert.equal(oversized.status, 413);
  await oversized.text();

  // The larger limit is scoped to /mcp; OAuth endpoints keep the default.
  const registerResponse = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://example.com/callback"], padding: "x".repeat(200 * 1024) }),
  });
  assert.equal(registerResponse.status, 413);
  await registerResponse.text();

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
