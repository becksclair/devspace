// Pins the tools/list and resources/list wire shape that MCP hosts see under SDK v2: every tool
// schema is JSON Schema 2020-12, no tool advertises `execution`, and the workspace card resource
// is listed (with widgets on) under a content-hashed ui:// URI that the tools reference. It also
// pins the JSON-RPC error that tools/call answers for a tool the session does not register.

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
import { createServer, currentEntryAssetFor, isWorkspaceAppResourceUri } from "./server.js";

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

// `bun run test` runs before the UI build in CI. Listing the card needs the manifest entry and
// reading it needs the entry's asset to exist, so a placeholder manifest and asset are written
// when there is no build and removed afterwards.
const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const uiDir = join(distDir, "ui");
const manifestDir = join(uiDir, ".vite");
const manifestPath = join(manifestDir, "manifest.json");
const createdDistDir = !existsSync(distDir);
const createdUiDir = !existsSync(uiDir);
const createdManifestDir = !existsSync(manifestDir);
const createdManifest = !existsSync(manifestPath);
const assetsDir = join(uiDir, "assets");
const createdAssetsDir = !existsSync(assetsDir);
const placeholderAsset = join(assetsDir, "workspace-app-placeholder.js");
if (createdManifest) {
  await mkdir(manifestDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  await writeFile(placeholderAsset, "");
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

/** The card's address under a widget build other than the current one. */
const EARLIER_BUILD_URI = "ui://devspace/workspace-app-0123456789ab.html";
/** Addresses that only resemble the card's; none of them may be answered. */
const FOREIGN_URIS = [
  "ui://other-server/workspace-app-0123456789ab.html",
  "ui://devspace/other-app-0123456789ab.html",
  "ui://devspace/workspace-app-0123456789ab.html/extra",
  "ui://devspace/workspace-app-latest.html",
  "ui://devspace/workspace-app-0123456789AB.html",
  "ui://devspace/workspace-app-0123456789a.html",
  "ui://devspace/workspace-app-0123456789abc.html",
  "ui://devspace/workspace-app-0123456789ab.htmlx",
  "file:///etc/workspace-app-0123456789ab.html",
];

/** The card's entry script and stylesheet under another build's names. */
const STALE_ENTRY_PATHS = ["/assets/workspace-app-AAAAAAAA.js", "/assets/workspace-app-AAAAAAAA.css"];
/** Paths that only resemble an entry asset; none of them may be answered with the entry. */
const FOREIGN_ASSET_PATHS = [
  "/assets/other-app-AAAAAAAA.js",
  "/assets/workspace-app-AAAAAAAA.js.map",
  "/assets/workspace-app-AAAA.js",
  "/assets/workspace-app-AAAAAAAAA.js",
  "/assets/workspace-app-AAAAAAAA.mjs",
  "/assets/nested/workspace-app-AAAAAAAA.js",
  "/workspace-app-AAAAAAAA.js",
];

interface WireLists {
  tools: WireTool[];
  /** The resources/list result, or the JSON-RPC error when the server has no resources capability. */
  resources: { resources?: WireResource[]; error?: { code: number } };
  templates: { resourceTemplates?: unknown[]; error?: { code: number } };
  /** GET results for paths under /mcp-app-assets, by path (widgets on only). */
  assets: Record<string, { status: number; cacheControl: string | null; body: string }>;
  /** resources/read results or errors, by requested address (widgets on only). */
  reads: Record<string, { result?: unknown; error?: { code: number; message?: string } }>;
  /** tools/call errors for an unknown name and for a real tool this session does not register. */
  unregisteredCalls: Record<string, { result?: unknown; error?: { code: number; message?: string } }>;
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
    const unregisteredCalls: WireLists["unregisteredCalls"] = {};
    for (const [index, name] of ["no_such_tool", "show_changes"].entries()) {
      const call = await post(endpoint, { jsonrpc: "2.0", id: 5 + index, method: "tools/call", params: { name, arguments: {} } }, sessionId);
      unregisteredCalls[name] = { result: call.result, error: call.error };
    }
    const reads: WireLists["reads"] = {};
    const listed = (resources.result as { resources?: WireResource[] } | undefined)?.resources?.[0]?.uri;
    if (listed) {
      for (const [index, uri] of [listed, EARLIER_BUILD_URI, ...FOREIGN_URIS].entries()) {
        const read = await post(endpoint, { jsonrpc: "2.0", id: 20 + index, method: "resources/read", params: { uri } }, sessionId);
        reads[uri] = { result: read.result, error: read.error };
      }
    }
    const assets: WireLists["assets"] = {};
    const cardHtml = listed ? (reads[listed]?.result as { contents?: Array<{ text?: string }> } | undefined)?.contents?.[0]?.text ?? "" : "";
    const entryPaths = [...cardHtml.matchAll(/\/mcp-app-assets(\/assets\/[^"]+)"/g)].map((match) => match[1]);
    for (const path of [...entryPaths, ...STALE_ENTRY_PATHS, ...FOREIGN_ASSET_PATHS]) {
      const response = await fetch(`${endpoint.replace(/\/mcp$/, "")}/mcp-app-assets${path}`);
      assets[path] = { status: response.status, cacheControl: response.headers.get("cache-control"), body: await response.text() };
    }
    return {
      assets,
      reads,
      unregisteredCalls,
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

async function post(endpoint: string, body: unknown, sessionId?: string): Promise<{ sessionId?: string; result?: unknown; error?: { code: number; message?: string } }> {
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
  const message = data ? (JSON.parse(data) as { result?: unknown; error?: { code: number; message?: string } }) : undefined;
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
  // The card is also readable under earlier builds' addresses; that is advertised as one template
  // and adds nothing to resources/list.
  assert.deepEqual(
    (full.templates.resourceTemplates as Array<{ uriTemplate: string; mimeType?: string }>).map((template) => [template.uriTemplate, template.mimeType]),
    [["ui://devspace/workspace-app-{build}.html", "text/html;profile=mcp-app"]],
  );
  process.stdout.write("ok - widgets full: 2020-12 schemas, no execution, one content-hashed card resource\n");

  // A host keeps the card's address from its last scan, and the address changes with every widget
  // build: an earlier build's address is answered with the current bundle, under the address asked for.
  assert.notEqual(card.uri, EARLIER_BUILD_URI);
  assert.equal(isWorkspaceAppResourceUri(card.uri), true, "the pattern matches the address the server really produces");
  const readContents = (uri: string) => (full.reads[uri]?.result as { contents: Array<{ uri: string; mimeType: string; text: string; _meta?: Record<string, unknown> }> } | undefined)?.contents;
  const current = readContents(card.uri);
  const earlier = readContents(EARLIER_BUILD_URI);
  assert.equal(current?.length, 1);
  assert.equal(current?.[0]?.uri, card.uri);
  assert.match(current?.[0]?.text ?? "", /<main id="app"/);
  assert.equal(earlier?.length, 1, "an earlier build's address is answered");
  assert.equal(earlier?.[0]?.uri, EARLIER_BUILD_URI, "under the address that was asked for");
  assert.equal(earlier?.[0]?.text, current?.[0]?.text, "with the current bundle");
  assert.equal(earlier?.[0]?.mimeType, "text/html;profile=mcp-app");
  assert.deepEqual(earlier?.[0]?._meta, current?.[0]?._meta);
  for (const uri of FOREIGN_URIS) {
    assert.equal(full.reads[uri]?.result, undefined, `${uri}: no contents`);
    assert.equal(full.reads[uri]?.error?.code, -32602, `${uri}: not found`);
    assert.match(full.reads[uri]?.error?.message ?? "", /^Resource not found: /, `${uri}: the SDK's not-found message`);
  }
  process.stdout.write("ok - an earlier build's card address reads the current bundle; foreign addresses are not found\n");

  // A host can paint its cached copy of the card before re-reading it, and that copy names the
  // previous build's entry script and stylesheet: those names are answered with the current entry
  // files, uncached. Nothing else under /mcp-app-assets changes.
  const scriptPath = Object.keys(full.assets).find((path) => path.endsWith(".js") && !STALE_ENTRY_PATHS.includes(path) && !FOREIGN_ASSET_PATHS.includes(path));
  const stylePath = Object.keys(full.assets).find((path) => path.endsWith(".css") && !STALE_ENTRY_PATHS.includes(path) && !FOREIGN_ASSET_PATHS.includes(path));
  assert.ok(scriptPath, "the card HTML names its entry script");
  assert.equal(full.assets[scriptPath]?.status, 200);
  assert.match(full.assets[scriptPath]?.cacheControl ?? "", /immutable/, "the current entry is cached immutably");
  const staleScript = full.assets["/assets/workspace-app-AAAAAAAA.js"];
  assert.equal(staleScript?.status, 200, "another build's entry script name is answered");
  assert.equal(staleScript?.body, full.assets[scriptPath]?.body, "with the current entry script");
  assert.equal(staleScript?.cacheControl, "no-cache", "and is not cached under the other build's name");
  const staleStyle = full.assets["/assets/workspace-app-AAAAAAAA.css"];
  if (stylePath) {
    assert.equal(staleStyle?.status, 200, "another build's stylesheet name is answered");
    assert.equal(staleStyle?.body, full.assets[stylePath]?.body, "with the current stylesheet");
    assert.equal(staleStyle?.cacheControl, "no-cache");
  } else {
    assert.equal(staleStyle?.status, 404, "a build without a stylesheet has none to answer with");
  }
  for (const path of FOREIGN_ASSET_PATHS) assert.equal(full.assets[path]?.status, 404, `${path}: not found`);
  const entry = { file: "assets/workspace-app-BBBBBBBB.js", css: ["assets/workspace-app-CCCCCCCC.css"] };
  assert.equal(currentEntryAssetFor("/assets/workspace-app-AAAAAAAA.js", entry), entry.file);
  assert.equal(currentEntryAssetFor("/assets/workspace-app-AAAAAAAA.css", entry), entry.css[0]);
  assert.equal(currentEntryAssetFor(`/${entry.file}`, entry), undefined, "the current name is served as a normal asset");
  assert.equal(currentEntryAssetFor("/assets/workspace-app-AAAAAAAA.css", { file: entry.file }), undefined);
  assert.equal(currentEntryAssetFor("/assets/react-vendor-AAAAAAAA.js", entry), undefined);
  process.stdout.write("ok - another build's entry script and stylesheet names load the current entry; nothing else is aliased\n");

  // SDK v2 / MCP specification behavior: tools/call for a tool the session does not register is a
  // JSON-RPC -32602 error, not a tool result with isError (SDK v1 answered isError: true).
  assert.equal(full.tools.some((tool) => tool.name === "show_changes"), false, "show_changes is not registered with widgets full");
  for (const name of ["no_such_tool", "show_changes"]) {
    assert.equal(full.unregisteredCalls[name]?.result, undefined, `${name}: no tool result`);
    assert.deepEqual(full.unregisteredCalls[name]?.error, { code: -32602, message: `Tool ${name} not found` }, `${name}: JSON-RPC invalid params`);
  }
  process.stdout.write("ok - tools/call for an unregistered tool answers JSON-RPC -32602\n");

  const off = await listWire("off");
  assertToolSchemas(off.tools);
  assert.equal(off.resources.error?.code, -32601, "widgets off: no resources capability, so resources/list is not found");
  assert.equal(off.templates.error?.code, -32601, "widgets off: resources/templates/list is not found");
  assert.equal(off.tools.some((tool) => tool._meta?.ui !== undefined), false, "widgets off: no tool references a UI resource");
  process.stdout.write("ok - widgets off: 2020-12 schemas, no execution, no resources capability\n");
} finally {
  if (createdManifest) await rm(manifestPath, { force: true });
  if (createdManifest) await rm(placeholderAsset, { force: true });
  if (createdAssetsDir) await rm(assetsDir, { recursive: true, force: true });
  if (createdManifestDir) await rm(manifestDir, { recursive: true, force: true });
  if (createdUiDir) await rm(uiDir, { recursive: true, force: true });
  if (createdDistDir) await rm(distDir, { recursive: true, force: true });
}

process.stdout.write("server-mcp-wire-shape.test: all checks passed\n");
