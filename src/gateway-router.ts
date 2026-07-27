import { randomUUID } from "node:crypto";
import type { GatewayWorkspaceStore, PublicWorkspaceBinding } from "./gateway-workspace-store.js";
import type { ToolName } from "./tool-contract.js";
import type { ToolResponse } from "./pi-tools.js";

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

export class GatewayExecutionRouter {
  private readonly machinesById = new Map<string, GatewayMachine>();
  private readonly names = new Map<string, GatewayMachine>();
  private readonly canonical: GatewayMachine;

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
    let result: ExecutorResult;
    try {
      result = await this.invoke(target, machine, tool, {
        ...args,
        workspaceId: binding.executorWorkspaceId,
      }, options);
    } catch (error) {
      if (error instanceof GatewayRoutingError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.split(binding.executorWorkspaceId).join(publicWorkspaceId));
    }
    this.bindings.touch(publicWorkspaceId);
    return {
      result: rewriteExecutorWorkspaceId(result, binding.executorWorkspaceId, publicWorkspaceId),
      machine: publicMachine(machine),
      publicWorkspaceId,
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

    const publicWorkspaceId = `gw_${randomUUID()}`;
    const now = new Date().toISOString();
    const binding: PublicWorkspaceBinding = {
      publicWorkspaceId,
      machineId: machine.id,
      executorWorkspaceId,
      createdAt: now,
      lastUsedAt: now,
    };
    this.bindings.save(binding);
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

function rewriteValue(value: unknown, privateId: string, publicId: string): unknown {
  if (typeof value === "string") return value.split(privateId).join(publicId);
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, privateId, publicId));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewriteValue(item, privateId, publicId)]),
    );
  }
  return value;
}

function publicMachine(machine: GatewayMachine): { id: string; displayName: string } {
  return { id: machine.id, displayName: machine.displayName };
}
