import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { CANONICAL_TOOL_NAMES, TOOL_CONTRACT_HASH, TOOL_SCHEMAS, canonicalToolContract, parseToolArguments } from "./tool-contract.js";

test("internal tool contract has fixed names and deterministic lowercase hash", () => {
  assert.deepEqual(CANONICAL_TOOL_NAMES, [
    "open_workspace", "workspace_status", "close_workspace",
    "read_file", "multi_read", "write_file", "edit_file", "grep_files", "find_files", "list_directory", "run_shell",
    "terminal_start", "terminal_read", "terminal_write", "terminal_resize", "terminal_status", "terminal_close",
    "show_changes",
  ]);
  assert.match(TOOL_CONTRACT_HASH, /^sha256:[0-9a-f]{64}$/);
  assert.equal(TOOL_CONTRACT_HASH, `sha256:${createHash("sha256").update(canonicalToolContract()).digest("hex")}`);
  assert.equal(parseToolArguments("open_workspace", { path: "/tmp", create: true, fresh: true }).fresh, true);
  assert.equal(parseToolArguments("workspace_status", { workspaceId: "w" }).workspaceId, "w");
  assert.equal(parseToolArguments("terminal_resize", { workspaceId: "w", terminalId: "t", cols: 120, rows: 40 }).cols, 120);
  assert.throws(() => parseToolArguments("show_changes", { workspaceId: "x", since: "bad" }));
  assert.equal(Object.keys(TOOL_SCHEMAS).length, CANONICAL_TOOL_NAMES.length);
});
