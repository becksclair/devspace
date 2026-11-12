// Launcher for the developer widget host: `bun run widget:host [flags]`.
//
// Starts a real DevSpace server with a throwaway seeded workspace, the host page, and the sandbox
// origin, all on 127.0.0.1, then prints one line with the host page URL. Ctrl-C stops everything
// and removes the temporary directories. See docs/widget-host.md.

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

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await harness.close();
  process.exit(0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
