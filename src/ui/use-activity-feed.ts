import { useEffect, useState } from "react";
import type { App } from "@modelcontextprotocol/ext-apps/react";
import type { ToolResultCard } from "./card-types.js";
import {
  ACTIVITY_REQUEST_TIMEOUT_MS,
  ACTIVITY_RETRY_DELAY_MS,
  ACTIVITY_TOOL,
  ACTIVITY_UNAVAILABLE,
  EMPTY_ACTIVITY_FEED,
  activityPollArguments,
  activityPollFailed,
  applyActivityPage,
  closesWorkspace,
  isWorkspaceActivityPage,
  type ActivityFeed,
} from "./activity-feed.js";

/**
 * Long-polls `workspace_activity` for an `open_workspace` card while the widget is connected and
 * not torn down. A new tool result (`cardVersion`), teardown, or unmount aborts the in-flight call
 * and any retry delay. The first poll returns at once; if it fails the feed stays disabled and the
 * plain workspace card shows. After that, polls wait up to 20 s for new events, and a failed poll
 * shows its error and retries after 2 s. Polling stops when the workspace is closed.
 */
export function useActivityFeed(
  app: App | null,
  card: ToolResultCard | null,
  cardVersion: number,
  active: boolean,
): ActivityFeed {
  const [state, setState] = useState<{ version: number; feed: ActivityFeed }>({
    version: cardVersion,
    feed: EMPTY_ACTIVITY_FEED,
  });
  const workspaceId = card?.tool === "open_workspace" ? card.workspaceId : undefined;

  useEffect(() => {
    if (!app || !active || !workspaceId) return;
    const controller = new AbortController();
    const { signal } = controller;
    const publish = (feed: ActivityFeed) => {
      if (!signal.aborted) setState({ version: cardVersion, feed });
    };

    void (async () => {
      let feed = EMPTY_ACTIVITY_FEED;
      while (!signal.aborted) {
        try {
          const result = await app.callServerTool(
            { name: ACTIVITY_TOOL, arguments: activityPollArguments(workspaceId, feed) },
            { timeout: ACTIVITY_REQUEST_TIMEOUT_MS, signal },
          );
          if (signal.aborted) return;
          const page: unknown = result.structuredContent;
          if (result.isError || !isWorkspaceActivityPage(page)) throw new Error(ACTIVITY_UNAVAILABLE);
          feed = applyActivityPage(feed, page);
          publish(feed);
          if (closesWorkspace(page)) return;
        } catch (failure) {
          if (signal.aborted || !feed.enabled) return;
          feed = activityPollFailed(feed, failure);
          publish(feed);
          await abortableDelay(ACTIVITY_RETRY_DELAY_MS, signal);
        }
      }
    })();

    return () => controller.abort();
  }, [app, active, workspaceId, cardVersion]);

  return state.version === cardVersion ? state.feed : EMPTY_ACTIVITY_FEED;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
