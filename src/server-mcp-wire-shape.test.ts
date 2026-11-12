// Pins the tools/list and resources/list wire shape that MCP hosts see under SDK v2: every tool
// schema is JSON Schema 2020-12, no tool advertises `execution`, and the workspace card resource
// is listed (with widgets on) under a content-hashed ui:// URI that the tools reference.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig, WidgetMode } from "./config.js";
import { SqliteOAuthStateStore } from "./oauth-store.js";
import { normalizeRootPolicies } from "./roots.js";
import { createServer } from "./server.js";

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const accessToken = "wire-shape-test-access-token";
const protocolVersion = "2025-11-25";
const publicBaseUrl = "http://127.0.0.1:7676";

interface WireTool {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execution?: unknown;
  _meta?: Record<string, unknown> & { ui?: { resourceUri?: string } };
}
interface WireResource {
  uri: string;
  name: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}

// `bun run test` runs before the UI build in CI; widgets need only the manifest entry to list the
// card resource, so a placeholder manifest is written when there is none and removed afterwards.
const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const uiDir = join(distDir, "ui");
const manifestDir = join(uiDir, ".vite");
const manifestPath = join(manifestDir, "manifest.json");
const createdDistDir = !existsSync(distDir);
const createdUiDir = !existsSync(uiDir);
const createdManifestDir = !existsSync(manifestDir);
const createdManifest = !existsSync(manifestPath);
if (createdManifest) {
  await mkdir(manifestDir, { recursive: true });
  await writeFile(manifestPath, JSON.stringify({ "workspace-app.html": { file: "assets/workspace-app-placeholder.js" } }));
}

function configFor(stateDir: string, widgets: WidgetMode): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7676,
    oauth: {
      ownerToken: "wire-shape-test-owner-token-long-enough",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 2592000,
      scopes: ["devspace"],
      allowedRedirectHosts: [],
    },
    allowedRoots: [process.cwd()],
    rootPolicies: normalizeRootPolicies([{ path: process.cwd(), access: "read-write" }]),
    allowedHosts: ["127.0.0.1"],
    publicBaseUrl,
    minimalTools: false,
    toolNaming: "short",
    widgets,
    annotationProfile: "standard",
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
  };
}

interface WireLists {
  tools: WireTool[];
  /** The resources/list result, or the JSON-RPC error when the server has no resources capability. */
  resources: { resources?: WireResource[]; error?: { code: number } };
  templates: { resourceTemplates?: unknown[]; error?: { code: number } };
}

async function listWire(widgets: WidgetMode): Promise<WireLists> {
  const stateDir = await mkdtemp(join(tmpdir(), `devspace-wire-shape-${widgets}-`));
  const store = new SqliteOAuthStateStore(stateDir);
  store.saveToken({
    tokenHash: createHash("sha256").update(accessToken).digest("base64url"),
    tokenType: "access",
    clientId: "wire-shape-test-client",
    scopes: ["devspace"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    resource: new URL(`${publicBaseUrl}/mcp`),
  });
  store.close();
  const { app } = createServer(configFor(stateDir, widgets));
  const httpServer = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("listening", resolve);
      httpServer.once("error", reject);
    });
    const endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
    const initialized = await post(endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "wire-shape-test", version: "1.0.0" } },
    });
    const sessionId = initialized.sessionId;
    assert.ok(sessionId, "initialize assigns a session");
    await post(endpoint, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
    const tools = await post(endpoint, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
    assert.equal(tools.error, undefined, "tools/list succeeds");
    const resources = await post(endpoint, { jsonrpc: "2.0", id: 3, method: "resources/list", params: {} }, sessionId);
    const templates = await post(endpoint, { jsonrpc: "2.0", id: 4, method: "resources/templates/list", params: {} }, sessionId);
    return {
      tools: (tools.result as { tools: WireTool[] }).tools,
      resources: resources.error ? { error: resources.error } : (resources.result as { resources: WireResource[] }),
      templates: templates.error ? { error: templates.error } : (templates.result as { resourceTemplates: unknown[] }),
    };
  } finally {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeAllConnections();
    });
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function post(endpoint: string, body: unknown, sessionId?: string): Promise<{ sessionId?: string; result?: unknown; error?: { code: number } }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(sessionId ? { "mcp-protocol-version": protocolVersion, "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${JSON.stringify(body)} answered HTTP ${response.status}`);
  const text = await response.text();
  const data = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("");
  const message = data ? (JSON.parse(data) as { result?: unknown; error?: { code: number } }) : undefined;
  return { sessionId: response.headers.get("mcp-session-id") ?? undefined, result: message?.result, error: message?.error };
}

function assertToolSchemas(tools: WireTool[]): void {
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name} inputSchema is an object schema`);
    assert.equal(tool.inputSchema.$schema, JSON_SCHEMA_2020_12, `${tool.name} inputSchema is JSON Schema 2020-12`);
    if (tool.outputSchema) {
      assert.equal(tool.outputSchema.type, "object", `${tool.name} outputSchema is an object schema`);
      assert.equal(tool.outputSchema.$schema, JSON_SCHEMA_2020_12, `${tool.name} outputSchema is JSON Schema 2020-12`);
    }
    assert.equal("execution" in tool, false, `${tool.name} advertises no execution (task support)`);
  }
  assert.ok(tools.some((tool) => tool.outputSchema), "some tools declare an outputSchema");
}

try {
  const full = await listWire("full");
  assertToolSchemas(full.tools);
  assert.equal(full.resources.resources?.length, 1, "widgets on list exactly the workspace card resource");
  const [card] = full.resources.resources;
  assert.match(card.uri, /^ui:\/\/devspace\/workspace-app-[a-f0-9]{12}\.html$/);
  assert.equal(card.name, "DevSpace Workspace Card");
  assert.equal(card.mimeType, "text/html;profile=mcp-app");
  assert.deepEqual(Object.keys(card._meta ?? {}).sort(), ["openai/widgetCSP", "ui"]);
  const widgetTools = full.tools.filter((tool) => tool._meta?.ui?.resourceUri !== undefined);
  assert.ok(widgetTools.length > 0, "tools reference the card");
  for (const tool of widgetTools) {
    assert.equal(tool._meta?.ui?.resourceUri, card.uri, `${tool.name} references the listed card`);
    assert.equal(tool._meta?.["ui/resourceUri"], card.uri, `${tool.name} carries the legacy ui/resourceUri key`);
  }
  assert.deepEqual(full.templates, { resourceTemplates: [] });
  process.stdout.write("ok - widgets full: 2020-12 schemas, no execution, one content-hashed card resource\n");

  const off = await listWire("off");
  assertToolSchemas(off.tools);
  assert.equal(off.resources.error?.code, -32601, "widgets off: no resources capability, so resources/list is not found");
  assert.equal(off.templates.error?.code, -32601, "widgets off: resources/templates/list is not found");
  assert.equal(off.tools.some((tool) => tool._meta?.ui !== undefined), false, "widgets off: no tool references a UI resource");
  process.stdout.write("ok - widgets off: 2020-12 schemas, no execution, no resources capability\n");
} finally {
  if (createdManifest) await rm(manifestPath, { force: true });
  if (createdManifestDir) await rm(manifestDir, { recursive: true, force: true });
  if (createdUiDir) await rm(uiDir, { recursive: true, force: true });
  if (createdDistDir) await rm(distDir, { recursive: true, force: true });
}

process.stdout.write("server-mcp-wire-shape.test: all checks passed\n");
