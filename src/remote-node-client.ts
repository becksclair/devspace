import { randomUUID } from "node:crypto";
import { TargetUnavailableError, type ExecutionTarget, type ExecutorResult } from "./gateway-router.js";
import { getBuildMetadata, PROTOCOL_MAJOR } from "./build-metadata.js";
import { TOOL_CONTRACT_HASH, type ToolName } from "./tool-contract.js";
import { isTailnetUrl } from "./tailnet.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const HELLO_RETRY_ATTEMPTS = 4;
const CANCEL_TIMEOUT_MS = 2_000;

export interface RemoteNodeClientConfig {
  machineId: string;
  url: string;
  nodeToken: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

interface NodeHello {
  protocolMajor: number;
  machineId: string;
  packageVersion: string;
  sourceCommit: string;
  toolContractHash: string;
  resumableCalls?: boolean;
  nodeInstanceId?: string;
}

type NodeCallEnvelope =
  | { ok: true; machineId: string; result: ExecutorResult }
  | { ok: false; error?: { code?: string; message?: string } };

class RemoteNodeTransportError extends TargetUnavailableError {
  constructor(message = "Remote node transport failed", options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteNodeTransportError";
  }
}

class RemoteNodeExecutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RemoteNodeExecutionError";
  }
}

export class RemoteNodeClient implements ExecutionTarget {
  constructor(private readonly config: RemoteNodeClientConfig) {
    const url = new URL(config.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Remote node URL must use HTTPS or HTTP");
    if (url.protocol === "http:" && !isTailnetUrl(url)) {
      throw new Error("Remote node HTTP is only allowed for Tailnet targets (100.64.0.0/10, fd7a:115c:a1e0::/48, or *.ts.net)");
    }
  }

  async hello(signal: AbortSignal): Promise<NodeHello> {
    let hello: NodeHello;
    try {
      hello = await this.withTimeout(signal, (boundedSignal) => this.retryTransient(
        async () => {
          const response = await this.request("/internal/v1/hello", { method: "GET" }, boundedSignal);
          if (!response.ok) throw new TargetUnavailableError(`Remote node hello failed (${response.status})`);
          return readBoundedJson<NodeHello>(response, this.maxBodyBytes());
        },
        boundedSignal,
        HELLO_RETRY_ATTEMPTS,
      ));
    } catch (error) {
      throw normalizeTargetError(error, signal, "Remote node hello failed");
    }
    if (
      hello.protocolMajor !== PROTOCOL_MAJOR ||
      hello.machineId !== this.config.machineId ||
      hello.toolContractHash !== TOOL_CONTRACT_HASH
    ) {
      throw new TargetUnavailableError("Remote node identity is incompatible");
    }
    return hello;
  }

  async execute(
    tool: ToolName,
    args: Record<string, unknown>,
    options: { requestId: string; signal: AbortSignal },
  ): Promise<ExecutorResult> {
    // Revalidate immediately before every operation. A process-lifetime cache
    // could route a later call to the wrong machine after DNS/tunnel changes.
    const hello = await this.hello(options.signal);
    // MCP JSON-RPC IDs are scoped to a session and are commonly reused (for
    // example, many fresh ChatGPT MCP sessions start again at id=1). Generate a
    // gateway-side operation ID unique to this execute() invocation and keep it
    // stable only across automatic transport reattachments for that call.
    const remoteRequestId = randomUUID();
    const nodeInstanceId = typeof hello.nodeInstanceId === "string" && hello.nodeInstanceId.length > 0
      ? hello.nodeInstanceId
      : undefined;
    const resumable = hello.resumableCalls === true && nodeInstanceId !== undefined;
    const body = JSON.stringify({
      protocolMajor: PROTOCOL_MAJOR,
      toolContractHash: TOOL_CONTRACT_HASH,
      machineId: this.config.machineId,
      requestId: remoteRequestId,
      tool,
      arguments: args,
      ...(resumable ? { resumable: true, nodeInstanceId } : {}),
    });
    if (Buffer.byteLength(body) > this.maxBodyBytes()) throw new Error("Internal request is too large");

    if (!resumable) {
      try {
        return await this.withTimeout(
          options.signal,
          (boundedSignal) => this.callOnce(body, boundedSignal),
          remoteToolTimeoutMs(tool, args, this.config.timeoutMs),
        );
      } catch (error) {
        throw normalizeTargetError(error, options.signal, "Remote node call failed");
      }
    }

    return this.executeResumable(body, tool, args, remoteRequestId, nodeInstanceId!, options);
  }

  private async executeResumable(
    body: string,
    tool: ToolName,
    args: Record<string, unknown>,
    remoteRequestId: string,
    nodeInstanceId: string,
    options: { requestId: string; signal: AbortSignal },
  ): Promise<ExecutorResult> {
    const deadlineSignal = AbortSignal.timeout(remoteToolTimeoutMs(tool, args, this.config.timeoutMs));
    let retry = 0;

    while (true) {
      const attemptSignal = AbortSignal.any([options.signal, deadlineSignal]);
      try {
        return await this.callOnce(body, attemptSignal);
      } catch (error) {
        // Downstream Saga->node transport loss is safe to reattach because the
        // request ID and node instance are stable. An upstream caller abort is
        // different: preserve cancellation semantics and explicitly stop the
        // remote operation rather than leaving an orphan behind.
        if (options.signal.aborted) {
          await this.bestEffortCancel(remoteRequestId, nodeInstanceId);
          throw options.signal.reason ?? new Error("Remote node call cancelled");
        }
        if (deadlineSignal.aborted) {
          await this.bestEffortCancel(remoteRequestId, nodeInstanceId);
          throw new TargetUnavailableError("Remote node call exceeded its execution deadline", { cause: error });
        }
        if (error instanceof RemoteNodeExecutionError) throw error;
        if (!(error instanceof RemoteNodeTransportError)) {
          throw normalizeTargetError(error, options.signal, "Remote node call failed");
        }
        retry += 1;
        try {
          await waitForRetry(retry, attemptSignal);
        } catch (waitError) {
          if (options.signal.aborted) {
            await this.bestEffortCancel(remoteRequestId, nodeInstanceId);
            throw options.signal.reason ?? new Error("Remote node call cancelled");
          }
          if (deadlineSignal.aborted) {
            await this.bestEffortCancel(remoteRequestId, nodeInstanceId);
            throw new TargetUnavailableError("Remote node call exceeded its execution deadline", { cause: waitError });
          }
          throw waitError;
        }
      }
    }
  }

  private async callOnce(body: string, signal: AbortSignal): Promise<ExecutorResult> {
    const response = await this.request("/internal/v1/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }, signal);
    const envelope = await readBoundedJson<NodeCallEnvelope>(response, this.maxBodyBytes());
    if (!response.ok || !envelope.ok) {
      const code = !envelope.ok && envelope.error?.code ? envelope.error.code : "target_error";
      if (code === "protocol_mismatch" || code === "identity_mismatch" || code === "unauthorized" || code === "target_error") {
        throw new TargetUnavailableError(`Remote node call failed (${code})`);
      }
      const message = !envelope.ok && envelope.error?.message ? envelope.error.message.slice(0, 1024) : `Remote node call failed (${code})`;
      throw new RemoteNodeExecutionError(code, message);
    }
    if (envelope.machineId !== this.config.machineId) {
      throw new TargetUnavailableError("Remote node call identity is incompatible");
    }
    return envelope.result;
  }

  private async bestEffortCancel(requestId: string, nodeInstanceId: string): Promise<void> {
    const body = JSON.stringify({
      protocolMajor: PROTOCOL_MAJOR,
      toolContractHash: TOOL_CONTRACT_HASH,
      machineId: this.config.machineId,
      requestId,
      nodeInstanceId,
    });
    try {
      const response = await this.request("/internal/v1/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }, AbortSignal.timeout(CANCEL_TIMEOUT_MS));
      await response.body?.cancel();
    } catch {
      // The remote executor still enforces its own tool timeout. Cancellation
      // here is best-effort because the transport may be the thing that failed.
    }
  }

  private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
      const url = new URL(path, this.config.url);
      const response = await fetch(url, {
        ...init,
        redirect: "manual",
        signal,
        headers: {
          "X-DevSpace-Node-Token": this.config.nodeToken,
          ...init.headers,
        },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new TargetUnavailableError("Remote node redirect rejected");
      }
      if (isTransientTransportStatus(response.status)) {
        await response.body?.cancel();
        throw new RemoteNodeTransportError(`Remote node transport failed (${response.status})`);
      }
      return response;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? new Error("Remote node call cancelled");
      if (error instanceof TargetUnavailableError) throw error;
      throw new RemoteNodeTransportError("Remote node transport failed", { cause: error });
    }
  }

  private async retryTransient<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
    maxAttempts: number,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        attempt += 1;
        if (!(error instanceof RemoteNodeTransportError) || attempt >= maxAttempts) throw error;
        await waitForRetry(attempt, signal);
      }
    }
  }

  private async withTimeout<T>(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return operation(AbortSignal.any([signal, timeoutSignal]));
  }

  private maxBodyBytes(): number {
    return this.config.maxBodyBytes ?? MAX_BODY_BYTES;
  }
}

export function remoteToolTimeoutMs(tool: ToolName, args: Record<string, unknown>, overrideMs?: number): number {
  if (overrideMs !== undefined) return overrideMs;
  if (tool !== "run_shell") return DEFAULT_TIMEOUT_MS;
  const requestedSeconds = typeof args.timeout === "number" && Number.isFinite(args.timeout) ? args.timeout : 30;
  return Math.min(Math.max(requestedSeconds, 1), 300) * 1000 + 10_000;
}

function normalizeTargetError(error: unknown, callerSignal: AbortSignal, message: string): unknown {
  if (callerSignal.aborted) return callerSignal.reason ?? new Error("Remote node call cancelled");
  if (error instanceof TargetUnavailableError) return error;
  return new TargetUnavailableError(message, { cause: error });
}

function isTransientTransportStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 527);
}

async function waitForRetry(attempt: number, signal: AbortSignal): Promise<void> {
  const delayMs = Math.min(2_000, 100 * (2 ** Math.min(attempt - 1, 5)));
  if (signal.aborted) throw signal.reason ?? new Error("Remote node call cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Remote node call cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readBoundedJson<T>(response: Response, maxBytes: number): Promise<T> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error("Remote node response is too large");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Remote node response is too large");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    throw new Error("Remote node returned invalid JSON", { cause: error });
  }
}

export const REMOTE_NODE_BUILD_IDENTITY = getBuildMetadata("gateway");
