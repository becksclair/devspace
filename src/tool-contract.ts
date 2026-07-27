import { createHash } from "node:crypto";
import * as z from "zod/v4";

/** Internal names are deliberately independent of the public short/legacy names. */
export const CANONICAL_TOOL_NAMES = [
  "open_workspace",
  "read_file",
  "write_file",
  "edit_file",
  "grep_files",
  "find_files",
  "list_directory",
  "run_shell",
  "show_changes",
] as const;
export type ToolName = (typeof CANONICAL_TOOL_NAMES)[number];

export const TOOL_SCHEMAS = {
  open_workspace: z.object({ path: z.string(), mode: z.enum(["checkout", "worktree"]).optional(), baseRef: z.string().optional() }),
  read_file: z.object({ workspaceId: z.string(), path: z.string(), offset: z.number().int().positive().optional(), limit: z.number().int().positive().optional() }),
  write_file: z.object({ workspaceId: z.string(), path: z.string(), content: z.string() }),
  edit_file: z.object({ workspaceId: z.string(), path: z.string(), edits: z.array(z.object({ oldText: z.string(), newText: z.string() })) }),
  grep_files: z.object({ workspaceId: z.string(), pattern: z.string(), path: z.string().optional(), include: z.string().optional() }),
  find_files: z.object({ workspaceId: z.string(), pattern: z.string(), path: z.string().optional() }),
  list_directory: z.object({ workspaceId: z.string(), path: z.string() }),
  run_shell: z.object({ workspaceId: z.string(), command: z.string(), workingDirectory: z.string().optional(), timeout: z.number().positive().max(300).optional() }),
  show_changes: z.object({ workspaceId: z.string(), since: z.enum(["last_shown", "workspace_open"]).optional(), markReviewed: z.boolean().optional() }),
} as const satisfies Record<ToolName, z.ZodType>;

export type ToolArguments<N extends ToolName = ToolName> = z.infer<(typeof TOOL_SCHEMAS)[N]>;

// Stable derivation: this is a hand-maintained, ordered description of the wire contract.
// Do not hash Zod's private _def; it is not guaranteed stable across library releases.
const CONTRACT_DESCRIPTION = CANONICAL_TOOL_NAMES.map((name) => ({
  name,
  fields: {
    open_workspace: ["path:string", "mode?:checkout|worktree", "baseRef?:string"],
    read_file: ["workspaceId:string", "path:string", "offset?:positive-int", "limit?:positive-int"],
    write_file: ["workspaceId:string", "path:string", "content:string"],
    edit_file: ["workspaceId:string", "path:string", "edits:array<{oldText:string,newText:string}>"] ,
    grep_files: ["workspaceId:string", "pattern:string", "path?:string", "include?:string"],
    find_files: ["workspaceId:string", "pattern:string", "path?:string"],
    list_directory: ["workspaceId:string", "path:string"],
    run_shell: ["workspaceId:string", "command:string", "workingDirectory?:string", "timeout?:positive-number<=300"],
    show_changes: ["workspaceId:string", "since?:last_shown|workspace_open", "markReviewed?:boolean"],
  }[name],
}));
export function canonicalToolContract(): string { return JSON.stringify(CONTRACT_DESCRIPTION); }
export const TOOL_CONTRACT_HASH = `sha256:${createHash("sha256").update(canonicalToolContract(), "utf8").digest("hex")}`;

export function parseToolArguments<N extends ToolName>(name: N, value: unknown): ToolArguments<N> {
  return TOOL_SCHEMAS[name].parse(value) as ToolArguments<N>;
}
