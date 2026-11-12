/**
 * T3 Code orchestration bridge (plan 015).
 *
 * Exposes a fixed allowlist of T3 Code's orchestration tools, plus the DevSpace-native
 * `t3_inbox`, through DevSpace's MCP server. The bridge talks to T3 Code's local Streamable
 * HTTP MCP endpoint with a full-access client credential minted headlessly through the T3 CLI
 * pairing flow. The credential lives in memory only and is never logged or returned.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { ProtocolError, SdkHttpError } from "@modelcontextprotocol/client";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as z from "zod/v4";
import type { AnnotationProfile, ServerConfig, T3BridgeConfig } from "./config.js";
import { logEvent, type LoggingConfig } from "./logger.js";
import { toolAnnotationsForProfile } from "./mcp-bridge-utils.js";
import { bridgeChildEnvironment } from "./shell-environment.js";
import { DEVSPACE_VERSION } from "./version.js";

export const T3_CAPABILITY = "t3";

export const T3_INBOX_TOOL = "t3_inbox";

export const T3_UNREACHABLE_MESSAGE = "T3 Code is not reachable on this machine.";
const T3_CREDENTIAL_REJECTED_MESSAGE = "T3 Code rejected DevSpace's credential.";

const T3_SCOPES = ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"] as const;
const PAIRING_TTL = "2m";
const CLI_TIMEOUT_MS = 30_000;
const CLI_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const OAUTH_TIMEOUT_MS = 15_000;
// T3 accepts loopback http redirect URIs and never calls them; the code is read from the decision response.
const OAUTH_REDIRECT_URI = "http://127.0.0.1:53682/callback";
const DAY_MS = 24 * 60 * 60 * 1000;
// Renew when fewer than min(three days, 10% of the token's lifetime) remain.
const TOKEN_RENEW_MARGIN_MS = 3 * DAY_MS;
const TOKEN_RENEW_FRACTION = 0.1;
const DEFAULT_TOKEN_LIFETIME_MS = 30 * DAY_MS;
const DEFAULT_CATALOG_TIMEOUT_MS = 3_000;
/** After a failed or timed-out catalog load, sessions get the fallback catalog at once for this long. */
const CATALOG_FALLBACK_MS = 60_000;
/** A project id the project list did not contain is not looked up again for this long. */
const PROJECT_MISS_TTL_MS = 60_000;
const REACHABILITY_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
const WAIT_DEFAULT_MS = 20_000;
const WAIT_MAX_MS = 25_000;
const READ_DEFAULT_LIMIT = 6;
const READ_DEFAULT_MAX_CHARS = 1_500;
const TAIL_INITIAL_WINDOW = 40;
const TAIL_MAX_WIDENINGS = 3;
const TAIL_MAX_PAGES = 40;
const PROJECT_MAX_PAGES = 20;
const INBOX_DEFAULT_LIMIT = 8;
const INBOX_MAX_LIMIT = 20;
const INBOX_PAGE_SIZE = 100;
/** At most 1000 unsettled top-level rows (10 pages) are read per inbox check. */
const INBOX_MAX_PAGES = 10;
const INBOX_MAX_INSPECTED = 60;
const INBOX_MAX_REPORTED = 1_000;
const INBOX_CONCURRENCY = 4;
const INBOX_PREVIEW_COUNT = 5;
const INBOX_PREVIEW_CHARS = 300;

const T3_GUIDANCE =
  "Find threads with t3_thread_search or t3_thread_list; never ask the user for IDs. Refer to threads by title and project, and give the thread link when the user may want to open it in the T3 app. Threads always run in full-access mode.";

const THREAD_REQUIRED_TOOLS = new Set(["t3_pending_request", "t3_thread_organize", "t3_queue", "t3_thread_update"]);
const CLIENT_REQUEST_ID_TOOLS = new Set(["t3_thread_launch", "t3_thread_send", "t3_thread_interrupt", "t3_thread_update"]);
/** Read-only T3 tools: safe to retry once after the connection dropped mid-request. */
const IDEMPOTENT_READ_TOOLS = new Set([
  "t3_project_list",
  "t3_thread_search",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_wait",
  "list_scheduled_tasks",
  "orchestrator_capabilities",
]);
/**
 * Fields the project tools forward. T3's other project settings stay out of the model-facing
 * surface, notably `scripts` (commands T3 runs on every new worktree). T3 ignores a default model
 * given at creation, so it is set with `t3_project_update`.
 */
const PROJECT_CREATE_FIELDS = ["title", "workspaceRoot", "createWorkspaceRootIfMissing"] as const;
const PROJECT_UPDATE_FIELDS = ["projectId", "title", "defaultModelSelection"] as const;
/** Webhook trigger settings; webhook triggers are not exposed (they accept requests from outside). */
const WEBHOOK_SCHEDULE_FIELDS = ["signature", "maxDeliveryAgeMinutes", "dedupe", "filters"] as const;
/** Secret-bearing scheduled-task fields removed from results: the webhook URL carries its access token. */
const WEBHOOK_RESULT_FIELDS = ["webhookUrl", "webhookSignature"] as const;
const SCHEDULE_DESCRIPTION =
  "Trigger: {type:'interval',everyMs} (everyMs at least 60000), {type:'fixed_time',timeOfDay:'HH:MM',weekdays?} (weekdays 0-6, 0 is Sunday; default every day), or {type:'once',runAt} (ISO-8601).";
const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const OUTCOME_BY_STATUS: Record<string, "finished" | "failed" | "stopped"> = {
  completed: "finished",
  failed: "failed",
  rolled_back: "failed",
  interrupted: "stopped",
  cancelled: "stopped",
};
const UNREACHABLE_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "EAI_AGAIN"]);

interface ToolSpec {
  title: string;
  readOnly: boolean;
  /** Description used when T3's live description is unavailable. */
  summary: string;
  /** DevSpace behavior appended to the description. */
  note?: string;
  /** Use `summary` even when T3's live description is available (T3 writes it for in-thread agents). */
  ownDescription?: boolean;
}

/** Every DevSpace T3 tool; key order is the registration order (`T3_TOOL_NAMES`). */
const TOOL_SPECS: Record<string, ToolSpec> = {
  t3_project_list: {
    title: "List T3 projects",
    readOnly: true,
    summary: "List T3 Code projects with their titles and folders.",
  },
  t3_thread_search: {
    title: "Search T3 threads",
    readOnly: true,
    summary: "Search T3 Code threads by title, branch, pull request, project, then message text.",
  },
  t3_thread_list: {
    title: "List T3 threads",
    readOnly: true,
    summary: "List T3 Code threads newest first, in one project or across all projects.",
    note: "Without `projectId` it lists all projects; subagent threads are left out and 10 rows are returned unless asked otherwise.",
  },
  t3_thread_read: {
    title: "Read a T3 thread",
    readOnly: true,
    summary: "Read a T3 Code thread's messages.",
    note: "Without `afterPosition` or `itemId` it returns the latest `limit` messages (default 6); `olderAvailable` says whether earlier ones exist.",
  },
  t3_thread_wait: {
    title: "Wait for a T3 thread",
    readOnly: true,
    summary: "Wait briefly for a T3 Code thread's run to finish.",
    note: "`timeoutMs` defaults to 20000 and is capped at 25000.",
  },
  [T3_INBOX_TOOL]: {
    title: "Check the T3 inbox",
    readOnly: true,
    summary:
      "Check T3 Code for threads that need the user (agent questions, and approvals only the T3 app can grant) and threads that finished, failed, or stopped since the last check. `needsYou` lists everything waiting; when `needsYouIncomplete` is true, `uninspected` active threads were not checked. `new` lists outcomes after the cursor, newest first, up to `limit`; `omitted` counts the outcomes left out, and the next check without `since` lists them. `since` (ISO-8601) overrides the cursor for that check; otherwise the cursor is the previous check or 24 hours ago, and it never moves past outcomes that were not listed. Answer questions with t3_pending_request, and settle a handled thread with t3_thread_organize action `settle`.",
  },
  t3_thread_launch: {
    title: "Start a T3 thread",
    readOnly: false,
    summary: "Start a new T3 Code thread in a project (`projectId`) or a new scratch folder (`scratch: true`), with the task in `message`.",
  },
  t3_thread_send: {
    title: "Send to a T3 thread",
    readOnly: false,
    summary: "Send a message to a T3 Code thread: start it, steer the running turn, queue a new turn, or restart.",
  },
  t3_thread_interrupt: {
    title: "Interrupt a T3 thread",
    readOnly: false,
    summary: "Stop a T3 Code thread's running turn.",
  },
  t3_pending_request: {
    title: "Answer a T3 agent question",
    readOnly: false,
    summary:
      "List, read, and answer the questions a T3 Code agent is waiting on. `respond` takes `answers` keyed by each question's `id` with the chosen option's `label`. Approvals are not listed and cannot be granted here.",
  },
  t3_thread_organize: {
    title: "Organize a T3 thread",
    readOnly: false,
    summary: "Settle, snooze, pin, archive, or mark a T3 Code thread unread. `snooze` needs `snoozedUntil`.",
  },
  t3_queue: {
    title: "Manage a T3 thread's queue",
    readOnly: false,
    summary: "List, read, edit, cancel, or reorder a T3 Code thread's queued messages.",
  },
  t3_thread_update: {
    title: "Rename a T3 thread",
    readOnly: false,
    summary: 'Rename a T3 Code thread (`action: "rename"` with `title`) or regenerate its title (`action: "regenerate_title"`).',
  },
  orchestrator_capabilities: {
    title: "List T3 models",
    readOnly: true,
    summary: "List the agent providers and models T3 Code can run, with each model's options. The list is short; `search` finds other models.",
    note: "Name models to the user by their `label`. A provider with `constraints` cannot run now; do not pick its models. Use a provider's `providerInstanceId` as `instanceId` and a model's `id` as `model` in t3_thread_launch `modelSelection` or t3_project_update `defaultModelSelection`.",
    ownDescription: true,
  },
  t3_project_create: {
    title: "Create a T3 project",
    readOnly: false,
    summary: "Register a folder as a T3 Code project, or create a new git repository for one.",
    note: "Without `workspaceRoot`, T3 creates a git repository at `~/.t3/projects/<title>`. A `workspaceRoot` must be an absolute path (or start with `~/`) and is created when missing. Set the project's default model afterwards with t3_project_update.",
  },
  t3_project_clone: {
    title: "Clone a repository for T3",
    readOnly: false,
    summary: "Clone a git repository into a new or empty folder.",
    note: "`destinationPath` must be an absolute path (or start with `~/`); the `workspaceRoot` of existing projects from t3_project_list shows where projects usually live. Then register the clone with t3_project_create, passing the returned `cwd` as `workspaceRoot`.",
  },
  t3_project_update: {
    title: "Update a T3 project",
    readOnly: false,
    summary: "Rename a T3 Code project or set its default model.",
    note: "`defaultModelSelection` is `{ instanceId, model }` from orchestrator_capabilities. Scheduled tasks need a project default model.",
  },
  list_scheduled_tasks: {
    title: "List scheduled T3 tasks",
    readOnly: true,
    summary: "List T3 Code scheduled tasks, in one project or in every project.",
  },
  schedule_task: {
    title: "Schedule a T3 task",
    readOnly: false,
    summary: "Create or update a T3 Code scheduled task that starts a new thread on a schedule.",
    note: "Pass `projectId` when creating a task; the project needs a default model (set it with t3_project_update) and must be a git repository. Unless `freshSession` is set, each run starts a new full-access thread in its own worktree. Webhook triggers are not available here.",
  },
  run_scheduled_task_now: {
    title: "Run a scheduled T3 task now",
    readOnly: false,
    summary: "Start one run of a T3 Code scheduled task now.",
    note: "`taskId` is the task's `scheduledTaskId`. Follow the returned thread with t3_thread_wait and t3_thread_read.",
  },
  delete_scheduled_task: {
    title: "Delete a scheduled T3 task",
    readOnly: false,
    summary: "Delete a T3 Code scheduled task.",
  },
};

export const T3_TOOL_NAMES: readonly string[] = Object.freeze(Object.keys(TOOL_SPECS));

export const T3_FORWARDED_TOOLS: readonly string[] = Object.freeze(T3_TOOL_NAMES.filter((name) => name !== T3_INBOX_TOOL));

const FORWARDED = new Set(T3_FORWARDED_TOOLS);

/** Targeted rewrites of T3's own descriptions; T3 writes them for agents running inside a thread. */
const DESCRIPTION_REWRITES: Record<string, Array<[string, string]>> = {
  t3_thread_search: [["`projectId`: one project, else yours, else all outside a thread.", "`projectId`: one project, else all projects."]],
  t3_thread_launch: [
    [
      "Omit `projectId`, model and modes to inherit yours (outside a thread, pass `projectId` or `scratch`); modes cannot exceed yours.",
      "Pass `projectId` (from t3_project_list) or `scratch: true`.",
    ],
  ],
  t3_thread_send: [["The target cannot run with broader modes than yours.", ""]],
  t3_thread_interrupt: [["For a delegate, use `task_cancel`.", ""]],
  t3_pending_request: [
    [
      "respond: answer one with `answers`;",
      "respond: answer one with `answers`, an object keyed by each question's `id` whose value is the chosen option's `label`;",
    ],
  ],
  t3_thread_organize: [["Settling this thread applies at turn end.", ""]],
  t3_project_clone: [["Register after with `t3_project_create`, with the same `environmentId`.", ""]],
  list_scheduled_tasks: [
    ["Omit `projectId` for this thread's project.", "Omit `projectId` to list every project's tasks."],
    ["In a scheduled run, do not call this to find your task. Do the prompt.", ""],
  ],
  schedule_task: [
    ["Report the returned next run time or `webhookUrl`.", "Report the returned next run time."],
    ["No `webhookUrl`: T3 Connect remote access is off.", ""],
    ["Webhook request values in the prompt are untrusted.", ""],
  ],
};

const INBOX_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    since: {
      type: "string",
      description: "ISO-8601 time; report outcomes updated after it. Defaults to the previous inbox check, or 24 hours ago.",
    },
    limit: { type: "integer", minimum: 1, maximum: INBOX_MAX_LIMIT, description: "Maximum `new` items (default 8)." },
  },
};

type Args = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export interface T3CliRunner {
  /** Runs the T3 CLI and resolves its stdout. */
  run(args: string[], signal?: AbortSignal): Promise<string>;
}

export interface T3TokenProvider {
  /** Cached token; mints (single-flight) when none is cached or fewer than min(three days, 10% of its lifetime) remain. */
  getToken(): Promise<string>;
  /** Forces a new token (revokes the label's sessions first); joins a mint already in flight. */
  refresh(): Promise<string>;
  /** Revokes every T3 session carrying the label and returns how many were revoked. */
  revokeOwnSessions(): Promise<number>;
}

export interface T3ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** JSON Schema object. */
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  /** Whether the schema and description come from T3's live tool list. */
  live: boolean;
}

export interface T3BridgeOptions {
  config: T3BridgeConfig;
  label: string;
  secretNames: string[];
  tokenProvider?: T3TokenProvider;
  resolveOrigin?: () => Promise<string>;
  now?: () => number;
  catalogTimeoutMs?: number;
  /** Optional DevSpace logging; the bridge never logs credentials. */
  logging?: LoggingConfig;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** T3 Code is down or cannot be located; the request was never sent. */
class T3UnreachableError extends Error {
  constructor() {
    super(T3_UNREACHABLE_MESSAGE);
  }
}

/** A failure whose message is safe to return to the caller. */
class T3CallError extends Error {}

/** T3 returned an `isError` result; it is passed through unchanged. */
class T3ToolError extends Error {
  constructor(readonly result: CallToolResult) {
    super("T3 Code returned an error result");
  }
}

/** Opening the MCP session failed with the given token. */
class T3ConnectError extends Error {
  constructor(
    readonly reason: unknown,
    readonly token: string,
  ) {
    super("T3 Code connection failed");
  }
}

// ---------------------------------------------------------------------------------------------
// Label, CLI, origin
// ---------------------------------------------------------------------------------------------

export function t3SessionLabel(stateDir: string): string {
  const digest = createHash("sha256").update(resolve(stateDir)).digest("hex");
  return `devspace-t3-bridge:${digest.slice(0, 10)}`;
}

export function createT3CliRunner(cliPath: string, secretNames: string[]): T3CliRunner {
  return {
    run(args: string[], signal?: AbortSignal): Promise<string> {
      const command = cliCommandName(args);
      return new Promise<string>((resolveRun, rejectRun) => {
        let settled = false;
        const finish = (error: Error | undefined, stdout?: string): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) rejectRun(error);
          else resolveRun(stdout ?? "");
        };
        const env = { ...bridgeChildEnvironment(process.env, secretNames), ELECTRON_RUN_AS_NODE: "1" };
        const child = spawn(cliPath, args, { env, stdio: ["ignore", "pipe", "pipe"], signal, windowsHide: true });
        let timedOut = false;
        let overflow = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, CLI_TIMEOUT_MS);
        const chunks: Buffer[] = [];
        let size = 0;
        child.stdout?.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > CLI_MAX_STDOUT_BYTES) {
            overflow = true;
            child.kill("SIGKILL");
            return;
          }
          chunks.push(chunk);
        });
        // The launcher may print harmless Electron warnings; stderr is drained and never surfaced.
        child.stderr?.resume();
        child.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") finish(new Error(`T3 CLI not found at ${cliPath}.`));
          else if (error.code === "EACCES") finish(new Error(`T3 CLI at ${cliPath} is not executable.`));
          else if (error.name === "AbortError") finish(new Error(`T3 CLI ${command} was cancelled.`));
          else finish(new Error(`T3 CLI ${command} could not run.`));
        });
        child.once("close", (code, closeSignal) => {
          if (timedOut) finish(new Error(`T3 CLI ${command} timed out after ${CLI_TIMEOUT_MS / 1000} seconds.`));
          else if (overflow) finish(new Error(`T3 CLI ${command} printed too much output.`));
          else if (code !== 0) finish(new Error(`T3 CLI ${command} exited with ${code ?? closeSignal}.`));
          else finish(undefined, Buffer.concat(chunks).toString("utf8"));
        });
      });
    },
  };
}

export function createT3OriginResolver(config: T3BridgeConfig): () => Promise<string> {
  return async () => {
    if (config.url) return httpOrigin(config.url);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(config.runtimeFile, "utf8"));
    } catch {
      throw new T3UnreachableError();
    }
    const origin = isRecord(parsed) ? parsed.origin : undefined;
    if (typeof origin !== "string") throw new T3UnreachableError();
    return httpOrigin(origin);
  };
}

function httpOrigin(value: string): string {
  const url = URL.parse(value.trim());
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) throw new T3UnreachableError();
  return url.origin;
}

function cliCommandName(args: string[]): string {
  return args.slice(0, 3).filter((arg) => !arg.startsWith("-")).join(" ") || "command";
}

/** Parses the CLI's JSON stdout, tolerating banner lines around it. Never echoes stdout. */
function parseCliJson(stdout: string, command: string): unknown {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    // fall through to line-based recovery
  }
  const lines = text.split(/\r?\n/);
  for (let start = 0; start < lines.length; start++) {
    const head = lines[start]!.trimStart();
    if (!head.startsWith("{") && !head.startsWith("[")) continue;
    for (let end = lines.length; end > start; end--) {
      const tail = lines[end - 1]!.trimEnd();
      if (!tail.endsWith("}") && !tail.endsWith("]")) continue;
      try {
        return JSON.parse(lines.slice(start, end).join("\n"));
      } catch {
        // try a shorter span
      }
    }
  }
  throw new Error(`T3 CLI ${command} did not print JSON.`);
}

// ---------------------------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------------------------

export function createT3TokenProvider(options: {
  runner: T3CliRunner;
  resolveOrigin: () => Promise<string>;
  label: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): T3TokenProvider {
  const { runner, resolveOrigin, label } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let current: { token: string; expiresAt: number; renewMarginMs: number } | undefined;
  let minting: Promise<string> | undefined;

  const revokeOwnSessions = async (): Promise<number> => {
    const listCommand = ["auth", "session", "list", "--json"];
    const sessions = parseCliJson(await runner.run(listCommand), cliCommandName(listCommand));
    if (!Array.isArray(sessions)) throw new Error("T3 CLI auth session list did not print a list.");
    let revoked = 0;
    for (const session of sessions) {
      if (!isRecord(session) || typeof session.sessionId !== "string") continue;
      if (!isRecord(session.client) || session.client.label !== label) continue;
      await runner.run(["auth", "session", "revoke", session.sessionId]);
      revoked += 1;
    }
    return revoked;
  };

  const mint = async (): Promise<string> => {
    let origin: string;
    try {
      origin = httpOrigin(await resolveOrigin());
    } catch {
      throw new T3UnreachableError();
    }
    // Reachability first, so a stopped T3 does not leave dangling pairing codes.
    const metadata = await oauthRequest(fetchImpl, `${origin}/.well-known/oauth-protected-resource`, { method: "GET" }, "resource metadata");
    const resource = typeof metadata.resource === "string" && metadata.resource ? metadata.resource : `${origin}/mcp`;

    // The cached token's session carries this label, so after a revocation it must not be reused
    // as the fallback for a renewal that fails further on.
    if ((await revokeOwnSessions()) > 0) current = undefined;

    const pairingCommand = ["auth", "pairing", "create", "--json", "--ttl", PAIRING_TTL, "--label", label];
    for (const scope of T3_SCOPES) pairingCommand.push("--scope", scope);
    const pairing = parseCliJson(await runner.run(pairingCommand), cliCommandName(pairingCommand));
    const pairingCode = isRecord(pairing) && typeof pairing.credential === "string" ? pairing.credential : "";
    if (!pairingCode) throw new Error("T3 CLI auth pairing create did not return a pairing credential.");

    const registration = await oauthRequest(
      fetchImpl,
      `${origin}/oauth/mcp/register`,
      jsonPost({ client_name: label, redirect_uris: [OAUTH_REDIRECT_URI], token_endpoint_auth_method: "none" }),
      "client registration",
    );
    const clientId = typeof registration.client_id === "string" ? registration.client_id : "";
    if (!clientId) throw new Error("T3 Code client registration did not return a client id.");

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("base64url");
    const decision = await oauthRequest(
      fetchImpl,
      `${origin}/oauth/mcp/decision`,
      jsonPost({
        authorization: {
          response_type: "code",
          client_id: clientId,
          redirect_uri: OAUTH_REDIRECT_URI,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          resource,
        },
        decision: { _tag: "pairing-code", access: "full-access", code: pairingCode },
      }),
      "pairing decision",
    );
    let code: string | null = null;
    let returnedState: string | null = null;
    if (typeof decision.redirectTo === "string") {
      try {
        const redirect = new URL(decision.redirectTo, origin);
        code = redirect.searchParams.get("code");
        returnedState = redirect.searchParams.get("state");
      } catch {
        // handled below
      }
    }
    if (!code || returnedState !== state) throw new Error("T3 Code did not approve the pairing decision.");

    const tokenResponse = await oauthRequest(
      fetchImpl,
      `${origin}/oauth/mcp/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: OAUTH_REDIRECT_URI,
          client_id: clientId,
          code_verifier: verifier,
          resource,
        }).toString(),
      },
      "token exchange",
    );
    const accessToken = typeof tokenResponse.access_token === "string" ? tokenResponse.access_token : "";
    if (!accessToken) throw new Error("T3 Code token exchange did not return an access token.");
    const lifetimeMs =
      typeof tokenResponse.expires_in === "number" && tokenResponse.expires_in > 0
        ? tokenResponse.expires_in * 1000
        : DEFAULT_TOKEN_LIFETIME_MS;
    current = {
      token: accessToken,
      expiresAt: now() + lifetimeMs,
      renewMarginMs: Math.min(TOKEN_RENEW_MARGIN_MS, lifetimeMs * TOKEN_RENEW_FRACTION),
    };
    return accessToken;
  };

  const startMint = (): Promise<string> => {
    minting ??= mint().finally(() => {
      minting = undefined;
    });
    return minting;
  };

  return {
    async getToken(): Promise<string> {
      if (current && current.expiresAt - now() > current.renewMarginMs) return current.token;
      const previous = current;
      try {
        return await startMint();
      } catch (error) {
        // Renewal is early; a still-valid token keeps working when the renewal fails.
        if (previous && previous === current && previous.expiresAt > now()) return previous.token;
        throw error;
      }
    },
    refresh: startMint,
    revokeOwnSessions,
  };
}

function jsonPost(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** OAuth request whose errors never include request or response bodies (they carry codes). */
async function oauthRequest(fetchImpl: typeof fetch, url: string, init: RequestInit, step: string): Promise<Args> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS) });
  } catch (error) {
    if (isUnreachableError(error)) throw new T3UnreachableError();
    throw new Error(`T3 Code ${step} request failed.`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`T3 Code ${step} failed with HTTP ${response.status}.`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`T3 Code ${step} returned invalid JSON.`);
  }
  if (!isRecord(body)) throw new Error(`T3 Code ${step} returned an unexpected response.`);
  return body;
}

// ---------------------------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------------------------

interface T3Connection {
  client: Client;
  token: string;
  inFlight: number;
  retired: boolean;
}

interface ConnectionSlot {
  token: string;
  promise: Promise<T3Connection>;
  connection?: T3Connection;
}

interface LiveTool {
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class T3Bridge {
  private readonly tokenProvider: T3TokenProvider;
  private readonly resolveOrigin: () => Promise<string>;
  private readonly now: () => number;
  private readonly catalogTimeoutMs: number;
  private readonly logging?: LoggingConfig;
  private slot?: ConnectionSlot;
  private liveTools?: Map<string, LiveTool>;
  private catalogLoad?: Promise<void>;
  /** When the last blocking catalog load failed or timed out. */
  private catalogFailedAt?: number;
  private projectTitles = new Map<string, string>();
  private projectLoad?: Promise<void>;
  /** Project ids a reload did not find, with the reload time (negative cache). */
  private projectMisses = new Map<string, number>();
  /** Implicit inbox cursor: the previous check, or the cursor held back while outcomes were omitted. */
  private inboxCursor?: number;
  /** Outcomes (`threadId updatedAt`) already listed after the held-back `inboxCursor`. */
  private inboxReported = new Set<string>();

  constructor(options: T3BridgeOptions) {
    this.now = options.now ?? Date.now;
    this.resolveOrigin = options.resolveOrigin ?? createT3OriginResolver(options.config);
    this.tokenProvider =
      options.tokenProvider ??
      createT3TokenProvider({
        runner: createT3CliRunner(options.config.cliPath, options.secretNames),
        resolveOrigin: this.resolveOrigin,
        label: options.label,
        now: this.now,
      });
    this.catalogTimeoutMs = options.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS;
    this.logging = options.logging;
  }

  /**
   * Every tool in `T3_TOOL_NAMES` order; loose schemas with `live: false` when T3 is
   * unreachable. Waits for the catalog at most `catalogTimeoutMs`, and not at all within
   * `CATALOG_FALLBACK_MS` of a failed or timed-out wait (a refresh then runs in the background).
   */
  async toolDefinitions(): Promise<T3ToolDefinition[]> {
    if (!this.liveTools) {
      const failedAt = this.catalogFailedAt;
      if (failedAt !== undefined && this.now() - failedAt < CATALOG_FALLBACK_MS) {
        void this.loadCatalog().catch(() => undefined);
      } else {
        await withTimeout(this.loadCatalog().catch(() => undefined), this.catalogTimeoutMs);
        if (!this.liveTools) this.catalogFailedAt = this.now();
      }
    }
    return T3_TOOL_NAMES.map((name) => this.definition(name));
  }

  /** Never throws: failures are `isError` results; T3's own `isError` results pass through unchanged. */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    try {
      const input = isRecord(args) ? args : {};
      if (name === T3_INBOX_TOOL) return await this.inbox(input, signal);
      if (!FORWARDED.has(name)) return errorResult(`${name} is not a DevSpace T3 tool.`);
      const shaped = shapeArguments(name, input);
      if (typeof shaped === "string") return errorResult(shaped);
      switch (name) {
        case "t3_thread_read":
          return await this.readThread(shaped, signal);
        case "t3_project_list":
        case "t3_thread_list":
        case "t3_thread_search":
          return jsonResult(await this.compactListing(name, await this.invokeData(name, name, shaped, signal)));
        case "orchestrator_capabilities":
          return jsonResult(compactCapabilities(await this.invokeData(name, name, shaped, signal)));
        case "schedule_task":
        case "list_scheduled_tasks":
          return withoutWebhookSecrets(await this.invoke(name, name, shaped, signal));
        case "t3_project_create":
        case "t3_project_update": {
          // Keep the project titles shown in thread rows current after a create or rename.
          const result = await this.invoke(name, name, shaped, signal);
          if (!result.isError) {
            const project = resultRecord(result);
            rememberProject(this.projectTitles, project);
            if (typeof project.id === "string") this.projectMisses.delete(project.id);
          }
          return result;
        }
        default:
          return await this.invoke(name, name, shaped, signal);
      }
    } catch (error) {
      if (error instanceof T3ToolError) return error.result;
      if (error instanceof T3CallError) return errorResult(error.message);
      this.log("warn", "t3_bridge_call_failed", { tool: name, error: error instanceof Error ? error.name : "unknown" });
      return errorResult(sentFailureMessage(name));
    }
  }

  async close(options?: { revoke?: boolean }): Promise<void> {
    const slot = this.slot;
    this.slot = undefined;
    if (slot) {
      const connection = await slot.promise.catch(() => undefined);
      if (connection) {
        connection.retired = true;
        await connection.client.close().catch(() => undefined);
      }
    }
    if (options?.revoke) await this.tokenProvider.revokeOwnSessions();
  }

  // -- catalog ---------------------------------------------------------------------------------

  private loadCatalog(): Promise<void> {
    this.catalogLoad ??= this.withConnection("tools/list", true, undefined, async (client) => {
      const tools = new Map<string, LiveTool>();
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = await client.request(
          { method: "tools/list", params: cursor ? { cursor } : {} },
          { timeout: CONNECT_TIMEOUT_MS },
        );
        for (const tool of result.tools) {
          if (FORWARDED.has(tool.name)) {
            tools.set(tool.name, { description: tool.description, inputSchema: tool.inputSchema as Record<string, unknown> });
          }
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return tools;
    })
      .then((tools) => {
        this.liveTools = tools;
      })
      .finally(() => {
        this.catalogLoad = undefined;
      });
    return this.catalogLoad;
  }

  private definition(name: string): T3ToolDefinition {
    const spec = TOOL_SPECS[name]!;
    if (name === T3_INBOX_TOOL) {
      return {
        name,
        title: spec.title,
        description: describeTool(name, undefined),
        inputSchema: structuredClone(INBOX_INPUT_SCHEMA),
        readOnly: spec.readOnly,
        live: this.liveTools !== undefined,
      };
    }
    const tool = this.liveTools?.get(name);
    if (!tool) {
      return {
        name,
        title: spec.title,
        description: describeTool(name, undefined),
        inputSchema: { type: "object", additionalProperties: true },
        readOnly: spec.readOnly,
        live: false,
      };
    }
    return {
      name,
      title: spec.title,
      description: describeTool(name, tool.description),
      inputSchema: trimSchema(name, tool.inputSchema),
      readOnly: spec.readOnly,
      live: true,
    };
  }

  // -- connection ------------------------------------------------------------------------------

  private async acquire(): Promise<T3Connection> {
    const token = await this.tokenProvider.getToken();
    let slot = this.slot;
    if (!slot || slot.token !== token) {
      if (slot) this.retireSlot(slot);
      const created: ConnectionSlot = { token, promise: this.open(token) };
      created.promise.then(
        (connection) => {
          created.connection = connection;
          if (this.slot !== created) {
            this.retire(connection);
            return;
          }
          // Refresh the catalog on every new session (single-flight with the first fetch).
          void this.loadCatalog().catch(() => undefined);
        },
        () => {
          if (this.slot === created) this.slot = undefined;
        },
      );
      this.slot = slot = created;
    }
    try {
      return await slot.promise;
    } catch (error) {
      throw new T3ConnectError(error, token);
    }
  }

  private async open(token: string): Promise<T3Connection> {
    const origin = httpOrigin(await this.resolveOrigin());
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "devspace-t3-bridge", version: DEVSPACE_VERSION }, { capabilities: {} });
    const connection: T3Connection = { client, token, inFlight: 0, retired: false };
    // A dropped SSE response stream is reported only through onerror and would leave its request
    // pending until the timeout; closing the client rejects pending requests so they can be retried.
    client.onerror = (error) => {
      if (error instanceof Error && error.message.startsWith("SSE stream disconnected")) {
        this.retire(connection, true);
      }
    };
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    this.log("debug", "t3_bridge_connected", { origin });
    return connection;
  }

  private retireSlot(slot: ConnectionSlot): void {
    if (this.slot === slot) this.slot = undefined;
    if (slot.connection) this.retire(slot.connection);
  }

  private retire(connection: T3Connection, force = false): void {
    if (this.slot?.connection === connection) this.slot = undefined;
    const alreadyRetired = connection.retired;
    connection.retired = true;
    if ((force && !alreadyRetired) || connection.inFlight === 0) {
      void connection.client.close().catch(() => undefined);
    }
  }

  /**
   * Runs one request with the retry policy: 401 re-mints and retries once; 404 (stale MCP
   * session) reconnects and retries once; any other failure after sending retries once only
   * when `retryAfterSend` (a read, or arguments that carry `clientRequestId`).
   */
  private async withConnection<T>(
    label: string,
    retryAfterSend: boolean,
    signal: AbortSignal | undefined,
    operation: (client: Client) => Promise<T>,
  ): Promise<T> {
    let authRetried = false;
    let sessionRetried = false;
    let sendRetried = false;
    let retiredRetried = false;
    const retryCredential = async (rejectedToken: string): Promise<void> => {
      if (authRetried) throw new T3CallError(T3_CREDENTIAL_REJECTED_MESSAGE);
      authRetried = true;
      this.log("debug", "t3_bridge_retry", { tool: label, reason: "credential_rejected" });
      await this.renewTokenOrFail(rejectedToken);
    };
    for (;;) {
      if (signal?.aborted) throw new T3CallError(sentFailureMessage(label));
      let connection: T3Connection;
      try {
        connection = await this.acquire();
      } catch (error) {
        if (error instanceof T3ConnectError && httpStatus(error.reason) === 401) {
          await retryCredential(error.token);
          continue;
        }
        throw this.connectFailure(error);
      }
      if (connection.retired && !retiredRetried) {
        // Retired while it was opening (the token changed meanwhile); nothing was sent on it.
        retiredRetried = true;
        continue;
      }
      connection.inFlight += 1;
      try {
        return await operation(connection.client);
      } catch (error) {
        if (signal?.aborted) throw new T3CallError(sentFailureMessage(label));
        // v2: ConnectionClosed and RequestTimeout are raised as SdkError, never ProtocolError, so a
        // ProtocolError is always a JSON-RPC error answered by T3.
        if (error instanceof ProtocolError) {
          // T3 answered with a JSON-RPC error: the session is healthy and the call did not run.
          throw new T3CallError(`T3 Code could not run ${label}: ${error.message}`);
        }
        const status = httpStatus(error);
        this.log("debug", "t3_bridge_request_failed", { tool: label, status: status ?? null, codes: errorCodes(error) });
        this.retire(connection);
        if (status === 401) {
          await retryCredential(connection.token);
          continue;
        }
        if (status === 404 && !sessionRetried) {
          sessionRetried = true;
          this.log("debug", "t3_bridge_retry", { tool: label, reason: "stale_session" });
          continue;
        }
        if (isUnreachableError(error)) throw new T3CallError(T3_UNREACHABLE_MESSAGE);
        if (retryAfterSend && !sendRetried) {
          sendRetried = true;
          this.log("debug", "t3_bridge_retry", { tool: label, reason: "connection_failed" });
          continue;
        }
        throw await this.sentFailure(label);
      } finally {
        connection.inFlight -= 1;
        if (connection.retired && connection.inFlight === 0) void connection.client.close().catch(() => undefined);
      }
    }
  }

  /**
   * The request was sent and may have run. When T3 has meanwhile gone away (a stopped T3 closes
   * pooled sockets and streams mid-request), report it as unreachable instead.
   */
  private async sentFailure(label: string): Promise<T3CallError> {
    return (await this.reachable()) ? new T3CallError(sentFailureMessage(label)) : new T3CallError(T3_UNREACHABLE_MESSAGE);
  }

  /**
   * Cheap reachability probe: an unauthenticated GET of T3's protected-resource metadata. It opens
   * no MCP session and never mints; any HTTP answer, or a timeout, counts as reachable.
   */
  private async reachable(): Promise<boolean> {
    let origin: string;
    try {
      origin = httpOrigin(await this.resolveOrigin());
    } catch {
      return false;
    }
    try {
      const response = await fetch(`${origin}/.well-known/oauth-protected-resource`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      return true;
    } catch (error) {
      return !isUnreachableError(error);
    }
  }

  private async renewTokenOrFail(failedToken: string): Promise<void> {
    try {
      const current = await this.tokenProvider.getToken();
      if (current !== failedToken) return; // another caller already renewed it
      this.log("info", "t3_bridge_credential_refresh", {});
      await this.tokenProvider.refresh();
    } catch (error) {
      throw this.connectFailure(error);
    }
  }

  private connectFailure(error: unknown): T3CallError {
    if (error instanceof T3CallError) return error;
    if (error instanceof T3ConnectError) {
      // Any failure while opening the session means the tool call was never sent.
      this.log("debug", "t3_bridge_unreachable", { status: httpStatus(error.reason) ?? null });
      return new T3CallError(T3_UNREACHABLE_MESSAGE);
    }
    if (isUnreachableError(error)) return new T3CallError(T3_UNREACHABLE_MESSAGE);
    const detail = error instanceof Error ? error.message : "unknown error";
    this.log("warn", "t3_bridge_credential_failed", { error: detail });
    return new T3CallError(`T3 Code credential setup failed: ${detail}`);
  }

  /**
   * Calls one T3 tool. Reads (`IDEMPOTENT_READ_TOOLS`, or `read` for the inbox's pending-request
   * lookups), calls carrying `clientRequestId`, and writes that only set fields are retried once
   * after a dropped connection.
   */
  private invoke(label: string, tool: string, args: Args, signal?: AbortSignal, read = false): Promise<CallToolResult> {
    const retryAfterSend = read || retrySafe(tool, args);
    return this.withConnection(label, retryAfterSend, signal, async (client) => {
      // The SDK never removes its abort listener from a request's signal, so each request gets its
      // own signal, linked to the caller's only while the request is in flight.
      const scoped = new AbortController();
      const forward = (): void => scoped.abort(signal?.reason);
      if (signal?.aborted) forward();
      else signal?.addEventListener("abort", forward, { once: true });
      try {
        return await client.request(
          { method: "tools/call", params: { name: tool, arguments: args } },
          { signal: scoped.signal, timeout: CALL_TIMEOUT_MS },
        );
      } finally {
        signal?.removeEventListener("abort", forward);
      }
    });
  }

  private async invokeData(label: string, tool: string, args: Args, signal?: AbortSignal, read = false): Promise<Args> {
    const result = await this.invoke(label, tool, args, signal, read);
    if (result.isError) throw new T3ToolError(result);
    return resultRecord(result);
  }

  // -- projects --------------------------------------------------------------------------------

  private projectTitle(projectId: unknown): string | null {
    return typeof projectId === "string" ? (this.projectTitles.get(projectId) ?? null) : null;
  }

  /**
   * Best effort: refreshes the cached project list when a project id is unknown. An id the
   * refresh did not find is not looked up again for `PROJECT_MISS_TTL_MS`; its title stays null.
   */
  private async ensureProjectTitles(projectIds: unknown[]): Promise<void> {
    const now = this.now();
    for (const [id, missedAt] of this.projectMisses) {
      if (now - missedAt >= PROJECT_MISS_TTL_MS) this.projectMisses.delete(id);
    }
    const unknown = new Set(
      projectIds.filter((id): id is string => typeof id === "string" && !this.projectTitles.has(id) && !this.projectMisses.has(id)),
    );
    if (unknown.size === 0) return;
    try {
      await this.loadProjects();
    } catch {
      // titles stay null
    }
    for (const id of unknown) if (!this.projectTitles.has(id)) this.projectMisses.set(id, now);
  }

  private loadProjects(): Promise<void> {
    this.projectLoad ??= (async () => {
      const titles = new Map<string, string>();
      let cursor: unknown;
      for (let page = 0; page < PROJECT_MAX_PAGES; page++) {
        const data = await this.invokeData("t3_project_list", "t3_project_list", {
          limit: 100,
          ...(typeof cursor === "number" ? { cursor } : {}),
        });
        for (const row of records(data.projects)) rememberProject(titles, row);
        cursor = data.nextCursor;
        if (typeof cursor !== "number") break;
      }
      this.projectTitles = titles;
    })().finally(() => {
      this.projectLoad = undefined;
    });
    return this.projectLoad;
  }

  private async compactListing(name: string, data: Args): Promise<Record<string, unknown>> {
    if (name === "t3_project_list") {
      const rows = records(data.projects);
      for (const row of rows) rememberProject(this.projectTitles, row);
      return {
        projects: rows.map((row) => ({ projectId: row.id ?? row.projectId, title: row.title, workspaceRoot: row.workspaceRoot })),
        nextCursor: data.nextCursor ?? null,
      };
    }
    if (name === "t3_thread_list") {
      const rows = records(data.threads);
      await this.ensureProjectTitles(rows.map((row) => row.projectId));
      return {
        threads: rows.map((row) => ({
          threadId: row.threadId,
          project: this.projectTitle(row.projectId),
          title: row.title,
          status: row.status,
          settled: row.settled,
          updatedAt: row.updatedAt,
          link: row.link,
        })),
        nextCursor: data.nextCursor ?? null,
        total: data.total ?? rows.length,
      };
    }
    const rows = records(data.matches);
    await this.ensureProjectTitles(rows.map((row) => row.projectId));
    return {
      matches: rows.map((row) => ({
        threadId: row.threadId,
        project: this.projectTitle(row.projectId),
        title: row.title,
        source: row.source,
        link: row.link,
      })),
    };
  }

  // -- reading ---------------------------------------------------------------------------------

  private compactThread(thread: Args): Record<string, unknown> {
    return {
      threadId: thread.threadId,
      project: this.projectTitle(thread.projectId),
      title: thread.title,
      status: thread.status,
      runtimeMode: thread.runtimeMode,
      pendingRequestCount: thread.pendingRequestCount,
      settled: thread.settled,
      archived: thread.archived,
      link: thread.link,
    };
  }

  private async readThread(args: Args, signal?: AbortSignal): Promise<CallToolResult> {
    if (!nonEmptyString(args.threadId)) return errorResult(missingThreadMessage());
    const limit = positiveInteger(args.limit) ?? READ_DEFAULT_LIMIT;
    const maxCharsPerItem = positiveInteger(args.maxCharsPerItem) ?? READ_DEFAULT_MAX_CHARS;
    if (args.afterPosition !== undefined || args.itemId !== undefined) {
      const data = await this.invokeData("t3_thread_read", "t3_thread_read", { ...args, limit, maxCharsPerItem }, signal);
      const thread = isRecord(data.thread) ? data.thread : {};
      await this.ensureProjectTitles([thread.projectId]);
      return jsonResult({
        thread: this.compactThread(thread),
        items: records(data.items).map(compactItem),
        olderAvailable: typeof args.afterPosition === "number" && args.afterPosition >= 0,
        nextPosition: data.nextPosition ?? null,
        hasMore: data.hasMore === true,
      });
    }
    const tail = await this.tailRead("t3_thread_read", args.threadId, { limit, maxCharsPerItem, view: args.view ?? "messages" }, signal);
    await this.ensureProjectTitles([tail.thread.projectId]);
    return jsonResult({
      thread: this.compactThread(tail.thread),
      items: tail.items.map(compactItem),
      olderAvailable: tail.olderAvailable,
    });
  }

  /**
   * Latest `limit` items. T3 pages forward from the start, so read the detail for `itemCount` and
   * page from `itemCount - window`, widening the window while too few items were found.
   */
  private async tailRead(
    label: string,
    threadId: string,
    options: { limit: number; maxCharsPerItem: number; view: unknown },
    signal?: AbortSignal,
  ): Promise<{ thread: Args; items: Args[]; olderAvailable: boolean }> {
    const detail = await this.invokeData(label, "t3_thread_read", { threadId, limit: 1, maxCharsPerItem: 1 }, signal);
    const thread = isRecord(detail.thread) ? detail.thread : {};
    const itemCount = typeof thread.itemCount === "number" ? thread.itemCount : 0;
    let window = TAIL_INITIAL_WINDOW;
    for (let widenings = 0; ; widenings++) {
      // The window starts at position `itemCount - window`. afterPosition is exclusive, so it is one
      // before that start; omit it to include position 0 when the window covers the thread.
      const start = itemCount - window;
      const afterPosition = start > 0 ? start - 1 : undefined;
      const { items, total } = await this.collectAfter(label, threadId, afterPosition, options, signal);
      if (total >= options.limit || afterPosition === undefined || widenings >= TAIL_MAX_WIDENINGS) {
        return { thread, items, olderAvailable: afterPosition !== undefined || total > options.limit };
      }
      window *= 4;
    }
  }

  private async collectAfter(
    label: string,
    threadId: string,
    afterPosition: number | undefined,
    options: { limit: number; maxCharsPerItem: number; view: unknown },
    signal?: AbortSignal,
  ): Promise<{ items: Args[]; total: number }> {
    const items: Args[] = [];
    let total = 0;
    let cursor = afterPosition;
    for (let page = 0; page < TAIL_MAX_PAGES; page++) {
      const data = await this.invokeData(
        label,
        "t3_thread_read",
        {
          threadId,
          view: options.view,
          limit: 100,
          maxCharsPerItem: options.maxCharsPerItem,
          ...(cursor !== undefined ? { afterPosition: cursor } : {}),
        },
        signal,
      );
      const pageItems = records(data.items);
      for (const item of pageItems) {
        items.push(item);
        total += 1;
        if (items.length > options.limit) items.shift();
      }
      const next = data.nextPosition;
      if (data.hasMore !== true || pageItems.length === 0 || typeof next !== "number") break;
      if (cursor !== undefined && next <= cursor) break;
      cursor = next;
    }
    return { items, total };
  }

  // -- inbox -----------------------------------------------------------------------------------

  /**
   * DevSpace-native inbox. With the implicit cursor, outcomes left out by `limit` are not lost: the
   * cursor stays where it was and the outcomes already listed are remembered, so the next check
   * lists the rest. The cursor moves to `checkedAt` only once nothing was omitted, and an explicit
   * `since` moves it only when it reached back at least as far as the implicit cursor.
   */
  private async inbox(args: Args, signal?: AbortSignal): Promise<CallToolResult> {
    const checkedAt = this.now();
    const explicit = args.since !== undefined && args.since !== null;
    let since: number;
    if (explicit) {
      const parsed = typeof args.since === "string" ? Date.parse(args.since) : Number.NaN;
      if (Number.isNaN(parsed)) return errorResult("since must be an ISO-8601 timestamp, for example 2026-11-09T17:00:00Z.");
      since = parsed;
    } else {
      since = this.inboxCursor ?? checkedAt - DAY_MS;
    }
    let limit = INBOX_DEFAULT_LIMIT;
    if (args.limit !== undefined && args.limit !== null) {
      if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > INBOX_MAX_LIMIT) {
        return errorResult(`limit must be an integer from 1 to ${INBOX_MAX_LIMIT}.`);
      }
      limit = args.limit;
    }

    const { rows: listed, truncated } = await this.inboxRows(signal);
    const rows = listed.filter((row) => row.snoozed !== true && row.settled !== true && row.archived !== true);
    await this.ensureProjectTitles(rows.map((row) => row.projectId));
    const summary = (row: Args) => ({
      threadId: row.threadId,
      project: this.projectTitle(row.projectId),
      title: row.title,
      link: row.link,
    });

    // Every active row is inspected, up to the INBOX_MAX_INSPECTED most recent; anything not
    // inspected makes needsYou incomplete.
    const active = rows.filter((row) => ACTIVE_STATUSES.has(String(row.status))).sort(byUpdatedDesc);
    const inspected = active.slice(0, INBOX_MAX_INSPECTED);
    let uninspected = active.length - inspected.length;
    let running = 0;
    const attention = await mapWithConcurrency(inspected, INBOX_CONCURRENCY, (row) => this.pendingAttention(row, signal));
    const needsYou: Array<Record<string, unknown>> = [];
    inspected.forEach((row, index) => {
      const pending = attention[index];
      if (pending === null) uninspected += 1;
      else if (pending) needsYou.push({ ...summary(row), ...pending, updatedAt: row.updatedAt });
      else running += 1;
    });
    const needsYouIncomplete = uninspected > 0 || truncated;

    // With the implicit cursor, outcomes already listed after the held-back cursor are skipped.
    const reported = explicit ? undefined : this.inboxReported;
    const outcomes = rows.flatMap((row) => {
      const outcome = OUTCOME_BY_STATUS[String(row.status)];
      if (!outcome) return [];
      const updatedMs = typeof row.updatedAt === "string" ? Date.parse(row.updatedAt) : Number.NaN;
      return [{ row, outcome, updatedMs, key: `${String(row.threadId)} ${String(row.updatedAt)}` }];
    });
    const fresh = outcomes
      .filter((entry) => entry.updatedMs > since && !reported?.has(entry.key))
      .sort((a, b) => b.updatedMs - a.updatedMs);
    const unsettledBacklog = outcomes.length - fresh.length;
    const shown = fresh.slice(0, limit);
    const omitted = fresh.length - shown.length;
    const previewed = shown.filter((entry) => entry.outcome === "finished").slice(0, INBOX_PREVIEW_COUNT);
    const previews = await mapWithConcurrency(previewed, INBOX_CONCURRENCY, (entry) => this.preview(entry.row, signal));
    const previewByEntry = new Map(previewed.map((entry, index) => [entry, previews[index]]));

    // An explicit `since` later than the implicit cursor did not list what lies between the two
    // (including outcomes held back by an earlier check), so it leaves the implicit state alone.
    const coversImplicit = !explicit || since <= (this.inboxCursor ?? checkedAt - DAY_MS);
    if (omitted === 0) {
      if (coversImplicit) {
        this.inboxCursor = checkedAt;
        this.inboxReported.clear();
      }
    } else if (!explicit) {
      // Hold the cursor (pinning the 24-hour fallback) and remember what this check listed.
      this.inboxCursor = since;
      for (const entry of shown) this.inboxReported.add(entry.key);
      for (const key of this.inboxReported) {
        if (this.inboxReported.size <= INBOX_MAX_REPORTED) break;
        this.inboxReported.delete(key);
      }
    }
    return jsonResult({
      needsYou,
      needsYouIncomplete,
      ...(needsYouIncomplete ? { uninspected } : {}),
      new: shown.map((entry) => {
        const preview = previewByEntry.get(entry);
        return {
          ...summary(entry.row),
          outcome: entry.outcome,
          updatedAt: entry.row.updatedAt,
          ...(preview !== undefined ? { preview } : {}),
        };
      }),
      omitted,
      counts: { running, unsettledBacklog },
      since: new Date(since).toISOString(),
      checkedAt: new Date(checkedAt).toISOString(),
    });
  }

  /** Unsettled top-level rows, newest first, paged through `nextCursor` up to INBOX_MAX_PAGES pages. */
  private async inboxRows(signal?: AbortSignal): Promise<{ rows: Args[]; truncated: boolean }> {
    const rows: Args[] = [];
    const seen = new Set<unknown>();
    let cursor: number | undefined;
    for (let page = 0; page < INBOX_MAX_PAGES; page++) {
      const data = await this.invokeData(
        T3_INBOX_TOOL,
        "t3_thread_list",
        {
          allProjects: true,
          settled: false,
          includeSubagents: false,
          limit: INBOX_PAGE_SIZE,
          ...(cursor !== undefined ? { cursor } : {}),
        },
        signal,
      );
      for (const row of records(data.threads)) {
        // Offset paging can repeat a row that moved up between pages.
        if (seen.has(row.threadId)) continue;
        seen.add(row.threadId);
        rows.push(row);
      }
      const next = data.nextCursor;
      if (typeof next !== "number" || (cursor !== undefined && next <= cursor)) return { rows, truncated: false };
      cursor = next;
    }
    return { rows, truncated: true };
  }

  /**
   * Pending question or approval on an active thread; undefined when it is simply running, null
   * when its detail could not be read (it was not inspected).
   */
  private async pendingAttention(row: Args, signal?: AbortSignal): Promise<Record<string, unknown> | undefined | null> {
    const threadId = row.threadId;
    if (!nonEmptyString(threadId)) return null;
    let pendingCount: unknown;
    try {
      const detail = await this.invokeData(T3_INBOX_TOOL, "t3_thread_read", { threadId, limit: 1, maxCharsPerItem: 1 }, signal);
      pendingCount = isRecord(detail.thread) ? detail.thread.pendingRequestCount : undefined;
    } catch (error) {
      if (error instanceof T3ToolError) return null;
      throw error;
    }
    if (typeof pendingCount !== "number" || pendingCount <= 0) return undefined;
    let requestId: string | undefined;
    try {
      const listed = await this.invokeData(T3_INBOX_TOOL, "t3_pending_request", { action: "list", threadId }, signal, true);
      requestId = Array.isArray(listed.requestIds) ? listed.requestIds.find(nonEmptyString) : undefined;
    } catch (error) {
      if (!(error instanceof T3ToolError)) throw error;
    }
    // t3_pending_request lists questions only; anything else pending is an approval for the T3 app.
    if (!requestId) return { kind: "approval" };
    try {
      const request = await this.invokeData(T3_INBOX_TOOL, "t3_pending_request", { action: "read", threadId, requestId }, signal, true);
      const question = records(request.questions)[0];
      if (!question) return { kind: "question", requestId };
      return {
        kind: "question",
        requestId,
        questionId: question.id,
        question: question.question,
        options: records(question.options)
          .map((option) => option.label)
          .filter((label): label is string => typeof label === "string"),
      };
    } catch (error) {
      if (error instanceof T3ToolError) return { kind: "question", requestId };
      throw error;
    }
  }

  private async preview(row: Args, signal?: AbortSignal): Promise<string | undefined> {
    if (!nonEmptyString(row.threadId)) return undefined;
    try {
      const tail = await this.tailRead(
        T3_INBOX_TOOL,
        row.threadId,
        { limit: 4, maxCharsPerItem: INBOX_PREVIEW_CHARS, view: "messages" },
        signal,
      );
      const last = [...tail.items].reverse().find((item) => item.type === "assistant_message" && typeof item.text === "string");
      return last ? (last.text as string).slice(0, INBOX_PREVIEW_CHARS) : undefined;
    } catch (error) {
      if (error instanceof T3ToolError) return undefined;
      throw error;
    }
  }

  private log(level: "debug" | "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    if (this.logging) logEvent(this.logging, level, event, fields);
  }
}

// ---------------------------------------------------------------------------------------------
// Shared instance and registration
// ---------------------------------------------------------------------------------------------

const sharedBridges = new Map<string, T3Bridge>();

/** Process-wide bridge per T3 settings and state directory; undefined unless `t3.enabled`. */
export function sharedT3Bridge(config: ServerConfig): T3Bridge | undefined {
  const t3 = config.t3;
  if (!t3?.enabled) return undefined;
  const key = JSON.stringify([t3.cliPath, t3.runtimeFile, t3.url ?? null, resolve(config.stateDir)]);
  let bridge = sharedBridges.get(key);
  if (!bridge) {
    bridge = new T3Bridge({
      config: t3,
      label: t3SessionLabel(config.stateDir),
      secretNames: config.secretNames,
      logging: config.logging,
    });
    sharedBridges.set(key, bridge);
  }
  return bridge;
}

/** Closes the connection of every process-wide bridge; each reconnects lazily on its next call. */
export async function closeSharedT3Bridges(): Promise<void> {
  await Promise.all([...sharedBridges.values()].map((bridge) => bridge.close().catch(() => undefined)));
}

export async function registerT3Tools(server: McpServer, bridge: T3Bridge, annotationProfile: AnnotationProfile): Promise<void> {
  const definitions = await bridge.toolDefinitions();
  for (const definition of definitions) {
    registerAppTool(
      server as never,
      definition.name as never,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: inputSchemaToZod(definition.inputSchema),
        // Write tools start agents or change thread state, so their base hints follow T3's own
        // (destructive, open-world); the trusted-owner profile relaxes them like DevSpace's exec tools.
        annotations: toolAnnotationsForProfile(annotationProfile, {
          readOnlyHint: definition.readOnly,
          destructiveHint: !definition.readOnly,
          openWorldHint: !definition.readOnly,
        }),
        _meta: {},
      } as never,
      (async (input: unknown, extra: { mcpReq?: { signal?: AbortSignal } } | undefined) => {
        const result = await bridge.call(definition.name, isRecord(input) ? input : {}, extra?.mcpReq?.signal);
        if (result.content.length > 0) return result;
        const text = result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : "";
        return { ...result, content: [{ type: "text", text }] };
      }) as never,
    );
  }
}

/**
 * JSON Schema to Zod for registration, self-contained so T3's schemas convert faithfully:
 * `{}` accepts any value (such as `modelSelection.model`), and `type: "null"`, type arrays,
 * `enum`, `const`, `anyOf`/`oneOf`/`allOf`, arrays, and objects with `required` and
 * `additionalProperties` are handled here. The top level is always an object.
 */
function inputSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  return described(objectToZod(schema), schema);
}

function toZod(schema: unknown): z.ZodTypeAny {
  if (schema === false) return z.never();
  if (!isRecord(schema)) return z.unknown();
  // JSON Schema keywords combine with AND: the schema's own type, then each composite.
  const parts: z.ZodTypeAny[] = [];
  const base = baseToZod(schema);
  if (base) parts.push(base);
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key];
    if (Array.isArray(options) && options.length > 0) parts.push(unionOf(options.map(toZod)));
  }
  if (Array.isArray(schema.allOf)) parts.push(...schema.allOf.map(toZod));
  const combined = parts.reduce<z.ZodTypeAny | undefined>((all, part) => (all ? z.intersection(all, part) : part), undefined);
  return described(combined ?? z.unknown(), schema);
}

/** The constraint from `const`, `enum`, `type`, `properties`, or `items`; undefined when there is none. */
function baseToZod(schema: Record<string, unknown>): z.ZodTypeAny | undefined {
  if ("const" in schema) return literalOf(schema.const);
  if (Array.isArray(schema.enum)) {
    const values = schema.enum;
    if (values.length > 0 && values.every((value): value is string => typeof value === "string")) {
      return z.enum(values as [string, ...string[]]);
    }
    return unionOf(values.map(literalOf));
  }
  if (Array.isArray(schema.type)) {
    return unionOf(schema.type.filter((type): type is string => typeof type === "string").map((type) => typedToZod(schema, type)));
  }
  if (typeof schema.type === "string") return typedToZod(schema, schema.type);
  if (isRecord(schema.properties) || schema.additionalProperties !== undefined) return objectToZod(schema);
  if (schema.items !== undefined) return typedToZod(schema, "array");
  return undefined;
}

function typedToZod(schema: Record<string, unknown>, type: string): z.ZodTypeAny {
  switch (type) {
    case "null":
      return z.null();
    case "boolean":
      return z.boolean();
    case "string": {
      let text = z.string();
      if (typeof schema.minLength === "number") text = text.min(schema.minLength);
      if (typeof schema.maxLength === "number") text = text.max(schema.maxLength);
      if (typeof schema.pattern === "string") {
        try {
          text = text.regex(new RegExp(schema.pattern));
        } catch {
          // an unsupported pattern is not enforced here; T3 validates it
        }
      }
      return text;
    }
    case "number":
    case "integer": {
      let number = type === "integer" ? z.number().int() : z.number();
      if (typeof schema.minimum === "number") number = number.min(schema.minimum);
      if (typeof schema.maximum === "number") number = number.max(schema.maximum);
      if (typeof schema.exclusiveMinimum === "number") number = number.gt(schema.exclusiveMinimum);
      if (typeof schema.exclusiveMaximum === "number") number = number.lt(schema.exclusiveMaximum);
      return number;
    }
    case "array": {
      let array = z.array(toZod(schema.items ?? {}));
      if (typeof schema.minItems === "number") array = array.min(schema.minItems);
      if (typeof schema.maxItems === "number") array = array.max(schema.maxItems);
      return array;
    }
    case "object":
      return objectToZod(schema);
    default:
      return z.unknown();
  }
}

function objectToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === "string") : []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, property] of Object.entries(properties)) {
    const field = toZod(property);
    shape[key] = required.has(key) ? field : field.optional();
  }
  const extra = schema.additionalProperties;
  if (extra === false) return z.object(shape);
  if (isRecord(extra)) return z.object(shape).catchall(toZod(extra));
  return z.looseObject(shape);
}

function literalOf(value: unknown): z.ZodTypeAny {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return z.literal(value);
  }
  // Object and array constants match by JSON equality.
  const expected = JSON.stringify(value);
  return z.unknown().refine((input) => JSON.stringify(input) === expected);
}

function unionOf(options: z.ZodTypeAny[]): z.ZodTypeAny {
  if (options.length === 0) return z.never();
  if (options.length === 1) return options[0]!;
  return z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function described(type: z.ZodTypeAny, schema: unknown): z.ZodTypeAny {
  return isRecord(schema) && typeof schema.description === "string" ? type.describe(schema.description) : type;
}

// ---------------------------------------------------------------------------------------------
// Shaping helpers
// ---------------------------------------------------------------------------------------------

function shapeArguments(name: string, input: Args): Args | string {
  const args: Args = { ...input };
  delete args.environmentId;
  if (THREAD_REQUIRED_TOOLS.has(name) && !nonEmptyString(args.threadId)) return missingThreadMessage();
  switch (name) {
    case "t3_thread_launch":
      delete args.delegatedFrom;
      args.runtimeMode = "full-access";
      break;
    case "t3_thread_list":
      if (!nonEmptyString(args.projectId)) {
        delete args.projectId;
        args.allProjects = true;
      }
      args.includeSubagents ??= false;
      args.limit ??= 10;
      break;
    case "t3_thread_search":
      args.limit ??= 8;
      break;
    case "t3_project_list":
      args.limit ??= 50;
      break;
    case "t3_thread_wait": {
      const requested = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) ? args.timeoutMs : WAIT_DEFAULT_MS;
      args.timeoutMs = Math.max(0, Math.min(requested, WAIT_MAX_MS));
      break;
    }
    case "t3_project_create": {
      const picked = pick(args, PROJECT_CREATE_FIELDS);
      if (picked.workspaceRoot === undefined) return picked;
      const root = absolutePath(picked.workspaceRoot, "workspaceRoot");
      if (root.error) return root.error;
      picked.workspaceRoot = root.path;
      picked.createWorkspaceRootIfMissing ??= true;
      return picked;
    }
    case "t3_project_clone": {
      const destination = absolutePath(args.destinationPath, "destinationPath");
      if (destination.error) return destination.error;
      args.destinationPath = destination.path;
      break;
    }
    case "t3_project_update":
      return pick(args, PROJECT_UPDATE_FIELDS);
    case "schedule_task": {
      const schedule = args.schedule;
      if (schedule !== undefined) {
        if (!isRecord(schedule)) return 'schedule must be an object, such as { type: "once", runAt: "2026-12-01T09:00:00Z" }.';
        if (schedule.type === "webhook") return "Webhook triggers are not available through DevSpace; set them up in the T3 Code app.";
        args.schedule = omit(schedule, WEBHOOK_SCHEDULE_FIELDS);
      }
      delete args.bindToCurrentThread;
      if (!nonEmptyString(args.scheduledTaskId)) {
        // A new task starts a new thread per run, and `clientRequestId` makes creation idempotent.
        // Updates change only the given fields, so an existing task keeps its thread binding.
        args.bindToCurrentThread = false;
        if (!nonEmptyString(args.clientRequestId)) args.clientRequestId = randomUUID();
      }
      break;
    }
  }
  if (CLIENT_REQUEST_ID_TOOLS.has(name) && !nonEmptyString(args.clientRequestId)) args.clientRequestId = randomUUID();
  return args;
}

function pick(args: Args, fields: readonly string[]): Args {
  const picked: Args = {};
  for (const key of fields) if (args[key] !== undefined) picked[key] = args[key];
  return picked;
}

function omit(record: Args, fields: readonly string[]): Args {
  const copy = { ...record };
  for (const key of fields) delete copy[key];
  return copy;
}

/**
 * Whether a forwarded call may be retried once after its request was sent. `clientRequestId`
 * counts only for tools whose T3 schema accepts it; T3 ignores it elsewhere.
 */
function retrySafe(tool: string, args: Args): boolean {
  if (IDEMPOTENT_READ_TOOLS.has(tool)) return true;
  if ((CLIENT_REQUEST_ID_TOOLS.has(tool) || tool === "schedule_task") && nonEmptyString(args.clientRequestId)) return true;
  // These set fields to given values, so repeating them changes nothing.
  return tool === "t3_project_update" || (tool === "schedule_task" && nonEmptyString(args.scheduledTaskId));
}

/** An absolute path, with a leading `~` expanded to this user's home folder (T3 runs as the same user). */
function absolutePath(value: unknown, field: string): { path: string; error?: undefined } | { path?: undefined; error: string } {
  if (!nonEmptyString(value)) return { error: `${field} is required and must be an absolute path.` };
  const text = value.trim();
  if (text === "~") return { path: homedir() };
  if (text.startsWith("~/")) return { path: join(homedir(), text.slice(2)) };
  if (isAbsolute(text)) return { path: text };
  return { error: `${field} must be an absolute path (or start with ~/), not "${text}".` };
}

/** Providers and their models, with availability constraints, without the in-thread delegation details. */
function compactCapabilities(data: Args): Args {
  const nonEmpty = (value: unknown): unknown[] | undefined => (Array.isArray(value) && value.length > 0 ? value : undefined);
  const providers = records(data.providers).map((provider) =>
    definedOnly({
      providerInstanceId: provider.providerInstanceId,
      displayName: provider.displayName,
      models: records(provider.models).map((model) => {
        const options = records(model.options).map((option) => definedOnly({ id: option.id, values: option.values, default: option.default }));
        return definedOnly({ id: model.id, label: model.label, options: nonEmpty(options) });
      }),
      // Why a provider cannot run now, such as "Provider instance is disabled."
      constraints: nonEmpty(provider.constraints),
    }),
  );
  return { providers };
}

/** The object without its undefined fields, so `structuredContent` and its JSON text agree. */
function definedOnly(value: Args): Args {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

/** Removes the webhook URL (it carries its access token) and signing details from scheduled-task results. */
function withoutWebhookSecrets(result: CallToolResult): CallToolResult {
  if (result.isError) return result;
  const data = resultRecord(result);
  const scrub = (task: Args): Args => omit(task, WEBHOOK_RESULT_FIELDS);
  return jsonResult(Array.isArray(data.tasks) ? { ...data, tasks: records(data.tasks).map(scrub) } : scrub(data));
}

function trimSchema(name: string, schema: Record<string, unknown>): Record<string, unknown> {
  const trimmed: Record<string, unknown> = structuredClone(schema);
  trimmed.type = "object";
  const properties: Record<string, unknown> = isRecord(trimmed.properties) ? { ...trimmed.properties } : {};
  delete properties.environmentId;
  switch (name) {
    case "t3_thread_launch":
      delete properties.runtimeMode;
      delete properties.delegatedFrom;
      break;
    case "t3_project_create":
    case "t3_project_update": {
      const fields: readonly string[] = name === "t3_project_create" ? PROJECT_CREATE_FIELDS : PROJECT_UPDATE_FIELDS;
      for (const key of Object.keys(properties)) if (!fields.includes(key)) delete properties[key];
      break;
    }
    case "schedule_task": {
      // `trimmed` is a deep copy, so the nested schedule schema is edited in place.
      delete properties.bindToCurrentThread;
      const schedule = properties.schedule;
      if (isRecord(schedule)) {
        schedule.description = SCHEDULE_DESCRIPTION;
        const fields = isRecord(schedule.properties) ? schedule.properties : {};
        for (const key of WEBHOOK_SCHEDULE_FIELDS) delete fields[key];
        if (isRecord(fields.type) && Array.isArray(fields.type.enum)) {
          fields.type.enum = fields.type.enum.filter((value) => value !== "webhook");
        }
      }
      break;
    }
  }
  let required = Array.isArray(trimmed.required)
    ? trimmed.required.filter((key): key is string => typeof key === "string" && key in properties)
    : [];
  if (THREAD_REQUIRED_TOOLS.has(name)) {
    properties.threadId ??= { type: "string" };
    if (!required.includes("threadId")) required = [...required, "threadId"];
  }
  trimmed.properties = properties;
  if (required.length > 0) trimmed.required = required;
  else delete trimmed.required;
  return trimmed;
}

function describeTool(name: string, liveDescription: string | undefined): string {
  const spec = TOOL_SPECS[name]!;
  const body = liveDescription && !spec.ownDescription ? rewriteDescription(name, liveDescription) : spec.summary;
  return `${spec.note ? `${body} ${spec.note}` : body}\n${T3_GUIDANCE}`;
}

function rewriteDescription(name: string, description: string): string {
  let text = description.replace(/\s*Omit `threadId` for this thread\.?/g, "");
  for (const [from, to] of DESCRIPTION_REWRITES[name] ?? []) text = text.replace(from, to);
  // Safety net if T3 rephrases: drop remaining sentences written for an agent inside a thread.
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.trim() !== "" && !/\bthis thread\b|\binherit\b|\byours\b/i.test(sentence))
    .join(" ")
    .trim();
}

function compactItem(item: Args): Record<string, unknown> {
  return {
    position: item.position,
    itemId: item.itemId,
    type: item.type,
    createdBy: item.createdBy,
    text: item.text ?? null,
    textTruncated: item.textTruncated === true,
    nextTextOffset: item.nextTextOffset ?? null,
    updatedAt: item.updatedAt,
  };
}

function rememberProject(titles: Map<string, string>, row: Args): void {
  const id = row.id ?? row.projectId;
  if (typeof id === "string" && typeof row.title === "string") titles.set(id, row.title);
}

function missingThreadMessage(): string {
  return "threadId is required. Find the thread with t3_thread_search or t3_thread_list.";
}

function sentFailureMessage(tool: string): string {
  return `T3 Code connection failed during ${tool}; it may or may not have run.`;
}

// ---------------------------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------------------------

function jsonResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function resultRecord(result: CallToolResult): Args {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  for (const block of result.content ?? []) {
    if (block.type !== "text") continue;
    try {
      const parsed: unknown = JSON.parse(block.text);
      if (isRecord(parsed)) return parsed;
    } catch {
      // not JSON
    }
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Args[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Newest `updatedAt` first; rows without a parsable time keep their order. */
function byUpdatedDesc(a: Args, b: Args): number {
  const time = (row: Args): number => (typeof row.updatedAt === "string" ? Date.parse(row.updatedAt) : Number.NaN);
  return time(b) - time(a) || 0;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function httpStatus(error: unknown): number | undefined {
  if (error instanceof SdkHttpError && typeof error.status === "number" && error.status > 0) return error.status;
  return undefined;
}

function errorCodes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== "object" || depth > 6) return [];
  const codes: string[] = [];
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") codes.push(code);
  codes.push(...errorCodes((error as { cause?: unknown }).cause, depth + 1));
  const nested = (error as { errors?: unknown }).errors;
  if (Array.isArray(nested)) for (const inner of nested) codes.push(...errorCodes(inner, depth + 1));
  return codes;
}

function isUnreachableError(error: unknown): boolean {
  return error instanceof T3UnreachableError || errorCodes(error).some((code) => UNREACHABLE_ERROR_CODES.has(code));
}

async function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([promise, new Promise<void>((resolveTimer) => (timer = setTimeout(resolveTimer, ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}
