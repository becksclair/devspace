import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./config.js";
import { SqliteOAuthStateStore } from "./oauth-store.js";
import { createServer } from "./server.js";

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
  allowedHosts: ["127.0.0.1"],
  publicBaseUrl,
  minimalTools: true,
  toolNaming: "short",
  widgets: "off",
  stateDir,
  worktreeRoot: join(stateDir, "worktrees"),
  skillsEnabled: false,
  skillPaths: [],
  agentDir: stateDir,
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
  const endpoint = `http://${config.host}:${address.port}/mcp`;
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
  await closeSession(endpoint, scalarSessionId);
} finally {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(stateDir, { recursive: true, force: true });
}

function postMcp(endpoint: string, body: unknown): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function assertInitialized(response: Response, expectedId: number): Promise<string> {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId);

  const responseText = await response.text();
  const dataLine = responseText.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(dataLine);
  const payload = JSON.parse(dataLine.slice("data: ".length)) as {
    id?: number;
    result?: { serverInfo?: { name?: string } };
  };
  assert.equal(payload.id, expectedId);
  assert.equal(payload.result?.serverInfo?.name, "devspace");
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
