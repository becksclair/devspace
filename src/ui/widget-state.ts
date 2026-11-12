// Widget state: the current result card and the view toggles that belong to it.

import type { CallToolResult } from "@modelcontextprotocol/client";
import { isToolName, isToolResultCard, type ToolName, type ToolResultCard } from "./card-types.js";

export interface WidgetState {
  card: ToolResultCard | null;
  /** Increments on every delivered tool result, so effects can restart per result. */
  cardVersion: number;
  /** Shown instead of a card when a result carries no card. */
  errorMessage: string | null;
  expanded: boolean;
  reviewFilesExpanded: boolean;
  activityExpanded: boolean;
  /** Set by `ui/resource-teardown`: stop polling and drop the heavy renderers. */
  tornDown: boolean;
}

export type WidgetAction =
  | { type: "toolResult"; result: CallToolResult }
  | { type: "toggleExpanded" }
  | { type: "showAllReviewFiles" }
  | { type: "toggleActivityExpanded" }
  | { type: "teardown" };

export const NO_CARD_MESSAGE = "No result card is available for this tool result.";

export const initialWidgetState: WidgetState = {
  card: null,
  cardVersion: 0,
  errorMessage: null,
  expanded: false,
  reviewFilesExpanded: false,
  activityExpanded: false,
  tornDown: false,
};

export function widgetReducer(state: WidgetState, action: WidgetAction): WidgetState {
  switch (action.type) {
    case "toolResult": {
      const card = cardFromToolResult(action.result);
      return {
        ...initialWidgetState,
        card,
        cardVersion: state.cardVersion + 1,
        errorMessage: card ? null : NO_CARD_MESSAGE,
      };
    }
    case "toggleExpanded":
      return { ...state, expanded: !state.expanded };
    case "showAllReviewFiles":
      return { ...state, reviewFilesExpanded: true };
    case "toggleActivityExpanded":
      return { ...state, activityExpanded: !state.activityExpanded };
    case "teardown":
      return { ...state, tornDown: true };
  }
}

/**
 * Builds the card from a tool result: `_meta.tool` names the card and `_meta.card` overlays
 * `structuredContent`. Returns null when the result carries no card.
 */
export function cardFromToolResult(result: CallToolResult): ToolResultCard | null {
  const meta = result._meta as Record<string, unknown> | undefined;
  const tool: unknown = meta?.tool;
  const metaCard = meta?.card && typeof meta.card === "object" ? (meta.card as Partial<ToolResultCard>) : undefined;
  const structuredContent = result.structuredContent as Partial<ToolResultCard> | undefined;
  const structured = metaCard ? { ...structuredContent, ...metaCard } : structuredContent;
  if (!isToolName(tool) || !isToolResultCard(structured)) return null;
  return { ...structured, tool: tool as ToolName };
}
