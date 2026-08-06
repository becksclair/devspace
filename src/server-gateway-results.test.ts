import assert from "node:assert/strict";
import { gatewayPublicResult } from "./server.js";
import type { RoutedExecution } from "./gateway-router.js";
import { CANONICAL_TOOL_NAMES } from "./tool-contract.js";

for (const tool of CANONICAL_TOOL_NAMES) {
  const routed: RoutedExecution = {
    machine: { id: "asgard", displayName: "Asgard" },
    publicWorkspaceId: "gw_public",
    result: {
      content: [{ type: "text", text: "workspace gw_public" }],
      structuredContent: tool === "open_workspace"
        ? { workspaceId: "gw_public", root: "/workspace", machine: { id: "asgard", displayName: "Asgard" } }
        : tool === "show_changes"
          ? { result: "changes", summary: {}, files: [], patch: "" }
          : { result: "ok" },
    },
  };
  const result = gatewayPublicResult(routed, tool, tool, { workspaceId: "gw_public", path: "file" });
  assert.ok("_meta" in result, `${tool} metadata`);
  const card = (result._meta as { card: { machine: unknown; workspaceId: string } }).card;
  assert.deepEqual(card.machine, { id: "asgard", displayName: "Asgard" }, `${tool} card machine`);
  assert.equal(card.workspaceId, "gw_public", `${tool} public workspace ID`);
  assert.equal(JSON.stringify(result).includes("private"), false, `${tool} leaks no private ID fixture`);
}

const failed = gatewayPublicResult({
  machine: { id: "saga", displayName: "Saga" },
  publicWorkspaceId: "gw_public",
  result: {
    content: [{ type: "text", text: "failed in gw_public" }],
    structuredContent: { workspaceId: "gw_public", result: "failed" },
    isError: true,
  },
}, "read_file", "read_file", { workspaceId: "gw_public", path: "missing" });
assert.equal(failed.isError, true);
assert.ok("_meta" in failed);
assert.deepEqual(failed._meta.card.machine, { id: "saga", displayName: "Saga" });
assert.equal(failed._meta.card.workspaceId, "gw_public");
assert.equal(JSON.stringify(failed).includes("private"), false);

const shell = gatewayPublicResult({
  machine: { id: "saga", displayName: "Saga" },
  publicWorkspaceId: "gw_public",
  result: {
    content: [{ type: "text", text: "one\ntwo" }],
  },
}, "run_shell", "bash", {
  workspaceId: "gw_public",
  command: "printf 'one'\n  && printf 'two'",
});
assert.equal(shell._meta.card.summary.command, "printf 'one' && printf 'two'");
assert.equal(shell._meta.card.summary.lines, 2);
