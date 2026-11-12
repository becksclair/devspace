// Server-renders each card kind with react-dom/server and checks its structure and text.

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolResultCard } from "./card-types.js";
import { EMPTY_ACTIVITY_FEED, applyActivityPage, type ActivityFeed } from "./activity-feed.js";
import { initialWidgetState, type WidgetState } from "./widget-state.js";
import { firstEnabledFrom, WidgetErrorBoundary, WorkspaceView, type WorkspaceViewProps } from "./workspace-view.js";

function render(card: ToolResultCard | null, overrides: Partial<WidgetState> = {}, props: Partial<WorkspaceViewProps> = {}): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <WorkspaceView
      connected
      connectionError={null}
      state={{ ...initialWidgetState, card, cardVersion: 1, ...overrides }}
      feed={EMPTY_ACTIVITY_FEED}
      themeType="dark"
      onToggleExpanded={noop}
      onShowAllReviewFiles={noop}
      onToggleActivityExpanded={noop}
      {...props}
    />,
  );
}

function count(html: string, pattern: RegExp): number {
  return html.match(new RegExp(pattern.source, "g"))?.length ?? 0;
}

// Connection and empty states.
assert.equal(render(null, {}, { connected: false }), '<main class="shell"><section class="empty muted">Connecting to host...</section></main>');
assert.equal(render(null, {}, { connectionError: "Handshake failed" }), '<main class="shell"><section class="empty error">Handshake failed</section></main>');
assert.equal(render(null), '<main class="shell"><section class="empty muted">Waiting for a tool result.</section></main>');
assert.match(render(null, { errorMessage: "No result card is available for this tool result." }), /class="empty error">No result card/);

// Read card, collapsed: an enabled header button with icon, title, label, badge and chevron.
const read: ToolResultCard = {
  tool: "read_file",
  path: "src/greeting.ts",
  summary: { lines: 9 },
  payload: { content: [{ type: "text", text: "export const x = 1;" }] },
};
let html = render(read);
assert.match(html, /^<main class="shell"><section class="tool-card read"><button class="tool-header" type="button" aria-expanded="false">/);
assert.match(html, /<span class="tool-icon" aria-hidden="true"><svg aria-hidden="true" class="icon-svg"/);
assert.match(html, /<span class="tool-title">Read File<\/span><span class="tool-label" title="src\/greeting.ts">src\/greeting.ts<\/span>/);
assert.match(html, /<span class="badge">9 lines<\/span><span class="chevron" aria-hidden="true"><svg/);
assert.equal(count(html, /tool-body/), 0);

// Expanded: the lazily loaded renderer shows its loading line inside the body.
html = render(read, { expanded: true });
assert.match(html, /aria-expanded="true"/);
assert.match(html, /class="chevron expanded"/);
assert.match(html, /<div class="tool-body"><div class="status muted">Loading details...<\/div><\/div>/);
// After teardown the renderer is not mounted again.
assert.match(render(read, { expanded: true, tornDown: true }), /<div class="tool-body"><\/div>/);

// Edit card with a machine badge.
html = render({ tool: "edit_file", path: "a.ts", machine: { id: "orion", displayName: "Orion" }, summary: { additions: 2, removals: 1 }, payload: { patch: "p" } });
assert.match(html, /class="tool-header has-machine"/);
assert.match(html, /<span class="stats" role="group" aria-label="Diff statistics"><span class="add">\+2<\/span><span class="remove">-1<\/span><\/span><span class="machine-badge" title="Orion" aria-label="Machine: Orion">Orion<\/span>/);

// A card with nothing to expand has a disabled header and no chevron icon.
html = render({ tool: "close_workspace", root: "/repo", summary: { lines: 1 } });
assert.match(html, /<button class="tool-header" type="button" disabled="">/);
assert.match(html, /<span class="chevron" aria-hidden="true"><\/span>/);

// Shell card, expanded: plain output.
html = render({ tool: "run_shell", summary: { command: "ls", lines: 2 }, payload: { content: [{ type: "text", text: "a\nb" }] } }, { expanded: true });
assert.match(html, /<span class="tool-label" title="ls">ls<\/span><\/span><span class="badge">ran · 2 lines<\/span>/);
assert.match(html, /<div class="tool-body"><pre class="text-payload run_shell">a\nb<\/pre><\/div>/);

// A failed shell call renders as an error, with its output as error text when expanded.
const failedShell: ToolResultCard = {
  tool: "run_shell",
  isError: true,
  summary: { command: "exit 3", lines: 5 },
  payload: { content: [{ type: "text", text: "fatal: simulated failure\n\n\nCommand exited with code 3" }] },
};
html = render(failedShell, { expanded: true });
assert.match(html, /<section class="tool-card shell error">/);
assert.match(html, /<circle cx="12" cy="12" r="8.5"><\/circle>/);
assert.match(html, /<span class="badge error">exit 3<\/span>/);
assert.match(html, /<div class="tool-body"><pre class="text-payload error-payload" role="alert">fatal: simulated failure\n\n\nCommand exited with code 3<\/pre><\/div>/);
// A failed read never reaches the code renderer.
html = render({ tool: "read_file", isError: true, path: "missing.ts", payload: { content: [{ type: "text", text: "ENOENT" }] } }, { expanded: true });
assert.match(html, /<section class="tool-card read error">.*<span class="badge error">error<\/span>/);
assert.match(html, /<pre class="text-payload error-payload" role="alert">ENOENT<\/pre>/);
assert.equal(html.includes("Loading details"), false);
// A failed review call renders as an error card, not a review.
const failedReview: ToolResultCard = { tool: "show_changes", isError: true, payload: { content: [{ type: "text", text: "not a git repository" }] } };
html = render(failedReview);
assert.match(html, /<section class="tool-card review error"><button class="tool-header"/);
// Its header stays enabled, so the error message can be opened.
assert.match(html, /<button class="tool-header" type="button" aria-expanded="false">/);
html = render(failedReview, { expanded: true });
assert.match(html, /<pre class="text-payload error-payload" role="alert">not a git repository<\/pre>/);

// A write result without a patch shows no diff badge (an empty span keeps the grid column).
html = render({ tool: "write_file", path: "a.ts", summary: { lines: 1 }, payload: { content: [{ type: "text", text: "Successfully wrote" }] } });
assert.match(html, /<span class="tool-label" title="a.ts">a.ts<\/span><\/span><span><\/span><span class="chevron"/);

// Workspace card with AGENTS.md, expanded.
const workspace: ToolResultCard = {
  tool: "open_workspace",
  workspaceId: "ws1",
  root: "/repo",
  summary: { agentsFiles: 1, skills: 0 },
  agentsFiles: [{ path: "AGENTS.md", content: "Rules" }],
};
html = render(workspace, { expanded: true });
assert.match(html, /<span class="badge-group" role="group" aria-label="Workspace summary"><span class="badge success"><svg aria-hidden="true" class="badge-icon"[^>]*>.*?<\/svg>AGENTS.md<\/span><span class="badge">0 skills<\/span><\/span>/);
assert.match(html, /<pre class="text-payload open_workspace">Workspace: ws1\nRoot: \/repo\nSkills: none\n\nAGENTS.md\n\nRules<\/pre>/);

// Terminal card, expanded.
html = render({ tool: "terminal_read", terminal: { terminalId: "t1", status: "running" }, terminalOutput: "ready" }, { expanded: true });
assert.match(html, /<span class="badge">running<\/span>/);
assert.match(html, /<pre class="text-payload terminal_read">t1 running \?x\? service-lifetime\n\n\nready<\/pre>/);

// Review card: header, lazily loaded file list, and the "more files" action.
const review: ToolResultCard = {
  tool: "show_changes",
  summary: { files: 5, additions: 19, removals: 9 },
  files: Array.from({ length: 5 }, (_, index) => ({ path: `f${index}` })),
  payload: { patch: "diff --git a/f0 b/f0" },
};
html = render(review);
assert.match(html, /^<main class="shell"><section class="tool-card review"><div class="review-header">/);
assert.match(html, /<div class="review-title-group"><span class="tool-title">Show Changes<\/span><span class="tool-label" title="5 changed files">5 changed files<\/span><\/div>/);
assert.match(html, /aria-label="Review diff statistics"><span class="add">\+19<\/span><span class="remove">-9<\/span>/);
assert.match(html, /<div class="review-summary" tabindex="-1"><div class="status muted">Loading review...<\/div><\/div>/);
assert.match(html, /<div class="review-actions"><button class="review-action" type="button">Show 2 more files<\/button><\/div>/);
assert.equal(count(render(review, { reviewFilesExpanded: true }), /review-actions/), 0);
// "Show N more files" focuses the first newly revealed row that can take focus.
const rows = [{ disabled: false, id: 0 }, { disabled: false, id: 1 }, { disabled: false, id: 2 }, { disabled: true, id: 3 }, { disabled: false, id: 4 }];
assert.equal(firstEnabledFrom(rows, 3)?.id, 4);
assert.equal(firstEnabledFrom(rows.slice(0, 4), 3), undefined);
assert.match(render({ tool: "show_changes", summary: { files: 0 } }), /No changes since last review/);
// A clean review has no +0 -0 badge.
html = render({ tool: "show_changes", summary: { files: 0, additions: 0, removals: 0 }, files: [], payload: { patch: "" } });
assert.equal(html.includes('class="stats"'), false);

// Activity card: shown once the feed is enabled, with the newest seven rows and a toggle.
const events = Array.from({ length: 9 }, (_, index) => ({
  seq: index + 1,
  workspaceId: "ws1",
  operationId: `op-${index + 1}`,
  tool: index === 8 ? ("run_shell" as const) : ("read_file" as const),
  machine: { id: "m", displayName: "M" },
  status: index === 8 ? ("error" as const) : ("success" as const),
  label: `label-${index + 1}`,
  detail: "1 lines",
  durationMs: 1_500,
  startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
}));
const feed: ActivityFeed = applyActivityPage(EMPTY_ACTIVITY_FEED, { events, latestSeq: 9, totalOperations: 9 });
html = render(workspace, {}, { feed });
assert.match(html, /^<main class="shell"><section class="tool-card workspace activity-card"><button class="tool-header workspace-activity-header" type="button" aria-expanded="false">/);
assert.match(html, /<span class="tool-title">DevSpace<\/span><span class="tool-label" title="\/repo">\/repo<\/span><\/span><span class="badge">9 operations<\/span>/);
assert.equal(count(html, /class="activity-row /), 7);
assert.equal(html.includes("label-2"), false);
assert.match(html, /<div class="activity-row error"><span class="activity-status" role="img" aria-label="error">×<\/span><span class="activity-main"><span class="activity-tool">Bash<\/span><span class="activity-label" title="label-9">label-9<\/span><\/span><span class="activity-detail">1 lines · 1.5s<\/span><\/div>/);
assert.match(html, /<div class="activity-footer"><button class="review-action" type="button">Show 2 earlier<\/button><\/div>/);
html = render(workspace, { activityExpanded: true }, { feed });
assert.equal(count(html, /class="activity-row /), 9);
assert.match(html, />Show latest</);
html = render(workspace, {}, { feed: { ...applyActivityPage(EMPTY_ACTIVITY_FEED, { events: [], latestSeq: 0, totalOperations: 0 }), error: "Workspace activity feed is unavailable." } });
assert.match(html, /<span class="badge">ready<\/span>/);
assert.match(html, /<div class="activity-empty">Ready. Workspace activity will appear here.<\/div><\/div><div class="activity-error">Workspace activity feed is unavailable.<\/div>/);

// Root error boundary. A card with wrong-typed fields throws while rendering; WorkspaceApp wraps
// the view in WidgetErrorBoundary so the widget shows its error state instead of unmounting.
// react-dom/server does not run error boundaries, so the boundary's static lifecycle methods and
// its fallback render are exercised directly.
assert.throws(() => render({ tool: "terminal_status", terminals: [null] } as unknown as ToolResultCard, { expanded: true }), /terminalId/);
assert.throws(() => render({ tool: "grep_files", payload: { content: "text" } } as unknown as ToolResultCard, { expanded: true }), /map is not a function/);
const boundary = new WidgetErrorBoundary({ resetKey: 1, children: <span>card</span> });
assert.deepEqual(boundary.state, { error: undefined, resetKey: 1 });
assert.equal(renderToStaticMarkup(<>{boundary.render()}</>), "<span>card</span>");
const caught = { ...boundary.state, ...WidgetErrorBoundary.getDerivedStateFromError(new TypeError("bad card")) };
boundary.state = caught;
assert.equal(
  renderToStaticMarkup(<>{boundary.render()}</>),
  '<main class="shell"><section class="empty error">This result could not be displayed. bad card</section></main>',
);
// The error stays for re-renders of the same result and clears when the next result arrives.
assert.equal(WidgetErrorBoundary.getDerivedStateFromProps({ resetKey: 1, children: null }, caught), null);
assert.deepEqual(WidgetErrorBoundary.getDerivedStateFromProps({ resetKey: 2, children: null }, caught), { error: undefined, resetKey: 2 });

console.log("workspace-view render tests passed");
