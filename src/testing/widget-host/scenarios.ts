// Widget-host scenarios, shared by the host page (browser) and the smoke test (Node).
//
// A scenario performs real tool calls against a freshly seeded fixture repository and names one
// "display" call whose real `tools/call` result the host delivers to the widget. Tool names are
// discovered from `tools/list`, so scenarios work with either naming mode. This module must stay
// free of DOM and Node APIs, and must not import the MCP TypeScript SDK.

import { isToolName, isToolResultCard, type ToolName, type ToolResultCard } from "../../ui/card-types.js";
import { LARGE_FILE_PATH, largeFileContent } from "./fixture-content.js";
import type { RpcOutcome } from "./mcp-http-client.js";

export type CanonicalTool =
  | "open_workspace"
  | "workspace_status"
  | "close_workspace"
  | "read"
  | "multi_read"
  | "write"
  | "edit"
  | "grep"
  | "glob"
  | "ls"
  | "shell"
  | "show_changes"
  | "terminal_start"
  | "terminal_read"
  | "terminal_close"
  | "workspace_activity";

const TOOL_CANDIDATES: Record<CanonicalTool, string[]> = {
  open_workspace: ["open_workspace"],
  workspace_status: ["workspace_status"],
  close_workspace: ["close_workspace"],
  read: ["read_file", "read"],
  multi_read: ["multi_read"],
  write: ["write_file", "write"],
  edit: ["edit_file", "edit"],
  grep: ["grep_files", "grep"],
  glob: ["find_files", "glob"],
  ls: ["list_directory", "ls"],
  shell: ["run_shell", "bash"],
  show_changes: ["show_changes"],
  terminal_start: ["terminal_start"],
  terminal_read: ["terminal_read"],
  terminal_close: ["terminal_close"],
  workspace_activity: ["workspace_activity"],
};

export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A `tools/call` result as it travels on the wire. */
export interface ToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** How the harness reaches DevSpace: the page uses fetch to /api, the test may do the same. */
export interface HarnessTransport {
  rpc(method: string, params?: Record<string, unknown>): Promise<RpcOutcome>;
  createFixture(): Promise<string>;
}

export class ScenarioError extends Error {}

export function toolResourceUri(tool: ToolDefinition | undefined): string | undefined {
  const meta = tool?._meta;
  const ui = meta?.ui as { resourceUri?: unknown } | undefined;
  const uri = ui?.resourceUri ?? meta?.["ui/resourceUri"];
  return typeof uri === "string" ? uri : undefined;
}

/** Spec default is ["model", "app"] when `_meta.ui.visibility` is omitted. */
export function toolVisibility(tool: ToolDefinition | undefined): string[] {
  const ui = tool?._meta?.ui as { visibility?: unknown } | undefined;
  return Array.isArray(ui?.visibility) ? ui.visibility.filter((value): value is string => typeof value === "string") : ["model", "app"];
}

export class ToolCatalog {
  private constructor(readonly tools: ToolDefinition[]) {}

  static async load(transport: HarnessTransport): Promise<ToolCatalog> {
    const tools: ToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const outcome = await transport.rpc("tools/list", cursor ? { cursor } : {});
      if ("error" in outcome) throw new ScenarioError(`tools/list failed: ${outcome.error.message}`);
      tools.push(...((outcome.result.tools as ToolDefinition[] | undefined) ?? []));
      cursor = typeof outcome.result.nextCursor === "string" ? outcome.result.nextCursor : undefined;
    } while (cursor);
    return new ToolCatalog(tools);
  }

  byName(name: string): ToolDefinition | undefined {
    return this.tools.find((tool) => tool.name === name);
  }

  name(tool: CanonicalTool): string | undefined {
    return TOOL_CANDIDATES[tool].find((candidate) => this.byName(candidate));
  }

  definition(tool: CanonicalTool): ToolDefinition | undefined {
    const name = this.name(tool);
    return name ? this.byName(name) : undefined;
  }

  /** Every distinct widget resource URI advertised by any tool. */
  resourceUris(): string[] {
    return Array.from(new Set(this.tools.map(toolResourceUri).filter((uri): uri is string => Boolean(uri))));
  }
}

export interface ScenarioContext {
  catalog: ToolCatalog;
  /** Calls a tool and returns its result; a JSON-RPC error becomes an `isError` result. */
  call(tool: CanonicalTool, args: Record<string, unknown>): Promise<ToolResult>;
  /** Like `call`, but a failed setup step aborts the scenario. */
  step(tool: CanonicalTool, args: Record<string, unknown>): Promise<ToolResult>;
  fixture(): Promise<string>;
  log(message: string): void;
}

export function createScenarioContext(
  transport: HarnessTransport,
  catalog: ToolCatalog,
  log: (message: string) => void = () => undefined,
): ScenarioContext {
  const call = async (tool: CanonicalTool, args: Record<string, unknown>): Promise<ToolResult> => {
    const name = catalog.name(tool);
    if (!name) throw new ScenarioError(`tool ${tool} is not offered by this server`);
    log(`tools/call ${name}`);
    const outcome = await transport.rpc("tools/call", { name, arguments: args });
    if ("error" in outcome) {
      return { content: [{ type: "text", text: `MCP error ${outcome.error.code}: ${outcome.error.message}` }], isError: true };
    }
    return outcome.result as ToolResult;
  };
  return {
    catalog,
    call,
    async step(tool, args) {
      const result = await call(tool, args);
      if (result.isError) throw new ScenarioError(`setup step ${tool} failed: ${resultText(result).slice(0, 400)}`);
      return result;
    },
    fixture: () => transport.createFixture(),
    log,
  };
}

export interface PreparedScenario {
  display: { tool: CanonicalTool; arguments: Record<string, unknown> };
  workspaceId?: string;
  /** Runs after the display result is delivered; may return an activity-feed target to wait for. */
  afterResult?: (displayResult: ToolResult) => Promise<{ activityOperations?: number } | void>;
}

/** What the display result must look like: a card, an error card, or a tool error. */
export type ScenarioExpectation = "card" | "error-card" | "tool-error";

export interface Scenario {
  id: string;
  title: string;
  description: string;
  displayTool: CanonicalTool;
  /** Other tools the scenario needs from the server. */
  requires?: CanonicalTool[];
  expect: ScenarioExpectation;
  prepare(ctx: ScenarioContext): Promise<PreparedScenario>;
}

export function resultText(result: ToolResult): string {
  return result.content
    .map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

async function openFixture(ctx: ScenarioContext): Promise<string> {
  const path = await ctx.fixture();
  const result = await ctx.step("open_workspace", { path });
  const workspaceId = result.structuredContent?.workspaceId;
  if (typeof workspaceId !== "string") throw new ScenarioError("open_workspace returned no workspaceId");
  return workspaceId;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FEATURE_FLAGS_SOURCE = [
  "export interface FeatureFlags {",
  "  compactCards: boolean;",
  "  lazyDiffs: boolean;",
  "}",
  "",
  "export const defaultFlags: FeatureFlags = {",
  "  compactCards: true,",
  "  lazyDiffs: true,",
  "};",
  "",
].join("\n");

const GREETING_EDITS = [
  {
    oldText: '  const punctuation = options.punctuation ?? "!";',
    newText: '  const punctuation = options.punctuation ?? ".";\n  const trimmed = name.trim() || "friend";',
  },
  {
    oldText: "  return `Hello, ${name}${punctuation}`;\n}",
    newText: "  return `Hello, ${trimmed}${punctuation}`;\n}\n\nexport function farewell(name: string): string {\n  return `Goodbye, ${name}.`;\n}",
  },
];

export const SCENARIOS: Scenario[] = [
  {
    id: "open_workspace",
    title: "open_workspace",
    description: "Workspace card for a freshly opened fixture (activity feed in --widgets workspace).",
    displayTool: "open_workspace",
    expect: "card",
    async prepare(ctx) {
      const path = await ctx.fixture();
      return { display: { tool: "open_workspace", arguments: { path } } };
    },
  },
  {
    id: "activity_feed",
    title: "open_workspace activity feed",
    description: "Activity feed card; the host then runs read, edit, grep and shell calls so the widget's long poll fills the feed.",
    displayTool: "open_workspace",
    requires: ["workspace_activity", "read", "edit", "shell"],
    expect: "card",
    async prepare(ctx) {
      const path = await ctx.fixture();
      return {
        display: { tool: "open_workspace", arguments: { path } },
        afterResult: async (displayResult) => {
          const workspaceId = displayResult.structuredContent?.workspaceId;
          if (typeof workspaceId !== "string") throw new ScenarioError("open_workspace returned no workspaceId");
          const followUps: Array<[CanonicalTool, Record<string, unknown>]> = [
            ["read", { workspaceId, path: "src/greeting.ts" }],
            ["edit", { workspaceId, path: "src/greeting.ts", edits: GREETING_EDITS.slice(0, 1) }],
            ["shell", { workspaceId, command: "git status --short" }],
            ["read", { workspaceId, path: "README.md" }],
            ["shell", { workspaceId, command: "exit 2" }],
          ];
          if (ctx.catalog.name("grep")) followUps.splice(2, 0, ["grep", { workspaceId, pattern: "greet" }]);
          for (const [tool, args] of followUps) {
            await delay(250);
            await ctx.call(tool, args);
          }
          const page = await ctx.call("workspace_activity", { workspaceId, afterSeq: 0, limit: 200, waitMs: 0 });
          const total = page.structuredContent?.totalOperations;
          return { activityOperations: typeof total === "number" ? total : undefined };
        },
      };
    },
  },
  {
    id: "workspace_status",
    title: "workspace_status",
    description: "Workspace status card with capabilities and terminals.",
    displayTool: "workspace_status",
    expect: "card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      return { workspaceId, display: { tool: "workspace_status", arguments: { workspaceId } } };
    },
  },
  {
    id: "read_file",
    title: "read_file",
    description: "Read card for a TypeScript file (expand it to load the lazy code renderer).",
    displayTool: "read",
    expect: "card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      return { workspaceId, display: { tool: "read", arguments: { workspaceId, path: "src/greeting.ts" } } };
    },
  },
  {
    id: "read_binary",
    title: "read_file (binary)",
    description: "Read card for a PNG, which the read tool returns as an image content block.",
    displayTool: "read",
    expect: "card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      return { workspaceId, display: { tool: "read", arguments: { workspaceId, path: "assets/logo.png" } } };
    },
  },
  {
    id: "multi_read",
    title: "multi_read",
    description: "Batched read of three files, including one with mixed line endings.",
    displayTool: "multi_read",
    expect: "card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      return {
        workspaceId,
        display: {
          tool: "multi_read",
          arguments: {
            workspaceId,
            reads: [{ path: "src/index.ts" }, { path: "docs/mixed-endings.txt" }, { path: "README.md", offset: 1, limit: 2 }],
          },
        },
      };
    },
  },
  {
    id: "write_file",
    title: "write_file (new file)",
    description: "Write card for a newly created file.",
    displayTool: "write",
    expect: "card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      return { workspaceId, display: { tool: "write", arguments: { workspaceId, path: "src/feature-flags.ts", content: FEATURE_FLAGS_SOURCE } } };
    },
  },
  {
    id: "edit_file",
    title: "edit_file",
    description: "Edit card with a two-hunk diff (expand it to load the lazy diff renderer).",
    displayTool: "edit",
    expect: "card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      return { workspaceId, display: { tool: "edit", arguments: { workspaceId, path: "src/greeting.ts", edits: GREETING_EDITS } } };
    },
  },
  {
    id: "grep_files",
    title: "grep_files",
    description: "Search card for a pattern that matches several files.",
    displayTool: "grep",
    expect: "card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      return { workspaceId, display: { tool: "grep", arguments: { workspaceId, pattern: "greet" } } };
    },
  },
  {
    id: "find_files",
    title: "find_files",
    description: "Find card for a glob over the fixture.",
    displayTool: "glob",
    expect: "card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      return { workspaceId, display: { tool: "glob", arguments: { workspaceId, pattern: "**/*.ts" } } };
    },
  },
  {
    id: "list_directory",
    title: "list_directory",
    description: "Directory card for the fixture root.",
    displayTool: "ls",
    expect: "card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      return { workspaceId, display: { tool: "ls", arguments: { workspaceId, path: "." } } };
    },
  },
  {
    id: "run_shell_success",
    title: "run_shell (success)",
    description: "Shell card for a command that exits 0 with multi-line output.",
    displayTool: "shell",
    expect: "card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      return {
        workspaceId,
        display: { tool: "shell", arguments: { workspaceId, command: "git log --oneline --format='%s' && git status --short --branch && ls src" } },
      };
    },
  },
  {
    id: "run_shell_failure",
    title: "run_shell (non-zero exit)",
    description: "Shell card for a command that writes to stderr and exits 3; must render as an error.",
    displayTool: "shell",
    expect: "error-card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      return {
        workspaceId,
        display: { tool: "shell", arguments: { workspaceId, command: "echo 'checking fixture'; echo 'fatal: simulated failure' >&2; exit 3" } },
      };
    },
  },
  {
    id: "terminal",
    title: "terminal_read",
    description: "Terminal card for a persistent terminal's screen; the host closes the terminal afterwards.",
    displayTool: "terminal_read",
    requires: ["terminal_start", "terminal_close"],
    expect: "card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      const started = await ctx.step("terminal_start", {
        workspaceId,
        command: "printf 'harness terminal ready\\n'; git log --oneline; exec sleep 300",
        cols: 100,
        rows: 20,
      });
      const terminal = started.structuredContent?.terminal as { terminalId?: unknown } | undefined;
      const terminalId = terminal?.terminalId ?? started.structuredContent?.terminalId;
      if (typeof terminalId !== "string") throw new ScenarioError("terminal_start returned no terminalId");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const screen = await ctx.step("terminal_read", { workspaceId, terminalId, mode: "screen" });
        if (JSON.stringify(screen).includes("harness terminal ready")) break;
        await delay(150);
      }
      return {
        workspaceId,
        display: { tool: "terminal_read", arguments: { workspaceId, terminalId, mode: "screen" } },
        afterResult: async () => {
          await ctx.call("terminal_close", { workspaceId, terminalId, force: true });
        },
      };
    },
  },
  {
    id: "show_changes",
    title: "show_changes",
    description: "Review card with an edit, a new file, a rename, a deletion, a binary change and a CRLF file edit.",
    displayTool: "show_changes",
    requires: ["edit", "write", "shell"],
    expect: "card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      await ctx.step("edit", { workspaceId, path: "src/greeting.ts", edits: GREETING_EDITS });
      await ctx.step("write", { workspaceId, path: "src/feature-flags.ts", content: FEATURE_FLAGS_SOURCE });
      await ctx.step("shell", {
        workspaceId,
        command: "git mv src/legacy-name.ts src/display-name.ts && printf '\\000\\001\\002\\003' >> assets/logo.png && rm docs/notes.txt",
      });
      await ctx.step("edit", {
        workspaceId,
        path: "src/index.ts",
        edits: [{ oldText: 'import { legacyName } from "./legacy-name.js";', newText: 'import { legacyName } from "./display-name.js";' }],
      });
      await ctx.step("edit", {
        workspaceId,
        path: "docs/mixed-endings.txt",
        edits: [{ oldText: "second line uses LF", newText: "second line was edited" }],
      });
      return { workspaceId, display: { tool: "show_changes", arguments: { workspaceId } } };
    },
  },
  {
    id: "show_changes_large",
    title: "show_changes (large diff)",
    description: `Review card for a ${LARGE_FILE_PATH} rewrite where every line changes, exercising the lazy diff renderer.`,
    displayTool: "show_changes",
    requires: ["write"],
    expect: "card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      await ctx.step("write", { workspaceId, path: LARGE_FILE_PATH, content: largeFileContent("rewritten") });
      return { workspaceId, display: { tool: "show_changes", arguments: { workspaceId } } };
    },
  },
  {
    id: "show_changes_clean",
    title: "show_changes (no changes)",
    description: "Review card when nothing changed since the workspace was opened.",
    displayTool: "show_changes",
    expect: "card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      return { workspaceId, display: { tool: "show_changes", arguments: { workspaceId } } };
    },
  },
  {
    id: "close_workspace",
    title: "close_workspace",
    description: "Close card for a clean checkout workspace.",
    displayTool: "close_workspace",
    expect: "card",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      return { workspaceId, display: { tool: "close_workspace", arguments: { workspaceId } } };
    },
  },
  {
    id: "tool_error",
    title: "tool error",
    description: "A read of a missing file: the tool returns isError and the widget shows its error state.",
    displayTool: "read",
    expect: "tool-error",
    async prepare(ctx) {
      const workspaceId = await openFixture(ctx);
      return { workspaceId, display: { tool: "read", arguments: { workspaceId, path: "missing/does-not-exist.ts" } } };
    },
  },
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

/** Returns why a scenario cannot run against this server, or undefined when it can. */
export function scenarioUnavailableReason(
  scenario: Scenario,
  catalog: ToolCatalog,
  options: { requireWidget: boolean },
): string | undefined {
  const display = catalog.definition(scenario.displayTool);
  if (!display) return `the server does not offer ${scenario.displayTool} in this widget mode`;
  if (options.requireWidget && !toolResourceUri(display)) {
    return `${display.name} has no _meta.ui.resourceUri in this widget mode, so a host would not render a widget for it`;
  }
  const missing = (scenario.requires ?? []).filter((tool) => !catalog.name(tool));
  if (missing.length > 0) return `the server does not offer ${missing.join(", ")} in this widget mode`;
  return undefined;
}

export type ClassifiedResult =
  | { kind: "card"; tool: ToolName; card: ToolResultCard }
  | { kind: "no-card"; reason: string };

/** Mirrors the widget's `ontoolresult`: `_meta.tool` names the card, `_meta.card` overlays `structuredContent`. */
export function classifyToolResult(result: ToolResult): ClassifiedResult {
  const meta = result._meta;
  const tool = meta?.tool;
  const metaCard = meta?.card && typeof meta.card === "object" ? (meta.card as Partial<ToolResultCard>) : undefined;
  const structured = metaCard ? { ...result.structuredContent, ...metaCard } : result.structuredContent;
  if (!isToolName(tool)) return { kind: "no-card", reason: "result has no recognised _meta.tool" };
  if (!isToolResultCard(structured)) return { kind: "no-card", reason: "result has no structured card" };
  return { kind: "card", tool, card: { ...(structured as Omit<ToolResultCard, "tool">), tool } };
}

/** Returns a failure message when the display result does not match the scenario's expectation. */
export function checkDisplayResult(scenario: Scenario, catalog: ToolCatalog, result: ToolResult): string | undefined {
  const classified = classifyToolResult(result);
  const expectedName = catalog.name(scenario.displayTool);
  switch (scenario.expect) {
    case "card":
      if (result.isError) return `expected a successful result, got isError: ${resultText(result).slice(0, 200)}`;
      if (classified.kind !== "card") return `expected a card: ${classified.reason}`;
      if (classified.tool !== expectedName) return `card names tool ${classified.tool}, expected ${expectedName}`;
      return undefined;
    case "error-card":
      if (result.isError !== true) return "expected isError: true";
      if (classified.kind !== "card") return `expected an error card: ${classified.reason}`;
      return undefined;
    case "tool-error":
      if (result.isError !== true) return "expected isError: true";
      return undefined;
  }
}
