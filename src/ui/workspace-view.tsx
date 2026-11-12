// Presentational components of the workspace card widget. State and host wiring live in
// workspace-root.tsx; this module only renders, so it can be rendered on the server in tests.

import { Component, useRef, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { isExpandableCard, isReviewTool, machineDisplayName, type ToolResultCard } from "./card-types.js";
import { ACTIVITY_COLLAPSED_ROWS, sortedOperations, type ActivityFeed, type WorkspaceActivityEvent } from "./activity-feed.js";
import { CheckCircleIcon, ChevronIcon, ToolIcon } from "./icons.js";
import { PayloadBody } from "./payload-body.js";
import type { ThemeType } from "./payload-fallback.js";
import {
  formatDuration,
  getToolDisplay,
  reviewFileCounts,
  summaryBadge,
  toolTitle,
  REVIEW_COLLAPSED_FILES,
} from "./tool-display.js";
import type { WidgetState } from "./widget-state.js";

export interface WorkspaceViewProps {
  connected: boolean;
  connectionError: string | null;
  state: WidgetState;
  feed: ActivityFeed;
  themeType: ThemeType;
  onToggleExpanded: () => void;
  onShowAllReviewFiles: () => void;
  onToggleActivityExpanded: () => void;
}

export function WorkspaceView(props: WorkspaceViewProps) {
  const { connected, connectionError, state, feed } = props;

  if (connectionError) return <EmptyState message={connectionError} tone="error" />;
  if (!connected) return <EmptyState message="Connecting to host..." />;
  if (!state.card) {
    return state.errorMessage
      ? <EmptyState message={state.errorMessage} tone="error" />
      : <EmptyState message="Waiting for a tool result." />;
  }
  if (state.card.tool === "open_workspace" && feed.enabled) {
    return <ActivityCard {...props} card={state.card} />;
  }
  // A failed review call has no review to show; it renders as a plain error card.
  if (isReviewTool(state.card.tool) && !state.card.isError) return <ReviewCard {...props} card={state.card} />;
  return <ToolCard {...props} card={state.card} />;
}

interface WidgetErrorBoundaryProps {
  /** Changes with every delivered tool result; a new value clears a caught error. */
  resetKey: number;
  children: ReactNode;
}

interface WidgetErrorBoundaryState {
  error: unknown;
  resetKey: number;
}

/**
 * Catches a render failure anywhere in the card (for example a result with wrong-typed fields)
 * and shows the widget's error state instead of an empty frame, until the next tool result.
 */
export class WidgetErrorBoundary extends Component<WidgetErrorBoundaryProps, WidgetErrorBoundaryState> {
  override state: WidgetErrorBoundaryState = { error: undefined, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<WidgetErrorBoundaryState> {
    return { error: error ?? new Error("Unknown rendering error.") };
  }

  static getDerivedStateFromProps(
    props: WidgetErrorBoundaryProps,
    state: WidgetErrorBoundaryState,
  ): Partial<WidgetErrorBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { error: undefined, resetKey: props.resetKey };
  }

  override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children;
    const detail = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
    return <EmptyState message={`This result could not be displayed. ${detail}`.trim()} tone="error" />;
  }
}

function EmptyState({ message, tone = "muted" }: { message: string; tone?: "muted" | "error" }) {
  return (
    <main className="shell">
      <section className={`empty ${tone}`}>{message}</section>
    </main>
  );
}

type CardProps = WorkspaceViewProps & { card: ToolResultCard };

function ToolCard({ card, state, themeType, onToggleExpanded }: CardProps) {
  const display = getToolDisplay(card);
  const expandable = isExpandableCard(card);
  const machine = machineDisplayName(card);

  return (
    <main className="shell">
      <section className={card.isError ? `tool-card ${display.tone} error` : `tool-card ${display.tone}`}>
        <button
          className={machine ? "tool-header has-machine" : "tool-header"}
          type="button"
          aria-expanded={expandable ? state.expanded : undefined}
          disabled={!expandable}
          onClick={expandable ? onToggleExpanded : undefined}
        >
          <span className="tool-icon" aria-hidden="true"><ToolIcon name={card.isError ? "alert" : display.icon} /></span>
          <span className="tool-main">
            <span className="tool-title">{display.title}</span>
            <span className="tool-label" title={display.label}>{display.label}</span>
          </span>
          <SummaryBadgeView card={card} />
          {machine ? <MachineBadge name={machine} /> : null}
          <Chevron expanded={state.expanded} visible={expandable} />
        </button>
        {state.expanded ? (
          <div className="tool-body">
            <PayloadBody card={card} themeType={themeType} tornDown={state.tornDown} />
          </div>
        ) : null}
      </section>
    </main>
  );
}

/**
 * The first control at or after `start` that can take focus. The "Show N more files" button
 * unmounts when clicked, so focus moves to the first newly revealed file row instead of `body`.
 */
export function firstEnabledFrom<T extends { disabled: boolean }>(controls: ArrayLike<T>, start: number): T | undefined {
  return Array.from(controls).slice(start).find((control) => !control.disabled);
}

function ReviewCard({ card, state, themeType, onShowAllReviewFiles }: CardProps) {
  const display = getToolDisplay(card);
  const machine = machineDisplayName(card);
  const { hidden } = reviewFileCounts(card, state.reviewFilesExpanded);
  const summaryRef = useRef<HTMLDivElement>(null);

  const showAllFiles = () => {
    flushSync(onShowAllReviewFiles);
    const summary = summaryRef.current;
    if (!summary) return;
    const headers = summary.querySelectorAll<HTMLButtonElement>(".review-diff-file-header");
    // Pure renames and binary rows are disabled buttons; then the list itself takes focus.
    (firstEnabledFrom(headers, REVIEW_COLLAPSED_FILES) ?? summary).focus();
  };

  return (
    <main className="shell">
      <section className="tool-card review">
        <div className={machine ? "review-header has-machine" : "review-header"}>
          <span className="tool-icon" aria-hidden="true"><ToolIcon name={display.icon} /></span>
          <div className="review-title-group">
            <span className="tool-title">{display.title}</span>
            <span className="tool-label" title={display.label}>{display.label}</span>
          </div>
          <SummaryBadgeView card={card} />
          {machine ? <MachineBadge name={machine} /> : null}
        </div>
        <div className="review-summary" ref={summaryRef} tabIndex={-1}>
          {/* A new result remounts the list, so no file stays open from the previous review. */}
          <PayloadBody
            key={state.cardVersion}
            card={card}
            themeType={themeType}
            tornDown={state.tornDown}
            visibleFileCount={state.reviewFilesExpanded ? undefined : REVIEW_COLLAPSED_FILES}
          />
        </div>
        {hidden > 0 ? (
          <div className="review-actions">
            <button className="review-action" type="button" onClick={showAllFiles}>
              {`Show ${hidden} more ${hidden === 1 ? "file" : "files"}`}
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function ActivityCard({ card, state, feed, themeType, onToggleExpanded, onToggleActivityExpanded }: CardProps) {
  const expandable = isExpandableCard(card);
  const machine = machineDisplayName(card);
  const root = card.root ?? card.canonicalRoot ?? "Workspace";
  const count = feed.totalOperations === 0
    ? "ready"
    : `${feed.totalOperations} ${feed.totalOperations === 1 ? "operation" : "operations"}`;
  const operations = sortedOperations(feed);
  const visible = state.activityExpanded ? operations : operations.slice(-ACTIVITY_COLLAPSED_ROWS);
  const hiddenCount = Math.max(0, operations.length - visible.length);

  return (
    <main className="shell">
      <section className="tool-card workspace activity-card">
        <button
          className={machine
            ? "tool-header workspace-activity-header has-machine"
            : "tool-header workspace-activity-header"}
          type="button"
          aria-expanded={expandable ? state.expanded : undefined}
          disabled={!expandable}
          onClick={expandable ? onToggleExpanded : undefined}
        >
          <span className="tool-icon" aria-hidden="true"><ToolIcon name="folder" /></span>
          <span className="tool-main">
            <span className="tool-title">DevSpace</span>
            <span className="tool-label" title={root}>{root}</span>
          </span>
          <span className="badge">{count}</span>
          {machine ? <MachineBadge name={machine} /> : null}
          <Chevron expanded={state.expanded} visible={expandable} />
        </button>
        <div className="activity-feed">
          {visible.length === 0
            ? <div className="activity-empty">Ready. Workspace activity will appear here.</div>
            : visible.map((event) => <ActivityRow key={event.operationId} event={event} />)}
        </div>
        {hiddenCount > 0 || (state.activityExpanded && operations.length > ACTIVITY_COLLAPSED_ROWS) ? (
          <div className="activity-footer">
            <button className="review-action" type="button" onClick={onToggleActivityExpanded}>
              {state.activityExpanded ? "Show latest" : `Show ${hiddenCount} earlier`}
            </button>
          </div>
        ) : null}
        {feed.error ? <div className="activity-error">{feed.error}</div> : null}
        {state.expanded ? (
          <div className="tool-body">
            <PayloadBody card={card} themeType={themeType} tornDown={state.tornDown} />
          </div>
        ) : null}
      </section>
    </main>
  );
}

const ACTIVITY_STATUS_GLYPHS: Record<WorkspaceActivityEvent["status"], string> = {
  running: "●",
  success: "✓",
  error: "×",
};

function ActivityRow({ event }: { event: WorkspaceActivityEvent }) {
  const details = [event.detail, formatDuration(event.durationMs)].filter(Boolean).join(" · ");
  return (
    <div className={`activity-row ${event.status}`}>
      <span className="activity-status" role="img" aria-label={event.status}>
        {ACTIVITY_STATUS_GLYPHS[event.status]}
      </span>
      <span className="activity-main">
        <span className="activity-tool">{toolTitle(event.tool)}</span>
        <span className="activity-label" title={event.label}>{event.label}</span>
      </span>
      <span className="activity-detail">{details}</span>
    </div>
  );
}

function SummaryBadgeView({ card }: { card: ToolResultCard }) {
  const badge = summaryBadge(card);
  switch (badge.kind) {
    case "stats":
      return (
        <span className="stats" role="group" aria-label={badge.label}>
          <span className="add">{`+${badge.additions}`}</span>
          <span className="remove">{`-${badge.removals}`}</span>
        </span>
      );
    case "workspace":
      if (badge.agentsFiles === undefined && badge.skills === undefined) return <span />;
      return (
        <span className="badge-group" role="group" aria-label="Workspace summary">
          {badge.agentsFiles === undefined ? null : (
            <span className={`badge ${badge.agentsFiles > 0 ? "success" : "muted"}`}>
              {badge.agentsFiles > 0 ? <CheckCircleIcon /> : null}
              {badge.agentsFiles > 0 ? "AGENTS.md" : "No AGENTS.md"}
            </span>
          )}
          {badge.skills === undefined ? null : (
            <span className="badge">{`${badge.skills} ${badge.skills === 1 ? "skill" : "skills"}`}</span>
          )}
        </span>
      );
    case "text":
      return <span className="badge">{badge.text}</span>;
    case "error":
      return <span className="badge error">{badge.text}</span>;
    case "none":
      // Keeps the header grid's badge column.
      return <span />;
  }
}

function MachineBadge({ name }: { name: string }) {
  return (
    <span className="machine-badge" title={name} aria-label={`Machine: ${name}`}>
      {name}
    </span>
  );
}

function Chevron({ expanded, visible }: { expanded: boolean; visible: boolean }) {
  return (
    <span className={visible && expanded ? "chevron expanded" : "chevron"} aria-hidden="true">
      {visible ? <ChevronIcon /> : null}
    </span>
  );
}
