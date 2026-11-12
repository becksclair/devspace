// Pure display mapping for result cards: titles, labels, icons, tones, badges and the plain-text
// bodies of workspace and terminal cards. No DOM or React here, so it is unit-testable in Node.

import {
  isEditTool,
  isReviewTool,
  isSearchTool,
  isShellTool,
  isTerminalTool,
  isWriteTool,
  summaryNumber,
  type ToolName,
  type ToolResultCard,
} from "./card-types.js";

export type IconName =
  | "folder"
  | "file"
  | "filePlus"
  | "edit"
  | "search"
  | "files"
  | "list"
  | "terminal"
  | "review";

export interface ToolDisplay {
  icon: IconName;
  title: string;
  label: string;
  tone: string;
}

export type SummaryBadge =
  | { kind: "stats"; label: string; additions: number; removals: number }
  | { kind: "workspace"; agentsFiles: number; skills: number }
  | { kind: "text"; text: string };

/** Number of review files listed before "Show N more files". */
export const REVIEW_COLLAPSED_FILES = 3;

export function toolTitle(tool: ToolName): string {
  switch (tool) {
    case "open_workspace": return "Workspace";
    case "workspace_status": return "Workspace Status";
    case "close_workspace": return "Close Workspace";
    case "read_file":
    case "read": return "Read";
    case "multi_read": return "Read Files";
    case "write_file":
    case "write": return "Write";
    case "edit_file":
    case "edit": return "Edit";
    case "grep_files":
    case "grep": return "Grep";
    case "find_files":
    case "glob": return "Glob";
    case "list_directory":
    case "ls": return "List";
    case "run_shell":
    case "bash": return "Bash";
    case "terminal_start": return "Start Terminal";
    case "terminal_read": return "Read Terminal";
    case "terminal_write": return "Write Terminal";
    case "terminal_resize": return "Resize Terminal";
    case "terminal_status": return "Terminal Status";
    case "terminal_close": return "Close Terminal";
    case "show_changes": return "Changes";
  }
}

export function getToolDisplay(card: ToolResultCard): ToolDisplay {
  const label = getToolLabel(card);

  switch (card.tool) {
    case "open_workspace":
      return { icon: "folder", title: "Workspace", label, tone: "workspace" };
    case "workspace_status":
      return { icon: "folder", title: "Workspace Status", label, tone: "workspace" };
    case "close_workspace":
      return { icon: "folder", title: "Close Workspace", label, tone: "workspace" };
    case "read_file":
    case "read":
      return { icon: "file", title: "Read File", label, tone: "read" };
    case "multi_read":
      return { icon: "files", title: "Read Files", label, tone: "read" };
    case "write_file":
    case "write":
      return { icon: "filePlus", title: "Write File", label, tone: "write" };
    case "edit_file":
    case "edit":
      return { icon: "edit", title: "Edit File", label, tone: "edit" };
    case "grep_files":
    case "grep":
      return { icon: "search", title: "Grep", label, tone: "search" };
    case "find_files":
    case "glob":
      return { icon: "files", title: "Glob", label, tone: "search" };
    case "list_directory":
    case "ls":
      return { icon: "list", title: "List Directory", label, tone: "directory" };
    case "run_shell":
    case "bash":
      return { icon: "terminal", title: "Bash", label, tone: "shell" };
    case "terminal_start":
      return { icon: "terminal", title: "Start Terminal", label, tone: "shell" };
    case "terminal_read":
      return { icon: "terminal", title: "Read Terminal", label, tone: "shell" };
    case "terminal_write":
      return { icon: "terminal", title: "Write Terminal", label, tone: "shell" };
    case "terminal_resize":
      return { icon: "terminal", title: "Resize Terminal", label, tone: "shell" };
    case "terminal_status":
      return { icon: "terminal", title: "Terminal Status", label, tone: "shell" };
    case "terminal_close":
      return { icon: "terminal", title: "Close Terminal", label, tone: "shell" };
    case "show_changes":
      return { icon: "review", title: "Show Changes", label, tone: "review" };
  }
}

function getToolLabel(card: ToolResultCard): string {
  if (card.tool === "workspace_status") return card.root ?? "capabilities and Git state";
  if (card.tool === "close_workspace") return card.root ?? "workspace session";
  if (isTerminalTool(card.tool)) {
    const terminal = card.terminal ?? card.terminals?.[0];
    return String(terminal?.commandSummary ?? terminal?.terminalId ?? card.tool);
  }
  if (isShellTool(card.tool)) {
    return String(card.summary?.command ?? card.path ?? card.tool);
  }
  if (isReviewTool(card.tool)) {
    const count = Number(card.summary?.files ?? card.files?.length ?? 0);
    return count === 0 ? "No changes since last review" : `${count} changed ${count === 1 ? "file" : "files"}`;
  }
  if (card.path) return card.path;
  if (card.root) return card.root;
  if (isSearchTool(card.tool)) {
    return String(card.summary?.pattern ?? card.tool);
  }

  return card.tool;
}

export function summaryBadge(card: ToolResultCard): SummaryBadge {
  const summary = card.summary ?? {};

  if (isReviewTool(card.tool)) {
    return {
      kind: "stats",
      label: "Review diff statistics",
      additions: Number(summary.additions ?? 0),
      removals: Number(summary.removals ?? 0),
    };
  }

  if (isEditTool(card.tool) || isWriteTool(card.tool)) {
    return {
      kind: "stats",
      label: "Diff statistics",
      additions: Number(summary.additions ?? 0),
      removals: Number(summary.removals ?? 0),
    };
  }

  if (card.tool === "open_workspace") {
    return {
      kind: "workspace",
      agentsFiles: summaryNumber(summary, "agentsFiles") ?? 0,
      skills: summaryNumber(summary, "skills") ?? 0,
    };
  }

  if (isTerminalTool(card.tool)) {
    const terminal = card.terminal ?? card.terminals?.[0];
    return { kind: "text", text: String(terminal?.status ?? "terminal") };
  }

  if (isShellTool(card.tool)) {
    return { kind: "text", text: `ran · ${String(summary.lines ?? 0)} lines` };
  }

  return { kind: "text", text: `${String(summary.lines ?? 0)} lines` };
}

/** How many review files the header lists and how many hide behind "Show N more files". */
export function reviewFileCounts(
  card: ToolResultCard,
  filesExpanded: boolean,
): { visible: number; hidden: number } {
  const total = card.files?.length ?? 0;
  const visible = filesExpanded ? total : Math.min(total, REVIEW_COLLAPSED_FILES);
  return { visible, hidden: Math.max(0, total - visible) };
}

export function workspacePayloadText(card: ToolResultCard): string {
  const agentsFiles = card.agentsFiles ?? [];
  const availableAgentsFiles = card.availableAgentsFiles ?? [];
  const skills = card.skills ?? [];
  const capabilities = card.capabilities as {
    fileAccess?: string;
    mountReadOnly?: boolean;
    warnings?: string[];
    git?: { branch?: string; head?: string; dirty?: boolean; strategy?: string };
    runtime?: { shellPath?: string; shellMode?: string; tmux?: boolean; opencode?: string; userSystemd?: boolean; privilegeEscalation?: string };
  } | undefined;
  const worktree = card.worktree as { strategy?: string; sourceCanonicalRoot?: string; baseSha?: string; dirtySource?: boolean } | undefined;
  const lines = [
    ...(capabilities?.warnings ?? []).map((warning) => `Warning: ${warning}`),
    card.workspaceId ? `Workspace: ${card.workspaceId}` : undefined,
    card.root ? `Root: ${card.root}` : undefined,
    card.canonicalRoot ? `Canonical root: ${card.canonicalRoot}` : undefined,
    capabilities?.fileAccess ? `Access: ${capabilities.fileAccess}${capabilities.mountReadOnly ? " (read-only mount)" : ""}` : undefined,
    capabilities?.git ? `Git: ${capabilities.git.branch ?? "detached"} ${capabilities.git.head ?? ""}${capabilities.git.dirty ? " dirty" : " clean"}` : undefined,
    worktree?.strategy ? `Managed strategy: ${worktree.strategy}; source=${worktree.sourceCanonicalRoot ?? "unknown"}; base=${worktree.baseSha ?? "unknown"}${worktree.dirtySource ? "; source dirty" : ""}` : undefined,
    capabilities?.runtime ? `Runtime: ${capabilities.runtime.shellPath ?? "shell"} (${capabilities.runtime.shellMode ?? "service"}), tmux ${capabilities.runtime.tmux ? "available" : "unavailable"}, user-systemd ${capabilities.runtime.userSystemd ? "available" : "unavailable"}, privilege ${capabilities.runtime.privilegeEscalation ?? "unknown"}` : undefined,
    skills.length > 0
      ? `Skills: ${skills.map((skill) => skill.name ?? skill.path ?? "unnamed").join(", ")}`
      : "Skills: none",
    availableAgentsFiles.length > 0
      ? `Nested instructions: ${availableAgentsFiles.map((file) => file.path ?? "unknown").join(", ")}`
      : undefined,
    agentsFiles.length > 0
      ? `\n${formatAgentsFiles(agentsFiles)}`
      : "\nAGENTS.md: none loaded",
  ].filter((line): line is string => typeof line === "string");

  return lines.join("\n");
}

export function terminalPayloadText(card: ToolResultCard): string {
  const terminals = card.terminals ?? (card.terminal ? [card.terminal] : []);
  const lines = terminals.map((terminal) => {
    const id = String(terminal.terminalId ?? "terminal");
    const status = String(terminal.status ?? "unknown");
    const geometry = `${String(terminal.cols ?? "?")}x${String(terminal.rows ?? "?")}`;
    const persistence = terminal.persistentAcrossDevspaceRestart ? "restart-persistent" : "service-lifetime";
    return `${id} ${status} ${geometry} ${persistence}\n${String(terminal.commandSummary ?? "")}`.trim();
  });
  if (card.terminalOutput) lines.push(`\n${card.terminalOutput}`);
  if (card.truncated) lines.push("\n[Terminal output truncated]");
  return lines.join("\n\n");
}

function formatAgentsFiles(agentsFiles: NonNullable<ToolResultCard["agentsFiles"]>): string {
  return agentsFiles
    .map((file) => {
      const path = file.path ?? "AGENTS.md";
      const content = file.content?.trim();
      return content ? `${path}\n\n${content}` : `${path}\n\nNo content loaded.`;
    })
    .join("\n\n");
}

export function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  return `${Math.round(durationMs / 1_000)}s`;
}
