import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { CANONICAL_TOOL_NAMES, TOOL_CONTRACT_HASH, TOOL_SCHEMAS, canonicalToolContract, parseToolArguments } from "./tool-contract.js";

test("internal tool contract has fixed names and deterministic lowercase hash", () => {
  assert.deepEqual(CANONICAL_TOOL_NAMES, ["open_workspace", "read_file", "write_file", "edit_file", "grep_files", "find_files", "list_directory", "run_shell", "show_changes"]);
  assert.match(TOOL_CONTRACT_HASH, /^sha256:[0-9a-f]{64}$/);
  assert.equal(TOOL_CONTRACT_HASH, `sha256:${createHash("sha256").update(canonicalToolContract()).digest("hex")}`);
  assert.equal(parseToolArguments("open_workspace", { path: "/tmp" }).path, "/tmp");
  assert.throws(() => parseToolArguments("show_changes", { workspaceId: "x", since: "bad" }));
  assert.equal(Object.keys(TOOL_SCHEMAS).length, CANONICAL_TOOL_NAMES.length);
});
