import assert from "node:assert/strict";
import test from "node:test";
import { isExpandableCard, isTerminalTool, isToolName, machineDisplayName, type ToolResultCard } from "./card-types.js";

test("machineDisplayName returns the configured display name", () => {
  const card = {
    tool: "read_file",
    machine: { id: "orion", displayName: "Orion" },
  } satisfies ToolResultCard;

  assert.equal(machineDisplayName(card), "Orion");
});

test("terminal tools are recognized and expandable", () => {
  assert.equal(isToolName("terminal_read"), true);
  assert.equal(isTerminalTool("terminal_read"), true);
  assert.equal(isTerminalTool("run_shell"), false);
  assert.equal(isExpandableCard({ tool: "terminal_read", terminalOutput: "hello" }), true);
});

test("machineDisplayName preserves standalone cards without a machine", () => {
  assert.equal(machineDisplayName({ tool: "read_file" } as ToolResultCard), undefined);
  assert.equal(
    machineDisplayName({ tool: "read_file", machine: { id: "orion", displayName: "  " } } as ToolResultCard),
    undefined,
  );
});
