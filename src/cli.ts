#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { delimiter, join, resolve } from "node:path";
import * as prompts from "@clack/prompts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { loadConfig, parseDisabledCapabilities, parseSkyCuaConfig, type ServerConfig } from "./config.js";
import {
  generateOwnerToken,
  loadDevspaceFiles,
  writeDevspaceAuth,
  writeDevspaceConfig,
  type DevspaceUserConfig,
} from "./user-config.js";
import { configuredLogicalRoots, expandHomePath, normalizeRootPolicies, rootPoliciesFromStrings } from "./roots.js";
import { loadRoleConfig } from "./role-config.js";
import { createShellRuntime, runConfiguredShell } from "./shell-environment.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { assertHermesOAuthConfigCompatible, mintHeadlessOAuth, writeHermesOAuthFiles, writeOAuthBundle } from "./headless-auth.js";
import { StaticKeyStore, mintApiKey, DEFAULT_KEY_TTL_SECONDS } from "./static-key-provider.js";

type Command = "serve" | "init" | "doctor" | "config" | "gateway" | "node" | "auth" | "help";
const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = ">=24 <27";

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "gateway":
      await runGateway(args);
      return;
    case "node":
      await runNode(args);
      return;
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "doctor":
      await runDoctor();
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "auth":
      await runAuthCommand(args);
      return;
    case "help":
      printHelp();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (command === "init" || command === "doctor" || command === "config" || command === "gateway" || command === "node" || command === "auth") return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  throw new Error(`Unknown command: ${command}`);
}

function configArg(args: string[]): string {
  const index = args.indexOf("--config");
  if (index < 0 || !args[index + 1]) throw new Error("Usage: devspace gateway|node --config <path>");
  return resolve(args[index + 1]);
}

async function runGateway(args: string[]): Promise<void> {
  const config = loadRoleConfig(configArg(args));
  if (config.role !== "gateway") throw new Error("gateway requires a gateway role config");
  const serverModule = await import("./server.js") as typeof import("./server.js") & { createGatewayServer?: (config: unknown) => { app: import("express").Express; close?: () => void } };
  if (!serverModule.createGatewayServer) throw new Error("Gateway server support is unavailable in this build");
  const { app, close } = serverModule.createGatewayServer(config);
  listenRole(app, config.port, config.host, "gateway", close);
}

async function runNode(args: string[]): Promise<void> {
  const config = loadRoleConfig(configArg(args));
  if (config.role !== "node") throw new Error("node requires a node role config");
  const [{ createNodeServer }, { createExecutor }] = await Promise.all([
    import("./node-server.js"),
    import("./executor.js"),
  ]);
  const executor = createExecutor(nodeExecutorConfig(config));
  const { app } = createNodeServer(config, executor);
  listenRole(app, config.port, config.host, "node", () => executor.close());
}

function listenRole(
  app: import("express").Express,
  port: number,
  host: string,
  role: "gateway" | "node",
  close?: () => void,
): void {
  const server = app.listen(port, host, () => console.log(`devspace ${role} listening on http://${host}:${port}`));
  const shutdown = () => {
    server.close(() => { close?.(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function nodeExecutorConfig(config: import("./role-config.js").NodeRoleConfig): ServerConfig {
  const rootPolicies = normalizeRootPolicies(config.roots ?? rootPoliciesFromStrings(config.allowedRoots ?? []));
  return {
    host: config.host,
    port: config.port,
    oauth: {
      ownerToken: "node-role-does-not-own-oauth",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 2592000,
      scopes: ["devspace"],
      allowedRedirectHosts: [],
    },
    allowedRoots: configuredLogicalRoots(rootPolicies),
    rootPolicies,
    allowedHosts: [config.host],
    publicBaseUrl: `http://${config.host}:${config.port}`,
    minimalTools: true,
    toolNaming: "short",
    annotationProfile: "standard",
    // The private node renders no widgets, but it must establish the
    // workspace-open review checkpoint used by the show_changes contract.
    widgets: "changes",
    stateDir: config.stateDir,
    worktreeRoot: config.worktreeRoot,
    skillsEnabled: true,
    skillPaths: [join(parseSkyCuaConfig(process.env).projectRoot, "skills")],
    agentDir: resolve(expandHomePath(process.env.DEVSPACE_AGENT_DIR ?? "~/.codex")),
    globalInstructionsFile: resolve(expandHomePath(process.env.DEVSPACE_GLOBAL_INSTRUCTIONS_FILE ?? "~/.devspace/AGENTS.md")),
    shell: {
      path: config.shell?.path,
      mode: config.shell?.mode ?? "service",
      environment: config.shell?.environment,
    },
    secretNames: Array.from(new Set([
      config.nodeTokenEnv,
      ...(process.env.DEVSPACE_INFRA_SECRET_NAMES ?? "").split(",").map((name) => name.trim()).filter(Boolean),
    ])),
    terminals: {
      backend: config.terminals?.backend ?? "tmux",
      runtimeDir: config.terminals?.runtimeDir ?? join(config.stateDir, "terminal-runtime"),
      maxPerWorkspace: config.terminals?.maxPerWorkspace ?? 4,
      maxTotal: config.terminals?.maxTotal ?? 12,
      idleTtlSeconds: config.terminals?.idleTtlSeconds ?? 8 * 60 * 60,
      useUserSystemd: config.terminals?.useUserSystemd ?? true,
    },
    maintenance: {
      intervalSeconds: 3600,
      closedSessionTtlSeconds: 7 * 24 * 60 * 60,
      checkoutIdleTtlSeconds: 30 * 24 * 60 * 60,
      isolatedIdleTtlSeconds: 7 * 24 * 60 * 60,
    },
    sessions: {
      idleTtlSeconds: 30 * 60,
      sweepIntervalSeconds: 60,
    },
    disabledCapabilities: (() => {
      if (config.disabledCapabilities !== undefined) return new Set(config.disabledCapabilities.map((c) => c.toLowerCase()));
      if (process.env.DISABLED_CAPABILITIES !== undefined) return parseDisabledCapabilities(process.env.DISABLED_CAPABILITIES);
      return new Set<string>(["sky-cua"]);
    })(),
    skyCua: parseSkyCuaConfig(process.env),
    logging: {
      level: "info",
      format: "json",
      requests: true,
      assets: false,
      toolCalls: true,
      shellCommands: false,
      trustProxy: false,
    },
  };
}

async function ensureConfigured(): Promise<void> {
  const files = loadDevspaceFiles();
  if (files.configExists && files.authExists) return;
  if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "DevSpace is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  devspace init",
        "",
        "Or provide DEVSPACE_OAUTH_OWNER_TOKEN and DEVSPACE_ALLOWED_ROOTS.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

async function runInit({ force }: { force: boolean }): Promise<void> {
  const files = loadDevspaceFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`DevSpace is already configured at ${files.dir}`);
    prompts.log.info("Run `devspace init --force` to update it.");
    return;
  }

  try {
    prompts.intro("DevSpace setup");

    const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
    const rootsAnswer = await textPrompt({
      message: `Where are your projects located? Press Enter to use ${defaultRoots}`,
      placeholder: defaultRoots,
      defaultValue: defaultRoots,
      validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
    });
    const allowedRoots = rootsAnswer
      .split(",")
      .map((root) => resolve(expandHomePath(root.trim())))
      .filter(Boolean);

    const defaultPort = String(files.config.port ?? 7676);
    const portAnswer = await textPrompt({
      message: `Which local port should DevSpace use? Press Enter to use ${defaultPort}`,
      placeholder: defaultPort,
      defaultValue: defaultPort,
      validate: validatePort,
    });
    const port = Number(portAnswer);

    prompts.note(
      [
        "DevSpace needs a public base URL so ChatGPT or Claude can reach this MCP server.",
        "Create a tunnel or reverse proxy with Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or your own HTTPS proxy.",
        "Paste the public origin here, without /mcp.",
        "",
        "Example: https://your-tunnel-host.example.com",
      ].join("\n"),
      "Public URL required",
    );
    const publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
      message: files.config.publicBaseUrl
        ? `What is the public base URL? Press Enter to keep ${files.config.publicBaseUrl}`
        : "What is the public base URL?",
      placeholder: files.config.publicBaseUrl ?? "https://your-tunnel-host.example.com",
      defaultValue: files.config.publicBaseUrl ?? "",
      validate: validateRequiredPublicBaseUrl,
    }));

    const config: DevspaceUserConfig = {
      host: files.config.host ?? "127.0.0.1",
      port,
      allowedRoots,
      publicBaseUrl,
    };
    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    const configPath = writeDevspaceConfig(config);
    const authPath = writeDevspaceAuth(auth);

    const lines = [
      `Config: ${configPath}`,
      `Auth: ${authPath}`,
      `Local MCP URL: http://${config.host}:${config.port}/mcp`,
      ...(publicBaseUrl ? [`Public MCP URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "DevSpace configured");
    prompts.note(
      [
        `Owner password: ${auth.ownerToken}`,
        "Use this when ChatGPT or Claude asks you to approve DevSpace access.",
        `Stored at: ${authPath}`,
      ].join("\n"),
      "Owner password",
    );
    prompts.outro("Run `devspace serve` to start the MCP server.");
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(): Promise<void> {
  const sqliteStatus = checkSqliteNative();
  if (sqliteStatus !== "ok") {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteStatus,
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const { createServer } = await import("./server.js");
  const config = loadConfig();
  const { app, close } = createServer(config);
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`devspace listening on http://${config.host}:${config.port}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because DEVSPACE_ALLOWED_HOSTS=*");
    }
    console.log("auth: Owner password approval required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
  });

  const shutdown = () => {
    httpServer.close(() => { close?.(); process.exit(0); });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runDoctor(): Promise<void> {
  const files = loadDevspaceFiles();
  console.log(`Config dir: ${files.dir}`);
  console.log(`Config file: ${files.configExists ? files.configPath : "missing"}`);
  console.log(`Auth file: ${files.authExists ? files.authPath : "missing"}`);
  console.log(`Node: ${process.version} (${nodeVersionStatus()})`);
  console.log(`Node ABI: ${process.versions.modules}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Git: ${checkGitAvailable()}`);
  console.log(`Bash shell: ${checkBashShell()}`);
  console.log(`SQLite native dependency: ${checkSqliteNative()}`);

  try {
    const config = loadConfig();
    console.log(`Local MCP URL: http://${config.host}:${config.port}/mcp`);
    console.log(`Public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`);
    console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`Root policies: ${config.rootPolicies.map((policy) => `${policy.path} [${policy.access}]${policy.aliases.length ? ` aliases=${policy.aliases.join(",")}` : ""}`).join("; ")}`);
    console.log(`Global instructions: ${config.globalInstructionsFile} (${existsSync(config.globalInstructionsFile) ? "present" : "missing"})`);
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
    console.log(`Shell: ${config.shell.path ?? "auto"} (${config.shell.mode})`);
    console.log(`Filtered child secret names: ${config.secretNames.join(", ")}`);
    console.log(`Terminals: ${config.terminals.backend} runtime=${config.terminals.runtimeDir} max=${config.terminals.maxPerWorkspace}/${config.terminals.maxTotal} idle=${config.terminals.idleTtlSeconds}s user-systemd=${config.terminals.useUserSystemd}`);
    console.log(`Maintenance: every ${config.maintenance.intervalSeconds}s closed=${config.maintenance.closedSessionTtlSeconds}s checkout=${config.maintenance.checkoutIdleTtlSeconds}s isolated=${config.maintenance.isolatedIdleTtlSeconds}s`);
    const effDisabled = config.disabledCapabilities ?? new Set<string>();
    const skyCua = config.skyCua ?? { projectRoot: resolve(expandHomePath("~/projects/sky-cua")), binPath: resolve(expandHomePath("~/projects/sky-cua/bin/sky-cua-client")) };
    const skillsWired = config.skillPaths.includes(join(skyCua.projectRoot, "skills"));
    console.log(`Disabled capabilities: ${effDisabled.size > 0 ? [...effDisabled].join(",") : "(none)"}`);
    console.log(`sky-cua: ${effDisabled.has("sky-cua") ? "disabled (global - per-session filter hides tools+skills)" : "enabled"} (projectRoot=${skyCua.projectRoot} bin=${skyCua.binPath} ${existsSync(skyCua.binPath) ? "bin present" : "bin missing"}; serviceSocket=${skyCua.serviceSocketPath ?? "(default)"} skills=${skillsWired ? (effDisabled.has("sky-cua") ? "wired but global disabled - per-session hidden" : "wired (per-session filter)") : "not wired"})`);

    const runtime = createShellRuntime(config.shell, config.secretNames);
    console.log(`Executor PATH: ${(runtime.environment.PATH ?? "").split(delimiter).filter(Boolean).join(delimiter)}`);
    try {
      const { stdout } = await runConfiguredShell(runtime, [
        "printf 'tmux=%s\\n' \"$(command -v tmux 2>/dev/null || true)\"",
        "printf 'opencode=%s\\n' \"$(command -v opencode 2>/dev/null || true)\"",
        "printf 'cargo=%s\\n' \"$(command -v cargo 2>/dev/null || true)\"",
        "printf 'uv=%s\\n' \"$(command -v uv 2>/dev/null || true)\"",
        "printf 'bun=%s\\n' \"$(command -v bun 2>/dev/null || true)\"",
        "printf 'npm=%s\\n' \"$(command -v npm 2>/dev/null || true)\"",
        "printf 'mise=%s\\n' \"$(command -v mise 2>/dev/null || true)\"",
        "if systemctl --user show-environment >/dev/null 2>&1; then echo user_systemd=available; else echo user_systemd=unavailable; fi",
        "if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then echo privilege_escalation=available; else echo privilege_escalation=unavailable; fi",
      ].join("; "), process.cwd(), 5_000);
      process.stdout.write(stdout);
    } catch (error) {
      console.log(`Shell capability probe: ${error instanceof Error ? error.message : String(error)}`);
    }

    const store = createWorkspaceStore(config.stateDir);
    try {
      const sessions = store.listSessions();
      console.log(`Workspace sessions: ${sessions.filter((session) => session.status === "active").length} active, ${sessions.filter((session) => session.status === "closed").length} closed`);
    } finally {
      store.close?.();
    }
  } catch (error) {
    console.log(`Config status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadDevspaceFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  if (key !== "publicBaseUrl") {
    throw new Error("Only `devspace config set publicBaseUrl <url|null>` is supported right now.");
  }

  const value = rest.join(" ").trim();
  if (!value) {
    throw new Error("Missing publicBaseUrl value.");
  }

  writeDevspaceConfig({
    ...files.config,
    publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
  });
  console.log(`Updated ${files.configPath}`);
}

async function runAuthCommand(args: string[]): Promise<void> {
  const [subcommand] = args;
  if (subcommand === "mint-key") {
    await runMintKey(args.slice(1));
    return;
  }
  if (subcommand === "revoke-key") {
    runRevokeKey(args.slice(1));
    return;
  }
  if (subcommand === "list-keys") {
    runListKeys(args.slice(1));
    return;
  }
  if (subcommand === "mint") {
    await runAuthMint(args.slice(1));
    return;
  }
  throw new Error("Usage: devspace auth mint|mint-key|revoke-key|list-keys [options]");
}
async function runAuthMint(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printAuthMintHelp("devspace");
    return;
  }
  const options = parseAuthMintArgs(args, "devspace");
  const destinationCount = Number(Boolean(options.output)) + Number(Boolean(options.hermesHome));
  if (destinationCount !== 1) {
    throw new Error("Specify exactly one of --output <file> or --hermes-home <directory>");
  }
  const hermesHome = options.hermesHome ? resolve(expandHomePath(options.hermesHome)) : undefined;
  if (hermesHome) await assertHermesOAuthConfigCompatible(hermesHome, options.serverName);
  let baseUrl = options.url ?? (process.env.DEVSPACE_PUBLIC_BASE_URL?.trim() || undefined);
  let ownerToken = options.ownerToken ?? (process.env.DEVSPACE_OAUTH_OWNER_TOKEN?.trim() || undefined);
  if (!baseUrl || !ownerToken) {
    const files = loadDevspaceFiles();
    baseUrl ||= files.config.publicBaseUrl ?? undefined;
    ownerToken ||= files.auth.ownerToken ?? undefined;
  }
  if (!baseUrl) throw new Error("OAuth server URL is required via --url, DEVSPACE_PUBLIC_BASE_URL, or DevSpace config");
  if (!ownerToken) throw new Error("OAuth owner password is required via --owner-token, DEVSPACE_OAUTH_OWNER_TOKEN, or DevSpace auth config");
  const bundle = await mintHeadlessOAuth({ baseUrl, ownerToken, clientName: options.clientName });
  if (hermesHome) {
    const paths = await writeHermesOAuthFiles(hermesHome, options.serverName, bundle);
    console.log(`Minted OAuth credentials and wrote ${paths.length} Hermes token files for '${options.serverName}'.`);
    return;
  }
  if (!options.output) throw new Error("Missing --output <file>");
  const outputPath = resolve(expandHomePath(options.output));
  await writeOAuthBundle(outputPath, bundle);
  console.log(`Minted OAuth credentials and wrote a protected bundle to ${outputPath}.`);
}

function resolveStateDir(args: string[]): string {
  const stateDirIndex = args.indexOf("--state-dir");
  if (stateDirIndex >= 0 && args[stateDirIndex + 1]) return resolve(args[stateDirIndex + 1]);
  const stateDir = process.env.DEVSPACE_STATE_DIR;
  if (stateDir) return resolve(stateDir);
  const files = loadDevspaceFiles();
  return resolve(files.config.stateDir ?? join(homedir(), ".local", "share", "devspace"));
}

function loadSupportedScopes(): string[] {
  const envScopes = process.env.DEVSPACE_OAUTH_SCOPES;
  if (envScopes) {
    return envScopes.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return ["devspace"];
}

async function runMintKey(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printMintKeyHelp("devspace");
    return;
  }
  const scopes: string[] = [];
  let ttlSeconds = DEFAULT_KEY_TTL_SECONDS;
  let keyId: string | undefined;
  let jsonOutput = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--scope") {
      const val = args[++i];
      if (!val || val.startsWith("--")) throw new Error("Missing value for --scope");
      scopes.push(val);
      continue;
    }
    if (flag === "--ttl") {
      const val = args[++i];
      if (!val || val.startsWith("--")) throw new Error("Missing value for --ttl");
      ttlSeconds = Number(val);
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) throw new Error("--ttl must be a positive integer");
      continue;
    }
    if (flag === "--key-id") {
      keyId = args[++i];
      if (!keyId || keyId.startsWith("--")) throw new Error("Missing value for --key-id");
      continue;
    }
    if (flag === "--json") { jsonOutput = true; continue; }
    if (flag === "--state-dir") { i++; continue; }
    throw new Error(`Unknown option: ${flag}`);
  }
  if (scopes.length === 0) scopes.push("devspace");
  const supported = loadSupportedScopes();
  const stateDir = resolveStateDir(args);
  const store = new StaticKeyStore(stateDir);
  try {
    const mcpUrl = new URL(process.env.DEVSPACE_PUBLIC_BASE_URL || "http://127.0.0.1:7676");
    const resource = new URL("/mcp", mcpUrl).href;
    const result = await mintApiKey(store, resource, { scopes, ttlSeconds, keyId }, supported);
    if (jsonOutput) {
      console.log(JSON.stringify({ key_id: result.keyId, raw_key: result.rawKey, scopes: result.scopes, expires_at: result.expiresAt, resource: result.resource }, null, 2));
    } else {
      console.log(`Static API key minted successfully.`);
      console.log(`Key ID: ${result.keyId}`);
      console.log(`Key:    ${result.rawKey}`);
      console.log(`Scopes: ${result.scopes.join(" ")}`);
      console.log(`Expires: ${new Date(result.expiresAt * 1000).toISOString()}`);
      console.log();
      console.log("Store this key securely. It will not be shown again.");
    }
  } finally {
    store.close();
  }
}

function runRevokeKey(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    printRevokeKeyHelp("devspace");
    return;
  }
  let keyId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--key-id") {
      keyId = args[++i];
      if (!keyId || keyId.startsWith("--")) throw new Error("Missing value for --key-id");
      continue;
    }
    if (args[i] === "--state-dir") { i++; continue; }
    throw new Error(`Unknown option: ${args[i]}`);
  }
  if (!keyId) throw new Error("--key-id is required");
  const stateDir = resolveStateDir(args);
  const store = new StaticKeyStore(stateDir);
  try {
    const deleted = store.deleteById(keyId);
    if (deleted) {
      console.log(`Revoked static API key: ${keyId}`);
    } else {
      console.log(`No key found with ID: ${keyId}`);
    }
  } finally {
    store.close();
  }
}

function runListKeys(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    printListKeysHelp("devspace");
    return;
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--state-dir") { i++; continue; }
    throw new Error(`Unknown option: ${args[i]}`);
  }
  const stateDir = resolveStateDir(args);
  const store = new StaticKeyStore(stateDir);
  try {
    const keys = store.listAll();
    if (keys.length === 0) {
      console.log("No static API keys found.");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    for (const key of keys) {
      const expired = key.expiresAt < now;
      console.log(`  ${key.keyId}  scopes=${key.scopes.join(",")}  expires=${new Date(key.expiresAt * 1000).toISOString()}${expired ? " [EXPIRED]" : ""}`);
    }
  } finally {
    store.close();
  }
}

function parseAuthMintArgs(args: string[], defaultServerName: string): {
  url?: string;
  ownerToken?: string;
  clientName: string;
  output?: string;
  hermesHome?: string;
  serverName: string;
} {
  const values: Record<string, string> = {};
  const flags = new Set(["--url", "--owner-token", "--client-name", "--output", "--hermes-home", "--server-name"]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flags.has(flag)) throw new Error(`Unknown auth mint option: ${flag}`);
    if (seen.has(flag)) throw new Error(`Duplicate auth mint option: ${flag}`);
    seen.add(flag);
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    values[flag] = value;
  }
  return {
    url: values["--url"],
    ownerToken: values["--owner-token"],
    clientName: values["--client-name"] ?? "Hermes Agent",
    output: values["--output"],
    hermesHome: values["--hermes-home"],
    serverName: values["--server-name"] ?? defaultServerName,
  };
}

function printAuthMintHelp(command: string): void {
  console.log([
    `Usage: ${command} auth mint [options]`,
    "",
    "  --output <file>             Write a portable OAuth bundle",
    "  --hermes-home <directory>   Write Hermes-native token files",
    "  --server-name <name>        Hermes server name",
    "  --url <base-url>            Override the OAuth server URL",
    "  --owner-token <password>    Override the owner approval password",
    "  --client-name <name>        Dynamic OAuth client name",
  ].join("\n"));
}

function printMintKeyHelp(command: string): void {
  console.log([
    `Usage: ${command} auth mint-key [options]`,
    "",
    "  --scope <scope>             Scope to grant (repeatable, default: devspace)",
    "  --ttl <seconds>             Key lifetime in seconds (default: 31536000)",
    "  --key-id <id>               Custom key ID (default: auto-generated)",
    "  --json                      Output key details as JSON",
    "  --state-dir <dir>           Override the state directory",
  ].join("\n"));
}

function printRevokeKeyHelp(command: string): void {
  console.log([
    `Usage: ${command} auth revoke-key [options]`,
    "",
    "  --key-id <id>               Key ID to revoke (required)",
    "  --state-dir <dir>           Override the state directory",
  ].join("\n"));
}

function printListKeysHelp(command: string): void {
  console.log([
    `Usage: ${command} auth list-keys [options]`,
    "",
    "  --state-dir <dir>           Override the state directory",
  ].join("\n"));
}

function printHelp(): void {
  console.log(
    [
      "DevSpace",
      "",
      "Usage:",
      "  devspace                 Run first-time setup if needed, then start the server",
      "  devspace serve           Start the server",
      "  devspace gateway --config <path>  Start the public gateway",
      "  devspace node --config <path>     Start the private node",
      "  devspace init            Create or update ~/.devspace/config.json and auth.json",
      "  devspace doctor          Show config, runtime, and native dependency status",
      "  devspace config get      Print persisted config",
      "  devspace config set publicBaseUrl <url|null>",
      "  devspace auth mint --output <file>|--hermes-home <directory> [options]",
      "  devspace auth mint-key [options]",
      "  devspace auth revoke-key --key-id <id>",
      "  devspace auth list-keys",
      "",
      "For temporary tunnels:",
      "  DEVSPACE_PUBLIC_BASE_URL=https://example.trycloudflare.com devspace serve",
    ].join("\n"),
  );
}

function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

type TextPromptOptions = Omit<Parameters<typeof prompts.text>[0], "validate"> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

function validatePort(value: string | undefined): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? undefined
    : "Enter a port between 1 and 65535.";
}

function validateRequiredPublicBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  return validatePublicBaseUrl(trimmed);
}

function validatePublicBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

function assertSupportedNode(): void {
  if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) return;

  throw new Error(
    [
      `DevSpace requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
        "Install Node 24 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

function nodeVersionStatus(): string {
  return satisfies(process.versions.node, SUPPORTED_NODE_RANGE)
    ? `supported ${SUPPORTED_NODE_RANGE}`
    : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}

class SetupCancelledError extends Error {}

function checkSqliteNative(): string {
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkGitAvailable(): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

function checkBashShell(): string {
  try {
    const { shell, args } = getShellConfig();
    return `${shell} ${args.join(" ")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
