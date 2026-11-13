import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./config.js";
import { SqliteOAuthStateStore } from "./oauth-store.js";
import { normalizeRootPolicies } from "./roots.js";
import {
  answeredProtocolVersion,
  createServer,
  mcpInitializeLogFields,
  mcpRequestTraceFields,
} from "./server.js";

assert.deepEqual(
  mcpRequestTraceFields({
    jsonrpc: "2.0",
    id: 7,
    method: "resources/read",
    params: {
      uri: "ui://devspace/workspace-app-old.html?token=secret#fragment",
    },
  }),
  {
    rpcType: "request",
    rpcMethod: "resources/read",
    rpcId: 7,
    resourceUri: "ui://devspace/workspace-app-old.html",
    toolName: undefined,
    promptName: undefined,
    requestedLogLevel: undefined,
    relatedRpcId: undefined,
  },
);

assert.equal(
  mcpRequestTraceFields({
    jsonrpc: "2.0",
    id: 8,
    method: "resources/read",
    params: { uri: "ui://user:must-not-be-logged@[" },
  }).resourceUri,
  "<invalid-uri>",
);

const toolTrace = mcpRequestTraceFields({
  jsonrpc: "2.0",
  id: "tool-request",
  method: "tools/call",
  params: {
    name: "write",
    arguments: {
      path: "secret/path.txt",
      content: "must not be logged",
    },
  },
});

assert.equal(toolTrace.rpcMethod, "tools/call");
assert.equal(toolTrace.toolName, "write");
assert.doesNotMatch(JSON.stringify(toolTrace), /secret|content|arguments/);

assert.deepEqual(
  mcpRequestTraceFields({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: "original-request", reason: "private detail" },
  }),
  {
    rpcType: "notification",
    rpcMethod: "notifications/cancelled",
    rpcId: undefined,
    resourceUri: undefined,
    toolName: undefined,
    promptName: undefined,
    requestedLogLevel: undefined,
    relatedRpcId: "original-request",
  },
);

assert.deepEqual(
  mcpRequestTraceFields([
    { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://one/app.html" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read", arguments: { path: "private" } } },
    { jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "summarize" } },
    { jsonrpc: "2.0", id: 4, method: "logging/setLevel", params: { level: "debug" } },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } },
  ]),
  {
    rpcType: "batch",
    rpcBatchSize: 5,
    rpcMessages: [
      {
        rpcType: "request",
        rpcMethod: "resources/read",
        rpcId: 1,
        resourceUri: "ui://one/app.html",
      },
      {
        rpcType: "request",
        rpcMethod: "tools/call",
        rpcId: 2,
        toolName: "read",
      },
      {
        rpcType: "request",
        rpcMethod: "prompts/get",
        rpcId: 3,
        promptName: "summarize",
      },
      {
        rpcType: "request",
        rpcMethod: "logging/setLevel",
        rpcId: 4,
        requestedLogLevel: "debug",
      },
      {
        rpcType: "notification",
        rpcMethod: "notifications/cancelled",
        relatedRpcId: 2,
      },
    ],
  },
);

assert.deepEqual(mcpRequestTraceFields(undefined, "GET"), {
  rpcType: "transport",
  transportMethod: "GET",
});

assert.deepEqual(mcpRequestTraceFields(undefined, "delete"), {
  rpcType: "transport",
  transportMethod: "DELETE",
});

assert.deepEqual(mcpRequestTraceFields(null), {
  rpcType: "invalid",
  rpcBodyType: "null",
});

// --- Mcp-Protocol-Version header in the per-request trace fields ---

assert.deepEqual(
  mcpRequestTraceFields({ jsonrpc: "2.0", id: 9, method: "tools/list" }, "POST", "2025-06-18"),
  {
    rpcType: "request",
    rpcMethod: "tools/list",
    rpcId: 9,
    resourceUri: undefined,
    toolName: undefined,
    promptName: undefined,
    requestedLogLevel: undefined,
    relatedRpcId: undefined,
    protocolVersionHeader: "2025-06-18",
  },
);
assert.deepEqual(mcpRequestTraceFields(undefined, "GET", "2025-06-18"), {
  rpcType: "transport",
  transportMethod: "GET",
  protocolVersionHeader: "2025-06-18",
});
assert.deepEqual(mcpRequestTraceFields([{ jsonrpc: "2.0", method: "notifications/initialized" }], "POST", "2025-03-26"), {
  rpcType: "batch",
  rpcBatchSize: 1,
  rpcMessages: [{ rpcType: "notification", rpcMethod: "notifications/initialized" }],
  protocolVersionHeader: "2025-03-26",
});
assert.equal(
  mcpRequestTraceFields({ jsonrpc: "2.0", id: 1, method: "ping" }, "POST", "x".repeat(200)).protocolVersionHeader,
  `${"x".repeat(61)}...`,
);
assert.equal("protocolVersionHeader" in mcpRequestTraceFields({ jsonrpc: "2.0", id: 1, method: "ping" }), false);

// --- Initialize fields ---

const oversizedClientName = `client-${"n".repeat(400)}`;
assert.deepEqual(
  mcpInitializeLogFields({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: oversizedClientName, version: "4.5.6" },
    },
  }),
  {
    requestedProtocolVersion: "2025-06-18",
    clientName: `${oversizedClientName.slice(0, 125)}...`,
    clientVersion: "4.5.6",
  },
);
assert.deepEqual(
  mcpInitializeLogFields([
    { jsonrpc: "2.0", id: 2, method: "ping" },
    { jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-03-26", clientInfo: { name: "batched" } } },
  ]),
  { requestedProtocolVersion: "2025-03-26", clientName: "batched" },
);
assert.deepEqual(
  mcpInitializeLogFields({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 7, clientInfo: "nope" } }),
  {},
);
assert.deepEqual(mcpInitializeLogFields({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {});

assert.equal(answeredProtocolVersion({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }, 1), "2025-06-18");
assert.equal(answeredProtocolVersion({ jsonrpc: "2.0", id: 2, result: { protocolVersion: "2025-06-18" } }, 1), undefined);
assert.equal(answeredProtocolVersion({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "bad" } }, 1), undefined);
assert.equal(answeredProtocolVersion({ jsonrpc: "2.0", method: "notifications/message" }, undefined), undefined);

// --- End to end: the log lines a real server writes for one session ---

const stateDir = await mkdtemp(join(tmpdir(), "devspace-mcp-logging-test-"));
const accessToken = "logging-test-access-token";
const publicBaseUrl = "http://127.0.0.1:7676";
const config = {
  host: "127.0.0.1",
  port: 7676,
  oauth: {
    ownerToken: "logging-test-owner-token-long-enough",
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
  sessions: { idleTtlSeconds: 1800, sweepIntervalSeconds: 60 },
  logging: {
    level: "info",
    format: "json",
    requests: true,
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
  clientId: "logging-test-client",
  scopes: ["devspace"],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  resource: new URL(`${publicBaseUrl}/mcp`),
});
oauthStore.close();

const logLines: Record<string, unknown>[] = [];
const originalConsoleLog = console.log;
console.log = (...args: unknown[]) => {
  if (args.length === 1 && typeof args[0] === "string" && args[0].startsWith("{")) {
    try {
      logLines.push(JSON.parse(args[0]) as Record<string, unknown>);
      return;
    } catch {
      // not a log line; fall through
    }
  }
  originalConsoleLog(...args);
};

const { app } = createServer(config);
const httpServer = app.listen(0, config.host);
try {
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  const endpoint = `http://${config.host}:${(httpServer.address() as AddressInfo).port}/mcp`;
  const headers = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };

  // An unsupported requested version is answered with the server's latest version.
  const initialize = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 41,
      method: "initialize",
      params: {
        protocolVersion: "1999-01-01",
        capabilities: {},
        clientInfo: { name: oversizedClientName, version: "9.8.7" },
      },
    }),
  });
  assert.equal(initialize.status, 200);
  const sessionId = initialize.headers.get("mcp-session-id");
  assert.ok(sessionId);
  const initializeBody = await initialize.text();
  const answered = /"protocolVersion":"([^"]+)"/.exec(initializeBody)?.[1];
  assert.ok(answered && answered !== "1999-01-01");

  const followUp = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": sessionId, "mcp-protocol-version": answered },
    body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "ping" }),
  });
  assert.equal(followUp.status, 200);
  await followUp.text();

  const created = logLines.filter((line) => line.event === "mcp_session_created");
  assert.equal(created.length, 1);
  assert.equal(created[0].sessionIdPrefix, sessionId.slice(0, 8));
  assert.equal(created[0].requestedProtocolVersion, "1999-01-01");
  assert.equal(created[0].clientName, `${oversizedClientName.slice(0, 125)}...`);
  assert.equal((created[0].clientName as string).length, 128);
  assert.equal(created[0].clientVersion, "9.8.7");

  const negotiated = logLines.filter((line) => line.event === "mcp_protocol_negotiated");
  assert.equal(negotiated.length, 1);
  assert.deepEqual(
    { ...negotiated[0], ts: undefined },
    {
      ts: undefined,
      level: "info",
      event: "mcp_protocol_negotiated",
      requestId: created[0].requestId,
      sessionIdPrefix: sessionId.slice(0, 8),
      requestedProtocolVersion: "1999-01-01",
      answeredProtocolVersion: answered,
    },
  );

  const requests = logLines.filter((line) => line.event === "mcp_request");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].rpcMethod, "initialize");
  assert.equal("protocolVersionHeader" in requests[0], false);
  assert.equal(requests[1].rpcMethod, "ping");
  assert.equal(requests[1].protocolVersionHeader, answered);
  assert.doesNotMatch(JSON.stringify(logLines), new RegExp(accessToken));

  // OAuth endpoints and discovery documents are mounted routers; the request log records the path
  // the client requested, never its query string, and the same fields as any other request.
  const origin = new URL(endpoint).origin;
  const oauthRequests: Array<[string, string, string]> = [
    ["POST", "/token?code=query-value-not-logged", "/token"],
    ["GET", "/authorize?client_id=query-value-not-logged", "/authorize"],
    ["POST", "/register", "/register"],
    ["POST", "/revoke", "/revoke"],
    ["GET", "/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server"],
    ["GET", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource/mcp"],
  ];
  for (const [method, path] of oauthRequests) {
    const response = await fetch(`${origin}${path}`, {
      method,
      redirect: "manual",
      ...(method === "POST" ? { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "client_id=body-value-not-logged" } : {}),
    });
    await response.text();
  }
  const oauthLines = logLines.filter((line) => line.event === "http_request").slice(-oauthRequests.length);
  assert.deepEqual(oauthLines.map((line) => [line.method, line.path]), oauthRequests.map(([method, , logged]) => [method, logged]));
  for (const line of oauthLines) {
    const expected = ["durationMs", "event", "host", "ip", "level", "method", "path", "requestId", "status", "ts", "userAgent"];
    if (line.method === "POST") expected.push("contentLength");
    assert.deepEqual(Object.keys(line).sort(), expected.sort(), `${line.method} ${line.path}: fields`);
    assert.equal(line.level, "info");
    assert.equal(line.ip, "127.0.0.1");
    assert.equal(typeof line.status, "number");
  }
  assert.doesNotMatch(JSON.stringify(logLines), /value-not-logged/);

  await fetch(endpoint, {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}`, "mcp-session-id": sessionId, "mcp-protocol-version": answered },
  });
} finally {
  console.log = originalConsoleLog;
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(stateDir, { recursive: true, force: true });
}
