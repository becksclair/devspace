/**
 * Fake T3 Code server and CLI for tests (plan 015, "Fake T3").
 *
 * Mirrors the real T3 Code behavior captured in `t3-tools.snapshot.json` and
 * `t3-contract-samples.json`: the headless OAuth flow, the `/mcp` bearer and
 * session failure modes, the Phase 1 orchestration tools, and the `t3 auth`
 * CLI commands DevSpace uses. Excluded from the build; tests only.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  isInitializeRequest,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export interface FakeT3Options {
  /** Milliseconds per second of a scripted `time.sleep(n)` turn. Default 20. */
  sleepScaleMs?: number;
  /** Delay before a scripted turn replies. Default 30. */
  completionDelayMs?: number;
  /** Access-token lifetime (`expires_in`). Default 2592000 (30 days), like T3. */
  tokenTtlSeconds?: number;
}

type JsonObject = Record<string, unknown>;

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

interface SnapshotTool {
  name: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

type RunStatus =
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "rolled_back";
type ThreadStatus = "idle" | RunStatus;
type ItemStatus = "idle" | "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
type CreatedBy = "user" | "agent" | "system";
type CreationSource = "web" | "mobile" | "mcp" | "provider" | "server";

interface ProjectRecord {
  id: string;
  title: string;
  workspaceRoot: string;
  projectIcon: JsonObject | null;
  createdAt: string;
  updatedAt: string;
}

interface ItemRecord {
  position: number;
  itemId: string;
  runId: string | null;
  messageId: string | null;
  createdBy: CreatedBy | null;
  creationSource: CreationSource | null;
  type: string;
  status: ItemStatus;
  title: string | null;
  text: string;
  updatedAt: string;
}

interface QuestionRecord {
  requestId: string;
  id: string;
  header: string;
  question: string;
  options: string[];
}

type RunScript =
  | { kind: "reply"; word: string }
  | { kind: "sleep"; durationMs: number; command: string; word: string }
  | { kind: "ask"; question: string; options: string[] }
  | { kind: "static" };

interface RunRecord {
  runId: string;
  ordinal: number;
  status: RunStatus;
  providerInstanceId: string;
  model: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  message: string | null;
  messageId: string | null;
  script: RunScript;
  questions: QuestionRecord[];
  approvals: number;
  interruptRequested: boolean;
  commandItem: ItemRecord | null;
  timers: Set<NodeJS.Timeout>;
}

interface ThreadRecord {
  threadId: string;
  projectId: string;
  title: string;
  createdBy: CreatedBy;
  creationSource: CreationSource;
  modelSelection: JsonObject;
  providerInstanceId: string;
  model: string;
  runtimeMode: string;
  interactionMode: string;
  branch: string | null;
  worktreePath: string | null;
  parentThreadId: string | null;
  relationshipToParent: "fork" | "subagent" | null;
  archived: boolean;
  settled: boolean;
  settledAt: string | null;
  snoozedUntil: string | null;
  pinnedAt: string | null;
  unread: boolean;
  createdAt: string;
  updatedAt: string;
  touched: number;
  runs: RunRecord[];
  /** Run ids waiting behind the active run, in dispatch order. */
  queue: string[];
  items: ItemRecord[];
  nextOrdinal: number;
}

interface OAuthClient {
  clientId: string;
  clientName: string | undefined;
  redirectUris: string[];
}

interface PairingRecord {
  id: string;
  credential: string;
  label: string;
  scopes: string[];
  expiresAt: number;
  consumed: boolean;
}

interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | undefined;
  scopes: string[];
  label: string;
  expiresAt: number;
  used: boolean;
}

interface AuthSession {
  sessionId: string;
  token: string;
  clientId: string;
  label: string;
  scopes: string[];
  userAgent: string;
  issuedAt: number;
  expiresAt: number;
  lastConnectedAt: string | null;
  revoked: boolean;
}

interface McpSessionEntry {
  transport: StreamableHTTPServerTransport;
  server: Server;
  authSessionId: string;
}

interface CallContext {
  clientId: string;
  signal: AbortSignal;
}

const SERVER_INFO = { name: "T3 Code", version: "0.1.8-nightly.20261109.4392" };
const FULL_ACCESS_SCOPES = ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"];
const SUPPORTED_SCOPES = ["orchestration:read", "orchestration:operate"];
const TOKEN_TTL_SECONDS = 2_592_000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
const CREDENTIAL_ERROR_BODY = JSON.stringify({
  error: "invalid_mcp_credential",
  message: "A valid T3 Code MCP credential is required.",
});
const NOT_IN_THREAD = "this MCP client is not running inside a T3 thread.";
const DEFAULT_MODEL_SELECTION = { instanceId: "claudeAgent", model: "claude-haiku-5-5" };
const STEP_MS = 2;
const CLOSE_SETTLE_MS = 25;
const MAX_BODY_BYTES = 1_048_576;
const ACTIVE_RUN_STATUSES = new Set<RunStatus>(["preparing", "starting", "running", "waiting"]);
const STEERABLE_RUN_STATUSES = new Set<RunStatus>(["running", "waiting"]);
const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
const THREAD_STATUSES = new Set<ThreadStatus>([
  "idle",
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const SNAPSHOT_PATH = fileURLToPath(new URL("./t3-tools.snapshot.json", import.meta.url));
const CLI_SCRIPT_PATH = fileURLToPath(new URL("./fake-t3-cli.mjs", import.meta.url));

/** A tool-level failure, returned as an `isError` result with T3's failure JSON. */
class ToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A JSON-RPC error whose wire message carries no extra "MCP error" prefix, like T3's. */
function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const nowIso = (): string => new Date().toISOString();
const secret = (bytes = 32): string => randomBytes(bytes).toString("base64url");
const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const optString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const optInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "thread";

function ok(value: JsonObject): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function failure(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure", code, message }) }],
  };
}

function checkValue(schema: JsonSchema, value: unknown): string | undefined {
  const actual = JSON.stringify(value);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `Expected ${schema.enum.map((option) => JSON.stringify(option)).join(" | ")}, actual ${actual}`;
  }
  switch (schema.type) {
    case "string":
      return typeof value === "string" ? undefined : `Expected string, actual ${actual}`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `Expected boolean, actual ${actual}`;
    case "object":
      return isRecord(value) ? undefined : `Expected object, actual ${actual}`;
    case "array":
      return Array.isArray(value) ? undefined : `Expected array, actual ${actual}`;
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) {
        return `Expected ${schema.type === "integer" ? "an integer" : "a number"}, actual ${actual}`;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `Expected a number greater than or equal to ${schema.minimum}, actual ${actual}`;
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `Expected a number less than or equal to ${schema.maximum}, actual ${actual}`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Mirrors T3's argument decoding: required keys, top-level types and enums. Unknown keys are
 * ignored, and `null` on an optional key is accepted (`t3_queue` documents `beforeRunId: null`).
 */
function validateArguments(tool: SnapshotTool, args: JsonObject): string | undefined {
  for (const key of tool.inputSchema.required ?? []) {
    if (args[key] === undefined) return `Missing key\n  at ["${key}"]`;
  }
  for (const [key, value] of Object.entries(args)) {
    const schema = tool.inputSchema.properties?.[key];
    if (!schema || value === undefined || (value === null && !tool.inputSchema.required?.includes(key))) continue;
    const problem = checkValue(schema, value);
    if (problem) return `${problem}\n  at ["${key}"]`;
  }
  return undefined;
}

/** Scripted agent behavior, keyed off the same prompts the live suite uses. */
function scriptFor(message: string, sleepScaleMs: number): RunScript {
  const ask = /ask me exactly one question, '([^']*)', with exactly two options: '([^']*)' and '([^']*)'/i.exec(message);
  if (ask) return { kind: "ask", question: ask[1], options: [ask[2], ask[3]] };
  const word = /reply with exactly\s+['"`]?([^\s'"`.,;!?]+)/i.exec(message)?.[1] ?? "OK";
  const sleep = /python3 -c 'import time; time\.sleep\((\d+(?:\.\d+)?)\)'/.exec(message);
  if (sleep) return { kind: "sleep", durationMs: Number(sleep[1]) * sleepScaleMs, command: sleep[0], word };
  return { kind: "reply", word };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function listen(server: HttpServer, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function isActive(run: RunRecord): boolean {
  return ACTIVE_RUN_STATUSES.has(run.status);
}

function activeRun(thread: ThreadRecord): RunRecord | undefined {
  return thread.runs.find(isActive);
}

/** The newest run that is not waiting in the queue behind another run. */
function latestRun(thread: ThreadRecord): RunRecord | undefined {
  for (let index = thread.runs.length - 1; index >= 0; index--) {
    const run = thread.runs[index];
    if (!thread.queue.includes(run.runId)) return run;
  }
  return undefined;
}

function threadStatus(thread: ThreadRecord): ThreadStatus {
  return activeRun(thread)?.status ?? latestRun(thread)?.status ?? "idle";
}

function pendingRequestCount(thread: ThreadRecord): number {
  return thread.runs.reduce((count, run) => count + run.questions.length + run.approvals, 0);
}

function byUpdatedDesc(a: ThreadRecord, b: ThreadRecord): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return b.touched - a.touched;
}

export class FakeT3 {
  readonly origin: string;
  readonly runtimeFile: string;
  /**
   * Executable wrapper for the fake CLI. The CLI talks to this in-process server, so run it
   * asynchronously: `execFileSync` blocks the event loop that must answer it and deadlocks.
   */
  readonly cliPath: string;
  readonly calls: Array<{ tool: string; args: Record<string, unknown>; label: string }> = [];
  readonly cliInvocations: Array<{ args: string[]; envNames: string[] }> = [];

  private readonly port: number;
  private readonly tempDir: string;
  private readonly resource: string;
  private readonly adminPrefix: string;
  private readonly sleepScaleMs: number;
  private readonly completionDelayMs: number;
  private readonly tokenTtlSeconds: number;
  private readonly environmentId = randomUUID();
  private readonly toolsList: SnapshotTool[];
  private readonly toolsByName: Map<string, SnapshotTool>;
  private readonly secrets: string[] = [];
  private readonly clients = new Map<string, OAuthClient>();
  private readonly pairings = new Map<string, PairingRecord>();
  private readonly authorizationCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly sessions = new Map<string, AuthSession>();
  private readonly sessionsByToken = new Map<string, string>();
  private readonly mcpSessions = new Map<string, McpSessionEntry>();
  private readonly requestSockets = new Map<string, Socket>();
  private readonly drops = new Map<string, number>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly idempotent = new Map<string, JsonObject>();
  private readonly waiters = new Set<() => void>();
  private readonly scratchProjectId: string;
  private httpServer: HttpServer | undefined;
  private sequence = 1000;
  private touchCounter = 0;
  private stopped = false;
  private rejectingCredentials = false;

  private constructor(tempDir: string, httpServer: HttpServer, port: number, options: FakeT3Options) {
    this.tempDir = tempDir;
    this.httpServer = httpServer;
    this.port = port;
    this.origin = `http://127.0.0.1:${port}`;
    this.resource = `${this.origin}/mcp`;
    this.adminPrefix = `/__fake/${secret(16)}/`;
    this.sleepScaleMs = options.sleepScaleMs ?? 20;
    this.completionDelayMs = options.completionDelayMs ?? 30;
    this.tokenTtlSeconds = options.tokenTtlSeconds ?? TOKEN_TTL_SECONDS;
    this.toolsList = (JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as { tools: SnapshotTool[] }).tools;
    this.toolsByName = new Map(this.toolsList.map((tool) => [tool.name, tool]));

    this.runtimeFile = join(tempDir, "server-runtime.json");
    writeFileSync(
      this.runtimeFile,
      `${JSON.stringify({
        pid: process.pid,
        host: "127.0.0.1",
        port,
        origin: this.origin,
        startedAt: nowIso(),
        serverVersion: SERVER_INFO.version,
      })}\n`,
    );
    this.cliPath = join(tempDir, "t3");
    writeFileSync(
      this.cliPath,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(CLI_SCRIPT_PATH)} --admin ${shellQuote(`${this.origin}${this.adminPrefix.slice(0, -1)}`)} "$@"\n`,
      { mode: 0o755 },
    );

    const createdAt = nowIso();
    this.scratchProjectId = randomUUID();
    this.projects.set(this.scratchProjectId, {
      id: this.scratchProjectId,
      title: "No project",
      workspaceRoot: join(tempDir, "scratch"),
      projectIcon: { kind: "lucide", name: "message-square-dashed", color: "gray" },
      createdAt,
      updatedAt: createdAt,
    });
    httpServer.on("request", this.onRequest);
  }

  static async start(options: FakeT3Options = {}): Promise<FakeT3> {
    const tempDir = mkdtempSync(join(tmpdir(), "fake-t3-"));
    const httpServer = createServer();
    try {
      const port = await listen(httpServer, 0);
      return new FakeT3(tempDir, httpServer, port, options);
    } catch (error) {
      httpServer.close();
      rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Control API
  // ---------------------------------------------------------------------------

  /** Every access token, pairing credential, and authorization code issued so far. */
  issuedSecrets(): string[] {
    return [...this.secrets];
  }

  /** Unrevoked, unexpired auth sessions whose client label is `label`. */
  liveSessions(label: string): number {
    return [...this.sessions.values()].filter((session) => session.label === label && this.isLive(session)).length;
  }

  addProject(input: { title: string; workspaceRoot?: string }): { projectId: string } {
    const id = randomUUID();
    const at = nowIso();
    this.projects.set(id, {
      id,
      title: input.title,
      workspaceRoot: input.workspaceRoot ?? join(this.tempDir, "projects", slug(input.title)),
      projectIcon: null,
      createdAt: at,
      updatedAt: at,
    });
    return { projectId: id };
  }

  /** Drops a project from `t3_project_list`; its threads keep the now-unknown `projectId`. */
  removeProject(projectId: string): void {
    if (!this.projects.delete(projectId)) throw new Error(`FakeT3.removeProject: unknown project ${projectId}`);
  }

  addThread(input: {
    projectId?: string;
    title: string;
    status?: string;
    settled?: boolean;
    snoozed?: boolean;
    subagent?: boolean;
    updatedAt?: string;
    messages?: Array<{ role: "user" | "assistant"; text: string }>;
  }): { threadId: string } {
    const projectId = input.projectId ?? this.scratchProjectId;
    if (!this.projects.has(projectId)) throw new Error(`FakeT3.addThread: unknown project ${projectId}`);
    const messages = input.messages ?? [];
    const status = input.status ?? (messages.length > 0 ? "completed" : "idle");
    if (!THREAD_STATUSES.has(status as ThreadStatus)) throw new Error(`FakeT3.addThread: unknown status ${status}`);
    const at = input.updatedAt ?? nowIso();
    const thread = this.createThread({
      threadId: randomUUID(),
      projectId,
      title: input.title,
      createdBy: input.subagent ? "agent" : "user",
      creationSource: input.subagent ? "provider" : "web",
      modelSelection: { ...DEFAULT_MODEL_SELECTION },
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath: null,
      createdAt: at,
    });
    if (input.subagent) {
      thread.parentThreadId = randomUUID();
      thread.relationshipToParent = "subagent";
    }
    if (input.settled) {
      thread.settled = true;
      thread.settledAt = at;
    }
    if (input.snoozed) thread.snoozedUntil = new Date(Date.now() + 86_400_000).toISOString();

    let run: RunRecord | undefined;
    if (status !== "idle") {
      run = this.newRun(thread, status as RunStatus, null, null);
      run.requestedAt = at;
      run.startedAt = status === "queued" || status === "preparing" ? null : at;
      run.completedAt = TERMINAL_RUN_STATUSES.has(run.status) ? at : null;
    }
    for (const message of messages) {
      if (message.role === "user") {
        const messageId = randomUUID();
        this.addItem(thread, {
          itemId: `turn-item:message:${messageId}`,
          runId: run?.runId ?? null,
          messageId,
          createdBy: "user",
          creationSource: "web",
          type: "user_message",
          status: "completed",
          title: null,
          text: message.text,
        }, at);
      } else {
        this.addReasoningItem(thread, run?.runId ?? null, at);
        this.addAssistantItem(thread, run?.runId ?? null, message.text, at);
      }
    }
    thread.updatedAt = at;
    return { threadId: thread.threadId };
  }

  /** Adds a pending user question to the thread's active run (starting a running turn if there is none). */
  addQuestion(threadId: string, question: { question: string; options: string[] }): { requestId: string } {
    const thread = this.controlThread(threadId);
    const run = this.ensureActiveRun(thread);
    const record = this.makeQuestion(run, question.question, question.options);
    run.questions.push(record);
    this.touch(thread);
    return { requestId: record.requestId };
  }

  /** Adds a pending approval: counted in `pendingRequestCount`, never listed by `t3_pending_request`. */
  addApproval(threadId: string): void {
    const thread = this.controlThread(threadId);
    this.ensureActiveRun(thread).approvals += 1;
    this.touch(thread);
  }

  revokeAllSessions(): void {
    for (const session of this.sessions.values()) session.revoked = true;
  }

  expireSessions(): void {
    const past = Date.now() - 1000;
    for (const session of this.sessions.values()) session.expiresAt = Math.min(session.expiresAt, past);
  }

  /** While `true`, `/mcp` rejects every bearer token with the invalid-token 401, including freshly minted ones. */
  rejectCredentials(reject: boolean): void {
    this.rejectingCredentials = reject;
  }

  /** `false` closes the listener, so connections are refused; MCP sessions are dropped as on a real shutdown. */
  async setAvailable(available: boolean): Promise<void> {
    if (this.stopped) throw new Error("FakeT3 is stopped");
    if (available && !this.httpServer) await this.openListener();
    else if (!available && this.httpServer) await this.closeListener();
  }

  /** Restarts on the same port: MCP sessions are dropped, auth sessions are kept. */
  async restart(): Promise<void> {
    if (this.stopped) throw new Error("FakeT3 is stopped");
    await this.closeListener();
    await this.openListener();
  }

  /** The next call to `tool` is processed, then its socket is destroyed before the response is written. */
  dropNextResponse(tool: string): void {
    this.drops.set(tool, (this.drops.get(tool) ?? 0) + 1);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.notify();
    for (const thread of this.threads.values()) {
      for (const run of thread.runs) this.clearTimers(run);
    }
    await this.closeListener();
    rmSync(this.tempDir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  private readonly onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    this.route(req, res).catch((error: unknown) => {
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
      } else {
        res.destroy();
      }
    });
  };

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", this.origin).pathname;
    if (path.startsWith(this.adminPrefix)) return this.handleAdmin(path.slice(this.adminPrefix.length), req, res);
    if (path === "/mcp") return this.handleMcp(req, res);
    if (
      req.method === "GET" &&
      (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")
    ) {
      sendJson(res, 200, {
        resource: this.resource,
        authorization_servers: [this.origin],
        scopes_supported: SUPPORTED_SCOPES,
        bearer_methods_supported: ["header"],
        resource_name: "T3 Code",
      });
      return;
    }
    if (req.method === "POST" && path === "/oauth/mcp/register") return this.handleRegister(req, res);
    if (req.method === "POST" && path === "/oauth/mcp/decision") return this.handleDecision(req, res);
    if (req.method === "POST" && path === "/oauth/mcp/token") return this.handleToken(req, res);
    sendJson(res, 404, { error: "not_found", message: "Not found." });
  }

  private async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req);
    const invalid = (error: string, description: string) => sendJson(res, 400, { error, error_description: description });
    if (!isRecord(body)) return invalid("invalid_client_metadata", "Expected a JSON object.");
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((uri) => typeof uri === "string")) {
      return invalid("invalid_redirect_uri", "redirect_uris must be a non-empty array of strings.");
    }
    for (const uri of redirectUris as string[]) {
      let url: URL;
      try {
        url = new URL(uri);
      } catch {
        return invalid("invalid_redirect_uri", `Invalid redirect URI: ${uri}`);
      }
      const allowed = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
      if (!allowed) return invalid("invalid_redirect_uri", `Redirect URIs must use https, or http on a loopback host: ${uri}`);
    }
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
      return invalid("invalid_client_metadata", "Only token_endpoint_auth_method 'none' is supported.");
    }
    const client: OAuthClient = {
      clientId: randomUUID(),
      clientName: optString(body.client_name),
      redirectUris: redirectUris as string[],
    };
    this.clients.set(client.clientId, client);
    sendJson(res, 201, {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(client.clientName !== undefined ? { client_name: client.clientName } : {}),
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  }

  private async handleDecision(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req);
    const invalid = (error: string, message: string, status = 400) => sendJson(res, status, { error, message });
    if (!isRecord(body) || !isRecord(body.authorization) || !isRecord(body.decision)) {
      return invalid("invalid_request", "Expected authorization and decision objects.");
    }
    const authorization = body.authorization;
    const decision = body.decision;
    const client = this.clients.get(optString(authorization.client_id) ?? "");
    if (!client) return invalid("invalid_client", "Unknown client_id.");
    const redirectUri = optString(authorization.redirect_uri);
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return invalid("invalid_request", "redirect_uri is not registered for this client.");
    }
    if (authorization.response_type !== "code") return invalid("unsupported_response_type", "response_type must be 'code'.");
    const codeChallenge = optString(authorization.code_challenge);
    if (!codeChallenge || authorization.code_challenge_method !== "S256") {
      return invalid("invalid_request", "A S256 code_challenge is required.");
    }
    const resource = optString(authorization.resource);
    if (resource !== undefined && resource !== this.resource) return invalid("invalid_target", "Unknown resource.");
    if (decision._tag !== "pairing-code") return invalid("invalid_request", "Unsupported decision.");

    const pairing = this.pairings.get(optString(decision.code) ?? "");
    if (!pairing || pairing.consumed || pairing.expiresAt <= Date.now()) {
      return invalid("invalid_pairing_code", "The pairing code is invalid or expired.");
    }
    pairing.consumed = true;
    let scopes: string[];
    if (decision.access === "full-access") {
      if (!FULL_ACCESS_SCOPES.every((scope) => pairing.scopes.includes(scope))) {
        return invalid("insufficient_scope", "The pairing code does not grant full access.", 403);
      }
      scopes = [...FULL_ACCESS_SCOPES];
    } else {
      scopes = pairing.scopes.filter((scope) => SUPPORTED_SCOPES.includes(scope));
    }

    const code = secret();
    this.secrets.push(code);
    this.authorizationCodes.set(code, {
      clientId: client.clientId,
      redirectUri,
      codeChallenge,
      resource,
      scopes,
      label: client.clientName ?? pairing.label,
      expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS,
      used: false,
    });
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    const state = optString(authorization.state);
    if (state !== undefined) redirect.searchParams.set("state", state);
    sendJson(res, 200, { redirectTo: redirect.toString() });
  }

  private async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await readBody(req));
    const invalid = (error: string, description: string) =>
      sendJson(res, 400, { error, error_description: description }, { "cache-control": "no-store" });
    if (form.get("grant_type") !== "authorization_code") {
      return invalid("unsupported_grant_type", "Only authorization_code is supported.");
    }
    const record = this.authorizationCodes.get(form.get("code") ?? "");
    if (!record || record.used || record.expiresAt <= Date.now()) {
      return invalid("invalid_grant", "The authorization code is invalid or expired.");
    }
    record.used = true;
    if (form.get("client_id") !== record.clientId || form.get("redirect_uri") !== record.redirectUri) {
      return invalid("invalid_grant", "client_id or redirect_uri does not match the authorization.");
    }
    const verifier = form.get("code_verifier") ?? "";
    if (createHash("sha256").update(verifier).digest("base64url") !== record.codeChallenge) {
      return invalid("invalid_grant", "PKCE verification failed.");
    }
    const resource = form.get("resource");
    if ((resource ?? record.resource) !== undefined && (resource ?? record.resource) !== this.resource) {
      return invalid("invalid_target", "Unknown resource.");
    }

    // Real MCP client tokens contain a dot; T3 uses that to decide whether a 401 offers OAuth metadata.
    const token = `${secret(16)}.${secret()}`;
    this.secrets.push(token);
    const issuedAt = Date.now();
    const session: AuthSession = {
      sessionId: randomUUID(),
      token,
      clientId: record.clientId,
      label: record.label,
      scopes: record.scopes,
      userAgent: req.headers["user-agent"] ?? "node",
      issuedAt,
      expiresAt: issuedAt + this.tokenTtlSeconds * 1000,
      lastConnectedAt: null,
      revoked: false,
    };
    this.sessions.set(session.sessionId, session);
    this.sessionsByToken.set(token, session.sessionId);
    sendJson(
      res,
      200,
      { access_token: token, token_type: "Bearer", expires_in: this.tokenTtlSeconds, scope: record.scopes.join(" ") },
      { "cache-control": "no-store" },
    );
  }

  private async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    const session = match ? this.sessions.get(this.sessionsByToken.get(match[1]) ?? "") : undefined;
    if (!session || !this.isLive(session) || this.rejectingCredentials) {
      // Mirrors T3's unauthorized(): OAuth metadata is offered unless the presented token looks like a
      // provider token (non-empty without a dot); `error="invalid_token"` appears whenever one was presented.
      const presented = match?.[1] ?? "";
      const offerOAuth = !(presented.length > 0 && !presented.includes("."));
      const parts = [
        ...(offerOAuth ? [`resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp"`] : []),
        ...(presented.length > 0 ? ['error="invalid_token"'] : []),
      ];
      res.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate": ["Bearer", parts.join(", ")].filter((part) => part.length > 0).join(" "),
      });
      res.end(CREDENTIAL_ERROR_BODY);
      return;
    }
    session.lastConnectedAt = nowIso();

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
        return;
      }
    }

    const sessionHeader = req.headers["mcp-session-id"];
    const mcpSessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    if (mcpSessionId) {
      const entry = this.mcpSessions.get(mcpSessionId);
      if (!entry) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.method === "GET") {
        res.writeHead(405, { allow: "POST, DELETE" });
        res.end();
        return;
      }
      entry.authSessionId = session.sessionId;
      const keys = this.trackToolCallSockets(mcpSessionId, body, req.socket);
      res.once("close", () => {
        for (const key of keys) this.requestSockets.delete(key);
      });
      await entry.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "POST" && (Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body))) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSessionId) => {
          this.mcpSessions.set(newSessionId, entry);
        },
      });
      const server = this.createMcpServer();
      const entry: McpSessionEntry = { transport, server, authSessionId: session.sessionId };
      transport.onclose = () => {
        if (transport.sessionId) this.mcpSessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405, { allow: "POST, DELETE" });
      res.end();
      return;
    }
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" },
      id: null,
    });
  }

  private trackToolCallSockets(mcpSessionId: string, body: unknown, socket: Socket): string[] {
    const keys: string[] = [];
    for (const message of Array.isArray(body) ? body : [body]) {
      if (isRecord(message) && message.method === "tools/call" && (typeof message.id === "string" || typeof message.id === "number")) {
        const key = `${mcpSessionId}:${String(message.id)}`;
        this.requestSockets.set(key, socket);
        keys.push(key);
      }
    }
    return keys;
  }

  private async handleAdmin(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Close admin connections so the CLI process exits without waiting on keep-alive sockets.
    const reply = (status: number, body: unknown) => sendJson(res, status, body, { connection: "close" });
    if (req.method === "POST" && path === "cli/invocation") {
      const body = await this.readJson(req);
      if (isRecord(body) && Array.isArray(body.args) && Array.isArray(body.envNames)) {
        this.cliInvocations.push({ args: body.args.map(String), envNames: body.envNames.map(String) });
      }
      return reply(200, {});
    }
    if (req.method === "POST" && path === "cli/pairing") {
      const body = await this.readJson(req);
      if (!isRecord(body)) return reply(400, { error: "invalid_request" });
      const ttlMs = optInt(body.ttlMs) ?? 5 * 60_000;
      const scopes = Array.isArray(body.scopes) ? body.scopes.map(String) : [...SUPPORTED_SCOPES];
      const pairing: PairingRecord = {
        id: randomUUID(),
        credential: secret(18),
        label: optString(body.label) ?? "",
        scopes,
        // T3 reports pairing expiry with whole seconds.
        expiresAt: Math.floor((Date.now() + ttlMs) / 1000) * 1000,
        consumed: false,
      };
      this.secrets.push(pairing.credential);
      this.pairings.set(pairing.credential, pairing);
      return reply(200, {
        id: pairing.id,
        credential: pairing.credential,
        label: pairing.label,
        scopes: pairing.scopes,
        expiresAt: new Date(pairing.expiresAt).toISOString(),
      });
    }
    if (req.method === "GET" && path === "cli/sessions") {
      const connected = new Set([...this.mcpSessions.values()].map((entry) => entry.authSessionId));
      return reply(
        200,
        [...this.sessions.values()]
          .filter((session) => this.isLive(session))
          .map((session) => ({
            sessionId: session.sessionId,
            method: "bearer-access-token",
            scopes: session.scopes,
            subject: "mcp-client",
            client: { label: session.label, ipAddress: "127.0.0.1", userAgent: session.userAgent, deviceType: "bot" },
            connected: connected.has(session.sessionId),
            issuedAt: new Date(session.issuedAt).toISOString(),
            expiresAt: new Date(session.expiresAt).toISOString(),
            lastConnectedAt: session.lastConnectedAt,
          })),
      );
    }
    if (req.method === "POST" && path === "cli/sessions/revoke") {
      const body = await this.readJson(req);
      const session = isRecord(body) ? this.sessions.get(optString(body.sessionId) ?? "") : undefined;
      if (!session || session.revoked) return reply(404, { error: "not_found" });
      session.revoked = true;
      return reply(200, { sessionId: session.sessionId });
    }
    reply(404, { error: "not_found" });
  }

  private async readJson(req: IncomingMessage): Promise<unknown> {
    try {
      return JSON.parse(await readBody(req));
    } catch {
      return undefined;
    }
  }

  private isLive(session: AuthSession): boolean {
    return !session.revoked && session.expiresAt > Date.now();
  }

  private async openListener(): Promise<void> {
    const server = createServer(this.onRequest);
    await listen(server, this.port);
    this.httpServer = server;
  }

  private async closeListener(): Promise<void> {
    const server = this.httpServer;
    if (!server) return;
    this.httpServer = undefined;
    const entries = [...this.mcpSessions.values()];
    this.mcpSessions.clear();
    await Promise.all(entries.map((entry) => entry.server.close().catch(() => undefined)));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    // Clients usually share this event loop; let them observe the closed keep-alive sockets
    // before the next request, as they would across a real T3 shutdown, instead of reusing one
    // and failing with ECONNRESET.
    await new Promise<void>((resolve) => setTimeout(resolve, CLOSE_SETTLE_MS));
  }

  // ---------------------------------------------------------------------------
  // MCP
  // ---------------------------------------------------------------------------

  private createMcpServer(): Server {
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.toolsList as unknown as Tool[] }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name;
      const args: JsonObject = isRecord(request.params.arguments) ? request.params.arguments : {};
      const entry = extra.sessionId ? this.mcpSessions.get(extra.sessionId) : undefined;
      const session = entry ? this.sessions.get(entry.authSessionId) : undefined;
      this.calls.push({ tool: name, args: structuredClone(args), label: session?.label ?? "" });

      const tool = this.toolsByName.get(name);
      if (!tool) throw rpcError(ErrorCode.InvalidParams, `Tool ${name} not found`);
      const problem = validateArguments(tool, args);
      if (problem) throw rpcError(ErrorCode.InvalidParams, `Invalid parameters for tool '${name}': ${problem}`);

      let result: CallToolResult;
      try {
        result = ok(await this.callTool(name, args, { clientId: session?.clientId ?? "unknown", signal: extra.signal }));
      } catch (error) {
        if (!(error instanceof ToolFailure)) throw error;
        result = failure(error.code, error.message);
      }

      const pendingDrops = this.drops.get(name) ?? 0;
      const socket = this.requestSockets.get(`${extra.sessionId}:${String(extra.requestId)}`);
      if (pendingDrops > 0 && socket) {
        this.drops.set(name, pendingDrops - 1);
        socket.destroy();
      }
      return result;
    });
    return server;
  }

  private async callTool(name: string, args: JsonObject, context: CallContext): Promise<JsonObject> {
    switch (name) {
      case "t3_project_list":
        return this.projectList(args);
      case "t3_thread_search":
        return this.threadSearch(args);
      case "t3_thread_list":
        return this.threadList(args);
      case "t3_thread_read":
        return this.threadRead(args);
      case "t3_thread_wait":
        return this.threadWait(args, context);
      case "t3_thread_launch":
        return this.threadLaunch(args, context);
      case "t3_thread_send":
        return this.threadSend(args, context);
      case "t3_thread_interrupt":
        return this.threadInterrupt(args, context);
      case "t3_pending_request":
        return this.pendingRequest(args);
      case "t3_thread_organize":
        return this.threadOrganize(args);
      case "t3_queue":
        return this.queue(args);
      case "task_status":
        throw new ToolFailure(
          "thread_credential_required",
          "This tool acts as the calling T3 thread, so it needs an agent running inside T3 Code. This MCP client signed in from outside a thread.",
        );
      default:
        throw new ToolFailure("not_implemented", `${name} is not implemented in fake T3.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  private projectList(args: JsonObject): JsonObject {
    const projects = [...this.projects.values()];
    const cursor = optInt(args.cursor) ?? 0;
    const limit = clamp(optInt(args.limit) ?? 50, 1, 100);
    return {
      projects: projects.slice(cursor, cursor + limit).map((project) => ({
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        repositoryIdentity: null,
        faviconPath: null,
        projectIcon: project.projectIcon,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        scripts: [],
        pinnedAt: null,
        archivedAt: null,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        deletedAt: null,
      })),
      nextCursor: cursor + limit < projects.length ? cursor + limit : null,
    };
  }

  private threadList(args: JsonObject): JsonObject {
    const projectId = optString(args.projectId);
    if (projectId === undefined && args.allProjects !== true) {
      throw new ToolFailure("target_required", `Pass projectId: ${NOT_IN_THREAD}`);
    }
    const statuses = Array.isArray(args.statuses) ? new Set(args.statuses) : undefined;
    const titleContains = optString(args.titleContains)?.toLowerCase();
    const rows = [...this.threads.values()]
      .filter((thread) => !thread.archived)
      .filter((thread) => projectId === undefined || thread.projectId === projectId)
      .filter((thread) => args.includeSubagents !== false || thread.relationshipToParent !== "subagent")
      .filter((thread) => typeof args.settled !== "boolean" || thread.settled === args.settled)
      .filter((thread) => typeof args.snoozed !== "boolean" || this.isSnoozed(thread) === args.snoozed)
      .filter((thread) => !statuses || statuses.has(threadStatus(thread)))
      .filter((thread) => titleContains === undefined || thread.title.toLowerCase().includes(titleContains))
      .sort(byUpdatedDesc);
    const cursor = optInt(args.cursor) ?? 0;
    const limit = clamp(optInt(args.limit) ?? 50, 1, 100);
    return {
      projectId: projectId ?? null,
      currentThreadId: null,
      threads: rows.slice(cursor, cursor + limit).map((thread) => this.threadRow(thread)),
      nextCursor: cursor + limit < rows.length ? cursor + limit : null,
      total: rows.length,
    };
  }

  private threadSearch(args: JsonObject): JsonObject {
    const query = String(args.query).trim().toLowerCase();
    const limit = clamp(optInt(args.limit) ?? 50, 1, 50);
    const projectId = optString(args.projectId);
    if (!query) return { matches: [] };
    const candidates = [...this.threads.values()]
      .filter((thread) => !thread.archived && thread.relationshipToParent !== "subagent")
      .filter((thread) => projectId === undefined || thread.projectId === projectId)
      .sort(byUpdatedDesc);
    const titleMatches = candidates
      .filter((thread) => thread.title.toLowerCase().includes(query))
      .map((thread) => ({
        threadId: thread.threadId,
        projectId: thread.projectId,
        title: thread.title,
        link: this.link(thread.threadId),
        source: "title",
      }));
    const titled = new Set(titleMatches.map((match) => match.threadId));
    const messageMatches: Array<JsonObject & { messageCreatedAt: string }> = [];
    for (const thread of candidates) {
      if (titled.has(thread.threadId)) continue;
      const item = [...thread.items]
        .reverse()
        .find(
          (candidate) =>
            (candidate.type === "user_message" || candidate.type === "assistant_message") &&
            candidate.text.toLowerCase().includes(query),
        );
      if (!item) continue;
      const start = Math.max(0, item.text.toLowerCase().indexOf(query) - 80);
      messageMatches.push({
        threadId: thread.threadId,
        projectId: thread.projectId,
        title: thread.title,
        link: this.link(thread.threadId),
        source: item.type === "user_message" ? "user" : "assistant",
        snippet: item.text.slice(start, start + 240),
        messageCreatedAt: item.updatedAt,
      });
    }
    messageMatches.sort((a, b) => (a.messageCreatedAt < b.messageCreatedAt ? 1 : a.messageCreatedAt > b.messageCreatedAt ? -1 : 0));
    return { matches: [...titleMatches, ...messageMatches].slice(0, limit) };
  }

  private threadRead(args: JsonObject): JsonObject {
    const thread = this.requireThread(args.threadId);
    const view = args.view === "activity" ? "activity" : "messages";
    const limit = clamp(optInt(args.limit) ?? 20, 1, 100);
    const runLimit = clamp(optInt(args.runLimit) ?? 5, 1, 50);
    const maxChars = clamp(optInt(args.maxCharsPerItem) ?? 4000, 1, 50_000);
    const visible = thread.items.filter(
      (item) => view === "activity" || item.type === "user_message" || item.type === "assistant_message",
    );
    const itemId = optString(args.itemId);
    let page: Array<{ item: ItemRecord; offset: number }>;
    let hasMore: boolean;
    if (itemId !== undefined) {
      const item = thread.items.find((candidate) => candidate.itemId === itemId);
      if (!item) throw new ToolFailure("not_found", `Item ${itemId} was not found in thread ${thread.threadId}.`);
      page = [{ item, offset: optInt(args.textOffset) ?? 0 }];
      hasMore = visible.some((candidate) => candidate.position > item.position);
    } else {
      const afterPosition = optInt(args.afterPosition);
      const remaining = visible.filter((item) => afterPosition === undefined || item.position > afterPosition);
      page = remaining.slice(0, limit).map((item) => ({ item, offset: 0 }));
      hasMore = remaining.length > page.length;
    }
    const last = page.at(-1)?.item.position;
    return {
      thread: this.threadDetail(thread),
      recentRuns: [...thread.runs]
        .reverse()
        .slice(0, runLimit)
        .map((run) => ({
          runId: run.runId,
          ordinal: run.ordinal,
          status: run.status,
          providerInstanceId: run.providerInstanceId,
          model: run.model,
          requestedAt: run.requestedAt,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
        })),
      items: page.map(({ item, offset }) => this.renderItem(thread, item, offset, maxChars)),
      nextPosition: last ?? optInt(args.afterPosition) ?? null,
      hasMore,
    };
  }

  private async threadWait(args: JsonObject, context: CallContext): Promise<JsonObject> {
    const thread = this.requireThread(args.threadId);
    const runId = optString(args.runId);
    const run = runId !== undefined ? thread.runs.find((candidate) => candidate.runId === runId) : latestRun(thread);
    if (runId !== undefined && !run) throw new ToolFailure("not_found", `Run ${runId} was not found.`);
    if (!run) return { threadId: thread.threadId, runId: null, status: "idle", timedOut: false };
    const timeoutMs = clamp(typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000, 0, 600_000);
    const timedOut = await this.waitForRun(run, timeoutMs, context.signal);
    return { threadId: thread.threadId, runId: run.runId, status: run.status, timedOut };
  }

  private threadLaunch(args: JsonObject, context: CallContext): JsonObject {
    const scratch = args.scratch === true;
    const projectId = optString(args.projectId);
    if (scratch && (projectId !== undefined || args.workspaceStrategy !== undefined)) {
      throw new ToolFailure("invalid_request", "`scratch` cannot be combined with `projectId` or `workspaceStrategy`.");
    }
    if (!scratch && projectId === undefined) {
      throw new ToolFailure("target_required", `Pass projectId or scratch: ${NOT_IN_THREAD}`);
    }
    const clientRequestId = optString(args.clientRequestId);
    const key = clientRequestId !== undefined ? `${context.clientId}:launch:${clientRequestId}` : undefined;
    const previous = key !== undefined ? this.idempotent.get(key) : undefined;
    if (previous) return this.launchResult(this.threads.get(String(previous.threadId)));

    const project = this.projects.get(scratch ? this.scratchProjectId : (projectId ?? ""));
    if (!project) throw new ToolFailure("not_found", `Project ${projectId} was not found.`);
    const threadId =
      clientRequestId !== undefined
        ? `mcp:launch:${sha256Hex(`client:${context.clientId}:${clientRequestId}`)}`
        : `mcp:${randomUUID()}`;
    const message = optString(args.message);
    const thread = this.createThread({
      threadId,
      projectId: project.id,
      title: String(args.title),
      createdBy: "agent",
      creationSource: "mcp",
      modelSelection: isRecord(args.modelSelection) ? { ...args.modelSelection } : { ...DEFAULT_MODEL_SELECTION },
      runtimeMode: optString(args.runtimeMode) ?? "full-access",
      interactionMode: optString(args.interactionMode) ?? "default",
      worktreePath: scratch
        ? join(project.workspaceRoot, `${nowIso().slice(0, 10)}-${slug(message ?? String(args.title))}-${sha256Hex(threadId).slice(-8)}`)
        : null,
      createdAt: nowIso(),
    });
    if (message) {
      const run = this.newRun(thread, "preparing", message, threadId);
      this.beginRun(thread, run, "launch");
    }
    if (key !== undefined) this.idempotent.set(key, { threadId });
    return this.launchResult(thread);
  }

  private launchResult(thread: ThreadRecord | undefined): JsonObject {
    if (!thread) throw new ToolFailure("not_found", "Thread was not found.");
    const run = thread.runs[0];
    return {
      threadId: thread.threadId,
      link: this.link(thread.threadId),
      projectId: thread.projectId,
      modelSelection: thread.modelSelection,
      runId: run?.runId ?? null,
      status: run?.status ?? null,
    };
  }

  private threadSend(args: JsonObject, context: CallContext): JsonObject {
    const thread = this.requireThread(args.threadId);
    const message = String(args.message);
    const clientRequestId = optString(args.clientRequestId);
    const key = clientRequestId !== undefined ? `${context.clientId}:send:${thread.threadId}:${clientRequestId}` : undefined;
    const previous = key !== undefined ? this.idempotent.get(key) : undefined;
    if (previous) {
      const run = thread.runs.find((candidate) => candidate.runId === previous.runId);
      return { ...previous, status: run?.status ?? previous.status };
    }

    const messageId = `message:mcp:${encodeURIComponent(`client:${context.clientId}`)}:thread-send:${clientRequestId ?? randomUUID()}`;
    const mode = optString(args.mode) ?? "auto";
    const active = activeRun(thread);
    let run: RunRecord;
    let delivery: "started" | "queued" | "steered" | "restarted";
    if (mode === "steer" || (mode === "auto" && active && STEERABLE_RUN_STATUSES.has(active.status))) {
      if (!active || !STEERABLE_RUN_STATUSES.has(active.status)) {
        throw new ToolFailure("thread_not_sendable", `Thread ${thread.threadId} has no running turn that can be steered.`);
      }
      this.addUserItem(thread, active.runId, messageId, message);
      this.touch(thread);
      run = active;
      delivery = "steered";
    } else if ((mode === "queue" || mode === "auto") && active) {
      run = this.newRun(thread, "queued", message, messageId);
      thread.queue.push(run.runId);
      this.touch(thread);
      delivery = "queued";
    } else {
      if (mode === "restart" && active) this.finishRun(thread, active, "cancelled", false);
      run = this.newRun(thread, "starting", message, messageId);
      this.beginRun(thread, run, "send");
      delivery = mode === "restart" && active ? "restarted" : "started";
    }
    const result = {
      threadId: thread.threadId,
      link: this.link(thread.threadId),
      messageId,
      runId: run.runId,
      status: run.status,
      delivery,
    };
    if (key !== undefined) this.idempotent.set(key, result);
    return result;
  }

  private threadInterrupt(args: JsonObject, context: CallContext): JsonObject {
    const thread = this.requireThread(args.threadId);
    const clientRequestId = optString(args.clientRequestId);
    const key =
      clientRequestId !== undefined ? `${context.clientId}:interrupt:${thread.threadId}:${clientRequestId}` : undefined;
    const previous = key !== undefined ? this.idempotent.get(key) : undefined;
    if (previous) return previous;

    if (args.stop === true) {
      for (const queuedRunId of [...thread.queue]) this.removeQueued(thread, queuedRunId);
    }
    const runId = optString(args.runId);
    const run = runId !== undefined ? thread.runs.find((candidate) => candidate.runId === runId) : activeRun(thread);
    if (runId !== undefined && !run) throw new ToolFailure("not_found", `Run ${runId} was not found.`);
    let result: JsonObject;
    if (!run) {
      result = { threadId: thread.threadId, runId: null, status: "no_active_run" };
    } else if (TERMINAL_RUN_STATUSES.has(run.status)) {
      result = { threadId: thread.threadId, runId: run.runId, status: run.status };
    } else if (thread.queue.includes(run.runId)) {
      this.removeQueued(thread, run.runId);
      result = { threadId: thread.threadId, runId: run.runId, status: "interrupt_requested" };
    } else {
      if (!run.interruptRequested) {
        run.interruptRequested = true;
        this.clearTimers(run);
        this.after(run, Math.max(STEP_MS, this.completionDelayMs), () => this.finishRun(thread, run, "cancelled"));
      }
      result = { threadId: thread.threadId, runId: run.runId, status: "interrupt_requested" };
    }
    if (result.status === "interrupt_requested") this.touch(thread);
    if (key !== undefined) this.idempotent.set(key, result);
    return result;
  }

  private pendingRequest(args: JsonObject): JsonObject {
    const thread = this.requireTargetThread(args.threadId);
    const questions = thread.runs.flatMap((run) => run.questions.map((question) => ({ run, question })));
    if (args.action === "list") return { requestIds: questions.map(({ question }) => question.requestId) };

    const requestId = optString(args.requestId);
    if (requestId === undefined) throw new ToolFailure("invalid_request", "Pass requestId.");
    const found = questions.find(({ question }) => question.requestId === requestId);
    if (!found) throw new ToolFailure("not_found", `Pending request ${requestId} was not found.`);
    const { run, question } = found;
    if (args.action === "read") {
      return {
        requestId: question.requestId,
        questions: [
          {
            id: question.id,
            header: question.header,
            question: question.question,
            options: question.options.map((label) => ({ label, description: `Pick ${label}` })),
            multiSelect: false,
          },
        ],
      };
    }

    const answers = args.answers;
    if (!isRecord(answers)) throw new ToolFailure("invalid_request", "Pass answers keyed by question id.");
    const answer = answers[question.id];
    const text =
      typeof answer === "string"
        ? answer
        : Array.isArray(answer) && answer.every((value) => typeof value === "string")
          ? answer.join(", ")
          : undefined;
    if (text === undefined) throw new ToolFailure("invalid_request", `Missing an answer for question ${JSON.stringify(question.id)}.`);
    run.questions = run.questions.filter((candidate) => candidate !== question);
    if (run.questions.length === 0 && (run.script.kind === "ask" || run.script.kind === "static")) {
      this.after(run, this.completionDelayMs, () => this.completeWithReply(thread, run, text));
    }
    this.touch(thread);
    return { sequence: this.nextSequence() };
  }

  private threadOrganize(args: JsonObject): JsonObject {
    const thread = this.requireTargetThread(args.threadId);
    const at = nowIso();
    switch (args.action) {
      case "pin":
        thread.pinnedAt = at;
        break;
      case "unpin":
        thread.pinnedAt = null;
        break;
      case "snooze": {
        const until = optString(args.snoozedUntil);
        if (until === undefined || Number.isNaN(Date.parse(until))) {
          throw new ToolFailure("invalid_request", "`snooze` needs an ISO-8601 `snoozedUntil`.");
        }
        thread.snoozedUntil = new Date(until).toISOString();
        break;
      }
      case "unsnooze":
        thread.snoozedUntil = null;
        break;
      case "settle":
        thread.settled = true;
        thread.settledAt = at;
        break;
      case "unsettle":
        thread.settled = false;
        thread.settledAt = null;
        break;
      case "archive":
        thread.archived = true;
        if (!thread.settled) {
          thread.settled = true;
          thread.settledAt = at;
        }
        break;
      case "unarchive":
        thread.archived = false;
        break;
      case "mark_unread":
        thread.unread = true;
        break;
    }
    this.touch(thread);
    return { sequence: this.nextSequence() };
  }

  private queue(args: JsonObject): JsonObject {
    const thread = this.requireTargetThread(args.threadId);
    const queued = thread.queue
      .map((runId) => thread.runs.find((run) => run.runId === runId))
      .filter((run): run is RunRecord => run !== undefined);
    const view = (run: RunRecord, maxChars: number) => ({
      queuedRunId: run.runId,
      text: (run.message ?? "").slice(0, maxChars),
      truncated: (run.message ?? "").length > maxChars,
    });
    if (args.action === "list") {
      const cursor = optInt(args.cursor) ?? 0;
      const limit = clamp(optInt(args.limit) ?? 50, 1, 100);
      return {
        items: queued.slice(cursor, cursor + limit).map((run) => view(run, 1000)),
        nextCursor: cursor + limit < queued.length ? cursor + limit : null,
      };
    }

    const queuedRunId = optString(args.queuedRunId);
    if (queuedRunId === undefined) throw new ToolFailure("invalid_request", "Pass queuedRunId.");
    const run = queued.find((candidate) => candidate.runId === queuedRunId);
    if (!run) throw new ToolFailure("not_found", `Run ${queuedRunId} is not queued.`);
    switch (args.action) {
      case "read":
        return view(run, 16_000);
      case "edit": {
        const text = optString(args.text);
        if (text === undefined) throw new ToolFailure("invalid_request", "Pass text.");
        run.message = text;
        run.script = scriptFor(text, this.sleepScaleMs);
        break;
      }
      case "cancel":
        this.removeQueued(thread, run.runId);
        break;
      case "reorder": {
        const before = optString(args.beforeRunId);
        thread.queue = thread.queue.filter((runId) => runId !== run.runId);
        const index = before === undefined ? -1 : thread.queue.indexOf(before);
        if (index < 0) thread.queue.push(run.runId);
        else thread.queue.splice(index, 0, run.runId);
        break;
      }
      case "promote_to_steer": {
        const active = activeRun(thread);
        const target = optString(args.targetRunId);
        if (!active || !STEERABLE_RUN_STATUSES.has(active.status) || (target !== undefined && target !== active.runId)) {
          throw new ToolFailure("thread_not_sendable", `Thread ${thread.threadId} has no running turn that can be steered.`);
        }
        this.removeQueued(thread, run.runId);
        this.addUserItem(thread, active.runId, run.messageId ?? randomUUID(), run.message ?? "");
        break;
      }
    }
    this.touch(thread);
    return { sequence: this.nextSequence() };
  }

  // ---------------------------------------------------------------------------
  // Thread model
  // ---------------------------------------------------------------------------

  private createThread(input: {
    threadId: string;
    projectId: string;
    title: string;
    createdBy: CreatedBy;
    creationSource: CreationSource;
    modelSelection: JsonObject;
    runtimeMode: string;
    interactionMode: string;
    worktreePath: string | null;
    createdAt: string;
  }): ThreadRecord {
    const selection = input.modelSelection;
    const thread: ThreadRecord = {
      threadId: input.threadId,
      projectId: input.projectId,
      title: input.title,
      createdBy: input.createdBy,
      creationSource: input.creationSource,
      modelSelection: selection,
      providerInstanceId: String(selection.instanceId ?? selection.provider ?? DEFAULT_MODEL_SELECTION.instanceId),
      model: String(selection.model ?? DEFAULT_MODEL_SELECTION.model),
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      branch: null,
      worktreePath: input.worktreePath,
      parentThreadId: null,
      relationshipToParent: null,
      archived: false,
      settled: false,
      settledAt: null,
      snoozedUntil: null,
      pinnedAt: null,
      unread: false,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      touched: ++this.touchCounter,
      runs: [],
      queue: [],
      items: [],
      nextOrdinal: 1,
    };
    this.threads.set(thread.threadId, thread);
    return thread;
  }

  private newRun(thread: ThreadRecord, status: RunStatus, message: string | null, messageId: string | null): RunRecord {
    const ordinal = thread.nextOrdinal++;
    const run: RunRecord = {
      runId: `run:thread:${encodeURIComponent(thread.threadId)}:ordinal:${ordinal}`,
      ordinal,
      status,
      providerInstanceId: thread.providerInstanceId,
      model: thread.model,
      requestedAt: nowIso(),
      startedAt: null,
      completedAt: null,
      message,
      messageId,
      script: message === null ? { kind: "static" } : scriptFor(message, this.sleepScaleMs),
      questions: [],
      approvals: 0,
      interruptRequested: false,
      commandItem: null,
      timers: new Set(),
    };
    thread.runs.push(run);
    return run;
  }

  /** Starts a run created as `preparing` (launch) or `starting` (send or dequeue). */
  private beginRun(thread: ThreadRecord, run: RunRecord, phase: "launch" | "send"): void {
    thread.settled = false;
    thread.settledAt = null;
    if (run.message !== null) {
      const messageId = run.messageId ?? randomUUID();
      this.addUserItem(thread, run.runId, messageId, run.message, phase === "launch" ? thread.threadId : undefined);
    }
    this.touch(thread);
    this.notify();
    if (phase === "launch") {
      this.after(run, STEP_MS, () => {
        run.status = "starting";
        this.addItem(thread, {
          itemId: `turn-item:provider:${run.providerInstanceId}:native-item:${encodeURIComponent(`workspace-preparation:${run.runId}`)}`,
          runId: run.runId,
          messageId: null,
          createdBy: null,
          creationSource: null,
          type: "command_execution",
          status: "completed",
          title: "Workspace ready",
          text: "$ Preparing workspace\nWorkspace preparation completed.",
        });
        this.touch(thread);
        this.notify();
      });
      this.after(run, 2 * STEP_MS, () => this.runScript(thread, run));
    } else {
      this.after(run, STEP_MS, () => this.runScript(thread, run));
    }
  }

  private runScript(thread: ThreadRecord, run: RunRecord): void {
    run.status = "running";
    run.startedAt = nowIso();
    this.addReasoningItem(thread, run.runId);
    this.touch(thread);
    this.notify();
    const script = run.script;
    switch (script.kind) {
      case "reply":
        this.after(run, this.completionDelayMs, () => this.completeWithReply(thread, run, script.word));
        break;
      case "sleep":
        run.commandItem = this.addItem(thread, {
          itemId: `turn-item:provider:${run.providerInstanceId}:native-item:${randomUUID()}`,
          runId: run.runId,
          messageId: null,
          createdBy: null,
          creationSource: null,
          type: "command_execution",
          status: "running",
          title: "Run command",
          text: `$ ${script.command}`,
        });
        this.after(run, script.durationMs, () => {
          if (run.commandItem) {
            run.commandItem.status = "completed";
            run.commandItem.updatedAt = nowIso();
          }
          this.completeWithReply(thread, run, script.word);
        });
        break;
      case "ask":
        run.questions.push(this.makeQuestion(run, script.question, script.options));
        break;
      case "static":
        break;
    }
  }

  private completeWithReply(thread: ThreadRecord, run: RunRecord, text: string): void {
    if (!isActive(run)) return;
    this.addAssistantItem(thread, run.runId, text);
    this.finishRun(thread, run, "completed");
  }

  private finishRun(thread: ThreadRecord, run: RunRecord, status: RunStatus, dispatch = true): void {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return;
    this.clearTimers(run);
    run.status = status;
    run.completedAt = nowIso();
    run.questions = [];
    run.approvals = 0;
    if (run.commandItem?.status === "running") {
      run.commandItem.status = status === "completed" ? "completed" : "interrupted";
      run.commandItem.updatedAt = run.completedAt;
    }
    this.touch(thread);
    this.notify();
    if (dispatch) this.dispatchQueue(thread);
  }

  private dispatchQueue(thread: ThreadRecord): void {
    if (activeRun(thread)) return;
    const runId = thread.queue.shift();
    const run = runId === undefined ? undefined : thread.runs.find((candidate) => candidate.runId === runId);
    if (!run) return;
    run.status = "starting";
    this.beginRun(thread, run, "send");
  }

  /** Drops a queued run; it never ran, so it leaves the thread's run list. */
  private removeQueued(thread: ThreadRecord, runId: string): void {
    const run = thread.runs.find((candidate) => candidate.runId === runId);
    if (run) run.status = "cancelled";
    thread.queue = thread.queue.filter((candidate) => candidate !== runId);
    thread.runs = thread.runs.filter((candidate) => candidate.runId !== runId);
    this.notify();
  }

  private ensureActiveRun(thread: ThreadRecord): RunRecord {
    const existing = activeRun(thread);
    if (existing) return existing;
    const run = this.newRun(thread, "running", null, null);
    run.startedAt = run.requestedAt;
    thread.settled = false;
    thread.settledAt = null;
    this.notify();
    return run;
  }

  private makeQuestion(run: RunRecord, question: string, options: string[]): QuestionRecord {
    const turn = `provider-turn:provider:${run.providerInstanceId}:native-turn:${encodeURIComponent(`turn:run-attempt:${run.runId}:attempt:1`)}`;
    return {
      requestId: `runtime-request:provider:${run.providerInstanceId}:provider-turn:${encodeURIComponent(turn)}:native-request:toolu_${randomBytes(12).toString("hex")}:${randomUUID()}`,
      id: question,
      header: "Question",
      question,
      options: [...options],
    };
  }

  private addItem(
    thread: ThreadRecord,
    item: Omit<ItemRecord, "position" | "updatedAt">,
    updatedAt: string = nowIso(),
  ): ItemRecord {
    const record: ItemRecord = { ...item, position: thread.items.length, updatedAt };
    thread.items.push(record);
    return record;
  }

  private addUserItem(thread: ThreadRecord, runId: string, messageId: string, text: string, itemKey?: string): void {
    this.addItem(thread, {
      itemId: `turn-item:message:${encodeURIComponent(itemKey ?? messageId)}`,
      runId,
      messageId,
      createdBy: "agent",
      creationSource: "mcp",
      type: "user_message",
      status: "completed",
      title: null,
      text,
    });
  }

  private addReasoningItem(thread: ThreadRecord, runId: string | null, at?: string): void {
    const instance = thread.providerInstanceId;
    this.addItem(
      thread,
      {
        itemId: `turn-item:provider:${instance}:native-item:msg_${randomBytes(12).toString("hex")}%3Athinking%3A0`,
        runId,
        messageId: null,
        createdBy: null,
        creationSource: null,
        type: "reasoning",
        status: "completed",
        title: "Thinking",
        text: "Working out the reply.",
      },
      at,
    );
  }

  private addAssistantItem(thread: ThreadRecord, runId: string | null, text: string, at?: string): void {
    const native = `${thread.providerInstanceId}:native-item:${randomUUID()}`;
    this.addItem(
      thread,
      {
        itemId: `turn-item:provider:${native}`,
        runId,
        messageId: `message:provider:${native}`,
        createdBy: "agent",
        creationSource: "provider",
        type: "assistant_message",
        status: "completed",
        title: null,
        text,
      },
      at,
    );
  }

  private renderItem(thread: ThreadRecord, item: ItemRecord, offset: number, maxChars: number): JsonObject {
    const end = offset + maxChars;
    const truncated = end < item.text.length;
    return {
      position: item.position,
      visibility: "local",
      sourceThreadId: thread.threadId,
      itemId: item.itemId,
      runId: item.runId,
      messageId: item.messageId,
      createdBy: item.createdBy,
      creationSource: item.creationSource,
      type: item.type,
      status: item.status,
      title: item.title,
      text: item.text.slice(offset, end),
      textTruncated: truncated,
      nextTextOffset: truncated ? end : null,
      updatedAt: item.updatedAt,
    };
  }

  private threadRow(thread: ThreadRecord): JsonObject {
    return {
      threadId: thread.threadId,
      projectId: thread.projectId,
      title: thread.title,
      link: this.link(thread.threadId),
      createdBy: thread.createdBy,
      creationSource: thread.creationSource,
      status: threadStatus(thread),
      latestRunId: latestRun(thread)?.runId ?? null,
      providerInstanceId: thread.providerInstanceId,
      model: thread.model,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      linkedPullRequest: null,
      pullRequests: [],
      settled: thread.settled,
      settledAt: thread.settledAt,
      snoozed: this.isSnoozed(thread),
      snoozedUntil: this.isSnoozed(thread) ? thread.snoozedUntil : null,
      parentThreadId: thread.parentThreadId,
      relationshipToParent: thread.relationshipToParent,
      itemCount: thread.items.length,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  }

  private threadDetail(thread: ThreadRecord): JsonObject {
    return {
      threadId: thread.threadId,
      projectId: thread.projectId,
      title: thread.title,
      link: this.link(thread.threadId),
      createdBy: thread.createdBy,
      creationSource: thread.creationSource,
      status: threadStatus(thread),
      latestRunId: latestRun(thread)?.runId ?? null,
      activeRunId: activeRun(thread)?.runId ?? null,
      providerInstanceId: thread.providerInstanceId,
      model: thread.model,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      linkedPullRequest: null,
      pullRequests: [],
      titleRegeneration: null,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      parentThreadId: thread.parentThreadId,
      relationshipToParent: thread.relationshipToParent,
      runCount: thread.runs.length,
      itemCount: thread.items.length,
      pendingRequestCount: pendingRequestCount(thread),
      archived: thread.archived,
      settled: thread.settled,
      settledAt: thread.settledAt,
      snoozed: this.isSnoozed(thread),
      snoozedUntil: this.isSnoozed(thread) ? thread.snoozedUntil : null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  }

  private isSnoozed(thread: ThreadRecord): boolean {
    return thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > Date.now();
  }

  private link(threadId: string): string {
    return `https://app.t3.codes/threads/${this.environmentId}/${encodeURIComponent(threadId)}`;
  }

  private requireThread(threadId: unknown): ThreadRecord {
    const thread = this.threads.get(String(threadId));
    if (!thread) throw new ToolFailure("not_found", `Thread ${String(threadId)} was not found.`);
    return thread;
  }

  /** Tools whose `threadId` is optional inside T3 refuse outside callers without it. */
  private requireTargetThread(threadId: unknown): ThreadRecord {
    if (typeof threadId !== "string") throw new ToolFailure("target_required", `Pass threadId: ${NOT_IN_THREAD}`);
    return this.requireThread(threadId);
  }

  private controlThread(threadId: string): ThreadRecord {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`FakeT3: unknown thread ${threadId}`);
    return thread;
  }

  private touch(thread: ThreadRecord): void {
    thread.updatedAt = nowIso();
    thread.touched = ++this.touchCounter;
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private after(run: RunRecord, ms: number, action: () => void): void {
    const timer = setTimeout(() => {
      run.timers.delete(timer);
      if (!this.stopped) action();
    }, ms);
    timer.unref();
    run.timers.add(timer);
  }

  private clearTimers(run: RunRecord): void {
    for (const timer of run.timers) clearTimeout(timer);
    run.timers.clear();
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  /** Resolves `true` on timeout (or stop/abort), `false` once the run is terminal. */
  private waitForRun(run: RunRecord, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (timedOut: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        signal.removeEventListener("abort", onAbort);
        resolve(timedOut);
      };
      const check = () => {
        if (TERMINAL_RUN_STATUSES.has(run.status)) finish(false);
        else if (this.stopped) finish(true);
      };
      const onAbort = () => finish(true);
      const timer = setTimeout(() => finish(true), timeoutMs);
      timer.unref();
      this.waiters.add(check);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
