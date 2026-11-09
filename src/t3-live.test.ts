// Live suites for the T3 Code bridge (plan 015, "Verification design"). Not part of `bun run test`.
//
//   bun run test:t3-live      --target=local     MCP client → in-process DevSpace → bridge → real T3 + real CLI
//   bun run test:t3-deployed  --target=deployed  MCP client → public DevSpace URL → Svartal gateway → real T3
//
// Both start real T3 threads (provider credits), title them `DevSpace bridge check <stamp> …`,
// settle and archive them, revoke every T3 session they create, and fail if anything remains.
// They fail loudly when T3 Code is not reachable.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { parseT3BridgeConfig, type ServerConfig, type T3BridgeConfig } from "./config.js";
import { mintHeadlessOAuth, writeOAuthBundle, type HeadlessOAuthBundle } from "./headless-auth.js";
import { SqliteOAuthStateStore } from "./oauth-store.js";
import { normalizeRootPolicies } from "./roots.js";
import { createServer } from "./server.js";
import {
  createT3CliRunner,
  createT3OriginResolver,
  createT3TokenProvider,
  T3_FORWARDED_TOOLS,
  T3_TOOL_NAMES,
  T3_UNREACHABLE_MESSAGE,
  T3Bridge,
  t3SessionLabel,
  type T3CliRunner,
  type T3TokenProvider,
} from "./t3-bridge.js";
import { loadDevspaceFiles } from "./user-config.js";
import { DEVSPACE_VERSION } from "./version.js";
import { FakeT3 } from "./testing/fake-t3.js";
import { captureConsole, checkCatalog, FULL_ACCESS_SCOPES, ok, resultData, resultText, type CatalogTool, type T3Call } from "./testing/t3-checks.js";
import { cleanupScenarioThreads, runScenarios, type ScenarioContext, type ScenarioTargetKind } from "./testing/t3-scenarios.js";

type Json = Record<string, unknown>;
type Target = "local" | "deployed";

const LIVE_MODEL = { instanceId: "claudeAgent", model: "claude-haiku-5-5" };
const LIVE_PROJECT = "No project";
const SCENARIO_TIMEOUT_MS = 5 * 60_000;
const WAIT_SLICE_MS = 25_000;
const REQUEST_TIMEOUT_MS = 120_000;
const DEVSPACE_ACCESS_TOKEN = `t3-live-${randomBytes(24).toString("base64url")}`;
const LOCAL_SCENARIOS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"];
// The deployed gateway runs on this machine, so S9 and S10 can clone into a local folder.
const DEPLOYED_SCENARIOS = ["S1", "S2", "S3", "S7", "S8", "S9", "S10"];
/** Where T3 keeps worktrees for project threads (scheduled runs create them). */
const T3_WORKTREES_DIR = join(homedir(), ".t3", "worktrees");
// Row keys real T3 includes only for some threads.
const OPTIONAL_ROW_KEYS = new Set(["branch"]);
/** The deployed suite's DevSpace OAuth client and refresh token (directory 0700, file 0600; never printed). */
const DEPLOYED_OAUTH_CACHE = join(homedir(), ".local", "state", "devspace", "t3-deployed-check.json");
const DEPLOYED_OAUTH_TIMEOUT_MS = 15_000;
/** How long the deployed suite waits for a freshly restarted gateway to serve T3's live tool schemas. */
const LIVE_CATALOG_WAIT_MS = 90_000;

/** Input properties (and their JSON types) the bridge sets, reads, or removes, per forwarded tool. */
const BRIDGE_PROPERTIES: Record<string, Record<string, string>> = {
  t3_project_list: { environmentId: "string", limit: "integer", cursor: "integer" },
  t3_thread_search: { environmentId: "string", query: "string", limit: "integer", projectId: "string" },
  t3_thread_list: {
    environmentId: "string",
    projectId: "string",
    allProjects: "boolean",
    includeSubagents: "boolean",
    settled: "boolean",
    titleContains: "string",
    cursor: "integer",
    limit: "integer",
  },
  t3_thread_read: {
    environmentId: "string",
    threadId: "string",
    itemId: "string",
    view: "string",
    afterPosition: "integer",
    limit: "integer",
    maxCharsPerItem: "integer",
  },
  t3_thread_wait: { environmentId: "string", threadId: "string", timeoutMs: "number" },
  t3_thread_launch: {
    environmentId: "string",
    projectId: "string",
    scratch: "boolean",
    title: "string",
    message: "string",
    modelSelection: "object",
    runtimeMode: "string",
    clientRequestId: "string",
    delegatedFrom: "object",
  },
  t3_thread_send: { environmentId: "string", threadId: "string", message: "string", mode: "string", clientRequestId: "string" },
  t3_thread_interrupt: { environmentId: "string", threadId: "string", reason: "string", clientRequestId: "string" },
  t3_pending_request: { environmentId: "string", action: "string", threadId: "string", requestId: "string", answers: "object" },
  t3_thread_organize: { environmentId: "string", threadId: "string", action: "string", snoozedUntil: "string" },
  t3_queue: { environmentId: "string", action: "string", threadId: "string", queuedRunId: "string", text: "string" },
  t3_thread_update: { environmentId: "string", threadId: "string", action: "string", title: "string", clientRequestId: "string" },
  orchestrator_capabilities: { environmentId: "string", search: "string" },
  t3_project_create: {
    environmentId: "string",
    title: "string",
    workspaceRoot: "string",
    createWorkspaceRootIfMissing: "boolean",
    defaultModelSelection: "object",
  },
  t3_project_clone: { environmentId: "string", destinationPath: "string", remoteUrl: "string", provider: "string", repository: "string" },
  t3_project_update: { environmentId: "string", projectId: "string", title: "string", defaultModelSelection: "object" },
  list_scheduled_tasks: { environmentId: "string", projectId: "string" },
  schedule_task: {
    environmentId: "string",
    projectId: "string",
    prompt: "string",
    schedule: "object",
    title: "string",
    enabled: "boolean",
    bindToCurrentThread: "boolean",
    clientRequestId: "string",
    scheduledTaskId: "string",
  },
  run_scheduled_task_now: { environmentId: "string", taskId: "string" },
  delete_scheduled_task: { environmentId: "string", scheduledTaskId: "string" },
};
/** `schedule` fields the bridge removes (webhook triggers); T3 must still call them this. */
const WEBHOOK_SCHEDULE_FIELDS = ["signature", "maxDeliveryAgeMinutes", "dedupe", "filters"];
const REQUIRED_ENUM_VALUES: Record<string, string[]> = {
  "t3_thread_launch.runtimeMode": ["full-access"],
  "t3_thread_read.view": ["messages"],
  "t3_thread_send.mode": ["steer", "queue"],
  "t3_pending_request.action": ["list", "read", "respond"],
  "t3_thread_organize.action": ["settle", "archive"],
  "t3_queue.action": ["list", "read", "edit", "cancel"],
  "t3_thread_update.action": ["rename", "regenerate_title"],
};
/** Fields the bridge reads from T3's results; every real result must carry them. */
const BRIDGE_READS = {
  listRow: ["threadId", "projectId", "title", "status", "settled", "snoozed", "updatedAt", "link"],
  listEnvelope: ["threads", "nextCursor", "total"],
  readEnvelope: ["thread", "items", "nextPosition", "hasMore"],
  readThread: ["threadId", "projectId", "title", "status", "runtimeMode", "pendingRequestCount", "settled", "archived", "link", "itemCount"],
  readItem: ["position", "itemId", "type", "createdBy", "text", "textTruncated", "nextTextOffset", "updatedAt"],
  searchMatch: ["threadId", "projectId", "title", "source", "link"],
  projectRow: ["id", "title", "workspaceRoot"],
  waitResult: ["threadId", "runId", "status", "timedOut"],
  launchResult: ["threadId", "link", "runId"],
  projectRecord: ["id", "title", "workspaceRoot", "defaultModelSelection"],
  scheduledTask: ["scheduledTaskId", "title", "projectId", "boundThreadId", "enabled", "nextRunAt", "lastRunStatus"],
  capabilityProvider: ["providerInstanceId", "displayName", "models"],
  capabilityModel: ["id"],
};
const ERROR_CASES: Array<{ tool: string; args: Json; code: string }> = [
  { tool: "t3_thread_list", args: {}, code: "target_required" },
  { tool: "t3_pending_request", args: { action: "list" }, code: "target_required" },
  { tool: "t3_thread_organize", args: { action: "settle" }, code: "target_required" },
  { tool: "task_status", args: { taskId: "devspace-contract-probe" }, code: "thread_credential_required" },
  { tool: "create_threads", args: { threads: [{ prompt: "Reply with exactly OK" }] }, code: "thread_credential_required" },
  { tool: "t3_thread_update", args: { action: "rename", title: "DevSpace contract probe" }, code: "target_required" },
  {
    tool: "schedule_task",
    args: { prompt: "Reply with exactly OK", schedule: { type: "once", runAt: new Date(Date.now() + 300 * 86_400_000).toISOString() } },
    code: "target_required",
  },
];

class LiveFailure extends Error {}

const failures: string[] = [];
const notes: string[] = [];

function progress(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): never {
  throw new LiveFailure(message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parseTarget(argv: string[]): Target {
  const value = argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length);
  if (value === "local" || value === "deployed") return value;
  fail("Pass --target=local (bun run test:t3-live) or --target=deployed (bun run test:t3-deployed).");
}

function newStamp(): string {
  return `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}-${randomBytes(3).toString("hex")}`;
}

/** Runs one named check, recording a failure instead of stopping the run. */
async function check(name: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body();
    progress(`ok - ${name}`);
  } catch (error) {
    failures.push(`${name}: ${describe(error)}`);
    progress(`FAIL - ${name}: ${describe(error)}`);
  }
}

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/^[[{]/m);
    if (start < 0) return undefined;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return undefined;
    }
  }
}

// -------------------------------------------------------------------------------------------
// Secret capture (B23): every pairing code, authorization code, and token issued during the run
// -------------------------------------------------------------------------------------------

interface CliRecord {
  args: string[];
  /** Parsed JSON output with pairing credentials removed; undefined for non-JSON output. */
  json?: unknown;
  /** Raw stdout for commands without JSON output (`auth session revoke`). */
  text?: string;
}

function recordingRunner(runner: T3CliRunner, log: CliRecord[], secrets: Set<string>): T3CliRunner {
  return {
    async run(args, signal) {
      const stdout = await runner.run(args, signal);
      const command = args.slice(0, 3).join(" ");
      const parsed = command === "auth session revoke" ? undefined : parseJsonLoose(stdout);
      if (command === "auth pairing create" && isRecord(parsed) && typeof parsed.credential === "string") {
        secrets.add(parsed.credential);
        log.push({ args: [...args], json: { ...parsed, credential: "<secret>" } });
      } else {
        log.push({ args: [...args], ...(parsed === undefined ? { text: stdout } : { json: parsed }) });
      }
      return stdout;
    },
  };
}

function recordingFetch(secrets: Set<string>): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (response.ok && /\/oauth\/mcp\/(decision|token)$/.test(new URL(url).pathname)) {
      try {
        const body = (await response.clone().json()) as unknown;
        if (isRecord(body) && typeof body.redirectTo === "string") {
          const code = new URL(body.redirectTo).searchParams.get("code");
          if (code) secrets.add(code);
        }
        if (isRecord(body) && typeof body.access_token === "string") secrets.add(body.access_token);
      } catch {
        // not JSON; the provider reports it
      }
    }
    return response;
  };
}

function scanForSecrets(secrets: Set<string>, texts: string[]): void {
  assert.ok(secrets.size >= 3, `expected at least a pairing code, an authorization code, and a token; captured ${secrets.size}`);
  let leaks = 0;
  for (const text of texts) for (const secret of secrets) if (text.includes(secret)) leaks += 1;
  // Never print the secret or the text around it.
  assert.equal(leaks, 0, `${leaks} issued secret occurrence(s) found in DevSpace logs or tool results`);
}

// -------------------------------------------------------------------------------------------
// Clients
// -------------------------------------------------------------------------------------------

async function connectMcp(url: string, token: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "devspace-t3-live", version: DEVSPACE_VERSION });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } } }),
  );
  return client;
}

/** Calls a T3 tool directly, without the SDK's output-schema validation (as the bridge does). */
function directCaller(client: Client): T3Call {
  return (name, args) =>
    client.request({ method: "tools/call", params: { name, arguments: args ?? {} } }, CallToolResultSchema, { timeout: REQUEST_TIMEOUT_MS });
}

function devspaceCaller(client: Client): T3Call {
  return async (name, args) => (await client.callTool({ name, arguments: args ?? {} }, undefined, { timeout: REQUEST_TIMEOUT_MS })) as CallToolResult;
}

function recordResults(client: Client, outputs: string[]): void {
  const callTool = client.callTool.bind(client);
  client.callTool = (async (...args: Parameters<Client["callTool"]>) => {
    const result = await callTool(...args);
    outputs.push(JSON.stringify(result));
    return result;
  }) as Client["callTool"];
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

async function toolNames(url: string, token: string, headers: Record<string, string>): Promise<string[]> {
  const client = await connectMcp(url, token, headers);
  try {
    return (await listAllTools(client)).map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

async function waitDone(call: T3Call, threadId: string, timeoutMs: number): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await ok(call, "t3_thread_wait", { threadId, timeoutMs: WAIT_SLICE_MS });
    if (result.timedOut === false) return result;
    if (Date.now() > deadline) fail(`thread ${threadId} did not finish within ${timeoutMs / 1000} s`);
  }
}

async function cliSessions(runner: T3CliRunner, label: string): Promise<Json[]> {
  const sessions = parseJsonLoose(await runner.run(["auth", "session", "list", "--json"]));
  assert.ok(Array.isArray(sessions), "auth session list --json prints an array");
  return records(sessions).filter((session) => isRecord(session.client) && session.client.label === label);
}

// -------------------------------------------------------------------------------------------
// Contract assertions: real T3 versus the snapshot and the fake
// -------------------------------------------------------------------------------------------

function schemaType(schema: unknown): string | undefined {
  return isRecord(schema) && typeof schema.type === "string" ? schema.type : undefined;
}

function compareToolSchemas(real: Tool[], snapshot: Tool[]): void {
  const problems: string[] = [];
  for (const name of T3_FORWARDED_TOOLS) {
    const realTool = real.find((tool) => tool.name === name);
    const snapshotTool = snapshot.find((tool) => tool.name === name);
    if (!realTool) {
      problems.push(`${name} is missing from T3's tools/list`);
      continue;
    }
    if (!snapshotTool) {
      problems.push(`${name} is missing from the snapshot served by the fake`);
      continue;
    }
    const realProperties = isRecord(realTool.inputSchema.properties) ? realTool.inputSchema.properties : {};
    const snapshotProperties = isRecord(snapshotTool.inputSchema.properties) ? snapshotTool.inputSchema.properties : {};
    for (const [property, type] of Object.entries(BRIDGE_PROPERTIES[name] ?? {})) {
      if (schemaType(realProperties[property]) !== type) problems.push(`${name}.${property} is ${schemaType(realProperties[property]) ?? "absent"} in T3, expected ${type}`);
      if (schemaType(snapshotProperties[property]) !== type) problems.push(`${name}.${property} is ${schemaType(snapshotProperties[property]) ?? "absent"} in the snapshot`);
      const wanted = REQUIRED_ENUM_VALUES[`${name}.${property}`];
      if (wanted) {
        const values = isRecord(realProperties[property]) ? (realProperties[property] as Json).enum : undefined;
        for (const value of wanted) if (!Array.isArray(values) || !values.includes(value)) problems.push(`${name}.${property} no longer accepts "${value}"`);
      }
    }
    const realRequired = [...(realTool.inputSchema.required ?? [])].sort();
    const snapshotRequired = [...(snapshotTool.inputSchema.required ?? [])].sort();
    if (JSON.stringify(realRequired) !== JSON.stringify(snapshotRequired)) {
      problems.push(`${name} requires ${JSON.stringify(realRequired)} in T3 but ${JSON.stringify(snapshotRequired)} in the snapshot`);
    }
    if (realTool.description !== snapshotTool.description) notes.push(`${name} description differs from the snapshot (refresh src/testing/t3-tools.snapshot.json)`);
  }
  assert.deepEqual(problems, [], "T3's tool schemas must match what the bridge and the fake rely on");
}

/** The fake must emit exactly T3's fields (optional ones aside); the bridge's reads must exist. */
function compareKeys(what: string, real: Json[], fake: Json[], reads: string[]): void {
  assert.ok(real.length > 0, `no real ${what} to compare`);
  assert.ok(fake.length > 0, `no fake ${what} to compare`);
  const realUnion = new Set(real.flatMap((entry) => Object.keys(entry)));
  const fakeUnion = new Set(fake.flatMap((entry) => Object.keys(entry)));
  for (const entry of real) {
    const missing = reads.filter((key) => !(key in entry));
    assert.deepEqual(missing, [], `real ${what} lacks fields the bridge reads`);
  }
  const onlyFake = [...fakeUnion].filter((key) => !realUnion.has(key) && !OPTIONAL_ROW_KEYS.has(key));
  const onlyReal = [...realUnion].filter((key) => !fakeUnion.has(key) && !OPTIONAL_ROW_KEYS.has(key));
  assert.deepEqual({ onlyFake, onlyReal }, { onlyFake: [], onlyReal: [] }, `${what}: the fake must match T3's fields`);
}

async function failureCode(call: T3Call, tool: string, args: Json): Promise<Json> {
  const result = await call(tool, args);
  assert.equal(result.isError, true, `${tool} ${JSON.stringify(args)} must fail`);
  const parsed = parseJsonLoose(resultText(result));
  assert.ok(isRecord(parsed), `${tool} failure must be JSON`);
  return parsed;
}

async function httpFailureModes(origin: string, validToken: string): Promise<Json> {
  const post = (headers: Record<string, string>) =>
    fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(10_000),
    });
  const noToken = await post({});
  const badToken = await post({ authorization: `Bearer invalid-${randomUUID()}` });
  const badDottedToken = await post({ authorization: `Bearer invalid.${randomUUID()}` });
  const staleSession = await post({ authorization: `Bearer ${validToken}`, "mcp-session-id": randomUUID() });
  const bodyOf = async (response: Response) => parseJsonLoose(await response.text());
  return {
    noToken: { status: noToken.status, wwwAuthenticate: noToken.headers.get("www-authenticate")?.replace(/"[^"]*"/g, '"…"'), error: (await bodyOf(noToken) as Json | undefined)?.error },
    badToken: { status: badToken.status, wwwAuthenticate: badToken.headers.get("www-authenticate")?.replace(/"[^"]*"/g, '"…"'), error: (await bodyOf(badToken) as Json | undefined)?.error },
    badDottedToken: { status: badDottedToken.status, wwwAuthenticate: badDottedToken.headers.get("www-authenticate")?.replace(/"[^"]*"/g, '"…"'), error: (await bodyOf(badDottedToken) as Json | undefined)?.error },
    staleSession: { status: staleSession.status, body: await staleSession.text() },
  };
}

interface ShapeSample {
  launch: Json;
  wait: Json;
  listEnvelope: Json;
  listRows: Json[];
  read: Json;
  searchMatches: Json[];
  projectRows: Json[];
  threadId: string;
}

/** Launches one tiny scratch thread directly on a T3 (real or fake) and samples every result shape. */
async function sampleShapes(call: T3Call, title: string, query: string, modelSelection: Json): Promise<ShapeSample> {
  const launch = await ok(call, "t3_thread_launch", {
    scratch: true,
    title,
    message: "Reply with exactly OK",
    modelSelection,
    runtimeMode: "full-access",
    clientRequestId: randomUUID(),
  });
  const threadId = String(launch.threadId);
  const wait = await waitDone(call, threadId, SCENARIO_TIMEOUT_MS);
  const listEnvelope = await poll(`t3_thread_list to show ${threadId}`, async () => {
    const envelope = await ok(call, "t3_thread_list", { allProjects: true, includeSubagents: false, titleContains: query, limit: 5 });
    return records(envelope.threads).some((row) => row.threadId === threadId) ? envelope : undefined;
  });
  const read = await ok(call, "t3_thread_read", { threadId, view: "messages", limit: 5 });
  const searchMatches = await poll(`t3_thread_search to find ${threadId}`, async () => {
    const matches = records((await ok(call, "t3_thread_search", { query, limit: 5 })).matches).filter((match) => match.source === "title");
    return matches.some((match) => match.threadId === threadId) ? matches : undefined;
  });
  const projectRows = records((await ok(call, "t3_project_list", { limit: 5 })).projects);
  return { launch, wait, listEnvelope, listRows: records(listEnvelope.threads), read, searchMatches, projectRows, threadId };
}

async function poll<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await delay(1_000);
  }
}

async function contractAssertions(options: {
  realCall: T3Call;
  realClient: Client;
  fakeCall: T3Call;
  fakeClient: Client;
  realOrigin: string;
  realToken: string;
  fake: FakeT3;
  fakeToken: string;
  stamp: string;
  workDir: string;
}): Promise<string | undefined> {
  const { realCall, fakeCall, stamp } = options;
  let contractThreadId: string | undefined;

  await check("contract: forwarded tools and the properties the bridge uses", async () => {
    const real = await listAllTools(options.realClient);
    const snapshot = await listAllTools(options.fakeClient);
    compareToolSchemas(real, snapshot);
  });

  await check("contract: error codes for outside clients", async () => {
    for (const { tool, args, code } of ERROR_CASES) {
      const real = await failureCode(realCall, tool, args);
      const fake = await failureCode(fakeCall, tool, args);
      assert.equal(real._tag, "OrchestratorMcpFailure", `${tool} real _tag`);
      assert.equal(real.code, code, `${tool} real code`);
      assert.equal(fake._tag, real._tag, `${tool} fake _tag`);
      assert.equal(fake.code, real.code, `${tool} fake code`);
      if (fake.message !== real.message) notes.push(`${tool} error message differs from the fake's`);
    }
  });

  await check("contract: HTTP failure modes", async () => {
    const real = await httpFailureModes(options.realOrigin, options.realToken);
    const fake = await httpFailureModes(options.fake.origin, options.fakeToken);
    assert.deepEqual(fake, real);
    assert.equal((real.noToken as Json).status, 401);
    assert.equal((real.staleSession as Json).status, 404);
  });

  await check("contract: result shapes (list rows, read, search, projects, launch, wait)", async () => {
    const title = `DevSpace bridge check ${stamp} contract`;
    const real = await sampleShapes(realCall, title, stamp, LIVE_MODEL);
    contractThreadId = real.threadId;
    const fake = await sampleShapes(fakeCall, title, stamp, LIVE_MODEL);
    compareKeys("launch result", [real.launch], [fake.launch], BRIDGE_READS.launchResult);
    compareKeys("wait result", [real.wait], [fake.wait], BRIDGE_READS.waitResult);
    compareKeys("thread list envelope", [real.listEnvelope], [fake.listEnvelope], BRIDGE_READS.listEnvelope);
    compareKeys("thread list rows", real.listRows, fake.listRows, BRIDGE_READS.listRow);
    compareKeys("thread read envelope", [real.read], [fake.read], BRIDGE_READS.readEnvelope);
    compareKeys("thread read detail", [real.read.thread as Json], [fake.read.thread as Json], BRIDGE_READS.readThread);
    compareKeys("thread read items", records(real.read.items), records(fake.read.items), BRIDGE_READS.readItem);
    compareKeys("thread read runs", records(real.read.recentRuns), records(fake.read.recentRuns), []);
    compareKeys("search title matches", real.searchMatches, fake.searchMatches, BRIDGE_READS.searchMatch);
    compareKeys("project rows", real.projectRows, fake.projectRows, BRIDGE_READS.projectRow);
    assert.equal((real.read.thread as Json).runtimeMode, "full-access", "a full-access launch reports runtimeMode full-access");
    const lastItem = records(real.read.items).at(-1);
    assert.equal(lastItem?.type, "assistant_message");
    await ok(realCall, "t3_thread_organize", { threadId: real.threadId, action: "settle" });
    await ok(realCall, "t3_thread_organize", { threadId: real.threadId, action: "archive" });
    const archived = await ok(realCall, "t3_thread_read", { threadId: real.threadId, limit: 1 });
    assert.equal((archived.thread as Json).archived, true);
    assert.equal((archived.thread as Json).settled, true, "archiving also settles");
    contractThreadId = undefined;
  });

  await check("contract: Phase 2 schemas and result shapes (projects, scheduled tasks, models)", async () => {
    await phase2Contract(options.realClient, options.fakeClient, realCall, fakeCall, stamp, options.workDir, options.fake);
  });

  return contractThreadId;
}

/**
 * Phase 2 facts the bridge relies on, checked against T3 and the fake: the webhook fields the bridge
 * strips, the default model T3 ignores on create, the webhook URL key it removes from results, and
 * the capability and scheduled-task fields it reads.
 */
async function phase2Contract(
  realClient: Client,
  fakeClient: Client,
  realCall: T3Call,
  fakeCall: T3Call,
  stamp: string,
  workDir: string,
  fake: FakeT3,
): Promise<void> {
  for (const [what, client] of [["T3", realClient], ["the snapshot", fakeClient]] as const) {
    const tool = (await listAllTools(client)).find((entry) => entry.name === "schedule_task");
    const schedule = tool?.inputSchema.properties?.schedule as Json | undefined;
    const fields = isRecord(schedule?.properties) ? schedule.properties : {};
    for (const key of WEBHOOK_SCHEDULE_FIELDS) assert.ok(key in fields, `schedule_task schedule.${key} exists in ${what}`);
    assert.deepEqual(((fields.type ?? {}) as Json).enum, ["interval", "fixed_time", "once", "webhook"], `schedule types in ${what}`);
  }

  const model = LIVE_MODEL;
  const samples: Partial<Record<"real" | "fake", { project: Json; updated: Json; task: Json; listing: Json; capabilities: Json }>> = {};
  for (const [side, call, root] of [
    ["real", realCall, join(workDir, `contract-${stamp}`)],
    ["fake", fakeCall, join(fake.home, `contract-${stamp}`)],
  ] as const) {
    const project = await ok(call, "t3_project_create", {
      title: `DevSpace bridge check ${stamp} contract project`,
      workspaceRoot: root,
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: model,
    });
    try {
      assert.equal(project.defaultModelSelection, null, `${side}: T3 ignores defaultModelSelection on create (if this fails, T3 fixed it; expose it again)`);
      const updated = await ok(call, "t3_project_update", { projectId: project.id, defaultModelSelection: model });
      assert.deepEqual(updated.defaultModelSelection, model, `${side}: t3_project_update sets the default model`);
      const task = await ok(call, "schedule_task", {
        projectId: project.id,
        title: `DevSpace bridge check ${stamp} contract webhook`,
        prompt: "Reply with exactly OK",
        schedule: { type: "webhook" },
        bindToCurrentThread: false,
        enabled: false,
      });
      const listing = await ok(call, "list_scheduled_tasks", { projectId: project.id });
      assert.deepEqual(await ok(call, "delete_scheduled_task", { scheduledTaskId: task.scheduledTaskId }), { scheduledTaskId: task.scheduledTaskId, deleted: true });
      const capabilities = await ok(call, "orchestrator_capabilities", {});
      samples[side] = { project, updated, task, listing, capabilities };
    } finally {
      await call("t3_project_delete", { projectId: project.id, force: true });
    }
  }
  const real = samples.real!;
  const fakeSample = samples.fake!;
  if (typeof real.task.webhookUrl === "string") {
    assert.ok("webhookSignature" in real.task, "a webhook task result carries webhookSignature");
    assert.ok(records(real.listing.tasks).some((entry) => typeof entry.webhookUrl === "string"), "list_scheduled_tasks returns webhookUrl");
  } else {
    notes.push("T3 returned no webhookUrl (T3 Connect remote access is off); the webhook field names were not checked");
  }
  compareKeys("project records", [real.project, real.updated], [fakeSample.project, fakeSample.updated], BRIDGE_READS.projectRecord);
  compareKeys("scheduled tasks", [real.task], [fakeSample.task], BRIDGE_READS.scheduledTask);
  compareKeys("scheduled task listing", [real.listing], [fakeSample.listing], ["tasks"]);
  compareKeys("capabilities", [real.capabilities], [fakeSample.capabilities], ["providers"]);
  const realProviders = records(real.capabilities.providers);
  const fakeProviders = records(fakeSample.capabilities.providers);
  compareKeys("capability providers", realProviders, fakeProviders, BRIDGE_READS.capabilityProvider);
  compareKeys("capability models", realProviders.flatMap((entry) => records(entry.models)), fakeProviders.flatMap((entry) => records(entry.models)), BRIDGE_READS.capabilityModel);
  const claude = realProviders.find((entry) => entry.providerInstanceId === model.instanceId);
  assert.ok(claude && records(claude.models).some((entry) => entry.id === model.model), `T3 lists ${model.instanceId}/${model.model}`);
}

/**
 * Deletes every T3 project titled with the stamp (through a direct T3 client: DevSpace never
 * exposes deletion), removes the scenario folders and the stamp's worktrees, and confirms that no
 * project, scheduled task, or worktree carrying the stamp is left.
 */
async function cleanupStampedProjects(direct: T3Call, stamp: string, workDir: string | undefined): Promise<void> {
  const stampedTasks = async (): Promise<Json[]> =>
    records((await ok(direct, "list_scheduled_tasks", {})).tasks).filter((task) => String(task.title ?? "").includes(stamp));
  const tasks = await stampedTasks();
  for (const task of tasks) await ok(direct, "delete_scheduled_task", { scheduledTaskId: task.scheduledTaskId });
  if (tasks.length > 0) notes.push(`cleanup deleted ${tasks.length} leftover scheduled task(s)`);
  const stampedProjects = async (): Promise<Json[]> => {
    const found: Json[] = [];
    let cursor: unknown = undefined;
    for (let page = 0; page < 20; page += 1) {
      const listing = await ok(direct, "t3_project_list", { limit: 100, ...(typeof cursor === "number" ? { cursor } : {}) });
      found.push(...records(listing.projects).filter((project) => String(project.title).includes(stamp)));
      cursor = listing.nextCursor;
      if (typeof cursor !== "number") break;
    }
    return found;
  };
  for (const project of await stampedProjects()) await ok(direct, "t3_project_delete", { projectId: project.id, force: true });
  if (workDir) await rm(workDir, { recursive: true, force: true });
  const stampedWorktrees = async (): Promise<string[]> => (await readdir(T3_WORKTREES_DIR).catch(() => [] as string[])).filter((entry) => entry.includes(stamp));
  for (const entry of await stampedWorktrees()) await rm(join(T3_WORKTREES_DIR, entry), { recursive: true, force: true });
  assert.deepEqual((await stampedProjects()).map((project) => project.title), [], "no project carries the stamp");
  assert.deepEqual(await stampedWorktrees(), [], "no worktree carries the stamp");
  assert.deepEqual((await stampedTasks()).map((task) => task.title), [], "no scheduled task carries the stamp");
}

function checkCliShapes(log: CliRecord[], fakeLog: CliRecord[]): void {
  const pairing = log.find((entry) => entry.args.slice(0, 3).join(" ") === "auth pairing create");
  const fakePairing = fakeLog.find((entry) => entry.args.slice(0, 3).join(" ") === "auth pairing create");
  assert.ok(isRecord(pairing?.json) && isRecord(fakePairing?.json), "pairing create printed JSON");
  assert.deepEqual(Object.keys(pairing.json).sort(), ["credential", "expiresAt", "id", "label", "scopes"]);
  assert.deepEqual(Object.keys(fakePairing.json).sort(), Object.keys(pairing.json).sort());
  assert.deepEqual([...(pairing.json.scopes as string[])].sort(), [...FULL_ACCESS_SCOPES].sort());

  // Compare a listing that contains at least one MCP-client session: listings taken right after a
  // revoke can hold only the T3 app's own sessions, which carry other fields.
  const listsClientSession = (entry: CliRecord): boolean =>
    entry.args.slice(0, 3).join(" ") === "auth session list" && records(entry.json).some((item) => item.subject === "mcp-client");
  const list = log.find(listsClientSession);
  const fakeList = fakeLog.find(listsClientSession);
  assert.ok(list && fakeList, "session list printed at least one MCP-client session");
  // Only MCP-client sessions: the T3 app's own sessions carry other fields.
  const realEntries = records(list.json).filter((entry) => entry.subject === "mcp-client");
  const fakeEntries = records(fakeList.json).filter((entry) => entry.subject === "mcp-client");
  for (const entry of realEntries) assert.ok(typeof entry.sessionId === "string" && isRecord(entry.client), "session entries carry sessionId and client");
  compareKeys("session list entries", realEntries, fakeEntries, ["sessionId", "client", "scopes", "expiresAt"]);
  compareKeys("session list clients", realEntries.map((entry) => entry.client as Json), fakeEntries.map((entry) => entry.client as Json), ["label"]);

  const revoke = log.find((entry) => entry.args.slice(0, 3).join(" ") === "auth session revoke");
  const fakeRevoke = fakeLog.find((entry) => entry.args.slice(0, 3).join(" ") === "auth session revoke");
  assert.ok(revoke && fakeRevoke, "a session was revoked through the CLI");
  const revokePattern = /^Revoked session \S+\.\s*$/;
  assert.match(String(revoke.text), revokePattern);
  assert.match(String(fakeRevoke.text), revokePattern);
}

// -------------------------------------------------------------------------------------------
// Local target
// -------------------------------------------------------------------------------------------

async function preflight(settings: T3BridgeConfig): Promise<string> {
  let origin: string;
  try {
    origin = await createT3OriginResolver(settings)();
  } catch {
    fail(`${T3_UNREACHABLE_MESSAGE} Cannot read the T3 runtime file ${settings.runtimeFile}; start T3 Code and retry.`);
  }
  try {
    const response = await fetch(`${origin}/.well-known/oauth-protected-resource`, { signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel();
    if (!response.ok) fail(`T3 Code at ${origin} answered HTTP ${response.status} for its protected-resource metadata.`);
  } catch (error) {
    if (error instanceof LiveFailure) throw error;
    fail(`${T3_UNREACHABLE_MESSAGE} Nothing answered at ${origin}; start T3 Code and retry.`);
  }
  try {
    await access(settings.cliPath, constants.X_OK);
  } catch {
    fail(`T3 CLI not found or not executable at ${settings.cliPath}.`);
  }
  return origin;
}

function localConfig(stateDir: string, t3: T3BridgeConfig): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7693,
    oauth: {
      ownerToken: `t3-live-owner-${randomBytes(16).toString("hex")}`,
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 2592000,
      scopes: ["devspace"],
      allowedRedirectHosts: [],
    },
    allowedRoots: [stateDir],
    rootPolicies: normalizeRootPolicies([{ path: stateDir, access: "read-write" }]),
    allowedHosts: ["127.0.0.1"],
    publicBaseUrl: "http://127.0.0.1:7693",
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
    terminals: { backend: "tmux", runtimeDir: join(stateDir, "terminal-runtime"), maxPerWorkspace: 2, maxTotal: 4, idleTtlSeconds: 3600, useUserSystemd: false },
    maintenance: { intervalSeconds: 3600, closedSessionTtlSeconds: 604800, checkoutIdleTtlSeconds: 2592000, isolatedIdleTtlSeconds: 604800 },
    sessions: { idleTtlSeconds: 1800, sweepIntervalSeconds: 60 },
    logging: { level: "debug", format: "json", requests: true, assets: false, toolCalls: true, shellCommands: false, trustProxy: false },
    disabledCapabilities: new Set(["sky-cua", "node_repl"]),
    t3,
  };
}

async function listen(app: ReturnType<typeof createServer>["app"]): Promise<{ endpoint: string; server: HttpServer }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, server };
}

function scenarioReport(results: Awaited<ReturnType<typeof runScenarios>>): void {
  for (const result of results) {
    if (result.ok) progress(`ok - scenario ${result.id} ${JSON.stringify(result.details ?? {})}`);
    else {
      failures.push(`scenario ${result.id}: ${result.error}`);
      progress(`FAIL - scenario ${result.id}: ${result.error}`);
    }
  }
}

async function runLocal(stamp: string): Promise<void> {
  const settings = parseT3BridgeConfig({ enabled: true });
  const origin = await preflight(settings);
  progress(`T3 Code at ${origin}; CLI ${settings.cliPath}; stamp ${stamp}`);

  const secrets = new Set<string>();
  const cliLog: CliRecord[] = [];
  const runner = recordingRunner(createT3CliRunner(settings.cliPath, []), cliLog, secrets);
  const fetchImpl = recordingFetch(secrets);
  const resolveOrigin = createT3OriginResolver(settings);
  const harnessLabel = `devspace-t3-live-harness:${stamp}`;
  const harnessProvider = createT3TokenProvider({ runner, resolveOrigin, label: harnessLabel, fetchImpl });

  const fake = await FakeT3.start();
  const fakeCliLog: CliRecord[] = [];
  const fakeRunner = recordingRunner(createT3CliRunner(fake.cliPath, []), fakeCliLog, new Set());
  const fakeProvider = createT3TokenProvider({ runner: fakeRunner, resolveOrigin: async () => fake.origin, label: harnessLabel });

  const stateDir = await mkdtemp(join(tmpdir(), "devspace-t3-live-"));
  // S9, S10, and the Phase 2 contract clone and create project folders here.
  const workDir = await mkdtemp(join(tmpdir(), "devspace-t3-live-work-"));
  const config = localConfig(stateDir, settings);
  const label = t3SessionLabel(stateDir);
  const bridgeProviders: T3TokenProvider[] = [];
  const makeBridge = (): T3Bridge => {
    const tokenProvider = createT3TokenProvider({ runner, resolveOrigin, label, fetchImpl });
    bridgeProviders.push(tokenProvider);
    return new T3Bridge({ config: settings, label, secretNames: config.secretNames, logging: config.logging, tokenProvider });
  };
  const store = new SqliteOAuthStateStore(stateDir);
  store.saveToken({
    tokenHash: createHash("sha256").update(DEVSPACE_ACCESS_TOKEN).digest("base64url"),
    tokenType: "access",
    clientId: "t3-live",
    scopes: ["devspace"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    resource: new URL(`${config.publicBaseUrl}/mcp`),
  });
  store.close();

  const consoleCapture = captureConsole();
  const outputs: string[] = [];
  let bridge = makeBridge();
  const running = createServer(config, { t3Bridge: bridge });
  let httpServer: HttpServer | undefined;
  let client: Client | undefined;
  let harness: Client | undefined;
  let fakeHarness: Client | undefined;
  const firstBridge = bridge;
  let ctx: ScenarioContext | undefined;
  let contractThreadId: string | undefined;
  let threadsCleaned = false;
  // Settles and archives every thread carrying the stamp (through DevSpace when connected), then
  // confirms through the direct client that none is left unarchived.
  const archiveStampedThreads = async (): Promise<void> => {
    if (client) {
      const archivedNow = await cleanupScenarioThreads(
        ctx ?? { kind: "live", client, stamp, projectName: LIVE_PROJECT, modelSelection: LIVE_MODEL, timeoutMs: SCENARIO_TIMEOUT_MS },
      );
      if (archivedNow > 0) notes.push(`cleanup archived ${archivedNow} leftover thread(s)`);
    } else if (harness && contractThreadId) {
      await ok(directCaller(harness), "t3_thread_organize", { threadId: contractThreadId, action: "archive" });
    }
    if (harness) {
      const remaining = records(
        (await ok(directCaller(harness), "t3_thread_list", { allProjects: true, includeSubagents: false, titleContains: stamp, limit: 100 })).threads,
      );
      assert.deepEqual(remaining.map((row) => row.title), [], "no unarchived thread carries the stamp");
    }
    contractThreadId = undefined;
  };
  try {
    const listening = await listen(running.app);
    httpServer = listening.server;
    const endpoint = listening.endpoint;

    const harnessToken = await harnessProvider.getToken();
    harness = await connectMcp(`${origin}/mcp`, harnessToken);
    const fakeToken = await fakeProvider.getToken();
    fakeHarness = await connectMcp(`${fake.origin}/mcp`, fakeToken);
    const harnessCall = directCaller(harness);
    contractThreadId = await contractAssertions({
      realCall: harnessCall,
      realClient: harness,
      fakeCall: directCaller(fakeHarness),
      fakeClient: fakeHarness,
      realOrigin: origin,
      realToken: harnessToken,
      fake,
      fakeToken,
      stamp,
      workDir,
    });

    // The chain: MCP client → in-process DevSpace → bridge → real T3.
    const deadline = Date.now() + 30_000;
    while (!(await bridge.toolDefinitions()).every((definition) => definition.live)) {
      if (Date.now() > deadline) fail("the bridge did not load T3's live catalog within 30 s");
      await delay(250);
    }
    client = await connectMcp(endpoint, DEVSPACE_ACCESS_TOKEN);
    recordResults(client, outputs);
    const call = devspaceCaller(client);

    await check("B1/B2/B3/B12/B17/B26: DevSpace exposes exactly the DevSpace T3 tools with trimmed schemas and real descriptions", async () => {
      const baseline = await toolNames(endpoint, DEVSPACE_ACCESS_TOKEN, { "x-disabled-capabilities": "t3" });
      for (const name of T3_TOOL_NAMES) assert.ok(!baseline.includes(name), `${name} is hidden when the session disables t3`);
      checkCatalog((await listAllTools(client!)) as CatalogTool[], { baseline: new Set(baseline) });
    });

    await check("B4: the bridge minted through the CLI pairing flow at full access", async () => {
      const pairing = cliLog.find((entry) => entry.args.slice(0, 3).join(" ") === "auth pairing create" && entry.args.includes(label));
      assert.ok(pairing, "the bridge created a pairing code");
      assert.deepEqual(pairing.args, ["auth", "pairing", "create", "--json", "--ttl", "2m", "--label", label, ...FULL_ACCESS_SCOPES.flatMap((scope) => ["--scope", scope])]);
      const own = await cliSessions(runner, label);
      assert.equal(own.length, 1, "one live session for the bridge's label");
      assert.deepEqual([...(own[0]!.scopes as string[])].sort(), [...FULL_ACCESS_SCOPES].sort());
    });

    await check("B13/B16: compact list and project rows; no subagent rows by default", async () => {
      const list = await ok(call, "t3_thread_list");
      const rows = records(list.threads);
      assert.ok(rows.length <= 10);
      for (const row of rows) {
        assert.deepEqual(Object.keys(row).sort(), ["link", "project", "settled", "status", "threadId", "title", "updatedAt"]);
        assert.match(String(row.link), /^https:\/\//);
        const detail = await ok(harnessCall, "t3_thread_read", { threadId: row.threadId, limit: 1, maxCharsPerItem: 1 });
        assert.notEqual((detail.thread as Json).relationshipToParent, "subagent", `${String(row.threadId)} is a subagent thread`);
      }
      const projects = records((await ok(call, "t3_project_list")).projects);
      assert.ok(projects.some((project) => project.title === LIVE_PROJECT), `the "${LIVE_PROJECT}" project exists`);
      for (const project of projects) assert.deepEqual(Object.keys(project).sort(), ["projectId", "title", "workspaceRoot"]);
    });

    ctx = { kind: "live", client, stamp, projectName: LIVE_PROJECT, modelSelection: LIVE_MODEL, timeoutMs: SCENARIO_TIMEOUT_MS, workDir };
    scenarioReport(await runScenarios(ctx, LOCAL_SCENARIOS));

    await check("cleanup: every thread titled with the stamp is archived", async () => {
      await archiveStampedThreads();
      threadsCleaned = true;
    });

    await check("B5: restarting the bridge twice leaves one live session for its label", async () => {
      for (let restart = 1; restart <= 2; restart += 1) {
        await bridge.close();
        bridge = makeBridge();
        const result = await bridge.call("t3_project_list", { limit: 1 });
        outputs.push(JSON.stringify(result));
        assert.notEqual(result.isError, true, resultText(result));
        assert.equal((await cliSessions(runner, label)).length, 1, `restart ${restart}`);
      }
    });

    await check("B23: no token, pairing code, or authorization code in DevSpace logs or tool results", async () => {
      // Every issued secret was captured from the CLI and OAuth responses; the providers' current tokens are added explicitly.
      for (const provider of [bridgeProviders.at(-1), harnessProvider]) if (provider) secrets.add(await provider.getToken());
      assert.ok(consoleCapture.lines.some((line) => line.includes('"event":"t3_bridge_connected"')), "bridge debug logs were captured");
      scanForSecrets(secrets, [...outputs, ...consoleCapture.lines]);
    });
  } finally {
    consoleCapture.restore();
    if (!threadsCleaned) await check("cleanup: every thread titled with the stamp is archived", archiveStampedThreads);
    await check("cleanup: no project, folder, worktree, or scheduled task carrying the stamp remains", async () => {
      if (harness) await cleanupStampedProjects(directCaller(harness), stamp, workDir);
      else await rm(workDir, { recursive: true, force: true });
    });
    await client?.close().catch(() => undefined);
    running.close?.();
    if (httpServer) {
      const closing = new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      httpServer.closeAllConnections();
      await closing;
    }
    await firstBridge.close().catch(() => undefined);
    // Revocation is by label, so this also covers sessions minted by earlier bridge instances.
    await check("cleanup: revoke the bridge's sessions", () => bridge.close({ revoke: true }));
    await harness?.close().catch(() => undefined);
    await check("cleanup: revoke the harness sessions", async () => {
      await harnessProvider.revokeOwnSessions();
    });
    await check("cleanup: no T3 session remains for the bridge or harness labels", async () => {
      assert.equal((await cliSessions(runner, label)).length, 0, "bridge label");
      assert.equal((await cliSessions(runner, harnessLabel)).length, 0, "harness label");
    });
    await fakeHarness?.close().catch(() => undefined);
    await fakeProvider.revokeOwnSessions().catch(() => 0);
    await check("contract: CLI output shapes (pairing, session list, revoke) match the fake", () => checkCliShapes(cliLog, fakeCliLog));
    await fake.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------------------------------
// Deployed target
// -------------------------------------------------------------------------------------------

interface DeployedOAuthCache extends HeadlessOAuthBundle {
  /** When the refresh token expires, when DevSpace reports it (`refresh_token_expires_in`). */
  refresh_expires_at?: string;
}

interface DeployedCredential {
  accessToken: string;
  reused: boolean;
  refreshExpiresAt?: string;
  /** Revokes the access token at the advertised revocation endpoint; false when none is advertised. */
  revoke(): Promise<boolean>;
}

function sameOrigin(url: unknown, origin: string): url is string {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function refreshExpiry(tokens: unknown): string | undefined {
  const seconds = isRecord(tokens) ? tokens.refresh_token_expires_in : undefined;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : undefined;
}

/** The cached bundle when it belongs to this DevSpace and carries a refresh token. Never printed. */
async function readDeployedCache(expectedResource: string, origin: string): Promise<DeployedOAuthCache | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(DEPLOYED_OAUTH_CACHE, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.resource !== expectedResource) return undefined;
  const { metadata, client, tokens } = parsed;
  if (!isRecord(metadata) || !isRecord(client) || !isRecord(tokens)) return undefined;
  if (typeof client.client_id !== "string" || typeof tokens.refresh_token !== "string" || tokens.refresh_token === "") return undefined;
  if (!sameOrigin(metadata.token_endpoint, origin)) return undefined;
  return parsed as unknown as DeployedOAuthCache;
}

async function writeDeployedCache(cache: DeployedOAuthCache): Promise<void> {
  const directory = dirname(DEPLOYED_OAUTH_CACHE);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  // Atomic replace with mode 0600.
  await writeOAuthBundle(DEPLOYED_OAUTH_CACHE, cache);
}

/** Refresh-token grant against the cached token endpoint; undefined when DevSpace refuses it. */
async function refreshDeployed(cache: DeployedOAuthCache): Promise<DeployedOAuthCache | undefined> {
  let response: Response;
  try {
    response = await fetch(cache.metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: cache.tokens.refresh_token,
        client_id: cache.client.client_id,
        resource: cache.resource,
      }),
      signal: AbortSignal.timeout(DEPLOYED_OAUTH_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (!isRecord(body) || typeof body.access_token !== "string" || body.access_token === "") return undefined;
  // DevSpace rotates refresh tokens: the one just used is gone, so store the new one.
  const rotated = typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : undefined;
  return {
    ...cache,
    tokens: {
      ...cache.tokens,
      access_token: body.access_token,
      token_type: typeof body.token_type === "string" ? body.token_type : cache.tokens.token_type,
      expires_in: typeof body.expires_in === "number" ? body.expires_in : cache.tokens.expires_in,
      refresh_token: rotated ?? cache.tokens.refresh_token,
      ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
    },
    refresh_expires_at: rotated ? refreshExpiry(body) : cache.refresh_expires_at,
  };
}

/**
 * DevSpace credential for the deployed suite. DevSpace retains at most 500 registered OAuth clients
 * and refuses registration beyond that, so the suite keeps one headless client and its refresh
 * token in DEPLOYED_OAUTH_CACHE and refreshes it on each run; it mints (and caches) a new client
 * only when the cache is missing, belongs to another DevSpace, or its refresh fails.
 */
async function deployedCredential(publicBaseUrl: string, ownerToken: string | undefined, ownerTokenSource: string): Promise<DeployedCredential> {
  const origin = new URL(publicBaseUrl).origin;
  const cached = await readDeployedCache(new URL("/mcp", publicBaseUrl).href, origin);
  let bundle: DeployedOAuthCache | undefined = cached ? await refreshDeployed(cached) : undefined;
  const reused = bundle !== undefined;
  if (!bundle) {
    if (!ownerToken) fail(`No owner token in ${ownerTokenSource} (or DEVSPACE_OAUTH_OWNER_TOKEN), and no reusable DevSpace OAuth client is cached.`);
    let minted: HeadlessOAuthBundle;
    try {
      minted = await mintHeadlessOAuth({ baseUrl: publicBaseUrl, ownerToken, clientName: "DevSpace T3 deployed check" });
    } catch (error) {
      fail(`Could not authenticate to DevSpace at ${publicBaseUrl}: ${describe(error)}`);
    }
    bundle = { ...minted, refresh_expires_at: refreshExpiry(minted.tokens) };
  }
  // Store before use: a rotated refresh token is the only one that still works. The access token
  // is not persisted; it is revoked at the end of the run.
  await writeDeployedCache({ ...bundle, tokens: { ...bundle.tokens, access_token: "" } });
  const accessToken = bundle.tokens.access_token;
  const clientId = bundle.client.client_id;
  const revocationEndpoint = bundle.metadata.revocation_endpoint;
  return {
    accessToken,
    reused,
    refreshExpiresAt: bundle.refresh_expires_at,
    async revoke() {
      if (!sameOrigin(revocationEndpoint, origin)) return false;
      const response = await fetch(revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: accessToken, token_type_hint: "access_token", client_id: clientId }),
        signal: AbortSignal.timeout(DEPLOYED_OAUTH_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new Error(`DevSpace token revocation failed with HTTP ${response.status}.`);
      return true;
    },
  };
}

async function runDeployed(stamp: string): Promise<void> {
  const files = loadDevspaceFiles(process.env);
  const publicBaseUrl = process.env.DEVSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? undefined;
  if (!publicBaseUrl) fail(`No publicBaseUrl in ${files.configPath} (or DEVSPACE_PUBLIC_BASE_URL).`);
  const ownerToken = process.env.DEVSPACE_OAUTH_OWNER_TOKEN ?? files.auth.ownerToken ?? undefined;

  // Check T3 first: a failed check then leaves no DevSpace access token to revoke.
  const settings = parseT3BridgeConfig({ enabled: true });
  const origin = await preflight(settings);
  const credential = await deployedCredential(publicBaseUrl, ownerToken, files.authPath);
  progress(
    `DevSpace OAuth client ${credential.reused ? "reused" : "newly minted"}${credential.refreshExpiresAt ? `; refresh token expires ${credential.refreshExpiresAt}` : ""}`,
  );
  const accessToken = credential.accessToken;
  const endpoint = new URL("/mcp", publicBaseUrl).href;
  // The gateway runs on this machine: a direct T3 client removes the projects S9 and S10 create
  // (DevSpace never exposes deletion), and the scenarios clone into a local folder.
  const runner = createT3CliRunner(settings.cliPath, []);
  const harnessLabel = `devspace-t3-deployed-harness:${stamp}`;
  const harnessProvider = createT3TokenProvider({ runner, resolveOrigin: createT3OriginResolver(settings), label: harnessLabel });
  const workDir = await mkdtemp(join(tmpdir(), "devspace-t3-deployed-work-"));
  let harness: Client | undefined;
  try {
    harness = await connectMcp(`${origin}/mcp`, await harnessProvider.getToken());
    await runDeployedChecks(endpoint, accessToken, stamp, workDir);
  } finally {
    await check("cleanup: no project, folder, worktree, or scheduled task carrying the stamp remains", async () => {
      if (harness) await cleanupStampedProjects(directCaller(harness), stamp, workDir);
      else await rm(workDir, { recursive: true, force: true });
    });
    await harness?.close().catch(() => undefined);
    await check("cleanup: revoke the harness's T3 sessions", async () => {
      await harnessProvider.revokeOwnSessions();
      assert.equal((await cliSessions(runner, harnessLabel)).length, 0, "harness label");
    });
    // Also runs when the MCP connection itself failed, so no run leaves its access token valid.
    await check("cleanup: revoke the DevSpace access token (the cached refresh token is kept)", async () => {
      if (!(await credential.revoke())) notes.push("DevSpace advertises no revocation endpoint; the access token expires on its own");
    });
  }
}

/**
 * Right after a gateway restart, MCP sessions get the bridge's fallback schemas until the bridge has
 * loaded T3's catalog (its first load mints a T3 credential). The deployed suite usually runs right
 * after a deployment, so it waits until a fresh session lists the live schemas.
 */
async function waitForLiveCatalog(endpoint: string, accessToken: string): Promise<void> {
  const deadline = Date.now() + LIVE_CATALOG_WAIT_MS;
  for (;;) {
    const probe = await connectMcp(endpoint, accessToken);
    try {
      const launch = (await listAllTools(probe)).find((tool) => tool.name === "t3_thread_launch");
      const properties = launch?.inputSchema.properties;
      if (isRecord(properties) && "message" in properties) return;
    } finally {
      await probe.close().catch(() => undefined);
    }
    if (Date.now() > deadline) fail(`The deployed gateway did not serve T3's live tool schemas within ${LIVE_CATALOG_WAIT_MS / 1000} s.`);
    await delay(3_000);
  }
}

async function runDeployedChecks(endpoint: string, accessToken: string, stamp: string, workDir: string): Promise<void> {
  await waitForLiveCatalog(endpoint, accessToken);
  const client = await connectMcp(endpoint, accessToken);
  const call = devspaceCaller(client);
  const kind: ScenarioTargetKind = "deployed";
  const ctx: ScenarioContext = { kind, client, stamp, projectName: LIVE_PROJECT, modelSelection: LIVE_MODEL, timeoutMs: SCENARIO_TIMEOUT_MS, workDir };
  try {
    const probe = await call("t3_project_list", { limit: 1 });
    if (probe.isError) fail(`The deployed gateway cannot use T3 Code: ${resultText(probe)}`);

    await check("B2/B3/B12/B17/B26: the deployed gateway exposes exactly the DevSpace T3 tools", async () => {
      const baseline = await toolNames(endpoint, accessToken, { "x-disabled-capabilities": "t3" });
      checkCatalog((await listAllTools(client)) as CatalogTool[], { baseline: new Set(baseline) });
    });

    await check("B16: compact list and project rows", async () => {
      for (const row of records((await ok(call, "t3_thread_list")).threads)) {
        assert.deepEqual(Object.keys(row).sort(), ["link", "project", "settled", "status", "threadId", "title", "updatedAt"]);
      }
      const projects = records(resultData(await call("t3_project_list")).projects);
      assert.ok(projects.some((project) => project.title === LIVE_PROJECT), `the "${LIVE_PROJECT}" project exists`);
      for (const project of projects) assert.deepEqual(Object.keys(project).sort(), ["projectId", "title", "workspaceRoot"]);
    });

    scenarioReport(await runScenarios(ctx, DEPLOYED_SCENARIOS));
  } finally {
    await check("cleanup: every thread titled with the stamp is archived (through DevSpace)", async () => {
      const archivedNow = await cleanupScenarioThreads(ctx);
      if (archivedNow > 0) notes.push(`cleanup archived ${archivedNow} leftover thread(s)`);
      const remaining = records((await ok(call, "t3_thread_list", { titleContains: stamp, limit: 100 })).threads);
      assert.deepEqual(remaining.map((row) => row.title), [], "no unarchived thread carries the stamp");
    });
    await client.close().catch(() => undefined);
  }
}

// -------------------------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------------------------

let target: Target | undefined;
try {
  target = parseTarget(process.argv.slice(2));
  const stamp = newStamp();
  progress(`t3-live (${target}): starting; real T3 threads are titled "DevSpace bridge check ${stamp} …"`);
  if (target === "local") await runLocal(stamp);
  else await runDeployed(stamp);
} catch (error) {
  failures.push(describe(error));
}

for (const note of notes) progress(`note - ${note}`);
if (failures.length > 0) {
  process.stderr.write(`t3-live (${target ?? "no target"}) FAILED:\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`);
  process.exit(1);
}
progress(`t3-live (${target}): all checks passed`);
process.exit(0);
