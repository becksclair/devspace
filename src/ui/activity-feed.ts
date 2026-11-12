// Pure state and cursor handling for the workspace activity feed (the `workspace_activity` long
// poll behind the gateway's live workspace card). The polling loop lives in use-activity-feed.ts.

import { isToolName, type ToolName } from "./card-types.js";

export interface WorkspaceActivityEvent {
  seq: number;
  workspaceId: string;
  operationId: string;
  tool: ToolName;
  machine: { id: string; displayName: string };
  status: "running" | "success" | "error";
  label: string;
  detail?: string;
  startedAt: string;
  durationMs?: number;
  createdAt: string;
}

export interface WorkspaceActivityPage {
  events: WorkspaceActivityEvent[];
  latestSeq: number;
  totalOperations: number;
}

export interface ActivityFeed {
  /** True once a page has been accepted; until then the plain workspace card shows. */
  enabled: boolean;
  /** Latest event per operation. */
  events: ReadonlyMap<string, WorkspaceActivityEvent>;
  /** The `afterSeq` of the next poll. */
  cursor: number;
  totalOperations: number;
  error: string | null;
}

export const ACTIVITY_TOOL = "workspace_activity";
const ACTIVITY_PAGE_LIMIT = 200;
export const ACTIVITY_MAX_OPERATIONS = 200;
const ACTIVITY_WAIT_MS = 20_000;
export const ACTIVITY_REQUEST_TIMEOUT_MS = 25_000;
export const ACTIVITY_RETRY_DELAY_MS = 2_000;
export const ACTIVITY_COLLAPSED_ROWS = 7;
export const ACTIVITY_UNAVAILABLE = "Workspace activity feed is unavailable.";

export const EMPTY_ACTIVITY_FEED: ActivityFeed = {
  enabled: false,
  events: new Map(),
  cursor: 0,
  totalOperations: 0,
  error: null,
};

/** Arguments of the next poll: the first returns at once, later ones long-poll. */
export function activityPollArguments(workspaceId: string, feed: ActivityFeed): Record<string, unknown> {
  return {
    workspaceId,
    afterSeq: feed.cursor,
    limit: ACTIVITY_PAGE_LIMIT,
    waitMs: feed.enabled ? ACTIVITY_WAIT_MS : 0,
  };
}

/** Merges an accepted page into the feed and advances the cursor. */
export function applyActivityPage(feed: ActivityFeed, page: WorkspaceActivityPage): ActivityFeed {
  if (page.latestSeq < feed.cursor) {
    // The server's sequence went backwards (a gateway restart). Its events after our cursor are
    // none of the new ones, so drop the old events and poll from 0, which returns the latest
    // page; advancing to this page's latestSeq would skip every event up to it.
    return { enabled: true, events: new Map(), cursor: 0, totalOperations: page.totalOperations, error: null };
  }
  const events = new Map(feed.events);
  for (const event of page.events) {
    if (!isToolName(event.tool)) continue;
    const existing = events.get(event.operationId);
    if (!existing || event.seq >= existing.seq) events.set(event.operationId, event);
  }
  if (events.size > ACTIVITY_MAX_OPERATIONS) {
    const oldest = Array.from(events.values())
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
      .slice(0, events.size - ACTIVITY_MAX_OPERATIONS);
    for (const event of oldest) events.delete(event.operationId);
  }
  return {
    enabled: true,
    events,
    cursor: page.events.at(-1)?.seq ?? page.latestSeq,
    totalOperations: page.totalOperations,
    error: null,
  };
}

/** Records a failed poll; the feed keeps its events and cursor. */
export function activityPollFailed(feed: ActivityFeed, error: unknown): ActivityFeed {
  return { ...feed, error: error instanceof Error ? error.message : String(error) };
}

/** True when the page shows the workspace was closed, which ends polling. */
export function closesWorkspace(page: WorkspaceActivityPage): boolean {
  return page.events.some(
    (event) => event.tool === "close_workspace" && event.status === "success" && event.detail === "closed",
  );
}

/** Operations in start order (sequence number breaks ties). */
export function sortedOperations(feed: ActivityFeed): WorkspaceActivityEvent[] {
  return Array.from(feed.events.values()).sort((left, right) => {
    const byStart = Date.parse(left.startedAt) - Date.parse(right.startedAt);
    return byStart !== 0 ? byStart : left.seq - right.seq;
  });
}

export function isWorkspaceActivityPage(value: unknown): value is WorkspaceActivityPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<WorkspaceActivityPage>;
  if (!Array.isArray(page.events) || typeof page.latestSeq !== "number" || typeof page.totalOperations !== "number") return false;
  return page.events.every((event) => {
    if (!event || typeof event !== "object") return false;
    const candidate = event as Partial<WorkspaceActivityEvent>;
    return typeof candidate.seq === "number"
      && typeof candidate.operationId === "string"
      && typeof candidate.tool === "string"
      && (candidate.status === "running" || candidate.status === "success" || candidate.status === "error")
      && typeof candidate.label === "string";
  });
}
