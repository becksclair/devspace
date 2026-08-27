import { createHash } from "node:crypto";
import * as z from "zod/v4";

/** Internal names are deliberately independent of the public short/legacy names. */
export const CANONICAL_TOOL_NAMES = [
  "open_workspace",
  "workspace_status",
  "close_workspace",
  "read_file",
  "multi_read",
  "write_file",
  "edit_file",
  "grep_files",
  "find_files",
  "list_directory",
  "run_shell",
  "terminal_start",
  "terminal_read",
  "terminal_write",
  "terminal_resize",
  "terminal_status",
  "terminal_close",
  "show_changes",
] as const;
export type ToolName = (typeof CANONICAL_TOOL_NAMES)[number];

export const TOOL_SCHEMAS = {
  open_workspace: z.object({ path: z.string(), mode: z.enum(["checkout", "worktree", "isolated"]).optional(), baseRef: z.string().optional(), create: z.boolean().optional(), fresh: z.boolean().optional() }),
  workspace_status: z.object({ workspaceId: z.string() }),
  close_workspace: z.object({ workspaceId: z.string() }),
  read_file: z.object({ workspaceId: z.string(), path: z.string(), offset: z.number().int().positive().optional(), limit: z.number().int().positive().optional() }),
  multi_read: z.object({
    workspaceId: z.string(),
    reads: z.array(z.object({ path: z.string(), offset: z.number().int().positive().optional(), limit: z.number().int().positive().optional() })).min(1).max(20),
    maxBytesPerFile: z.number().int().positive().max(2_000_000).optional(),
    maxTotalBytes: z.number().int().positive().max(10_000_000).optional(),
  }),
  write_file: z.object({ workspaceId: z.string(), path: z.string(), content: z.string() }),
  edit_file: z.object({ workspaceId: z.string(), path: z.string(), edits: z.array(z.object({ oldText: z.string(), newText: z.string() })) }),
  grep_files: z.object({ workspaceId: z.string(), pattern: z.string(), path: z.string().optional(), include: z.string().optional() }),
  find_files: z.object({ workspaceId: z.string(), pattern: z.string(), path: z.string().optional() }),
  list_directory: z.object({ workspaceId: z.string(), path: z.string() }),
  run_shell: z.object({ workspaceId: z.string(), command: z.string(), workingDirectory: z.string().optional(), timeout: z.number().positive().max(300).optional() }),
  terminal_start: z.object({
    workspaceId: z.string(),
    command: z.string().min(1),
    workingDirectory: z.string().optional(),
    cols: z.number().int().min(40).max(400).optional(),
    rows: z.number().int().min(10).max(200).optional(),
    shellMode: z.enum(["service", "login"]).optional(),
    retainOnWorkspaceClose: z.boolean().optional(),
  }),
  terminal_read: z.object({ workspaceId: z.string(), terminalId: z.string(), mode: z.enum(["screen", "history"]).optional(), lines: z.number().int().min(1).max(2000).optional() }),
  terminal_write: z.object({ workspaceId: z.string(), terminalId: z.string(), text: z.string().optional(), keys: z.array(z.string()).max(32).optional(), submit: z.boolean().optional() }),
  terminal_resize: z.object({ workspaceId: z.string(), terminalId: z.string(), cols: z.number().int().min(40).max(400), rows: z.number().int().min(10).max(200) }),
  terminal_status: z.object({ workspaceId: z.string(), terminalId: z.string().optional() }),
  terminal_close: z.object({ workspaceId: z.string(), terminalId: z.string(), force: z.boolean().optional() }),
  show_changes: z.object({ workspaceId: z.string(), since: z.enum(["last_shown", "workspace_open"]).optional(), markReviewed: z.boolean().optional() }),
} as const satisfies Record<ToolName, z.ZodType>;

export type ToolArguments<N extends ToolName = ToolName> = z.infer<(typeof TOOL_SCHEMAS)[N]>;

// Stable derivation: this is a hand-maintained, ordered description of the wire contract.
// Do not hash Zod's private _def; it is not guaranteed stable across library releases.
const CONTRACT_DESCRIPTION = CANONICAL_TOOL_NAMES.map((name) => ({
  name,
  fields: {
    open_workspace: ["path:string", "mode?:checkout|worktree|isolated", "baseRef?:string", "create?:boolean", "fresh?:boolean"],
    workspace_status: ["workspaceId:string"],
    close_workspace: ["workspaceId:string"],
    read_file: ["workspaceId:string", "path:string", "offset?:positive-int", "limit?:positive-int"],
    multi_read: ["workspaceId:string", "reads:array<{path:string,offset?:positive-int,limit?:positive-int}>", "maxBytesPerFile?:positive-int", "maxTotalBytes?:positive-int"],
    write_file: ["workspaceId:string", "path:string", "content:string"],
    edit_file: ["workspaceId:string", "path:string", "edits:array<{oldText:string,newText:string}>"] ,
    grep_files: ["workspaceId:string", "pattern:string", "path?:string", "include?:string"],
    find_files: ["workspaceId:string", "pattern:string", "path?:string"],
    list_directory: ["workspaceId:string", "path:string"],
    run_shell: ["workspaceId:string", "command:string", "workingDirectory?:string", "timeout?:positive-number<=300"],
    terminal_start: ["workspaceId:string", "command:string", "workingDirectory?:string", "cols?:int40-400", "rows?:int10-200", "shellMode?:service|login", "retainOnWorkspaceClose?:boolean"],
    terminal_read: ["workspaceId:string", "terminalId:string", "mode?:screen|history", "lines?:int1-2000"],
    terminal_write: ["workspaceId:string", "terminalId:string", "text?:string", "keys?:string[]", "submit?:boolean"],
    terminal_resize: ["workspaceId:string", "terminalId:string", "cols:int40-400", "rows:int10-200"],
    terminal_status: ["workspaceId:string", "terminalId?:string"],
    terminal_close: ["workspaceId:string", "terminalId:string", "force?:boolean"],
    show_changes: ["workspaceId:string", "since?:last_shown|workspace_open", "markReviewed?:boolean"],
  }[name],
}));
export function canonicalToolContract(): string { return JSON.stringify(CONTRACT_DESCRIPTION); }
export const TOOL_CONTRACT_HASH = `sha256:${createHash("sha256").update(canonicalToolContract(), "utf8").digest("hex")}`;

export function parseToolArguments<N extends ToolName>(name: N, value: unknown): ToolArguments<N> {
  return TOOL_SCHEMAS[name].parse(value) as ToolArguments<N>;
}
