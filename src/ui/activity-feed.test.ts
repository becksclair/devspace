import assert from "node:assert/strict";
import {
  ACTIVITY_COLLAPSED_ROWS,
  ACTIVITY_MAX_OPERATIONS,
  EMPTY_ACTIVITY_FEED,
  activityPollArguments,
  activityPollFailed,
  applyActivityPage,
  closesWorkspace,
  isWorkspaceActivityPage,
  sortedOperations,
  type WorkspaceActivityEvent,
  type WorkspaceActivityPage,
} from "./activity-feed.js";

function event(seq: number, overrides: Partial<WorkspaceActivityEvent> = {}): WorkspaceActivityEvent {
  return {
    seq,
    workspaceId: "ws",
    operationId: `op-${seq}`,
    tool: "read_file",
    machine: { id: "m", displayName: "M" },
    status: "success",
    label: `file-${seq}`,
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    ...overrides,
  };
}

function page(events: WorkspaceActivityEvent[], latestSeq = events.at(-1)?.seq ?? 0, totalOperations = events.length): WorkspaceActivityPage {
  return { events, latestSeq, totalOperations };
}

// The first poll returns at once; later polls long-poll from the cursor.
assert.deepEqual(activityPollArguments("ws", EMPTY_ACTIVITY_FEED), { workspaceId: "ws", afterSeq: 0, limit: 200, waitMs: 0 });

let feed = applyActivityPage(EMPTY_ACTIVITY_FEED, page([event(1), event(2)]));
assert.equal(feed.enabled, true);
assert.equal(feed.cursor, 2);
assert.equal(feed.totalOperations, 2);
assert.deepEqual(activityPollArguments("ws", feed), { workspaceId: "ws", afterSeq: 2, limit: 200, waitMs: 20_000 });

// A later event for the same operation replaces the earlier one; an older one does not.
feed = applyActivityPage(feed, page([event(3, { operationId: "op-1", status: "error", label: "updated" })], 3, 2));
assert.equal(feed.events.get("op-1")?.label, "updated");
assert.equal(feed.events.size, 2);
feed = applyActivityPage(feed, page([event(1, { label: "stale" })], 3, 2));
assert.equal(feed.events.get("op-1")?.label, "updated");

// An empty page keeps the cursor at the server's latest sequence.
feed = applyActivityPage(feed, page([], 3, 2));
assert.equal(feed.cursor, 3);

// Events for unknown tools are ignored.
feed = applyActivityPage(feed, page([event(4, { tool: "mystery" as never })], 4, 3));
assert.equal(feed.events.has("op-4"), false);
assert.equal(feed.cursor, 4);

// A failed poll keeps events and cursor; the next accepted page clears the error.
feed = activityPollFailed(feed, new Error("boom"));
assert.equal(feed.error, "boom");
assert.equal(feed.cursor, 4);
feed = applyActivityPage(feed, page([], 4, 3));
assert.equal(feed.error, null);

// The feed keeps the newest 200 operations.
let big = EMPTY_ACTIVITY_FEED;
big = applyActivityPage(big, page(Array.from({ length: ACTIVITY_MAX_OPERATIONS + 5 }, (_, index) => event(index + 1))));
assert.equal(big.events.size, ACTIVITY_MAX_OPERATIONS);
assert.equal(big.events.has("op-1"), false);
assert.equal(big.events.has(`op-${ACTIVITY_MAX_OPERATIONS + 5}`), true);

// Operations sort by start time, then sequence.
const sameStart = new Date(Date.UTC(2026, 0, 1)).toISOString();
const sorted = sortedOperations(applyActivityPage(EMPTY_ACTIVITY_FEED, page([
  event(3, { startedAt: sameStart }),
  event(2, { startedAt: sameStart }),
  event(1, { startedAt: new Date(Date.UTC(2025, 0, 1)).toISOString() }),
])));
assert.deepEqual(sorted.map((item) => item.seq), [1, 2, 3]);
assert.equal(ACTIVITY_COLLAPSED_ROWS, 7);

assert.equal(closesWorkspace(page([event(9, { tool: "close_workspace", detail: "closed" })])), true);
assert.equal(closesWorkspace(page([event(9, { tool: "close_workspace", detail: "kept" })])), false);
assert.equal(closesWorkspace(page([event(9, { tool: "close_workspace", status: "error", detail: "closed" })])), false);

assert.equal(isWorkspaceActivityPage(page([event(1)])), true);
assert.equal(isWorkspaceActivityPage({ events: [], latestSeq: "1", totalOperations: 0 }), false);
assert.equal(isWorkspaceActivityPage({ events: [{ seq: 1, operationId: "x", tool: "read", status: "done", label: "" }], latestSeq: 1, totalOperations: 1 }), false);
assert.equal(isWorkspaceActivityPage(null), false);

console.log("activity-feed tests passed");
