import { lazy, Suspense } from "react";
import {
  isEditTool,
  isReadTool,
  isReviewTool,
  isTerminalTool,
  isWriteTool,
  payloadText,
  type ToolResultCard,
} from "./card-types.js";
import { PayloadErrorBoundary, StatusLine, type ThemeType } from "./payload-fallback.js";
import { plainRenderText } from "./render-fallback.js";
import { terminalPayloadText, workspacePayloadText } from "./tool-display.js";

// The code and diff renderers pull in @pierre/diffs and Shiki, so they load on demand.
const HeavyPayload = lazy(() => import("./heavy-payload.js"));
const ReviewPayload = lazy(() => import("./review-payload.js"));

/** The expanded body of a card (the review card's file list is always shown). */
export function PayloadBody({
  card,
  themeType,
  visibleFileCount,
  tornDown,
}: {
  card: ToolResultCard;
  themeType: ThemeType;
  visibleFileCount?: number;
  tornDown: boolean;
}) {
  if (card.isError) {
    // A failed call's payload is its error message, never code to highlight.
    return (
      <pre className="text-payload error-payload" role="alert">
        {payloadText(card.payload) || "The tool call failed without a message."}
      </pre>
    );
  }

  if (card.tool === "open_workspace" || card.tool === "workspace_status") {
    return <pre className="text-payload open_workspace">{workspacePayloadText(card)}</pre>;
  }

  if (isTerminalTool(card.tool)) {
    return (
      <pre className={`text-payload ${card.tool}`}>
        {terminalPayloadText(card) || "No terminal details available."}
      </pre>
    );
  }

  const heavy = isReadTool(card.tool) || isEditTool(card.tool) || isWriteTool(card.tool);
  if (heavy || isReviewTool(card.tool)) {
    // After ui/resource-teardown the renderers are unmounted and not loaded again.
    if (tornDown) return null;
    return (
      <PayloadErrorBoundary fallbackText={plainRenderText(card)} tool={card.tool}>
        {heavy ? (
          <Suspense fallback={<StatusLine message="Loading details..." />}>
            <HeavyPayload card={card} themeType={themeType} />
          </Suspense>
        ) : (
          <Suspense fallback={<StatusLine message="Loading review..." />}>
            <ReviewPayload card={card} themeType={themeType} visibleFileCount={visibleFileCount} />
          </Suspense>
        )}
      </PayloadErrorBoundary>
    );
  }

  const text = payloadText(card.payload);
  if (!text) return <StatusLine message="No details available." />;
  return <pre className={`text-payload ${card.tool}`}>{text}</pre>;
}
