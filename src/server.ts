import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { isCapabilityDisabled, loadConfig, parseDisabledCapabilities, type ServerConfig, type WidgetMode } from "./config.js";
import {
  logEvent,
  requestIp,
  requestPath,
  sessionIdPrefix,
} from "./logger.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { createOAuthStateStore } from "./oauth-store.js";
import { StaticKeyStore, StaticKeyVerifier } from "./static-key-provider.js";
import { DEVSPACE_VERSION } from "./version.js";
import { GatewayExecutionRouter, type ExecutionTarget, type RoutedExecution } from "./gateway-router.js";
import type { ToolName as CanonicalToolName } from "./tool-contract.js";
import { getBuildMetadata } from "./build-metadata.js";
import { createGatewayWorkspaceStore } from "./gateway-workspace-store.js";
import { LocalExecutor } from "./executor.js";
import { RemoteNodeClient } from "./remote-node-client.js";
import { envSecret, type GatewayRoleConfig } from "./role-config.js";
import { configuredLogicalRoots, normalizeRootPolicies, rootPoliciesFromStrings } from "./roots.js";

type Transport = StreamableHTTPServerTransport;
const WORKSPACE_APP_URI_PREFIX = "ui://devspace/workspace-app";

// sky-cua bridge singleton: lazily created stdio MCP client that proxies sky-cua's tools/list live.
// Keyed by binPath so changing DEVSPACE_SKY_CUA_BIN without restart does not reuse stale binary.
// Unhealthy bridges are not cached - next enabled session retries.
let skyBridgeCache = new Map<string, Promise<import("./sky-cua/bridge.js").SkyBridge | null>>();
async function getSkyBridge(config: ServerConfig): Promise<import("./sky-cua/bridge.js").SkyBridge | null> {
  const disabled = config.disabledCapabilities ?? new Set<string>();
  if (isCapabilityDisabled(disabled, "sky-cua")) return null;
  const skyCua = config.skyCua ?? { projectRoot: "/tmp/sky-cua-missing", binPath: "/tmp/sky-cua-missing/bin/sky-cua-client" };
  const key = skyCua.binPath;
  const cached = skyBridgeCache.get(key);
  if (cached) return cached;
  const promise = (async () => {
    try {
      const mod = await import("./sky-cua/bridge.js");
      const bridge = await mod.createSkyBridge(skyCua);
      if (!bridge || !bridge.healthy) {
        skyBridgeCache.delete(key);
        return bridge;
      }
      return bridge;
    } catch {
      skyBridgeCache.delete(key);
      return null;
    }
  })();
  skyBridgeCache.set(key, promise);
  promise.catch(() => skyBridgeCache.delete(key));
  return promise;
}

export function parseEffectiveDisabledFromRequest(req: Request, config: ServerConfig): Set<string> {
  const global = config.disabledCapabilities ?? new Set<string>();
  const headerRaw = (req.header("x-disabled-capabilities") ?? req.header("x-devspace-disabled-capabilities") ?? "") as string;
  const queryRaw = (typeof req.query?.disabled_capabilities === "string" ? (req.query.disabled_capabilities as string) : "") as string;
  // Also support clientInfo _meta disabledCapabilities passed via JSON-RPC body for initialize: check header fallback below in mcp handler.
  const headerSet = parseDisabledCapabilities(headerRaw);
  const querySet = parseDisabledCapabilities(queryRaw);
  const merged = new Set<string>([...global]);
  for (const c of headerSet) merged.add(c);
  for (const c of querySet) merged.add(c);
  // Also check per-request body meta if present (set by caller in initialize params._meta)
  // This is handled per-session at create time; here we just merge header/query.
  return merged;
}

function isSkyCuaDisabled(effective: Set<string>): boolean {
  return isCapabilityDisabled(effective, "sky-cua");
}

function filterSkyCuaSkillsForEffective(skills: unknown[] | undefined, effective: Set<string>, skyCuaRoot?: string): unknown[] | undefined {
  if (!skills || !isSkyCuaDisabled(effective)) return skills;
  const root = skyCuaRoot ?? "";
  return (skills as Array<{ path?: string; name?: string; id?: string }>).filter((s) => {
    const p = s.path ?? "";
    const n = s.name ?? s.id ?? "";
    if (root && p.includes(root)) return false;
    if (p.includes("sky-cua/skills") || p.includes("sky-cua")) return false;
    if (["phone-use", "browser-use", "computer-use"].includes(n)) return false;
    return true;
  });
}
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const WRITE_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

function toolAnnotationsForProfile(
  profile: ServerConfig["annotationProfile"],
  standard: ToolAnnotations,
  trustedOverrides: Partial<ToolAnnotations> = {},
): ToolAnnotations {
  if (profile === "standard") return standard;
  return {
    ...standard,
    destructiveHint: false,
    openWorldHint: false,
    ...trustedOverrides,
  };
}

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  close?: () => void;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

interface AppCsp {
  resourceDomains: string[];
  connectDomains: string[];
}

interface OpenAiWidgetCsp {
  resource_domains: string[];
  connect_domains: string[];
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

export function workspaceAppResourceUri(
  entry: Pick<WorkspaceAppManifestEntry, "file" | "css">,
): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([entry.file, ...(entry.css ?? [])]))
    .digest("hex")
    .slice(0, 12);
  return `${WORKSPACE_APP_URI_PREFIX}-${fingerprint}.html`;
}

type ToolWidgetKind =
  | "workspace_open"
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

interface ToolDefinitionMeta extends Record<string, unknown> {
  "openai/outputTemplate"?: string;
  "ui/resourceUri"?: string;
  ui?: {
    resourceUri?: string;
    visibility: Array<"model" | "app">;
  };
}

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "workspace_open" || kind === "workspace" || kind === "show_changes";
    case "workspace":
      return kind === "workspace_open";
    case "full":
      return true;
  }
}

export function toolWidgetDescriptorMeta(
  config: Pick<ServerConfig, "widgets">,
  kind: ToolWidgetKind,
  resourceUri?: string,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };
  if (!resourceUri) throw new Error("Widget resource URI is required when widgets are enabled.");

  return {
    _meta: {
      "openai/outputTemplate": resourceUri,
      ui: {
        resourceUri,
        visibility: ["model"],
      },
    },
  };
}

function appOnlyToolDescriptorMeta(): ToolWidgetDescriptorMeta {
  return {
    _meta: {
      ui: { visibility: ["app"] },
    },
  };
}

interface ToolNames {
  openWorkspace: "open_workspace";
  read: "read_file" | "read";
  write: "write_file" | "write";
  edit: "edit_file" | "edit";
  grep: "grep_files" | "grep";
  glob: "find_files" | "glob";
  ls: "list_directory" | "ls";
  shell: "run_shell" | "bash";
}

interface JsonRpcMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedLogString(value: unknown, maxLength = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function rpcIdForLog(value: unknown): string | number | null | undefined {
  if (value === null || typeof value === "number") return value;
  return boundedLogString(value, 128);
}

function uriForLog(value: unknown): string | undefined {
  const uri = boundedLogString(value);
  if (!uri) return undefined;

  try {
    const parsed = new URL(uri);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "<invalid-uri>";
  }
}

function compactLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

function rpcMessageTraceFields(body: JsonRpcMessage): Record<string, unknown> {
  const rpcMethod = boundedLogString(body.method, 128);
  const rpcId = rpcIdForLog(body.id);
  const params = isRecord(body.params) ? body.params : undefined;
  const rpcType = rpcMethod
    ? body.id === undefined
      ? "notification"
      : "request"
    : body.result !== undefined || body.error !== undefined
      ? "response"
      : "unknown";

  return {
    rpcType,
    rpcMethod,
    rpcId,
    resourceUri:
      rpcMethod?.startsWith("resources/") && params ? uriForLog(params.uri) : undefined,
    toolName: rpcMethod === "tools/call" && params
      ? boundedLogString(params.name, 128)
      : undefined,
    promptName: rpcMethod === "prompts/get" && params
      ? boundedLogString(params.name, 128)
      : undefined,
    requestedLogLevel: rpcMethod === "logging/setLevel" && params
      ? boundedLogString(params.level, 32)
      : undefined,
    relatedRpcId: rpcMethod === "notifications/cancelled" && params
      ? rpcIdForLog(params.requestId)
      : undefined,
  };
}

export function mcpRequestTraceFields(
  body: unknown,
  httpMethod = "POST",
): Record<string, unknown> {
  if (httpMethod.toUpperCase() !== "POST") {
    return {
      rpcType: "transport",
      transportMethod: httpMethod.toUpperCase(),
    };
  }

  if (Array.isArray(body)) {
    const messages = body.filter(isRecord).map(rpcMessageTraceFields);
    return {
      rpcType: "batch",
      rpcBatchSize: body.length,
      rpcMessages: messages.map(compactLogFields),
    };
  }

  return isRecord(body)
    ? rpcMessageTraceFields(body)
    : { rpcType: "invalid", rpcBodyType: body === null ? "null" : typeof body };
}

function containsInitializeRequest(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(isInitializeRequest);
}

function toolNamesFor(config: ServerConfig): ToolNames {
  return config.toolNaming === "short"
    ? {
        openWorkspace: "open_workspace",
        read: "read",
        write: "write",
        edit: "edit",
        grep: "grep",
        glob: "glob",
        ls: "ls",
        shell: "bash",
      }
    : {
        openWorkspace: "open_workspace",
        read: "read_file",
        write: "write_file",
        edit: "edit_file",
        grep: "grep_files",
        glob: "find_files",
        ls: "list_directory",
        shell: "run_shell",
      };
}

const PHONE_EPHEMERAL_AGENTS_PATH = ".devspace/phone-AGENTS.md";
const PHONE_EPHEMERAL_AGENTS_CONTENT = [
  "# Phone — ephemeral lifecycle guidance (auto-injected when sky-cua is enabled)",
  "",
  "CompanionDirect sessions are **epoch-fenced**: `direct-{device_id}-{epoch}`. The companion ws epoch bumps on every reconnect (S26 `f6e5da20-d8df…`/`7381631a…` 1→13 observed), so a session is expected to drop.",
  "",
  "- **Ground truth for connectivity:** `list_resources(surface:phone, resource:devices)` (or `status(phone, refresh_devices:true)`). `status(phone)` without refresh only probes ADB and will show `devices=0` even when Direct devices are live — don't use it as \"Not connected\".",
  "- **Workspace / machine:** Phone `7381631a…` (`alias phone`, S26) lives on **Saga** (`saga.stegosaurus-aeolian.ts.net`), not Asgard (`f6e5da20…`). Don't open `~/projects/devspace` on `machine:asgard` for this — you'll resolve the wrong `phone` alias and get `0 devices` or `PhoneNoSession` for `direct-738…`. For phone work, open without `machine` or with `machine:saga` on a path that exists on Saga (e.g., `~` or `~/projects/devspace` via Saga). The repo path alone doesn't imply the phone host.",
  "- **To (re)connect:** `phone_connection(operation:connect, alias:phone)` — use `alias:phone` (default, S26) or `alias:tablet`. This mints `direct-{device_id}-{new_epoch}`. After a drop, **use `connect`, not `refresh`**. `refresh` requires a live `session_id` and returns `PhoneNoSession`/\"Not connected\" when the old session was evicted by `reconcile_direct_sessions()`.",
  "- **Device visible but session 0:** Companion says `Connected to Saga/Asgard` + `list_resources` shows `2 devices` but `status` shows `sessions=0` → just `connect` again. If `list_resources` shows `0 devices` while Companion says connected, the DevSpace gateway's `sky-cua-client mcp` bridge is stale after a `sky-cua-service` restart (stale `service.sock`). Gateway restart (Saga/Asgard) clears it — no re-pairing needed.",
  "- **Notifications/accessibility:** require `notification_listener_enabled:true`/`accessibility_enabled:true` in the `phone_connection` capability. After `connect`, `phone_notifications(alias:phone)` returns `backend companion` (fixed for Direct). Verified on Saga `738…` → 3 events.",
  "- **App packages — verify before launch:** `list_resources(surface:phone, resource:apps, session_id, include_system:false)` is paginated/truncated (293 on S26). Search the returned `apps[].package_name`/`label` — Thunderbird on this S26 is `net.thunderbird.android` (`label: Thunderbird`, `launchable:true`), not `org.mozilla.thunderbird` (not installed → `PhoneCompanionDirectDispatchFailed: rejected`). Use `phone_app_action(operation:launch, session_id, package_name:<actual>)`; check `list_resources` or `phone_app_list` first.",
  "- **Selector — never combine:** `phone_app_action`, `phone_notifications`, `phone_accessibility_tree`, `observe(phone)` etc expect **exactly one** of `session_id` / `device_id` / `alias` (e.g. `alias:phone`). Providing `alias` **and** `session_id` together is `InvalidRequest` (\"never combine them\"). After `phone_connection` gives you `direct-…-13`, call the next tool with **only** `session_id:direct-…-13` (or only `alias:phone` if you have no session yet), not both.",
  "- **Observe(phone) contract — don't mix surfaces:** `observe(surface:phone, session_id:direct-…)` (or `alias:phone`/`device_id`) allows **only** `surface` + one selector + `include_accessibility`/`include_notifications`/`backend`. Do **not** send `detail`/`element_*`/`target`/`tab_id`/`capture_timeout_ms`/`text_limit` — those belong to `surface:desktop`/`browser` and cause `InvalidRequest: do not mix fields from another surface` (e.g. `detail:full` is desktop-only). Correct: `{\"surface\":\"phone\",\"session_id\":\"direct-738…-13\",\"include_accessibility\":true}`. Gateway now strips stray desktop fields, but keep the call clean.",
  "- **App launch — wait for ready:** After `phone_app_action(launch)` returns `backend companion` with a `destination_appshot`, the app may briefly show `Connecting…` *in the accessibility tree* and not yet expose chat names (e.g., 2 unread in All Chats / 1 in Personal but no `Luke`). Poll `observe(surface:phone, session_id, include_accessibility:true)` until the in-tree `Connecting…` banner/text is gone and the `RecyclerView` chat rows appear — **poll every 1.5-2s, not tight-loop** (ChatGPT anti-loop will trip and you'll waste bandwidth; give Telegram time to settle). Usually 1-2 polls over 3-5s is enough; cap at ~5 polls / 10s then report not ready. **Window title may still say `Connecting…` even when `consistency:stable` + `semantics_complete:true` + `pixels_complete:true` and the list is fully visible** — Telegram keeps the Activity title stale. Don't wait for the title; the ready signal is a stable AppShot with the chat-list `RecyclerView` and the expected `Luke` row in `semantic_projection` + screenshot. Use that fresh `phone_snapshot_id` for the tap.",


  "- **List → visual grounding (Telegram etc):** If the target chat/row is already visible in the last `observe` (`Chat Preview` containers with `text`/`content_desc` like `Luke`), **do not open search**. Tree tells you *what* it is, screenshot/AppShot tells you *where* to tap. Use the row's `bounds` from the screenshot (center of hitbox) with the fresh `phone_snapshot_id`; don't trust a generic `clickable:false` container's accessibility bounds. Search is only for off-screen targets.",
  "- **Search field hygiene:** `Search Chats` is a placeholder/hint (`content_desc`/`hint`), not real `text`. Before typing `Luke`: tap field → ensure `focused:true` and `text==\"\"`, then `phone_keyboard(clear)` or `select_all` → `type_text`. Next `observe` must show `text==\"Luke\"`, not `Search ChatsLuke`. If you see the concatenated form, you typed into the hint state — clear and retry.",
  "- **Pointer — provenance, TTL & AppShotRequired:** `phone_pointer(operation:tap, session_id, x, y, phone_snapshot_id)` requires `phone_snapshot_id` from the *same* `observe` that produced the coordinates — **not** `appshot_id` (common copy-paste → `InvalidRequest: expects phone_snapshot_id`). `phone_snapshot_id`/`AppShot` expires after **30s action TTL** (also `AppShotRequired` with `fresh_appshot.snapshot_id` is the same signal) — this is **not** a validator error. If >30s elapsed since the `observe` or you get `AppShotRequired`/`snapshot expired`, don't sit idle: `observe(surface:phone, session_id, include_accessibility:true)` for a fresh `phone_snapshot_id` and retry the tap immediately with it. For bottom-up selection, always `observe` → tap/swipe with *fresh* id → `observe` → scroll up → repeat. Use `use_device_coordinates:true` only for raw device pixels.",

  "- **Other phone tools — per-operation allowlists:** `phone_keyboard` (`type_text`→`text`, `press_key`→`key`), `phone_app_action` (`launch`→`package_name`, `open_intent`→`intent_uri`), `phone_notification_action` (`open`/`dismiss`→`event_id`, `action`→`action_id`), `phone_accessibility_tree`/`phone_notifications`, `phone_connection` (`connect` vs `refresh`/`disconnect`), etc are all `additionalProperties:false` per branch. Don't mix fields from another operation or surface (`surface`/`tab_id`/`detail`/`target`/`include_*`/`backend` where not listed). Gateway now strips stray fields and maps `appshot_id→phone_snapshot_id` for pointer, but keep calls minimal.",
  "- **Polling hygiene — don't hammer the bridge:** ChatGPT has anti-loop detection and the bridge costs bandwidth. For any wait (launch, scroll, selection), poll `observe` every **1.5-2s** with backoff, not tight-loop. 3-5 polls over 5-10s is sane; 100 rapid `observe` calls will get throttled and waste your budget. If still not ready after ~10s, report not-ready and back off.",
  "- **Android Doze:** expect epoch churn every 30-90 min. Keep Companion foreground: `Settings → Apps → Sky Companion → Battery → Unrestricted`, `Pause if unused OFF`, keep Tailscale active. Then just `connect` again.",
].join("\n");
function phoneEphemeralAgentsFile(): { path: string; content: string } {
  return { path: PHONE_EPHEMERAL_AGENTS_PATH, content: PHONE_EPHEMERAL_AGENTS_CONTENT };
}
const PHONE_USE_SKILL_EPHEMERAL_PATH = ".devspace/skills/phone-use/SKILL.md";
function phoneUseSkillEphemeralFile(config: ServerConfig): { path: string; content: string } | null {
  const root = config.skyCua?.projectRoot ?? "";
  if (!root) return null;
  try {
    const p = `${root}/skills/phone-use/SKILL.md`;
    const content = readFileSync(p, "utf8");
    if (!content.trim()) return null;
    return { path: PHONE_USE_SKILL_EPHEMERAL_PATH, content };
  } catch {
    return null;
  }
}

function normalizePhoneSelectorForBridge(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  // sky-cua's rich validation (validation_schemas, not the flattened advertised schema) is strict:
  // phone tools require *exactly one* of session_id / device_id / alias / serial — "never combine them".
  // ChatGPT often sends both alias:phone and session_id:direct-… after a connect, which then hits
  // InvalidRequest before the phone RPC. Normalize by keeping the most specific selector.
  const has = (k: string) => typeof args[k] === "string" && (args[k] as string).trim() !== "";
  const isPhoneSelectorTool =
    toolName.startsWith("phone_") ||
    toolName === "observe" ||
    toolName === "capture_screen" ||
    toolName === "list_resources" ||
    toolName === "status";
  if (!isPhoneSelectorTool) return args;
  let out: Record<string, unknown> = { ...args };
  const selectors = ["session_id", "device_id", "alias", "serial"].filter(has);
  if (selectors.length > 1) {
    // Prefer session_id > device_id > alias > serial
    const order = ["session_id", "device_id", "alias", "serial"];
    let keep: string | undefined;
    for (const k of order) if (has(k)) { keep = k; break; }
    if (keep) {
      for (const k of selectors) if (k !== keep) delete out[k];
    }
  }
  // `observe(surface=phone)` is strict: exact_branch_schema allows only
  // surface + one selector + include_accessibility/include_notifications/backend.
  // `detail` (and desktop/browser fields like target/tab_id/element_*) belong to
  // the desktop/browser branches. ChatGPT copies them from examples and then
  // the phone branch is rejected as "do not mix fields from another surface".
  // Strip desktop/browser-only fields when the caller declared surface=phone so
  // the call reaches the device instead of failing validation.
  if (toolName === "observe" && out.surface === "phone") {
    const phoneAllowed = new Set([
      "surface",
      "session_id",
      "device_id",
      "alias",
      "serial",
      "include_accessibility",
      "include_notifications",
      "backend",
    ]);
    for (const k of Object.keys(out)) if (!phoneAllowed.has(k)) delete out[k];
  }
  if (toolName === "capture_screen" && out.surface === "phone") {
    const capsAllowed = new Set(["surface", "session_id", "device_id", "alias", "serial", "backend"]);
    for (const k of Object.keys(out)) if (!capsAllowed.has(k)) delete out[k];
  }
  // `phone_pointer` is strict: tap requires x/y + phone_snapshot_id OR use_device_coordinates, swipe requires start/end. ChatGPT sometimes copies observe fields (surface/backend/detail) or sends appshot_id instead of phone_snapshot_id. Strip non-allowed fields so the call reaches the device.
  if (toolName === "phone_pointer") {
    const op = out.operation;
    const baseAllowed = new Set(["operation", "session_id", "device_id", "alias", "serial", "appshot_id", "phone_snapshot_id", "use_device_coordinates"]);
    let allowed: Set<string>;
    if (op === "tap") allowed = new Set([...baseAllowed, "x", "y"]);
    else if (op === "swipe") allowed = new Set([...baseAllowed, "start_x", "start_y", "end_x", "end_y", "duration_ms"]);
    else allowed = baseAllowed;
    for (const k of Object.keys(out)) if (!allowed.has(k)) delete out[k];
    // Common copy-paste: appshot_id sent where phone_snapshot_id required. If phone_snapshot_id missing, fall back to appshot_id (they are often the same UUID from observe).
    const hasPhoneSnapshot = typeof out.phone_snapshot_id === "string" && (out.phone_snapshot_id as string).trim() !== "";
    const hasAppshot = typeof out.appshot_id === "string" && (out.appshot_id as string).trim() !== "";
    if (!hasPhoneSnapshot && hasAppshot) {
      out.phone_snapshot_id = out.appshot_id;
    }
  }
  // Other phone tools are also strict per-operation (exact_branch_schema + additionalProperties:false). Gateway advertised schema is flattened and permissive, so stray fields (surface, tab_id, detail, etc) slip through and hit InvalidRequest on the rich validation. Strip to per-operation allowlists.
  if (toolName === "phone_keyboard") {
    const op = out.operation;
    const base = new Set(["operation", "session_id", "device_id", "alias", "serial", "appshot_id"]);
    let allowed: Set<string>;
    if (op === "type_text") allowed = new Set([...base, "text"]);
    else if (op === "press_key") allowed = new Set([...base, "key"]);
    else allowed = new Set([...base, "text", "key"]);
    for (const k of Object.keys(out)) if (!allowed.has(k)) delete out[k];
  }
  if (toolName === "phone_app_action") {
    const op = out.operation;
    const base = new Set(["operation", "session_id", "device_id", "alias", "serial"]);
    let allowed: Set<string>;
    if (op === "launch") allowed = new Set([...base, "package_name"]);
    else if (op === "open_intent") allowed = new Set([...base, "intent_uri", "package_name"]);
    else allowed = new Set([...base, "package_name", "intent_uri"]);
    for (const k of Object.keys(out)) if (!allowed.has(k)) delete out[k];
  }
  if (toolName === "phone_notification_action") {
    const op = out.operation;
    const base = new Set(["operation", "session_id", "device_id", "alias", "serial", "appshot_id", "event_id"]);
    let allowed: Set<string>;
    if (op === "action") allowed = new Set([...base, "action_id"]);
    else allowed = base; // open/dismiss need only event_id
    for (const k of Object.keys(out)) if (!allowed.has(k)) delete out[k];
  }
  if (toolName === "phone_accessibility_tree" || toolName === "phone_notifications") {
    const allowed = new Set(["session_id", "device_id", "alias", "serial", "node_limit", "limit"]);
    // phone_notifications uses limit, accessibility_tree uses node_limit — keep both, strip the other + any surface/detail
    for (const k of Object.keys(out)) if (!allowed.has(k)) delete out[k];
  }
  if (toolName === "phone_app_force_stop") {
    const allowed = new Set(["session_id", "device_id", "alias", "serial", "package_name", "appshot_id"]);
    for (const k of Object.keys(out)) if (!allowed.has(k)) delete out[k];
  }
  if (toolName === "phone_connection") {
    const op = out.operation;
    let allowed: Set<string>;
    if (op === "connect") allowed = new Set(["operation", "serial", "device_id", "alias", "backend", "install_companion", "start_scrcpy"]);
    else if (op === "disconnect") allowed = new Set(["operation", "session_id", "device_id", "alias", "serial", "keep_wireless"]);
    else if (op === "refresh") allowed = new Set(["operation", "session_id", "device_id", "alias", "serial"]);
    else allowed = new Set(["operation", "serial", "device_id", "alias", "session_id", "backend", "install_companion", "start_scrcpy", "keep_wireless"]);
    for (const k of Object.keys(out)) if (!allowed.has(k)) delete out[k];
  }
  if (toolName === "phone_setup") {
    const op = out.operation;
    let allowed: Set<string>;
    if (op === "create_enrollment") allowed = new Set(["operation"]);
    else if (op === "install_companion") allowed = new Set(["operation", "session_id", "device_id", "alias", "serial", "force_reinstall", "allow_downgrade"]);
    else if (op === "open_settings") allowed = new Set(["operation", "session_id", "device_id", "alias", "serial", "screen", "package_name"]);
    else allowed = new Set(["operation", "session_id", "device_id", "alias", "serial", "screen", "package_name", "force_reinstall", "allow_downgrade"]);
    for (const k of Object.keys(out)) if (!allowed.has(k)) delete out[k];
  }
  if (toolName === "list_resources" && out.surface === "phone") {
    // Phone list_resources: surface + resource (+ session_id for apps/current_app). Strip browser/desktop extras like target/tab_id/limit-as-browser
    const allowed = new Set(["surface", "resource", "session_id", "device_id", "alias", "serial", "include_system", "filter", "limit", "query"]);
    for (const k of Object.keys(out)) if (!allowed.has(k)) delete out[k];
  }
  if (toolName === "status" && (out.component === "phone" || out.component === "phone_companion")) {
    const allowed = new Set(["component", "refresh_devices", "session_id", "device_id", "alias", "serial"]);
    for (const k of Object.keys(out)) if (!allowed.has(k)) delete out[k];
  }
  // Generic fallback for remaining phone_* tools (content/clipboard/editor/camera/storage/install) that weren't explicitly allowlisted above:
  // strip obvious cross-surface contaminants that often leak from observe/desktop examples. Keep per-tool allowlists permissive above.
  if (toolName.startsWith("phone_") && toolName !== "phone_pointer" && toolName !== "phone_keyboard" && toolName !== "phone_app_action" && toolName !== "phone_notification_action" && toolName !== "phone_accessibility_tree" && toolName !== "phone_notifications" && toolName !== "phone_app_force_stop" && toolName !== "phone_connection" && toolName !== "phone_setup") {
    const crossSurface = new Set(["surface", "resource", "component", "tab_id", "target", "detail", "text_limit", "capture_timeout_ms", "element_query", "element_offset", "element_limit", "window_id", "pid", "tty", "title", "app_id", "wm_class", "include_accessibility", "include_notifications", "backend"]);
    for (const k of Object.keys(out)) if (crossSurface.has(k)) delete out[k];
  }
  return out;
}

function serverInstructions(config: ServerConfig, toolNames: ToolNames, effectiveDisabled?: Set<string>): string {
  const disabled = effectiveDisabled ?? config.disabledCapabilities ?? new Set<string>();
  const skyDisabled = isCapabilityDisabled(disabled, "sky-cua");
  const inspection = config.minimalTools
    ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `
    : `${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} provide structured file inspection when useful. `;

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";

  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. When sky-cua phone is enabled, ${PHONE_EPHEMERAL_AGENTS_PATH} and ${PHONE_USE_SKILL_EPHEMERAL_PATH} are auto-injected on open: the former has the Direct epoch/session lifecycle, the latter is the full phone-use skill (AppShot/snapshot/execution contract). `;

  const showChanges =
    config.widgets === "changes"
      ? " After creating, editing, or overwriting files, call show_changes once after the related file changes are complete so the user can see the aggregate diff."
      : "";

  const skyCua = skyDisabled
    ? ""
    : " sky-cua desktop/browser/phone (sky-cua) tools are available: desktop/browser observe/capture/input plus phone Companion (aliases phone=default + tablet) via status/list_resources(surface=phone)/phone_connection/observe(surface=phone)/phone_pointer etc. Phone sessions are epoch-fenced — use connect, not refresh, after a drop; list_resources is the ground truth. When a task matches browser-use/computer-use/phone-use, read that SKILL.md before acting and follow its AppShot/phone_snapshot_id contract.";

  return `Use DevSpace to work directly in local development workspaces. Call ${toolNames.openWorkspace} once per project folder to obtain a workspaceId. Reuse that workspaceId for later tools in the same folder. The open result reports canonical path, writability, Git, shell, terminal, user-systemd, and privilege capabilities; heed its warnings. Use mode=\"isolated\" when a source checkout or its Git metadata is read-only and writable independent work is required. Use workspace_status to refresh capabilities. Prefer terminal_start/read/write/resize/status/close for installers, builds, upgrades, long test suites, interactive processes, and any work that should survive an MCP or network interruption; use the shell tool for bounded non-interactive commands. Close the workspace when the workstream is complete. ${agentsMd}${skills}${inspection}Use ${toolNames.read}, ${toolNames.edit}, ${toolNames.write}, and ${toolNames.shell} in whatever combination completes the task most effectively. ${toolNames.shell} provides direct, unfiltered local Bash execution and may be root-capable according to host policy. File tools enforce canonical configured root policy, but shell and terminal tools can perform any action available to the service account. When asked to change, build, or fix something, make the in-scope changes and run relevant validation instead of stopping at instructions or recommendations.${skyCua}${showChanges}`;
}
function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const workspaceCapabilitiesOutputSchema = z.object({
  logicalRoot: z.string(),
  canonicalRoot: z.string(),
  fileAccess: z.enum(["read-only", "read-write"]),
  mountReadOnly: z.boolean(),
  git: z.object({
    repositoryRoot: z.string(),
    commonDirectory: z.string(),
    head: z.string(),
    branch: z.string().optional(),
    dirty: z.boolean(),
    worktreeAvailable: z.boolean(),
    cloneAvailable: z.boolean(),
    gitMetadataWritable: z.boolean(),
  }).optional(),
  runtime: z.object({
    shellPath: z.string(),
    shellMode: z.enum(["service", "login"]),
    tmux: z.boolean(),
    opencode: z.string().optional(),
    userSystemd: z.boolean(),
    privilegeEscalation: z.enum(["unavailable", "available", "unknown"]),
    filteredSecretNames: z.array(z.string()),
  }),
  warnings: z.array(z.string()),
});

const terminalOutputSchema = z.object({
  terminalId: z.string(),
  workspaceId: z.string(),
  commandSummary: z.string(),
  workingDirectory: z.string(),
  status: z.enum(["active", "closed", "dead"]),
  cols: z.number().int(),
  rows: z.number().int(),
  retainOnWorkspaceClose: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  closedAt: z.string().optional(),
  persistentAcrossDevspaceRestart: z.boolean(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function compactSummary(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(
  config: ServerConfig,
  entry: WorkspaceAppManifestEntry,
): string {
  const baseUrl = assetBaseUrl(config);
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): AppCsp {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function openAiWidgetCsp(config: ServerConfig): OpenAiWidgetCsp {
  const csp = appCsp(config);
  return {
    resource_domains: csp.resourceDomains,
    connect_domains: csp.connectDomains,
  };
}

function contentSecurityPolicy(config: ServerConfig, options: { frameAncestors?: string } = {}): string {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  const directives = [
    ["default-src", "'none'"],
    ["base-uri", "'self'"],
    // The approval page must be submittable from embedded webviews (ChatGPT
    // Apps, etc.) whose effective origin differs from the public base URL.
    // 'self' + host-source still gets blocked in those contexts, and
    // default-src 'none' would block forms entirely if form-action were
    // omitted — so allow form submission outright. The single form is the
    // owner-password approval; the OAuth flow itself is protected by the
    // owner token, PKCE, and resource checks.
    ["form-action", "*"],
    ["object-src", "'none'"],
    ["script-src", "'self'", "'wasm-unsafe-eval'"],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", publicBaseUrl],
    ["font-src", "'self'", "data:", publicBaseUrl],
    ["connect-src", "'self'", publicBaseUrl],
    ["media-src", "'self'", publicBaseUrl],
    ["worker-src", "'none'"],
    ["frame-src", "'none'"],
  ];

  if (options.frameAncestors) {
    directives.splice(3, 0, ["frame-ancestors", options.frameAncestors]);
  }

  return directives.map(([name, ...values]) => `${name} ${values.join(" ")}`).join("; ");
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setSecurityHeaders(config: ServerConfig, res: Response): void {
  res.setHeader("Content-Security-Policy", contentSecurityPolicy(config, { frameAncestors: "'none'" }));
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function setAssetHeaders(config: ServerConfig, res: Response): void {
  res.setHeader("Content-Security-Policy", contentSecurityPolicy(config));
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(
  entry: WorkspaceAppManifestEntry,
): Promise<void> {
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

async function routeGatewayTool(
  router: GatewayExecutionRouter,
  canonicalTool: CanonicalToolName,
  publicTool: string,
  args: Record<string, unknown>,
  extra: { requestId: string | number; signal: AbortSignal },
) {
  const routed = await router.execute(canonicalTool, args, {
    requestId: String(extra.requestId).slice(0, 128),
    signal: extra.signal,
  });
  return gatewayPublicResult(routed, canonicalTool, publicTool, args);
}

async function routeStandaloneTool(
  executor: LocalExecutor | undefined,
  canonicalTool: CanonicalToolName,
  publicTool: string,
  args: Record<string, unknown>,
  extra: { requestId: string | number; signal: AbortSignal },
) {
  if (!executor) throw new Error("Standalone executor is unavailable in gateway mode");
  const result = await executor.execute(canonicalTool, args as never, {
    requestId: String(extra.requestId).slice(0, 128),
    signal: extra.signal,
  });
  const workspaceId = canonicalTool === "open_workspace"
    ? String(result.structuredContent?.workspaceId ?? "")
    : String(args.workspaceId ?? "");
  return publicExecutorResult({ result, publicWorkspaceId: workspaceId }, canonicalTool, publicTool, args);
}

export function gatewayPublicResult(
  routed: RoutedExecution,
  canonicalTool: CanonicalToolName,
  publicTool: string,
  args: Record<string, unknown>,
) {
  return publicExecutorResult(routed, canonicalTool, publicTool, args);
}

function publicExecutorResult(
  routed: { result: RoutedExecution["result"]; machine?: RoutedExecution["machine"]; publicWorkspaceId: string },
  canonicalTool: CanonicalToolName,
  publicTool: string,
  args: Record<string, unknown>,
) {
  const result = routed.result;
  const content = result.content as ToolContent[];
  const executorStructured = result.structuredContent ?? {};
  const resultText = contentText(content);
  const structuredTools = new Set<CanonicalToolName>([
    "open_workspace", "workspace_status", "close_workspace", "show_changes",
    "terminal_start", "terminal_read", "terminal_write", "terminal_resize", "terminal_status", "terminal_close",
  ]);
  const structuredContent = structuredTools.has(canonicalTool)
    ? executorStructured
    : canonicalTool === "edit_file"
      ? { status: "applied", result: resultText }
      : { result: resultText };
  const details = result.details && typeof result.details === "object"
    ? result.details as Record<string, unknown>
    : {};
  const summary = canonicalTool === "show_changes"
    ? ((executorStructured.summary as Record<string, unknown> | undefined) ?? {})
    : {
        ...textSummary(content),
        ...(canonicalTool === "run_shell" && typeof args.command === "string" ? { command: compactSummary(args.command) } : {}),
        ...((canonicalTool === "grep_files" || canonicalTool === "find_files") && typeof args.pattern === "string" ? { pattern: compactSummary(args.pattern) } : {}),
      };
  const card = {
    workspaceId: routed.publicWorkspaceId,
    machine: routed.machine,
    path: typeof args.path === "string" ? args.path : undefined,
    root: typeof executorStructured.root === "string" ? executorStructured.root : undefined,
    canonicalRoot: typeof executorStructured.canonicalRoot === "string" ? executorStructured.canonicalRoot : undefined,
    capabilities: executorStructured.capabilities,
    worktree: executorStructured.worktree,
    terminal: executorStructured.terminal,
    terminals: executorStructured.terminals,
    terminalOutput: executorStructured.output,
    truncated: executorStructured.truncated,
    status: typeof structuredContent.status === "string" ? structuredContent.status : undefined,
    summary,
    files: Array.isArray(executorStructured.files) ? executorStructured.files : undefined,
    agentsFiles: Array.isArray(executorStructured.agentsFiles) ? executorStructured.agentsFiles : undefined,
    availableAgentsFiles: Array.isArray(executorStructured.availableAgentsFiles) ? executorStructured.availableAgentsFiles : undefined,
    skills: Array.isArray(executorStructured.skills) ? executorStructured.skills : undefined,
    skillDiagnostics: Array.isArray(executorStructured.skillDiagnostics) ? executorStructured.skillDiagnostics : undefined,
    instruction: typeof executorStructured.instruction === "string" ? executorStructured.instruction : undefined,
    payload: {
      content,
      diff: typeof details.diff === "string" ? details.diff : undefined,
      patch: typeof details.patch === "string"
        ? details.patch
        : typeof executorStructured.patch === "string" ? executorStructured.patch : undefined,
    },
  };
  return {
    content,
    structuredContent,
    _meta: { tool: publicTool, card },
    ...(result.isError ? { isError: true } : {}),
  };
}

async function createMcpServer(
  config: ServerConfig,
  executor: LocalExecutor | undefined,
  gatewayRouter?: GatewayExecutionRouter,
  effectiveDisabled?: Set<string>,
): Promise<McpServer> {
  const effective = effectiveDisabled ?? config.disabledCapabilities ?? new Set<string>();
  const toolNames = toolNamesFor(config);
  const workspaceAppManifestEntry =
    config.widgets === "off" ? undefined : getWorkspaceAppManifestEntry();
  const workspaceAppUri = workspaceAppManifestEntry
    ? workspaceAppResourceUri(workspaceAppManifestEntry)
    : undefined;
  const server = new McpServer(
    {
      name: "devspace",
      title: "DevSpace",
      version: DEVSPACE_VERSION,
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: serverInstructions(config, toolNames, effective),
    },
  );

  if (workspaceAppManifestEntry && workspaceAppUri) {
    registerAppResource(
      server,
      "DevSpace Workspace Card",
      workspaceAppUri,
      {
        description: "Interactive card for DevSpace workspace activity and file diffs.",
        _meta: {
          ui: {
            csp: appCsp(config),
          },
          "openai/widgetCSP": openAiWidgetCsp(config),
        },
      },
      async () => {
        await assertWorkspaceAppAssets(workspaceAppManifestEntry);
        return {
          contents: [
            {
              uri: workspaceAppUri,
              mimeType: RESOURCE_MIME_TYPE,
              text: workspaceAppHtml(config, workspaceAppManifestEntry),
              _meta: {
                ui: {
                  csp: appCsp(config),
                },
                "openai/widgetCSP": openAiWidgetCsp(config),
              },
            },
          ],
        };
      },
    );
  }

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open a local project directory as a coding workspace. Call this once per project folder and reuse the returned workspaceId. The result reports logical/canonical paths, real filesystem and Git writability, runtime capabilities, warnings, instructions, and skills. Active checkout sessions are reused unless fresh=true. Use mode=\"worktree\" to require a Git worktree or mode=\"isolated\" to create a writable worktree/clone automatically. Missing checkout directories require create=true.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a local project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree", "isolated"])
          .optional()
          .describe(
            "Defaults to checkout. Use worktree to require a managed Git worktree. Use isolated to create a writable worktree or independent clone automatically.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
        create: z
          .boolean()
          .optional()
          .describe("Defaults to false. Set true only when the requested checkout directory should be created explicitly."),
        fresh: z
          .boolean()
          .optional()
          .describe("Checkout mode only. Set true to force a separate workspace session and review baseline instead of reusing an active checkout."),
        machine: z
          .string()
          .optional()
          .describe("Gateway only: exact configured machine ID or alias. Omission selects the canonical machine."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        canonicalRoot: z.string(),
        mode: z.enum(["checkout", "worktree", "isolated"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            sourceCanonicalRoot: z.string(),
            strategy: z.enum(["worktree", "clone"]),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema),
        skills: z.array(workspaceSkillOutputSchema),
        skillDiagnostics: z.array(z.unknown()),
        capabilities: workspaceCapabilitiesOutputSchema,
        instruction: z.string(),
        machine: z.object({ id: z.string(), displayName: z.string() }).optional(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace_open", workspaceAppUri),
      annotations: toolAnnotationsForProfile(config.annotationProfile, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
    },
    (async (input: unknown, extra: unknown) => {
      const { path, mode, baseRef, create, fresh, machine } = input as { path: string; mode?: string; baseRef?: string; create?: boolean; fresh?: boolean; machine?: string };
      const ex = extra as { requestId: string | number; signal: AbortSignal };
      const res = gatewayRouter
        ? await routeGatewayTool(gatewayRouter, "open_workspace", "open_workspace", { path, mode, baseRef, create, fresh, machine }, ex)
        : (() => { if (machine !== undefined) throw new Error("machine selection is available only in gateway mode"); return routeStandaloneTool(executor, "open_workspace", "open_workspace", { path, mode, baseRef, create, fresh }, ex); })();
      const awaited = await res;
      if (isSkyCuaDisabled(effective)) {
        const sc = (awaited as unknown as { structuredContent?: { skills?: unknown[]; skillDiagnostics?: unknown[] } }).structuredContent;
        if (sc?.skills) sc.skills = filterSkyCuaSkillsForEffective(sc.skills, effective, config.skyCua?.projectRoot) as unknown as never;
        if (sc?.skillDiagnostics) sc.skillDiagnostics = filterSkyCuaSkillsForEffective(sc.skillDiagnostics, effective, config.skyCua?.projectRoot) as unknown as never;
        const card = (awaited as unknown as { _meta?: { card?: { skills?: unknown[] } } })._meta?.card;
        if (card?.skills) card.skills = filterSkyCuaSkillsForEffective(card.skills, effective, config.skyCua?.projectRoot) as unknown as never;
      } else {
        // Ephemeral phone lifecycle guidance + full phone-use skill: injected as AGENTS so every workspace open is fully loaded without an extra read.
        const sc = (awaited as unknown as {
          structuredContent?: {
            agentsFiles?: Array<{ path: string; content: string }>;
            availableAgentsFiles?: Array<{ path: string }>;
            instruction?: string;
            skills?: unknown[];
          };
        }).structuredContent;
        const card = (awaited as unknown as { _meta?: { card?: { agentsFiles?: Array<{ path: string; content: string }>; availableAgentsFiles?: Array<{ path: string }>; instruction?: string } } })._meta?.card;
        const phoneFile = phoneEphemeralAgentsFile();
        const phoneSkillFile = phoneUseSkillEphemeralFile(config);
        const inject = (target: { agentsFiles?: Array<{ path: string; content: string }>; availableAgentsFiles?: Array<{ path: string }>; instruction?: string } | undefined) => {
          if (!target) return;
          const filesToInject: Array<{ path: string; content: string }> = [phoneFile];
          if (phoneSkillFile) filesToInject.push(phoneSkillFile);
          for (const f of filesToInject) {
            if (Array.isArray(target.agentsFiles)) {
              if (!target.agentsFiles.some((existing) => existing.path === f.path)) target.agentsFiles.push(f);
            } else target.agentsFiles = [f];
            if (Array.isArray(target.availableAgentsFiles)) {
              if (!target.availableAgentsFiles.some((existing) => existing.path === f.path)) target.availableAgentsFiles.push({ path: f.path });
            } else target.availableAgentsFiles = [{ path: f.path }];
          }
          if (typeof target.instruction === "string") {
            target.instruction += "\n\n" + PHONE_EPHEMERAL_AGENTS_CONTENT;
            if (phoneSkillFile) target.instruction += `\n\nPhone-use skill is also auto-injected as ${phoneSkillFile.path} — read it for the full AppShot/snapshot/execution contract.`;
          }
        };
        inject(sc);
        inject(card as unknown as never);
      }
      return awaited;
    }) as unknown as never,
  );

  if (gatewayRouter && config.widgets === "workspace") {
    registerAppTool(
      server,
      "workspace_activity",
      {
        title: "Workspace activity",
        description: "App-only incremental activity feed for the live DevSpace workspace card.",
        inputSchema: {
          workspaceId: z.string(),
          afterSeq: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          waitMs: z.number().int().min(0).max(30_000).optional(),
        },
        outputSchema: {
          events: z.array(z.object({
            seq: z.number().int().positive(),
            workspaceId: z.string(),
            operationId: z.string(),
            tool: z.string(),
            machine: z.object({ id: z.string(), displayName: z.string() }),
            status: z.enum(["running", "success", "error"]),
            label: z.string(),
            detail: z.string().optional(),
            startedAt: z.string(),
            durationMs: z.number().int().nonnegative().optional(),
            createdAt: z.string(),
          })),
          latestSeq: z.number().int().nonnegative(),
          totalOperations: z.number().int().nonnegative(),
        },
        ...appOnlyToolDescriptorMeta(),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ workspaceId, afterSeq, limit, waitMs }, extra) => {
        const page = await gatewayRouter.waitForActivity(
          workspaceId,
          afterSeq ?? 0,
          limit ?? 100,
          waitMs ?? 20_000,
          extra.signal,
        );
        return {
          content: [{ type: "text", text: `${page.events.length} workspace activity events` }],
          structuredContent: page,
        };
      },
    );
  }

  registerAppTool(
    server,
    "workspace_status",
    {
      title: "Workspace status",
      description: "Refresh and report the real filesystem, Git, shell, terminal, user-systemd, and privilege capabilities of an open workspace.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        canonicalRoot: z.string(),
        mode: z.enum(["checkout", "worktree", "isolated"]),
        capabilities: workspaceCapabilitiesOutputSchema,
        terminals: z.array(terminalOutputSchema),
        review: z.object({ initialized: z.boolean(), diagnostic: z.string().optional() }),
        machine: z.object({ id: z.string(), displayName: z.string() }).optional(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace", workspaceAppUri),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }, extra) => {
      if (gatewayRouter) return routeGatewayTool(gatewayRouter, "workspace_status", "workspace_status", { workspaceId }, extra);
      return routeStandaloneTool(executor, "workspace_status", "workspace_status", { workspaceId }, extra);
    },
  );

  registerAppTool(
    server,
    "close_workspace",
    {
      title: "Close workspace",
      description: "Close an open workspace, stop non-retained terminals, remove its review state, and remove a clean managed checkout. Dirty managed work is retained and reported.",
      inputSchema: { workspaceId: z.string().describe("Workspace identifier returned by open_workspace.") },
      outputSchema: {
        workspace: z.object({
          workspaceId: z.string(),
          mode: z.enum(["checkout", "worktree", "isolated"]),
          closed: z.boolean(),
          removed: z.boolean(),
          retainedPath: z.string().optional(),
          dirty: z.boolean(),
          reason: z.string().optional(),
        }),
        terminals: z.object({ closed: z.array(z.string()), retained: z.array(z.string()) }),
      },
      ...toolWidgetDescriptorMeta(config, "workspace", workspaceAppUri),
      annotations: toolAnnotationsForProfile(config.annotationProfile, { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false }),
    },
    async ({ workspaceId }, extra) => gatewayRouter
      ? routeGatewayTool(gatewayRouter, "close_workspace", "close_workspace", { workspaceId }, extra)
      : routeStandaloneTool(executor, "close_workspace", "close_workspace", { workspaceId }, extra),
  );

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read a file inside an open workspace. Use this for file inspection instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read", workspaceAppUri),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }, extra) => {
      const p = (input as { path?: string }).path;
      if (p === PHONE_EPHEMERAL_AGENTS_PATH && !isSkyCuaDisabled(effective)) {
        const text = PHONE_EPHEMERAL_AGENTS_CONTENT;
        return {
          content: [{ type: "text", text }],
          structuredContent: { result: text },
        } as unknown as never;
      }
      if (p === PHONE_USE_SKILL_EPHEMERAL_PATH && !isSkyCuaDisabled(effective)) {
        const file = phoneUseSkillEphemeralFile(config);
        const text = file?.content ?? "";
        if (text) {
          return {
            content: [{ type: "text", text }],
            structuredContent: { result: text },
          } as unknown as never;
        }
      }
      if (gatewayRouter) return routeGatewayTool(gatewayRouter, "read_file", toolNames.read, { workspaceId, ...input }, extra);
      return routeStandaloneTool(executor, "read_file", toolNames.read, { workspaceId, ...input }, extra);},
  );

  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description:
        `Create or completely overwrite a file inside an open workspace. Prefer ${toolNames.edit} for targeted changes to existing files. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write", workspaceAppUri),
      annotations: toolAnnotationsForProfile(config.annotationProfile, WRITE_TOOL_ANNOTATIONS, { idempotentHint: true }),
    },
    async ({ workspaceId, ...input }, extra) => {
      if (gatewayRouter) return routeGatewayTool(gatewayRouter, "write_file", toolNames.write, { workspaceId, ...input }, extra);
      return routeStandaloneTool(executor, "write_file", toolNames.write, { workspaceId, ...input }, extra);},
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description:
        `Edit one file inside an open workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      ...toolWidgetDescriptorMeta(config, "edit", workspaceAppUri),
      annotations: toolAnnotationsForProfile(config.annotationProfile, EDIT_TOOL_ANNOTATIONS, { idempotentHint: true }),
    },
    async ({ workspaceId, ...input }, extra) => {
      if (gatewayRouter) return routeGatewayTool(gatewayRouter, "edit_file", toolNames.edit, { workspaceId, ...input }, extra);
      return routeStandaloneTool(executor, "edit_file", toolNames.edit, { workspaceId, ...input }, extra);},
  );

  if (config.widgets === "changes" || gatewayRouter) {
    registerAppTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description:
          "Show aggregate file changes in an open workspace since the last shown checkpoint or since the workspace was opened. After you create, edit, or overwrite files, call this once when the related file changes are complete so the user can inspect the combined diff.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          since: z
            .enum(["last_shown", "workspace_open"])
            .optional()
            .describe("Defaults to last_shown. Use workspace_open to compare against the initial open_workspace checkpoint."),
          markReviewed: z
            .boolean()
            .optional()
            .describe("Defaults to true. When true, advances the last shown checkpoint to the current workspace state."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "show_changes", workspaceAppUri),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, since, markReviewed }, extra) => {
        if (gatewayRouter) return routeGatewayTool(gatewayRouter, "show_changes", "show_changes", { workspaceId, since, markReviewed }, extra);
        return routeStandaloneTool(executor, "show_changes", "show_changes", { workspaceId, since, markReviewed }, extra);},
    );
  }

  if (!config.minimalTools) {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: config.toolNaming === "short" ? "Grep" : "Grep files",
        description:
          "Search file contents inside an open workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("Search pattern."),
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root.",
            ),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search", workspaceAppUri),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }, extra) => {
        if (gatewayRouter) return routeGatewayTool(gatewayRouter, "grep_files", toolNames.grep, { workspaceId, ...input }, extra);
        return routeStandaloneTool(executor, "grep_files", toolNames.grep, { workspaceId, ...input }, extra);},
    );

    registerAppTool(
      server,
      toolNames.glob,
      {
        title: config.toolNaming === "short" ? "Glob" : "Find files",
        description:
          "Find files by glob pattern inside an open workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("File glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search", workspaceAppUri),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }, extra) => {
        if (gatewayRouter) return routeGatewayTool(gatewayRouter, "find_files", toolNames.glob, { workspaceId, ...input }, extra);
        return routeStandaloneTool(executor, "find_files", toolNames.glob, { workspaceId, ...input }, extra);},
    );

    registerAppTool(
      server,
      toolNames.ls,
      {
        title: config.toolNaming === "short" ? "Ls" : "List directory",
        description:
          "List a directory inside an open workspace. Use this for directory inspection before reading files. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory", workspaceAppUri),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }, extra) => {
        if (gatewayRouter) return routeGatewayTool(gatewayRouter, "list_directory", toolNames.ls, { workspaceId, ...input }, extra);
        return routeStandaloneTool(executor, "list_directory", toolNames.ls, { workspaceId, ...input }, extra);},
    );
  }

  registerAppTool(
    server,
    toolNames.shell,
    {
      title: config.toolNaming === "short" ? "Bash" : "Run shell",
      description: config.minimalTools
        ? `Execute a bounded non-interactive Bash command directly on the DevSpace host. Use it for inspection, targeted changes, dependency commands, quick builds/tests, git, and system commands. Prefer terminal_start for installers, substantial builds, upgrades, long test suites, or anything that should survive an MCP/network interruption. The command runs unfiltered as the DevSpace service account without a terminal or input stream. In minimal tool mode, use command-line tools such as rg, find, and ls for inspection. Returns combined stdout and stderr; a nonzero exit or timeout is an error.`
        : `Execute a bounded non-interactive Bash command directly on the DevSpace host. Use it for inspection, targeted changes, dependency commands, quick builds/tests, git, and system commands. Prefer terminal_start for installers, substantial builds, upgrades, long test suites, or anything that should survive an MCP/network interruption. The command runs unfiltered as the DevSpace service account without a terminal or input stream. Returns combined stdout and stderr; a nonzero exit or timeout is an error.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        command: z
          .string()
          .describe("Bash command to execute directly on the DevSpace host."),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Starting directory relative to the workspace root. Defaults to the workspace root; it does not confine the command to that directory.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell", workspaceAppUri),
      annotations: toolAnnotationsForProfile(config.annotationProfile, SHELL_TOOL_ANNOTATIONS),
    },
    async ({ workspaceId, workingDirectory, ...input }, extra) => {
      if (gatewayRouter) return routeGatewayTool(gatewayRouter, "run_shell", toolNames.shell, { workspaceId, workingDirectory, ...input }, extra);
      return routeStandaloneTool(executor, "run_shell", toolNames.shell, { workspaceId, workingDirectory, ...input }, extra);},
  );

  registerAppTool(
    server,
    "terminal_start",
    {
      title: "Start terminal",
      description: "Start a persistent terminal session in an open workspace. Prefer this for installers, substantial builds, upgrades, long test suites, interactive programs, and processes that must keep running across MCP or network interruptions. The process is detached from this MCP request and may survive DevSpace restart when user-systemd is available.",
      inputSchema: {
        workspaceId: z.string(), command: z.string().min(1), workingDirectory: z.string().optional(),
        cols: z.number().int().min(40).max(400).optional(), rows: z.number().int().min(10).max(200).optional(),
        shellMode: z.enum(["service", "login"]).optional(), retainOnWorkspaceClose: z.boolean().optional(),
      },
      outputSchema: { terminal: terminalOutputSchema },
      ...toolWidgetDescriptorMeta(config, "shell", workspaceAppUri),
      annotations: toolAnnotationsForProfile(config.annotationProfile, SHELL_TOOL_ANNOTATIONS),
    },
    async (input, extra) => gatewayRouter
      ? routeGatewayTool(gatewayRouter, "terminal_start", "terminal_start", input, extra)
      : routeStandaloneTool(executor, "terminal_start", "terminal_start", input, extra),
  );

  registerAppTool(
    server,
    "terminal_read",
    {
      title: "Read terminal",
      description: "Capture the current screen or bounded history from a persistent terminal session.",
      inputSchema: { workspaceId: z.string(), terminalId: z.string(), mode: z.enum(["screen", "history"]).optional(), lines: z.number().int().min(1).max(2000).optional() },
      outputSchema: { terminal: terminalOutputSchema, output: z.string(), truncated: z.boolean() },
      ...toolWidgetDescriptorMeta(config, "shell", workspaceAppUri),
      annotations: { readOnlyHint: true },
    },
    async (input, extra) => gatewayRouter
      ? routeGatewayTool(gatewayRouter, "terminal_read", "terminal_read", input, extra)
      : routeStandaloneTool(executor, "terminal_read", "terminal_read", input, extra),
  );

  registerAppTool(
    server,
    "terminal_write",
    {
      title: "Write terminal",
      description: "Send literal text, control keys, or Enter to a persistent terminal session.",
      inputSchema: { workspaceId: z.string(), terminalId: z.string(), text: z.string().optional(), keys: z.array(z.string()).max(32).optional(), submit: z.boolean().optional() },
      outputSchema: { terminal: terminalOutputSchema },
      ...toolWidgetDescriptorMeta(config, "shell", workspaceAppUri),
      annotations: toolAnnotationsForProfile(config.annotationProfile, SHELL_TOOL_ANNOTATIONS),
    },
    async (input, extra) => gatewayRouter
      ? routeGatewayTool(gatewayRouter, "terminal_write", "terminal_write", input, extra)
      : routeStandaloneTool(executor, "terminal_write", "terminal_write", input, extra),
  );

  registerAppTool(
    server,
    "terminal_resize",
    {
      title: "Resize terminal",
      description: "Resize a persistent terminal session.",
      inputSchema: { workspaceId: z.string(), terminalId: z.string(), cols: z.number().int().min(40).max(400), rows: z.number().int().min(10).max(200) },
      outputSchema: { terminal: terminalOutputSchema },
      ...toolWidgetDescriptorMeta(config, "shell", workspaceAppUri),
      annotations: toolAnnotationsForProfile(config.annotationProfile, { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }),
    },
    async (input, extra) => gatewayRouter
      ? routeGatewayTool(gatewayRouter, "terminal_resize", "terminal_resize", input, extra)
      : routeStandaloneTool(executor, "terminal_resize", "terminal_resize", input, extra),
  );

  registerAppTool(
    server,
    "terminal_status",
    {
      title: "Terminal status",
      description: "List persistent terminals for a workspace or inspect one terminal.",
      inputSchema: { workspaceId: z.string(), terminalId: z.string().optional() },
      outputSchema: { terminals: z.array(terminalOutputSchema) },
      ...toolWidgetDescriptorMeta(config, "shell", workspaceAppUri),
      annotations: { readOnlyHint: true },
    },
    async (input, extra) => gatewayRouter
      ? routeGatewayTool(gatewayRouter, "terminal_status", "terminal_status", input, extra)
      : routeStandaloneTool(executor, "terminal_status", "terminal_status", input, extra),
  );

  registerAppTool(
    server,
    "terminal_close",
    {
      title: "Close terminal",
      description: "Stop and close a persistent terminal session.",
      inputSchema: { workspaceId: z.string(), terminalId: z.string(), force: z.boolean().optional() },
      outputSchema: { terminal: terminalOutputSchema },
      ...toolWidgetDescriptorMeta(config, "shell", workspaceAppUri),
      annotations: toolAnnotationsForProfile(config.annotationProfile, { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false }),
    },
    async (input, extra) => gatewayRouter
      ? routeGatewayTool(gatewayRouter, "terminal_close", "terminal_close", input, extra)
      : routeStandaloneTool(executor, "terminal_close", "terminal_close", input, extra),
  );

  // sky-cua bridge — live tools/list from ~/projects/sky-cua/bin/sky-cua-client mcp
  // Hidden when DISABLED_CAPABILITIES includes sky-cua (per-session header or global),
  // or when the gateway node's disabledCapabilities hides it.
  const effectiveSet = effective ?? new Set<string>();
  if (!isSkyCuaDisabled(effectiveSet)) {
    const bridge = await getSkyBridge(config);
    if (bridge && bridge.healthy) {
      for (const tool of bridge.tools) {
        // sky-cua tools are not workspace-scoped. Force non-destructive so ChatGPT/Hermes platform safety never
        // blocks any of them (phone/desktop/browser). Underlying sky-cua service still enforces its own safety;
        // the MCP `destructiveHint`/`openWorldHint` gate is just the extra LLM prompt gate that was blocking Sarah.
        const baseAnnotations = tool.annotations ?? { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
        const skyAnnotations = { ...baseAnnotations, destructiveHint: false, openWorldHint: false };
        // inputSchema here is a Zod object; registerAppTool expects ZodRawShape, so unwrap if it's ZodObject
        const rawInputShape: Record<string, z.ZodTypeAny> = (() => {
          const s = tool.inputSchema as z.ZodTypeAny;
          if (s instanceof z.ZodObject) return (s as z.ZodObject<Record<string, z.ZodTypeAny>>).shape;
          const maybeShape = (s as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape;
          if (maybeShape && typeof maybeShape === "object" && !Array.isArray(maybeShape)) return maybeShape;
          return {};
        })();
        const hasShape = Object.keys(rawInputShape).length > 0;
        registerAppTool(
          server as never,
          tool.name as never,
          {
            title: tool.title ?? tool.name,
            description: tool.description ?? `sky-cua tool ${tool.name}`,
            ...(hasShape ? { inputSchema: rawInputShape } : { inputSchema: {} }),
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema as unknown as Record<string, z.ZodTypeAny> } : {}),
            annotations: toolAnnotationsForProfile(config.annotationProfile, skyAnnotations as ToolAnnotations),
            _meta: {},
          } as never,
          (async (input: unknown, extra: { signal: AbortSignal; requestId: string | number }) => {
            // Validate against original JSON Schema-derived Zod type when MCP layer used empty shape fallback
            if (!hasShape) {
              const parsed = (tool.inputSchema as z.ZodTypeAny).safeParse(input);
              if (!parsed.success) throw new Error(`Invalid arguments for tool ${tool.name}: ${parsed.error.message}`);
            }
            const normalized = normalizePhoneSelectorForBridge(tool.name, (input as Record<string, unknown>) ?? {});
            const result = await bridge.callTool(tool.name, normalized, extra.signal);
            const mapped: Record<string, unknown> = {
              content: result.content as unknown[],
              ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
              ...(result.isError ? { isError: true } : {}),
            };
            if ((mapped.content as unknown[]).length === 0) {
              (mapped.content as unknown[]).push({ type: "text", text: "" });
            }
            return mapped as { content: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
          }) as never,
        );
      }
    } else if (bridge && !bridge.healthy) {
      // Degraded but visible: expose a diagnostic doctor tool? bridge error surfaced via doctor only.
    }
  }

  return server;
}

interface CreateServerOptions {
  gatewayRouter?: GatewayExecutionRouter;
  role?: "standalone" | "gateway";
  healthCheck?: () => void;
}

export function createServer(config = loadConfig(), options: CreateServerOptions = {}): RunningServer {
  if (config.widgets === "workspace" && !options.gatewayRouter) {
    throw new Error("DEVSPACE_WIDGETS=workspace is only supported in gateway mode");
  }
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new Map<string, Transport>();
  const lastActiveAt = new Map<string, number>();
  const inFlight = new Set<string>();
  const sessionEffectiveDisabled = new Map<string, Set<string>>();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthStore = createOAuthStateStore(config.stateDir);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, oauthStore);
  const staticKeyStore = new StaticKeyStore(config.stateDir);
  staticKeyStore.cleanupExpired();
  const staticKeyVerifier = new StaticKeyVerifier(staticKeyStore, resourceServerUrl.href);
  const compositeVerifier = {
    async verifyAccessToken(token: string) {
      try {
        return await staticKeyVerifier.verifyAccessToken(token);
      } catch {
        return oauthProvider.verifyAccessToken(token);
      }
    },
  };
  const bearerAuth = requireBearerAuth({
    verifier: compositeVerifier,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const executor = options.gatewayRouter ? undefined : new LocalExecutor({ config });

  if (config.logging.trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use((_req, res, next) => {
    setSecurityHeaders(config, res);
    next();
  });

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(config, res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: (res) => setAssetHeaders(config, res),
    }),
  );

  app.get("/healthz", (_req, res) => {
    try {
      options.healthCheck?.();
      if (options.role === "gateway") {
        const metadata = getBuildMetadata("gateway");
        res.json({
          ok: true,
          role: "gateway",
          packageVersion: metadata.packageVersion,
          sourceCommit: metadata.sourceCommit,
          protocolMajor: metadata.protocolMajor,
        });
        return;
      }
      res.json({ ok: true, name: "devspace", version: DEVSPACE_VERSION });
    } catch {
      res.status(503).json({ ok: false, role: options.role ?? "standalone" });
    }
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && containsInitializeRequest(req.body);
    const rpcTrace = mcpRequestTraceFields(req.body, req.method);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...rpcTrace,
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    if (config.logging.requests) {
      logEvent(config.logging, "info", "mcp_request", {
        requestId,
        method: req.method,
        sessionIdPresent: Boolean(sessionId),
        sessionIdPrefix: sessionIdPrefix(sessionId),
        isInitialize: initializeRequest,
        ...rpcTrace,
      });
    }

    let newTransport: Transport | undefined;

    try {
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          logEvent(config.logging, "warn", "mcp_routing_error", {
            requestId,
            reason: "unknown_mcp_session",
            sessionIdPrefix: sessionIdPrefix(sessionId),
            ...rpcTrace,
          });
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
        lastActiveAt.set(sessionId, Date.now());
        // Refresh stored effective set from current header/query - tools remain fixed until new session, but map stays current for diagnostics.
        try {
          const cur = parseEffectiveDisabledFromRequest(req, config);
          const bm = (req.body as unknown as { params?: { _meta?: { disabledCapabilities?: unknown } } })?.params?._meta?.disabledCapabilities as unknown;
          if (Array.isArray(bm)) for (const v of bm as string[]) if (typeof v === "string" && v.trim()) cur.add(v.trim().toLowerCase());
          else if (typeof bm === "string" && (bm as string).trim()) for (const v of (bm as string).split(",")) if (v.trim()) cur.add(v.trim().toLowerCase());
          sessionEffectiveDisabled.set(sessionId, cur);
        } catch {}
      } else if (initializeRequest) {
        const pendingEffectiveDisabled = parseEffectiveDisabledFromRequest(req, config);
        // Merge body _meta disabledCapabilities if present in initialize
        try {
          const bodyMeta = (req.body as { params?: { _meta?: { disabledCapabilities?: unknown } } })?.params?._meta?.disabledCapabilities;
          if (Array.isArray(bodyMeta)) {
            for (const v of bodyMeta) if (typeof v === "string" && v.trim()) pendingEffectiveDisabled.add(v.trim().toLowerCase());
          } else if (typeof bodyMeta === "string" && bodyMeta.trim()) {
            for (const v of bodyMeta.split(",")) if (v.trim()) pendingEffectiveDisabled.add(v.trim().toLowerCase());
          }
        } catch {}
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) {
              transports.set(newSessionId, transport);
              lastActiveAt.set(newSessionId, Date.now());
              sessionEffectiveDisabled.set(newSessionId, new Set(pendingEffectiveDisabled));
            }
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req, config),
            });
          },
        });
        newTransport = transport;

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) {
            transports.delete(closedSessionId);
            lastActiveAt.delete(closedSessionId);
            sessionEffectiveDisabled.delete(closedSessionId);
            logEvent(config.logging, "info", "mcp_session_closed", {
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const effectiveDisabled = pendingEffectiveDisabled;
        const server = await createMcpServer(config, executor, options.gatewayRouter, effectiveDisabled);
        await server.connect(transport);
      } else {
        logEvent(config.logging, "warn", "mcp_routing_error", {
          requestId,
          reason: "missing_mcp_session",
          ...rpcTrace,
        });
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      if (sessionId) inFlight.add(sessionId);
      try {
        await transport.handleRequest(req, res, req.body);
      } finally {
        if (sessionId) inFlight.delete(sessionId);
      }
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
        ...rpcTrace,
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    } finally {
      if (newTransport && !newTransport.sessionId) {
        try {
          await newTransport.close();
        } catch (error) {
          logEvent(config.logging, "error", "mcp_transport_cleanup_error", {
            requestId,
            error: error instanceof Error ? error.message : String(error),
            ...rpcTrace,
          });
        }
      }
    }
  });

  // MCP clients (ChatGPT, Claude, etc.) routinely create fresh sessions and
  // never send DELETE, so without eviction every session's McpServer and
  // transport stay pinned in memory forever. Sweep sessions that have been
  // idle beyond the configured TTL; active sessions self-warm via activity
  // polling, and clients re-initialize freely after an eviction.
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    const ttlMs = config.sessions.idleTtlSeconds * 1000;
    let evicted = 0;
    for (const [sessionId, lastActive] of lastActiveAt) {
      if (now - lastActive < ttlMs) continue;
      // Never close a transport while a request is being handled: a
      // long-running tool call must not be cut off by eviction.
      if (inFlight.has(sessionId)) continue;
      const transport = transports.get(sessionId);
      if (!transport) {
        lastActiveAt.delete(sessionId);
        sessionEffectiveDisabled.delete(sessionId);
        continue;
      }
      evicted += 1;
      logEvent(config.logging, "info", "mcp_session_evicted", {
        sessionIdPrefix: sessionIdPrefix(sessionId),
        idleSeconds: Math.round((now - lastActive) / 1000),
        ttlSeconds: config.sessions.idleTtlSeconds,
      });
      void transport.close().catch(() => undefined);
    }
    logEvent(config.logging, "debug", "mcp_session_count", {
      sessions: transports.size,
      idleTtlSeconds: config.sessions.idleTtlSeconds,
    });
    if (evicted > 0) {
      logEvent(config.logging, "info", "mcp_session_eviction_sweep", {
        evicted,
        remaining: transports.size,
      });
    }
  }, config.sessions.sweepIntervalSeconds * 1000);
  sweepTimer.unref();

  return {
    app,
    config,
    close: () => {
      clearInterval(sweepTimer);
      executor?.close();
      oauthStore.close?.();
      staticKeyStore.close();
      for (const transport of transports.values()) void transport.close();
      transports.clear();
      lastActiveAt.clear();
      sessionEffectiveDisabled.clear();
      // close sky bridges if created
      for (const p of skyBridgeCache.values()) void p.then((b) => b?.close()).catch(() => undefined);
      skyBridgeCache.clear();
    },
  };
}

export function createGatewayServer(roleConfig: GatewayRoleConfig): RunningServer {
  const localMachine = roleConfig.machines.find((machine) => machine.kind === "local");
  const publicRootEnvironment = localMachine?.roots
    ? { DEVSPACE_ROOTS: JSON.stringify(localMachine.roots), DEVSPACE_ALLOWED_ROOTS: undefined }
    : { DEVSPACE_ALLOWED_ROOTS: (localMachine?.allowedRoots ?? [process.cwd()]).join(","), DEVSPACE_ROOTS: undefined };
  const publicConfig = loadConfig({
    ...process.env,
    ...publicRootEnvironment,
    HOST: roleConfig.host,
    PORT: String(roleConfig.port),
    DEVSPACE_PUBLIC_BASE_URL: roleConfig.publicBaseUrl,
    DEVSPACE_STATE_DIR: roleConfig.stateDir,
    DEVSPACE_CONFIG_DIR: `${roleConfig.stateDir}/role-config-source`,
    DEVSPACE_WORKTREE_ROOT: localMachine?.worktreeRoot ?? `${roleConfig.stateDir}/unused-worktrees`,
  });
  publicConfig.minimalTools = false;
  publicConfig.widgets = process.env.DEVSPACE_WIDGETS === undefined ? "workspace" : publicConfig.widgets;
  // Merge local machine disabledCapabilities (if any) into gateway public config.
  // Remote nodes default to sky-cua disabled but gateway's sky-cua lives on the local host,
  // so only the local machine's toggle matters for exposure.
  const localDisabled = localMachine?.disabledCapabilities;
  if (localDisabled && localDisabled.length > 0) {
    const eff = publicConfig.disabledCapabilities ?? new Set<string>();
    for (const cap of localDisabled) eff.add(cap.toLowerCase());
    publicConfig.disabledCapabilities = eff;
  }
  if (!publicConfig.disabledCapabilities) publicConfig.disabledCapabilities = new Set<string>();
  const bindings = createGatewayWorkspaceStore(roleConfig.stateDir);
  const targets = new Map<string, ExecutionTarget>();
  const localExecutors: LocalExecutor[] = [];
  for (const machine of roleConfig.machines) {
    if (machine.kind === "local") {
      const rootPolicies = normalizeRootPolicies(machine.roots ?? rootPoliciesFromStrings(machine.allowedRoots ?? []));
      const executorConfig: ServerConfig = {
        ...publicConfig,
        allowedRoots: configuredLogicalRoots(rootPolicies),
        rootPolicies,
        stateDir: machine.stateDir!,
        worktreeRoot: machine.worktreeRoot!,
        shell: {
          path: machine.shell?.path,
          mode: machine.shell?.mode ?? "service",
          environment: machine.shell?.environment,
        },
        secretNames: Array.from(new Set([
          ...publicConfig.secretNames,
          ...roleConfig.machines.filter((entry) => entry.kind === "remote").map((entry) => entry.nodeTokenEnv!),
        ])),
        terminals: {
          backend: machine.terminals?.backend ?? "tmux",
          runtimeDir: machine.terminals?.runtimeDir ?? `${machine.stateDir!}/terminal-runtime`,
          maxPerWorkspace: machine.terminals?.maxPerWorkspace ?? 4,
          maxTotal: machine.terminals?.maxTotal ?? 12,
          idleTtlSeconds: machine.terminals?.idleTtlSeconds ?? 8 * 60 * 60,
          useUserSystemd: machine.terminals?.useUserSystemd ?? true,
        },
        widgets: "changes",
      };
      const executor = new LocalExecutor({ config: executorConfig });
      localExecutors.push(executor);
      targets.set(machine.id, {
        execute: (tool, args, context) => executor.execute(tool, args as never, context),
      });
      continue;
    }
    targets.set(machine.id, new RemoteNodeClient({
      machineId: machine.id,
      url: machine.url!,
      nodeToken: envSecret(machine.nodeTokenEnv!),
    }));
  }
  const router = new GatewayExecutionRouter(
    roleConfig.machines.map((machine) => ({
      id: machine.id,
      displayName: machine.displayName,
      aliases: machine.aliases ?? [],
      canonical: machine.canonical === true,
    })),
    targets,
    bindings,
  );
  const running = createServer(publicConfig, {
    gatewayRouter: router,
    role: "gateway",
    healthCheck: () => bindings.ping(),
  });
  return {
    ...running,
    close: () => {
      running.close?.();
      router.close();
      for (const executor of localExecutors) executor.close();
      bindings.close();
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
  });
  const shutdown = () => httpServer.close(() => { close?.(); process.exit(0); });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
