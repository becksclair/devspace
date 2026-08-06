import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isEditTool,
  isExpandableCard,
  isReadTool,
  isReviewTool,
  isSearchTool,
  isShellTool,
  isTerminalTool,
  isToolName,
  isToolResultCard,
  machineDisplayName,
  isWriteTool,
  payloadText,
  summaryNumber,
  type HostContext,
  type ToolName,
  type ToolResultCard,
} from "./card-types.js";
import "./workspace-app.css";

interface ToolDisplay {
  icon: string;
  title: string;
  label: string;
  tone: string;
}

interface WorkspaceActivityEvent {
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

interface WorkspaceActivityPage {
  events: WorkspaceActivityEvent[];
  latestSeq: number;
  totalOperations: number;
}

interface MountedPayload {
  update(options: {
    card: ToolResultCard;
    hostContext?: HostContext;
    errorMessage?: string | null;
    visibleFileCount?: number;
  }): void;
  unmount(): void;
}

let app: App | null = null;
let connected = false;
let connectionError: string | null = null;
let hostContext: HostContext | undefined;
let card: ToolResultCard | null = null;
let expanded = false;
let reviewFilesExpanded = false;
let errorMessage: string | null = null;
let currentPayload: MountedPayload | null = null;
let currentPayloadContainer: HTMLElement | null = null;
let activityEvents = new Map<string, WorkspaceActivityEvent>();
let activitySeq = 0;
let activityTotalOperations = 0;
let activityFeedEnabled = false;
let activityExpanded = false;
let activityPollGeneration = 0;
let activityPolling = false;
let activityError: string | null = null;

const maybeAppRoot = document.querySelector<HTMLElement>("#app");

if (!maybeAppRoot) {
  throw new Error("Missing #app root element.");
}

const appRoot = maybeAppRoot;

void boot();

async function boot(): Promise<void> {
  render();

  app = new App(
    { name: "devspace-tool-cards", version: "0.4.0" },
    {},
  );

  app.ontoolresult = (result) => {
    const structuredContent = getStructuredContent<Partial<ToolResultCard>>(result);
    const metaCard = cardFromMeta(result);
    const structured = metaCard
      ? { ...structuredContent, ...metaCard }
      : structuredContent;
    const tool = toolNameFromMeta(result);

    if (!tool || !isToolResultCard(structured)) {
      card = null;
      expanded = false;
      reviewFilesExpanded = false;
      errorMessage = "No result card is available for this tool result.";
      render();
      return;
    }

    card = { ...structured, tool };
    expanded = false;
    reviewFilesExpanded = false;
    errorMessage = null;
    if (tool === "open_workspace") resetActivityFeed();
    render();
    if (tool === "open_workspace") void startActivityPolling();
  };

  app.onhostcontextchanged = (ctx) => {
    hostContext = {
      ...hostContext,
      ...ctx,
    };
    applyHostContext();
    renderPayloadIfNeeded();
  };

  app.onteardown = async () => {
    activityPollGeneration += 1;
    activityPolling = false;
    unmountPayload();
    return {};
  };

  try {
    await app.connect();
    const initialContext = app.getHostContext();
    if (initialContext) hostContext = initialContext;
    applyHostContext();
    connected = true;
    if (card?.tool === "open_workspace") void startActivityPolling();
  } catch (connectError) {
    connectionError = connectError instanceof Error
      ? connectError.message
      : String(connectError);
  }

  render();
}

function applyHostContext(): void {
  if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  if (hostContext?.styles?.variables) {
    applyHostStyleVariables(hostContext.styles.variables);
  }
  if (hostContext?.styles?.css?.fonts) {
    applyHostFonts(hostContext.styles.css.fonts);
  }

  const insets = hostContext?.safeAreaInsets;
  if (!insets) return;

  document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
}

function render(): void {
  unmountPayload();

  if (connectionError) {
    renderEmpty(connectionError, "error");
    return;
  }

  if (!connected) {
    renderEmpty("Connecting to host...");
    return;
  }

  if (!card) {
    renderEmpty(errorMessage ?? "Waiting for a tool result.", errorMessage ? "error" : "muted");
    return;
  }

  if (card.tool === "open_workspace" && activityFeedEnabled) {
    renderWorkspaceActivityCard(card);
    return;
  }

  const display = getToolDisplay(card);
  if (isReviewTool(card.tool)) {
    renderReviewCard(card, display);
    return;
  }

  const expandable = isExpandableCard(card);
  const main = element("main", { className: "shell" });
  const section = element("section", { className: `tool-card ${display.tone}` });
  const machineBadge = renderMachineBadge(card);
  const button = element("button", {
    className: machineBadge ? "tool-header has-machine" : "tool-header",
    type: "button",
    ariaExpanded: String(expanded),
    disabled: !expandable,
  });

  if (expandable) {
    button.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
  }

  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.innerHTML = display.icon;

  const toolMain = element("span", { className: "tool-main" });
  const title = element("span", { className: "tool-title", text: display.title });
  const label = element("span", {
    className: "tool-label",
    text: display.label,
    title: display.label,
  });
  toolMain.append(title, label);

  button.append(
    icon,
    toolMain,
    renderSummaryBadge(card),
  );
  if (machineBadge) button.append(machineBadge);
  button.append(renderChevron(expanded, expandable));
  section.append(button);

  if (expanded) {
    const body = element("div", { className: "tool-body" });
    currentPayloadContainer = body;
    section.append(body);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

function renderWorkspaceActivityCard(workspace: ToolResultCard): void {
  const main = element("main", { className: "shell" });
  const section = element("section", { className: "tool-card workspace activity-card" });
  const expandable = isExpandableCard(workspace);
  const machineBadge = renderMachineBadge(workspace);
  const header = element("button", {
    className: machineBadge
      ? "tool-header workspace-activity-header has-machine"
      : "tool-header workspace-activity-header",
    type: "button",
    ariaExpanded: String(expanded),
    disabled: !expandable,
  });
  if (expandable) {
    header.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
  }

  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.innerHTML = folderIcon();
  const toolMain = element("span", { className: "tool-main" });
  const root = workspace.root ?? workspace.canonicalRoot ?? "Workspace";
  toolMain.append(
    element("span", { className: "tool-title", text: "DevSpace" }),
    element("span", { className: "tool-label", text: root, title: root }),
  );
  const countText = activityTotalOperations === 0
    ? "ready"
    : `${activityTotalOperations} ${activityTotalOperations === 1 ? "operation" : "operations"}`;
  header.append(icon, toolMain, element("span", { className: "badge", text: countText }));
  if (machineBadge) header.append(machineBadge);
  header.append(renderChevron(expanded, expandable));
  section.append(header);

  const feed = element("div", { className: "activity-feed" });
  const operations = Array.from(activityEvents.values()).sort((left, right) => {
    const byStart = Date.parse(left.startedAt) - Date.parse(right.startedAt);
    return byStart !== 0 ? byStart : left.seq - right.seq;
  });
  const visible = activityExpanded ? operations : operations.slice(-7);
  if (visible.length === 0) {
    feed.append(element("div", { className: "activity-empty", text: "Ready. Workspace activity will appear here." }));
  } else {
    for (const event of visible) feed.append(renderActivityRow(event));
  }
  section.append(feed);

  const hiddenCount = Math.max(0, operations.length - visible.length);
  if (hiddenCount > 0 || (activityExpanded && operations.length > 7)) {
    const footer = element("div", { className: "activity-footer" });
    const toggle = element("button", {
      className: "review-action",
      type: "button",
      text: activityExpanded ? "Show latest" : `Show ${hiddenCount} earlier`,
    });
    toggle.addEventListener("click", () => {
      activityExpanded = !activityExpanded;
      render();
    });
    footer.append(toggle);
    section.append(footer);
  }

  if (activityError) {
    section.append(element("div", { className: "activity-error", text: activityError }));
  }

  if (expanded) {
    const body = element("div", { className: "tool-body" });
    currentPayloadContainer = body;
    section.append(body);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

function renderActivityRow(event: WorkspaceActivityEvent): HTMLElement {
  const row = element("div", { className: `activity-row ${event.status}` });
  const status = element("span", {
    className: "activity-status",
    text: event.status === "running" ? "●" : event.status === "success" ? "✓" : "×",
  });
  status.setAttribute("aria-label", event.status);
  const main = element("span", { className: "activity-main" });
  main.append(
    element("span", { className: "activity-tool", text: toolTitle(event.tool) }),
    element("span", { className: "activity-label", text: event.label, title: event.label }),
  );
  const details = [event.detail, formatDuration(event.durationMs)].filter(Boolean).join(" · ");
  row.append(status, main, element("span", { className: "activity-detail", text: details }));
  return row;
}

function resetActivityFeed(): void {
  activityPollGeneration += 1;
  activityEvents = new Map();
  activitySeq = 0;
  activityTotalOperations = 0;
  activityFeedEnabled = false;
  activityExpanded = false;
  activityPolling = false;
  activityError = null;
}

async function startActivityPolling(): Promise<void> {
  if (!app || !connected || activityPolling || card?.tool !== "open_workspace" || !card.workspaceId) return;
  const workspaceId = card.workspaceId;
  const generation = ++activityPollGeneration;
  activityPolling = true;

  while (generation === activityPollGeneration && card?.tool === "open_workspace" && card.workspaceId === workspaceId) {
    try {
      const result = await app.callServerTool(
        {
          name: "workspace_activity",
          arguments: { workspaceId, afterSeq: activitySeq, limit: 200, waitMs: activityFeedEnabled ? 20_000 : 0 },
        },
        { timeout: 25_000 },
      );
      if (generation !== activityPollGeneration) break;
      const page = getStructuredContent<WorkspaceActivityPage>(result);
      if (result.isError || !isWorkspaceActivityPage(page)) {
        throw new Error("Workspace activity feed is unavailable.");
      }

      activityFeedEnabled = true;
      activityError = null;
      if (page.latestSeq < activitySeq) {
        activityEvents.clear();
        activitySeq = 0;
      }
      activityTotalOperations = page.totalOperations;
      for (const event of page.events) {
        const existing = activityEvents.get(event.operationId);
        if (!existing || event.seq >= existing.seq) activityEvents.set(event.operationId, event);
      }
      if (activityEvents.size > 200) {
        const oldest = Array.from(activityEvents.values())
          .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
          .slice(0, activityEvents.size - 200);
        for (const event of oldest) activityEvents.delete(event.operationId);
      }
      activitySeq = page.events.at(-1)?.seq ?? page.latestSeq;
      render();

      const closed = page.events.some(
        (event) => event.tool === "close_workspace" && event.status === "success" && event.detail === "closed",
      );
      if (closed) break;
    } catch (activityFailure) {
      if (generation !== activityPollGeneration) break;
      if (!activityFeedEnabled) break;
      activityError = activityFailure instanceof Error ? activityFailure.message : String(activityFailure);
      render();
      await delay(2_000);
    }
  }

  if (generation === activityPollGeneration) activityPolling = false;
}

function isWorkspaceActivityPage(value: unknown): value is WorkspaceActivityPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<WorkspaceActivityPage>;
  if (!Array.isArray(page.events) || typeof page.latestSeq !== "number" || typeof page.totalOperations !== "number") return false;
  return page.events.every((event) => {
    if (!event || typeof event !== "object") return false;
    const candidate = event as Partial<WorkspaceActivityEvent>;
    return typeof candidate.seq === "number"
      && typeof candidate.operationId === "string"
      && isToolName(candidate.tool)
      && (candidate.status === "running" || candidate.status === "success" || candidate.status === "error")
      && typeof candidate.label === "string";
  });
}

function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  return `${Math.round(durationMs / 1_000)}s`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderEmpty(message: string, tone: "muted" | "error" = "muted"): void {
  const main = element("main", { className: "shell" });
  main.append(element("section", { className: `empty ${tone}`, text: message }));
  appRoot.replaceChildren(main);
}

async function renderPayloadIfNeeded(): Promise<void> {
  if (!card || !currentPayloadContainer || (!expanded && !isReviewTool(card.tool))) return;

  const target = currentPayloadContainer;

  if (errorMessage) {
    renderStatus(target, errorMessage, "error");
    return;
  }

  if (card.tool === "open_workspace" || card.tool === "workspace_status") {
    renderPrePayload(target, workspacePayloadText(card), "open_workspace");
    return;
  }

  if (isTerminalTool(card.tool)) {
    const terminalText = terminalPayloadText(card);
    renderPrePayload(target, terminalText || "No terminal details available.", card.tool);
    return;
  }

  if (shouldUseHeavyPayload(card)) {
    if (currentPayload) {
      currentPayload.update({ card, hostContext, errorMessage });
      return;
    }

    renderStatus(target, "Loading details...");

    const { mountHeavyPayload } = await import("./heavy-payload.js");
    if (target !== currentPayloadContainer || !expanded || !card) return;

    currentPayload = mountHeavyPayload(target, {
      card,
      hostContext,
      errorMessage,
    });
    return;
  }

  if (isReviewTool(card.tool)) {
    const visibleFileCount = reviewFilesExpanded
      ? undefined
      : Math.max(3, (card.files ?? []).slice(0, 3).length);

    if (currentPayload) {
      currentPayload.update({ card, hostContext, errorMessage, visibleFileCount });
      return;
    }

    renderStatus(target, "Loading review...");

    const { mountReviewPayload } = await import("./review-payload.js");
    if (target !== currentPayloadContainer || !card) return;

    currentPayload = mountReviewPayload(target, {
      card,
      hostContext,
      errorMessage,
      visibleFileCount,
    });
    return;
  }

  const text = payloadText(card.payload);
  if (!text) {
    renderStatus(target, "No details available.");
    return;
  }

  renderPrePayload(target, text, card.tool);
}

function shouldUseHeavyPayload(card: ToolResultCard): boolean {
  return isReadTool(card.tool) || isEditTool(card.tool) || isWriteTool(card.tool);
}

function unmountPayload(): void {
  unmountCurrentPayload();
  currentPayload = null;
  currentPayloadContainer = null;
}

function unmountCurrentPayload(): void {
  currentPayload?.unmount();
  currentPayload = null;
}

function renderStatus(
  container: HTMLElement,
  message: string,
  tone: "muted" | "error" = "muted",
): void {
  unmountCurrentPayload();
  container.replaceChildren(element("div", { className: `status ${tone}`, text: message }));
}

function renderPrePayload(
  container: HTMLElement,
  text: string,
  tool: string,
): void {
  unmountCurrentPayload();
  container.replaceChildren(element("pre", { className: `text-payload ${tool}`, text }));
}

function renderSummaryBadge(card: ToolResultCard): HTMLElement {
  const summary = card.summary ?? {};

  if (isReviewTool(card.tool)) {
    const stats = element("span", { className: "stats" });
    stats.setAttribute("aria-label", "Review diff statistics");
    stats.append(
      element("span", { className: "add", text: `+${String(summary.additions ?? 0)}` }),
      element("span", { className: "remove", text: `-${String(summary.removals ?? 0)}` }),
    );
    return stats;
  }

  if (isEditTool(card.tool) || isWriteTool(card.tool)) {
    const stats = element("span", { className: "stats" });
    stats.setAttribute("aria-label", "Diff statistics");
    stats.append(
      element("span", { className: "add", text: `+${String(summary.additions ?? 0)}` }),
      element("span", { className: "remove", text: `-${String(summary.removals ?? 0)}` }),
    );
    return stats;
  }

  if (card.tool === "open_workspace") {
    const agentsFiles = summaryNumber(summary, "agentsFiles") ?? 0;
    const skills = summaryNumber(summary, "skills") ?? 0;
    const group = element("span", { className: "badge-group" });
    group.setAttribute("aria-label", "Workspace summary");

    const agentsBadge = element("span", {
      className: `badge ${agentsFiles > 0 ? "success" : "muted"}`,
      text: agentsFiles > 0 ? "AGENTS.md" : "No AGENTS.md",
    });
    if (agentsFiles > 0) {
      agentsBadge.insertAdjacentHTML("afterbegin", checkCircleIcon());
    }

    group.append(agentsBadge, element("span", { className: "badge", text: `${skills} skills` }));
    return group;
  }

  if (isTerminalTool(card.tool)) {
    const terminal = card.terminal ?? card.terminals?.[0];
    return element("span", { className: "badge", text: String(terminal?.status ?? "terminal") });
  }

  if (isShellTool(card.tool)) {
    return element("span", { className: "badge", text: `ran · ${String(summary.lines ?? 0)} lines` });
  }

  if (isSearchTool(card.tool)) {
    return element("span", { className: "badge", text: `${String(summary.lines ?? 0)} lines` });
  }

  return element("span", { className: "badge", text: `${String(summary.lines ?? 0)} lines` });
}

function renderReviewCard(card: ToolResultCard, display: ToolDisplay): void {
  unmountPayload();

  const files = card.files ?? [];
  const visibleFiles = reviewFilesExpanded ? files : files.slice(0, 3);
  const hiddenCount = Math.max(0, files.length - visibleFiles.length);
  const main = element("main", { className: "shell" });
  const section = element("section", { className: "tool-card review" });
  const machineBadge = renderMachineBadge(card);
  const header = element("div", {
    className: machineBadge ? "review-header has-machine" : "review-header",
  });
  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.innerHTML = display.icon;
  const titleGroup = element("div", { className: "review-title-group" });

  titleGroup.append(
    element("span", { className: "tool-title", text: display.title }),
    element("span", { className: "tool-label", text: display.label, title: display.label }),
  );
  header.append(icon, titleGroup, renderSummaryBadge(card));
  if (machineBadge) header.append(machineBadge);

  const body = element("div", { className: "review-summary" });
  currentPayloadContainer = body;

  const actions = element("div", { className: "review-actions" });
  if (hiddenCount > 0) {
    const showMore = element("button", {
      className: "review-action",
      type: "button",
      text: `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`,
    });
    showMore.addEventListener("click", () => {
      reviewFilesExpanded = true;
      render();
    });
    actions.append(showMore);
  }

  section.append(header, body);
  if (actions.childElementCount > 0) {
    section.append(actions);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

function renderMachineBadge(card: ToolResultCard): HTMLElement | null {
  const displayName = machineDisplayName(card);
  if (!displayName) return null;

  const badge = element("span", {
    className: "machine-badge",
    text: displayName,
    title: displayName,
  });
  badge.setAttribute("aria-label", `Machine: ${displayName}`);
  return badge;
}

function renderChevron(isExpanded: boolean, visible: boolean): HTMLElement {
  const chevron = element("span", {
    className: visible ? `chevron ${isExpanded ? "expanded" : ""}` : "chevron",
    ariaHidden: "true",
  });

  if (visible) {
    chevron.innerHTML = iconSvg('<path d="m6 9 6 6 6-6" />');
  }

  return chevron;
}

function workspacePayloadText(card: ToolResultCard): string {
  const agentsFiles = card.agentsFiles ?? [];
  const availableAgentsFiles = card.availableAgentsFiles ?? [];
  const skills = card.skills ?? [];
  const capabilities = card.capabilities as {
    fileAccess?: string;
    mountReadOnly?: boolean;
    warnings?: string[];
    git?: { branch?: string; head?: string; dirty?: boolean; strategy?: string };
    runtime?: { shellPath?: string; shellMode?: string; tmux?: boolean; opencode?: string; userSystemd?: boolean; privilegeEscalation?: string };
  } | undefined;
  const worktree = card.worktree as { strategy?: string; sourceCanonicalRoot?: string; baseSha?: string; dirtySource?: boolean } | undefined;
  const lines = [
    ...(capabilities?.warnings ?? []).map((warning) => `Warning: ${warning}`),
    card.workspaceId ? `Workspace: ${card.workspaceId}` : undefined,
    card.root ? `Root: ${card.root}` : undefined,
    card.canonicalRoot ? `Canonical root: ${card.canonicalRoot}` : undefined,
    capabilities?.fileAccess ? `Access: ${capabilities.fileAccess}${capabilities.mountReadOnly ? " (read-only mount)" : ""}` : undefined,
    capabilities?.git ? `Git: ${capabilities.git.branch ?? "detached"} ${capabilities.git.head ?? ""}${capabilities.git.dirty ? " dirty" : " clean"}` : undefined,
    worktree?.strategy ? `Managed strategy: ${worktree.strategy}; source=${worktree.sourceCanonicalRoot ?? "unknown"}; base=${worktree.baseSha ?? "unknown"}${worktree.dirtySource ? "; source dirty" : ""}` : undefined,
    capabilities?.runtime ? `Runtime: ${capabilities.runtime.shellPath ?? "shell"} (${capabilities.runtime.shellMode ?? "service"}), tmux ${capabilities.runtime.tmux ? "available" : "unavailable"}, user-systemd ${capabilities.runtime.userSystemd ? "available" : "unavailable"}, privilege ${capabilities.runtime.privilegeEscalation ?? "unknown"}` : undefined,
    skills.length > 0
      ? `Skills: ${skills.map((skill) => skill.name ?? skill.path ?? "unnamed").join(", ")}`
      : "Skills: none",
    availableAgentsFiles.length > 0
      ? `Nested instructions: ${availableAgentsFiles.map((file) => file.path ?? "unknown").join(", ")}`
      : undefined,
    agentsFiles.length > 0
      ? `\n${formatAgentsFilesForPayload(agentsFiles)}`
      : "\nAGENTS.md: none loaded",
  ].filter((line): line is string => typeof line === "string");

  return lines.join("\n");
}

function terminalPayloadText(card: ToolResultCard): string {
  const terminals = card.terminals ?? (card.terminal ? [card.terminal] : []);
  const lines = terminals.map((terminal) => {
    const id = String(terminal.terminalId ?? "terminal");
    const status = String(terminal.status ?? "unknown");
    const geometry = `${String(terminal.cols ?? "?")}x${String(terminal.rows ?? "?")}`;
    const persistence = terminal.persistentAcrossDevspaceRestart ? "restart-persistent" : "service-lifetime";
    return `${id} ${status} ${geometry} ${persistence}\n${String(terminal.commandSummary ?? "")}`.trim();
  });
  if (card.terminalOutput) lines.push(`\n${card.terminalOutput}`);
  if (card.truncated) lines.push("\n[Terminal output truncated]");
  return lines.join("\n\n");
}

function formatAgentsFilesForPayload(
  agentsFiles: NonNullable<ToolResultCard["agentsFiles"]>,
): string {
  return agentsFiles
    .map((file) => {
      const path = file.path ?? "AGENTS.md";
      const content = file.content?.trim();
      return content ? `${path}\n\n${content}` : `${path}\n\nNo content loaded.`;
    })
    .join("\n\n");
}

function toolTitle(tool: ToolName): string {
  switch (tool) {
    case "open_workspace": return "Workspace";
    case "workspace_status": return "Workspace Status";
    case "close_workspace": return "Close Workspace";
    case "read_file":
    case "read": return "Read";
    case "write_file":
    case "write": return "Write";
    case "edit_file":
    case "edit": return "Edit";
    case "grep_files":
    case "grep": return "Grep";
    case "find_files":
    case "glob": return "Glob";
    case "list_directory":
    case "ls": return "List";
    case "run_shell":
    case "bash": return "Bash";
    case "terminal_start": return "Start Terminal";
    case "terminal_read": return "Read Terminal";
    case "terminal_write": return "Write Terminal";
    case "terminal_resize": return "Resize Terminal";
    case "terminal_status": return "Terminal Status";
    case "terminal_close": return "Close Terminal";
    case "show_changes": return "Changes";
  }
}

function getToolDisplay(card: ToolResultCard): ToolDisplay {
  const label = getToolLabel(card);

  switch (card.tool) {
    case "open_workspace":
      return { icon: folderIcon(), title: "Workspace", label, tone: "workspace" };
    case "workspace_status":
      return { icon: folderIcon(), title: "Workspace Status", label, tone: "workspace" };
    case "close_workspace":
      return { icon: folderIcon(), title: "Close Workspace", label, tone: "workspace" };
    case "read_file":
    case "read":
      return { icon: fileIcon(), title: "Read File", label, tone: "read" };
    case "write_file":
    case "write":
      return { icon: filePlusIcon(), title: "Write File", label, tone: "write" };
    case "edit_file":
    case "edit":
      return { icon: editIcon(), title: "Edit File", label, tone: "edit" };
    case "grep_files":
    case "grep":
      return { icon: searchIcon(), title: "Grep", label, tone: "search" };
    case "find_files":
    case "glob":
      return { icon: filesIcon(), title: "Glob", label, tone: "search" };
    case "list_directory":
    case "ls":
      return { icon: listIcon(), title: "List Directory", label, tone: "directory" };
    case "run_shell":
    case "bash":
      return { icon: terminalIcon(), title: "Bash", label, tone: "shell" };
    case "terminal_start":
      return { icon: terminalIcon(), title: "Start Terminal", label, tone: "shell" };
    case "terminal_read":
      return { icon: terminalIcon(), title: "Read Terminal", label, tone: "shell" };
    case "terminal_write":
      return { icon: terminalIcon(), title: "Write Terminal", label, tone: "shell" };
    case "terminal_resize":
      return { icon: terminalIcon(), title: "Resize Terminal", label, tone: "shell" };
    case "terminal_status":
      return { icon: terminalIcon(), title: "Terminal Status", label, tone: "shell" };
    case "terminal_close":
      return { icon: terminalIcon(), title: "Close Terminal", label, tone: "shell" };
    case "show_changes":
      return { icon: reviewIcon(), title: "Show Changes", label, tone: "review" };
  }
}

function getToolLabel(card: ToolResultCard): string {
  if (card.tool === "workspace_status") return card.root ?? "capabilities and Git state";
  if (card.tool === "close_workspace") return card.root ?? "workspace session";
  if (isTerminalTool(card.tool)) {
    const terminal = card.terminal ?? card.terminals?.[0];
    return String(terminal?.commandSummary ?? terminal?.terminalId ?? card.tool);
  }
  if (isShellTool(card.tool)) {
    return String(card.summary?.command ?? card.path ?? card.tool);
  }
  if (isReviewTool(card.tool)) {
    const count = Number(card.summary?.files ?? card.files?.length ?? 0);
    return count === 0 ? "No changes since last review" : `${count} changed ${count === 1 ? "file" : "files"}`;
  }
  if (card.path) return card.path;
  if (card.root) return card.root;
  if (isSearchTool(card.tool)) {
    return String(card.summary?.pattern ?? card.tool);
  }

  return card.tool;
}

function toolNameFromMeta(result: CallToolResult): ToolName | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const tool = meta?.tool;
  return isToolName(tool) ? tool : undefined;
}

function cardFromMeta(result: CallToolResult): Partial<ToolResultCard> | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const metaCard = meta?.card;
  return metaCard && typeof metaCard === "object" ? metaCard : undefined;
}

function getStructuredContent<T>(result: CallToolResult): T | undefined {
  return result.structuredContent as T | undefined;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    type?: string;
    title?: string;
    ariaHidden?: string;
    ariaExpanded?: string;
    disabled?: boolean;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type !== undefined && "type" in node) node.setAttribute("type", options.type);
  if (options.title !== undefined) node.title = options.title;
  if (options.ariaHidden !== undefined) node.setAttribute("aria-hidden", options.ariaHidden);
  if (options.ariaExpanded !== undefined) node.setAttribute("aria-expanded", options.ariaExpanded);
  if (options.disabled !== undefined && "disabled" in node) {
    (node as HTMLButtonElement).disabled = options.disabled;
  }
  return node;
}

function iconSvg(children: string): string {
  return `<svg aria-hidden="true" class="icon-svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8">${children}</svg>`;
}

function folderIcon(): string {
  return iconSvg('<path d="M3 7.5h6l2 2h10" /><path d="M3 7.5v10A2.5 2.5 0 0 0 5.5 20h13a2.5 2.5 0 0 0 2.5-2.5v-8H3" />');
}

function fileIcon(): string {
  return iconSvg('<path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /><path d="M9 13h6" /><path d="M9 17h4" />');
}

function filePlusIcon(): string {
  return iconSvg('<path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /><path d="M12 12v6" /><path d="M9 15h6" />');
}

function editIcon(): string {
  return iconSvg('<path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" />');
}

function searchIcon(): string {
  return iconSvg('<circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" />');
}

function filesIcon(): string {
  return iconSvg('<path d="M8 7V4h9l4 4v10h-3" /><path d="M12 4v5h5" /><path d="M4 7h9l4 4v10H4z" /><path d="M13 7v5h4" />');
}

function checkCircleIcon(): string {
  return '<svg aria-hidden="true" class="badge-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="8" cy="8" r="6" /><path d="m5.5 8 1.7 1.7 3.4-3.5" /></svg>';
}

function listIcon(): string {
  return iconSvg('<path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" />');
}

function terminalIcon(): string {
  return iconSvg('<path d="m5 7 5 5-5 5" /><path d="M12 17h7" />');
}

function reviewIcon(): string {
  return iconSvg('<path d="M5 4h14v16H5z" /><path d="M8 8h8" /><path d="M8 12h5" /><path d="M8 16h7" />');
}
