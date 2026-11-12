import assert from "node:assert/strict";
import type { ToolResultCard } from "./card-types.js";
import {
  formatDuration,
  getToolDisplay,
  reviewFileCounts,
  summaryBadge,
  terminalPayloadText,
  toolTitle,
  workspacePayloadText,
} from "./tool-display.js";

const read: ToolResultCard = { tool: "read_file", path: "src/a.ts", summary: { lines: 9 } };
assert.deepEqual(getToolDisplay(read), { icon: "file", title: "Read File", label: "src/a.ts", tone: "read" });
assert.deepEqual(summaryBadge(read), { kind: "text", text: "9 lines" });

const shell: ToolResultCard = { tool: "run_shell", summary: { command: "ls", lines: 5 } };
assert.deepEqual(getToolDisplay(shell), { icon: "terminal", title: "Bash", label: "ls", tone: "shell" });
assert.deepEqual(summaryBadge(shell), { kind: "text", text: "ran · 5 lines" });

assert.equal(getToolDisplay({ tool: "grep", summary: { pattern: "greet" } }).label, "greet");
assert.equal(getToolDisplay({ tool: "workspace_status" }).label, "capabilities and Git state");
assert.equal(getToolDisplay({ tool: "close_workspace", root: "/r" }).label, "/r");
assert.equal(getToolDisplay({ tool: "terminal_read", terminal: { terminalId: "t1" } }).label, "t1");
assert.deepEqual(summaryBadge({ tool: "terminal_read", terminal: { status: "running" } }), { kind: "text", text: "running" });

const review: ToolResultCard = { tool: "show_changes", summary: { files: 7, additions: 19, removals: 9 }, files: Array.from({ length: 7 }, (_, i) => ({ path: `f${i}` })) };
assert.equal(getToolDisplay(review).label, "7 changed files");
assert.equal(getToolDisplay({ tool: "show_changes", summary: { files: 1 } }).label, "1 changed file");
assert.equal(getToolDisplay({ tool: "show_changes" }).label, "No changes since last review");
assert.deepEqual(summaryBadge(review), { kind: "stats", label: "Review diff statistics", additions: 19, removals: 9 });
assert.deepEqual(reviewFileCounts(review, false), { visible: 3, hidden: 4 });
assert.deepEqual(reviewFileCounts(review, true), { visible: 7, hidden: 0 });
assert.deepEqual(reviewFileCounts({ tool: "show_changes" }, false), { visible: 0, hidden: 0 });

assert.deepEqual(summaryBadge({ tool: "open_workspace", summary: { agentsFiles: 1, skills: 2 } }), { kind: "workspace", agentsFiles: 1, skills: 2 });

assert.equal(toolTitle("list_directory"), "List");
assert.equal(toolTitle("show_changes"), "Changes");

assert.equal(
  workspacePayloadText({
    tool: "open_workspace",
    workspaceId: "ws1",
    root: "/repo",
    capabilities: { fileAccess: "read-write", git: { branch: "main", head: "abc", dirty: false } },
    agentsFiles: [{ path: "AGENTS.md", content: " Rules \n" }],
  }),
  "Workspace: ws1\nRoot: /repo\nAccess: read-write\nGit: main abc clean\nSkills: none\n\nAGENTS.md\n\nRules",
);
assert.match(workspacePayloadText({ tool: "workspace_status" }), /Skills: none\n\nAGENTS\.md: none loaded$/);

assert.equal(
  terminalPayloadText({ tool: "terminal_read", terminal: { terminalId: "t1", status: "running", cols: 80, rows: 24, commandSummary: "bash" }, terminalOutput: "hi", truncated: true }),
  "t1 running 80x24 service-lifetime\nbash\n\n\nhi\n\n\n[Terminal output truncated]",
);

assert.equal(formatDuration(undefined), undefined);
assert.equal(formatDuration(12), "12ms");
assert.equal(formatDuration(1_500), "1.5s");
assert.equal(formatDuration(12_400), "12s");

console.log("tool-display tests passed");
