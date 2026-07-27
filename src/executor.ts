import type { ServerConfig } from "./config.js";
import { createReviewCheckpointManager, type ReviewCheckpointManager } from "./review-checkpoints.js";
import { editFileTool, findFilesTool, grepFilesTool, listDirectoryTool, readFileTool, runShellTool, writeFileTool, type ToolResponse } from "./pi-tools.js";
import { formatPathForPrompt } from "./skills.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { createWorkspaceStore, type WorkspaceStore } from "./workspace-store.js";
import { parseToolArguments, type ToolArguments, type ToolName } from "./tool-contract.js";

export interface ExecutorRequestOptions { requestId: string; signal?: AbortSignal }
export interface LocalExecutorOptions {
  config: ServerConfig;
  workspaces?: WorkspaceRegistry;
  reviewCheckpoints?: ReviewCheckpointManager;
}

export class LocalExecutor {
  readonly workspaces: WorkspaceRegistry;
  readonly reviewCheckpoints: ReviewCheckpointManager;
  private readonly ownedStore?: WorkspaceStore;
  private readonly initializeReviewOnOpen: boolean;
  private readonly skillsEnabled: boolean;
  constructor(options: LocalExecutorOptions) {
    this.ownedStore = options.workspaces ? undefined : createWorkspaceStore(options.config.stateDir);
    this.workspaces = options.workspaces ?? new WorkspaceRegistry(options.config, this.ownedStore);
    this.reviewCheckpoints = options.reviewCheckpoints ?? createReviewCheckpointManager();
    this.initializeReviewOnOpen = options.config.widgets === "changes";
    this.skillsEnabled = options.config.skillsEnabled;
  }

  close(): void { this.ownedStore?.close?.(); }

  async execute<N extends ToolName>(name: N, args: ToolArguments<N>, options: ExecutorRequestOptions): Promise<ToolResponse> {
    if (!options.requestId || options.requestId.length > 128) throw new Error("requestId must be 1-128 characters");
    if (options.signal?.aborted) throw new Error("Request cancelled");
    const input = parseToolArguments(name, args);
    switch (name) {
      case "open_workspace": return this.openWorkspace(input as ToolArguments<"open_workspace">);
      case "read_file": return this.read(input as ToolArguments<"read_file">, options);
      case "write_file": return this.workspaceTool(input as ToolArguments<"write_file">, options, writeFileTool);
      case "edit_file": return this.workspaceTool(input as ToolArguments<"edit_file">, options, editFileTool);
      case "grep_files": return this.workspaceTool(input as ToolArguments<"grep_files">, options, grepFilesTool);
      case "find_files": return this.workspaceTool(input as ToolArguments<"find_files">, options, findFilesTool);
      case "list_directory": return this.workspaceTool(input as ToolArguments<"list_directory">, options, listDirectoryTool);
      case "run_shell": return this.shell(input as ToolArguments<"run_shell">, options);
      case "show_changes": return this.showChanges(input as ToolArguments<"show_changes">, options);
    }
  }

  private async openWorkspace(input: ToolArguments<"open_workspace">): Promise<ToolResponse> {
    const { workspace, agentsFiles, availableAgentsFiles } = await this.workspaces.openWorkspace(input);
    if (this.initializeReviewOnOpen) {
      await this.reviewCheckpoints.initializeWorkspace({ workspaceId: workspace.id, root: workspace.root });
    }
    const skills = this.skillsEnabled
      ? workspace.skills.filter((skill) => !skill.disableModelInvocation).map((skill) => ({ name: skill.name, description: skill.description, path: formatPathForPrompt(skill.filePath) }))
      : [];
    const loadedAgentsFiles = agentsFiles.map((file) => ({ path: formatAgentsPath(file.path, workspace.root), content: file.content }));
    const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({ path: formatAgentsPath(file.path, workspace.root) }));
    const instruction = this.skillsEnabled
      ? "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
      : "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
    const text = [
      `Opened workspace ${workspace.id}`,
      `Root: ${workspace.root}`,
      `Mode: ${workspace.mode}`,
      loadedAgentsFiles.length ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}` : undefined,
      availableAgentsFileOutputs.length ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}` : undefined,
      skills.length ? `Available skills: ${skills.map((skill) => skill.name).join(", ")}` : undefined,
      instruction,
    ].filter(Boolean).join("\n");
    return { content: [{ type: "text", text }], structuredContent: { workspaceId: workspace.id, root: workspace.root, mode: workspace.mode, sourceRoot: workspace.sourceRoot, worktree: workspace.worktree, agentsFiles: loadedAgentsFiles, availableAgentsFiles: availableAgentsFileOutputs, skills, skillDiagnostics: workspace.skillDiagnostics, instruction } };
  }

  private async workspaceTool<T>(input: T & { workspaceId: string }, options: ExecutorRequestOptions, fn: (input: any, context: any, signal?: AbortSignal, requestId?: string) => Promise<ToolResponse>): Promise<ToolResponse> {
    const workspace = this.workspaces.getWorkspace(input.workspaceId);
    const context = { cwd: workspace.root, root: workspace.root, readRoots: [workspace.root] };
    const { workspaceId: _ignored, ...toolInput } = input as any;
    return fn(toolInput, context, options.signal, options.requestId);
  }

  private async read(input: ToolArguments<"read_file">, options: ExecutorRequestOptions): Promise<ToolResponse> {
    const workspace = this.workspaces.getWorkspace(input.workspaceId);
    const readPath = this.workspaces.resolveReadPath(workspace, input.path);
    const result = await readFileTool({ path: readPath.absolutePath, offset: input.offset, limit: input.limit }, { cwd: workspace.root, root: workspace.root, readRoots: readPath.readRoots }, options.signal, options.requestId);
    if (!result.isError) this.workspaces.markReadPathLoaded(workspace, readPath);
    return result;
  }

  private async shell(input: ToolArguments<"run_shell">, options: ExecutorRequestOptions): Promise<ToolResponse> {
    const workspace = this.workspaces.getWorkspace(input.workspaceId);
    const cwd = this.workspaces.resolveWorkingDirectory(workspace, input.workingDirectory);
    return runShellTool({ command: input.command, timeout: input.timeout }, { cwd, root: workspace.root }, options.signal, options.requestId);
  }

  private async showChanges(input: ToolArguments<"show_changes">, _options: ExecutorRequestOptions): Promise<ToolResponse> {
    const workspace = this.workspaces.getWorkspace(input.workspaceId);
    const review = await this.reviewCheckpoints.reviewChanges({ workspaceId: input.workspaceId, root: workspace.root, since: input.since, markReviewed: input.markReviewed });
    return { content: [{ type: "text", text: review.result }], structuredContent: review as unknown as Record<string, unknown> };
  }
}

export function createExecutor(config: ServerConfig): LocalExecutor {
  return new LocalExecutor({ config });
}
