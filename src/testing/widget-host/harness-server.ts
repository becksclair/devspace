// Server half of the DevSpace widget host: a real DevSpace server, a same-origin JSON proxy for
// the host page, and the sandbox proxy origin. Used by `serve.ts` and by `src/widget-host.test.ts`.
//
// Three loopback HTTP servers, each on its own port so each has its own origin:
//   - DevSpace (`createServer`, or `createGatewayServer` for --widgets workspace) at /mcp, serving
//     the widget assets under /mcp-app-assets exactly as in production;
//   - the harness: host page (Vite middleware mode, optional) and the JSON proxy under /api;
//   - the sandbox proxy page, so host and sandbox origins differ as the MCP Apps spec requires.
//
// The harness authenticates to /mcp with a static API key minted into the temporary state
// directory. The key and the generated owner token never leave this process and are never logged.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { ServerConfig, ToolNamingMode, WidgetMode } from "../../config.js";
import type { GatewayRoleConfig } from "../../role-config.js";
import { normalizeRootPolicies } from "../../roots.js";
import { createGatewayServer, createServer } from "../../server.js";
import { StaticKeyStore } from "../../static-key-provider.js";
import { seedFixtureRepository } from "./fixture.js";
import { McpHttpClient } from "./mcp-http-client.js";
import { sandboxProxyHtml } from "./sandbox-proxy.js";

export type HarnessWidgetMode = Exclude<WidgetMode, "off">;

export interface HarnessOptions {
  /** Widget mode. `workspace` runs DevSpace as a gateway with one local machine. */
  widgets: HarnessWidgetMode | "off";
  toolNaming?: ToolNamingMode;
  /** Harness (host page) port; 0 picks an ephemeral port. */
  port?: number;
  devspacePort?: number;
  sandboxPort?: number;
  /** Serve the host page through Vite. The smoke test runs without it. */
  servePage?: boolean;
  /** Run DevSpace as a gateway even when widgets is not `workspace` (the smoke test uses this). */
  gateway?: boolean;
}

export interface RunningHarness {
  hostUrl: string;
  devspaceOrigin: string;
  sandboxOrigin: string;
  widgets: HarnessOptions["widgets"];
  toolNaming: ToolNamingMode;
  role: "standalone" | "gateway";
  close(): Promise<void>;
}

export interface HarnessInfo {
  widgets: HarnessOptions["widgets"];
  toolNaming: ToolNamingMode;
  role: "standalone" | "gateway";
  devspaceOrigin: string;
  sandboxUrl: string;
  protocolVersion?: string;
}

const HOST = "127.0.0.1";
const PROXIED_METHODS = new Set(["tools/list", "tools/call", "resources/list", "resources/read"]);
const DISABLED_CAPABILITIES = ["sky-cua", "node_repl", "t3"];
const UI_MANIFEST = fileURLToPath(new URL("../../../dist/ui/.vite/manifest.json", import.meta.url));
const PAGE_ROOT = fileURLToPath(new URL("./page", import.meta.url));

export class HarnessSetupError extends Error {}

/** True when `bun run build:check` (or a build) has produced the widget bundle. */
export function widgetBundleExists(): boolean {
  return existsSync(UI_MANIFEST);
}

async function listen(server: HttpServer, port: number): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return `http://${HOST}:${(server.address() as AddressInfo).port}`;
}

async function closeHttp(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Rejects requests whose Host header is not this loopback origin (DNS rebinding guard). */
function hostGuard(origin: string): express.RequestHandler {
  const expected = new URL(origin).host;
  const alternate = `localhost:${new URL(origin).port}`;
  return (req, res, next) => {
    if (req.headers.host === expected || req.headers.host === alternate) return next();
    res.status(403).json({ error: "unexpected Host header" });
  };
}

function standaloneConfig(base: {
  origin: string;
  port: number;
  stateDir: string;
  root: string;
  widgets: WidgetMode;
  toolNaming: ToolNamingMode;
  ownerToken: string;
}): ServerConfig {
  return {
    host: HOST,
    port: base.port,
    oauth: {
      ownerToken: base.ownerToken,
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86400,
      scopes: ["devspace"],
      allowedRedirectHosts: [],
    },
    allowedRoots: [base.root],
    rootPolicies: normalizeRootPolicies([{ path: base.root, access: "read-write" }]),
    allowedHosts: [HOST],
    publicBaseUrl: base.origin,
    minimalTools: false,
    toolNaming: base.toolNaming,
    widgets: base.widgets,
    annotationProfile: "trusted-owner",
    stateDir: base.stateDir,
    worktreeRoot: join(base.stateDir, "worktrees"),
    skillsEnabled: false,
    skillPaths: [],
    agentDir: join(base.stateDir, "agent"),
    globalInstructionsFile: join(base.stateDir, "AGENTS.md"),
    shell: { mode: "service" },
    secretNames: ["DEVSPACE_OAUTH_OWNER_TOKEN"],
    terminals: {
      backend: "tmux",
      runtimeDir: join(base.stateDir, "terminal-runtime"),
      maxPerWorkspace: 4,
      maxTotal: 8,
      idleTtlSeconds: 3600,
      useUserSystemd: false,
    },
    maintenance: {
      intervalSeconds: 3600,
      closedSessionTtlSeconds: 86400,
      checkoutIdleTtlSeconds: 86400,
      isolatedIdleTtlSeconds: 86400,
    },
    sessions: { idleTtlSeconds: 3600, sweepIntervalSeconds: 60 },
    logging: {
      level: "silent",
      format: "json",
      requests: false,
      assets: false,
      toolCalls: false,
      shellCommands: false,
      trustProxy: false,
    },
    disabledCapabilities: new Set(DISABLED_CAPABILITIES),
  };
}

/**
 * `createGatewayServer` builds its public config from `process.env`, so the gateway mode first
 * replaces every DevSpace variable in this process with harness values. The harness process owns
 * its environment; nothing outside it is touched.
 */
function applyGatewayEnvironment(values: Record<string, string>): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("DEVSPACE_") || name === "DISABLED_CAPABILITIES") delete process.env[name];
  }
  Object.assign(process.env, values);
}

export async function startHarness(options: HarnessOptions): Promise<RunningHarness> {
  const widgets = options.widgets;
  const toolNaming = options.toolNaming ?? "short";
  if (widgets !== "off" && !widgetBundleExists()) {
    throw new HarnessSetupError(
      "dist/ui is missing: the widget bundle has not been built. Run `bun run build:check` in this checkout first.",
    );
  }

  // tmux sockets live under the state directory; macOS's long tmpdir exceeds the Unix socket
  // path limit, so use /tmp there, as the terminal test suites do.
  const tempBase = process.platform === "darwin" ? "/tmp" : tmpdir();
  const tempRoot = await realpath(await mkdtemp(join(tempBase, "devspace-widget-host-")));
  const stateDir = join(tempRoot, "state");
  const projectsRoot = join(tempRoot, "projects");
  await mkdir(stateDir, { recursive: true });
  await mkdir(projectsRoot, { recursive: true });

  const closers: Array<() => Promise<void> | void> = [];
  const close = async (): Promise<void> => {
    for (const closer of closers.reverse()) {
      try {
        await closer();
      } catch {
        // Keep closing the rest.
      }
    }
    closers.length = 0;
    await rm(tempRoot, { recursive: true, force: true });
  };

  try {
    // DevSpace derives its OAuth resource from publicBaseUrl, so bind first and attach the app after.
    const devspaceHttp = createHttpServer();
    const devspaceOrigin = await listen(devspaceHttp, options.devspacePort ?? 0);
    closers.push(() => closeHttp(devspaceHttp));
    const devspacePort = Number(new URL(devspaceOrigin).port);
    const ownerToken = randomBytes(24).toString("base64url");

    let running: ReturnType<typeof createServer>;
    const role = widgets === "workspace" || options.gateway ? "gateway" : "standalone";
    if (role === "gateway") {
      const gatewayState = join(stateDir, "gateway");
      const machineState = join(stateDir, "machine");
      applyGatewayEnvironment({
        DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
        DEVSPACE_WIDGETS: widgets,
        DEVSPACE_TOOL_NAMING: toolNaming,
        DEVSPACE_SKILLS: "false",
        DEVSPACE_AUTOLOAD_SKILLS: "",
        DEVSPACE_AGENT_DIR: join(stateDir, "agent"),
        DEVSPACE_GLOBAL_INSTRUCTIONS_FILE: join(stateDir, "AGENTS.md"),
        DEVSPACE_LOG_LEVEL: "silent",
        DEVSPACE_LOG_REQUESTS: "false",
        DEVSPACE_LOG_TOOL_CALLS: "false",
        DISABLED_CAPABILITIES: DISABLED_CAPABILITIES.join(","),
      });
      const roleConfig: GatewayRoleConfig = {
        role: "gateway",
        host: HOST,
        port: devspacePort,
        publicBaseUrl: devspaceOrigin,
        stateDir: gatewayState,
        machines: [
          {
            id: "harness",
            displayName: "Harness Machine",
            kind: "local",
            canonical: true,
            roots: [{ path: projectsRoot, access: "read-write" }],
            stateDir: machineState,
            worktreeRoot: join(machineState, "worktrees"),
            terminals: { backend: "tmux", runtimeDir: join(machineState, "terminal-runtime"), useUserSystemd: false },
            disabledCapabilities: DISABLED_CAPABILITIES,
          },
        ],
      };
      running = createGatewayServer(roleConfig);
    } else {
      running = createServer(
        standaloneConfig({ origin: devspaceOrigin, port: devspacePort, stateDir, root: projectsRoot, widgets, toolNaming, ownerToken }),
      );
    }
    closers.push(() => running.close?.());
    devspaceHttp.on("request", running.app);

    const keyStore = new StaticKeyStore(running.config.stateDir);
    const key = keyStore.mint(new URL("/mcp", devspaceOrigin).href, "widget-host", { scopes: ["devspace"], ttlSeconds: 24 * 60 * 60 });
    keyStore.close();
    const client = new McpHttpClient({ endpoint: new URL("/mcp", devspaceOrigin), bearerToken: key.rawKey });
    closers.push(() => client.close());

    // Sandbox origin.
    const sandboxApp = express();
    const sandboxHttp = createHttpServer(sandboxApp);
    const sandboxOrigin = await listen(sandboxHttp, options.sandboxPort ?? 0);
    closers.push(() => closeHttp(sandboxHttp));

    // Harness origin: JSON proxy plus the host page.
    const hostApp = express();
    const hostHttp = createHttpServer(hostApp);
    const hostOrigin = await listen(hostHttp, options.port ?? 0);
    closers.push(() => closeHttp(hostHttp));

    sandboxApp.disable("x-powered-by");
    sandboxApp.use(hostGuard(sandboxOrigin));
    sandboxApp.get("/sandbox.html", (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.type("html").send(sandboxProxyHtml(hostOrigin));
    });

    let fixtureCount = 0;
    const info: HarnessInfo = {
      widgets,
      toolNaming,
      role,
      devspaceOrigin,
      sandboxUrl: `${sandboxOrigin}/sandbox.html`,
    };

    hostApp.disable("x-powered-by");
    hostApp.use(hostGuard(hostOrigin));
    hostApp.use("/api", (req, res, next) => {
      // Browsers attach Origin to cross-origin requests; only the host page may use the proxy.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== hostOrigin) {
        res.status(403).json({ error: "cross-origin request rejected" });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      next();
    });
    hostApp.use("/api", express.json({ limit: "8mb" }));
    hostApp.get("/api/info", (_req, res) => {
      res.json({ ...info, protocolVersion: client.negotiatedProtocolVersion });
    });
    hostApp.post("/api/fixture", async (_req, res) => {
      try {
        fixtureCount += 1;
        const path = join(projectsRoot, `fixture-${String(fixtureCount).padStart(3, "0")}`);
        await seedFixtureRepository(path);
        res.json({ path });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });
    hostApp.post("/api/mcp", async (req, res) => {
      const body = req.body as { method?: unknown; params?: unknown } | undefined;
      const method = typeof body?.method === "string" ? body.method : "";
      if (!PROXIED_METHODS.has(method)) {
        res.status(400).json({ error: `method not proxied: ${method || "(none)"}` });
        return;
      }
      const params = body?.params && typeof body.params === "object" ? (body.params as Record<string, unknown>) : {};
      try {
        res.json(await client.request(method, params));
      } catch (error) {
        res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    if (options.servePage) {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        configFile: false,
        root: PAGE_ROOT,
        appType: "custom",
        logLevel: "warn",
        cacheDir: join(tempRoot, "vite-cache"),
        server: { middlewareMode: true, hmr: false, ws: false },
        optimizeDeps: { include: ["@modelcontextprotocol/ext-apps/app-bridge"] },
      });
      closers.push(() => vite.close());
      hostApp.get("/", async (req, res, next) => {
        try {
          const template = await readFile(join(PAGE_ROOT, "index.html"), "utf8");
          // Without HMR the injected Vite client only retries a WebSocket and fills the console.
          const html = (await vite.transformIndexHtml(req.originalUrl, template)).replace(
            /<script type="module" src="\/@vite\/client"><\/script>\s*/,
            "",
          );
          res.setHeader("Cache-Control", "no-store");
          res.type("html").send(html);
        } catch (error) {
          next(error);
        }
      });
      hostApp.use(vite.middlewares);
    }

    return {
      hostUrl: `${hostOrigin}/`,
      devspaceOrigin,
      sandboxOrigin,
      widgets,
      toolNaming,
      role,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
