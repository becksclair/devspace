// Cancelling an in-flight tools/call from an MCP client must abort the signal that reaches the
// work behind it: the local executor (a running shell command) and a bridged T3 Code call (the
// fake T3 sees its own request cancelled). Both run through the real Streamable HTTP endpoint.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ServerConfig } from "./config.js";
import { SqliteOAuthStateStore } from "./oauth-store.js";
import { normalizeRootPolicies } from "./roots.js";
import { createServer } from "./server.js";
import { T3Bridge } from "./t3-bridge.js";
import { FakeT3 } from "./testing/fake-t3.js";
import { waitFor } from "./testing/t3-checks.js";

const watchdog = setTimeout(() => {
  process.stderr.write("server-mcp-cancellation.test: timed out after 90 s\n");
  process.exit(1);
}, 90_000);
watchdog.unref();

const accessToken = "cancellation-test-access-token";
const stateDir = await mkdtemp(join(tmpdir(), "devspace-mcp-cancel-state-"));
const workDir = await realpath(await mkdtemp(join(tmpdir(), "devspace-mcp-cancel-work-")));
const publicBaseUrl = "http://127.0.0.1:7676";
const fake = await FakeT3.start({ completionDelayMs: 5 });
const bridge = new T3Bridge({
  config: { enabled: true, cliPath: fake.cliPath, runtimeFile: fake.runtimeFile },
  label: "devspace-mcp-cancellation-test",
  secretNames: [],
});

const config = {
  host: "127.0.0.1",
  port: 7676,
  oauth: {
    ownerToken: "cancellation-test-owner-token-long-enough",
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 2592000,
    scopes: ["devspace"],
    allowedRedirectHosts: [],
  },
  allowedRoots: [workDir],
  rootPolicies: normalizeRootPolicies([{ path: workDir, access: "read-write" }]),
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
    level: "silent",
    format: "json",
    requests: false,
    assets: false,
    toolCalls: false,
    shellCommands: false,
    trustProxy: false,
  },
  t3: { enabled: true, cliPath: fake.cliPath, runtimeFile: fake.runtimeFile },
} satisfies ServerConfig;

const oauthStore = new SqliteOAuthStateStore(stateDir);
oauthStore.saveToken({
  tokenHash: createHash("sha256").update(accessToken).digest("base64url"),
  tokenType: "access",
  clientId: "cancellation-test-client",
  scopes: ["devspace"],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  resource: new URL(`${publicBaseUrl}/mcp`),
});
oauthStore.close();

const { app } = createServer(config, { t3Bridge: bridge });
const httpServer = app.listen(0, "127.0.0.1");
const client = new Client({ name: "cancellation-test", version: "1.0.0" });

/** Starts a tool call, waits until `started` holds, aborts it, and returns the client's rejection. */
async function cancelInFlight(name: string, args: Record<string, unknown>, started: () => Promise<boolean> | boolean): Promise<unknown> {
  const controller = new AbortController();
  const call = client.callTool({ name, arguments: args }, { signal: controller.signal, timeout: 60_000 });
  const settled = call.then(
    () => assert.fail(`${name} completed instead of being cancelled`),
    (error: unknown) => error,
  );
  await waitFor(`${name} to start`, started, 10_000);
  controller.abort(new Error("cancelled by the test"));
  return settled;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

try {
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  const { port } = httpServer.address() as AddressInfo;
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );

  // (a) Local executor: the running shell command is killed once the call is cancelled.
  const opened = await client.callTool({ name: "open_workspace", arguments: { path: workDir } });
  const workspaceId = (opened.structuredContent as { workspaceId?: string } | undefined)?.workspaceId;
  assert.ok(workspaceId, "open_workspace returns a workspaceId");
  const pidFile = join(workDir, "cancel.pid");
  let pid = 0;
  await cancelInFlight("bash", { workspaceId, command: "echo $$ > cancel.pid && exec sleep 30" }, async () => {
    pid = Number.parseInt(await readFile(pidFile, "utf8").catch(() => ""), 10);
    return Number.isInteger(pid) && pid > 0;
  });
  await waitFor("the cancelled shell command to exit", () => !processAlive(pid), 10_000);
  process.stdout.write("ok - cancelling a tools/call aborts the local executor's shell command\n");

  // (b) Bridged T3 call: the abort is forwarded, so T3's own request is cancelled.
  const waiting = fake.addThread({ title: "Cancelled wait", status: "running" });
  const mark = fake.calls.length;
  await cancelInFlight("t3_thread_wait", { threadId: waiting.threadId, timeoutMs: 30_000 }, () =>
    fake.calls.slice(mark).some((call) => call.tool === "t3_thread_wait"),
  );
  await waitFor("T3 to see its call cancelled", () => fake.cancelledCalls.includes("t3_thread_wait"), 10_000);
  process.stdout.write("ok - cancelling a tools/call aborts the bridged T3 Code call\n");
} finally {
  await client.close().catch(() => undefined);
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
    httpServer.closeAllConnections();
  });
  await bridge.close().catch(() => undefined);
  await fake.stop();
  await rm(stateDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
  clearTimeout(watchdog);
}

process.stdout.write("server-mcp-cancellation.test: all checks passed\n");
