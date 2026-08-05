import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  configuredLogicalRoots,
  expandHomePath,
  normalizeRootPolicies,
  rootPoliciesFromStrings,
  type NormalizedRootPolicy,
  type RootPolicy,
} from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { loadDevspaceFiles } from "./user-config.js";

export type ToolNamingMode = "legacy" | "short";
export type WidgetMode = "off" | "changes" | "full";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  rootPolicies: NormalizedRootPolicy[];
  allowedHosts: string[];
  publicBaseUrl: string;
  minimalTools: boolean;
  toolNaming: ToolNamingMode;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  skillsEnabled: boolean;
  skillPaths: string[];
  agentDir: string;
  logging: LoggingConfig;
  shell: ShellConfig;
  secretNames: string[];
  terminals: TerminalConfig;
  maintenance: MaintenanceConfig;
}

export interface ShellConfig {
  path?: string;
  mode: "service" | "login";
  environment?: Record<string, string>;
}

export interface TerminalConfig {
  backend: "tmux";
  runtimeDir: string;
  maxPerWorkspace: number;
  maxTotal: number;
  idleTtlSeconds: number;
  useUserSystemd: boolean;
}

export interface MaintenanceConfig {
  intervalSeconds: number;
  closedSessionTtlSeconds: number;
  checkoutIdleTtlSeconds: number;
  isolatedIdleTtlSeconds: number;
}

/** Publicly exported parser helpers used by role-specific configuration. */
export { parsePort, parseAllowedRoots, parsePublicBaseUrl, localPublicBaseUrl };

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseRootPolicies(files: { roots?: RootPolicy[]; allowedRoots?: string[] }, env: NodeJS.ProcessEnv): NormalizedRootPolicy[] {
  const envPolicies = Boolean(env.DEVSPACE_ROOTS);
  const envLegacy = Boolean(env.DEVSPACE_ALLOWED_ROOTS);
  const filePolicies = Boolean(files.roots);
  const fileLegacy = Boolean(files.allowedRoots);
  if ((envPolicies && envLegacy) || (filePolicies && fileLegacy) || (envPolicies && fileLegacy) || (envLegacy && filePolicies)) {
    throw new Error("Root configuration cannot mix policy roots with legacy allowedRoots");
  }
  if (env.DEVSPACE_ROOTS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.DEVSPACE_ROOTS);
    } catch (error) {
      throw new Error("DEVSPACE_ROOTS must be valid JSON", { cause: error });
    }
    if (!Array.isArray(parsed)) throw new Error("DEVSPACE_ROOTS must be a JSON array");
    return normalizeRootPolicies(parsed as RootPolicy[]);
  }
  if (env.DEVSPACE_ALLOWED_ROOTS) {
    return normalizeRootPolicies(rootPoliciesFromStrings(parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS)));
  }
  if (files.roots) return normalizeRootPolicies(files.roots);
  return normalizeRootPolicies(rootPoliciesFromStrings(parseAllowedRoots(files.allowedRoots)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function parseMinimalTools(env: NodeJS.ProcessEnv): boolean {
  if (env.DEVSPACE_TOOL_MODE === "minimal") return true;
  if (env.DEVSPACE_TOOL_MODE === "full") return false;
  if (env.DEVSPACE_TOOL_MODE) {
    throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${env.DEVSPACE_TOOL_MODE}`);
  }
  if (env.DEVSPACE_MINIMAL_TOOLS !== undefined) return parseBoolean(env.DEVSPACE_MINIMAL_TOOLS);
  return true;
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => resolve(expandHomePath(entry))) ?? []
  );
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function stringValue(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseShellMode(value: string | undefined): ShellConfig["mode"] {
  if (!value || value === "service") return "service";
  if (value === "login") return "login";
  throw new Error(`Invalid DEVSPACE_SHELL_MODE: ${value}`);
}

function parseToolNaming(value: string | undefined): ToolNamingMode {
  if (!value || value === "short") return "short";
  if (value === "legacy") return "legacy";

  throw new Error(`Invalid DEVSPACE_TOOL_NAMING: ${value}`);
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
    format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
    requests: env.DEVSPACE_LOG_REQUESTS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_REQUESTS),
    assets: parseBoolean(env.DEVSPACE_LOG_ASSETS),
    toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS),
    trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY),
  };
}

function parseTerminalBackend(value: string | undefined): TerminalConfig["backend"] {
  if (!value || value === "tmux") return "tmux";
  throw new Error(`Invalid DEVSPACE_TERMINAL_BACKEND: ${value}`);
}

function parseWidgetMode(value: string | undefined): WidgetMode {
  if (!value || value === "full") return "full";
  if (value === "off" || value === "changes") return value;

  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for DevSpace OAuth. Run: devspace init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOAuthConfig(env: NodeJS.ProcessEnv, ownerToken: string | undefined): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(env.DEVSPACE_OAUTH_OWNER_TOKEN ?? ownerToken, "DEVSPACE_OAUTH_OWNER_TOKEN"),
    accessTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, ["devspace"]),
    allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "devspace");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".devspace", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];

  const rootPolicies = parseRootPolicies(files.config, env);
  const stateDir = resolve(expandHomePath(env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir()));
  return {
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    allowedRoots: configuredLogicalRoots(rootPolicies),
    rootPolicies,
    allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    minimalTools: parseMinimalTools(env),
    toolNaming: parseToolNaming(env.DEVSPACE_TOOL_NAMING),
    widgets: parseWidgetMode(env.DEVSPACE_WIDGETS),
    stateDir,
    worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    skillsEnabled: env.DEVSPACE_SKILLS === undefined ? true : parseBoolean(env.DEVSPACE_SKILLS),
    skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
    agentDir: resolve(expandHomePath(env.DEVSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
    logging: parseLoggingConfig(env),
    shell: {
      path: env.DEVSPACE_SHELL_PATH ?? files.config.shell?.path,
      mode: parseShellMode(env.DEVSPACE_SHELL_MODE ?? files.config.shell?.mode),
      environment: files.config.shell?.environment,
    },
    secretNames: Array.from(new Set(["DEVSPACE_OAUTH_OWNER_TOKEN", ...(env.DEVSPACE_INFRA_SECRET_NAMES ?? "").split(",").map((name) => name.trim()).filter(Boolean)])),
    terminals: {
      backend: parseTerminalBackend(env.DEVSPACE_TERMINAL_BACKEND ?? files.config.terminals?.backend),
      runtimeDir: resolve(expandHomePath(env.DEVSPACE_TERMINAL_RUNTIME_DIR ?? files.config.terminals?.runtimeDir ?? join(stateDir, "terminal-runtime"))),
      maxPerWorkspace: parsePositiveInteger(env.DEVSPACE_TERMINAL_MAX_PER_WORKSPACE ?? stringValue(files.config.terminals?.maxPerWorkspace), 4, "DEVSPACE_TERMINAL_MAX_PER_WORKSPACE"),
      maxTotal: parsePositiveInteger(env.DEVSPACE_TERMINAL_MAX_TOTAL ?? stringValue(files.config.terminals?.maxTotal), 12, "DEVSPACE_TERMINAL_MAX_TOTAL"),
      idleTtlSeconds: parsePositiveInteger(env.DEVSPACE_TERMINAL_IDLE_TTL_SECONDS ?? stringValue(files.config.terminals?.idleTtlSeconds), 8 * 60 * 60, "DEVSPACE_TERMINAL_IDLE_TTL_SECONDS"),
      useUserSystemd: env.DEVSPACE_TERMINAL_USER_SYSTEMD === undefined
        ? files.config.terminals?.useUserSystemd ?? true
        : parseBoolean(env.DEVSPACE_TERMINAL_USER_SYSTEMD),
    },
    maintenance: {
      intervalSeconds: parsePositiveInteger(env.DEVSPACE_MAINTENANCE_INTERVAL_SECONDS ?? stringValue(files.config.maintenance?.intervalSeconds), 3600, "DEVSPACE_MAINTENANCE_INTERVAL_SECONDS"),
      closedSessionTtlSeconds: parsePositiveInteger(env.DEVSPACE_CLOSED_SESSION_TTL_SECONDS ?? stringValue(files.config.maintenance?.closedSessionTtlSeconds), 7 * 24 * 60 * 60, "DEVSPACE_CLOSED_SESSION_TTL_SECONDS"),
      checkoutIdleTtlSeconds: parsePositiveInteger(env.DEVSPACE_CHECKOUT_IDLE_TTL_SECONDS ?? stringValue(files.config.maintenance?.checkoutIdleTtlSeconds), 30 * 24 * 60 * 60, "DEVSPACE_CHECKOUT_IDLE_TTL_SECONDS"),
      isolatedIdleTtlSeconds: parsePositiveInteger(env.DEVSPACE_ISOLATED_IDLE_TTL_SECONDS ?? stringValue(files.config.maintenance?.isolatedIdleTtlSeconds), 7 * 24 * 60 * 60, "DEVSPACE_ISOLATED_IDLE_TTL_SECONDS"),
    },
  };
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
