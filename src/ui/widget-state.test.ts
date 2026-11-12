import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { NO_CARD_MESSAGE, cardFromToolResult, initialWidgetState, widgetReducer } from "./widget-state.js";

function result(partial: Partial<CallToolResult>): CallToolResult {
  return { content: [], ...partial } as CallToolResult;
}

// `_meta.tool` names the card and `_meta.card` overlays structuredContent.
assert.deepEqual(
  cardFromToolResult(result({
    structuredContent: { path: "a.ts", summary: { lines: 3 } },
    _meta: { tool: "read_file", card: { payload: { content: [{ type: "text", text: "x" }] } } },
  })),
  { path: "a.ts", summary: { lines: 3 }, payload: { content: [{ type: "text", text: "x" }] }, tool: "read_file" },
);
assert.equal(cardFromToolResult(result({ structuredContent: { path: "a.ts" } })), null, "no _meta.tool");
assert.equal(cardFromToolResult(result({ _meta: { tool: "not_a_tool" }, structuredContent: {} })), null);
assert.equal(cardFromToolResult(result({ _meta: { tool: "read_file" } })), null, "no structured card");
assert.deepEqual(cardFromToolResult(result({ _meta: { tool: "read_file", card: { path: "b" } } })), { path: "b", tool: "read_file" });

// isError comes from the result, not the card.
assert.equal(cardFromToolResult(result({ isError: true, _meta: { tool: "run_shell", card: { summary: {} } } }))?.isError, true);
assert.equal(cardFromToolResult(result({ _meta: { tool: "run_shell", card: { summary: {} } } }))?.isError, undefined);

// A result resets the per-card toggles and bumps the version.
let state = widgetReducer(initialWidgetState, {
  type: "toolResult",
  result: result({ _meta: { tool: "edit_file" }, structuredContent: { path: "a.ts", payload: { patch: "p" } } }),
});
assert.equal(state.card?.tool, "edit_file");
assert.equal(state.cardVersion, 1);
assert.equal(state.errorMessage, null);
state = widgetReducer(state, { type: "toggleExpanded" });
state = widgetReducer(state, { type: "showAllReviewFiles" });
state = widgetReducer(state, { type: "toggleActivityExpanded" });
state = widgetReducer(state, { type: "teardown" });
assert.deepEqual(
  [state.expanded, state.reviewFilesExpanded, state.activityExpanded, state.tornDown],
  [true, true, true, true],
);
state = widgetReducer(state, { type: "toggleExpanded" });
assert.equal(state.expanded, false);

// A result without a card shows the error; a later result (even after teardown) starts afresh.
state = widgetReducer(state, { type: "toolResult", result: result({ content: [{ type: "text", text: "plain" }] }) });
assert.equal(state.card, null);
assert.equal(state.errorMessage, NO_CARD_MESSAGE);
assert.equal(state.cardVersion, 2);
// A failure raised before a card could be built keeps its own text.
const failedWithoutCard = widgetReducer(state, { type: "toolResult", result: result({ isError: true, content: [{ type: "text", text: "Unknown workspace" }] }) });
assert.equal(failedWithoutCard.card, null);
assert.equal(failedWithoutCard.errorMessage, "Unknown workspace");
assert.equal(widgetReducer(state, { type: "toolResult", result: result({ isError: true, content: [] }) }).errorMessage, NO_CARD_MESSAGE);
assert.equal(state.tornDown, false);
assert.equal(state.reviewFilesExpanded, false);

console.log("widget-state tests passed");
