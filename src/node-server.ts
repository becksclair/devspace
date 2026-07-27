import express, { type Request, type Response } from "express";
import { getBuildMetadata, type BuildMetadata } from "./build-metadata.js";
import { constantTimeEqual, envSecret, type NodeRoleConfig } from "./role-config.js";
import { CANONICAL_TOOL_NAMES, parseToolArguments, TOOL_CONTRACT_HASH } from "./tool-contract.js";

export interface NodeExecutor {
  execute(tool: string, args: unknown, context: { requestId: string; signal: AbortSignal }): Promise<unknown>;
}
export interface NodeServerOptions { metadata?: BuildMetadata; maxBodyBytes?: number; allowedTools?: Set<string> | string[]; }

export function createNodeServer(config: NodeRoleConfig, executor: NodeExecutor, options: NodeServerOptions = {}) {
  const app = express();
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const metadata = options.metadata ?? { ...getBuildMetadata("node"), toolContractHash: TOOL_CONTRACT_HASH };
  const allowed = options.allowedTools ? new Set(options.allowedTools) : new Set<string>(CANONICAL_TOOL_NAMES);
  app.use(express.json({ limit: maxBodyBytes }));
  app.use((req, res, next) => {
    const provided = req.header("X-DevSpace-Node-Token") ?? "";
    let expected = ""; try { expected = envSecret(config.nodeTokenEnv); } catch { /* handled as unauthorized */ }
    if (!expected || !constantTimeEqual(provided, expected)) return res.status(401).json({ error: { code: "unauthorized", message: "Unauthorized" } });
    next();
  });
  app.get("/internal/v1/hello", (_req, res) => res.json({ protocolMajor: metadata.protocolMajor, machineId: config.machineId, packageVersion: metadata.packageVersion, sourceCommit: metadata.sourceCommit, toolContractHash: metadata.toolContractHash }));
  app.post("/internal/v1/call", async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const requestId = typeof body?.requestId === "string" ? body.requestId : "";
    const fail = (status: number, code: string, message: string) => res.status(status).json({ ok: false, error: { code, message: message.slice(0, 1024) } });
    if (!body || body.protocolMajor !== metadata.protocolMajor || body.toolContractHash !== metadata.toolContractHash) return fail(400, "protocol_mismatch", "Protocol or tool contract mismatch");
    if (body.machineId !== config.machineId) return fail(409, "identity_mismatch", "Machine identity mismatch");
    if (!requestId || requestId.length > 128 || typeof body.tool !== "string" || !allowed.has(body.tool)) return fail(400, "invalid_request", "Invalid call envelope");
    let args: unknown; try { args = parseToolArguments(body.tool as never, body.arguments); } catch { return fail(400, "invalid_arguments", "Invalid tool arguments"); }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const abortOnResponseClose = () => { if (!res.writableEnded) abort(); };
    req.once("aborted", abort); res.once("close", abortOnResponseClose);
    try {
      const result = await executor.execute(body.tool, args, { requestId, signal: controller.signal });
      if (!res.headersSent) {
        const responseBody = JSON.stringify({ ok: true, machineId: config.machineId, result });
        if (Buffer.byteLength(responseBody) > maxBodyBytes) fail(500, "response_too_large", "Executor response exceeds the configured limit");
        else res.type("application/json").send(responseBody);
      }
    } catch (error) {
      if (!res.headersSent) fail(500, "executor_error", error instanceof Error ? error.message : String(error));
    } finally { req.off("aborted", abort); res.off("close", abortOnResponseClose); }
  });
  return { app, metadata };
}

export async function startNodeServer(config: NodeRoleConfig, executor: NodeExecutor, options?: NodeServerOptions): Promise<import("node:http").Server> {
  const { app } = createNodeServer(config, executor, options);
  return app.listen(config.port, config.host);
}
