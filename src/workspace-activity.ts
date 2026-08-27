import type { ToolName } from "./tool-contract.js";
import type { ToolResponse } from "./pi-tools.js";

export type WorkspaceActivityStatus = "running" | "success" | "error";

export interface WorkspaceActivityEvent {
  seq: number;
  workspaceId: string;
  operationId: string;
  tool: ToolName;
  machine: {
    id: string;
    displayName: string;
  };
  status: WorkspaceActivityStatus;
  label: string;
  detail?: string;
  startedAt: string;
  durationMs?: number;
  createdAt: string;
}

export type NewWorkspaceActivityEvent = Omit<WorkspaceActivityEvent, "seq">;

export interface WorkspaceActivityPage extends Record<string, unknown> {
  events: WorkspaceActivityEvent[];
  latestSeq: number;
  totalOperations: number;
}

const MAX_LABEL_LENGTH = 180;

export function workspaceActivityLabel(tool: ToolName, args: Record<string, unknown>): string {
  const path = stringArg(args.path);
  switch (tool) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "list_directory":
      return truncate(path ?? tool, MAX_LABEL_LENGTH);
    case "grep_files": {
      const pattern = stringArg(args.pattern);
      return truncate(pattern ? `${pattern}${path ? ` · ${path}` : ""}` : path ?? tool, MAX_LABEL_LENGTH);
    }
    case "find_files":
      return truncate(stringArg(args.pattern) ?? path ?? tool, MAX_LABEL_LENGTH);
    case "run_shell":
      return truncate(stringArg(args.command) ?? "shell command", MAX_LABEL_LENGTH);
    case "terminal_start":
      return truncate(stringArg(args.command) ?? "terminal", MAX_LABEL_LENGTH);
    case "terminal_read":
    case "terminal_write":
    case "terminal_resize":
    case "terminal_status":
    case "terminal_close":
      return truncate(stringArg(args.terminalId) ?? "terminal", MAX_LABEL_LENGTH);
    case "show_changes":
      return "aggregate diff";
    case "workspace_status":
      return "capabilities and Git state";
    case "close_workspace":
      return "workspace session";
    case "multi_read":
      return truncate("batch read", MAX_LABEL_LENGTH);
    case "open_workspace":
      return truncate(stringArg(args.path) ?? "workspace", MAX_LABEL_LENGTH);
    default:
      return truncate(tool, MAX_LABEL_LENGTH);
  }
}

export function workspaceActivityDetail(tool: ToolName, result: ToolResponse): string | undefined {
  if (result.isError) return "failed";

  const structured = result.structuredContent ?? {};
  switch (tool) {
    case "edit_file":
    case "write_file": {
      const stats = diffStats(result.details);
      return stats ? `+${stats.additions} −${stats.removals}` : "applied";
    }
    case "show_changes": {
      const summary = isRecord(structured.summary) ? structured.summary : {};
      const files = finiteNumber(summary.files) ?? (Array.isArray(structured.files) ? structured.files.length : 0);
      const additions = finiteNumber(summary.additions) ?? 0;
      const removals = finiteNumber(summary.removals) ?? 0;
      return `${files} ${files === 1 ? "file" : "files"} · +${additions} −${removals}`;
    }
    case "terminal_start":
    case "terminal_read":
    case "terminal_write":
    case "terminal_resize":
    case "terminal_status":
    case "terminal_close": {
      const terminal = isRecord(structured.terminal)
        ? structured.terminal
        : Array.isArray(structured.terminals) && isRecord(structured.terminals[0])
          ? structured.terminals[0]
          : undefined;
      const status = terminal && typeof terminal.status === "string" ? terminal.status : undefined;
      return status ?? lineDetail(result);
    }
    case "close_workspace": {
      const workspace = isRecord(structured.workspace) ? structured.workspace : undefined;
      if (workspace?.closed === true) return "closed";
      if (workspace?.closed === false) {
        const reason = typeof workspace.reason === "string" ? workspace.reason.trim() : "";
        return reason ? truncate(`remains open · ${reason}`, MAX_LABEL_LENGTH) : "remains open";
      }
      return "completed";
    }
    case "workspace_status":
      return "updated";
    case "open_workspace":
      return "opened";
    case "read_file":
    case "grep_files":
    case "find_files":
    case "list_directory":
    case "run_shell":
    case "multi_read":
      return lineDetail(result);
    default:
      return lineDetail(result);
  }
}

function lineDetail(result: ToolResponse): string {
  const text = result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const lines = text.length === 0 ? 0 : text.split("\n").length;
  return `${lines} ${lines === 1 ? "line" : "lines"}`;
}

function diffStats(details: unknown): { additions: number; removals: number } | undefined {
  if (!isRecord(details) || typeof details.diff !== "string" || !details.diff) return undefined;
  let additions = 0;
  let removals = 0;
  for (const line of details.diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) removals += 1;
  }
  return { additions, removals };
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, Math.max(0, limit - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
