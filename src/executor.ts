import type { ServerConfig } from "./config.js";
import { commandPreview, logEvent } from "./logger.js";
import { editFileTool, findFilesTool, grepFilesTool, listDirectoryTool, readFileTool, runShellTool, writeFileTool, type ToolResponse } from "./pi-tools.js";
import { createReviewCheckpointManager, type ReviewCheckpointManager } from "./review-checkpoints.js";
import { formatPathForPrompt } from "./skills.js";
import { TerminalManager } from "./terminal-manager.js";
import { parseToolArguments, type ToolArguments, type ToolName } from "./tool-contract.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { createWorkspaceStore, type WorkspaceStore } from "./workspace-store.js";

export interface ExecutorRequestOptions { requestId: string; signal?: AbortSignal }
export interface LocalExecutorOptions {
  config: ServerConfig;
  workspaces?: WorkspaceRegistry;
  reviewCheckpoints?: ReviewCheckpointManager;
  terminals?: TerminalManager;
}

type MaintenanceResult = {
  workspaces: Awaited<ReturnType<WorkspaceRegistry["maintenance"]>>;
  terminals: Awaited<ReturnType<TerminalManager["maintenance"]>>;
};

export class LocalExecutor {
  readonly workspaces: WorkspaceRegistry;
  readonly reviewCheckpoints: ReviewCheckpointManager;
  readonly terminals: TerminalManager;
  private readonly ownedStore?: WorkspaceStore;
  private readonly ownsTerminals: boolean;
  private readonly initializeReviewOnOpen: boolean;
  private readonly maintenanceTimer: NodeJS.Timeout;
  private readonly config: ServerConfig;
  private readonly skillsEnabled: boolean;
  private readonly activeWorkspaceOperations = new Map<string, number>();
  private readonly closingWorkspaceIds = new Set<string>();
  private maintenanceInFlight?: Promise<MaintenanceResult>;
  private closeRequested = false;
  private resourcesClosed = false;

  constructor(options: LocalExecutorOptions) {
    this.config = options.config;
    this.ownedStore = options.workspaces ? undefined : createWorkspaceStore(options.config.stateDir);
    this.workspaces = options.workspaces ?? new WorkspaceRegistry(options.config, this.ownedStore);
    this.reviewCheckpoints = options.reviewCheckpoints ?? createReviewCheckpointManager(options.config.stateDir);
    this.terminals = options.terminals ?? new TerminalManager(options.config.terminals, this.workspaces.shellRuntime, options.config.stateDir);
    this.ownsTerminals = options.terminals === undefined;
    this.initializeReviewOnOpen = options.config.widgets === "changes";
    this.skillsEnabled = options.config.skillsEnabled;
    this.maintenanceTimer = setInterval(() => void this.runMaintenance().catch(() => undefined), options.config.maintenance.intervalSeconds * 1000);
    this.maintenanceTimer.unref();
    void this.runMaintenance().catch(() => undefined);
  }

  close(): void {
    clearInterval(this.maintenanceTimer);
    this.closeRequested = true;
    if (this.maintenanceInFlight) {
      void this.maintenanceInFlight.finally(() => this.closeResources()).catch(() => undefined);
      return;
    }
    this.closeResources();
  }

  async execute<N extends ToolName>(name: N, args: ToolArguments<N>, options: ExecutorRequestOptions): Promise<ToolResponse> {
    if (this.closeRequested) throw new Error("Executor is closed");
    if (!options.requestId || options.requestId.length > 128) throw new Error("requestId must be 1-128 characters");
    if (options.signal?.aborted) throw new Error("Request cancelled");
    const input = parseToolArguments(name, args);
    const workspaceId = "workspaceId" in input && typeof input.workspaceId === "string" ? input.workspaceId : undefined;
    const startedAt = performance.now();
    const isClose = name === "close_workspace";
    if (workspaceId) {
      if (this.closingWorkspaceIds.has(workspaceId)) throw new Error(`Workspace is closing: ${workspaceId}`);
      if (isClose) this.closingWorkspaceIds.add(workspaceId);
      this.beginWorkspaceOperation(workspaceId);
    }
    try {
      const result = await this.dispatch(name, input, options);
      this.logToolExecution(name, input, !result.isError, startedAt, result.isError ? errorPreviewForTool(name, result) : undefined);
      return result;
    } catch (error) {
      this.logToolExecution(name, input, false, startedAt, thrownErrorPreviewForTool(name, error));
      throw error;
    } finally {
      if (workspaceId) {
        this.endWorkspaceOperation(workspaceId);
        if (isClose) this.closingWorkspaceIds.delete(workspaceId);
      }
    }
  }

  private async dispatch<N extends ToolName>(name: N, input: ToolArguments<N>, options: ExecutorRequestOptions): Promise<ToolResponse> {
    switch (name) {
      case "open_workspace": return this.openWorkspace(input as ToolArguments<"open_workspace">);
      case "workspace_status": return this.workspaceStatus(input as ToolArguments<"workspace_status">);
      case "close_workspace": return this.closeWorkspace(input as ToolArguments<"close_workspace">);
      case "read_file": return this.read(input as ToolArguments<"read_file">, options);
      case "write_file": return this.write(input as ToolArguments<"write_file">, options);
      case "edit_file": return this.edit(input as ToolArguments<"edit_file">, options);
      case "grep_files": return this.grep(input as ToolArguments<"grep_files">, options);
      case "find_files": return this.find(input as ToolArguments<"find_files">, options);
      case "list_directory": return this.list(input as ToolArguments<"list_directory">, options);
      case "run_shell": return this.shell(input as ToolArguments<"run_shell">, options);
      case "terminal_start": return this.terminalStart(input as ToolArguments<"terminal_start">);
      case "terminal_read": return this.terminalRead(input as ToolArguments<"terminal_read">);
      case "terminal_write": return this.terminalWrite(input as ToolArguments<"terminal_write">);
      case "terminal_resize": return this.terminalResize(input as ToolArguments<"terminal_resize">);
      case "terminal_status": return this.terminalStatus(input as ToolArguments<"terminal_status">);
      case "terminal_close": return this.terminalClose(input as ToolArguments<"terminal_close">);
      case "show_changes": return this.showChanges(input as ToolArguments<"show_changes">, options);
    }
    throw new Error(`Unsupported tool: ${String(name)}`);
  }

  private logToolExecution(
    tool: ToolName,
    input: Record<string, unknown>,
    success: boolean,
    startedAt: number,
    error?: string,
  ): void {
    if (!this.config.logging.toolCalls) return;
    const command = typeof input.command === "string" ? input.command : undefined;
    logEvent(this.config.logging, success ? "info" : "warn", "tool_call", {
      tool,
      workspaceId: typeof input.workspaceId === "string" ? input.workspaceId : undefined,
      path: typeof input.path === "string" ? input.path : undefined,
      workingDirectory: typeof input.workingDirectory === "string" ? input.workingDirectory : undefined,
      commandLength: command?.length,
      commandPreview: this.config.logging.shellCommands && command ? commandPreview(command) : undefined,
      success,
      durationMs: Math.round(performance.now() - startedAt),
      error: error ? boundedText(error, 240) : undefined,
    });
  }

  runMaintenance(now = Date.now()): Promise<MaintenanceResult> {
    if (this.maintenanceInFlight) return this.maintenanceInFlight;
    if (this.closeRequested) return Promise.reject(new Error("Executor is closed"));

    const task = this.performMaintenance(now);
    this.maintenanceInFlight = task;
    void task.finally(() => {
      if (this.maintenanceInFlight === task) this.maintenanceInFlight = undefined;
      if (this.closeRequested) this.closeResources();
    }).catch(() => undefined);
    return task;
  }

  private async performMaintenance(now: number): Promise<MaintenanceResult> {
    const terminals = await this.terminals.maintenance(now, (workspaceId) => this.workspaces.hasActiveWorkspace(workspaceId));
    const protectedWorkspaceIds = new Set([
      ...this.activeWorkspaceOperations.keys(),
      ...terminals.activeWorkspaceIds,
    ]);
    const workspaces = await this.workspaces.maintenance(this.config.maintenance, now, protectedWorkspaceIds);
    for (const workspaceId of workspaces.prunedWorkspaceIds) {
      await this.reviewCheckpoints.removeWorkspace({ workspaceId });
    }
    return { workspaces, terminals };
  }

  private closeResources(): void {
    if (this.resourcesClosed) return;
    this.resourcesClosed = true;
    if (this.ownsTerminals) this.terminals.closeStore();
    this.ownedStore?.close?.();
  }

  private async openWorkspace(input: ToolArguments<"open_workspace">): Promise<ToolResponse> {
    let context = await this.workspaces.openWorkspace(input);
    if (context.workspace.mode === "checkout" && this.closingWorkspaceIds.has(context.workspace.id)) {
      context = await this.workspaces.openWorkspace({ ...input, fresh: true });
    }
    const { workspace, capabilities, agentsFiles, availableAgentsFiles } = context;
    if (this.initializeReviewOnOpen) {
      await this.reviewCheckpoints.initializeWorkspace({ workspaceId: workspace.id, root: workspace.root });
    }
    const skills = this.visibleSkills(workspace.skills);
    const loadedAgentsFiles = agentsFiles.map((file) => ({ path: formatAgentsPath(file.path, workspace.root), content: file.content }));
    const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({ path: formatAgentsPath(file.path, workspace.root) }));
    const instruction = this.workspaceInstruction();
    const text = [
      ...capabilities.warnings,
      `Opened workspace ${workspace.id}`,
      `Root: ${workspace.root}`,
      `Canonical root: ${workspace.canonicalRoot}`,
      `Mode: ${workspace.mode}`,
      `Access: ${capabilities.fileAccess}`,
      loadedAgentsFiles.length ? `Loaded global/project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}` : undefined,
      availableAgentsFileOutputs.length ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}` : undefined,
      skills.length ? `Available skills: ${skills.map((skill) => skill.name).join(", ")}` : undefined,
      instruction,
    ].filter(Boolean).join("\n");
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        workspaceId: workspace.id,
        root: workspace.root,
        canonicalRoot: workspace.canonicalRoot,
        mode: workspace.mode,
        sourceRoot: workspace.sourceRoot,
        worktree: publicWorktree(workspace.worktree),
        capabilities,
        agentsFiles: loadedAgentsFiles,
        availableAgentsFiles: availableAgentsFileOutputs,
        skills,
        skillDiagnostics: workspace.skillDiagnostics,
        instruction,
      },
    };
  }

  private async workspaceStatus(input: ToolArguments<"workspace_status">): Promise<ToolResponse> {
    const { workspace, capabilities } = await this.workspaces.workspaceStatus(input.workspaceId);
    const terminals = await this.terminals.status(input.workspaceId);
    if (!this.reviewCheckpoints.status({ workspaceId: input.workspaceId }).initialized) {
      await this.reviewCheckpoints.initializeWorkspace({ workspaceId: input.workspaceId, root: workspace.root });
    }
    const review = publicReviewStatus(this.reviewCheckpoints.status({ workspaceId: input.workspaceId }));
    const text = [
      ...capabilities.warnings,
      `Workspace ${workspace.id}`,
      `Root: ${workspace.root}`,
      `Canonical root: ${workspace.canonicalRoot}`,
      `Mode: ${workspace.mode}`,
      `Access: ${capabilities.fileAccess}`,
      capabilities.git ? `Git: ${capabilities.git.branch ?? "detached"} ${capabilities.git.head}${capabilities.git.dirty ? " dirty" : " clean"}` : "Git: not a repository",
      `Shell: ${capabilities.runtime.shellPath} (${capabilities.runtime.shellMode})`,
      `tmux: ${capabilities.runtime.tmux ? "available" : "unavailable"}`,
      `OpenCode: ${capabilities.runtime.opencode ?? "unavailable"}`,
      `User systemd: ${capabilities.runtime.userSystemd ? "available" : "unavailable"}`,
      `Privilege escalation: ${capabilities.runtime.privilegeEscalation}`,
      `Terminals: ${terminals.filter((terminal) => terminal.status === "active").length} active`,
      `Review checkpoint: ${review.initialized ? "ready" : review.diagnostic ?? "not initialized"}`,
    ].join("\n");
    return { content: [{ type: "text", text }], structuredContent: { workspaceId: workspace.id, root: workspace.root, canonicalRoot: workspace.canonicalRoot, mode: workspace.mode, capabilities, terminals, review } };
  }

  private async closeWorkspace(input: ToolArguments<"close_workspace">): Promise<ToolResponse> {
    const activeWorkspace = this.workspaces.getWorkspace(input.workspaceId);
    const activeOperations = this.activeWorkspaceOperations.get(input.workspaceId) ?? 1;
    if (activeOperations > 1) {
      const workspace = {
        workspaceId: input.workspaceId,
        mode: activeWorkspace.mode,
        closed: false,
        removed: false,
        dirty: false,
        reason: "other workspace operations are still active",
      };
      return {
        content: [{ type: "text", text: `Workspace ${input.workspaceId} remains open because ${activeOperations - 1} other operation(s) are active.` }],
        structuredContent: { workspace, terminals: { closed: [], retained: [] } },
      };
    }
    const terminals = await this.terminals.closeWorkspace(input.workspaceId);
    if (terminals.retained.length > 0) {
      const workspace = {
        workspaceId: input.workspaceId,
        mode: activeWorkspace.mode,
        closed: false,
        removed: false,
        dirty: false,
        reason: "retained terminals must be closed before the workspace can close",
      };
      return {
        content: [{ type: "text", text: `Workspace ${input.workspaceId} remains open because retained terminals are active: ${terminals.retained.join(", ")}.` }],
        structuredContent: { workspace, terminals },
      };
    }
    await this.reviewCheckpoints.removeWorkspace({ workspaceId: input.workspaceId });
    const workspace = await this.workspaces.closeWorkspace(input.workspaceId);
    const text = workspace.retainedPath
      ? `Closed workspace ${input.workspaceId}. Retained ${workspace.retainedPath}: ${workspace.reason}.`
      : `Closed workspace ${input.workspaceId}${workspace.removed ? " and removed its clean managed checkout" : ""}.`;
    return { content: [{ type: "text", text }], structuredContent: { workspace, terminals } };
  }

  private async read(input: ToolArguments<"read_file">, options: ExecutorRequestOptions): Promise<ToolResponse> {
    const workspace = this.workspaces.getWorkspace(input.workspaceId);
    const readPath = this.workspaces.resolveReadPath(workspace, input.path);
    const result = await readFileTool({ path: readPath.absolutePath, offset: input.offset, limit: input.limit }, { cwd: workspace.root, root: workspace.canonicalRoot, readRoots: readPath.readRoots }, options.signal, options.requestId);
    if (!result.isError) this.workspaces.markReadPathLoaded(workspace, readPath);
    return result;
  }

  private async write(input: ToolArguments<"write_file">, options: ExecutorRequestOptions): Promise<ToolResponse> {
    const workspace = this.workspaces.getWorkspace(input.workspaceId);
    const path = this.workspaces.resolveWritePath(workspace, input.path);
    return writeFileTool({ path, content: input.content }, { cwd: workspace.root, root: workspace.canonicalRoot }, options.signal, options.requestId);
  }

  private async edit(input: ToolArguments<"edit_file">, options: ExecutorRequestOptions): Promise<ToolResponse> {
    const workspace = this.workspaces.getWorkspace(input.workspaceId);
    const path = this.workspaces.resolveWritePath(workspace, input.path);
    return editFileTool({ path, edits: input.edits }, { cwd: workspace.root, root: workspace.canonicalRoot }, options.signal, options.requestId);
  }

  private async grep(input: ToolArguments<"grep_files">, options: ExecutorRequestOptions): Promise<ToolResponse> {
    const workspace = this.workspaces.getWorkspace(input.workspaceId);
    const path = this.workspaces.resolveOptionalSearchPath(workspace, input.path);
    return grepFilesTool({ pattern: input.pattern, path, glob: input.include }, { cwd: workspace.root, root: workspace.canonicalRoot }, options.signal, options.requestId);
  }

  private async find(input: ToolArguments<"find_files">, options: ExecutorRequestOptions): Promise<ToolResponse> {
    const workspace = this.workspaces.getWorkspace(input.workspaceId);
    const path = this.workspaces.resolveOptionalSearchPath(workspace, input.path);
    return findFilesTool({ pattern: input.pattern, path }, { cwd: workspace.root, root: workspace.canonicalRoot }, options.signal, options.requestId);
  }

  private async list(input: ToolArguments<"list_directory">, options: ExecutorRequestOptions): Promise<ToolResponse> {
    const workspace = this.workspaces.getWorkspace(input.workspaceId);
    const path = this.workspaces.resolvePath(workspace, input.path);
    return listDirectoryTool({ path }, { cwd: workspace.root, root: workspace.canonicalRoot }, options.signal, options.requestId);
  }

  private async shell(input: ToolArguments<"run_shell">, options: ExecutorRequestOptions): Promise<ToolResponse> {
    const workspace = this.workspaces.getWorkspace(input.workspaceId);
    const cwd = this.workspaces.resolveWorkingDirectory(workspace, input.workingDirectory);
    return runShellTool({ command: input.command, timeout: input.timeout }, { cwd, root: workspace.canonicalRoot, shellRuntime: this.workspaces.shellRuntime }, options.signal, options.requestId);
  }

  private async terminalStart(input: ToolArguments<"terminal_start">): Promise<ToolResponse> {
    const workspace = this.workspaces.getWorkspace(input.workspaceId);
    const workingDirectory = this.workspaces.resolveWorkingDirectory(workspace, input.workingDirectory);
    const terminal = await this.terminals.start({ ...input, workingDirectory });
    return terminalResponse(`Started terminal ${terminal.terminalId}.`, terminal);
  }

  private async terminalRead(input: ToolArguments<"terminal_read">): Promise<ToolResponse> {
    this.workspaces.getWorkspace(input.workspaceId);
    const result = await this.terminals.read(input);
    return {
      content: [{ type: "text", text: result.output || "(no terminal output)" }],
      structuredContent: { terminal: result.terminal, output: result.output, truncated: result.truncated },
    };
  }

  private async terminalWrite(input: ToolArguments<"terminal_write">): Promise<ToolResponse> {
    this.workspaces.getWorkspace(input.workspaceId);
    const terminal = await this.terminals.write(input);
    return terminalResponse(`Updated terminal ${terminal.terminalId}.`, terminal);
  }

  private async terminalResize(input: ToolArguments<"terminal_resize">): Promise<ToolResponse> {
    this.workspaces.getWorkspace(input.workspaceId);
    const terminal = await this.terminals.resize(input);
    return terminalResponse(`Resized terminal ${terminal.terminalId} to ${terminal.cols}x${terminal.rows}.`, terminal);
  }

  private async terminalStatus(input: ToolArguments<"terminal_status">): Promise<ToolResponse> {
    this.workspaces.getWorkspace(input.workspaceId);
    const terminals = await this.terminals.status(input.workspaceId, input.terminalId);
    const text = terminals.length === 0
      ? "No terminal sessions for this workspace."
      : terminals.map((terminal) => `${terminal.terminalId} ${terminal.status} ${terminal.cols}x${terminal.rows} ${terminal.commandSummary}`).join("\n");
    return { content: [{ type: "text", text }], structuredContent: { terminals } };
  }

  private async terminalClose(input: ToolArguments<"terminal_close">): Promise<ToolResponse> {
    this.workspaces.getWorkspace(input.workspaceId);
    const terminal = await this.terminals.close(input);
    return terminalResponse(`Closed terminal ${terminal.terminalId}.`, terminal);
  }

  private async showChanges(input: ToolArguments<"show_changes">, _options: ExecutorRequestOptions): Promise<ToolResponse> {
    const workspace = this.workspaces.getWorkspace(input.workspaceId);
    const review = await this.reviewCheckpoints.reviewChanges({ workspaceId: input.workspaceId, root: workspace.root, since: input.since, markReviewed: input.markReviewed });
    return { content: [{ type: "text", text: review.result }], structuredContent: review as unknown as Record<string, unknown> };
  }

  private beginWorkspaceOperation(workspaceId: string): void {
    this.activeWorkspaceOperations.set(workspaceId, (this.activeWorkspaceOperations.get(workspaceId) ?? 0) + 1);
  }

  private endWorkspaceOperation(workspaceId: string): void {
    const remaining = (this.activeWorkspaceOperations.get(workspaceId) ?? 1) - 1;
    if (remaining <= 0) this.activeWorkspaceOperations.delete(workspaceId);
    else this.activeWorkspaceOperations.set(workspaceId, remaining);
  }

  private visibleSkills(skills: Array<{ name: string; description?: string; filePath: string; disableModelInvocation?: boolean }>) {
    return this.skillsEnabled
      ? skills.filter((skill) => !skill.disableModelInvocation).map((skill) => ({ name: skill.name, description: skill.description, path: formatPathForPrompt(skill.filePath) }))
      : [];
  }

  private workspaceInstruction(): string {
    const base = "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for the same folder unless the workspaceId stops working, you switch folders or modes, or the user asks. Follow loaded global and project instructions, and read relevant nested instruction files before working there.";
    return this.skillsEnabled ? `${base} Read an advertised SKILL.md before using that skill.` : base;
  }
}

const SENSITIVE_EXECUTION_TOOLS = new Set<ToolName>([
  "run_shell",
  "terminal_start",
  "terminal_read",
  "terminal_write",
  "terminal_resize",
  "terminal_status",
  "terminal_close",
]);

function errorPreviewForTool(tool: ToolName, result: ToolResponse): string | undefined {
  return SENSITIVE_EXECUTION_TOOLS.has(tool) ? "execution failed" : contentPreview(result);
}

function thrownErrorPreviewForTool(tool: ToolName, error: unknown): string {
  if (SENSITIVE_EXECUTION_TOOLS.has(tool)) return "execution failed";
  return boundedText(error instanceof Error ? error.message : String(error), 240);
}

function contentPreview(result: ToolResponse): string | undefined {
  const text = result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return text ? boundedText(text, 240) : undefined;
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function publicWorktree(worktree: import("./workspaces.js").WorkspaceWorktree | undefined) {
  if (!worktree) return undefined;
  return {
    path: worktree.path,
    sourceCanonicalRoot: worktree.sourceCanonicalRoot,
    strategy: worktree.strategy,
    baseRef: worktree.baseRef,
    baseSha: worktree.baseSha,
    dirtySource: worktree.dirtySource,
    detached: worktree.detached,
    managed: worktree.managed,
  };
}

function publicReviewStatus(status: { initialized: boolean; diagnostic?: string }) {
  return { initialized: status.initialized, diagnostic: status.diagnostic };
}

function terminalResponse(text: string, terminal: unknown): ToolResponse {
  return { content: [{ type: "text", text }], structuredContent: { terminal } };
}

export function createExecutor(config: ServerConfig): LocalExecutor {
  return new LocalExecutor({ config });
}
