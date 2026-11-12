// End-to-end suite for the T3 Code bridge (plan 015): MCP SDK client → DevSpace HTTP /mcp →
// bridge → fake T3 over HTTP with its OAuth flow and the fake CLI as a child process. Runs the
// whole chain in serve mode (createServer) and gateway mode (createGatewayServer), including the
// shared orchestrator scenarios S1–S7.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type express from "express";
import type { ServerConfig, T3BridgeConfig } from "./config.js";
import { SqliteOAuthStateStore } from "./oauth-store.js";
import type { GatewayRoleConfig } from "./role-config.js";
import { normalizeRootPolicies } from "./roots.js";
import { createGatewayServer, createServer } from "./server.js";
import { sharedT3Bridge, T3_TOOL_NAMES, T3Bridge, t3SessionLabel } from "./t3-bridge.js";
import { FakeT3 } from "./testing/fake-t3.js";
import {
  captureConsole,
  checkCatalog,
  checkCliEnvironment,
  checkCredentialRecovery,
  checkDroppedLaunch,
  checkFullAccessMint,
  checkInbox,
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
  ok,
  waitFor,
  type CatalogTool,
  type T3Call,
} from "./testing/t3-checks.js";
import { cleanupScenarioThreads, runScenarios, type ScenarioContext } from "./testing/t3-scenarios.js";

const SECRET_NAME = "DEVSPACE_T3_TEST_SECRET";
const ACCESS_TOKEN = "t3-e2e-devspace-access-token";
const OWNER_TOKEN = "t3-e2e-owner-token-that-is-long-enough";
const PROJECT_NAME = "devspace-fixture";
const SCENARIO_TIMEOUT_MS = 20_000;
const BASE_CAPABILITIES_OFF = ["sky-cua", "node_repl"];

process.env[SECRET_NAME] = "configured-secret-that-must-not-reach-the-t3-cli";
process.env.GH_TOKEN ??= "github-token-that-must-not-reach-the-t3-cli";
// Gateway mode reads its settings through loadConfig(process.env).
process.env.DEVSPACE_WIDGETS = "off";
process.env.DEVSPACE_LOG_LEVEL = "debug";
process.env.DEVSPACE_ANNOTATION_PROFILE = "standard";
process.env.DEVSPACE_INFRA_SECRET_NAMES = SECRET_NAME;
delete process.env.DISABLED_CAPABILITIES;

const watchdog = setTimeout(() => {
  process.stderr.write("t3-e2e.test: timed out after 150 s\n");
  process.exit(1);
}, 150_000);
watchdog.unref();

const consoleCapture = captureConsole();
const cleanups: Array<() => Promise<void> | void> = [];

function progress(message: string): void {
  process.stdout.write(`${message}\n`);
}

function t3Config(fake: FakeT3): T3BridgeConfig {
  return { enabled: true, cliPath: fake.cliPath, runtimeFile: fake.runtimeFile };
}

function seedAccessToken(stateDir: string, publicBaseUrl: string): void {
  const store = new SqliteOAuthStateStore(stateDir);
  store.saveToken({
    tokenHash: createHash("sha256").update(ACCESS_TOKEN).digest("base64url"),
    tokenType: "access",
    clientId: "t3-e2e-client",
    scopes: ["devspace"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    resource: new URL(`${publicBaseUrl}/mcp`),
  });
  store.close();
}

async function listen(app: express.Express): Promise<{ endpoint: string; server: HttpServer }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return { endpoint: `http://127.0.0.1:${port}/mcp`, server };
}

async function connect(endpoint: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "t3-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { authorization: `Bearer ${ACCESS_TOKEN}`, ...headers } },
    }),
  );
  cleanups.push(() => client.close());
  return client;
}

async function toolNames(endpoint: string, headers: Record<string, string> = {}): Promise<string[]> {
  const client = await connect(endpoint, headers);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

/** Records every tool result the client receives, including the scenarios' calls (B23). */
function recordResults(client: Client, outputs: string[]): void {
  const callTool = client.callTool.bind(client);
  client.callTool = (async (...args: Parameters<Client["callTool"]>) => {
    const result = await callTool(...args);
    outputs.push(JSON.stringify(result));
    return result;
  }) as Client["callTool"];
}

function callerFor(client: Client): T3Call {
  return async (name, args) => (await client.callTool({ name, arguments: args ?? {} }, { timeout: 60_000 })) as CallToolResult;
}

async function warmCatalog(bridge: T3Bridge): Promise<void> {
  await waitFor("the live T3 catalog", async () => (await bridge.toolDefinitions()).every((definition) => definition.live), 15_000);
}

function assertNoT3Tools(names: string[], why: string): void {
  assert.ok(names.length > 0, "DevSpace still lists its own tools");
  for (const name of T3_TOOL_NAMES) assert.ok(!names.includes(name), `${name} must be absent ${why}`);
}

/** Everything that runs identically in both modes against a fresh fake and a fresh bridge. */
async function exerciseChain(
  mode: string,
  endpoint: string,
  fake: FakeT3,
  label: string,
  outputs: string[],
  annotationProfile: "standard" | "trusted-owner",
): Promise<void> {
  // B1 (per session) and the baseline for B2.
  const baseline = await toolNames(endpoint, { "x-disabled-capabilities": "t3" });
  assertNoT3Tools(baseline, "when the session disables the t3 capability");

  const client = await connect(endpoint);
  recordResults(client, outputs);
  const call = callerFor(client);
  checkCatalog((await client.listTools()).tools as CatalogTool[], { baseline: new Set(baseline), annotationProfile });
  progress(`ok - ${mode}: catalog and annotations (B1, B2, B3, B12, B15, B17)`);

  await checkInbox(call, fake);
  await checkInboxOmitted(call, fake);
  await checkListing(call, fake);
  await checkReading(call, fake);
  await checkShaping(call, fake);
  progress(`ok - ${mode}: shaped results (B12–B22; omitted inbox outcomes)`);
  await checkThreadUpdate(call, fake);
  const projects = await checkProjects(call, fake);
  await checkScheduledTasks(call, fake, String(projects.projectId));
  progress(`ok - ${mode}: rename, projects, model catalog, scheduled tasks (B27–B31)`);

  const ctx: ScenarioContext = {
    kind: "fake",
    client,
    stamp: `e2e-${mode}-${Date.now()}`,
    projectName: PROJECT_NAME,
    timeoutMs: SCENARIO_TIMEOUT_MS,
    workDir: join(fake.home, `scenarios-${mode}`),
  };
  const results = await runScenarios(ctx);
  assert.deepEqual(results.map((result) => result.id), ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"]);
  for (const result of results) assert.ok(result.ok, `${mode} ${result.id} failed: ${result.error}`);
  assert.equal(await cleanupScenarioThreads(ctx), 0, "the scenarios archived every thread they started");
  progress(`ok - ${mode}: scenarios S1–S10`);

  await checkCredentialRecovery(call, fake, label);
  await checkUnavailable(call, fake, () => toolNames(endpoint));
  await checkRestart(call, fake);
  await checkDroppedLaunch(call, fake);
  await checkNoBlindRetry(call, fake);
  await checkPhase2Retries(call, fake);
  progress(`ok - ${mode}: credential, availability, restart, dropped responses and read retries (B6, B8, B9, B10, B11, B32)`);

  checkCliEnvironment(fake, SECRET_NAME);
  await checkFullAccessMint(fake, label, [SECRET_NAME]);
  await client.close();
}

function finalSecretScan(mode: string, fake: FakeT3, outputs: string[]): void {
  const lines = consoleCapture.lines;
  assert.ok(lines.some((line) => line.includes('"level":"debug"') && line.includes('"event":"t3_bridge_retry"')), "bridge debug logs were captured");
  assert.ok(lines.some((line) => line.includes('"event":"mcp_session_created"') && line.includes('"level":"info"')), "DevSpace logs were captured");
  checkNoSecrets(fake, [...outputs, ...lines]);
  checkCliEnvironment(fake, SECRET_NAME);
  progress(`ok - ${mode}: no secrets in DevSpace logs or tool results; scrubbed CLI environment (B23, B24)`);
}

// -------------------------------------------------------------------------------------------
// Serve mode
// -------------------------------------------------------------------------------------------

function serveConfig(stateDir: string, t3: T3BridgeConfig): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7691,
    oauth: {
      ownerToken: OWNER_TOKEN,
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 2592000,
      scopes: ["devspace"],
      allowedRedirectHosts: [],
    },
    allowedRoots: [process.cwd()],
    rootPolicies: normalizeRootPolicies([{ path: process.cwd(), access: "read-write" }]),
    allowedHosts: ["127.0.0.1"],
    publicBaseUrl: "http://127.0.0.1:7691",
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
    secretNames: ["DEVSPACE_OAUTH_OWNER_TOKEN", SECRET_NAME],
    terminals: { backend: "tmux", runtimeDir: join(stateDir, "terminal-runtime"), maxPerWorkspace: 2, maxTotal: 4, idleTtlSeconds: 3600, useUserSystemd: false },
    maintenance: { intervalSeconds: 3600, closedSessionTtlSeconds: 604800, checkoutIdleTtlSeconds: 2592000, isolatedIdleTtlSeconds: 604800 },
    sessions: { idleTtlSeconds: 1800, sweepIntervalSeconds: 60 },
    logging: { level: "debug", format: "json", requests: true, assets: false, toolCalls: true, shellCommands: false, trustProxy: false },
    disabledCapabilities: new Set(BASE_CAPABILITIES_OFF),
    t3,
  };
}

const seededStateDirs = new Set<string>();

async function startServe(config: ServerConfig, t3Bridge?: T3Bridge): Promise<string> {
  if (!seededStateDirs.has(config.stateDir)) seedAccessToken(config.stateDir, config.publicBaseUrl);
  seededStateDirs.add(config.stateDir);
  const running = createServer(config, t3Bridge ? { t3Bridge } : {});
  cleanups.push(() => running.close?.());
  return (await listen(running.app)).endpoint;
}

async function serveMode(): Promise<void> {
  const fake = await FakeT3.start({ sleepScaleMs: 100 });
  cleanups.push(() => fake.stop());
  fake.addProject({ title: PROJECT_NAME });
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-t3-e2e-serve-"));
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const config = serveConfig(stateDir, t3Config(fake));
  const label = t3SessionLabel(stateDir);
  const newBridge = () => {
    const bridge = new T3Bridge({ config: t3Config(fake), label, secretNames: config.secretNames, logging: config.logging });
    cleanups.push(() => bridge.close());
    return bridge;
  };

  // B1: `t3.enabled: false` hides the tools even with a bridge injected.
  const disabledDir = await mkdtemp(join(tmpdir(), "devspace-t3-e2e-serve-disabled-"));
  cleanups.push(() => rm(disabledDir, { recursive: true, force: true }));
  const disabledEndpoint = await startServe(serveConfig(disabledDir, { ...t3Config(fake), enabled: false }), newBridge());
  assertNoT3Tools(await toolNames(disabledEndpoint), "when t3.enabled is false");

  const bridge = newBridge();
  await warmCatalog(bridge);
  const endpoint = await startServe(config, bridge);
  const outputs: string[] = [];
  await exerciseChain("serve", endpoint, fake, label, outputs, "trusted-owner");

  // B5: DevSpace restarts with a new bridge for the same state directory leave one live session.
  await bridge.close();
  for (let restart = 1; restart <= 2; restart += 1) {
    const restartedBridge = newBridge();
    const restartedEndpoint = await startServe(config, restartedBridge);
    const client = await connect(restartedEndpoint);
    recordResults(client, outputs);
    await ok(callerFor(client), "t3_project_list");
    assert.equal(fake.liveSessions(label), 1, `restart ${restart} leaves one live session for the label`);
    await client.close();
    await restartedBridge.close({ revoke: restart === 2 });
  }
  assert.equal(fake.liveSessions(label), 0, "close({ revoke: true }) leaves no session behind");
  progress("ok - serve: revoke before mint across DevSpace restarts (B4, B5)");

  finalSecretScan("serve", fake, outputs);
}

// -------------------------------------------------------------------------------------------
// Gateway mode
// -------------------------------------------------------------------------------------------

async function startGateway(
  fake: FakeT3,
  disabledCapabilities: string[],
  t3Bridge?: T3Bridge,
): Promise<{ endpoint: string; config: ServerConfig; stateDir: string }> {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-t3-e2e-gateway-"));
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  // Gateway mode reads config.json and auth.json from <stateDir>/role-config-source.
  const source = join(stateDir, "role-config-source");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "config.json"), JSON.stringify({ t3: { enabled: true, cliPath: fake.cliPath, runtimeFile: fake.runtimeFile } }));
  writeFileSync(join(source, "auth.json"), JSON.stringify({ ownerToken: OWNER_TOKEN }));
  const publicBaseUrl = "http://127.0.0.1:7692";
  // The gateway's OAuth store lives in the gateway state directory.
  seedAccessToken(stateDir, publicBaseUrl);
  const roleConfig: GatewayRoleConfig = {
    role: "gateway",
    host: "127.0.0.1",
    port: 7692,
    publicBaseUrl,
    stateDir,
    machines: [
      {
        id: "local",
        displayName: "Local",
        canonical: true,
        kind: "local",
        allowedRoots: [process.cwd()],
        stateDir: join(stateDir, "machine-local"),
        worktreeRoot: join(stateDir, "machine-worktrees"),
        terminals: { useUserSystemd: false },
        disabledCapabilities,
      },
    ],
  };
  const running = createGatewayServer(roleConfig, t3Bridge ? { t3Bridge } : undefined);
  cleanups.push(() => running.close?.());
  const { endpoint } = await listen(running.app);
  return { endpoint, config: running.config, stateDir };
}

async function gatewayMode(): Promise<void> {
  const fake = await FakeT3.start({ sleepScaleMs: 100 });
  cleanups.push(() => fake.stop());
  fake.addProject({ title: PROJECT_NAME });

  // The production path: settings from role-config-source, the process-wide shared bridge.
  const gateway = await startGateway(fake, BASE_CAPABILITIES_OFF);
  assert.deepEqual(gateway.config.t3, t3Config(fake), "t3 settings come from <stateDir>/role-config-source/config.json");
  assert.ok(gateway.config.secretNames.includes(SECRET_NAME));
  assert.equal(gateway.config.logging.level, "debug");
  const bridge = sharedT3Bridge(gateway.config);
  assert.ok(bridge, "the gateway uses the shared bridge");
  cleanups.push(() => bridge.close());
  await warmCatalog(bridge);
  const label = t3SessionLabel(gateway.stateDir);
  const outputs: string[] = [];
  // The gateway loads its settings through loadConfig, whose annotation profile defaults to standard.
  await exerciseChain("gateway", gateway.endpoint, fake, label, outputs, "standard");
  assert.ok(fake.calls.every((entry) => entry.label === label), "every T3 call came from the gateway's own label");

  // B1: the local machine's disabledCapabilities hides the tools, even with a bridge injected.
  const injectedLabel = "devspace-t3-bridge:e2e-injected";
  const injected = new T3Bridge({ config: t3Config(fake), label: injectedLabel, secretNames: [SECRET_NAME] });
  cleanups.push(() => injected.close({ revoke: true }));
  const hidden = await startGateway(fake, [...BASE_CAPABILITIES_OFF, "t3"], injected);
  assertNoT3Tools(await toolNames(hidden.endpoint), "when the gateway machine disables t3");

  // createGatewayServer's injected bridge is the one that runs.
  const viaInjected = await startGateway(fake, BASE_CAPABILITIES_OFF, injected);
  const client = await connect(viaInjected.endpoint);
  recordResults(client, outputs);
  const mark = fake.calls.length;
  await ok(callerFor(client), "t3_project_list");
  assert.deepEqual(fake.calls.slice(mark).map((entry) => entry.label), [injectedLabel]);
  await client.close();
  progress("ok - gateway: machine-level t3 capability and bridge injection (B1)");

  finalSecretScan("gateway", fake, outputs);
}

let failed = false;
try {
  await serveMode();
  await gatewayMode();
} catch (error) {
  failed = true;
  process.stderr.write(`t3-e2e.test failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      // keep tearing down
    }
  }
  consoleCapture.restore();
  clearTimeout(watchdog);
}

if (failed) process.exit(1);
progress("t3-e2e.test: all checks passed");
