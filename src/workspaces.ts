import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, opendir, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { MaintenanceConfig, ServerConfig } from "./config.js";
import { createManagedIsolatedWorkspace, createManagedWorktree, type ManagedWorktree } from "./git-worktrees.js";
import {
  AccessDeniedError,
  assertAllowedPath,
  authorizeWorkspacePath,
  canonicalTarget,
  expandHomePath,
  findCanonicalPolicy,
  isPathInsideRoot,
  policyById,
  type RootAccess,
} from "./roots.js";
import {
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  type LoadedSkills,
  type SkillReadResolution,
} from "./skills.js";
import { createShellRuntime, type ShellRuntime } from "./shell-environment.js";
import { probeWorkspaceCapabilities, type WorkspaceCapabilities } from "./workspace-capabilities.js";
import type { WorkspaceMode, WorkspaceSession, WorkspaceStore } from "./workspace-store.js";

export interface LoadedAgentsFile {
  path: string;
  content: string;
}

export interface AvailableAgentsFile {
  path: string;
}

export interface WorkspaceWorktree {
  path: string;
  sourceCanonicalRoot: string;
  strategy: "worktree" | "clone";
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  rootDevice: string;
  rootInode: string;
  detached: boolean;
  managed: boolean;
}

export interface Workspace {
  id: string;
  root: string;
  canonicalRoot: string;
  rootPolicyId: string;
  access: RootAccess;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
  skills: LoadedSkills["skills"];
  skillDiagnostics: LoadedSkills["diagnostics"];
  activatedSkillDirs: Set<string>;
}

export interface WorkspaceContext {
  workspace: Workspace;
  capabilities: WorkspaceCapabilities;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
}

export interface WorkspaceReadPath {
  absolutePath: string;
  logicalPath: string;
  readRoots: string[];
  skillRead?: SkillReadResolution;
}

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
  create?: boolean;
  fresh?: boolean;
}

const execFileAsync = promisify(execFile);

export interface WorkspaceCloseResult {
  workspaceId: string;
  mode: WorkspaceMode;
  closed: boolean;
  removed: boolean;
  retainedPath?: string;
  dirty: boolean;
  reason?: string;
}

export interface WorkspaceMaintenanceResult {
  prunedWorkspaceIds: string[];
  removedPaths: string[];
  retainedDirty: Array<{ workspaceId: string; path: string }>;
  retainedUnsafe: Array<{ workspaceId: string; path: string; reason: string }>;
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  readonly shellRuntime: ShellRuntime;

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {
    this.shellRuntime = createShellRuntime(config.shell, config.secretNames);
  }

  async openWorkspace(input: string | OpenWorkspaceInput): Promise<WorkspaceContext> {
    const options = typeof input === "string" ? { path: input } : input;
    const mode = options.mode ?? "checkout";

    if (mode === "worktree") {
      if (options.create) throw new Error("create is only valid for checkout mode");
      if (options.fresh) throw new Error("fresh is only valid for checkout mode");
      return this.openWorktreeWorkspace(options.path, options.baseRef);
    }
    if (mode === "isolated") {
      if (options.create) throw new Error("create is only valid for checkout mode");
      if (options.fresh) throw new Error("fresh is only valid for checkout mode");
      return this.openIsolatedWorkspace(options.path, options.baseRef);
    }

    return this.openCheckoutWorkspace(options.path, options.create === true, options.fresh === true);
  }

  getWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      this.store?.touchSession(workspaceId);
      return workspace;
    }

    const session = this.store?.getSession(workspaceId);
    if (!session) throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    if (session.status !== "active") throw new Error(`Workspace is not active: ${workspaceId}`);

    const restoredWorkspace = this.restoreWorkspace(session);
    this.store?.touchSession(workspaceId);
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);
    return restoredWorkspace;
  }

  hasActiveWorkspace(workspaceId: string): boolean {
    if (this.store) return this.store.getSession(workspaceId)?.status === "active";
    return this.workspaces.has(workspaceId);
  }

  async workspaceStatus(workspaceId: string): Promise<{ workspace: Workspace; capabilities: WorkspaceCapabilities }> {
    const workspace = this.getWorkspace(workspaceId);
    return { workspace, capabilities: await this.probeCapabilities(workspace) };
  }

  async closeWorkspace(workspaceId: string): Promise<WorkspaceCloseResult> {
    const workspace = this.getWorkspace(workspaceId);
    let removed = false;
    let dirty = false;
    let retainedPath: string | undefined;
    let reason: string | undefined;

    if (workspace.worktree?.managed) {
      const identity = await this.verifyManagedWorkspaceIdentity(
        workspace.root,
        workspace.canonicalRoot,
        workspace.worktree.rootDevice,
        workspace.worktree.rootInode,
      );
      if (!identity.ok) {
        retainedPath = workspace.root;
        reason = identity.reason;
      } else {
        dirty = await this.managedWorkspaceDirty(identity.canonicalRoot);
        if (dirty) {
          retainedPath = workspace.root;
          reason = "managed workspace contains uncommitted changes";
        } else if (workspace.worktree.strategy === "clone") {
          await rm(identity.canonicalRoot, { recursive: true, force: true });
          removed = true;
        } else if (workspace.sourceRoot) {
          const sourceIdentity = await this.verifySourceIdentity(workspace.sourceRoot, workspace.worktree.sourceCanonicalRoot);
          if (!sourceIdentity.ok) {
            retainedPath = workspace.root;
            reason = sourceIdentity.reason;
          } else {
            try {
              await execFileAsync("git", ["worktree", "remove", "--force", workspace.root], { cwd: sourceIdentity.canonicalRoot, maxBuffer: 2 * 1024 * 1024 });
              removed = true;
            } catch (error) {
              retainedPath = workspace.root;
              reason = `git worktree removal failed: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
        }
      }
    }

    this.store?.closeSession(workspaceId);
    this.workspaces.delete(workspaceId);
    return { workspaceId, mode: workspace.mode, closed: true, removed, retainedPath, dirty, reason };
  }

  async maintenance(
    policy: MaintenanceConfig,
    now = Date.now(),
    protectedWorkspaceIds: ReadonlySet<string> = new Set(),
  ): Promise<WorkspaceMaintenanceResult> {
    const result: WorkspaceMaintenanceResult = { prunedWorkspaceIds: [], removedPaths: [], retainedDirty: [], retainedUnsafe: [] };
    if (!this.store) return result;

    for (const session of this.store.listSessions()) {
      if (protectedWorkspaceIds.has(session.id)) continue;
      const idleMs = now - Date.parse(session.lastUsedAt);
      if (session.status === "closed") {
        if (idleMs >= policy.closedSessionTtlSeconds * 1000) {
          this.store.deleteSession(session.id);
          this.workspaces.delete(session.id);
          result.prunedWorkspaceIds.push(session.id);
        }
        continue;
      }

      if (session.mode === "checkout") {
        if (idleMs >= policy.checkoutIdleTtlSeconds * 1000) {
          this.store.closeSession(session.id);
          this.store.deleteSession(session.id);
          this.workspaces.delete(session.id);
          result.prunedWorkspaceIds.push(session.id);
        }
        continue;
      }

      if (idleMs < policy.isolatedIdleTtlSeconds * 1000) continue;
      const cleanup = await this.cleanupStoredManagedWorkspace(session);
      if (cleanup.dirty) {
        result.retainedDirty.push({ workspaceId: session.id, path: session.root });
        continue;
      }
      if (cleanup.reason) {
        result.retainedUnsafe.push({ workspaceId: session.id, path: session.root, reason: cleanup.reason });
        continue;
      }
      if (!cleanup.removed) continue;
      this.store.closeSession(session.id);
      this.store.deleteSession(session.id);
      this.workspaces.delete(session.id);
      result.prunedWorkspaceIds.push(session.id);
      result.removedPaths.push(session.root);
    }
    this.store.checkpoint();
    return result;
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    return this.resolveWorkspaceTarget(workspace, inputPath, "read").canonicalPath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    try {
      const target = this.resolveWorkspaceTarget(workspace, inputPath, "read");
      return {
        absolutePath: target.canonicalPath,
        logicalPath: target.logicalPath,
        readRoots: this.fileReadRoots(workspace),
      };
    } catch (workspaceError) {
      const skillRead = resolveSkillReadPath(workspace.skills, workspace.activatedSkillDirs, inputPath);
      if (!skillRead) throw workspaceError;
      return {
        absolutePath: skillRead.absolutePath,
        logicalPath: skillRead.absolutePath,
        readRoots: [workspace.canonicalRoot, skillRead.skill.baseDir],
        skillRead,
      };
    }
  }

  resolveWritePath(workspace: Workspace, inputPath: string): string {
    return this.resolveWorkspaceTarget(workspace, inputPath, "write").canonicalPath;
  }

  resolveOptionalSearchPath(workspace: Workspace, inputPath: string | undefined): string | undefined {
    return inputPath === undefined ? undefined : this.resolveWorkspaceTarget(workspace, inputPath, "read").canonicalPath;
  }

  markReadPathLoaded(workspace: Workspace, readPath: WorkspaceReadPath): void {
    if (readPath.skillRead?.isSkillFile) markSkillActivated(workspace.activatedSkillDirs, readPath.skillRead.skill);
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    if (!workingDirectory) return workspace.root;
    const target = this.resolveWorkspaceTarget(workspace, workingDirectory, "read");
    return target.logicalPath;
  }

  private async openCheckoutWorkspace(path: string, create: boolean, fresh: boolean): Promise<WorkspaceContext> {
    let authorized;
    try {
      authorized = authorizeWorkspacePath(path, this.config.rootPolicies, create ? "write" : "read", { allowMissing: create });
    } catch (error) {
      if (!create && error instanceof AccessDeniedError && error.message.startsWith("Path does not exist:")) {
        throw new Error(`${error.message}. Pass create=true to create it explicitly.`);
      }
      throw error;
    }

    if (create) {
      await mkdir(authorized.canonicalPath, { recursive: true });
      authorized = authorizeWorkspacePath(path, this.config.rootPolicies, "write");
    }

    const rootStats = await stat(authorized.canonicalPath);
    if (!rootStats.isDirectory()) throw new Error(`Workspace root must be a directory: ${path}`);

    if (!fresh) {
      const reusable = this.findReusableCheckout(authorized.logicalPath, authorized.canonicalPath);
      if (reusable) {
        this.store?.touchSession(reusable.id);
        return this.hydrateWorkspaceContext(reusable);
      }
    }

    return this.createWorkspaceContext({
      root: authorized.logicalPath,
      canonicalRoot: authorized.canonicalPath,
      rootPolicyId: authorized.policy.id,
      access: authorized.policy.access,
      mode: "checkout",
    });
  }

  private async openWorktreeWorkspace(path: string, baseRef: string | undefined): Promise<WorkspaceContext> {
    const source = authorizeWorkspacePath(path, this.config.rootPolicies, "write");
    const worktree = await createManagedWorktree({ sourcePath: source.logicalPath, baseRef, config: this.config });
    return this.createManagedWorkspaceContext("worktree", worktree);
  }

  private async openIsolatedWorkspace(path: string, baseRef: string | undefined): Promise<WorkspaceContext> {
    const source = authorizeWorkspacePath(path, this.config.rootPolicies, "read");
    const isolated = await createManagedIsolatedWorkspace({
      sourcePath: source.logicalPath,
      baseRef,
      config: this.config,
      allowSourceMetadataWrite: source.policy.access === "read-write",
    });
    return this.createManagedWorkspaceContext("isolated", isolated);
  }

  private async createManagedWorkspaceContext(mode: "worktree" | "isolated", worktree: ManagedWorktree): Promise<WorkspaceContext> {
    const identity = await managedPathIdentity(worktree.path);
    const managedWorktree = { ...worktree, rootDevice: identity.device, rootInode: identity.inode };
    try {
      return await this.createWorkspaceContext({
        root: worktree.path,
        canonicalRoot: identity.canonicalRoot,
        rootPolicyId: mode === "isolated" ? "managed-isolated" : "managed-worktree",
        access: "read-write",
        mode,
        sourceRoot: worktree.sourceRoot,
        worktree: managedWorktree,
      });
    } catch (error) {
      try {
        await this.removeFreshManagedWorkspace(worktree, identity.canonicalRoot);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Failed to open managed workspace ${worktree.path} and could not remove it`);
      }
      throw error;
    }
  }

  private async createWorkspaceContext(input: {
    root: string;
    canonicalRoot: string;
    rootPolicyId: string;
    access: RootAccess;
    mode: WorkspaceMode;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
  }): Promise<WorkspaceContext> {
    const workspace: Workspace = {
      id: `ws_${randomUUID()}`,
      root: input.root,
      canonicalRoot: input.canonicalRoot,
      rootPolicyId: input.rootPolicyId,
      access: input.access,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
      ...this.loadSkillsForWorkspace(input.root),
      activatedSkillDirs: new Set(),
    };

    const context = await this.hydrateWorkspaceContext(workspace);

    this.store?.createSession({
      id: workspace.id,
      root: workspace.root,
      canonicalRoot: workspace.canonicalRoot,
      rootPolicyId: workspace.rootPolicyId,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      sourceCanonicalRoot: workspace.worktree?.sourceCanonicalRoot,
      strategy: workspace.worktree?.strategy,
      sourceDirty: workspace.worktree?.dirtySource,
      managedDevice: workspace.worktree?.rootDevice,
      managedInode: workspace.worktree?.rootInode,
      baseRef: workspace.worktree?.baseRef,
      baseSha: workspace.worktree?.baseSha,
      managed: workspace.worktree?.managed,
    });
    this.workspaces.set(workspace.id, workspace);
    return context;
  }

  private async hydrateWorkspaceContext(workspace: Workspace): Promise<WorkspaceContext> {
    const [capabilities, agentsFiles, availableAgentsFiles] = await Promise.all([
      this.probeCapabilities(workspace),
      Promise.resolve(this.loadInitialAgentsFiles(workspace)),
      this.findAvailableAgentsFiles(workspace),
    ]);
    return { workspace, capabilities, agentsFiles, availableAgentsFiles };
  }

  private findReusableCheckout(logicalRoot: string, canonicalRoot: string): Workspace | undefined {
    for (const workspace of this.workspaces.values()) {
      if (workspace.mode !== "checkout") continue;
      if (workspace.root !== logicalRoot || workspace.canonicalRoot !== canonicalRoot) continue;
      if (!this.hasActiveWorkspace(workspace.id)) continue;
      return workspace;
    }
    for (const session of this.store?.listSessions() ?? []) {
      if (session.status !== "active" || session.mode !== "checkout") continue;
      if (session.root !== logicalRoot || session.canonicalRoot !== canonicalRoot) continue;
      const workspace = this.restoreWorkspace(session);
      this.workspaces.set(workspace.id, workspace);
      return workspace;
    }
    return undefined;
  }

  private restoreWorkspace(session: NonNullable<ReturnType<NonNullable<WorkspaceStore["getSession"]>>>): Workspace {
    if (session.mode === "worktree" || session.mode === "isolated") {
      const root = assertAllowedPath(session.root, [this.config.worktreeRoot]);
      const canonicalRoot = canonicalTarget(root);
      const canonicalManagedRoot = canonicalTarget(this.config.worktreeRoot);
      if (canonicalRoot === canonicalManagedRoot || !isPathInsideRoot(canonicalRoot, canonicalManagedRoot)) {
        throw new Error(`Stored managed workspace is outside the configured managed root: ${session.root}`);
      }
      if (session.canonicalRoot && session.canonicalRoot !== canonicalRoot) {
        throw new Error(`Stored workspace canonical root changed: ${session.root}`);
      }
      if (session.managedDevice && session.managedInode) {
        const stats = statSync(canonicalRoot, { bigint: true });
        if (stats.dev.toString() !== session.managedDevice || stats.ino.toString() !== session.managedInode) {
          throw new Error(`Stored managed workspace filesystem identity changed: ${session.root}`);
        }
      }
      return {
        id: session.id,
        root,
        canonicalRoot,
        rootPolicyId: session.rootPolicyId ?? (session.mode === "isolated" ? "managed-isolated" : "managed-worktree"),
        access: "read-write",
        mode: session.mode,
        sourceRoot: session.sourceRoot,
        worktree: {
          path: root,
          sourceCanonicalRoot: session.sourceCanonicalRoot ?? session.sourceRoot ?? "",
          strategy: session.strategy ?? "worktree",
          baseRef: session.baseRef ?? "HEAD",
          baseSha: session.baseSha ?? "",
          dirtySource: session.sourceDirty,
          rootDevice: session.managedDevice ?? "",
          rootInode: session.managedInode ?? "",
          detached: true,
          managed: session.managed,
        },
        ...this.loadSkillsForWorkspace(root),
        activatedSkillDirs: new Set(),
      };
    }

    const authorized = authorizeWorkspacePath(session.root, this.config.rootPolicies, "read");
    if (session.canonicalRoot && session.canonicalRoot !== authorized.canonicalPath) {
      throw new Error(`Stored workspace canonical root changed: ${session.root}`);
    }
    if (session.rootPolicyId && !policyById(session.rootPolicyId, this.config.rootPolicies)) {
      throw new Error(`Stored workspace root policy is no longer configured: ${session.root}`);
    }
    return {
      id: session.id,
      root: authorized.logicalPath,
      canonicalRoot: authorized.canonicalPath,
      rootPolicyId: authorized.policy.id,
      access: authorized.policy.access,
      mode: "checkout",
      ...this.loadSkillsForWorkspace(authorized.logicalPath),
      activatedSkillDirs: new Set(),
    };
  }

  private resolveWorkspaceTarget(workspace: Workspace, inputPath: string, access: "read" | "write") {
    const logicalPath = resolve(workspace.root, expandHomePath(inputPath));
    if (!isPathInsideRoot(logicalPath, workspace.root)) {
      throw new AccessDeniedError(`Path is outside workspace root: ${inputPath}`);
    }

    const canonicalPath = canonicalTarget(logicalPath);
    if (isPathInsideRoot(canonicalPath, workspace.canonicalRoot)) {
      if (access === "write" && workspace.access !== "read-write") {
        throw new AccessDeniedError(`Workspace is read-only: ${inputPath}`);
      }
      return { logicalPath, canonicalPath };
    }

    const policy = findCanonicalPolicy(canonicalPath, this.config.rootPolicies);
    if (!policy || (access === "write" && policy.access !== "read-write")) {
      throw new AccessDeniedError(`Canonical target is outside permitted ${access} roots: ${inputPath}`);
    }
    return { logicalPath, canonicalPath };
  }

  private fileReadRoots(workspace: Workspace): string[] {
    return Array.from(new Set([workspace.canonicalRoot, ...this.config.rootPolicies.map((policy) => policy.canonicalPath)]));
  }

  private loadSkillsForWorkspace(root: string): Pick<Workspace, "skills" | "skillDiagnostics"> {
    const result = loadWorkspaceSkills(this.config, root);
    return { skills: result.skills, skillDiagnostics: result.diagnostics };
  }

  private loadInitialAgentsFiles(workspace: Workspace): LoadedAgentsFile[] {
    const agentDir = resolve(this.config.agentDir);
    let canonicalAgentDir: string | undefined;
    try {
      canonicalAgentDir = canonicalTarget(agentDir);
    } catch {
      canonicalAgentDir = undefined;
    }
    return loadProjectContextFiles({ cwd: workspace.root, agentDir })
      .filter((file) => {
        const path = resolve(file.path);
        try {
          const canonicalPath = canonicalTarget(path);
          if (canonicalAgentDir && isPathInsideRoot(canonicalPath, canonicalAgentDir)) return true;
          return dirname(path) === workspace.root && isPathInsideRoot(canonicalPath, workspace.canonicalRoot);
        } catch {
          return false;
        }
      })
      .map((file) => ({ path: resolve(file.path), content: file.content }));
  }

  private async findAvailableAgentsFiles(workspace: Workspace): Promise<AvailableAgentsFile[]> {
    const loadedPaths = new Set(this.loadInitialAgentsFiles(workspace).map((file) => resolve(file.path)));
    const discovered: AvailableAgentsFile[] = [];

    await walkWorkspace(workspace.root, async (path, entry) => {
      if (!entry.isFile() || !CONTEXT_FILE_NAMES.has(entry.name) || loadedPaths.has(path)) return;
      try {
        this.resolveWorkspaceTarget(workspace, path, "read");
        discovered.push({ path });
      } catch {
        // Ignore context files whose canonical target is not authorized.
      }
    });

    return discovered.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async cleanupStoredManagedWorkspace(session: WorkspaceSession): Promise<{ removed: boolean; dirty: boolean; reason?: string }> {
    if (!session.canonicalRoot || !session.managedDevice || !session.managedInode) {
      return { removed: false, dirty: false, reason: "stored managed workspace identity is incomplete" };
    }
    const identity = await this.verifyManagedWorkspaceIdentity(
      session.root,
      session.canonicalRoot,
      session.managedDevice,
      session.managedInode,
    );
    if (!identity.ok) return { removed: false, dirty: false, reason: identity.reason };
    const dirty = await this.managedWorkspaceDirty(identity.canonicalRoot);
    if (dirty) return { removed: false, dirty: true };
    if (session.strategy === "clone") {
      await rm(identity.canonicalRoot, { recursive: true, force: true });
      return { removed: true, dirty: false };
    }
    if (!session.sourceRoot || !session.sourceCanonicalRoot) {
      return { removed: false, dirty: false, reason: "stored worktree source identity is incomplete" };
    }
    const sourceIdentity = await this.verifySourceIdentity(session.sourceRoot, session.sourceCanonicalRoot);
    if (!sourceIdentity.ok) return { removed: false, dirty: false, reason: sourceIdentity.reason };
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", session.root], { cwd: sourceIdentity.canonicalRoot, maxBuffer: 2 * 1024 * 1024 });
      return { removed: true, dirty: false };
    } catch (error) {
      return {
        removed: false,
        dirty: false,
        reason: `git worktree removal failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async verifyManagedWorkspaceIdentity(
    root: string,
    expectedCanonicalRoot: string,
    expectedDevice: string,
    expectedInode: string,
  ): Promise<{ ok: true; canonicalRoot: string } | { ok: false; reason: string }> {
    try {
      assertAllowedPath(root, [this.config.worktreeRoot]);
      const canonicalManagedRoot = await realpath(this.config.worktreeRoot);
      const identity = await managedPathIdentity(root);
      if (identity.canonicalRoot === canonicalManagedRoot || !isPathInsideRoot(identity.canonicalRoot, canonicalManagedRoot)) {
        return { ok: false, reason: "managed workspace is outside the configured managed root" };
      }
      if (identity.canonicalRoot !== expectedCanonicalRoot) {
        return { ok: false, reason: `managed workspace identity changed from ${expectedCanonicalRoot} to ${identity.canonicalRoot}` };
      }
      if (identity.device !== expectedDevice || identity.inode !== expectedInode) {
        return { ok: false, reason: "managed workspace filesystem identity changed" };
      }
      return { ok: true, canonicalRoot: identity.canonicalRoot };
    } catch (error) {
      return { ok: false, reason: `managed workspace identity could not be verified: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async verifySourceIdentity(root: string, expectedCanonicalRoot: string): Promise<{ ok: true; canonicalRoot: string } | { ok: false; reason: string }> {
    try {
      const canonicalRoot = await realpath(root);
      if (canonicalRoot !== expectedCanonicalRoot) {
        return { ok: false, reason: `source repository identity changed from ${expectedCanonicalRoot} to ${canonicalRoot}` };
      }
      return { ok: true, canonicalRoot };
    } catch (error) {
      return { ok: false, reason: `source repository identity could not be verified: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async removeFreshManagedWorkspace(worktree: ManagedWorktree, canonicalRoot: string): Promise<void> {
    if (worktree.strategy === "clone") {
      await rm(canonicalRoot, { recursive: true, force: true });
      return;
    }
    await execFileAsync("git", ["worktree", "remove", "--force", worktree.path], { cwd: worktree.sourceCanonicalRoot, maxBuffer: 2 * 1024 * 1024 });
  }

  private async managedWorkspaceDirty(root: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
      return stdout.trim().length > 0;
    } catch {
      return true;
    }
  }

  private probeCapabilities(workspace: Workspace): Promise<WorkspaceCapabilities> {
    return probeWorkspaceCapabilities({
      logicalRoot: workspace.root,
      canonicalRoot: workspace.canonicalRoot,
      policyAccess: workspace.access,
      worktreeRoot: this.config.worktreeRoot,
      shellRuntime: this.shellRuntime,
    });
  }
}

async function managedPathIdentity(path: string): Promise<{ canonicalRoot: string; device: string; inode: string }> {
  const canonicalRoot = await realpath(path);
  const stats = await stat(canonicalRoot, { bigint: true });
  if (!stats.isDirectory()) throw new Error(`Managed workspace is not a directory: ${path}`);
  return { canonicalRoot, device: stats.dev.toString(), inode: stats.ino.toString() };
}

const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const SKIPPED_CONTEXT_DIRS = new Set([".git", ".hg", ".svn", ".devspace", "node_modules", "dist", "build", ".next", ".turbo", ".cache"]);

export function formatAgentsPath(path: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return path.split(sep).join("/");
  const relationship = relative(workspaceRoot, path);
  if (relationship === "" || relationship.startsWith("..") || relationship === ".." || relationship.includes(`..${sep}`)) {
    return path.split(sep).join("/");
  }
  return relationship.split(sep).join("/");
}

async function walkWorkspace(
  directory: string,
  visit: (path: string, entry: { name: string; isFile(): boolean; isDirectory(): boolean }) => Promise<void> | void,
): Promise<void> {
  let entries;
  try {
    entries = await opendir(directory);
  } catch {
    return;
  }

  for await (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_CONTEXT_DIRS.has(entry.name)) await walkWorkspace(path, visit);
      continue;
    }
    await visit(path, entry);
  }
}
