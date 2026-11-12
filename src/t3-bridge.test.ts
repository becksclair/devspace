// Unit suite for the T3 Code bridge (plan 015): the bridge module against the fake T3 over HTTP,
// with the fake CLI as the real child process. Covers the behavior matrix's Unit column (B25 is in
// config.test.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { AnnotationProfile, ServerConfig, T3BridgeConfig } from "./config.js";
import type { LoggingConfig } from "./logger.js";
import { normalizeRootPolicies } from "./roots.js";
import {
  createT3CliRunner,
  createT3OriginResolver,
  createT3TokenProvider,
  registerT3Tools,
  sharedT3Bridge,
  T3_CAPABILITY,
  T3_FORWARDED_TOOLS,
  T3_INBOX_TOOL,
  T3_TOOL_NAMES,
  T3_UNREACHABLE_MESSAGE,
  T3Bridge,
  t3SessionLabel,
  type T3BridgeOptions,
  type T3CliRunner,
  type T3ToolDefinition,
  type T3TokenProvider,
} from "./t3-bridge.js";
import { FakeT3, type FakeT3Options } from "./testing/fake-t3.js";
import {
  captureConsole,
  checkCatalog,
  checkCliEnvironment,
  checkCredentialRecovery,
  checkDroppedLaunch,
  checkFullAccessMint,
  checkInbox,
  checkInboxCompleteness,
  checkInboxOmitted,
  checkListing,
  checkNoBlindRetry,
  checkPhase2Retries,
  checkProjects,
  checkScheduledTasks,
  checkThreadUpdate,
  checkNoSecrets,
  checkReading,
  checkRestart,
  checkShaping,
  checkUnavailable,
  fails,
  forwarded,
  ok,
  pairingCount,
  recordingCall,
  resultText,
  waitFor,
  type CatalogTool,
  type T3Call,
} from "./testing/t3-checks.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SECRET_NAME = "DEVSPACE_T3_TEST_SECRET";
process.env[SECRET_NAME] = "configured-secret-that-must-not-reach-the-t3-cli";
process.env.GH_TOKEN ??= "github-token-that-must-not-reach-the-t3-cli";

const watchdog = setTimeout(() => {
  process.stderr.write("t3-bridge.test: timed out after 120 s\n");
  process.exit(1);
}, 120_000);
watchdog.unref();

const debugLogging: LoggingConfig = {
  level: "debug",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
};

const tempDir = await mkdtemp(join(tmpdir(), "devspace-t3-bridge-test-"));
const consoleCapture = captureConsole();
const fakes: FakeT3[] = [];
const bridges: T3Bridge[] = [];
const outputs: string[] = [];

function progress(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function startFake(options: FakeT3Options = {}): Promise<FakeT3> {
  const fake = await FakeT3.start({ completionDelayMs: 5, ...options });
  fakes.push(fake);
  return fake;
}

/** An origin on a port nothing listens on (connection refused). */
async function closedOrigin(): Promise<string> {
  const server = createHttpServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return `http://127.0.0.1:${port}`;
}

function countingProvider(provider: T3TokenProvider, counter: { getToken: number }): T3TokenProvider {
  return {
    getToken() {
      counter.getToken += 1;
      return provider.getToken();
    },
    refresh: () => provider.refresh(),
    revokeOwnSessions: () => provider.revokeOwnSessions(),
  };
}

function rows(data: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = data[key];
  assert.ok(Array.isArray(value), `${key} is an array`);
  return value as Array<Record<string, unknown>>;
}

function t3Config(fake: FakeT3): T3BridgeConfig {
  return { enabled: true, cliPath: fake.cliPath, runtimeFile: fake.runtimeFile };
}

function newBridge(fake: FakeT3, label: string, overrides: Partial<T3BridgeOptions> = {}): T3Bridge {
  const bridge = new T3Bridge({ config: t3Config(fake), label, secretNames: [SECRET_NAME], logging: debugLogging, ...overrides });
  bridges.push(bridge);
  return bridge;
}

function callerFor(bridge: T3Bridge): T3Call {
  const recorder = recordingCall((name, args) => bridge.call(name, args ?? {}));
  return async (name, args) => {
    const result = await recorder.call(name, args);
    outputs.push(...recorder.outputs.splice(0));
    return result;
  };
}

function countingRunner(runner: T3CliRunner, runs: string[][]): T3CliRunner {
  return {
    run(args, signal) {
      runs.push(args);
      return runner.run(args, signal);
    },
  };
}

async function captureError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputs.push(message);
    return message;
  }
  assert.fail("expected a rejection");
}

function serverConfig(stateDir: string, t3: T3BridgeConfig | undefined): ServerConfig {
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
    publicBaseUrl: "http://127.0.0.1:7676",
    minimalTools: true,
    toolNaming: "short",
    widgets: "off",
    annotationProfile: "standard",
    stateDir,
    worktreeRoot: join(stateDir, "worktrees"),
    skillsEnabled: false,
    skillPaths: [],
    agentDir: stateDir,
    globalInstructionsFile: join(stateDir, "AGENTS.md"),
    shell: { mode: "service" },
    secretNames: ["DEVSPACE_OAUTH_OWNER_TOKEN", SECRET_NAME],
    terminals: { backend: "tmux", runtimeDir: join(stateDir, "terminal-runtime"), maxPerWorkspace: 2, maxTotal: 4, idleTtlSeconds: 3600, useUserSystemd: false },
    maintenance: { intervalSeconds: 3600, closedSessionTtlSeconds: 604800, checkoutIdleTtlSeconds: 2592000, isolatedIdleTtlSeconds: 604800 },
    sessions: { idleTtlSeconds: 1800, sweepIntervalSeconds: 60 },
    logging: debugLogging,
    ...(t3 ? { t3 } : {}),
  };
}

async function connectRegistered(bridge: T3Bridge, profile: AnnotationProfile): Promise<{ client: Client; close(): Promise<void> }> {
  const server = new McpServer({ name: "t3-unit", version: "1.0.0" });
  await registerT3Tools(server, bridge, profile);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "t3-unit-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function mcpCaller(client: Client): T3Call {
  return async (name, args) => {
    const result = (await client.callTool({ name, arguments: args ?? {} })) as CallToolResult;
    outputs.push(JSON.stringify(result));
    return result;
  };
}

try {
  // -----------------------------------------------------------------------------------------
  // Exports, labels, and the shared instance
  // -----------------------------------------------------------------------------------------
  assert.equal(T3_CAPABILITY, "t3");
  assert.equal(T3_INBOX_TOOL, "t3_inbox");
  assert.deepEqual([...T3_TOOL_NAMES], [
    "t3_project_list",
    "t3_thread_search",
    "t3_thread_list",
    "t3_thread_read",
    "t3_thread_wait",
    "t3_inbox",
    "t3_thread_launch",
    "t3_thread_send",
    "t3_thread_interrupt",
    "t3_pending_request",
    "t3_thread_organize",
    "t3_queue",
    "t3_thread_update",
    "orchestrator_capabilities",
    "t3_project_create",
    "t3_project_clone",
    "t3_project_update",
    "list_scheduled_tasks",
    "schedule_task",
    "run_scheduled_task_now",
    "delete_scheduled_task",
  ]);
  assert.deepEqual([...T3_FORWARDED_TOOLS], T3_TOOL_NAMES.filter((name) => name !== T3_INBOX_TOOL));
  const stateLabel = t3SessionLabel(join(tempDir, "state"));
  assert.match(stateLabel, /^devspace-t3-bridge:[0-9a-f]{10}$/);
  assert.equal(t3SessionLabel(`${join(tempDir, "state")}/`), stateLabel, "the label uses the resolved state directory");
  assert.notEqual(t3SessionLabel(join(tempDir, "other-state")), stateLabel);

  const disabledConfig = serverConfig(join(tempDir, "state"), { enabled: false, cliPath: "/nonexistent/t3", runtimeFile: "/nonexistent/runtime.json" });
  assert.equal(sharedT3Bridge(disabledConfig), undefined);
  assert.equal(sharedT3Bridge(serverConfig(join(tempDir, "state"), undefined)), undefined);
  const enabledConfig = serverConfig(join(tempDir, "state"), { enabled: true, cliPath: "/nonexistent/t3", runtimeFile: "/nonexistent/runtime.json" });
  const shared = sharedT3Bridge(enabledConfig);
  assert.ok(shared instanceof T3Bridge);
  assert.equal(sharedT3Bridge({ ...enabledConfig }), shared, "one bridge per process for the same settings and state");
  const otherShared = sharedT3Bridge(serverConfig(join(tempDir, "other-state"), enabledConfig.t3));
  assert.ok(otherShared && otherShared !== shared, "a different state directory gets its own bridge");
  assert.equal(resultText(await shared.call("t3_project_list", {})), T3_UNREACHABLE_MESSAGE, "a missing runtime file is unreachable");
  await shared.close();
  await otherShared.close();
  progress("ok - exports, session labels, shared instance");

  // -----------------------------------------------------------------------------------------
  // CLI runner and token provider: B4, B7, B24, single-flight, revoke before mint
  // -----------------------------------------------------------------------------------------
  const cliFake = await startFake();
  const runner = createT3CliRunner(cliFake.cliPath, [SECRET_NAME]);
  assert.ok(Array.isArray(JSON.parse(await runner.run(["auth", "session", "list", "--json"]))));
  assert.equal(await captureError(runner.run(["auth", "bogus"])), "T3 CLI auth bogus exited with 2.");
  assert.equal(
    await captureError(createT3CliRunner(join(tempDir, "missing-t3"), []).run(["auth", "session", "list", "--json"])),
    `T3 CLI not found at ${join(tempDir, "missing-t3")}.`,
  );

  const runs: string[][] = [];
  let clock = Date.now();
  const providerLabel = "devspace-t3-bridge:unit-provider";
  const provider = createT3TokenProvider({
    runner: countingRunner(runner, runs),
    resolveOrigin: async () => cliFake.origin,
    label: providerLabel,
    now: () => clock,
  });
  const firstTokens = await Promise.all([provider.getToken(), provider.getToken(), provider.refresh()]);
  assert.equal(new Set(firstTokens).size, 1, "concurrent getToken and refresh share one mint");
  assert.equal(pairingCount(cliFake, providerLabel), 1);
  assert.deepEqual(
    runs.map((args) => args.slice(0, 3).join(" ")),
    ["auth session list", "auth pairing create"],
    "the label's sessions are listed (and revoked) before the pairing code is created",
  );
  await checkFullAccessMint(cliFake, providerLabel, [SECRET_NAME]);

  const otherLabel = "devspace-t3-bridge:unit-other";
  const otherProvider = createT3TokenProvider({ runner, resolveOrigin: async () => cliFake.origin, label: otherLabel });
  await otherProvider.getToken();
  const refreshed = await provider.refresh();
  assert.notEqual(refreshed, firstTokens[0]);
  assert.equal(pairingCount(cliFake, providerLabel), 2);
  assert.equal(cliFake.liveSessions(providerLabel), 1, "revoke before mint keeps one session for the label");
  assert.equal(cliFake.liveSessions(otherLabel), 1, "other labels' sessions are left alone");
  assert.ok(runs.some((args) => args.slice(0, 3).join(" ") === "auth session revoke"));

  // B7: cached while more than three days remain, re-minted when fewer remain.
  clock += 26 * DAY_MS;
  assert.equal(await provider.getToken(), refreshed, "four days left: cached");
  assert.equal(pairingCount(cliFake, providerLabel), 2);
  clock += 1.5 * DAY_MS;
  const renewed = await provider.getToken();
  assert.notEqual(renewed, refreshed, "fewer than three days left: re-minted");
  assert.equal(pairingCount(cliFake, providerLabel), 3);
  assert.equal(cliFake.liveSessions(providerLabel), 1);
  assert.equal(await provider.getToken(), renewed);

  // B7: the renewal margin is min(three days, 10% of the lifetime), so a one-hour token is reused
  // until its last six minutes instead of being re-minted on every call.
  const shortFake = await startFake({ tokenTtlSeconds: 3_600 });
  const shortLabel = "devspace-t3-bridge:unit-short-ttl";
  let shortClock = Date.now();
  const shortProvider = createT3TokenProvider({
    runner: createT3CliRunner(shortFake.cliPath, [SECRET_NAME]),
    resolveOrigin: async () => shortFake.origin,
    label: shortLabel,
    now: () => shortClock,
  });
  const shortToken = await shortProvider.getToken();
  for (let call = 0; call < 3; call += 1) assert.equal(await shortProvider.getToken(), shortToken, "a fresh one-hour token is reused");
  shortClock += 50 * 60_000;
  assert.equal(await shortProvider.getToken(), shortToken, "ten minutes left (more than 10%): cached");
  assert.equal(pairingCount(shortFake, shortLabel), 1, "no re-mint while more than 10% of the lifetime remains");
  shortClock += 5 * 60_000;
  assert.notEqual(await shortProvider.getToken(), shortToken, "five minutes left (less than 10%): re-minted");
  assert.equal(pairingCount(shortFake, shortLabel), 2);
  await shortProvider.revokeOwnSessions();

  assert.equal(await provider.revokeOwnSessions(), 1);
  assert.equal(cliFake.liveSessions(providerLabel), 0);
  assert.equal(cliFake.liveSessions(otherLabel), 1);
  assert.equal(await otherProvider.revokeOwnSessions(), 1);

  // Unreachable T3: no CLI work, so no dangling pairing codes.
  await cliFake.setAvailable(false);
  const runsBefore = runs.length;
  const coldProvider = createT3TokenProvider({
    runner: countingRunner(runner, runs),
    resolveOrigin: async () => cliFake.origin,
    label: "devspace-t3-bridge:unit-cold",
  });
  assert.equal(await captureError(coldProvider.getToken()), T3_UNREACHABLE_MESSAGE);
  assert.equal(runs.length, runsBefore, "no CLI call while T3 is down");
  await cliFake.setAvailable(true);
  const missingProvider = createT3TokenProvider({
    runner: countingRunner(runner, runs),
    resolveOrigin: createT3OriginResolver({ ...t3Config(cliFake), runtimeFile: join(tempDir, "missing-runtime.json") }),
    label: "devspace-t3-bridge:unit-missing",
  });
  assert.equal(await captureError(missingProvider.getToken()), T3_UNREACHABLE_MESSAGE);
  assert.equal(runs.length, runsBefore);
  checkCliEnvironment(cliFake, SECRET_NAME);
  progress("ok - CLI runner and token provider (B4, B7, B24; renewal margin relative to lifetime)");

  // -----------------------------------------------------------------------------------------
  // Catalog and registration: B2, B3, B8 (cold start), B12, B15, B17
  // -----------------------------------------------------------------------------------------
  const catalogFake = await startFake();
  const catalogBridge = newBridge(catalogFake, "devspace-t3-bridge:unit-catalog");
  const definitions = await catalogBridge.toolDefinitions();
  assert.ok(definitions.every((definition) => definition.live), "the first fetch loads the live catalog");
  assert.ok(definitions.every((definition) => definition.title.length > 0));
  checkCatalog(definitions.map((definition): CatalogTool => ({ ...definition })));
  const readDefinition = definitions.find((definition) => definition.name === "t3_thread_read");
  assert.match(String(readDefinition?.description), /returns the latest `limit` messages \(default 6\)/);

  for (const profile of ["standard", "trusted-owner"] as const) {
    const registered = await connectRegistered(catalogBridge, profile);
    try {
      const { tools } = await registered.client.listTools();
      checkCatalog(tools as CatalogTool[], { annotationProfile: profile });
      const registeredCall = mcpCaller(registered.client);
      const launched = await ok(registeredCall, "t3_thread_launch", {
        scratch: true,
        title: `Registered launch ${profile}`,
        message: "Reply with exactly OK",
        modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
        runtimeMode: "approval-required",
      });
      const launch = [...catalogFake.calls].reverse().find((entry) => entry.tool === "t3_thread_launch");
      assert.equal(launch?.args.runtimeMode, "full-access");
      assert.deepEqual(launch?.args.modelSelection, { instanceId: "claudeAgent", model: "claude-haiku-5-5" });
      await ok(registeredCall, "t3_thread_organize", { threadId: launched.threadId, action: "archive" });
      assert.match(await fails(registeredCall, "t3_inbox", { limit: 50 }), /limit/);
      assert.match(await fails(registeredCall, "t3_queue", { action: "list" }), /threadId/);
    } finally {
      await registered.close();
    }
  }

  // Cold start while T3 is down: same names, loose schemas, unreachable calls; then recovery.
  await catalogFake.setAvailable(false);
  const coldBridge = newBridge(catalogFake, "devspace-t3-bridge:unit-cold-start");
  const coldDefinitions = await coldBridge.toolDefinitions();
  assert.deepEqual(coldDefinitions.map((definition) => definition.name), [...T3_TOOL_NAMES]);
  assert.ok(coldDefinitions.every((definition) => !definition.live));
  for (const definition of coldDefinitions) {
    if (definition.name !== T3_INBOX_TOOL) assert.deepEqual(definition.inputSchema, { type: "object", additionalProperties: true });
  }
  checkCatalog(coldDefinitions.map((definition): CatalogTool => ({ ...definition })), { live: false });
  const coldRegistered = await connectRegistered(coldBridge, "standard");
  try {
    const { tools } = await coldRegistered.client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), [...T3_TOOL_NAMES], "fallback schemas still register every tool");
    assert.equal(await fails(mcpCaller(coldRegistered.client), "t3_thread_list", { anything: true }), T3_UNREACHABLE_MESSAGE);
  } finally {
    await coldRegistered.close();
  }
  await catalogFake.setAvailable(true);
  await ok(callerFor(coldBridge), "t3_project_list");
  await waitFor("the live catalog after T3 came back", async () => (await coldBridge.toolDefinitions()).every((definition) => definition.live));

  // The first fetch has a bounded budget; the catalog keeps loading in the background.
  const slowLabel = "devspace-t3-bridge:unit-slow";
  const realProvider = createT3TokenProvider({
    runner: createT3CliRunner(catalogFake.cliPath, [SECRET_NAME]),
    resolveOrigin: createT3OriginResolver(t3Config(catalogFake)),
    label: slowLabel,
  });
  const slowProvider: T3TokenProvider = {
    async getToken() {
      await delay(400);
      return realProvider.getToken();
    },
    refresh: () => realProvider.refresh(),
    revokeOwnSessions: () => realProvider.revokeOwnSessions(),
  };
  const slowBridge = newBridge(catalogFake, slowLabel, { tokenProvider: slowProvider, catalogTimeoutMs: 50 });
  const slowStarted = Date.now();
  const slowDefinitions = await slowBridge.toolDefinitions();
  assert.ok(Date.now() - slowStarted < 350, "the first catalog fetch respects its budget");
  assert.ok(slowDefinitions.every((definition) => !definition.live));
  await waitFor("the slow catalog", async () => (await slowBridge.toolDefinitions()).every((definition) => definition.live));

  // After a failed catalog load, sessions get the fallback at once while a refresh continues in
  // the background; once the live catalog is cached, sessions get live schemas.
  let catalogHealthy = false;
  let failedLoads = 0;
  const recoveringProvider = createT3TokenProvider({
    runner: createT3CliRunner(catalogFake.cliPath, [SECRET_NAME]),
    resolveOrigin: createT3OriginResolver(t3Config(catalogFake)),
    label: "devspace-t3-bridge:unit-failing-catalog",
  });
  const failingProvider: T3TokenProvider = {
    async getToken() {
      if (catalogHealthy) return recoveringProvider.getToken();
      failedLoads += 1;
      await delay(300);
      throw new Error("T3 Code did not answer.");
    },
    refresh: () => recoveringProvider.refresh(),
    revokeOwnSessions: () => recoveringProvider.revokeOwnSessions(),
  };
  let catalogClock = Date.now();
  const failingBridge = newBridge(catalogFake, "devspace-t3-bridge:unit-failing-catalog", {
    tokenProvider: failingProvider,
    catalogTimeoutMs: 2_000,
    now: () => catalogClock,
  });
  let catalogStarted = Date.now();
  assert.ok((await failingBridge.toolDefinitions()).every((definition) => !definition.live));
  assert.ok(Date.now() - catalogStarted >= 250, "the first session waits for the load to fail");
  for (let session = 0; session < 3; session += 1) {
    catalogStarted = Date.now();
    const fallback = await failingBridge.toolDefinitions();
    assert.ok(Date.now() - catalogStarted < 100, "after a failed load, a session's definitions return at once");
    assert.deepEqual(fallback.map((definition) => definition.name), [...T3_TOOL_NAMES]);
    assert.ok(fallback.every((definition) => !definition.live));
  }
  await waitFor("a background catalog refresh", () => failedLoads >= 2);
  // Once the 60-second fallback window has passed, a session waits for the catalog again.
  await delay(400);
  catalogClock += 61_000;
  const loadsBefore = failedLoads;
  catalogStarted = Date.now();
  assert.ok((await failingBridge.toolDefinitions()).every((definition) => !definition.live));
  assert.ok(Date.now() - catalogStarted >= 250, "after the fallback window, a session waits for the catalog again");
  assert.equal(failedLoads, loadsBefore + 1);
  catalogStarted = Date.now();
  await failingBridge.toolDefinitions();
  assert.ok(Date.now() - catalogStarted < 100, "the failed wait opens a new fallback window");
  catalogHealthy = true;
  await waitFor("the live catalog after recovery", async () => (await failingBridge.toolDefinitions()).every((definition) => definition.live));

  // The registration converter is self-contained: every forwarded snapshot schema converts and
  // validates representative arguments; `{}`, anyOf, and type: "null" behave as JSON Schema.
  const snapshotTools = (
    JSON.parse(readFileSync(new URL("./testing/t3-tools.snapshot.json", import.meta.url), "utf8")) as {
      tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
    }
  ).tools.filter((tool) => T3_FORWARDED_TOOLS.includes(tool.name));
  assert.equal(snapshotTools.length, T3_FORWARDED_TOOLS.length);
  const modelSelection = { instanceId: "claudeAgent", model: "claude-haiku-5-5" };
  const conversionCases: Record<string, { valid: Record<string, unknown>; invalid: Record<string, unknown> }> = {
    t3_project_list: { valid: { limit: 5, cursor: 0 }, invalid: { limit: "five" } },
    t3_thread_search: { valid: { query: "parser", limit: 3, projectId: "p" }, invalid: { query: 42 } },
    t3_thread_list: {
      valid: { allProjects: true, includeSubagents: false, statuses: ["running", "completed"], limit: 10 },
      invalid: { statuses: "running" },
    },
    t3_thread_read: { valid: { threadId: "t", view: "messages", afterPosition: 2, limit: 5, maxCharsPerItem: 100 }, invalid: { threadId: "t", view: "everything" } },
    t3_thread_wait: { valid: { threadId: "t", timeoutMs: 1_500 }, invalid: { threadId: "t", timeoutMs: "soon" } },
    t3_thread_launch: {
      valid: {
        scratch: true,
        title: "Converter",
        message: "Reply with exactly OK",
        modelSelection,
        runtimeMode: "full-access",
        attachments: [{ type: "file", id: "a", name: "notes.txt", mimeType: "text/plain", sizeBytes: 20_000_000 }],
      },
      invalid: { title: "Converter", modelSelection: "claude" },
    },
    t3_thread_send: { valid: { threadId: "t", message: "steer", mode: "queue" }, invalid: { threadId: "t", message: ["steer"] } },
    t3_thread_interrupt: { valid: { threadId: "t", reason: "done", stop: true }, invalid: { threadId: "t", stop: "yes" } },
    t3_pending_request: { valid: { action: "respond", threadId: "t", requestId: "r", answers: { "Ship?": "Ship" } }, invalid: { action: "answer" } },
    t3_thread_organize: { valid: { threadId: "t", action: "snooze", snoozedUntil: "2026-11-10T09:00:00Z" }, invalid: { threadId: "t", action: 7 } },
    t3_queue: { valid: { action: "edit", threadId: "t", queuedRunId: "q", text: "new text" }, invalid: { action: "edit", cursor: "first" } },
    t3_thread_update: { valid: { threadId: "t", action: "rename", title: "Renamed" }, invalid: { threadId: "t", action: "retitle" } },
    orchestrator_capabilities: { valid: { search: "haiku" }, invalid: { search: 5 } },
    t3_project_create: { valid: { title: "p", workspaceRoot: "/tmp/p", createWorkspaceRootIfMissing: true }, invalid: { title: 5 } },
    t3_project_clone: {
      valid: { remoteUrl: "https://example.invalid/r.git", destinationPath: "/tmp/r", protocol: "https" },
      invalid: { destinationPath: "/tmp/r", protocol: "ftp" },
    },
    t3_project_update: { valid: { projectId: "p", title: "t", defaultModelSelection: modelSelection }, invalid: { projectId: "p", title: 5 } },
    list_scheduled_tasks: { valid: { projectId: "p" }, invalid: { projectId: 5 } },
    schedule_task: {
      valid: { projectId: "p", prompt: "Reply with exactly OK", schedule: { type: "fixed_time", timeOfDay: "03:17", weekdays: [0, 6] } },
      invalid: { projectId: "p", prompt: "x", schedule: { type: "fixed_time", weekdays: ["sunday"] } },
    },
    run_scheduled_task_now: { valid: { taskId: "s" }, invalid: {} },
    delete_scheduled_task: { valid: { scheduledTaskId: "s" }, invalid: {} },
  };
  const syntheticSchema: Record<string, unknown> = {
    type: "object",
    properties: {
      nullableText: { anyOf: [{ type: "string" }, { type: "null" }] },
      maybeCount: { type: ["integer", "null"] },
      anything: {},
      fixed: { const: "exact" },
      mixed: { enum: ["a", 1, null] },
      tagged: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"], additionalProperties: false },
      labels: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["nullableText"],
  };
  const echoed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const stubBridge = {
    async toolDefinitions(): Promise<T3ToolDefinition[]> {
      return [
        ...snapshotTools.map((tool) => ({
          name: tool.name,
          title: tool.name,
          description: tool.description ?? tool.name,
          inputSchema: tool.inputSchema,
          readOnly: true,
          live: true,
        })),
        { name: "synthetic_schema", title: "Synthetic", description: "Synthetic", inputSchema: syntheticSchema, readOnly: true, live: true },
      ];
    },
    async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
      echoed.push({ name, args });
      return { content: [{ type: "text", text: "{}" }], structuredContent: {} };
    },
  } as unknown as T3Bridge;
  const converted = await connectRegistered(stubBridge, "standard");
  try {
    const accepts = async (name: string, args: Record<string, unknown>): Promise<void> => {
      const before = echoed.length;
      const result = (await converted.client.callTool({ name, arguments: args })) as CallToolResult;
      assert.notEqual(result.isError, true, `${name} must accept ${JSON.stringify(args)}: ${resultText(result)}`);
      assert.deepEqual(echoed.slice(before), [{ name, args }], `${name} receives the arguments unchanged`);
    };
    const rejects = async (name: string, args: Record<string, unknown>): Promise<void> => {
      const before = echoed.length;
      const result = (await converted.client.callTool({ name, arguments: args })) as CallToolResult;
      assert.equal(result.isError, true, `${name} must reject ${JSON.stringify(args)}`);
      assert.equal(echoed.length, before, `${name} never runs with invalid arguments`);
    };
    for (const tool of snapshotTools) {
      const cases = conversionCases[tool.name];
      assert.ok(cases, `a conversion case for ${tool.name}`);
      await accepts(tool.name, cases.valid);
      await rejects(tool.name, cases.invalid);
    }
    await accepts("synthetic_schema", { nullableText: null });
    await accepts("synthetic_schema", {
      nullableText: "text",
      maybeCount: null,
      anything: ["any", { value: 1 }],
      fixed: "exact",
      mixed: null,
      tagged: { kind: "k" },
      labels: { a: "x" },
    });
    await accepts("synthetic_schema", { nullableText: "text", maybeCount: 3, mixed: 1 });
    await rejects("synthetic_schema", { nullableText: 5 });
    await rejects("synthetic_schema", {});
    await rejects("synthetic_schema", { nullableText: "text", maybeCount: "3" });
    await rejects("synthetic_schema", { nullableText: "text", fixed: "other" });
    await rejects("synthetic_schema", { nullableText: "text", mixed: "b" });
    await rejects("synthetic_schema", { nullableText: "text", tagged: {} });
    await rejects("synthetic_schema", { nullableText: "text", labels: { a: 1 } });
  } finally {
    await converted.close();
  }

  // A fixed `url` wins over the runtime file.
  const urlBridge = newBridge(catalogFake, "devspace-t3-bridge:unit-url", {
    config: { ...t3Config(catalogFake), runtimeFile: join(tempDir, "missing-runtime.json"), url: `${catalogFake.origin}/mcp` },
  });
  await ok(callerFor(urlBridge), "t3_project_list");
  const missingBridge = newBridge(catalogFake, "devspace-t3-bridge:unit-missing", {
    config: { ...t3Config(catalogFake), runtimeFile: join(tempDir, "missing-runtime.json") },
  });
  assert.equal(await fails(callerFor(missingBridge), "t3_project_list"), T3_UNREACHABLE_MESSAGE);
  assert.equal(resultText(await missingBridge.call("task_status", {})), "task_status is not a DevSpace T3 tool.");
  checkCliEnvironment(catalogFake, SECRET_NAME);
  progress("ok - catalog, registration, cold start, non-blocking fallback, schema conversion (B2, B3, B8, B12, B15, B17)");

  // -----------------------------------------------------------------------------------------
  // Shaped behavior: B13–B22
  // -----------------------------------------------------------------------------------------
  const fake = await startFake();
  const label = t3SessionLabel(join(tempDir, "behavior-state"));
  const bridge = newBridge(fake, label);
  const call = callerFor(bridge);
  await checkInbox(call, fake);
  await checkInboxOmitted(call, fake);
  progress("ok - inbox (B18, B19, B20, B21, B22; omitted outcomes are listed by the next check)");
  await checkListing(call, fake);
  progress("ok - listing (B13, B16)");
  await checkReading(call, fake);
  progress("ok - reading and waiting (B14)");
  await checkShaping(call, fake);
  progress("ok - argument shaping (B12, B15)");
  await checkThreadUpdate(call, fake);
  progress("ok - thread rename and title regeneration (B28)");
  const projects = await checkProjects(call, fake);
  progress("ok - projects, clones, default model, model catalog (B29, B30, B31)");
  await checkScheduledTasks(call, fake, String(projects.projectId));
  progress("ok - scheduled tasks (B27)");
  await checkFullAccessMint(fake, label, [SECRET_NAME]);

  // -----------------------------------------------------------------------------------------
  // Resilience: B6, B8, B9, B10, B11
  // -----------------------------------------------------------------------------------------
  await checkCredentialRecovery(call, fake, label);
  progress("ok - credential rejection (B6)");
  await checkUnavailable(call, fake, async () => (await bridge.toolDefinitions()).map((definition) => definition.name));
  progress("ok - T3 down and back (B8)");
  await checkRestart(call, fake);
  progress("ok - T3 restart (B9)");
  await checkDroppedLaunch(call, fake);
  progress("ok - dropped launch response (B10)");
  await checkNoBlindRetry(call, fake);
  progress("ok - no blind retry (B11)");
  await checkPhase2Retries(call, fake);
  progress("ok - Phase 2 retry classification (B32)");

  // B5: repeated restarts leave at most one live session for the label.
  await bridge.close();
  for (let restart = 0; restart < 3; restart += 1) {
    const restarted = newBridge(fake, label);
    await ok(callerFor(restarted), "t3_project_list");
    assert.equal(fake.liveSessions(label), 1, `restart ${restart + 1} leaves one live session`);
    await restarted.close();
  }
  const revoking = newBridge(fake, label);
  await ok(callerFor(revoking), "t3_project_list");
  await revoking.close({ revoke: true });
  assert.equal(fake.liveSessions(label), 0, "close({ revoke: true }) revokes the label's sessions");
  progress("ok - revoke before mint across restarts (B5)");

  // A call never throws, even when aborted.
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await newBridge(fake, label).call("t3_project_list", {}, aborted.signal)).isError, true);

  // -----------------------------------------------------------------------------------------
  // Inbox completeness (B18), project-title negative cache, failure classification
  // -----------------------------------------------------------------------------------------
  const extraFake = await startFake();
  await checkInboxCompleteness(callerFor(newBridge(extraFake, "devspace-t3-bridge:unit-completeness")), extraFake);
  progress("ok - inbox needsYou inspects every active thread up to its cap (B18)");

  // An unknown project id reloads the project list at most once a minute; its title stays null.
  let projectClock = Date.now();
  const projectCall = callerFor(newBridge(extraFake, "devspace-t3-bridge:unit-project-miss", { now: () => projectClock }));
  const gone = extraFake.addProject({ title: "gone-fixture" });
  const orphan = extraFake.addThread({ projectId: gone.projectId, title: "Orphaned thread", messages: [{ role: "user", text: "hi" }] });
  extraFake.removeProject(gone.projectId);
  let projectMark = extraFake.calls.length;
  for (let call = 0; call < 3; call += 1) {
    const listed = rows(await ok(projectCall, "t3_thread_list", { projectId: gone.projectId }), "threads");
    assert.deepEqual(listed.map((row) => [row.threadId, row.project]), [[orphan.threadId, null]]);
  }
  assert.equal(forwarded(extraFake, "t3_project_list", projectMark).length, 1, "one project-list reload for an unknown id within a minute");
  projectClock += 61_000;
  projectMark = extraFake.calls.length;
  await ok(projectCall, "t3_thread_list", { projectId: gone.projectId });
  assert.equal(forwarded(extraFake, "t3_project_list", projectMark).length, 1, "the id is looked up again after a minute");
  const known = extraFake.addProject({ title: "new-fixture" });
  const knownThread = extraFake.addThread({ projectId: known.projectId, title: "New project thread", messages: [{ role: "user", text: "hi" }] });
  const knownRows = rows(await ok(projectCall, "t3_thread_list", { projectId: known.projectId }), "threads");
  assert.deepEqual(knownRows.map((row) => [row.threadId, row.project]), [[knownThread.threadId, "new-fixture"]], "a different unknown id still reloads");
  progress("ok - project titles: negative cache for unknown project ids");

  // Classifying a failure after the request was sent neither reconnects nor mints; T3 gone by
  // then is reported as unreachable.
  const tokenCounter = { getToken: 0 };
  const classifyLabel = "devspace-t3-bridge:unit-classify";
  const deadOrigin = await closedOrigin();
  let originDead = false;
  const classifyCall = callerFor(
    newBridge(extraFake, classifyLabel, {
      tokenProvider: countingProvider(
        createT3TokenProvider({
          runner: createT3CliRunner(extraFake.cliPath, [SECRET_NAME]),
          resolveOrigin: async () => extraFake.origin,
          label: classifyLabel,
        }),
        tokenCounter,
      ),
      resolveOrigin: async () => (originDead ? deadOrigin : extraFake.origin),
    }),
  );
  const classified = extraFake.addThread({ title: "Classified failure", messages: [{ role: "user", text: "hi" }] });
  await ok(classifyCall, "t3_project_list");
  let tokenCalls = tokenCounter.getToken;
  extraFake.dropNextResponse("t3_thread_organize");
  assert.equal(
    await fails(classifyCall, "t3_thread_organize", { threadId: classified.threadId, action: "pin" }),
    "T3 Code connection failed during t3_thread_organize; it may or may not have run.",
  );
  assert.equal(tokenCounter.getToken - tokenCalls, 1, "classifying the failure acquires no connection and mints nothing");
  await ok(classifyCall, "t3_project_list");
  originDead = true;
  tokenCalls = tokenCounter.getToken;
  extraFake.dropNextResponse("t3_thread_organize");
  assert.equal(await fails(classifyCall, "t3_thread_organize", { threadId: classified.threadId, action: "unpin" }), T3_UNREACHABLE_MESSAGE);
  assert.equal(tokenCounter.getToken - tokenCalls, 1);
  originDead = false;
  await ok(classifyCall, "t3_thread_read", { threadId: classified.threadId });
  progress("ok - failure classification after a sent request uses a cheap reachability probe");

  // A JSON-RPC error answered by T3 (a ProtocolError in SDK v2) means the session is healthy and
  // the call did not run: it is reported as such, never retried (even for a read), and mints nothing.
  tokenCalls = tokenCounter.getToken;
  const rpcMark = extraFake.calls.length;
  assert.match(
    await fails(classifyCall, "t3_project_list", { limit: "five" }),
    /^T3 Code could not run t3_project_list: .*Invalid parameters for tool 't3_project_list'/,
  );
  assert.equal(forwarded(extraFake, "t3_project_list", rpcMark).length, 1, "a JSON-RPC error is not retried");
  assert.equal(tokenCounter.getToken - tokenCalls, 1, "a JSON-RPC error keeps the connection and mints nothing");
  progress("ok - failure classification: a JSON-RPC error from T3 is reported, not retried");

  // A stale MCP session answers HTTP 404 (an SdkHttpError with status 404 in SDK v2): the bridge
  // reconnects and sends the call once, even a write that is not otherwise retried after sending.
  await ok(classifyCall, "t3_project_list");
  await extraFake.restart();
  const staleRetries = (): number =>
    consoleCapture.lines.filter((line) => line.includes('"event":"t3_bridge_retry"') && line.includes('"reason":"stale_session"')).length;
  const staleBefore = staleRetries();
  const writeMark = extraFake.calls.length;
  await ok(classifyCall, "t3_thread_organize", { threadId: classified.threadId, action: "pin" });
  assert.equal(forwarded(extraFake, "t3_thread_organize", writeMark).length, 1, "the write ran exactly once after the restart");
  assert.equal(staleRetries() - staleBefore, 1, "the 404 was classified as a stale session");
  progress("ok - failure classification: HTTP 404 reconnects a stale session once");

  // A request timeout (an SdkError, not a ProtocolError, in SDK v2) is a sent request that may have
  // run: a read is retried once, then reported as a connection failure.
  const waiting = extraFake.addThread({ title: "Timed out wait", status: "running" });
  const timeoutCall = callerFor(newBridge(extraFake, "devspace-t3-bridge:unit-timeout", { callTimeoutMs: 300 }));
  await ok(timeoutCall, "t3_project_list");
  const timeoutMark = extraFake.calls.length;
  assert.equal(
    await fails(timeoutCall, "t3_thread_wait", { threadId: waiting.threadId, timeoutMs: 5_000 }),
    "T3 Code connection failed during t3_thread_wait; it may or may not have run.",
  );
  assert.equal(forwarded(extraFake, "t3_thread_wait", timeoutMark).length, 2, "a timed-out read is retried once");
  progress("ok - failure classification: a request timeout is a sent failure, retried once for a read");

  // -----------------------------------------------------------------------------------------
  // B23 and B24 across everything above
  // -----------------------------------------------------------------------------------------
  for (const bridgeToClose of bridges) await bridgeToClose.close();
  const logLines = consoleCapture.lines;
  assert.ok(logLines.some((line) => line.includes('"event":"t3_bridge_retry"')), "debug logging was captured");
  assert.ok(logLines.some((line) => line.includes('"event":"t3_bridge_connected"')));
  for (const each of fakes) {
    checkNoSecrets(each, [...outputs, ...logLines]);
    checkCliEnvironment(each, SECRET_NAME);
  }
  progress("ok - no secrets in logs or results; scrubbed CLI environment (B23, B24)");
} finally {
  consoleCapture.restore();
  for (const bridgeToClose of bridges) await bridgeToClose.close().catch(() => undefined);
  for (const each of fakes) await each.stop();
  await rm(tempDir, { recursive: true, force: true });
  clearTimeout(watchdog);
}

progress("t3-bridge.test: all checks passed");
