import { mkdtemp, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isPathInsideRoot, type RootAccess } from "./roots.js";
import type { ShellRuntime } from "./shell-environment.js";
import { runConfiguredShell } from "./shell-environment.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceCapabilities {
  logicalRoot: string;
  canonicalRoot: string;
  fileAccess: RootAccess;
  mountReadOnly: boolean;
  git?: {
    repositoryRoot: string;
    commonDirectory: string;
    head: string;
    branch?: string;
    dirty: boolean;
    worktreeAvailable: boolean;
    cloneAvailable: boolean;
    gitMetadataWritable: boolean;
  };
  runtime: {
    shellPath: string;
    shellMode: "service" | "login";
    tmux: boolean;
    opencode?: string;
    userSystemd: boolean;
    privilegeEscalation: "unavailable" | "available" | "unknown";
    filteredSecretNames: string[];
  };
  warnings: string[];
}

export async function probeWorkspaceCapabilities(input: {
  logicalRoot: string;
  canonicalRoot: string;
  policyAccess: RootAccess;
  worktreeRoot: string;
  shellRuntime: ShellRuntime;
}): Promise<WorkspaceCapabilities> {
  const mountReadOnly = await isReadOnlyMount(input.canonicalRoot);
  const writable = input.policyAccess === "read-write" && !mountReadOnly && await probeDirectoryWrite(input.canonicalRoot);
  const fileAccess: RootAccess = writable ? "read-write" : "read-only";
  const runtime = await probeRuntime(input.logicalRoot, input.shellRuntime);
  const git = await probeGit(input.logicalRoot, input.worktreeRoot, input.policyAccess === "read-write" && !mountReadOnly);
  const warnings: string[] = [];

  if (fileAccess === "read-only") {
    warnings.push("Checkout is read-only. Reopen with mode=\"isolated\" when writable isolated workspaces are available.");
  } else if (git && !git.gitMetadataWritable) {
    warnings.push("Checkout files are writable but Git metadata is read-only. A managed worktree cannot be created from this source.");
  }
  if (runtime.privilegeEscalation === "available") {
    warnings.push("Shell execution is root-capable through the host sudo policy.");
  }

  return {
    logicalRoot: input.logicalRoot,
    canonicalRoot: input.canonicalRoot,
    fileAccess,
    mountReadOnly,
    git,
    runtime,
    warnings,
  };
}

async function probeRuntime(logicalRoot: string, shellRuntime: ShellRuntime): Promise<WorkspaceCapabilities["runtime"]> {
  const command = [
    "printf 'tmux=%s\\n' \"$(command -v tmux 2>/dev/null || true)\"",
    "printf 'opencode=%s\\n' \"$(command -v opencode 2>/dev/null || true)\"",
    "if systemctl --user show-environment >/dev/null 2>&1; then echo user_systemd=1; else echo user_systemd=0; fi",
    "if command -v sudo >/dev/null 2>&1; then if sudo -n true >/dev/null 2>&1; then echo sudo=available; else echo sudo=unavailable; fi; else echo sudo=unavailable; fi",
  ].join("; ");

  try {
    const { stdout } = await runConfiguredShell(shellRuntime, command, logicalRoot, 5_000);
    const values = Object.fromEntries(stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      return separator === -1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    return {
      shellPath: shellRuntime.shellPath,
      shellMode: shellRuntime.mode,
      tmux: Boolean(values.tmux),
      opencode: values.opencode || undefined,
      userSystemd: values.user_systemd === "1",
      privilegeEscalation: values.sudo === "available" ? "available" : "unavailable",
      filteredSecretNames: shellRuntime.filteredSecretNames,
    };
  } catch {
    return {
      shellPath: shellRuntime.shellPath,
      shellMode: shellRuntime.mode,
      tmux: false,
      userSystemd: false,
      privilegeEscalation: "unknown",
      filteredSecretNames: shellRuntime.filteredSecretNames,
    };
  }
}

async function probeGit(cwd: string, worktreeRoot: string, allowWriteProbe: boolean): Promise<WorkspaceCapabilities["git"] | undefined> {
  try {
    const repositoryRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    const commonRaw = (await git(cwd, ["rev-parse", "--git-common-dir"])).trim();
    const commonDirectory = await realpath(isAbsolute(commonRaw) ? commonRaw : resolve(cwd, commonRaw));
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    const branchRaw = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
    const dirty = (await git(cwd, ["status", "--porcelain=v1"])).trim().length > 0;
    const gitMetadataWritable = allowWriteProbe && await probeDirectoryWrite(commonDirectory);
    const cloneAvailable = await probeCloneRoot(worktreeRoot);
    return {
      repositoryRoot,
      commonDirectory,
      head,
      branch: branchRaw || undefined,
      dirty,
      worktreeAvailable: gitMetadataWritable && cloneAvailable,
      cloneAvailable,
      gitMetadataWritable,
    };
  } catch {
    return undefined;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}

async function probeCloneRoot(path: string): Promise<boolean> {
  let parent = resolve(path);
  while (true) {
    try {
      if ((await stat(parent)).isDirectory()) break;
      return false;
    } catch {
      const next = dirname(parent);
      if (next === parent) return false;
      parent = next;
    }
  }

  let probe: string | undefined;
  try {
    probe = await mkdtemp(join(parent, ".devspace-clone-probe-"));
    return true;
  } catch {
    return false;
  } finally {
    if (probe) await rm(probe, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function probeDirectoryWrite(directory: string): Promise<boolean> {
  const name = `.devspace-write-probe-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const path = join(directory, name);
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.close();
    await rm(path, { force: true });
    return true;
  } catch {
    await rm(path, { force: true }).catch(() => undefined);
    return false;
  }
}

async function isReadOnlyMount(path: string): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
    const canonical = await realpath(path);
    let best: { mountPoint: string; readOnly: boolean } | undefined;
    for (const line of mountInfo.split("\n")) {
      if (!line) continue;
      const separator = line.indexOf(" - ");
      if (separator === -1) continue;
      const fields = line.slice(0, separator).split(" ");
      if (fields.length < 6) continue;
      const mountPoint = decodeMountInfo(fields[4] ?? "");
      if (!isPathInsideRoot(canonical, mountPoint)) continue;
      const options = new Set((fields[5] ?? "").split(","));
      if (!best || mountPoint.length > best.mountPoint.length) {
        best = { mountPoint, readOnly: options.has("ro") };
      }
    }
    return best?.readOnly ?? false;
  } catch {
    return false;
  }
}

function decodeMountInfo(value: string): string {
  return value.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\012/g, "\n").replace(/\\134/g, "\\");
}
