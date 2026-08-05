import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getShellConfig, type BashSpawnHook } from "@earendil-works/pi-coding-agent";
import type { ShellConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface ShellRuntime {
  shellPath: string;
  mode: ShellConfig["mode"];
  environment: NodeJS.ProcessEnv;
  filteredSecretNames: string[];
}

export function createShellRuntime(
  config: ShellConfig,
  secretNames: string[],
  baseEnvironment: NodeJS.ProcessEnv = process.env,
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
  const filteredSecretNames = Array.from(new Set(secretNames.map((name) => name.trim()).filter(Boolean))).sort();
  for (const name of filteredSecretNames) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid DevSpace infrastructure secret name: ${name}`);
    delete environment[name];
  }

  return {
    shellPath,
    mode: config.mode,
    environment,
    filteredSecretNames,
  };
}

export function createDevspaceShellSpawnHook(runtime: ShellRuntime): BashSpawnHook {
  return ({ command, cwd }) => ({
    command: runtime.mode === "login"
      ? `exec ${shellQuote(runtime.shellPath)} -lc ${shellQuote(prepareShellCommand(runtime, command))}`
      : prepareShellCommand(runtime, command),
    cwd,
    env: { ...runtime.environment, PWD: cwd },
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
    env: { ...runtime.environment, PWD: cwd },
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
