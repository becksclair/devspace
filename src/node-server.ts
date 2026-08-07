import { createHash, randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { getBuildMetadata, type BuildMetadata } from "./build-metadata.js";
import { constantTimeEqual, envSecret, type NodeRoleConfig } from "./role-config.js";
import { CANONICAL_TOOL_NAMES, parseToolArguments, TOOL_CONTRACT_HASH } from "./tool-contract.js";

export interface NodeExecutor {
  execute(tool: string, args: unknown, context: { requestId: string; signal: AbortSignal }): Promise<unknown>;
}

export interface NodeServerOptions {
  metadata?: BuildMetadata;
  maxBodyBytes?: number;
  allowedTools?: Set<string> | string[];
  resultRetentionMs?: number;
  operationRetentionMs?: number;
  maxRunningOperations?: number;
  maxCompletedOutcomes?: number;
}

type NodeEnvelope =
  | { ok: true; machineId: string; result: unknown }
  | { ok: false; error: { code: string; message: string } };

type NodeCallOutcome = { status: number; body: string };

type NodeOperation = RunningOperation | CompletedOperation | ExpiredOperation;

interface OperationBase {
  fingerprint: string;
}

interface RunningOperation extends OperationBase {
  state: "running";
  controller: AbortController;
  promise: Promise<NodeCallOutcome>;
}

interface CompletedOperation extends OperationBase {
  state: "completed";
  outcome: NodeCallOutcome;
  completedAt: number;
}

interface ExpiredOperation extends OperationBase {
  state: "expired";
  completedAt: number;
}

const DEFAULT_RESULT_RETENTION_MS = 60 * 1000;
const DEFAULT_OPERATION_RETENTION_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RUNNING_OPERATIONS = 64;
const DEFAULT_MAX_COMPLETED_OUTCOMES = 128;

export function createNodeServer(config: NodeRoleConfig, executor: NodeExecutor, options: NodeServerOptions = {}) {
  const app = express();
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const resultRetentionMs = Math.max(1, options.resultRetentionMs ?? DEFAULT_RESULT_RETENTION_MS);
  const operationRetentionMs = Math.max(resultRetentionMs, options.operationRetentionMs ?? DEFAULT_OPERATION_RETENTION_MS);
  const maxRunningOperations = positiveInteger(options.maxRunningOperations, DEFAULT_MAX_RUNNING_OPERATIONS);
  const maxCompletedOutcomes = positiveInteger(options.maxCompletedOutcomes, DEFAULT_MAX_COMPLETED_OUTCOMES);
  const metadata = options.metadata ?? { ...getBuildMetadata("node"), toolContractHash: TOOL_CONTRACT_HASH };
  const allowed = options.allowedTools ? new Set(options.allowedTools) : new Set<string>(CANONICAL_TOOL_NAMES);
  const nodeInstanceId = randomUUID();
  const operations = new Map<string, NodeOperation>();

  app.use(express.json({ limit: maxBodyBytes }));
  app.use((req, res, next) => {
    const provided = req.header("X-DevSpace-Node-Token") ?? "";
    let expected = "";
    try {
      expected = envSecret(config.nodeTokenEnv);
    } catch {
      // Handled as unauthorized below.
    }
    if (!expected || !constantTimeEqual(provided, expected)) {
      return res.status(401).json({ error: { code: "unauthorized", message: "Unauthorized" } });
    }
    next();
  });

  app.get("/internal/v1/hello", (_req, res) => res.json({
    protocolMajor: metadata.protocolMajor,
    machineId: config.machineId,
    packageVersion: metadata.packageVersion,
    sourceCommit: metadata.sourceCommit,
    toolContractHash: metadata.toolContractHash,
    resumableCalls: true,
    nodeInstanceId,
  }));

  app.post("/internal/v1/call", async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const requestId = typeof body?.requestId === "string" ? body.requestId : "";
    const fail = (status: number, code: string, message: string) => sendOutcome(res, jsonOutcome(status, {
      ok: false,
      error: { code, message: message.slice(0, 1024) },
    }));

    if (!body || body.protocolMajor !== metadata.protocolMajor || body.toolContractHash !== metadata.toolContractHash) {
      return fail(400, "protocol_mismatch", "Protocol or tool contract mismatch");
    }
    if (body.machineId !== config.machineId) return fail(409, "identity_mismatch", "Machine identity mismatch");
    if (!requestId || requestId.length > 128 || typeof body.tool !== "string" || !allowed.has(body.tool)) {
      return fail(400, "invalid_request", "Invalid call envelope");
    }
    if (body.resumable !== undefined && typeof body.resumable !== "boolean") {
      return fail(400, "invalid_request", "Invalid resumable call flag");
    }

    let args: unknown;
    try {
      args = parseToolArguments(body.tool as never, body.arguments);
    } catch {
      return fail(400, "invalid_arguments", "Invalid tool arguments");
    }

    if (body.resumable !== true) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const abortOnResponseClose = () => {
        if (!res.writableEnded) abort();
      };
      req.once("aborted", abort);
      res.once("close", abortOnResponseClose);
      try {
        sendOutcome(res, await executeCall(executor, body.tool, args, requestId, controller.signal, config.machineId, maxBodyBytes));
      } finally {
        req.off("aborted", abort);
        res.off("close", abortOnResponseClose);
      }
      return;
    }

    if (body.nodeInstanceId !== nodeInstanceId) {
      return fail(409, "operation_epoch_mismatch", "Remote node instance changed while the operation result was uncertain");
    }

    pruneOperations(operations, resultRetentionMs, operationRetentionMs, maxCompletedOutcomes);
    const fingerprint = operationFingerprint(body.tool, args);
    let operation = operations.get(requestId);
    if (operation && operation.fingerprint !== fingerprint) {
      return fail(409, "request_id_conflict", "requestId is already bound to different tool arguments");
    }
    if (operation?.state === "expired") {
      return fail(410, "operation_result_expired", "Remote operation already ran but its replayable result has expired");
    }
    if (!operation) {
      if (countRunningOperations(operations) >= maxRunningOperations) {
        return fail(503, "operation_capacity", "Remote operation capacity is temporarily exhausted");
      }
      const controller = new AbortController();
      const running: RunningOperation = {
        state: "running",
        fingerprint,
        controller,
        promise: Promise.resolve({ status: 500, body: "" }),
      };
      running.promise = executeCall(executor, body.tool, args, requestId, controller.signal, config.machineId, maxBodyBytes)
        .then((outcome) => {
          if (operations.get(requestId) === running) {
            operations.set(requestId, {
              state: "completed",
              fingerprint,
              outcome,
              completedAt: Date.now(),
            });
          }
          return outcome;
        });
      operation = running;
      operations.set(requestId, operation);
    }

    if (operation.state === "completed") {
      sendOutcome(res, operation.outcome);
      return;
    }
    sendOutcome(res, await operation.promise);
  });

  app.post("/internal/v1/cancel", (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const requestId = typeof body?.requestId === "string" ? body.requestId : "";
    const fail = (status: number, code: string, message: string) => sendOutcome(res, jsonOutcome(status, {
      ok: false,
      error: { code, message: message.slice(0, 1024) },
    }));

    if (!body || body.protocolMajor !== metadata.protocolMajor || body.toolContractHash !== metadata.toolContractHash) {
      return fail(400, "protocol_mismatch", "Protocol or tool contract mismatch");
    }
    if (body.machineId !== config.machineId) return fail(409, "identity_mismatch", "Machine identity mismatch");
    if (!requestId || requestId.length > 128) return fail(400, "invalid_request", "Invalid cancel envelope");
    if (body.nodeInstanceId !== nodeInstanceId) {
      return fail(409, "operation_epoch_mismatch", "Remote node instance changed before cancellation could be confirmed");
    }

    pruneOperations(operations, resultRetentionMs, operationRetentionMs, maxCompletedOutcomes);
    const operation = operations.get(requestId);
    if (!operation) return fail(404, "unknown_operation", "Unknown remote operation");
    if (operation.state === "running") {
      operation.controller.abort(new Error("Remote operation cancelled"));
      return res.json({ ok: true, state: "cancelling" });
    }
    return res.json({ ok: true, state: "completed" });
  });

  return { app, metadata };
}

async function executeCall(
  executor: NodeExecutor,
  tool: string,
  args: unknown,
  requestId: string,
  signal: AbortSignal,
  machineId: string,
  maxBodyBytes: number,
): Promise<NodeCallOutcome> {
  try {
    const result = await executor.execute(tool, args, { requestId, signal });
    const envelope: NodeEnvelope = { ok: true, machineId, result };
    const body = JSON.stringify(envelope);
    if (Buffer.byteLength(body) > maxBodyBytes) {
      return jsonOutcome(500, {
        ok: false,
        error: { code: "response_too_large", message: "Executor response exceeds the configured limit" },
      });
    }
    return { status: 200, body };
  } catch (error) {
    return jsonOutcome(500, {
      ok: false,
      error: {
        code: "executor_error",
        message: (error instanceof Error ? error.message : String(error)).slice(0, 1024),
      },
    });
  }
}

function operationFingerprint(tool: unknown, args: unknown): string {
  return createHash("sha256").update(JSON.stringify({ tool, args }), "utf8").digest("hex");
}

function pruneOperations(
  operations: Map<string, NodeOperation>,
  resultRetentionMs: number,
  operationRetentionMs: number,
  maxCompletedOutcomes: number,
): void {
  const now = Date.now();
  const completed: Array<{ requestId: string; completedAt: number }> = [];
  for (const [requestId, operation] of operations) {
    if (operation.state === "running") continue;
    if (now - operation.completedAt >= operationRetentionMs) {
      operations.delete(requestId);
      continue;
    }
    if (operation.state === "completed") {
      if (now - operation.completedAt >= resultRetentionMs) {
        operations.set(requestId, { state: "expired", fingerprint: operation.fingerprint, completedAt: operation.completedAt });
      } else {
        completed.push({ requestId, completedAt: operation.completedAt });
      }
    }
  }

  if (completed.length <= maxCompletedOutcomes) return;
  completed.sort((left, right) => left.completedAt - right.completedAt);
  for (const entry of completed.slice(0, completed.length - maxCompletedOutcomes)) {
    const operation = operations.get(entry.requestId);
    if (operation?.state === "completed") {
      operations.set(entry.requestId, { state: "expired", fingerprint: operation.fingerprint, completedAt: operation.completedAt });
    }
  }
}

function countRunningOperations(operations: Map<string, NodeOperation>): number {
  let count = 0;
  for (const operation of operations.values()) if (operation.state === "running") count += 1;
  return count;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function jsonOutcome(status: number, envelope: NodeEnvelope): NodeCallOutcome {
  return { status, body: JSON.stringify(envelope) };
}

function sendOutcome(res: Response, outcome: NodeCallOutcome): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.status(outcome.status).type("application/json").send(outcome.body);
}

export async function startNodeServer(config: NodeRoleConfig, executor: NodeExecutor, options?: NodeServerOptions): Promise<import("node:http").Server> {
  const { app } = createNodeServer(config, executor, options);
  return app.listen(config.port, config.host);
}
