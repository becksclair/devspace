// Minimal MCP client over Streamable HTTP, written against the wire protocol with plain fetch.
//
// The widget host must survive the MCP SDK v1 -> v2 package split, so nothing here imports the
// MCP TypeScript SDK packages. It speaks only the subset the harness needs: initialize,
// notifications/initialized, and single JSON-RPC requests, with responses delivered either as
// `application/json` or as a `text/event-stream`. Never log the bearer token.

export const HARNESS_PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type RpcOutcome =
  | { result: Record<string, unknown> }
  | { error: JsonRpcError };

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: JsonRpcError;
}

export class McpHttpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "McpHttpError";
  }
}

export interface McpHttpClientOptions {
  endpoint: URL;
  bearerToken: string;
  clientName?: string;
}

/** One MCP session against a DevSpace `/mcp` endpoint. Concurrent requests are allowed. */
export class McpHttpClient {
  private readonly endpoint: URL;
  private readonly bearerToken: string;
  private readonly clientName: string;
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private initializing: Promise<void> | undefined;
  private nextId = 1;

  constructor(options: McpHttpClientOptions) {
    this.endpoint = options.endpoint;
    this.bearerToken = options.bearerToken;
    this.clientName = options.clientName ?? "devspace-widget-host";
  }

  /** Server-reported protocol version after initialize, if any. */
  get negotiatedProtocolVersion(): string | undefined {
    return this.protocolVersion;
  }

  /** Sends one request and returns its JSON-RPC result or error. Re-initializes once on a lost session. */
  async request(method: string, params: Record<string, unknown> = {}): Promise<RpcOutcome> {
    await this.ensureInitialized();
    const sessionId = this.sessionId;
    try {
      return await this.send(method, params);
    } catch (error) {
      if (!(error instanceof McpHttpError) || error.status !== 404) throw error;
      // The server evicted the session (idle TTL or restart): start a new one and retry once.
      // A concurrent request that lost the same session may already have replaced it.
      if (this.sessionId === sessionId) {
        this.sessionId = undefined;
        this.initializing = undefined;
      }
      await this.ensureInitialized();
      return this.send(method, params);
    }
  }

  /** Ends the session with an HTTP DELETE. Errors are ignored; the server may already be gone. */
  async close(): Promise<void> {
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    this.initializing = undefined;
    if (!sessionId) return;
    try {
      const response = await fetch(this.endpoint, { method: "DELETE", headers: this.headers(sessionId) });
      await response.body?.cancel();
    } catch {
      // Best effort.
    }
  }

  private ensureInitialized(): Promise<void> {
    this.initializing ??= this.initialize().catch((error: unknown) => {
      this.initializing = undefined;
      throw error;
    });
    return this.initializing;
  }

  private async initialize(): Promise<void> {
    const id = this.nextId++;
    const response = await this.post({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.clientName, version: "1.0.0" },
      },
    });
    const sessionId = response.headers.get("mcp-session-id");
    const message = await readResponseMessage(response, id);
    if (message.error) throw new McpHttpError(`initialize failed: ${message.error.message}`);
    const version = message.result?.protocolVersion;
    this.protocolVersion = typeof version === "string" ? version : HARNESS_PROTOCOL_VERSION;
    this.sessionId = sessionId ?? undefined;

    const initialized = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    await initialized.body?.cancel();
    if (initialized.status !== 202 && !initialized.ok) {
      throw new McpHttpError(`notifications/initialized failed with HTTP ${initialized.status}`, initialized.status);
    }
  }

  private async send(method: string, params: Record<string, unknown>): Promise<RpcOutcome> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params });
    const message = await readResponseMessage(response, id);
    if (message.error) return { error: message.error };
    return { result: message.result ?? {} };
  }

  private async post(body: unknown): Promise<Response> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        ...this.headers(this.sessionId),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
    if (response.status === 404 && this.sessionId) {
      await response.body?.cancel();
      throw new McpHttpError("MCP session not found", 404);
    }
    if (!response.ok && response.status !== 202) {
      const text = await response.text().catch(() => "");
      throw new McpHttpError(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
    }
    return response;
  }

  private headers(sessionId: string | undefined): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.bearerToken}` };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    if (this.protocolVersion) headers["Mcp-Protocol-Version"] = this.protocolVersion;
    return headers;
  }
}

async function readResponseMessage(response: Response, id: number): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const message = await readEventStream(response, id);
    if (!message) throw new McpHttpError(`event stream ended without a response to request ${id}`);
    return message;
  }
  const parsed = (await response.json()) as JsonRpcResponse | JsonRpcResponse[];
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const message = messages.find((candidate) => candidate.id === id);
  if (!message) throw new McpHttpError(`response did not include request ${id}`);
  return message;
}

/** Reads SSE events until the JSON-RPC response for `id` arrives; other messages are ignored. */
async function readEventStream(response: Response, id: number): Promise<JsonRpcResponse | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += value;
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) {
          const message = JSON.parse(data) as JsonRpcResponse;
          if (message.id === id && (message.result !== undefined || message.error !== undefined)) return message;
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (done) return undefined;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
