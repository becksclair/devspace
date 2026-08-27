import { randomUUID } from "node:crypto";
import type { GatewayWorkspaceStore, PublicWorkspaceBinding } from "./gateway-workspace-store.js";
import type { ToolName } from "./tool-contract.js";
import type { ToolResponse } from "./pi-tools.js";
import {
  workspaceActivityDetail,
  workspaceActivityLabel,
  type NewWorkspaceActivityEvent,
  type WorkspaceActivityEvent,
  type WorkspaceActivityPage,
} from "./workspace-activity.js";

export interface GatewayMachine {
  id: string;
  displayName: string;
  aliases: string[];
  canonical: boolean;
}

export type ExecutorResult = ToolResponse;

export interface ExecutionTarget {
  execute(
    tool: ToolName,
    args: Record<string, unknown>,
    options: { requestId: string; signal: AbortSignal },
  ): Promise<ExecutorResult>;
}

export interface RoutedExecution {
  result: ExecutorResult;
  machine: { id: string; displayName: string };
  publicWorkspaceId: string;
}

export class GatewayRoutingError extends Error {
  constructor(
    readonly code: "unknown_machine" | "target_unavailable" | "unknown_workspace",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GatewayRoutingError";
  }
}

export class TargetUnavailableError extends Error {
  constructor(message = "Execution target is unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "TargetUnavailableError";
  }
}

const ACTIVITY_RETENTION_AFTER_CLOSE_MS = 60_000;

export class GatewayExecutionRouter {
  private readonly machinesById = new Map<string, GatewayMachine>();
  private readonly names = new Map<string, GatewayMachine>();
  private readonly canonical: GatewayMachine;
  private readonly activityWaiters = new Map<string, Set<() => void>>();
  private readonly activityEvents = new Map<string, WorkspaceActivityEvent[]>();
  private readonly activityNextSeq = new Map<string, number>();
  private readonly activityOperationTotals = new Map<string, number>();
  private readonly activityCleanupTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    machines: GatewayMachine[],
    private readonly targets: ReadonlyMap<string, ExecutionTarget>,
    private readonly bindings: GatewayWorkspaceStore,
  ) {
    const canonical = machines.filter((machine) => machine.canonical);
    if (canonical.length !== 1) {
      throw new Error("Gateway requires exactly one canonical machine");
    }
    this.canonical = canonical[0]!;

    for (const machine of machines) {
      const id = normalizeMachineName(machine.id);
      if (!id || this.names.has(id)) throw new Error(`Duplicate machine ID or alias: ${machine.id}`);
      const normalized = { ...machine, id, aliases: machine.aliases.map(normalizeMachineName) };
      this.machinesById.set(id, normalized);
      this.names.set(id, normalized);
      for (const alias of normalized.aliases) {
        if (!alias || this.names.has(alias)) throw new Error(`Duplicate machine ID or alias: ${alias}`);
        this.names.set(alias, normalized);
      }
    }
  }

  async execute(
    tool: ToolName,
    args: Record<string, unknown>,
    options: { requestId: string; signal: AbortSignal },
  ): Promise<RoutedExecution> {
    if (tool === "open_workspace") return this.openWorkspace(args, options);

    const publicWorkspaceId = typeof args.workspaceId === "string" ? args.workspaceId : "";
    const binding = publicWorkspaceId ? this.bindings.get(publicWorkspaceId) : undefined;
    if (!binding) {
      throw new GatewayRoutingError(
        "unknown_workspace",
        `Unknown workspaceId: ${publicWorkspaceId || "<missing>"}. Call open_workspace first.`,
      );
    }
    const machine = this.machinesById.get(binding.machineId);
    if (!machine) {
      throw new GatewayRoutingError(
        "target_unavailable",
        `Workspace target ${binding.machineId} is no longer configured.`,
      );
    }
    const target = this.targetFor(machine);
    const operationId = randomUUID();
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const label = workspaceActivityLabel(tool, args);
    this.appendActivity({
      workspaceId: publicWorkspaceId,
      operationId,
      tool,
      machine: publicMachine(machine),
      status: "running",
      label,
      startedAt,
      createdAt: startedAt,
    });

    let result: ExecutorResult;
    try {
      result = await this.invoke(target, machine, tool, {
        ...args,
        workspaceId: binding.executorWorkspaceId,
      }, options);
    } catch (error) {
      this.appendActivity({
        workspaceId: publicWorkspaceId,
        operationId,
        tool,
        machine: publicMachine(machine),
        status: "error",
        label,
        detail: "failed",
        startedAt,
        durationMs: Date.now() - startedMs,
        createdAt: new Date().toISOString(),
      });
      if (error instanceof GatewayRoutingError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/Unknown workspaceId:|Workspace is not active:/.test(message)) {
        this.bindings.delete(publicWorkspaceId);
        this.scheduleActivityCleanup(publicWorkspaceId);
        throw new GatewayRoutingError(
          "unknown_workspace",
          `Unknown workspaceId: ${publicWorkspaceId}. Call open_workspace first.`,
          { cause: error },
        );
      }
      // Do not perform substring replacement on arbitrary error messages (which may contain
      // file content, patches, or logs). That would corrupt data and is unnecessary for
      // privacy — the workspaceId-specific case is already handled above.
      throw error instanceof Error ? error : new Error(message);
    }

    const rewrittenResult = rewriteExecutorWorkspaceId(result, binding.executorWorkspaceId, publicWorkspaceId);
    this.appendActivity({
      workspaceId: publicWorkspaceId,
      operationId,
      tool,
      machine: publicMachine(machine),
      status: result.isError ? "error" : "success",
      label,
      detail: workspaceActivityDetail(tool, rewrittenResult),
      startedAt,
      durationMs: Date.now() - startedMs,
      createdAt: new Date().toISOString(),
    });
    // RV-003 per-file fan-out for multi_read so gateway UI/audit shows per-file granularity
    if (tool === "multi_read" && Array.isArray((rewrittenResult.structuredContent as unknown as { results?: unknown[] })?.results)) {
      const results = (rewrittenResult.structuredContent as unknown as { results: Array<{ path: string; status: string }> }).results;
      for (let idx = 0; idx < results.length; idx++) {
        const r = results[idx]!;
        const sanitized = r.path.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
        const fileOpId = `${operationId}:${sanitized}:${idx}`;
        // Per-file duration estimated as equal split of total duration for simplicity; advisory only (RV-003)
        const perFileMs = Math.round((Date.now() - startedMs) / results.length);
        this.appendActivity({
          workspaceId: publicWorkspaceId,
          operationId: fileOpId,
          tool: "read_file" as ToolName,
          machine: publicMachine(machine),
          status: r.status === "ok" ? "success" : "error",
          label: `read_file ${r.path}`,
          detail: r.status,
          startedAt,
          durationMs: perFileMs,
          createdAt: new Date().toISOString(),
        });
      }
    }

    const workspaceClosed = tool === "close_workspace" && result.structuredContent?.workspace && typeof result.structuredContent.workspace === "object"
      ? (result.structuredContent.workspace as { closed?: unknown }).closed === true
      : false;
    if (workspaceClosed) {
      this.bindings.deleteByExecutor(machine.id, binding.executorWorkspaceId);
      this.scheduleActivityCleanup(publicWorkspaceId);
    } else {
      this.bindings.touch(publicWorkspaceId);
    }
    return {
      result: rewrittenResult,
      machine: publicMachine(machine),
      publicWorkspaceId,
    };
  }

  close(): void {
    for (const timer of this.activityCleanupTimers.values()) clearTimeout(timer);
    this.activityCleanupTimers.clear();
    for (const waiters of this.activityWaiters.values()) {
      for (const wake of Array.from(waiters)) wake();
    }
    this.activityWaiters.clear();
    this.activityEvents.clear();
    this.activityNextSeq.clear();
    this.activityOperationTotals.clear();
  }

  async waitForActivity(
    publicWorkspaceId: string,
    afterSeq: number,
    limit: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<WorkspaceActivityPage> {
    let page = this.listActivity(publicWorkspaceId, afterSeq, limit);
    if (page.events.length > 0 || page.latestSeq < afterSeq || waitMs <= 0 || signal?.aborted) return page;

    await new Promise<void>((resolve) => {
      let settled = false;
      const waiters = this.activityWaiters.get(publicWorkspaceId) ?? new Set<() => void>();
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        waiters.delete(finish);
        if (waiters.size === 0) this.activityWaiters.delete(publicWorkspaceId);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, Math.min(30_000, waitMs)));
      waiters.add(finish);
      this.activityWaiters.set(publicWorkspaceId, waiters);
      signal?.addEventListener("abort", finish, { once: true });
      if (this.listActivity(publicWorkspaceId, afterSeq, 1).events.length > 0) queueMicrotask(finish);
    });

    page = this.listActivity(publicWorkspaceId, afterSeq, limit);
    return page;
  }

  private appendActivity(event: NewWorkspaceActivityEvent): void {
    const seq = this.activityNextSeq.get(event.workspaceId) ?? 1;
    const events = this.activityEvents.get(event.workspaceId) ?? [];
    events.push({ ...event, seq });
    if (events.length > 400) events.splice(0, events.length - 400);
    this.activityEvents.set(event.workspaceId, events);
    this.activityNextSeq.set(event.workspaceId, seq + 1);
    if (event.status === "running") {
      this.activityOperationTotals.set(
        event.workspaceId,
        (this.activityOperationTotals.get(event.workspaceId) ?? 0) + 1,
      );
    }

    const waiters = this.activityWaiters.get(event.workspaceId);
    if (!waiters) return;
    for (const wake of Array.from(waiters)) wake();
  }

  private scheduleActivityCleanup(publicWorkspaceId: string): void {
    const existing = this.activityCleanupTimers.get(publicWorkspaceId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.activityCleanupTimers.delete(publicWorkspaceId);
      this.activityEvents.delete(publicWorkspaceId);
      this.activityNextSeq.delete(publicWorkspaceId);
      this.activityOperationTotals.delete(publicWorkspaceId);
      const waiters = this.activityWaiters.get(publicWorkspaceId);
      if (!waiters) return;
      for (const wake of Array.from(waiters)) wake();
    }, ACTIVITY_RETENTION_AFTER_CLOSE_MS);
    timer.unref();
    this.activityCleanupTimers.set(publicWorkspaceId, timer);
  }

  private listActivity(publicWorkspaceId: string, afterSeq: number, limit: number): WorkspaceActivityPage {
    const events = this.activityEvents.get(publicWorkspaceId) ?? [];
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const normalizedAfterSeq = Math.max(0, Math.trunc(afterSeq));
    const selected = normalizedAfterSeq === 0
      ? events.slice(-boundedLimit)
      : events.filter((event) => event.seq > normalizedAfterSeq).slice(0, boundedLimit);
    return {
      events: selected,
      latestSeq: events.at(-1)?.seq ?? 0,
      totalOperations: this.activityOperationTotals.get(publicWorkspaceId) ?? 0,
    };
  }

  private async openWorkspace(
    args: Record<string, unknown>,
    options: { requestId: string; signal: AbortSignal },
  ): Promise<RoutedExecution> {
    const rawMachine = args.machine;
    let machine: GatewayMachine;
    if (rawMachine === undefined) {
      machine = this.machinesById.get(normalizeMachineName(this.canonical.id)) ?? this.canonical;
    } else if (typeof rawMachine === "string" && rawMachine.trim()) {
      const selected = this.names.get(normalizeMachineName(rawMachine));
      if (!selected) throw this.unknownMachine(rawMachine);
      machine = selected;
    } else {
      throw this.unknownMachine(typeof rawMachine === "string" ? rawMachine : String(rawMachine));
    }

    const target = this.targetFor(machine);
    const { machine: _machine, ...executorArgs } = args;
    const result = await this.invoke(target, machine, "open_workspace", executorArgs, options);
    const executorWorkspaceId = result.structuredContent?.workspaceId;
    if (result.isError || typeof executorWorkspaceId !== "string" || !executorWorkspaceId) {
      return {
        result: typeof executorWorkspaceId === "string" && executorWorkspaceId
          ? rewriteExecutorWorkspaceId(result, executorWorkspaceId, "")
          : result,
        machine: publicMachine(machine),
        publicWorkspaceId: "",
      };
    }

    const existing = this.bindings.findByExecutor(machine.id, executorWorkspaceId);
    const publicWorkspaceId = existing?.publicWorkspaceId ?? `gw_${randomUUID()}`;
    const now = new Date().toISOString();
    const binding: PublicWorkspaceBinding = {
      publicWorkspaceId,
      machineId: machine.id,
      executorWorkspaceId,
      createdAt: now,
      lastUsedAt: now,
    };
    if (existing) this.bindings.touch(publicWorkspaceId);
    else this.bindings.save(binding);
    const rewritten = rewriteExecutorWorkspaceId(result, executorWorkspaceId, publicWorkspaceId);
    rewritten.structuredContent = {
      ...rewritten.structuredContent,
      machine: publicMachine(machine),
    };
    return { result: rewritten, machine: publicMachine(machine), publicWorkspaceId };
  }

  private async invoke(
    target: ExecutionTarget,
    machine: GatewayMachine,
    tool: ToolName,
    args: Record<string, unknown>,
    options: { requestId: string; signal: AbortSignal },
  ): Promise<ExecutorResult> {
    try {
      return await target.execute(tool, args, options);
    } catch (error) {
      if (error instanceof GatewayRoutingError) throw error;
      if (!(error instanceof TargetUnavailableError)) throw error;
      throw new GatewayRoutingError(
        "target_unavailable",
        `Target ${machine.displayName} is unavailable.`,
        { cause: error },
      );
    }
  }

  private targetFor(machine: GatewayMachine): ExecutionTarget {
    const target = this.targets.get(machine.id);
    if (!target) {
      throw new GatewayRoutingError(
        "target_unavailable",
        `Target ${machine.displayName} is unavailable.`,
      );
    }
    return target;
  }

  private unknownMachine(value: string): GatewayRoutingError {
    return new GatewayRoutingError(
      "unknown_machine",
      `Unknown machine ${JSON.stringify(value)}. Valid machines: ${Array.from(this.names.keys()).sort().join(", ")}.`,
    );
  }
}

export function normalizeMachineName(value: string): string {
  return value.trim().toLowerCase();
}

export function rewriteExecutorWorkspaceId<T>(
  value: T,
  executorWorkspaceId: string,
  publicWorkspaceId: string,
): T {
  return rewriteValue(value, executorWorkspaceId, publicWorkspaceId) as T;
}

// Rewrites only known workspaceId locations via exact string equality, never
// via substring replacement. This prevents corruption of file content, grep
// output, patches/diffs (up to 50 MB), and shell logs that happen to contain
// the private ID as a substring. Only exact-match `workspaceId` /
// `executorWorkspaceId` fields are remapped; `content[*].text` is left
// byte-identical except for a constrained prefix rewrite for human-readable
// workspace lifecycle messages (e.g. "Opened workspace <id>") so the private
// ID does not leak via the opener's human text while file data remains
// untouched.
function rewriteValue(value: unknown, privateId: string, publicId: string): unknown {
  if (value === privateId) return publicId;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, privateId, publicId));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "workspaceId" || key === "executorWorkspaceId") && item === privateId) {
        out[key] = publicId;
      } else if (key === "content" && Array.isArray(item)) {
        out[key] = item.map((entry) => {
          if (
            entry &&
            typeof entry === "object" &&
            "text" in (entry as Record<string, unknown>) &&
            typeof (entry as Record<string, unknown>)["text"] === "string"
          ) {
            const text = (entry as Record<string, unknown>)["text"] as string;
            const prefixes = ["Opened workspace ", "Workspace ", "workspace ", "Closed workspace "];
            for (const prefix of prefixes) {
              if (text.startsWith(prefix + privateId)) {
                const rest = text.slice((prefix + privateId).length);
                return { ...(entry as Record<string, unknown>), text: prefix + publicId + rest };
              }
            }
            return entry;
          }
          return rewriteValue(entry, privateId, publicId);
        });
      } else if (key === "workspace" && item && typeof item === "object") {
        out[key] = rewriteValue(item, privateId, publicId);
      } else if (key === "terminal" || key === "terminals") {
        out[key] = item;
      } else {
        out[key] = rewriteValue(item, privateId, publicId);
      }
    }
    return out;
  }
  return value;
}

function publicMachine(machine: GatewayMachine): { id: string; displayName: string } {
  return { id: machine.id, displayName: machine.displayName };
}
