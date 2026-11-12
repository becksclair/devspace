// Host page of the DevSpace widget host: a minimal MCP Apps host for local, in-browser checks.
//
// It loads the widget resource from a real DevSpace server (through the harness's /api proxy),
// frames it through the sandbox proxy on a separate origin, and drives it with `AppBridge` from
// `@modelcontextprotocol/ext-apps/app-bridge`, restricted to API common to ext-apps 1.7.5 and
// 2.x: the constructor, `on*` handler properties, `connect`, and the `send*`/`teardownResource`
// methods. `setRequestHandler` is deliberately not used.

import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  SCENARIOS,
  ScenarioError,
  ToolCatalog,
  checkDisplayResult,
  createScenarioContext,
  findScenario,
  scenarioUnavailableReason,
  toolResourceUri,
  toolVisibility,
  type Scenario,
  type ToolDefinition,
  type ToolResult,
} from "../scenarios.js";
import { createProxyTransport } from "../transport.js";
import type { HarnessInfo } from "../harness-server.js";

type HostContext = NonNullable<NonNullable<ConstructorParameters<typeof AppBridge>[3]>["hostContext"]>;
type HostCapabilities = ConstructorParameters<typeof AppBridge>[2];
type BridgeToolResult = Awaited<ReturnType<NonNullable<AppBridge["oncalltool"]>>>;
type BridgeResourceResult = Awaited<ReturnType<NonNullable<AppBridge["onreadresource"]>>>;
type BridgeTransport = Parameters<AppBridge["connect"]>[0];
type Theme = "light" | "dark";

const WIDTHS = [360, 480, 768];
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
const INITIALIZE_TIMEOUT_MS = 15_000;
const SETTLE_QUIET_MS = 700;
const SETTLE_MAX_MS = 12_000;
const ACTIVITY_TIMEOUT_MS = 30_000;
const LOG_LIMIT = 600;

const STYLE_VARIABLES: Record<Theme, Record<string, string>> = {
  light: {
    "--color-background-primary": "#ffffff",
    "--color-background-secondary": "#f5f5f3",
    "--color-background-tertiary": "#ebebe7",
    "--color-background-danger": "#fef3f2",
    "--color-background-success": "#ecfdf3",
    "--color-text-primary": "#1d1d1b",
    "--color-text-secondary": "#55554f",
    "--color-text-tertiary": "#8a8a82",
    "--color-text-danger": "#b42318",
    "--color-text-success": "#067647",
    "--color-border-primary": "#d6d6d0",
    "--color-border-secondary": "#e4e4df",
    "--font-sans": '"Harness Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
    "--font-mono": 'ui-monospace, SFMono-Regular, Menlo, monospace',
    "--border-radius-md": "8px",
  },
  dark: {
    "--color-background-primary": "#1f1f1d",
    "--color-background-secondary": "#2a2a27",
    "--color-background-tertiary": "#34342f",
    "--color-background-danger": "#3a1d1a",
    "--color-background-success": "#12301f",
    "--color-text-primary": "#ececea",
    "--color-text-secondary": "#bdbdb6",
    "--color-text-tertiary": "#8f8f87",
    "--color-text-danger": "#f97066",
    "--color-text-success": "#47cd89",
    "--color-border-primary": "#3a3a36",
    "--color-border-secondary": "#2f2f2b",
    "--font-sans": '"Harness Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
    "--font-mono": 'ui-monospace, SFMono-Regular, Menlo, monospace',
    "--border-radius-md": "8px",
  },
};

// Local fonts only: a host font from the network would need the widget CSP to allow it.
const HOST_FONTS = '@font-face { font-family: "Harness Sans"; src: local("Helvetica Neue"), local("Helvetica"), local("Arial"); }';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

const ui = {
  scenario: byId<HTMLSelectElement>("scenario"),
  theme: byId<HTMLSelectElement>("theme"),
  width: byId<HTMLSelectElement>("width"),
  cspMode: byId<HTMLSelectElement>("csp-mode"),
  rerun: byId<HTMLButtonElement>("rerun"),
  resend: byId<HTMLButtonElement>("resend"),
  teardown: byId<HTMLButtonElement>("teardown"),
  status: byId<HTMLSpanElement>("harness-status"),
  mode: byId<HTMLSpanElement>("harness-mode"),
  csp: byId<HTMLSpanElement>("harness-csp"),
  error: byId<HTMLParagraphElement>("harness-error"),
  stage: byId<HTMLElement>("stage"),
  index: byId<HTMLElement>("index"),
  cspPolicy: byId<HTMLPreElement>("csp-policy"),
  log: byId<HTMLOListElement>("log"),
  logCount: byId<HTMLSpanElement>("log-count"),
};

const query = new URLSearchParams(location.search);
const state = {
  scenarioId: query.get("scenario") ?? "index",
  theme: (query.get("theme") === "dark" ? "dark" : "light") as Theme,
  width: WIDTHS.includes(Number(query.get("width"))) ? Number(query.get("width")) : 480,
  // "spec" applies the spec-derived CSP; "wasm" also allows WebAssembly compilation.
  csp: (query.get("csp") === "wasm" ? "wasm" : "spec") as "spec" | "wasm",
};

let bridge: AppBridge | undefined;
let frame: HTMLIFrameElement | undefined;
let lastResult: ToolResult | undefined;
let lastSizeChangeAt = 0;
let cspViolations = 0;
let widgetFailures = 0;
let logCount = 0;
let activityTotal = -1;
const activityWaiters: Array<() => void> = [];

function setHarnessState(next: "loading" | "ready" | "error", message?: string): void {
  // A widget failure is sticky: a later "ready" does not hide it.
  if (next === "ready" && widgetFailures > 0) return;
  document.documentElement.dataset.harnessState = next;
  ui.status.textContent = next;
  if (next === "error") {
    ui.error.hidden = false;
    ui.error.textContent = message ?? "unknown error";
  } else {
    ui.error.hidden = true;
    ui.error.textContent = "";
  }
}

/**
 * zod probes for `new Function` support once per load (in the mcp-app-vendor chunk) and falls back
 * when the CSP blocks it; that report is expected. Every other violation, including a blocked
 * WebAssembly compilation (`wasm-eval`), is a widget failure.
 */
function isKnownBenignViolation(detail: { directive?: string; blockedURI?: string }): boolean {
  return detail.directive === "script-src" && detail.blockedURI === "eval";
}

/** Marks the run as failed; automation reads `data-harness-state` and `data-harness-failures`. */
function recordWidgetFailure(message: string): void {
  widgetFailures += 1;
  document.documentElement.dataset.harnessFailures = String(widgetFailures);
  log("host", `widget failure: ${message}`);
  setHarnessState("error", widgetFailures === 1 ? message : `${message} (and ${widgetFailures - 1} earlier)`);
}

function updateUrl(): void {
  const params = new URLSearchParams();
  params.set("scenario", state.scenarioId);
  params.set("theme", state.theme);
  params.set("width", String(state.width));
  if (state.csp !== "spec") params.set("csp", state.csp);
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
}

function log(direction: string, summary: string, payload?: unknown): void {
  logCount += 1;
  ui.logCount.textContent = String(logCount);
  const item = document.createElement("li");
  const label = document.createElement("span");
  label.className = "direction";
  label.textContent = direction;
  item.append(label, document.createTextNode(` ${summary}`));
  if (payload !== undefined) {
    const details = document.createElement("details");
    const summaryElement = document.createElement("summary");
    summaryElement.textContent = "message";
    const pre = document.createElement("pre");
    const json = JSON.stringify(payload, null, 2) ?? String(payload);
    pre.textContent = json.length > 20_000 ? `${json.slice(0, 20_000)}\n… (${json.length} characters)` : json;
    details.append(summaryElement, pre);
    item.append(details);
  }
  ui.log.append(item);
  while (ui.log.childElementCount > LOG_LIMIT) ui.log.firstElementChild?.remove();
}

function describeMessage(message: unknown): string {
  if (!message || typeof message !== "object") return String(message);
  const record = message as { id?: unknown; method?: unknown; error?: { message?: unknown } };
  if (typeof record.method === "string") return record.id === undefined ? record.method : `${record.method} #${String(record.id)}`;
  if (record.error) return `error #${String(record.id)}: ${String(record.error.message)}`;
  return `response #${String(record.id)}`;
}

function hostContext(tool: ToolDefinition): HostContext {
  return {
    toolInfo: { id: `harness-${Date.now()}`, tool: tool as never },
    theme: state.theme,
    styles: { variables: STYLE_VARIABLES[state.theme] as never, css: { fonts: HOST_FONTS } },
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    containerDimensions: { width: state.width, maxHeight: 4000 },
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: "devspace-widget-host/1.0",
    platform: "web",
    deviceCapabilities: { touch: false, hover: true },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

function applyPageTheme(): void {
  document.documentElement.dataset.theme = state.theme;
}

function applyFrameWidth(): void {
  const host = ui.stage.querySelector<HTMLElement>(".frame-host");
  if (host) host.style.width = `${state.width}px`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits until the widget has stopped resizing for a moment, which approximates "rendered". */
async function waitForSettle(): Promise<void> {
  const started = Date.now();
  await delay(SETTLE_QUIET_MS);
  while (Date.now() - started < SETTLE_MAX_MS && Date.now() - lastSizeChangeAt < SETTLE_QUIET_MS) {
    await delay(100);
  }
}

async function waitForActivity(target: number): Promise<void> {
  const deadline = Date.now() + ACTIVITY_TIMEOUT_MS;
  while (activityTotal < target) {
    if (Date.now() > deadline) throw new ScenarioError(`activity feed did not reach ${target} operations (last poll saw ${activityTotal})`);
    await new Promise<void>((resolve) => {
      activityWaiters.push(resolve);
      setTimeout(resolve, 1000);
    });
  }
}

function populateControls(catalog: ToolCatalog): void {
  ui.scenario.replaceChildren();
  const indexOption = new Option("index (list scenarios)", "index");
  ui.scenario.append(indexOption);
  for (const scenario of SCENARIOS) {
    const reason = scenarioUnavailableReason(scenario, catalog, { requireWidget: true });
    const option = new Option(reason ? `${scenario.id} (unavailable)` : scenario.id, scenario.id);
    ui.scenario.append(option);
  }
  ui.scenario.value = findScenario(state.scenarioId) ? state.scenarioId : "index";
  ui.theme.value = state.theme;
  ui.width.value = String(state.width);
  ui.cspMode.value = state.csp;
}

function renderIndex(catalog: ToolCatalog, info: HarnessInfo): void {
  ui.stage.replaceChildren();
  ui.index.hidden = false;
  const table = document.createElement("table");
  table.innerHTML = "<thead><tr><th>id</th><th>display tool</th><th>shows</th><th>availability</th></tr></thead>";
  const body = document.createElement("tbody");
  for (const scenario of SCENARIOS) {
    const reason = scenarioUnavailableReason(scenario, catalog, { requireWidget: true });
    const row = document.createElement("tr");
    if (reason) row.className = "unavailable";
    const idCell = document.createElement("td");
    const link = document.createElement("a");
    link.href = `?scenario=${encodeURIComponent(scenario.id)}&theme=${state.theme}&width=${state.width}${state.csp === "wasm" ? "&csp=wasm" : ""}`;
    link.textContent = scenario.id;
    link.dataset.scenarioId = scenario.id;
    idCell.append(link);
    const toolCell = document.createElement("td");
    toolCell.textContent = catalog.name(scenario.displayTool) ?? scenario.displayTool;
    const descriptionCell = document.createElement("td");
    descriptionCell.textContent = scenario.description;
    const availabilityCell = document.createElement("td");
    availabilityCell.textContent = reason ? `unavailable with --widgets ${info.widgets}: ${reason}` : "available";
    row.append(idCell, toolCell, descriptionCell, availabilityCell);
    body.append(row);
  }
  table.append(body);
  ui.index.replaceChildren(table);
}

async function readWidgetResource(transport: ReturnType<typeof createProxyTransport>, uri: string): Promise<{ html: string; csp: unknown; permissions: unknown }> {
  const outcome = await transport.rpc("resources/read", { uri });
  if ("error" in outcome) throw new ScenarioError(`resources/read ${uri} failed: ${outcome.error.message}`);
  const contents = (outcome.result.contents as Array<Record<string, unknown>> | undefined) ?? [];
  const content = contents.find((entry) => entry.uri === uri) ?? contents[0];
  if (!content) throw new ScenarioError(`resources/read ${uri} returned no contents`);
  if (content.mimeType !== MCP_APP_MIME_TYPE) {
    throw new ScenarioError(`widget resource has MIME type ${String(content.mimeType)}, expected ${MCP_APP_MIME_TYPE}`);
  }
  if (typeof content.text !== "string") throw new ScenarioError("widget resource has no text HTML");
  const ui = (content._meta as { ui?: { csp?: unknown; permissions?: unknown } } | undefined)?.ui;
  return { html: content.text, csp: ui?.csp, permissions: ui?.permissions };
}

async function teardownWidget(reason: string): Promise<void> {
  const current = bridge;
  if (!current) return;
  ui.teardown.disabled = true;
  ui.resend.disabled = true;
  log("host → app", `ui/resource-teardown (${reason})`);
  try {
    await current.teardownResource({});
  } catch (error) {
    log("host", `teardown request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // AppBridge has no public close() in ext-apps 1.7.5; removing the frame ends the session.
  bridge = undefined;
  frame = undefined;
  const placeholder = document.createElement("div");
  placeholder.className = "placeholder";
  placeholder.textContent = "Widget torn down.";
  ui.stage.replaceChildren(placeholder);
}

async function mountWidget(options: {
  transport: ReturnType<typeof createProxyTransport>;
  catalog: ToolCatalog;
  info: HarnessInfo;
  displayTool: ToolDefinition;
  resource: { html: string; csp: unknown; permissions: unknown };
}): Promise<AppBridge> {
  const host = document.createElement("div");
  host.className = "frame-host";
  host.style.width = `${state.width}px`;
  const iframe = document.createElement("iframe");
  iframe.title = "MCP App sandbox";
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  iframe.style.height = "80px";
  iframe.src = state.csp === "wasm" ? `${options.info.sandboxUrl}?csp=wasm` : options.info.sandboxUrl;
  host.append(iframe);
  ui.stage.replaceChildren(host);
  frame = iframe;
  const proxyWindow = iframe.contentWindow;
  if (!proxyWindow) throw new ScenarioError("sandbox iframe has no window");

  const capabilities: HostCapabilities = {
    serverTools: {},
    serverResources: {},
    logging: {},
    openLinks: {},
    updateModelContext: { text: {} },
    message: { text: {} },
  };
  const created = new AppBridge(null, { name: "devspace-widget-host", version: "1.0.0" }, capabilities, {
    hostContext: hostContext(options.displayTool),
  });

  let resolveInitialized: () => void = () => undefined;
  const initialized = new Promise<void>((resolve) => {
    resolveInitialized = resolve;
  });

  created.onsandboxready = () => {
    void created.sendSandboxResourceReady({
      html: options.resource.html,
      csp: options.resource.csp as never,
      permissions: options.resource.permissions as never,
    });
  };
  created.oninitialized = () => resolveInitialized();
  created.onsizechange = ({ width, height }) => {
    lastSizeChangeAt = Date.now();
    if (typeof height === "number" && frame === iframe) iframe.style.height = `${Math.ceil(height)}px`;
    void width;
  };
  created.oncalltool = async (params) => {
    const tool = options.catalog.byName(params.name);
    if (!tool) throw new Error(`unknown tool ${params.name}`);
    if (!toolVisibility(tool).includes("app")) {
      throw new Error(`tool ${params.name} is not visible to apps (visibility ${JSON.stringify(toolVisibility(tool))})`);
    }
    const outcome = await options.transport.rpc("tools/call", { name: params.name, arguments: params.arguments ?? {} });
    if ("error" in outcome) throw new Error(outcome.error.message);
    if (params.name === "workspace_activity") {
      const total = (outcome.result.structuredContent as { totalOperations?: unknown } | undefined)?.totalOperations;
      if (typeof total === "number") {
        activityTotal = Math.max(activityTotal, total);
        activityWaiters.splice(0).forEach((resolve) => resolve());
      }
    }
    return outcome.result as BridgeToolResult;
  };
  created.onreadresource = async (params) => {
    const outcome = await options.transport.rpc("resources/read", { uri: params.uri });
    if ("error" in outcome) throw new Error(outcome.error.message);
    return outcome.result as BridgeResourceResult;
  };
  created.onopenlink = async ({ url }) => {
    window.open(url, "_blank", "noopener,noreferrer");
    return {};
  };
  created.onmessage = async () => ({});
  created.onupdatemodelcontext = async () => ({});
  created.onrequestdisplaymode = async () => ({ mode: "inline" });
  created.onrequestteardown = () => {
    void teardownWidget("requested by the widget");
  };
  created.onloggingmessage = ({ logger, level, data }) => {
    if (logger !== "widget-host/sandbox") return;
    const detail = data as { kind?: string; policy?: string; directive?: string; blockedURI?: string; message?: string } | undefined;
    if (detail?.kind === "csp-applied" && typeof detail.policy === "string") {
      ui.cspPolicy.textContent = detail.policy.split("; ").join(";\n");
    } else if (detail?.kind === "csp-violation") {
      cspViolations += 1;
      document.documentElement.dataset.harnessCspViolations = String(cspViolations);
      ui.csp.textContent = `CSP violations: ${cspViolations}`;
      console.warn("widget CSP violation", detail);
      if (!isKnownBenignViolation(detail)) {
        recordWidgetFailure(`CSP violation: ${detail.directive ?? "?"} blocked ${detail.blockedURI ?? "?"}`);
      }
    } else if (level === "error") {
      console.error("widget error", detail);
      recordWidgetFailure(`${detail?.kind ?? "error"}: ${detail?.message ?? JSON.stringify(detail)}`);
    }
  };

  const transport = new PostMessageTransport(proxyWindow, proxyWindow) as BridgeTransport;
  const send = transport.send.bind(transport);
  transport.send = (message, sendOptions) => {
    log("host → app", describeMessage(message), message);
    return send(message, sendOptions);
  };
  await created.connect(transport);
  const receive = transport.onmessage;
  transport.onmessage = (message, extra) => {
    log("app → host", describeMessage(message), message);
    receive?.(message, extra);
  };
  bridge = created;

  await Promise.race([
    initialized,
    delay(INITIALIZE_TIMEOUT_MS).then(() => {
      throw new ScenarioError("the widget never sent ui/notifications/initialized");
    }),
  ]);
  ui.teardown.disabled = false;
  return created;
}

async function runScenario(scenario: Scenario, info: HarnessInfo, catalog: ToolCatalog, transport: ReturnType<typeof createProxyTransport>): Promise<void> {
  const reason = scenarioUnavailableReason(scenario, catalog, { requireWidget: true });
  if (reason) throw new ScenarioError(`scenario ${scenario.id} is unavailable with --widgets ${info.widgets}: ${reason}`);

  const ctx = createScenarioContext(transport, catalog, (message) => log("scenario", message));
  const prepared = await scenario.prepare(ctx);
  const displayTool = catalog.definition(prepared.display.tool);
  const uri = toolResourceUri(displayTool);
  if (!displayTool || !uri) throw new ScenarioError(`display tool ${prepared.display.tool} has no widget`);
  const resource = await readWidgetResource(transport, uri);

  const connected = await mountWidget({ transport, catalog, info, displayTool, resource });
  // A host sends the complete tool input first, then the result once the call completes.
  await connected.sendToolInput({ arguments: prepared.display.arguments });
  const result = await ctx.call(prepared.display.tool, prepared.display.arguments);
  lastResult = result;
  await connected.sendToolResult(result as never);
  ui.resend.disabled = false;
  const failure = checkDisplayResult(scenario, catalog, result);

  // afterResult also releases what the scenario opened (the terminal), so it runs before a
  // mismatched result fails the scenario.
  const after = await prepared.afterResult?.(result);
  if (failure) throw new ScenarioError(`scenario ${scenario.id}: ${failure}`);
  if (after && typeof after.activityOperations === "number") await waitForActivity(after.activityOperations);
  await waitForSettle();
}

function bindControls(navigate: () => void): void {
  ui.scenario.addEventListener("change", () => {
    state.scenarioId = ui.scenario.value;
    navigate();
  });
  ui.rerun.addEventListener("click", navigate);
  ui.cspMode.addEventListener("change", () => {
    state.csp = ui.cspMode.value === "wasm" ? "wasm" : "spec";
    navigate();
  });
  ui.theme.addEventListener("change", () => {
    state.theme = ui.theme.value === "dark" ? "dark" : "light";
    applyPageTheme();
    updateUrl();
    if (bridge) {
      void bridge.sendHostContextChange({
        theme: state.theme,
        styles: { variables: STYLE_VARIABLES[state.theme] as never, css: { fonts: HOST_FONTS } },
      });
    }
  });
  ui.width.addEventListener("change", () => {
    state.width = Number(ui.width.value);
    applyFrameWidth();
    updateUrl();
    if (bridge) void bridge.sendHostContextChange({ containerDimensions: { width: state.width, maxHeight: 4000 } });
  });
  ui.resend.addEventListener("click", () => {
    if (bridge && lastResult) void bridge.sendToolResult(lastResult as never);
  });
  ui.teardown.addEventListener("click", () => {
    void teardownWidget("teardown button");
  });
}

async function main(): Promise<void> {
  document.documentElement.dataset.harnessFailures = "0";
  document.documentElement.dataset.harnessCspViolations = "0";
  setHarnessState("loading");
  applyPageTheme();
  updateUrl();
  bindControls(() => {
    updateUrl();
    location.reload();
  });

  const infoResponse = await fetch("/api/info");
  if (!infoResponse.ok) throw new Error(`/api/info failed with HTTP ${infoResponse.status}`);
  const info = (await infoResponse.json()) as HarnessInfo;
  ui.mode.textContent = `widgets ${info.widgets} · ${info.role} · ${info.toolNaming} names · CSP ${state.csp === "wasm" ? "spec + 'wasm-unsafe-eval'" : "spec"} · DevSpace ${info.devspaceOrigin}`;
  const transport = createProxyTransport("/api");
  const catalog = await ToolCatalog.load(transport);
  populateControls(catalog);

  if (state.scenarioId === "index") {
    renderIndex(catalog, info);
    setHarnessState("ready");
    return;
  }
  const scenario = findScenario(state.scenarioId);
  if (!scenario) throw new ScenarioError(`unknown scenario "${state.scenarioId}"; open ?scenario=index for the list`);
  ui.index.hidden = true;
  await runScenario(scenario, info, catalog, transport);
  setHarnessState("ready");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  log("host", `error: ${message}`);
  setHarnessState("error", message);
});
