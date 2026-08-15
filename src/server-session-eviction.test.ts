import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./config.js";
import { SqliteOAuthStateStore } from "./oauth-store.js";
import { normalizeRootPolicies } from "./roots.js";
import { createServer } from "./server.js";

const stateDir = await mkdtemp(join(tmpdir(), "devspace-session-eviction-test-"));
const accessToken = "test-session-eviction-token";
const protocolVersion = "2025-03-26";
const publicBaseUrl = "http://127.0.0.1:7676";

function serverConfig(sessions: ServerConfig["sessions"]): ServerConfig {
  return {
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
    sessions,
    logging: {
      level: "silent",
      format: "json",
      requests: false,
      assets: false,
      toolCalls: false,
      shellCommands: false,
      trustProxy: false,
    },
  };
}

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface RunningTestServer {
  endpoint: string;
  close: () => Promise<void>;
}

async function startServer(config: ServerConfig): Promise<RunningTestServer> {
  const running = createServer(config);
  const httpServer = running.app.listen(0, config.host);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  const address = httpServer.address() as AddressInfo;
  return {
    endpoint: `http://${config.host}:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        running.close?.();
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function postMcp(endpoint: string, body: unknown, sessionId?: string): Promise<Response> {
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

async function initializeSession(endpoint: string): Promise<string> {
  const response = await postMcp(endpoint, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "session-eviction-test", version: "1.0.0" },
    },
  });
  assert.equal(response.status, 200);
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  await response.text();
  const initialized = await postMcp(
    endpoint,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  );
  assert.ok(initialized.status === 200 || initialized.status === 202);
  await initialized.text();
  return sessionId;
}

async function ping(endpoint: string, sessionId: string, id: number): Promise<Response> {
  return postMcp(endpoint, { jsonrpc: "2.0", id, method: "ping" }, sessionId);
}

// An idle session must be evicted by the sweep: the transport closes and the
// stale session id is rejected on the next request.
const idleServer = await startServer(serverConfig({ idleTtlSeconds: 1, sweepIntervalSeconds: 1 }));
try {
  const sessionId = await initializeSession(idleServer.endpoint);
  const warm = await ping(idleServer.endpoint, sessionId, 2);
  assert.ok(warm.status === 200 || warm.status === 202);
  await warm.text();

  await sleep(3500);

  const stale = await ping(idleServer.endpoint, sessionId, 3);
  assert.equal(stale.status, 404);
  const payload = (await stale.json()) as { error?: { message?: string } };
  assert.equal(payload.error?.message, "Unknown MCP session");
} finally {
  await idleServer.close();
}

// A session that keeps receiving requests must survive the sweep.
const activeServer = await startServer(serverConfig({ idleTtlSeconds: 3, sweepIntervalSeconds: 1 }));
try {
  const sessionId = await initializeSession(activeServer.endpoint);
  for (let tick = 0; tick < 4; tick += 1) {
    await sleep(900);
    const keepAlive = await ping(activeServer.endpoint, sessionId, 10 + tick);
    assert.ok(keepAlive.status === 200 || keepAlive.status === 202);
    await keepAlive.text();
  }
  const final = await ping(activeServer.endpoint, sessionId, 20);
  assert.ok(final.status === 200 || final.status === 202);
  await final.text();
} finally {
  await activeServer.close();
}

await rm(stateDir, { recursive: true, force: true });
