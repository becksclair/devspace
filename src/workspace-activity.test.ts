import assert from "node:assert/strict";
import test from "node:test";
import { workspaceActivityLabel, workspaceActivityDetail } from "./workspace-activity.js";
import type { ToolName } from "./tool-contract.js";

test("workspace-activity covers all canonical tool names (compilation guard)", () => {
  const names: ToolName[] = [
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
  ];
  for (const name of names) {
    const label = workspaceActivityLabel(name, {});
    assert.strictEqual(typeof label, "string");
    assert.ok(label.length > 0, `label for ${name} must be non-empty`);
  }
});

test("workspace-activity label handles args", () => {
  assert.ok(workspaceActivityLabel("read_file", { path: "/a/b" }).includes("/a/b"));
  assert.ok(workspaceActivityLabel("run_shell", { command: "echo hi" }).includes("echo hi"));
  assert.ok(workspaceActivityLabel("multi_read", {}).includes("batch"));
});

test("workspace-activity detail handles error results", () => {
  const errorResult = { isError: true, content: [{ type: "text", text: "bad" }], details: undefined };
  assert.strictEqual(workspaceActivityDetail("read_file", errorResult as any), "failed");
});

test("workspace-activity detail handles all tool names", () => {
  const result = { isError: false, content: [{ type: "text", text: "ok" }], structuredContent: {}, details: undefined };
  const names: ToolName[] = [
    "open_workspace", "workspace_status", "close_workspace", "read_file", "multi_read",
    "write_file", "edit_file", "grep_files", "find_files", "list_directory", "run_shell",
    "terminal_start", "terminal_read", "terminal_write", "terminal_resize", "terminal_status", "terminal_close",
    "show_changes",
  ];
  for (const name of names) {
    const detail = workspaceActivityDetail(name, result as any);
    assert.strictEqual(typeof detail, "string", `detail for ${name} must be string`);
  }
});
