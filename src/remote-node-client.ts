import { TargetUnavailableError, type ExecutionTarget, type ExecutorResult } from "./gateway-router.js";
import { getBuildMetadata, PROTOCOL_MAJOR } from "./build-metadata.js";
import { TOOL_CONTRACT_HASH, type ToolName } from "./tool-contract.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

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
}

export class RemoteNodeClient implements ExecutionTarget {
  constructor(private readonly config: RemoteNodeClientConfig) {
    const url = new URL(config.url);
    if (url.protocol !== "https:") throw new Error("Remote node URL must use HTTPS");
  }

  async hello(signal: AbortSignal): Promise<NodeHello> {
    let hello: NodeHello;
    try {
      hello = await this.withTimeout(signal, async (boundedSignal) => {
        const response = await this.request("/internal/v1/hello", { method: "GET" }, boundedSignal);
        if (!response.ok) throw new TargetUnavailableError(`Remote node hello failed (${response.status})`);
        return readBoundedJson<NodeHello>(response, this.maxBodyBytes());
      });
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
    await this.hello(options.signal);
    const body = JSON.stringify({
      protocolMajor: PROTOCOL_MAJOR,
      toolContractHash: TOOL_CONTRACT_HASH,
      machineId: this.config.machineId,
      requestId: options.requestId,
      tool,
      arguments: args,
    });
    if (Buffer.byteLength(body) > this.maxBodyBytes()) throw new Error("Internal request is too large");
    let response: Response;
    let envelope: { ok: true; machineId: string; result: ExecutorResult } | { ok: false; error?: { code?: string; message?: string } };
    try {
      ({ response, envelope } = await this.withTimeout(options.signal, async (boundedSignal) => {
        const response = await this.request("/internal/v1/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }, boundedSignal);
        const envelope = await readBoundedJson<
          { ok: true; machineId: string; result: ExecutorResult } | { ok: false; error?: { code?: string; message?: string } }
        >(response, this.maxBodyBytes());
        return { response, envelope };
      }));
    } catch (error) {
      throw normalizeTargetError(error, options.signal, "Remote node call failed");
    }
    if (!response.ok || !envelope.ok) {
      const code = !envelope.ok && envelope.error?.code ? envelope.error.code : "target_error";
      if (code === "protocol_mismatch" || code === "identity_mismatch" || code === "unauthorized" || code === "target_error") {
        throw new TargetUnavailableError(`Remote node call failed (${code})`);
      }
      const message = !envelope.ok && envelope.error?.message ? envelope.error.message.slice(0, 1024) : `Remote node call failed (${code})`;
      throw new Error(message);
    }
    if (envelope.machineId !== this.config.machineId) {
      throw new TargetUnavailableError("Remote node call identity is incompatible");
    }
    return envelope.result;
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
      return response;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? new Error("Remote node call cancelled");
      if (error instanceof TargetUnavailableError) throw error;
      throw new TargetUnavailableError("Remote node transport failed", { cause: error });
    }
  }

  private async withTimeout<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return operation(AbortSignal.any([signal, timeoutSignal]));
  }

  private maxBodyBytes(): number {
    return this.config.maxBodyBytes ?? MAX_BODY_BYTES;
  }
}

function normalizeTargetError(error: unknown, callerSignal: AbortSignal, message: string): unknown {
  if (callerSignal.aborted) return callerSignal.reason ?? new Error("Remote node call cancelled");
  if (error instanceof TargetUnavailableError) return error;
  return new TargetUnavailableError(message, { cause: error });
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
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    throw new Error("Remote node returned invalid JSON", { cause: error });
  }
}

export const REMOTE_NODE_BUILD_IDENTITY = getBuildMetadata("gateway");
