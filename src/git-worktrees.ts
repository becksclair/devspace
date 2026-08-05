import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";

const execFileAsync = promisify(execFile);

export class GitWorktreeError extends Error {
  constructor(
    readonly code:
      | "GIT_NOT_AVAILABLE"
      | "GIT_REPOSITORY_NOT_FOUND"
      | "GIT_REPOSITORY_HAS_NO_COMMITS"
      | "GIT_INVALID_BASE_REF"
      | "GIT_WORKTREE_CREATE_FAILED"
      | "GIT_CLONE_CREATE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "GitWorktreeError";
  }
}

export interface ManagedWorktree {
  sourceRoot: string;
  sourceCanonicalRoot: string;
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
  strategy: "worktree" | "clone";
}

export async function createManagedWorktree(input: {
  sourcePath: string;
  baseRef?: string;
  config: ServerConfig;
}): Promise<ManagedWorktree> {
  const source = await inspectSource(input);
  const worktreePath = await prepareManagedPath(input.config, source.sourceRoot);
  try {
    await git(["worktree", "add", "--detach", worktreePath, source.baseSha], source.sourceRoot);
  } catch (error) {
    await rm(worktreePath, { recursive: true, force: true });
    throw new GitWorktreeError("GIT_WORKTREE_CREATE_FAILED", `Git failed to create the managed worktree. ${errorMessage(error)}`);
  }
  return { ...source, path: worktreePath, detached: true, managed: true, strategy: "worktree" };
}

export async function createManagedIsolatedWorkspace(input: {
  sourcePath: string;
  baseRef?: string;
  config: ServerConfig;
  allowSourceMetadataWrite?: boolean;
}): Promise<ManagedWorktree> {
  const source = await inspectSource(input);
  if (input.allowSourceMetadataWrite !== false && await gitMetadataWritable(source.sourceRoot)) {
    return createManagedWorktree(input);
  }

  const clonePath = await prepareManagedPath(input.config, source.sourceRoot);
  try {
    await git(["clone", "--no-local", "--no-checkout", source.sourceRoot, clonePath], dirname(clonePath));
    await git(["checkout", "--detach", source.baseSha], clonePath);
    await preserveNetworkOrigin(source.sourceRoot, clonePath);
  } catch (error) {
    await rm(clonePath, { recursive: true, force: true });
    throw new GitWorktreeError("GIT_CLONE_CREATE_FAILED", `Git failed to create the managed clone. ${errorMessage(error)}`);
  }

  return { ...source, path: clonePath, detached: true, managed: true, strategy: "clone" };
}

async function inspectSource(input: { sourcePath: string; baseRef?: string; config: ServerConfig }) {
  const sourcePath = assertAllowedPath(input.sourcePath, input.config.allowedRoots);
  try {
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isDirectory()) {
      throw new GitWorktreeError("GIT_REPOSITORY_NOT_FOUND", `Cannot open workspace because the source path is not a directory: ${input.sourcePath}`);
    }
  } catch (error) {
    if (error instanceof GitWorktreeError) throw error;
    throw new GitWorktreeError("GIT_REPOSITORY_NOT_FOUND", `Cannot open workspace because the source path does not exist: ${input.sourcePath}`);
  }

  const sourceRoot = await resolveGitRoot(sourcePath, input.config.allowedRoots);
  const sourceCanonicalRoot = await realpath(sourceRoot);
  const baseRef = input.baseRef ?? "HEAD";
  const baseSha = await resolveBaseCommit(sourceRoot, baseRef);
  const dirtySource = (await git(["status", "--porcelain=v1"], sourceRoot)).trim().length > 0;
  return { sourceRoot, sourceCanonicalRoot, baseRef, baseSha, dirtySource };
}

async function prepareManagedPath(config: ServerConfig, sourceRoot: string): Promise<string> {
  await mkdir(config.worktreeRoot, { recursive: true });
  const path = managedWorktreePath({ worktreeRoot: config.worktreeRoot, repoRoot: sourceRoot });
  assertAllowedPath(path, [config.worktreeRoot]);
  return path;
}

async function resolveGitRoot(path: string, allowedRoots: string[]): Promise<string> {
  try {
    const output = await git(["rev-parse", "--show-toplevel"], path);
    return await assertGitRootAllowed(output.trim(), allowedRoots);
  } catch (error) {
    if (isGitUnavailable(error)) {
      throw new GitWorktreeError("GIT_NOT_AVAILABLE", "Cannot open workspace because Git is not available on this machine.");
    }
    if (error instanceof GitWorktreeError) throw error;
    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace because this path is not inside a Git repository: ${path}. Use mode=\"checkout\" or initialize Git first.`,
    );
  }
}

async function assertGitRootAllowed(gitRoot: string, allowedRoots: string[]): Promise<string> {
  try {
    return assertAllowedPath(gitRoot, allowedRoots);
  } catch {
    const canonicalGitRoot = await realpath(gitRoot);
    for (const allowedRoot of allowedRoots) {
      const canonicalAllowedRoot = await realpath(allowedRoot).catch(() => undefined);
      if (!canonicalAllowedRoot || !isPathInsideRoot(canonicalGitRoot, canonicalAllowedRoot)) continue;
      const logicalGitRoot = resolve(allowedRoot, relative(canonicalAllowedRoot, canonicalGitRoot));
      return assertAllowedPath(logicalGitRoot, allowedRoots);
    }
    return assertAllowedPath(canonicalGitRoot, allowedRoots);
  }
}

async function resolveBaseCommit(sourceRoot: string, baseRef: string): Promise<string> {
  try {
    return (await git(["rev-parse", "--verify", `${baseRef}^{commit}`], sourceRoot)).trim();
  } catch (error) {
    if (baseRef === "HEAD") {
      throw new GitWorktreeError("GIT_REPOSITORY_HAS_NO_COMMITS", "Cannot open workspace because the repository has no commits yet.");
    }
    throw new GitWorktreeError("GIT_INVALID_BASE_REF", `baseRef ${JSON.stringify(baseRef)} does not resolve to a commit.`);
  }
}

async function gitMetadataWritable(sourceRoot: string): Promise<boolean> {
  try {
    const raw = (await git(["rev-parse", "--git-common-dir"], sourceRoot)).trim();
    const common = await realpath(isAbsolute(raw) ? raw : resolve(sourceRoot, raw));
    const probe = join(common, `.devspace-git-probe-${process.pid}-${randomBytes(4).toString("hex")}`);
    const handle = await open(probe, "wx", 0o600);
    await handle.close();
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function preserveNetworkOrigin(sourceRoot: string, clonePath: string): Promise<void> {
  const sourceOrigin = (await git(["remote", "get-url", "origin"], sourceRoot).catch(() => "")).trim();
  if (!sourceOrigin || isLocalRemote(sourceOrigin)) {
    await git(["remote", "remove", "origin"], clonePath).catch(() => "");
    return;
  }
  await git(["remote", "set-url", "origin", sourceOrigin], clonePath);
}

function isLocalRemote(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("./") || value.startsWith("../") || value.startsWith("file:");
}

function managedWorktreePath(input: { worktreeRoot: string; repoRoot: string }): string {
  const repoName = sanitizePathSegment(basename(input.repoRoot)) || "repo";
  return join(input.worktreeRoot, `${repoName}-${randomBytes(4).toString("hex")}`);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (isGitUnavailable(error)) throw error;
    const stderr = typeof error === "object" && error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
    const stdout = typeof error === "object" && error && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "").trim() : "";
    throw new Error(stderr || stdout || errorMessage(error));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGitUnavailable(error: unknown): boolean {
  return Boolean(typeof error === "object" && error && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
