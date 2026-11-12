// Launcher for the developer widget host: `bun run widget:host [flags]`.
//
// Starts a real DevSpace server with a throwaway seeded workspace, the host page, and the sandbox
// origin, all on 127.0.0.1, then prints one line with the host page URL. Ctrl-C (or SIGTERM,
// SIGHUP, or an uncaught error) stops everything and removes the temporary directories. See
// docs/widget-host.md.

import { parseArgs } from "node:util";
import type { ToolNamingMode } from "../../config.js";
import { HarnessSetupError, startHarness, type HarnessWidgetMode } from "./harness-server.js";

const WIDGET_MODES: HarnessWidgetMode[] = ["full", "changes", "workspace"];
const TOOL_NAMING: ToolNamingMode[] = ["short", "legacy"];
const RESERVED_PORTS = new Set([3000, 7676, 7677, 7678, 7679, 7680]);

const USAGE = `Usage: bun run widget:host [--widgets full|changes|workspace] [--tool-naming short|legacy]
                            [--port N] [--devspace-port N] [--sandbox-port N]

  --widgets        DevSpace widget mode (default full). "workspace" runs DevSpace as a gateway with
                   one local machine, which is the only mode with the live activity feed.
  --tool-naming    DevSpace tool naming mode (default short).
  --port           Host page port (default 0: ephemeral). Ports 3000 and 7676-7680 are refused.
  --devspace-port  DevSpace server port (default 0: ephemeral).
  --sandbox-port   Sandbox proxy port (default 0: ephemeral).`;

function fail(message: string): never {
  console.error(`widget-host: ${message}`);
  process.exit(2);
}

function port(value: string | undefined, name: string): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) fail(`--${name} must be a port number`);
  if (RESERVED_PORTS.has(parsed)) fail(`--${name} ${parsed} is reserved for other local services; choose another port`);
  return parsed;
}

const { values } = parseArgs({
  options: {
    widgets: { type: "string", default: "full" },
    "tool-naming": { type: "string", default: "short" },
    port: { type: "string" },
    "devspace-port": { type: "string" },
    "sandbox-port": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!WIDGET_MODES.includes(values.widgets as HarnessWidgetMode)) {
  fail(`--widgets must be one of ${WIDGET_MODES.join(", ")} (got "${values.widgets}")`);
}
if (!TOOL_NAMING.includes(values["tool-naming"] as ToolNamingMode)) {
  fail(`--tool-naming must be one of ${TOOL_NAMING.join(", ")}`);
}

let harness: Awaited<ReturnType<typeof startHarness>>;
try {
  harness = await startHarness({
    widgets: values.widgets as HarnessWidgetMode,
    toolNaming: values["tool-naming"] as ToolNamingMode,
    port: port(values.port, "port"),
    devspacePort: port(values["devspace-port"], "devspace-port"),
    sandboxPort: port(values["sandbox-port"], "sandbox-port"),
    servePage: true,
  });
} catch (error) {
  if (error instanceof HarnessSetupError) fail(error.message);
  throw error;
}

console.log(`widget-host ready (widgets ${harness.widgets}, ${harness.role}): ${harness.hostUrl}?scenario=index`);

// Every exit path runs the same close. Handlers stay installed (`on`, not `once`), so a second
// signal during a slow close waits for that close instead of killing the process mid-cleanup.
let exitCode = 0;
let closing: Promise<void> | undefined;
function stop(code: number): void {
  exitCode = Math.max(exitCode, code);
  closing ??= harness
    .close()
    .catch((error: unknown) => {
      console.error(`widget-host: cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      exitCode = Math.max(exitCode, 1);
    })
    .finally(() => process.exit(exitCode));
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => stop(0));
process.on("uncaughtException", (error) => {
  console.error("widget-host: uncaught exception:", error);
  stop(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("widget-host: unhandled rejection:", reason);
  stop(1);
});
