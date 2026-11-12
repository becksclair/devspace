import { useCallback, useReducer } from "react";
import { flushSync } from "react-dom";
import { useApp, type App } from "@modelcontextprotocol/ext-apps/react";
import { useActivityFeed } from "./use-activity-feed.js";
import { useHostContext } from "./use-host-context.js";
import { initialWidgetState, widgetReducer, type WidgetAction } from "./widget-state.js";
import { WorkspaceView } from "./workspace-view.js";

const APP_INFO = { name: "devspace-tool-cards", version: "0.4.0" };

/** Connects to the host, holds the widget state, and renders the current card. */
export function WorkspaceApp() {
  const [state, dispatch] = useReducer(widgetReducer, initialWidgetState);

  // Handlers must be registered before connect() so the first tool result is not missed.
  // useApp calls onAppCreated once, and `dispatch` is stable.
  const onAppCreated = useCallback((created: App) => registerHandlers(created, dispatch), []);
  const { app, isConnected, error } = useApp({ appInfo: APP_INFO, capabilities: {}, onAppCreated });

  const hostContext = useHostContext(app);
  const feed = useActivityFeed(app, state.card, state.cardVersion, !state.tornDown);

  return (
    <WorkspaceView
      connected={isConnected}
      connectionError={error ? error.message : null}
      state={state}
      feed={feed}
      themeType={hostContext?.theme === "light" ? "light" : "dark"}
      onToggleExpanded={() => dispatch({ type: "toggleExpanded" })}
      onShowAllReviewFiles={() => dispatch({ type: "showAllReviewFiles" })}
      onToggleActivityExpanded={() => dispatch({ type: "toggleActivityExpanded" })}
    />
  );
}

function registerHandlers(app: App, dispatch: (action: WidgetAction) => void): void {
  app.addEventListener("toolresult", (result) => dispatch({ type: "toolResult", result }));
  // Teardown is a request with a result, so it has no addEventListener form. Committing it
  // synchronously runs the poller's cleanup, which cancels an in-flight poll before the response.
  app.onteardown = () => {
    flushSync(() => dispatch({ type: "teardown" }));
    return {};
  };
}
