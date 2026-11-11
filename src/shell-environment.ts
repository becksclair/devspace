import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { getShellConfig, type BashSpawnHook } from "@earendil-works/pi-coding-agent";
import type { ShellConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface ShellRuntime {
  shellPath: string;
  mode: ShellConfig["mode"];
  /** Environment captured when the runtime was created. Spawns use `currentShellEnvironment`. */
  environment: NodeJS.ProcessEnv;
  filteredSecretNames: string[];
  /** Graphical-session variables refreshed from the live session at each spawn. */
  sessionVariableNames: readonly string[];
  readSessionEnvironment?: SessionEnvironmentReader;
}

/** Returns live graphical-session variables, or undefined when the session source is unavailable. */
export type SessionEnvironmentReader = () => Readonly<Record<string, string>> | undefined;

/**
 * Variables a desktop session exports that GUI and screenshot tooling needs. A
 * long-running service may start before the session imports these into the
 * systemd user manager, so they are resolved at spawn time instead of startup.
 */
export const GRAPHICAL_SESSION_VARIABLES: readonly string[] = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
  "DESKTOP_SESSION",
  "KDE_FULL_SESSION",
  "KDE_SESSION_VERSION",
];

export interface ShellRuntimeOptions {
  /** Live session source; defaults to the systemd user manager on Linux. `false` disables it. */
  sessionEnvironment?: SessionEnvironmentReader | false;
}

export function createShellRuntime(
  config: ShellConfig,
  secretNames: string[],
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  options: ShellRuntimeOptions = {},
): ShellRuntime {
  const shellPath = getShellConfig(config.path).shell;
  for (const [name, value] of Object.entries(config.environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid configured shell environment name: ${name}`);
    if (value.includes("\0")) throw new Error(`Configured shell environment value contains NUL: ${name}`);
  }
  const environment: NodeJS.ProcessEnv = {
    ...baseEnvironment,
    ...(config.environment ?? {}),
  };
  environment.PATH = mergePathEntries(
    userExecutablePaths(environment),
    environment.PATH,
  ).join(delimiter);
  const filteredSecretNames = normalizeSecretNames(secretNames);
  for (const name of filteredSecretNames) delete environment[name];

  // Explicitly configured values and filtered secrets always win over the live session.
  const pinnedNames = new Set([...Object.keys(config.environment ?? {}), ...filteredSecretNames]);
  const readSessionEnvironment = options.sessionEnvironment === false
    ? undefined
    : options.sessionEnvironment ?? createSystemdSessionEnvironmentReader(environment);

  return {
    shellPath,
    mode: config.mode,
    environment,
    filteredSecretNames,
    sessionVariableNames: GRAPHICAL_SESSION_VARIABLES.filter((name) => !pinnedNames.has(name)),
    readSessionEnvironment,
  };
}

/** Live session values for the runtime's session variables; empty when no session source answers. */
export function sessionEnvironmentOverrides(runtime: ShellRuntime): Record<string, string> {
  const live = runtime.readSessionEnvironment?.();
  const overrides: Record<string, string> = {};
  if (!live) return overrides;
  for (const name of runtime.sessionVariableNames) {
    const value = live[name];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) overrides[name] = value;
  }
  return overrides;
}

/** The environment a child process should receive now: the startup snapshot plus the live session. */
export function currentShellEnvironment(runtime: ShellRuntime): NodeJS.ProcessEnv {
  const overrides = sessionEnvironmentOverrides(runtime);
  return Object.keys(overrides).length === 0 ? runtime.environment : { ...runtime.environment, ...overrides };
}

const SESSION_ENVIRONMENT_TTL_MS = 2_000;
// The query is synchronous, so back off longer after a failure to avoid
// repeatedly stalling the event loop on a wedged user bus.
const SESSION_ENVIRONMENT_FAILURE_TTL_MS = 30_000;
const SESSION_ENVIRONMENT_TIMEOUT_MS = 1_000;

export interface SystemdSessionEnvironmentReaderOptions {
  ttlMs?: number;
  failureTtlMs?: number;
  now?: () => number;
  /** Returns `busctl --json=short` output for the manager's Environment property. */
  query?: () => string;
}

/**
 * Reads the systemd user manager's environment (what `systemctl --user
 * show-environment` reports) over D-Bus, caching the result briefly. Returns
 * undefined off Linux, without a user bus, or when the query fails.
 */
export function createSystemdSessionEnvironmentReader(
  environment: NodeJS.ProcessEnv,
  options: SystemdSessionEnvironmentReaderOptions = {},
): SessionEnvironmentReader | undefined {
  if (!options.query && (process.platform !== "linux" || !(environment.XDG_RUNTIME_DIR || environment.DBUS_SESSION_BUS_ADDRESS))) {
    return undefined;
  }
  const ttlMs = options.ttlMs ?? SESSION_ENVIRONMENT_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? SESSION_ENVIRONMENT_FAILURE_TTL_MS;
  const now = options.now ?? Date.now;
  const query = options.query ?? (() => execFileSync("busctl", [
    "--user", "--json=short", "get-property",
    "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "Environment",
  ], {
    env: environment,
    encoding: "utf8",
    timeout: SESSION_ENVIRONMENT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  }));
  let cached: Record<string, string> | undefined;
  let expiresAt = -Infinity;
  return () => {
    const current = now();
    if (current < expiresAt) return cached;
    try {
      cached = parseManagerEnvironment(query());
      expiresAt = current + ttlMs;
    } catch {
      cached = undefined;
      expiresAt = current + failureTtlMs;
    }
    return cached;
  };
}

export function parseManagerEnvironment(output: string): Record<string, string> {
  const parsed = JSON.parse(output) as { type?: unknown; data?: unknown };
  if (parsed.type !== "as" || !Array.isArray(parsed.data)) throw new Error("Unexpected systemd manager Environment property");
  const environment: Record<string, string> = {};
  for (const entry of parsed.data) {
    if (typeof entry !== "string") continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
}

const BRIDGE_ALWAYS_STRIPPED = new Set(["DEVSPACE_OAUTH_OWNER_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]);

function normalizeSecretNames(secretNames: string[]): string[] {
  const names = Array.from(new Set(secretNames.map((name) => name.trim()).filter(Boolean))).sort();
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid DevSpace infrastructure secret name: ${name}`);
  }
  return names;
}

export function bridgeChildEnvironment(baseEnvironment: NodeJS.ProcessEnv, secretNames: string[]): Record<string, string> {
  const configured = new Set(normalizeSecretNames(secretNames));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseEnvironment)) {
    if (typeof value !== "string") continue;
    if (BRIDGE_ALWAYS_STRIPPED.has(name) || name.endsWith("_NODE_TOKEN") || configured.has(name)) continue;
    env[name] = value;
  }
  return env;
}

const GIT_ALWAYS_STRIPPED = new Set(["DEVSPACE_OAUTH_OWNER_TOKEN"]);
const registeredGitSecretNames = new Set<string>();

/**
 * Adds control-plane secret names that git children must never receive. The process
 * environment is process-wide, so the names accumulate for the life of the process.
 */
export function registerGitChildSecretNames(secretNames: string[]): void {
  for (const name of normalizeSecretNames(secretNames)) registeredGitSecretNames.add(name);
}

/**
 * Environment for git processes DevSpace starts itself (worktrees, clones, status probes,
 * review snapshots). Git runs repository-configured programs (hooks, fsmonitor, credential
 * helpers), so these children get the service environment minus DevSpace's control-plane
 * secrets. Development credentials such as GH_TOKEN are kept.
 */
export function gitChildEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(baseEnvironment)) {
    if (value === undefined) continue;
    if (GIT_ALWAYS_STRIPPED.has(name) || registeredGitSecretNames.has(name)) continue;
    environment[name] = value;
  }
  return { ...environment, ...overrides };
}

export function createDevspaceShellSpawnHook(runtime: ShellRuntime): BashSpawnHook {
  return ({ command, cwd }) => ({
    command: runtime.mode === "login"
      ? `exec ${shellQuote(runtime.shellPath)} -lc ${shellQuote(prepareShellCommand(runtime, command))}`
      : prepareShellCommand(runtime, command),
    cwd,
    env: { ...currentShellEnvironment(runtime), PWD: cwd },
  });
}

export async function runConfiguredShell(
  runtime: ShellRuntime,
  command: string,
  cwd: string,
  timeoutMs = 10_000,
): Promise<{ stdout: string; stderr: string }> {
  const preparedCommand = prepareShellCommand(runtime, command);
  const args = runtime.mode === "login" ? ["-lc", preparedCommand] : ["-c", preparedCommand];
  const result = await execFileAsync(runtime.shellPath, args, {
    cwd,
    env: { ...currentShellEnvironment(runtime), PWD: cwd },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export function prepareShellCommand(runtime: ShellRuntime, command: string): string {
  if (runtime.filteredSecretNames.length === 0) return command;
  return `unset ${runtime.filteredSecretNames.join(" ")} || exit 126; ${command}`;
}

type PathGroup = string | readonly (string | undefined)[] | undefined;

export function mergePathEntries(...groups: PathGroup[]): string[] {
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    const values = typeof group === "string" ? group.split(delimiter) : group ?? [];
    for (const value of values) {
      const entry = value?.trim();
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      entries.push(entry);
    }
  }

  return entries;
}

export function userExecutablePaths(environment: NodeJS.ProcessEnv): string[] {
  const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || homedir();
  const xdgDataHome = environment.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  const bunHome = environment.BUN_INSTALL?.trim() || join(home, ".bun");
  const cargoHome = environment.CARGO_HOME?.trim() || join(home, ".cargo");
  const miseDataDir = environment.MISE_DATA_DIR?.trim() || join(xdgDataHome, "mise");

  return mergePathEntries([
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(bunHome, "bin"),
    join(cargoHome, "bin"),
    join(miseDataDir, "shims"),
    environment.PNPM_HOME,
  ]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
